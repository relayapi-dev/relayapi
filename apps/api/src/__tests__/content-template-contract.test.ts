import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	ContentTemplateResponse,
	CreateContentTemplateBody,
	UpdateContentTemplateBody,
} from "../schemas/content-templates";

describe("content template API contract", () => {
	it("creates organization-shared definitions and rejects an ignored workspace", () => {
		const valid = CreateContentTemplateBody.safeParse({
			name: "Weekly update",
			content: "Hello {{account_name}}",
		});
		expect(valid.success).toBe(true);
		if (valid.success) expect(valid.data.tags).toEqual([]);

		expect(
			CreateContentTemplateBody.safeParse({
				name: "Weekly update",
				content: "Hello",
				workspace_id: "ws_ignored",
			}).success,
		).toBe(false);
		expect(
			UpdateContentTemplateBody.safeParse({ workspace_id: "ws_ignored" })
				.success,
		).toBe(false);
	});

	it("keeps legacy scoped rows readable while new rows serialize with null scope", () => {
		const response = {
			id: "tmpl_1",
			name: "Weekly update",
			description: null,
			content: "Hello",
			platform_overrides: null,
			tags: [],
			workspace_id: null,
			created_at: "2026-08-08T10:00:00.000Z",
			updated_at: "2026-08-08T10:00:00.000Z",
		};

		expect(ContentTemplateResponse.safeParse(response).success).toBe(true);
		expect(
			ContentTemplateResponse.safeParse({
				...response,
				workspace_id: "ws_legacy",
			}).success,
		).toBe(true);
	});

	it("checks a legacy template workspace before rendering it into a post", () => {
		const posts = readFileSync(
			new URL("../routes/posts.ts", import.meta.url),
			"utf8",
		);
		const createHandler = posts.slice(
			posts.indexOf("app.openapi(createPostRoute"),
		);
		const templateLookup = createHandler.indexOf(".from(contentTemplates)");
		const workspaceFence = createHandler.indexOf(
			"assertWorkspaceScope(c, tmpl.workspaceId)",
		);
		const templateRender = createHandler.indexOf("renderPostTemplate(");

		expect(templateLookup).toBeGreaterThan(-1);
		expect(workspaceFence).toBeGreaterThan(templateLookup);
		expect(templateRender).toBeGreaterThan(workspaceFence);
		expect(createHandler.slice(workspaceFence, templateRender)).toContain(
			"markMutationInputNotApplied(c)",
		);
	});
});
