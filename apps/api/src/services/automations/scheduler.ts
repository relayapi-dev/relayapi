import {
	automationEnrollments,
	automationScheduledTicks,
} from "@relayapi/db";
import { createDb } from "@relayapi/db";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Env } from "../../types";

const BATCH_SIZE = 200;
// A tick that's been claimed (`processing`) but never confirmed `done` or
// flipped back to `pending` for this long is almost certainly the victim of a
// worker dying mid-send. Reclaim on the next sweep.
const STALE_PROCESSING_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Cron-triggered sweep: find enrollments whose delay has elapsed and re-enqueue them.
 * Claims only BATCH_SIZE rows per run so rows in excess of the batch stay `pending`
 * and are picked up by the next tick rather than stranded in `processing`.
 */
export async function processAutomationSchedule(env: Env): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();

	// Reclaim ticks stuck in `processing` past the stale threshold. A tick
	// can end up here if the worker died after claiming but before marking
	// the tick `done` or rolling it back to `pending`. Without this sweep,
	// those ticks would sit forever and their enrollments would never advance.
	const staleCutoff = new Date(Date.now() - STALE_PROCESSING_MS);
	await db
		.update(automationScheduledTicks)
		.set({
			status: "pending",
			attempts: sql`${automationScheduledTicks.attempts} + 1`,
		})
		.where(
			and(
				eq(automationScheduledTicks.status, "processing"),
				lte(automationScheduledTicks.runAt, staleCutoff),
			),
		);

	// Select a batch of due tick IDs first, then claim only those.
	const dueRows = await db
		.select({ id: automationScheduledTicks.id })
		.from(automationScheduledTicks)
		.where(
			and(
				eq(automationScheduledTicks.status, "pending"),
				lte(automationScheduledTicks.runAt, now),
			),
		)
		.orderBy(asc(automationScheduledTicks.runAt))
		.limit(BATCH_SIZE);

	if (dueRows.length === 0) return 0;

	const dueIds = dueRows.map((r) => r.id);
	const claimed = await db
		.update(automationScheduledTicks)
		.set({ status: "processing" })
		.where(
			and(
				inArray(automationScheduledTicks.id, dueIds),
				eq(automationScheduledTicks.status, "pending"),
			),
		)
		.returning({
			id: automationScheduledTicks.id,
			enrollmentId: automationScheduledTicks.enrollmentId,
		});

	let enqueued = 0;
	for (const tick of claimed) {
		try {
			await env.AUTOMATION_QUEUE.send({
				type: "advance",
				enrollment_id: tick.enrollmentId,
				resume_label: "next",
			});
			await db
				.update(automationScheduledTicks)
				.set({ status: "done" })
				.where(eq(automationScheduledTicks.id, tick.id));
			enqueued++;
		} catch {
			await db
				.update(automationScheduledTicks)
				.set({
					status: "pending",
					attempts: sql`${automationScheduledTicks.attempts} + 1`,
				})
				.where(eq(automationScheduledTicks.id, tick.id));
		}
	}

	return enqueued;
}

/**
 * Timeout sweep: enrollments that have been waiting on user input past their
 * `_pending_input_timeout_at` mark should be advanced with a 'timeout' branch.
 */
export async function processAutomationInputTimeouts(
	env: Env,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date().toISOString();

	const rows = (await db.execute(sql`
		SELECT id FROM automation_enrollments
		WHERE status = 'waiting'
		  AND state ? '_pending_input_timeout_at'
		  AND (state ->> '_pending_input_timeout_at') <= ${now}
		ORDER BY (state ->> '_pending_input_timeout_at') ASC
		LIMIT ${BATCH_SIZE}
	`)) as unknown as Array<{ id: string }>;

	let count = 0;
	for (const row of rows) {
		// Load the current row so we can restore on queue-send failure. Without
		// this, a transient queue failure would strand the enrollment in
		// `active` with the `_pending_input_*` markers already cleared, so no
		// future sweep could reclaim it.
		const current = await db.query.automationEnrollments.findFirst({
			where: eq(automationEnrollments.id, row.id),
		});
		if (!current) continue;
		const originalState = current.state;

		// Claim the row by clearing the markers + flipping to active. This
		// prevents a concurrent sweep tick from re-claiming while the queue
		// send is in flight.
		await db
			.update(automationEnrollments)
			.set({
				state: sql`(${automationEnrollments.state}::jsonb
					- '_pending_input_field'
					- '_pending_input_node_key'
					- '_pending_input_timeout_at')`,
				status: "active",
				updatedAt: new Date(),
			})
			.where(eq(automationEnrollments.id, row.id));

		try {
			await env.AUTOMATION_QUEUE.send({
				type: "advance",
				enrollment_id: row.id,
				resume_label: "timeout",
			});
			count++;
		} catch (err) {
			console.error("[scheduler] timeout enqueue failed for", row.id, err);
			// Restore waiting state + original markers so the next sweep retries.
			await db
				.update(automationEnrollments)
				.set({
					state: originalState,
					status: "waiting",
					updatedAt: new Date(),
				})
				.where(eq(automationEnrollments.id, row.id));
		}
	}
	return count;
}
