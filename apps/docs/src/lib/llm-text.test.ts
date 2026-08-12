/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
	findOperationById,
	generateApiPageContent,
	operationIdFromPageUrl,
} from "./llm-text";

describe("LLM API operation resolution", () => {
	test("uses the operation id encoded in generated page URLs", () => {
		expect(operationIdFromPageUrl("/api-reference/inbox/deleteComment")).toBe(
			"deleteComment",
		);
		expect(findOperationById("deleteComment")).toMatchObject({
			method: "DELETE",
			path: "/v1/inbox/comments/{comment_id}",
		});
		expect(findOperationById("deleteIdeaComment")).toMatchObject({
			method: "DELETE",
			path: "/v1/ideas/{id}/comments/{comment_id}",
		});
	});

	test("does not confuse pages that share the same title", async () => {
		const inbox = await generateApiPageContent({
			data: { title: "Delete a comment" },
			url: "/api-reference/inbox/deleteComment",
		});
		const ideas = await generateApiPageContent({
			data: { title: "Delete a comment" },
			url: "/api-reference/ideas/deleteIdeaComment",
		});

		expect(inbox).toContain(
			"`DELETE https://api.relayapi.dev/v1/inbox/comments/{comment_id}`",
		);
		expect(inbox).not.toContain("/v1/ideas/");
		expect(ideas).toContain(
			"`DELETE https://api.relayapi.dev/v1/ideas/{id}/comments/{comment_id}`",
		);
	});
});
