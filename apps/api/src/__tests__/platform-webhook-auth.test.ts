import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Env } from "../types";
import { createMockDb } from "./__mocks__/db";

const acceptInboundWebhook = mock(async () => ({ id: "inw_test" }));
let mockDb = createMockDb();

const column = (name: string) => ({ name });
const socialAccounts = {
	id: column("id"),
	organizationId: column("organizationId"),
	platform: column("platform"),
	platformAccountId: column("platformAccountId"),
	webhookAccountId: column("webhookAccountId"),
	accessToken: column("accessToken"),
	lifecycleStatus: column("lifecycleStatus"),
	toString: () => "social_accounts",
};
const inboxConversations = {
	id: column("id"),
	organizationId: column("organizationId"),
	socialAccountId: column("socialAccountId"),
	platformConversationId: column("platformConversationId"),
	toString: () => "inbox_conversations",
};
const inboxMessages = {
	conversationId: column("conversationId"),
	platformMessageId: column("platformMessageId"),
	direction: column("direction"),
	text: column("text"),
	createdAt: column("createdAt"),
	toString: () => "inbox_messages",
};

type Condition = { _filter: (row: Record<string, unknown>) => boolean };

mock.module("@relayapi/db", () => ({
	createDb: () => mockDb,
	inboxConversations,
	inboxMessages,
	socialAccounts,
}));

mock.module("drizzle-orm", () => ({
	eq: (col: { name: string }, value: unknown): Condition => ({
		_filter: (row) => row[col.name] === value,
	}),
	gt: (col: { name: string }, value: unknown): Condition => ({
		_filter: (row) => String(row[col.name]) > String(value),
	}),
	inArray: (col: { name: string }, values: unknown[]): Condition => ({
		_filter: (row) => values.includes(row[col.name]),
	}),
	and: (...conditions: Condition[]): Condition => ({
		_filter: (row) => conditions.every((condition) => condition._filter(row)),
	}),
	asc: (col: { name: string }) => col,
	sql: () => 1,
}));

mock.module("../lib/account-token-crypto", () => ({
	decryptAccountToken: async (stored: string | null | undefined) =>
		stored ?? null,
}));

mock.module("../services/telegram-connection", () => ({
	processTelegramConnectionChallenge: async () => undefined,
}));

mock.module("../services/inbound-webhook-acceptance", () => ({
	acceptInboundWebhook,
}));

const {
	MAX_PLATFORM_WEBHOOK_BYTES,
	default: platformWebhooks,
	processRawPlatformWebhook,
	processSmsWebhook,
} = await import("../routes/platform-webhooks");

function env(overrides: Partial<Env> = {}): Env {
	return {
		ENCRYPTION_KEY: "test-encryption-key",
		HYPERDRIVE: { connectionString: "postgresql://test.invalid/test" },
		INBOX_QUEUE: { send: mock(async () => undefined) },
		...overrides,
	} as unknown as Env;
}

async function hmacHex(
	secret: string,
	body: string | Uint8Array<ArrayBuffer>,
	hash: "SHA-1" | "SHA-256",
): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		typeof body === "string" ? encoder.encode(body) : body,
	);
	return Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function bodyWithInvalidUtf8(
	prefix: string,
	suffix: string,
): Uint8Array<ArrayBuffer> {
	const encoder = new TextEncoder();
	const prefixBytes = encoder.encode(prefix);
	const suffixBytes = encoder.encode(suffix);
	const body = new Uint8Array(
		new ArrayBuffer(prefixBytes.byteLength + 1 + suffixBytes.byteLength),
	);
	body.set(prefixBytes);
	body[prefixBytes.byteLength] = 0x80;
	body.set(suffixBytes, prefixBytes.byteLength + 1);
	return body;
}

async function twilioSignature(
	authToken: string,
	url: string,
	params: Record<string, string>,
): Promise<string> {
	let data = url;
	for (const key of Object.keys(params).sort()) data += key + params[key];
	const hex = await hmacHex(authToken, data, "SHA-1");
	const bytes = Uint8Array.from(
		hex.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? [],
	);
	return btoa(String.fromCharCode(...bytes));
}

describe("platform webhook authentication", () => {
	beforeEach(() => {
		acceptInboundWebhook.mockClear();
		mockDb = createMockDb();
	});

	it("rejects matching attacker-controlled Telegram path and header secrets", async () => {
		const response = await platformWebhooks.request(
			"https://api.example.test/telegram/attacker-secret",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-telegram-bot-api-secret-token": "attacker-secret",
				},
				body: JSON.stringify({ update_id: 1 }),
			},
			env({ TELEGRAM_WEBHOOK_SECRET: "server-secret" }),
		);

		expect(response.status).toBe(403);
		expect(acceptInboundWebhook).not.toHaveBeenCalled();
	});

	it("rejects a valid Telegram header sent to a foreign secret path", async () => {
		const response = await platformWebhooks.request(
			"https://api.example.test/telegram/foreign-path",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-telegram-bot-api-secret-token": "server-secret",
				},
				body: JSON.stringify({ update_id: 2 }),
			},
			env({ TELEGRAM_WEBHOOK_SECRET: "server-secret" }),
		);

		expect(response.status).toBe(403);
		expect(acceptInboundWebhook).not.toHaveBeenCalled();
	});

	it("disables Telegram ingestion when the server-held secret is absent", async () => {
		const response = await platformWebhooks.request(
			"https://api.example.test/telegram/attacker-secret",
			{
				method: "POST",
				headers: { "x-telegram-bot-api-secret-token": "attacker-secret" },
				body: JSON.stringify({ update_id: 3 }),
			},
			env(),
		);

		expect(response.status).toBe(503);
		expect(acceptInboundWebhook).not.toHaveBeenCalled();
	});

	it("accepts Telegram only when both secrets match server-held material", async () => {
		const body = JSON.stringify({ update_id: 4 });
		const response = await platformWebhooks.request(
			"https://api.example.test/telegram/server-secret",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-telegram-bot-api-secret-token": "server-secret",
				},
				body,
			},
			env({ TELEGRAM_WEBHOOK_SECRET: "server-secret" }),
		);

		expect(response.status).toBe(200);
		expect(acceptInboundWebhook).toHaveBeenCalledTimes(1);
	});

	it("rejects oversized Facebook, Instagram, WhatsApp, Telegram, and YouTube envelopes consistently", async () => {
		const cases = [
			{
				name: "Facebook",
				url: "https://api.example.test/facebook",
				headers: { "x-hub-signature-256": "sha256=00" },
				environment: env({ FACEBOOK_APP_SECRET: "meta-secret" }),
			},
			{
				name: "Instagram",
				url: "https://api.example.test/facebook",
				headers: { "x-hub-signature-256": "sha256=00" },
				environment: env({ INSTAGRAM_LOGIN_APP_SECRET: "instagram-secret" }),
			},
			{
				name: "WhatsApp",
				url: "https://api.example.test/whatsapp",
				headers: { "x-hub-signature-256": "sha256=00" },
				environment: env({ FACEBOOK_APP_SECRET: "meta-secret" }),
			},
			{
				name: "Telegram",
				url: "https://api.example.test/telegram/server-secret",
				headers: {
					"x-telegram-bot-api-secret-token": "server-secret",
				},
				environment: env({ TELEGRAM_WEBHOOK_SECRET: "server-secret" }),
			},
			{
				name: "YouTube",
				url: "https://api.example.test/youtube",
				headers: { "x-hub-signature": "sha1=00" },
				environment: env({ YOUTUBE_HUB_SECRET: "youtube-secret" }),
			},
		] as const;

		for (const testCase of cases) {
			const response = await platformWebhooks.request(
				testCase.url,
				{
					method: "POST",
					headers: {
						...testCase.headers,
						"content-length": String(MAX_PLATFORM_WEBHOOK_BYTES + 1),
					},
					body: "{}",
				},
				testCase.environment,
			);

			expect(response.status, testCase.name).toBe(413);
			expect(await response.json<{ error: string }>(), testCase.name).toEqual({
				error: "Payload too large",
			});
		}
		expect(acceptInboundWebhook).not.toHaveBeenCalled();
	});

	it("enforces the streamed limit when Content-Length understates the body", async () => {
		const response = await platformWebhooks.request(
			"https://api.example.test/whatsapp",
			{
				method: "POST",
				headers: {
					"content-length": "1",
					"x-hub-signature-256": "sha256=00",
				},
				body: new Uint8Array(new ArrayBuffer(MAX_PLATFORM_WEBHOOK_BYTES + 1)),
			},
			env({ FACEBOOK_APP_SECRET: "meta-secret" }),
		);

		expect(response.status).toBe(413);
		expect(await response.json<{ error: string }>()).toEqual({
			error: "Payload too large",
		});
		expect(acceptInboundWebhook).not.toHaveBeenCalled();
	});

	it("verifies Facebook and Instagram signatures against the exact request bytes", async () => {
		const cases = [
			{
				object: "page",
				secret: "facebook-app-secret",
				environment: env({ FACEBOOK_APP_SECRET: "facebook-app-secret" }),
			},
			{
				object: "instagram",
				secret: "instagram-login-secret",
				environment: env({
					INSTAGRAM_LOGIN_APP_SECRET: "instagram-login-secret",
				}),
			},
		] as const;

		for (const testCase of cases) {
			const body = bodyWithInvalidUtf8(
				`{"object":"${testCase.object}","entry":[],"marker":"`,
				'"}',
			);
			const signature = await hmacHex(testCase.secret, body, "SHA-256");
			const response = await platformWebhooks.request(
				"https://api.example.test/facebook",
				{
					method: "POST",
					headers: { "x-hub-signature-256": `sha256=${signature}` },
					body,
				},
				testCase.environment,
			);

			expect(response.status, testCase.object).toBe(200);
		}
		expect(acceptInboundWebhook).toHaveBeenCalledTimes(2);
	});

	it("fails YouTube closed when YOUTUBE_HUB_SECRET is absent", async () => {
		const response = await platformWebhooks.request(
			"https://api.example.test/youtube",
			{
				method: "POST",
				headers: { "x-hub-signature": "sha1=00" },
				body: "<feed />",
			},
			env(),
		);

		expect(response.status).toBe(503);
		expect(acceptInboundWebhook).not.toHaveBeenCalled();
	});

	it("requires and validates a YouTube WebSub signature", async () => {
		const body = "<feed><entry /></feed>";
		const secret = "youtube-hub-secret";
		const signature = await hmacHex(secret, body, "SHA-1");
		const response = await platformWebhooks.request(
			"https://api.example.test/youtube",
			{
				method: "POST",
				headers: { "x-hub-signature": `sha1=${signature}` },
				body,
			},
			env({ YOUTUBE_HUB_SECRET: secret }),
		);

		expect(response.status).toBe(200);
		expect(acceptInboundWebhook).toHaveBeenCalledTimes(1);
	});

	it("verifies YouTube WebSub signatures against the exact request bytes", async () => {
		const body = bodyWithInvalidUtf8("<feed><title>", "</title></feed>");
		const secret = "youtube-hub-secret";
		const signature = await hmacHex(secret, body, "SHA-1");
		const response = await platformWebhooks.request(
			"https://api.example.test/youtube",
			{
				method: "POST",
				headers: { "x-hub-signature": `sha1=${signature}` },
				body,
			},
			env({ YOUTUBE_HUB_SECRET: secret }),
		);

		expect(response.status).toBe(200);
		expect(acceptInboundWebhook).toHaveBeenCalledTimes(1);
	});

	it("rejects Twilio when the signed AccountSid has no active BYOC account", async () => {
		const accountSid = `AC${"1".repeat(32)}`;
		const response = await platformWebhooks.request(
			"https://api.example.test/sms",
			{
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"x-twilio-signature": "attacker-signature",
				},
				body: new URLSearchParams({
					AccountSid: accountSid,
					To: "+15551234567",
					From: "+15557654321",
					Body: "forged",
				}).toString(),
			},
			env(),
		);

		expect(response.status).toBe(403);
		expect(acceptInboundWebhook).not.toHaveBeenCalled();
	});

	it("accepts Twilio only with the matching account's encrypted BYOC token", async () => {
		const authToken = "twilio-auth-token";
		const accountSid = `AC${"2".repeat(32)}`;
		mockDb._seed("socialAccounts", [
			{
				id: "acc_sms_1",
				organizationId: "org_1",
				platform: "sms",
				platformAccountId: accountSid,
				accessToken: authToken,
				lifecycleStatus: "active",
			},
		]);
		const params = {
			AccountSid: accountSid,
			Body: "hello",
			From: "+15557654321",
			MessageSid: "SM123",
			To: "+15551234567",
		};
		const url = "https://api.example.test/sms";
		const signature = await twilioSignature(authToken, url, params);
		const response = await platformWebhooks.request(
			url,
			{
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"x-twilio-signature": signature,
				},
				body: new URLSearchParams(params).toString(),
			},
			env(),
		);

		expect(response.status).toBe(200);
		expect(acceptInboundWebhook).toHaveBeenCalledTimes(1);
		expect(acceptInboundWebhook).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				deliveryId: "SM123",
				signatureMetadata: {
					twilio_account_sid: accountSid,
					verified_account_ids: ["acc_sms_1"],
				},
			}),
		);
	});

	it("rejects an invalid Twilio signature for a known BYOC AccountSid", async () => {
		const accountSid = `AC${"5".repeat(32)}`;
		mockDb._seed("socialAccounts", [
			{
				id: "acc_sms_known",
				organizationId: "org_known",
				platform: "sms",
				platformAccountId: accountSid,
				accessToken: "server-held-token",
				lifecycleStatus: "active",
			},
		]);
		const params = {
			AccountSid: accountSid,
			Body: "forged",
			From: "+15557654321",
			MessageSid: "SMFORGED",
			To: "+15551234567",
		};
		const url = "https://api.example.test/sms";
		const signature = await twilioSignature("attacker-token", url, params);
		const response = await platformWebhooks.request(
			url,
			{
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"x-twilio-signature": signature,
				},
				body: new URLSearchParams(params).toString(),
			},
			env(),
		);

		expect(response.status).toBe(403);
		expect(acceptInboundWebhook).not.toHaveBeenCalled();
	});

	it("persists only the BYOC accounts whose own token verifies", async () => {
		const accountSid = `AC${"3".repeat(32)}`;
		mockDb._seed("socialAccounts", [
			{
				id: "acc_sms_wrong",
				organizationId: "org_wrong",
				platform: "sms",
				platformAccountId: accountSid,
				accessToken: "wrong-token",
				lifecycleStatus: "active",
			},
			{
				id: "acc_sms_verified",
				organizationId: "org_verified",
				platform: "sms",
				platformAccountId: accountSid,
				accessToken: "verified-token",
				lifecycleStatus: "active",
			},
		]);
		const params = {
			AccountSid: accountSid,
			Body: "tenant-safe",
			From: "+15557654321",
			MessageSid: "SM456",
			To: "+15551234567",
		};
		const url = "https://api.example.test/sms?route=primary";
		const signature = await twilioSignature("verified-token", url, params);
		const response = await platformWebhooks.request(
			url,
			{
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded; charset=utf-8",
					"x-twilio-signature": signature,
				},
				body: new URLSearchParams(params).toString(),
			},
			env(),
		);

		expect(response.status).toBe(200);
		expect(acceptInboundWebhook).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				signatureMetadata: expect.objectContaining({
					verified_account_ids: ["acc_sms_verified"],
				}),
			}),
		);
	});

	it("accepts every Relay account whose own token verifies", async () => {
		const accountSid = `AC${"6".repeat(32)}`;
		const sharedToken = "shared-byoc-token";
		mockDb._seed("socialAccounts", [
			{
				id: "acc_sms_ambiguous_a",
				organizationId: "org_ambiguous_a",
				platform: "sms",
				platformAccountId: accountSid,
				accessToken: sharedToken,
				lifecycleStatus: "active",
			},
			{
				id: "acc_sms_ambiguous_b",
				organizationId: "org_ambiguous_b",
				platform: "sms",
				platformAccountId: accountSid,
				accessToken: sharedToken,
				lifecycleStatus: "active",
			},
		]);
		const params = {
			AccountSid: accountSid,
			Body: "fan-out",
			From: "+15557654321",
			MessageSid: "SMAMBIGUOUS",
			To: "+15551234567",
		};
		const url = "https://api.example.test/sms";
		const signature = await twilioSignature(sharedToken, url, params);
		const response = await platformWebhooks.request(
			url,
			{
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"x-twilio-signature": signature,
				},
				body: new URLSearchParams(params).toString(),
			},
			env(),
		);

		expect(response.status).toBe(200);
		expect(acceptInboundWebhook).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				signatureMetadata: expect.objectContaining({
					verified_account_ids: ["acc_sms_ambiguous_a", "acc_sms_ambiguous_b"],
				}),
			}),
		);
	});

	it("pages through more than 100 valid accounts for one Twilio AccountSid", async () => {
		const accountSid = `AC${"8".repeat(32)}`;
		const sharedToken = "shared-paged-token";
		const accountIds = Array.from(
			{ length: 101 },
			(_, index) => `acc_sms_${String(index).padStart(3, "0")}`,
		);
		mockDb._seed(
			"socialAccounts",
			accountIds.map((id, index) => ({
				id,
				organizationId: `org_${index}`,
				platform: "sms",
				platformAccountId: accountSid,
				accessToken: sharedToken,
				lifecycleStatus: "active",
			})),
		);
		const params = {
			AccountSid: accountSid,
			Body: "paged fan-out",
			From: "+15557654321",
			MessageSid: "SMPAGED",
			To: "+15551234567",
		};
		const url = "https://api.example.test/sms";
		const signature = await twilioSignature(sharedToken, url, params);
		const response = await platformWebhooks.request(
			url,
			{
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"x-twilio-signature": signature,
				},
				body: new URLSearchParams(params).toString(),
			},
			env(),
		);

		expect(response.status).toBe(200);
		expect(acceptInboundWebhook).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				signatureMetadata: expect.objectContaining({
					verified_account_ids: accountIds,
				}),
			}),
		);
	});

	it("queue-side SMS receipts fan out to every verified account id", async () => {
		const accountSid = `AC${"7".repeat(32)}`;
		mockDb._seed("socialAccounts", [
			{
				id: "acc_sms_a",
				organizationId: "org_a",
				platform: "sms",
				platformAccountId: accountSid,
				lifecycleStatus: "active",
			},
			{
				id: "acc_sms_b",
				organizationId: "org_b",
				platform: "sms",
				platformAccountId: accountSid,
				lifecycleStatus: "active",
			},
			{
				id: "acc_sms_unverified",
				organizationId: "org_unverified",
				platform: "sms",
				platformAccountId: accountSid,
				lifecycleStatus: "active",
			},
		]);
		const send = mock(async () => undefined);

		await processRawPlatformWebhook(
			"sms",
			JSON.stringify({
				AccountSid: accountSid,
				From: "+15557654321",
				To: "+15551234567",
			}),
			env({ INBOX_QUEUE: { send } as never }),
			{
				verified_account_ids: ["acc_sms_a", "acc_sms_b"],
			},
		);

		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				account_id: "acc_sms_a",
				organization_id: "org_a",
			}),
		);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				account_id: "acc_sms_b",
				organization_id: "org_b",
			}),
		);
	});

	it("queue-side SMS routing cannot fan out beyond authenticated account ids", async () => {
		const accountSid = `AC${"4".repeat(32)}`;
		mockDb._seed("socialAccounts", [
			{
				id: "acc_sms_other",
				organizationId: "org_other",
				platform: "sms",
				platformAccountId: accountSid,
				accessToken: "shared-token",
				lifecycleStatus: "active",
			},
			{
				id: "acc_sms_target",
				organizationId: "org_target",
				platform: "sms",
				platformAccountId: accountSid,
				accessToken: "shared-token",
				lifecycleStatus: "active",
			},
		]);
		const send = mock(async () => undefined);

		await processSmsWebhook(
			{
				AccountSid: accountSid,
				From: "+15557654321",
				MessageSid: "SM789",
				To: "+15551234567",
			},
			env({ INBOX_QUEUE: { send } as never }),
			["acc_sms_target"],
		);

		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				account_id: "acc_sms_target",
				organization_id: "org_target",
				platform_account_id: accountSid,
			}),
		);
	});
});
