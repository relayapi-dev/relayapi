import { describe, expect, it } from "bun:test";
import {
	inboxConversationNotes,
	inboxConversations,
	inboxMessages,
} from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	INBOX_MAINTENANCE_BATCH_SIZE,
	INBOX_MESSAGE_REDACTION_BATCH_SIZE,
	INBOX_NOTE_DELETION_BATCH_SIZE,
	INBOX_POST_CLOSE_CONTENT_RETENTION_MS,
} from "../services/inbox-maintenance";

describe("inbox-content-retention", () => {
	it("pins bounded 90-day conversation, message, and note drains", () => {
		expect(INBOX_POST_CLOSE_CONTENT_RETENTION_MS).toBe(
			90 * 24 * 60 * 60 * 1_000,
		);
		expect(INBOX_MAINTENANCE_BATCH_SIZE).toBe(500);
		expect(INBOX_MESSAGE_REDACTION_BATCH_SIZE).toBe(2_000);
		expect(INBOX_NOTE_DELETION_BATCH_SIZE).toBe(2_000);

		const conversation = getTableConfig(inboxConversations);
		const message = getTableConfig(inboxMessages);
		const note = getTableConfig(inboxConversationNotes);
		expect(conversation.columns.map(({ name }) => name)).toEqual(
			expect.arrayContaining([
				"closed_at",
				"content_expires_at",
				"content_redacted_at",
			]),
		);
		expect(message.columns.map(({ name }) => name)).toContain(
			"content_redacted_at",
		);
		expect(conversation.indexes.map(({ config }) => config.name)).toEqual(
			expect.arrayContaining([
				"inbox_conv_open_activity_idx",
				"inbox_conv_content_retention_due_idx",
			]),
		);
		expect(message.indexes.map(({ config }) => config.name)).toContain(
			"inbox_msg_content_retention_pending_idx",
		);
		expect(note.indexes.map(({ config }) => config.name)).toContain(
			"inbox_note_conv_created_idx",
		);
	});

	it("redacts child content in hard pages before finalizing the parent", async () => {
		const source = await Bun.file(
			new URL("../services/inbox-maintenance.ts", import.meta.url),
		).text();
		for (const marker of [
			"LIMIT ${INBOX_MESSAGE_REDACTION_BATCH_SIZE}",
			"LIMIT ${INBOX_NOTE_DELETION_BATCH_SIZE}",
			"message.content_redacted_at IS NULL",
			"NOT EXISTS (",
			"enqueueExactObjectCleanup",
			"FOR UPDATE OF conversation SKIP LOCKED",
			"FOR SHARE",
		]) {
			expect(source).toContain(marker);
		}
		expect(source.indexOf("UPDATE inbox_messages")).toBeLessThan(
			source.indexOf("contentRedactedAt: now"),
		);
	});

	it("serializes note creation against final conversation redaction", async () => {
		const source = await Bun.file(
			new URL("../routes/inbox-feed.ts", import.meta.url),
		).text();
		const createNote = source.slice(
			source.indexOf("app.openapi(createNoteRoute"),
			source.indexOf("// Notes — update"),
		);
		expect(createNote).toContain('.for("key share")');
		expect(createNote).toContain("lockedConversation.contentRedactedAt");
		expect(createNote).toContain(
			"Conversation content retention has elapsed",
		);
	});
});
