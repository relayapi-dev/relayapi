import { describe, expect, test } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

function routeSection(source: string, start: string, end: string): string {
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex + start.length);
	expect(startIndex).toBeGreaterThanOrEqual(0);
	expect(endIndex).toBeGreaterThan(startIndex);
	return source.slice(startIndex, endIndex);
}

describe("self-host publisher connector compatibility", () => {
	test("ships the same fail-closed publisher option and media preflight", async () => {
		const [
			readme,
			validation,
			options,
			convertKitPublisher,
			threads,
			sdkThreads,
			sdkValidate,
			limits,
		] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/platform-post-validation.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/schemas/publisher-options.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/publishers/convertkit.ts`,
			).text(),
			Bun.file(`${repositoryRoot}apps/api/src/schemas/threads.ts`).text(),
			Bun.file(`${repositoryRoot}packages/sdk/src/resources/threads.ts`).text(),
			Bun.file(
				`${repositoryRoot}packages/sdk/src/resources/tools/validate.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/config/platform-limits.ts`,
			).text(),
		]);

		expect(validation).toContain(
			'whatsapp: ["image", "video", "document", "audio"]',
		);
		expect(validation).toContain("validatePlatformPostInput");
		expect(options).toContain(
			"email_template_id: z.number().int().positive().optional()",
		);
		expect(options).toContain(
			"list_id: z.number().int().positive().optional()",
		);
		expect(convertKitPublisher).toContain("PROVIDER_DRAFT_UNSUPPORTED");
		expect(convertKitPublisher).toContain(
			"PROVIDER_DRAFT_REQUIRES_MANUAL_ACTION",
		);
		expect(limits).toContain("convertkit:");
		expect(limits).toContain("maxImages: 0");
		expect(threads).toContain(
			"target_options: PublisherTargetOptions.optional()",
		);
		expect(threads).toContain("media: z.array(PostMediaItem)");
		expect(sdkThreads).toContain("target_options?: PublisherTargetOptions");
		expect(sdkThreads).toContain("media?: Array<PostMediaInput>");
		expect(sdkValidate).toContain("target_options?: PublisherTargetOptions");

		const normalizedReadme = readme.replace(/\s+/g, " ");
		expect(normalizedReadme).toContain(
			"Audio attachments are admitted only for WhatsApp",
		);
		expect(normalizedReadme).toContain(
			"reject Relay media attachments instead of silently discarding them",
		);
		expect(normalizedReadme).toContain(
			"rejects Kit `send_at: null` before provider I/O",
		);
		expect(normalizedReadme).toContain(
			"retains the broadcast ID and terminalizes for manual action",
		);
		expect(normalizedReadme).toContain(
			"WhatsApp audio with nonblank text is rejected",
		);
		expect(normalizedReadme).toContain(
			"add no self-host binding, secret, migration, or operator setting",
		);
	});

	test("ships the 22-platform schema and tenant-owned direct connectors", async () => {
		const [
			readme,
			domainContracts,
			schema,
			connect,
			slackParser,
			discordParser,
			deploy,
			scaffold,
		] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
			Bun.file(`${repositoryRoot}packages/db/src/domain-contracts.ts`).text(),
			Bun.file(`${repositoryRoot}packages/db/src/schema.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/routes/connect.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/lib/slack-webhook.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/lib/discord-webhook.ts`).text(),
			Bun.file(`${repositoryRoot}packages/self-host/src/deploy.ts`).text(),
			Bun.file(`${repositoryRoot}packages/self-host/src/scaffold.ts`).text(),
		]);

		const platformRegistry = domainContracts.match(
			/export const SOCIAL_PLATFORM_IDS = \[([\s\S]*?)\] as const;/,
		)?.[1];
		expect(platformRegistry).toBeDefined();
		expect([...(platformRegistry ?? "").matchAll(/"([^"]+)"/g)]).toHaveLength(
			22,
		);
		expect(platformRegistry).toContain('"slack"');
		expect(schema).toContain(
			'export const platformEnum = pgEnum("platform", [...SOCIAL_PLATFORM_IDS])',
		);
		expect(schema).toContain(
			'"ad_account_identities_social_account_org_scope_fk"',
		);

		const discord = routeSection(
			connect,
			"app.openapi(connectDiscord",
			"app.openapi(connectSms",
		);
		const sms = routeSection(
			connect,
			"app.openapi(connectSms",
			"app.openapi(connectSlack",
		);
		const slack = routeSection(
			connect,
			"app.openapi(connectSlack",
			"app.openapi(initTelegram",
		);

		expect(discord).toContain("parseDiscordWebhookUrl(webhook_url)");
		expect(discord).toContain("await fetch(webhook.url");
		expect(discord).toContain("accessToken: webhook.url");
		expect(sms).toContain("api.twilio.com/2010-04-01/Accounts/");
		expect(sms).toContain("accessToken: auth_token");
		expect(slack).toContain("parseSlackWebhookUrl(webhook_url)");
		expect(slack).toContain("accessToken: webhook.url");
		expect(slack).not.toContain("await fetch(");

		expect(slackParser).toContain('"hooks.slack.com", "hooks.slack-gov.com"');
		expect(slackParser).toContain("/^\\/services\\/");
		expect(discordParser).toContain('parsed.hostname !== "discord.com"');
		expect(discordParser).toContain("/^\\/api(?:\\/v\\d+)?\\/webhooks\\/");

		const globalSecretSources = `${deploy}\n${scaffold}`;
		for (const unsupportedGlobalSecret of [
			"DISCORD_WEBHOOK_URL",
			"SLACK_WEBHOOK_URL",
			"TWILIO_ACCOUNT_SID",
			"TWILIO_AUTH_TOKEN",
		]) {
			expect(globalSecretSources).not.toContain(unsupportedGlobalSecret);
		}

		const normalizedReadme = readme.replace(/\s+/g, " ");
		expect(normalizedReadme).toContain(
			"shared publishing registry now contains 22 platforms, including Slack",
		);
		expect(normalizedReadme).toContain(
			"add no global provider secret or Cloudflare binding",
		);
		expect(normalizedReadme).toContain(
			"incoming webhooks expose no non-mutating probe",
		);
		expect(normalizedReadme).toContain(
			"no provider message ID for deletion or reconciliation",
		);
	});

	test("keeps provider identity connection-owned and contains newsletter egress", async () => {
		const [
			readme,
			metadataService,
			beehiivPublisher,
			listmonkPublisher,
			smsPublisher,
			linkedinPublisher,
			accountsRoute,
			snapchatPublisher,
			snapchatConnector,
		] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/ad-access-token.ts`,
			).text(),
			Bun.file(`${repositoryRoot}apps/api/src/publishers/beehiiv.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/publishers/listmonk.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/publishers/sms.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/publishers/linkedin.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/routes/accounts.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/publishers/snapchat.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/routes/connect.ts`).text(),
		]);

		for (const protectedKey of [
			'"instance_url"',
			'"pds_url"',
			'"did"',
			'"auth_mode"',
			'"waba_id"',
			'"publication_id"',
			'"from_number"',
			'"default_from_number"',
			'"mms_capable"',
		]) {
			expect(metadataService).toContain(protectedKey);
		}
		expect(metadataService).toContain(
			"CONNECTION_OWNED_SOCIAL_ACCOUNT_METADATA_KEYS.has(key)",
		);
		expect(beehiivPublisher).toContain("return account.platform_account_id");
		expect(listmonkPublisher).toContain(
			"parseListmonkInstanceUrl(account.platform_account_id)",
		);
		expect(listmonkPublisher).toContain('redirect: "error"');
		expect(listmonkPublisher).toContain("timeout: 30_000");
		expect(listmonkPublisher).toContain("timeoutThroughBody: true");
		expect(listmonkPublisher).toContain(
			"maxBytes: LISTMONK_RESPONSE_MAX_BYTES",
		);
		expect(listmonkPublisher).toContain(
			"const LISTMONK_RESPONSE_MAX_BYTES = 512 * 1024",
		);
		const smsPublish = smsPublisher.slice(
			smsPublisher.indexOf("async publish"),
		);
		expect(smsPublish).toContain('code: "SMS_SENDER_MISMATCH"');
		expect(smsPublish.indexOf("SMS_SENDER_MISMATCH")).toBeLessThan(
			smsPublish.indexOf("await fetch("),
		);
		const linkedinPublish = linkedinPublisher.slice(
			linkedinPublisher.indexOf("async publish"),
		);
		expect(linkedinPublish).toContain(
			"const authorUrn = request.account.platform_account_id",
		);
		expect(linkedinPublish).toContain('code: "ORGANIZATION_URN_MISMATCH"');
		expect(linkedinPublish.indexOf("ORGANIZATION_URN_MISMATCH")).toBeLessThan(
			linkedinPublish.indexOf("await linkedinFetch("),
		);

		const newsletterLists = routeSection(
			accountsRoute,
			"app.openapi(getNewsletterLists",
			"app.openapi(getNewsletterTemplates",
		);
		const newsletterTemplates = routeSection(
			accountsRoute,
			"app.openapi(getNewsletterTemplates",
			"export default app",
		);
		for (const route of [newsletterLists, newsletterTemplates]) {
			expect(route).toContain("assertWorkspaceScope(c, account.workspaceId)");
		}

		expect(metadataService).toContain("snapchat_public_profile_verified");
		expect(snapchatConnector).toContain(
			"snapchat_public_profile_verified: true",
		);
		expect(snapchatPublisher).toContain("SNAPCHAT_RECONNECT_REQUIRED");

		const normalizedReadme = readme.replace(/\s+/g, " ");
		expect(normalizedReadme).toContain(
			"Generic account metadata updates cannot overwrite Mastodon/Listmonk",
		);
		expect(normalizedReadme).toContain(
			"Newsletter list/template discovery also checks the account's workspace",
		);
		expect(normalizedReadme).toContain(
			"always uses the connector-verified sender",
		);
		expect(normalizedReadme).toContain(
			"LinkedIn publishing always uses the connector-selected member or organization URN",
		);
		expect(normalizedReadme).toContain(
			"Every Snapchat account created before the Public Profile verification marker was introduced must reconnect",
		);
	});

	test("preserves provider effects and terminalizes signed WhatsApp callbacks monotonically", async () => {
		const [
			readme,
			publisherTypes,
			publisherRunner,
			whatsappPublisher,
			inboxProcessor,
			platformWebhooks,
			providerReconciler,
			postsRoute,
			telegramPublisher,
		] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/publishers/types.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/publisher-runner.ts`,
			).text(),
			Bun.file(`${repositoryRoot}apps/api/src/publishers/whatsapp.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/inbox-event-processor.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/routes/platform-webhooks.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/provider-outcome-reconciler.ts`,
			).text(),
			Bun.file(`${repositoryRoot}apps/api/src/routes/posts.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/publishers/telegram.ts`).text(),
		]);

		expect(publisherTypes).toContain("effect_recorder?: PublishEffectRecorder");
		expect(publisherTypes).toContain("recordProviderEffect(");
		expect(publisherRunner).toContain("persistPublishTaskEffect(");
		expect(publisherRunner).toContain("mergeRecordedEffectsIntoResult(");
		expect(publisherRunner).toContain("effect_recorder: effectRecorder");
		expect(publisherRunner).toContain(
			".set({ providerEffects: effects, updatedAt: recordedAt })",
		);
		expect(publisherRunner).toContain(".set({ providerEffects: effects })");

		expect(whatsappPublisher).toContain('reconciliation: "webhook"');
		expect(whatsappPublisher).toContain('providerState === "sent"');
		expect(whatsappPublisher).toContain('disposition: "accepted"');
		expect(whatsappPublisher).toContain(
			'providerState === "delivered" || providerState === "read"',
		);
		expect(platformWebhooks.indexOf("verifyHmacSha256")).toBeLessThan(
			platformWebhooks.indexOf('provider: "whatsapp"'),
		);
		expect(inboxProcessor).toContain("const WA_STATUS_RANK");
		expect(inboxProcessor).toContain('if (status.status === "sent")');
		expect(inboxProcessor).toContain(
			'eq(postTargets.deliveryState, "unknown")',
		);
		expect(inboxProcessor).toContain("persistTerminalProviderReconciliation");
		expect(providerReconciler).toContain(
			"export async function persistTerminalProviderReconciliation",
		);
		expect(providerReconciler).toContain("continuationQueued");

		const unpublish = routeSection(
			postsRoute,
			"app.openapi(unpublishPost",
			"// Post logs",
		);
		for (const platform of [
			"twitter",
			"facebook",
			"linkedin",
			"reddit",
			"pinterest",
			"threads",
			"youtube",
			"bluesky",
			"googlebusiness",
			"telegram",
			"mastodon",
			"discord",
		]) {
			expect(unpublish).toContain(`case "${platform}"`);
		}
		expect(unpublish).not.toContain('case "instagram"');
		expect(unpublish).toContain("Unpublish is not supported by this platform");
		expect(unpublish).toContain('finalPostStatus: "draft" | "partial"');
		expect(unpublish).toContain('effect.name.startsWith("telegram_message_")');
		expect(unpublish).toContain('includes("message to delete not found")');
		expect(telegramPublisher).toContain(`name: \`telegram_message_\${index}\``);
		expect(telegramPublisher).toContain('provider_state: "sent_media_group"');

		const normalizedReadme = readme.replace(/\s+/g, " ");
		expect(normalizedReadme).toContain(
			"records each confirmed effect in both rows before starting the next step",
		);
		expect(normalizedReadme).toContain(
			"`sent` remains accepted and nonterminal",
		);
		expect(normalizedReadme).toContain(
			"Duplicate or reordered callbacks cannot regress a terminal state",
		);
		expect(normalizedReadme).toContain(
			"adds no self-host binding, secret, migration, or operator setting",
		);
		expect(normalizedReadme).toContain(
			"Provider delete is implemented for Twitter/X, Facebook, LinkedIn, Reddit, Pinterest, Threads, YouTube, Bluesky, Google Business, Telegram, Mastodon, and Discord",
		);
		expect(normalizedReadme).toContain(
			"mixed result remains `partial` and retryable",
		);
		expect(normalizedReadme).toContain(
			"Telegram media groups journal every returned message ID",
		);
	});
});
