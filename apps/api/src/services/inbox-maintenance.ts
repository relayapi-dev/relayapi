/**
 * Bounded inbox lifecycle maintenance.
 *
 * 1. Stale open conversations are closed in due order.
 * 2. Ninety days after close, participant/message content is minimized unless
 *    an active organization/workspace erasure hold pauses that unit.
 * 3. R2 avatar deletion intent is committed with the database redaction and is
 *    reconciled independently by the external-subject cleanup worker.
 */

import {
	createDb,
	type Database,
	inboxConversations,
} from "@relayapi/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../types";
import { enqueueExactObjectCleanup } from "./external-subject-cleanup";

export const INBOX_STALE_CLOSE_MS = 90 * 24 * 60 * 60 * 1_000;
export const INBOX_POST_CLOSE_CONTENT_RETENTION_MS =
	90 * 24 * 60 * 60 * 1_000;
export const INBOX_MAINTENANCE_BATCH_SIZE = 500;
export const INBOX_MESSAGE_REDACTION_BATCH_SIZE = 2_000;
export const INBOX_NOTE_DELETION_BATCH_SIZE = 2_000;

interface DueConversation {
	id: string;
	organizationId: string;
	workspaceId: string | null;
	participantAvatarObjectKey: string | null;
}

interface InboxMaintenanceOptions {
	db?: Database;
	now?: Date;
	limit?: number;
}

export interface InboxMaintenanceResult {
	closed: number;
	redacted: number;
	messagesRedacted: number;
	notesDeleted: number;
	avatarCleanupJobs: number;
}

function boundedLimit(requested: number | undefined): number {
	return Math.min(
		Math.max(Math.trunc(requested ?? INBOX_MAINTENANCE_BATCH_SIZE), 1),
		1_000,
	);
}

async function closeStaleConversations(
	db: Database,
	now: Date,
	limit: number,
): Promise<number> {
	const cutoff = new Date(now.getTime() - INBOX_STALE_CLOSE_MS);
	const contentExpiresAt = new Date(
		now.getTime() + INBOX_POST_CLOSE_CONTENT_RETENTION_MS,
	);
	const rows = (await db.execute(sql`
		WITH due AS (
			SELECT id
			  FROM inbox_conversations
			 WHERE status = 'open'
			   AND COALESCE(last_message_at, created_at) <= ${cutoff}
			 ORDER BY COALESCE(last_message_at, created_at) ASC, id ASC
			 LIMIT ${limit}
			 FOR UPDATE SKIP LOCKED
		)
		UPDATE inbox_conversations AS conversation
		   SET status = 'archived',
		       closed_at = ${now},
		       content_expires_at = ${contentExpiresAt},
		       content_redacted_at = NULL,
		       updated_at = ${now}
		  FROM due
		 WHERE conversation.id = due.id
		RETURNING conversation.id
	`)) as unknown as Array<{ id: string }>;
	return rows.length;
}

/**
 * Lock the same tenant roots that hold placement locks with FOR UPDATE, then
 * re-evaluate active holds before claiming conversations. This prevents a hold
 * placement racing between our eligibility check and destructive redaction.
 */
async function claimDueConversations(
	tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
	now: Date,
	limit: number,
): Promise<DueConversation[]> {
	const candidates = (await tx.execute(sql`
		SELECT id,
		       organization_id AS "organizationId",
		       workspace_id AS "workspaceId"
		  FROM inbox_conversations
		 WHERE status = 'archived'
		   AND content_redacted_at IS NULL
		   AND content_expires_at <= ${now}
		   AND NOT EXISTS (
		         SELECT 1
		           FROM erasure_holds AS hold
		          WHERE hold.released_at IS NULL
		            AND hold.organization_tombstone_id =
		                inbox_conversations.organization_id
		            AND (
		                  (
		                    hold.subject_kind = 'organization'
		                    AND hold.subject_id =
		                        inbox_conversations.organization_id
		                  )
		                  OR (
		                    hold.subject_kind = 'workspace'
		                    AND hold.subject_id =
		                        inbox_conversations.workspace_id
		                  )
		                )
		       )
		 ORDER BY content_expires_at ASC, id ASC
		 LIMIT ${limit}
	`)) as unknown as Array<{
		id: string;
		organizationId: string;
		workspaceId: string | null;
	}>;
	if (candidates.length === 0) return [];

	const organizationIds = [
		...new Set(candidates.map(({ organizationId }) => organizationId)),
	].sort();
	const workspaceIds = [
		...new Set(
			candidates.flatMap(({ workspaceId }) =>
				workspaceId ? [workspaceId] : [],
			),
		),
	].sort();

	await tx.execute(sql`
		SELECT id
		  FROM organization
		 WHERE id = ANY(${organizationIds}::text[])
		 ORDER BY id
		 FOR SHARE
	`);
	if (workspaceIds.length > 0) {
		await tx.execute(sql`
			SELECT id
			  FROM workspaces
			 WHERE id = ANY(${workspaceIds}::text[])
			 ORDER BY id
			 FOR SHARE
		`);
	}

	return (await tx.execute(sql`
		SELECT conversation.id,
		       conversation.organization_id AS "organizationId",
		       conversation.workspace_id AS "workspaceId",
		       conversation.participant_avatar_object_key
		         AS "participantAvatarObjectKey"
		  FROM inbox_conversations AS conversation
		 WHERE conversation.id = ANY(${candidates.map(({ id }) => id)}::text[])
		   AND conversation.status = 'archived'
		   AND conversation.content_redacted_at IS NULL
		   AND conversation.content_expires_at <= ${now}
		   AND NOT EXISTS (
		         SELECT 1
		           FROM erasure_holds AS hold
		          WHERE hold.released_at IS NULL
		            AND hold.organization_tombstone_id =
		                conversation.organization_id
		            AND (
		                  (
		                    hold.subject_kind = 'organization'
		                    AND hold.subject_id = conversation.organization_id
		                  )
		                  OR (
		                    hold.subject_kind = 'workspace'
		                    AND hold.subject_id = conversation.workspace_id
		                  )
		                )
		       )
		 ORDER BY conversation.content_expires_at ASC, conversation.id ASC
		 FOR UPDATE OF conversation SKIP LOCKED
	`)) as unknown as DueConversation[];
}

async function redactDueConversations(
	db: Database,
	now: Date,
	limit: number,
): Promise<{
	redacted: number;
	messagesRedacted: number;
	notesDeleted: number;
	avatarCleanupJobs: number;
}> {
	return db.transaction(async (tx) => {
		const conversations = await claimDueConversations(tx, now, limit);
		if (conversations.length === 0) {
			return {
				redacted: 0,
				messagesRedacted: 0,
				notesDeleted: 0,
				avatarCleanupJobs: 0,
			};
		}
		const conversationIds = conversations.map(({ id }) => id);
		const messages = (await tx.execute(sql`
			WITH due AS (
				SELECT message.id
				  FROM inbox_messages AS message
				  JOIN inbox_conversations AS conversation
				    ON conversation.id = message.conversation_id
				   AND conversation.organization_id = message.organization_id
				 WHERE conversation.id = ANY(${conversationIds}::text[])
				   AND message.content_redacted_at IS NULL
				 ORDER BY conversation.content_expires_at ASC,
				          conversation.id ASC,
				          message.id ASC
				 LIMIT ${INBOX_MESSAGE_REDACTION_BATCH_SIZE}
				 FOR UPDATE OF message SKIP LOCKED
			)
			UPDATE inbox_messages AS message
			   SET author_name = NULL,
			       author_platform_id = NULL,
			       author_avatar_url = NULL,
			       text = NULL,
			       attachments = '[]'::jsonb,
			       sentiment_score = NULL,
			       classification = NULL,
			       platform_data = '{}'::jsonb,
			       is_liked = FALSE,
			       content_redacted_at = ${now}
			  FROM due
			 WHERE message.id = due.id
			RETURNING message.id
		`)) as unknown as Array<{ id: string }>;
		const messageIds = messages.map(({ id }) => id);

		// Retention cannot replay an old effect after its source payload has been
		// destroyed. Preserve completed/unknown evidence; fence pending/in-flight
		// work to unknown and remove only the replay body. The effect fanout is
		// schema-bounded to the three effect kinds per selected message.
		if (messageIds.length > 0) {
			await tx.execute(sql`
			UPDATE inbox_event_effects AS effect
			   SET status = CASE
			                  WHEN effect.status IN ('pending', 'in_flight')
			                    THEN 'unknown'
			                  ELSE effect.status
			                END,
			       replay_payload = NULL,
			       lease_token = CASE
			                       WHEN effect.status = 'in_flight'
			                         THEN effect.lease_token + 1
			                       ELSE effect.lease_token
			                     END,
			       lease_expires_at = NULL,
			       last_enqueued_at = NULL,
			       error = CASE
			                 WHEN effect.status = 'completed' THEN effect.error
			                 ELSE 'inbox_content_retention_elapsed'
			               END,
			       updated_at = ${now}
			 WHERE EXISTS (
			         SELECT 1
			           FROM inbox_messages AS message
			          WHERE message.id = ANY(${messageIds}::text[])
			            AND message.organization_id = effect.organization_id
			            AND message.account_id = effect.account_id
			            AND message.platform_message_id =
			                effect.platform_event_id
			       )
			`);
		}

		const deletedNotes = (await tx.execute(sql`
			WITH due AS (
				SELECT note.id
				  FROM inbox_conversation_notes AS note
				  JOIN inbox_conversations AS conversation
				    ON conversation.id = note.conversation_id
				   AND conversation.organization_id = note.organization_id
				 WHERE conversation.id = ANY(${conversationIds}::text[])
				 ORDER BY conversation.content_expires_at ASC,
				          conversation.id ASC,
				          note.id ASC
				 LIMIT ${INBOX_NOTE_DELETION_BATCH_SIZE}
				 FOR UPDATE OF note SKIP LOCKED
			)
			DELETE FROM inbox_conversation_notes AS note
			      USING due
			      WHERE note.id = due.id
			RETURNING note.id
		`)) as unknown as Array<{ id: string }>;

		const finalizable = (await tx.execute(sql`
			SELECT conversation.id
			  FROM inbox_conversations AS conversation
			 WHERE conversation.id = ANY(${conversationIds}::text[])
			   AND NOT EXISTS (
			         SELECT 1
			           FROM inbox_messages AS message
			          WHERE message.conversation_id = conversation.id
			            AND message.content_redacted_at IS NULL
			       )
			   AND NOT EXISTS (
			         SELECT 1
			           FROM inbox_conversation_notes AS note
			          WHERE note.conversation_id = conversation.id
			       )
			 ORDER BY conversation.content_expires_at ASC, conversation.id ASC
			 LIMIT ${limit}
		`)) as unknown as Array<{ id: string }>;
		const finalizableIds = finalizable.map(({ id }) => id);
		if (finalizableIds.length === 0) {
			return {
				redacted: 0,
				messagesRedacted: messages.length,
				notesDeleted: deletedNotes.length,
				avatarCleanupJobs: 0,
			};
		}
		const finalizableIdSet = new Set(finalizableIds);
		let avatarCleanupJobs = 0;
		for (const conversation of conversations) {
			if (
				!finalizableIdSet.has(conversation.id) ||
				!conversation.participantAvatarObjectKey
			) {
				continue;
			}
			const inserted = await enqueueExactObjectCleanup(
				tx,
				conversation.workspaceId
					? {
							subjectKind: "workspace",
							subjectId: conversation.workspaceId,
							organizationId: conversation.organizationId,
							workspaceId: conversation.workspaceId,
							bucket: "media",
							objectLocator: conversation.participantAvatarObjectKey,
						}
					: {
							subjectKind: "organization",
							subjectId: conversation.organizationId,
							organizationId: conversation.organizationId,
							workspaceId: null,
							bucket: "media",
							objectLocator: conversation.participantAvatarObjectKey,
						},
				now,
			);
			if (inserted) avatarCleanupJobs++;
		}

		const redacted = await tx
			.update(inboxConversations)
			.set({
				contactId: null,
				contactSubjectLocator: null,
				contactSubjectIdentityKeyFingerprint: null,
				participantName: null,
				participantPlatformId: null,
				participantAvatar: null,
				participantAvatarObjectKey: null,
				participantMetadata: {},
				assignedUserId: null,
				priority: "normal",
				labels: [],
				unreadCount: 0,
				lastMessageText: null,
				sentimentAvg: null,
				contentRedactedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					inArray(inboxConversations.id, finalizableIds),
					eq(inboxConversations.status, "archived"),
				),
			)
			.returning({ id: inboxConversations.id });

		if (redacted.length !== finalizableIds.length) {
			throw new Error("Inbox retention lost its locked conversation set");
		}
		return {
			redacted: redacted.length,
			messagesRedacted: messages.length,
			notesDeleted: deletedNotes.length,
			avatarCleanupJobs,
		};
	});
}

/**
 * Close and minimize at most one bounded page per invocation. The 30-minute
 * schedule gives 24,000 rows/day of steady-state capacity at the default batch.
 */
export async function cleanupOldConversations(
	env: Env,
	options: InboxMaintenanceOptions = {},
): Promise<InboxMaintenanceResult> {
	const db = options.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options.now ?? new Date();
	const limit = boundedLimit(options.limit);
	const closed = await closeStaleConversations(db, now, limit);
	const { redacted, messagesRedacted, notesDeleted, avatarCleanupJobs } =
		await redactDueConversations(db, now, limit);
	const result = {
		closed,
		redacted,
		messagesRedacted,
		notesDeleted,
		avatarCleanupJobs,
	};
	console.log("[inbox-maintenance] lifecycle batch complete", result);
	return result;
}
