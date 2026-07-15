import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	automationContactControls,
	automationRuns,
	broadcastRecipients,
	contactChannels,
	contactConsentEvents,
	contactSegmentMemberships,
	contactSubscriptions,
	contacts,
	customFieldDefinitions,
	customFieldValues,
	generateId,
	inboxConversations,
	socialAccounts,
} from "@relayapi/db";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
	decodeTimestampIdCursor,
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
} from "../lib/pagination-cursor";
import {
	inheritOperationalCreateScope,
	workspaceScopeKey,
} from "../lib/request-access";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
} from "../lib/workspace-scope";
import { ErrorResponse } from "../schemas/common";
import {
	AddChannelBody,
	BulkCreateContactsBody,
	BulkCreateContactsResponse,
	BulkOperationsBody,
	BulkOperationsResponse,
	ChannelIdParams,
	ChannelResponse,
	ContactConsentListResponse,
	ContactConsentQuery,
	ContactConsentResponse,
	ContactFieldParams,
	ContactIdParams,
	ContactListResponse,
	ContactQuery,
	ContactResponse,
	ContactSegmentMembershipListResponse,
	ContactSegmentMembershipResponse,
	ContactSegmentParams,
	CreateContactBody,
	MergeContactBody,
	MergeContactResponse,
	RecordContactConsentBody,
	SetContactFieldBody,
	SetContactFieldResponse,
	UpdateContactBody,
} from "../schemas/contacts";
import {
	isConsentOccurrenceTimeAllowed,
	normalizeRecipientIdentifier,
	recordContactConsent,
	recordContactConsentInTransaction,
} from "../services/contact-consent";
import {
	addContactToStaticSegment,
	ensureStaticSegment,
	getContactSegmentIds,
	listContactSegmentMemberships,
	removeContactFromStaticSegment,
} from "../services/segment-memberships";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
const CONTACT_ERASURE_PURPOSES = [
	"marketing",
	"automation",
	"service",
] as const;

// --- Helpers ---

type SerializableChannel = Pick<
	typeof contactChannels.$inferSelect,
	"id" | "socialAccountId" | "platform" | "identifier" | "createdAt"
>;

function uniqueConsentIdentifiers(
	identifiers: Array<{ channel: string; identifier: string } | null>,
): Array<{ channel: string; identifier: string }> {
	const seen = new Set<string>();
	return identifiers.filter(
		(value): value is { channel: string; identifier: string } => {
			if (!value) return false;
			const key = `${value.channel}:${normalizeRecipientIdentifier(value.channel, value.identifier)}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		},
	);
}

function serializeContact(
	c: {
		id: string;
		workspaceId: string | null;
		name: string | null;
		email: string | null;
		phone: string | null;
		tags: string[];
		optedIn: boolean;
		metadata: unknown;
		createdAt: Date;
		updatedAt: Date;
	},
	channels: SerializableChannel[] = [],
	segmentIds: string[] = [],
) {
	return {
		id: c.id,
		workspace_id: c.workspaceId,
		name: c.name ?? null,
		email: c.email ?? null,
		phone: c.phone ?? null,
		tags: c.tags,
		opted_in: c.optedIn,
		channels: channels.map(serializeChannel),
		segment_ids: segmentIds,
		metadata: (c.metadata as Record<string, unknown> | null) ?? null,
		created_at: c.createdAt.toISOString(),
		updated_at: c.updatedAt.toISOString(),
	};
}

function serializeChannel(ch: SerializableChannel) {
	return {
		id: ch.id,
		social_account_id: ch.socialAccountId,
		platform: ch.platform,
		identifier: ch.identifier,
		created_at: ch.createdAt.toISOString(),
	};
}

function serializeConsentEvent(
	event: typeof contactConsentEvents.$inferSelect,
) {
	return {
		id: event.id,
		contact_id: event.contactId,
		channel: event.channel,
		purpose: event.purpose,
		status: event.status,
		identifier_hash: event.identifierHash,
		identifier_masked: event.identifierMasked,
		source: event.source,
		occurred_at: event.occurredAt.toISOString(),
		evidence: (event.evidence as Record<string, unknown> | null) ?? null,
		policy_version: event.policyVersion,
		jurisdiction: event.jurisdiction,
		created_at: event.createdAt.toISOString(),
	};
}

// =====================
// Route definitions
// =====================

// 1. List contacts
const listContacts = createRoute({
	operationId: "listContacts",
	method: "get",
	path: "/",
	tags: ["Contacts"],
	summary: "List contacts with filtering and pagination",
	security: [{ Bearer: [] }],
	request: { query: ContactQuery },
	responses: {
		200: {
			description: "Contacts list",
			content: { "application/json": { schema: ContactListResponse } },
		},
	},
});

// 2. Create contact
const createContact = createRoute({
	operationId: "createContact",
	method: "post",
	path: "/",
	tags: ["Contacts"],
	summary: "Create a contact",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: CreateContactBody } } },
	},
	responses: {
		201: {
			description: "Contact created",
			content: { "application/json": { schema: ContactResponse } },
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// 3. Get contact
const getContact = createRoute({
	operationId: "getContact",
	method: "get",
	path: "/{id}",
	tags: ["Contacts"],
	summary: "Get a single contact with all channels",
	security: [{ Bearer: [] }],
	request: { params: ContactIdParams },
	responses: {
		200: {
			description: "Contact details",
			content: { "application/json": { schema: ContactResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// 4. Update contact
const updateContact = createRoute({
	operationId: "updateContact",
	method: "patch",
	path: "/{id}",
	tags: ["Contacts"],
	summary: "Update a contact",
	security: [{ Bearer: [] }],
	request: {
		params: ContactIdParams,
		body: { content: { "application/json": { schema: UpdateContactBody } } },
	},
	responses: {
		200: {
			description: "Updated contact",
			content: { "application/json": { schema: ContactResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// 5. Delete contact
const deleteContact = createRoute({
	operationId: "deleteContact",
	method: "delete",
	path: "/{id}",
	tags: ["Contacts"],
	summary: "Delete a contact",
	security: [{ Bearer: [] }],
	request: { params: ContactIdParams },
	responses: {
		204: { description: "Contact deleted" },
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const listContactConsents = createRoute({
	operationId: "listContactConsents",
	method: "get",
	path: "/{id}/consents",
	tags: ["Contacts"],
	summary: "List immutable consent evidence for a contact",
	security: [{ Bearer: [] }],
	request: { params: ContactIdParams, query: ContactConsentQuery },
	responses: {
		200: {
			description: "Consent evidence",
			content: { "application/json": { schema: ContactConsentListResponse } },
		},
		400: {
			description: "Invalid cursor",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const recordContactConsentRoute = createRoute({
	operationId: "recordContactConsent",
	method: "post",
	path: "/{id}/consents",
	tags: ["Contacts"],
	summary: "Record consent or withdrawal evidence",
	description:
		"Consent authority is organization-global for the exact channel, purpose, and normalized recipient identifier. The contact workspace is retained only as evidence provenance.",
	security: [{ Bearer: [] }],
	request: {
		params: ContactIdParams,
		body: {
			content: { "application/json": { schema: RecordContactConsentBody } },
		},
	},
	responses: {
		201: {
			description: "Immutable consent event",
			content: { "application/json": { schema: ContactConsentResponse } },
		},
		400: {
			description: "Identifier cannot be inferred",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// 6. List channels for a contact
const listChannels = createRoute({
	operationId: "listContactChannels",
	method: "get",
	path: "/{id}/channels",
	tags: ["Contacts"],
	summary: "List channels for a contact",
	security: [{ Bearer: [] }],
	request: { params: ContactIdParams },
	responses: {
		200: {
			description: "Channel list",
			content: {
				"application/json": {
					schema: z.object({ data: z.array(ChannelResponse) }),
				},
			},
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// 7. Add channel to a contact
const addChannel = createRoute({
	operationId: "addContactChannel",
	method: "post",
	path: "/{id}/channels",
	tags: ["Contacts"],
	summary: "Add a channel to a contact",
	security: [{ Bearer: [] }],
	request: {
		params: ContactIdParams,
		body: { content: { "application/json": { schema: AddChannelBody } } },
	},
	responses: {
		201: {
			description: "Channel added",
			content: { "application/json": { schema: ChannelResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Channel already exists",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// 8. Remove channel from a contact
const removeChannel = createRoute({
	operationId: "removeContactChannel",
	method: "delete",
	path: "/{id}/channels/{channelId}",
	tags: ["Contacts"],
	summary: "Remove a channel from a contact",
	security: [{ Bearer: [] }],
	request: { params: ChannelIdParams },
	responses: {
		204: { description: "Channel removed" },
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// 9. List static segment memberships for a contact
const listContactSegments = createRoute({
	operationId: "listContactSegments",
	method: "get",
	path: "/{id}/segments",
	tags: ["Contacts"],
	summary: "List static segment memberships for a contact",
	security: [{ Bearer: [] }],
	request: { params: ContactIdParams },
	responses: {
		200: {
			description: "Contact segment memberships",
			content: {
				"application/json": {
					schema: ContactSegmentMembershipListResponse,
				},
			},
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// 10. Add a contact to a static segment
const addContactSegment = createRoute({
	operationId: "addContactSegment",
	method: "put",
	path: "/{id}/segments/{segmentId}",
	tags: ["Contacts"],
	summary: "Add a contact to a static segment",
	security: [{ Bearer: [] }],
	request: { params: ContactSegmentParams },
	responses: {
		200: {
			description: "Membership added",
			content: {
				"application/json": { schema: ContactSegmentMembershipResponse },
			},
		},
		400: {
			description: "Invalid segment",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// 11. Remove a contact from a static segment
const removeContactSegment = createRoute({
	operationId: "removeContactSegment",
	method: "delete",
	path: "/{id}/segments/{segmentId}",
	tags: ["Contacts"],
	summary: "Remove a contact from a static segment",
	security: [{ Bearer: [] }],
	request: { params: ContactSegmentParams },
	responses: {
		204: { description: "Membership removed" },
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// 12. Bulk create contacts
const bulkCreate = createRoute({
	operationId: "bulkCreateContacts",
	method: "post",
	path: "/bulk",
	tags: ["Contacts"],
	summary: "Bulk create up to 1000 contacts",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: BulkCreateContactsBody } },
		},
	},
	responses: {
		200: {
			description: "Bulk create result",
			content: { "application/json": { schema: BulkCreateContactsResponse } },
		},
	},
});

// 13. Bulk operations (add_tags, remove_tags, delete)
const bulkOperations = createRoute({
	operationId: "bulkContactOperations",
	method: "post",
	path: "/bulk-operations",
	tags: ["Contacts"],
	summary: "Bulk add tags, remove tags, or delete contacts",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: BulkOperationsBody } } },
	},
	responses: {
		200: {
			description: "Bulk operation result",
			content: { "application/json": { schema: BulkOperationsResponse } },
		},
	},
});

// 14. Merge contacts
const mergeContact = createRoute({
	operationId: "mergeContact",
	method: "post",
	path: "/{id}/merge",
	tags: ["Contacts"],
	summary: "Merge another contact into this one",
	security: [{ Bearer: [] }],
	request: {
		params: ContactIdParams,
		body: { content: { "application/json": { schema: MergeContactBody } } },
	},
	responses: {
		200: {
			description: "Merge result",
			content: { "application/json": { schema: MergeContactResponse } },
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// 15. Set custom field value
const setFieldValue = createRoute({
	operationId: "setContactFieldValue",
	method: "put",
	path: "/{id}/fields/{slug}",
	tags: ["Contacts"],
	summary: "Set a custom field value for a contact",
	security: [{ Bearer: [] }],
	request: {
		params: ContactFieldParams,
		body: { content: { "application/json": { schema: SetContactFieldBody } } },
	},
	responses: {
		200: {
			description: "Field value set",
			content: { "application/json": { schema: SetContactFieldResponse } },
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// 16. Clear custom field value
const clearFieldValue = createRoute({
	operationId: "clearContactFieldValue",
	method: "delete",
	path: "/{id}/fields/{slug}",
	tags: ["Contacts"],
	summary: "Clear a custom field value for a contact",
	security: [{ Bearer: [] }],
	request: { params: ContactFieldParams },
	responses: {
		204: { description: "Field value cleared" },
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// =====================
// Route handlers
// =====================

// 1. List contacts
app.openapi(listContacts, async (c) => {
	const orgId = c.get("orgId");
	const {
		workspace_id,
		search,
		tag,
		segment_id,
		platform,
		account_id,
		cursor,
		limit,
	} = c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(contacts.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, contacts.workspaceId);

	if (workspace_id) {
		conditions.push(eq(contacts.workspaceId, workspace_id));
	}

	if (search) {
		const escaped = search.replace(/[%_\\]/g, "\\$&");
		const searchCondition = or(
			ilike(contacts.name, `%${escaped}%`),
			ilike(contacts.phone, `%${escaped}%`),
			ilike(contacts.email, `%${escaped}%`),
		);
		if (searchCondition) {
			conditions.push(searchCondition);
		}
	}

	if (tag) {
		conditions.push(sql`${tag} = ANY(${contacts.tags})`);
	}

	if (segment_id) {
		conditions.push(
			sql`EXISTS (
				SELECT 1 FROM contact_segment_memberships csm
				WHERE csm.contact_id = ${contacts.id}
				AND csm.segment_id = ${segment_id}
				AND csm.organization_id = ${orgId}
			)`,
		);
	}

	if (platform && account_id) {
		conditions.push(
			sql`EXISTS (
				SELECT 1 FROM contact_channels cc
				WHERE cc.contact_id = ${contacts.id}
				AND cc.platform = ${platform}
				AND cc.social_account_id = ${account_id}
			)`,
		);
	} else if (platform) {
		conditions.push(
			sql`EXISTS (
				SELECT 1 FROM contact_channels cc
				WHERE cc.contact_id = ${contacts.id}
				AND cc.platform = ${platform}
			)`,
		);
	}

	if (cursor) {
		// Fetch the cursor row's created_at as raw text so we don't round-trip it
		// through a JS Date, which truncates Postgres microseconds to millisecond
		// precision. Truncation would skip rows sharing the cursor's millisecond
		// (common after bulk imports) once the page boundary falls inside that
		// millisecond. Bind it back with an explicit ::timestamptz cast to keep the
		// keyset comparison exact.
		const [cursorRow] = await db
			.select({ createdAt: sql<string>`${contacts.createdAt}::text` })
			.from(contacts)
			.where(eq(contacts.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${contacts.createdAt}, ${contacts.id}) < (${cursorRow.createdAt}::timestamptz, ${cursor})`,
			);
		}
	}

	const rows = await db
		.select({
			id: contacts.id,
			workspaceId: contacts.workspaceId,
			name: contacts.name,
			email: contacts.email,
			phone: contacts.phone,
			tags: contacts.tags,
			optedIn: contacts.optedIn,
			metadata: contacts.metadata,
			createdAt: contacts.createdAt,
			updatedAt: contacts.updatedAt,
		})
		.from(contacts)
		.where(and(...conditions))
		.orderBy(desc(contacts.createdAt), desc(contacts.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	// Load channels for all returned contacts
	const contactIds = data.map((ct) => ct.id);
	// Channels and segment memberships both key only on contactIds and are
	// independent — fetch them in parallel instead of two serial round-trips.
	const [channels, segmentIdsByContact] = await Promise.all([
		contactIds.length > 0
			? db
					.select({
						id: contactChannels.id,
						contactId: contactChannels.contactId,
						socialAccountId: contactChannels.socialAccountId,
						platform: contactChannels.platform,
						identifier: contactChannels.identifier,
						createdAt: contactChannels.createdAt,
					})
					.from(contactChannels)
					.where(inArray(contactChannels.contactId, contactIds))
			: Promise.resolve([]),
		getContactSegmentIds(db, contactIds),
	]);

	const channelsByContact = new Map<string, (typeof channels)[number][]>();
	for (const ch of channels) {
		const list = channelsByContact.get(ch.contactId) ?? [];
		list.push(ch);
		channelsByContact.set(ch.contactId, list);
	}

	return c.json(
		{
			data: data.map((ct) =>
				serializeContact(
					ct,
					channelsByContact.get(ct.id) ?? [],
					segmentIdsByContact.get(ct.id) ?? [],
				),
			),
			next_cursor:
				hasMore && data.length > 0 ? (data[data.length - 1]?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

// 2. Create contact
// @ts-expect-error — handler returns 201 or 400
app.openapi(createContact, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");
	const parentWorkspaceIds: Array<string | null> = [];
	if (body.account_id && body.platform && body.identifier) {
		const accountConditions = [
			eq(socialAccounts.id, body.account_id),
			eq(socialAccounts.organizationId, orgId),
		];
		applyWorkspaceScope(c, accountConditions, socialAccounts.workspaceId);
		const [account] = await db
			.select({
				id: socialAccounts.id,
				platform: socialAccounts.platform,
				workspaceId: socialAccounts.workspaceId,
			})
			.from(socialAccounts)
			.where(and(...accountConditions))
			.limit(1);
		if (!account || account.platform !== body.platform) {
			return c.json(
				{
					error: {
						code: "INVALID_ACCOUNT",
						message:
							"Channel account must belong to the contact workspace and platform",
					},
				},
				400,
			);
		}
		parentWorkspaceIds.push(account.workspaceId);
	}
	const scope = await inheritOperationalCreateScope(
		c,
		body.workspace_id,
		parentWorkspaceIds,
		"contact",
	);
	if (!scope.ok) return scope.response as never;
	const workspaceId = scope.workspaceId;

	const contactValues = {
		organizationId: orgId,
		workspaceId,
		name: body.name ?? null,
		email: body.email ?? null,
		phone: body.phone ?? null,
		tags: body.tags ?? [],
		optedIn: body.opted_in ?? false,
		metadata: body.metadata ?? null,
	};

	// The common path has no consent evidence to project. Preserve its original
	// latency by avoiding a transaction and the associated extra round trip.
	if (body.opted_in === undefined) {
		const [contact] = await db
			.insert(contacts)
			.values(contactValues)
			.returning();
		if (!contact) {
			return c.json(
				{
					error: {
						code: "INTERNAL_ERROR",
						message: "Failed to create contact",
					},
				},
				500,
			);
		}
		let channelRows: (typeof contactChannels.$inferSelect)[] = [];
		if (body.account_id && body.platform && body.identifier) {
			const [channel] = await db
				.insert(contactChannels)
				.values({
					organizationId: orgId,
					scopeKey: workspaceScopeKey(workspaceId),
					contactId: contact.id,
					socialAccountId: body.account_id,
					platform:
						body.platform as typeof contactChannels.$inferInsert.platform,
					identifier: body.identifier,
				})
				.onConflictDoNothing()
				.returning();
			if (channel) channelRows = [channel];
		}
		return c.json(serializeContact(contact, channelRows, []), 201);
	}

	const created = await db.transaction(async (tx) => {
		const [contact] = await tx
			.insert(contacts)
			.values(contactValues)
			.returning();
		if (!contact) return null;

		// If channel info was provided, create the first channel. ON CONFLICT keeps
		// the former duplicate-skip behavior without aborting the outer transaction.
		let channelRows: (typeof contactChannels.$inferSelect)[] = [];
		if (body.account_id && body.platform && body.identifier) {
			const [channel] = await tx
				.insert(contactChannels)
				.values({
					organizationId: orgId,
					scopeKey: workspaceScopeKey(workspaceId),
					contactId: contact.id,
					socialAccountId: body.account_id,
					platform:
						body.platform as typeof contactChannels.$inferInsert.platform,
					identifier: body.identifier,
				})
				.onConflictDoNothing()
				.returning();
			if (channel) channelRows = [channel];
		}

		// Preserve the existing explicit opted_in contract by projecting either
		// value into the canonical ledger for every identifier known at creation.
		// An omitted preference remains unproven and defaults conservatively false.
		if (body.opted_in !== undefined) {
			const occurredAt = new Date();
			const identifiers = uniqueConsentIdentifiers([
				body.email ? { channel: "email", identifier: body.email } : null,
				body.phone ? { channel: "sms", identifier: body.phone } : null,
				body.phone ? { channel: "whatsapp", identifier: body.phone } : null,
				...channelRows.map((channel) => ({
					channel: channel.platform,
					identifier: channel.identifier,
				})),
			]);
			for (const identifier of identifiers) {
				await recordContactConsentInTransaction(tx, {
					organizationId: orgId,
					workspaceId,
					contactId: contact.id,
					channel: identifier.channel,
					purpose: "marketing",
					identifier: identifier.identifier,
					status: body.opted_in ? "granted" : "denied",
					source: body.opted_in
						? "contact_global_opt_in"
						: "contact_global_opt_out",
					occurredAt,
					evidence: { opted_in: body.opted_in },
				});
			}
		}
		return { contact, channelRows };
	});

	if (!created) {
		return c.json(
			{
				error: { code: "INTERNAL_ERROR", message: "Failed to create contact" },
			},
			500,
		);
	}

	return c.json(
		serializeContact(created.contact, created.channelRows, []),
		201,
	);
});

// 3. Get contact
// @ts-expect-error — handler may return 403 from assertWorkspaceScope
app.openapi(getContact, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [contact] = await db
		.select()
		.from(contacts)
		.where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
		.limit(1);

	if (!contact) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, contact.workspaceId);
	if (denied) return denied;

	const [channels, segmentIdsMap] = await Promise.all([
		db
			.select()
			.from(contactChannels)
			.where(eq(contactChannels.contactId, contact.id)),
		getContactSegmentIds(db, [contact.id]),
	]);
	const segmentIds = segmentIdsMap.get(contact.id) ?? [];

	return c.json(serializeContact(contact, channels, segmentIds), 200);
});

app.openapi(listContactConsents, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { cursor, limit } = c.req.valid("query");
	const db = c.get("db");
	let decodedCursor: ReturnType<typeof decodeTimestampIdCursor> | null = null;
	if (cursor) {
		try {
			decodedCursor = decodeTimestampIdCursor(cursor);
		} catch {
			return c.json(INVALID_CURSOR_BODY, 400);
		}
	}
	const [contact] = await db
		.select({ workspaceId: contacts.workspaceId })
		.from(contacts)
		.where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
		.limit(1);
	if (!contact) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, contact.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	const conditions = [
		eq(contactConsentEvents.organizationId, orgId),
		eq(contactConsentEvents.contactId, id),
	];
	if (decodedCursor) {
		conditions.push(
			sql`(${contactConsentEvents.occurredAt}, ${contactConsentEvents.id}) < (${decodedCursor.timestamp}::timestamptz, ${decodedCursor.id})`,
		);
	}
	const events = await db
		.select()
		.from(contactConsentEvents)
		.where(and(...conditions))
		.orderBy(
			desc(contactConsentEvents.occurredAt),
			desc(contactConsentEvents.id),
		)
		.limit(limit + 1);
	const hasMore = events.length > limit;
	const page = events.slice(0, limit);
	const last = page.at(-1);
	return c.json(
		{
			data: page.map(serializeConsentEvent),
			next_cursor:
				hasMore && last
					? encodeTimestampIdCursor(last.occurredAt, last.id)
					: null,
			has_more: hasMore,
		},
		200,
	);
});

app.openapi(recordContactConsentRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const occurredAt = new Date(body.occurred_at);
	if (!isConsentOccurrenceTimeAllowed(occurredAt)) {
		return c.json(
			{
				error: {
					code: "INVALID_OCCURRENCE_TIME",
					message: "occurred_at cannot be more than five minutes in the future",
				},
			},
			400,
		);
	}
	const [contact] = await db
		.select()
		.from(contacts)
		.where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
		.limit(1);
	if (!contact) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, contact.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	let identifier = body.identifier;
	if (!identifier && body.channel === "email")
		identifier = contact.email ?? undefined;
	if (!identifier && ["sms", "whatsapp", "phone"].includes(body.channel)) {
		identifier = contact.phone ?? undefined;
	}
	if (!identifier) {
		const matchingChannels = await db
			.selectDistinct({ identifier: contactChannels.identifier })
			.from(contactChannels)
			.where(
				and(
					eq(contactChannels.contactId, id),
					eq(
						contactChannels.platform,
						body.channel as typeof contactChannels.$inferSelect.platform,
					),
				),
			)
			.limit(2);
		if (matchingChannels.length > 1) {
			return c.json(
				{
					error: {
						code: "AMBIGUOUS_IDENTIFIER",
						message:
							"Multiple identifiers match this consent channel; provide identifier explicitly",
					},
				},
				400,
			);
		}
		identifier = matchingChannels[0]?.identifier;
	}
	if (!identifier) {
		return c.json(
			{
				error: {
					code: "IDENTIFIER_REQUIRED",
					message: "Provide an identifier for this consent channel",
				},
			},
			400,
		);
	}

	const event = await recordContactConsent(db, {
		organizationId: orgId,
		workspaceId: contact.workspaceId,
		contactId: id,
		channel: body.channel,
		purpose: body.purpose,
		identifier,
		status: body.status,
		source: body.source,
		occurredAt,
		evidence: body.evidence ?? null,
		policyVersion: body.policy_version ?? null,
		jurisdiction: body.jurisdiction ?? null,
	});
	return c.json(serializeConsentEvent(event), 201);
});

// 4. Update contact
// @ts-expect-error — handler may return 403 from assertWorkspaceScope
app.openapi(updateContact, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	// Verify contact exists and check workspace scope before updating
	const [existing] = await db
		.select()
		.from(contacts)
		.where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	const updateSet: Record<string, unknown> = { updatedAt: new Date() };
	if (body.name !== undefined) updateSet.name = body.name;
	if (body.email !== undefined) updateSet.email = body.email;
	if (body.phone !== undefined) updateSet.phone = body.phone;
	if (body.tags !== undefined) updateSet.tags = body.tags;
	if (body.opted_in !== undefined) updateSet.optedIn = body.opted_in;
	if (body.metadata !== undefined) updateSet.metadata = body.metadata;
	const retiredIdentifiers = uniqueConsentIdentifiers([
		body.email !== undefined &&
		existing.email &&
		normalizeRecipientIdentifier("email", existing.email) !==
			normalizeRecipientIdentifier("email", body.email)
			? { channel: "email", identifier: existing.email }
			: null,
		body.phone !== undefined &&
		existing.phone &&
		normalizeRecipientIdentifier("sms", existing.phone) !==
			normalizeRecipientIdentifier("sms", body.phone)
			? { channel: "sms", identifier: existing.phone }
			: null,
		body.phone !== undefined &&
		existing.phone &&
		normalizeRecipientIdentifier("whatsapp", existing.phone) !==
			normalizeRecipientIdentifier("whatsapp", body.phone)
			? { channel: "whatsapp", identifier: existing.phone }
			: null,
	]);

	if (body.opted_in === undefined) {
		const updated =
			retiredIdentifiers.length === 0
				? (
						await db
							.update(contacts)
							.set(updateSet)
							.where(eq(contacts.id, id))
							.returning()
					).at(0)
				: await db.transaction(async (tx) => {
						const [saved] = await tx
							.update(contacts)
							.set(updateSet)
							.where(eq(contacts.id, id))
							.returning();
						if (!saved) return null;
						const occurredAt = new Date();
						for (const identifier of retiredIdentifiers) {
							for (const purpose of CONTACT_ERASURE_PURPOSES) {
								await recordContactConsentInTransaction(tx, {
									organizationId: orgId,
									workspaceId: saved.workspaceId,
									contactId: saved.id,
									channel: identifier.channel,
									purpose,
									identifier: identifier.identifier,
									status: "denied",
									source: "contact_identifier_replaced",
									occurredAt,
									evidence: { reason: "identifier_replaced" },
								});
							}
						}
						return saved;
					});
		if (!updated) {
			return c.json(
				{ error: { code: "NOT_FOUND", message: "Contact not found" } },
				404,
			);
		}
		const [channels, segmentIdsMap] = await Promise.all([
			db
				.select()
				.from(contactChannels)
				.where(eq(contactChannels.contactId, updated.id)),
			getContactSegmentIds(db, [updated.id]),
		]);
		return c.json(
			serializeContact(updated, channels, segmentIdsMap.get(updated.id) ?? []),
			200,
		);
	}

	const result = await db.transaction(async (tx) => {
		const [updated] = await tx
			.update(contacts)
			.set(updateSet)
			.where(eq(contacts.id, id))
			.returning();
		if (!updated) return null;
		const channels = await tx
			.select()
			.from(contactChannels)
			.where(eq(contactChannels.contactId, updated.id));
		const occurredAt = new Date();
		for (const identifier of retiredIdentifiers) {
			for (const purpose of CONTACT_ERASURE_PURPOSES) {
				await recordContactConsentInTransaction(tx, {
					organizationId: orgId,
					workspaceId: updated.workspaceId,
					contactId: updated.id,
					channel: identifier.channel,
					purpose,
					identifier: identifier.identifier,
					status: "denied",
					source: "contact_identifier_replaced",
					occurredAt,
					evidence: { reason: "identifier_replaced" },
				});
			}
		}
		const identifiers = uniqueConsentIdentifiers([
			updated.email ? { channel: "email", identifier: updated.email } : null,
			updated.phone ? { channel: "sms", identifier: updated.phone } : null,
			updated.phone ? { channel: "whatsapp", identifier: updated.phone } : null,
			!body.opted_in && existing.email
				? { channel: "email", identifier: existing.email }
				: null,
			!body.opted_in && existing.phone
				? { channel: "sms", identifier: existing.phone }
				: null,
			!body.opted_in && existing.phone
				? { channel: "whatsapp", identifier: existing.phone }
				: null,
			...channels.map((channel) => ({
				channel: channel.platform,
				identifier: channel.identifier,
			})),
		]);
		for (const identifier of identifiers) {
			await recordContactConsentInTransaction(tx, {
				organizationId: orgId,
				workspaceId: updated.workspaceId,
				contactId: updated.id,
				channel: identifier.channel,
				purpose: "marketing",
				identifier: identifier.identifier,
				status: body.opted_in ? "granted" : "denied",
				source: body.opted_in
					? "contact_global_opt_in"
					: "contact_global_opt_out",
				occurredAt,
				evidence: { opted_in: body.opted_in },
			});
		}
		return { updated, channels };
	});
	if (!result) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}
	const segmentIdsMap = await getContactSegmentIds(db, [result.updated.id]);
	return c.json(
		serializeContact(
			result.updated,
			result.channels,
			segmentIdsMap.get(result.updated.id) ?? [],
		),
		200,
	);
});

// 5. Delete contact
app.openapi(deleteContact, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select({
			id: contacts.id,
			workspaceId: contacts.workspaceId,
			email: contacts.email,
			phone: contacts.phone,
		})
		.from(contacts)
		.where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;
	const channels = await db
		.select({
			platform: contactChannels.platform,
			identifier: contactChannels.identifier,
		})
		.from(contactChannels)
		.where(eq(contactChannels.contactId, id));
	const identifiers = [
		existing.email ? { channel: "email", identifier: existing.email } : null,
		existing.phone ? { channel: "sms", identifier: existing.phone } : null,
		existing.phone ? { channel: "whatsapp", identifier: existing.phone } : null,
		...channels.map((channel) => ({
			channel: channel.platform,
			identifier: channel.identifier,
		})),
	].filter(
		(value): value is { channel: string; identifier: string } => value !== null,
	);
	for (const identifier of identifiers) {
		for (const purpose of CONTACT_ERASURE_PURPOSES) {
			await recordContactConsent(db, {
				organizationId: orgId,
				workspaceId: existing.workspaceId,
				contactId: id,
				channel: identifier.channel,
				purpose,
				identifier: identifier.identifier,
				status: "denied",
				source: "contact_deleted",
				occurredAt: new Date(),
				evidence: { reason: "contact_deleted" },
			});
		}
	}

	await db.delete(contacts).where(eq(contacts.id, id));

	return c.body(null, 204);
});

// 6. List channels for a contact
// @ts-expect-error — handler may return 403 from assertWorkspaceScope
app.openapi(listChannels, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	// Verify contact belongs to org
	const [contact] = await db
		.select({ id: contacts.id, workspaceId: contacts.workspaceId })
		.from(contacts)
		.where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
		.limit(1);

	if (!contact) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, contact.workspaceId);
	if (denied) return denied;

	const channels = await db
		.select()
		.from(contactChannels)
		.where(eq(contactChannels.contactId, id));

	return c.json({ data: channels.map(serializeChannel) }, 200);
});

// 7. Add channel
// @ts-expect-error — handler may return 403 from assertWorkspaceScope
app.openapi(addChannel, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	// Verify contact belongs to org
	const [contact] = await db
		.select({ id: contacts.id, workspaceId: contacts.workspaceId })
		.from(contacts)
		.where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
		.limit(1);

	if (!contact) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, contact.workspaceId);
	if (denied) return denied;
	const [account] = await db
		.select({ id: socialAccounts.id, platform: socialAccounts.platform })
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, body.account_id),
				eq(socialAccounts.organizationId, orgId),
				sql`${socialAccounts.workspaceId} IS NOT DISTINCT FROM ${contact.workspaceId}`,
			),
		)
		.limit(1);
	if (!account || account.platform !== body.platform) {
		return c.json(
			{
				error: {
					code: "INVALID_ACCOUNT",
					message:
						"Channel account must belong to the contact workspace and platform",
				},
			},
			400,
		);
	}

	try {
		const [ch] = await db
			.insert(contactChannels)
			.values({
				organizationId: orgId,
				scopeKey: workspaceScopeKey(contact.workspaceId),
				contactId: id,
				socialAccountId: body.account_id,
				platform: body.platform,
				identifier: body.identifier,
			})
			.returning();

		if (!ch) throw new Error("Failed to create channel");
		return c.json(serializeChannel(ch), 201);
	} catch {
		return c.json(
			{
				error: {
					code: "CONFLICT",
					message: "Channel already exists for this account and identifier",
				},
			},
			409,
		);
	}
});

// 8. Remove channel
app.openapi(removeChannel, async (c) => {
	const orgId = c.get("orgId");
	const { id, channelId } = c.req.valid("param");
	const db = c.get("db");

	// Verify contact belongs to org
	const [contact] = await db
		.select({ id: contacts.id, workspaceId: contacts.workspaceId })
		.from(contacts)
		.where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
		.limit(1);

	if (!contact) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, contact.workspaceId);
	if (denied) return denied;

	const [deleted] = await db
		.delete(contactChannels)
		.where(
			and(eq(contactChannels.id, channelId), eq(contactChannels.contactId, id)),
		)
		.returning({ id: contactChannels.id });

	if (!deleted) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Channel not found" } },
			404,
		);
	}

	return c.body(null, 204);
});

// 9. List contact segments
// @ts-expect-error — handler may return 403 from assertWorkspaceScope
app.openapi(listContactSegments, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [contact] = await db
		.select({ id: contacts.id, workspaceId: contacts.workspaceId })
		.from(contacts)
		.where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
		.limit(1);

	if (!contact) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, contact.workspaceId);
	if (denied) return denied;

	const memberships = (
		await listContactSegmentMemberships(db, orgId, id)
	).filter((row) => !isWorkspaceScopeDenied(c, row.workspace_id));

	return c.json({ data: memberships }, 200);
});

// 10. Add contact to segment
// @ts-expect-error — handler may return 400/403 from scope and validation checks
app.openapi(addContactSegment, async (c) => {
	const orgId = c.get("orgId");
	const { id, segmentId } = c.req.valid("param");
	const db = c.get("db");

	const [contact] = await db
		.select({ id: contacts.id, workspaceId: contacts.workspaceId })
		.from(contacts)
		.where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
		.limit(1);

	if (!contact) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, contact.workspaceId);
	if (denied) return denied;

	const segmentResult = await ensureStaticSegment(db, orgId, segmentId);
	if ("error" in segmentResult) {
		return c.json(
			{ error: { code: "BAD_REQUEST", message: segmentResult.error } },
			400,
		);
	}

	const segmentDenied = assertWorkspaceScope(
		c,
		segmentResult.segment.workspaceId,
	);
	if (segmentDenied) return segmentDenied;
	if (segmentResult.segment.workspaceId !== contact.workspaceId) {
		return c.json(
			{
				error: {
					code: "WORKSPACE_MISMATCH",
					message: "Contact and segment must belong to the same workspace.",
				},
			},
			400,
		);
	}

	await addContactToStaticSegment(db, {
		organizationId: orgId,
		contactId: id,
		segmentId,
		source: "manual",
		createdByUserId: null,
	});

	const membership = (await listContactSegmentMemberships(db, orgId, id)).find(
		(row) => row.segment_id === segmentId,
	);

	return c.json(
		membership ?? {
			segment_id: segmentResult.segment.id,
			workspace_id: segmentResult.segment.workspaceId ?? null,
			name: segmentResult.segment.name,
			description: segmentResult.segment.description ?? null,
			is_dynamic: false,
			source: "manual",
			created_at: new Date().toISOString(),
		},
		200,
	);
});

// 11. Remove contact from segment
app.openapi(removeContactSegment, async (c) => {
	const orgId = c.get("orgId");
	const { id, segmentId } = c.req.valid("param");
	const db = c.get("db");

	const [contact] = await db
		.select({ id: contacts.id, workspaceId: contacts.workspaceId })
		.from(contacts)
		.where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
		.limit(1);

	if (!contact) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, contact.workspaceId);
	if (denied) return denied;

	const segmentResult = await ensureStaticSegment(db, orgId, segmentId);
	if ("error" in segmentResult) {
		return c.json(
			{ error: { code: "BAD_REQUEST", message: segmentResult.error } },
			400,
		);
	}

	const segmentDenied = assertWorkspaceScope(
		c,
		segmentResult.segment.workspaceId,
	);
	if (segmentDenied) return segmentDenied;
	if (segmentResult.segment.workspaceId !== contact.workspaceId) {
		return c.json(
			{
				error: {
					code: "WORKSPACE_MISMATCH",
					message: "Contact and segment must belong to the same workspace.",
				},
			},
			400,
		);
	}

	await removeContactFromStaticSegment(db, {
		organizationId: orgId,
		contactId: id,
		segmentId,
	});

	return c.body(null, 204);
});

// 12. Bulk create contacts
// @ts-expect-error — handler may return 400/403 from scoped workspace checks
app.openapi(bulkCreate, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");
	const requestedChannelAccounts = [
		...new Set(
			body.contacts
				.map((item) => item.account_id)
				.filter((id): id is string => Boolean(id)),
		),
	];
	let parentWorkspaceIds: Array<string | null> = [];
	if (requestedChannelAccounts.length > 0) {
		const accountConditions = [
			eq(socialAccounts.organizationId, orgId),
			inArray(socialAccounts.id, requestedChannelAccounts),
		];
		applyWorkspaceScope(c, accountConditions, socialAccounts.workspaceId);
		const accountRows = await db
			.select({
				id: socialAccounts.id,
				platform: socialAccounts.platform,
				workspaceId: socialAccounts.workspaceId,
			})
			.from(socialAccounts)
			.where(and(...accountConditions));
		const accountPlatforms = new Map(
			accountRows.map((row) => [
				row.id,
				{ platform: row.platform, workspaceId: row.workspaceId },
			]),
		);
		const invalidAccount = body.contacts.find(
			(item) =>
				item.account_id &&
				(!accountPlatforms.has(item.account_id) ||
					(item.platform &&
						accountPlatforms.get(item.account_id)?.platform !== item.platform)),
		);
		if (invalidAccount) {
			return c.json(
				{
					error: {
						code: "INVALID_ACCOUNT",
						message:
							"Every channel account must belong to the contact workspace and platform",
					},
				},
				400,
			);
		}
		parentWorkspaceIds = accountRows.map((account) => account.workspaceId);
	}
	const scope = await inheritOperationalCreateScope(
		c,
		body.workspace_id,
		parentWorkspaceIds,
		"contact",
	);
	if (!scope.ok) return scope.response as never;
	const workspaceId = scope.workspaceId;

	let created = 0;
	let skipped = 0;

	const batchSize = 500;
	for (let i = 0; i < body.contacts.length; i += batchSize) {
		const batch = body.contacts.slice(i, i + batchSize);
		// Pre-generate contact ids client-side so we can correlate each returned
		// row to its source batch item by ID, not by array position. With
		// .onConflictDoNothing() RETURNING only yields rows actually inserted
		// (duplicates skipped by the unique (workspace_id, email) index are
		// omitted), so positional zipping would attach channels to the wrong
		// contacts — or drop them entirely — once any row in the batch conflicts.
		const values = batch.map((item) => ({
			id: generateId("ct_"),
			organizationId: orgId,
			workspaceId,
			name: item.name ?? null,
			email: item.email ?? null,
			phone: item.phone ?? null,
			tags: item.tags ?? [],
		}));

		const result = await db
			.insert(contacts)
			.values(values)
			.onConflictDoNothing()
			.returning({ id: contacts.id });

		const insertedIdSet = new Set(result.map((r) => r.id));
		created += insertedIdSet.size;

		// Batch channel inserts for this batch — one query instead of N.
		// onConflictDoNothing mirrors the prior per-row try/catch on duplicates.
		// Only attach a channel when its contact row was actually inserted; this
		// pairs each channel with the exact contact generated for that item and
		// naturally skips channels for rows skipped as duplicates.
		const channelValues: Array<{
			organizationId: string;
			scopeKey: string;
			contactId: string;
			socialAccountId: string;
			platform: typeof contactChannels.$inferInsert.platform;
			identifier: string;
		}> = [];
		for (const [j, item] of batch.entries()) {
			const insertedValue = values[j];
			if (!insertedValue) continue;
			const contactId = insertedValue.id;
			if (
				insertedIdSet.has(contactId) &&
				item.account_id &&
				item.platform &&
				item.identifier
			) {
				channelValues.push({
					organizationId: orgId,
					scopeKey: workspaceScopeKey(workspaceId),
					contactId,
					socialAccountId: item.account_id,
					platform:
						item.platform as typeof contactChannels.$inferInsert.platform,
					identifier: item.identifier,
				});
			}
		}
		if (channelValues.length > 0) {
			await db
				.insert(contactChannels)
				.values(channelValues)
				.onConflictDoNothing();
		}
	}

	skipped = body.contacts.length - created;

	return c.json({ created, skipped }, 200);
});

// 10. Bulk operations
app.openapi(bulkOperations, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	let affected = 0;
	const contactIds = body.contact_ids;
	const scopedConditions = () => {
		const conditions = [
			inArray(contacts.id, contactIds),
			eq(contacts.organizationId, orgId),
		];
		applyWorkspaceScope(c, conditions, contacts.workspaceId);
		return conditions;
	};

	if (body.action === "delete") {
		const deleting = await db
			.select({
				id: contacts.id,
				workspaceId: contacts.workspaceId,
				email: contacts.email,
				phone: contacts.phone,
			})
			.from(contacts)
			.where(and(...scopedConditions()));
		const deletingIds = deleting.map((contact) => contact.id);
		const channels =
			deletingIds.length > 0
				? await db
						.select({
							contactId: contactChannels.contactId,
							platform: contactChannels.platform,
							identifier: contactChannels.identifier,
						})
						.from(contactChannels)
						.where(inArray(contactChannels.contactId, deletingIds))
				: [];
		for (const contact of deleting) {
			const identifiers = [
				contact.email ? { channel: "email", identifier: contact.email } : null,
				contact.phone ? { channel: "sms", identifier: contact.phone } : null,
				contact.phone
					? { channel: "whatsapp", identifier: contact.phone }
					: null,
				...channels
					.filter((channel) => channel.contactId === contact.id)
					.map((channel) => ({
						channel: channel.platform,
						identifier: channel.identifier,
					})),
			].filter(
				(value): value is { channel: string; identifier: string } =>
					value !== null,
			);
			for (const identifier of identifiers) {
				for (const purpose of CONTACT_ERASURE_PURPOSES) {
					await recordContactConsent(db, {
						organizationId: orgId,
						workspaceId: contact.workspaceId,
						contactId: contact.id,
						channel: identifier.channel,
						purpose,
						identifier: identifier.identifier,
						status: "denied",
						source: "contact_deleted",
						occurredAt: new Date(),
						evidence: { reason: "bulk_contact_deleted" },
					});
				}
			}
		}
		const result = await db
			.delete(contacts)
			.where(and(...scopedConditions()))
			.returning({ id: contacts.id });
		affected = result.length;
	} else if (body.action === "add_tags" && body.tags) {
		const tagsToAdd = body.tags;
		const result = await db
			.update(contacts)
			.set({
				tags: sql`(
					SELECT array_agg(DISTINCT elem)
					FROM unnest(array_cat(${contacts.tags}, ${tagsToAdd}::text[])) AS elem
				)`,
				updatedAt: new Date(),
			})
			.where(and(...scopedConditions()))
			.returning({ id: contacts.id });
		affected = result.length;
	} else if (body.action === "remove_tags" && body.tags) {
		const tagsToRemove = body.tags;
		const result = await db
			.update(contacts)
			.set({
				tags: sql`(
					SELECT coalesce(array_agg(elem), '{}')
					FROM unnest(${contacts.tags}) AS elem
					WHERE elem != ALL(${tagsToRemove}::text[])
				)`,
				updatedAt: new Date(),
			})
			.where(and(...scopedConditions()))
			.returning({ id: contacts.id });
		affected = result.length;
	}

	return c.json({ affected }, 200);
});

// 11. Merge contacts
// @ts-expect-error — handler may return 403 from assertWorkspaceScope
app.openapi(mergeContact, async (c) => {
	const orgId = c.get("orgId");
	const { id: targetId } = c.req.valid("param");
	const { merge_contact_id: sourceId } = c.req.valid("json");
	const db = c.get("db");

	// Guard against self-merge. Without this, the dedupe DELETEs below match
	// every channel/field against itself and wipe them all, and the final
	// source delete then destroys the contact row outright — returning 200
	// while irrecoverably deleting the contact and its cascaded children.
	if (sourceId === targetId) {
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message:
						"merge_contact_id must be different from the target contact id",
				},
			},
			400,
		);
	}

	// Verify both contacts belong to this org
	const [target] = await db
		.select({ id: contacts.id, workspaceId: contacts.workspaceId })
		.from(contacts)
		.where(and(eq(contacts.id, targetId), eq(contacts.organizationId, orgId)))
		.limit(1);

	if (!target) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Target contact not found" } },
			404,
		);
	}

	const targetDenied = assertWorkspaceScope(c, target.workspaceId);
	if (targetDenied) return targetDenied;

	const [source] = await db
		.select({ id: contacts.id, workspaceId: contacts.workspaceId })
		.from(contacts)
		.where(and(eq(contacts.id, sourceId), eq(contacts.organizationId, orgId)))
		.limit(1);

	if (!source) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Source contact not found" } },
			404,
		);
	}

	const sourceDenied = assertWorkspaceScope(c, source.workspaceId);
	if (sourceDenied) return sourceDenied;
	if (source.workspaceId !== target.workspaceId) {
		return c.json(
			{
				error: {
					code: "WORKSPACE_MISMATCH",
					message: "Contacts can only be merged within the same workspace.",
				},
			},
			400,
		);
	}

	// Run the whole merge inside a single transaction so a mid-sequence failure
	// (TOCTOU on a unique index, transient DB error, worker eviction) rolls back
	// cleanly instead of leaving a durable half-merged contact. All child-table
	// re-parenting and the final source delete must be atomic with each other.
	const result = await db.transaction(async (tx) => {
		// Move channels from source to target in bulk (skip duplicates).
		// Two queries total instead of N: first delete source rows whose
		// (socialAccountId, identifier) already exists under target (would violate
		// the unique index), then re-parent the rest.
		await tx.execute(sql`
			DELETE FROM contact_channels
			WHERE contact_id = ${sourceId}
				AND (social_account_id, identifier) IN (
					SELECT social_account_id, identifier
					FROM contact_channels
					WHERE contact_id = ${targetId}
				)
		`);
		const channelsMovedRows = await tx
			.update(contactChannels)
			.set({ contactId: targetId })
			.where(eq(contactChannels.contactId, sourceId))
			.returning({ id: contactChannels.id });
		const channelsMoved = channelsMovedRows.length;

		// Move custom field values from source to target in bulk (skip duplicates).
		// Same pattern: the unique index is on (definitionId, contactId), so delete
		// source rows whose definitionId already has a value on target, then re-parent.
		await tx.execute(sql`
			DELETE FROM custom_field_values
			WHERE contact_id = ${sourceId}
				AND definition_id IN (
					SELECT definition_id
					FROM custom_field_values
					WHERE contact_id = ${targetId}
				)
		`);
		const fieldsMovedRows = await tx
			.update(customFieldValues)
			.set({ contactId: targetId })
			.where(eq(customFieldValues.contactId, sourceId))
			.returning({ id: customFieldValues.id });
		const fieldsMoved = fieldsMovedRows.length;

		// Re-parent broadcast recipients and inbox conversations from source to
		// target — independent tables.
		const recipientResult = await tx
			.update(broadcastRecipients)
			.set({ contactId: targetId })
			.where(eq(broadcastRecipients.contactId, sourceId))
			.returning({ id: broadcastRecipients.id });
		const conversationResult = await tx
			.update(inboxConversations)
			.set({ contactId: targetId })
			.where(eq(inboxConversations.contactId, sourceId))
			.returning({ id: inboxConversations.id });
		const recipientsUpdated = recipientResult.length;
		const conversationsUpdated = conversationResult.length;

		// Re-parent automation runs (sequence/automation enrollments). These FK
		// with onDelete cascade, so without this the final source delete would
		// silently destroy the source's active and historical runs. The partial
		// unique index idx_automation_runs_active_uniq is on (contact_id,
		// automation_id) for status in (active, waiting), so first CAS-fence and
		// exit any source run that collides with an active/waiting target run for
		// the same automation, then re-parent it as history. Deleting the run would
		// erase its node/effect ledger while a provider request may still be in
		// flight; the revision bump makes that worker's final transition lose.
		await tx.execute(sql`
			UPDATE automation_runs
			SET status = 'exited',
				exit_reason = 'contact_merged_conflict',
				completed_at = NOW(),
				revision = revision + 1,
				updated_at = NOW()
			WHERE contact_id = ${sourceId}
				AND status IN ('active', 'waiting')
				AND automation_id IN (
					SELECT automation_id
					FROM automation_runs
					WHERE contact_id = ${targetId}
						AND status IN ('active', 'waiting')
				)
		`);
		const enrollmentRows = await tx
			.update(automationRuns)
			.set({
				contactId: targetId,
				revision: sql`${automationRuns.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(eq(automationRuns.contactId, sourceId))
			.returning({ id: automationRuns.id });
		const enrollmentsUpdated = enrollmentRows.length;

		// Re-parent automation pause/opt-out controls. FK with onDelete cascade,
		// so they would otherwise be destroyed by the source delete — making a
		// merged contact who had opted out messageable again. Dedupe against both
		// the per-automation unique index (contact_id, automation_id where
		// automation_id IS NOT NULL) and the global one (contact_id where
		// automation_id IS NULL) before re-parenting.
		await tx.execute(sql`
			DELETE FROM automation_contact_controls
			WHERE contact_id = ${sourceId}
				AND (
					(
						automation_id IS NOT NULL
						AND automation_id IN (
							SELECT automation_id
							FROM automation_contact_controls
							WHERE contact_id = ${targetId}
								AND automation_id IS NOT NULL
						)
					)
					OR (
						automation_id IS NULL
						AND EXISTS (
							SELECT 1
							FROM automation_contact_controls
							WHERE contact_id = ${targetId}
								AND automation_id IS NULL
						)
					)
				)
		`);
		await tx
			.update(automationContactControls)
			.set({ contactId: targetId })
			.where(eq(automationContactControls.contactId, sourceId));

		// Re-parent static segment memberships ('source: manual' rows cannot be
		// recomputed). PK is (contact_id, segment_id), so drop source rows for
		// segments the target already belongs to, then re-parent the rest.
		await tx.execute(sql`
			DELETE FROM contact_segment_memberships
			WHERE contact_id = ${sourceId}
				AND segment_id IN (
					SELECT segment_id
					FROM contact_segment_memberships
					WHERE contact_id = ${targetId}
				)
		`);
		await tx
			.update(contactSegmentMemberships)
			.set({ contactId: targetId })
			.where(eq(contactSegmentMemberships.contactId, sourceId));

		// Re-parent subscription-list rows. No FK (so the source delete would
		// orphan them), PK is (contact_id, list_id). Drop source rows for lists
		// the target is already on, then re-parent the rest.
		await tx.execute(sql`
			DELETE FROM contact_subscriptions
			WHERE contact_id = ${sourceId}
				AND list_id IN (
					SELECT list_id
					FROM contact_subscriptions
					WHERE contact_id = ${targetId}
				)
		`);
		await tx
			.update(contactSubscriptions)
			.set({ contactId: targetId })
			.where(eq(contactSubscriptions.contactId, sourceId));

		// Delete the source contact (remaining cascade children, if any, are now
		// empty or intentionally cascaded).
		await tx.delete(contacts).where(eq(contacts.id, sourceId));

		return {
			channelsMoved,
			fieldsMoved,
			recipientsUpdated,
			conversationsUpdated,
			enrollmentsUpdated,
		};
	});

	return c.json(
		{
			channels_moved: result.channelsMoved,
			fields_moved: result.fieldsMoved,
			recipients_updated: result.recipientsUpdated,
			conversations_updated: result.conversationsUpdated,
			enrollments_updated: result.enrollmentsUpdated,
		},
		200,
	);
});

// 12. Set custom field value
// @ts-expect-error — handler may return 403 from assertWorkspaceScope
app.openapi(setFieldValue, async (c) => {
	const orgId = c.get("orgId");
	const { id, slug } = c.req.valid("param");
	const { value } = c.req.valid("json");
	const db = c.get("db");

	// Verify contact exists in this org
	const [contact] = await db
		.select({ id: contacts.id, workspaceId: contacts.workspaceId })
		.from(contacts)
		.where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
		.limit(1);

	if (!contact) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, contact.workspaceId);
	if (denied) return denied;

	// Look up field definition
	const [field] = await db
		.select()
		.from(customFieldDefinitions)
		.where(
			and(
				eq(customFieldDefinitions.organizationId, orgId),
				eq(customFieldDefinitions.slug, slug),
			),
		)
		.limit(1);

	if (!field) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: `Custom field "${slug}" not found`,
				},
			},
			404,
		);
	}
	if (field.workspaceId !== null && field.workspaceId !== contact.workspaceId) {
		return c.json(
			{
				error: {
					code: "WORKSPACE_MISMATCH",
					message:
						"A workspace field can only be used by contacts in that workspace.",
				},
			},
			400,
		);
	}

	// Validate value against field type
	const strValue = String(value);
	switch (field.type) {
		case "number":
			if (Number.isNaN(Number(value))) {
				return c.json(
					{
						error: {
							code: "VALIDATION_ERROR",
							message: "Value must be a valid number",
						},
					},
					400,
				);
			}
			break;
		case "boolean":
			if (strValue !== "true" && strValue !== "false") {
				return c.json(
					{
						error: {
							code: "VALIDATION_ERROR",
							message: "Value must be true or false",
						},
					},
					400,
				);
			}
			break;
		case "date":
			if (Number.isNaN(Date.parse(strValue))) {
				return c.json(
					{
						error: {
							code: "VALIDATION_ERROR",
							message: "Value must be a valid ISO 8601 date",
						},
					},
					400,
				);
			}
			break;
		case "select": {
			const options = (field.options as string[] | null) ?? [];
			if (!options.includes(strValue)) {
				return c.json(
					{
						error: {
							code: "VALIDATION_ERROR",
							message: `Value must be one of: ${options.join(", ")}`,
						},
					},
					400,
				);
			}
			break;
		}
	}

	// Upsert the value
	await db
		.insert(customFieldValues)
		.values({
			definitionId: field.id,
			contactId: id,
			organizationId: orgId,
			scopeKey: workspaceScopeKey(contact.workspaceId),
			definitionScopeKey: workspaceScopeKey(field.workspaceId),
			value: strValue,
		})
		.onConflictDoUpdate({
			target: [customFieldValues.definitionId, customFieldValues.contactId],
			set: { value: strValue, updatedAt: new Date() },
		});

	return c.json({ success: true, field: slug, value }, 200);
});

// 13. Clear custom field value
app.openapi(clearFieldValue, async (c) => {
	const orgId = c.get("orgId");
	const { id, slug } = c.req.valid("param");
	const db = c.get("db");

	// Verify contact belongs to this org
	const [contact] = await db
		.select({ id: contacts.id, workspaceId: contacts.workspaceId })
		.from(contacts)
		.where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
		.limit(1);

	if (!contact) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, contact.workspaceId);
	if (denied) return denied;

	// Look up field definition
	const [field] = await db
		.select({
			id: customFieldDefinitions.id,
			workspaceId: customFieldDefinitions.workspaceId,
		})
		.from(customFieldDefinitions)
		.where(
			and(
				eq(customFieldDefinitions.organizationId, orgId),
				eq(customFieldDefinitions.slug, slug),
			),
		)
		.limit(1);

	if (!field) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: `Custom field "${slug}" not found`,
				},
			},
			404,
		);
	}
	if (field.workspaceId !== null && field.workspaceId !== contact.workspaceId) {
		return c.json(
			{
				error: {
					code: "WORKSPACE_MISMATCH",
					message:
						"A workspace field can only be used by contacts in that workspace.",
				},
			},
			400,
		);
	}

	await db
		.delete(customFieldValues)
		.where(
			and(
				eq(customFieldValues.definitionId, field.id),
				eq(customFieldValues.contactId, id),
			),
		);

	return c.body(null, 204);
});

export { app as contactsRouter };
