// Run history panel (Plan 3 — Unit C1, Task R2).
//
// Lists automation runs via the new `/v1/automations/{id}/runs` endpoint.
// Emits `onSelectRun(runId)` when a row is clicked; the full run inspector is
// built in Unit C2. Until then we surface the current node / waiting state /
// exit reason inline so operators can see the status of each run.

import { useCallback, useEffect, useRef, useState } from "react";
import {
	History,
	Loader2,
	RefreshCw,
	X,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types — mirror SDK AutomationRunResponse (plus optional contact hydration)
// ---------------------------------------------------------------------------

interface RunContact {
	id: string;
	name?: string | null;
}

interface RunRow {
	id: string;
	automation_id: string;
	organization_id: string;
	entrypoint_id: string | null;
	binding_id: string | null;
	contact_id: string;
	contact?: RunContact | null;
	conversation_id: string | null;
	status: string;
	current_node_key: string | null;
	current_port_key: string | null;
	waiting_until: string | null;
	waiting_for: string | null;
	exit_reason: string | null;
	started_at: string;
	completed_at: string | null;
	updated_at: string;
}

interface RunListResponse {
	data: RunRow[];
	next_cursor: string | null;
	has_more: boolean;
}

type StatusFilter = "" | "active" | "waiting" | "completed" | "exited" | "failed";

interface Props {
	automationId: string;
	onClose: () => void;
	onSelectRun?: (runId: string) => void;
	/** Kept for backwards compatibility with the legacy detail page. */
	onHighlightPath?: (nodeKeys: string[]) => void;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatRelative(s: string | null): string {
	if (!s) return "—";
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) return s;
	const diff = Date.now() - d.getTime();
	const sec = Math.round(diff / 1000);
	if (sec < 60) return `${sec}s ago`;
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.round(hr / 24);
	if (day < 7) return `${day}d ago`;
	return d.toLocaleDateString();
}

function formatDuration(
	startedAt: string,
	completedAt: string | null,
): string | null {
	if (!completedAt) return null;
	const start = new Date(startedAt).getTime();
	const end = new Date(completedAt).getTime();
	if (Number.isNaN(start) || Number.isNaN(end)) return null;
	const ms = Math.max(0, end - start);
	if (ms < 1000) return `${ms}ms`;
	const sec = Math.round(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.round(min / 60);
	return `${hr}h`;
}

function statusColor(status: string): string {
	switch (status) {
		case "completed":
			return "text-emerald-600 bg-emerald-500/10 border-emerald-500/30";
		case "active":
			return "text-sky-600 bg-sky-500/10 border-sky-500/30";
		case "waiting":
			return "text-amber-600 bg-amber-500/10 border-amber-500/30";
		case "failed":
			return "text-destructive bg-destructive/10 border-destructive/30";
		case "exited":
			return "text-neutral-600 bg-neutral-500/10 border-neutral-500/30";
		default:
			return "text-muted-foreground bg-muted border-border";
	}
}

function contactLabel(run: RunRow): string {
	return run.contact?.name || run.contact?.id || run.contact_id;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RunHistoryPanel({
	automationId,
	onClose,
	onSelectRun,
	onHighlightPath,
}: Props) {
	const [runs, setRuns] = useState<RunRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [cursor, setCursor] = useState<string | null>(null);
	const [hasMore, setHasMore] = useState(false);
	const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

	const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
	const [contactFilter, setContactFilter] = useState("");

	const highlightRef = useRef(onHighlightPath);
	highlightRef.current = onHighlightPath;

	const buildUrl = useCallback(
		(append: boolean): string => {
			const url = new URL(
				`/api/automations/${automationId}/runs`,
				window.location.origin,
			);
			url.searchParams.set("limit", "20");
			if (append && cursor) url.searchParams.set("cursor", cursor);
			if (statusFilter) url.searchParams.set("status", statusFilter);
			if (contactFilter.trim())
				url.searchParams.set("contact_id", contactFilter.trim());
			return url.toString();
		},
		[automationId, cursor, statusFilter, contactFilter],
	);

	const loadRuns = useCallback(
		async (append: boolean) => {
			if (append) setLoadingMore(true);
			else setLoading(true);
			setError(null);
			try {
				const res = await fetch(buildUrl(append));
				if (!res.ok) {
					const body = await res.json().catch(() => null);
					throw new Error(body?.error?.message ?? `Error ${res.status}`);
				}
				const json = (await res.json()) as RunListResponse;
				setRuns((prev) => (append ? [...prev, ...json.data] : json.data));
				setCursor(json.next_cursor);
				setHasMore(json.has_more);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Network error");
			} finally {
				if (append) setLoadingMore(false);
				else setLoading(false);
			}
		},
		[buildUrl],
	);

	// Reload on filter change (resets cursor)
	useEffect(() => {
		setCursor(null);
		setRuns([]);
		void loadRuns(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [automationId, statusFilter, contactFilter]);

	// When the user selects a run, emit the event + legacy highlight callback.
	useEffect(() => {
		if (!selectedRunId) {
			highlightRef.current?.([]);
			return;
		}
		const run = runs.find((r) => r.id === selectedRunId);
		if (run?.current_node_key) {
			highlightRef.current?.([run.current_node_key]);
		} else {
			highlightRef.current?.([]);
		}
	}, [selectedRunId, runs]);

	const handleSelect = (runId: string) => {
		setSelectedRunId((prev) => (prev === runId ? null : runId));
		if (onSelectRun) onSelectRun(runId);
	};

	const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;

	return (
		<div className="w-80 border-l border-border bg-card/30 flex flex-col overflow-hidden">
			<div className="px-3 py-2 border-b border-border flex items-center justify-between">
				<div>
					<h3 className="text-xs font-medium flex items-center gap-1.5">
						<History className="size-3.5" />
						Runs
					</h3>
					<p className="text-[10px] text-muted-foreground mt-0.5">
						Recent runs for this automation
					</p>
				</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={() => {
							setCursor(null);
							void loadRuns(false);
						}}
						className="text-muted-foreground hover:text-foreground"
						title="Refresh"
					>
						<RefreshCw className="size-3.5" />
					</button>
					<button
						type="button"
						onClick={onClose}
						className="text-muted-foreground hover:text-foreground"
					>
						<X className="size-3.5" />
					</button>
				</div>
			</div>

			{/* Filters */}
			<div className="border-b border-border px-3 py-2 space-y-1.5">
				<select
					value={statusFilter}
					onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
					className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs"
				>
					<option value="">All statuses</option>
					<option value="active">Active</option>
					<option value="waiting">Waiting</option>
					<option value="completed">Completed</option>
					<option value="exited">Exited</option>
					<option value="failed">Failed</option>
				</select>
				<input
					type="text"
					value={contactFilter}
					onChange={(e) => setContactFilter(e.target.value)}
					placeholder="Filter by contact id"
					className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs placeholder:text-muted-foreground"
				/>
			</div>

			<ScrollArea className="flex-1">
				{loading ? (
					<div className="flex justify-center py-10">
						<Loader2 className="size-4 animate-spin text-muted-foreground" />
					</div>
				) : error ? (
					<div className="m-3 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
						{error}
					</div>
				) : runs.length === 0 ? (
					<p className="text-[11px] text-muted-foreground text-center py-10 px-4">
						No runs yet. Activate this automation and trigger it to see runs
						here.
					</p>
				) : (
					<>
						<ul>
							{runs.map((r) => {
								const duration = formatDuration(r.started_at, r.completed_at);
								const isTerminal =
									r.status === "completed" ||
									r.status === "exited" ||
									r.status === "failed";
								const isSelected = selectedRunId === r.id;
								return (
									<li key={r.id}>
										<button
											type="button"
											onClick={() => handleSelect(r.id)}
											className={cn(
												"w-full px-3 py-2 text-left hover:bg-accent/30 border-b border-border/60 text-[11px]",
												isSelected && "bg-accent/40",
											)}
										>
											<div className="flex items-start justify-between gap-2">
												<div className="min-w-0 flex-1">
													<div className="truncate font-medium">
														{contactLabel(r)}
													</div>
													<div className="mt-0.5 text-[10px] text-muted-foreground">
														{formatRelative(r.started_at)}
														{duration && ` · ${duration}`}
													</div>
													{r.status === "waiting" && r.current_node_key && (
														<div className="mt-0.5 text-[10px] text-amber-600">
															at{" "}
															<span className="font-mono">
																{r.current_node_key}
															</span>
														</div>
													)}
													{isTerminal && r.exit_reason && (
														<div className="mt-0.5 text-[10px] text-muted-foreground">
															{r.exit_reason}
														</div>
													)}
												</div>
												<span
													className={cn(
														"shrink-0 rounded-full border px-1.5 py-0 text-[9px] font-medium",
														statusColor(r.status),
													)}
												>
													{r.status}
												</span>
											</div>
										</button>
									</li>
								);
							})}
						</ul>
						{hasMore && (
							<div className="p-2">
								<button
									type="button"
									onClick={() => void loadRuns(true)}
									disabled={loadingMore}
									className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
								>
									{loadingMore ? (
										<span className="inline-flex items-center gap-1">
											<Loader2 className="size-3 animate-spin" />
											Loading
										</span>
									) : (
										"Load more"
									)}
								</button>
							</div>
						)}

						{selectedRun && !onSelectRun && (
							<div className="border-t border-border bg-muted/20 px-3 py-3 text-[11px] space-y-1.5">
								<div className="font-semibold uppercase tracking-wide text-[10px] text-muted-foreground">
									Run preview
								</div>
								<div className="font-mono break-all">{selectedRun.id}</div>
								<div className="text-muted-foreground">
									Status: {selectedRun.status}
								</div>
								{selectedRun.current_node_key && (
									<div className="text-muted-foreground">
										Current node:{" "}
										<span className="font-mono">
											{selectedRun.current_node_key}
										</span>
									</div>
								)}
								{selectedRun.exit_reason && (
									<div className="text-muted-foreground">
										Exit reason: {selectedRun.exit_reason}
									</div>
								)}
								<div className="text-muted-foreground/70 text-[10px]">
									Full run inspector coming soon.
								</div>
							</div>
						)}
					</>
				)}
			</ScrollArea>
		</div>
	);
}
