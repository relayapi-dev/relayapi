// Insights panel (Plan 3 — Unit C1, Task R3).
//
// Reads aggregated run metrics from `/v1/automations/{id}/insights?period=X`.
// Period selector drives the query; totals/tiles/exit-reasons/per-entrypoint/
// per-node are rendered inline. No charting library — simple HTML/Tailwind.

import { useMemo, useState } from "react";
import { BarChart3, Loader2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useApi } from "@/hooks/use-api";
import { PANEL_BODY_CLS, PANEL_SHELL_CLS, PanelHeader } from "./panel-styles";

// ---------------------------------------------------------------------------
// Types — mirror SDK AutomationInsightsResponse
// ---------------------------------------------------------------------------

type InsightsPeriod = "24h" | "7d" | "30d" | "90d";

interface InsightsResponse {
	period: { from: string; to: string };
	totals: {
		enrolled: number;
		completed: number;
		exited: number;
		failed: number;
		active: number;
		waiting: number;
		avg_duration_ms: number;
	};
	exit_reasons: Array<{ reason: string; count: number }>;
	by_entrypoint: Array<{
		entrypoint_id: string | null;
		kind: string | null;
		runs: number;
		completion_rate: number;
	}>;
	per_node: Array<{
		node_key: string;
		kind: string;
		executions: number;
		success_rate: number;
	}>;
}

interface Props {
	automationId: string;
	onClose: () => void;
}

const PERIOD_LABELS: Record<InsightsPeriod, string> = {
	"24h": "24h",
	"7d": "7d",
	"30d": "30d",
	"90d": "90d",
};

function formatRate(value: number): string {
	if (!Number.isFinite(value)) return "—";
	return `${Math.round(value * 100)}%`;
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const sec = ms / 1000;
	if (sec < 60) return `${sec.toFixed(1)}s`;
	const min = sec / 60;
	if (min < 60) return `${min.toFixed(1)}m`;
	const hr = min / 60;
	return `${hr.toFixed(1)}h`;
}

export function InsightsPanel({ automationId, onClose }: Props) {
	const [period, setPeriod] = useState<InsightsPeriod>("7d");
	const { data, loading, error } = useApi<InsightsResponse>(
		`automations/${automationId}/insights`,
		{ query: { period } },
	);

	const totals = data?.totals;

	const isEmpty = useMemo(() => {
		if (!totals) return true;
		return (
			totals.enrolled === 0 &&
			totals.active === 0 &&
			totals.waiting === 0 &&
			totals.completed === 0 &&
			totals.exited === 0 &&
			totals.failed === 0
		);
	}, [totals]);

	const maxExitReason = useMemo(() => {
		if (!data?.exit_reasons.length) return 0;
		return Math.max(...data.exit_reasons.map((r) => r.count));
	}, [data?.exit_reasons]);

	return (
		<div className={cn(PANEL_SHELL_CLS, "min-w-0 flex-1 md:w-96 md:flex-none")}>
			<PanelHeader
				icon={<BarChart3 className="size-[18px]" />}
				title="Insights"
				subtitle="Totals, exit reasons, entrypoints, and per-node metrics"
				onClose={onClose}
			/>

			{/* Period selector */}
			<div className="border-b border-[#eef0f4] px-4 py-3">
				<div className="flex items-center gap-1 rounded-lg border border-[#e6e9ef] bg-[#f4f5f7] p-0.5">
					{(Object.keys(PERIOD_LABELS) as InsightsPeriod[]).map((p) => (
						<button
							key={p}
							type="button"
							onClick={() => setPeriod(p)}
							className={cn(
								"flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
								period === p
									? "bg-white text-[#353a44] shadow-sm"
									: "text-[#8b92a0] hover:text-[#353a44]",
							)}
						>
							{PERIOD_LABELS[p]}
						</button>
					))}
				</div>
			</div>

			<ScrollArea className={PANEL_BODY_CLS}>
				<div className="px-4 py-4 space-y-3">
					{loading ? (
						<div className="flex justify-center py-8">
							<Loader2 className="size-4 animate-spin text-muted-foreground" />
						</div>
					) : error ? (
						<div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
							{error}
						</div>
					) : !data || isEmpty || !totals ? (
						<div className="rounded-xl border border-[#e6e9ef] bg-white px-3 py-6 text-[11px] text-[#8b92a0] text-center">
							No runs in this period.
						</div>
					) : (
						<>
							{/* Totals tiles */}
							<div className="grid grid-cols-2 gap-2">
								<Tile label="Enrolled" value={totals.enrolled} />
								<Tile
									label="Live"
									value={totals.active + totals.waiting}
								/>
								<Tile label="Completed" value={totals.completed} />
								<Tile label="Failed" value={totals.failed} />
								<Tile label="Exited" value={totals.exited} />
								<Tile
									label="Avg duration"
									value={formatDuration(totals.avg_duration_ms)}
								/>
							</div>

							{/* Exit reasons */}
							<Section title="Exit reasons">
								{data.exit_reasons.length === 0 ? (
									<p className="text-[11px] text-muted-foreground">None.</p>
								) : (
									<ul className="space-y-1">
										{data.exit_reasons.map((row) => (
											<li key={row.reason}>
												<div className="flex items-center justify-between text-[11px]">
													<span>{row.reason}</span>
													<span className="font-medium text-muted-foreground">
														{row.count}
													</span>
												</div>
												<div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-[#eef0f4]">
													<div
														className="h-full bg-[#9aa3b2]"
														style={{
															width: `${maxExitReason > 0 ? (row.count / maxExitReason) * 100 : 0}%`,
														}}
													/>
												</div>
											</li>
										))}
									</ul>
								)}
							</Section>

							{/* By entrypoint */}
							<Section title="By entrypoint">
								{data.by_entrypoint.length === 0 ? (
									<p className="text-[11px] text-muted-foreground">
										No entrypoint runs recorded.
									</p>
								) : (
									<table className="w-full text-[11px]">
										<thead>
											<tr className="text-[10px] text-muted-foreground">
												<th className="text-left font-medium py-1">Entrypoint</th>
												<th className="text-right font-medium py-1">Runs</th>
												<th className="text-right font-medium py-1">Completion</th>
											</tr>
										</thead>
										<tbody>
											{data.by_entrypoint.map((row, i) => (
												<tr
													key={row.entrypoint_id ?? `manual-${i}`}
													className="border-t border-border/60"
												>
													<td className="py-1 pr-2">
														<div className="font-medium">
															{row.kind ?? "manual"}
														</div>
														{row.entrypoint_id && (
															<div className="font-mono text-[10px] text-muted-foreground truncate">
																{row.entrypoint_id}
															</div>
														)}
													</td>
													<td className="py-1 text-right font-medium">
														{row.runs}
													</td>
													<td className="py-1 text-right text-muted-foreground">
														{formatRate(row.completion_rate)}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								)}
							</Section>

							{/* Per node */}
							<Section title="Per node">
								{data.per_node.length === 0 ? (
									<p className="text-[11px] text-muted-foreground">
										No node executions yet.
									</p>
								) : (
									<table className="w-full text-[11px]">
										<thead>
											<tr className="text-[10px] text-muted-foreground">
												<th className="text-left font-medium py-1">Node</th>
												<th className="text-right font-medium py-1">Executions</th>
												<th className="text-right font-medium py-1">Success</th>
											</tr>
										</thead>
										<tbody>
											{data.per_node.map((row) => (
												<tr
													key={row.node_key}
													className="border-t border-border/60"
												>
													<td className="py-1 pr-2">
														<div className="font-mono font-medium truncate max-w-[10rem]">
															{row.node_key}
														</div>
														<div className="text-[10px] text-muted-foreground">
															{row.kind}
														</div>
													</td>
													<td className="py-1 text-right font-medium">
														{row.executions}
													</td>
													<td className="py-1 text-right text-muted-foreground">
														{formatRate(row.success_rate)}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								)}
							</Section>
						</>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function Tile({ label, value }: { label: string; value: string | number }) {
	return (
		<div className="rounded-xl border border-[#e6e9ef] bg-white px-3 py-2.5">
			<div className="text-[10px] text-[#8b92a0]">{label}</div>
			<div className="mt-1 text-sm font-semibold text-[#353a44]">
				{typeof value === "number" ? value.toLocaleString() : value}
			</div>
		</div>
	);
}

function Section({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div className="rounded-xl border border-[#e6e9ef] bg-white px-3 py-2.5">
			<div className="text-[10px] font-medium text-[#8b92a0] mb-2">
				{title}
			</div>
			{children}
		</div>
	);
}
