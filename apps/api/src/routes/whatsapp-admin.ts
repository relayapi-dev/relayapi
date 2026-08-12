import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { generateId, socialAccounts, whatsappGroups } from "@relayapi/db";
import { and, eq, or } from "drizzle-orm";
import type { Context } from "hono";
import { encryptToken } from "../lib/crypto";
import {
	durableOperationHashes,
	sha256Hex,
	stableOperationJson,
} from "../lib/durable-operation";
import { canAccessWorkspaceScope } from "../lib/workspace-scope";
import { markMutationInputNotApplied } from "../middleware/mutation-validation";
import { ErrorResponse } from "../schemas/common";
import { SocialMutationResponse } from "../schemas/social-actions";
import {
	BlockedUsersResponse,
	BlockUsersBody,
	BlockUsersQuery,
	BusinessUsernameResponse,
	CreateTemplateFromLibraryBody,
	CreateWhatsAppGroupBody,
	EditTemplateBody,
	GroupMessageBody,
	GroupPinBody,
	InviteLinkResponse,
	JoinRequestListResponse,
	JoinRequestsQuery,
	ListWhatsAppGroupsQuery,
	RemoveGroupParticipantsBody,
	RequiredWhatsAppMutationHeaders,
	ResolveJoinRequestsBody,
	SetBusinessUsernameBody,
	TemplateIdParams,
	TemplateLibraryQuery,
	TemplateLibraryResponse,
	UpdateWhatsAppGroupBody,
	UsernameSuggestionsResponse,
	WhatsAppAccountQuery,
	WhatsAppCapabilitiesResponse,
	WhatsAppGroupListResponse,
	WhatsAppGroupParams,
	WhatsAppGroupQuery,
	WhatsAppGroupResponse,
} from "../schemas/whatsapp-admin";
import {
	getSocialMutation,
	runSocialMutation,
	SocialMutationConflictError,
	serializeSocialMutation,
} from "../services/social-mutation-operations";
import { SocialProviderActionError } from "../services/social-provider-actions";
import { refreshTokenIfNeeded } from "../services/token-refresh-coordinator";
import {
	createWhatsAppGroup,
	createWhatsAppTemplateFromLibrary,
	deleteWhatsAppBusinessUsername,
	deleteWhatsAppGroup,
	editWhatsAppTemplate,
	getWhatsAppBusinessUsername,
	getWhatsAppGroup,
	getWhatsAppGroupInviteLink,
	getWhatsAppUsernameSuggestions,
	listBlockedWhatsAppUsers,
	listWhatsAppGroups,
	listWhatsAppJoinRequests,
	listWhatsAppTemplateLibrary,
	mutateBlockedWhatsAppUsers,
	pinWhatsAppGroupMessage,
	probeWhatsAppAdminCapabilities,
	probeWhatsAppGroups,
	removeWhatsAppGroupParticipants,
	resetWhatsAppGroupInviteLink,
	resolveWhatsAppJoinRequests,
	sendWhatsAppGroupMessage,
	setWhatsAppBusinessUsername,
	updateWhatsAppGroup,
	type WhatsAppAdminAccount,
	type WhatsAppGroupProviderRecord,
} from "../services/whatsapp-admin-provider";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

type ResolvedWhatsAppAccount = WhatsAppAdminAccount & {
	id: string;
	organizationId: string;
	workspaceId: string | null;
	platform: "whatsapp";
};

const mutationResponses = {
	200: {
		description: "Durable WhatsApp provider mutation",
		content: { "application/json": { schema: SocialMutationResponse } },
	},
	400: {
		description: "Unsupported capability or invalid provider mutation",
		content: { "application/json": { schema: ErrorResponse } },
	},
	404: {
		description: "Account or target not found",
		content: { "application/json": { schema: ErrorResponse } },
	},
	409: {
		description: "Idempotency or active-mutation conflict",
		content: { "application/json": { schema: ErrorResponse } },
	},
	502: {
		description: "WhatsApp response unavailable",
		content: { "application/json": { schema: ErrorResponse } },
	},
} as const;

app.onError((error, c) => {
	if (error instanceof SocialMutationConflictError) {
		markMutationInputNotApplied(c);
		return c.json({ error: { code: error.code, message: error.message } }, 409);
	}
	if (error instanceof SocialProviderActionError) {
		const status = error.status === 404 ? 404 : error.definitive ? 400 : 502;
		return c.json(
			{ error: { code: error.code, message: error.message } },
			status,
		);
	}
	console.error("[whatsapp-admin] request failed", error);
	return c.json(
		{
			error: {
				code: "INTERNAL_ERROR",
				message: "WhatsApp admin request failed",
			},
		},
		500,
	);
});

async function resolveAccount(
	c: AppContext,
	accountId: string,
): Promise<ResolvedWhatsAppAccount | null> {
	const [account] = await c
		.get("db")
		.select()
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, accountId),
				eq(socialAccounts.organizationId, c.get("orgId")),
				eq(socialAccounts.platform, "whatsapp"),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		)
		.limit(1);
	if (
		!account ||
		!canAccessWorkspaceScope(c.get("workspaceScope"), account.workspaceId)
	) {
		return null;
	}
	const accessToken = await refreshTokenIfNeeded(c.env, {
		id: account.id,
		platform: account.platform,
		accessToken: account.accessToken,
		refreshToken: account.refreshToken,
		tokenExpiresAt: account.tokenExpiresAt,
	});
	const metadata = account.metadata as Record<string, unknown> | null;
	return {
		id: account.id,
		organizationId: account.organizationId,
		workspaceId: account.workspaceId,
		platform: "whatsapp",
		phoneNumberId: account.platformAccountId,
		wabaId: typeof metadata?.waba_id === "string" ? metadata.waba_id : null,
		accessToken,
	};
}

async function requiredAccount(
	c: AppContext,
	accountId: string,
): Promise<ResolvedWhatsAppAccount | Response> {
	const account = await resolveAccount(c, accountId);
	if (account) return account;
	markMutationInputNotApplied(c);
	return c.json(
		{
			error: {
				code: "ACCOUNT_NOT_FOUND",
				message: "WhatsApp account not found",
			},
		},
		404,
	);
}

type GroupRow = typeof whatsappGroups.$inferSelect;

async function resolveGroup(
	c: AppContext,
	account: ResolvedWhatsAppAccount,
	groupId: string,
): Promise<GroupRow | null> {
	const [group] = await c
		.get("db")
		.select()
		.from(whatsappGroups)
		.where(
			and(
				eq(whatsappGroups.organizationId, c.get("orgId")),
				eq(whatsappGroups.accountId, account.id),
				eq(whatsappGroups.platform, "whatsapp"),
				or(
					eq(whatsappGroups.id, groupId),
					eq(whatsappGroups.providerGroupId, groupId),
				),
			),
		)
		.limit(1);
	if (
		!group ||
		!canAccessWorkspaceScope(c.get("workspaceScope"), group.workspaceId)
	) {
		return null;
	}
	return group;
}

async function requiredActiveGroup(
	c: AppContext,
	account: ResolvedWhatsAppAccount,
	groupId: string,
): Promise<(GroupRow & { providerGroupId: string }) | Response> {
	const group = await resolveGroup(c, account, groupId);
	if (
		group?.lifecycleStatus === "active" &&
		typeof group.providerGroupId === "string"
	) {
		return group as GroupRow & { providerGroupId: string };
	}
	markMutationInputNotApplied(c);
	return c.json(
		{
			error: {
				code: "GROUP_NOT_FOUND",
				message: "Active WhatsApp group not found",
			},
		},
		404,
	);
}

function parseProviderDate(value: unknown): Date | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const numeric = Number(value);
	if (Number.isFinite(numeric) && numeric > 0) {
		return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1_000);
	}
	const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isNaN(parsed) ? null : new Date(parsed);
}

async function projectProviderGroup(
	c: AppContext,
	account: ResolvedWhatsAppAccount,
	provider: WhatsAppGroupProviderRecord,
): Promise<GroupRow> {
	if (!provider.id || !provider.subject) {
		throw new SocialProviderActionError(
			"WHATSAPP_GROUP_RESPONSE_INVALID",
			"WhatsApp returned a group without an ID or subject",
		);
	}
	const db = c.get("db");
	const [existing] = await db
		.select()
		.from(whatsappGroups)
		.where(
			and(
				eq(whatsappGroups.organizationId, c.get("orgId")),
				eq(whatsappGroups.accountId, account.id),
				eq(whatsappGroups.providerGroupId, provider.id),
			),
		)
		.limit(1);
	const now = new Date();
	const values = {
		subject: provider.subject,
		description: provider.description ?? null,
		joinApprovalMode: provider.join_approval_mode ?? null,
		lifecycleStatus: provider.suspended
			? ("suspended" as const)
			: ("active" as const),
		participantCount: provider.total_participant_count ?? null,
		providerCreatedAt: parseProviderDate(
			provider.creation_timestamp ?? provider.created_at,
		),
		lastSyncedAt: now,
		updatedAt: now,
	};
	if (existing) {
		const [updated] = await db
			.update(whatsappGroups)
			.set(values)
			.where(
				and(
					eq(whatsappGroups.id, existing.id),
					eq(whatsappGroups.organizationId, c.get("orgId")),
					eq(whatsappGroups.accountId, account.id),
				),
			)
			.returning();
		if (!updated) throw new Error("WhatsApp group projection changed");
		return updated;
	}
	const [inserted] = await db
		.insert(whatsappGroups)
		.values({
			id: generateId("wg_"),
			organizationId: c.get("orgId"),
			workspaceId: account.workspaceId,
			accountId: account.id,
			platform: "whatsapp",
			providerGroupId: provider.id,
			...values,
			createdAt: now,
		})
		.returning();
	if (!inserted) throw new Error("WhatsApp group projection failed");
	return inserted;
}

function groupResponse(group: GroupRow, provider: WhatsAppGroupProviderRecord) {
	return { ...provider, relay_group_id: group.id };
}

async function contentHash(value: unknown): Promise<string> {
	return sha256Hex(stableOperationJson(value));
}

const capabilitiesRoute = createRoute({
	operationId: "getWhatsAppAdminCapabilities",
	method: "get",
	path: "/capabilities",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: { query: WhatsAppAccountQuery },
	responses: {
		200: {
			description:
				"Conservative account capability snapshot; supported is returned only after a feature-specific read probe",
			content: { "application/json": { schema: WhatsAppCapabilitiesResponse } },
		},
		404: mutationResponses[404],
		502: mutationResponses[502],
	},
});

app.openapi(capabilitiesRoute, async (c) => {
	const { account_id: accountId } = c.req.valid("query");
	const resolved = await requiredAccount(c, accountId);
	if (resolved instanceof Response) return resolved as never;
	const capabilities = await probeWhatsAppAdminCapabilities(resolved);
	const requirements = Object.entries(capabilities)
		.filter(([, state]) => state !== "supported")
		.map(([feature, state]) => `${feature}: ${state}`);
	return c.json(
		{
			account_id: resolved.id,
			capabilities,
			requirements,
			checked_at: new Date().toISOString(),
		},
		200,
	);
});

const listGroupsRoute = createRoute({
	operationId: "listWhatsAppGroups",
	method: "get",
	path: "/groups",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: { query: ListWhatsAppGroupsQuery },
	responses: {
		200: {
			description: "Active WhatsApp groups",
			content: { "application/json": { schema: WhatsAppGroupListResponse } },
		},
		404: mutationResponses[404],
		502: mutationResponses[502],
	},
});

app.openapi(listGroupsRoute, async (c) => {
	const query = c.req.valid("query");
	const resolved = await requiredAccount(c, query.account_id);
	if (resolved instanceof Response) return resolved as never;
	const provider = await listWhatsAppGroups(resolved, query);
	const data = await Promise.all(
		provider.groups.map(async (record) =>
			groupResponse(await projectProviderGroup(c, resolved, record), record),
		),
	);
	return c.json({ data, paging: provider.paging }, 200);
});

const createGroupRoute = createRoute({
	operationId: "createWhatsAppGroup",
	method: "post",
	path: "/groups",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredWhatsAppMutationHeaders,
		body: {
			content: { "application/json": { schema: CreateWhatsAppGroupBody } },
		},
	},
	responses: { 202: mutationResponses[200], ...mutationResponses },
});

app.openapi(createGroupRoute, async (c) => {
	const body = c.req.valid("json");
	const operationKey = c.req.valid("header")["idempotency-key"];
	const resolved = await requiredAccount(c, body.account_id);
	if (resolved instanceof Response) return resolved as never;
	if ((await probeWhatsAppGroups(resolved)) !== "supported") {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "WHATSAPP_GROUPS_UNAVAILABLE",
					message: "This phone number is not eligible for the Groups API",
				},
			},
			400,
		) as never;
	}
	const requestPayload = {
		account_id: resolved.id,
		subject: body.subject,
		description: body.description,
		join_approval_mode: body.join_approval_mode,
	};
	const { operationKeyHash } = await durableOperationHashes(
		c.get("orgId"),
		"group_create",
		operationKey,
		requestPayload,
	);
	const localGroupId = `wg_${operationKeyHash.slice(0, 21)}`;
	await c
		.get("db")
		.insert(whatsappGroups)
		.values({
			id: localGroupId,
			organizationId: c.get("orgId"),
			workspaceId: resolved.workspaceId,
			accountId: resolved.id,
			platform: "whatsapp",
			subject: body.subject,
			description: body.description ?? null,
			joinApprovalMode: body.join_approval_mode,
			lifecycleStatus: "creating",
		})
		.onConflictDoNothing();
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: resolved.workspaceId,
		accountId: resolved.id,
		platform: "whatsapp",
		targetType: "whatsapp_group",
		targetId: localGroupId,
		kind: "group_create",
		operationKey,
		requestPayload: { ...requestPayload, group_id: localGroupId },
		mutationEffectTracker: c.get("mutationEffectTracker"),
		provider: () => createWhatsAppGroup(resolved, body),
		project: async (result) => {
			const [updated] = await c
				.get("db")
				.update(whatsappGroups)
				.set({
					providerGroupId: result.providerId ?? null,
					providerRequestId: result.providerOperationId ?? null,
					lifecycleStatus: result.providerId ? "active" : "creating",
					lastSyncedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(whatsappGroups.id, localGroupId),
						eq(whatsappGroups.organizationId, c.get("orgId")),
						eq(whatsappGroups.accountId, resolved.id),
					),
				)
				.returning({ id: whatsappGroups.id });
			if (!updated) throw new Error("WhatsApp group projection changed");
		},
	});
	if (operation.status === "failed") {
		await c
			.get("db")
			.update(whatsappGroups)
			.set({ lifecycleStatus: "failed", updatedAt: new Date() })
			.where(
				and(
					eq(whatsappGroups.id, localGroupId),
					eq(whatsappGroups.organizationId, c.get("orgId")),
					eq(whatsappGroups.accountId, resolved.id),
					eq(whatsappGroups.lifecycleStatus, "creating"),
				),
			);
	}
	return c.json(serializeSocialMutation(operation), 202);
});

const getGroupRoute = createRoute({
	operationId: "getWhatsAppGroup",
	method: "get",
	path: "/groups/{group_id}",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: { params: WhatsAppGroupParams, query: WhatsAppGroupQuery },
	responses: {
		200: {
			description: "WhatsApp group",
			content: { "application/json": { schema: WhatsAppGroupResponse } },
		},
		404: mutationResponses[404],
		502: mutationResponses[502],
	},
});

app.openapi(getGroupRoute, async (c) => {
	const { group_id: groupId } = c.req.valid("param");
	const query = c.req.valid("query");
	const resolved = await requiredAccount(c, query.account_id);
	if (resolved instanceof Response) return resolved as never;
	const group = await requiredActiveGroup(c, resolved, groupId);
	if (group instanceof Response) return group as never;
	const provider = await getWhatsAppGroup(
		resolved,
		group.providerGroupId,
		query.fields,
	);
	const projected = await projectProviderGroup(c, resolved, {
		...provider,
		id: group.providerGroupId,
		subject: provider.subject ?? group.subject,
	});
	return c.json(groupResponse(projected, provider), 200);
});

const updateGroupRoute = createRoute({
	operationId: "updateWhatsAppGroup",
	method: "patch",
	path: "/groups/{group_id}",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredWhatsAppMutationHeaders,
		params: WhatsAppGroupParams,
		body: {
			content: { "application/json": { schema: UpdateWhatsAppGroupBody } },
		},
	},
	responses: mutationResponses,
});

app.openapi(updateGroupRoute, async (c) => {
	const { group_id: groupId } = c.req.valid("param");
	const body = c.req.valid("json");
	const resolved = await requiredAccount(c, body.account_id);
	if (resolved instanceof Response) return resolved as never;
	const group = await requiredActiveGroup(c, resolved, groupId);
	if (group instanceof Response) return group as never;
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: group.workspaceId,
		accountId: resolved.id,
		platform: "whatsapp",
		targetType: "whatsapp_group",
		targetId: group.id,
		kind: "group_update",
		operationKey: c.req.valid("header")["idempotency-key"],
		requestPayload: { group_id: group.id, ...body },
		mutationEffectTracker: c.get("mutationEffectTracker"),
		provider: () =>
			updateWhatsAppGroup(resolved, group.providerGroupId, {
				subject: body.subject,
				description: body.description,
			}),
		project: async () => {
			const [updated] = await c
				.get("db")
				.update(whatsappGroups)
				.set({
					...(body.subject !== undefined ? { subject: body.subject } : {}),
					...(body.description !== undefined
						? { description: body.description }
						: {}),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(whatsappGroups.id, group.id),
						eq(whatsappGroups.organizationId, c.get("orgId")),
						eq(whatsappGroups.accountId, resolved.id),
					),
				)
				.returning({ id: whatsappGroups.id });
			if (!updated) throw new Error("WhatsApp group projection changed");
		},
	});
	return c.json(serializeSocialMutation(operation), 200);
});

const deleteGroupRoute = createRoute({
	operationId: "deleteWhatsAppGroup",
	method: "delete",
	path: "/groups/{group_id}",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredWhatsAppMutationHeaders,
		params: WhatsAppGroupParams,
		query: WhatsAppAccountQuery,
	},
	responses: mutationResponses,
});

app.openapi(deleteGroupRoute, async (c) => {
	const { group_id: groupId } = c.req.valid("param");
	const { account_id: accountId } = c.req.valid("query");
	const resolved = await requiredAccount(c, accountId);
	if (resolved instanceof Response) return resolved as never;
	const group = await requiredActiveGroup(c, resolved, groupId);
	if (group instanceof Response) return group as never;
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: group.workspaceId,
		accountId: resolved.id,
		platform: "whatsapp",
		targetType: "whatsapp_group",
		targetId: group.id,
		kind: "group_delete",
		operationKey: c.req.valid("header")["idempotency-key"],
		requestPayload: { account_id: resolved.id, group_id: group.id },
		mutationEffectTracker: c.get("mutationEffectTracker"),
		provider: () => deleteWhatsAppGroup(resolved, group.providerGroupId),
		project: async () => {
			const [updated] = await c
				.get("db")
				.update(whatsappGroups)
				.set({ lifecycleStatus: "deleting", updatedAt: new Date() })
				.where(
					and(
						eq(whatsappGroups.id, group.id),
						eq(whatsappGroups.organizationId, c.get("orgId")),
						eq(whatsappGroups.accountId, resolved.id),
					),
				)
				.returning({ id: whatsappGroups.id });
			if (!updated) throw new Error("WhatsApp group projection changed");
		},
	});
	return c.json(serializeSocialMutation(operation), 200);
});

const inviteLinkRoute = createRoute({
	operationId: "getWhatsAppGroupInviteLink",
	method: "get",
	path: "/groups/{group_id}/invite-link",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: { params: WhatsAppGroupParams, query: WhatsAppAccountQuery },
	responses: {
		200: {
			description: "Current group invite link",
			content: { "application/json": { schema: InviteLinkResponse } },
		},
		404: mutationResponses[404],
		502: mutationResponses[502],
	},
});

app.openapi(inviteLinkRoute, async (c) => {
	const { group_id: groupId } = c.req.valid("param");
	const resolved = await requiredAccount(c, c.req.valid("query").account_id);
	if (resolved instanceof Response) return resolved as never;
	const group = await requiredActiveGroup(c, resolved, groupId);
	if (group instanceof Response) return group as never;
	const payload = await getWhatsAppGroupInviteLink(
		resolved,
		group.providerGroupId,
	);
	const ciphertext = await encryptToken(
		payload.invite_link,
		c.env.ENCRYPTION_KEY,
		{
			recordId: group.id,
			field: "whatsapp_group_invite_link",
		},
	);
	await c
		.get("db")
		.update(whatsappGroups)
		.set({ inviteLinkCiphertext: ciphertext, updatedAt: new Date() })
		.where(
			and(
				eq(whatsappGroups.id, group.id),
				eq(whatsappGroups.organizationId, c.get("orgId")),
				eq(whatsappGroups.accountId, resolved.id),
			),
		);
	return c.json(payload, 200);
});

const resetInviteLinkRoute = createRoute({
	operationId: "resetWhatsAppGroupInviteLink",
	method: "post",
	path: "/groups/{group_id}/invite-link",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredWhatsAppMutationHeaders,
		params: WhatsAppGroupParams,
		body: {
			content: {
				"application/json": { schema: z.object({ account_id: z.string() }) },
			},
		},
	},
	responses: mutationResponses,
});

app.openapi(resetInviteLinkRoute, async (c) => {
	const body = c.req.valid("json");
	const resolved = await requiredAccount(c, body.account_id);
	if (resolved instanceof Response) return resolved as never;
	const group = await requiredActiveGroup(
		c,
		resolved,
		c.req.valid("param").group_id,
	);
	if (group instanceof Response) return group as never;
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: group.workspaceId,
		accountId: resolved.id,
		platform: "whatsapp",
		targetType: "whatsapp_group",
		targetId: group.id,
		kind: "group_update",
		operationKey: c.req.valid("header")["idempotency-key"],
		requestPayload: {
			account_id: resolved.id,
			group_id: group.id,
			reset_invite_link: true,
		},
		mutationEffectTracker: c.get("mutationEffectTracker"),
		provider: () =>
			resetWhatsAppGroupInviteLink(resolved, group.providerGroupId),
		project: async (result) => {
			const inviteLink = result.transient?.invite_link;
			if (typeof inviteLink !== "string") {
				throw new Error("WhatsApp did not return the rotated invite link");
			}
			const ciphertext = await encryptToken(inviteLink, c.env.ENCRYPTION_KEY, {
				recordId: group.id,
				field: "whatsapp_group_invite_link",
			});
			const [updated] = await c
				.get("db")
				.update(whatsappGroups)
				.set({ inviteLinkCiphertext: ciphertext, updatedAt: new Date() })
				.where(
					and(
						eq(whatsappGroups.id, group.id),
						eq(whatsappGroups.organizationId, c.get("orgId")),
						eq(whatsappGroups.accountId, resolved.id),
					),
				)
				.returning({ id: whatsappGroups.id });
			if (!updated) throw new Error("WhatsApp group projection changed");
		},
	});
	return c.json(serializeSocialMutation(operation), 200);
});

const joinRequestsRoute = createRoute({
	operationId: "listWhatsAppGroupJoinRequests",
	method: "get",
	path: "/groups/{group_id}/join-requests",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: { params: WhatsAppGroupParams, query: JoinRequestsQuery },
	responses: {
		200: {
			description: "Pending WhatsApp group join requests",
			content: { "application/json": { schema: JoinRequestListResponse } },
		},
		404: mutationResponses[404],
		502: mutationResponses[502],
	},
});

app.openapi(joinRequestsRoute, async (c) => {
	const query = c.req.valid("query");
	const resolved = await requiredAccount(c, query.account_id);
	if (resolved instanceof Response) return resolved as never;
	const group = await requiredActiveGroup(
		c,
		resolved,
		c.req.valid("param").group_id,
	);
	if (group instanceof Response) return group as never;
	return c.json(
		await listWhatsAppJoinRequests(resolved, group.providerGroupId, query),
		200,
	) as never;
});

function joinMutationRoute(action: "approve" | "reject") {
	return createRoute({
		operationId:
			action === "approve"
				? "approveWhatsAppGroupJoinRequests"
				: "rejectWhatsAppGroupJoinRequests",
		method: "post",
		path: `/groups/{group_id}/join-requests/${action}`,
		tags: ["WhatsApp Admin"],
		security: [{ Bearer: [] }],
		request: {
			headers: RequiredWhatsAppMutationHeaders,
			params: WhatsAppGroupParams,
			body: {
				content: { "application/json": { schema: ResolveJoinRequestsBody } },
			},
		},
		responses: mutationResponses,
	});
}

for (const action of ["approve", "reject"] as const) {
	app.openapi(joinMutationRoute(action), async (c) => {
		const body = c.req.valid("json");
		const resolved = await requiredAccount(c, body.account_id);
		if (resolved instanceof Response) return resolved as never;
		const group = await requiredActiveGroup(
			c,
			resolved,
			c.req.valid("param").group_id,
		);
		if (group instanceof Response) return group as never;
		const operation = await runSocialMutation({
			db: c.get("db"),
			organizationId: c.get("orgId"),
			workspaceId: group.workspaceId,
			accountId: resolved.id,
			platform: "whatsapp",
			targetType: "whatsapp_group",
			targetId: group.id,
			kind: action === "approve" ? "group_join_approve" : "group_join_reject",
			operationKey: c.req.valid("header")["idempotency-key"],
			requestPayload: {
				account_id: resolved.id,
				group_id: group.id,
				action,
				join_request_ids_hash: await contentHash(body.join_request_ids),
				join_request_count: body.join_request_ids.length,
			},
			mutationEffectTracker: c.get("mutationEffectTracker"),
			provider: () =>
				resolveWhatsAppJoinRequests(
					resolved,
					group.providerGroupId,
					body.join_request_ids,
					action,
				),
		});
		return c.json(serializeSocialMutation(operation), 200);
	});
}

const removeParticipantsRoute = createRoute({
	operationId: "removeWhatsAppGroupParticipants",
	method: "post",
	path: "/groups/{group_id}/participants/remove",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredWhatsAppMutationHeaders,
		params: WhatsAppGroupParams,
		body: {
			content: { "application/json": { schema: RemoveGroupParticipantsBody } },
		},
	},
	responses: mutationResponses,
});

app.openapi(removeParticipantsRoute, async (c) => {
	const body = c.req.valid("json");
	const resolved = await requiredAccount(c, body.account_id);
	if (resolved instanceof Response) return resolved as never;
	const group = await requiredActiveGroup(
		c,
		resolved,
		c.req.valid("param").group_id,
	);
	if (group instanceof Response) return group as never;
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: group.workspaceId,
		accountId: resolved.id,
		platform: "whatsapp",
		targetType: "whatsapp_group",
		targetId: group.id,
		kind: "group_participant_remove",
		operationKey: c.req.valid("header")["idempotency-key"],
		requestPayload: {
			account_id: resolved.id,
			group_id: group.id,
			participants_hash: await contentHash(body.participants),
			participant_count: body.participants.length,
		},
		mutationEffectTracker: c.get("mutationEffectTracker"),
		provider: () =>
			removeWhatsAppGroupParticipants(
				resolved,
				group.providerGroupId,
				body.participants,
			),
	});
	return c.json(serializeSocialMutation(operation), 200);
});

const sendGroupMessageRoute = createRoute({
	operationId: "sendWhatsAppGroupMessage",
	method: "post",
	path: "/groups/{group_id}/messages",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredWhatsAppMutationHeaders,
		params: WhatsAppGroupParams,
		body: { content: { "application/json": { schema: GroupMessageBody } } },
	},
	responses: mutationResponses,
});

app.openapi(sendGroupMessageRoute, async (c) => {
	const body = c.req.valid("json");
	const resolved = await requiredAccount(c, body.account_id);
	if (resolved instanceof Response) return resolved as never;
	const group = await requiredActiveGroup(
		c,
		resolved,
		c.req.valid("param").group_id,
	);
	if (group instanceof Response) return group as never;
	const providerBody = { ...body };
	delete (providerBody as { account_id?: string }).account_id;
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: group.workspaceId,
		accountId: resolved.id,
		platform: "whatsapp",
		targetType: "whatsapp_group",
		targetId: group.id,
		kind: "group_message",
		operationKey: c.req.valid("header")["idempotency-key"],
		requestPayload: {
			account_id: resolved.id,
			group_id: group.id,
			type: body.type,
			content_hash: await contentHash(providerBody),
		},
		mutationEffectTracker: c.get("mutationEffectTracker"),
		provider: () =>
			sendWhatsAppGroupMessage(resolved, group.providerGroupId, providerBody),
	});
	return c.json(serializeSocialMutation(operation), 200);
});

const pinGroupMessageRoute = createRoute({
	operationId: "pinWhatsAppGroupMessage",
	method: "post",
	path: "/groups/{group_id}/pins",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredWhatsAppMutationHeaders,
		params: WhatsAppGroupParams,
		body: { content: { "application/json": { schema: GroupPinBody } } },
	},
	responses: mutationResponses,
});

app.openapi(pinGroupMessageRoute, async (c) => {
	const body = c.req.valid("json");
	const resolved = await requiredAccount(c, body.account_id);
	if (resolved instanceof Response) return resolved as never;
	const group = await requiredActiveGroup(
		c,
		resolved,
		c.req.valid("param").group_id,
	);
	if (group instanceof Response) return group as never;
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: group.workspaceId,
		accountId: resolved.id,
		platform: "whatsapp",
		targetType: "whatsapp_group",
		targetId: group.id,
		kind: "group_pin",
		operationKey: c.req.valid("header")["idempotency-key"],
		requestPayload: { ...body, group_id: group.id },
		mutationEffectTracker: c.get("mutationEffectTracker"),
		provider: () =>
			pinWhatsAppGroupMessage(resolved, group.providerGroupId, {
				message_id: body.message_id,
				action: body.action,
				expiration_days: body.expiration_days,
			}),
	});
	return c.json(serializeSocialMutation(operation), 200);
});

const blockedUsersRoute = createRoute({
	operationId: "listBlockedWhatsAppUsers",
	method: "get",
	path: "/block-users",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: { query: BlockUsersQuery },
	responses: {
		200: {
			description: "Blocked WhatsApp users",
			content: { "application/json": { schema: BlockedUsersResponse } },
		},
		404: mutationResponses[404],
		502: mutationResponses[502],
	},
});

app.openapi(blockedUsersRoute, async (c) => {
	const query = c.req.valid("query");
	const resolved = await requiredAccount(c, query.account_id);
	if (resolved instanceof Response) return resolved as never;
	return c.json(await listBlockedWhatsAppUsers(resolved, query), 200) as never;
});

function blockMutationRoute(action: "block" | "unblock") {
	return createRoute({
		operationId:
			action === "block" ? "blockWhatsAppUsers" : "unblockWhatsAppUsers",
		method: action === "block" ? "post" : "delete",
		path: "/block-users",
		tags: ["WhatsApp Admin"],
		security: [{ Bearer: [] }],
		request: {
			headers: RequiredWhatsAppMutationHeaders,
			body: { content: { "application/json": { schema: BlockUsersBody } } },
		},
		responses: mutationResponses,
	});
}

for (const action of ["block", "unblock"] as const) {
	app.openapi(blockMutationRoute(action), async (c) => {
		const body = c.req.valid("json");
		const resolved = await requiredAccount(c, body.account_id);
		if (resolved instanceof Response) return resolved as never;
		const operation = await runSocialMutation({
			db: c.get("db"),
			organizationId: c.get("orgId"),
			workspaceId: resolved.workspaceId,
			accountId: resolved.id,
			platform: "whatsapp",
			targetType: "whatsapp_account",
			targetId: resolved.id,
			kind: action === "block" ? "block_users" : "unblock_users",
			operationKey: c.req.valid("header")["idempotency-key"],
			requestPayload: {
				account_id: resolved.id,
				action,
				users_hash: await contentHash(body.users),
				user_count: body.users.length,
			},
			mutationEffectTracker: c.get("mutationEffectTracker"),
			provider: () => mutateBlockedWhatsAppUsers(resolved, body.users, action),
		});
		return c.json(serializeSocialMutation(operation), 200);
	});
}

const usernameRoute = createRoute({
	operationId: "getWhatsAppBusinessUsername",
	method: "get",
	path: "/username",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: { query: WhatsAppAccountQuery },
	responses: {
		200: {
			description: "Current WhatsApp business username",
			content: { "application/json": { schema: BusinessUsernameResponse } },
		},
		404: mutationResponses[404],
		502: mutationResponses[502],
	},
});

app.openapi(usernameRoute, async (c) => {
	const resolved = await requiredAccount(c, c.req.valid("query").account_id);
	if (resolved instanceof Response) return resolved as never;
	return c.json(await getWhatsAppBusinessUsername(resolved), 200) as never;
});

const setUsernameRoute = createRoute({
	operationId: "setWhatsAppBusinessUsername",
	method: "put",
	path: "/username",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredWhatsAppMutationHeaders,
		body: {
			content: { "application/json": { schema: SetBusinessUsernameBody } },
		},
	},
	responses: mutationResponses,
});

app.openapi(setUsernameRoute, async (c) => {
	const body = c.req.valid("json");
	const resolved = await requiredAccount(c, body.account_id);
	if (resolved instanceof Response) return resolved as never;
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: resolved.workspaceId,
		accountId: resolved.id,
		platform: "whatsapp",
		targetType: "whatsapp_account",
		targetId: resolved.id,
		kind: "username_set",
		operationKey: c.req.valid("header")["idempotency-key"],
		requestPayload: body,
		mutationEffectTracker: c.get("mutationEffectTracker"),
		provider: () =>
			setWhatsAppBusinessUsername(resolved, {
				username: body.username,
			}),
	});
	return c.json(serializeSocialMutation(operation), 200);
});

const deleteUsernameRoute = createRoute({
	operationId: "deleteWhatsAppBusinessUsername",
	method: "delete",
	path: "/username",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredWhatsAppMutationHeaders,
		query: WhatsAppAccountQuery,
	},
	responses: mutationResponses,
});

app.openapi(deleteUsernameRoute, async (c) => {
	const resolved = await requiredAccount(c, c.req.valid("query").account_id);
	if (resolved instanceof Response) return resolved as never;
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: resolved.workspaceId,
		accountId: resolved.id,
		platform: "whatsapp",
		targetType: "whatsapp_account",
		targetId: resolved.id,
		kind: "username_delete",
		operationKey: c.req.valid("header")["idempotency-key"],
		requestPayload: { account_id: resolved.id },
		mutationEffectTracker: c.get("mutationEffectTracker"),
		provider: () => deleteWhatsAppBusinessUsername(resolved),
	});
	return c.json(serializeSocialMutation(operation), 200);
});

const usernameSuggestionsRoute = createRoute({
	operationId: "getWhatsAppUsernameSuggestions",
	method: "get",
	path: "/username/suggestions",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: { query: WhatsAppAccountQuery },
	responses: {
		200: {
			description: "Reserved WhatsApp username suggestions",
			content: { "application/json": { schema: UsernameSuggestionsResponse } },
		},
		404: mutationResponses[404],
		502: mutationResponses[502],
	},
});

app.openapi(usernameSuggestionsRoute, async (c) => {
	const resolved = await requiredAccount(c, c.req.valid("query").account_id);
	if (resolved instanceof Response) return resolved as never;
	return c.json(await getWhatsAppUsernameSuggestions(resolved), 200) as never;
});

const templateLibraryRoute = createRoute({
	operationId: "listWhatsAppTemplateLibrary",
	method: "get",
	path: "/template-library",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: { query: TemplateLibraryQuery },
	responses: {
		200: {
			description: "WhatsApp template library",
			content: { "application/json": { schema: TemplateLibraryResponse } },
		},
		404: mutationResponses[404],
		502: mutationResponses[502],
	},
});

app.openapi(templateLibraryRoute, async (c) => {
	const query = c.req.valid("query");
	const resolved = await requiredAccount(c, query.account_id);
	if (resolved instanceof Response) return resolved as never;
	const { account_id: _accountId, ...filters } = query;
	return c.json(
		await listWhatsAppTemplateLibrary(resolved, filters),
		200,
	) as never;
});

const createTemplateRoute = createRoute({
	operationId: "createWhatsAppTemplateFromLibrary",
	method: "post",
	path: "/templates/from-library",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredWhatsAppMutationHeaders,
		body: {
			content: {
				"application/json": { schema: CreateTemplateFromLibraryBody },
			},
		},
	},
	responses: mutationResponses,
});

app.openapi(createTemplateRoute, async (c) => {
	const body = c.req.valid("json");
	const resolved = await requiredAccount(c, body.account_id);
	if (resolved instanceof Response) return resolved as never;
	const { account_id: _accountId, ...providerBody } = body;
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: resolved.workspaceId,
		accountId: resolved.id,
		platform: "whatsapp",
		targetType: "whatsapp_template",
		targetId: `template:${body.name}`,
		kind: "template_library_create",
		operationKey: c.req.valid("header")["idempotency-key"],
		requestPayload: {
			account_id: resolved.id,
			name: body.name,
			library_template_name: body.library_template_name,
			body_hash: await contentHash(providerBody),
		},
		mutationEffectTracker: c.get("mutationEffectTracker"),
		provider: () => createWhatsAppTemplateFromLibrary(resolved, providerBody),
	});
	return c.json(serializeSocialMutation(operation), 200);
});

const editTemplateRoute = createRoute({
	operationId: "editWhatsAppTemplate",
	method: "patch",
	path: "/templates/{template_id}",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredWhatsAppMutationHeaders,
		params: TemplateIdParams,
		body: { content: { "application/json": { schema: EditTemplateBody } } },
	},
	responses: mutationResponses,
});

app.openapi(editTemplateRoute, async (c) => {
	const body = c.req.valid("json");
	const templateId = c.req.valid("param").template_id;
	const resolved = await requiredAccount(c, body.account_id);
	if (resolved instanceof Response) return resolved as never;
	const { account_id: _accountId, ...providerBody } = body;
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: resolved.workspaceId,
		accountId: resolved.id,
		platform: "whatsapp",
		targetType: "whatsapp_template",
		targetId: templateId,
		kind: "template_edit",
		operationKey: c.req.valid("header")["idempotency-key"],
		requestPayload: {
			account_id: resolved.id,
			template_id: templateId,
			body_hash: await contentHash(providerBody),
		},
		mutationEffectTracker: c.get("mutationEffectTracker"),
		provider: () => editWhatsAppTemplate(resolved, templateId, providerBody),
	});
	return c.json(serializeSocialMutation(operation), 200);
});

const operationRoute = createRoute({
	operationId: "getWhatsAppAdminOperation",
	method: "get",
	path: "/operations/{operation_id}",
	tags: ["WhatsApp Admin"],
	security: [{ Bearer: [] }],
	request: {
		params: z.object({ operation_id: z.string() }),
		query: WhatsAppAccountQuery,
	},
	responses: {
		200: {
			description: "Durable WhatsApp operation",
			content: { "application/json": { schema: SocialMutationResponse } },
		},
		404: mutationResponses[404],
	},
});

app.openapi(operationRoute, async (c) => {
	const resolved = await requiredAccount(c, c.req.valid("query").account_id);
	if (resolved instanceof Response) return resolved as never;
	const operation = await getSocialMutation(
		c.get("db"),
		c.get("orgId"),
		c.req.valid("param").operation_id,
	);
	if (
		operation?.platform !== "whatsapp" ||
		operation.accountId !== resolved.id ||
		!canAccessWorkspaceScope(c.get("workspaceScope"), operation.workspaceId)
	) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "WhatsApp operation not found" } },
			404,
		);
	}
	return c.json(serializeSocialMutation(operation), 200);
});

export default app;
