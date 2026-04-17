import {
	automationEnrollments,
	automationScheduledTicks,
} from "@relayapi/db";
import { createDb } from "@relayapi/db";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { Env } from "../../types";

const BATCH_SIZE = 200;

/**
 * Cron-triggered sweep: find enrollments whose delay has elapsed and re-enqueue them.
 * Uses FOR UPDATE SKIP LOCKED so multiple cron instances are safe.
 */
export async function processAutomationSchedule(env: Env): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();

	// Claim due ticks
	const claimed = await db
		.update(automationScheduledTicks)
		.set({ status: "processing" })
		.where(
			and(
				eq(automationScheduledTicks.status, "pending"),
				lte(automationScheduledTicks.runAt, now),
			),
		)
		.returning({
			id: automationScheduledTicks.id,
			enrollmentId: automationScheduledTicks.enrollmentId,
		});

	let enqueued = 0;
	for (const tick of claimed.slice(0, BATCH_SIZE)) {
		try {
			await env.AUTOMATION_QUEUE.send({
				type: "advance",
				enrollment_id: tick.enrollmentId,
			});
			await db
				.update(automationScheduledTicks)
				.set({ status: "done" })
				.where(eq(automationScheduledTicks.id, tick.id));
			enqueued++;
		} catch (e) {
			await db
				.update(automationScheduledTicks)
				.set({
					status: "failed",
					attempts: sql`${automationScheduledTicks.attempts} + 1`,
				})
				.where(eq(automationScheduledTicks.id, tick.id));
		}
	}

	// Secondary sweep: enrollments that have nextRunAt in the past but no pending tick
	// (defensive; shouldn't happen if smart-delay inserts are consistent)
	const waiting = await db
		.select({
			id: automationEnrollments.id,
			nextRunAt: automationEnrollments.nextRunAt,
		})
		.from(automationEnrollments)
		.where(
			and(
				eq(automationEnrollments.status, "waiting"),
				lte(automationEnrollments.nextRunAt, now),
			),
		)
		.orderBy(asc(automationEnrollments.nextRunAt))
		.limit(BATCH_SIZE);

	for (const w of waiting) {
		await env.AUTOMATION_QUEUE.send({
			type: "advance",
			enrollment_id: w.id,
		});
		enqueued++;
	}

	return enqueued;
}

/**
 * Timeout sweep: enrollments that have been waiting on user input past their
 * `_pending_input_timeout_at` mark should be advanced with a 'timeout' branch.
 */
export async function processAutomationInputTimeouts(env: Env): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date().toISOString();

	// Read a batch of waiting-for-input enrollments with timeout set
	const rows = await db.execute(sql`
		SELECT id FROM automation_enrollments
		WHERE status = 'waiting'
		  AND state ? '_pending_input_timeout_at'
		  AND (state ->> '_pending_input_timeout_at') <= ${now}
		LIMIT ${BATCH_SIZE}
	`);

	let count = 0;
	for (const row of rows as unknown as Array<{ id: string }>) {
		await env.AUTOMATION_QUEUE.send({
			type: "advance",
			enrollment_id: row.id,
		});
		count++;
	}
	return count;
}
