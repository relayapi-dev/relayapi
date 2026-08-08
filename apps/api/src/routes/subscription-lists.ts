import { createRoute, OpenAPIHono, type z } from "@hono/zod-openapi";
import {
	contactSubscriptions,
	contacts,
	subscriptionLists,
} from "@relayapi/db";
import { and, desc, eq, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import {
	decodeTimestampIdCursor,
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
	type TimestampIdCursor,
} from "../lib/pagination-cursor";
import { resolveOperationalCreateScope } from "../lib/request-access";
import {
	applyWorkspaceScope,
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
} from "../lib/workspace-scope";
import { ErrorResponse } from "../schemas/common";
import {
	AddSubscriptionMemberSpec,
	SubscriptionListCreateSpec,
	SubscriptionListIdParams,
	SubscriptionListListQuery,
	SubscriptionListListResponse,
	SubscriptionListResponse,
	SubscriptionListUpdateSpec,
	SubscriptionMemberListQuery,
	SubscriptionMemberListResponse,
	SubscriptionMemberParams,
	SubscriptionMemberResponse,
} from "../schemas/subscription-lists";
import { transitionContactSubscription } from "../services/contact-subscription-transitions";
import {
	decryptContactRow,
	decryptContactRows,
} from "../services/contact-protection";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

type ListRow = typeof subscriptionLists.$inferSelect;
type MembershipRow = typeof contactSubscriptions.$inferSelect;
interface ContactSummary {
	id: string;
	name: string | null;
	email: string | null;
	phone: string | null;
}

function serializeList(row: ListRow): z.infer<typeof SubscriptionListResponse> {
	return {
		id: row.id,
		organization_id: row.organizationId,
		workspace_id: row.workspaceId,
		name: row.name,
		channel: row.channel,
		description: row.description,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

function serializeMember(
	membership: MembershipRow,
	contact: ContactSummary,
	channel: ListRow["channel"],
): z.infer<typeof SubscriptionMemberResponse> {
	return {
		list_id: membership.listId,
		channel,
		contact_id: membership.contactId,
		contact: {
			id: contact.id,
			name: contact.name,
			email: contact.email,
			phone: contact.phone,
		},
		status: membership.unsubscribedAt === null ? "active" : "unsubscribed",
		source: membership.source,
		subscribed_at: membership.subscribedAt.toISOString(),
		unsubscribed_at: membership.unsubscribedAt?.toISOString() ?? null,
		updated_at: membership.updatedAt.toISOString(),
	};
}

function decodeCursor(cursor?: string): TimestampIdCursor | null {
	return cursor ? decodeTimestampIdCursor(cursor) : null;
}

async function loadList(
	db: Variables["db"],
	organizationId: string,
	id: string,
): Promise<ListRow | undefined> {
	const [row] = await db
		.select()
		.from(subscriptionLists)
		.where(
			and(
				eq(subscriptionLists.id, id),
				eq(subscriptionLists.organizationId, organizationId),
			),
		)
		.limit(1);
	return row;
}

const createList = createRoute({
	operationId: "createSubscriptionList",
	method: "post",
	path: "/",
	tags: ["Subscription Lists"],
	summary: "Create a channel-scoped subscription list",
	description:
		"Creates an audience definition. Membership in the list does not grant channel or purpose consent.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: SubscriptionListCreateSpec },
			},
		},
	},
	responses: {
		201: {
			description: "Subscription list created",
			content: { "application/json": { schema: SubscriptionListResponse } },
		},
		400: {
			description: "Invalid scope or request",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createList, async (c) => {
	const db = c.get("db");
	const organizationId = c.get("orgId");
	const body = c.req.valid("json");
	const scope = await resolveOperationalCreateScope(
		c,
		body.workspace_id,
		"subscription list",
	);
	if (!scope.ok) return scope.response as never;

	const [row] = await db
		.insert(subscriptionLists)
		.values({
			organizationId,
			workspaceId: scope.workspaceId,
			name: body.name,
			channel: body.channel,
			description: body.description,
		})
		.returning();
	if (!row) throw new Error("Failed to create subscription list");
	return c.json(serializeList(row), 201);
});

const listLists = createRoute({
	operationId: "listSubscriptionLists",
	method: "get",
	path: "/",
	tags: ["Subscription Lists"],
	summary: "List subscription lists",
	security: [{ Bearer: [] }],
	request: { query: SubscriptionListListQuery },
	responses: {
		200: {
			description: "Subscription lists",
			content: {
				"application/json": { schema: SubscriptionListListResponse },
			},
		},
		400: {
			description: "Invalid cursor",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listLists, async (c) => {
	const db = c.get("db");
	const organizationId = c.get("orgId");
	const { cursor, limit, workspace_id, channel } = c.req.valid("query");
	let decodedCursor: TimestampIdCursor | null;
	try {
		decodedCursor = decodeCursor(cursor);
	} catch {
		return c.json(INVALID_CURSOR_BODY, 400);
	}

	const conditions: SQL[] = [
		eq(subscriptionLists.organizationId, organizationId),
	];
	applyWorkspaceScope(c, conditions, subscriptionLists.workspaceId);
	if (workspace_id) {
		conditions.push(eq(subscriptionLists.workspaceId, workspace_id));
	}
	if (channel) conditions.push(eq(subscriptionLists.channel, channel));
	if (decodedCursor) {
		conditions.push(
			sql`(${subscriptionLists.createdAt}, ${subscriptionLists.id})
				< (${decodedCursor.timestamp}::timestamptz, ${decodedCursor.id})`,
		);
	}

	const rows = await db
		.select({
			id: subscriptionLists.id,
			organizationId: subscriptionLists.organizationId,
			workspaceId: subscriptionLists.workspaceId,
			scopeKey: subscriptionLists.scopeKey,
			name: subscriptionLists.name,
			channel: subscriptionLists.channel,
			description: subscriptionLists.description,
			createdAt: subscriptionLists.createdAt,
			updatedAt: subscriptionLists.updatedAt,
			cursorTimestamp: sql<string>`to_char(${subscriptionLists.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(subscriptionLists)
		.where(and(...conditions))
		.orderBy(desc(subscriptionLists.createdAt), desc(subscriptionLists.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return c.json(
		{
			data: page.map(serializeList),
			next_cursor:
				hasMore && last
					? encodeTimestampIdCursor(last.cursorTimestamp, last.id)
					: null,
			has_more: hasMore,
		},
		200,
	);
});

const getList = createRoute({
	operationId: "getSubscriptionList",
	method: "get",
	path: "/{id}",
	tags: ["Subscription Lists"],
	summary: "Get a subscription list",
	security: [{ Bearer: [] }],
	request: { params: SubscriptionListIdParams },
	responses: {
		200: {
			description: "Subscription list",
			content: { "application/json": { schema: SubscriptionListResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Subscription list not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getList, async (c) => {
	const row = await loadList(
		c.get("db"),
		c.get("orgId"),
		c.req.valid("param").id,
	);
	if (!row) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Subscription list not found",
				},
			},
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	return c.json(serializeList(row), 200);
});

const updateList = createRoute({
	operationId: "updateSubscriptionList",
	method: "patch",
	path: "/{id}",
	tags: ["Subscription Lists"],
	summary: "Update a subscription list",
	description:
		"The channel is immutable because changing it would change the consent authority required for every member.",
	security: [{ Bearer: [] }],
	request: {
		params: SubscriptionListIdParams,
		body: {
			content: {
				"application/json": { schema: SubscriptionListUpdateSpec },
			},
		},
	},
	responses: {
		200: {
			description: "Subscription list updated",
			content: { "application/json": { schema: SubscriptionListResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Subscription list not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateList, async (c) => {
	const db = c.get("db");
	const organizationId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const existing = await loadList(db, organizationId, id);
	if (!existing) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Subscription list not found",
				},
			},
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, existing.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	if (body.name === undefined && body.description === undefined) {
		return c.json(serializeList(existing), 200);
	}
	const [updated] = await db
		.update(subscriptionLists)
		.set({
			...(body.name !== undefined ? { name: body.name } : {}),
			...(body.description !== undefined
				? { description: body.description }
				: {}),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(subscriptionLists.id, id),
				eq(subscriptionLists.organizationId, organizationId),
			),
		)
		.returning();
	if (!updated) throw new Error("Failed to update subscription list");
	return c.json(serializeList(updated), 200);
});

const deleteList = createRoute({
	operationId: "deleteSubscriptionList",
	method: "delete",
	path: "/{id}",
	tags: ["Subscription Lists"],
	summary: "Delete a subscription list",
	security: [{ Bearer: [] }],
	request: { params: SubscriptionListIdParams },
	responses: {
		204: { description: "Subscription list deleted" },
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Subscription list not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteList, async (c) => {
	const db = c.get("db");
	const organizationId = c.get("orgId");
	const { id } = c.req.valid("param");
	const existing = await loadList(db, organizationId, id);
	if (!existing) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Subscription list not found",
				},
			},
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, existing.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	await db
		.delete(subscriptionLists)
		.where(
			and(
				eq(subscriptionLists.id, id),
				eq(subscriptionLists.organizationId, organizationId),
			),
		);
	return c.body(null, 204);
});

const listMembers = createRoute({
	operationId: "listSubscriptionListMembers",
	method: "get",
	path: "/{id}/members",
	tags: ["Subscription Lists"],
	summary: "List current and/or unsubscribed list members",
	description:
		"Returns list membership state only. Delivery still requires current channel and purpose consent at send time.",
	security: [{ Bearer: [] }],
	request: {
		params: SubscriptionListIdParams,
		query: SubscriptionMemberListQuery,
	},
	responses: {
		200: {
			description: "Subscription-list members",
			content: {
				"application/json": { schema: SubscriptionMemberListResponse },
			},
		},
		400: {
			description: "Invalid cursor",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Subscription list not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listMembers, async (c) => {
	const db = c.get("db");
	const organizationId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { cursor, limit, status } = c.req.valid("query");
	let decodedCursor: TimestampIdCursor | null;
	try {
		decodedCursor = decodeCursor(cursor);
	} catch {
		return c.json(INVALID_CURSOR_BODY, 400);
	}

	const list = await loadList(db, organizationId, id);
	if (!list) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Subscription list not found",
				},
			},
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, list.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	const conditions: SQL[] = [
		eq(contactSubscriptions.organizationId, organizationId),
		eq(contactSubscriptions.listId, id),
	];
	if (status === "active") {
		conditions.push(isNull(contactSubscriptions.unsubscribedAt));
	} else if (status === "unsubscribed") {
		conditions.push(isNotNull(contactSubscriptions.unsubscribedAt));
	}
	if (decodedCursor) {
		conditions.push(
			sql`(${contactSubscriptions.updatedAt}, ${contactSubscriptions.contactId})
				< (${decodedCursor.timestamp}::timestamptz, ${decodedCursor.id})`,
		);
	}

	const rows = await db
		.select({
			membership: contactSubscriptions,
			contact: {
				id: contacts.id,
				organizationId: contacts.organizationId,
				nameCiphertext: contacts.nameCiphertext,
				emailCiphertext: contacts.emailCiphertext,
				phoneCiphertext: contacts.phoneCiphertext,
				metadataCiphertext: contacts.metadataCiphertext,
				searchIdentityKeyFingerprint:
					contacts.searchIdentityKeyFingerprint,
			},
			cursorTimestamp: sql<string>`to_char(${contactSubscriptions.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(contactSubscriptions)
		.innerJoin(
			contacts,
			and(
				eq(contacts.id, contactSubscriptions.contactId),
				eq(contacts.organizationId, contactSubscriptions.organizationId),
				eq(contacts.scopeKey, contactSubscriptions.scopeKey),
			),
		)
		.where(and(...conditions))
		.orderBy(
			desc(contactSubscriptions.updatedAt),
			desc(contactSubscriptions.contactId),
		)
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	const plaintextContacts = await decryptContactRows(
		c.env.ENCRYPTION_KEY,
		page.map(({ contact }) => contact),
	);
	return c.json(
		{
			data: page.map((row, index) =>
				serializeMember(
					row.membership,
					plaintextContacts[index] as ContactSummary,
					list.channel,
				),
			),
			next_cursor:
				hasMore && last
					? encodeTimestampIdCursor(
							last.cursorTimestamp,
							last.membership.contactId,
						)
					: null,
			has_more: hasMore,
		},
		200,
	);
});

const addMember = createRoute({
	operationId: "addSubscriptionListMember",
	method: "post",
	path: "/{id}/members",
	tags: ["Subscription Lists"],
	summary: "Add or re-add a list member",
	description:
		"Re-adding an unsubscribed contact opens a new membership interval and preserves the previous transition in immutable history. No consent is granted.",
	security: [{ Bearer: [] }],
	request: {
		params: SubscriptionListIdParams,
		body: {
			content: {
				"application/json": { schema: AddSubscriptionMemberSpec },
			},
		},
	},
	responses: {
		200: {
			description: "Member is active",
			content: {
				"application/json": { schema: SubscriptionMemberResponse },
			},
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Subscription list or contact not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(addMember, async (c) => {
	const db = c.get("db");
	const organizationId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { contact_id } = c.req.valid("json");
	const list = await loadList(db, organizationId, id);
	if (!list) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Subscription list not found",
				},
			},
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, list.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	const [contact] = await db
		.select()
		.from(contacts)
		.where(
			and(
				eq(contacts.id, contact_id),
				eq(contacts.organizationId, organizationId),
				eq(contacts.scopeKey, list.scopeKey),
			),
		)
		.limit(1);
	if (!contact) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Contact not found in the subscription list scope",
				},
			},
			404,
		);
	}
	const plaintextContact = await decryptContactRow(
		c.env.ENCRYPTION_KEY,
		contact,
	);

	const result = await transitionContactSubscription(db, {
		organizationId,
		scopeKey: list.scopeKey,
		contactId: contact.id,
		listId: list.id,
		type: "subscribed",
		source: "api",
		actorId: c.get("keyId"),
	});
	return c.json(
		serializeMember(result.membership, plaintextContact, list.channel),
		200,
	);
});

const unsubscribeMember = createRoute({
	operationId: "unsubscribeSubscriptionListMember",
	method: "delete",
	path: "/{id}/members/{contact_id}",
	tags: ["Subscription Lists"],
	summary: "Unsubscribe a list member",
	description:
		"Closes the current list-membership interval without deleting history or changing consent.",
	security: [{ Bearer: [] }],
	request: { params: SubscriptionMemberParams },
	responses: {
		204: { description: "Member is unsubscribed" },
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Subscription list or contact not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(unsubscribeMember, async (c) => {
	const db = c.get("db");
	const organizationId = c.get("orgId");
	const { id, contact_id } = c.req.valid("param");
	const list = await loadList(db, organizationId, id);
	if (!list) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Subscription list not found",
				},
			},
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, list.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	const [contact] = await db
		.select({ id: contacts.id })
		.from(contacts)
		.where(
			and(
				eq(contacts.id, contact_id),
				eq(contacts.organizationId, organizationId),
				eq(contacts.scopeKey, list.scopeKey),
			),
		)
		.limit(1);
	if (!contact) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Contact not found in the subscription list scope",
				},
			},
			404,
		);
	}

	await transitionContactSubscription(db, {
		organizationId,
		scopeKey: list.scopeKey,
		contactId: contact.id,
		listId: list.id,
		type: "unsubscribed",
		source: "api",
		actorId: c.get("keyId"),
	});
	return c.body(null, 204);
});

export default app;
