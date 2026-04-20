import { useEffect, useMemo, useState } from "react";
import {
	ChevronRight,
	History,
	Loader2,
	RefreshCw,
	X,
	CheckCircle2,
	XCircle,
	CircleDot,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface EnrollmentRow {
	id: string;
	trigger_id: string | null;
	contact_id: string | null;
	conversation_id: string | null;
	state: unknown;
	status: string;
	enrolled_at: string;
	completed_at: string | null;
}

interface EnrollmentListResponse {
	data: EnrollmentRow[];
	has_more: boolean;
	next_cursor: string | null;
}

interface RunLogRow {
	id: string;
	node_id: string | null;
	node_key: string | null;
	node_type: string | null;
	node_config: Record<string, unknown> | null;
	executed_at: string;
	outcome: string;
	branch_label: string | null;
	duration_ms: number | null;
	error: string | null;
	payload: unknown | null;
}

// Runner outcomes (from runner.ts): ok | complete | exit | wait |
// wait_for_input | goto | failed. Anything in `FAIL_OUTCOMES` renders red,
// `SUCCESS_OUTCOMES` render green, everything else is neutral.
const SUCCESS_OUTCOMES = new Set(["ok", "complete"]);
const FAIL_OUTCOMES = new Set(["failed", "fail", "error"]);

interface RunListResponse {
	data: RunLogRow[];
}

interface Props {
	automationId: string;
	onClose: () => void;
	onHighlightPath: (nodeKeys: string[]) => void;
}

function formatDate(s: string) {
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) return s;
	return d.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function formatJson(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

// Enrollment statuses emitted by the API: active | waiting | completed |
// exited | failed.
function statusColor(status: string) {
	switch (status) {
		case "completed":
			return "text-emerald-400 bg-emerald-400/10";
		case "active":
		case "waiting":
			return "text-sky-400 bg-sky-400/10";
		case "failed":
			return "text-destructive bg-destructive/10";
		case "exited":
			return "text-neutral-400 bg-neutral-400/10";
		default:
			return "text-muted-foreground bg-muted";
	}
}

export function RunHistoryPanel({
	automationId,
	onClose,
	onHighlightPath,
}: Props) {
	const [enrollments, setEnrollments] = useState<EnrollmentRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
	const [runs, setRuns] = useState<RunLogRow[]>([]);
	const [runsLoading, setRunsLoading] = useState(false);
	const [rerunLoading, setRerunLoading] = useState(false);
	const [rerunMessage, setRerunMessage] = useState<string | null>(null);

	const loadEnrollments = () => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		fetch(`/api/automations/${automationId}/enrollments?limit=20`)
			.then(async (res) => {
				if (!res.ok) {
					const body = await res.json().catch(() => null);
					throw new Error(body?.error?.message ?? `Error ${res.status}`);
				}
				return res.json() as Promise<EnrollmentListResponse>;
			})
			.then((data) => {
				if (!cancelled) setEnrollments(data.data ?? []);
			})
			.catch((e) => {
				if (!cancelled)
					setError(e instanceof Error ? e.message : "Network error");
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	};

	useEffect(() => {
		return loadEnrollments();
	}, [automationId]);

	useEffect(() => {
		if (!selected) {
			setRuns([]);
			setSelectedRunId(null);
			setRerunMessage(null);
			onHighlightPath([]);
			return;
		}
		let cancelled = false;
		setRunsLoading(true);
		fetch(`/api/automations/${automationId}/enrollments/${selected}/runs`)
			.then(async (res) => {
				if (!res.ok) {
					const body = await res.json().catch(() => null);
					throw new Error(body?.error?.message ?? `Error ${res.status}`);
				}
				return res.json() as Promise<RunListResponse>;
			})
			.then((data) => {
				if (cancelled) return;
				const nextRuns = data.data ?? [];
				setRuns(nextRuns);
				setSelectedRunId((prev) =>
					prev && nextRuns.some((run) => run.id === prev)
						? prev
						: (nextRuns[0]?.id ?? null),
				);
				// Highlight via node_key since the canvas is keyed by node.key,
				// not the database node_id.
				const path = nextRuns
					.map((r) => r.node_key)
					.filter((k): k is string => typeof k === "string");
				onHighlightPath(path);
			})
			.catch((e) => {
				if (!cancelled)
					setError(e instanceof Error ? e.message : "Network error");
			})
			.finally(() => {
				if (!cancelled) setRunsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [automationId, selected, onHighlightPath]);

	const selectedEnrollment = useMemo(
		() => enrollments.find((e) => e.id === selected) ?? null,
		[enrollments, selected],
	);
	const selectedRun = useMemo(
		() => runs.find((run) => run.id === selectedRunId) ?? null,
		[runs, selectedRunId],
	);
	const selectedRunPayload = useMemo(
		() => asRecord(selectedRun?.payload),
		[selectedRun],
	);

	const payloadText = useMemo(
		() => formatJson(selectedRun?.payload),
		[selectedRun],
	);
	const enrollmentStateText = useMemo(
		() => formatJson(selectedEnrollment?.state),
		[selectedEnrollment],
	);
	const nodeConfigText = useMemo(
		() => formatJson(selectedRun?.node_config),
		[selectedRun],
	);
	const stateBeforeText = useMemo(
		() => formatJson(selectedRunPayload?.state_before),
		[selectedRunPayload],
	);
	const statePatchText = useMemo(
		() => formatJson(selectedRunPayload?.state_patch),
		[selectedRunPayload],
	);
	const stateAfterText = useMemo(
		() => formatJson(selectedRunPayload?.state_after),
		[selectedRunPayload],
	);
	const transitionText = useMemo(() => {
		if (!selectedRunPayload) return null;
		const resultKind = selectedRunPayload.result_kind;
		if (typeof resultKind !== "string") return null;
		if (resultKind === "next") {
			const outputLabel =
				typeof selectedRunPayload.output_label === "string"
					? selectedRunPayload.output_label
					: (selectedRun?.branch_label ?? null);
			const nextNodeKey =
				typeof selectedRunPayload.next_node_key === "string"
					? selectedRunPayload.next_node_key
					: null;
			return [
				outputLabel ? `Output ${outputLabel}` : null,
				nextNodeKey ? `to ${nextNodeKey}` : null,
			]
				.filter(Boolean)
				.join(" ");
		}
		if (resultKind === "goto") {
			return typeof selectedRunPayload.target_node_key === "string"
				? `Jumped to ${selectedRunPayload.target_node_key}`
				: "Jumped to target node";
		}
		if (resultKind === "wait") {
			return typeof selectedRunPayload.next_run_at === "string"
				? `Waiting until ${formatDate(selectedRunPayload.next_run_at)}`
				: "Waiting for scheduled resume";
		}
		if (resultKind === "wait_for_input") return "Waiting for user input";
		if (resultKind === "complete") {
			return typeof selectedRunPayload.reason === "string"
				? `Completed: ${selectedRunPayload.reason}`
				: "Completed";
		}
		if (resultKind === "exit") {
			return typeof selectedRunPayload.reason === "string"
				? `Exited: ${selectedRunPayload.reason}`
				: "Exited";
		}
		if (resultKind === "fail") {
			return typeof selectedRunPayload.error === "string"
				? selectedRunPayload.error
				: (selectedRun?.error ?? null);
		}
		return resultKind;
	}, [selectedRun, selectedRunPayload]);

	const rerunEnrollment = async () => {
		if (!selectedEnrollment) return;
		setRerunLoading(true);
		setRerunMessage(null);
		const replayPayload =
			asRecord(asRecord(runs[0]?.payload)?.state_before) ??
			(selectedEnrollment.state &&
			typeof selectedEnrollment.state === "object" &&
			!Array.isArray(selectedEnrollment.state)
				? (selectedEnrollment.state as Record<string, unknown>)
				: undefined);
		try {
			const res = await fetch(`/api/automations/${automationId}/enroll`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					trigger_id: selectedEnrollment.trigger_id ?? undefined,
					contact_id: selectedEnrollment.contact_id ?? undefined,
					conversation_id: selectedEnrollment.conversation_id ?? undefined,
					payload: replayPayload,
				}),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.error?.message ?? `Error ${res.status}`);
			}
			const json = (await res.json()) as { enrollment_id?: string };
			setRerunMessage(
				json.enrollment_id
					? `Queued new enrollment ${json.enrollment_id}`
					: "Enrollment queued",
			);
			loadEnrollments();
		} catch (e) {
			setRerunMessage(
				e instanceof Error ? e.message : "Failed to rerun enrollment",
			);
		} finally {
			setRerunLoading(false);
		}
	};

	return (
		<div className="w-80 border-l border-border bg-card/30 flex flex-col overflow-hidden">
			<div className="px-3 py-2 border-b border-border flex items-center justify-between">
				<div>
					<h3 className="text-xs font-medium flex items-center gap-1.5">
						<History className="size-3.5" />
						Run history
					</h3>
					<p className="text-[10px] text-muted-foreground mt-0.5">
						Recent enrollments and step logs
					</p>
				</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={() => loadEnrollments()}
						className="text-muted-foreground hover:text-foreground"
						title="Refresh"
					>
						<RefreshCw className="size-3.5" />
					</button>
					<button
						type="button"
						onClick={() => {
							onHighlightPath([]);
							onClose();
						}}
						className="text-muted-foreground hover:text-foreground"
					>
						<X className="size-3.5" />
					</button>
				</div>
			</div>

			{selected && selectedEnrollment ? (
				<ScrollArea className="flex-1">
					<button
						type="button"
						onClick={() => {
							setSelected(null);
							setSelectedRunId(null);
						}}
						className="w-full px-3 py-2 text-left text-[11px] text-muted-foreground hover:text-foreground border-b border-border flex items-center gap-1"
					>
						<ChevronRight className="size-3 rotate-180" />
						Back to enrollments
					</button>
					<div className="px-3 py-2 border-b border-border space-y-1">
						<div className="flex items-center justify-between gap-2">
							<span className="text-[10px] text-muted-foreground">
								Enrollment
							</span>
							<span
								className={cn(
									"rounded-full px-2 py-0.5 text-[10px] font-medium",
									statusColor(selectedEnrollment.status),
								)}
							>
								{selectedEnrollment.status}
							</span>
						</div>
						<div className="text-[11px] font-mono truncate">
							{selectedEnrollment.id}
						</div>
						<div className="text-[10px] text-muted-foreground">
							Contact: {selectedEnrollment.contact_id ?? "—"}
						</div>
						<div className="text-[10px] text-muted-foreground">
							Trigger: {selectedEnrollment.trigger_id ?? "—"}
						</div>
						<div className="text-[10px] text-muted-foreground">
							Conversation: {selectedEnrollment.conversation_id ?? "—"}
						</div>
						<div className="text-[10px] text-muted-foreground">
							{formatDate(selectedEnrollment.enrolled_at)}
							{selectedEnrollment.completed_at &&
								` → ${formatDate(selectedEnrollment.completed_at)}`}
						</div>
						<div className="pt-1">
							<button
								type="button"
								onClick={rerunEnrollment}
								disabled={rerunLoading}
								className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[10px] font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
							>
								{rerunLoading ? (
									<Loader2 className="size-3 animate-spin" />
								) : (
									<RefreshCw className="size-3" />
								)}
								Replay enrollment
							</button>
							{rerunMessage && (
								<p className="mt-1 text-[10px] text-muted-foreground">
									{rerunMessage}
								</p>
							)}
						</div>
						{enrollmentStateText && (
							<div className="pt-1">
								<div className="text-[10px] font-medium text-muted-foreground mb-1">
									Enrollment state
								</div>
								<pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/30 px-2 py-1.5 text-[10px] text-foreground whitespace-pre-wrap break-all">
									{enrollmentStateText}
								</pre>
							</div>
						)}
					</div>
					<div className="px-3 py-2 space-y-2">
						{runsLoading ? (
							<div className="flex justify-center py-6">
								<Loader2 className="size-4 animate-spin text-muted-foreground" />
							</div>
						) : runs.length === 0 ? (
							<p className="text-[11px] text-muted-foreground text-center py-6">
								No run logs yet.
							</p>
						) : (
							<>
								<ol className="space-y-1.5">
									{runs.map((r) => (
										<li
											key={r.id}
											className={cn(
												"rounded-md border px-2 py-1.5 text-[11px]",
												SUCCESS_OUTCOMES.has(r.outcome)
													? "border-emerald-500/30 bg-emerald-500/5"
													: FAIL_OUTCOMES.has(r.outcome)
														? "border-destructive/30 bg-destructive/5"
														: "border-border bg-card",
												selectedRunId === r.id && "ring-2 ring-ring/30",
											)}
										>
											<button
												type="button"
												onClick={() =>
													setSelectedRunId((prev) =>
														prev === r.id ? null : r.id,
													)
												}
												className="w-full text-left"
											>
												<div className="flex items-center gap-1.5">
													{SUCCESS_OUTCOMES.has(r.outcome) ? (
														<CheckCircle2 className="size-3 text-emerald-400" />
													) : FAIL_OUTCOMES.has(r.outcome) ? (
														<XCircle className="size-3 text-destructive" />
													) : (
														<CircleDot className="size-3 text-muted-foreground" />
													)}
													<span className="font-medium truncate">
														{r.node_key ?? r.node_id ?? "(system)"}
													</span>
													{r.branch_label && (
														<span className="ml-auto rounded-full bg-muted px-1.5 py-0 text-[9px] font-medium text-muted-foreground">
															→ {r.branch_label}
														</span>
													)}
												</div>
												<div className="flex items-center gap-2 mt-0.5 text-muted-foreground text-[10px]">
													{r.node_type && (
														<span>{r.node_type.replace(/_/g, " ")}</span>
													)}
													<span>·</span>
													<span>{formatDate(r.executed_at)}</span>
													{r.duration_ms !== null && (
														<>
															<span>·</span>
															<span>{r.duration_ms}ms</span>
														</>
													)}
												</div>
												{r.error && (
													<div className="mt-0.5 text-destructive/80 text-[10px]">
														{r.error}
													</div>
												)}
											</button>
										</li>
									))}
								</ol>
								{selectedRun && (
									<div className="rounded-md border border-border bg-card px-2 py-2">
										<div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
											Step detail
										</div>
										<div className="mt-1 text-[11px] font-medium">
											{selectedRun.node_key ??
												selectedRun.node_id ??
												"(system)"}
										</div>
										<div className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
											<span>Outcome: {selectedRun.outcome}</span>
											{selectedRun.branch_label && (
												<span>Branch: {selectedRun.branch_label}</span>
											)}
											{selectedRun.node_type && (
												<span>Node: {selectedRun.node_type}</span>
											)}
											{selectedRun.duration_ms !== null && (
												<span>Duration: {selectedRun.duration_ms}ms</span>
											)}
											<span>
												Executed: {formatDate(selectedRun.executed_at)}
											</span>
										</div>
										{selectedRun.error && (
											<div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
												{selectedRun.error}
											</div>
										)}
										{transitionText && (
											<div className="mt-2 rounded-md border border-border bg-muted/20 px-2 py-1.5 text-[10px] text-foreground">
												<div className="mb-1 font-medium text-muted-foreground">
													Transition
												</div>
												<div>{transitionText}</div>
											</div>
										)}
										<JsonBlock title="Node config" value={nodeConfigText} />
										<JsonBlock title="State before" value={stateBeforeText} />
										<JsonBlock title="State patch" value={statePatchText} />
										<JsonBlock title="State after" value={stateAfterText} />
										<JsonBlock
											title="Raw log payload"
											value={payloadText}
											maxHeightClassName="max-h-52"
										/>
									</div>
								)}
							</>
						)}
					</div>
				</ScrollArea>
			) : (
				<ScrollArea className="flex-1">
					{loading ? (
						<div className="flex justify-center py-10">
							<Loader2 className="size-4 animate-spin text-muted-foreground" />
						</div>
					) : error ? (
						<div className="m-3 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
							{error}
						</div>
					) : enrollments.length === 0 ? (
						<p className="text-[11px] text-muted-foreground text-center py-10 px-4">
							No enrollments yet. Publish the automation and trigger it to see
							runs here.
						</p>
					) : (
						<ul>
							{enrollments.map((e) => (
								<li key={e.id}>
									<button
										type="button"
										onClick={() => setSelected(e.id)}
										className="w-full px-3 py-2 text-left hover:bg-accent/30 border-b border-border/60 text-[11px] flex items-start justify-between gap-2"
									>
										<div className="min-w-0 flex-1">
											<div className="font-mono text-[10px] truncate">
												{e.id}
											</div>
											<div className="text-muted-foreground text-[10px] mt-0.5">
												{e.contact_id ?? "no contact"} ·{" "}
												{formatDate(e.enrolled_at)}
											</div>
										</div>
										<span
											className={cn(
												"rounded-full px-1.5 py-0 text-[10px] font-medium shrink-0",
												statusColor(e.status),
											)}
										>
											{e.status}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</ScrollArea>
			)}
		</div>
	);
}

function JsonBlock({
	title,
	value,
	maxHeightClassName = "max-h-40",
}: {
	title: string;
	value: string | null;
	maxHeightClassName?: string;
}) {
	if (!value) return null;
	return (
		<div className="mt-2">
			<div className="mb-1 text-[10px] font-medium text-muted-foreground">
				{title}
			</div>
			<pre
				className={cn(
					"overflow-auto rounded-md border border-border bg-muted/30 px-2 py-1.5 text-[10px] text-foreground whitespace-pre-wrap break-all",
					maxHeightClassName,
				)}
			>
				{value}
			</pre>
		</div>
	);
}
