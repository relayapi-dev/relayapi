// Builder graph store (Plan 2 — Unit K1).
//
// Holds the in-memory editing state for a single automation graph: the
// canonical `AutomationGraph`, current selection, dirty flag (graph !==
// last-saved snapshot), validation issues, and a bounded undo/redo history.
//
// Implementation notes:
// - Uses React `useReducer` + a `useSyncExternalStore`-style hook isn't needed
//   because we expose the state directly from the hook. Consumers re-render
//   when the reducer dispatches.
// - History is bounded at 50 entries on the past side; pushing beyond drops
//   the oldest entry. The future stack clears on every mutation.
// - All "mutations" (addNode / removeNodes / etc.) push the *prior* graph
//   onto `past`, then mutate. Undo restores the most recent past entry.
// - `addNode(kind, position, connect?)` is atomic: when `connect` is set, the
//   new node and its inbound edge land in the same dispatch. If the source
//   port was already connected, we replace that edge in the same history
//   entry and preserve the downstream target when the inserted node has a
//   single default output.
// - Node keys are short opaque ids (8 chars). We try to use the SDK's
//   nanoid-style generator if available; otherwise fall back to a sliced
//   `crypto.randomUUID()`.

import { useCallback, useMemo, useReducer, useRef } from "react";
import type {
	AutomationEdge,
	AutomationGraph,
	AutomationNode,
} from "./graph-types";
import { derivePorts } from "./derive-ports";
import type { ValidationIssue } from "./validation";

const HISTORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphStoreState {
	graph: AutomationGraph;
	selection: string[];
	dirty: boolean;
	validationErrors: ValidationIssue[];
	validationWarnings: ValidationIssue[];
	history: { past: AutomationGraph[]; future: AutomationGraph[] };
}

export interface GraphStoreActions {
	setGraph(g: AutomationGraph): void;
	addNode(
		kind: string,
		position: { x: number; y: number },
		connect?: { sourceNodeKey: string; sourcePortKey: string },
	): string;
	removeNodes(keys: string[]): void;
	moveNode(key: string, position: { x: number; y: number }): void;
	updateNodeConfig(key: string, config: Record<string, unknown>): void;
	updateNodeTitle(key: string, title: string): void;
	addEdge(
		fromNode: string,
		fromPort: string,
		toNode: string,
		toPort: string,
	): void;
	removeEdge(index: number): void;
	reconnectEdge(index: number, newEnd: Partial<AutomationEdge>): void;
	setSelection(keys: string[]): void;
	setValidation(
		errors: ValidationIssue[],
		warnings: ValidationIssue[],
	): void;
	undo(): void;
	redo(): void;
	markSaved(): void;
}

export type UseGraphStore = GraphStoreState & GraphStoreActions;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ID_ALPHABET =
	"23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function generateNodeKey(): string {
	if (
		typeof globalThis.crypto !== "undefined" &&
		typeof globalThis.crypto.getRandomValues === "function"
	) {
		const buf = new Uint8Array(8);
		globalThis.crypto.getRandomValues(buf);
		let out = "";
		for (let i = 0; i < buf.length; i++) {
			out += ID_ALPHABET[buf[i]! % ID_ALPHABET.length];
		}
		return out;
	}
	// Last-resort fallback (test environments without WebCrypto).
	return Math.random().toString(36).slice(2, 10);
}

export const EMPTY_GRAPH: AutomationGraph = {
	schema_version: 1,
	root_node_key: null,
	nodes: [],
	edges: [],
};

function cloneGraph(g: AutomationGraph): AutomationGraph {
	// Structured clone is overkill and isn't always faster than JSON for the
	// kind of plain objects we deal with here.
	return JSON.parse(JSON.stringify(g)) as AutomationGraph;
}

function pushHistory(
	history: GraphStoreState["history"],
	prev: AutomationGraph,
): GraphStoreState["history"] {
	const past = history.past.concat([cloneGraph(prev)]);
	while (past.length > HISTORY_LIMIT) past.shift();
	return { past, future: [] };
}

// Cheap field-wise equality for two ValidationIssue lists. `validateGraph`
// returns fresh array and object identities on every call, so reference
// equality can't be used to short-circuit the SET_VALIDATION reducer.
function validationIssuesEqual(
	a: ValidationIssue[],
	b: ValidationIssue[],
): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!;
		const y = b[i]!;
		if (
			x.code !== y.code ||
			x.message !== y.message ||
			x.severity !== y.severity ||
			x.nodeKey !== y.nodeKey ||
			x.portKey !== y.portKey ||
			x.edgeIndex !== y.edgeIndex
		) {
			return false;
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

type Action =
	| { type: "SET_GRAPH"; graph: AutomationGraph; resetHistory?: boolean }
	| {
			type: "ADD_NODE";
			node: AutomationNode;
			edge?: AutomationEdge;
			tailEdge?: AutomationEdge;
			replaceEdgeIndex?: number;
			removeNodeKeys?: string[];
	  }
	| { type: "REMOVE_NODES"; keys: string[] }
	| { type: "MOVE_NODE"; key: string; x: number; y: number }
	| {
			type: "UPDATE_NODE_CONFIG";
			key: string;
			config: Record<string, unknown>;
	  }
	| { type: "UPDATE_NODE_TITLE"; key: string; title: string }
	| { type: "ADD_EDGE"; edge: AutomationEdge }
	| { type: "REMOVE_EDGE"; index: number }
	| { type: "RECONNECT_EDGE"; index: number; patch: Partial<AutomationEdge> }
	| { type: "SET_SELECTION"; keys: string[] }
	| {
			type: "SET_VALIDATION";
			errors: ValidationIssue[];
			warnings: ValidationIssue[];
	  }
	| { type: "UNDO" }
	| { type: "REDO" }
	| { type: "MARK_SAVED" };

function reducer(state: GraphStoreState, action: Action): GraphStoreState {
	switch (action.type) {
		case "SET_GRAPH": {
			if (action.resetHistory !== false) {
				return {
					...state,
					graph: action.graph,
					dirty: false,
					history: { past: [], future: [] },
				};
			}
			return {
				...state,
				graph: action.graph,
				history: pushHistory(state.history, state.graph),
				dirty: true,
			};
		}

		case "ADD_NODE": {
			const removedKeys = new Set(action.removeNodeKeys ?? []);
			const nodes = state.graph.nodes
				.filter((n) => !removedKeys.has(n.key))
				.concat([action.node]);
			const edges = state.graph.edges
				.filter((_, index) => index !== action.replaceEdgeIndex)
				.filter(
					(e) => !removedKeys.has(e.from_node) && !removedKeys.has(e.to_node),
				);
			if (action.edge) edges.push(action.edge);
			if (action.tailEdge) edges.push(action.tailEdge);
			return {
				...state,
				graph: {
					...state.graph,
					nodes,
					edges,
					root_node_key:
						state.graph.root_node_key &&
						removedKeys.has(state.graph.root_node_key)
							? null
							: state.graph.root_node_key,
				},
				history: pushHistory(state.history, state.graph),
				dirty: true,
			};
		}

		case "REMOVE_NODES": {
			const removed = new Set(action.keys);
			const nodes = state.graph.nodes.filter((n) => !removed.has(n.key));
			const edges = state.graph.edges.filter(
				(e) => !removed.has(e.from_node) && !removed.has(e.to_node),
			);
			return {
				...state,
				graph: {
					...state.graph,
					nodes,
					edges,
					root_node_key:
						state.graph.root_node_key &&
						removed.has(state.graph.root_node_key)
							? null
							: state.graph.root_node_key,
				},
				selection: state.selection.filter((k) => !removed.has(k)),
				history: pushHistory(state.history, state.graph),
				dirty: true,
			};
		}

		case "MOVE_NODE": {
			const node = state.graph.nodes.find((n) => n.key === action.key);
			if (!node) return state;
			if (node.canvas_x === action.x && node.canvas_y === action.y) {
				// idempotent — same position, no history bump
				return state;
			}
			const nodes = state.graph.nodes.map((n) =>
				n.key === action.key
					? { ...n, canvas_x: action.x, canvas_y: action.y }
					: n,
			);
			return {
				...state,
				graph: { ...state.graph, nodes },
				history: pushHistory(state.history, state.graph),
				dirty: true,
			};
		}

		case "UPDATE_NODE_CONFIG": {
			const idx = state.graph.nodes.findIndex((n) => n.key === action.key);
			if (idx < 0) return state;
			const nodes = state.graph.nodes.slice();
			nodes[idx] = { ...nodes[idx]!, config: action.config };
			return {
				...state,
				graph: { ...state.graph, nodes },
				history: pushHistory(state.history, state.graph),
				dirty: true,
			};
		}

		case "UPDATE_NODE_TITLE": {
			const idx = state.graph.nodes.findIndex((n) => n.key === action.key);
			if (idx < 0) return state;
			const nodes = state.graph.nodes.slice();
			nodes[idx] = { ...nodes[idx]!, title: action.title };
			return {
				...state,
				graph: { ...state.graph, nodes },
				history: pushHistory(state.history, state.graph),
				dirty: true,
			};
		}

		case "ADD_EDGE": {
			const edges = state.graph.edges.concat([action.edge]);
			return {
				...state,
				graph: { ...state.graph, edges },
				history: pushHistory(state.history, state.graph),
				dirty: true,
			};
		}

		case "REMOVE_EDGE": {
			if (action.index < 0 || action.index >= state.graph.edges.length) {
				return state;
			}
			const edges = state.graph.edges.slice();
			edges.splice(action.index, 1);
			return {
				...state,
				graph: { ...state.graph, edges },
				history: pushHistory(state.history, state.graph),
				dirty: true,
			};
		}

		case "RECONNECT_EDGE": {
			if (action.index < 0 || action.index >= state.graph.edges.length) {
				return state;
			}
			const edges = state.graph.edges.slice();
			edges[action.index] = { ...edges[action.index]!, ...action.patch };
			return {
				...state,
				graph: { ...state.graph, edges },
				history: pushHistory(state.history, state.graph),
				dirty: true,
			};
		}

		case "SET_SELECTION": {
			// Idempotent — content-equal incoming keys return the same state
			// reference, which keeps the `useMemo`-derived store identity
			// stable. Without this, controlled-selection round-trips through
			// React Flow produce a new graphStore identity each frame, which
			// re-runs every effect that takes `graphStore` in its deps and
			// cascades into a freeze when many components subscribe.
			const prev = state.selection;
			const next = action.keys;
			if (prev === next) return state;
			if (prev.length === next.length) {
				let same = true;
				for (let i = 0; i < prev.length; i++) {
					if (prev[i] !== next[i]) {
						same = false;
						break;
					}
				}
				if (same) return state;
			}
			return { ...state, selection: next };
		}

		case "SET_VALIDATION":
			// Idempotent — if the incoming issues are content-equal to the
			// stored ones, return the SAME state reference. The canvas's
			// validation effect fires `validateGraph(graph) → setValidation`
			// on every render that picks up a new `graphStore` reference;
			// without this guard, each call produces a new state (and thus a
			// new `graphStore` via `useMemo`), which triggers the effect
			// again and pins React's render loop — surfacing as React error
			// #185 ("Maximum update depth exceeded").
			if (
				validationIssuesEqual(state.validationErrors, action.errors) &&
				validationIssuesEqual(state.validationWarnings, action.warnings)
			) {
				return state;
			}
			return {
				...state,
				validationErrors: action.errors,
				validationWarnings: action.warnings,
			};

		case "UNDO": {
			const { past, future } = state.history;
			if (past.length === 0) return state;
			const previous = past[past.length - 1]!;
			return {
				...state,
				graph: previous,
				history: {
					past: past.slice(0, -1),
					future: future.concat([cloneGraph(state.graph)]),
				},
				dirty: true,
			};
		}

		case "REDO": {
			const { past, future } = state.history;
			if (future.length === 0) return state;
			const next = future[future.length - 1]!;
			return {
				...state,
				graph: next,
				history: {
					past: past.concat([cloneGraph(state.graph)]),
					future: future.slice(0, -1),
				},
				dirty: true,
			};
		}

		case "MARK_SAVED":
			return { ...state, dirty: false };
	}
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

function initialState(initialGraph?: AutomationGraph): GraphStoreState {
	return {
		graph: initialGraph ?? EMPTY_GRAPH,
		selection: [],
		dirty: false,
		validationErrors: [],
		validationWarnings: [],
		history: { past: [], future: [] },
	};
}

function singleOutputPortKey(node: Pick<AutomationNode, "kind" | "config">): string | null {
	const outputs = derivePorts(node).filter((p) => p.direction === "output");
	return outputs.length === 1 ? outputs[0]?.key ?? null : null;
}

function planAddNode(
	graph: AutomationGraph,
	kind: string,
	key: string,
	position: { x: number; y: number },
	connect?: { sourceNodeKey: string; sourcePortKey: string },
): Extract<Action, { type: "ADD_NODE" }> {
	const node: AutomationNode = {
		key,
		kind,
		canvas_x: position.x,
		canvas_y: position.y,
		config: {},
		ports: [],
	};

	if (!connect) {
		return { type: "ADD_NODE", node };
	}

	const edge: AutomationEdge = {
		from_node: connect.sourceNodeKey,
		from_port: connect.sourcePortKey,
		to_node: key,
		to_port: "in",
	};

	const replaceEdgeIndex = graph.edges.findIndex(
		(e) =>
			e.from_node === connect.sourceNodeKey &&
			e.from_port === connect.sourcePortKey,
	);
	if (replaceEdgeIndex < 0) {
		return { type: "ADD_NODE", node, edge };
	}

	const existingEdge = graph.edges[replaceEdgeIndex]!;
	const downstreamPortKey = singleOutputPortKey(node);
	if (downstreamPortKey) {
		return {
			type: "ADD_NODE",
			node,
			edge,
			tailEdge: {
				from_node: key,
				from_port: downstreamPortKey,
				to_node: existingEdge.to_node,
				to_port: existingEdge.to_port,
			},
			replaceEdgeIndex,
		};
	}

	const existingTarget = graph.nodes.find((n) => n.key === existingEdge.to_node);
	const removeNodeKeys =
		existingTarget?.kind === "end" &&
		!graph.edges.some(
			(e, index) => index !== replaceEdgeIndex && e.to_node === existingTarget.key,
		)
			? [existingTarget.key]
			: undefined;

	return {
		type: "ADD_NODE",
		node,
		edge,
		replaceEdgeIndex,
		removeNodeKeys,
	};
}

export function useGraphStore(initialGraph?: AutomationGraph): UseGraphStore {
	const [state, dispatch] = useReducer(
		reducer,
		initialGraph,
		initialState,
	);

	// Stable refs to the latest dispatch — used inside actions that need to
	// read the current state (e.g. `addNode` returning the generated key).
	const stateRef = useRef(state);
	stateRef.current = state;

	const setGraph = useCallback((g: AutomationGraph) => {
		dispatch({ type: "SET_GRAPH", graph: g });
	}, []);

	const addNode = useCallback<GraphStoreActions["addNode"]>(
		(kind, position, connect) => {
			const key = generateNodeKey();
			dispatch(
				planAddNode(stateRef.current.graph, kind, key, position, connect),
			);
			return key;
		},
		[],
	);

	const removeNodes = useCallback((keys: string[]) => {
		if (keys.length === 0) return;
		dispatch({ type: "REMOVE_NODES", keys });
	}, []);

	const moveNode = useCallback<GraphStoreActions["moveNode"]>(
		(key, position) => {
			dispatch({
				type: "MOVE_NODE",
				key,
				x: position.x,
				y: position.y,
			});
		},
		[],
	);

	const updateNodeConfig = useCallback<
		GraphStoreActions["updateNodeConfig"]
	>((key, config) => {
		dispatch({ type: "UPDATE_NODE_CONFIG", key, config });
	}, []);

	const updateNodeTitle = useCallback<
		GraphStoreActions["updateNodeTitle"]
	>((key, title) => {
		dispatch({ type: "UPDATE_NODE_TITLE", key, title });
	}, []);

	const addEdge = useCallback<GraphStoreActions["addEdge"]>(
		(fromNode, fromPort, toNode, toPort) => {
			dispatch({
				type: "ADD_EDGE",
				edge: {
					from_node: fromNode,
					from_port: fromPort,
					to_node: toNode,
					to_port: toPort,
				},
			});
		},
		[],
	);

	const removeEdge = useCallback((index: number) => {
		dispatch({ type: "REMOVE_EDGE", index });
	}, []);

	const reconnectEdge = useCallback<
		GraphStoreActions["reconnectEdge"]
	>((index, patch) => {
		dispatch({ type: "RECONNECT_EDGE", index, patch });
	}, []);

	const setSelection = useCallback((keys: string[]) => {
		dispatch({ type: "SET_SELECTION", keys });
	}, []);

	const setValidation = useCallback<GraphStoreActions["setValidation"]>(
		(errors, warnings) => {
			dispatch({ type: "SET_VALIDATION", errors, warnings });
		},
		[],
	);

	const undo = useCallback(() => dispatch({ type: "UNDO" }), []);
	const redo = useCallback(() => dispatch({ type: "REDO" }), []);
	const markSaved = useCallback(() => dispatch({ type: "MARK_SAVED" }), []);

	return useMemo<UseGraphStore>(
		() => ({
			...state,
			setGraph,
			addNode,
			removeNodes,
			moveNode,
			updateNodeConfig,
			updateNodeTitle,
			addEdge,
			removeEdge,
			reconnectEdge,
			setSelection,
			setValidation,
			undo,
			redo,
			markSaved,
		}),
		[
			state,
			setGraph,
			addNode,
			removeNodes,
			moveNode,
			updateNodeConfig,
			updateNodeTitle,
			addEdge,
			removeEdge,
			reconnectEdge,
			setSelection,
			setValidation,
			undo,
			redo,
			markSaved,
		],
	);
}

// ---------------------------------------------------------------------------
// Pure helpers exposed for unit tests (avoid having to mount a React tree).
// ---------------------------------------------------------------------------

export const __test__ = {
	reducer,
	initialState,
	HISTORY_LIMIT,
	cloneGraph,
	planAddNode,
	singleOutputPortKey,
};
