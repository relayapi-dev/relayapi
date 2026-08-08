import { describe, expect, it } from "bun:test";
import { getMutationEffectCoveragePolicy } from "../lib/mutation-effect-policy";

describe("mutation-effect coverage policy", () => {
	const postgresCompleteRoutes: ReadonlyArray<readonly [string, string]> = [
		["POST", "/v1/contacts"],
		["PATCH", "/v1/contacts/ct_1"],
		["DELETE", "/v1/contacts/ct_1"],
		["POST", "/v1/contacts/ct_1/consents"],
		["POST", "/v1/contacts/ct_1/channels"],
		["DELETE", "/v1/contacts/ct_1/channels/cc_1"],
		["PUT", "/v1/contacts/ct_1/segments/seg_1"],
		["DELETE", "/v1/contacts/ct_1/segments/seg_1"],
		["POST", "/v1/contacts/bulk"],
		["POST", "/v1/contacts/bulk-operations"],
		["POST", "/v1/contacts/ct_1/merge"],
		["PUT", "/v1/contacts/ct_1/fields/customer-tier"],
		["DELETE", "/v1/contacts/ct_1/fields/customer-tier"],
		["POST", "/v1/tags"],
		["PATCH", "/v1/tags/tag_1"],
		["DELETE", "/v1/tags/tag_1"],
		["POST", "/v1/content-templates"],
		["PATCH", "/v1/content-templates/tpl_1"],
		["DELETE", "/v1/content-templates/tpl_1"],
		["POST", "/v1/custom-fields"],
		["PATCH", "/v1/custom-fields/cfd_1"],
		["DELETE", "/v1/custom-fields/cfd_1"],
		["POST", "/v1/segments"],
		["PATCH", "/v1/segments/seg_1"],
		["DELETE", "/v1/segments/seg_1"],
		["PUT", "/v1/automations/auto_1/graph"],
		["POST", "/v1/whatsapp/bulk-send"],
		["POST", "/v1/idea-groups"],
		["PATCH", "/v1/idea-groups/ig_1"],
		["DELETE", "/v1/idea-groups/ig_1"],
		["POST", "/v1/qr-codes"],
		["PATCH", "/v1/qr-codes/qr_1"],
		["DELETE", "/v1/qr-codes/qr_1"],
		["POST", "/v1/signatures"],
		["PATCH", "/v1/signatures/sig_1"],
		["DELETE", "/v1/signatures/sig_1"],
		["POST", "/v1/signatures/sig_1/set-default"],
		["POST", "/v1/subscription-lists"],
		["PATCH", "/v1/subscription-lists/list_1"],
		["DELETE", "/v1/subscription-lists/list_1"],
		["POST", "/v1/subscription-lists/list_1/members"],
		["DELETE", "/v1/subscription-lists/list_1/members/ct_1"],
		["POST", "/v1/ai-agents"],
		["PATCH", "/v1/ai-agents/agent_1"],
		["DELETE", "/v1/ai-agents/agent_1"],
		["POST", "/v1/ai-knowledge"],
		["PATCH", "/v1/ai-knowledge/kb_1"],
		["DELETE", "/v1/ai-knowledge/kb_1"],
		["POST", "/v1/ai-knowledge/kb_1/documents"],
		["DELETE", "/v1/ai-knowledge/kb_1/documents/doc_1"],
		["POST", "/v1/ai-knowledge/kb_1/documents/doc_1/retry"],
		["POST", "/v1/ideas"],
		["PATCH", "/v1/ideas/idea_1"],
		["POST", "/v1/ideas/idea_1/move"],
		["POST", "/v1/ideas/idea_1/convert"],
		["POST", "/v1/ideas/idea_1/comments"],
		["PATCH", "/v1/ideas/idea_1/comments/comment_1"],
		["DELETE", "/v1/ideas/idea_1/comments/comment_1"],
		["POST", "/v1/ref-urls"],
		["PATCH", "/v1/ref-urls/ref_1"],
		["DELETE", "/v1/ref-urls/ref_1"],
		["POST", "/v1/ref-urls/ref_1/click"],
		["POST", "/v1/landing-pages"],
		["PATCH", "/v1/landing-pages/lp_1"],
		["DELETE", "/v1/landing-pages/lp_1"],
		["POST", "/v1/auto-post-rules"],
		["PATCH", "/v1/auto-post-rules/rule_1"],
		["DELETE", "/v1/auto-post-rules/rule_1"],
		["POST", "/v1/auto-post-rules/rule_1/activate"],
		["POST", "/v1/auto-post-rules/rule_1/pause"],
		["POST", "/v1/automations"],
		["PATCH", "/v1/automations/auto_1"],
		["DELETE", "/v1/automations/auto_1"],
		["POST", "/v1/automations/auto_1/activate"],
		["POST", "/v1/automations/auto_1/pause"],
		["POST", "/v1/automations/auto_1/resume"],
		["POST", "/v1/automations/auto_1/archive"],
		["POST", "/v1/automations/auto_1/unarchive"],
		["POST", "/v1/automations/auto_1/entrypoints"],
		["PATCH", "/v1/automation-entrypoints/entry_1"],
		["DELETE", "/v1/automation-entrypoints/entry_1"],
		["POST", "/v1/automation-entrypoints/entry_1/rotate-secret"],
		["POST", "/v1/automation-runs/run_1/stop"],
		["POST", "/v1/contacts/ct_1/automation-pause"],
		["PATCH", "/v1/inbox/conversations/convo_1"],
		["POST", "/v1/inbox/conversations/convo_1/notes"],
		["PATCH", "/v1/inbox/notes/note_1"],
		["DELETE", "/v1/inbox/notes/note_1"],
		["POST", "/v1/inbox/bulk"],
		["PUT", "/v1/posts/post_1/tags/tag_1"],
		["DELETE", "/v1/posts/post_1/tags/tag_1"],
		["PATCH", "/v1/posts/post_1/notes"],
		["PUT", "/v1/posts/post_1/recycling"],
		["DELETE", "/v1/posts/post_1/recycling"],
		["POST", "/v1/invite/tokens"],
		["DELETE", "/v1/invite/tokens/inv_1"],
		["POST", "/v1/threads"],
		["DELETE", "/v1/threads/thread_1"],
		["POST", "/v1/workspaces"],
		["PATCH", "/v1/workspaces/ws_1"],
		["POST", "/v1/workspaces/ws_1/archive"],
		["POST", "/v1/workspaces/ws_1/restore"],
		["DELETE", "/v1/workspaces/ws_1"],
		["PATCH", "/v1/org-settings"],
		["POST", "/v1/queue/slots"],
		["PUT", "/v1/queue/slots"],
		["DELETE", "/v1/queue/slots"],
		["POST", "/v1/api-keys"],
		["DELETE", "/v1/api-keys/key_1"],
		["PUT", "/v1/short-links/config"],
		["PATCH", "/v1/accounts/acc_1"],
		["DELETE", "/v1/cross-post-actions/action_1"],
		["PUT", "/v1/byos"],
		["DELETE", "/v1/byos"],
		["POST", "/v1/broadcasts"],
		["PATCH", "/v1/broadcasts/brd_1"],
		["DELETE", "/v1/broadcasts/brd_1"],
		["POST", "/v1/broadcasts/brd_1/recipients"],
		["POST", "/v1/broadcasts/brd_1/send"],
		["POST", "/v1/broadcasts/brd_1/schedule"],
		["POST", "/v1/broadcasts/brd_1/cancel"],
		["POST", "/v1/webhooks"],
		["PATCH", "/v1/webhooks/wh_1"],
		["DELETE", "/v1/webhooks/wh_1"],
		["POST", "/v1/webhooks/wh_1/rotate-secret"],
	];

	for (const [method, path] of postgresCompleteRoutes) {
		it(`classifies ${method} ${path} as request-Postgres complete`, () => {
			expect(getMutationEffectCoveragePolicy(method, path)).toBe(
				"postgres_complete",
			);
		});
	}

	const trackedCompleteRoutes: ReadonlyArray<readonly [string, string]> = [
		["POST", "/v1/twitter/retweet"],
		["DELETE", "/v1/twitter/retweet"],
		["POST", "/v1/twitter/bookmark"],
		["DELETE", "/v1/twitter/bookmark"],
		["POST", "/v1/twitter/follow"],
		["DELETE", "/v1/twitter/follow"],
		["POST", "/v1/inbox/conversations/convo_1/messages"],
		["POST", "/v1/inbox/conversations/convo_1/typing"],
		["POST", "/v1/inbox/conversations/convo_1/messages/msg_1/reactions"],
		["DELETE", "/v1/inbox/conversations/convo_1/messages/msg_1/reactions"],
		["DELETE", "/v1/inbox/conversations/convo_1/messages/msg_1"],
		["POST", "/v1/whatsapp/templates"],
		["DELETE", "/v1/whatsapp/templates/welcome"],
		["PUT", "/v1/whatsapp/business-profile"],
		["POST", "/v1/whatsapp/business-profile/display-name"],
		["POST", "/v1/whatsapp/business-profile/photo"],
		["POST", "/v1/whatsapp/flows"],
		["PATCH", "/v1/whatsapp/flows/flow_1"],
		["DELETE", "/v1/whatsapp/flows/flow_1"],
		["POST", "/v1/whatsapp/flows/flow_1/publish"],
		["POST", "/v1/whatsapp/flows/flow_1/deprecate"],
		["PUT", "/v1/whatsapp/flows/flow_1/json"],
		["POST", "/v1/whatsapp/flows/send"],
	];

	for (const [method, path] of trackedCompleteRoutes) {
		it(`classifies ${method} ${path} as boundary-tracked complete`, () => {
			expect(getMutationEffectCoveragePolicy(method, path)).toBe(
				"tracked_complete",
			);
		});
	}

	it("normalizes method case and accepts Hono's optional trailing slash", () => {
		expect(getMutationEffectCoveragePolicy("post", "/v1/contacts/")).toBe(
			"postgres_complete",
		);
		expect(
			getMutationEffectCoveragePolicy(
				"delete",
				"/v1/contacts/ct_1/channels/cc_1/",
			),
		).toBe("postgres_complete");
		expect(
			getMutationEffectCoveragePolicy("post", "/v1/broadcasts/brd_1/schedule/"),
		).toBe("postgres_complete");
		expect(
			getMutationEffectCoveragePolicy(
				"post",
				"/v1/webhooks/wh_1/rotate-secret/",
			),
		).toBe("postgres_complete");
	});

	it("fails closed for external, durable, queue, R2, and uninstrumented routes", () => {
		const incompleteRoutes: ReadonlyArray<readonly [string, string]> = [
			["POST", "/v1/ads/audiences"],
			["POST", "/v1/accounts/acc_1/sync"],
			["POST", "/v1/media/upload"],
			["POST", "/v1/whatsapp/phone-numbers/phone_1/verify"],
			["POST", "/v1/webhooks/test"],
			["POST", "/v1/ai-agents/agent_1/respond"],
			["POST", "/v1/ai-knowledge/kb_1/search"],
			["POST", "/v1/short-links/shorten"],
			["DELETE", "/v1/ideas/idea_1"],
		];

		for (const [method, path] of incompleteRoutes) {
			expect(getMutationEffectCoveragePolicy(method, path)).toBe("incomplete");
		}
	});

	it("anchors method and path instead of matching route prefixes", () => {
		const nearMisses: ReadonlyArray<readonly [string, string]> = [
			["GET", "/v1/contacts"],
			["POST", "/v1/contacts-extra"],
			["POST", "/v1/contacts/ct_1/channels/cc_1"],
			["DELETE", "/v1/contacts/ct_1/channels/cc_1/extra"],
			["POST", "/v1/content-templates/tpl_1"],
			["PATCH", "/v1/custom-fields/cfd_1/extra"],
			["POST", "/v1/tags?unexpected=query"],
			["GET", "/v1/broadcasts/brd_1/send"],
			["POST", "/v1/broadcasts/brd_1"],
			["POST", "/v1/broadcasts/brd_1/recipients/extra"],
			["POST", "/v1/broadcasts-extra"],
			["GET", "/v1/webhooks"],
			["POST", "/v1/webhooks/wh_1"],
			["POST", "/v1/webhooks/test"],
			["POST", "/v1/webhooks/wh_1/rotate-secret/extra"],
			["PATCH", "/v1/webhooks/wh_1/rotate-secret"],
		];

		for (const [method, path] of nearMisses) {
			expect(getMutationEffectCoveragePolicy(method, path)).toBe("incomplete");
		}
	});

	it("marks only webhook-test preflight rejections as authoritative K=0", async () => {
		const source = await Bun.file(
			new URL("../routes/webhooks.ts", import.meta.url),
		).text();
		const handler = source.slice(
			source.indexOf("app.openapi(testWebhookRoute"),
			source.indexOf(
				"app.openapi(getWebhookLogs",
				source.indexOf("app.openapi(testWebhookRoute"),
			),
		);
		const providerBoundary = handler.indexOf("await fetchWithTimeout");
		expect(providerBoundary).toBeGreaterThan(-1);
		expect(
			handler
				.slice(0, providerBoundary)
				.match(/markWebhookTestNotApplied\(c\)/g),
		).toHaveLength(3);
		expect(handler.slice(providerBoundary)).not.toContain(
			"markWebhookTestNotApplied(c)",
		);
		expect(handler.indexOf("if (!webhook)")).toBeLessThan(
			handler.indexOf("markWebhookTestNotApplied(c)"),
		);
		expect(handler).toContain("if (denied) {");
		expect(handler).toContain("if (await isBlockedUrlWithDns(webhook.url)) {");
	});

	it("keeps request-side broadcast delivery mutations PostgreSQL-owned", async () => {
		const source = await Bun.file(
			new URL("../routes/broadcasts.ts", import.meta.url),
		).text();
		const sendHandler = source.slice(
			source.indexOf("app.openapi(sendBroadcastRoute"),
			source.indexOf(
				"app.openapi(scheduleBroadcastRoute",
				source.indexOf("app.openapi(sendBroadcastRoute"),
			),
		);
		expect(sendHandler).toContain("processScheduledBroadcasts");
		expect(sendHandler).toContain(".update(broadcasts)");
		expect(sendHandler).toContain('status: "scheduled"');
		for (const providerCall of [
			"fetchWithTimeout(",
			"PUBLISH_QUEUE.send(",
			"adapter.",
			"publishPost(",
		]) {
			expect(sendHandler).not.toContain(providerCall);
		}
	});

	it("wraps every inbox-feed provider mutation and finalizes no-op paths", async () => {
		const source = await Bun.file(
			new URL("../routes/inbox-feed.ts", import.meta.url),
		).text();
		const handlerNames = [
			"sendMessageRoute",
			"sendTypingRoute",
			"addReactionRoute",
			"removeReactionRoute",
			"deleteMessageRoute",
		];

		for (const [index, handlerName] of handlerNames.entries()) {
			const start = source.indexOf(`app.openapi(${handlerName}`);
			const nextName = handlerNames[index + 1];
			const end = nextName
				? source.indexOf(`app.openapi(${nextName}`, start)
				: source.indexOf("// Notes — list", start);
			const handler = source.slice(start, end);
			expect(handler).toContain("new SingleUnitProviderMutationAggregate");
			expect(handler).toContain("trackedProviderFetch(");
			expect(handler).toContain("mutation.finalize()");
			if (handlerName === "sendMessageRoute") {
				expect(handler).toContain("mutation.hasCommittedEffect()");
			}
			// The only raw fetches are read-only participant lookups in send/typing.
			expect(handler.match(/await fetch\(/g)?.length ?? 0).toBe(
				index < 2 ? 1 : 0,
			);
		}
	});

	it("preserves AI provider outcomes across parsing and projection failures", async () => {
		const [agentSource, knowledgeSource] = await Promise.all([
			Bun.file(new URL("../routes/ai-agents.ts", import.meta.url)).text(),
			Bun.file(new URL("../routes/ai-knowledge.ts", import.meta.url)).text(),
		]);
		const respondHandler = agentSource.slice(
			agentSource.indexOf("app.openapi(respondAgent"),
			agentSource.indexOf("export default app"),
		);
		const searchHandler = knowledgeSource.slice(
			knowledgeSource.indexOf("app.openapi(searchKb"),
			knowledgeSource.indexOf("export default app"),
		);

		for (const handler of [respondHandler, searchHandler]) {
			expect(handler).toContain("new SingleUnitProviderMutationAggregate");
			expect(handler).toContain("markMutationInputNotApplied(c)");
			expect(handler).toContain("mutation.markCommitted()");
			expect(handler).toContain("mutation.finalize()");
		}
		expect(respondHandler).toContain("mutation,");
		expect(searchHandler).toContain("mutation,");
	});

	it("finalizes external short-link evidence only after provider egress", async () => {
		const source = await Bun.file(
			new URL("../routes/short-links.ts", import.meta.url),
		).text();
		const handler = source.slice(
			source.indexOf("app.openapi(shortenRoute"),
			source.indexOf("app.openapi(statsRoute"),
		);

		expect(handler).toContain("new SingleUnitProviderMutationAggregate");
		expect(handler).toContain("providerMutation.markCommitted()");
		expect(handler).toContain("providerMutation,");
		expect(handler).toContain("providerMutation.hasAttempts()");
		expect(handler).toContain("providerMutation.hasCommittedEffect()");
		expect(handler).toContain("providerMutation.finalize()");
		expect(handler.match(/markMutationInputNotApplied\(c\)/g)).toHaveLength(3);
	});

	it("enumerates exact pre-effect K=0 coverage for connect and account mutations", async () => {
		const [connectSource, accountsSource, validationSource] = await Promise.all(
			[
				Bun.file(new URL("../routes/connect.ts", import.meta.url)).text(),
				Bun.file(new URL("../routes/accounts.ts", import.meta.url)).text(),
				Bun.file(
					new URL("../middleware/mutation-validation.ts", import.meta.url),
				).text(),
			],
		);
		const handler = (source: string, name: string) => {
			const start = source.indexOf(`app.openapi(${name}`);
			expect(start).toBeGreaterThan(-1);
			const next = source.indexOf("app.openapi(", start + 1);
			return source.slice(start, next === -1 ? source.length : next);
		};

		const connectMutations = [
			["connectBeehiiv", 1, 1],
			["connectConvertKit", 1, 1],
			["connectMailchimp", 2, 1],
			["connectListMonk", 4, 1],
			["connectBluesky", 1, 1],
			["initTelegram", 0, 1],
			["whatsappEmbeddedSignup", 2, 1],
			["whatsappCredentials", 0, 1],
			["selectFacebookPage", 2, 1],
			["selectLinkedInOrg", 1, 1],
			["selectPinterestBoard", 1, 1],
			["selectGBPLocation", 2, 1],
			["selectSnapchatProfile", 1, 1],
			["completeOAuth", 13, 2],
		] as const;
		expect(connectMutations).toHaveLength(14);
		for (const [name, directMarkers, sharedMarkers] of connectMutations) {
			const source = handler(connectSource, name);
			expect(
				source.match(/markMutationInputNotApplied\(c\)/g) ?? [],
			).toHaveLength(directMarkers);
			expect(source.match(/connectionInputNotApplied\(c,/g) ?? []).toHaveLength(
				sharedMarkers,
			);
		}

		for (const name of [
			"selectFacebookPage",
			"selectLinkedInOrg",
			"selectPinterestBoard",
			"selectGBPLocation",
			"selectSnapchatProfile",
		]) {
			expect(handler(connectSource, name)).toContain(
				"authorizePendingSecondary(c, pendingData)",
			);
		}
		const authorizeStart = connectSource.indexOf(
			"async function authorizePendingSecondary",
		);
		const authorizeEnd = connectSource.indexOf(
			"export type OAuthExchangeResult",
			authorizeStart,
		);
		expect(
			connectSource
				.slice(authorizeStart, authorizeEnd)
				.match(/connectionInputNotApplied\(/g) ?? [],
		).toHaveLength(4);

		for (const [name, boundary] of [
			["connectBluesky", "const session = (await res.json())"],
			["whatsappEmbeddedSignup", "const accessToken = tokenData.access_token"],
		] as const) {
			const source = handler(connectSource, name);
			const boundaryIndex = source.indexOf(boundary);
			expect(boundaryIndex).toBeGreaterThan(-1);
			expect(source.slice(boundaryIndex)).not.toContain(
				"markMutationInputNotApplied(c)",
			);
			expect(source.slice(boundaryIndex)).not.toContain(
				"connectionInputNotApplied(c,",
			);
		}
		const provenOAuthErrorsStart = connectSource.indexOf(
			"const PROVEN_NOT_APPLIED_OAUTH_ERRORS",
		);
		const provenOAuthErrorsEnd = connectSource.indexOf(
			"type PendingSecondaryScope",
			provenOAuthErrorsStart,
		);
		const provenOAuthErrors = connectSource.slice(
			provenOAuthErrorsStart,
			provenOAuthErrorsEnd,
		);
		for (const code of [
			"OAUTH_NOT_SUPPORTED",
			"MISSING_CREDENTIALS",
			"ACCOUNT_WORKSPACE_CONFLICT",
			"WORKSPACE_ACCESS_DENIED",
		]) {
			expect(provenOAuthErrors).toContain(`"${code}"`);
		}
		for (const code of ["PROFILE_FETCH_FAILED", "ACCOUNT_SAVE_FAILED"]) {
			expect(provenOAuthErrors).not.toContain(`"${code}"`);
		}
		const completeHandler = handler(connectSource, "completeOAuth");
		expect(completeHandler).toContain(
			"PROVEN_NOT_APPLIED_OAUTH_ERRORS.has(result.code)",
		);
		const completeCatch = completeHandler.indexOf("} catch (err)");
		expect(completeCatch).toBeGreaterThan(-1);
		expect(completeHandler.slice(completeCatch)).not.toContain(
			"markMutationInputNotApplied(c)",
		);
		for (const name of ["connectBluesky", "whatsappEmbeddedSignup"]) {
			const source = handler(connectSource, name);
			expect(source).toContain("isDefinitiveProviderMutationRejection(");
		}

		for (const name of [
			"selectFacebookPage",
			"selectLinkedInOrg",
			"selectPinterestBoard",
			"selectGBPLocation",
			"selectSnapchatProfile",
		]) {
			const source = handler(connectSource, name);
			const boundaryIndex = source.indexOf("persistConnectedAccount({");
			expect(boundaryIndex).toBeGreaterThan(-1);
			expect(source.slice(boundaryIndex)).not.toContain(
				"markMutationInputNotApplied(c)",
			);
			expect(source.slice(boundaryIndex)).not.toContain(
				"connectionInputNotApplied(c,",
			);
		}

		const deleteAccountHandler = handler(accountsSource, "deleteAccount");
		expect(
			deleteAccountHandler.match(/markMutationInputNotApplied\(c\)/g) ?? [],
		).toHaveLength(3);
		const disconnectBoundary = deleteAccountHandler.indexOf(
			"deleteConnectedAccountGraph(",
		);
		const replayProof = deleteAccountHandler.indexOf(
			"if (!persistedDisconnectEvent)",
		);
		const cacheRepair = deleteAccountHandler.indexOf(
			"invalidateAccountCaches(c.env.KV",
		);
		expect(disconnectBoundary).toBeGreaterThan(-1);
		expect(replayProof).toBeGreaterThan(disconnectBoundary);
		expect(cacheRepair).toBeGreaterThan(replayProof);
		expect(deleteAccountHandler.slice(replayProof, cacheRepair)).toContain(
			"markMutationInputNotApplied(c)",
		);
		expect(deleteAccountHandler.slice(cacheRepair)).not.toContain(
			"markMutationInputNotApplied(c)",
		);

		for (const name of [
			"setFacebookPage",
			"setLinkedInOrg",
			"setPinterestBoard",
			"setRedditSubreddit",
			"setGmbLocation",
			"setYoutubePlaylist",
		]) {
			const source = handler(accountsSource, name);
			expect(
				source.match(/markMutationInputNotApplied\(c\)/g) ?? [],
			).toHaveLength(2);
			const boundaryIndex = source.indexOf(".update(socialAccounts)");
			expect(boundaryIndex).toBeGreaterThan(-1);
			expect(source.slice(boundaryIndex)).not.toContain(
				"markMutationInputNotApplied(c)",
			);
		}

		const returnHelperStart = validationSource.indexOf(
			"export function returnMutationInputNotApplied",
		);
		const returnHelperEnd = validationSource.indexOf(
			"export const openApiMutationValidationHook",
			returnHelperStart,
		);
		expect(returnHelperStart).toBeGreaterThan(-1);
		expect(
			validationSource
				.slice(returnHelperStart, returnHelperEnd)
				.match(/markMutationInputNotApplied\(c\)/g) ?? [],
		).toHaveLength(1);

		const conflictHelperStart = connectSource.indexOf(
			"function accountWorkspaceConflictResponse",
		);
		const conflictHelperEnd = connectSource.indexOf(
			"function accountConnectedPayload",
			conflictHelperStart,
		);
		expect(
			connectSource
				.slice(conflictHelperStart, conflictHelperEnd)
				.match(/markMutationInputNotApplied\(c\)/g) ?? [],
		).toHaveLength(2);
	});
});
