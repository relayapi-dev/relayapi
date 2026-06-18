// apps/api/src/services/automations/ports.ts
import type { GraphNode, Port } from "../../schemas/automation-graph";

// Loose shapes for node config parsed from JSON. Fields are optional because
// the config is untrusted at this layer; all access is guarded at runtime.
interface ConfigButton {
	type?: string;
	id?: string;
	label?: string;
}
interface ConfigBlock {
	type?: string;
	buttons?: ConfigButton[];
	cards?: ConfigCard[];
}
interface ConfigCard {
	buttons?: ConfigButton[];
}
interface ConfigQuickReply {
	id?: string;
	label?: string;
}
interface ConfigVariant {
	key?: string;
	label?: string;
}
interface ConfigAction {
	on_error?: string;
}

/**
 * Derives the canonical port array for a node from its kind + config.
 * Pure function. Always returns a fresh array.
 */
export function derivePorts(node: Pick<GraphNode, "kind" | "config">): Port[] {
  const cfg = node.config ?? {};
  switch (node.kind) {
    case "message": {
      const ports: Port[] = [{ key: "in", direction: "input" }];
      ports.push({ key: "next", direction: "output", role: "default" });
      // branch buttons (across all text/card blocks) + quick replies
      const blocks: ConfigBlock[] = Array.isArray(cfg.blocks) ? cfg.blocks : [];
      for (const b of blocks) {
        if (Array.isArray(b?.buttons)) {
          for (const btn of b.buttons) {
            if (btn?.type === "branch" && typeof btn.id === "string") {
              ports.push({
                key: `button.${btn.id}`,
                direction: "output",
                role: "interactive",
                label: btn.label,
              });
            }
          }
        }
        if (b?.type === "card" && Array.isArray(b?.buttons)) {
          for (const btn of b.buttons) {
            if (btn?.type === "branch" && typeof btn.id === "string") {
              ports.push({
                key: `button.${btn.id}`,
                direction: "output",
                role: "interactive",
                label: btn.label,
              });
            }
          }
        }
        if (b?.type === "gallery" && Array.isArray(b?.cards)) {
          for (const card of b.cards) {
            if (Array.isArray(card?.buttons)) {
              for (const btn of card.buttons) {
                if (btn?.type === "branch" && typeof btn.id === "string") {
                  ports.push({
                    key: `button.${btn.id}`,
                    direction: "output",
                    role: "interactive",
                    label: btn.label,
                  });
                }
              }
            }
          }
        }
      }
      const qrs: ConfigQuickReply[] = Array.isArray(cfg.quick_replies)
        ? cfg.quick_replies
        : [];
      for (const qr of qrs) {
        if (typeof qr?.id === "string") {
          ports.push({
            key: `quick_reply.${qr.id}`,
            direction: "output",
            role: "interactive",
            label: qr.label,
          });
        }
      }
      if (cfg.wait_for_reply && cfg.no_response_timeout_min) {
        ports.push({ key: "no_response", direction: "output", role: "timeout" });
      }
      return ports;
    }
    case "input":
      return [
        { key: "in", direction: "input" },
        { key: "captured", direction: "output", role: "success" },
        { key: "invalid", direction: "output", role: "invalid" },
        { key: "timeout", direction: "output", role: "timeout" },
        { key: "skip", direction: "output", role: "skip" },
      ];
    case "delay":
      return [
        { key: "in", direction: "input" },
        { key: "next", direction: "output", role: "default" },
      ];
    case "condition":
      return [
        { key: "in", direction: "input" },
        { key: "true", direction: "output", role: "branch", label: "True" },
        { key: "false", direction: "output", role: "branch", label: "False" },
      ];
    case "randomizer": {
      const ports: Port[] = [{ key: "in", direction: "input" }];
      const variants: ConfigVariant[] = Array.isArray(cfg.variants)
        ? cfg.variants
        : [];
      for (const v of variants) {
        if (typeof v?.key === "string") {
          ports.push({
            key: `variant.${v.key}`,
            direction: "output",
            role: "branch",
            label: v.label ?? v.key,
          });
        }
      }
      return ports;
    }
    case "action_group": {
      const ports: Port[] = [
        { key: "in", direction: "input" },
        { key: "next", direction: "output", role: "default" },
      ];
      const actions: ConfigAction[] = Array.isArray(cfg.actions)
        ? cfg.actions
        : [];
      if (actions.some((a) => a?.on_error === "abort" || a?.on_error === undefined)) {
        ports.push({ key: "error", direction: "output", role: "error" });
      }
      return ports;
    }
    case "http_request":
      return [
        { key: "in", direction: "input" },
        { key: "success", direction: "output", role: "success" },
        { key: "error", direction: "output", role: "error" },
      ];
    case "start_automation":
      return [
        { key: "in", direction: "input" },
        { key: "next", direction: "output", role: "default" },
      ];
    case "goto":
      return [{ key: "in", direction: "input" }];
    case "end":
      return [{ key: "in", direction: "input" }];
    default:
      return [{ key: "in", direction: "input" }];
  }
}

/** Replaces a node's ports array in place. */
export function applyDerivedPorts<T extends GraphNode>(node: T): T {
  return { ...node, ports: derivePorts(node) };
}
