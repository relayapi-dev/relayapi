import type { AutomationSnapshot, AutomationSnapshotTrigger } from "./types";

export const ENROLLMENT_TRIGGER_STATE_KEY = "_trigger_id";

export interface DirectEnrollmentTrigger {
	id: string;
	type: string;
	order_index: number;
}

function enrollmentStateRecord(
	enrollmentState: unknown,
): Record<string, unknown> | null {
	return enrollmentState &&
		typeof enrollmentState === "object" &&
		!Array.isArray(enrollmentState)
		? (enrollmentState as Record<string, unknown>)
		: null;
}

export function withStoredEnrollmentTriggerId(
	enrollmentState: Record<string, unknown> | undefined,
	triggerId: string,
): Record<string, unknown> {
	return {
		...(enrollmentState ?? {}),
		[ENROLLMENT_TRIGGER_STATE_KEY]: triggerId,
	};
}

export function getEnrollmentTriggerId(
	enrollmentTriggerId: string | null | undefined,
	enrollmentState: unknown,
): string | null {
	if (enrollmentTriggerId) return enrollmentTriggerId;

	const state = enrollmentStateRecord(enrollmentState);
	const stored = state?.[ENROLLMENT_TRIGGER_STATE_KEY];
	return typeof stored === "string" && stored.length > 0 ? stored : null;
}

export function selectDirectEnrollmentTrigger(
	triggers: DirectEnrollmentTrigger[],
	requestedTriggerId?: string | null,
):
	| { ok: true; trigger: DirectEnrollmentTrigger }
	| { ok: false; reason: "invalid_trigger" | "ambiguous_trigger" | "no_triggers" } {
	if (requestedTriggerId) {
		const exact = triggers.find((trigger) => trigger.id === requestedTriggerId);
		return exact
			? { ok: true, trigger: exact }
			: { ok: false, reason: "invalid_trigger" };
	}

	const sorted = [...triggers].sort((a, b) => a.order_index - b.order_index);
	if (sorted.length === 0) {
		return { ok: false, reason: "no_triggers" };
	}
	if (sorted.length > 1) {
		return { ok: false, reason: "ambiguous_trigger" };
	}
	return { ok: true, trigger: sorted[0]! };
}

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
