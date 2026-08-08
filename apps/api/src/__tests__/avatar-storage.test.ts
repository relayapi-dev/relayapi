import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import avatars from "../routes/avatars";
import {
	deleteStoredAvatar,
	hasStoredAvatar,
	rehostAvatar,
	rehostTransientAvatar,
} from "../services/avatar-store";
import type { Env } from "../types";

function fixture<T>(value: unknown): T {
	return value as T;
}

function envFixture(value: Partial<Env>): Env {
	return value as Env;
}

function imageObject(body: string, etag = '"avatar-etag"'): R2ObjectBody {
	const stream = new Response(body).body;
	if (!stream) throw new Error("expected response body");
	return fixture<R2ObjectBody>({
		body: stream,
		httpEtag: etag,
		httpMetadata: { contentType: "image/png" },
	});
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockImageFetch(body = "avatar-bytes"): void {
	globalThis.fetch = fixture<typeof fetch>(
		async () =>
			new Response(body, {
				status: 200,
				headers: { "Content-Type": "image/png; charset=binary" },
			}),
	);
}

describe("avatar storage lifecycle", () => {
	it("writes account avatars only to the durable avatar bucket", async () => {
		mockImageFetch();
		const durableWrites: Array<{ key: string; contentType?: string }> = [];
		const mediaWrites: string[] = [];
		const env = envFixture({
			API_BASE_URL: "https://api.test.dev/",
			AVATAR_BUCKET: fixture<R2Bucket>({
				put: async (
					key: string,
					_body: ArrayBuffer,
					options?: R2PutOptions,
				) => {
					const metadata = options?.httpMetadata;
					durableWrites.push({
						key,
						contentType:
							metadata instanceof Headers
								? (metadata.get("content-type") ?? undefined)
								: metadata?.contentType,
					});
					return fixture<R2Object>({ key });
				},
			}),
			MEDIA_BUCKET: fixture<R2Bucket>({
				put: async (key: string) => {
					mediaWrites.push(key);
					return fixture<R2Object>({ key });
				},
			}),
		});

		const url = await rehostAvatar(
			env,
			"acc_123",
			"https://provider.test/avatar",
		);

		expect(url).toBe("https://api.test.dev/avatars/acc_123");
		expect(durableWrites).toEqual([
			{ key: "account/acc_123/avatar", contentType: "image/png" },
		]);
		expect(mediaWrites).toEqual([]);
	});

	it("keeps inbox participant avatars in the expiring media bucket", async () => {
		mockImageFetch();
		const durableWrites: string[] = [];
		const mediaWrites: string[] = [];
		const env = envFixture({
			AVATAR_BUCKET: fixture<R2Bucket>({
				put: async (key: string) => {
					durableWrites.push(key);
					return fixture<R2Object>({ key });
				},
			}),
			MEDIA_BUCKET: fixture<R2Bucket>({
				put: async (key: string) => {
					mediaWrites.push(key);
					return fixture<R2Object>({ key });
				},
			}),
		});

		await rehostTransientAvatar(
			env,
			"org_123",
			"ws_123",
			"conv_123",
			"https://provider.test/participant",
		);

		expect(mediaWrites).toEqual([
			"org_123/workspaces/ws_123/conversations/conv_123/avatar",
		]);
		expect(durableWrites).toEqual([]);
	});

	it("checks and deletes the independently addressable durable object", async () => {
		const deleted: string[] = [];
		const env = envFixture({
			AVATAR_BUCKET: fixture<R2Bucket>({
				head: async () => fixture<R2Object>({ key: "account/acc_123/avatar" }),
				delete: async (key: string) => {
					deleted.push(`durable:${key}`);
				},
			}),
		});

		expect(await hasStoredAvatar(env, "acc_123")).toBe(true);
		await deleteStoredAvatar(env, "acc_123");
		expect(deleted).toEqual(["durable:account/acc_123/avatar"]);
	});
});

describe("public avatar routing", () => {
	it("serves account avatars from the durable bucket", async () => {
		const reads: string[] = [];
		const response = await avatars.request(
			"/acc_123",
			{},
			envFixture({
				AVATAR_BUCKET: fixture<R2Bucket>({
					get: async (key: string) => {
						reads.push(`durable:${key}`);
						return imageObject("durable");
					},
				}),
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("durable");
		expect(response.headers.get("etag")).toBe('"avatar-etag"');
		expect(response.headers.get("cache-control")).toBe("private, no-cache");
		expect(reads).toEqual(["durable:account/acc_123/avatar"]);
	});

	it("revalidates account avatars without a shared edge-cache store", async () => {
		const response = await avatars.request(
			"/acc_123",
			{ headers: { "If-None-Match": '"avatar-etag"' } },
			envFixture({
				AVATAR_BUCKET: fixture<R2Bucket>({
					get: async () => imageObject("durable"),
				}),
			}),
		);

		expect(response.status).toBe(304);
		expect(response.headers.get("etag")).toBe('"avatar-etag"');
		expect(response.headers.get("cache-control")).toBe("private, no-cache");
		expect(await response.text()).toBe("");
	});

	it("does not preserve a pre-live legacy-bucket fallback", async () => {
		const reads: string[] = [];
		const response = await avatars.request(
			"/acc_legacy",
			{},
			envFixture({
				AVATAR_BUCKET: fixture<R2Bucket>({
					get: async (key: string) => {
						reads.push(`durable:${key}`);
						return null;
					},
				}),
			}),
		);

		expect(response.status).toBe(404);
		expect(reads).toEqual(["durable:account/acc_legacy/avatar"]);
	});

	it("serves conversation avatars only from the media bucket", async () => {
		let durableReads = 0;
		const mediaReads: string[] = [];
		const response = await avatars.request(
			"/conversations/org_123/workspace-ws_123/conv_123",
			{},
			envFixture({
				AVATAR_BUCKET: fixture<R2Bucket>({
					get: async () => {
						durableReads += 1;
						return null;
					},
				}),
				MEDIA_BUCKET: fixture<R2Bucket>({
					get: async (key: string) => {
						mediaReads.push(key);
						return imageObject("conversation");
					},
				}),
			}),
		);

		expect(await response.text()).toBe("conversation");
		expect(response.headers.get("cache-control")).toBe("private, no-cache");
		expect(durableReads).toBe(0);
		expect(mediaReads).toEqual([
			"org_123/workspaces/ws_123/conversations/conv_123/avatar",
		]);
	});

	it("does not use the Workers Cache API for avatar responses", () => {
		const source = readFileSync(
			new URL("../routes/avatars.ts", import.meta.url),
			"utf8",
		);
		expect(source).not.toContain("caches.default");
		expect(source).not.toContain(".put(c.req.raw");
	});
});

describe("avatar repair and cleanup wiring", () => {
	it("repairs from R2 state before fetching external posts", () => {
		const source = readFileSync(
			new URL("../services/external-post-sync/sync.ts", import.meta.url),
			"utf8",
		);
		const objectCheck = source.indexOf("hasStoredAvatar(env, account.id)");
		const postFetch = source.indexOf("fetcher.fetchPosts(");

		expect(objectCheck).toBeGreaterThan(-1);
		expect(postFetch).toBeGreaterThan(objectCheck);
		expect(source).not.toContain('avatarUrl?.includes("/avatars/")');
	});

	it("wires durable deletion into every account lifecycle cleanup", () => {
		const revocation = readFileSync(
			new URL("../services/account-revocation.ts", import.meta.url),
			"utf8",
		);
		const workspace = readFileSync(
			new URL("../services/workspace-erasure.ts", import.meta.url),
			"utf8",
		);
		const tenant = readFileSync(
			new URL("../services/tenant-deletion.ts", import.meta.url),
			"utf8",
		);

		expect(revocation).toContain("deleteStoredAvatar(env, job.accountId)");
		expect(workspace).toContain("env.AVATAR_BUCKET.delete(");
		expect(workspace).toContain('phase === "workspace_media"');
		expect(tenant).toContain("env.AVATAR_BUCKET.delete(avatarKeys)");
		expect(tenant).toContain(
			[
				"`organization/",
				"$",
				"{encodeURIComponent(job.organizationId)}",
				"/`",
			].join(""),
		);
	});
});
