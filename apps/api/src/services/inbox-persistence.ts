/**
 * Inbox persistence service — shared read/write layer for the unified inbox.
 *
 * Used by:
 * - inbox-event-processor (writes incoming messages/conversations)
 * - Phase 3 API routes (queries data for AI-friendly endpoints)
 */

import {
	type Database,
	generateId,
	inboxConversations,
	inboxMessages,
} from "@relayapi/db";
import {
	and,
	asc,
	count,
	desc,
	eq,
	getTableColumns,
	gte,
	ilike,
	lte,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { deriveProtectedContactSubjectLocator } from "../lib/consent-hmac";
import {
	decodeTimestampIdCursor,
	encodeTimestampIdCursor,
} from "../lib/pagination-cursor";
import { workspaceScopeSqlCondition } from "../lib/workspace-scope";
import { findMatchingContact } from "./contact-linker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Conversation = typeof inboxConversations.$inferSelect;
type Message = typeof inboxMessages.$inferSelect;

export const INBOX_CONTENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export interface UpsertConversationData {
	organizationId: string;
	/** Authoritative scope copied from the source social account. */
	workspaceId: string | null;
	accountId: string;
	platform: Conversation["platform"];
	type: Conversation["type"];
	platformConversationId: string;
	postId?: string | null;
	postPlatformId?: string | null;
	participantName?: string | null;
	participantPlatformId?: string | null;
	participantAvatar?: string | null;
	participantMetadata?: Record<string, unknown> | null;
	lastMessageText?: string | null;
	lastMessageAt?: Date | null;
	lastMessageDirection?: Conversation["lastMessageDirection"];
}

export interface InsertMessageData {
	conversationId: string;
	organizationId: string;
	platformMessageId: string;
	authorName?: string | null;
	authorPlatformId?: string | null;
	authorAvatarUrl?: string | null;
	text?: string | null;
	direction: Message["direction"];
	attachments?: unknown[] | null;
	sentimentScore?: number | null;
	classification?: string | null;
	platformData?: Record<string, unknown> | null;
	/**
	 * Conversation-list preview override (`lastMessageText`) for messages with an
	 * empty body — e.g. "Mentioned you in their story". Does not touch the stored
	 * message `text`. Falls back to `text` when omitted.
	 */
	previewText?: string | null;
	isHidden?: boolean;
	isLiked?: boolean;
	createdAt?: Date;
}

export interface ListConversationsFilters {
	type?: string;
	platform?: string;
	status?: string;
	accountId?: string;
	labels?: string[];
	cursor?: string;
	limit?: number;
	workspaceScope?: "all" | string[];
}

export interface SearchMessagesFilters {
	platform?: string;
	since?: string;
	until?: string;
	cursor?: string;
	limit?: number;
	workspaceScope?: "all" | string[];
}

export interface InboxStatsFilters {
	platform?: string;
	accountId?: string;
	workspaceScope?: "all" | string[];
}

export interface ConversationUpdates {
	status?: Conversation["status"];
	labels?: string[];
	priority?: string;
	assignedUserId?: string | null;
}

// ---------------------------------------------------------------------------
// 1. upsertConversation
// ---------------------------------------------------------------------------

export async function upsertConversation(
	db: Database,
	data: UpsertConversationData,
	subjectLocatorKeyConfig: string,
): Promise<Conversation> {
	const now = new Date();

	const [row] = await db
		.insert(inboxConversations)
		.values({
			id: generateId("conv_"),
			organizationId: data.organizationId,
			workspaceId: data.workspaceId,
			accountId: data.accountId,
			platform: data.platform,
			type: data.type,
			platformConversationId: data.platformConversationId,
			postId: data.postId ?? null,
			postPlatformId: data.postPlatformId ?? null,
			participantName: data.participantName ?? null,
			participantPlatformId: data.participantPlatformId ?? null,
			participantAvatar: data.participantAvatar ?? null,
			participantMetadata: data.participantMetadata ?? {},
			lastMessageText: data.lastMessageText ?? null,
			lastMessageAt: data.lastMessageAt ?? now,
			lastMessageDirection: data.lastMessageDirection ?? "inbound",
			unreadCount: 0,
			messageCount: 0,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [
				inboxConversations.accountId,
				inboxConversations.platformConversationId,
			],
			set: {
				// COALESCE(existing, new): keep an already-stored participant
				// name/avatar and only fill from the raw event when nothing is
				// stored yet. The Instagram/Facebook DM normalizers set
				// `author.name = scopedId` because the webhook carries no display
				// name, so `COALESCE(new, existing)` would clobber the enriched
				// profile name with the numeric scoped ID on every inbound DM.
				// The dedicated profile-enrichment UPDATE in the event processor is
				// the only path allowed to overwrite these with a real name/avatar.
				participantName: sql`COALESCE(${inboxConversations.participantName}, ${data.participantName ?? null})`,
				participantAvatar: sql`COALESCE(${inboxConversations.participantAvatar}, ${data.participantAvatar ?? null})`,
				...(data.participantMetadata
					? {
							participantMetadata: sql`COALESCE(${inboxConversations.participantMetadata}, '{}'::jsonb) || ${data.participantMetadata}`,
						}
					: {}),
				status: "open",
				closedAt: null,
				contentExpiresAt: null,
				contentRedactedAt: null,
				updatedAt: sql`${now.toISOString()}`,
			},
		})
		.returning();

	// An upsert always returns a row (INSERT or UPDATE path)
	if (!row) {
		throw new Error("upsertConversation: insert returned no row");
	}
	const conversation = row;

	// Auto-link to contact if no contact is already linked. Every successful link
	// writes the retained-key HMAC locator in the same UPDATE, so a later
	// contact-FK SET NULL cannot make subject erasure undiscoverable.
	let linkedContactId = conversation.contactId;
	if (!linkedContactId) {
		try {
			const match = await findMatchingContact(
				db,
				data.organizationId,
				data.accountId,
				data.participantPlatformId ?? null,
				data.participantName ?? null,
				data.participantMetadata ?? null,
				subjectLocatorKeyConfig,
			);

			// Auto-link for high-confidence matches (not name suggestions)
			if (match && match.confidence !== "name_suggestion") {
				linkedContactId = match.contactId;
			}
		} catch {
			// Don't fail the upsert if contact linking fails
		}
	}
	if (linkedContactId) {
		const locator = await deriveProtectedContactSubjectLocator(
			subjectLocatorKeyConfig,
			data.organizationId,
			linkedContactId,
		);
		await db
			.update(inboxConversations)
			.set({ contactId: linkedContactId, ...locator })
			.where(
				and(
					eq(inboxConversations.id, conversation.id),
					eq(inboxConversations.organizationId, data.organizationId),
				),
			);
		conversation.contactId = linkedContactId;
		conversation.contactSubjectLocator = locator.contactSubjectLocator;
		conversation.contactSubjectIdentityKeyFingerprint =
			locator.contactSubjectIdentityKeyFingerprint;
	}

	return conversation;
}

// ---------------------------------------------------------------------------
// 2. insertMessage
// ---------------------------------------------------------------------------

export async function insertMessage(
	db: Database,
	data: InsertMessageData,
): Promise<Message | null> {
	const now = data.createdAt ?? new Date();

	return db.transaction(async (tx) => {
		const [conversationScope] = await tx
			.select({
				scopeKey: inboxConversations.scopeKey,
				accountId: inboxConversations.accountId,
				platform: inboxConversations.platform,
			})
			.from(inboxConversations)
			.where(
				and(
					eq(inboxConversations.id, data.conversationId),
					eq(inboxConversations.organizationId, data.organizationId),
				),
			)
			.limit(1)
			.for("update");
		if (!conversationScope) {
			throw new Error("insertMessage: conversation not found in organization");
		}

		const rows = await tx
			.insert(inboxMessages)
			.values({
				id: generateId("msg_"),
				conversationId: data.conversationId,
				organizationId: data.organizationId,
				scopeKey: conversationScope.scopeKey,
				accountId: conversationScope.accountId,
				platform: conversationScope.platform,
				platformMessageId: data.platformMessageId,
				authorName: data.authorName ?? null,
				authorPlatformId: data.authorPlatformId ?? null,
				authorAvatarUrl: data.authorAvatarUrl ?? null,
				text: data.text ?? null,
				direction: data.direction,
				attachments: data.attachments ?? [],
				sentimentScore: data.sentimentScore ?? null,
				classification: data.classification ?? null,
				platformData: data.platformData ?? {},
				isHidden: data.isHidden ?? false,
				isLiked: data.isLiked ?? false,
				createdAt: now,
			})
			.onConflictDoNothing({
				target: [
					inboxMessages.platform,
					inboxMessages.accountId,
					inboxMessages.platformMessageId,
				],
			})
			.returning();

		const message = rows[0];
		const previewText = data.previewText ?? data.text ?? null;

		if (!message) {
			// A duplicate can be a retry of the old two-statement implementation
			// after it committed the message but crashed before updating the parent.
			// Repair the durable count and latest-message projection before returning.
			// `unread_count` has no per-message read ledger, so it can only be safely
			// incremented when this duplicate is demonstrably the missing latest row.
			const [existing] = await tx
				.select()
				.from(inboxMessages)
				.where(
					and(
						eq(inboxMessages.organizationId, data.organizationId),
						eq(inboxMessages.accountId, conversationScope.accountId),
						eq(inboxMessages.platform, conversationScope.platform),
						eq(inboxMessages.platformMessageId, data.platformMessageId),
					),
				)
				.limit(1);
			if (existing) {
				const repairConversationId = existing.conversationId;
				const repairPreviewText =
					repairConversationId === data.conversationId
						? previewText
						: existing.text;
				await tx.execute(sql`
					WITH stats AS (
						SELECT COUNT(*)::integer AS message_count
						  FROM inbox_messages
						 WHERE conversation_id = ${repairConversationId}
						   AND organization_id = ${data.organizationId}
					), latest AS (
						SELECT id, text, direction, created_at
						  FROM inbox_messages
						 WHERE conversation_id = ${repairConversationId}
						   AND organization_id = ${data.organizationId}
						 ORDER BY created_at DESC, id DESC
						 LIMIT 1
					)
					UPDATE inbox_conversations AS conversation
					   SET message_count = stats.message_count,
					       last_message_text = CASE
					         WHEN latest.id = ${existing.id} THEN ${repairPreviewText}
					         ELSE latest.text
					       END,
					       last_message_at = latest.created_at,
					       last_message_direction = latest.direction,
					       unread_count = conversation.unread_count + CASE
					         WHEN conversation.message_count < stats.message_count
					          AND latest.id = ${existing.id}
					          AND latest.direction = 'inbound'
					          AND (
					            conversation.last_message_at IS NULL
					            OR conversation.last_message_at <= latest.created_at
					          )
					         THEN 1 ELSE 0
					       END,
					       updated_at = NOW()
					  FROM stats, latest
					 WHERE conversation.id = ${repairConversationId}
					   AND conversation.organization_id = ${data.organizationId}
				`);
			}
			return null;
		}

		// Insert and parent projection now commit atomically. The preview fields
		// remain monotonic so historical backfill cannot rewind a live thread.
		const nowTs = sql`${now.toISOString()}::timestamptz`;
		const insertedAt = new Date();
		const isNewer = sql`(${inboxConversations.lastMessageAt} IS NULL OR ${inboxConversations.lastMessageAt} <= ${nowTs})`;
		await tx
			.update(inboxConversations)
			.set({
				lastMessageText: sql`CASE WHEN ${isNewer} THEN ${previewText} ELSE ${inboxConversations.lastMessageText} END`,
				lastMessageAt: sql`GREATEST(COALESCE(${inboxConversations.lastMessageAt}, ${nowTs}), ${nowTs})`,
				lastMessageDirection: sql`CASE WHEN ${isNewer} THEN ${data.direction} ELSE ${inboxConversations.lastMessageDirection} END`,
				messageCount: sql`${inboxConversations.messageCount} + 1`,
				unreadCount:
					data.direction === "inbound"
						? sql`${inboxConversations.unreadCount} + CASE WHEN ${isNewer} THEN 1 ELSE 0 END`
						: inboxConversations.unreadCount,
				status: "open",
				closedAt: null,
				contentExpiresAt: null,
				contentRedactedAt: null,
				updatedAt: insertedAt,
			})
			.where(
				and(
					eq(inboxConversations.id, data.conversationId),
					eq(inboxConversations.organizationId, data.organizationId),
				),
			);

		return message;
	});
}

// ---------------------------------------------------------------------------
// 3. listConversations
// ---------------------------------------------------------------------------

export async function listConversations(
	db: Database,
	orgId: string,
	filters?: ListConversationsFilters,
): Promise<{
	data: Conversation[];
	next_cursor: string | null;
	has_more: boolean;
}> {
	const limit = Math.min(Math.max(filters?.limit ?? 20, 1), 100);
	const decodedCursor = filters?.cursor
		? decodeTimestampIdCursor(filters.cursor)
		: null;

	const conditions: (SQL | undefined)[] = [
		eq(inboxConversations.organizationId, orgId),
	];

	// Workspace scope enforcement — include org-level (NULL workspace) resources
	if (filters?.workspaceScope && filters.workspaceScope !== "all") {
		conditions.push(
			workspaceScopeSqlCondition(
				filters.workspaceScope,
				inboxConversations.workspaceId,
			),
		);
	}

	if (filters?.type) {
		conditions.push(
			eq(inboxConversations.type, filters.type as Conversation["type"]),
		);
	}

	if (filters?.platform) {
		conditions.push(
			eq(
				inboxConversations.platform,
				filters.platform as Conversation["platform"],
			),
		);
	}

	if (filters?.status) {
		conditions.push(
			eq(inboxConversations.status, filters.status as Conversation["status"]),
		);
	}

	if (filters?.accountId) {
		conditions.push(eq(inboxConversations.accountId, filters.accountId));
	}

	if (filters?.labels && filters.labels.length > 0) {
		// Match conversations that contain ANY of the requested labels
		const labelConditions = filters.labels.map(
			(label) => sql`${label} = ANY(${inboxConversations.labels})`,
		);
		conditions.push(or(...labelConditions));
	}

	if (decodedCursor) {
		conditions.push(
			sql`(${inboxConversations.updatedAt}, ${inboxConversations.id}) < (${decodedCursor.timestamp}::timestamptz, ${decodedCursor.id})`,
		);
	}

	// Fetch limit+1 to check if there are more rows
	const rows = await db
		.select({
			...getTableColumns(inboxConversations),
			cursorTimestamp: sql<string>`to_char(${inboxConversations.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(inboxConversations)
		.where(and(...conditions))
		.orderBy(desc(inboxConversations.updatedAt), desc(inboxConversations.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = hasMore ? rows.slice(0, limit) : rows;
	const lastRow = data[data.length - 1];
	const nextCursor =
		hasMore && lastRow
			? encodeTimestampIdCursor(lastRow.cursorTimestamp, lastRow.id)
			: null;

	return { data, next_cursor: nextCursor, has_more: hasMore };
}

// ---------------------------------------------------------------------------
// 4. getConversationWithMessages
// ---------------------------------------------------------------------------

export async function getConversationWithMessages(
	db: Database,
	conversationId: string,
	orgId: string,
	workspaceScope?: "all" | string[],
): Promise<{ conversation: Conversation; messages: Message[] } | null> {
	const conditions: (SQL | undefined)[] = [
		eq(inboxConversations.id, conversationId),
		eq(inboxConversations.organizationId, orgId),
	];
	if (workspaceScope && workspaceScope !== "all") {
		conditions.push(
			workspaceScopeSqlCondition(
				workspaceScope,
				inboxConversations.workspaceId,
			),
		);
	}

	// Both queries are keyed on conversationId — one parallel round trip.
	// Messages are discarded when the conversation lookup fails the org /
	// workspace-scope filter.
	const [[conversation], messages] = await Promise.all([
		db
			.select()
			.from(inboxConversations)
			.where(and(...conditions))
			.limit(1),
		db
			.select()
			.from(inboxMessages)
			.where(eq(inboxMessages.conversationId, conversationId))
			.orderBy(asc(inboxMessages.createdAt))
			.limit(200),
	]);

	if (!conversation) {
		return null;
	}

	return { conversation, messages };
}

// ---------------------------------------------------------------------------
// 5. searchMessages
// ---------------------------------------------------------------------------

export async function searchMessages(
	db: Database,
	orgId: string,
	query: string,
	filters?: SearchMessagesFilters,
): Promise<{
	data: Message[];
	next_cursor: string | null;
	has_more: boolean;
}> {
	const limit = Math.min(Math.max(filters?.limit ?? 20, 1), 100);
	const decodedCursor = filters?.cursor
		? decodeTimestampIdCursor(filters.cursor)
		: null;

	// A leading-wildcard ILIKE is served by the pg_trgm GIN index
	// (inbox_msg_text_trgm_idx, see packages/db/src/schema.ts). Trigram indexes
	// cannot help queries shorter than 3 chars, so a 1-2 char term would force a
	// full heap scan of the org's message history — short-circuit to empty
	// instead. (Callers can paginate larger terms normally.)
	if (query.trim().length < 3) {
		return { data: [], next_cursor: null, has_more: false };
	}

	const conditions = [
		eq(inboxMessages.organizationId, orgId),
		ilike(inboxMessages.text, `%${query.replace(/[%_\\]/g, "\\$&")}%`),
	];

	// Workspace scope enforcement — filter messages by their conversation's workspace
	if (filters?.workspaceScope && filters.workspaceScope !== "all") {
		const scopeCondition = workspaceScopeSqlCondition(
			filters.workspaceScope,
			inboxConversations.workspaceId,
		);
		conditions.push(
			sql`${inboxMessages.conversationId} IN (
				SELECT ${inboxConversations.id} FROM ${inboxConversations}
				WHERE ${inboxConversations.organizationId} = ${orgId}
				AND ${scopeCondition}
			)`,
		);
	}

	if (filters?.platform) {
		// Join through conversations to filter by platform
		// Use a subquery to get conversation IDs for the platform
		conditions.push(
			sql`${inboxMessages.conversationId} IN (
				SELECT ${inboxConversations.id} FROM ${inboxConversations}
				WHERE ${inboxConversations.organizationId} = ${orgId}
				AND ${inboxConversations.platform} = ${filters.platform}
			)`,
		);
	}

	if (filters?.since) {
		conditions.push(gte(inboxMessages.createdAt, new Date(filters.since)));
	}

	if (filters?.until) {
		conditions.push(lte(inboxMessages.createdAt, new Date(filters.until)));
	}

	if (decodedCursor) {
		conditions.push(
			sql`(${inboxMessages.createdAt}, ${inboxMessages.id}) < (${decodedCursor.timestamp}::timestamptz, ${decodedCursor.id})`,
		);
	}

	const rows = await db
		.select({
			...getTableColumns(inboxMessages),
			cursorTimestamp: sql<string>`to_char(${inboxMessages.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(inboxMessages)
		.where(and(...conditions))
		.orderBy(desc(inboxMessages.createdAt), desc(inboxMessages.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = hasMore ? rows.slice(0, limit) : rows;
	const lastRow = data[data.length - 1];
	const nextCursor =
		hasMore && lastRow
			? encodeTimestampIdCursor(lastRow.cursorTimestamp, lastRow.id)
			: null;

	return { data, next_cursor: nextCursor, has_more: hasMore };
}

// ---------------------------------------------------------------------------
// 6. getInboxStats
// ---------------------------------------------------------------------------

export async function getInboxStats(
	db: Database,
	orgId: string,
	filters?: InboxStatsFilters,
): Promise<{
	total_conversations: number;
	open_conversations: number;
	unread_messages: number;
	by_platform: Record<string, { conversations: number; unread: number }>;
}> {
	const conditions: (SQL | undefined)[] = [
		eq(inboxConversations.organizationId, orgId),
	];

	// Workspace scope enforcement — include org-level (NULL workspace) resources
	if (filters?.workspaceScope && filters.workspaceScope !== "all") {
		conditions.push(
			workspaceScopeSqlCondition(
				filters.workspaceScope,
				inboxConversations.workspaceId,
			),
		);
	}

	if (filters?.platform) {
		conditions.push(
			eq(
				inboxConversations.platform,
				filters.platform as Conversation["platform"],
			),
		);
	}

	if (filters?.accountId) {
		conditions.push(eq(inboxConversations.accountId, filters.accountId));
	}

	const whereClause = and(...conditions);

	// Aggregate totals and per-platform stats in a single query
	const rows = await db
		.select({
			platform: inboxConversations.platform,
			status: inboxConversations.status,
			conversations: count(),
			unread:
				sql<number>`COALESCE(SUM(${inboxConversations.unreadCount}), 0)`.mapWith(
					Number,
				),
		})
		.from(inboxConversations)
		.where(whereClause)
		.groupBy(inboxConversations.platform, inboxConversations.status);

	let totalConversations = 0;
	let openConversations = 0;
	let unreadMessages = 0;
	const byPlatform: Record<string, { conversations: number; unread: number }> =
		{};

	for (const row of rows) {
		const convCount = Number(row.conversations);
		const unreadCount = Number(row.unread);

		totalConversations += convCount;
		if (row.status === "open") {
			openConversations += convCount;
		}
		unreadMessages += unreadCount;

		const existing = byPlatform[row.platform];
		if (existing) {
			existing.conversations += convCount;
			existing.unread += unreadCount;
		} else {
			byPlatform[row.platform] = {
				conversations: convCount,
				unread: unreadCount,
			};
		}
	}

	return {
		total_conversations: totalConversations,
		open_conversations: openConversations,
		unread_messages: unreadMessages,
		by_platform: byPlatform,
	};
}

// ---------------------------------------------------------------------------
// 7. updateConversation
// ---------------------------------------------------------------------------

export async function updateConversation(
	db: Database,
	conversationId: string,
	orgId: string,
	updates: ConversationUpdates,
	workspaceScope?: "all" | string[],
): Promise<Conversation | null> {
	const setClause: Record<string, unknown> = {
		updatedAt: new Date(),
	};

	if (updates.status !== undefined) {
		setClause.status = updates.status;
		if (updates.status === "archived") {
			const closedAt = new Date();
			setClause.closedAt = closedAt;
			setClause.contentExpiresAt = new Date(
				closedAt.getTime() + INBOX_CONTENT_RETENTION_MS,
			);
		} else {
			setClause.closedAt = null;
			setClause.contentExpiresAt = null;
		}
	}
	if (updates.labels !== undefined) {
		setClause.labels = updates.labels;
	}
	if (updates.priority !== undefined) {
		setClause.priority = updates.priority;
	}
	if (updates.assignedUserId !== undefined) {
		setClause.assignedUserId = updates.assignedUserId;
	}

	const updateConditions: (SQL | undefined)[] = [
		eq(inboxConversations.id, conversationId),
		eq(inboxConversations.organizationId, orgId),
	];
	if (workspaceScope && workspaceScope !== "all") {
		updateConditions.push(
			workspaceScopeSqlCondition(
				workspaceScope,
				inboxConversations.workspaceId,
			),
		);
	}

	const [updated] = await db
		.update(inboxConversations)
		.set(setClause)
		.where(and(...updateConditions))
		.returning();

	return updated ?? null;
}
