import { describe, expect, it } from "bun:test";
import { BULK_USAGE_COMMITTED_FIELDS } from "../middleware/usage-tracking";
import { BroadcastResponse } from "../schemas/broadcasts";
import {
	BulkCreateContactsResponse,
	BulkOperationsResponse,
} from "../schemas/contacts";
import { BulkActionResponse } from "../schemas/inbox-feed";
import { BulkCsvResponse } from "../schemas/posts";

const expectedFields = {
	"/v1/posts/bulk": ["summary", "succeeded"],
	"/v1/posts/bulk-csv": ["summary", "posts_created"],
	"/v1/contacts/bulk": ["created"],
	"/v1/contacts/bulk-operations": ["affected"],
	"/v1/whatsapp/bulk-send": ["recipient_count"],
	"/v1/inbox/bulk": ["processed"],
} as const;

describe("bulk usage response authority", () => {
	it("keeps every settlement field explicit and closed", () => {
		expect(BULK_USAGE_COMMITTED_FIELDS).toEqual(expectedFields);
	});

	it("keeps exported response schemas aligned with settlement fields", () => {
		expect(
			BulkCsvResponse.safeParse({
				data: [],
				summary: {
					total_rows: 3,
					succeeded: 2,
					failed: 1,
					skipped: 0,
					posts_created: 2,
				},
			}).success,
		).toBe(true);
		expect(
			BulkCreateContactsResponse.safeParse({ created: 2, skipped: 1 }).success,
		).toBe(true);
		expect(BulkOperationsResponse.safeParse({ affected: 2 }).success).toBe(
			true,
		);
		expect(
			BroadcastResponse.safeParse({
				id: "brd_1",
				name: "Bulk send",
				description: null,
				platform: "whatsapp",
				account_id: "acc_1",
				status: "scheduled",
				message_text: null,
				template_name: "welcome",
				template_language: "en",
				recipient_count: 2,
				sent_count: 0,
				failed_count: 0,
				scheduled_at: null,
				completed_at: null,
				created_at: new Date().toISOString(),
			}).success,
		).toBe(true);
		expect(
			BulkActionResponse.safeParse({ processed: 2, failed: 1, errors: [] })
				.success,
		).toBe(true);
	});

	it("keeps real route handlers aligned with all six settlement fields", async () => {
		const [posts, contacts, whatsapp, inbox] = await Promise.all([
			Bun.file(new URL("../routes/posts.ts", import.meta.url)).text(),
			Bun.file(new URL("../routes/contacts.ts", import.meta.url)).text(),
			Bun.file(new URL("../routes/whatsapp.ts", import.meta.url)).text(),
			Bun.file(new URL("../routes/inbox-feed.ts", import.meta.url)).text(),
		]);
		const handlers = [
			posts.slice(
				posts.indexOf("app.openapi(bulkCreatePosts"),
				posts.indexOf(
					"app.openapi(unpublishPost",
					posts.indexOf("app.openapi(bulkCreatePosts"),
				),
			),
			posts.slice(
				posts.indexOf("app.openapi(bulkCsvUpload"),
				posts.indexOf(
					"export default",
					posts.indexOf("app.openapi(bulkCsvUpload"),
				),
			),
			contacts.slice(
				contacts.indexOf("app.openapi(bulkCreate"),
				contacts.indexOf("app.openapi(bulkOperations"),
			),
			contacts.slice(
				contacts.indexOf("app.openapi(bulkOperations"),
				contacts.indexOf("app.openapi(mergeContact"),
			),
			whatsapp.slice(
				whatsapp.indexOf("app.openapi(bulkSend"),
				whatsapp.indexOf("app.openapi(listTemplates"),
			),
			inbox.slice(
				inbox.indexOf("app.openapi(bulkRoute"),
				inbox.indexOf("const statsRoute"),
			),
		];
		const fieldPaths = Object.values(expectedFields);
		expect(handlers).toHaveLength(fieldPaths.length);
		for (const [index, handler] of handlers.entries()) {
			const fieldPath = fieldPaths[index];
			expect(fieldPath).toBeDefined();
			expect(handler.length).toBeGreaterThan(0);
			for (const field of fieldPath ?? []) expect(handler).toContain(field);
		}
	});
});
