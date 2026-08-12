import {
	accountRevocationJobs,
	connectionLogs,
	createDb,
	type Database,
	socialAccounts,
} from "@relayapi/db";
import { and, asc, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import { decryptAccountToken } from "../lib/account-token-crypto";
import { readResponseBytes } from "../lib/fetch-public-url";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import type { Env } from "../types";
import { deleteStoredAvatar } from "./avatar-store";

const LEASE_MS = 5 * 60_000;
const REVOCATION_TIMEOUT_MS = 10_000;
const REVOCATION_RESPONSE_MAX_BYTES = 64 * 1024;
export const REVOCATION_AUTOMATIC_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

type RevocationResult =
	| { kind: "succeeded"; response?: Record<string, unknown> }
	| { kind: "manual_required"; reason: string }
	| { kind: "retry"; reason: string }
	| { kind: "unknown"; reason: string };

export function revocationNeedsManualReview(
	createdAt: Date,
	now: Date,
): boolean {
	return now.getTime() - createdAt.getTime() >= REVOCATION_AUTOMATIC_RETRY_MS;
}

function revocationRetryAt(attempts: number, now: Date): Date {
	return new Date(
		now.getTime() + Math.min(86_400_000, 2 ** Math.min(attempts, 10) * 60_000),
	);
}

export function isCurrentCredentialSource(
	currentTokenVersion: number,
	sourceTokenVersion: number,
): boolean {
	return currentTokenVersion === sourceTokenVersion;
}

/**
 * Complete the old grant's revocation job when an authoritative credential
 * write advances the account's monotonic token version. Reconnect paths call
 * this in the credential-write transaction so no obsolete job survives commit.
 */
export async function supersedeAccountRevocationJob(
	db: Pick<Database, "update">,
	params: {
		accountId: string;
		organizationId: string;
		tokenVersion: number;
	},
): Promise<void> {
	const now = new Date();
	await db
		.update(accountRevocationJobs)
		.set({
			status: "succeeded",
			accessTokenCiphertext: null,
			refreshTokenCiphertext: null,
			leaseExpiresAt: null,
			lastError: null,
			providerResponse: { superseded_by_reconnect: true },
			completedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(accountRevocationJobs.accountId, params.accountId),
				eq(accountRevocationJobs.organizationId, params.organizationId),
				ne(accountRevocationJobs.sourceTokenVersion, params.tokenVersion),
			),
		);
}

async function revokeProviderToken(
	env: Env,
	platform: string,
	token: string,
): Promise<RevocationResult> {
	let response: Response;
	if (platform === "youtube" || platform === "googlebusiness") {
		// Official Google OAuth revocation endpoint:
		// https://developers.google.com/identity/openid-connect/reference#revocation_endpoint
		response = await fetchWithTimeout("https://oauth2.googleapis.com/revoke", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token }),
			timeout: REVOCATION_TIMEOUT_MS,
			timeoutThroughBody: true,
		});
	} else if (platform === "tiktok") {
		// Official TikTok endpoint and fields:
		// https://developers.tiktok.com/doc/oauth-user-access-token-management
		if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
			return { kind: "retry", reason: "TikTok OAuth credentials unavailable" };
		}
		response = await fetchWithTimeout(
			"https://open.tiktokapis.com/v2/oauth/revoke/",
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_key: env.TIKTOK_CLIENT_KEY,
					client_secret: env.TIKTOK_CLIENT_SECRET,
					token,
				}),
				timeout: REVOCATION_TIMEOUT_MS,
				timeoutThroughBody: true,
			},
		);
	} else {
		return {
			kind: "manual_required",
			reason: `No verified server-side revocation endpoint is configured for ${platform}`,
		};
	}

	const body = new TextDecoder().decode(
		await readResponseBytes(response, REVOCATION_RESPONSE_MAX_BYTES),
	);
	if (
		response.ok ||
		(response.status === 400 && body.includes("invalid_token"))
	) {
		return {
			kind: "succeeded",
			response: { status: response.status, body: body.slice(0, 1000) },
		};
	}
	if (response.status === 429 || response.status >= 500) {
		return {
			kind: "retry",
			reason: `Provider revocation returned ${response.status}: ${body.slice(0, 500)}`,
		};
	}
	return {
		kind: "manual_required",
		reason: `Provider revocation was rejected (${response.status}): ${body.slice(0, 500)}`,
	};
}

export async function processAccountRevocations(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const retryCutoff = new Date(now.getTime() - REVOCATION_AUTOMATIC_RETRY_MS);

	// Seven days is the owner-selected automatic cleanup boundary. Provider
	// cleanup evidence survives, but the copied credential is redacted before
	// the row enters manual handling.
	await db
		.update(accountRevocationJobs)
		.set({
			status: "manual_required",
			accessTokenCiphertext: null,
			refreshTokenCiphertext: null,
			leaseExpiresAt: null,
			lastError: sql`COALESCE(${accountRevocationJobs.lastError}, 'Provider revocation exceeded the seven-day automatic retry window')`,
			completedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				or(
					inArray(accountRevocationJobs.status, [
						"pending",
						"retry",
						"unknown",
					]),
					and(
						eq(accountRevocationJobs.status, "processing"),
						lte(accountRevocationJobs.leaseExpiresAt, now),
					),
				),
				lte(accountRevocationJobs.createdAt, retryCutoff),
			),
		);

	const due = await db
		.select({
			id: accountRevocationJobs.id,
			status: accountRevocationJobs.status,
			attempts: accountRevocationJobs.attempts,
			leaseToken: accountRevocationJobs.leaseToken,
			requestMayHaveBeenSentAt: accountRevocationJobs.requestMayHaveBeenSentAt,
		})
		.from(accountRevocationJobs)
		.where(
			and(
				or(
					and(
						inArray(accountRevocationJobs.status, [
							"pending",
							"retry",
							"unknown",
						]),
						lte(accountRevocationJobs.nextAttemptAt, now),
					),
					and(
						eq(accountRevocationJobs.status, "processing"),
						lte(accountRevocationJobs.leaseExpiresAt, now),
					),
				),
				sql`${accountRevocationJobs.createdAt} > ${retryCutoff}`,
			),
		)
		.orderBy(
			asc(accountRevocationJobs.nextAttemptAt),
			asc(accountRevocationJobs.createdAt),
			asc(accountRevocationJobs.id),
		)
		.limit(20);

	for (const candidate of due) {
		// A dead worker crossed the provider boundary. Persist the ambiguity
		// before scheduling the next idempotent revocation attempt.
		if (
			candidate.status === "processing" &&
			candidate.requestMayHaveBeenSentAt
		) {
			await db
				.update(accountRevocationJobs)
				.set({
					status: "unknown",
					leaseExpiresAt: null,
					lastError:
						"Revocation worker lease expired after the provider request boundary",
					nextAttemptAt: revocationRetryAt(candidate.attempts, now),
					updatedAt: now,
				})
				.where(
					and(
						eq(accountRevocationJobs.id, candidate.id),
						eq(accountRevocationJobs.status, "processing"),
						eq(accountRevocationJobs.leaseToken, candidate.leaseToken),
						lte(accountRevocationJobs.leaseExpiresAt, now),
					),
				);
			continue;
		}

		const claimNow = new Date();
		const [job] = await db
			.update(accountRevocationJobs)
			.set({
				status: "processing",
				attempts: sql`${accountRevocationJobs.attempts} + 1`,
				leaseToken: sql`${accountRevocationJobs.leaseToken} + 1`,
				leaseExpiresAt: new Date(claimNow.getTime() + LEASE_MS),
				requestMayHaveBeenSentAt: null,
				updatedAt: claimNow,
			})
			.where(
				and(
					eq(accountRevocationJobs.id, candidate.id),
					sql`${accountRevocationJobs.createdAt} > ${retryCutoff}`,
					or(
						and(
							inArray(accountRevocationJobs.status, [
								"pending",
								"retry",
								"unknown",
							]),
							lte(accountRevocationJobs.nextAttemptAt, claimNow),
						),
						and(
							eq(accountRevocationJobs.status, "processing"),
							lte(accountRevocationJobs.leaseExpiresAt, claimNow),
							sql`${accountRevocationJobs.requestMayHaveBeenSentAt} IS NULL`,
						),
					),
				),
			)
			.returning();
		if (!job) continue;
		const [currentAccount] = await db
			.select({ tokenVersion: socialAccounts.tokenVersion })
			.from(socialAccounts)
			.where(eq(socialAccounts.id, job.accountId))
			.limit(1);
		if (
			currentAccount &&
			!isCurrentCredentialSource(
				currentAccount.tokenVersion,
				job.sourceTokenVersion,
			)
		) {
			await supersedeAccountRevocationJob(db, {
				accountId: job.accountId,
				organizationId: job.organizationId,
				tokenVersion: currentAccount.tokenVersion,
			});
			continue;
		}

		const tokenField =
			job.platform === "tiktok" || !job.refreshTokenCiphertext
				? "access_token"
				: "refresh_token";
		const token = await decryptAccountToken(
			job.platform === "tiktok"
				? job.accessTokenCiphertext
				: (job.refreshTokenCiphertext ?? job.accessTokenCiphertext),
			env.ENCRYPTION_KEY,
			job.accountId,
			tokenField,
		).catch(() => null);

		let result: RevocationResult;
		let requestBoundary: Date | null = null;
		if (!token) {
			result = {
				kind: "manual_required",
				reason: "No decryptable provider credential remains",
			};
		} else {
			requestBoundary = new Date();
			const [armed] = await db
				.update(accountRevocationJobs)
				.set({
					requestMayHaveBeenSentAt: requestBoundary,
					updatedAt: requestBoundary,
				})
				.where(
					and(
						eq(accountRevocationJobs.id, job.id),
						eq(accountRevocationJobs.status, "processing"),
						eq(accountRevocationJobs.leaseToken, job.leaseToken),
					),
				)
				.returning({ id: accountRevocationJobs.id });
			if (!armed) continue;
			result = await revokeProviderToken(env, job.platform, token).catch(
				(error): RevocationResult => ({
					kind: "unknown",
					reason: error instanceof Error ? error.message : String(error),
				}),
			);
		}

		if (result.kind === "retry" || result.kind === "unknown") {
			const outcomeAt = new Date();
			const agedOut = revocationNeedsManualReview(job.createdAt, outcomeAt);
			await db
				.update(accountRevocationJobs)
				.set({
					status: agedOut ? "manual_required" : result.kind,
					...(agedOut
						? {
								accessTokenCiphertext: null,
								refreshTokenCiphertext: null,
								completedAt: outcomeAt,
							}
						: {}),
					lastError: result.reason,
					leaseExpiresAt: null,
					requestMayHaveBeenSentAt:
						result.kind === "unknown" ? requestBoundary : null,
					nextAttemptAt: revocationRetryAt(job.attempts, outcomeAt),
					updatedAt: outcomeAt,
				})
				.where(
					and(
						eq(accountRevocationJobs.id, job.id),
						eq(accountRevocationJobs.status, "processing"),
						eq(accountRevocationJobs.leaseToken, job.leaseToken),
					),
				);
			continue;
		}

		const completedAt = new Date();
		const disconnected = await db.transaction(async (tx) => {
			const finalizedJobs = await tx
				.update(accountRevocationJobs)
				.set({
					status: result.kind,
					lastError: result.kind === "manual_required" ? result.reason : null,
					providerResponse:
						result.kind === "succeeded" ? (result.response ?? {}) : null,
					accessTokenCiphertext: null,
					refreshTokenCiphertext: null,
					leaseExpiresAt: null,
					completedAt,
					updatedAt: completedAt,
				})
				.where(
					and(
						eq(accountRevocationJobs.id, job.id),
						eq(accountRevocationJobs.status, "processing"),
						eq(accountRevocationJobs.leaseToken, job.leaseToken),
					),
				)
				.returning({ id: accountRevocationJobs.id });
			if (finalizedJobs.length === 0) return false;
			await tx.insert(connectionLogs).values({
				organizationId: job.organizationId,
				socialAccountId: job.accountId,
				platform: job.platform,
				event: "disconnected",
				message:
					result.kind === "succeeded"
						? "Provider credential cleanup completed"
						: `Provider cleanup requires manual action: ${result.reason}`,
				snapshot: {
					revocation_job_id: job.id,
					provider_revocation: result.kind,
					completed_at: completedAt.toISOString(),
				},
			});
			return true;
		});
		if (disconnected) await deleteStoredAvatar(env, job.accountId);
	}
}
