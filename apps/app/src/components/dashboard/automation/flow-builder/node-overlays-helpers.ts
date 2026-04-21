// Pure helpers backing `node-overlays.tsx` (Plan 3 — Unit C4, Task U1).
//
// Kept in a separate file with zero UI / `@/lib` imports so the bun test
// runner can load them without going through the React / Tailwind paths
// that the surrounding .tsx file pulls in.

export type BadgeTone = "green" | "yellow" | "red" | "grey";

export interface NodeMetrics {
	executions: number;
	success_rate: number;
	per_port: Record<string, number>;
}

/**
 * Choose a tone for the metric pill. Rules from the spec:
 *   - `grey`   → no executions recorded (or undefined metrics)
 *   - `green`  → success rate > 90%
 *   - `yellow` → 70% – 90%
 *   - `red`    → below 70%
 */
export function toneForMetrics(metrics: NodeMetrics | undefined): BadgeTone {
	if (!metrics || metrics.executions <= 0) return "grey";
	const rate = metrics.success_rate;
	if (!Number.isFinite(rate)) return "grey";
	if (rate > 0.9) return "green";
	if (rate >= 0.7) return "yellow";
	return "red";
}

/**
 * Rank the exit ports for this node, highest-count first. Ties break
 * alphabetically for stable ordering across renders.
 */
export function rankPorts(
	perPort: Record<string, number>,
): Array<{ port: string; count: number }> {
	return Object.entries(perPort)
		.map(([port, count]) => ({ port, count }))
		.sort((a, b) => {
			if (b.count !== a.count) return b.count - a.count;
			return a.port.localeCompare(b.port);
		});
}

/**
 * Format a success rate (0..1) as a short percentage string. Returns `—`
 * for non-finite inputs.
 */
export function formatSuccessRate(rate: number): string {
	if (!Number.isFinite(rate)) return "—";
	return `${Math.round(rate * 100)}%`;
}

/**
 * Compute the label used inside the pill:
 *
 *   ⚡ <executions> · <success%> → <top exit port>
 *
 * The arrow segment is omitted when there is no recorded exit port.
 */
export function summarizeMetrics(metrics: NodeMetrics | undefined): {
	executionsLabel: string;
	rateLabel: string | null;
	topPort: string | null;
} {
	if (!metrics || metrics.executions <= 0) {
		return { executionsLabel: "0", rateLabel: null, topPort: null };
	}
	const ranked = rankPorts(metrics.per_port);
	return {
		executionsLabel: metrics.executions.toLocaleString(),
		rateLabel: formatSuccessRate(metrics.success_rate),
		topPort: ranked[0]?.port ?? null,
	};
}
