import {
	createDb,
	type Database,
	inboxMessages,
	postTargets,
	socialAccounts,
	socialMutationOperations,
	whatsappGroups,
} from "@relayapi/db";
import { and, asc, eq, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import { decryptToken, encryptToken } from "../lib/crypto";
import type { Env } from "../types";
import {
	MAX_SOCIAL_PROJECTION_ATTEMPTS,
	resumeConfirmedSocialProjection,
	type SocialMutationOperation,
} from "./social-mutation-operations";
import type { SocialProviderActionResult } from "./social-provider-actions";
import { refreshTokenIfNeeded } from "./token-refresh-coordinator";
import { getWhatsAppGroupInviteLink } from "./whatsapp-admin-provider";

const MAX_RECONCILE_BATCH = 50;

type ProjectionIdentity = Pick<
	SocialMutationOperation,
	"organizationId" | "targetType" | "targetId" | "kind"
>;

function projectionContext(identity: ProjectionIdentity) {
	return {
		recordId: [
			identity.organizationId,
			identity.targetType,
			identity.targetId,
			identity.kind,
		].join(":"),
		field: "social_mutation_projection_payload",
	};
}

/** Encrypt provider-confirmed content needed only for durable local replay. */
export async function encryptSocialProjectionPayload(
	encryptionKey: string,
	identity: ProjectionIdentity,
	payload: Record<string, unknown>,
): Promise<string> {
	return encryptToken(
		JSON.stringify(payload),
		encryptionKey,
		projectionContext(identity),
	);
}

export async function decryptSocialProjectionPayload(
	encryptionKey: string,
	identity: ProjectionIdentity,
	ciphertext: string,
): Promise<Record<string, unknown>> {
	const plaintext = await decryptToken(
		ciphertext,
		encryptionKey,
		projectionContext(identity),
	);
	const parsed = JSON.parse(plaintext) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Social mutation projection payload is invalid");
	}
	return parsed as Record<string, unknown>;
}

function requiredString(
	value: unknown,
	field: string,
	maxLength = 40_000,
): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength
	) {
		throw new Error(`Social mutation ${field} is invalid`);
	}
	return value;
}

async function projectionPayload(
	env: Env,
	operation: SocialMutationOperation,
): Promise<Record<string, unknown>> {
	const ciphertext = requiredString(
		operation.requestPayload.projection_payload_ciphertext,
		"projection payload",
		200_000,
	);
	return decryptSocialProjectionPayload(
		env.ENCRYPTION_KEY,
		operation,
		ciphertext,
	);
}

function providerReplacementId(
	result: SocialProviderActionResult,
	fallback: string,
): string {
	return result.providerId && result.providerId.length <= 512
		? result.providerId
		: fallback;
}

async function projectPublishedEdit(
	db: Database,
	env: Env,
	operation: SocialMutationOperation,
	result: SocialProviderActionResult,
): Promise<void> {
	const payload = await projectionPayload(env, operation);
	const content = requiredString(payload.content, "content");
	const postId = requiredString(
		operation.requestPayload.post_id,
		"post id",
		128,
	);
	const expectedProviderId = requiredString(
		operation.requestPayload.expected_provider_post_id,
		"expected provider post id",
		512,
	);
	const expectedRevision = Number(
		operation.requestPayload.expected_edit_revision,
	);
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
		throw new Error("Social mutation expected edit revision is invalid");
	}
	const replacementId = providerReplacementId(result, expectedProviderId);
	const [target] = await db
		.select()
		.from(postTargets)
		.where(
			and(
				eq(postTargets.id, operation.targetId),
				eq(postTargets.postId, postId),
				eq(postTargets.organizationId, operation.organizationId),
				eq(postTargets.socialAccountId, operation.accountId),
				eq(postTargets.platform, operation.platform),
			),
		)
		.limit(1);
	if (!target) return;
	const confirmedAt = operation.providerConfirmedAt;
	if (!confirmedAt) throw new Error("Provider confirmation is missing");
	if (
		target.platformPostId === replacementId &&
		target.confirmedContent === content &&
		target.editRevision === expectedRevision + 1 &&
		target.lastEditedAt &&
		target.lastEditedAt >= confirmedAt
	) {
		return;
	}
	if (target.platformPostId !== expectedProviderId) {
		throw new Error("Published target provider identity changed");
	}
	if (target.editRevision !== expectedRevision) {
		throw new Error("Published target edit revision changed");
	}
	const history = target.platformPostIdHistory ?? [];
	const projectedAt = new Date();
	const [updated] = await db
		.update(postTargets)
		.set({
			platformPostId: replacementId,
			confirmedContent: content,
			editRevision: expectedRevision + 1,
			lastEditedAt: projectedAt,
			platformPostIdHistory:
				replacementId === expectedProviderId
					? history
					: [
							...history,
							{
								id: expectedProviderId,
								replaced_at: confirmedAt.toISOString(),
								operation_id: operation.id,
							},
						],
			updatedAt: projectedAt,
		})
		.where(
			and(
				eq(postTargets.id, target.id),
				eq(postTargets.organizationId, operation.organizationId),
				eq(postTargets.socialAccountId, operation.accountId),
				eq(postTargets.platform, operation.platform),
				eq(postTargets.platformPostId, expectedProviderId),
				eq(postTargets.editRevision, expectedRevision),
			),
		)
		.returning({ id: postTargets.id });
	if (!updated) throw new Error("Published target projection changed");
}

async function projectMessageEdit(
	db: Database,
	env: Env,
	operation: SocialMutationOperation,
): Promise<void> {
	const payload = await projectionPayload(env, operation);
	const text = requiredString(payload.text, "message text", 4096);
	const conversationId = requiredString(
		operation.requestPayload.conversation_id,
		"conversation id",
		128,
	);
	const expectedRevision = Number(
		operation.requestPayload.expected_edit_revision,
	);
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
		throw new Error("Social mutation expected edit revision is invalid");
	}
	const [message] = await db
		.select()
		.from(inboxMessages)
		.where(
			and(
				eq(inboxMessages.id, operation.targetId),
				eq(inboxMessages.conversationId, conversationId),
				eq(inboxMessages.organizationId, operation.organizationId),
				eq(inboxMessages.accountId, operation.accountId),
				eq(inboxMessages.platform, operation.platform),
			),
		)
		.limit(1);
	if (!message || message.deletedAt || message.contentRedactedAt) return;
	const confirmedAt = operation.providerConfirmedAt;
	if (!confirmedAt) throw new Error("Provider confirmation is missing");
	if (
		message.text === text &&
		message.editedAt &&
		message.editedAt >= confirmedAt
	) {
		return;
	}
	const projectedAt = new Date();
	const [updated] = await db
		.update(inboxMessages)
		.set({
			text,
			editRevision: expectedRevision + 1,
			editedAt: projectedAt,
			updatedAt: projectedAt,
		})
		.where(
			and(
				eq(inboxMessages.id, operation.targetId),
				eq(inboxMessages.conversationId, conversationId),
				eq(inboxMessages.organizationId, operation.organizationId),
				eq(inboxMessages.accountId, operation.accountId),
				eq(inboxMessages.platform, operation.platform),
				eq(inboxMessages.editRevision, expectedRevision),
			),
		)
		.returning({ id: inboxMessages.id });
	if (!updated) throw new Error("Message projection revision changed");
}

async function projectReadReceipt(
	db: Database,
	operation: SocialMutationOperation,
): Promise<void> {
	const conversationId = requiredString(
		operation.requestPayload.conversation_id,
		"conversation id",
		128,
	);
	const confirmedAt = operation.providerConfirmedAt;
	if (!confirmedAt) throw new Error("Provider confirmation is missing");
	await db
		.update(inboxMessages)
		.set({ providerReadAt: confirmedAt, updatedAt: new Date() })
		.where(
			and(
				eq(inboxMessages.id, operation.targetId),
				eq(inboxMessages.conversationId, conversationId),
				eq(inboxMessages.organizationId, operation.organizationId),
				eq(inboxMessages.accountId, operation.accountId),
				eq(inboxMessages.platform, operation.platform),
				or(
					sql`${inboxMessages.providerReadAt} IS NULL`,
					lt(inboxMessages.providerReadAt, confirmedAt),
				),
			),
		);
}

async function exactCommentProjection(
	db: Database,
	operation: SocialMutationOperation,
) {
	const commentId = requiredString(
		operation.requestPayload.comment_id,
		"comment id",
		512,
	);
	const [message] = await db
		.select()
		.from(inboxMessages)
		.where(
			and(
				eq(inboxMessages.organizationId, operation.organizationId),
				eq(inboxMessages.accountId, operation.accountId),
				eq(inboxMessages.platform, operation.platform),
				or(
					eq(inboxMessages.id, commentId),
					eq(inboxMessages.platformMessageId, commentId),
				),
			),
		)
		.limit(1);
	return { commentId, message };
}

async function projectCommentEdit(
	db: Database,
	env: Env,
	operation: SocialMutationOperation,
	result: SocialProviderActionResult,
): Promise<void> {
	const payload = await projectionPayload(env, operation);
	const text = requiredString(payload.text, "comment text", 10_000);
	const { commentId, message } = await exactCommentProjection(db, operation);
	if (!message || message.deletedAt || message.contentRedactedAt) return;
	const confirmedAt = operation.providerConfirmedAt;
	if (!confirmedAt) throw new Error("Provider confirmation is missing");
	const replacementId = providerReplacementId(result, commentId);
	if (
		message.text === text &&
		message.platformMessageId === replacementId &&
		message.editedAt &&
		message.editedAt >= confirmedAt
	) {
		return;
	}
	const projectedAt = new Date();
	const [updated] = await db
		.update(inboxMessages)
		.set({
			text,
			platformMessageId: replacementId,
			editRevision: message.editRevision + 1,
			editedAt: projectedAt,
			updatedAt: projectedAt,
		})
		.where(
			and(
				eq(inboxMessages.id, message.id),
				eq(inboxMessages.organizationId, operation.organizationId),
				eq(inboxMessages.accountId, operation.accountId),
				eq(inboxMessages.platform, operation.platform),
				eq(inboxMessages.editRevision, message.editRevision),
			),
		)
		.returning({ id: inboxMessages.id });
	if (!updated) throw new Error("Comment projection revision changed");
}

async function projectModeration(
	db: Database,
	operation: SocialMutationOperation,
): Promise<void> {
	const action = operation.requestPayload.action;
	if (action !== "hide" && action !== "unhide") return;
	const { message } = await exactCommentProjection(db, operation);
	if (!message) return;
	await db
		.update(inboxMessages)
		.set({
			isHidden: action === "hide",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(inboxMessages.id, message.id),
				eq(inboxMessages.organizationId, operation.organizationId),
				eq(inboxMessages.accountId, operation.accountId),
				eq(inboxMessages.platform, operation.platform),
			),
		);
}

async function loadWhatsAppAccount(
	db: Database,
	env: Env,
	operation: SocialMutationOperation,
) {
	const [account] = await db
		.select()
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, operation.accountId),
				eq(socialAccounts.organizationId, operation.organizationId),
				eq(socialAccounts.platform, "whatsapp"),
				eq(socialAccounts.lifecycleStatus, "active"),
				sql`${socialAccounts.workspaceId} IS NOT DISTINCT FROM ${operation.workspaceId}`,
			),
		)
		.limit(1);
	if (!account) throw new Error("WhatsApp account is no longer available");
	const accessToken = await refreshTokenIfNeeded(env, {
		id: account.id,
		platform: account.platform,
		accessToken: account.accessToken,
		refreshToken: account.refreshToken,
		tokenExpiresAt: account.tokenExpiresAt,
	});
	const metadata = account.metadata as Record<string, unknown> | null;
	return {
		phoneNumberId: account.platformAccountId,
		wabaId: typeof metadata?.waba_id === "string" ? metadata.waba_id : null,
		accessToken,
	};
}

async function projectWhatsAppGroup(
	db: Database,
	env: Env,
	operation: SocialMutationOperation,
	result: SocialProviderActionResult,
): Promise<void> {
	const [group] = await db
		.select()
		.from(whatsappGroups)
		.where(
			and(
				eq(whatsappGroups.id, operation.targetId),
				eq(whatsappGroups.organizationId, operation.organizationId),
				eq(whatsappGroups.accountId, operation.accountId),
				eq(whatsappGroups.platform, "whatsapp"),
				sql`${whatsappGroups.workspaceId} IS NOT DISTINCT FROM ${operation.workspaceId}`,
			),
		)
		.limit(1);
	if (!group) return;
	const confirmedAt = operation.providerConfirmedAt;
	if (!confirmedAt) throw new Error("Provider confirmation is missing");

	if (operation.kind === "group_create") {
		const webhookIsNewer = Boolean(
			group.lastSyncedAt && group.lastSyncedAt > confirmedAt,
		);
		await db
			.update(whatsappGroups)
			.set({
				providerGroupId: result.providerId ?? group.providerGroupId,
				providerRequestId:
					result.providerOperationId ?? group.providerRequestId,
				lifecycleStatus: webhookIsNewer
					? group.lifecycleStatus
					: result.providerId || group.providerGroupId
						? "active"
						: "creating",
				lastSyncedAt: webhookIsNewer ? group.lastSyncedAt : confirmedAt,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(whatsappGroups.id, group.id),
					eq(whatsappGroups.organizationId, operation.organizationId),
					eq(whatsappGroups.accountId, operation.accountId),
				),
			);
		return;
	}

	if (operation.kind === "group_delete") {
		if (group.lifecycleStatus === "deleted") return;
		await db
			.update(whatsappGroups)
			.set({ lifecycleStatus: "deleting", updatedAt: new Date() })
			.where(
				and(
					eq(whatsappGroups.id, group.id),
					eq(whatsappGroups.organizationId, operation.organizationId),
					eq(whatsappGroups.accountId, operation.accountId),
				),
			);
		return;
	}

	if (operation.kind !== "group_update") return;
	if (operation.requestPayload.reset_invite_link === true) {
		if (!group.providerGroupId) {
			throw new Error("WhatsApp group provider identity is missing");
		}
		const account = await loadWhatsAppAccount(db, env, operation);
		// The remote mutation has already been confirmed. GET the canonical link;
		// never replay the reset mutation itself.
		const invite = await getWhatsAppGroupInviteLink(
			account,
			group.providerGroupId,
		);
		const ciphertext = await encryptToken(
			invite.invite_link,
			env.ENCRYPTION_KEY,
			{ recordId: group.id, field: "whatsapp_group_invite_link" },
		);
		await db
			.update(whatsappGroups)
			.set({ inviteLinkCiphertext: ciphertext, updatedAt: new Date() })
			.where(
				and(
					eq(whatsappGroups.id, group.id),
					eq(whatsappGroups.organizationId, operation.organizationId),
					eq(whatsappGroups.accountId, operation.accountId),
				),
			);
		return;
	}
	if (group.lastSyncedAt && group.lastSyncedAt > confirmedAt) return;
	const subject = operation.requestPayload.subject;
	const description = operation.requestPayload.description;
	await db
		.update(whatsappGroups)
		.set({
			...(typeof subject === "string" ? { subject } : {}),
			...(typeof description === "string" ? { description } : {}),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(whatsappGroups.id, group.id),
				eq(whatsappGroups.organizationId, operation.organizationId),
				eq(whatsappGroups.accountId, operation.accountId),
			),
		);
}

export async function applySocialMutationProjection(
	db: Database,
	env: Env,
	operation: SocialMutationOperation,
	result: SocialProviderActionResult,
): Promise<void> {
	switch (operation.kind) {
		case "post_edit":
			return projectPublishedEdit(db, env, operation, result);
		case "message_edit":
			return projectMessageEdit(db, env, operation);
		case "read_receipt":
			return projectReadReceipt(db, operation);
		case "comment_edit":
			return projectCommentEdit(db, env, operation, result);
		case "moderation":
			return projectModeration(db, operation);
		case "group_create":
		case "group_update":
		case "group_delete":
			return projectWhatsAppGroup(db, env, operation, result);
		default:
			// These kinds have no Relay projection. A crash between provider
			// confirmation and the final status update needs only durable completion.
			return;
	}
}

export type SocialMutationRecoveryDisposition =
	| "projection_replay"
	| "manual_reconciliation"
	| "exhausted"
	| "none";

export function classifySocialMutationRecovery(
	operation: Pick<
		SocialMutationOperation,
		"status" | "phase" | "providerConfirmedAt" | "attempts"
	>,
): SocialMutationRecoveryDisposition {
	if (
		operation.phase === "projection" &&
		operation.providerConfirmedAt &&
		(operation.status === "unknown" ||
			operation.status === "request_may_have_been_sent" ||
			operation.status === "processing")
	) {
		return operation.attempts >= MAX_SOCIAL_PROJECTION_ATTEMPTS
			? "exhausted"
			: "projection_replay";
	}
	if (
		!operation.providerConfirmedAt &&
		(operation.status === "unknown" ||
			operation.status === "request_may_have_been_sent")
	) {
		return "manual_reconciliation";
	}
	return "none";
}

/**
 * Recover only local work after provider confirmation. Expired provider-phase
 * boundaries are parked for manual reconciliation and are never dispatched.
 */
export async function reconcileSocialMutationOperations(
	env: Env,
	limit = 25,
): Promise<{
	safelyFailed: number;
	manual: number;
	recovered: number;
	remainingUnknown: number;
}> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const batchSize = Math.min(
		Math.max(Math.trunc(limit), 1),
		MAX_RECONCILE_BATCH,
	);
	const safelyFailed = (await db.execute(sql`
		WITH expired AS (
			SELECT id
			  FROM social_mutation_operations
			 WHERE status = 'processing'
			   AND phase = 'provider'
			   AND provider_confirmed_at IS NULL
			   AND request_may_have_been_sent_at IS NULL
			   AND lease_expires_at <= NOW()
			 ORDER BY lease_expires_at ASC, id ASC
			 LIMIT ${batchSize}
			 FOR UPDATE SKIP LOCKED
		)
		UPDATE social_mutation_operations AS operation
		   SET status = 'failed',
		       lease_expires_at = NULL,
		       last_error = 'Mutation lease expired before the provider boundary',
		       updated_at = NOW()
		  FROM expired
		 WHERE operation.id = expired.id
		RETURNING operation.id
	`)) as unknown as Array<{ id: string }>;
	const manual = (await db.execute(sql`
		WITH expired AS (
			SELECT id
			  FROM social_mutation_operations
			 WHERE status = 'request_may_have_been_sent'
			   AND phase = 'provider'
			   AND provider_confirmed_at IS NULL
			   AND lease_expires_at <= NOW()
			 ORDER BY lease_expires_at ASC, id ASC
			 LIMIT ${batchSize}
			 FOR UPDATE SKIP LOCKED
		)
		UPDATE social_mutation_operations AS operation
		   SET status = 'unknown',
		       lease_expires_at = NULL,
		       last_error = 'Provider outcome is ambiguous; manual reconciliation required',
		       updated_at = NOW()
		  FROM expired
		 WHERE operation.id = expired.id
		RETURNING operation.id
	`)) as unknown as Array<{ id: string }>;

	const candidates = await db
		.select({ id: socialMutationOperations.id })
		.from(socialMutationOperations)
		.where(
			and(
				eq(socialMutationOperations.phase, "projection"),
				isNotNull(socialMutationOperations.providerConfirmedAt),
				lt(socialMutationOperations.attempts, MAX_SOCIAL_PROJECTION_ATTEMPTS),
				or(
					eq(socialMutationOperations.status, "unknown"),
					and(
						eq(socialMutationOperations.status, "request_may_have_been_sent"),
						lte(socialMutationOperations.leaseExpiresAt, new Date()),
					),
					and(
						eq(socialMutationOperations.status, "processing"),
						lte(socialMutationOperations.leaseExpiresAt, new Date()),
					),
				),
			),
		)
		.orderBy(asc(socialMutationOperations.updatedAt))
		.limit(batchSize);
	let recovered = 0;
	let remainingUnknown = 0;
	for (const candidate of candidates) {
		const outcome = await resumeConfirmedSocialProjection({
			db,
			operationId: candidate.id,
			project: (result, operation) =>
				applySocialMutationProjection(db, env, operation, result),
		});
		if (outcome?.status === "completed") recovered += 1;
		if (outcome?.status === "unknown") remainingUnknown += 1;
	}
	return {
		safelyFailed: safelyFailed.length,
		manual: manual.length,
		recovered,
		remainingUnknown,
	};
}
