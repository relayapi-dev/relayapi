import { describe, expect, it } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host provider lifecycle compatibility", () => {
	it("ships truthful Beehiiv reconciliation and exact ad-account snapshot fencing", async () => {
		const [readme, beehiiv, adConnections] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/publishers/beehiiv.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/ad-connection-service.ts`,
			).text(),
		]);

		expect(beehiiv).toContain('providerStatus === "draft"');
		expect(beehiiv).toContain('providerStatus === "archived"');
		expect(beehiiv).toContain('providerStatus !== "confirmed"');
		expect(beehiiv).toContain('"PROVIDER_DRAFT_REQUIRES_MANUAL_ACTION"');
		expect(beehiiv).toContain('"PROVIDER_ARCHIVED"');
		expect(beehiiv).toContain("effects: [...request.effects]");

		expect(adConnections).toContain("notInArray(");
		expect(adConnections).toContain(
			"eq(adAccounts.adConnectionId, connection.id)",
		);
		expect(adConnections).toContain(
			"eq(adAccounts.organizationId, connection.organizationId)",
		);
		expect(adConnections).toContain(
			"eq(adAccounts.platform, connection.platform)",
		);
		expect(adConnections).toContain(
			"eq(adAccounts.workspaceId, connection.workspaceId)",
		);
		expect(adConnections).toContain("await db.transaction(async (tx) => {");
		expect(adConnections).toContain('.for("update")');
		expect(adConnections).toContain(
			"authoritative.credentialVersion !== connection.credentialVersion",
		);

		const normalizedReadme = readme.replace(/\s+/g, " ");
		expect(normalizedReadme).toContain(
			"never reports `draft` or `archived` as a successful send",
		);
		expect(normalizedReadme).toContain(
			"only missing rows owned by that exact connection, organization, workspace scope, and platform are disabled",
		);
		expect(normalizedReadme).toContain(
			"a concurrent rotation or revocation cannot reactivate stale rows",
		);
		expect(normalizedReadme).toContain(
			"no self-host binding, secret, database migration, or operator setting",
		);
	});

	it("ships Discord thread-edit context with the publisher and edit routes", async () => {
		const [readme, discordPublisher, context, publishedEdits, socialActions] =
			await Promise.all([
				Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
				Bun.file(`${repositoryRoot}apps/api/src/publishers/discord.ts`).text(),
				Bun.file(
					`${repositoryRoot}apps/api/src/lib/discord-message-context.ts`,
				).text(),
				Bun.file(
					`${repositoryRoot}apps/api/src/routes/published-edits.ts`,
				).text(),
				Bun.file(
					`${repositoryRoot}apps/api/src/routes/social-actions.ts`,
				).text(),
			]);

		expect(context).toContain('"discord_thread_context"');
		expect(discordPublisher).toContain("await recordProviderEffect(");
		expect(publishedEdits).toContain("discordThreadContextFromEffects(");
		expect(publishedEdits).toContain("discordThreadContextRequired:");
		expect(socialActions).toContain("discord_thread_scoped === true");
		expect(socialActions).toContain('type === "comment_thread"');
		expect(readme).toContain("`DISCORD_THREAD_CONTEXT_MISSING`");
		expect(readme).toContain("adds no self-host binding, secret, or operator");
	});
});
