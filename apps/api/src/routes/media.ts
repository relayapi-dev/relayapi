import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { type Database, generateId, media, posts } from "@relayapi/db";
import type { AwsClient } from "aws4fetch";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { mediaPublicHost } from "../lib/deployment-mode";
import {
	createBoundedReadableBody,
	parseContentLength,
	ResponseTooLargeError,
} from "../lib/fetch-public-url";
import {
	isAllowedMediaMimeType,
	MAX_MEDIA_UPLOAD_BYTES,
	normalizeMediaMimeType,
	validateStoredMediaObject,
} from "../lib/media-storage-policy";
import {
	getCachedR2Client,
	presignR2Url,
	presignRelayMediaUrls,
} from "../lib/r2-presign";
import { relayMediaReferenceFromUrl } from "../lib/relay-media-policy";
import { resolveOperationalCreateScope } from "../lib/request-access";
import { thumbnailKeyFor } from "../lib/thumbnails";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
} from "../lib/workspace-scope";
import { ErrorResponse, FilterParams, IdParam } from "../schemas/common";
import {
	MediaListResponse,
	MediaPresignRequest,
	MediaPresignResponse,
	MediaResponse,
	MediaUploadResponse,
} from "../schemas/media";
import {
	processMediaDeletion,
	retireRejectedMediaUpload,
} from "../services/media-reliability";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const PRESIGN_GET_EXPIRES = 3600; // 1 hour

export { MAX_MEDIA_UPLOAD_BYTES } from "../lib/media-storage-policy";

function requireR2Client(env: Env): AwsClient {
	const client = getCachedR2Client(env);
	if (!client) {
		throw new Error(
			"R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and CF_ACCOUNT_ID must be set",
		);
	}
	return client;
}

type MediaReadSource = {
	organizationId: string;
	status: string;
	storageKey: string;
	url: string | null;
	thumbnailUrl: string | null;
	originalDeletedAt: Date | null;
	deletionRequestedAt: Date | null;
};

/**
 * Never mint a fresh URL unless the current DB row is ready and available. The
 * batch policy query also prevents historical or URL-derived keys from being
 * signed merely because they share the tenant prefix.
 */
async function getMediaReadUrls(
	db: Database,
	env: Env,
	records: MediaReadSource[],
): Promise<Array<string | null>> {
	if (records.length === 0) return [];
	const organizationId = records[0]?.organizationId;
	if (!organizationId) return records.map(() => null);
	const candidates = records.map((record) => ({
		url:
			record.status === "ready" &&
			!record.deletionRequestedAt &&
			!record.originalDeletedAt &&
			record.url
				? record.url
				: record.thumbnailUrl,
	}));
	const resolved =
		(await presignRelayMediaUrls(
			db,
			env,
			candidates,
			PRESIGN_GET_EXPIRES,
			organizationId,
		)) ?? candidates;
	return resolved.map((item, index) => {
		if (!item.url) return null;
		// An unchanged canonical URL means the row failed the DB readiness policy
		// or signing is unavailable. Do not expose it as if it were fetchable.
		return relayMediaReferenceFromUrl(item.url, mediaPublicHost(env))
			? (records[index]?.thumbnailUrl ?? null)
			: item.url;
	});
}

export async function getMediaReadUrl(
	db: Database,
	env: Env,
	record: MediaReadSource,
): Promise<string | null> {
	return (await getMediaReadUrls(db, env, [record]))[0] ?? null;
}

// --- Route definitions ---

const listMedia = createRoute({
	operationId: "listMedia",
	method: "get",
	path: "/",
	tags: ["Media"],
	summary: "List media files",
	security: [{ Bearer: [] }],
	request: { query: FilterParams },
	responses: {
		200: {
			description: "List of media files",
			content: { "application/json": { schema: MediaListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const uploadMedia = createRoute({
	operationId: "uploadMedia",
	method: "post",
	path: "/upload",
	tags: ["Media"],
	summary: "Upload a file",
	description:
		"Upload a raw file body. Pass the filename as a query parameter and set Content-Type to one of the documented media types. Generic application/octet-stream bodies are rejected.",
	security: [{ Bearer: [] }],
	request: {
		query: z.object({
			filename: z.string().describe("Original filename"),
			workspace_id: z
				.string()
				.optional()
				.describe("Workspace ID for the media record"),
		}),
		body: {
			content: {
				"image/jpeg": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"image/png": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"image/gif": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"image/webp": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"image/heic": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"image/heif": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"image/avif": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"video/mp4": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"video/webm": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"video/quicktime": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"video/mpeg": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"audio/mpeg": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"audio/mp4": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"audio/webm": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"audio/wav": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"audio/ogg": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
				"application/pdf": {
					schema: z.string().openapi({ type: "string", format: "binary" }),
				},
			},
			required: true,
			description: "Raw file bytes",
		},
	},
	responses: {
		201: {
			description: "File uploaded",
			content: { "application/json": { schema: MediaUploadResponse } },
		},
		400: {
			description: "Bad request",
			content: { "application/json": { schema: ErrorResponse } },
		},
		413: {
			description: "File exceeds the upload size limit",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const presignMedia = createRoute({
	operationId: "presignMedia",
	method: "post",
	path: "/presign",
	tags: ["Media"],
	summary: "Get a pre-signed upload URL",
	description:
		"Create a pending media upload intent and generate a create-only pre-signed R2 PUT URL. Send every header in upload_headers exactly as returned, including Content-Type and If-None-Match, then call POST /v1/media/confirm; confirmation is mandatory before using the canonical media URL.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: MediaPresignRequest } },
		},
	},
	responses: {
		200: {
			description: "Pre-signed URL generated",
			content: { "application/json": { schema: MediaPresignResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getMedia = createRoute({
	operationId: "getMedia",
	method: "get",
	path: "/{id}",
	tags: ["Media"],
	summary: "Get media details",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Media details",
			content: { "application/json": { schema: MediaResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteMedia = createRoute({
	operationId: "deleteMedia",
	method: "delete",
	path: "/{id}",
	tags: ["Media"],
	summary: "Delete media",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Media deleted" },
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Media is still referenced by an active post",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const confirmMedia = createRoute({
	operationId: "confirmMedia",
	method: "post",
	path: "/confirm",
	tags: ["Media"],
	summary: "Confirm a presigned upload completed",
	description:
		"Mandatory final step for a presigned upload. Verifies the stored object and marks the pending media intent ready.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": {
					schema: z.object({
						storage_key: z
							.string()
							.describe(
								"The path portion of the canonical url returned by POST /v1/media/presign, without the leading slash",
							),
					}),
				},
			},
		},
	},
	responses: {
		200: {
			description: "Upload confirmed",
			content: { "application/json": { schema: MediaResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Media not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Route handlers ---

app.openapi(listMedia, async (c) => {
	const orgId = c.get("orgId");
	const { limit, workspace_id, cursor } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [
		eq(media.organizationId, orgId),
		eq(media.status, "ready"),
	];
	applyWorkspaceScope(c, conditions, media.workspaceId);
	if (workspace_id) {
		// Show workspace-specific + shared org-level media
		const workspaceCondition = or(
			eq(media.workspaceId, workspace_id),
			isNull(media.workspaceId),
		);
		if (workspaceCondition) {
			conditions.push(workspaceCondition);
		}
	}
	// Composite keyset on (created_at, id) — the full sort key. The cursor is the
	// id of the last item from the previous page; we read that row's created_at
	// as text (avoiding the JS-Date microsecond truncation that would skip rows)
	// and bind it back with an explicit ::timestamptz cast. A plain created_at
	// keyset would drop rows that share a created_at across the page boundary.
	if (cursor) {
		const [cursorRow] = await db
			.select({ createdAt: sql<string>`${media.createdAt}::text` })
			.from(media)
			.where(eq(media.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${media.createdAt}, ${media.id}) < (${cursorRow.createdAt}::timestamptz, ${cursor})`,
			);
		}
	}

	const records = await db
		.select({
			id: media.id,
			organizationId: media.organizationId,
			status: media.status,
			storageKey: media.storageKey,
			url: media.url,
			thumbnailUrl: media.thumbnailUrl,
			originalDeletedAt: media.originalDeletedAt,
			deletionRequestedAt: media.deletionRequestedAt,
			filename: media.filename,
			mimeType: media.mimeType,
			size: media.size,
			width: media.width,
			height: media.height,
			duration: media.duration,
			createdAt: media.createdAt,
		})
		.from(media)
		.where(and(...conditions))
		.orderBy(desc(media.createdAt), desc(media.id))
		.limit(limit + 1);

	const hasMore = records.length > limit;
	const data = records.slice(0, limit);

	const urls = await getMediaReadUrls(db, c.env, data);

	return c.json(
		{
			data: data.map((r, i) => ({
				id: r.id,
				url: urls[i] ?? null,
				filename: r.filename,
				mime_type: r.mimeType,
				size: r.size,
				width: r.width ?? null,
				height: r.height ?? null,
				duration: r.duration ?? null,
				created_at: r.createdAt.toISOString(),
			})),
			next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

app.openapi(uploadMedia, async (c) => {
	const orgId = c.get("orgId");
	const { filename, workspace_id } = c.req.valid("query");
	const scope = await resolveOperationalCreateScope(c, workspace_id, "media");
	if (!scope.ok) return scope.response as never;
	const contentType =
		c.req.header("content-type") ?? "application/octet-stream";
	const normalizedContentType = normalizeMediaMimeType(contentType);

	// SECURITY: Validate MIME type against allowlist to prevent stored XSS
	if (!isAllowedMediaMimeType(contentType)) {
		return c.json(
			{
				error: {
					code: "INVALID_CONTENT_TYPE",
					message: `Content type '${contentType}' is not allowed. Supported types: images, videos, audio, and PDF.`,
				},
			} as never,
			400 as never,
		);
	}

	// Reject a declared oversized body before touching R2 or the database. The
	// counting stream below independently enforces the same bound when the
	// header is absent, zero, malformed, or dishonest.
	const contentLength = parseContentLength(c.req.raw.headers);
	if (contentLength !== null && contentLength > MAX_MEDIA_UPLOAD_BYTES) {
		void c.req.raw.body?.cancel().catch(() => {});
		return c.json(
			{
				error: {
					code: "FILE_TOO_LARGE",
					message: `Max upload size is ${MAX_MEDIA_UPLOAD_BYTES / 1024 / 1024}MB`,
				},
			} as never,
			413 as never,
		);
	}

	const requestBody = c.req.raw.body;
	if (!requestBody) {
		return c.json(
			{ error: { code: "BAD_REQUEST", message: "Request body is empty" } },
			400,
		);
	}
	const boundedBody = createBoundedReadableBody(
		requestBody,
		MAX_MEDIA_UPLOAD_BYTES,
		contentLength,
	);

	// Sanitize filename: strip path separators, traversal sequences, and XSS-relevant chars.
	// Also replace %, #, ? — these survive the storage key but break the canonical-URL
	// round-trip (new URL() + decodeURIComponent) used to re-derive the key at presign/
	// publish time, producing dead media URLs.
	const safeFilename = filename
		.replace(/[/\\]/g, "_")
		.replace(/\.\./g, "_")
		.replace(/\0/g, "")
		.replace(/[<>"'&]/g, "_")
		.replace(/[%#?]/g, "_");
	const storageKey = `${orgId}/media/${generateId("file_")}/${safeFilename}`;
	const url = `https://${mediaPublicHost(c.env)}/${storageKey}`;
	const db = c.get("db");
	const mediaId = generateId("med_");

	// Persist the upload intent before R2 sees the object. An object-create event
	// can therefore always find the row, and a Worker crash after the PUT leaves
	// an `uploading` row that the scheduled reconciler can repair.
	await db.insert(media).values({
		id: mediaId,
		organizationId: orgId,
		workspaceId: scope.workspaceId,
		filename: safeFilename,
		mimeType: normalizedContentType,
		size: contentLength ?? 0,
		storageKey,
		url,
		status: "uploading",
	});

	let size = 0;
	let streamFailure: unknown;
	void boundedBody.bytesRead.catch((error) => {
		streamFailure = error;
	});
	try {
		await c.env.MEDIA_BUCKET.put(storageKey, boundedBody.body, {
			httpMetadata: { contentType },
			customMetadata: { orgId, filename: safeFilename },
		});
		size = await boundedBody.bytesRead;
	} catch (error) {
		// Keep the durable intent for the scheduled reconciler, but distinguish a
		// failed stream from an object that may have completed before a lost reply.
		await db
			.update(media)
			.set({ status: "upload_failed" })
			.where(eq(media.id, mediaId));
		await Promise.resolve();
		if (
			error instanceof ResponseTooLargeError ||
			streamFailure instanceof ResponseTooLargeError
		) {
			return c.json(
				{
					error: {
						code: "FILE_TOO_LARGE",
						message: `Max upload size is ${MAX_MEDIA_UPLOAD_BYTES / 1024 / 1024}MB`,
					},
				} as never,
				413 as never,
			);
		}
		throw error;
	}

	if (size === 0) {
		await Promise.all([
			c.env.MEDIA_BUCKET.delete(storageKey),
			db
				.update(media)
				.set({ status: "upload_failed" })
				.where(eq(media.id, mediaId)),
		]);
		return c.json(
			{ error: { code: "BAD_REQUEST", message: "Request body is empty" } },
			400,
		);
	}

	// If this write fails, do not delete the accepted object. The R2 event or
	// scheduled reconciler will observe the durable row and complete it.
	await db
		.update(media)
		.set({ status: "ready", size })
		.where(eq(media.id, mediaId));

	return c.json(
		{
			url,
			type: contentType,
			size,
			filename,
		},
		201,
	);
});

// Presigned URL generation using the S3-compatible API.
// Docs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
// Section: "Generate presigned URLs" → JavaScript example
// Requires R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and CF_ACCOUNT_ID env vars.
// These are R2 API tokens created in the Cloudflare Dashboard:
//   R2 > Account Details > Manage API Tokens
// IMPORTANT: Presigned URLs only work with the S3 API domain
//   (https://<ACCOUNT_ID>.r2.cloudflarestorage.com), NOT custom domains.
// Docs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/#presigned-urls-with-other-domains
// @ts-expect-error — Hono strict return types; handler returns valid response or error
app.openapi(presignMedia, async (c) => {
	const orgId = c.get("orgId");
	const { filename, content_type, workspace_id } = c.req.valid("json");
	const normalizedContentType = normalizeMediaMimeType(content_type);
	const scope = await resolveOperationalCreateScope(c, workspace_id, "media");
	if (!scope.ok) return scope.response as never;

	// SECURITY: Validate MIME type against allowlist to prevent stored XSS
	if (!isAllowedMediaMimeType(content_type)) {
		return c.json(
			{
				error: {
					code: "INVALID_CONTENT_TYPE",
					message: `Content type '${content_type}' is not allowed. Supported types: images, videos, audio, and PDF.`,
				},
			} as never,
			400 as never,
		);
	}

	const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID } = c.env;
	if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !CF_ACCOUNT_ID) {
		return c.json(
			{
				error: {
					code: "NOT_CONFIGURED",
					message:
						"Media presigned uploads are not configured. Use the direct upload endpoint instead.",
				},
			},
			400,
		);
	}

	// Replace %, #, ? in addition to path separators / traversal / NUL: these survive
	// into the storage key but break the canonical-URL round-trip (new URL() +
	// decodeURIComponent) used to re-derive the key at presign/publish time.
	const safeFilename = filename
		.replace(/[/\\]/g, "_")
		.replace(/\.\./g, "_")
		.replace(/\0/g, "")
		.replace(/[%#?]/g, "_");
	const storageKey = `${orgId}/media/${generateId("file_")}/${safeFilename}`;
	const expiresIn = 3600; // 1 hour

	const client = requireR2Client(c.env);

	const uploadUrl = await presignR2Url(
		c.env,
		client,
		storageKey,
		"PUT",
		expiresIn,
		normalizedContentType,
	);

	const url = `https://${mediaPublicHost(c.env)}/${storageKey}`;

	// Create a pending DB record so the file is tracked before upload
	const db = c.get("db");
	const [pendingMedia] = await db
		.insert(media)
		.values({
			organizationId: orgId,
			workspaceId: scope.workspaceId,
			filename,
			mimeType: normalizedContentType,
			size: 0,
			storageKey,
			url,
			status: "pending",
		})
		.returning({ id: media.id });
	if (!pendingMedia) {
		throw new Error("Failed to persist the media upload intent");
	}

	return c.json(
		{
			id: pendingMedia.id,
			upload_url: uploadUrl,
			upload_headers: {
				"Content-Type": normalizedContentType,
				"If-None-Match": "*" as const,
			},
			url,
			expires_in: expiresIn,
		},
		200,
	);
});

app.openapi(getMedia, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [record] = await db
		.select()
		.from(media)
		.where(and(eq(media.id, id), eq(media.organizationId, orgId)))
		.limit(1);

	if (!record) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Media not found" } },
			404,
		);
	}
	if (record.status === "deleting" || record.status === "deletion_failed") {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Media not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, record.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	if (record.status !== "ready" || record.deletionRequestedAt) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Media not found" } },
			404,
		);
	}

	const url = await getMediaReadUrl(db, c.env, record);

	return c.json(
		{
			id: record.id,
			url,
			filename: record.filename,
			mime_type: record.mimeType,
			size: record.size,
			width: record.width ?? null,
			height: record.height ?? null,
			duration: record.duration ?? null,
			created_at: record.createdAt.toISOString(),
		},
		200,
	);
});

app.openapi(deleteMedia, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [record] = await db
		.select({
			id: media.id,
			storageKey: media.storageKey,
			thumbnailKey: media.thumbnailKey,
			workspaceId: media.workspaceId,
		})
		.from(media)
		.where(and(eq(media.id, id), eq(media.organizationId, orgId)))
		.limit(1);

	if (!record) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Media not found" } },
			404,
		);
	}
	const denied = assertWorkspaceScope(c, record.workspaceId);
	if (denied) return denied;

	// Preserve accepted draft/scheduled/publishing posts: the durable deletion
	// flow must not tombstone media that one of those posts still references.
	const canonicalUrl = `https://${mediaPublicHost(c.env)}/${record.storageKey}`;
	const referencing = await db
		.select({ id: posts.id })
		.from(posts)
		.where(
			and(
				eq(posts.organizationId, orgId),
				inArray(posts.status, ["draft", "scheduled", "publishing"]),
				sql`COALESCE(${posts.platformOverrides}, '{}'::jsonb) @> jsonb_build_object(
					'_media',
					jsonb_build_array(jsonb_build_object('url', ${canonicalUrl}::text))
				)`,
			),
		)
		.limit(1);
	if (referencing.length > 0) {
		return c.json(
			{
				error: {
					code: "MEDIA_IN_USE",
					message:
						"Media is still referenced by an active post. Remove it from the post before deleting.",
				},
			},
			409,
		);
	}

	// Commit the tombstone before either provider boundary. If the Worker dies at
	// any later point, the every-minute reconciler resumes the two idempotent R2
	// deletes. The row is hidden immediately but retained until both keys are gone.
	const now = new Date();
	await db
		.update(media)
		.set({
			status: "deleting",
			url: null,
			thumbnailKey: record.thumbnailKey ?? thumbnailKeyFor(record.storageKey),
			deletionRequestedAt: sql<Date>`COALESCE(${media.deletionRequestedAt}, ${now})`,
			deletionNextRetryAt: now,
			deletionLastError: null,
		})
		.where(and(eq(media.id, id), eq(media.organizationId, orgId)));
	await processMediaDeletion(db, c.env, id, now);

	return c.body(null, 204);
});

app.openapi(confirmMedia, async (c) => {
	const orgId = c.get("orgId");
	const { storage_key } = c.req.valid("json");
	const db = c.get("db");

	// SECURITY: Validate storage key belongs to this org to prevent cross-org R2 oracle
	if (!storage_key.startsWith(`${orgId}/`)) {
		return c.json(
			{
				error: { code: "BAD_REQUEST", message: "Invalid storage key" },
			} as never,
			400 as never,
		);
	}

	// Establish ownership and lifecycle state before touching R2. A tenant prefix
	// alone is not authority to inspect or delete an object.
	const [intent] = await db
		.select()
		.from(media)
		.where(
			and(
				eq(media.storageKey, storage_key),
				eq(media.organizationId, orgId),
				inArray(media.status, ["pending", "ready"]),
				isNull(media.deletionRequestedAt),
			),
		)
		.limit(1);
	if (!intent) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "No pending media record found for this storage key",
				},
			},
			404,
		);
	}

	let record = intent;
	const r2Object = await c.env.MEDIA_BUCKET.head(storage_key);
	if (!r2Object) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Upload not found in storage",
				},
			},
			404,
		);
	}
	const validation = validateStoredMediaObject(r2Object);
	if (!validation.ok) {
		await retireRejectedMediaUpload(db, c.env, intent.id);
		return c.json(
			{
				error: {
					code: validation.code,
					message: validation.message,
				},
			},
			400 as never,
		);
	}

	if (intent.status === "pending") {
		const [updated] = await db
			.update(media)
			.set({
				size: validation.size,
				mimeType: validation.mimeType,
				status: "ready",
			})
			.where(
				and(
					eq(media.id, intent.id),
					eq(media.organizationId, orgId),
					eq(media.status, "pending"),
					isNull(media.deletionRequestedAt),
				),
			)
			.returning();

		// Idempotency: if another confirm won the pending -> ready transition,
		// return that same ready row rather than a misleading failure.
		if (updated) {
			record = updated;
		} else {
			const [existing] = await db
				.select()
				.from(media)
				.where(
					and(
						eq(media.id, intent.id),
						eq(media.organizationId, orgId),
						eq(media.status, "ready"),
						isNull(media.deletionRequestedAt),
					),
				)
				.limit(1);
			if (existing) record = existing;
			else {
				return c.json(
					{
						error: {
							code: "NOT_FOUND",
							message: "Media upload is no longer pending",
						},
					},
					404,
				);
			}
		}
	}

	const viewUrl = await getMediaReadUrl(db, c.env, record);

	return c.json(
		{
			id: record.id,
			url: viewUrl,
			filename: record.filename,
			mime_type: record.mimeType,
			size: record.size,
			width: record.width ?? null,
			height: record.height ?? null,
			duration: record.duration ?? null,
			created_at: record.createdAt.toISOString(),
		},
		200,
	);
});

export default app;
