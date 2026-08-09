import {
	accountRevocationJobs,
	assertKvPrivacyStoreKey,
	createDb,
	externalPosts,
	media,
	shortLinkCredentials,
	shortLinks,
	socialAccounts,
	whatsappPhoneNumbers,
	whatsappPhoneProvisioningOperations,
	whatsappPhoneReleaseOperations,
	workspaceErasureJobs,
	workspaceErasureSteps,
	workspaces,
	workspaceTombstones,
} from "@relayapi/db";
import {
	and,
	count,
	eq,
	gt,
	inArray,
	isNull,
	lte,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { buildAccountCacheKeys } from "../lib/delete-account";
import { purgePresignedViewCache } from "../lib/r2-presign";
import { thumbnailKeyFor, thumbnailStorageTarget } from "../lib/thumbnails";
import { deleteQueueRescueSubjectPage } from "../queues/queue-rescue";
import type { Env } from "../types";
import { externalPreviewStorageKey } from "./external-post-sync/previews";
import { enqueueShortLinkProviderCleanup } from "./external-subject-cleanup";
import { stagePhoneRelease } from "./phone-number-operations";
import { findActiveErasureHold } from "./privacy-retention-policy";
import { pruneOrphanedShortLinkCredentials } from "./short-link-configuration";
import type { ProviderRef } from "./short-link-providers";
import { invalidateRelayApiShortLinkCaches } from "./short-link-providers/relayapi";
import {
	deleteStoredObject,
	storageLocatorForMedia,
	storageLocatorForThumbnailObject,
} from "./storage-locator";

const JOB_LEASE_MS = 10 * 60_000;
const WAIT_MS = 60_000;
const MAX_JOBS_PER_TICK = 5;
const MAX_WORK_UNITS_PER_JOB = 8;
const DELETE_BATCH_SIZE = 100;
const EXTERNAL_BATCH_SIZE = 25;
const ACCOUNT_ARTIFACT_BATCH_SIZE = 100;

export const WORKSPACE_ERASURE_STEP_KEYS = [
	"lifecycle_fenced",
	"revoke_external_resources",
	"purge_scoped_data",
	"write_tombstone",
] as const;

/**
 * Workspace-located tombstones that must outlive the workspace row. Deleting
 * one in the generic table sweep would abandon the external deletion intent
 * that makes database erasure truthful.
 */
export const WORKSPACE_ERASURE_SURVIVOR_TABLES = [
	"external_subject_cleanup_jobs",
] as const;

/**
 * Every table that directly carries workspace_id, in child-before-parent order.
 * The erasure processor deletes these rows explicitly before deleting the
 * workspace. This is deliberately not inferred at runtime: changing the schema
 * must update this reviewed ownership inventory and its contract test.
 */
export const WORKSPACE_PURGE_TABLES = [
	"ad_audiences",
	"ad_creation_operations",
	"ads",
	"ad_campaigns",
	"ad_accounts",
	"ai_agents",
	"ai_knowledge_bases",
	"auto_post_rules",
	"automation_bindings",
	"broadcasts",
	"content_templates",
	"custom_field_definitions",
	"external_posts",
	"invite_token_workspaces",
	"idea_media",
	"ideas",
	"idea_groups",
	"inbox_conversations",
	"contacts",
	"ref_urls",
	"landing_pages",
	"media",
	"automations",
	"segments",
	"short_links",
	"posts",
	"principal_workspace_grants",
	"signatures",
	"telegram_connection_challenges",
	"social_accounts",
	"subscription_lists",
	"tags",
	"thread_executions",
	"post_threads",
	"webhook_endpoints",
	"webhook_events",
] as const;

type WorkspaceStepKey = (typeof WORKSPACE_ERASURE_STEP_KEYS)[number];
type WorkspaceJob = typeof workspaceErasureJobs.$inferSelect;
type WorkspaceStep = typeof workspaceErasureSteps.$inferSelect;
type ErasureDb = ReturnType<typeof createDb>;

type StepResult =
	| {
			kind: "completed";
			rowsDeleted?: number;
	  }
	| {
			kind: "pending";
			cursor?: Record<string, unknown> | null;
			rowsDeleted?: number;
			delayMs?: number;
			reason?: string;
	  }
	| { kind: "manual_review"; reason: string };

interface PurgeCursor {
	phase?:
		| "account_dependents"
		| "workspace_media"
		| "queue_rescue"
		| "shared_receipts"
		| "consent_authority"
		| "tables";
	table_index?: number;
	dependent_index?: number;
	r2_cursor?: string;
}

async function minimizeWorkspaceSharedReceipts(
	db: ErasureDb,
	job: WorkspaceJob,
): Promise<number> {
	const rows = await db.execute<{ id: string }>(sql`
		WITH candidates AS (
			SELECT failure.id
			  FROM public.queue_failures AS failure
			 WHERE failure.organization_ids @> ARRAY[${job.organizationId}]::text[]
			   AND failure.workspace_ids @> ARRAY[${job.workspaceId}]::text[]
			 ORDER BY failure.id
			 LIMIT ${DELETE_BATCH_SIZE}
			 FOR UPDATE OF failure SKIP LOCKED
		)
		UPDATE public.queue_failures AS failure
		   SET workspace_ids = array_remove(failure.workspace_ids, ${job.workspaceId}),
		       payload_ciphertext = NULL,
		       payload_key_id = NULL,
		       payload_redacted_at = COALESCE(failure.payload_redacted_at, NOW()),
		       user_ids = ARRAY[]::text[],
		       contact_ids = ARRAY[]::text[],
		       account_ids = ARRAY[]::text[],
		       status = CASE
		           WHEN failure.status IN ('replayed', 'dismissed')
		             THEN failure.status
		           ELSE 'dismissed'
		       END,
		       resolved_at = CASE
		           WHEN failure.status IN ('replayed', 'dismissed')
		             THEN failure.resolved_at
		           ELSE COALESCE(failure.resolved_at, NOW())
		       END,
		       replay_claim_token = NULL,
		       replay_claim_expires_at = NULL,
		       error = 'workspace_erased'
		  FROM candidates
		 WHERE failure.id = candidates.id
		RETURNING failure.id
	`);
	return rows.length;
}

interface RevokeCursor {
	account_after?: string;
}

function parseCursor<T extends object>(value: unknown): Partial<T> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Partial<T>)
		: {};
}

function retryDelay(attempts: number): number {
	return Math.min(86_400_000, 2 ** Math.min(attempts, 10) * 60_000);
}

async function ensureWorkspaceErasureSteps(
	db: ErasureDb,
	job: WorkspaceJob,
): Promise<void> {
	await db
		.insert(workspaceErasureSteps)
		.values(
			WORKSPACE_ERASURE_STEP_KEYS.map((stepKey) => ({
				workspaceId: job.workspaceId,
				organizationId: job.organizationId,
				stepKey,
				...(stepKey === "lifecycle_fenced"
					? { status: "completed" as const, completedAt: job.requestedAt }
					: {}),
			})),
		)
		.onConflictDoNothing({
			target: [
				workspaceErasureSteps.workspaceId,
				workspaceErasureSteps.stepKey,
			],
		});
}

async function claimWorkspaceStep(
	db: ErasureDb,
	job: WorkspaceJob,
	stepKey: WorkspaceStepKey,
): Promise<WorkspaceStep | null> {
	const now = new Date();
	const [step] = await db
		.update(workspaceErasureSteps)
		.set({
			status: "processing",
			attempts: sql`${workspaceErasureSteps.attempts} + 1`,
			leaseToken: sql`${workspaceErasureSteps.leaseToken} + 1`,
			leaseExpiresAt: new Date(now.getTime() + JOB_LEASE_MS),
			lastError: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(workspaceErasureSteps.workspaceId, job.workspaceId),
				eq(workspaceErasureSteps.organizationId, job.organizationId),
				eq(workspaceErasureSteps.stepKey, stepKey),
				lte(workspaceErasureSteps.nextAttemptAt, now),
				or(
					inArray(workspaceErasureSteps.status, ["pending", "failed"]),
					and(
						eq(workspaceErasureSteps.status, "processing"),
						lte(workspaceErasureSteps.leaseExpiresAt, now),
					),
				),
			),
		)
		.returning();
	return step ?? null;
}

async function persistWorkspaceStepResult(
	db: ErasureDb,
	job: WorkspaceJob,
	step: WorkspaceStep,
	result: StepResult,
): Promise<boolean> {
	const now = new Date();
	const rowsDeleted = "rowsDeleted" in result ? (result.rowsDeleted ?? 0) : 0;
	const commonWhere = and(
		eq(workspaceErasureSteps.id, step.id),
		eq(workspaceErasureSteps.status, "processing"),
		eq(workspaceErasureSteps.leaseToken, step.leaseToken),
	);

	if (result.kind === "completed") {
		const updated = await db
			.update(workspaceErasureSteps)
			.set({
				status: "completed",
				cursor: null,
				rowsDeleted: sql`${workspaceErasureSteps.rowsDeleted} + ${rowsDeleted}`,
				leaseExpiresAt: null,
				lastError: null,
				completedAt: now,
				updatedAt: now,
			})
			.where(commonWhere)
			.returning({ id: workspaceErasureSteps.id });
		return updated.length === 1;
	}

	if (result.kind === "manual_review") {
		await db.transaction(async (tx) => {
			await tx
				.update(workspaceErasureSteps)
				.set({
					status: "manual_review",
					leaseExpiresAt: null,
					lastError: result.reason,
					updatedAt: now,
				})
				.where(commonWhere);
			await tx
				.update(workspaceErasureJobs)
				.set({
					status: "manual_review",
					leaseExpiresAt: null,
					lastError: result.reason,
					updatedAt: now,
				})
				.where(
					and(
						eq(workspaceErasureJobs.workspaceId, job.workspaceId),
						eq(workspaceErasureJobs.status, "processing"),
						eq(workspaceErasureJobs.leaseToken, job.leaseToken),
					),
				);
		});
		return true;
	}

	const nextAttemptAt = new Date(now.getTime() + (result.delayMs ?? 0));
	const updated = await db
		.update(workspaceErasureSteps)
		.set({
			status: "pending",
			cursor: result.cursor ?? step.cursor,
			rowsDeleted: sql`${workspaceErasureSteps.rowsDeleted} + ${rowsDeleted}`,
			leaseExpiresAt: null,
			nextAttemptAt,
			lastError: result.reason ?? null,
			updatedAt: now,
		})
		.where(commonWhere)
		.returning({ id: workspaceErasureSteps.id });
	return updated.length === 1;
}

async function stageWorkspaceAccountRevocations(
	db: ErasureDb,
	organizationId: string,
	workspaceId: string,
): Promise<number> {
	return db.transaction(async (tx) => {
		const unstaged = await tx
			.select({
				id: socialAccounts.id,
				platform: socialAccounts.platform,
				accessToken: socialAccounts.accessToken,
				refreshToken: socialAccounts.refreshToken,
				tokenVersion: socialAccounts.tokenVersion,
			})
			.from(socialAccounts)
			.where(
				and(
					eq(socialAccounts.organizationId, organizationId),
					eq(socialAccounts.workspaceId, workspaceId),
					ne(socialAccounts.lifecycleStatus, "disconnected"),
				),
			)
			.orderBy(socialAccounts.id)
			.limit(EXTERNAL_BATCH_SIZE)
			.for("update");
		if (unstaged.length === 0) return 0;

		const now = new Date();
		await tx
			.insert(accountRevocationJobs)
			.values(
				unstaged.map((account) => ({
					accountId: account.id,
					organizationId,
					platform: account.platform,
					accessTokenCiphertext: account.accessToken,
					refreshTokenCiphertext: account.refreshToken,
					sourceTokenVersion: account.tokenVersion,
					status: "pending" as const,
					nextAttemptAt: now,
				})),
			)
			.onConflictDoUpdate({
				target: accountRevocationJobs.accountId,
				set: {
					accessTokenCiphertext: sql`excluded.access_token_ciphertext`,
					refreshTokenCiphertext: sql`excluded.refresh_token_ciphertext`,
					sourceTokenVersion: sql`excluded.source_token_version`,
					status: "pending",
					attempts: 0,
					leaseToken: 0,
					nextAttemptAt: now,
					leaseExpiresAt: null,
					requestMayHaveBeenSentAt: null,
					lastError: null,
					providerResponse: null,
					completedAt: null,
					updatedAt: now,
				},
			});
		await tx
			.update(socialAccounts)
			.set({
				lifecycleStatus: "disconnected",
				accessToken: null,
				refreshToken: null,
				metadata: sql`${socialAccounts.metadata} - 'meta_ads_user_access_token' - 'meta_ads_user_access_token_expires_at' - 'facebook_user_id'`,
				disconnectRequestedAt: now,
				disconnectReason: "workspace_deleted",
				tokenExpiresAt: null,
				disconnectedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(socialAccounts.organizationId, organizationId),
					eq(socialAccounts.workspaceId, workspaceId),
					inArray(
						socialAccounts.id,
						unstaged.map((account) => account.id),
					),
					ne(socialAccounts.lifecycleStatus, "disconnected"),
				),
			);
		return unstaged.length;
	});
}

async function stageWorkspacePhoneReleaseBatch(
	db: ErasureDb,
	organizationId: string,
	workspaceId: string,
): Promise<number> {
	const rows = await db
		.select({ id: whatsappPhoneNumbers.id })
		.from(whatsappPhoneNumbers)
		.innerJoin(
			whatsappPhoneProvisioningOperations,
			and(
				eq(
					whatsappPhoneProvisioningOperations.phoneNumberId,
					whatsappPhoneNumbers.id,
				),
				eq(whatsappPhoneProvisioningOperations.organizationId, organizationId),
			),
		)
		.innerJoin(
			socialAccounts,
			and(
				eq(
					socialAccounts.id,
					whatsappPhoneProvisioningOperations.provisioningSourceAccountId,
				),
				eq(socialAccounts.organizationId, organizationId),
			),
		)
		.leftJoin(
			whatsappPhoneReleaseOperations,
			eq(whatsappPhoneReleaseOperations.phoneNumberId, whatsappPhoneNumbers.id),
		)
		.where(
			and(
				eq(whatsappPhoneNumbers.organizationId, organizationId),
				eq(socialAccounts.workspaceId, workspaceId),
				ne(whatsappPhoneNumbers.status, "released"),
				or(
					isNull(whatsappPhoneReleaseOperations.releaseOperationId),
					and(
						eq(whatsappPhoneReleaseOperations.releaseReason, "user_requested"),
						ne(whatsappPhoneReleaseOperations.releaseState, "completed"),
					),
				),
			),
		)
		.orderBy(whatsappPhoneNumbers.id)
		.limit(EXTERNAL_BATCH_SIZE);
	for (const row of rows) {
		// The provider ledger currently has one deletion reason for tenant-owned
		// resources. The workspace job and exact source account preserve the
		// narrower ownership boundary.
		await stagePhoneRelease(db, organizationId, row.id, "tenant_deleted");
	}
	return rows.length;
}

async function getWorkspaceExternalState(
	db: ErasureDb,
	organizationId: string,
	workspaceId: string,
): Promise<{
	accountIncomplete: number;
	accountManual: number;
	phoneIncomplete: number;
	phoneManual: number;
}> {
	const [accountIncomplete, accountManual, phoneIncomplete, phoneManual] =
		await Promise.all([
			db
				.select({ value: count() })
				.from(accountRevocationJobs)
				.innerJoin(
					socialAccounts,
					eq(socialAccounts.id, accountRevocationJobs.accountId),
				)
				.where(
					and(
						eq(socialAccounts.organizationId, organizationId),
						eq(socialAccounts.workspaceId, workspaceId),
						ne(accountRevocationJobs.status, "succeeded"),
					),
				),
			db
				.select({ value: count() })
				.from(accountRevocationJobs)
				.innerJoin(
					socialAccounts,
					eq(socialAccounts.id, accountRevocationJobs.accountId),
				)
				.where(
					and(
						eq(socialAccounts.organizationId, organizationId),
						eq(socialAccounts.workspaceId, workspaceId),
						eq(accountRevocationJobs.status, "manual_required"),
					),
				),
			db
				.select({ value: count() })
				.from(whatsappPhoneNumbers)
				.innerJoin(
					whatsappPhoneProvisioningOperations,
					eq(
						whatsappPhoneProvisioningOperations.phoneNumberId,
						whatsappPhoneNumbers.id,
					),
				)
				.innerJoin(
					socialAccounts,
					and(
						eq(
							socialAccounts.id,
							whatsappPhoneProvisioningOperations.provisioningSourceAccountId,
						),
						eq(socialAccounts.organizationId, organizationId),
					),
				)
				.where(
					and(
						eq(whatsappPhoneNumbers.organizationId, organizationId),
						eq(socialAccounts.workspaceId, workspaceId),
						ne(whatsappPhoneNumbers.status, "released"),
					),
				),
			db
				.select({ value: count() })
				.from(whatsappPhoneNumbers)
				.innerJoin(
					whatsappPhoneProvisioningOperations,
					eq(
						whatsappPhoneProvisioningOperations.phoneNumberId,
						whatsappPhoneNumbers.id,
					),
				)
				.innerJoin(
					socialAccounts,
					and(
						eq(
							socialAccounts.id,
							whatsappPhoneProvisioningOperations.provisioningSourceAccountId,
						),
						eq(socialAccounts.organizationId, organizationId),
					),
				)
				.innerJoin(
					whatsappPhoneReleaseOperations,
					eq(
						whatsappPhoneReleaseOperations.phoneNumberId,
						whatsappPhoneNumbers.id,
					),
				)
				.where(
					and(
						eq(whatsappPhoneNumbers.organizationId, organizationId),
						eq(socialAccounts.workspaceId, workspaceId),
						or(
							eq(whatsappPhoneReleaseOperations.releaseState, "manual_review"),
							eq(whatsappPhoneReleaseOperations.releaseState, "unknown"),
						),
					),
				),
		]);
	return {
		accountIncomplete: accountIncomplete[0]?.value ?? 0,
		accountManual: accountManual[0]?.value ?? 0,
		phoneIncomplete: phoneIncomplete[0]?.value ?? 0,
		phoneManual: phoneManual[0]?.value ?? 0,
	};
}

async function deleteReleasedWorkspacePhones(
	db: ErasureDb,
	organizationId: string,
	workspaceId: string,
): Promise<number> {
	const rows = await db
		.select({ id: whatsappPhoneNumbers.id })
		.from(whatsappPhoneNumbers)
		.innerJoin(
			whatsappPhoneProvisioningOperations,
			eq(
				whatsappPhoneProvisioningOperations.phoneNumberId,
				whatsappPhoneNumbers.id,
			),
		)
		.innerJoin(
			socialAccounts,
			and(
				eq(
					socialAccounts.id,
					whatsappPhoneProvisioningOperations.provisioningSourceAccountId,
				),
				eq(socialAccounts.organizationId, organizationId),
			),
		)
		.where(
			and(
				eq(whatsappPhoneNumbers.organizationId, organizationId),
				eq(socialAccounts.workspaceId, workspaceId),
				eq(whatsappPhoneNumbers.status, "released"),
			),
		)
		.orderBy(whatsappPhoneNumbers.id)
		.limit(EXTERNAL_BATCH_SIZE);
	if (rows.length > 0) {
		await db.delete(whatsappPhoneNumbers).where(
			inArray(
				whatsappPhoneNumbers.id,
				rows.map((row) => row.id),
			),
		);
	}
	return rows.length;
}

async function processWorkspaceExternalResources(
	db: ErasureDb,
	env: Env,
	job: WorkspaceJob,
	step: WorkspaceStep,
): Promise<StepResult> {
	// Capture every phone's exact release credential before account revocation
	// shreds the source account ciphertext. Returning after each phone batch also
	// keeps this ordering correct if the configured batch size is ever lower than
	// the number of workspace-owned phones.
	const stagedPhones = await stageWorkspacePhoneReleaseBatch(
		db,
		job.organizationId,
		job.workspaceId,
	);
	if (stagedPhones > 0) {
		return {
			kind: "pending",
			reason: "Phone release work was durably staged before account revocation",
		};
	}
	const stagedAccounts = await stageWorkspaceAccountRevocations(
		db,
		job.organizationId,
		job.workspaceId,
	);
	if (stagedAccounts > 0) {
		return {
			kind: "pending",
			reason: "External account revocation work was durably staged",
		};
	}

	const state = await getWorkspaceExternalState(
		db,
		job.organizationId,
		job.workspaceId,
	);
	if (state.accountManual > 0 || state.phoneManual > 0) {
		return {
			kind: "manual_review",
			reason: `Workspace external cleanup requires manual review (accounts=${state.accountManual}, phones=${state.phoneManual})`,
		};
	}
	if (state.accountIncomplete > 0 || state.phoneIncomplete > 0) {
		return {
			kind: "pending",
			delayMs: WAIT_MS,
			reason: `Waiting for workspace external cleanup (accounts=${state.accountIncomplete}, phones=${state.phoneIncomplete})`,
		};
	}

	const deletedPhones = await deleteReleasedWorkspacePhones(
		db,
		job.organizationId,
		job.workspaceId,
	);
	if (deletedPhones > 0) {
		return { kind: "pending", rowsDeleted: deletedPhones };
	}

	const cursor = parseCursor<RevokeCursor>(step.cursor);
	const accounts = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			platformAccountId: socialAccounts.platformAccountId,
			webhookAccountId: socialAccounts.webhookAccountId,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.organizationId, job.organizationId),
				eq(socialAccounts.workspaceId, job.workspaceId),
				...(cursor.account_after
					? [gt(socialAccounts.id, cursor.account_after)]
					: []),
			),
		)
		.orderBy(socialAccounts.id)
		.limit(ACCOUNT_ARTIFACT_BATCH_SIZE);
	if (accounts.length === 0) return { kind: "completed" };

	await Promise.all([
		env.AVATAR_BUCKET.delete(
			accounts.map(
				(account) => `account/${encodeURIComponent(account.id)}/avatar`,
			),
		),
		env.MEDIA_BUCKET.delete(
			accounts.map(
				(account) => `account/${encodeURIComponent(account.id)}/avatar`,
			),
		),
		...accounts.flatMap((account) =>
			buildAccountCacheKeys({
				accountId: account.id,
				platform: account.platform,
				platformAccountId: account.platformAccountId,
				webhookAccountId: account.webhookAccountId,
			}).map((key) =>
				env.KV.delete(
					assertKvPrivacyStoreKey(
						[
							"kv:platform-account",
							"kv:ig-sender-id",
							"kv:sync-dedup",
							"kv:inbox-posts",
						],
						key,
					),
				),
			),
		),
	]);
	return {
		kind: "pending",
		cursor: { account_after: accounts.at(-1)?.id },
	};
}

async function deleteAccountDependentBatch(
	db: ErasureDb,
	job: WorkspaceJob,
	table: "connection_logs",
): Promise<number> {
	const accountColumn = "social_account_id";
	const rows = await db.execute<{ deleted: number }>(sql`
		WITH candidates AS (
			SELECT child.ctid
			FROM public.${sql.identifier(table)} AS child
			INNER JOIN public.social_accounts AS account
				ON account.id = child.${sql.identifier(accountColumn)}
			WHERE account.organization_id = ${job.organizationId}
			  AND account.workspace_id = ${job.workspaceId}
			ORDER BY child.ctid
			LIMIT ${DELETE_BATCH_SIZE}
			FOR UPDATE OF child SKIP LOCKED
		)
		DELETE FROM public.${sql.identifier(table)} AS child
		USING candidates
		WHERE child.ctid = candidates.ctid
		RETURNING 1 AS deleted
	`);
	return rows.length;
}

async function deleteMediaBatch(
	db: ErasureDb,
	env: Env,
	job: WorkspaceJob,
): Promise<number> {
	const rows = await db
		.select({
			id: media.id,
			storageProvider: media.storageProvider,
			storageBucketLocator: media.storageBucketLocator,
			storageRegion: media.storageRegion,
			storageLocationId: media.storageLocationId,
			storageCredentialVersion: media.storageCredentialVersion,
			storageKey: media.storageKey,
			thumbnailKey: media.thumbnailKey,
			thumbnailStorageProvider: media.thumbnailStorageProvider,
			thumbnailStorageBucketLocator: media.thumbnailStorageBucketLocator,
			thumbnailStorageRegion: media.thumbnailStorageRegion,
		})
		.from(media)
		.where(
			and(
				eq(media.organizationId, job.organizationId),
				eq(media.workspaceId, job.workspaceId),
			),
		)
		.orderBy(media.id)
		.limit(DELETE_BATCH_SIZE);
	if (rows.length === 0) return 0;

	const currentThumbnailTarget = thumbnailStorageTarget(env);
	await Promise.all([
		...rows.map((row) =>
			deleteStoredObject(
				db,
				env,
				storageLocatorForMedia({
					...row,
					organizationId: job.organizationId,
				}),
			),
		),
		...rows.map((row) =>
			deleteStoredObject(
				db,
				env,
				storageLocatorForThumbnailObject({
					organizationId: job.organizationId,
					thumbnailKey: row.thumbnailKey ?? thumbnailKeyFor(row.storageKey),
					thumbnailStorageProvider:
						row.thumbnailStorageProvider ?? currentThumbnailTarget.provider,
					thumbnailStorageBucketLocator:
						row.thumbnailStorageBucketLocator ?? currentThumbnailTarget.bucket,
					thumbnailStorageRegion:
						row.thumbnailStorageRegion ?? currentThumbnailTarget.region,
				}),
			),
		),
		...rows.map(({ storageKey, storageBucketLocator }) =>
			purgePresignedViewCache(
				env,
				storageKey,
				undefined,
				storageBucketLocator,
			),
		),
	]);
	await db.delete(media).where(
		inArray(
			media.id,
			rows.map(({ id }) => id),
		),
	);
	return rows.length;
}

async function deleteExternalPostsBatch(
	db: ErasureDb,
	env: Env,
	job: WorkspaceJob,
): Promise<number> {
	const rows = await db
		.select({
			id: externalPosts.id,
			previewThumbnailKey: externalPosts.previewThumbnailKey,
			previewStorageProvider: externalPosts.previewStorageProvider,
			previewStorageBucketLocator: externalPosts.previewStorageBucketLocator,
			previewStorageRegion: externalPosts.previewStorageRegion,
		})
		.from(externalPosts)
		.where(
			and(
				eq(externalPosts.organizationId, job.organizationId),
				eq(externalPosts.workspaceId, job.workspaceId),
			),
		)
		.orderBy(externalPosts.id)
		.limit(DELETE_BATCH_SIZE);
	if (rows.length === 0) return 0;

	const currentThumbnailTarget = thumbnailStorageTarget(env);
	await Promise.all(
		rows.map((row) =>
			deleteStoredObject(
				db,
				env,
				storageLocatorForThumbnailObject({
					organizationId: job.organizationId,
					thumbnailKey:
						row.previewThumbnailKey ??
						thumbnailKeyFor(
							externalPreviewStorageKey(job.organizationId, row.id),
						),
					thumbnailStorageProvider:
						row.previewStorageProvider ?? currentThumbnailTarget.provider,
					thumbnailStorageBucketLocator:
						row.previewStorageBucketLocator ?? currentThumbnailTarget.bucket,
					thumbnailStorageRegion:
						row.previewStorageRegion ?? currentThumbnailTarget.region,
				}),
			),
		),
	);
	await db.delete(externalPosts).where(
		and(
			eq(externalPosts.organizationId, job.organizationId),
			inArray(
				externalPosts.id,
				rows.map(({ id }) => id),
			),
		),
	);
	return rows.length;
}

async function deleteWorkspaceShortLinksBatch(
	db: ErasureDb,
	env: Env,
	job: WorkspaceJob,
): Promise<number> {
	const deleted = await db.transaction(async (tx) => {
		const candidates = await tx
			.select({
				id: shortLinks.id,
				provider: shortLinks.provider,
				providerRef: shortLinks.providerRef,
				shortCode: shortLinks.shortCode,
				credentialCiphertext: shortLinkCredentials.apiKeyCiphertext,
			})
			.from(shortLinks)
			.leftJoin(
				shortLinkCredentials,
				and(
					eq(shortLinkCredentials.organizationId, shortLinks.organizationId),
					eq(shortLinkCredentials.provider, shortLinks.provider),
					eq(shortLinkCredentials.version, shortLinks.credentialVersion),
				),
			)
			.where(
				and(
					eq(shortLinks.organizationId, job.organizationId),
					eq(shortLinks.workspaceId, job.workspaceId),
				),
			)
			.orderBy(shortLinks.id)
			.limit(DELETE_BATCH_SIZE)
			.for("update", { of: shortLinks });
		if (candidates.length === 0) return [];
		for (const candidate of candidates) {
			if (candidate.provider === "relayapi") continue;
			if (!candidate.credentialCiphertext) {
				throw new Error(
					"Historical short-link credential is missing during workspace erasure",
				);
			}
			await enqueueShortLinkProviderCleanup(tx, {
				subjectKind: "workspace",
				subjectId: job.workspaceId,
				organizationId: job.organizationId,
				workspaceId: job.workspaceId,
				provider: candidate.provider,
				providerRef: candidate.providerRef as ProviderRef,
				credentialCiphertext: candidate.credentialCiphertext,
			});
		}
		const removed = await tx
			.delete(shortLinks)
			.where(
				and(
					eq(shortLinks.organizationId, job.organizationId),
					inArray(
						shortLinks.id,
						candidates.map((candidate) => candidate.id),
					),
				),
			)
			.returning({
				provider: shortLinks.provider,
				shortCode: shortLinks.shortCode,
			});
		await pruneOrphanedShortLinkCredentials(tx, job.organizationId);
		return removed;
	});
	await invalidateRelayApiShortLinkCaches(
		env.KV,
		deleted.flatMap((row) =>
			row.provider === "relayapi" && row.shortCode ? [row.shortCode] : [],
		),
	);
	return deleted.length;
}

async function deleteWorkspaceTableBatch(
	db: ErasureDb,
	env: Env,
	job: WorkspaceJob,
	table: (typeof WORKSPACE_PURGE_TABLES)[number],
): Promise<number> {
	if (table === "media") return deleteMediaBatch(db, env, job);
	if (table === "external_posts") {
		return deleteExternalPostsBatch(db, env, job);
	}
	if (table === "short_links") {
		return deleteWorkspaceShortLinksBatch(db, env, job);
	}
	const rows = await db.execute<{ deleted: number }>(sql`
		WITH candidates AS (
			SELECT target.ctid
			FROM public.${sql.identifier(table)} AS target
			WHERE target.organization_id = ${job.organizationId}
			  AND target.workspace_id = ${job.workspaceId}
			ORDER BY target.ctid
			LIMIT ${DELETE_BATCH_SIZE}
			FOR UPDATE OF target SKIP LOCKED
		)
		DELETE FROM public.${sql.identifier(table)} AS target
		USING candidates
		WHERE target.ctid = candidates.ctid
		RETURNING 1 AS deleted
	`);
	return rows.length;
}

/**
 * Workspace erasure removes contact-level evidence without resurrecting sends
 * that the recipient denied. Granted projections can disappear with their
 * workspace; denied projections retain only the organization-scoped logical
 * identity needed for the absolute send veto. Consent events remain as
 * minimized audit evidence and lose all directly identifying payload fields.
 *
 * workspace_id is left in place until the final workspace DELETE applies both
 * SET NULL actions in one statement, keeping the state -> source-event scope
 * identity coherent.
 */
async function minimizeWorkspaceConsentAuthority(
	db: ErasureDb,
	job: WorkspaceJob,
): Promise<{ changed: number; complete: boolean }> {
	return db.transaction(async (tx) => {
		const deletedGrants = await tx.execute<{ id: string }>(sql`
			WITH candidates AS (
				SELECT state.id
				FROM public.contact_consent_states AS state
				WHERE state.organization_id = ${job.organizationId}
				  AND state.workspace_id = ${job.workspaceId}
				  AND state.status = 'granted'
				ORDER BY state.id
				LIMIT ${DELETE_BATCH_SIZE}
				FOR UPDATE SKIP LOCKED
			)
			DELETE FROM public.contact_consent_states AS state
			USING candidates
			WHERE state.id = candidates.id
			RETURNING state.id
		`);
		const minimizedDenials = await tx.execute<{ id: string }>(sql`
			WITH candidates AS (
				SELECT state.id
				FROM public.contact_consent_states AS state
				WHERE state.organization_id = ${job.organizationId}
				  AND state.workspace_id = ${job.workspaceId}
				  AND state.status = 'denied'
				  AND state.source <> 'redacted'
				ORDER BY state.id
				LIMIT ${DELETE_BATCH_SIZE}
				FOR UPDATE SKIP LOCKED
			)
			UPDATE public.contact_consent_states AS state
			SET source = 'redacted',
				updated_at = now()
			FROM candidates
			WHERE state.id = candidates.id
			RETURNING state.id
		`);
		const minimizedEvents = await tx.execute<{ id: string }>(sql`
			WITH candidates AS (
				SELECT event.id
				FROM public.contact_consent_events AS event
				WHERE event.organization_id = ${job.organizationId}
				  AND event.workspace_id = ${job.workspaceId}
				  AND (
					event.contact_id IS NOT NULL
					OR event.identifier_masked IS NOT NULL
					OR event.evidence IS NOT NULL
				  )
				ORDER BY event.id
				LIMIT ${DELETE_BATCH_SIZE}
				FOR UPDATE SKIP LOCKED
			)
			UPDATE public.contact_consent_events AS event
			SET contact_id = NULL,
				identifier_masked = NULL,
				evidence = NULL
			FROM candidates
			WHERE event.id = candidates.id
			RETURNING event.id
		`);
		const counts = [
			deletedGrants.length,
			minimizedDenials.length,
			minimizedEvents.length,
		];
		return {
			changed: counts.reduce((sum, value) => sum + value, 0),
			complete: counts.every((value) => value < DELETE_BATCH_SIZE),
		};
	});
}

async function processWorkspacePurge(
	db: ErasureDb,
	env: Env,
	job: WorkspaceJob,
	step: WorkspaceStep,
): Promise<StepResult> {
	const cursor = parseCursor<PurgeCursor>(step.cursor);
	const phase = cursor.phase ?? "account_dependents";
	if (phase === "account_dependents") {
		const dependents = ["connection_logs"] as const;
		const index = cursor.dependent_index ?? 0;
		const table = dependents[index];
		if (!table) {
			return {
				kind: "pending",
				cursor: { phase: "workspace_media" },
			};
		}
		const deleted = await deleteAccountDependentBatch(db, job, table);
		return {
			kind: "pending",
			rowsDeleted: deleted,
			cursor: {
				phase,
				dependent_index: deleted < DELETE_BATCH_SIZE ? index + 1 : index,
			},
		};
	}

	if (phase === "workspace_media") {
		const page = await env.MEDIA_BUCKET.list({
			prefix: `${encodeURIComponent(job.organizationId)}/workspaces/${encodeURIComponent(job.workspaceId)}/`,
			limit: 500,
			...(cursor.r2_cursor ? { cursor: cursor.r2_cursor } : {}),
		});
		if (page.objects.length > 0) {
			await env.MEDIA_BUCKET.delete(page.objects.map(({ key }) => key));
		}
		return {
			kind: "pending",
			rowsDeleted: page.objects.length,
			cursor: page.truncated
				? { phase, r2_cursor: page.cursor }
				: { phase: "queue_rescue" },
		};
	}

	if (phase === "queue_rescue") {
		const page = await deleteQueueRescueSubjectPage(
			env.QUEUE_RESCUE_BUCKET,
			job.organizationId,
			{ kind: "workspace", id: job.workspaceId },
			{ cursor: cursor.r2_cursor, limit: 500 },
		);
		return {
			kind: "pending",
			rowsDeleted: page.deleted,
			cursor: page.complete
				? { phase: "shared_receipts" }
				: { phase, r2_cursor: page.cursor },
		};
	}

	if (phase === "shared_receipts") {
		const changed = await minimizeWorkspaceSharedReceipts(db, job);
		return {
			kind: "pending",
			rowsDeleted: changed,
			cursor:
				changed < DELETE_BATCH_SIZE
					? { phase: "consent_authority" }
					: { phase },
		};
	}

	if (phase === "consent_authority") {
		const result = await minimizeWorkspaceConsentAuthority(db, job);
		return {
			kind: "pending",
			rowsDeleted: result.changed,
			cursor: result.complete ? { phase: "tables", table_index: 0 } : { phase },
		};
	}

	const index = cursor.table_index ?? 0;
	const table = WORKSPACE_PURGE_TABLES[index];
	if (!table) return { kind: "completed" };
	const deleted = await deleteWorkspaceTableBatch(db, env, job, table);
	return {
		kind: "pending",
		rowsDeleted: deleted,
		cursor: {
			phase: "tables",
			table_index: deleted < DELETE_BATCH_SIZE ? index + 1 : index,
		},
	};
}

async function writeWorkspaceTombstone(
	db: ErasureDb,
	job: WorkspaceJob,
	step: WorkspaceStep,
): Promise<void> {
	await db.transaction(async (tx) => {
		const [ownedJob] = await tx
			.select({
				workspaceId: workspaceErasureJobs.workspaceId,
				organizationId: workspaceErasureJobs.organizationId,
				erasureOperationId: workspaceErasureJobs.erasureOperationId,
			})
			.from(workspaceErasureJobs)
			.where(
				and(
					eq(workspaceErasureJobs.workspaceId, job.workspaceId),
					eq(workspaceErasureJobs.organizationId, job.organizationId),
					eq(workspaceErasureJobs.status, "processing"),
					eq(workspaceErasureJobs.leaseToken, job.leaseToken),
				),
			)
			.for("update")
			.limit(1);
		if (!ownedJob) throw new Error("Workspace erasure lease was lost");

		await tx
			.insert(workspaceTombstones)
			.values({
				workspaceId: job.workspaceId,
				organizationId: job.organizationId,
				erasureOperationId: job.erasureOperationId,
			})
			.onConflictDoNothing({ target: workspaceTombstones.workspaceId });
		const [tombstone] = await tx
			.select()
			.from(workspaceTombstones)
			.where(eq(workspaceTombstones.workspaceId, job.workspaceId))
			.limit(1);
		if (
			!tombstone ||
			tombstone.organizationId !== job.organizationId ||
			tombstone.erasureOperationId !== job.erasureOperationId
		) {
			throw new Error(
				"Workspace tombstone conflicts with this erasure operation",
			);
		}

		await tx
			.delete(workspaces)
			.where(
				and(
					eq(workspaces.id, job.workspaceId),
					eq(workspaces.organizationId, job.organizationId),
					eq(workspaces.lifecycleStatus, "erasing"),
				),
			);

		const completedAt = new Date();
		const completedStep = await tx
			.update(workspaceErasureSteps)
			.set({
				status: "completed",
				cursor: null,
				leaseExpiresAt: null,
				lastError: null,
				completedAt,
				updatedAt: completedAt,
			})
			.where(
				and(
					eq(workspaceErasureSteps.id, step.id),
					eq(workspaceErasureSteps.status, "processing"),
					eq(workspaceErasureSteps.leaseToken, step.leaseToken),
				),
			)
			.returning({ id: workspaceErasureSteps.id });
		if (completedStep.length !== 1) {
			throw new Error("Workspace tombstone step lease was lost");
		}

		const completedJob = await tx
			.update(workspaceErasureJobs)
			.set({
				status: "purged",
				requestedBy: null,
				auditSnapshot: {
					redacted: true,
					erasure_operation_id: job.erasureOperationId,
				},
				leaseExpiresAt: null,
				lastError: null,
				completedAt,
				updatedAt: completedAt,
			})
			.where(
				and(
					eq(workspaceErasureJobs.workspaceId, job.workspaceId),
					eq(workspaceErasureJobs.status, "processing"),
					eq(workspaceErasureJobs.leaseToken, job.leaseToken),
				),
			)
			.returning({ workspaceId: workspaceErasureJobs.workspaceId });
		if (completedJob.length !== 1) {
			throw new Error("Workspace erasure lease was lost during completion");
		}
	});
}

async function processClaimedWorkspaceJob(
	db: ErasureDb,
	env: Env,
	job: WorkspaceJob,
): Promise<void> {
	await ensureWorkspaceErasureSteps(db, job);

	for (let unit = 0; unit < MAX_WORK_UNITS_PER_JOB; unit += 1) {
		// Placement fences the top-level lease and every processing step in the
		// same transaction. This read closes the smaller race where a worker was
		// claimed just before that transaction became visible; no new destructive
		// unit begins after an active hold is observable.
		if (
			await findActiveErasureHold(db, {
				kind: "workspace",
				organizationId: job.organizationId,
				workspaceId: job.workspaceId,
			})
		) {
			return;
		}
		const steps = await db
			.select()
			.from(workspaceErasureSteps)
			.where(
				and(
					eq(workspaceErasureSteps.workspaceId, job.workspaceId),
					eq(workspaceErasureSteps.organizationId, job.organizationId),
				),
			);
		const byKey = new Map(steps.map((step) => [step.stepKey, step]));
		const nextKey = WORKSPACE_ERASURE_STEP_KEYS.find(
			(key) => byKey.get(key)?.status !== "completed",
		);
		if (!nextKey) {
			throw new Error(
				"Workspace erasure completed without a tombstone receipt",
			);
		}
		const current = byKey.get(nextKey);
		if (current?.status === "manual_review") return;

		const step = await claimWorkspaceStep(db, job, nextKey);
		if (!step) break;
		if (nextKey === "write_tombstone") {
			await writeWorkspaceTombstone(db, job, step);
			return;
		}

		let result: StepResult;
		if (nextKey === "lifecycle_fenced") {
			result = { kind: "completed" };
		} else if (nextKey === "revoke_external_resources") {
			result = await processWorkspaceExternalResources(db, env, job, step);
		} else {
			result = await processWorkspacePurge(db, env, job, step);
		}
		const persisted = await persistWorkspaceStepResult(db, job, step, result);
		if (!persisted || result.kind === "manual_review") return;
		if (result.kind === "pending" && (result.delayMs ?? 0) > 0) break;
	}

	const releasedAt = new Date();
	await db
		.update(workspaceErasureJobs)
		.set({
			status: "pending",
			leaseExpiresAt: null,
			nextAttemptAt: releasedAt,
			updatedAt: releasedAt,
		})
		.where(
			and(
				eq(workspaceErasureJobs.workspaceId, job.workspaceId),
				eq(workspaceErasureJobs.status, "processing"),
				eq(workspaceErasureJobs.leaseToken, job.leaseToken),
			),
		);
}

async function failWorkspaceJob(
	db: ErasureDb,
	job: WorkspaceJob,
	error: unknown,
): Promise<void> {
	const attempts = job.attempts + 1;
	const now = new Date();
	const message = error instanceof Error ? error.message : String(error);
	await db.transaction(async (tx) => {
		await tx
			.update(workspaceErasureSteps)
			.set({
				status: "failed",
				leaseExpiresAt: null,
				lastError: message,
				nextAttemptAt: new Date(now.getTime() + retryDelay(attempts)),
				updatedAt: now,
			})
			.where(
				and(
					eq(workspaceErasureSteps.workspaceId, job.workspaceId),
					eq(workspaceErasureSteps.status, "processing"),
				),
			);
		await tx
			.update(workspaceErasureJobs)
			.set({
				status: "failed",
				attempts,
				leaseExpiresAt: null,
				lastError: message,
				nextAttemptAt: new Date(now.getTime() + retryDelay(attempts)),
				updatedAt: now,
			})
			.where(
				and(
					eq(workspaceErasureJobs.workspaceId, job.workspaceId),
					eq(workspaceErasureJobs.status, "processing"),
					eq(workspaceErasureJobs.leaseToken, job.leaseToken),
				),
			);
	});
}

/** Cron/queue-safe bounded workspace erasure reconciler. */
export async function processWorkspaceErasureJobs(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const candidates = await db
		.select({ workspaceId: workspaceErasureJobs.workspaceId })
		.from(workspaceErasureJobs)
		.where(
			and(
				inArray(workspaceErasureJobs.status, [
					"pending",
					"failed",
					"processing",
				]),
				lte(workspaceErasureJobs.nextAttemptAt, now),
				or(
					inArray(workspaceErasureJobs.status, ["pending", "failed"]),
					and(
						eq(workspaceErasureJobs.status, "processing"),
						lte(workspaceErasureJobs.leaseExpiresAt, now),
					),
				),
			),
		)
		.orderBy(
			workspaceErasureJobs.nextAttemptAt,
			workspaceErasureJobs.workspaceId,
		)
		.limit(MAX_JOBS_PER_TICK);

	for (const candidate of candidates) {
		const claimedAt = new Date();
		const [job] = await db
			.update(workspaceErasureJobs)
			.set({
				status: "processing",
				leaseToken: sql`${workspaceErasureJobs.leaseToken} + 1`,
				leaseExpiresAt: new Date(claimedAt.getTime() + JOB_LEASE_MS),
				operatorRetryRequestedAt: null,
				lastError: null,
				updatedAt: claimedAt,
			})
			.where(
				and(
					eq(workspaceErasureJobs.workspaceId, candidate.workspaceId),
					lte(workspaceErasureJobs.nextAttemptAt, claimedAt),
					inArray(workspaceErasureJobs.status, [
						"pending",
						"failed",
						"processing",
					]),
					or(
						inArray(workspaceErasureJobs.status, ["pending", "failed"]),
						and(
							eq(workspaceErasureJobs.status, "processing"),
							lte(workspaceErasureJobs.leaseExpiresAt, claimedAt),
						),
					),
				),
			)
			.returning();
		if (!job) continue;
		try {
			await processClaimedWorkspaceJob(db, env, job);
		} catch (error) {
			await failWorkspaceJob(db, job, error);
		}
	}
}
