import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	createDb,
	organizationSubscriptions,
	usageRecords,
	apiRequestLogs,
} from "@relayapi/db";
import { and, count, desc, eq, gte, lt, lte } from "drizzle-orm";
import {
	ErrorResponse,
	PaginationParams,
	paginatedResponse,
} from "../schemas/common";
import { UsageResponse } from "../schemas/usage";
import type { Env, Variables } from "../types";
import { PRICING } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Route definitions ---

const getUsage = createRoute({
	operationId: "getUsage",
	method: "get",
	path: "/",
	tags: ["Usage"],
	summary: "Get subscription usage",
	description:
		"Returns current plan details and API call usage statistics for the organization.",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Usage details",
			content: { "application/json": { schema: UsageResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Route handlers ---

app.openapi(getUsage, async (c) => {
	const orgId = c.get("orgId");
	const plan = c.get("plan");
	const callsIncluded = c.get("callsIncluded");
	const db = c.get("db");

	const now = new Date();
	const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

	// Query subscription and KV counter in parallel (they are independent)
	const [subResult, kvRaw] = await Promise.all([
		db
			.select()
			.from(organizationSubscriptions)
			.where(eq(organizationSubscriptions.organizationId, orgId))
			.limit(1),
		c.env.KV.get(`usage:${orgId}:${month}`, "text"),
	]);

	const sub = subResult[0];
	const kvCount = parseInt(kvRaw ?? "0", 10);

	// SECURITY: Use UTC consistently (matches KV key format in usage-tracking)
	const cycleStart = sub?.currentPeriodStart
		?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const cycleEnd = sub?.currentPeriodEnd
		?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

	// Read DB usage record (depends on cycleStart from subscription)
	const [dbUsage] = await db
		.select()
		.from(usageRecords)
		.where(
			and(
				eq(usageRecords.organizationId, orgId),
				eq(usageRecords.periodStart, cycleStart),
			),
		)
		.limit(1);

	const dbCallsCount = dbUsage?.apiCallsCount ?? 0;

	// KV counter covers the full calendar month. If the billing period starts
	// mid-month, KV includes calls from the previous period, so prefer DB.
	const calendarMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const periodIsCalendarAligned = cycleStart.getTime() === calendarMonthStart.getTime();
	const apiCallsUsed = periodIsCalendarAligned
		? Math.max(kvCount, dbCallsCount)
		: dbCallsCount || kvCount; // prefer DB when available, fall back to KV
	const overageCalls = Math.max(0, apiCallsUsed - callsIncluded);
	const overageCostCents = Math.max(0, Math.ceil(overageCalls / 1000) * PRICING.pricePerThousandCallsCents);

	// Free plan: remaining is hard-capped; Pro plan: can go negative (overage billed)
	const apiCallsRemaining = plan === "free"
		? Math.max(0, callsIncluded - apiCallsUsed)
		: callsIncluded - apiCallsUsed; // Pro: can go negative (overage billed)

	// Rate limit info from plan config (counters managed by CF Rate Limiting binding)
	const rateLimitMax = plan === "pro" ? PRICING.proRateLimitMax : PRICING.freeRateLimitMax;

	return c.json(
		{
			plan: {
				name: plan,
				api_calls_limit: callsIncluded,
				api_calls_per_min: rateLimitMax,
				features: {
					analytics: plan === "pro",
					inbox: plan === "pro",
				},
			},
			subscription: {
				status: sub?.status ?? (plan === "free" ? "trialing" : "active"),
				monthly_price_cents: sub?.monthlyPriceCents ?? (plan === "pro" ? PRICING.monthlyPriceCents : 0),
				price_per_thousand_calls_cents: PRICING.pricePerThousandCallsCents,
			},
			usage: {
				api_calls_used: apiCallsUsed,
				api_calls_remaining: apiCallsRemaining,
				overage_calls: overageCalls,
				overage_cost_cents: overageCostCents,
				cycle_start: cycleStart.toISOString(),
				cycle_end: cycleEnd.toISOString(),
			},
			rate_limit: {
				limit_per_minute: rateLimitMax,
			},
		},
		200,
	);
});

// --- Request logs ---

const RequestLogEntry = z.object({
	id: z.string(),
	method: z.string(),
	path: z.string(),
	status_code: z.number(),
	response_time_ms: z.number(),
	billable: z.boolean(),
	created_at: z.string().datetime(),
});

const listRequestLogs = createRoute({
	operationId: "listRequestLogs",
	method: "get",
	path: "/logs",
	tags: ["Usage"],
	summary: "List API request logs",
	description:
		"Returns per-request API logs for the organization, ordered by most recent first.",
	security: [{ Bearer: [] }],
	request: { query: PaginationParams },
	responses: {
		200: {
			description: "Request log entries",
			content: {
				"application/json": {
					schema: paginatedResponse(RequestLogEntry).extend({
							total: z.number(),
						}),
				},
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listRequestLogs, async (c) => {
	const orgId = c.get("orgId");
	const { limit, cursor, from, to } = c.req.valid("query");
	const db = c.get("db");

	const baseConditions = [eq(apiRequestLogs.organizationId, orgId)];
	if (from) baseConditions.push(gte(apiRequestLogs.createdAt, new Date(from)));
	if (to) baseConditions.push(lte(apiRequestLogs.createdAt, new Date(to)));

	const conditions = [...baseConditions];
	if (cursor) {
		conditions.push(lt(apiRequestLogs.id, Number(cursor)));
	}

	const [rows, countRows] = await Promise.all([
		db
			.select()
			.from(apiRequestLogs)
			.where(and(...conditions))
			.orderBy(desc(apiRequestLogs.id))
			.limit(limit + 1),
		db
			.select({ total: count() })
			.from(apiRequestLogs)
			.where(and(...baseConditions)),
	]);
	const total = countRows[0]?.total ?? 0;

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	return c.json(
		{
			data: data.map((l) => ({
				id: String(l.id),
				method: l.method,
				path: l.path,
				status_code: l.statusCode,
				response_time_ms: l.responseTimeMs,
				billable: l.billable,
				created_at: l.createdAt.toISOString(),
			})),
			next_cursor: hasMore ? String(data.at(-1)?.id ?? "") || null : null,
			has_more: hasMore,
			total,
		},
		200,
	);
});

export default app;
