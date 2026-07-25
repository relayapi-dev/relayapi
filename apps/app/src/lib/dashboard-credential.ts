import {
	API_KEY_CACHE_TTL_SECONDS,
	getBillingPolicy,
	PRICING,
} from "@relayapi/config";
import { apikey, generateId, organizationSubscriptions } from "@relayapi/db";
import { and, eq, lt, sql } from "drizzle-orm";
import {
	getDashboardCredentialPermissions,
	hasCurrentDashboardCredentialPermissions,
} from "./credential-authorization";
import { clearClientCache } from "./relay";
import {
	IS_SELF_HOSTED_BUILD,
	SELF_HOSTED_AI_ENABLED,
} from "./deployment-mode";

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

const pendingEnsures = new Map<
	string,
	Promise<Extract<DashboardCredentialResult, { ok: true }>>
>();

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

async function ensureAuthorizedDashboardCredential(
	locals: App.Locals,
	organizationId: string,
	userId: string,
	membershipRole: string,
): Promise<Extract<DashboardCredentialResult, { ok: true }>> {
	const { db, kv } = locals;
	const dashboardKeyName = `dashboard-key:${organizationId}:${userId}`;
	const permissions = getDashboardCredentialPermissions(membershipRole);
	const existing = await kv.get(dashboardKeyName);
	let stalePrincipalHash: string | null = null;

	if (existing) {
		const existingHash = await hashKey(existing);
		const [row] = await db
			.select({
				enabled: apikey.enabled,
				expiresAt: apikey.expiresAt,
				referenceId: apikey.referenceId,
				organizationId: apikey.organizationId,
				permissions: apikey.permissions,
				metadata: apikey.metadata,
			})
			.from(apikey)
			.where(eq(apikey.key, existingHash))
			.limit(1);

		const metadata = row?.metadata as
			| Record<string, unknown>
			| null
			| undefined;
		const belongsToPrincipal =
			row?.organizationId === organizationId &&
			row.referenceId === userId &&
			metadata?.principal_type === "dashboard_user" &&
			metadata.principal_id === userId;
		if (
			row?.enabled &&
			belongsToPrincipal &&
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
			aiEnabled: organizationSubscriptions.aiEnabled,
			dailyToolLimit: organizationSubscriptions.dailyToolLimit,
			stripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
			trialEndsAt: organizationSubscriptions.trialEndsAt,
			currentPeriodStart: organizationSubscriptions.currentPeriodStart,
			currentPeriodEnd: organizationSubscriptions.currentPeriodEnd,
		})
		.from(organizationSubscriptions)
		.where(eq(organizationSubscriptions.organizationId, organizationId))
		.limit(1);

	const decision = getBillingPolicy({
		status: subscription?.status,
		stripeSubscriptionId: subscription?.stripeSubscriptionId,
		trialEndsAt: subscription?.trialEndsAt,
		currentPeriodStart: subscription?.currentPeriodStart,
		currentPeriodEnd: subscription?.currentPeriodEnd,
	});
	const plan = IS_SELF_HOSTED_BUILD ? "pro" : decision.entitlement;
	const rawKey = generateRawKey();
	const hashedKey = await hashKey(rawKey);
	const keyId = generateId("key_");
	const expiresAt = new Date(Date.now() + DASHBOARD_KEY_TTL_SECONDS * 1000);

	// Replace only the stale key that this request actually inspected. Concurrent
	// cache-miss mints may coexist until their short expiry; whichever pointer is
	// published last therefore always names a valid credential.
	await db.transaction(async (tx) => {
		// The raw-key pointer expires before its database row, so normal renewal
		// cannot identify the previous hash. Remove only credentials for this exact
		// dashboard principal that have already expired, keeping row growth bounded
		// without touching a concurrently minted or still-valid credential.
		await tx
			.delete(apikey)
			.where(
				and(
					eq(apikey.organizationId, organizationId),
					eq(apikey.referenceId, userId),
					lt(apikey.expiresAt, new Date()),
					sql`${apikey.metadata}->>'principal_type' = 'dashboard_user'`,
					sql`${apikey.metadata}->>'principal_id' = ${userId}`,
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
						eq(apikey.referenceId, userId),
						sql`${apikey.metadata}->>'principal_type' = 'dashboard_user'`,
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
			enabled: true,
			expiresAt,
			permissions: permissions.join(","),
			metadata: {
				workspace_scope: "all",
				principal_type: "dashboard_user",
				principal_id: userId,
			},
		});
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
			workspace_scope: "all",
			principal_type: "dashboard_user",
			principal_id: userId,
			expires_at: expiresAt.toISOString(),
			plan,
			calls_included: IS_SELF_HOSTED_BUILD
				? Number.MAX_SAFE_INTEGER
				: plan === "pro"
					? PRICING.proCallsIncluded
					: PRICING.freeCallsIncluded,
			ai_enabled: IS_SELF_HOSTED_BUILD
				? SELF_HOSTED_AI_ENABLED
				: (subscription?.aiEnabled ?? false),
			daily_tool_limit:
				IS_SELF_HOSTED_BUILD
					? Number.MAX_SAFE_INTEGER
					: subscription?.dailyToolLimit ?? (plan === "pro" ? 10 : 2),
			period_start: IS_SELF_HOSTED_BUILD
				? null
				: (decision.usagePeriod?.start.toISOString() ?? null),
			period_end: IS_SELF_HOSTED_BUILD
				? null
				: (decision.usagePeriod?.end.toISOString() ?? null),
		}),
		{ expirationTtl: API_KEY_CACHE_TTL_SECONDS },
	);
	// Publish the raw-key pointer only after the API authorization cache exists.
	await kv.put(dashboardKeyName, rawKey, {
		expirationTtl:
			DASHBOARD_KEY_TTL_SECONDS - DASHBOARD_KEY_RENEWAL_WINDOW_SECONDS,
	});
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
	const user = locals.user as { id?: string } | null | undefined;
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
	if (!locals.kv || !locals.db) {
		return Promise.resolve({
			ok: false,
			status: 500,
			code: "DASHBOARD_CREDENTIAL_UNAVAILABLE",
			message: "Dashboard credential storage is unavailable.",
		});
	}

	const pendingKey = `${organization.id}:${user.id}`;
	const current = pendingEnsures.get(pendingKey);
	if (current) return current;

	const operation = ensureAuthorizedDashboardCredential(
		locals,
		organization.id,
		user.id,
		membershipRole,
	).finally(() => {
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
