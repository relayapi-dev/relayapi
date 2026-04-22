// Automation detail page.
//
// Wires the port-driven `<GuidedFlow>` canvas against the
// `AutomationResponse` shape. The graph lives in `useGraphStore`;
// autosave fires from inside `<GuidedFlow>` via the
// `/api/automations/{id}/graph` proxy. This page owns metadata (name /
// description / status), the entrypoint panel on the left, and the property
// panel on the right.
//
// Tabs:
//   - Canvas  → the GuidedFlow port-driven canvas
//   - Runs    → <RunInspector> — two-column layout (list + detail). Deep-links
//               via ?tab=runs&run_id=X. "Show on canvas" switches the tab
//               back to Canvas and selects the target node.
//   - Insights → <InsightsPanel> (migrated to /v1/automations/{id}/insights)
//
// Simulator + bindings stay accessible from the toolbar as side panels.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Archive,
	ArrowLeft,
	FlaskConical,
	Link2,
	Loader2,
	Pause,
	Play,
	PlayCircle,
	Redo2,
	Undo2,
	Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi, useMutation } from "@/hooks/use-api";
import { cn } from "@/lib/utils";
import { GuidedFlow } from "@/components/dashboard/automation/flow-builder/guided-flow";
import { PropertyPanel } from "@/components/dashboard/automation/flow-builder/property-panel";
import { SimulatorPanel } from "@/components/dashboard/automation/flow-builder/simulator-panel";
import { RunInspector } from "@/components/dashboard/automation/run-inspector";
import { BindingsPanel } from "@/components/dashboard/automation/flow-builder/bindings-panel";
import { InsightsPanel } from "@/components/dashboard/automation/flow-builder/insights-panel";
import { EntrypointPanel } from "@/components/dashboard/automation/flow-builder/entrypoint-panel";
import { useAutomationCatalog } from "@/components/dashboard/automation/flow-builder/use-catalog";
import {
	EMPTY_GRAPH,
	useGraphStore,
} from "@/components/dashboard/automation/flow-builder/use-graph-store";
import type { AutomationGraph } from "@/components/dashboard/automation/flow-builder/graph-types";

// ---------------------------------------------------------------------------
// API response typing — aligned with SDK AutomationResponse
// ---------------------------------------------------------------------------

interface ApiValidationError {
	node_key?: string;
	port_key?: string;
	edge_index?: number;
	code: string;
	message: string;
}

interface ApiAutomationResponse {
	id: string;
	organization_id: string;
	workspace_id: string | null;
	name: string;
	description: string | null;
	channel: string;
	status: "draft" | "active" | "paused" | "archived";
	graph: AutomationGraph;
	created_from_template: string | null;
	template_config: Record<string, unknown> | null;
	total_enrolled: number;
	total_completed: number;
	total_exited: number;
	total_failed: number;
	last_validated_at: string | null;
	validation_errors: ApiValidationError[] | null;
	created_by: string | null;
	created_at: string;
	updated_at: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
	automationId: string;
}

type TabKey = "canvas" | "runs" | "insights";
type SidePanel = "property" | "simulator" | "bindings";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AutomationDetailPage({ automationId }: Props) {
	const automationPath = `automations/${automationId}`;

	const {
		data: automation,
		loading: loadingAutomation,
		error: automationError,
		refetch: refetchAutomation,
	} = useApi<ApiAutomationResponse>(automationPath);

	const catalog = useAutomationCatalog();

	// ---- Graph store -------------------------------------------------------

	const graphStore = useGraphStore(EMPTY_GRAPH);
	const lastHydratedSignature = useRef<string | null>(null);

	// Hydrate the graph store on first load / on each refetch, but skip
	// re-hydration while the user has unsaved local edits so a background
	// refetch can't clobber their in-progress draft.
	useEffect(() => {
		if (!automation) return;
		if (graphStore.dirty) return;
		const signature = `${automation.id}:${automation.updated_at}`;
		if (lastHydratedSignature.current === signature) return;
		lastHydratedSignature.current = signature;
		graphStore.setGraph(automation.graph ?? EMPTY_GRAPH);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [automation?.id, automation?.updated_at, graphStore.dirty]);

	// ---- Local UI state ----------------------------------------------------

	const [tab, setTab] = useState<TabKey>(() => {
		if (typeof window === "undefined") return "canvas";
		try {
			const q = new URL(window.location.href).searchParams.get("tab");
			if (q === "runs" || q === "insights" || q === "canvas") return q;
		} catch {}
		return "canvas";
	});
	// Mirror `tab` into the URL via history.replaceState so deep-linking
	// (?tab=runs&run_id=X) survives refreshes without polluting the back stack.
	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			const url = new URL(window.location.href);
			if (tab === "canvas") url.searchParams.delete("tab");
			else url.searchParams.set("tab", tab);
			if (tab !== "runs") url.searchParams.delete("run_id");
			const qs = url.searchParams.toString();
			const next = `${url.pathname}${qs ? `?${qs}` : ""}${url.hash}`;
			window.history.replaceState(window.history.state, "", next);
		} catch {}
	}, [tab]);

	const handleShowRunOnCanvas = useCallback(
		(nodeKey: string) => {
			setTab("canvas");
			graphStore.setSelection([nodeKey]);
		},
		[graphStore],
	);

	const [sidePanel, setSidePanel] = useState<SidePanel>("property");
	const [banner, setBanner] = useState<{
		type: "error" | "success";
		message: string;
	} | null>(null);

	// ---- Status transitions ------------------------------------------------

	const activateAutomation = useMutation<ApiAutomationResponse>(
		`${automationPath}/activate`,
		"POST",
	);
	const pauseAutomation = useMutation<ApiAutomationResponse>(
		`${automationPath}/pause`,
		"POST",
	);
	const resumeAutomation = useMutation<ApiAutomationResponse>(
		`${automationPath}/resume`,
		"POST",
	);
	const archiveAutomation = useMutation<ApiAutomationResponse>(
		`${automationPath}/archive`,
		"POST",
	);
	const unarchiveAutomation = useMutation<ApiAutomationResponse>(
		`${automationPath}/unarchive`,
		"POST",
	);
	const updateAutomation = useMutation<ApiAutomationResponse>(
		automationPath,
		"PATCH",
	);

	const handleActivate = useCallback(async () => {
		setBanner(null);
		const res = await activateAutomation.mutate();
		if (res) {
			refetchAutomation();
			setBanner({ type: "success", message: "Activated" });
		} else if (activateAutomation.error) {
			setBanner({ type: "error", message: activateAutomation.error });
		}
	}, [activateAutomation, refetchAutomation]);

	const handlePauseResume = useCallback(async () => {
		if (!automation) return;
		setBanner(null);
		const m = automation.status === "active" ? pauseAutomation : resumeAutomation;
		const res = await m.mutate();
		if (res) refetchAutomation();
		else if (m.error) setBanner({ type: "error", message: m.error });
	}, [automation, pauseAutomation, resumeAutomation, refetchAutomation]);

	const handleArchive = useCallback(async () => {
		if (!automation) return;
		setBanner(null);
		if (automation.status === "archived") {
			const res = await unarchiveAutomation.mutate();
			if (res) refetchAutomation();
			else if (unarchiveAutomation.error)
				setBanner({ type: "error", message: unarchiveAutomation.error });
			return;
		}
		if (
			!confirm(
				"Archive this automation? It will stop processing new enrollments.",
			)
		)
			return;
		const res = await archiveAutomation.mutate();
		if (res) {
			window.location.href = "/app/automation";
		} else if (archiveAutomation.error) {
			setBanner({ type: "error", message: archiveAutomation.error });
		}
	}, [automation, archiveAutomation, unarchiveAutomation, refetchAutomation]);

	// ---- Name editing (debounced PATCH) -----------------------------------

	const [nameDraft, setNameDraft] = useState<string>("");
	useEffect(() => {
		setNameDraft(automation?.name ?? "");
	}, [automation?.name]);

	const commitName = useCallback(() => {
		if (!automation) return;
		if (nameDraft.trim() === "" || nameDraft === automation.name) return;
		void updateAutomation.mutate({ name: nameDraft.trim() });
	}, [automation, nameDraft, updateAutomation]);

	// ---- Selection → sidepanel dispatch -----------------------------------

	const selection = graphStore.selection;
	const selectedNode = useMemo(() => {
		if (selection.length !== 1) return null;
		return graphStore.graph.nodes.find((n) => n.key === selection[0]) ?? null;
	}, [graphStore.graph.nodes, selection]);

	// When the user selects a node, the right panel should show property editor.
	useEffect(() => {
		if (selection.length > 0) setSidePanel("property");
	}, [selection.length]);

	// ---- Render ------------------------------------------------------------

	const loading = loadingAutomation;
	if (loading) {
		return (
			<div className="flex items-center justify-center py-20">
				<Loader2 className="size-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (automationError || !automation) {
		return (
			<div className="space-y-4 p-4">
				<a
					href="/app/automation"
					className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft className="size-3.5" />
					Back to automations
				</a>
				<div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
					{automationError ?? "Failed to load automation"}
				</div>
			</div>
		);
	}

	const isActive = automation.status === "active";
	const isPaused = automation.status === "paused";
	const isArchived = automation.status === "archived";
	const isDraft = automation.status === "draft";
	const readOnly = isArchived;

	const validationErrors = automation.validation_errors ?? [];
	const hasValidationErrors = validationErrors.length > 0;

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden border-t border-border bg-[#f5f6fa]">
			{/* ===== Header ===== */}
			<header className="z-20 flex shrink-0 items-center justify-between gap-4 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
				<div className="flex min-w-0 items-center gap-3">
					<a
						href="/app/automation"
						className="shrink-0 text-muted-foreground hover:text-foreground"
						aria-label="Back"
					>
						<ArrowLeft className="size-4" />
					</a>
					<div className="min-w-0">
						<input
							type="text"
							value={nameDraft}
							disabled={readOnly}
							onChange={(e) => setNameDraft(e.target.value)}
							onBlur={commitName}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.currentTarget.blur();
								}
							}}
							className="max-w-[340px] -ml-1 truncate rounded bg-transparent px-1 text-sm font-medium outline-none focus:ring-1 focus:ring-ring"
						/>
						<div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
							<StatusBadge status={automation.status} />
							<span>·</span>
							<span className="capitalize">{automation.channel}</span>
							{automation.created_from_template && (
								<>
									<span>·</span>
									<span className="rounded-full bg-[#eef2ff] px-1.5 py-0.5 text-[9px] font-medium text-[#4338ca]">
										{automation.created_from_template}
									</span>
								</>
							)}
							{graphStore.dirty && (
								<>
									<span>·</span>
									<span className="text-amber-500">unsaved</span>
								</>
							)}
						</div>
					</div>
				</div>

				{/* ===== Tabs ===== */}
				<div className="flex items-center gap-1 rounded-lg border border-border bg-muted/30 p-0.5">
					<TabButton
						active={tab === "canvas"}
						onClick={() => setTab("canvas")}
						label="Canvas"
					/>
					<TabButton
						active={tab === "runs"}
						onClick={() => setTab("runs")}
						label="Runs"
					/>
					<TabButton
						active={tab === "insights"}
						onClick={() => setTab("insights")}
						label="Insights"
					/>
				</div>

				{/* ===== Toolbar ===== */}
				<div className="flex shrink-0 items-center gap-1.5">
					{!readOnly && (
						<>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => graphStore.undo()}
								disabled={graphStore.history.past.length === 0}
								title="Undo (⌘Z)"
								className="h-7 w-7 p-0"
							>
								<Undo2 className="size-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => graphStore.redo()}
								disabled={graphStore.history.future.length === 0}
								title="Redo (⌘⇧Z)"
								className="h-7 w-7 p-0"
							>
								<Redo2 className="size-3.5" />
							</Button>
							<div className="mx-0.5 h-4 w-px bg-border" />
							<Button
								variant="ghost"
								size="sm"
								onClick={() =>
									setSidePanel(sidePanel === "simulator" ? "property" : "simulator")
								}
								title="Simulator"
								className={cn(
									"h-7 w-7 p-0",
									sidePanel === "simulator" && "bg-accent/40",
								)}
							>
								<FlaskConical className="size-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() =>
									setSidePanel(sidePanel === "bindings" ? "property" : "bindings")
								}
								title="Bindings"
								className={cn(
									"h-7 w-7 p-0",
									sidePanel === "bindings" && "bg-accent/40",
								)}
							>
								<Link2 className="size-3.5" />
							</Button>
							<div className="mx-0.5 h-4 w-px bg-border" />
						</>
					)}
					<Button
						variant="ghost"
						size="sm"
						onClick={handleArchive}
						disabled={archiveAutomation.loading || unarchiveAutomation.loading}
						className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-destructive"
						title={isArchived ? "Unarchive" : "Archive"}
					>
						<Archive className="size-3.5" />
					</Button>
					{!readOnly && (isActive || isPaused) && (
						<Button
							variant="ghost"
							size="sm"
							onClick={handlePauseResume}
							disabled={pauseAutomation.loading || resumeAutomation.loading}
							className="h-7 gap-1.5 text-xs"
						>
							{isActive ? (
								<Pause className="size-3.5" />
							) : (
								<Play className="size-3.5" />
							)}
							{isActive ? "Pause" : "Resume"}
						</Button>
					)}
					{isDraft && !readOnly && (
						<Button
							size="sm"
							onClick={handleActivate}
							disabled={
								activateAutomation.loading || hasValidationErrors
							}
							className="h-7 gap-1.5 text-xs"
						>
							{activateAutomation.loading ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<Upload className="size-3.5" />
							)}
							Activate
						</Button>
					)}
				</div>
			</header>

			{banner && (
				<div
					className={cn(
						"border-b px-4 py-2 text-xs",
						banner.type === "error"
							? "border-destructive/30 bg-destructive/10 text-destructive"
							: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500",
					)}
				>
					{banner.message}
				</div>
			)}

			{hasValidationErrors && (
				<div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-600">
					<div className="font-medium">
						Automation paused due to validation errors
					</div>
					<ul className="mt-0.5 space-y-0.5 text-amber-600/80">
						{validationErrors.slice(0, 4).map((err, idx) => (
							<li key={idx}>· {err.message}</li>
						))}
						{validationErrors.length > 4 && (
							<li>… and {validationErrors.length - 4} more</li>
						)}
					</ul>
				</div>
			)}

			<div className="flex min-h-0 flex-1">
				{/* ===== Left: Entrypoints ===== */}
				{tab === "canvas" && (
					<EntrypointPanel
						automationId={automation.id}
						channel={automation.channel}
						readOnly={readOnly}
						onEntrypointChange={refetchAutomation}
					/>
				)}

				{/* ===== Middle: Tab content ===== */}
				<div className="flex min-w-0 flex-1">
					{tab === "canvas" && (
						<GuidedFlow
							automationId={automation.id}
							channel={automation.channel}
							graphStore={graphStore}
							catalog={catalog.data}
							readOnly={readOnly}
							automationStatus={automation.status}
						/>
					)}
					{tab === "runs" && (
						<RunInspector
							automationId={automation.id}
							onShowOnCanvas={handleShowRunOnCanvas}
							onClosePanel={() => setTab("canvas")}
						/>
					)}
					{tab === "insights" && (
						<div className="flex flex-1">
							<div className="flex flex-1 items-start justify-center p-6">
								<div className="max-w-xl text-sm text-muted-foreground">
									Totals and outcomes over the last 30 days.
								</div>
							</div>
							<InsightsPanel
								automationId={automation.id}
								onClose={() => setTab("canvas")}
							/>
						</div>
					)}
				</div>

				{/* ===== Right: Property/Simulator/Bindings panel ===== */}
				{tab === "canvas" && (
					<>
						{sidePanel === "simulator" ? (
							<SimulatorPanel
								automationId={automation.id}
								graph={graphStore.graph}
								onClose={() => setSidePanel("property")}
							/>
						) : sidePanel === "bindings" ? (
							<BindingsPanel
								automationId={automation.id}
								onClose={() => setSidePanel("property")}
							/>
						) : selectedNode ? (
							<PropertyPanel
								automationId={automation.id}
								node={{
									key: selectedNode.key,
									kind: selectedNode.kind,
									notes: (selectedNode.ui_state?.notes as string | undefined) ?? undefined,
									config: selectedNode.config ?? {},
								}}
								automationChannel={automation.channel}
								onChange={(patch) => {
									if (patch.config) {
										graphStore.updateNodeConfig(selectedNode.key, patch.config);
									}
									if (typeof patch.notes === "string") {
										const notes = patch.notes;
										const nodes = graphStore.graph.nodes.map((n) =>
											n.key === selectedNode.key
												? {
														...n,
														ui_state: {
															...(n.ui_state ?? {}),
															notes,
														},
													}
												: n,
										);
										graphStore.setGraph({ ...graphStore.graph, nodes });
									}
									if (typeof patch.key === "string" && patch.key !== selectedNode.key) {
										const patchKey = patch.key;
										// Key rename requires a setGraph to also fix up edges.
										const renamed = graphStore.graph.nodes.map((n) =>
											n.key === selectedNode.key ? { ...n, key: patchKey } : n,
										);
										const renamedEdges = graphStore.graph.edges.map((e) => ({
											...e,
											from_node:
												e.from_node === selectedNode.key ? patchKey : e.from_node,
											to_node: e.to_node === selectedNode.key ? patchKey : e.to_node,
										}));
										graphStore.setGraph({
											...graphStore.graph,
											nodes: renamed,
											edges: renamedEdges,
											root_node_key:
												graphStore.graph.root_node_key === selectedNode.key
													? patchKey
													: graphStore.graph.root_node_key,
										});
										graphStore.setSelection([patchKey]);
									}
								}}
								onDelete={() => {
									if (selectedNode.key === graphStore.graph.root_node_key) {
										setBanner({
											type: "error",
											message: "Cannot delete the root node",
										});
										return;
									}
									graphStore.removeNodes([selectedNode.key]);
								}}
								onClose={() => graphStore.setSelection([])}
								existingKeys={graphStore.graph.nodes.map((n) => n.key)}
							/>
						) : (
							<EmptyRightPanel />
						)}
					</>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Helpers
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
				"rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
				active
					? "bg-white text-foreground shadow-sm"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{label}
		</button>
	);
}

function EmptyRightPanel() {
	return (
		<div className="flex w-[360px] items-center justify-center border-l border-[#e6e9ef] bg-white p-8 xl:w-[392px]">
			<p className="text-center text-sm text-[#7e8695]">
				Select a node to edit its properties
			</p>
		</div>
	);
}

function StatusBadge({
	status,
}: {
	status: "draft" | "active" | "paused" | "archived";
}) {
	const map: Record<string, { label: string; classes: string }> = {
		draft: { label: "Draft", classes: "text-neutral-500" },
		active: { label: "Active", classes: "text-emerald-600" },
		paused: { label: "Paused", classes: "text-amber-500" },
		archived: { label: "Archived", classes: "text-neutral-500" },
	};
	const cfg = map[status] ?? map.draft!;
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 font-medium",
				cfg.classes,
			)}
		>
			{status === "active" && <PlayCircle className="size-2.5" />}
			{cfg.label}
		</span>
	);
}
