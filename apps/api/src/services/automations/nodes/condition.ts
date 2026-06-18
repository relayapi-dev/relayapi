// apps/api/src/services/automations/nodes/condition.ts
//
// Boolean branch. Evaluates a FilterGroup-shaped predicate tree against the
// current run context and routes through either the `true` or `false` port.
// Reuses the preserved filter-eval module.
import { evaluateFilterGroup, type FilterGroup } from "../filter-eval";
import type { NodeHandler } from "../types";

type ConditionConfig = {
	predicates?: FilterGroup;
};

export const conditionHandler: NodeHandler<ConditionConfig> = {
	kind: "condition",
	async handle(node, ctx) {
		const group = node.config?.predicates ?? {};
		const matched = evaluateFilterGroup(group, {
			contact:
				(ctx.context.contact as Record<string, unknown> | null | undefined) ??
				null,
			state: ctx.context,
			tags: (ctx.context.tags as string[] | undefined) ?? [],
			fields: (ctx.context.fields as Record<string, unknown> | undefined) ?? {},
		});
		return { result: "advance", via_port: matched ? "true" : "false" };
	},
};
