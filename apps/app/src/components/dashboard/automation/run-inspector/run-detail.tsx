// Run detail (Plan 3 — Unit C2, Tasks S1 / S5).
//
// Right-hand pane of the run inspector. Fetches a single run via
// `/api/automation-runs/{id}` and renders a compact header with tabs
// (Timeline / Context / Transcript). Provides the "Stop run" action for
// active/waiting runs via the `/api/automation-runs/{id}/stop` proxy.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ArrowRight,
	Clock,
	Loader2,
	MapPin,
	RefreshCw,
	StopCircle,
	User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Timeline } from "./timeline";
import { ContextViewer } from "./context-viewer";
import { Transcript } from "./transcript";
import { entrypointSummary, statusColor } from "./helpers";

// ---------------------------------------------------------------------------
// Types (mirror SDK AutomationRunResponse)
// ---------------------------------------------------------------------------

interface RunDetailResponse {
	id: string;
	automation_id: string;
	organization_id: string;
	entrypoint_id: string | null;
	binding_id: string | null;
	contact_id: string;
	conversation_id: string | null;
	status: string;
	current_node_key: string | null;
	current_port_key: string | null;
	context: Record<string, unknown> | null;
	waiting_until: string | null;
	waiting_for: string | null;
	exit_reason: string | null;
	started_at: string;
	completed_at: string | null;
	updated_at: string;
	// Optional hydration — present when the API decides to include them.
	contact?: { id: string; name?: string | null } | null;
	automation_name?: string | null;
	channel?: string | null;
}

type DetailTab = "timeline" | "context" | "transcript";

interface Props {
	runId: string | null;
	/**
	 * Optional callback so the detail page can jump the canvas tab to a node.
	 * Called when the user clicks "Show on canvas" from the header or from a
	 * timeline row.
	 */
	onShowOnCanvas?: (nodeKey: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RunDetail({ runId, onShowOnCanvas }: Props) {
	const [run, setRun] = useState<RunDetailResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<DetailTab>("timeline");
	const [toast, setToast] = useState<{
		type: "success" | "error";
		message: string;
	} | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [stopping, setStopping] = useState(false);

	const load = useCallback(async () => {
		if (!runId) return;
		setLoading(true);
		setError(null);
		try {
			const res = await fetch(`/api/automation-runs/${runId}`);
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.error?.message ?? `Error ${res.status}`);
			}
			const json = (await res.json()) as RunDetailResponse;
			setRun(json);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Network error");
		} finally {
			setLoading(false);
		}
	}, [runId]);

	useEffect(() => {
		if (!runId) {
			setRun(null);
			return;
		}
		setTab("timeline");
		void load();
	}, [runId, load]);

	useEffect(() => {
		if (!toast) return;
		const handle = window.setTimeout(() => setToast(null), 3000);
		return () => window.clearTimeout(handle);
	}, [toast]);

	const handleStop = useCallback(async () => {
		if (!runId) return;
		setStopping(true);
		try {
			const res = await fetch(`/api/automation-runs/${runId}/stop`, {
				method: "POST",
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.error?.message ?? `Error ${res.status}`);
			}
			setToast({ type: "success", message: "Run stopped" });
			setConfirmOpen(false);
			await load();
		} catch (e) {
			setToast({
				type: "error",
				message: e instanceof Error ? e.message : "Failed to stop run",
			});
		} finally {
			setStopping(false);
		}
	}, [runId, load]);

	const canStop = useMemo(() => {
		if (!run) return false;
		return run.status === "active" || run.status === "waiting";
	}, [run]);

	if (!runId) {
		return (
			<div className="flex flex-1 items-center justify-center p-6">
				<p className="max-w-sm text-center text-sm text-muted-foreground">
					Select a run from the list to inspect its timeline, context, and
					transcript.
				</p>
			</div>
		);
	}

	if (loading && !run) {
		return (
			<div className="flex flex-1 items-center justify-center p-6">
				<Loader2 className="size-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (error || !run) {
		return (
			<div className="flex flex-1 items-center justify-center p-6">
				<div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive">
					{error ?? "Run not found"}
				</div>
			</div>
		);
	}

	const contactLabel = run.contact?.name ?? run.contact?.id ?? run.contact_id;
	const isTerminal =
		run.status === "completed" ||
		run.status === "exited" ||
		run.status === "failed";

	return (
		<div className="flex min-w-0 flex-1 flex-col bg-background">
			{/* ---------- Header ---------- */}
			<div className="shrink-0 border-b border-border px-4 py-3">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0 space-y-1">
						<div className="flex items-center gap-2">
							<h2 className="truncate text-sm font-semibold">
								{run.automation_name ?? "Automation run"}
							</h2>
							<span
								className={cn(
									"rounded-full border px-1.5 py-0 text-[10px] font-medium",
									statusColor(run.status),
								)}
							>
								{run.status}
							</span>
						</div>
						<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
							<span className="inline-flex items-center gap-1">
								<User className="size-3" />
								{contactLabel}
							</span>
							<span className="inline-flex items-center gap-1">
								<ArrowRight className="size-3" />
								{entrypointSummary(run)}
							</span>
							<span className="inline-flex items-center gap-1">
								<Clock className="size-3" />
								{formatDate(run.started_at)}
							</span>
							{run.current_node_key && run.status === "waiting" && (
								<span className="inline-flex items-center gap-1 text-amber-600">
									<MapPin className="size-3" />
									at <span className="font-mono">{run.current_node_key}</span>
								</span>
							)}
							{isTerminal && run.exit_reason && (
								<span className="text-muted-foreground/80">
									· {run.exit_reason}
								</span>
							)}
						</div>
					</div>

					<div className="flex shrink-0 items-center gap-1.5">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => void load()}
							className="h-7 w-7 p-0"
							title="Refresh"
						>
							<RefreshCw
								className={cn(
									"size-3.5",
									loading && "animate-spin",
								)}
							/>
						</Button>
						{onShowOnCanvas && run.current_node_key && (
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									run.current_node_key &&
									onShowOnCanvas(run.current_node_key)
								}
								className="h-7 gap-1 text-[11px]"
							>
								<MapPin className="size-3" />
								Show on canvas
							</Button>
						)}
						{canStop && (
							<Button
								variant="destructive"
								size="sm"
								onClick={() => setConfirmOpen(true)}
								disabled={stopping}
								className="h-7 gap-1 text-[11px]"
							>
								<StopCircle className="size-3" />
								Stop run
							</Button>
						)}
					</div>
				</div>

				{/* Tabs */}
				<div className="mt-3 inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/30 p-0.5">
					<TabButton
						active={tab === "timeline"}
						onClick={() => setTab("timeline")}
						label="Timeline"
					/>
					<TabButton
						active={tab === "context"}
						onClick={() => setTab("context")}
						label="Context"
					/>
					<TabButton
						active={tab === "transcript"}
						onClick={() => setTab("transcript")}
						label="Transcript"
					/>
				</div>
			</div>

			{/* ---------- Toast ---------- */}
			{toast && (
				<div
					className={cn(
						"border-b px-4 py-2 text-xs",
						toast.type === "error"
							? "border-destructive/30 bg-destructive/10 text-destructive"
							: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
					)}
				>
					{toast.message}
				</div>
			)}

			{/* ---------- Body ---------- */}
			<div className="flex-1 min-h-0 overflow-hidden">
				{tab === "timeline" && (
					<div className="h-full overflow-auto">
						<Timeline runId={run.id} onShowOnCanvas={onShowOnCanvas} />
					</div>
				)}
				{tab === "context" && <ContextViewer context={run.context} />}
				{tab === "transcript" && (
					<Transcript
						runId={run.id}
						conversationId={run.conversation_id}
						channel={run.channel ?? undefined}
						contactName={run.contact?.name ?? null}
					/>
				)}
			</div>

			{/* ---------- Stop confirmation ---------- */}
			<Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Stop this run?</DialogTitle>
						<DialogDescription>
							This will force-exit the run. It will be marked as exited with
							exit_reason <span className="font-mono">admin_stopped</span>. Any
							pending step will not execute.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setConfirmOpen(false)}
							disabled={stopping}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={() => void handleStop()}
							disabled={stopping}
						>
							{stopping ? (
								<>
									<Loader2 className="mr-1.5 size-3.5 animate-spin" />
									Stopping
								</>
							) : (
								"Stop run"
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function TabButton({
	active,
	onClick,
	label,
}: {
	active: boolean;
	onClick: () => void;
	label: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
				active
					? "bg-background text-foreground shadow-sm"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{label}
		</button>
	);
}

function formatDate(s: string): string {
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) return s;
	return d.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
