import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	posts,
	postTargets,
	socialAccounts,
	socialMutationOperations,
} from "@relayapi/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
	type DiscordThreadContext,
	discordThreadContextFromEffects,
	isDiscordSnowflake,
} from "../lib/discord-message-context";
import { sha256Hex } from "../lib/durable-operation";
import { assertWorkspaceScope } from "../lib/workspace-scope";
import { markMutationInputNotApplied } from "../middleware/mutation-validation";
import { ErrorResponse } from "../schemas/common";
import {
	CreatePublishedEditBody,
	PublishedEditBatchResponse,
	PublishedEditOperationParams,
	PublishedEditParams,
	RequiredSocialMutationHeaders,
	SocialMutationResponse,
} from "../schemas/social-actions";
import {
	getSocialMutation,
	runSocialMutation,
	SocialMutationConflictError,
	serializeSocialMutation,
} from "../services/social-mutation-operations";
import { encryptSocialProjectionPayload } from "../services/social-mutation-projection";
import {
	editPublishedPost,
	SocialProviderActionError,
} from "../services/social-provider-actions";
import { refreshTokenIfNeeded } from "../services/token-refresh-coordinator";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

function resolvePublishedDiscordThreadContext(
	providerEffects: unknown,
	platformOverrides: unknown,
): DiscordThreadContext {
	const confirmed = discordThreadContextFromEffects(providerEffects);
	if (confirmed.required) return confirmed;
	if (
		!platformOverrides ||
		typeof platformOverrides !== "object" ||
		Array.isArray(platformOverrides)
	) {
		return { required: false };
	}
	const rawDiscord = (platformOverrides as Record<string, unknown>).discord;
	if (
		!rawDiscord ||
		typeof rawDiscord !== "object" ||
		Array.isArray(rawDiscord)
	) {
		return { required: false };
	}
	const discord = rawDiscord as Record<string, unknown>;
	if (isDiscordSnowflake(discord.thread_id)) {
		return { required: true, threadId: discord.thread_id.trim() };
	}
	return typeof discord.thread_name === "string" && discord.thread_name.trim()
		? { required: true }
		: { required: false };
}

app.onError((error, c) => {
	if (error instanceof SocialMutationConflictError) {
		markMutationInputNotApplied(c);
		return c.json({ error: { code: error.code, message: error.message } }, 409);
	}
	console.error("[published-edits] request failed", error);
	return c.json(
		{ error: { code: "INTERNAL_ERROR", message: "Published edit failed" } },
		500,
	);
});

const createEdit = createRoute({
	operationId: "createPublishedPostEdit",
	method: "post",
	path: "/{post_id}/edits",
	tags: ["Posts"],
	summary: "Edit one or more published post targets",
	description:
		"Creates an independent durable provider mutation for each explicit target. Partial success is retained. X edits replace the provider Post ID.",
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredSocialMutationHeaders,
		params: PublishedEditParams,
		body: {
			content: { "application/json": { schema: CreatePublishedEditBody } },
		},
	},
	responses: {
		202: {
			description: "Published edit operations accepted or replayed",
			content: { "application/json": { schema: PublishedEditBatchResponse } },
		},
		400: {
			description: "Unsupported target or invalid state",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Post or target not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Idempotency or active-mutation conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getEdit = createRoute({
	operationId: "getPublishedPostEdit",
	method: "get",
	path: "/{post_id}/edits/{operation_id}",
	tags: ["Posts"],
	summary: "Get a published-edit operation",
	security: [{ Bearer: [] }],
	request: { params: PublishedEditOperationParams },
	responses: {
		200: {
			description: "Published-edit operation",
			content: { "application/json": { schema: SocialMutationResponse } },
		},
		404: {
			description: "Operation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const listEdits = createRoute({
	operationId: "listPublishedPostEdits",
	method: "get",
	path: "/{post_id}/edits",
	tags: ["Posts"],
	summary: "List published-edit operations",
	security: [{ Bearer: [] }],
	request: {
		params: PublishedEditParams,
		query: z.object({
			limit: z.coerce.number().int().min(1).max(100).default(20),
		}),
	},
	responses: {
		200: {
			description: "Published-edit operations",
			content: {
				"application/json": {
					schema: z.object({ data: z.array(SocialMutationResponse) }),
				},
			},
		},
		404: {
			description: "Post not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createEdit, async (c) => {
	const db = c.get("db");
	const organizationId = c.get("orgId");
	const { post_id: postId } = c.req.valid("param");
	const { targets: requestedTargets } = c.req.valid("json");
	const operationKey = c.req.valid("header")["idempotency-key"];

	const [post] = await db
		.select()
		.from(posts)
		.where(and(eq(posts.id, postId), eq(posts.organizationId, organizationId)))
		.limit(1);
	if (!post) {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}
	const workspaceDenied = assertWorkspaceScope(c, post.workspaceId);
	if (workspaceDenied) {
		markMutationInputNotApplied(c);
		return workspaceDenied as never;
	}
	if (post.status !== "published" && post.status !== "partial") {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "INVALID_STATE",
					message: "Only published or partially published posts can be edited",
				},
			},
			400,
		);
	}

	const targetIds = requestedTargets.map((target) => target.target_id);
	const rows = await db
		.select({ target: postTargets, account: socialAccounts })
		.from(postTargets)
		.innerJoin(
			socialAccounts,
			and(
				eq(postTargets.socialAccountId, socialAccounts.id),
				eq(postTargets.organizationId, socialAccounts.organizationId),
			),
		)
		.where(
			and(
				eq(postTargets.postId, postId),
				eq(postTargets.organizationId, organizationId),
				inArray(postTargets.id, targetIds),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		);
	if (rows.length !== targetIds.length) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "TARGET_NOT_FOUND",
					message: "One or more post targets are unavailable",
				},
			},
			404,
		);
	}

	const rowById = new Map(rows.map((row) => [row.target.id, row]));
	for (const requested of requestedTargets) {
		const row = rowById.get(requested.target_id);
		if (row?.target.status !== "published" || !row.target.platformPostId) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "TARGET_NOT_PUBLISHED",
						message: `Target ${requested.target_id} is not currently published`,
					},
				},
				400,
			);
		}
		if (
			!new Set(["twitter", "facebook", "discord", "reddit"]).has(
				row.target.platform,
			)
		) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "PUBLISHED_EDIT_UNSUPPORTED",
						message: `Published editing is not supported for ${row.target.platform}`,
					},
				},
				400,
			);
		}
		if (
			requested.expected_provider_post_id !== undefined &&
			requested.expected_provider_post_id !== row.target.platformPostId
		) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "PROVIDER_POST_ID_CHANGED",
						message: `Target ${requested.target_id} no longer has the expected provider Post ID`,
					},
				},
				409,
			);
		}
	}

	const operations = await Promise.all(
		requestedTargets.map(async (requested) => {
			const row = rowById.get(requested.target_id);
			if (!row?.target.platformPostId) {
				throw new Error("Validated published target disappeared");
			}
			const providerPostId = row.target.platformPostId;
			const discordThreadContext =
				row.account.platform === "discord"
					? resolvePublishedDiscordThreadContext(
							row.target.providerEffects,
							post.platformOverrides,
						)
					: { required: false };
			const accessToken = await refreshTokenIfNeeded(c.env, {
				id: row.account.id,
				platform: row.account.platform,
				accessToken: row.account.accessToken,
				refreshToken: row.account.refreshToken,
				tokenExpiresAt: row.account.tokenExpiresAt,
			});
			const logicalPayload = {
				post_id: postId,
				target_id: row.target.id,
				content_hash: await sha256Hex(requested.content),
				expected_provider_post_id:
					requested.expected_provider_post_id ?? providerPostId,
				expected_edit_revision: row.target.editRevision,
				discord_thread_context_required: discordThreadContext.required,
				discord_thread_id: discordThreadContext.threadId ?? null,
			};
			const projectionPayloadCiphertext = await encryptSocialProjectionPayload(
				c.env.ENCRYPTION_KEY,
				{
					organizationId,
					targetType: "post_target",
					targetId: row.target.id,
					kind: "post_edit",
				},
				{ content: requested.content },
			);
			return runSocialMutation({
				db,
				organizationId,
				workspaceId: post.workspaceId,
				accountId: row.account.id,
				platform: row.account.platform,
				targetType: "post_target",
				targetId: row.target.id,
				kind: "post_edit",
				operationKey: `${operationKey}:${row.target.id}`,
				requestPayload: {
					...logicalPayload,
					projection_payload_ciphertext: projectionPayloadCiphertext,
				},
				requestHashPayload: logicalPayload,
				validateBeforeProvider: async () => {
					const [current] = await db
						.select({
							status: postTargets.status,
							platformPostId: postTargets.platformPostId,
							editRevision: postTargets.editRevision,
							providerEffects: postTargets.providerEffects,
						})
						.from(postTargets)
						.where(
							and(
								eq(postTargets.id, row.target.id),
								eq(postTargets.postId, postId),
								eq(postTargets.organizationId, organizationId),
								eq(postTargets.socialAccountId, row.account.id),
								eq(postTargets.platform, row.account.platform),
							),
						)
						.limit(1);
					const currentDiscordThreadContext =
						row.account.platform === "discord"
							? resolvePublishedDiscordThreadContext(
									current?.providerEffects,
									post.platformOverrides,
								)
							: { required: false };
					if (
						current?.status !== "published" ||
						current.platformPostId !== providerPostId ||
						current.editRevision !== row.target.editRevision ||
						currentDiscordThreadContext.required !==
							discordThreadContext.required ||
						currentDiscordThreadContext.threadId !==
							discordThreadContext.threadId
					) {
						throw new SocialProviderActionError(
							"PUBLISHED_EDIT_PRECONDITION_CHANGED",
							"Published target changed while this edit waited for admission",
							{ definitive: true },
						);
					}
				},
				provider: () =>
					editPublishedPost(
						{
							id: row.account.id,
							platform: row.account.platform,
							platformAccountId: row.account.platformAccountId,
							accessToken,
							metadata: row.account.metadata,
						},
						providerPostId,
						requested.content,
						{
							discordThreadContextRequired: discordThreadContext.required,
							discordThreadId: discordThreadContext.threadId,
						},
					),
				project: async (result, operation) => {
					const now = new Date();
					const currentHistory = row.target.platformPostIdHistory ?? [];
					const [updated] = await db
						.update(postTargets)
						.set({
							platformPostId: result.providerId ?? providerPostId,
							confirmedContent: requested.content,
							editRevision: row.target.editRevision + 1,
							lastEditedAt: now,
							platformPostIdHistory:
								result.providerId && result.providerId !== providerPostId
									? [
											...currentHistory,
											{
												id: providerPostId,
												replaced_at: now.toISOString(),
												operation_id: operation.id,
											},
										]
									: currentHistory,
							updatedAt: now,
						})
						.where(
							and(
								eq(postTargets.id, row.target.id),
								eq(postTargets.postId, postId),
								eq(postTargets.organizationId, organizationId),
								eq(postTargets.socialAccountId, row.account.id),
								eq(postTargets.platform, row.account.platform),
								eq(postTargets.platformPostId, providerPostId),
								eq(postTargets.editRevision, row.target.editRevision),
							),
						)
						.returning({ id: postTargets.id });
					if (!updated) {
						throw new Error("Published target projection changed");
					}
				},
			});
		}),
	);

	const completed = operations.filter(
		(operation) => operation.status === "completed",
	).length;
	const failed = operations.filter(
		(operation) => operation.status === "failed",
	).length;
	const unknown = operations.length - completed - failed;
	const tracker = c.get("mutationEffectTracker");
	tracker?.setAuthoritativeOutcome(
		completed > 0
			? { kind: "committed", units: 1 }
			: unknown > 0
				? { kind: "unknown" }
				: { kind: "not_applied" },
	);
	return c.json(
		{
			data: operations.map(serializeSocialMutation),
			completed,
			failed,
			unknown,
			partial: completed > 0 && completed < operations.length,
		},
		202,
	);
});

app.openapi(getEdit, async (c) => {
	const organizationId = c.get("orgId");
	const { post_id: postId, operation_id: operationId } = c.req.valid("param");
	const operation = await getSocialMutation(
		c.get("db"),
		organizationId,
		operationId,
	);
	if (
		operation?.targetType !== "post_target" ||
		operation.kind !== "post_edit" ||
		(operation.requestPayload as Record<string, unknown>).post_id !== postId
	) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Published-edit operation not found",
				},
			},
			404,
		);
	}
	const denied = assertWorkspaceScope(c, operation.workspaceId);
	if (denied) return denied as never;
	return c.json(serializeSocialMutation(operation), 200);
});

app.openapi(listEdits, async (c) => {
	const db = c.get("db");
	const organizationId = c.get("orgId");
	const { post_id: postId } = c.req.valid("param");
	const { limit } = c.req.valid("query");
	const [post] = await db
		.select({ workspaceId: posts.workspaceId })
		.from(posts)
		.where(and(eq(posts.id, postId), eq(posts.organizationId, organizationId)))
		.limit(1);
	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}
	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) return denied as never;
	const targetRows = await db
		.select({ id: postTargets.id })
		.from(postTargets)
		.where(
			and(
				eq(postTargets.postId, postId),
				eq(postTargets.organizationId, organizationId),
			),
		);
	if (targetRows.length === 0) return c.json({ data: [] }, 200);
	const rows = await db
		.select()
		.from(socialMutationOperations)
		.where(
			and(
				eq(socialMutationOperations.organizationId, organizationId),
				eq(socialMutationOperations.targetType, "post_target"),
				eq(socialMutationOperations.kind, "post_edit"),
				inArray(
					socialMutationOperations.targetId,
					targetRows.map((target) => target.id),
				),
			),
		)
		.orderBy(
			desc(socialMutationOperations.createdAt),
			desc(socialMutationOperations.id),
		)
		.limit(limit);
	return c.json({ data: rows.map(serializeSocialMutation) }, 200);
});

export default app;
