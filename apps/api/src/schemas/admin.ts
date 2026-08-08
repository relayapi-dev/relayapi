import { z } from "@hono/zod-openapi";
import {
	OPERATOR_RESOLUTION_ACTIONS,
	OPERATOR_RESOLUTION_TARGET_TYPES,
} from "@relayapi/db";

export const AdminOrganization = z
	.object({
		id: z.string(),
		name: z.string(),
		slug: z.string(),
		logo: z.string().nullable(),
		createdAt: z.string().datetime(),
		memberCount: z.number().int().nonnegative(),
		plan: z.enum(["free", "pro"]),
		subscriptionStatus: z.string().nullable(),
		basePriceCents: z.number().int().nonnegative(),
		apiCallsUsed: z.number().int().nonnegative(),
		apiCallsIncluded: z.number().int().nonnegative(),
		aiEnabled: z.boolean(),
		dailyToolLimit: z.number().int().nonnegative(),
		dailyToolLimitOverride: z.number().int().nonnegative().nullable(),
	})
	.openapi("AdminOrganization");

export const AdminOrganizationListResponse = z
	.object({
		organizations: z.array(AdminOrganization),
		total: z.number().int().nonnegative(),
		limit: z.number().int().min(1).max(100),
		offset: z.number().int().nonnegative(),
	})
	.openapi("AdminOrganizationListResponse");

export const AdminOrganizationUpdate = z
	.object({
		name: z.string().trim().min(1).max(255).optional(),
		slug: z
			.string()
			.trim()
			.min(1)
			.max(128)
			.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
			.optional(),
		plan: z.enum(["free", "pro"]).optional(),
		aiEnabled: z.boolean().optional(),
		dailyToolLimitOverride: z
			.number()
			.int()
			.min(0)
			.max(2_147_483_647)
			.nullable()
			.optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "At least one field is required",
	})
	.openapi("AdminOrganizationUpdate");

export const AdminSubscription = z
	.object({
		id: z.string(),
		organizationId: z.string(),
		status: z.string(),
		source: z.enum(["stripe", "complimentary"]),
		basePriceCents: z.number().int().nonnegative(),
		delinquentAt: z.string().datetime().nullable(),
		graceEndsAt: z.string().datetime().nullable(),
		currentPeriodStart: z.string().datetime(),
		currentPeriodEnd: z.string().datetime().nullable(),
		trialEndsAt: z.string().datetime().nullable(),
		createdAt: z.string().datetime(),
		orgName: z.string().nullable(),
		orgSlug: z.string().nullable(),
		apiCallsUsed: z.number().int().nonnegative(),
		apiCallsIncluded: z.number().int().nonnegative(),
		overageCalls: z.number().int().nonnegative(),
		overageCostCents: z.number().int().nonnegative(),
	})
	.openapi("AdminSubscription");

export const AdminSubscriptionListResponse = z
	.object({ subscriptions: z.array(AdminSubscription) })
	.openapi("AdminSubscriptionListResponse");

export const AdminSubscriptionUpdate = z
	.object({
		status: z.enum(["active", "cancelled"]).optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "At least one field is required",
	})
	.openapi("AdminSubscriptionUpdate");

export const AdminMutationResponse = z
	.object({ ok: z.literal(true) })
	.openapi("AdminMutationResponse");

export const AdminAutomationWebhookFailure = z
	.object({
		occurrenceId: z.string(),
		organizationId: z.string(),
		automationId: z.string(),
		entrypointId: z.string(),
		channel: z.string(),
		socialAccountId: z.string().nullable(),
		reason: z.enum([
			"missing_secret",
			"missing_signature",
			"credential_unavailable",
			"invalid_timestamp",
			"stale_timestamp",
			"bad_signature",
			"bad_payload",
			"contact_lookup_failed",
			"enrollment_blocked",
			"enrollment_failed",
			"invalid_payload",
		]),
		requestDigest: z.string().length(64).nullable(),
		receivedAt: z.string().datetime(),
		status: z.enum(["pending", "processing", "done", "failed", "unknown"]),
		attempts: z.number().int().nonnegative(),
		error: z.string().nullable(),
		manualReviewRequired: z.boolean(),
		resolutionMode: z.literal("evidence_only"),
		createdAt: z.string().datetime(),
	})
	.openapi("AdminAutomationWebhookFailure");

export const AdminAutomationWebhookFailureListResponse = z
	.object({
		failures: z.array(AdminAutomationWebhookFailure),
		total: z.number().int().nonnegative(),
		limit: z.number().int().min(1).max(100),
		offset: z.number().int().nonnegative(),
	})
	.openapi("AdminAutomationWebhookFailureListResponse");

export const AdminErasureHold = z
	.object({
		id: z.string(),
		subjectKind: z.enum(["organization", "workspace"]),
		subjectId: z.string(),
		organizationId: z.string(),
		reasonCode: z.string(),
		reasonSummary: z.string(),
		legalAuthorityRef: z.string(),
		placedBy: z.string(),
		placedAt: z.string().datetime(),
		releasedBy: z.string().nullable(),
		releasedAt: z.string().datetime().nullable(),
		releaseReasonSummary: z.string().nullable(),
		hasEvidence: z.boolean(),
		evidenceRedactedAt: z.string().datetime().nullable(),
	})
	.openapi("AdminErasureHold");

export const AdminErasureHoldListResponse = z
	.object({
		holds: z.array(AdminErasureHold),
		total: z.number().int().nonnegative(),
		limit: z.number().int().min(1).max(100),
		offset: z.number().int().nonnegative(),
	})
	.openapi("AdminErasureHoldListResponse");

const AdminErasureHoldCommonInput = z.object({
	reasonCode: z
		.string()
		.trim()
		.regex(/^[a-z][a-z0-9_]{0,63}$/),
	reasonSummary: z.string().trim().min(1).max(500),
	legalAuthorityRef: z.string().trim().min(1).max(256),
	evidence: z
		.string()
		.refine(
			(value) => new TextEncoder().encode(value).byteLength <= 45_000,
			"Evidence must be at most 45,000 UTF-8 bytes",
		)
		.optional(),
});

export const AdminErasureHoldCreate = z
	.discriminatedUnion("subjectKind", [
		AdminErasureHoldCommonInput.extend({
			subjectKind: z.literal("organization"),
			organizationId: z.string().min(1),
		}),
		AdminErasureHoldCommonInput.extend({
			subjectKind: z.literal("workspace"),
			organizationId: z.string().min(1),
			workspaceId: z.string().min(1),
		}),
	])
	.openapi("AdminErasureHoldCreate");

export const AdminErasureHoldRelease = z
	.object({
		releaseReasonSummary: z.string().trim().min(1).max(500),
	})
	.openapi("AdminErasureHoldRelease");

export const AdminErasureJobStatus = z.enum([
	"pending",
	"processing",
	"tombstoned",
	"waiting_external",
	"held",
	"manual_review",
	"failed",
	"purged",
]);

export const AdminErasureJob = z
	.object({
		kind: z.enum(["organization", "workspace"]),
		jobId: z.string(),
		organizationId: z.string(),
		workspaceId: z.string().nullable(),
		status: AdminErasureJobStatus,
		activeHoldId: z.string().nullable(),
		requestedAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
		agedAlertedAt: z.string().datetime().nullable(),
		completedAt: z.string().datetime().nullable(),
	})
	.openapi("AdminErasureJob");

export const AdminErasureJobListResponse = z
	.object({
		jobs: z.array(AdminErasureJob),
		total: z.number().int().nonnegative(),
		limit: z.number().int().min(1).max(100),
		offset: z.number().int().nonnegative(),
	})
	.openapi("AdminErasureJobListResponse");

export const AdminOperatorResolutionTargetType = z.enum(
	OPERATOR_RESOLUTION_TARGET_TYPES,
);
export const AdminOperatorResolutionAction = z.enum(
	OPERATOR_RESOLUTION_ACTIONS,
);

export const AdminOperatorResolutionItem = z
	.object({
		targetType: AdminOperatorResolutionTargetType,
		targetId: z.string(),
		organizationId: z.string().nullable(),
		status: z.string(),
		reasonCode: z.string(),
		allowedActions: z.array(AdminOperatorResolutionAction),
		detectedAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
	})
	.openapi("AdminOperatorResolutionItem");

export const AdminOperatorResolutionListResponse = z
	.object({
		items: z.array(AdminOperatorResolutionItem),
		total: z.number().int().nonnegative(),
		limit: z.number().int().min(1).max(100),
		offset: z.number().int().nonnegative(),
	})
	.openapi("AdminOperatorResolutionListResponse");

const AdminOperatorResolutionState = z.record(
	z.string(),
	z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const AdminOperatorResolutionEvidence = z
	.object({
		id: z.string(),
		organizationId: z.string().nullable(),
		targetType: AdminOperatorResolutionTargetType,
		targetId: z.string(),
		action: AdminOperatorResolutionAction,
		reason: z.string().nullable(),
		reasonCode: z.enum([
			"operator_asserted_succeeded",
			"operator_asserted_not_applied",
			"operator_requested_retry",
			"operator_abandoned",
		]),
		reasonDigest: z.string().regex(/^[0-9a-f]{64}$/),
		actorUserId: z.string(),
		beforeState: AdminOperatorResolutionState,
		afterState: AdminOperatorResolutionState,
		targetUpdatedAtBefore: z.string().datetime(),
		targetUpdatedAtAfter: z.string().datetime(),
		resolvedAt: z.string().datetime(),
	})
	.openapi("AdminOperatorResolutionEvidence");

export const AdminOperatorResolutionEvidenceListResponse = z
	.object({
		evidence: z.array(AdminOperatorResolutionEvidence),
		next_cursor: z.string().nullable(),
		has_more: z.boolean(),
	})
	.openapi("AdminOperatorResolutionEvidenceListResponse");

export const AdminOperatorResolutionRequest = z
	.object({
		action: AdminOperatorResolutionAction,
		reason: z.string().trim().min(1).max(500).openapi({
			description:
				"Operator decision rationale. Do not include payloads, credentials, or other secrets.",
		}),
		providerReference: z.string().trim().min(1).max(255).optional(),
	})
	.openapi("AdminOperatorResolutionRequest");

export const AdminOperatorResolutionResponse = z
	.object({ evidence: AdminOperatorResolutionEvidence })
	.openapi("AdminOperatorResolutionResponse");
