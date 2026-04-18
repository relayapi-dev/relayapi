import type { NodeHandler } from "../types";

interface Variant {
	label: string;
	weight: number;
}

export const splitTestHandler: NodeHandler = async (ctx) => {
	const variants = ctx.node.config.variants as Variant[] | undefined;
	if (!variants || variants.length < 2) {
		return { kind: "fail", error: "split_test requires at least two variants" };
	}

	const totalWeight = variants.reduce((sum, variant) => sum + (variant.weight ?? 1), 0);
	let roll = Math.random() * totalWeight;
	for (const variant of variants) {
		roll -= variant.weight ?? 1;
		if (roll <= 0) {
			return {
				kind: "next",
				label: variant.label,
				state_patch: { split_test_variant: variant.label },
			};
		}
	}

	const fallback = variants[variants.length - 1]!;
	return {
		kind: "next",
		label: fallback.label,
		state_patch: { split_test_variant: fallback.label },
	};
};
