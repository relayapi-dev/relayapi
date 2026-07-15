import {
	createDb,
	generateId,
	socialAccounts,
	tokenRefreshOperations,
} from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import {
	decryptAccountToken,
	decryptAccountTokens,
	encryptAccountToken,
} from "../lib/account-token-crypto";
import { logConnectionEvent } from "../routes/connections";
import type { Platform } from "../schemas/common";
import type { Env } from "../types";
import { rehostAvatar } from "./avatar-store";
import { sendNotificationToOrg } from "./notification-manager";
import { executeProviderTokenRefresh, fetchAvatarUrl } from "./token-refresh";

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const CLAIM_LEASE_MS = 30 * 1000;
export const TOKEN_REFRESH_BOUNDARY_STALE_MS = 60 * 1000;
const BUSY_POLL_ATTEMPTS = 8;
const BUSY_POLL_INTERVAL_MS = 250;

export type RefreshMode = "if_needed" | "force";

export interface RefreshAccountRecord {
	id: string;
	organizationId: string;
	platform: Platform;
	platformAccountId: string;
	username: string | null;
	displayName: string | null;
	accessToken: string | null;
	refreshToken: string | null;
	tokenVersion: number;
	tokenExpiresAt: Date | null;
	metadata: unknown;
}

export interface RefreshClaim {
	operationId: string;
	fencingToken: number;
	sourceTokenVersion: number;
	account: RefreshAccountRecord;
}

export type RefreshClaimOutcome =
	| { kind: "ready"; account: RefreshAccountRecord }
	| { kind: "claimed"; claim: RefreshClaim }
	| { kind: "busy"; account: RefreshAccountRecord }
	| {
			kind: "blocked_unknown";
			operationId: string;
			account: RefreshAccountRecord;
	  }
	| { kind: "missing" };

export interface PersistedRefreshTokens {
	accessToken: string;
	refreshToken?: string;
	tokenExpiresAt?: Date;
}

export interface TokenRefreshStore {
	claim(
		accountId: string,
		mode: RefreshMode,
		now: Date,
	): Promise<RefreshClaimOutcome>;
	markRequestMayHaveBeenSent(claim: RefreshClaim, now: Date): Promise<boolean>;
	persistSuccess(
		claim: RefreshClaim,
		tokens: PersistedRefreshTokens,
		now: Date,
	): Promise<RefreshAccountRecord | null>;
	markUnknown(claim: RefreshClaim, error: string, now: Date): Promise<void>;
	observe(accountId: string): Promise<{
		account: RefreshAccountRecord | null;
		operation: {
			operationId: string;
			state:
				| "claimed_pre_request"
				| "request_may_have_been_sent"
				| "succeeded"
				| "unknown";
			sourceTokenVersion: number;
			requestMayHaveBeenSentAt: Date | null;
		} | null;
	}>;
}

export interface RefreshProviderResult {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
}

export interface CoordinatedRefreshResult {
	accessToken: string;
	refreshed: boolean;
	account: RefreshAccountRecord;
}

export interface CoordinatorDependencies {
	store: TokenRefreshStore;
	decrypt: (account: RefreshAccountRecord) => Promise<{
		accessToken: string | null;
		refreshToken: string | null;
	}>;
	decryptAccess?: (account: RefreshAccountRecord) => Promise<string | null>;
	encrypt: (
		claim: RefreshClaim,
		result: RefreshProviderResult,
		now: Date,
	) => Promise<PersistedRefreshTokens>;
	refreshProvider: (
		claim: RefreshClaim,
		tokens: { accessToken: string | null; refreshToken: string | null },
	) => Promise<RefreshProviderResult | null>;
	now?: () => Date;
	sleep?: (milliseconds: number) => Promise<void>;
}

export class TokenRefreshUnknownError extends Error {
	constructor(
		message: string,
		public readonly source?: RefreshAccountRecord,
	) {
		super(message);
		this.name = "TokenRefreshUnknownError";
	}
}

export class TokenRefreshAccountUnavailableError extends Error {
	constructor(accountId: string) {
		super(`Social account ${accountId} is unavailable for token refresh`);
		this.name = "TokenRefreshAccountUnavailableError";
	}
}

export class TokenRefreshInProgressError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TokenRefreshInProgressError";
	}
}

function sameRefreshSource(
	account: RefreshAccountRecord,
	source: {
		sourceTokenVersion: number;
	},
): boolean {
	return account.tokenVersion === source.sourceTokenVersion;
}

function hasRefreshCapability(
	env: Env,
	account: RefreshAccountRecord,
): boolean {
	const hasRefreshToken = Boolean(account.refreshToken);
	switch (account.platform) {
		case "twitter":
			return (
				hasRefreshToken &&
				Boolean(env.TWITTER_CLIENT_ID && env.TWITTER_CLIENT_SECRET)
			);
		case "instagram": {
			const metadata =
				account.metadata && typeof account.metadata === "object"
					? (account.metadata as Record<string, unknown>)
					: null;
			return (
				metadata?.ig_login_method !== "facebook" && Boolean(account.accessToken)
			);
		}
		case "linkedin":
			return (
				hasRefreshToken &&
				Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET)
			);
		case "tiktok":
			return (
				hasRefreshToken &&
				Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET)
			);
		case "youtube":
			return (
				hasRefreshToken &&
				Boolean(env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET)
			);
		case "googlebusiness":
			return (
				hasRefreshToken &&
				Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
			);
		case "pinterest":
			return (
				hasRefreshToken &&
				Boolean(env.PINTEREST_APP_ID && env.PINTEREST_APP_SECRET)
			);
		case "threads":
			return Boolean(account.accessToken);
		case "snapchat":
			return (
				hasRefreshToken &&
				Boolean(env.SNAPCHAT_CLIENT_ID && env.SNAPCHAT_CLIENT_SECRET)
			);
		case "reddit":
			return (
				hasRefreshToken &&
				Boolean(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET)
			);
		default:
			return false;
	}
}

function toRefreshAccountRecord(
	account: typeof socialAccounts.$inferSelect,
): RefreshAccountRecord {
	return {
		id: account.id,
		organizationId: account.organizationId,
		platform: account.platform as Platform,
		platformAccountId: account.platformAccountId,
		username: account.username,
		displayName: account.displayName,
		accessToken: account.accessToken,
		refreshToken: account.refreshToken,
		tokenVersion: account.tokenVersion,
		tokenExpiresAt: account.tokenExpiresAt,
		metadata: account.metadata,
	};
}

class DbTokenRefreshStore implements TokenRefreshStore {
	private readonly db: ReturnType<typeof createDb>;

	constructor(
		connectionString: string,
		private readonly env: Env,
		private readonly expectedOrganizationId?: string,
	) {
		this.db = createDb(connectionString);
	}

	async claim(
		accountId: string,
		mode: RefreshMode,
		now: Date,
	): Promise<RefreshClaimOutcome> {
		return this.db.transaction(async (tx) => {
			// Lock the authoritative token row first. This serializes claim decisions
			// without holding a transaction open across provider HTTP.
			const [accountRow] = await tx
				.select()
				.from(socialAccounts)
				.where(
					and(
						eq(socialAccounts.id, accountId),
						...(this.expectedOrganizationId
							? [eq(socialAccounts.organizationId, this.expectedOrganizationId)]
							: []),
						eq(socialAccounts.lifecycleStatus, "active"),
					),
				)
				.for("update")
				.limit(1);
			if (!accountRow) return { kind: "missing" } as const;
			const account = toRefreshAccountRecord(accountRow);

			if (
				mode === "if_needed" &&
				(!account.tokenExpiresAt ||
					account.tokenExpiresAt.getTime() >
						now.getTime() + REFRESH_THRESHOLD_MS)
			) {
				return { kind: "ready", account } as const;
			}
			if (!hasRefreshCapability(this.env, account)) {
				return { kind: "ready", account } as const;
			}

			const [existing] = await tx
				.select()
				.from(tokenRefreshOperations)
				.where(eq(tokenRefreshOperations.accountId, accountId))
				.for("update")
				.limit(1);

			if (existing && sameRefreshSource(account, existing)) {
				if (existing.state === "unknown") {
					return {
						kind: "blocked_unknown",
						operationId: existing.operationId,
						account,
					} as const;
				}
				if (existing.state === "request_may_have_been_sent") {
					const boundaryExpired =
						!existing.requestMayHaveBeenSentAt ||
						existing.requestMayHaveBeenSentAt.getTime() <=
							now.getTime() - TOKEN_REFRESH_BOUNDARY_STALE_MS;
					if (boundaryExpired) {
						await tx
							.update(tokenRefreshOperations)
							.set({
								state: "unknown",
								leaseExpiresAt: null,
								completedAt: now,
								lastError:
									"Provider refresh boundary expired without a durable outcome; reconnect is required",
								updatedAt: now,
							})
							.where(
								and(
									eq(tokenRefreshOperations.accountId, accountId),
									eq(tokenRefreshOperations.operationId, existing.operationId),
									eq(
										tokenRefreshOperations.fencingToken,
										existing.fencingToken,
									),
									eq(
										tokenRefreshOperations.state,
										"request_may_have_been_sent",
									),
								),
							);
						return {
							kind: "blocked_unknown",
							operationId: existing.operationId,
							account,
						} as const;
					}
					// A provider request has a 15-second deadline. Keep a conservative
					// buffer before converting an abandoned boundary to manual review;
					// never reclaim it for another provider call.
					return { kind: "busy", account } as const;
				}
				if (
					existing.state === "claimed_pre_request" &&
					existing.leaseExpiresAt &&
					existing.leaseExpiresAt.getTime() > now.getTime()
				) {
					return { kind: "busy", account } as const;
				}
			}

			const operationId = generateId("tref_");
			const fencingToken = (existing?.fencingToken ?? 0) + 1;
			const operation = {
				accountId,
				operationId,
				state: "claimed_pre_request" as const,
				fencingToken,
				sourceTokenVersion: account.tokenVersion,
				attempts: (existing?.attempts ?? 0) + 1,
				leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
				startedAt: now,
				requestMayHaveBeenSentAt: null,
				completedAt: null,
				lastError: null,
				updatedAt: now,
			};

			if (existing) {
				await tx
					.update(tokenRefreshOperations)
					.set(operation)
					.where(eq(tokenRefreshOperations.accountId, accountId));
			} else {
				await tx.insert(tokenRefreshOperations).values(operation);
			}

			return {
				kind: "claimed",
				claim: {
					operationId,
					fencingToken,
					sourceTokenVersion: account.tokenVersion,
					account,
				},
			} as const;
		});
	}

	async markRequestMayHaveBeenSent(
		claim: RefreshClaim,
		now: Date,
	): Promise<boolean> {
		const rows = await this.db
			.update(tokenRefreshOperations)
			.set({
				state: "request_may_have_been_sent",
				requestMayHaveBeenSentAt: now,
				leaseExpiresAt: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(tokenRefreshOperations.accountId, claim.account.id),
					eq(tokenRefreshOperations.operationId, claim.operationId),
					eq(tokenRefreshOperations.fencingToken, claim.fencingToken),
					eq(tokenRefreshOperations.state, "claimed_pre_request"),
				),
			)
			.returning({ accountId: tokenRefreshOperations.accountId });
		return rows.length === 1;
	}

	async persistSuccess(
		claim: RefreshClaim,
		tokens: PersistedRefreshTokens,
		now: Date,
	): Promise<RefreshAccountRecord | null> {
		return this.db.transaction(async (tx) => {
			// Preserve lock ordering with claim(): social account, then operation.
			const [currentAccount] = await tx
				.select()
				.from(socialAccounts)
				.where(eq(socialAccounts.id, claim.account.id))
				.for("update")
				.limit(1);
			const [operation] = await tx
				.select()
				.from(tokenRefreshOperations)
				.where(eq(tokenRefreshOperations.accountId, claim.account.id))
				.for("update")
				.limit(1);

			if (
				!currentAccount ||
				!operation ||
				operation.operationId !== claim.operationId ||
				operation.fencingToken !== claim.fencingToken ||
				operation.state !== "request_may_have_been_sent" ||
				!sameRefreshSource(toRefreshAccountRecord(currentAccount), claim)
			) {
				return null;
			}

			const previousMetadata =
				currentAccount.metadata && typeof currentAccount.metadata === "object"
					? (currentAccount.metadata as Record<string, unknown>)
					: null;
			let clearedMetadata: Record<string, unknown> | undefined;
			if (previousMetadata && "refresh_failed_at" in previousMetadata) {
				const { refresh_failed_at: _removed, ...rest } = previousMetadata;
				clearedMetadata = rest;
			}

			const [updated] = await tx
				.update(socialAccounts)
				.set({
					accessToken: tokens.accessToken,
					...(tokens.refreshToken !== undefined
						? { refreshToken: tokens.refreshToken }
						: {}),
					...(tokens.tokenExpiresAt !== undefined
						? { tokenExpiresAt: tokens.tokenExpiresAt }
						: {}),
					...(clearedMetadata !== undefined
						? { metadata: clearedMetadata }
						: {}),
					tokenVersion: sql`${socialAccounts.tokenVersion} + 1`,
					updatedAt: now,
				})
				.where(
					and(
						eq(socialAccounts.id, claim.account.id),
						eq(socialAccounts.lifecycleStatus, "active"),
						eq(socialAccounts.tokenVersion, claim.sourceTokenVersion),
					),
				)
				.returning();
			if (!updated) {
				await tx
					.update(tokenRefreshOperations)
					.set({
						state: "unknown",
						lastError: "token source CAS failed",
						updatedAt: now,
					})
					.where(
						and(
							eq(tokenRefreshOperations.accountId, claim.account.id),
							eq(tokenRefreshOperations.operationId, claim.operationId),
							eq(tokenRefreshOperations.fencingToken, claim.fencingToken),
						),
					);
				return null;
			}

			await tx
				.update(tokenRefreshOperations)
				.set({
					state: "succeeded",
					completedAt: now,
					leaseExpiresAt: null,
					updatedAt: now,
				})
				.where(
					and(
						eq(tokenRefreshOperations.accountId, claim.account.id),
						eq(tokenRefreshOperations.operationId, claim.operationId),
						eq(tokenRefreshOperations.fencingToken, claim.fencingToken),
					),
				);
			return toRefreshAccountRecord(updated);
		});
	}

	async markUnknown(
		claim: RefreshClaim,
		error: string,
		now: Date,
	): Promise<void> {
		await this.db
			.update(tokenRefreshOperations)
			.set({
				state: "unknown",
				lastError: error.slice(0, 2_000),
				leaseExpiresAt: null,
				completedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(tokenRefreshOperations.accountId, claim.account.id),
					eq(tokenRefreshOperations.operationId, claim.operationId),
					eq(tokenRefreshOperations.fencingToken, claim.fencingToken),
					eq(tokenRefreshOperations.state, "request_may_have_been_sent"),
				),
			);
	}

	async observe(accountId: string): Promise<{
		account: RefreshAccountRecord | null;
		operation: {
			operationId: string;
			state:
				| "claimed_pre_request"
				| "request_may_have_been_sent"
				| "succeeded"
				| "unknown";
			sourceTokenVersion: number;
			requestMayHaveBeenSentAt: Date | null;
		} | null;
	}> {
		// A locking read bypasses Hyperdrive's query cache and observes the latest
		// committed token/operation pair.
		return this.db.transaction(async (tx) => {
			const [accountRow] = await tx
				.select()
				.from(socialAccounts)
				.where(eq(socialAccounts.id, accountId))
				.for("update")
				.limit(1);
			const [operation] = await tx
				.select({
					operationId: tokenRefreshOperations.operationId,
					state: tokenRefreshOperations.state,
					sourceTokenVersion: tokenRefreshOperations.sourceTokenVersion,
					requestMayHaveBeenSentAt:
						tokenRefreshOperations.requestMayHaveBeenSentAt,
				})
				.from(tokenRefreshOperations)
				.where(eq(tokenRefreshOperations.accountId, accountId))
				.for("update")
				.limit(1);
			return {
				account: accountRow ? toRefreshAccountRecord(accountRow) : null,
				operation: operation ?? null,
			};
		});
	}
}

async function resultFromAccount(
	dependencies: CoordinatorDependencies,
	account: RefreshAccountRecord,
	refreshed: boolean,
): Promise<CoordinatedRefreshResult> {
	const accessToken = dependencies.decryptAccess
		? await dependencies.decryptAccess(account)
		: (await dependencies.decrypt(account)).accessToken;
	return { accessToken: accessToken ?? "", refreshed, account };
}

/**
 * Provider-independent refresh state machine. It is exported so concurrency and
 * crash-window behavior can be exercised with an in-memory store.
 */
export async function coordinateTokenRefresh(
	dependencies: CoordinatorDependencies,
	accountId: string,
	mode: RefreshMode,
): Promise<CoordinatedRefreshResult> {
	const now = dependencies.now ?? (() => new Date());
	const sleep =
		dependencies.sleep ??
		((milliseconds: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const outcome = await dependencies.store.claim(accountId, mode, now());

	if (outcome.kind === "missing") {
		throw new TokenRefreshAccountUnavailableError(accountId);
	}
	if (outcome.kind === "ready") {
		return resultFromAccount(dependencies, outcome.account, false);
	}
	if (outcome.kind === "blocked_unknown") {
		throw new TokenRefreshUnknownError(
			`Token refresh ${outcome.operationId} may already have reached the provider; reconnect the account before retrying`,
			outcome.account,
		);
	}
	if (outcome.kind === "busy") {
		for (let attempt = 0; attempt < BUSY_POLL_ATTEMPTS; attempt++) {
			await sleep(BUSY_POLL_INTERVAL_MS);
			const observed = await dependencies.store.observe(accountId);
			if (!observed.account) {
				throw new TokenRefreshAccountUnavailableError(accountId);
			}
			if (
				!sameRefreshSource(observed.account, {
					sourceTokenVersion: outcome.account.tokenVersion,
				})
			) {
				return resultFromAccount(dependencies, observed.account, false);
			}
			if (
				observed.operation &&
				sameRefreshSource(observed.account, observed.operation) &&
				observed.operation.state === "unknown"
			) {
				throw new TokenRefreshUnknownError(
					`Token refresh ${observed.operation.operationId} has an unknown provider outcome`,
					observed.account,
				);
			}
		}
		throw new TokenRefreshInProgressError(
			`Token refresh for account ${accountId} is still in progress`,
		);
	}

	const claim = outcome.claim;
	const plaintext = await dependencies.decrypt(claim.account);
	const boundaryAt = now();
	if (
		!(await dependencies.store.markRequestMayHaveBeenSent(claim, boundaryAt))
	) {
		throw new TokenRefreshInProgressError(
			`Token refresh claim ${claim.operationId} lost its fencing token before provider I/O`,
		);
	}

	try {
		const providerResult = await dependencies.refreshProvider(claim, plaintext);
		if (!providerResult) {
			throw new Error("provider returned no refresh token result");
		}
		const persistAt = now();
		const encrypted = await dependencies.encrypt(
			claim,
			providerResult,
			persistAt,
		);
		const updated = await dependencies.store.persistSuccess(
			claim,
			encrypted,
			persistAt,
		);
		if (!updated) {
			throw new Error("refreshed tokens were rejected by the source-token CAS");
		}
		return {
			accessToken: providerResult.access_token,
			refreshed: true,
			account: updated,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await dependencies.store.markUnknown(claim, message, now());
		throw new TokenRefreshUnknownError(
			`Token refresh ${claim.operationId} crossed the provider boundary and now has an unknown outcome: ${message}`,
			claim.account,
		);
	}
}

async function recordRefreshFailure(
	env: Env,
	source: RefreshAccountRecord,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const [account] = await db
		.update(socialAccounts)
		.set({
			metadata: sql`jsonb_set(
				coalesce(${socialAccounts.metadata}, '{}'::jsonb),
				'{refresh_failed_at}',
				to_jsonb(${now.toISOString()}::text),
				true
			)`,
			updatedAt: now,
		})
		.where(
			and(
				eq(socialAccounts.id, source.id),
				eq(socialAccounts.lifecycleStatus, "active"),
				eq(socialAccounts.tokenVersion, source.tokenVersion),
			),
		)
		.returning({
			id: socialAccounts.id,
			organizationId: socialAccounts.organizationId,
			platform: socialAccounts.platform,
			platformAccountId: socialAccounts.platformAccountId,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			tokenVersion: socialAccounts.tokenVersion,
		});
	if (!account) return;

	const dedupeKey = `token-refresh-notified:${account.id}`;
	if (await env.KV.get(dedupeKey).catch(() => null)) return;
	const accountName =
		account.displayName ?? account.username ?? account.platformAccountId;
	await logConnectionEvent(
		env,
		account.organizationId,
		{
			account_id: account.id,
			platform: account.platform,
			event: "error",
			message: `Token refresh failed for ${accountName} — reconnection needed`,
		},
		db,
	);
	await sendNotificationToOrg(env, {
		type: "account_disconnected",
		orgId: account.organizationId,
		title: "Account token expired",
		body: `Your ${account.platform} account ${accountName} needs to be reconnected`,
		data: {
			platform: account.platform,
			accountId: account.id,
			accountName,
		},
		occurrenceId: `token-refresh-failed:${account.id}:v${account.tokenVersion}`,
	}).catch((error) => {
		console.error(
			`[Token Refresh] Failed to notify about ${account.id}:`,
			error,
		);
	});
	await env.KV.put(dedupeKey, "1", { expirationTtl: 7 * 24 * 60 * 60 }).catch(
		() => {},
	);
}

function productionDependencies(
	env: Env,
	expectedOrganizationId?: string,
): CoordinatorDependencies {
	return {
		store: new DbTokenRefreshStore(
			env.HYPERDRIVE.connectionString,
			env,
			expectedOrganizationId,
		),
		decrypt: async (account) =>
			decryptAccountTokens(account, env.ENCRYPTION_KEY),
		decryptAccess: async (account) =>
			decryptAccountToken(
				account.accessToken,
				env.ENCRYPTION_KEY,
				account.id,
				"access_token",
			),
		encrypt: async (claim, result, now) => ({
			accessToken:
				(await encryptAccountToken(
					result.access_token,
					env.ENCRYPTION_KEY,
					claim.account.id,
					"access_token",
				)) ?? "",
			...(result.refresh_token
				? {
						refreshToken:
							(await encryptAccountToken(
								result.refresh_token,
								env.ENCRYPTION_KEY,
								claim.account.id,
								"refresh_token",
							)) ?? "",
					}
				: {}),
			...(result.expires_in
				? { tokenExpiresAt: new Date(now.getTime() + result.expires_in * 1000) }
				: {}),
		}),
		refreshProvider: async (claim, tokens) =>
			executeProviderTokenRefresh(
				env,
				claim.account.platform,
				{
					accessToken: tokens.accessToken,
					refreshToken: tokens.refreshToken,
				},
				claim.account.metadata,
			),
	};
}

export async function refreshTokenIfNeeded(
	env: Env,
	account: {
		id: string;
		platform: Platform;
		accessToken: string | null;
		refreshToken: string | null;
		tokenExpiresAt: Date | null;
	},
): Promise<string> {
	// The caller already loaded an authorized active account. Avoid a locking
	// transaction on every provider call when its token is clearly fresh (or has
	// no expiry); the coordinator re-reads and fences the row only near expiry.
	if (
		!account.tokenExpiresAt ||
		account.tokenExpiresAt.getTime() > Date.now() + REFRESH_THRESHOLD_MS
	) {
		return (
			(await decryptAccountToken(
				account.accessToken,
				env.ENCRYPTION_KEY,
				account.id,
				"access_token",
			)) ?? ""
		);
	}
	return (
		await coordinateTokenRefresh(
			productionDependencies(env),
			account.id,
			"if_needed",
		)
	).accessToken;
}

export async function forceRefreshToken(
	env: Env,
	accountId: string,
): Promise<CoordinatedRefreshResult> {
	return coordinateTokenRefresh(
		productionDependencies(env),
		accountId,
		"force",
	);
}

/** Queue/cron entry point. Provider I/O is coordinated by the same state machine. */
export async function refreshAccountToken(
	env: Env,
	accountId: string,
	organizationId: string,
): Promise<void> {
	let result: CoordinatedRefreshResult;
	try {
		result = await coordinateTokenRefresh(
			productionDependencies(env, organizationId),
			accountId,
			"force",
		);
	} catch (error) {
		if (error instanceof TokenRefreshUnknownError && error.source) {
			await recordRefreshFailure(env, error.source);
		}
		throw error;
	}
	if (!result.refreshed) {
		await recordRefreshFailure(env, result.account);
		return;
	}

	await env.KV.delete(`token-refresh-notified:${accountId}`).catch(() => {});
	const db = createDb(env.HYPERDRIVE.connectionString);
	try {
		const newAvatarUrl = await fetchAvatarUrl(
			result.account.platform,
			result.accessToken,
			result.account.platformAccountId,
		);
		if (newAvatarUrl) {
			const stable = await rehostAvatar(env, accountId, newAvatarUrl);
			await db
				.update(socialAccounts)
				.set({ avatarUrl: stable ?? newAvatarUrl, updatedAt: new Date() })
				.where(
					and(
						eq(socialAccounts.id, accountId),
						eq(socialAccounts.organizationId, organizationId),
						eq(socialAccounts.lifecycleStatus, "active"),
					),
				);
		}
	} catch (error) {
		console.warn(
			`[Token Refresh] Avatar re-host failed for ${accountId}:`,
			error,
		);
	}

	console.log(
		`[Token Refresh] Refreshed ${result.account.platform} account ${accountId}`,
	);
	try {
		await logConnectionEvent(
			env,
			result.account.organizationId,
			{
				account_id: accountId,
				platform: result.account.platform,
				event: "token_refreshed",
				message: `Token refreshed for ${result.account.displayName || result.account.username || result.account.platform} account`,
			},
			db,
		);
	} catch (error) {
		// The token rotation is already durable. Audit bookkeeping must never make
		// the Queue retry the provider mutation with a rotating refresh token.
		console.warn(
			`[Token Refresh] Success event logging failed for ${accountId}:`,
			error,
		);
	}
}
