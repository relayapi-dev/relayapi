import { adCampaigns, ads, and, apiRequestLogs, eq } from "@relayapi/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { matchedRoutes } from "hono/route";
import { parseCsv } from "../lib/csv-parser";
import {
	instrumentMutationDatabase,
	MutationEffectTracker,
} from "../lib/mutation-effect";
import { getMutationEffectCoveragePolicy } from "../lib/mutation-effect-policy";
import type { getRequestDb } from "../lib/request-db";
import {
	ensureComplimentaryBillingAuthority,
	ensureHostedFreeUsageAuthority,
} from "../services/billing-periods";
import { sendNotificationToOrg } from "../services/notification-manager";
import { reconcileStripeBillingAuthority } from "../services/stripe-billing-authority";
import {
	armUsageReservationProviderBoundary,
	BillingAuthorityPendingError,
	finalizeMutationUsage,
	reserveMutationUsage,
	resolveSuccessfulMutationAuthority,
	type SuccessfulMutationAuthority,
	successfulMutationDisposition,
	type UsageDisposition,
	type UsageReservationDecision,
} from "../services/usage-meter";
import type { Env, Variables } from "../types";

/** KV is a display/notification hint only; PostgreSQL usage buckets are authoritative. */
export async function incrementUsage(
	kv: KVNamespace,
	orgId: string,
	amount = 1,
): Promise<number> {
	if (!Number.isSafeInteger(amount) || amount < 0) {
		throw new Error("Usage hint increment must be a nonnegative safe integer");
	}
	const current = await getUsageCount(kv, orgId);
	const projected = current + amount;
	if (!Number.isSafeInteger(projected)) {
		throw new Error("Usage hint exceeds Number.MAX_SAFE_INTEGER");
	}
	await putUsageHint(kv, orgId, projected);
	return projected;
}

export async function getUsageCount(
	kv: KVNamespace,
	orgId: string,
): Promise<number> {
	const current = await kv.get(usageHintKey(orgId), "text");
	if (!current) return 0;
	const parsed = Number(current);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
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
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new Error("Usage hint must be a nonnegative safe integer");
	}
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

type JsonObject = Record<string, unknown>;

type SpendAuthority = {
	status: string;
	dailyBudgetCents: number | null;
	lifetimeBudgetCents: number | null;
};

/**
 * Classify only pure spend-stop mutations. Naming/targeting changes and any
 * budget increase remain ordinary billable mutations, even when bundled with
 * a pause, so this escape hatch cannot be used as a general quota bypass.
 */
export function isEmergencySpendMutation(
	current: SpendAuthority,
	body: JsonObject,
	allowedKeys: readonly string[],
): boolean {
	if (Object.keys(body).some((key) => !allowedKeys.includes(key))) return false;
	if (body.status !== undefined && body.status !== "paused") return false;
	const compareBudget = (
		value: unknown,
		existing: number | null,
	): { safe: boolean; decreased: boolean } => {
		if (value === undefined) return { safe: true, decreased: false };
		if (
			!Number.isSafeInteger(value) ||
			(value as number) < 0 ||
			existing === null
		) {
			return { safe: false, decreased: false };
		}
		return {
			safe: (value as number) <= existing,
			decreased: (value as number) < existing,
		};
	};
	const daily = compareBudget(
		body.daily_budget_cents,
		current.dailyBudgetCents,
	);
	const lifetime = compareBudget(
		body.lifetime_budget_cents,
		current.lifetimeBudgetCents,
	);
	if (!daily.safe || !lifetime.safe) return false;
	return body.status === "paused" || daily.decreased || lifetime.decreased;
}

async function isEmergencySpendControl(
	c: UsageTrackingContext,
	db: ReturnType<typeof getRequestDb>,
): Promise<boolean> {
	if (c.req.method === "DELETE") {
		return (
			/^\/v1\/ads\/[^/]+$/.test(c.req.path) ||
			/^\/v1\/ads\/campaigns\/[^/]+$/.test(c.req.path)
		);
	}
	if (c.req.method !== "PATCH") return false;
	const campaignMatch = c.req.path.match(/^\/v1\/ads\/campaigns\/([^/]+)$/);
	const adMatch = c.req.path.match(/^\/v1\/ads\/([^/]+)$/);
	if (!campaignMatch && !adMatch) return false;
	const body = c.get("parsedBody");
	if (!body) return false;
	const id = decodeURIComponent((campaignMatch ?? adMatch)?.[1] ?? "");
	if (!id) return false;
	const organizationId = c.get("orgId");
	if (campaignMatch) {
		const [current] = await db
			.select({
				status: adCampaigns.status,
				dailyBudgetCents: adCampaigns.dailyBudgetCents,
				lifetimeBudgetCents: adCampaigns.lifetimeBudgetCents,
			})
			.from(adCampaigns)
			.where(
				and(
					eq(adCampaigns.id, id),
					eq(adCampaigns.organizationId, organizationId),
				),
			)
			.limit(1);
		return current
			? isEmergencySpendMutation(current, body, [
					"status",
					"daily_budget_cents",
					"lifetime_budget_cents",
				])
			: false;
	}
	const [current] = await db
		.select({
			status: ads.status,
			dailyBudgetCents: ads.dailyBudgetCents,
			lifetimeBudgetCents: ads.lifetimeBudgetCents,
		})
		.from(ads)
		.where(and(eq(ads.id, id), eq(ads.organizationId, organizationId)))
		.limit(1);
	return current
		? isEmergencySpendMutation(current, body, [
				"status",
				"daily_budget_cents",
				"lifetime_budget_cents",
			])
		: false;
}

function asJsonObject(value: unknown): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function safeCommittedUnits(
	value: unknown,
	reservedUnits: number,
): number | null {
	return Number.isSafeInteger(value) &&
		(value as number) >= 0 &&
		(value as number) <= reservedUnits
		? (value as number)
		: null;
}

/**
 * Exact response authority for every N-unit bulk reservation. Keep this public
 * so route/schema contract tests fail if a response field is renamed without
 * updating billing settlement in the same change.
 */
export const BULK_USAGE_COMMITTED_FIELDS = {
	"/v1/posts/bulk": ["summary", "succeeded"],
	"/v1/posts/bulk-csv": ["summary", "posts_created"],
	"/v1/contacts/bulk": ["created"],
	"/v1/contacts/bulk-operations": ["affected"],
	"/v1/whatsapp/bulk-send": ["recipient_count"],
	"/v1/inbox/bulk": ["processed"],
} as const satisfies Record<string, readonly string[]>;

function committedUnitsFromBulkResponse(
	path: string,
	payload: JsonObject,
	reservedUnits: number,
): number | null {
	const fields = (
		BULK_USAGE_COMMITTED_FIELDS as Record<string, readonly string[] | undefined>
	)[path];
	if (!fields) return null;
	let candidate: unknown = payload;
	for (const field of fields) {
		candidate = asJsonObject(candidate)?.[field];
	}
	return safeCommittedUnits(candidate, reservedUnits);
}

function isBulkUsagePath(path: string): boolean {
	return path === "/v1/posts/bulk-csv" || path in JSON_BULK_USAGE_FIELDS;
}

function isDryRunCsvRequest(c: UsageTrackingContext): boolean {
	return (
		c.req.method === "POST" &&
		c.req.path === "/v1/posts/bulk-csv" &&
		new URL(c.req.url).searchParams.get("dry_run") === "true"
	);
}

const READ_ONLY_POST_PATHS = new Set([
	"/v1/auto-post-rules/test-feed",
	"/v1/short-links/test",
	"/v1/tools/validate/post",
	"/v1/tools/validate/media",
	"/v1/tools/validate/post-length",
	"/v1/tools/instagram/hashtag-checker",
	"/v1/tools/linkedin/resolve-mention",
]);

/** POST-shaped probes and simulations that the public pricing contract treats as reads. */
function isReadOnlyPostAction(method: string, path: string): boolean {
	return (
		method === "POST" &&
		(READ_ONLY_POST_PATHS.has(path) ||
			/^\/v1\/automations\/[^/]+\/simulate\/?$/.test(path))
	);
}

/** Reject router fall-through: middleware-only matches are not API actions. */
function hasTerminalMethodRoute(c: UsageTrackingContext): boolean {
	return matchedRoutes(c).some((route) => route.method === c.req.method);
}

async function settleMutationDisposition(
	c: UsageTrackingContext,
	responseStatus: number,
	reservedUnits: number,
): Promise<{ disposition: UsageDisposition; committedUnits: number }> {
	if (responseStatus >= 400) {
		const evidence = c.get("mutationEffectTracker")?.outcome(reservedUnits);
		if (evidence?.kind === "committed") {
			return {
				disposition: {
					commit: true,
					reason: "settled",
					responseStatus,
					committedUnits: evidence.units,
				},
				committedUnits: evidence.units,
			};
		}
		if (evidence?.kind === "not_applied") {
			return {
				disposition: {
					commit: false,
					reason: responseStatus >= 500 ? "proven_not_applied" : "rejected",
					responseStatus,
					committedUnits: 0,
				},
				committedUnits: 0,
			};
		}
		return {
			disposition: {
				commit: true,
				reason: "unknown",
				responseStatus: null,
			},
			committedUnits: 0,
		};
	}
	if (!isBulkUsagePath(c.req.path)) {
		const tracker = c.get("mutationEffectTracker");
		const authoritative = tracker?.routeAuthoritativeOutcome(reservedUnits);
		if (authoritative?.kind === "unknown") {
			return {
				disposition: {
					commit: true,
					reason: "unknown",
					responseStatus: null,
				},
				committedUnits: 0,
			};
		}
		if (authoritative?.kind === "not_applied") {
			return {
				disposition: successfulMutationDisposition(responseStatus, 0),
				committedUnits: 0,
			};
		}
		if (authoritative?.kind === "committed") {
			return {
				disposition: successfulMutationDisposition(
					responseStatus,
					authoritative.units,
				),
				committedUnits: authoritative.units,
			};
		}
		if (
			getMutationEffectCoveragePolicy(c.req.method, c.req.path) ===
			"postgres_complete"
		) {
			const evidence = tracker?.outcome(reservedUnits);
			if (evidence?.kind === "unknown") {
				return {
					disposition: {
						commit: true,
						reason: "unknown",
						responseStatus: null,
					},
					committedUnits: 0,
				};
			}
			if (evidence?.kind === "not_applied") {
				return {
					disposition: successfulMutationDisposition(responseStatus, 0),
					committedUnits: 0,
				};
			}
			if (evidence?.kind === "committed") {
				return {
					disposition: successfulMutationDisposition(
						responseStatus,
						evidence.units,
					),
					committedUnits: evidence.units,
				};
			}
		}
		return {
			disposition: successfulMutationDisposition(responseStatus, reservedUnits),
			committedUnits: reservedUnits,
		};
	}

	try {
		const contentType = c.res.headers.get("content-type") ?? undefined;
		if (!isJsonContentType(contentType))
			throw new Error("non-JSON bulk response");
		const payload = asJsonObject(await c.res.clone().json());
		const committedUnits = payload
			? committedUnitsFromBulkResponse(c.req.path, payload, reservedUnits)
			: null;
		if (committedUnits === null) throw new Error("invalid bulk outcome count");
		const reconciled = c
			.get("mutationEffectTracker")
			?.reconcileAuthoritativeCommittedUnits(reservedUnits, committedUnits);
		if (!reconciled || reconciled.kind === "unknown") {
			throw new Error("bulk outcome conflicts with mutation-effect evidence");
		}
		return {
			disposition: successfulMutationDisposition(
				responseStatus,
				committedUnits,
			),
			committedUnits,
		};
	} catch {
		// A successful bulk response without authoritative outcome evidence must
		// not silently charge N or release N. Keep the reservation parked for the
		// durable reconciler/operator path to establish K.
		return {
			disposition: {
				commit: true,
				reason: "unknown",
				responseStatus: null,
			},
			committedUnits: 0,
		};
	}
}

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

/**
 * Resolve and, at most once, repair hosted paid usage authority. The initial
 * live read also handles stale edge projections that are already repair-complete
 * in PostgreSQL without making a provider request.
 */
async function repairSuccessfulMutationAuthority(
	c: UsageTrackingContext,
	db: ReturnType<typeof getRequestDb>,
	now: Date,
): Promise<SuccessfulMutationAuthority | null> {
	let resolution = await resolveSuccessfulMutationAuthority(
		db,
		c.get("orgId"),
		now,
		{ includeUsageSnapshot: false },
	);
	if (resolution.state === "ready") return resolution.authority;

	if (resolution.billingSource === "complimentary") {
		await ensureComplimentaryBillingAuthority(db, {
			organizationId: c.get("orgId"),
		});
	} else {
		const repaired = await reconcileStripeBillingAuthority(c.env, db, {
			organizationId: c.get("orgId"),
			now,
		});
		if (repaired.state === "pending") return null;
	}

	resolution = await resolveSuccessfulMutationAuthority(
		db,
		c.get("orgId"),
		now,
		{ includeUsageSnapshot: false },
	);
	return resolution.state === "ready" ? resolution.authority : null;
}

function pendingBillingAuthorityResponse(
	c: UsageTrackingContext,
	db: ReturnType<typeof getRequestDb>,
	startedAt: number,
): Response {
	c.header("Retry-After", "5");
	c.executionCtx.waitUntil(
		persistApiLog(db, {
			orgId: c.get("orgId"),
			keyId: c.get("keyId"),
			method: c.req.method,
			path: c.req.path,
			statusCode: 503,
			responseTimeMs: Date.now() - startedAt,
			billable: false,
		}),
	);
	return c.json(
		{
			error: {
				code: "BILLING_AUTHORITY_PENDING",
				message: "Billing authority is being reconciled; retry shortly",
			},
		},
		503,
	);
}

async function projectUsageWarning(
	c: UsageTrackingContext,
	committedUnits: number,
	includedUnits: number,
	unitsJustCommitted: number,
	periodIdentity: string,
	periodEnd: Date,
): Promise<void> {
	if (includedUnits <= 0) return;
	const before = Math.max(0, committedUnits - unitsJustCommitted);
	const percentBefore = Math.floor((before / includedUnits) * 100);
	const percentNow = Math.floor((committedUnits / includedUnits) * 100);
	for (const threshold of [80, 100] as const) {
		if (percentBefore >= threshold || percentNow < threshold) continue;
		const warningKey = `usage-warning:${c.get("orgId")}:${threshold}:${periodIdentity}`;
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
		const ttlSeconds = Math.max(
			60,
			Math.ceil((periodEnd.getTime() - Date.now()) / 1_000) + 24 * 60 * 60,
		);
		await c.env.KV.put(warningKey, "1", { expirationTtl: ttlSeconds });
	}
}

export const usageTrackingMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const startedAt = Date.now();
	const orgId = c.get("orgId");
	const keyId = c.get("keyId");
	const db = c.get("db");
	const mutationEffects = new MutationEffectTracker();
	c.set("mutationEffectTracker", mutationEffects);
	const mutationCoverage = getMutationEffectCoveragePolicy(
		c.req.method,
		c.req.path,
	);
	const markMutationRouteEntered = () => {
		mutationEffects.markRouteEntered();
		if (mutationCoverage !== "incomplete") {
			mutationEffects.markCoverageComplete();
		}
	};
	const isEmergencyControl = await isEmergencySpendControl(c, db);
	const isNonBillable =
		c.req.method === "GET" ||
		c.req.method === "HEAD" ||
		c.req.method === "OPTIONS" ||
		c.req.path === "/v1/billing" ||
		c.req.path.startsWith("/v1/billing/") ||
		isReadOnlyPostAction(c.req.method, c.req.path) ||
		isDryRunCsvRequest(c) ||
		isEmergencyControl ||
		!hasTerminalMethodRoute(c);

	if (isNonBillable) {
		c.set("db", instrumentMutationDatabase(db, mutationEffects));
		markMutationRouteEntered();
		await next();
		c.executionCtx.waitUntil(
			persistApiLog(db, {
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

	const transitionAt = c.get("billingTransitionAt")
		? new Date(c.get("billingTransitionAt") ?? "")
		: null;
	if (
		transitionAt &&
		!Number.isNaN(transitionAt.getTime()) &&
		transitionAt <= new Date()
	) {
		const transitioned = await ensureHostedFreeUsageAuthority(db, {
			organizationId: orgId,
		});
		if (transitioned) {
			c.executionCtx.waitUntil(c.env.KV.delete(`apikey:${c.get("keyHash")}`));
		}
	}

	const now = new Date();
	const units = Math.min(1000, Math.max(1, await getUsageUnits(c)));
	const period = resolveBillingPeriod(c.get("periodStart"), c.get("periodEnd"));
	let authority: SuccessfulMutationAuthority = {
		quotaMode: c.get("quotaMode"),
		includedUnits: c.get("callsIncluded"),
		periodStart: period.periodStart,
		periodEnd: period.periodEnd,
		billingPeriodId:
			c.get("billingSource") === "stripe" ||
			c.get("billingSource") === "complimentary"
				? c.get("billingPeriodId")
				: null,
	};
	const billingSource = c.get("billingSource");
	if (billingSource === "complimentary") {
		await ensureComplimentaryBillingAuthority(db, { organizationId: orgId });
	}
	let repairAttempted = false;
	if (c.get("billingAuthorityState") === "pending") {
		repairAttempted = true;
		const repaired = await repairSuccessfulMutationAuthority(c, db, now);
		if (!repaired) return pendingBillingAuthorityResponse(c, db, startedAt);
		authority = repaired;
		c.executionCtx.waitUntil(c.env.KV.delete(`apikey:${c.get("keyHash")}`));
	}

	const reserve = (
		resolvedAuthority: SuccessfulMutationAuthority,
	): Promise<UsageReservationDecision> =>
		reserveMutationUsage(db, {
			organizationId: orgId,
			// The outer idempotency middleware suppresses active receipt replays. If a
			// receipt expires, using the same caller-supplied key is a new mutation and
			// must receive a new charge, so the usage ledger uses an execution identity.
			idempotencyKey: `request:${crypto.randomUUID()}`,
			units,
			...resolvedAuthority,
			billingAuthorityState: "ready",
		});

	let decision: UsageReservationDecision;
	try {
		decision = await reserve(authority);
	} catch (error) {
		if (!(error instanceof BillingAuthorityPendingError)) throw error;
		if (repairAttempted)
			return pendingBillingAuthorityResponse(c, db, startedAt);
		repairAttempted = true;
		const repaired = await repairSuccessfulMutationAuthority(c, db, now);
		if (!repaired) return pendingBillingAuthorityResponse(c, db, startedAt);
		c.executionCtx.waitUntil(c.env.KV.delete(`apikey:${c.get("keyHash")}`));
		try {
			decision = await reserve(repaired);
		} catch (retryError) {
			if (retryError instanceof BillingAuthorityPendingError) {
				return pendingBillingAuthorityResponse(c, db, startedAt);
			}
			throw retryError;
		}
	}
	if (decision.selfHealed) {
		c.executionCtx.waitUntil(c.env.KV.delete(`apikey:${c.get("keyHash")}`));
	}

	if (!decision.ok) {
		const used = decision.committedUnits + decision.reservedUnits;
		c.header("X-Usage-Count", String(used));
		c.header("X-Usage-Limit", String(decision.includedUnits));
		c.executionCtx.waitUntil(
			persistApiLog(db, {
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
					message: `Usage limit reached (${decision.includedUnits} successful mutations per period). Upgrade or wait for the next period to continue.`,
				},
			},
			403,
		);
	}

	const reservation = decision.reservation;
	c.set("usageReservation", reservation);
	c.header(
		"X-Usage-Count",
		String(reservation.committedUnits + reservation.reservedUnits),
	);
	c.header(
		"X-Usage-Limit",
		reservation.includedUnits === null
			? "unlimited"
			: String(reservation.includedUnits),
	);

	let responseStatus = 500;
	await armUsageReservationProviderBoundary(db, reservation);
	// From this point onward, route-owned PostgreSQL writes produce monotonic
	// effect evidence. Reservation/auth/idempotency bookkeeping above is excluded.
	c.set("db", instrumentMutationDatabase(db, mutationEffects));
	markMutationRouteEntered();
	try {
		await next();
		responseStatus = c.res.status;
	} catch (error) {
		const settlement = await settleMutationDisposition(
			c,
			500,
			reservation.units,
		);
		await finalizeMutationUsage(db, reservation, settlement.disposition);
		throw error;
	}

	const settlement = await settleMutationDisposition(
		c,
		responseStatus,
		reservation.units,
	);
	const finalized = await finalizeMutationUsage(
		db,
		reservation,
		settlement.disposition,
	);
	// A durable route may already have settled this request's reservation (for
	// example, a no-op retry adopts the original operation and sets this K=0).
	// Logs and warnings must use the authoritative ledger K, not the provisional
	// response-derived disposition.
	const billable = finalized.reservationCommittedUnits > 0;
	c.header("X-Usage-Count", String(finalized.committedUnits));
	c.header(
		"X-Usage-Limit",
		finalized.includedUnits === null
			? "unlimited"
			: String(finalized.includedUnits),
	);

	c.executionCtx.waitUntil(
		Promise.all([
			persistApiLog(db, {
				orgId,
				keyId,
				method: c.req.method,
				path: c.req.path,
				statusCode: responseStatus,
				responseTimeMs: Date.now() - startedAt,
				billable,
			}),
			putUsageHint(c.env.KV, orgId, finalized.committedUnits),
			...(billable && finalized.includedUnits !== null
				? [
						projectUsageWarning(
							c,
							finalized.committedUnits,
							finalized.includedUnits,
							finalized.reservationCommittedUnits,
							reservation.bucketId,
							reservation.periodEnd,
						),
					]
				: []),
		]),
	);
});
