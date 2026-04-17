import { contacts } from "@relayapi/db";
import { eq, sql } from "drizzle-orm";
import type { NodeHandler } from "../types";

export const tagAddHandler: NodeHandler = async (ctx) => {
	const tag = ctx.node.config.tag as string | undefined;
	if (!tag) return { kind: "fail", error: "tag_add missing 'tag'" };
	if (!ctx.enrollment.contact_id)
		return { kind: "fail", error: "no contact" };

	await ctx.db
		.update(contacts)
		.set({
			tags: sql`array(select distinct unnest(coalesce(${contacts.tags}, '{}'::text[]) || array[${tag}]::text[]))`,
			updatedAt: new Date(),
		})
		.where(eq(contacts.id, ctx.enrollment.contact_id));

	return { kind: "next" };
};

export const tagRemoveHandler: NodeHandler = async (ctx) => {
	const tag = ctx.node.config.tag as string | undefined;
	if (!tag) return { kind: "fail", error: "tag_remove missing 'tag'" };
	if (!ctx.enrollment.contact_id)
		return { kind: "fail", error: "no contact" };

	await ctx.db
		.update(contacts)
		.set({
			tags: sql`array_remove(coalesce(${contacts.tags}, '{}'::text[]), ${tag})`,
			updatedAt: new Date(),
		})
		.where(eq(contacts.id, ctx.enrollment.contact_id));

	return { kind: "next" };
};
