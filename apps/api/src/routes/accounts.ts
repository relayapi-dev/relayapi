import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createDb, socialAccounts, socialAccountSyncState, workspaces } from "@relayapi/db";
import { and, desc, eq, isNull, gt, or, ilike, inArray } from "drizzle-orm";
import { getOwnedAccount } from "../lib/accounts";
import { deleteConnectedAccountGraph } from "../lib/delete-account";
import { maybeDecrypt } from "../lib/crypto";
import { isBlockedUrlWithDns } from "../lib/ssrf-guard";
import { dispatchWebhookEvent } from "../services/webhook-delivery";
import { logConnectionEvent } from "./connections";
import {
	AccountHealthResponse,
	AccountListResponse,
	AccountResponse,
	FacebookPagesResponse,
	GmbLocationsResponse,
	LinkedInOrgsResponse,
	PinterestBoardsResponse,
	RedditFlairsResponse,
	RedditSubredditsResponse,
	SetFacebookPageBody,
	SetGmbLocationBody,
	SetLinkedInOrgBody,
	SetPinterestBoardBody,
	SetRedditSubredditBody,
	SetYouTubePlaylistBody,
	TikTokCreatorInfoResponse,
	UpdateAccountBody,
	YouTubePlaylistsResponse,
} from "../schemas/accounts";
import { ErrorResponse, IdParam, PaginationParams, type Platform } from "../schemas/common";
import type { Env, Variables } from "../types";
import { applyWorkspaceScope, assertWorkspaceScope } from "../lib/workspace-scope";
import { assertAllWorkspaceScope } from "../lib/request-access";
import { getSupportedSyncPlatforms } from "../services/external-post-sync/index";
import type { SyncPostsMessage } from "../services/external-post-sync/types";
import {
	mergePublicSocialAccountMetadata,
	sanitizeSocialAccountMetadata,
} from "../services/ad-access-token";
import { fetchAvatarUrl } from "../services/token-refresh";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Route definitions ---

const AccountListQuery = PaginationParams.extend({
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
	ungrouped: z.coerce.boolean().optional().describe("Only show ungrouped accounts"),
	search: z.string().optional().describe("Search by name or username"),
	platforms: z.string().optional().describe("Comma-separated platform filter (e.g. instagram,facebook)"),
});

const listAccounts = createRoute({
	operationId: "listAccounts",
	method: "get",
	path: "/",
	tags: ["Accounts"],
	summary: "List connected accounts",
	security: [{ Bearer: [] }],
	request: { query: AccountListQuery },
	responses: {
		200: {
			description: "List of accounts",
			content: { "application/json": { schema: AccountListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getAccount = createRoute({
	operationId: "getAccount",
	method: "get",
	path: "/{id}",
	tags: ["Accounts"],
	summary: "Get a connected account",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Account details",
			content: { "application/json": { schema: AccountResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteAccount = createRoute({
	operationId: "disconnectAccount",
	method: "delete",
	path: "/{id}",
	tags: ["Accounts"],
	summary: "Disconnect a social account",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Account disconnected" },
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const HealthCheckQuery = z.object({
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Number of items per page"),
});

const healthCheck = createRoute({
	operationId: "accountsHealth",
	method: "get",
	path: "/health",
	tags: ["Accounts"],
	summary: "Check health of all connected accounts",
	security: [{ Bearer: [] }],
	request: { query: HealthCheckQuery },
	responses: {
		200: {
			description: "Account health status",
			content: { "application/json": { schema: AccountHealthResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const singleHealthCheck = createRoute({
	operationId: "accountHealth",
	method: "get",
	path: "/{id}/health",
	tags: ["Accounts"],
	summary: "Check health of a single connected account",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Account health status",
			content: {
				"application/json": {
					schema: z.object({
						id: z.string(),
						platform: z.string(),
						username: z.string().nullable(),
						display_name: z.string().nullable(),
						avatar_url: z.string().nullable(),
						healthy: z.boolean(),
						token_expires_at: z.string().nullable(),
						scopes: z.array(z.string()),
						sync: z
							.object({
								enabled: z.boolean(),
								last_sync_at: z.string().nullable(),
								next_sync_at: z.string().nullable(),
								total_posts_synced: z.number(),
								total_sync_runs: z.number(),
								last_error: z.string().nullable(),
								last_error_at: z.string().nullable(),
								consecutive_errors: z.number(),
								rate_limit_reset_at: z.string().nullable(),
							})
							.nullable()
							.optional(),
						error: z
							.object({
								code: z.string(),
								message: z.string(),
							})
							.optional(),
					}),
				},
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Route handlers ---

// Single account health must be before /{id} catch-all GET
// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(singleHealthCheck, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [row] = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			avatarUrl: socialAccounts.avatarUrl,
			tokenExpiresAt: socialAccounts.tokenExpiresAt,
			scopes: socialAccounts.scopes,
			workspaceId: socialAccounts.workspaceId,
			syncEnabled: socialAccountSyncState.enabled,
			lastSyncAt: socialAccountSyncState.lastSyncAt,
			nextSyncAt: socialAccountSyncState.nextSyncAt,
			totalPostsSynced: socialAccountSyncState.totalPostsSynced,
			totalSyncRuns: socialAccountSyncState.totalSyncRuns,
			lastError: socialAccountSyncState.lastError,
			lastErrorAt: socialAccountSyncState.lastErrorAt,
			consecutiveErrors: socialAccountSyncState.consecutiveErrors,
			rateLimitResetAt: socialAccountSyncState.rateLimitResetAt,
		})
		.from(socialAccounts)
		.leftJoin(
			socialAccountSyncState,
			eq(socialAccounts.id, socialAccountSyncState.socialAccountId),
		)
		.where(
			and(eq(socialAccounts.id, id), eq(socialAccounts.organizationId, orgId)),
		)
		.limit(1);

	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, row.workspaceId);
	if (denied) return denied;

	const now = new Date();
	const expired = row.tokenExpiresAt
		? row.tokenExpiresAt < now
		: false;
	const isOnSyncPlatform = getSupportedSyncPlatforms().includes(row.platform);
	const syncErrors = row.consecutiveErrors ?? 0;
	const hasSyncFailure = isOnSyncPlatform && row.syncEnabled === true && syncErrors >= 3;

	const sync =
		isOnSyncPlatform && row.syncEnabled != null
			? {
					enabled: row.syncEnabled,
					last_sync_at: row.lastSyncAt?.toISOString() ?? null,
					next_sync_at: row.nextSyncAt?.toISOString() ?? null,
					total_posts_synced: row.totalPostsSynced ?? 0,
					total_sync_runs: row.totalSyncRuns ?? 0,
					last_error: row.lastError ?? null,
					last_error_at: row.lastErrorAt?.toISOString() ?? null,
					consecutive_errors: syncErrors,
					rate_limit_reset_at: row.rateLimitResetAt?.toISOString() ?? null,
				}
			: null;

	return c.json(
		{
			id: row.id,
			platform: row.platform,
			username: row.username,
			display_name: row.displayName ?? null,
			avatar_url: row.avatarUrl ?? null,
			healthy: !expired && !hasSyncFailure,
			token_expires_at: row.tokenExpiresAt?.toISOString() ?? null,
			scopes: row.scopes ?? [],
			sync,
			...(expired
				? {
						error: {
							code: "TOKEN_EXPIRED",
							message: `${row.platform} access token expired. Please reconnect.`,
						},
					}
				: hasSyncFailure
					? {
							error: {
								code: "SYNC_FAILING",
								message: `Post sync has failed ${syncErrors} times consecutively.`,
							},
						}
					: {}),
		},
		200,
	);
});

app.openapi(healthCheck, async (c) => {
	const orgId = c.get("orgId");
	const { cursor, limit } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const conditions = [eq(socialAccounts.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, socialAccounts.workspaceId);

	// Cursor pagination
	if (cursor) {
		conditions.push(gt(socialAccounts.id, cursor));
	}

	const accounts = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			avatarUrl: socialAccounts.avatarUrl,
			tokenExpiresAt: socialAccounts.tokenExpiresAt,
			scopes: socialAccounts.scopes,
			workspaceId: socialAccounts.workspaceId,
			workspaceName: workspaces.name,
			syncEnabled: socialAccountSyncState.enabled,
			lastSyncAt: socialAccountSyncState.lastSyncAt,
			nextSyncAt: socialAccountSyncState.nextSyncAt,
			totalPostsSynced: socialAccountSyncState.totalPostsSynced,
			totalSyncRuns: socialAccountSyncState.totalSyncRuns,
			lastError: socialAccountSyncState.lastError,
			lastErrorAt: socialAccountSyncState.lastErrorAt,
			consecutiveErrors: socialAccountSyncState.consecutiveErrors,
			rateLimitResetAt: socialAccountSyncState.rateLimitResetAt,
		})
		.from(socialAccounts)
		.leftJoin(workspaces, eq(socialAccounts.workspaceId, workspaces.id))
		.leftJoin(
			socialAccountSyncState,
			eq(socialAccounts.id, socialAccountSyncState.socialAccountId),
		)
		.where(and(...conditions))
		.orderBy(socialAccounts.id)
		.limit(limit + 1);

	const hasMore = accounts.length > limit;
	const page = accounts.slice(0, limit);

	const supportedPlatforms = getSupportedSyncPlatforms();

	const data = page.map((a) => {
		const now = new Date();
		const expired = a.tokenExpiresAt ? a.tokenExpiresAt < now : false;
		const isOnSyncPlatform = supportedPlatforms.includes(a.platform);
		const syncErrors = a.consecutiveErrors ?? 0;
		const hasSyncFailure = isOnSyncPlatform && a.syncEnabled === true && syncErrors >= 3;

		const sync =
			isOnSyncPlatform && a.syncEnabled != null
				? {
						enabled: a.syncEnabled,
						last_sync_at: a.lastSyncAt?.toISOString() ?? null,
						next_sync_at: a.nextSyncAt?.toISOString() ?? null,
						total_posts_synced: a.totalPostsSynced ?? 0,
						total_sync_runs: a.totalSyncRuns ?? 0,
						last_error: a.lastError ?? null,
						last_error_at: a.lastErrorAt?.toISOString() ?? null,
						consecutive_errors: syncErrors,
						rate_limit_reset_at: a.rateLimitResetAt?.toISOString() ?? null,
					}
				: null;

		return {
			id: a.id,
			platform: a.platform,
			username: a.username,
			display_name: a.displayName ?? null,
			avatar_url: a.avatarUrl ?? null,
			healthy: !expired && !hasSyncFailure,
			token_expires_at: a.tokenExpiresAt?.toISOString() ?? null,
			scopes: a.scopes ?? [],
			workspace: a.workspaceId && a.workspaceName
				? { id: a.workspaceId, name: a.workspaceName }
				: null,
			sync,
			...(expired
				? {
						error: {
							code: "TOKEN_EXPIRED",
							message: `${a.platform} access token expired. Please reconnect.`,
						},
					}
				: hasSyncFailure
					? {
							error: {
								code: "SYNC_FAILING",
								message: `Post sync has failed ${syncErrors} times consecutively.`,
							},
						}
					: {}),
		};
	});

	return c.json(
		{
			data,
			next_cursor: hasMore ? data[data.length - 1]!.id : null,
			has_more: hasMore,
		},
		200,
	);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(listAccounts, async (c) => {
	const orgId = c.get("orgId");
	const { limit, cursor, workspace_id, ungrouped, search, platforms } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const conditions = [eq(socialAccounts.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, socialAccounts.workspaceId);
	if (workspace_id) {
		conditions.push(eq(socialAccounts.workspaceId, workspace_id));
	} else if (ungrouped) {
		conditions.push(isNull(socialAccounts.workspaceId));
	}
	if (search) {
		conditions.push(
			or(
				ilike(socialAccounts.displayName, `%${search.replace(/[%_\\]/g, "\\$&")}%`),
				ilike(socialAccounts.username, `%${search.replace(/[%_\\]/g, "\\$&")}%`),
			)!,
		);
	}
	if (platforms) {
		const platformList = platforms.split(",").map((p) => p.trim()).filter(Boolean) as (typeof socialAccounts.platform.enumValues)[number][];
		if (platformList.length > 0) {
			conditions.push(inArray(socialAccounts.platform, platformList));
		}
	}
	if (cursor) {
		conditions.push(gt(socialAccounts.id, cursor));
	}

	const accounts = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			platformAccountId: socialAccounts.platformAccountId,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			avatarUrl: socialAccounts.avatarUrl,
			metadata: socialAccounts.metadata,
			workspaceId: socialAccounts.workspaceId,
			connectedAt: socialAccounts.connectedAt,
			updatedAt: socialAccounts.updatedAt,
			workspaceName: workspaces.name,
		})
		.from(socialAccounts)
		.leftJoin(workspaces, eq(socialAccounts.workspaceId, workspaces.id))
		.where(and(...conditions))
		.orderBy(desc(socialAccounts.connectedAt))
		.limit(limit + 1);

	const hasMore = accounts.length > limit;
	const data = accounts.slice(0, limit);

	return c.json(
		{
			data: data.map((a) => ({
				id: a.id,
				platform: a.platform,
				platform_account_id: a.platformAccountId,
				username: a.username,
				display_name: a.displayName,
				avatar_url: a.avatarUrl,
				metadata: sanitizeSocialAccountMetadata(a.metadata),
				workspace: a.workspaceId ? { id: a.workspaceId, name: a.workspaceName } : null,
				connected_at: a.connectedAt.toISOString(),
				updated_at: a.updatedAt.toISOString(),
			})),
			next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getAccount, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [account] = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			platformAccountId: socialAccounts.platformAccountId,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			avatarUrl: socialAccounts.avatarUrl,
			metadata: socialAccounts.metadata,
			workspaceId: socialAccounts.workspaceId,
			connectedAt: socialAccounts.connectedAt,
			updatedAt: socialAccounts.updatedAt,
		})
		.from(socialAccounts)
		.where(
			and(eq(socialAccounts.id, id), eq(socialAccounts.organizationId, orgId)),
		)
		.limit(1);

	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	return c.json(
		{
			id: account.id,
			platform: account.platform,
			platform_account_id: account.platformAccountId,
			username: account.username,
			display_name: account.displayName,
			avatar_url: account.avatarUrl,
			metadata: sanitizeSocialAccountMetadata(account.metadata),
			connected_at: account.connectedAt.toISOString(),
			updated_at: account.updatedAt.toISOString(),
		},
		200,
	);
});

app.openapi(deleteAccount, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [account] = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			workspaceId: socialAccounts.workspaceId,
		})
		.from(socialAccounts)
		.where(
			and(eq(socialAccounts.id, id), eq(socialAccounts.organizationId, orgId)),
		)
		.limit(1);

	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	try {
		await deleteConnectedAccountGraph(db, id);
		console.log(`[accounts] Deleted account ${id} successfully`);
	} catch (err) {
		console.error(`[accounts] Failed to delete account ${id}:`, err);
		return c.json(
			{ error: { code: "DELETE_FAILED", message: "Failed to delete account" } },
			500,
		);
	}

	c.executionCtx.waitUntil(
		dispatchWebhookEvent(c.env, db, orgId, "account.disconnected", {
			account_id: account.id,
			platform: account.platform,
			username: account.username,
			display_name: account.displayName,
		}),
	);
	c.executionCtx.waitUntil(
		logConnectionEvent(c.env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "disconnected",
			message: `Disconnected ${account.displayName || account.username || account.platform} account`,
		}),
	);

	return c.body(null, 204);
});

// --- PATCH /{id} — Update account metadata ---

const updateAccount = createRoute({
	operationId: "updateAccount",
	method: "patch",
	path: "/{id}",
	tags: ["Accounts"],
	summary: "Update account metadata",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: UpdateAccountBody } },
		},
	},
	responses: {
		200: {
			description: "Account updated",
			content: { "application/json": { schema: AccountResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(updateAccount, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [account] = await db
		.select({ id: socialAccounts.id, metadata: socialAccounts.metadata, workspaceId: socialAccounts.workspaceId })
		.from(socialAccounts)
		.where(
			and(eq(socialAccounts.id, id), eq(socialAccounts.organizationId, orgId)),
		)
		.limit(1);

	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (body.metadata !== undefined) {
		updates.metadata = mergePublicSocialAccountMetadata(
			account.metadata,
			body.metadata,
		);
	}
	if (body.display_name !== undefined) {
		updates.displayName = body.display_name;
	}
	if (body.workspace_id !== undefined) {
		const workspaceChangeDenied = assertAllWorkspaceScope(
			c,
			"Reassigning account workspaces requires an API key with access to all workspaces.",
		);
		if (workspaceChangeDenied) return workspaceChangeDenied;

		// SECURITY: Validate workspace belongs to this org to prevent cross-org assignment
		if (body.workspace_id !== null) {
			const [ws] = await db
				.select({ id: workspaces.id })
				.from(workspaces)
				.where(and(eq(workspaces.id, body.workspace_id), eq(workspaces.organizationId, orgId)))
				.limit(1);
			if (!ws) {
				return c.json(
					{ error: { code: "NOT_FOUND", message: "Workspace not found" } } as never,
					404 as never,
				);
			}
		}
		updates.workspaceId = body.workspace_id;
	}

	// Use .returning() to avoid a second SELECT, then fetch group name only if needed
	const [updatedRow] = await db.update(socialAccounts).set(updates).where(eq(socialAccounts.id, id)).returning({
		id: socialAccounts.id,
		platform: socialAccounts.platform,
		platformAccountId: socialAccounts.platformAccountId,
		username: socialAccounts.username,
		displayName: socialAccounts.displayName,
		avatarUrl: socialAccounts.avatarUrl,
		metadata: socialAccounts.metadata,
		workspaceId: socialAccounts.workspaceId,
		connectedAt: socialAccounts.connectedAt,
		updatedAt: socialAccounts.updatedAt,
	});

	if (!updatedRow) {
		return c.json({ error: { code: "NOT_FOUND", message: "Account not found" } }, 404);
	}

	let workspaceName: string | null = null;
	if (updatedRow.workspaceId) {
		const [group] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, updatedRow.workspaceId)).limit(1);
		workspaceName = group?.name ?? null;
	}

	return c.json(
		{
			id: updatedRow.id,
			platform: updatedRow.platform,
			platform_account_id: updatedRow.platformAccountId,
			username: updatedRow.username,
			display_name: updatedRow.displayName,
			avatar_url: updatedRow.avatarUrl,
			metadata: sanitizeSocialAccountMetadata(updatedRow.metadata),
			workspace: updatedRow.workspaceId ? { id: updatedRow.workspaceId, name: workspaceName } : null,
			connected_at: updatedRow.connectedAt.toISOString(),
			updated_at: updatedRow.updatedAt.toISOString(),
		},
		200,
	);
});

// ---------------------------------------------------------------------------
// Platform-specific endpoints
// ---------------------------------------------------------------------------


function formatAccountResult(account: {
	id: string;
	platform: string;
	platformAccountId: string;
	username: string | null;
	displayName: string | null;
	avatarUrl: string | null;
	metadata: unknown;
	connectedAt: Date;
	updatedAt: Date;
}) {
	return {
		id: account.id,
		platform: account.platform,
		platform_account_id: account.platformAccountId,
		username: account.username,
		display_name: account.displayName,
		avatar_url: account.avatarUrl,
		metadata: sanitizeSocialAccountMetadata(account.metadata),
		connected_at: account.connectedAt.toISOString(),
		updated_at: account.updatedAt.toISOString(),
	};
}

// --- Facebook Pages ---

const getFacebookPages = createRoute({
	operationId: "getFacebookPages",
	method: "get",
	path: "/{id}/facebook-pages",
	tags: ["Accounts"],
	summary: "Fetch Facebook pages for an account",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Facebook pages",
			content: { "application/json": { schema: FacebookPagesResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const setFacebookPage = createRoute({
	operationId: "setFacebookPage",
	method: "put",
	path: "/{id}/facebook-pages",
	tags: ["Accounts"],
	summary: "Set default Facebook page",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: SetFacebookPageBody } },
		},
	},
	responses: {
		200: {
			description: "Default page set",
			content: { "application/json": { schema: AccountResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getFacebookPages, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getOwnedAccount(db, id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	if (!account.accessToken) {
		return c.json({ data: [] }, 200);
	}

	try {
		const res = await fetch(
			`https://graph.facebook.com/v25.0/me/accounts?access_token=${account.accessToken}`,
		);
		if (!res.ok) {
			return c.json({ data: [] }, 200);
		}
		const json = (await res.json()) as {
			data: Array<{
				id: string;
				name: string;
				access_token: string;
				category: string;
			}>;
		};
		return c.json(
			{
				data: json.data.map((p) => ({
					id: p.id,
					name: p.name,
					category: p.category,
				})),
			},
			200,
		);
	} catch {
		return c.json({ data: [] }, 200);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(setFacebookPage, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getOwnedAccount(db, id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	const metadata = {
		...(account.metadata as object),
		default_page_id: body.page_id,
	};
	await db
		.update(socialAccounts)
		.set({ metadata, updatedAt: new Date() })
		.where(eq(socialAccounts.id, id));

	return c.json(
		formatAccountResult({ ...account, metadata, updatedAt: new Date() }),
		200,
	);
});

// --- LinkedIn Organizations ---

const getLinkedInOrgs = createRoute({
	operationId: "getLinkedInOrganizations",
	method: "get",
	path: "/{id}/linkedin-organizations",
	tags: ["Accounts"],
	summary: "Fetch LinkedIn organizations for an account",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "LinkedIn organizations",
			content: { "application/json": { schema: LinkedInOrgsResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const setLinkedInOrg = createRoute({
	operationId: "setLinkedInOrganization",
	method: "put",
	path: "/{id}/linkedin-organizations",
	tags: ["Accounts"],
	summary: "Switch LinkedIn account type",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: SetLinkedInOrgBody } },
		},
	},
	responses: {
		200: {
			description: "Account type updated",
			content: { "application/json": { schema: AccountResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getLinkedInOrgs, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getOwnedAccount(db, id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	if (!account.accessToken) {
		return c.json({ data: [] }, 200);
	}

	try {
		// LinkedIn Organization Access Control API — List organizations by role
		// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role
		const res = await fetch(
			"https://api.linkedin.com/v2/organizationAcls?q=roleAssignee",
			{
				headers: { Authorization: `Bearer ${account.accessToken}` },
			},
		);
		if (!res.ok) {
			return c.json({ data: [] }, 200);
		}
		const json = (await res.json()) as {
			elements: Array<{
				organization: string;
				organizationId: number;
			}>;
		};
		return c.json(
			{
				data: json.elements.map((e) => ({
					id: String(e.organizationId),
					name: e.organization,
				})),
			},
			200,
		);
	} catch {
		return c.json({ data: [] }, 200);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(setLinkedInOrg, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getOwnedAccount(db, id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	const metadata = {
		...(account.metadata as object),
		linkedin_organization_id: body.organization_id,
		linkedin_account_type: body.account_type,
	};
	await db
		.update(socialAccounts)
		.set({ metadata, updatedAt: new Date() })
		.where(eq(socialAccounts.id, id));

	return c.json(
		formatAccountResult({ ...account, metadata, updatedAt: new Date() }),
		200,
	);
});

// --- Pinterest Boards ---

const getPinterestBoards = createRoute({
	operationId: "getPinterestBoards",
	method: "get",
	path: "/{id}/pinterest-boards",
	tags: ["Accounts"],
	summary: "Fetch Pinterest boards for an account",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Pinterest boards",
			content: {
				"application/json": { schema: PinterestBoardsResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const setPinterestBoard = createRoute({
	operationId: "setPinterestBoard",
	method: "put",
	path: "/{id}/pinterest-boards",
	tags: ["Accounts"],
	summary: "Set default Pinterest board",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: {
				"application/json": { schema: SetPinterestBoardBody },
			},
		},
	},
	responses: {
		200: {
			description: "Default board set",
			content: { "application/json": { schema: AccountResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getPinterestBoards, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getOwnedAccount(db, id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	if (!account.accessToken) {
		return c.json({ data: [] }, 200);
	}

	try {
		// Pinterest Boards API — List boards for the authenticated user
		// https://developers.pinterest.com/docs/api/v5/boards-list/
		const res = await fetch("https://api.pinterest.com/v5/boards", {
			headers: { Authorization: `Bearer ${account.accessToken}` },
		});
		if (!res.ok) {
			return c.json({ data: [] }, 200);
		}
		const json = (await res.json()) as {
			items: Array<{
				id: string;
				name: string;
				description: string;
			}>;
		};
		return c.json(
			{
				data: (json.items ?? []).map((b) => ({
					id: b.id,
					name: b.name,
					description: b.description,
				})),
			},
			200,
		);
	} catch {
		return c.json({ data: [] }, 200);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(setPinterestBoard, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getOwnedAccount(db, id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	const metadata = {
		...(account.metadata as object),
		default_board_id: body.board_id,
	};
	await db
		.update(socialAccounts)
		.set({ metadata, updatedAt: new Date() })
		.where(eq(socialAccounts.id, id));

	return c.json(
		formatAccountResult({ ...account, metadata, updatedAt: new Date() }),
		200,
	);
});

// --- Reddit Subreddits ---

const getRedditSubreddits = createRoute({
	operationId: "getRedditSubreddits",
	method: "get",
	path: "/{id}/reddit-subreddits",
	tags: ["Accounts"],
	summary: "Fetch Reddit subreddits for an account",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Reddit subreddits",
			content: {
				"application/json": { schema: RedditSubredditsResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const setRedditSubreddit = createRoute({
	operationId: "setRedditSubreddit",
	method: "put",
	path: "/{id}/reddit-subreddits",
	tags: ["Accounts"],
	summary: "Set default Reddit subreddit",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: {
				"application/json": { schema: SetRedditSubredditBody },
			},
		},
	},
	responses: {
		200: {
			description: "Default subreddit set",
			content: { "application/json": { schema: AccountResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getRedditFlairs = createRoute({
	operationId: "getRedditFlairs",
	method: "get",
	path: "/{id}/reddit-flairs",
	tags: ["Accounts"],
	summary: "Fetch Reddit flairs for a subreddit",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		query: z.object({
			subreddit: z.string().describe("Subreddit name"),
		}),
	},
	responses: {
		200: {
			description: "Reddit flairs",
			content: {
				"application/json": { schema: RedditFlairsResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getRedditSubreddits, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getOwnedAccount(db, id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	if (!account.accessToken) {
		return c.json({ data: [] }, 200);
	}

	try {
		// Reddit API: List subreddits the authenticated user is subscribed to
		// https://www.reddit.com/dev/api/#GET_subreddits_mine_{where}
		const res = await fetch(
			"https://oauth.reddit.com/subreddits/mine/subscriber?limit=100",
			{
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					"User-Agent": "RelayAPI/1.0",
				},
			},
		);
		if (!res.ok) {
			return c.json({ data: [] }, 200);
		}
		const json = (await res.json()) as {
			data: {
				children: Array<{
					data: {
						display_name: string;
						title: string;
						subscribers: number;
						icon_img: string;
					};
				}>;
			};
		};
		return c.json(
			{
				data: json.data.children.map((s) => ({
					name: s.data.display_name,
					title: s.data.title,
					subscribers: s.data.subscribers,
					icon_url: s.data.icon_img || null,
				})),
			},
			200,
		);
	} catch {
		return c.json({ data: [] }, 200);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(setRedditSubreddit, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getOwnedAccount(db, id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	const metadata = {
		...(account.metadata as object),
		default_subreddit: body.subreddit,
	};
	await db
		.update(socialAccounts)
		.set({ metadata, updatedAt: new Date() })
		.where(eq(socialAccounts.id, id));

	return c.json(
		formatAccountResult({ ...account, metadata, updatedAt: new Date() }),
		200,
	);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getRedditFlairs, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { subreddit } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getOwnedAccount(db, id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	if (!account.accessToken) {
		return c.json({ data: [] }, 200);
	}

	try {
		// Reddit API: Get available link flairs for a subreddit
		// https://www.reddit.com/dev/api/#GET_api_link_flair_v2
		const res = await fetch(
			`https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/api/link_flair_v2`,
			{
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					"User-Agent": "RelayAPI/1.0",
				},
			},
		);
		if (!res.ok) {
			return c.json({ data: [] }, 200);
		}
		const json = (await res.json()) as Array<{
			id: string;
			text: string;
			text_color: string;
			background_color: string;
		}>;
		return c.json(
			{
				data: json.map((f) => ({
					id: f.id,
					text: f.text,
					text_color: f.text_color,
					background_color: f.background_color,
				})),
			},
			200,
		);
	} catch {
		return c.json({ data: [] }, 200);
	}
});

// --- Google My Business Locations ---

const getGmbLocations = createRoute({
	operationId: "getGmbLocations",
	method: "get",
	path: "/{id}/gmb-locations",
	tags: ["Accounts"],
	summary: "Fetch Google My Business locations",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "GMB locations",
			content: {
				"application/json": { schema: GmbLocationsResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const setGmbLocation = createRoute({
	operationId: "setGmbLocation",
	method: "put",
	path: "/{id}/gmb-locations",
	tags: ["Accounts"],
	summary: "Set default GMB location",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: {
				"application/json": { schema: SetGmbLocationBody },
			},
		},
	},
	responses: {
		200: {
			description: "Default location set",
			content: { "application/json": { schema: AccountResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getGmbLocations, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getOwnedAccount(db, id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	if (!account.accessToken) {
		return c.json({ data: [] }, 200);
	}

	try {
		// First get accounts
		// Google Business Profile — List accounts
		// https://developers.google.com/my-business/reference/accountmanagement/rest/v1/accounts/list
		const accountsRes = await fetch(
			"https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
			{
				headers: { Authorization: `Bearer ${account.accessToken}` },
			},
		);
		if (!accountsRes.ok) {
			return c.json({ data: [] }, 200);
		}
		const accountsJson = (await accountsRes.json()) as {
			accounts: Array<{ name: string }>;
		};
		const gmbAccount = accountsJson.accounts?.[0];
		if (!gmbAccount) {
			return c.json({ data: [] }, 200);
		}

		// Then get locations
		// Google Business Profile — List locations for an account
		// https://developers.google.com/my-business/reference/businessinformation/rest/v1/accounts.locations/list
		const locationsRes = await fetch(
			`https://mybusinessbusinessinformation.googleapis.com/v1/${gmbAccount.name}/locations`,
			{
				headers: { Authorization: `Bearer ${account.accessToken}` },
			},
		);
		if (!locationsRes.ok) {
			return c.json({ data: [] }, 200);
		}
		const locationsJson = (await locationsRes.json()) as {
			locations: Array<{
				name: string;
				title: string;
				storefrontAddress?: { formattedAddress?: string };
			}>;
		};
		return c.json(
			{
				data: (locationsJson.locations ?? []).map((l) => ({
					id: l.name,
					name: l.title,
					address: l.storefrontAddress?.formattedAddress ?? null,
				})),
			},
			200,
		);
	} catch {
		return c.json({ data: [] }, 200);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(setGmbLocation, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getOwnedAccount(db, id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	const metadata = {
		...(account.metadata as object),
		default_location_id: body.location_id,
	};
	await db
		.update(socialAccounts)
		.set({ metadata, updatedAt: new Date() })
		.where(eq(socialAccounts.id, id));

	return c.json(
		formatAccountResult({ ...account, metadata, updatedAt: new Date() }),
		200,
	);
});

// --- YouTube Playlists ---

const getYoutubePlaylists = createRoute({
	operationId: "getYoutubePlaylists",
	method: "get",
	path: "/{id}/youtube-playlists",
	tags: ["Accounts"],
	summary: "Fetch YouTube playlists for an account",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "YouTube playlists",
			content: {
				"application/json": { schema: YouTubePlaylistsResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const setYoutubePlaylist = createRoute({
	operationId: "setYoutubePlaylist",
	method: "put",
	path: "/{id}/youtube-playlists",
	tags: ["Accounts"],
	summary: "Set default YouTube playlist",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: {
				"application/json": { schema: SetYouTubePlaylistBody },
			},
		},
	},
	responses: {
		200: {
			description: "Default playlist set",
			content: { "application/json": { schema: AccountResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getYoutubePlaylists, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getOwnedAccount(db, id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	if (!account.accessToken) {
		return c.json({ data: [] }, 200);
	}

	try {
		// YouTube Data API — Playlists: list (mine=true)
		// https://developers.google.com/youtube/v3/docs/playlists/list
		// Quota cost: 1 unit
		const res = await fetch(
			"https://www.googleapis.com/youtube/v3/playlists?mine=true&part=snippet,contentDetails,status&maxResults=50",
			{ headers: { Authorization: `Bearer ${account.accessToken}` } },
		);
		if (!res.ok) {
			return c.json({ data: [] }, 200);
		}
		const json = (await res.json()) as {
			items?: Array<{
				id: string;
				snippet: {
					title: string;
					description: string;
					thumbnails?: { default?: { url?: string } };
				};
				contentDetails: { itemCount: number };
				status: { privacyStatus: string };
			}>;
		};
		return c.json(
			{
				data: (json.items ?? []).map((p) => ({
					id: p.id,
					title: p.snippet.title,
					description: p.snippet.description || null,
					privacy: p.status.privacyStatus as
						| "public"
						| "private"
						| "unlisted",
					item_count: p.contentDetails.itemCount,
					thumbnail_url:
						p.snippet.thumbnails?.default?.url ?? null,
				})),
			},
			200,
		);
	} catch {
		return c.json({ data: [] }, 200);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(setYoutubePlaylist, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getOwnedAccount(db, id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	const metadata = {
		...(account.metadata as object),
		default_playlist_id: body.playlist_id,
		...(body.playlist_name !== undefined && {
			default_playlist_name: body.playlist_name,
		}),
	};
	await db
		.update(socialAccounts)
		.set({ metadata, updatedAt: new Date() })
		.where(eq(socialAccounts.id, id));

	return c.json(
		formatAccountResult({ ...account, metadata, updatedAt: new Date() }),
		200,
	);
});

// ---------------------------------------------------------------------------
// TikTok Creator Info
// ---------------------------------------------------------------------------

const getTikTokCreatorInfo = createRoute({
	operationId: "getTikTokCreatorInfo",
	method: "get",
	path: "/{id}/tiktok-creator-info",
	tags: ["Accounts"],
	summary: "Fetch TikTok creator info (available privacy levels, posting limits)",
	description:
		"Returns TikTok creator details, available privacy levels, and default interaction settings. Use this before creating TikTok posts to ensure the privacy_level is valid for the account.",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "TikTok creator info",
			content: { "application/json": { schema: TikTokCreatorInfoResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(getTikTokCreatorInfo, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getOwnedAccount(db, id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	if (account.platform !== "tiktok") {
		return c.json(
			{ error: { code: "INVALID_PLATFORM", message: "This endpoint only works with TikTok accounts" } },
			400,
		);
	}

	if (!account.accessToken) {
		return c.json(
			{ error: { code: "NO_TOKEN", message: "No access token for this account. Please reconnect." } },
			422,
		);
	}

	try {
		// TikTok Content Posting API — Query Creator Info
		// Docs: https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
		// Section: "HTTP URL" — POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/
		// Required headers: Authorization: Bearer {token}, Content-Type: application/json; charset=UTF-8
		// Required scope: video.publish | Rate limit: 20 req/min per token
		// Response wraps data in { data: {...}, error: { code, message, log_id } }
		const res = await fetch(
			"https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					"Content-Type": "application/json; charset=UTF-8",
				},
			},
		);

		if (res.status === 401) {
			return c.json(
				{ error: { code: "TOKEN_EXPIRED", message: "TikTok access token expired. Please reconnect." } },
				401,
			);
		}

		if (res.status === 429) {
			return c.json(
				{ error: { code: "RATE_LIMITED", message: "TikTok rate limit exceeded (20 req/min). Please try again later." } },
				429,
			);
		}

		if (!res.ok) {
			return c.json(
				{ error: { code: "TIKTOK_ERROR", message: `TikTok API error: ${res.status}` } },
				502,
			);
		}

		const json = (await res.json()) as {
			data?: {
				creator_avatar_url?: string;
				creator_username?: string;
				creator_nickname?: string;
				privacy_level_options?: string[];
				comment_disabled?: boolean;
				duet_disabled?: boolean;
				stitch_disabled?: boolean;
				max_video_post_duration_sec?: number;
			};
			error?: { code?: string; message?: string; log_id?: string };
		};

		if (json.error?.code && json.error.code !== "ok") {
			const logSuffix = json.error.log_id ? ` (log_id: ${json.error.log_id})` : "";
			return c.json(
				{ error: { code: json.error.code, message: (json.error.message ?? "TikTok error") + logSuffix } },
				502,
			);
		}

		if (!json.data) {
			return c.json(
				{ error: { code: "NO_DATA", message: "TikTok returned no creator data" } },
				502,
			);
		}

		return c.json(
			{
				creator_avatar_url: json.data.creator_avatar_url ?? "",
				creator_username: json.data.creator_username ?? "",
				creator_nickname: json.data.creator_nickname ?? "",
				privacy_level_options: json.data.privacy_level_options ?? [],
				comment_disabled: json.data.comment_disabled ?? false,
				duet_disabled: json.data.duet_disabled ?? false,
				stitch_disabled: json.data.stitch_disabled ?? false,
				max_video_post_duration_sec: json.data.max_video_post_duration_sec ?? 600,
			},
			200,
		);
	} catch (e) {
		return c.json(
			{ error: { code: "TIKTOK_ERROR", message: e instanceof Error ? e.message : "Failed to connect to TikTok API" } },
			502,
		);
	}
});

// ---------------------------------------------------------------------------
// Single account sync trigger
// ---------------------------------------------------------------------------

const singleSync = createRoute({
  operationId: "syncAccount",
  method: "post",
  path: "/{id}/sync",
  tags: ["Accounts"],
  summary: "Trigger post sync for a single account",
  security: [{ Bearer: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "Sync enqueued",
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean() }),
        },
      },
    },
    404: {
      description: "Account not found or not syncable",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(singleSync, async (c) => {
  const orgId = c.get("orgId");
  const { id } = c.req.valid("param");
  const db = createDb(c.env.HYPERDRIVE.connectionString);

  const [account] = await db
    .select({
      id: socialAccounts.id,
      platform: socialAccounts.platform,
      workspaceId: socialAccounts.workspaceId,
      accessToken: socialAccounts.accessToken,
      platformAccountId: socialAccounts.platformAccountId,
    })
    .from(socialAccounts)
    .where(
      and(eq(socialAccounts.id, id), eq(socialAccounts.organizationId, orgId)),
    )
    .limit(1);

  if (!account) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Account not found" } },
      404,
    );
  }

  const denied = assertWorkspaceScope(c, account.workspaceId);
  if (denied) return denied;

  const supportedPlatforms = getSupportedSyncPlatforms();
  if (!supportedPlatforms.includes(account.platform)) {
    return c.json(
      {
        error: {
          code: "NOT_SYNCABLE",
          message: `${account.platform} does not support post sync`,
        },
      },
      404,
    );
  }

  // Re-fetch avatar URL (CDN URLs expire over time)
  const token = await maybeDecrypt(account.accessToken, c.env.ENCRYPTION_KEY);
  if (token) {
    const newAvatarUrl = await fetchAvatarUrl(
      account.platform as Platform,
      token,
      account.platformAccountId,
    );
    if (newAvatarUrl) {
      await db
        .update(socialAccounts)
        .set({ avatarUrl: newAvatarUrl, updatedAt: new Date() })
        .where(eq(socialAccounts.id, account.id));
    }
  }

  // Upsert sync state: reset errors, schedule now
  await db
    .insert(socialAccountSyncState)
    .values({
      socialAccountId: account.id,
      organizationId: orgId,
      platform: account.platform as any,
      enabled: true,
      nextSyncAt: new Date(),
      consecutiveErrors: 0,
      lastError: null,
      lastErrorAt: null,
    })
    .onConflictDoUpdate({
      target: socialAccountSyncState.socialAccountId,
      set: {
        enabled: true,
        nextSyncAt: new Date(),
        consecutiveErrors: 0,
        lastError: null,
        lastErrorAt: null,
        rateLimitResetAt: null,
        updatedAt: new Date(),
      },
    });

  // Enqueue sync job
  await c.env.SYNC_QUEUE.send({
    type: "sync_posts",
    social_account_id: account.id,
    organization_id: orgId,
    platform: account.platform,
  } satisfies SyncPostsMessage);

  return c.json({ success: true }, 200);
});

// ---------------------------------------------------------------------------
// Force sync all connected accounts
// ---------------------------------------------------------------------------

const forceSync = createRoute({
	operationId: "forceSync",
	method: "post",
	path: "/sync",
	tags: ["Accounts"],
	summary: "Force sync all connected accounts to pull in external posts",
	security: [{ Bearer: [] }],
	request: {
		query: z.object({
			workspace_id: z.string().optional().describe("Optional workspace filter"),
		}),
	},
	responses: {
		200: {
			description: "Sync enqueued",
			content: {
				"application/json": {
					schema: z.object({
						enqueued_count: z.number(),
					}),
				},
			},
		},
	},
});

app.openapi(forceSync, async (c) => {
	const orgId = c.get("orgId");
	const { workspace_id } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const supportedPlatforms = getSupportedSyncPlatforms();

	// Find all accounts on supported platforms
	const conditions = [eq(socialAccounts.organizationId, orgId)];
	if (workspace_id) {
		conditions.push(eq(socialAccounts.workspaceId, workspace_id));
	}

	const accounts = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
		})
		.from(socialAccounts)
		.where(and(...conditions));

	const syncable = accounts.filter((a) => supportedPlatforms.includes(a.platform));

	if (syncable.length === 0) {
		return c.json({ enqueued_count: 0 }, 200);
	}

	// Ensure sync state exists for each account and enqueue
	const messages: { body: SyncPostsMessage }[] = [];

	for (const account of syncable) {
		// Upsert sync state
		await db
			.insert(socialAccountSyncState)
			.values({
				socialAccountId: account.id,
				organizationId: orgId,
				platform: account.platform as any,
				nextSyncAt: new Date(),
			})
			.onConflictDoUpdate({
				target: socialAccountSyncState.socialAccountId,
				set: {
					enabled: true,
					nextSyncAt: new Date(),
					updatedAt: new Date(),
				},
			});

		messages.push({
			body: {
				type: "sync_posts",
				social_account_id: account.id,
				organization_id: orgId,
				platform: account.platform,
			},
		});
	}

	// Batch-enqueue to SYNC_QUEUE (100 per sendBatch)
	for (let i = 0; i < messages.length; i += 100) {
		await c.env.SYNC_QUEUE.sendBatch(messages.slice(i, i + 100));
	}

	return c.json({ enqueued_count: syncable.length }, 200);
});

// ===========================================================================
// Newsletter discovery: Lists + Templates
// ===========================================================================

const NEWSLETTER_PLATFORMS = new Set(["beehiiv", "convertkit", "mailchimp", "listmonk"]);

const NewsletterListItem = z.object({
	id: z.string(),
	name: z.string(),
	subscriber_count: z.number().nullable(),
});

const NewsletterTemplateItem = z.object({
	id: z.string(),
	name: z.string(),
	preview_url: z.string().nullable(),
});

const getNewsletterLists = createRoute({
	operationId: "getNewsletterLists",
	method: "get",
	path: "/{id}/lists",
	tags: ["Accounts"],
	summary: "Get newsletter lists/audiences for a newsletter account",
	security: [{ Bearer: [] }],
	request: { params: z.object({ id: z.string() }) },
	responses: {
		200: { description: "Lists", content: { "application/json": { schema: z.object({ data: z.array(NewsletterListItem) }) } } },
		400: { description: "Bad request", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const getNewsletterTemplates = createRoute({
	operationId: "getNewsletterTemplates",
	method: "get",
	path: "/{id}/templates",
	tags: ["Accounts"],
	summary: "Get newsletter templates for a newsletter account",
	security: [{ Bearer: [] }],
	request: { params: z.object({ id: z.string() }) },
	responses: {
		200: { description: "Templates", content: { "application/json": { schema: z.object({ data: z.array(NewsletterTemplateItem) }) } } },
		400: { description: "Bad request", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

app.openapi(getNewsletterLists, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [account] = await db.select().from(socialAccounts).where(and(eq(socialAccounts.id, id), eq(socialAccounts.organizationId, orgId))).limit(1);
	if (!account) return c.json({ error: { code: "NOT_FOUND", message: "Account not found" } }, 404 as any);
	if (!NEWSLETTER_PLATFORMS.has(account.platform)) {
		return c.json({ error: { code: "BAD_REQUEST", message: "This endpoint is only for newsletter platforms" } }, 400 as any);
	}

	const token = await maybeDecrypt(account.accessToken, c.env.ENCRYPTION_KEY) ?? "";
	const meta = (account.metadata ?? {}) as Record<string, unknown>;
	const lists: Array<{ id: string; name: string; subscriber_count: number | null }> = [];

	try {
		if (account.platform === "beehiiv") {
			// Not applicable for Beehiiv (publication-level, not list-level)
			lists.push({ id: meta.publication_id as string ?? account.platformAccountId, name: meta.publication_name as string ?? "All Subscribers", subscriber_count: null });
		} else if (account.platform === "mailchimp") {
			const dc = (meta.datacenter as string) ?? token.split("-").pop();
			const res = await fetch(`https://${dc}.api.mailchimp.com/3.0/lists?count=100`, { headers: { Authorization: `Basic ${btoa(`relayapi:${token}`)}` } });
			if (res.ok) {
				const data = (await res.json()) as { lists?: Array<{ id: string; name: string; stats?: { member_count?: number } }> };
				for (const l of data.lists ?? []) lists.push({ id: l.id, name: l.name, subscriber_count: l.stats?.member_count ?? null });
			}
		} else if (account.platform === "listmonk") {
			const url = meta.instance_url as string;
			if (!url || await isBlockedUrlWithDns(url)) return c.json({ data: [] }, 200);
			const res = await fetch(`${url}/api/lists?per_page=100`, {
				headers: { Authorization: `Basic ${token}` },
				redirect: "error",
			});
			if (res.ok) {
				const data = (await res.json()) as { data?: { results?: Array<{ id: number; name: string; subscriber_count?: number }> } };
				for (const l of data.data?.results ?? []) lists.push({ id: String(l.id), name: l.name, subscriber_count: l.subscriber_count ?? null });
			}
		} else if (account.platform === "convertkit") {
			// ConvertKit uses tags, not lists, but we can show forms/sequences as "lists"
			lists.push({ id: "all", name: "All Subscribers", subscriber_count: null });
		}
	} catch {
		// Non-fatal — return empty list
	}

	return c.json({ data: lists }, 200);
});

app.openapi(getNewsletterTemplates, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [account] = await db.select().from(socialAccounts).where(and(eq(socialAccounts.id, id), eq(socialAccounts.organizationId, orgId))).limit(1);
	if (!account) return c.json({ error: { code: "NOT_FOUND", message: "Account not found" } }, 404 as any);
	if (!NEWSLETTER_PLATFORMS.has(account.platform)) {
		return c.json({ error: { code: "BAD_REQUEST", message: "This endpoint is only for newsletter platforms" } }, 400 as any);
	}

	const token = await maybeDecrypt(account.accessToken, c.env.ENCRYPTION_KEY) ?? "";
	const meta = (account.metadata ?? {}) as Record<string, unknown>;
	const templates: Array<{ id: string; name: string; preview_url: string | null }> = [];

	try {
		if (account.platform === "listmonk") {
			const url = meta.instance_url as string;
			if (!url || await isBlockedUrlWithDns(url)) return c.json({ data: [] }, 200);
			const res = await fetch(`${url}/api/templates?per_page=100`, {
				headers: { Authorization: `Basic ${token}` },
				redirect: "error",
			});
			if (res.ok) {
				const data = (await res.json()) as { data?: Array<{ id: number; name: string }> };
				for (const t of data.data ?? []) templates.push({ id: String(t.id), name: t.name, preview_url: null });
			}
		} else if (account.platform === "mailchimp") {
			const dc = (meta.datacenter as string) ?? token.split("-").pop();
			const res = await fetch(`https://${dc}.api.mailchimp.com/3.0/templates?count=100`, { headers: { Authorization: `Basic ${btoa(`relayapi:${token}`)}` } });
			if (res.ok) {
				const data = (await res.json()) as { templates?: Array<{ id: number; name: string; thumbnail?: string }> };
				for (const t of data.templates ?? []) templates.push({ id: String(t.id), name: t.name, preview_url: t.thumbnail ?? null });
			}
		}
		// Beehiiv and ConvertKit don't have a public template listing API
	} catch {
		// Non-fatal
	}

	return c.json({ data: templates }, 200);
});

export default app;
