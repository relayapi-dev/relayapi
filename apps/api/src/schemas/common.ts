import { z } from "@hono/zod-openapi";

export const PLATFORMS = [
	"twitter",
	"instagram",
	"facebook",
	"linkedin",
	"tiktok",
	"youtube",
	"pinterest",
	"reddit",
	"bluesky",
	"threads",
	"telegram",
	"snapchat",
	"googlebusiness",
	"whatsapp",
	"mastodon",
	"discord",
	"sms",
	"beehiiv",
	"convertkit",
	"mailchimp",
	"listmonk",
] as const;

export type Platform = (typeof PLATFORMS)[number];

export const PlatformEnum = z.enum(PLATFORMS);

export const ErrorResponse = z.object({
	error: z.object({
		code: z.string().describe("Error code"),
		message: z.string().describe("Error message"),
		details: z.record(z.string(), z.any()).optional(),
	}),
});

export const PaginationParams = z.object({
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Number of items per page"),
	from: z.string().datetime({ offset: true }).optional().describe("Filter: start date (ISO 8601)"),
	to: z.string().datetime({ offset: true }).optional().describe("Filter: end date (ISO 8601)"),
});

// Cursor pagination only supports sequential (next/prev) navigation. Log
// endpoints that also expose a `total` count add an optional `offset` so clients
// can jump directly to any page (e.g. the dashboard's numbered page buttons,
// including "last page"). When `offset` is provided it takes precedence over
// `cursor`. Only honored by endpoints whose query uses this schema.
export const OffsetPaginationParams = PaginationParams.extend({
	offset: z.coerce
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			"Number of items to skip for offset-based pagination. Enables random access to any page; takes precedence over `cursor` when provided.",
		),
});

export const FilterParams = PaginationParams.extend({
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
	account_id: z.string().optional().describe("Filter by specific account ID"),
	account_ids: z
		.string()
		.optional()
		.describe(
			"Filter by any of several account IDs (comma-separated). Takes precedence over account_id.",
		),
	status: z.enum(["draft", "scheduled", "publishing", "published", "failed"]).optional().describe("Filter by post status"),
	include: z.string().optional().describe("Comma-separated list of fields to include in the response (e.g. 'targets,media')"),
	include_external: z.enum(["true", "false"]).default("false").optional()
		.describe("When true, also return external posts merged by published_at (works with status=published or no status filter)"),
});

export function paginatedResponse<T extends z.ZodTypeAny>(itemSchema: T) {
	return z.object({
		data: z.array(itemSchema),
		next_cursor: z.string().nullable().describe("Cursor for next page"),
		has_more: z.boolean().describe("Whether more items exist"),
	});
}

export const IdParam = z.object({
	id: z.string().describe("Resource ID"),
});
