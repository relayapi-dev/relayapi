import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createDb, shortLinkConfigs, shortLinks } from "@relayapi/db";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { ErrorResponse, IdParam, PaginationParams } from "../schemas/common";
import {
	ShortLinkConfigBody,
	ShortLinkConfigResponse,
	ShortLinkListResponse,
	ShortLinkResponse,
	ShortLinkStatsResponse,
	ShortLinkTestResponse,
	ShortenUrlBody,
	ShortenUrlResponse,
} from "../schemas/short-links";
import { getProvider, createRelayApiProvider } from "../services/short-link-providers";
import type { ShortLinkProvider } from "../services/short-link-providers";
import { encryptToken, maybeDecrypt } from "../lib/crypto";
import type { Env, Variables } from "../types";
import { requireAllWorkspaceScopeMiddleware } from "../middleware/permissions";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

app.use("*", requireAllWorkspaceScopeMiddleware);

// --- Helpers ---

/** Resolve the provider instance + API key from config. Built-in provider uses KV, others use decrypted API key. */
async function resolveProvider(
	config: { provider: string | null; apiKey: string | null; domain: string | null },
	env: Env,
): Promise<{ provider: ShortLinkProvider; apiKey: string } | null> {
	if (!config.provider) return null;

	if (config.provider === "relayapi") {
		const baseUrl = env.API_BASE_URL || "https://api.relayapi.dev";
		return { provider: createRelayApiProvider(env.KV, baseUrl), apiKey: "builtin" };
	}

	if (!config.apiKey) return null;
	const provider = getProvider(config.provider as "dub" | "short_io" | "bitly");
	if (!provider) return null;
	const apiKey = await maybeDecrypt(config.apiKey, env.ENCRYPTION_KEY);
	if (!apiKey) return null;
	return { provider, apiKey };
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
			description: "Short link configuration (defaults returned if not yet configured)",
			content: { "application/json": { schema: ShortLinkConfigResponse } },
		},
		401: {
			description: "Unauthorized",
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
	},
});

const testConfigRoute = createRoute({
	operationId: "testShortLinkConfig",
	method: "post",
	path: "/test",
	tags: ["Short Links"],
	summary: "Test short link configuration",
	description:
		"Test the configured provider by shortening a test URL. Returns the shortened URL on success.",
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
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Route handlers ---

app.openapi(getConfigRoute, async (c) => {
	const orgId = c.get("orgId");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

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
			provider: config.provider as "relayapi" | "dub" | "short_io" | "bitly" | null,
			has_api_key: !!config.apiKey,
			domain: config.domain,
			created_at: config.createdAt.toISOString(),
			updated_at: config.updatedAt.toISOString(),
		},
		200,
	);
});

app.openapi(updateConfigRoute, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	// Validate: if mode is not "never", provider + api_key are required
	// (either from this request or from an existing saved config)
	if (body.mode !== "never") {
		const [existing] = await db
			.select({ provider: shortLinkConfigs.provider, apiKey: shortLinkConfigs.apiKey })
			.from(shortLinkConfigs)
			.where(eq(shortLinkConfigs.organizationId, orgId))
			.limit(1);

		const effectiveProvider = body.provider ?? existing?.provider;
		const effectiveApiKey = body.api_key ?? existing?.apiKey;

		// Built-in provider doesn't need an API key; third-party providers do
		if (!effectiveProvider) {
			return c.json(
				{ error: { code: "INVALID_CONFIG", message: "Provider is required when mode is not 'never'" } },
				400,
			);
		}
		if (effectiveProvider !== "relayapi" && !effectiveApiKey) {
			return c.json(
				{ error: { code: "INVALID_CONFIG", message: "API key is required for third-party providers" } },
				400,
			);
		}
	}

	// Encrypt API key if provided
	const encryptedApiKey = body.api_key
		? await encryptToken(body.api_key, c.env.ENCRYPTION_KEY)
		: undefined;

	const values: Record<string, unknown> = {
		mode: body.mode,
		updatedAt: new Date(),
	};
	if (body.provider !== undefined) values.provider = body.provider;
	if (encryptedApiKey !== undefined) values.apiKey = encryptedApiKey;
	if (body.domain !== undefined) values.domain = body.domain;

	// Upsert: insert or update on conflict
	const rows = await db
		.insert(shortLinkConfigs)
		.values({
			organizationId: orgId,
			mode: body.mode,
			provider: body.provider ?? null,
			apiKey: encryptedApiKey ?? null,
			domain: body.domain ?? null,
		})
		.onConflictDoUpdate({
			target: shortLinkConfigs.organizationId,
			set: values,
		})
		.returning();

	const config = rows[0]!;

	return c.json(
		{
			id: config.id,
			mode: config.mode as "always" | "ask" | "never",
			provider: config.provider as "relayapi" | "dub" | "short_io" | "bitly" | null,
			has_api_key: !!config.apiKey,
			domain: config.domain,
			created_at: config.createdAt.toISOString(),
			updated_at: config.updatedAt.toISOString(),
		},
		200,
	);
});

app.openapi(testConfigRoute, async (c) => {
	const orgId = c.get("orgId");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [config] = await db
		.select()
		.from(shortLinkConfigs)
		.where(eq(shortLinkConfigs.organizationId, orgId))
		.limit(1);

	if (!config || !config.provider) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "No provider configured" } },
			404,
		);
	}

	const resolved = await resolveProvider(config, c.env);
	if (!resolved) {
		return c.json(
			{ success: false, short_url: null, error: "Provider not configured correctly" },
			200,
		);
	}

	try {
		const shortUrl = await resolved.provider.shorten(
			resolved.apiKey,
			config.domain,
			"https://example.com/test",
		);
		return c.json({ success: true, short_url: shortUrl, error: null }, 200);
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
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const conditions = [eq(shortLinks.organizationId, orgId)];
	if (cursor) {
		const [cursorRow] = await db
			.select({ createdAt: shortLinks.createdAt })
			.from(shortLinks)
			.where(eq(shortLinks.id, cursor))
			.limit(1);
		if (cursorRow) {
			// Tie-break on ID to avoid skipping records with identical timestamps
			conditions.push(
				or(
					lt(shortLinks.createdAt, cursorRow.createdAt),
					and(
						eq(shortLinks.createdAt, cursorRow.createdAt),
						sql`${shortLinks.id} < ${cursor}`,
					),
				)!,
			);
		}
	}

	const rows = await db
		.select()
		.from(shortLinks)
		.where(and(...conditions))
		.orderBy(desc(shortLinks.createdAt), desc(shortLinks.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	return c.json(
		{
			data: data.map((sl) => ({
				id: sl.id,
				original_url: sl.originalUrl,
				short_url: sl.shortUrl,
				post_id: sl.postId,
				click_count: sl.clickCount,
				created_at: sl.createdAt.toISOString(),
			})),
			next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

app.openapi(listByPostRoute, async (c) => {
	const orgId = c.get("orgId");
	const { postId } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const rows = await db
		.select()
		.from(shortLinks)
		.where(
			and(
				eq(shortLinks.organizationId, orgId),
				eq(shortLinks.postId, postId),
			),
		)
		.orderBy(desc(shortLinks.createdAt));

	return c.json(
		{
			data: rows.map((sl) => ({
				id: sl.id,
				original_url: sl.originalUrl,
				short_url: sl.shortUrl,
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
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [config] = await db
		.select()
		.from(shortLinkConfigs)
		.where(eq(shortLinkConfigs.organizationId, orgId))
		.limit(1);

	if (!config?.provider) {
		return c.json(
			{
				error: {
					code: "PROVIDER_NOT_CONFIGURED",
					message: "No short link provider configured. Set up a provider in short link settings.",
				},
			},
			400,
		);
	}

	const resolved = await resolveProvider(config, c.env);
	if (!resolved) {
		return c.json(
			{ error: { code: "INVALID_PROVIDER", message: "Provider not configured correctly" } },
			400,
		);
	}

	try {
		const shortUrl = await resolved.provider.shorten(resolved.apiKey, config.domain, body.url);

		// Store the short link
		await db.insert(shortLinks).values({
			organizationId: orgId,
			originalUrl: body.url,
			shortUrl,
		});

		return c.json(
			{ original_url: body.url, short_url: shortUrl },
			200,
		);
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
	}
});

app.openapi(statsRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [link] = await db
		.select()
		.from(shortLinks)
		.where(
			and(eq(shortLinks.id, id), eq(shortLinks.organizationId, orgId)),
		)
		.limit(1);

	if (!link) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Short link not found" } },
			404,
		);
	}

	// Try to fetch live click count from provider
	let clickCount = link.clickCount;
	try {
		const [config] = await db
			.select()
			.from(shortLinkConfigs)
			.where(eq(shortLinkConfigs.organizationId, orgId))
			.limit(1);

		if (config?.provider) {
			const resolved = await resolveProvider(config, c.env);

			if (resolved) {
				clickCount = await resolved.provider.getClickCount(resolved.apiKey, link.shortUrl);

				// Update cached count
				c.executionCtx.waitUntil(
					db
						.update(shortLinks)
						.set({ clickCount, lastClickSyncAt: new Date() })
						.where(eq(shortLinks.id, id)),
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
			last_synced_at: link.lastClickSyncAt?.toISOString() ?? null,
		},
		200,
	);
});

export default app;
