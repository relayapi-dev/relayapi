import {
	type Database,
	erasureHolds,
	getPrivacyRetentionStore,
	type LegalHoldTreatment,
	organization,
	tenantDeletionJobs,
	tenantDeletionSteps,
	user,
	workspaceErasureJobs,
	workspaceErasureSteps,
	workspaces,
} from "@relayapi/db";
import {
	and,
	eq,
	inArray,
	isNotNull,
	isNull,
	lte,
	notInArray,
	or,
	sql,
} from "drizzle-orm";

export type ErasureHoldTarget =
	| {
			kind: "organization";
			organizationId: string;
	  }
	| {
			kind: "workspace";
			organizationId: string;
			workspaceId: string;
	  };

export type RetentionHoldAction = "continue" | "pause" | "minimize";

export interface RetentionHoldDecision {
	action: RetentionHoldAction;
	storeId: string;
	activeHoldId: string | null;
}

export type RetentionExecutionResult<T> =
	| {
			status: "completed";
			action: "continue" | "minimize";
			value: T;
	  }
	| {
			status: "paused";
			action: "pause";
			activeHoldId: string;
	  };

export const RELEASED_HOLD_EVIDENCE_REDACTION_BATCH = 5_000;
export const RELEASED_HOLD_EVIDENCE_REDACTION_MAX_PASSES = 20;

export interface PlaceErasureHoldInput {
	target: ErasureHoldTarget;
	reasonCode: string;
	reasonSummary: string;
	legalAuthorityRef: string;
	/** Application-encrypted evidence only; never pass plaintext evidence. */
	evidenceCiphertext?: string | null;
	actorUserId: string;
}

export interface ReleaseErasureHoldInput {
	holdId: string;
	releaseReasonSummary: string;
	actorUserId: string;
}

type HoldRow = typeof erasureHolds.$inferSelect;
type PrivacyDb = Pick<Database, "select" | "insert" | "update">;
type HoldReadDb = Pick<Database, "select">;

export class ErasureHoldAuthorizationError extends Error {
	constructor() {
		super("Only a global system administrator may manage erasure holds");
		this.name = "ErasureHoldAuthorizationError";
	}
}

export class ErasureHoldTargetNotFoundError extends Error {
	constructor() {
		super("Erasure-hold target not found in the requested organization");
		this.name = "ErasureHoldTargetNotFoundError";
	}
}

export class ErasureHoldNotFoundError extends Error {
	constructor() {
		super("Active erasure hold not found");
		this.name = "ErasureHoldNotFoundError";
	}
}

export class InvalidErasureHoldInputError extends Error {
	constructor(field: string) {
		super(`Invalid erasure-hold field: ${field}`);
		this.name = "InvalidErasureHoldInputError";
	}
}

export class MissingRetentionMinimizerError extends Error {
	constructor(storeId: string) {
		super(
			`Store ${storeId} requires a secret/PII minimizer while held; destructive retention was not run`,
		);
		this.name = "MissingRetentionMinimizerError";
	}
}

function requireText(value: string, field: string, maxLength: number): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.length > maxLength) {
		throw new InvalidErasureHoldInputError(field);
	}
	return normalized;
}

export function canManageErasureHolds(globalRole: string | null): boolean {
	return globalRole === "admin";
}

export function erasureHoldCoversTarget(
	hold: Pick<HoldRow, "subjectKind" | "subjectId" | "organizationTombstoneId">,
	target: ErasureHoldTarget,
): boolean {
	if (
		hold.subjectKind === "organization" &&
		hold.subjectId === target.organizationId &&
		hold.organizationTombstoneId === target.organizationId
	) {
		return true;
	}
	return (
		target.kind === "workspace" &&
		hold.subjectKind === "workspace" &&
		hold.subjectId === target.workspaceId &&
		hold.organizationTombstoneId === target.organizationId
	);
}

function normalizeReasonCode(value: string): string {
	const normalized = value.trim();
	if (!/^[a-z][a-z0-9_]{0,63}$/.test(normalized)) {
		throw new InvalidErasureHoldInputError("reasonCode");
	}
	return normalized;
}

async function requireGlobalAdmin(
	db: PrivacyDb,
	actorUserId: string,
): Promise<void> {
	const [actor] = await db
		.select({ role: user.role })
		.from(user)
		.where(eq(user.id, actorUserId))
		.for("share")
		.limit(1);
	if (!canManageErasureHolds(actor?.role ?? null)) {
		throw new ErasureHoldAuthorizationError();
	}
}

async function lockAndValidateTarget(
	db: PrivacyDb,
	target: ErasureHoldTarget,
): Promise<void> {
	// Every ordinary retention delete takes a shared lock on the tenant row
	// before it evaluates active holds. Lock the same row first for both hold
	// scopes so a workspace hold cannot race a tenant-owned deletion.
	const [organizationRow] = await db
		.select({ id: organization.id })
		.from(organization)
		.where(eq(organization.id, target.organizationId))
		.for("update")
		.limit(1);
	if (!organizationRow) throw new ErasureHoldTargetNotFoundError();
	if (target.kind === "organization") return;

	const [row] = await db
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(
			and(
				eq(workspaces.id, target.workspaceId),
				eq(workspaces.organizationId, target.organizationId),
			),
		)
		.for("update")
		.limit(1);
	if (!row) throw new ErasureHoldTargetNotFoundError();
}

function activeTargetPredicate(target: ErasureHoldTarget) {
	const organizationHold = and(
		eq(erasureHolds.subjectKind, "organization"),
		eq(erasureHolds.subjectId, target.organizationId),
		eq(erasureHolds.organizationTombstoneId, target.organizationId),
	);
	if (target.kind === "organization") return organizationHold;
	return or(
		organizationHold,
		and(
			eq(erasureHolds.subjectKind, "workspace"),
			eq(erasureHolds.subjectId, target.workspaceId),
			eq(erasureHolds.organizationTombstoneId, target.organizationId),
		),
	);
}

export async function findActiveErasureHold(
	db: HoldReadDb,
	target: ErasureHoldTarget,
): Promise<HoldRow | null> {
	const [hold] = await db
		.select()
		.from(erasureHolds)
		.where(and(isNull(erasureHolds.releasedAt), activeTargetPredicate(target)))
		.orderBy(erasureHolds.placedAt, erasureHolds.id)
		.limit(1);
	return hold ?? null;
}

export function resolveHoldAction(
	legalHold: LegalHoldTreatment,
	hasActiveHold: boolean,
): RetentionHoldAction {
	if (!hasActiveHold || legalHold === "never") return "continue";
	return legalHold;
}

/**
 * Store-specific policy gate for erasure and ordinary retention workers.
 *
 * Secret/ephemeral stores resolve to `continue` or `minimize`, never `pause`.
 * A workspace decision also observes an active organization hold.
 */
export async function getRetentionHoldDecision(
	db: Database,
	storeId: string,
	target: ErasureHoldTarget,
): Promise<RetentionHoldDecision> {
	const store = getPrivacyRetentionStore(storeId);
	if (!store) throw new Error(`Unregistered privacy store: ${storeId}`);
	if (store.legalHold === "never") {
		return { action: "continue", storeId, activeHoldId: null };
	}
	const hold = await findActiveErasureHold(db, target);
	return {
		action: resolveHoldAction(store.legalHold, hold !== null),
		storeId,
		activeHoldId: hold?.id ?? null,
	};
}

export async function shouldPauseRetention(
	db: Database,
	storeId: string,
	target: ErasureHoldTarget,
): Promise<boolean> {
	return (
		(await getRetentionHoldDecision(db, storeId, target)).action === "pause"
	);
}

/**
 * Enforcement wrapper for destructive retention units. A paused unit is not
 * invoked; a mixed store must supply an explicit minimizer, so a caller cannot
 * accidentally preserve credentials or silently delete all held evidence.
 */
export async function executeRetentionOperation<T>(
	db: Database,
	storeId: string,
	target: ErasureHoldTarget,
	operations: {
		destroy: () => Promise<T>;
		minimize?: () => Promise<T>;
	},
): Promise<RetentionExecutionResult<T>> {
	const decision = await getRetentionHoldDecision(db, storeId, target);
	if (decision.action === "pause") {
		if (!decision.activeHoldId) {
			throw new Error("Paused retention decision is missing an active hold");
		}
		return {
			status: "paused",
			action: "pause",
			activeHoldId: decision.activeHoldId,
		};
	}
	if (decision.action === "minimize") {
		if (!operations.minimize) {
			throw new MissingRetentionMinimizerError(storeId);
		}
		return {
			status: "completed",
			action: "minimize",
			value: await operations.minimize(),
		};
	}
	return {
		status: "completed",
		action: "continue",
		value: await operations.destroy(),
	};
}

export async function placeErasureHold(
	db: Database,
	input: PlaceErasureHoldInput,
): Promise<HoldRow> {
	const reasonCode = normalizeReasonCode(input.reasonCode);
	const reasonSummary = requireText(input.reasonSummary, "reasonSummary", 500);
	const legalAuthorityRef = requireText(
		input.legalAuthorityRef,
		"legalAuthorityRef",
		256,
	);
	if (
		input.evidenceCiphertext &&
		new TextEncoder().encode(input.evidenceCiphertext).byteLength > 65_536
	) {
		throw new InvalidErasureHoldInputError("evidenceCiphertext");
	}
	return db.transaction(async (tx) => {
		await requireGlobalAdmin(tx, input.actorUserId);
		await lockAndValidateTarget(tx, input.target);
		const subjectId =
			input.target.kind === "organization"
				? input.target.organizationId
				: input.target.workspaceId;
		const [hold] = await tx
			.insert(erasureHolds)
			.values({
				subjectKind: input.target.kind,
				subjectId,
				organizationTombstoneId: input.target.organizationId,
				reasonCode,
				reasonSummary,
				legalAuthorityRef,
				placedBy: input.actorUserId,
				evidenceCiphertext: input.evidenceCiphertext ?? null,
			})
			.returning();
		if (!hold) throw new Error("Erasure hold insert returned no row");

		const heldAt = hold.placedAt;
		const pauseJob = {
			status: "held" as const,
			leaseToken: sql`${tenantDeletionJobs.leaseToken} + 1`,
			leaseExpiresAt: null,
			nextAttemptAt: heldAt,
			lastError: "paused_by_erasure_hold",
			updatedAt: heldAt,
		};
		const pauseWorkspaceJob = {
			status: "held" as const,
			leaseToken: sql`${workspaceErasureJobs.leaseToken} + 1`,
			leaseExpiresAt: null,
			nextAttemptAt: heldAt,
			lastError: "paused_by_erasure_hold",
			updatedAt: heldAt,
		};
		const fenceTenantSteps = async () => {
			await tx
				.update(tenantDeletionSteps)
				.set({
					status: "pending",
					leaseToken: sql`${tenantDeletionSteps.leaseToken} + 1`,
					leaseExpiresAt: null,
					nextAttemptAt: heldAt,
					lastError: "paused_by_erasure_hold",
					updatedAt: heldAt,
				})
				.where(
					and(
						eq(tenantDeletionSteps.organizationId, input.target.organizationId),
						eq(tenantDeletionSteps.status, "processing"),
					),
				);
		};
		const fenceWorkspaceSteps = async (
			workspacePredicate: ReturnType<typeof eq> | ReturnType<typeof inArray>,
		) => {
			await tx
				.update(workspaceErasureSteps)
				.set({
					status: "pending",
					leaseToken: sql`${workspaceErasureSteps.leaseToken} + 1`,
					leaseExpiresAt: null,
					nextAttemptAt: heldAt,
					lastError: "paused_by_erasure_hold",
					updatedAt: heldAt,
				})
				.where(
					and(
						eq(
							workspaceErasureSteps.organizationId,
							input.target.organizationId,
						),
						workspacePredicate,
						eq(workspaceErasureSteps.status, "processing"),
					),
				);
		};

		if (input.target.kind === "organization") {
			await tx
				.update(tenantDeletionJobs)
				.set(pauseJob)
				.where(
					and(
						eq(tenantDeletionJobs.organizationId, input.target.organizationId),
						inArray(tenantDeletionJobs.status, [
							"pending",
							"processing",
							"tombstoned",
							"waiting_external",
							"failed",
						]),
					),
				);
			await tx
				.update(workspaceErasureJobs)
				.set(pauseWorkspaceJob)
				.where(
					and(
						eq(
							workspaceErasureJobs.organizationId,
							input.target.organizationId,
						),
						inArray(workspaceErasureJobs.status, [
							"pending",
							"processing",
							"failed",
						]),
					),
				);
			await fenceTenantSteps();
			const workspaceIds = await tx
				.select({ id: workspaceErasureJobs.workspaceId })
				.from(workspaceErasureJobs)
				.where(
					eq(workspaceErasureJobs.organizationId, input.target.organizationId),
				);
			if (workspaceIds.length > 0) {
				await fenceWorkspaceSteps(
					inArray(
						workspaceErasureSteps.workspaceId,
						workspaceIds.map(({ id }) => id),
					),
				);
			}
		} else {
			await tx
				.update(workspaceErasureJobs)
				.set(pauseWorkspaceJob)
				.where(
					and(
						eq(workspaceErasureJobs.workspaceId, input.target.workspaceId),
						eq(
							workspaceErasureJobs.organizationId,
							input.target.organizationId,
						),
						inArray(workspaceErasureJobs.status, [
							"pending",
							"processing",
							"failed",
						]),
					),
				);
			await fenceWorkspaceSteps(
				eq(workspaceErasureSteps.workspaceId, input.target.workspaceId),
			);
		}
		return hold;
	});
}

export async function releaseErasureHold(
	db: Database,
	input: ReleaseErasureHoldInput,
): Promise<HoldRow> {
	const releaseReasonSummary = requireText(
		input.releaseReasonSummary,
		"releaseReasonSummary",
		500,
	);
	return db.transaction(async (tx) => {
		await requireGlobalAdmin(tx, input.actorUserId);
		const [candidate] = await tx
			.select()
			.from(erasureHolds)
			.where(
				and(eq(erasureHolds.id, input.holdId), isNull(erasureHolds.releasedAt)),
			)
			.limit(1);
		if (!candidate) throw new ErasureHoldNotFoundError();
		await lockAndValidateTarget(
			tx,
			candidate.subjectKind === "organization"
				? {
						kind: "organization",
						organizationId: candidate.organizationTombstoneId,
					}
				: {
						kind: "workspace",
						organizationId: candidate.organizationTombstoneId,
						workspaceId: candidate.subjectId,
					},
		);
		const [existing] = await tx
			.select()
			.from(erasureHolds)
			.where(
				and(eq(erasureHolds.id, input.holdId), isNull(erasureHolds.releasedAt)),
			)
			.for("update")
			.limit(1);
		if (!existing) throw new ErasureHoldNotFoundError();

		const releasedAt = new Date();
		const [released] = await tx
			.update(erasureHolds)
			.set({
				releasedBy: input.actorUserId,
				releasedAt,
				releaseReasonSummary,
			})
			.where(
				and(eq(erasureHolds.id, existing.id), isNull(erasureHolds.releasedAt)),
			)
			.returning();
		if (!released) throw new ErasureHoldNotFoundError();

		if (existing.subjectKind === "organization") {
			await tx
				.update(tenantDeletionJobs)
				.set({
					status: "tombstoned",
					nextAttemptAt: releasedAt,
					lastError: null,
					updatedAt: releasedAt,
				})
				.where(
					and(
						eq(
							tenantDeletionJobs.organizationId,
							existing.organizationTombstoneId,
						),
						eq(tenantDeletionJobs.status, "held"),
					),
				);

			const workspaceSpecificHolds = await tx
				.select({ workspaceId: erasureHolds.subjectId })
				.from(erasureHolds)
				.where(
					and(
						eq(erasureHolds.subjectKind, "workspace"),
						eq(
							erasureHolds.organizationTombstoneId,
							existing.organizationTombstoneId,
						),
						isNull(erasureHolds.releasedAt),
					),
				);
			const resumableWorkspaceCondition =
				workspaceSpecificHolds.length === 0
					? eq(
							workspaceErasureJobs.organizationId,
							existing.organizationTombstoneId,
						)
					: and(
							eq(
								workspaceErasureJobs.organizationId,
								existing.organizationTombstoneId,
							),
							notInArray(
								workspaceErasureJobs.workspaceId,
								workspaceSpecificHolds.map(({ workspaceId }) => workspaceId),
							),
						);
			await tx
				.update(workspaceErasureJobs)
				.set({
					status: "pending",
					nextAttemptAt: releasedAt,
					lastError: null,
					updatedAt: releasedAt,
				})
				.where(
					and(
						resumableWorkspaceCondition,
						eq(workspaceErasureJobs.status, "held"),
					),
				);
		} else {
			const [organizationHold] = await tx
				.select({ id: erasureHolds.id })
				.from(erasureHolds)
				.where(
					and(
						eq(erasureHolds.subjectKind, "organization"),
						eq(erasureHolds.subjectId, existing.organizationTombstoneId),
						eq(
							erasureHolds.organizationTombstoneId,
							existing.organizationTombstoneId,
						),
						isNull(erasureHolds.releasedAt),
					),
				)
				.limit(1);
			if (!organizationHold) {
				await tx
					.update(workspaceErasureJobs)
					.set({
						status: "pending",
						nextAttemptAt: releasedAt,
						lastError: null,
						updatedAt: releasedAt,
					})
					.where(
						and(
							eq(workspaceErasureJobs.workspaceId, existing.subjectId),
							eq(
								workspaceErasureJobs.organizationId,
								existing.organizationTombstoneId,
							),
							eq(workspaceErasureJobs.status, "held"),
						),
					);
			}
		}
		return released;
	});
}

/**
 * Bounded evidence drain. The caller supplies the reviewed post-release cutoff;
 * this function cannot redact active-hold evidence.
 */
export async function redactReleasedErasureHoldEvidence(
	db: Database,
	releasedBefore: Date,
	redactedAt = new Date(),
): Promise<number> {
	let redactedCount = 0;
	for (
		let pass = 0;
		pass < RELEASED_HOLD_EVIDENCE_REDACTION_MAX_PASSES;
		pass++
	) {
		const rows = await db
			.update(erasureHolds)
			.set({
				reasonSummary: "[redacted]",
				legalAuthorityRef: "[redacted]",
				placedBy: "[redacted]",
				releasedBy: "[redacted]",
				releaseReasonSummary: "[redacted]",
				evidenceCiphertext: null,
				evidenceRedactedAt: redactedAt,
			})
			.where(
				inArray(
					erasureHolds.id,
					db
						.select({ id: erasureHolds.id })
						.from(erasureHolds)
						.where(
							and(
								isNotNull(erasureHolds.releasedAt),
								isNull(erasureHolds.evidenceRedactedAt),
								lte(erasureHolds.releasedAt, releasedBefore),
							),
						)
						.orderBy(erasureHolds.releasedAt, erasureHolds.id)
						.limit(RELEASED_HOLD_EVIDENCE_REDACTION_BATCH),
				),
			)
			.returning({ id: erasureHolds.id });
		redactedCount += rows.length;
		if (rows.length < RELEASED_HOLD_EVIDENCE_REDACTION_BATCH) break;
	}
	return redactedCount;
}
