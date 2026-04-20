import {
	automationEnrollments,
	automationRunLogs,
	automationScheduledTicks,
	automationVersions,
	automations,
} from "@relayapi/db";
import { createDb } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { Env } from "../../types";
import { getNodeHandler } from "./nodes";
import { sendInputPrompt } from "./nodes/user-input";
import { validateInput } from "./nodes/user-input-validation";
import { getEnrollmentTriggerId } from "./resolve-trigger";
import type {
	AutomationSnapshot,
	NodeExecutionContext,
	NodeExecutionResult,
} from "./types";

const MAX_STEPS_PER_TICK = 25; // hard cap on synchronous chain length before re-enqueueing

/**
 * Runs an enrollment forward until it completes, waits, or hits the step cap.
 * Called from the AUTOMATION_QUEUE consumer.
 *
 * @param opts.resumeLabel — when set, the runner treats the enrollment's
 *   current node as already-executed (it was a wait/wait_for_input node) and
 *   follows the outgoing edge with this label. This prevents smart_delay and
 *   user_input nodes from re-executing themselves on resume.
 */
export async function advanceEnrollment(
	env: Env,
	enrollmentId: string,
	opts?: { resumeLabel?: string },
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const enrollment = await db.query.automationEnrollments.findFirst({
		where: eq(automationEnrollments.id, enrollmentId),
	});
	if (!enrollment) return;
	if (
		enrollment.status === "completed" ||
		enrollment.status === "exited" ||
		enrollment.status === "failed"
	) {
		return;
	}

	const snapshot = await loadSnapshot(
		db,
		enrollment.automationId,
		enrollment.automationVersion,
	);
	if (!snapshot) {
		await markFailed(db, enrollment.id, "automation version not found");
		return;
	}

	let currentNodeKey = enrollment.currentNodeId
		? nodeKeyById(snapshot, enrollment.currentNodeId)
		: snapshot.entry_node_key;
	let state: Record<string, unknown> =
		(enrollment.state as Record<string, unknown>) ?? {};
	const triggerId = getEnrollmentTriggerId(enrollment.triggerId, state);
	let resumeLabel = opts?.resumeLabel;

	// Resume path: advance past the waiting node without re-executing it.
	if (resumeLabel) {
		const nextKey = resolveNextNodeKey(snapshot, currentNodeKey, resumeLabel);
		if (!nextKey) {
			await db
				.update(automationEnrollments)
				.set({
					status: "completed",
					completedAt: new Date(),
					state,
					updatedAt: new Date(),
				})
				.where(eq(automationEnrollments.id, enrollment.id));
			await db
				.update(automations)
				.set({ totalCompleted: sqlIncrement(1) as never })
				.where(eq(automations.id, enrollment.automationId));
			return;
		}
		currentNodeKey = nextKey;
		resumeLabel = undefined;
	}

	for (let step = 0; step < MAX_STEPS_PER_TICK; step++) {
		const node = snapshot.nodes.find((n) => n.key === currentNodeKey);
		if (!node) {
			await markFailed(
				db,
				enrollment.id,
				`node '${currentNodeKey}' not in snapshot`,
			);
			return;
		}

		const handler = getNodeHandler(node.type);
		const startedAt = Date.now();
		const ctx: NodeExecutionContext = {
			env,
			db,
			enrollment: {
				id: enrollment.id,
				organization_id: enrollment.organizationId,
				automation_id: enrollment.automationId,
				automation_version: enrollment.automationVersion,
				trigger_id: triggerId,
				contact_id: enrollment.contactId,
				conversation_id: enrollment.conversationId,
				current_node_id: node.id,
				state,
			},
			snapshot,
			node,
		};
		const stateBefore = cloneJson(state);

		let result: NodeExecutionResult;
		try {
			result = await handler(ctx);
		} catch (e) {
			result = { kind: "fail", error: String(e) };
		}
		const duration = Date.now() - startedAt;

		state = {
			...state,
			...(result.kind !== "fail" ? (result.state_patch ?? {}) : {}),
		};
		const stateAfter = cloneJson(state);

		const label = result.kind === "next" ? (result.label ?? "next") : null;
		const nextKey =
			result.kind === "goto"
				? result.target_node_key
				: result.kind === "next"
					? resolveNextNodeKey(snapshot, currentNodeKey, label ?? "next")
					: null;
		const logPayload: Record<string, unknown> = {
			result_kind: result.kind,
			node_config: cloneJson(node.config),
			state_before: stateBefore,
			state_patch:
				result.kind === "fail" ? null : cloneJson(result.state_patch ?? null),
			state_after: stateAfter,
		};
		if (result.kind === "next") {
			logPayload.output_label = label;
			logPayload.next_node_key = nextKey;
		}
		if (result.kind === "goto") {
			logPayload.target_node_key = result.target_node_key;
		}
		if (result.kind === "wait") {
			logPayload.next_run_at = result.next_run_at.toISOString();
		}
		if (result.kind === "complete" && result.reason) {
			logPayload.reason = result.reason;
		}
		if (result.kind === "exit") {
			logPayload.reason = result.reason;
		}
		if (result.kind === "fail") {
			logPayload.error = result.error;
		}

		await db.insert(automationRunLogs).values({
			enrollmentId: enrollment.id,
			nodeId: node.id,
			nodeType: node.type as never,
			executedAt: new Date(),
			outcome: outcomeFromResult(result),
			branchLabel: result.kind === "next" ? (result.label ?? "next") : null,
			durationMs: duration,
			error: result.kind === "fail" ? result.error : null,
			payload: logPayload,
		});

		if (result.kind === "fail") {
			await markFailed(db, enrollment.id, result.error);
			return;
		}

		if (result.kind === "complete") {
			await db
				.update(automationEnrollments)
				.set({
					status: "completed",
					completedAt: new Date(),
					state,
					currentNodeId: node.id,
					updatedAt: new Date(),
				})
				.where(eq(automationEnrollments.id, enrollment.id));
			await db
				.update(automations)
				.set({ totalCompleted: sqlIncrement(1) as never })
				.where(eq(automations.id, enrollment.automationId));
			return;
		}

		if (result.kind === "exit") {
			await db
				.update(automationEnrollments)
				.set({
					status: "exited",
					exitedAt: new Date(),
					exitReason: result.reason,
					state,
					currentNodeId: node.id,
					updatedAt: new Date(),
				})
				.where(eq(automationEnrollments.id, enrollment.id));
			await db
				.update(automations)
				.set({ totalExited: sqlIncrementExited(1) as never })
				.where(eq(automations.id, enrollment.automationId));
			return;
		}

		if (result.kind === "wait") {
			await db
				.update(automationEnrollments)
				.set({
					status: "waiting",
					nextRunAt: result.next_run_at,
					state,
					currentNodeId: node.id,
					updatedAt: new Date(),
				})
				.where(eq(automationEnrollments.id, enrollment.id));
			await db.insert(automationScheduledTicks).values({
				enrollmentId: enrollment.id,
				runAt: result.next_run_at,
			});
			return;
		}

		if (result.kind === "wait_for_input") {
			await db
				.update(automationEnrollments)
				.set({
					status: "waiting",
					state,
					currentNodeId: node.id,
					updatedAt: new Date(),
				})
				.where(eq(automationEnrollments.id, enrollment.id));
			return;
		}

		if (!nextKey) {
			// Graph terminates implicitly (no outgoing edge). This counts as a
			// successful completion — increment totalCompleted just like an
			// explicit `complete` result.
			await db
				.update(automationEnrollments)
				.set({
					status: "completed",
					completedAt: new Date(),
					state,
					currentNodeId: node.id,
					updatedAt: new Date(),
				})
				.where(eq(automationEnrollments.id, enrollment.id));
			await db
				.update(automations)
				.set({ totalCompleted: sqlIncrement(1) as never })
				.where(eq(automations.id, enrollment.automationId));
			return;
		}

		currentNodeKey = nextKey;
	}

	// Hit step cap — re-enqueue for next tick. The enrollment row is updated
	// first so the next worker resumes from the right node. If the queue send
	// fails, insert a scheduled tick so the cron sweep rescues the enrollment
	// instead of letting it sit `active` with no worker scheduled.
	await db
		.update(automationEnrollments)
		.set({
			state,
			currentNodeId:
				snapshot.nodes.find((n) => n.key === currentNodeKey)?.id ?? null,
			updatedAt: new Date(),
		})
		.where(eq(automationEnrollments.id, enrollment.id));
	try {
		await env.AUTOMATION_QUEUE.send({
			type: "advance",
			enrollment_id: enrollment.id,
		});
	} catch (err) {
		console.error(
			"[runner] step-cap requeue failed, scheduling recovery tick for",
			enrollment.id,
			err,
		);
		// Schedule a tick ~10s out so the cron sweep reclaims the enrollment.
		await db.insert(automationScheduledTicks).values({
			enrollmentId: enrollment.id,
			runAt: new Date(Date.now() + 10_000),
		});
	}
}

/**
 * Called when inbound message / file arrives for a contact parked at a
 * user_input_* node. Validates the input against the node's subtype + config:
 *
 *   - valid        → save to `save_to_field`, clear markers, resume via `captured`
 *   - invalid + attempts remaining → increment `_pending_input_attempts`,
 *     re-send `retry_prompt` (if configured), keep parked as `waiting`
 *   - invalid + attempts exhausted → clear markers, resume via `no_match`
 */
export async function resumeFromInput(
	env: Env,
	enrollmentId: string,
	inputValue: unknown,
	fileMeta?: { mime_type?: string; size_bytes?: number },
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const enrollment = await db.query.automationEnrollments.findFirst({
		where: eq(automationEnrollments.id, enrollmentId),
	});
	if (!enrollment || enrollment.status !== "waiting") return;

	const state = (enrollment.state as Record<string, unknown>) ?? {};
	const fieldKey = state._pending_input_field as string | undefined;
	const nodeType = state._pending_input_node_type as string | undefined;
	const attemptsSoFar =
		(state._pending_input_attempts as number | undefined) ?? 0;

	// Load the snapshot so we can look up the node's config for validation
	// and re-send the retry_prompt on invalid attempts.
	const snapshot = await loadSnapshot(
		db,
		enrollment.automationId,
		enrollment.automationVersion,
	);
	const nodeId = enrollment.currentNodeId;
	const node = snapshot?.nodes.find((n) => n.id === nodeId);

	// If we can't locate the node (snapshot drift) or the type isn't a
	// user_input_* (upgrade path), fall back to the old behavior: save + resume.
	if (!node || !nodeType || !nodeType.startsWith("user_input_")) {
		if (fieldKey) state[fieldKey] = inputValue;
		delete state._pending_input_field;
		delete state._pending_input_node_key;
		delete state._pending_input_node_type;
		delete state._pending_input_timeout_at;
		delete state._pending_input_channel;
		delete state._pending_input_conversation_id;
		delete state._pending_input_attempts;
		await db
			.update(automationEnrollments)
			.set({ status: "active", state, updatedAt: new Date() })
			.where(eq(automationEnrollments.id, enrollmentId));
		await advanceEnrollment(env, enrollmentId, { resumeLabel: "captured" });
		return;
	}

	const verdict = validateInput(
		nodeType,
		node.config,
		inputValue,
		attemptsSoFar,
		fileMeta,
	);

	if (verdict.kind === "ok") {
		if (fieldKey) state[fieldKey] = verdict.value;
		delete state._pending_input_field;
		delete state._pending_input_node_key;
		delete state._pending_input_node_type;
		delete state._pending_input_timeout_at;
		delete state._pending_input_channel;
		delete state._pending_input_conversation_id;
		delete state._pending_input_attempts;
		await db
			.update(automationEnrollments)
			.set({ status: "active", state, updatedAt: new Date() })
			.where(eq(automationEnrollments.id, enrollmentId));
		await advanceEnrollment(env, enrollmentId, { resumeLabel: "captured" });
		return;
	}

	if (verdict.kind === "retry") {
		// Bump attempts and (optionally) re-send the retry prompt. Keep the
		// enrollment parked in `waiting` with markers intact so the next
		// inbound message comes back through here.
		state._pending_input_attempts = attemptsSoFar + 1;
		state._last_input_validation_reason = verdict.reason;

		const retryPrompt = node.config.retry_prompt as string | undefined;
		if (retryPrompt) {
			await sendInputPrompt(
				{
					env,
					db,
					snapshot: snapshot as AutomationSnapshot,
					enrollment: {
						id: enrollment.id,
						organization_id: enrollment.organizationId,
						automation_id: enrollment.automationId,
						automation_version: enrollment.automationVersion,
						trigger_id: getEnrollmentTriggerId(enrollment.triggerId, state),
						contact_id: enrollment.contactId,
						conversation_id: enrollment.conversationId,
						current_node_id: enrollment.currentNodeId,
						state,
					},
				},
				retryPrompt,
			);
		}

		await db
			.update(automationEnrollments)
			.set({ state, updatedAt: new Date() })
			.where(eq(automationEnrollments.id, enrollmentId));
		// Stay in waiting status — no advance.
		return;
	}

	// verdict.kind === "fail" — attempts exhausted. Clear markers and fall
	// through to the `no_match` branch.
	state._last_input_validation_reason = verdict.reason;
	delete state._pending_input_field;
	delete state._pending_input_node_key;
	delete state._pending_input_node_type;
	delete state._pending_input_timeout_at;
	delete state._pending_input_channel;
	delete state._pending_input_conversation_id;
	delete state._pending_input_attempts;

	await db
		.update(automationEnrollments)
		.set({ status: "active", state, updatedAt: new Date() })
		.where(eq(automationEnrollments.id, enrollmentId));
	await advanceEnrollment(env, enrollmentId, { resumeLabel: "no_match" });
}

async function loadSnapshot(
	db: ReturnType<typeof createDb>,
	automationId: string,
	version: number,
): Promise<AutomationSnapshot | null> {
	const row = await db.query.automationVersions.findFirst({
		where: and(
			eq(automationVersions.automationId, automationId),
			eq(automationVersions.version, version),
		),
	});
	if (!row) return null;
	return row.snapshot as AutomationSnapshot;
}

function nodeKeyById(snapshot: AutomationSnapshot, nodeId: string): string {
	return (
		snapshot.nodes.find((n) => n.id === nodeId)?.key ?? snapshot.entry_node_key
	);
}

function resolveNextNodeKey(
	snapshot: AutomationSnapshot,
	fromKey: string,
	label: string,
): string | null {
	const candidates = snapshot.edges
		.filter((e) => e.from_node_key === fromKey && e.label === label)
		.sort((a, b) => a.order - b.order);
	const first = candidates[0];
	if (first) return first.to_node_key;

	// Fallback to 'next' if the specific label isn't present
	if (label !== "next") {
		const fallback = snapshot.edges
			.filter((e) => e.from_node_key === fromKey && e.label === "next")
			.sort((a, b) => a.order - b.order);
		const fallbackFirst = fallback[0];
		if (fallbackFirst) return fallbackFirst.to_node_key;
	}

	return null;
}

async function markFailed(
	db: ReturnType<typeof createDb>,
	enrollmentId: string,
	error: string,
): Promise<void> {
	await db
		.update(automationEnrollments)
		.set({
			status: "failed",
			exitReason: error.slice(0, 500),
			updatedAt: new Date(),
		})
		.where(eq(automationEnrollments.id, enrollmentId));
}

function outcomeFromResult(result: NodeExecutionResult): string {
	switch (result.kind) {
		case "next":
			return "ok";
		case "wait":
			return "wait";
		case "wait_for_input":
			return "wait_for_input";
		case "goto":
			return "goto";
		case "complete":
			return "complete";
		case "exit":
			return "exit";
		case "fail":
			return "failed";
	}
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value ?? null)) as T;
}

// Helpers to increment a counter in an update. Drizzle doesn't have a clean
// `+1` helper, so we use raw SQL templates for the counter update paths.
import { sql as drizzleSql } from "drizzle-orm";
function sqlIncrement(amount: number) {
	return drizzleSql`total_completed + ${amount}`;
}
function sqlIncrementExited(amount: number) {
	return drizzleSql`total_exited + ${amount}`;
}
