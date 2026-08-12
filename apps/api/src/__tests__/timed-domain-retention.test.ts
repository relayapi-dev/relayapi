import { describe, expect, it } from "bun:test";
import {
	aiKnowledgeDocuments,
	automationBindings,
	broadcastRecipients,
	broadcasts,
	contactConsentEvents,
	EXECUTABLE_POSTGRES_RETENTION_CONTRACTS,
	externalPosts,
	operatorResolutionNotes,
	socialAccountSyncState,
	whatsappPhoneProvisioningOperations,
	whatsappPhoneReleaseOperations,
} from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";

const TIMED_DOMAIN_RETENTION_RUNTIME_PROOF =
	"TIMED_DOMAIN_RETENTION_RUNTIME_PROOF";
const source = await Bun.file(
	new URL("../services/timed-domain-retention.ts", import.meta.url),
).text();

function indexes(table: Parameters<typeof getTableConfig>[0]): string[] {
	return getTableConfig(table).indexes.flatMap((index) =>
		index.config.name ? [index.config.name] : [],
	);
}

describe(TIMED_DOMAIN_RETENTION_RUNTIME_PROOF, () => {
	it("registers every newly explicit timed domain store exactly once", () => {
		const expected = [
			"postgres:public.contact_consent_events",
			"postgres:public.broadcasts",
			"postgres:public.broadcast_recipients",
			"postgres:public.external_posts",
			"postgres:public.social_account_sync_state",
			"postgres:public.automation_bindings",
			"postgres:public.ai_knowledge_documents",
			"postgres:public.whatsapp_phone_provisioning_operations",
			"postgres:public.whatsapp_phone_release_operations",
			"postgres:public.operator_resolution_notes",
		];
		const registered = EXECUTABLE_POSTGRES_RETENTION_CONTRACTS.map(
			(contract) => contract.storeId,
		);
		for (const storeId of expected) {
			expect(
				registered.filter((candidate) => candidate === storeId),
			).toHaveLength(1);
		}
	});

	it("pins the exact oldest-first indexes used by every phase", () => {
		expect(indexes(contactConsentEvents)).toEqual(
			expect.arrayContaining([
				"contact_consent_events_supersession_idx",
				"contact_consent_events_retention_idx",
			]),
		);
		expect(indexes(broadcasts)).toContain("broadcasts_retention_idx");
		expect(indexes(broadcastRecipients)).toEqual(
			expect.arrayContaining([
				"broadcast_recipients_pii_retention_idx",
				"broadcast_recipients_outcome_retention_idx",
			]),
		);
		expect(indexes(externalPosts)).toContain("external_posts_retention_idx");
		expect(indexes(socialAccountSyncState)).toContain(
			"social_account_sync_error_retention_idx",
		);
		expect(indexes(automationBindings)).toContain(
			"automation_bindings_sync_error_retention_idx",
		);
		expect(indexes(aiKnowledgeDocuments)).toContain(
			"ai_knowledge_documents_failure_retention_idx",
		);
		expect(indexes(whatsappPhoneProvisioningOperations)).toContain(
			"wa_phone_provisioning_evidence_retention_idx",
		);
		expect(indexes(whatsappPhoneReleaseOperations)).toContain(
			"wa_phone_release_retention_idx",
		);
		expect(indexes(operatorResolutionNotes)).toContain(
			"operator_resolution_notes_expiry_idx",
		);
	});

	it("preserves unresolved capability while enforcing exact horizons", () => {
		expect(source).toContain("interval '2 years'");
		expect(source).toContain("interval '30 days'");
		expect(source).toContain("interval '90 days'");
		expect(source).toContain("interval '1 year'");
		expect(source).toContain("interval '25 months'");
		expect(source).toContain(
			"recipient.status IN ('sent', 'failed', 'cancelled')",
		);
		expect(source).not.toContain(
			"recipient.status IN ('sent', 'failed', 'unknown', 'cancelled')",
		);
		expect(source).toContain(
			"parent.status IN (\n\t\t\t\t\t\t'sent',\n\t\t\t\t\t\t'partially_failed',\n\t\t\t\t\t\t'failed',\n\t\t\t\t\t\t'cancelled'",
		);
		expect(source).not.toContain("DELETE FROM automation_bindings");
		expect(source).not.toContain("DELETE FROM ai_knowledge_documents");
		expect(source).not.toContain(
			"DELETE FROM whatsapp_phone_provisioning_operations",
		);
		expect(source).toContain("DELETE FROM operator_resolution_notes AS note");
	});

	it("bounds physical rows rather than trusting cascading source counts", () => {
		expect(source).toContain("LIMIT $" + "{TIMED_DOMAIN_RETENTION_BATCH}");
		expect(source.indexOf("DELETE FROM broadcast_recipients")).toBeLessThan(
			source.indexOf("DELETE FROM broadcasts AS parent"),
		);
		expect(source).toContain(
			"FROM broadcast_recipients AS recipient\n\t\t\t\t\t\t WHERE recipient.broadcast_id = parent.id",
		);
		expect(source).toContain("FROM $" + "{ads} AS ad");
		expect(source).toContain(".insert(externalSubjectCleanupJobs)");
		expect(source).toContain(
			"One candidate produces at most two physical writes",
		);
		expect(source).toContain("FOR SHARE OF tenant");
		expect(source).toContain("FOR UPDATE OF item SKIP LOCKED");
	});

	it("uses a real error clock rather than mutable row freshness", async () => {
		const columns = getTableConfig(automationBindings).columns.map(
			(column) => column.name,
		);
		expect(columns).toContain("sync_error_at");
		const bindingSync = await Bun.file(
			new URL("../services/automations/binding-sync.ts", import.meta.url),
		).text();
		expect(bindingSync).toContain("syncErrorAt: failedAt");
		expect(bindingSync).toContain("syncErrorAt: null");
		expect(source).toContain(
			"item.sync_error_at <= $" + "{now} - interval '90 days'",
		);
	});

	it("applies each store's declared legal-hold treatment to minimization", () => {
		const contracts = new Map(
			EXECUTABLE_POSTGRES_RETENTION_CONTRACTS.map((contract) => [
				contract.storeId,
				contract,
			]),
		);
		expect(
			contracts.get("postgres:public.contact_consent_events")?.holdTreatment,
		).toBe("minimize");
		expect(
			contracts.get("postgres:public.broadcast_recipients")?.holdTreatment,
		).toBe("minimize");
		expect(
			contracts.get("postgres:public.automation_bindings")?.holdTreatment,
		).toBe("pause");
		expect(
			contracts.get("postgres:public.ai_knowledge_documents")?.holdTreatment,
		).toBe("pause");

		const bindingStart = source.indexOf(
			"export async function redactAutomationBindingSyncErrors",
		);
		const aiStart = source.indexOf(
			"export async function redactAiKnowledgeFailureDetails",
		);
		const phoneStart = source.indexOf(
			"export async function retainTerminalPhoneProvisioningEvidence",
		);
		expect(bindingStart).toBeGreaterThan(-1);
		expect(aiStart).toBeGreaterThan(bindingStart);
		expect(phoneStart).toBeGreaterThan(aiStart);
		expect(source.slice(bindingStart, aiStart)).toContain(
			"FROM erasure_holds AS hold",
		);
		expect(source.slice(aiStart, phoneStart)).toContain(
			"FROM erasure_holds AS hold",
		);
		expect(source).toContain(
			"active hold preserves that minimal receipt, not stale contact detail",
		);
		expect(source).toContain(
			"A hold does not lengthen raw recipient-PII retention",
		);
	});
});
