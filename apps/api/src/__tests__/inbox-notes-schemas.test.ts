import { describe, it, expect } from "bun:test";
import {
	CreateInboxNoteBody,
	DeleteInboxNoteQuery,
	InboxNote,
	UpdateInboxNoteBody,
} from "../schemas/inbox-notes";

/**
 * Schema-only tests for the inbox notes API.
 *
 * Rationale for schema-only coverage: the full integration test surface for
 * these routes requires the mock DB to support `db.query.member.findFirst`
 * (Drizzle's relational query API), `and()` / `leftJoin()` composition, a
 * `delete()` chain, and `returning()` on inserts/updates — none of which the
 * existing `__mocks__/db.ts` harness implements. Extending it would roughly
 * double the mock's size and duplicate real Drizzle semantics, which is out
 * of scope for this task. The route handlers themselves are thin wrappers
 * around these Zod schemas plus Drizzle calls, so validating the schemas
 * gives us the highest-value coverage without rebuilding an ORM.
 */

describe("CreateInboxNoteBody", () => {
	it("parses a well-formed { text, user_id } payload", () => {
		const result = CreateInboxNoteBody.safeParse({
			text: "Hello team, this is an internal note.",
			user_id: "user_123",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.text).toBe("Hello team, this is an internal note.");
			expect(result.data.user_id).toBe("user_123");
		}
	});

	it("rejects a missing user_id", () => {
		const result = CreateInboxNoteBody.safeParse({ text: "hi" });
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) => i.path.includes("user_id"));
			expect(issue).toBeDefined();
		}
	});

	it("rejects empty text", () => {
		const result = CreateInboxNoteBody.safeParse({ text: "", user_id: "user_1" });
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) => i.path.includes("text"));
			expect(issue).toBeDefined();
		}
	});

	it("rejects text > 5000 chars", () => {
		const result = CreateInboxNoteBody.safeParse({
			text: "a".repeat(5001),
			user_id: "user_1",
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) => i.path.includes("text"));
			expect(issue).toBeDefined();
		}
	});

	it("accepts exactly 5000 chars (boundary)", () => {
		const result = CreateInboxNoteBody.safeParse({
			text: "a".repeat(5000),
			user_id: "user_1",
		});
		expect(result.success).toBe(true);
	});
});

describe("UpdateInboxNoteBody", () => {
	it("parses a well-formed { text, user_id } payload", () => {
		const result = UpdateInboxNoteBody.safeParse({
			text: "edited note",
			user_id: "user_123",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.text).toBe("edited note");
			expect(result.data.user_id).toBe("user_123");
		}
	});

	it("rejects a missing user_id", () => {
		const result = UpdateInboxNoteBody.safeParse({ text: "updated" });
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) => i.path.includes("user_id"));
			expect(issue).toBeDefined();
		}
	});

	it("rejects empty text", () => {
		const result = UpdateInboxNoteBody.safeParse({ text: "", user_id: "user_1" });
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) => i.path.includes("text"));
			expect(issue).toBeDefined();
		}
	});

	it("rejects text > 5000 chars", () => {
		const result = UpdateInboxNoteBody.safeParse({
			text: "z".repeat(5001),
			user_id: "user_1",
		});
		expect(result.success).toBe(false);
	});
});

describe("DeleteInboxNoteQuery", () => {
	it("parses { user_id }", () => {
		const result = DeleteInboxNoteQuery.safeParse({ user_id: "user_42" });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.user_id).toBe("user_42");
		}
	});

	it("rejects a missing user_id", () => {
		const result = DeleteInboxNoteQuery.safeParse({});
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) => i.path.includes("user_id"));
			expect(issue).toBeDefined();
		}
	});
});

describe("InboxNote", () => {
	const baseNote = {
		id: "note_abc123",
		conversation_id: "conv_1",
		organization_id: "org_1",
		user_id: "user_1",
		text: "internal note",
		created_at: "2026-04-20T00:00:00.000Z",
		updated_at: "2026-04-20T00:00:00.000Z",
	};

	it("accepts a complete note with author_name and author_email populated", () => {
		const result = InboxNote.safeParse({
			...baseNote,
			author_name: "Ada Lovelace",
			author_email: "ada@example.com",
		});
		expect(result.success).toBe(true);
	});

	it("accepts a note where author_name and author_email are explicitly null", () => {
		const result = InboxNote.safeParse({
			...baseNote,
			author_name: null,
			author_email: null,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.author_name).toBeNull();
			expect(result.data.author_email).toBeNull();
		}
	});

	it("rejects a note missing author_name", () => {
		const result = InboxNote.safeParse({
			...baseNote,
			author_email: null,
			// author_name omitted entirely
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) => i.path.includes("author_name"));
			expect(issue).toBeDefined();
		}
	});

	it("rejects a note missing author_email", () => {
		const result = InboxNote.safeParse({
			...baseNote,
			author_name: null,
			// author_email omitted entirely
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) => i.path.includes("author_email"));
			expect(issue).toBeDefined();
		}
	});

	it("rejects a note missing a required core field (id)", () => {
		const { id: _id, ...noId } = baseNote;
		const result = InboxNote.safeParse({
			...noId,
			author_name: null,
			author_email: null,
		});
		expect(result.success).toBe(false);
	});
});
