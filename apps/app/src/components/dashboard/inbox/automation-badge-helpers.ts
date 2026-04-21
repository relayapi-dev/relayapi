// Pure helpers backing `automation-badge.tsx` (Plan 3 — Unit C4, Task V1).
//
// Kept in a separate, UI-free file so the bun test runner can import
// them without resolving the dashboard's `@/lib/utils` alias.

export interface ProxyRun {
	id: string;
	automation_id: string;
	contact_id: string;
	status: string;
	current_node_key: string | null;
	current_port_key: string | null;
	started_at: string;
}

export interface ProxyAutomation {
	id: string;
	name: string;
	channel: string;
	status: string;
}

export interface AutomationNode {
	key: string;
	kind: string;
	title?: string | null;
}

/**
 * Derive the "at [current step]" label for the badge. When we have the
 * automation graph we show the human title (falling back to the node kind);
 * otherwise we show the raw node key or a generic status label.
 */
export function formatStepLabel(
	run: Pick<ProxyRun, "current_node_key" | "status">,
	nodes: AutomationNode[] | undefined,
): string {
	if (!run.current_node_key) {
		return run.status === "waiting" ? "waiting" : "active";
	}
	const node = nodes?.find((n) => n.key === run.current_node_key);
	if (node?.title) return node.title;
	if (node?.kind) return node.kind;
	return run.current_node_key;
}

/**
 * Build the positional "step X/Y" suffix from a graph's node list. Returns
 * `null` when we can't locate the current node (unknown graph / missing
 * key) so the caller can fall back to showing just the step label.
 */
export function formatStepPosition(
	currentNodeKey: string | null | undefined,
	nodes: AutomationNode[] | undefined,
): { index: number; total: number } | null {
	if (!currentNodeKey || !nodes || nodes.length === 0) return null;
	const idx = nodes.findIndex((n) => n.key === currentNodeKey);
	if (idx < 0) return null;
	return { index: idx + 1, total: nodes.length };
}

/**
 * Pick the most-relevant run for the badge. We prefer `active` over
 * `waiting`, then tie-break on the most recently started. Returns the
 * matching automation + run so callers can render without re-looking up.
 */
export function pickPrimaryRun(
	runs: ProxyRun[],
	automations: ProxyAutomation[],
): { run: ProxyRun; automation: ProxyAutomation } | null {
	if (runs.length === 0) return null;
	const scoreStatus = (status: string): number => {
		if (status === "active") return 2;
		if (status === "waiting") return 1;
		return 0;
	};
	const sorted = [...runs].sort((a, b) => {
		const s = scoreStatus(b.status) - scoreStatus(a.status);
		if (s !== 0) return s;
		return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
	});
	for (const run of sorted) {
		const automation = automations.find((a) => a.id === run.automation_id);
		if (automation) return { run, automation };
	}
	return null;
}
