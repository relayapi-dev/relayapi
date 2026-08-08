// apps/api/src/services/automations/types.ts
//
// Runtime types for the Manychat-parity automation engine.
// See docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md
// §8 (Runtime Execution Model) for the full design.

import type { Database } from "@relayapi/db";
import type { Graph, GraphNode, Port } from "../../schemas/automation-graph";

export type RunStatus =
	| "active"
	| "waiting"
	| "completed"
	| "exited"
	| "failed";

export type AutomationExternalEffectDescriptor = {
	effectKey: string;
	kind: "message_block" | "http_request" | "automation_action";
};

export type AutomationExternalEffectOutcome<T> =
	| {
			outcome: "succeeded";
			value: T;
			providerReference?: string | null;
	  }
	| { outcome: "failed"; value: T; error: string };

export class AutomationExternalEffectBusyError extends Error {
	constructor() {
		super("automation external effect is owned by another worker");
		this.name = "AutomationExternalEffectBusyError";
	}
}

export class AutomationExternalEffectUnknownError extends Error {
	constructor(
		public readonly effectId: string,
		message: string,
	) {
		super(message);
		this.name = "AutomationExternalEffectUnknownError";
	}
}

/** Provider responded definitively that the mutation was not applied. */
export class AutomationExternalEffectKnownFailureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AutomationExternalEffectKnownFailureError";
	}
}

export function isAutomationExternalEffectControlError(
	error: unknown,
): error is
	| AutomationExternalEffectBusyError
	| AutomationExternalEffectUnknownError {
	return (
		error instanceof AutomationExternalEffectBusyError ||
		error instanceof AutomationExternalEffectUnknownError
	);
}

/** Direct-messaging channels supported by the automation dispatcher. */
export type Channel = "instagram" | "facebook" | "whatsapp" | "telegram";

export type RunContext = {
	runId: string;
	automationId: string;
	organizationId: string;
	workspaceId?: string | null;
	contactId: string;
	conversationId: string | null;
	channel: string;
	graph: Graph;
	context: Record<string, unknown>;
	now: Date;
	/**
	 * DB handle for the current run. Populated by `runLoop`/`enrollContact` at
	 * context construction — node and action handlers should always read DB
	 * access from `ctx.db` (not `ctx.env.db`, which is no longer guaranteed to
	 * be present).
	 */
	db: Database;
	/**
	 * Stable key for this exact run-revision/node execution. Provider-facing
	 * handlers should pass it to APIs that support idempotency. It remains the
	 * same when a completed HandlerResult is replayed after a runner crash.
	 */
	effectIdempotencyKey?: string;
	/** Derive a stable child key for one action/block inside a composite node. */
	effectIdempotencyKeyFor?: (component: string) => string;
	/**
	 * Fenced provider boundary for one actual external block/action. Local
	 * validation and pure orchestration stay outside this callback.
	 */
	executeExternalEffect?<T>(
		descriptor: AutomationExternalEffectDescriptor,
		operation: (
			providerIdempotencyKey: string,
		) => Promise<AutomationExternalEffectOutcome<T>>,
	): Promise<T>;
	// Remaining env bindings (KV, Queue, R2, encryption keys, etc.) flow here.
	env: Record<string, unknown>;
};

export type HandlerResult =
	| { result: "advance"; via_port: string; payload?: unknown }
	| { result: "wait_input"; timeout_at?: Date; payload?: unknown }
	| { result: "wait_delay"; resume_at: Date; payload?: unknown }
	| {
			result: "wait_event";
			event_kinds: string[];
			timeout_at?: Date;
			payload?: unknown;
	  }
	| { result: "end"; exit_reason: string; payload?: unknown }
	| { result: "fail"; error: Error; payload?: unknown };

export interface NodeHandler<TConfig = unknown> {
	kind: string;
	handle(
		node: { key: string; kind: string; config: TConfig },
		ctx: RunContext,
	): Promise<HandlerResult>;
}

export type { Graph, GraphNode, Port };
