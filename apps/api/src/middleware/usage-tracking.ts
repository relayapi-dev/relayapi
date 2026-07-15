import { apiRequestLogs } from "@relayapi/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { parseCsv } from "../lib/csv-parser";
import type { getRequestDb } from "../lib/request-db";
import { sendNotificationToOrg } from "../services/notification-manager";
import {
	finalizeMutationUsage,
	reserveMutationUsage,
} from "../services/usage-meter";
import type { Env, Variables } from "../types";

/** KV is a display/notification hint only; PostgreSQL usage buckets are authoritative. */
export async function incrementUsage(
	kv: KVNamespace,
	orgId: string,
	amount = 1,
): Promise<number> {
	const current = await getUsageCount(kv, orgId);
	const projected = current + amount;
	await putUsageHint(kv, orgId, projected);
	return projected;
}

export async function getUsageCount(
	kv: KVNamespace,
	orgId: string,
): Promise<number> {
	const current = await kv.get(usageHintKey(orgId), "text");
	return current ? Number.parseInt(current, 10) || 0 : 0;
}

function usageHintKey(orgId: string, at = new Date()): string {
	return `usage:${orgId}:${usageMonth(at)}`;
}

function usageMonth(at = new Date()): string {
	return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function putUsageHint(
	kv: KVNamespace,
	orgId: string,
	count: number,
): Promise<void> {
	await kv.put(usageHintKey(orgId), String(count), {
		expirationTtl: 35 * 24 * 60 * 60,
	});
}

type UsageTrackingContext = Context<{
	Bindings: Env;
	Variables: Variables;
}>;

export function resolveBillingPeriod(
	periodStartIso?: string | null,
	periodEndIso?: string | null,
	at: Date = new Date(),
): { periodStart: Date; periodEnd: Date } {
	if (periodStartIso && periodEndIso) {
		const periodStart = new Date(periodStartIso);
		const periodEnd = new Date(periodEndIso);
		if (
			!Number.isNaN(periodStart.getTime()) &&
			!Number.isNaN(periodEnd.getTime()) &&
			periodEnd > periodStart
		) {
			return { periodStart, periodEnd };
		}
	}
	return {
		periodStart: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
		periodEnd: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
	};
}

const JSON_BULK_USAGE_FIELDS: Record<string, string> = {
	"/v1/posts/bulk": "posts",
	"/v1/contacts/bulk": "contacts",
	"/v1/contacts/bulk-operations": "contact_ids",
	"/v1/whatsapp/bulk-send": "recipients",
	"/v1/inbox/bulk": "targets",
};

function isJsonContentType(contentType: string | undefined): boolean {
	if (!contentType) return false;
	const mimeType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
	return mimeType === "application/json" || mimeType.endsWith("+json");
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

async function countBulkCsvUnits(c: UsageTrackingContext): Promise<number> {
	try {
		const formData = await c.req.raw.clone().formData();
		const file = formData.get("file");
		if (!(file instanceof File)) return 1;
		return Math.max(1, parseCsv(await file.text()).length);
	} catch {
		return 1;
	}
}

async function getUsageUnits(c: UsageTrackingContext): Promise<number> {
	if (c.req.method !== "POST") return 1;
	const field = JSON_BULK_USAGE_FIELDS[c.req.path];
	if (field) {
		const body =
			(c.get("parsedBody") as Record<string, unknown> | null | undefined) ??
			(await readJsonBodyFromClone(c));
		const items = body?.[field];
		return Array.isArray(items) ? Math.max(1, items.length) : 1;
	}
	if (c.req.path === "/v1/posts/bulk-csv") return countBulkCsvUnits(c);
	return 1;
}

async function persistApiLog(
	db: ReturnType<typeof getRequestDb>,
	entry: {
		orgId: string;
		keyId: string;
		method: string;
		path: string;
		statusCode: number;
		responseTimeMs: number;
		billable: boolean;
	},
): Promise<void> {
	try {
		await db.insert(apiRequestLogs).values({
			organizationId: entry.orgId,
			apiKeyId: entry.keyId,
			method: entry.method,
			path: entry.path,
			statusCode: entry.statusCode,
			responseTimeMs: entry.responseTimeMs,
			billable: entry.billable,
		});
	} catch (error) {
		console.error("API usage log persistence failed:", error);
	}
}

async function projectUsageWarning(
	c: UsageTrackingContext,
	committedUnits: number,
	includedUnits: number,
	unitsJustCommitted: number,
): Promise<void> {
	if (includedUnits <= 0) return;
	const before = Math.max(0, committedUnits - unitsJustCommitted);
	const percentBefore = Math.floor((before / includedUnits) * 100);
	const percentNow = Math.floor((committedUnits / includedUnits) * 100);
	for (const threshold of [80, 100] as const) {
		if (percentBefore >= threshold || percentNow < threshold) continue;
		const warningKey = `usage_warning:${c.get("orgId")}:${threshold}:${usageMonth()}`;
		if (await c.env.KV.get(warningKey)) continue;
		await sendNotificationToOrg(c.env, {
			type: "usage_warning",
			orgId: c.get("orgId"),
			title:
				threshold === 100
					? "API mutation limit reached"
					: "Approaching API mutation limit",
			body: `You've used ${committedUnits.toLocaleString()} of ${includedUnits.toLocaleString()} included mutations.`,
			data: {
				percentUsed: percentNow,
				callsUsed: committedUnits,
				callsIncluded: includedUnits,
				plan: c.get("plan"),
			},
			occurrenceId: warningKey,
		});
		await c.env.KV.put(warningKey, "1", {
			expirationTtl: 35 * 24 * 60 * 60,
		});
	}
}

export const usageTrackingMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const startedAt = Date.now();
	const orgId = c.get("orgId");
	const keyId = c.get("keyId");
	const isRead =
		c.req.method === "GET" ||
		c.req.method === "HEAD" ||
		c.req.method === "OPTIONS";

	if (isRead) {
		await next();
		c.executionCtx.waitUntil(
			persistApiLog(c.get("db"), {
				orgId,
				keyId,
				method: c.req.method,
				path: c.req.path,
				statusCode: c.res.status,
				responseTimeMs: Date.now() - startedAt,
				billable: false,
			}),
		);
		return;
	}

	const units = Math.min(1000, Math.max(1, await getUsageUnits(c)));
	const period = resolveBillingPeriod(c.get("periodStart"), c.get("periodEnd"));
	const decision = await reserveMutationUsage(c.get("db"), {
		organizationId: orgId,
		// The outer idempotency middleware suppresses active receipt replays. If a
		// receipt expires, using the same caller-supplied key is a new mutation and
		// must receive a new charge, so the usage ledger uses an execution identity.
		idempotencyKey: `request:${crypto.randomUUID()}`,
		units,
		includedUnits: c.get("callsIncluded"),
		periodStart: period.periodStart,
		periodEnd: period.periodEnd,
		hardLimit: c.get("plan") === "free",
	});

	if (!decision.ok) {
		const used = decision.committedUnits + decision.reservedUnits;
		c.header("X-Usage-Count", String(used));
		c.header("X-Usage-Limit", String(decision.includedUnits));
		c.executionCtx.waitUntil(
			persistApiLog(c.get("db"), {
				orgId,
				keyId,
				method: c.req.method,
				path: c.req.path,
				statusCode: 403,
				responseTimeMs: Date.now() - startedAt,
				billable: false,
			}),
		);
		return c.json(
			{
				error: {
					code: "FREE_LIMIT_REACHED",
					message: `Free plan limit reached (${decision.includedUnits} successful mutations per period). Upgrade to Pro to continue.`,
				},
			},
			403,
		);
	}

	const reservation = decision.reservation;
	c.header(
		"X-Usage-Count",
		String(reservation.committedUnits + reservation.reservedUnits),
	);
	c.header("X-Usage-Limit", String(reservation.includedUnits));

	let responseStatus = 500;
	try {
		await next();
		responseStatus = c.res.status;
	} catch (error) {
		await finalizeMutationUsage(c.get("db"), reservation, 500);
		throw error;
	}

	const finalized = await finalizeMutationUsage(
		c.get("db"),
		reservation,
		responseStatus,
	);
	const billable = responseStatus < 400;
	c.header("X-Usage-Count", String(finalized.committedUnits));
	c.header("X-Usage-Limit", String(finalized.includedUnits));

	c.executionCtx.waitUntil(
		Promise.all([
			persistApiLog(c.get("db"), {
				orgId,
				keyId,
				method: c.req.method,
				path: c.req.path,
				statusCode: responseStatus,
				responseTimeMs: Date.now() - startedAt,
				billable,
			}),
			putUsageHint(c.env.KV, orgId, finalized.committedUnits),
			...(billable
				? [
						projectUsageWarning(
							c,
							finalized.committedUnits,
							finalized.includedUnits,
							reservation.units,
						),
					]
				: []),
		]),
	);
});
