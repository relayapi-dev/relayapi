import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Database } from "@relayapi/db";
import ideasRouter, {
	InvalidIdeaRelationError,
	validateIdeaRelations,
} from "../routes/ideas";
import type { Env, Variables } from "../types";

type RelationRow = { kind: "group" | "tag"; id: string };

function executor(rows: RelationRow[]) {
	const calls: unknown[] = [];
	return {
		calls,
		db: {
			execute: async (query: unknown) => {
				calls.push(query);
				return rows;
			},
		} as unknown as Pick<Database, "execute">,
	};
}

function collectBoundValues(value: unknown, result: unknown[] = []): unknown[] {
	if (typeof value === "string") {
		result.push(value);
		return result;
	}
	if (!value || typeof value !== "object") return result;
	if (Array.isArray(value)) {
		for (const item of value) collectBoundValues(item, result);
		return result;
	}
	const node = value as { value?: unknown; queryChunks?: unknown[] };
	if ("value" in node) collectBoundValues(node.value, result);
	for (const chunk of node.queryChunks ?? []) collectBoundValues(chunk, result);
	return result;
}

describe("Ideas tenant-scoped relations", () => {
	it("validates the group and every tag in one scoped query", async () => {
		const { db, calls } = executor([
			{ kind: "group", id: "idg_a" },
			{ kind: "tag", id: "tag_a" },
			{ kind: "tag", id: "tag_b" },
		]);

		await expect(
			validateIdeaRelations(db, "org_a", "ws_a", "idg_a", ["tag_a", "tag_b"]),
		).resolves.toMatchObject({ groupScopeKey: "ws/ws_a" });
		expect(calls).toHaveLength(1);
		const values = collectBoundValues(calls[0]);
		expect(values).toContain("org_a");
		expect(values).toContain("ws_a");
		expect(values).toContain("idg_a");
		expect(values).toContain("tag_a");
		expect(values).toContain("tag_b");
	});

	it("rejects a disclosed group id from another organization", async () => {
		const { db } = executor([{ kind: "tag", id: "tag_a" }]);
		await expect(
			validateIdeaRelations(db, "org_a", "ws_a", "idg_foreign", ["tag_a"]),
		).rejects.toBeInstanceOf(InvalidIdeaRelationError);
	});

	it("rejects a disclosed tag id from another organization", async () => {
		const { db } = executor([{ kind: "group", id: "idg_a" }]);
		await expect(
			validateIdeaRelations(db, "org_a", "ws_a", "idg_a", ["tag_foreign"]),
		).rejects.toBeInstanceOf(InvalidIdeaRelationError);
	});

	it("rejects same-organization relations from another workspace", async () => {
		// The scoped SQL returns no rows when the ids exist in ws_b but the idea is
		// being written in ws_a.
		const { db } = executor([]);
		await expect(
			validateIdeaRelations(db, "org_a", "ws_a", "idg_ws_b", ["tag_ws_b"]),
		).rejects.toBeInstanceOf(InvalidIdeaRelationError);
	});

	it("deduplicates tag ids before validating them", async () => {
		const { db } = executor([
			{ kind: "group", id: "idg_a" },
			{ kind: "tag", id: "tag_a" },
		]);
		await expect(
			validateIdeaRelations(db, "org_a", null, "idg_a", ["tag_a", "tag_a"]),
		).resolves.toMatchObject({ groupScopeKey: "org" });
	});
});

function invalidRelationApp(relationRows: RelationRow[]) {
	const calls = { transactions: 0, mutations: 0 };
	let rootSelects = 0;
	const current = {
		id: "idea_a",
		organizationId: "org_a",
		workspaceId: "ws_a",
		scopeKey: "ws/ws_a",
		groupId: "idg_a",
		revision: 0,
	};
	// biome-ignore lint/suspicious/noExplicitAny: focused transactional Drizzle stub
	const tx: any = {
		execute: async () => relationRows,
		select: () => {
			// biome-ignore lint/suspicious/noExplicitAny: focused query-builder stub
			const query: any = {
				from: () => query,
				where: () => query,
				orderBy: () => ({ for: async () => [] }),
				for: () => query,
				limit: async () => [current],
			};
			return query;
		},
		insert: () => {
			calls.mutations++;
			throw new Error("relation validation must run before inserts");
		},
		update: () => {
			calls.mutations++;
			throw new Error("relation validation must run before updates");
		},
		delete: () => {
			calls.mutations++;
			throw new Error("relation validation must run before deletes");
		},
	};
	const db = {
		select: () => {
			const query = {
				from: () => query,
				where: () => query,
				for: () => query,
				limit: async () =>
					rootSelects++ === 0
						? [{ requireWorkspaceId: false, revision: 0 }]
						: [{ id: "ws_a", lifecycleStatus: "active" }],
			};
			return query;
		},
		transaction: async (callback: (transaction: typeof tx) => unknown) => {
			calls.transactions++;
			return callback(tx);
		},
	};

	const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", async (c, next) => {
		c.set("orgId", "org_a");
		c.set("keyId", "key_a");
		c.set("workspaceScope", "all");
		c.set("db", db as never);
		await next();
	});
	app.route("/", ideasRouter);
	return { app, calls };
}

describe("Ideas transactional relation rejection", () => {
	it.each([
		{
			name: "create",
			path: "/",
			method: "POST",
			body: {
				title: "Cross tenant",
				workspace_id: "ws_a",
				group_id: "idg_foreign",
				tag_ids: ["tag_foreign"],
			},
			rows: [] as RelationRow[],
		},
		{
			name: "update",
			path: "/idea_a",
			method: "PATCH",
			body: { tag_ids: ["tag_foreign"], expected_revision: 0 },
			rows: [{ kind: "group", id: "idg_a" }] as RelationRow[],
		},
		{
			name: "move",
			path: "/idea_a/move",
			method: "POST",
			body: { group_id: "idg_foreign", expected_revision: 0 },
			rows: [] as RelationRow[],
		},
	])("rejects foreign relations before any $name mutation", async (testCase) => {
		const { app, calls } = invalidRelationApp(testCase.rows);
		const response = await app.request(
			testCase.path,
			{
				method: testCase.method,
				headers: { "content-type": "application/json" },
				body: JSON.stringify(testCase.body),
			},
			{} as Env,
		);

		expect(response.status).toBe(400);
		expect(calls.transactions).toBe(1);
		expect(calls.mutations).toBe(0);
	});
});
