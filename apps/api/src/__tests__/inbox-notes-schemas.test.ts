import { describe, expect, it } from "bun:test";
import { resolveInboxNoteActor } from "../lib/inbox-note-actor";
import {
	CreateInboxNoteBody,
	InboxNote,
	UpdateInboxNoteBody,
} from "../schemas/inbox-notes";

describe("inbox note request schemas", () => {
	for (const [name, schema] of [
		["create", CreateInboxNoteBody],
		["update", UpdateInboxNoteBody],
	] as const) {
		it(`${name} accepts note text without client-supplied identity`, () => {
			expect(schema.safeParse({ text: "Internal note" }).success).toBe(true);
		});

		it(`${name} rejects client-supplied user impersonation fields`, () => {
			expect(
				schema.safeParse({ text: "Internal note", user_id: "user_victim" })
					.success,
			).toBe(false);
		});

		it(`${name} enforces the text bounds`, () => {
			expect(schema.safeParse({ text: "" }).success).toBe(false);
			expect(schema.safeParse({ text: "a".repeat(5000) }).success).toBe(true);
			expect(schema.safeParse({ text: "a".repeat(5001) }).success).toBe(false);
		});
	}
});

describe("resolveInboxNoteActor", () => {
	it("binds dashboard notes to the authenticated user", () => {
		expect(
			resolveInboxNoteActor({
				principalType: "dashboard_user",
				principalId: "user_123",
				keyId: "key_dashboard",
			}),
		).toEqual({
			actorType: "dashboard_user",
			actorId: "user_123",
			userId: "user_123",
		});
	});

	it("binds service notes to the authenticated API key", () => {
		expect(
			resolveInboxNoteActor({
				principalType: "service",
				principalId: null,
				keyId: "key_service",
			}),
		).toEqual({
			actorType: "service",
			actorId: "key_service",
			userId: null,
		});
	});

	it("fails closed for a malformed dashboard credential", () => {
		expect(() =>
			resolveInboxNoteActor({
				principalType: "dashboard_user",
				principalId: null,
				keyId: "key_dashboard",
			}),
		).toThrow("missing its user id");
	});
});

describe("InboxNote response", () => {
	const base = {
		id: "note_abc123",
		conversation_id: "conv_1",
		organization_id: "org_1",
		actor_type: "dashboard_user" as const,
		actor_id: "user_1",
		user_id: "user_1",
		author_name: "Ada Lovelace",
		author_email: "ada@example.com",
		text: "internal note",
		created_at: "2026-04-20T00:00:00.000Z",
		updated_at: "2026-04-20T00:00:00.000Z",
	};

	it("accepts an authenticated dashboard actor", () => {
		expect(InboxNote.safeParse(base).success).toBe(true);
	});

	it("accepts a service actor without a user row", () => {
		expect(
			InboxNote.safeParse({
				...base,
				actor_type: "service",
				actor_id: "key_1",
				user_id: null,
				author_name: null,
				author_email: null,
			}).success,
		).toBe(true);
	});
});
