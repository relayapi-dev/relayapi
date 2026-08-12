import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	DASHBOARD_SESSION_AUTHORITY_HEADER,
	getDashboardCredentialPermissions,
} from "@relayapi/config";
import {
	adAccounts,
	and,
	apikey,
	createDb,
	type Database,
	eq,
	erasureHolds,
	generateId,
	gt,
	organization,
	organizationPrincipals,
	organizationSubscriptions,
	session,
	socialAccounts,
	sql,
	tenantDeletionJobs,
	user,
	verification,
} from "@relayapi/db";
import { encryptAccountToken } from "../lib/account-token-crypto";
import {
	type DurableCredentialAuthoritySnapshot,
	lockCredentialMutationAuthorityInTransaction,
	lockDurableCredentialAuthorityInTransaction,
	withCredentialMutationAuthorityInTransaction,
} from "../lib/credential-mutation-authority";
import {
	AccountWorkspaceAccessError,
	upsertConnectedAccountWithCredentials,
} from "../services/account-credential-write";
import { lockAdProviderBoundary } from "../services/ad-provider-boundary";
import {
	placeErasureHold,
	releaseErasureHold,
} from "../services/privacy-retention-policy";
import {
	requestTenantDeletion,
	type TenantDeletionAuthorityFence,
} from "../services/tenant-deletion";
import type { Env } from "../types";
import {
	deleteOwnedFixtureOrganization,
	insertOwnedFixtureOrganization,
} from "./helpers/owned-organization-fixture";

const CONNECTION_STRING =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
const REQUIRE_DB_FIXTURES = process.env.RELAYAPI_REQUIRE_DB_FIXTURES === "1";
const AD_BOUNDARY_ENCRYPTION_KEY = `test=${"31".repeat(32)}`;
const AD_BOUNDARY_ENV = {
	DEPLOYMENT_MODE: "hosted",
	ENCRYPTION_KEY: AD_BOUNDARY_ENCRYPTION_KEY,
} as Env;

if (REQUIRE_DB_FIXTURES && !CONNECTION_STRING) {
	throw new Error(
		"RELAYAPI_REQUIRE_DB_FIXTURES=1 requires a PostgreSQL URL in HYPERDRIVE_LOCAL_CONNECTION_STRING or CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
	);
}

const databaseIt = CONNECTION_STRING ? it : it.skip;
const db = CONNECTION_STRING
	? createDb(CONNECTION_STRING)
	: (null as unknown as ReturnType<typeof createDb>);

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Ordering = "revocation-first" | "mutation-first";
type AuthorityContext = Parameters<
	typeof lockCredentialMutationAuthorityInTransaction
>[0];

interface AuthorityFixture {
	organizationId: string;
	userId: string;
	memberId: string;
	principalId: string;
	keyId: string;
	keyHash: string;
	credentialVersion: string;
	sessionId: string;
	sessionToken: string;
	markerId: string;
	markerIdentifier: string;
	permissions: string[];
}

interface AdBoundaryFixture extends AuthorityFixture {
	socialAccountId: string;
	adAccountId: string;
}

interface ParticipantHooks {
	started(pid: number): void;
	reachedBoundary(): Promise<void>;
}

type ParticipantOutcome<T> =
	| { ok: true; value: T }
	| { ok: false; error: unknown };

const createdOrganizations: string[] = [];
const extraUserIds: string[] = [];
let dbAvailable = false;

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

function observe<T>(promise: Promise<T>): Promise<ParticipantOutcome<T>> {
	return promise.then(
		(value) => ({ ok: true, value }),
		(error: unknown) => ({ ok: false, error }),
	);
}

function unwrap<T>(outcome: ParticipantOutcome<T>): T {
	if (outcome.ok) return outcome.value;
	throw outcome.error;
}

async function signalBeforeCompletion<T, U>(
	signal: Promise<T>,
	completion: Promise<ParticipantOutcome<U>>,
	label: string,
): Promise<T> {
	const winner = await Promise.race([
		signal.then((value) => ({ kind: "signal" as const, value })),
		completion.then((outcome) => ({ kind: "completion" as const, outcome })),
	]);
	if (winner.kind === "signal") return winner.value;
	if (!winner.outcome.ok) throw winner.outcome.error;
	throw new Error(
		`${label} completed before reaching its required lock barrier`,
	);
}

async function backendPid(tx: Pick<Transaction, "execute">): Promise<number> {
	const rows = await tx.execute<{ pid: number }>(
		sql`SELECT pg_backend_pid()::integer AS pid`,
	);
	const pid = Number(rows[0]?.pid);
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		throw new Error(
			`PostgreSQL returned an invalid backend PID: ${String(pid)}`,
		);
	}
	return pid;
}

async function requireBlockedBy(
	blockedPid: number,
	blockerPid: number,
): Promise<void> {
	if (blockedPid === blockerPid) {
		throw new Error(
			"Race participants unexpectedly shared one PostgreSQL backend",
		);
	}
	for (let attempt = 0; attempt < 256; attempt += 1) {
		const rows = await db.execute<{ blocked: boolean }>(sql`
			SELECT ${blockerPid} = ANY(pg_blocking_pids(${blockedPid})) AS blocked
		`);
		if (rows[0]?.blocked === true) return;
		await Promise.resolve();
	}
	throw new Error(
		`PostgreSQL backend ${blockedPid} never blocked behind ${blockerPid}`,
	);
}

async function runDeterministicRace(
	ordering: Ordering,
	mutation: (hooks: ParticipantHooks) => Promise<boolean>,
	revocation: (hooks: ParticipantHooks) => Promise<void>,
): Promise<boolean> {
	const release = deferred<void>();
	const mutationStarted = deferred<number>();
	const mutationBoundary = deferred<void>();
	const revocationStarted = deferred<number>();
	const revocationBoundary = deferred<void>();

	const mutationHooks: ParticipantHooks = {
		started: mutationStarted.resolve,
		reachedBoundary: async () => {
			mutationBoundary.resolve();
			if (ordering === "mutation-first") await release.promise;
		},
	};
	const revocationHooks: ParticipantHooks = {
		started: revocationStarted.resolve,
		reachedBoundary: async () => {
			revocationBoundary.resolve();
			if (ordering === "revocation-first") await release.promise;
		},
	};

	let mutationRun: Promise<ParticipantOutcome<boolean>>;
	let revocationRun: Promise<ParticipantOutcome<void>>;
	let orchestrationError: unknown;

	if (ordering === "mutation-first") {
		mutationRun = observe(mutation(mutationHooks));
		revocationRun = Promise.resolve({ ok: true, value: undefined });
		try {
			const mutationPid = await signalBeforeCompletion(
				mutationStarted.promise,
				mutationRun,
				"mutation",
			);
			await signalBeforeCompletion(
				mutationBoundary.promise,
				mutationRun,
				"mutation",
			);
			revocationRun = observe(revocation(revocationHooks));
			const revocationPid = await signalBeforeCompletion(
				revocationStarted.promise,
				revocationRun,
				"revocation",
			);
			await requireBlockedBy(revocationPid, mutationPid);
		} catch (error) {
			orchestrationError = error;
		} finally {
			release.resolve();
		}
	} else {
		revocationRun = observe(revocation(revocationHooks));
		mutationRun = Promise.resolve({ ok: true, value: false });
		try {
			const revocationPid = await signalBeforeCompletion(
				revocationStarted.promise,
				revocationRun,
				"revocation",
			);
			await signalBeforeCompletion(
				revocationBoundary.promise,
				revocationRun,
				"revocation",
			);
			mutationRun = observe(mutation(mutationHooks));
			const mutationPid = await signalBeforeCompletion(
				mutationStarted.promise,
				mutationRun,
				"mutation",
			);
			await requireBlockedBy(mutationPid, revocationPid);
		} catch (error) {
			orchestrationError = error;
		} finally {
			release.resolve();
		}
	}

	const [mutationOutcome, revocationOutcome] = await Promise.all([
		mutationRun,
		revocationRun,
	]);
	if (orchestrationError !== undefined) throw orchestrationError;
	unwrap(revocationOutcome);
	return unwrap(mutationOutcome);
}

async function createAuthorityFixture(
	label: string,
): Promise<AuthorityFixture> {
	const organizationId = generateId("org_");
	const userId = `fixture_owner_${organizationId}`;
	const memberId = `fixture_member_${organizationId}`;
	const principalId = generateId("prn_");
	const keyId = generateId("key_");
	const sessionId = generateId("ses_");
	const sessionToken = `authority-race-token:${sessionId}`;
	const markerId = generateId("vrf_");
	const credentialVersion = generateId("cred_");
	const permissions = getDashboardCredentialPermissions("owner");
	const keyHash = `authority-race-hash:${organizationId}`;
	const markerIdentifier = `authority-race:${organizationId}`;

	await insertOwnedFixtureOrganization(db, {
		id: organizationId,
		name: `Authority race ${label}`,
		slug: `authority-race-${label}-${organizationId.slice(-8)}`,
	});
	createdOrganizations.push(organizationId);
	await db
		.update(user)
		.set({
			role: "admin",
			banned: false,
			banExpires: null,
			credentialVersion,
			updatedAt: new Date(),
		})
		.where(eq(user.id, userId));
	await db.insert(organizationPrincipals).values({
		id: principalId,
		organizationId,
		kind: "member",
		memberId,
		scopeMode: "all",
	});
	await db.insert(apikey).values({
		id: keyId,
		name: `Authority race ${label}`,
		key: keyHash,
		referenceId: userId,
		organizationId,
		principalId,
		enabled: true,
		permissions: permissions.join(","),
		credentialVersion,
	});
	await db.insert(session).values({
		id: sessionId,
		userId,
		token: sessionToken,
		expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		activeOrganizationId: organizationId,
		impersonatedBy: null,
	});
	await db.insert(verification).values({
		id: markerId,
		identifier: markerIdentifier,
		value: "pending",
		expiresAt: new Date(Date.now() + 60 * 60 * 1000),
	});

	return {
		organizationId,
		userId,
		memberId,
		principalId,
		keyId,
		keyHash,
		credentialVersion,
		sessionId,
		sessionToken,
		markerId,
		markerIdentifier,
		permissions,
	};
}

function authorityContext(fixture: AuthorityFixture): AuthorityContext {
	const values: Record<string, unknown> = {
		db,
		orgId: fixture.organizationId,
		keyId: fixture.keyId,
		keyHash: fixture.keyHash,
		principalId: fixture.principalId,
		principalType: "dashboard_user",
		principalUserId: fixture.userId,
		permissions: fixture.permissions,
		workspaceScope: "all",
	};
	return {
		get(name: string) {
			return values[name];
		},
		req: {
			header(name: string) {
				return name === DASHBOARD_SESSION_AUTHORITY_HEADER
					? fixture.sessionId
					: undefined;
			},
		},
	} as unknown as AuthorityContext;
}

function durableSnapshot(
	fixture: AuthorityFixture,
): DurableCredentialAuthoritySnapshot {
	return {
		organizationId: fixture.organizationId,
		keyId: fixture.keyId,
		principalId: fixture.principalId,
		principalType: "dashboard_user",
		userId: fixture.userId,
		authorityMemberId: fixture.memberId,
		credentialVersion: fixture.credentialVersion,
		authoritySessionId: fixture.sessionId,
		authorityWorkspaceId: null,
		authorityRequiresAllWorkspaceScope: true,
		admittedAt: new Date(),
		revision: 1,
	};
}

async function createAdBoundaryFixture(
	label: string,
): Promise<AdBoundaryFixture> {
	const fixture = await createAuthorityFixture(label);
	const socialAccountId = generateId("acc_");
	const adAccountId = generateId("adacc_");
	const accessToken = await encryptAccountToken(
		"ad-boundary-provider-token",
		AD_BOUNDARY_ENCRYPTION_KEY,
		socialAccountId,
		"access_token",
	);
	await db.insert(organizationSubscriptions).values({
		organizationId: fixture.organizationId,
		status: "active",
		source: "complimentary",
	});
	await db.insert(socialAccounts).values({
		id: socialAccountId,
		organizationId: fixture.organizationId,
		workspaceId: null,
		platform: "instagram",
		platformAccountId: `ad-boundary-${fixture.organizationId}`,
		accessToken,
		lifecycleStatus: "active",
	});
	await db.insert(adAccounts).values({
		id: adAccountId,
		organizationId: fixture.organizationId,
		workspaceId: null,
		socialAccountId,
		platform: "meta",
		platformAdAccountId: `act_${fixture.organizationId}`,
		status: "active",
	});
	return { ...fixture, socialAccountId, adAccountId };
}

async function markerValue(fixture: AuthorityFixture): Promise<string | null> {
	const [row] = await db
		.select({ value: verification.value })
		.from(verification)
		.where(eq(verification.id, fixture.markerId))
		.limit(1);
	return row?.value ?? null;
}

async function revokeGlobalAdmin(
	fixture: AuthorityFixture,
	hooks: ParticipantHooks,
): Promise<void> {
	await db.transaction(async (tx) => {
		hooks.started(await backendPid(tx));
		await tx
			.update(user)
			.set({ role: null, updatedAt: new Date() })
			.where(eq(user.id, fixture.userId));
		await hooks.reachedBoundary();
	});
}

async function revokeByBan(
	fixture: AuthorityFixture,
	hooks: ParticipantHooks,
): Promise<void> {
	await db.transaction(async (tx) => {
		hooks.started(await backendPid(tx));
		await tx
			.update(user)
			.set({ banned: true, banExpires: null, updatedAt: new Date() })
			.where(eq(user.id, fixture.userId));
		await hooks.reachedBoundary();
	});
}

async function runA01(ordering: Ordering): Promise<void> {
	const fixture = await createAuthorityFixture(`a01-${ordering}`);
	const targetUserId = generateId("usr_");
	const impersonationSessionId = generateId("ses_");
	extraUserIds.push(targetUserId);
	await db.insert(user).values({
		id: targetUserId,
		name: "Impersonation target",
		email: `${targetUserId}@fixtures.relayapi.test`,
		emailVerified: true,
	});

	const authorized = await runDeterministicRace(
		ordering,
		async (hooks) =>
			db.transaction(async (tx) => {
				hooks.started(await backendPid(tx));
				const [actor] = await tx
					.select({ role: user.role, banned: user.banned })
					.from(user)
					.where(eq(user.id, fixture.userId))
					.for("share")
					.limit(1);
				if (
					actor?.banned === true ||
					!(actor?.role ?? "")
						.split(",")
						.some((role) => role.trim() === "admin")
				) {
					return false;
				}
				await tx.insert(session).values({
					id: impersonationSessionId,
					userId: targetUserId,
					token: `impersonation-race:${impersonationSessionId}`,
					expiresAt: new Date(Date.now() + 60 * 60 * 1000),
					activeOrganizationId: fixture.organizationId,
					impersonatedBy: fixture.userId,
				});
				await hooks.reachedBoundary();
				return true;
			}),
		(hooks) => revokeGlobalAdmin(fixture, hooks),
	);

	expect(authorized).toBe(ordering === "mutation-first");
	const impersonationRows = await db
		.select({ id: session.id })
		.from(session)
		.where(eq(session.id, impersonationSessionId));
	expect(impersonationRows).toHaveLength(0);
}

async function runA01SessionRevocation(ordering: Ordering): Promise<void> {
	const fixture = await createAuthorityFixture(`a01-session-${ordering}`);
	const targetUserId = generateId("usr_");
	const impersonationSessionId = generateId("ses_");
	extraUserIds.push(targetUserId);
	await db.insert(user).values({
		id: targetUserId,
		name: "Session revocation impersonation target",
		email: `${targetUserId}@fixtures.relayapi.test`,
		emailVerified: true,
	});

	const authorized = await runDeterministicRace(
		ordering,
		async (hooks) =>
			db.transaction(async (tx) => {
				hooks.started(await backendPid(tx));
				const [lockedUser] = await tx
					.update(user)
					.set({ credentialVersion: fixture.credentialVersion })
					.where(
						and(
							eq(user.id, fixture.userId),
							eq(user.credentialVersion, fixture.credentialVersion),
						),
					)
					.returning({ id: user.id });
				if (!lockedUser) return false;
				const [lockedSession] = await tx
					.update(session)
					.set({ updatedAt: new Date() })
					.where(
						and(
							eq(session.id, fixture.sessionId),
							eq(session.userId, fixture.userId),
							eq(session.token, fixture.sessionToken),
							gt(session.expiresAt, sql`statement_timestamp()`),
						),
					)
					.returning({
						id: session.id,
						impersonatedBy: session.impersonatedBy,
					});
				if (!lockedSession || lockedSession.impersonatedBy !== null) {
					return false;
				}
				await tx.insert(session).values({
					id: impersonationSessionId,
					userId: targetUserId,
					token: `session-revocation-race:${impersonationSessionId}`,
					expiresAt: new Date(Date.now() + 60 * 60 * 1000),
					activeOrganizationId: fixture.organizationId,
					impersonatedBy: fixture.userId,
				});
				await hooks.reachedBoundary();
				return true;
			}),
		async (hooks) => {
			await db.transaction(async (tx) => {
				hooks.started(await backendPid(tx));
				await tx
					.delete(session)
					.where(
						and(
							eq(session.id, fixture.sessionId),
							eq(session.userId, fixture.userId),
							eq(session.token, fixture.sessionToken),
						),
					);
				await hooks.reachedBoundary();
			});
		},
	);

	expect(authorized).toBe(ordering === "mutation-first");
	const impersonationRows = await db
		.select({ id: session.id })
		.from(session)
		.where(eq(session.id, impersonationSessionId));
	expect(impersonationRows).toHaveLength(0);
}

async function runA02(ordering: Ordering): Promise<void> {
	const fixture = await createAuthorityFixture(`a02-${ordering}`);
	const authorized = await runDeterministicRace(
		ordering,
		async (hooks) =>
			db.transaction(async (tx) => {
				hooks.started(await backendPid(tx));
				const [lockedUser] = await tx
					.update(user)
					.set({ credentialVersion: fixture.credentialVersion })
					.where(
						and(
							eq(user.id, fixture.userId),
							eq(user.credentialVersion, fixture.credentialVersion),
						),
					)
					.returning({
						id: user.id,
						role: user.role,
						banned: user.banned,
						banExpires: user.banExpires,
					});
				if (
					!lockedUser ||
					lockedUser.banned === true ||
					!(lockedUser.role ?? "")
						.split(",")
						.some((role) => role.trim() === "admin")
				) {
					return false;
				}
				const [lockedSession] = await tx
					.update(session)
					.set({ id: fixture.sessionId })
					.where(
						and(
							eq(session.id, fixture.sessionId),
							eq(session.userId, fixture.userId),
							eq(session.token, fixture.sessionToken),
							gt(session.expiresAt, sql`statement_timestamp()`),
						),
					)
					.returning({
						id: session.id,
						impersonatedBy: session.impersonatedBy,
					});
				if (!lockedSession || lockedSession.impersonatedBy !== null)
					return false;
				await tx
					.update(verification)
					.set({ value: "committed", updatedAt: new Date() })
					.where(eq(verification.id, fixture.markerId));
				await hooks.reachedBoundary();
				return true;
			}),
		(hooks) => revokeGlobalAdmin(fixture, hooks),
	);

	expect(authorized).toBe(ordering === "mutation-first");
	expect(await markerValue(fixture)).toBe(
		ordering === "mutation-first" ? "committed" : "pending",
	);
}

class RevokedDeletionAuthorityError extends Error {}

async function runD01(ordering: Ordering): Promise<void> {
	const fixture = await createAuthorityFixture(`d01-${ordering}`);
	const context = authorityContext(fixture);
	const authorized = await runDeterministicRace(
		ordering,
		async (hooks) => {
			const authorityFence: TenantDeletionAuthorityFence = {
				organizationIds: [fixture.organizationId],
				async lockActorUser(tx) {
					hooks.started(await backendPid(tx));
					const [actor] = await tx
						.select({ id: user.id })
						.from(user)
						.where(eq(user.id, fixture.userId))
						.for("share")
						.limit(1);
					if (!actor) throw new RevokedDeletionAuthorityError();
				},
				async authorize(tx) {
					const authority = await lockCredentialMutationAuthorityInTransaction(
						context,
						{ requireAllWorkspaceScope: true },
						tx,
					);
					if (!authority.ok) throw new RevokedDeletionAuthorityError();
					await hooks.reachedBoundary();
					return fixture.userId;
				},
			};
			try {
				await requestTenantDeletion(db, fixture.organizationId, authorityFence);
				return true;
			} catch (error) {
				if (error instanceof RevokedDeletionAuthorityError) return false;
				throw error;
			}
		},
		(hooks) => revokeByBan(fixture, hooks),
	);

	expect(authorized).toBe(ordering === "mutation-first");
	const [row] = await db
		.select({ lifecycleStatus: organization.lifecycleStatus })
		.from(organization)
		.where(eq(organization.id, fixture.organizationId))
		.limit(1);
	expect(row?.lifecycleStatus).toBe(
		ordering === "mutation-first" ? "tombstoned" : "active",
	);
}

async function runD02(ordering: Ordering): Promise<void> {
	const fixture = await createAuthorityFixture(`d02-${ordering}`);
	const context = authorityContext(fixture);
	const hold = await placeErasureHold(db, {
		target: {
			kind: "organization",
			organizationId: fixture.organizationId,
		},
		reasonCode: "authority_race",
		reasonSummary: "Deterministic administrator revocation race",
		legalAuthorityRef: `fixture:${fixture.organizationId}`,
		actorUserId: fixture.userId,
	});
	const authorized = await runDeterministicRace(
		ordering,
		async (hooks) =>
			db.transaction(async (tx) => {
				hooks.started(await backendPid(tx));
				const result = await withCredentialMutationAuthorityInTransaction(
					context,
					{ requireGlobalAdmin: true },
					tx,
					async (authorityTx) => {
						await releaseErasureHold(authorityTx as unknown as Database, {
							holdId: hold.id,
							releaseReasonSummary:
								"Deterministic administrator revocation race",
							actorUserId: fixture.userId,
						});
						await hooks.reachedBoundary();
						return true;
					},
				);
				return result.ok;
			}),
		(hooks) => revokeGlobalAdmin(fixture, hooks),
	);

	expect(authorized).toBe(ordering === "mutation-first");
	const [storedHold] = await db
		.select({ releasedAt: erasureHolds.releasedAt })
		.from(erasureHolds)
		.where(eq(erasureHolds.id, hold.id))
		.limit(1);
	expect(storedHold?.releasedAt ?? null).toEqual(
		ordering === "mutation-first" ? expect.any(Date) : null,
	);
}

async function runD03(ordering: Ordering): Promise<void> {
	const fixture = await createAuthorityFixture(`d03-${ordering}`);
	const platformAccountId = `authority-race-${fixture.organizationId}`;
	const authorized = await runDeterministicRace(
		ordering,
		async (hooks) => {
			try {
				return await db.transaction(async (tx) => {
					hooks.started(await backendPid(tx));
					const account = await upsertConnectedAccountWithCredentials(
						tx,
						`active=${"53".repeat(32)}`,
						{
							apiKeyId: fixture.keyId,
							authoritySessionId: fixture.sessionId,
							authorizedWorkspaceScope: "all",
							insert: {
								organizationId: fixture.organizationId,
								workspaceId: null,
								platform: "twitter",
								platformAccountId,
							},
							update: {},
							accessToken: "authority-race-access-token",
							refreshToken: "authority-race-refresh-token",
						},
					);
					if (!account) return false;
					await hooks.reachedBoundary();
					return true;
				});
			} catch (error) {
				if (error instanceof AccountWorkspaceAccessError) return false;
				throw error;
			}
		},
		(hooks) => revokeByBan(fixture, hooks),
	);

	expect(authorized).toBe(ordering === "mutation-first");
	const accounts = await db
		.select({ id: socialAccounts.id })
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.organizationId, fixture.organizationId),
				eq(socialAccounts.platformAccountId, platformAccountId),
			),
		);
	expect(accounts).toHaveLength(ordering === "mutation-first" ? 1 : 0);
}

async function runD04(ordering: Ordering): Promise<void> {
	const fixture = await createAuthorityFixture(`d04-${ordering}`);
	const snapshot = durableSnapshot(fixture);
	const authorized = await runDeterministicRace(
		ordering,
		async (hooks) =>
			db.transaction(async (tx) => {
				hooks.started(await backendPid(tx));
				const authority = await lockDurableCredentialAuthorityInTransaction(
					tx,
					snapshot,
					{ requiredFinancialPermission: "manage_spend" },
				);
				if (!authority.ok) return false;
				await tx
					.update(verification)
					.set({ value: "committed", updatedAt: new Date() })
					.where(eq(verification.id, fixture.markerId));
				await hooks.reachedBoundary();
				return true;
			}),
		async (hooks) => {
			await db.transaction(async (tx) => {
				hooks.started(await backendPid(tx));
				await tx
					.update(apikey)
					.set({
						permissions:
							"read,write,manage_api_keys,view_billing,manage_billing",
						updatedAt: new Date(),
					})
					.where(eq(apikey.id, fixture.keyId));
				await hooks.reachedBoundary();
			});
		},
	);

	expect(authorized).toBe(ordering === "mutation-first");
	expect(await markerValue(fixture)).toBe(
		ordering === "mutation-first" ? "committed" : "pending",
	);
}

async function runD04EntitlementBoundary(ordering: Ordering): Promise<void> {
	const fixture = await createAdBoundaryFixture(`d04-entitlement-${ordering}`);
	const authorized = await runDeterministicRace(
		ordering,
		async (hooks) =>
			db.transaction(async (tx) => {
				hooks.started(await backendPid(tx));
				const boundary = await lockAdProviderBoundary(tx, AD_BOUNDARY_ENV, {
					organizationId: fixture.organizationId,
					workspaceId: null,
					adAccountId: fixture.adAccountId,
					platform: "meta",
					requiresLiveEntitlement: true,
				});
				if (!boundary.ok) return false;
				await tx
					.update(verification)
					.set({ value: "committed", updatedAt: new Date() })
					.where(eq(verification.id, fixture.markerId));
				await hooks.reachedBoundary();
				return true;
			}),
		async (hooks) => {
			await db.transaction(async (tx) => {
				hooks.started(await backendPid(tx));
				await tx
					.update(organizationSubscriptions)
					.set({ status: "cancelled", updatedAt: new Date() })
					.where(
						eq(
							organizationSubscriptions.organizationId,
							fixture.organizationId,
						),
					);
				await hooks.reachedBoundary();
			});
		},
	);

	expect(authorized).toBe(ordering === "mutation-first");
	expect(await markerValue(fixture)).toBe(
		ordering === "mutation-first" ? "committed" : "pending",
	);
}

async function runD04ProviderBoundary(ordering: Ordering): Promise<void> {
	const fixture = await createAdBoundaryFixture(`d04-provider-${ordering}`);
	const authorized = await runDeterministicRace(
		ordering,
		async (hooks) =>
			db.transaction(async (tx) => {
				hooks.started(await backendPid(tx));
				const boundary = await lockAdProviderBoundary(tx, AD_BOUNDARY_ENV, {
					organizationId: fixture.organizationId,
					workspaceId: null,
					adAccountId: fixture.adAccountId,
					platform: "meta",
					requiresLiveEntitlement: true,
				});
				if (!boundary.ok) return false;
				await tx
					.update(verification)
					.set({ value: "committed", updatedAt: new Date() })
					.where(eq(verification.id, fixture.markerId));
				await hooks.reachedBoundary();
				return true;
			}),
		async (hooks) => {
			await db.transaction(async (tx) => {
				hooks.started(await backendPid(tx));
				const now = new Date();
				await tx
					.update(socialAccounts)
					.set({
						lifecycleStatus: "disconnected",
						disconnectRequestedAt: now,
						disconnectedAt: now,
						disconnectReason: "deterministic authority race",
						accessToken: null,
						updatedAt: now,
					})
					.where(eq(socialAccounts.id, fixture.socialAccountId));
				await hooks.reachedBoundary();
			});
		},
	);

	expect(authorized).toBe(ordering === "mutation-first");
	expect(await markerValue(fixture)).toBe(
		ordering === "mutation-first" ? "committed" : "pending",
	);
}

async function runD05(ordering: Ordering): Promise<void> {
	const fixture = await createAuthorityFixture(`d05-${ordering}`);
	const snapshot = durableSnapshot(fixture);
	const authorized = await runDeterministicRace(
		ordering,
		async (hooks) =>
			db.transaction(async (tx) => {
				hooks.started(await backendPid(tx));
				const authority = await lockDurableCredentialAuthorityInTransaction(
					tx,
					snapshot,
				);
				if (!authority.ok) return false;
				await tx
					.update(verification)
					.set({ value: "committed", updatedAt: new Date() })
					.where(eq(verification.id, fixture.markerId));
				await hooks.reachedBoundary();
				return true;
			}),
		async (hooks) => {
			await db.transaction(async (tx) => {
				hooks.started(await backendPid(tx));
				await tx.delete(session).where(eq(session.id, fixture.sessionId));
				await hooks.reachedBoundary();
			});
		},
	);

	expect(authorized).toBe(ordering === "mutation-first");
	expect(await markerValue(fixture)).toBe(
		ordering === "mutation-first" ? "committed" : "pending",
	);
}

beforeAll(async () => {
	if (!CONNECTION_STRING) return;
	await db.execute(sql`
		SELECT 1
		FROM pg_catalog.pg_class
		WHERE oid = 'auth.user'::regclass
			AND 'auth.session'::regclass IS NOT NULL
			AND 'public.organization_principals'::regclass IS NOT NULL
	`);
	dbAvailable = true;
});

afterAll(async () => {
	if (!dbAvailable) return;
	for (const organizationId of createdOrganizations.reverse()) {
		await db
			.delete(erasureHolds)
			.where(eq(erasureHolds.organizationTombstoneId, organizationId));
		await db
			.delete(tenantDeletionJobs)
			.where(eq(tenantDeletionJobs.organizationId, organizationId));
		await db
			.delete(organizationSubscriptions)
			.where(eq(organizationSubscriptions.organizationId, organizationId));
		await db
			.delete(socialAccounts)
			.where(eq(socialAccounts.organizationId, organizationId));
		await db
			.delete(verification)
			.where(eq(verification.identifier, `authority-race:${organizationId}`));
		await deleteOwnedFixtureOrganization(db, organizationId);
	}
	for (const userId of extraUserIds.reverse()) {
		await db.delete(user).where(eq(user.id, userId));
	}
});

describe("credential authority revocation races", () => {
	databaseIt(
		"A01 rejects impersonation when revocation commits first",
		async () => {
			await runA01("revocation-first");
		},
	);

	databaseIt(
		"A01 removes impersonation when creation commits first",
		async () => {
			await runA01("mutation-first");
		},
	);

	databaseIt(
		"A01 rejects impersonation when originating-session revocation commits first",
		async () => {
			await runA01SessionRevocation("revocation-first");
		},
	);

	databaseIt(
		"A01 removes impersonation when originating-session creation commits first",
		async () => {
			await runA01SessionRevocation("mutation-first");
		},
	);

	databaseIt(
		"A02 rejects an admin mutation when demotion commits first",
		async () => {
			await runA02("revocation-first");
		},
	);

	databaseIt(
		"A02 makes demotion wait for an admitted admin mutation",
		async () => {
			await runA02("mutation-first");
		},
	);

	databaseIt(
		"D01 rejects tenant deletion when a ban commits first",
		async () => {
			await runD01("revocation-first");
		},
	);

	databaseIt("D01 makes a ban wait for admitted tenant deletion", async () => {
		await runD01("mutation-first");
	});

	databaseIt(
		"D02 rejects an erasure-hold release when demotion commits first",
		async () => {
			await runD02("revocation-first");
		},
	);

	databaseIt(
		"D02 makes demotion wait for an admitted erasure-hold release",
		async () => {
			await runD02("mutation-first");
		},
	);

	databaseIt(
		"D03 rejects an OAuth write when a ban commits first",
		async () => {
			await runD03("revocation-first");
		},
	);

	databaseIt("D03 makes a ban wait for an admitted OAuth write", async () => {
		await runD03("mutation-first");
	});

	databaseIt(
		"D04 rejects an ad boundary after spend authority is revoked",
		async () => {
			await runD04("revocation-first");
		},
	);

	databaseIt(
		"D04 makes spend revocation wait for an admitted ad boundary",
		async () => {
			await runD04("mutation-first");
		},
	);

	databaseIt(
		"D04 rejects an ad write when billing downgrade commits first",
		async () => {
			await runD04EntitlementBoundary("revocation-first");
		},
	);

	databaseIt(
		"D04 makes billing downgrade wait for an admitted ad write",
		async () => {
			await runD04EntitlementBoundary("mutation-first");
		},
	);

	databaseIt(
		"D04 rejects an ad write when provider disconnect commits first",
		async () => {
			await runD04ProviderBoundary("revocation-first");
		},
	);

	databaseIt(
		"D04 makes provider disconnect wait for an admitted ad write",
		async () => {
			await runD04ProviderBoundary("mutation-first");
		},
	);

	databaseIt(
		"D05 rejects a phone release after its session is revoked",
		async () => {
			await runD05("revocation-first");
		},
	);

	databaseIt(
		"D05 makes session revocation wait for an admitted phone release",
		async () => {
			await runD05("mutation-first");
		},
	);
});
