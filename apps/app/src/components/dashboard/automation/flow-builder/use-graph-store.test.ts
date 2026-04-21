import { describe, expect, it } from "bun:test";
import {
	EMPTY_GRAPH,
	__test__,
	generateNodeKey,
} from "./use-graph-store";
import type { AutomationGraph, AutomationNode } from "./graph-types";

const { reducer, initialState, HISTORY_LIMIT, cloneGraph } = __test__;

function makeNode(key: string, x = 0, y = 0): AutomationNode {
	return {
		key,
		kind: "message_text",
		canvas_x: x,
		canvas_y: y,
		config: {},
		ports: [],
	};
}

function graphWith(nodes: AutomationNode[], edges: AutomationGraph["edges"] = []): AutomationGraph {
	return {
		schema_version: 1,
		root_node_key: nodes[0]?.key ?? null,
		nodes,
		edges,
	};
}

describe("useGraphStore reducer — addNode", () => {
	it("adds a node to the graph and pushes prior state onto history", () => {
		const initial = initialState(EMPTY_GRAPH);
		const node = makeNode("n1");

		const next = reducer(initial, { type: "ADD_NODE", node });

		expect(next.graph.nodes).toHaveLength(1);
		expect(next.graph.nodes[0]).toEqual(node);
		expect(next.dirty).toBe(true);
		expect(next.history.past).toHaveLength(1);
		expect(next.history.past[0]?.nodes).toHaveLength(0);
		expect(next.history.future).toHaveLength(0);
	});

	it("supports atomic add-node-with-edge in a single dispatch", () => {
		const startNode = makeNode("source");
		const initial = initialState(graphWith([startNode]));
		const newNode = makeNode("n2");

		const next = reducer(initial, {
			type: "ADD_NODE",
			node: newNode,
			edge: {
				from_node: "source",
				from_port: "next",
				to_node: "n2",
				to_port: "in",
			},
		});

		expect(next.graph.nodes.map((n) => n.key)).toEqual(["source", "n2"]);
		expect(next.graph.edges).toHaveLength(1);
		expect(next.graph.edges[0]).toMatchObject({
			from_node: "source",
			to_node: "n2",
		});
		// Single history entry — both mutations land atomically.
		expect(next.history.past).toHaveLength(1);
	});
});

describe("useGraphStore reducer — removeNodes", () => {
	it("removes the nodes and any edges that reference them", () => {
		const initial = initialState(
			graphWith(
				[makeNode("a"), makeNode("b"), makeNode("c")],
				[
					{ from_node: "a", from_port: "next", to_node: "b", to_port: "in" },
					{ from_node: "b", from_port: "next", to_node: "c", to_port: "in" },
				],
			),
		);

		const next = reducer(initial, { type: "REMOVE_NODES", keys: ["b"] });

		expect(next.graph.nodes.map((n) => n.key)).toEqual(["a", "c"]);
		expect(next.graph.edges).toHaveLength(0);
	});

	it("clears root_node_key if the root was removed", () => {
		const initial = initialState(graphWith([makeNode("a"), makeNode("b")]));
		const next = reducer(initial, { type: "REMOVE_NODES", keys: ["a"] });
		expect(next.graph.root_node_key).toBeNull();
	});

	it("strips removed keys from selection", () => {
		const initial = {
			...initialState(graphWith([makeNode("a"), makeNode("b")])),
			selection: ["a", "b"],
		};
		const next = reducer(initial, { type: "REMOVE_NODES", keys: ["a"] });
		expect(next.selection).toEqual(["b"]);
	});
});

describe("useGraphStore reducer — moveNode", () => {
	it("updates the position when changed", () => {
		const initial = initialState(graphWith([makeNode("a", 10, 20)]));
		const next = reducer(initial, {
			type: "MOVE_NODE",
			key: "a",
			x: 50,
			y: 60,
		});
		expect(next.graph.nodes[0]).toMatchObject({ canvas_x: 50, canvas_y: 60 });
		expect(next.history.past).toHaveLength(1);
	});

	it("is idempotent when the position is unchanged (no history bump)", () => {
		const initial = initialState(graphWith([makeNode("a", 10, 20)]));
		const next = reducer(initial, {
			type: "MOVE_NODE",
			key: "a",
			x: 10,
			y: 20,
		});
		expect(next).toBe(initial);
	});

	it("ignores unknown node keys", () => {
		const initial = initialState(graphWith([makeNode("a")]));
		const next = reducer(initial, {
			type: "MOVE_NODE",
			key: "missing",
			x: 1,
			y: 1,
		});
		expect(next).toBe(initial);
	});
});

describe("useGraphStore reducer — undo / redo", () => {
	it("round-trips through a sequence of mutations", () => {
		const start = initialState(EMPTY_GRAPH);
		const after1 = reducer(start, { type: "ADD_NODE", node: makeNode("a") });
		const after2 = reducer(after1, { type: "ADD_NODE", node: makeNode("b") });

		// Undo once → back to one node.
		const undo1 = reducer(after2, { type: "UNDO" });
		expect(undo1.graph.nodes.map((n) => n.key)).toEqual(["a"]);
		expect(undo1.history.future).toHaveLength(1);

		// Undo again → empty graph.
		const undo2 = reducer(undo1, { type: "UNDO" });
		expect(undo2.graph.nodes).toHaveLength(0);
		expect(undo2.history.future).toHaveLength(2);

		// Redo back to two nodes.
		const redo1 = reducer(undo2, { type: "REDO" });
		const redo2 = reducer(redo1, { type: "REDO" });
		expect(redo2.graph.nodes.map((n) => n.key)).toEqual(["a", "b"]);
		expect(redo2.history.future).toHaveLength(0);
	});

	it("clears the future stack on a new mutation", () => {
		const start = initialState(EMPTY_GRAPH);
		const after1 = reducer(start, { type: "ADD_NODE", node: makeNode("a") });
		const after2 = reducer(after1, { type: "ADD_NODE", node: makeNode("b") });
		const undone = reducer(after2, { type: "UNDO" });
		expect(undone.history.future).toHaveLength(1);

		const branched = reducer(undone, {
			type: "ADD_NODE",
			node: makeNode("c"),
		});
		expect(branched.history.future).toHaveLength(0);
		expect(branched.graph.nodes.map((n) => n.key)).toEqual(["a", "c"]);
	});

	it("undo on empty history is a no-op", () => {
		const start = initialState(EMPTY_GRAPH);
		const next = reducer(start, { type: "UNDO" });
		expect(next).toBe(start);
	});

	it("caps the past stack at HISTORY_LIMIT entries", () => {
		let state = initialState(EMPTY_GRAPH);
		for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
			state = reducer(state, {
				type: "ADD_NODE",
				node: makeNode(`n${i}`),
			});
		}
		expect(state.history.past.length).toBe(HISTORY_LIMIT);
	});
});

describe("useGraphStore reducer — markSaved + setGraph", () => {
	it("markSaved clears the dirty flag without touching history", () => {
		const initial = initialState(EMPTY_GRAPH);
		const after = reducer(initial, { type: "ADD_NODE", node: makeNode("a") });
		expect(after.dirty).toBe(true);
		const saved = reducer(after, { type: "MARK_SAVED" });
		expect(saved.dirty).toBe(false);
		// History preserved so the user can still undo past the save mark.
		expect(saved.history.past).toEqual(after.history.past);
	});

	it("setGraph resets history by default", () => {
		const initial = initialState(graphWith([makeNode("a")]));
		const after = reducer(initial, {
			type: "ADD_NODE",
			node: makeNode("b"),
		});
		expect(after.history.past).toHaveLength(1);
		const reset = reducer(after, {
			type: "SET_GRAPH",
			graph: graphWith([makeNode("z")]),
		});
		expect(reset.history.past).toHaveLength(0);
		expect(reset.dirty).toBe(false);
	});
});

describe("useGraphStore reducer — edges", () => {
	it("addEdge appends and removeEdge by index drops", () => {
		const initial = initialState(graphWith([makeNode("a"), makeNode("b")]));
		const added = reducer(initial, {
			type: "ADD_EDGE",
			edge: {
				from_node: "a",
				from_port: "next",
				to_node: "b",
				to_port: "in",
			},
		});
		expect(added.graph.edges).toHaveLength(1);

		const removed = reducer(added, { type: "REMOVE_EDGE", index: 0 });
		expect(removed.graph.edges).toHaveLength(0);
	});

	it("reconnectEdge merges patches", () => {
		const initial = initialState(
			graphWith(
				[makeNode("a"), makeNode("b"), makeNode("c")],
				[{ from_node: "a", from_port: "next", to_node: "b", to_port: "in" }],
			),
		);
		const next = reducer(initial, {
			type: "RECONNECT_EDGE",
			index: 0,
			patch: { to_node: "c" },
		});
		expect(next.graph.edges[0]).toMatchObject({
			from_node: "a",
			to_node: "c",
		});
	});
});

describe("generateNodeKey", () => {
	it("returns short opaque keys", () => {
		const key = generateNodeKey();
		expect(key).toHaveLength(8);
		expect(key).toMatch(/^[0-9A-Za-z]+$/);
	});

	it("returns distinct keys across calls", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 50; i++) seen.add(generateNodeKey());
		expect(seen.size).toBe(50);
	});
});

describe("cloneGraph", () => {
	it("produces a deep copy", () => {
		const g = graphWith([makeNode("a")], []);
		g.nodes[0]!.config = { foo: { bar: 1 } };
		const copy = cloneGraph(g);
		(copy.nodes[0]!.config as { foo: { bar: number } }).foo.bar = 42;
		expect((g.nodes[0]!.config as { foo: { bar: number } }).foo.bar).toBe(1);
	});
});
