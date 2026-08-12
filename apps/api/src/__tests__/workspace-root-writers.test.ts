import { describe, expect, it } from "bun:test";

const apiSrc = new URL("../", import.meta.url).pathname;

const ROOT_WRITERS: Record<string, string[]> = {
	socialAccounts: [
		"services/account-credential-write.ts",
		"services/telegram-connection.ts",
	],
	postThreads: ["routes/threads.ts"],
	posts: [
		"routes/ideas.ts",
		"routes/posts.ts",
		"routes/threads.ts",
		"services/recycling-processor.ts",
		"services/rss-generator.ts",
	],
	media: ["routes/ideas.ts", "routes/media-uploads.ts", "routes/media.ts"],
	webhookEndpoints: ["routes/webhooks.ts"],
	inboxConversations: ["services/inbox-persistence.ts"],
	autoPostRules: ["routes/auto-post-rules.ts"],
	contacts: [
		"routes/contacts.ts",
		"services/ad-advanced-store.ts",
		"services/automations/webhook-receiver.ts",
		"services/contact-linker.ts",
		"services/public-growth-events.ts",
	],
	broadcasts: ["routes/broadcasts.ts", "routes/whatsapp.ts"],
	adAccounts: ["services/ad-connection-service.ts", "services/ad-service.ts"],
	adAudiences: ["services/ad-audience.ts"],
	shortLinks: [
		"services/short-link-lifecycle.ts",
		"services/short-link-providers/relayapi.ts",
	],
	ideas: ["routes/ideas.ts"],
	automations: ["routes/automations.ts"],
	segments: ["routes/segments.ts"],
	subscriptionLists: ["routes/subscription-lists.ts"],
	aiKnowledgeBases: ["routes/ai-knowledge.ts"],
	aiAgents: ["routes/ai-agents.ts"],
	refUrls: ["routes/ref-urls.ts"],
	landingPages: ["routes/landing-pages.ts"],
};

async function source(relativePath: string): Promise<string> {
	return Bun.file(`${apiSrc}${relativePath}`).text();
}

async function runtimeSources(): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	const glob = new Bun.Glob("**/*.ts");
	for await (const relativePath of glob.scan({ cwd: apiSrc })) {
		if (relativePath.startsWith("__tests__/")) continue;
		files.set(relativePath, await source(relativePath));
	}
	return files;
}

describe("Require Workspace ID root writer inventory", () => {
	it("keeps every runtime insert/upsert writer explicitly classified", async () => {
		const files = await runtimeSources();
		for (const [tableVariable, expectedFiles] of Object.entries(ROOT_WRITERS)) {
			const insertPattern = new RegExp(
				String.raw`\.insert\(\s*${tableVariable}\s*\)`,
				"m",
			);
			const actualFiles = [...files]
				.filter(([, fileSource]) => insertPattern.test(fileSource))
				.map(([relativePath]) => relativePath)
				.sort();
			expect(actualFiles, tableVariable).toEqual([...expectedFiles].sort());
		}
	});

	it("persists the explicit thread parent before its scoped children", async () => {
		const threads = await source("routes/threads.ts");
		expect(threads).toContain(".insert(postThreads)");
		expect(threads.indexOf(".insert(postThreads)")).toBeLessThan(
			threads.indexOf(".insert(threadExecutions)"),
		);
	});

	it("copies authoritative parent scopes in every derived background writer", async () => {
		const [
			recycling,
			rss,
			ideas,
			contactLinker,
			webhookReceiver,
			whatsapp,
			adService,
			adAudience,
			shortLinkProvider,
			postsRoute,
		] = await Promise.all([
			source("services/recycling-processor.ts"),
			source("services/rss-generator.ts"),
			source("routes/ideas.ts"),
			source("services/contact-linker.ts"),
			source("services/automations/webhook-receiver.ts"),
			source("routes/whatsapp.ts"),
			source("services/ad-service.ts"),
			source("services/ad-audience.ts"),
			source("services/short-link-providers/relayapi.ts"),
			source("routes/posts.ts"),
		]);
		expect(recycling).toContain("workspaceId: sourcePost.workspaceId");
		expect(rss).toContain("workspaceId: rule.workspaceId");
		expect(ideas).toContain("workspaceId: existing.workspaceId");
		expect(contactLinker).toContain("workspaceId: account.workspaceId");
		expect(webhookReceiver).toContain(
			"workspaceId: match.automation.workspaceId",
		);
		expect(whatsapp).toContain("workspaceId: activeAccount.workspaceId");
		expect(adService).toContain("workspaceId: socialAcc.workspaceId");
		expect(adService).toContain("workspaceId: primary.workspaceId");
		expect(adAudience).toContain("workspaceId: ctx.adAccount.workspaceId");
		expect(shortLinkProvider).toContain("workspaceId: candidate.workspaceId");
		expect(postsRoute).toContain("workspaceId: txPost.workspaceId");
	});

	it("derives inbox conversation scope from the exact active account", async () => {
		const [backfill, persistence] = await Promise.all([
			source("services/inbox-backfill.ts"),
			source("services/inbox-persistence.ts"),
		]);
		expect(backfill.match(/workspaceId: account\.workspaceId/g)).toHaveLength(
			4,
		);
		expect(backfill).toContain(
			"eq(socialAccounts.organizationId, message.organization_id)",
		);
		expect(backfill).toContain('eq(socialAccounts.lifecycleStatus, "active")');
		expect(persistence).toContain("workspaceId: string | null;");
		expect(persistence).toContain("workspaceId: data.workspaceId,");
	});

	it("bounds provider discovery writes to the caller's authorized scope", async () => {
		const [adsRoute, adConnectionService, adService] = await Promise.all([
			source("routes/ads.ts"),
			source("services/ad-connection-service.ts"),
			source("services/ad-service.ts"),
		]);
		expect(adsRoute).toContain('c.get("workspaceScope")');
		expect(adsRoute).toContain("resolveOperationalCreateScope(");
		expect(adsRoute).toContain(
			"const denied = await authorizeAdAccount(c, ad_account_id);",
		);
		expect(adConnectionService).toContain(
			"workspaceId: connection.workspaceId",
		);
		expect(adConnectionService).toContain(
			"adAccounts.workspaceId} IS NOT DISTINCT FROM",
		);
		expect(adService).toContain(
			"canAccessWorkspaceScope(workspaceScope, socialAcc.workspaceId)",
		);
		expect(adService).toContain(
			"workspaceScopeSqlCondition(workspaceScope, socialAccounts.workspaceId)",
		);
	});

	it("routes independent short-link writes through canonical policy", async () => {
		const shortLinks = await source("routes/short-links.ts");
		expect(shortLinks).toContain("resolveOperationalCreateScope(");
		expect(shortLinks).toContain("workspaceId: scope.workspaceId");
		expect(shortLinks).toContain(
			"applyWorkspaceScope(c, conditions, shortLinks.workspaceId)",
		);
		expect(shortLinks).toContain("assertWorkspaceScope(c, link.workspaceId)");
	});

	it("authorizes the phone-provisioning parent before creating an account", async () => {
		const provisioning = await source("routes/whatsapp-phone-provisioning.ts");
		expect(provisioning).toContain("inheritOperationalCreateScope(");
		expect(provisioning).toContain("[sourceWorkspaceId]");
		expect(
			provisioning.indexOf(
				"const accountScope = await inheritOperationalCreateScope(",
			),
		).toBeLessThan(
			provisioning.indexOf(
				"const account = await upsertConnectedAccountWithCredentials(",
			),
		);
	});
});
