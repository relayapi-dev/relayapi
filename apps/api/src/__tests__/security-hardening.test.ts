import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import {
	readOnlyMiddleware,
	requireAllWorkspaceScopeMiddleware,
} from "../middleware/permissions";
import { isAllowedCustomerRedirectUrl } from "../lib/customer-redirect";
import { isBlockedUrlWithDns } from "../lib/ssrf-guard";
import { CreatePostBody } from "../schemas/posts";
import { ShortenUrlBody } from "../schemas/short-links";
import { TestFeedBody } from "../schemas/auto-post-rules";
import { CreateThreadBody } from "../schemas/threads";
import { ValidateMediaBody } from "../schemas/tools";
import { UploadProfilePhotoBody } from "../schemas/whatsapp";
import type { Env, Variables, KVKeyData } from "../types";
import { createMockEnv, hashKey, seedApiKeyInKV } from "./__mocks__/env";

const mockCtx = {
	waitUntil: () => {},
	passThroughOnException: () => {},
} as unknown as ExecutionContext;
const originalFetch = globalThis.fetch;

function makeApiKeyRequest(key: string) {
	return new Request("http://localhost/v1/api-keys", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ name: "test" }),
	});
}

describe("API key admin hardening", () => {
	let env: Env;
	let app: Hono<{ Bindings: Env; Variables: Variables }>;

	beforeEach(() => {
		const mock = createMockEnv();
		env = mock.env;

		app = new Hono<{ Bindings: Env; Variables: Variables }>();
		app.use("*", authMiddleware);
		app.use("*", readOnlyMiddleware);
		app.use("*", requireAllWorkspaceScopeMiddleware);
		app.post("/v1/api-keys", (c) => c.json({ ok: true }, 200));
	});

	async function seedKey(token: string, data: KVKeyData) {
		const hashed = await hashKey(token);
		await seedApiKeyInKV((env.KV as unknown) as ReturnType<typeof createMockEnv>["kv"], hashed, data);
	}

	it("blocks read-only keys from mutating /v1/api-keys", async () => {
		const token = "rlay_live_securityhardening_readonly000000000000000000000";
		await seedKey(token, {
			org_id: "org_test",
			key_id: "key_read_only",
			permissions: [],
			workspace_scope: "all",
			expires_at: null,
			plan: "pro",
			calls_included: 10_000,
		});

		const res = await app.fetch(makeApiKeyRequest(token), env, mockCtx);
		const body = (await res.json()) as { error: { code: string } };

		expect(res.status).toBe(403);
		expect(body.error.code).toBe("READ_ONLY");
	});

	it("blocks workspace-scoped write keys from mutating /v1/api-keys", async () => {
		const token = "rlay_live_securityhardening_scoped0000000000000000000000";
		await seedKey(token, {
			org_id: "org_test",
			key_id: "key_scoped",
			permissions: ["write"],
			workspace_scope: ["ws_123"],
			expires_at: null,
			plan: "pro",
			calls_included: 10_000,
		});

		const res = await app.fetch(makeApiKeyRequest(token), env, mockCtx);
		const body = (await res.json()) as { error: { code: string } };

		expect(res.status).toBe(403);
		expect(body.error.code).toBe("ORG_LEVEL_ACCESS_REQUIRED");
	});

	it("allows org-wide write keys to mutate /v1/api-keys", async () => {
		const token = "rlay_live_securityhardening_orgwide000000000000000000000";
		await seedKey(token, {
			org_id: "org_test",
			key_id: "key_org_admin",
			permissions: ["write"],
			workspace_scope: "all",
			expires_at: null,
			plan: "pro",
			calls_included: 10_000,
		});

			const res = await app.fetch(makeApiKeyRequest(token), env, mockCtx);

			expect(res.status).toBe(200);
			expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
	});
});

describe("URL validation hardening", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("rejects javascript: short-link targets", () => {
		expect(
			ShortenUrlBody.safeParse({ url: "javascript:alert(1)" }).success,
		).toBe(false);
	});

	it("rejects data: short-link targets", () => {
		expect(
			ShortenUrlBody.safeParse({ url: "data:text/html,<script>alert(1)</script>" }).success,
		).toBe(false);
	});

	it("accepts https short-link targets", () => {
		expect(
			ShortenUrlBody.safeParse({ url: "https://example.com/path" }).success,
		).toBe(true);
	});

	it("rejects OAuth customer redirects to external domains", () => {
		expect(isAllowedCustomerRedirectUrl("https://evil.example/callback")).toBe(false);
	});

	it("allows OAuth customer redirects on relayapi.dev", () => {
		expect(
			isAllowedCustomerRedirectUrl("https://app.relayapi.dev/connect/callback"),
		).toBe(true);
	});

	it("rejects non-http post media URLs", () => {
		expect(
			CreatePostBody.safeParse({
				content: "hello",
				targets: ["twitter"],
				scheduled_at: "now",
				media: [{ url: "javascript:alert(1)", type: "image" }],
			}).success,
		).toBe(false);
	});

	it("rejects non-http thread media URLs", () => {
		expect(
			CreateThreadBody.safeParse({
				items: [
					{ content: "one", media: [{ url: "data:text/html,hi", type: "image" }] },
					{ content: "two" },
				],
				targets: ["twitter"],
				scheduled_at: "draft",
			}).success,
		).toBe(false);
	});

	it("rejects non-http media validation URLs", () => {
		expect(
			ValidateMediaBody.safeParse({ url: "javascript:alert(1)" }).success,
		).toBe(false);
	});

	it("rejects non-http feed URLs", () => {
		expect(
			TestFeedBody.safeParse({ feed_url: "javascript:alert(1)" }).success,
		).toBe(false);
	});

	it("requires https for WhatsApp profile photo URLs", () => {
		expect(
			UploadProfilePhotoBody.safeParse({
				account_id: "acc_123",
				photo_url: "http://example.com/photo.jpg",
			}).success,
		).toBe(false);
		expect(
			UploadProfilePhotoBody.safeParse({
				account_id: "acc_123",
				photo_url: "https://example.com/photo.jpg",
			}).success,
		).toBe(true);
	});

		it("rejects hostnames whose DNS resolves to private IPs", async () => {
			globalThis.fetch = mock(async () =>
				Response.json({ Answer: [{ type: 1, data: "127.0.0.1" }] }),
			) as unknown as typeof fetch;

		expect(await isBlockedUrlWithDns("https://ssrf-private.example")).toBe(true);
	});

		it("allows hostnames whose DNS resolves only to public IPs", async () => {
			globalThis.fetch = mock(async () =>
				Response.json({ Answer: [{ type: 1, data: "93.184.216.34" }] }),
			) as unknown as typeof fetch;

		expect(await isBlockedUrlWithDns("https://ssrf-public.example")).toBe(false);
	});
});
