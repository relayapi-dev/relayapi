import { apiRequestLogs, createDb, usageRecords } from "@relayapi/db";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { parseCsv } from "../lib/csv-parser";
import { getRequestDb } from "../lib/request-db";
import { sendNotificationToOrg } from "../services/notification-manager";
import type { Env, Variables } from "../types";
import { PRICING } from "../types";

/**
 * Increment the KV usage counter for an org and return the new count.
 * Exported so the scheduler and queue consumer can account for usage too.
 */
export async function incrementUsage(
	kv: KVNamespace,
	orgId: string,
	amount: number = 1,
): Promise<number> {
	const now = new Date();
	const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
	const kvKey = `usage:${orgId}:${month}`;

	// Read current count
	const current = await kv.get(kvKey, "text");
	const count = current ? parseInt(current, 10) : 0;
	const newCount = count + amount;

	// Write incremented value immediately (TTL: 35 days)
	await kv.put(kvKey, String(newCount), {
		expirationTtl: 35 * 24 * 60 * 60,
	});

	return newCount;
}

/**
 * Get the current usage count for an org without incrementing.
 */
export async function getUsageCount(
	kv: KVNamespace,
	orgId: string,
): Promise<number> {
	const now = new Date();
	const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
	const kvKey = `usage:${orgId}:${month}`;
	const current = await kv.get(kvKey, "text");
	return current ? parseInt(current, 10) : 0;
}

type ApiLogEntry = {
	orgId: string;
	keyId: string;
	method: string;
	path: string;
	statusCode: number;
	responseTimeMs: number;
	billable: boolean;
};

type UsageWrite = {
	orgId: string;
	callsIncluded: number;
	units: number;
};

type UsageTrackingContext = Context<{
	Bindings: Env;
	Variables: Variables;
}>;

const JSON_BULK_USAGE_FIELDS: Record<string, string> = {
	"/v1/posts/bulk": "posts",
	"/v1/contacts/bulk": "contacts",
	"/v1/contacts/bulk-operations": "contact_ids",
	"/v1/whatsapp/bulk-send": "recipients",
	"/v1/inbox/bulk": "targets",
};

function isJsonContentType(contentType: string | undefined): boolean {
	if (!contentType) return false;
	const mimeType = contentType.split(";")[0]!.trim().toLowerCase();
	return mimeType === "application/json" || mimeType.endsWith("+json");
}

function countBodyItems(
	body: Record<string, unknown> | null | undefined,
	field: string,
): number {
	const items = body?.[field];
	return Array.isArray(items) && items.length > 0 ? items.length : 1;
}

async function readJsonBodyFromClone(
	c: UsageTrackingContext,
): Promise<Record<string, unknown> | null> {
	if (!isJsonContentType(c.req.header("content-type"))) return null;
	try {
		return (await c.req.raw.clone().json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function countBulkCsvUnits(
	c: UsageTrackingContext,
): Promise<number> {
	try {
		const formData = await c.req.raw.clone().formData();
		const file = formData.get("file");
		if (!(file instanceof File)) return 1;
		const rows = parseCsv(await file.text());
		return rows.length > 0 ? rows.length : 1;
	} catch {
		return 1;
	}
}

async function getUsageUnits(
	c: UsageTrackingContext,
): Promise<number> {
	if (c.req.method !== "POST") return 1;

	const bulkField = JSON_BULK_USAGE_FIELDS[c.req.path];
	if (bulkField) {
		const cachedBody = c.get("parsedBody") as
			| Record<string, unknown>
			| null
			| undefined;
		const body = cachedBody ?? (await readJsonBodyFromClone(c));
		return countBodyItems(body, bulkField);
	}

	if (c.req.path === "/v1/posts/bulk-csv") {
		return countBulkCsvUnits(c);
	}

	return 1;
}

async function persistUsageAndLogs(
	env: Env,
	entry: ApiLogEntry,
	usage?: UsageWrite,
): Promise<void> {
	const db = getRequestDb(env);
	const tasks: Promise<unknown>[] = [
		db.insert(apiRequestLogs).values({
			organizationId: entry.orgId,
			apiKeyId: entry.keyId,
			method: entry.method,
			path: entry.path,
			statusCode: entry.statusCode,
			responseTimeMs: entry.responseTimeMs,
			billable: entry.billable,
		}),
	];

	if (usage) {
		const now = new Date();
		const periodStart = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
		);
		const periodEnd = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
		);

		tasks.push(
			db
				.insert(usageRecords)
				.values({
					organizationId: usage.orgId,
					periodStart,
					periodEnd,
					postsCount: 0,
					postsIncluded: usage.callsIncluded,
					apiCallsCount: usage.units,
					apiCallsIncluded: usage.callsIncluded,
					overageCalls: 0,
					overageCallsCostCents: 0,
				})
				.onConflictDoUpdate({
					target: [usageRecords.organizationId, usageRecords.periodStart],
					set: {
						apiCallsCount: sql`${usageRecords.apiCallsCount} + ${usage.units}`,
						overageCalls: sql`GREATEST(0, ${usageRecords.apiCallsCount} + ${usage.units} - ${usageRecords.apiCallsIncluded})`,
						overageCallsCostCents: sql`GREATEST(0, CEIL((${usageRecords.apiCallsCount} + ${usage.units} - ${usageRecords.apiCallsIncluded}) / 1000.0)) * ${PRICING.pricePerThousandCallsCents}`,
						updatedAt: new Date(),
					},
				}),
		);
	}

	const results = await Promise.allSettled(tasks);
	for (const result of results) {
		if (result.status === "rejected") {
			console.error("Usage tracking persistence failed:", result.reason);
		}
	}
}

export const usageTrackingMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const start = Date.now();

	// GET/HEAD: not metered for billing, but logged for abuse detection
	if (c.req.method === "GET" || c.req.method === "HEAD") {
		await next();
		const orgId = c.get("orgId");
		const keyId = c.get("keyId");
		if (orgId) {
			c.executionCtx.waitUntil(
				persistUsageAndLogs(c.env, {
					orgId,
					keyId,
					method: c.req.method,
					path: c.req.path,
					statusCode: c.res.status,
					responseTimeMs: Date.now() - start,
					billable: false,
				}),
			);
		}
		return;
	}

	const orgId = c.get("orgId");
	const keyId = c.get("keyId");
	const plan = c.get("plan");
	const callsIncluded = c.get("callsIncluded");

	// Determine how many units this request costs.
	// Multi-item endpoints cost 1 per item, not 1 per request.
	const units = await getUsageUnits(c);

	// Read the counter synchronously (needed for free-plan gate + threshold detection),
	// then defer the KV write via waitUntil — the handler no longer blocks on it.
	// Concurrency note: KV get+put has never been atomic here; free-plan overage under
	// bursts was already tolerated. The DB counter in persistUsageAndLogs
	// (SQL apiCallsCount + units) remains the source of truth for billing.
	// TODO: migrate to Durable Objects for atomic per-org counters.
	const now = new Date();
	const usageMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
	const usageKvKey = `usage:${orgId}:${usageMonth}`;
	const current = await c.env.KV.get(usageKvKey, "text");
	const countBefore = current ? parseInt(current, 10) : 0;
	const newCount = countBefore + units;
	c.executionCtx.waitUntil(
		c.env.KV.put(usageKvKey, String(newCount), {
			expirationTtl: 35 * 24 * 60 * 60,
		}),
	);

	// Usage warning notifications (fire-and-forget, deduplicated via KV)
	if (callsIncluded > 0) {
		const percentNow = Math.floor((newCount / callsIncluded) * 100);
		const percentBefore = Math.floor((countBefore / callsIncluded) * 100);

		const thresholds = [80, 100] as const;
		for (const threshold of thresholds) {
			if (percentNow >= threshold && percentBefore < threshold) {
				const now = new Date();
				const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
				const warningKey = `usage_warning:${orgId}:${threshold}:${month}`;

				c.executionCtx.waitUntil(
					(async () => {
						const alreadySent = await c.env.KV.get(warningKey);
						if (alreadySent) return;
						try {
							await sendNotificationToOrg(c.env, {
								type: "usage_warning",
								orgId,
								title:
									threshold >= 100
										? "API call limit reached"
										: "Approaching API call limit",
								body:
									threshold >= 100
										? `You've used ${newCount.toLocaleString()} of ${callsIncluded.toLocaleString()} API calls (${percentNow}%)`
										: `You've used ${percentNow}% of your included API calls`,
								data: {
									percentUsed: percentNow,
									callsUsed: newCount,
									callsIncluded,
									plan,
								},
							});
							// Only set dedup flag after successful notification delivery
							await c.env.KV.put(warningKey, "1", {
								expirationTtl: 35 * 24 * 60 * 60,
							});
						} catch (err) {
							console.error("[Notification] Usage warning failed:", err);
						}
					})(),
				);
			}
		}
	}

	// Free plan: hard limit
	if (plan === "free" && countBefore >= callsIncluded) {
		// Already over limit — don't process. The counter is slightly inflated
		// but that's safe (it resets monthly).
		c.header("X-Usage-Count", String(newCount));
		c.header("X-Usage-Limit", String(callsIncluded));
		c.executionCtx.waitUntil(
			persistUsageAndLogs(c.env, {
				orgId,
				keyId,
				method: c.req.method,
				path: c.req.path,
				statusCode: 403,
				responseTimeMs: Date.now() - start,
				billable: false,
			}),
		);
		return c.json(
			{
				error: {
					code: "FREE_LIMIT_REACHED",
					message: `Free plan limit reached (${callsIncluded} API calls/month). Upgrade to Pro to continue.`,
				},
			},
			403,
		);
	}

	// Set usage headers
	const limit = callsIncluded;
	c.header("X-Usage-Count", String(newCount));
	c.header("X-Usage-Limit", String(limit));

	await next();

	c.executionCtx.waitUntil(
		persistUsageAndLogs(
			c.env,
			{
				orgId,
				keyId,
				method: c.req.method,
				path: c.req.path,
				statusCode: c.res.status,
				responseTimeMs: Date.now() - start,
				billable: true,
			},
			{
				orgId,
				callsIncluded,
				units,
			},
		),
	);
});
