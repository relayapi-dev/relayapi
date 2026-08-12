import {
	contactSegmentMemberships,
	contacts,
	type Database,
	segments,
} from "@relayapi/db";
import { and, eq, inArray } from "drizzle-orm";
import { getDynamicSegmentPairs } from "./dynamic-segments";

export interface ContactSegmentMembershipRow {
	segment_id: string;
	workspace_id: string | null;
	name: string;
	description: string | null;
	is_dynamic: boolean;
	source: string;
	created_at: string | null;
}

export async function getContactSegmentIds(
	db: Database,
	organizationId: string,
	contactIds: string[],
): Promise<Map<string, string[]>> {
	if (contactIds.length === 0) return new Map();

	const [staticRows, dynamicRows] = await Promise.all([
		db
			.select({
				contactId: contactSegmentMemberships.contactId,
				segmentId: contactSegmentMemberships.segmentId,
			})
			.from(contactSegmentMemberships)
			.where(
				and(
					eq(contactSegmentMemberships.organizationId, organizationId),
					inArray(contactSegmentMemberships.contactId, contactIds),
				),
			),
		getDynamicSegmentPairs(db, organizationId, contactIds),
	]);

	const out = new Map<string, string[]>();
	for (const row of [...staticRows, ...dynamicRows]) {
		const list = out.get(row.contactId) ?? [];
		if (!list.includes(row.segmentId)) list.push(row.segmentId);
		out.set(row.contactId, list);
	}
	for (const ids of out.values()) ids.sort();
	return out;
}

export async function listContactSegmentMemberships(
	db: Database,
	organizationId: string,
	contactId: string,
): Promise<ContactSegmentMembershipRow[]> {
	const contact = await db.query.contacts.findFirst({
		columns: { id: true, scopeKey: true },
		where: and(
			eq(contacts.id, contactId),
			eq(contacts.organizationId, organizationId),
		),
	});
	if (!contact) return [];

	const [staticRows, dynamicDefinitions] = await Promise.all([
		db
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
					eq(segments.isDynamic, false),
				),
			),
		db
			.select({
				id: segments.id,
				organizationId: segments.organizationId,
				workspaceId: segments.workspaceId,
				scopeKey: segments.scopeKey,
				filter: segments.filter,
				isDynamic: segments.isDynamic,
				memberCount: segments.memberCount,
				name: segments.name,
				description: segments.description,
				createdAt: segments.createdAt,
			})
			.from(segments)
			.where(
				and(
					eq(segments.organizationId, organizationId),
					eq(segments.scopeKey, contact.scopeKey),
					eq(segments.isDynamic, true),
				),
			),
	]);

	const dynamicPairs = await getDynamicSegmentPairs(
		db,
		organizationId,
		[contactId],
		dynamicDefinitions,
	);
	const matchedDynamicIds = new Set(dynamicPairs.map((row) => row.segmentId));
	const memberships: ContactSegmentMembershipRow[] = staticRows.map((row) => ({
		...row,
		created_at: row.created_at.toISOString(),
	}));
	for (const segment of dynamicDefinitions) {
		if (!matchedDynamicIds.has(segment.id)) continue;
		memberships.push({
			segment_id: segment.id,
			workspace_id: segment.workspaceId,
			name: segment.name,
			description: segment.description,
			is_dynamic: true,
			source: "dynamic",
			created_at: null,
		});
	}
	return memberships.sort(
		(a, b) =>
			a.name.localeCompare(b.name) || a.segment_id.localeCompare(b.segment_id),
	);
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
		where: and(
			eq(contacts.id, contactId),
			eq(contacts.organizationId, organizationId),
		),
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

	return { removed: removed.length > 0 } as const;
}
