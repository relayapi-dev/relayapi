import {
	accountRevocationJobs,
	createDb,
	externalPosts,
	media,
	qrCodes,
	refUrls,
	socialAccounts,
	whatsappPhoneNumbers,
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
import { thumbnailKeyFor } from "../lib/thumbnails";
import type { Env } from "../types";
import { stagePhoneRelease } from "./phone-number-operations";

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
	"contact_consent_states",
	"contact_suppressions",
	"contact_consent_events",
	"content_templates",
	"custom_field_definitions",
	"external_posts",
	"idea_media",
	"idea_tags",
	"ideas",
	"idea_groups",
	"inbox_conversations",
	"contacts",
	"landing_pages",
	"media",
	"ref_urls",
	"automations",
	"segments",
	"short_links",
	"posts",
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
	phase?: "qr_codes" | "account_dependents" | "tables";
	table_index?: number;
	dependent_index?: number;
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
	const unstaged = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			accessToken: socialAccounts.accessToken,
			refreshToken: socialAccounts.refreshToken,
			tokenVersion: socialAccounts.tokenVersion,
		})
		.from(socialAccounts)
		.leftJoin(
			accountRevocationJobs,
			eq(accountRevocationJobs.accountId, socialAccounts.id),
		)
		.where(
			and(
				eq(socialAccounts.organizationId, organizationId),
				eq(socialAccounts.workspaceId, workspaceId),
				ne(socialAccounts.lifecycleStatus, "disconnected"),
				isNull(accountRevocationJobs.id),
			),
		)
		.orderBy(socialAccounts.id)
		.limit(EXTERNAL_BATCH_SIZE);
	if (unstaged.length === 0) return 0;

	const now = new Date();
	await db.transaction(async (tx) => {
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
			.onConflictDoNothing({ target: accountRevocationJobs.accountId });
		await tx
			.update(socialAccounts)
			.set({
				lifecycleStatus: "disconnecting",
				disconnectRequestedAt: now,
				disconnectReason: "workspace_deleted",
				tokenExpiresAt: null,
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
	});
	return unstaged.length;
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
			socialAccounts,
			and(
				eq(socialAccounts.id, whatsappPhoneNumbers.provisioningSourceAccountId),
				eq(socialAccounts.organizationId, organizationId),
			),
		)
		.where(
			and(
				eq(whatsappPhoneNumbers.organizationId, organizationId),
				eq(socialAccounts.workspaceId, workspaceId),
				ne(whatsappPhoneNumbers.status, "released"),
				isNull(whatsappPhoneNumbers.releaseState),
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
					socialAccounts,
					and(
						eq(
							socialAccounts.id,
							whatsappPhoneNumbers.provisioningSourceAccountId,
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
					socialAccounts,
					and(
						eq(
							socialAccounts.id,
							whatsappPhoneNumbers.provisioningSourceAccountId,
						),
						eq(socialAccounts.organizationId, organizationId),
					),
				)
				.where(
					and(
						eq(whatsappPhoneNumbers.organizationId, organizationId),
						eq(socialAccounts.workspaceId, workspaceId),
						or(
							eq(whatsappPhoneNumbers.releaseState, "manual_review"),
							eq(whatsappPhoneNumbers.releaseState, "unknown"),
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
			socialAccounts,
			and(
				eq(socialAccounts.id, whatsappPhoneNumbers.provisioningSourceAccountId),
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
	const stagedAccounts = await stageWorkspaceAccountRevocations(
		db,
		job.organizationId,
		job.workspaceId,
	);
	const stagedPhones = await stageWorkspacePhoneReleaseBatch(
		db,
		job.organizationId,
		job.workspaceId,
	);
	if (stagedAccounts > 0 || stagedPhones > 0) {
		return {
			kind: "pending",
			reason: "External revocation work was durably staged",
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
			accounts.map((account) => `avatars/${account.id}`),
		),
		env.MEDIA_BUCKET.delete(accounts.map((account) => `avatars/${account.id}`)),
		...accounts.flatMap((account) =>
			buildAccountCacheKeys({
				accountId: account.id,
				platform: account.platform,
				platformAccountId: account.platformAccountId,
				webhookAccountId: account.webhookAccountId,
			}).map((key) => env.KV.delete(key)),
		),
	]);
	return {
		kind: "pending",
		cursor: { account_after: accounts.at(-1)?.id },
	};
}

async function deleteQrCodeObjectBatch(
	db: ErasureDb,
	env: Env,
	job: WorkspaceJob,
): Promise<number> {
	const rows = await db
		.select({ id: qrCodes.id, imageR2Key: qrCodes.imageR2Key })
		.from(qrCodes)
		.innerJoin(refUrls, eq(refUrls.id, qrCodes.refUrlId))
		.where(
			and(
				eq(refUrls.organizationId, job.organizationId),
				eq(refUrls.workspaceId, job.workspaceId),
			),
		)
		.orderBy(qrCodes.id)
		.limit(DELETE_BATCH_SIZE);
	if (rows.length === 0) return 0;
	const keys = rows.flatMap(({ imageR2Key }) =>
		imageR2Key ? [imageR2Key] : [],
	);
	if (keys.length > 0) await env.MEDIA_BUCKET.delete(keys);
	await db.delete(qrCodes).where(
		inArray(
			qrCodes.id,
			rows.map(({ id }) => id),
		),
	);
	return rows.length;
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
			storageKey: media.storageKey,
			thumbnailKey: media.thumbnailKey,
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

	const originalKeys = rows.flatMap((row) =>
		row.storageProvider === "r2" ? [row.storageKey] : [],
	);
	const thumbnailKeys = rows.flatMap((row) => {
		if (row.thumbnailKey) return [row.thumbnailKey];
		return row.storageProvider === "r2"
			? [thumbnailKeyFor(row.storageKey)]
			: [];
	});
	await Promise.all([
		originalKeys.length > 0
			? env.MEDIA_BUCKET.delete(originalKeys)
			: Promise.resolve(),
		thumbnailKeys.length > 0
			? env.THUMBNAIL_BUCKET.delete(thumbnailKeys)
			: Promise.resolve(),
		...originalKeys.map((key) => purgePresignedViewCache(env, key)),
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

	const previewKeys = rows.flatMap((row) =>
		row.previewThumbnailKey ? [row.previewThumbnailKey] : [],
	);
	if (previewKeys.length > 0) {
		await env.THUMBNAIL_BUCKET.delete(previewKeys);
	}
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

async function processWorkspacePurge(
	db: ErasureDb,
	env: Env,
	job: WorkspaceJob,
	step: WorkspaceStep,
): Promise<StepResult> {
	const cursor = parseCursor<PurgeCursor>(step.cursor);
	const phase = cursor.phase ?? "qr_codes";
	if (phase === "qr_codes") {
		const deleted = await deleteQrCodeObjectBatch(db, env, job);
		return {
			kind: "pending",
			rowsDeleted: deleted,
			cursor: {
				phase: deleted < DELETE_BATCH_SIZE ? "account_dependents" : phase,
				dependent_index: 0,
			},
		};
	}
	if (phase === "account_dependents") {
		const dependents = ["connection_logs"] as const;
		const index = cursor.dependent_index ?? 0;
		const table = dependents[index];
		if (!table) {
			return {
				kind: "pending",
				cursor: { phase: "tables", table_index: 0 },
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
