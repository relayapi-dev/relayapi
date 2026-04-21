// apps/api/src/__tests__/automation-graph-schema.test.ts
import { describe, expect, test } from "bun:test";
import { GraphSchema, MessageBlockSchema } from "../schemas/automation-graph";

describe("GraphSchema", () => {
  test("accepts a minimal valid graph", () => {
    const g = {
      schema_version: 1,
      root_node_key: "n1",
      nodes: [{ key: "n1", kind: "end", config: {}, ports: [] }],
      edges: [],
    };
    expect(() => GraphSchema.parse(g)).not.toThrow();
  });

  test("rejects schema_version != 1", () => {
    expect(() => GraphSchema.parse({ schema_version: 2, root_node_key: null, nodes: [], edges: [] }))
      .toThrow();
  });

  test("accepts multiple edges", () => {
    const g = {
      schema_version: 1,
      root_node_key: "a",
      nodes: [
        { key: "a", kind: "message", config: {}, ports: [] },
        { key: "b", kind: "end", config: {}, ports: [] },
      ],
      edges: [{ from_node: "a", from_port: "next", to_node: "b", to_port: "in" }],
    };
    expect(() => GraphSchema.parse(g)).not.toThrow();
  });
});

describe("MessageBlockSchema", () => {
  test("accepts a text block with buttons", () => {
    const b = {
      id: "blk_1",
      type: "text",
      text: "Hi",
      buttons: [{ id: "btn_a", type: "branch", label: "A" }],
    };
    expect(() => MessageBlockSchema.parse(b)).not.toThrow();
  });

  test("rejects >3 buttons", () => {
    const b = {
      id: "blk_1",
      type: "text",
      text: "Hi",
      buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, type: "branch", label: `L${i}` })),
    };
    expect(() => MessageBlockSchema.parse(b)).toThrow();
  });

  test("rejects gallery with >10 cards", () => {
    const b = {
      id: "gal",
      type: "gallery",
      cards: Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, type: "card", title: "t" })),
    };
    expect(() => MessageBlockSchema.parse(b)).toThrow();
  });
});
