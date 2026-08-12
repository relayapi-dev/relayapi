import { z } from "@hono/zod-openapi";

export const UsageResponse = z.object({
	plan: z.object({
		name: z.enum(["free", "pro"]).describe("Current plan"),
		quota_mode: z.enum(["hard", "metered", "unlimited"]),
		api_calls_limit: z
			.string()
			.regex(/^\d+$/)
			.nullable()
			.describe("Decimal API-call allowance; null only for unlimited"),
		api_calls_per_min: z.number().describe("API calls allowed per minute"),
		features: z.object({
			analytics: z.boolean().describe("Access to /v1/analytics"),
			inbox: z.boolean().describe("Access to /v1/inbox"),
		}),
	}),
	subscription: z.object({
		status: z.string().describe("Subscription status"),
		monthly_price_cents: z.number().describe("Base monthly price in cents"),
		price_per_thousand_calls_cents: z
			.number()
			.describe("Overage price per 1K API calls in cents"),
	}),
	usage: z.object({
		quota_mode: z.enum(["hard", "metered", "unlimited"]),
		included_units: z.string().regex(/^\d+$/).nullable(),
		api_calls_used: z
			.string()
			.regex(/^\d+$/)
			.describe("API calls used this cycle"),
		api_calls_remaining: z
			.string()
			.regex(/^-?\d+$/)
			.nullable()
			.describe(
				"Decimal API calls remaining this cycle; null only for unlimited.",
			),
		overage_calls: z
			.string()
			.regex(/^\d+$/)
			.describe("API calls exceeding included amount"),
		overage_cost_cents: z.number().describe("Overage cost in cents"),
		cycle_start: z.string().datetime().describe("Current billing cycle start"),
		cycle_end: z.string().datetime().describe("Current billing cycle end"),
	}),
	rate_limit: z.object({
		limit_per_minute: z
			.number()
			.describe("Max API calls per rate-limit window"),
	}),
});
