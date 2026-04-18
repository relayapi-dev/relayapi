import { contacts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { resolveTemplatedValue } from "../resolve-templated-value";
import {
	addContactToStaticSegment,
	ensureOrgContact,
	ensureStaticSegment,
	removeContactFromStaticSegment,
} from "../../segment-memberships";
import type { NodeHandler } from "../types";

type ResolvedSegmentContext =
	| { error: string }
	| { contactId: string; segmentId: string };

async function resolveSegmentContext(
	ctx: Parameters<NodeHandler>[0],
	rawSegmentId: unknown,
): Promise<ResolvedSegmentContext> {
	if (!rawSegmentId) {
		return { error: "segment action missing 'segment_id'" };
	}
	if (!ctx.enrollment.contact_id) {
		return { error: "enrollment has no contact_id" };
	}

	const contactResult = await ensureOrgContact(
		ctx.db,
		ctx.enrollment.organization_id,
		ctx.enrollment.contact_id,
	);
	if ("error" in contactResult) return { error: String(contactResult.error) };
	const { contact } = contactResult;

	const segmentId = String(
		resolveTemplatedValue(rawSegmentId, {
			contact: (contact as Record<string, unknown> | null | undefined) ?? null,
			state: ctx.enrollment.state,
		}) ?? "",
	).trim();
	if (!segmentId) {
		return { error: "segment action resolved an empty segment_id" };
	}

	const segmentResult = await ensureStaticSegment(
		ctx.db,
		ctx.enrollment.organization_id,
		segmentId,
	);
	if ("error" in segmentResult) return { error: String(segmentResult.error) };

	return { contactId: contact.id, segmentId };
}

export const segmentAddHandler: NodeHandler = async (ctx) => {
	const resolved: ResolvedSegmentContext = await resolveSegmentContext(
		ctx,
		ctx.node.config.segment_id,
	);
	if ("error" in resolved) return { kind: "fail", error: resolved.error };

	await addContactToStaticSegment(ctx.db, {
		organizationId: ctx.enrollment.organization_id,
		contactId: resolved.contactId,
		segmentId: resolved.segmentId,
		source: "automation",
	});

	return {
		kind: "next",
		state_patch: {
			last_segment_id: resolved.segmentId,
			last_segment_action: "added",
		},
	};
};

export const segmentRemoveHandler: NodeHandler = async (ctx) => {
	const resolved: ResolvedSegmentContext = await resolveSegmentContext(
		ctx,
		ctx.node.config.segment_id,
	);
	if ("error" in resolved) return { kind: "fail", error: resolved.error };

	await removeContactFromStaticSegment(ctx.db, {
		organizationId: ctx.enrollment.organization_id,
		contactId: resolved.contactId,
		segmentId: resolved.segmentId,
	});

	return {
		kind: "next",
		state_patch: {
			last_segment_id: resolved.segmentId,
			last_segment_action: "removed",
		},
	};
};
