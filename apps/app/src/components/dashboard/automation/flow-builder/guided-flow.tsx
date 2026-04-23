// Guided flow canvas (Plan 2 — Unit B2, Task L2 + L5).
//
// The builder's main editing surface. Port-driven handles, graph-store-backed
// mutations, drag-to-create insert menu, clipboard + keyboard shortcuts,
// debounced autosave.
//
// API surface:
//
//   <GuidedFlow
//     automationId={id}
//     channel={channel}
//     graphStore={store}    // `useGraphStore()` instance owned by the host page
//     catalog={catalog}     // from `useAutomationCatalog()`
//     readOnly={false}
//     onAutoArrange={fn?}
//   />
//
// The component is intentionally prop-thin: the host page is responsible for
// creating the graph store, loading the initial graph into it, and observing
// `graphStore.dirty` to gate save/publish buttons. This component handles
// every *mutation* locally (moves, adds, edge creation, duplicate, paste,
// delete, undo/redo) and pushes them to the server via the SDK-proxy
// `/api/automations/{id}/graph` endpoint on a 750 ms debounce.
//
// The old edge-label-based connection model is gone. Every edge now stores
// `{from_node, from_port, to_node, to_port}` — React Flow's
// `sourceHandle`/`targetHandle` line up with port keys 1:1, and node handles
// are rendered by `port-handles.tsx` from the canonical `derivePorts()`
// output.

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Background,
	BackgroundVariant,
	Handle,
	MarkerType,
	Panel,
	Position,
	ReactFlow,
	ReactFlowProvider,
	useReactFlow,
	type Connection,
	type Edge,
	type EdgeChange,
	type Node,
	type NodeChange,
	type NodeProps,
	type XYPosition,
} from "reactflow";
import "reactflow/dist/style.css";
import {
	Bot,
	Clock3,
	CornerDownRight,
	GitBranch,
	Globe,
	LayoutGrid,
	MessageSquare,
	Play,
	Plus,
	RefreshCw,
	Shuffle,
	StopCircle,
	Zap,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { platformIcons } from "@/lib/platform-icons";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PortHandles } from "./port-handles";
import { derivePorts } from "./derive-ports";
import { InsertMenu } from "./insert-menu";
import { validateGraph } from "./validation";
import { useAutosave } from "./use-autosave";
import type { UseGraphStore } from "./use-graph-store";
import { generateNodeKey } from "./use-graph-store";
import type {
	AutomationCatalog,
	CatalogEntrypointKind,
} from "./use-catalog";
import type {
	AutomationEdge,
	AutomationGraph,
	AutomationNode,
} from "./graph-types";
import {
	parseGraphSaveResponse,
	type GraphSaveResult,
} from "./graph-save-response";
import {
	NodeMetricBadge,
	useNodeOverlays,
	type NodeMetrics,
	type OverlayPeriod,
} from "./node-overlays";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutomationEntrypoint {
	id: string;
	automation_id: string;
	channel: string;
	kind: string;
	status: string;
	social_account_id: string | null;
	config: Record<string, unknown> | null;
	filters: Record<string, unknown> | null;
	allow_reentry: boolean;
	reentry_cooldown_min: number;
	priority: number;
	specificity: number;
	created_at: string;
	updated_at: string;
}

export const TRIGGER_NODE_ID = "__trigger";

export interface GuidedFlowProps {
	automationId: string;
	channel: string;
	graphStore: UseGraphStore;
	catalog: AutomationCatalog | undefined;
	readOnly?: boolean;
	/**
	 * Automation lifecycle status. When `active`, the canvas fetches
	 * per-node insights and overlays a small metric pill on each node.
	 * Any other value (or omitted) skips the fetch and hides the pill.
	 */
	automationStatus?: "draft" | "active" | "paused" | "archived";
	onAutoArrange?: () => void;
	/**
	 * Override the autosave endpoint. Defaults to PUTting to
	 * `/api/automations/{id}/graph` which is the SDK proxy on the dashboard
	 * side. Returns the parsed save result so the caller can decide how to
	 * surface validation errors vs hard failures.
	 */
	onSave?: (graph: UseGraphStore["graph"]) => Promise<GraphSaveResult>;
	/**
	 * Entrypoints for this automation. Rendered into the synthetic trigger
	 * canvas node — clicking a row fires `onSelectTrigger(entrypointId)`;
	 * clicking the card itself fires `onSelectTrigger(null)`.
	 */
	entrypoints?: AutomationEntrypoint[];
	/**
	 * Called when the trigger card or one of its entrypoint rows is clicked.
	 * `null` means the card itself (list mode); otherwise the entrypoint id.
	 */
	onSelectTrigger?: (entrypointId: string | null) => void;
	/** Called when the user picks a kind from the "+ New Trigger" dropdown. */
	onAddEntrypoint?: (kind: string) => void;
	/** Whether the trigger card should render as selected. */
	triggerSelected?: boolean;
	/**
	 * Called whenever the user clicks empty canvas area, in addition to the
	 * internal graph-store selection clear. Parent should use this to dismiss
	 * any non-graph selection state (e.g. trigger panel).
	 */
	onPaneClick?: () => void;
}

interface NodeData {
	node: AutomationNode;
	catalog: AutomationCatalog | undefined;
	channel: string;
	readOnly: boolean;
	metrics?: NodeMetrics;
	overlaysEnabled: boolean;
}

interface TriggerNodeData {
	channel: string;
	entrypoints: AutomationEntrypoint[];
	availableKinds: CatalogEntrypointKind[];
	readOnly: boolean;
	onSelectCard: () => void;
	onSelectEntrypoint: (entrypointId: string) => void;
	onAddEntrypoint: (kind: string) => void;
}

// ---------------------------------------------------------------------------
// Auto-arrange (preserved from pre-rewrite canvas).
// ---------------------------------------------------------------------------

const LAYER_GAP = 420;
const ROW_GAP = 200;

function computeAutoPositions(
	nodes: AutomationNode[],
	edges: AutomationEdge[],
	rootKey: string | null,
): Map<string, XYPosition> {
	const layers = new Map<number, string[]>();
	const childrenByKey = new Map<string, string[]>();
	for (const e of edges) {
		const list = childrenByKey.get(e.from_node) ?? [];
		list.push(e.to_node);
		childrenByKey.set(e.from_node, list);
	}

	const seen = new Set<string>();
	const queue: Array<{ depth: number; key: string }> = [];
	if (rootKey) {
		queue.push({ depth: 0, key: rootKey });
		seen.add(rootKey);
	}

	while (queue.length > 0) {
		const current = queue.shift()!;
		const layer = layers.get(current.depth) ?? [];
		layer.push(current.key);
		layers.set(current.depth, layer);
		for (const childKey of childrenByKey.get(current.key) ?? []) {
			if (seen.has(childKey)) continue;
			seen.add(childKey);
			queue.push({ depth: current.depth + 1, key: childKey });
		}
	}

	const lastDepth = layers.size > 0 ? Math.max(...layers.keys()) : -1;
	let orphanDepth = lastDepth + 1;
	for (const n of nodes) {
		if (seen.has(n.key)) continue;
		const layer = layers.get(orphanDepth) ?? [];
		layer.push(n.key);
		layers.set(orphanDepth, layer);
		orphanDepth += 1;
	}

	const positions = new Map<string, XYPosition>();
	for (const [depth, keys] of Array.from(layers.entries()).sort(
		(a, b) => a[0] - b[0],
	)) {
		const startY = -((keys.length - 1) * ROW_GAP) / 2;
		keys.forEach((key, index) => {
			positions.set(key, {
				x: depth * LAYER_GAP,
				y: startY + index * ROW_GAP,
			});
		});
	}

	return positions;
}

// ---------------------------------------------------------------------------
// Toast (tiny inline implementation — no sonner dep available)
// ---------------------------------------------------------------------------

type Toast = { id: number; message: string };

function useTinyToast() {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const push = useCallback((message: string) => {
		const id = Date.now() + Math.random();
		setToasts((prev) => [...prev, { id, message }]);
		window.setTimeout(() => {
			setToasts((prev) => prev.filter((t) => t.id !== id));
		}, 3000);
	}, []);
	const view = (
		<div className="pointer-events-none absolute bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
			{toasts.map((t) => (
				<div
					key={t.id}
					className="pointer-events-auto rounded-lg bg-slate-900 px-3 py-1.5 text-[12px] font-medium text-white shadow-[0_8px_24px_rgba(15,23,42,0.25)]"
				>
					{t.message}
				</div>
			))}
		</div>
	);
	return { push, view };
}

// ---------------------------------------------------------------------------
// Node rendering
// ---------------------------------------------------------------------------

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
	message: MessageSquare,
	input: Play,
	delay: Clock3,
	condition: GitBranch,
	randomizer: Shuffle,
	action_group: Zap,
	http_request: Globe,
	start_automation: CornerDownRight,
	goto: CornerDownRight,
	end: StopCircle,
};

function CanvasNode({ data, selected }: NodeProps<NodeData>) {
	const node = data.node;
	const Icon = KIND_ICON[node.kind] ?? Bot;
	const title =
		node.title ??
		data.catalog?.node_kinds.find((k) => k.kind === node.kind)?.label ??
		node.kind;
	const description =
		data.catalog?.node_kinds.find((k) => k.kind === node.kind)?.description ?? "";

	// Derive ports client-side so new button/quick-reply entries show up as
	// handles without waiting for a round-trip.
	const ports = useMemo(() => {
		if (node.ports && node.ports.length > 0) return node.ports;
		return derivePorts(node);
	}, [node]);

	const outputCount = ports.filter((p) => p.direction === "output").length;
	// Pad the right side so port labels don't clip the card content.
	const minHeight = Math.max(96, 60 + outputCount * 22);

	return (
		<div
			className={cn(
				"relative w-[280px] rounded-2xl border bg-white pr-10 shadow-[0_2px_8px_rgba(34,44,66,0.08)] transition-all",
				selected
					? "border-[#4680ff] shadow-[0_0_0_2px_rgba(70,128,255,0.18)]"
					: "border-slate-200",
			)}
			style={{ minHeight }}
		>
			<PortHandles ports={ports} isConnectable={!data.readOnly} />

			{data.overlaysEnabled ? (
				<NodeMetricBadge metrics={data.metrics} />
			) : null}

			<div className="flex items-start gap-3 px-4 py-3">
				<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
					<Icon className="size-4" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="truncate text-[13px] font-semibold text-slate-900">
						{title}
					</div>
					{description ? (
						<div className="mt-0.5 truncate text-[11px] text-slate-500">
							{description}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Trigger canvas node — synthetic "When..." card (plan 8).
// Rendered at ReactFlow id TRIGGER_NODE_ID, driven by the `entrypoints` prop
// on GuidedFlow. Not stored in the graph.
// ---------------------------------------------------------------------------

const ENTRYPOINT_KIND_LABELS: Record<string, string> = {
	dm_received: "User sends a message",
	keyword: "Keyword match",
	comment_created: "User comments on your Post",
	story_reply: "User replies to your Story",
	story_mention: "User mentions your Story",
	live_comment: "User comments on your Live",
	ad_click: "User clicks your Ad",
	ref_link_click: "User clicks a referral link",
	share_to_dm: "User shares to DM",
	follow: "User follows your account",
	schedule: "Scheduled time",
	field_changed: "Contact field changed",
	tag_applied: "Tag applied to contact",
	tag_removed: "Tag removed from contact",
	conversion_event: "Conversion event",
	webhook_inbound: "Inbound webhook",
};

function humanizeEntrypointKind(kind: string): string {
	if (ENTRYPOINT_KIND_LABELS[kind]) return ENTRYPOINT_KIND_LABELS[kind];
	return kind
		.split("_")
		.filter(Boolean)
		.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
		.join(" ");
}

function platformIconBubble(channel: string) {
	const palette =
		channel === "instagram"
			? "bg-[linear-gradient(135deg,#ffd776_0%,#f74a5c_48%,#7d3cff_100%)]"
			: channel === "facebook"
				? "bg-[#1877f2]"
				: channel === "whatsapp"
					? "bg-[#25d366]"
					: channel === "telegram"
						? "bg-[#27a7e7]"
						: "bg-[#7c8ca5]";
	return (
		<div
			className={cn(
				"flex size-7 items-center justify-center rounded-full text-white shadow-[0_2px_8px_rgba(15,23,42,0.15)]",
				palette,
			)}
		>
			<div className="scale-[0.8]">
				{platformIcons[channel] ?? <MessageSquare className="size-3.5" />}
			</div>
		</div>
	);
}

function TriggerNode({ data, selected }: NodeProps<TriggerNodeData>) {
	const channel = data.channel;

	return (
		<div
			className={cn(
				"group relative w-[390px] overflow-visible rounded-[22px] border bg-white shadow-[0_2px_10px_rgba(34,44,66,0.08)] transition-all duration-150",
				selected
					? "border-[#63d26f] shadow-[0_0_0_1px_rgba(99,210,111,0.3),0_3px_12px_rgba(34,44,66,0.1)]"
					: "border-[#e6e9ef]",
				"cursor-grab active:cursor-grabbing",
			)}
			onClick={(event) => {
				if (
					(event.target as HTMLElement).closest(
						"button,input,a,[role=button],[role=menuitem]",
					)
				) {
					return;
				}
				data.onSelectCard();
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					data.onSelectCard();
				}
			}}
			role="button"
			tabIndex={0}
		>
			<Handle
				type="source"
				position={Position.Right}
				id="out"
				className="!size-[14px] !border-[3px] !border-white !bg-[#5f6b7f] !shadow-[0_1px_4px_rgba(34,44,66,0.18)]"
				style={{ right: -8, top: "calc(100% - 22px)" }}
				isConnectable={false}
			/>
			<div className="block w-full px-5 py-4 text-left">
				<div className="flex items-center gap-2 text-[18px] font-bold tracking-tight text-[#1f2633]">
					<Zap className="size-[18px] text-[#1f2633]" />
					<span>When...</span>
				</div>

				{data.entrypoints.length > 0 ? (
					<div className="mt-4 space-y-3">
						{data.entrypoints.map((ep) => {
							const summary = humanizeEntrypointKind(ep.kind);
							const statusLabel =
								ep.status === "active"
									? "Active"
									: ep.status === "paused"
										? "Paused"
										: ep.status;
							return (
								<button
									key={ep.id}
									type="button"
									onClick={(event) => {
										event.stopPropagation();
										data.onSelectEntrypoint(ep.id);
									}}
									className="nodrag flex w-full items-center gap-3 rounded-[16px] bg-[#f4f5f8] px-4 py-3 text-left transition hover:bg-[#eceef3]"
								>
									{platformIconBubble(channel)}
									<div className="min-w-0 flex-1">
										<div className="truncate text-[13px] font-medium leading-4 text-[#8b92a0]">
											{statusLabel}
										</div>
										<div className="mt-0.5 text-[15px] font-semibold leading-5 text-[#404552]">
											{summary}
										</div>
									</div>
								</button>
							);
						})}
					</div>
				) : (
					<div className="mt-4 rounded-[16px] border border-dashed border-[#d9dde6] bg-white px-4 py-5 text-center text-[13px] text-[#7e8695]">
						No triggers yet — add one below.
					</div>
				)}

				{!data.readOnly && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								onClick={(event) => event.stopPropagation()}
								className="nodrag mt-4 flex h-[48px] w-full items-center justify-center rounded-[14px] border border-dashed border-[#d9dde6] text-[15px] font-semibold text-[#4680ff] transition hover:border-[#4680ff] hover:bg-[#f4f8ff]"
								disabled={data.availableKinds.length === 0}
								title={
									data.availableKinds.length === 0
										? "No entrypoint kinds available for this channel"
										: undefined
								}
							>
								+ New Trigger
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							align="center"
							sideOffset={8}
							className="w-[320px]"
						>
							{data.availableKinds.map((k) => (
								<DropdownMenuItem
									key={k.kind}
									onSelect={(event) => {
										event.preventDefault();
										data.onAddEntrypoint(k.kind);
									}}
								>
									<span className="text-[13px] font-medium text-foreground">
										{typeof k.label === "string"
											? k.label
											: humanizeEntrypointKind(k.kind)}
									</span>
								</DropdownMenuItem>
							))}
							{data.availableKinds.length === 0 && (
								<div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
									No entrypoint kinds available.
								</div>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				)}

				<div className="mt-3 flex justify-end text-[13px] font-medium text-[#6f7786]">
					Then
				</div>
			</div>
		</div>
	);
}

const nodeTypes = { canvas: CanvasNode, trigger: TriggerNode };

// ---------------------------------------------------------------------------
// Canvas controls
// ---------------------------------------------------------------------------

function CanvasControls({
	onAutoArrange,
}: {
	onAutoArrange?: () => void;
}) {
	const rf = useReactFlow();
	return (
		<Panel position="top-right" className="!right-4 !top-1/2 !-translate-y-1/2">
			<div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_14px_32px_rgba(15,23,42,0.08)]">
				<button
					type="button"
					onClick={() => rf.zoomIn({ duration: 180 })}
					className="flex size-11 items-center justify-center border-b border-slate-200 text-slate-600 hover:bg-slate-50"
					aria-label="Zoom in"
				>
					<ZoomIn className="size-4" />
				</button>
				<button
					type="button"
					onClick={() => rf.zoomOut({ duration: 180 })}
					className="flex size-11 items-center justify-center border-b border-slate-200 text-slate-600 hover:bg-slate-50"
					aria-label="Zoom out"
				>
					<ZoomOut className="size-4" />
				</button>
				<button
					type="button"
					onClick={onAutoArrange}
					disabled={!onAutoArrange}
					className="flex size-11 items-center justify-center border-b border-slate-200 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
					aria-label="Auto arrange"
				>
					<LayoutGrid className="size-4" />
				</button>
				<button
					type="button"
					onClick={() => rf.fitView({ duration: 220, padding: 0.18 })}
					className="flex size-11 items-center justify-center text-slate-600 hover:bg-slate-50"
					aria-label="Fit view"
				>
					<RefreshCw className="size-4" />
				</button>
			</div>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Default autosave: PUT to the dashboard's SDK proxy.
// ---------------------------------------------------------------------------

async function defaultSave(
	automationId: string,
	graph: UseGraphStore["graph"],
): Promise<GraphSaveResult> {
	let res: Response;
	try {
		res = await fetch(`/api/automations/${automationId}/graph`, {
			method: "PUT",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ graph }),
		});
	} catch (err) {
		// Network error / offline — surface as a soft error so callers can
		// retry rather than crashing the builder.
		return {
			kind: "error",
			message:
				err instanceof Error ? err.message : "Network error while saving",
		};
	}
	return parseGraphSaveResponse(res);
}

// ---------------------------------------------------------------------------
// Main canvas
// ---------------------------------------------------------------------------

function isCycleWithoutPauseForEdge(
	nodes: AutomationNode[],
	edges: AutomationEdge[],
	candidate: AutomationEdge,
): boolean {
	// Light-weight check: would adding `candidate` close a loop that contains
	// no input/delay/goto node? We replay server-style cycle detection.
	const adj = new Map<string, string[]>();
	for (const e of edges.concat([candidate])) {
		if (!adj.has(e.from_node)) adj.set(e.from_node, []);
		adj.get(e.from_node)!.push(e.to_node);
	}
	const byKey = new Map(nodes.map((n) => [n.key, n]));
	const PAUSE = new Set(["input", "delay", "goto"]);
	const color = new Map<string, 0 | 1 | 2>();
	const stack: string[] = [];
	let foundBad = false;
	const dfs = (u: string): void => {
		if (foundBad) return;
		color.set(u, 1);
		stack.push(u);
		for (const v of adj.get(u) ?? []) {
			const c = color.get(v) ?? 0;
			if (c === 1) {
				const idx = stack.indexOf(v);
				if (idx >= 0) {
					const cycle = stack.slice(idx);
					const hasPause = cycle.some((k) => {
						const n = byKey.get(k);
						return n ? PAUSE.has(n.kind) : false;
					});
					if (!hasPause) {
						foundBad = true;
						return;
					}
				}
			} else if (c === 0) dfs(v);
		}
		stack.pop();
		color.set(u, 2);
	};
	for (const n of nodes) {
		if ((color.get(n.key) ?? 0) === 0) dfs(n.key);
		if (foundBad) break;
	}
	return foundBad;
}

const OVERLAY_PERIOD_KEY = "relay.automation.overlay-period";
const OVERLAY_PERIODS: OverlayPeriod[] = ["24h", "7d", "30d", "90d"];

function loadOverlayPeriod(): OverlayPeriod {
	if (typeof window === "undefined") return "7d";
	try {
		const stored = window.localStorage.getItem(OVERLAY_PERIOD_KEY);
		if (stored && (OVERLAY_PERIODS as string[]).includes(stored)) {
			return stored as OverlayPeriod;
		}
	} catch {
		// Private mode / storage disabled — fall through to default.
	}
	return "7d";
}

function persistOverlayPeriod(period: OverlayPeriod): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(OVERLAY_PERIOD_KEY, period);
	} catch {
		// Ignore.
	}
}

function CanvasInner({
	automationId,
	channel,
	graphStore,
	catalog,
	readOnly = false,
	automationStatus,
	onAutoArrange,
	onSave,
	entrypoints = [],
	onSelectTrigger,
	onAddEntrypoint,
	triggerSelected = false,
	onPaneClick,
}: GuidedFlowProps) {
	const rf = useReactFlow();
	const wrapperRef = useRef<HTMLDivElement | null>(null);
	const fitSignatureRef = useRef<string | null>(null);
	const connectStartRef = useRef<{ nodeKey: string; portKey: string } | null>(
		null,
	);
	const lastPasteOffset = useRef<number>(0);
	const toast = useTinyToast();

	// Overlay controls — only active when the flow is live. Period persists
	// across reloads so the ops team can stay in their preferred window.
	const overlaysEnabled = automationStatus === "active";
	const [overlayPeriod, setOverlayPeriod] = useState<OverlayPeriod>(() =>
		loadOverlayPeriod(),
	);
	const handleOverlayPeriodChange = useCallback((next: OverlayPeriod) => {
		setOverlayPeriod(next);
		persistOverlayPeriod(next);
	}, []);
	const overlay = useNodeOverlays(automationId, overlayPeriod, overlaysEnabled);

	const [insertMenu, setInsertMenu] = useState<
		| null
		| {
				screen: { x: number; y: number };
				flow: { x: number; y: number };
				sourcePort?: { nodeKey: string; portKey: string };
		  }
	>(null);

	const { graph, selection } = graphStore;

	// Trigger canvas node position is local state (the synthetic "__trigger"
	// node is NOT in graph.nodes). Default places it to the left of the root.
	const [triggerPos, setTriggerPos] = useState<XYPosition>({ x: -480, y: 0 });

	// Entrypoint kinds available for this automation's channel — passed into
	// the trigger card's "+ New Trigger" dropdown.
	const availableKinds = useMemo(() => {
		if (!catalog) return [] as CatalogEntrypointKind[];
		return catalog.entrypoint_kinds.filter((k) => {
			const channels = Array.isArray(k.channels) ? k.channels : [];
			if (channels.length === 0) return true;
			return channels.includes(channel);
		});
	}, [catalog, channel]);

	// Auto-arrange positions — computed once per graph change; used only as a
	// fallback when a node has no stored canvas position (e.g. just inserted
	// by the menu with a cursor-space coordinate).
	const autoPositions = useMemo(
		() => computeAutoPositions(graph.nodes, graph.edges, graph.root_node_key),
		[graph],
	);

	// --- React Flow data ---------------------------------------------------

	const rfNodes = useMemo<Node[]>(() => {
		const triggerNode: Node<TriggerNodeData> = {
			id: TRIGGER_NODE_ID,
			type: "trigger",
			position: triggerPos,
			data: {
				channel,
				entrypoints,
				availableKinds,
				readOnly,
				onSelectCard: () => onSelectTrigger?.(null),
				onSelectEntrypoint: (epId) => onSelectTrigger?.(epId),
				onAddEntrypoint: (kind) => onAddEntrypoint?.(kind),
			},
			selected: triggerSelected,
			selectable: true,
			draggable: !readOnly,
		};

		const stepNodes: Node<NodeData>[] = graph.nodes.map((node) => {
			const fallback = autoPositions.get(node.key);
			return {
				id: node.key,
				type: "canvas",
				position: {
					x: node.canvas_x ?? fallback?.x ?? 0,
					y: node.canvas_y ?? fallback?.y ?? 0,
				},
				data: {
					node,
					catalog,
					channel,
					readOnly,
					metrics: overlaysEnabled ? overlay.data.get(node.key) : undefined,
					overlaysEnabled,
				},
				selected: selection.includes(node.key),
				selectable: true,
				draggable: !readOnly,
			};
		});

		return [triggerNode, ...stepNodes];
	}, [
		autoPositions,
		availableKinds,
		catalog,
		channel,
		entrypoints,
		graph.nodes,
		onAddEntrypoint,
		onSelectTrigger,
		overlay.data,
		overlaysEnabled,
		readOnly,
		selection,
		triggerPos,
		triggerSelected,
	]);

	const rfEdges = useMemo<Edge[]>(() => {
		const edges: Edge[] = graph.edges.map((e, index) => ({
			id: `${e.from_node}.${e.from_port}→${e.to_node}.${e.to_port}`,
			source: e.from_node,
			sourceHandle: e.from_port,
			target: e.to_node,
			targetHandle: e.to_port,
			type: "default",
			data: { edgeIndex: index },
			markerEnd: {
				type: MarkerType.ArrowClosed,
				width: 18,
				height: 18,
				color: "#9aa7bd",
			},
			style: { stroke: "#9aa7bd", strokeWidth: 2 },
		}));

		// Synthetic trigger → root edge. Not stored anywhere; purely visual.
		if (graph.root_node_key) {
			edges.unshift({
				id: `${TRIGGER_NODE_ID}→${graph.root_node_key}`,
				source: TRIGGER_NODE_ID,
				sourceHandle: "out",
				target: graph.root_node_key,
				targetHandle: "in",
				type: "default",
				deletable: false,
				markerEnd: {
					type: MarkerType.ArrowClosed,
					width: 18,
					height: 18,
					color: "#9aa7bd",
				},
				style: { stroke: "#9aa7bd", strokeWidth: 2 },
			});
		}
		return edges;
	}, [graph.edges, graph.root_node_key]);

	// --- Fit view on initial mount / big graph changes ---------------------

	useEffect(() => {
		const signature = `${rfNodes.length}:${rfEdges.length}`;
		if (fitSignatureRef.current === signature) return;
		fitSignatureRef.current = signature;
		const frame = requestAnimationFrame(() => {
			rf.fitView({ duration: 260, padding: 0.18 });
		});
		return () => cancelAnimationFrame(frame);
	}, [rfEdges.length, rfNodes.length, rf]);

	// --- Validation ping on every graph change -----------------------------

	useEffect(() => {
		const result = validateGraph(graph);
		graphStore.setValidation(result.errors, result.warnings);
	}, [graph, graphStore]);

	// --- Autosave ----------------------------------------------------------

	// Monotonically increasing save token so the autosave hook only triggers
	// on *content* change, not every re-render.
	const saveVersion = useMemo(
		() => `${graph.nodes.length}:${graph.edges.length}:${JSON.stringify(graph)}`.length,
		[graph],
	);

	const doSave = useCallback(async () => {
		if (readOnly) return;
		let result: GraphSaveResult;
		try {
			if (onSave) {
				result = await onSave(graph);
			} else {
				result = await defaultSave(automationId, graph);
			}
		} catch (err) {
			toast.push(
				err instanceof Error ? err.message : "Failed to save automation",
			);
			return;
		}

		if (result.kind === "error") {
			toast.push(result.message);
			return;
		}

		// Apply canonical graph + validation to the local store. The API may
		// have normalised the graph (derived ports, ordered edges), so we
		// overwrite the local copy with the server's version. Callers are
		// aware of the 750ms autosave debounce — edits made between request
		// and response are covered by the next save cycle.
		const serverGraph = result.graph as AutomationGraph;
		graphStore.setGraph(serverGraph);
		graphStore.markSaved();

		// Translate server validation payload → client ValidationIssue shape.
		const mapIssue = (
			iss: {
				node_key?: string;
				port_key?: string;
				edge_index?: number;
				code: string;
				message: string;
			},
			severity: "error" | "warning",
		) => ({
			code: iss.code,
			message: iss.message,
			severity,
			nodeKey: iss.node_key,
			portKey: iss.port_key,
			edgeIndex: iss.edge_index,
		});
		graphStore.setValidation(
			result.validation.errors.map((e) => mapIssue(e, "error")),
			result.validation.warnings.map((w) => mapIssue(w, "warning")),
		);

		if (result.kind === "saved_with_errors") {
			// Server force-paused the automation (or kept it paused) because the
			// graph has fatal errors. Surface a toast — the validation banner
			// elsewhere in the UI picks up the error list from the store.
			toast.push(
				result.automation_status === "paused"
					? "Graph saved with errors. Automation paused."
					: "Graph saved with errors.",
			);
		}
	}, [automationId, graph, graphStore, onSave, readOnly, toast]);

	useAutosave({
		version: saveVersion,
		dirty: graphStore.dirty,
		onSave: doSave,
		debounceMs: 750,
		enabled: !readOnly,
	});

	// --- React Flow event handlers -----------------------------------------

	const onNodesChange = useCallback(
		(changes: NodeChange[]) => {
			for (const change of changes) {
				if (change.type === "position" && change.position && !change.dragging) {
					if (change.id === TRIGGER_NODE_ID) {
						// Persist trigger card position in component-local state. It
						// is not part of the graph — the server never sees it.
						setTriggerPos({
							x: change.position.x,
							y: change.position.y,
						});
						continue;
					}
					// Commit position on drag stop only (avoids history spam per pixel).
					graphStore.moveNode(change.id, {
						x: change.position.x,
						y: change.position.y,
					});
				} else if (change.type === "select") {
					// React Flow's internal selection — translate to store selection.
					// We coalesce multiple select events at the end of the changes
					// array into a single setSelection dispatch.
				} else if (change.type === "remove") {
					if (change.id === TRIGGER_NODE_ID) {
						// Trigger card is virtual; ignore delete requests.
						continue;
					}
					if (graph.root_node_key === change.id) {
						toast.push("Cannot delete the root node");
						continue;
					}
					graphStore.removeNodes([change.id]);
				}
			}
			// Apply selection changes in a single pass. The trigger node's
			// selection is driven by the parent (via `triggerSelected`), so we
			// skip it here to avoid polluting the graph store's selection with
			// synthetic ids.
			const selectEvents = changes.filter(
				(c): c is Extract<NodeChange, { type: "select" }> =>
					c.type === "select" && c.id !== TRIGGER_NODE_ID,
			);
			if (selectEvents.length > 0) {
				const next = new Set(selection);
				for (const ev of selectEvents) {
					if (ev.selected) next.add(ev.id);
					else next.delete(ev.id);
				}
				graphStore.setSelection(Array.from(next));
			}
		},
		[graph.root_node_key, graphStore, selection, toast],
	);

	const onEdgesChange = useCallback(
		(changes: EdgeChange[]) => {
			for (const change of changes) {
				if (change.type === "remove") {
					// Synthetic trigger edge is visual-only; ignore.
					if (change.id.startsWith(`${TRIGGER_NODE_ID}→`)) continue;
					// `change.id` format matches rfEdges.id
					const idx = graph.edges.findIndex(
						(e, i) =>
							`${e.from_node}.${e.from_port}→${e.to_node}.${e.to_port}` ===
							change.id,
					);
					if (idx >= 0) graphStore.removeEdge(idx);
				}
			}
		},
		[graph.edges, graphStore],
	);

	const onConnect = useCallback(
		(connection: Connection) => {
			if (readOnly) return;
			connectStartRef.current = null;
			setInsertMenu(null);

			const { source, sourceHandle, target, targetHandle } = connection;
			if (!source || !sourceHandle || !target || !targetHandle) return;

			// The synthetic trigger node is not part of the graph; ignore any
			// attempt to route an edge through it.
			if (source === TRIGGER_NODE_ID || target === TRIGGER_NODE_ID) {
				return;
			}

			const fromNode = graph.nodes.find((n) => n.key === source);
			const toNode = graph.nodes.find((n) => n.key === target);
			if (!fromNode || !toNode) {
				toast.push("Connection failed: unknown node");
				return;
			}

			const fromPorts = derivePorts(fromNode);
			const toPorts = derivePorts(toNode);
			const fromPort = fromPorts.find(
				(p) => p.key === sourceHandle && p.direction === "output",
			);
			const toPort = toPorts.find(
				(p) => p.key === targetHandle && p.direction === "input",
			);
			if (!fromPort) {
				toast.push(`Source port "${sourceHandle}" is not an output`);
				return;
			}
			if (!toPort) {
				toast.push(`Target port "${targetHandle}" is not an input`);
				return;
			}
			if (source === target && toNode.kind !== "goto") {
				toast.push("Self-loops are only allowed via a Go To node");
				return;
			}

			// Second connection on the same source port replaces the first.
			const existingIdx = graph.edges.findIndex(
				(e) => e.from_node === source && e.from_port === sourceHandle,
			);

			const candidate: AutomationEdge = {
				from_node: source,
				from_port: sourceHandle,
				to_node: target,
				to_port: targetHandle,
			};

			// Cycle guard.
			const stripped =
				existingIdx >= 0
					? graph.edges.filter((_, i) => i !== existingIdx)
					: graph.edges;
			if (isCycleWithoutPauseForEdge(graph.nodes, stripped, candidate)) {
				toast.push("Connection would create a loop without a pause point");
				return;
			}

			if (existingIdx >= 0) {
				graphStore.reconnectEdge(existingIdx, {
					to_node: target,
					to_port: targetHandle,
				});
			} else {
				graphStore.addEdge(source, sourceHandle, target, targetHandle);
			}
		},
		[graph.edges, graph.nodes, graphStore, readOnly, toast],
	);

	const onConnectStart = useCallback(
		(
			_e: unknown,
			params: { nodeId: string | null; handleId: string | null },
		) => {
			if (readOnly || !params.nodeId || !params.handleId) {
				connectStartRef.current = null;
				return;
			}
			connectStartRef.current = {
				nodeKey: params.nodeId,
				portKey: params.handleId,
			};
		},
		[readOnly],
	);

	const onConnectEnd = useCallback(
		(event: MouseEvent | TouchEvent) => {
			if (readOnly || !connectStartRef.current) return;
			const target = event.target as HTMLElement | null;
			if (target?.closest(".react-flow__handle")) {
				// User landed on a valid handle — React Flow will fire onConnect.
				connectStartRef.current = null;
				return;
			}
			const bounds = wrapperRef.current?.getBoundingClientRect();
			if (!bounds) {
				connectStartRef.current = null;
				return;
			}
			const pointer =
				"changedTouches" in event
					? event.changedTouches[0]
					: (event as MouseEvent);
			if (!pointer) {
				connectStartRef.current = null;
				return;
			}
			const flow = rf.screenToFlowPosition({
				x: pointer.clientX,
				y: pointer.clientY,
			});
			setInsertMenu({
				screen: {
					x: pointer.clientX - bounds.left,
					y: pointer.clientY - bounds.top,
				},
				flow,
				sourcePort: connectStartRef.current,
			});
			connectStartRef.current = null;
		},
		[readOnly, rf],
	);

	// --- Insert menu commit ------------------------------------------------

	const handleInsert = useCallback(
		(
			kind: string,
			position: { x: number; y: number },
			connect?: { sourceNodeKey: string; sourcePortKey: string },
		) => {
			if (readOnly) return;
			const newKey = graphStore.addNode(kind, position, connect);
			graphStore.setSelection([newKey]);
		},
		[graphStore, readOnly],
	);

	// --- Auto-arrange ------------------------------------------------------

	const handleAutoArrange = useCallback(() => {
		if (readOnly) return;
		const positions = computeAutoPositions(
			graph.nodes,
			graph.edges,
			graph.root_node_key,
		);
		for (const [key, pos] of positions) {
			graphStore.moveNode(key, pos);
		}
		requestAnimationFrame(() => {
			rf.fitView({ duration: 220, padding: 0.18 });
		});
		onAutoArrange?.();
	}, [graph, graphStore, onAutoArrange, readOnly, rf]);

	// --- Keyboard shortcuts (Task L5) --------------------------------------

	useEffect(() => {
		if (typeof window === "undefined") return;

		const isEditable = (el: EventTarget | null): boolean => {
			if (!(el instanceof HTMLElement)) return false;
			if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
			if (el.isContentEditable) return true;
			return false;
		};

		const handler = async (e: KeyboardEvent) => {
			if (isEditable(e.target)) return;
			const mod = e.metaKey || e.ctrlKey;

			// Cmd+K or "/" opens the insert menu at viewport centre.
			if ((mod && e.key.toLowerCase() === "k") || (!mod && e.key === "/")) {
				if (readOnly) return;
				e.preventDefault();
				const bounds = wrapperRef.current?.getBoundingClientRect();
				if (!bounds) return;
				const screenCenter = {
					x: bounds.width / 2,
					y: bounds.height / 2,
				};
				const flowCenter = rf.screenToFlowPosition({
					x: bounds.left + screenCenter.x,
					y: bounds.top + screenCenter.y,
				});
				setInsertMenu({
					screen: { x: screenCenter.x - 160, y: screenCenter.y - 20 },
					flow: flowCenter,
				});
				return;
			}

			// Delete / Backspace removes selected nodes.
			if ((e.key === "Delete" || e.key === "Backspace") && !mod) {
				if (readOnly) return;
				if (selection.length === 0) return;
				e.preventDefault();
				const deletable = selection.filter(
					(k) => k !== graph.root_node_key,
				);
				if (deletable.length !== selection.length) {
					toast.push("Root node cannot be deleted");
				}
				if (deletable.length > 0) graphStore.removeNodes(deletable);
				return;
			}

			// Duplicate (Cmd+D).
			if (mod && e.key.toLowerCase() === "d" && !e.shiftKey) {
				if (readOnly || selection.length === 0) return;
				e.preventDefault();
				duplicateSelection();
				return;
			}

			// Copy (Cmd+C).
			if (mod && e.key.toLowerCase() === "c" && !e.shiftKey) {
				if (selection.length === 0) return;
				e.preventDefault();
				await copySelection();
				return;
			}

			// Paste (Cmd+V).
			if (mod && e.key.toLowerCase() === "v" && !e.shiftKey) {
				if (readOnly) return;
				e.preventDefault();
				await pasteClipboard();
				return;
			}

			// Undo / Redo.
			if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
				if (readOnly) return;
				e.preventDefault();
				graphStore.undo();
				return;
			}
			if (
				(mod && e.key.toLowerCase() === "z" && e.shiftKey) ||
				(mod && e.key.toLowerCase() === "y")
			) {
				if (readOnly) return;
				e.preventDefault();
				graphStore.redo();
				return;
			}

			// Force save (Cmd+S).
			if (mod && e.key.toLowerCase() === "s") {
				if (readOnly) return;
				e.preventDefault();
				void doSave();
				return;
			}

			// Frame selection (F).
			if (!mod && (e.key === "f" || e.key === "F")) {
				if (selection.length === 0) {
					rf.fitView({ duration: 220, padding: 0.18 });
					return;
				}
				e.preventDefault();
				const selectedNodes = rf.getNodes().filter((n) => selection.includes(n.id));
				rf.fitView({
					duration: 220,
					padding: 0.25,
					nodes: selectedNodes,
				});
				return;
			}

			// Reset zoom (0).
			if (!mod && e.key === "0") {
				e.preventDefault();
				rf.zoomTo(1, { duration: 160 });
				return;
			}
		};

		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		graph.root_node_key,
		graphStore,
		readOnly,
		rf,
		selection,
		toast,
		doSave,
	]);

	// --- Clipboard helpers -------------------------------------------------

	const copySelection = useCallback(async () => {
		const selected = new Set(selection);
		const nodes = graph.nodes.filter((n) => selected.has(n.key));
		const edges = graph.edges.filter(
			(e) => selected.has(e.from_node) && selected.has(e.to_node),
		);
		const payload = {
			schema_version: 1,
			nodes,
			edges,
		};
		try {
			await navigator.clipboard.writeText(JSON.stringify(payload));
			toast.push(`Copied ${nodes.length} node${nodes.length === 1 ? "" : "s"}`);
		} catch {
			toast.push("Clipboard write blocked");
		}
	}, [graph.edges, graph.nodes, selection, toast]);

	const pasteClipboard = useCallback(async () => {
		let text: string;
		try {
			text = await navigator.clipboard.readText();
		} catch {
			toast.push("Clipboard read blocked");
			return;
		}
		let payload: {
			schema_version?: number;
			nodes?: AutomationNode[];
			edges?: AutomationEdge[];
		};
		try {
			payload = JSON.parse(text);
		} catch {
			toast.push("Clipboard is not a valid node payload");
			return;
		}
		if (!payload?.nodes || !Array.isArray(payload.nodes)) {
			toast.push("Clipboard has no nodes");
			return;
		}

		const keyMap = new Map<string, string>();
		lastPasteOffset.current += 40;
		const offset = lastPasteOffset.current;

		for (const node of payload.nodes) {
			keyMap.set(node.key, generateNodeKey());
		}

		// Rewrite nodes with fresh keys + offset.
		const newNodes: AutomationNode[] = payload.nodes.map((n) => ({
			...n,
			key: keyMap.get(n.key)!,
			canvas_x: (n.canvas_x ?? 0) + offset,
			canvas_y: (n.canvas_y ?? 0) + offset,
		}));

		const newEdges: AutomationEdge[] = (payload.edges ?? [])
			.map((e) => {
				const from = keyMap.get(e.from_node);
				const to = keyMap.get(e.to_node);
				if (!from || !to) return null;
				return { ...e, from_node: from, to_node: to };
			})
			.filter((e): e is AutomationEdge => e !== null);

		// We need to apply these as a SET_GRAPH so the history entry contains
		// the before-state intact. Build the merged graph and set it.
		graphStore.setGraph({
			...graph,
			nodes: graph.nodes.concat(newNodes),
			edges: graph.edges.concat(newEdges),
		});
		graphStore.setSelection(newNodes.map((n) => n.key));
		toast.push(
			`Pasted ${newNodes.length} node${newNodes.length === 1 ? "" : "s"}`,
		);
	}, [graph, graphStore, toast]);

	const duplicateSelection = useCallback(() => {
		if (selection.length === 0) return;
		const selected = new Set(selection);
		const nodes = graph.nodes.filter((n) => selected.has(n.key));
		const edges = graph.edges.filter(
			(e) => selected.has(e.from_node) && selected.has(e.to_node),
		);
		const keyMap = new Map<string, string>();
		for (const n of nodes) keyMap.set(n.key, generateNodeKey());

		const newNodes: AutomationNode[] = nodes.map((n) => ({
			...n,
			key: keyMap.get(n.key)!,
			canvas_x: (n.canvas_x ?? 0) + 40,
			canvas_y: (n.canvas_y ?? 0) + 40,
		}));
		const newEdges: AutomationEdge[] = edges
			.map((e) => {
				const from = keyMap.get(e.from_node);
				const to = keyMap.get(e.to_node);
				if (!from || !to) return null;
				return { ...e, from_node: from, to_node: to };
			})
			.filter((e): e is AutomationEdge => e !== null);

		graphStore.setGraph({
			...graph,
			nodes: graph.nodes.concat(newNodes),
			edges: graph.edges.concat(newEdges),
		});
		graphStore.setSelection(newNodes.map((n) => n.key));
	}, [graph, graphStore, selection]);

	// --- Render ------------------------------------------------------------

	return (
		<div ref={wrapperRef} className="relative h-full min-w-0 flex-1 bg-[#f5f6fa]">
			<ReactFlow
				nodes={rfNodes}
				edges={rfEdges}
				nodeTypes={nodeTypes}
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onConnect={onConnect}
				onConnectStart={onConnectStart}
				onConnectEnd={onConnectEnd}
				onPaneClick={() => {
					setInsertMenu(null);
					graphStore.setSelection([]);
					onPaneClick?.();
				}}
				proOptions={{ hideAttribution: true }}
				fitView
				fitViewOptions={{ padding: 0.18 }}
				edgesUpdatable={!readOnly}
				nodesConnectable={!readOnly}
				nodesDraggable={!readOnly}
				selectionOnDrag
				multiSelectionKeyCode={["Meta", "Shift"]}
				deleteKeyCode={null} // we handle delete ourselves to surface the root-node toast
				minZoom={0.2}
				maxZoom={1.8}
				className="bg-transparent"
			>
				<Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#dfe2ea" />
				<CanvasControls
					onAutoArrange={readOnly ? undefined : handleAutoArrange}
				/>
				{!readOnly ? (
					<Panel position="top-left" className="!left-4 !top-4">
						<button
							type="button"
							className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm hover:bg-slate-50"
							onClick={() => {
								const bounds = wrapperRef.current?.getBoundingClientRect();
								if (!bounds) return;
								const screen = {
									x: bounds.width / 2 - 160,
									y: 80,
								};
								const flow = rf.screenToFlowPosition({
									x: bounds.left + bounds.width / 2,
									y: bounds.top + 80,
								});
								setInsertMenu({ screen, flow });
							}}
						>
							<Plus className="size-3.5" />
							Add node
						</button>
					</Panel>
				) : null}
				{overlaysEnabled ? (
					<Panel
						position="top-left"
						className={cn("!left-4", readOnly ? "!top-4" : "!top-14")}
					>
						<div
							className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-1 py-1 text-[11px] shadow-sm"
							role="tablist"
							aria-label="Metric overlay period"
						>
							{OVERLAY_PERIODS.map((p) => (
								<button
									key={p}
									type="button"
									role="tab"
									aria-selected={overlayPeriod === p}
									onClick={() => handleOverlayPeriodChange(p)}
									className={cn(
										"rounded-full px-2.5 py-0.5 font-medium transition-colors",
										overlayPeriod === p
											? "bg-slate-900 text-white"
											: "text-slate-500 hover:bg-slate-100",
									)}
								>
									{p}
								</button>
							))}
							{overlay.loading ? (
								<span className="ml-1 text-[10px] text-slate-400">…</span>
							) : overlay.error ? (
								<span
									className="ml-1 text-[10px] text-rose-500"
									title={overlay.error.message}
								>
									!
								</span>
							) : null}
						</div>
					</Panel>
				) : null}
			</ReactFlow>
			{insertMenu && !readOnly ? (
				<InsertMenu
					open={true}
					position={insertMenu.screen}
					channel={channel}
					catalog={catalog}
					sourcePort={insertMenu.sourcePort}
					targetPosition={insertMenu.flow}
					onClose={() => setInsertMenu(null)}
					onInsert={handleInsert}
				/>
			) : null}
			{toast.view}
		</div>
	);
}

export function GuidedFlow(props: GuidedFlowProps) {
	return (
		<ReactFlowProvider>
			<CanvasInner {...props} />
		</ReactFlowProvider>
	);
}

// Re-export canvas helpers so tests / other builders can reuse them. Not part
// of the public API.
export const __test__ = {
	computeAutoPositions,
	isCycleWithoutPauseForEdge,
};
