// apps/api/src/routes/automation-bindings.ts
//
// Binding CRUD for the Manychat-parity automation engine (spec §9.4).
//
// Bindings connect a social account + binding slot to a specific automation.
// Provider-owned profile bindings use a revisioned async synchronization
// protocol so stale queue deliveries can never overwrite a newer edit.

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { automationBindings, automations, socialAccounts } from "@relayapi/db";
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Context } from "hono";
import { withCredentialMutationAuthority } from "../lib/credential-mutation-authority";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
} from "../lib/workspace-scope";
import {
	BindingConfigByType,
	BindingCreateSchema,
	BindingTypeSchema,
	BindingUpdateSchema,
	getBindingConfigChannelError,
	isBindingTypeSupportedOnChannel,
	isProviderBindingType,
} from "../schemas/automation-bindings";
import { ErrorResponse } from "../schemas/common";
import { enqueueAutomationBindingSync } from "../services/automations/binding-sync";
import type { Env, Variables } from "../types";
import {
	aggregateInsights,
	BindingInsightsQuery,
	InsightsResponseSchema,
} from "./_automation-insights";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BindingRow = typeof automationBindings.$inferSelect;

const BindingResponseSchema = z.object({
	id: z.string(),
	organization_id: z.string(),
	workspace_id: z.string().nullable(),
	social_account_id: z.string(),
	channel: z.enum(["instagram", "facebook", "whatsapp", "telegram"]),
	binding_type: BindingTypeSchema,
	automation_id: z.string(),
	config: z.record(z.string(), z.any()).nullable(),
	status: z.string(),
	desired_active: z.boolean(),
	delete_after_sync: z.boolean(),
	sync_revision: z.number().int(),
	last_synced_revision: z.number().int(),
	sync_attempts: z.number().int(),
	last_synced_at: z.string().nullable(),
	sync_error: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
	// Optional account hydration — populated by list/get via a left-join so the
	// dashboard (canvas binding cards, bindings panel) can render a real handle
	// instead of a truncated id. Omitted on create/update responses.
	social_account: z
		.object({
			id: z.string(),
			handle: z.string().nullable(),
			display_name: z.string().nullable(),
			avatar_url: z.string().nullable(),
		})
		.nullable()
		.optional(),
});

type BindingAccountSummary = {
	id: string;
	username: string | null;
	displayName: string | null;
	avatarUrl: string | null;
};

function serializeBinding(
	row: BindingRow,
	opts?: { account?: BindingAccountSummary | null },
): z.infer<typeof BindingResponseSchema> {
	const base: z.infer<typeof BindingResponseSchema> = {
		id: row.id,
		organization_id: row.organizationId,
		workspace_id: row.workspaceId ?? null,
		social_account_id: row.socialAccountId,
		channel: row.channel as z.infer<typeof BindingResponseSchema>["channel"],
		binding_type: row.bindingType,
		automation_id: row.automationId,
		config: (row.config as Record<string, unknown> | null) ?? null,
		status: row.status,
		desired_active: row.desiredActive,
		delete_after_sync: row.deleteAfterSync,
		sync_revision: row.syncRevision,
		last_synced_revision: row.lastSyncedRevision,
		sync_attempts: row.syncAttempts,
		last_synced_at: row.lastSyncedAt?.toISOString() ?? null,
		sync_error: row.syncError ?? null,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
	// `account.id` is null when a left-join finds no row — guard so we omit
	// the field rather than emit an account with a null id.
	if (opts?.account?.id) {
		base.social_account = {
			id: opts.account.id,
			handle: opts.account.username ?? null,
			display_name: opts.account.displayName ?? null,
			avatar_url: opts.account.avatarUrl ?? null,
		};
	}
	return base;
}

function notFound(c: AppContext) {
	return c.json(
		{ error: { code: "NOT_FOUND", message: "Binding not found" } },
		404,
	);
}

function markBindingMutationNotApplied(c: AppContext): void {
	c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
		kind: "not_applied",
	});
}

function markBindingMutationCommitted(c: AppContext): void {
	c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
		kind: "committed",
		units: 1,
	});
}

async function loadScopedBinding(c: AppContext, id: string) {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const [row] = await db
		.select()
		.from(automationBindings)
		.where(
			and(
				eq(automationBindings.id, id),
				eq(automationBindings.organizationId, orgId),
			),
		)
		.limit(1);
	if (!row) return null;
	const denied = assertWorkspaceScope(c, row.workspaceId);
	if (denied) return { denied };
	return { row };
}

function validateBindingConfig(bindingType: string, config: unknown) {
	const parsedType = BindingTypeSchema.safeParse(bindingType);
	if (!parsedType.success) {
		return {
			success: false,
			error: { issues: [{ message: `unknown binding_type ${bindingType}` }] },
		} as const;
	}
	const schema = BindingConfigByType[parsedType.data];
	return schema.safeParse(config);
}

async function enqueueProviderSyncSafely(
	c: AppContext,
	binding: Pick<BindingRow, "id" | "organizationId" | "syncRevision">,
): Promise<void> {
	try {
		await enqueueAutomationBindingSync(c.get("db"), c.env, binding);
	} catch (error) {
		// The scheduled reconciler re-enqueues rows whose revision has not been
		// acknowledged. The CRUD operation therefore remains durable even if the
		// queue is temporarily unavailable.
		console.error("failed to enqueue automation binding sync", {
			bindingId: binding.id,
			revision: binding.syncRevision,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const IdParams = z.object({ id: z.string() });

const ListQuery = z.object({
	social_account_id: z.string().optional(),
	binding_type: BindingTypeSchema.optional(),
	automation_id: z.string().optional(),
	workspace_id: z.string().optional(),
});

const ListResponse = z.object({ data: z.array(BindingResponseSchema) });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listBindings = createRoute({
	operationId: "listAutomationBindings",
	method: "get",
	path: "/",
	tags: ["Automation Bindings"],
	summary: "List bindings with filters",
	security: [{ Bearer: [] }],
	request: { query: ListQuery },
	responses: {
		200: {
			description: "Binding list",
			content: { "application/json": { schema: ListResponse } },
		},
	},
});

app.openapi(listBindings, async (c) => {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const q = c.req.valid("query");

	const conditions: SQL[] = [eq(automationBindings.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, automationBindings.workspaceId);
	if (q.workspace_id) {
		conditions.push(eq(automationBindings.workspaceId, q.workspace_id));
	}
	if (q.social_account_id) {
		conditions.push(
			eq(automationBindings.socialAccountId, q.social_account_id),
		);
	}
	if (q.binding_type) {
		conditions.push(
			eq(
				automationBindings.bindingType,
				q.binding_type as typeof automationBindings.$inferSelect.bindingType,
			),
		);
	}
	if (q.automation_id) {
		conditions.push(eq(automationBindings.automationId, q.automation_id));
	}

	const rows = await db
		.select({
			binding: automationBindings,
			account: {
				id: socialAccounts.id,
				username: socialAccounts.username,
				displayName: socialAccounts.displayName,
				avatarUrl: socialAccounts.avatarUrl,
			},
		})
		.from(automationBindings)
		.leftJoin(
			socialAccounts,
			and(
				eq(automationBindings.socialAccountId, socialAccounts.id),
				// Scope the joined account to this org so a binding pointing at a
				// foreign account id hydrates to null instead of leaking identity.
				eq(socialAccounts.organizationId, orgId),
			),
		)
		.where(and(...conditions))
		.orderBy(desc(automationBindings.createdAt));

	return c.json(
		{
			data: rows.map((r) =>
				serializeBinding(r.binding, { account: r.account }),
			),
		},
		200,
	);
});

const createBinding = createRoute({
	operationId: "createAutomationBinding",
	method: "post",
	path: "/",
	tags: ["Automation Bindings"],
	summary: "Create a binding for a social account",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: BindingCreateSchema } } },
	},
	responses: {
		201: {
			description: "Created",
			content: { "application/json": { schema: BindingResponseSchema } },
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Automation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description:
				"A binding already exists for this (social_account_id, binding_type)",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — handler may return 403 from assertWorkspaceScope
app.openapi(createBinding, async (c) => {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const body = c.req.valid("json");

	// Validate binding config against per-type schema.
	const parsed = validateBindingConfig(body.binding_type, body.config ?? {});
	if (!parsed.success) {
		markBindingMutationNotApplied(c);
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message: `invalid config for binding_type ${body.binding_type}`,
					details: {
						errors: "error" in parsed ? (parsed.error?.issues ?? []) : [],
					},
				},
			},
			400,
		);
	}

	// Verify the automation belongs to this org + workspace scope.
	const [automation] = await db
		.select()
		.from(automations)
		.where(
			and(
				eq(automations.id, body.automation_id),
				eq(automations.organizationId, orgId),
			),
		)
		.limit(1);
	if (!automation) {
		markBindingMutationNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Automation not found" } },
			404,
		);
	}
	const denied = assertWorkspaceScope(c, automation.workspaceId);
	if (denied) {
		markBindingMutationNotApplied(c);
		return denied;
	}
	if (body.channel !== automation.channel) {
		markBindingMutationNotApplied(c);
		return c.json(
			{
				error: {
					code: "INVALID_CHANNEL",
					message: "Binding channel must match the automation channel",
				},
			},
			400,
		);
	}
	if (!isBindingTypeSupportedOnChannel(body.binding_type, body.channel)) {
		markBindingMutationNotApplied(c);
		return c.json(
			{
				error: {
					code: "UNSUPPORTED_BINDING_CHANNEL",
					message: `${body.binding_type} is not supported on ${body.channel}`,
				},
			},
			400,
		);
	}
	const channelConfigError = getBindingConfigChannelError(
		body.binding_type,
		body.channel,
		parsed.data as Record<string, unknown>,
	);
	if (channelConfigError) {
		markBindingMutationNotApplied(c);
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message: channelConfigError,
				},
			},
			400,
		);
	}
	// Verify the social account belongs to this org. Without this, a caller can
	// bind to another org's account id and then read its handle/display name/
	// avatar back via GET /{id} (account-identity disclosure).
	const bindingWorkspaceId =
		body.workspace_id ?? automation.workspaceId ?? null;
	if (bindingWorkspaceId !== automation.workspaceId) {
		markBindingMutationNotApplied(c);
		return c.json(
			{
				error: {
					code: "INVALID_WORKSPACE",
					message: "Binding workspace must match the automation workspace",
				},
			},
			400,
		);
	}
	const [boundAccount] = await db
		.select({
			id: socialAccounts.id,
			workspaceId: socialAccounts.workspaceId,
			platform: socialAccounts.platform,
			lifecycleStatus: socialAccounts.lifecycleStatus,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, body.social_account_id),
				eq(socialAccounts.organizationId, orgId),
			),
		)
		.limit(1);
	if (!boundAccount) {
		markBindingMutationNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Social account not found" } },
			404,
		);
	}
	if (
		boundAccount.workspaceId !== bindingWorkspaceId ||
		boundAccount.platform !== body.channel ||
		boundAccount.lifecycleStatus !== "active"
	) {
		markBindingMutationNotApplied(c);
		return c.json(
			{
				error: {
					code: "INVALID_ACCOUNT",
					message:
						"Social account, channel, and workspace must match the automation",
				},
			},
			400,
		);
	}

	const providerBinding = isProviderBindingType(body.binding_type);
	let inserted: BindingRow | undefined;
	try {
		const authority = await withCredentialMutationAuthority(
			c,
			{},
			async (tx) => {
				const [liveAutomation] = await tx
					.select({
						id: automations.id,
						workspaceId: automations.workspaceId,
						channel: automations.channel,
					})
					.from(automations)
					.where(
						and(
							eq(automations.id, body.automation_id),
							eq(automations.organizationId, orgId),
						),
					)
					.limit(1)
					.for("update");
				if (!liveAutomation) {
					return { kind: "automation_not_found" } as const;
				}
				const [liveAccount] = await tx
					.select({
						id: socialAccounts.id,
						workspaceId: socialAccounts.workspaceId,
						platform: socialAccounts.platform,
						lifecycleStatus: socialAccounts.lifecycleStatus,
					})
					.from(socialAccounts)
					.where(
						and(
							eq(socialAccounts.id, body.social_account_id),
							eq(socialAccounts.organizationId, orgId),
						),
					)
					.limit(1)
					.for("update");
				if (!liveAccount) return { kind: "account_not_found" } as const;
				if (
					liveAutomation.workspaceId !== bindingWorkspaceId ||
					liveAccount.workspaceId !== bindingWorkspaceId ||
					liveAutomation.channel !== body.channel ||
					liveAccount.platform !== body.channel ||
					liveAccount.lifecycleStatus !== "active"
				) {
					return { kind: "invalid_tuple" } as const;
				}
				const [created] = await tx
					.insert(automationBindings)
					.values({
						organizationId: orgId,
						workspaceId: bindingWorkspaceId,
						socialAccountId: body.social_account_id,
						channel: body.channel,
						bindingType: body.binding_type,
						automationId: body.automation_id,
						config: parsed.data as Record<string, unknown>,
						status: providerBinding ? "pending_sync" : "active",
						desiredActive: true,
						deleteAfterSync: false,
						syncRevision: providerBinding ? 1 : 0,
					})
					.returning();
				return created
					? ({ kind: "created", row: created } as const)
					: ({ kind: "insert_failed" } as const);
			},
		);
		if (!authority.ok) {
			markBindingMutationNotApplied(c);
			return c.json(
				{
					error: { code: authority.code, message: authority.message },
				} as never,
				authority.status as never,
			);
		}
		const result = authority.value;
		if (result.kind === "automation_not_found") {
			markBindingMutationNotApplied(c);
			return c.json(
				{ error: { code: "NOT_FOUND", message: "Automation not found" } },
				404,
			);
		}
		if (result.kind === "account_not_found") {
			markBindingMutationNotApplied(c);
			return c.json(
				{ error: { code: "NOT_FOUND", message: "Social account not found" } },
				404,
			);
		}
		if (result.kind === "invalid_tuple") {
			markBindingMutationNotApplied(c);
			return c.json(
				{
					error: {
						code: "INVALID_BINDING_SCOPE",
						message:
							"Binding, automation, account, channel, and workspace must form one scope tuple",
					},
				},
				400,
			);
		}
		inserted = result.kind === "created" ? result.row : undefined;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/uniq|duplicate|unique/i.test(message)) {
			markBindingMutationNotApplied(c);
			return c.json(
				{
					error: {
						code: "CONFLICT",
						message:
							"A binding already exists for this (social_account_id, binding_type)",
					},
				},
				409,
			);
		}
		throw err;
	}
	if (!inserted) {
		markBindingMutationNotApplied(c);
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "failed to create binding",
				},
			},
			400,
		);
	}
	// The binding row is the durable request authority. Provider sync is a
	// recoverable accelerator whose outcome cannot raise this N=1 request above
	// the already-proven K=1.
	markBindingMutationCommitted(c);
	if (providerBinding) await enqueueProviderSyncSafely(c, inserted);
	return c.json(serializeBinding(inserted), 201);
});

const getBinding = createRoute({
	operationId: "getAutomationBinding",
	method: "get",
	path: "/{id}",
	tags: ["Automation Bindings"],
	summary: "Get a binding",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Binding",
			content: { "application/json": { schema: BindingResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getBinding, async (c) => {
	const { id } = c.req.valid("param");
	const orgId = c.get("orgId");
	const scoped = await loadScopedBinding(c, id);
	if (!scoped) return notFound(c);
	if ("denied" in scoped) return scoped.denied as never;
	const db = c.get("db");
	// Scope the account hydration to this org so a binding that (via legacy data)
	// points at a foreign account never leaks that account's identity.
	const [account] = await db
		.select({
			id: socialAccounts.id,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			avatarUrl: socialAccounts.avatarUrl,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, scoped.row.socialAccountId),
				eq(socialAccounts.organizationId, orgId),
			),
		)
		.limit(1);
	return c.json(
		serializeBinding(scoped.row, { account: account ?? null }),
		200,
	);
});

const updateBinding = createRoute({
	operationId: "updateAutomationBinding",
	method: "patch",
	path: "/{id}",
	tags: ["Automation Bindings"],
	summary: "Update a binding",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: { content: { "application/json": { schema: BindingUpdateSchema } } },
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: BindingResponseSchema } },
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateBinding, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const scoped = await loadScopedBinding(c, id);
	if (!scoped) {
		markBindingMutationNotApplied(c);
		return notFound(c);
	}
	if ("denied" in scoped) {
		markBindingMutationNotApplied(c);
		return scoped.denied as never;
	}
	const existing = scoped.row;
	const orgId = c.get("orgId");
	if (
		!isBindingTypeSupportedOnChannel(existing.bindingType, existing.channel)
	) {
		markBindingMutationNotApplied(c);
		return c.json(
			{
				error: {
					code: "UNSUPPORTED_BINDING_CHANNEL",
					message: `${existing.bindingType} is not supported on ${existing.channel}`,
				},
			},
			400,
		);
	}

	let parsedConfig: Record<string, unknown> | undefined;
	if (body.config !== undefined) {
		const parsed = validateBindingConfig(existing.bindingType, body.config);
		if (!parsed.success) {
			markBindingMutationNotApplied(c);
			return c.json(
				{
					error: {
						code: "VALIDATION_ERROR",
						message: `invalid config for binding_type ${existing.bindingType}`,
						details: {
							errors: "error" in parsed ? (parsed.error?.issues ?? []) : [],
						},
					},
				},
				400,
			);
		}
		parsedConfig = parsed.data as Record<string, unknown>;
		const channelConfigError = getBindingConfigChannelError(
			existing.bindingType,
			existing.channel,
			parsedConfig,
		);
		if (channelConfigError) {
			markBindingMutationNotApplied(c);
			return c.json(
				{
					error: {
						code: "VALIDATION_ERROR",
						message: channelConfigError,
					},
				},
				400,
			);
		}
	}

	const providerBinding = isProviderBindingType(existing.bindingType);
	const desiredActive =
		body.status === undefined
			? existing.desiredActive
			: body.status === "active";
	const patch: PgUpdateSetSource<typeof automationBindings> = providerBinding
		? {
				...(body.automation_id === undefined
					? {}
					: { automationId: body.automation_id }),
				...(parsedConfig === undefined ? {} : { config: parsedConfig }),
				desiredActive,
				deleteAfterSync: false,
				status: "pending_sync",
				syncRevision: sql`${automationBindings.syncRevision} + 1`,
				syncAttempts: 0,
				syncNextAttemptAt: new Date(),
				syncLeaseExpiresAt: null,
				syncStartedAt: null,
				syncRequestMayHaveBeenSentAt: null,
				syncError: null,
				syncErrorClass: null,
				syncErrorAt: null,
				updatedAt: new Date(),
			}
		: {
				...(body.automation_id === undefined
					? {}
					: { automationId: body.automation_id }),
				...(parsedConfig === undefined ? {} : { config: parsedConfig }),
				...(body.status === undefined ? {} : { status: body.status }),
				desiredActive,
				updatedAt: new Date(),
			};
	const prospectiveAutomationId = body.automation_id ?? existing.automationId;

	// Lock the authoritative parent rows in a stable order before mutation so
	// account lifecycle/platform and automation scope/channel cannot change
	// between validation and the binding update.
	const authority = await withCredentialMutationAuthority(c, {}, async (tx) => {
		const [automation] = await tx
			.select({
				id: automations.id,
				workspaceId: automations.workspaceId,
				channel: automations.channel,
			})
			.from(automations)
			.where(
				and(
					eq(automations.id, prospectiveAutomationId),
					eq(automations.organizationId, orgId),
				),
			)
			.limit(1)
			.for("update");
		if (!automation) return { kind: "automation_not_found" } as const;

		const [account] = await tx
			.select({
				id: socialAccounts.id,
				workspaceId: socialAccounts.workspaceId,
				platform: socialAccounts.platform,
				lifecycleStatus: socialAccounts.lifecycleStatus,
			})
			.from(socialAccounts)
			.where(
				and(
					eq(socialAccounts.id, existing.socialAccountId),
					eq(socialAccounts.organizationId, orgId),
				),
			)
			.limit(1)
			.for("update");
		if (!account) return { kind: "account_not_found" } as const;
		if (
			existing.workspaceId !== automation.workspaceId ||
			account.workspaceId !== automation.workspaceId ||
			existing.channel !== automation.channel ||
			account.platform !== automation.channel ||
			account.lifecycleStatus !== "active"
		) {
			return { kind: "invalid_tuple" } as const;
		}

		const [updated] = await tx
			.update(automationBindings)
			.set(patch)
			.where(
				and(
					eq(automationBindings.id, id),
					eq(automationBindings.organizationId, orgId),
				),
			)
			.returning();
		return updated
			? ({ kind: "updated", row: updated } as const)
			: ({ kind: "not_found" } as const);
	});
	if (!authority.ok) {
		markBindingMutationNotApplied(c);
		return c.json(
			{ error: { code: authority.code, message: authority.message } } as never,
			authority.status as never,
		);
	}
	const result = authority.value;

	if (result.kind === "automation_not_found") {
		markBindingMutationNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Automation not found" } },
			404,
		);
	}
	if (result.kind === "account_not_found") {
		markBindingMutationNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Social account not found" } },
			404,
		);
	}
	if (result.kind === "invalid_tuple") {
		markBindingMutationNotApplied(c);
		return c.json(
			{
				error: {
					code: "INVALID_BINDING_SCOPE",
					message:
						"Binding, automation, account, channel, and workspace must form one scope tuple",
				},
			},
			400,
		);
	}
	if (result.kind === "not_found") {
		markBindingMutationNotApplied(c);
		return notFound(c);
	}
	markBindingMutationCommitted(c);
	if (providerBinding) await enqueueProviderSyncSafely(c, result.row);
	return c.json(serializeBinding(result.row), 200);
});

const deleteBinding = createRoute({
	operationId: "deleteAutomationBinding",
	method: "delete",
	path: "/{id}",
	tags: ["Automation Bindings"],
	summary: "Delete a binding",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		204: { description: "Deleted" },
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteBinding, async (c) => {
	const { id } = c.req.valid("param");
	const scoped = await loadScopedBinding(c, id);
	if (!scoped) {
		markBindingMutationNotApplied(c);
		return notFound(c);
	}
	if ("denied" in scoped) {
		markBindingMutationNotApplied(c);
		return scoped.denied as never;
	}

	const db = c.get("db");
	let committed = false;
	if (isProviderBindingType(scoped.row.bindingType)) {
		const [updated] = await db
			.update(automationBindings)
			.set({
				desiredActive: false,
				deleteAfterSync: true,
				status: "pending_sync",
				syncRevision: sql`${automationBindings.syncRevision} + 1`,
				syncAttempts: 0,
				syncNextAttemptAt: new Date(),
				syncLeaseExpiresAt: null,
				syncStartedAt: null,
				syncRequestMayHaveBeenSentAt: null,
				syncError: null,
				syncErrorClass: null,
				syncErrorAt: null,
				updatedAt: new Date(),
			})
			.where(eq(automationBindings.id, id))
			.returning();
		committed = Boolean(updated);
		if (updated) {
			markBindingMutationCommitted(c);
			await enqueueProviderSyncSafely(c, updated);
		}
	} else {
		const [deleted] = await db
			.delete(automationBindings)
			.where(eq(automationBindings.id, id))
			.returning({ id: automationBindings.id });
		committed = Boolean(deleted);
		if (deleted) markBindingMutationCommitted(c);
	}
	if (!committed) markBindingMutationNotApplied(c);
	return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Binding insights (G8)
// ---------------------------------------------------------------------------

const bindingInsights = createRoute({
	operationId: "getAutomationBindingInsights",
	method: "get",
	path: "/{id}/insights",
	tags: ["Automation Bindings"],
	summary: "Aggregate run metrics scoped to a binding",
	security: [{ Bearer: [] }],
	request: { params: IdParams, query: BindingInsightsQuery },
	responses: {
		200: {
			description: "Insights",
			content: { "application/json": { schema: InsightsResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(bindingInsights, async (c) => {
	const { id } = c.req.valid("param");
	const query = c.req.valid("query");
	const scoped = await loadScopedBinding(c, id);
	if (!scoped) return notFound(c);
	if ("denied" in scoped) return scoped.denied as never;

	const db = c.get("db");
	const result = await aggregateInsights(db, query, {
		orgId: c.get("orgId"),
		bindingId: id,
	});
	return c.json(result, 200);
});

export default app;
