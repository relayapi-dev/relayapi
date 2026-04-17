import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { generateId, media } from "@relayapi/db";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { type S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ErrorResponse, IdParam, PaginationParams, FilterParams } from "../schemas/common";
import {
	MediaListResponse,
	MediaPresignRequest,
	MediaPresignResponse,
	MediaResponse,
	MediaUploadResponse,
} from "../schemas/media";
import type { Env, Variables } from "../types";
import { applyWorkspaceScope } from "../lib/workspace-scope";
import { getCachedR2Client, RELAY_R2_BUCKET } from "../lib/r2-presign";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const PRESIGN_GET_EXPIRES = 3600; // 1 hour

// SECURITY: Allowed MIME types to prevent stored XSS via SVG/HTML uploads
const ALLOWED_MIME_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/heic",
	"image/heif",
	"image/avif",
	"video/mp4",
	"video/webm",
	"video/quicktime",
	"video/mpeg",
	"audio/mpeg",
	"audio/mp4",
	"audio/wav",
	"audio/ogg",
	"application/pdf",
]);

function requireS3Client(env: Env): S3Client {
	const client = getCachedR2Client(env);
	if (!client) {
		throw new Error("R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and CF_ACCOUNT_ID must be set");
	}
	return client;
}

async function getPresignedViewUrl(s3: S3Client, storageKey: string): Promise<string> {
	return getSignedUrl(
		s3,
		new GetObjectCommand({ Bucket: RELAY_R2_BUCKET, Key: storageKey }),
		{ expiresIn: PRESIGN_GET_EXPIRES },
	);
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
		"Upload a raw file body. Pass the filename as a query parameter and set the Content-Type header.",
	security: [{ Bearer: [] }],
	request: {
		query: z.object({
			filename: z.string().describe("Original filename"),
		}),
		body: {
			content: {
				"application/octet-stream": {
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
		"Generate a pre-signed URL for direct upload to R2. The client can PUT the file to the returned URL.",
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
	},
});

const confirmMedia = createRoute({
	operationId: "confirmMedia",
	method: "post",
	path: "/confirm",
	tags: ["Media"],
	summary: "Confirm a presigned upload completed",
	description:
		"After uploading a file to the presigned URL, call this endpoint to mark the media as ready.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": {
					schema: z.object({
						storage_key: z.string().describe("The storage key from the presign response URL"),
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
	const { limit, workspace_id } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [
		eq(media.organizationId, orgId),
		eq(media.status, "ready"),
	];
	applyWorkspaceScope(c, conditions, media.workspaceId);
	if (workspace_id) {
		// Show workspace-specific + shared org-level media
		conditions.push(or(eq(media.workspaceId, workspace_id), isNull(media.workspaceId))!);
	}

	const records = await db
		.select({
			id: media.id,
			storageKey: media.storageKey,
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
		.orderBy(desc(media.createdAt))
		.limit(limit + 1);

	const hasMore = records.length > limit;
	const data = records.slice(0, limit);

	const s3 = requireS3Client(c.env);
	const urls = await Promise.all(
		data.map((r) => getPresignedViewUrl(s3, r.storageKey)),
	);

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
	const { filename } = c.req.valid("query");
	const contentType =
		c.req.header("content-type") ?? "application/octet-stream";

	// SECURITY: Validate MIME type against allowlist to prevent stored XSS
	if (!ALLOWED_MIME_TYPES.has(contentType.split(";")[0]!.trim().toLowerCase())) {
		return c.json(
			{ error: { code: "INVALID_CONTENT_TYPE", message: `Content type '${contentType}' is not allowed. Supported types: images, videos, audio, and PDF.` } } as never,
			400 as never,
		);
	}

	// SECURITY: Enforce max upload size (50MB) to prevent OOM on Workers
	const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
	const contentLength = parseInt(c.req.header("content-length") ?? "0", 10);
	if (contentLength > MAX_UPLOAD_SIZE) {
		return c.json(
			{ error: { code: "FILE_TOO_LARGE", message: `Max upload size is ${MAX_UPLOAD_SIZE / 1024 / 1024}MB` } } as never,
			400 as never,
		);
	}

	let body: ArrayBuffer | ReadableStream<Uint8Array> | null = c.req.raw.body;
	let size = contentLength;

	if (!body || contentLength <= 0) {
		const bufferedBody = await c.req.arrayBuffer();
		if (!bufferedBody || bufferedBody.byteLength === 0) {
			return c.json(
				{ error: { code: "BAD_REQUEST", message: "Request body is empty" } },
				400,
			);
		}

		if (bufferedBody.byteLength > MAX_UPLOAD_SIZE) {
			return c.json(
				{ error: { code: "FILE_TOO_LARGE", message: `Max upload size is ${MAX_UPLOAD_SIZE / 1024 / 1024}MB` } } as never,
				400 as never,
			);
		}

		body = bufferedBody;
		size = bufferedBody.byteLength;
	}

	// Sanitize filename: strip path separators, traversal sequences, and XSS-relevant chars
	const safeFilename = filename.replace(/[/\\]/g, "_").replace(/\.\./g, "_").replace(/\0/g, "").replace(/[<>"'&]/g, "_");
	const storageKey = `${orgId}/${generateId("file_")}/${safeFilename}`;

	await c.env.MEDIA_BUCKET.put(storageKey, body, {
		httpMetadata: { contentType },
		customMetadata: { orgId, filename: safeFilename },
	});

	const url = `https://media.relayapi.dev/${storageKey}`;

	const db = c.get("db");
	try {
		await db.insert(media).values({
			organizationId: orgId,
			filename: safeFilename,
			mimeType: contentType,
			size,
			storageKey,
			url,
		});
	} catch (err) {
		// Clean up R2 object if the DB write fails to avoid orphaned files
		await c.env.MEDIA_BUCKET.delete(storageKey).catch((deleteErr) =>
			console.error(`Failed to clean up R2 object ${storageKey}:`, deleteErr),
		);
		throw err;
	}

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
	const { filename, content_type } = c.req.valid("json");

	// SECURITY: Validate MIME type against allowlist to prevent stored XSS
	if (!ALLOWED_MIME_TYPES.has(content_type.split(";")[0]!.trim().toLowerCase())) {
		return c.json(
			{ error: { code: "INVALID_CONTENT_TYPE", message: `Content type '${content_type}' is not allowed. Supported types: images, videos, audio, and PDF.` } } as never,
			400 as never,
		);
	}

	const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID } = c.env;
	if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !CF_ACCOUNT_ID) {
		return c.json(
			{ error: { code: "NOT_CONFIGURED", message: "Media presigned uploads are not configured. Use the direct upload endpoint instead." } },
			400,
		);
	}

	const safeFilename = filename.replace(/[/\\]/g, "_").replace(/\.\./g, "_").replace(/\0/g, "");
	const storageKey = `${orgId}/${generateId("file_")}/${safeFilename}`;
	const expiresIn = 3600; // 1 hour

	const s3 = requireS3Client(c.env);

	const uploadUrl = await getSignedUrl(
		s3,
		new PutObjectCommand({
			Bucket: RELAY_R2_BUCKET,
			Key: storageKey,
			ContentType: content_type,
		}),
		{ expiresIn },
	);

	const url = `https://media.relayapi.dev/${storageKey}`;

	// Create a pending DB record so the file is tracked before upload
	const db = c.get("db");
	await db.insert(media).values({
		organizationId: orgId,
		filename,
		mimeType: content_type,
		size: 0,
		storageKey,
		url,
		status: "pending",
	});

	return c.json(
		{
			upload_url: uploadUrl,
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

	const s3 = requireS3Client(c.env);
	const url = await getPresignedViewUrl(s3, record.storageKey);

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
		.select({ id: media.id, storageKey: media.storageKey })
		.from(media)
		.where(and(eq(media.id, id), eq(media.organizationId, orgId)))
		.limit(1);

	if (!record) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Media not found" } },
			404,
		);
	}

	// Delete from R2 + DB in parallel (independent systems)
	await Promise.all([
		c.env.MEDIA_BUCKET.delete(record.storageKey),
		db.delete(media).where(eq(media.id, id)),
	]);

	return c.body(null, 204);
});

app.openapi(confirmMedia, async (c) => {
	const orgId = c.get("orgId");
	const { storage_key } = c.req.valid("json");
	const db = c.get("db");

	// SECURITY: Validate storage key belongs to this org to prevent cross-org R2 oracle
	if (!storage_key.startsWith(`${orgId}/`)) {
		return c.json(
			{ error: { code: "BAD_REQUEST", message: "Invalid storage key" } } as never,
			400 as never,
		);
	}

	// Verify the object exists in R2
	const r2Object = await c.env.MEDIA_BUCKET.head(storage_key);
	if (!r2Object) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Upload not found in storage" } },
			404,
		);
	}

	// SEC-02: Re-verify MIME type at confirm time (presigned uploads can bypass declared type)
	const actualContentType = r2Object.httpMetadata?.contentType;
	if (actualContentType && !ALLOWED_MIME_TYPES.has(actualContentType.split(";")[0]!.trim().toLowerCase())) {
		await c.env.MEDIA_BUCKET.delete(storage_key);
		return c.json(
			{ error: { code: "INVALID_FILE_TYPE", message: `File type '${actualContentType}' is not allowed` } },
			400 as never,
		);
	}

	// SEC-11: Enforce size limit on presigned uploads (direct uploads already enforce 50MB)
	const MAX_CONFIRM_SIZE = 50 * 1024 * 1024;
	if (r2Object.size > MAX_CONFIRM_SIZE) {
		await c.env.MEDIA_BUCKET.delete(storage_key);
		return c.json(
			{ error: { code: "FILE_TOO_LARGE", message: `File size ${r2Object.size} exceeds maximum of ${MAX_CONFIRM_SIZE / 1024 / 1024}MB` } },
			400 as never,
		);
	}

	// Update the pending record with actual size and mark as ready
	const [updated] = await db
		.update(media)
		.set({
			size: r2Object.size,
			status: "ready",
		})
		.where(
			and(
				eq(media.storageKey, storage_key),
				eq(media.organizationId, orgId),
				eq(media.status, "pending"),
			),
		)
		.returning();

	if (!updated) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "No pending media record found for this storage key" } },
			404,
		);
	}

	const s3 = requireS3Client(c.env);
	const viewUrl = await getPresignedViewUrl(s3, updated.storageKey);

	return c.json(
		{
			id: updated.id,
			url: viewUrl,
			filename: updated.filename,
			mime_type: updated.mimeType,
			size: updated.size,
			width: updated.width ?? null,
			height: updated.height ?? null,
			duration: updated.duration ?? null,
			created_at: updated.createdAt.toISOString(),
		},
		200,
	);
});

export default app;
