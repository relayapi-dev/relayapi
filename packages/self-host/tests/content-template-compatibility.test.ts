import { describe, expect, it } from "bun:test";

describe("self-host content template compatibility", () => {
	it("ships the organization-shared API contract without new infrastructure", async () => {
		const [readme, schema, route, posts] = await Promise.all([
			Bun.file(new URL("../README.md", import.meta.url)).text(),
			Bun.file(
				new URL(
					"../../../apps/api/src/schemas/content-templates.ts",
					import.meta.url,
				),
			).text(),
			Bun.file(
				new URL(
					"../../../apps/api/src/routes/content-templates.ts",
					import.meta.url,
				),
			).text(),
			Bun.file(
				new URL("../../../apps/api/src/routes/posts.ts", import.meta.url),
			).text(),
		]);

		expect(readme).toContain(
			"Content templates are organization-shared definitions",
		);
		expect(readme).toContain("adds no binding, secret, or migration");
		expect(schema).toContain("CreateContentTemplateBody");
		expect(schema.match(/\.strict\(\)/g)?.length).toBeGreaterThanOrEqual(2);
		expect(route).toContain("assertAllWorkspaceScope");
		expect(route).toContain("workspaceId: null");
		expect(posts).toContain("assertWorkspaceScope(c, tmpl.workspaceId)");
		expect(readme).toMatch(/rechecks the calling key's\s+workspace grant/);
	});
});
