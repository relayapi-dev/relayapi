/**
 * Canonical durable-domain registry.
 *
 * A text column whose name ends in type/kind/role/direction is never allowed to
 * acquire semantics accidentally. `domain-contract-audit.ts` derives the
 * candidate set from the Drizzle schema and requires exactly one entry here.
 *
 * Closed value arrays are the application-owned vocabulary. The database
 * constraint named by each contract must contain exactly the same values.
 */

import { FINANCIAL_RETENTION_SOURCE_KINDS } from "./financial-retention-contracts";
import { OPERATOR_RESOLUTION_TARGET_TYPES } from "./operator-resolution-contracts";

export const AD_AUDIENCE_TYPES = [
	"customer_list",
	"website",
	"lookalike",
] as const;
export const AD_ADVANCED_RESOURCE_KINDS = [
	"messaging_experience",
	"creative_asset",
	"catalog",
	"product_set",
] as const;
export const AD_CREATION_OPERATION_KINDS = [
	"create_campaign",
	"create_ad",
	"boost_post",
] as const;
export const AD_MUTATION_TARGET_TYPES = ["ad", "campaign"] as const;
export const AD_MUTATION_KINDS = [
	"update_ad",
	"cancel_ad",
	"update_campaign",
	"cancel_campaign",
] as const;
export const AD_PROMOTABLE_IDENTITY_TYPES = [
	"social_account",
	"facebook_page",
	"instagram_account",
	"linkedin_organization",
	"pinterest_profile",
	"tiktok_identity",
	"x_user",
] as const;
export const AD_PROMOTABLE_IDENTITY_STATUSES = [
	"active",
	"revoked",
	"unavailable",
] as const;
export const DURABLE_AUTHORITY_PRINCIPAL_TYPES = [
	"service",
	"dashboard_user",
] as const;
export const AD_SYNC_TYPES = ["external_listing"] as const;
export const AI_KNOWLEDGE_SOURCE_TYPES = ["url", "media", "text"] as const;
export const AUTOMATION_BINDING_TYPES = [
	"default_reply",
	"welcome_message",
	"get_started",
	"main_menu",
	"ice_breaker",
] as const;
export const AUTOMATION_EFFECT_KINDS = [
	"message_block",
	"http_request",
	"automation_action",
] as const;
export const AUTOMATION_ENTRYPOINT_KINDS = [
	"dm_received",
	"comment_created",
	"story_reply",
	"story_mention",
	"live_comment",
	"ad_click",
	"ref_link_click",
	"share_to_dm",
	"schedule",
	"field_changed",
	"tag_applied",
	"tag_removed",
	"conversion_event",
	"webhook_inbound",
] as const;
export const AUTOMATION_SCHEDULED_JOB_TYPES = [
	"resume_run",
	"input_timeout",
	"event_timeout",
	"internal_event",
	"scheduled_trigger",
	"webhook_reception_failure",
] as const;
export const AUTOMATION_SECRET_KINDS = ["webhook_out", "http_request"] as const;
export const AUTOMATION_NODE_KINDS = [
	"message",
	"input",
	"delay",
	"wait_event",
	"condition",
	"randomizer",
	"action_group",
	"http_request",
	"start_automation",
	"social_profile_check",
	"goto",
	"end",
	// Durable evidence used when a run's current node disappeared after a graph
	// edit. It is not an authorable graph-node kind.
	"unknown",
] as const;
export const BILLING_OUTBOX_KINDS = [
	"auth_cache.refresh",
	"payment_failed.notify",
	"subscription.cancel",
] as const;
export const BILLING_OPERATION_KINDS = ["cycle", "catchup"] as const;
export const BILLING_STRIPE_PRICE_ROLES = ["base"] as const;
export const CONTACT_SUBSCRIPTION_EVENT_TYPES = [
	"subscribed",
	"unsubscribed",
] as const;
export const CROSS_POST_ACTION_TYPES = ["repost", "comment", "quote"] as const;
export const CUSTOM_FIELD_TYPES = [
	"text",
	"number",
	"date",
	"boolean",
	"select",
] as const;
export const ERASURE_HOLD_SUBJECT_KINDS = [
	"organization",
	"workspace",
] as const;
export const EXTERNAL_SUBJECT_CLEANUP_SUBJECT_KINDS = [
	"user",
	"contact",
	"account",
	"organization",
	"workspace",
] as const;
export const IDEA_MEDIA_TYPES = ["image", "video", "gif", "document"] as const;
export const INBOX_NOTE_ACTOR_TYPES = ["dashboard_user", "service"] as const;
export const INBOX_CONVERSATION_TYPES = [
	"comment_thread",
	"dm",
	"review",
] as const;
export const INBOX_DIRECTIONS = ["inbound", "outbound"] as const;
export const INVITE_TOKEN_ROLES = ["owner", "admin", "member"] as const;
export const NOTIFICATION_TYPES = [
	"post_failed",
	"post_published",
	"account_disconnected",
	"payment_failed",
	"usage_warning",
	"weekly_digest",
	"marketing",
	"streak_warning",
	"automation_notice",
] as const;
export const ONE_TIME_CAPABILITY_KINDS = [
	"oauth_state",
	"websocket_ticket",
] as const;
export const ORGANIZATION_PRINCIPAL_KINDS = ["member", "service"] as const;
export const PUBLIC_GROWTH_EVENT_TYPES = [
	"ref_visit",
	"qr_scan",
	"landing_view",
	"landing_conversion",
] as const;
export const PUBLISH_OUTBOX_KINDS = [
	"publish",
	"publish_thread",
	"notification",
	"post_completion",
] as const;
export const QUEUE_FAILURE_KINDS = [
	"permanent_input",
	"unknown_external_outcome",
	"dead_letter",
] as const;
export const REF_URL_DESTINATION_TYPES = ["https_url", "landing_page"] as const;
export const SOCIAL_PLATFORM_IDS = [
	"twitter",
	"instagram",
	"facebook",
	"linkedin",
	"tiktok",
	"youtube",
	"pinterest",
	"reddit",
	"bluesky",
	"threads",
	"telegram",
	"snapchat",
	"googlebusiness",
	"whatsapp",
	"mastodon",
	"discord",
	"sms",
	"beehiiv",
	"convertkit",
	"mailchimp",
	"listmonk",
	"slack",
] as const;
export const MEDIA_DERIVATIVE_KINDS = [
	"normalized",
	"provider",
	"cover",
	"gif_video",
] as const;
export const SOCIAL_MUTATION_TARGET_TYPES = [
	"post_target",
	"provider_post",
	"inbox_message",
	"comment",
	"whatsapp_group",
	"whatsapp_account",
	"whatsapp_template",
] as const;
export const SOCIAL_MUTATION_KINDS = [
	"post_edit",
	"message_edit",
	"read_receipt",
	"comment_edit",
	"moderation",
	"reaction",
	"group_create",
	"group_update",
	"group_delete",
	"group_join_approve",
	"group_join_reject",
	"group_participant_remove",
	"group_message",
	"group_pin",
	"block_users",
	"unblock_users",
	"username_set",
	"username_delete",
	"template_edit",
	"template_library_create",
] as const;
export const TOOL_JOB_KINDS = ["download", "transcript"] as const;
export const WEBHOOK_ATTEMPT_KINDS = ["delivery", "test"] as const;
export const WEBHOOK_ATTEMPT_OUTCOMES = [
	"succeeded",
	"retry_scheduled",
	"failed",
	"unknown",
] as const;

type DomainLocation = {
	schemaName: string;
	tableName: string;
	columnName: string;
};

export type ClosedDomainContract = DomainLocation & {
	classification: "closed";
	values: readonly [string, ...string[]];
	database:
		| { kind: "check"; constraintName: string }
		| { kind: "pg_enum"; enumName: string };
};

export type ProviderPassthroughDomainContract = DomainLocation & {
	classification: "provider_passthrough";
	provider: string;
	rationale: string;
};

export type ExternallyOwnedDomainContract = DomainLocation & {
	classification: "externally_owned";
	owner: string;
	rationale: string;
};

export type DomainContract =
	| ClosedDomainContract
	| ProviderPassthroughDomainContract
	| ExternallyOwnedDomainContract;

export const DOMAIN_CONTRACTS = [
	{
		schemaName: "public",
		tableName: "ad_advanced_resources",
		columnName: "kind",
		classification: "closed",
		values: AD_ADVANCED_RESOURCE_KINDS,
		database: {
			kind: "check",
			constraintName: "ad_advanced_resources_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "ad_account_promotable_identities",
		columnName: "identity_type",
		classification: "closed",
		values: AD_PROMOTABLE_IDENTITY_TYPES,
		database: {
			kind: "check",
			constraintName: "ad_account_identities_identity_type_check",
		},
	},
	{
		schemaName: "public",
		tableName: "ad_audiences",
		columnName: "type",
		classification: "closed",
		values: AD_AUDIENCE_TYPES,
		database: { kind: "pg_enum", enumName: "audience_type" },
	},
	{
		schemaName: "public",
		tableName: "ad_creation_operations",
		columnName: "authority_principal_type",
		classification: "closed",
		values: DURABLE_AUTHORITY_PRINCIPAL_TYPES,
		database: {
			kind: "check",
			constraintName: "ad_creation_operations_authority_check",
		},
	},
	{
		schemaName: "public",
		tableName: "ad_creation_operations",
		columnName: "kind",
		classification: "closed",
		values: AD_CREATION_OPERATION_KINDS,
		database: {
			kind: "check",
			constraintName: "ad_creation_operations_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "ad_mutation_operations",
		columnName: "authority_principal_type",
		classification: "closed",
		values: DURABLE_AUTHORITY_PRINCIPAL_TYPES,
		database: {
			kind: "check",
			constraintName: "ad_mutation_operations_authority_check",
		},
	},
	{
		schemaName: "public",
		tableName: "ad_mutation_operations",
		columnName: "target_type",
		classification: "closed",
		values: AD_MUTATION_TARGET_TYPES,
		database: {
			kind: "check",
			constraintName: "ad_mutation_operations_target_check",
		},
	},
	{
		schemaName: "public",
		tableName: "whatsapp_phone_release_operations",
		columnName: "authority_principal_type",
		classification: "closed",
		values: DURABLE_AUTHORITY_PRINCIPAL_TYPES,
		database: {
			kind: "check",
			constraintName: "wa_phone_release_authority_check",
		},
	},
	{
		schemaName: "public",
		tableName: "ad_mutation_operations",
		columnName: "kind",
		classification: "closed",
		values: AD_MUTATION_KINDS,
		database: {
			kind: "check",
			constraintName: "ad_mutation_operations_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "ad_sync_logs",
		columnName: "sync_type",
		classification: "closed",
		values: AD_SYNC_TYPES,
		database: { kind: "check", constraintName: "ad_sync_logs_type_check" },
	},
	{
		schemaName: "public",
		tableName: "ai_knowledge_documents",
		columnName: "source_type",
		classification: "closed",
		values: AI_KNOWLEDGE_SOURCE_TYPES,
		database: {
			kind: "check",
			constraintName: "ai_knowledge_documents_source_type_check",
		},
	},
	{
		schemaName: "public",
		tableName: "automation_bindings",
		columnName: "binding_type",
		classification: "closed",
		values: AUTOMATION_BINDING_TYPES,
		database: { kind: "pg_enum", enumName: "automation_binding_type" },
	},
	{
		schemaName: "public",
		tableName: "automation_effects",
		columnName: "kind",
		classification: "closed",
		values: AUTOMATION_EFFECT_KINDS,
		database: {
			kind: "check",
			constraintName: "automation_effects_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "automation_entrypoints",
		columnName: "kind",
		classification: "closed",
		values: AUTOMATION_ENTRYPOINT_KINDS,
		database: {
			kind: "check",
			constraintName: "automation_entrypoints_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "automation_scheduled_jobs",
		columnName: "job_type",
		classification: "closed",
		values: AUTOMATION_SCHEDULED_JOB_TYPES,
		database: {
			kind: "check",
			constraintName: "automation_scheduled_jobs_type_check",
		},
	},
	{
		schemaName: "public",
		tableName: "automation_secrets",
		columnName: "kind",
		classification: "closed",
		values: AUTOMATION_SECRET_KINDS,
		database: {
			kind: "check",
			constraintName: "automation_secrets_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "automation_step_runs",
		columnName: "node_kind",
		classification: "closed",
		values: AUTOMATION_NODE_KINDS,
		database: {
			kind: "check",
			constraintName: "automation_step_runs_node_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "billing_outbox",
		columnName: "kind",
		classification: "closed",
		values: BILLING_OUTBOX_KINDS,
		database: {
			kind: "check",
			constraintName: "billing_outbox_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "billing_operations",
		columnName: "kind",
		classification: "closed",
		values: BILLING_OPERATION_KINDS,
		database: {
			kind: "check",
			constraintName: "billing_operations_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "billing_periods",
		columnName: "stripe_price_role",
		classification: "closed",
		values: BILLING_STRIPE_PRICE_ROLES,
		database: {
			kind: "check",
			constraintName: "billing_periods_stripe_price_role_check",
		},
	},
	{
		schemaName: "public",
		tableName: "contact_subscription_events",
		columnName: "type",
		classification: "closed",
		values: CONTACT_SUBSCRIPTION_EVENT_TYPES,
		database: {
			kind: "pg_enum",
			enumName: "contact_subscription_event_type",
		},
	},
	{
		schemaName: "public",
		tableName: "cross_post_actions",
		columnName: "action_type",
		classification: "closed",
		values: CROSS_POST_ACTION_TYPES,
		database: {
			kind: "check",
			constraintName: "cross_post_actions_type_check",
		},
	},
	{
		schemaName: "public",
		tableName: "custom_field_definitions",
		columnName: "type",
		classification: "closed",
		values: CUSTOM_FIELD_TYPES,
		database: {
			kind: "check",
			constraintName: "custom_field_definitions_type_check",
		},
	},
	{
		schemaName: "public",
		tableName: "erasure_holds",
		columnName: "subject_kind",
		classification: "closed",
		values: ERASURE_HOLD_SUBJECT_KINDS,
		database: { kind: "pg_enum", enumName: "erasure_hold_subject_kind" },
	},
	{
		schemaName: "public",
		tableName: "external_posts",
		columnName: "media_type",
		classification: "provider_passthrough",
		provider: "connected social platform",
		rationale:
			"Provider media vocabularies differ and evolve; RelayAPI preserves the raw diagnostic value while presentation code normalizes behavior.",
	},
	{
		schemaName: "public",
		tableName: "external_subject_cleanup_jobs",
		columnName: "subject_kind",
		classification: "closed",
		values: EXTERNAL_SUBJECT_CLEANUP_SUBJECT_KINDS,
		database: {
			kind: "check",
			constraintName: "external_subject_cleanup_jobs_subject_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "financial_retention_receipts",
		columnName: "source_kind",
		classification: "closed",
		values: FINANCIAL_RETENTION_SOURCE_KINDS,
		database: {
			kind: "check",
			constraintName: "financial_retention_receipts_source_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "idea_media",
		columnName: "type",
		classification: "closed",
		values: IDEA_MEDIA_TYPES,
		database: { kind: "pg_enum", enumName: "idea_media_type" },
	},
	{
		schemaName: "public",
		tableName: "idempotency_receipts",
		columnName: "response_content_type",
		classification: "provider_passthrough",
		provider: "RelayAPI HTTP response",
		rationale:
			"HTTP media types are an extensible standards vocabulary and the receipt must replay the exact response value rather than a local subset.",
	},
	{
		schemaName: "public",
		tableName: "inbound_webhook_events",
		columnName: "content_type",
		classification: "provider_passthrough",
		provider: "webhook sender",
		rationale:
			"Webhook senders own their HTTP media type and parameters; parsing policy is separate from preservation of the received header.",
	},
	{
		schemaName: "public",
		tableName: "tool_jobs",
		columnName: "kind",
		classification: "closed",
		values: TOOL_JOB_KINDS,
		database: {
			kind: "check",
			constraintName: "tool_jobs_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "inbox_conversation_notes",
		columnName: "actor_type",
		classification: "closed",
		values: INBOX_NOTE_ACTOR_TYPES,
		database: {
			kind: "check",
			constraintName: "inbox_note_actor_type_check",
		},
	},
	{
		schemaName: "public",
		tableName: "inbox_conversations",
		columnName: "type",
		classification: "closed",
		values: INBOX_CONVERSATION_TYPES,
		database: { kind: "pg_enum", enumName: "conversation_type" },
	},
	{
		schemaName: "public",
		tableName: "inbox_conversations",
		columnName: "last_message_direction",
		classification: "closed",
		values: INBOX_DIRECTIONS,
		database: {
			kind: "check",
			constraintName: "inbox_conversations_last_message_direction_check",
		},
	},
	{
		schemaName: "public",
		tableName: "inbox_messages",
		columnName: "direction",
		classification: "closed",
		values: INBOX_DIRECTIONS,
		database: {
			kind: "check",
			constraintName: "inbox_messages_direction_check",
		},
	},
	{
		schemaName: "auth",
		tableName: "invitation",
		columnName: "role",
		classification: "externally_owned",
		owner: "Better Auth organization plugin",
		rationale:
			"Better Auth owns this compatibility table and its role vocabulary; RelayAPI constrains its separate bearer-invite authority.",
	},
	{
		schemaName: "public",
		tableName: "invite_tokens",
		columnName: "role",
		classification: "closed",
		values: INVITE_TOKEN_ROLES,
		database: {
			kind: "check",
			constraintName: "invite_tokens_role_check",
		},
	},
	{
		schemaName: "public",
		tableName: "media",
		columnName: "mime_type",
		classification: "provider_passthrough",
		provider: "uploading client and object metadata",
		rationale:
			"MIME types are an extensible standards vocabulary; capability-specific allowlists are enforced at the operation boundary.",
	},
	{
		schemaName: "public",
		tableName: "media_derivatives",
		columnName: "kind",
		classification: "closed",
		values: MEDIA_DERIVATIVE_KINDS,
		database: {
			kind: "check",
			constraintName: "media_derivatives_state_check",
		},
	},
	{
		schemaName: "public",
		tableName: "media_derivatives",
		columnName: "mime_type",
		classification: "provider_passthrough",
		provider: "RelayAPI media processor and source object metadata",
		rationale:
			"MIME types are an extensible standards vocabulary; processor profiles and publish boundaries enforce their operation-specific allowlists.",
	},
	{
		schemaName: "public",
		tableName: "media_upload_sessions",
		columnName: "expected_mime_type",
		classification: "provider_passthrough",
		provider: "uploading client and verified source object metadata",
		rationale:
			"MIME types are an extensible standards vocabulary; resumable upload admission and completion revalidation enforce the supported allowlist.",
	},
	{
		schemaName: "auth",
		tableName: "member",
		columnName: "role",
		classification: "externally_owned",
		owner: "Better Auth organization plugin",
		rationale:
			"Better Auth owns membership persistence and may extend its role representation; RelayAPI maps effective authority at its API boundary.",
	},
	{
		schemaName: "public",
		tableName: "notifications",
		columnName: "type",
		classification: "closed",
		values: NOTIFICATION_TYPES,
		database: {
			kind: "check",
			constraintName: "notifications_type_check",
		},
	},
	{
		schemaName: "public",
		tableName: "one_time_capabilities",
		columnName: "kind",
		classification: "closed",
		values: ONE_TIME_CAPABILITY_KINDS,
		database: {
			kind: "check",
			constraintName: "one_time_capabilities_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "operator_resolution_evidence",
		columnName: "target_type",
		classification: "closed",
		values: OPERATOR_RESOLUTION_TARGET_TYPES,
		database: {
			kind: "check",
			constraintName: "operator_resolution_evidence_target_type_check",
		},
	},
	{
		schemaName: "public",
		tableName: "organization_principals",
		columnName: "kind",
		classification: "closed",
		values: ORGANIZATION_PRINCIPAL_KINDS,
		database: {
			kind: "check",
			constraintName: "organization_principals_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "public_growth_events",
		columnName: "event_type",
		classification: "closed",
		values: PUBLIC_GROWTH_EVENT_TYPES,
		database: {
			kind: "check",
			constraintName: "public_growth_events_type_check",
		},
	},
	{
		schemaName: "public",
		tableName: "publish_outbox",
		columnName: "kind",
		classification: "closed",
		values: PUBLISH_OUTBOX_KINDS,
		database: {
			kind: "check",
			constraintName: "publish_outbox_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "queue_failures",
		columnName: "failure_kind",
		classification: "closed",
		values: QUEUE_FAILURE_KINDS,
		database: {
			kind: "check",
			constraintName: "queue_failures_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "ref_urls",
		columnName: "destination_type",
		classification: "closed",
		values: REF_URL_DESTINATION_TYPES,
		database: {
			kind: "check",
			constraintName: "ref_urls_destination_type_check",
		},
	},
	{
		schemaName: "public",
		tableName: "social_mutation_operations",
		columnName: "target_type",
		classification: "closed",
		values: SOCIAL_MUTATION_TARGET_TYPES,
		database: {
			kind: "check",
			constraintName: "social_mutation_operations_target_check",
		},
	},
	{
		schemaName: "public",
		tableName: "social_mutation_operations",
		columnName: "kind",
		classification: "closed",
		values: SOCIAL_MUTATION_KINDS,
		database: {
			kind: "check",
			constraintName: "social_mutation_operations_kind_check",
		},
	},
	{
		schemaName: "public",
		tableName: "stripe_events",
		columnName: "type",
		classification: "provider_passthrough",
		provider: "Stripe",
		rationale:
			"Stripe owns and versions event type strings; the durable inbox must retain unrecognized event types for replay and operator evidence.",
	},
	{
		schemaName: "public",
		tableName: "webhook_logs",
		columnName: "attempt_kind",
		classification: "closed",
		values: WEBHOOK_ATTEMPT_KINDS,
		database: {
			kind: "check",
			constraintName: "webhook_logs_attempt_kind_check",
		},
	},
	{
		schemaName: "auth",
		tableName: "user",
		columnName: "role",
		classification: "externally_owned",
		owner: "Better Auth admin plugin",
		rationale:
			"Better Auth owns the nullable global user-role field; organization authority is modeled separately in membership and stable principals.",
	},
] as const satisfies readonly DomainContract[];

export type BillingOutboxKind = (typeof BILLING_OUTBOX_KINDS)[number];
export type AutomationEntrypointKind =
	(typeof AUTOMATION_ENTRYPOINT_KINDS)[number];
export type AutomationNodeKind = (typeof AUTOMATION_NODE_KINDS)[number];
export type AutomationSecretKind = (typeof AUTOMATION_SECRET_KINDS)[number];
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export type InboxDirection = (typeof INBOX_DIRECTIONS)[number];
export type InviteTokenRole = (typeof INVITE_TOKEN_ROLES)[number];
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type OneTimeCapabilityKind = (typeof ONE_TIME_CAPABILITY_KINDS)[number];
export type WebhookAttemptKind = (typeof WEBHOOK_ATTEMPT_KINDS)[number];
export type WebhookAttemptOutcome = (typeof WEBHOOK_ATTEMPT_OUTCOMES)[number];

export function isAutomationEntrypointKind(
	value: string,
): value is AutomationEntrypointKind {
	return (AUTOMATION_ENTRYPOINT_KINDS as readonly string[]).includes(value);
}

export function isAutomationNodeKind(
	value: string,
): value is AutomationNodeKind {
	return (AUTOMATION_NODE_KINDS as readonly string[]).includes(value);
}
