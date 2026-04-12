import { apiRequestLogs, createDb, usageRecords } from "@relayapi/db";
import { sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
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

async function persistUsageAndLogs(
	env: Env,
	entry: ApiLogEntry,
	usage?: UsageWrite,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
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
	// Bulk endpoints cost 1 per item, not 1 per request.
	let units = 1;
	if (c.req.method === "POST" && c.req.path.endsWith("/bulk")) {
		const body = c.get("parsedBody");
		const postItems = body?.posts;
		if (Array.isArray(postItems)) {
			units = postItems.length;
		}
	}

	// SECURITY: Increment BEFORE checking the limit.
	// Note: KV get+put is NOT atomic — concurrent requests (within the same
	// isolate at await points or across edge locations) can read the same
	// count and produce an under-count. This means the free-plan hard limit
	// can be slightly exceeded under concurrent bursts. The DB counter
	// (SQL apiCallsCount + units) is always correct for billing.
	// TODO: migrate to Durable Objects for atomic per-org counters.
	const newCount = await incrementUsage(c.env.KV, orgId, units);
	const countBefore = newCount - units;

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
