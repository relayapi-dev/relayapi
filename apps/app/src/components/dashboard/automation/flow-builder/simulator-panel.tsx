import { useMemo, useState } from "react";
import { Play, Loader2, X, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AutomationDetail, AutomationSchema } from "./types";

interface SimulatedStep {
	node_id: string;
	node_key: string;
	node_type: string;
	branch_label: string | null;
	note: string | null;
}

interface SimulateResult {
	automation_id: string;
	version: number;
	path: SimulatedStep[];
	terminated: {
		kind: "complete" | "exit" | "step_cap" | "dead_end" | "cycle" | "unknown_node";
		reason?: string;
		node_key?: string;
	};
	error?: string;
}

interface Props {
	automation: AutomationDetail;
	schema: AutomationSchema;
	onClose: () => void;
	onHighlightPath: (nodeKeys: string[]) => void;
}

const INPUT_CLS =
	"h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground";

// Node types that actually branch. For these the user gets a key/value row in
// "branch choices" so they can force a specific outgoing label instead of the
// simulator's default.
function branchingNodes(automation: AutomationDetail): string[] {
	const keys: string[] = [];
	for (const n of automation.nodes) {
		if (
			n.type === "condition" ||
			n.type === "randomizer" ||
			n.type === "split_test" ||
			n.type === "ai_intent_router" ||
			n.type === "ai_agent" ||
			n.type.startsWith("user_input_")
		) {
			keys.push(n.key);
		}
	}
	return keys;
}

// For each terminated.kind, a user-readable label + color.
const TERMINATED_META: Record<SimulateResult["terminated"]["kind"], { label: string; cls: string }> = {
	complete: {
		label: "Completed",
		cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
	},
	exit: { label: "Exited", cls: "border-amber-500/30 bg-amber-500/10 text-amber-400" },
	step_cap: {
		label: "Hit step cap",
		cls: "border-amber-500/30 bg-amber-500/10 text-amber-400",
	},
	dead_end: {
		label: "Dead end",
		cls: "border-destructive/30 bg-destructive/10 text-destructive",
	},
	cycle: {
		label: "Cycle detected",
		cls: "border-destructive/30 bg-destructive/10 text-destructive",
	},
	unknown_node: {
		label: "Unknown node",
		cls: "border-destructive/30 bg-destructive/10 text-destructive",
	},
};

export function SimulatorPanel({
	automation,
	schema,
	onClose,
	onHighlightPath,
}: Props) {
	const triggerDef = useMemo(
		() => schema.triggers.find((t) => t.type === automation.trigger_type),
		[schema, automation.trigger_type],
	);
	const branchKeys = useMemo(() => branchingNodes(automation), [automation]);

	const [branchChoices, setBranchChoices] = useState<Record<string, string>>({});
	const [maxSteps, setMaxSteps] = useState(50);
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<SimulateResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	const setChoice = (key: string, value: string) => {
		setBranchChoices((prev) => {
			const next = { ...prev };
			if (value.trim() === "") delete next[key];
			else next[key] = value;
			return next;
		});
	};

	const run = async () => {
		setLoading(true);
		setError(null);
		setResult(null);

		try {
			const res = await fetch(`/api/automations/${automation.id}/simulate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					branch_choices:
						Object.keys(branchChoices).length > 0 ? branchChoices : undefined,
					max_steps: maxSteps,
				}),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				setError(body?.error?.message ?? `Error ${res.status}`);
			} else {
				const json = (await res.json()) as SimulateResult;
				setResult(json);
				onHighlightPath(json.path.map((s) => s.node_key));
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : "Network error");
		} finally {
			setLoading(false);
		}
	};

	const clear = () => {
		setResult(null);
		setError(null);
		onHighlightPath([]);
	};

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

			<div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
				{triggerDef && (
					<div className="rounded-md border border-border/60 bg-card/50 px-2 py-1.5">
						<div className="text-[10px] font-medium text-muted-foreground">
							Trigger
						</div>
						<div className="text-[11px] font-mono mt-0.5">{triggerDef.type}</div>
						{triggerDef.description && (
							<p className="text-[10px] text-muted-foreground/80 mt-0.5">
								{triggerDef.description}
							</p>
						)}
					</div>
				)}

				{branchKeys.length > 0 && (
					<div>
						<label className="text-[10px] font-medium text-muted-foreground block mb-1">
							Branch choices
						</label>
						<p className="text-[10px] text-muted-foreground/70 mb-1.5">
							Force a specific outgoing label on branching nodes. Leave blank for the
							simulator's default.
						</p>
						<div className="space-y-1">
							{branchKeys.map((key) => (
								<div key={key} className="flex items-center gap-1.5">
									<span className="text-[11px] font-mono text-muted-foreground w-28 truncate">
										{key}
									</span>
									<input
										type="text"
										value={branchChoices[key] ?? ""}
										onChange={(e) => setChoice(key, e.target.value)}
										placeholder="label (e.g. yes)"
										className={INPUT_CLS}
									/>
								</div>
							))}
						</div>
					</div>
				)}

				<div>
					<label className="text-[10px] font-medium text-muted-foreground block mb-1">
						Max steps
					</label>
					<input
						type="number"
						min={1}
						max={200}
						value={maxSteps}
						onChange={(e) =>
							setMaxSteps(Math.max(1, Math.min(200, Number(e.target.value) || 50)))
						}
						className={INPUT_CLS}
					/>
				</div>

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
					Run simulation
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
								Executed path ({result.path.length} step
								{result.path.length === 1 ? "" : "s"})
							</h4>
							<button
								type="button"
								onClick={clear}
								className="text-[10px] text-muted-foreground hover:text-foreground"
							>
								clear
							</button>
						</div>

						<div
							className={cn(
								"rounded-md border px-2 py-1.5 text-[11px]",
								TERMINATED_META[result.terminated.kind].cls,
							)}
						>
							<div className="font-medium">
								{TERMINATED_META[result.terminated.kind].label}
							</div>
							{result.terminated.reason && (
								<div className="opacity-80 mt-0.5">{result.terminated.reason}</div>
							)}
						</div>

						<ol className="space-y-1">
							{result.path.map((step, i) => (
								<li
									key={i}
									className="rounded-md border border-border bg-card px-2 py-1.5 text-[11px]"
								>
									<div className="flex items-center gap-1.5">
										<CheckCircle2 className="size-3 text-emerald-400" />
										<span className="font-medium font-mono">{step.node_key}</span>
										<span className="text-muted-foreground">
											· {step.node_type.replace(/_/g, " ")}
										</span>
										{step.branch_label && (
											<span className="ml-auto rounded-full bg-muted px-1.5 py-0 text-[9px] font-medium text-muted-foreground">
												→ {step.branch_label}
											</span>
										)}
									</div>
									{step.note && (
										<div className="mt-0.5 text-muted-foreground/80">
											{step.note}
										</div>
									)}
								</li>
							))}
						</ol>
					</div>
				)}

			</div>
		</div>
	);
}
