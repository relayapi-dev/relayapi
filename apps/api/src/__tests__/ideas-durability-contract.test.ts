import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	ideaActivity,
	ideaComments,
	ideaConversionOperations,
	ideaGroups,
	ideaMedia,
	ideas,
	media,
	organizationPrincipals,
	posts,
} from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	ConvertIdeaBody,
	CreateIdeaBody,
	MoveIdeaBody,
	UpdateIdeaBody,
} from "../schemas/ideas";

function indexColumns(
	table: Parameters<typeof getTableConfig>[0],
	name: string,
): string[] | undefined {
	return getTableConfig(table)
		.indexes.find((index) => index.config.name === name)
		?.config.columns.flatMap((column) =>
			typeof (column as { name?: unknown }).name === "string"
				? [(column as { name: string }).name]
				: [],
		);
}

function foreignKeyColumns(
	table: Parameters<typeof getTableConfig>[0],
	foreignTable: Parameters<typeof getTableConfig>[0],
): { local: string[]; foreign: string[] } | undefined {
	const foreignKey = getTableConfig(table).foreignKeys.find(
		(candidate) => candidate.reference().foreignTable === foreignTable,
	);
	if (!foreignKey) return undefined;
	const reference = foreignKey.reference();
	return {
		local: reference.columns.map((column) => column.name),
		foreign: reference.foreignColumns.map((column) => column.name),
	};
}

describe("Ideas durable schema contracts", () => {
	it("uses exact-scope durable media ownership instead of raw URL rows", () => {
		expect(ideaMedia.mediaId).toBeDefined();
		expect("url" in ideaMedia).toBe(false);
		expect(foreignKeyColumns(ideaMedia, ideas)).toEqual({
			local: ["idea_id", "organization_id", "scope_key"],
			foreign: ["id", "organization_id", "scope_key"],
		});
		expect(foreignKeyColumns(ideaMedia, media)).toEqual({
			local: ["media_id", "organization_id", "scope_key"],
			foreign: ["id", "organization_id", "scope_key"],
		});
		expect(indexColumns(ideaMedia, "idea_media_idea_position_uniq")).toEqual([
			"idea_id",
			"position",
		]);
		expect(indexColumns(ideaMedia, "idea_media_media_uniq")).toEqual([
			"media_id",
		]);
	});

	it("fences default groups, ordering, and conversion identity in PostgreSQL", () => {
		const groupConfig = getTableConfig(ideaGroups);
		const defaultIndex = groupConfig.indexes.find(
			(index) => index.config.name === "idea_groups_default_per_scope_uniq",
		);
		expect(defaultIndex?.config.unique).toBe(true);
		expect(defaultIndex?.config.where).toBeDefined();
		expect(ideaGroups.position.getSQLType()).toBe("integer");
		expect(ideas.position.getSQLType()).toBe("integer");
		expect(indexColumns(ideas, "ideas_group_position_uniq")).toEqual([
			"group_id",
			"organization_id",
			"scope_key",
			"position",
		]);
		expect(foreignKeyColumns(ideas, posts)).toEqual({
			local: ["converted_to_post_id", "organization_id", "scope_key"],
			foreign: ["id", "organization_id", "scope_key"],
		});
		expect(
			indexColumns(
				ideaConversionOperations,
				"idea_conversion_operations_org_idempotency_uniq",
			),
		).toEqual(["organization_id", "idempotency_key"]);
	});

	it("binds comments and activity to the exact tenant and stable principal", () => {
		expect(foreignKeyColumns(ideaComments, ideas)).toEqual({
			local: ["idea_id", "organization_id"],
			foreign: ["id", "organization_id"],
		});
		expect(foreignKeyColumns(ideaComments, organizationPrincipals)).toEqual({
			local: ["author_principal_id", "organization_id"],
			foreign: ["id", "organization_id"],
		});
		expect(foreignKeyColumns(ideaActivity, ideas)).toEqual({
			local: ["idea_id", "organization_id"],
			foreign: ["id", "organization_id"],
		});
		expect(foreignKeyColumns(ideaActivity, organizationPrincipals)).toEqual({
			local: ["actor_principal_id", "organization_id"],
			foreign: ["id", "organization_id"],
		});
	});
});

describe("Ideas API durability contracts", () => {
	it("requires optimistic revisions and a stable conversion identity", () => {
		expect(UpdateIdeaBody.safeParse({ title: "new" }).success).toBe(false);
		expect(MoveIdeaBody.safeParse({ group_id: "idg_next" }).success).toBe(
			false,
		);
		expect(ConvertIdeaBody.safeParse({ expected_revision: 0 }).success).toBe(
			false,
		);
		expect(
			ConvertIdeaBody.safeParse({
				expected_revision: 0,
				idempotency_key: "convert-1",
			}).success,
		).toBe(true);
		const parsed = CreateIdeaBody.parse({
			title: "No URL attachment",
			media: [{ url: "https://example.com/unowned.jpg" }],
		});
		expect("media" in parsed).toBe(false);
	});

	it("commits upload intent before R2 and has a stale-intent reconciler", () => {
		const route = readFileSync(
			new URL("../routes/ideas.ts", import.meta.url),
			"utf8",
		);
		const upload = route.slice(route.indexOf("const uploadIdeaMedia"));
		expect(upload.indexOf(".insert(media)")).toBeGreaterThan(-1);
		expect(upload.indexOf("MEDIA_BUCKET.put")).toBeGreaterThan(
			upload.indexOf(".insert(media)"),
		);
		expect(upload).toContain('status: "upload_failed"');
		expect(upload).toContain("processMediaDeletion");

		const reliability = readFileSync(
			new URL("../services/media-reliability.ts", import.meta.url),
			"utf8",
		);
		const reconciler = reliability.slice(
			reliability.indexOf("export async function reconcileMediaUploads"),
			reliability.indexOf("export function isMediaEventMessage"),
		);
		expect(reconciler).toContain("headStoredObject");
		expect(reconciler).toContain("storageLocatorForMedia(row)");
		expect(reconciler).toContain("tx.delete(ideaMedia)");
		expect(reconciler).toContain('status: "ready"');
	});

	it("uses stable principals for every idea writer and ownership check", () => {
		const route = readFileSync(
			new URL("../routes/ideas.ts", import.meta.url),
			"utf8",
		);
		expect(route).not.toContain('c.get("keyId")');
		expect(route).not.toContain("authorId:");
		expect(route).not.toContain("actorId:");
		expect(route).toContain('c.get("principalId")');
		expect(route).toContain("authorPrincipalId: principalId");
		expect(route).toContain("actorPrincipalId: principalId");
		expect(route).toContain("comment.authorPrincipalId !== principalId");
		expect(route).toContain(
			"eq(organizationPrincipals.organizationId, organizationId)",
		);

		const apiKeys = readFileSync(
			new URL("../routes/api-keys.ts", import.meta.url),
			"utf8",
		);
		const retirement = apiKeys.slice(
			apiKeys.indexOf("app.openapi(deleteApiKey"),
		);
		expect(retirement).not.toContain(".delete(organizationPrincipals)");
		expect(retirement).toContain('lifecycleStatus: "disabled"');
		expect(retirement).toContain(".delete(principalWorkspaceGrants)");
	});
});
