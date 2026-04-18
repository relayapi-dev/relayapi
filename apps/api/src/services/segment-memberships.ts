import {
	type Database,
	contactSegmentMemberships,
	contacts,
	segments,
} from "@relayapi/db";
import { and, eq, inArray, sql } from "drizzle-orm";

export interface ContactSegmentMembershipRow {
	segment_id: string;
	workspace_id: string | null;
	name: string;
	description: string | null;
	is_dynamic: boolean;
	source: string;
	created_at: string;
}

export async function getContactSegmentIds(
	db: Database,
	contactIds: string[],
): Promise<Map<string, string[]>> {
	if (contactIds.length === 0) return new Map();

	const rows = await db
		.select({
			contactId: contactSegmentMemberships.contactId,
			segmentId: contactSegmentMemberships.segmentId,
		})
		.from(contactSegmentMemberships)
		.where(inArray(contactSegmentMemberships.contactId, contactIds));

	const out = new Map<string, string[]>();
	for (const row of rows) {
		const list = out.get(row.contactId) ?? [];
		list.push(row.segmentId);
		out.set(row.contactId, list);
	}
	return out;
}

export async function listContactSegmentMemberships(
	db: Database,
	organizationId: string,
	contactId: string,
): Promise<ContactSegmentMembershipRow[]> {
	const rows = await db
		.select({
			segment_id: segments.id,
			workspace_id: segments.workspaceId,
			name: segments.name,
			description: segments.description,
			is_dynamic: segments.isDynamic,
			source: contactSegmentMemberships.source,
			created_at: contactSegmentMemberships.createdAt,
		})
		.from(contactSegmentMemberships)
		.innerJoin(
			segments,
			and(
				eq(contactSegmentMemberships.segmentId, segments.id),
				eq(contactSegmentMemberships.organizationId, segments.organizationId),
			),
		)
		.where(
			and(
				eq(contactSegmentMemberships.organizationId, organizationId),
				eq(contactSegmentMemberships.contactId, contactId),
			),
		);

	return rows.map((row) => ({
		...row,
		created_at: row.created_at.toISOString(),
	}));
}

export async function ensureStaticSegment(
	db: Database,
	organizationId: string,
	segmentId: string,
) {
	const segment = await db.query.segments.findFirst({
		where: and(
			eq(segments.id, segmentId),
			eq(segments.organizationId, organizationId),
		),
	});
	if (!segment) {
		return { error: `segment '${segmentId}' not found` } as const;
	}
	if (segment.isDynamic) {
		return {
			error: `segment '${segmentId}' is dynamic and cannot be modified manually`,
		} as const;
	}
	return { segment } as const;
}

export async function ensureOrgContact(
	db: Database,
	organizationId: string,
	contactId: string,
) {
	const contact = await db.query.contacts.findFirst({
		where: and(eq(contacts.id, contactId), eq(contacts.organizationId, organizationId)),
	});
	if (!contact) {
		return { error: `contact '${contactId}' not found` } as const;
	}
	return { contact } as const;
}

export async function addContactToStaticSegment(
	db: Database,
	args: {
		organizationId: string;
		contactId: string;
		segmentId: string;
		source: string;
		createdByUserId?: string | null;
	},
) {
	const inserted = await db
		.insert(contactSegmentMemberships)
		.values({
			contactId: args.contactId,
			segmentId: args.segmentId,
			organizationId: args.organizationId,
			source: args.source,
			createdByUserId: args.createdByUserId ?? null,
		})
		.onConflictDoNothing()
		.returning({ segmentId: contactSegmentMemberships.segmentId });

	if (inserted.length > 0) {
		await db
			.update(segments)
			.set({
				memberCount: sql`greatest(${segments.memberCount} + 1, 0)`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(segments.id, args.segmentId),
					eq(segments.organizationId, args.organizationId),
				),
			);
	}

	return { added: inserted.length > 0 } as const;
}

export async function removeContactFromStaticSegment(
	db: Database,
	args: {
		organizationId: string;
		contactId: string;
		segmentId: string;
	},
) {
	const removed = await db
		.delete(contactSegmentMemberships)
		.where(
			and(
				eq(contactSegmentMemberships.organizationId, args.organizationId),
				eq(contactSegmentMemberships.contactId, args.contactId),
				eq(contactSegmentMemberships.segmentId, args.segmentId),
			),
		)
		.returning({ segmentId: contactSegmentMemberships.segmentId });

	if (removed.length > 0) {
		await db
			.update(segments)
			.set({
				memberCount: sql`greatest(${segments.memberCount} - 1, 0)`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(segments.id, args.segmentId),
					eq(segments.organizationId, args.organizationId),
				),
			);
	}

	return { removed: removed.length > 0 } as const;
}
