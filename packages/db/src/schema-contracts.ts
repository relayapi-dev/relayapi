/**
 * Machine-readable tenancy contract. This is intentionally independent of the
 * Drizzle objects so API policy checks and catalog verification can consume it
 * without creating schema initialization cycles.
 */
export type SchemaScopeClass =
	| "operational_root"
	| "scoped_child"
	| "shared_definition"
	| "organization_definition"
	| "audit_evidence"
	| "tombstone";

export type SchemaScopeContract = {
	tableName: string;
	class: SchemaScopeClass;
	/** Whether Require Workspace ID blocks new organization-scoped rows. */
	requireWorkspacePolicy: boolean;
	/** Parent whose exact scope is authoritative for a child, when applicable. */
	scopeParent?: string;
	/**
	 * Audit evidence may deliberately detach its nullable workspace locator when
	 * that workspace is erased while retaining tenant-scoped minimized evidence.
	 */
	workspaceDetachOnDelete?: boolean;
	notes?: string;
};

export const SCHEMA_SCOPE_CONTRACTS = [
	{
		tableName: "social_accounts",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "telegram_connection_challenges",
		class: "audit_evidence",
		requireWorkspacePolicy: false,
		notes:
			"Ephemeral connection workflow state records the initiating API key and immutable grant snapshot so an unauthenticated bot event cannot choose or expand tenant scope.",
	},
	{
		tableName: "external_subject_cleanup_jobs",
		class: "tombstone",
		requireWorkspacePolicy: false,
		notes:
			"Typed external-erasure intent deliberately outlives the user/contact/account/workspace/organization row and therefore carries nullable tombstone locators without ownership FKs.",
	},
	{
		tableName: "principal_workspace_grants",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "organization_principals",
		notes:
			"Exact selected-workspace authority for a stable principal; all-scope principals have no grant rows.",
	},
	{
		tableName: "invite_token_workspaces",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "invite_tokens",
		notes:
			"Immutable selected-workspace invitation evidence copied into durable principal grants at redemption.",
	},
	{
		tableName: "post_threads",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "posts",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "thread_executions",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "post_threads",
	},
	{
		tableName: "post_targets",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "posts",
	},
	{
		tableName: "cross_post_actions",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "post_targets",
	},
	{
		tableName: "media",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "webhook_endpoints",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "webhook_events",
		class: "audit_evidence",
		requireWorkspacePolicy: false,
		notes:
			"An occurrence is an outbox root; deliveries, not events, reference endpoints.",
	},
	{
		tableName: "inbox_conversations",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "inbox_messages",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "inbox_conversations",
	},
	{
		tableName: "auto_post_rules",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "custom_field_definitions",
		class: "shared_definition",
		requireWorkspacePolicy: false,
	},
	{
		tableName: "custom_field_values",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "contacts",
	},
	{
		tableName: "contacts",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "contact_channels",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "contacts",
	},
	{
		tableName: "contact_consent_events",
		class: "audit_evidence",
		requireWorkspacePolicy: false,
		workspaceDetachOnDelete: true,
		notes:
			"Exact-scope history may outlive a later strict-mode toggle; workspace erasure detaches the nullable locator while retaining minimized tenant consent evidence.",
	},
	{
		tableName: "contact_consent_states",
		class: "audit_evidence",
		requireWorkspacePolicy: false,
		workspaceDetachOnDelete: true,
		notes:
			"The current denial/grant authority detaches its nullable workspace locator during workspace erasure so consent enforcement survives subject deletion.",
	},
	{
		tableName: "broadcasts",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "broadcast_recipients",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "broadcasts",
	},
	{
		tableName: "ad_accounts",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "ad_campaigns",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "ad_accounts",
	},
	{
		tableName: "ads",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "ad_campaigns",
	},
	{
		tableName: "ad_creation_operations",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "ad_accounts",
	},
	{
		tableName: "ad_audiences",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "external_posts",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "social_accounts",
	},
	{
		tableName: "ad_sync_logs",
		class: "audit_evidence",
		requireWorkspacePolicy: false,
		scopeParent: "ad_accounts",
	},
	{
		tableName: "social_account_sync_state",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "social_accounts",
	},
	{
		tableName: "content_templates",
		class: "shared_definition",
		requireWorkspacePolicy: false,
	},
	{
		tableName: "signatures",
		class: "shared_definition",
		requireWorkspacePolicy: false,
	},
	{
		tableName: "short_links",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "tags",
		class: "shared_definition",
		requireWorkspacePolicy: false,
	},
	{
		tableName: "idea_groups",
		class: "shared_definition",
		requireWorkspacePolicy: false,
	},
	{
		tableName: "ideas",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "idea_conversion_operations",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "ideas",
	},
	{
		tableName: "idea_media",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "ideas",
	},
	{
		tableName: "idea_tags",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "ideas",
	},
	{
		tableName: "post_tags",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "posts",
	},
	{
		tableName: "automations",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "automation_entrypoints",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "automations",
	},
	{
		tableName: "automation_entrypoint_daily_counts",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "automation_entrypoints",
	},
	{
		tableName: "automation_bindings",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "automations",
	},
	{
		tableName: "automation_runs",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "automations",
	},
	{
		tableName: "automation_conversion_events",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "automation_runs",
	},
	{
		tableName: "automation_node_executions",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "automation_runs",
	},
	{
		tableName: "automation_effects",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "automation_node_executions",
	},
	{
		tableName: "automation_step_runs",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "automation_runs",
		notes:
			"Longer-lived public timeline rows carry a composite run/automation/tenant/scope tuple so analytical denormalization cannot drift from the run.",
	},
	{
		tableName: "automation_scheduled_jobs",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "automation_runs|automation_entrypoints",
		notes:
			"The checked parent union selects exactly one authoritative run or entrypoint tuple; both project the same automation, tenant, and scope identity.",
	},
	{
		tableName: "segments",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "contact_segment_memberships",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "segments",
	},
	{
		tableName: "subscription_lists",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "queue_schedules",
		class: "organization_definition",
		requireWorkspacePolicy: false,
		notes:
			"Organization-global posting schedule authority; KV is a bounded read cache only.",
	},
	{
		tableName: "contact_subscriptions",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "subscription_lists",
	},
	{
		tableName: "contact_subscription_events",
		class: "audit_evidence",
		requireWorkspacePolicy: false,
		scopeParent: "subscription_lists",
		notes:
			"Immutable list-membership transition evidence; consent remains a separate send-time authority.",
	},
	{
		tableName: "ai_knowledge_bases",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "ai_knowledge_documents",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "ai_knowledge_bases",
	},
	{
		tableName: "ai_knowledge_chunks",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "ai_knowledge_documents",
	},
	{
		tableName: "ai_agents",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "ref_urls",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "qr_codes",
		class: "scoped_child",
		requireWorkspacePolicy: false,
		scopeParent: "ref_urls",
	},
	{
		tableName: "landing_pages",
		class: "operational_root",
		requireWorkspacePolicy: true,
	},
	{
		tableName: "public_growth_events",
		class: "audit_evidence",
		requireWorkspacePolicy: false,
		notes:
			"Discriminated ref/QR/landing occurrence and durable dispatch state; exact scope is constrained through the selected target.",
	},
	{
		tableName: "workspace_erasure_jobs",
		class: "audit_evidence",
		requireWorkspacePolicy: false,
		notes:
			"Durable erasure state intentionally survives deletion of its workspace row.",
	},
	{
		tableName: "workspace_erasure_steps",
		class: "audit_evidence",
		requireWorkspacePolicy: false,
		scopeParent: "workspace_erasure_jobs",
	},
	{
		tableName: "workspace_tombstones",
		class: "tombstone",
		requireWorkspacePolicy: false,
	},
] as const satisfies readonly SchemaScopeContract[];

export const REQUIRE_WORKSPACE_OPERATIONAL_ROOTS =
	SCHEMA_SCOPE_CONTRACTS.filter(
		(contract) => contract.requireWorkspacePolicy,
	).map((contract) => contract.tableName);

/**
 * Explicit decisions for columns which look like durable workflow state or a
 * high-risk numeric value but intentionally do not have a closed-domain or
 * range CHECK. Keep this list small: the schema invariant audit rejects stale
 * exceptions once a database constraint is added.
 */
export type SchemaInvariantCategory = "workflow_state" | "high_risk_numeric";

export type SchemaInvariantException = {
	tableName: string;
	columnName: string;
	category: SchemaInvariantCategory;
	rationale: string;
	owner: string;
	reviewedAt: string;
	reviewExpiresAt: string;
};

export const SCHEMA_INVARIANT_EXCEPTIONS = [
	{
		tableName: "ad_accounts",
		columnName: "status",
		category: "workflow_state",
		rationale:
			"Provider account statuses are retained verbatim; closing this domain requires a normalized local lifecycle column and data migration.",
		owner: "data-governance",
		reviewedAt: "2026-07-28",
		reviewExpiresAt: "2027-07-28",
	},
	{
		tableName: "ad_audiences",
		columnName: "status",
		category: "workflow_state",
		rationale:
			"Provider audience lifecycle statuses are passthrough values and are not a RelayAPI-owned state machine.",
		owner: "data-governance",
		reviewedAt: "2026-07-28",
		reviewExpiresAt: "2027-07-28",
	},
	{
		tableName: "automation_entrypoints",
		columnName: "priority",
		category: "high_risk_numeric",
		rationale:
			"Priority is intentionally signed and unbounded; lower values sort before higher values and negative priorities are valid.",
		owner: "data-governance",
		reviewedAt: "2026-07-28",
		reviewExpiresAt: "2027-07-28",
	},
	{
		tableName: "post_targets",
		columnName: "provider_state",
		category: "workflow_state",
		rationale:
			"Provider lifecycle strings are retained verbatim as diagnostic evidence; RelayAPI's closed lifecycle is provider_disposition.",
		owner: "data-governance",
		reviewedAt: "2026-07-28",
		reviewExpiresAt: "2027-07-28",
	},
	{
		tableName: "publish_attempts",
		columnName: "provider_state",
		category: "workflow_state",
		rationale:
			"Attempt evidence preserves the provider's raw status vocabulary while provider_disposition owns the constrained local lifecycle.",
		owner: "data-governance",
		reviewedAt: "2026-07-28",
		reviewExpiresAt: "2027-07-28",
	},
] as const satisfies readonly SchemaInvariantException[];
