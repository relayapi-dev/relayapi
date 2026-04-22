// apps/api/src/services/automations/simulator.ts
//
// Pure dry-run of an automation graph (spec §14.4). No DB writes, no platform
// sends, no queue enqueues — just a deterministic walk through the graph that
// records each visit. Used by the builder preview and the simulate endpoint.

import type { Graph, GraphEdge, GraphNode } from "../../schemas/automation-graph";
import { evaluateFilterGroup } from "./filter-eval";

export type SimulateStep = {
	node_key: string;
	node_kind: string;
	entered_via_port_key: string | null;
	exited_via_port_key: string | null;
	outcome: "advance" | "wait_input" | "wait_delay" | "end" | "fail";
	payload?: unknown;
};

export type SimulateResult = {
	steps: SimulateStep[];
	ended_at_node: string | null;
	exit_reason: string;
};

export type SimulateInput = {
	graph: Graph;
	startNodeKey?: string;
	testContext?: Record<string, unknown>;
	/** Force a node to exit via the given port, overriding default branching. */
	branchChoices?: Record<string, string>;
	/** Hard cap on node visits — defaults to 100. */
	maxVisits?: number;
};

const DEFAULT_MAX_VISITS = 100;

export async function simulate(input: SimulateInput): Promise<SimulateResult> {
	const { graph } = input;
	const branchChoices = input.branchChoices ?? {};
	const ctx = input.testContext ?? {};
	const maxVisits = input.maxVisits ?? DEFAULT_MAX_VISITS;

	const steps: SimulateStep[] = [];
	let currentKey: string | null =
		input.startNodeKey ?? graph.root_node_key ?? null;
	let enteredPort: string | null = null;
	let visits = 0;

	while (currentKey && visits < maxVisits) {
		visits++;
		const node = graph.nodes.find((n) => n.key === currentKey);
		if (!node) {
			return {
				steps,
				ended_at_node: currentKey,
				exit_reason: "unknown_node",
			};
		}

		const walkResult = walkNode(graph, node, branchChoices, ctx);

		steps.push({
			node_key: node.key,
			node_kind: node.kind,
			entered_via_port_key: enteredPort,
			exited_via_port_key: walkResult.exitPort,
			outcome: walkResult.outcome,
			payload: walkResult.payload,
		});

		if (walkResult.outcome !== "advance") {
			return {
				steps,
				ended_at_node: node.key,
				exit_reason: walkResult.reason,
			};
		}

		// Follow edge.
		const nextEdge = findEdge(graph, node.key, walkResult.exitPort);
		if (walkResult.gotoTarget) {
			currentKey = walkResult.gotoTarget;
			enteredPort = null;
			continue;
		}
		if (!nextEdge) {
			return {
				steps,
				ended_at_node: node.key,
				exit_reason: "no_outgoing_edge",
			};
		}
		currentKey = nextEdge.to_node;
		enteredPort = nextEdge.to_port;
	}

	if (visits >= maxVisits) {
		return {
			steps,
			ended_at_node: currentKey,
			exit_reason: "max_visits",
		};
	}

	return { steps, ended_at_node: currentKey, exit_reason: "completed" };
}

type WalkResult =
	| {
			outcome: "advance";
			exitPort: string;
			payload?: unknown;
			gotoTarget?: string;
			reason: "advance";
	  }
	| {
			outcome: "wait_input" | "wait_delay" | "end" | "fail";
			exitPort: string | null;
			payload?: unknown;
			reason: string;
	  };

function walkNode(
	graph: Graph,
	node: GraphNode,
	branchChoices: Record<string, string>,
	ctx: Record<string, unknown>,
): WalkResult {
	const forced = branchChoices[node.key];

	switch (node.kind) {
		case "message": {
			if (forced) {
				return {
					outcome: "advance",
					exitPort: forced,
					payload: null,
					reason: "advance",
				};
			}
			const cfg = (node.config ?? {}) as Record<string, unknown>;
			const waitForReply = Boolean(cfg.wait_for_reply);
			const blocks = Array.isArray(cfg.blocks) ? cfg.blocks : [];
			const hasInteractive = blocks.some((b) => {
				if (!b || typeof b !== "object") return false;
				const bb = b as Record<string, unknown>;
				if (!Array.isArray(bb.buttons)) return false;
				return bb.buttons.some(
					(btn) =>
						btn &&
						typeof btn === "object" &&
						(btn as Record<string, unknown>).type === "branch",
				);
			});
			const quickReplies = Array.isArray(cfg.quick_replies)
				? cfg.quick_replies
				: [];
			if (waitForReply || hasInteractive || quickReplies.length > 0) {
				return {
					outcome: "wait_input",
					exitPort: null,
					reason: "wait_input",
				};
			}
			return {
				outcome: "advance",
				exitPort: "next",
				payload: null,
				reason: "advance",
			};
		}

		case "input": {
			if (forced) {
				return {
					outcome: "advance",
					exitPort: forced,
					payload: null,
					reason: "advance",
				};
			}
			return { outcome: "wait_input", exitPort: null, reason: "wait_input" };
		}

		case "delay": {
			return {
				outcome: "advance",
				exitPort: "next",
				payload: null,
				reason: "advance",
			};
		}

		case "condition": {
			if (forced) {
				return {
					outcome: "advance",
					exitPort: forced,
					payload: null,
					reason: "advance",
				};
			}
			const cfg = (node.config ?? {}) as Record<string, unknown>;
			const predicates = cfg.predicates as Record<string, unknown> | undefined;
			if (!predicates) {
				// No predicates configured → fall through the `false` branch. The
				// runtime's port keys are "true" / "false" (see ports.ts and
				// nodes/condition.ts); the simulator must match.
				return {
					outcome: "advance",
					exitPort: "false",
					payload: null,
					reason: "advance",
				};
			}
			const ok = evaluateFilterGroup(predicates as never, {
				contact: null,
				state: ctx,
				tags: (ctx.tags as string[] | undefined) ?? [],
				fields: (ctx.fields as Record<string, unknown> | undefined) ?? {},
			});
			return {
				outcome: "advance",
				exitPort: ok ? "true" : "false",
				payload: null,
				reason: "advance",
			};
		}

		case "randomizer": {
			if (forced) {
				return {
					outcome: "advance",
					exitPort: forced,
					payload: null,
					reason: "advance",
				};
			}
			// The runtime stores weighted branches under `config.variants` (see
			// nodes/randomizer.ts) and emits ports prefixed `variant.<key>`; the
			// simulator must walk the same shape.
			const cfg = (node.config ?? {}) as Record<string, unknown>;
			const variants =
				(cfg.variants as
					| Array<{ key?: string; label?: string; weight?: number }>
					| undefined) ?? [];
			if (variants.length === 0) {
				return {
					outcome: "fail",
					exitPort: null,
					reason: "randomizer_missing_variants",
				};
			}
			const totalWeight = variants.reduce(
				(acc, v) => acc + (typeof v.weight === "number" ? v.weight : 1),
				0,
			);
			let pick = Math.random() * totalWeight;
			for (const v of variants) {
				const w = typeof v.weight === "number" ? v.weight : 1;
				if (pick <= w) {
					const key = v.key ?? v.label ?? "1";
					return {
						outcome: "advance",
						exitPort: `variant.${key}`,
						payload: { variant_key: key },
						reason: "advance",
					};
				}
				pick -= w;
			}
			// Fallback — pick last variant.
			const last = variants[variants.length - 1]!;
			const key = last.key ?? last.label ?? "1";
			return {
				outcome: "advance",
				exitPort: `variant.${key}`,
				payload: { variant_key: key },
				reason: "advance",
			};
		}

		case "action_group": {
			// An action_group has two output ports: `next` (success) and `error`
			// (at least one action failed). The simulator honours an explicit
			// `branch_choices[node.key]` to force the `error` path; otherwise it
			// assumes success and advances via `next`. This keeps the simulator
			// consistent with how `condition` / `randomizer` / `http_request`
			// already respect forced branching (spec §B12 fix).
			const cfg = (node.config ?? {}) as Record<string, unknown>;
			const exitPort = forced === "error" ? "error" : "next";
			return {
				outcome: "advance",
				exitPort,
				payload: { would_fire_actions: cfg.actions ?? [] },
				reason: "advance",
			};
		}

		case "http_request": {
			const port = forced ?? "success";
			return {
				outcome: "advance",
				exitPort: port,
				payload: null,
				reason: "advance",
			};
		}

		case "start_automation": {
			const cfg = (node.config ?? {}) as Record<string, unknown>;
			return {
				outcome: "advance",
				exitPort: "next",
				payload: { would_enroll: cfg.target_automation_id ?? null },
				reason: "advance",
			};
		}

		case "goto": {
			const cfg = (node.config ?? {}) as Record<string, unknown>;
			const target =
				(cfg.target_node_key as string | undefined) ??
				(cfg.target_automation_id as string | undefined);
			if (!target) {
				return {
					outcome: "fail",
					exitPort: null,
					reason: "goto_missing_target",
				};
			}
			return {
				outcome: "advance",
				exitPort: "_goto",
				payload: { target_node_key: target },
				gotoTarget: target,
				reason: "advance",
			};
		}

		case "end": {
			const cfg = (node.config ?? {}) as Record<string, unknown>;
			return {
				outcome: "end",
				exitPort: null,
				reason: (cfg.reason as string | undefined) ?? "completed",
			};
		}

		default: {
			return {
				outcome: "advance",
				exitPort: forced ?? "next",
				payload: null,
				reason: "advance",
			};
		}
	}
}

function findEdge(
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

// ---------------------------------------------------------------------------
// Back-compat shim (legacy snapshot-based callers)
// ---------------------------------------------------------------------------

/**
 * Legacy snapshot-based simulator kept for existing callers in
 * routes/automations.ts and the older automations.test.ts. Walks a snapshot
 * using label-based branching; no node handlers run. Will be removed once
 * those callers migrate to the new `simulate()` API.
 */
export interface LegacySimulateInput {
	branch_choices?: Record<string, string>;
	max_steps?: number;
}

export interface LegacySimulatedStep {
	node_id: string;
	node_key: string;
	node_type: string;
	branch_label: string | null;
	note: string | null;
}

export interface LegacySimulateResult {
	automation_id: string;
	version: number;
	path: LegacySimulatedStep[];
	terminated: {
		kind:
			| "complete"
			| "exit"
			| "step_cap"
			| "dead_end"
			| "cycle"
			| "unknown_node";
		reason?: string;
		node_key?: string;
	};
}

interface LegacySnapshot {
	automation_id: string;
	version: number;
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
		condition_expr: string | null;
	}>;
}

export function simulateAutomation(
	snapshot: LegacySnapshot,
	input: LegacySimulateInput = {},
): LegacySimulateResult {
	const branchChoices = input.branch_choices ?? {};
	const maxSteps = Math.min(Math.max(input.max_steps ?? 50, 1), 200);
	const path: LegacySimulatedStep[] = [];
	const visited = new Set<string>();

	let currentKey = snapshot.entry_node_key;

	for (let step = 0; step < maxSteps; step++) {
		const node = snapshot.nodes.find((n) => n.key === currentKey);
		if (!node) {
			return {
				automation_id: snapshot.automation_id,
				version: snapshot.version,
				path,
				terminated: {
					kind: "unknown_node",
					reason: `Node '${currentKey}' not found in snapshot`,
					node_key: currentKey,
				},
			};
		}

		if (visited.has(node.key)) {
			return {
				automation_id: snapshot.automation_id,
				version: snapshot.version,
				path,
				terminated: {
					kind: "cycle",
					reason: `Re-entered node '${node.key}' without a branch choice`,
					node_key: node.key,
				},
			};
		}
		visited.add(node.key);

		if (node.type === "end") {
			path.push({
				node_id: node.id,
				node_key: node.key,
				node_type: node.type,
				branch_label: null,
				note: (node.config.reason as string | undefined) ?? null,
			});
			return {
				automation_id: snapshot.automation_id,
				version: snapshot.version,
				path,
				terminated: {
					kind: "exit",
					reason: (node.config.reason as string | undefined) ?? "end node",
					node_key: node.key,
				},
			};
		}

		if (node.type === "goto") {
			const target = node.config.target_node_key as string | undefined;
			path.push({
				node_id: node.id,
				node_key: node.key,
				node_type: node.type,
				branch_label: null,
				note: target ? `goto → ${target}` : null,
			});
			if (!target) {
				return {
					automation_id: snapshot.automation_id,
					version: snapshot.version,
					path,
					terminated: {
						kind: "dead_end",
						reason: "goto node missing target_node_key",
						node_key: node.key,
					},
				};
			}
			currentKey = target;
			continue;
		}

		const label = pickLegacyBranchLabel(
			node.type,
			branchChoices[node.key],
			node.config,
		);
		path.push({
			node_id: node.id,
			node_key: node.key,
			node_type: node.type,
			branch_label: label,
			note: legacyNoteFor(node.type),
		});

		const nextKey = resolveLegacyNextNodeKey(snapshot, node.key, label);
		if (!nextKey) {
			return {
				automation_id: snapshot.automation_id,
				version: snapshot.version,
				path,
				terminated: {
					kind: "complete",
					reason: `No outgoing edge labeled '${label}' from '${node.key}'`,
					node_key: node.key,
				},
			};
		}
		currentKey = nextKey;
	}

	return {
		automation_id: snapshot.automation_id,
		version: snapshot.version,
		path,
		terminated: {
			kind: "step_cap",
			reason: `Hit max_steps (${maxSteps}); path truncated`,
			node_key: currentKey,
		},
	};
}

function pickLegacyBranchLabel(
	nodeType: string,
	override: string | undefined,
	config: Record<string, unknown>,
): string {
	if (override) return override;
	if (nodeType === "condition") return "yes";
	if (nodeType === "randomizer") {
		const branches = config.branches as Array<{ label: string }> | undefined;
		return branches?.[0]?.label ?? "branch_1";
	}
	if (nodeType === "split_test") {
		const variants = config.variants as Array<{ label: string }> | undefined;
		return variants?.[0]?.label ?? "variant_a";
	}
	if (nodeType === "ai_intent_router") {
		const intents = config.intents as Array<{ label: string }> | undefined;
		return intents?.[0]?.label ?? "intent_1";
	}
	if (
		nodeType === "instagram_send_quick_replies" ||
		nodeType === "facebook_send_quick_replies"
	) {
		const quickReplies = config.quick_replies as
			| Array<{ payload?: string; title?: string }>
			| undefined;
		const first = quickReplies?.[0];
		return first?.payload ?? first?.title ?? "next";
	}
	if (
		nodeType === "instagram_send_buttons" ||
		nodeType === "facebook_send_button_template"
	) {
		const buttons = config.buttons as
			| Array<{ type?: string; payload?: string; title?: string }>
			| undefined;
		const button = buttons?.find((item) => item.type === "postback");
		return button?.payload ?? button?.title ?? "next";
	}
	if (nodeType === "whatsapp_send_interactive") {
		const buttons = config.buttons as
			| Array<{ id?: string; title?: string }>
			| undefined;
		const firstButton = buttons?.[0];
		if (firstButton) return firstButton.id ?? firstButton.title ?? "next";
		const list = config.list as
			| {
					sections?: Array<{
						rows?: Array<{ id?: string; title?: string }>;
					}>;
			  }
			| undefined;
		const firstRow = list?.sections?.flatMap((section) => section.rows ?? [])[0];
		return firstRow?.id ?? firstRow?.title ?? "next";
	}
	if (nodeType === "telegram_send_keyboard") {
		const rows = config.buttons as
			| Array<Array<{ callback_data?: string; text?: string }>>
			| undefined;
		const firstButton = rows
			?.flatMap((row) => row)
			.find((button) => button.callback_data);
		return firstButton?.callback_data ?? firstButton?.text ?? "next";
	}
	if (nodeType.startsWith("user_input_")) return "captured";
	if (nodeType === "ai_agent") return "complete";
	return "next";
}

function legacyNoteFor(nodeType: string): string | null {
	if (nodeType === "smart_delay") return "delay skipped in simulation";
	if (nodeType.startsWith("user_input_"))
		return "input capture simulated as 'captured' branch";
	if (nodeType.startsWith("message_")) return "send skipped in simulation";
	if (
		nodeType === "instagram_send_quick_replies" ||
		nodeType === "facebook_send_quick_replies" ||
		nodeType === "instagram_send_buttons" ||
		nodeType === "facebook_send_button_template" ||
		nodeType === "whatsapp_send_interactive" ||
		nodeType === "telegram_send_keyboard"
	) {
		return "interactive send simulated via first configured option";
	}
	if (nodeType === "http_request") return "HTTP request skipped in simulation";
	if (nodeType === "webhook_out") return "webhook skipped in simulation";
	if (nodeType === "subflow_call")
		return "subflow execution skipped in simulation";
	if (nodeType === "ai_agent" || nodeType === "ai_step")
		return "AI call skipped in simulation";
	if (
		/^(instagram|facebook|whatsapp|telegram|discord|sms|twitter|bluesky|threads|youtube|linkedin|mastodon|reddit|googlebusiness|beehiiv|kit|mailchimp|listmonk|pinterest)_/.test(
			nodeType,
		)
	)
		return "platform send skipped in simulation";
	return null;
}

function resolveLegacyNextNodeKey(
	snapshot: LegacySnapshot,
	fromKey: string,
	label: string,
): string | null {
	const specific = snapshot.edges
		.filter((e) => e.from_node_key === fromKey && e.label === label)
		.sort((a, b) => a.order - b.order);
	if (specific[0]) return specific[0].to_node_key;

	if (label !== "next") {
		const fallback = snapshot.edges
			.filter((e) => e.from_node_key === fromKey && e.label === "next")
			.sort((a, b) => a.order - b.order);
		if (fallback[0]) return fallback[0].to_node_key;
	}

	return null;
}
