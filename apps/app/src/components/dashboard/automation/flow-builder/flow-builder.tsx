import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ReactFlow,
	ReactFlowProvider,
	Background,
	Controls,
	MiniMap,
	addEdge,
	applyNodeChanges,
	applyEdgeChanges,
	useReactFlow,
	type Node,
	type Edge,
	type Connection,
	type NodeChange,
	type EdgeChange,
	type NodeTypes,
	type EdgeTypes,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import { TriggerNode } from "./nodes/trigger-node";
import { GenericNode } from "./nodes/generic-node";
import { LabeledEdge } from "./edge-components";
import { autoLayout, needsAutoLayout } from "./auto-layout";
import { PALETTE_DRAG_MIME } from "./node-palette";
import type {
	AutomationDetail,
	AutomationEdgeSpec,
	AutomationNodeSpec,
	AutomationSchema,
	SchemaNodeDef,
} from "./types";

const nodeTypes: NodeTypes = {
	trigger: TriggerNode,
	generic: GenericNode,
};

const edgeTypes: EdgeTypes = {
	labeled: LabeledEdge,
};

function nodeSummary(spec: AutomationNodeSpec): string | undefined {
	if (typeof spec.text === "string") return spec.text as string;
	if (typeof spec.prompt === "string") return spec.prompt as string;
	if (typeof spec.when === "string") return spec.when as string;
	if (typeof spec.url === "string") return spec.url as string;
	if (typeof spec.target === "string") return `→ ${spec.target}`;
	return undefined;
}

/**
 * Catalog of valid output labels for the given node. Combines the schema's
 * static `output_labels` with any dynamic labels defined on the node itself
 * (randomizer branches, split_test variants, ai_intent_router intents).
 */
function availableLabelsFor(
	sourceNode: AutomationNodeSpec | undefined,
	def: SchemaNodeDef | undefined,
): string[] {
	const base = def?.output_labels ?? ["next"];
	if (!sourceNode) return base;
	const extras: string[] = [];
	if (sourceNode.type === "randomizer" && Array.isArray(sourceNode.branches)) {
		for (const b of sourceNode.branches as Array<{ label?: string }>) {
			if (typeof b?.label === "string") extras.push(b.label);
		}
	}
	if (sourceNode.type === "split_test" && Array.isArray(sourceNode.variants)) {
		for (const v of sourceNode.variants as Array<{ label?: string }>) {
			if (typeof v?.label === "string") extras.push(v.label);
		}
	}
	if (
		sourceNode.type === "ai_intent_router" &&
		Array.isArray(sourceNode.intents)
	) {
		for (const it of sourceNode.intents as Array<{ label?: string }>) {
			if (typeof it?.label === "string") extras.push(it.label);
		}
	}
	return Array.from(new Set([...base, ...extras]));
}

/**
 * Pick the default label for a new edge from `sourceKey`. We use the first
 * available label that isn't already used by another outgoing edge from that
 * node, so repeatedly connecting from a condition creates `yes`, then `no`,
 * then whatever's next in the schema's output list.
 */
function pickDefaultLabel(
	sourceKey: string,
	sourceNode: AutomationNodeSpec | undefined,
	def: SchemaNodeDef | undefined,
	existingEdges: AutomationEdgeSpec[],
): string {
	const available = availableLabelsFor(sourceNode, def);
	const used = new Set(
		existingEdges.filter((e) => e.from === sourceKey).map((e) => e.label),
	);
	for (const lbl of available) {
		if (!used.has(lbl)) return lbl;
	}
	return available[0] ?? "next";
}

function toReactFlowNodes(
	automation: AutomationDetail,
	schemaNodesByType: Map<string, SchemaNodeDef>,
	errorKeys: Set<string>,
	highlightKeys: Set<string>,
): Node[] {
	const triggerNode: Node = {
		id: "trigger",
		type: "trigger",
		position: { x: 0, y: 0 },
		data: {
			label: "Trigger",
			triggerType: automation.trigger_type,
			channel: automation.channel,
		},
		draggable: true,
	};

	const rest: Node[] = automation.nodes.map((spec) => {
		const def = schemaNodesByType.get(spec.type);
		return {
			id: spec.key,
			type: "generic",
			position: {
				x: typeof spec.canvas_x === "number" ? spec.canvas_x : 0,
				y: typeof spec.canvas_y === "number" ? spec.canvas_y : 0,
			},
			data: {
				label: spec.key,
				key: spec.key,
				nodeType: spec.type,
				category: def?.category ?? "ops",
				summary: nodeSummary(spec),
				hasError: errorKeys.has(spec.key),
				highlighted: highlightKeys.has(spec.key),
				dimmed: highlightKeys.size > 0 && !highlightKeys.has(spec.key),
			},
			draggable: true,
		};
	});

	return [triggerNode, ...rest];
}

interface EdgeBuildDeps {
	nodesByKey: Map<string, AutomationNodeSpec>;
	schemaByType: Map<string, SchemaNodeDef>;
	onChangeLabel: (edgeId: string, label: string) => void;
	readOnly: boolean;
}

function toReactFlowEdges(
	edges: AutomationEdgeSpec[],
	deps: EdgeBuildDeps,
): Edge[] {
	return edges.map((e, i) => {
		const src = deps.nodesByKey.get(e.from);
		const def = src ? deps.schemaByType.get(src.type) : undefined;
		return {
			id: `${e.from}->${e.to}-${i}`,
			source: e.from,
			target: e.to,
			type: "labeled",
			data: {
				label: e.label,
				availableLabels: availableLabelsFor(src, def),
				onChangeLabel: deps.onChangeLabel,
				readOnly: deps.readOnly,
			},
		};
	});
}

interface FlowBuilderProps {
	automation: AutomationDetail;
	schema: AutomationSchema;
	errorKeys: Set<string>;
	highlightKeys?: Set<string>;
	selectedNodeKey: string | null;
	onSelectNode: (key: string | null) => void;
	onGraphChange: (
		nodes: AutomationNodeSpec[],
		edges: AutomationEdgeSpec[],
	) => void;
	onDropNodeType?: (nodeType: string, position: { x: number; y: number }) => void;
	readOnly?: boolean;
}

function FlowBuilderInner({
	automation,
	schema,
	errorKeys,
	highlightKeys,
	selectedNodeKey,
	onSelectNode,
	onGraphChange,
	onDropNodeType,
	readOnly = false,
}: FlowBuilderProps) {
	const wrapperRef = useRef<HTMLDivElement>(null);
	const { screenToFlowPosition } = useReactFlow();
	const schemaNodesByType = useMemo(
		() => new Map(schema.nodes.map((n) => [n.type, n])),
		[schema],
	);

	const nodesByKey = useMemo(
		() => new Map(automation.nodes.map((n) => [n.key, n])),
		[automation.nodes],
	);

	const effectiveHighlight = useMemo(
		() => highlightKeys ?? new Set<string>(),
		[highlightKeys],
	);

	// Ref holds the "change edge label" handler so the edge components can
	// call it after commit without triggering re-renders on every render.
	const onChangeLabelRef = useRef<(edgeId: string, label: string) => void>(
		() => undefined,
	);
	const edgeBuildDeps = useMemo(
		() => ({
			nodesByKey,
			schemaByType: schemaNodesByType,
			onChangeLabel: (edgeId: string, label: string) =>
				onChangeLabelRef.current(edgeId, label),
			readOnly,
		}),
		[nodesByKey, schemaNodesByType, readOnly],
	);

	const initialNodes = useMemo(() => {
		const rf = toReactFlowNodes(
			automation,
			schemaNodesByType,
			errorKeys,
			effectiveHighlight,
		);
		if (needsAutoLayout(rf)) {
			const rfEdges = toReactFlowEdges(automation.edges, edgeBuildDeps);
			return autoLayout(rf, rfEdges);
		}
		return rf;
	}, [automation, schemaNodesByType, errorKeys, effectiveHighlight, edgeBuildDeps]);

	const initialEdges = useMemo(
		() => toReactFlowEdges(automation.edges, edgeBuildDeps),
		[automation.edges, edgeBuildDeps],
	);

	const [nodes, setNodes] = useState<Node[]>(initialNodes);
	const [edges, setEdges] = useState<Edge[]>(initialEdges);

	useEffect(() => {
		setNodes(initialNodes);
		setEdges(initialEdges);
	}, [initialNodes, initialEdges]);

	useEffect(() => {
		setNodes((prev) =>
			prev.map((n) => {
				if (n.id === "trigger") return n;
				const hasError = errorKeys.has(n.id);
				const highlighted = effectiveHighlight.has(n.id);
				const dimmed = effectiveHighlight.size > 0 && !highlighted;
				const data = n.data as {
					hasError?: boolean;
					highlighted?: boolean;
					dimmed?: boolean;
				};
				if (
					data.hasError === hasError &&
					data.highlighted === highlighted &&
					data.dimmed === dimmed
				) {
					return n;
				}
				return { ...n, data: { ...n.data, hasError, highlighted, dimmed } };
			}),
		);
	}, [errorKeys, effectiveHighlight]);

	useEffect(() => {
		setNodes((prev) =>
			prev.map((n) => ({
				...n,
				selected: n.id === selectedNodeKey,
			})),
		);
	}, [selectedNodeKey]);

	const emitGraph = useCallback(
		(latestNodes: Node[], latestEdges: Edge[]) => {
			const specs: AutomationNodeSpec[] = [];
			for (const spec of automation.nodes) {
				const rf = latestNodes.find((n) => n.id === spec.key);
				if (!rf) continue;
				specs.push({
					...spec,
					canvas_x: Math.round(rf.position.x),
					canvas_y: Math.round(rf.position.y),
				});
			}
			const edgeSpecs: AutomationEdgeSpec[] = latestEdges.map((e) => {
				const label = (e.data as { label?: string } | undefined)?.label;
				const existing = automation.edges.find(
					(orig) => orig.from === e.source && orig.to === e.target,
				);
				return {
					from: e.source,
					to: e.target,
					label: label ?? existing?.label,
					order: existing?.order,
					condition_expr: existing?.condition_expr,
				};
			});
			onGraphChange(specs, edgeSpecs);
		},
		[automation.nodes, automation.edges, onGraphChange],
	);

	const onNodesChange = useCallback(
		(changes: NodeChange[]) => {
			setNodes((prev) => {
				const next = applyNodeChanges(changes, prev);
				const hasPositionChange = changes.some(
					(c) => c.type === "position" && c.dragging === false,
				);
				if (hasPositionChange) {
					setEdges((curr) => {
						emitGraph(next, curr);
						return curr;
					});
				}
				return next;
			});
		},
		[emitGraph],
	);

	const onEdgesChange = useCallback(
		(changes: EdgeChange[]) => {
			setEdges((prev) => {
				const next = applyEdgeChanges(changes, prev);
				const hasRemoval = changes.some((c) => c.type === "remove");
				if (hasRemoval) {
					setNodes((curr) => {
						emitGraph(curr, next);
						return curr;
					});
				}
				return next;
			});
		},
		[emitGraph],
	);

	const onConnect = useCallback(
		(connection: Connection) => {
			if (!connection.source || !connection.target) return;
			const sourceKey = connection.source;
			const srcNode = nodesByKey.get(sourceKey);
			const def = srcNode ? schemaNodesByType.get(srcNode.type) : undefined;
			const label = pickDefaultLabel(
				sourceKey,
				srcNode,
				def,
				automation.edges,
			);
			setEdges((prev) => {
				const next = addEdge(
					{
						...connection,
						type: "labeled",
						data: {
							label,
							availableLabels: availableLabelsFor(srcNode, def),
							onChangeLabel: (edgeId: string, lbl: string) =>
								onChangeLabelRef.current(edgeId, lbl),
							readOnly,
						},
					},
					prev,
				);
				setNodes((curr) => {
					emitGraph(curr, next);
					return curr;
				});
				return next;
			});
		},
		[emitGraph, nodesByKey, schemaNodesByType, automation.edges, readOnly],
	);

	const onEdgeLabelChange = useCallback(
		(edgeId: string, label: string) => {
			setEdges((prev) => {
				const next = prev.map((e) =>
					e.id === edgeId ? { ...e, data: { ...(e.data ?? {}), label } } : e,
				);
				setNodes((curr) => {
					emitGraph(curr, next);
					return curr;
				});
				return next;
			});
		},
		[emitGraph],
	);

	useEffect(() => {
		onChangeLabelRef.current = onEdgeLabelChange;
	}, [onEdgeLabelChange]);

	const onDragOver = useCallback((e: React.DragEvent) => {
		if (Array.from(e.dataTransfer.types).includes(PALETTE_DRAG_MIME)) {
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
		}
	}, []);

	const onDrop = useCallback(
		(e: React.DragEvent) => {
			if (readOnly || !onDropNodeType) return;
			const nodeType = e.dataTransfer.getData(PALETTE_DRAG_MIME);
			if (!nodeType) return;
			e.preventDefault();
			const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
			onDropNodeType(nodeType, position);
		},
		[readOnly, onDropNodeType, screenToFlowPosition],
	);

	return (
		<div ref={wrapperRef} className="w-full h-full bg-muted/40">
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				onNodesChange={readOnly ? undefined : onNodesChange}
				onEdgesChange={readOnly ? undefined : onEdgesChange}
				onConnect={readOnly ? undefined : onConnect}
				onNodeClick={(_, n) =>
					onSelectNode(n.id === "trigger" ? null : n.id)
				}
				onPaneClick={() => onSelectNode(null)}
				onDragOver={onDragOver}
				onDrop={onDrop}
				fitView
				proOptions={{ hideAttribution: true }}
			>
				<Background gap={16} size={1} />
				<Controls />
				<MiniMap pannable zoomable className="!bg-card !border-border" />
			</ReactFlow>
		</div>
	);
}

export function FlowBuilder(props: FlowBuilderProps) {
	return (
		<ReactFlowProvider>
			<FlowBuilderInner {...props} />
		</ReactFlowProvider>
	);
}
