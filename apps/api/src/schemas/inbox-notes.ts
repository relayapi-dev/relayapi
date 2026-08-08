import { z } from "@hono/zod-openapi";
import { INBOX_NOTE_ACTOR_TYPES } from "@relayapi/db";

export const InboxNote = z
	.object({
		id: z.string().openapi({ example: "note_abc123" }),
		conversation_id: z.string(),
		organization_id: z.string(),
		actor_type: z.enum(INBOX_NOTE_ACTOR_TYPES),
		actor_id: z.string(),
		user_id: z.string().nullable(),
		author_name: z.string().nullable(),
		author_email: z.string().nullable(),
		text: z.string(),
		created_at: z.string(),
		updated_at: z.string(),
	})
	.openapi("InboxNote");

export const ListInboxNotesResponse = z
	.object({
		data: z.array(InboxNote),
	})
	.openapi("ListInboxNotesResponse");

export const CreateInboxNoteBody = z
	.object({
		text: z.string().min(1).max(5000),
	})
	.strict()
	.openapi("CreateInboxNoteBody");

export const UpdateInboxNoteBody = z
	.object({
		text: z.string().min(1).max(5000),
	})
	.strict()
	.openapi("UpdateInboxNoteBody");

export const InboxNoteResponse = z
	.object({
		note: InboxNote,
	})
	.openapi("InboxNoteResponse");

export const DeleteInboxNoteResponse = z
	.object({
		success: z.boolean(),
	})
	.openapi("DeleteInboxNoteResponse");

export const NoteIdParam = z.object({
	noteId: z.string().openapi({ param: { name: "noteId", in: "path" } }),
});
