import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	createDb,
	contacts,
	contactChannels,
	customFieldDefinitions,
	customFieldValues,
	broadcastRecipients,
	sequenceEnrollments,
	inboxConversations,
} from "@relayapi/db";
import { and, eq, ilike, inArray, sql, desc, or } from "drizzle-orm";
import { ErrorResponse } from "../schemas/common";
import {
	ContactResponse,
	ContactListResponse,
	ContactIdParams,
	ChannelIdParams,
	ContactFieldParams,
	ContactQuery,
	CreateContactBody,
	UpdateContactBody,
	AddChannelBody,
	ChannelResponse,
	BulkCreateContactsBody,
	BulkCreateContactsResponse,
	BulkOperationsBody,
	BulkOperationsResponse,
	MergeContactBody,
	MergeContactResponse,
	SetContactFieldBody,
	SetContactFieldResponse,
} from "../schemas/contacts";
import type { Env, Variables } from "../types";
import { assertScopedCreateWorkspace } from "../lib/request-access";
import { applyWorkspaceScope, assertWorkspaceScope } from "../lib/workspace-scope";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Helpers ---

function serializeContact(
	c: {
		id: string;
		name: string | null;
		email: string | null;
		phone: string | null;
		tags: string[];
		optedIn: boolean;
		createdAt: Date;
	},
	channels: (typeof contactChannels.$inferSelect)[] = [],
) {
	return {
		id: c.id,
		name: c.name ?? null,
		email: c.email ?? null,
		phone: c.phone ?? null,
		tags: c.tags,
		opted_in: c.optedIn,
		channels: channels.map(serializeChannel),
		created_at: c.createdAt.toISOString(),
	};
}

function serializeChannel(ch: typeof contactChannels.$inferSelect) {
	return {
		id: ch.id,
		social_account_id: ch.socialAccountId,
		platform: ch.platform,
		identifier: ch.identifier,
		created_at: ch.createdAt.toISOString(),
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

// 9. Bulk create contacts
const bulkCreate = createRoute({
	operationId: "bulkCreateContacts",
	method: "post",
	path: "/bulk",
	tags: ["Contacts"],
	summary: "Bulk create up to 1000 contacts",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: BulkCreateContactsBody } } },
	},
	responses: {
		200: {
			description: "Bulk create result",
			content: { "application/json": { schema: BulkCreateContactsResponse } },
		},
	},
});

// 10. Bulk operations (add_tags, remove_tags, delete)
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

// 11. Merge contacts
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
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// 12. Set custom field value
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

// 13. Clear custom field value
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
	const { workspace_id, search, tag, platform, account_id, cursor, limit } =
		c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(contacts.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, contacts.workspaceId);

	if (workspace_id) {
		conditions.push(eq(contacts.workspaceId, workspace_id));
	}

	if (search) {
		const escaped = search.replace(/[%_\\]/g, "\\$&");
		conditions.push(
			or(
				ilike(contacts.name, `%${escaped}%`),
				ilike(contacts.phone, `%${escaped}%`),
				ilike(contacts.email, `%${escaped}%`),
			)!,
		);
	}

	if (tag) {
		conditions.push(sql`${tag} = ANY(${contacts.tags})`);
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
		const [cursorRow] = await db
			.select({ createdAt: contacts.createdAt })
			.from(contacts)
			.where(eq(contacts.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${contacts.createdAt} < ${cursorRow.createdAt} OR (${contacts.createdAt} = ${cursorRow.createdAt} AND ${contacts.id} < ${cursor}))`,
			);
		}
	}

	const rows = await db
		.select({
			id: contacts.id,
			name: contacts.name,
			email: contacts.email,
			phone: contacts.phone,
			tags: contacts.tags,
			optedIn: contacts.optedIn,
			createdAt: contacts.createdAt,
		})
		.from(contacts)
		.where(and(...conditions))
		.orderBy(desc(contacts.createdAt), desc(contacts.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	// Load channels for all returned contacts
	const contactIds = data.map((ct) => ct.id);
	const channels =
			contactIds.length > 0
				? await db
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
				: [];

	const channelsByContact = new Map<
		string,
		(typeof contactChannels.$inferSelect)[]
	>();
	for (const ch of channels) {
		const list = channelsByContact.get(ch.contactId) ?? [];
		list.push(ch);
		channelsByContact.set(ch.contactId, list);
	}

	return c.json(
		{
			data: data.map((ct) =>
				serializeContact(ct, channelsByContact.get(ct.id) ?? []),
			),
			next_cursor:
				hasMore && data.length > 0 ? data[data.length - 1]!.id : null,
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
	const denied = assertScopedCreateWorkspace(c, body.workspace_id, "contact");
	if (denied) return denied;

	const [contact] = await db
		.insert(contacts)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id,
			name: body.name ?? null,
			email: body.email ?? null,
			phone: body.phone ?? null,
			tags: body.tags ?? [],
			optedIn: body.opted_in ?? true,
			metadata: body.metadata ?? null,
		})
		.returning();

	if (!contact) {
		return c.json(
			{ error: { code: "INTERNAL_ERROR", message: "Failed to create contact" } },
			500,
		);
	}

	// If channel info provided, create the first channel
	let channelRows: (typeof contactChannels.$inferSelect)[] = [];
	if (body.account_id && body.platform && body.identifier) {
		try {
			const [ch] = await db
				.insert(contactChannels)
				.values({
					contactId: contact.id,
					socialAccountId: body.account_id,
					platform: body.platform,
					identifier: body.identifier,
				})
				.returning();
			if (ch) channelRows = [ch];
		} catch {
			// Duplicate channel — skip silently
		}
	}

	return c.json(serializeContact(contact, channelRows), 201);
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
		.where(
			and(eq(contacts.id, id), eq(contacts.organizationId, orgId)),
		)
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
		.where(eq(contactChannels.contactId, contact.id));

	return c.json(serializeContact(contact, channels), 200);
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

	const [updated] = await db
		.update(contacts)
		.set(updateSet)
		.where(eq(contacts.id, id))
		.returning();

	if (!updated) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}

	const channels = await db
		.select()
		.from(contactChannels)
		.where(eq(contactChannels.contactId, updated.id));

	return c.json(serializeContact(updated, channels), 200);
});

// 5. Delete contact
app.openapi(deleteContact, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select({ id: contacts.id, workspaceId: contacts.workspaceId })
		.from(contacts)
		.where(
			and(eq(contacts.id, id), eq(contacts.organizationId, orgId)),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

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
		.where(
			and(eq(contacts.id, id), eq(contacts.organizationId, orgId)),
		)
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
		.where(
			and(eq(contacts.id, id), eq(contacts.organizationId, orgId)),
		)
		.limit(1);

	if (!contact) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, contact.workspaceId);
	if (denied) return denied;

	try {
		const [ch] = await db
			.insert(contactChannels)
			.values({
				contactId: id,
				socialAccountId: body.account_id,
				platform: body.platform,
				identifier: body.identifier,
			})
			.returning();

		return c.json(serializeChannel(ch!), 201);
	} catch {
		return c.json(
			{ error: { code: "CONFLICT", message: "Channel already exists for this account and identifier" } },
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
		.where(
			and(eq(contacts.id, id), eq(contacts.organizationId, orgId)),
		)
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
			and(
				eq(contactChannels.id, channelId),
				eq(contactChannels.contactId, id),
			),
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

// 9. Bulk create contacts
// @ts-expect-error — handler may return 400/403 from scoped workspace checks
app.openapi(bulkCreate, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");
	const denied = assertScopedCreateWorkspace(c, body.workspace_id, "contact");
	if (denied) return denied;

	let created = 0;
	let skipped = 0;

	const batchSize = 500;
	for (let i = 0; i < body.contacts.length; i += batchSize) {
		const batch = body.contacts.slice(i, i + batchSize);
		const values = batch.map((item) => ({
			organizationId: orgId,
			workspaceId: body.workspace_id,
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

		const insertedIds = result.map((r) => r.id);
		created += insertedIds.length;

		// Insert channels for contacts that have channel info
		for (let j = 0; j < batch.length; j++) {
			const item = batch[j]!;
			const contactId = insertedIds[j];
			if (contactId && item.account_id && item.platform && item.identifier) {
				try {
					await db.insert(contactChannels).values({
						contactId,
						socialAccountId: item.account_id,
						platform: item.platform,
						identifier: item.identifier,
					});
				} catch {
					// Duplicate channel — skip
				}
			}
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

	// Verify both contacts belong to this org
	const [target] = await db
		.select({ id: contacts.id, workspaceId: contacts.workspaceId })
		.from(contacts)
		.where(
			and(eq(contacts.id, targetId), eq(contacts.organizationId, orgId)),
		)
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
		.where(
			and(eq(contacts.id, sourceId), eq(contacts.organizationId, orgId)),
		)
		.limit(1);

	if (!source) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Source contact not found" } },
			404,
		);
	}

	const sourceDenied = assertWorkspaceScope(c, source.workspaceId);
	if (sourceDenied) return sourceDenied;

	// Move channels from source to target (skip duplicates)
	let channelsMoved = 0;
	const sourceChannels = await db
		.select()
		.from(contactChannels)
		.where(eq(contactChannels.contactId, sourceId));

	for (const ch of sourceChannels) {
		try {
			await db
				.update(contactChannels)
				.set({ contactId: targetId })
				.where(eq(contactChannels.id, ch.id));
			channelsMoved++;
		} catch {
			// Duplicate unique constraint — delete the source channel instead
			await db.delete(contactChannels).where(eq(contactChannels.id, ch.id));
		}
	}

	// Move custom field values from source to target (skip duplicates)
	let fieldsMoved = 0;
	const sourceFields = await db
		.select()
		.from(customFieldValues)
		.where(eq(customFieldValues.contactId, sourceId));

	for (const fv of sourceFields) {
		try {
			await db
				.update(customFieldValues)
				.set({ contactId: targetId })
				.where(eq(customFieldValues.id, fv.id));
			fieldsMoved++;
		} catch {
			// Duplicate — delete the source value
			await db.delete(customFieldValues).where(eq(customFieldValues.id, fv.id));
		}
	}

	// Update broadcast recipients from source to target
	const recipientResult = await db
		.update(broadcastRecipients)
		.set({ contactId: targetId })
		.where(eq(broadcastRecipients.contactId, sourceId))
		.returning({ id: broadcastRecipients.id });
	const recipientsUpdated = recipientResult.length;

	// Update sequence enrollments from source to target
	const enrollmentResult = await db
		.update(sequenceEnrollments)
		.set({ contactId: targetId })
		.where(eq(sequenceEnrollments.contactId, sourceId))
		.returning({ id: sequenceEnrollments.id });
	const enrollmentsUpdated = enrollmentResult.length;

	// Update inbox conversations from source to target
	const conversationResult = await db
		.update(inboxConversations)
		.set({ contactId: targetId })
		.where(eq(inboxConversations.contactId, sourceId))
		.returning({ id: inboxConversations.id });
	const conversationsUpdated = conversationResult.length;

	// Delete the source contact
	await db.delete(contacts).where(eq(contacts.id, sourceId));

	return c.json(
		{
			channels_moved: channelsMoved,
			fields_moved: fieldsMoved,
			recipients_updated: recipientsUpdated,
			enrollments_updated: enrollmentsUpdated,
			conversations_updated: conversationsUpdated,
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
		.where(
			and(eq(contacts.id, id), eq(contacts.organizationId, orgId)),
		)
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
			{ error: { code: "NOT_FOUND", message: `Custom field "${slug}" not found` } },
			404,
		);
	}

	// Validate value against field type
	const strValue = String(value);
	switch (field.type) {
		case "number":
			if (Number.isNaN(Number(value))) {
				return c.json(
					{ error: { code: "VALIDATION_ERROR", message: "Value must be a valid number" } },
					400,
				);
			}
			break;
		case "boolean":
			if (strValue !== "true" && strValue !== "false") {
				return c.json(
					{ error: { code: "VALIDATION_ERROR", message: "Value must be true or false" } },
					400,
				);
			}
			break;
		case "date":
			if (Number.isNaN(Date.parse(strValue))) {
				return c.json(
					{ error: { code: "VALIDATION_ERROR", message: "Value must be a valid ISO 8601 date" } },
					400,
				);
			}
			break;
		case "select": {
			const options = (field.options as string[] | null) ?? [];
			if (!options.includes(strValue)) {
				return c.json(
					{ error: { code: "VALIDATION_ERROR", message: `Value must be one of: ${options.join(", ")}` } },
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
		.where(
			and(eq(contacts.id, id), eq(contacts.organizationId, orgId)),
		)
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
		.select({ id: customFieldDefinitions.id })
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
			{ error: { code: "NOT_FOUND", message: `Custom field "${slug}" not found` } },
			404,
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
