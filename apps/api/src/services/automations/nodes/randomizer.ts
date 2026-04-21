// apps/api/src/services/automations/nodes/randomizer.ts
//
// Weighted-random branch with sticky-per-run decisions. A run that revisits
// the same randomizer (e.g. after a goto cycle or a retry) gets the same
// variant so behavior is deterministic within a single enrollment.
import type { HandlerResult, NodeHandler } from "../types";

type Variant = { key: string; weight: number };
type RandomizerConfig = { variants: Variant[] };

export const randomizerHandler: NodeHandler<RandomizerConfig> = {
	kind: "randomizer",
	async handle(node, ctx): Promise<HandlerResult> {
		const sticky = ctx.context._randomizer?.[node.key];
		if (typeof sticky === "string") {
			return { result: "advance", via_port: `variant.${sticky}` };
		}
		const variants: Variant[] = Array.isArray(node.config?.variants)
			? node.config.variants
			: [];
		if (variants.length === 0) {
			return {
				result: "fail",
				error: new Error("randomizer has no variants"),
			};
		}
		const totalWeight = variants.reduce((s, v) => s + (v.weight ?? 1), 0);
		let roll = Math.random() * totalWeight;
		let chosen: Variant = variants[0]!;
		for (const v of variants) {
			roll -= v.weight ?? 1;
			if (roll <= 0) {
				chosen = v;
				break;
			}
		}
		// Write sticky decision into context so subsequent visits are deterministic.
		ctx.context._randomizer = {
			...(ctx.context._randomizer ?? {}),
			[node.key]: chosen.key,
		};
		return {
			result: "advance",
			via_port: `variant.${chosen.key}`,
			payload: { variant_key: chosen.key },
		};
	},
};
