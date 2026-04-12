import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

function isHttpOrHttpsUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

// --- Create ---

export const CreateAutoPostRuleBody = z.object({
	name: z.string().min(1).max(200).describe("Display name for the rule"),
	feed_url: z
		.string()
		.url()
		.refine(isHttpOrHttpsUrl, "URL must use http or https")
		.describe("RSS/Atom feed URL"),
	polling_interval_minutes: z.number().int().min(15).max(1440).default(60).describe("How often to check the feed (minutes)"),
	content_template: z.string().max(5000).optional().describe("Post template with {{title}}, {{url}}, {{description}}, {{published_date}} variables"),
	append_feed_url: z.boolean().default(true).describe("Append the article URL to the post content"),
	account_ids: z.array(z.string()).default([]).describe("Target account IDs (empty = all accounts)"),
	workspace_id: z.string().optional().describe("Workspace ID to scope this rule to"),
});

// --- Update ---

export const UpdateAutoPostRuleBody = z.object({
	name: z.string().min(1).max(200).optional(),
	feed_url: z
		.string()
		.url()
		.refine(isHttpOrHttpsUrl, "URL must use http or https")
		.optional(),
	polling_interval_minutes: z.number().int().min(15).max(1440).optional(),
	content_template: z.string().max(5000).nullable().optional(),
	append_feed_url: z.boolean().optional(),
	account_ids: z.array(z.string()).optional(),
});

// --- Response ---

export const AutoPostRuleResponse = z.object({
	id: z.string(),
	name: z.string(),
	feed_url: z.string(),
	polling_interval_minutes: z.number(),
	content_template: z.string().nullable(),
	append_feed_url: z.boolean(),
	account_ids: z.array(z.string()),
	status: z.enum(["active", "paused", "error"]),
	consecutive_errors: z.number(),
	last_processed_url: z.string().nullable(),
	last_processed_at: z.string().nullable(),
	last_error: z.string().nullable(),
	workspace_id: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
});

export const AutoPostRuleListResponse = paginatedResponse(AutoPostRuleResponse);

// --- Test Feed ---

export const TestFeedBody = z.object({
	feed_url: z
		.string()
		.url()
		.refine(isHttpOrHttpsUrl, "URL must use http or https")
		.describe("RSS/Atom feed URL to test"),
	workspace_id: z.string().optional().describe("Workspace ID (required when workspace enforcement is enabled)"),
});

export const TestFeedItemSchema = z.object({
	title: z.string(),
	url: z.string(),
	description: z.string(),
	published_at: z.string().nullable(),
	image_url: z.string().nullable(),
});

export const TestFeedResponse = z.object({
	items: z.array(TestFeedItemSchema),
});
