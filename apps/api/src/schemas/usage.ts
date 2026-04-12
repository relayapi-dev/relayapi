import { z } from "@hono/zod-openapi";

export const UsageResponse = z.object({
	plan: z.object({
		name: z.enum(["free", "pro"]).describe("Current plan"),
		api_calls_limit: z.number().describe("API calls included per billing cycle"),
		api_calls_per_min: z.number().describe("API calls allowed per minute"),
		features: z.object({
			analytics: z.boolean().describe("Access to /v1/analytics"),
			inbox: z.boolean().describe("Access to /v1/inbox"),
		}),
	}),
	subscription: z.object({
		status: z.string().describe("Subscription status"),
		monthly_price_cents: z.number().describe("Base monthly price in cents"),
		price_per_thousand_calls_cents: z.number().describe("Overage price per 1K API calls in cents"),
	}),
	usage: z.object({
		api_calls_used: z.number().describe("API calls used this cycle"),
		api_calls_remaining: z.number().nullable().describe("API calls remaining this cycle. Null for pro plan (unlimited, overage billed)."),
		overage_calls: z.number().describe("API calls exceeding included amount"),
		overage_cost_cents: z.number().describe("Overage cost in cents"),
		cycle_start: z.string().datetime().describe("Current billing cycle start"),
		cycle_end: z.string().datetime().describe("Current billing cycle end"),
	}),
	rate_limit: z.object({
		limit_per_minute: z.number().describe("Max API calls per rate-limit window"),
	}),
});
