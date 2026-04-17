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
import type {
	AutomationSnapshot,
	NodeExecutionContext,
	NodeExecutionResult,
} from "./types";

const MAX_STEPS_PER_TICK = 25; // hard cap on synchronous chain length before re-enqueueing

/**
 * Runs an enrollment forward until it completes, waits, or hits the step cap.
 * Called from the AUTOMATION_QUEUE consumer.
 */
export async function advanceEnrollment(
	env: Env,
	enrollmentId: string,
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
	let state: Record<string, unknown> = (enrollment.state as Record<string, unknown>) ?? {};

	for (let step = 0; step < MAX_STEPS_PER_TICK; step++) {
		const node = snapshot.nodes.find((n) => n.key === currentNodeKey);
		if (!node) {
			await markFailed(db, enrollment.id, `node '${currentNodeKey}' not in snapshot`);
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
				contact_id: enrollment.contactId,
				conversation_id: enrollment.conversationId,
				current_node_id: node.id,
				state,
			},
			snapshot,
			node,
		};

		let result: NodeExecutionResult;
		try {
			result = await handler(ctx);
		} catch (e) {
			result = { kind: "fail", error: String(e) };
		}
		const duration = Date.now() - startedAt;

		state = { ...state, ...(result.kind !== "fail" ? result.state_patch ?? {} : {}) };

		await db.insert(automationRunLogs).values({
			enrollmentId: enrollment.id,
			nodeId: node.id,
			nodeType: node.type as never,
			executedAt: new Date(),
			outcome: outcomeFromResult(result),
			branchLabel: result.kind === "next" ? (result.label ?? "next") : null,
			durationMs: duration,
			error: result.kind === "fail" ? result.error : null,
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

		// Resolve next node based on edge label
		const label = result.kind === "goto" ? null : (result.label ?? "next");
		const nextKey =
			result.kind === "goto"
				? result.target_node_key
				: resolveNextNodeKey(snapshot, currentNodeKey, label ?? "next");

		if (!nextKey) {
			// Graph terminates implicitly (no outgoing edge).
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
			return;
		}

		currentNodeKey = nextKey;
	}

	// Hit step cap — re-enqueue for next tick
	await db
		.update(automationEnrollments)
		.set({
			state,
			currentNodeId: snapshot.nodes.find((n) => n.key === currentNodeKey)?.id ?? null,
			updatedAt: new Date(),
		})
		.where(eq(automationEnrollments.id, enrollment.id));
	await env.AUTOMATION_QUEUE.send({ type: "advance", enrollment_id: enrollment.id });
}

/**
 * Called when inbound message arrives for a contact with a pending input-wait.
 */
export async function resumeFromInput(
	env: Env,
	enrollmentId: string,
	inputValue: unknown,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const enrollment = await db.query.automationEnrollments.findFirst({
		where: eq(automationEnrollments.id, enrollmentId),
	});
	if (!enrollment || enrollment.status !== "waiting") return;

	const state = (enrollment.state as Record<string, unknown>) ?? {};
	const fieldKey = state._pending_input_field as string | undefined;
	if (fieldKey) {
		state[fieldKey] = inputValue;
	}
	delete state._pending_input_field;
	delete state._pending_input_node_key;
	delete state._pending_input_timeout_at;

	await db
		.update(automationEnrollments)
		.set({ status: "active", state, updatedAt: new Date() })
		.where(eq(automationEnrollments.id, enrollmentId));

	await advanceEnrollment(env, enrollmentId);
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
	return snapshot.nodes.find((n) => n.id === nodeId)?.key ?? snapshot.entry_node_key;
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

// Helper to increment a counter in an update. Drizzle doesn't have a clean `+1` helper,
// so we use a raw SQL template for the rare counter update path.
import { sql as drizzleSql } from "drizzle-orm";
function sqlIncrement(amount: number) {
	return drizzleSql`total_completed + ${amount}`;
}
