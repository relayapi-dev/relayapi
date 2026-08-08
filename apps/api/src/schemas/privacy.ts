import { z } from "@hono/zod-openapi";

export const ErasureHoldSummary = z
	.object({
		id: z.string(),
		subject_kind: z.enum(["organization", "workspace"]),
		subject_id: z.string(),
		reason_code: z.string(),
		reason_summary: z.string(),
		placed_at: z.string().datetime(),
	})
	.openapi("ErasureHoldSummary");

export const ErasureHoldSummaryListResponse = z
	.object({
		held: z.boolean(),
		holds: z.array(ErasureHoldSummary),
	})
	.openapi("ErasureHoldSummaryListResponse");
