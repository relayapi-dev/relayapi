import { type Database, socialMutationOperations } from "@relayapi/db";
import { and, eq, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import { durableOperationHashes } from "../lib/durable-operation";
import type { MutationEffectTracker } from "../lib/mutation-effect";
import {
	SocialProviderActionError,
	type SocialProviderActionResult,
} from "./social-provider-actions";

const LEASE_MS = 2 * 60_000;
export const MAX_SOCIAL_PROJECTION_ATTEMPTS = 8;

export type SocialMutationOperation =
	typeof socialMutationOperations.$inferSelect;
export type SocialMutationTargetType = SocialMutationOperation["targetType"];
export type SocialMutationKind = SocialMutationOperation["kind"];

export class SocialMutationConflictError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "SocialMutationConflictError";
		this.code = code;
	}
}

type BeginSocialMutationOptions = {
	db: Database;
	organizationId: string;
	workspaceId: string | null;
	accountId: string;
	platform: SocialMutationOperation["platform"];
	targetType: SocialMutationTargetType;
	targetId: string;
	kind: SocialMutationKind;
	operationKey: string;
	requestPayload: Record<string, unknown>;
	/**
	 * Logical request used for idempotency hashing when the durable payload also
	 * contains randomized encrypted projection material.
	 */
	requestHashPayload?: Record<string, unknown>;
};

type BeginSocialMutationResult =
	| { execute: true; operation: SocialMutationOperation; leaseToken: number }
	| { execute: false; operation: SocialMutationOperation };

async function beginSocialMutation(
	options: BeginSocialMutationOptions,
): Promise<BeginSocialMutationResult> {
	const { operationKeyHash, requestHash } = await durableOperationHashes(
		options.organizationId,
		options.kind,
		options.operationKey,
		options.requestHashPayload ?? options.requestPayload,
	);
	const now = new Date();
	const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
	return options.db.transaction(async (tx) => {
		const [inserted] = await tx
			.insert(socialMutationOperations)
			.values({
				organizationId: options.organizationId,
				workspaceId: options.workspaceId,
				accountId: options.accountId,
				platform: options.platform,
				targetType: options.targetType,
				targetId: options.targetId,
				kind: options.kind,
				operationKeyHash,
				requestHash,
				requestPayload: options.requestPayload,
				status: "processing",
				phase: "provider",
				leaseToken: 1,
				leaseExpiresAt,
				attempts: 1,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing()
			.returning();

		if (inserted) {
			return { execute: true, operation: inserted, leaseToken: 1 };
		}

		const [sameKey] = await tx
			.select()
			.from(socialMutationOperations)
			.where(
				and(
					eq(socialMutationOperations.organizationId, options.organizationId),
					eq(socialMutationOperations.targetType, options.targetType),
					eq(socialMutationOperations.targetId, options.targetId),
					eq(socialMutationOperations.operationKeyHash, operationKeyHash),
				),
			)
			.for("update")
			.limit(1);
		if (sameKey) {
			if (sameKey.requestHash !== requestHash) {
				throw new SocialMutationConflictError(
					"IDEMPOTENCY_KEY_REUSED",
					"The Idempotency-Key was already used with a different request",
				);
			}
			return { execute: false, operation: sameKey };
		}

		const [active] = await tx
			.select()
			.from(socialMutationOperations)
			.where(
				and(
					eq(socialMutationOperations.organizationId, options.organizationId),
					eq(socialMutationOperations.targetType, options.targetType),
					eq(socialMutationOperations.targetId, options.targetId),
					inArray(socialMutationOperations.status, [
						"pending",
						"processing",
						"request_may_have_been_sent",
						"unknown",
					]),
				),
			)
			.for("update")
			.limit(1);
		if (active) {
			throw new SocialMutationConflictError(
				"SOCIAL_MUTATION_IN_PROGRESS",
				"This provider object already has an active or ambiguous mutation",
			);
		}
		throw new SocialMutationConflictError(
			"SOCIAL_MUTATION_CONFLICT",
			"The provider mutation could not be admitted",
		);
	});
}

async function markRequestBoundary(
	db: Database,
	operationId: string,
	leaseToken: number,
): Promise<void> {
	const now = new Date();
	const [updated] = await db
		.update(socialMutationOperations)
		.set({
			status: "request_may_have_been_sent",
			requestMayHaveBeenSentAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(socialMutationOperations.id, operationId),
				eq(socialMutationOperations.status, "processing"),
				eq(socialMutationOperations.leaseToken, leaseToken),
			),
		)
		.returning({ id: socialMutationOperations.id });
	if (!updated) {
		throw new SocialMutationConflictError(
			"SOCIAL_MUTATION_LEASE_LOST",
			"The provider mutation lease was lost before dispatch",
		);
	}
}

async function markProviderConfirmed(
	db: Database,
	operationId: string,
	leaseToken: number,
	result: SocialProviderActionResult,
): Promise<void> {
	const now = new Date();
	const [updated] = await db
		.update(socialMutationOperations)
		.set({
			phase: "projection",
			providerConfirmedAt: now,
			providerOperationId:
				result.providerOperationId ?? result.providerId ?? null,
			providerResult: {
				...(result.providerResult ?? {}),
				...(result.providerId ? { provider_id: result.providerId } : {}),
			},
			updatedAt: now,
		})
		.where(
			and(
				eq(socialMutationOperations.id, operationId),
				eq(socialMutationOperations.status, "request_may_have_been_sent"),
				eq(socialMutationOperations.leaseToken, leaseToken),
			),
		)
		.returning({ id: socialMutationOperations.id });
	if (!updated) {
		throw new SocialMutationConflictError(
			"SOCIAL_MUTATION_LEASE_LOST",
			"The provider mutation lease was lost before projection",
		);
	}
}

async function completeSocialMutation(
	db: Database,
	operationId: string,
	leaseToken: number,
): Promise<SocialMutationOperation> {
	const now = new Date();
	const [completed] = await db
		.update(socialMutationOperations)
		.set({
			status: "completed",
			phase: "completed",
			leaseExpiresAt: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(socialMutationOperations.id, operationId),
				inArray(socialMutationOperations.status, [
					"processing",
					"request_may_have_been_sent",
				]),
				eq(socialMutationOperations.phase, "projection"),
				eq(socialMutationOperations.leaseToken, leaseToken),
			),
		)
		.returning();
	if (!completed) {
		throw new SocialMutationConflictError(
			"SOCIAL_MUTATION_LEASE_LOST",
			"The provider mutation lease was lost during projection",
		);
	}
	return completed;
}

type ClaimedProjection = {
	operation: SocialMutationOperation;
	leaseToken: number;
};

/**
 * Claim only a provider-confirmed local projection. This function can never
 * claim a provider-phase or unconfirmed operation, which is the hard fence
 * preventing a scheduler from replaying an ambiguous remote mutation.
 */
export async function claimConfirmedSocialProjection(
	db: Database,
	operationId: string,
	now = new Date(),
): Promise<ClaimedProjection | null> {
	const [claimed] = await db
		.update(socialMutationOperations)
		.set({
			status: "processing",
			leaseToken: sql`${socialMutationOperations.leaseToken} + 1`,
			leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
			attempts: sql`${socialMutationOperations.attempts} + 1`,
			lastError: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(socialMutationOperations.id, operationId),
				eq(socialMutationOperations.phase, "projection"),
				isNotNull(socialMutationOperations.providerConfirmedAt),
				lt(socialMutationOperations.attempts, MAX_SOCIAL_PROJECTION_ATTEMPTS),
				or(
					eq(socialMutationOperations.status, "unknown"),
					and(
						eq(socialMutationOperations.status, "request_may_have_been_sent"),
						lte(socialMutationOperations.leaseExpiresAt, now),
					),
					and(
						eq(socialMutationOperations.status, "processing"),
						lte(socialMutationOperations.leaseExpiresAt, now),
					),
				),
			),
		)
		.returning();
	if (!claimed) return null;
	return { operation: claimed, leaseToken: claimed.leaseToken };
}

function storedProviderResult(
	operation: SocialMutationOperation,
): SocialProviderActionResult {
	const providerResult = operation.providerResult as Record<
		string,
		unknown
	> | null;
	return {
		providerId:
			typeof providerResult?.provider_id === "string"
				? providerResult.provider_id
				: undefined,
		providerOperationId: operation.providerOperationId ?? undefined,
		providerResult: providerResult ?? undefined,
	};
}

/** Execute a fenced, projection-only replay after an exact provider ack. */
export async function resumeConfirmedSocialProjection(options: {
	db: Database;
	operationId: string;
	project: (
		result: SocialProviderActionResult,
		operation: SocialMutationOperation,
	) => Promise<void>;
	now?: Date;
}): Promise<SocialMutationOperation | null> {
	const claimed = await claimConfirmedSocialProjection(
		options.db,
		options.operationId,
		options.now,
	);
	if (!claimed) return null;
	try {
		await options.project(
			storedProviderResult(claimed.operation),
			claimed.operation,
		);
		return completeSocialMutation(
			options.db,
			claimed.operation.id,
			claimed.leaseToken,
		);
	} catch (error) {
		return parkSocialMutation(
			options.db,
			claimed.operation.id,
			claimed.leaseToken,
			"unknown",
			error,
		);
	}
}

async function parkSocialMutation(
	db: Database,
	operationId: string,
	leaseToken: number,
	status: "unknown" | "failed",
	error: unknown,
): Promise<SocialMutationOperation> {
	const now = new Date();
	const message =
		error instanceof Error
			? error.message.slice(0, 4000)
			: "Provider mutation failed";
	const [parked] = await db
		.update(socialMutationOperations)
		.set({
			status,
			leaseExpiresAt: null,
			lastError: message,
			updatedAt: now,
		})
		.where(
			and(
				eq(socialMutationOperations.id, operationId),
				eq(socialMutationOperations.leaseToken, leaseToken),
				inArray(socialMutationOperations.status, [
					"processing",
					"request_may_have_been_sent",
				]),
			),
		)
		.returning();
	if (!parked) {
		throw new SocialMutationConflictError(
			"SOCIAL_MUTATION_LEASE_LOST",
			"The provider mutation lease was lost while recording its outcome",
		);
	}
	return parked;
}

export type RunSocialMutationOptions = BeginSocialMutationOptions & {
	mutationEffectTracker?: MutationEffectTracker;
	/**
	 * Re-read the provider target after durable admission and before crossing the
	 * remote request boundary. This closes the wait-on-partial-unique-index race:
	 * a second mutation may have resolved its target before the first completed.
	 */
	validateBeforeProvider?: (
		operation: SocialMutationOperation,
	) => Promise<void>;
	provider: () => Promise<SocialProviderActionResult>;
	project?: (
		result: SocialProviderActionResult,
		operation: SocialMutationOperation,
	) => Promise<void>;
};

export async function runSocialMutation(
	options: RunSocialMutationOptions,
): Promise<SocialMutationOperation> {
	const begun = await beginSocialMutation(options);
	if (!begun.execute) return begun.operation;

	const attempt = options.mutationEffectTracker?.begin(
		`${options.platform}.${options.kind}`,
	);
	let providerCommitted = false;
	try {
		if (options.validateBeforeProvider) {
			await options.validateBeforeProvider(begun.operation);
		}
		await markRequestBoundary(options.db, begun.operation.id, begun.leaseToken);
		const result = await options.provider();
		providerCommitted = true;
		attempt?.committed();
		options.mutationEffectTracker?.setAuthoritativeOutcome({
			kind: "committed",
			units: 1,
		});
		await markProviderConfirmed(
			options.db,
			begun.operation.id,
			begun.leaseToken,
			result,
		);
		if (options.project) await options.project(result, begun.operation);
		return completeSocialMutation(
			options.db,
			begun.operation.id,
			begun.leaseToken,
		);
	} catch (error) {
		const definitive =
			!providerCommitted &&
			error instanceof SocialProviderActionError &&
			error.definitive;
		if (providerCommitted) {
			// The provider acknowledgement is exact K=1 even when the local
			// projection fails. Keep the operation discoverable for projection-only
			// reconciliation without regressing request usage evidence.
		} else if (definitive) {
			attempt?.notApplied();
			options.mutationEffectTracker?.setAuthoritativeOutcome({
				kind: "not_applied",
			});
		} else {
			attempt?.unknown();
			options.mutationEffectTracker?.setAuthoritativeOutcome({
				kind: "unknown",
			});
		}
		return parkSocialMutation(
			options.db,
			begun.operation.id,
			begun.leaseToken,
			definitive ? "failed" : "unknown",
			error,
		);
	}
}

export async function getSocialMutation(
	db: Database,
	organizationId: string,
	operationId: string,
): Promise<SocialMutationOperation | null> {
	const [row] = await db
		.select()
		.from(socialMutationOperations)
		.where(
			and(
				eq(socialMutationOperations.id, operationId),
				eq(socialMutationOperations.organizationId, organizationId),
			),
		)
		.limit(1);
	return row ?? null;
}

export function serializeSocialMutation(operation: SocialMutationOperation) {
	const result = operation.providerResult as Record<string, unknown> | null;
	return {
		id: operation.id,
		target_id: operation.targetId,
		account_id: operation.accountId,
		platform: operation.platform,
		kind: operation.kind,
		status: operation.status,
		provider_operation_id: operation.providerOperationId,
		provider_post_id:
			typeof result?.provider_id === "string" ? result.provider_id : null,
		result,
		error: operation.lastError,
		created_at: operation.createdAt.toISOString(),
		updated_at: operation.updatedAt.toISOString(),
		completed_at: operation.completedAt?.toISOString() ?? null,
	};
}
