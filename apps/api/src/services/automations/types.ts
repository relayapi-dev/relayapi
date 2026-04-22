// apps/api/src/services/automations/types.ts
//
// Runtime types for the Manychat-parity automation engine.
// See docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md
// §8 (Runtime Execution Model) for the full design.

import type { Database } from "@relayapi/db";
import type {
	Graph,
	GraphNode,
	Port,
} from "../../schemas/automation-graph";

export type RunStatus =
	| "active"
	| "waiting"
	| "completed"
	| "exited"
	| "failed";

/** Direct-messaging channels supported by the automation dispatcher. */
export type Channel =
	| "instagram"
	| "facebook"
	| "whatsapp"
	| "telegram"
	| "tiktok";

export type RunContext = {
	runId: string;
	automationId: string;
	organizationId: string;
	contactId: string;
	conversationId: string | null;
	channel: string;
	graph: Graph;
	context: Record<string, any>;
	now: Date;
	/**
	 * DB handle for the current run. Populated by `runLoop`/`enrollContact` at
	 * context construction — node and action handlers should always read DB
	 * access from `ctx.db` (not `ctx.env.db`, which is no longer guaranteed to
	 * be present).
	 */
	db: Database;
	// Remaining env bindings (KV, Queue, R2, encryption keys, etc.) flow here.
	env: Record<string, any>;
};

export type HandlerResult =
	| { result: "advance"; via_port: string; payload?: any }
	| { result: "wait_input"; timeout_at?: Date; payload?: any }
	| { result: "wait_delay"; resume_at: Date; payload?: any }
	| { result: "end"; exit_reason: string; payload?: any }
	| { result: "fail"; error: Error; payload?: any };

export interface NodeHandler<TConfig = any> {
	kind: string;
	handle(
		node: { key: string; kind: string; config: TConfig },
		ctx: RunContext,
	): Promise<HandlerResult>;
}

export type { Graph, GraphNode, Port };
