import type {
	ExecutablePostgresRetentionContract,
	PostgresRetentionStoreId,
	RetentionDuration,
	RetentionHoldScope,
	RetentionHorizon,
} from "./executable-retention-contracts";
import { postgresRetentionHoldTreatment } from "./postgres-retention-hold-policy";

const SCHEDULE_SOURCE = "apps/api/src/scheduled/index.ts" as const;
const RUNTIME_TEST =
	"apps/api/src/__tests__/specialized-retention-contracts.test.ts" as const;
const RUNTIME_TEST_MARKER = "SPECIALIZED_RETENTION_RUNTIME_PROOF";

function days(value: number): RetentionDuration {
	return { value, unit: "days" };
}

function months(value: number): RetentionDuration {
	return { value, unit: "months" };
}

function atExpiry(): RetentionDuration {
	return { value: 0, unit: "at_expiry" };
}

interface SpecializedContractInput {
	readonly storeId: PostgresRetentionStoreId;
	readonly handlerId: string;
	readonly source: `apps/api/${string}.ts`;
	readonly exportName: string;
	readonly testSource?: `apps/api/${string}.test.ts`;
	readonly testMarker?: string;
	readonly cutoff: ExecutablePostgresRetentionContract["cutoff"];
	readonly minimize?: RetentionHorizon;
	readonly delete?: RetentionHorizon;
	readonly holdScope: RetentionHoldScope;
	readonly rows: number;
	readonly maxPasses: number;
	readonly orderBy: readonly [string, string, ...string[]];
	readonly indexName: string;
	readonly indexStoreId?: PostgresRetentionStoreId;
	readonly additionalIndexes?: ExecutablePostgresRetentionContract["batch"]["additionalIndexes"];
	readonly cron: string;
	readonly taskName: string;
	readonly owner: string;
}

function specializedContract(
	input: SpecializedContractInput,
): ExecutablePostgresRetentionContract {
	return {
		storeId: input.storeId,
		handler: {
			id: input.handlerId,
			source: input.source,
			exportName: input.exportName,
			testSource: input.testSource ?? RUNTIME_TEST,
			testMarker: input.testMarker ?? RUNTIME_TEST_MARKER,
		},
		cutoff: input.cutoff,
		horizons: {
			minimize: input.minimize ?? null,
			delete: input.delete ?? null,
		},
		holdTreatment: postgresRetentionHoldTreatment(input.storeId),
		holdScope: input.holdScope,
		batch: {
			rows: input.rows,
			maxPasses: input.maxPasses,
			orderBy: input.orderBy,
			indexName: input.indexName,
			...(input.indexStoreId ? { indexStoreId: input.indexStoreId } : {}),
			...(input.additionalIndexes
				? { additionalIndexes: input.additionalIndexes }
				: {}),
		},
		cadence: {
			cron: input.cron,
			taskName: input.taskName,
			source: SCHEDULE_SOURCE,
		},
		owner: input.owner,
	};
}

const DAILY_CRON = "0 9 * * *";
const EVERY_MINUTE_CRON = "*/1 * * * *";
const EVERY_FIVE_MINUTES_CRON = "*/5 * * * *";
const EVERY_THIRTY_MINUTES_CRON = "*/30 * * * *";

/**
 * Existing state-machine and domain-specific retention paths that cannot use
 * the generic high-growth SQL executor. Each entry names the actual scheduled
 * export and the physical index/order used by its bounded drain.
 */
export const SPECIALIZED_POSTGRES_RETENTION_CONTRACTS = [
	specializedContract({
		storeId: "postgres:auth.session",
		handlerId: "prune_expired_auth_sessions",
		source: "apps/api/src/services/operational-retention.ts",
		exportName: "pruneExpiredAuthState",
		cutoff: {
			timestampExpression: "expiresAt",
			terminalPredicate: "expiresAt <= now",
		},
		delete: {
			after: atExpiry(),
			predicate: "expiresAt <= now",
			preserves: "no session capability after its exact expiry",
		},
		holdScope: "none",
		rows: 5_000,
		maxPasses: 20,
		orderBy: ["expiresAt", "id"],
		indexName: "session_expires_idx",
		cron: DAILY_CRON,
		taskName: "auth_ephemeral_retention",
		owner: "identity",
	}),
	specializedContract({
		storeId: "postgres:auth.verification",
		handlerId: "prune_expired_auth_verification",
		source: "apps/api/src/services/operational-retention.ts",
		exportName: "pruneExpiredAuthState",
		cutoff: {
			timestampExpression: "expiresAt",
			terminalPredicate: "expiresAt <= now",
		},
		delete: {
			after: atExpiry(),
			predicate: "expiresAt <= now",
			preserves: "no reset, verification, or OAuth capability after expiry",
		},
		holdScope: "none",
		rows: 5_000,
		maxPasses: 20,
		orderBy: ["expiresAt", "id"],
		indexName: "verification_expires_idx",
		cron: DAILY_CRON,
		taskName: "auth_ephemeral_retention",
		owner: "identity",
	}),
	specializedContract({
		storeId: "postgres:auth.organization_creation_reservation",
		handlerId: "prune_expired_organization_creation_reservations",
		source: "apps/api/src/services/operational-retention.ts",
		exportName: "pruneExpiredAuthState",
		cutoff: {
			timestampExpression: "expires_at",
			terminalPredicate: "expires_at <= now",
		},
		delete: {
			after: atExpiry(),
			predicate: "expires_at <= now",
			preserves: "the authoritative organization/member rows, if creation won",
		},
		holdScope: "none",
		rows: 5_000,
		maxPasses: 20,
		orderBy: ["expires_at", "id"],
		indexName: "organization_creation_reservation_expiry_idx",
		cron: DAILY_CRON,
		taskName: "auth_ephemeral_retention",
		owner: "identity",
	}),
	specializedContract({
		storeId: "postgres:auth.invitation",
		handlerId: "prune_terminal_auth_invitations",
		source: "apps/api/src/services/operational-retention.ts",
		exportName: "pruneExpiredAuthState",
		cutoff: {
			timestampExpression: "expiresAt",
			terminalPredicate: "expiresAt <= now - 30 days",
		},
		delete: {
			after: days(30),
			predicate: "expiresAt <= now - 30 days",
			preserves: "canonical membership and principal authorization state",
		},
		holdScope: "none",
		rows: 5_000,
		maxPasses: 20,
		orderBy: ["expiresAt", "id"],
		indexName: "invitation_retention_idx",
		cron: DAILY_CRON,
		taskName: "auth_ephemeral_retention",
		owner: "identity",
	}),
	specializedContract({
		storeId: "postgres:public.invite_token_workspaces",
		handlerId: "prune_terminal_invite_token_workspaces",
		source: "apps/api/src/services/operational-retention.ts",
		exportName: "pruneExpiredAuthState",
		cutoff: {
			timestampExpression: "parent token expires_at / used_at",
			terminalPredicate:
				"parent token expired or used at least 30 days earlier",
		},
		delete: {
			after: days(30),
			predicate: "parent token expires_at or used_at <= now - 30 days",
			preserves:
				"workspace grants copied to the stable principal at redemption",
		},
		holdScope: "none",
		rows: 5_000,
		maxPasses: 20,
		orderBy: ["parent token expires_at", "invite_token_id", "workspace_id"],
		indexName: "invite_token_workspaces_retention_idx",
		cron: DAILY_CRON,
		taskName: "auth_ephemeral_retention",
		owner: "identity",
	}),
	specializedContract({
		storeId: "postgres:public.invite_tokens",
		handlerId: "prune_terminal_invite_tokens",
		source: "apps/api/src/services/operational-retention.ts",
		exportName: "pruneExpiredAuthState",
		cutoff: {
			timestampExpression: "expires_at (eligibility also checks used_at)",
			terminalPredicate:
				"(expires_at <= now - 30 days OR used_at <= now - 30 days) AND no workspace children remain",
		},
		delete: {
			after: days(30),
			predicate:
				"expired/used token after child-first workspace-evidence drain",
			preserves: "membership and stable principal grants",
		},
		holdScope: "none",
		rows: 5_000,
		maxPasses: 20,
		orderBy: ["expires_at", "id"],
		indexName: "invite_tokens_expiry_idx",
		cron: DAILY_CRON,
		taskName: "auth_ephemeral_retention",
		owner: "identity",
	}),
	specializedContract({
		storeId: "postgres:public.tenant_deletion_steps",
		handlerId: "prune_completed_tenant_deletion_steps",
		source: "apps/api/src/services/operational-retention.ts",
		exportName: "pruneCompletedErasureSteps",
		cutoff: {
			timestampExpression: "completed_at",
			terminalPredicate:
				"status = 'completed' AND parent job status = 'purged'",
		},
		delete: {
			after: days(90),
			predicate:
				"completed_at <= now - 90 days and no active organization hold",
			preserves: "the minimized tenant-deletion job receipt",
		},
		holdScope: "organization",
		rows: 5_000,
		maxPasses: 20,
		orderBy: ["completed_at", "id"],
		indexName: "tenant_deletion_steps_completed_retention_idx",
		cron: DAILY_CRON,
		taskName: "erasure_step_retention",
		owner: "data-governance",
	}),
	specializedContract({
		storeId: "postgres:public.workspace_erasure_steps",
		handlerId: "prune_completed_workspace_erasure_steps",
		source: "apps/api/src/services/operational-retention.ts",
		exportName: "pruneCompletedErasureSteps",
		cutoff: {
			timestampExpression: "completed_at",
			terminalPredicate:
				"status = 'completed' AND parent job status = 'purged'",
		},
		delete: {
			after: days(90),
			predicate:
				"completed_at <= now - 90 days and no active matching organization/workspace hold",
			preserves: "the minimized workspace-erasure job and tombstone",
		},
		holdScope: "organization_or_workspace",
		rows: 5_000,
		maxPasses: 20,
		orderBy: ["completed_at", "id"],
		indexName: "workspace_erasure_steps_completed_retention_idx",
		cron: DAILY_CRON,
		taskName: "erasure_step_retention",
		owner: "data-governance",
	}),
	specializedContract({
		storeId: "postgres:public.api_request_logs",
		handlerId: "prune_api_request_logs",
		source: "apps/api/src/services/operational-retention.ts",
		exportName: "pruneApiRequestLogs",
		cutoff: {
			timestampExpression: "created_at",
			terminalPredicate: "created_at < now - 90 days",
		},
		delete: {
			after: days(90),
			predicate: "no active organization hold",
			preserves: "no per-request record outside the reviewed abuse window",
		},
		holdScope: "organization",
		rows: 5_000,
		maxPasses: 20,
		orderBy: ["created_at", "id"],
		indexName: "api_request_logs_retention_idx",
		cron: DAILY_CRON,
		taskName: "api_request_log_retention",
		owner: "platform",
	}),
	specializedContract({
		storeId: "postgres:public.automation_entrypoint_daily_counts",
		handlerId: "prune_automation_entrypoint_daily_counts",
		source: "apps/api/src/services/operational-retention.ts",
		exportName: "pruneAutomationEntrypointDailyCounts",
		cutoff: {
			timestampExpression: "day",
			terminalPredicate: "day < current UTC day - 90 days",
		},
		delete: {
			after: days(90),
			predicate: "no active matching organization/workspace hold",
			preserves: "current admission-day counters only",
		},
		holdScope: "organization_or_workspace",
		rows: 5_000,
		maxPasses: 20,
		orderBy: ["day", "id"],
		indexName: "automation_entrypoint_daily_counts_retention_idx",
		cron: DAILY_CRON,
		taskName: "automation_entrypoint_daily_count_retention",
		owner: "automation",
	}),
	specializedContract({
		storeId: "postgres:public.email_deliveries",
		handlerId: "retain_email_deliveries",
		source: "apps/api/src/services/operational-retention.ts",
		exportName: "retainEmailDeliveries",
		cutoff: {
			timestampExpression: "purge_at (payload clock is expires_at)",
			terminalPredicate: "redacted_at IS NOT NULL AND purge_at <= now",
		},
		minimize: {
			after: days(30),
			predicate: "expires_at <= now AND redacted_at IS NULL",
			preserves: "typed delivery state and sanitized failure class",
		},
		delete: {
			after: days(90),
			predicate: "purge_at <= now and no active organization hold",
			preserves: "no delivery receipt beyond the configured window",
		},
		holdScope: "organization",
		rows: 5_000,
		maxPasses: 20,
		orderBy: ["purge_at", "id"],
		indexName: "email_deliveries_purge_idx",
		additionalIndexes: [{ indexName: "email_deliveries_expiry_idx" }],
		cron: DAILY_CRON,
		taskName: "email_delivery_retention",
		owner: "messaging",
	}),
	specializedContract({
		storeId: "postgres:public.queue_failures",
		handlerId: "retain_queue_failures",
		source: "apps/api/src/services/operational-retention.ts",
		exportName: "retainQueueFailures",
		cutoff: {
			timestampExpression: "purge_at (payload clock is payload_expires_at)",
			terminalPredicate: "payload_redacted_at IS NOT NULL AND purge_at <= now",
		},
		minimize: {
			after: days(30),
			predicate: "payload_expires_at <= now and payload is not redacted",
			preserves: "typed owner locators, failure class, state, and timestamps",
		},
		delete: {
			after: days(90),
			predicate:
				"purge_at <= now and no active matching organization/workspace hold",
			preserves: "no replay receipt beyond the configured window",
		},
		holdScope: "organization_or_workspace",
		rows: 5_000,
		maxPasses: 20,
		orderBy: ["purge_at", "id"],
		indexName: "queue_failures_purge_idx",
		additionalIndexes: [{ indexName: "queue_failures_payload_expiry_idx" }],
		cron: DAILY_CRON,
		taskName: "queue_failure_retention",
		owner: "platform",
	}),
	specializedContract({
		storeId: "postgres:public.erasure_holds",
		handlerId: "redact_released_erasure_hold_evidence",
		source: "apps/api/src/services/erasure-hold-maintenance.ts",
		exportName: "maintainErasureHolds",
		cutoff: {
			timestampExpression: "released_at",
			terminalPredicate:
				"released_at <= now - 90 days AND evidence_redacted_at IS NULL",
		},
		minimize: {
			after: days(90),
			predicate: "released hold with unredacted free-form evidence",
			preserves:
				"typed immutable hold/release transition and tombstone identifiers",
		},
		holdScope: "none",
		rows: 5_000,
		maxPasses: 20,
		orderBy: ["released_at", "id"],
		indexName: "erasure_holds_released_evidence_retention_idx",
		cron: DAILY_CRON,
		taskName: "erasure_hold_maintenance",
		owner: "data-governance",
	}),
	specializedContract({
		storeId: "postgres:public.one_time_capabilities",
		handlerId: "cleanup_one_time_capabilities",
		source: "apps/api/src/services/one-time-capability-cleanup.ts",
		exportName: "cleanupOneTimeCapabilities",
		cutoff: {
			timestampExpression: "expires_at",
			terminalPredicate: "expires_at < now",
		},
		delete: {
			after: atExpiry(),
			predicate: "expires_at < now",
			preserves: "no privileged bearer capability after exact expiry",
		},
		holdScope: "none",
		rows: 2_000,
		maxPasses: 10,
		orderBy: ["expires_at", "id"],
		indexName: "one_time_capabilities_expiry_idx",
		cron: EVERY_FIVE_MINUTES_CRON,
		taskName: "capability_cleanup",
		owner: "identity",
	}),
	specializedContract({
		storeId: "postgres:public.telegram_connection_challenges",
		handlerId: "cleanup_telegram_connection_challenges",
		source: "apps/api/src/services/telegram-connection.ts",
		exportName: "cleanupExpiredTelegramConnectionChallenges",
		cutoff: {
			timestampExpression: "expires_at",
			terminalPredicate: "expires_at <= now",
		},
		delete: {
			after: atExpiry(),
			predicate: "expires_at <= now",
			preserves: "the connected social-account record when the flow completed",
		},
		holdScope: "none",
		rows: 1_000,
		maxPasses: 10,
		orderBy: ["expires_at", "id"],
		indexName: "telegram_connection_challenges_expiry_idx",
		cron: EVERY_FIVE_MINUTES_CRON,
		taskName: "telegram_challenge_cleanup",
		owner: "connections",
	}),
	specializedContract({
		storeId: "postgres:public.automation_webhook_receipts",
		handlerId: "cleanup_automation_webhook_receipts",
		source: "apps/api/src/services/automation-webhook-receipt-cleanup.ts",
		exportName: "cleanupAutomationWebhookReceipts",
		cutoff: {
			timestampExpression: "expires_at",
			terminalPredicate: "expires_at < now",
		},
		delete: {
			after: atExpiry(),
			predicate: "expires_at < now",
			preserves: "the created automation run, if the receipt succeeded",
		},
		holdScope: "none",
		rows: 1_000,
		maxPasses: 10,
		orderBy: ["expires_at", "id"],
		indexName: "automation_webhook_receipts_expiry_idx",
		cron: EVERY_FIVE_MINUTES_CRON,
		taskName: "automation_webhook_cleanup",
		owner: "automation",
	}),
	specializedContract({
		storeId: "postgres:public.idempotency_receipts",
		handlerId: "reconcile_idempotency_receipt_retention",
		source: "apps/api/src/services/idempotency-receipt-reconciler.ts",
		exportName: "reconcileIdempotencyReceipts",
		cutoff: {
			timestampExpression: "expires_at",
			terminalPredicate: "expires_at < now",
			unresolvedPredicate:
				"state = 'in_progress' and created_at < now - 10 minutes",
		},
		delete: {
			after: atExpiry(),
			predicate: "expires_at < now",
			preserves: "no replay response outside its exact request window",
		},
		holdScope: "none",
		rows: 2_000,
		maxPasses: 1,
		orderBy: ["expires_at", "id"],
		indexName: "idempotency_receipts_expiry_idx",
		cron: EVERY_MINUTE_CRON,
		taskName: "idempotency_receipts",
		owner: "platform",
	}),
	specializedContract({
		storeId: "postgres:public.inbound_webhook_events",
		handlerId: "retain_inbound_webhook_events",
		source: "apps/api/src/services/inbound-webhook-retention.ts",
		exportName: "redactExpiredInboundWebhookPayloads",
		cutoff: {
			timestampExpression: "received_at (payload clock is expires_at)",
			terminalPredicate: "redacted receipt received at least 365 days earlier",
		},
		minimize: {
			after: atExpiry(),
			predicate:
				"expires_at <= now, manual_review_until elapsed, and no live processing claim",
			preserves:
				"provider delivery key, typed outcome, owner locators, and timestamps",
		},
		delete: {
			after: days(365),
			predicate:
				"redacted_at IS NOT NULL and no active matching organization hold",
			preserves: "no replay receipt beyond the one-year duplicate window",
		},
		holdScope: "organization",
		rows: 500,
		maxPasses: 1,
		orderBy: ["received_at", "id"],
		indexName: "inbound_webhook_events_receipt_retention_idx",
		additionalIndexes: [{ indexName: "inbound_webhook_events_expiry_idx" }],
		cron: EVERY_FIVE_MINUTES_CRON,
		taskName: "inbound_payload_retention",
		owner: "webhooks",
	}),
	specializedContract({
		storeId: "postgres:public.webhook_logs",
		handlerId: "cleanup_customer_webhook_logs",
		source: "apps/api/src/services/webhook-retention.ts",
		exportName: "cleanupCustomerWebhookHistory",
		cutoff: {
			timestampExpression: "created_at",
			terminalPredicate:
				"created_at < now - 7 days under a fully terminal parent event",
		},
		delete: {
			after: days(7),
			predicate:
				"parent event is hold-free and every child row has reached the same horizon",
			preserves: "the endpoint configuration and current delivery authority",
		},
		holdScope: "organization_or_workspace",
		rows: 5_000,
		maxPasses: 1,
		orderBy: ["created_at", "id"],
		indexName: "webhook_logs_retention_idx",
		cron: EVERY_FIVE_MINUTES_CRON,
		taskName: "webhook_retention",
		owner: "webhooks",
	}),
	specializedContract({
		storeId: "postgres:public.webhook_deliveries",
		handlerId: "cleanup_customer_webhook_deliveries",
		source: "apps/api/src/services/webhook-retention.ts",
		exportName: "cleanupCustomerWebhookHistory",
		cutoff: {
			timestampExpression: "COALESCE(completed_at, manual_review_until)",
			terminalPredicate:
				"manual_review auto-terminalizes at manual_review_until when not held; status IN ('succeeded', 'failed', 'unresolved') deletes seven days after completed_at",
			unresolvedPredicate:
				"status = 'manual_review' before its review deadline or while retained by a matching hold",
		},
		delete: {
			after: days(7),
			predicate: "no attempt-log children remain and parent event is hold-free",
			preserves: "the endpoint configuration",
		},
		holdScope: "organization_or_workspace",
		rows: 5_000,
		maxPasses: 1,
		orderBy: ["completed_at", "id"],
		indexName: "webhook_deliveries_retention_idx",
		additionalIndexes: [
			{ indexName: "webhook_deliveries_manual_review_expiry_idx" },
		],
		cron: EVERY_FIVE_MINUTES_CRON,
		taskName: "webhook_retention",
		owner: "webhooks",
	}),
	specializedContract({
		storeId: "postgres:public.webhook_events",
		handlerId: "cleanup_customer_webhook_events",
		source: "apps/api/src/services/webhook-retention.ts",
		exportName: "cleanupCustomerWebhookHistory",
		cutoff: {
			timestampExpression: "created_at",
			terminalPredicate:
				"created_at < now - 7 days AND no delivery/log children remain",
		},
		delete: {
			after: days(7),
			predicate: "child-first physical drain completed and parent is hold-free",
			preserves: "the endpoint configuration",
		},
		holdScope: "organization_or_workspace",
		rows: 5_000,
		maxPasses: 1,
		orderBy: ["created_at", "id"],
		indexName: "webhook_events_retention_idx",
		cron: EVERY_FIVE_MINUTES_CRON,
		taskName: "webhook_retention",
		owner: "webhooks",
	}),
	specializedContract({
		storeId: "postgres:public.inbox_messages",
		handlerId: "retain_inbox_message_content",
		source: "apps/api/src/services/inbox-maintenance.ts",
		exportName: "cleanupOldConversations",
		testSource: "apps/api/src/__tests__/inbox-maintenance.test.ts",
		testMarker: "inbox-content-retention",
		cutoff: {
			timestampExpression: "parent conversation content_expires_at",
			terminalPredicate: "parent is archived and content_expires_at <= now",
		},
		minimize: {
			after: days(90),
			predicate:
				"message content is not redacted under a due, hold-free parent conversation",
			preserves:
				"message identity, direction, delivery timestamps, and a fenced effect outcome",
		},
		holdScope: "organization_or_workspace",
		rows: 2_000,
		maxPasses: 1,
		orderBy: ["parent content_expires_at", "conversation_id", "id"],
		indexName: "inbox_msg_content_retention_pending_idx",
		additionalIndexes: [
			{
				indexName: "inbox_conv_content_retention_due_idx",
				indexStoreId: "postgres:public.inbox_conversations",
			},
		],
		cron: EVERY_THIRTY_MINUTES_CRON,
		taskName: "inbox_retention",
		owner: "inbox",
	}),
	specializedContract({
		storeId: "postgres:public.inbox_conversation_notes",
		handlerId: "retain_inbox_conversation_notes",
		source: "apps/api/src/services/inbox-maintenance.ts",
		exportName: "cleanupOldConversations",
		testSource: "apps/api/src/__tests__/inbox-maintenance.test.ts",
		testMarker: "inbox-content-retention",
		cutoff: {
			timestampExpression: "parent conversation content_expires_at",
			terminalPredicate: "parent is archived and content_expires_at <= now",
		},
		delete: {
			after: days(90),
			predicate: "note belongs to a due, hold-free archived conversation",
			preserves: "the minimized conversation lifecycle receipt",
		},
		holdScope: "organization_or_workspace",
		rows: 2_000,
		maxPasses: 1,
		orderBy: ["parent content_expires_at", "conversation_id", "id"],
		indexName: "inbox_note_conv_created_idx",
		additionalIndexes: [
			{
				indexName: "inbox_conv_content_retention_due_idx",
				indexStoreId: "postgres:public.inbox_conversations",
			},
		],
		cron: EVERY_THIRTY_MINUTES_CRON,
		taskName: "inbox_retention",
		owner: "inbox",
	}),
	specializedContract({
		storeId: "postgres:public.inbox_conversations",
		handlerId: "retain_inbox_conversation_content",
		source: "apps/api/src/services/inbox-maintenance.ts",
		exportName: "cleanupOldConversations",
		testSource: "apps/api/src/__tests__/inbox-maintenance.test.ts",
		testMarker: "inbox-content-retention",
		cutoff: {
			timestampExpression: "content_expires_at",
			terminalPredicate:
				"status = 'archived' AND every message/note child is drained",
		},
		minimize: {
			after: days(90),
			predicate:
				"content_expires_at <= now, no active matching hold, and no raw-content children remain",
			preserves:
				"conversation identity, account/channel, status, and timestamps",
		},
		holdScope: "organization_or_workspace",
		rows: 500,
		maxPasses: 1,
		orderBy: ["content_expires_at", "id"],
		indexName: "inbox_conv_content_retention_due_idx",
		additionalIndexes: [{ indexName: "inbox_conv_open_activity_idx" }],
		cron: EVERY_THIRTY_MINUTES_CRON,
		taskName: "inbox_retention",
		owner: "inbox",
	}),
	specializedContract({
		storeId: "postgres:public.contact_consent_events",
		handlerId: "retain_superseded_contact_consent_events",
		source: "apps/api/src/services/timed-domain-retention.ts",
		exportName: "retainSupersededContactConsentEvents",
		cutoff: {
			timestampExpression: "next transition occurred_at",
			terminalPredicate: "a later ingestion sequence superseded the event",
		},
		minimize: {
			after: months(24),
			predicate:
				"the superseding transition occurred at least two years earlier",
			preserves:
				"rotation-safe hashes, decision, source, policy, jurisdiction, and ordering tuple",
		},
		holdScope: "organization_or_workspace",
		rows: 500,
		maxPasses: 4,
		orderBy: ["next transition occurred_at", "id"],
		indexName: "contact_consent_events_retention_idx",
		additionalIndexes: [
			{ indexName: "contact_consent_events_supersession_idx" },
		],
		cron: DAILY_CRON,
		taskName: "timed_domain_retention",
		owner: "data-governance",
	}),
	specializedContract({
		storeId: "postgres:public.broadcast_recipients",
		handlerId: "retain_broadcast_recipients",
		source: "apps/api/src/services/timed-domain-retention.ts",
		exportName: "retainBroadcastRecipients",
		cutoff: {
			timestampExpression: "parent broadcast completed_at",
			terminalPredicate: "status IN ('sent', 'failed', 'cancelled')",
			unresolvedPredicate: "status = 'unknown'",
		},
		minimize: {
			after: days(30),
			predicate: "terminal recipient under a completed campaign",
			preserves:
				"recipient hash, provider message identity, typed outcome, and timestamps",
		},
		delete: {
			after: months(12),
			predicate:
				"PII is redacted and no active organization/workspace hold applies",
			preserves: "aggregate delivery counts on the parent broadcast",
		},
		holdScope: "organization_or_workspace",
		rows: 500,
		maxPasses: 4,
		orderBy: ["parent completed_at", "id"],
		indexName: "broadcasts_retention_idx",
		indexStoreId: "postgres:public.broadcasts",
		additionalIndexes: [
			{ indexName: "broadcast_recipients_pii_retention_idx" },
			{ indexName: "broadcast_recipients_outcome_retention_idx" },
		],
		cron: DAILY_CRON,
		taskName: "timed_domain_retention",
		owner: "messaging",
	}),
	specializedContract({
		storeId: "postgres:public.broadcasts",
		handlerId: "retain_broadcasts",
		source: "apps/api/src/services/timed-domain-retention.ts",
		exportName: "retainBroadcasts",
		cutoff: {
			timestampExpression: "completed_at",
			terminalPredicate:
				"status IN ('sent', 'partially_failed', 'failed', 'cancelled') AND no recipient children remain",
			unresolvedPredicate: "status = 'requires_attention'",
		},
		delete: {
			after: months(12),
			predicate:
				"child-first recipient drain completed and no active matching hold applies",
			preserves:
				"no campaign row beyond the configured campaign-history window",
		},
		holdScope: "organization_or_workspace",
		rows: 500,
		maxPasses: 4,
		orderBy: ["completed_at", "id"],
		indexName: "broadcasts_retention_idx",
		cron: DAILY_CRON,
		taskName: "timed_domain_retention",
		owner: "messaging",
	}),
	specializedContract({
		storeId: "postgres:public.external_posts",
		handlerId: "retain_external_posts",
		source: "apps/api/src/services/timed-domain-retention.ts",
		exportName: "retainExternalPosts",
		cutoff: {
			timestampExpression: "published_at",
			terminalPredicate: "no ad still references the provider mirror",
		},
		delete: {
			after: months(25),
			predicate:
				"hold-free, childless mirror with durable thumbnail cleanup intent committed",
			preserves:
				"active ads and their copied platform post identity; provider resync remains available",
		},
		holdScope: "organization_or_workspace",
		rows: 500,
		maxPasses: 4,
		orderBy: ["published_at", "id"],
		indexName: "external_posts_retention_idx",
		cron: DAILY_CRON,
		taskName: "timed_domain_retention",
		owner: "publishing",
	}),
	specializedContract({
		storeId: "postgres:public.social_account_sync_state",
		handlerId: "redact_social_account_sync_errors",
		source: "apps/api/src/services/timed-domain-retention.ts",
		exportName: "redactSocialAccountSyncErrors",
		cutoff: {
			timestampExpression: "last_error_at",
			terminalPredicate: "last_error IS NOT NULL",
		},
		minimize: {
			after: days(90),
			predicate: "free-form provider error reached its detail horizon",
			preserves:
				"sync cursor, due/lease state, typed error class, counters, and error timestamp",
		},
		holdScope: "organization_or_workspace",
		rows: 500,
		maxPasses: 4,
		orderBy: ["last_error_at", "id"],
		indexName: "social_account_sync_error_retention_idx",
		cron: DAILY_CRON,
		taskName: "timed_domain_retention",
		owner: "publishing",
	}),
	specializedContract({
		storeId: "postgres:public.automation_bindings",
		handlerId: "redact_automation_binding_sync_errors",
		source: "apps/api/src/services/timed-domain-retention.ts",
		exportName: "redactAutomationBindingSyncErrors",
		cutoff: {
			timestampExpression: "sync_error_at",
			terminalPredicate: "sync_error IS NOT NULL",
		},
		minimize: {
			after: days(90),
			predicate: "free-form provider sync error reached its detail horizon",
			preserves:
				"binding definition, desired/applied revisions, typed outcome, and retry authority",
		},
		holdScope: "organization_or_workspace",
		rows: 500,
		maxPasses: 4,
		orderBy: ["sync_error_at", "id"],
		indexName: "automation_bindings_sync_error_retention_idx",
		cron: DAILY_CRON,
		taskName: "timed_domain_retention",
		owner: "automation",
	}),
	specializedContract({
		storeId: "postgres:public.ai_knowledge_documents",
		handlerId: "redact_ai_knowledge_failure_details",
		source: "apps/api/src/services/timed-domain-retention.ts",
		exportName: "redactAiKnowledgeFailureDetails",
		cutoff: {
			timestampExpression: "completed_at",
			terminalPredicate: "status = 'terminal_failure'",
			unresolvedPredicate: "status = 'retryable_failure'",
		},
		minimize: {
			after: days(90),
			predicate: "terminal free-form failure detail is not yet minimized",
			preserves:
				"document entity, source, stable failure code, status, and timestamps",
		},
		holdScope: "organization_or_workspace",
		rows: 500,
		maxPasses: 4,
		orderBy: ["completed_at", "id"],
		indexName: "ai_knowledge_documents_failure_retention_idx",
		cron: DAILY_CRON,
		taskName: "timed_domain_retention",
		owner: "ai",
	}),
	specializedContract({
		storeId: "postgres:public.whatsapp_phone_provisioning_operations",
		handlerId: "retain_terminal_phone_provisioning_evidence",
		source: "apps/api/src/services/timed-domain-retention.ts",
		exportName: "retainTerminalPhoneProvisioningEvidence",
		cutoff: {
			timestampExpression:
				"detail_expires_at (terminal clock derives from the seven-day detail deadline)",
			terminalPredicate:
				"status IN ('completed', 'cancelled') AND detail_expires_at <= now",
		},
		minimize: {
			after: atExpiry(),
			predicate:
				"checkout URL at seven days; checkout/error evidence at one year",
			preserves:
				"current phone read projection, request hashes, provider locators, terminal state, and timestamps",
		},
		holdScope: "organization",
		rows: 1_000,
		maxPasses: 12,
		orderBy: ["detail_expires_at", "id"],
		indexName: "wa_phone_provisioning_detail_expiry_idx",
		additionalIndexes: [
			{ indexName: "wa_phone_provisioning_evidence_retention_idx" },
		],
		cron: DAILY_CRON,
		taskName: "timed_domain_retention",
		owner: "connections",
	}),
	specializedContract({
		storeId: "postgres:public.whatsapp_phone_release_operations",
		handlerId: "retain_terminal_phone_release_evidence",
		source: "apps/api/src/services/timed-domain-retention.ts",
		exportName: "retainTerminalPhoneReleaseEvidence",
		cutoff: {
			timestampExpression: "completed_at",
			terminalPredicate: "status = 'completed'",
			unresolvedPredicate: "status IN ('unknown', 'manual_review')",
		},
		delete: {
			after: months(12),
			predicate: "completed release with no active organization hold",
			preserves:
				"the phone entity's released status and provider cleanup projection",
		},
		holdScope: "organization",
		rows: 500,
		maxPasses: 4,
		orderBy: ["completed_at", "id"],
		indexName: "wa_phone_release_retention_idx",
		cron: DAILY_CRON,
		taskName: "timed_domain_retention",
		owner: "connections",
	}),
	specializedContract({
		storeId: "postgres:public.operator_resolution_notes",
		handlerId: "retain_operator_resolution_notes",
		source: "apps/api/src/services/timed-domain-retention.ts",
		exportName: "retainOperatorResolutionNotes",
		cutoff: {
			timestampExpression: "expires_at",
			terminalPredicate: "expires_at <= now",
		},
		delete: {
			after: days(90),
			predicate: "encrypted operator rationale reached its exact expiry",
			preserves:
				"append-only operator evidence with reason code, digest, scalar state, and transition timestamps",
		},
		holdScope: "none",
		rows: 500,
		maxPasses: 4,
		orderBy: ["expires_at", "evidence_id"],
		indexName: "operator_resolution_notes_expiry_idx",
		cron: DAILY_CRON,
		taskName: "timed_domain_retention",
		owner: "data-governance",
	}),
	specializedContract({
		storeId: "postgres:public.publish_outbox",
		handlerId: "cleanup_dispatched_publish_outbox",
		source: "apps/api/src/services/publish-outbox.ts",
		exportName: "dispatchPublishOutbox",
		cutoff: {
			timestampExpression: "dispatched_at",
			terminalPredicate:
				"status = 'dispatched' AND dispatched_at < now - 30 days",
		},
		delete: {
			after: days(30),
			predicate: "no active organization hold",
			preserves: "post/notification state and the downstream durable work item",
		},
		holdScope: "organization",
		rows: 1_000,
		maxPasses: 1,
		orderBy: ["dispatched_at", "id"],
		indexName: "publish_outbox_retention_idx",
		cron: EVERY_MINUTE_CRON,
		taskName: "publish_outbox",
		owner: "publishing",
	}),
	specializedContract({
		storeId: "postgres:public.public_growth_events",
		handlerId: "cleanup_public_growth_events",
		source: "apps/api/src/services/public-growth-events.ts",
		exportName: "processPublicGrowthEvents",
		cutoff: {
			timestampExpression: "completed_at",
			terminalPredicate: "status IN ('succeeded', 'failed')",
		},
		delete: {
			after: days(90),
			predicate:
				"anonymous rows at 7 days, identified rows at 90 days, no active matching hold",
			preserves:
				"aggregate visit/scan/conversion counts on the owning definition",
		},
		holdScope: "organization_or_workspace",
		rows: 5_000,
		maxPasses: 1,
		orderBy: ["completed_at", "id"],
		indexName: "public_growth_events_retention_idx",
		cron: EVERY_MINUTE_CRON,
		taskName: "public_growth_events",
		owner: "growth",
	}),
	specializedContract({
		storeId: "postgres:public.external_subject_cleanup_jobs",
		handlerId: "prune_external_subject_cleanup_receipts",
		source: "apps/api/src/services/external-subject-cleanup.ts",
		exportName: "processExternalSubjectCleanupJobs",
		cutoff: {
			timestampExpression: "purge_at",
			terminalPredicate: "status = 'completed' AND purge_at <= now",
			unresolvedPredicate: "status = 'manual_review'",
		},
		delete: {
			after: atExpiry(),
			predicate: "completed cleanup receipt reached purge_at",
			preserves:
				"manual-review jobs and the fact that external deletion already completed",
		},
		holdScope: "none",
		rows: 100,
		maxPasses: 1,
		orderBy: ["purge_at", "id"],
		indexName: "external_subject_cleanup_jobs_retention_idx",
		cron: EVERY_MINUTE_CRON,
		taskName: "external_subject_cleanup",
		owner: "platform",
	}),
	specializedContract({
		storeId: "postgres:public.ad_leads",
		handlerId: "prune_expired_advanced_ad_leads",
		source: "apps/api/src/services/ad-advanced-store.ts",
		exportName: "pruneExpiredAdvancedAdLeads",
		testSource: "apps/api/src/__tests__/media-upload-session-retention.test.ts",
		testMarker: "advanced ad lead retention",
		cutoff: {
			timestampExpression: "expires_at",
			terminalPredicate: "expires_at <= now",
		},
		delete: {
			after: atExpiry(),
			predicate: "expires_at <= now",
			preserves:
				"a promoted contact only; provider lead identity and encrypted intake payload are deleted together",
		},
		holdScope: "none",
		rows: 5_000,
		maxPasses: 1,
		orderBy: ["expires_at", "id"],
		indexName: "ad_leads_expiry_idx",
		cron: DAILY_CRON,
		taskName: "advanced_ad_lead_retention",
		owner: "ads",
	}),
	specializedContract({
		storeId: "postgres:public.media_upload_sessions",
		handlerId: "retain_media_upload_sessions",
		source: "apps/api/src/services/media-upload-session-cleanup.ts",
		exportName: "cleanupExpiredMediaUploadSessions",
		testSource: "apps/api/src/__tests__/media-upload-session-retention.test.ts",
		testMarker: "media upload session retention",
		cutoff: {
			timestampExpression: "GREATEST(expires_at, updated_at)",
			terminalPredicate:
				"status IN ('completed', 'aborted', 'failed', 'expired') AND expires_at <= now - 24 hours AND updated_at <= now - 24 hours AND lease_expires_at IS NULL AND multipart_upload_id_ciphertext IS NULL",
		},
		minimize: {
			after: atExpiry(),
			predicate:
				"completion, confirmed abort, or expiry clears multipart_upload_id_ciphertext",
			preserves: "only bounded terminal upload diagnostics during the grace",
		},
		delete: {
			after: days(1),
			predicate:
				"terminal row is at least 24 hours past both expires_at and its last transition, has no active lease, and has no multipart authority",
			preserves: "the authoritative media row and object lifecycle",
		},
		holdScope: "none",
		rows: 5_000,
		maxPasses: 1,
		orderBy: ["expires_at", "id"],
		indexName: "media_upload_sessions_expiry_idx",
		cron: EVERY_MINUTE_CRON,
		taskName: "media_upload_session_expiry",
		owner: "media",
	}),
	specializedContract({
		storeId: "postgres:public.media_derivatives",
		handlerId: "cleanup_expired_media_derivatives",
		source: "apps/api/src/services/media-processing-jobs.ts",
		exportName: "cleanupExpiredMediaDerivatives",
		cutoff: {
			timestampExpression: "delete_after",
			terminalPredicate:
				"status IN ('ready', 'deleting') AND delete_after <= now",
		},
		delete: {
			after: atExpiry(),
			predicate: "private object deletion succeeds before projection deletion",
			preserves: "the original media row and bytes",
		},
		holdScope: "none",
		rows: 100,
		maxPasses: 1,
		orderBy: ["delete_after", "id"],
		indexName: "media_derivatives_cleanup_idx",
		cron: DAILY_CRON,
		taskName: "media_derivative_retention",
		owner: "media",
	}),
	specializedContract({
		storeId: "postgres:public.ad_report_jobs",
		handlerId: "retain_advanced_ad_report_jobs",
		source: "apps/api/src/services/ad-report-jobs.ts",
		exportName: "retainAdvancedAdReports",
		cutoff: {
			timestampExpression: "updated_at",
			terminalPredicate:
				"status IN ('completed', 'failed', 'cancelled', 'unknown')",
		},
		minimize: {
			after: days(7),
			predicate:
				"result_expires_at <= now deletes private bytes and clears result_object_key",
			preserves: "bounded terminal job metadata without normalized report rows",
		},
		delete: {
			after: days(90),
			predicate: "terminal job has no result object",
			preserves: "no report-specific local authority",
		},
		holdScope: "none",
		rows: 500,
		maxPasses: 1,
		orderBy: ["updated_at", "id"],
		indexName: "ad_report_jobs_terminal_retention_idx",
		additionalIndexes: [{ indexName: "ad_report_jobs_result_expiry_idx" }],
		cron: DAILY_CRON,
		taskName: "advanced_ad_report_retention",
		owner: "ads",
	}),
	specializedContract({
		storeId: "postgres:public.ad_report_rows",
		handlerId: "retain_advanced_ad_report_rows",
		source: "apps/api/src/services/ad-report-jobs.ts",
		exportName: "retainAdvancedAdReports",
		cutoff: {
			timestampExpression: "parent result_expires_at",
			terminalPredicate: "parent result_expires_at <= now",
		},
		delete: {
			after: days(7),
			predicate: "parent result artifact reached expiry",
			preserves: "bounded terminal report-job metadata only",
		},
		holdScope: "none",
		rows: 5_000,
		maxPasses: 20,
		orderBy: ["parent result_expires_at", "report_job_id", "row_number"],
		indexName: "ad_report_jobs_result_expiry_idx",
		indexStoreId: "postgres:public.ad_report_jobs",
		cron: DAILY_CRON,
		taskName: "advanced_ad_report_retention",
		owner: "ads",
	}),
	specializedContract({
		storeId: "postgres:public.tool_jobs",
		handlerId: "prune_expired_tool_jobs",
		source: "apps/api/src/services/tool-jobs.ts",
		exportName: "pruneExpiredToolJobs",
		cutoff: {
			timestampExpression: "purge_at",
			terminalPredicate: "purge_at <= now",
		},
		delete: {
			after: atExpiry(),
			predicate: "purge_at <= now",
			preserves:
				"no durable tool payload; the client observes expiry as terminal",
		},
		holdScope: "none",
		rows: 500,
		maxPasses: 1,
		orderBy: ["purge_at", "id"],
		indexName: "tool_jobs_purge_idx",
		cron: EVERY_MINUTE_CRON,
		taskName: "tool_jobs",
		owner: "platform",
	}),
] as const satisfies readonly ExecutablePostgresRetentionContract[];
