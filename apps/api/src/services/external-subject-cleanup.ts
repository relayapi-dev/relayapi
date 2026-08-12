import {
	createDb,
	type Database,
	externalSubjectCleanupJobs,
	generateId,
} from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import { exponentialBackoffSeconds } from "../lib/async-policy";
import { maybeDecrypt } from "../lib/crypto";
import {
	deleteQueueRescueSubjectPage,
	type QueueRescueSubjectKind,
} from "../queues/queue-rescue";
import type { Env } from "../types";
import type { ExternalShortLinkProviderType } from "./short-link-lifecycle";
import { getProvider, type ProviderRef } from "./short-link-providers";

export const EXTERNAL_SUBJECT_CLEANUP_BATCH_SIZE = 25;
export const EXTERNAL_SUBJECT_CLEANUP_TENANT_CAP = 5;
export const EXTERNAL_SUBJECT_CLEANUP_LEASE_MS = 5 * 60 * 1_000;
export const EXTERNAL_SUBJECT_CLEANUP_DEADLINE_MS = 7 * 24 * 60 * 60 * 1_000;
export const EXTERNAL_SUBJECT_CLEANUP_RECEIPT_MS = 90 * 24 * 60 * 60 * 1_000;

const CLEANUP_RETRY = {
	baseSeconds: 30,
	capSeconds: 6 * 60 * 60,
	jitterRatio: 0.2,
} as const;

export type ExternalCleanupSubjectKind =
	| "user"
	| "contact"
	| "account"
	| "organization"
	| "workspace";
export type ExternalCleanupObjectBucket = "avatar" | "media" | "thumbnail";

type CleanupWriter = Pick<Database, "insert">;
type CleanupJob = typeof externalSubjectCleanupJobs.$inferSelect;

interface CleanupSubject {
	subjectKind: ExternalCleanupSubjectKind;
	subjectId: string;
	organizationId?: string | null;
	workspaceId?: string | null;
}

export type EnqueueExternalSubjectCleanupInput =
	| (CleanupSubject & {
			operation: "delete_exact";
			bucket: ExternalCleanupObjectBucket;
			objectLocator: string;
	  })
	| (CleanupSubject & {
			operation: "delete_prefix";
			bucket: ExternalCleanupObjectBucket;
			prefixLocator: string;
	  })
	| (CleanupSubject & {
			operation: "purge_rescue_subject";
			bucket: "queue_rescue";
			subjectKind: QueueRescueSubjectKind;
			organizationId: string;
	  })
	| (CleanupSubject & {
			operation: "delete_short_link";
			bucket: "short_link_provider";
			subjectKind: "organization" | "workspace";
			organizationId: string;
			provider: ExternalShortLinkProviderType;
			providerRef: ProviderRef;
			credentialCiphertext: string;
	  });

function hasAsciiControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function requireIdentifier(value: string, name: string): string {
	if (
		value.length === 0 ||
		value.length > 180 ||
		hasAsciiControlCharacter(value)
	) {
		throw new Error(`Invalid external cleanup ${name}`);
	}
	return value;
}

function validateObjectLocator(
	bucket: ExternalCleanupObjectBucket,
	locator: string,
	kind: "exact" | "prefix",
): string {
	if (
		locator.length === 0 ||
		locator.length > 1024 ||
		locator.startsWith("/") ||
		locator.includes("//") ||
		/(^|\/)\.\.?(\/|$)/.test(locator) ||
		hasAsciiControlCharacter(locator) ||
		(kind === "exact" ? locator.endsWith("/") : !locator.endsWith("/"))
	) {
		throw new Error(`Invalid ${bucket} cleanup ${kind} locator`);
	}
	if (
		bucket === "avatar" &&
		!/^(account|user|organization)\/[^/]+\//.test(locator)
	) {
		throw new Error("Avatar cleanup locator is outside a typed avatar prefix");
	}
	if (
		bucket === "thumbnail" &&
		kind === "exact" &&
		!locator.endsWith(".avif")
	) {
		throw new Error("Thumbnail exact cleanup locator must end in .avif");
	}
	if (
		bucket === "media" &&
		/^(account|user|organization|queue-rescue)\//.test(locator)
	) {
		throw new Error("Media cleanup locator belongs to another bucket family");
	}
	return locator;
}

function validateSubject(input: CleanupSubject): void {
	requireIdentifier(input.subjectId, "subject ID");
	if (input.organizationId) {
		requireIdentifier(input.organizationId, "organization ID");
	}
	if (input.workspaceId) {
		requireIdentifier(input.workspaceId, "workspace ID");
	}
	if (
		(input.subjectKind === "contact" || input.subjectKind === "account") &&
		!input.organizationId
	) {
		throw new Error(`${input.subjectKind} cleanup requires an organization`);
	}
	if (
		input.subjectKind === "organization" &&
		(input.organizationId !== input.subjectId || input.workspaceId)
	) {
		throw new Error("Organization cleanup subject tuple is inconsistent");
	}
	if (
		input.subjectKind === "workspace" &&
		(!input.organizationId || input.workspaceId !== input.subjectId)
	) {
		throw new Error("Workspace cleanup subject tuple is inconsistent");
	}
	if (input.subjectKind === "user" && input.workspaceId) {
		throw new Error("User cleanup cannot carry a workspace locator");
	}
}

/**
 * Persist one idempotent external cleanup intent inside the caller's business
 * transaction. The expression unique index makes duplicate erasure requests a
 * no-op without coalescing unrelated object keys into an unbounded JSON array.
 */
export async function enqueueExternalSubjectCleanup(
	db: CleanupWriter,
	input: EnqueueExternalSubjectCleanupInput,
	now = new Date(),
): Promise<string | null> {
	validateSubject(input);
	const objectLocator =
		input.operation === "delete_exact"
			? validateObjectLocator(input.bucket, input.objectLocator, "exact")
			: null;
	const prefixLocator =
		input.operation === "delete_prefix"
			? validateObjectLocator(input.bucket, input.prefixLocator, "prefix")
			: null;
	if (input.operation === "purge_rescue_subject" && !input.organizationId) {
		throw new Error("Queue rescue cleanup requires an organization");
	}
	if (input.operation === "delete_short_link") {
		if (
			input.providerRef.provider !== input.provider ||
			input.credentialCiphertext.length === 0 ||
			input.credentialCiphertext.length > 8192
		) {
			throw new Error("Short-link cleanup provider identity is invalid");
		}
	}

	const id = generateId("escj_");
	const inserted = await db
		.insert(externalSubjectCleanupJobs)
		.values({
			id,
			organizationId: input.organizationId ?? null,
			workspaceId: input.workspaceId ?? null,
			subjectKind: input.subjectKind,
			subjectId: input.subjectId,
			operation: input.operation,
			bucket: input.bucket,
			objectLocator,
			prefixLocator,
			externalProvider:
				input.operation === "delete_short_link" ? input.provider : null,
			providerRef:
				input.operation === "delete_short_link" ? input.providerRef : null,
			credentialCiphertext:
				input.operation === "delete_short_link"
					? input.credentialCiphertext
					: null,
			status: "pending",
			nextAttemptAt: now,
			deadlineAt: new Date(
				now.getTime() + EXTERNAL_SUBJECT_CLEANUP_DEADLINE_MS,
			),
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing()
		.returning({ id: externalSubjectCleanupJobs.id });
	return inserted[0]?.id ?? null;
}

export function enqueueExactObjectCleanup(
	db: CleanupWriter,
	input: CleanupSubject & {
		bucket: ExternalCleanupObjectBucket;
		objectLocator: string;
	},
	now = new Date(),
): Promise<string | null> {
	return enqueueExternalSubjectCleanup(
		db,
		{ ...input, operation: "delete_exact" },
		now,
	);
}

export function enqueueObjectPrefixCleanup(
	db: CleanupWriter,
	input: CleanupSubject & {
		bucket: ExternalCleanupObjectBucket;
		prefixLocator: string;
	},
	now = new Date(),
): Promise<string | null> {
	return enqueueExternalSubjectCleanup(
		db,
		{ ...input, operation: "delete_prefix" },
		now,
	);
}

export function enqueueQueueRescueSubjectCleanup(
	db: CleanupWriter,
	input: CleanupSubject & {
		subjectKind: QueueRescueSubjectKind;
		organizationId: string;
	},
	now = new Date(),
): Promise<string | null> {
	return enqueueExternalSubjectCleanup(
		db,
		{ ...input, operation: "purge_rescue_subject", bucket: "queue_rescue" },
		now,
	);
}

export function enqueueShortLinkProviderCleanup(
	db: CleanupWriter,
	input: CleanupSubject & {
		subjectKind: "organization" | "workspace";
		organizationId: string;
		provider: ExternalShortLinkProviderType;
		providerRef: ProviderRef;
		credentialCiphertext: string;
	},
	now = new Date(),
): Promise<string | null> {
	return enqueueExternalSubjectCleanup(
		db,
		{
			...input,
			operation: "delete_short_link",
			bucket: "short_link_provider",
		},
		now,
	);
}

function objectBucket(env: Env, bucket: ExternalCleanupObjectBucket): R2Bucket {
	if (bucket === "avatar") return env.AVATAR_BUCKET;
	if (bucket === "media") return env.MEDIA_BUCKET;
	return env.THUMBNAIL_BUCKET;
}

async function processObjectJob(
	env: Env,
	job: CleanupJob,
): Promise<{ complete: boolean; cursor: string | null }> {
	if (
		job.bucket !== "avatar" &&
		job.bucket !== "media" &&
		job.bucket !== "thumbnail"
	) {
		throw new Error("cleanup_bucket_mismatch");
	}
	const bucket = objectBucket(env, job.bucket);
	if (job.operation === "delete_exact") {
		if (!job.objectLocator) throw new Error("cleanup_exact_locator_missing");
		await bucket.delete(job.objectLocator);
		return { complete: true, cursor: null };
	}
	if (job.operation !== "delete_prefix" || !job.prefixLocator) {
		throw new Error("cleanup_prefix_locator_missing");
	}
	const page = await bucket.list({
		prefix: job.prefixLocator,
		limit: 1_000,
		...(job.cursor ? { cursor: job.cursor } : {}),
	});
	if (page.objects.length > 0) {
		await bucket.delete(page.objects.map(({ key }) => key));
	}
	if (!page.truncated) return { complete: true, cursor: null };
	if (!page.cursor) throw new Error("cleanup_prefix_cursor_missing");
	return { complete: false, cursor: page.cursor };
}

async function processRescueJob(
	env: Env,
	job: CleanupJob,
): Promise<{ complete: boolean; cursor: string | null }> {
	if (
		job.operation !== "purge_rescue_subject" ||
		job.bucket !== "queue_rescue" ||
		!job.organizationId ||
		(job.subjectKind !== "workspace" &&
			job.subjectKind !== "user" &&
			job.subjectKind !== "contact" &&
			job.subjectKind !== "account")
	) {
		throw new Error("cleanup_rescue_locator_invalid");
	}
	const page = await deleteQueueRescueSubjectPage(
		env.QUEUE_RESCUE_BUCKET,
		job.organizationId,
		{ kind: job.subjectKind, id: job.subjectId },
		{ cursor: job.cursor ?? undefined, limit: 500 },
	);
	return {
		complete: page.complete,
		cursor: page.complete ? null : (page.cursor ?? null),
	};
}

async function processShortLinkJob(env: Env, job: CleanupJob) {
	if (
		job.operation !== "delete_short_link" ||
		job.bucket !== "short_link_provider" ||
		!job.externalProvider ||
		!job.providerRef ||
		!job.credentialCiphertext
	) {
		throw new Error("cleanup_short_link_identity_invalid");
	}
	const provider = getProvider(
		job.externalProvider as ExternalShortLinkProviderType,
	);
	if (!provider) throw new Error("cleanup_short_link_provider_unsupported");
	const apiKey = await maybeDecrypt(
		job.credentialCiphertext,
		env.ENCRYPTION_KEY,
	);
	if (!apiKey) throw new Error("cleanup_short_link_credential_invalid");
	return provider.deleteLink(apiKey, job.providerRef as ProviderRef);
}

function retryAt(job: CleanupJob, now: Date): Date {
	return new Date(
		now.getTime() +
			exponentialBackoffSeconds(
				job.attempts,
				CLEANUP_RETRY,
				`${job.id}:${job.leaseToken}`,
			) *
				1_000,
	);
}

async function completeJob(
	db: Database,
	job: CleanupJob,
	now: Date,
): Promise<boolean> {
	const rows = await db
		.update(externalSubjectCleanupJobs)
		.set({
			status: "completed",
			cursor: null,
			credentialCiphertext: null,
			leaseExpiresAt: null,
			lastError: null,
			completedAt: now,
			purgeAt: new Date(now.getTime() + EXTERNAL_SUBJECT_CLEANUP_RECEIPT_MS),
			updatedAt: now,
		})
		.where(
			and(
				eq(externalSubjectCleanupJobs.id, job.id),
				eq(externalSubjectCleanupJobs.status, "processing"),
				eq(externalSubjectCleanupJobs.leaseToken, job.leaseToken),
			),
		)
		.returning({ id: externalSubjectCleanupJobs.id });
	return rows.length === 1;
}

async function moveClaimToManualReview(
	db: Database,
	job: CleanupJob,
	now: Date,
	reason: string,
): Promise<boolean> {
	const rows = await db
		.update(externalSubjectCleanupJobs)
		.set({
			status: "manual_review",
			leaseExpiresAt: null,
			lastError: reason.slice(0, 1000),
			updatedAt: now,
		})
		.where(
			and(
				eq(externalSubjectCleanupJobs.id, job.id),
				eq(externalSubjectCleanupJobs.status, "processing"),
				eq(externalSubjectCleanupJobs.leaseToken, job.leaseToken),
			),
		)
		.returning({ id: externalSubjectCleanupJobs.id });
	return rows.length === 1;
}

async function checkpointJob(
	db: Database,
	job: CleanupJob,
	cursor: string,
	now: Date,
): Promise<boolean> {
	const rows = await db
		.update(externalSubjectCleanupJobs)
		.set({
			status: "pending",
			cursor,
			leaseExpiresAt: null,
			nextAttemptAt: now,
			lastError: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(externalSubjectCleanupJobs.id, job.id),
				eq(externalSubjectCleanupJobs.status, "processing"),
				eq(externalSubjectCleanupJobs.leaseToken, job.leaseToken),
			),
		)
		.returning({ id: externalSubjectCleanupJobs.id });
	return rows.length === 1;
}

async function failJob(
	db: Database,
	job: CleanupJob,
	now: Date,
): Promise<boolean> {
	const manualReview = now.getTime() >= job.deadlineAt.getTime();
	const rows = await db
		.update(externalSubjectCleanupJobs)
		.set({
			status: manualReview ? "manual_review" : "pending",
			leaseExpiresAt: null,
			nextAttemptAt: manualReview ? job.nextAttemptAt : retryAt(job, now),
			lastError: "external_store_operation_failed",
			updatedAt: now,
		})
		.where(
			and(
				eq(externalSubjectCleanupJobs.id, job.id),
				eq(externalSubjectCleanupJobs.status, "processing"),
				eq(externalSubjectCleanupJobs.leaseToken, job.leaseToken),
			),
		)
		.returning({ id: externalSubjectCleanupJobs.id });
	return rows.length === 1;
}

async function processClaimedJob(
	db: Database,
	env: Env,
	job: CleanupJob,
	now: Date,
): Promise<"completed" | "checkpointed" | "manual_review" | "failed"> {
	try {
		if (job.operation === "delete_short_link") {
			const outcome = await processShortLinkJob(env, job);
			if (outcome.kind === "deleted" || outcome.kind === "neutralized") {
				return (await completeJob(db, job, now)) ? "completed" : "failed";
			}
			const reason =
				outcome.kind === "unsupported"
					? `short_link_cleanup_unsupported:${outcome.reason}`
					: `short_link_cleanup_unknown:${outcome.reason}`;
			return (await moveClaimToManualReview(db, job, now, reason))
				? "manual_review"
				: "failed";
		}
		const result =
			job.operation === "purge_rescue_subject"
				? await processRescueJob(env, job)
				: await processObjectJob(env, job);
		if (result.complete) {
			return (await completeJob(db, job, now)) ? "completed" : "failed";
		}
		if (!result.cursor) throw new Error("cleanup_cursor_missing");
		return (await checkpointJob(db, job, result.cursor, now))
			? "checkpointed"
			: "failed";
	} catch {
		await failJob(db, job, now);
		console.error("[external-subject-cleanup] external operation failed", {
			job_id: job.id,
			operation: job.operation,
			bucket: job.bucket,
		});
		return "failed";
	}
}

async function moveExpiredJobsToManualReview(
	db: Database,
	limit: number,
	now: Date,
): Promise<number> {
	const rows = (await db.execute(sql`
		WITH ranked AS (
			SELECT candidate.id,
			       candidate.deadline_at,
			       row_number() OVER (
				       PARTITION BY COALESCE(
					       candidate.organization_id,
					       candidate.subject_kind || ':' || candidate.subject_id
				       )
				       ORDER BY candidate.deadline_at, candidate.id
			       ) AS tenant_rank
			  FROM external_subject_cleanup_jobs AS candidate
			 WHERE candidate.status IN ('pending', 'processing')
			   AND candidate.deadline_at <= ${now}
		),
		expired AS (
			SELECT job.id
			  FROM external_subject_cleanup_jobs AS job
			  JOIN ranked ON ranked.id = job.id
			 WHERE ranked.tenant_rank <= ${EXTERNAL_SUBJECT_CLEANUP_TENANT_CAP}
			 ORDER BY ranked.tenant_rank, ranked.deadline_at, job.id
			 LIMIT ${limit}
			 FOR UPDATE OF job SKIP LOCKED
		)
		UPDATE external_subject_cleanup_jobs AS job
		   SET status = 'manual_review',
		       lease_token = lease_token + 1,
		       lease_expires_at = NULL,
		       completed_at = NULL,
		       purge_at = NULL,
		       last_error = 'automatic_cleanup_deadline_exceeded',
		       updated_at = ${now}
		  FROM expired
		 WHERE job.id = expired.id
		RETURNING job.id
	`)) as unknown as Array<{ id: string }>;
	return rows.length;
}

async function claimCleanupJobs(
	db: Database,
	limit: number,
	now: Date,
): Promise<CleanupJob[]> {
	return (await db.execute(sql`
		WITH ranked AS (
			SELECT candidate.id,
			       candidate.next_attempt_at,
			       row_number() OVER (
				       PARTITION BY COALESCE(
					       candidate.organization_id,
					       candidate.subject_kind || ':' || candidate.subject_id
				       )
				       ORDER BY candidate.next_attempt_at, candidate.id
			       ) AS tenant_rank
			  FROM external_subject_cleanup_jobs AS candidate
			 WHERE candidate.deadline_at > ${now}
			   AND (
					(candidate.status = 'pending'
					 AND candidate.next_attempt_at <= ${now})
					OR (candidate.status = 'processing'
						AND candidate.lease_expires_at <= ${now})
			   )
		),
		due AS (
			SELECT job.id
			  FROM external_subject_cleanup_jobs AS job
			  JOIN ranked ON ranked.id = job.id
			 WHERE ranked.tenant_rank <= ${EXTERNAL_SUBJECT_CLEANUP_TENANT_CAP}
			 ORDER BY ranked.tenant_rank, ranked.next_attempt_at, job.id
			 LIMIT ${limit}
			 FOR UPDATE OF job SKIP LOCKED
		)
		UPDATE external_subject_cleanup_jobs AS job
		   SET status = 'processing',
		       attempts = attempts + 1,
		       lease_token = lease_token + 1,
		       lease_expires_at =
		         ${new Date(now.getTime() + EXTERNAL_SUBJECT_CLEANUP_LEASE_MS)},
		       updated_at = ${now}
		  FROM due
		 WHERE job.id = due.id
		RETURNING job.*
	`)) as unknown as CleanupJob[];
}

async function pruneCompletedCleanupJobs(
	db: Database,
	limit: number,
	now: Date,
): Promise<number> {
	const rows = (await db.execute(sql`
		WITH due AS (
			SELECT id
			  FROM external_subject_cleanup_jobs
			 WHERE status = 'completed'
			   AND purge_at <= ${now}
			 ORDER BY purge_at ASC, id ASC
			 LIMIT ${limit}
			 FOR UPDATE SKIP LOCKED
		)
		DELETE FROM external_subject_cleanup_jobs AS job
		      USING due
		      WHERE job.id = due.id
		RETURNING job.id
	`)) as unknown as Array<{ id: string }>;
	return rows.length;
}

/**
 * Bounded at-least-once external cleanup reconciler. R2 exact/prefix deletes
 * and Queue-rescue subject purges are idempotent; the lease token only accepts
 * the state transition belonging to the current claim.
 */
export async function processExternalSubjectCleanupJobs(
	env: Env,
	requestedLimit = EXTERNAL_SUBJECT_CLEANUP_BATCH_SIZE,
	now = new Date(),
): Promise<{
	claimed: number;
	completed: number;
	checkpointed: number;
	failed: number;
	manualReview: number;
	pruned: number;
}> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), 100);
	const expiredManualReview = await moveExpiredJobsToManualReview(
		db,
		limit,
		now,
	);
	const claimed = await claimCleanupJobs(db, limit, now);
	const outcomes = await Promise.all(
		claimed.map((job) => processClaimedJob(db, env, job, now)),
	);
	const pruned = await pruneCompletedCleanupJobs(db, limit, now);
	return {
		claimed: claimed.length,
		completed: outcomes.filter((outcome) => outcome === "completed").length,
		checkpointed: outcomes.filter((outcome) => outcome === "checkpointed")
			.length,
		failed: outcomes.filter((outcome) => outcome === "failed").length,
		manualReview:
			expiredManualReview +
			outcomes.filter((outcome) => outcome === "manual_review").length,
		pruned,
	};
}
