import {
	createDb,
	generateId,
	posts,
	postTargets,
	publishAttempts,
	publishOutbox,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { decryptAccountToken } from "../lib/account-token-crypto";
import { mapConcurrently } from "../lib/concurrency";
import { notifyRealtime } from "../lib/notify-post-update";
import { resolveRelayMediaForPublish } from "../lib/r2-presign";
import { RelayMediaPolicyError } from "../lib/relay-media-policy";
import type {
	ProviderOutcome,
	PublishRequest,
	PublishResult,
} from "../publishers";
import { getPublisher } from "../publishers";
import {
	hasTerminalProviderEvidence,
	isNonTerminalProviderOutcome,
	isTerminalProviderSuccess,
} from "../publishers/types";
import type { Platform } from "../schemas/common";
import type { Env } from "../types";
import {
	getAllowedRecipientHashes,
	hashRecipientIdentifier,
} from "./contact-consent";
import { postCompletionOutboxRow } from "./publish-outbox";
import {
	forceRefreshToken,
	refreshTokenIfNeeded,
} from "./token-refresh-coordinator";
import {
	enqueuePersistedWebhookEvent,
	persistWebhookEventInTransaction,
} from "./webhook-delivery";

// Keep local media graphs serialized to bound isolate memory. Cloudflare now
// counts only connections still waiting for response headers toward the six-
// connection limit and queues any excess request, so media work must not reduce
// the independent lightweight-task concurrency.
// Docs: https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections
export const TEXT_TARGET_CONCURRENCY = 6;
export const MEDIA_TARGET_CONCURRENCY = 1;
export const PUBLISH_RESULT_PERSIST_CONCURRENCY = 2;
export const DEFINITIVE_RATE_LIMIT_MAX_RETRIES = 2;
export const DEFINITIVE_RATE_LIMIT_BASE_DELAY_MS = 250;
export const DEFINITIVE_RATE_LIMIT_MAX_DELAY_MS = 2_000;
const PUBLISH_PARENT_LEASE_MS = 30 * 60 * 1000;
export const LOCAL_MEDIA_TARGET_PLATFORMS: ReadonlySet<string> = new Set([
	"bluesky",
	"discord",
	"facebook",
	"linkedin",
	"mastodon",
	"pinterest",
	"reddit",
	"snapchat",
	"twitter",
	"youtube",
]);

type PublishMediaDescriptor = { type?: string };

/**
 * Identify only publish modes that actually download or re-stream media in the
 * Worker. Several platform APIs accept source URLs directly, so classifying on
 * platform name alone unnecessarily serializes otherwise lightweight targets.
 */
export function publishOperationLocallyStreamsMedia(
	platform: string,
	fallbackMedia: PublishRequest["media"],
	targetOptions: Record<string, unknown>,
): boolean {
	if (!LOCAL_MEDIA_TARGET_PLATFORMS.has(platform)) return false;

	const effectiveMedia = (
		Array.isArray(targetOptions.media) ? targetOptions.media : fallbackMedia
	) as PublishMediaDescriptor[];
	const threadItems = Array.isArray(targetOptions.thread)
		? targetOptions.thread
		: [];
	const threadMedia = threadItems.flatMap((item) =>
		item &&
		typeof item === "object" &&
		Array.isArray((item as { media?: unknown }).media)
			? ((item as { media: PublishMediaDescriptor[] }).media ?? [])
			: [],
	);
	const operationMedia = threadItems.length > 0 ? threadMedia : effectiveMedia;

	switch (platform) {
		case "bluesky": {
			const linkPreview = targetOptions.link_preview;
			const hasThumbnail =
				linkPreview !== null &&
				typeof linkPreview === "object" &&
				typeof (linkPreview as { thumbnail_url?: unknown }).thumbnail_url ===
					"string";
			return operationMedia.length > 0 || hasThumbnail;
		}
		case "discord":
			return operationMedia.some((media) => media.type !== "video");
		case "facebook":
			return (
				targetOptions.content_type === "reel" ||
				(targetOptions.content_type === "story" &&
					operationMedia[0]?.type === "video")
			);
		case "linkedin":
			return operationMedia.some(
				(media) =>
					!media.type ||
					["image", "video", "gif", "document"].includes(media.type),
			);
		case "mastodon":
			return operationMedia.length > 0;
		case "pinterest":
			return operationMedia.some((media) => media.type === "video");
		case "reddit":
			return (
				targetOptions.force_self !== true &&
				(operationMedia.length > 1 ||
					(operationMedia.length === 1 && !targetOptions.url))
			);
		case "snapchat":
			return operationMedia.length > 0;
		case "twitter":
			return operationMedia.length > 0;
		case "youtube":
			return operationMedia.some((media) => media.type === "video");
		default:
			return false;
	}
}

export class PublishBoundaryError extends Error {
	readonly requestMayHaveBeenSent: boolean;

	constructor(cause: unknown, requestMayHaveBeenSent: boolean) {
		super(cause instanceof Error ? cause.message : "Unknown publish error");
		this.name = "PublishBoundaryError";
		this.requestMayHaveBeenSent = requestMayHaveBeenSent;
	}
}

class PostPublishLeaseLostError extends Error {
	constructor() {
		super("Post publish execution lease was lost");
		this.name = "PostPublishLeaseLostError";
	}
}

export function classifyPublishTaskRejection(
	reason: unknown,
): "PUBLISH_OUTCOME_UNKNOWN" | "PUBLISH_PREBOUNDARY_ERROR" {
	return reason instanceof PublishBoundaryError && reason.requestMayHaveBeenSent
		? "PUBLISH_OUTCOME_UNKNOWN"
		: "PUBLISH_PREBOUNDARY_ERROR";
}

export function classifyPersistedPostTargets(
	rows: Array<{ status: string; deliveryState: string }>,
): "active" | "unknown" | "empty" | "published" | "failed" | "partial" {
	if (
		rows.some(
			(row) =>
				row.deliveryState === "queued" || row.deliveryState === "in_flight",
		)
	) {
		return "active";
	}
	if (rows.some((row) => row.deliveryState === "unknown")) return "unknown";
	if (rows.length === 0) return "empty";
	if (rows.every((row) => row.status === "published")) return "published";
	if (rows.every((row) => row.status === "failed")) return "failed";
	return "partial";
}

/**
 * Return the bounded inline delay for a provider request that was explicitly
 * rejected. Missing retry metadata is deliberately treated as ambiguous.
 */
export function getDefinitiveRateLimitRetryDelay(
	result: PublishResult,
	retriesUsed: number,
): number | null {
	if (
		result.success ||
		result.error?.code !== "RATE_LIMITED" ||
		result.retry?.disposition !== "safe_to_retry" ||
		retriesUsed < 0 ||
		retriesUsed >= DEFINITIVE_RATE_LIMIT_MAX_RETRIES
	) {
		return null;
	}

	const exponentialDelay =
		DEFINITIVE_RATE_LIMIT_BASE_DELAY_MS * 2 ** retriesUsed;
	const requestedDelay =
		typeof result.retry.after_ms === "number" &&
		Number.isFinite(result.retry.after_ms) &&
		result.retry.after_ms >= 0
			? result.retry.after_ms
			: 0;
	const delay = Math.max(exponentialDelay, requestedDelay);

	// Do not hold a Worker open for a provider-requested long delay. The result is
	// still a definitive failure and remains eligible for a later API-level retry.
	return delay <= DEFINITIVE_RATE_LIMIT_MAX_DELAY_MS ? Math.floor(delay) : null;
}

export function canRetryTokenExpiredPublish(
	result: PublishResult,
	isMultiPostOperation: boolean,
): boolean {
	return (
		!result.success &&
		result.error?.code === "TOKEN_EXPIRED" &&
		(!isMultiPostOperation ||
			result.outcome?.disposition === "definitive_rejection")
	);
}

export function requiresPublishOutcomeReconciliation(
	result: PublishResult,
): boolean {
	if (
		result.provider_outcome?.disposition === "outcome_unknown" ||
		result.provider_outcome?.disposition === "partial"
	) {
		return true;
	}
	if (
		result.provider_outcome &&
		(isTerminalProviderSuccess(result.provider_outcome) ||
			isNonTerminalProviderOutcome(result.provider_outcome) ||
			result.provider_outcome.disposition === "failed")
	) {
		return false;
	}
	return (
		!result.success &&
		[
			"PLATFORM_ERROR",
			"RATE_LIMITED",
			"PUBLISH_FAILED",
			"PUBLISH_OUTCOME_UNKNOWN",
		].includes(result.error?.code ?? "PUBLISH_FAILED") &&
		result.retry?.disposition !== "safe_to_retry" &&
		result.outcome?.disposition !== "definitive_rejection"
	);
}

/**
 * Convert legacy publisher results into the truthful lifecycle model. Updated
 * adapters provide `provider_outcome` directly; this compatibility path refuses
 * to call an id-less `success: true` published.
 */
export function normalizeProviderOutcome(
	result: PublishResult,
): ProviderOutcome {
	if (result.provider_outcome) {
		if (
			isTerminalProviderSuccess(result.provider_outcome) &&
			!hasTerminalProviderEvidence(result.provider_outcome)
		) {
			return {
				disposition: "outcome_unknown",
				provider_operation_id: result.provider_outcome.provider_operation_id,
				provider_state: result.provider_outcome.provider_state,
				effects: result.provider_outcome.effects,
			};
		}
		return result.provider_outcome;
	}
	if (result.success) {
		if (result.platform_post_id?.trim()) {
			return {
				disposition: "published",
				platform_post_id: result.platform_post_id,
				platform_url: result.platform_url,
			};
		}
		return { disposition: "outcome_unknown" };
	}
	return {
		disposition: requiresPublishOutcomeReconciliation(result)
			? "outcome_unknown"
			: "failed",
	};
}

export function providerReconcileAt(
	outcome: ProviderOutcome,
	now = new Date(),
): Date | null {
	if (outcome.next_reconcile_at) {
		const parsed = new Date(outcome.next_reconcile_at);
		if (Number.isFinite(parsed.getTime()) && parsed.getTime() > now.getTime()) {
			return parsed;
		}
	}
	if (
		outcome.disposition === "outcome_unknown" ||
		outcome.disposition === "partial"
	) {
		return new Date(now.getTime() + 60_000);
	}
	if (!isNonTerminalProviderOutcome(outcome)) return null;
	const delayMs =
		outcome.disposition === "processing" || outcome.disposition === "accepted"
			? 15_000
			: 15 * 60_000;
	return new Date(now.getTime() + delayMs);
}

export type PublishResultPersistenceGate = <T>(
	work: () => Promise<T>,
) => Promise<T>;

/** Bound short result transactions shared by media and lightweight publishers. */
export function createPublishResultPersistenceGate(
	limit = PUBLISH_RESULT_PERSIST_CONCURRENCY,
): PublishResultPersistenceGate {
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new RangeError("Publish result persistence limit must be positive");
	}
	let active = 0;
	const waiters: Array<() => void> = [];

	return async <T>(work: () => Promise<T>): Promise<T> => {
		if (active >= limit) {
			await new Promise<void>((resolve) => waiters.push(resolve));
		} else {
			active++;
		}
		try {
			return await work();
		} finally {
			const next = waiters.shift();
			if (next) next();
			else active--;
		}
	};
}

/** Persist a task as soon as it settles, without changing its rejection shape. */
export async function settleAndPersistPublishTask<T, P>(
	task: () => Promise<T>,
	persist: (settled: PromiseSettledResult<T>) => Promise<P>,
): Promise<{ settled: PromiseSettledResult<T>; persistence: P }> {
	let settled: PromiseSettledResult<T>;
	try {
		settled = { status: "fulfilled", value: await task() };
	} catch (reason) {
		settled = { status: "rejected", reason };
	}
	return { settled, persistence: await persist(settled) };
}

export interface PublishTaskPersistenceInput {
	postId: string;
	organizationId: string;
	parentLeaseId: string;
	postTargetId: string;
	attemptId: string;
	publishOperationId: string;
	requestMayHaveBeenSent: boolean;
	result: PublishResult;
}

/** Atomically persist the target and its attempt under the same execution fences. */
export async function persistPublishTaskResult(
	db: ReturnType<typeof createDb>,
	input: PublishTaskPersistenceInput,
): Promise<boolean> {
	const completedAt = new Date();
	const providerOutcome = normalizeProviderOutcome(input.result);
	const terminalSuccess = isTerminalProviderSuccess(providerOutcome);
	const nonterminal = isNonTerminalProviderOutcome(providerOutcome);
	const unknown = ["partial", "outcome_unknown"].includes(
		providerOutcome.disposition,
	);
	const nextReconcileAt = providerReconcileAt(providerOutcome, completedAt);
	const platformPostId =
		providerOutcome.platform_post_id ?? input.result.platform_post_id ?? null;
	const platformUrl =
		providerOutcome.platform_url ?? input.result.platform_url ?? null;
	const providerFields = {
		providerDisposition: providerOutcome.disposition,
		providerOperationId: providerOutcome.provider_operation_id ?? null,
		providerState: providerOutcome.provider_state ?? null,
		providerEffects: providerOutcome.effects ?? null,
		nextReconcileAt,
	};
	const parentFence = sql`EXISTS (
		SELECT 1 FROM posts AS publish_parent
		WHERE publish_parent.id = ${input.postId}
			AND publish_parent.organization_id = ${input.organizationId}
			AND publish_parent.status = 'publishing'
			AND publish_parent.publish_lease_id = ${input.parentLeaseId}
	)`;

	return db.transaction(async (tx) => {
		const [savedTarget] = await tx
			.update(postTargets)
			.set(
				terminalSuccess
					? {
							status: "published",
							deliveryState: "succeeded",
							platformPostId,
							platformUrl,
							...providerFields,
							publishedAt: completedAt,
							error: null,
							errorCode: null,
							errorDetail: null,
							leaseExpiresAt: null,
							updatedAt: completedAt,
						}
					: nonterminal
						? {
								status: "publishing",
								// Keep the existing coarse projection compatible. The
								// providerDisposition distinguishes known nonterminal state
								// from an actually ambiguous provider outcome.
								deliveryState: "unknown",
								platformPostId,
								platformUrl,
								...providerFields,
								error: null,
								errorCode: null,
								errorDetail: null,
								leaseExpiresAt: null,
								updatedAt: completedAt,
							}
						: unknown
							? {
									status: "publishing",
									deliveryState: "unknown",
									platformPostId,
									platformUrl,
									...providerFields,
									error:
										input.result.error?.message ?? "Provider outcome unknown",
									errorCode: "PUBLISH_OUTCOME_UNKNOWN",
									errorDetail: input.result.error?.detail ?? null,
									leaseExpiresAt: null,
									updatedAt: completedAt,
								}
							: {
									status: "failed",
									deliveryState: "failed",
									platformPostId,
									platformUrl,
									...providerFields,
									error: input.result.error?.message ?? "Unknown error",
									errorCode: input.result.error?.code ?? "PUBLISH_FAILED",
									errorDetail: input.result.error?.detail ?? null,
									publishedAt: null,
									leaseExpiresAt: null,
									updatedAt: completedAt,
								},
			)
			.where(
				and(
					eq(postTargets.id, input.postTargetId),
					eq(postTargets.postId, input.postId),
					eq(postTargets.organizationId, input.organizationId),
					eq(postTargets.publishOperationId, input.publishOperationId),
					eq(postTargets.attemptId, input.attemptId),
					eq(postTargets.status, "publishing"),
					input.requestMayHaveBeenSent
						? and(
								eq(postTargets.deliveryState, "unknown"),
								isNotNull(postTargets.requestMayHaveBeenSentAt),
							)
						: and(
								eq(postTargets.deliveryState, "in_flight"),
								isNull(postTargets.requestMayHaveBeenSentAt),
							),
					parentFence,
				),
			)
			.returning({ id: postTargets.id });
		if (!savedTarget) return false;

		const [savedAttempt] = await tx
			.update(publishAttempts)
			.set(
				terminalSuccess
					? {
							state: "succeeded",
							providerPostId: platformPostId,
							providerOperationId:
								providerOutcome.provider_operation_id ?? null,
							providerDisposition: providerOutcome.disposition,
							providerState: providerOutcome.provider_state ?? null,
							providerEffects: providerOutcome.effects ?? null,
							completedAt,
							error: null,
							leaseExpiresAt: completedAt,
						}
					: nonterminal
						? {
								state: "unknown",
								providerPostId: platformPostId,
								providerOperationId:
									providerOutcome.provider_operation_id ?? null,
								providerDisposition: providerOutcome.disposition,
								providerState: providerOutcome.provider_state ?? null,
								providerEffects: providerOutcome.effects ?? null,
								completedAt,
								error: null,
								leaseExpiresAt: completedAt,
							}
						: unknown
							? {
									state: "unknown",
									providerPostId: platformPostId,
									providerOperationId:
										providerOutcome.provider_operation_id ?? null,
									providerDisposition: providerOutcome.disposition,
									providerState: providerOutcome.provider_state ?? null,
									providerEffects: providerOutcome.effects ?? null,
									completedAt,
									error:
										input.result.error?.message ?? "Provider outcome unknown",
									leaseExpiresAt: completedAt,
								}
							: {
									state: "failed",
									providerPostId: platformPostId,
									providerOperationId:
										providerOutcome.provider_operation_id ?? null,
									providerDisposition: providerOutcome.disposition,
									providerState: providerOutcome.provider_state ?? null,
									providerEffects: providerOutcome.effects ?? null,
									completedAt,
									error: input.result.error?.message ?? "Publish rejected",
									leaseExpiresAt: completedAt,
								},
			)
			.where(
				and(
					eq(publishAttempts.id, input.attemptId),
					eq(publishAttempts.postTargetId, input.postTargetId),
					eq(publishAttempts.publishOperationId, input.publishOperationId),
					eq(
						publishAttempts.state,
						input.requestMayHaveBeenSent ? "unknown" : "in_flight",
					),
					parentFence,
				),
			)
			.returning({ id: publishAttempts.id });
		if (!savedAttempt) throw new PostPublishLeaseLostError();
		return true;
	});
}

/**
 * Convert media.relayapi.dev URLs to presigned R2 GET URLs so external
 * platforms (Instagram, Facebook, etc.) can fetch the media.
 * Docs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
 */
async function resolveMediaUrls(
	db: ReturnType<typeof createDb>,
	env: Env,
	mediaItems: PublishRequest["media"],
	targetOptions: Record<string, Record<string, unknown>> | null,
	orgId: string,
): Promise<{
	mediaItems: PublishRequest["media"];
	targetOptions: Record<string, Record<string, unknown>> | null;
}> {
	return resolveRelayMediaForPublish(
		db,
		env,
		{ mediaItems, targetOptions },
		orgId,
	);
}

export interface PublishTargetInput {
	key: string;
	platform: Platform;
	accounts: Array<{
		id: string;
		username: string | null;
	}>;
}

export interface PublishTargetResult {
	status: string;
	platform: string;
	accounts: Array<{
		id: string;
		username: string | null;
		url: string | null;
	}>;
	error?: { code: string; message: string; detail?: string };
}

type TerminalPostStatus = "published" | "failed" | "partial";

interface PublishBatchResult {
	targets: Record<string, PublishTargetResult>;
	finalStatus: TerminalPostStatus | null;
}

/**
 * Publishes a post to all resolved targets. Updates post_targets and post status in DB.
 * Returns a map of target key -> result for building the response.
 */
export async function publishToTargets(
	env: Env,
	postId: string,
	orgId: string,
	content: string | null,
	mediaItems: PublishRequest["media"],
	targetOptions: Record<string, Record<string, unknown>> | null,
	targets: PublishTargetInput[],
	parentLeaseId: string,
	notificationUserId: string | null,
): Promise<PublishBatchResult> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const parentWhere = and(
		eq(posts.id, postId),
		eq(posts.organizationId, orgId),
		eq(posts.status, "publishing"),
		eq(posts.publishLeaseId, parentLeaseId),
	);
	const parentFence = sql`EXISTS (
		SELECT 1 FROM posts AS publish_parent
		WHERE publish_parent.id = ${postId}
			AND publish_parent.organization_id = ${orgId}
			AND publish_parent.status = 'publishing'
			AND publish_parent.publish_lease_id = ${parentLeaseId}
	)`;
	const responseTargets: Record<string, PublishTargetResult> = {};
	const successCounts: Record<string, number> = {};
	const activeCounts: Record<string, number> = {};
	const failureCounts: Record<string, number> = {};
	const unknownCounts: Record<string, number> = {};

	// Resolve the complete provider payload, including nested target options. A
	// legacy/corrupt Relay URL is converted into a definitive pre-boundary target
	// failure below and never reaches a provider.
	let mediaPolicyFailure: RelayMediaPolicyError | null = null;
	let resolvedMedia = mediaItems;
	let resolvedTargetOptions = targetOptions;
	try {
		const resolved = await resolveMediaUrls(
			db,
			env,
			mediaItems,
			targetOptions,
			orgId,
		);
		resolvedMedia = resolved.mediaItems;
		resolvedTargetOptions = resolved.targetOptions;
	} catch (error) {
		if (!(error instanceof RelayMediaPolicyError)) throw error;
		mediaPolicyFailure = error;
	}

	// Batch-fetch all account details upfront in one query
	const allAccountIds = [
		...new Set(targets.flatMap((t) => t.accounts.map((a) => a.id))),
	];
	const fullAccounts =
		allAccountIds.length > 0
			? await db
					.select()
					.from(socialAccounts)
					.where(
						and(
							inArray(socialAccounts.id, allAccountIds),
							eq(socialAccounts.organizationId, orgId),
							eq(socialAccounts.lifecycleStatus, "active"),
						),
					)
			: [];
	const accountMap = new Map(fullAccounts.map((a) => [a.id, a]));
	const targetStateRows =
		allAccountIds.length > 0
			? await db
					.select()
					.from(postTargets)
					.where(
						and(
							eq(postTargets.postId, postId),
							inArray(postTargets.socialAccountId, allAccountIds),
						),
					)
			: [];
	const targetStateByAccount = new Map(
		targetStateRows.map((row) => [row.socialAccountId, row]),
	);

	let immediateResultCount = 0;
	const recordPreBoundaryFailure = async (
		postTargetId: string,
		attemptId: string,
		publishOperationId: string,
		message: string,
		errorCode: string,
	): Promise<boolean> =>
		persistPublishTaskResult(db, {
			postId,
			organizationId: orgId,
			parentLeaseId,
			postTargetId,
			attemptId,
			publishOperationId,
			requestMayHaveBeenSent: false,
			result: {
				success: false,
				error: { code: errorCode, message },
			},
		});

	// Initialize response targets and collect publish tasks for parallel execution
	type PublishTask = {
		targetKey: string;
		platform: string;
		accountId: string;
		username: string | null;
		postTargetId: string;
		attemptId: string;
		publishOperationId: string;
		locallyStreamsMedia: boolean;
		task: () => Promise<PublishResult>;
	};
	const publishTasks: PublishTask[] = [];

	for (const target of targets) {
		const publisher = getPublisher(target.platform);

		let entry = responseTargets[target.key];
		if (!entry) {
			entry = {
				status: "published",
				platform: target.platform,
				accounts: [],
			};
			responseTargets[target.key] = entry;
		}

		for (const account of target.accounts) {
			const targetState = targetStateByAccount.get(account.id);
			if (!targetState) continue;
			const attemptId = generateId("pat_");
			const claimedAt = new Date();
			const leaseExpiresAt = new Date(claimedAt.getTime() + 5 * 60 * 1000);
			const claimedTarget = await db.transaction(async (tx) => {
				const rows = await tx
					.update(postTargets)
					.set({
						status: "publishing",
						deliveryState: "in_flight",
						attemptId,
						claimedAt,
						leaseExpiresAt,
						updatedAt: claimedAt,
					})
					.where(
						and(
							eq(postTargets.id, targetState.id),
							or(
								eq(postTargets.deliveryState, "queued"),
								and(
									eq(postTargets.deliveryState, "in_flight"),
									isNull(postTargets.requestMayHaveBeenSentAt),
									or(
										isNull(postTargets.leaseExpiresAt),
										lt(postTargets.leaseExpiresAt, claimedAt),
									),
								),
							),
							parentFence,
						),
					)
					.returning({
						id: postTargets.id,
						publishOperationId: postTargets.publishOperationId,
					});
				const claimed = rows[0];
				if (!claimed) return null;
				await tx.insert(publishAttempts).values({
					id: attemptId,
					publishOperationId: claimed.publishOperationId,
					postTargetId: claimed.id,
					state: "in_flight",
					claimedAt,
					leaseExpiresAt,
				});
				return claimed;
			});
			if (!claimedTarget) continue;

			if (mediaPolicyFailure) {
				const recorded = await recordPreBoundaryFailure(
					claimedTarget.id,
					attemptId,
					claimedTarget.publishOperationId,
					mediaPolicyFailure.message,
					"MEDIA_NOT_READY",
				);
				if (!recorded) continue;
				immediateResultCount++;
				entry.accounts.push({
					id: account.id,
					username: account.username,
					url: null,
				});
				failureCounts[target.key] = (failureCounts[target.key] ?? 0) + 1;
				entry.status = "failed";
				entry.error = {
					code: "MEDIA_NOT_READY",
					message: mediaPolicyFailure.message,
				};
				continue;
			}

			if (!publisher) {
				const failureMessage = `Platform ${target.platform} not supported`;
				const recorded = await recordPreBoundaryFailure(
					claimedTarget.id,
					attemptId,
					claimedTarget.publishOperationId,
					failureMessage,
					"PLATFORM_NOT_SUPPORTED",
				);
				if (!recorded) continue;
				immediateResultCount++;
				entry.accounts.push({
					id: account.id,
					username: account.username,
					url: null,
				});
				failureCounts[target.key] = (failureCounts[target.key] ?? 0) + 1;
				entry.status = "failed";
				entry.error = {
					code: "PLATFORM_NOT_SUPPORTED",
					message: `Publishing to ${target.platform} is not yet supported.`,
				};
				continue;
			}

			const fullAccount = accountMap.get(account.id);
			if (!fullAccount) continue;

			let targetOpts =
				(resolvedTargetOptions?.[target.key] as Record<string, unknown>) ?? {};
			if (target.platform === "sms") {
				const phoneNumbers = Array.isArray(targetOpts.phone_numbers)
					? targetOpts.phone_numbers.filter(
							(value): value is string => typeof value === "string",
						)
					: [];
				const purpose =
					typeof targetOpts.consent_purpose === "string"
						? targetOpts.consent_purpose
						: "marketing";
				const allowedHashes = await getAllowedRecipientHashes(
					db,
					orgId,
					"sms",
					purpose,
					phoneNumbers.map((identifier) => ({ identifier })),
				);
				const authorizedPhones: string[] = [];
				for (const phone of phoneNumbers) {
					if (allowedHashes.has(await hashRecipientIdentifier("sms", phone))) {
						authorizedPhones.push(phone);
					}
				}
				if (authorizedPhones.length === 0) {
					const recorded = await recordPreBoundaryFailure(
						claimedTarget.id,
						attemptId,
						claimedTarget.publishOperationId,
						"SMS consent required",
						"CONSENT_REQUIRED",
					);
					if (!recorded) continue;
					immediateResultCount++;
					entry.accounts.push({
						id: account.id,
						username: account.username,
						url: null,
					});
					failureCounts[target.key] = (failureCounts[target.key] ?? 0) + 1;
					entry.status = "failed";
					entry.error = {
						code: "CONSENT_REQUIRED",
						message: "No SMS recipient has current consent for this purpose.",
					};
					continue;
				}
				targetOpts = { ...targetOpts, phone_numbers: authorizedPhones };
			}

			// Queue publish task for parallel execution (with inline token refresh retry)
			const isMultiPostOperation =
				(target.platform === "twitter" || target.platform === "threads") &&
				Array.isArray(targetOpts.thread) &&
				targetOpts.thread.length > 0;
			publishTasks.push({
				targetKey: target.key,
				platform: target.platform,
				accountId: account.id,
				username: account.username,
				postTargetId: claimedTarget.id,
				attemptId,
				publishOperationId: claimedTarget.publishOperationId,
				locallyStreamsMedia: publishOperationLocallyStreamsMedia(
					target.platform,
					resolvedMedia,
					targetOpts,
				),
				task: async () => {
					let requestMayHaveBeenSent = false;
					try {
						let accessToken =
							target.platform === "telegram"
								? (env.TELEGRAM_BOT_TOKEN ??
									(await decryptAccountToken(
										fullAccount.accessToken,
										env.ENCRYPTION_KEY,
										fullAccount.id,
										"access_token",
									)) ??
									"")
								: await refreshTokenIfNeeded(env, {
										id: fullAccount.id,
										platform: target.platform,
										accessToken: fullAccount.accessToken,
										refreshToken: fullAccount.refreshToken,
										tokenExpiresAt: fullAccount.tokenExpiresAt,
									});

						let tokenRefreshRetries = 0;
						let rateLimitRetries = 0;
						let attempt = 0;
						while (true) {
							const leaseRenewedAt = new Date();
							const [renewedParent] = await db
								.update(posts)
								.set({
									publishLeaseExpiresAt: new Date(
										leaseRenewedAt.getTime() + PUBLISH_PARENT_LEASE_MS,
									),
									revision: sql`${posts.revision} + 1`,
								})
								.where(parentWhere)
								.returning({ id: posts.id });
							if (!renewedParent) throw new PostPublishLeaseLostError();
							const requestBoundary = new Date();
							await db.transaction(async (tx) => {
								const [boundary] = await tx
									.update(postTargets)
									.set({
										deliveryState: "unknown",
										requestMayHaveBeenSentAt: requestBoundary,
										updatedAt: requestBoundary,
									})
									.where(
										and(
											eq(postTargets.id, claimedTarget.id),
											eq(postTargets.attemptId, attemptId),
											parentFence,
										),
									)
									.returning({ id: postTargets.id });
								if (!boundary) throw new PostPublishLeaseLostError();
								await tx
									.update(publishAttempts)
									.set({
										state: "unknown",
										requestMayHaveBeenSentAt: requestBoundary,
									})
									.where(eq(publishAttempts.id, attemptId));
							});
							requestMayHaveBeenSent = true;
							const publishStart = Date.now();
							console.log(
								`[publisher-runner] Publishing to ${target.platform} for account ${account.id}${attempt > 0 ? ` (retry ${attempt})` : ""}...`,
							);
							const result = await publisher.publish({
								operation_id: claimedTarget.publishOperationId,
								content,
								media: resolvedMedia,
								target_options: targetOpts,
								account: {
									id: fullAccount.id,
									platform: target.platform,
									access_token: accessToken,
									refresh_token: null,
									platform_account_id: fullAccount.platformAccountId,
									username: fullAccount.username,
									metadata: fullAccount.metadata as Record<
										string,
										unknown
									> | null,
								},
							});
							console.log(
								`[publisher-runner] ${target.platform} publish completed in ${Date.now() - publishStart}ms: ${result.success ? "success" : "failed"} ${result.error?.message ?? ""}`,
							);

							// If TOKEN_EXPIRED and we haven't exhausted retries, refresh and retry
							if (
								canRetryTokenExpiredPublish(result, isMultiPostOperation) &&
								tokenRefreshRetries < 1
							) {
								console.log(
									`[publisher-runner] Token expired for ${target.platform} account ${account.id}, refreshing and retrying...`,
								);
								try {
									const refreshed = await forceRefreshToken(
										env,
										fullAccount.id,
									);
									if (refreshed.refreshed) {
										accessToken = refreshed.accessToken;
										tokenRefreshRetries++;
										attempt++;
										continue; // retry with the coordinator's CAS-persisted token
									}
								} catch (refreshErr) {
									console.error(
										`[publisher-runner] Token refresh failed for ${target.platform} account ${account.id}:`,
										refreshErr,
									);
								}
							}

							const rateLimitDelay = getDefinitiveRateLimitRetryDelay(
								result,
								rateLimitRetries,
							);
							if (rateLimitDelay !== null) {
								rateLimitRetries++;
								attempt++;
								console.log(
									`[publisher-runner] Provider definitively rejected ${target.platform} publish; retrying in ${rateLimitDelay}ms`,
								);
								await new Promise((resolve) =>
									setTimeout(resolve, rateLimitDelay),
								);
								continue;
							}

							return result;
						}
					} catch (error) {
						throw new PublishBoundaryError(error, requestMayHaveBeenSent);
					}
				},
			});
		}
	}

	if (publishTasks.length === 0 && immediateResultCount === 0) {
		return { targets: {}, finalStatus: null };
	}

	// Providers that locally stream/re-chunk media are serialized so only one
	// bounded media graph is active for this post. URL-forwarding providers and
	// text-only work retain higher parallelism, including when another target in
	// the same post carries media. This avoids the previous all-target slowdown.
	type SettledPublishResult = PromiseSettledResult<
		Awaited<ReturnType<PublishTask["task"]>>
	>;
	const normalizeSettledResult = (
		settled: SettledPublishResult,
	): { result: PublishResult; requestMayHaveBeenSent: boolean } => {
		if (settled.status === "fulfilled") {
			return { result: settled.value, requestMayHaveBeenSent: true };
		}
		const requestMayHaveBeenSent =
			settled.reason instanceof PublishBoundaryError &&
			settled.reason.requestMayHaveBeenSent;
		return {
			requestMayHaveBeenSent,
			result: {
				success: false,
				error: {
					code: classifyPublishTaskRejection(settled.reason),
					message:
						settled.reason instanceof Error
							? settled.reason.message
							: String(settled.reason ?? "Unknown error"),
				},
			},
		};
	};
	const persistAndRecordResult = async (
		task: PublishTask,
		settled: SettledPublishResult,
	): Promise<boolean> => {
		const { result, requestMayHaveBeenSent } = normalizeSettledResult(settled);
		const persisted = await persistPublishTaskResult(db, {
			postId,
			organizationId: orgId,
			parentLeaseId,
			postTargetId: task.postTargetId,
			attemptId: task.attemptId,
			publishOperationId: task.publishOperationId,
			requestMayHaveBeenSent,
			result,
		});
		if (!persisted) return false;

		const entry = responseTargets[task.targetKey];
		if (!entry) return true;
		const providerOutcome = normalizeProviderOutcome(result);
		if (isTerminalProviderSuccess(providerOutcome)) {
			entry.accounts.push({
				id: task.accountId,
				username: task.username,
				url: providerOutcome.platform_url ?? result.platform_url ?? null,
			});
			successCounts[task.targetKey] = (successCounts[task.targetKey] ?? 0) + 1;
		} else if (isNonTerminalProviderOutcome(providerOutcome)) {
			entry.accounts.push({
				id: task.accountId,
				username: task.username,
				url: providerOutcome.platform_url ?? null,
			});
			activeCounts[task.targetKey] = (activeCounts[task.targetKey] ?? 0) + 1;
		} else if (requiresPublishOutcomeReconciliation(result)) {
			entry.accounts.push({
				id: task.accountId,
				username: task.username,
				url: null,
			});
			unknownCounts[task.targetKey] = (unknownCounts[task.targetKey] ?? 0) + 1;
			entry.error ??= {
				code: "PUBLISH_OUTCOME_UNKNOWN",
				message:
					"The provider may have accepted this post; manual reconciliation is required.",
			};
		} else {
			entry.accounts.push({
				id: task.accountId,
				username: task.username,
				url: null,
			});
			failureCounts[task.targetKey] = (failureCounts[task.targetKey] ?? 0) + 1;
			entry.error ??= result.error;
		}
		return true;
	};
	const locallyStreamingTasks = publishTasks.filter(
		(task) => task.locallyStreamsMedia,
	);
	const lightweightTasks = publishTasks.filter(
		(task) => !task.locallyStreamsMedia,
	);
	const persistResult = createPublishResultPersistenceGate();
	let persistenceFailed = false;
	let persistenceError: unknown;
	const runTask = async (task: PublishTask): Promise<void> => {
		try {
			await settleAndPersistPublishTask(task.task, (settled) =>
				persistResult(() => persistAndRecordResult(task, settled)),
			);
		} catch (error) {
			// Continue draining the bounded provider batch so every already-claimed
			// target gets one persistence attempt. The first storage failure is thrown
			// only after the remaining settled results have been durably recorded.
			persistenceFailed = true;
			persistenceError ??= error;
		}
	};
	await Promise.all([
		mapConcurrently(locallyStreamingTasks, MEDIA_TARGET_CONCURRENCY, runTask),
		mapConcurrently(lightweightTasks, TEXT_TARGET_CONCURRENCY, runTask),
	]);
	if (persistenceFailed) {
		throw persistenceError ?? new Error("Publish result persistence failed");
	}

	// Compute per-target status
	for (const target of targets) {
		const entry = responseTargets[target.key];
		if (!entry) continue;
		const hasSuccess = (successCounts[target.key] ?? 0) > 0;
		const hasActive = (activeCounts[target.key] ?? 0) > 0;
		const hasFailure = (failureCounts[target.key] ?? 0) > 0;
		const hasUnknown = (unknownCounts[target.key] ?? 0) > 0;
		const hasAttempts = entry.accounts.length > 0;
		if (!hasAttempts) {
			entry.status = "failed";
		} else if (hasActive) {
			entry.status = "publishing";
		} else if (hasUnknown) {
			entry.status = "unknown";
		} else if (hasSuccess && hasFailure) {
			entry.status = "partial";
		} else if (hasFailure) {
			entry.status = "failed";
		} else {
			entry.status = "published";
		}
	}

	// Compute final status from the FULL set of post_targets rows in the DB, not
	// just the in-memory subset passed to this call. Retry/partial paths only pass
	// the previously-failed targets, so deriving status from `responseTargets` alone
	// would wrongly flip a partially-live post to "failed" (wiping publishedAt and
	// firing post.failed while content is still live). Reading the persisted rows
	// after the result transactions keeps full-set callers behavior-identical while
	// fixing retry.
	const allTargetRows = await db
		.select({
			status: postTargets.status,
			publishedAt: postTargets.publishedAt,
			deliveryState: postTargets.deliveryState,
			platform: postTargets.platform,
		})
		.from(postTargets)
		.where(eq(postTargets.postId, postId));

	const aggregateState = classifyPersistedPostTargets(allTargetRows);
	if (aggregateState === "active") {
		// A fenced result transition did not complete (or another target is still
		// active). Never manufacture a terminal partial result while work remains.
		return { targets: responseTargets, finalStatus: null };
	}
	if (aggregateState === "unknown") {
		const [savedPost] = await db
			.update(posts)
			.set({
				status: "publishing",
				terminalReason: {
					code: "PUBLISH_OUTCOME_UNKNOWN",
					message:
						"At least one provider request has an unknown outcome and will not be retried automatically.",
				},
				publishLeaseId: null,
				publishLeaseExpiresAt: null,
				revision: sql`${posts.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(parentWhere)
			.returning({ id: posts.id });
		if (!savedPost) return { targets: responseTargets, finalStatus: null };
		await notifyRealtime(env, orgId, {
			type: "post.updated",
			post_id: postId,
			status: "publishing",
		});
		return { targets: responseTargets, finalStatus: null };
	}

	// Guard: a post always has at least one target row. An empty set here means the
	// post has no targets at all (e.g. its only account was disconnected, deleting
	// the rows). `[].every(...)` is vacuously true, which would falsely mark the post
	// "published" and fire a post.published webhook for zero publishes — bail to
	// "failed" instead.
	if (aggregateState === "empty") {
		const occurrenceId = `post:${postId}:publish:${parentLeaseId}:failed`;
		const finalizedAt = new Date();
		const persisted = await db.transaction(async (tx) => {
			const [savedPost] = await tx
				.update(posts)
				.set({
					status: "failed",
					publishedAt: null,
					publishLeaseId: null,
					publishLeaseExpiresAt: null,
					revision: sql`${posts.revision} + 1`,
					updatedAt: finalizedAt,
				})
				.where(parentWhere)
				.returning({ id: posts.id });
			if (!savedPost) return null;
			const webhook = await persistWebhookEventInTransaction(
				tx,
				orgId,
				"post.failed",
				{
					post_id: postId,
					status: "failed",
					targets: responseTargets,
				},
				{
					occurrenceId,
				},
			);
			const completion = postCompletionOutboxRow({
				postId,
				organizationId: orgId,
				userId: notificationUserId,
				status: "failed",
				occurrenceId,
				platforms: allTargetRows.map((target) => target.platform),
				occurredAt: finalizedAt,
			});
			if (completion) {
				await tx.insert(publishOutbox).values(completion).onConflictDoNothing();
			}
			return webhook;
		});
		if (!persisted) return { targets: responseTargets, finalStatus: null };
		await enqueuePersistedWebhookEvent(env, db, persisted);
		await notifyRealtime(env, orgId, {
			type: "post.updated",
			post_id: postId,
			status: "failed",
		});
		return { targets: responseTargets, finalStatus: "failed" };
	}

	const finalStatus = aggregateState;

	// Preserve an existing publishedAt for partial posts (some targets are already
	// live) instead of nulling it. Only set/clear when transitioning to a terminal
	// all-published / all-failed state.
	const existingPublishedAt =
		allTargetRows.find((r) => r.publishedAt)?.publishedAt ?? null;

	const webhookEvent =
		finalStatus === "published"
			? "post.published"
			: finalStatus === "failed"
				? "post.failed"
				: "post.partial";

	const occurrenceId = `post:${postId}:publish:${parentLeaseId}:${finalStatus}`;
	const finalizedAt = new Date();
	const persisted = await db.transaction(async (tx) => {
		const [savedPost] = await tx
			.update(posts)
			.set({
				status: finalStatus,
				publishedAt:
					finalStatus === "published"
						? finalizedAt
						: finalStatus === "partial"
							? existingPublishedAt
							: null,
				publishLeaseId: null,
				publishLeaseExpiresAt: null,
				revision: sql`${posts.revision} + 1`,
				updatedAt: finalizedAt,
			})
			.where(parentWhere)
			.returning({ id: posts.id });
		if (!savedPost) return null;
		const webhook = await persistWebhookEventInTransaction(
			tx,
			orgId,
			webhookEvent,
			{
				post_id: postId,
				status: finalStatus,
				targets: responseTargets,
			},
			{
				occurrenceId,
			},
		);
		const completion = postCompletionOutboxRow({
			postId,
			organizationId: orgId,
			userId: notificationUserId,
			status: finalStatus,
			occurrenceId,
			platforms: allTargetRows.map((target) => target.platform),
			occurredAt: finalizedAt,
		});
		if (completion) {
			await tx.insert(publishOutbox).values(completion).onConflictDoNothing();
		}
		return webhook;
	});
	if (!persisted) return { targets: responseTargets, finalStatus: null };
	const terminalFollowUps: Promise<unknown>[] = [
		enqueuePersistedWebhookEvent(env, db, persisted),
		notifyRealtime(env, orgId, {
			type: "post.updated",
			post_id: postId,
			status: finalStatus,
		}),
	];
	const terminalFollowUpResults = await Promise.allSettled(terminalFollowUps);
	if (terminalFollowUpResults.some((result) => result.status === "rejected")) {
		// Webhook source rows are durable and their pending dispatcher recovers a
		// failed handoff. Realtime delivery is intentionally best-effort.
		console.error("[publisher-runner] post-terminal follow-up failed", {
			postId,
			status: finalStatus,
		});
	}

	return { targets: responseTargets, finalStatus };
}

/**
 * Finalize a post's status purely from its persisted post_targets rows, then
 * dispatch the matching webhook and realtime notification. Used to recover posts
 * that were claimed into "publishing" but whose targets are all already terminal
 * (e.g. a previous attempt crashed after publishing every target but before the
 * post-level status update). Prevents posts being abandoned in "publishing".
 */
async function finalizePostStatusFromTargets(
	env: Env,
	db: ReturnType<typeof createDb>,
	postId: string,
	orgId: string,
	parentLeaseId: string,
	notificationUserId: string | null,
): Promise<TerminalPostStatus | null> {
	const parentWhere = and(
		eq(posts.id, postId),
		eq(posts.organizationId, orgId),
		eq(posts.status, "publishing"),
		eq(posts.publishLeaseId, parentLeaseId),
	);
	const allTargetRows = await db
		.select({
			status: postTargets.status,
			publishedAt: postTargets.publishedAt,
			deliveryState: postTargets.deliveryState,
			platform: postTargets.platform,
		})
		.from(postTargets)
		.where(eq(postTargets.postId, postId));

	const aggregateState = classifyPersistedPostTargets(allTargetRows);
	if (aggregateState === "active") {
		// Another target attempt is still actionable or within its lease. It is not
		// a terminal partial result and must not emit a post-level webhook.
		return null;
	}
	if (aggregateState === "unknown") {
		await db
			.update(posts)
			.set({
				status: "publishing",
				terminalReason: {
					code: "PUBLISH_OUTCOME_UNKNOWN",
					message: "Provider outcome is unknown; automatic replay is disabled.",
				},
				publishLeaseId: null,
				publishLeaseExpiresAt: null,
				revision: sql`${posts.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(parentWhere);
		return null;
	}
	if (aggregateState === "empty") {
		const occurrenceId = `post:${postId}:publish:${parentLeaseId}:failed`;
		const finalizedAt = new Date();
		const persisted = await db.transaction(async (tx) => {
			const [savedPost] = await tx
				.update(posts)
				.set({
					status: "failed",
					publishedAt: null,
					publishLeaseId: null,
					publishLeaseExpiresAt: null,
					revision: sql`${posts.revision} + 1`,
					updatedAt: finalizedAt,
				})
				.where(parentWhere)
				.returning({ id: posts.id });
			if (!savedPost) return null;
			const webhook = await persistWebhookEventInTransaction(
				tx,
				orgId,
				"post.failed",
				{ post_id: postId, status: "failed" },
				{ occurrenceId },
			);
			const completion = postCompletionOutboxRow({
				postId,
				organizationId: orgId,
				userId: notificationUserId,
				status: "failed",
				occurrenceId,
				platforms: allTargetRows.map((target) => target.platform),
				occurredAt: finalizedAt,
			});
			if (completion) {
				await tx.insert(publishOutbox).values(completion).onConflictDoNothing();
			}
			return webhook;
		});
		if (!persisted) return null;
		await enqueuePersistedWebhookEvent(env, db, persisted);
		await notifyRealtime(env, orgId, {
			type: "post.updated",
			post_id: postId,
			status: "failed",
		});
		return "failed";
	}

	const finalStatus = aggregateState;
	const existingPublishedAt =
		allTargetRows.find((r) => r.publishedAt)?.publishedAt ?? null;

	const webhookEvent =
		finalStatus === "published"
			? "post.published"
			: finalStatus === "failed"
				? "post.failed"
				: "post.partial";
	const occurrenceId = `post:${postId}:publish:${parentLeaseId}:${finalStatus}`;
	const finalizedAt = new Date();
	const persisted = await db.transaction(async (tx) => {
		const [savedPost] = await tx
			.update(posts)
			.set({
				status: finalStatus,
				publishedAt:
					finalStatus === "published"
						? (existingPublishedAt ?? finalizedAt)
						: finalStatus === "partial"
							? existingPublishedAt
							: null,
				publishLeaseId: null,
				publishLeaseExpiresAt: null,
				revision: sql`${posts.revision} + 1`,
				updatedAt: finalizedAt,
			})
			.where(parentWhere)
			.returning({ id: posts.id });
		if (!savedPost) return null;
		const webhook = await persistWebhookEventInTransaction(
			tx,
			orgId,
			webhookEvent,
			{ post_id: postId, status: finalStatus },
			{ occurrenceId },
		);
		const completion = postCompletionOutboxRow({
			postId,
			organizationId: orgId,
			userId: notificationUserId,
			status: finalStatus,
			occurrenceId,
			platforms: allTargetRows.map((target) => target.platform),
			occurredAt: existingPublishedAt ?? finalizedAt,
		});
		if (completion) {
			await tx.insert(publishOutbox).values(completion).onConflictDoNothing();
		}
		return webhook;
	});
	if (!persisted) return null;
	const recoveryFollowUps: Promise<unknown>[] = [
		enqueuePersistedWebhookEvent(env, db, persisted),
		notifyRealtime(env, orgId, {
			type: "post.updated",
			post_id: postId,
			status: finalStatus,
		}),
	];
	const recoveryFollowUpResults = await Promise.allSettled(recoveryFollowUps);
	if (recoveryFollowUpResults.some((result) => result.status === "rejected")) {
		console.error("[publisher-runner] recovery follow-up failed", {
			postId,
			status: finalStatus,
		});
	}
	return finalStatus;
}

/**
 * Publishes a post by ID — used by queue consumer and scheduler.
 */
export async function publishPostById(
	env: Env,
	postId: string,
	orgId: string,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const [post] = await db
		.select()
		.from(posts)
		.where(and(eq(posts.id, postId), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) return;
	if (["published", "failed", "partial"].includes(post.status)) return;
	if (!["scheduled", "publishing"].includes(post.status)) return;

	// Atomically claim a durable parent lease. The monotonic revision CAS elects one winner
	// among simultaneous deliveries, while the lease prevents a later redelivery
	// from re-claiming an already-publishing parent. Expired leases are recovered by
	// the bounded publish reconciler.
	const claimNow = new Date();
	const parentLeaseId = crypto.randomUUID();
	const [claimed] = await db
		.update(posts)
		.set({
			status: "publishing",
			publishLeaseId: parentLeaseId,
			publishLeaseExpiresAt: new Date(
				claimNow.getTime() + PUBLISH_PARENT_LEASE_MS,
			),
			publishAttempts: sql`${posts.publishAttempts} + 1`,
			revision: sql`${posts.revision} + 1`,
			updatedAt: claimNow,
		})
		.where(
			and(
				eq(posts.id, postId),
				eq(posts.organizationId, orgId),
				eq(posts.status, post.status),
				eq(posts.revision, post.revision),
				or(
					isNull(posts.publishLeaseExpiresAt),
					lt(posts.publishLeaseExpiresAt, claimNow),
				),
			),
		)
		.returning({ id: posts.id });

	if (!claimed) return;

	// Get all targets
	const targets = await db
		.select()
		.from(postTargets)
		.where(eq(postTargets.postId, postId));

	// Filter to actionable (not-yet-terminal) targets
	const now = new Date();
	const actionableTargets = targets.filter(
		(t) =>
			t.deliveryState === "queued" ||
			(t.deliveryState === "in_flight" &&
				t.requestMayHaveBeenSentAt == null &&
				(t.leaseExpiresAt?.getTime() ?? 0) < now.getTime()),
	);

	// Recovery / idempotency guard: if some targets are already published but others
	// remain actionable (a previous attempt crashed after publishing a subset), do NOT
	// bail silently — that would leave the post stuck in "publishing" forever. Resume by
	// publishing only the remaining actionable targets below. If NO actionable targets
	// remain (every target is already in a terminal published/failed state), finalize the
	// post status from the persisted target rows instead of abandoning it.
	if (actionableTargets.length === 0) {
		await finalizePostStatusFromTargets(
			env,
			db,
			postId,
			orgId,
			parentLeaseId,
			post.createdBy,
		);
		return;
	}

	// Batch-fetch all social accounts in one query
	const accountIds = [
		...new Set(actionableTargets.map((t) => t.socialAccountId)),
	];
	const accountRows =
		accountIds.length > 0
			? await db
					.select({
						id: socialAccounts.id,
						username: socialAccounts.username,
					})
					.from(socialAccounts)
					.where(
						and(
							inArray(socialAccounts.id, accountIds),
							eq(socialAccounts.organizationId, orgId),
							eq(socialAccounts.lifecycleStatus, "active"),
						),
					)
			: [];
	const accountMap = new Map(accountRows.map((a) => [a.id, a]));

	// Group targets by platform
	const targetMap = new Map<string, PublishTargetInput>();
	for (const t of actionableTargets) {
		const account = accountMap.get(t.socialAccountId);
		if (!account) continue;

		const key = t.platform;
		const existing = targetMap.get(key);
		if (existing) {
			existing.accounts.push(account);
		} else {
			targetMap.set(key, {
				key,
				platform: t.platform as Platform,
				accounts: [account],
			});
		}
	}

	// Guard: if no target resolved to a live account (every actionable target's
	// social account was deleted or is missing), there is nothing to publish. Do NOT
	// call publishToTargets with an empty set — finalize the post from its persisted
	// target rows so it is not abandoned in "publishing" and no false post.published
	// is emitted.
	if (targetMap.size === 0) {
		const missingAccountTargetIds = actionableTargets.map(
			(target) => target.id,
		);
		if (missingAccountTargetIds.length > 0) {
			await db
				.update(postTargets)
				.set({
					status: "failed",
					deliveryState: "failed",
					error: "Connected account is no longer available",
					errorCode: "ACCOUNT_NOT_AVAILABLE",
					updatedAt: new Date(),
				})
				.where(
					and(
						inArray(postTargets.id, missingAccountTargetIds),
						sql`EXISTS (
							SELECT 1 FROM posts AS publish_parent
							WHERE publish_parent.id = ${postId}
								AND publish_parent.organization_id = ${orgId}
								AND publish_parent.publish_lease_id = ${parentLeaseId}
						)`,
					),
				);
		}
		await finalizePostStatusFromTargets(
			env,
			db,
			postId,
			orgId,
			parentLeaseId,
			post.createdBy,
		);
		return;
	}

	const overrides = (post.platformOverrides as Record<string, unknown>) ?? {};

	// Media URLs are stored under the _media key in platformOverrides at creation time.
	// Extract them and remove _media from the target overrides passed to publishers.
	const mediaItems = (
		Array.isArray(overrides._media) ? overrides._media : []
	) as PublishRequest["media"];

	const { _media: _, ...restOverrides } = overrides;
	const targetOverrides = (
		Object.keys(restOverrides).length > 0 ? restOverrides : null
	) as Record<string, Record<string, unknown>> | null;

	const result = await publishToTargets(
		env,
		postId,
		orgId,
		post.content,
		mediaItems,
		targetOverrides,
		Array.from(targetMap.values()),
		parentLeaseId,
		post.createdBy,
	);
	if (Object.keys(result.targets).length === 0 && !result.finalStatus) {
		await finalizePostStatusFromTargets(
			env,
			db,
			postId,
			orgId,
			parentLeaseId,
			post.createdBy,
		);
	}
}
