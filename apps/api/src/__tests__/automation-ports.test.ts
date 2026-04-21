// apps/api/src/__tests__/automation-ports.test.ts
import { describe, expect, test } from "bun:test";
import { derivePorts } from "../services/automations/ports";

describe("derivePorts", () => {
  test("message with buttons and quick replies", () => {
    const ports = derivePorts({
      kind: "message",
      config: {
        blocks: [{
          id: "blk_1",
          type: "text",
          text: "Hi",
          buttons: [
            { id: "btn_a", type: "branch", label: "A" },
            { id: "btn_b", type: "branch", label: "B" },
            { id: "btn_url", type: "url", label: "Go", url: "https://x" }, // should NOT create port
          ],
        }],
        quick_replies: [{ id: "qr1", label: "Y" }],
        wait_for_reply: true,
        no_response_timeout_min: 60,
      },
    });
    const keys = ports.map((p) => p.key).sort();
    expect(keys).toEqual(["button.btn_a", "button.btn_b", "in", "next", "no_response", "quick_reply.qr1"].sort());
  });

  test("message without wait_for_reply has no no_response port", () => {
    const ports = derivePorts({ kind: "message", config: { blocks: [] } });
    expect(ports.map((p) => p.key)).toEqual(["in", "next"]);
  });

  test("condition always has true/false", () => {
    const ports = derivePorts({ kind: "condition", config: {} });
    expect(ports.map((p) => p.key)).toEqual(["in", "true", "false"]);
  });

  test("action_group has error only when any action has on_error=abort", () => {
    const withAbort = derivePorts({
      kind: "action_group",
      config: { actions: [{ id: "a", type: "tag_add", tag: "x", on_error: "abort" }] },
    });
    expect(withAbort.map((p) => p.key)).toEqual(["in", "next", "error"]);

    const allContinue = derivePorts({
      kind: "action_group",
      config: { actions: [{ id: "a", type: "tag_add", tag: "x", on_error: "continue" }] },
    });
    expect(allContinue.map((p) => p.key)).toEqual(["in", "next"]);
  });

  test("randomizer exposes one port per variant", () => {
    const ports = derivePorts({
      kind: "randomizer",
      config: { variants: [{ key: "a", weight: 50 }, { key: "b", weight: 50 }] },
    });
    expect(ports.map((p) => p.key)).toEqual(["in", "variant.a", "variant.b"]);
  });

  test("input has all four output ports", () => {
    const ports = derivePorts({ kind: "input", config: {} });
    expect(ports.map((p) => p.key)).toEqual(["in", "captured", "invalid", "timeout", "skip"]);
  });

  test("http_request has success + error", () => {
    const ports = derivePorts({ kind: "http_request", config: { url: "https://x" } });
    expect(ports.map((p) => p.key)).toEqual(["in", "success", "error"]);
  });

  test("goto and end have no output ports", () => {
    expect(derivePorts({ kind: "goto", config: {} }).filter((p) => p.direction === "output")).toEqual([]);
    expect(derivePorts({ kind: "end", config: {} }).filter((p) => p.direction === "output")).toEqual([]);
  });

  test("unknown kind still has an in port", () => {
    const ports = derivePorts({ kind: "mystery_kind", config: {} });
    expect(ports.map((p) => p.key)).toEqual(["in"]);
  });
});
