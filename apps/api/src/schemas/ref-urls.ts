import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

export const RefUrlCreateSpec = z.object({
	slug: z
		.string()
		.min(1)
		.max(100)
		.regex(/^[a-zA-Z0-9_-]+$/)
		.describe("URL-safe slug; must be unique within the organization"),
	workspace_id: z.string().optional(),
	automation_id: z
		.string()
		.nullable()
		.optional()
		.describe("Automation to enroll the contact into on click"),
	enabled: z.boolean().default(true),
});

export const RefUrlUpdateSpec = z.object({
	slug: z
		.string()
		.min(1)
		.max(100)
		.regex(/^[a-zA-Z0-9_-]+$/)
		.optional(),
	automation_id: z.string().nullable().optional(),
	enabled: z.boolean().optional(),
});

export const RefUrlResponse = z.object({
	id: z.string(),
	organization_id: z.string(),
	workspace_id: z.string().nullable(),
	slug: z.string(),
	automation_id: z.string().nullable(),
	uses: z.number().int(),
	enabled: z.boolean(),
	created_at: z.string().datetime(),
});

export const RefUrlListResponse = paginatedResponse(RefUrlResponse);
