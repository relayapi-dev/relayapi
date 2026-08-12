import {
	createDb,
	type Database,
	mediaDerivatives,
	mediaProcessingJobs,
} from "@relayapi/db";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { AUTOMATIC_MEDIA_PROFILE } from "../lib/media-storage-policy";
import type { Env } from "../types";
import { headStoredObject, storageLocatorForMedia } from "./storage-locator";

export const MEDIA_PROCESSOR_VERSION = "relay-media-v1";

const MAX_AUTOMATIC_ATTEMPTS = 3;
const RECOVERY_BATCH_SIZE = 100;

type MediaRow = {
	id: string;
	organizationId: string;
	workspaceId: string | null;
	storageProvider: "r2" | "byos";
	storageBucketLocator: string;
	storageRegion: string;
	storageLocationId: string | null;
	storageCredentialVersion: number | null;
	storageKey: string;
	mimeType: string;
};

export type MediaProcessingIntent = {
	operation: "normalize" | "provider_variant" | "cover";
	profile: string;
	options: Record<string, unknown>;
};

export type MediaProcessingRequestResult = {
	job: typeof mediaProcessingJobs.$inferSelect;
	createdOrRetried: boolean;
	handoffAccepted: boolean;
};

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => canonicalize(item));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value as Record<string, unknown>)
				.sort()
				.map((key) => [
					key,
					canonicalize((value as Record<string, unknown>)[key]),
				]),
		);
	}
	return value;
}

export function canonicalMediaProcessingOptions(
	options: Record<string, unknown>,
): string {
	return JSON.stringify(canonicalize(options));
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function supportsAutomaticNormalization(mimeType: string): boolean {
	return (
		mimeType.startsWith("image/") ||
		mimeType.startsWith("video/") ||
		mimeType.startsWith("audio/")
	);
}

export function supportsMediaProcessingIntent(
	mimeType: string,
	operation: MediaProcessingIntent["operation"],
): boolean {
	if (operation === "cover") {
		return mimeType.startsWith("image/") || mimeType.startsWith("video/");
	}
	return supportsAutomaticNormalization(mimeType);
}

function retryAt(attempts: number, now = new Date()): Date {
	const delayMinutes = Math.min(30, 2 ** Math.max(0, attempts));
	return new Date(now.getTime() + delayMinutes * 60_000);
}

async function sendJob(
	env: Env,
	job: Pick<typeof mediaProcessingJobs.$inferSelect, "id" | "leaseToken">,
): Promise<boolean> {
	if (!env.MEDIA_PROCESSING_QUEUE || !env.MEDIA_PROCESSING_WORKFLOW)
		return false;
	try {
		await env.MEDIA_PROCESSING_QUEUE.send({
			jobId: job.id,
			generation: job.leaseToken,
		});
		return true;
	} catch (error) {
		// The durable pending row is the recovery authority. The every-minute
		// reconciler will issue a new fenced generation if this handoff is lost.
		console.error("[media-processing] queue handoff failed", error);
		return false;
	}
}

export async function requestMediaProcessing(
	db: Database,
	env: Env,
	record: MediaRow,
	intent: MediaProcessingIntent,
): Promise<MediaProcessingRequestResult | null> {
	if (!supportsMediaProcessingIntent(record.mimeType, intent.operation)) {
		return null;
	}
	if (!env.MEDIA_PROCESSING_QUEUE || !env.MEDIA_PROCESSING_WORKFLOW)
		return null;
	if (!env.MEDIA_PROCESSOR) return null;
	const source = await headStoredObject(
		db,
		env,
		storageLocatorForMedia(record),
	);
	if (!source?.etag) return null;

	const optionsHash = await sha256(
		canonicalMediaProcessingOptions(intent.options),
	);
	const [created] = await db
		.insert(mediaProcessingJobs)
		.values({
			organizationId: record.organizationId,
			workspaceId: record.workspaceId,
			mediaId: record.id,
			operation: intent.operation,
			profile: intent.profile,
			options: intent.options,
			optionsHash,
			sourceEtag: source.etag,
			processorVersion: MEDIA_PROCESSOR_VERSION,
		})
		.onConflictDoNothing()
		.returning();

	let job = created;
	let createdOrRetried = !!created;
	if (!job) {
		[job] = await db
			.select()
			.from(mediaProcessingJobs)
			.where(
				and(
					eq(mediaProcessingJobs.mediaId, record.id),
					eq(mediaProcessingJobs.operation, intent.operation),
					eq(mediaProcessingJobs.profile, intent.profile),
					eq(mediaProcessingJobs.optionsHash, optionsHash),
					eq(mediaProcessingJobs.sourceEtag, source.etag),
					eq(mediaProcessingJobs.processorVersion, MEDIA_PROCESSOR_VERSION),
				),
			)
			.limit(1);
		if (
			job &&
			job.status === "failed" &&
			job.attempts < MAX_AUTOMATIC_ATTEMPTS
		) {
			const [retried] = await db
				.update(mediaProcessingJobs)
				.set({
					status: "pending",
					workflowId: null,
					leaseToken: sql`${mediaProcessingJobs.leaseToken} + 1`,
					leaseExpiresAt: null,
					nextAttemptAt: new Date(),
					lastErrorCode: null,
					lastError: null,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(mediaProcessingJobs.id, job.id),
						eq(mediaProcessingJobs.status, "failed"),
						eq(mediaProcessingJobs.leaseToken, job.leaseToken),
					),
				)
				.returning();
			if (retried) {
				job = retried;
				createdOrRetried = true;
			}
		}
	}
	if (!job) throw new Error("Media processing job could not be persisted");
	const handoffAccepted =
		job.status === "pending" ? await sendJob(env, job) : false;
	return { job, createdOrRetried, handoffAccepted };
}

/**
 * Best-effort, fail-open normalization for every transformable ready upload.
 * The original remains authoritative and publishable while the derivative is
 * pending or failed.
 */
export async function enqueueAutomaticMediaNormalization(
	db: Database,
	env: Env,
	record: MediaRow,
): Promise<MediaProcessingRequestResult | null> {
	if (!supportsAutomaticNormalization(record.mimeType)) return null;
	return requestMediaProcessing(db, env, record, {
		operation: "normalize",
		profile: AUTOMATIC_MEDIA_PROFILE,
		options: { compression_mode: "balanced", fail_open: true },
	});
}

/** Recover lost queue handoffs and expired processor leases without replaying a
 * live generation. Generations are monotonically fenced in PostgreSQL. */
export async function reconcileMediaProcessingJobs(env: Env): Promise<number> {
	if (
		!env.MEDIA_PROCESSING_QUEUE ||
		!env.MEDIA_PROCESSING_WORKFLOW ||
		!env.MEDIA_PROCESSOR
	) {
		return 0;
	}
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();

	await db
		.update(mediaProcessingJobs)
		.set({
			status: "manual_review",
			leaseExpiresAt: null,
			lastErrorCode: sql`COALESCE(${mediaProcessingJobs.lastErrorCode}, 'MEDIA_PROCESSING_RETRY_EXHAUSTED')`,
			lastError: sql`COALESCE(${mediaProcessingJobs.lastError}, 'Automatic media processing exhausted its retry budget')`,
			updatedAt: now,
		})
		.where(
			and(
				inArray(mediaProcessingJobs.status, ["failed", "processing"]),
				sql`${mediaProcessingJobs.attempts} >= ${MAX_AUTOMATIC_ATTEMPTS}`,
				or(
					eq(mediaProcessingJobs.status, "failed"),
					and(
						eq(mediaProcessingJobs.status, "processing"),
						lt(mediaProcessingJobs.leaseExpiresAt, now),
					),
				),
			),
		);

	const due = await db
		.select()
		.from(mediaProcessingJobs)
		.where(
			and(
				sql`${mediaProcessingJobs.attempts} < ${MAX_AUTOMATIC_ATTEMPTS}`,
				or(
					and(
						eq(mediaProcessingJobs.status, "pending"),
						lte(mediaProcessingJobs.nextAttemptAt, now),
					),
					and(
						eq(mediaProcessingJobs.status, "failed"),
						lte(mediaProcessingJobs.nextAttemptAt, now),
					),
					and(
						eq(mediaProcessingJobs.status, "processing"),
						lt(mediaProcessingJobs.leaseExpiresAt, now),
					),
				),
			),
		)
		.orderBy(
			asc(mediaProcessingJobs.nextAttemptAt),
			asc(mediaProcessingJobs.id),
		)
		.limit(RECOVERY_BATCH_SIZE);

	let recovered = 0;
	for (const candidate of due) {
		const [job] = await db
			.update(mediaProcessingJobs)
			.set({
				status: "pending",
				workflowId: null,
				leaseToken: sql`${mediaProcessingJobs.leaseToken} + 1`,
				leaseExpiresAt: null,
				nextAttemptAt: retryAt(candidate.attempts, now),
				updatedAt: now,
			})
			.where(
				and(
					eq(mediaProcessingJobs.id, candidate.id),
					eq(mediaProcessingJobs.status, candidate.status),
					eq(mediaProcessingJobs.leaseToken, candidate.leaseToken),
					candidate.status === "processing"
						? lt(mediaProcessingJobs.leaseExpiresAt, now)
						: isNull(mediaProcessingJobs.leaseExpiresAt),
				),
			)
			.returning();
		if (!job) continue;
		await sendJob(env, job);
		recovered++;
	}
	return recovered;
}

/** Delete expired private derivatives before removing their durable projection. */
export async function cleanupExpiredMediaDerivatives(
	env: Env,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const candidates = await db
		.select({
			id: mediaDerivatives.id,
			processingJobId: mediaDerivatives.processingJobId,
			storageKey: mediaDerivatives.storageKey,
			status: mediaDerivatives.status,
		})
		.from(mediaDerivatives)
		.where(
			and(
				inArray(mediaDerivatives.status, ["ready", "deleting"]),
				lte(mediaDerivatives.deleteAfter, now),
			),
		)
		.orderBy(asc(mediaDerivatives.deleteAfter), asc(mediaDerivatives.id))
		.limit(100);

	let deleted = 0;
	for (const candidate of candidates) {
		if (candidate.status === "ready") {
			const [claimed] = await db
				.update(mediaDerivatives)
				.set({ status: "deleting" })
				.where(
					and(
						eq(mediaDerivatives.id, candidate.id),
						eq(mediaDerivatives.status, "ready"),
						lte(mediaDerivatives.deleteAfter, now),
					),
				)
				.returning({ id: mediaDerivatives.id });
			if (!claimed) continue;
		}
		try {
			await env.MEDIA_BUCKET.delete(candidate.storageKey);
			await db.transaction(async (tx) => {
				await tx
					.delete(mediaProcessingJobs)
					.where(eq(mediaProcessingJobs.id, candidate.processingJobId));
				await tx
					.delete(mediaDerivatives)
					.where(eq(mediaDerivatives.id, candidate.id));
			});
			deleted++;
		} catch (error) {
			console.error("[media-processing] derivative cleanup failed", error);
		}
	}
	return deleted;
}
