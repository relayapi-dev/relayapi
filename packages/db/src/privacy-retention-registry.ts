/**
 * Source-owned privacy and retention inventory.
 *
 * PostgreSQL coverage is enforced against the exported Drizzle schema in
 * `privacy-retention-registry.test.ts`. External entries name logical stores,
 * not merely bindings, because one physical namespace can contain key families
 * with materially different payload and expiry rules.
 */

import { EXTERNAL_PROVIDER_RETENTION_CONTRACTS } from "./external-provider-retention-registry";
import {
	GOVERNANCE_REVIEW_EXPIRES_AT,
	GOVERNANCE_REVIEWED_AT,
	validateGovernanceReview,
} from "./governance-review";
import {
	POSTGRES_PRIVACY_FIELD_CLASSIFICATIONS,
	PRIVACY_FIELD_CLASSES,
	type PrivacyFieldClass,
} from "./postgres-privacy-field-classifications";

export {
	KV_PRIVACY_KEY_PREFIX_BY_STORE_ID,
	type KvPrivacyStoreId,
} from "./kv-key-contracts";
export {
	POSTGRES_PRIVACY_FIELD_CLASSIFICATIONS,
	PRIVACY_FIELD_CLASSES,
	type PrivacyFieldClass,
} from "./postgres-privacy-field-classifications";

export type PrivacyStoreKind =
	| "postgres"
	| "r2"
	| "kv"
	| "queue"
	| "workers_logs"
	| "durable_object"
	| "edge_cache"
	| "browser_egress"
	| "external_provider";

export type RetentionRowPolicy =
	| "entity_lifetime"
	| "parent_lifetime"
	| "ttl_delete"
	| "field_redaction"
	| "retained_record"
	| "remove_after_replacement"
	| "no_persistent_records";

/**
 * Names which system makes a retention promise executable. PostgreSQL
 * `scheduled` stores must have a bounded, indexed application drain.
 */
export type RetentionExecution =
	| "scheduled"
	| "lifecycle"
	| "provider"
	| "none";

/**
 * `pause` preserves the registered store while a target hold is active.
 * `minimize` keeps only non-secret evidence and never pauses secret shredding.
 * `never` lets the ordinary expiry/deletion clock continue unchanged.
 */
export type LegalHoldTreatment = "pause" | "minimize" | "never";

export type PrivacySubjectLocator =
	| "organization"
	| "workspace"
	| "user"
	| "contact"
	| "account"
	| "parent"
	| "shared_organizations"
	| "none";

export type PrivacyPurgeMechanism =
	| "foreign_key"
	| "explicit_delete"
	| "field_redaction"
	| "array_owner_removal"
	| "prefix_delete"
	| "exact_key_delete"
	| "ttl"
	| "provider_delete"
	| "retained_receipt"
	| "none";

export interface PrivacyRetentionField {
	readonly column: string;
	readonly class: PrivacyFieldClass;
	readonly subjectLocator?: PrivacySubjectLocator;
	readonly action?: PrivacyPurgeMechanism;
	readonly retention?: string;
	readonly reviewedAt: string;
	readonly reviewExpiresAt: string;
}

export interface PrivacyRetentionStore {
	readonly id: string;
	readonly kind: PrivacyStoreKind;
	readonly rowPolicy: RetentionRowPolicy;
	readonly retentionExecution: RetentionExecution;
	readonly subjects: readonly PrivacySubjectLocator[];
	readonly purge: PrivacyPurgeMechanism;
	readonly legalHold: LegalHoldTreatment;
	/** Columns or payload fields that must keep their ordinary shred clock. */
	readonly secretFields: readonly string[];
	/** True when a hold must not lengthen the store's existing maximum TTL. */
	readonly ephemeral: boolean;
	readonly retention: string;
	readonly owner: string;
	readonly reviewedAt: string;
	readonly reviewExpiresAt: string;
	/** Required and exact for every PostgreSQL physical column. */
	readonly fields?: readonly PrivacyRetentionField[];
	readonly physicalResource?: string;
}

export interface PostgresPrivacyRetentionStore extends PrivacyRetentionStore {
	readonly kind: "postgres";
	readonly fields: readonly PrivacyRetentionField[];
}

type StorePolicy = Omit<PrivacyRetentionStore, "id" | "kind">;
type StorePolicyInput = Omit<StorePolicy, "reviewedAt" | "reviewExpiresAt"> &
	Partial<Pick<StorePolicy, "reviewedAt" | "reviewExpiresAt">>;

const REVIEWED_AT = GOVERNANCE_REVIEWED_AT;
const REVIEW_EXPIRES_AT = GOVERNANCE_REVIEW_EXPIRES_AT;
const DATA_GOVERNANCE_OWNER = "data-governance";
const PLATFORM_OWNER = "platform";

function defineStores(
	kind: PrivacyStoreKind,
	ids: readonly string[],
	policy: StorePolicyInput,
): PrivacyRetentionStore[] {
	return ids.map((id) => ({
		id,
		kind,
		...policy,
		reviewedAt: policy.reviewedAt ?? REVIEWED_AT,
		reviewExpiresAt: policy.reviewExpiresAt ?? REVIEW_EXPIRES_AT,
	}));
}

function postgresStores(
	ids: readonly string[],
	policy: Omit<StorePolicyInput, "reviewedAt" | "reviewExpiresAt">,
): Omit<PostgresPrivacyRetentionStore, "fields">[] {
	return ids.map((id) => ({
		id: `postgres:${id}`,
		kind: "postgres",
		...policy,
		reviewedAt: REVIEWED_AT,
		reviewExpiresAt: REVIEW_EXPIRES_AT,
	}));
}

function postgresFields(
	store: Omit<PostgresPrivacyRetentionStore, "fields">,
): PrivacyRetentionField[] {
	const classification =
		POSTGRES_PRIVACY_FIELD_CLASSIFICATIONS[
			store.id as keyof typeof POSTGRES_PRIVACY_FIELD_CLASSIFICATIONS
		];
	if (!classification) {
		throw new Error(
			`Missing PostgreSQL privacy field classification: ${store.id}`,
		);
	}
	const fields: PrivacyRetentionField[] = [];
	for (const fieldClass of PRIVACY_FIELD_CLASSES) {
		const columns =
			(
				classification.columns as Readonly<
					Partial<Record<PrivacyFieldClass, readonly string[]>>
				>
			)[fieldClass] ?? [];
		for (const column of columns) {
			const reviewed = {
				reviewedAt: store.reviewedAt,
				reviewExpiresAt: store.reviewExpiresAt,
			};
			fields.push(
				fieldClass === "non_personal"
					? { column, class: fieldClass, ...reviewed }
					: {
							column,
							class: fieldClass,
							subjectLocator: classification.subjectLocator,
							action: store.purge,
							retention: store.retention,
							...reviewed,
						},
			);
		}
	}
	return fields;
}

const POSTGRES_EPHEMERAL_STORES = postgresStores(
	[
		"auth.session",
		"auth.verification",
		"public.automation_webhook_receipts",
		"public.idempotency_receipts",
		"public.one_time_capabilities",
		"public.operator_resolution_notes",
		"public.telegram_connection_challenges",
		"public.tool_jobs",
	],
	{
		rowPolicy: "ttl_delete",
		retentionExecution: "scheduled",
		subjects: ["organization", "user", "parent"],
		purge: "ttl",
		legalHold: "never",
		secretFields: ["token_or_payload"],
		ephemeral: true,
		retention: "Exact expiry; total drain; no legal-hold extension.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_NONSECRET_EPHEMERAL_STORES = postgresStores(
	["auth.organization_creation_reservation"],
	{
		rowPolicy: "ttl_delete",
		retentionExecution: "scheduled",
		subjects: ["user"],
		purge: "ttl",
		legalHold: "never",
		secretFields: [],
		ephemeral: true,
		retention: "Exact ten-minute expiry with a total drain.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_CREDENTIAL_STORES = postgresStores(
	["auth.account", "auth.apikey", "public.automation_secrets"],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "lifecycle",
		subjects: ["organization", "user", "parent"],
		purge: "field_redaction",
		legalHold: "never",
		secretFields: ["credential_material"],
		ephemeral: false,
		retention:
			"Active credential lifetime; revoke and shred on unlink or erase.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_USER_SCOPED_NEVER_HELD = postgresStores(
	["public.notification_preferences", "public.user_preferences"],
	{
		rowPolicy: "remove_after_replacement",
		retentionExecution: "lifecycle",
		subjects: ["user", "organization"],
		purge: "foreign_key",
		legalHold: "never",
		secretFields: [],
		ephemeral: false,
		retention:
			"User lifetime, or remove when the canonical replacement is authoritative.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_ROOT_ENTITIES = postgresStores(
	["auth.organization", "public.workspaces"],
	{
		rowPolicy: "entity_lifetime",
		retentionExecution: "lifecycle",
		subjects: ["organization", "workspace"],
		purge: "explicit_delete",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention: "Entity lifetime; typed tenant/workspace erasure.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_USER_IDENTITY = postgresStores(["auth.user"], {
	rowPolicy: "field_redaction",
	retentionExecution: "lifecycle",
	subjects: ["user"],
	purge: "field_redaction",
	legalHold: "never",
	secretFields: [],
	ephemeral: false,
	retention:
		"Account lifetime; erase direct identity and retain only justified pseudonymous audit references.",
	owner: DATA_GOVERNANCE_OWNER,
});

const POSTGRES_HOLD_ELIGIBLE_CONTROL_STATE = postgresStores(
	[
		"auth.member",
		"public.organization_principals",
		"public.organization_settings",
		"public.principal_workspace_grants",
		"public.tenant_deletion_jobs",
		"public.workspace_erasure_jobs",
	],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "lifecycle",
		subjects: ["organization", "workspace", "user"],
		purge: "field_redaction",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention:
			"Raw while active/held; redact terminal workflow detail and retain the minimum transition receipt.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_TIMED_ERASURE_STEPS = postgresStores(
	["public.tenant_deletion_steps", "public.workspace_erasure_steps"],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "scheduled",
		subjects: ["organization", "workspace", "user"],
		purge: "field_redaction",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention:
			"Raw while active/held; redact terminal step detail on the bounded post-completion clock.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_MINIMIZED_CONTROL_STATE = postgresStores(
	["auth.invitation", "public.invite_token_workspaces", "public.invite_tokens"],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "scheduled",
		subjects: ["organization", "workspace", "user"],
		purge: "field_redaction",
		legalHold: "minimize",
		secretFields: ["token_hash_or_invitation_capability"],
		ephemeral: false,
		retention:
			"Active until expiry; never retain usable invitation capability material.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_RETAINED_PRIVACY_RECEIPTS = postgresStores(
	["public.erasure_holds"],
	{
		rowPolicy: "retained_record",
		retentionExecution: "scheduled",
		subjects: ["organization", "workspace"],
		purge: "retained_receipt",
		legalHold: "never",
		secretFields: ["evidence_ciphertext"],
		ephemeral: false,
		retention:
			"Minimal transition receipt survives; legal-hold evidence follows its own post-release redaction clock.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_OPERATOR_AUDIT_EVIDENCE = postgresStores(
	["public.operator_resolution_evidence"],
	{
		rowPolicy: "retained_record",
		retentionExecution: "none",
		subjects: ["organization", "workspace", "user", "account", "parent"],
		purge: "retained_receipt",
		legalHold: "never",
		secretFields: [],
		ephemeral: false,
		retention:
			"Append-only, tombstone-compatible operator decision evidence; no provider payloads or credentials are stored.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_TOMBSTONE_RECEIPTS = postgresStores(
	["public.workspace_tombstones"],
	{
		rowPolicy: "retained_record",
		retentionExecution: "none",
		subjects: ["organization", "workspace"],
		purge: "retained_receipt",
		legalHold: "never",
		secretFields: [],
		ephemeral: false,
		retention:
			"PII-free authorization receipt retained for the named service lifetime.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_MIXED_CREDENTIAL_ENTITIES = postgresStores(
	["public.social_accounts", "public.webhook_endpoints"],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "lifecycle",
		subjects: ["organization", "workspace", "account", "parent"],
		purge: "field_redaction",
		legalHold: "minimize",
		secretFields: ["credential_ciphertext_or_provider_token"],
		ephemeral: false,
		retention:
			"Entity/evidence may remain, but credentials, checkout URLs, and grants shred on their normal clock.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_BYOS_CREDENTIALS = postgresStores(
	["public.storage_credentials"],
	{
		rowPolicy: "entity_lifetime",
		retentionExecution: "lifecycle",
		subjects: ["organization", "parent"],
		purge: "explicit_delete",
		legalHold: "minimize",
		secretFields: ["access_key_id", "secret_access_key"],
		ephemeral: false,
		retention:
			"Encrypted credential versions remain only while a pinned media object or unresolved storage-cleanup attempt needs that exact historical authority; delete after the final pin drains, and delete every version after tenant prefix cleanup.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_SHORT_LINK_CREDENTIALS = postgresStores(
	["public.short_link_credentials"],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "lifecycle",
		subjects: ["organization", "parent"],
		purge: "field_redaction",
		legalHold: "never",
		secretFields: ["api_key_ciphertext"],
		ephemeral: false,
		retention:
			"Versioned provider authority remains only while active configuration, an existing short link, or an unresolved external deletion intent pins that version; shred the API key on retirement after the final pin drains and on tenant erasure.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_TIMED_CREDENTIAL_EVIDENCE = postgresStores(
	[
		"public.account_revocation_jobs",
		"public.whatsapp_phone_release_operations",
	],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "scheduled",
		subjects: ["organization", "workspace", "account", "parent"],
		purge: "field_redaction",
		legalHold: "minimize",
		secretFields: ["credential_ciphertext_or_provider_token"],
		ephemeral: false,
		retention:
			"Provider-bound credentials shred on the fixed terminal clock; only minimized operation evidence may remain. A non-null durable usage-reservation link is child provenance: tenant erasure deletes the operation first, and ordinary usage retention defers the parent reservation until that operation is deleted or unlinked.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_ENTITY_CONTENT = postgresStores(
	[
		"public.ad_accounts",
		"public.ad_audiences",
		"public.ad_campaigns",
		"public.ads",
		"public.ai_agents",
		"public.ai_knowledge_bases",
		"public.ai_knowledge_chunks",
		"public.auto_post_rules",
		"public.automation_contact_controls",
		"public.automation_entrypoints",
		"public.automations",
		"public.content_templates",
		"public.custom_field_definitions",
		"public.custom_field_values",
		"public.idea_groups",
		"public.idea_media",
		"public.idea_tags",
		"public.ideas",
		"public.landing_pages",
		"public.media",
		"public.org_streaks",
		"public.post_recycling_configs",
		"public.post_tags",
		"public.post_threads",
		"public.posts",
		"public.qr_codes",
		"public.queue_schedules",
		"public.ref_urls",
		"public.segments",
		"public.short_link_configs",
		"public.short_links",
		"public.signatures",
		"public.storage_locations",
		"public.subscription_lists",
		"public.tags",
		"public.whatsapp_phone_numbers",
	],
	{
		rowPolicy: "entity_lifetime",
		retentionExecution: "lifecycle",
		subjects: ["organization", "workspace", "contact", "parent"],
		purge: "explicit_delete",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention: "Entity or authoritative parent lifetime.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_TIMED_ENTITY_EVIDENCE = postgresStores(
	[
		"public.ai_knowledge_documents",
		"public.automation_bindings",
		"public.automation_conversion_events",
		"public.broadcasts",
		"public.external_posts",
		"public.publish_outbox",
	],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "scheduled",
		subjects: ["organization", "workspace", "contact", "parent"],
		purge: "field_redaction",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention:
			"Entity-adjacent payload, failure detail, or terminal evidence follows its explicit bounded minimization/deletion clock.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_CONTACT_PROFILE_CONTENT = postgresStores(
	["public.contact_channels", "public.contacts"],
	{
		rowPolicy: "entity_lifetime",
		retentionExecution: "lifecycle",
		subjects: ["organization", "workspace", "contact", "parent"],
		purge: "explicit_delete",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention:
			"Contact lifetime or tenant erasure. Names, email addresses, phone numbers, channel identifiers, and metadata are stored as AES-GCM ciphertext; equality and substring lookup use tenant-scoped HMAC hashes/blind indexes. Explicit erasure withdraws consent, minimizes dependent operational content, and deletes the profile unless an active tenant/workspace hold pauses it.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_INBOX_CONTENT = postgresStores(
	[
		"public.inbox_conversation_notes",
		"public.inbox_conversations",
		"public.inbox_messages",
	],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "scheduled",
		subjects: ["organization", "workspace", "contact", "parent"],
		purge: "field_redaction",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention:
			"Profile, preview, message, attachment, platform, and note content is minimized 90 days after close; contact erasure minimizes immediately. Exact participant-avatar cleanup is durable and independently retried.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_EXTERNAL_SUBJECT_CLEANUP = postgresStores(
	["public.external_subject_cleanup_jobs"],
	{
		rowPolicy: "ttl_delete",
		retentionExecution: "scheduled",
		subjects: ["organization", "workspace", "user", "contact", "account"],
		purge: "explicit_delete",
		legalHold: "never",
		secretFields: ["credential_ciphertext"],
		ephemeral: false,
		retention:
			"Durable exact-key, prefix, Queue-rescue, or external short-link deletion intent until completion. Short-link credentials are copied only so cleanup can survive tenant deletion and are cleared immediately on success. Deadline/unsupported/ambiguous outcomes enter operator-visible manual review; completed tombstone detail is deleted after 90 days.",
		owner: PLATFORM_OWNER,
	},
);

const POSTGRES_RETENTION_DRAIN_CONTROL = postgresStores(
	["public.retention_drain_runs"],
	{
		rowPolicy: "retained_record",
		retentionExecution: "lifecycle",
		subjects: ["none"],
		purge: "none",
		legalHold: "never",
		secretFields: [],
		ephemeral: false,
		retention:
			"Exactly one non-personal control row per executable retention handler. In-place fenced state preserves cursor progress, bounded backlog age, and manual-review escalation without accumulating run history.",
		owner: PLATFORM_OWNER,
	},
);

const POSTGRES_COLLABORATIVE_CONTENT = postgresStores(
	["public.idea_comments"],
	{
		rowPolicy: "entity_lifetime",
		retentionExecution: "lifecycle",
		subjects: ["organization", "workspace", "user", "parent"],
		purge: "explicit_delete",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention:
			"Idea lifetime; user erasure retires the linked principal to a pseudonymous actor without deleting shared comment content.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_BOUNDED_CONTENT = postgresStores(
	[
		"public.ad_metrics",
		"public.post_analytics",
		"public.webhook_deliveries",
		"public.webhook_events",
		"public.webhook_logs",
	],
	{
		rowPolicy: "ttl_delete",
		retentionExecution: "scheduled",
		subjects: ["organization", "workspace", "parent"],
		purge: "explicit_delete",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention:
			"Bounded analytical/delivery history; absent a hold, each customer-webhook review is at most 90 days, at most one audited retry can start one final bounded review, terminal history drains after 7 days, and analytics is 25 months.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_OPERATIONAL_EVIDENCE = postgresStores(
	[
		"public.ad_creation_operations",
		"public.ad_mutation_operations",
		"public.ad_sync_logs",
		"public.api_request_logs",
		"public.auto_post_feed_items",
		"public.automation_effects",
		"public.automation_node_executions",
		"public.automation_runs",
		"public.automation_scheduled_jobs",
		"public.automation_step_runs",
		"public.broadcast_recipients",
		"public.connection_logs",
		"public.cross_post_actions",
		"public.idea_activity",
		"public.idea_conversion_operations",
		"public.inbox_event_effects",
		"public.notifications",
		"public.publish_attempts",
		"public.recycling_occurrences",
		"public.social_account_sync_state",
		"public.thread_executions",
		"public.token_refresh_operations",
		"public.whatsapp_phone_provisioning_operations",
	],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "scheduled",
		subjects: [
			"organization",
			"workspace",
			"user",
			"contact",
			"account",
			"parent",
		],
		purge: "field_redaction",
		legalHold: "minimize",
		secretFields: [],
		ephemeral: false,
		retention:
			"Raw operational detail 30–90 days; minimized outcome up to one year where justified. For operation rows with a non-null durable usage-reservation link, tenant erasure deletes the operation first and ordinary usage retention defers the parent reservation until the operation is deleted or unlinked.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_PARENT_OPERATIONAL_STATE = postgresStores(
	[
		"public.ad_audience_users",
		"public.contact_segment_memberships",
		"public.contact_subscription_events",
		"public.contact_subscriptions",
		"public.post_targets",
		"public.stripe_organization_leases",
		"public.whatsapp_phone_billing_attempts",
		"public.whatsapp_phone_billing_operations",
	],
	{
		rowPolicy: "parent_lifetime",
		retentionExecution: "lifecycle",
		subjects: [
			"organization",
			"workspace",
			"user",
			"contact",
			"account",
			"parent",
		],
		purge: "foreign_key",
		legalHold: "minimize",
		secretFields: [],
		ephemeral: false,
		retention:
			"Authoritative parent or membership lifetime; explicit erasure and parent deletion own removal. Phone add-on authority and immutable revisions are first reduced to one detached seven-year financial receipt digest.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_AUTOMATION_DAILY_COUNTS = postgresStores(
	["public.automation_entrypoint_daily_counts"],
	{
		rowPolicy: "ttl_delete",
		retentionExecution: "scheduled",
		subjects: ["organization", "workspace", "parent"],
		purge: "explicit_delete",
		legalHold: "minimize",
		secretFields: [],
		ephemeral: false,
		retention:
			"UTC date admission counter; bounded oldest-first deletion after 90 days unless an active organization/workspace hold preserves the minimized aggregate receipt.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_EMAIL_DELIVERIES = postgresStores(["public.email_deliveries"], {
	rowPolicy: "field_redaction",
	retentionExecution: "scheduled",
	subjects: ["organization", "user"],
	purge: "field_redaction",
	legalHold: "minimize",
	secretFields: ["envelope_ciphertext"],
	ephemeral: false,
	retention:
		"Identifier-only Queue handoff; encrypted envelope 30 days, minimized delivery receipt 90 days, then delete unless an active organization hold retains that minimal receipt.",
	owner: DATA_GOVERNANCE_OWNER,
});

const POSTGRES_CONSENT_EVIDENCE = postgresStores(
	["public.contact_consent_events"],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "scheduled",
		subjects: ["organization", "workspace", "contact"],
		purge: "field_redaction",
		legalHold: "minimize",
		secretFields: [],
		ephemeral: false,
		retention:
			"Immutable transition evidence; redact contact, mask, and free-form evidence at most two years after supersession or on approved subject erasure.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_CONSENT_AUTHORITY = postgresStores(
	["public.contact_consent_states"],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "lifecycle",
		subjects: ["organization", "workspace", "contact"],
		purge: "field_redaction",
		legalHold: "minimize",
		secretFields: [],
		ephemeral: false,
		retention:
			"Current grant while its contact exists; minimized denied HMAC authority until explicit grant or organization deletion.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_PUBLIC_GROWTH_EVIDENCE = postgresStores(
	["public.public_growth_events"],
	{
		rowPolicy: "ttl_delete",
		retentionExecution: "scheduled",
		subjects: ["organization", "workspace", "contact", "parent"],
		purge: "explicit_delete",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention:
			"Anonymous terminal occurrences 7 days; identified/outbox detail 90 days; aggregate counters survive on the owning ref URL, QR placement, or landing page.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_SHARED_RECEIPTS = postgresStores(
	["public.inbound_webhook_events"],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "scheduled",
		subjects: ["shared_organizations"],
		purge: "array_owner_removal",
		legalHold: "minimize",
		secretFields: ["encrypted_payload"],
		ephemeral: false,
		retention:
			"7/30/90-day payload clocks; remove one owner or retain minimized shared receipt.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_QUEUE_FAILURE_RECEIPTS = postgresStores(
	["public.queue_failures"],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "scheduled",
		subjects: [
			"shared_organizations",
			"workspace",
			"user",
			"contact",
			"account",
		],
		purge: "array_owner_removal",
		legalHold: "minimize",
		secretFields: ["encrypted_payload"],
		ephemeral: false,
		retention:
			"Application-encrypted replay payload shredded at 30 days even under hold; typed-locator receipt deleted at 90 days unless an active organization/workspace hold preserves only the minimized receipt.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_FINANCIAL_CURRENT_STATE = postgresStores(
	["public.organization_subscriptions"],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "lifecycle",
		subjects: ["organization"],
		purge: "field_redaction",
		legalHold: "minimize",
		secretFields: [],
		ephemeral: false,
		retention:
			"Active entitlement lifetime; history belongs in canonical financial evidence.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_FINANCIAL_CAPABILITIES = postgresStores(
	["public.subscription_checkout_operations"],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "scheduled",
		subjects: ["organization"],
		purge: "field_redaction",
		legalHold: "minimize",
		secretFields: ["checkout_url"],
		ephemeral: false,
		retention: "Redact checkout URL at expiry; terminal operation 90 days.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_FINANCIAL_EVIDENCE = postgresStores(
	[
		"public.billing_operation_attempts",
		"public.billing_operations",
		"public.billing_outbox",
		"public.billing_periods",
		"public.dunning_events",
		"public.stripe_events",
	],
	{
		rowPolicy: "field_redaction",
		retentionExecution: "scheduled",
		subjects: ["organization", "parent"],
		purge: "field_redaction",
		legalHold: "minimize",
		secretFields: [],
		ephemeral: false,
		retention:
			"Operational payload, provider identifiers, customer identifiers, errors, and responses drain after 90 days for resolved rows; unknown, manual-review, and terminal-failed billing operations remain until explicit resolution or write-off, and manual-review Stripe receipts remain until retry or audited abandonment. Billing-period authority remains through its 25-month usage-detail horizon. Successful and operator-abandoned Stripe payloads are redacted immediately. Stripe rows carry immutable set-once tenant attribution without a cascading FK, so tenant erasure deterministically receipts and deletes historical raw events before current billing authority is purged. Only normalized financial receipts and append-only operator evidence survive resolved-row pruning.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_FINANCIAL_RETAINED_RECEIPTS = postgresStores(
	["public.financial_retention_receipts"],
	{
		rowPolicy: "retained_record",
		retentionExecution: "scheduled",
		subjects: ["organization", "parent"],
		purge: "retained_receipt",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention:
			"Immutable, no-JSON minimized evidence: financial facts seven years, usage aggregates 25 months, and global SHA-256 Stripe receipts one year. Provider references and external source IDs are digests; active holds pause only this minimized row.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_FINANCIAL_INVOICES = postgresStores(["public.invoices"], {
	rowPolicy: "field_redaction",
	retentionExecution: "scheduled",
	subjects: ["organization"],
	purge: "field_redaction",
	legalHold: "minimize",
	secretFields: ["stripe_hosted_url"],
	ephemeral: false,
	retention:
		"Hosted invoice URL redacts after 90 days even under hold; normalized invoice evidence remains for seven years and deletion pauses under an active organization hold.",
	owner: DATA_GOVERNANCE_OWNER,
});

const POSTGRES_FINANCIAL_USAGE_RECORDS = postgresStores(
	["public.usage_buckets", "public.usage_reservations"],
	{
		rowPolicy: "retained_record",
		retentionExecution: "scheduled",
		subjects: ["organization"],
		purge: "retained_receipt",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention:
			"Jurisdiction/operator policy (default invoice evidence seven years; usage detail 25 months). At expiry, committed/released reservations detach every durable provider-operation link in the same locked transaction before deletion; reserved/parked rows remain pinned with their unresolved provenance.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_FINANCIAL_USAGE_LINKS = postgresStores(
	["public.usage_reservation_carryovers"],
	{
		rowPolicy: "parent_lifetime",
		retentionExecution: "lifecycle",
		subjects: ["organization", "parent"],
		purge: "foreign_key",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention:
			"Settlement-aware allowance evidence follows both its source reservation and successor bucket. Tenant erasure refuses unresolved predecessors and materializes the effective aggregate before this edge is deleted child-first; ordinary 25-month usage retention then removes it with either parent.",
		owner: DATA_GOVERNANCE_OWNER,
	},
);

const POSTGRES_PRIVACY_RETENTION_BASE_STORES: readonly Omit<
	PostgresPrivacyRetentionStore,
	"fields"
>[] = [
	...POSTGRES_EPHEMERAL_STORES,
	...POSTGRES_NONSECRET_EPHEMERAL_STORES,
	...POSTGRES_CREDENTIAL_STORES,
	...POSTGRES_USER_SCOPED_NEVER_HELD,
	...POSTGRES_ROOT_ENTITIES,
	...POSTGRES_USER_IDENTITY,
	...POSTGRES_HOLD_ELIGIBLE_CONTROL_STATE,
	...POSTGRES_TIMED_ERASURE_STEPS,
	...POSTGRES_MINIMIZED_CONTROL_STATE,
	...POSTGRES_RETAINED_PRIVACY_RECEIPTS,
	...POSTGRES_OPERATOR_AUDIT_EVIDENCE,
	...POSTGRES_TOMBSTONE_RECEIPTS,
	...POSTGRES_MIXED_CREDENTIAL_ENTITIES,
	...POSTGRES_BYOS_CREDENTIALS,
	...POSTGRES_SHORT_LINK_CREDENTIALS,
	...POSTGRES_TIMED_CREDENTIAL_EVIDENCE,
	...POSTGRES_ENTITY_CONTENT,
	...POSTGRES_TIMED_ENTITY_EVIDENCE,
	...POSTGRES_CONTACT_PROFILE_CONTENT,
	...POSTGRES_INBOX_CONTENT,
	...POSTGRES_EXTERNAL_SUBJECT_CLEANUP,
	...POSTGRES_RETENTION_DRAIN_CONTROL,
	...POSTGRES_COLLABORATIVE_CONTENT,
	...POSTGRES_BOUNDED_CONTENT,
	...POSTGRES_CONSENT_EVIDENCE,
	...POSTGRES_CONSENT_AUTHORITY,
	...POSTGRES_OPERATIONAL_EVIDENCE,
	...POSTGRES_PARENT_OPERATIONAL_STATE,
	...POSTGRES_AUTOMATION_DAILY_COUNTS,
	...POSTGRES_EMAIL_DELIVERIES,
	...POSTGRES_PUBLIC_GROWTH_EVIDENCE,
	...POSTGRES_SHARED_RECEIPTS,
	...POSTGRES_QUEUE_FAILURE_RECEIPTS,
	...POSTGRES_FINANCIAL_CURRENT_STATE,
	...POSTGRES_FINANCIAL_CAPABILITIES,
	...POSTGRES_FINANCIAL_EVIDENCE,
	...POSTGRES_FINANCIAL_RETAINED_RECEIPTS,
	...POSTGRES_FINANCIAL_INVOICES,
	...POSTGRES_FINANCIAL_USAGE_LINKS,
	...POSTGRES_FINANCIAL_USAGE_RECORDS,
];

export const POSTGRES_PRIVACY_RETENTION_STORES: readonly PostgresPrivacyRetentionStore[] =
	POSTGRES_PRIVACY_RETENTION_BASE_STORES.map((store) => ({
		...store,
		fields: postgresFields(store),
	}));

const R2_PRIVACY_RETENTION_STORES = [
	...defineStores("r2", ["r2:api.MEDIA_BUCKET"], {
		rowPolicy: "entity_lifetime",
		retentionExecution: "provider",
		subjects: ["organization", "workspace", "contact", "parent"],
		purge: "prefix_delete",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention:
			"Original media policy with typed owner/region/key locator; contact/conversation exact-key deletion is durably retried, with infrastructure fallback about 30 days.",
		owner: PLATFORM_OWNER,
		reviewedAt: REVIEWED_AT,
		physicalResource: "relayapi-media",
	}),
	...defineStores("r2", ["r2:api.AVATAR_BUCKET"], {
		rowPolicy: "entity_lifetime",
		retentionExecution: "lifecycle",
		subjects: ["organization", "account"],
		purge: "prefix_delete",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention: "Account profile lifetime; account/{id}/ prefix deletion.",
		owner: PLATFORM_OWNER,
		reviewedAt: REVIEWED_AT,
		physicalResource: "relayapi-avatars",
	}),
	...defineStores("r2", ["r2:app.AVATARS_BUCKET"], {
		rowPolicy: "entity_lifetime",
		retentionExecution: "lifecycle",
		subjects: ["organization", "user"],
		purge: "prefix_delete",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention:
			"User/organization profile lifetime; typed user/{id} and organization/{id} prefixes.",
		owner: PLATFORM_OWNER,
		reviewedAt: REVIEWED_AT,
		physicalResource: "relayapi-avatars",
	}),
	...defineStores("r2", ["r2:api.THUMBNAIL_BUCKET"], {
		rowPolicy: "parent_lifetime",
		retentionExecution: "lifecycle",
		subjects: ["organization", "workspace", "parent"],
		purge: "prefix_delete",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention: "Media metadata lifetime; explicit owner/region/key locator.",
		owner: PLATFORM_OWNER,
		reviewedAt: REVIEWED_AT,
		physicalResource: "relayapi-media-thumbnails",
	}),
	...defineStores(
		"r2",
		["r2:api.QUEUE_RESCUE_BUCKET", "r2:app.QUEUE_RESCUE_BUCKET"],
		{
			rowPolicy: "ttl_delete",
			retentionExecution: "provider",
			subjects: ["organization", "workspace", "shared_organizations"],
			purge: "ttl",
			legalHold: "never",
			secretFields: ["encrypted_queue_envelope"],
			ephemeral: true,
			retention: "30-day maximum; application attempt 40 is terminal.",
			owner: PLATFORM_OWNER,
			reviewedAt: REVIEWED_AT,
			physicalResource: "relayapi-queue-rescue-ledger",
		},
	),
	...defineStores("r2", ["r2:app.PUBLIC_ASSETS"], {
		rowPolicy: "entity_lifetime",
		retentionExecution: "none",
		subjects: ["none"],
		purge: "none",
		legalHold: "never",
		secretFields: [],
		ephemeral: false,
		retention: "Immutable build assets only; tenant uploads are forbidden.",
		owner: PLATFORM_OWNER,
		reviewedAt: REVIEWED_AT,
		physicalResource: "relayapi-public-assets",
	}),
];

const KV_CREDENTIAL_AND_ONE_TIME_STORES = defineStores(
	"kv",
	[
		"kv:apikey",
		"kv:dashboard-key",
		"kv:pending-oauth",
		"kv:pending-secondary",
		"kv:r2-presign",
	],
	{
		rowPolicy: "ttl_delete",
		retentionExecution: "provider",
		subjects: ["organization", "workspace", "user", "account"],
		purge: "ttl",
		legalHold: "never",
		secretFields: ["credential_or_capability"],
		ephemeral: true,
		retention:
			"One-time or short TTL plus explicit invalidation; never authoritative.",
		owner: PLATFORM_OWNER,
		reviewedAt: REVIEWED_AT,
	},
);

const KV_RUNTIME_CONTROL_STORES = defineStores(
	"kv",
	["kv:maintenance-control"],
	{
		rowPolicy: "entity_lifetime",
		retentionExecution: "lifecycle",
		subjects: ["none"],
		purge: "exact_key_delete",
		legalHold: "never",
		secretFields: [],
		ephemeral: false,
		retention:
			"Authoritative, non-personal deployment safety control at control:maintenance:v1; preserve across application-cache clears and replace or delete only through the baseline cutover procedure.",
		owner: PLATFORM_OWNER,
		reviewedAt: REVIEWED_AT,
	},
);

const KV_DERIVED_CACHE_STORES = defineStores(
	"kv",
	[
		"kv:ad-discovery",
		"kv:analytics-overview",
		"kv:analytics-posts",
		"kv:best-time",
		"kv:billing-invoice-discovery-cursor",
		"kv:ig-sender-id",
		"kv:inbox-comments",
		"kv:inbox-posts",
		"kv:msg-dedup",
		"kv:org-settings",
		"kv:org-summary",
		"kv:outbound-mid",
		"kv:platform-account",
		"kv:queue-schedule",
		"kv:short-link",
		"kv:sync-dedup",
		"kv:token-refresh-notified",
		"kv:usage",
		"kv:usage-warning",
		"kv:ws-valid",
	],
	{
		rowPolicy: "ttl_delete",
		retentionExecution: "provider",
		subjects: ["organization", "workspace", "account", "parent"],
		purge: "ttl",
		legalHold: "never",
		secretFields: [],
		ephemeral: true,
		retention:
			"Finite TTL and owner invalidation; PostgreSQL remains authoritative.",
		owner: PLATFORM_OWNER,
		reviewedAt: REVIEWED_AT,
	},
);

const QUEUE_FAMILIES = [
	"media-cleanup",
	"publish",
	"email",
	"refresh",
	"inbox",
	"tools",
	"ads",
	"sync",
	"customer-webhooks",
] as const;

const QUEUE_PRIVACY_RETENTION_STORES = [
	...defineStores(
		"queue",
		QUEUE_FAMILIES.map((family) => `queue:main:${family}`),
		{
			rowPolicy: "ttl_delete",
			retentionExecution: "provider",
			subjects: ["organization", "workspace", "parent"],
			purge: "ttl",
			legalHold: "never",
			secretFields: ["message_envelope"],
			ephemeral: true,
			retention: "Identifier-only messages; at most 24 hours.",
			owner: PLATFORM_OWNER,
			reviewedAt: REVIEWED_AT,
		},
	),
	...defineStores(
		"queue",
		QUEUE_FAMILIES.map((family) => `queue:dlq:${family}`),
		{
			rowPolicy: "ttl_delete",
			retentionExecution: "provider",
			subjects: ["organization", "workspace", "parent"],
			purge: "ttl",
			legalHold: "never",
			secretFields: ["message_envelope"],
			ephemeral: true,
			retention: "Identifier-only messages; at most 24 hours.",
			owner: PLATFORM_OWNER,
			reviewedAt: REVIEWED_AT,
		},
	),
	...defineStores("queue", ["queue:rescue"], {
		rowPolicy: "ttl_delete",
		retentionExecution: "provider",
		subjects: ["organization", "workspace", "parent"],
		purge: "ttl",
		legalHold: "never",
		secretFields: ["message_envelope"],
		ephemeral: true,
		retention:
			"Application-encrypted rescue envelope; at most 24 hours; terminal at application attempt 40 with no self-handoff.",
		owner: PLATFORM_OWNER,
		reviewedAt: REVIEWED_AT,
	}),
];

const INFRASTRUCTURE_PRIVACY_RETENTION_STORES = [
	...defineStores("workers_logs", ["workers_logs:api", "workers_logs:app"], {
		rowPolicy: "ttl_delete",
		retentionExecution: "provider",
		subjects: ["none"],
		purge: "ttl",
		legalHold: "never",
		secretFields: [],
		ephemeral: true,
		retention:
			"Cloudflare-owned sampled retention; allowlisted structured fields only.",
		owner: PLATFORM_OWNER,
		reviewedAt: REVIEWED_AT,
	}),
	...defineStores("workers_logs", ["workers_logs:docs"], {
		rowPolicy: "ttl_delete",
		retentionExecution: "provider",
		subjects: ["none"],
		purge: "ttl",
		legalHold: "never",
		secretFields: [],
		ephemeral: true,
		retention:
			"Cloudflare-owned sampled framework logs; automatic invocation logs are disabled and the docs Worker exposes no authenticated application routes.",
		owner: PLATFORM_OWNER,
		reviewedAt: REVIEWED_AT,
	}),
	...defineStores("durable_object", ["durable_object:RealtimeDO"], {
		rowPolicy: "no_persistent_records",
		retentionExecution: "none",
		subjects: ["organization"],
		purge: "none",
		legalHold: "never",
		secretFields: [],
		ephemeral: true,
		retention: "WebSocket hibernation only; ctx.storage must remain unused.",
		owner: PLATFORM_OWNER,
		reviewedAt: REVIEWED_AT,
	}),
];

const EXTERNAL_PROVIDER_PRIVACY_RETENTION_STORES =
	EXTERNAL_PROVIDER_RETENTION_CONTRACTS.map<PrivacyRetentionStore>(
		(contract) => ({
			id: `external_provider:${contract.id}`,
			kind: "external_provider",
			rowPolicy: "field_redaction",
			retentionExecution: "provider",
			subjects: ["organization", "workspace", "user", "contact", "account"],
			purge: "provider_delete",
			legalHold: "minimize",
			secretFields: ["provider_credentials"],
			ephemeral: false,
			retention: `${contract.retentionBoundary} ${contract.remoteAction}`,
			owner: contract.owner,
			reviewedAt: contract.reviewedAt,
			reviewExpiresAt: contract.reviewExpiresAt,
			physicalResource: contract.provider,
		}),
	);

export const EXTERNAL_PRIVACY_RETENTION_STORES: readonly PrivacyRetentionStore[] =
	[
		...R2_PRIVACY_RETENTION_STORES,
		...KV_CREDENTIAL_AND_ONE_TIME_STORES,
		...KV_RUNTIME_CONTROL_STORES,
		...KV_DERIVED_CACHE_STORES,
		...QUEUE_PRIVACY_RETENTION_STORES,
		...INFRASTRUCTURE_PRIVACY_RETENTION_STORES,
		...EXTERNAL_PROVIDER_PRIVACY_RETENTION_STORES,
	];

export const PRIVACY_RETENTION_STORES: readonly PrivacyRetentionStore[] = [
	...POSTGRES_PRIVACY_RETENTION_STORES,
	...EXTERNAL_PRIVACY_RETENTION_STORES,
];

const PRIVACY_RETENTION_STORE_BY_ID = new Map(
	PRIVACY_RETENTION_STORES.map((store) => [store.id, store]),
);

export function getPrivacyRetentionStore(
	id: string,
): PrivacyRetentionStore | undefined {
	return PRIVACY_RETENTION_STORE_BY_ID.get(id);
}

export function validatePostgresPrivacyFieldColumns(
	store: PrivacyRetentionStore,
	physicalColumns: readonly string[],
): string[] {
	const errors: string[] = [];
	const classified = store.fields?.map((field) => field.column) ?? [];
	const physical = new Set(physicalColumns);
	const seen = new Set<string>();
	for (const column of classified) {
		if (seen.has(column)) {
			errors.push(`${store.id} has duplicate privacy field: ${column}`);
		}
		seen.add(column);
		if (!physical.has(column)) {
			errors.push(`${store.id} classifies unknown physical column: ${column}`);
		}
	}
	for (const column of physicalColumns) {
		if (!seen.has(column)) {
			errors.push(`${store.id} is missing privacy field: ${column}`);
		}
	}
	return errors;
}

export function validatePrivacyRetentionRegistry(
	stores: readonly PrivacyRetentionStore[] = PRIVACY_RETENTION_STORES,
): string[] {
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const store of stores) {
		if (seen.has(store.id)) errors.push(`Duplicate privacy store: ${store.id}`);
		seen.add(store.id);
		if (store.ephemeral && store.legalHold !== "never") {
			errors.push(
				`${store.id} is ephemeral but legalHold=${store.legalHold}; holds cannot extend ephemera`,
			);
		}
		if (store.secretFields.length > 0 && store.legalHold === "pause") {
			errors.push(
				`${store.id} contains secrets but legalHold=pause; use minimize or never`,
			);
		}
		if (
			store.legalHold === "pause" &&
			!store.subjects.includes("organization") &&
			!store.subjects.includes("workspace") &&
			!store.subjects.includes("parent")
		) {
			errors.push(`${store.id} can pause without a tenant/workspace locator`);
		}
		if (store.retention.trim().length === 0) {
			errors.push(`${store.id} has no retention contract`);
		}
		errors.push(...validateGovernanceReview(store.id, store));
		if (store.kind === "postgres") {
			if (!store.fields || store.fields.length === 0) {
				errors.push(`${store.id} has no physical-column privacy fields`);
			} else {
				const fieldColumns = new Set<string>();
				for (const field of store.fields) {
					const label = `${store.id}.${field.column}`;
					if (fieldColumns.has(field.column)) {
						errors.push(
							`${store.id} has duplicate privacy field: ${field.column}`,
						);
					}
					fieldColumns.add(field.column);
					if (!PRIVACY_FIELD_CLASSES.includes(field.class)) {
						errors.push(`${label} has an invalid privacy class`);
					}
					if (field.column.trim().length === 0) {
						errors.push(`${store.id} has a privacy field with no column`);
					}
					if (field.class === "non_personal") {
						if (
							field.subjectLocator !== undefined ||
							field.action !== undefined ||
							field.retention !== undefined
						) {
							errors.push(
								`${label} is non_personal but declares personal-data handling`,
							);
						}
					} else if (
						!field.subjectLocator ||
						field.subjectLocator === "none" ||
						!field.action ||
						!field.retention?.trim()
					) {
						errors.push(
							`${label} must declare subjectLocator, action, and retention`,
						);
					}
					errors.push(
						...validateGovernanceReview(
							label,
							{
								owner: store.owner,
								reviewedAt: field.reviewedAt,
								reviewExpiresAt: field.reviewExpiresAt,
							},
							new Date(),
						),
					);
					const reviewedAt = new Date(`${field.reviewedAt}T00:00:00.000Z`);
					if (!Number.isNaN(reviewedAt.getTime()) && reviewedAt > new Date()) {
						errors.push(`${label} reviewedAt is in the future`);
					}
				}
			}
		}
		if (
			!["scheduled", "lifecycle", "provider", "none"].includes(
				store.retentionExecution,
			)
		) {
			errors.push(`${store.id} has no valid retention execution authority`);
		}
		if (store.kind === "postgres" && store.retentionExecution === "provider") {
			errors.push(
				`${store.id} is PostgreSQL-backed but delegates retention to a provider`,
			);
		}
		if (
			store.kind === "postgres" &&
			store.rowPolicy === "ttl_delete" &&
			store.retentionExecution !== "scheduled"
		) {
			errors.push(
				`${store.id} promises PostgreSQL TTL deletion without a scheduled drain`,
			);
		}
		if (
			store.rowPolicy === "no_persistent_records" &&
			store.retentionExecution !== "none"
		) {
			errors.push(
				`${store.id} has no persistent records but declares retention execution`,
			);
		}
	}
	return errors;
}
