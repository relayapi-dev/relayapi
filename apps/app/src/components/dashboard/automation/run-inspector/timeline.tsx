// Run timeline (Plan 3 — Unit C2, Task S2).
//
// Vertical list of step_runs for a given run. Hits the
// `/api/automation-runs/{id}/steps` proxy which fans out to the SDK's
// `automationRuns.listSteps` call. Rows are collapsible — expanding a row
// shows the raw payload + error JSON.

import { useCallback, useEffect, useState } from "react";
import {
	Bot,
	ChevronDown,
	ChevronRight,
	Circle,
	CheckCircle2,
	Clock,
	CornerDownRight,
	GitBranch,
	Globe,
	Loader2,
	MessageSquare,
	MinusCircle,
	Play,
	Shuffle,
	StopCircle,
	XCircle,
	Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
	formatDuration,
	nodeKindIcon,
	outcomeAccent,
	outcomeIcon,
} from "./helpers";

interface StepRow {
	id: string;
	run_id: string;
	automation_id: string;
	node_key: string;
	node_kind: string;
	entered_via_port_key: string | null;
	exited_via_port_key: string | null;
	outcome: string;
	duration_ms: number;
	payload: unknown | null;
	error: unknown | null;
	executed_at: string;
}

interface StepListResponse {
	data: StepRow[];
	next_cursor: string | null;
	has_more: boolean;
}

interface Props {
	runId: string;
	/** Optional callback so the caller can jump the canvas to a node. */
	onShowOnCanvas?: (nodeKey: string) => void;
}

// Icon resolvers — helpers return lucide string identifiers, we map to
// components here (keeps helpers pure for tests).
const NODE_ICONS: Record<string, React.ComponentType<{ className?: string }>> =
	{
		"message-square": MessageSquare,
		play: Play,
		clock: Clock,
		"git-branch": GitBranch,
		shuffle: Shuffle,
		zap: Zap,
		globe: Globe,
		"corner-down-right": CornerDownRight,
		"stop-circle": StopCircle,
		bot: Bot,
	};

const OUTCOME_ICONS: Record<
	string,
	React.ComponentType<{ className?: string }>
> = {
	"check-circle-2": CheckCircle2,
	"stop-circle": StopCircle,
	"minus-circle": MinusCircle,
	clock: Clock,
	"x-circle": XCircle,
	circle: Circle,
};

function resolveNodeIcon(kind: string) {
	return NODE_ICONS[nodeKindIcon(kind)] ?? Bot;
}
function resolveOutcomeIcon(outcome: string) {
	return OUTCOME_ICONS[outcomeIcon(outcome)] ?? Circle;
}

export function Timeline({ runId, onShowOnCanvas }: Props) {
	const [steps, setSteps] = useState<StepRow[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [hasMore, setHasMore] = useState(false);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	const load = useCallback(
		async (append: boolean) => {
			if (append) setLoadingMore(true);
			else setLoading(true);
			setError(null);
			try {
				const url = new URL(
					`/api/automation-runs/${runId}/steps`,
					window.location.origin,
				);
				url.searchParams.set("limit", "50");
				if (append && cursor) url.searchParams.set("cursor", cursor);
				const res = await fetch(url.toString());
				if (!res.ok) {
					const body = await res.json().catch(() => null);
					throw new Error(body?.error?.message ?? `Error ${res.status}`);
				}
				const json = (await res.json()) as StepListResponse;
				setSteps((prev) => (append ? [...prev, ...json.data] : json.data));
				setCursor(json.next_cursor);
				setHasMore(json.has_more);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Network error");
			} finally {
				if (append) setLoadingMore(false);
				else setLoading(false);
			}
		},
		[runId, cursor],
	);

	useEffect(() => {
		setSteps([]);
		setCursor(null);
		void load(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [runId]);

	const toggle = (id: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	if (loading) {
		return (
			<div className="flex justify-center py-8">
				<Loader2 className="size-4 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (error) {
		return (
			<div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
				{error}
			</div>
		);
	}

	if (steps.length === 0) {
		return (
			<p className="py-10 text-center text-xs text-muted-foreground">
				No steps recorded for this run yet.
			</p>
		);
	}

	return (
		<div className="space-y-2 p-3">
			{steps.map((s) => {
				const NodeIcon = resolveNodeIcon(s.node_kind);
				const OutcomeIcon = resolveOutcomeIcon(s.outcome);
				const isOpen = expanded.has(s.id);
				return (
					<div
						key={s.id}
						className={cn(
							"rounded-md border text-xs",
							outcomeAccent(s.outcome),
						)}
					>
						<button
							type="button"
							onClick={() => toggle(s.id)}
							className="flex w-full items-start gap-2 px-2 py-2 text-left"
						>
							<div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-background shadow-sm ring-1 ring-border">
								<NodeIcon className="size-3.5 text-muted-foreground" />
							</div>
							<div className="min-w-0 flex-1 space-y-0.5">
								<div className="flex items-center gap-1.5">
									<span className="truncate font-medium">{s.node_key}</span>
									<span className="rounded-sm bg-muted px-1 py-0 text-[10px] font-mono text-muted-foreground">
										{s.node_kind}
									</span>
								</div>
								<div className="flex items-center gap-1 text-[10px] text-muted-foreground">
									<span
										className={cn(
											"rounded px-1 py-0 font-mono",
											s.entered_via_port_key
												? "bg-sky-500/10 text-sky-700"
												: "text-muted-foreground/60",
										)}
									>
										{s.entered_via_port_key ?? "(none)"}
									</span>
									<span>→</span>
									<span
										className={cn(
											"rounded px-1 py-0 font-mono",
											s.exited_via_port_key
												? "bg-emerald-500/10 text-emerald-700"
												: "text-muted-foreground/60",
										)}
									>
										{s.exited_via_port_key ?? "(none)"}
									</span>
								</div>
								<div className="flex items-center gap-1.5 text-[10px]">
									<span className="inline-flex items-center gap-0.5 rounded border border-border bg-background px-1 py-0 text-muted-foreground">
										<OutcomeIcon className="size-2.5" />
										{s.outcome}
									</span>
									<span className="text-muted-foreground/70">
										{formatDuration(s.duration_ms)}
									</span>
								</div>
							</div>
							<div className="flex items-center gap-1">
								{onShowOnCanvas && (
									<span
										role="button"
										tabIndex={0}
										onClick={(e) => {
											e.stopPropagation();
											onShowOnCanvas(s.node_key);
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												e.stopPropagation();
												onShowOnCanvas(s.node_key);
											}
										}}
										className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
										title="Show on canvas"
									>
										Canvas
									</span>
								)}
								{isOpen ? (
									<ChevronDown className="size-3.5 text-muted-foreground" />
								) : (
									<ChevronRight className="size-3.5 text-muted-foreground" />
								)}
							</div>
						</button>

						{isOpen && (
							<div className="border-t border-border/50 bg-background/60 px-2 py-2 space-y-2">
								<JsonBlock label="Payload" value={s.payload} />
								{s.error != null && (
									<JsonBlock label="Error" value={s.error} tone="error" />
								)}
								<div className="text-[10px] text-muted-foreground/70">
									executed_at · {s.executed_at}
								</div>
							</div>
						)}
					</div>
				);
			})}

			{hasMore && (
				<button
					type="button"
					onClick={() => void load(true)}
					disabled={loadingMore}
					className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[11px] font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
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
			)}
		</div>
	);
}

function JsonBlock({
	label,
	value,
	tone,
}: {
	label: string;
	value: unknown;
	tone?: "error";
}) {
	const text = (() => {
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	})();
	return (
		<div>
			<div
				className={cn(
					"mb-1 text-[10px] font-semibold uppercase tracking-wide",
					tone === "error" ? "text-destructive" : "text-muted-foreground",
				)}
			>
				{label}
			</div>
			<pre
				className={cn(
					"max-h-64 overflow-auto rounded border bg-muted/40 p-2 text-[10px] leading-[1.4]",
					tone === "error" && "border-destructive/30 bg-destructive/5",
				)}
			>
				<code>{text || "—"}</code>
			</pre>
		</div>
	);
}
