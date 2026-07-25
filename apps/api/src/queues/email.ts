import { createDb, emailDeliveries, organization } from "@relayapi/db";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { isSelfHosted, selfHostedFeatureEnabled } from "../lib/deployment-mode";
import { processEmailMessage } from "../lib/email-queue/consumer";
import type { EmailQueueMessage } from "../lib/email-queue/types";
import type { Env } from "../types";
import { recordQueueFailure } from "./failures";

const EMAIL_CLAIM_MS = 60_000;

function isEmailQueueMessage(value: unknown): value is EmailQueueMessage {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const body = value as Record<string, unknown>;
	return (
		typeof body.id === "string" &&
		body.id.length > 0 &&
		typeof body.organization_id === "string" &&
		body.organization_id.length > 0 &&
		typeof body.to === "string" &&
		typeof body.subject === "string" &&
		typeof body.html === "string" &&
		(body.from === undefined || typeof body.from === "string")
	);
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
			const [activeOrganization] = await tx
				.select({ id: organization.id })
				.from(organization)
				.where(
					and(
						eq(organization.id, body.organization_id),
						eq(organization.lifecycleStatus, "active"),
					),
				)
				.for("key share")
				.limit(1);
			if (!activeOrganization) return { state: "inactive" as const };

			await tx
				.insert(emailDeliveries)
				.values({ id: body.id })
				.onConflictDoNothing();
			const [ledger] = await tx
				.select()
				.from(emailDeliveries)
				.where(eq(emailDeliveries.id, body.id))
				.limit(1);
			if (!ledger) throw new Error(`Email ledger ${body.id} was not persisted`);
			if (ledger.status === "sent" || ledger.status === "failed") {
				return { state: "terminal" as const };
			}
			const idempotencyWindowOpen =
				Date.now() - ledger.createdAt.getTime() < 23 * 60 * 60 * 1000;
			if (ledger.status === "unknown" && !idempotencyWindowOpen) {
				return { state: "expired_unknown" as const };
			}
			if (
				ledger.status === "unknown" &&
				ledger.requestMayHaveBeenSentAt &&
				ledger.requestMayHaveBeenSentAt.getTime() >
					claimAt.getTime() - EMAIL_CLAIM_MS
			) {
				return {
					state: "busy" as const,
					retryAfterSeconds: Math.max(
						1,
						Math.ceil(
							(ledger.requestMayHaveBeenSentAt.getTime() +
								EMAIL_CLAIM_MS -
								claimAt.getTime()) /
								1_000,
						),
					),
				};
			}
			const claimed = await tx
				.update(emailDeliveries)
				.set({
					status: "unknown",
					attempts: sql`${emailDeliveries.attempts} + 1`,
					requestMayHaveBeenSentAt: claimAt,
					error: null,
				})
				.where(
					and(
						eq(emailDeliveries.id, body.id),
						or(
							eq(emailDeliveries.status, "pending"),
							and(
								eq(emailDeliveries.status, "unknown"),
								or(
									isNull(emailDeliveries.requestMayHaveBeenSentAt),
									lte(
										emailDeliveries.requestMayHaveBeenSentAt,
										new Date(claimAt.getTime() - EMAIL_CLAIM_MS),
									),
								),
							),
						),
					),
				)
				.returning({
					id: emailDeliveries.id,
					claimAt: emailDeliveries.requestMayHaveBeenSentAt,
				});
			const claimedRow = claimed.find((row) => row.id === body.id);
			return {
				state: claimedRow ? ("claimed" as const) : ("not_claimed" as const),
				claimAt: claimedRow?.claimAt ?? null,
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
		if (claim.state === "expired_unknown") {
			await recordQueueFailure(
				env,
				batch.queue,
				message,
				"unknown_external_outcome",
				"Resend idempotency window elapsed; manual reconciliation required",
			);
			message.ack();
			continue;
		}
		if (claim.state === "busy") {
			message.retry({ delaySeconds: claim.retryAfterSeconds });
			continue;
		}
		if (!claim.claimAt)
			throw new Error(`Email ${body.id} claim fence is missing`);
		const claimFence = and(
			eq(emailDeliveries.id, body.id),
			eq(emailDeliveries.status, "unknown"),
			eq(emailDeliveries.requestMayHaveBeenSentAt, claim.claimAt),
		);

		const result = await processEmailMessage(body, env.RESEND_API_KEY);

		if (result.success) {
			await db
				.update(emailDeliveries)
				.set({
					status: "sent",
					providerMessageId: result.providerMessageId ?? null,
					completedAt: new Date(),
				})
				.where(claimFence);
			message.ack();
		} else if (result.shouldRetry) {
			await db
				.update(emailDeliveries)
				.set({
					error: result.error ?? "Ambiguous email send failure",
					requestMayHaveBeenSentAt: null,
				})
				.where(claimFence);
			const delaySeconds = 2 ** message.attempts;
			console.log(
				`[Queue] Retrying email in ${delaySeconds}s (attempt ${message.attempts})`,
			);
			message.retry({ delaySeconds });
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
					error: result.error ?? "Non-retryable email failure",
					completedAt: new Date(),
				})
				.where(claimFence);
			message.ack();
		}
	}
}
