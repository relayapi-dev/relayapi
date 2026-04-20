import type { AutomationSnapshot, AutomationSnapshotTrigger } from "./types";

/**
 * Returns the snapshot trigger that fired for this enrollment. Falls back to
 * the first trigger (lowest order_index) when trigger_id is missing — e.g.
 * manual enrollments from POST /v1/automations/:id/enroll that didn't match
 * against a specific trigger.
 */
export function resolveEnrollmentTrigger(
	snapshot: AutomationSnapshot,
	enrollmentTriggerId: string | null | undefined,
): AutomationSnapshotTrigger {
	if (enrollmentTriggerId) {
		const exact = snapshot.triggers.find((t) => t.id === enrollmentTriggerId);
		if (exact) return exact;
	}
	const first = [...snapshot.triggers].sort(
		(a, b) => a.order_index - b.order_index,
	)[0];
	if (!first) {
		throw new Error(
			`automation ${snapshot.automation_id} snapshot has no triggers`,
		);
	}
	return first;
}
