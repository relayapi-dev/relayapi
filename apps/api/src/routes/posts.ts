import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	contentTemplates,
	type createDb,
	crossPostActions,
	type Database,
	externalPosts,
	generateId,
	ideaActivity,
	ideas,
	media as mediaTable,
	ORGANIZATION_SCOPE_KEY,
	postRecyclingConfigs,
	posts,
	postTags,
	postTargets,
	publishOutbox,
	shortLinkConfigs,
	shortLinks,
	signatures,
	socialAccounts,
	tags,
	threadExecutions,
} from "@relayapi/db";
import { and, desc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { GRAPH_BASE } from "../config/api-versions";
import { decryptAccountToken } from "../lib/account-token-crypto";
import { parseCsv } from "../lib/csv-parser";
import { mediaPublicHost } from "../lib/deployment-mode";
import { parseDiscordWebhookUrl } from "../lib/discord-webhook";
import { fetchPublicUrl, readResponseJson } from "../lib/fetch-public-url";
import {
	getLinkedInRestHeaders,
	LINKEDIN_REST_BASE,
} from "../lib/linkedin-rest";
import {
	isDefinitiveProviderMutationRejection,
	SingleUnitProviderMutationAggregate,
	trackSingleUnitProviderMutation,
} from "../lib/mutation-provider-boundary";
import { notifyRealtime } from "../lib/notify-post-update";
import {
	decodeKeysetCursor,
	decodeTimestampIdCursor,
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
	type TimestampIdCursor,
} from "../lib/pagination-cursor";
import { readProviderJson, readProviderText } from "../lib/provider-response";
import { presignRelayMediaUrls, RELAY_MEDIA_HOST } from "../lib/r2-presign";
import {
	loadRelayMediaPolicy,
	type RelayMediaPolicy,
	type RelayMediaViolation,
} from "../lib/relay-media-policy";
import {
	inheritOperationalCreateScope,
	workspaceScopeKey,
} from "../lib/request-access";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
	workspaceScopeSqlCondition,
} from "../lib/workspace-scope";
import {
	markMutationInputNotApplied,
	multipartMutationInputPreflight,
} from "../middleware/mutation-validation";
import { deleteBlueskyPost } from "../publishers/bluesky";
import { resolveMastodonInstanceUrl } from "../publishers/mastodon";
import { addToPlaylist } from "../publishers/youtube";
import {
	ErrorResponse,
	FilterParams,
	IdParam,
	PaginationParams,
} from "../schemas/common";
import {
	BulkCsvResponse,
	CreatePostBody,
	PostListResponse,
	PostResponse,
	PostTagListQuery,
	PostTagListResponse,
	PostTagParams,
	PostTimelineResponse,
	RecyclingConfigResponse,
	RecyclingInput,
	UpdateMetadataBody,
	UpdateMetadataResponse,
	UpdatePostBody,
} from "../schemas/posts";
import { TagResponse } from "../schemas/tags";
import { chooseCrossPostSourceTarget } from "../services/cross-post-processor";
import {
	hasEffectivePostPayload,
	injectPostSignature,
	injectSignatureIntoTargetOptions,
	mergePostTargetOptions,
	renderPostTemplate,
	renderPostTemplateOverrides,
	resolveTemplateAccountName,
} from "../services/post-content-resolution";
import {
	lockProviderReconciliationScope,
	persistManualProviderReconciliation,
} from "../services/provider-reconciliation-persistence";
import {
	dispatchPublishOutbox,
	publishOutboxRow,
} from "../services/publish-outbox";
import {
	computeNextRecycleAt,
	validateRecyclingConfig,
} from "../services/recycling-validator";
import { resolveExternalShortLinkProvider } from "../services/short-link-configuration";
import {
	createTrackedExternalShortLink,
	type ExternalShortLinkProviderType,
} from "../services/short-link-lifecycle";
import { createRelayApiProvider } from "../services/short-link-providers";
import { shortenUrlsInContent } from "../services/short-link-service";
import { resolveTargets } from "../services/target-resolver";
import { refreshTokenIfNeeded } from "../services/token-refresh-coordinator";
import {
	enqueuePersistedWebhookEvent,
	type PersistedWebhookEvent,
	persistWebhookEventInTransaction,
} from "../services/webhook-delivery";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const PRESIGN_GET_EXPIRES = 3600;

type MediaItem = {
	url: string;
	type?: "image" | "video" | "gif" | "document" | "audio";
	thumbnail?: string;
};
type PostResponseBody = z.infer<typeof PostResponse>;
type PostTargetAccount = NonNullable<
	PostResponseBody["targets"][string]["accounts"]
>[number];

function serializePostTag(
	row: typeof tags.$inferSelect,
): z.infer<typeof TagResponse> {
	return {
		id: row.id,
		name: row.name,
		color: row.color,
		workspace_id: row.workspaceId,
		created_at: row.createdAt.toISOString(),
	};
}

function responseMediaType(value: string | null): MediaItem["type"] {
	return value === "image" ||
		value === "video" ||
		value === "gif" ||
		value === "document" ||
		value === "audio"
		? value
		: undefined;
}

async function presignMediaUrls(
	db: Database,
	env: Env,
	mediaArr: MediaItem[] | null,
	orgId: string,
	preloadedPolicy?: RelayMediaPolicy,
): Promise<MediaItem[] | null> {
	return presignRelayMediaUrls(
		db,
		env,
		mediaArr,
		PRESIGN_GET_EXPIRES,
		orgId,
		preloadedPolicy,
	);
}

function mediaPolicyInput(value: {
	media?: unknown;
	target_options?: unknown;
}): unknown {
	return { media: value.media, target_options: value.target_options };
}

function mediaPolicyError(violation: RelayMediaViolation) {
	return {
		error: {
			code: "MEDIA_NOT_READY",
			message:
				violation.reason === "invalid_relay_url"
					? "Relay-hosted media must use its canonical HTTPS URL"
					: "Relay-hosted media must belong to this organization and be ready before it can be used",
			details: { url: violation.url },
		},
	};
}

function violationForPostInput(
	policy: RelayMediaPolicy,
	value: { media?: unknown; target_options?: unknown },
): RelayMediaViolation | null {
	return policy.violationFor(mediaPolicyInput(value));
}

/**
 * Derive the relayapi-media storage key from a canonical media URL
 * (https://media.relayapi.dev/<storageKey>), or null if it isn't one. This is
 * the join key from the denormalized post `_media` snapshot back to the media row.
 */
function relayStorageKeyFromUrl(url: string): string | null {
	try {
		const u = new URL(url);
		if (u.hostname !== RELAY_MEDIA_HOST) return null;
		return decodeURIComponent(u.pathname.slice(1));
	} catch {
		return null;
	}
}

/**
 * One query mapping every relay-hosted media URL across the given posts to its
 * durable thumbnail URL, so card/list previews can fall back to the tiny stored
 * thumbnail after the full-res original is lifecycle-deleted.
 */
async function buildThumbnailMap(
	db: Database,
	orgId: string,
	mediaArrays: Array<MediaItem[] | null | undefined>,
): Promise<Map<string, string>> {
	const keys = new Set<string>();
	for (const arr of mediaArrays) {
		if (!arr) continue;
		for (const item of arr) {
			const key = relayStorageKeyFromUrl(item.url);
			if (key) keys.add(key);
		}
	}
	if (keys.size === 0) return new Map();
	// Thumbnails are an optional enrichment: never let this lookup fail the whole
	// posts list. If it throws (e.g. the thumbnail columns aren't migrated yet on
	// this DB), serve posts without thumbnails instead of 500ing the calendar.
	let rows: Array<{ storageKey: string; thumbnailUrl: string | null }> = [];
	try {
		rows = await db
			.select({
				storageKey: mediaTable.storageKey,
				thumbnailUrl: mediaTable.thumbnailUrl,
			})
			.from(mediaTable)
			.where(
				and(
					eq(mediaTable.organizationId, orgId),
					inArray(mediaTable.storageKey, [...keys]),
				),
			);
	} catch (err) {
		console.error(
			"[posts] thumbnail lookup failed; serving without thumbnails:",
			err,
		);
		return new Map();
	}
	const map = new Map<string, string>();
	for (const r of rows) {
		if (r.thumbnailUrl) map.set(r.storageKey, r.thumbnailUrl);
	}
	return map;
}

/** Attach durable thumbnail URLs to relay-hosted media items (before presigning). */
function attachThumbnails(
	mediaArr: MediaItem[] | null,
	thumbMap: Map<string, string>,
): MediaItem[] | null {
	if (!mediaArr || thumbMap.size === 0) return mediaArr;
	return mediaArr.map((item) => {
		const key = relayStorageKeyFromUrl(item.url);
		const thumbnail = key ? thumbMap.get(key) : undefined;
		return thumbnail ? { ...item, thumbnail } : item;
	});
}

/** Durable thumbnail URLs for a post's own R2 media, in `_media` order. */
function durableThumbnailsFor(
	rawMedia: MediaItem[] | null,
	thumbMap: Map<string, string>,
): Array<string | undefined> {
	if (!rawMedia) return [];
	return rawMedia.map((item) => {
		const key = relayStorageKeyFromUrl(item.url);
		return key ? thumbMap.get(key) : undefined;
	});
}

/**
 * Serve platform CDN media as the full-res `url`, but prefer our own durable R2
 * thumbnail (permanent) over the platform's expiring CDN thumbnail. Keeps the
 * platform thumbnail only where we have no durable copy (posts published outside
 * RelayAPI). Index-matched to the post's `_media` order.
 */
function preferDurableThumbnails(
	extMedia: MediaItem[],
	rawMedia: MediaItem[] | null,
	thumbMap: Map<string, string>,
): MediaItem[] {
	const durable = durableThumbnailsFor(rawMedia, thumbMap);
	if (durable.length === 0) return extMedia;
	return extMedia.map((item, i) => {
		const dur = durable[i];
		return dur ? { ...item, thumbnail: dur } : item;
	});
}

// Matches an explicit UTC offset or "Z" at the end of an ISO datetime string.
const ISO_HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Resolve a scheduled-at wall-clock string to a UTC Date, honouring the post's IANA
 * timezone. `new Date("2026-06-15T10:00:00")` on Workers parses an offset-less string
 * as UTC, so "10:00 America/New_York" would publish 4-5h early. When the string carries
 * no explicit offset and a timezone is provided, interpret the wall-clock time AS LOCAL
 * to that timezone and convert to the correct UTC instant. Strings that already include
 * an offset (or "Z") are respected as-is. Uses Intl to compute the zone offset (DST-aware),
 * matching the approach in slot-finder.ts.
 */
function resolveScheduledAt(value: string, timezone?: string | null): Date {
	if (!timezone || ISO_HAS_OFFSET.test(value)) {
		return new Date(value);
	}
	// Parse the wall-clock components by treating the input as if it were UTC, then
	// shift by the target zone's offset at that instant.
	const asUtc = new Date(`${value}Z`);
	if (Number.isNaN(asUtc.getTime())) {
		// Fall back to native parsing so callers still get an (Invalid) Date rather than
		// throwing here; upstream validation handles malformed input.
		return new Date(value);
	}
	const offsetMinutes = tzOffsetMinutes(asUtc, timezone);
	return new Date(asUtc.getTime() - offsetMinutes * 60_000);
}

/** UTC offset (minutes east of UTC) for an IANA timezone at a given instant. */
function tzOffsetMinutes(at: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(at);
	const get = (type: string) =>
		Number(parts.find((p) => p.type === type)?.value ?? "0");
	const asLocalUtc = Date.UTC(
		get("year"),
		get("month") - 1,
		get("day"),
		get("hour"),
		get("minute"),
		get("second"),
	);
	let offset = Math.round((asLocalUtc - at.getTime()) / 60_000);
	// Normalize across the day boundary.
	if (offset > 720) offset -= 1440;
	if (offset < -720) offset += 1440;
	return offset;
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
			content: { "application/json": { schema: PostTimelineResponse } },
		},
		400: {
			description: "Invalid pagination cursor",
			content: { "application/json": { schema: ErrorResponse } },
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
		400: {
			description: "Invalid pagination cursor",
			content: { "application/json": { schema: ErrorResponse } },
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
			description: "Workspace access denied or quota exceeded",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "No slot available",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Referenced content template or idea not found",
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

const ReconcilePublishTargetParams = z.object({
	id: z.string(),
	target_id: z.string(),
});

const ReconcilePublishTargetBody = z.discriminatedUnion("outcome", [
	z.object({
		outcome: z.literal("succeeded"),
		publish_operation_id: z.string().min(1).max(256),
		provider_post_id: z.string().min(1).max(2048),
		provider_url: z.string().url().max(8192).optional(),
	}),
	z.object({
		outcome: z.literal("failed"),
		publish_operation_id: z.string().min(1).max(256),
		error_code: z.string().min(1).max(128),
		error_message: z.string().min(1).max(2048),
	}),
]);

const ReconcilePublishTargetResponse = z.object({
	post_id: z.string(),
	target_id: z.string(),
	publish_operation_id: z.string(),
	outcome: z.enum(["succeeded", "failed"]),
	post_status: z.enum(["publishing", "published", "failed", "partial"]),
	thread_status: z
		.enum(["queued", "completed", "failed", "unknown"])
		.nullable(),
});

const reconcilePublishTarget = createRoute({
	operationId: "reconcilePostTarget",
	method: "post",
	path: "/{id}/targets/{target_id}/reconcile",
	tags: ["Posts"],
	summary: "Resolve an unknown provider publish outcome",
	description:
		"Manually reconcile a target using its stable publish_operation_id. Unknown outcomes are never replayed automatically.",
	security: [{ Bearer: [] }],
	request: {
		params: ReconcilePublishTargetParams,
		body: {
			content: {
				"application/json": { schema: ReconcilePublishTargetBody },
			},
		},
	},
	responses: {
		200: {
			description: "Unknown outcome reconciled",
			content: {
				"application/json": { schema: ReconcilePublishTargetResponse },
			},
		},
		404: {
			description: "Post not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Target is not unknown or the operation fence changed",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
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
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Workspace not found",
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
						platforms: z
							.array(z.string())
							.optional()
							.describe(
								"Platforms to unpublish from. If omitted, unpublishes from all.",
							),
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
		id?: string | null;
		socialAccountId: string;
		platform: string;
		status: string;
		platformUrl: string | null;
		platformPostId?: string | null;
		error: string | null;
		errorCode?: string | null;
		errorDetail?: string | null;
		publishOperationId: string;
		deliveryState: string;
		username?: string | null;
		displayName?: string | null;
		avatarUrl?: string | null;
	}>,
): PostResponseBody["targets"] {
	const result: PostResponseBody["targets"] = {};
	for (const t of targets) {
		result[t.socialAccountId] = {
			status: t.status as PostResponseBody["targets"][string]["status"],
			platform: t.platform as NonNullable<
				PostResponseBody["targets"][string]["platform"]
			>,
			accounts: [
				{
					id: t.socialAccountId,
					username: t.username ?? null,
					display_name: t.displayName ?? null,
					avatar_url: t.avatarUrl ?? null,
					url: t.platformUrl,
					platform_post_id: t.platformPostId ?? null,
					target_id: t.id ?? null,
					publish_operation_id: t.publishOperationId,
					delivery_state:
						t.deliveryState as PostTargetAccount["delivery_state"],
				},
			],
			...(t.error
				? {
						error: {
							code: t.errorCode ?? "PUBLISH_FAILED",
							message: t.error,
							...(t.errorDetail ? { detail: t.errorDetail } : {}),
						},
					}
				: {}),
		};
	}
	return result;
}

// --- Route handlers ---

app.openapi(listPosts, async (c) => {
	const orgId = c.get("orgId");
	const {
		cursor,
		limit,
		workspace_id,
		account_id,
		account_ids,
		status,
		from,
		to,
		include,
		include_external,
	} = c.req.valid("query");
	const db = c.get("db");
	let decodedCursor: TimestampIdCursor | null = null;
	if (cursor) {
		try {
			decodedCursor = decodeTimestampIdCursor(cursor);
		} catch {
			return c.json(INVALID_CURSOR_BODY, 400);
		}
	}

	const accountIdList = account_ids
		? account_ids
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: [];

	const includeSet = new Set(
		(include ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	const includeTargets = includeSet.has("targets");
	const includeMedia = includeSet.has("media");

	// Kick off the external-posts fetch concurrently with the internal query — it
	// depends only on request params, so awaiting it after the internal round trips
	// adds an avoidable serial DB RTT to every include_external=true request.
	const externalPromise =
		include_external === "true" && (!status || status === "published")
			? fetchExternalPostItems(db, orgId, c, {
					workspace_id,
					account_id,
					account_ids: accountIdList,
					from,
					to,
					limit,
					cursor: decodedCursor,
				})
			: null;

	const conditions = [eq(posts.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, posts.workspaceId);

	if (decodedCursor) {
		conditions.push(
			sql`(coalesce(${posts.publishedAt}, ${posts.createdAt}), ${posts.id}) < (${decodedCursor.timestamp}::timestamptz, ${decodedCursor.id})`,
		);
	}

	if (status) {
		conditions.push(eq(posts.status, status));
	}

	if (from) {
		const fromDate = new Date(from);
		const fromCondition = or(
			gte(posts.scheduledAt, fromDate),
			gte(posts.publishedAt, fromDate),
		);
		if (fromCondition) {
			conditions.push(fromCondition);
		}
	}
	if (to) {
		const toDate = new Date(to);
		const toCondition = or(
			lte(posts.scheduledAt, toDate),
			lte(posts.publishedAt, toDate),
		);
		if (toCondition) {
			conditions.push(toCondition);
		}
	}

	if (accountIdList.length > 0) {
		conditions.push(
			sql`${posts.id} IN (SELECT ${postTargets.postId} FROM ${postTargets} WHERE ${inArray(postTargets.socialAccountId, accountIdList)})`,
		);
	} else if (account_id) {
		conditions.push(
			sql`${posts.id} IN (SELECT ${postTargets.postId} FROM ${postTargets} WHERE ${postTargets.socialAccountId} = ${account_id})`,
		);
	} else if (workspace_id) {
		const workspaceCondition = or(
			eq(posts.workspaceId, workspace_id),
			sql`${posts.id} IN (SELECT ${postTargets.postId} FROM ${postTargets} JOIN ${socialAccounts} ON ${postTargets.socialAccountId} = ${socialAccounts.id} WHERE ${socialAccounts.workspaceId} = ${workspace_id})`,
		);
		if (workspaceCondition) {
			conditions.push(workspaceCondition);
		}
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
			cursorTimestamp: sql<string>`to_char(coalesce(${posts.publishedAt}, ${posts.createdAt}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(posts)
		.where(and(...conditions))
		.orderBy(
			desc(sql`coalesce(${posts.publishedAt}, ${posts.createdAt})`),
			desc(posts.id),
		)
		.limit(limit + 1);

	const hasMore = allPosts.length > limit;
	const data = allPosts.slice(0, limit);
	const pageRelayMediaPolicy = includeMedia
		? await loadRelayMediaPolicy(
				db,
				orgId,
				data.map((post) => {
					const overrides = post.platformOverrides as Record<
						string,
						unknown
					> | null;
					return overrides?._media ?? null;
				}),
				mediaPublicHost(c.env),
				c.get("workspaceScope"),
			)
		: undefined;

	const postIds = data.map((p) => p.id);

	// When include=targets, fetch full target data with account info
	if (includeTargets && postIds.length > 0) {
		const fullTargets = await db
			.select({
				id: postTargets.id,
				postId: postTargets.postId,
				socialAccountId: postTargets.socialAccountId,
				platform: postTargets.platform,
				status: postTargets.status,
				platformUrl: postTargets.platformUrl,
				platformPostId: postTargets.platformPostId,
				error: postTargets.error,
				errorCode: postTargets.errorCode,
				errorDetail: postTargets.errorDetail,
				publishOperationId: postTargets.publishOperationId,
				deliveryState: postTargets.deliveryState,
				publishedAt: postTargets.publishedAt,
				username: socialAccounts.username,
				displayName: socialAccounts.displayName,
				avatarUrl: socialAccounts.avatarUrl,
			})
			.from(postTargets)
			.leftJoin(
				socialAccounts,
				eq(postTargets.socialAccountId, socialAccounts.id),
			)
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
		const extMediaByPlatformPostId = new Map<string, MediaItem[]>();
		if (includeMedia && allPlatformPostIds.length > 0) {
			const extRows = await db
				.select({
					platformPostId: externalPosts.platformPostId,
					mediaUrls: externalPosts.mediaUrls,
					mediaType: externalPosts.mediaType,
					thumbnailUrl: externalPosts.thumbnailUrl,
					previewThumbnailUrl: externalPosts.previewThumbnailUrl,
				})
				.from(externalPosts)
				.where(
					and(
						inArray(externalPosts.platformPostId, allPlatformPostIds),
						eq(externalPosts.organizationId, orgId),
					),
				);
			for (const row of extRows) {
				const items: MediaItem[] = [];
				const urls = row.mediaUrls as string[] | null;
				const previewUrl =
					row.previewThumbnailUrl ?? row.thumbnailUrl ?? undefined;
				if (urls && urls.length > 0) {
					for (const url of urls) {
						items.push({
							url,
							type: responseMediaType(row.mediaType),
							thumbnail: previewUrl,
						});
					}
				} else if (previewUrl) {
					// Fallback to thumbnail only when no full media URLs exist (e.g. video poster)
					items.push({
						url: previewUrl,
						type: responseMediaType(row.mediaType),
						thumbnail: previewUrl,
					});
				}
				if (items.length > 0) {
					extMediaByPlatformPostId.set(row.platformPostId, items);
				}
			}
		}

		// One query maps every relay-hosted media URL on this page to its durable
		// thumbnail, so previews survive after the full-res original is purged.
		const thumbMap = includeMedia
			? await buildThumbnailMap(
					db,
					orgId,
					data.map((p) => {
						const ov = p.platformOverrides as Record<string, unknown> | null;
						return (ov?._media as MediaItem[] | undefined) ?? null;
					}),
				)
			: new Map<string, string>();

		const internalItems = await Promise.all(
			data.map(async (p) => {
				const pTargets = targetsByPost.get(p.id) ?? [];
				const overrides = p.platformOverrides as Record<string, unknown> | null;
				const rawMedia =
					includeMedia && overrides?._media
						? (overrides._media as MediaItem[])
						: null;

				// Prefer platform CDN media for published posts (full-res), but keep our
				// durable R2 thumbnail as the preview so it survives platform-URL expiry.
				let mediaArr: MediaItem[] | null = null;
				if (includeMedia && p.status === "published") {
					for (const t of pTargets) {
						if (t.status === "published" && t.platformPostId) {
							const extMedia = extMediaByPlatformPostId.get(t.platformPostId);
							if (extMedia) {
								mediaArr = preferDurableThumbnails(
									extMedia,
									rawMedia,
									thumbMap,
								);
								break;
							}
						}
					}
				}
				// Fall back to presigned R2 URLs, attaching durable thumbnails first.
				if (!mediaArr) {
					mediaArr = includeMedia
						? await presignMediaUrls(
								db,
								c.env,
								attachThumbnails(rawMedia, thumbMap),
								orgId,
								pageRelayMediaPolicy,
							)
						: rawMedia;
				}

				return {
					id: p.id,
					source: "internal" as const,
					status: p.status,
					content: p.content,
					notes: p.notes ?? null,
					platforms: platformsByPost.get(p.id) ?? [],
					scheduled_at: p.scheduledAt?.toISOString() ?? null,
					published_at: p.publishedAt ? p.cursorTimestamp : null,
					targets: buildTargetResponse(pTargets),
					media: mediaArr,
					metrics: (p.metricsSnapshot as Record<string, number>) ?? {},
					recycling: null,
					recycled_from_id: p.recycledFromId ?? null,
					created_at: p.publishedAt
						? p.createdAt.toISOString()
						: p.cursorTimestamp,
					updated_at: p.updatedAt.toISOString(),
				};
			}),
		);

		// Merge external posts if requested
		if (externalPromise) {
			const ext = await externalPromise;
			const moreExternal = ext.length > limit;
			const extPage = ext.slice(0, limit);
			const merged = mergeByPublishedAt(internalItems, extPage, limit);
			const last = merged.at(-1);
			const more =
				hasMore ||
				moreExternal ||
				internalItems.length + extPage.length > merged.length;
			return c.json(
				{
					data: merged as z.infer<typeof PostTimelineResponse>["data"],
					next_cursor:
						more && last
							? encodeTimestampIdCursor(
									last.published_at ?? last.created_at ?? "",
									last.id,
								)
							: null,
					has_more: more,
				},
				200,
			);
		}

		const lastInternal = data.at(-1);
		return c.json(
			{
				data: internalItems as unknown as z.infer<
					typeof PostTimelineResponse
				>["data"],
				next_cursor: hasMore
					? lastInternal
						? encodeTimestampIdCursor(
								lastInternal.cursorTimestamp,
								lastInternal.id,
							)
						: null
					: null,
				has_more: hasMore,
			},
			200,
		);
	}

	// Default lean response (no include=targets; still handles include=media)
	const targets =
		postIds.length > 0
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

	const leanThumbMap = includeMedia
		? await buildThumbnailMap(
				db,
				orgId,
				data.map((p) => {
					const ov = p.platformOverrides as Record<string, unknown> | null;
					return (ov?._media as MediaItem[] | undefined) ?? null;
				}),
			)
		: new Map<string, string>();

	const leanItems = await Promise.all(
		data.map(async (p) => {
			let mediaArr: MediaItem[] | null = null;
			if (includeMedia) {
				const overrides = p.platformOverrides as Record<string, unknown> | null;
				const rawMedia = overrides?._media
					? (overrides._media as MediaItem[])
					: null;
				mediaArr = await presignMediaUrls(
					db,
					c.env,
					attachThumbnails(rawMedia, leanThumbMap),
					orgId,
					pageRelayMediaPolicy,
				);
			}
			return {
				id: p.id,
				source: "internal" as const,
				status: p.status,
				content: p.content,
				platforms: platformsByPost.get(p.id) ?? [],
				scheduled_at: p.scheduledAt?.toISOString() ?? null,
				published_at: p.publishedAt ? p.cursorTimestamp : null,
				targets: {},
				media: mediaArr,
				metrics: (p.metricsSnapshot as Record<string, number>) ?? {},
				recycling: null,
				recycled_from_id: p.recycledFromId ?? null,
				created_at: p.publishedAt
					? p.createdAt.toISOString()
					: p.cursorTimestamp,
				updated_at: p.updatedAt.toISOString(),
			};
		}),
	);

	// Merge external posts if requested
	if (externalPromise) {
		const ext = await externalPromise;
		const moreExternal = ext.length > limit;
		const extPage = ext.slice(0, limit);
		const merged = mergeByPublishedAt(leanItems, extPage, limit);
		const last = merged.at(-1);
		const more =
			hasMore ||
			moreExternal ||
			leanItems.length + extPage.length > merged.length;
		return c.json(
			{
				data: merged as z.infer<typeof PostTimelineResponse>["data"],
				next_cursor:
					more && last
						? encodeTimestampIdCursor(
								last.published_at ?? last.created_at ?? "",
								last.id,
							)
						: null,
				has_more: more,
			},
			200,
		);
	}

	const lastInternal = data.at(-1);
	return c.json(
		{
			data: leanItems as z.infer<typeof PostTimelineResponse>["data"],
			next_cursor: hasMore
				? lastInternal
					? encodeTimestampIdCursor(
							lastInternal.cursorTimestamp,
							lastInternal.id,
						)
					: null
				: null,
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
	c: AppContext,
	filters: {
		workspace_id?: string;
		account_id?: string;
		account_ids?: string[];
		from?: string;
		to?: string;
		limit: number;
		cursor?: TimestampIdCursor | null;
	},
) {
	const conditions = [eq(externalPosts.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, externalPosts.workspaceId);

	if (filters.account_ids && filters.account_ids.length > 0) {
		conditions.push(
			inArray(externalPosts.socialAccountId, filters.account_ids),
		);
	} else if (filters.account_id) {
		conditions.push(eq(externalPosts.socialAccountId, filters.account_id));
	} else if (filters.workspace_id) {
		// Honour the workspace_id filter for external posts (it was previously ignored,
		// so a filtered timeline leaked external posts from every workspace the key can
		// access). OR the account's workspace to cover external_posts rows whose own
		// workspaceId was nulled by ON DELETE SET NULL — mirrors the internal-posts query.
		const workspaceCondition = or(
			eq(externalPosts.workspaceId, filters.workspace_id),
			eq(socialAccounts.workspaceId, filters.workspace_id),
		);
		if (workspaceCondition) {
			conditions.push(workspaceCondition);
		}
	}
	if (filters.from) {
		conditions.push(gte(externalPosts.publishedAt, new Date(filters.from)));
	}
	if (filters.to) {
		conditions.push(lte(externalPosts.publishedAt, new Date(filters.to)));
	}
	if (filters.cursor) {
		conditions.push(
			sql`(${externalPosts.publishedAt}, ${externalPosts.id}) < (${filters.cursor.timestamp}::timestamptz, ${filters.cursor.id})`,
		);
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
			previewThumbnailUrl: externalPosts.previewThumbnailUrl,
			metrics: externalPosts.metrics,
			publishedAt: externalPosts.publishedAt,
			createdAt: externalPosts.createdAt,
			cursorTimestamp: sql<string>`to_char(${externalPosts.publishedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
			accountUsername: socialAccounts.username,
			accountDisplayName: socialAccounts.displayName,
			accountAvatarUrl: socialAccounts.avatarUrl,
		})
		.from(externalPosts)
		.leftJoin(
			socialAccounts,
			eq(externalPosts.socialAccountId, socialAccounts.id),
		)
		.where(and(...conditions))
		.orderBy(desc(externalPosts.publishedAt), desc(externalPosts.id))
		.limit(filters.limit + 1);

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
		thumbnail_url: ep.previewThumbnailUrl ?? ep.thumbnailUrl,
		account_name: ep.accountDisplayName || ep.accountUsername || null,
		account_avatar_url: ep.accountAvatarUrl || null,
		metrics: (ep.metrics as Record<string, number>) ?? {},
		published_at: ep.cursorTimestamp,
		created_at: ep.createdAt.toISOString(),
	}));
}

type MergeableItem = {
	id: string;
	published_at?: string | null;
	created_at?: string | null;
};

function timestampToEpochMicros(value: string | null | undefined): number {
	if (!value) return -Infinity;
	const epochMs = new Date(value).getTime();
	if (Number.isNaN(epochMs)) return -Infinity;
	const fractional = value.match(/\.(\d{1,6})/)?.[1] ?? "";
	const microsecondsAfterMillisecond = Number(
		fractional.padEnd(6, "0").slice(3, 6),
	);
	return epochMs * 1000 + microsecondsAfterMillisecond;
}

export function mergeByPublishedAt<
	TInternal extends MergeableItem,
	TExternal extends MergeableItem,
>(
	internal: TInternal[],
	external: TExternal[],
	limit: number,
): Array<TInternal | TExternal> {
	const merged: Array<TInternal | TExternal> = [];
	let i = 0;
	let e = 0;

	while (
		merged.length < limit &&
		(i < internal.length || e < external.length)
	) {
		const internalItem = internal[i];
		const externalItem = external[e];
		const iDate = internalItem
			? timestampToEpochMicros(
					internalItem.published_at ?? internalItem.created_at,
				)
			: -Infinity;
		const eDate = externalItem
			? timestampToEpochMicros(externalItem.published_at)
			: -Infinity;

		const internalFirst =
			iDate > eDate ||
			(iDate === eDate &&
				!!internalItem &&
				(!externalItem || internalItem.id > externalItem.id));

		if (internalFirst && internalItem) {
			merged.push(internalItem);
			i++;
		} else if (externalItem) {
			merged.push(externalItem);
			e++;
		} else if (internalItem) {
			merged.push(internalItem);
			i++;
		} else {
			break;
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
	const { limit, from, to, cursor } = c.req.valid("query");
	const db = c.get("db");

	// Single JOIN query with DB-level filtering and pagination
	const conditions = [eq(posts.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, posts.workspaceId);
	if (from) conditions.push(gte(postTargets.updatedAt, new Date(from)));
	if (to) conditions.push(lte(postTargets.updatedAt, new Date(to)));
	if (cursor) {
		const decoded = decodeKeysetCursor(cursor);
		if (decoded.kind === "invalid") return c.json(INVALID_CURSOR_BODY, 400);
		conditions.push(
			decoded.kind === "composite"
				? sql`(${postTargets.updatedAt}, ${postTargets.id}) < (${decoded.timestamp}::timestamptz, ${decoded.id})`
				: lt(postTargets.updatedAt, new Date(decoded.timestamp)),
		);
	}

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
			errorCode: postTargets.errorCode,
			errorDetail: postTargets.errorDetail,
			publishOperationId: postTargets.publishOperationId,
			deliveryState: postTargets.deliveryState,
			publishedAt: postTargets.publishedAt,
			updatedAt: postTargets.updatedAt,
			cursorTimestamp: sql<string>`to_char(${postTargets.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(postTargets)
		.innerJoin(posts, eq(postTargets.postId, posts.id))
		.where(and(...conditions))
		.orderBy(desc(postTargets.updatedAt), desc(postTargets.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	return c.json(
		{
			data: data.map(formatLogEntry),
			next_cursor: hasMore
				? (() => {
						const last = data.at(-1);
						return last
							? encodeTimestampIdCursor(last.cursorTimestamp, last.id)
							: null;
					})()
				: null,
			has_more: hasMore,
		},
		200,
	);
});

app.openapi(createPostRoute, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");
	const relayMediaPolicy = await loadRelayMediaPolicy(
		db,
		orgId,
		mediaPolicyInput(body),
		mediaPublicHost(c.env),
		c.get("workspaceScope"),
	);
	const mediaViolation = violationForPostInput(relayMediaPolicy, body);
	if (mediaViolation) {
		markMutationInputNotApplied(c);
		return c.json(mediaPolicyError(mediaViolation), 400 as never);
	}

	const isDraft = body.scheduled_at === "draft";
	const isAuto = body.scheduled_at === "auto";

	// Resolve targets
	const targetResolution = await resolveTargets(
		db,
		orgId,
		body.targets,
		c.get("workspaceScope"),
		undefined,
		body.workspace_id ?? null,
	);
	const scope = await inheritOperationalCreateScope(
		c,
		body.workspace_id,
		targetResolution.workspaceIds,
		"post",
	);
	if (!scope.ok) {
		markMutationInputNotApplied(c);
		return scope.response as never;
	}
	const workspaceId = scope.workspaceId;
	const { resolved, failed } = targetResolution;
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
			db,
			workspaceScope: c.get("workspaceScope"),
			workspaceId,
			accountId: resolved[0]?.accounts[0]?.id,
			after: new Date(),
			strategy: "smart",
		});
		if (!slot) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "NO_SLOT_AVAILABLE",
						message:
							"No available slot found. Configure queue slots or try a specific time.",
					},
				},
				409,
			);
		}
		scheduledAt = new Date(slot.slot_at);
	} else {
		scheduledAt = resolveScheduledAt(body.scheduled_at, body.timezone);
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
	const templateTargetOptions: Record<string, Record<string, unknown>> = {};

	if (body.template_id) {
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

		if (!tmpl) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "TEMPLATE_NOT_FOUND",
						message: "Content template not found in this organization.",
					},
				},
				404,
			);
		}
		const templateAccessDenied = assertWorkspaceScope(c, tmpl.workspaceId);
		if (templateAccessDenied) {
			markMutationInputNotApplied(c);
			return templateAccessDenied as never;
		}

		if (!finalContent) {
			const accountName = resolveTemplateAccountName(resolved);
			const renderedAt = new Date();
			const rendered = renderPostTemplate(
				tmpl.content,
				body.template_variables,
				accountName,
				renderedAt,
			);
			if (!rendered.ok) {
				markMutationInputNotApplied(c);
				return c.json(
					{
						error: {
							code: rendered.code,
							message:
								"{{account_name}} requires one unambiguous account name or an explicit template_variables.account_name value.",
							details: { variable: rendered.variable },
						},
					},
					400,
				);
			}
			finalContent = rendered.content;

			const renderedOverrides = renderPostTemplateOverrides(
				tmpl.platformOverrides,
				body.template_variables,
				accountName,
				renderedAt,
				new Set(resolved.map((target) => target.platform)),
			);
			if (!renderedOverrides.ok) {
				markMutationInputNotApplied(c);
				return c.json(
					{
						error: {
							code: renderedOverrides.code,
							message: `The ${renderedOverrides.platform} template override requires one unambiguous account name or an explicit template_variables.account_name value.`,
							details: {
								variable: renderedOverrides.variable,
								platform: renderedOverrides.platform,
							},
						},
					},
					400,
				);
			}
			for (const target of resolved) {
				const override = renderedOverrides.overrides[target.platform];
				// A blank override means "inherit the shared content", not "publish
				// nothing to this platform" — that is what omitting the target does.
				if (override?.trim()) {
					templateTargetOptions[target.platform] = { content: override };
				}
			}
		}
	}

	// --- Idea resolution ---
	let ideaSource: { id: string; content: string | null } | null = null;
	if (body.idea_id) {
		const [idea] = await db
			.select({ id: ideas.id, content: ideas.content })
			.from(ideas)
			.where(and(eq(ideas.id, body.idea_id), eq(ideas.organizationId, orgId)))
			.limit(1);
		if (!idea) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "IDEA_NOT_FOUND",
						message: "Idea not found in this organization.",
					},
				},
				404,
			);
		}
		ideaSource = idea;
		// Use idea content as fallback — explicit content takes precedence
		if (!finalContent) {
			finalContent = idea.content;
		}
	}

	let effectiveTargetOptions = mergePostTargetOptions(
		templateTargetOptions,
		body.target_options,
	);
	// A draft is explicitly a placeholder to fill in later, so it is exempt from
	// the payload requirement; everything that can publish is not.
	if (
		!isDraft &&
		!hasEffectivePostPayload(finalContent, body.media, effectiveTargetOptions)
	) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "CONTENT_REQUIRED",
					message:
						"Post creation requires non-empty content, media, or per-target content after resolving template and idea references.",
				},
			},
			400,
		);
	}

	// --- Signature injection ---
	if (!body.skip_signature) {
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
				if (finalContent?.trim()) {
					finalContent = injectPostSignature(finalContent, defaultSig);
				}
				effectiveTargetOptions = injectSignatureIntoTargetOptions(
					effectiveTargetOptions,
					defaultSig,
				);
			}
		} catch {
			// Signature injection failure should not block post creation
		}
	}

	// --- URL shortening (Pro plan only) ---
	let shortenedUrls: Array<{
		original: string;
		short: string;
		provider: string;
		shortLinkId?: string;
	}> = [];

	if (finalContent && !isDraft && c.get("plan") === "pro") {
		try {
			const [slConfig] = await db
				.select()
				.from(shortLinkConfigs)
				.where(eq(shortLinkConfigs.organizationId, orgId))
				.limit(1);

			let shouldShorten = false;
			if (slConfig?.mode === "always") shouldShorten = true;
			if (slConfig?.mode === "ask" && body.shorten_urls === true)
				shouldShorten = true;

			if (shouldShorten && slConfig?.provider) {
				if (slConfig.provider === "relayapi") {
					const baseUrl =
						c.env.PUBLIC_LINK_BASE_URL ||
						c.env.API_BASE_URL ||
						"https://api.relayapi.dev";
					const provider = createRelayApiProvider({
						db,
						kv: c.env.KV,
						baseUrl,
						organizationId: orgId,
						workspaceId,
						providerConfigVersion: slConfig.providerConfigVersion,
					});
					const result = await shortenUrlsInContent(
						provider.shortLinkDomain,
						slConfig.domain,
						finalContent,
						async (url) => {
							const created = await provider.shorten(
								"builtin",
								slConfig.domain,
								url,
								crypto.randomUUID(),
							);
							return { shortUrl: created.shortUrl };
						},
					);
					finalContent = result.content;
					shortenedUrls = result.shortenedUrls.map((url) => ({
						...url,
						provider: "relayapi",
					}));
				} else if (slConfig.credentialVersion) {
					const resolvedProvider = await resolveExternalShortLinkProvider({
						db,
						organizationId: orgId,
						provider: slConfig.provider as ExternalShortLinkProviderType,
						credentialVersion: slConfig.credentialVersion,
						encryptionKey: c.env.ENCRYPTION_KEY,
					});
					if (!resolvedProvider) {
						throw new Error(
							"Short-link provider credential version is unavailable",
						);
					}
					const result = await shortenUrlsInContent(
						resolvedProvider.provider.shortLinkDomain,
						slConfig.domain,
						finalContent,
						async (url) => {
							const created = await createTrackedExternalShortLink({
								db,
								organizationId: orgId,
								workspaceId,
								originalUrl: url,
								providerType:
									slConfig.provider as ExternalShortLinkProviderType,
								providerConfigVersion: slConfig.providerConfigVersion,
								credentialVersion: slConfig.credentialVersion as number,
								domain: slConfig.domain,
								apiKey: resolvedProvider.apiKey,
								provider: resolvedProvider.provider,
							});
							if (!created.shortUrl) {
								throw new Error("Short-link provider returned no active URL");
							}
							return {
								shortUrl: created.shortUrl,
								shortLinkId: created.id,
							};
						},
					);
					finalContent = result.content;
					shortenedUrls = result.shortenedUrls.map((url) => ({
						...url,
						provider: slConfig.provider as ExternalShortLinkProviderType,
					}));
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
		...effectiveTargetOptions,
		...(body.media && body.media.length > 0 ? { _media: body.media } : {}),
	};

	// Sentinel type for early-exit error responses inside the transaction
	type TxEarlyReturn = { __earlyReturn: true; body: unknown; status: number };

	let post: typeof posts.$inferSelect;
	let recyclingResponse: ReturnType<typeof formatRecyclingConfig> | null = null;
	let scheduledWebhook: PersistedWebhookEvent | null = null;
	let responseTargets: PostResponseBody["targets"] = {};
	const scheduleOccurrenceId =
		postStatus === "scheduled" ? generateId("pso_") : null;

	try {
		const txResult = await db.transaction(async (tx) => {
			const rows = await tx
				.insert(posts)
				.values({
					organizationId: orgId,
					workspaceId,
					content: finalContent,
					status: postStatus,
					scheduledAt,
					timezone: body.timezone,
					platformOverrides:
						Object.keys(platformOverrides).length > 0
							? platformOverrides
							: null,
				})
				.returning();
			const txPost = rows[0];
			if (!txPost) {
				throw {
					__earlyReturn: true,
					body: {
						error: { code: "INTERNAL_ERROR", message: "Failed to create post" },
					},
					status: 400,
				} as TxEarlyReturn;
			}

			// Track shortened URLs
			if (shortenedUrls.length > 0) {
				const relayApiCodes = shortenedUrls
					.filter((link) => link.provider === "relayapi")
					.map(
						(link) =>
							new URL(link.short).pathname.split("/").filter(Boolean).at(-1) ??
							link.short,
					);
				const externalLinks = shortenedUrls.filter(
					(link) =>
						link.provider !== "relayapi" &&
						typeof link.shortLinkId === "string",
				);

				if (relayApiCodes.length > 0) {
					await tx
						.update(shortLinks)
						.set({ postId: txPost.id })
						.where(
							and(
								eq(shortLinks.organizationId, orgId),
								eq(shortLinks.scopeKey, workspaceScopeKey(txPost.workspaceId)),
								eq(shortLinks.provider, "relayapi"),
								inArray(shortLinks.shortCode, relayApiCodes),
							),
						);
				}

				if (externalLinks.length > 0) {
					await tx
						.update(shortLinks)
						.set({ postId: txPost.id })
						.where(
							and(
								eq(shortLinks.organizationId, orgId),
								eq(shortLinks.scopeKey, workspaceScopeKey(txPost.workspaceId)),
								inArray(
									shortLinks.id,
									externalLinks.map((link) => link.shortLinkId as string),
								),
								eq(shortLinks.creationStatus, "active"),
							),
						);
				}
			}

			// Insert post_targets for resolved accounts (bulk insert)
			const targetValues = resolved.flatMap((target) =>
				target.accounts.map((account) => ({
					organizationId: orgId,
					scopeKey: workspaceScopeKey(txPost.workspaceId),
					postId: txPost.id,
					socialAccountId: account.id,
					platform: target.platform,
					status: (isDraft ? "draft" : isNow ? "publishing" : "scheduled") as
						| "draft"
						| "publishing"
						| "scheduled",
				})),
			);
			const insertedTargets =
				targetValues.length > 0
					? await tx.insert(postTargets).values(targetValues).returning()
					: [];
			const accountDetails = new Map(
				resolved.flatMap((target) =>
					target.accounts.map((account) => [account.id, account] as const),
				),
			);
			const txResponseTargets = buildTargetResponse(
				insertedTargets.map((target) => {
					const account = accountDetails.get(target.socialAccountId);
					return {
						...target,
						username: account?.username ?? null,
						displayName: account?.display_name ?? null,
						avatarUrl: null,
					};
				}),
			);
			for (const target of failed) {
				txResponseTargets[target.key] = {
					status: "failed",
					platform: null,
					error: target.error,
				};
			}
			if (isNow && targetValues.length > 0) {
				await tx.insert(publishOutbox).values(
					publishOutboxRow({
						organizationId: orgId,
						postId: txPost.id,
					}),
				);
			}

			// Handle recycling config if provided
			let txRecyclingResponse: ReturnType<typeof formatRecyclingConfig> | null =
				null;
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
						tx as unknown as ReturnType<typeof createDb>,
						orgId,
						txPost.id,
						postStatus,
						body.recycling,
						undefined,
						resolved.flatMap((target) =>
							target.accounts.map(() => target.platform),
						),
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
			if (
				body.cross_post_actions &&
				body.cross_post_actions.length > 0 &&
				!isDraft
			) {
				// Resolve each acting account and an explicit same-platform source
				// target. Persisting the source removes the processor's former
				// arbitrary `.limit(1)` choice and binds the complete scope tuple.
				const targetIds = body.cross_post_actions.map(
					(a) => a.target_account_id,
				);
				const ownedAccounts = await tx
					.select({
						id: socialAccounts.id,
						platform: socialAccounts.platform,
					})
					.from(socialAccounts)
					.where(
						and(
							inArray(socialAccounts.id, targetIds),
							eq(socialAccounts.organizationId, orgId),
							eq(socialAccounts.scopeKey, txPost.scopeKey),
							eq(socialAccounts.lifecycleStatus, "active"),
						),
					);
				const ownedById = new Map(
					ownedAccounts.map((account) => [account.id, account]),
				);
				for (const action of body.cross_post_actions) {
					if (!ownedById.has(action.target_account_id)) {
						throw {
							__earlyReturn: true,
							body: {
								error: {
									code: "NOT_FOUND",
									message: `Target account ${action.target_account_id} not found`,
								},
							},
							status: 404,
						} as TxEarlyReturn;
					}
				}

				const publishDate = scheduledAt ?? new Date();
				const actionValues = body.cross_post_actions.map((action) => {
					const targetAccount = ownedById.get(action.target_account_id);
					if (!targetAccount) {
						throw new Error("Validated target account disappeared");
					}
					const sourceTarget = chooseCrossPostSourceTarget(
						insertedTargets,
						targetAccount.platform,
					);
					if (!sourceTarget) {
						throw {
							__earlyReturn: true,
							body: {
								error: {
									code: "INVALID_REQUEST",
									message: `Cross-post target account ${action.target_account_id} has no same-platform post target`,
								},
							},
							status: 400,
						} as TxEarlyReturn;
					}
					const id = generateId("cpa_");
					const scheduledFor = new Date(
						publishDate.getTime() + action.delay_minutes * 60 * 1000,
					);
					return {
						id,
						operationId: `cross-post:${id}`,
						organizationId: orgId,
						scopeKey: txPost.scopeKey,
						postId: txPost.id,
						sourceTargetId: sourceTarget.id,
						sourcePlatform: sourceTarget.platform,
						actionType: action.action_type,
						targetAccountId: action.target_account_id,
						targetPlatform: targetAccount.platform,
						content: action.content ?? null,
						delayMinutes: action.delay_minutes,
						scheduledFor,
						nextAttemptAt: scheduledFor,
					};
				});
				await tx.insert(crossPostActions).values(actionValues);
			}

			const webhook = scheduleOccurrenceId
				? await persistWebhookEventInTransaction(
						tx,
						orgId,
						"post.scheduled",
						{
							post_id: txPost.id,
							status: "scheduled",
							scheduled_at: txPost.scheduledAt?.toISOString() ?? null,
							targets: txResponseTargets,
						},
						{
							workspaceId: txPost.workspaceId,
							occurrenceId: `post:${txPost.id}:schedule:${scheduleOccurrenceId}`,
						},
					)
				: null;

			return {
				post: txPost,
				recyclingResponse: txRecyclingResponse,
				webhook,
				responseTargets: txResponseTargets,
			};
		});

		post = txResult.post;
		recyclingResponse = txResult.recyclingResponse;
		scheduledWebhook = txResult.webhook;
		responseTargets = txResult.responseTargets;
	} catch (err: unknown) {
		const earlyErr = err as {
			__earlyReturn?: boolean;
			body?: unknown;
			status?: unknown;
		};
		if (earlyErr?.__earlyReturn) {
			return c.json(earlyErr.body as never, earlyErr.status as never);
		}
		throw err;
	}

	// --- Update idea reference if created from an idea ---
	if (ideaSource) {
		const ideaSourceId = ideaSource.id;
		const attributionPrincipalId = c.get("principalId");
		c.executionCtx.waitUntil(
			db.transaction(async (tx) => {
				await tx
					.update(ideas)
					.set({ convertedToPostId: post.id, updatedAt: new Date() })
					.where(
						and(eq(ideas.id, ideaSourceId), eq(ideas.organizationId, orgId)),
					);
				await tx.insert(ideaActivity).values({
					ideaId: ideaSourceId,
					organizationId: orgId,
					actorPrincipalId: attributionPrincipalId,
					action: "converted",
					metadata: { post_id: post.id },
				});
			}),
		);
	}

	// Publish now — fire-and-forget via waitUntil so the response returns immediately.
	// Publishing can take 8-30+ seconds (Instagram needs to download and process media).
	// Blocking the response causes frontend timeouts and duplicate retries.
	if (isNow && resolved.length > 0) {
		// Enqueue to PUBLISH_QUEUE — queue consumers have 15min timeout vs 30s for waitUntil,
		// which is required for video publishing (Threads/Instagram poll for minutes).
		c.executionCtx.waitUntil(dispatchPublishOutbox(c.env));
		c.executionCtx.waitUntil(
			notifyRealtime(c.env, orgId, {
				type: "post.created",
				post_id: post.id,
				status: "publishing",
			}),
		);

		const presignedMedia = await presignMediaUrls(
			db,
			c.env,
			body.media ?? null,
			orgId,
		);
		const response: PostResponseBody = {
			id: post.id,
			status: "publishing" as const,
			content: post.content,
			scheduled_at: body.scheduled_at,
			published_at: null,
			targets: responseTargets,
			media: presignedMedia,
			recycling: recyclingResponse,
			recycled_from_id: null,
			created_at: post.createdAt.toISOString(),
			updated_at: new Date().toISOString(),
		};
		return c.json(response, 201);
	}

	if (scheduledWebhook) {
		c.executionCtx.waitUntil(
			enqueuePersistedWebhookEvent(c.env, db, scheduledWebhook),
		);
	}

	c.executionCtx.waitUntil(
		notifyRealtime(c.env, orgId, {
			type: "post.created",
			post_id: post.id,
			status: postStatus,
		}),
	);

	const presignedMedia = await presignMediaUrls(
		db,
		c.env,
		body.media ?? null,
		orgId,
	);
	const response: PostResponseBody = {
		id: post.id,
		status: postStatus,
		content: post.content,
		scheduled_at: body.scheduled_at,
		published_at: post.publishedAt?.toISOString() ?? null,
		targets: responseTargets,
		media: presignedMedia,
		recycling: recyclingResponse,
		recycled_from_id: null,
		created_at: post.createdAt.toISOString(),
		updated_at: post.updatedAt.toISOString(),
	};
	return c.json(response, 201);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getPost, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	// All three queries are keyed on the path id, so they run in one parallel
	// round trip instead of post-then-children (results are discarded unless
	// the post exists, belongs to the org, and passes workspace scope).
	const [[post], targets, [recyclingConfig]] = await Promise.all([
		db
			.select({
				id: posts.id,
				status: posts.status,
				content: posts.content,
				notes: posts.notes,
				scheduledAt: posts.scheduledAt,
				platformOverrides: posts.platformOverrides,
				timezone: posts.timezone,
				recycledFromId: posts.recycledFromId,
				workspaceId: posts.workspaceId,
				createdAt: posts.createdAt,
				updatedAt: posts.updatedAt,
			})
			.from(posts)
			.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
			.limit(1),
		db
			.select({
				id: postTargets.id,
				socialAccountId: postTargets.socialAccountId,
				platform: postTargets.platform,
				status: postTargets.status,
				platformUrl: postTargets.platformUrl,
				platformPostId: postTargets.platformPostId,
				error: postTargets.error,
				errorCode: postTargets.errorCode,
				errorDetail: postTargets.errorDetail,
				publishOperationId: postTargets.publishOperationId,
				deliveryState: postTargets.deliveryState,
				username: socialAccounts.username,
				displayName: socialAccounts.displayName,
				avatarUrl: socialAccounts.avatarUrl,
			})
			.from(postTargets)
			.leftJoin(
				socialAccounts,
				eq(postTargets.socialAccountId, socialAccounts.id),
			)
			.where(eq(postTargets.postId, id)),
		db
			.select()
			.from(postRecyclingConfigs)
			.where(eq(postRecyclingConfigs.sourcePostId, id))
			.limit(1),
	]);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) return denied as never;

	const overrides = post.platformOverrides as Record<string, unknown> | null;
	const rawMedia = overrides?._media ? (overrides._media as MediaItem[]) : null;
	const thumbMap = await buildThumbnailMap(db, orgId, [rawMedia]);

	// Prefer platform CDN media from external posts for published posts (parity
	// with the list endpoint), but keep our durable R2 thumbnail as the preview so
	// it survives platform-URL expiry.
	let mediaArr: MediaItem[] | null = null;
	if (post.status === "published") {
		const publishedPostIds = targets
			.filter((t) => t.status === "published" && t.platformPostId)
			.map((t) => t.platformPostId as string);
		if (publishedPostIds.length > 0) {
			const extRows = await db
				.select({
					platformPostId: externalPosts.platformPostId,
					mediaUrls: externalPosts.mediaUrls,
					mediaType: externalPosts.mediaType,
					thumbnailUrl: externalPosts.thumbnailUrl,
					previewThumbnailUrl: externalPosts.previewThumbnailUrl,
				})
				.from(externalPosts)
				.where(
					and(
						inArray(externalPosts.platformPostId, publishedPostIds),
						eq(externalPosts.organizationId, orgId),
					),
				);
			for (const row of extRows) {
				const items: MediaItem[] = [];
				const urls = row.mediaUrls as string[] | null;
				const previewUrl =
					row.previewThumbnailUrl ?? row.thumbnailUrl ?? undefined;
				if (urls && urls.length > 0) {
					for (const url of urls) {
						items.push({
							url,
							type: responseMediaType(row.mediaType),
							thumbnail: previewUrl,
						});
					}
				} else if (previewUrl) {
					items.push({
						url: previewUrl,
						type: responseMediaType(row.mediaType),
						thumbnail: previewUrl,
					});
				}
				if (items.length > 0) {
					mediaArr = preferDurableThumbnails(items, rawMedia, thumbMap);
					break;
				}
			}
		}
	}
	// Fall back to presigned R2 URLs, attaching durable thumbnails first.
	if (!mediaArr) {
		mediaArr = await presignMediaUrls(
			db,
			c.env,
			attachThumbnails(rawMedia, thumbMap),
			orgId,
		);
	}
	const targetOpts = overrides
		? Object.fromEntries(
				Object.entries(overrides).filter(([k]) => k !== "_media"),
			)
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
			target_options:
				targetOpts && Object.keys(targetOpts).length > 0 ? targetOpts : null,
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
	const db = c.get("db");

	const [post] = await db
		.select()
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) {
		markMutationInputNotApplied(c);
		return denied as never;
	}

	if (!["draft", "scheduled", "failed"].includes(post.status)) {
		markMutationInputNotApplied(c);
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
	const relayMediaPolicy = await loadRelayMediaPolicy(
		db,
		orgId,
		mediaPolicyInput(body),
		mediaPublicHost(c.env),
		c.get("workspaceScope"),
	);
	const mediaViolation = violationForPostInput(relayMediaPolicy, body);
	if (mediaViolation) {
		markMutationInputNotApplied(c);
		return c.json(mediaPolicyError(mediaViolation), 400 as never);
	}

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (body.content !== undefined) updates.content = body.content;
	if (body.notes !== undefined) updates.notes = body.notes;
	if (body.timezone !== undefined) updates.timezone = body.timezone;

	// Merge platformOverrides: preserve _media when updating target_options and vice versa
	const existingOverrides =
		(post.platformOverrides as Record<string, unknown>) ?? {};
	const { _media: existingMedia } = existingOverrides;
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
		updates.platformOverrides =
			Object.keys(newOverrides).length > 0 ? newOverrides : null;
	}

	const effectiveTimezone = body.timezone ?? post.timezone ?? null;
	if (body.scheduled_at !== undefined) {
		if (body.scheduled_at === "draft") {
			updates.status = "draft";
			updates.scheduledAt = null;
		} else if (body.scheduled_at === "now") {
			updates.status = "publishing";
		} else if (body.scheduled_at === "auto") {
			// Auto-schedule to the best available slot, mirroring the create handler.
			// Previously "auto" fell into the else branch → new Date("auto") (Invalid Date)
			// → 500 when serialized.
			const { findBestSlot } = await import("../services/slot-finder");
			const slot = await findBestSlot(c.env, orgId, {
				db,
				workspaceScope: c.get("workspaceScope"),
				workspaceId: post.workspaceId,
				after: new Date(),
				strategy: "smart",
			});
			if (!slot) {
				markMutationInputNotApplied(c);
				return c.json(
					{
						error: {
							code: "NO_SLOT_AVAILABLE",
							message:
								"No available slot found. Configure queue slots or try a specific time.",
						},
					},
					409 as never,
				);
			}
			updates.status = "scheduled";
			updates.scheduledAt = new Date(slot.slot_at);
		} else {
			updates.status = "scheduled";
			// Honour the post's IANA timezone for offset-less wall-clock times.
			updates.scheduledAt = resolveScheduledAt(
				body.scheduled_at,
				effectiveTimezone,
			);
		}
	}

	const projectedStatus =
		(updates.status as typeof posts.$inferSelect.status | undefined) ??
		post.status;

	// Drafts are exempt from the payload requirement at creation because they are
	// placeholders. That exemption has to be re-checked here: leaving draft is the
	// point where an empty post becomes publishable, and nothing downstream in the
	// publish queue re-validates content.
	if (projectedStatus !== "draft") {
		const { _media: projectedMedia, ...projectedTargetOptions } = newOverrides;
		if (
			!hasEffectivePostPayload(
				body.content !== undefined ? body.content : post.content,
				Array.isArray(projectedMedia) ? projectedMedia : undefined,
				projectedTargetOptions as Record<string, Record<string, unknown>>,
			)
		) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "CONTENT_REQUIRED",
						message:
							"A post must have non-empty content, media, or per-target content before it can leave draft.",
					},
				},
				400 as never,
			);
		}
	}

	let replacementTargets: Array<typeof postTargets.$inferInsert> | null = null;

	// Resolve every related ID before mutating the parent. A validation failure now
	// leaves the original post and targets untouched.
	if (body.targets !== undefined && body.targets.length > 0) {
		const { resolved, failed } = await resolveTargets(
			db,
			orgId,
			body.targets,
			c.get("workspaceScope"),
			undefined,
			post.workspaceId,
		);

		// If NOTHING resolved, do NOT delete the existing targets — wiping them would
		// leave the post with zero targets (it would publish to nothing, or get stuck).
		// Reject with NO_VALID_TARGETS, mirroring createThread.
		if (resolved.length === 0) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "NO_VALID_TARGETS",
						message:
							failed.length > 0
								? failed.map((f) => `${f.key}: ${f.error.message}`).join("; ")
								: "No valid targets resolved.",
					},
				},
				400,
			);
		}

		const targetStatus =
			projectedStatus === "draft"
				? "draft"
				: projectedStatus === "publishing"
					? "publishing"
					: "scheduled";

		replacementTargets = resolved.flatMap((target) =>
			target.accounts.map((account) => ({
				organizationId: orgId,
				scopeKey: workspaceScopeKey(post.workspaceId),
				postId: id,
				socialAccountId: account.id,
				platform: target.platform as typeof postTargets.$inferInsert.platform,
				status: targetStatus as typeof postTargets.$inferInsert.status,
			})),
		);
	}

	const scheduleOccurrenceId =
		updates.status === "scheduled" ? generateId("pso_") : null;
	const mutation = await db.transaction(async (tx) => {
		const updatedRows = await tx
			.update(posts)
			.set({
				...updates,
				revision: sql`${posts.revision} + 1`,
			})
			.where(
				and(
					eq(posts.id, id),
					eq(posts.organizationId, orgId),
					eq(posts.status, post.status),
					eq(posts.revision, post.revision),
				),
			)
			.returning();
		const txUpdated = updatedRows[0];
		if (!txUpdated) return { post: null, webhook: null };

		if (replacementTargets) {
			await tx.delete(postTargets).where(eq(postTargets.postId, id));
			await tx.insert(postTargets).values(replacementTargets);
		} else if (projectedStatus === "publishing") {
			await tx
				.update(postTargets)
				.set({
					status: "publishing",
					deliveryState: "queued",
					attemptId: null,
					claimedAt: null,
					leaseExpiresAt: null,
					requestMayHaveBeenSentAt: null,
					error: null,
					errorCode: null,
					errorDetail: null,
					updatedAt: new Date(),
				})
				.where(eq(postTargets.postId, id));
		}

		if (projectedStatus === "publishing") {
			await tx.insert(publishOutbox).values(
				publishOutboxRow({
					organizationId: orgId,
					postId: id,
					operationId: `publish:${id}:${crypto.randomUUID()}`,
				}),
			);
		}

		// Re-anchor never-attempted actions atomically with the post schedule.
		// Provider/readiness retries update only nextAttemptAt later, preserving
		// scheduledFor as the product schedule that was actually requested.
		if (body.scheduled_at !== undefined && body.scheduled_at !== "draft") {
			const anchor =
				txUpdated.status === "publishing"
					? txUpdated.updatedAt
					: txUpdated.scheduledAt;
			if (anchor) {
				await tx
					.update(crossPostActions)
					.set({
						scheduledFor: sql`${anchor.toISOString()}::timestamptz + (${crossPostActions.delayMinutes} * interval '1 minute')`,
						nextAttemptAt: sql`${anchor.toISOString()}::timestamptz + (${crossPostActions.delayMinutes} * interval '1 minute')`,
					})
					.where(
						and(
							eq(crossPostActions.postId, id),
							eq(crossPostActions.status, "pending"),
						),
					);
			}
		}

		const webhook = scheduleOccurrenceId
			? await persistWebhookEventInTransaction(
					tx,
					orgId,
					"post.scheduled",
					{
						post_id: id,
						status: "scheduled",
						scheduled_at: txUpdated.scheduledAt?.toISOString() ?? null,
						targets: {},
					},
					{
						workspaceId: txUpdated.workspaceId,
						occurrenceId: `post:${id}:schedule:${scheduleOccurrenceId}`,
					},
				)
			: null;
		return { post: txUpdated, webhook };
	});
	const updated = mutation.post;
	const updatedScheduledWebhook = mutation.webhook;
	if (!updated) {
		return c.json(
			{
				error: {
					code: "CONFLICT",
					message:
						"The post changed or publishing started while this update was being applied. Reload and try again.",
				},
			},
			409,
		);
	}
	if (updatedScheduledWebhook) {
		c.executionCtx.waitUntil(
			enqueuePersistedWebhookEvent(c.env, db, updatedScheduledWebhook),
		);
	}

	// Enqueue for publishing if status changed to "publishing". Usage is billed by
	// the mutating-request middleware, never by the retryable Queue consumer.
	if (updates.status === "publishing") {
		c.executionCtx.waitUntil(dispatchPublishOutbox(c.env));
	}

	// Fetch updated targets and recycling config for response
	const [updatedTargets, [recyclingConfig]] = await Promise.all([
		db
			.select({
				id: postTargets.id,
				socialAccountId: postTargets.socialAccountId,
				platform: postTargets.platform,
				status: postTargets.status,
				platformUrl: postTargets.platformUrl,
				platformPostId: postTargets.platformPostId,
				error: postTargets.error,
				errorCode: postTargets.errorCode,
				errorDetail: postTargets.errorDetail,
				publishOperationId: postTargets.publishOperationId,
				deliveryState: postTargets.deliveryState,
				username: socialAccounts.username,
				displayName: socialAccounts.displayName,
				avatarUrl: socialAccounts.avatarUrl,
			})
			.from(postTargets)
			.leftJoin(
				socialAccounts,
				eq(postTargets.socialAccountId, socialAccounts.id),
			)
			.where(eq(postTargets.postId, id)),
		db
			.select()
			.from(postRecyclingConfigs)
			.where(eq(postRecyclingConfigs.sourcePostId, id))
			.limit(1),
	]);

	const finalOverrides =
		(updated.platformOverrides as Record<string, unknown>) ?? {};
	const responseMedia = await presignMediaUrls(
		db,
		c.env,
		finalOverrides._media ? (finalOverrides._media as MediaItem[]) : null,
		orgId,
	);
	const responseOpts = Object.fromEntries(
		Object.entries(finalOverrides).filter(([k]) => k !== "_media"),
	);

	c.executionCtx.waitUntil(
		notifyRealtime(c.env, orgId, {
			type: "post.updated",
			post_id: id,
			status: updated.status,
		}),
	);
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
			target_options:
				Object.keys(responseOpts).length > 0 ? responseOpts : null,
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
	const db = c.get("db");

	const [post] = await db
		.select({
			id: posts.id,
			status: posts.status,
			workspaceId: posts.workspaceId,
			publishAttempts: posts.publishAttempts,
			revision: posts.revision,
		})
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) {
		markMutationInputNotApplied(c);
		return denied;
	}

	// Once provider execution has started, retain the durable attempts and result
	// graph for reconciliation/audit. A draft or never-attempted schedule can be
	// deleted safely; the CAS elects either this delete or a concurrent scheduler.
	if (
		!(["draft", "scheduled"] as string[]).includes(post.status) ||
		post.publishAttempts > 0
	) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "INVALID_STATE",
					message:
						"Posts are immutable after publishing starts so provider history can be reconciled.",
				},
			},
			409,
		);
	}
	const deleted = await db
		.delete(posts)
		.where(
			and(
				eq(posts.id, id),
				eq(posts.organizationId, orgId),
				eq(posts.status, post.status),
				eq(posts.publishAttempts, 0),
				eq(posts.revision, post.revision),
			),
		)
		.returning({ id: posts.id });
	if (deleted.length === 0) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "CONFLICT",
					message:
						"The post changed or publishing started while deletion was being applied.",
				},
			},
			409,
		);
	}

	c.executionCtx.waitUntil(
		notifyRealtime(c.env, orgId, { type: "post.deleted", post_id: id }),
	);
	return c.body(null, 204);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(retryPost, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [post] = await db
		.select()
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) {
		markMutationInputNotApplied(c);
		return denied as never;
	}

	if (!["failed", "partial"].includes(post.status)) {
		markMutationInputNotApplied(c);
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

	// Resolve which failed targets are actually retryable: their social account must
	// still exist AND be within the API key's workspace scope. We must filter BEFORE
	// resetting target status — otherwise targets whose account is missing/out-of-scope
	// would be flipped to "publishing" but never published, stranding them un-retryable
	// (a later retry only re-selects status="failed") and billing for a no-op.
	const accountIds = [...new Set(failedTargets.map((t) => t.socialAccountId))];
	const wsScope = c.get("workspaceScope");
	const retryAccountConditions = [inArray(socialAccounts.id, accountIds)];
	if (wsScope !== "all") {
		retryAccountConditions.push(
			workspaceScopeSqlCondition(wsScope, socialAccounts.workspaceId),
		);
	}
	const accounts = await db
		.select({ id: socialAccounts.id })
		.from(socialAccounts)
		.where(and(...retryAccountConditions));
	const resolvableAccountIds = new Set(accounts.map((a) => a.id));

	const retryableTargets = failedTargets.filter((t) =>
		resolvableAccountIds.has(t.socialAccountId),
	);

	// Nothing resolvable to retry — leave targets untouched (still "failed", still
	// retryable later) and do not charge usage. Return the post unchanged.
	if (retryableTargets.length === 0) {
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

	// Reset ONLY the resolvable failed targets to "publishing" and flip the post to
	// "publishing", then hand off to the publish queue. Publishing inline here blocked
	// the HTTP response on every platform API call (video polling can take minutes) plus
	// awaited webhook retries — the same reason single-post create enqueues. The consumer
	// (publishPostById) re-extracts media from platformOverrides._media (fixing the bug
	// where retry published without attachments) and only acts on actionable targets.
	const retryableTargetIds = retryableTargets.map((t) => t.id);
	await db.transaction(async (tx) => {
		await tx
			.update(postTargets)
			.set({
				status: "publishing",
				deliveryState: "queued",
				attemptId: null,
				claimedAt: null,
				leaseExpiresAt: null,
				requestMayHaveBeenSentAt: null,
				error: null,
			})
			.where(inArray(postTargets.id, retryableTargetIds));
		await tx
			.update(posts)
			.set({
				status: "publishing",
				revision: sql`${posts.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(eq(posts.id, id));
		await tx.insert(publishOutbox).values(
			publishOutboxRow({
				organizationId: orgId,
				postId: id,
				operationId: `publish:${id}:retry:${crypto.randomUUID()}`,
			}),
		);
	});

	c.executionCtx.waitUntil(dispatchPublishOutbox(c.env));

	const allTargets = await db
		.select()
		.from(postTargets)
		.where(eq(postTargets.postId, id));

	c.executionCtx.waitUntil(
		notifyRealtime(c.env, orgId, {
			type: "post.updated",
			post_id: id,
			status: "publishing",
		}),
	);
	return c.json(
		{
			id: post.id,
			status: "publishing",
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

app.openapi(reconcilePublishTarget, async (c) => {
	const orgId = c.get("orgId");
	const { id, target_id: targetId } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
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
	if (isWorkspaceScopeDenied(c, post.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	const now = new Date();
	const result = await db.transaction(async (tx) => {
		const scope = await lockProviderReconciliationScope(tx, {
			postId: id,
			organizationId: orgId,
			threadGroupId: post.threadGroupId,
		});
		if (!scope.locked) {
			return {
				conflict:
					scope.conflict === "thread"
						? ("thread" as const)
						: ("target" as const),
			};
		}
		const lockedPost = scope.post;
		if (!lockedPost.threadGroupId && lockedPost.publishLeaseId !== null) {
			return { conflict: "target" as const };
		}

		const threadLeaseId = `reconcile:${crypto.randomUUID()}`;
		if (lockedPost.threadGroupId) {
			// Serialize reconciliation for every unknown target in a thread. Two
			// operators may resolve different targets concurrently; without a row
			// fence both transactions can observe the other target as unresolved and
			// leave a thread permanently asleep. This same fence also prevents a
			// reconciliation from racing the worker before it has terminalized the
			// execution as unknown.
			const [claimedThread] = await tx
				.update(threadExecutions)
				.set({
					leaseId: threadLeaseId,
					leaseExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
					updatedAt: now,
				})
				.where(
					and(
						eq(threadExecutions.threadGroupId, lockedPost.threadGroupId),
						eq(threadExecutions.organizationId, orgId),
						eq(threadExecutions.status, "unknown"),
					),
				)
				.returning({ threadGroupId: threadExecutions.threadGroupId });
			if (!claimedThread) return { conflict: "thread" as const };
		}

		const succeeded = body.outcome === "succeeded";
		const saved = await persistManualProviderReconciliation(tx, {
			targetId,
			postId: id,
			organizationId: orgId,
			publishOperationId: body.publish_operation_id,
			succeeded,
			providerPostId: succeeded ? body.provider_post_id : null,
			providerUrl: succeeded ? (body.provider_url ?? null) : null,
			errorCode: succeeded ? null : body.error_code,
			errorMessage: succeeded ? null : body.error_message,
			observedAt: now,
		});
		if (!saved) {
			if (lockedPost.threadGroupId) {
				await tx
					.update(threadExecutions)
					.set({ leaseId: null, leaseExpiresAt: null, updatedAt: now })
					.where(
						and(
							eq(threadExecutions.threadGroupId, lockedPost.threadGroupId),
							eq(threadExecutions.organizationId, orgId),
							eq(threadExecutions.status, "unknown"),
							eq(threadExecutions.leaseId, threadLeaseId),
						),
					);
			}
			return { conflict: "target" as const };
		}

		const targetStates = await tx
			.select({
				status: postTargets.status,
				deliveryState: postTargets.deliveryState,
			})
			.from(postTargets)
			.where(eq(postTargets.postId, id));
		const hasNonterminal = targetStates.some((item) =>
			["queued", "in_flight", "unknown"].includes(item.deliveryState),
		);
		const postStatus: "publishing" | "published" | "failed" | "partial" =
			hasNonterminal
				? "publishing"
				: targetStates.every((item) => item.status === "published")
					? "published"
					: targetStates.every((item) => item.status === "failed")
						? "failed"
						: "partial";
		const hasPublishedTarget = targetStates.some(
			(item) => item.status === "published",
		);
		await tx
			.update(posts)
			.set({
				status: postStatus,
				publishedAt:
					postStatus === "published" ||
					(postStatus === "partial" && hasPublishedTarget)
						? (lockedPost.publishedAt ?? now)
						: postStatus === "failed"
							? null
							: lockedPost.publishedAt,
				terminalReason: hasNonterminal ? lockedPost.terminalReason : null,
				revision: sql`${posts.revision} + 1`,
				updatedAt: now,
			})
			.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)));

		let threadStatus: "queued" | "completed" | "failed" | "unknown" | null =
			null;
		let threadCompleted = false;
		if (lockedPost.threadGroupId) {
			const groupPosts = await tx
				.select({
					id: posts.id,
					position: posts.threadPosition,
				})
				.from(posts)
				.where(
					and(
						eq(posts.threadGroupId, lockedPost.threadGroupId),
						eq(posts.organizationId, orgId),
					),
				);
			const groupPostIds = groupPosts.map((item) => item.id);
			const unresolved =
				groupPostIds.length === 0
					? []
					: await tx
							.select({ id: postTargets.id })
							.from(postTargets)
							.where(
								and(
									inArray(postTargets.postId, groupPostIds),
									eq(postTargets.deliveryState, "unknown"),
								),
							)
							.limit(1);
			if (unresolved.length > 0) {
				await tx
					.update(threadExecutions)
					.set({ leaseId: null, leaseExpiresAt: null, updatedAt: now })
					.where(
						and(
							eq(threadExecutions.threadGroupId, lockedPost.threadGroupId),
							eq(threadExecutions.organizationId, orgId),
							eq(threadExecutions.status, "unknown"),
							eq(threadExecutions.leaseId, threadLeaseId),
						),
					);
				threadStatus = "unknown";
			} else if (postStatus === "failed") {
				const downstreamIds = groupPosts
					.filter(
						(item) => (item.position ?? 0) > (lockedPost.threadPosition ?? 0),
					)
					.map((item) => item.id);
				if (downstreamIds.length > 0) {
					const failure = {
						code: "THREAD_ANCESTOR_FAILED",
						message: `Thread position ${lockedPost.threadPosition ?? 0} was reconciled as failed`,
					};
					await tx
						.update(posts)
						.set({
							status: "failed",
							terminalReason: failure,
							revision: sql`${posts.revision} + 1`,
							updatedAt: now,
						})
						.where(
							and(
								inArray(posts.id, downstreamIds),
								inArray(posts.status, ["draft", "scheduled", "publishing"]),
							),
						);
					await tx
						.update(postTargets)
						.set({
							status: "failed",
							deliveryState: "failed",
							error: failure.message,
							errorCode: failure.code,
							updatedAt: now,
						})
						.where(
							and(
								inArray(postTargets.postId, downstreamIds),
								inArray(postTargets.deliveryState, ["queued", "in_flight"]),
							),
						);
				}
				await tx
					.update(threadExecutions)
					.set({
						status: "failed",
						failedPosition: lockedPost.threadPosition ?? 0,
						failure: {
							code: "THREAD_ANCESTOR_FAILED",
							message: "Reconciled provider outcome was failed",
						},
						leaseId: null,
						leaseExpiresAt: null,
						updatedAt: now,
					})
					.where(
						and(
							eq(threadExecutions.threadGroupId, lockedPost.threadGroupId),
							eq(threadExecutions.organizationId, orgId),
							eq(threadExecutions.status, "unknown"),
							eq(threadExecutions.leaseId, threadLeaseId),
						),
					);
				threadStatus = "failed";
			} else {
				const nextPosition = groupPosts
					.map((item) => item.position ?? 0)
					.filter((position) => position > (lockedPost.threadPosition ?? 0))
					.sort((a, b) => a - b)[0];
				if (nextPosition === undefined) {
					await tx
						.update(threadExecutions)
						.set({
							status: "completed",
							failedPosition: null,
							failure: null,
							leaseId: null,
							leaseExpiresAt: null,
							updatedAt: now,
						})
						.where(
							and(
								eq(threadExecutions.threadGroupId, lockedPost.threadGroupId),
								eq(threadExecutions.organizationId, orgId),
								eq(threadExecutions.status, "unknown"),
								eq(threadExecutions.leaseId, threadLeaseId),
							),
						);
					threadStatus = "completed";
					threadCompleted = true;
				} else {
					await tx
						.update(threadExecutions)
						.set({
							status: "queued",
							currentPosition: nextPosition,
							failedPosition: null,
							failure: null,
							leaseId: null,
							leaseExpiresAt: null,
							updatedAt: now,
						})
						.where(
							and(
								eq(threadExecutions.threadGroupId, lockedPost.threadGroupId),
								eq(threadExecutions.organizationId, orgId),
								eq(threadExecutions.status, "unknown"),
								eq(threadExecutions.leaseId, threadLeaseId),
							),
						);
					await tx
						.insert(publishOutbox)
						.values(
							publishOutboxRow({
								organizationId: orgId,
								threadGroupId: lockedPost.threadGroupId,
								threadPosition: nextPosition,
								operationId: `thread:${lockedPost.threadGroupId}:reconcile:${body.publish_operation_id}:${nextPosition}`,
							}),
						)
						.onConflictDoNothing();
					threadStatus = "queued";
				}
			}
		}

		const persistedEvents = [];
		if (postStatus !== "publishing") {
			const eventName =
				postStatus === "published"
					? "post.published"
					: postStatus === "failed"
						? "post.failed"
						: "post.partial";
			persistedEvents.push(
				await persistWebhookEventInTransaction(
					tx,
					orgId,
					eventName,
					{ post_id: id, status: postStatus },
					{
						occurrenceId: `post:${id}:reconcile:${body.publish_operation_id}:${postStatus}`,
					},
				),
			);
		}
		if (threadCompleted && lockedPost.threadGroupId) {
			persistedEvents.push(
				await persistWebhookEventInTransaction(
					tx,
					orgId,
					"thread.published",
					{ thread_group_id: lockedPost.threadGroupId },
					{
						workspaceId: lockedPost.workspaceId,
						occurrenceId: `thread:${lockedPost.threadGroupId}:published`,
					},
				),
			);
		}

		return {
			conflict: null,
			postStatus,
			threadStatus,
			threadCompleted,
			persistedEvents,
		};
	});

	if (result.conflict) {
		return c.json(
			{
				error: {
					code:
						result.conflict === "thread"
							? "THREAD_NOT_RECONCILABLE"
							: "OUTCOME_ALREADY_RESOLVED",
					message:
						result.conflict === "thread"
							? "The thread has not reached an unknown terminal state or is being reconciled by another request."
							: "Target is not unknown or the publish operation fence no longer matches.",
				},
			},
			409,
		);
	}

	await Promise.all(
		result.persistedEvents.map((persisted) =>
			enqueuePersistedWebhookEvent(c.env, db, persisted),
		),
	);
	if (result.threadStatus === "queued") {
		c.executionCtx.waitUntil(dispatchPublishOutbox(c.env));
	}
	await notifyRealtime(c.env, orgId, {
		type: "post.updated",
		post_id: id,
		status: result.postStatus,
	});

	return c.json(
		{
			post_id: id,
			target_id: targetId,
			publish_operation_id: body.publish_operation_id,
			outcome: body.outcome,
			post_status: result.postStatus,
			thread_status: result.threadStatus,
		},
		200,
	);
});

// ---------------------------------------------------------------------------
// Bulk create
// ---------------------------------------------------------------------------

async function bulkItemErrorFromResponse(response: Response): Promise<{
	code: string;
	message: string;
}> {
	try {
		const payload = (await readProviderJson(response)) as {
			error?: { code?: unknown; message?: unknown };
		};
		if (
			typeof payload.error?.code === "string" &&
			typeof payload.error.message === "string"
		) {
			return {
				code: payload.error.code,
				message: payload.error.message,
			};
		}
	} catch {
		// Fall through to a stable per-item error. The synthesized response is
		// internal and should always carry the standard error envelope.
	}
	return {
		code: "WORKSPACE_ACCESS_DENIED",
		message: "The post could not be authorized for the requested workspace.",
	};
}

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(bulkCreatePosts, async (c) => {
	const orgId = c.get("orgId");
	const { posts: postItems } = c.req.valid("json");
	const db = c.get("db");
	const wsScope = c.get("workspaceScope");
	const bulkRelayMediaPolicy = await loadRelayMediaPolicy(
		db,
		orgId,
		postItems.map(mediaPolicyInput),
		mediaPublicHost(c.env),
		wsScope,
	);

	// Pre-fetch org accounts once for all items (resolveTargets fetches them each time)
	const prefetchConditions = [
		eq(socialAccounts.organizationId, orgId),
		eq(socialAccounts.lifecycleStatus, "active"),
	];
	applyWorkspaceScope(c, prefetchConditions, socialAccounts.workspaceId);
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
			const mediaViolation = violationForPostInput(bulkRelayMediaPolicy, item);
			if (mediaViolation) {
				results.push({
					status: "error",
					error: mediaPolicyError(mediaViolation).error,
				});
				failed++;
				continue;
			}
			const targetResolution = await resolveTargets(
				db,
				orgId,
				item.targets,
				wsScope,
				orgAccounts,
				item.workspace_id ?? null,
			);
			const itemScope = await inheritOperationalCreateScope(
				c,
				item.workspace_id,
				targetResolution.workspaceIds,
				"post",
			);
			if (!itemScope.ok) {
				results.push({
					status: "error",
					error: await bulkItemErrorFromResponse(itemScope.response),
				});
				failed++;
				continue;
			}
			const workspaceId = itemScope.workspaceId;
			const { resolved, failed: _failedTargets } = targetResolution;

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
					db,
					workspaceScope: c.get("workspaceScope"),
					workspaceId,
					accountId: resolved[0]?.accounts[0]?.id,
					after: new Date(),
					strategy: "smart",
					excludeTimes: autoScheduledTimes,
				});
				if (!slot) {
					results.push({
						status: "error",
						error: {
							code: "NO_SLOT_AVAILABLE",
							message: "No available slot found for auto-scheduling.",
						},
					});
					failed++;
					continue;
				}
				scheduledAt = new Date(slot.slot_at);
				autoScheduledTimes.push(scheduledAt);
			} else {
				scheduledAt = resolveScheduledAt(item.scheduled_at, item.timezone);
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

			const post = await db.transaction(async (tx) => {
				const rows = await tx
					.insert(posts)
					.values({
						organizationId: orgId,
						workspaceId,
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
				const txPost = rows[0];
				if (!txPost) throw new Error("Failed to insert bulk post");

				const bulkTargetValues = resolved.flatMap((target) =>
					target.accounts.map((account) => ({
						organizationId: orgId,
						scopeKey: workspaceScopeKey(txPost.workspaceId),
						postId: txPost.id,
						socialAccountId: account.id,
						platform: target.platform,
						status: (isDraft ? "draft" : isNow ? "publishing" : "scheduled") as
							| "draft"
							| "publishing"
							| "scheduled",
					})),
				);
				if (bulkTargetValues.length > 0) {
					await tx.insert(postTargets).values(bulkTargetValues);
				}
				if (isNow && bulkTargetValues.length > 0) {
					await tx.insert(publishOutbox).values(
						publishOutboxRow({
							organizationId: orgId,
							postId: txPost.id,
						}),
					);
				}
				return txPost;
			});

			// Publish now if requested: enqueue to PUBLISH_QUEUE rather than publishing
			// inline. Inline publishing awaited every platform's API (8-30s+, minutes for
			// video) serially per item, so a 10-item "now" bulk could run for minutes or
			// hit Worker limits. The post + targets are already persisted with status
			// "publishing"; the consumer (publishPostById) performs the publish and
			// re-extracts media from platformOverrides._media.
			if (isNow && resolved.length > 0) {
				c.executionCtx.waitUntil(dispatchPublishOutbox(c.env));
				results.push({
					id: post.id,
					status: "publishing",
					content: post.content,
					scheduled_at: item.scheduled_at,
					targets: {},
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
	const db = c.get("db");

	const [post] = await db
		.select()
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	// Enforce workspace scope: unpublish issues real DELETE calls to external platforms
	// and flips the post status, so a workspace-scoped key must not be able to unpublish
	// a post in another workspace of the same org. Mirrors every other post mutation.
	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) {
		markMutationInputNotApplied(c);
		return denied;
	}

	if (!["published", "partial"].includes(post.status)) {
		markMutationInputNotApplied(c);
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
		publishedTargets = publishedTargets.filter((t) =>
			selectedPlatforms.includes(t.platform),
		);
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
						platformAccountId: socialAccounts.platformAccountId,
						metadata: socialAccounts.metadata,
					})
					.from(socialAccounts)
					.where(
						and(
							inArray(socialAccounts.id, accountIds),
							eq(socialAccounts.organizationId, orgId),
							eq(socialAccounts.lifecycleStatus, "active"),
						),
					)
			: [];
	// Decrypt and refresh tokens before platform deletion calls
	const accounts = await Promise.all(
		rawAccounts.map(async (a) => {
			const token =
				a.platform === "telegram"
					? await decryptAccountToken(
							a.accessToken,
							c.env.ENCRYPTION_KEY,
							a.id,
							"access_token",
						)
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
	const unpublishMutation = new SingleUnitProviderMutationAggregate(
		c.get("mutationEffectTracker"),
	);
	const deleteResults = await Promise.allSettled(
		publishedTargets
			.filter((t) => t.platformPostId)
			.map(async (target) => {
				const account = accountMap.get(target.socialAccountId);
				if (!account) {
					return {
						targetId: target.id,
						success: false,
						error: "Connected account is unavailable",
					};
				}
				const accessToken =
					account.accessToken ??
					(target.platform === "telegram" ? c.env.TELEGRAM_BOT_TOKEN : null);
				if (!accessToken) {
					return {
						targetId: target.id,
						success: false,
						error: "Connected account credentials are unavailable",
					};
				}
				if (!target.platformPostId) {
					return {
						targetId: target.id,
						success: false,
						error: "Provider post ID is unavailable",
					};
				}
				const platformPostId = target.platformPostId;

				let deleteSuccess = false;
				let attempted = false;
				try {
					const signal = AbortSignal.timeout(FETCH_TIMEOUT);
					switch (target.platform) {
						case "twitter":
							attempted = true;
							deleteSuccess = (
								await unpublishMutation.track("twitter.post.delete", () =>
									fetch(
										`https://api.twitter.com/2/tweets/${target.platformPostId}`,
										{
											method: "DELETE",
											headers: {
												Authorization: `Bearer ${accessToken}`,
											},
											signal,
										},
									),
								)
							).ok;
							break;
						// Facebook Graph API: DELETE a Page post
						// Docs: https://developers.facebook.com/docs/graph-api/reference/post/#deleting
						case "facebook":
							attempted = true;
							deleteSuccess = (
								await unpublishMutation.track("facebook.post.delete", () =>
									fetch(`${GRAPH_BASE.facebook}/${target.platformPostId}`, {
										method: "DELETE",
										headers: { Authorization: `Bearer ${accessToken}` },
										signal,
									}),
								)
							).ok;
							break;
						case "linkedin":
							attempted = true;
							deleteSuccess = (
								await unpublishMutation.track("linkedin.post.delete", () =>
									fetch(
										`${LINKEDIN_REST_BASE}/posts/${encodeURIComponent(platformPostId)}`,
										{
											method: "DELETE",
											headers: getLinkedInRestHeaders(accessToken),
											signal,
										},
									),
								)
							).ok;
							break;
						case "reddit":
							attempted = true;
							deleteSuccess = (
								await unpublishMutation.track("reddit.post.delete", () =>
									fetch("https://oauth.reddit.com/api/del", {
										method: "POST",
										headers: {
											Authorization: `Bearer ${accessToken}`,
											"Content-Type": "application/x-www-form-urlencoded",
											"User-Agent": "RelayAPI/1.0",
										},
										body: new URLSearchParams({ id: platformPostId }),
										signal,
									}),
								)
							).ok;
							break;
						case "pinterest":
							attempted = true;
							deleteSuccess = (
								await unpublishMutation.track("pinterest.post.delete", () =>
									fetch(
										`https://api.pinterest.com/v5/pins/${target.platformPostId}`,
										{
											method: "DELETE",
											headers: {
												Authorization: `Bearer ${accessToken}`,
											},
											signal,
										},
									),
								)
							).ok;
							break;
						// Threads API official Meta collection, "Delete Threads Media
						// Objects" -> DELETE /{thread_id}.
						// https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api
						case "threads":
							attempted = true;
							deleteSuccess = (
								await unpublishMutation.track("threads.post.delete", () =>
									fetch(
										`${GRAPH_BASE.threads}/${encodeURIComponent(platformPostId)}`,
										{
											method: "DELETE",
											headers: { Authorization: `Bearer ${accessToken}` },
											signal,
										},
									),
								)
							).ok;
							break;
						// YouTube Data API v3, videos.delete:
						// DELETE /youtube/v3/videos?id={videoId}; success is 204.
						// https://developers.google.com/youtube/v3/docs/videos/delete
						case "youtube": {
							attempted = true;
							const url = new URL(
								"https://www.googleapis.com/youtube/v3/videos",
							);
							url.searchParams.set("id", platformPostId);
							deleteSuccess = (
								await unpublishMutation.track("youtube.video.delete", () =>
									fetch(url, {
										method: "DELETE",
										headers: { Authorization: `Bearer ${accessToken}` },
										signal,
									}),
								)
							).ok;
							break;
						}
						// AT Protocol canonical deleteRecord Lexicon:
						// POST com.atproto.repo.deleteRecord with repo/collection/rkey.
						// https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/deleteRecord.json
						case "bluesky":
							attempted = true;
							deleteSuccess = (
								await unpublishMutation.track("bluesky.post.delete", () =>
									deleteBlueskyPost(
										{
											id: account.id,
											platform: "bluesky",
											access_token: accessToken,
											refresh_token: null,
											platform_account_id: account.platformAccountId,
											username: null,
											metadata: account.metadata as Record<
												string,
												unknown
											> | null,
										},
										platformPostId,
										signal,
									),
								)
							).ok;
							break;
						// Google Business Profile Local Posts delete:
						// DELETE /v4/{name=accounts/*/locations/*/localPosts/*}.
						// https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts/delete
						case "googlebusiness": {
							attempted = true;
							const resourceName = platformPostId.replace(/^\/+/, "");
							if (
								!/^accounts\/[^/]+\/locations\/[^/]+\/localPosts\/[^/]+$/u.test(
									resourceName,
								)
							) {
								break;
							}
							const connectedLocation = account.platformAccountId.replace(
								/\/+$/u,
								"",
							);
							const defaultLocation =
								typeof (account.metadata as Record<string, unknown> | null)
									?.default_location_id === "string"
									? String(
											(account.metadata as Record<string, unknown>)
												.default_location_id,
										).replace(/^\/+|\/+$/gu, "")
									: null;
							const connectedAccount = /^accounts\/[^/]+/u.exec(
								connectedLocation,
							)?.[0];
							const allowedParents = new Set([connectedLocation]);
							if (connectedAccount && defaultLocation) {
								allowedParents.add(
									`${connectedAccount}/${
										defaultLocation.startsWith("locations/")
											? defaultLocation
											: `locations/${defaultLocation}`
									}`,
								);
							}
							const resourceParent = resourceName.replace(
								/\/localPosts\/[^/]+$/u,
								"",
							);
							if (!allowedParents.has(resourceParent)) break;
							deleteSuccess = (
								await unpublishMutation.track(
									"googlebusiness.post.delete",
									() =>
										fetch(
											`https://mybusiness.googleapis.com/v4/${resourceName}`,
											{
												method: "DELETE",
												headers: { Authorization: `Bearer ${accessToken}` },
												signal,
											},
										),
								)
							).ok;
							break;
						}
						// Telegram Bot API deleteMessage (subject to the provider's
						// documented 48-hour and chat-permission limits).
						// https://core.telegram.org/bots/api#deletemessage
						case "telegram": {
							attempted = true;
							const messageIds = new Set<number>();
							for (const rawId of [
								platformPostId,
								...(target.providerEffects ?? [])
									.filter(
										(effect) =>
											effect.status === "succeeded" &&
											effect.name.startsWith("telegram_message_") &&
											effect.provider_id,
									)
									.map((effect) => effect.provider_id as string),
							]) {
								const messageId = Number(rawId);
								if (Number.isSafeInteger(messageId) && messageId > 0) {
									messageIds.add(messageId);
								}
							}
							if (messageIds.size === 0) {
								break;
							}
							const outcomes = await Promise.all(
								[...messageIds].map(async (messageId, index) => {
									const response = await unpublishMutation.track(
										`telegram.message.delete.${index}`,
										() =>
											fetchPublicUrl(
												`https://api.telegram.org/bot${accessToken}/deleteMessage`,
												{
													method: "POST",
													redirect: "error",
													timeout: FETCH_TIMEOUT,
													timeoutThroughBody: true,
													headers: { "Content-Type": "application/json" },
													body: JSON.stringify({
														chat_id: account.platformAccountId,
														message_id: messageId,
													}),
													signal,
												},
											),
									);
									type TelegramDeleteResponse = {
										ok?: boolean;
										result?: boolean;
										description?: string;
									};
									const payload =
										await readResponseJson<TelegramDeleteResponse>(
											response,
											64 * 1024,
										).catch((): TelegramDeleteResponse => ({}));
									return (
										(response.ok &&
											payload.ok === true &&
											payload.result === true) ||
										(response.status === 400 &&
											payload.description
												?.toLowerCase()
												.includes("message to delete not found"))
									);
								}),
							);
							deleteSuccess = outcomes.every(Boolean);
							break;
						}
						// Mastodon statuses API, "Delete a status":
						// DELETE /api/v1/statuses/:id with write:statuses.
						// https://docs.joinmastodon.org/methods/statuses/#delete
						case "mastodon": {
							attempted = true;
							const instanceUrl = resolveMastodonInstanceUrl(
								account.metadata as Record<string, unknown> | null,
							);
							const url = new URL(
								`/api/v1/statuses/${encodeURIComponent(platformPostId)}`,
								instanceUrl,
							);
							url.searchParams.set("delete_media", "true");
							deleteSuccess = (
								await unpublishMutation.track("mastodon.status.delete", () =>
									fetchPublicUrl(url, {
										method: "DELETE",
										redirect: "error",
										timeout: FETCH_TIMEOUT,
										headers: { Authorization: `Bearer ${accessToken}` },
										signal,
									}),
								)
							).ok;
							break;
						}
						// Discord Webhook API, "Delete Webhook Message":
						// DELETE /webhooks/{webhook.id}/{webhook.token}/messages/{message.id}.
						// https://docs.discord.com/developers/resources/webhook#delete-webhook-message
						case "discord": {
							attempted = true;
							const webhook = parseDiscordWebhookUrl(accessToken);
							deleteSuccess = (
								await unpublishMutation.track("discord.message.delete", () =>
									fetchPublicUrl(
										`${webhook.url}/messages/${encodeURIComponent(platformPostId)}`,
										{
											method: "DELETE",
											redirect: "error",
											timeout: FETCH_TIMEOUT,
											signal,
										},
									),
								)
							).ok;
							break;
						}
					}
				} catch {
					/* timeout or network error */
				}
				return {
					targetId: target.id,
					success: deleteSuccess,
					error: deleteSuccess
						? null
						: attempted
							? "Platform deletion failed"
							: "Unpublish is not supported by this platform",
				};
			}),
	);

	// Build update promises for targets that went through platform deletion.
	// On a FAILED deletion the content is still live on the platform, so the target
	// must stay "published" (with the error recorded) — marking it "failed" would both
	// misreport the state and block any retry (unpublish only accepts published/partial
	// posts). Only a SUCCESSFUL deletion flips the target to "draft".
	const updatePromises: Promise<unknown>[] = [];
	const processedTargetIds = new Set<string>();
	let anySuccessfullyRemoved = false;
	let hasLocalUnpublishEffect = false;

	for (const result of deleteResults) {
		const val =
			result.status === "fulfilled"
				? result.value
				: { targetId: "", success: false, error: "Platform deletion failed" };
		if (!val.targetId) continue;
		processedTargetIds.add(val.targetId);
		if (val.success) {
			anySuccessfullyRemoved = true;
			updatePromises.push(
				db
					.update(postTargets)
					.set({ status: "draft", error: null })
					.where(eq(postTargets.id, val.targetId)),
			);
		} else {
			updatePromises.push(
				db
					.update(postTargets)
					.set({ error: val.error })
					.where(eq(postTargets.id, val.targetId)),
			);
		}
	}

	// Published targets with no platformPostId (skipped above) were never really live —
	// safe to flip to "draft".
	for (const target of publishedTargets) {
		if (!processedTargetIds.has(target.id)) {
			anySuccessfullyRemoved = true;
			hasLocalUnpublishEffect = true;
			updatePromises.push(
				db
					.update(postTargets)
					.set({ status: "draft", error: null })
					.where(eq(postTargets.id, target.id)),
			);
		}
	}

	await Promise.all(updatePromises);
	if (hasLocalUnpublishEffect || anySuccessfullyRemoved) {
		unpublishMutation.markCommitted();
	}
	unpublishMutation.finalize();

	// Re-fetch all targets and derive the post status from the ACTUAL outcome rather
	// than hardcoding "draft". If any target is still "published" (a subset was filtered
	// out by `platforms`, or a deletion failed), the post is "partial" so it stays
	// retryable and downstream guards behave. Only flip to "draft" when every previously
	// published target was successfully removed.
	const allTargets = await db
		.select()
		.from(postTargets)
		.where(eq(postTargets.postId, id));

	const anyStillPublished = allTargets.some((t) => t.status === "published");
	const finalPostStatus: "draft" | "partial" | string = anyStillPublished
		? "partial"
		: anySuccessfullyRemoved
			? "draft"
			: // nothing was removed and nothing remains published — preserve prior status
				post.status;

	await db
		.update(posts)
		.set({
			status: finalPostStatus as "draft",
			revision: sql`${posts.revision} + 1`,
			updatedAt: new Date(),
		})
		.where(eq(posts.id, id));

	c.executionCtx.waitUntil(
		notifyRealtime(c.env, orgId, {
			type: "post.updated",
			post_id: id,
			status: finalPostStatus,
		}),
	);
	return c.json(
		{
			id: post.id,
			status: finalPostStatus,
			content: post.content,
			scheduled_at: post.scheduledAt?.toISOString() ?? null,
			// Per-target deletion errors are surfaced inside `targets` (buildTargetResponse
			// includes each target's status + error); failed-deletion targets remain
			// "published" with their error recorded, and the top-level status is "partial"
			// when any target is still live, accurately reflecting the mixed outcome.
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

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getPostLogs, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	// Run the ownership probe and the child query concurrently — the child query is
	// independent of the ownership result (which only gates the 404), so serializing
	// them doubles the DB latency. We discard the child rows when the post is absent.
	const [[post], targets] = await Promise.all([
		db
			.select({ id: posts.id, workspaceId: posts.workspaceId })
			.from(posts)
			.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
			.limit(1),
		db
			.select()
			.from(postTargets)
			.where(eq(postTargets.postId, id))
			.orderBy(desc(postTargets.updatedAt)),
	]);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	// Enforce workspace scope so a workspace-scoped key cannot read logs of a post in
	// another workspace of the same org.
	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) return denied;

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
	const db = c.get("db");

	let videoId: string;
	let accountId: string;

	if (id === "_") {
		// Direct mode: video_id + account_id required
		if (!body.video_id || !body.account_id) {
			markMutationInputNotApplied(c);
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
			markMutationInputNotApplied(c);
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
		.select({
			id: socialAccounts.id,
			accessToken: socialAccounts.accessToken,
			workspaceId: socialAccounts.workspaceId,
		})
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
		markMutationInputNotApplied(c);
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
	if (denied) {
		markMutationInputNotApplied(c);
		return denied;
	}

	const token = await decryptAccountToken(
		account.accessToken,
		c.env.ENCRYPTION_KEY,
		account.id,
		"access_token",
	);
	if (!token) {
		markMutationInputNotApplied(c);
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

	// Fetch current video data from YouTube
	const listRes = await fetch(
		`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${videoId}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);

	if (!listRes.ok) {
		markMutationInputNotApplied(c);
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

	const listData = (await readProviderJson(listRes)) as {
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
		markMutationInputNotApplied(c);
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
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "BAD_REQUEST",
					message:
						"No fields to update. Provide at least one of: title, description, tags, visibility, category_id, made_for_kids, playlist_id.",
				},
			},
			400,
		);
	}

	let providerMutationCommitted = false;
	// Call YouTube Data API v3 videos.update (only if metadata fields changed).
	// The boundary records the provider response before later parsing/error
	// projection can obscure whether YouTube accepted the mutation.
	if (updatedFields.length > 0) {
		const updateRes = await trackSingleUnitProviderMutation(
			c.get("mutationEffectTracker"),
			"youtube.video.metadata.update",
			() =>
				fetch(
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
				),
		);

		if (!updateRes.ok) {
			const errText = await readProviderText(updateRes).catch(
				() => "Unknown error",
			);
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
		providerMutationCommitted = true;
	}

	// Add to playlist if requested
	if (body.playlist_id) {
		const tracker = c.get("mutationEffectTracker");
		const attempt = tracker?.begin("youtube.playlist.item.create");
		try {
			await addToPlaylist({ access_token: token }, body.playlist_id, videoId);
			attempt?.committed();
			tracker?.setAuthoritativeOutcome({ kind: "committed", units: 1 });
			providerMutationCommitted = true;
			updatedFields.push("playlist_id");
		} catch (err) {
			const statusCode =
				typeof err === "object" &&
				err !== null &&
				"statusCode" in err &&
				typeof err.statusCode === "number"
					? err.statusCode
					: null;
			const definitive =
				statusCode !== null &&
				isDefinitiveProviderMutationRejection(statusCode);
			if (definitive) attempt?.notApplied();
			else attempt?.unknown();
			if (!providerMutationCommitted) {
				tracker?.setAuthoritativeOutcome(
					definitive ? { kind: "not_applied" } : { kind: "unknown" },
				);
			}
			return c.json(
				{
					error: {
						code: "YOUTUBE_API_ERROR",
						message:
							err instanceof Error
								? err.message
								: "Failed to add video to playlist.",
					},
				},
				502 as never,
			);
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
	middleware: multipartMutationInputPreflight,
	request: {
		query: z.object({
			dry_run: z
				.string()
				.optional()
				.describe('Set to "true" to validate without creating posts'),
			workspace_id: z
				.string()
				.optional()
				.describe(
					"Workspace ID for every CSV row. Omission lets each row inherit its sole target-account workspace in either policy mode.",
				),
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
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Workspace not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(bulkCsvUpload, async (c) => {
	const orgId = c.get("orgId");
	const { dry_run, workspace_id } = c.req.valid("query");
	const dryRun = dry_run === "true";
	const db = c.get("db");
	const wsScope = c.get("workspaceScope");

	// --- Parse multipart form ---
	let formData: FormData;
	try {
		formData = await c.req.formData();
	} catch {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "BAD_REQUEST",
					message: "Request must be multipart/form-data with a 'file' field.",
				},
			},
			400,
		);
	}

	const file = formData.get("file");
	if (!file || !(file instanceof File)) {
		markMutationInputNotApplied(c);
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
		markMutationInputNotApplied(c);
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
		markMutationInputNotApplied(c);
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
		markMutationInputNotApplied(c);
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
		markMutationInputNotApplied(c);
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
	const firstRow = rows[0];
	if (!firstRow || !("targets" in firstRow) || !("scheduled_at" in firstRow)) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "BAD_REQUEST",
					message: "CSV must have 'targets' and 'scheduled_at' columns.",
				},
			},
			400,
		);
	}
	// Build one request-wide readiness snapshot before the row loop. Invalid JSON
	// remains a normal per-row validation error; valid nested target options are
	// included so a Relay URL cannot bypass the media column policy.
	const csvRelayMediaPolicy = await loadRelayMediaPolicy(
		db,
		orgId,
		rows.map((row) => {
			const mediaUrls = (row.media_urls ?? "")
				.split(";")
				.map((url) => url.trim())
				.filter(Boolean)
				.map((url) => ({ url }));
			let targetOptions: unknown;
			try {
				targetOptions = row.target_options
					? JSON.parse(row.target_options)
					: undefined;
			} catch {
				targetOptions = undefined;
			}
			return mediaPolicyInput({
				media: mediaUrls,
				target_options: targetOptions,
			});
		}),
		mediaPublicHost(c.env),
		c.get("workspaceScope"),
	);

	// Pre-fetch org accounts once, filtered by workspace scope
	const csvPrefetchConditions = [eq(socialAccounts.organizationId, orgId)];
	applyWorkspaceScope(c, csvPrefetchConditions, socialAccounts.workspaceId);
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

	for (const [i, row] of rows.entries()) {
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
							message: "Invalid JSON in 'target_options' column.",
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
			const mediaViolation = violationForPostInput(csvRelayMediaPolicy, item);
			if (mediaViolation) {
				results.push({
					row: rowNum,
					status: "error",
					error: mediaPolicyError(mediaViolation).error,
				});
				failed++;
				continue;
			}

			// Resolve targets
			const targetResolution = await resolveTargets(
				db,
				orgId,
				item.targets,
				wsScope,
				orgAccounts,
				workspace_id ?? null,
			);
			const rowScope = await inheritOperationalCreateScope(
				c,
				workspace_id,
				targetResolution.workspaceIds,
				"post",
			);
			if (!rowScope.ok) {
				results.push({
					row: rowNum,
					status: "error",
					error: await bulkItemErrorFromResponse(rowScope.response),
				});
				failed++;
				continue;
			}
			const resolvedWorkspaceId = rowScope.workspaceId;
			const { resolved, failed: failedTargets } = targetResolution;

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
					db,
					workspaceScope: c.get("workspaceScope"),
					workspaceId: resolvedWorkspaceId,
					accountId: resolved[0]?.accounts[0]?.id,
					after: new Date(),
					strategy: "smart",
					excludeTimes: csvAutoScheduledTimes,
				});
				if (!slot) {
					results.push({
						row: rowNum,
						status: "error",
						error: {
							code: "NO_SLOT_AVAILABLE",
							message: "No available slot for auto-scheduling.",
						},
					});
					failed++;
					continue;
				}
				parsedScheduledAt = new Date(slot.slot_at);
				csvAutoScheduledTimes.push(parsedScheduledAt);
			} else {
				parsedScheduledAt = resolveScheduledAt(
					item.scheduled_at,
					item.timezone,
				);
			}

			const postStatus: "draft" | "scheduled" | "publishing" = isDraft
				? "draft"
				: isNow
					? "publishing"
					: "scheduled";

			const platformOverrides: Record<string, unknown> = {
				...(item.target_options ?? {}),
				...(item.media && item.media.length > 0 ? { _media: item.media } : {}),
			};

			const post = await db.transaction(async (tx) => {
				const insertedRows = await tx
					.insert(posts)
					.values({
						organizationId: orgId,
						workspaceId: resolvedWorkspaceId,
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
				const txPost = insertedRows[0];
				if (!txPost) throw new Error("Failed to insert CSV post");

				const targetValues = resolved.flatMap((target) =>
					target.accounts.map((account) => ({
						organizationId: orgId,
						scopeKey: workspaceScopeKey(txPost.workspaceId),
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
				if (isNow && targetValues.length > 0) {
					await tx.insert(publishOutbox).values(
						publishOutboxRow({
							organizationId: orgId,
							postId: txPost.id,
						}),
					);
				}
				return txPost;
			});

			// Publish immediately if requested: enqueue to PUBLISH_QUEUE instead of
			// publishing inline. The CSV endpoint accepts up to 500 rows; inline serial
			// publishing (8-30s+ per row, minutes for video) would blow the request budget.
			// The post + targets are persisted as "publishing"; the consumer publishes and
			// re-extracts media from platformOverrides._media.
			if (isNow && resolved.length > 0) {
				c.executionCtx.waitUntil(dispatchPublishOutbox(c.env));
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
					message: err instanceof Error ? err.message : "Unknown error",
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

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getRecyclingConfig, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	// Ownership probe and child query run concurrently (child is independent of the 404).
	const [[post], [config]] = await Promise.all([
		db
			.select({ id: posts.id, workspaceId: posts.workspaceId })
			.from(posts)
			.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
			.limit(1),
		db
			.select()
			.from(postRecyclingConfigs)
			.where(eq(postRecyclingConfigs.sourcePostId, id))
			.limit(1),
	]);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) return denied;

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
	const db = c.get("db");

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

	// Probe ownership and existing config concurrently (config is independent of 404).
	const [[post], [existingConfig]] = await Promise.all([
		db
			.select({
				id: posts.id,
				status: posts.status,
				workspaceId: posts.workspaceId,
			})
			.from(posts)
			.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
			.limit(1),
		db
			.select({ id: postRecyclingConfigs.id })
			.from(postRecyclingConfigs)
			.where(eq(postRecyclingConfigs.sourcePostId, id))
			.limit(1),
	]);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) return denied;

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
				expireDate: body.expire_date ? new Date(body.expire_date) : null,
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
				expireDate: body.expire_date ? new Date(body.expire_date) : null,
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
			...(validation.warnings ? { warnings: validation.warnings } : {}),
		},
		200,
	);
});

app.openapi(deleteRecyclingConfig, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [post] = await db
		.select({ id: posts.id, workspaceId: posts.workspaceId })
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) return denied;

	await db
		.delete(postRecyclingConfigs)
		.where(
			and(
				eq(postRecyclingConfigs.sourcePostId, id),
				eq(postRecyclingConfigs.organizationId, orgId),
			),
		)
		.returning({ id: postRecyclingConfigs.id });

	return c.body(null, 204);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(listRecycledCopies, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { limit } = c.req.valid("query");
	const db = c.get("db");

	// Ownership probe and child query run concurrently (child is org-scoped, so parallel
	// execution leaks nothing; the probe only gates the 404).
	const [[post], copies] = await Promise.all([
		db
			.select({ id: posts.id, workspaceId: posts.workspaceId })
			.from(posts)
			.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
			.limit(1),
		db
			.select()
			.from(posts)
			.where(and(eq(posts.recycledFromId, id), eq(posts.organizationId, orgId)))
			.orderBy(desc(posts.createdAt))
			.limit(limit + 1),
	]);

	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) return denied;

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

// --- Post Tags ---

const listPostTags = createRoute({
	operationId: "listPostTags",
	method: "get",
	path: "/{id}/tags",
	tags: ["Posts"],
	summary: "List tags attached to a post",
	security: [{ Bearer: [] }],
	request: { params: IdParam, query: PostTagListQuery },
	responses: {
		200: {
			description: "Attached tags",
			content: { "application/json": { schema: PostTagListResponse } },
		},
		400: {
			description: "Invalid cursor",
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

app.openapi(listPostTags, async (c) => {
	const organizationId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { cursor, limit } = c.req.valid("query");
	const db = c.get("db");
	let decodedCursor: TimestampIdCursor | null = null;
	if (cursor) {
		try {
			decodedCursor = decodeTimestampIdCursor(cursor);
		} catch {
			return c.json(INVALID_CURSOR_BODY, 400);
		}
	}

	const [post] = await db
		.select({ id: posts.id, workspaceId: posts.workspaceId })
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, organizationId)))
		.limit(1);
	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}
	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) return denied as never;

	const conditions = [
		eq(postTags.organizationId, organizationId),
		eq(postTags.postId, id),
	];
	if (decodedCursor) {
		conditions.push(
			sql`(${tags.createdAt}, ${tags.id})
				< (${decodedCursor.timestamp}::timestamptz, ${decodedCursor.id})`,
		);
	}
	const rows = await db
		.select({
			tag: tags,
			cursorTimestamp: sql<string>`to_char(${tags.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(postTags)
		.innerJoin(
			tags,
			and(
				eq(tags.id, postTags.tagId),
				eq(tags.organizationId, postTags.organizationId),
				eq(tags.scopeKey, postTags.tagScopeKey),
			),
		)
		.where(and(...conditions))
		.orderBy(desc(tags.createdAt), desc(tags.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return c.json(
		{
			data: page.map(({ tag }) => serializePostTag(tag)),
			next_cursor:
				hasMore && last
					? encodeTimestampIdCursor(last.cursorTimestamp, last.tag.id)
					: null,
			has_more: hasMore,
		},
		200,
	);
});

const attachPostTag = createRoute({
	operationId: "attachPostTag",
	method: "put",
	path: "/{id}/tags/{tag_id}",
	tags: ["Posts"],
	summary: "Attach a tag to a post",
	description:
		"Idempotently attaches an organization-shared tag or a tag from the post's exact workspace.",
	security: [{ Bearer: [] }],
	request: { params: PostTagParams },
	responses: {
		200: {
			description: "Attached tag",
			content: { "application/json": { schema: TagResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Post or visible tag not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(attachPostTag, async (c) => {
	const organizationId = c.get("orgId");
	const { id, tag_id } = c.req.valid("param");
	const db = c.get("db");
	const [[post], [tag]] = await Promise.all([
		db
			.select({
				id: posts.id,
				workspaceId: posts.workspaceId,
				scopeKey: posts.scopeKey,
			})
			.from(posts)
			.where(and(eq(posts.id, id), eq(posts.organizationId, organizationId)))
			.limit(1),
		db
			.select()
			.from(tags)
			.where(and(eq(tags.id, tag_id), eq(tags.organizationId, organizationId)))
			.limit(1),
	]);
	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}
	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) return denied as never;
	if (
		!tag ||
		(tag.scopeKey !== ORGANIZATION_SCOPE_KEY && tag.scopeKey !== post.scopeKey)
	) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Tag not found in the post scope",
				},
			},
			404,
		);
	}

	await db
		.insert(postTags)
		.values({
			organizationId,
			postId: post.id,
			scopeKey: post.scopeKey,
			tagId: tag.id,
			tagScopeKey: tag.scopeKey,
		})
		.onConflictDoNothing({
			target: [postTags.organizationId, postTags.tagId, postTags.postId],
		})
		.returning({ postId: postTags.postId });
	return c.json(serializePostTag(tag), 200);
});

const detachPostTag = createRoute({
	operationId: "detachPostTag",
	method: "delete",
	path: "/{id}/tags/{tag_id}",
	tags: ["Posts"],
	summary: "Detach a tag from a post",
	security: [{ Bearer: [] }],
	request: { params: PostTagParams },
	responses: {
		204: { description: "Tag detached" },
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

app.openapi(detachPostTag, async (c) => {
	const organizationId = c.get("orgId");
	const { id, tag_id } = c.req.valid("param");
	const db = c.get("db");
	const [post] = await db
		.select({ id: posts.id, workspaceId: posts.workspaceId })
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, organizationId)))
		.limit(1);
	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}
	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) return denied as never;

	await db
		.delete(postTags)
		.where(
			and(
				eq(postTags.organizationId, organizationId),
				eq(postTags.postId, id),
				eq(postTags.tagId, tag_id),
			),
		)
		.returning({ postId: postTags.postId });
	return c.body(null, 204);
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
			content: {
				"application/json": {
					schema: z.object({ notes: z.string().nullable() }),
				},
			},
		},
		404: {
			description: "Post not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
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
			content: {
				"application/json": { schema: z.object({ notes: z.string() }) },
			},
		},
	},
	responses: {
		200: {
			description: "Updated notes",
			content: {
				"application/json": {
					schema: z.object({ notes: z.string().nullable() }),
				},
			},
		},
		404: {
			description: "Post not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getPostNotes, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	// Try internal posts first
	const [post] = await db
		.select({ notes: posts.notes, workspaceId: posts.workspaceId })
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (post) {
		const denied = assertWorkspaceScope(c, post.workspaceId);
		if (denied) return denied;
		return c.json({ notes: post.notes ?? null }, 200);
	}

	// Fall back to external posts
	const [ext] = await db
		.select({
			notes: externalPosts.notes,
			workspaceId: externalPosts.workspaceId,
		})
		.from(externalPosts)
		.where(
			and(eq(externalPosts.id, id), eq(externalPosts.organizationId, orgId)),
		)
		.limit(1);

	if (ext) {
		const denied = assertWorkspaceScope(c, ext.workspaceId);
		if (denied) return denied;
		return c.json({ notes: ext.notes ?? null }, 200);
	}

	return c.json(
		{ error: { code: "NOT_FOUND", message: "Post not found" } },
		404,
	);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(updatePostNotes, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { notes } = c.req.valid("json");
	const db = c.get("db");

	// Try internal posts first
	const [post] = await db
		.select({ id: posts.id, workspaceId: posts.workspaceId })
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (post) {
		const denied = assertWorkspaceScope(c, post.workspaceId);
		if (denied) return denied;
		await db
			.update(posts)
			.set({
				notes,
				revision: sql`${posts.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(eq(posts.id, id));
		return c.json({ notes }, 200);
	}

	// Fall back to external posts
	const [ext] = await db
		.select({ id: externalPosts.id, workspaceId: externalPosts.workspaceId })
		.from(externalPosts)
		.where(
			and(eq(externalPosts.id, id), eq(externalPosts.organizationId, orgId)),
		)
		.limit(1);

	if (ext) {
		const denied = assertWorkspaceScope(c, ext.workspaceId);
		if (denied) return denied;
		await db
			.update(externalPosts)
			.set({ notes, updatedAt: new Date() })
			.where(eq(externalPosts.id, id));
		return c.json({ notes }, 200);
	}

	return c.json(
		{ error: { code: "NOT_FOUND", message: "Post not found" } },
		404,
	);
});

export default app;
