import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

// --- Short link config ---

export const ShortLinkConfigBody = z.object({
	mode: z.enum(["always", "ask", "never"]).describe("When to shorten URLs in posts"),
	provider: z
		.enum(["relayapi", "dub", "short_io", "bitly"])
		.optional()
		.describe("Short link provider"),
	api_key: z
		.string()
		.optional()
		.describe("Provider API key (required when provider is set)"),
	domain: z
		.string()
		.optional()
		.describe('Custom short domain (e.g. "link.mybrand.com")'),
});

export const ShortLinkConfigResponse = z.object({
	id: z.string().nullable().describe("Config ID (null if not configured)"),
	mode: z.enum(["always", "ask", "never"]).describe("URL shortening mode"),
	provider: z
		.enum(["relayapi", "dub", "short_io", "bitly"])
		.nullable()
		.describe("Configured provider"),
	has_api_key: z.boolean().describe("Whether an API key is configured"),
	domain: z.string().nullable().describe("Custom short domain"),
	created_at: z.string().datetime().nullable(),
	updated_at: z.string().datetime().nullable(),
});

// --- Short link test ---

export const ShortLinkTestResponse = z.object({
	success: z.boolean().describe("Whether the test succeeded"),
	short_url: z
		.string()
		.nullable()
		.describe("The shortened test URL (if successful)"),
	error: z.string().nullable().describe("Error message (if failed)"),
});

// --- Short link ---

export const ShortLinkResponse = z.object({
	id: z.string().describe("Short link ID"),
	original_url: z.string().describe("Original URL"),
	short_url: z.string().describe("Shortened URL"),
	post_id: z.string().nullable().describe("Associated post ID"),
	click_count: z.number().describe("Cached click count"),
	created_at: z.string().datetime(),
});

export const ShortLinkListResponse = paginatedResponse(ShortLinkResponse);

// --- Shorten request ---

export const ShortenUrlBody = z.object({
	url: z
		.string()
		.url()
		.refine((url) => {
			try {
				const parsed = new URL(url);
				return parsed.protocol === "http:" || parsed.protocol === "https:";
			} catch {
				return false;
			}
		}, "URL must use http or https")
		.describe("URL to shorten"),
});

export const ShortenUrlResponse = z.object({
	original_url: z.string().describe("Original URL"),
	short_url: z.string().describe("Shortened URL"),
});

// --- Short link stats ---

export const ShortLinkStatsResponse = z.object({
	id: z.string().describe("Short link ID"),
	short_url: z.string().describe("Shortened URL"),
	original_url: z.string().describe("Original URL"),
	click_count: z.number().describe("Total click count"),
	last_synced_at: z.string().datetime().nullable().describe("Last time click data was synced"),
});
