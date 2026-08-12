import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

// --- Upload response (raw upload) ---

export const MediaUploadResponse = z.object({
	id: z.string().describe("ID of the ready media record"),
	url: z.string().url().describe("Public URL of the uploaded file"),
	type: z.string().describe("MIME type of the uploaded file"),
	size: z.number().int().describe("File size in bytes"),
	filename: z.string().describe("Original filename"),
});

// --- Presign request / response ---

export const MediaPresignRequest = z.object({
	filename: z.string().describe("Desired filename"),
	content_type: z.string().describe("MIME type of the file to upload"),
	workspace_id: z
		.string()
		.optional()
		.describe("Workspace ID for the media record"),
});

export const MediaPresignResponse = z.object({
	id: z.string().describe("ID of the pending media upload intent"),
	upload_url: z.string().url().describe("Pre-signed PUT URL for uploading"),
	upload_headers: z
		.object({
			"Content-Type": z.string(),
			"If-None-Match": z.literal("*"),
		})
		.describe("Exact headers required by the pre-signed create-only PUT"),
	url: z.string().url().describe("Public URL after upload completes"),
	expires_in: z.number().int().describe("Seconds until the upload URL expires"),
});

// --- Media response ---

export const MediaResponse = z.object({
	id: z.string().describe("Media ID"),
	workspace_id: z
		.string()
		.nullable()
		.describe("Workspace scope, or null for organization-shared media"),
	original_available: z
		.boolean()
		.describe("Whether original bytes remain available for provider delivery"),
	url: z
		.string()
		.url()
		.nullable()
		.describe(
			"Original URL while retained, otherwise the durable thumbnail URL; null when neither is available",
		),
	reference_url: z
		.string()
		.url()
		.nullable()
		.describe(
			"Stable canonical attachment URL while the original remains available; use this value in post media payloads instead of the expiring read URL",
		),
	filename: z.string().describe("Original filename"),
	mime_type: z.string().describe("MIME type"),
	size: z.number().int().describe("File size in bytes"),
	width: z.number().int().nullable().optional().describe("Width in pixels"),
	height: z.number().int().nullable().optional().describe("Height in pixels"),
	duration: z
		.number()
		.int()
		.nullable()
		.optional()
		.describe("Duration in seconds (video/audio)"),
	processing_status: z
		.enum(["not_requested", "pending", "processing", "ready", "failed"])
		.optional()
		.describe("Asynchronous normalization/derivative state"),
	processing_error: z
		.object({ code: z.string(), message: z.string() })
		.nullable()
		.optional(),
	variants: z
		.array(
			z.object({
				id: z.string(),
				kind: z.enum(["normalized", "provider", "cover", "gif_video"]),
				profile: z.string(),
				mime_type: z.string(),
				size: z.number().int().nonnegative(),
				width: z.number().int().positive().nullable(),
				height: z.number().int().positive().nullable(),
				duration: z.number().int().nonnegative().nullable(),
				status: z.enum(["processing", "ready", "failed", "deleting"]),
			}),
		)
		.optional(),
	variants_truncated: z
		.boolean()
		.optional()
		.describe("Whether additional derivative variants were omitted"),
	created_at: z.string().datetime().describe("Upload timestamp"),
});

export const MediaListResponse = paginatedResponse(MediaResponse);

export const MediaUploadSessionCreateRequest = z.object({
	filename: z.string().min(1).max(512),
	content_type: z.string().min(1).max(255),
	size_bytes: z
		.number()
		.int()
		.positive()
		.max(200 * 1024 * 1024),
	workspace_id: z.string().optional(),
});

export const MediaUploadSessionPart = z.object({
	part_number: z.number().int().min(1).max(10_000),
	etag: z.string().min(1).max(256),
});

export const MediaUploadSessionResponse = z.object({
	id: z.string(),
	media_id: z.string(),
	mode: z.enum(["single", "multipart"]),
	status: z.enum([
		"created",
		"uploading",
		"completing",
		"completed",
		"aborting",
		"aborted",
		"failed",
		"expired",
	]),
	expected_size: z.number().int().positive(),
	content_type: z.string(),
	part_size: z.number().int().positive().nullable(),
	part_count: z.number().int().positive().nullable(),
	expires_at: z.string().datetime(),
	upload: z
		.object({
			url: z.string().url(),
			headers: z.record(z.string(), z.string()),
		})
		.nullable()
		.optional(),
	media: MediaResponse.nullable().optional(),
	error: z
		.object({ code: z.string(), message: z.string() })
		.nullable()
		.optional(),
});

export const MediaUploadPartUrlsRequest = z.object({
	part_numbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(32),
});

export const MediaUploadPartUrlsResponse = z.object({
	upload_id: z.string(),
	parts: z.array(
		z.object({
			part_number: z.number().int(),
			upload_url: z.string().url(),
			upload_headers: z.record(z.string(), z.string()),
			expires_at: z.string().datetime(),
		}),
	),
});

export const MediaUploadSessionCompleteRequest = z.object({
	parts: z.array(MediaUploadSessionPart).max(10_000).default([]),
});

const MediaProcessingProfile = z
	.string()
	.min(1)
	.max(128)
	.regex(
		/^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
		"Profile must contain only letters, numbers, dots, underscores, colons, or hyphens",
	);

const CompressionOptions = z
	.object({
		compression_mode: z
			.enum(["balanced", "high_quality", "smaller"])
			.default("balanced"),
		fail_open: z.boolean().default(true),
	})
	.strict();

export const MediaProcessingRequest = z.discriminatedUnion("operation", [
	z.object({
		operation: z.literal("normalize"),
		profile: MediaProcessingProfile,
		options: CompressionOptions.default({
			compression_mode: "balanced",
			fail_open: true,
		}),
	}),
	z.object({
		operation: z.literal("provider_variant"),
		profile: MediaProcessingProfile,
		options: CompressionOptions.default({
			compression_mode: "balanced",
			fail_open: true,
		}),
	}),
	z.object({
		operation: z.literal("cover"),
		profile: MediaProcessingProfile,
		options: z
			.object({
				timestamp_seconds: z.number().min(0).max(86_400).default(0),
			})
			.strict()
			.default({ timestamp_seconds: 0 }),
	}),
]);
