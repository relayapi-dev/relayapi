import {
	API_KEY_CACHE_TTL_SECONDS,
	dailyToolLimitForPlan,
	getBillingPolicy,
	PRICING,
} from "@relayapi/config";
import {
	apikey,
	user as authUser,
	billingPeriods,
	generateId,
	LEGACY_CREDENTIAL_VERSION,
	member,
	organization,
	organizationPrincipals,
	organizationSubscriptions,
	principalWorkspaceGrants,
} from "@relayapi/db";
import { and, eq, lt, sql } from "drizzle-orm";
import {
	getDashboardCredentialPermissions,
	hasCurrentDashboardCredentialPermissions,
} from "./credential-authorization";
import {
	type DashboardCredentialPointer,
	decryptDashboardCredential,
	encryptDashboardApiKey,
} from "./dashboard-key-envelope";
import {
	IS_SELF_HOSTED_BUILD,
	SELF_HOSTED_AI_ENABLED,
} from "./deployment-mode";
import { clearClientCache } from "./relay-client-cache";

const DASHBOARD_KEY_TTL_SECONDS = 12 * 60 * 60;
// Expire the retrievable raw key before the database credential. This leaves
// enough time for the one-minute SDK client cache to drain before renewal, so
// requests never keep using a database-expired credential.
const DASHBOARD_KEY_RENEWAL_WINDOW_SECONDS = 2 * 60;

export type DashboardCredentialResult =
	| { ok: true; created: boolean }
	| {
			ok: false;
			status: 401 | 403 | 500;
			code: string;
			message: string;
	  };

const pendingEnsures = new Map<string, Promise<DashboardCredentialResult>>();

class DashboardCredentialAuthorizationError extends Error {
	constructor(
		readonly result: Extract<DashboardCredentialResult, { ok: false }>,
	) {
		super(result.message);
		this.name = "DashboardCredentialAuthorizationError";
	}
}

function normalizedCredentialVersion(value: unknown): string {
	return typeof value === "string" && value ? value : LEGACY_CREDENTIAL_VERSION;
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

async function hashKey(key: string): Promise<string> {
	const encoded = new TextEncoder().encode(key);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(hashBuffer))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function generateRawKey(): string {
	const bytes = new Uint8Array(29);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `rlay_live_${hex}`;
}

async function ensureMemberPrincipal(
	locals: App.Locals,
	organizationId: string,
	userId: string,
): Promise<{
	id: string;
	workspaceScope: "all" | string[];
}> {
	const { db } = locals;
	const principal = await db.transaction(async (tx) => {
		const [membership] = await tx
			.select({ id: member.id })
			.from(member)
			.where(
				and(
					eq(member.organizationId, organizationId),
					eq(member.userId, userId),
				),
			)
			.for("share")
			.limit(1);
		if (!membership) {
			throw new Error("Active organization membership is required");
		}

		const [existing] = await tx
			.select({
				id: organizationPrincipals.id,
				scopeMode: organizationPrincipals.scopeMode,
			})
			.from(organizationPrincipals)
			.where(
				and(
					eq(organizationPrincipals.organizationId, organizationId),
					eq(organizationPrincipals.memberId, membership.id),
					eq(organizationPrincipals.kind, "member"),
					eq(organizationPrincipals.lifecycleStatus, "active"),
				),
			)
			.for("share")
			.limit(1);
		if (existing) return existing;

		const candidateId = generateId("prn_");
		const [inserted] = await tx
			.insert(organizationPrincipals)
			.values({
				id: candidateId,
				organizationId,
				kind: "member",
				memberId: membership.id,
				scopeMode: "all",
			})
			.onConflictDoNothing()
			.returning({
				id: organizationPrincipals.id,
				scopeMode: organizationPrincipals.scopeMode,
			});
		if (inserted) return inserted;

		const [concurrent] = await tx
			.select({
				id: organizationPrincipals.id,
				scopeMode: organizationPrincipals.scopeMode,
			})
			.from(organizationPrincipals)
			.where(
				and(
					eq(organizationPrincipals.organizationId, organizationId),
					eq(organizationPrincipals.memberId, membership.id),
					eq(organizationPrincipals.kind, "member"),
					eq(organizationPrincipals.lifecycleStatus, "active"),
				),
			)
			.limit(1);
		if (!concurrent) {
			throw new Error("Could not resolve organization principal");
		}
		return concurrent;
	});

	if (principal.scopeMode === "all") {
		return { id: principal.id, workspaceScope: "all" };
	}
	const grants = await db
		.select({ workspaceId: principalWorkspaceGrants.workspaceId })
		.from(principalWorkspaceGrants)
		.where(
			and(
				eq(principalWorkspaceGrants.organizationId, organizationId),
				eq(principalWorkspaceGrants.principalId, principal.id),
			),
		);
	return {
		id: principal.id,
		workspaceScope: grants.map((grant) => grant.workspaceId).sort(),
	};
}

async function ensureAuthorizedDashboardCredential(
	locals: App.Locals,
	organizationId: string,
	userId: string,
	membershipRole: string,
	credentialVersion: string,
): Promise<Extract<DashboardCredentialResult, { ok: true }>> {
	const { db, kv, dashboardCredentialSecret } = locals;
	const dashboardKeyName = `dashboard-key:${organizationId}:${userId}`;
	const permissions = getDashboardCredentialPermissions(membershipRole);
	const principal = await ensureMemberPrincipal(locals, organizationId, userId);
	const existingEnvelope = await kv.get(dashboardKeyName);
	let existing: DashboardCredentialPointer | null = null;
	if (existingEnvelope) {
		try {
			existing = await decryptDashboardCredential(
				existingEnvelope,
				dashboardCredentialSecret,
				dashboardKeyName,
			);
		} catch {
			// Secret rotation or a damaged pointer cannot expose or preserve a
			// bearer. Drop only the pointer; its short-lived DB hash expires.
			await kv.delete(dashboardKeyName);
		}
	}
	let stalePrincipalHash: string | null = null;

	if (existing) {
		const existingHash = await hashKey(existing.apiKey);
		const [row] = await db
			.select({
				enabled: apikey.enabled,
				expiresAt: apikey.expiresAt,
				referenceId: apikey.referenceId,
				organizationId: apikey.organizationId,
				principalId: apikey.principalId,
				permissions: apikey.permissions,
				credentialVersion: apikey.credentialVersion,
				liveUserId: authUser.id,
				userBanned: authUser.banned,
				userBanExpires: authUser.banExpires,
				userCredentialVersion: authUser.credentialVersion,
			})
			.from(apikey)
			.leftJoin(authUser, eq(authUser.id, apikey.referenceId))
			.where(eq(apikey.key, existingHash))
			.limit(1);

		const belongsToPrincipal =
			row?.organizationId === organizationId &&
			row.referenceId === userId &&
			row.principalId === principal.id;
		if (
			row?.enabled &&
			belongsToPrincipal &&
			row.liveUserId === userId &&
			!hasActiveBan({
				banned: row.userBanned,
				banExpires: row.userBanExpires,
			}) &&
			existing.credentialVersion === credentialVersion &&
			normalizedCredentialVersion(row.credentialVersion) ===
				credentialVersion &&
			normalizedCredentialVersion(row.userCredentialVersion) ===
				credentialVersion &&
			row.expiresAt != null &&
			row.expiresAt > new Date() &&
			hasCurrentDashboardCredentialPermissions(row.permissions, membershipRole)
		) {
			return { ok: true, created: false };
		}

		// Only an exact stale key owned by this principal may be disabled. A raw
		// pointer can be replaced concurrently by another Worker isolate, so do
		// not delete the shared pointer or disable unseen credentials here.
		if (belongsToPrincipal) stalePrincipalHash = existingHash;
		clearClientCache(organizationId, userId);
	}

	const [subscription] = await db
		.select({
			status: organizationSubscriptions.status,
			source: organizationSubscriptions.source,
			aiEnabled: organizationSubscriptions.aiEnabled,
			dailyToolLimitOverride: organizationSubscriptions.dailyToolLimitOverride,
			stripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
			trialEndsAt: organizationSubscriptions.trialEndsAt,
			delinquentAt: organizationSubscriptions.delinquentAt,
			graceEndsAt: organizationSubscriptions.graceEndsAt,
			billingPeriodId: billingPeriods.id,
			billingPeriodSource: billingPeriods.source,
			billingPeriodBillable: billingPeriods.billable,
			billingPeriodQuotaMode: billingPeriods.quotaMode,
			billingPeriodIncludedUnits: billingPeriods.includedUnits,
			billingPeriodStart: billingPeriods.periodStart,
			billingPeriodEnd: billingPeriods.periodEnd,
		})
		.from(organizationSubscriptions)
		.leftJoin(
			billingPeriods,
			and(
				eq(
					billingPeriods.organizationId,
					organizationSubscriptions.organizationId,
				),
				eq(billingPeriods.state, "open"),
				sql`${billingPeriods.periodStart} <= statement_timestamp()`,
				sql`${billingPeriods.periodEnd} > statement_timestamp()`,
			),
		)
		.where(eq(organizationSubscriptions.organizationId, organizationId))
		.limit(1);

	const decision = getBillingPolicy({
		status: subscription?.status,
		source: subscription?.source,
		stripeSubscriptionId: subscription?.stripeSubscriptionId,
		trialEndsAt: subscription?.trialEndsAt,
		delinquentAt: subscription?.delinquentAt,
		graceEndsAt: subscription?.graceEndsAt,
		currentPeriodStart: subscription?.billingPeriodStart,
		currentPeriodEnd: subscription?.billingPeriodEnd,
	});
	const plan = IS_SELF_HOSTED_BUILD ? "pro" : decision.entitlement;
	const rawKey = generateRawKey();
	const hashedKey = await hashKey(rawKey);
	const keyId = generateId("key_");
	const expiresAt = new Date(Date.now() + DASHBOARD_KEY_TTL_SECONDS * 1000);

	// Replace only the stale key that this request actually inspected. Concurrent
	// cache-miss mints may coexist until their short expiry; whichever pointer is
	// published last therefore always names a valid credential.
	const issuedCredentialVersion = await db.transaction(async (tx) => {
		// Lock the credential generation before inserting the bearer. The ban
		// trigger updates this row, so issuance and a concurrent ban serialize.
		const [liveUser] = await tx
			.select({
				id: authUser.id,
				banned: authUser.banned,
				banExpires: authUser.banExpires,
				credentialVersion: authUser.credentialVersion,
			})
			.from(authUser)
			.where(eq(authUser.id, userId))
			.for("share")
			.limit(1);
		const liveCredentialVersion = normalizedCredentialVersion(
			liveUser?.credentialVersion,
		);
		if (
			!liveUser ||
			hasActiveBan(liveUser) ||
			liveCredentialVersion !== credentialVersion
		) {
			throw new DashboardCredentialAuthorizationError({
				ok: false,
				status: 401,
				code: "SESSION_CREDENTIAL_STALE",
				message: "The authenticated session is no longer current.",
			});
		}

		const [liveMembership] = await tx
			.select({ id: member.id, role: member.role })
			.from(member)
			.where(
				and(
					eq(member.organizationId, organizationId),
					eq(member.userId, userId),
				),
			)
			.for("share")
			.limit(1);
		if (!liveMembership || liveMembership.role !== membershipRole) {
			throw new DashboardCredentialAuthorizationError({
				ok: false,
				status: 403,
				code: "ORGANIZATION_MEMBERSHIP_REQUIRED",
				message: "Active organization membership is required.",
			});
		}

		const [liveOrganization] = await tx
			.select({
				id: organization.id,
				lifecycleStatus: organization.lifecycleStatus,
			})
			.from(organization)
			.where(eq(organization.id, organizationId))
			.for("share")
			.limit(1);
		if (liveOrganization?.lifecycleStatus !== "active") {
			throw new DashboardCredentialAuthorizationError({
				ok: false,
				status: 403,
				code: "ORGANIZATION_NOT_ACTIVE",
				message: "The organization is no longer active.",
			});
		}

		// API-key creation locks dashboard authority in user -> member ->
		// organization -> key -> principal order. Lock the exact stale bearer in
		// the same position before disabling it so rotation cannot deadlock with a
		// request still presenting that key.
		if (stalePrincipalHash) {
			await tx
				.select({ id: apikey.id })
				.from(apikey)
				.where(
					and(
						eq(apikey.key, stalePrincipalHash),
						eq(apikey.organizationId, organizationId),
						eq(apikey.principalId, principal.id),
					),
				)
				.for("update")
				.limit(1);
		}

		const [livePrincipal] = await tx
			.select({
				id: organizationPrincipals.id,
				memberId: organizationPrincipals.memberId,
				lifecycleStatus: organizationPrincipals.lifecycleStatus,
			})
			.from(organizationPrincipals)
			.where(
				and(
					eq(organizationPrincipals.id, principal.id),
					eq(organizationPrincipals.organizationId, organizationId),
					eq(organizationPrincipals.kind, "member"),
				),
			)
			.for("share")
			.limit(1);
		if (
			!livePrincipal ||
			livePrincipal.memberId !== liveMembership.id ||
			livePrincipal.lifecycleStatus !== "active"
		) {
			throw new DashboardCredentialAuthorizationError({
				ok: false,
				status: 403,
				code: "ORGANIZATION_MEMBERSHIP_REQUIRED",
				message: "Active organization membership is required.",
			});
		}

		// The raw-key pointer expires before its database row, so normal renewal
		// cannot identify the previous hash. Remove only credentials for this exact
		// dashboard principal that have already expired, keeping row growth bounded
		// without touching a concurrently minted or still-valid credential.
		await tx
			.delete(apikey)
			.where(
				and(
					eq(apikey.organizationId, organizationId),
					eq(apikey.principalId, principal.id),
					lt(apikey.expiresAt, new Date()),
				),
			);
		if (stalePrincipalHash) {
			await tx
				.update(apikey)
				.set({ enabled: false, updatedAt: new Date() })
				.where(
					and(
						eq(apikey.key, stalePrincipalHash),
						eq(apikey.organizationId, organizationId),
						eq(apikey.principalId, principal.id),
					),
				);
		}
		await tx.insert(apikey).values({
			id: keyId,
			name: "Dashboard Session",
			key: hashedKey,
			start: rawKey.slice(0, 8),
			prefix: "rlay_live_",
			organizationId,
			referenceId: userId,
			principalId: principal.id,
			credentialVersion: liveCredentialVersion,
			enabled: true,
			expiresAt,
			permissions: permissions.join(","),
			metadata: { credential_purpose: "dashboard_session" },
		});
		return liveCredentialVersion;
	});

	if (stalePrincipalHash) {
		await kv.delete(`apikey:${stalePrincipalHash}`);
	}
	await kv.put(
		`apikey:${hashedKey}`,
		JSON.stringify({
			org_id: organizationId,
			key_id: keyId,
			permissions,
			workspace_scope: principal.workspaceScope,
			principal_type: "dashboard_user",
			principal_id: principal.id,
			principal_user_id: userId,
			expires_at: expiresAt.toISOString(),
			plan,
			quota_mode: IS_SELF_HOSTED_BUILD
				? "unlimited"
				: (subscription?.billingPeriodQuotaMode ?? decision.quotaMode),
			calls_included: IS_SELF_HOSTED_BUILD
				? null
				: (subscription?.billingPeriodIncludedUnits ??
					(plan === "pro"
						? PRICING.proCallsIncluded
						: PRICING.freeCallsIncluded)),
			billing_source: IS_SELF_HOSTED_BUILD
				? "self_hosted"
				: plan === "free"
					? "free"
					: (subscription?.billingPeriodSource ??
						subscription?.source ??
						"stripe"),
			billable: IS_SELF_HOSTED_BUILD
				? false
				: (subscription?.billingPeriodBillable ?? decision.billable),
			billing_period_id: IS_SELF_HOSTED_BUILD
				? null
				: (subscription?.billingPeriodId ?? null),
			ai_enabled: IS_SELF_HOSTED_BUILD
				? SELF_HOSTED_AI_ENABLED
				: (subscription?.aiEnabled ?? false),
			daily_tool_limit: IS_SELF_HOSTED_BUILD
				? null
				: dailyToolLimitForPlan(plan, subscription?.dailyToolLimitOverride),
			period_start: IS_SELF_HOSTED_BUILD
				? null
				: (subscription?.billingPeriodStart?.toISOString() ??
					decision.usagePeriod?.start.toISOString() ??
					null),
			period_end: IS_SELF_HOSTED_BUILD
				? null
				: (subscription?.billingPeriodEnd?.toISOString() ??
					decision.usagePeriod?.end.toISOString() ??
					null),
		}),
		{ expirationTtl: API_KEY_CACHE_TTL_SECONDS },
	);
	// Publish the raw-key pointer only after the API authorization cache exists.
	await kv.put(
		dashboardKeyName,
		await encryptDashboardApiKey(
			rawKey,
			dashboardCredentialSecret,
			dashboardKeyName,
			issuedCredentialVersion,
		),
		{
			expirationTtl:
				DASHBOARD_KEY_TTL_SECONDS - DASHBOARD_KEY_RENEWAL_WINDOW_SECONDS,
		},
	);
	clearClientCache(organizationId, userId);

	return { ok: true, created: true };
}

/**
 * Ensure the authenticated live organization member has one current,
 * short-lived, user-bound dashboard credential. Concurrent requests handled by
 * the same Worker isolate share the same rotation operation.
 */
export function ensureDashboardCredential(
	locals: App.Locals,
): Promise<DashboardCredentialResult> {
	const user = locals.user as
		| { id?: string; credentialVersion?: string }
		| null
		| undefined;
	const organization = locals.organization as
		| { id?: string }
		| null
		| undefined;
	const membershipRole = locals.organizationMembershipRole;

	if (!user?.id) {
		return Promise.resolve({
			ok: false,
			status: 401,
			code: "UNAUTHORIZED",
			message: "Not authenticated",
		});
	}
	if (!organization?.id || !membershipRole) {
		return Promise.resolve({
			ok: false,
			status: 403,
			code: "ORGANIZATION_MEMBERSHIP_REQUIRED",
			message: "Active organization membership is required.",
		});
	}
	if (!locals.kv || !locals.db || !locals.dashboardCredentialSecret) {
		return Promise.resolve({
			ok: false,
			status: 500,
			code: "DASHBOARD_CREDENTIAL_UNAVAILABLE",
			message: "Dashboard credential storage is unavailable.",
		});
	}

	const credentialVersion = normalizedCredentialVersion(user.credentialVersion);
	const pendingKey = `${organization.id}:${user.id}:${credentialVersion}`;
	const current = pendingEnsures.get(pendingKey);
	if (current) return current;

	const operation = ensureAuthorizedDashboardCredential(
		locals,
		organization.id,
		user.id,
		membershipRole,
		credentialVersion,
	)
		.catch((error: unknown) => {
			if (error instanceof DashboardCredentialAuthorizationError) {
				return error.result;
			}
			throw error;
		})
		.finally(() => {
			if (pendingEnsures.get(pendingKey) === operation) {
				pendingEnsures.delete(pendingKey);
			}
		});
	pendingEnsures.set(pendingKey, operation);
	return operation;
}

export function dashboardCredentialErrorResponse(
	result: Extract<DashboardCredentialResult, { ok: false }>,
): Response {
	return Response.json(
		{ error: { code: result.code, message: result.message } },
		{ status: result.status },
	);
}
