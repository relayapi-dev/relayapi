import { REQUIRE_WORKSPACE_OPERATIONAL_ROOTS } from "./schema-contracts";

/**
 * Non-declarative database objects that Drizzle cannot express in schema.ts.
 * The migration and live-catalog verifiers use these names so regeneration
 * cannot silently drop organization onboarding invariants.
 */
export const ORGANIZATION_PROVISIONING_CONTRACT = {
	functionSchema: "public",
	functionName: "provision_organization_defaults",
	triggerName: "provision_organization_defaults_after_insert",
	organizationSchema: "auth",
	organizationTable: "organization",
	settingsTable: "organization_settings",
	workspaceTable: "workspaces",
	ideaGroupTable: "idea_groups",
	initialWorkspaceName: "General",
	defaultIdeaGroupName: "Unassigned",
} as const;

/**
 * Scope/workspace copies on child rows are database projections, not caller
 * authority. PostgreSQL fills these fields before NOT NULL, generated-column,
 * and exact-scope foreign-key checks run. This keeps inserts ergonomic while
 * still making cross-scope references impossible.
 */
export const PARENT_IDENTITY_PROJECTION_FUNCTION = {
	functionSchema: "public",
	functionName: "project_parent_identity",
} as const;

export type ParentIdentityProjection = {
	childTable: string;
	triggerName: string;
	parentTable: string;
	childParentColumn: string;
	projections: readonly {
		parentColumn: string;
		childColumn: string;
	}[];
};

function projection(
	childTable: string,
	parentTable: string,
	childParentColumn: string,
	projections: ParentIdentityProjection["projections"],
): ParentIdentityProjection {
	return {
		childTable,
		triggerName: `project_${childTable}_${childParentColumn}`.slice(0, 63),
		parentTable,
		childParentColumn,
		projections,
	};
}

const workspaceProjection = [
	{ parentColumn: "workspace_id", childColumn: "workspace_id" },
] as const;
const scopeProjection = [
	{ parentColumn: "scope_key", childColumn: "scope_key" },
] as const;

export const PARENT_IDENTITY_PROJECTIONS = [
	projection(
		"thread_executions",
		"post_threads",
		"thread_group_id",
		workspaceProjection,
	),
	projection("post_targets", "posts", "post_id", scopeProjection),
	projection("post_targets", "social_accounts", "social_account_id", [
		{ parentColumn: "platform", childColumn: "platform" },
	]),
	projection("cross_post_actions", "post_targets", "source_target_id", [
		{ parentColumn: "post_id", childColumn: "post_id" },
		{ parentColumn: "scope_key", childColumn: "scope_key" },
		{ parentColumn: "platform", childColumn: "source_platform" },
	]),
	projection("cross_post_actions", "social_accounts", "target_account_id", [
		{ parentColumn: "platform", childColumn: "target_platform" },
	]),
	projection("inbox_conversations", "social_accounts", "account_id", [
		...workspaceProjection,
		{ parentColumn: "platform", childColumn: "platform" },
	]),
	projection("inbox_messages", "inbox_conversations", "conversation_id", [
		{ parentColumn: "scope_key", childColumn: "scope_key" },
		{ parentColumn: "account_id", childColumn: "account_id" },
		{ parentColumn: "platform", childColumn: "platform" },
	]),
	projection("custom_field_values", "contacts", "contact_id", scopeProjection),
	projection(
		"custom_field_values",
		"custom_field_definitions",
		"definition_id",
		[{ parentColumn: "scope_key", childColumn: "definition_scope_key" }],
	),
	projection("contact_channels", "contacts", "contact_id", scopeProjection),
	projection("contact_channels", "social_accounts", "social_account_id", [
		{ parentColumn: "platform", childColumn: "platform" },
	]),
	projection(
		"contact_consent_states",
		"contact_consent_events",
		"last_event_id",
		workspaceProjection,
	),
	projection(
		"contact_suppressions",
		"contact_consent_events",
		"source_event_id",
		workspaceProjection,
	),
	projection("broadcasts", "social_accounts", "social_account_id", [
		...workspaceProjection,
		{ parentColumn: "platform", childColumn: "platform" },
	]),
	projection(
		"broadcast_recipients",
		"broadcasts",
		"broadcast_id",
		scopeProjection,
	),
	projection(
		"ad_accounts",
		"social_accounts",
		"social_account_id",
		workspaceProjection,
	),
	projection("ad_campaigns", "ad_accounts", "ad_account_id", [
		...workspaceProjection,
		{ parentColumn: "platform", childColumn: "platform" },
	]),
	projection("ads", "ad_campaigns", "campaign_id", [
		{ parentColumn: "workspace_id", childColumn: "workspace_id" },
		{ parentColumn: "ad_account_id", childColumn: "ad_account_id" },
		{ parentColumn: "platform", childColumn: "platform" },
	]),
	projection("ad_creation_operations", "ad_accounts", "ad_account_id", [
		...workspaceProjection,
		{ parentColumn: "platform", childColumn: "platform" },
	]),
	projection("ad_audiences", "ad_accounts", "ad_account_id", [
		...workspaceProjection,
		{ parentColumn: "platform", childColumn: "platform" },
	]),
	projection("external_posts", "social_accounts", "social_account_id", [
		...workspaceProjection,
		{ parentColumn: "platform", childColumn: "platform" },
	]),
	projection("ad_sync_logs", "ad_accounts", "ad_account_id", [
		{ parentColumn: "scope_key", childColumn: "scope_key" },
		{ parentColumn: "platform", childColumn: "platform" },
	]),
	projection(
		"social_account_sync_state",
		"social_accounts",
		"social_account_id",
		[
			{ parentColumn: "scope_key", childColumn: "scope_key" },
			{ parentColumn: "platform", childColumn: "platform" },
		],
	),
	projection("ideas", "idea_groups", "group_id", [
		{ parentColumn: "scope_key", childColumn: "group_scope_key" },
	]),
	projection("idea_conversion_operations", "ideas", "idea_id", scopeProjection),
	projection("idea_media", "ideas", "idea_id", workspaceProjection),
	projection("idea_tags", "ideas", "idea_id", workspaceProjection),
	projection("idea_tags", "tags", "tag_id", [
		{ parentColumn: "scope_key", childColumn: "tag_scope_key" },
	]),
	projection("post_tags", "posts", "post_id", scopeProjection),
	projection("post_tags", "tags", "tag_id", [
		{ parentColumn: "scope_key", childColumn: "tag_scope_key" },
	]),
	projection(
		"automation_entrypoints",
		"automations",
		"automation_id",
		scopeProjection,
	),
	projection(
		"automation_bindings",
		"automations",
		"automation_id",
		workspaceProjection,
	),
	projection(
		"automation_runs",
		"automations",
		"automation_id",
		scopeProjection,
	),
	projection(
		"automation_node_executions",
		"automation_runs",
		"run_id",
		scopeProjection,
	),
	projection(
		"automation_effects",
		"automation_node_executions",
		"node_execution_id",
		scopeProjection,
	),
	projection(
		"contact_segment_memberships",
		"segments",
		"segment_id",
		scopeProjection,
	),
	projection(
		"contact_subscriptions",
		"subscription_lists",
		"list_id",
		scopeProjection,
	),
	projection(
		"ai_knowledge_documents",
		"ai_knowledge_bases",
		"kb_id",
		scopeProjection,
	),
	projection("ai_knowledge_chunks", "ai_knowledge_documents", "document_id", [
		...scopeProjection,
		{ parentColumn: "kb_id", childColumn: "kb_id" },
	]),
	projection("qr_codes", "ref_urls", "ref_url_id", scopeProjection),
	projection(
		"billing_operations",
		"usage_bucket_settlements",
		"usage_bucket_settlement_id",
		[
			{ parentColumn: "amount_cents", childColumn: "amount_cents" },
			{ parentColumn: "currency", childColumn: "currency" },
		],
	),
] as const satisfies readonly ParentIdentityProjection[];

/** Derived counter maintained from the authoritative membership relation. */
export const SEGMENT_MEMBER_COUNT_CONTRACT = {
	functionSchema: "public",
	functionName: "maintain_segment_member_count",
	triggerName: "maintain_segment_member_count_after_write",
	segmentTable: "segments",
	membershipTable: "contact_segment_memberships",
} as const;

/**
 * Database race backstop for the opt-in Require Workspace ID policy. Historical
 * inactive rows remain editable; a transition back to an operational state is
 * checked in the same way as an insert.
 */
export const WORKSPACE_REQUIREMENT_CONTRACT = {
	functionSchema: "public",
	functionName: "enforce_workspace_requirement",
	settingsTable: "organization_settings",
	settingsColumn: "require_workspace_id",
	workspaceTable: "workspaces",
	activeWorkspaceState: "active",
	tables: REQUIRE_WORKSPACE_OPERATIONAL_ROOTS,
	inactiveStates: {
		social_accounts: {
			column: "lifecycle_status",
			values: ["disconnected"],
		},
		inbox_conversations: { column: "status", values: ["archived"] },
		automations: { column: "status", values: ["archived"] },
	} as Readonly<Record<string, { column: string; values: readonly string[] }>>,
} as const;

export function workspaceRequirementTriggerName(tableName: string): string {
	// The zz_ prefix makes this run after project_* BEFORE triggers, so inherited
	// workspace_id is populated before policy enforcement.
	return `zz_require_workspace_${tableName}`.slice(0, 63);
}
