import {
	API_KEY_CACHE_TTL_SECONDS,
	API_KEY_NEGATIVE_CACHE_TTL_SECONDS,
	apiKeyCacheTtl,
	dailyToolLimitForPlan,
	getBillingPolicy,
	hasCurrentDashboardCredentialPermissions,
	PRICING,
} from "@relayapi/config";
import {
	apikey,
	billingPeriods,
	type Database,
	LEGACY_CREDENTIAL_VERSION,
	member,
	organization,
	organizationPrincipals,
	organizationSubscriptions,
	principalWorkspaceGrants,
	usageBuckets,
	user,
} from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { parseApiKeyWorkspaceScope } from "../lib/api-key-workspace-scope";
import { deploymentEntitlements } from "../lib/deployment-mode";
import type { Env, KVKeyData, Variables } from "../types";

const API_KEY_PREFIXES = ["rlay_live_", "rlay_test_"];

function normalizedCredentialVersion(value: string | null | undefined): string {
	return value || LEGACY_CREDENTIAL_VERSION;
}

function hasActiveBan(
	value: { banned: boolean | null; banExpires: Date | null },
	now = new Date(),
): boolean {
	return (
		value.banned === true &&
		(value.banExpires === null || value.banExpires > now)
	);
}

function normalizedPermissions(
	value: string | readonly string[] | null | undefined,
): string[] {
	const permissions: readonly string[] =
		typeof value === "string" ? value.split(",") : (value ?? ["read", "write"]);
	return [
		...new Set(
			permissions.map((permission) => permission.trim()).filter(Boolean),
		),
	].sort();
}

function permissionsMatch(
	stored: string | null | undefined,
	projected: readonly string[],
): boolean {
	return (
		JSON.stringify(normalizedPermissions(stored)) ===
		JSON.stringify(normalizedPermissions(projected))
	);
}

/**
 * KV cache lifetime for an API key record. Acts as a passive backstop:
 * if a key is mutated in the DB without going through an explicit
 * invalidation path (DELETE endpoint, Stripe webhook, invoice generator),
 * the change still takes effect within this window. Active invalidation
 * paths bypass this entirely.
 *
 * Kept short (10 min) so an out-of-band revoke/disable (direct DB/admin
 * update, or a Better Auth apiKey() route) stops authenticating within
 * minutes rather than a full day. The miss path is a single LEFT JOIN
 * (~100ms) with the KV write-back deferred via waitUntil, so once-per-
 * window rehydration per key per colo is cheap.
 */
export const API_KEY_KV_TTL_SECONDS = API_KEY_CACHE_TTL_SECONDS;

/**
 * KV TTL for the negative (tombstone) cache entry written when a
 * well-formed-but-invalid key is looked up. Bounds how long a revoked/
 * unknown key keeps short-circuiting at the edge without a DB round trip.
 * KV enforces a 60s minimum TTL.
 */
export const API_KEY_NEGATIVE_KV_TTL_SECONDS =
	API_KEY_NEGATIVE_CACHE_TTL_SECONDS;

/** Sentinel stored in KV to mark a well-formed key as known-invalid. */
const NEGATIVE_CACHE_VALUE = '{"invalid":true}';

/**
 * Compute the actual TTL to use when writing a key to KV — clamps the
 * backstop window (API_KEY_KV_TTL_SECONDS) against the key's own expiry
 * so we never cache past it. KV requires a minimum TTL of 60s.
 */
export function kvTtlForKey(expiresAt: Date | string | null): number {
	return apiKeyCacheTtl(expiresAt);
}

export async function hashKey(key: string): Promise<string> {
	const encoded = new TextEncoder().encode(key);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Rebuild the KV cache for an API key from the database. Returns null if
 * the key doesn't exist, is disabled, has no org, or is expired. On
 * success, writes the rebuilt record to KV with the standard TTL.
 *
 * Pass `waitUntil` (from the request's ExecutionContext) to defer the KV
 * write off the response path; without it the write is awaited.
 */
export async function hydrateApiKey(
	env: Env,
	hashedKey: string,
	db: Database,
	waitUntil?: (p: Promise<unknown>) => void,
): Promise<KVKeyData | null> {
	// Single round trip: key row + its org's subscription via LEFT JOIN.
	// These were two serialized queries (~2x origin RTT) before.
	const [joined] = await db
		.select({
			id: apikey.id,
			keyCredentialVersion: apikey.credentialVersion,
			organizationId: apikey.organizationId,
			enabled: apikey.enabled,
			expiresAt: apikey.expiresAt,
			permissions: apikey.permissions,
			principalId: apikey.principalId,
			principalKind: organizationPrincipals.kind,
			principalScopeMode: organizationPrincipals.scopeMode,
			principalUserId: member.userId,
			memberRole: member.role,
			liveUserId: user.id,
			userBanned: user.banned,
			userBanExpires: user.banExpires,
			userCredentialVersion: user.credentialVersion,
			organizationLifecycleStatus: organization.lifecycleStatus,
			subStatus: organizationSubscriptions.status,
			subSource: organizationSubscriptions.source,
			subAiEnabled: organizationSubscriptions.aiEnabled,
			subDailyToolLimitOverride:
				organizationSubscriptions.dailyToolLimitOverride,
			subStripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
			subTrialEndsAt: organizationSubscriptions.trialEndsAt,
			subDelinquentAt: organizationSubscriptions.delinquentAt,
			subGraceEndsAt: organizationSubscriptions.graceEndsAt,
			subCurrentPeriodStart: organizationSubscriptions.currentPeriodStart,
			subCurrentPeriodEnd: organizationSubscriptions.currentPeriodEnd,
			subUpdatedAt: organizationSubscriptions.updatedAt,
			billingPeriodId: billingPeriods.id,
			billingPeriodSource: billingPeriods.source,
			billingPeriodBillable: billingPeriods.billable,
			billingPeriodQuotaMode: billingPeriods.quotaMode,
			billingPeriodIncludedUnits: billingPeriods.includedUnits,
			billingPeriodProviderCycleAnchor: billingPeriods.providerCycleAnchor,
			billingPeriodStripeSubscriptionId: billingPeriods.stripeSubscriptionId,
			billingPeriodStart: billingPeriods.periodStart,
			billingPeriodEnd: billingPeriods.periodEnd,
			usageBucketId: usageBuckets.id,
			usageBucketPeriodStart: usageBuckets.periodStart,
			usageBucketPeriodEnd: usageBuckets.periodEnd,
			usageBucketQuotaMode: usageBuckets.quotaMode,
			usageBucketIncludedUnits: usageBuckets.includedUnits,
		})
		.from(apikey)
		.innerJoin(organization, eq(organization.id, apikey.organizationId))
		.innerJoin(
			organizationPrincipals,
			and(
				eq(organizationPrincipals.id, apikey.principalId),
				eq(organizationPrincipals.organizationId, apikey.organizationId),
				eq(organizationPrincipals.lifecycleStatus, "active"),
			),
		)
		.leftJoin(
			member,
			and(
				eq(member.id, organizationPrincipals.memberId),
				eq(member.organizationId, organizationPrincipals.organizationId),
			),
		)
		.leftJoin(user, eq(user.id, member.userId))
		.leftJoin(
			organizationSubscriptions,
			eq(organizationSubscriptions.organizationId, apikey.organizationId),
		)
		.leftJoin(
			billingPeriods,
			and(
				eq(billingPeriods.organizationId, apikey.organizationId),
				eq(billingPeriods.state, "open"),
				sql`${billingPeriods.periodStart} <= statement_timestamp()`,
				sql`${billingPeriods.periodEnd} > statement_timestamp()`,
			),
		)
		.leftJoin(
			usageBuckets,
			and(
				eq(usageBuckets.billingPeriodId, billingPeriods.id),
				eq(usageBuckets.organizationId, apikey.organizationId),
				eq(usageBuckets.metric, "successful_mutation"),
			),
		)
		.where(eq(apikey.key, hashedKey))
		.limit(1);
	const invalidMemberCredential =
		joined?.principalKind === "member" &&
		(!joined.principalUserId ||
			joined.liveUserId !== joined.principalUserId ||
			!hasCurrentDashboardCredentialPermissions(
				joined.permissions,
				joined.memberRole,
			) ||
			hasActiveBan({
				banned: joined.userBanned,
				banExpires: joined.userBanExpires,
			}) ||
			normalizedCredentialVersion(joined.keyCredentialVersion) !==
				normalizedCredentialVersion(joined.userCredentialVersion));

	if (
		!joined ||
		joined.enabled === false ||
		!joined.organizationId ||
		joined.organizationLifecycleStatus !== "active" ||
		(joined.expiresAt && joined.expiresAt < new Date()) ||
		invalidMemberCredential
	) {
		// Negative cache: write a short-lived tombstone so a misconfigured
		// client or an attacker replaying one revoked/unknown key doesn't
		// turn every request into a blocking origin DB round trip. Key
		// creation/re-enable overwrites `apikey:<hash>` with the real record,
		// so a newly valid key is never blocked by a stale tombstone.
		const tombstone = env.KV.put(`apikey:${hashedKey}`, NEGATIVE_CACHE_VALUE, {
			expirationTtl: API_KEY_NEGATIVE_KV_TTL_SECONDS,
		});
		if (waitUntil) waitUntil(tombstone);
		else await tombstone;
		return null;
	}

	const row = joined;
	const sub = {
		status: joined.subStatus,
		aiEnabled: joined.subAiEnabled,
		dailyToolLimitOverride: joined.subDailyToolLimitOverride,
	};

	const billing = getBillingPolicy({
		status: sub.status,
		source: joined.subSource,
		stripeSubscriptionId: joined.subStripeSubscriptionId,
		trialEndsAt: joined.subTrialEndsAt,
		delinquentAt: joined.subDelinquentAt,
		graceEndsAt: joined.subGraceEndsAt,
		currentPeriodStart: joined.subCurrentPeriodStart,
		currentPeriodEnd: joined.subCurrentPeriodEnd,
	});
	const selfHosted = deploymentEntitlements(env);
	const plan = selfHosted?.plan ?? billing.entitlement;
	const hasMatchingUsageBucket = Boolean(
		joined.usageBucketId &&
			joined.billingPeriodStart &&
			joined.billingPeriodEnd &&
			joined.usageBucketPeriodStart?.getTime() ===
				joined.billingPeriodStart.getTime() &&
			joined.usageBucketPeriodEnd?.getTime() ===
				joined.billingPeriodEnd.getTime() &&
			joined.usageBucketQuotaMode === joined.billingPeriodQuotaMode &&
			joined.usageBucketIncludedUnits === joined.billingPeriodIncludedUnits,
	);
	const hasMatchingStripeAgreement = Boolean(
		joined.subSource !== "stripe" ||
			(joined.billingPeriodSource === "stripe" &&
				joined.subStripeSubscriptionId &&
				joined.billingPeriodStripeSubscriptionId ===
					joined.subStripeSubscriptionId &&
				joined.subCurrentPeriodStart &&
				joined.subCurrentPeriodEnd &&
				joined.billingPeriodProviderCycleAnchor?.getTime() ===
					joined.subCurrentPeriodStart.getTime() &&
				joined.billingPeriodEnd?.getTime() ===
					joined.subCurrentPeriodEnd.getTime()),
	);
	const hasCurrentBillingAuthority = Boolean(
		!selfHosted &&
			plan === "pro" &&
			joined.billingPeriodId &&
			joined.billingPeriodStart &&
			joined.billingPeriodEnd &&
			joined.billingPeriodSource === joined.subSource &&
			joined.billingPeriodBillable === billing.billable &&
			joined.billingPeriodQuotaMode === billing.quotaMode &&
			hasMatchingUsageBucket &&
			hasMatchingStripeAgreement,
	);
	const hasCurrentStripePeriodWindow = Boolean(
		!selfHosted &&
			joined.billingPeriodSource === "stripe" &&
			joined.billingPeriodId &&
			joined.billingPeriodStart &&
			joined.billingPeriodEnd,
	);
	const billingAuthorityState: "ready" | "pending" =
		selfHosted || plan === "free" || hasCurrentBillingAuthority
			? "ready"
			: "pending";
	const callsIncluded = selfHosted
		? selfHosted.callsIncluded
		: plan === "free"
			? PRICING.freeCallsIncluded
			: billingAuthorityState === "pending"
				? 0
				: (joined.billingPeriodIncludedUnits ?? PRICING.proCallsIncluded);
	const now = new Date();
	const nextBoundary = [
		joined.subGraceEndsAt,
		joined.subTrialEndsAt,
		joined.subCurrentPeriodEnd,
		joined.billingPeriodEnd,
	]
		.filter((value): value is Date => Boolean(value && value > now))
		.sort((left, right) => left.getTime() - right.getTime())[0];
	const billingTransitionAt =
		hasCurrentStripePeriodWindow && joined.subSource === "stripe"
			? joined.subStatus === "past_due"
				? joined.subGraceEndsAt
				: joined.subStatus === "trialing"
					? joined.subTrialEndsAt
					: joined.subStatus === "cancelled"
						? joined.subUpdatedAt
						: null
			: null;

	const permissionsArray = (row.permissions ?? "read,write")
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);

	const workspaceScope: "all" | string[] =
		row.principalScopeMode === "all"
			? "all"
			: (
					await db
						.select({
							workspaceId: principalWorkspaceGrants.workspaceId,
						})
						.from(principalWorkspaceGrants)
						.where(
							and(
								eq(principalWorkspaceGrants.organizationId, row.organizationId),
								eq(principalWorkspaceGrants.principalId, row.principalId),
							),
						)
				)
					.map((grant) => grant.workspaceId)
					.sort();

	// Carry the Stripe billing period only for active (pro) subs that have it —
	// usage records key on it so the included-allowance window matches the
	// charged window. Free orgs fall back to calendar month downstream.
	const data: KVKeyData = {
		org_id: joined.organizationId,
		key_id: row.id,
		permissions: permissionsArray,
		workspace_scope: workspaceScope,
		principal_type:
			row.principalKind === "member" ? "dashboard_user" : "service",
		principal_id: row.principalId,
		principal_user_id: row.principalUserId ?? null,
		expires_at: row.expiresAt?.toISOString() ?? null,
		plan,
		quota_mode:
			selfHosted?.quotaMode ??
			(plan === "free"
				? "hard"
				: billingAuthorityState === "pending"
					? "hard"
					: (joined.billingPeriodQuotaMode ?? billing.quotaMode)),
		calls_included: callsIncluded,
		billing_source: selfHosted
			? "self_hosted"
			: plan === "free"
				? "free"
				: billingAuthorityState === "ready"
					? (joined.billingPeriodSource ?? joined.subSource ?? "stripe")
					: (joined.subSource ?? "stripe"),
		billable: selfHosted
			? false
			: plan === "pro"
				? billingAuthorityState === "ready" &&
					(joined.billingPeriodBillable ?? billing.billable)
				: false,
		billing_period_id: hasCurrentBillingAuthority
			? (joined.billingPeriodId ?? null)
			: null,
		billing_authority_state: billingAuthorityState,
		ai_enabled: selfHosted?.aiEnabled ?? sub?.aiEnabled ?? false,
		daily_tool_limit: selfHosted
			? null
			: dailyToolLimitForPlan(plan, sub?.dailyToolLimitOverride),
		period_start: hasCurrentBillingAuthority
			? (joined.billingPeriodStart?.toISOString() ?? null)
			: null,
		period_end: hasCurrentBillingAuthority
			? (joined.billingPeriodEnd?.toISOString() ?? null)
			: null,
		entitlement_recheck_at: selfHosted
			? null
			: (nextBoundary?.toISOString() ?? null),
		billing_transition_at: billingTransitionAt?.toISOString() ?? null,
	};

	const kvWrite = env.KV.put(`apikey:${hashedKey}`, JSON.stringify(data), {
		expirationTtl: kvTtlForKey(row.expiresAt),
	});
	if (waitUntil) waitUntil(kvWrite);
	else await kvWrite;

	return data;
}

/**
 * KV is a bounded authentication projection, not revocation authority. A
 * hydrate that began before key deletion can finish its deferred KV write
 * afterwards, so every positive cache hit is revalidated against the compact
 * key/principal/organization tuple in PostgreSQL. This also keeps dashboard
 * membership removal and service-principal disablement immediate.
 */
async function isLiveApiKeyPrincipal(
	db: Database,
	hashedKey: string,
	data: KVKeyData,
): Promise<boolean> {
	if (!data.principal_id) return false;

	const [row] = await db
		.select({
			id: apikey.id,
			keyCredentialVersion: apikey.credentialVersion,
			permissions: apikey.permissions,
			expiresAt: apikey.expiresAt,
			organizationLifecycleStatus: organization.lifecycleStatus,
			principalKind: organizationPrincipals.kind,
			principalLifecycleStatus: organizationPrincipals.lifecycleStatus,
			principalUserId: member.userId,
			memberRole: member.role,
			liveUserId: user.id,
			userBanned: user.banned,
			userBanExpires: user.banExpires,
			userCredentialVersion: user.credentialVersion,
		})
		.from(apikey)
		.innerJoin(organization, eq(organization.id, apikey.organizationId))
		.innerJoin(
			organizationPrincipals,
			and(
				eq(organizationPrincipals.id, apikey.principalId),
				eq(organizationPrincipals.organizationId, apikey.organizationId),
			),
		)
		.leftJoin(
			member,
			and(
				eq(member.id, organizationPrincipals.memberId),
				eq(member.organizationId, organizationPrincipals.organizationId),
			),
		)
		.leftJoin(user, eq(user.id, member.userId))
		.where(
			and(
				eq(apikey.id, data.key_id),
				eq(apikey.key, hashedKey),
				eq(apikey.organizationId, data.org_id),
				eq(apikey.principalId, data.principal_id),
				eq(apikey.enabled, true),
			),
		)
		.limit(1);
	if (
		row?.organizationLifecycleStatus !== "active" ||
		row.principalLifecycleStatus !== "active" ||
		(row.expiresAt !== null && row.expiresAt <= new Date())
	) {
		return false;
	}
	if (!permissionsMatch(row.permissions, data.permissions)) return false;
	if (row.principalKind === "member") {
		return (
			data.principal_type === "dashboard_user" &&
			Boolean(data.principal_user_id) &&
			row.principalUserId === data.principal_user_id &&
			row.liveUserId === row.principalUserId &&
			hasCurrentDashboardCredentialPermissions(
				row.permissions,
				row.memberRole,
			) &&
			!hasActiveBan({
				banned: row.userBanned,
				banExpires: row.userBanExpires,
			}) &&
			normalizedCredentialVersion(row.keyCredentialVersion) ===
				normalizedCredentialVersion(row.userCredentialVersion)
		);
	}
	return (
		row.principalKind === "service" &&
		data.principal_type !== "dashboard_user" &&
		row.principalUserId == null
	);
}

export const authMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Missing API key" } },
			401,
		);
	}

	const token = authHeader.slice(7);
	const hasValidPrefix = API_KEY_PREFIXES.some((prefix) =>
		token.startsWith(prefix),
	);
	if (!hasValidPrefix) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Invalid API key format" } },
			401,
		);
	}

	const hashedKey = await hashKey(token);
	const cached = await c.env.KV.get<KVKeyData & { invalid?: boolean }>(
		`apikey:${hashedKey}`,
		"json",
	);

	// Negative cache hit: a prior lookup proved this well-formed key invalid.
	// Reject at the edge without a DB round trip.
	if (cached?.invalid) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Invalid API key" } },
			401,
		);
	}
	if (cached && parseApiKeyWorkspaceScope(cached) === null) {
		c.executionCtx.waitUntil(c.env.KV.delete(`apikey:${hashedKey}`));
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Invalid API key scope" } },
			401,
		);
	}

	let data: KVKeyData | null = cached ?? null;
	if (data?.expires_at && new Date(data.expires_at) < new Date()) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "API key expired" } },
			401,
		);
	}
	if (
		data &&
		(!("entitlement_recheck_at" in data) ||
			(data.plan === "pro" && !("billing_authority_state" in data)) ||
			(data.entitlement_recheck_at !== null &&
				data.entitlement_recheck_at !== undefined &&
				new Date(data.entitlement_recheck_at) <= new Date()))
	) {
		data = await hydrateApiKey(c.env, hashedKey, c.get("db"), (p) =>
			c.executionCtx.waitUntil(p),
		);
	}

	if (!data) {
		// Cache miss — rehydrate from DB. This is the path that lets us run
		// with a short KV TTL: passive backstop for permission/enabled changes
		// that bypass the explicit invalidation paths. hydrateApiKey writes a
		// short-lived negative tombstone when the key is invalid.
		data = await hydrateApiKey(c.env, hashedKey, c.get("db"), (p) =>
			c.executionCtx.waitUntil(p),
		);
	}

	if (!data) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Invalid API key" } },
			401,
		);
	}

	if (data.expires_at && new Date(data.expires_at) < new Date()) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "API key expired" } },
			401,
		);
	}
	if (!data.principal_id) {
		c.executionCtx.waitUntil(c.env.KV.delete(`apikey:${hashedKey}`));
		return c.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "API key has no active principal",
				},
			},
			401,
		);
	}
	const liveWorkspaceScope = parseApiKeyWorkspaceScope({
		workspace_scope: data.workspace_scope,
	});
	if (liveWorkspaceScope === null) {
		c.executionCtx.waitUntil(c.env.KV.delete(`apikey:${hashedKey}`));
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Invalid API key scope" } },
			401,
		);
	}

	if (!(await isLiveApiKeyPrincipal(c.get("db"), hashedKey, data))) {
		c.executionCtx.waitUntil(c.env.KV.delete(`apikey:${hashedKey}`));
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Invalid API key" } },
			401,
		);
	}

	// SECURITY: default to "free" — never grant Pro without explicit proof
	const selfHosted = deploymentEntitlements(c.env);
	const plan = selfHosted?.plan ?? data.plan ?? "free";
	const billingAuthorityState: "ready" | "pending" =
		selfHosted || plan === "free"
			? "ready"
			: data.billing_authority_state === "ready" &&
					data.billing_period_id &&
					data.period_start &&
					data.period_end
				? "ready"
				: "pending";
	const callsIncluded = selfHosted
		? null
		: plan === "free"
			? PRICING.freeCallsIncluded
			: billingAuthorityState === "pending"
				? 0
				: (data.calls_included ?? PRICING.proCallsIncluded);

	c.set("orgId", data.org_id);
	c.set("keyId", data.key_id);
	c.set("keyHash", hashedKey);
	c.set("permissions", data.permissions);
	c.set("workspaceScope", liveWorkspaceScope);
	c.set("principalType", data.principal_type ?? "service");
	c.set("principalId", data.principal_id);
	c.set("principalUserId", data.principal_user_id ?? null);
	c.set("plan", plan);
	c.set(
		"quotaMode",
		selfHosted?.quotaMode ??
			(plan === "free" ? "hard" : (data.quota_mode ?? "hard")),
	);
	c.set("callsIncluded", callsIncluded);
	c.set(
		"billingSource",
		selfHosted
			? "self_hosted"
			: plan === "free"
				? "free"
				: (data.billing_source ?? "stripe"),
	);
	c.set(
		"billable",
		selfHosted || plan === "free" || billingAuthorityState === "pending"
			? false
			: (data.billable ?? false),
	);
	c.set(
		"billingPeriodId",
		selfHosted || plan === "free" || billingAuthorityState === "pending"
			? null
			: (data.billing_period_id ?? null),
	);
	c.set("billingAuthorityState", billingAuthorityState);
	c.set("aiEnabled", selfHosted?.aiEnabled ?? data.ai_enabled ?? false);
	c.set(
		"dailyToolLimit",
		selfHosted
			? null
			: (data.daily_tool_limit ?? dailyToolLimitForPlan(plan, null)),
	);
	c.set(
		"periodStart",
		selfHosted || plan === "free" || billingAuthorityState === "pending"
			? null
			: (data.period_start ?? null),
	);
	c.set(
		"periodEnd",
		selfHosted || plan === "free" || billingAuthorityState === "pending"
			? null
			: (data.period_end ?? null),
	);
	c.set(
		"billingTransitionAt",
		selfHosted ? null : (data.billing_transition_at ?? null),
	);
	return next();
});
