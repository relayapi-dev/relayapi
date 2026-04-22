// apps/api/src/services/automations/actions/segment.ts
//
// segment_add / segment_remove — INSERT / DELETE into
// `contact_segment_memberships` (composite PK: contact_id + segment_id).

import { contactSegmentMemberships } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { Action } from "../../../schemas/automation-actions";
import type { ActionHandler, ActionRegistry } from "./types";

type SegmentAddAction = Extract<Action, { type: "segment_add" }>;
type SegmentRemoveAction = Extract<Action, { type: "segment_remove" }>;

const segmentAdd: ActionHandler<SegmentAddAction> = async (action, ctx) => {
	const db = ctx.db;
	if (!db) throw new Error("segment_add: db binding missing");
	await db
		.insert(contactSegmentMemberships)
		.values({
			contactId: ctx.contactId,
			segmentId: action.segment_id,
			organizationId: ctx.organizationId,
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
	await db
		.delete(contactSegmentMemberships)
		.where(
			and(
				eq(contactSegmentMemberships.contactId, ctx.contactId),
				eq(contactSegmentMemberships.segmentId, action.segment_id),
			),
		);
};

export const segmentHandlers: ActionRegistry = {
	segment_add: segmentAdd,
	segment_remove: segmentRemove,
};
