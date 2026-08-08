import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	and,
	createDb,
	eq,
	generateId,
	sql,
	toolJobs,
	usageBuckets,
	usageReservations,
} from "@relayapi/db";
import { encryptToken } from "../lib/crypto";
import {
	type ClaimedToolJob,
	createToolJob,
	failExpiredToolJobs,
	pruneExpiredToolJobs,
	reconcileLateDefinitiveToolJobOutcome,
	TOOL_JOB_TERMINAL_TTL_MS,
} from "../services/tool-jobs";
import {
	PARKED_USAGE_WRITE_OFF_AFTER_MS,
	PARKED_USAGE_WRITE_OFF_REASON,
	writeOffExpiredParkedUsageReservations,
} from "../services/usage-meter";
import type { Env } from "../types";
import {
	deleteOwnedFixtureOrganization,
	insertOwnedFixtureOrganization,
} from "./helpers/owned-organization-fixture";

const CONNECTION_STRING =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
const REQUIRE_DB_FIXTURES = process.env.RELAYAPI_REQUIRE_DB_FIXTURES === "1";
const ENCRYPTION_KEY = `test=${"a".repeat(64)}`;

if (REQUIRE_DB_FIXTURES && !CONNECTION_STRING) {
	throw new Error(
		"RELAYAPI_REQUIRE_DB_FIXTURES=1 requires a PostgreSQL URL in HYPERDRIVE_LOCAL_CONNECTION_STRING or CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
	);
}

const db = CONNECTION_STRING
	? createDb(CONNECTION_STRING)
	: (null as unknown as ReturnType<typeof createDb>);
const databaseIt = CONNECTION_STRING ? it : it.skip;
const organizationId = generateId("org_");
const env = {
	HYPERDRIVE: { connectionString: CONNECTION_STRING ?? "" },
	ENCRYPTION_KEY,
	TOOLS_QUEUE: { send: async () => {} } as unknown as Queue,
} as Env;
let dbAvailable = false;

beforeAll(async () => {
	if (!CONNECTION_STRING) return;
	await insertOwnedFixtureOrganization(db, {
		id: organizationId,
		name: "Tool lifecycle fixture",
		slug: `tool-lifecycle-${organizationId.slice(-8)}`,
	});
	dbAvailable = true;
});

afterEach(async () => {
	if (!dbAvailable) return;
	await db.delete(toolJobs).where(eq(toolJobs.organizationId, organizationId));
	await db
		.delete(usageReservations)
		.where(eq(usageReservations.organizationId, organizationId));
	await db
		.delete(usageBuckets)
		.where(eq(usageBuckets.organizationId, organizationId));
});

afterAll(async () => {
	if (!dbAvailable) return;
	await deleteOwnedFixtureOrganization(db, organizationId);
});

async function encrypted(
	jobId: string,
	field: "request" | "result" | "error",
	value: unknown,
): Promise<string> {
	return encryptToken(JSON.stringify(value), ENCRYPTION_KEY, {
		recordId: jobId,
		field,
	});
}

async function seedProcessingJob(input: {
	now: Date;
	leaseExpiresAt: Date;
	attempts?: number;
}): Promise<ClaimedToolJob> {
	const bucketId = generateId("ub_");
	const reservationId = generateId("ur_");
	const jobId = generateId("tj_");
	const createdAt = new Date(input.now.getTime() - 60_000);
	const boundaryAt = new Date(createdAt.getTime() + 1_000);
	const deadlineAt = new Date(createdAt.getTime() + 15 * 60_000);
	await db.insert(usageBuckets).values({
		id: bucketId,
		organizationId,
		metric: "tool_invocation",
		periodStart: new Date(createdAt.getTime() - 60_000),
		periodEnd: new Date(createdAt.getTime() + 24 * 60 * 60_000),
		quotaMode: "hard",
		includedUnits: 10,
	});
	await db.insert(usageReservations).values({
		id: reservationId,
		organizationId,
		bucketId,
		idempotencyKey: `tool-fixture:${jobId}`,
		state: "reserved",
		disposition: "pending",
		reservedAt: createdAt,
		requestMayHaveBeenSentAt: boundaryAt,
	});
	await db.insert(toolJobs).values({
		id: jobId,
		organizationId,
		kind: "download",
		status: "processing",
		requestCiphertext: await encrypted(jobId, "request", {
			url: "https://example.test/video",
		}),
		usageReservationId: reservationId,
		attempts: input.attempts ?? 1,
		leaseToken: 7,
		nextAttemptAt: createdAt,
		leaseExpiresAt: input.leaseExpiresAt,
		requestMayHaveBeenSentAt: boundaryAt,
		deadlineAt,
		purgeAt: new Date(deadlineAt.getTime() + TOOL_JOB_TERMINAL_TTL_MS),
		createdAt,
		updatedAt: createdAt,
	});
	return {
		id: jobId,
		organizationId,
		kind: "download",
		request: { url: "https://example.test/video" },
		attempts: input.attempts ?? 1,
		leaseToken: 7,
		deadlineAt,
		usageReservation: { id: reservationId, bucketId, organizationId },
	};
}

describe("tool-job database lifecycle races", () => {
	databaseIt(
		"creates a pending job with one application-clock attempt timestamp",
		async () => {
			if (!dbAvailable)
				throw new Error("Database fixture setup did not complete");
			const now = new Date();
			const bucketId = generateId("ub_");
			const reservationId = generateId("ur_");
			const jobId = generateId("tj_");
			await db.insert(usageBuckets).values({
				id: bucketId,
				organizationId,
				metric: "tool_invocation",
				periodStart: new Date(now.getTime() - 60_000),
				periodEnd: new Date(now.getTime() + 24 * 60 * 60_000),
				quotaMode: "hard",
				includedUnits: 10,
			});
			await db.insert(usageReservations).values({
				id: reservationId,
				organizationId,
				bucketId,
				idempotencyKey: `tool-fixture:${jobId}`,
				reservedAt: now,
			});

			await createToolJob(
				env,
				jobId,
				organizationId,
				"download",
				reservationId,
				{
					url: "https://example.test/video",
				},
			);

			const [row] = await db
				.select({
					status: toolJobs.status,
					createdAt: toolJobs.createdAt,
					nextAttemptAt: toolJobs.nextAttemptAt,
				})
				.from(toolJobs)
				.where(eq(toolJobs.id, jobId));
			expect(row?.status).toBe("pending");
			expect(row?.nextAttemptAt.getTime()).toBe(row?.createdAt.getTime());
		},
	);

	databaseIt(
		"does not terminalize a processing row with a live lease",
		async () => {
			if (!dbAvailable)
				throw new Error("Database fixture setup did not complete");
			const now = new Date();
			const claim = await seedProcessingJob({
				now,
				leaseExpiresAt: new Date(now.getTime() + 30_000),
				attempts: 3,
			});

			expect(await failExpiredToolJobs(env, 10, now, organizationId)).toBe(0);
			const [live] = await db
				.select({ status: toolJobs.status })
				.from(toolJobs)
				.where(eq(toolJobs.id, claim.id));
			expect(live?.status).toBe("processing");

			await db
				.update(toolJobs)
				.set({ leaseExpiresAt: new Date(now.getTime() - 1) })
				.where(eq(toolJobs.id, claim.id));
			expect(await failExpiredToolJobs(env, 10, now, organizationId)).toBe(1);
			const [terminal] = await db
				.select({ status: toolJobs.status })
				.from(toolJobs)
				.where(eq(toolJobs.id, claim.id));
			expect(terminal?.status).toBe("manual_review");
		},
	);

	databaseIt(
		"reconciles a known-good late result after expired-lease manual review",
		async () => {
			if (!dbAvailable)
				throw new Error("Database fixture setup did not complete");
			const now = new Date();
			const claim = await seedProcessingJob({
				now,
				leaseExpiresAt: new Date(now.getTime() - 1),
			});

			expect(await failExpiredToolJobs(env, 10, now, organizationId)).toBe(1);
			expect(
				await reconcileLateDefinitiveToolJobOutcome(
					env,
					claim,
					{ kind: "completed", result: { download_url: "https://cdn.test/x" } },
					new Date(now.getTime() + 1),
				),
			).toBe(true);

			const [row] = await db
				.select({
					status: toolJobs.status,
					errorCode: toolJobs.errorCode,
					resultCiphertext: toolJobs.resultCiphertext,
					disposition: usageReservations.disposition,
				})
				.from(toolJobs)
				.innerJoin(
					usageReservations,
					and(
						eq(usageReservations.id, toolJobs.usageReservationId),
						eq(usageReservations.organizationId, toolJobs.organizationId),
					),
				)
				.where(eq(toolJobs.id, claim.id));
			expect(row).toEqual(
				expect.objectContaining({
					status: "completed",
					errorCode: null,
					disposition: "settled",
				}),
			);
			expect(row?.resultCiphertext).toStartWith("enc:v2:");
		},
	);

	databaseIt(
		"reconciles a definitive late provider rejection after manual review",
		async () => {
			if (!dbAvailable)
				throw new Error("Database fixture setup did not complete");
			const now = new Date();
			const claim = await seedProcessingJob({
				now,
				leaseExpiresAt: new Date(now.getTime() - 1),
			});

			expect(await failExpiredToolJobs(env, 10, now, organizationId)).toBe(1);
			expect(
				await reconcileLateDefinitiveToolJobOutcome(
					env,
					claim,
					{
						kind: "failed",
						error: "captions are unavailable",
						errorCode: "EXTRACTION_FAILED",
					},
					new Date(now.getTime() + 1),
				),
			).toBe(true);

			const [row] = await db
				.select({
					status: toolJobs.status,
					errorCode: toolJobs.errorCode,
					errorCiphertext: toolJobs.errorCiphertext,
					disposition: usageReservations.disposition,
				})
				.from(toolJobs)
				.innerJoin(
					usageReservations,
					and(
						eq(usageReservations.id, toolJobs.usageReservationId),
						eq(usageReservations.organizationId, toolJobs.organizationId),
					),
				)
				.where(eq(toolJobs.id, claim.id));
			expect(row).toEqual(
				expect.objectContaining({
					status: "failed",
					errorCode: "EXTRACTION_FAILED",
					disposition: "settled",
				}),
			);
			expect(row?.errorCiphertext).toStartWith("enc:v2:");
		},
	);

	databaseIt(
		"never overwrites an operator transition with a late provider result",
		async () => {
			if (!dbAvailable)
				throw new Error("Database fixture setup did not complete");
			const now = new Date();
			const claim = await seedProcessingJob({
				now,
				leaseExpiresAt: new Date(now.getTime() - 1),
			});

			expect(await failExpiredToolJobs(env, 10, now, organizationId)).toBe(1);
			await db
				.update(toolJobs)
				.set({
					status: "failed",
					requestCiphertext: null,
					errorCode: "OPERATOR_ABANDONED",
					leaseToken: sql`${toolJobs.leaseToken} + 1`,
					updatedAt: new Date(now.getTime() + 1),
				})
				.where(eq(toolJobs.id, claim.id));

			expect(
				await reconcileLateDefinitiveToolJobOutcome(
					env,
					claim,
					{ kind: "completed", result: { should_not_persist: true } },
					new Date(now.getTime() + 2),
				),
			).toBe(false);
			const [row] = await db
				.select({
					status: toolJobs.status,
					leaseToken: toolJobs.leaseToken,
					errorCode: toolJobs.errorCode,
					resultCiphertext: toolJobs.resultCiphertext,
					disposition: usageReservations.disposition,
				})
				.from(toolJobs)
				.innerJoin(
					usageReservations,
					and(
						eq(usageReservations.id, toolJobs.usageReservationId),
						eq(usageReservations.organizationId, toolJobs.organizationId),
					),
				)
				.where(eq(toolJobs.id, claim.id));
			expect(row).toEqual(
				expect.objectContaining({
					status: "failed",
					leaseToken: claim.leaseToken + 1,
					errorCode: "OPERATOR_ABANDONED",
					resultCiphertext: null,
					disposition: "unknown",
				}),
			);
		},
	);

	databaseIt(
		"prunes only terminal rows even if a live row has expired purge_at",
		async () => {
			if (!dbAvailable)
				throw new Error("Database fixture setup did not complete");
			const now = new Date();
			const createdAt = new Date(now.getTime() - 2 * 60 * 60_000);
			const bucketId = generateId("ub_");
			const pendingReservationId = generateId("ur_");
			const completedReservationId = generateId("ur_");
			const pendingJobId = generateId("tj_");
			const completedJobId = generateId("tj_");
			const boundaryAt = new Date(createdAt.getTime() + 1_000);
			await db.insert(usageBuckets).values({
				id: bucketId,
				organizationId,
				metric: "tool_invocation",
				periodStart: new Date(createdAt.getTime() - 60_000),
				periodEnd: new Date(now.getTime() + 24 * 60 * 60_000),
				quotaMode: "hard",
				includedUnits: 10,
			});
			await db.insert(usageReservations).values([
				{
					id: pendingReservationId,
					organizationId,
					bucketId,
					idempotencyKey: `tool-fixture:${pendingJobId}`,
					reservedAt: createdAt,
				},
				{
					id: completedReservationId,
					organizationId,
					bucketId,
					idempotencyKey: `tool-fixture:${completedJobId}`,
					state: "committed",
					disposition: "settled",
					committedUnits: 1,
					reservedAt: createdAt,
					requestMayHaveBeenSentAt: boundaryAt,
					finalizedAt: new Date(createdAt.getTime() + 2_000),
				},
			]);
			const expiredPurgeAt = new Date(now.getTime() - 1);
			await db.insert(toolJobs).values([
				{
					id: pendingJobId,
					organizationId,
					kind: "download",
					requestCiphertext: await encrypted(pendingJobId, "request", {
						url: "https://example.test/pending",
					}),
					usageReservationId: pendingReservationId,
					deadlineAt: new Date(now.getTime() + 60_000),
					purgeAt: expiredPurgeAt,
					nextAttemptAt: createdAt,
					createdAt,
					updatedAt: createdAt,
				},
				{
					id: completedJobId,
					organizationId,
					kind: "download",
					status: "completed",
					resultCiphertext: await encrypted(completedJobId, "result", {
						download_url: "https://cdn.test/completed",
					}),
					usageReservationId: completedReservationId,
					attempts: 1,
					leaseToken: 1,
					nextAttemptAt: createdAt,
					requestMayHaveBeenSentAt: boundaryAt,
					deadlineAt: new Date(createdAt.getTime() + 60_000),
					completedAt: new Date(createdAt.getTime() + 2_000),
					purgeAt: expiredPurgeAt,
					createdAt,
					updatedAt: createdAt,
				},
			]);

			expect(await pruneExpiredToolJobs(env, 10, now, organizationId)).toBe(1);
			const remaining = await db
				.select({ id: toolJobs.id })
				.from(toolJobs)
				.where(eq(toolJobs.organizationId, organizationId));
			expect(remaining).toEqual([{ id: pendingJobId }]);
		},
	);

	databaseIt(
		"retains an unknown tool handle until a due 30-day usage write-off completes",
		async () => {
			if (!dbAvailable)
				throw new Error("Database fixture setup did not complete");
			const now = new Date();
			const cutoff = new Date(now.getTime() - PARKED_USAGE_WRITE_OFF_AFTER_MS);
			const oldReservationId = generateId("ur_");
			const recentReservationId = generateId("ur_");
			const jobId = generateId("tj_");
			const bucketId = generateId("ub_");
			const recentReservedAt = new Date(cutoff.getTime() - 1_000);
			const recentBoundaryAt = new Date(cutoff.getTime() + 1);
			await db.insert(usageBuckets).values({
				id: bucketId,
				organizationId,
				metric: "tool_invocation",
				periodStart: new Date(cutoff.getTime() - 24 * 60 * 60_000),
				periodEnd: new Date(now.getTime() + 24 * 60 * 60_000),
				quotaMode: "hard",
				includedUnits: 10,
			});
			await db.insert(usageReservations).values([
				{
					id: oldReservationId,
					organizationId,
					bucketId,
					idempotencyKey: `tool-write-off:${jobId}`,
					units: 3,
					state: "parked",
					disposition: "unknown",
					reservedAt: cutoff,
					requestMayHaveBeenSentAt: cutoff,
				},
				{
					id: recentReservationId,
					organizationId,
					bucketId,
					idempotencyKey: `usage-write-off:not-due:${recentReservationId}`,
					units: 2,
					state: "parked",
					disposition: "unknown",
					reservedAt: recentReservedAt,
					requestMayHaveBeenSentAt: recentBoundaryAt,
				},
			]);
			await db.insert(toolJobs).values({
				id: jobId,
				organizationId,
				kind: "download",
				status: "manual_review",
				requestCiphertext: await encrypted(jobId, "request", {
					url: "https://example.test/unknown",
				}),
				errorCiphertext: await encrypted(
					jobId,
					"error",
					"Provider outcome is unknown",
				),
				errorCode: "PROVIDER_OUTCOME_UNKNOWN",
				usageReservationId: oldReservationId,
				attempts: 1,
				leaseToken: 7,
				nextAttemptAt: cutoff,
				requestMayHaveBeenSentAt: cutoff,
				deadlineAt: new Date(cutoff.getTime() + 15 * 60_000),
				completedAt: new Date(cutoff.getTime() + 60_000),
				purgeAt: new Date(now.getTime() - 1),
				createdAt: cutoff,
				updatedAt: new Date(cutoff.getTime() + 60_000),
			});

			expect(await pruneExpiredToolJobs(env, 10, now, organizationId)).toBe(0);
			expect(
				await writeOffExpiredParkedUsageReservations(
					db,
					10,
					now,
					organizationId,
				),
			).toBe(1);

			const [oldReservation] = await db
				.select()
				.from(usageReservations)
				.where(eq(usageReservations.id, oldReservationId));
			const [recentReservation] = await db
				.select()
				.from(usageReservations)
				.where(eq(usageReservations.id, recentReservationId));
			const [bucket] = await db
				.select({
					committedUnits: usageBuckets.committedUnits,
					reservedUnits: usageBuckets.reservedUnits,
				})
				.from(usageBuckets)
				.where(eq(usageBuckets.id, bucketId));
			expect(oldReservation).toEqual(
				expect.objectContaining({
					state: "released",
					disposition: "written_off",
					committedUnits: 0,
					writeOffReason: PARKED_USAGE_WRITE_OFF_REASON,
				}),
			);
			expect(oldReservation?.writtenOffAt?.getTime()).toBe(now.getTime());
			expect(oldReservation?.finalizedAt?.getTime()).toBe(now.getTime());
			expect(oldReservation?.writeOffEvidence).toEqual(
				expect.objectContaining({
					policy: "parked_usage_30_day_write_off_v1",
					decision: "release_without_charge",
					reason_code: PARKED_USAGE_WRITE_OFF_REASON,
					minimum_age_days: 30,
					written_off_at: now.toISOString(),
				}),
			);
			expect(recentReservation).toEqual(
				expect.objectContaining({
					state: "parked",
					disposition: "unknown",
					committedUnits: null,
					writtenOffAt: null,
				}),
			);
			expect(bucket).toEqual({ committedUnits: 0, reservedUnits: 2 });

			expect(await pruneExpiredToolJobs(env, 10, now, organizationId)).toBe(1);
			const [removedJob] = await db
				.select({ id: toolJobs.id })
				.from(toolJobs)
				.where(eq(toolJobs.id, jobId));
			expect(removedJob).toBeUndefined();
		},
	);
});
