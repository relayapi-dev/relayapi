/**
 * Sequence step processor — runs on the every-minute cron trigger.
 * Finds enrollments where nextStepAt <= now() and sends the next message.
 */

import {
	createDb,
	sequences,
	sequenceSteps,
	sequenceEnrollments,
	socialAccounts,
} from "@relayapi/db";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Env } from "../types";
import { sendMessage } from "./message-sender";
import { refreshTokenIfNeeded } from "./token-refresh";
import { mapConcurrently } from "../lib/concurrency";

export async function processSequenceSteps(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	// Find enrollments that are due
	const dueEnrollments = await db
		.select()
		.from(sequenceEnrollments)
		.where(
			and(
				eq(sequenceEnrollments.status, "active"),
				lte(sequenceEnrollments.nextStepAt, new Date()),
			),
		)
		.limit(50);

	if (dueEnrollments.length === 0) return;

	const sequenceIds = [...new Set(dueEnrollments.map((enrollment) => enrollment.sequenceId))];
	const activeSequences = sequenceIds.length > 0
		? await db
				.select()
				.from(sequences)
				.where(
					and(
						inArray(sequences.id, sequenceIds),
						eq(sequences.status, "active"),
					),
				)
		: [];
	const sequenceById = new Map(activeSequences.map((sequence) => [sequence.id, sequence]));

	const stepRows = activeSequences.length > 0
		? await db
				.select()
				.from(sequenceSteps)
				.where(inArray(sequenceSteps.sequenceId, activeSequences.map((sequence) => sequence.id)))
				.orderBy(asc(sequenceSteps.sequenceId), asc(sequenceSteps.order))
		: [];
	const stepsBySequence = new Map<string, (typeof sequenceSteps.$inferSelect)[]>();
	for (const step of stepRows) {
		const steps = stepsBySequence.get(step.sequenceId) ?? [];
		steps.push(step);
		stepsBySequence.set(step.sequenceId, steps);
	}

	const accounts = activeSequences.length > 0
		? await db
				.select({
					id: socialAccounts.id,
					platform: socialAccounts.platform,
					accessToken: socialAccounts.accessToken,
					refreshToken: socialAccounts.refreshToken,
					tokenExpiresAt: socialAccounts.tokenExpiresAt,
					platformAccountId: socialAccounts.platformAccountId,
				})
				.from(socialAccounts)
				.where(inArray(socialAccounts.id, [...new Set(activeSequences.map((sequence) => sequence.socialAccountId))]))
		: [];
	const accountById = new Map(accounts.map((account) => [account.id, account]));
	const tokenByAccountId = new Map<string, Promise<string | null>>();

	const getTokenForAccount = (account: (typeof accounts)[number]) => {
		const cached = tokenByAccountId.get(account.id);
		if (cached) return cached;

		const tokenPromise = refreshTokenIfNeeded(env, account)
			.catch((err) => {
				console.error(
					`[sequence-processor] Failed to refresh token for account ${account.id}:`,
					err,
				);
				return null;
			});
		tokenByAccountId.set(account.id, tokenPromise);
		return tokenPromise;
	};

	await mapConcurrently(dueEnrollments, 5, async (enrollment) => {
		try {
			await processEnrollment(
				db,
				enrollment,
				sequenceById,
				stepsBySequence,
				accountById,
				getTokenForAccount,
			);
		} catch (err) {
			console.error(
				`[sequence-processor] Failed to process enrollment ${enrollment.id}:`,
				err,
			);
		}
	});
}

async function processEnrollment(
	db: ReturnType<typeof createDb>,
	enrollment: typeof sequenceEnrollments.$inferSelect,
	sequenceById: Map<string, typeof sequences.$inferSelect>,
	stepsBySequence: Map<string, (typeof sequenceSteps.$inferSelect)[]>,
	accountById: Map<
		string,
		{
			id: string;
			platform: typeof socialAccounts.$inferSelect.platform;
			accessToken: string | null;
			refreshToken: string | null;
			tokenExpiresAt: Date | null;
			platformAccountId: string;
		}
	>,
	getTokenForAccount: (
		account: {
			id: string;
			platform: typeof socialAccounts.$inferSelect.platform;
			accessToken: string | null;
			refreshToken: string | null;
			tokenExpiresAt: Date | null;
			platformAccountId: string;
		},
	) => Promise<string | null>,
): Promise<void> {
	const seq = sequenceById.get(enrollment.sequenceId);
	if (!seq) {
		// Sequence was paused/deleted — pause enrollment
		await db
			.update(sequenceEnrollments)
			.set({ status: "paused", updatedAt: new Date() })
			.where(eq(sequenceEnrollments.id, enrollment.id));
		return;
	}

	const steps = stepsBySequence.get(seq.id) ?? [];
	const currentStep = steps[enrollment.currentStepIndex];
	if (!currentStep) {
		// No more steps — mark as completed
		await db
			.update(sequenceEnrollments)
			.set({
				status: "completed",
				completedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(sequenceEnrollments.id, enrollment.id));

		await db
			.update(sequences)
			.set({ totalCompleted: sql`${sequences.totalCompleted} + 1` })
			.where(eq(sequences.id, seq.id));
		return;
	}

	const account = accountById.get(seq.socialAccountId);
	if (!account) {
		console.error(
			`[sequence-processor] Account ${seq.socialAccountId} not found`,
		);
		return;
	}

	const token = await getTokenForAccount(account);
	if (!token) {
		console.error(
			`[sequence-processor] No access token for account ${seq.socialAccountId}`,
		);
		return;
	}

	// Send the message
	const result = await sendMessage({
		platform: seq.platform,
		accessToken: token,
		platformAccountId: account.platformAccountId,
		recipientId: enrollment.contactIdentifier,
		text: currentStep.messageText ?? "",
		templateName: currentStep.templateName ?? undefined,
		templateLanguage: currentStep.templateLanguage ?? undefined,
		templateComponents: (currentStep.templateComponents as unknown[]) ?? undefined,
	});

	if (!result.success) {
		console.error(
			`[sequence-processor] Message send failed for enrollment ${enrollment.id}: ${result.error}`,
		);
		// Don't exit on send failure — will retry next cron cycle
		return;
	}

	// Advance enrollment
	const nextStepIndex = enrollment.currentStepIndex + 1;
	const nextStep = steps[nextStepIndex];

	const updateData: Record<string, unknown> = {
		currentStepIndex: nextStepIndex,
		stepsSent: enrollment.stepsSent + 1,
		lastStepSentAt: new Date(),
		updatedAt: new Date(),
	};

	if (nextStep) {
		// Calculate next step time
		updateData.nextStepAt = new Date(
			Date.now() + nextStep.delayMinutes * 60 * 1000,
		);
	} else {
		// Last step completed
		updateData.status = "completed";
		updateData.completedAt = new Date();
		updateData.nextStepAt = null;
	}

	await db
		.update(sequenceEnrollments)
		.set(updateData)
		.where(eq(sequenceEnrollments.id, enrollment.id));

	// Update sequence stats if completed
	if (!nextStep) {
		await db
			.update(sequences)
			.set({ totalCompleted: sql`${sequences.totalCompleted} + 1` })
			.where(eq(sequences.id, seq.id));
	}
}

/**
 * Check if a reply should exit any sequence enrollments.
 * Called from the inbox event processor when a message/reply is received.
 */
export async function checkSequenceExitOnReply(
	orgId: string,
	platform: string,
	senderIdentifier: string,
	db: ReturnType<typeof createDb>,
): Promise<void> {
	// Find active enrollments for this sender
	const activeEnrollments = await db
		.select({
			id: sequenceEnrollments.id,
			sequenceId: sequenceEnrollments.sequenceId,
		})
		.from(sequenceEnrollments)
		.innerJoin(sequences, eq(sequences.id, sequenceEnrollments.sequenceId))
		.where(
			and(
				eq(sequenceEnrollments.organizationId, orgId),
				eq(sequenceEnrollments.contactIdentifier, senderIdentifier),
				eq(sequenceEnrollments.status, "active"),
				eq(sequences.platform, platform),
				eq(sequences.exitOnReply, true),
			),
		);

	for (const enrollment of activeEnrollments) {
		await db
			.update(sequenceEnrollments)
			.set({
				status: "exited",
				exitReason: "reply",
				exitedAt: new Date(),
				nextStepAt: null,
				updatedAt: new Date(),
			})
			.where(eq(sequenceEnrollments.id, enrollment.id));

		await db
			.update(sequences)
			.set({ totalExited: sql`${sequences.totalExited} + 1` })
			.where(eq(sequences.id, enrollment.sequenceId));
	}
}
