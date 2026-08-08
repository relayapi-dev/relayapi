import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Database } from "@relayapi/db";
import { generateAndStoreThumbnail } from "../lib/thumbnails";
import mediaRouter, {
	getMediaReadUrl,
	MAX_MEDIA_UPLOAD_BYTES,
} from "../routes/media";
import {
	isManagedMediaStorageKey,
	isMediaEventMessage,
	MEDIA_DELETION_LATE_WRITE_GRACE_MS,
	MEDIA_DIRECT_UPLOAD_STALE_MS,
	MEDIA_PRESIGNED_UPLOAD_STALE_MS,
	mediaDeletionRetryDelaySeconds,
	processMediaDeletion,
	processMediaEvent,
	processThumbnailForMedia,
	RetryableMediaError,
	thumbnailRetryDelaySeconds,
} from "../services/media-reliability";
import type { Env, Variables } from "../types";

function fixture<T>(value: unknown): T {
	return value as T;
}

function envFixture(value: Partial<Env>): Env {
	return {
		R2_MEDIA_BUCKET_NAME: "relayapi-media",
		R2_MEDIA_BUCKET_JURISDICTION: "default",
		R2_THUMBNAIL_BUCKET_NAME: "relayapi-media-thumbnails",
		R2_THUMBNAIL_BUCKET_JURISDICTION: "default",
		...value,
	} as Env;
}

function updateOnlyDb(updates: Array<Record<string, unknown>>): Database {
	return fixture<Database>({
		update: () => ({
			set: (value: Record<string, unknown>) => {
				updates.push(value);
				return {
					where: () => ({
						returning: async () => [{ id: "med_1" }],
					}),
				};
			},
		}),
	});
}

/**
 * Upload route fixtures still exercise the real workspace-policy resolver.
 * Model an initialized organization in optional mode while keeping each test's
 * upload-write behavior explicit in its own DB fixture.
 */
function optionalWorkspacePolicyQuery() {
	let joined = false;
	const query = {
		from: () => query,
		innerJoin: () => {
			joined = true;
			return query;
		},
		where: () => query,
		orderBy: () => query,
		for: () => query,
		limit: async () =>
			joined ? [] : [{ requireWorkspaceId: false, revision: 0 }],
	};
	return query;
}

describe("typed thumbnail outcomes", () => {
	it("records unsupported MIME types as terminal", async () => {
		const result = await generateAndStoreThumbnail(
			envFixture({}),
			"org_1/file_1/report.pdf",
			"application/pdf",
		);
		expect(result.status).toBe("unsupported");
	});

	it("distinguishes a missing R2 source from a transient transform failure", async () => {
		const sourceMissing = await generateAndStoreThumbnail(
			envFixture({
				IMAGES: fixture<ImagesBinding>({}),
				MEDIA_BUCKET: fixture<R2Bucket>({ get: async () => null }),
			}),
			"org_1/file_1/photo.png",
			"image/png",
		);
		expect(sourceMissing.status).toBe("source_missing");

		const transient = await generateAndStoreThumbnail(
			envFixture({}),
			"org_1/file_1/photo.png",
			"image/png",
		);
		expect(transient).toEqual({
			status: "transient_failure",
			error: "Cloudflare Images binding is unavailable",
		});
	});

	it("returns generated only after the durable thumbnail object is stored", async () => {
		const puts: string[] = [];
		const output = fixture<ImageTransformationResult>({
			response: () => new Response("tiny-avif"),
		});
		let transformer: ImageTransformer;
		transformer = fixture<ImageTransformer>({
			transform: (): ImageTransformer => transformer,
			output: async () => output,
		});
		const originalBody = new Response("original").body;
		if (!originalBody) throw new Error("expected response body");
		const result = await generateAndStoreThumbnail(
			envFixture({
				MEDIA_BUCKET: fixture<R2Bucket>({
					get: async () =>
						fixture<R2ObjectBody>({
							size: 128,
							body: originalBody,
						}),
				}),
				IMAGES: fixture<ImagesBinding>({ input: () => transformer }),
				THUMBNAIL_BUCKET: fixture<R2Bucket>({
					put: async (key: string) => {
						puts.push(key);
						return fixture<R2Object>({ key });
					},
				}),
			}),
			"org_1/file_1/photo.png",
			"image/png",
		);

		expect(result.status).toBe("generated");
		expect(puts).toEqual(["org_1/file_1/photo.png.avif"]);
	});
});

describe("media retry and lifecycle state", () => {
	it("reconciles stale presigned-upload intents as well as direct uploads", () => {
		const source = readFileSync(
			new URL("../services/media-reliability.ts", import.meta.url),
			"utf8",
		);
		const reconciler = source.slice(
			source.indexOf("export async function reconcileMediaUploads"),
			source.indexOf("export function isMediaEventMessage"),
		);
		expect(reconciler).toContain('eq(media.status, "pending")');
		expect(reconciler).toContain(
			'inArray(media.status, ["uploading", "upload_failed"])',
		);
		expect(MEDIA_DIRECT_UPLOAD_STALE_MS).toBe(10 * 60 * 1000);
		expect(MEDIA_PRESIGNED_UPLOAD_STALE_MS).toBeGreaterThan(60 * 60 * 1000);
		expect(reconciler).toContain('"presigned_upload_expired"');
	});

	it("refuses to tombstone media still referenced by an active post", () => {
		const source = readFileSync(
			new URL("../routes/media.ts", import.meta.url),
			"utf8",
		);
		const guard = source.indexOf('code: "MEDIA_IN_USE"');
		const tombstone = source.indexOf('status: "deleting"', guard);
		expect(guard).toBeGreaterThan(-1);
		expect(tombstone).toBeGreaterThan(guard);
		expect(source.slice(guard - 1_000, guard)).toContain(
			'inArray(posts.status, ["draft", "scheduled", "publishing"])',
		);
		expect(source.slice(guard - 1_000, guard)).toContain(
			"jsonb_build_array(jsonb_build_object('url'",
		);
		expect(source.slice(guard - 1_000, guard)).not.toContain("::text LIKE");
	});

	it("uses bounded exponential retry delays", () => {
		expect(thumbnailRetryDelaySeconds(1)).toBe(60);
		expect(thumbnailRetryDelaySeconds(4)).toBe(480);
		expect(thumbnailRetryDelaySeconds(99)).toBeLessThanOrEqual(6 * 60 * 60);
	});

	it("retains a deletion tombstone and checkpoints the completed R2 phase", async () => {
		const updates: Array<Record<string, unknown>> = [];
		let rowDeleted = false;
		const row = {
			id: "med_delete_1",
			organizationId: "org_1",
			storageProvider: "r2" as const,
			storageBucketLocator: "relayapi-media",
			storageRegion: "default",
			storageKey: "org_1/file_1/photo.png",
			thumbnailKey: "org_1/file_1/photo.png.avif",
			thumbnailStorageProvider: "r2" as const,
			thumbnailStorageBucketLocator: "relayapi-media-thumbnails",
			thumbnailStorageRegion: "default",
			createdAt: new Date("2026-07-01T10:00:00Z"),
			deletionRequestedAt: new Date("2026-07-13T10:00:00Z"),
			originalDeletionConfirmedAt: null,
			thumbnailDeletionConfirmedAt: null,
			deletionAttempts: 0,
		};
		const query = {
			from: () => query,
			where: () => query,
			limit: async () => [row],
		};
		const db = fixture<Database>({
			select: () => query,
			update: () => ({
				set: (value: Record<string, unknown>) => {
					updates.push(value);
					return { where: async () => [] };
				},
			}),
			delete: () => ({
				where: async () => {
					rowDeleted = true;
				},
			}),
		});
		const deletedKeys: string[] = [];
		const result = await processMediaDeletion(
			db,
			envFixture({
				MEDIA_BUCKET: fixture<R2Bucket>({
					delete: async (key: string) => {
						deletedKeys.push(key);
					},
				}),
				THUMBNAIL_BUCKET: fixture<R2Bucket>({
					delete: async (key: string) => {
						deletedKeys.push(key);
						throw new Error("temporary R2 failure");
					},
				}),
			}),
			row.id,
			new Date("2026-07-13T10:01:00Z"),
		);

		expect(result).toEqual({
			status: "pending",
			attempts: 1,
			originalPending: false,
			thumbnailPending: true,
		});
		expect(rowDeleted).toBe(false);
		expect(deletedKeys).toEqual([row.storageKey, row.thumbnailKey]);
		expect(updates[0]?.originalDeletionConfirmedAt).toBeInstanceOf(Date);
		expect(updates[0]?.deletionLastError).toBe("thumbnail_delete_unconfirmed");
	});

	it("performs a final unconditional sweep before removing the tombstone", async () => {
		let rowDeleted = false;
		let originalDeleteCalls = 0;
		let thumbnailDeleteCalls = 0;
		const row = {
			id: "med_delete_2",
			organizationId: "org_1",
			storageProvider: "r2" as const,
			storageBucketLocator: "relayapi-media",
			storageRegion: "default",
			storageKey: "org_1/file_2/photo.png",
			thumbnailKey: "org_1/file_2/photo.png.avif",
			thumbnailStorageProvider: "r2" as const,
			thumbnailStorageBucketLocator: "relayapi-media-thumbnails",
			thumbnailStorageRegion: "default",
			createdAt: new Date("2026-07-01T10:00:00Z"),
			deletionRequestedAt: new Date("2026-07-13T10:00:00Z"),
			originalDeletionConfirmedAt: new Date("2026-07-13T10:01:00Z"),
			thumbnailDeletionConfirmedAt: null,
			deletionAttempts: 1,
		};
		const query = {
			from: () => query,
			where: () => query,
			limit: async () => [row],
		};
		const db = fixture<Database>({
			select: () => query,
			update: () => ({ set: () => ({ where: async () => [] }) }),
			delete: () => ({
				where: async () => {
					rowDeleted = true;
				},
			}),
		});
		const result = await processMediaDeletion(
			db,
			envFixture({
				MEDIA_BUCKET: fixture<R2Bucket>({
					delete: async () => {
						originalDeleteCalls++;
					},
				}),
				THUMBNAIL_BUCKET: fixture<R2Bucket>({
					delete: async () => {
						thumbnailDeleteCalls++;
					},
				}),
			}),
			row.id,
		);

		expect(result).toEqual({ status: "complete" });
		expect(originalDeleteCalls).toBe(1);
		expect(thumbnailDeleteCalls).toBe(1);
		expect(rowDeleted).toBe(true);
	});

	it("retains a recent tombstone until late presigned writes are impossible", async () => {
		const updates: Array<Record<string, unknown>> = [];
		let rowDeleted = false;
		const createdAt = new Date("2026-07-18T10:00:00Z");
		const now = new Date("2026-07-18T10:05:00Z");
		const row = {
			id: "med_delete_recent",
			organizationId: "org_1",
			storageProvider: "r2" as const,
			storageBucketLocator: "relayapi-media",
			storageRegion: "default",
			storageKey: "org_1/media/file_1/photo.png",
			thumbnailKey: "org_1/media/file_1/photo.png.avif",
			thumbnailStorageProvider: "r2" as const,
			thumbnailStorageBucketLocator: "relayapi-media-thumbnails",
			thumbnailStorageRegion: "default",
			createdAt,
			deletionRequestedAt: now,
			originalDeletionConfirmedAt: null,
			thumbnailDeletionConfirmedAt: null,
			deletionAttempts: 0,
		};
		const query = {
			from: () => query,
			where: () => query,
			limit: async () => [row],
		};
		const db = fixture<Database>({
			select: () => query,
			update: () => ({
				set: (value: Record<string, unknown>) => {
					updates.push(value);
					return { where: async () => [] };
				},
			}),
			delete: () => ({
				where: async () => {
					rowDeleted = true;
				},
			}),
		});

		const result = await processMediaDeletion(
			db,
			envFixture({
				MEDIA_BUCKET: fixture<R2Bucket>({ delete: async () => {} }),
				THUMBNAIL_BUCKET: fixture<R2Bucket>({ delete: async () => {} }),
			}),
			row.id,
			now,
		);

		expect(result).toEqual({
			status: "pending",
			attempts: 0,
			originalPending: false,
			thumbnailPending: false,
		});
		expect(rowDeleted).toBe(false);
		expect(updates[0]?.deletionNextRetryAt).toEqual(
			new Date(createdAt.getTime() + MEDIA_DELETION_LATE_WRITE_GRACE_MS),
		);
	});

	it("bounds deletion retry backoff", () => {
		expect(mediaDeletionRetryDelaySeconds(1)).toBe(30);
		expect(mediaDeletionRetryDelaySeconds(5)).toBe(480);
		expect(mediaDeletionRetryDelaySeconds(99)).toBeLessThanOrEqual(6 * 60 * 60);
	});

	it("persists transient retry state before asking the Queue to retry", async () => {
		const updates: Array<Record<string, unknown>> = [];
		const now = new Date("2026-07-12T12:00:00.000Z");
		const attempt = processThumbnailForMedia(
			updateOnlyDb(updates),
			envFixture({}),
			{
				id: "med_1",
				organizationId: "org_1",
				storageProvider: "r2",
				storageBucketLocator: "relayapi-media",
				storageRegion: "default",
				storageLocationId: null,
				storageCredentialVersion: null,
				storageKey: "org_1/file_1/photo.png",
				mimeType: "image/png",
				thumbnailUrl: null,
				thumbnailStatus: "pending",
				thumbnailAttempts: 0,
				thumbnailNextRetryAt: null,
				originalDeletedAt: null,
			},
			now,
		);

		await expect(attempt).rejects.toBeInstanceOf(RetryableMediaError);
		expect(updates).toHaveLength(2);
		expect(updates[0]?.thumbnailAttempts).toBe(1);
		expect(updates[0]?.thumbnailNextRetryAt).toEqual(
			new Date("2026-07-12T12:05:00.000Z"),
		);
		expect(updates[1]?.thumbnailStatus).toBe("transient_failure");
		expect(updates[1]?.thumbnailNextRetryAt).toEqual(
			new Date("2026-07-12T12:01:00.000Z"),
		);
	});

	it("allows only one thumbnail transform for duplicate deliveries", async () => {
		let claimOpen = false;
		let thumbnailStatus = "pending";
		let transformCalls = 0;
		const db = fixture<Database>({
			update: () => ({
				set: (values: Record<string, unknown>) => ({
					where: () => {
						const isClaim =
							"thumbnailAttempts" in values && !("thumbnailStatus" in values);
						if (isClaim) {
							const won = !claimOpen;
							if (won) claimOpen = true;
							return {
								returning: async () => (won ? [{ id: "med_race" }] : []),
							};
						}
						if (values.thumbnailStatus === "generated") {
							thumbnailStatus = "generated";
						}
						return { returning: async () => [{ id: "med_race" }] };
					},
				}),
			}),
		});
		const transformStarted = Promise.withResolvers<void>();
		const releaseTransform = Promise.withResolvers<void>();
		const output = fixture<ImageTransformationResult>({
			response: () => new Response("tiny-avif"),
		});
		let transformer: ImageTransformer;
		transformer = fixture<ImageTransformer>({
			transform: () => transformer,
			output: async () => output,
		});
		const env = envFixture({
			MEDIA_BUCKET: fixture<R2Bucket>({
				get: async () => {
					transformCalls++;
					transformStarted.resolve();
					await releaseTransform.promise;
					const body = new Response("original").body;
					if (!body) throw new Error("expected response body");
					return fixture<R2ObjectBody>({ size: 8, body });
				},
			}),
			IMAGES: fixture<ImagesBinding>({ input: () => transformer }),
			THUMBNAIL_BUCKET: fixture<R2Bucket>({
				put: async (key: string) => fixture<R2Object>({ key }),
			}),
		});
		const row = {
			id: "med_race",
			organizationId: "org_1",
			storageProvider: "r2" as const,
			storageBucketLocator: "relayapi-media",
			storageRegion: "default",
			storageLocationId: null,
			storageCredentialVersion: null,
			storageKey: "org_1/file_1/photo.png",
			mimeType: "image/png",
			thumbnailUrl: null,
			thumbnailStatus: "pending" as const,
			thumbnailAttempts: 0,
			thumbnailNextRetryAt: null,
			originalDeletedAt: null,
		};

		const first = processThumbnailForMedia(db, env, row);
		await transformStarted.promise;
		const duplicate = await processThumbnailForMedia(db, env, row);
		releaseTransform.resolve();
		const generated = await first;

		expect(duplicate.status).toBe("transient_failure");
		expect(generated.status).toBe("generated");
		expect(transformCalls).toBe(1);
		expect(thumbnailStatus).toBe("generated");
	});

	it("preserves the media row when the original lifecycle-deletes", async () => {
		const updates: Array<Record<string, unknown>> = [];
		let deleteCalled = false;
		const query = {
			from: () => query,
			where: () => query,
			limit: async () => [{ id: "med_1", thumbnailUrl: null }],
		};
		const db = fixture<Database>({
			select: () => query,
			update: () => ({
				set: (value: Record<string, unknown>) => {
					updates.push(value);
					return { where: async () => [] };
				},
			}),
			delete: () => {
				deleteCalled = true;
				return { where: async () => [] };
			},
		});

		await processMediaEvent(db, envFixture({}), {
			account: "account",
			bucket: "relayapi-media",
			action: "LifecycleDeletion",
			object: { key: "org_1/file_1/photo.png" },
		});

		expect(deleteCalled).toBe(false);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.url).toBeNull();
		expect(updates[0]?.originalDeletedAt).toBeInstanceOf(Date);
		expect(updates[0]?.thumbnailStatus).toBeDefined();
	});
});

describe("media event and read-path guards", () => {
	it("recognizes only the dedicated media object namespace", () => {
		expect(isManagedMediaStorageKey("org_1/media/file_abc/photo.png")).toBe(
			true,
		);
		expect(isManagedMediaStorageKey("org_1/ideas/file_abc/photo.png")).toBe(
			false,
		);
		expect(isManagedMediaStorageKey("org_1/file_abc/photo.png")).toBe(false);
	});

	it("deletes a late namespaced object after its tombstone is gone", async () => {
		const deleted: string[] = [];
		const query = {
			from: () => query,
			where: () => query,
			limit: async () => [],
		};
		await processMediaEvent(
			fixture<Database>({ select: () => query }),
			envFixture({
				MEDIA_BUCKET: fixture<R2Bucket>({
					delete: async (key: string) => {
						deleted.push(key);
					},
				}),
			}),
			{
				account: "account",
				bucket: "relayapi-media",
				action: "PutObject",
				object: { key: "org_1/media/file_late/photo.png" },
			},
		);
		expect(deleted).toEqual(["org_1/media/file_late/photo.png"]);
	});

	it("validates the R2 event fields used by the consumer", () => {
		expect(
			isMediaEventMessage(
				{
					account: "account",
					bucket: "relayapi-media",
					action: "PutObject",
					object: { key: "org_1/file.png" },
				},
				{ account: "account", bucket: "relayapi-media" },
			),
		).toBe(true);
		expect(isMediaEventMessage({ action: "PutObject", object: {} })).toBe(
			false,
		);
		expect(
			isMediaEventMessage(
				{
					account: "unexpected-account",
					bucket: "relayapi-media",
					action: "PutObject",
					object: { key: "org_1/file.png" },
				},
				{ account: "account", bucket: "relayapi-media" },
			),
		).toBe(false);
		expect(
			isMediaEventMessage(
				{
					account: "account",
					bucket: "unexpected-bucket",
					action: "PutObject",
					object: { key: "org_1/file.png" },
				},
				{ account: "account", bucket: "relayapi-media" },
			),
		).toBe(false);
	});

	it("persists a direct-upload row before putting the object in R2", async () => {
		const order: string[] = [];
		const db = fixture<Database>({
			select: () => optionalWorkspacePolicyQuery(),
			insert: () => ({
				values: async () => {
					order.push("db-intent");
					return [];
				},
			}),
			update: () => ({
				set: () => ({
					where: async () => {
						order.push("db-ready");
						return [];
					},
				}),
			}),
		});
		const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
		app.use("*", async (c, next) => {
			c.set("orgId", "org_1");
			c.set("workspaceScope", "all");
			c.set("db", db);
			await next();
		});
		app.route("/v1/media", mediaRouter);
		const env = envFixture({
			MEDIA_BUCKET: fixture<R2Bucket>({
				put: async (key: string, body: ReadableStream<Uint8Array>) => {
					order.push("r2-put");
					await new Response(body).arrayBuffer();
					return fixture<R2Object>({ key });
				},
			}),
		});

		const response = await app.request(
			"/v1/media/upload?filename=photo.png",
			{
				method: "POST",
				headers: { "content-type": "image/png" },
				body: "image-bytes",
			},
			env,
		);

		expect(response.status).toBe(201);
		expect(order).toEqual(["db-intent", "r2-put", "db-ready"]);
	});

	it("rejects an oversized declared upload before R2 or upload writes", async () => {
		let touchedStorage = false;
		const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
		app.use("*", async (c, next) => {
			c.set("orgId", "org_1");
			c.set("workspaceScope", "all");
			c.set(
				"db",
				fixture<Database>({
					select: () => optionalWorkspacePolicyQuery(),
					insert: () => {
						throw new Error("upload rows should not be written");
					},
				}),
			);
			await next();
		});
		app.route("/v1/media", mediaRouter);
		const env = envFixture({
			MEDIA_BUCKET: fixture<R2Bucket>({
				put: async () => {
					touchedStorage = true;
					return fixture<R2Object>({});
				},
			}),
		});

		const response = await app.request(
			"/v1/media/upload?filename=too-large.mp4",
			{
				method: "POST",
				headers: {
					"content-type": "video/mp4",
					"content-length": String(MAX_MEDIA_UPLOAD_BYTES + 1),
				},
				body: "x",
			},
			env,
		);

		expect(response.status).toBe(413);
		expect(touchedStorage).toBe(false);
	});

	it("stops a dishonest zero-length upload while streaming", async () => {
		const updates: Array<Record<string, unknown>> = [];
		const db = fixture<Database>({
			select: () => optionalWorkspacePolicyQuery(),
			insert: () => ({ values: async () => [] }),
			update: () => ({
				set: (value: Record<string, unknown>) => {
					updates.push(value);
					return { where: async () => [] };
				},
			}),
		});
		const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
		app.use("*", async (c, next) => {
			c.set("orgId", "org_1");
			c.set("workspaceScope", "all");
			c.set("db", db);
			await next();
		});
		app.route("/v1/media", mediaRouter);
		let chunksRead = 0;
		const env = envFixture({
			MEDIA_BUCKET: fixture<R2Bucket>({
				put: async (_key: string, body: ReadableStream<Uint8Array>) => {
					const reader = body.getReader();
					for (;;) {
						const { done } = await reader.read();
						if (done) break;
						chunksRead++;
					}
					return fixture<R2Object>({});
				},
			}),
		});
		let emitted = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (emitted >= 51) {
					controller.close();
					return;
				}
				emitted++;
				controller.enqueue(new Uint8Array(1024 * 1024));
			},
		});

		const response = await app.request(
			"/v1/media/upload?filename=lying.mp4",
			{
				method: "POST",
				headers: {
					"content-type": "video/mp4",
					"content-length": "0",
				},
				body,
			},
			env,
		);

		expect(response.status).toBe(413);
		expect(chunksRead).toBeLessThanOrEqual(50);
		expect(updates).toContainEqual(
			expect.objectContaining({ status: "upload_failed" }),
		);
	});

	it("returns the durable thumbnail after the original is gone", async () => {
		const readDb = fixture<Database>({});
		const url = await getMediaReadUrl(readDb, envFixture({}), {
			organizationId: "org_1",
			status: "ready",
			storageKey: "org_1/file_1/photo.png",
			url: null,
			thumbnailUrl: "https://thumbs.relayapi.dev/org_1/file_1/photo.png.avif",
			originalDeletedAt: new Date(),
			deletionRequestedAt: null,
		});
		expect(url).toBe("https://thumbs.relayapi.dev/org_1/file_1/photo.png.avif");

		const missing = await getMediaReadUrl(readDb, envFixture({}), {
			organizationId: "org_1",
			status: "ready",
			storageKey: "org_1/file_2/photo.png",
			url: null,
			thumbnailUrl: null,
			originalDeletedAt: new Date(),
			deletionRequestedAt: null,
		});
		expect(missing).toBeNull();
	});
});
