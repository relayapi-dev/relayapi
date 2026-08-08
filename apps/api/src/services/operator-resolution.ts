import {
	accountRevocationJobs,
	adCreationOperations,
	adMutationOperations,
	automationBindings,
	automationConversionEvents,
	automationEffects,
	billingOperationAttempts,
	billingOperations,
	billingPeriods,
	type Database,
	externalSubjectCleanupJobs,
	generateId,
	invoices,
	OPERATOR_RESOLUTION_NOTE_RETENTION_MS,
	OPERATOR_RESOLUTION_REASON_CODE_BY_ACTION,
	type OperatorResolutionAction,
	type OperatorResolutionState,
	type OperatorResolutionTargetType,
	operatorResolutionEvidence,
	operatorResolutionNotes,
	organizationSubscriptions,
	shortLinks,
	stripeEvents,
	tenantDeletionJobs,
	toolJobs,
	usageBuckets,
	usageReservations,
	webhookDeliveries,
	whatsappPhoneBillingAttempts,
	whatsappPhoneBillingOperations,
	whatsappPhoneNumbers,
	whatsappPhoneProvisioningOperations,
	whatsappPhoneReleaseOperations,
	workspaceErasureJobs,
} from "@relayapi/db";
import { and, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import {
	LATE_BILLING_EFFECT_ALERT_PREFIX,
	LATE_BILLING_EFFECT_COMPENSATED_PREFIX,
	LATE_BILLING_EFFECT_REASON_CODE,
	LATE_BILLING_EFFECT_WAIVED_PREFIX,
} from "../config/billing";
import { hasAdCreationProviderEffect } from "../lib/ad-money";
import { decryptToken, encryptToken } from "../lib/crypto";
import { CUSTOMER_WEBHOOK_REPAIR_WINDOW_MS } from "../lib/customer-webhook-policy";
import {
	encodeTimestampIdCursor,
	type TimestampIdCursor,
} from "../lib/pagination-cursor";
import { projectOperatorConfirmedAdMutation } from "./ad-mutation-operations";
import { AUTOMATION_CONVERSION_DISPATCH_DEADLINE_MS } from "./automation-conversion-dispatch";
import {
	EXTERNAL_SUBJECT_CLEANUP_DEADLINE_MS,
	EXTERNAL_SUBJECT_CLEANUP_RECEIPT_MS,
} from "./external-subject-cleanup";
import { TOOL_JOB_DEADLINE_MS, TOOL_JOB_TERMINAL_TTL_MS } from "./tool-jobs";

type ResolutionTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];
type EvidenceRow = typeof operatorResolutionEvidence.$inferSelect;
type EvidenceWithReason = EvidenceRow & { reason: string | null };

interface PreparedReason {
	readonly evidenceId: string;
	readonly digest: string;
	readonly ciphertext: string;
}

export interface OperatorResolutionListItem {
	targetType: OperatorResolutionTargetType;
	targetId: string;
	organizationId: string | null;
	status: string;
	reasonCode: string;
	allowedActions: OperatorResolutionAction[];
	detectedAt: Date;
	updatedAt: Date;
}

export interface ResolveOperatorResolutionInput {
	targetType: OperatorResolutionTargetType;
	targetId: string;
	action: OperatorResolutionAction;
	reason: string;
	actorUserId: string;
	providerReference?: string;
}

type PreparedOperatorResolutionInput = Omit<
	ResolveOperatorResolutionInput,
	"reason"
> & {
	reason: PreparedReason;
};

export class OperatorResolutionNotFoundError extends Error {
	constructor() {
		super("Operator-resolution target not found");
		this.name = "OperatorResolutionNotFoundError";
	}
}

export class OperatorResolutionActionNotAllowedError extends Error {
	constructor(
		readonly targetType: OperatorResolutionTargetType,
		readonly status: string,
		readonly action: OperatorResolutionAction,
	) {
		super(`${action} is not allowed for ${targetType} in status ${status}`);
		this.name = "OperatorResolutionActionNotAllowedError";
	}
}

export class OperatorResolutionStateConflictError extends Error {
	constructor() {
		super("The target changed while the operator decision was being applied");
		this.name = "OperatorResolutionStateConflictError";
	}
}

export class OperatorResolutionInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OperatorResolutionInputError";
	}
}

interface ActionContext {
	targetType: OperatorResolutionTargetType;
	status: string;
	operatorRetryRequestedAt?: Date | null;
	leaseExpiresAt?: Date | null;
	reasonCode?: string;
	now?: Date;
}

/**
 * Status-sensitive action matrix. Target-level possibilities live in
 * `@relayapi/db`; this function narrows them to transitions that are safe for
 * the exact persisted state.
 */
export function allowedOperatorResolutionActions({
	targetType,
	status,
	operatorRetryRequestedAt = null,
	leaseExpiresAt = null,
	reasonCode,
	now = new Date(),
}: ActionContext): OperatorResolutionAction[] {
	switch (targetType) {
		case "automation_effect":
			return status === "unknown" ? ["mark_succeeded", "mark_not_applied"] : [];
		case "automation_binding":
			if (status === "unknown") {
				return ["mark_succeeded", "mark_not_applied"];
			}
			return status === "permanent" ? ["retry"] : [];
		case "automation_conversion_event":
			return status === "manual_review" ? ["retry"] : [];
		case "stripe_event":
			return status === "manual_review" && !operatorRetryRequestedAt
				? ["retry", "abandon"]
				: [];
		case "billing_operation":
			if (reasonCode === LATE_BILLING_EFFECT_REASON_CODE) {
				return ["mark_succeeded", "abandon"];
			}
			if (operatorRetryRequestedAt) return [];
			if (status === "terminal_failed") {
				// A terminal provider rejection is immutable. Rebill only after the
				// operator records non-effect proof and creates a new revision.
				return ["mark_not_applied", "abandon"];
			}
			return status === "unknown" || status === "manual_review"
				? ["mark_succeeded", "mark_not_applied", "retry", "abandon"]
				: [];
		case "tenant_erasure_job":
		case "workspace_erasure_job":
			if (
				status === "purged" ||
				status === "held" ||
				operatorRetryRequestedAt
			) {
				return [];
			}
			if (
				status === "processing" &&
				(!leaseExpiresAt || leaseExpiresAt.getTime() > now.getTime())
			) {
				return [];
			}
			return ["retry"];
		case "account_revocation_job":
			if (status === "unknown") {
				return ["mark_succeeded", "mark_not_applied"];
			}
			return status === "manual_required" ? ["mark_succeeded", "abandon"] : [];
		case "external_subject_cleanup_job":
			return status === "manual_review" ? ["mark_succeeded", "retry"] : [];
		case "short_link_creation":
			if (status !== "manual_review") return [];
			return reasonCode === "ambiguous_provider_create_candidate_recorded"
				? ["mark_succeeded", "mark_not_applied"]
				: ["mark_not_applied"];
		case "customer_webhook_delivery":
			if (status !== "manual_review") return [];
			if (reasonCode === "pre_http_repair_exhausted") {
				return operatorRetryRequestedAt ? ["abandon"] : ["retry", "abandon"];
			}
			if (reasonCode === "http_outcome_unknown") {
				return operatorRetryRequestedAt
					? ["mark_succeeded", "mark_not_applied"]
					: ["mark_succeeded", "mark_not_applied", "retry"];
			}
			return [];
		case "tool_job":
			if (status !== "manual_review") return [];
			return reasonCode === "provider_outcome_unknown_retryable"
				? ["mark_not_applied", "abandon"]
				: ["abandon"];
		case "whatsapp_phone_provisioning_operation":
			if (status !== "manual_review") return [];
			if (reasonCode === "provisioning_fenced_for_release") return [];
			if (reasonCode === "provisioning_economic_boundary_recorded") {
				return ["mark_succeeded", "retry"];
			}
			return reasonCode === "provisioning_reconciliation_exhausted"
				? ["retry"]
				: [];
		case "whatsapp_phone_release_operation":
			if (status !== "manual_review") return [];
			if (reasonCode === "ambiguous_meta_deregistration") {
				return ["mark_succeeded", "mark_not_applied"];
			}
			return reasonCode === "manual_meta_deregistration_required"
				? ["mark_succeeded", "retry"]
				: ["retry"];
		case "whatsapp_phone_billing_operation":
			return status === "unknown" || status === "manual_review"
				? ["mark_succeeded", "mark_not_applied"]
				: [];
		case "ad_mutation_operation":
			if (!(status === "unknown" || status === "manual_review")) return [];
			if (reasonCode === "ad_mutation_pre_provider_retries_exhausted") {
				return ["mark_not_applied", "retry"];
			}
			return reasonCode === "confirmed_ad_provider_mutation_projection_pending"
				? ["mark_succeeded"]
				: ["mark_succeeded", "mark_not_applied"];
		case "ad_creation_operation":
			if (status !== "manual_review") return [];
			if (reasonCode === "ad_creation_provider_progress_recorded") {
				return ["mark_succeeded"];
			}
			return reasonCode === "ad_creation_pre_provider_retries_exhausted"
				? ["mark_not_applied", "retry"]
				: ["mark_succeeded", "mark_not_applied"];
	}
}

function operatorResolutionRowsSql(): SQL {
	return sql`
		WITH unresolved AS (
			SELECT
				'automation_effect'::text AS target_type,
				effect.id AS target_id,
				effect.organization_id,
				effect.status,
				'unknown_external_effect'::text AS reason_code,
				COALESCE(effect.request_may_have_been_sent_at, effect.updated_at) AS detected_at,
				effect.updated_at,
				NULL::timestamptz AS operator_retry_requested_at,
				effect.lease_expires_at
			FROM public.automation_effects AS effect
			WHERE effect.status = 'unknown'

			UNION ALL

			SELECT
				'automation_binding'::text,
				binding.id,
				binding.organization_id,
				binding.sync_error_class,
				CASE binding.sync_error_class
					WHEN 'unknown' THEN 'unknown_meta_outcome'
					ELSE 'permanent_meta_failure'
				END,
				COALESCE(binding.sync_request_may_have_been_sent_at, binding.updated_at),
				binding.updated_at,
				NULL::timestamptz,
				binding.sync_lease_expires_at
			FROM public.automation_bindings AS binding
			WHERE binding.binding_type IN ('get_started', 'main_menu', 'ice_breaker')
			  AND binding.last_synced_revision < binding.sync_revision
			  AND binding.sync_error_class IN ('unknown', 'permanent')

			UNION ALL

			SELECT
				'automation_conversion_event'::text,
				event.id,
				event.organization_id,
				event.dispatch_status,
				COALESCE(
					event.last_dispatch_error,
					'conversion_trigger_dispatch_exhausted'
				),
				event.updated_at,
				event.updated_at,
				NULL::timestamptz,
				event.dispatch_lease_expires_at
			FROM public.automation_conversion_events AS event
			WHERE event.dispatch_status = 'manual_review'

			UNION ALL

			SELECT
				'stripe_event'::text,
				event.id,
				COALESCE(
					event.organization_id,
					(
					SELECT min(subscription.organization_id)
					FROM public.organization_subscriptions AS subscription
					WHERE (event.customer_id IS NOT NULL
							AND subscription.stripe_customer_id = event.customer_id)
					   OR (event.subscription_id IS NOT NULL
							AND subscription.stripe_subscription_id = event.subscription_id)
					HAVING count(DISTINCT subscription.organization_id) = 1
					)
				),
				event.status,
				COALESCE(event.last_error_class, 'manual_review'),
				COALESCE(event.manual_review_at, event.updated_at),
				event.updated_at,
				event.operator_retry_requested_at,
				event.lease_expires_at
			FROM public.stripe_events AS event
			WHERE event.status = 'manual_review'

			UNION ALL

			SELECT
				'billing_operation'::text,
				operation.id,
				operation.organization_id,
				operation.status,
				CASE
					WHEN operation.last_error LIKE ${`${LATE_BILLING_EFFECT_ALERT_PREFIX}%`}
						THEN ${LATE_BILLING_EFFECT_REASON_CODE}
					ELSE COALESCE(operation.last_error_class, operation.status)
				END,
				operation.updated_at,
				operation.updated_at,
				operation.operator_retry_requested_at,
				operation.lease_expires_at
			FROM public.billing_operations AS operation
			WHERE (
				operation.status IN ('unknown', 'manual_review', 'terminal_failed')
				OR (
					operation.status IN ('released', 'written_off')
					AND operation.last_error LIKE ${`${LATE_BILLING_EFFECT_ALERT_PREFIX}%`}
				)
			)
			  AND operation.operator_retry_requested_at IS NULL

			UNION ALL

			SELECT
				'tenant_erasure_job'::text,
				job.organization_id,
				job.organization_id,
				job.status,
				CASE
					WHEN job.status = 'held' THEN 'active_erasure_hold'
					ELSE 'aged_erasure_job'
				END,
				job.aged_alerted_at,
				job.updated_at,
				job.operator_retry_requested_at,
				job.lease_expires_at
			FROM public.tenant_deletion_jobs AS job
			WHERE job.aged_alerted_at IS NOT NULL
			  AND job.status <> 'purged'
			  AND job.operator_retry_requested_at IS NULL

			UNION ALL

			SELECT
				'workspace_erasure_job'::text,
				job.erasure_operation_id,
				job.organization_id,
				job.status,
				CASE
					WHEN job.status = 'held' THEN 'active_erasure_hold'
					ELSE 'aged_erasure_job'
				END,
				job.aged_alerted_at,
				job.updated_at,
				job.operator_retry_requested_at,
				job.lease_expires_at
			FROM public.workspace_erasure_jobs AS job
			WHERE job.aged_alerted_at IS NOT NULL
			  AND job.status <> 'purged'
			  AND job.operator_retry_requested_at IS NULL

			UNION ALL

			SELECT
				'account_revocation_job'::text,
				job.id,
				job.organization_id,
				job.status,
				CASE job.status
					WHEN 'unknown' THEN 'unknown_provider_revocation'
					ELSE 'manual_provider_revocation'
				END,
				COALESCE(job.request_may_have_been_sent_at, job.updated_at),
				job.updated_at,
				NULL::timestamptz,
				job.lease_expires_at
			FROM public.account_revocation_jobs AS job
			WHERE job.status IN ('unknown', 'manual_required')

			UNION ALL

			SELECT
				'external_subject_cleanup_job'::text,
				job.id,
				job.organization_id,
				job.status,
				COALESCE(job.last_error, 'external_cleanup_manual_review'),
				job.updated_at,
				job.updated_at,
				NULL::timestamptz,
				job.lease_expires_at
			FROM public.external_subject_cleanup_jobs AS job
			WHERE job.status = 'manual_review'

			UNION ALL

			SELECT
				'short_link_creation'::text,
				link.id,
				link.organization_id,
				link.creation_status,
				CASE
					WHEN link.short_url IS NOT NULL
						THEN 'ambiguous_provider_create_candidate_recorded'
					ELSE 'ambiguous_provider_create'
				END,
				link.creation_completed_at,
				link.creation_completed_at,
				NULL::timestamptz,
				NULL::timestamptz
			FROM public.short_links AS link
			WHERE link.creation_status = 'manual_review'

			UNION ALL

			SELECT
				'customer_webhook_delivery'::text,
				delivery.id,
				delivery.organization_id,
				delivery.status,
				delivery.manual_review_reason,
					delivery.updated_at,
					delivery.updated_at,
					delivery.operator_retry_requested_at,
					delivery.lease_expires_at
				FROM public.webhook_deliveries AS delivery
				WHERE delivery.status = 'manual_review'
				  AND delivery.manual_review_reason IN (
						'pre_http_repair_exhausted',
						'http_outcome_unknown'
				  )
				  AND delivery.manual_review_until > now()

			UNION ALL

			SELECT
				'tool_job'::text,
				job.id,
				job.organization_id,
				job.status,
				CASE
					WHEN bucket.period_end > now()
						THEN 'provider_outcome_unknown_retryable'
					ELSE 'provider_outcome_unknown_closed_window'
				END,
				COALESCE(job.request_may_have_been_sent_at, job.updated_at),
				job.updated_at,
				NULL::timestamptz,
				job.lease_expires_at
			FROM public.tool_jobs AS job
			JOIN public.usage_reservations AS reservation
			  ON reservation.id = job.usage_reservation_id
			 AND reservation.organization_id = job.organization_id
			JOIN public.usage_buckets AS bucket
			  ON bucket.id = reservation.bucket_id
			 AND bucket.organization_id = reservation.organization_id
			WHERE job.status = 'manual_review'
			  AND job.error_code = 'PROVIDER_OUTCOME_UNKNOWN'

			UNION ALL

			SELECT
				'whatsapp_phone_provisioning_operation'::text,
				operation.id,
				operation.organization_id,
				operation.status,
				CASE
					WHEN EXISTS (
						SELECT 1
						FROM public.whatsapp_phone_release_operations AS release
						WHERE release.phone_number_id = operation.phone_number_id
					) THEN 'provisioning_fenced_for_release'
					WHEN operation.stripe_checkout_session_id IS NOT NULL
					  OR operation.phase IN ('telnyx_order', 'meta_registration', 'completed')
						THEN 'provisioning_economic_boundary_recorded'
					ELSE 'provisioning_reconciliation_exhausted'
				END,
				COALESCE(operation.request_may_have_been_sent_at, operation.updated_at),
				operation.updated_at,
				NULL::timestamptz,
				operation.lease_expires_at
			FROM public.whatsapp_phone_provisioning_operations AS operation
			WHERE operation.status = 'manual_review'
			  AND NOT EXISTS (
				SELECT 1
				  FROM public.operator_resolution_evidence AS evidence
				 WHERE evidence.target_type = 'whatsapp_phone_provisioning_operation'
				   AND evidence.target_id = operation.id
				   AND evidence.action IN ('mark_succeeded', 'mark_not_applied')
			  )

			UNION ALL

			SELECT
				'whatsapp_phone_release_operation'::text,
				operation.id,
				operation.organization_id,
				operation.status,
				CASE
					WHEN operation.phase = 'meta'
					 AND operation.meta_status = 'unknown'
						THEN 'ambiguous_meta_deregistration'
					WHEN operation.phase = 'meta'
					 AND operation.meta_status = 'pending'
						THEN 'manual_meta_deregistration_required'
					ELSE 'manual_phone_release_provider_resolution'
				END,
				COALESCE(operation.request_may_have_been_sent_at, operation.updated_at),
				operation.updated_at,
				NULL::timestamptz,
				operation.lease_expires_at
			FROM public.whatsapp_phone_release_operations AS operation
			WHERE operation.status = 'manual_review'

			UNION ALL

			SELECT
				'whatsapp_phone_billing_operation'::text,
				operation.id,
				operation.organization_id,
				operation.state,
				'ambiguous_stripe_phone_billing'::text,
				COALESCE(operation.request_may_have_been_sent_at, operation.updated_at),
				operation.updated_at,
				NULL::timestamptz,
				operation.lease_expires_at
			FROM public.whatsapp_phone_billing_operations AS operation
			WHERE operation.state IN ('unknown', 'manual_review')

			UNION ALL

			SELECT
				'ad_creation_operation'::text,
				operation.id,
				operation.organization_id,
				operation.status,
				CASE
					WHEN operation.platform_creative_id IS NOT NULL
					  OR operation.platform_ad_id IS NOT NULL
					  OR (
						NOT (
							operation.kind = 'create_ad'
							AND COALESCE(
								jsonb_typeof(operation.request_payload -> 'campaignId') = 'string',
								false
							)
						)
						AND (
							operation.platform_campaign_id IS NOT NULL
							OR operation.platform_ad_set_id IS NOT NULL
						)
					  )
						THEN 'ad_creation_provider_progress_recorded'::text
					WHEN operation.request_may_have_been_sent_at IS NULL
						THEN 'ad_creation_pre_provider_retries_exhausted'::text
					ELSE 'ambiguous_ad_provider_creation'::text
				END,
				COALESCE(operation.request_may_have_been_sent_at, operation.updated_at),
				operation.updated_at,
				NULL::timestamptz,
				operation.lease_expires_at
			FROM public.ad_creation_operations AS operation
			WHERE operation.status = 'manual_review'
			  AND NOT EXISTS (
				SELECT 1
				  FROM public.operator_resolution_evidence AS evidence
				 WHERE evidence.target_type = 'ad_creation_operation'
				   AND evidence.target_id = operation.id
				   AND evidence.action IN ('mark_succeeded', 'mark_not_applied')
			  )

			UNION ALL

			SELECT
				'ad_mutation_operation'::text,
				operation.id,
				operation.organization_id,
				operation.status,
				CASE
					WHEN operation.phase = 'projection'
						OR operation.provider_confirmed_at IS NOT NULL
					THEN 'confirmed_ad_provider_mutation_projection_pending'::text
					WHEN operation.status = 'manual_review'
					 AND operation.phase = 'provider'
					 AND operation.request_may_have_been_sent_at IS NULL
					THEN 'ad_mutation_pre_provider_retries_exhausted'::text
					ELSE 'ambiguous_ad_provider_mutation'::text
				END,
				COALESCE(operation.request_may_have_been_sent_at, operation.updated_at),
				operation.updated_at,
				NULL::timestamptz,
				operation.lease_expires_at
			FROM public.ad_mutation_operations AS operation
			WHERE operation.status IN ('unknown', 'manual_review')
			  AND NOT EXISTS (
				SELECT 1
				  FROM public.operator_resolution_evidence AS evidence
				 WHERE evidence.target_type = 'ad_mutation_operation'
				   AND evidence.target_id = operation.id
				   AND evidence.action IN ('mark_succeeded', 'mark_not_applied')
			  )
		)
	`;
}

interface OperatorResolutionSqlRow extends Record<string, unknown> {
	target_type: OperatorResolutionTargetType;
	target_id: string;
	organization_id: string | null;
	status: string;
	reason_code: string;
	detected_at: Date;
	updated_at: Date;
	operator_retry_requested_at: Date | null;
	lease_expires_at: Date | null;
}

export async function listOperatorResolutionItems(
	db: Database,
	params: {
		limit: number;
		offset: number;
		targetType?: OperatorResolutionTargetType;
		organizationId?: string;
	},
): Promise<{
	items: OperatorResolutionListItem[];
	total: number;
}> {
	const filters = and(
		params.targetType
			? sql`unresolved.target_type = ${params.targetType}`
			: undefined,
		params.organizationId
			? sql`unresolved.organization_id = ${params.organizationId}`
			: undefined,
	);
	const where = filters ? sql`WHERE ${filters}` : sql``;
	const [rows, totalRows] = await Promise.all([
		db.execute<OperatorResolutionSqlRow>(sql`
			${operatorResolutionRowsSql()}
			SELECT *
			FROM unresolved
			${where}
			ORDER BY detected_at DESC, target_type, target_id
			LIMIT ${params.limit}
			OFFSET ${params.offset}
		`),
		db.execute<{ value: number }>(sql`
			${operatorResolutionRowsSql()}
			SELECT count(*)::integer AS value
			FROM unresolved
			${where}
		`),
	]);
	const now = new Date();
	return {
		items: rows.map((row) => ({
			targetType: row.target_type,
			targetId: row.target_id,
			organizationId: row.organization_id,
			status: row.status,
			reasonCode: row.reason_code,
			allowedActions: allowedOperatorResolutionActions({
				targetType: row.target_type,
				status: row.status,
				operatorRetryRequestedAt: row.operator_retry_requested_at,
				leaseExpiresAt: row.lease_expires_at,
				reasonCode: row.reason_code,
				now,
			}),
			detectedAt: row.detected_at,
			updatedAt: row.updated_at,
		})),
		total: Number(totalRows[0]?.value ?? 0),
	};
}

export async function listOperatorResolutionEvidence(
	db: Database,
	params: {
		limit: number;
		encryptionKey: string;
		cursor?: TimestampIdCursor;
		organizationId?: string;
		targetType?: OperatorResolutionTargetType;
		targetId?: string;
		action?: OperatorResolutionAction;
	},
): Promise<{
	evidence: EvidenceWithReason[];
	nextCursor: string | null;
	hasMore: boolean;
}> {
	const where = and(
		params.organizationId
			? eq(operatorResolutionEvidence.organizationId, params.organizationId)
			: undefined,
		params.targetType
			? eq(operatorResolutionEvidence.targetType, params.targetType)
			: undefined,
		params.targetId
			? eq(operatorResolutionEvidence.targetId, params.targetId)
			: undefined,
		params.action
			? eq(operatorResolutionEvidence.action, params.action)
			: undefined,
		params.cursor
			? sql`(${operatorResolutionEvidence.resolvedAt}, ${operatorResolutionEvidence.id})
				< (${params.cursor.timestamp}::timestamptz, ${params.cursor.id})`
			: undefined,
	);
	const rows = await db
		.select({
			evidence: operatorResolutionEvidence,
			noteCiphertext: operatorResolutionNotes.noteCiphertext,
			noteExpiresAt: operatorResolutionNotes.expiresAt,
			cursorTimestamp: sql<string>`to_char(
				${operatorResolutionEvidence.resolvedAt} AT TIME ZONE 'UTC',
				'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
			)`,
		})
		.from(operatorResolutionEvidence)
		.leftJoin(
			operatorResolutionNotes,
			eq(operatorResolutionNotes.evidenceId, operatorResolutionEvidence.id),
		)
		.where(where)
		.orderBy(
			desc(operatorResolutionEvidence.resolvedAt),
			desc(operatorResolutionEvidence.id),
		)
		.limit(params.limit + 1);
	const hasMore = rows.length > params.limit;
	const page = rows.slice(0, params.limit);
	const last = page.at(-1);
	const now = new Date();
	return {
		evidence: await Promise.all(
			page.map(async (row) => ({
				...row.evidence,
				reason:
					row.noteCiphertext && row.noteExpiresAt && row.noteExpiresAt > now
						? await decryptToken(row.noteCiphertext, params.encryptionKey, {
								recordId: row.evidence.id,
								field: "note_ciphertext",
							})
						: null,
			})),
		),
		nextCursor:
			hasMore && last
				? encodeTimestampIdCursor(last.cursorTimestamp, last.evidence.id)
				: null,
		hasMore,
	};
}

function transitionAt(previous: Date): Date {
	return new Date(Math.max(Date.now(), previous.getTime()));
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function assertAllowed(
	targetType: OperatorResolutionTargetType,
	status: string,
	action: OperatorResolutionAction,
	options?: {
		operatorRetryRequestedAt?: Date | null;
		leaseExpiresAt?: Date | null;
		reasonCode?: string;
		now?: Date;
	},
): void {
	const allowed = allowedOperatorResolutionActions({
		targetType,
		status,
		...options,
	});
	if (!allowed.includes(action)) {
		throw new OperatorResolutionActionNotAllowedError(
			targetType,
			status,
			action,
		);
	}
}

async function assertNoTerminalOperatorDecision(
	tx: ResolutionTransaction,
	targetType: OperatorResolutionTargetType,
	targetId: string,
): Promise<void> {
	const [terminal] = await tx
		.select({ id: operatorResolutionEvidence.id })
		.from(operatorResolutionEvidence)
		.where(
			and(
				eq(operatorResolutionEvidence.targetType, targetType),
				eq(operatorResolutionEvidence.targetId, targetId),
				inArray(operatorResolutionEvidence.action, [
					"mark_succeeded",
					"mark_not_applied",
				]),
			),
		)
		.limit(1);
	if (terminal) throw new OperatorResolutionStateConflictError();
}

async function appendEvidence(
	tx: ResolutionTransaction,
	input: {
		organizationId: string | null;
		targetType: OperatorResolutionTargetType;
		targetId: string;
		action: OperatorResolutionAction;
		reason: PreparedReason;
		actorUserId: string;
		beforeState: OperatorResolutionState;
		afterState: OperatorResolutionState;
		targetUpdatedAtBefore: Date;
		targetUpdatedAtAfter: Date;
	},
): Promise<EvidenceRow> {
	const resolvedAt = input.targetUpdatedAtAfter;
	const [evidence] = await tx
		.insert(operatorResolutionEvidence)
		.values({
			id: input.reason.evidenceId,
			organizationId: input.organizationId,
			targetType: input.targetType,
			targetId: input.targetId,
			action: input.action,
			reasonCode: OPERATOR_RESOLUTION_REASON_CODE_BY_ACTION[input.action],
			reasonDigest: input.reason.digest,
			actorUserId: input.actorUserId,
			beforeState: input.beforeState,
			afterState: input.afterState,
			targetUpdatedAtBefore: input.targetUpdatedAtBefore,
			targetUpdatedAtAfter: input.targetUpdatedAtAfter,
			resolvedAt,
		})
		.returning();
	if (!evidence) throw new OperatorResolutionStateConflictError();
	await tx.insert(operatorResolutionNotes).values({
		evidenceId: evidence.id,
		organizationId: evidence.organizationId,
		noteCiphertext: input.reason.ciphertext,
		createdAt: resolvedAt,
		expiresAt: new Date(
			resolvedAt.getTime() + OPERATOR_RESOLUTION_NOTE_RETENTION_MS,
		),
	});
	return evidence;
}

function automationEffectState(
	row: typeof automationEffects.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.status,
		kind: row.kind,
		attempts: row.attempts,
		lease_token: row.leaseToken,
		request_boundary_recorded: row.requestMayHaveBeenSentAt !== null,
		provider_reference_recorded: row.providerReference !== null,
	};
}

function automationBindingState(
	row: typeof automationBindings.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.status,
		error_class: row.syncErrorClass,
		desired_active: row.desiredActive,
		delete_after_sync: row.deleteAfterSync,
		sync_revision: row.syncRevision,
		last_synced_revision: row.lastSyncedRevision,
		dispatch_generation: row.syncDispatchGeneration,
		attempts: row.syncAttempts,
		request_boundary_recorded: row.syncRequestMayHaveBeenSentAt !== null,
	};
}

function automationConversionEventState(
	row: typeof automationConversionEvents.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.dispatchStatus,
		attempts: row.dispatchAttempts,
		lease_token: row.dispatchLeaseToken,
		event_depth: row.eventDepth,
		dispatched: row.dispatchedAt !== null,
	};
}

function stripeEventState(
	row: typeof stripeEvents.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.status,
		event_type: row.type,
		error_class: row.lastErrorClass,
		attempts: row.attempts,
		lease_token: row.leaseToken,
		operator_retry_requested: row.operatorRetryRequestedAt !== null,
	};
}

function billingOperationState(
	row: typeof billingOperations.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.status,
		kind: row.kind,
		attempt_revision: row.attemptRevision,
		error_class: row.lastErrorClass,
		attempts: row.attempts,
		lease_token: row.leaseToken,
		invoice_authority_recorded: row.stripeInvoiceId !== null,
		provider_reference_recorded: row.stripeInvoiceItemId !== null,
		operator_retry_requested: row.operatorRetryRequestedAt !== null,
		late_provider_effect_resolution: row.lastError?.startsWith(
			LATE_BILLING_EFFECT_ALERT_PREFIX,
		)
			? "pending_compensation"
			: row.lastError?.startsWith(LATE_BILLING_EFFECT_COMPENSATED_PREFIX)
				? "compensated"
				: row.lastError?.startsWith(LATE_BILLING_EFFECT_WAIVED_PREFIX)
					? "writeoff_accepted"
					: null,
	};
}

function tenantErasureState(
	row: typeof tenantDeletionJobs.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.status,
		attempts: row.attempts,
		lease_token: row.leaseToken,
		aged_alert_recorded: row.agedAlertedAt !== null,
		operator_retry_requested: row.operatorRetryRequestedAt !== null,
	};
}

function workspaceErasureState(
	row: typeof workspaceErasureJobs.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.status,
		attempts: row.attempts,
		lease_token: row.leaseToken,
		aged_alert_recorded: row.agedAlertedAt !== null,
		operator_retry_requested: row.operatorRetryRequestedAt !== null,
	};
}

function accountRevocationState(
	row: typeof accountRevocationJobs.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.status,
		platform: row.platform,
		attempts: row.attempts,
		lease_token: row.leaseToken,
		source_token_version: row.sourceTokenVersion,
		request_boundary_recorded: row.requestMayHaveBeenSentAt !== null,
		credential_material_retained:
			row.accessTokenCiphertext !== null || row.refreshTokenCiphertext !== null,
	};
}

function externalSubjectCleanupState(
	row: typeof externalSubjectCleanupJobs.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.status,
		operation: row.operation,
		bucket: row.bucket,
		subject_kind: row.subjectKind,
		attempts: row.attempts,
		lease_token: row.leaseToken,
		cursor_recorded: row.cursor !== null,
	};
}

function shortLinkCreationReasonCode(
	row: typeof shortLinks.$inferSelect,
): string {
	return row.shortCode !== null && row.shortUrl !== null
		? "ambiguous_provider_create_candidate_recorded"
		: "ambiguous_provider_create";
}

function shortLinkCreationState(
	row: typeof shortLinks.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.creationStatus,
		provider: row.provider,
		provider_config_version: row.providerConfigVersion,
		credential_version: row.credentialVersion,
		creation_fence: row.creationFence,
		provider_result_recorded: row.shortCode !== null && row.shortUrl !== null,
	};
}

function customerWebhookDeliveryState(
	row: typeof webhookDeliveries.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.status,
		attempts: row.attempts,
		repair_attempts: row.repairAttempts,
		dispatch_attempts: row.dispatchAttempts,
		lease_token: row.leaseToken,
		request_boundary_recorded: row.requestMayHaveBeenSentAt !== null,
		manual_review_reason: row.manualReviewReason,
		manual_review_until: row.manualReviewUntil?.toISOString() ?? null,
		operator_intervened_at: row.operatorIntervenedAt?.toISOString() ?? null,
		operator_retry_requested_at:
			row.operatorRetryRequestedAt?.toISOString() ?? null,
	};
}

function toolJobState(
	job: typeof toolJobs.$inferSelect,
	reservation: typeof usageReservations.$inferSelect,
): OperatorResolutionState {
	return {
		status: job.status,
		attempts: job.attempts,
		lease_token: job.leaseToken,
		request_boundary_recorded: job.requestMayHaveBeenSentAt !== null,
		usage_state: reservation.state,
		usage_disposition: reservation.disposition,
		usage_reserved_units: reservation.units,
		usage_committed_units: reservation.committedUnits,
		usage_boundary_recorded: reservation.requestMayHaveBeenSentAt !== null,
	};
}

function phoneProvisioningState(
	row: typeof whatsappPhoneProvisioningOperations.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.provisioningState,
		phase: row.provisioningPhase,
		attempts: row.provisioningAttempts,
		lease_token: row.provisioningLeaseToken,
		request_boundary_recorded:
			row.provisioningRequestMayHaveBeenSentAt !== null,
	};
}

function phoneReleaseState(
	row: typeof whatsappPhoneReleaseOperations.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.releaseState,
		phase: row.releasePhase,
		meta_status: row.releaseMetaStatus,
		stripe_status: row.releaseStripeStatus,
		telnyx_status: row.releaseTelnyxStatus,
		attempts: row.releaseAttempts,
		lease_token: row.releaseLeaseToken,
		request_boundary_recorded: row.releaseRequestMayHaveBeenSentAt !== null,
	};
}

function phoneBillingState(
	row: typeof whatsappPhoneBillingOperations.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.state,
		desired_quantity: row.desiredQuantity,
		applied_quantity: row.appliedQuantity,
		revision: row.revision,
		attempts: row.attempts,
		lease_token: row.leaseToken,
		request_boundary_recorded: row.requestMayHaveBeenSentAt !== null,
		provider_subscription_recorded: row.stripeSubscriptionId !== null,
		provider_item_recorded: row.stripeSubscriptionItemId !== null,
	};
}

function adMutationState(
	row: typeof adMutationOperations.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.status,
		phase: row.phase,
		kind: row.kind,
		target_type: row.targetType,
		attempts: row.attempts,
		lease_token: row.leaseToken,
		request_boundary_recorded: row.requestMayHaveBeenSentAt !== null,
		provider_confirmed: row.providerConfirmedAt !== null,
	};
}

function adCreationState(
	row: typeof adCreationOperations.$inferSelect,
): OperatorResolutionState {
	return {
		status: row.status,
		phase: row.phase,
		kind: row.kind,
		attempts: row.attempts,
		lease_token: row.leaseToken,
		request_boundary_recorded: row.requestMayHaveBeenSentAt !== null,
		provider_campaign_recorded: row.platformCampaignId !== null,
		provider_ad_set_recorded: row.platformAdSetId !== null,
		provider_creative_recorded: row.platformCreativeId !== null,
		provider_ad_recorded: row.platformAdId !== null,
	};
}

async function resolveAutomationEffect(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(automationEffects)
			.where(eq(automationEffects.id, input.targetId))
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionNotFoundError();
		assertAllowed("automation_effect", row.status, input.action);

		const resolvedAt = transitionAt(row.updatedAt);
		const nextStatus =
			input.action === "mark_succeeded" ? "succeeded" : "failed";
		const [updated] = await tx
			.update(automationEffects)
			.set({
				status: nextStatus,
				leaseExpiresAt: null,
				providerReference:
					input.action === "mark_succeeded"
						? (input.providerReference ?? row.providerReference)
						: null,
				result: {
					version: 1,
					value: null,
					operator_resolved: true,
				},
				lastError:
					input.action === "mark_not_applied"
						? "Operator confirmed the provider effect was not applied"
						: null,
				completedAt: resolvedAt,
				updatedAt: resolvedAt,
			})
			.where(
				and(
					eq(automationEffects.id, row.id),
					eq(automationEffects.status, "unknown"),
					eq(automationEffects.leaseToken, row.leaseToken),
				),
			)
			.returning();
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId: row.organizationId,
			targetType: "automation_effect",
			targetId: row.id,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState: automationEffectState(row),
			afterState: automationEffectState(updated),
			targetUpdatedAtBefore: row.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

async function resolveAutomationBinding(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(automationBindings)
			.where(eq(automationBindings.id, input.targetId))
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionNotFoundError();
		const providerBinding =
			row.bindingType === "get_started" ||
			row.bindingType === "main_menu" ||
			row.bindingType === "ice_breaker";
		if (
			!providerBinding ||
			row.lastSyncedRevision >= row.syncRevision ||
			!row.syncErrorClass
		) {
			throw new OperatorResolutionActionNotAllowedError(
				"automation_binding",
				row.status,
				input.action,
			);
		}
		assertAllowed("automation_binding", row.syncErrorClass, input.action);
		const resolvedAt = transitionAt(row.updatedAt);
		const beforeState = automationBindingState(row);

		if (
			input.action === "mark_succeeded" &&
			!row.desiredActive &&
			row.deleteAfterSync
		) {
			const [deleted] = await tx
				.delete(automationBindings)
				.where(
					and(
						eq(automationBindings.id, row.id),
						eq(automationBindings.syncRevision, row.syncRevision),
						eq(
							automationBindings.syncDispatchGeneration,
							row.syncDispatchGeneration,
						),
						eq(automationBindings.syncErrorClass, "unknown"),
						eq(automationBindings.desiredActive, false),
						eq(automationBindings.deleteAfterSync, true),
					),
				)
				.returning({ id: automationBindings.id });
			if (!deleted) throw new OperatorResolutionStateConflictError();
			return appendEvidence(tx, {
				organizationId: row.organizationId,
				targetType: "automation_binding",
				targetId: row.id,
				action: input.action,
				reason: input.reason,
				actorUserId: input.actorUserId,
				beforeState,
				afterState: {
					status: "deleted",
					sync_revision: row.syncRevision,
					last_synced_revision: row.syncRevision,
				},
				targetUpdatedAtBefore: row.updatedAt,
				targetUpdatedAtAfter: resolvedAt,
			});
		}

		const terminal =
			input.action === "mark_succeeded"
				? {
						status: row.desiredActive
							? ("active" as const)
							: ("paused" as const),
						lastSyncedAt: resolvedAt,
						lastSyncedRevision: row.syncRevision,
						syncLeaseExpiresAt: null,
						syncStartedAt: null,
						syncRequestMayHaveBeenSentAt: null,
						syncNextAttemptAt: null,
						syncError: null,
						syncErrorClass: null,
						syncErrorAt: null,
						updatedAt: resolvedAt,
					}
				: {
						status: "pending_sync" as const,
						syncDispatchGeneration: sql`${automationBindings.syncDispatchGeneration} + 1`,
						syncLeaseExpiresAt: null,
						syncStartedAt: null,
						syncRequestMayHaveBeenSentAt: null,
						syncNextAttemptAt: resolvedAt,
						syncError: null,
						syncErrorClass: null,
						syncErrorAt: null,
						updatedAt: resolvedAt,
					};
		const [updated] = await tx
			.update(automationBindings)
			.set(terminal)
			.where(
				and(
					eq(automationBindings.id, row.id),
					eq(automationBindings.syncRevision, row.syncRevision),
					eq(
						automationBindings.syncDispatchGeneration,
						row.syncDispatchGeneration,
					),
					eq(automationBindings.syncErrorClass, row.syncErrorClass),
					eq(automationBindings.lastSyncedRevision, row.lastSyncedRevision),
				),
			)
			.returning();
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId: row.organizationId,
			targetType: "automation_binding",
			targetId: row.id,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState,
			afterState: automationBindingState(updated),
			targetUpdatedAtBefore: row.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

async function resolveAutomationConversionEvent(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(automationConversionEvents)
			.where(eq(automationConversionEvents.id, input.targetId))
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionNotFoundError();
		assertAllowed(
			"automation_conversion_event",
			row.dispatchStatus,
			input.action,
		);

		const resolvedAt = transitionAt(row.updatedAt);
		const [updated] = await tx
			.update(automationConversionEvents)
			.set({
				dispatchStatus: "pending",
				dispatchAttempts: 0,
				dispatchLeaseToken: sql`${automationConversionEvents.dispatchLeaseToken} + 1`,
				dispatchLeaseExpiresAt: null,
				nextDispatchAt: resolvedAt,
				dispatchDeadlineAt: new Date(
					resolvedAt.getTime() + AUTOMATION_CONVERSION_DISPATCH_DEADLINE_MS,
				),
				dispatchedAt: null,
				lastDispatchError: "operator_requested_conversion_dispatch_retry",
				updatedAt: resolvedAt,
			})
			.where(
				and(
					eq(automationConversionEvents.id, row.id),
					eq(automationConversionEvents.dispatchStatus, "manual_review"),
					eq(
						automationConversionEvents.dispatchLeaseToken,
						row.dispatchLeaseToken,
					),
				),
			)
			.returning();
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId: row.organizationId,
			targetType: "automation_conversion_event",
			targetId: row.id,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState: automationConversionEventState(row),
			afterState: automationConversionEventState(updated),
			targetUpdatedAtBefore: row.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

async function resolveStripeEventOrganizationId(
	tx: ResolutionTransaction,
	row: typeof stripeEvents.$inferSelect,
): Promise<string | null> {
	if (row.organizationId) return row.organizationId;
	const identity = or(
		row.customerId
			? eq(organizationSubscriptions.stripeCustomerId, row.customerId)
			: undefined,
		row.subscriptionId
			? eq(organizationSubscriptions.stripeSubscriptionId, row.subscriptionId)
			: undefined,
	);
	if (!identity) return null;
	const subscriptions = await tx
		.selectDistinct({
			organizationId: organizationSubscriptions.organizationId,
		})
		.from(organizationSubscriptions)
		.where(identity)
		.limit(2);
	return subscriptions.length === 1
		? (subscriptions[0]?.organizationId ?? null)
		: null;
}

async function resolveStripeEvent(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(stripeEvents)
			.where(eq(stripeEvents.id, input.targetId))
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionNotFoundError();
		assertAllowed("stripe_event", row.status, input.action, {
			operatorRetryRequestedAt: row.operatorRetryRequestedAt,
		});
		const providerReference = input.providerReference?.trim();
		if (
			input.action === "abandon" &&
			(!providerReference || providerReference.length > 255)
		) {
			throw new OperatorResolutionInputError(
				"providerReference must contain between 1 and 255 characters to abandon a Stripe receipt after reconciliation",
			);
		}
		const providerReferenceDigest = providerReference
			? await sha256Hex(providerReference)
			: null;
		const resolvedAt = transitionAt(row.updatedAt);
		const organizationId = await resolveStripeEventOrganizationId(tx, row);
		const isRetry = input.action === "retry";
		const [updated] = await tx
			.update(stripeEvents)
			.set(
				isRetry
					? {
							status: "failed",
							attempts: 0,
							leaseToken: sql`${stripeEvents.leaseToken} + 1`,
							nextAttemptAt: resolvedAt,
							leaseExpiresAt: null,
							processedAt: null,
							manualReviewAt: null,
							operatorRetryRequestedAt: resolvedAt,
							lastError: "Operator requested a fenced receipt retry",
							lastErrorClass: "transient",
							updatedAt: resolvedAt,
						}
					: {
							status: "failed",
							// A terminal operator disposition must not preserve the raw Stripe
							// payload or the reconciliation reference. Only its digest enters
							// the append-only evidence state below.
							payload: {},
							leaseToken: sql`${stripeEvents.leaseToken} + 1`,
							leaseExpiresAt: null,
							processedAt: null,
							manualReviewAt: null,
							operatorRetryRequestedAt: null,
							lastError:
								"Operator abandoned Stripe receipt after provider reconciliation",
							lastErrorClass: "permanent",
							updatedAt: resolvedAt,
						},
			)
			.where(
				and(
					eq(stripeEvents.id, row.id),
					eq(stripeEvents.status, "manual_review"),
					eq(stripeEvents.leaseToken, row.leaseToken),
					isNull(stripeEvents.operatorRetryRequestedAt),
				),
			)
			.returning();
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId,
			targetType: "stripe_event",
			targetId: row.id,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState: stripeEventState(row),
			afterState: {
				...stripeEventState(updated),
				...(providerReferenceDigest
					? {
							reconciliation_reference_sha256: providerReferenceDigest,
						}
					: {}),
			},
			targetUpdatedAtBefore: row.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

async function resolveBillingOperation(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [identity] = await tx
			.select({
				billingPeriodId: billingOperations.billingPeriodId,
			})
			.from(billingOperations)
			.where(eq(billingOperations.id, input.targetId))
			.limit(1);
		if (!identity) throw new OperatorResolutionNotFoundError();
		const [period] = await tx
			.select()
			.from(billingPeriods)
			.where(eq(billingPeriods.id, identity.billingPeriodId))
			.for("update")
			.limit(1);
		const [row] = await tx
			.select()
			.from(billingOperations)
			.where(eq(billingOperations.id, input.targetId))
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionNotFoundError();
		if (row.lastError?.startsWith(LATE_BILLING_EFFECT_ALERT_PREFIX)) {
			if (input.action !== "mark_succeeded" && input.action !== "abandon") {
				throw new OperatorResolutionActionNotAllowedError(
					"billing_operation",
					row.status,
					input.action,
				);
			}
			const providerReference = input.providerReference?.trim();
			if (input.action === "mark_succeeded" && !providerReference) {
				throw new OperatorResolutionInputError(
					"providerReference is required to record a compensating invoice or credit",
				);
			}
			const resolvedAt = transitionAt(row.updatedAt);
			const providerReferenceDigest = providerReference
				? await sha256Hex(providerReference)
				: null;
			const resolutionMarker =
				input.action === "mark_succeeded"
					? `${LATE_BILLING_EFFECT_COMPENSATED_PREFIX}provider_reference_sha256=${providerReferenceDigest};resolved_at=${resolvedAt.toISOString()}`
					: `${LATE_BILLING_EFFECT_WAIVED_PREFIX}resolved_at=${resolvedAt.toISOString()}`;
			const [resolvedAlert] = await tx
				.update(billingOperations)
				.set({
					lastError: resolutionMarker,
					lastErrorClass: "permanent",
					leaseToken: sql`${billingOperations.leaseToken} + 1`,
					updatedAt: resolvedAt,
				})
				.where(
					and(
						eq(billingOperations.id, row.id),
						eq(billingOperations.status, row.status),
						eq(billingOperations.leaseToken, row.leaseToken),
						sql`${billingOperations.lastError} LIKE ${`${LATE_BILLING_EFFECT_ALERT_PREFIX}%`}`,
					),
				)
				.returning();
			if (!resolvedAlert) throw new OperatorResolutionStateConflictError();
			return appendEvidence(tx, {
				organizationId: row.organizationId,
				targetType: "billing_operation",
				targetId: row.id,
				action: input.action,
				reason: input.reason,
				actorUserId: input.actorUserId,
				beforeState: billingOperationState(row),
				afterState: billingOperationState(resolvedAlert),
				targetUpdatedAtBefore: row.updatedAt,
				targetUpdatedAtAfter: resolvedAlert.updatedAt,
			});
		}
		assertAllowed("billing_operation", row.status, input.action, {
			operatorRetryRequestedAt: row.operatorRetryRequestedAt,
		});
		if (input.action === "mark_succeeded" && !input.providerReference?.trim()) {
			throw new OperatorResolutionInputError(
				"providerReference is required to mark a billing operation succeeded",
			);
		}
		if (
			(input.action === "mark_not_applied" || input.action === "abandon") &&
			(period?.state !== "claimed" ||
				period.releaseCount !== 0 ||
				period.organizationId !== row.organizationId)
		) {
			throw new OperatorResolutionActionNotAllowedError(
				"billing_operation",
				row.status,
				input.action,
			);
		}
		let [attempt] = await tx
			.select()
			.from(billingOperationAttempts)
			.where(
				and(
					eq(billingOperationAttempts.billingOperationId, row.id),
					eq(billingOperationAttempts.organizationId, row.organizationId),
					eq(billingOperationAttempts.revision, row.attemptRevision),
				),
			)
			.for("update")
			.limit(1);
		const resolvedAt = transitionAt(row.updatedAt);
		let updated: typeof billingOperations.$inferSelect | undefined;
		if (input.action === "mark_succeeded") {
			const providerReference = input.providerReference?.trim();
			if (
				period?.state !== "claimed" ||
				period.organizationId !== row.organizationId ||
				!row.stripeInvoiceId ||
				!providerReference ||
				!attempt
			) {
				throw new OperatorResolutionActionNotAllowedError(
					"billing_operation",
					row.status,
					input.action,
				);
			}
			const [localInvoice] = await tx
				.select()
				.from(invoices)
				.where(
					and(
						eq(invoices.organizationId, row.organizationId),
						eq(invoices.stripeInvoiceId, row.stripeInvoiceId),
					),
				)
				.for("update")
				.limit(1);
			if (!localInvoice || localInvoice.status === "draft") {
				throw new OperatorResolutionInputError(
					"A finalized local invoice is required to settle the billing period",
				);
			}
			if (attempt.status === "succeeded") {
				if (attempt.stripeInvoiceItemId !== providerReference) {
					throw new OperatorResolutionStateConflictError();
				}
			} else {
				if (attempt.status !== "requesting" && attempt.status !== "unknown") {
					throw new OperatorResolutionActionNotAllowedError(
						"billing_operation",
						row.status,
						input.action,
					);
				}
				[attempt] = await tx
					.update(billingOperationAttempts)
					.set({
						status: "succeeded",
						stripeInvoiceItemId: providerReference,
						providerEvidence: {
							schema_version: 1,
							policy: "operator_resolution_v1",
							decision: "provider_effect_succeeded",
							action: "mark_succeeded",
							stripe_invoice_id: row.stripeInvoiceId,
							stripe_invoice_item_id: providerReference,
							evidence_id: input.reason.evidenceId,
							actor_user_id: input.actorUserId,
							resolved_at: resolvedAt.toISOString(),
						},
						resolvedAt,
					})
					.where(
						and(
							eq(billingOperationAttempts.id, attempt.id),
							inArray(billingOperationAttempts.status, [
								"requesting",
								"unknown",
							]),
						),
					)
					.returning();
				if (!attempt) throw new OperatorResolutionStateConflictError();
			}
			[updated] = await tx
				.update(billingOperations)
				.set({
					status: "succeeded" as const,
					stripeInvoiceItemId: providerReference,
					leaseToken: sql`${billingOperations.leaseToken} + 1`,
					leaseExpiresAt: null,
					lastError: null,
					lastErrorClass: null,
					operatorRetryRequestedAt: null,
					completedAt: resolvedAt,
					updatedAt: resolvedAt,
				})
				.where(
					and(
						eq(billingOperations.id, row.id),
						eq(billingOperations.status, row.status),
						eq(billingOperations.leaseToken, row.leaseToken),
						isNull(billingOperations.operatorRetryRequestedAt),
					),
				)
				.returning();
			const [settledPeriod] = await tx
				.update(billingPeriods)
				.set({
					state: "settled",
					invoiceId: localInvoice.id,
					stripeInvoiceId: row.stripeInvoiceId,
					settledAt: resolvedAt,
				})
				.where(
					and(
						eq(billingPeriods.id, period.id),
						eq(billingPeriods.state, "claimed"),
					),
				)
				.returning({ id: billingPeriods.id });
			if (!settledPeriod) throw new OperatorResolutionStateConflictError();
		} else if (input.action === "retry") {
			if (
				!attempt ||
				!["prepared", "requesting", "unknown"].includes(attempt.status)
			) {
				throw new OperatorResolutionActionNotAllowedError(
					"billing_operation",
					row.status,
					input.action,
				);
			}
			[updated] = await tx
				.update(billingOperations)
				.set({
					status: "unknown",
					attempts: 0,
					leaseToken: sql`${billingOperations.leaseToken} + 1`,
					nextAttemptAt: resolvedAt,
					leaseExpiresAt: null,
					lastError: "Operator requested provider reconciliation before retry",
					lastErrorClass: "unknown",
					operatorRetryRequestedAt: resolvedAt,
					completedAt: null,
					updatedAt: resolvedAt,
				})
				.where(
					and(
						eq(billingOperations.id, row.id),
						eq(billingOperations.status, row.status),
						eq(billingOperations.leaseToken, row.leaseToken),
						isNull(billingOperations.operatorRetryRequestedAt),
					),
				)
				.returning();
		} else if (input.action === "mark_not_applied") {
			if (attempt && !["rejected", "written_off"].includes(attempt.status)) {
				if (
					attempt.status !== "prepared" &&
					attempt.status !== "requesting" &&
					attempt.status !== "unknown"
				) {
					throw new OperatorResolutionActionNotAllowedError(
						"billing_operation",
						row.status,
						input.action,
					);
				}
				[attempt] = await tx
					.update(billingOperationAttempts)
					.set({
						status: "rejected",
						providerEvidence: {
							schema_version: 1,
							policy: "operator_resolution_v1",
							decision: "provider_effect_not_applied",
							action: "mark_not_applied",
							evidence_id: input.reason.evidenceId,
							actor_user_id: input.actorUserId,
							resolved_at: resolvedAt.toISOString(),
						},
						resolvedAt,
					})
					.where(
						and(
							eq(billingOperationAttempts.id, attempt.id),
							inArray(billingOperationAttempts.status, [
								"prepared",
								"requesting",
								"unknown",
							]),
						),
					)
					.returning();
				if (!attempt) throw new OperatorResolutionStateConflictError();
			}
			const nextRevision = row.attemptRevision + 1;
			[updated] = await tx
				.update(billingOperations)
				.set({
					kind: "catchup",
					status: "invoice_preparing",
					stripeInvoiceId: null,
					stripeInvoiceItemId: null,
					invoiceIdempotencyKey: `relayapi:overage:${row.billingPeriodId}:catchup-invoice:r${nextRevision}`,
					idempotencyKey: `relayapi:overage:${row.billingPeriodId}:catchup:r${nextRevision}`,
					attemptRevision: nextRevision,
					attempts: 0,
					leaseToken: sql`${billingOperations.leaseToken} + 1`,
					nextAttemptAt: resolvedAt,
					leaseExpiresAt: null,
					lastError:
						"Operator proved the prior effect was not applied; preparing a new catch-up revision",
					lastErrorClass: null,
					operatorRetryRequestedAt: null,
					completedAt: null,
					updatedAt: resolvedAt,
				})
				.where(
					and(
						eq(billingOperations.id, row.id),
						eq(billingOperations.status, row.status),
						eq(billingOperations.leaseToken, row.leaseToken),
						isNull(billingOperations.operatorRetryRequestedAt),
					),
				)
				.returning();
		} else {
			if (attempt?.status === "requesting") {
				[attempt] = await tx
					.update(billingOperationAttempts)
					.set({ status: "unknown" })
					.where(
						and(
							eq(billingOperationAttempts.id, attempt.id),
							eq(billingOperationAttempts.status, "requesting"),
						),
					)
					.returning();
				if (!attempt) throw new OperatorResolutionStateConflictError();
			}
			if (attempt && ["prepared", "unknown"].includes(attempt.status)) {
				[attempt] = await tx
					.update(billingOperationAttempts)
					.set({
						status: "written_off",
						providerEvidence: {
							schema_version: 1,
							policy: "operator_resolution_v1",
							decision: "write_off_without_additional_stripe_mutation",
							action: "abandon",
							evidence_id: input.reason.evidenceId,
							actor_user_id: input.actorUserId,
							resolved_at: resolvedAt.toISOString(),
						},
						resolvedAt,
					})
					.where(
						and(
							eq(billingOperationAttempts.id, attempt.id),
							inArray(billingOperationAttempts.status, ["prepared", "unknown"]),
						),
					)
					.returning();
				if (!attempt) throw new OperatorResolutionStateConflictError();
			} else if (attempt?.status === "succeeded") {
				throw new OperatorResolutionActionNotAllowedError(
					"billing_operation",
					row.status,
					input.action,
				);
			}

			[updated] = await tx
				.update(billingOperations)
				.set({
					status: "written_off",
					leaseToken: sql`${billingOperations.leaseToken} + 1`,
					leaseExpiresAt: null,
					lastError: "Operator explicitly wrote off this billing operation",
					lastErrorClass: "permanent",
					operatorRetryRequestedAt: null,
					completedAt: resolvedAt,
					updatedAt: resolvedAt,
				})
				.where(
					and(
						eq(billingOperations.id, row.id),
						eq(billingOperations.status, row.status),
						eq(billingOperations.leaseToken, row.leaseToken),
						isNull(billingOperations.operatorRetryRequestedAt),
					),
				)
				.returning();
			if (!period) throw new OperatorResolutionStateConflictError();
			const [writtenOffPeriod] = await tx
				.update(billingPeriods)
				.set({
					state: "written_off",
					writtenOffAt: resolvedAt,
					writeOffReason: "operator_abandoned_billing_operation",
					writeOffEvidence: {
						schema_version: 1,
						policy: "operator_resolution_v1",
						decision: "write_off_without_additional_stripe_mutation",
						action: "abandon",
						billing_operation_id: row.id,
						attempt_revision: row.attemptRevision,
						amount_cents: row.amountCents,
						currency: row.currency,
						evidence_id: input.reason.evidenceId,
						actor_user_id: input.actorUserId,
						written_off_at: resolvedAt.toISOString(),
					},
				})
				.where(
					and(
						eq(billingPeriods.id, period.id),
						eq(billingPeriods.state, "claimed"),
					),
				)
				.returning({ id: billingPeriods.id });
			if (!writtenOffPeriod) throw new OperatorResolutionStateConflictError();
		}
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId: row.organizationId,
			targetType: "billing_operation",
			targetId: row.id,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState: billingOperationState(row),
			afterState: billingOperationState(updated),
			targetUpdatedAtBefore: row.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

async function resolveTenantErasureJob(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(tenantDeletionJobs)
			.where(eq(tenantDeletionJobs.organizationId, input.targetId))
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionNotFoundError();
		if (!row.agedAlertedAt) {
			throw new OperatorResolutionActionNotAllowedError(
				"tenant_erasure_job",
				row.status,
				input.action,
			);
		}
		const resolvedAt = transitionAt(row.updatedAt);
		assertAllowed("tenant_erasure_job", row.status, input.action, {
			operatorRetryRequestedAt: row.operatorRetryRequestedAt,
			leaseExpiresAt: row.leaseExpiresAt,
			now: resolvedAt,
		});
		const [updated] = await tx
			.update(tenantDeletionJobs)
			.set({
				status: "failed",
				leaseToken: sql`${tenantDeletionJobs.leaseToken} + 1`,
				leaseExpiresAt: null,
				nextAttemptAt: resolvedAt,
				lastError: "Operator requested an aged erasure retry",
				operatorRetryRequestedAt: resolvedAt,
				completedAt: null,
				updatedAt: resolvedAt,
			})
			.where(
				and(
					eq(tenantDeletionJobs.organizationId, row.organizationId),
					eq(tenantDeletionJobs.status, row.status),
					eq(tenantDeletionJobs.leaseToken, row.leaseToken),
					isNull(tenantDeletionJobs.operatorRetryRequestedAt),
				),
			)
			.returning();
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId: row.organizationId,
			targetType: "tenant_erasure_job",
			targetId: row.organizationId,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState: tenantErasureState(row),
			afterState: tenantErasureState(updated),
			targetUpdatedAtBefore: row.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

async function resolveWorkspaceErasureJob(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(workspaceErasureJobs)
			.where(eq(workspaceErasureJobs.erasureOperationId, input.targetId))
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionNotFoundError();
		if (!row.agedAlertedAt) {
			throw new OperatorResolutionActionNotAllowedError(
				"workspace_erasure_job",
				row.status,
				input.action,
			);
		}
		const resolvedAt = transitionAt(row.updatedAt);
		assertAllowed("workspace_erasure_job", row.status, input.action, {
			operatorRetryRequestedAt: row.operatorRetryRequestedAt,
			leaseExpiresAt: row.leaseExpiresAt,
			now: resolvedAt,
		});
		const [updated] = await tx
			.update(workspaceErasureJobs)
			.set({
				status: "failed",
				leaseToken: sql`${workspaceErasureJobs.leaseToken} + 1`,
				leaseExpiresAt: null,
				nextAttemptAt: resolvedAt,
				lastError: "Operator requested an aged erasure retry",
				operatorRetryRequestedAt: resolvedAt,
				completedAt: null,
				updatedAt: resolvedAt,
			})
			.where(
				and(
					eq(workspaceErasureJobs.erasureOperationId, row.erasureOperationId),
					eq(workspaceErasureJobs.status, row.status),
					eq(workspaceErasureJobs.leaseToken, row.leaseToken),
					isNull(workspaceErasureJobs.operatorRetryRequestedAt),
				),
			)
			.returning();
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId: row.organizationId,
			targetType: "workspace_erasure_job",
			targetId: row.erasureOperationId,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState: workspaceErasureState(row),
			afterState: workspaceErasureState(updated),
			targetUpdatedAtBefore: row.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

async function resolveAccountRevocationJob(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(accountRevocationJobs)
			.where(eq(accountRevocationJobs.id, input.targetId))
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionNotFoundError();
		assertAllowed("account_revocation_job", row.status, input.action);
		const resolvedAt = transitionAt(row.updatedAt);
		const values =
			input.action === "mark_not_applied"
				? {
						status: "retry" as const,
						leaseToken: sql`${accountRevocationJobs.leaseToken} + 1`,
						leaseExpiresAt: null,
						requestMayHaveBeenSentAt: null,
						nextAttemptAt: resolvedAt,
						lastError:
							"Operator confirmed the provider revocation was not applied",
						completedAt: null,
						updatedAt: resolvedAt,
					}
				: {
						status:
							input.action === "mark_succeeded"
								? ("succeeded" as const)
								: ("abandoned" as const),
						accessTokenCiphertext: null,
						refreshTokenCiphertext: null,
						leaseToken: sql`${accountRevocationJobs.leaseToken} + 1`,
						leaseExpiresAt: null,
						lastError:
							input.action === "abandon"
								? "Provider cleanup explicitly abandoned by operator"
								: null,
						providerResponse:
							input.action === "mark_succeeded"
								? {
										operator_resolved: true,
										...(input.providerReference
											? {
													provider_reference: input.providerReference,
												}
											: {}),
									}
								: { operator_abandoned: true },
						completedAt: resolvedAt,
						updatedAt: resolvedAt,
					};
		const [updated] = await tx
			.update(accountRevocationJobs)
			.set(values)
			.where(
				and(
					eq(accountRevocationJobs.id, row.id),
					eq(accountRevocationJobs.status, row.status),
					eq(accountRevocationJobs.leaseToken, row.leaseToken),
					eq(accountRevocationJobs.sourceTokenVersion, row.sourceTokenVersion),
				),
			)
			.returning();
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId: row.organizationId,
			targetType: "account_revocation_job",
			targetId: row.id,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState: accountRevocationState(row),
			afterState: accountRevocationState(updated),
			targetUpdatedAtBefore: row.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

async function resolveExternalSubjectCleanupJob(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(externalSubjectCleanupJobs)
			.where(eq(externalSubjectCleanupJobs.id, input.targetId))
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionNotFoundError();
		assertAllowed("external_subject_cleanup_job", row.status, input.action);

		const resolvedAt = transitionAt(row.updatedAt);
		const values =
			input.action === "mark_succeeded"
				? {
						status: "completed" as const,
						leaseToken: sql`${externalSubjectCleanupJobs.leaseToken} + 1`,
						leaseExpiresAt: null,
						cursor: null,
						credentialCiphertext: null,
						lastError: null,
						completedAt: resolvedAt,
						purgeAt: new Date(
							resolvedAt.getTime() + EXTERNAL_SUBJECT_CLEANUP_RECEIPT_MS,
						),
						updatedAt: resolvedAt,
					}
				: {
						status: "pending" as const,
						attempts: 0,
						leaseToken: sql`${externalSubjectCleanupJobs.leaseToken} + 1`,
						nextAttemptAt: resolvedAt,
						leaseExpiresAt: null,
						deadlineAt: new Date(
							resolvedAt.getTime() + EXTERNAL_SUBJECT_CLEANUP_DEADLINE_MS,
						),
						lastError: "operator_requested_external_cleanup_retry",
						completedAt: null,
						purgeAt: null,
						updatedAt: resolvedAt,
					};
		const [updated] = await tx
			.update(externalSubjectCleanupJobs)
			.set(values)
			.where(
				and(
					eq(externalSubjectCleanupJobs.id, row.id),
					eq(externalSubjectCleanupJobs.status, "manual_review"),
					eq(externalSubjectCleanupJobs.leaseToken, row.leaseToken),
				),
			)
			.returning();
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId: row.organizationId,
			targetType: "external_subject_cleanup_job",
			targetId: row.id,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState: externalSubjectCleanupState(row),
			afterState: externalSubjectCleanupState(updated),
			targetUpdatedAtBefore: row.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

async function resolveShortLinkCreation(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(shortLinks)
			.where(eq(shortLinks.id, input.targetId))
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionNotFoundError();
		const reasonCode = shortLinkCreationReasonCode(row);
		assertAllowed("short_link_creation", row.creationStatus, input.action, {
			reasonCode,
		});

		const previousTimestamp = row.creationCompletedAt ?? row.createdAt;
		const resolvedAt = transitionAt(previousTimestamp);
		const beforeState = shortLinkCreationState(row);
		if (input.action === "mark_not_applied") {
			const [deleted] = await tx
				.delete(shortLinks)
				.where(
					and(
						eq(shortLinks.id, row.id),
						eq(shortLinks.creationStatus, "manual_review"),
						eq(shortLinks.creationFence, row.creationFence),
					),
				)
				.returning({ id: shortLinks.id });
			if (!deleted) throw new OperatorResolutionStateConflictError();
			return appendEvidence(tx, {
				organizationId: row.organizationId,
				targetType: "short_link_creation",
				targetId: row.id,
				action: input.action,
				reason: input.reason,
				actorUserId: input.actorUserId,
				beforeState,
				afterState: {
					status: "deleted",
					creation_fence: row.creationFence,
					operator_resolved: true,
				},
				targetUpdatedAtBefore: previousTimestamp,
				targetUpdatedAtAfter: resolvedAt,
			});
		}

		if (!row.shortCode || !row.shortUrl) {
			throw new OperatorResolutionActionNotAllowedError(
				"short_link_creation",
				row.creationStatus,
				input.action,
			);
		}
		const [updated] = await tx
			.update(shortLinks)
			.set({
				creationStatus: "active",
				creationFence: sql`${shortLinks.creationFence} + 1`,
				creationCompletedAt: resolvedAt,
				creationLastError: null,
			})
			.where(
				and(
					eq(shortLinks.id, row.id),
					eq(shortLinks.creationStatus, "manual_review"),
					eq(shortLinks.creationFence, row.creationFence),
					eq(shortLinks.shortCode, row.shortCode),
					eq(shortLinks.shortUrl, row.shortUrl),
				),
			)
			.returning();
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId: row.organizationId,
			targetType: "short_link_creation",
			targetId: row.id,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState,
			afterState: shortLinkCreationState(updated),
			targetUpdatedAtBefore: previousTimestamp,
			targetUpdatedAtAfter: updated.creationCompletedAt ?? resolvedAt,
		});
	});
}

async function resolveCustomerWebhookDelivery(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.id, input.targetId))
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionNotFoundError();
		assertAllowed("customer_webhook_delivery", row.status, input.action, {
			operatorRetryRequestedAt: row.operatorRetryRequestedAt,
			reasonCode: row.manualReviewReason ?? undefined,
		});
		if (
			row.manualReviewReason !== "pre_http_repair_exhausted" &&
			row.manualReviewReason !== "http_outcome_unknown"
		) {
			throw new OperatorResolutionActionNotAllowedError(
				"customer_webhook_delivery",
				row.status,
				input.action,
			);
		}
		const manualReviewReason = row.manualReviewReason;
		const knownNotSent = manualReviewReason === "pre_http_repair_exhausted";
		if (
			(knownNotSent && row.requestMayHaveBeenSentAt !== null) ||
			(!knownNotSent && row.requestMayHaveBeenSentAt === null)
		) {
			throw new OperatorResolutionActionNotAllowedError(
				"customer_webhook_delivery",
				row.status,
				input.action,
			);
		}

		const resolvedAt = transitionAt(row.updatedAt);
		if (
			!row.manualReviewUntil ||
			row.manualReviewUntil.getTime() <= resolvedAt.getTime()
		) {
			throw new OperatorResolutionActionNotAllowedError(
				"customer_webhook_delivery",
				row.status,
				input.action,
			);
		}
		const boundaryFence = row.requestMayHaveBeenSentAt
			? eq(
					webhookDeliveries.requestMayHaveBeenSentAt,
					row.requestMayHaveBeenSentAt,
				)
			: isNull(webhookDeliveries.requestMayHaveBeenSentAt);
		const retrying = input.action === "retry";
		const terminalStatus =
			input.action === "mark_succeeded"
				? ("succeeded" as const)
				: ("failed" as const);
		const terminalError =
			input.action === "mark_succeeded"
				? "Operator confirmed the ambiguous delivery was received"
				: input.action === "mark_not_applied"
					? "Operator confirmed the ambiguous delivery was not received"
					: "Operator abandoned a known-not-sent delivery after review";
		const [updated] = await tx
			.update(webhookDeliveries)
			.set(
				retrying
					? {
							status: "pending",
							repairAttempts: 0,
							repairDeadlineAt: new Date(
								resolvedAt.getTime() + CUSTOMER_WEBHOOK_REPAIR_WINDOW_MS,
							),
							leaseToken: sql`${webhookDeliveries.leaseToken} + 1`,
							leaseExpiresAt: null,
							claimedAt: null,
							requestMayHaveBeenSentAt: null,
							completedAt: null,
							statusCode: null,
							responseTimeMs: null,
							manualReviewReason: null,
							manualReviewUntil: null,
							operatorIntervenedAt: row.operatorIntervenedAt ?? resolvedAt,
							operatorRetryRequestedAt: resolvedAt,
							error: knownNotSent
								? "Operator requested a fenced pre-HTTP delivery repair retry"
								: "Operator authorized a fenced retry after reconciling an ambiguous delivery",
							nextAttemptAt: resolvedAt,
							dispatchLeaseId: null,
							dispatchLeaseExpiresAt: null,
							nextDispatchAt: resolvedAt,
							lastEnqueuedAt: null,
							dispatchAttempts: 0,
							updatedAt: resolvedAt,
						}
					: {
							status: terminalStatus,
							leaseToken: sql`${webhookDeliveries.leaseToken} + 1`,
							leaseExpiresAt: null,
							claimedAt: null,
							requestMayHaveBeenSentAt: row.requestMayHaveBeenSentAt,
							completedAt: resolvedAt,
							statusCode: null,
							manualReviewReason: null,
							manualReviewUntil: null,
							operatorIntervenedAt: row.operatorIntervenedAt ?? resolvedAt,
							error: input.action === "mark_succeeded" ? null : terminalError,
							nextAttemptAt: resolvedAt,
							dispatchLeaseId: null,
							dispatchLeaseExpiresAt: null,
							nextDispatchAt: resolvedAt,
							lastEnqueuedAt: null,
							updatedAt: resolvedAt,
						},
			)
			.where(
				and(
					eq(webhookDeliveries.id, row.id),
					eq(webhookDeliveries.status, "manual_review"),
					eq(webhookDeliveries.manualReviewReason, manualReviewReason),
					eq(webhookDeliveries.manualReviewUntil, row.manualReviewUntil),
					eq(webhookDeliveries.leaseToken, row.leaseToken),
					boundaryFence,
					row.operatorIntervenedAt
						? eq(
								webhookDeliveries.operatorIntervenedAt,
								row.operatorIntervenedAt,
							)
						: isNull(webhookDeliveries.operatorIntervenedAt),
					retrying
						? isNull(webhookDeliveries.operatorRetryRequestedAt)
						: undefined,
				),
			)
			.returning();
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId: row.organizationId,
			targetType: "customer_webhook_delivery",
			targetId: row.id,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState: customerWebhookDeliveryState(row),
			afterState: customerWebhookDeliveryState(updated),
			targetUpdatedAtBefore: row.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

async function resolveToolJob(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [candidate] = await tx
			.select({
				usageReservationId: toolJobs.usageReservationId,
			})
			.from(toolJobs)
			.where(eq(toolJobs.id, input.targetId))
			.limit(1);
		if (!candidate) throw new OperatorResolutionNotFoundError();
		const [usageCandidate] = await tx
			.select({ bucketId: usageReservations.bucketId })
			.from(usageReservations)
			.where(eq(usageReservations.id, candidate.usageReservationId))
			.limit(1);
		if (!usageCandidate) throw new OperatorResolutionNotFoundError();

		const [bucket] = await tx
			.select({ id: usageBuckets.id, periodEnd: usageBuckets.periodEnd })
			.from(usageBuckets)
			.where(eq(usageBuckets.id, usageCandidate.bucketId))
			.for("update")
			.limit(1);
		const [reservation] = await tx
			.select()
			.from(usageReservations)
			.where(eq(usageReservations.id, candidate.usageReservationId))
			.for("update")
			.limit(1);
		const [job] = await tx
			.select()
			.from(toolJobs)
			.where(eq(toolJobs.id, input.targetId))
			.for("update")
			.limit(1);
		if (!job || !reservation || !bucket) {
			throw new OperatorResolutionNotFoundError();
		}
		const resolvedAt = transitionAt(job.updatedAt);
		const retryable = bucket.periodEnd.getTime() > resolvedAt.getTime();
		assertAllowed("tool_job", job.status, input.action, {
			reasonCode: retryable
				? "provider_outcome_unknown_retryable"
				: "provider_outcome_unknown_closed_window",
		});
		if (
			job.errorCode !== "PROVIDER_OUTCOME_UNKNOWN" ||
			job.requestMayHaveBeenSentAt === null ||
			reservation.state !== "parked" ||
			reservation.disposition !== "unknown" ||
			reservation.requestMayHaveBeenSentAt === null
		) {
			throw new OperatorResolutionActionNotAllowedError(
				"tool_job",
				job.status,
				input.action,
			);
		}

		const beforeState = toolJobState(job, reservation);
		if (input.action === "mark_not_applied") {
			const usageRows = await tx
				.update(usageReservations)
				.set({
					state: "reserved",
					disposition: "pending",
					committedUnits: null,
					responseStatus: null,
					requestMayHaveBeenSentAt: null,
					finalizedAt: null,
				})
				.where(
					and(
						eq(usageReservations.id, reservation.id),
						eq(usageReservations.state, "parked"),
						eq(usageReservations.disposition, "unknown"),
						eq(
							usageReservations.requestMayHaveBeenSentAt,
							reservation.requestMayHaveBeenSentAt,
						),
					),
				)
				.returning();
			if (usageRows.length !== 1) {
				throw new OperatorResolutionStateConflictError();
			}
			const [updated] = await tx
				.update(toolJobs)
				.set({
					status: "pending",
					attempts: 0,
					leaseToken: sql`${toolJobs.leaseToken} + 1`,
					nextAttemptAt: resolvedAt,
					lastEnqueuedAt: null,
					leaseExpiresAt: null,
					requestMayHaveBeenSentAt: null,
					deadlineAt: new Date(resolvedAt.getTime() + TOOL_JOB_DEADLINE_MS),
					resultCiphertext: null,
					errorCiphertext: null,
					errorCode: null,
					completedAt: null,
					purgeAt: new Date(
						resolvedAt.getTime() +
							TOOL_JOB_DEADLINE_MS +
							TOOL_JOB_TERMINAL_TTL_MS,
					),
					updatedAt: resolvedAt,
				})
				.where(
					and(
						eq(toolJobs.id, job.id),
						eq(toolJobs.status, "manual_review"),
						eq(toolJobs.leaseToken, job.leaseToken),
						eq(toolJobs.requestMayHaveBeenSentAt, job.requestMayHaveBeenSentAt),
					),
				)
				.returning();
			const resetReservation = usageRows[0];
			if (!updated || !resetReservation) {
				throw new OperatorResolutionStateConflictError();
			}
			return appendEvidence(tx, {
				organizationId: job.organizationId,
				targetType: "tool_job",
				targetId: job.id,
				action: input.action,
				reason: input.reason,
				actorUserId: input.actorUserId,
				beforeState,
				afterState: toolJobState(updated, resetReservation),
				targetUpdatedAtBefore: job.updatedAt,
				targetUpdatedAtAfter: updated.updatedAt,
			});
		}

		// Abandon is an audited write-off: the provider outcome remains unknown,
		// but no units may remain parked forever or leak into a later settlement.
		const [writtenOffReservation] = await tx
			.update(usageReservations)
			.set({
				state: "released",
				disposition: "written_off",
				committedUnits: 0,
				responseStatus: null,
				writeOffReason: "operator_abandoned_unknown_provider_outcome",
				writeOffEvidence: {
					schema_version: 1,
					policy: "operator_resolution_v1",
					decision: "release_without_charge",
					action: "abandon",
					target_type: "tool_job",
					target_id: job.id,
					actor_user_id: input.actorUserId,
					reserved_units: reservation.units,
					reserved_at: reservation.reservedAt.toISOString(),
					request_boundary_at:
						reservation.requestMayHaveBeenSentAt.toISOString(),
					written_off_at: resolvedAt.toISOString(),
				},
				writtenOffAt: resolvedAt,
				finalizedAt: resolvedAt,
			})
			.where(
				and(
					eq(usageReservations.id, reservation.id),
					eq(usageReservations.state, "parked"),
					eq(usageReservations.disposition, "unknown"),
					eq(
						usageReservations.requestMayHaveBeenSentAt,
						reservation.requestMayHaveBeenSentAt,
					),
				),
			)
			.returning();
		if (!writtenOffReservation) {
			throw new OperatorResolutionStateConflictError();
		}

		const [updated] = await tx
			.update(toolJobs)
			.set({
				status: "failed",
				requestCiphertext: null,
				errorCode: "OPERATOR_ABANDONED",
				leaseToken: sql`${toolJobs.leaseToken} + 1`,
				leaseExpiresAt: null,
				purgeAt: new Date(resolvedAt.getTime() + TOOL_JOB_TERMINAL_TTL_MS),
				updatedAt: resolvedAt,
			})
			.where(
				and(
					eq(toolJobs.id, job.id),
					eq(toolJobs.status, "manual_review"),
					eq(toolJobs.leaseToken, job.leaseToken),
				),
			)
			.returning();
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId: job.organizationId,
			targetType: "tool_job",
			targetId: job.id,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState,
			afterState: toolJobState(updated, writtenOffReservation),
			targetUpdatedAtBefore: job.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

async function resolveWhatsappPhoneProvisioningOperation(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [candidate] = await tx
			.select({
				phoneNumberId: whatsappPhoneProvisioningOperations.phoneNumberId,
				organizationId: whatsappPhoneProvisioningOperations.organizationId,
			})
			.from(whatsappPhoneProvisioningOperations)
			.where(
				eq(
					whatsappPhoneProvisioningOperations.provisioningOperationId,
					input.targetId,
				),
			)
			.limit(1);
		if (!candidate) throw new OperatorResolutionNotFoundError();

		// Release staging locks the phone first. Taking the same parent lock makes
		// the "no release exists" decision stable until this retry transition
		// commits.
		const [phone] = await tx
			.select({ id: whatsappPhoneNumbers.id })
			.from(whatsappPhoneNumbers)
			.where(
				and(
					eq(whatsappPhoneNumbers.id, candidate.phoneNumberId),
					eq(whatsappPhoneNumbers.organizationId, candidate.organizationId),
				),
			)
			.for("update")
			.limit(1);
		if (!phone) throw new OperatorResolutionNotFoundError();

		const [row] = await tx
			.select()
			.from(whatsappPhoneProvisioningOperations)
			.where(
				and(
					eq(
						whatsappPhoneProvisioningOperations.provisioningOperationId,
						input.targetId,
					),
					eq(
						whatsappPhoneProvisioningOperations.phoneNumberId,
						candidate.phoneNumberId,
					),
				),
			)
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionStateConflictError();
		await assertNoTerminalOperatorDecision(
			tx,
			"whatsapp_phone_provisioning_operation",
			row.provisioningOperationId,
		);

		const [release] = await tx
			.select({ id: whatsappPhoneReleaseOperations.releaseOperationId })
			.from(whatsappPhoneReleaseOperations)
			.where(
				eq(whatsappPhoneReleaseOperations.phoneNumberId, row.phoneNumberId),
			)
			.limit(1);
		const economicBoundaryRecorded =
			row.stripeCheckoutSessionId !== null ||
			["telnyx_order", "meta_registration", "completed"].includes(
				row.provisioningPhase,
			);
		const reasonCode = release
			? "provisioning_fenced_for_release"
			: economicBoundaryRecorded
				? "provisioning_economic_boundary_recorded"
				: "provisioning_reconciliation_exhausted";
		assertAllowed(
			"whatsapp_phone_provisioning_operation",
			row.provisioningState,
			input.action,
			{ reasonCode },
		);

		const resolvedAt = transitionAt(row.updatedAt);
		const retry = input.action === "retry";
		const [updated] = await tx
			.update(whatsappPhoneProvisioningOperations)
			.set({
				provisioningState: retry ? "unknown" : "manual_review",
				provisioningAttempts: retry ? 0 : row.provisioningAttempts,
				provisioningLeaseToken: sql`${whatsappPhoneProvisioningOperations.provisioningLeaseToken} + 1`,
				provisioningLeaseExpiresAt: null,
				provisioningNextAttemptAt: resolvedAt,
				provisioningLastError: retry
					? "Operator requested a fenced provider-state reconciliation"
					: input.action === "mark_succeeded"
						? "Operator confirmed the provisioning effect succeeded; economic outcome recorded"
						: "Operator confirmed the provisioning effect was not applied; economic outcome recorded",
				updatedAt: resolvedAt,
			})
			.where(
				and(
					eq(
						whatsappPhoneProvisioningOperations.provisioningOperationId,
						row.provisioningOperationId,
					),
					eq(
						whatsappPhoneProvisioningOperations.provisioningState,
						"manual_review",
					),
					eq(
						whatsappPhoneProvisioningOperations.provisioningLeaseToken,
						row.provisioningLeaseToken,
					),
				),
			)
			.returning();
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId: row.organizationId,
			targetType: "whatsapp_phone_provisioning_operation",
			targetId: row.provisioningOperationId,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState: phoneProvisioningState(row),
			afterState: phoneProvisioningState(updated),
			targetUpdatedAtBefore: row.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

function phoneReleaseReasonCode(
	row: typeof whatsappPhoneReleaseOperations.$inferSelect,
):
	| "ambiguous_meta_deregistration"
	| "manual_meta_deregistration_required"
	| "manual_phone_release_provider_resolution" {
	if (row.releasePhase === "meta" && row.releaseMetaStatus === "unknown") {
		return "ambiguous_meta_deregistration";
	}
	if (row.releasePhase === "meta" && row.releaseMetaStatus === "pending") {
		return "manual_meta_deregistration_required";
	}
	return "manual_phone_release_provider_resolution";
}

async function resolveWhatsappPhoneReleaseOperation(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(whatsappPhoneReleaseOperations)
			.where(
				eq(whatsappPhoneReleaseOperations.releaseOperationId, input.targetId),
			)
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionNotFoundError();
		const reasonCode = phoneReleaseReasonCode(row);
		assertAllowed(
			"whatsapp_phone_release_operation",
			row.releaseState,
			input.action,
			{ reasonCode },
		);

		const resolvedAt = transitionAt(row.updatedAt);
		const markSucceeded = input.action === "mark_succeeded";
		const retry = input.action === "retry";
		const succeededPhaseValues =
			row.releasePhase === "meta"
				? {
						releasePhase: "stripe" as const,
						releaseMetaStatus: "confirmed" as const,
					}
				: row.releasePhase === "stripe"
					? {
							releasePhase: "telnyx" as const,
							releaseStripeStatus: "confirmed" as const,
						}
					: {
							releasePhase: "completed" as const,
							releaseTelnyxStatus: "confirmed" as const,
						};
		const [updated] = await tx
			.update(whatsappPhoneReleaseOperations)
			.set({
				releaseState:
					retry && row.releaseRequestMayHaveBeenSentAt !== null
						? "unknown"
						: "failed",
				...(markSucceeded
					? succeededPhaseValues
					: input.action === "mark_not_applied"
						? {
								releasePhase: "meta" as const,
								releaseMetaStatus: "pending" as const,
							}
						: {}),
				releaseLeaseToken: sql`${whatsappPhoneReleaseOperations.releaseLeaseToken} + 1`,
				releaseLeaseExpiresAt: null,
				releaseRequestMayHaveBeenSentAt: null,
				releaseNextAttemptAt: resolvedAt,
				releaseLastError: retry
					? "Operator requested fenced release reconciliation"
					: markSucceeded
						? `Operator confirmed ${row.releasePhase} release completed`
						: "Operator confirmed Meta deregistration was not applied",
				updatedAt: resolvedAt,
			})
			.where(
				and(
					eq(
						whatsappPhoneReleaseOperations.releaseOperationId,
						row.releaseOperationId,
					),
					eq(whatsappPhoneReleaseOperations.releaseState, "manual_review"),
					eq(
						whatsappPhoneReleaseOperations.releaseLeaseToken,
						row.releaseLeaseToken,
					),
					eq(whatsappPhoneReleaseOperations.releasePhase, row.releasePhase),
					eq(
						whatsappPhoneReleaseOperations.releaseMetaStatus,
						row.releaseMetaStatus,
					),
				),
			)
			.returning();
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId: row.organizationId,
			targetType: "whatsapp_phone_release_operation",
			targetId: row.releaseOperationId,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState: phoneReleaseState(row),
			afterState: phoneReleaseState(updated),
			targetUpdatedAtBefore: row.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

async function resolveWhatsappPhoneBillingOperation(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(whatsappPhoneBillingOperations)
			.where(eq(whatsappPhoneBillingOperations.id, input.targetId))
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionNotFoundError();
		assertAllowed("whatsapp_phone_billing_operation", row.state, input.action);
		const [attempt] = await tx
			.select()
			.from(whatsappPhoneBillingAttempts)
			.where(
				and(
					eq(whatsappPhoneBillingAttempts.phoneBillingOperationId, row.id),
					eq(whatsappPhoneBillingAttempts.organizationId, row.organizationId),
					eq(whatsappPhoneBillingAttempts.revision, row.revision),
				),
			)
			.for("update")
			.limit(1);
		if (!attempt) {
			throw new OperatorResolutionInputError(
				"The immutable phone billing attempt evidence is missing",
			);
		}
		if (
			input.action === "mark_succeeded" &&
			row.desiredQuantity > 0 &&
			(!row.stripeSubscriptionId || !row.stripeSubscriptionItemId)
		) {
			throw new OperatorResolutionInputError(
				"A Stripe subscription and item must be recorded before this phone quantity can be marked succeeded",
			);
		}
		const resolvedAt = transitionAt(row.updatedAt);
		const values =
			input.action === "mark_succeeded"
				? {
						state: "applied" as const,
						appliedQuantity: row.desiredQuantity,
						requestMayHaveBeenSentAt: null,
						leaseToken: sql`${whatsappPhoneBillingOperations.leaseToken} + 1`,
						leaseExpiresAt: null,
						lastError: null,
						appliedAt: resolvedAt,
						updatedAt: resolvedAt,
					}
				: {
						state: "pending" as const,
						revision: row.revision + 1,
						idempotencyKey: `wa-phone-addon:${row.organizationId}:operator-r${row.revision + 1}`,
						stripeCheckoutSessionId: null,
						requestMayHaveBeenSentAt: null,
						leaseToken: sql`${whatsappPhoneBillingOperations.leaseToken} + 1`,
						leaseExpiresAt: null,
						attempts: 0,
						nextAttemptAt: resolvedAt,
						lastError:
							"Operator confirmed the Stripe phone mutation was not applied",
						appliedAt: null,
						updatedAt: resolvedAt,
					};
		const [updated] = await tx
			.update(whatsappPhoneBillingOperations)
			.set(values)
			.where(
				and(
					eq(whatsappPhoneBillingOperations.id, row.id),
					eq(whatsappPhoneBillingOperations.state, row.state),
					eq(whatsappPhoneBillingOperations.leaseToken, row.leaseToken),
				),
			)
			.returning();
		if (!updated) throw new OperatorResolutionStateConflictError();
		const [attemptUpdated] = await tx
			.update(whatsappPhoneBillingAttempts)
			.set({
				status:
					input.action === "mark_succeeded"
						? "applied"
						: "confirmed_not_applied",
				stripeCheckoutSessionId: row.stripeCheckoutSessionId,
				stripeSubscriptionId: row.stripeSubscriptionId,
				stripeSubscriptionItemId: row.stripeSubscriptionItemId,
				stripeLatestInvoiceId: row.stripeLatestInvoiceId,
				providerEvidence: sql`COALESCE(${whatsappPhoneBillingAttempts.providerEvidence}, '{}'::jsonb)
					|| jsonb_build_object(
						${input.action === "mark_succeeded" ? "operatorConfirmedApplied" : "operatorConfirmedNotApplied"},
						true
					)`,
				resolvedAt,
			})
			.where(
				and(
					eq(whatsappPhoneBillingAttempts.id, attempt.id),
					inArray(whatsappPhoneBillingAttempts.status, [
						"unknown",
						"manual_review",
					]),
				),
			)
			.returning({ id: whatsappPhoneBillingAttempts.id });
		if (!attemptUpdated) throw new OperatorResolutionStateConflictError();
		if (input.action === "mark_not_applied") {
			if (!updated.stripeCustomerId) {
				throw new OperatorResolutionInputError(
					"A Stripe customer is required for the next phone billing revision",
				);
			}
			await tx.insert(whatsappPhoneBillingAttempts).values({
				organizationId: updated.organizationId,
				phoneBillingOperationId: updated.id,
				revision: updated.revision,
				status: "prepared",
				desiredQuantity: updated.desiredQuantity,
				priorAppliedQuantity: updated.appliedQuantity,
				stripeCustomerId: updated.stripeCustomerId,
				idempotencyKey: updated.idempotencyKey,
			});
		}
		if (input.action === "mark_succeeded") {
			await tx
				.update(whatsappPhoneNumbers)
				.set({
					stripePhoneSubscriptionId:
						row.desiredQuantity > 0 ? row.stripeSubscriptionId : null,
					stripeSubscriptionItemId:
						row.desiredQuantity > 0 ? row.stripeSubscriptionItemId : null,
					updatedAt: resolvedAt,
				})
				.where(
					and(
						eq(whatsappPhoneNumbers.organizationId, row.organizationId),
						inArray(whatsappPhoneNumbers.status, [
							"purchasing",
							"pending_verification",
							"verified",
							"active",
						]),
					),
				);
		}
		return appendEvidence(tx, {
			organizationId: row.organizationId,
			targetType: "whatsapp_phone_billing_operation",
			targetId: row.id,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState: phoneBillingState(row),
			afterState: phoneBillingState(updated),
			targetUpdatedAtBefore: row.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

function adCreationReasonCode(
	row: typeof adCreationOperations.$inferSelect,
):
	| "ad_creation_pre_provider_retries_exhausted"
	| "ad_creation_provider_progress_recorded"
	| "ambiguous_ad_provider_creation" {
	if (hasAdCreationProviderEffect(row)) {
		return "ad_creation_provider_progress_recorded";
	}
	return row.requestMayHaveBeenSentAt === null
		? "ad_creation_pre_provider_retries_exhausted"
		: "ambiguous_ad_provider_creation";
}

async function resolveAdCreationOperation(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(adCreationOperations)
			.where(eq(adCreationOperations.id, input.targetId))
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionNotFoundError();
		await assertNoTerminalOperatorDecision(tx, "ad_creation_operation", row.id);
		assertAllowed("ad_creation_operation", row.status, input.action, {
			reasonCode: adCreationReasonCode(row),
		});
		const resolvedAt = transitionAt(row.updatedAt);
		const retry = input.action === "retry";
		const [updated] = await tx
			.update(adCreationOperations)
			.set({
				status: retry ? "failed" : "manual_review",
				...(retry ? { attempts: 0 } : {}),
				leaseToken: sql`${adCreationOperations.leaseToken} + 1`,
				leaseExpiresAt: null,
				nextAttemptAt: resolvedAt,
				lastError: retry
					? "Operator requested a safe pre-provider retry"
					: input.action === "mark_succeeded"
						? "Operator confirmed provider creation succeeded; economic outcome recorded"
						: "Operator confirmed provider creation was not applied; economic outcome recorded",
				updatedAt: resolvedAt,
			})
			.where(
				and(
					eq(adCreationOperations.id, row.id),
					eq(adCreationOperations.status, "manual_review"),
					eq(adCreationOperations.leaseToken, row.leaseToken),
				),
			)
			.returning();
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId: row.organizationId,
			targetType: "ad_creation_operation",
			targetId: row.id,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState: adCreationState(row),
			afterState: adCreationState(updated),
			targetUpdatedAtBefore: row.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

async function resolveAdMutationOperation(
	db: Database,
	input: PreparedOperatorResolutionInput,
): Promise<EvidenceRow> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(adMutationOperations)
			.where(eq(adMutationOperations.id, input.targetId))
			.for("update")
			.limit(1);
		if (!row) throw new OperatorResolutionNotFoundError();
		await assertNoTerminalOperatorDecision(tx, "ad_mutation_operation", row.id);
		const providerWasConfirmed =
			row.phase !== "provider" || row.providerConfirmedAt !== null;
		const reasonCode = providerWasConfirmed
			? "confirmed_ad_provider_mutation_projection_pending"
			: row.status === "manual_review" && row.requestMayHaveBeenSentAt === null
				? "ad_mutation_pre_provider_retries_exhausted"
				: "ambiguous_ad_provider_mutation";
		assertAllowed("ad_mutation_operation", row.status, input.action, {
			reasonCode,
		});
		const resolvedAt = transitionAt(row.updatedAt);
		const retry = input.action === "retry";
		const updated =
			input.action === "mark_succeeded"
				? await projectOperatorConfirmedAdMutation(tx, row, resolvedAt)
				: (
						await tx
							.update(adMutationOperations)
							.set({
								// `failed` releases the target-active uniqueness fence. For a
								// not-applied decision, same-key replay is separately fenced by
								// append-only terminal evidence; retry evidence is nonterminal.
								status: "failed",
								phase: "provider",
								requestMayHaveBeenSentAt: null,
								providerConfirmedAt: null,
								leaseToken: sql`${adMutationOperations.leaseToken} + 1`,
								leaseExpiresAt: null,
								attempts: retry ? 0 : row.attempts,
								nextAttemptAt: resolvedAt,
								lastError: retry
									? "Operator requested a safe pre-provider retry"
									: "Operator confirmed the provider mutation was not applied",
								completedAt: null,
								updatedAt: resolvedAt,
							})
							.where(
								and(
									eq(adMutationOperations.id, row.id),
									eq(adMutationOperations.status, row.status),
									eq(adMutationOperations.leaseToken, row.leaseToken),
								),
							)
							.returning()
					)[0];
		if (!updated) throw new OperatorResolutionStateConflictError();
		return appendEvidence(tx, {
			organizationId: row.organizationId,
			targetType: "ad_mutation_operation",
			targetId: row.id,
			action: input.action,
			reason: input.reason,
			actorUserId: input.actorUserId,
			beforeState: adMutationState(row),
			afterState: adMutationState(updated),
			targetUpdatedAtBefore: row.updatedAt,
			targetUpdatedAtAfter: updated.updatedAt,
		});
	});
}

export async function resolveOperatorResolution(
	db: Database,
	input: ResolveOperatorResolutionInput,
	encryptionKey: string,
): Promise<EvidenceWithReason> {
	const reason = input.reason.trim();
	const actorUserId = input.actorUserId.trim();
	if (reason.length < 1 || reason.length > 500) {
		throw new OperatorResolutionInputError(
			"reason must contain between 1 and 500 characters",
		);
	}
	if (actorUserId.length < 1 || actorUserId.length > 255) {
		throw new OperatorResolutionInputError("actorUserId is invalid");
	}
	const evidenceId = generateId("ore_");
	const normalized: PreparedOperatorResolutionInput = {
		...input,
		reason: {
			evidenceId,
			digest: await sha256Hex(reason),
			ciphertext: await encryptToken(reason, encryptionKey, {
				recordId: evidenceId,
				field: "note_ciphertext",
			}),
		},
		actorUserId,
	};
	let evidence: EvidenceRow | undefined;
	switch (input.targetType) {
		case "automation_effect":
			evidence = await resolveAutomationEffect(db, normalized);
			break;
		case "automation_binding":
			evidence = await resolveAutomationBinding(db, normalized);
			break;
		case "automation_conversion_event":
			evidence = await resolveAutomationConversionEvent(db, normalized);
			break;
		case "stripe_event":
			evidence = await resolveStripeEvent(db, normalized);
			break;
		case "billing_operation":
			evidence = await resolveBillingOperation(db, normalized);
			break;
		case "tenant_erasure_job":
			evidence = await resolveTenantErasureJob(db, normalized);
			break;
		case "workspace_erasure_job":
			evidence = await resolveWorkspaceErasureJob(db, normalized);
			break;
		case "account_revocation_job":
			evidence = await resolveAccountRevocationJob(db, normalized);
			break;
		case "external_subject_cleanup_job":
			evidence = await resolveExternalSubjectCleanupJob(db, normalized);
			break;
		case "short_link_creation":
			evidence = await resolveShortLinkCreation(db, normalized);
			break;
		case "customer_webhook_delivery":
			evidence = await resolveCustomerWebhookDelivery(db, normalized);
			break;
		case "tool_job":
			evidence = await resolveToolJob(db, normalized);
			break;
		case "whatsapp_phone_provisioning_operation":
			evidence = await resolveWhatsappPhoneProvisioningOperation(
				db,
				normalized,
			);
			break;
		case "whatsapp_phone_release_operation":
			evidence = await resolveWhatsappPhoneReleaseOperation(db, normalized);
			break;
		case "whatsapp_phone_billing_operation":
			evidence = await resolveWhatsappPhoneBillingOperation(db, normalized);
			break;
		case "ad_creation_operation":
			evidence = await resolveAdCreationOperation(db, normalized);
			break;
		case "ad_mutation_operation":
			evidence = await resolveAdMutationOperation(db, normalized);
			break;
	}
	if (!evidence) {
		throw new OperatorResolutionInputError(
			`Unsupported operator-resolution target: ${input.targetType}`,
		);
	}
	return { ...evidence, reason };
}

export function serializeOperatorResolutionEvidence(row: EvidenceWithReason) {
	return {
		id: row.id,
		organizationId: row.organizationId,
		targetType: row.targetType,
		targetId: row.targetId,
		action: row.action,
		reason: row.reason,
		reasonCode: row.reasonCode,
		reasonDigest: row.reasonDigest,
		actorUserId: row.actorUserId,
		beforeState: row.beforeState,
		afterState: row.afterState,
		targetUpdatedAtBefore: row.targetUpdatedAtBefore.toISOString(),
		targetUpdatedAtAfter: row.targetUpdatedAtAfter.toISOString(),
		resolvedAt: row.resolvedAt.toISOString(),
	};
}
