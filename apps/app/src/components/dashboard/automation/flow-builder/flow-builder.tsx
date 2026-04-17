import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ReactFlow,
	ReactFlowProvider,
	Background,
	Controls,
	MiniMap,
	addEdge,
	applyNodeChanges,
	applyEdgeChanges,
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

function toReactFlowNodes(
	automation: AutomationDetail,
	schemaNodesByType: Map<string, SchemaNodeDef>,
	errorKeys: Set<string>,
): Node[] {
	const triggerNode: Node = {
		id: "trigger",
		type: "trigger",
		position: { x: 0, y: 0 },
		data: {
			label: "Trigger",
			triggerType: automation.trigger.type,
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
			},
			draggable: true,
		};
	});

	return [triggerNode, ...rest];
}

function toReactFlowEdges(edges: AutomationEdgeSpec[]): Edge[] {
	return edges.map((e, i) => ({
		id: `${e.from}->${e.to}-${i}`,
		source: e.from,
		target: e.to,
		type: "labeled",
		data: { label: e.label },
	}));
}

interface FlowBuilderProps {
	automation: AutomationDetail;
	schema: AutomationSchema;
	errorKeys: Set<string>;
	selectedNodeKey: string | null;
	onSelectNode: (key: string | null) => void;
	onGraphChange: (
		nodes: AutomationNodeSpec[],
		edges: AutomationEdgeSpec[],
	) => void;
	readOnly?: boolean;
}

function FlowBuilderInner({
	automation,
	schema,
	errorKeys,
	selectedNodeKey,
	onSelectNode,
	onGraphChange,
	readOnly = false,
}: FlowBuilderProps) {
	const schemaNodesByType = useMemo(
		() => new Map(schema.nodes.map((n) => [n.type, n])),
		[schema],
	);

	const initialNodes = useMemo(() => {
		const rf = toReactFlowNodes(automation, schemaNodesByType, errorKeys);
		if (needsAutoLayout(rf)) {
			const rfEdges = toReactFlowEdges(automation.edges);
			return autoLayout(rf, rfEdges);
		}
		return rf;
	}, [automation, schemaNodesByType, errorKeys]);

	const initialEdges = useMemo(
		() => toReactFlowEdges(automation.edges),
		[automation.edges],
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
				if ((n.data as { hasError?: boolean }).hasError === hasError) {
					return n;
				}
				return { ...n, data: { ...n.data, hasError } };
			}),
		);
	}, [errorKeys]);

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
			setEdges((prev) => {
				const next = addEdge(
					{ ...connection, type: "labeled", data: { label: "next" } },
					prev,
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

	return (
		<ReactFlow
			nodes={nodes}
			edges={edges}
			nodeTypes={nodeTypes}
			edgeTypes={edgeTypes}
			onNodesChange={readOnly ? undefined : onNodesChange}
			onEdgesChange={readOnly ? undefined : onEdgesChange}
			onConnect={readOnly ? undefined : onConnect}
			onNodeClick={(_, n) => onSelectNode(n.id === "trigger" ? null : n.id)}
			onPaneClick={() => onSelectNode(null)}
			fitView
			proOptions={{ hideAttribution: true }}
			colorMode="dark"
		>
			<Background gap={16} size={1} />
			<Controls />
			<MiniMap pannable zoomable className="!bg-card !border-border" />
		</ReactFlow>
	);
}

export function FlowBuilder(props: FlowBuilderProps) {
	return (
		<ReactFlowProvider>
			<FlowBuilderInner {...props} />
		</ReactFlowProvider>
	);
}
