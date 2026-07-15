import { describe, expect, it } from "bun:test";
import {
	workspaceErasureJobs,
	workspaceErasureSteps,
	workspaces,
	workspaceTombstones,
} from "@relayapi/db";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../../../packages/db/src/schema";
import {
	WorkspaceErasureRequestBody,
	WorkspaceLifecycleBody,
} from "../schemas/workspaces";
import { WORKSPACE_PURGE_TABLES } from "../services/workspace-erasure";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

describe("workspace lifecycle and erasure", () => {
	it("models reversible archive separately from irreversible erasure", () => {
		expect(workspaces.lifecycleStatus.default).toBe("active");
		expect(workspaces.lifecycleStatus.enumValues).toEqual([
			"active",
			"archived",
			"erasing",
		]);
		expect(workspaces.revision.default).toBe(0);
		expect(workspaceErasureJobs.workspaceId.primary).toBe(true);
		expect(workspaceErasureJobs.erasureOperationId.isUnique).toBe(true);
		expect(workspaceErasureSteps.stepKey).toBeDefined();
		expect(workspaceTombstones.workspaceId.primary).toBe(true);
		expect(
			getTableConfig(workspaceErasureSteps).indexes.some(
				(index) => index.config.unique,
			),
		).toBe(true);
	});

	it("requires a compare-and-swap revision for lifecycle transitions", () => {
		expect(WorkspaceLifecycleBody.safeParse({}).success).toBe(false);
		expect(
			WorkspaceLifecycleBody.safeParse({ expected_revision: 4 }).success,
		).toBe(true);
		expect(WorkspaceErasureRequestBody.safeParse({}).success).toBe(false);
	});

	it("fences and enqueues erasure without deleting in the request", async () => {
		const source = await Bun.file(
			`${repoRoot}apps/api/src/routes/workspaces.ts`,
		).text();
		const handler = source.slice(
			source.indexOf("app.openapi(deleteWorkspace"),
			source.indexOf("export default app"),
		);

		expect(handler).toContain("db.transaction");
		expect(handler).toContain('.for("update")');
		expect(handler).toContain('lifecycleStatus: "erasing"');
		expect(handler).toContain("eq(workspaces.revision, expected_revision)");
		expect(handler).toContain(".insert(workspaceErasureJobs)");
		expect(handler).toContain(".onConflictDoNothing");
		expect(handler).not.toContain(".delete(workspaces)");
		expect(handler).not.toContain("whatsappBroadcasts");
	});

	it("exposes explicit archive and restore transitions", async () => {
		const source = await Bun.file(
			`${repoRoot}apps/api/src/routes/workspaces.ts`,
		).text();
		expect(source).toContain('path: "/{id}/archive"');
		expect(source).toContain('path: "/{id}/restore"');
		expect(source).toMatch(/"active",\s*"archived"/);
		expect(source).toMatch(/"archived",\s*"active"/);
	});

	it("keeps a complete child-first inventory of workspace-owned tables", () => {
		const configured = new Map<string, number>(
			WORKSPACE_PURGE_TABLES.map((table, index) => [table, index]),
		);
		const tables = Object.values(schema).flatMap((value) => {
			if (!is(value, PgTable)) return [];
			const table = getTableConfig(value);
			return table.columns.some((column) => column.name === "workspace_id")
				? [{ name: table.name, table }]
				: [];
		});
		const excluded = new Set([
			"workspace_erasure_jobs",
			"workspace_erasure_steps",
			"workspace_tombstones",
		]);
		expect([...configured.keys()].sort()).toEqual(
			tables
				.map(({ name }) => name)
				.filter((name) => !excluded.has(name))
				.sort(),
		);

		for (const { name, table } of tables) {
			for (const foreignKey of table.foreignKeys) {
				const parentName = getTableConfig(
					foreignKey.reference().foreignTable,
				).name;
				const childIndex = configured.get(name);
				const parentIndex = configured.get(parentName);
				if (
					name !== parentName &&
					childIndex !== undefined &&
					parentIndex !== undefined
				) {
					expect(childIndex).toBeLessThan(parentIndex);
				}
			}
		}
	});

	it("purges pending Telegram challenges directly before social accounts", async () => {
		const challengeIndex = WORKSPACE_PURGE_TABLES.indexOf(
			"telegram_connection_challenges",
		);
		const accountIndex = WORKSPACE_PURGE_TABLES.indexOf("social_accounts");
		expect(challengeIndex).toBeGreaterThanOrEqual(0);
		expect(challengeIndex).toBeLessThan(accountIndex);

		const source = await Bun.file(
			`${repoRoot}apps/api/src/services/workspace-erasure.ts`,
		).text();
		const dependentPhase = source.slice(
			source.indexOf('const dependents = ["connection_logs"]'),
			source.indexOf("const index = cursor.table_index"),
		);
		expect(dependentPhase).not.toContain("telegram_connection_challenges");
	});

	it("processes leased bounded batches and writes only a redacted tombstone", async () => {
		const source = await Bun.file(
			`${repoRoot}apps/api/src/services/workspace-erasure.ts`,
		).text();
		expect(source).toContain("workspaceErasureSteps");
		expect(source).toContain("leaseToken");
		expect(source).toContain("FOR UPDATE OF target SKIP LOCKED");
		expect(source).toMatch(/LIMIT \$\{DELETE_BATCH_SIZE\}/);
		expect(source).toContain("requestedBy: null");
		expect(source).toContain("redacted: true");
		expect(source).toContain('"connection_logs"');
		expect(source).toContain('"telegram_connection_challenges"');
		expect(source).not.toMatch(/workspace[_A-Za-z]*Id:\s*null/);
	});
});
