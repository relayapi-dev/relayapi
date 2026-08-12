import {
	createDb,
	posts,
	postTargets,
	publishAttempts,
	publishOutbox,
} from "@relayapi/db";
import {
	and,
	asc,
	eq,
	gt,
	isNotNull,
	isNull,
	lte,
	notExists,
	sql,
} from "drizzle-orm";
import type { ProviderEffect } from "../publishers/types";
import type { Env } from "../types";
import { dispatchPublishOutbox, publishOutboxRow } from "./publish-outbox";

const BATCH_SIZE = 25;
const RECOVERY_RECONCILE_DELAY_MS = 60_000;

function succeededEffectId(
	effects: readonly ProviderEffect[],
	name: string,
): string | null {
	return (
		effects
			.find(
				(effect) =>
					effect.name === name &&
					effect.status === "succeeded" &&
					!!effect.provider_id?.trim(),
			)
			?.provider_id?.trim() ?? null
	);
}

function recoveredProviderIdentity(
	platform: string,
	effects: readonly ProviderEffect[],
): { platformPostId: string | null; providerOperationId: string | null } {
	const postPublished = succeededEffectId(effects, "post_published");
	const defaultIdentity = {
		platformPostId: postPublished,
		providerOperationId: postPublished,
	};
	switch (platform) {
		case "linkedin":
			return defaultIdentity;
		case "youtube": {
			const videoId = succeededEffectId(effects, "video_upload");
			return { platformPostId: videoId, providerOperationId: videoId };
		}
		case "mailchimp":
		case "listmonk": {
			const campaignId = succeededEffectId(effects, "campaign_created");
			return {
				platformPostId: campaignId,
				providerOperationId: campaignId,
			};
		}
		case "tiktok":
			return {
				platformPostId: defaultIdentity.platformPostId,
				providerOperationId: succeededEffectId(effects, "tiktok_publish_init"),
			};
		case "facebook":
			return {
				platformPostId: defaultIdentity.platformPostId,
				providerOperationId:
					succeededEffectId(effects, "video_finish_accepted") ??
					succeededEffectId(effects, "video_binary_uploaded") ??
					succeededEffectId(effects, "video_upload_started") ??
					defaultIdentity.providerOperationId,
			};
		case "twitter":
		case "threads":
		case "bluesky": {
			const rootId = succeededEffectId(effects, "thread_item_1");
			return {
				platformPostId: rootId ?? defaultIdentity.platformPostId,
				providerOperationId: rootId ?? defaultIdentity.providerOperationId,
			};
		}
		case "telegram": {
			const messageId = succeededEffectId(effects, "telegram_message_0");
			return {
				platformPostId: messageId ?? defaultIdentity.platformPostId,
				providerOperationId: messageId ?? defaultIdentity.providerOperationId,
			};
		}
		case "sms": {
			const recipientIds = effects.filter(
				(effect) =>
					effect.name.startsWith("recipient_") &&
					effect.status === "succeeded" &&
					!!effect.provider_id?.trim(),
			);
			const onlyMessageId =
				recipientIds.length === 1
					? (recipientIds[0]?.provider_id?.trim() ?? null)
					: null;
			return {
				platformPostId: onlyMessageId ?? defaultIdentity.platformPostId,
				providerOperationId:
					onlyMessageId ?? defaultIdentity.providerOperationId,
			};
		}
		default:
			return defaultIdentity;
	}
}

function confirmedEffects(
	effects: readonly ProviderEffect[] | null,
): ProviderEffect[] {
	return (effects ?? []).filter(
		(effect) => effect.status === "succeeded" && !!effect.provider_id?.trim(),
	);
}

function hasMatchingConfirmedEffects(
	targetEffects: readonly ProviderEffect[],
	attemptEffects: readonly ProviderEffect[] | null,
): boolean {
	const attemptByName = new Map(
		confirmedEffects(attemptEffects).map((effect) => [
			effect.name,
			effect.provider_id?.trim(),
		]),
	);
	return (
		attemptByName.size === targetEffects.length &&
		targetEffects.every(
			(effect) => attemptByName.get(effect.name) === effect.provider_id?.trim(),
		)
	);
}

/** Recover standalone post executions without replaying ambiguous provider I/O. */
export async function reconcilePostPublishExecutions(
	env: Env,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const activePreBoundaryTarget = db
		.select({ id: postTargets.id })
		.from(postTargets)
		.where(
			and(
				eq(postTargets.postId, posts.id),
				eq(postTargets.deliveryState, "in_flight"),
				isNull(postTargets.requestMayHaveBeenSentAt),
				gt(postTargets.leaseExpiresAt, now),
			),
		);
	const candidates = await db
		.select({
			id: posts.id,
			organizationId: posts.organizationId,
			leaseId: posts.publishLeaseId,
			leaseExpiresAt: posts.publishLeaseExpiresAt,
			publishAttempts: posts.publishAttempts,
		})
		.from(posts)
		.where(
			and(
				eq(posts.status, "publishing"),
				isNotNull(posts.publishLeaseId),
				isNotNull(posts.publishLeaseExpiresAt),
				lte(posts.publishLeaseExpiresAt, now),
				notExists(activePreBoundaryTarget),
			),
		)
		.orderBy(
			asc(posts.publishLeaseExpiresAt),
			asc(posts.updatedAt),
			asc(posts.id),
		)
		.limit(BATCH_SIZE);

	let recovered = 0;
	let requeued = 0;
	for (const candidate of candidates) {
		if (!candidate.leaseId) continue;
		const leaseId = candidate.leaseId;
		const recovery = await db.transaction(async (tx) => {
			const [lockedParent] = await tx
				.select({ id: posts.id })
				.from(posts)
				.where(
					and(
						eq(posts.id, candidate.id),
						eq(posts.organizationId, candidate.organizationId),
						eq(posts.status, "publishing"),
						eq(posts.publishLeaseId, leaseId),
						isNotNull(posts.publishLeaseExpiresAt),
						lte(posts.publishLeaseExpiresAt, now),
					),
				)
				.for("update")
				.limit(1);
			if (!lockedParent) return "none" as const;

			const targets = await tx
				.select({
					id: postTargets.id,
					organizationId: postTargets.organizationId,
					status: postTargets.status,
					deliveryState: postTargets.deliveryState,
					platform: postTargets.platform,
					attemptId: postTargets.attemptId,
					publishOperationId: postTargets.publishOperationId,
					leaseExpiresAt: postTargets.leaseExpiresAt,
					requestMayHaveBeenSentAt: postTargets.requestMayHaveBeenSentAt,
					platformPostId: postTargets.platformPostId,
					providerOperationId: postTargets.providerOperationId,
					providerState: postTargets.providerState,
					providerEffects: postTargets.providerEffects,
					providerDisposition: postTargets.providerDisposition,
				})
				.from(postTargets)
				.where(
					and(
						eq(postTargets.postId, candidate.id),
						eq(postTargets.organizationId, candidate.organizationId),
					),
				)
				.orderBy(asc(postTargets.id))
				.for("update");
			const hasUnknown = targets.some(
				(target) => target.deliveryState === "unknown",
			);
			const hasActivePreBoundary = targets.some(
				(target) =>
					target.deliveryState === "in_flight" &&
					target.requestMayHaveBeenSentAt == null &&
					(target.leaseExpiresAt?.getTime() ?? 0) > now.getTime(),
			);
			if (hasActivePreBoundary) return "none" as const;

			const unknownTargets = targets.filter(
				(target) => target.deliveryState === "unknown",
			);
			const attemptRows = new Map<
				string,
				{
					id: string;
					postTargetId: string;
					publishOperationId: string;
					state: "in_flight" | "unknown";
					requestMayHaveBeenSentAt: Date | null;
					providerEffects: ProviderEffect[] | null;
				}
			>();
			for (const target of unknownTargets) {
				if (!target.attemptId || !target.publishOperationId) {
					return "none" as const;
				}
				const [attempt] = await tx
					.select({
						id: publishAttempts.id,
						postTargetId: publishAttempts.postTargetId,
						publishOperationId: publishAttempts.publishOperationId,
						state: publishAttempts.state,
						requestMayHaveBeenSentAt: publishAttempts.requestMayHaveBeenSentAt,
						providerEffects: publishAttempts.providerEffects,
					})
					.from(publishAttempts)
					.where(
						and(
							eq(publishAttempts.id, target.attemptId),
							eq(publishAttempts.postTargetId, target.id),
							eq(publishAttempts.publishOperationId, target.publishOperationId),
						),
					)
					.for("update")
					.limit(1);
				if (
					(attempt?.state !== "in_flight" && attempt?.state !== "unknown") ||
					attempt.requestMayHaveBeenSentAt == null ||
					!hasMatchingConfirmedEffects(
						confirmedEffects(target.providerEffects),
						attempt.providerEffects,
					)
				) {
					return "none" as const;
				}
				attemptRows.set(target.id, {
					...attempt,
					state: attempt.state as "in_flight" | "unknown",
				});
			}

			for (const target of unknownTargets) {
				const attempt = attemptRows.get(target.id);
				if (!attempt) throw new Error("Publish recovery attempt lock was lost");
				const effects = confirmedEffects(target.providerEffects);
				const hasDurableEvidence =
					effects.length > 0 && target.providerDisposition == null;
				if (!hasDurableEvidence) {
					if (attempt.state === "unknown") continue;
					const manualMessage =
						"Publish lease expired after a provider request may have been sent; manual reconciliation is required.";
					const [savedTarget] = await tx
						.update(postTargets)
						.set({
							leaseExpiresAt: null,
							error: manualMessage,
							errorCode: "PUBLISH_OUTCOME_UNKNOWN",
							updatedAt: now,
						})
						.where(
							and(
								eq(postTargets.id, target.id),
								eq(postTargets.postId, candidate.id),
								eq(postTargets.organizationId, candidate.organizationId),
								eq(postTargets.status, "publishing"),
								eq(postTargets.deliveryState, "unknown"),
								eq(postTargets.attemptId, attempt.id),
								eq(postTargets.publishOperationId, attempt.publishOperationId),
								isNotNull(postTargets.requestMayHaveBeenSentAt),
							),
						)
						.returning({ id: postTargets.id });
					if (!savedTarget) {
						throw new Error("Manual publish recovery target fence was lost");
					}
					const [savedAttempt] = await tx
						.update(publishAttempts)
						.set({
							state: "unknown",
							completedAt: now,
							leaseExpiresAt: now,
							error: manualMessage,
						})
						.where(
							and(
								eq(publishAttempts.id, attempt.id),
								eq(publishAttempts.postTargetId, target.id),
								eq(
									publishAttempts.publishOperationId,
									attempt.publishOperationId,
								),
								eq(publishAttempts.state, "in_flight"),
								isNotNull(publishAttempts.requestMayHaveBeenSentAt),
							),
						)
						.returning({ id: publishAttempts.id });
					if (!savedAttempt) {
						throw new Error("Manual publish recovery attempt fence was lost");
					}
					continue;
				}
				const identity = recoveredProviderIdentity(target.platform, effects);
				const platformPostId = target.platformPostId ?? identity.platformPostId;
				const providerOperationId =
					target.providerOperationId ?? identity.providerOperationId;
				const providerState =
					target.providerState ?? "RECOVERED_FROM_DURABLE_EFFECTS";
				const nextReconcileAt = new Date(
					now.getTime() + RECOVERY_RECONCILE_DELAY_MS,
				);
				const [savedTarget] = await tx
					.update(postTargets)
					.set({
						providerDisposition: "partial",
						platformPostId,
						providerOperationId,
						providerState,
						nextReconcileAt,
						leaseExpiresAt: null,
						error:
							"Provider effect was confirmed before the publish lease expired; awaiting read-only reconciliation.",
						errorCode: "PUBLISH_OUTCOME_UNKNOWN",
						updatedAt: now,
					})
					.where(
						and(
							eq(postTargets.id, target.id),
							eq(postTargets.postId, candidate.id),
							eq(postTargets.organizationId, candidate.organizationId),
							eq(postTargets.status, "publishing"),
							eq(postTargets.deliveryState, "unknown"),
							eq(postTargets.attemptId, attempt.id),
							eq(postTargets.publishOperationId, attempt.publishOperationId),
							isNotNull(postTargets.requestMayHaveBeenSentAt),
						),
					)
					.returning({ id: postTargets.id });
				if (!savedTarget)
					throw new Error("Publish recovery target fence was lost");

				const [savedAttempt] = await tx
					.update(publishAttempts)
					.set({
						state: "unknown",
						providerPostId: platformPostId,
						providerOperationId,
						providerDisposition: "partial",
						providerState,
						completedAt: now,
						leaseExpiresAt: now,
						error:
							"Provider effect was confirmed before the publish lease expired; awaiting read-only reconciliation.",
					})
					.where(
						and(
							eq(publishAttempts.id, attempt.id),
							eq(publishAttempts.postTargetId, target.id),
							eq(
								publishAttempts.publishOperationId,
								attempt.publishOperationId,
							),
							eq(publishAttempts.state, attempt.state),
							isNotNull(publishAttempts.requestMayHaveBeenSentAt),
						),
					)
					.returning({ id: publishAttempts.id });
				if (!savedAttempt) {
					throw new Error("Publish recovery attempt fence was lost");
				}
			}

			if (hasUnknown) {
				const [updated] = await tx
					.update(posts)
					.set({
						terminalReason: {
							code: "PUBLISH_OUTCOME_UNKNOWN",
							message:
								"At least one provider request has an unknown outcome and requires reconciliation.",
						},
						publishLeaseId: null,
						publishLeaseExpiresAt: null,
						revision: sql`${posts.revision} + 1`,
						updatedAt: now,
					})
					.where(
						and(
							eq(posts.id, candidate.id),
							eq(posts.organizationId, candidate.organizationId),
							eq(posts.status, "publishing"),
							eq(posts.publishLeaseId, leaseId),
						),
					)
					.returning({ id: posts.id });
				if (!updated) throw new Error("Publish recovery parent fence was lost");
				return "unknown" as const;
			}

			const [updated] = await tx
				.update(posts)
				.set({
					publishLeaseId: null,
					publishLeaseExpiresAt: null,
					revision: sql`${posts.revision} + 1`,
					updatedAt: now,
				})
				.where(
					and(
						eq(posts.id, candidate.id),
						eq(posts.organizationId, candidate.organizationId),
						eq(posts.status, "publishing"),
						eq(posts.publishLeaseId, leaseId),
					),
				)
				.returning({ id: posts.id });
			if (!updated) throw new Error("Publish recovery parent fence was lost");
			await tx
				.insert(publishOutbox)
				.values(
					publishOutboxRow({
						organizationId: candidate.organizationId,
						postId: candidate.id,
						operationId: `publish:${candidate.id}:lease-recovery:${candidate.publishAttempts}`,
					}),
				)
				.onConflictDoNothing();
			return "requeued" as const;
		});
		if (recovery === "none") continue;
		recovered++;
		if (recovery === "requeued") requeued++;
	}

	if (requeued > 0) {
		try {
			await dispatchPublishOutbox(env);
		} catch (error) {
			console.error(
				"[Publish] Durable lease recovery dispatch deferred",
				error,
			);
		}
	}
	return recovered;
}
