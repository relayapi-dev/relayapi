export const ASYNC_CONTRACT_TYPES = [
	"external_mutation",
	"transactional_outbox",
	"poll_read_synchronization",
	"durable_inbox_receipt",
	"pure_orchestration",
] as const;

export type AsyncContractType = (typeof ASYNC_CONTRACT_TYPES)[number];

export interface AsyncLifecycleRegistration {
	table: string;
	contract: AsyncContractType;
	owner: string;
	source: string;
}

export const AUTOMATION_SCHEDULED_JOB_CONTRACTS = {
	resume_run: "pure_orchestration",
	input_timeout: "pure_orchestration",
	event_timeout: "pure_orchestration",
	internal_event: "pure_orchestration",
	scheduled_trigger: "pure_orchestration",
	webhook_reception_failure: "external_mutation",
} as const satisfies Record<
	(typeof AUTOMATION_SCHEDULED_JOB_TYPES)[number],
	AsyncContractType
>;

export function automationScheduledJobMayCrossExternalBoundary(
	jobType: string,
): boolean {
	return (
		AUTOMATION_SCHEDULED_JOB_CONTRACTS[
			jobType as keyof typeof AUTOMATION_SCHEDULED_JOB_CONTRACTS
		] === "external_mutation"
	);
}

function registrations(
	contract: AsyncContractType,
	source: string,
	owner: string,
	tables: readonly string[],
): AsyncLifecycleRegistration[] {
	return tables.map((table) => ({ table, contract, source, owner }));
}

/**
 * Source-owned classification of every durable table whose columns look like
 * async state. A lifecycle can have component rows, but it must not be folded
 * into a generic global "attempt" table: ownership and terminal semantics stay
 * with the feature aggregate named here.
 */
export const ASYNC_LIFECYCLE_REGISTRY: readonly AsyncLifecycleRegistration[] = [
	...registrations(
		"poll_read_synchronization",
		"src/services/ad-sync.ts",
		"ads",
		["ad_accounts", "ads"],
	),
	...registrations(
		"poll_read_synchronization",
		"src/services/analytics-refresh.ts",
		"analytics",
		["external_posts"],
	),
	...registrations(
		"poll_read_synchronization",
		"src/services/external-post-sync/cron.ts",
		"external-posts",
		["social_account_sync_state"],
	),
	...registrations(
		"poll_read_synchronization",
		"src/services/short-link-click-sync.ts",
		"short-links",
		["short_links"],
	),
	...registrations(
		"poll_read_synchronization",
		"src/services/ai-knowledge.ts",
		"ai-knowledge",
		["ai_knowledge_documents"],
	),
	...registrations(
		"poll_read_synchronization",
		"src/services/rss-generator.ts",
		"rss",
		["auto_post_rules"],
	),
	...registrations(
		"external_mutation",
		"src/services/account-revocation.ts",
		"accounts",
		["account_revocation_jobs"],
	),
	...registrations(
		"external_mutation",
		"src/services/ad-creation-operations.ts",
		"ads",
		["ad_creation_operations"],
	),
	...registrations(
		"external_mutation",
		"src/services/ad-mutation-operations.ts",
		"ads",
		["ad_mutation_operations"],
	),
	...registrations(
		"external_mutation",
		"src/services/ad-report-jobs.ts",
		"ads",
		["ad_report_jobs"],
	),
	...registrations("external_mutation", "src/routes/ads-advanced.ts", "ads", [
		"ad_conversion_events",
	]),
	...registrations(
		"external_mutation",
		"src/services/automations/binding-sync.ts",
		"automations",
		["automation_bindings"],
	),
	...registrations(
		"external_mutation",
		"src/services/automations/runner.ts",
		"automations",
		["automation_effects"],
	),
	...registrations(
		"external_mutation",
		"src/services/billing-operations.ts",
		"billing",
		["billing_operations", "billing_operation_attempts"],
	),
	...registrations(
		"external_mutation",
		"src/services/broadcast-processor.ts",
		"broadcasts",
		["broadcast_recipients"],
	),
	...registrations(
		"external_mutation",
		"src/services/cross-post-processor.ts",
		"publishing",
		["cross_post_actions"],
	),
	...registrations("external_mutation", "src/services/dunning.ts", "billing", [
		"dunning_events",
	]),
	...registrations("external_mutation", "src/queues/email.ts", "email", [
		"email_deliveries",
	]),
	...registrations(
		"external_mutation",
		"src/services/inbox-effect-reconciler.ts",
		"inbox",
		["inbox_event_effects"],
	),
	...registrations(
		"external_mutation",
		"src/services/media-reliability.ts",
		"media",
		["media"],
	),
	...registrations(
		"external_mutation",
		"src/routes/media-uploads.ts",
		"media",
		["media_upload_sessions"],
	),
	...registrations(
		"pure_orchestration",
		"src/workflows/media-processing.ts",
		"media",
		["media_processing_jobs"],
	),
	...registrations(
		"external_mutation",
		"src/services/byos-configuration.ts",
		"storage",
		["storage_credentials"],
	),
	...registrations(
		"external_mutation",
		"src/services/publisher-runner.ts",
		"publishing",
		["post_targets", "publish_attempts"],
	),
	...registrations(
		"external_mutation",
		"src/services/social-mutation-operations.ts",
		"social-actions",
		["social_mutation_operations"],
	),
	...registrations(
		"external_mutation",
		"src/services/stripe-subscriptions.ts",
		"billing",
		["subscription_checkout_operations"],
	),
	...registrations(
		"pure_orchestration",
		"src/services/stripe-organization-lease.ts",
		"billing",
		["stripe_organization_leases"],
	),
	...registrations(
		"external_mutation",
		"src/services/thread-execution-reconciler.ts",
		"publishing",
		["thread_executions"],
	),
	...registrations(
		"external_mutation",
		"src/services/token-refresh.ts",
		"accounts",
		["token_refresh_operations"],
	),
	...registrations(
		"external_mutation",
		"src/services/webhook-delivery.ts",
		"customer-webhooks",
		["webhook_deliveries", "webhook_logs"],
	),
	...registrations(
		"external_mutation",
		"src/services/external-subject-cleanup.ts",
		"privacy",
		["external_subject_cleanup_jobs"],
	),
	...registrations("external_mutation", "src/services/tool-jobs.ts", "tools", [
		"tool_jobs",
	]),
	...registrations(
		"external_mutation",
		"src/services/usage-meter.ts",
		"usage-quota",
		["usage_reservations"],
	),
	...registrations(
		"external_mutation",
		"src/services/phone-number-operations.ts",
		"phone-numbers",
		[
			"whatsapp_phone_billing_attempts",
			"whatsapp_phone_billing_operations",
			"whatsapp_phone_provisioning_operations",
			"whatsapp_phone_release_operations",
		],
	),
	...registrations(
		"transactional_outbox",
		"src/services/automation-conversion-dispatch.ts",
		"automations",
		["automation_conversion_events"],
	),
	...registrations(
		"transactional_outbox",
		"src/services/billing-outbox.ts",
		"billing",
		["billing_outbox"],
	),
	...registrations(
		"transactional_outbox",
		"src/services/publish-outbox.ts",
		"publishing",
		["publish_outbox"],
	),
	...registrations(
		"transactional_outbox",
		"src/services/invoice-generator.ts",
		"billing",
		["billing_periods"],
	),
	...registrations(
		"durable_inbox_receipt",
		"src/services/automations/webhook-receiver.ts",
		"automations",
		["automation_webhook_receipts"],
	),
	...registrations(
		"durable_inbox_receipt",
		"src/services/inbound-webhook-reconciler.ts",
		"inbound-webhooks",
		["inbound_webhook_events"],
	),
	...registrations(
		"durable_inbox_receipt",
		"src/services/one-time-capability-cleanup.ts",
		"capabilities",
		["one_time_capabilities"],
	),
	...registrations(
		"durable_inbox_receipt",
		"src/services/queue-replay.ts",
		"queues",
		["queue_failures"],
	),
	...registrations(
		"durable_inbox_receipt",
		"src/routes/stripe-webhooks.ts",
		"billing",
		["stripe_events"],
	),
	...registrations(
		"pure_orchestration",
		"src/services/automations/runner.ts",
		"automations",
		["automation_node_executions"],
	),
	...registrations(
		// One physical lifecycle is still optimal because every variant shares
		// occurrence identity, due-time, claim, lease, and terminal retention.
		// The variant registry above confines the nullable ambiguous-effect
		// boundary to the sole external adapter.
		"external_mutation",
		"src/services/automations/scheduler.ts",
		"automations",
		["automation_scheduled_jobs"],
	),
	...registrations(
		"pure_orchestration",
		"src/services/broadcast-processor.ts",
		"broadcasts",
		["broadcasts"],
	),
	...registrations("pure_orchestration", "src/routes/ideas.ts", "ideas", [
		"idea_conversion_operations",
	]),
	...registrations(
		"pure_orchestration",
		"src/services/recycling-processor.ts",
		"recycling",
		["post_recycling_configs"],
	),
	...registrations(
		"pure_orchestration",
		"src/services/scheduler.ts",
		"publishing",
		["posts"],
	),
	...registrations(
		"pure_orchestration",
		"src/services/public-growth-events.ts",
		"public-growth",
		["public_growth_events"],
	),
	...registrations(
		"pure_orchestration",
		"src/services/executable-retention.ts",
		"privacy",
		["retention_drain_runs"],
	),
	...registrations(
		"pure_orchestration",
		"src/services/tenant-deletion.ts",
		"privacy",
		["tenant_deletion_jobs", "tenant_deletion_steps"],
	),
	...registrations(
		"pure_orchestration",
		"src/services/workspace-erasure.ts",
		"privacy",
		["workspace_erasure_jobs", "workspace_erasure_steps"],
	),
] as const;

/**
 * These names match the mechanical column heuristic but are credentials or
 * hold transitions, not background async lifecycles.
 */
export const ASYNC_SIGNATURE_EXCEPTIONS = {
	account:
		"Better Auth credential refresh fields; no background claim lifecycle",
	ad_connections:
		"operator-driven ad credential rotation; automatic provider token exchange is intentionally disabled",
	social_accounts:
		"encrypted provider credential fields; token_refresh_operations owns refresh",
	erasure_holds: "release transition fields, not a retry/claim lifecycle",
} as const;

import type { AUTOMATION_SCHEDULED_JOB_TYPES } from "@relayapi/db";
