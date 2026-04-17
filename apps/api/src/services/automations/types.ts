import type { Database } from "@relayapi/db";
import type { Env } from "../../types";

/** Queue message dispatched to AUTOMATION_QUEUE. */
export type AutomationQueueMessage =
	| { type: "advance"; enrollment_id: string }
	| { type: "resume_from_input"; enrollment_id: string; input_value: unknown }
	| { type: "enroll"; automation_id: string; contact_id: string | null; trigger_payload: Record<string, unknown> };

/** Shape of a published automation version snapshot. */
export interface AutomationSnapshot {
	automation_id: string;
	version: number;
	name: string;
	channel: string;
	trigger: {
		type: string;
		account_id?: string;
		config: Record<string, unknown>;
		filters: Record<string, unknown>;
	};
	entry_node_key: string;
	nodes: Array<{
		id: string;
		key: string;
		type: string;
		config: Record<string, unknown>;
	}>;
	edges: Array<{
		id: string;
		from_node_key: string;
		to_node_key: string;
		label: string;
		order: number;
		condition_expr: unknown | null;
	}>;
}

/** Context passed to every node handler. */
export interface NodeExecutionContext {
	env: Env;
	db: Database;
	enrollment: {
		id: string;
		organization_id: string;
		automation_id: string;
		automation_version: number;
		contact_id: string | null;
		conversation_id: string | null;
		current_node_id: string | null;
		state: Record<string, unknown>;
	};
	snapshot: AutomationSnapshot;
	node: AutomationSnapshot["nodes"][number];
}

/** Result returned by a node handler. */
export type NodeExecutionResult =
	| { kind: "next"; label?: string; state_patch?: Record<string, unknown> }
	| { kind: "wait"; next_run_at: Date; state_patch?: Record<string, unknown> }
	| { kind: "wait_for_input"; state_patch?: Record<string, unknown> }
	| { kind: "goto"; target_node_key: string; state_patch?: Record<string, unknown> }
	| { kind: "complete"; reason?: string; state_patch?: Record<string, unknown> }
	| { kind: "exit"; reason: string; state_patch?: Record<string, unknown> }
	| { kind: "fail"; error: string };

export type NodeHandler = (
	ctx: NodeExecutionContext,
) => Promise<NodeExecutionResult>;
