import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ArrowLeft,
	Loader2,
	Pause,
	Play,
	PlayCircle,
	AlertTriangle,
	Save,
	Upload,
	Archive,
	Undo2,
	Redo2,
	History,
	FlaskConical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi, useMutation } from "@/hooks/use-api";
import { cn } from "@/lib/utils";
import { FlowBuilder } from "@/components/dashboard/automation/flow-builder/flow-builder";
import { NodePalette } from "@/components/dashboard/automation/flow-builder/node-palette";
import { PropertyPanel } from "@/components/dashboard/automation/flow-builder/property-panel";
import { SimulatorPanel } from "@/components/dashboard/automation/flow-builder/simulator-panel";
import { RunHistoryPanel } from "@/components/dashboard/automation/flow-builder/run-history-panel";
import {
	useHistory,
	useHistoryKeyboardShortcuts,
	type GraphSnapshot,
} from "@/components/dashboard/automation/flow-builder/use-history";
import { useAutosave } from "@/components/dashboard/automation/flow-builder/use-autosave";
import {
	validateGraph,
	type ValidationIssue,
} from "@/components/dashboard/automation/flow-builder/validation";
import type {
	AutomationDetail,
	AutomationEdgeSpec,
	AutomationNodeSpec,
	AutomationSchema,
	SchemaNodeDef,
} from "@/components/dashboard/automation/flow-builder/types";

interface Props {
	automationId: string;
}

function generateUniqueKey(type: string, existing: Set<string>): string {
	const base = type.toLowerCase().replace(/[^a-z0-9_]/g, "_");
	let candidate = base;
	let i = 2;
	while (existing.has(candidate)) {
		candidate = `${base}_${i}`;
		i += 1;
	}
	return candidate;
}

export function AutomationDetailPage({ automationId }: Props) {
	const automationPath = `automations/${automationId}`;

	const {
		data: fetched,
		loading: loadingAutomation,
		error: automationError,
		refetch: refetchAutomation,
	} = useApi<AutomationDetail>(automationPath);

	const { data: schema, loading: loadingSchema } = useApi<AutomationSchema>(
		"automations/schema",
	);

	const [draft, setDraft] = useState<AutomationDetail | null>(null);
	const [dirty, setDirty] = useState(false);
	// Monotonic counter that bumps on every local edit. Used by useAutosave
	// to re-arm its debounce timer from the latest edit, and by silentSave
	// to detect whether the draft changed while a save was in flight.
	const [editVersion, setEditVersion] = useState(0);
	const bumpEdit = useCallback(() => setEditVersion((v) => v + 1), []);
	const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null);
	const [rightPanel, setRightPanel] = useState<
		"property" | "simulator" | "history" | null
	>(null);
	const [highlightKeys, setHighlightKeys] = useState<Set<string>>(
		() => new Set(),
	);
	const [banner, setBanner] = useState<{
		type: "error" | "success";
		message: string;
	} | null>(null);

	const restoreSnapshot = useCallback(
		(snap: GraphSnapshot) => {
			setDraft((prev) => (prev ? { ...prev, nodes: snap.nodes, edges: snap.edges } : prev));
			setDirty(true);
			bumpEdit();
		},
		[bumpEdit],
	);

	const history = useHistory(restoreSnapshot);
	useHistoryKeyboardShortcuts(history.undo, history.redo);

	useEffect(() => {
		if (!fetched) return;
		setDraft(fetched);
		setDirty(false);
		setSelectedNodeKey(null);
		setHighlightKeys(new Set());
		history.reset({ nodes: fetched.nodes, edges: fetched.edges });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fetched]);

	const patchAutomation = useMutation<AutomationDetail>(automationPath, "PATCH");
	const publishAutomation = useMutation<AutomationDetail>(
		`${automationPath}/publish`,
		"POST",
	);
	const pauseAutomation = useMutation<AutomationDetail>(
		`${automationPath}/pause`,
		"POST",
	);
	const resumeAutomation = useMutation<AutomationDetail>(
		`${automationPath}/resume`,
		"POST",
	);
	const archiveAutomation = useMutation<AutomationDetail>(
		`${automationPath}/archive`,
		"POST",
	);

	const schemaNodesByType = useMemo(
		() => new Map((schema?.nodes ?? []).map((n) => [n.type, n])),
		[schema],
	);

	const issues: ValidationIssue[] = useMemo(() => {
		if (!draft || !schema) return [];
		return validateGraph(draft.nodes, draft.edges, schema.nodes);
	}, [draft, schema]);

	const errorKeys = useMemo(() => {
		const set = new Set<string>();
		for (const i of issues) {
			if (i.severity === "error" && i.nodeKey) set.add(i.nodeKey);
		}
		return set;
	}, [issues]);

	const canPublish = issues.every((i) => i.severity !== "error");

	const handleGraphChange = useCallback(
		(nodes: AutomationNodeSpec[], edges: AutomationEdgeSpec[]) => {
			setDraft((prev) => (prev ? { ...prev, nodes, edges } : prev));
			setDirty(true);
			bumpEdit();
			history.push({ nodes, edges });
		},
		[history, bumpEdit],
	);

	const addNode = useCallback(
		(def: SchemaNodeDef) => {
			setDraft((prev) => {
				if (!prev) return prev;
				const existing = new Set(prev.nodes.map((n) => n.key));
				const key = generateUniqueKey(def.type, existing);
				const maxY = prev.nodes.reduce(
					(m, n) => Math.max(m, n.canvas_y ?? 0),
					0,
				);
				const newNode: AutomationNodeSpec = {
					type: def.type,
					key,
					canvas_x: 0,
					canvas_y: maxY + 140,
				};
				const next = {
					...prev,
					nodes: [...prev.nodes, newNode],
				};
				history.push({ nodes: next.nodes, edges: next.edges });
				return next;
			});
			setDirty(true);
			bumpEdit();
		},
		[history, bumpEdit],
	);

	const addNodeAtPosition = useCallback(
		(nodeType: string, position: { x: number; y: number }) => {
			setDraft((prev) => {
				if (!prev) return prev;
				const existing = new Set(prev.nodes.map((n) => n.key));
				const key = generateUniqueKey(nodeType, existing);
				const newNode: AutomationNodeSpec = {
					type: nodeType,
					key,
					canvas_x: Math.round(position.x),
					canvas_y: Math.round(position.y),
				};
				const next = {
					...prev,
					nodes: [...prev.nodes, newNode],
				};
				history.push({ nodes: next.nodes, edges: next.edges });
				return next;
			});
			setDirty(true);
			bumpEdit();
		},
		[history, bumpEdit],
	);

	const updateSelectedNode = useCallback(
		(patch: Partial<AutomationNodeSpec>) => {
			setDraft((prev) => {
				if (!prev || !selectedNodeKey) return prev;
				const nodes = prev.nodes.map((n) =>
					n.key === selectedNodeKey ? { ...n, ...patch } : n,
				);
				let edges = prev.edges;
				if (patch.key && patch.key !== selectedNodeKey) {
					edges = prev.edges.map((e) => ({
						...e,
						from: e.from === selectedNodeKey ? (patch.key as string) : e.from,
						to: e.to === selectedNodeKey ? (patch.key as string) : e.to,
					}));
				}
				history.push({ nodes, edges });
				return { ...prev, nodes, edges };
			});
			if (patch.key) setSelectedNodeKey(patch.key as string);
			setDirty(true);
			bumpEdit();
		},
		[selectedNodeKey, history, bumpEdit],
	);

	const deleteSelectedNode = useCallback(() => {
		if (!selectedNodeKey) return;
		setDraft((prev) => {
			if (!prev) return prev;
			const nodes = prev.nodes.filter((n) => n.key !== selectedNodeKey);
			const edges = prev.edges.filter(
				(e) => e.from !== selectedNodeKey && e.to !== selectedNodeKey,
			);
			history.push({ nodes, edges });
			return { ...prev, nodes, edges };
		});
		setSelectedNodeKey(null);
		setDirty(true);
		bumpEdit();
	}, [selectedNodeKey, history, bumpEdit]);

	const saveDraft = useCallback(async () => {
		if (!draft) return;
		setBanner(null);
		const versionAtStart = editVersion;
		const result = await patchAutomation.mutate({
			nodes: draft.nodes,
			edges: draft.edges,
			name: draft.name,
			description: draft.description,
		});
		if (result) {
			// Only clear the dirty flag if the user hasn't edited since we captured
			// the snapshot. Otherwise newer edits would be silently marked saved.
			setDirty((d) => (editVersion === versionAtStart ? false : d));
			setBanner({ type: "success", message: "Draft saved" });
			refetchAutomation();
		} else if (patchAutomation.error) {
			setBanner({ type: "error", message: patchAutomation.error });
		}
	}, [draft, editVersion, patchAutomation, refetchAutomation]);

	const silentSave = useCallback(async () => {
		if (!draft) return;
		const versionAtStart = editVersion;
		const result = await patchAutomation.mutate({
			nodes: draft.nodes,
			edges: draft.edges,
			name: draft.name,
			description: draft.description,
		});
		if (result) {
			setDirty((d) => (editVersion === versionAtStart ? false : d));
		}
	}, [draft, editVersion, patchAutomation]);

	useAutosave({
		version: editVersion,
		dirty,
		onSave: silentSave,
		enabled: !!draft && draft.status !== "archived",
	});

	// Warn before unloading / navigating away with unsaved changes.
	useEffect(() => {
		if (!dirty) return;
		const onBeforeUnload = (e: BeforeUnloadEvent) => {
			e.preventDefault();
			e.returnValue = "";
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [dirty]);

	const publishAndActivate = useCallback(async () => {
		if (!draft) return;
		// Re-run validation fresh right before publishing. The `canPublish`
		// gate is based on React-rendered state; this ensures we never send
		// a publish request for an invalid graph even if the render is stale.
		const freshIssues = schema
			? validateGraph(draft.nodes, draft.edges, schema.nodes)
			: [];
		const blocking = freshIssues.filter((i) => i.severity === "error");
		if (blocking.length > 0) {
			setBanner({
				type: "error",
				message: `Fix ${blocking.length} validation error${blocking.length === 1 ? "" : "s"} before publishing`,
			});
			return;
		}
		setBanner(null);
		if (dirty) {
			const versionAtStart = editVersion;
			const saved = await patchAutomation.mutate({
				nodes: draft.nodes,
				edges: draft.edges,
			});
			if (!saved) {
				setBanner({
					type: "error",
					message: patchAutomation.error ?? "Save failed",
				});
				return;
			}
			setDirty((d) => (editVersion === versionAtStart ? false : d));
		}
		const published = await publishAutomation.mutate();
		if (published) {
			setBanner({ type: "success", message: "Published" });
			refetchAutomation();
		} else if (publishAutomation.error) {
			setBanner({ type: "error", message: publishAutomation.error });
		}
	}, [
		draft,
		dirty,
		editVersion,
		schema,
		patchAutomation,
		publishAutomation,
		refetchAutomation,
	]);

	const togglePause = useCallback(async () => {
		if (!draft) return;
		setBanner(null);
		const m = draft.status === "active" ? pauseAutomation : resumeAutomation;
		const result = await m.mutate();
		if (result) {
			refetchAutomation();
		} else if (m.error) {
			setBanner({ type: "error", message: m.error });
		}
	}, [draft, pauseAutomation, resumeAutomation, refetchAutomation]);

	const archive = useCallback(async () => {
		if (!confirm("Archive this automation? It will stop processing new enrollments.")) {
			return;
		}
		setBanner(null);
		const result = await archiveAutomation.mutate();
		if (result) {
			window.location.href = "/app/automation";
		} else if (archiveAutomation.error) {
			setBanner({ type: "error", message: archiveAutomation.error });
		}
	}, [archiveAutomation]);

	const selectedNode = useMemo(() => {
		if (!draft || !selectedNodeKey) return null;
		return draft.nodes.find((n) => n.key === selectedNodeKey) ?? null;
	}, [draft, selectedNodeKey]);

	const selectedNodeDef = selectedNode
		? schemaNodesByType.get(selectedNode.type) ?? null
		: null;

	const existingKeys = useMemo(
		() => (draft ? draft.nodes.map((n) => n.key) : []),
		[draft],
	);

	const loading = loadingAutomation || loadingSchema;

	if (loading) {
		return (
			<div className="flex items-center justify-center py-20">
				<Loader2 className="size-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (automationError || !draft || !schema) {
		return (
			<div className="space-y-4">
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

	const isActive = draft.status === "active";
	const isPaused = draft.status === "paused";
	const isArchived = draft.status === "archived";

	return (
		<div className="flex flex-col -mx-5 sm:-mx-8 md:-mx-10 -mt-4 md:-mt-8 h-[calc(100vh-2rem)] md:h-[calc(100vh-4rem)] border-t border-border">
			<header className="flex items-center justify-between gap-4 px-4 py-2 border-b border-border">
				<div className="flex items-center gap-3 min-w-0">
					<a
						href="/app/automation"
						className="text-muted-foreground hover:text-foreground shrink-0"
					>
						<ArrowLeft className="size-4" />
					</a>
					<div className="min-w-0">
						<input
							type="text"
							value={draft.name}
							onChange={(e) => {
								setDraft({ ...draft, name: e.target.value });
								setDirty(true);
								bumpEdit();
							}}
							className="text-sm font-medium bg-transparent outline-none focus:ring-1 focus:ring-ring rounded px-1 -ml-1 truncate max-w-[340px]"
						/>
						<div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
							<StatusBadge status={draft.status} />
							<span>·</span>
							<span className="capitalize">{draft.channel}</span>
							<span>·</span>
							<span>{draft.trigger.type.replace(/_/g, " ")}</span>
							{dirty && <span className="text-amber-400">· unsaved</span>}
						</div>
					</div>
				</div>

				<div className="flex items-center gap-1.5 shrink-0">
					{!isArchived && (
						<>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => history.undo()}
								disabled={!history.canUndo}
								title="Undo (⌘Z)"
								className="h-7 w-7 p-0"
							>
								<Undo2 className="size-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => history.redo()}
								disabled={!history.canRedo}
								title="Redo (⌘⇧Z)"
								className="h-7 w-7 p-0"
							>
								<Redo2 className="size-3.5" />
							</Button>
							<div className="w-px h-4 bg-border mx-0.5" />
							<Button
								variant="ghost"
								size="sm"
								onClick={() =>
									setRightPanel(rightPanel === "simulator" ? null : "simulator")
								}
								title="Simulator"
								className={cn(
									"h-7 w-7 p-0",
									rightPanel === "simulator" && "bg-accent/40",
								)}
							>
								<FlaskConical className="size-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() =>
									setRightPanel(rightPanel === "history" ? null : "history")
								}
								title="Run history"
								className={cn(
									"h-7 w-7 p-0",
									rightPanel === "history" && "bg-accent/40",
								)}
							>
								<History className="size-3.5" />
							</Button>
							<div className="w-px h-4 bg-border mx-0.5" />
							<Button
								variant="ghost"
								size="sm"
								onClick={saveDraft}
								disabled={!dirty || patchAutomation.loading}
								className="h-7 text-xs gap-1.5"
							>
								{patchAutomation.loading ? (
									<Loader2 className="size-3.5 animate-spin" />
								) : (
									<Save className="size-3.5" />
								)}
								Save
							</Button>
							{(isActive || isPaused) && (
								<Button
									variant="ghost"
									size="sm"
									onClick={togglePause}
									disabled={pauseAutomation.loading || resumeAutomation.loading}
									className="h-7 text-xs gap-1.5"
								>
									{isActive ? (
										<Pause className="size-3.5" />
									) : (
										<Play className="size-3.5" />
									)}
									{isActive ? "Pause" : "Resume"}
								</Button>
							)}
							<Button
								size="sm"
								onClick={publishAndActivate}
								disabled={
									!canPublish ||
									publishAutomation.loading ||
									patchAutomation.loading
								}
								className="h-7 text-xs gap-1.5"
							>
								{publishAutomation.loading ? (
									<Loader2 className="size-3.5 animate-spin" />
								) : (
									<Upload className="size-3.5" />
								)}
								{isActive ? "Publish new version" : "Publish"}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={archive}
								disabled={archiveAutomation.loading}
								className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-destructive"
							>
								<Archive className="size-3.5" />
							</Button>
						</>
					)}
				</div>
			</header>

			{banner && (
				<div
					className={cn(
						"px-4 py-2 text-xs border-b",
						banner.type === "error"
							? "bg-destructive/10 border-destructive/30 text-destructive"
							: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400",
					)}
				>
					{banner.message}
				</div>
			)}

			{issues.filter((i) => i.severity === "error").length > 0 && (
				<div className="px-4 py-2 text-xs bg-amber-500/10 border-b border-amber-500/30 text-amber-400 flex items-start gap-2">
					<AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
					<div className="space-y-0.5">
						<div className="font-medium">
							{issues.filter((i) => i.severity === "error").length} validation{" "}
							{issues.filter((i) => i.severity === "error").length === 1
								? "error"
								: "errors"}{" "}
							prevent publishing
						</div>
						<ul className="space-y-0.5 text-amber-400/80">
							{issues
								.filter((i) => i.severity === "error")
								.slice(0, 4)
								.map((i, idx) => (
									<li key={idx}>· {i.message}</li>
								))}
						</ul>
					</div>
				</div>
			)}

			<div className="flex-1 flex min-h-0">
				<NodePalette
					schema={schema}
					channel={draft.channel}
					onAddNode={addNode}
					disabled={isArchived}
				/>
				<div className="flex-1 min-w-0">
					<FlowBuilder
						automation={draft}
						schema={schema}
						errorKeys={errorKeys}
						highlightKeys={highlightKeys}
						selectedNodeKey={selectedNodeKey}
						onSelectNode={(key) => {
							setSelectedNodeKey(key);
							if (key) setRightPanel("property");
						}}
						onGraphChange={handleGraphChange}
						onDropNodeType={addNodeAtPosition}
						readOnly={isArchived}
					/>
				</div>
				{rightPanel === "simulator" ? (
					<SimulatorPanel
						automation={draft}
						schema={schema}
						onClose={() => setRightPanel(null)}
						onHighlightPath={(keys) => setHighlightKeys(new Set(keys))}
					/>
				) : rightPanel === "history" ? (
					<RunHistoryPanel
						automationId={draft.id}
						onClose={() => setRightPanel(null)}
						onHighlightPath={(keys) => setHighlightKeys(new Set(keys))}
					/>
				) : selectedNode ? (
					<PropertyPanel
						node={selectedNode}
						nodeDef={selectedNodeDef}
						onChange={updateSelectedNode}
						onDelete={deleteSelectedNode}
						onClose={() => {
							setSelectedNodeKey(null);
							setRightPanel(null);
						}}
						existingKeys={existingKeys}
					/>
				) : (
					<div className="w-80 border-l border-border bg-card/30 flex items-center justify-center p-6">
						<p className="text-xs text-muted-foreground text-center">
							Select a node to edit, or open the Simulator / Run history panel.
						</p>
					</div>
				)}
			</div>
		</div>
	);
}

function StatusBadge({ status }: { status: AutomationDetail["status"] }) {
	const map: Record<string, { label: string; classes: string }> = {
		draft: { label: "Draft", classes: "text-neutral-400" },
		active: { label: "Active", classes: "text-emerald-400" },
		paused: { label: "Paused", classes: "text-amber-400" },
		archived: { label: "Archived", classes: "text-neutral-500" },
	};
	const cfg = map[status] ?? map.draft!;
	return (
		<span className={cn("inline-flex items-center gap-1 font-medium", cfg.classes)}>
			{status === "active" && <PlayCircle className="size-2.5" />}
			{cfg.label}
		</span>
	);
}
