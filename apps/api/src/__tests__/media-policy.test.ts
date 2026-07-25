import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { Database } from "@relayapi/db";
import {
	MAX_MEDIA_UPLOAD_BYTES,
	validateStoredMediaObject,
} from "../lib/media-storage-policy";
import {
	getCachedR2Client,
	presignR2Url,
	presignRelayMediaUrls,
	resolveRelayMediaForPublish,
} from "../lib/r2-presign";
import {
	collectRelayMediaReferences,
	loadRelayMediaPolicy,
	RelayMediaPolicyError,
} from "../lib/relay-media-policy";
import type { Env } from "../types";

function fixture<T>(value: unknown): T {
	return value as T;
}

type ReadyRow = {
	id: string;
	storageKey: string;
	mimeType: string;
	size: number;
};

function policyDb(rows: ReadyRow[]): Database {
	const query = {
		from: () => query,
		where: async () => rows,
	};
	return fixture<Database>({ select: () => query });
}

function signingEnv(
	stored: { contentType: string; size: number } = {
		contentType: "image/png",
		size: 1024,
	},
): Env {
	return fixture<Env>({
		CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
		R2_ACCESS_KEY_ID: "test-access-key",
		R2_SECRET_ACCESS_KEY: "test-secret-key",
		MEDIA_BUCKET: fixture<R2Bucket>({
			head: async () =>
				fixture<R2Object>({
					size: stored.size,
					httpMetadata: { contentType: stored.contentType },
				}),
		}),
	});
}

describe("stored media policy", () => {
	it("accepts only allowlisted persisted metadata within 50 MiB", () => {
		expect(
			validateStoredMediaObject(
				fixture<R2Object>({
					size: MAX_MEDIA_UPLOAD_BYTES,
					httpMetadata: { contentType: "Image/PNG; charset=binary" },
				}),
			),
		).toEqual({
			ok: true,
			mimeType: "image/png",
			size: MAX_MEDIA_UPLOAD_BYTES,
		});
	});

	it("rejects missing/disallowed MIME and oversized persisted objects", () => {
		expect(
			validateStoredMediaObject(fixture<R2Object>({ size: 1 })),
		).toMatchObject({ ok: false, code: "INVALID_FILE_TYPE" });
		expect(
			validateStoredMediaObject(
				fixture<R2Object>({
					size: 1,
					httpMetadata: { contentType: "text/html" },
				}),
			),
		).toMatchObject({ ok: false, code: "INVALID_FILE_TYPE" });
		expect(
			validateStoredMediaObject(
				fixture<R2Object>({
					size: MAX_MEDIA_UPLOAD_BYTES + 1,
					httpMetadata: { contentType: "video/mp4" },
				}),
			),
		).toMatchObject({ ok: false, code: "FILE_TOO_LARGE" });
	});

	it("signs create-only PUTs with both required upload headers", async () => {
		const env = signingEnv();
		const client = getCachedR2Client(env);
		if (!client) throw new Error("expected an R2 signing client");
		const url = await presignR2Url(
			env,
			client,
			"org_1/media/file_1/photo.png",
			"PUT",
			3600,
			"image/png",
		);
		const signedHeaders =
			new URL(url).searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];
		expect(signedHeaders).toContain("content-type");
		expect(signedHeaders).toContain("if-none-match");
	});
});

describe("Relay media ownership and signing policy", () => {
	const readyUrl = "https://media.relayapi.dev/org_1/media/file_1/photo.png";
	const pendingUrl =
		"https://media.relayapi.dev/org_1/media/file_pending/photo.png";

	it("scans nested provider options but leaves external origins outside the policy", () => {
		const references = collectRelayMediaReferences({
			media: [{ url: "https://cdn.example.test/photo.png" }],
			target_options: {
				instagram: { media: [{ url: readyUrl }] },
			},
		});
		expect(references).toEqual([
			{
				url: readyUrl,
				storageKey: "org_1/media/file_1/photo.png",
			},
		]);
	});

	it("requires canonical HTTPS shape and a ready policy row", async () => {
		const db = policyDb([
			{
				id: "med_1",
				storageKey: "org_1/media/file_1/photo.png",
				mimeType: "image/png",
				size: 1024,
			},
		]);
		const value = {
			ready: readyUrl,
			pending: pendingUrl,
			external: "https://cdn.example.test/photo.png",
		};
		const policy = await loadRelayMediaPolicy(db, "org_1", value);
		expect(policy.isReadyUrl(readyUrl)).toBe(true);
		expect(policy.isReadyUrl(pendingUrl)).toBe(false);
		expect(policy.violationFor({ url: pendingUrl })).toMatchObject({
			reason: "not_ready_or_not_owned",
		});
		expect(
			policy.violationFor({
				url: "http://media.relayapi.dev/org_1/media/file_1/photo.png",
			}),
		).toMatchObject({ reason: "invalid_relay_url" });
		expect(
			policy.violationFor({ url: "https://cdn.example.test/photo.png" }),
		).toBeNull();
	});

	it("does not sign a pending or unowned historical row", async () => {
		const [result] =
			(await presignRelayMediaUrls(
				policyDb([]),
				signingEnv(),
				[{ url: pendingUrl }],
				3600,
				"org_1",
			)) ?? [];
		expect(result?.url).toBe(pendingUrl);
	});

	it("signs ready nested Relay URLs at the provider fence and preserves external URLs", async () => {
		const external = "https://cdn.example.test/photo.png";
		const resolved = await resolveRelayMediaForPublish(
			policyDb([
				{
					id: "med_1",
					storageKey: "org_1/media/file_1/photo.png",
					mimeType: "image/png",
					size: 1024,
				},
			]),
			signingEnv(),
			{
				media: [{ url: readyUrl }],
				target_options: {
					instagram: { media: [{ url: readyUrl }, { url: external }] },
				},
			},
			"org_1",
		);
		expect(resolved.media[0]?.url).toContain(
			".r2.cloudflarestorage.com/relayapi-media/org_1/media/file_1/photo.png",
		);
		expect(resolved.media[0]?.url).toContain("X-Amz-Signature=");
		expect(resolved.target_options.instagram.media[1]?.url).toBe(external);
	});

	it("rejects a post-confirm overwrite whose current R2 metadata drifted", async () => {
		expect(
			resolveRelayMediaForPublish(
				policyDb([
					{
						id: "med_1",
						storageKey: "org_1/media/file_1/photo.png",
						mimeType: "image/png",
						size: 1024,
					},
				]),
				signingEnv({ contentType: "text/html", size: 1024 }),
				{ media: [{ url: readyUrl }] },
				"org_1",
			),
		).rejects.toMatchObject({
			name: "RelayMediaPolicyError",
			violation: { reason: "stored_object_invalid" },
		});

		expect(
			resolveRelayMediaForPublish(
				policyDb([
					{
						id: "med_1",
						storageKey: "org_1/media/file_1/photo.png",
						mimeType: "image/png",
						size: 1024,
					},
				]),
				signingEnv({ contentType: "image/png", size: 2048 }),
				{ media: [{ url: readyUrl }] },
				"org_1",
			),
		).rejects.toMatchObject({
			name: "RelayMediaPolicyError",
			violation: { reason: "stored_object_drift" },
		});
	});

	it("rejects an unready Relay URL before the provider boundary", async () => {
		expect(
			resolveRelayMediaForPublish(
				policyDb([]),
				signingEnv(),
				{ media: [{ url: pendingUrl }] },
				"org_1",
			),
		).rejects.toBeInstanceOf(RelayMediaPolicyError);
	});
});

describe("media policy integration fences", () => {
	it("validates before every stale-upload promotion and retires invalid objects", () => {
		const source = readFileSync(
			new URL("../services/media-reliability.ts", import.meta.url),
			"utf8",
		);
		const reconciler = source.slice(
			source.indexOf("export async function reconcileMediaUploads"),
			source.indexOf("export function isMediaEventMessage"),
		);
		const validation = reconciler.indexOf("validateStoredMediaObject(object)");
		const promotion = reconciler.indexOf('status: "ready"');
		expect(validation).toBeGreaterThan(-1);
		expect(promotion).toBeGreaterThan(validation);
		expect(reconciler.slice(validation, promotion)).toContain(
			"retireRejectedMediaUpload",
		);
	});

	it("enforces readiness on single, update, bulk, CSV, and both publisher paths", () => {
		const posts = readFileSync(
			new URL("../routes/posts.ts", import.meta.url),
			"utf8",
		);
		for (const handler of [
			"app.openapi(createPostRoute",
			"app.openapi(updatePostRoute",
			"app.openapi(bulkCreatePosts",
			"app.openapi(bulkCsvUpload",
		]) {
			const start = posts.indexOf(handler);
			expect(start).toBeGreaterThan(-1);
			const handlerSource = posts.slice(start, start + 12_000);
			expect(handlerSource).toContain("violationForPostInput");
			expect(handlerSource).toContain("mediaPolicyError");
		}
		const publisher = readFileSync(
			new URL("../services/publisher-runner.ts", import.meta.url),
			"utf8",
		);
		const threadPublisher = readFileSync(
			new URL("../services/thread-publisher.ts", import.meta.url),
			"utf8",
		);
		expect(publisher).toContain("resolveRelayMediaForPublish");
		expect(publisher).toContain('"MEDIA_NOT_READY"');
		expect(threadPublisher).toContain("resolveRelayMediaForPublish");
		expect(threadPublisher).toContain('errorCode: "MEDIA_NOT_READY"');
	});
});
