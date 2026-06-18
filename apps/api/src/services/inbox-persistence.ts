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
import { findMatchingContact } from "./contact-linker";
import { and, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql, asc, count, type SQL } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Conversation = typeof inboxConversations.$inferSelect;
type Message = typeof inboxMessages.$inferSelect;

export interface UpsertConversationData {
	organizationId: string;
	workspaceId?: string | null;
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
	lastMessageDirection?: string | null;
}

export interface InsertMessageData {
	conversationId: string;
	organizationId: string;
	platformMessageId: string;
	authorName?: string | null;
	authorPlatformId?: string | null;
	authorAvatarUrl?: string | null;
	text?: string | null;
	direction: string;
	attachments?: unknown[] | null;
	sentimentScore?: number | null;
	classification?: string | null;
	platformData?: Record<string, unknown> | null;
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
): Promise<Conversation> {
	const now = new Date();

	const [row] = await db
		.insert(inboxConversations)
		.values({
			id: generateId("conv_"),
			organizationId: data.organizationId,
			workspaceId: data.workspaceId ?? null,
			accountId: data.accountId,
			platform: data.platform,
			type: data.type,
			platformConversationId: data.platformConversationId,
			postId: data.postId ?? null,
			postPlatformId: data.postPlatformId ?? null,
			participantName: data.participantName ?? null,
			participantPlatformId: data.participantPlatformId ?? null,
			participantAvatar: data.participantAvatar ?? null,
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
				updatedAt: sql`${now.toISOString()}`,
			},
		})
		.returning();

	// An upsert always returns a row (INSERT or UPDATE path)
	if (!row) {
		throw new Error("upsertConversation: insert returned no row");
	}
	const conversation = row;

	// Auto-link to contact if no contact is already linked
	if (!conversation.contactId) {
		try {
			const match = await findMatchingContact(
				db,
				data.organizationId,
				data.accountId,
				data.participantPlatformId ?? null,
				data.participantName ?? null,
				data.participantMetadata ?? null,
			);

			// Auto-link for high-confidence matches (not name suggestions)
			if (match && match.confidence !== "name_suggestion") {
				await db
					.update(inboxConversations)
					.set({ contactId: match.contactId })
					.where(eq(inboxConversations.id, conversation.id));
				conversation.contactId = match.contactId;
			}
		} catch {
			// Don't fail the upsert if contact linking fails
		}
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

	const rows = await db
		.insert(inboxMessages)
		.values({
			id: generateId("msg_"),
			conversationId: data.conversationId,
			organizationId: data.organizationId,
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
			target: [inboxMessages.conversationId, inboxMessages.platformMessageId],
		})
		.returning();

	const message = rows[0];

	// If the insert was a no-op (conflict / duplicate), skip the conversation update
	if (!message) {
		return null;
	}

	// Update parent conversation preview + counts.
	//
	// The preview fields (lastMessageText/At/Direction) must be MONOTONIC: backfill
	// and out-of-order live deliveries call this with historical platform
	// timestamps in raw API order, so an older message inserted after a newer one
	// must NOT rewind the preview to stale content. We only overwrite the preview
	// when the new message is at least as new as the stored lastMessageAt.
	//
	// `updatedAt` is set to actual wall-clock insertion time (new Date()) rather
	// than the message's createdAt so that backfilling historical rows does not
	// regress conversation list ordering (listConversations orders by updatedAt
	// desc). The unreadCount increment is likewise gated on the message being
	// newer, so backfilling months-old inbound messages can't inflate unread.
	const nowTs = sql`${now.toISOString()}::timestamptz`;
	const insertedAt = new Date();
	const isNewer = sql`(${inboxConversations.lastMessageAt} IS NULL OR ${inboxConversations.lastMessageAt} <= ${nowTs})`;
	await db
		.update(inboxConversations)
		.set({
			lastMessageText: sql`CASE WHEN ${isNewer} THEN ${data.text ?? null} ELSE ${inboxConversations.lastMessageText} END`,
			lastMessageAt: sql`GREATEST(COALESCE(${inboxConversations.lastMessageAt}, ${nowTs}), ${nowTs})`,
			lastMessageDirection: sql`CASE WHEN ${isNewer} THEN ${data.direction} ELSE ${inboxConversations.lastMessageDirection} END`,
			messageCount: sql`${inboxConversations.messageCount} + 1`,
			unreadCount:
				data.direction === "inbound"
					? sql`${inboxConversations.unreadCount} + CASE WHEN ${isNewer} THEN 1 ELSE 0 END`
					: inboxConversations.unreadCount,
			updatedAt: insertedAt,
		})
		.where(eq(inboxConversations.id, data.conversationId));

	return message;
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

	const conditions: (SQL | undefined)[] = [
		eq(inboxConversations.organizationId, orgId),
	];

	// Workspace scope enforcement — include org-level (NULL workspace) resources
	if (filters?.workspaceScope && filters.workspaceScope !== "all") {
		conditions.push(
			or(
				inArray(inboxConversations.workspaceId, filters.workspaceScope),
				isNull(inboxConversations.workspaceId),
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
			eq(inboxConversations.platform, filters.platform as Conversation["platform"]),
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
		const labelConditions = filters.labels.map((label) =>
			sql`${label} = ANY(${inboxConversations.labels})`,
		);
		conditions.push(or(...labelConditions));
	}

	if (filters?.cursor) {
		// Cursor is an ISO timestamp — fetch rows strictly older than the cursor
		conditions.push(lt(inboxConversations.updatedAt, new Date(filters.cursor)));
	}

	// Fetch limit+1 to check if there are more rows
	const rows = await db
		.select()
		.from(inboxConversations)
		.where(and(...conditions))
		.orderBy(desc(inboxConversations.updatedAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = hasMore ? rows.slice(0, limit) : rows;
	const lastRow = data[data.length - 1];
	const nextCursor =
		hasMore && lastRow ? lastRow.updatedAt.toISOString() : null;

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
			or(
				inArray(inboxConversations.workspaceId, workspaceScope),
				isNull(inboxConversations.workspaceId),
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
		const wsScope = filters.workspaceScope;
		conditions.push(
			sql`${inboxMessages.conversationId} IN (
				SELECT ${inboxConversations.id} FROM ${inboxConversations}
				WHERE ${inboxConversations.organizationId} = ${orgId}
				AND ${inboxConversations.workspaceId} IN (${sql.join(wsScope.map(w => sql`${w}`), sql`, `)})
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

	if (filters?.cursor) {
		conditions.push(lt(inboxMessages.createdAt, new Date(filters.cursor)));
	}

	const rows = await db
		.select()
		.from(inboxMessages)
		.where(and(...conditions))
		.orderBy(desc(inboxMessages.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = hasMore ? rows.slice(0, limit) : rows;
	const lastRow = data[data.length - 1];
	const nextCursor =
		hasMore && lastRow ? lastRow.createdAt.toISOString() : null;

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
			or(
				inArray(inboxConversations.workspaceId, filters.workspaceScope),
				isNull(inboxConversations.workspaceId),
			),
		);
	}

	if (filters?.platform) {
		conditions.push(
			eq(inboxConversations.platform, filters.platform as Conversation["platform"]),
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
			unread: sql<number>`COALESCE(SUM(${inboxConversations.unreadCount}), 0)`.mapWith(Number),
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
			or(
				inArray(inboxConversations.workspaceId, workspaceScope),
				isNull(inboxConversations.workspaceId),
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
