import { z } from "@hono/zod-openapi";
import { PlatformEnum, paginatedResponse } from "./common";

// --- Create content template ---

export const CreateContentTemplateBody = z.object({
	name: z.string().min(1).max(200).describe("Template name"),
	description: z.string().max(1000).optional().describe("Description of when to use this template"),
	content: z.string().min(1).max(10000).describe("Post text content (supports {{variables}})"),
	platform_overrides: z
		.record(PlatformEnum, z.string().max(10000))
		.optional()
		.describe("Platform-specific content overrides"),
	tags: z.array(z.string().max(50)).max(20).default([]).describe("Tags for filtering"),
	workspace_id: z.string().optional().describe("Workspace ID to scope this template to"),
});

// --- Update content template ---

export const UpdateContentTemplateBody = z.object({
	name: z.string().min(1).max(200).optional().describe("Template name"),
	description: z.string().max(1000).nullable().optional().describe("Description"),
	content: z.string().min(1).max(10000).optional().describe("Post text content"),
	platform_overrides: z
		.record(PlatformEnum, z.string().max(10000))
		.nullable()
		.optional()
		.describe("Platform-specific content overrides"),
	tags: z.array(z.string().max(50)).max(20).optional().describe("Tags for filtering"),
});

// --- Content template response ---

export const ContentTemplateResponse = z.object({
	id: z.string().describe("Template ID"),
	name: z.string().describe("Template name"),
	description: z.string().nullable().describe("Description"),
	content: z.string().describe("Post text content"),
	platform_overrides: z.record(z.string(), z.string()).nullable().describe("Platform-specific overrides"),
	tags: z.array(z.string()).describe("Tags"),
	workspace_id: z.string().nullable().describe("Workspace ID"),
	created_at: z.string().datetime().describe("Creation timestamp"),
	updated_at: z.string().datetime().describe("Last update timestamp"),
});

// --- Paginated list ---

export const ContentTemplateListResponse = paginatedResponse(ContentTemplateResponse);
