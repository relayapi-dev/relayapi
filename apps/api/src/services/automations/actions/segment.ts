// apps/api/src/services/automations/actions/segment.ts
//
// segment_add / segment_remove — INSERT / DELETE into
// `contact_segment_memberships` (composite PK: contact_id + segment_id).

import { contactSegmentMemberships, segments } from "@relayapi/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Action } from "../../../schemas/automation-actions";
import type { ActionHandler, ActionRegistry } from "./types";

type SegmentAddAction = Extract<Action, { type: "segment_add" }>;
type SegmentRemoveAction = Extract<Action, { type: "segment_remove" }>;

async function assertSegmentScope(
	action: SegmentAddAction | SegmentRemoveAction,
	ctx: Parameters<ActionHandler>[1],
) {
	const segment = await ctx.db.query.segments.findFirst({
		where: and(
			eq(segments.id, action.segment_id),
			eq(segments.organizationId, ctx.organizationId),
			ctx.workspaceId
				? eq(segments.workspaceId, ctx.workspaceId)
				: isNull(segments.workspaceId),
		),
	});
	if (!segment) throw new Error("segment does not belong to automation tenant");
}

const segmentAdd: ActionHandler<SegmentAddAction> = async (action, ctx) => {
	const db = ctx.db;
	if (!db) throw new Error("segment_add: db binding missing");
	await assertSegmentScope(action, ctx);
	await db
		.insert(contactSegmentMemberships)
		.values({
			contactId: ctx.contactId,
			segmentId: action.segment_id,
			organizationId: ctx.organizationId,
			scopeKey: ctx.workspaceId ? `ws/${ctx.workspaceId}` : "org",
			source: "automation",
		})
		.onConflictDoNothing();
};

const segmentRemove: ActionHandler<SegmentRemoveAction> = async (
	action,
	ctx,
) => {
	const db = ctx.db;
	if (!db) throw new Error("segment_remove: db binding missing");
	await assertSegmentScope(action, ctx);
	await db
		.delete(contactSegmentMemberships)
		.where(
			and(
				eq(contactSegmentMemberships.contactId, ctx.contactId),
				eq(contactSegmentMemberships.segmentId, action.segment_id),
				eq(contactSegmentMemberships.organizationId, ctx.organizationId),
			),
		);
};

export const segmentHandlers: ActionRegistry = {
	segment_add: segmentAdd,
	segment_remove: segmentRemove,
};
