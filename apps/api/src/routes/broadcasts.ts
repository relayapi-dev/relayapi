import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
	broadcastRecipients,
	broadcasts,
	contactChannels,
	contacts,
	type createDb,
	socialAccounts,
} from "@relayapi/db";
import {
	and,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	or,
	sql,
} from "drizzle-orm";
import { decryptAccountToken } from "../lib/account-token-crypto";
import { inheritOperationalCreateScope } from "../lib/request-access";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
	canAccessWorkspaceScope,
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
} from "../lib/workspace-scope";
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
	ScheduleBroadcastBody,
	UpdateBroadcastBody,
} from "../schemas/broadcasts";
import { ErrorResponse } from "../schemas/common";
import {
	getAllowedRecipientHashes,
	hashRecipientIdentifier,
} from "../services/contact-consent";
import { decryptContactChannelRows } from "../services/contact-protection";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const WorkspaceDeniedResponse = {
	description: "Workspace access denied",
	content: { "application/json": { schema: ErrorResponse } },
} as const;

type BroadcastStatus =
	| "draft"
	| "scheduled"
	| "sending"
	| "sent"
	| "partially_failed"
	| "requires_attention"
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
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		)
		.limit(1);
	if (!account) return null;
	if (!canAccessWorkspaceScope(workspaceScope, account.workspaceId))
		return null;
	return {
		...account,
		accessToken: await decryptAccountToken(
			account.accessToken,
			encryptionKey,
			account.id,
			"access_token",
		),
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
		400: {
			description: "Account and workspace do not match",
			content: { "application/json": { schema: ErrorResponse } },
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
		403: WorkspaceDeniedResponse,
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
		403: WorkspaceDeniedResponse,
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
		403: WorkspaceDeniedResponse,
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
		403: WorkspaceDeniedResponse,
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
		403: WorkspaceDeniedResponse,
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
	description:
		"Queues the broadcast for immediate delivery. Returns 202 with the broadcast in `scheduled` status; the every-minute processor sends pending recipients in bounded batches and finalizes counts. Poll GET /v1/broadcasts/{id} for progress.",
	security: [{ Bearer: [] }],
	request: { params: BroadcastIdParams },
	responses: {
		403: WorkspaceDeniedResponse,
		202: {
			description: "Broadcast queued for sending",
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
		403: WorkspaceDeniedResponse,
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
		403: WorkspaceDeniedResponse,
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
	const account = await getAccount(
		db,
		body.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Social account not found" } },
			404,
		);
	}
	// The account is the authoritative parent. Its non-null scope satisfies
	// Require Workspace ID even when the redundant request field is omitted.
	const scope = await inheritOperationalCreateScope(
		c,
		body.workspace_id,
		[account.workspaceId],
		"broadcast",
	);
	if (!scope.ok) return scope.response as never;
	if (account.workspaceId !== scope.workspaceId) {
		return c.json(
			{
				error: {
					code: "INVALID_ACCOUNT",
					message: "Broadcast account must belong to the broadcast workspace",
				},
			},
			400,
		);
	}
	if (account.platform === "whatsapp" && !body.template) {
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message: "WhatsApp broadcasts require an approved template",
				},
			},
			400,
		);
	}
	if (account.platform !== "whatsapp" && !body.message_text) {
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message: "Non-WhatsApp broadcasts require message_text",
				},
			},
			400,
		);
	}

	const [row] = await db
		.insert(broadcasts)
		.values({
			organizationId: orgId,
			workspaceId: scope.workspaceId,
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

	if (!row) throw new Error("Failed to create broadcast");
	return c.json(serializeBroadcast(row), 201);
});

app.openapi(listBroadcasts, async (c) => {
	const orgId = c.get("orgId");
	const { workspace_id, account_id, status, cursor, limit } =
		c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(broadcasts.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, broadcasts.workspaceId);
	if (workspace_id) conditions.push(eq(broadcasts.workspaceId, workspace_id));
	if (account_id) conditions.push(eq(broadcasts.socialAccountId, account_id));
	if (status) conditions.push(eq(broadcasts.status, status));

	// Cursor pagination (composite: createdAt DESC, id DESC to handle timestamp ties).
	// Read the cursor row's created_at as raw text so we don't round-trip it through
	// a JS Date, which truncates Postgres microseconds to millisecond precision and
	// would skip rows sharing the cursor's millisecond. Bind it back with an explicit
	// ::timestamptz cast to keep the keyset comparison exact.
	if (cursor) {
		const [cursorRow] = await db
			.select({ createdAt: sql<string>`${broadcasts.createdAt}::text` })
			.from(broadcasts)
			.where(eq(broadcasts.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${broadcasts.createdAt}, ${broadcasts.id}) < (${cursorRow.createdAt}::timestamptz, ${cursor})`,
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
		next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
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
	const denied = assertWorkspaceScope(c, row.workspaceId);
	if (denied) return denied;

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
	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

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

	const updates: Record<string, unknown> = {
		updatedAt: new Date(),
		revision: sql`${broadcasts.revision} + 1`,
	};
	if (body.name !== undefined) updates.name = body.name;
	if (body.description !== undefined) updates.description = body.description;
	if (body.message_text !== undefined) updates.messageText = body.message_text;
	if (body.template) {
		updates.templateName = body.template.name;
		updates.templateLanguage = body.template.language;
		if (body.template.components)
			updates.templateComponents = body.template.components;
	}

	const [updated] = await db
		.update(broadcasts)
		.set(updates)
		.where(
			and(
				eq(broadcasts.id, id),
				eq(broadcasts.organizationId, orgId),
				eq(broadcasts.status, "draft"),
				eq(broadcasts.revision, existing.revision),
			),
		)
		.returning();

	if (!updated) {
		return c.json(
			{
				error: {
					code: "CONCURRENT_MODIFICATION",
					message: "Broadcast changed while the update was being applied",
				},
			},
			400,
		);
	}
	return c.json(serializeBroadcast(updated));
});

app.openapi(deleteBroadcast, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select({
			status: broadcasts.status,
			workspaceId: broadcasts.workspaceId,
			revision: broadcasts.revision,
		})
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

	const deleted = await db
		.delete(broadcasts)
		.where(
			and(
				eq(broadcasts.id, id),
				eq(broadcasts.organizationId, orgId),
				inArray(broadcasts.status, ["draft", "cancelled"]),
				eq(broadcasts.revision, existing.revision),
			),
		)
		.returning({ id: broadcasts.id });
	if (deleted.length === 0) {
		return c.json(
			{
				error: {
					code: "CONCURRENT_MODIFICATION",
					message: "Broadcast changed before it could be deleted",
				},
			},
			400,
		);
	}
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
	const denied = assertWorkspaceScope(c, broadcast.workspaceId);
	if (denied) return denied;

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
				contactId: contacts.id,
				id: contactChannels.id,
				organizationId: contactChannels.organizationId,
				identifierCiphertext: contactChannels.identifierCiphertext,
				identifierHash: contactChannels.identifierHash,
				identityKeyFingerprint:
					contactChannels.identityKeyFingerprint,
			})
			.from(contacts)
			.innerJoin(contactChannels, eq(contactChannels.contactId, contacts.id))
			.where(
				and(
					eq(contacts.organizationId, orgId),
					eq(contacts.scopeKey, broadcast.scopeKey),
					inArray(contacts.id, body.contact_ids),
					eq(contactChannels.socialAccountId, broadcast.socialAccountId),
				),
			);

		const plaintextRows = await decryptContactChannelRows(
			c.env.ENCRYPTION_KEY,
			contactRows,
		);
		for (const row of plaintextRows) {
			toInsert.push({
				contactId: row.contactId,
				contactIdentifier: row.identifier,
			});
		}
	}

	if (toInsert.length === 0) {
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message:
						"No recipients provided. Supply phones, contact_ids, or identifiers.",
				},
			},
			400,
		);
	}

	const allowedHashes = await getAllowedRecipientHashes(
		db,
		c.env.ENCRYPTION_KEY,
		orgId,
		broadcast.platform,
		"marketing",
		toInsert.map((item) => ({
			identifier: item.contactIdentifier,
			contactId: item.contactId,
		})),
	);
	const authorized = (
		await Promise.all(
			toInsert.map(async (item) => ({
				...item,
				contactIdentifierHash: await hashRecipientIdentifier(
					c.env.ENCRYPTION_KEY,
					orgId,
					broadcast.platform,
					"marketing",
					item.contactIdentifier,
				),
			})),
		)
	).filter((item) => allowedHashes.has(item.contactIdentifierHash));

	// Lock and revalidate the parent, insert the recipient identities, and advance
	// the aggregate count/revision atomically. A scheduler claim can no longer see
	// a partially-added recipient set or race the pre-read status check.
	const mutation = await db.transaction(async (tx) => {
		const [locked] = await tx
			.select()
			.from(broadcasts)
			.where(and(eq(broadcasts.id, id), eq(broadcasts.organizationId, orgId)))
			.limit(1)
			.for("update");
		if (
			!locked ||
			(locked.status !== "draft" && locked.status !== "scheduled")
		) {
			return { ok: false as const, added: 0 };
		}

		const inserted =
			authorized.length > 0
				? await tx
						.insert(broadcastRecipients)
						.values(
							authorized.map((item) => ({
								organizationId: orgId,
								scopeKey: locked.scopeKey,
								broadcastId: id,
								contactId: item.contactId,
								contactIdentifier: item.contactIdentifier,
								contactIdentifierHash: item.contactIdentifierHash,
							})),
						)
						.onConflictDoNothing()
						.returning({ id: broadcastRecipients.id })
				: [];
		const added = inserted.length;
		if (added > 0) {
			const advanced = await tx
				.update(broadcasts)
				.set({
					recipientCount: sql`${broadcasts.recipientCount} + ${added}`,
					revision: sql`${broadcasts.revision} + 1`,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(broadcasts.id, id),
						eq(broadcasts.organizationId, orgId),
						inArray(broadcasts.status, ["draft", "scheduled"]),
						eq(broadcasts.revision, locked.revision),
					),
				)
				.returning({ id: broadcasts.id });
			if (advanced.length === 0) {
				throw new Error("Broadcast recipient revision fence failed");
			}
		}
		return { ok: true as const, added };
	});
	if (!mutation.ok) {
		return c.json(
			{
				error: {
					code: "CONCURRENT_MODIFICATION",
					message: "Broadcast started sending before recipients were added",
				},
			},
			400,
		);
	}
	const added = mutation.added;
	const skipped = toInsert.length - added;

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
		.select({
			id: broadcasts.id,
			workspaceId: broadcasts.workspaceId,
			scopeKey: broadcasts.scopeKey,
		})
		.from(broadcasts)
		.where(and(eq(broadcasts.id, id), eq(broadcasts.organizationId, orgId)))
		.limit(1);

	if (!broadcast) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Broadcast not found" } },
			404,
		);
	}
	const denied = assertWorkspaceScope(c, broadcast.workspaceId);
	if (denied) return denied;

	const conditions = [
		eq(broadcastRecipients.broadcastId, id),
		eq(broadcastRecipients.organizationId, orgId),
		eq(broadcastRecipients.scopeKey, broadcast.scopeKey),
	];
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
		status: r.status as
			| "pending"
			| "sending"
			| "sent"
			| "failed"
			| "unknown"
			| "cancelled",
		message_id: r.messageId ?? null,
		error: r.error ?? null,
		sent_at: r.sentAt?.toISOString() ?? null,
	}));

	return c.json({
		data,
		next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
		has_more: hasMore,
	});
});

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
	if (isWorkspaceScopeDenied(c, broadcast.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
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
	if (broadcast.recipientCount === 0) {
		return c.json(
			{
				error: {
					code: "NO_RECIPIENTS",
					message: "Add at least one recipient before sending",
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

	// Hand off to the resumable cron-driven processor instead of fanning out the
	// entire broadcast inline on the request path. We mark the broadcast
	// `scheduled` with `scheduledAt = now` so the every-minute
	// processScheduledBroadcasts (services/broadcast-processor.ts) picks it up,
	// claims pending recipients in bounded keyset chunks, and finalizes counts —
	// avoiding proxy/subrequest limits and the "wedged in sending forever" failure
	// mode when a large send is cut off mid-request.
	const [updated] = await db
		.update(broadcasts)
		.set({
			status: "scheduled",
			scheduledAt: new Date(),
			completedAt: null,
			leaseExpiresAt: null,
			revision: sql`${broadcasts.revision} + 1`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(broadcasts.id, id),
				eq(broadcasts.organizationId, orgId),
				inArray(broadcasts.status, ["draft", "scheduled"]),
				eq(broadcasts.revision, broadcast.revision),
			),
		)
		.returning();

	if (!updated) {
		return c.json(
			{
				error: {
					code: "CONCURRENT_MODIFICATION",
					message: "Broadcast changed before it could be queued",
				},
			},
			400,
		);
	}
	return c.json(serializeBroadcast(updated), 202);
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
	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

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
	if (existing.recipientCount === 0) {
		return c.json(
			{
				error: {
					code: "NO_RECIPIENTS",
					message: "Add at least one recipient before scheduling",
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
			leaseExpiresAt: null,
			revision: sql`${broadcasts.revision} + 1`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(broadcasts.id, id),
				eq(broadcasts.organizationId, orgId),
				inArray(broadcasts.status, ["draft", "scheduled"]),
				eq(broadcasts.revision, existing.revision),
			),
		)
		.returning();

	if (!updated) {
		return c.json(
			{
				error: {
					code: "CONCURRENT_MODIFICATION",
					message: "Broadcast changed before it could be scheduled",
				},
			},
			400,
		);
	}
	return c.json(serializeBroadcast(updated));
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
	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	if (existing.status !== "scheduled" && existing.status !== "sending") {
		return c.json(
			{
				error: {
					code: "INVALID_STATUS",
					message: "Only scheduled or sending broadcasts can be cancelled",
				},
			},
			400,
		);
	}

	const updated = await db.transaction(async (tx) => {
		const [cancelled] = await tx
			.update(broadcasts)
			.set({
				status: "cancelled",
				scheduledAt: null,
				completedAt: new Date(),
				leaseExpiresAt: null,
				revision: sql`${broadcasts.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(broadcasts.id, id),
					eq(broadcasts.organizationId, orgId),
					inArray(broadcasts.status, ["scheduled", "sending"]),
					eq(broadcasts.revision, existing.revision),
				),
			)
			.returning();
		if (!cancelled) return null;
		await tx
			.update(broadcastRecipients)
			.set({
				status: "cancelled",
				deliveryState: "cancelled",
				claimedAt: null,
				error: "Broadcast cancelled before provider delivery",
			})
			.where(
				and(
					eq(broadcastRecipients.broadcastId, id),
					eq(broadcastRecipients.organizationId, orgId),
					eq(broadcastRecipients.scopeKey, existing.scopeKey),
					or(
						eq(broadcastRecipients.status, "pending"),
						and(
							eq(broadcastRecipients.status, "sending"),
							isNull(broadcastRecipients.requestMayHaveBeenSentAt),
						),
					),
				),
			);
		// Requests that already crossed the provider boundary cannot safely be
		// called cancelled or retried. Freeze them as unknown immediately so a
		// stopped, now-fenced worker cannot leave `sending` rows under a cancelled
		// parent indefinitely (and a late response cannot overwrite the decision).
		await tx
			.update(broadcastRecipients)
			.set({
				status: "unknown",
				deliveryState: "unknown",
				claimedAt: null,
				error: "Broadcast cancelled after the provider boundary",
			})
			.where(
				and(
					eq(broadcastRecipients.broadcastId, id),
					eq(broadcastRecipients.organizationId, orgId),
					eq(broadcastRecipients.scopeKey, existing.scopeKey),
					eq(broadcastRecipients.status, "sending"),
					isNotNull(broadcastRecipients.requestMayHaveBeenSentAt),
				),
			);
		return cancelled;
	});

	if (!updated) {
		return c.json(
			{
				error: {
					code: "CONCURRENT_MODIFICATION",
					message: "Broadcast finished or changed before cancellation",
				},
			},
			400,
		);
	}
	return c.json(serializeBroadcast(updated));
});

export default app;
