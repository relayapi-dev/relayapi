// apps/api/src/services/automations/runner.ts
//
// Execution loop for the Manychat-parity automation engine.
// See docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md
// §8.3 for the step-by-step semantics this file implements.
//
// Per-iteration behavior:
//   1. pause check (automation_contact_controls)
//   2. re-read graph from automations.graph
//   3. locate current node (graph_changed exit if missing)
//   4. claim a revision-bound node/effect ledger row
//   5. dispatch or replay the persisted HandlerResult
//   6. apply HandlerResult (advance / wait_input / wait_delay / end / fail)
// plus: integer-revision CAS concurrency, 200-visit infinite-loop cap.

import {
	type AutomationNodeKind,
	automationBindings,
	automationContactControls,
	automationEffects,
	automationEntrypointDailyCounts,
	automationEntrypoints,
	automationNodeExecutions,
	automationRuns,
	automationScheduledJobs,
	automationStepRuns,
	automations,
	contacts,
	customFieldDefinitions,
	customFieldValues,
	type Database,
	inboxConversations,
	isAutomationNodeKind,
	socialAccounts,
} from "@relayapi/db";
import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNull,
	lte,
	notExists,
	or,
	sql,
} from "drizzle-orm";
import type { Graph, GraphEdge } from "../../schemas/automation-graph";
import { decryptContactRow } from "../contact-protection";
import { getContactSegmentIds } from "../segment-memberships";
import { getHandler } from "./manifest";
import {
	AutomationExternalEffectBusyError,
	type AutomationExternalEffectDescriptor,
	AutomationExternalEffectKnownFailureError,
	type AutomationExternalEffectOutcome,
	AutomationExternalEffectUnknownError,
	type HandlerResult,
	type RunContext,
	type RunStatus,
} from "./types";

const MAX_VISITS_PER_LOOP = 200;
const NODE_EXECUTION_LEASE_MS = 5 * 60 * 1000;

type AutomationRunRow = typeof automationRuns.$inferSelect;
type NodeExecutionRow = typeof automationNodeExecutions.$inferSelect;
type AutomationEffectRow = typeof automationEffects.$inferSelect;

type StoredHandlerResult =
	| { result: "advance"; via_port: string; payload?: unknown }
	| {
			result: "wait_input";
			timeout_at?: string;
			payload?: unknown;
	  }
	| { result: "wait_delay"; resume_at: string; payload?: unknown }
	| {
			result: "wait_event";
			event_kinds: string[];
			timeout_at?: string;
			payload?: unknown;
	  }
	| { result: "end"; exit_reason: string; payload?: unknown }
	| {
			result: "fail";
			error: { message: string; stack?: string };
			payload?: unknown;
	  };

type StoredNodeCompletion = {
	version: 1;
	handlerResult: StoredHandlerResult;
	context: Record<string, unknown>;
	durationMs: number;
};

type NodeExecutionClaim =
	| {
			state: "owned";
			execution: NodeExecutionRow;
			effectIdempotencyKey: string;
	  }
	| {
			state: "replay";
			execution: NodeExecutionRow;
			effectIdempotencyKey: string;
			completion: StoredNodeCompletion;
	  }
	| { state: "busy" }
	| {
			state: "unknown";
			execution: NodeExecutionRow;
			effectIdempotencyKey: string;
			reason: string;
	  };

class LostNodeExecutionClaimError extends Error {}

export type EnrollmentBlockedReason =
	| "active_run"
	| "automation_inactive"
	| "reentry_disabled"
	| "reentry_cooldown"
	| "daily_cap";

export class EnrollmentBlockedError extends Error {
	constructor(public readonly reason: EnrollmentBlockedReason) {
		super(`automation enrollment blocked: ${reason}`);
		this.name = "EnrollmentBlockedError";
	}
}

class TriggerOccurrenceConflictError extends Error {
	constructor() {
		super("automation trigger occurrence already enrolled");
		this.name = "TriggerOccurrenceConflictError";
	}
}

function toJsonSafe(value: unknown): unknown {
	if (value === undefined) return null;
	const seen = new WeakSet<object>();
	try {
		const encoded = JSON.stringify(value, (_key, current) => {
			if (typeof current === "bigint") return current.toString();
			if (current instanceof Date) return current.toISOString();
			if (current instanceof Error) {
				return { message: current.message, stack: current.stack };
			}
			if (current && typeof current === "object") {
				if (seen.has(current)) return "[Circular]";
				seen.add(current);
			}
			return current;
		});
		return encoded === undefined ? null : JSON.parse(encoded);
	} catch (error) {
		return {
			serialization_error:
				error instanceof Error ? error.message : String(error),
		};
	}
}

export function serializeAutomationHandlerResult(
	result: HandlerResult,
): StoredHandlerResult {
	const payload =
		result.payload === undefined ? undefined : toJsonSafe(result.payload);
	switch (result.result) {
		case "advance":
			return { result: "advance", via_port: result.via_port, payload };
		case "wait_input":
			return {
				result: "wait_input",
				timeout_at: result.timeout_at?.toISOString(),
				payload,
			};
		case "wait_delay":
			return {
				result: "wait_delay",
				resume_at: result.resume_at.toISOString(),
				payload,
			};
		case "wait_event":
			return {
				result: "wait_event",
				event_kinds: result.event_kinds,
				timeout_at: result.timeout_at?.toISOString(),
				payload,
			};
		case "end":
			return {
				result: "end",
				exit_reason: result.exit_reason,
				payload,
			};
		case "fail":
			return {
				result: "fail",
				error: { message: result.error.message, stack: result.error.stack },
				payload,
			};
	}
}

export function deserializeAutomationHandlerResult(
	stored: StoredHandlerResult,
): HandlerResult {
	switch (stored.result) {
		case "advance":
			return {
				result: "advance",
				via_port: stored.via_port,
				payload: stored.payload,
			};
		case "wait_input":
			return {
				result: "wait_input",
				timeout_at: stored.timeout_at ? new Date(stored.timeout_at) : undefined,
				payload: stored.payload,
			};
		case "wait_delay":
			return {
				result: "wait_delay",
				resume_at: new Date(stored.resume_at),
				payload: stored.payload,
			};
		case "wait_event":
			return {
				result: "wait_event",
				event_kinds: stored.event_kinds,
				timeout_at: stored.timeout_at ? new Date(stored.timeout_at) : undefined,
				payload: stored.payload,
			};
		case "end":
			return {
				result: "end",
				exit_reason: stored.exit_reason,
				payload: stored.payload,
			};
		case "fail": {
			const error = new Error(stored.error.message);
			if (stored.error.stack) error.stack = stored.error.stack;
			return { result: "fail", error, payload: stored.payload };
		}
	}
}

export function automationEffectIdempotencyKey(
	nodeExecutionId: string,
	effectKey?: string,
): string {
	const base = `relayapi:automation:${nodeExecutionId}`;
	return effectKey ? `${base}:${encodeURIComponent(effectKey)}` : base;
}

function storedNodeCompletion(value: unknown): StoredNodeCompletion | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Partial<StoredNodeCompletion>;
	if (
		candidate.version !== 1 ||
		!candidate.handlerResult ||
		typeof candidate.handlerResult !== "object" ||
		!candidate.context ||
		typeof candidate.context !== "object" ||
		Array.isArray(candidate.context) ||
		typeof candidate.durationMs !== "number"
	) {
		return null;
	}
	const result = (candidate.handlerResult as { result?: unknown }).result;
	if (
		result !== "advance" &&
		result !== "wait_input" &&
		result !== "wait_delay" &&
		result !== "wait_event" &&
		result !== "end" &&
		result !== "fail"
	) {
		return null;
	}
	return candidate as StoredNodeCompletion;
}

function leaseIsExpired(leaseExpiresAt: Date | null, now: Date): boolean {
	return !leaseExpiresAt || leaseExpiresAt <= now;
}

function nodeExecutionLeaseExpirySql() {
	return sql`CURRENT_TIMESTAMP + (${NODE_EXECUTION_LEASE_MS} * INTERVAL '1 millisecond')`;
}

export function automationExecutionRecoveryDisposition(
	execution: {
		status: "claimed" | "in_flight" | "succeeded" | "failed" | "unknown";
		leaseExpiresAt: Date | null;
		requestMayHaveBeenSentAt: Date | null;
	},
	now: Date,
): "completed" | "busy" | "reclaim" | "unknown" {
	if (execution.status === "succeeded" || execution.status === "failed") {
		return "completed";
	}
	if (execution.status === "unknown") return "unknown";
	if (!leaseIsExpired(execution.leaseExpiresAt, now)) return "busy";
	if (execution.status === "in_flight" || execution.requestMayHaveBeenSentAt) {
		return "unknown";
	}
	return "reclaim";
}

function nodeExecutionRecoveryDisposition(
	execution: NodeExecutionRow,
	now: Date,
): "completed" | "busy" | "reclaim" | "unknown" {
	if (execution.status === "succeeded" || execution.status === "failed") {
		return "completed";
	}
	if (execution.status === "unknown") return "unknown";
	return leaseIsExpired(execution.leaseExpiresAt, now) ? "reclaim" : "busy";
}

async function loadNodeExecution(
	db: Db,
	runId: string,
	runRevision: number,
): Promise<NodeExecutionRow | undefined> {
	const [row] = await db
		.select()
		.from(automationNodeExecutions)
		.where(
			and(
				eq(automationNodeExecutions.runId, runId),
				eq(automationNodeExecutions.runRevision, runRevision),
				eq(automationNodeExecutions.visitOrdinal, 0),
			),
		)
		.limit(1);
	return row;
}

async function loadNodeEffect(
	db: Db,
	nodeExecutionId: string,
	effectKey: string,
): Promise<AutomationEffectRow | undefined> {
	const [row] = await db
		.select()
		.from(automationEffects)
		.where(
			and(
				eq(automationEffects.nodeExecutionId, nodeExecutionId),
				eq(automationEffects.effectKey, effectKey),
			),
		)
		.limit(1);
	return row;
}

async function markNodeExecutionUnknown(
	db: Db,
	execution: NodeExecutionRow,
	reason: string,
	requireExpiredLease = false,
): Promise<boolean> {
	try {
		await db.transaction(async (tx) => {
			const [marked] = await tx
				.update(automationNodeExecutions)
				.set({
					status: "unknown",
					leaseExpiresAt: null,
					error: { message: reason },
					completedAt: sql`CURRENT_TIMESTAMP`,
					updatedAt: sql`CURRENT_TIMESTAMP`,
				})
				.where(
					and(
						eq(automationNodeExecutions.id, execution.id),
						eq(automationNodeExecutions.leaseToken, execution.leaseToken),
						eq(automationNodeExecutions.status, "claimed"),
						requireExpiredLease
							? or(
									isNull(automationNodeExecutions.leaseExpiresAt),
									lte(
										automationNodeExecutions.leaseExpiresAt,
										sql`CURRENT_TIMESTAMP`,
									),
								)
							: undefined,
					),
				)
				.returning({ id: automationNodeExecutions.id });
			if (!marked) throw new LostNodeExecutionClaimError();
		});
		return true;
	} catch (error) {
		if (error instanceof LostNodeExecutionClaimError) return false;
		throw error;
	}
}

type EffectClaim =
	| { state: "owned"; effect: AutomationEffectRow }
	| { state: "replay"; effect: AutomationEffectRow }
	| { state: "busy" }
	| { state: "unknown"; effectId: string; reason: string };

async function claimExternalEffect(
	db: Db,
	execution: NodeExecutionRow,
	descriptor: AutomationExternalEffectDescriptor,
	now: Date,
): Promise<EffectClaim> {
	const providerIdempotencyKey = automationEffectIdempotencyKey(
		execution.id,
		descriptor.effectKey,
	);
	const [inserted] = await db
		.insert(automationEffects)
		.values({
			nodeExecutionId: execution.id,
			organizationId: execution.organizationId,
			scopeKey: execution.scopeKey,
			effectKey: descriptor.effectKey,
			kind: descriptor.kind,
			providerIdempotencyKey,
			status: "claimed",
			leaseToken: 1,
			leaseExpiresAt: nodeExecutionLeaseExpirySql(),
		})
		.onConflictDoNothing()
		.returning();
	if (inserted) return { state: "owned", effect: inserted };

	const existing = await loadNodeEffect(db, execution.id, descriptor.effectKey);
	if (!existing) return { state: "busy" };
	if (
		existing.kind !== descriptor.kind ||
		existing.providerIdempotencyKey !== providerIdempotencyKey
	) {
		return {
			state: "unknown",
			effectId: existing.id,
			reason: "automation effect identity does not match its node execution",
		};
	}
	const recovery = automationExecutionRecoveryDisposition(existing, now);
	if (recovery === "unknown") {
		if (existing.status !== "unknown") {
			const reason =
				existing.lastError ??
				"automation effect lease expired after its provider boundary";
			await db
				.update(automationEffects)
				.set({
					status: "unknown",
					leaseExpiresAt: null,
					lastError: reason,
					completedAt: sql`CURRENT_TIMESTAMP`,
					updatedAt: sql`CURRENT_TIMESTAMP`,
				})
				.where(
					and(
						eq(automationEffects.id, existing.id),
						eq(automationEffects.leaseToken, existing.leaseToken),
						inArray(automationEffects.status, ["claimed", "in_flight"]),
					),
				);
		}
		return {
			state: "unknown",
			effectId: existing.id,
			reason:
				existing.lastError ??
				(existing.status === "in_flight" || existing.requestMayHaveBeenSentAt
					? "automation effect lease expired after its side-effect boundary"
					: "automation effect outcome is unknown"),
		};
	}
	if (recovery === "completed") {
		return { state: "replay", effect: existing };
	}
	if (recovery === "busy") return { state: "busy" };
	const [reclaimed] = await db
		.update(automationEffects)
		.set({
			leaseToken: sql`${automationEffects.leaseToken} + 1`,
			leaseExpiresAt: nodeExecutionLeaseExpirySql(),
			lastError: null,
			updatedAt: sql`CURRENT_TIMESTAMP`,
		})
		.where(
			and(
				eq(automationEffects.id, existing.id),
				eq(automationEffects.status, "claimed"),
				eq(automationEffects.leaseToken, existing.leaseToken),
				or(
					isNull(automationEffects.leaseExpiresAt),
					lte(automationEffects.leaseExpiresAt, now),
				),
			),
		)
		.returning();
	return reclaimed ? { state: "owned", effect: reclaimed } : { state: "busy" };
}

function storedExternalEffectValue(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as { version?: unknown; value?: unknown };
	return candidate.version === 1 ? candidate.value : null;
}

async function executeAutomationExternalEffect<T>(
	db: Db,
	execution: NodeExecutionRow,
	descriptor: AutomationExternalEffectDescriptor,
	operation: (
		providerIdempotencyKey: string,
	) => Promise<AutomationExternalEffectOutcome<T>>,
): Promise<T> {
	const claim = await claimExternalEffect(
		db,
		execution,
		descriptor,
		new Date(),
	);
	if (claim.state === "busy") throw new AutomationExternalEffectBusyError();
	if (claim.state === "unknown") {
		throw new AutomationExternalEffectUnknownError(
			claim.effectId,
			claim.reason,
		);
	}
	if (claim.state === "replay") {
		const value = storedExternalEffectValue(claim.effect.result) as T;
		if (claim.effect.status === "failed") {
			throw new Error(
				claim.effect.lastError ?? "automation external effect failed",
			);
		}
		return value;
	}

	const requestBoundary = new Date();
	const [armed] = await db
		.update(automationEffects)
		.set({
			status: "in_flight",
			attempts: sql`${automationEffects.attempts} + 1`,
			requestMayHaveBeenSentAt: requestBoundary,
			leaseExpiresAt: nodeExecutionLeaseExpirySql(),
			updatedAt: requestBoundary,
		})
		.where(
			and(
				eq(automationEffects.id, claim.effect.id),
				eq(automationEffects.status, "claimed"),
				eq(automationEffects.leaseToken, claim.effect.leaseToken),
			),
		)
		.returning({ id: automationEffects.id });
	if (!armed) throw new AutomationExternalEffectBusyError();

	let outcome: AutomationExternalEffectOutcome<T>;
	try {
		outcome = await operation(claim.effect.providerIdempotencyKey);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (error instanceof AutomationExternalEffectKnownFailureError) {
			const [failed] = await db
				.update(automationEffects)
				.set({
					status: "failed",
					leaseExpiresAt: null,
					result: { version: 1, value: null },
					lastError: reason,
					completedAt: sql`CURRENT_TIMESTAMP`,
					updatedAt: sql`CURRENT_TIMESTAMP`,
				})
				.where(
					and(
						eq(automationEffects.id, claim.effect.id),
						eq(automationEffects.status, "in_flight"),
						eq(automationEffects.leaseToken, claim.effect.leaseToken),
					),
				)
				.returning({ id: automationEffects.id });
			if (!failed) {
				throw new AutomationExternalEffectUnknownError(
					claim.effect.id,
					"known provider failure lost its local completion fence",
				);
			}
			throw new Error(reason);
		}
		await db
			.update(automationEffects)
			.set({
				status: "unknown",
				leaseExpiresAt: null,
				lastError: reason,
				completedAt: sql`CURRENT_TIMESTAMP`,
				updatedAt: sql`CURRENT_TIMESTAMP`,
			})
			.where(
				and(
					eq(automationEffects.id, claim.effect.id),
					eq(automationEffects.status, "in_flight"),
					eq(automationEffects.leaseToken, claim.effect.leaseToken),
				),
			);
		throw new AutomationExternalEffectUnknownError(claim.effect.id, reason);
	}

	const terminalStatus =
		outcome.outcome === "succeeded" ? "succeeded" : "failed";
	const [completed] = await db
		.update(automationEffects)
		.set({
			status: terminalStatus,
			leaseExpiresAt: null,
			providerReference:
				outcome.outcome === "succeeded"
					? (outcome.providerReference ?? null)
					: null,
			result: { version: 1, value: toJsonSafe(outcome.value) },
			lastError: outcome.outcome === "failed" ? outcome.error : null,
			completedAt: sql`CURRENT_TIMESTAMP`,
			updatedAt: sql`CURRENT_TIMESTAMP`,
		})
		.where(
			and(
				eq(automationEffects.id, claim.effect.id),
				eq(automationEffects.status, "in_flight"),
				eq(automationEffects.leaseToken, claim.effect.leaseToken),
			),
		)
		.returning({ id: automationEffects.id });
	if (!completed) {
		throw new AutomationExternalEffectUnknownError(
			claim.effect.id,
			"automation effect completed remotely but lost its local completion fence",
		);
	}
	if (outcome.outcome === "failed") throw new Error(outcome.error);
	return outcome.value;
}

async function claimNodeExecution(
	db: Db,
	run: AutomationRunRow,
	nodeKey: string,
): Promise<NodeExecutionClaim> {
	const now = new Date();
	let execution = await loadNodeExecution(db, run.id, run.revision);
	let ownsExecutionClaim = false;
	if (!execution) {
		const [inserted] = await db
			.insert(automationNodeExecutions)
			.values({
				runId: run.id,
				organizationId: run.organizationId,
				scopeKey: run.scopeKey,
				runRevision: run.revision,
				visitOrdinal: 0,
				nodeKey,
				status: "claimed",
				leaseToken: 1,
				leaseExpiresAt: nodeExecutionLeaseExpirySql(),
			})
			.onConflictDoNothing()
			.returning();
		execution = inserted ?? (await loadNodeExecution(db, run.id, run.revision));
		ownsExecutionClaim = Boolean(inserted);
		if (!execution) return { state: "busy" };
	}

	const providerIdempotencyKey = automationEffectIdempotencyKey(execution.id);
	if (execution.nodeKey !== nodeKey) {
		await markNodeExecutionUnknown(
			db,
			execution,
			"run revision resolved to two different automation nodes",
		);
		return {
			state: "unknown",
			execution,
			effectIdempotencyKey: providerIdempotencyKey,
			reason: "run revision resolved to two different automation nodes",
		};
	}

	const recovery = ownsExecutionClaim
		? "reclaim"
		: nodeExecutionRecoveryDisposition(execution, now);
	if (recovery === "completed") {
		const completion = storedNodeCompletion(execution.result);
		if (completion) {
			return {
				state: "replay",
				execution,
				effectIdempotencyKey: providerIdempotencyKey,
				completion,
			};
		}
		return {
			state: "unknown",
			execution,
			effectIdempotencyKey: providerIdempotencyKey,
			reason: "completed automation node has no replayable HandlerResult",
		};
	}
	if (recovery === "unknown") {
		const reason = "automation node outcome is unknown";
		if (execution.status !== "unknown") {
			const marked = await markNodeExecutionUnknown(
				db,
				execution,
				reason,
				true,
			);
			if (!marked) {
				return claimNodeExecution(db, run, nodeKey);
			}
		}
		return {
			state: "unknown",
			execution,
			effectIdempotencyKey: providerIdempotencyKey,
			reason,
		};
	}
	if (recovery === "busy") {
		return { state: "busy" };
	}

	if (!ownsExecutionClaim) {
		const [reclaimed] = await db
			.update(automationNodeExecutions)
			.set({
				leaseToken: sql`${automationNodeExecutions.leaseToken} + 1`,
				leaseExpiresAt: nodeExecutionLeaseExpirySql(),
				error: null,
				updatedAt: sql`CURRENT_TIMESTAMP`,
			})
			.where(
				and(
					eq(automationNodeExecutions.id, execution.id),
					eq(automationNodeExecutions.status, "claimed"),
					eq(automationNodeExecutions.leaseToken, execution.leaseToken),
					or(
						isNull(automationNodeExecutions.leaseExpiresAt),
						lte(automationNodeExecutions.leaseExpiresAt, now),
					),
				),
			)
			.returning();
		if (!reclaimed) return { state: "busy" };
		execution = reclaimed;
	}

	return {
		state: "owned",
		execution,
		effectIdempotencyKey: providerIdempotencyKey,
	};
}

async function armNodeExecution(
	db: Db,
	run: AutomationRunRow,
	nodeKey: string,
	claim: Extract<NodeExecutionClaim, { state: "owned" }>,
): Promise<boolean> {
	try {
		await db.transaction(async (tx) => {
			const [fencedRun] = await tx
				.select({ id: automationRuns.id })
				.from(automationRuns)
				.where(
					and(
						eq(automationRuns.id, run.id),
						eq(automationRuns.revision, run.revision),
						eq(automationRuns.status, "active"),
						eq(automationRuns.currentNodeKey, nodeKey),
					),
				)
				.limit(1)
				.for("update");
			if (!fencedRun) throw new LostNodeExecutionClaimError();

			const [armedExecution] = await tx
				.update(automationNodeExecutions)
				.set({
					attempts: sql`${automationNodeExecutions.attempts} + 1`,
					leaseExpiresAt: nodeExecutionLeaseExpirySql(),
					updatedAt: sql`CURRENT_TIMESTAMP`,
				})
				.where(
					and(
						eq(automationNodeExecutions.id, claim.execution.id),
						eq(automationNodeExecutions.status, "claimed"),
						eq(automationNodeExecutions.leaseToken, claim.execution.leaseToken),
					),
				)
				.returning({ id: automationNodeExecutions.id });
			if (!armedExecution) throw new LostNodeExecutionClaimError();
		});
		return true;
	} catch (error) {
		if (error instanceof LostNodeExecutionClaimError) return false;
		throw error;
	}
}

type StepRunValues = Omit<
	typeof automationStepRuns.$inferInsert,
	"id" | "executedAt"
>;

async function persistNodeCompletion(
	db: Db,
	claim: Extract<NodeExecutionClaim, { state: "owned" }>,
	result: HandlerResult,
	context: Record<string, unknown>,
	durationMs: number,
	step: StepRunValues,
): Promise<boolean> {
	const safeContext = toJsonSafe(context);
	const completion: StoredNodeCompletion = {
		version: 1,
		handlerResult: serializeAutomationHandlerResult(result),
		context:
			safeContext &&
			typeof safeContext === "object" &&
			!Array.isArray(safeContext)
				? (safeContext as Record<string, unknown>)
				: {},
		durationMs,
	};
	const terminalStatus = result.result === "fail" ? "failed" : "succeeded";
	const errorPayload =
		result.result === "fail"
			? { message: result.error.message, stack: result.error.stack }
			: null;
	try {
		await db.transaction(async (tx) => {
			const [completedExecution] = await tx
				.update(automationNodeExecutions)
				.set({
					status: terminalStatus,
					leaseExpiresAt: null,
					result: completion,
					error: errorPayload,
					completedAt: sql`CURRENT_TIMESTAMP`,
					updatedAt: sql`CURRENT_TIMESTAMP`,
				})
				.where(
					and(
						eq(automationNodeExecutions.id, claim.execution.id),
						eq(automationNodeExecutions.status, "claimed"),
						eq(automationNodeExecutions.leaseToken, claim.execution.leaseToken),
					),
				)
				.returning({ id: automationNodeExecutions.id });
			if (!completedExecution) throw new LostNodeExecutionClaimError();
			await tx.insert(automationStepRuns).values({
				...step,
				executedAt: sql`CURRENT_TIMESTAMP`,
				payload: step.payload == null ? null : toJsonSafe(step.payload),
				error: step.error == null ? null : toJsonSafe(step.error),
			});
		});
		return true;
	} catch (error) {
		if (error instanceof LostNodeExecutionClaimError) return false;
		throw error;
	}
}

export type Db = Database;

export type RunLoopOptions = {
	/**
	 * Override the infinite-loop guard (default 200). Tests use a lower value
	 * to exercise the cap without making 200+ DB round-trips.
	 */
	maxVisits?: number;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runLoop(
	db: Db,
	runId: string,
	env: Record<string, unknown>,
	options: RunLoopOptions = {},
): Promise<{ status: RunStatus; exit_reason: string | null }> {
	const maxVisits = options.maxVisits ?? MAX_VISITS_PER_LOOP;
	let visits = 0;

	while (visits < maxVisits) {
		visits += 1;

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		if (!run) {
			return { status: "failed", exit_reason: "run_not_found" };
		}
		if (
			run.status === "completed" ||
			run.status === "exited" ||
			run.status === "failed"
		) {
			return { status: run.status as RunStatus, exit_reason: run.exitReason };
		}
		// Resume paths must first CAS a waiting run back to active (and, for delay
		// or input, advance it through the waiting node). A stray/duplicate job
		// must not redispatch the parked node under a fresh revision.
		if (run.status === "waiting") {
			return { status: "waiting", exit_reason: run.exitReason };
		}

		// 1+2. Pause check and graph load both depend only on immutable run
		// fields (organizationId, contactId, automationId), so issue them in
		// parallel to shave one DB round trip per node visited. Semantics are
		// unchanged: the pause result is still applied before the graph is used.
		const [paused, auto] = await Promise.all([
			findActivePause(db, run.organizationId, run.contactId, run.automationId),
			db.query.automations.findFirst({
				where: and(
					eq(automations.id, run.automationId),
					eq(automations.organizationId, run.organizationId),
				),
			}),
		]);
		if (paused) {
			const ok = await updateRunOptimistic(db, run.id, run.revision, {
				status: "waiting",
				waitingFor: "external_event",
				waitingUntil: null,
			});
			if (!ok) return { status: "waiting", exit_reason: null };
			// Close the unpause-before-park window: the control may have been
			// deleted after findActivePause() but before the waiting write.
			if (
				!(await findActivePause(
					db,
					run.organizationId,
					run.contactId,
					run.automationId,
				))
			) {
				const parked = await db.query.automationRuns.findFirst({
					where: eq(automationRuns.id, run.id),
				});
				if (
					parked?.status === "waiting" &&
					parked.waitingFor === "external_event" &&
					(await updateRunOptimistic(db, parked.id, parked.revision, {
						status: "active",
						waitingFor: null,
						waitingUntil: null,
					}))
				) {
					continue;
				}
			}
			return { status: "waiting", exit_reason: null };
		}

		// Load graph fresh on every iteration so edits take effect immediately.
		if (!auto) {
			const exited = await transitionRunTerminal(
				db,
				run.id,
				run.revision,
				run.automationId,
				"exited",
				"automation_deleted",
			);
			if (exited) {
				return { status: "exited", exit_reason: "automation_deleted" };
			}
			return { status: "active", exit_reason: null };
		}
		const graph = (auto.graph ?? {
			schema_version: 1,
			root_node_key: null,
			nodes: [],
			edges: [],
		}) as Graph;

		// 3. Locate current node.
		const currentKey = run.currentNodeKey;
		if (!currentKey) {
			const completed = await transitionRunTerminal(
				db,
				run.id,
				run.revision,
				run.automationId,
				"completed",
				"completed",
			);
			if (!completed) return { status: "active", exit_reason: null };
			return { status: "completed", exit_reason: "completed" };
		}
		const node = graph.nodes.find((n) => n.key === currentKey);
		if (!node) {
			await writeStepRun(db, {
				runId: run.id,
				automationId: run.automationId,
				organizationId: run.organizationId,
				scopeKey: run.scopeKey,
				nodeKey: currentKey,
				nodeKind: "unknown",
				enteredViaPortKey: run.currentPortKey,
				exitedViaPortKey: null,
				outcome: "graph_changed",
				durationMs: 0,
				payload: { reason: "current_node_missing" },
				error: null,
			});
			const exited = await transitionRunTerminal(
				db,
				run.id,
				run.revision,
				run.automationId,
				"exited",
				"graph_changed",
			);
			if (exited) {
				return { status: "exited", exit_reason: "graph_changed" };
			}
			return { status: "active", exit_reason: null };
		}

		// 4. Claim this exact run-revision/node visit before dispatching a handler.
		// The unique (run_id, run_revision, visit_ordinal) ledger row is the
		// pure-orchestration fence. Actual provider effects claim component rows.
		const executionClaim = await claimNodeExecution(db, run, node.key);
		if (executionClaim.state === "busy") {
			return { status: "active", exit_reason: null };
		}
		if (executionClaim.state === "unknown") {
			const manualContext = {
				...((run.context as Record<string, unknown>) ?? {}),
				_automation_manual_reconciliation: {
					node_execution_id: executionClaim.execution.id,
					node_key: node.key,
					effect_idempotency_key: executionClaim.effectIdempotencyKey,
					reason: executionClaim.reason,
					detected_at: new Date().toISOString(),
				},
			};
			const failed = await transitionRunTerminal(
				db,
				run.id,
				run.revision,
				run.automationId,
				"failed",
				"node_effect_unknown",
				{ context: manualContext },
			);
			if (failed) {
				return { status: "failed", exit_reason: "node_effect_unknown" };
			}
			return { status: "active", exit_reason: null };
		}

		// Reconstruct env.socialAccountId from the persisted trigger when a
		// resume-path caller (scheduler, input-resume, interactive-resume)
		// didn't pass it through env. Without this, a run that started
		// under account A but then waits through an `input` node would
		// resume with no account pinned and `resolveRecipient` would pick
		// up the newest contact_channels row — potentially account B in a
		// multi-account workspace.
		const runCtxObj =
			executionClaim.state === "replay"
				? executionClaim.completion.context
				: ((run.context as Record<string, unknown>) ?? {});
		const persistedAccountId = runCtxObj._triggering_social_account_id as
			| string
			| null
			| undefined;
		const effectiveEnv: Record<string, unknown> = { db, ...env };
		if (effectiveEnv.socialAccountId == null && persistedAccountId) {
			effectiveEnv.socialAccountId = persistedAccountId;
		}
		const effectIdempotencyKey = executionClaim.effectIdempotencyKey;
		effectiveEnv.automationEffectIdempotencyKey = effectIdempotencyKey;
		effectiveEnv.effectIdempotencyKey = effectIdempotencyKey;
		const ctx: RunContext = {
			runId: run.id,
			automationId: run.automationId,
			organizationId: run.organizationId,
			workspaceId: auto.workspaceId,
			contactId: run.contactId,
			conversationId: run.conversationId,
			channel: auto.channel,
			graph,
			context: runCtxObj,
			now: new Date(),
			db,
			effectIdempotencyKey,
			effectIdempotencyKeyFor: (component) =>
				`${effectIdempotencyKey}:${encodeURIComponent(component)}`,
			executeExternalEffect:
				executionClaim.state === "owned"
					? (descriptor, operation) =>
							executeAutomationExternalEffect(
								db,
								executionClaim.execution,
								descriptor,
								operation,
							)
					: undefined,
			// Mirror the db handle into env as a convenience for legacy callers
			// that still read `env.db`, but ctx.db is the canonical source now.
			env: effectiveEnv,
		};
		let result: HandlerResult;
		let durationMs: number;
		if (executionClaim.state === "replay") {
			result = deserializeAutomationHandlerResult(
				executionClaim.completion.handlerResult,
			);
			durationMs = executionClaim.completion.durationMs;
		} else {
			if (!(await armNodeExecution(db, run, node.key, executionClaim))) {
				return { status: "active", exit_reason: null };
			}
			const handler = getHandler(node.kind);
			const startedAt = Date.now();
			if (!handler) {
				result = {
					result: "fail",
					error: new Error(`no handler registered for kind "${node.kind}"`),
				};
			} else {
				try {
					result = await handler.handle(
						{ key: node.key, kind: node.kind, config: node.config },
						ctx,
					);
				} catch (err) {
					if (err instanceof AutomationExternalEffectBusyError) {
						return { status: "active", exit_reason: null };
					}
					if (err instanceof AutomationExternalEffectUnknownError) {
						await markNodeExecutionUnknown(
							db,
							executionClaim.execution,
							err.message,
						);
						const manualContext = {
							...ctx.context,
							_automation_manual_reconciliation: {
								node_execution_id: executionClaim.execution.id,
								effect_id: err.effectId,
								node_key: node.key,
								reason: err.message,
								detected_at: new Date().toISOString(),
							},
						};
						const failed = await transitionRunTerminal(
							db,
							run.id,
							run.revision,
							run.automationId,
							"failed",
							"node_effect_unknown",
							{ context: manualContext },
						);
						return failed
							? { status: "failed", exit_reason: "node_effect_unknown" }
							: { status: "active", exit_reason: null };
					}
					result = {
						result: "fail",
						error: err instanceof Error ? err : new Error(String(err)),
					};
				}
			}
			durationMs = Date.now() - startedAt;
			const persisted = await persistNodeCompletion(
				db,
				executionClaim,
				result,
				ctx.context,
				durationMs,
				{
					runId: run.id,
					automationId: run.automationId,
					organizationId: run.organizationId,
					scopeKey: run.scopeKey,
					nodeKey: node.key,
					nodeKind: isAutomationNodeKind(node.kind) ? node.kind : "unknown",
					enteredViaPortKey: run.currentPortKey,
					exitedViaPortKey:
						result.result === "advance" ? result.via_port : null,
					outcome: stepOutcomeFromResult(result),
					durationMs,
					payload: result.result === "fail" ? null : (result.payload ?? null),
					error:
						result.result === "fail"
							? {
									message: result.error.message,
									stack: result.error.stack,
								}
							: null,
				},
			);
			if (!persisted) return { status: "active", exit_reason: null };
		}

		// 5. Apply the persisted/replayed HandlerResult with the same run revision
		// CAS that identified the node execution. Exactly one replay can advance.
		if (result.result === "end") {
			const ok = await transitionRunTerminal(
				db,
				run.id,
				run.revision,
				run.automationId,
				"completed",
				result.exit_reason,
				{ context: ctx.context },
			);
			if (!ok) return { status: "active", exit_reason: null };
			return { status: "completed", exit_reason: result.exit_reason };
		}

		if (result.result === "fail") {
			// Try the `error` output port if there's an edge from it.
			const errorEdge = graph.edges.find(
				(e) => e.from_node === node.key && e.from_port === "error",
			);
			if (errorEdge) {
				const ok = await updateRunOptimistic(db, run.id, run.revision, {
					currentNodeKey: errorEdge.to_node,
					currentPortKey: errorEdge.to_port,
					context: ctx.context,
				});
				if (!ok) return { status: "active", exit_reason: null };
				continue;
			}
			const ok = await transitionRunTerminal(
				db,
				run.id,
				run.revision,
				run.automationId,
				"failed",
				"handler_failure",
				{ context: ctx.context },
			);
			if (!ok) return { status: "active", exit_reason: null };
			return { status: "failed", exit_reason: "handler_failure" };
		}

		if (result.result === "wait_input") {
			const ok = await db.transaction(async (tx) => {
				const updated = await updateRunOptimistic(tx, run.id, run.revision, {
					status: "waiting",
					waitingFor: "input",
					waitingUntil: result.timeout_at ?? null,
					context: ctx.context,
				});
				if (!updated) return false;
				if (result.timeout_at) {
					// Stamp the node key that armed this timeout into the job payload so
					// the scheduler can reject a stale job after a later wait.
					const timeoutPayload = {
						...((result.payload as Record<string, unknown> | null) ?? {}),
						_timeout_node_key: node.key,
					};
					await tx
						.insert(automationScheduledJobs)
						.values({
							occurrenceId: `node-execution:${executionClaim.execution.id}:input-timeout`,
							organizationId: run.organizationId,
							scopeKey: run.scopeKey,
							runId: run.id,
							jobType: "input_timeout",
							automationId: run.automationId,
							runAt: result.timeout_at,
							payload: timeoutPayload,
						})
						.onConflictDoNothing();
				}
				return true;
			});
			if (!ok) return { status: "active", exit_reason: null };
			return { status: "waiting", exit_reason: null };
		}

		if (result.result === "wait_delay") {
			const ok = await db.transaction(async (tx) => {
				const updated = await updateRunOptimistic(tx, run.id, run.revision, {
					status: "waiting",
					waitingFor: "delay",
					waitingUntil: result.resume_at,
					context: ctx.context,
				});
				if (!updated) return false;
				await tx
					.insert(automationScheduledJobs)
					.values({
						occurrenceId: `node-execution:${executionClaim.execution.id}:resume`,
						organizationId: run.organizationId,
						scopeKey: run.scopeKey,
						runId: run.id,
						jobType: "resume_run",
						automationId: run.automationId,
						runAt: result.resume_at,
						payload: result.payload ?? null,
					})
					.onConflictDoNothing();
				return true;
			});
			if (!ok) return { status: "active", exit_reason: null };
			return { status: "waiting", exit_reason: null };
		}

		if (result.result === "wait_event") {
			const ok = await db.transaction(async (tx) => {
				const updated = await updateRunOptimistic(tx, run.id, run.revision, {
					status: "waiting",
					waitingFor: "inbound_event",
					waitingUntil: result.timeout_at ?? null,
					context: {
						...ctx.context,
						_wait_event_kinds: result.event_kinds,
					},
				});
				if (!updated) return false;
				if (result.timeout_at) {
					await tx
						.insert(automationScheduledJobs)
						.values({
							occurrenceId: `node-execution:${executionClaim.execution.id}:event-timeout`,
							organizationId: run.organizationId,
							scopeKey: run.scopeKey,
							runId: run.id,
							jobType: "event_timeout",
							automationId: run.automationId,
							runAt: result.timeout_at,
							payload: {
								...((result.payload as Record<string, unknown> | null) ?? {}),
								_timeout_node_key: node.key,
							},
						})
						.onConflictDoNothing();
				}
				return true;
			});
			if (!ok) return { status: "active", exit_reason: null };
			return { status: "waiting", exit_reason: null };
		}

		// result.result === "advance"
		// Special _goto signal: jump straight to target_node_key, no edge lookup.
		if (result.via_port === "_goto") {
			const target = (result.payload as { target_node_key?: string } | null)
				?.target_node_key;
			if (!target) {
				const failed = await transitionRunTerminal(
					db,
					run.id,
					run.revision,
					run.automationId,
					"failed",
					"goto_missing_target",
				);
				if (!failed) return { status: "active", exit_reason: null };
				return { status: "failed", exit_reason: "goto_missing_target" };
			}
			const ok = await updateRunOptimistic(db, run.id, run.revision, {
				currentNodeKey: target,
				currentPortKey: null,
				context: ctx.context,
			});
			if (!ok) return { status: "active", exit_reason: null };
			continue;
		}

		const edge = findOutgoingEdge(graph, node.key, result.via_port);
		if (!edge) {
			// No outgoing edge → treat as graceful completion (operator choice).
			const ok = await transitionRunTerminal(
				db,
				run.id,
				run.revision,
				run.automationId,
				"completed",
				"completed",
				{ context: ctx.context },
			);
			if (!ok) return { status: "active", exit_reason: null };
			return { status: "completed", exit_reason: "completed" };
		}

		const ok = await updateRunOptimistic(db, run.id, run.revision, {
			currentNodeKey: edge.to_node,
			currentPortKey: edge.to_port,
			context: ctx.context,
		});
		if (!ok) return { status: "active", exit_reason: null };
		// loop
	}

	// Infinite-loop cap.
	const runAtCap = await db.query.automationRuns.findFirst({
		where: eq(automationRuns.id, runId),
	});
	if (runAtCap) {
		await transitionRunTerminal(
			db,
			runId,
			runAtCap.revision,
			runAtCap.automationId,
			"failed",
			"infinite_loop_cap",
		);
	}
	return { status: "failed", exit_reason: "infinite_loop_cap" };
}

export function automationDeferredEnrollmentOccurrenceId(
	runId: string,
): string {
	return `initial-run:${runId}`;
}

async function stageDeferredEnrollment(
	db: Pick<Db, "insert">,
	run: typeof automationRuns.$inferSelect,
): Promise<void> {
	await db
		.insert(automationScheduledJobs)
		.values({
			occurrenceId: automationDeferredEnrollmentOccurrenceId(run.id),
			organizationId: run.organizationId,
			scopeKey: run.scopeKey,
			runId: run.id,
			automationId: run.automationId,
			jobType: "resume_run",
			runAt: new Date(),
			payload: { source: "deferred_enrollment" },
		})
		.onConflictDoNothing({ target: automationScheduledJobs.occurrenceId });
}

export async function enrollContact(
	db: Db,
	args: {
		automationId: string;
		organizationId: string;
		contactId: string;
		conversationId: string | null;
		channel: string;
		entrypointId: string | null;
		bindingId: string | null;
		/**
		 * Triggering social account. When set, the runner pins all outbound
		 * sends for this run to this account — critical for multi-account
		 * workspaces where `contact_channels` can return the wrong row for
		 * a contact who reached us through account A but also exists under
		 * account B on the same channel.
		 *
		 * Persisted on `automation_runs.context._triggering_social_account_id`
		 * so resume paths (scheduler, input-resume, interactive-resume) can
		 * reconstruct `env.socialAccountId` even when the runLoop caller
		 * forgot to pass it through env.
		 */
		socialAccountId?: string | null;
		/** Stable source occurrence used to resume instead of duplicating a run. */
		triggerOccurrenceId?: string | null;
		contextOverrides?: Record<string, unknown>;
		env: Record<string, unknown>;
		runLoopOptions?: RunLoopOptions;
		/**
		 * Persist an immediate resume job instead of walking the graph inline.
		 * Used by durable HTTP receipts so a short acceptance lease never spans a
		 * potentially long automation graph.
		 */
		deferRun?: boolean;
		/**
		 * Contact state already loaded by the caller (e.g. the trigger matcher
		 * loads the contact row + custom fields to evaluate entrypoint filters).
		 * When supplied, buildInitialRunContext skips its two queries and reuses
		 * this, saving ~2 redundant DB round trips per enrollment.
		 */
		prehydrated?: {
			contact: Record<string, unknown> | null;
			tags: string[];
			fields: Record<string, string>;
		};
		/** Authoritative admission policy, rechecked under a DB advisory lock. */
		admission?: {
			allowReentry: boolean;
			reentryCooldownMin: number;
			dailyCap: number | null;
		};
		/**
		 * Optional caller authority fence executed inside the exact admission
		 * transaction, before the automation row is locked. API callers use this
		 * to linearize credential/session revocation with run creation without
		 * holding those authority rows across the later runLoop/provider work.
		 */
		admissionAuthority?: (
			tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
		) => Promise<void>;
		/**
		 * Request-local accounting observers. Preflight completion means every
		 * remaining failure crosses the admission transaction boundary; admission
		 * commitment means the durable run exists even if inline execution fails.
		 */
		onPreflightComplete?: () => void;
		onAdmissionCommitted?: (runId: string) => void;
	},
): Promise<{ runId: string }> {
	const auto = await db.query.automations.findFirst({
		where: and(
			eq(automations.id, args.automationId),
			eq(automations.organizationId, args.organizationId),
		),
	});
	if (!auto) throw new Error(`automation ${args.automationId} not found`);
	if (auto.channel !== args.channel) {
		throw new Error("enrollment channel does not match automation channel");
	}

	// Every related id must resolve inside the same tenant. Opaque ids are not
	// authorization: without these predicates a caller could hydrate a foreign
	// contact or send through another organization's connected account.
	const [contact, entrypoint, binding, account, conversation] =
		await Promise.all([
			db.query.contacts.findFirst({
				where: and(
					eq(contacts.id, args.contactId),
					eq(contacts.organizationId, args.organizationId),
					auto.workspaceId
						? eq(contacts.workspaceId, auto.workspaceId)
						: isNull(contacts.workspaceId),
				),
			}),
			args.entrypointId
				? db.query.automationEntrypoints.findFirst({
						where: and(
							eq(automationEntrypoints.id, args.entrypointId),
							eq(automationEntrypoints.automationId, auto.id),
						),
					})
				: Promise.resolve(null),
			args.bindingId
				? db.query.automationBindings.findFirst({
						where: and(
							eq(automationBindings.id, args.bindingId),
							eq(automationBindings.organizationId, args.organizationId),
							eq(automationBindings.automationId, auto.id),
						),
					})
				: Promise.resolve(null),
			args.socialAccountId
				? db.query.socialAccounts.findFirst({
						where: and(
							eq(socialAccounts.id, args.socialAccountId),
							eq(socialAccounts.organizationId, args.organizationId),
							eq(socialAccounts.lifecycleStatus, "active"),
							eq(socialAccounts.platform, auto.channel),
							auto.workspaceId
								? eq(socialAccounts.workspaceId, auto.workspaceId)
								: isNull(socialAccounts.workspaceId),
						),
					})
				: Promise.resolve(null),
			args.conversationId
				? db.query.inboxConversations.findFirst({
						where: and(
							eq(inboxConversations.id, args.conversationId),
							eq(inboxConversations.organizationId, args.organizationId),
							eq(inboxConversations.contactId, args.contactId),
							eq(inboxConversations.platform, auto.channel),
							args.socialAccountId
								? eq(inboxConversations.accountId, args.socialAccountId)
								: undefined,
							auto.workspaceId
								? eq(inboxConversations.workspaceId, auto.workspaceId)
								: isNull(inboxConversations.workspaceId),
						),
					})
				: Promise.resolve(null),
		]);
	if (!contact) throw new Error("contact does not belong to automation tenant");
	if (args.entrypointId && !entrypoint)
		throw new Error("entrypoint does not belong to automation");
	if (args.bindingId && !binding)
		throw new Error("binding does not belong to automation tenant");
	if (args.socialAccountId && !account)
		throw new Error("social account does not belong to automation tenant");
	if (args.conversationId && !conversation)
		throw new Error("conversation does not belong to automation tenant");
	// Hydrate the run context with the contact row, inline tags, and keyed
	// custom fields before inserting. Merge-tag resolution and condition
	// predicates that read `{{contact.*}}` / tags / fields depend on this.
	const hydrated = await buildInitialRunContext(
		db,
		args.contactId,
		args.organizationId,
		args.contextOverrides ?? {},
		typeof args.env.ENCRYPTION_KEY === "string"
			? args.env.ENCRYPTION_KEY
			: (() => {
					throw new Error("ENCRYPTION_KEY is required");
				})(),
		args.prehydrated,
	);
	const initialContext = {
		...hydrated,
		// Persist the triggering social account on context so later
		// resume paths can rebuild env.socialAccountId even when the
		// caller of runLoop didn't pass it through. This is a reserved runtime
		// key: never trust context_overrides (manual API input or webhook payload
		// mappings) to replace the account that was validated above.
		_triggering_social_account_id: args.socialAccountId ?? null,
	};

	args.onPreflightComplete?.();
	let admissionResult: {
		row: typeof automationRuns.$inferSelect;
		created: boolean;
	};
	try {
		admissionResult = await db.transaction(async (tx) => {
			// Serialize admission for one contact+automation pair. Unlike a row lock,
			// this also protects the first-ever enrollment where no run row exists yet.
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${args.organizationId}:${args.automationId}:${args.contactId}`}, 0))`,
			);
			await args.admissionAuthority?.(tx);

			if (args.triggerOccurrenceId) {
				const [existingOccurrence] = await tx
					.select()
					.from(automationRuns)
					.where(
						and(
							eq(automationRuns.automationId, args.automationId),
							eq(automationRuns.triggerOccurrenceId, args.triggerOccurrenceId),
						),
					)
					.limit(1);
				if (existingOccurrence) {
					if (args.deferRun) {
						await stageDeferredEnrollment(tx, existingOccurrence);
					}
					return { row: existingOccurrence, created: false };
				}
			}

			// A status check performed before admission can be held open while the
			// automation is paused or its graph is replaced. Lock and re-read the
			// authoritative row at the run-creation boundary, then start at the root
			// of that exact graph snapshot. FOR UPDATE also serializes totalEnrolled.
			const [admissionAutomation] = await tx
				.select({
					id: automations.id,
					channel: automations.channel,
					status: automations.status,
					graph: automations.graph,
				})
				.from(automations)
				.where(
					and(
						eq(automations.id, args.automationId),
						eq(automations.organizationId, args.organizationId),
					),
				)
				.for("update")
				.limit(1);
			if (!admissionAutomation) {
				throw new Error(`automation ${args.automationId} not found`);
			}
			if (admissionAutomation.channel !== args.channel) {
				throw new Error("enrollment channel does not match automation channel");
			}
			if (admissionAutomation.status !== "active") {
				throw new EnrollmentBlockedError("automation_inactive");
			}
			const admissionGraph = (admissionAutomation.graph ?? {
				schema_version: 1,
				root_node_key: null,
				nodes: [],
				edges: [],
			}) as Graph;

			if (args.admission) {
				const priorRuns = await tx
					.select({
						status: automationRuns.status,
						completedAt: automationRuns.completedAt,
					})
					.from(automationRuns)
					.where(
						and(
							eq(automationRuns.automationId, args.automationId),
							eq(automationRuns.contactId, args.contactId),
						),
					);
				if (
					priorRuns.some(
						(run) => run.status === "active" || run.status === "waiting",
					)
				) {
					throw new EnrollmentBlockedError("active_run");
				}
				if (!args.admission.allowReentry && priorRuns.length > 0) {
					throw new EnrollmentBlockedError("reentry_disabled");
				}
				if (
					args.admission.allowReentry &&
					args.admission.reentryCooldownMin > 0
				) {
					const cutoff =
						Date.now() - args.admission.reentryCooldownMin * 60_000;
					if (
						priorRuns.some(
							(run) => run.completedAt && run.completedAt.getTime() >= cutoff,
						)
					) {
						throw new EnrollmentBlockedError("reentry_cooldown");
					}
				}
				if (args.admission.dailyCap && args.entrypointId) {
					const day = new Date().toISOString().slice(0, 10);
					const incremented = await tx
						.insert(automationEntrypointDailyCounts)
						.values({
							organizationId: args.organizationId,
							entrypointId: args.entrypointId,
							day,
							count: 1,
						})
						.onConflictDoUpdate({
							target: [
								automationEntrypointDailyCounts.entrypointId,
								automationEntrypointDailyCounts.day,
							],
							set: {
								count: sql`${automationEntrypointDailyCounts.count} + 1`,
								updatedAt: sql`CURRENT_TIMESTAMP`,
							},
							setWhere: sql`${automationEntrypointDailyCounts.count} < ${args.admission.dailyCap}`,
						})
						.returning({ id: automationEntrypointDailyCounts.id });
					if (incremented.length === 0) {
						throw new EnrollmentBlockedError("daily_cap");
					}
				}
			}

			const [inserted] = await tx
				.insert(automationRuns)
				.values({
					automationId: args.automationId,
					organizationId: args.organizationId,
					entrypointId: args.entrypointId,
					bindingId: args.bindingId,
					contactId: args.contactId,
					conversationId: args.conversationId,
					triggerOccurrenceId: args.triggerOccurrenceId ?? null,
					status: "active",
					currentNodeKey: admissionGraph.root_node_key,
					currentPortKey: null,
					context: initialContext,
				})
				.onConflictDoNothing({
					target: [
						automationRuns.automationId,
						automationRuns.triggerOccurrenceId,
					],
				})
				.returning();
			if (!inserted && args.triggerOccurrenceId) {
				// A duplicate for another contact uses a different admission lock. Throw
				// so the transaction rolls back any daily-cap increment before resolving
				// the winning run outside the transaction.
				throw new TriggerOccurrenceConflictError();
			}
			if (!inserted) throw new Error("failed to create automation run");
			await tx
				.update(automations)
				.set({ totalEnrolled: sql`${automations.totalEnrolled} + 1` })
				.where(eq(automations.id, args.automationId));
			if (args.deferRun) {
				await stageDeferredEnrollment(tx, inserted);
			}
			return { row: inserted, created: true };
		});
	} catch (error) {
		if (
			!(error instanceof TriggerOccurrenceConflictError) ||
			!args.triggerOccurrenceId
		) {
			throw error;
		}
		const existingOccurrence = await db.query.automationRuns.findFirst({
			where: and(
				eq(automationRuns.automationId, args.automationId),
				eq(automationRuns.triggerOccurrenceId, args.triggerOccurrenceId),
			),
		});
		if (!existingOccurrence) throw error;
		if (args.deferRun) {
			await stageDeferredEnrollment(db, existingOccurrence);
		}
		admissionResult = { row: existingOccurrence, created: false };
	}
	const inserted = admissionResult.row;
	args.onAdmissionCommitted?.(inserted.id);

	// Ensure downstream handlers invoked from runLoop can still find `db` on
	// ctx.env if they haven't been migrated yet — but the canonical source is
	// ctx.db, which runLoop populates directly. Pin socialAccountId on env
	// so `resolveRecipient` scopes `contact_channels` to the account that
	// actually triggered this run.
	const envForRun: Record<string, unknown> = { db, ...args.env };
	if (args.socialAccountId && envForRun.socialAccountId == null) {
		envForRun.socialAccountId = args.socialAccountId;
	}
	if (args.deferRun) {
		return { runId: inserted.id };
	}
	await runLoop(db, inserted.id, envForRun, args.runLoopOptions);
	return { runId: inserted.id };
}

/**
 * Wakes runs that runLoop parked on a contact pause. When a run hits an active
 * pause (automation_contact_controls), runLoop sets status='waiting',
 * waitingFor='external_event' and returns without scheduling any resume job.
 * Nothing else wakes those runs — so when the pause is lifted (the
 * resume_automations_for_contact action or the contact-automation-resume route
 * deletes the control row), the caller must call this to re-activate and
 * re-enter the parked runs. Otherwise the run stays wedged forever and, because
 * of the partial unique index on active/waiting runs, the contact can never
 * re-enroll in that automation again.
 *
 * Scope: when `automationId` is provided, only runs for that automation are
 * resumed (matching a "current"-scope unpause); when null, all of the contact's
 * external_event-parked runs are resumed (a "global"-scope unpause).
 *
 * Best-effort: a per-run failure is swallowed so one bad run can't block the
 * rest. Returns the number of runs that were re-entered.
 */
export async function resumeExternalEventRuns(
	db: Db,
	args: {
		organizationId: string;
		contactId: string;
		automationId: string | null;
		env: Record<string, unknown>;
	},
): Promise<{ activated: number; resumed: number }> {
	const parked = await db
		.select({
			id: automationRuns.id,
			automationId: automationRuns.automationId,
		})
		.from(automationRuns)
		.where(
			and(
				eq(automationRuns.organizationId, args.organizationId),
				eq(automationRuns.contactId, args.contactId),
				eq(automationRuns.status, "waiting"),
				eq(automationRuns.waitingFor, "external_event"),
				args.automationId
					? eq(automationRuns.automationId, args.automationId)
					: undefined,
			),
		);

	let resumed = 0;
	let activated = 0;
	for (const row of parked) {
		try {
			// Re-read the run for its current revision, flip it back to active
			// (guarded), then re-enter runLoop. runLoop re-checks the pause on its
			// first iteration, so if another pause is still active the run simply
			// re-parks — no harm.
			const fresh = await db.query.automationRuns.findFirst({
				where: eq(automationRuns.id, row.id),
			});
			if (
				fresh?.status !== "waiting" ||
				fresh.waitingFor !== "external_event"
			) {
				continue;
			}
			const ok = await updateRunOptimistic(db, fresh.id, fresh.revision, {
				status: "active",
				waitingFor: null,
				waitingUntil: null,
			});
			if (!ok) continue;
			activated += 1;
			await runLoop(db, fresh.id, { db, ...args.env });
			resumed += 1;
		} catch (err) {
			console.error(
				`[automation runner] failed to resume external_event run ${row.id}:`,
				err,
			);
		}
	}
	return { activated, resumed };
}

/**
 * Bounded safety net for hard termination during an unpause. The hot run loop
 * closes the race synchronously; this reconciler covers interruption between
 * the control update and the corresponding run resume.
 */
export async function reconcileExternalEventWaits(
	db: Db,
	_env: Record<string, unknown>,
	limit = 100,
): Promise<{ scanned: number; resumed: number }> {
	const now = new Date();
	const activePause = db
		.select({ id: automationContactControls.id })
		.from(automationContactControls)
		.where(
			and(
				eq(
					automationContactControls.organizationId,
					automationRuns.organizationId,
				),
				eq(automationContactControls.contactId, automationRuns.contactId),
				or(
					eq(
						automationContactControls.automationId,
						automationRuns.automationId,
					),
					isNull(automationContactControls.automationId),
				),
				or(
					isNull(automationContactControls.pausedUntil),
					gt(automationContactControls.pausedUntil, now),
				),
			),
		);
	const parked = await db
		.select({
			id: automationRuns.id,
			organizationId: automationRuns.organizationId,
			scopeKey: automationRuns.scopeKey,
			contactId: automationRuns.contactId,
			automationId: automationRuns.automationId,
		})
		.from(automationRuns)
		.where(
			and(
				eq(automationRuns.status, "waiting"),
				eq(automationRuns.waitingFor, "external_event"),
				notExists(activePause),
			),
		)
		.orderBy(asc(automationRuns.updatedAt), asc(automationRuns.id))
		.limit(Math.max(1, Math.min(limit, 500)));

	let resumed = 0;
	for (const row of parked) {
		if (
			await findActivePause(
				db,
				row.organizationId,
				row.contactId,
				row.automationId,
			)
		) {
			continue;
		}
		const fresh = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, row.id),
		});
		if (fresh?.status !== "waiting" || fresh.waitingFor !== "external_event") {
			continue;
		}
		// Commit the wake-up and its resume job together. The scheduler bounds graph
		// execution separately, so this reconciler remains a cheap DB sweep instead
		// of walking as many as 100 automation graphs inside one cron invocation.
		const claimed = await db.transaction(async (tx) => {
			const updated = await updateRunOptimistic(tx, fresh.id, fresh.revision, {
				status: "active",
				waitingFor: null,
				waitingUntil: null,
			});
			if (!updated) return false;
			await tx
				.insert(automationScheduledJobs)
				.values({
					occurrenceId: `external-event-reconcile:${fresh.id}:revision:${fresh.revision}`,
					organizationId: fresh.organizationId,
					scopeKey: fresh.scopeKey,
					runId: fresh.id,
					automationId: fresh.automationId,
					jobType: "resume_run",
					runAt: new Date(),
					payload: { source: "external_event_reconciler" },
				})
				.onConflictDoNothing();
			return true;
		});
		if (!claimed) continue;
		resumed += 1;
	}
	return { scanned: parked.length, resumed };
}

/**
 * Re-queues expired node claims so a pre-boundary crash can be reclaimed and a
 * post-boundary crash is driven through the runner's unknown/manual-safe path.
 * The lease token is part of the occurrence id: each recovery generation is
 * queued once, while another expiry after a legitimate reclaim gets a new job.
 */
export async function reconcileExpiredAutomationNodeExecutions(
	db: Db,
	limit = 20,
): Promise<{ scanned: number; queued: number }> {
	const now = new Date();
	const expired = await db
		.select({
			executionId: automationNodeExecutions.id,
			leaseToken: automationNodeExecutions.leaseToken,
			runId: automationRuns.id,
			automationId: automationRuns.automationId,
			organizationId: automationRuns.organizationId,
			scopeKey: automationRuns.scopeKey,
		})
		.from(automationNodeExecutions)
		.innerJoin(
			automationRuns,
			and(
				eq(automationRuns.id, automationNodeExecutions.runId),
				eq(
					automationRuns.organizationId,
					automationNodeExecutions.organizationId,
				),
				eq(automationRuns.scopeKey, automationNodeExecutions.scopeKey),
				eq(automationRuns.revision, automationNodeExecutions.runRevision),
				eq(automationRuns.currentNodeKey, automationNodeExecutions.nodeKey),
			),
		)
		.where(
			and(
				eq(automationRuns.status, "active"),
				eq(automationNodeExecutions.status, "claimed"),
				or(
					isNull(automationNodeExecutions.leaseExpiresAt),
					lte(automationNodeExecutions.leaseExpiresAt, now),
				),
			),
		)
		.orderBy(
			asc(automationNodeExecutions.leaseExpiresAt),
			asc(automationNodeExecutions.id),
		)
		.limit(Math.max(1, Math.min(limit, 100)));

	let queued = 0;
	for (const row of expired) {
		const [inserted] = await db
			.insert(automationScheduledJobs)
			.values({
				occurrenceId: `node-execution-recovery:${row.executionId}:lease:${row.leaseToken}`,
				organizationId: row.organizationId,
				scopeKey: row.scopeKey,
				runId: row.runId,
				automationId: row.automationId,
				jobType: "resume_run",
				runAt: now,
				payload: {
					source: "expired_node_execution_reconciler",
					node_execution_id: row.executionId,
				},
			})
			.onConflictDoNothing()
			.returning({ id: automationScheduledJobs.id });
		if (inserted) queued += 1;
	}
	return { scanned: expired.length, queued };
}

/**
 * Build the initial `automation_runs.context` JSONB payload for a fresh
 * enrollment. Loads the contact row, inline tag array, and keyed custom
 * field values so merge-tag resolution and condition evaluation have access
 * to contact state from the very first step.
 *
 * `overrides` win over the hydrated fields so callers can pre-seed values
 * like `{ trigger: { post_id: ... } }` without being clobbered.
 *
 * NOTE: we intentionally do NOT re-hydrate on resume. v1.1 can add a refresh
 * step if stale state becomes a problem.
 */
async function buildInitialRunContext(
	db: Db,
	contactId: string,
	organizationId: string,
	overrides: Record<string, unknown>,
	keyConfig: string,
	prehydrated?: {
		contact: Record<string, unknown> | null;
		tags: string[];
		fields: Record<string, string>;
	},
): Promise<Record<string, unknown>> {
	// Reuse caller-supplied contact state when available (the trigger matcher
	// already loaded the contact row + custom fields to evaluate filters), so we
	// don't re-run the same two queries here.
	if (prehydrated) {
		return {
			contact: prehydrated.contact ?? null,
			tags: prehydrated.tags ?? [],
			fields: prehydrated.fields ?? {},
			...overrides,
		};
	}

	// The contact row and the custom-field map are independent reads — issue
	// them in parallel to save one DB round trip on every enrollment (this path
	// runs per inbound message / internal event / scheduled contact).
	const [contact, fieldRows, segmentIdsMap] = await Promise.all([
		db.query.contacts.findFirst({
			where: and(
				eq(contacts.id, contactId),
				eq(contacts.organizationId, organizationId),
			),
		}),
		// Custom fields: keyed by `custom_field_definitions.slug` (the schema
		// uses `slug`, not `key`). We scope by organization and inner-join to
		// the definition to get the slug + resolve to a `{ slug: value }` map.
		db
			.select({
				slug: customFieldDefinitions.slug,
				value: customFieldValues.value,
			})
			.from(customFieldValues)
			.innerJoin(
				customFieldDefinitions,
				eq(customFieldValues.definitionId, customFieldDefinitions.id),
			)
			.where(
				and(
					eq(customFieldValues.contactId, contactId),
					eq(customFieldValues.organizationId, organizationId),
				),
			),
		getContactSegmentIds(db, organizationId, [contactId]),
	]);

	// Tags live inline on `contacts.tags` (text[]); no separate join table.
	const tags = contact?.tags ?? [];
	const plaintextContact = contact
		? {
				...(await decryptContactRow(keyConfig, contact)),
				segment_ids: segmentIdsMap.get(contactId) ?? [],
			}
		: null;
	const fields: Record<string, string> = {};
	for (const row of fieldRows) {
		if (row.slug) fields[row.slug] = row.value;
	}

	return {
		contact: plaintextContact,
		tags,
		fields,
		// Overrides win — callers (start_automation, webhook receiver, trigger
		// matcher) may pre-seed `trigger`/`state` keys that we must not clobber.
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findActivePause(
	db: Db,
	organizationId: string,
	contactId: string,
	automationId: string,
): Promise<boolean> {
	const rows = await db
		.select({ id: automationContactControls.id })
		.from(automationContactControls)
		.where(
			and(
				eq(automationContactControls.organizationId, organizationId),
				eq(automationContactControls.contactId, contactId),
				or(
					eq(automationContactControls.automationId, automationId),
					isNull(automationContactControls.automationId),
				),
				or(
					isNull(automationContactControls.pausedUntil),
					sql`${automationContactControls.pausedUntil} > NOW()`,
				),
			),
		)
		.limit(1);
	return rows.length > 0;
}

function findOutgoingEdge(
	graph: Graph,
	fromNode: string,
	fromPort: string,
): GraphEdge | null {
	return (
		graph.edges.find(
			(e) => e.from_node === fromNode && e.from_port === fromPort,
		) ?? null
	);
}

type AutomationStepOutcome =
	(typeof automationStepRuns.$inferSelect)["outcome"];

function stepOutcomeFromResult(result: HandlerResult): AutomationStepOutcome {
	switch (result.result) {
		case "advance":
			return "ok";
		case "wait_input":
			return "wait_input";
		case "wait_delay":
			return "wait_delay";
		case "wait_event":
			return "wait_event";
		case "end":
			return "end";
		case "fail":
			return "failed";
	}
}

export type RunUpdate = Partial<{
	status: RunStatus;
	currentNodeKey: string | null;
	currentPortKey: string | null;
	context: Record<string, unknown>;
	waitingFor: string | null;
	waitingUntil: Date | null;
	exitReason: string | null;
	completedAt: Date | null;
}>;

/**
 * Applies a run update guarded by the durable integer revision. Returns true iff
 * the update hit a row (i.e. this worker still owned the run). A false return
 * means another worker took over; callers should exit the loop gracefully.
 *
 * Exported so the scheduler (input_timeout / resume_run) and the input /
 * interactive resume paths can guard their run-state writes on the same CAS
 * predicate. Unlike timestamp equality, the revision cannot alias when two
 * transitions happen in the same millisecond.
 */
export async function updateRunOptimistic(
	db: Pick<Db, "update">,
	runId: string,
	expectedRevision: number,
	patch: RunUpdate,
): Promise<boolean> {
	const setPayload: Record<string, unknown> = {
		revision: sql`${automationRuns.revision} + 1`,
		updatedAt: sql`CURRENT_TIMESTAMP`,
	};
	if (patch.status !== undefined) setPayload.status = patch.status;
	if (patch.currentNodeKey !== undefined)
		setPayload.currentNodeKey = patch.currentNodeKey;
	if (patch.currentPortKey !== undefined)
		setPayload.currentPortKey = patch.currentPortKey;
	if (patch.context !== undefined) setPayload.context = patch.context;
	if (patch.waitingFor !== undefined) setPayload.waitingFor = patch.waitingFor;
	if (patch.waitingUntil !== undefined)
		setPayload.waitingUntil = patch.waitingUntil;
	if (patch.exitReason !== undefined) setPayload.exitReason = patch.exitReason;
	if (patch.completedAt !== undefined) {
		setPayload.completedAt =
			patch.completedAt === null ? null : sql`CURRENT_TIMESTAMP`;
	}

	const rows = await db
		.update(automationRuns)
		.set(setPayload)
		.where(
			and(
				eq(automationRuns.id, runId),
				eq(automationRuns.revision, expectedRevision),
			),
		)
		.returning({ id: automationRuns.id });
	return rows.length > 0;
}

export async function transitionRunTerminal(
	db: Db,
	runId: string,
	expectedRevision: number,
	automationId: string,
	status: Extract<RunStatus, "completed" | "exited" | "failed">,
	exitReason: string,
	patch: Omit<RunUpdate, "status" | "exitReason" | "completedAt"> = {},
): Promise<boolean> {
	const counter =
		status === "completed"
			? "total_completed"
			: status === "failed"
				? "total_failed"
				: "total_exited";
	return db.transaction(async (tx) => {
		const updated = await updateRunOptimistic(tx, runId, expectedRevision, {
			...patch,
			status,
			exitReason,
			completedAt: new Date(),
		});
		if (!updated) return false;
		await incrementCounter(tx, automationId, counter);
		return true;
	});
}

export async function incrementCounter(
	db: Pick<Db, "update">,
	automationId: string,
	column: "total_completed" | "total_failed" | "total_exited",
): Promise<void> {
	const colExpr =
		column === "total_completed"
			? sql`${automations.totalCompleted} + 1`
			: column === "total_failed"
				? sql`${automations.totalFailed} + 1`
				: sql`${automations.totalExited} + 1`;
	const set =
		column === "total_completed"
			? { totalCompleted: colExpr }
			: column === "total_failed"
				? { totalFailed: colExpr }
				: { totalExited: colExpr };
	await db
		.update(automations)
		.set(set as never)
		.where(eq(automations.id, automationId));
}

async function writeStepRun(
	db: Db,
	row: {
		runId: string;
		automationId: string;
		organizationId: string;
		scopeKey: string;
		nodeKey: string;
		nodeKind: AutomationNodeKind;
		enteredViaPortKey: string | null;
		exitedViaPortKey: string | null;
		outcome: AutomationStepOutcome;
		durationMs: number;
		payload: unknown;
		error: unknown;
	},
): Promise<void> {
	await db.insert(automationStepRuns).values({
		runId: row.runId,
		automationId: row.automationId,
		organizationId: row.organizationId,
		scopeKey: row.scopeKey,
		nodeKey: row.nodeKey,
		nodeKind: row.nodeKind,
		enteredViaPortKey: row.enteredViaPortKey,
		exitedViaPortKey: row.exitedViaPortKey,
		outcome: row.outcome,
		durationMs: row.durationMs,
		payload: row.payload ?? null,
		error: row.error ?? null,
		executedAt: sql`CURRENT_TIMESTAMP`,
	});
}
