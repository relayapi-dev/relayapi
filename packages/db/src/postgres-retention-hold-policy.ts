import type { LegalHoldTreatment } from "./privacy-retention-registry";

/**
 * Dependency-free executable projection of the canonical privacy registry.
 *
 * Retention contract construction imports this module from schema-adjacent
 * code, where importing the full registry would create an initialization
 * cycle through domain and financial vocabularies. The executable-contract
 * suite compares every projected value back to the canonical registry.
 */
const PAUSE_STORES = new Set<string>([
	"postgres:public.ad_metrics",
	"postgres:public.post_analytics",
	"postgres:public.automation_conversion_events",
	"postgres:public.tenant_deletion_steps",
	"postgres:public.workspace_erasure_steps",
	"postgres:public.webhook_logs",
	"postgres:public.webhook_deliveries",
	"postgres:public.webhook_events",
	"postgres:public.inbox_messages",
	"postgres:public.inbox_conversation_notes",
	"postgres:public.inbox_conversations",
	"postgres:public.broadcasts",
	"postgres:public.external_posts",
	"postgres:public.automation_bindings",
	"postgres:public.ai_knowledge_documents",
	"postgres:public.publish_outbox",
	"postgres:public.public_growth_events",
	"postgres:public.usage_buckets",
	"postgres:public.usage_reservations",
	"postgres:public.financial_retention_receipts",
]);

const NEVER_STORES = new Set<string>([
	"postgres:auth.session",
	"postgres:auth.verification",
	"postgres:auth.organization_creation_reservation",
	"postgres:public.erasure_holds",
	"postgres:public.one_time_capabilities",
	"postgres:public.telegram_connection_challenges",
	"postgres:public.automation_webhook_receipts",
	"postgres:public.idempotency_receipts",
	"postgres:public.operator_resolution_notes",
	"postgres:public.external_subject_cleanup_jobs",
	"postgres:public.tool_jobs",
	"postgres:public.ad_leads",
	"postgres:public.media_upload_sessions",
	"postgres:public.media_derivatives",
	"postgres:public.ad_report_jobs",
	"postgres:public.ad_report_rows",
]);

export function postgresRetentionHoldTreatment(
	storeId: string,
): LegalHoldTreatment {
	if (PAUSE_STORES.has(storeId)) return "pause";
	if (NEVER_STORES.has(storeId)) return "never";
	return "minimize";
}
