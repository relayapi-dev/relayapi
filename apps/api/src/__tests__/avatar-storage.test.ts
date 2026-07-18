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
			{ key: "avatars/acc_123", contentType: "image/png" },
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
			"conv_123",
			"https://provider.test/participant",
		);

		expect(mediaWrites).toEqual(["avatars/conv_123"]);
		expect(durableWrites).toEqual([]);
	});

	it("checks the durable object and deletes durable plus legacy copies", async () => {
		const deleted: string[] = [];
		const env = envFixture({
			AVATAR_BUCKET: fixture<R2Bucket>({
				head: async () => fixture<R2Object>({ key: "avatars/acc_123" }),
				delete: async (key: string) => {
					deleted.push(`durable:${key}`);
				},
			}),
			MEDIA_BUCKET: fixture<R2Bucket>({
				delete: async (key: string) => {
					deleted.push(`legacy:${key}`);
				},
			}),
		});

		expect(await hasStoredAvatar(env, "acc_123")).toBe(true);
		await deleteStoredAvatar(env, "acc_123");
		expect(deleted.sort()).toEqual([
			"durable:avatars/acc_123",
			"legacy:avatars/acc_123",
		]);
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
				MEDIA_BUCKET: fixture<R2Bucket>({
					get: async (key: string) => {
						reads.push(`legacy:${key}`);
						return null;
					},
				}),
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("durable");
		expect(response.headers.get("etag")).toBe('"avatar-etag"');
		expect(reads).toEqual(["durable:avatars/acc_123"]);
	});

	it("falls back to legacy account objects during migration", async () => {
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
				MEDIA_BUCKET: fixture<R2Bucket>({
					get: async (key: string) => {
						reads.push(`legacy:${key}`);
						return imageObject("legacy");
					},
				}),
			}),
		);

		expect(await response.text()).toBe("legacy");
		expect(reads).toEqual([
			"durable:avatars/acc_legacy",
			"legacy:avatars/acc_legacy",
		]);
	});

	it("serves conversation avatars only from the media bucket", async () => {
		let durableReads = 0;
		const response = await avatars.request(
			"/conv_123",
			{},
			envFixture({
				AVATAR_BUCKET: fixture<R2Bucket>({
					get: async () => {
						durableReads += 1;
						return null;
					},
				}),
				MEDIA_BUCKET: fixture<R2Bucket>({
					get: async () => imageObject("conversation"),
				}),
			}),
		);

		expect(await response.text()).toBe("conversation");
		expect(durableReads).toBe(0);
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
		expect(tenant).toContain("env.AVATAR_BUCKET.delete(avatarKeys)");
	});
});
