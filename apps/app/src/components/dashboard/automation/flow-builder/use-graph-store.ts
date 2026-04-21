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
//   new node and its inbound edge land in the same dispatch, so undo reverts
//   both at once.
// - Node keys are short opaque ids (8 chars). We try to use the SDK's
//   nanoid-style generator if available; otherwise fall back to a sliced
//   `crypto.randomUUID()`.

import { useCallback, useMemo, useReducer, useRef } from "react";
import type {
	AutomationEdge,
	AutomationGraph,
	AutomationNode,
} from "./graph-types";
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

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

type Action =
	| { type: "SET_GRAPH"; graph: AutomationGraph; resetHistory?: boolean }
	| {
			type: "ADD_NODE";
			node: AutomationNode;
			edge?: AutomationEdge;
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
			const nodes = state.graph.nodes.concat([action.node]);
			const edges = action.edge
				? state.graph.edges.concat([action.edge])
				: state.graph.edges;
			return {
				...state,
				graph: { ...state.graph, nodes, edges },
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

		case "SET_SELECTION":
			return { ...state, selection: action.keys };

		case "SET_VALIDATION":
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
			const node: AutomationNode = {
				key,
				kind,
				canvas_x: position.x,
				canvas_y: position.y,
				config: {},
				ports: [],
			};
			let edge: AutomationEdge | undefined;
			if (connect) {
				edge = {
					from_node: connect.sourceNodeKey,
					from_port: connect.sourcePortKey,
					to_node: key,
					to_port: "in",
				};
			}
			dispatch({ type: "ADD_NODE", node, edge });
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
};
