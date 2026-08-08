import { describe, expect, test } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host OAuth session-authority compatibility", () => {
	test("ships exact dashboard-session fencing without a new binding", async () => {
		const [
			readme,
			config,
			appApi,
			connect,
			telegramConnection,
			databaseSchema,
			accountWrite,
			requestAccess,
			wrangler,
		] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
			Bun.file(`${repositoryRoot}packages/config/src/index.ts`).text(),
			Bun.file(`${repositoryRoot}apps/app/src/lib/api-utils.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/routes/connect.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/telegram-connection.ts`,
			).text(),
			Bun.file(`${repositoryRoot}packages/db/src/schema.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/account-credential-write.ts`,
			).text(),
			Bun.file(`${repositoryRoot}apps/api/src/lib/request-access.ts`).text(),
			Bun.file(
				`${repositoryRoot}packages/self-host/src/wrangler-config.ts`,
			).text(),
		]);

		expect(readme).toContain(
			"Dashboard-initiated OAuth and direct provider-account credential writes",
		);
		expect(config).toContain("export const DASHBOARD_SESSION_AUTHORITY_HEADER");
		expect(appApi).toContain(
			"[DASHBOARD_SESSION_AUTHORITY_HEADER]: currentSession.id",
		);
		expect(connect).toContain(
			'if (c.get("principalType") !== "dashboard_user") return null;',
		);
		expect(connect).toContain(
			"authority_session_id: connectionAuthoritySessionId(c)",
		);
		expect(connect).toContain(
			"stateData.authority_session_id === connectionAuthoritySessionId(c)",
		);
		expect(connect).toContain("connectionAuthoritySessionId(c)");
		expect(telegramConnection).toContain(
			"authoritySessionId: challenge.authoritySessionId",
		);
		expect(databaseSchema).toContain(
			'authoritySessionId: text("authority_session_id").references',
		);
		expect(accountWrite).toContain(
			"authoritySessionId: params.authoritySessionId",
		);
		expect(requestAccess).toContain(
			"eq(authSession.id, params.authoritySessionId)",
		);
		expect(requestAccess).toContain(
			"else if (params.authoritySessionId !== null)",
		);
		expect(wrangler).not.toContain("DASHBOARD_SESSION_AUTHORITY_HEADER");
	});
});
