import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
	createDb,
	socialAccounts,
	broadcasts,
	broadcastRecipients,
	contacts,
	contactChannels,
} from "@relayapi/db";
import { and, eq, desc, inArray, sql, lte, count } from "drizzle-orm";
import { maybeDecrypt } from "../lib/crypto";
import { sendMessage } from "../services/message-sender";
import { ErrorResponse } from "../schemas/common";
import {
	AddRecipientsBody,
	AddRecipientsResponse,
	BroadcastIdParams,
	BroadcastListQuery,
	BroadcastListResponse,
	BroadcastResponse,
	CreateBroadcastBody,
	RecipientListQuery,
	RecipientListResponse,
	RecipientResponse,
	ScheduleBroadcastBody,
	UpdateBroadcastBody,
} from "../schemas/broadcasts";
import type { Env, Variables } from "../types";
import { applyWorkspaceScope, assertWorkspaceScope } from "../lib/workspace-scope";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

type BroadcastStatus =
	| "draft"
	| "scheduled"
	| "sending"
	| "sent"
	| "partially_failed"
	| "failed"
	| "cancelled";

// ---------------------------------------------------------------------------
// Helper: serialise a broadcast row to API response
// ---------------------------------------------------------------------------

function serializeBroadcast(b: typeof broadcasts.$inferSelect) {
	return {
		id: b.id,
		name: b.name ?? null,
		description: b.description ?? null,
		platform: b.platform,
		account_id: b.socialAccountId,
		status: b.status as BroadcastStatus,
		message_text: b.messageText ?? null,
		template_name: b.templateName ?? null,
		template_language: b.templateLanguage ?? null,
		recipient_count: b.recipientCount,
		sent_count: b.sentCount,
		failed_count: b.failedCount,
		scheduled_at: b.scheduledAt?.toISOString() ?? null,
		completed_at: b.completedAt?.toISOString() ?? null,
		created_at: b.createdAt.toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Helper: look up a social account + decrypt token
// ---------------------------------------------------------------------------

async function getAccount(
	db: ReturnType<typeof createDb>,
	accountId: string,
	orgId: string,
	encryptionKey?: string,
	workspaceScope: "all" | string[] = "all",
) {
	const [account] = await db
		.select()
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, accountId),
				eq(socialAccounts.organizationId, orgId),
			),
		)
		.limit(1);
	if (!account) return null;
	if (workspaceScope !== "all") {
		if (!account.workspaceId || !workspaceScope.includes(account.workspaceId)) {
			return null;
		}
	}
	return {
		...account,
		accessToken: await maybeDecrypt(account.accessToken, encryptionKey),
	};
}

// =====================
// Route definitions
// =====================

const createBroadcast = createRoute({
	operationId: "createBroadcast",
	method: "post",
	path: "/",
	tags: ["Broadcasts"],
	summary: "Create a broadcast draft",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: CreateBroadcastBody } } },
	},
	responses: {
		201: {
			description: "Broadcast created",
			content: { "application/json": { schema: BroadcastResponse } },
		},
		404: {
			description: "Account not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const listBroadcasts = createRoute({
	operationId: "listBroadcasts",
	method: "get",
	path: "/",
	tags: ["Broadcasts"],
	summary: "List broadcasts",
	security: [{ Bearer: [] }],
	request: { query: BroadcastListQuery },
	responses: {
		200: {
			description: "Broadcasts list",
			content: { "application/json": { schema: BroadcastListResponse } },
		},
	},
});

const getBroadcast = createRoute({
	operationId: "getBroadcast",
	method: "get",
	path: "/{id}",
	tags: ["Broadcasts"],
	summary: "Get broadcast details",
	security: [{ Bearer: [] }],
	request: { params: BroadcastIdParams },
	responses: {
		200: {
			description: "Broadcast details",
			content: { "application/json": { schema: BroadcastResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const updateBroadcast = createRoute({
	operationId: "updateBroadcast",
	method: "patch",
	path: "/{id}",
	tags: ["Broadcasts"],
	summary: "Update a broadcast",
	security: [{ Bearer: [] }],
	request: {
		params: BroadcastIdParams,
		body: { content: { "application/json": { schema: UpdateBroadcastBody } } },
	},
	responses: {
		200: {
			description: "Broadcast updated",
			content: { "application/json": { schema: BroadcastResponse } },
		},
		400: {
			description: "Invalid status",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteBroadcast = createRoute({
	operationId: "deleteBroadcast",
	method: "delete",
	path: "/{id}",
	tags: ["Broadcasts"],
	summary: "Delete a broadcast (draft or cancelled only)",
	security: [{ Bearer: [] }],
	request: { params: BroadcastIdParams },
	responses: {
		204: { description: "Deleted" },
		400: {
			description: "Invalid status",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const addRecipients = createRoute({
	operationId: "addBroadcastRecipients",
	method: "post",
	path: "/{id}/recipients",
	tags: ["Broadcasts"],
	summary: "Add recipients to a broadcast",
	security: [{ Bearer: [] }],
	request: {
		params: BroadcastIdParams,
		body: { content: { "application/json": { schema: AddRecipientsBody } } },
	},
	responses: {
		200: {
			description: "Recipients added",
			content: { "application/json": { schema: AddRecipientsResponse } },
		},
		400: {
			description: "Invalid status or no recipients",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const listRecipients = createRoute({
	operationId: "listBroadcastRecipients",
	method: "get",
	path: "/{id}/recipients",
	tags: ["Broadcasts"],
	summary: "List broadcast recipients",
	security: [{ Bearer: [] }],
	request: {
		params: BroadcastIdParams,
		query: RecipientListQuery,
	},
	responses: {
		200: {
			description: "Recipients list",
			content: { "application/json": { schema: RecipientListResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const sendBroadcastRoute = createRoute({
	operationId: "sendBroadcast",
	method: "post",
	path: "/{id}/send",
	tags: ["Broadcasts"],
	summary: "Trigger immediate send",
	security: [{ Bearer: [] }],
	request: { params: BroadcastIdParams },
	responses: {
		200: {
			description: "Send result",
			content: { "application/json": { schema: BroadcastResponse } },
		},
		400: {
			description: "Invalid status",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const scheduleBroadcastRoute = createRoute({
	operationId: "scheduleBroadcast",
	method: "post",
	path: "/{id}/schedule",
	tags: ["Broadcasts"],
	summary: "Schedule broadcast for later",
	security: [{ Bearer: [] }],
	request: {
		params: BroadcastIdParams,
		body: {
			content: { "application/json": { schema: ScheduleBroadcastBody } },
		},
	},
	responses: {
		200: {
			description: "Broadcast scheduled",
			content: { "application/json": { schema: BroadcastResponse } },
		},
		400: {
			description: "Invalid status or date",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const cancelBroadcast = createRoute({
	operationId: "cancelBroadcast",
	method: "post",
	path: "/{id}/cancel",
	tags: ["Broadcasts"],
	summary: "Cancel a broadcast",
	security: [{ Bearer: [] }],
	request: { params: BroadcastIdParams },
	responses: {
		200: {
			description: "Broadcast cancelled",
			content: { "application/json": { schema: BroadcastResponse } },
		},
		400: {
			description: "Invalid status",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// =====================
// Handlers
// =====================

app.openapi(createBroadcast, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	// Validate account exists and belongs to org
	const account = await getAccount(db, body.account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Social account not found" } },
			404,
		);
	}

	const [row] = await db
		.insert(broadcasts)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			socialAccountId: account.id,
			platform: account.platform,
			name: body.name,
			description: body.description,
			messageText: body.message_text,
			templateName: body.template?.name,
			templateLanguage: body.template?.language,
			templateComponents: body.template?.components,
		})
		.returning();

	return c.json(serializeBroadcast(row!), 201);
});

app.openapi(listBroadcasts, async (c) => {
	const orgId = c.get("orgId");
	const { workspace_id, account_id, status, cursor, limit } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(broadcasts.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, broadcasts.workspaceId);
	if (workspace_id) conditions.push(eq(broadcasts.workspaceId, workspace_id));
	if (account_id) conditions.push(eq(broadcasts.socialAccountId, account_id));
	if (status) conditions.push(eq(broadcasts.status, status));

	// Cursor pagination (composite: createdAt DESC, id DESC to handle timestamp ties)
	if (cursor) {
		const [cursorRow] = await db
			.select({ createdAt: broadcasts.createdAt })
			.from(broadcasts)
			.where(eq(broadcasts.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${broadcasts.createdAt} < ${cursorRow.createdAt} OR (${broadcasts.createdAt} = ${cursorRow.createdAt} AND ${broadcasts.id} < ${cursor}))`,
			);
		}
	}

	const rows = await db
		.select()
		.from(broadcasts)
		.where(and(...conditions))
		.orderBy(desc(broadcasts.createdAt), desc(broadcasts.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit).map(serializeBroadcast);

	return c.json({
		data,
		next_cursor: hasMore ? data[data.length - 1]!.id : null,
		has_more: hasMore,
	});
});

// @ts-expect-error — Hono strict return types
app.openapi(getBroadcast, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [row] = await db
		.select()
		.from(broadcasts)
		.where(and(eq(broadcasts.id, id), eq(broadcasts.organizationId, orgId)))
		.limit(1);

	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Broadcast not found" } },
			404,
		);
	}

	return c.json(serializeBroadcast(row));
});

// @ts-expect-error — Hono strict return types
app.openapi(updateBroadcast, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [existing] = await db
		.select()
		.from(broadcasts)
		.where(and(eq(broadcasts.id, id), eq(broadcasts.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Broadcast not found" } },
			404,
		);
	}

	if (existing.status !== "draft") {
		return c.json(
			{
				error: {
					code: "INVALID_STATUS",
					message: "Only draft broadcasts can be updated",
				},
			},
			400,
		);
	}

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (body.name !== undefined) updates.name = body.name;
	if (body.description !== undefined) updates.description = body.description;
	if (body.message_text !== undefined) updates.messageText = body.message_text;
	if (body.template) {
		updates.templateName = body.template.name;
		updates.templateLanguage = body.template.language;
		if (body.template.components) updates.templateComponents = body.template.components;
	}

	const [updated] = await db
		.update(broadcasts)
		.set(updates)
		.where(eq(broadcasts.id, id))
		.returning();

	return c.json(serializeBroadcast(updated!));
});

app.openapi(deleteBroadcast, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select({ status: broadcasts.status, workspaceId: broadcasts.workspaceId })
		.from(broadcasts)
		.where(and(eq(broadcasts.id, id), eq(broadcasts.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Broadcast not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	if (existing.status !== "draft" && existing.status !== "cancelled") {
		return c.json(
			{
				error: {
					code: "INVALID_STATUS",
					message: "Only draft or cancelled broadcasts can be deleted",
				},
			},
			400,
		);
	}

	await db.delete(broadcasts).where(eq(broadcasts.id, id));
	return c.body(null, 204);
});

// @ts-expect-error — Hono strict return types
app.openapi(addRecipients, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [broadcast] = await db
		.select()
		.from(broadcasts)
		.where(and(eq(broadcasts.id, id), eq(broadcasts.organizationId, orgId)))
		.limit(1);

	if (!broadcast) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Broadcast not found" } },
			404,
		);
	}

	if (broadcast.status !== "draft" && broadcast.status !== "scheduled") {
		return c.json(
			{
				error: {
					code: "INVALID_STATUS",
					message: "Can only add recipients to draft or scheduled broadcasts",
				},
			},
			400,
		);
	}

	// Collect all identifiers to insert
	const toInsert: Array<{
		contactId: string | null;
		contactIdentifier: string;
	}> = [];

	// From raw phone numbers (WhatsApp)
	if (body.phones?.length) {
		for (const phone of body.phones) {
			toInsert.push({ contactId: null, contactIdentifier: phone });
		}
	}

	// From raw platform identifiers
	if (body.identifiers?.length) {
		for (const identifier of body.identifiers) {
			toInsert.push({ contactId: null, contactIdentifier: identifier });
		}
	}

	// From contact IDs — resolve to platform identifiers via contact channels
	if (body.contact_ids?.length) {
		const contactRows = await db
			.select({
				id: contacts.id,
				identifier: contactChannels.identifier,
			})
			.from(contacts)
			.innerJoin(contactChannels, eq(contactChannels.contactId, contacts.id))
			.where(
				and(
					eq(contacts.organizationId, orgId),
					inArray(contacts.id, body.contact_ids),
					eq(contactChannels.socialAccountId, broadcast.socialAccountId),
				),
			);

		for (const row of contactRows) {
			toInsert.push({
				contactId: row.id,
				contactIdentifier: row.identifier,
			});
		}
	}

	if (toInsert.length === 0) {
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message: "No recipients provided. Supply phones, contact_ids, or identifiers.",
				},
			},
			400,
		);
	}

	let added = 0;
	let skipped = 0;

	for (const item of toInsert) {
		try {
			await db.insert(broadcastRecipients).values({
				broadcastId: id,
				contactId: item.contactId,
				contactIdentifier: item.contactIdentifier,
			});
			added++;
		} catch {
			// Unique constraint violation = duplicate
			skipped++;
		}
	}

	// Update recipient count
	if (added > 0) {
		await db
			.update(broadcasts)
			.set({
				recipientCount: sql`${broadcasts.recipientCount} + ${added}`,
				updatedAt: new Date(),
			})
			.where(eq(broadcasts.id, id));
	}

	return c.json({ added, skipped });
});

// @ts-expect-error — Hono strict return types
app.openapi(listRecipients, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { status, cursor, limit } = c.req.valid("query");
	const db = c.get("db");

	// Verify broadcast exists and belongs to org
	const [broadcast] = await db
		.select({ id: broadcasts.id })
		.from(broadcasts)
		.where(and(eq(broadcasts.id, id), eq(broadcasts.organizationId, orgId)))
		.limit(1);

	if (!broadcast) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Broadcast not found" } },
			404,
		);
	}

	const conditions = [eq(broadcastRecipients.broadcastId, id)];
	if (status) conditions.push(eq(broadcastRecipients.status, status));

	if (cursor) {
		const [cursorRow] = await db
			.select({ id: broadcastRecipients.id })
			.from(broadcastRecipients)
			.where(eq(broadcastRecipients.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(sql`${broadcastRecipients.id} < ${cursorRow.id}`);
		}
	}

	const rows = await db
		.select()
		.from(broadcastRecipients)
		.where(and(...conditions))
		.orderBy(desc(broadcastRecipients.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit).map((r) => ({
		id: r.id,
		contact_id: r.contactId ?? null,
		contact_identifier: r.contactIdentifier,
		status: r.status as "pending" | "sent" | "failed",
		message_id: r.messageId ?? null,
		error: r.error ?? null,
		sent_at: r.sentAt?.toISOString() ?? null,
	}));

	return c.json({
		data,
		next_cursor: hasMore ? data[data.length - 1]!.id : null,
		has_more: hasMore,
	});
});

// @ts-expect-error — Hono strict return types
app.openapi(sendBroadcastRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [broadcast] = await db
		.select()
		.from(broadcasts)
		.where(and(eq(broadcasts.id, id), eq(broadcasts.organizationId, orgId)))
		.limit(1);

	if (!broadcast) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Broadcast not found" } },
			404,
		);
	}

	if (broadcast.status !== "draft" && broadcast.status !== "scheduled") {
		return c.json(
			{
				error: {
					code: "INVALID_STATUS",
					message: `Broadcast is already ${broadcast.status}`,
				},
			},
			400,
		);
	}

	const account = await getAccount(
		db,
		broadcast.socialAccountId,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);

	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_ERROR",
					message: "Social account not found or missing access token",
				},
			},
			400,
		);
	}

	// Mark as sending
	await db
		.update(broadcasts)
		.set({ status: "sending", updatedAt: new Date() })
		.where(eq(broadcasts.id, id));

	// Fetch pending recipients
	const recipients = await db
		.select()
		.from(broadcastRecipients)
		.where(
			and(
				eq(broadcastRecipients.broadcastId, id),
				eq(broadcastRecipients.status, "pending"),
			),
		);

	let sent = 0;
	let failed = 0;

	for (const recipient of recipients) {
		const result = await sendMessage({
			platform: broadcast.platform,
			accessToken: account.accessToken,
			platformAccountId: account.platformAccountId ?? "",
			recipientId: recipient.contactIdentifier,
			text: broadcast.messageText ?? "",
			templateName: broadcast.templateName ?? undefined,
			templateLanguage: broadcast.templateLanguage ?? undefined,
			templateComponents: (recipient.variables
				? (recipient.variables as unknown[])
				: (broadcast.templateComponents as unknown[] | null)) ?? undefined,
		});

		if (result.success) {
			await db
				.update(broadcastRecipients)
				.set({
					status: "sent",
					messageId: result.messageId ?? null,
					sentAt: new Date(),
				})
				.where(eq(broadcastRecipients.id, recipient.id));
			sent++;
		} else {
			await db
				.update(broadcastRecipients)
				.set({ status: "failed", error: result.error ?? "Unknown error" })
				.where(eq(broadcastRecipients.id, recipient.id));
			failed++;
		}
	}

	const finalStatus: BroadcastStatus =
		failed === 0
			? "sent"
			: sent === 0
				? "failed"
				: "partially_failed";

	const [updated] = await db
		.update(broadcasts)
		.set({
			status: finalStatus,
			sentCount: sent,
			failedCount: failed,
			completedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(broadcasts.id, id))
		.returning();

	return c.json(serializeBroadcast(updated!));
});

// @ts-expect-error — Hono strict return types
app.openapi(scheduleBroadcastRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { scheduled_at } = c.req.valid("json");
	const db = c.get("db");

	const [existing] = await db
		.select()
		.from(broadcasts)
		.where(and(eq(broadcasts.id, id), eq(broadcasts.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Broadcast not found" } },
			404,
		);
	}

	if (existing.status !== "draft" && existing.status !== "scheduled") {
		return c.json(
			{
				error: {
					code: "INVALID_STATUS",
					message: "Only draft or scheduled broadcasts can be scheduled",
				},
			},
			400,
		);
	}

	const scheduledAt = new Date(scheduled_at);
	if (scheduledAt <= new Date()) {
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message: "Scheduled time must be in the future",
				},
			},
			400,
		);
	}

	const [updated] = await db
		.update(broadcasts)
		.set({
			status: "scheduled",
			scheduledAt,
			updatedAt: new Date(),
		})
		.where(eq(broadcasts.id, id))
		.returning();

	return c.json(serializeBroadcast(updated!));
});

// @ts-expect-error — Hono strict return types
app.openapi(cancelBroadcast, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select()
		.from(broadcasts)
		.where(and(eq(broadcasts.id, id), eq(broadcasts.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Broadcast not found" } },
			404,
		);
	}

	if (existing.status !== "scheduled") {
		return c.json(
			{
				error: {
					code: "INVALID_STATUS",
					message: "Only scheduled broadcasts can be cancelled",
				},
			},
			400,
		);
	}

	const [updated] = await db
		.update(broadcasts)
		.set({
			status: "cancelled",
			scheduledAt: null,
			updatedAt: new Date(),
		})
		.where(eq(broadcasts.id, id))
		.returning();

	return c.json(serializeBroadcast(updated!));
});

export default app;
