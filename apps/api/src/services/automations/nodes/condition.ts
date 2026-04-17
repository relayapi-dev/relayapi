import { contacts, customFieldDefinitions, customFieldValues } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { evaluateFilterGroup } from "../filter-eval";
import type { NodeHandler } from "../types";

export const conditionHandler: NodeHandler = async (ctx) => {
	const group = ctx.node.config.if as {
		all?: Array<{ field: string; op: string; value?: unknown }>;
		any?: Array<{ field: string; op: string; value?: unknown }>;
		none?: Array<{ field: string; op: string; value?: unknown }>;
	};
	if (!group) {
		return { kind: "fail", error: "condition node missing 'if'" };
	}

	let contact: Record<string, unknown> | null = null;
	const fields: Record<string, unknown> = {};
	let tags: string[] = [];

	if (ctx.enrollment.contact_id) {
		const row = await ctx.db.query.contacts.findFirst({
			where: eq(contacts.id, ctx.enrollment.contact_id),
		});
		if (row) {
			contact = row as unknown as Record<string, unknown>;
			tags = row.tags ?? [];
		}

		const fieldRows = await ctx.db
			.select({
				slug: customFieldDefinitions.slug,
				value: customFieldValues.value,
			})
			.from(customFieldValues)
			.leftJoin(
				customFieldDefinitions,
				eq(customFieldValues.definitionId, customFieldDefinitions.id),
			)
			.where(
				and(
					eq(customFieldValues.contactId, ctx.enrollment.contact_id),
					eq(customFieldValues.organizationId, ctx.enrollment.organization_id),
				),
			);
		for (const fr of fieldRows) {
			if (fr.slug) fields[fr.slug] = fr.value;
		}
	}

	const matched = evaluateFilterGroup(group, {
		contact,
		state: ctx.enrollment.state,
		tags,
		fields,
	});

	return { kind: "next", label: matched ? "yes" : "no" };
};
