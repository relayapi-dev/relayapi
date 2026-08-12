/**
 * Lease-fenced scheduled broadcast processor.
 *
 * The generic `broadcasts` / `broadcast_recipients` tables are the only
 * broadcast runtime, including WhatsApp. A worker owns a parent revision and a
 * monotonically increasing lease token; every claim, provider fence, heartbeat,
 * release, and finalization proves that ownership. Route-side cancellation
 * advances the revision, so an older worker cannot finalize over it.
 */

import {
	broadcastRecipients,
	broadcasts,
	createDb,
	socialAccounts,
} from "@relayapi/db";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { notifyRealtime } from "../lib/notify-post-update";
import type { Env } from "../types";
import {
	getAllowedRecipientHashes,
	hashRecipientIdentifier,
} from "./contact-consent";
import { sendMessage } from "./message-sender";
import { refreshTokenIfNeeded } from "./token-refresh-coordinator";

const MAX_RECIPIENTS_PER_TICK = 200;
const CHUNK_SIZE = 50;
const INTER_CHUNK_DELAY_MS = 1000;
const BROADCAST_LEASE_MS = 2 * 60 * 1000;

type BroadcastRow = typeof broadcasts.$inferSelect;

interface BroadcastLease {
	broadcast: BroadcastRow;
	revision: number;
	leaseToken: number;
}

interface ClaimedRecipient {
	id: string;
	contact_id: string | null;
	contact_identifier: string;
	contact_identifier_hash: string;
	variables: unknown;
}

export function broadcastFinalStatus(
	sent: number,
	failed: number,
	unknown: number,
): "sent" | "partially_failed" | "requires_attention" | "failed" {
	if (unknown > 0) return "requires_attention";
	if (failed === 0) return "sent";
	if (sent === 0) return "failed";
	return "partially_failed";
}

function leaseExpiry(): Date {
	return new Date(Date.now() + BROADCAST_LEASE_MS);
}

export async function processScheduledBroadcasts(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const candidates = await db
		.select()
		.from(broadcasts)
		.where(
			and(
				or(
					and(
						eq(broadcasts.status, "scheduled"),
						lte(broadcasts.scheduledAt, now),
					),
					eq(broadcasts.status, "sending"),
				),
				or(
					isNull(broadcasts.leaseExpiresAt),
					lte(broadcasts.leaseExpiresAt, now),
				),
			),
		)
		.orderBy(asc(broadcasts.scheduledAt), asc(broadcasts.id))
		.limit(5);

	let budget = MAX_RECIPIENTS_PER_TICK;
	for (const candidate of candidates) {
		if (budget <= 0) break;
		try {
			const lease = await claimBroadcastLease(db, candidate, env);
			if (!lease) continue;
			budget -= await executeBroadcast(db, lease, env, budget);
		} catch (error) {
			console.error(
				`[broadcast-processor] Failed to process broadcast ${candidate.id}:`,
				error,
			);
			// The bounded lease expires and makes the parent recoverable. Recipients
			// that crossed the provider boundary become `unknown` on the next claim.
		}
	}
}

async function claimBroadcastLease(
	db: ReturnType<typeof createDb>,
	candidate: BroadcastRow,
	env: Env,
): Promise<BroadcastLease | null> {
	const now = new Date();
	const [claimed] = await db
		.update(broadcasts)
		.set({
			status: "sending",
			revision: sql`${broadcasts.revision} + 1`,
			leaseToken: sql`${broadcasts.leaseToken} + 1`,
			leaseExpiresAt: leaseExpiry(),
			updatedAt: now,
		})
		.where(
			and(
				eq(broadcasts.id, candidate.id),
				eq(broadcasts.organizationId, candidate.organizationId),
				eq(broadcasts.revision, candidate.revision),
				candidate.status === "scheduled"
					? and(
							eq(broadcasts.status, "scheduled"),
							lte(broadcasts.scheduledAt, now),
						)
					: eq(broadcasts.status, "sending"),
				or(
					isNull(broadcasts.leaseExpiresAt),
					lte(broadcasts.leaseExpiresAt, now),
				),
			),
		)
		.returning();
	if (!claimed) return null;

	// Recover only the previous lease's incomplete claims. Work that definitely
	// did not reach the provider can retry; work that may have reached it cannot.
	await db.execute(sql`
		UPDATE broadcast_recipients
		   SET status = CASE
		                  WHEN request_may_have_been_sent_at IS NULL THEN 'pending'
		                  ELSE 'unknown'
		                END,
		       delivery_state = CASE
		                          WHEN request_may_have_been_sent_at IS NULL THEN 'pending'
		                          ELSE 'unknown'
		                        END,
		       claimed_at = NULL,
		       error = CASE
		                 WHEN request_may_have_been_sent_at IS NULL THEN NULL
		                 ELSE 'Delivery worker stopped after the provider boundary'
		               END
		 WHERE broadcast_id = ${claimed.id}
		   AND organization_id = ${claimed.organizationId}
		   AND scope_key = ${claimed.scopeKey}
		   AND status = 'sending'
	`);

	if (candidate.status === "scheduled") {
		await notifyRealtime(env, claimed.organizationId, {
			type: "broadcast.updated",
			broadcast_id: claimed.id,
			status: "sending",
		}).catch(() => {});
	}

	return {
		broadcast: claimed,
		revision: claimed.revision,
		leaseToken: claimed.leaseToken,
	};
}

async function renewLease(
	db: ReturnType<typeof createDb>,
	lease: BroadcastLease,
): Promise<boolean> {
	const renewed = await db
		.update(broadcasts)
		.set({ leaseExpiresAt: leaseExpiry(), updatedAt: new Date() })
		.where(
			and(
				eq(broadcasts.id, lease.broadcast.id),
				eq(broadcasts.organizationId, lease.broadcast.organizationId),
				eq(broadcasts.status, "sending"),
				eq(broadcasts.revision, lease.revision),
				eq(broadcasts.leaseToken, lease.leaseToken),
				gt(broadcasts.leaseExpiresAt, new Date()),
			),
		)
		.returning({ id: broadcasts.id });
	return renewed.length === 1;
}

async function claimRecipientChunk(
	db: ReturnType<typeof createDb>,
	lease: BroadcastLease,
	limit: number,
): Promise<ClaimedRecipient[]> {
	return (await db.execute(sql`
		WITH claimed AS (
			SELECT r.id
			  FROM broadcast_recipients r
			 WHERE r.broadcast_id = ${lease.broadcast.id}
			   AND r.organization_id = ${lease.broadcast.organizationId}
			   AND r.scope_key = ${lease.broadcast.scopeKey}
			   AND r.status = 'pending'
			   AND r.contact_identifier IS NOT NULL
			   AND r.pii_erased_at IS NULL
			   AND EXISTS (
			       SELECT 1
			         FROM broadcasts b
			         JOIN social_accounts a
			           ON a.id = b.social_account_id
			          AND a.organization_id = b.organization_id
			          AND a.scope_key = b.scope_key
			          AND a.platform = b.platform
			        WHERE b.id = ${lease.broadcast.id}
			          AND b.organization_id = ${lease.broadcast.organizationId}
			          AND b.status = 'sending'
			          AND b.revision = ${lease.revision}
			          AND b.lease_token = ${lease.leaseToken}
			          AND b.lease_expires_at > NOW()
			          AND a.lifecycle_status = 'active'
			   )
			 ORDER BY r.id ASC
			 LIMIT ${limit}
			 FOR UPDATE SKIP LOCKED
		)
		UPDATE broadcast_recipients r
		   SET status = 'sending',
		       delivery_state = 'in_flight',
		       claimed_at = NOW(),
		       request_may_have_been_sent_at = NULL,
		       error = NULL
		  FROM claimed
		 WHERE r.id = claimed.id
		RETURNING r.id, r.contact_id, r.contact_identifier,
		          r.contact_identifier_hash, r.variables
	`)) as unknown as ClaimedRecipient[];
}

async function loadProviderFence(
	db: ReturnType<typeof createDb>,
	lease: BroadcastLease,
) {
	const [account] = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			accessToken: socialAccounts.accessToken,
			refreshToken: socialAccounts.refreshToken,
			tokenExpiresAt: socialAccounts.tokenExpiresAt,
			tokenVersion: socialAccounts.tokenVersion,
			platformAccountId: socialAccounts.platformAccountId,
		})
		.from(broadcasts)
		.innerJoin(
			socialAccounts,
			and(
				eq(socialAccounts.id, broadcasts.socialAccountId),
				eq(socialAccounts.organizationId, broadcasts.organizationId),
				eq(socialAccounts.scopeKey, broadcasts.scopeKey),
				eq(socialAccounts.platform, broadcasts.platform),
			),
		)
		.where(
			and(
				eq(broadcasts.id, lease.broadcast.id),
				eq(broadcasts.organizationId, lease.broadcast.organizationId),
				eq(broadcasts.status, "sending"),
				eq(broadcasts.revision, lease.revision),
				eq(broadcasts.leaseToken, lease.leaseToken),
				gt(broadcasts.leaseExpiresAt, new Date()),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		)
		.limit(1);
	return account ?? null;
}

async function authorizeProviderChunk(
	db: ReturnType<typeof createDb>,
	lease: BroadcastLease,
	env: Env,
) {
	let account = await loadProviderFence(db, lease);
	if (!account) return null;
	let token = await refreshTokenIfNeeded(env, account);
	if (!token) return null;

	// Token refresh can advance token_version, and disconnect can race refresh.
	// Re-read the exact active account + parent lease immediately before the
	// message provider boundary. If the grant changed, decrypt the current grant
	// and fence it once more before returning it to the chunk sender.
	let fenced = await loadProviderFence(db, lease);
	if (!fenced) return null;
	if (fenced.tokenVersion !== account.tokenVersion) {
		token = await refreshTokenIfNeeded(env, fenced);
		if (!token) return null;
		account = fenced;
		fenced = await loadProviderFence(db, lease);
		if (!fenced || fenced.tokenVersion !== account.tokenVersion) return null;
	}
	return { account: fenced, token };
}

async function releaseUnattemptedClaims(
	db: ReturnType<typeof createDb>,
	lease: BroadcastLease,
	ids: string[],
): Promise<void> {
	if (ids.length === 0) return;
	await db.execute(sql`
		UPDATE broadcast_recipients r
		   SET status = CASE WHEN b.status = 'cancelled' THEN 'cancelled' ELSE 'pending' END,
		       delivery_state = CASE WHEN b.status = 'cancelled' THEN 'cancelled' ELSE 'pending' END,
		       claimed_at = NULL,
		       error = CASE WHEN b.status = 'cancelled'
		                    THEN 'Broadcast cancelled before provider delivery'
		                    ELSE NULL END
		  FROM broadcasts b
		 WHERE b.id = r.broadcast_id
		   AND r.id IN (${sql.join(
					ids.map((id) => sql`${id}`),
					sql`, `,
				)})
		   AND r.broadcast_id = ${lease.broadcast.id}
		   AND r.organization_id = ${lease.broadcast.organizationId}
		   AND r.scope_key = ${lease.broadcast.scopeKey}
		   AND r.status = 'sending'
		   AND r.request_may_have_been_sent_at IS NULL
	`);
}

async function failRemainingRecipients(
	db: ReturnType<typeof createDb>,
	lease: BroadcastLease,
	error: string,
): Promise<void> {
	await db.execute(sql`
		UPDATE broadcast_recipients
		   SET status = 'failed',
		       delivery_state = 'failed',
		       claimed_at = NULL,
		       error = ${error}
		 WHERE broadcast_id = ${lease.broadcast.id}
		   AND organization_id = ${lease.broadcast.organizationId}
		   AND scope_key = ${lease.broadcast.scopeKey}
		   AND (
		       status = 'pending'
		       OR (status = 'sending' AND request_may_have_been_sent_at IS NULL)
		   )
	`);
}

async function executeBroadcast(
	db: ReturnType<typeof createDb>,
	lease: BroadcastLease,
	env: Env,
	budget: number,
): Promise<number> {
	let processed = 0;
	while (processed < budget) {
		if (!(await renewLease(db, lease))) return processed;
		const batch = await claimRecipientChunk(
			db,
			lease,
			Math.min(CHUNK_SIZE, budget - processed),
		);
		if (batch.length === 0) break;

		const allowedHashes = await getAllowedRecipientHashes(
			db,
			env.ENCRYPTION_KEY,
			lease.broadcast.organizationId,
			lease.broadcast.platform,
			"marketing",
			batch.map((recipient) => ({
				identifier: recipient.contact_identifier,
				contactId: recipient.contact_id,
			})),
		);
		const withHashes = await Promise.all(
			batch.map(async (recipient) => ({
				...recipient,
				contact_identifier_hash:
					recipient.contact_identifier_hash ||
					(await hashRecipientIdentifier(
						env.ENCRYPTION_KEY,
						lease.broadcast.organizationId,
						lease.broadcast.platform,
						"marketing",
						recipient.contact_identifier,
					)),
			})),
		);
		const sendBatch = withHashes.filter((recipient) =>
			allowedHashes.has(recipient.contact_identifier_hash),
		);
		const suppressedIds = withHashes
			.filter(
				(recipient) => !allowedHashes.has(recipient.contact_identifier_hash),
			)
			.map((recipient) => recipient.id);
		if (suppressedIds.length > 0) {
			await db
				.update(broadcastRecipients)
				.set({
					status: "failed",
					deliveryState: "failed",
					claimedAt: null,
					error: "Current channel/purpose consent is required",
				})
				.where(
					and(
						inArray(broadcastRecipients.id, suppressedIds),
						eq(broadcastRecipients.status, "sending"),
						isNull(broadcastRecipients.requestMayHaveBeenSentAt),
					),
				);
		}
		if (sendBatch.length === 0) {
			processed += batch.length;
			continue;
		}

		const authorization = await authorizeProviderChunk(db, lease, env);
		if (!authorization) {
			if (await renewLease(db, lease)) {
				await failRemainingRecipients(
					db,
					lease,
					"Broadcast account is inactive or has no usable access token",
				);
			} else {
				await releaseUnattemptedClaims(
					db,
					lease,
					sendBatch.map((recipient) => recipient.id),
				);
				return processed;
			}
			break;
		}

		// Mark only still-owned recipient claims as having crossed the provider
		// boundary. Cancellation can safely cancel every other pending/claimed row.
		const marked = (await db.execute(sql`
			UPDATE broadcast_recipients r
			   SET delivery_state = 'unknown', request_may_have_been_sent_at = NOW()
			 WHERE r.id IN (${sql.join(
					sendBatch.map((recipient) => sql`${recipient.id}`),
					sql`, `,
				)})
			   AND r.broadcast_id = ${lease.broadcast.id}
			   AND r.organization_id = ${lease.broadcast.organizationId}
			   AND r.scope_key = ${lease.broadcast.scopeKey}
			   AND r.status = 'sending'
			   AND r.request_may_have_been_sent_at IS NULL
			   AND EXISTS (
			       SELECT 1
			         FROM broadcasts b
			         JOIN social_accounts a
			           ON a.id = b.social_account_id
			          AND a.organization_id = b.organization_id
			          AND a.scope_key = b.scope_key
			          AND a.platform = b.platform
			        WHERE b.id = ${lease.broadcast.id}
			          AND b.organization_id = ${lease.broadcast.organizationId}
			          AND b.status = 'sending'
			          AND b.revision = ${lease.revision}
			          AND b.lease_token = ${lease.leaseToken}
			          AND b.lease_expires_at > NOW()
			          AND a.lifecycle_status = 'active'
			          AND a.token_version = ${authorization.account.tokenVersion}
			   )
			RETURNING r.id
		`)) as unknown as Array<{ id: string }>;
		const markedIds = new Set(marked.map((row) => row.id));
		const unmarkedIds = sendBatch
			.filter((recipient) => !markedIds.has(recipient.id))
			.map((recipient) => recipient.id);
		await releaseUnattemptedClaims(db, lease, unmarkedIds);
		const providerBatch = sendBatch.filter((recipient) =>
			markedIds.has(recipient.id),
		);
		if (providerBatch.length === 0) {
			processed += batch.length;
			continue;
		}

		const results = await Promise.allSettled(
			providerBatch.map((recipient) =>
				sendMessage({
					platform: lease.broadcast.platform,
					accessToken: authorization.token,
					platformAccountId: authorization.account.platformAccountId ?? "",
					recipientId: recipient.contact_identifier,
					text: lease.broadcast.messageText ?? "",
					templateName: lease.broadcast.templateName ?? undefined,
					templateLanguage: lease.broadcast.templateLanguage ?? undefined,
					templateComponents:
						(recipient.variables
							? (recipient.variables as unknown[])
							: (lease.broadcast.templateComponents as unknown[] | null)) ??
						undefined,
				}),
			),
		);

		const sentRows: Array<{ id: string; messageId: string | null }> = [];
		const failedRows: Array<{ id: string; error: string }> = [];
		const unknownRows: Array<{ id: string; error: string }> = [];
		for (const [index, settled] of results.entries()) {
			const recipient = providerBatch[index];
			if (!recipient) continue;
			if (settled.status === "fulfilled" && settled.value.success) {
				sentRows.push({
					id: recipient.id,
					messageId: settled.value.messageId ?? null,
				});
			} else if (settled.status === "fulfilled") {
				failedRows.push({
					id: recipient.id,
					error: settled.value.error ?? "Provider rejected the message",
				});
			} else {
				unknownRows.push({
					id: recipient.id,
					error:
						settled.reason instanceof Error
							? settled.reason.message
							: "Provider outcome unknown",
				});
			}
		}
		await persistChunkOutcomes(db, sentRows, failedRows, unknownRows);
		processed += batch.length;
		if (processed < budget) {
			await new Promise((resolve) => setTimeout(resolve, INTER_CHUNK_DELAY_MS));
		}
	}

	await finalizeOrRelease(db, lease, env);
	return processed;
}

async function persistChunkOutcomes(
	db: ReturnType<typeof createDb>,
	sentRows: Array<{ id: string; messageId: string | null }>,
	failedRows: Array<{ id: string; error: string }>,
	unknownRows: Array<{ id: string; error: string }>,
): Promise<void> {
	const writes: Promise<unknown>[] = [];
	if (sentRows.length > 0) {
		const values = sql.join(
			sentRows.map((row) => sql`(${row.id}::text, ${row.messageId}::text)`),
			sql`, `,
		);
		writes.push(
			db.execute(sql`
				UPDATE broadcast_recipients r
				   SET status = 'sent', delivery_state = 'succeeded',
				       message_id = v.message_id, sent_at = NOW()
				  FROM (VALUES ${values}) AS v(id, message_id)
				 WHERE r.id = v.id AND r.status = 'sending'
			`),
		);
	}
	if (failedRows.length > 0) {
		const values = sql.join(
			failedRows.map((row) => sql`(${row.id}::text, ${row.error}::text)`),
			sql`, `,
		);
		writes.push(
			db.execute(sql`
				UPDATE broadcast_recipients r
				   SET status = 'failed', delivery_state = 'failed', error = v.error
				  FROM (VALUES ${values}) AS v(id, error)
				 WHERE r.id = v.id AND r.status = 'sending'
			`),
		);
	}
	if (unknownRows.length > 0) {
		const values = sql.join(
			unknownRows.map((row) => sql`(${row.id}::text, ${row.error}::text)`),
			sql`, `,
		);
		writes.push(
			db.execute(sql`
				UPDATE broadcast_recipients r
				   SET status = 'unknown', delivery_state = 'unknown', error = v.error
				  FROM (VALUES ${values}) AS v(id, error)
				 WHERE r.id = v.id AND r.status = 'sending'
			`),
		);
	}
	await Promise.all(writes);
}

async function finalizeOrRelease(
	db: ReturnType<typeof createDb>,
	lease: BroadcastLease,
	env: Env,
): Promise<void> {
	const [counts] = await db
		.select({
			pending: sql<number>`count(*) FILTER (WHERE ${broadcastRecipients.status} IN ('pending', 'sending'))::int`,
			sent: sql<number>`count(*) FILTER (WHERE ${broadcastRecipients.status} = 'sent')::int`,
			failed: sql<number>`count(*) FILTER (WHERE ${broadcastRecipients.status} = 'failed')::int`,
			unknown: sql<number>`count(*) FILTER (WHERE ${broadcastRecipients.status} = 'unknown')::int`,
		})
		.from(broadcastRecipients)
		.where(
			and(
				eq(broadcastRecipients.broadcastId, lease.broadcast.id),
				eq(broadcastRecipients.organizationId, lease.broadcast.organizationId),
				eq(broadcastRecipients.scopeKey, lease.broadcast.scopeKey),
			),
		);
	if ((counts?.pending ?? 0) > 0) {
		await db
			.update(broadcasts)
			.set({ leaseExpiresAt: null, updatedAt: new Date() })
			.where(
				and(
					eq(broadcasts.id, lease.broadcast.id),
					eq(broadcasts.organizationId, lease.broadcast.organizationId),
					eq(broadcasts.status, "sending"),
					eq(broadcasts.revision, lease.revision),
					eq(broadcasts.leaseToken, lease.leaseToken),
				),
			);
		return;
	}

	const sent = counts?.sent ?? 0;
	const failed = counts?.failed ?? 0;
	const unknown = counts?.unknown ?? 0;
	const finalStatus = broadcastFinalStatus(sent, failed, unknown);
	const finalized = await db
		.update(broadcasts)
		.set({
			status: finalStatus,
			sentCount: sent,
			failedCount: failed,
			completedAt: new Date(),
			leaseExpiresAt: null,
			revision: sql`${broadcasts.revision} + 1`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(broadcasts.id, lease.broadcast.id),
				eq(broadcasts.organizationId, lease.broadcast.organizationId),
				eq(broadcasts.status, "sending"),
				eq(broadcasts.revision, lease.revision),
				eq(broadcasts.leaseToken, lease.leaseToken),
				gt(broadcasts.leaseExpiresAt, new Date()),
			),
		)
		.returning({ id: broadcasts.id });
	if (finalized.length === 0) return;

	await notifyRealtime(env, lease.broadcast.organizationId, {
		type: "broadcast.updated",
		broadcast_id: lease.broadcast.id,
		status: finalStatus,
	}).catch(() => {});
}
