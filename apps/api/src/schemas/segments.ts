import { z } from "@hono/zod-openapi";
import { FilterGroup } from "./automations";
import { paginatedResponse } from "./common";

export const SegmentFilter = FilterGroup.describe(
	"e.g. { all: [{ field: 'tags', op: 'contains', value: 'vip' }] }",
);

export const SegmentCreateSpec = z.object({
	name: z.string().min(1).max(200),
	description: z.string().optional(),
	workspace_id: z.string().optional(),
	filter: SegmentFilter,
	is_dynamic: z.boolean().default(true),
});

export const SegmentUpdateSpec = SegmentCreateSpec.partial();

export const SegmentResponse = z.object({
	id: z.string(),
	organization_id: z.string(),
	workspace_id: z.string().nullable(),
	name: z.string(),
	description: z.string().nullable(),
	filter: z.any(),
	is_dynamic: z.boolean(),
	member_count: z.number().int(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const SegmentListResponse = paginatedResponse(SegmentResponse);
