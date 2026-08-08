import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import {
	assertDatabaseIdentity,
	assertSupportedPostgres,
} from "../src/database-contract";
import { readCatalog } from "./capture-catalog-fingerprint";
import {
	auditCatalogFingerprint,
	buildCatalogFingerprint,
	type CatalogFingerprint,
	type CatalogObject,
	OLD_CHAIN_CATALOG_EVIDENCE_FILE,
} from "./catalog-fingerprint-contract";
import {
	type MigrationManifest,
	verifyLiveMigrationHistory,
} from "./verify-migration-history";

const CONNECTION_ENV =
	"CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE";

type Sql = ReturnType<typeof postgres>;

export const PRELIVE_INVENTORY_EXCLUDED_SCHEMA = "relayapi_cutover_guard";
const PRELIVE_RESET_SENTINEL_TABLE = "reset_sentinel";

export const EXPECTED_RESET_GUARD_CATALOG_SIGNATURES = [
	"column:relayapi_cutover_guard.reset_sentinel.approved_inventory_sha256",
	"column:relayapi_cutover_guard.reset_sentinel.armed_at",
	"column:relayapi_cutover_guard.reset_sentinel.base_manifest_sha256",
	"column:relayapi_cutover_guard.reset_sentinel.expected_database",
	"column:relayapi_cutover_guard.reset_sentinel.id",
	"column:relayapi_cutover_guard.reset_sentinel.sentinel_sha256",
	"constraint:relayapi_cutover_guard.reset_sentinel.reset_sentinel_approved_inventory_sha256_check",
	"constraint:relayapi_cutover_guard.reset_sentinel.reset_sentinel_base_manifest_sha256_check",
	"constraint:relayapi_cutover_guard.reset_sentinel.reset_sentinel_id_check",
	"constraint:relayapi_cutover_guard.reset_sentinel.reset_sentinel_pkey",
	"constraint:relayapi_cutover_guard.reset_sentinel.reset_sentinel_sentinel_sha256_check",
	"index:relayapi_cutover_guard.reset_sentinel_pkey",
	"relation:relayapi_cutover_guard.reset_sentinel",
	"schema:relayapi_cutover_guard",
] as const;

function extensionSchema(object: CatalogObject): string | null {
	if (object.kind !== "extension") return null;
	try {
		const definition = JSON.parse(object.definition) as { schema?: unknown };
		return typeof definition.schema === "string" ? definition.schema : null;
	} catch {
		return null;
	}
}

export function resetGuardCatalogSignatures(
	objects: readonly CatalogObject[],
): string[] {
	return objects
		.filter(
			(object) =>
				(object.kind === "schema" &&
					object.identity === PRELIVE_INVENTORY_EXCLUDED_SCHEMA) ||
				object.identity.startsWith(`${PRELIVE_INVENTORY_EXCLUDED_SCHEMA}.`) ||
				extensionSchema(object) === PRELIVE_INVENTORY_EXCLUDED_SCHEMA,
		)
		.map(({ kind, identity }) => `${kind}:${identity}`)
		.sort();
}

export function assertResetGuardCatalogShape(
	objects: readonly CatalogObject[],
	input: { allowAbsent: boolean; rowCount: number | null },
): "absent" | "ready" {
	const signatures = resetGuardCatalogSignatures(objects);
	if (signatures.length === 0 && input.allowAbsent) {
		if (input.rowCount !== null) {
			throw new Error("Absent reset guard cannot report sentinel rows");
		}
		return "absent";
	}
	if (
		JSON.stringify(signatures) !==
		JSON.stringify(EXPECTED_RESET_GUARD_CATALOG_SIGNATURES)
	) {
		throw new Error(
			`Reset guard schema contains unexpected or missing objects: ${signatures.join(", ")}`,
		);
	}
	if (input.rowCount !== 1) {
		throw new Error("Reset guard must contain exactly one sentinel row");
	}
	return "ready";
}

export type InventoryRow = Record<string, unknown>;
export type InventoryRowsByTable = ReadonlyMap<string, readonly InventoryRow[]>;

export type MoneyBearingReference = {
	kind: string;
	organizationId: string | null;
	localId: string;
	providerIds: string[];
	status: string | null;
};

export type ProviderOperationInventoryContract = {
	relation: string;
	kind: string;
	stateKey: string;
	unresolvedStates: readonly string[];
	terminalStates: readonly string[];
	providerKeys: readonly string[];
	localIdKey?: string;
	organizationIdKey?: string;
	qualifies?: (row: InventoryRow) => boolean;
};

export type MoneyBearingInventoryContract = {
	relation: string;
	kind: string;
	providerKeys: readonly string[];
	stateKey?: string;
	moneyBearingStates?: readonly string[];
	nonMoneyBearingStates?: readonly string[];
	localIdKey?: string;
	organizationIdKey?: string;
	qualifies?: (row: InventoryRow) => boolean;
};

const STRIPE_PHONE_PROVIDER_KEYS = [
	"stripe_customer_id",
	"stripe_checkout_session_id",
	"stripe_subscription_id",
	"stripe_subscription_item_id",
	"stripe_latest_invoice_id",
] as const;

export const PROVIDER_OPERATION_INVENTORY_CONTRACTS = [
	{
		relation: "public.subscription_checkout_operations",
		kind: "subscription_checkout_operation",
		stateKey: "status",
		unresolvedStates: ["pending", "creating", "unknown", "created"],
		terminalStates: ["completed", "blocked", "failed", "expired"],
		providerKeys: ["stripe_customer_id", "stripe_checkout_session_id"],
	},
	{
		relation: "public.billing_operations",
		kind: "billing_operation",
		stateKey: "status",
		unresolvedStates: [
			"invoice_preparing",
			"invoice_unknown",
			"pending",
			"processing",
			"failed",
			"unknown",
			"terminal_failed",
			"manual_review",
		],
		terminalStates: ["succeeded", "released", "written_off"],
		providerKeys: [
			"stripe_customer_id",
			"stripe_subscription_id",
			"stripe_invoice_id",
			"stripe_invoice_item_id",
		],
	},
	{
		relation: "public.billing_operation_attempts",
		kind: "billing_operation_attempt",
		stateKey: "status",
		unresolvedStates: ["prepared", "requesting", "unknown"],
		terminalStates: ["succeeded", "rejected", "written_off"],
		providerKeys: [
			"stripe_customer_id",
			"stripe_subscription_id",
			"stripe_invoice_id",
			"stripe_invoice_item_id",
		],
	},
	{
		relation: "public.whatsapp_phone_billing_operations",
		kind: "phone_billing_operation",
		stateKey: "state",
		unresolvedStates: [
			"pending",
			"processing",
			"request_may_have_been_sent",
			"unknown",
			"waiting_payment",
			"manual_review",
		],
		terminalStates: ["applied"],
		providerKeys: STRIPE_PHONE_PROVIDER_KEYS,
	},
	{
		relation: "public.whatsapp_phone_billing_attempts",
		kind: "phone_billing_attempt",
		stateKey: "status",
		unresolvedStates: [
			"prepared",
			"requesting",
			"unknown",
			"waiting_payment",
			"manual_review",
		],
		terminalStates: ["applied", "confirmed_not_applied"],
		providerKeys: STRIPE_PHONE_PROVIDER_KEYS,
	},
	{
		relation: "public.dunning_events",
		kind: "dunning_delivery",
		stateKey: "status",
		unresolvedStates: ["pending", "processing", "failed", "terminal_failed"],
		terminalStates: ["sent"],
		providerKeys: ["stripe_invoice_id", "provider_message_id"],
	},
	{
		relation: "public.dunning_events",
		kind: "dunning_deactivation",
		stateKey: "deactivation_status",
		unresolvedStates: [
			"pending",
			"processing",
			"unknown",
			"failed",
			"manual_review",
		],
		terminalStates: ["not_applicable", "succeeded"],
		providerKeys: ["stripe_invoice_id", "deactivation_operation_id"],
	},
	{
		relation: "public.billing_outbox",
		kind: "billing_outbox_operation",
		stateKey: "status",
		unresolvedStates: ["pending", "processing", "failed", "manual_review"],
		terminalStates: ["succeeded"],
		providerKeys: [],
	},
	{
		relation: "public.stripe_events",
		kind: "stripe_inbox_event",
		stateKey: "status",
		unresolvedStates: ["pending", "processing", "failed", "manual_review"],
		terminalStates: ["succeeded"],
		providerKeys: ["object_id", "customer_id", "subscription_id"],
	},
	{
		relation: "public.whatsapp_phone_provisioning_operations",
		kind: "phone_provisioning_operation",
		stateKey: "status",
		unresolvedStates: [
			"pending",
			"processing",
			"waiting_external",
			"request_may_have_been_sent",
			"unknown",
			"manual_review",
			"failed",
		],
		terminalStates: ["completed", "cancelled"],
		providerKeys: ["phone_number_id", "stripe_checkout_session_id"],
	},
	{
		relation: "public.whatsapp_phone_release_operations",
		kind: "phone_release_operation",
		stateKey: "status",
		unresolvedStates: [
			"pending",
			"processing",
			"request_may_have_been_sent",
			"unknown",
			"revocation_pending",
			"manual_review",
			"failed",
		],
		terminalStates: ["completed", "cancelled"],
		providerKeys: ["phone_number_id", "source_account_id"],
	},
	{
		relation: "public.ad_creation_operations",
		kind: "ad_creation_operation",
		stateKey: "status",
		unresolvedStates: [
			"pending",
			"processing",
			"request_may_have_been_sent",
			"unknown",
			"reconciling",
			"revocation_pending",
			"manual_review",
			"failed",
		],
		terminalStates: ["completed", "cancelled"],
		providerKeys: [
			"platform_campaign_id",
			"platform_ad_set_id",
			"platform_creative_id",
			"platform_ad_id",
		],
	},
	{
		relation: "public.ad_mutation_operations",
		kind: "ad_mutation_operation",
		stateKey: "status",
		unresolvedStates: [
			"pending",
			"processing",
			"request_may_have_been_sent",
			"unknown",
			"reconciling",
			"revocation_pending",
			"manual_review",
			"failed",
		],
		terminalStates: ["completed", "cancelled"],
		providerKeys: ["target_id"],
	},
	{
		relation: "public.account_revocation_jobs",
		kind: "account_revocation_operation",
		stateKey: "status",
		unresolvedStates: [
			"pending",
			"processing",
			"retry",
			"unknown",
			"manual_required",
		],
		terminalStates: ["succeeded", "abandoned"],
		providerKeys: ["account_id"],
	},
	{
		relation: "public.token_refresh_operations",
		kind: "token_refresh_operation",
		stateKey: "state",
		unresolvedStates: [
			"claimed_pre_request",
			"request_may_have_been_sent",
			"unknown",
		],
		terminalStates: ["succeeded"],
		providerKeys: ["operation_id"],
		localIdKey: "account_id",
	},
	{
		relation: "public.usage_reservations",
		kind: "usage_reservation",
		stateKey: "state",
		unresolvedStates: ["reserved", "parked"],
		terminalStates: ["committed", "released"],
		providerKeys: [],
	},
	{
		relation: "public.publish_outbox",
		kind: "publish_outbox_operation",
		stateKey: "status",
		unresolvedStates: ["pending", "dispatching"],
		terminalStates: ["dispatched"],
		providerKeys: ["operation_id"],
	},
	{
		relation: "public.thread_executions",
		kind: "thread_publish_execution",
		stateKey: "status",
		unresolvedStates: ["queued", "in_flight", "unknown"],
		terminalStates: ["completed", "failed"],
		providerKeys: ["thread_group_id"],
		localIdKey: "thread_group_id",
	},
	{
		relation: "public.queue_failures",
		kind: "queue_failure_resolution",
		stateKey: "status",
		unresolvedStates: ["unresolved", "replay_claimed", "replay_unknown"],
		terminalStates: ["replayed", "dismissed"],
		providerKeys: ["queue_name", "message_id", "operation_id", "failure_kind"],
	},
	{
		relation: "public.post_targets",
		kind: "post_delivery_operation",
		stateKey: "delivery_state",
		unresolvedStates: ["in_flight", "unknown"],
		terminalStates: ["queued", "succeeded", "failed"],
		providerKeys: ["platform_post_id", "provider_operation_id"],
	},
	{
		relation: "public.publish_attempts",
		kind: "publish_attempt",
		stateKey: "state",
		unresolvedStates: ["in_flight", "unknown"],
		terminalStates: ["succeeded", "failed"],
		providerKeys: ["provider_post_id", "provider_operation_id"],
	},
	{
		relation: "public.webhook_deliveries",
		kind: "webhook_delivery",
		stateKey: "status",
		unresolvedStates: [
			"pending",
			"in_flight",
			"failed",
			"unknown",
			"manual_review",
			"unresolved",
		],
		terminalStates: ["succeeded"],
		providerKeys: [],
	},
	{
		relation: "public.inbox_event_effects",
		kind: "inbox_event_effect",
		stateKey: "status",
		unresolvedStates: ["pending", "in_flight", "unknown"],
		terminalStates: ["completed"],
		providerKeys: ["account_id", "platform_event_id", "effect"],
	},
	{
		relation: "public.email_deliveries",
		kind: "email_delivery",
		stateKey: "status",
		unresolvedStates: ["pending", "processing", "unknown", "manual_review"],
		terminalStates: ["sent", "failed"],
		providerKeys: ["provider_message_id"],
	},
	{
		relation: "public.broadcast_recipients",
		kind: "broadcast_delivery",
		stateKey: "delivery_state",
		unresolvedStates: ["pending", "in_flight", "unknown"],
		terminalStates: ["succeeded", "failed", "cancelled"],
		providerKeys: ["message_id"],
	},
	{
		relation: "public.cross_post_actions",
		kind: "cross_post_operation",
		stateKey: "status",
		unresolvedStates: [
			"pending",
			"processing",
			"executing",
			"retry",
			"unknown",
		],
		terminalStates: ["executed", "failed", "cancelled"],
		providerKeys: ["operation_id", "result_post_id"],
	},
	{
		relation: "public.automation_bindings",
		kind: "automation_binding_sync",
		stateKey: "status",
		unresolvedStates: ["pending_sync", "sync_failed"],
		terminalStates: ["active", "paused", "inactive"],
		providerKeys: ["social_account_id", "automation_id"],
	},
	{
		relation: "public.automation_effects",
		kind: "automation_provider_effect",
		stateKey: "status",
		unresolvedStates: ["claimed", "in_flight", "unknown"],
		terminalStates: ["succeeded", "failed"],
		providerKeys: ["provider_idempotency_key", "provider_reference"],
	},
	{
		relation: "public.external_subject_cleanup_jobs",
		kind: "external_subject_cleanup",
		stateKey: "status",
		unresolvedStates: ["pending", "processing", "manual_review"],
		terminalStates: ["completed"],
		providerKeys: ["object_locator", "prefix_locator", "external_provider"],
	},
	{
		relation: "public.short_links",
		kind: "short_link_creation",
		stateKey: "creation_status",
		unresolvedStates: ["pending", "manual_review"],
		terminalStates: ["active"],
		providerKeys: ["short_code", "short_url"],
	},
	{
		relation: "public.tool_jobs",
		kind: "tool_provider_job",
		stateKey: "status",
		unresolvedStates: ["pending", "processing", "manual_review"],
		terminalStates: ["completed", "failed"],
		providerKeys: [],
	},
	{
		relation: "public.tenant_deletion_jobs",
		kind: "tenant_deletion",
		stateKey: "status",
		unresolvedStates: [
			"pending",
			"processing",
			"tombstoned",
			"waiting_external",
			"held",
			"manual_review",
			"failed",
		],
		terminalStates: ["purged"],
		providerKeys: [],
		localIdKey: "organization_id",
	},
	{
		relation: "public.tenant_deletion_steps",
		kind: "tenant_deletion_step",
		stateKey: "status",
		unresolvedStates: ["pending", "processing", "failed", "manual_review"],
		terminalStates: ["completed"],
		providerKeys: [],
	},
	{
		relation: "public.workspace_erasure_jobs",
		kind: "workspace_erasure",
		stateKey: "status",
		unresolvedStates: [
			"pending",
			"processing",
			"held",
			"manual_review",
			"failed",
		],
		terminalStates: ["purged"],
		providerKeys: [],
		localIdKey: "workspace_id",
	},
	{
		relation: "public.workspace_erasure_steps",
		kind: "workspace_erasure_step",
		stateKey: "status",
		unresolvedStates: ["pending", "processing", "failed", "manual_review"],
		terminalStates: ["completed"],
		providerKeys: [],
	},
] as const satisfies readonly ProviderOperationInventoryContract[];

function hasStringValue(row: InventoryRow, key: string): boolean {
	return stringValue(row, key) !== null;
}

export const MONEY_BEARING_INVENTORY_CONTRACTS = [
	{
		relation: "public.organization_subscriptions",
		kind: "stripe_base_subscription",
		stateKey: "status",
		moneyBearingStates: ["trialing", "active", "past_due"],
		nonMoneyBearingStates: ["cancelled"],
		providerKeys: [
			"stripe_customer_id",
			"stripe_checkout_session_id",
			"stripe_subscription_id",
		],
		qualifies: (row) => stringValue(row, "source") === "stripe",
	},
	{
		relation: "public.whatsapp_phone_numbers",
		kind: "whatsapp_phone",
		stateKey: "status",
		moneyBearingStates: [
			"purchasing",
			"pending_verification",
			"verified",
			"active",
			"releasing",
		],
		nonMoneyBearingStates: ["released"],
		providerKeys: [
			"provider_number_id",
			"telnyx_order_id",
			"wa_phone_number_id",
			"stripe_phone_subscription_id",
			"stripe_subscription_item_id",
		],
	},
	{
		relation: "public.whatsapp_phone_billing_operations",
		kind: "applied_phone_billing_commitment",
		stateKey: "state",
		moneyBearingStates: ["applied"],
		nonMoneyBearingStates: [
			"pending",
			"processing",
			"request_may_have_been_sent",
			"unknown",
			"waiting_payment",
			"manual_review",
		],
		providerKeys: STRIPE_PHONE_PROVIDER_KEYS,
		qualifies: (row) =>
			typeof row.applied_quantity === "number" && row.applied_quantity > 0,
	},
	{
		relation: "public.billing_periods",
		kind: "billable_usage_period",
		stateKey: "state",
		moneyBearingStates: ["open", "closed", "claimed", "released"],
		nonMoneyBearingStates: ["settled", "written_off", "void"],
		providerKeys: [
			"stripe_customer_id",
			"stripe_subscription_id",
			"stripe_product_id",
			"stripe_price_id",
			"stripe_invoice_id",
		],
		qualifies: (row) => row.billable === true,
	},
	{
		relation: "public.invoices",
		kind: "open_invoice",
		stateKey: "status",
		moneyBearingStates: ["draft", "finalized"],
		nonMoneyBearingStates: ["paid", "void"],
		providerKeys: ["stripe_invoice_id"],
	},
	{
		relation: "public.ad_campaigns",
		kind: "provider_ad_campaign",
		stateKey: "status",
		moneyBearingStates: ["draft", "pending_review", "active", "paused"],
		nonMoneyBearingStates: ["completed", "rejected", "cancelled"],
		providerKeys: ["platform_campaign_id"],
		qualifies: (row) => hasStringValue(row, "platform_campaign_id"),
	},
	{
		relation: "public.ads",
		kind: "provider_ad",
		stateKey: "status",
		moneyBearingStates: ["draft", "pending_review", "active", "paused"],
		nonMoneyBearingStates: ["completed", "rejected", "cancelled"],
		providerKeys: ["platform_ad_id"],
		qualifies: (row) => hasStringValue(row, "platform_ad_id"),
	},
	{
		relation: "public.ad_creation_operations",
		kind: "partial_provider_ad_creation",
		stateKey: "status",
		moneyBearingStates: [
			"pending",
			"processing",
			"request_may_have_been_sent",
			"unknown",
			"reconciling",
			"revocation_pending",
			"manual_review",
			"failed",
		],
		nonMoneyBearingStates: ["completed", "cancelled"],
		providerKeys: [
			"platform_campaign_id",
			"platform_ad_set_id",
			"platform_creative_id",
			"platform_ad_id",
		],
		qualifies: (row) =>
			[
				"platform_campaign_id",
				"platform_ad_set_id",
				"platform_creative_id",
				"platform_ad_id",
			].some((key) => hasStringValue(row, key)),
	},
] as const satisfies readonly MoneyBearingInventoryContract[];

const GENERATION_ONE_ABSENT_PROVIDER_RELATIONS = new Set<string>([
	"public.billing_operation_attempts",
	"public.whatsapp_phone_billing_operations",
	"public.whatsapp_phone_billing_attempts",
	"public.whatsapp_phone_provisioning_operations",
	"public.whatsapp_phone_release_operations",
	"public.ad_mutation_operations",
	"public.external_subject_cleanup_jobs",
	// Generation 1 created short links synchronously and had no durable
	// creation_status column. Reusing the generation-2 state contract would
	// treat the missing column as an empty relation instead of proving the old
	// shape. The exact catalog assertion below proves this is the reviewed old
	// relation; it has no locally recoverable in-flight operation state.
	"public.short_links",
	"public.tool_jobs",
]);

function generationOneProviderContract(
	contract: ProviderOperationInventoryContract,
): ProviderOperationInventoryContract {
	switch (contract.kind) {
		case "billing_outbox_operation":
			return {
				...contract,
				unresolvedStates: ["pending", "processing", "failed"],
				terminalStates: ["succeeded"],
			};
		case "account_revocation_operation":
			return {
				...contract,
				unresolvedStates: ["pending", "processing", "retry", "manual_required"],
				terminalStates: ["succeeded"],
			};
		case "usage_reservation":
			return {
				...contract,
				unresolvedStates: ["reserved"],
				terminalStates: ["committed", "released"],
			};
		case "ad_creation_operation":
			return {
				...contract,
				unresolvedStates: [
					"pending",
					"processing",
					"request_may_have_been_sent",
					"unknown",
					"reconciling",
					"manual_review",
					"failed",
				],
				terminalStates: ["completed"],
			};
		case "webhook_delivery":
			return {
				...contract,
				unresolvedStates: ["pending", "in_flight", "failed", "unknown"],
				terminalStates: ["succeeded"],
			};
		case "email_delivery":
			return {
				...contract,
				unresolvedStates: ["pending", "unknown"],
				terminalStates: ["sent", "failed"],
			};
		case "tenant_deletion":
			return {
				...contract,
				unresolvedStates: [
					"pending",
					"processing",
					"tombstoned",
					"waiting_external",
					"manual_review",
					"failed",
				],
				terminalStates: ["purged"],
			};
		case "workspace_erasure":
			return {
				...contract,
				unresolvedStates: ["pending", "processing", "manual_review", "failed"],
				terminalStates: ["purged"],
			};
		default:
			return contract;
	}
}

/**
 * The destructive inventory observes the sealed generation-1 catalog, not the
 * generation-2 schema in `src/schema.ts`. Keep the old embedded state machines
 * and settlement authority explicit so a future-only relation cannot look like
 * an empty live relation.
 */
export const GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS = [
	...PROVIDER_OPERATION_INVENTORY_CONTRACTS.filter(
		(contract) =>
			contract.relation !== "public.billing_operations" &&
			!GENERATION_ONE_ABSENT_PROVIDER_RELATIONS.has(contract.relation),
	).map((contract) => generationOneProviderContract(contract)),
	{
		relation: "public.billing_operations",
		kind: "generation_one_billing_operation",
		stateKey: "status",
		unresolvedStates: [
			"pending",
			"processing",
			"failed",
			"unknown",
			"terminal_failed",
		],
		terminalStates: ["succeeded"],
		providerKeys: [
			"stripe_customer_id",
			"stripe_invoice_item_id",
			"usage_bucket_settlement_id",
		],
	},
	{
		relation: "public.usage_bucket_settlements",
		kind: "generation_one_usage_settlement",
		stateKey: "state",
		unresolvedStates: ["claimed"],
		terminalStates: ["settled", "released"],
		providerKeys: ["bucket_id", "invoice_id", "settlement_key"],
	},
	{
		relation: "public.whatsapp_phone_numbers",
		kind: "generation_one_phone_provisioning",
		stateKey: "provisioning_state",
		unresolvedStates: [
			"pending",
			"processing",
			"waiting_external",
			"request_may_have_been_sent",
			"unknown",
			"manual_review",
			"failed",
		],
		terminalStates: ["completed", "cancelled"],
		providerKeys: [
			"provider_number_id",
			"telnyx_order_id",
			"wa_phone_number_id",
			"stripe_checkout_session_id",
			"stripe_subscription_item_id",
			"provisioning_operation_id",
			"provisioning_source_account_id",
		],
	},
	{
		relation: "public.whatsapp_phone_numbers",
		kind: "generation_one_phone_release",
		stateKey: "release_state",
		unresolvedStates: [
			"pending",
			"processing",
			"request_may_have_been_sent",
			"unknown",
			"manual_review",
			"failed",
		],
		terminalStates: ["completed"],
		providerKeys: [
			"provider_number_id",
			"wa_phone_number_id",
			"stripe_subscription_item_id",
			"release_operation_id",
			"release_source_account_id",
			"release_meta_status",
			"release_stripe_status",
			"release_telnyx_status",
		],
		qualifies: (row) =>
			typeof row.release_state === "string" && row.release_state.length > 0,
	},
] satisfies readonly ProviderOperationInventoryContract[];

const GENERATION_ONE_ABSENT_MONEY_RELATIONS = new Set<string>([
	"public.whatsapp_phone_billing_operations",
	"public.billing_periods",
]);

export const GENERATION_ONE_MONEY_BEARING_INVENTORY_CONTRACTS =
	MONEY_BEARING_INVENTORY_CONTRACTS.filter(
		(contract) => !GENERATION_ONE_ABSENT_MONEY_RELATIONS.has(contract.relation),
	).map((sourceContract): MoneyBearingInventoryContract => {
		const contract: MoneyBearingInventoryContract = sourceContract;
		if (contract.kind === "stripe_base_subscription") {
			// Generation 1 predates `source` and checkout-session attribution.
			// Every paid-state row blocks, including a malformed row with no Stripe
			// identity; an empty providerIds list is evidence for manual cleanup, not
			// permission to silently discard it.
			return {
				...contract,
				providerKeys: [
					"stripe_customer_id",
					"stripe_subscription_id",
					"stripe_metered_item_id",
				],
				qualifies: undefined,
			};
		}
		if (contract.kind === "whatsapp_phone") {
			return {
				...contract,
				providerKeys: [
					"provider_number_id",
					"telnyx_order_id",
					"wa_phone_number_id",
					"stripe_checkout_session_id",
					"stripe_subscription_item_id",
				],
			};
		}
		if (contract.kind === "partial_provider_ad_creation") {
			return {
				...contract,
				moneyBearingStates: [
					"pending",
					"processing",
					"request_may_have_been_sent",
					"unknown",
					"reconciling",
					"manual_review",
					"failed",
				],
				nonMoneyBearingStates: ["completed"],
			};
		}
		return contract;
	}) satisfies readonly MoneyBearingInventoryContract[];

export type PreliveDatabaseInventory = {
	schemaVersion: 1;
	targetBaselineGeneration: 2;
	database: string;
	migrationManifestSha256: string;
	catalog: ReturnType<typeof buildCatalogFingerprint>;
	tables: Array<{
		relation: string;
		rowCount: number;
		rowsSha256: string;
	}>;
	sequences: Array<{
		relation: string;
		lastValue: string;
		isCalled: boolean;
	}>;
	moneyBearingReferences: MoneyBearingReference[];
	unresolvedProviderOperations: MoneyBearingReference[];
};

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function identifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nested]) => [key, canonicalize(nested)]),
		);
	}
	return value;
}

export function canonicalDatabaseInventory(
	inventory: PreliveDatabaseInventory,
): string {
	return `${JSON.stringify(canonicalize(inventory), null, 2)}\n`;
}

export function databaseInventorySha256(
	inventory: PreliveDatabaseInventory,
): string {
	return sha256(canonicalDatabaseInventory(inventory));
}

export function assertReviewedGenerationOneCatalog(
	actual: CatalogFingerprint,
	reviewed: CatalogFingerprint,
): void {
	const failures = auditCatalogFingerprint(reviewed);
	if (failures.length > 0) {
		throw new Error(
			`Reviewed generation-1 catalog evidence is invalid:\n- ${failures.join("\n- ")}`,
		);
	}
	if (
		reviewed.source !== "old-chain" ||
		reviewed.generation !== 1 ||
		JSON.stringify(actual) !== JSON.stringify(reviewed)
	) {
		throw new Error(
			`Live database catalog does not match reviewed generation-1 evidence (expected ${reviewed.catalogSha256}, got ${actual.catalogSha256})`,
		);
	}
}

function reviewedGenerationOneCatalog(): CatalogFingerprint {
	return JSON.parse(
		readFileSync(
			new URL(`../${OLD_CHAIN_CATALOG_EVIDENCE_FILE}`, import.meta.url),
			"utf8",
		),
	) as CatalogFingerprint;
}

export function parseDatabaseInventory(
	source: string,
): PreliveDatabaseInventory {
	const inventory = JSON.parse(source) as PreliveDatabaseInventory;
	if (
		inventory.schemaVersion !== 1 ||
		inventory.targetBaselineGeneration !== 2 ||
		!inventory.database ||
		!Array.isArray(inventory.tables) ||
		!Array.isArray(inventory.sequences) ||
		!Array.isArray(inventory.moneyBearingReferences) ||
		!Array.isArray(inventory.unresolvedProviderOperations)
	) {
		throw new Error("Approved database inventory has an invalid shape");
	}
	return inventory;
}

async function tableRows(
	sql: Sql,
	schema: string,
	table: string,
): Promise<Array<Record<string, unknown>>> {
	return sql
		.unsafe<Array<Record<string, unknown>>>(
			`SELECT row_to_json(source_row)::jsonb AS row FROM ${identifier(schema)}.${identifier(table)} AS source_row`,
		)
		.then((rows) => rows.map(({ row }) => row as Record<string, unknown>));
}

async function sequenceState(
	sql: Sql,
	schema: string,
	sequence: string,
): Promise<{ lastValue: string; isCalled: boolean }> {
	const [row] = await sql.unsafe<
		Array<{ last_value: string; is_called: boolean }>
	>(
		`SELECT last_value::text, is_called FROM ${identifier(schema)}.${identifier(sequence)}`,
	);
	if (!row) {
		throw new Error(`Could not inventory sequence ${schema}.${sequence}`);
	}
	return { lastValue: row.last_value, isCalled: row.is_called };
}

function isExcludedCatalogObject(object: {
	kind: string;
	identity: string;
}): boolean {
	return (
		(object.kind === "schema" &&
			object.identity === PRELIVE_INVENTORY_EXCLUDED_SCHEMA) ||
		object.identity.startsWith(`${PRELIVE_INVENTORY_EXCLUDED_SCHEMA}.`)
	);
}

export async function assertLiveResetGuardShape(
	sql: Sql,
	input: { allowAbsent: boolean; catalogObjects?: readonly CatalogObject[] },
): Promise<"absent" | "ready"> {
	const objects = input.catalogObjects ?? (await readCatalog(sql)).objects;
	const signatures = resetGuardCatalogSignatures(objects);
	if (signatures.length === 0) {
		return assertResetGuardCatalogShape(objects, {
			allowAbsent: input.allowAbsent,
			rowCount: null,
		});
	}
	// Validate the exact object allowlist before referencing the sentinel table;
	// a partial or adversarial guard schema must fail with no hidden lookup.
	assertResetGuardCatalogShape(objects, {
		allowAbsent: false,
		rowCount: 1,
	});
	const [count] = await sql.unsafe<Array<{ row_count: number }>>(
		`SELECT count(*)::integer AS row_count FROM ${identifier(PRELIVE_INVENTORY_EXCLUDED_SCHEMA)}.${identifier(PRELIVE_RESET_SENTINEL_TABLE)}`,
	);
	return assertResetGuardCatalogShape(objects, {
		allowAbsent: false,
		rowCount: count?.row_count ?? null,
	});
}

function stringValue(row: Record<string, unknown>, key: string): string | null {
	const value = row[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function reference(
	kind: string,
	row: InventoryRow,
	providerKeys: readonly string[],
	options: {
		localIdKey?: string;
		organizationIdKey?: string;
		stateKey?: string;
	} = {},
): MoneyBearingReference {
	const localIdKey = options.localIdKey ?? "id";
	const localId = stringValue(row, localIdKey);
	if (!localId) throw new Error(`${kind} row is missing its local ID`);
	return {
		kind,
		organizationId: stringValue(
			row,
			options.organizationIdKey ?? "organization_id",
		),
		localId,
		providerIds: [...new Set(providerKeys.map((key) => stringValue(row, key)))]
			.filter((value): value is string => value !== null)
			.sort(),
		status: options.stateKey ? stringValue(row, options.stateKey) : null,
	};
}

function explicitState(
	contract: {
		relation: string;
		kind: string;
		stateKey: string;
	},
	row: InventoryRow,
): string {
	const state = stringValue(row, contract.stateKey);
	if (!state) {
		throw new Error(
			`${contract.relation}.${contract.stateKey} is missing for ${contract.kind}`,
		);
	}
	return state;
}

function assertDisjointStates(
	contract: { relation: string; kind: string },
	blocking: readonly string[],
	terminal: readonly string[],
): void {
	const all = [...blocking, ...terminal];
	if (new Set(all).size !== all.length) {
		throw new Error(
			`${contract.relation} ${contract.kind} inventory states overlap or repeat`,
		);
	}
}

function compareReference(
	left: MoneyBearingReference,
	right: MoneyBearingReference,
): number {
	return `${left.kind}\0${left.organizationId ?? ""}\0${left.localId}`.localeCompare(
		`${right.kind}\0${right.organizationId ?? ""}\0${right.localId}`,
	);
}

export function classifyUnresolvedProviderOperations(
	rowsByTable: InventoryRowsByTable,
	contracts: readonly ProviderOperationInventoryContract[] = PROVIDER_OPERATION_INVENTORY_CONTRACTS,
): MoneyBearingReference[] {
	const references: MoneyBearingReference[] = [];
	for (const sourceContract of contracts) {
		const contract: ProviderOperationInventoryContract = sourceContract;
		assertDisjointStates(
			contract,
			contract.unresolvedStates,
			contract.terminalStates,
		);
		for (const row of rowsByTable.get(contract.relation) ?? []) {
			if (contract.qualifies && !contract.qualifies(row)) continue;
			const state = explicitState(contract, row);
			if (contract.terminalStates.includes(state as never)) continue;
			if (!contract.unresolvedStates.includes(state as never)) {
				throw new Error(
					`${contract.relation}.${contract.stateKey} has unclassified state ${state}`,
				);
			}
			references.push(
				reference(contract.kind, row, contract.providerKeys, {
					localIdKey: contract.localIdKey,
					organizationIdKey: contract.organizationIdKey,
					stateKey: contract.stateKey,
				}),
			);
		}
	}
	return references.sort(compareReference);
}

export function classifyMoneyBearingReferences(
	rowsByTable: InventoryRowsByTable,
	contracts: readonly MoneyBearingInventoryContract[] = MONEY_BEARING_INVENTORY_CONTRACTS,
): MoneyBearingReference[] {
	const references: MoneyBearingReference[] = [];
	for (const sourceContract of contracts) {
		const contract: MoneyBearingInventoryContract = sourceContract;
		if (contract.stateKey) {
			const blocking = contract.moneyBearingStates ?? [];
			const terminal = contract.nonMoneyBearingStates ?? [];
			assertDisjointStates(contract, blocking, terminal);
		}
		for (const row of rowsByTable.get(contract.relation) ?? []) {
			let state: string | undefined;
			if (contract.stateKey) {
				state = explicitState(
					{
						relation: contract.relation,
						kind: contract.kind,
						stateKey: contract.stateKey,
					},
					row,
				);
				if (contract.nonMoneyBearingStates?.includes(state as never)) continue;
				if (!contract.moneyBearingStates?.includes(state as never)) {
					throw new Error(
						`${contract.relation}.${contract.stateKey} has unclassified state ${state}`,
					);
				}
			}
			if (contract.qualifies && !contract.qualifies(row)) continue;
			references.push(
				reference(contract.kind, row, contract.providerKeys, {
					localIdKey: contract.localIdKey,
					organizationIdKey: contract.organizationIdKey,
					stateKey: contract.stateKey,
				}),
			);
		}
	}
	return references.sort(compareReference);
}

export function assertInventoryContractRelations(
	rowsByTable: InventoryRowsByTable,
	providerContracts: readonly ProviderOperationInventoryContract[],
	moneyContracts: readonly MoneyBearingInventoryContract[],
): void {
	const requiredRelations = new Set([
		...providerContracts.map(({ relation }) => relation),
		...moneyContracts.map(({ relation }) => relation),
	]);
	for (const relation of [...requiredRelations].sort()) {
		if (!rowsByTable.has(relation)) {
			throw new Error(
				`Inventory contract relation ${relation} is absent from the live catalog`,
			);
		}
	}
}

function nonnegativeSafeInteger(row: InventoryRow, key: string): number {
	const value = row[key];
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`generation-1 usage bucket has invalid ${key}`);
	}
	return value as number;
}

/**
 * Generation 1 has no billing-period state machine. Its closed or churned
 * overage can exist without any settlement row, and writes can arrive after a
 * settlement closes. A settlement therefore proves coverage only through its
 * immutable committed_units_snapshot; any later units above the larger of the
 * included allowance and that snapshot remain billable and block reset.
 */
export function classifyGenerationOneUnsettledUsageBuckets(
	rowsByTable: InventoryRowsByTable,
): MoneyBearingReference[] {
	for (const relation of [
		"public.usage_bucket_settlements",
		"public.usage_buckets",
	]) {
		if (!rowsByTable.has(relation)) {
			throw new Error(
				`Generation-1 usage authority ${relation} is absent from the live catalog`,
			);
		}
	}
	const settlementsByBucket = new Map<string, InventoryRow>();
	for (const settlement of rowsByTable.get("public.usage_bucket_settlements") ??
		[]) {
		const bucketId = stringValue(settlement, "bucket_id");
		if (!bucketId) {
			throw new Error("generation-1 usage settlement is missing bucket_id");
		}
		if (settlementsByBucket.has(bucketId)) {
			throw new Error(
				`generation-1 usage bucket ${bucketId} has duplicate settlements`,
			);
		}
		settlementsByBucket.set(bucketId, settlement);
	}

	const references: MoneyBearingReference[] = [];
	for (const bucket of rowsByTable.get("public.usage_buckets") ?? []) {
		const bucketId = stringValue(bucket, "id");
		if (!bucketId) throw new Error("generation-1 usage bucket is missing id");
		const metric = stringValue(bucket, "metric");
		if (metric !== "successful_mutation") {
			throw new Error(
				`generation-1 usage bucket ${bucketId} has unclassified metric ${metric ?? "<missing>"}`,
			);
		}
		const committed = nonnegativeSafeInteger(bucket, "committed_units");
		const included = nonnegativeSafeInteger(bucket, "included_units");
		const settlement = settlementsByBucket.get(bucketId);
		const settlementState = settlement
			? explicitState(
					{
						relation: "public.usage_bucket_settlements",
						kind: "generation_one_usage_settlement",
						stateKey: "state",
					},
					settlement,
				)
			: null;
		const coveredThrough = settlement
			? Math.max(
					included,
					nonnegativeSafeInteger(settlement, "committed_units_snapshot"),
				)
			: included;
		if (committed <= coveredThrough) continue;

		const providerIds = settlement
			? [
					stringValue(settlement, "id"),
					stringValue(settlement, "invoice_id"),
					stringValue(settlement, "settlement_key"),
				].filter((value): value is string => value !== null)
			: [];
		references.push({
			kind: "generation_one_unsettled_overage_bucket",
			organizationId: stringValue(bucket, "organization_id"),
			localId: bucketId,
			providerIds: [...new Set(providerIds)].sort(),
			status: settlementState ?? "unclaimed",
		});
	}
	return references.sort(compareReference);
}

export function classifyGenerationOneLegacyUsageRecords(
	rowsByTable: InventoryRowsByTable,
): MoneyBearingReference[] {
	const relation = "public.usage_records";
	if (!rowsByTable.has(relation)) {
		throw new Error(
			`Generation-1 legacy usage authority ${relation} is absent from the live catalog`,
		);
	}
	const references: MoneyBearingReference[] = [];
	for (const row of rowsByTable.get(relation) ?? []) {
		const postsCount = nonnegativeSafeInteger(row, "posts_count");
		const postsIncluded = nonnegativeSafeInteger(row, "posts_included");
		const overagePosts = nonnegativeSafeInteger(row, "overage_posts");
		const mutationCost = nonnegativeSafeInteger(
			row,
			"overage_calls_cost_cents",
		);
		const mutationCount = nonnegativeSafeInteger(row, "api_calls_count");
		const mutationIncluded = nonnegativeSafeInteger(row, "api_calls_included");
		const overageCalls = nonnegativeSafeInteger(row, "overage_calls");
		const legacyPostCost = nonnegativeSafeInteger(row, "overage_cost_cents");
		if (row.billed_at !== null && typeof row.billed_at !== "string") {
			throw new Error("generation-1 legacy usage record has invalid billed_at");
		}
		const hasOverage =
			mutationCost > 0 ||
			legacyPostCost > 0 ||
			overageCalls > 0 ||
			overagePosts > 0 ||
			mutationCount > mutationIncluded ||
			postsCount > postsIncluded;
		if (!hasOverage) continue;
		const localId = stringValue(row, "id");
		if (!localId) {
			throw new Error(
				"generation-1 legacy usage record is missing its local ID",
			);
		}
		// Generation 1 set billed_at even when no Stripe customer was present and
		// retained no invoice/item identity. The timestamp is not collection proof;
		// exact cleanup-to-zero requires manual reconciliation of every overage.
		references.push({
			kind: "generation_one_legacy_overage",
			organizationId: stringValue(row, "organization_id"),
			localId,
			providerIds: [],
			status: row.billed_at === null ? "unbilled" : "billed_marker_untrusted",
		});
	}
	return references.sort(compareReference);
}

export async function captureDatabaseInventoryOnTransaction(
	sql: Sql,
	input: {
		expectedDatabase: string;
		manifest: MigrationManifest;
		manifestText: string;
	},
): Promise<PreliveDatabaseInventory> {
	await assertDatabaseIdentity(sql, input.expectedDatabase);
	await assertSupportedPostgres(sql);
	await verifyLiveMigrationHistory(sql, input.manifest, {
		requireCurrent: true,
	});
	const liveCatalog = await readCatalog(sql);
	await assertLiveResetGuardShape(sql, {
		allowAbsent: true,
		catalogObjects: liveCatalog.objects,
	});
	const catalog = buildCatalogFingerprint({
		source: "old-chain",
		generation: 1,
		postgresMajor: liveCatalog.postgresMajor,
		migrationManifestSha256: sha256(input.manifestText),
		objects: liveCatalog.objects.filter(
			(object) => !isExcludedCatalogObject(object),
		),
	});
	assertReviewedGenerationOneCatalog(catalog, reviewedGenerationOneCatalog());
	const relations = await sql<
		Array<{ schema_name: string; relation_name: string; relation_kind: string }>
	>`
		SELECT
			namespace_row.nspname AS schema_name,
			relation_row.relname AS relation_name,
			relation_row.relkind::text AS relation_kind
		FROM pg_catalog.pg_class AS relation_row
		JOIN pg_catalog.pg_namespace AS namespace_row
			ON namespace_row.oid = relation_row.relnamespace
		WHERE namespace_row.nspname !~ '^pg_'
			AND namespace_row.nspname <> 'information_schema'
			AND namespace_row.nspname <> ${PRELIVE_INVENTORY_EXCLUDED_SCHEMA}
			AND relation_row.relkind IN ('r', 'p', 'S')
		ORDER BY namespace_row.nspname, relation_row.relname
	`;
	const tables: PreliveDatabaseInventory["tables"] = [];
	const sequences: PreliveDatabaseInventory["sequences"] = [];
	const rowsByTable = new Map<string, InventoryRow[]>();
	const sequenceCoordinates: Array<{ schema: string; sequence: string }> = [];
	for (const relation of relations) {
		const name = `${relation.schema_name}.${relation.relation_name}`;
		if (relation.relation_kind === "S") {
			const sequence = await sequenceState(
				sql,
				relation.schema_name,
				relation.relation_name,
			);
			sequences.push({
				relation: name,
				...sequence,
			});
			sequenceCoordinates.push({
				schema: relation.schema_name,
				sequence: relation.relation_name,
			});
			continue;
		}
		const rows = await tableRows(
			sql,
			relation.schema_name,
			relation.relation_name,
		);
		const serializedRows = rows
			.map((row) => JSON.stringify(canonicalize(row)))
			.sort();
		const hasher = createHash("sha256");
		for (const serialized of serializedRows) {
			hasher.update(String(Buffer.byteLength(serialized)));
			hasher.update(":");
			hasher.update(serialized);
			hasher.update("\n");
		}
		tables.push({
			relation: name,
			rowCount: rows.length,
			rowsSha256: hasher.digest("hex"),
		});
		rowsByTable.set(name, rows);
	}
	for (let index = 0; index < sequenceCoordinates.length; index += 1) {
		const coordinate = sequenceCoordinates[index];
		const expected = sequences[index];
		if (!coordinate || !expected) {
			throw new Error("Sequence inventory lost its canonical ordering");
		}
		const observed = await sequenceState(
			sql,
			coordinate.schema,
			coordinate.sequence,
		);
		if (
			observed.lastValue !== expected.lastValue ||
			observed.isCalled !== expected.isCalled
		) {
			throw new Error(
				`Sequence ${expected.relation} changed while the inventory snapshot was captured`,
			);
		}
	}

	assertInventoryContractRelations(
		rowsByTable,
		GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS,
		GENERATION_ONE_MONEY_BEARING_INVENTORY_CONTRACTS,
	);
	const moneyBearingReferences = [
		...classifyMoneyBearingReferences(
			rowsByTable,
			GENERATION_ONE_MONEY_BEARING_INVENTORY_CONTRACTS,
		),
		...classifyGenerationOneUnsettledUsageBuckets(rowsByTable),
		...classifyGenerationOneLegacyUsageRecords(rowsByTable),
	].sort(compareReference);
	const unresolvedProviderOperations = classifyUnresolvedProviderOperations(
		rowsByTable,
		GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS,
	);
	return {
		schemaVersion: 1,
		targetBaselineGeneration: 2,
		database: input.expectedDatabase,
		migrationManifestSha256: sha256(input.manifestText),
		catalog,
		tables,
		sequences,
		moneyBearingReferences,
		unresolvedProviderOperations,
	};
}

export async function captureDatabaseInventory(
	sql: Sql,
	input: {
		expectedDatabase: string;
		manifest: MigrationManifest;
		manifestText: string;
	},
): Promise<PreliveDatabaseInventory> {
	return sql.begin(
		"isolation level repeatable read read only",
		async (transaction) =>
			captureDatabaseInventoryOnTransaction(
				transaction as unknown as Sql,
				input,
			),
	);
}

async function main(): Promise<void> {
	const command = process.argv[2];
	const connectionString = required(CONNECTION_ENV);
	const expectedDatabase = required("PRELIVE_EXPECTED_DATABASE");
	const manifestPath = required("PRELIVE_EXPECTED_LEDGER_MANIFEST");
	const manifestText = readFileSync(manifestPath, "utf8");
	const manifest = JSON.parse(manifestText) as MigrationManifest;
	const sql = postgres(connectionString, {
		max: 1,
		prepare: false,
		connect_timeout: 15,
		idle_timeout: 20,
	});
	try {
		if (command === "capture") {
			const inventory = await captureDatabaseInventory(sql, {
				expectedDatabase,
				manifest,
				manifestText,
			});
			const output = required("PRELIVE_DATABASE_INVENTORY_OUTPUT");
			writeFileSync(output, canonicalDatabaseInventory(inventory), {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			console.log(
				JSON.stringify({
					event: "prelive_database_inventory_captured",
					sha256: databaseInventorySha256(inventory),
					money_bearing_count: inventory.moneyBearingReferences.length,
					unresolved_provider_operation_count:
						inventory.unresolvedProviderOperations.length,
					output,
				}),
			);
			return;
		}
		if (command === "verify") {
			const inputPath = required("PRELIVE_APPROVED_DATABASE_INVENTORY");
			const expectedSource = readFileSync(inputPath, "utf8");
			const expected = parseDatabaseInventory(expectedSource);
			const expectedSha256 = required(
				"PRELIVE_APPROVED_DATABASE_INVENTORY_SHA256",
			);
			if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
				throw new Error("Approved database inventory SHA-256 is invalid");
			}
			if (sha256(expectedSource) !== expectedSha256) {
				throw new Error(
					"Approved database inventory file digest does not match",
				);
			}
			const actual = await captureDatabaseInventory(sql, {
				expectedDatabase,
				manifest,
				manifestText,
			});
			if (
				canonicalDatabaseInventory(actual) !==
				canonicalDatabaseInventory(expected)
			) {
				throw new Error(
					`Live database inventory changed; expected ${expectedSha256}, got ${databaseInventorySha256(actual)}`,
				);
			}
			if (
				expected.moneyBearingReferences.length > 0 ||
				expected.unresolvedProviderOperations.length > 0
			) {
				throw new Error(
					"Database inventory still contains money-bearing resources or unresolved provider operations",
				);
			}
			console.log(
				JSON.stringify({
					event: "prelive_database_inventory_verified",
					sha256: expectedSha256,
				}),
			);
			return;
		}
		throw new Error(
			"Usage: bun run scripts/prelive-database-inventory.ts capture|verify",
		);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

if (import.meta.main) await main();
