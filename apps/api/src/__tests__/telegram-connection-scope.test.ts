import { describe, expect, it } from "bun:test";
import { telegramConnectionChallenges } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

describe("Telegram connection scope durability", () => {
	it("persists exact tenant scope with purge and due-time indexes", () => {
		const table = getTableConfig(telegramConnectionChallenges);
		expect(
			table.columns.find((column) => column.name === "api_key_id")?.notNull,
		).toBe(true);
		expect(
			table.columns.find((column) => column.name === "initial_workspace_scope")
				?.notNull,
		).toBe(true);
		expect(table.columns.some((column) => column.name === "workspace_id")).toBe(
			true,
		);
		expect(table.columns.some((column) => column.name === "scope_key")).toBe(
			true,
		);
		expect(table.indexes.map((index) => index.config.name)).toContain(
			"telegram_connection_challenges_org_workspace_idx",
		);
		expect(table.indexes.map((index) => index.config.name)).toContain(
			"telegram_connection_challenges_expiry_idx",
		);
		expect(table.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
			expect.arrayContaining([
				"telegram_connection_challenges_api_key_org_fk",
				"telegram_connection_challenges_workspace_org_fk",
				"telegram_connection_challenges_account_org_scope_fk",
			]),
		);
		expect(table.checks.map((check) => check.name)).toContain(
			"telegram_connection_challenges_initial_scope_check",
		);
	});

	it("inherits an existing account scope on omission and rejects explicit moves", async () => {
		const source = await Bun.file(
			`${repoRoot}apps/api/src/services/telegram-connection.ts`,
		).text();
		expect(source).toContain(
			"challenge.workspaceId === null && existingAccount",
		);
		expect(source).toContain(
			"existingAccount.workspaceId !== challenge.workspaceId",
		);
		expect(source).toContain("workspaceId: effectiveWorkspaceId");
		expect(source).toContain(
			"IS NOT DISTINCT FROM $" + "{effectiveWorkspaceId}",
		);
		expect(source).toContain("challenge.initialWorkspaceScope");
		expect(source).toContain("challenge.apiKeyId");
	});

	it("removes expired challenges in bounded ordered batches on maintenance cron", async () => {
		const [service, scheduled] = await Promise.all([
			Bun.file(
				`${repoRoot}apps/api/src/services/telegram-connection.ts`,
			).text(),
			Bun.file(`${repoRoot}apps/api/src/scheduled/index.ts`).text(),
		]);
		expect(service).toContain("CHALLENGE_CLEANUP_MAX_BATCHES");
		expect(service).toContain(
			"lte(telegramConnectionChallenges.expiresAt, now)",
		);
		expect(service).toContain("asc(telegramConnectionChallenges.expiresAt)");
		expect(service).toContain(".limit(boundedLimit)");
		expect(scheduled).toContain("cleanupExpiredTelegramConnectionChallenges");
		expect(scheduled).toContain('name: "telegram_challenge_cleanup"');
	});
});
