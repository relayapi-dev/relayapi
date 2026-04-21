// Client-side mirror of `apps/api/src/services/automations/ports.ts`.
//
// Derives the canonical port array for a node from its `kind` + `config`.
// Pure function. Always returns a fresh array.
//
// Kept in sync with the server implementation so client-side validation,
// handle rendering, and the "phantom" edge previews match what the backend
// will canonicalise on save.

import type { AutomationNode, AutomationPort } from "./graph-types";

type NodeLike = Pick<AutomationNode, "kind" | "config">;

export function derivePorts(node: NodeLike): AutomationPort[] {
	const cfg = (node.config ?? {}) as Record<string, unknown>;

	switch (node.kind) {
		case "message": {
			const ports: AutomationPort[] = [{ key: "in", direction: "input" }];
			ports.push({ key: "next", direction: "output", role: "default" });

			const blocks = Array.isArray(cfg.blocks)
				? (cfg.blocks as Array<Record<string, unknown>>)
				: [];
			for (const b of blocks) {
				if (Array.isArray(b?.buttons)) {
					for (const btn of b.buttons as Array<Record<string, unknown>>) {
						if (btn?.type === "branch" && typeof btn.id === "string") {
							ports.push({
								key: `button.${btn.id}`,
								direction: "output",
								role: "interactive",
								label: typeof btn.label === "string" ? btn.label : undefined,
							});
						}
					}
				}
				if (b?.type === "card" && Array.isArray(b?.buttons)) {
					for (const btn of b.buttons as Array<Record<string, unknown>>) {
						if (btn?.type === "branch" && typeof btn.id === "string") {
							ports.push({
								key: `button.${btn.id}`,
								direction: "output",
								role: "interactive",
								label: typeof btn.label === "string" ? btn.label : undefined,
							});
						}
					}
				}
				if (b?.type === "gallery" && Array.isArray(b?.cards)) {
					for (const card of b.cards as Array<Record<string, unknown>>) {
						if (Array.isArray(card?.buttons)) {
							for (const btn of card.buttons as Array<Record<string, unknown>>) {
								if (btn?.type === "branch" && typeof btn.id === "string") {
									ports.push({
										key: `button.${btn.id}`,
										direction: "output",
										role: "interactive",
										label:
											typeof btn.label === "string" ? btn.label : undefined,
									});
								}
							}
						}
					}
				}
			}

			const qrs = Array.isArray(cfg.quick_replies)
				? (cfg.quick_replies as Array<Record<string, unknown>>)
				: [];
			for (const qr of qrs) {
				if (typeof qr?.id === "string") {
					ports.push({
						key: `quick_reply.${qr.id}`,
						direction: "output",
						role: "interactive",
						label: typeof qr.label === "string" ? qr.label : undefined,
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
			const ports: AutomationPort[] = [{ key: "in", direction: "input" }];
			const variants = Array.isArray(cfg.variants)
				? (cfg.variants as Array<Record<string, unknown>>)
				: [];
			for (const v of variants) {
				if (typeof v?.key === "string") {
					ports.push({
						key: `variant.${v.key}`,
						direction: "output",
						role: "branch",
						label:
							typeof v.label === "string"
								? v.label
								: (v.key as string),
					});
				}
			}
			return ports;
		}

		case "action_group": {
			const ports: AutomationPort[] = [
				{ key: "in", direction: "input" },
				{ key: "next", direction: "output", role: "default" },
			];
			const actions = Array.isArray(cfg.actions)
				? (cfg.actions as Array<Record<string, unknown>>)
				: [];
			if (
				actions.some(
					(a) => a?.on_error === "abort" || a?.on_error === undefined,
				)
			) {
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

/** Returns a node with its `ports` replaced by the derived canonical set. */
export function applyDerivedPorts<T extends AutomationNode>(node: T): T {
	return { ...node, ports: derivePorts(node) };
}
