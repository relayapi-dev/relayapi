// apps/api/src/services/automations/nodes/condition.ts
//
// Boolean branch. Evaluates a FilterGroup-shaped predicate tree against the
// current run context and routes through either the `true` or `false` port.
// Reuses the preserved filter-eval module.
import { evaluateFilterGroup } from "../filter-eval";
import type { NodeHandler } from "../types";

type ConditionConfig = {
	predicates?: any;
};

export const conditionHandler: NodeHandler<ConditionConfig> = {
	kind: "condition",
	async handle(node, ctx) {
		const group = node.config?.predicates ?? {};
		const matched = evaluateFilterGroup(group, {
			contact: ctx.context.contact ?? null,
			state: ctx.context,
			tags: ctx.context.tags ?? [],
			fields: ctx.context.fields ?? {},
		});
		return { result: "advance", via_port: matched ? "true" : "false" };
	},
};
