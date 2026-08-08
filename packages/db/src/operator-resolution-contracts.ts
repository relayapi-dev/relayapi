/**
 * Source-owned operator-resolution vocabulary.
 *
 * Actions are intentionally narrower than the target lifecycles. In
 * particular, an unknown external mutation is never made retryable merely
 * because an operator opened the resolution surface: the operator must first
 * assert either that it succeeded or that it was not applied.
 */

export const OPERATOR_RESOLUTION_TARGET_TYPES = [
	"automation_effect",
	"automation_binding",
	"automation_conversion_event",
	"stripe_event",
	"billing_operation",
	"tenant_erasure_job",
	"workspace_erasure_job",
	"account_revocation_job",
	"external_subject_cleanup_job",
	"short_link_creation",
	"customer_webhook_delivery",
	"tool_job",
	"whatsapp_phone_provisioning_operation",
	"whatsapp_phone_release_operation",
	"whatsapp_phone_billing_operation",
	"ad_creation_operation",
	"ad_mutation_operation",
] as const;

export type OperatorResolutionTargetType =
	(typeof OPERATOR_RESOLUTION_TARGET_TYPES)[number];

export const OPERATOR_RESOLUTION_ACTIONS = [
	"mark_succeeded",
	"mark_not_applied",
	"retry",
	"abandon",
] as const;

export type OperatorResolutionAction =
	(typeof OPERATOR_RESOLUTION_ACTIONS)[number];

export const OPERATOR_RESOLUTION_REASON_CODE_BY_ACTION = {
	mark_succeeded: "operator_asserted_succeeded",
	mark_not_applied: "operator_asserted_not_applied",
	retry: "operator_requested_retry",
	abandon: "operator_abandoned",
} as const satisfies Record<OperatorResolutionAction, string>;

export const OPERATOR_RESOLUTION_REASON_CODES = [
	OPERATOR_RESOLUTION_REASON_CODE_BY_ACTION.mark_succeeded,
	OPERATOR_RESOLUTION_REASON_CODE_BY_ACTION.mark_not_applied,
	OPERATOR_RESOLUTION_REASON_CODE_BY_ACTION.retry,
	OPERATOR_RESOLUTION_REASON_CODE_BY_ACTION.abandon,
] as const;

export type OperatorResolutionReasonCode =
	(typeof OPERATOR_RESOLUTION_REASON_CODES)[number];

export const OPERATOR_RESOLUTION_NOTE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export const OPERATOR_RESOLUTION_ACTIONS_BY_TARGET = {
	automation_effect: ["mark_succeeded", "mark_not_applied"],
	automation_binding: ["mark_succeeded", "mark_not_applied", "retry"],
	automation_conversion_event: ["retry"],
	stripe_event: ["retry", "abandon"],
	billing_operation: ["mark_succeeded", "mark_not_applied", "retry", "abandon"],
	tenant_erasure_job: ["retry"],
	workspace_erasure_job: ["retry"],
	account_revocation_job: ["mark_succeeded", "mark_not_applied", "abandon"],
	external_subject_cleanup_job: ["mark_succeeded", "retry"],
	short_link_creation: ["mark_succeeded", "mark_not_applied"],
	customer_webhook_delivery: [
		"mark_succeeded",
		"mark_not_applied",
		"retry",
		"abandon",
	],
	tool_job: ["mark_not_applied", "abandon"],
	whatsapp_phone_provisioning_operation: [
		"mark_succeeded",
		"mark_not_applied",
		"retry",
	],
	whatsapp_phone_release_operation: [
		"mark_succeeded",
		"mark_not_applied",
		"retry",
	],
	whatsapp_phone_billing_operation: ["mark_succeeded", "mark_not_applied"],
	ad_creation_operation: ["mark_succeeded", "mark_not_applied", "retry"],
	ad_mutation_operation: ["mark_succeeded", "mark_not_applied", "retry"],
} as const satisfies Record<
	OperatorResolutionTargetType,
	readonly OperatorResolutionAction[]
>;

export type OperatorResolutionStateValue = string | number | boolean | null;

export type OperatorResolutionState = Record<
	string,
	OperatorResolutionStateValue
>;
