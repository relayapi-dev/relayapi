// apps/api/src/__tests__/automation-validator.test.ts
import { describe, expect, test } from "bun:test";
import { validateGraph } from "../services/automations/validator";

const mkGraph = (overrides: Partial<any> = {}) => ({
  schema_version: 1 as const,
  root_node_key: "a",
  nodes: [
    { key: "a", kind: "message", config: { blocks: [] }, ports: [] },
    { key: "b", kind: "end", config: {}, ports: [] },
  ],
  edges: [{ from_node: "a", from_port: "next", to_node: "b", to_port: "in" }],
  ...overrides,
});

describe("validateGraph", () => {
  test("valid simple graph passes", () => {
    const r = validateGraph(mkGraph());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("missing root errors", () => {
    const r = validateGraph(mkGraph({ root_node_key: "missing" }));
    expect(r.errors.some((e) => e.code === "missing_root")).toBe(true);
  });

  test("input as root is invalid", () => {
    const r = validateGraph({
      schema_version: 1,
      root_node_key: "a",
      nodes: [{ key: "a", kind: "input", config: {}, ports: [] }],
      edges: [],
    });
    expect(r.errors.some((e) => e.code === "invalid_root_kind")).toBe(true);
  });

  test("orphan node is error", () => {
    const r = validateGraph(mkGraph({
      nodes: [
        { key: "a", kind: "message", config: { blocks: [] }, ports: [] },
        { key: "b", kind: "end", config: {}, ports: [] },
        { key: "c", kind: "end", config: {}, ports: [] },
      ],
    }));
    expect(r.errors.some((e) => e.code === "orphan_node" && e.node_key === "c")).toBe(true);
  });

  test("edge to unknown node", () => {
    const r = validateGraph(mkGraph({
      edges: [{ from_node: "a", from_port: "next", to_node: "zzz", to_port: "in" }],
    }));
    expect(r.errors.some((e) => e.code === "edge_missing_to_node")).toBe(true);
  });

  test("edge to non-existent port", () => {
    const r = validateGraph(mkGraph({
      edges: [{ from_node: "a", from_port: "wrong_port", to_node: "b", to_port: "in" }],
    }));
    expect(r.errors.some((e) => e.code === "edge_missing_from_port")).toBe(true);
  });

  test("cycle without pause is error", () => {
    const r = validateGraph({
      schema_version: 1,
      root_node_key: "a",
      nodes: [
        { key: "a", kind: "message", config: { blocks: [] }, ports: [] },
        { key: "b", kind: "message", config: { blocks: [] }, ports: [] },
      ],
      edges: [
        { from_node: "a", from_port: "next", to_node: "b", to_port: "in" },
        { from_node: "b", from_port: "next", to_node: "a", to_port: "in" },
      ],
    });
    expect(r.errors.some((e) => e.code === "cycle_without_pause")).toBe(true);
  });

  test("cycle with delay is OK", () => {
    const r = validateGraph({
      schema_version: 1,
      root_node_key: "a",
      nodes: [
        { key: "a", kind: "message", config: { blocks: [] }, ports: [] },
        { key: "d", kind: "delay", config: { seconds: 60 }, ports: [] },
      ],
      edges: [
        { from_node: "a", from_port: "next", to_node: "d", to_port: "in" },
        { from_node: "d", from_port: "next", to_node: "a", to_port: "in" },
      ],
    });
    const cycleErrors = r.errors.filter((e) => e.code === "cycle_without_pause");
    expect(cycleErrors).toEqual([]);
  });

  test("orphan port produces warning not error", () => {
    const r = validateGraph(mkGraph({
      nodes: [
        { key: "a", kind: "condition", config: {}, ports: [] },
        { key: "b", kind: "end", config: {}, ports: [] },
      ],
      edges: [{ from_node: "a", from_port: "true", to_node: "b", to_port: "in" }],
    }));
    expect(r.warnings.some((w) => w.code === "port_no_outgoing_edge" && w.port_key === "false")).toBe(true);
    // ... but no error about this
  });
});
