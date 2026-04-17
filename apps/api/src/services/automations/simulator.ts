import type { AutomationSnapshot } from "./types";

/**
 * Static dry-run of an automation graph. No handlers execute; no side effects
 * (DB writes, queue sends, platform sends) happen. The traversal picks the
 * default outgoing edge on every node, unless the caller overrides the branch
 * for a specific node via `branch_choices`.
 *
 * Rules for picking the default branch (when no choice is provided):
 *   - condition        → "yes"
 *   - randomizer       → first branch label, then "branch_1", then "next"
 *   - split_test       → first variant label, then "variant_a", then "next"
 *   - user_input_*     → "captured"
 *   - ai_agent         → "complete"
 *   - ai_intent_router → "intent_1", then "next"
 *   - goto             → follows `target_node_key` directly
 *   - end              → terminates
 *   - everything else  → "next"
 *
 * Wait-style nodes (smart_delay, user_input_*) are not suspended — they're
 * treated as instantaneous passthroughs so the caller can see the whole path.
 */

export interface SimulateInput {
	branch_choices?: Record<string, string>;
	max_steps?: number;
}

export interface SimulatedStep {
	node_id: string;
	node_key: string;
	node_type: string;
	branch_label: string | null;
	note: string | null;
}

export interface SimulateResult {
	automation_id: string;
	version: number;
	path: SimulatedStep[];
	terminated: {
		kind: "complete" | "exit" | "step_cap" | "dead_end" | "cycle" | "unknown_node";
		reason?: string;
		node_key?: string;
	};
}

export function simulateAutomation(
	snapshot: AutomationSnapshot,
	input: SimulateInput = {},
): SimulateResult {
	const branchChoices = input.branch_choices ?? {};
	const maxSteps = Math.min(Math.max(input.max_steps ?? 50, 1), 200);
	const path: SimulatedStep[] = [];
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

		// End node terminates immediately.
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

		// Goto jumps directly to the target.
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

		const label = pickBranchLabel(node.type, branchChoices[node.key], node.config);
		path.push({
			node_id: node.id,
			node_key: node.key,
			node_type: node.type,
			branch_label: label,
			note: noteFor(node.type),
		});

		const nextKey = resolveNextNodeKey(snapshot, node.key, label);
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

function pickBranchLabel(
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
	if (nodeType.startsWith("user_input_")) return "captured";
	if (nodeType === "ai_agent") return "complete";
	return "next";
}

function noteFor(nodeType: string): string | null {
	if (nodeType === "smart_delay") return "delay skipped in simulation";
	if (nodeType.startsWith("user_input_"))
		return "input capture simulated as 'captured' branch";
	if (nodeType.startsWith("message_"))
		return "send skipped in simulation";
	if (nodeType === "http_request") return "HTTP request skipped in simulation";
	if (nodeType === "webhook_out") return "webhook skipped in simulation";
	if (nodeType === "ai_agent" || nodeType === "ai_step")
		return "AI call skipped in simulation";
	// Platform-specific send nodes follow `<channel>_send_*` or similar naming.
	if (/^(instagram|facebook|whatsapp|telegram|discord|sms|twitter|bluesky|threads|youtube|linkedin|mastodon|reddit|googlebusiness|beehiiv|kit|mailchimp|listmonk|pinterest)_/.test(nodeType))
		return "platform send skipped in simulation";
	return null;
}

function resolveNextNodeKey(
	snapshot: AutomationSnapshot,
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
