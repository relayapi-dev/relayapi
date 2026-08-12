import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Database } from "@relayapi/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Env } from "../types";

const retireCalls: Array<{ mediaId: string; reason: string }> = [];
const lifecycleEvents: string[] = [];

mock.module("../services/media-reliability", () => ({
	retireRejectedMediaUpload: async (
		_db: Database,
		_env: unknown,
		mediaId: string,
		_now: Date,
		reason: string,
	) => {
		lifecycleEvents.push("retire");
		retireCalls.push({ mediaId, reason });
	},
}));

const { encryptToken } = await import("../lib/crypto");
const {
	cleanupExpiredMediaUploadSessions,
	MEDIA_UPLOAD_SESSION_CLEANUP_LEASE_MS,
	MEDIA_UPLOAD_SESSION_TERMINAL_GRACE_MS,
} = await import("../services/media-upload-session-cleanup");
const { pruneExpiredAdvancedAdLeads } = await import(
	"../services/ad-advanced-store"
);

const ENCRYPTION_KEY = `active=${"ab".repeat(32)}`;

interface FixtureOptions {
	rows?: Array<{
		session: {
			id: string;
			mode: "single" | "multipart";
			multipartUploadIdCiphertext: string | null;
			status: "created" | "uploading" | "completing" | "aborting" | "failed";
			leaseToken: number;
		};
		record: {
			id: string;
			organizationId: string;
			storageProvider: "r2";
			storageBucketLocator: string;
			storageRegion: "default";
			storageLocationId: null;
			storageCredentialVersion: null;
			storageKey: string;
		};
	}>;
	deletedIds?: string[];
	claim?: boolean;
}

function databaseFixture(options: FixtureOptions = {}) {
	const updates: Array<Record<string, unknown>> = [];
	const statements: Array<Parameters<PgDialect["sqlToQuery"]>[0]> = [];
	const predicates: Array<Parameters<PgDialect["sqlToQuery"]>[0]> = [];
	let updateNumber = 0;
	const db = {
		select: () => ({
			from: () => ({
				innerJoin: () => ({
					where: (
						predicate: Parameters<PgDialect["sqlToQuery"]>[0] | undefined,
					) => {
						if (predicate) predicates.push(predicate);
						return {
							orderBy: () => ({
								limit: async () => options.rows ?? [],
							}),
						};
					},
				}),
			}),
		}),
		update: () => {
			const currentUpdate = updateNumber++;
			return {
				set: (values: Record<string, unknown>) => {
					updates.push(values);
					if (currentUpdate > 0) {
						lifecycleEvents.push(
							values.status === "expired" ? "finalize" : "release",
						);
					}
					return {
						where: (
							predicate: Parameters<PgDialect["sqlToQuery"]>[0] | undefined,
						) => {
							if (predicate) predicates.push(predicate);
							return Object.assign(Promise.resolve(undefined), {
								returning: async () => {
									if (currentUpdate === 0) lifecycleEvents.push("claim");
									return options.claim === false
										? []
										: [{ id: "mus_1", leaseToken: 8 }];
								},
							});
						},
					};
				},
			};
		},
		execute: async (statement: Parameters<PgDialect["sqlToQuery"]>[0]) => {
			lifecycleEvents.push("delete");
			statements.push(statement);
			return (options.deletedIds ?? []).map((id) => ({ id }));
		},
	};
	return { db: db as unknown as Database, predicates, statements, updates };
}

function environment(
	abort: () => Promise<void>,
	headResults: Array<R2Object | null> = [null],
): Env {
	return {
		ENCRYPTION_KEY,
		R2_MEDIA_BUCKET_NAME: "relayapi-media",
		R2_MEDIA_BUCKET_JURISDICTION: "default",
		MEDIA_BUCKET: {
			head: async () => headResults.shift() ?? null,
			resumeMultipartUpload: (key: string, uploadId: string) => {
				expect(key).toBe("org_1/media_1/source.mp4");
				expect(uploadId).toBe("provider-upload-1");
				return { abort };
			},
		},
	} as unknown as Env;
}

beforeEach(() => {
	retireCalls.length = 0;
	lifecycleEvents.length = 0;
});

describe("media upload session retention", () => {
	it("confirms provider abort before shredding multipart authority", async () => {
		const ciphertext = await encryptToken("provider-upload-1", ENCRYPTION_KEY, {
			recordId: "mus_1",
			field: "multipart_upload_id",
		});
		const { db, predicates, updates } = databaseFixture({
			rows: [
				{
					session: {
						id: "mus_1",
						mode: "multipart",
						multipartUploadIdCiphertext: ciphertext,
						status: "uploading",
						leaseToken: 7,
					},
					record: {
						id: "med_1",
						organizationId: "org_1",
						storageProvider: "r2",
						storageBucketLocator: "relayapi-media",
						storageRegion: "default",
						storageLocationId: null,
						storageCredentialVersion: null,
						storageKey: "org_1/media_1/source.mp4",
					},
				},
			],
		});
		const count = await cleanupExpiredMediaUploadSessions(
			environment(async () => {
				lifecycleEvents.push("abort");
			}),
			{ db, now: new Date("2026-08-10T12:00:00.000Z") },
		);

		expect(count).toBe(1);
		expect(lifecycleEvents).toEqual([
			"claim",
			"abort",
			"finalize",
			"retire",
			"delete",
		]);
		expect(updates[0]).toMatchObject({ status: "aborting" });
		expect(updates[0]).not.toHaveProperty("multipartUploadIdCiphertext");
		expect(updates[0]?.leaseExpiresAt).toEqual(
			new Date("2026-08-10T12:05:00.000Z"),
		);
		expect(MEDIA_UPLOAD_SESSION_CLEANUP_LEASE_MS).toBe(300_000);
		const dialect = new PgDialect();
		const selection = predicates[0];
		expect(selection).toBeDefined();
		if (!selection) throw new Error("missing expiry selection predicate");
		expect(dialect.sqlToQuery(selection).sql.replace(/\s+/g, " ")).toContain(
			'("media_upload_sessions"."lease_expires_at" is null or "media_upload_sessions"."lease_expires_at" <=',
		);
		const leaseIncrement = updates[0]?.leaseToken;
		expect(leaseIncrement).toBeDefined();
		if (!leaseIncrement) throw new Error("missing lease-token increment");
		expect(
			dialect
				.sqlToQuery(leaseIncrement as Parameters<PgDialect["sqlToQuery"]>[0])
				.sql.replace(/\s+/g, " "),
		).toContain('"media_upload_sessions"."lease_token" + 1');
		expect(updates[1]).toMatchObject({
			status: "expired",
			multipartUploadIdCiphertext: null,
			leaseExpiresAt: null,
			lastErrorCode: "UPLOAD_SESSION_EXPIRED",
		});
		expect(retireCalls).toEqual([
			{ mediaId: "med_1", reason: "upload_session_expired" },
		]);
	});

	it("retains encrypted abort authority when the provider abort fails", async () => {
		const ciphertext = await encryptToken("provider-upload-1", ENCRYPTION_KEY, {
			recordId: "mus_1",
			field: "multipart_upload_id",
		});
		const { db, updates } = databaseFixture({
			rows: [
				{
					session: {
						id: "mus_1",
						mode: "multipart",
						multipartUploadIdCiphertext: ciphertext,
						status: "aborting",
						leaseToken: 7,
					},
					record: {
						id: "med_1",
						organizationId: "org_1",
						storageProvider: "r2",
						storageBucketLocator: "relayapi-media",
						storageRegion: "default",
						storageLocationId: null,
						storageCredentialVersion: null,
						storageKey: "org_1/media_1/source.mp4",
					},
				},
			],
		});
		const errorLog = spyOn(console, "error").mockImplementation(() => {});
		try {
			const count = await cleanupExpiredMediaUploadSessions(
				environment(async () => {
					lifecycleEvents.push("abort");
					throw new Error("provider unavailable");
				}),
				{ db, now: new Date("2026-08-10T12:00:00.000Z") },
			);
			expect(count).toBe(0);
		} finally {
			errorLog.mockRestore();
		}

		expect(lifecycleEvents).toEqual(["claim", "abort", "release", "delete"]);
		expect(updates).toHaveLength(2);
		expect(updates[0]).toMatchObject({ status: "aborting" });
		expect(updates[0]).not.toHaveProperty("multipartUploadIdCiphertext");
		expect(updates[1]).toMatchObject({
			leaseExpiresAt: new Date("2026-08-10T12:00:00.000Z"),
			lastErrorCode: "UPLOAD_SESSION_ABORT_RETRY",
		});
		expect(updates[1]).not.toHaveProperty("multipartUploadIdCiphertext");
		expect(retireCalls).toEqual([]);
	});

	it("retires a completed R2 object after a crash before DB finalization", async () => {
		const ciphertext = await encryptToken("provider-upload-1", ENCRYPTION_KEY, {
			recordId: "mus_1",
			field: "multipart_upload_id",
		});
		const { db, updates } = databaseFixture({
			rows: [
				{
					session: {
						id: "mus_1",
						mode: "multipart",
						multipartUploadIdCiphertext: ciphertext,
						status: "completing",
						leaseToken: 7,
					},
					record: {
						id: "med_1",
						organizationId: "org_1",
						storageProvider: "r2",
						storageBucketLocator: "relayapi-media",
						storageRegion: "default",
						storageLocationId: null,
						storageCredentialVersion: null,
						storageKey: "org_1/media_1/source.mp4",
					},
				},
			],
		});
		let abortCalls = 0;
		const count = await cleanupExpiredMediaUploadSessions(
			environment(async () => {
				abortCalls++;
			}, [
				{
					size: 1024,
					httpEtag: "etag-completed",
					httpMetadata: { contentType: "video/mp4" },
				} as R2Object,
			]),
			{ db, now: new Date("2026-08-10T12:00:00.000Z") },
		);

		expect(count).toBe(1);
		expect(abortCalls).toBe(0);
		expect(updates[1]).toMatchObject({
			status: "expired",
			multipartUploadIdCiphertext: null,
			leaseExpiresAt: null,
		});
		expect(retireCalls).toEqual([
			{ mediaId: "med_1", reason: "upload_session_expired" },
		]);
	});

	it("treats R2 NoSuchUpload as confirmed prior abort when the object is absent", async () => {
		const ciphertext = await encryptToken("provider-upload-1", ENCRYPTION_KEY, {
			recordId: "mus_1",
			field: "multipart_upload_id",
		});
		const { db, updates } = databaseFixture({
			rows: [
				{
					session: {
						id: "mus_1",
						mode: "multipart",
						multipartUploadIdCiphertext: ciphertext,
						status: "aborting",
						leaseToken: 8,
					},
					record: {
						id: "med_1",
						organizationId: "org_1",
						storageProvider: "r2",
						storageBucketLocator: "relayapi-media",
						storageRegion: "default",
						storageLocationId: null,
						storageCredentialVersion: null,
						storageKey: "org_1/media_1/source.mp4",
					},
				},
			],
		});
		const count = await cleanupExpiredMediaUploadSessions(
			environment(async () => {
				throw new Error("abort: multipart upload does not exist (10024)");
			}),
			{ db, now: new Date("2026-08-10T12:00:00.000Z") },
		);

		expect(count).toBe(1);
		expect(updates[1]).toMatchObject({
			status: "expired",
			multipartUploadIdCiphertext: null,
			leaseExpiresAt: null,
		});
		expect(retireCalls).toEqual([
			{ mediaId: "med_1", reason: "upload_session_expired" },
		]);
	});

	it("counts a bounded terminal-row deletion pass after the 24-hour grace", async () => {
		const { db, statements } = databaseFixture({
			deletedIds: ["mus_1", "mus_2"],
		});
		const count = await cleanupExpiredMediaUploadSessions(
			environment(async () => {}),
			{
				db,
				now: new Date("2026-08-10T12:00:00.000Z"),
				deleteLimit: 2,
			},
		);
		expect(MEDIA_UPLOAD_SESSION_TERMINAL_GRACE_MS).toBe(86_400_000);
		expect(count).toBe(2);
		expect(lifecycleEvents).toEqual(["delete"]);
		const statement = statements[0];
		expect(statement).toBeDefined();
		if (!statement) throw new Error("missing terminal retention statement");
		const query = new PgDialect().sqlToQuery(statement);
		expect(query.sql.replace(/\s+/g, " ")).toContain(
			"status IN ('completed', 'aborted', 'failed', 'expired') AND expires_at <= $1 AND updated_at <= $2 AND lease_expires_at IS NULL AND multipart_upload_id_ciphertext IS NULL ORDER BY expires_at, id LIMIT $3",
		);
		expect(query.params).toContain(2);
		expect(query.params).toEqual([
			new Date("2026-08-09T12:00:00.000Z"),
			new Date("2026-08-09T12:00:00.000Z"),
			2,
		]);
	});
});

describe("advanced ad lead retention", () => {
	it("deletes the complete encrypted projection in one bounded ordered pass", async () => {
		const { db, statements } = databaseFixture({
			deletedIds: ["adlead_1", "adlead_2"],
		});
		const now = new Date("2026-08-10T12:00:00.000Z");
		const count = await pruneExpiredAdvancedAdLeads(
			{} as Pick<Env, "HYPERDRIVE">,
			{ db, now, limit: 50_001 },
		);

		expect(count).toBe(2);
		const statement = statements[0];
		expect(statement).toBeDefined();
		if (!statement) throw new Error("missing lead retention statement");
		const query = new PgDialect().sqlToQuery(statement);
		expect(query.sql.replace(/\s+/g, " ")).toContain(
			"DELETE FROM ad_leads WHERE id IN ( SELECT id FROM ad_leads WHERE expires_at <= $1 ORDER BY expires_at, id LIMIT $2 ) RETURNING id",
		);
		expect(query.params).toEqual([now, 5_000]);
	});
});
