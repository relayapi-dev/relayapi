import { createDb, emailDeliveries, organization, user } from "@relayapi/db";
import { and, eq, lte, or, sql } from "drizzle-orm";
import { decryptToken } from "../lib/crypto";
import { isSelfHosted, selfHostedFeatureEnabled } from "../lib/deployment-mode";
import { processEmailMessage } from "../lib/email-queue/consumer";
import {
	EMAIL_PROVIDER_MAX_ATTEMPTS,
	nextEmailProviderAttemptAt,
} from "../lib/email-queue/policy";
import type {
	EmailDeliveryEnvelope,
	EmailQueueMessage,
} from "../lib/email-queue/types";
import type { Env } from "../types";
import { recordQueueFailure } from "./failures";

const EMAIL_CLAIM_MS = 60_000;

function isEmailQueueMessage(value: unknown): value is EmailQueueMessage {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const body = value as Record<string, unknown>;
	return (
		typeof body.id === "string" &&
		body.id.length > 0 &&
		Object.keys(body).every((key) => key === "id")
	);
}

function parseEmailEnvelope(value: string): EmailDeliveryEnvelope {
	const parsed = JSON.parse(value) as Partial<EmailDeliveryEnvelope>;
	if (
		typeof parsed.to !== "string" ||
		parsed.to.length === 0 ||
		typeof parsed.subject !== "string" ||
		typeof parsed.html !== "string" ||
		(parsed.from !== undefined && typeof parsed.from !== "string")
	) {
		throw new Error("Encrypted email delivery envelope is invalid");
	}
	return {
		to: parsed.to,
		subject: parsed.subject,
		html: parsed.html,
		...(parsed.from ? { from: parsed.from } : {}),
	};
}

export async function consumeEmailQueue(
	batch: MessageBatch<EmailQueueMessage>,
	env: Env,
): Promise<void> {
	for (const message of batch.messages) {
		if (isSelfHosted(env) && !selfHostedFeatureEnabled(env, "email")) {
			message.ack();
			continue;
		}
		if (!isEmailQueueMessage(message.body)) {
			await recordQueueFailure(
				env,
				batch.queue,
				message,
				"permanent_input",
				"Invalid email queue payload",
			);
			message.ack();
			continue;
		}
		const body = message.body;
		const db = createDb(env.HYPERDRIVE.connectionString);
		const claim = await db.transaction(async (tx) => {
			const claimAt = new Date();
			const [ledger] = await tx
				.select()
				.from(emailDeliveries)
				.where(eq(emailDeliveries.id, body.id))
				.for("update")
				.limit(1);
			if (!ledger) return { state: "missing" as const };
			if (ledger.intent === "organization" && ledger.organizationId) {
				const [activeOrganization] = await tx
					.select({ id: organization.id })
					.from(organization)
					.where(
						and(
							eq(organization.id, ledger.organizationId),
							eq(organization.lifecycleStatus, "active"),
						),
					)
					.for("key share")
					.limit(1);
				if (!activeOrganization) return { state: "inactive" as const };
			} else if (ledger.intent === "auth_user" && ledger.authUserId) {
				const [activeUser] = await tx
					.select({ id: user.id })
					.from(user)
					.where(eq(user.id, ledger.authUserId))
					.for("key share")
					.limit(1);
				if (!activeUser) return { state: "inactive" as const };
			} else {
				return { state: "inactive" as const };
			}
			if (
				ledger.status === "sent" ||
				ledger.status === "failed" ||
				ledger.status === "manual_review"
			) {
				return { state: "terminal" as const };
			}
			if (
				ledger.status === "processing" &&
				ledger.leaseExpiresAt &&
				ledger.leaseExpiresAt > claimAt
			) {
				return { state: "busy" as const };
			}
			if (
				ledger.deadlineAt <= claimAt ||
				ledger.providerAttempts >= EMAIL_PROVIDER_MAX_ATTEMPTS
			) {
				await tx
					.update(emailDeliveries)
					.set({
						status: "manual_review",
						leaseExpiresAt: null,
						error:
							ledger.deadlineAt <= claimAt
								? "Email delivery exceeded its durable provider deadline"
								: "Email delivery exhausted its durable provider-attempt budget",
						completedAt: claimAt,
					})
					.where(
						and(
							eq(emailDeliveries.id, ledger.id),
							eq(emailDeliveries.status, ledger.status),
							eq(emailDeliveries.leaseToken, ledger.leaseToken),
						),
					);
				return { state: "exhausted" as const };
			}
			const claimed = await tx
				.update(emailDeliveries)
				.set({
					status: "processing",
					providerAttempts: sql`${emailDeliveries.providerAttempts} + 1`,
					leaseToken: sql`${emailDeliveries.leaseToken} + 1`,
					leaseExpiresAt: new Date(claimAt.getTime() + EMAIL_CLAIM_MS),
					// Queue delivery can race the producer's post-send update.
					// Once this provider-attempt claim wins, the dispatch lease
					// is obsolete and must not contradict the processing state.
					dispatchLeaseExpiresAt: null,
					requestMayHaveBeenSentAt: null,
					error: null,
				})
				.where(
					and(
						eq(emailDeliveries.id, body.id),
						sql`${emailDeliveries.providerAttempts} < ${EMAIL_PROVIDER_MAX_ATTEMPTS}`,
						sql`${emailDeliveries.deadlineAt} > ${claimAt}`,
						lte(emailDeliveries.nextAttemptAt, claimAt),
						or(
							eq(emailDeliveries.status, "pending"),
							eq(emailDeliveries.status, "unknown"),
							and(
								eq(emailDeliveries.status, "processing"),
								lte(emailDeliveries.leaseExpiresAt, claimAt),
							),
						),
					),
				)
				.returning({
					id: emailDeliveries.id,
					leaseToken: emailDeliveries.leaseToken,
					providerAttempts: emailDeliveries.providerAttempts,
					deadlineAt: emailDeliveries.deadlineAt,
					envelopeCiphertext: emailDeliveries.envelopeCiphertext,
				});
			const claimedRow = claimed.find((row) => row.id === body.id);
			return {
				state: claimedRow ? ("claimed" as const) : ("not_claimed" as const),
				leaseToken: claimedRow?.leaseToken ?? null,
				providerAttempts: claimedRow?.providerAttempts ?? null,
				deadlineAt: claimedRow?.deadlineAt ?? null,
				envelopeCiphertext: claimedRow?.envelopeCiphertext ?? null,
			};
		});

		if (
			claim.state === "inactive" ||
			claim.state === "terminal" ||
			claim.state === "not_claimed"
		) {
			message.ack();
			continue;
		}
		if (claim.state === "missing") {
			// Owner deletion cascades the ledger. A delayed Queue duplicate is
			// therefore an already-erased occurrence, not a replayable failure.
			message.ack();
			continue;
		}
		if (claim.state === "exhausted") {
			await recordQueueFailure(
				env,
				batch.queue,
				message,
				"unknown_external_outcome",
				"Email provider-attempt budget or deadline exhausted; manual reconciliation required",
			);
			message.ack();
			continue;
		}
		if (claim.state === "busy") {
			// Another fenced provider attempt owns this occurrence. The durable
			// ledger (and its scheduled recovery sweep) owns the retry clock, so
			// retrying this duplicate Queue delivery would stack two clocks.
			message.ack();
			continue;
		}
		if (
			!claim.leaseToken ||
			!claim.providerAttempts ||
			!claim.deadlineAt ||
			!claim.envelopeCiphertext
		) {
			await db
				.update(emailDeliveries)
				.set({
					status: "failed",
					leaseExpiresAt: null,
					error: "Encrypted email envelope is missing",
					completedAt: new Date(),
				})
				.where(
					and(
						eq(emailDeliveries.id, body.id),
						eq(emailDeliveries.status, "processing"),
						eq(emailDeliveries.leaseToken, claim.leaseToken ?? -1),
					),
				);
			await recordQueueFailure(
				env,
				batch.queue,
				message,
				"permanent_input",
				"Encrypted email envelope is missing",
			);
			message.ack();
			continue;
		}

		let envelope: EmailDeliveryEnvelope;
		try {
			envelope = parseEmailEnvelope(
				await decryptToken(claim.envelopeCiphertext, env.ENCRYPTION_KEY, {
					recordId: body.id,
					field: "email_delivery_envelope",
				}),
			);
		} catch {
			await db
				.update(emailDeliveries)
				.set({
					status: "failed",
					leaseExpiresAt: null,
					error: "Encrypted email envelope could not be opened",
					completedAt: new Date(),
				})
				.where(
					and(
						eq(emailDeliveries.id, body.id),
						eq(emailDeliveries.status, "processing"),
						eq(emailDeliveries.leaseToken, claim.leaseToken),
					),
				);
			await recordQueueFailure(
				env,
				batch.queue,
				message,
				"permanent_input",
				"Encrypted email envelope could not be opened",
			);
			message.ack();
			continue;
		}

		const requestBoundary = new Date();
		const [armed] = await db
			.update(emailDeliveries)
			.set({ requestMayHaveBeenSentAt: requestBoundary })
			.where(
				and(
					eq(emailDeliveries.id, body.id),
					eq(emailDeliveries.status, "processing"),
					eq(emailDeliveries.leaseToken, claim.leaseToken),
				),
			)
			.returning({ id: emailDeliveries.id });
		if (!armed) {
			// A competing transition won the fence. Its durable row is now the
			// authority; this stale Queue hint has no independent work to retry.
			message.ack();
			continue;
		}
		if (!requestBoundary)
			throw new Error(`Email ${body.id} claim fence is missing`);
		const claimFence = and(
			eq(emailDeliveries.id, body.id),
			eq(emailDeliveries.status, "processing"),
			eq(emailDeliveries.leaseToken, claim.leaseToken),
			eq(emailDeliveries.requestMayHaveBeenSentAt, requestBoundary),
		);

		const result = await processEmailMessage(
			{ id: body.id, ...envelope },
			env.RESEND_API_KEY,
		);

		if (result.success) {
			await db
				.update(emailDeliveries)
				.set({
					status: "sent",
					providerMessageId: result.providerMessageId ?? null,
					leaseExpiresAt: null,
					completedAt: new Date(),
				})
				.where(claimFence);
			message.ack();
		} else if (result.shouldRetry) {
			const retryDecisionAt = new Date();
			const retryAt = nextEmailProviderAttemptAt(
				claim.providerAttempts,
				retryDecisionAt,
				claim.deadlineAt,
			);
			await db
				.update(emailDeliveries)
				.set(
					retryAt
						? {
								status: "unknown",
								leaseExpiresAt: null,
								error: result.error ?? "Ambiguous email send failure",
								nextAttemptAt: retryAt,
								nextDispatchAt: retryAt,
							}
						: {
								status: "manual_review",
								leaseExpiresAt: null,
								error:
									result.error ??
									"Email provider-attempt budget or deadline exhausted",
								completedAt: retryDecisionAt,
							},
				)
				.where(claimFence);
			if (retryAt) {
				console.log(
					`[Queue] Scheduled durable email recovery after provider attempt ${claim.providerAttempts}`,
				);
			}
			message.ack();
		} else {
			console.error(`[Queue] Non-retryable email error: ${result.error}`);
			await recordQueueFailure(
				env,
				batch.queue,
				message,
				"permanent_input",
				result.error ?? "Non-retryable email failure",
			);
			await db
				.update(emailDeliveries)
				.set({
					status: "failed",
					leaseExpiresAt: null,
					error: result.error ?? "Non-retryable email failure",
					completedAt: new Date(),
				})
				.where(claimFence);
			message.ack();
		}
	}
}
