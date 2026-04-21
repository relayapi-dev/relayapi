// Node metric overlays (Plan 3 — Unit C4, Phase U / Task U1).
//
// Attaches per-node execution metrics to the canvas. For an automation
// whose status is `active`, we fetch
//
//     GET /api/automations/{id}/insights?period=<24h|7d|30d|90d>
//
// and render a small pill on the top-right corner of each React Flow node
// with execution count, success rate, and the most frequent exit port.
// Clicking the pill opens a popover with the full per-port breakdown.
//
// Draft / paused / archived automations skip the fetch entirely (controlled
// by the `enabled` flag on `useNodeOverlays`), so we don't burn bandwidth
// querying insights on flows that have no runs yet.
//
// Public surface:
//
//   const { data, loading, error } = useNodeOverlays(automationId, "7d", true);
//   const metrics = data.get(node.key);
//   <NodeMetricBadge metrics={metrics} />
//
// Pure helpers live in `./node-overlays-helpers.ts` so tests can import
// them without going through this file's UI deps.

import { useEffect, useMemo, useRef, useState } from "react";
import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	formatSuccessRate,
	rankPorts,
	summarizeMetrics,
	toneForMetrics,
	type BadgeTone,
	type NodeMetrics,
} from "./node-overlays-helpers";

// Re-export helpers so existing imports via `./node-overlays` keep working.
export {
	formatSuccessRate,
	rankPorts,
	summarizeMetrics,
	toneForMetrics,
} from "./node-overlays-helpers";
export type {
	BadgeTone,
	NodeMetrics,
} from "./node-overlays-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OverlayPeriod = "24h" | "7d" | "30d" | "90d";

export interface UseNodeOverlaysResult {
	data: Map<string, NodeMetrics>;
	loading: boolean;
	error: Error | null;
	refetch: () => void;
}

interface InsightsResponse {
	per_node?: Array<{
		node_key: string;
		executions?: number;
		success_rate?: number;
		per_port?: Record<string, number>;
	}>;
}

const TONE_CLASSES: Record<BadgeTone, string> = {
	green:
		"bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100",
	yellow: "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100",
	red: "bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100",
	grey: "bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100",
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useNodeOverlays(
	automationId: string,
	period: OverlayPeriod,
	enabled: boolean,
): UseNodeOverlaysResult {
	const [data, setData] = useState<Map<string, NodeMetrics>>(() => new Map());
	const [loading, setLoading] = useState<boolean>(false);
	const [error, setError] = useState<Error | null>(null);
	const [bump, setBump] = useState(0);
	const fetchId = useRef(0);

	useEffect(() => {
		if (!enabled || !automationId) {
			setData(new Map());
			setLoading(false);
			setError(null);
			return;
		}
		const id = ++fetchId.current;
		setLoading(true);
		setError(null);

		(async () => {
			try {
				const url = new URL(
					`/api/automations/${encodeURIComponent(automationId)}/insights`,
					window.location.origin,
				);
				url.searchParams.set("period", period);
				const res = await fetch(url.toString(), {
					signal: AbortSignal.timeout(15_000),
				});
				if (id !== fetchId.current) return;
				if (!res.ok) {
					const body = (await res.json().catch(() => null)) as
						| { error?: { message?: string } }
						| null;
					const message = body?.error?.message ?? `Error ${res.status}`;
					throw new Error(message);
				}
				const json = (await res.json()) as InsightsResponse;
				if (id !== fetchId.current) return;
				const next = new Map<string, NodeMetrics>();
				for (const row of json.per_node ?? []) {
					next.set(row.node_key, {
						executions: Number(row.executions ?? 0),
						success_rate: Number(row.success_rate ?? 0),
						per_port: row.per_port ?? {},
					});
				}
				setData(next);
			} catch (err) {
				if (id !== fetchId.current) return;
				setError(err instanceof Error ? err : new Error(String(err)));
				setData(new Map());
			} finally {
				if (id === fetchId.current) setLoading(false);
			}
		})();

		return () => {
			// Invalidate in-flight by bumping the fetch id.
			fetchId.current += 1;
		};
	}, [automationId, period, enabled, bump]);

	return {
		data,
		loading,
		error,
		refetch: () => setBump((b) => b + 1),
	};
}

// ---------------------------------------------------------------------------
// Badge component
// ---------------------------------------------------------------------------

interface NodeMetricBadgeProps {
	metrics: NodeMetrics | undefined;
	/**
	 * Anchor class — the badge is absolutely positioned to the top-right of
	 * the node. Consumers can override for alternate layouts.
	 */
	className?: string;
}

export function NodeMetricBadge({ metrics, className }: NodeMetricBadgeProps) {
	const [open, setOpen] = useState(false);
	const tone = toneForMetrics(metrics);
	const summary = summarizeMetrics(metrics);
	const ranked = useMemo(
		() => rankPorts(metrics?.per_port ?? {}),
		[metrics?.per_port],
	);
	const totalExits = useMemo(
		() => ranked.reduce((acc, row) => acc + row.count, 0),
		[ranked],
	);

	// Close on outside click.
	const rootRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!open) return;
		const handler = (event: MouseEvent) => {
			if (!rootRef.current) return;
			if (!rootRef.current.contains(event.target as Node)) setOpen(false);
		};
		window.addEventListener("mousedown", handler);
		return () => window.removeEventListener("mousedown", handler);
	}, [open]);

	return (
		<div
			ref={rootRef}
			className={cn(
				"absolute -top-2.5 right-2 z-10 nodrag nopan",
				className,
			)}
		>
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					setOpen((v) => !v);
				}}
				onMouseDown={(e) => e.stopPropagation()}
				className={cn(
					"inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold shadow-sm transition-colors",
					TONE_CLASSES[tone],
				)}
				title={
					metrics && metrics.executions > 0
						? `${summary.executionsLabel} executions · ${summary.rateLabel} success`
						: "No executions recorded in this period"
				}
			>
				<Zap className="size-3" />
				<span>{summary.executionsLabel}</span>
				{summary.rateLabel ? (
					<>
						<span className="opacity-50">·</span>
						<span>{summary.rateLabel}</span>
					</>
				) : null}
				{summary.topPort ? (
					<>
						<span className="opacity-50">→</span>
						<span className="max-w-[6rem] truncate">{summary.topPort}</span>
					</>
				) : null}
			</button>

			{open ? (
				<div
					className="absolute right-0 top-full z-20 mt-2 w-[15rem] rounded-lg border border-slate-200 bg-white p-2 text-[11px] shadow-lg"
					onMouseDown={(e) => e.stopPropagation()}
					onClick={(e) => e.stopPropagation()}
				>
					<div className="mb-1 flex items-center justify-between px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
						<span>Exits</span>
						{metrics ? (
							<span className="text-slate-500">
								{summary.rateLabel ?? "—"} success
							</span>
						) : null}
					</div>
					{ranked.length === 0 ? (
						<p className="px-1 py-2 text-slate-500">
							No recorded exits in this period.
						</p>
					) : (
						<ul className="space-y-1">
							{ranked.map((row) => {
								const share = totalExits > 0 ? row.count / totalExits : 0;
								return (
									<li
										key={row.port}
										className="flex items-center justify-between gap-2 rounded-md px-1 py-0.5"
									>
										<span className="truncate font-mono text-slate-700">
											{row.port}
										</span>
										<span className="shrink-0 tabular-nums text-slate-500">
											{row.count.toLocaleString()}
											<span className="ml-1 text-slate-400">
												({Math.round(share * 100)}%)
											</span>
										</span>
									</li>
								);
							})}
						</ul>
					)}
				</div>
			) : null}
		</div>
	);
}

// (Tests import helpers directly from ./node-overlays-helpers.)
