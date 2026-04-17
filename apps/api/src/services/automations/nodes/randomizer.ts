import type { NodeHandler } from "../types";

interface Branch {
	label: string;
	weight: number;
}

export const randomizerHandler: NodeHandler = async (ctx) => {
	const branches = ctx.node.config.branches as Branch[] | undefined;
	if (!branches || branches.length === 0) {
		return { kind: "fail", error: "randomizer missing branches" };
	}
	const total = branches.reduce((sum, b) => sum + (b.weight ?? 1), 0);
	let roll = Math.random() * total;
	for (const b of branches) {
		roll -= b.weight ?? 1;
		if (roll <= 0) return { kind: "next", label: b.label };
	}
	return { kind: "next", label: branches[branches.length - 1]!.label };
};
