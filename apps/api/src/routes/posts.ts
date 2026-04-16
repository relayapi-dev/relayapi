import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	contentTemplates,
	createDb,
	ideas,
	ideaActivity,
	crossPostActions,
	externalPosts,
	postRecyclingConfigs,
	posts,
	postTargets,
	shortLinkConfigs,
	shortLinks,
	signatures,
	socialAccounts,
	usageRecords,
} from "@relayapi/db";
import { and, desc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { maybeDecrypt } from "../lib/crypto";
import { incrementUsage } from "../middleware/usage-tracking";
import { getProvider } from "../services/short-link-providers";
import { shortenUrlsInContent } from "../services/short-link-service";
import type { PublishRequest } from "../publishers";
import { addToPlaylist } from "../publishers/youtube";
import type { Platform } from "../schemas/common";
import {
	ErrorResponse,
	FilterParams,
	IdParam,
	PaginationParams,
} from "../schemas/common";
import {
	BulkCsvResponse,
	BulkCsvRowResult,
	CreatePostBody,
	PostListResponse,
	PostResponse,
	RecyclingConfigResponse,
	RecyclingInput,
	UpdatePostBody,
	UpdateMetadataBody,
	UpdateMetadataResponse,
} from "../schemas/posts";
import { parseCsv } from "../lib/csv-parser";
import {
	type PublishTargetInput,
	publishToTargets,
} from "../services/publisher-runner";
import {
	computeNextRecycleAt,
	validateRecyclingConfig,
} from "../services/recycling-validator";
import { resolveTargets } from "../services/target-resolver";
import { refreshTokenIfNeeded } from "../services/token-refresh";
import { dispatchWebhookEvent } from "../services/webhook-delivery";
import { notifyRealtime } from "../lib/notify-post-update";
import type { Env, Variables } from "../types";
import { PRICING } from "../types";
import { applyWorkspaceScope, assertWorkspaceScope } from "../lib/workspace-scope";
import { presignRelayMediaUrls } from "../lib/r2-presign";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const PRESIGN_GET_EXPIRES = 3600;

async function presignMediaUrls(
	env: Env,
	mediaArr: Array<{ url: string; type?: string }> | null,
): Promise<Array<{ url: string; type?: string }> | null> {
	return presignRelayMediaUrls(env, mediaArr, PRESIGN_GET_EXPIRES);
}

// --- Route definitions ---

const listPosts = createRoute({
	operationId: "listPosts",
	method: "get",
	path: "/",
	tags: ["Posts"],
	summary: "List posts",
	security: [{ Bearer: [] }],
	request: { query: FilterParams },
	responses: {
		200: {
			description: "List of posts",
			content: { "application/json": { schema: PostListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const PublishLogEntry = z.object({
	id: z.string().describe("Log entry ID (post target ID)"),
	post_id: z.string().describe("Post ID"),
	social_account_id: z.string().describe("Social account ID"),
	platform: z.string().describe("Platform name"),
	status: z.string().describe("Target status"),
	platform_post_id: z.string().nullable().describe("Platform post ID"),
	platform_url: z.string().nullable().describe("Published URL"),
	error: z.string().nullable().describe("Error message if failed"),
	published_at: z
		.string()
		.datetime()
		.nullable()
		.describe("Published timestamp"),
	updated_at: z.string().datetime().describe("Last updated"),
});

const PublishLogListResponse = z.object({
	data: z.array(PublishLogEntry),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
});

const listAllPostLogs = createRoute({
	operationId: "listAllPostLogs",
	method: "get",
	path: "/logs",
	tags: ["Posts"],
	summary: "List all publishing logs",
	description: "Query publishing logs across all posts with pagination.",
	security: [{ Bearer: [] }],
	request: { query: PaginationParams },
	responses: {
		200: {
			description: "Publishing logs",
			content: {
				"application/json": { schema: PublishLogListResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const createPostRoute = createRoute({
	operationId: "createPost",
	method: "post",
	path: "/",
	tags: ["Posts"],
	summary: "Create a post",
	description:
		'Create a post. Use scheduled_at: "now" to publish immediately, "draft" to save as draft, or an ISO timestamp to schedule.',
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: CreatePostBody } } },
	},
	responses: {
		201: {
			description: "Post created",
			content: { "application/json": { schema: PostResponse } },
		},
		400: {
			description: "Bad request",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Quota exceeded",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getPost = createRoute({
	operationId: "getPost",
	method: "get",
	path: "/{id}",
	tags: ["Posts"],
	summary: "Get a post",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Post details",
			content: { "application/json": { schema: PostResponse } },
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

const updatePostRoute = createRoute({
	operationId: "updatePost",
	method: "patch",
	path: "/{id}",
	tags: ["Posts"],
	summary: "Update a post",
	description: "Update a draft or scheduled post.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: { content: { "application/json": { schema: UpdatePostBody } } },
	},
	responses: {
		200: {
			description: "Post updated",
			content: { "application/json": { schema: PostResponse } },
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

const deletePost = createRoute({
	operationId: "deletePost",
	method: "delete",
	path: "/{id}",
	tags: ["Posts"],
	summary: "Delete a post",
	description: "Delete a post.",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Post deleted" },
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

const retryPost = createRoute({
	operationId: "retryPost",
	method: "post",
	path: "/{id}/retry",
	tags: ["Posts"],
	summary: "Retry failed targets",
	description: "Retry publishing for failed targets on a post.",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Post retried",
			content: { "application/json": { schema: PostResponse } },
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

const bulkCreatePosts = createRoute({
	operationId: "bulkCreatePosts",
	method: "post",
	path: "/bulk",
	tags: ["Posts"],
	summary: "Bulk create posts",
	description:
		"Create multiple posts in a single request. Each item follows the same schema as single post creation.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": {
					schema: z.object({
						posts: z
							.array(CreatePostBody)
							.min(1)
							.max(50)
							.describe("Array of posts to create (max 50)"),
					}),
				},
			},
		},
	},
	responses: {
		201: {
			description: "Posts created",
			content: {
				"application/json": {
					schema: z.object({
						data: z.array(PostResponse),
						summary: z.object({
							total: z.number(),
							succeeded: z.number(),
							failed: z.number(),
						}),
					}),
				},
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const unpublishPost = createRoute({
	operationId: "unpublishPost",
	method: "post",
	path: "/{id}/unpublish",
	tags: ["Posts"],
	summary: "Unpublish a published post",
	description:
		"Attempt to delete the post from each platform and set the post status to cancelled.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: {
				"application/json": {
					schema: z.object({
						platforms: z.array(z.string()).optional().describe("Platforms to unpublish from. If omitted, unpublishes from all."),
					}),
				},
			},
			required: false,
		},
	},
	responses: {
		200: {
			description: "Post unpublished",
			content: { "application/json": { schema: PostResponse } },
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

// --- Recycling sub-route definitions ---

const getRecyclingConfig = createRoute({
	operationId: "getRecyclingConfig",
	method: "get",
	path: "/{id}/recycling",
	tags: ["Posts"],
	summary: "Get recycling configuration",
	description: "Get the recycling configuration for a post.",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Recycling configuration",
			content: {
				"application/json": { schema: RecyclingConfigResponse },
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

const putRecyclingConfig = createRoute({
	operationId: "putRecyclingConfig",
	method: "put",
	path: "/{id}/recycling",
	tags: ["Posts"],
	summary: "Set recycling configuration",
	description:
		"Create or replace the recycling configuration for a post. Pro plan only.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: RecyclingInput } },
		},
	},
	responses: {
		200: {
			description: "Recycling configuration set",
			content: {
				"application/json": {
					schema: z.object({
						data: RecyclingConfigResponse,
						warnings: z.array(z.string()).optional(),
					}),
				},
			},
		},
		400: {
			description: "Validation failed",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Pro plan required",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteRecyclingConfig = createRoute({
	operationId: "deleteRecyclingConfig",
	method: "delete",
	path: "/{id}/recycling",
	tags: ["Posts"],
	summary: "Remove recycling configuration",
	description: "Stop recycling and remove the configuration.",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Recycling configuration removed" },
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

const listRecycledCopies = createRoute({
	operationId: "listRecycledCopies",
	method: "get",
	path: "/{id}/recycled-copies",
	tags: ["Posts"],
	summary: "List recycled copies of a post",
	description: "List all posts that were created by recycling this post.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		query: PaginationParams,
	},
	responses: {
		200: {
			description: "List of recycled copies",
			content: { "application/json": { schema: PostListResponse } },
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

// --- Helpers ---

function formatRecyclingConfig(
	config: typeof postRecyclingConfigs.$inferSelect,
) {
	return {
		id: config.id,
		enabled: config.enabled,
		gap: config.gap,
		gap_freq: config.gapFreq,
		start_date: config.startDate.toISOString(),
		expire_count: config.expireCount,
		expire_date: config.expireDate?.toISOString() ?? null,
		content_variations: config.contentVariations ?? [],
		recycle_count: config.recycleCount,
		content_variation_index: config.contentVariationIndex,
		next_recycle_at: config.nextRecycleAt?.toISOString() ?? null,
		last_recycled_at: config.lastRecycledAt?.toISOString() ?? null,
		created_at: config.createdAt.toISOString(),
		updated_at: config.updatedAt.toISOString(),
	};
}

function buildTargetResponse(
	targets: Array<{
		socialAccountId: string;
		platform: string;
		status: string;
		platformUrl: string | null;
		platformPostId?: string | null;
		error: string | null;
		username?: string | null;
		displayName?: string | null;
		avatarUrl?: string | null;
	}>,
) {
	const result: Record<string, unknown> = {};
	for (const t of targets) {
		result[t.socialAccountId] = {
			status: t.status,
			platform: t.platform,
			accounts: [{
				id: t.socialAccountId,
				username: t.username ?? null,
				display_name: t.displayName ?? null,
				avatar_url: t.avatarUrl ?? null,
				url: t.platformUrl,
				platform_post_id: t.platformPostId ?? null,
			}],
			...(t.error
				? { error: { code: "PUBLISH_FAILED", message: t.error } }
				: {}),
		};
	}
	return result;
}

// --- Route handlers ---

app.openapi(listPosts, async (c) => {
	const orgId = c.get("orgId");
	const { cursor, limit, workspace_id, account_id, status, from, to, include, include_external } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const includeSet = new Set((include ?? "").split(",").map((s) => s.trim()).filter(Boolean));
	const includeTargets = includeSet.has("targets");
	const includeMedia = includeSet.has("media");

	const conditions = [eq(posts.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, posts.workspaceId);

	if (cursor) {
		conditions.push(lt(posts.createdAt, new Date(cursor)));
	}

	if (status) {
		conditions.push(eq(posts.status, status));
	}

	if (from) {
		const fromDate = new Date(from);
		conditions.push(or(gte(posts.scheduledAt, fromDate), gte(posts.publishedAt, fromDate))!);
	}
	if (to) {
		const toDate = new Date(to);
		conditions.push(or(lte(posts.scheduledAt, toDate), lte(posts.publishedAt, toDate))!);
	}

	if (account_id) {
		conditions.push(
			sql`${posts.id} IN (SELECT ${postTargets.postId} FROM ${postTargets} WHERE ${postTargets.socialAccountId} = ${account_id})`,
		);
	} else if (workspace_id) {
		conditions.push(
			or(
				eq(posts.workspaceId, workspace_id),
				sql`${posts.id} IN (SELECT ${postTargets.postId} FROM ${postTargets} JOIN ${socialAccounts} ON ${postTargets.socialAccountId} = ${socialAccounts.id} WHERE ${socialAccounts.workspaceId} = ${workspace_id})`,
			)!,
		);
	}

	const allPosts = await db
		.select({
			id: posts.id,
			status: posts.status,
			content: posts.content,
			notes: posts.notes,
			scheduledAt: posts.scheduledAt,
			publishedAt: posts.publishedAt,
			platformOverrides: posts.platformOverrides,
			metricsSnapshot: posts.metricsSnapshot,
			recycledFromId: posts.recycledFromId,
			createdAt: posts.createdAt,
			updatedAt: posts.updatedAt,
		})
		.from(posts)
		.where(and(...conditions))
		.orderBy(desc(posts.createdAt))
		.limit(limit + 1);

	const hasMore = allPosts.length > limit;
	const data = allPosts.slice(0, limit);

	const postIds = data.map((p) => p.id);

	// When include=targets, fetch full target data with account info
	if (includeTargets && postIds.length > 0) {
		const fullTargets = await db
			.select({
				postId: postTargets.postId,
				socialAccountId: postTargets.socialAccountId,
				platform: postTargets.platform,
				status: postTargets.status,
				platformUrl: postTargets.platformUrl,
				platformPostId: postTargets.platformPostId,
				error: postTargets.error,
				publishedAt: postTargets.publishedAt,
				username: socialAccounts.username,
				displayName: socialAccounts.displayName,
				avatarUrl: socialAccounts.avatarUrl,
			})
			.from(postTargets)
			.leftJoin(socialAccounts, eq(postTargets.socialAccountId, socialAccounts.id))
			.where(inArray(postTargets.postId, postIds));

		const targetsByPost = new Map<string, typeof fullTargets>();
		const platformsByPost = new Map<string, string[]>();
		for (const t of fullTargets) {
			const list = targetsByPost.get(t.postId) ?? [];
			list.push(t);
			targetsByPost.set(t.postId, list);

			const platforms = platformsByPost.get(t.postId) ?? [];
			if (!platforms.includes(t.platform)) platforms.push(t.platform);
			platformsByPost.set(t.postId, platforms);
		}

		// For published posts, look up platform media URLs from external posts
		// so previews persist after R2 files expire (30 days)
		const allPlatformPostIds: string[] = [];
		for (const targets of targetsByPost.values()) {
			for (const t of targets) {
				if (t.status === "published" && t.platformPostId) {
					allPlatformPostIds.push(t.platformPostId);
				}
			}
		}
		const extMediaByPlatformPostId = new Map<string, Array<{ url: string; type?: string }>>();
		if (includeMedia && allPlatformPostIds.length > 0) {
			const extRows = await db
				.select({
					platformPostId: externalPosts.platformPostId,
					mediaUrls: externalPosts.mediaUrls,
					mediaType: externalPosts.mediaType,
					thumbnailUrl: externalPosts.thumbnailUrl,
				})
				.from(externalPosts)
				.where(and(
					inArray(externalPosts.platformPostId, allPlatformPostIds),
					eq(externalPosts.organizationId, orgId),
				));
			for (const row of extRows) {
				const media: Array<{ url: string; type?: string }> = [];
				const urls = row.mediaUrls as string[] | null;
				if (urls && urls.length > 0) {
					for (const url of urls) {
						media.push({ url, type: row.mediaType ?? undefined });
					}
				} else if (row.thumbnailUrl) {
					// Fallback to thumbnail only when no full media URLs exist (e.g. video poster)
					media.push({ url: row.thumbnailUrl, type: row.mediaType ?? undefined });
				}
				if (media.length > 0) {
					extMediaByPlatformPostId.set(row.platformPostId, media);
				}
			}
		}

		const internalItems = await Promise.all(data.map(async (p) => {
				const pTargets = targetsByPost.get(p.id) ?? [];
				const overrides = p.platformOverrides as Record<string, any> | null;
				const rawMedia = includeMedia && overrides?._media
					? (overrides._media as Array<{ url: string; type?: string }>)
					: null;

				// Prefer platform CDN media from external posts for published posts
				let mediaArr: Array<{ url: string; type?: string }> | null = null;
				if (includeMedia && p.status === "published") {
					for (const t of pTargets) {
						if (t.status === "published" && t.platformPostId) {
							const extMedia = extMediaByPlatformPostId.get(t.platformPostId);
							if (extMedia) {
								mediaArr = extMedia;
								break;
							}
						}
					}
				}
				// Fall back to presigned R2 URLs
				if (!mediaArr) {
					mediaArr = includeMedia ? await presignMediaUrls(c.env, rawMedia) : rawMedia;
				}

				return {
					id: p.id,
					source: "internal" as const,
					status: p.status,
					content: p.content,
					notes: p.notes ?? null,
					platforms: platformsByPost.get(p.id) ?? [],
					scheduled_at: p.scheduledAt?.toISOString() ?? null,
					published_at: p.publishedAt?.toISOString() ?? null,
					targets: buildTargetResponse(pTargets),
					media: mediaArr,
					metrics: (p.metricsSnapshot as Record<string, number>) ?? {},
					recycling: null,
					recycled_from_id: p.recycledFromId ?? null,
					created_at: p.createdAt.toISOString(),
					updated_at: p.updatedAt.toISOString(),
				};
			}));

		// Merge external posts if requested
		if (include_external === "true" && (!status || status === "published")) {
			const ext = await fetchExternalPostItems(db, orgId, c, { workspace_id, account_id, from, to, limit });
			const merged = mergeByPublishedAt(internalItems, ext, limit);
			return c.json(
				{
					data: merged,
					next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
					has_more: hasMore || ext.length >= limit,
				},
				200,
			);
		}

		return c.json(
			{
				data: internalItems,
				next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
				has_more: hasMore,
			},
			200,
		);
	}

	// Default lean response (no include=targets; still handles include=media)
	const targets = postIds.length > 0
		? await db
				.select({
					postId: postTargets.postId,
					platform: postTargets.platform,
				})
				.from(postTargets)
				.where(inArray(postTargets.postId, postIds))
		: [];

	const platformsByPost = new Map<string, string[]>();
	for (const t of targets) {
		const list = platformsByPost.get(t.postId) ?? [];
		if (!list.includes(t.platform)) list.push(t.platform);
		platformsByPost.set(t.postId, list);
	}

	const leanItems = await Promise.all(data.map(async (p) => {
		let mediaArr: Array<{ url: string; type?: string }> | null = null;
		if (includeMedia) {
			const overrides = p.platformOverrides as Record<string, any> | null;
			const rawMedia = overrides?._media
				? (overrides._media as Array<{ url: string; type?: string }>)
				: null;
			mediaArr = await presignMediaUrls(c.env, rawMedia);
		}
		return {
			id: p.id,
			source: "internal" as const,
			status: p.status,
			content: p.content,
			platforms: platformsByPost.get(p.id) ?? [],
			scheduled_at: p.scheduledAt?.toISOString() ?? null,
			published_at: p.publishedAt?.toISOString() ?? null,
			targets: {},
			media: mediaArr,
			metrics: (p.metricsSnapshot as Record<string, number>) ?? {},
			recycling: null,
			recycled_from_id: p.recycledFromId ?? null,
			created_at: p.createdAt.toISOString(),
			updated_at: p.updatedAt.toISOString(),
		};
	}));

	// Merge external posts if requested
	if (include_external === "true" && (!status || status === "published")) {
		const ext = await fetchExternalPostItems(db, orgId, c, { workspace_id, account_id, from, to, limit });
		const merged = mergeByPublishedAt(leanItems, ext, limit);
		return c.json(
			{
				data: merged,
				next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
				has_more: hasMore || ext.length >= limit,
			},
			200,
		);
	}

	return c.json(
		{
			data: leanItems,
			next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

// ---------------------------------------------------------------------------
// External posts helpers (for include_external merge)
// ---------------------------------------------------------------------------

async function fetchExternalPostItems(
	db: ReturnType<typeof createDb>,
	orgId: string,
	c: any,
	filters: {
		workspace_id?: string;
		account_id?: string;
		from?: string;
		to?: string;
		limit: number;
	},
) {
	const conditions = [eq(externalPosts.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, externalPosts.workspaceId);

	if (filters.account_id) {
		conditions.push(eq(externalPosts.socialAccountId, filters.account_id));
	}
	if (filters.from) {
		conditions.push(gte(externalPosts.publishedAt, new Date(filters.from)));
	}
	if (filters.to) {
		conditions.push(lte(externalPosts.publishedAt, new Date(filters.to)));
	}

	const rows = await db
		.select({
			id: externalPosts.id,
			platform: externalPosts.platform,
			socialAccountId: externalPosts.socialAccountId,
			platformPostId: externalPosts.platformPostId,
			platformUrl: externalPosts.platformUrl,
			content: externalPosts.content,
			mediaUrls: externalPosts.mediaUrls,
			mediaType: externalPosts.mediaType,
			thumbnailUrl: externalPosts.thumbnailUrl,
			metrics: externalPosts.metrics,
			publishedAt: externalPosts.publishedAt,
			createdAt: externalPosts.createdAt,
			accountUsername: socialAccounts.username,
			accountDisplayName: socialAccounts.displayName,
			accountAvatarUrl: socialAccounts.avatarUrl,
		})
		.from(externalPosts)
		.leftJoin(socialAccounts, eq(externalPosts.socialAccountId, socialAccounts.id))
		.where(and(...conditions))
		.orderBy(desc(externalPosts.publishedAt))
		.limit(filters.limit);

	return rows.map((ep) => ({
		id: ep.id,
		source: "external" as const,
		platform: ep.platform,
		social_account_id: ep.socialAccountId,
		platform_post_id: ep.platformPostId,
		platform_url: ep.platformUrl,
		content: ep.content,
		media_urls: (ep.mediaUrls as string[]) ?? [],
		media_type: ep.mediaType,
		thumbnail_url: ep.thumbnailUrl,
		account_name: ep.accountDisplayName || ep.accountUsername || null,
		account_avatar_url: ep.accountAvatarUrl || null,
		metrics: (ep.metrics as Record<string, number>) ?? {},
		published_at: ep.publishedAt.toISOString(),
		created_at: ep.createdAt.toISOString(),
	}));
}

function mergeByPublishedAt(
	internal: any[],
	external: any[],
	limit: number,
): any[] {
	const merged: any[] = [];
	let i = 0;
	let e = 0;

	while (merged.length < limit && (i < internal.length || e < external.length)) {
		const iDate = i < internal.length
			? new Date(internal[i].published_at ?? internal[i].created_at).getTime()
			: -Infinity;
		const eDate = e < external.length
			? new Date(external[e].published_at).getTime()
			: -Infinity;

		if (iDate >= eDate) {
			merged.push(internal[i]);
			i++;
		} else {
			merged.push(external[e]);
			e++;
		}
	}

	return merged;
}

function formatLogEntry(t: {
	id: string;
	postId: string;
	socialAccountId: string;
	platform: string;
	status: string;
	platformPostId: string | null;
	platformUrl: string | null;
	error: string | null;
	publishedAt: Date | null;
	updatedAt: Date;
}) {
	return {
		id: t.id,
		post_id: t.postId,
		social_account_id: t.socialAccountId,
		platform: t.platform,
		status: t.status,
		platform_post_id: t.platformPostId,
		platform_url: t.platformUrl,
		error: t.error,
		published_at: t.publishedAt?.toISOString() ?? null,
		updated_at: t.updatedAt.toISOString(),
	};
}

app.openapi(listAllPostLogs, async (c) => {
	const orgId = c.get("orgId");
	const { limit, from, to } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	// Single JOIN query with DB-level filtering and pagination
	const conditions = [eq(posts.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, posts.workspaceId);
	if (from) conditions.push(gte(postTargets.updatedAt, new Date(from)));
	if (to) conditions.push(lte(postTargets.updatedAt, new Date(to)));

	const rows = await db
		.select({
			id: postTargets.id,
			postId: postTargets.postId,
			socialAccountId: postTargets.socialAccountId,
			platform: postTargets.platform,
			status: postTargets.status,
			platformPostId: postTargets.platformPostId,
			platformUrl: postTargets.platformUrl,
			error: postTargets.error,
			publishedAt: postTargets.publishedAt,
			updatedAt: postTargets.updatedAt,
		})
		.from(postTargets)
		.innerJoin(posts, eq(postTargets.postId, posts.id))
		.where(and(...conditions))
		.orderBy(desc(postTargets.updatedAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	return c.json(
		{
			data: data.map(formatLogEntry),
			next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(createPostRoute, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const isDraft = body.scheduled_at === "draft";
	const isAuto = body.scheduled_at === "auto";

	// Resolve targets
	const { resolved, failed } = await resolveTargets(db, orgId, body.targets, c.get("workspaceScope"));
	const noResolved = resolved.length === 0;

	// Determine intent
	const isNow = body.scheduled_at === "now";

	// Auto-schedule: resolve to the best available slot
	let scheduledAt: Date | null;
	if (isDraft) {
		scheduledAt = null;
	} else if (isNow) {
		scheduledAt = new Date();
	} else if (isAuto) {
		const { findBestSlot } = await import("../services/slot-finder");
		const slot = await findBestSlot(c.env, orgId, {
			accountId: resolved[0]?.accounts[0]?.id,
			after: new Date(),
			strategy: "smart",
		});
		if (!slot) {
			return c.json(
				{
					error: {
						code: "NO_SLOT_AVAILABLE",
						message:
							"No available slot found. Configure queue slots or try a specific time.",
					},
				},
				409 as any,
			);
		}
		scheduledAt = new Date(slot.slot_at);
	} else {
		scheduledAt = new Date(body.scheduled_at);
	}

	const postStatus: "draft" | "scheduled" | "publishing" | "failed" = isDraft
		? "draft"
		: isNow
			? noResolved
				? "failed"
				: "publishing"
			: noResolved
				? "failed"
				: "scheduled";

	// --- Template resolution ---
	let finalContent = body.content ?? null;

	if (body.template_id && !finalContent) {
		try {
			const [tmpl] = await db
				.select()
				.from(contentTemplates)
				.where(
					and(
						eq(contentTemplates.id, body.template_id),
						eq(contentTemplates.organizationId, orgId),
					),
				)
				.limit(1);

			if (tmpl) {
				let rendered = tmpl.content;
				// Built-in variables
				rendered = rendered.replace(/\{\{date\}\}/g, new Date().toISOString().split("T")[0] ?? "");
				// Custom variables from request
				if (body.template_variables) {
					for (const [key, value] of Object.entries(body.template_variables)) {
						// SECURITY: Escape regex metacharacters to prevent ReDoS via user-controlled keys
						const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
						rendered = rendered.replace(new RegExp(`\\{\\{${escapedKey}\\}\\}`, "g"), value);
					}
				}
				finalContent = rendered;
			}
		} catch {
			// Template resolution failure should not block post creation
		}
	}

	// --- Idea resolution ---
	let ideaSource: { id: string; content: string | null } | null = null;
	if (body.idea_id) {
		const [idea] = await db
			.select({ id: ideas.id, content: ideas.content })
			.from(ideas)
			.where(
				and(
					eq(ideas.id, body.idea_id),
					eq(ideas.organizationId, orgId),
				),
			)
			.limit(1);
		if (idea) {
			ideaSource = idea;
			// Use idea content as fallback — explicit content takes precedence
			if (!finalContent) {
				finalContent = idea.content;
			}
		}
	}

	// --- Signature injection ---
	if (finalContent && !body.skip_signature) {
		try {
			const [defaultSig] = await db
				.select()
				.from(signatures)
				.where(
					and(
						eq(signatures.organizationId, orgId),
						eq(signatures.isDefault, true),
					),
				)
				.limit(1);

			if (defaultSig) {
				finalContent =
					defaultSig.position === "prepend"
						? `${defaultSig.content}\n\n${finalContent}`
						: `${finalContent}\n\n${defaultSig.content}`;
			}
		} catch {
			// Signature injection failure should not block post creation
		}
	}

	// --- URL shortening (Pro plan only) ---
	let shortenedUrls: Array<{ original: string; short: string }> = [];

	if (finalContent && !isDraft && c.get("plan") === "pro") {
		try {
			const [slConfig] = await db
				.select()
				.from(shortLinkConfigs)
				.where(eq(shortLinkConfigs.organizationId, orgId))
				.limit(1);

			let shouldShorten = false;
			if (slConfig?.mode === "always") shouldShorten = true;
			if (slConfig?.mode === "ask" && body.shorten_urls === true) shouldShorten = true;

			if (shouldShorten && slConfig?.provider) {
				let provider;
				let apiKey: string | null = null;

				if (slConfig.provider === "relayapi") {
					const { createRelayApiProvider } = await import("../services/short-link-providers/relayapi");
					const baseUrl = c.env.API_BASE_URL || "https://api.relayapi.dev";
					provider = createRelayApiProvider(c.env.KV, baseUrl);
					apiKey = "builtin"; // not used by relayapi provider
				} else if (slConfig.apiKey) {
					provider = getProvider(slConfig.provider as "dub" | "short_io" | "bitly");
					apiKey = await maybeDecrypt(slConfig.apiKey, c.env.ENCRYPTION_KEY);
				}

				if (provider && apiKey) {
					const result = await shortenUrlsInContent(
						provider,
						apiKey,
						slConfig.domain,
						finalContent,
					);
					finalContent = result.content;
					shortenedUrls = result.shortenedUrls;
				}
			}
		} catch (err) {
			// URL shortening failure should not block post creation
			console.error("[ShortLinks] Failed to shorten URLs:", err);
		}
	}

	// Insert post — persist media in platformOverrides._media so that
	// scheduled/queued publishes can retrieve attachments later.
	const platformOverrides: Record<string, unknown> = {
		...(body.target_options ?? {}),
		...(body.media && body.media.length > 0 ? { _media: body.media } : {}),
	};

	// Sentinel type for early-exit error responses inside the transaction
	type TxEarlyReturn = { __earlyReturn: true; body: any; status: number };

	let post: typeof posts.$inferSelect;
	let recyclingResponse: ReturnType<typeof formatRecyclingConfig> | null = null;

	try {
		const txResult = await db.transaction(async (tx) => {
			const rows = await tx
				.insert(posts)
				.values({
					organizationId: orgId,
					workspaceId: body.workspace_id ?? null,
					content: finalContent,
					status: postStatus,
					scheduledAt,
					timezone: body.timezone,
					platformOverrides:
						Object.keys(platformOverrides).length > 0 ? platformOverrides : null,
				})
				.returning();
			const txPost = rows[0];
			if (!txPost) {
				throw {
					__earlyReturn: true,
					body: { error: { code: "INTERNAL_ERROR", message: "Failed to create post" } },
					status: 400,
				} as TxEarlyReturn;
			}

			// Track shortened URLs
			if (shortenedUrls.length > 0) {
				await tx.insert(shortLinks).values(
					shortenedUrls.map((sl) => ({
						organizationId: orgId,
						originalUrl: sl.original,
						shortUrl: sl.short,
						postId: txPost.id,
					})),
				);
			}

			// Atomically increment usage counter (skip for drafts)
			if (!isDraft) {
				const now = new Date();
				const cycleStart = new Date(now.getFullYear(), now.getMonth(), 1);
				const cycleEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

				await tx
					.insert(usageRecords)
					.values({
						organizationId: orgId,
						periodStart: cycleStart,
						periodEnd: cycleEnd,
						postsCount: 1,
						postsIncluded: PRICING.proCallsIncluded,
					})
					.onConflictDoUpdate({
						target: [usageRecords.organizationId, usageRecords.periodStart],
						set: {
							postsCount: sql`${usageRecords.postsCount} + 1`,
							overagePosts: sql`GREATEST(0, ${usageRecords.postsCount} + 1 - ${usageRecords.postsIncluded})`,
							overageCostCents: sql`GREATEST(0, ${usageRecords.postsCount} + 1 - ${usageRecords.postsIncluded}) * ${PRICING.pricePerThousandCallsCents}`,
							updatedAt: new Date(),
						},
					});
			}

			// Insert post_targets for resolved accounts (bulk insert)
			const targetValues = resolved.flatMap((target) =>
				target.accounts.map((account) => ({
					postId: txPost.id,
					socialAccountId: account.id,
					platform: target.platform,
					status: (isDraft ? "draft" : isNow ? "publishing" : "scheduled") as
						| "draft"
						| "publishing"
						| "scheduled",
				})),
			);
			if (targetValues.length > 0) {
				await tx.insert(postTargets).values(targetValues);
			}

			// Handle recycling config if provided
			let txRecyclingResponse: ReturnType<typeof formatRecyclingConfig> | null = null;
			if (
				body.recycling &&
				(postStatus === "scheduled" || postStatus === "publishing")
			) {
				const plan = c.get("plan") as string;
				if (plan === "free") {
					throw {
						__earlyReturn: true,
						body: {
							error: {
								code: "PLAN_UPGRADE_REQUIRED",
								message:
									"Post recycling requires a Pro plan. Upgrade to access this feature.",
							},
						},
						status: 403,
					} as TxEarlyReturn;
				} else {
					const validation = await validateRecyclingConfig(
						tx as any,
						orgId,
						txPost.id,
						postStatus,
						body.recycling,
					);
					if (!validation.valid) {
						throw {
							__earlyReturn: true,
							body: { error: validation.error },
							status: 400,
						} as TxEarlyReturn;
					}
					if (validation.valid) {
						const nextRecycle = computeNextRecycleAt(
							new Date(body.recycling.start_date),
							body.recycling.gap,
							body.recycling.gap_freq,
						);
						const [config] = await tx
							.insert(postRecyclingConfigs)
							.values({
								organizationId: orgId,
								sourcePostId: txPost.id,
								enabled: body.recycling.enabled,
								gap: body.recycling.gap,
								gapFreq: body.recycling.gap_freq,
								startDate: new Date(body.recycling.start_date),
								expireCount: body.recycling.expire_count ?? null,
								expireDate: body.recycling.expire_date
									? new Date(body.recycling.expire_date)
									: null,
								contentVariations: body.recycling.content_variations ?? [],
								nextRecycleAt: nextRecycle,
							})
							.returning();
						if (config) {
							txRecyclingResponse = formatRecyclingConfig(config);
						}
					}
				}
			}

			// Create cross-post actions if provided (not for drafts)
			if (body.cross_post_actions && body.cross_post_actions.length > 0 && !isDraft) {
				// SECURITY: Validate all target_account_id values belong to this org to prevent cross-org IDOR
				const targetIds = body.cross_post_actions.map((a) => a.target_account_id);
				const ownedAccounts = await tx
					.select({ id: socialAccounts.id })
					.from(socialAccounts)
					.where(and(inArray(socialAccounts.id, targetIds), eq(socialAccounts.organizationId, orgId)));
				const ownedSet = new Set(ownedAccounts.map((a) => a.id));
				for (const action of body.cross_post_actions) {
					if (!ownedSet.has(action.target_account_id)) {
						throw {
							__earlyReturn: true,
							body: { error: { code: "NOT_FOUND", message: `Target account ${action.target_account_id} not found` } },
							status: 404,
						} as TxEarlyReturn;
					}
				}

				const publishDate = scheduledAt ?? new Date();
				const actionValues = body.cross_post_actions.map((action) => ({
					postId: txPost.id,
					actionType: action.action_type,
					targetAccountId: action.target_account_id,
					content: action.content ?? null,
					delayMinutes: action.delay_minutes,
					executeAt: new Date(publishDate.getTime() + action.delay_minutes * 60 * 1000),
				}));
				await tx.insert(crossPostActions).values(actionValues);
			}

			return { post: txPost, recyclingResponse: txRecyclingResponse };
		});

		post = txResult.post;
		recyclingResponse = txResult.recyclingResponse;
	} catch (err: any) {
		if (err && err.__earlyReturn) {
			return c.json(err.body as never, err.status as never);
		}
		throw err;
	}

	// --- Update idea reference if created from an idea ---
	if (ideaSource) {
		c.executionCtx.waitUntil(
			(async () => {
				await db
					.update(ideas)
					.set({ convertedToPostId: post.id, updatedAt: new Date() })
					.where(eq(ideas.id, ideaSource!.id));
				await db.insert(ideaActivity).values({
					ideaId: ideaSource!.id,
					actorId: c.get("keyId"),
					action: "converted",
					metadata: { post_id: post.id },
				});
			})(),
		);
	}

	// Build response targets
	const responseTargets: Record<string, unknown> = {};

	for (const target of resolved) {
		responseTargets[target.key] = {
			status: isDraft ? "draft" : isNow ? "publishing" : "scheduled",
			platform: target.platform,
			accounts: target.accounts.map((a) => ({
				id: a.id,
				username: a.username,
				url: null,
			})),
		};
	}
	for (const f of failed) {
		responseTargets[f.key] = {
			status: "failed",
			platform: null,
			error: f.error,
		};
	}

	// Publish now — fire-and-forget via waitUntil so the response returns immediately.
	// Publishing can take 8-30+ seconds (Instagram needs to download and process media).
	// Blocking the response causes frontend timeouts and duplicate retries.
	if (isNow && resolved.length > 0) {
		// Enqueue to PUBLISH_QUEUE — queue consumers have 15min timeout vs 30s for waitUntil,
		// which is required for video publishing (Threads/Instagram poll for minutes).
		c.executionCtx.waitUntil(
			c.env.PUBLISH_QUEUE.send({
				type: "publish",
				post_id: post.id,
				org_id: orgId,
				usage_tracked: true, // middleware already incremented usage
			}),
		);
		c.executionCtx.waitUntil(notifyRealtime(c.env, orgId, { type: "post.created", post_id: post.id, status: "publishing" }));

		const presignedMedia = await presignMediaUrls(c.env, body.media ?? null);
		return c.json(
			{
				id: post.id,
				status: "publishing",
				content: post.content,
				scheduled_at: body.scheduled_at,
				targets: responseTargets,
				media: presignedMedia,
				recycling: recyclingResponse,
				recycled_from_id: null,
				created_at: post.createdAt.toISOString(),
				updated_at: new Date().toISOString(),
			},
			201,
		);
	}

	if (postStatus === "scheduled") {
		c.executionCtx.waitUntil(
			dispatchWebhookEvent(c.env, db, orgId, "post.scheduled", {
				post_id: post.id,
				status: "scheduled",
				scheduled_at: body.scheduled_at,
				targets: responseTargets,
			}),
		);
	}

	c.executionCtx.waitUntil(notifyRealtime(c.env, orgId, { type: "post.created", post_id: post.id, status: postStatus }));

	const presignedMedia = await presignMediaUrls(c.env, body.media ?? null);
	return c.json(
		{
			id: post.id,
			status: postStatus,
			content: post.content,
			scheduled_at: body.scheduled_at,
			targets: responseTargets,
			media: presignedMedia,
			recycling: recyclingResponse,
			recycled_from_id: null,
			created_at: post.createdAt.toISOString(),
			updated_at: post.updatedAt.toISOString(),
		},
		201,
	);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getPost, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [post] = await db
		.select({
			id: posts.id,
			status: posts.status,
			content: posts.content,
			notes: posts.notes,
			scheduledAt: posts.scheduledAt,
			platformOverrides: posts.platformOverrides,
			timezone: posts.timezone,
			recycledFromId: posts.recycledFromId,
			createdAt: posts.createdAt,
			updatedAt: posts.updatedAt,
		})
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	const [targets, [recyclingConfig]] = await Promise.all([
		db
			.select({
				socialAccountId: postTargets.socialAccountId,
				platform: postTargets.platform,
				status: postTargets.status,
				platformUrl: postTargets.platformUrl,
				platformPostId: postTargets.platformPostId,
				error: postTargets.error,
				username: socialAccounts.username,
				displayName: socialAccounts.displayName,
				avatarUrl: socialAccounts.avatarUrl,
			})
			.from(postTargets)
			.leftJoin(socialAccounts, eq(postTargets.socialAccountId, socialAccounts.id))
			.where(eq(postTargets.postId, post.id)),
		db
			.select()
			.from(postRecyclingConfigs)
			.where(eq(postRecyclingConfigs.sourcePostId, post.id))
			.limit(1),
	]);

	const overrides = post.platformOverrides as Record<string, any> | null;
	const rawMedia = overrides?._media
		? (overrides._media as Array<{ url: string; type?: string }>)
		: null;
	const mediaArr = await presignMediaUrls(c.env, rawMedia);
	const targetOpts = overrides
		? Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "_media"))
		: null;

	return c.json(
		{
			id: post.id,
			status: post.status,
			content: post.content,
			notes: post.notes ?? null,
			scheduled_at: post.scheduledAt?.toISOString() ?? null,
			targets: buildTargetResponse(targets),
			media: mediaArr,
			target_options: (targetOpts && Object.keys(targetOpts).length > 0) ? targetOpts : null,
			timezone: post.timezone ?? null,
			recycling: recyclingConfig
				? formatRecyclingConfig(recyclingConfig)
				: null,
			recycled_from_id: post.recycledFromId ?? null,
			created_at: post.createdAt.toISOString(),
			updated_at: post.updatedAt.toISOString(),
		},
		200,
	);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(updatePostRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [post] = await db
		.select()
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	if (!["draft", "scheduled", "failed"].includes(post.status)) {
		return c.json(
			{
				error: {
					code: "INVALID_STATE",
					message: `Cannot update a post with status "${post.status}".`,
				},
			},
			400,
		);
	}

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (body.content !== undefined) updates.content = body.content;
	if (body.notes !== undefined) updates.notes = body.notes;
	if (body.timezone !== undefined) updates.timezone = body.timezone;

	// Merge platformOverrides: preserve _media when updating target_options and vice versa
	const existingOverrides = (post.platformOverrides as Record<string, any>) ?? {};
	const { _media: existingMedia, ...existingOpts } = existingOverrides;
	let newOverrides = { ...existingOverrides };
	let overridesChanged = false;

	if (body.target_options !== undefined) {
		newOverrides = {
			...body.target_options,
			...(existingMedia ? { _media: existingMedia } : {}),
		};
		overridesChanged = true;
	}
	if (body.media !== undefined) {
		if (body.media.length > 0) {
			newOverrides._media = body.media;
		} else {
			delete newOverrides._media;
		}
		overridesChanged = true;
	}
	if (overridesChanged) {
		updates.platformOverrides = Object.keys(newOverrides).length > 0 ? newOverrides : null;
	}

	if (body.scheduled_at !== undefined) {
		if (body.scheduled_at === "draft") {
			updates.status = "draft";
			updates.scheduledAt = null;
		} else if (body.scheduled_at === "now") {
			updates.status = "publishing";
		} else {
			updates.status = "scheduled";
			updates.scheduledAt = new Date(body.scheduled_at);
		}
	}

	const updatedRows = await db
		.update(posts)
		.set(updates)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.returning();
	const updated = updatedRows[0] ?? post;

	// Handle targets update
	if (body.targets !== undefined && body.targets.length > 0) {
		const { resolved } = await resolveTargets(
			db, orgId, body.targets, c.get("workspaceScope"),
		);

		await db.delete(postTargets).where(eq(postTargets.postId, id));

		const targetStatus = updated.status === "draft" ? "draft"
			: updated.status === "publishing" ? "publishing"
			: "scheduled";

		const targetValues = resolved.flatMap((target) =>
			target.accounts.map((account) => ({
				postId: id,
				socialAccountId: account.id,
				platform: target.platform as any,
				status: targetStatus as any,
			})),
		);
		if (targetValues.length > 0) {
			await db.insert(postTargets).values(targetValues);
		}
	}

	// Enqueue for publishing if status changed to "publishing"
	if (updates.status === "publishing") {
		c.executionCtx.waitUntil(
			c.env.PUBLISH_QUEUE.send({
				type: "publish",
				post_id: id,
				org_id: orgId,
				usage_tracked: false,
			}),
		);
	}

	if (updates.status === "scheduled") {
		c.executionCtx.waitUntil(
			dispatchWebhookEvent(c.env, db, orgId, "post.scheduled", {
				post_id: id,
				status: "scheduled",
				scheduled_at: body.scheduled_at,
				targets: {},
			}),
		);
	}

	// Fetch updated targets and recycling config for response
	const [updatedTargets, [recyclingConfig]] = await Promise.all([
		db
			.select({
				socialAccountId: postTargets.socialAccountId,
				platform: postTargets.platform,
				status: postTargets.status,
				platformUrl: postTargets.platformUrl,
				platformPostId: postTargets.platformPostId,
				error: postTargets.error,
				username: socialAccounts.username,
				displayName: socialAccounts.displayName,
				avatarUrl: socialAccounts.avatarUrl,
			})
			.from(postTargets)
			.leftJoin(socialAccounts, eq(postTargets.socialAccountId, socialAccounts.id))
			.where(eq(postTargets.postId, id)),
		db
			.select()
			.from(postRecyclingConfigs)
			.where(eq(postRecyclingConfigs.sourcePostId, id))
			.limit(1),
	]);

	const finalOverrides = (updated.platformOverrides as Record<string, any>) ?? {};
	const responseMedia = await presignMediaUrls(
		c.env,
		finalOverrides._media
			? (finalOverrides._media as Array<{ url: string; type?: string }>)
			: null,
	);
	const responseOpts = Object.fromEntries(
		Object.entries(finalOverrides).filter(([k]) => k !== "_media"),
	);

	c.executionCtx.waitUntil(notifyRealtime(c.env, orgId, { type: "post.updated", post_id: id, status: updated.status }));
	return c.json(
		{
			id: updated.id,
			status: updated.status,
			content: updated.content,
			notes: updated.notes ?? null,
			scheduled_at:
				updated.scheduledAt?.toISOString() ?? body.scheduled_at ?? null,
			targets: buildTargetResponse(updatedTargets),
			media: responseMedia,
			target_options: Object.keys(responseOpts).length > 0 ? responseOpts : null,
			timezone: updated.timezone ?? null,
			recycling: recyclingConfig
				? formatRecyclingConfig(recyclingConfig)
				: null,
			recycled_from_id: updated.recycledFromId ?? null,
			created_at: updated.createdAt.toISOString(),
			updated_at: updated.updatedAt.toISOString(),
		},
		200,
	);
});

app.openapi(deletePost, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [post] = await db
		.select({ id: posts.id, status: posts.status })
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	// Delete recycling config, targets, then post (FK constraints)
	await db
		.delete(postRecyclingConfigs)
		.where(eq(postRecyclingConfigs.sourcePostId, id));
	await db.delete(postTargets).where(eq(postTargets.postId, id));
	await db.delete(posts).where(eq(posts.id, id));

	c.executionCtx.waitUntil(notifyRealtime(c.env, orgId, { type: "post.deleted", post_id: id }));
	return c.body(null, 204);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(retryPost, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [post] = await db
		.select()
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	if (!["failed", "partial"].includes(post.status)) {
		return c.json(
			{
				error: {
					code: "INVALID_STATE",
					message: 'Can only retry posts with status "failed" or "partial".',
				},
			},
			400,
		);
	}

	// Get failed targets
	const failedTargets = await db
		.select()
		.from(postTargets)
		.where(and(eq(postTargets.postId, id), eq(postTargets.status, "failed")));

	// Charge usage for each failed target being retried (N platforms = N units)
	if (failedTargets.length > 0) {
		await incrementUsage(c.env.KV, orgId, failedTargets.length);
	}

	if (failedTargets.length === 0) {
		const allTargets = await db
			.select()
			.from(postTargets)
			.where(eq(postTargets.postId, id));

		return c.json(
			{
				id: post.id,
				status: post.status,
				content: post.content,
				scheduled_at: post.scheduledAt?.toISOString() ?? null,
				targets: buildTargetResponse(allTargets),
				media: null,
				recycling: null,
				recycled_from_id: post.recycledFromId ?? null,
				created_at: post.createdAt.toISOString(),
				updated_at: post.updatedAt.toISOString(),
			},
			200,
		);
	}

	// Reset failed targets to publishing (batch update)
	const failedTargetIds = failedTargets.map((t) => t.id);
	await db
		.update(postTargets)
		.set({ status: "publishing", error: null })
		.where(inArray(postTargets.id, failedTargetIds));

	// Batch-fetch all social accounts for failed targets
	const accountIds = [...new Set(failedTargets.map((t) => t.socialAccountId))];
	const wsScope = c.get("workspaceScope");
	const retryAccountConditions = [inArray(socialAccounts.id, accountIds)];
	if (wsScope !== "all") {
		retryAccountConditions.push(inArray(socialAccounts.workspaceId, wsScope));
	}
	const accounts = await db
		.select({
			id: socialAccounts.id,
			username: socialAccounts.username,
		})
		.from(socialAccounts)
		.where(and(...retryAccountConditions));
	const accountMap = new Map(accounts.map((a) => [a.id, a]));

	// Group failed targets for publishing
	const targetMap = new Map<string, PublishTargetInput>();
	for (const t of failedTargets) {
		const account = accountMap.get(t.socialAccountId);
		if (!account) continue;

		const key = t.platform;
		const existing = targetMap.get(key);
		if (existing) {
			existing.accounts.push(account);
		} else {
			targetMap.set(key, {
				key,
				platform: t.platform as Platform,
				accounts: [account],
			});
		}
	}

	const targetOverrides =
		(post.platformOverrides as Record<string, Record<string, unknown>>) ?? null;

	const results = await publishToTargets(
		c.env,
		post.id,
		orgId,
		post.content,
		[],
		targetOverrides,
		Array.from(targetMap.values()),
	);

	// Parallel fetch: all targets + updated post
	const [allTargets, [updatedPost]] = await Promise.all([
		db.select().from(postTargets).where(eq(postTargets.postId, id)),
		db
			.select({
				id: posts.id,
				status: posts.status,
				content: posts.content,
				scheduledAt: posts.scheduledAt,
				recycledFromId: posts.recycledFromId,
				createdAt: posts.createdAt,
				updatedAt: posts.updatedAt,
			})
			.from(posts)
			.where(eq(posts.id, id))
			.limit(1),
	]);

	const finalPost = updatedPost ?? post;

	c.executionCtx.waitUntil(notifyRealtime(c.env, orgId, { type: "post.updated", post_id: id, status: finalPost.status }));
	return c.json(
		{
			id: finalPost.id,
			status: finalPost.status,
			content: finalPost.content,
			scheduled_at: finalPost.scheduledAt?.toISOString() ?? null,
			targets: buildTargetResponse(allTargets),
			media: null,
			recycling: null,
			recycled_from_id: finalPost.recycledFromId ?? null,
			created_at: finalPost.createdAt.toISOString(),
			updated_at: finalPost.updatedAt.toISOString(),
		},
		200,
	);
});

// ---------------------------------------------------------------------------
// Bulk create
// ---------------------------------------------------------------------------

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(bulkCreatePosts, async (c) => {
	const orgId = c.get("orgId");
	const { posts: postItems } = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	// Pre-fetch org accounts once for all items (resolveTargets fetches them each time)
	const wsScope = c.get("workspaceScope");
	const prefetchConditions = [eq(socialAccounts.organizationId, orgId)];
	if (wsScope !== "all") {
		prefetchConditions.push(inArray(socialAccounts.workspaceId, wsScope));
	}
	const orgAccounts = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			workspaceId: socialAccounts.workspaceId,
		})
		.from(socialAccounts)
		.where(and(...prefetchConditions));

	const results: Array<Record<string, unknown>> = [];
	let succeeded = 0;
	let failed = 0;

	const autoScheduledTimes: Date[] = []; // Accumulate auto-scheduled times to avoid collisions within batch
	for (const item of postItems) {
		try {
			const { resolved, failed: failedTargets } = await resolveTargets(
				db,
				orgId,
				item.targets,
				wsScope,
				orgAccounts,
			);

			const isDraft = item.scheduled_at === "draft";
			const isNow = item.scheduled_at === "now";
			const isAuto = item.scheduled_at === "auto";

			let scheduledAt: Date | null;
			if (isDraft) {
				scheduledAt = null;
			} else if (isNow) {
				scheduledAt = new Date();
			} else if (isAuto) {
				const { findBestSlot } = await import("../services/slot-finder");
				const slot = await findBestSlot(c.env, orgId, {
					accountId: resolved[0]?.accounts[0]?.id,
					after: new Date(),
					strategy: "smart",
					excludeTimes: autoScheduledTimes,
				});
				if (!slot) {
					results.push({ status: "error", error: { code: "NO_SLOT_AVAILABLE", message: "No available slot found for auto-scheduling." } });
					failed++;
					continue;
				}
				scheduledAt = new Date(slot.slot_at);
				autoScheduledTimes.push(scheduledAt);
			} else {
				scheduledAt = new Date(item.scheduled_at);
			}

			const postStatus: "draft" | "scheduled" | "publishing" | "failed" =
				isDraft
					? "draft"
					: isNow
						? resolved.length === 0
							? "failed"
							: "publishing"
						: resolved.length === 0
							? "failed"
							: "scheduled";

			// Persist media in platformOverrides._media for scheduled/queued publishes
			const bulkPlatformOverrides: Record<string, unknown> = {
				...(item.target_options ?? {}),
				...(item.media && item.media.length > 0 ? { _media: item.media } : {}),
			};

			const rows = await db
				.insert(posts)
				.values({
					organizationId: orgId,
					workspaceId: item.workspace_id ?? null,
					content: item.content ?? null,
					status: postStatus,
					scheduledAt,
					timezone: item.timezone,
					platformOverrides:
						Object.keys(bulkPlatformOverrides).length > 0
							? bulkPlatformOverrides
							: null,
				})
				.returning();
			const post = rows[0];
			if (!post) {
				failed++;
				continue;
			}

			const bulkTargetValues = resolved.flatMap((target) =>
				target.accounts.map((account) => ({
					postId: post.id,
					socialAccountId: account.id,
					platform: target.platform,
					status: (isDraft ? "draft" : isNow ? "publishing" : "scheduled") as
						| "draft"
						| "publishing"
						| "scheduled",
				})),
			);
			if (bulkTargetValues.length > 0) {
				await db.insert(postTargets).values(bulkTargetValues);
			}

			// Publish now if requested
			if (isNow && resolved.length > 0) {
				const publishTargets: PublishTargetInput[] = resolved.map((t) => ({
					key: t.key,
					platform: t.platform,
					accounts: t.accounts.map((a) => ({
						id: a.id,
						username: a.username,
					})),
				}));

				const publishResults = await publishToTargets(
					c.env,
					post.id,
					orgId,
					item.content ?? null,
					(item.media ?? []) as PublishRequest["media"],
					(item.target_options as Record<string, Record<string, unknown>>) ??
						null,
					publishTargets,
				);

				const statuses = Object.values(publishResults).map((t) => t.status);
				const finalStatus = statuses.every((s) => s === "published")
					? "published"
					: statuses.every((s) => s === "failed")
						? "failed"
						: "partial";

				results.push({
					id: post.id,
					status: finalStatus,
					content: post.content,
					scheduled_at: item.scheduled_at,
					targets: publishResults,
					media: item.media ?? null,
					recycling: null,
					recycled_from_id: null,
					created_at: post.createdAt.toISOString(),
					updated_at: new Date().toISOString(),
				});
			} else {
				results.push({
					id: post.id,
					status: postStatus,
					content: post.content,
					scheduled_at: item.scheduled_at,
					targets: {},
					media: item.media ?? null,
					recycling: null,
					recycled_from_id: null,
					created_at: post.createdAt.toISOString(),
					updated_at: post.updatedAt.toISOString(),
				});
			}

			succeeded++;
		} catch {
			failed++;
		}
	}

	return c.json(
		{
			data: results,
			summary: { total: postItems.length, succeeded, failed },
		},
		201,
	);
});

// ---------------------------------------------------------------------------
// Unpublish
// ---------------------------------------------------------------------------

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(unpublishPost, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const selectedPlatforms = body?.platforms as string[] | undefined;
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [post] = await db
		.select()
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	if (!["published", "partial"].includes(post.status)) {
		return c.json(
			{
				error: {
					code: "INVALID_STATE",
					message: `Cannot unpublish a post with status "${post.status}". Only published or partial posts can be unpublished.`,
				},
			},
			400,
		);
	}

	// Get published targets, optionally filtered by platform
	let publishedTargets = await db
		.select()
		.from(postTargets)
		.where(
			and(eq(postTargets.postId, id), eq(postTargets.status, "published")),
		);

	if (selectedPlatforms?.length) {
		publishedTargets = publishedTargets.filter((t) => selectedPlatforms.includes(t.platform));
	}

	// Batch-fetch all accounts needed for deletion in one query
	const accountIds = [
		...new Set(publishedTargets.map((t) => t.socialAccountId)),
	];
	const rawAccounts =
		accountIds.length > 0
			? await db
					.select({
						id: socialAccounts.id,
						platform: socialAccounts.platform,
						accessToken: socialAccounts.accessToken,
						refreshToken: socialAccounts.refreshToken,
						tokenExpiresAt: socialAccounts.tokenExpiresAt,
					})
					.from(socialAccounts)
					.where(inArray(socialAccounts.id, accountIds))
			: [];
	// Decrypt and refresh tokens before platform deletion calls
	const accounts = await Promise.all(
		rawAccounts.map(async (a) => {
			const token = a.platform === "telegram"
				? await maybeDecrypt(a.accessToken, c.env.ENCRYPTION_KEY)
				: await refreshTokenIfNeeded(c.env, {
						id: a.id,
						platform: a.platform,
						accessToken: a.accessToken,
						refreshToken: a.refreshToken,
						tokenExpiresAt: a.tokenExpiresAt,
					});
			return { ...a, accessToken: token };
		}),
	);
	const accountMap = new Map(accounts.map((a) => [a.id, a]));

	// Delete from all platforms in parallel
	const FETCH_TIMEOUT = 10_000;
	const deleteResults = await Promise.allSettled(
		publishedTargets
			.filter((t) => t.platformPostId)
			.map(async (target) => {
				const account = accountMap.get(target.socialAccountId);
				if (!account?.accessToken)
					return { targetId: target.id, success: false };

				let deleteSuccess = false;
				try {
					const signal = AbortSignal.timeout(FETCH_TIMEOUT);
					switch (target.platform) {
						case "twitter":
							deleteSuccess = (
								await fetch(
									`https://api.twitter.com/2/tweets/${target.platformPostId}`,
									{
										method: "DELETE",
										headers: { Authorization: `Bearer ${account.accessToken}` },
										signal,
									},
								)
							).ok;
							break;
						// Facebook Graph API: DELETE a Page post
						// Docs: https://developers.facebook.com/docs/graph-api/reference/post/#deleting
						case "facebook":
							deleteSuccess = (
								await fetch(
									`https://graph.facebook.com/v25.0/${target.platformPostId}`,
									{
										method: "DELETE",
										headers: { Authorization: `Bearer ${account.accessToken}` },
										signal,
									},
								)
							).ok;
							break;
						// Instagram Graph API: DELETE an IG Media object
						// Docs: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/#deleting
						// Host: graph.instagram.com (Instagram Login) or graph.facebook.com (Facebook Login)
						case "instagram": {
							const igHost = account.accessToken.startsWith("IGAA")
								? "graph.instagram.com"
								: "graph.facebook.com";
							deleteSuccess = (
								await fetch(
									`https://${igHost}/v25.0/${target.platformPostId}`,
									{
										method: "DELETE",
										headers: { Authorization: `Bearer ${account.accessToken}` },
										signal,
									},
								)
							).ok;
							break;
						}
						case "linkedin":
							deleteSuccess = (
								await fetch(
									`https://api.linkedin.com/rest/posts/${encodeURIComponent(target.platformPostId!)}`,
									{
										method: "DELETE",
										headers: {
											Authorization: `Bearer ${account.accessToken}`,
											"LinkedIn-Version": "202402",
											"X-Restli-Protocol-Version": "2.0.0",
										},
										signal,
									},
								)
							).ok;
							break;
						case "reddit":
							deleteSuccess = (
								await fetch("https://oauth.reddit.com/api/del", {
									method: "POST",
									headers: {
										Authorization: `Bearer ${account.accessToken}`,
										"Content-Type": "application/x-www-form-urlencoded",
										"User-Agent": "RelayAPI/1.0",
									},
									body: `id=${target.platformPostId}`,
									signal,
								})
							).ok;
							break;
						case "pinterest":
							deleteSuccess = (
								await fetch(
									`https://api.pinterest.com/v5/pins/${target.platformPostId}`,
									{
										method: "DELETE",
										headers: { Authorization: `Bearer ${account.accessToken}` },
										signal,
									},
								)
							).ok;
							break;
					}
				} catch {
					/* timeout or network error */
				}
				return { targetId: target.id, success: deleteSuccess };
			}),
	);

	// Build update promises for targets that went through platform deletion
	const updatePromises: Promise<unknown>[] = [];
	const processedTargetIds = new Set<string>();

	for (const result of deleteResults) {
		const val =
			result.status === "fulfilled"
				? result.value
				: { targetId: "", success: false };
		if (!val.targetId) continue;
		processedTargetIds.add(val.targetId);
		updatePromises.push(
			db
				.update(postTargets)
				.set({
					status: val.success ? "draft" : "failed",
					error: val.success ? null : "Platform deletion failed",
				})
				.where(eq(postTargets.id, val.targetId)),
		);
	}

	// Also update published targets that had no platformPostId (skipped above)
	for (const target of publishedTargets) {
		if (!processedTargetIds.has(target.id)) {
			updatePromises.push(
				db
					.update(postTargets)
					.set({ status: "draft", error: null })
					.where(eq(postTargets.id, target.id)),
			);
		}
	}

	// Flush all target updates + post status update first, THEN re-fetch for response
	await Promise.all([
		...updatePromises,
		db
			.update(posts)
			.set({ status: "draft", updatedAt: new Date() })
			.where(eq(posts.id, id)),
	]);

	const allTargets = await db
		.select()
		.from(postTargets)
		.where(eq(postTargets.postId, id));

	c.executionCtx.waitUntil(notifyRealtime(c.env, orgId, { type: "post.updated", post_id: id, status: "draft" }));
	return c.json(
		{
			id: post.id,
			status: "draft",
			content: post.content,
			scheduled_at: post.scheduledAt?.toISOString() ?? null,
			targets: buildTargetResponse(allTargets),
			media: null,
			recycling: null,
			recycled_from_id: post.recycledFromId ?? null,
			created_at: post.createdAt.toISOString(),
			updated_at: new Date().toISOString(),
		},
		200,
	);
});

// ---------------------------------------------------------------------------
// Post logs
// ---------------------------------------------------------------------------

const getPostLogs = createRoute({
	operationId: "getPostLogs",
	method: "get",
	path: "/{id}/logs",
	tags: ["Posts"],
	summary: "Get publishing logs for a post",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Publishing logs",
			content: {
				"application/json": { schema: PublishLogListResponse },
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

app.openapi(getPostLogs, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [post] = await db
		.select()
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	const targets = await db
		.select()
		.from(postTargets)
		.where(eq(postTargets.postId, id))
		.orderBy(desc(postTargets.updatedAt));

	return c.json(
		{
			data: targets.map(formatLogEntry),
			next_cursor: null,
			has_more: false,
		},
		200,
	);
});

// --- Update Metadata (published videos) ---

const updateMetadata = createRoute({
	operationId: "updatePostMetadata",
	method: "post",
	path: "/{id}/update-metadata",
	tags: ["Posts"],
	summary: "Update metadata on a published video",
	description:
		"Update title, description, tags, visibility, or other metadata on an already-published YouTube video without re-uploading. Use '_' as the post ID with video_id + account_id for videos not published through RelayAPI.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: UpdateMetadataBody } },
		},
	},
	responses: {
		200: {
			description: "Metadata updated",
			content: {
				"application/json": { schema: UpdateMetadataResponse },
			},
		},
		400: {
			description: "Bad request",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Post or video not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(updateMetadata, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	let videoId: string;
	let accountId: string;

	if (id === "_") {
		// Direct mode: video_id + account_id required
		if (!body.video_id || !body.account_id) {
			return c.json(
				{
					error: {
						code: "BAD_REQUEST",
						message:
							'When using "_" as post ID, both video_id and account_id are required.',
					},
				},
				400,
			);
		}
		videoId = body.video_id;
		accountId = body.account_id;
	} else {
		// Post mode: look up the YouTube target
		const targets = await db
			.select({
				platformPostId: postTargets.platformPostId,
				socialAccountId: postTargets.socialAccountId,
				platform: postTargets.platform,
			})
			.from(postTargets)
			.innerJoin(posts, eq(posts.id, postTargets.postId))
			.where(
				and(
					eq(postTargets.postId, id),
					eq(posts.organizationId, orgId),
					eq(postTargets.platform, "youtube"),
				),
			)
			.limit(1);

		const target = targets[0];
		if (!target?.platformPostId) {
			return c.json(
				{
					error: {
						code: "NOT_FOUND",
						message:
							"No published YouTube video found for this post. Ensure the post was published to YouTube.",
					},
				},
				404,
			);
		}
		videoId = target.platformPostId;
		accountId = target.socialAccountId;
	}

	// Get YouTube account access token
	const [account] = await db
		.select({ accessToken: socialAccounts.accessToken, workspaceId: socialAccounts.workspaceId })
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, accountId),
				eq(socialAccounts.organizationId, orgId),
				eq(socialAccounts.platform, "youtube"),
			),
		)
		.limit(1);

	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "YouTube account not found or missing access token.",
				},
			},
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	const token = await maybeDecrypt(
		account.accessToken,
		c.env.ENCRYPTION_KEY,
	);

	// Fetch current video data from YouTube
	const listRes = await fetch(
		`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${videoId}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);

	if (!listRes.ok) {
		return c.json(
			{
				error: {
					code: "YOUTUBE_API_ERROR",
					message: `YouTube API returned ${listRes.status}`,
				},
			},
			400,
		);
	}

	const listData = (await listRes.json()) as {
		items?: Array<{
			snippet: {
				title: string;
				description: string;
				tags?: string[];
				categoryId: string;
			};
			status: {
				privacyStatus: string;
				selfDeclaredMadeForKids?: boolean;
			};
		}>;
	};

	const video = listData.items?.[0];
	if (!video) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: `YouTube video ${videoId} not found.`,
				},
			},
			404,
		);
	}

	// Merge updates
	const updatedFields: string[] = [];
	const snippet = { ...video.snippet };
	const status = { ...video.status };

	if (body.title !== undefined) {
		snippet.title = body.title;
		updatedFields.push("title");
	}
	if (body.description !== undefined) {
		snippet.description = body.description;
		updatedFields.push("description");
	}
	if (body.tags !== undefined) {
		snippet.tags = body.tags;
		updatedFields.push("tags");
	}
	if (body.category_id !== undefined) {
		snippet.categoryId = body.category_id;
		updatedFields.push("category_id");
	}
	if (body.visibility !== undefined) {
		status.privacyStatus = body.visibility;
		updatedFields.push("visibility");
	}
	if (body.made_for_kids !== undefined) {
		status.selfDeclaredMadeForKids = body.made_for_kids;
		updatedFields.push("made_for_kids");
	}

	if (updatedFields.length === 0 && !body.playlist_id) {
		return c.json(
			{
				error: {
					code: "BAD_REQUEST",
					message: "No fields to update. Provide at least one of: title, description, tags, visibility, category_id, made_for_kids, playlist_id.",
				},
			},
			400,
		);
	}

	// Call YouTube Data API v3 videos.update (only if metadata fields changed)
	if (updatedFields.length > 0) {
		const updateRes = await fetch(
			"https://www.googleapis.com/youtube/v3/videos?part=snippet,status",
			{
				method: "PUT",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					id: videoId,
					snippet,
					status,
				}),
			},
		);

		if (!updateRes.ok) {
			const errText = await updateRes.text().catch(() => "Unknown error");
			return c.json(
				{
					error: {
						code: "YOUTUBE_API_ERROR",
						message: `YouTube update failed (${updateRes.status}): ${errText}`,
					},
				},
				400,
			);
		}
	}

	// Add to playlist if requested
	if (body.playlist_id) {
		try {
			await addToPlaylist({ access_token: token! }, body.playlist_id, videoId);
			updatedFields.push("playlist_id");
		} catch (err) {
			console.warn(`Failed to add video ${videoId} to playlist ${body.playlist_id}:`, err);
		}
	}

	return c.json(
		{
			success: true,
			platform: "youtube",
			video_id: videoId,
			updated_fields: updatedFields,
		},
		200,
	);
});

// ---------------------------------------------------------------------------
// Bulk CSV upload
// ---------------------------------------------------------------------------

const bulkCsvUpload = createRoute({
	operationId: "bulkCsvUpload",
	method: "post",
	path: "/bulk-csv",
	tags: ["Posts"],
	summary: "Bulk create posts from CSV",
	description:
		"Upload a CSV file to create multiple posts. Use dry_run=true to validate without creating. " +
		"CSV columns: content, targets (semicolon-separated), scheduled_at, media_urls (semicolon-separated), timezone, target_options (JSON string). " +
		"Max 500 rows, max 1 MB file size.",
	security: [{ Bearer: [] }],
	request: {
		query: z.object({
			dry_run: z
				.string()
				.optional()
				.describe('Set to "true" to validate without creating posts'),
		}),
	},
	responses: {
		200: {
			description: "CSV processed (dry_run)",
			content: { "application/json": { schema: BulkCsvResponse } },
		},
		201: {
			description: "Posts created",
			content: { "application/json": { schema: BulkCsvResponse } },
		},
		400: {
			description: "Bad request",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(bulkCsvUpload, async (c) => {
	const orgId = c.get("orgId");
	const dryRun = c.req.query("dry_run") === "true";

	// --- Parse multipart form ---
	let formData: FormData;
	try {
		formData = await c.req.formData();
	} catch {
		return c.json(
			{
				error: {
					code: "BAD_REQUEST",
					message:
						"Request must be multipart/form-data with a 'file' field.",
				},
			},
			400,
		);
	}

	const file = formData.get("file");
	if (!file || !(file instanceof File)) {
		return c.json(
			{
				error: {
					code: "BAD_REQUEST",
					message:
						"Missing 'file' field. Upload a CSV file as multipart/form-data.",
				},
			},
			400,
		);
	}

	// --- Validate file ---
	const MAX_FILE_SIZE = 1_048_576; // 1 MB
	if (file.size > MAX_FILE_SIZE) {
		return c.json(
			{
				error: {
					code: "BAD_REQUEST",
					message: `File too large (${Math.round(file.size / 1024)} KB). Maximum is 1 MB.`,
				},
			},
			400,
		);
	}

	const csvText = await file.text();
	if (!csvText.trim()) {
		return c.json(
			{
				error: { code: "BAD_REQUEST", message: "CSV file is empty." },
			},
			400,
		);
	}

	// --- Parse CSV ---
	const rows = parseCsv(csvText);

	if (rows.length === 0) {
		return c.json(
			{
				error: {
					code: "BAD_REQUEST",
					message: "CSV file contains no data rows.",
				},
			},
			400,
		);
	}

	const MAX_ROWS = 500;
	if (rows.length > MAX_ROWS) {
		return c.json(
			{
				error: {
					code: "BAD_REQUEST",
					message: `CSV has ${rows.length} rows. Maximum is ${MAX_ROWS}.`,
				},
			},
			400,
		);
	}

	// --- Validate required columns ---
	const firstRow = rows[0]!;
	if (!("targets" in firstRow) || !("scheduled_at" in firstRow)) {
		return c.json(
			{
				error: {
					code: "BAD_REQUEST",
					message:
						"CSV must have 'targets' and 'scheduled_at' columns.",
				},
			},
			400,
		);
	}

	const db = createDb(c.env.HYPERDRIVE.connectionString);

	// Pre-fetch org accounts once, filtered by workspace scope
	const wsScope = c.get("workspaceScope");
	const csvPrefetchConditions = [eq(socialAccounts.organizationId, orgId)];
	if (wsScope !== "all") {
		csvPrefetchConditions.push(inArray(socialAccounts.workspaceId, wsScope));
	}
	const orgAccounts = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			workspaceId: socialAccounts.workspaceId,
		})
		.from(socialAccounts)
		.where(and(...csvPrefetchConditions));

	const results: Array<{
		row: number;
		status: "success" | "error" | "skipped";
		post_id?: string;
		error?: { code: string; message: string };
	}> = [];
	let succeeded = 0;
	let failed = 0;
	let skipped = 0;
	let postsCreated = 0;
	const csvAutoScheduledTimes: Date[] = [];

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]!;
		const rowNum = i + 1; // 1-based for user display

		try {
			// Parse targets (semicolon-separated)
			const rawTargets = row.targets ?? "";
			if (!rawTargets) {
				results.push({
					row: rowNum,
					status: "error",
					error: {
						code: "VALIDATION_ERROR",
						message: "Missing 'targets' value.",
					},
				});
				failed++;
				continue;
			}
			const targets = rawTargets
				.split(";")
				.map((t) => t.trim())
				.filter(Boolean);

			// Parse scheduled_at
			const scheduledAt = (row.scheduled_at ?? "").trim();
			if (!scheduledAt) {
				results.push({
					row: rowNum,
					status: "error",
					error: {
						code: "VALIDATION_ERROR",
						message: "Missing 'scheduled_at' value.",
					},
				});
				failed++;
				continue;
			}

			// Parse media_urls (semicolon-separated)
			const rawMedia = (row.media_urls ?? "").trim();
			const media = rawMedia
				? rawMedia
						.split(";")
						.map((u) => u.trim())
						.filter(Boolean)
						.map((url) => ({ url }))
				: undefined;

			// Parse target_options (JSON string)
			let targetOptions: Record<string, Record<string, unknown>> | undefined;
			const rawTargetOptions = (row.target_options ?? "").trim();
			if (rawTargetOptions) {
				try {
					targetOptions = JSON.parse(rawTargetOptions);
				} catch {
					results.push({
						row: rowNum,
						status: "error",
						error: {
							code: "VALIDATION_ERROR",
							message:
								"Invalid JSON in 'target_options' column.",
						},
					});
					failed++;
					continue;
				}
			}

			const timezone = (row.timezone ?? "").trim() || "UTC";
			const content = (row.content ?? "").trim() || undefined;

			// Validate against schema
			const parsed = CreatePostBody.safeParse({
				content,
				targets,
				scheduled_at: scheduledAt,
				media,
				target_options: targetOptions,
				timezone,
			});

			if (!parsed.success) {
				const firstError = parsed.error.issues[0];
				results.push({
					row: rowNum,
					status: "error",
					error: {
						code: "VALIDATION_ERROR",
						message: firstError
							? `${firstError.path.join(".")}: ${firstError.message}`
							: "Validation failed.",
					},
				});
				failed++;
				continue;
			}

			const item = parsed.data;

			// Resolve targets
			const { resolved, failed: failedTargets } = await resolveTargets(
				db,
				orgId,
				item.targets,
				wsScope,
				orgAccounts,
			);

			if (resolved.length === 0) {
				const errMsg =
					failedTargets.length > 0
						? failedTargets
								.map((f) => `${f.key}: ${f.error.message}`)
								.join("; ")
						: "No valid targets resolved.";
				results.push({
					row: rowNum,
					status: "error",
					error: {
						code: "INVALID_TARGETS",
						message: errMsg,
					},
				});
				failed++;
				continue;
			}

			// --- Dry run: validation passed, skip DB insert ---
			if (dryRun) {
				results.push({ row: rowNum, status: "skipped" });
				skipped++;
				continue;
			}

			// --- Create post ---
			const isDraft = item.scheduled_at === "draft";
			const isNow = item.scheduled_at === "now";
			const isAutoCSV = item.scheduled_at === "auto";
			let parsedScheduledAt: Date | null;
			if (isDraft) {
				parsedScheduledAt = null;
			} else if (isNow) {
				parsedScheduledAt = new Date();
			} else if (isAutoCSV) {
				const { findBestSlot } = await import("../services/slot-finder");
				const slot = await findBestSlot(c.env, orgId, {
					accountId: resolved[0]?.accounts[0]?.id,
					after: new Date(),
					strategy: "smart",
					excludeTimes: csvAutoScheduledTimes,
				});
				if (!slot) {
					results.push({ row: rowNum, status: "error", error: { code: "NO_SLOT_AVAILABLE", message: "No available slot for auto-scheduling." } });
					failed++;
					continue;
				}
				parsedScheduledAt = new Date(slot.slot_at);
				csvAutoScheduledTimes.push(parsedScheduledAt);
			} else {
				parsedScheduledAt = new Date(item.scheduled_at);
			}

			const postStatus: "draft" | "scheduled" | "publishing" = isDraft
				? "draft"
				: isNow
					? "publishing"
					: "scheduled";

			const platformOverrides: Record<string, unknown> = {
				...(item.target_options ?? {}),
				...(item.media && item.media.length > 0
					? { _media: item.media }
					: {}),
			};

			const insertedRows = await db
				.insert(posts)
				.values({
					organizationId: orgId,
					workspaceId: null,
					content: item.content ?? null,
					status: postStatus,
					scheduledAt: parsedScheduledAt,
					timezone: item.timezone,
					platformOverrides:
						Object.keys(platformOverrides).length > 0
							? platformOverrides
							: null,
				})
				.returning();

			const post = insertedRows[0];
			if (!post) {
				results.push({
					row: rowNum,
					status: "error",
					error: {
						code: "DB_ERROR",
						message: "Failed to insert post.",
					},
				});
				failed++;
				continue;
			}

			// Create targets
			const targetValues = resolved.flatMap((target) =>
				target.accounts.map((account) => ({
					postId: post.id,
					socialAccountId: account.id,
					platform: target.platform,
					status: (isDraft
						? "draft"
						: isNow
							? "publishing"
							: "scheduled") as "draft" | "publishing" | "scheduled",
				})),
			);
			if (targetValues.length > 0) {
				await db.insert(postTargets).values(targetValues);
			}

			// Publish immediately if requested
			if (isNow && resolved.length > 0) {
				const publishTargets: PublishTargetInput[] = resolved.map(
					(t) => ({
						key: t.key,
						platform: t.platform,
						accounts: t.accounts.map((a) => ({
							id: a.id,
							username: a.username,
						})),
					}),
				);

				await publishToTargets(
					c.env,
					post.id,
					orgId,
					item.content ?? null,
					(item.media ?? []) as PublishRequest["media"],
					(item.target_options as Record<
						string,
						Record<string, unknown>
					>) ?? null,
					publishTargets,
				);
			}

			postsCreated++;
			succeeded++;
			results.push({
				row: rowNum,
				status: "success",
				post_id: post.id,
			});
		} catch (err) {
			results.push({
				row: rowNum,
				status: "error",
				error: {
					code: "UNEXPECTED_ERROR",
					message:
						err instanceof Error ? err.message : "Unknown error",
				},
			});
			failed++;
		}
	}

	const statusCode = dryRun ? 200 : 201;
	return c.json(
		{
			data: results,
			summary: {
				total_rows: rows.length,
				succeeded,
				failed,
				skipped,
				posts_created: postsCreated,
			},
		},
		statusCode,
	);
});

// --- Recycling sub-route handlers ---

app.openapi(getRecyclingConfig, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [post] = await db
		.select({ id: posts.id })
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	const [config] = await db
		.select()
		.from(postRecyclingConfigs)
		.where(eq(postRecyclingConfigs.sourcePostId, id))
		.limit(1);

	if (!config) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "No recycling configuration found for this post",
				},
			},
			404,
		);
	}

	return c.json(formatRecyclingConfig(config), 200);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(putRecyclingConfig, async (c) => {
	const orgId = c.get("orgId");
	const plan = c.get("plan") as string;
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	if (plan === "free") {
		return c.json(
			{
				error: {
					code: "PLAN_UPGRADE_REQUIRED",
					message:
						"Post recycling requires a Pro plan. Upgrade to access this feature.",
				},
			},
			403,
		);
	}

	const [post] = await db
		.select({ id: posts.id, status: posts.status })
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	// Check for existing config (for update vs create)
	const [existingConfig] = await db
		.select({ id: postRecyclingConfigs.id })
		.from(postRecyclingConfigs)
		.where(eq(postRecyclingConfigs.sourcePostId, id))
		.limit(1);

	const validation = await validateRecyclingConfig(
		db,
		orgId,
		id,
		post.status,
		body,
		existingConfig?.id,
	);

	if (!validation.valid) {
		return c.json({ error: validation.error }, 400);
	}

	const nextRecycle = computeNextRecycleAt(
		new Date(body.start_date),
		body.gap,
		body.gap_freq,
	);

	let config: typeof postRecyclingConfigs.$inferSelect | undefined;

	if (existingConfig) {
		const [updated] = await db
			.update(postRecyclingConfigs)
			.set({
				enabled: body.enabled,
				gap: body.gap,
				gapFreq: body.gap_freq,
				startDate: new Date(body.start_date),
				expireCount: body.expire_count ?? null,
				expireDate: body.expire_date
					? new Date(body.expire_date)
					: null,
				contentVariations: body.content_variations ?? [],
				nextRecycleAt: nextRecycle,
				updatedAt: new Date(),
			})
			.where(eq(postRecyclingConfigs.id, existingConfig.id))
			.returning();
		config = updated;
	} else {
		const [created] = await db
			.insert(postRecyclingConfigs)
			.values({
				organizationId: orgId,
				sourcePostId: id,
				enabled: body.enabled,
				gap: body.gap,
				gapFreq: body.gap_freq,
				startDate: new Date(body.start_date),
				expireCount: body.expire_count ?? null,
				expireDate: body.expire_date
					? new Date(body.expire_date)
					: null,
				contentVariations: body.content_variations ?? [],
				nextRecycleAt: nextRecycle,
			})
			.returning();
		config = created;
	}

	if (!config) {
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Failed to save recycling configuration",
				},
			},
			500,
		);
	}

	return c.json(
		{
			data: formatRecyclingConfig(config),
			...(validation.warnings
				? { warnings: validation.warnings }
				: {}),
		},
		200,
	);
});

app.openapi(deleteRecyclingConfig, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [post] = await db
		.select({ id: posts.id })
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	await db
		.delete(postRecyclingConfigs)
		.where(eq(postRecyclingConfigs.sourcePostId, id));

	return c.body(null, 204);
});

app.openapi(listRecycledCopies, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { limit } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [post] = await db
		.select({ id: posts.id })
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	const copies = await db
		.select()
		.from(posts)
		.where(
			and(
				eq(posts.recycledFromId, id),
				eq(posts.organizationId, orgId),
			),
		)
		.orderBy(desc(posts.createdAt))
		.limit(limit + 1);

	const hasMore = copies.length > limit;
	const data = copies.slice(0, limit);

	return c.json(
		{
			data: data.map((p) => ({
				id: p.id,
				status: p.status,
				content: p.content,
				scheduled_at: p.scheduledAt?.toISOString() ?? null,
				published_at: p.publishedAt?.toISOString() ?? null,
				targets: {},
				media: null,
				recycling: null,
				recycled_from_id: p.recycledFromId ?? null,
				created_at: p.createdAt.toISOString(),
				updated_at: p.updatedAt.toISOString(),
			})),
			next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

// --- Post Notes (works for both internal and external posts) ---

const getPostNotes = createRoute({
	operationId: "getPostNotes",
	method: "get",
	path: "/{id}/notes",
	tags: ["Posts"],
	summary: "Get notes for a post",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Notes for the post",
			content: { "application/json": { schema: z.object({ notes: z.string().nullable() }) } },
		},
		404: { description: "Post not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const updatePostNotes = createRoute({
	operationId: "updatePostNotes",
	method: "patch",
	path: "/{id}/notes",
	tags: ["Posts"],
	summary: "Update notes for a post",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: z.object({ notes: z.string() }) } },
		},
	},
	responses: {
		200: {
			description: "Updated notes",
			content: { "application/json": { schema: z.object({ notes: z.string().nullable() }) } },
		},
		404: { description: "Post not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

app.openapi(getPostNotes, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	// Try internal posts first
	const [post] = await db
		.select({ notes: posts.notes })
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (post) {
		return c.json({ notes: post.notes ?? null }, 200);
	}

	// Fall back to external posts
	const [ext] = await db
		.select({ notes: externalPosts.notes })
		.from(externalPosts)
		.where(and(eq(externalPosts.id, id), eq(externalPosts.organizationId, orgId)))
		.limit(1);

	if (ext) {
		return c.json({ notes: ext.notes ?? null }, 200);
	}

	return c.json({ error: { code: "NOT_FOUND", message: "Post not found" } }, 404);
});

app.openapi(updatePostNotes, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { notes } = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	// Try internal posts first
	const [post] = await db
		.select({ id: posts.id })
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (post) {
		await db.update(posts).set({ notes, updatedAt: new Date() }).where(eq(posts.id, id));
		return c.json({ notes }, 200);
	}

	// Fall back to external posts
	const [ext] = await db
		.select({ id: externalPosts.id })
		.from(externalPosts)
		.where(and(eq(externalPosts.id, id), eq(externalPosts.organizationId, orgId)))
		.limit(1);

	if (ext) {
		await db.update(externalPosts).set({ notes, updatedAt: new Date() }).where(eq(externalPosts.id, id));
		return c.json({ notes }, 200);
	}

	return c.json({ error: { code: "NOT_FOUND", message: "Post not found" } }, 404);
});

export default app;
