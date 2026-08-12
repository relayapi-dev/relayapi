import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	generateId,
	media,
	mediaDerivatives,
	mediaProcessingJobs,
	mediaUploadSessions,
} from "@relayapi/db";
import type { AwsClient } from "aws4fetch";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { decryptToken, encryptToken } from "../lib/crypto";
import { mediaPublicHost } from "../lib/deployment-mode";
import {
	isAllowedMediaMimeType,
	MAX_MEDIA_UPLOAD_BYTES,
	MEDIA_MULTIPART_PART_BYTES,
	MEDIA_MULTIPART_THRESHOLD_BYTES,
	normalizeMediaMimeType,
	validateStoredMediaObject,
} from "../lib/media-storage-policy";
import { isR2NoSuchUploadError } from "../lib/r2-multipart";
import {
	getCachedR2Client,
	presignR2MultipartPartUrl,
	presignR2Url,
} from "../lib/r2-presign";
import { resolveOperationalCreateScope } from "../lib/request-access";
import { assertWorkspaceScope } from "../lib/workspace-scope";
import { ErrorResponse } from "../schemas/common";
import {
	MediaProcessingRequest,
	MediaResponse,
	MediaUploadPartUrlsRequest,
	MediaUploadPartUrlsResponse,
	MediaUploadSessionCompleteRequest,
	MediaUploadSessionCreateRequest,
	MediaUploadSessionResponse,
} from "../schemas/media";
import {
	enqueueAutomaticMediaNormalization,
	requestMediaProcessing,
	supportsMediaProcessingIntent,
} from "../services/media-processing-jobs";
import { retireRejectedMediaUpload } from "../services/media-reliability";
import {
	headStoredObject,
	preferredMediaStorageTarget,
	presignStoredObject,
	storageLocatorForMedia,
} from "../services/storage-locator";
import type { Env, Variables } from "../types";
import { getMediaReadUrl } from "./media";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SIGNED_URL_TTL_SECONDS = 15 * 60;
const SESSION_OPERATION_LEASE_MS = 10 * 60 * 1000;

function markNotApplied(c: AppContext): void {
	c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
		kind: "not_applied",
	});
}

function markCommitted(c: AppContext): void {
	c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
		kind: "committed",
		units: 1,
	});
}

function uploadIdContext(sessionId: string) {
	return { recordId: sessionId, field: "multipart_upload_id" };
}

function sanitizeFilename(filename: string): string {
	const sanitized = filename
		.replace(/[/\\]/g, "_")
		.replace(/\.\./g, "_")
		.replace(/\0/g, "")
		.replace(/[%#?]/g, "_")
		.trim();
	return sanitized || "upload";
}

function requireR2Client(env: Env): AwsClient {
	const client = getCachedR2Client(env);
	if (!client) {
		throw new Error(
			"R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and CF_ACCOUNT_ID must be set",
		);
	}
	return client;
}

type UploadSessionRow = typeof mediaUploadSessions.$inferSelect;

async function loadSession(c: AppContext, id: string) {
	const db = c.get("db");
	const [row] = await db
		.select({ session: mediaUploadSessions, media })
		.from(mediaUploadSessions)
		.innerJoin(
			media,
			and(
				eq(media.id, mediaUploadSessions.mediaId),
				eq(media.organizationId, mediaUploadSessions.organizationId),
				eq(media.scopeKey, mediaUploadSessions.scopeKey),
			),
		)
		.where(
			and(
				eq(mediaUploadSessions.id, id),
				eq(mediaUploadSessions.organizationId, c.get("orgId")),
			),
		)
		.limit(1);
	return row;
}

async function uploadUrlForSingle(
	c: AppContext,
	record: typeof media.$inferSelect,
) {
	const locator = storageLocatorForMedia(record);
	const url =
		locator.provider === "r2"
			? await presignR2Url(
					c.env,
					requireR2Client(c.env),
					record.storageKey,
					"PUT",
					SIGNED_URL_TTL_SECONDS,
					record.mimeType,
					{
						bucket: locator.bucket,
						region: locator.region,
					},
				)
			: await presignStoredObject(
					c.get("db"),
					c.env,
					locator,
					"PUT",
					SIGNED_URL_TTL_SECONDS,
					record.mimeType,
				);
	return {
		url,
		headers: {
			"Content-Type": record.mimeType,
			"If-None-Match": "*",
		},
	};
}

async function mediaProjection(
	c: AppContext,
	record: typeof media.$inferSelect,
) {
	const derivatives = await c
		.get("db")
		.select()
		.from(mediaDerivatives)
		.where(
			and(
				eq(mediaDerivatives.mediaId, record.id),
				eq(mediaDerivatives.organizationId, record.organizationId),
			),
		)
		.orderBy(desc(mediaDerivatives.createdAt), desc(mediaDerivatives.id))
		.limit(51);
	const [latestJob] = await c
		.get("db")
		.select()
		.from(mediaProcessingJobs)
		.where(
			and(
				eq(mediaProcessingJobs.mediaId, record.id),
				eq(mediaProcessingJobs.organizationId, record.organizationId),
			),
		)
		.orderBy(desc(mediaProcessingJobs.updatedAt))
		.limit(1);
	const processingStatus:
		| "not_requested"
		| "pending"
		| "processing"
		| "ready"
		| "failed" = latestJob
		? latestJob.status === "completed"
			? "ready"
			: latestJob.status === "processing"
				? "processing"
				: latestJob.status === "pending"
					? "pending"
					: "failed"
		: "not_requested";
	return {
		id: record.id,
		workspace_id: record.workspaceId,
		original_available:
			record.status === "ready" &&
			record.originalDeletedAt === null &&
			record.deletionRequestedAt === null,
		url:
			record.status === "ready"
				? await getMediaReadUrl(c.get("db"), c.env, record)
				: null,
		reference_url:
			record.status === "ready" &&
			record.originalDeletedAt === null &&
			record.deletionRequestedAt === null
				? record.url
				: null,
		filename: record.filename,
		mime_type: record.mimeType,
		size: record.size,
		width: record.width ?? null,
		height: record.height ?? null,
		duration: record.duration ?? null,
		processing_status: processingStatus,
		processing_error:
			latestJob &&
			!["pending", "processing", "completed"].includes(latestJob.status)
				? {
						code: latestJob.lastErrorCode ?? "MEDIA_PROCESSING_FAILED",
						message: latestJob.lastError ?? "Media processing failed",
					}
				: null,
		variants: derivatives.slice(0, 50).map((derivative) => ({
			id: derivative.id,
			kind: derivative.kind,
			profile: derivative.profile,
			mime_type: derivative.mimeType,
			size: derivative.size,
			width: derivative.width ?? null,
			height: derivative.height ?? null,
			duration: derivative.duration ?? null,
			status: derivative.status,
		})),
		variants_truncated: derivatives.length > 50,
		created_at: record.createdAt.toISOString(),
	};
}

async function sessionProjection(
	c: AppContext,
	session: UploadSessionRow,
	record: typeof media.$inferSelect,
	includeUpload = false,
) {
	return {
		id: session.id,
		media_id: session.mediaId,
		mode: session.mode,
		status: session.status,
		expected_size: session.expectedSize,
		content_type: session.expectedMimeType,
		part_size: session.partSize,
		part_count: session.partCount,
		expires_at: session.expiresAt.toISOString(),
		upload:
			includeUpload &&
			session.mode === "single" &&
			!["completed", "aborted", "failed", "expired"].includes(session.status)
				? await uploadUrlForSingle(c, record)
				: null,
		media:
			session.status === "completed" ? await mediaProjection(c, record) : null,
		error: session.lastErrorCode
			? {
					code: session.lastErrorCode,
					message: session.lastError ?? "Upload failed",
				}
			: null,
	};
}

const createUpload = createRoute({
	operationId: "createMediaUploadSession",
	method: "post",
	path: "/uploads",
	tags: ["Media"],
	summary: "Create a resumable media upload session",
	description:
		"Creates a single-part or multipart direct-to-storage upload supporting canonical objects up to 200 MiB.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: MediaUploadSessionCreateRequest },
			},
		},
	},
	responses: {
		201: {
			description: "Upload session created",
			content: { "application/json": { schema: MediaUploadSessionResponse } },
		},
		400: {
			description: "Invalid media intent",
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
		413: {
			description: "Media exceeds 200 MiB",
			content: { "application/json": { schema: ErrorResponse } },
		},
		422: {
			description: "Storage does not support requested upload mode",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getUpload = createRoute({
	operationId: "getMediaUploadSession",
	method: "get",
	path: "/uploads/{id}",
	tags: ["Media"],
	security: [{ Bearer: [] }],
	request: { params: z.object({ id: z.string() }) },
	responses: {
		200: {
			description: "Upload session",
			content: { "application/json": { schema: MediaUploadSessionResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const createPartUrls = createRoute({
	operationId: "createMediaUploadPartUrls",
	method: "post",
	path: "/uploads/{id}/parts",
	tags: ["Media"],
	security: [{ Bearer: [] }],
	request: {
		params: z.object({ id: z.string() }),
		body: {
			content: { "application/json": { schema: MediaUploadPartUrlsRequest } },
		},
	},
	responses: {
		200: {
			description: "Signed part URLs",
			content: { "application/json": { schema: MediaUploadPartUrlsResponse } },
		},
		400: {
			description: "Invalid part request",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Session is not uploadable",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const completeUpload = createRoute({
	operationId: "completeMediaUploadSession",
	method: "post",
	path: "/uploads/{id}/complete",
	tags: ["Media"],
	security: [{ Bearer: [] }],
	request: {
		params: z.object({ id: z.string() }),
		body: {
			content: {
				"application/json": { schema: MediaUploadSessionCompleteRequest },
			},
		},
	},
	responses: {
		200: {
			description: "Upload completed",
			content: { "application/json": { schema: MediaResponse } },
		},
		400: {
			description: "Stored object failed validation",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Session cannot be completed",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const abortUpload = createRoute({
	operationId: "abortMediaUploadSession",
	method: "delete",
	path: "/uploads/{id}",
	tags: ["Media"],
	security: [{ Bearer: [] }],
	request: { params: z.object({ id: z.string() }) },
	responses: {
		204: { description: "Upload aborted" },
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Completed uploads cannot be aborted",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const processMedia = createRoute({
	operationId: "processMedia",
	method: "post",
	path: "/{id}/process",
	tags: ["Media"],
	security: [{ Bearer: [] }],
	request: {
		params: z.object({ id: z.string() }),
		body: {
			content: { "application/json": { schema: MediaProcessingRequest } },
		},
	},
	responses: {
		202: {
			description: "Processing queued",
			content: { "application/json": { schema: MediaResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		422: {
			description: "The requested transform is not valid for this media type",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Original media bytes are unavailable",
			content: { "application/json": { schema: ErrorResponse } },
		},
		503: {
			description: "Media processing is unavailable",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createUpload, async (c) => {
	const body = c.req.valid("json");
	if (body.size_bytes > MAX_MEDIA_UPLOAD_BYTES) {
		markNotApplied(c);
		return c.json(
			{
				error: {
					code: "FILE_TOO_LARGE",
					message: "Maximum media size is 200 MiB",
				},
			},
			413,
		);
	}
	if (!isAllowedMediaMimeType(body.content_type)) {
		markNotApplied(c);
		return c.json(
			{
				error: {
					code: "INVALID_CONTENT_TYPE",
					message: "Content type is not supported",
				},
			},
			400,
		);
	}
	const scope = await resolveOperationalCreateScope(
		c,
		body.workspace_id,
		"media",
	);
	if (!scope.ok) {
		markNotApplied(c);
		return scope.response as never;
	}
	const db = c.get("db");
	const orgId = c.get("orgId");
	const target = await preferredMediaStorageTarget(db, c.env, orgId);
	const mode =
		body.size_bytes > MEDIA_MULTIPART_THRESHOLD_BYTES ? "multipart" : "single";
	if (mode === "multipart" && target.provider !== "r2") {
		markNotApplied(c);
		return c.json(
			{
				error: {
					code: "MULTIPART_STORAGE_UNAVAILABLE",
					message:
						"The active custom storage location does not support resumable multipart uploads",
				},
			},
			422,
		);
	}
	if (target.provider === "r2" && !getCachedR2Client(c.env)) {
		markNotApplied(c);
		return c.json(
			{
				error: {
					code: "NOT_CONFIGURED",
					message: "R2 signing credentials are required for resumable uploads",
				},
			},
			422,
		);
	}

	const filename = sanitizeFilename(body.filename);
	const contentType = normalizeMediaMimeType(body.content_type);
	const storageKey = `${orgId}/media/${generateId("file_")}/${filename}`;
	const mediaId = generateId("med_");
	const sessionId = generateId("mup_");
	const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
	let multipartUpload: R2MultipartUpload | null = null;
	let uploadIdCiphertext: string | null = null;
	let partCount: number | null = null;
	if (mode === "multipart") {
		multipartUpload = await c.env.MEDIA_BUCKET.createMultipartUpload(
			storageKey,
			{
				httpMetadata: { contentType },
				customMetadata: { orgId, mediaId, uploadSessionId: sessionId },
			},
		);
		uploadIdCiphertext = await encryptToken(
			multipartUpload.uploadId,
			c.env.ENCRYPTION_KEY,
			uploadIdContext(sessionId),
		);
		partCount = Math.ceil(body.size_bytes / MEDIA_MULTIPART_PART_BYTES);
	}

	try {
		await db.transaction(async (tx) => {
			await tx.insert(media).values({
				id: mediaId,
				organizationId: orgId,
				workspaceId: scope.workspaceId,
				filename,
				mimeType: contentType,
				size: body.size_bytes,
				storageKey,
				storageProvider: target.provider,
				storageBucketLocator: target.bucket,
				storageRegion: target.region,
				...(target.provider === "byos"
					? {
							storageLocationId: target.locationId,
							storageCredentialVersion: target.credentialVersion,
						}
					: {}),
				url: `https://${mediaPublicHost(c.env)}/${storageKey}`,
				status: "pending",
			});
			await tx.insert(mediaUploadSessions).values({
				id: sessionId,
				organizationId: orgId,
				workspaceId: scope.workspaceId,
				mediaId,
				mode,
				expectedSize: body.size_bytes,
				expectedMimeType: contentType,
				partSize: mode === "multipart" ? MEDIA_MULTIPART_PART_BYTES : null,
				partCount,
				multipartUploadIdCiphertext: uploadIdCiphertext,
				expiresAt,
			});
		});
	} catch (error) {
		if (multipartUpload) {
			await multipartUpload.abort().catch((abortError) => {
				console.error(
					"[media-upload] failed to abort an unprojected multipart upload",
					abortError,
				);
			});
		}
		throw error;
	}
	markCommitted(c);
	const loaded = await loadSession(c, sessionId);
	if (!loaded)
		throw new Error("Persisted upload session could not be reloaded");
	return c.json(
		await sessionProjection(c, loaded.session, loaded.media, true),
		201,
	);
});

app.openapi(getUpload, async (c) => {
	const loaded = await loadSession(c, c.req.valid("param").id);
	if (!loaded)
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Upload session not found" } },
			404,
		);
	const denied = assertWorkspaceScope(c, loaded.session.workspaceId);
	if (denied) return denied as never;
	return c.json(
		await sessionProjection(c, loaded.session, loaded.media, true),
		200,
	);
});

app.openapi(createPartUrls, async (c) => {
	const loaded = await loadSession(c, c.req.valid("param").id);
	if (!loaded)
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Upload session not found" } },
			404,
		);
	const denied = assertWorkspaceScope(c, loaded.session.workspaceId);
	if (denied) return denied as never;
	const { session, media: mediaRow } = loaded;
	const partCount = session.partCount;
	if (
		session.mode !== "multipart" ||
		!session.multipartUploadIdCiphertext ||
		!partCount
	) {
		markNotApplied(c);
		return c.json(
			{
				error: {
					code: "NOT_MULTIPART",
					message: "Upload session is not multipart",
				},
			},
			409,
		);
	}
	if (
		!["created", "uploading"].includes(session.status) ||
		session.expiresAt <= new Date()
	) {
		markNotApplied(c);
		return c.json(
			{
				error: {
					code: "UPLOAD_NOT_ACTIVE",
					message: "Upload session is not active",
				},
			},
			409,
		);
	}
	const requested = [...new Set(c.req.valid("json").part_numbers)].sort(
		(a, b) => a - b,
	);
	if (requested.some((part) => part > partCount)) {
		markNotApplied(c);
		return c.json(
			{
				error: {
					code: "INVALID_PART",
					message: "Part number exceeds the expected part count",
				},
			},
			400,
		);
	}
	const uploadId = await decryptToken(
		session.multipartUploadIdCiphertext,
		c.env.ENCRYPTION_KEY,
		uploadIdContext(session.id),
	);
	const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000);
	const client = requireR2Client(c.env);
	const location = {
		bucket: mediaRow.storageBucketLocator,
		region: mediaRow.storageRegion as "default" | "eu",
	};
	const parts = await Promise.all(
		requested.map(async (partNumber) => ({
			part_number: partNumber,
			upload_url: await presignR2MultipartPartUrl(
				c.env,
				client,
				mediaRow.storageKey,
				uploadId,
				partNumber,
				SIGNED_URL_TTL_SECONDS,
				location,
			),
			upload_headers: {},
			expires_at: expiresAt.toISOString(),
		})),
	);
	await c
		.get("db")
		.update(mediaUploadSessions)
		.set({ status: "uploading", updatedAt: new Date() })
		.where(
			and(
				eq(mediaUploadSessions.id, session.id),
				eq(mediaUploadSessions.status, session.status),
			),
		);
	markNotApplied(c);
	return c.json({ upload_id: session.id, parts }, 200);
});

app.openapi(completeUpload, async (c) => {
	const loaded = await loadSession(c, c.req.valid("param").id);
	if (!loaded)
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Upload session not found" } },
			404,
		);
	const denied = assertWorkspaceScope(c, loaded.session.workspaceId);
	if (denied) return denied as never;
	let { session, media: mediaRow } = loaded;
	if (session.status === "completed" && mediaRow.status === "ready") {
		await enqueueAutomaticMediaNormalization(
			c.get("db"),
			c.env,
			mediaRow,
		).catch((error) => {
			console.error("[media-processing] automatic handoff failed", error);
		});
		markNotApplied(c);
		return c.json(await mediaProjection(c, mediaRow), 200);
	}
	if (!["created", "uploading", "completing"].includes(session.status)) {
		markNotApplied(c);
		return c.json(
			{
				error: {
					code: "UPLOAD_NOT_COMPLETABLE",
					message: "Upload session cannot be completed",
				},
			},
			409,
		);
	}
	const claimNow = new Date();
	if (session.expiresAt <= claimNow) {
		markNotApplied(c);
		return c.json(
			{
				error: {
					code: "UPLOAD_SESSION_EXPIRED",
					message: "Upload session has expired",
				},
			},
			409,
		);
	}
	const parts = c.req.valid("json").parts;
	if (session.mode === "multipart") {
		if (!session.partCount || parts.length !== session.partCount) {
			markNotApplied(c);
			return c.json(
				{
					error: {
						code: "INVALID_PARTS",
						message: "Every expected multipart ETag is required",
					},
				},
				400,
			);
		}
		const numbers = parts.map((part) => part.part_number).sort((a, b) => a - b);
		if (numbers.some((number, index) => number !== index + 1)) {
			markNotApplied(c);
			return c.json(
				{
					error: {
						code: "INVALID_PARTS",
						message: "Multipart parts must be unique and contiguous",
					},
				},
				400,
			);
		}
	}

	const [claimed] = await c
		.get("db")
		.update(mediaUploadSessions)
		.set({
			status: "completing",
			leaseToken: sql`${mediaUploadSessions.leaseToken} + 1`,
			leaseExpiresAt: new Date(claimNow.getTime() + SESSION_OPERATION_LEASE_MS),
			updatedAt: claimNow,
		})
		.where(
			and(
				eq(mediaUploadSessions.id, session.id),
				eq(mediaUploadSessions.organizationId, c.get("orgId")),
				gt(mediaUploadSessions.expiresAt, claimNow),
				or(
					inArray(mediaUploadSessions.status, ["created", "uploading"]),
					and(
						eq(mediaUploadSessions.status, "completing"),
						lte(mediaUploadSessions.leaseExpiresAt, claimNow),
					),
				),
			),
		)
		.returning();
	if (!claimed) {
		const current = await loadSession(c, session.id);
		if (
			current?.session.status === "completed" &&
			current.media.status === "ready"
		) {
			markNotApplied(c);
			return c.json(await mediaProjection(c, current.media), 200);
		}
		markNotApplied(c);
		return c.json(
			{
				error: {
					code: "UPLOAD_OPERATION_IN_PROGRESS",
					message: "Another upload completion or abort owns this session",
				},
			},
			409,
		);
	}
	session = claimed;
	const completionLeaseToken = session.leaseToken;

	let stored = await headStoredObject(
		c.get("db"),
		c.env,
		storageLocatorForMedia(mediaRow),
	);
	if (!stored && session.mode === "multipart") {
		if (!session.multipartUploadIdCiphertext)
			throw new Error("Multipart session is missing its upload id");
		const uploadId = await decryptToken(
			session.multipartUploadIdCiphertext,
			c.env.ENCRYPTION_KEY,
			uploadIdContext(session.id),
		);
		const upload = c.env.MEDIA_BUCKET.resumeMultipartUpload(
			mediaRow.storageKey,
			uploadId,
		);
		await upload.complete(
			parts.map((part) => ({ partNumber: part.part_number, etag: part.etag })),
		);
		stored = await headStoredObject(
			c.get("db"),
			c.env,
			storageLocatorForMedia(mediaRow),
		);
	}
	if (!stored) {
		const [failed] = await c
			.get("db")
			.update(mediaUploadSessions)
			.set({
				status: "failed",
				multipartUploadIdCiphertext: null,
				leaseExpiresAt: null,
				lastErrorCode: "UPLOAD_NOT_FOUND",
				lastError: "The completed object was not found in storage",
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(mediaUploadSessions.id, session.id),
					eq(mediaUploadSessions.status, "completing"),
					eq(mediaUploadSessions.leaseToken, completionLeaseToken),
				),
			)
			.returning({ id: mediaUploadSessions.id });
		if (!failed) throw new Error("Upload completion lease was lost");
		return c.json(
			{
				error: {
					code: "UPLOAD_NOT_FOUND",
					message: "The uploaded object was not found",
				},
			},
			404,
		);
	}
	const validation = validateStoredMediaObject({
		size: stored.size,
		httpMetadata: { contentType: stored.contentType ?? undefined },
	});
	if (
		!validation.ok ||
		stored.size !== session.expectedSize ||
		validation.mimeType !== session.expectedMimeType
	) {
		const [failed] = await c
			.get("db")
			.update(mediaUploadSessions)
			.set({
				status: "failed",
				multipartUploadIdCiphertext: null,
				leaseExpiresAt: null,
				lastErrorCode: validation.ok
					? "UPLOAD_METADATA_MISMATCH"
					: validation.code,
				lastError: validation.ok
					? "Stored object does not match the declared size or content type"
					: validation.message,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(mediaUploadSessions.id, session.id),
					eq(mediaUploadSessions.status, "completing"),
					eq(mediaUploadSessions.leaseToken, completionLeaseToken),
				),
			)
			.returning({ id: mediaUploadSessions.id });
		if (!failed) throw new Error("Upload completion lease was lost");
		await retireRejectedMediaUpload(
			c.get("db"),
			c.env,
			mediaRow.id,
			new Date(),
			"resumable_upload_validation_failed",
		);
		return c.json(
			{
				error: {
					code: "UPLOAD_METADATA_MISMATCH",
					message: "Stored object failed upload validation",
				},
			},
			400,
		);
	}
	const now = new Date();
	await c.get("db").transaction(async (tx) => {
		const [completed] = await tx
			.update(mediaUploadSessions)
			.set({
				status: "completed",
				multipartUploadIdCiphertext: null,
				leaseExpiresAt: null,
				completedAt: now,
				updatedAt: now,
				lastError: null,
				lastErrorCode: null,
			})
			.where(
				and(
					eq(mediaUploadSessions.id, session.id),
					eq(mediaUploadSessions.organizationId, c.get("orgId")),
					eq(mediaUploadSessions.status, "completing"),
					eq(mediaUploadSessions.leaseToken, completionLeaseToken),
				),
			)
			.returning({ id: mediaUploadSessions.id });
		if (!completed) throw new Error("Upload completion lease was lost");
		const [updated] = await tx
			.update(media)
			.set({
				size: validation.size,
				mimeType: validation.mimeType,
				status: "ready",
			})
			.where(
				and(
					eq(media.id, mediaRow.id),
					inArray(media.status, ["pending", "uploading"]),
					isNull(media.deletionRequestedAt),
				),
			)
			.returning();
		if (!updated) {
			const [currentMedia] = await tx
				.select()
				.from(media)
				.where(
					and(
						eq(media.id, mediaRow.id),
						eq(media.organizationId, c.get("orgId")),
						eq(media.status, "ready"),
						isNull(media.deletionRequestedAt),
					),
				)
				.limit(1);
			if (!currentMedia) {
				throw new Error("Media projection changed during upload completion");
			}
			mediaRow = currentMedia;
		} else {
			mediaRow = updated;
		}
	});
	await enqueueAutomaticMediaNormalization(c.get("db"), c.env, mediaRow).catch(
		(error) => {
			console.error("[media-processing] automatic handoff failed", error);
		},
	);
	markCommitted(c);
	return c.json(await mediaProjection(c, mediaRow), 200);
});

app.openapi(abortUpload, async (c) => {
	const loaded = await loadSession(c, c.req.valid("param").id);
	if (!loaded) {
		markNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Upload session not found" } },
			404,
		);
	}
	const denied = assertWorkspaceScope(c, loaded.session.workspaceId);
	if (denied) return denied as never;
	if (loaded.session.status === "completed") {
		markNotApplied(c);
		return c.json(
			{
				error: {
					code: "UPLOAD_COMPLETED",
					message: "Completed media must be deleted through the media endpoint",
				},
			},
			409,
		);
	}
	if (["aborted", "expired"].includes(loaded.session.status)) {
		markNotApplied(c);
		return c.body(null, 204);
	}
	const abortNow = new Date();
	const needsProviderAbort =
		loaded.session.mode === "multipart" &&
		Boolean(loaded.session.multipartUploadIdCiphertext);
	const [claimed] = await c
		.get("db")
		.update(mediaUploadSessions)
		.set({
			status: needsProviderAbort ? "aborting" : "aborted",
			leaseToken: sql`${mediaUploadSessions.leaseToken} + 1`,
			leaseExpiresAt: needsProviderAbort
				? new Date(abortNow.getTime() + SESSION_OPERATION_LEASE_MS)
				: null,
			...(needsProviderAbort ? {} : { multipartUploadIdCiphertext: null }),
			updatedAt: abortNow,
		})
		.where(
			and(
				eq(mediaUploadSessions.id, loaded.session.id),
				eq(mediaUploadSessions.organizationId, c.get("orgId")),
				eq(mediaUploadSessions.status, loaded.session.status),
				eq(mediaUploadSessions.leaseToken, loaded.session.leaseToken),
				or(
					isNull(mediaUploadSessions.leaseExpiresAt),
					lte(mediaUploadSessions.leaseExpiresAt, abortNow),
				),
			),
		)
		.returning();
	if (!claimed) {
		const current = await loadSession(c, loaded.session.id);
		if (current?.session.status === "completed") {
			markNotApplied(c);
			return c.json(
				{
					error: {
						code: "UPLOAD_COMPLETED",
						message:
							"Completed media must be deleted through the media endpoint",
					},
				},
				409,
			);
		}
		if (current && ["aborted", "expired"].includes(current.session.status)) {
			markNotApplied(c);
			return c.body(null, 204);
		}
		markNotApplied(c);
		return c.json(
			{
				error: {
					code: "UPLOAD_OPERATION_IN_PROGRESS",
					message: "Another upload completion or abort owns this session",
				},
			},
			409,
		);
	}
	const abortLeaseToken = claimed.leaseToken;
	if (needsProviderAbort && claimed.multipartUploadIdCiphertext) {
		const locator = storageLocatorForMedia(loaded.media);
		const uploadId = await decryptToken(
			claimed.multipartUploadIdCiphertext,
			c.env.ENCRYPTION_KEY,
			uploadIdContext(claimed.id),
		);
		let completedObject = await headStoredObject(c.get("db"), c.env, locator);
		if (!completedObject) {
			try {
				await c.env.MEDIA_BUCKET.resumeMultipartUpload(
					loaded.media.storageKey,
					uploadId,
				).abort();
			} catch (abortError) {
				// Completion may have won after the first head. R2 completion is
				// strongly visible, so re-head the exact object before deciding. With
				// no object, only the documented NoSuchUpload code proves the upload
				// was already aborted; every other error keeps encrypted authority for
				// a fenced retry after this lease expires.
				completedObject = await headStoredObject(c.get("db"), c.env, locator);
				if (!completedObject && !isR2NoSuchUploadError(abortError)) {
					throw abortError;
				}
			}
		}
	}
	if (needsProviderAbort) {
		const [finalized] = await c
			.get("db")
			.update(mediaUploadSessions)
			.set({
				status: "aborted",
				multipartUploadIdCiphertext: null,
				leaseExpiresAt: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(mediaUploadSessions.id, claimed.id),
					eq(mediaUploadSessions.status, "aborting"),
					eq(mediaUploadSessions.leaseToken, abortLeaseToken),
				),
			)
			.returning({ id: mediaUploadSessions.id });
		if (!finalized) throw new Error("Upload abort lease was lost");
	}
	await retireRejectedMediaUpload(
		c.get("db"),
		c.env,
		loaded.media.id,
		new Date(),
		"upload_session_aborted",
	);
	markCommitted(c);
	return c.body(null, 204);
});

app.openapi(processMedia, async (c) => {
	const orgId = c.get("orgId");
	const [record] = await c
		.get("db")
		.select()
		.from(media)
		.where(
			and(
				eq(media.id, c.req.valid("param").id),
				eq(media.organizationId, orgId),
				eq(media.status, "ready"),
			),
		)
		.limit(1);
	if (!record)
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Media not found" } },
			404,
		);
	const denied = assertWorkspaceScope(c, record.workspaceId);
	if (denied) return denied as never;
	const body = c.req.valid("json");
	if (!supportsMediaProcessingIntent(record.mimeType, body.operation)) {
		markNotApplied(c);
		return c.json(
			{
				error: {
					code: "MEDIA_PROCESSING_TYPE_UNSUPPORTED",
					message:
						body.operation === "cover"
							? "Cover extraction requires image or video media"
							: "Compression requires image, video, or audio media",
				},
			},
			422,
		);
	}
	if (
		!c.env.MEDIA_PROCESSING_QUEUE ||
		!c.env.MEDIA_PROCESSING_WORKFLOW ||
		!c.env.MEDIA_PROCESSOR
	) {
		markNotApplied(c);
		return c.json(
			{
				error: {
					code: "MEDIA_PROCESSING_UNAVAILABLE",
					message: "Media processing is not configured for this deployment",
				},
			},
			503,
		);
	}
	const requested = await requestMediaProcessing(c.get("db"), c.env, record, {
		operation: body.operation,
		profile: body.profile,
		options: body.options,
	});
	if (!requested) {
		markNotApplied(c);
		return c.json(
			{
				error: {
					code: "MEDIA_SOURCE_UNAVAILABLE",
					message: "Original media bytes are unavailable",
				},
			},
			409,
		);
	}
	if (requested.createdOrRetried) {
		markCommitted(c);
	} else {
		markNotApplied(c);
	}
	return c.json(await mediaProjection(c, record), 202);
});

export default app;
