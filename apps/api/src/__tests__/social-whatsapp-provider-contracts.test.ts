import { afterEach, describe, expect, it } from "bun:test";
import { GroupMessageBody, GroupPinBody } from "../schemas/whatsapp-admin";
import {
	editConversationMessage,
	editProviderComment,
	editPublishedPost,
	engageProviderPost,
	moderateProviderComment,
	sendReadReceipt,
} from "../services/social-provider-actions";
import {
	createWhatsAppGroup,
	createWhatsAppTemplateFromLibrary,
	editWhatsAppTemplate,
	listWhatsAppTemplateLibrary,
	mutateBlockedWhatsAppUsers,
	pinWhatsAppGroupMessage,
	probeWhatsAppAdminCapabilities,
	removeWhatsAppGroupParticipants,
	resetWhatsAppGroupInviteLink,
	resolveWhatsAppJoinRequests,
	sendWhatsAppGroupMessage,
	setWhatsAppBusinessUsername,
	updateWhatsAppGroup,
} from "../services/whatsapp-admin-provider";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

type CapturedRequest = { url: string; init?: RequestInit };

function captureFetch(
	responses: Array<{ status?: number; body?: unknown }>,
): CapturedRequest[] {
	const requests: CapturedRequest[] = [];
	globalThis.fetch = (async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		requests.push({ url: String(input), init });
		const response = responses.shift() ?? {};
		return new Response(
			response.body === undefined ? null : JSON.stringify(response.body),
			{
				status: response.status ?? 200,
				headers:
					response.body === undefined
						? undefined
						: { "Content-Type": "application/json" },
			},
		);
	}) as typeof fetch;
	return requests;
}

describe("published and message edit provider contracts", () => {
	it("uses X edit_options and returns the replacement Post ID", async () => {
		const requests = captureFetch([{ body: { data: { id: "tweet-new" } } }]);
		const result = await editPublishedPost(
			{
				id: "acc_x",
				platform: "twitter",
				platformAccountId: "user-x",
				accessToken: "token-x",
			},
			"tweet-old",
			"replacement",
		);

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://api.x.com/2/tweets");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			text: "replacement",
			edit_options: { previous_post_id: "tweet-old" },
		});
		expect(result.providerId).toBe("tweet-new");
	});

	it("edits only the originating Discord webhook message and disables mentions", async () => {
		const requests = captureFetch([{ body: { id: "message-1" } }]);
		await editPublishedPost(
			{
				id: "acc_discord",
				platform: "discord",
				platformAccountId: "channel-1",
				accessToken: "https://discord.com/api/webhooks/123456/token_value",
			},
			"message-1",
			"safe edit",
		);

		expect(requests[0]?.url).toBe(
			"https://discord.com/api/webhooks/123456/token_value/messages/message-1",
		);
		expect(requests[0]?.init?.method).toBe("PATCH");
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			content: "safe edit",
			allowed_mentions: { parse: [] },
		});
	});

	it("passes exact Discord thread context and fails closed when it is missing", async () => {
		const discordThreadId = ["223456789", "012345678"].join("");
		const requests = captureFetch([{ body: { id: "message-thread" } }]);
		await editPublishedPost(
			{
				id: "acc_discord",
				platform: "discord",
				platformAccountId: "channel-1",
				accessToken: "https://discord.com/api/webhooks/123456/token_value",
			},
			"message-thread",
			"thread edit",
			{
				discordThreadContextRequired: true,
				discordThreadId,
			},
		);

		expect(new URL(requests[0]?.url ?? "").searchParams.get("thread_id")).toBe(
			discordThreadId,
		);
		await expect(
			editPublishedPost(
				{
					id: "acc_discord",
					platform: "discord",
					platformAccountId: "channel-1",
					accessToken: "https://discord.com/api/webhooks/123456/token_value",
				},
				"message-missing-context",
				"blocked edit",
				{ discordThreadContextRequired: true },
			),
		).rejects.toMatchObject({
			code: "DISCORD_THREAD_CONTEXT_MISSING",
			definitive: true,
		});
		expect(requests).toHaveLength(1);
	});

	it("uses an explicitly scoped Discord inbox conversation as thread context", async () => {
		const discordThreadId = ["223456789", "012345678"].join("");
		const requests = captureFetch([{ body: { id: "message-thread" } }]);
		await editConversationMessage(
			{
				id: "acc_discord",
				platform: "discord",
				platformAccountId: "channel-1",
				accessToken: "https://discord.com/api/webhooks/123456/token_value",
			},
			discordThreadId,
			"message-thread",
			"thread edit",
			{
				discordThreadScoped: true,
				discordThreadId,
			},
		);
		expect(new URL(requests[0]?.url ?? "").searchParams.get("thread_id")).toBe(
			discordThreadId,
		);
	});

	it("uses the same official provider contracts for Discord messages and X replies", async () => {
		const requests = captureFetch([
			{ body: { id: "message-2" } },
			{ body: { data: { id: "reply-new" } } },
		]);
		await editConversationMessage(
			{
				id: "acc_discord",
				platform: "discord",
				platformAccountId: "channel-1",
				accessToken: "https://discord.com/api/webhooks/123456/token_value",
			},
			"channel-1",
			"message-2",
			"message edit",
		);
		const reply = await editProviderComment(
			{
				id: "acc_x",
				platform: "twitter",
				platformAccountId: "user-x",
				accessToken: "token-x",
			},
			"reply-old",
			"reply edit",
		);

		expect(requests[0]?.url).toContain("/messages/message-2");
		expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
			content: "message edit",
		});
		expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
			text: "reply edit",
			edit_options: { previous_post_id: "reply-old" },
		});
		expect(reply.providerId).toBe("reply-new");
	});

	it("uses Reddit editusertext form fields", async () => {
		const requests = captureFetch([{ body: { json: { errors: [] } } }]);
		await editPublishedPost(
			{
				id: "acc_reddit",
				platform: "reddit",
				platformAccountId: "user-r",
				accessToken: "token-r",
			},
			"t3_post",
			"new self text",
		);

		expect(requests[0]?.url).toBe("https://oauth.reddit.com/api/editusertext");
		const form = new URLSearchParams(String(requests[0]?.init?.body));
		expect(form.get("api_type")).toBe("json");
		expect(form.get("thing_id")).toBe("t3_post");
		expect(form.get("text")).toBe("new self text");
	});

	it("uses Telegram's numeric message ID and WhatsApp's exact read target", async () => {
		const requests = captureFetch([
			{ body: { ok: true, result: { message_id: 42 } } },
			{ body: { success: true } },
		]);
		await editConversationMessage(
			{
				id: "acc_tg",
				platform: "telegram",
				platformAccountId: "bot",
				accessToken: "bot-token",
			},
			"chat-1",
			"42",
			"edited",
		);
		await sendReadReceipt(
			{
				id: "acc_wa",
				platform: "whatsapp",
				platformAccountId: "phone-number-id",
				accessToken: "wa-token",
			},
			"conversation-unused-by-wa",
			"wamid.exact",
		);

		expect(requests[0]?.url).toContain("/editMessageText");
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			chat_id: "chat-1",
			message_id: 42,
			text: "edited",
		});
		expect(requests[1]?.url).toContain("/phone-number-id/messages");
		expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
			messaging_product: "whatsapp",
			status: "read",
			message_id: "wamid.exact",
		});
	});

	it("uses X's distinct like and unlike request contracts", async () => {
		const requests = captureFetch([
			{ body: { data: { liked: true } } },
			{ body: { data: { liked: false } } },
		]);
		const account = {
			id: "acc_x",
			platform: "twitter" as const,
			platformAccountId: "user-x",
			accessToken: "token-x",
		};

		await engageProviderPost(account, "tweet-1", "like");
		await engageProviderPost(account, "tweet-1", "unlike");

		expect(requests[0]?.url).toBe("https://api.x.com/2/users/user-x/likes");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[0]?.init?.headers).toMatchObject({
			Authorization: "Bearer token-x",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			tweet_id: "tweet-1",
		});
		expect(requests[1]?.url).toBe(
			"https://api.x.com/2/users/user-x/likes/tweet-1",
		);
		expect(requests[1]?.init?.method).toBe("DELETE");
		expect(requests[1]?.init?.body).toBeUndefined();
	});

	it("keeps Meta access tokens out of URLs and JSON bodies", async () => {
		const requests = captureFetch([
			{ body: { success: true } },
			{ body: { success: true } },
			{ body: { recipient_id: "customer-1" } },
			{ body: { success: true } },
			{ body: { success: true } },
		]);
		const token = "meta-secret-token";
		const facebook = {
			id: "acc_fb",
			platform: "facebook" as const,
			platformAccountId: "page-1",
			accessToken: token,
		};

		await editPublishedPost(facebook, "post-1", "post edit");
		await editProviderComment(facebook, "comment-1", "comment edit");
		await sendReadReceipt(facebook, "customer-1", "message-1");
		await moderateProviderComment(facebook, "comment-1", "hide");
		await engageProviderPost(facebook, "post-1", "like");

		for (const request of requests) {
			expect(request.url).not.toContain(token);
			expect(String(request.init?.body ?? "")).not.toContain(token);
			expect(request.init?.headers).toMatchObject({
				Authorization: `Bearer ${token}`,
			});
		}
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			message: "post edit",
		});
		expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
			message: "comment edit",
		});
		expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
			recipient: { id: "customer-1" },
			sender_action: "mark_seen",
		});
		expect(JSON.parse(String(requests[3]?.init?.body))).toEqual({
			is_hidden: true,
		});
	});

	it("does not surface credential-bearing transport errors", async () => {
		globalThis.fetch = (async () => {
			throw new Error(
				"request failed for https://api.telegram.org/botsecret-bot-token/editMessageText",
			);
		}) as unknown as typeof fetch;
		try {
			await editConversationMessage(
				{
					id: "acc_tg",
					platform: "telegram",
					platformAccountId: "bot",
					accessToken: "secret-bot-token",
				},
				"chat-1",
				"42",
				"edited",
			);
			throw new Error("expected provider failure");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toBe(
				"Provider transport failed after dispatch; outcome is unknown",
			);
			expect(message).not.toContain("secret-bot-token");
		}
	});
});

describe("provider mutation confirmation guards", () => {
	const facebook = {
		id: "acc_fb",
		platform: "facebook" as const,
		platformAccountId: "page-1",
		accessToken: "meta-token",
	};
	const twitter = {
		id: "acc_x",
		platform: "twitter" as const,
		platformAccountId: "user-x",
		accessToken: "x-token",
	};

	it("rejects explicit negative logical envelopes inside HTTP 2xx", async () => {
		captureFetch([{ body: { success: false } }]);
		await expect(
			editPublishedPost(facebook, "post-1", "rejected"),
		).rejects.toMatchObject({
			code: "FACEBOOK_EDIT_REJECTED",
			status: 400,
			definitive: true,
		});

		captureFetch([{ body: { ok: false, error_code: 400 } }]);
		await expect(
			editConversationMessage(
				{
					id: "acc_tg",
					platform: "telegram",
					platformAccountId: "bot",
					accessToken: "bot-token",
				},
				"chat-1",
				"42",
				"rejected",
			),
		).rejects.toMatchObject({
			code: "TELEGRAM_EDIT_REJECTED",
			status: 400,
			definitive: true,
		});

		captureFetch([{ body: { data: { liked: false } } }]);
		await expect(
			engageProviderPost(twitter, "tweet-1", "like"),
		).rejects.toMatchObject({
			code: "X_ENGAGEMENT_REJECTED",
			status: 400,
			definitive: true,
		});

		captureFetch([{ body: { success: false } }]);
		await expect(
			sendReadReceipt(
				{
					id: "acc_wa",
					platform: "whatsapp",
					platformAccountId: "phone-number-id",
					accessToken: "wa-token",
				},
				"conversation-1",
				"wamid.1",
			),
		).rejects.toMatchObject({
			code: "WHATSAPP_READ_RECEIPT_REJECTED",
			status: 400,
			definitive: true,
		});
	});

	it("keeps missing or mismatched provider identity outcome-unknown", async () => {
		captureFetch([{ body: {} }]);
		await expect(
			editPublishedPost(facebook, "post-1", "missing ack"),
		).rejects.toMatchObject({
			code: "PROVIDER_RESPONSE_INVALID",
			status: null,
			definitive: false,
		});

		captureFetch([{ body: { recipient_id: "different-recipient" } }]);
		await expect(
			sendReadReceipt(facebook, "expected-recipient", "message-1"),
		).rejects.toMatchObject({
			code: "PROVIDER_RESPONSE_INVALID",
			definitive: false,
		});

		captureFetch([{ body: { id: "different-message" } }]);
		await expect(
			editPublishedPost(
				{
					id: "acc_discord",
					platform: "discord",
					platformAccountId: "channel-1",
					accessToken: "https://discord.com/api/webhooks/123456/token_value",
				},
				"expected-message",
				"mismatch",
			),
		).rejects.toMatchObject({
			code: "PROVIDER_RESPONSE_INVALID",
			definitive: false,
		});

		captureFetch([{ body: { ok: true, result: { message_id: 43 } } }]);
		await expect(
			editConversationMessage(
				{
					id: "acc_tg",
					platform: "telegram",
					platformAccountId: "bot",
					accessToken: "bot-token",
				},
				"chat-1",
				"42",
				"mismatch",
			),
		).rejects.toMatchObject({
			code: "PROVIDER_RESPONSE_INVALID",
			definitive: false,
		});

		captureFetch([{ body: { id: "different-comment" } }]);
		await expect(
			editProviderComment(
				{
					id: "acc_youtube",
					platform: "youtube",
					platformAccountId: "channel-1",
					accessToken: "youtube-token",
				},
				"comment-1",
				"mismatch",
			),
		).rejects.toMatchObject({
			code: "PROVIDER_RESPONSE_INVALID",
			definitive: false,
		});
	});

	it("accepts only the documented no-content success for YouTube writes", async () => {
		const youtube = {
			id: "acc_youtube",
			platform: "youtube" as const,
			platformAccountId: "channel-1",
			accessToken: "youtube-token",
		};

		captureFetch([{ status: 204 }]);
		await expect(
			moderateProviderComment(youtube, "comment-1", "approve"),
		).resolves.toMatchObject({ providerId: "comment-1" });

		captureFetch([{ status: 204 }]);
		await expect(
			engageProviderPost(youtube, "video-1", "like"),
		).resolves.toMatchObject({ providerId: "video-1" });

		captureFetch([{ body: { success: true } }]);
		await expect(
			moderateProviderComment(youtube, "comment-1", "approve"),
		).rejects.toMatchObject({
			code: "PROVIDER_RESPONSE_INVALID",
			definitive: false,
		});
	});

	it("accepts Reddit's empty vote response but rejects an invented JSON ack", async () => {
		const reddit = {
			id: "acc_reddit",
			platform: "reddit" as const,
			platformAccountId: "user-r",
			accessToken: "reddit-token",
		};

		captureFetch([{}]);
		await expect(
			engageProviderPost(reddit, "t3_post", "upvote"),
		).resolves.toMatchObject({ providerId: "t3_post" });

		captureFetch([{ body: { success: true } }]);
		await expect(
			engageProviderPost(reddit, "t3_post", "upvote"),
		).rejects.toMatchObject({
			code: "PROVIDER_RESPONSE_INVALID",
			definitive: false,
		});
	});
});

describe("official WhatsApp Groups and block-user contracts", () => {
	const account = {
		phoneNumberId: "phone-number-id",
		wabaId: "waba-id",
		accessToken: "wa-token",
	};

	it("reports supported only for feature-specific successful read probes", async () => {
		const requests = captureFetch([
			{ body: { data: [] } },
			{ body: { data: [] } },
			{ body: { data: [] } },
			{ body: { data: [] } },
		]);
		const capabilities = await probeWhatsAppAdminCapabilities(account);

		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			expect.stringContaining("/phone-number-id/groups"),
			expect.stringContaining("/phone-number-id/block_users"),
			expect.stringContaining("/phone-number-id/username_suggestions"),
			expect.stringContaining("/message_template_library"),
		]);
		expect(capabilities).toEqual({
			groups: "supported",
			block_users: "supported",
			business_username: "supported",
			template_library: "supported",
			template_edit: "requires_eligibility",
			bsuid_webhooks: "requires_eligibility",
			bsuid_outbound: "requires_eligibility",
		});
	});

	it("never converts generic 400/401/403 provider failures into eligibility proof", async () => {
		captureFetch([
			{ status: 400, body: { error: { code: 100 } } },
			{ status: 403, body: { error: { code: 200 } } },
			{ status: 401, body: { error: { code: 190 } } },
			{ status: 503, body: { error: { code: 2 } } },
		]);
		const capabilities = await probeWhatsAppAdminCapabilities(account);

		expect(capabilities.groups).toBe("unverified");
		expect(capabilities.block_users).toBe("unavailable");
		expect(capabilities.business_username).toBe("unavailable");
		expect(capabilities.template_library).toBe("unverified");
		expect(Object.values(capabilities)).not.toContain("requires_oba");
	});

	it("uses the official create and invite-only participant removal shapes", async () => {
		const requests = captureFetch([
			{ body: { id: "group-1" } },
			{ body: { success: true } },
		]);
		await createWhatsAppGroup(account, {
			subject: "Customers",
			description: "Updates",
			join_approval_mode: "approval_required",
		});
		await removeWhatsAppGroupParticipants(account, "group-1", [
			{ user: "bsuid-1" },
		]);

		expect(requests[0]?.url).toContain("/phone-number-id/groups");
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			messaging_product: "whatsapp",
			subject: "Customers",
			description: "Updates",
			join_approval_mode: "approval_required",
		});
		expect(requests[1]?.url).toContain("/group-1/participants");
		expect(requests[1]?.init?.method).toBe("DELETE");
		expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
			messaging_product: "whatsapp",
			participants: [{ user: "bsuid-1" }],
		});
	});

	it("sends group messages and pins through the phone-number messages edge", async () => {
		const requests = captureFetch([
			{ body: { messages: [{ id: "wamid.message" }] } },
			{ body: { messages: [{ id: "wamid.pin" }] } },
		]);
		await sendWhatsAppGroupMessage(account, "group-1", {
			type: "text",
			text: { body: "hello group" },
		});
		await pinWhatsAppGroupMessage(account, "group-1", {
			message_id: "wamid.message",
			action: "pin",
			expiration_days: 7,
		});

		for (const request of requests) {
			expect(request.url).toContain("/phone-number-id/messages");
		}
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			messaging_product: "whatsapp",
			recipient_type: "group",
			to: "group-1",
			type: "text",
			text: { body: "hello group" },
		});
		expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
			messaging_product: "whatsapp",
			recipient_type: "group",
			to: "group-1",
			type: "pin",
			pin: {
				type: "pin",
				message_id: "wamid.message",
				expiration_days: 7,
			},
		});
	});

	it("fails definitively on explicit logical rejection inside HTTP 2xx", async () => {
		captureFetch([{ body: { success: false } }]);
		await expect(
			updateWhatsAppGroup(account, "group-1", { subject: "Rejected" }),
		).rejects.toMatchObject({
			code: "WHATSAPP_GROUP_UPDATE_REJECTED",
			status: 400,
			definitive: true,
		});

		captureFetch([{ body: { success: false } }]);
		await expect(
			setWhatsAppBusinessUsername(account, { username: "rejected.name" }),
		).rejects.toMatchObject({
			code: "WHATSAPP_USERNAME_SET_REJECTED",
			status: 400,
			definitive: true,
		});

		captureFetch([
			{
				body: {
					id: "template-1",
					whatsapp_business_account: { id: "waba-id" },
				},
			},
			{ body: { success: false } },
		]);
		await expect(
			editWhatsAppTemplate(account, "template-1", { category: "UTILITY" }),
		).rejects.toMatchObject({
			code: "WHATSAPP_TEMPLATE_EDIT_REJECTED",
			status: 400,
			definitive: true,
		});
	});

	it("keeps unconfirmed HTTP 2xx mutations outcome-unknown", async () => {
		captureFetch([{ body: {} }]);
		await expect(
			updateWhatsAppGroup(account, "group-1", { description: "No ack" }),
		).rejects.toMatchObject({
			code: "WHATSAPP_PROVIDER_RESPONSE_INVALID",
			status: null,
			definitive: false,
		});

		captureFetch([{ body: { success: true } }]);
		await expect(
			resetWhatsAppGroupInviteLink(account, "group-1"),
		).rejects.toMatchObject({
			code: "WHATSAPP_PROVIDER_RESPONSE_INVALID",
			definitive: false,
		});

		captureFetch([{ body: { success: true } }]);
		await expect(
			pinWhatsAppGroupMessage(account, "group-1", {
				message_id: "wamid.message",
				action: "pin",
				expiration_days: 7,
			}),
		).rejects.toMatchObject({
			code: "WHATSAPP_PROVIDER_RESPONSE_INVALID",
			definitive: false,
		});
	});

	it("requires durable IDs for asynchronous and created provider resources", async () => {
		captureFetch([{ body: { success: true } }]);
		await expect(
			createWhatsAppGroup(account, {
				subject: "Missing operation ID",
				join_approval_mode: "approval_required",
			}),
		).rejects.toMatchObject({
			code: "WHATSAPP_PROVIDER_RESPONSE_INVALID",
			definitive: false,
		});

		captureFetch([{ body: { success: true } }]);
		await expect(
			sendWhatsAppGroupMessage(account, "group-1", {
				type: "text",
				text: { body: "No message ID" },
			}),
		).rejects.toMatchObject({
			code: "WHATSAPP_PROVIDER_RESPONSE_INVALID",
			definitive: false,
		});

		captureFetch([{ body: { success: true } }]);
		await expect(
			createWhatsAppTemplateFromLibrary(account, {
				name: "missing_template_id",
				language: "en_US",
				category: "UTILITY",
				library_template_name: "appointment_reminder_1",
			}),
		).rejects.toMatchObject({
			code: "WHATSAPP_PROVIDER_RESPONSE_INVALID",
			definitive: false,
		});
	});

	it("reports join-request partial outcomes without retaining participant IDs", async () => {
		captureFetch([
			{
				body: {
					approved_join_requests: ["join-ok"],
					failed_join_requests: [
						{ join_request_id: "join-private", errors: [{ code: 131203 }] },
					],
				},
			},
		]);
		const result = await resolveWhatsAppJoinRequests(
			account,
			"group-1",
			["join-ok", "join-private"],
			"approve",
		);

		expect(result.providerResult).toEqual({
			action: "approve",
			applied_count: 1,
			failed_count: 1,
			partial: true,
		});
		expect(JSON.stringify(result)).not.toContain("join-private");
	});

	it("uses block_users and strips echoed identities from durable results", async () => {
		const requests = captureFetch([
			{
				status: 400,
				body: {
					block_users: {
						added_users: [{ user: "15550001111" }],
						failed_users: [{ user: "bsuid-private", code: 131000 }],
					},
				},
			},
		]);
		const result = await mutateBlockedWhatsAppUsers(
			account,
			[{ user: "15550001111" }, { user: "bsuid-private" }],
			"block",
		);

		expect(requests[0]?.url).toContain("/phone-number-id/block_users");
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			messaging_product: "whatsapp",
			block_users: [{ user: "15550001111" }, { user: "bsuid-private" }],
		});
		expect(result.providerResult).toEqual({
			action: "block",
			applied_count: 1,
			failed_count: 1,
			partial: true,
		});
		expect(JSON.stringify(result)).not.toContain("bsuid-private");
	});

	it("keeps media references and pin inputs inside official message shapes", () => {
		expect(
			GroupMessageBody.safeParse({
				account_id: "acc_wa",
				type: "document",
				media: {
					id: "media-1",
					filename: "guide.pdf",
					caption: "Guide",
				},
			}).success,
		).toBe(true);
		expect(
			GroupMessageBody.safeParse({
				account_id: "acc_wa",
				type: "image",
				media: { id: "media-1", link: "https://example.test/image.jpg" },
			}).success,
		).toBe(false);
		expect(
			GroupMessageBody.safeParse({
				account_id: "acc_wa",
				type: "audio",
				media: {},
			}).success,
		).toBe(false);
		expect(
			GroupPinBody.safeParse({
				account_id: "acc_wa",
				message_id: "wamid.1",
				action: "pin",
			}).success,
		).toBe(false);
		expect(
			GroupPinBody.safeParse({
				account_id: "acc_wa",
				message_id: "wamid.1",
				action: "unpin",
				expiration_days: 7,
			}).success,
		).toBe(false);
	});

	it("uses official business-username and template-library fields", async () => {
		const requests = captureFetch([
			{ body: { success: true } },
			{ body: { data: [] } },
			{ body: { id: "template-1" } },
		]);
		await setWhatsAppBusinessUsername(account, { username: "relay.business" });
		await listWhatsAppTemplateLibrary(account, {
			name_or_content: "appointment",
			category: "UTILITY",
			limit: 25,
		});
		await createWhatsAppTemplateFromLibrary(account, {
			name: "appointment_reminder",
			language: "en_US",
			category: "UTILITY",
			library_template_name: "appointment_reminder_1",
			library_template_body_inputs: [{ type: "text", text: "Tomorrow" }],
		});

		expect(requests[0]?.url).toContain("/phone-number-id/username");
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			username: "relay.business",
		});
		const libraryUrl = new URL(requests[1]?.url ?? "https://invalid.test");
		expect(libraryUrl.pathname).toContain("/message_template_library");
		expect(libraryUrl.searchParams.get("name_or_content")).toBe("appointment");
		expect(libraryUrl.searchParams.get("category")).toBe("UTILITY");
		expect(libraryUrl.searchParams.get("limit")).toBe("25");
		expect(requests[2]?.url).toContain("/waba-id/message_templates");
		expect(JSON.parse(String(requests[2]?.init?.body))).toMatchObject({
			library_template_body_inputs: [{ type: "text", text: "Tomorrow" }],
		});
	});
});
