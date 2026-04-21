// Simulator panel (Plan 3 — Unit C1, Task R1).
//
// Dry-runs the automation graph via the new `/v1/automations/{id}/simulate`
// endpoint (`execute_side_effects: false`). Walks the current in-memory graph
// from the store so the simulator reflects unsaved edits.

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { derivePorts } from "./derive-ports";
import type { AutomationGraph } from "./graph-types";

// ---------------------------------------------------------------------------
// Types (mirror SDK AutomationSimulateResponse)
// ---------------------------------------------------------------------------

interface SimulateStep {
	node_key: string;
	node_kind: string;
	entered_via_port_key: string | null;
	exited_via_port_key: string | null;
	outcome: "advance" | "wait_input" | "wait_delay" | "end" | "fail";
	payload?: unknown;
}

interface SimulateResponse {
	steps: SimulateStep[];
	ended_at_node: string | null;
	exit_reason: string;
	elapsed_ms?: number;
}

interface Props {
	automationId: string;
	graph: AutomationGraph;
	onClose: () => void;
	onHighlightPath?: (nodeKeys: string[]) => void;
}

const INPUT_CLS =
	"h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground";

const BRANCHING_KINDS = new Set(["condition", "randomizer", "input"]);

const OUTCOME_META: Record<
	SimulateStep["outcome"],
	{ label: string; cls: string }
> = {
	advance: {
		label: "Advanced",
		cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
	},
	wait_input: {
		label: "Waiting for input",
		cls: "border-sky-500/30 bg-sky-500/10 text-sky-600",
	},
	wait_delay: {
		label: "Waiting",
		cls: "border-sky-500/30 bg-sky-500/10 text-sky-600",
	},
	end: {
		label: "Ended",
		cls: "border-neutral-500/30 bg-neutral-500/10 text-neutral-600",
	},
	fail: {
		label: "Failed",
		cls: "border-destructive/30 bg-destructive/10 text-destructive",
	},
};

function outputPortsFor(
	graph: AutomationGraph,
	nodeKey: string,
): { key: string; label: string }[] {
	const node = graph.nodes.find((n) => n.key === nodeKey);
	if (!node) return [];
	const ports = derivePorts({ kind: node.kind, config: node.config });
	return ports
		.filter((p) => p.direction === "output")
		.map((p) => ({ key: p.key, label: p.label ?? p.key }));
}

function formatPayload(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function SimulatorPanel({
	automationId,
	graph,
	onClose,
	onHighlightPath,
}: Props) {
	const [startNodeKey, setStartNodeKey] = useState<string>("");
	const [branchChoices, setBranchChoices] = useState<Record<string, string>>(
		{},
	);
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<SimulateResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Record<number, boolean>>({});

	const branchingNodes = useMemo(() => {
		return graph.nodes
			.filter((n) => BRANCHING_KINDS.has(n.kind))
			.map((n) => ({
				key: n.key,
				kind: n.kind,
				ports: outputPortsFor(graph, n.key),
			}))
			.filter((n) => n.ports.length > 0);
	}, [graph]);

	const setChoice = (nodeKey: string, portKey: string) => {
		setBranchChoices((prev) => {
			const next = { ...prev };
			if (!portKey) delete next[nodeKey];
			else next[nodeKey] = portKey;
			return next;
		});
	};

	const run = async () => {
		setLoading(true);
		setError(null);
		setResult(null);
		try {
			const body: Record<string, unknown> = {
				test_context: {},
				execute_side_effects: false,
			};
			if (startNodeKey) body.start_node_key = startNodeKey;
			if (Object.keys(branchChoices).length > 0)
				body.branch_choices = branchChoices;

			const res = await fetch(`/api/automations/${automationId}/simulate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => null);
				setError(err?.error?.message ?? `Error ${res.status}`);
				return;
			}
			const json = (await res.json()) as SimulateResponse;
			setResult(json);
			onHighlightPath?.(json.steps.map((s) => s.node_key));
		} catch (e) {
			setError(e instanceof Error ? e.message : "Network error");
		} finally {
			setLoading(false);
		}
	};

	const clear = () => {
		setResult(null);
		setError(null);
		setExpanded({});
		onHighlightPath?.([]);
	};

	const toggle = (idx: number) =>
		setExpanded((prev) => ({ ...prev, [idx]: !prev[idx] }));

	return (
		<div className="w-80 border-l border-border bg-card/30 flex flex-col overflow-hidden">
			<div className="px-3 py-2 border-b border-border flex items-center justify-between">
				<div>
					<h3 className="text-xs font-medium">Simulator</h3>
					<p className="text-[10px] text-muted-foreground mt-0.5">
						Dry-run the graph — no sends, no side effects
					</p>
				</div>
				<button
					type="button"
					onClick={() => {
						clear();
						onClose();
					}}
					className="text-muted-foreground hover:text-foreground"
				>
					<X className="size-3.5" />
				</button>
			</div>

			<ScrollArea className="flex-1">
				<div className="px-3 py-3 space-y-3">
					<div>
						<label className="text-[10px] font-medium text-muted-foreground block mb-1">
							Start node
						</label>
						<select
							value={startNodeKey}
							onChange={(e) => setStartNodeKey(e.target.value)}
							className={INPUT_CLS}
						>
							<option value="">
								Root{graph.root_node_key ? ` (${graph.root_node_key})` : ""}
							</option>
							{graph.nodes.map((n) => (
								<option key={n.key} value={n.key}>
									{n.key} · {n.kind}
								</option>
							))}
						</select>
						<p className="text-[10px] text-muted-foreground/70 mt-0.5">
							Leave blank to start from the root.
						</p>
					</div>

					{branchingNodes.length > 0 && (
						<div>
							<label className="text-[10px] font-medium text-muted-foreground block mb-1">
								Branch choices
							</label>
							<p className="text-[10px] text-muted-foreground/70 mb-1.5">
								Force an output port on branching nodes. Blank = simulator
								picks the default.
							</p>
							<div className="space-y-1">
								{branchingNodes.map((node) => (
									<div key={node.key} className="flex items-center gap-1.5">
										<span className="text-[11px] font-mono text-muted-foreground w-28 truncate">
											{node.key}
										</span>
										<select
											value={branchChoices[node.key] ?? ""}
											onChange={(e) => setChoice(node.key, e.target.value)}
											className={INPUT_CLS}
										>
											<option value="">Default</option>
											{node.ports.map((port) => (
												<option key={port.key} value={port.key}>
													{port.label}
												</option>
											))}
										</select>
									</div>
								))}
							</div>
						</div>
					)}

					<Button
						onClick={run}
						disabled={loading}
						size="sm"
						className="w-full h-7 text-xs gap-1.5"
					>
						{loading ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<Play className="size-3.5" />
						)}
						Simulate
					</Button>

					{error && (
						<div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
							{error}
						</div>
					)}

					{result && (
						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<h4 className="text-[10px] font-medium text-muted-foreground">
									{result.steps.length} step
									{result.steps.length === 1 ? "" : "s"}
									{result.elapsed_ms !== undefined && (
										<span className="ml-1">· {result.elapsed_ms}ms</span>
									)}
								</h4>
								<button
									type="button"
									onClick={clear}
									className="text-[10px] text-muted-foreground hover:text-foreground"
								>
									clear
								</button>
							</div>

							<div className="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-[11px]">
								<div className="font-medium">
									{result.exit_reason || "ended"}
								</div>
								{result.ended_at_node && (
									<div className="text-[10px] font-mono text-muted-foreground mt-0.5">
										at {result.ended_at_node}
									</div>
								)}
							</div>

							<ol className="space-y-1">
								{result.steps.map((step, i) => {
									const meta = OUTCOME_META[step.outcome] ?? {
										label: step.outcome,
										cls: "border-border bg-card text-foreground",
									};
									const payloadText = formatPayload(step.payload);
									const isOpen = !!expanded[i];
									return (
										<li
											key={i}
											className="rounded-md border border-border bg-card px-2 py-1.5 text-[11px]"
										>
											<div className="flex items-center gap-1.5">
												<span className="font-medium font-mono">
													{step.node_key}
												</span>
												<span className="text-muted-foreground">
													· {step.node_kind.replace(/_/g, " ")}
												</span>
												<span
													className={cn(
														"ml-auto rounded-full border px-1.5 py-0 text-[9px] font-medium",
														meta.cls,
													)}
												>
													{meta.label}
												</span>
											</div>
											{(step.entered_via_port_key || step.exited_via_port_key) && (
												<div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
													<span className="font-mono">
														{step.entered_via_port_key ?? "—"}
													</span>
													<span>→</span>
													<span className="font-mono">
														{step.exited_via_port_key ?? "—"}
													</span>
												</div>
											)}
											{payloadText && (
												<div className="mt-1">
													<button
														type="button"
														onClick={() => toggle(i)}
														className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
													>
														{isOpen ? (
															<ChevronDown className="size-3" />
														) : (
															<ChevronRight className="size-3" />
														)}
														Payload
													</button>
													{isOpen && (
														<pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border bg-muted/30 px-2 py-1.5 text-[10px] whitespace-pre-wrap break-all">
															{payloadText}
														</pre>
													)}
												</div>
											)}
										</li>
									);
								})}
							</ol>
						</div>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
