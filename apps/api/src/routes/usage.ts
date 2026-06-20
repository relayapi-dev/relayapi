import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	organizationSubscriptions,
	usageRecords,
	apiRequestLogs,
} from "@relayapi/db";
import { and, count, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import {
	ErrorResponse,
	OffsetPaginationParams,
	paginatedResponse,
} from "../schemas/common";
import { UsageResponse } from "../schemas/usage";
import type { Env, Variables } from "../types";
import { PRICING } from "../types";
import { resolveBillingPeriod } from "../middleware/usage-tracking";

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

	// Resolve the org's current billing window exactly as the write path does
	// (resolveBillingPeriod): the Stripe period for pro orgs, calendar month
	// otherwise. usage_records.periodStart is keyed on this same window, so the
	// current record is fetched directly by periodStart (no JS scan / no risk of
	// the row falling outside a "most recent N" window).
	const { periodStart: cycleStart, periodEnd: cycleEnd } = resolveBillingPeriod(
		c.get("periodStart"),
		c.get("periodEnd"),
		now,
	);

	// Query subscription, the current period's usage record, and the KV counter
	// in parallel — all independent (cycleStart derives from auth context, no DB).
	const [subResult, currentUsageRows, kvRaw] = await Promise.all([
		db
			.select()
			.from(organizationSubscriptions)
			.where(eq(organizationSubscriptions.organizationId, orgId))
			.limit(1),
		db
			.select()
			.from(usageRecords)
			.where(
				and(
					eq(usageRecords.organizationId, orgId),
					eq(usageRecords.periodStart, cycleStart),
				),
			)
			.limit(1),
		c.env.KV.get(`usage:${orgId}:${month}`, "text"),
	]);

	const sub = subResult[0];
	const kvCount = parseInt(kvRaw ?? "0", 10);

	const dbUsage = currentUsageRows[0];
	const dbCallsCount = dbUsage?.apiCallsCount ?? 0;

	// The KV counter is calendar-month-keyed and written from contexts without
	// the Stripe period (cron/queue), so it only aligns with the billing window
	// for calendar-aligned (free) orgs. When the cycle is calendar-aligned, take
	// the max of KV and DB; for a Stripe period the DB record is authoritative
	// (an explicit null check honors a legitimate count of 0 at cycle start
	// rather than leaking the calendar-month KV total into a fresh period).
	const calendarMonthStart = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
	);
	const periodIsCalendarAligned =
		cycleStart.getTime() === calendarMonthStart.getTime();
	const apiCallsUsed = periodIsCalendarAligned
		? Math.max(kvCount, dbCallsCount)
		: dbCallsCount;
	const overageCalls = Math.max(0, apiCallsUsed - callsIncluded);
	// Pro-rated to the cent, matching the amount actually charged via Stripe
	// in invoice-generator.ts and the "$1 per 1,000 extra calls" pricing copy.
	const overageCostCents = Math.max(
		0,
		Math.ceil((overageCalls * PRICING.pricePerThousandCallsCents) / 1000),
	);

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
	request: { query: OffsetPaginationParams },
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
	const { limit, cursor, from, to, offset } = c.req.valid("query");
	const db = c.get("db");

	const baseConditions = [eq(apiRequestLogs.organizationId, orgId)];
	if (from) baseConditions.push(gte(apiRequestLogs.createdAt, new Date(from)));
	if (to) baseConditions.push(lte(apiRequestLogs.createdAt, new Date(to)));

	// `offset` enables random page access and takes precedence over `cursor`.
	const useOffset = offset !== undefined;
	const conditions = [...baseConditions];
	// Keyset pagination on the bigserial id. Guard against a non-numeric cursor
	// (stale/typoed) which would otherwise be sent to postgres as "NaN" and 500
	// the request. Mirror the media.ts pattern: ignore an unparseable cursor.
	if (!useOffset && cursor) {
		const cursorId = Number(cursor);
		if (!Number.isNaN(cursorId)) {
			conditions.push(lt(apiRequestLogs.id, cursorId));
		}
	}

	const dataQuery = db
		.select()
		.from(apiRequestLogs)
		.where(and(...conditions))
		.orderBy(desc(apiRequestLogs.id))
		.limit(limit + 1);

	const [rows, countRows] = await Promise.all([
		offset !== undefined ? dataQuery.offset(offset) : dataQuery,
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

// --- Daily call timeseries (powers the dashboard "API Calls" heatmap) ---

const UsageTimeseriesQuery = z.object({
	days: z.coerce
		.number()
		.int()
		.min(1)
		.max(365)
		.default(365)
		.describe("Number of days of history to include (1–365)"),
});

const UsageTimeseriesDay = z.object({
	date: z.string().describe("UTC day, YYYY-MM-DD"),
	total: z.number().describe("All API calls that day"),
	publish: z.number().describe("Write calls (POST/PUT/PATCH/DELETE)"),
	listen: z.number().describe("Read calls (GET)"),
});

const UsageTimeseriesResponse = z.object({
	range: z.object({
		from: z.string().datetime(),
		to: z.string().datetime(),
	}),
	days: z.array(UsageTimeseriesDay),
});

const getUsageTimeseries = createRoute({
	operationId: "getUsageTimeseries",
	method: "get",
	path: "/timeseries",
	tags: ["Usage"],
	summary: "Get daily API call counts",
	description:
		"Returns per-day API call counts for the organization over the requested window, split into publish (write) and listen (read) calls. Days with no calls are omitted.",
	security: [{ Bearer: [] }],
	request: { query: UsageTimeseriesQuery },
	responses: {
		200: {
			description: "Daily API call counts",
			content: { "application/json": { schema: UsageTimeseriesResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getUsageTimeseries, async (c) => {
	const orgId = c.get("orgId");
	const { days } = c.req.valid("query");
	const db = c.get("db");

	const now = new Date();
	const since = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

	// Group by UTC calendar day. Publish/listen is split off the HTTP method —
	// writes vs reads — a simple, defensible heuristic that can be refined later
	// (e.g. classifying by path) without changing the response shape.
	const dayExpr = sql<string>`to_char(date_trunc('day', ${apiRequestLogs.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
	const rows = await db
		.select({
			date: dayExpr,
			total: sql<number>`count(*)::int`,
			publish: sql<number>`count(*) FILTER (WHERE ${apiRequestLogs.method} IN ('POST','PUT','PATCH','DELETE'))::int`,
			listen: sql<number>`count(*) FILTER (WHERE ${apiRequestLogs.method} = 'GET')::int`,
		})
		.from(apiRequestLogs)
		.where(
			and(
				eq(apiRequestLogs.organizationId, orgId),
				gte(apiRequestLogs.createdAt, since),
			),
		)
		.groupBy(dayExpr)
		.orderBy(dayExpr);

	return c.json(
		{
			range: { from: since.toISOString(), to: now.toISOString() },
			days: rows.map((r) => ({
				date: r.date,
				total: Number(r.total),
				publish: Number(r.publish),
				listen: Number(r.listen),
			})),
		},
		200,
	);
});

export default app;
