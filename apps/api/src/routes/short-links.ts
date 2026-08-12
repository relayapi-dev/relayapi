import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	type Database,
	posts,
	shortLinkConfigs,
	shortLinks,
} from "@relayapi/db";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { withCredentialMutationAuthority } from "../lib/credential-mutation-authority";
import { encryptToken } from "../lib/crypto";
import { SingleUnitProviderMutationAggregate } from "../lib/mutation-provider-boundary";
import {
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
	tryDecodeTimestampIdCursor,
} from "../lib/pagination-cursor";
import {
	assertAllWorkspaceScope,
	resolveOperationalCreateScope,
} from "../lib/request-access";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
} from "../lib/workspace-scope";
import { markMutationInputNotApplied } from "../middleware/mutation-validation";
import { ErrorResponse, IdParam, PaginationParams } from "../schemas/common";
import {
	ShortenUrlBody,
	ShortenUrlResponse,
	ShortLinkConfigBody,
	ShortLinkConfigResponse,
	ShortLinkListResponse,
	ShortLinkResponse,
	ShortLinkStatsResponse,
	ShortLinkTestResponse,
} from "../schemas/short-links";
import {
	resolveExternalShortLinkProvider,
	updateVersionedShortLinkConfigInTransaction,
} from "../services/short-link-configuration";
import {
	analyticsTargetForShortLink,
	createTrackedExternalShortLink,
	type ExternalShortLinkProviderType,
} from "../services/short-link-lifecycle";
import type { ShortLinkProvider } from "../services/short-link-providers";
import {
	createRelayApiProvider,
	getProvider,
} from "../services/short-link-providers";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Helpers ---

/** Resolve the provider instance + API key from config. Built-in provider uses KV, others use decrypted API key. */
async function resolveProvider(
	config: {
		provider: string | null;
		domain: string | null;
		providerConfigVersion: number;
		credentialVersion: number | null;
	},
	env: Env,
	db: Database,
	organizationId: string,
	workspaceId: string | null = null,
): Promise<{ provider: ShortLinkProvider; apiKey: string } | null> {
	if (!config.provider) return null;

	if (config.provider === "relayapi") {
		const baseUrl =
			env.PUBLIC_LINK_BASE_URL ||
			env.API_BASE_URL ||
			"https://api.relayapi.dev";
		return {
			provider: createRelayApiProvider({
				db,
				kv: env.KV,
				baseUrl,
				organizationId,
				workspaceId,
				providerConfigVersion: config.providerConfigVersion,
			}),
			apiKey: "builtin",
		};
	}

	if (!config.credentialVersion) return null;
	const resolved = await resolveExternalShortLinkProvider({
		db,
		organizationId,
		provider: config.provider as ExternalShortLinkProviderType,
		credentialVersion: config.credentialVersion,
		encryptionKey: env.ENCRYPTION_KEY,
	});
	return resolved
		? { provider: resolved.provider, apiKey: resolved.apiKey }
		: null;
}

// --- Route definitions ---

const getConfigRoute = createRoute({
	operationId: "getShortLinkConfig",
	method: "get",
	path: "/config",
	tags: ["Short Links"],
	summary: "Get short link configuration",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description:
				"Short link configuration (defaults returned if not yet configured)",
			content: { "application/json": { schema: ShortLinkConfigResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "All-workspace access required",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const updateConfigRoute = createRoute({
	operationId: "updateShortLinkConfig",
	method: "put",
	path: "/config",
	tags: ["Short Links"],
	summary: "Update short link configuration",
	description:
		"Create or update the organization's short link configuration. Set mode, provider, and credentials.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: ShortLinkConfigBody } },
		},
	},
	responses: {
		200: {
			description: "Configuration updated",
			content: { "application/json": { schema: ShortLinkConfigResponse } },
		},
		400: {
			description: "Invalid configuration",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "All-workspace access required",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const testConfigRoute = createRoute({
	operationId: "testShortLinkConfig",
	method: "post",
	path: "/test",
	tags: ["Short Links"],
	summary: "Test short link configuration",
	description:
		"Test the configured provider with a read-only credential probe. No remote link is created.",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Test result",
			content: { "application/json": { schema: ShortLinkTestResponse } },
		},
		404: {
			description: "No configuration found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "All-workspace access required",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const ShortLinkListQuery = PaginationParams.pick({ cursor: true, limit: true });

const listShortLinksRoute = createRoute({
	operationId: "listShortLinks",
	method: "get",
	path: "/",
	tags: ["Short Links"],
	summary: "List short links",
	security: [{ Bearer: [] }],
	request: { query: ShortLinkListQuery },
	responses: {
		200: {
			description: "List of short links",
			content: { "application/json": { schema: ShortLinkListResponse } },
		},
		400: {
			description: "Invalid cursor",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const PostIdParam = z.object({
	postId: z.string().describe("Post ID"),
});

const listByPostRoute = createRoute({
	operationId: "listShortLinksByPost",
	method: "get",
	path: "/by-post/{postId}",
	tags: ["Short Links"],
	summary: "List short links for a post",
	security: [{ Bearer: [] }],
	request: { params: PostIdParam },
	responses: {
		200: {
			description: "Short links for the post",
			content: {
				"application/json": {
					schema: z.object({ data: z.array(ShortLinkResponse) }),
				},
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Post not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const shortenRoute = createRoute({
	operationId: "shortenUrl",
	method: "post",
	path: "/shorten",
	tags: ["Short Links"],
	summary: "Shorten a URL",
	description: "Manually shorten a single URL using the configured provider.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: ShortenUrlBody } },
		},
	},
	responses: {
		200: {
			description: "Shortened URL",
			content: { "application/json": { schema: ShortenUrlResponse } },
		},
		400: {
			description: "Provider not configured",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Workspace not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Workspace not active",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const statsRoute = createRoute({
	operationId: "getShortLinkStats",
	method: "get",
	path: "/{id}/stats",
	tags: ["Short Links"],
	summary: "Get short link click stats",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Click statistics",
			content: {
				"application/json": { schema: ShortLinkStatsResponse },
			},
		},
		404: {
			description: "Short link not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Short link creation requires reconciliation",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Route handlers ---

app.openapi(getConfigRoute, async (c) => {
	const denied = assertAllWorkspaceScope(c);
	if (denied) return denied as never;
	const orgId = c.get("orgId");
	const db = c.get("db");

	const [config] = await db
		.select()
		.from(shortLinkConfigs)
		.where(eq(shortLinkConfigs.organizationId, orgId))
		.limit(1);

	if (!config) {
		return c.json(
			{
				id: null,
				mode: "never" as const,
				provider: null,
				has_api_key: false,
				domain: null,
				created_at: null,
				updated_at: null,
			},
			200,
		);
	}

	return c.json(
		{
			id: config.id,
			mode: config.mode as "always" | "ask" | "never",
			provider: config.provider as
				| "relayapi"
				| "dub"
				| "short_io"
				| "bitly"
				| null,
			has_api_key: config.credentialVersion !== null,
			domain: config.domain,
			created_at: config.createdAt.toISOString(),
			updated_at: config.updatedAt.toISOString(),
		},
		200,
	);
});

app.openapi(updateConfigRoute, async (c) => {
	const denied = assertAllWorkspaceScope(c);
	if (denied) return denied as never;
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [existing] = await db
		.select({
			provider: shortLinkConfigs.provider,
			credentialVersion: shortLinkConfigs.credentialVersion,
		})
		.from(shortLinkConfigs)
		.where(eq(shortLinkConfigs.organizationId, orgId))
		.limit(1);

	const effectiveProvider = body.provider ?? existing?.provider;
	// Validate the effective provider/credential before entering the versioned
	// configuration transaction.
	if (body.mode !== "never") {
		const hasEffectiveApiKey =
			Boolean(body.api_key) ||
			(Boolean(existing?.credentialVersion) &&
				effectiveProvider === existing?.provider);

		// Built-in provider doesn't need an API key; third-party providers do
		if (!effectiveProvider) {
			return c.json(
				{
					error: {
						code: "INVALID_CONFIG",
						message: "Provider is required when mode is not 'never'",
					},
				},
				400,
			);
		}
		if (effectiveProvider !== "relayapi" && !hasEffectiveApiKey) {
			return c.json(
				{
					error: {
						code: "INVALID_CONFIG",
						message: "API key is required for third-party providers",
					},
				},
				400,
			);
		}
	}

	// A replacement credential becomes active only after a documented read-only
	// provider probe. A failed probe leaves the prior immutable version active.
	if (body.api_key && effectiveProvider && effectiveProvider !== "relayapi") {
		const provider = getProvider(effectiveProvider);
		if (!provider) {
			return c.json(
				{
					error: {
						code: "INVALID_CONFIG",
						message: "Unsupported short-link provider",
					},
				},
				400,
			);
		}
		try {
			await provider.probeCredential(body.api_key);
		} catch (error) {
			return c.json(
				{
					error: {
						code: "INVALID_CREDENTIAL",
						message:
							error instanceof Error
								? error.message
								: "Short-link credential probe failed",
					},
				},
				400,
			);
		}
	}

	// Encrypt API key if provided
	const encryptedApiKey = body.api_key
		? await encryptToken(body.api_key, c.env.ENCRYPTION_KEY)
		: undefined;

	let config: typeof shortLinkConfigs.$inferSelect;
	try {
		const authority = await withCredentialMutationAuthority(
			c,
			{ requireAllWorkspaceScope: true },
			(tx) =>
				updateVersionedShortLinkConfigInTransaction(tx, orgId, {
					mode: body.mode,
					...(body.provider !== undefined ? { provider: body.provider } : {}),
					...(body.domain !== undefined ? { domain: body.domain } : {}),
					...(encryptedApiKey ? { encryptedApiKey } : {}),
				}),
		);
		if (!authority.ok) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: { code: authority.code, message: authority.message },
				} as never,
				authority.status as never,
			);
		}
		config = authority.value;
	} catch (error) {
		return c.json(
			{
				error: {
					code: "INVALID_CONFIG",
					message:
						error instanceof Error
							? error.message
							: "Failed to save short-link configuration",
				},
			},
			400,
		);
	}

	return c.json(
		{
			id: config.id,
			mode: config.mode as "always" | "ask" | "never",
			provider: config.provider as
				| "relayapi"
				| "dub"
				| "short_io"
				| "bitly"
				| null,
			has_api_key: config.credentialVersion !== null,
			domain: config.domain,
			created_at: config.createdAt.toISOString(),
			updated_at: config.updatedAt.toISOString(),
		},
		200,
	);
});

app.openapi(testConfigRoute, async (c) => {
	const denied = assertAllWorkspaceScope(c);
	if (denied) return denied as never;
	const orgId = c.get("orgId");
	const db = c.get("db");

	const [config] = await db
		.select()
		.from(shortLinkConfigs)
		.where(eq(shortLinkConfigs.organizationId, orgId))
		.limit(1);

	if (!config?.provider) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "No provider configured" } },
			404,
		);
	}

	const resolved = await resolveProvider(config, c.env, db, orgId, null);
	if (!resolved) {
		return c.json(
			{
				success: false,
				short_url: null,
				error: "Provider not configured correctly",
			},
			200,
		);
	}

	try {
		await resolved.provider.probeCredential(resolved.apiKey);
		return c.json({ success: true, short_url: null, error: null }, 200);
	} catch (err) {
		return c.json(
			{
				success: false,
				short_url: null,
				error: err instanceof Error ? err.message : "Unknown error",
			},
			200,
		);
	}
});

app.openapi(listShortLinksRoute, async (c) => {
	const orgId = c.get("orgId");
	const { cursor, limit } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(shortLinks.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, shortLinks.workspaceId);
	// Keyset pagination on (createdAt, id). Read the cursor row's created_at as raw
	// text so it isn't round-tripped through a JS Date, which truncates Postgres
	// microseconds to millisecond precision and would skip rows sharing the cursor's
	// millisecond. Bind it back with an explicit ::timestamptz cast.
	if (cursor) {
		const key = tryDecodeTimestampIdCursor(cursor);
		if (!key) return c.json(INVALID_CURSOR_BODY, 400);
		conditions.push(
			sql`(${shortLinks.createdAt}, ${shortLinks.id}) < (${key.timestamp}::timestamptz, ${key.id})`,
		);
	}

	const rows = await db
		.select({
			...getTableColumns(shortLinks),
			cursorTimestamp: sql<string>`to_char(${shortLinks.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(shortLinks)
		.where(and(...conditions))
		.orderBy(desc(shortLinks.createdAt), desc(shortLinks.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);
	const last = data.at(-1);
	const nextCursor =
		hasMore && last
			? encodeTimestampIdCursor(last.cursorTimestamp, last.id)
			: null;

	return c.json(
		{
			data: data.map((sl) => ({
				id: sl.id,
				workspace_id: sl.workspaceId,
				original_url: sl.originalUrl,
				short_url: sl.shortUrl,
				status: sl.creationStatus,
				post_id: sl.postId,
				click_count: sl.clickCount,
				created_at: sl.createdAt.toISOString(),
			})),
			next_cursor: nextCursor,
			has_more: hasMore,
		},
		200,
	);
});

app.openapi(listByPostRoute, async (c) => {
	const orgId = c.get("orgId");
	const { postId } = c.req.valid("param");
	const db = c.get("db");
	const [post] = await db
		.select({ workspaceId: posts.workspaceId })
		.from(posts)
		.where(and(eq(posts.id, postId), eq(posts.organizationId, orgId)))
		.limit(1);
	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}
	const postDenied = assertWorkspaceScope(c, post.workspaceId);
	if (postDenied) return postDenied as never;

	const conditions = [
		eq(shortLinks.organizationId, orgId),
		eq(shortLinks.postId, postId),
	];
	applyWorkspaceScope(c, conditions, shortLinks.workspaceId);
	const rows = await db
		.select()
		.from(shortLinks)
		.where(and(...conditions))
		.orderBy(desc(shortLinks.createdAt));

	return c.json(
		{
			data: rows.map((sl) => ({
				id: sl.id,
				workspace_id: sl.workspaceId,
				original_url: sl.originalUrl,
				short_url: sl.shortUrl,
				status: sl.creationStatus,
				post_id: sl.postId,
				click_count: sl.clickCount,
				created_at: sl.createdAt.toISOString(),
			})),
		},
		200,
	);
});

app.openapi(shortenRoute, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");
	const scope = await resolveOperationalCreateScope(
		c,
		body.workspace_id,
		"short link",
	);
	if (!scope.ok) {
		markMutationInputNotApplied(c);
		return scope.response as never;
	}

	const [config] = await db
		.select()
		.from(shortLinkConfigs)
		.where(eq(shortLinkConfigs.organizationId, orgId))
		.limit(1);

	if (!config?.provider) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "PROVIDER_NOT_CONFIGURED",
					message:
						"No short link provider configured. Set up a provider in short link settings.",
				},
			},
			400,
		);
	}

	const resolved = await resolveProvider(
		config,
		c.env,
		db,
		orgId,
		scope.workspaceId,
	);
	if (!resolved) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "INVALID_PROVIDER",
					message: "Provider not configured correctly",
				},
			},
			400,
		);
	}
	const providerMutation = new SingleUnitProviderMutationAggregate(
		c.get("mutationEffectTracker"),
	);

	try {
		if (config.provider === "relayapi") {
			const created = await resolved.provider.shorten(
				resolved.apiKey,
				config.domain,
				body.url,
				crypto.randomUUID(),
			);
			providerMutation.markCommitted();
			return c.json(
				{ original_url: body.url, short_url: created.shortUrl },
				200,
			);
		}
		if (!config.credentialVersion) {
			throw new Error("Short-link provider credential version is missing");
		}
		const created = await createTrackedExternalShortLink({
			db,
			organizationId: orgId,
			workspaceId: scope.workspaceId,
			originalUrl: body.url,
			providerType: config.provider as ExternalShortLinkProviderType,
			providerConfigVersion: config.providerConfigVersion,
			credentialVersion: config.credentialVersion,
			domain: config.domain,
			apiKey: resolved.apiKey,
			provider: resolved.provider,
			providerMutation,
		});
		if (!created.shortUrl) {
			throw new Error("Short-link provider returned no active URL");
		}
		return c.json({ original_url: body.url, short_url: created.shortUrl }, 200);
	} catch (err) {
		return c.json(
			{
				error: {
					code: "SHORTEN_FAILED",
					message: err instanceof Error ? err.message : "Failed to shorten URL",
				},
			},
			400,
		);
	} finally {
		// The durable pending-row insert precedes provider egress. If it fails,
		// preserve the request's ambiguity instead of manufacturing K=0.
		if (
			providerMutation.hasAttempts() ||
			providerMutation.hasCommittedEffect()
		) {
			providerMutation.finalize();
		}
	}
});

app.openapi(statsRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [link] = await db
		.select()
		.from(shortLinks)
		.where(and(eq(shortLinks.id, id), eq(shortLinks.organizationId, orgId)))
		.limit(1);

	if (!link) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Short link not found" } },
			404,
		);
	}
	const denied = assertWorkspaceScope(c, link.workspaceId);
	if (denied) return denied as never;
	if (link.creationStatus !== "active" || !link.shortUrl) {
		return c.json(
			{
				error: {
					code: "SHORT_LINK_NOT_ACTIVE",
					message:
						"Short-link creation is not active and requires reconciliation",
				},
			},
			409,
		);
	}

	// Built-in (relayapi) links count clicks directly in short_links.click_count
	// (the redirect handler's atomic increment) — that DB value is authoritative,
	// so don't overwrite it with the provider's KV counter (no longer written).
	// Only external providers keep counts off-platform and need a live fetch.
	let clickCount = link.clickCount;
	let lastSyncedAt = link.lastClickSyncAt;
	try {
		if (link.provider !== "relayapi" && link.credentialVersion !== null) {
			const resolved = await resolveExternalShortLinkProvider({
				db,
				organizationId: orgId,
				provider: link.provider as ExternalShortLinkProviderType,
				credentialVersion: link.credentialVersion,
				encryptionKey: c.env.ENCRYPTION_KEY,
			});
			const target = analyticsTargetForShortLink(link);

			if (resolved && target) {
				clickCount = await resolved.provider.getClickCount(
					resolved.apiKey,
					target,
				);
				lastSyncedAt = new Date();

				// Update cached count
				c.executionCtx.waitUntil(
					db
						.update(shortLinks)
						.set({
							clickCount,
							lastClickSyncAt: lastSyncedAt,
							nextClickSyncAt: new Date(
								lastSyncedAt.getTime() + 60 * 60 * 1000,
							),
							clickSyncLeaseExpiresAt: null,
							clickSyncStartedAt: null,
							clickSyncAttempts: 0,
							clickSyncLastError: null,
							clickSyncLastErrorClass: null,
						})
						.where(
							and(eq(shortLinks.id, id), eq(shortLinks.organizationId, orgId)),
						),
				);
			}
		}
	} catch {
		// Fall back to cached count
	}

	return c.json(
		{
			id: link.id,
			short_url: link.shortUrl,
			original_url: link.originalUrl,
			click_count: clickCount,
			last_synced_at: lastSyncedAt?.toISOString() ?? null,
		},
		200,
	);
});

export default app;
