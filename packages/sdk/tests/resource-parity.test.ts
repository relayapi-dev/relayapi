import { describe, expect, it } from "bun:test";
import Relay, { POST_TARGET_PLATFORMS } from "../src";

const API_KEY = ["rlay", "test", "resource-parity"].join("_");

describe("hand-written resource parity", () => {
	it("exposes the exact typed 22-platform publishing union", () => {
		expect(POST_TARGET_PLATFORMS).toEqual([
			"twitter",
			"instagram",
			"facebook",
			"linkedin",
			"tiktok",
			"youtube",
			"pinterest",
			"reddit",
			"bluesky",
			"threads",
			"telegram",
			"snapchat",
			"googlebusiness",
			"whatsapp",
			"mastodon",
			"discord",
			"sms",
			"beehiiv",
			"convertkit",
			"mailchimp",
			"listmonk",
			"slack",
		]);
		expect(new Set(POST_TARGET_PLATFORMS).size).toBe(22);
	});

	it("maps API-owned email intent routes", async () => {
		const requests: Array<{ body: string; method: string; url: string }> = [];
		const client = new Relay({
			apiKey: API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 0,
			fetch: async (input, init) => {
				requests.push({
					body: String(init?.body ?? ""),
					method: init?.method ?? "GET",
					url: String(input),
				});
				return Response.json({ delivery_id: "email_1", status: "staged" });
			},
		});

		await client.emailIntents.resendInvitation("invite_1", {
			idempotencyKey: "resend_123",
		});
		await client.emailIntents.requestOnDemandPlatform(
			{ platform: "Example", email: "person@example.com" },
			{ idempotencyKey: "support_123" },
		);

		expect(
			requests.map(
				({ method, url }) => `${method} ${new URL(url).pathname}`,
			),
		).toEqual([
			"POST /v1/invitations/invite_1/resend",
			"POST /v1/support/on-demand-platform-requests",
		]);
		expect(requests[0]?.body).toBe("");
		expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({
			platform: "Example",
			email: "person@example.com",
		});
	});

	it("maps AI and BYOS completion routes", async () => {
		const requests: Array<{ method: string; url: string }> = [];
		const client = new Relay({
			apiKey: API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 0,
			fetch: async (input, init) => {
				const method = init?.method ?? "GET";
				requests.push({ method, url: String(input) });
				return method === "DELETE"
					? new Response(null, { status: 204 })
					: Response.json({});
			},
		});

		await client.byos.retrieve();
		await client.byos.update({
			endpoint: "https://objects.example.test",
			bucket: "tenant-media",
			access_key_id: "access",
			secret_access_key: "secret",
		});
		await client.byos.test();
		await client.byos.delete();
		await client.aiKnowledge.search("kb_1", { query: "refund policy" });
		await client.aiKnowledge.documents.create("kb_1", {
			source_type: "media",
			media_id: "med_1",
		});
		await client.aiKnowledge.documents.retry("kb_1", "doc_1");
		await client.aiAgents.create({ name: "Support" });
		await client.aiAgents.respond("agent_1", { message: "Help" });

		expect(
			requests.map(
				({ method, url }) => `${method} ${new URL(url).pathname}`,
			),
		).toEqual([
			"GET /v1/byos",
			"PUT /v1/byos",
			"POST /v1/byos/test",
			"DELETE /v1/byos",
			"POST /v1/ai-knowledge/kb_1/search",
			"POST /v1/ai-knowledge/kb_1/documents",
			"POST /v1/ai-knowledge/kb_1/documents/doc_1/retry",
			"POST /v1/ai-agents",
			"POST /v1/ai-agents/agent_1/respond",
		]);
	});

	it("maps API-owned dashboard billing routes", async () => {
		const requests: Array<{ method: string; url: string }> = [];
		const client = new Relay({
			apiKey: API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 0,
			fetch: async (input, init) => {
				requests.push({ method: init?.method ?? "GET", url: String(input) });
				return Response.json({});
			},
		});

		await client.billing.status();
		await client.billing.checkout();
		await client.billing.portal();
		await client.billing.sync();

		expect(
			requests.map(
				({ method, url }) => `${method} ${new URL(url).pathname}`,
			),
		).toEqual([
			"GET /v1/billing",
			"POST /v1/billing/checkout",
			"POST /v1/billing/portal",
			"POST /v1/billing/sync",
		]);
	});

	it("maps public-growth definition resources", async () => {
		const requests: Array<{ method: string; url: string }> = [];
		const client = new Relay({
			apiKey: API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 0,
			fetch: async (input, init) => {
				const method = init?.method ?? "GET";
				requests.push({ method, url: String(input) });
				return method === "DELETE"
					? new Response(null, { status: 204 })
					: Response.json({});
			},
		});
		await client.refUrls.create({
			slug: "summer",
			destination: { type: "https_url", url: "https://example.test" },
		});
		await client.refUrls.recordClick("ref_1", {
			contact_id: "ct_1",
			idempotency_key: "visit_1",
		});
		await client.qrCodes.create({
			ref_url_id: "ref_1",
			label: "front-window",
		});
		await client.qrCodes.list({ ref_url_id: "ref_1" });
		await client.qrCodes.retrieve("qr_1");
		await client.qrCodes.update("qr_1", { campaign_key: "summer" });
		await client.qrCodes.delete("qr_1");
		await client.landingPages.create({
			slug: "welcome",
			title: "Welcome",
			config: {
				version: 1,
				theme: {
					mode: "light",
					background_color: "#ffffff",
					text_color: "#111827",
					accent_color: "#2563eb",
					font: "sans",
				},
				blocks: [],
			},
		});
		await client.landingPages.list({ workspace_id: "ws_1" });
		await client.landingPages.retrieve("lp_1");
		await client.landingPages.update("lp_1", { enabled: false });
		await client.landingPages.delete("lp_1");

		expect(
			requests.map(
				({ method, url }) =>
					`${method} ${new URL(url).pathname}${new URL(url).search}`,
			),
		).toEqual([
			"POST /v1/ref-urls",
			"POST /v1/ref-urls/ref_1/click",
			"POST /v1/qr-codes",
			"GET /v1/qr-codes?ref_url_id=ref_1",
			"GET /v1/qr-codes/qr_1",
			"PATCH /v1/qr-codes/qr_1",
			"DELETE /v1/qr-codes/qr_1",
			"POST /v1/landing-pages",
			"GET /v1/landing-pages?workspace_id=ws_1",
			"GET /v1/landing-pages/lp_1",
			"PATCH /v1/landing-pages/lp_1",
			"DELETE /v1/landing-pages/lp_1",
		]);
	});

	it("maps subscription-list membership and post-tag routes", async () => {
		const requests: Array<{ method: string; url: string }> = [];
		const client = new Relay({
			apiKey: API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 0,
			fetch: async (input, init) => {
				const method = init?.method ?? "GET";
				requests.push({ method, url: String(input) });
				return method === "DELETE"
					? new Response(null, { status: 204 })
					: Response.json({});
			},
		});

		await client.subscriptionLists.create({
			name: "Customers",
			channel: "whatsapp",
		});
		await client.subscriptionLists.list({ channel: "whatsapp" });
		await client.subscriptionLists.retrieve("sublist_1");
		await client.subscriptionLists.update("sublist_1", {
			name: "Active customers",
		});
		await client.subscriptionLists.members.list("sublist_1", {
			status: "all",
		});
		await client.subscriptionLists.members.add("sublist_1", {
			contact_id: "ct_1",
		});
		await client.subscriptionLists.members.unsubscribe(
			"sublist_1",
			"ct_1",
		);
		await client.subscriptionLists.delete("sublist_1");
		await client.posts.tags.list("post_1", { limit: 10 });
		await client.posts.tags.attach("post_1", "tag_1");
		await client.posts.tags.detach("post_1", "tag_1");

		expect(
			requests.map(
				({ method, url }) =>
					`${method} ${new URL(url).pathname}${new URL(url).search}`,
			),
		).toEqual([
			"POST /v1/subscription-lists",
			"GET /v1/subscription-lists?channel=whatsapp",
			"GET /v1/subscription-lists/sublist_1",
			"PATCH /v1/subscription-lists/sublist_1",
			"GET /v1/subscription-lists/sublist_1/members?status=all",
			"POST /v1/subscription-lists/sublist_1/members",
			"DELETE /v1/subscription-lists/sublist_1/members/ct_1",
			"DELETE /v1/subscription-lists/sublist_1",
			"GET /v1/posts/post_1/tags?limit=10",
			"PUT /v1/posts/post_1/tags/tag_1",
			"DELETE /v1/posts/post_1/tags/tag_1",
		]);
	});

	it("maps API-owned system administration routes", async () => {
		const requests: Array<{ method: string; url: string }> = [];
		const client = new Relay({
			apiKey: API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 0,
			fetch: async (input, init) => {
				requests.push({ method: init?.method ?? "GET", url: String(input) });
				return Response.json({ ok: true });
			},
		});

		await client.admin.listOrganizations({ limit: 25, offset: 50 });
		await client.admin.updateOrganization("org_1", { plan: "pro" });
		await client.admin.listSubscriptions();
		await client.admin.updateSubscription("sub_1", { status: "active" });
		await client.admin.listErasureHolds({
			organizationId: "org_1",
			active: "true",
		});
		await client.admin.listErasureJobs({
			organizationId: "org_1",
			status: "held",
			aged: "true",
		});
		await client.admin.listAutomationWebhookFailures({
			organizationId: "org_1",
			review: "required",
		});
		await client.admin.listOperatorResolutions({
			organizationId: "org_1",
			targetType: "automation_effect",
		});
		await client.admin.resolveOperatorResolution(
			"automation_effect",
			"aef_1",
			{
				action: "mark_not_applied",
				reason: "Provider support confirmed no request was applied",
			},
		);
		await client.admin.createErasureHold({
			subjectKind: "workspace",
			organizationId: "org_1",
			workspaceId: "ws_1",
			reasonCode: "legal_dispute",
			reasonSummary: "Preserve eligible records",
			legalAuthorityRef: "case-123",
		});
		await client.admin.releaseErasureHold("hold_1", {
			releaseReasonSummary: "Matter resolved",
		});
		await client.privacy.listActiveErasureHolds({ workspace_id: "ws_1" });

		expect(
			requests.map(
				({ method, url }) =>
					`${method} ${new URL(url).pathname}${new URL(url).search}`,
			),
		).toEqual([
			"GET /v1/admin/organizations?limit=25&offset=50",
			"PATCH /v1/admin/organizations/org_1",
			"GET /v1/admin/subscriptions",
			"PATCH /v1/admin/subscriptions/sub_1",
			"GET /v1/admin/erasure-holds?organizationId=org_1&active=true",
			"GET /v1/admin/erasure-jobs?organizationId=org_1&status=held&aged=true",
			"GET /v1/admin/automation-webhook-failures?organizationId=org_1&review=required",
			"GET /v1/admin/operator-resolutions?organizationId=org_1&targetType=automation_effect",
			"POST /v1/admin/operator-resolutions/automation_effect/aef_1",
			"POST /v1/admin/erasure-holds",
			"POST /v1/admin/erasure-holds/hold_1/release",
			"GET /v1/privacy/erasure-holds?workspace_id=ws_1",
		]);
	});

	it("maps the inbox AI and feed methods to their API routes", async () => {
		const requests: Array<{ method: string; url: string }> = [];
		const client = new Relay({
			apiKey: API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 0,
			fetch: async (input, init) => {
				requests.push({ method: init?.method ?? "GET", url: String(input) });
				return Response.json({});
			},
		});

		await client.inbox.classify({ messages: [{ text: "hello" }] });
		await client.inbox.suggestReply({ conversation_id: "conv_1" });
		await client.inbox.summarize({ conversation_id: "conv_1" });
		await client.inbox.priorities({ limit: 10 });
		await client.inbox.search({ q: "refund" });
		await client.inbox.stats({ platform: "instagram" });

		expect(requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
			"POST /v1/inbox/classify",
			"POST /v1/inbox/suggest-reply",
			"POST /v1/inbox/summarize",
			"GET /v1/inbox/priorities",
			"GET /v1/inbox/search",
			"GET /v1/inbox/stats",
		]);
	});

	it("maps every downloader, transcript, resolver, and job poll route", async () => {
		const paths: string[] = [];
		const client = new Relay({
			apiKey: API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 0,
			fetch: async (input) => {
				paths.push(new URL(String(input)).pathname);
				return Response.json({});
			},
		});
		const body = { url: "https://example.test/content" };

		await client.tools.resolveLinkedInMention({
			account_id: "acc_1",
			type: "organization",
			vanity_name: "relay",
		});
		await client.tools.downloadYoutube(body);
		await client.tools.downloadTiktok(body);
		await client.tools.downloadInstagram(body);
		await client.tools.downloadTwitter(body);
		await client.tools.downloadFacebook(body);
		await client.tools.downloadLinkedin(body);
		await client.tools.downloadBluesky(body);
		await client.tools.getYoutubeTranscript({ url: "video-id" });
		await client.tools.getJobStatus("tj_1");

		expect(paths).toEqual([
			"/v1/tools/linkedin/resolve-mention",
			"/v1/tools/youtube/download",
			"/v1/tools/tiktok/download",
			"/v1/tools/instagram/download",
			"/v1/tools/twitter/download",
			"/v1/tools/facebook/download",
			"/v1/tools/linkedin/download",
			"/v1/tools/bluesky/download",
			"/v1/tools/youtube/transcript",
			"/v1/tools/jobs/tj_1",
		]);
	});

	it("maps the typed ad audience account and JSON-rule contracts", async () => {
		const requests: Array<{ body: string; method: string; url: string }> = [];
		const client = new Relay({
			apiKey: API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 0,
			fetch: async (input, init) => {
				requests.push({
					body: String(init?.body ?? ""),
					method: init?.method ?? "GET",
					url: String(input),
				});
				return Response.json({ data: [], next_cursor: null, has_more: false });
			},
		});

		await client.ads.listAudiences({ ad_account_id: "ada_1" });
		await client.ads.createAudience({
			ad_account_id: "ada_1",
			name: "Pricing visitors",
			type: "website",
			pixel_id: "pixel_1",
			rule: { url: { contains: "pricing" } },
		});

		expect(
			requests.map(
				({ method, url }) =>
					`${method} ${new URL(url).pathname}${new URL(url).search}`,
			),
		).toEqual([
			"GET /v1/ads/audiences?ad_account_id=ada_1",
			"POST /v1/ads/audiences",
		]);
		expect(JSON.parse(requests[1]?.body ?? "{}").rule).toEqual({
			url: { contains: "pricing" },
		});
	});

	it("does not expose API routes that do not exist", () => {
		const client = new Relay({ apiKey: API_KEY });
		expect("groups" in client.whatsapp).toBe(false);
	});
});
