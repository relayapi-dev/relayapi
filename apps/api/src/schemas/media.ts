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
	created_at: z.string().datetime().describe("Upload timestamp"),
});

export const MediaListResponse = paginatedResponse(MediaResponse);
