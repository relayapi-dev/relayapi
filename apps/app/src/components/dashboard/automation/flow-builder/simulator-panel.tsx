import { useEffect, useMemo, useState } from "react";
import { Play, Loader2, X, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { resolveNodeOutputLabels } from "./output-labels";
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

interface EnrollResult {
	enrollment_id: string;
}

interface SampleResult {
	data: Array<{
		enrollment_id: string;
		automation_version: number;
		trigger_id: string | null;
		contact_id: string | null;
		conversation_id: string | null;
		status: string;
		state: unknown;
		enrolled_at: string;
	}>;
}

interface Props {
	automation: AutomationDetail;
	schema: AutomationSchema;
	onClose: () => void;
	onHighlightPath: (nodeKeys: string[]) => void;
}

const INPUT_CLS =
	"h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground";

interface BranchChoiceField {
	key: string;
	labels: string[];
}

function branchingNodes(
	automation: AutomationDetail,
	schema: AutomationSchema,
): BranchChoiceField[] {
	const schemaByType = new Map(schema.nodes.map((node) => [node.type, node]));
	return automation.nodes
		.map((node) => ({
			key: node.key,
			labels: resolveNodeOutputLabels(node, schemaByType.get(node.type) ?? null),
		}))
		.filter((node) => node.labels.length > 1);
}

function describeTrigger(
	trigger: AutomationDetail["triggers"][number],
): string {
	return `${trigger.label} · ${trigger.type.replace(/_/g, " ")}`;
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
	const triggerDefs = useMemo(
		() =>
			automation.triggers
				.map((t) => schema.triggers.find((s) => s.type === t.type))
				.filter((def): def is NonNullable<typeof def> => def !== undefined),
		[schema, automation.triggers],
	);
	const branchKeys = useMemo(() => branchingNodes(automation, schema), [automation, schema]);

	const [branchChoices, setBranchChoices] = useState<Record<string, string>>({});
	const [maxSteps, setMaxSteps] = useState(50);
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<SimulateResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [liveTestTriggerId, setLiveTestTriggerId] = useState("");
	const [liveTestContactId, setLiveTestContactId] = useState("");
	const [liveTestConversationId, setLiveTestConversationId] = useState("");
	const [liveTestPayload, setLiveTestPayload] = useState("{}");
	const [liveTestLoading, setLiveTestLoading] = useState(false);
	const [liveTestError, setLiveTestError] = useState<string | null>(null);
	const [liveTestResult, setLiveTestResult] = useState<EnrollResult | null>(null);
	const [samples, setSamples] = useState<SampleResult["data"]>([]);
	const [samplesLoading, setSamplesLoading] = useState(false);
	const [samplesError, setSamplesError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		const loadSamples = async () => {
			setSamplesLoading(true);
			setSamplesError(null);
			try {
				const res = await fetch(`/api/automations/${automation.id}/samples?limit=5`);
				if (!res.ok) {
					const body = await res.json().catch(() => null);
					if (!cancelled) {
						setSamplesError(body?.error?.message ?? `Error ${res.status}`);
					}
					return;
				}
				const json = (await res.json()) as SampleResult;
				if (!cancelled) {
					setSamples(json.data ?? []);
				}
			} catch (err) {
				if (!cancelled) {
					setSamplesError(err instanceof Error ? err.message : "Network error");
				}
			} finally {
				if (!cancelled) setSamplesLoading(false);
			}
		};
		void loadSamples();
		return () => {
			cancelled = true;
		};
	}, [automation.id]);

	useEffect(() => {
		setLiveTestTriggerId((current) => {
			if (
				current &&
				automation.triggers.some((trigger) => trigger.id === current)
			) {
				return current;
			}
			return automation.triggers.length === 1
				? automation.triggers[0]!.id
				: "";
		});
	}, [automation.triggers]);

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

	const runLiveTest = async () => {
		setLiveTestLoading(true);
		setLiveTestError(null);
		setLiveTestResult(null);

		const selectedTriggerId =
			liveTestTriggerId || (automation.triggers.length === 1
				? automation.triggers[0]!.id
				: "");
		if (!selectedTriggerId) {
			setLiveTestError(
				"Choose which trigger context to use for this live test.",
			);
			setLiveTestLoading(false);
			return;
		}

		let parsedPayload: Record<string, unknown> | undefined;
		try {
			const trimmed = liveTestPayload.trim();
			if (trimmed) {
				const parsed = JSON.parse(trimmed);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					parsedPayload = parsed as Record<string, unknown>;
				} else {
					setLiveTestError("Payload must be a JSON object.");
					setLiveTestLoading(false);
					return;
				}
			}
		} catch (err) {
			setLiveTestError(err instanceof Error ? err.message : "Invalid JSON payload");
			setLiveTestLoading(false);
			return;
		}

		try {
			const res = await fetch(`/api/automations/${automation.id}/enroll`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					trigger_id: selectedTriggerId,
					contact_id: liveTestContactId.trim() || undefined,
					conversation_id: liveTestConversationId.trim() || undefined,
					payload: parsedPayload,
				}),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				setLiveTestError(body?.error?.message ?? `Error ${res.status}`);
			} else {
				setLiveTestResult((await res.json()) as EnrollResult);
			}
		} catch (err) {
			setLiveTestError(err instanceof Error ? err.message : "Network error");
		} finally {
			setLiveTestLoading(false);
		}
	};

	const applySample = (sample: SampleResult["data"][number]) => {
		if (
			sample.trigger_id &&
			automation.triggers.some((trigger) => trigger.id === sample.trigger_id)
		) {
			setLiveTestTriggerId(sample.trigger_id);
		}
		setLiveTestContactId(sample.contact_id ?? "");
		setLiveTestConversationId(sample.conversation_id ?? "");
		try {
			setLiveTestPayload(JSON.stringify(sample.state ?? {}, null, 2));
		} catch {
			setLiveTestPayload("{}");
		}
		setLiveTestError(null);
		setLiveTestResult(null);
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

			<ScrollArea className="flex-1">
				<div className="px-3 py-3 space-y-3">
				{triggerDefs.length > 0 && (
					<div className="rounded-md border border-border/60 bg-card/50 px-2 py-1.5 space-y-1">
						<div className="text-[10px] font-medium text-muted-foreground">
							{triggerDefs.length === 1 ? "Trigger" : "Triggers"}
						</div>
						{triggerDefs.map((def) => (
							<div key={def.type} className="space-y-0.5">
								<div className="text-[11px] font-mono">{def.type}</div>
								{def.description && (
									<p className="text-[10px] text-muted-foreground/80">
										{def.description}
									</p>
								)}
							</div>
						))}
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
							{branchKeys.map((branch) => (
								<div key={branch.key} className="flex items-center gap-1.5">
									<span className="text-[11px] font-mono text-muted-foreground w-28 truncate">
										{branch.key}
									</span>
									{branch.labels.length <= 6 ? (
										<select
											value={branchChoices[branch.key] ?? ""}
											onChange={(e) => setChoice(branch.key, e.target.value)}
											className={INPUT_CLS}
										>
											<option value="">Default</option>
											{branch.labels.map((label) => (
												<option key={label} value={label}>
													{label}
												</option>
											))}
										</select>
									) : (
										<input
											type="text"
											value={branchChoices[branch.key] ?? ""}
											onChange={(e) => setChoice(branch.key, e.target.value)}
											placeholder={`label (${branch.labels[0] ?? "branch"})`}
											className={INPUT_CLS}
										/>
									)}
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

				<div className="border-t border-border pt-3 space-y-2">
					<div>
						<h4 className="text-[10px] font-medium text-muted-foreground">
							Live test
						</h4>
						<p className="text-[10px] text-muted-foreground/70 mt-0.5">
							Queue a real enrollment. This executes actual steps and can send
							messages or call webhooks.
						</p>
					</div>

					<div className="rounded-md border border-border/70 bg-card/50 px-2.5 py-2 space-y-2">
						<div className="flex items-center justify-between gap-2">
							<div>
								<div className="text-[10px] font-medium text-muted-foreground">
									Recent samples
								</div>
								<p className="text-[10px] text-muted-foreground/70 mt-0.5">
									Reuse recent enrollment payloads as test input.
								</p>
							</div>
							{samplesLoading && (
								<Loader2 className="size-3.5 animate-spin text-muted-foreground" />
							)}
						</div>
						{samplesError ? (
							<div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
								{samplesError}
							</div>
						) : samples.length === 0 ? (
							<p className="text-[10px] text-muted-foreground/70">
								No captured samples yet. Run the automation once or queue a live
								test to populate this list.
							</p>
						) : (
							<div className="space-y-1.5">
								{samples.map((sample) => (
									<div
										key={sample.enrollment_id}
										className="rounded-md border border-border bg-background/80 px-2 py-1.5"
									>
										<div className="flex items-center justify-between gap-2">
											<div className="min-w-0">
												<div className="text-[11px] font-medium font-mono truncate">
													{sample.enrollment_id}
												</div>
												<div className="text-[10px] text-muted-foreground/70">
													v{sample.automation_version} · {sample.status}
												</div>
											</div>
											<Button
												type="button"
												size="sm"
												variant="outline"
												className="h-6 px-2 text-[10px]"
												onClick={() => applySample(sample)}
											>
												Use sample
											</Button>
										</div>
										<div className="mt-1 text-[10px] text-muted-foreground/70">
											{sample.contact_id ? `Contact ${sample.contact_id}` : "No contact"} ·{" "}
											{sample.conversation_id
												? `Conversation ${sample.conversation_id}`
												: "No conversation"}
										</div>
									</div>
								))}
							</div>
						)}
					</div>

					<div>
						<label className="text-[10px] font-medium text-muted-foreground block mb-1">
							Trigger context
						</label>
						<select
							value={liveTestTriggerId}
							onChange={(e) => setLiveTestTriggerId(e.target.value)}
							className={INPUT_CLS}
						>
							<option value="">
								{automation.triggers.length > 1
									? "Choose trigger"
									: "Use the automation trigger"}
							</option>
							{automation.triggers.map((trigger) => (
								<option key={trigger.id} value={trigger.id}>
									{describeTrigger(trigger)}
								</option>
							))}
						</select>
						<p className="text-[10px] text-muted-foreground/70 mt-0.5">
							Selects the trigger/account context used for this enrollment.
						</p>
					</div>

					<div>
						<label className="text-[10px] font-medium text-muted-foreground block mb-1">
							Contact ID
						</label>
						<input
							type="text"
							value={liveTestContactId}
							onChange={(e) => setLiveTestContactId(e.target.value)}
							placeholder="Optional contact id (ct_...)"
							className={INPUT_CLS}
						/>
					</div>

					<div>
						<label className="text-[10px] font-medium text-muted-foreground block mb-1">
							Conversation ID
						</label>
						<input
							type="text"
							value={liveTestConversationId}
							onChange={(e) => setLiveTestConversationId(e.target.value)}
							placeholder="Optional conversation id"
							className={INPUT_CLS}
						/>
					</div>

					<div>
						<label className="text-[10px] font-medium text-muted-foreground block mb-1">
							Initial payload
						</label>
						<textarea
							value={liveTestPayload}
							onChange={(e) => setLiveTestPayload(e.target.value)}
							rows={5}
							className="w-full text-xs font-mono rounded-md border border-input bg-background px-2 py-1.5 resize-y"
						/>
						<p className="text-[10px] text-muted-foreground/70 mt-0.5">
							Available to the workflow as <span className="font-mono">state.*</span>.
						</p>
					</div>

					<Button
						onClick={runLiveTest}
						disabled={liveTestLoading}
						size="sm"
						variant="outline"
						className="w-full h-7 text-xs gap-1.5"
					>
						{liveTestLoading ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<Play className="size-3.5" />
						)}
						Queue live test
					</Button>

					{liveTestError && (
						<div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
							{liveTestError}
						</div>
					)}

					{liveTestResult && (
						<div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-400">
							Enrollment queued:{" "}
							<span className="font-mono">{liveTestResult.enrollment_id}</span>
						</div>
					)}
				</div>
				</div>
			</ScrollArea>
		</div>
	);
}
