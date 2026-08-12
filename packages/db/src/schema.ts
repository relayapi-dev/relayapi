import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	bigserial,
	boolean,
	check,
	date,
	foreignKey,
	index,
	integer,
	jsonb,
	pgEnum,
	pgSchema,
	pgTable,
	primaryKey,
	real,
	smallint,
	text,
	timestamp,
	unique,
	uniqueIndex,
	varchar,
	vector,
} from "drizzle-orm/pg-core";
import {
	AI_EMBEDDING_DIMENSIONS,
	AI_EMBEDDING_MODEL,
	AI_EMBEDDING_PROVIDER,
	AI_INFERENCE_MODEL,
	AI_INFERENCE_PROVIDER,
	AI_KNOWLEDGE_DOCUMENT_MAX_ATTEMPTS,
} from "./ai-contracts";
import { LEGACY_CREDENTIAL_VERSION } from "./credential-version";
import { ddlIntegerLiteral, ddlTextLiteral } from "./ddl-literals";
import {
	AD_ADVANCED_RESOURCE_KINDS,
	AD_AUDIENCE_TYPES,
	AD_CREATION_OPERATION_KINDS,
	AD_PROMOTABLE_IDENTITY_STATUSES,
	AD_PROMOTABLE_IDENTITY_TYPES,
	AD_SYNC_TYPES,
	AI_KNOWLEDGE_SOURCE_TYPES,
	AUTOMATION_BINDING_TYPES,
	AUTOMATION_EFFECT_KINDS,
	AUTOMATION_ENTRYPOINT_KINDS,
	AUTOMATION_NODE_KINDS,
	AUTOMATION_SCHEDULED_JOB_TYPES,
	AUTOMATION_SECRET_KINDS,
	BILLING_OUTBOX_KINDS,
	CONTACT_SUBSCRIPTION_EVENT_TYPES,
	CROSS_POST_ACTION_TYPES,
	CUSTOM_FIELD_TYPES,
	ERASURE_HOLD_SUBJECT_KINDS,
	EXTERNAL_SUBJECT_CLEANUP_SUBJECT_KINDS,
	IDEA_MEDIA_TYPES,
	INBOX_CONVERSATION_TYPES,
	INBOX_DIRECTIONS,
	INBOX_NOTE_ACTOR_TYPES,
	INVITE_TOKEN_ROLES,
	MEDIA_DERIVATIVE_KINDS,
	NOTIFICATION_TYPES,
	ONE_TIME_CAPABILITY_KINDS,
	ORGANIZATION_PRINCIPAL_KINDS,
	PUBLIC_GROWTH_EVENT_TYPES,
	PUBLISH_OUTBOX_KINDS,
	QUEUE_FAILURE_KINDS,
	REF_URL_DESTINATION_TYPES,
	SOCIAL_MUTATION_KINDS,
	SOCIAL_MUTATION_TARGET_TYPES,
	SOCIAL_PLATFORM_IDS,
	TOOL_JOB_KINDS,
	WEBHOOK_ATTEMPT_KINDS,
	WEBHOOK_ATTEMPT_OUTCOMES,
} from "./domain-contracts";
import {
	FINANCIAL_RETENTION_CLASSES,
	FINANCIAL_RETENTION_SOURCE_KINDS,
	FINANCIAL_RETENTION_STATUSES,
} from "./financial-retention-contracts";
import {
	OPERATOR_RESOLUTION_ACTIONS,
	OPERATOR_RESOLUTION_REASON_CODES,
	OPERATOR_RESOLUTION_TARGET_TYPES,
	type OperatorResolutionState,
} from "./operator-resolution-contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function generateId(prefix: string): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `${prefix}${hex}`;
}

/**
 * Canonical exact-scope discriminator for every table that can be owned by an
 * organization directly or by one of its workspaces. The typed prefixes make
 * the organization sentinel impossible to collide with a workspace ID.
 */
export const ORGANIZATION_SCOPE_KEY = "org";

function workspaceScopeKeySql() {
	return sql`CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END`;
}

// ---------------------------------------------------------------------------
// Auth schema (Better Auth owns these tables)
// ---------------------------------------------------------------------------

const authSchema = pgSchema("auth");

export const user = authSchema.table(
	"user",
	{
		id: text("id").primaryKey(),
		name: text("name"),
		email: text("email").notNull(),
		emailVerified: boolean("emailVerified").notNull().default(false),
		image: text("image"),
		role: text("role"),
		banned: boolean("banned"),
		banReason: text("banReason"),
		banExpires: timestamp("banExpires", { withTimezone: true }),
		credentialVersion: text("credentialVersion")
			.default(LEGACY_CREDENTIAL_VERSION)
			.notNull(),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [uniqueIndex("user_email_idx").on(table.email)],
);

export const session = authSchema.table(
	"session",
	{
		id: text("id").primaryKey(),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		token: text("token").notNull(),
		expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
		ipAddress: text("ipAddress"),
		userAgent: text("userAgent"),
		activeOrganizationId: text("activeOrganizationId"),
		impersonatedBy: text("impersonatedBy"),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("session_token_idx").on(table.token),
		index("session_userId_idx").on(table.userId),
		index("session_impersonatedBy_idx").on(table.impersonatedBy),
		index("session_expires_idx").on(table.expiresAt, table.id),
	],
);

export const account = authSchema.table("account", {
	id: text("id").primaryKey(),
	userId: text("userId")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	accountId: text("accountId").notNull(),
	providerId: text("providerId").notNull(),
	accessToken: text("accessToken"),
	refreshToken: text("refreshToken"),
	accessTokenExpiresAt: timestamp("accessTokenExpiresAt", {
		withTimezone: true,
	}),
	refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", {
		withTimezone: true,
	}),
	scope: text("scope"),
	idToken: text("idToken"),
	password: text("password"),
	createdAt: timestamp("createdAt", { withTimezone: true })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updatedAt", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const verification = authSchema.table(
	"verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("verification_identifier_idx").on(table.identifier),
		// Better Auth stores the affected user ID in `value` for password-reset
		// and account-deletion capabilities. This locator makes identity erasure
		// independent of parsing opaque token identifiers.
		index("verification_value_idx").on(table.value),
		index("verification_expires_idx").on(table.expiresAt, table.id),
	],
);

export const apikey = authSchema.table(
	"apikey",
	{
		id: text("id").primaryKey(),
		configId: text("configId").default("default"),
		name: text("name"),
		start: text("start"),
		prefix: text("prefix"),
		key: text("key").notNull(), // hashed
		referenceId: text("referenceId").references(() => user.id, {
			onDelete: "set null",
		}), // points to user.id (who created the key)
		organizationId: text("organizationId").notNull(), // the org this key belongs to
		principalId: text("principalId").notNull(),
		refillInterval: text("refillInterval"),
		refillAmount: integer("refillAmount"),
		lastRefillAt: timestamp("lastRefillAt", { withTimezone: true }),
		enabled: boolean("enabled").default(true),
		rateLimitEnabled: boolean("rateLimitEnabled").default(false),
		rateLimitTimeWindow: integer("rateLimitTimeWindow"),
		rateLimitMax: integer("rateLimitMax"),
		requestCount: integer("requestCount").default(0),
		remaining: integer("remaining"),
		lastRequest: timestamp("lastRequest", { withTimezone: true }),
		expiresAt: timestamp("expiresAt", { withTimezone: true }),
		permissions: text("permissions"),
		metadata: jsonb("metadata"),
		credentialVersion: text("credentialVersion"),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.principalId, table.organizationId],
			foreignColumns: [
				organizationPrincipals.id,
				organizationPrincipals.organizationId,
			],
			name: "apikey_principal_org_fk",
		}).onDelete("cascade"),
		unique("apikey_id_organization_uniq").on(table.id, table.organizationId),
		index("apikey_principal_idx").on(
			table.organizationId,
			table.principalId,
			table.createdAt,
		),
		index("apikey_referenceId_idx").on(table.referenceId),
		index("apikey_organizationId_idx").on(
			table.organizationId,
			table.createdAt,
			table.id,
		),
		index("apikey_key_idx").on(table.key),
	],
);

// ---------------------------------------------------------------------------
// Organization (Better Auth organization plugin)
// ---------------------------------------------------------------------------

export const organization = authSchema.table(
	"organization",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		slug: text("slug").notNull().unique(),
		logo: text("logo"),
		metadata: text("metadata"),
		lifecycleStatus: text("lifecycle_status", {
			enum: ["active", "deleting", "tombstoned"],
		})
			.notNull()
			.default("active"),
		deletionRequestedAt: timestamp("deletion_requested_at", {
			withTimezone: true,
		}),
		tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"organization_lifecycle_status_check",
			sql`${table.lifecycleStatus} IN ('active', 'deleting', 'tombstoned')`,
		),
		check(
			"organization_lifecycle_timestamps_check",
			sql`(${table.lifecycleStatus} = 'active' AND ${table.deletionRequestedAt} IS NULL AND ${table.tombstonedAt} IS NULL)
				OR (${table.lifecycleStatus} = 'deleting' AND ${table.deletionRequestedAt} IS NOT NULL AND ${table.tombstonedAt} IS NULL)
				OR (${table.lifecycleStatus} = 'tombstoned' AND ${table.deletionRequestedAt} IS NOT NULL AND ${table.tombstonedAt} IS NOT NULL)`,
		),
	],
);

export const member = authSchema.table(
	"member",
	{
		id: text("id").primaryKey(),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("member_id_organization_uniq").on(table.id, table.organizationId),
		unique("member_user_organization_uniq").on(
			table.userId,
			table.organizationId,
		),
		index("member_userId_idx").on(table.userId),
		index("member_organizationId_idx").on(table.organizationId),
	],
);

/**
 * Short-lived quota claims close the gap between Better Auth's pre-create hook
 * and its later organization/member inserts. A failed create expires safely;
 * a successful create removes its claim in the after-create hook.
 */
export const organizationCreationReservations = authSchema.table(
	"organization_creation_reservation",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ocr_")),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		slug: text("slug").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		unique("organization_creation_reservation_user_slug_uniq").on(
			table.userId,
			table.slug,
		),
		check(
			"organization_creation_reservation_expiry_check",
			sql`${table.expiresAt} > ${table.createdAt}`,
		),
		index("organization_creation_reservation_user_expiry_idx").on(
			table.userId,
			table.expiresAt,
		),
		index("organization_creation_reservation_expiry_idx").on(
			table.expiresAt,
			table.id,
		),
	],
);

export const invitation = authSchema.table(
	"invitation",
	{
		id: text("id").primaryKey(),
		email: text("email").notNull(),
		inviterId: text("inviterId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		issuerCredentialVersion: text("issuerCredentialVersion")
			.default(LEGACY_CREDENTIAL_VERSION)
			.notNull(),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		role: text("role"),
		status: text("status").notNull(),
		expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("invitation_email_status_expires_idx").on(
			sql`lower(${table.email})`,
			table.status,
			table.expiresAt,
		),
		index("invitation_inviter_status_idx").on(
			table.inviterId,
			table.status,
			table.id,
		),
		index("invitation_retention_idx").on(table.expiresAt, table.id),
	],
);

// ---------------------------------------------------------------------------
// Enums (public schema)
// ---------------------------------------------------------------------------

export const subscriptionStatusEnum = pgEnum("subscription_status", [
	"trialing",
	"active",
	"past_due",
	"cancelled",
]);

export const invoiceStatusEnum = pgEnum("invoice_status", [
	"draft",
	"finalized",
	"paid",
	"void",
]);

export const platformEnum = pgEnum("platform", [...SOCIAL_PLATFORM_IDS]);

export const postStatusEnum = pgEnum("post_status", [
	"draft",
	"scheduled",
	"publishing",
	"published",
	"provider_draft",
	"failed",
	"partial",
]);

export const recycleGapFreqEnum = pgEnum("recycle_gap_freq", [
	"day",
	"week",
	"month",
]);

export const storageProviderEnum = pgEnum("storage_provider", ["r2", "byos"]);

export const workspaceRoleEnum = pgEnum("workspace_role", [
	"owner",
	"admin",
	"member",
]);

// ---------------------------------------------------------------------------
// Public schema tables
// ---------------------------------------------------------------------------

export const workspaces = pgTable(
	"workspaces",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ws_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		name: text("name").notNull(),
		slug: text("slug")
			.notNull()
			.$defaultFn(() => generateId("workspace-")),
		description: text("description"),
		lifecycleStatus: text("lifecycle_status", {
			enum: ["active", "archived", "erasing"],
		})
			.notNull()
			.default("active"),
		revision: integer("revision").notNull().default(0),
		archivedAt: timestamp("archived_at", { withTimezone: true }),
		erasureRequestedAt: timestamp("erasure_requested_at", {
			withTimezone: true,
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("workspaces_id_org_uniq").on(table.id, table.organizationId),
		unique("workspaces_org_slug_uniq").on(table.organizationId, table.slug),
		check(
			"workspaces_slug_format_check",
			sql`${table.slug} ~ '^[a-z0-9][a-z0-9_-]{0,99}$'`,
		),
		check(
			"workspaces_lifecycle_status_check",
			sql`${table.lifecycleStatus} IN ('active', 'archived', 'erasing')`,
		),
		check("workspaces_revision_nonnegative_check", sql`${table.revision} >= 0`),
		check(
			"workspaces_lifecycle_timestamps_check",
			sql`(${table.lifecycleStatus} <> 'archived' OR ${table.archivedAt} IS NOT NULL)
				AND (${table.lifecycleStatus} <> 'erasing' OR ${table.erasureRequestedAt} IS NOT NULL)`,
		),
		index("workspaces_org_idx").on(table.organizationId),
		index("workspaces_org_name_idx").on(table.organizationId, table.name),
		index("workspaces_org_slug_idx").on(table.organizationId, table.slug),
		index("workspaces_org_lifecycle_idx").on(
			table.organizationId,
			table.lifecycleStatus,
		),
	],
);

/**
 * Stable organization-scoped authority. Membership and credentials have
 * independent lifecycles: a member principal survives credential rotation,
 * retires to a pseudonymous actor when membership ends, and a service
 * principal can own one or more replaceable API keys.
 */
export const organizationPrincipals = pgTable(
	"organization_principals",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("prn_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		kind: text("kind", {
			enum: [...ORGANIZATION_PRINCIPAL_KINDS],
		}).notNull(),
		memberId: text("member_id"),
		serviceName: text("service_name"),
		scopeMode: text("scope_mode", { enum: ["all", "selected"] }).notNull(),
		lifecycleStatus: text("lifecycle_status", {
			enum: ["active", "disabled"],
		})
			.notNull()
			.default("active"),
		disabledAt: timestamp("disabled_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		foreignKey({
			columns: [table.memberId, table.organizationId],
			foreignColumns: [member.id, member.organizationId],
			name: "organization_principals_member_org_fk",
		}),
		unique("organization_principals_id_org_uniq").on(
			table.id,
			table.organizationId,
		),
		unique("organization_principals_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeMode,
		),
		uniqueIndex("organization_principals_member_uniq")
			.on(table.organizationId, table.memberId)
			.where(sql`${table.kind} = 'member'`),
		check(
			"organization_principals_kind_check",
			sql`${table.kind} IN ('member', 'service')`,
		),
		check(
			"organization_principals_scope_mode_check",
			sql`${table.scopeMode} IN ('all', 'selected')`,
		),
		check(
			"organization_principals_lifecycle_status_check",
			sql`${table.lifecycleStatus} IN ('active', 'disabled')`,
		),
		check(
			"organization_principals_identity_tuple_check",
			sql`(${table.kind} = 'member'
					AND ${table.serviceName} IS NULL
					AND (
						${table.memberId} IS NOT NULL
						OR ${table.lifecycleStatus} = 'disabled'
					))
				OR (${table.kind} = 'service'
					AND ${table.memberId} IS NULL
					AND length(btrim(${table.serviceName})) BETWEEN 1 AND 120)`,
		),
		check(
			"organization_principals_lifecycle_check",
			sql`(${table.lifecycleStatus} = 'active' AND ${table.disabledAt} IS NULL)
				OR (${table.lifecycleStatus} = 'disabled' AND ${table.disabledAt} IS NOT NULL)`,
		),
		check(
			"organization_principals_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND (${table.disabledAt} IS NULL OR ${table.disabledAt} >= ${table.createdAt})`,
		),
		index("organization_principals_org_kind_status_idx").on(
			table.organizationId,
			table.kind,
			table.lifecycleStatus,
		),
	],
);

/**
 * Exact workspace grants for selected-scope principals. The local selected
 * discriminator participates in the parent FK, so an all-scope principal
 * cannot accidentally accumulate contradictory grant rows.
 */
export const principalWorkspaceGrants = pgTable(
	"principal_workspace_grants",
	{
		organizationId: text("organization_id").notNull(),
		principalId: text("principal_id").notNull(),
		workspaceId: text("workspace_id").notNull(),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		scopeMode: text("scope_mode", { enum: ["selected"] })
			.notNull()
			.default("selected"),
		grantedAt: timestamp("granted_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		primaryKey({
			name: "principal_workspace_grants_pkey",
			columns: [table.organizationId, table.principalId, table.workspaceId],
		}),
		foreignKey({
			columns: [table.principalId, table.organizationId, table.scopeMode],
			foreignColumns: [
				organizationPrincipals.id,
				organizationPrincipals.organizationId,
				organizationPrincipals.scopeMode,
			],
			name: "principal_workspace_grants_selected_principal_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "principal_workspace_grants_workspace_org_fk",
		}).onDelete("cascade"),
		check(
			"principal_workspace_grants_scope_mode_check",
			sql`${table.scopeMode} = 'selected'`,
		),
		index("principal_workspace_grants_workspace_idx").on(
			table.organizationId,
			table.workspaceId,
			table.principalId,
		),
	],
);

/** PII-free receipt retained after irreversible workspace erasure. */
export const workspaceTombstones = pgTable(
	"workspace_tombstones",
	{
		workspaceId: text("workspace_id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		erasureOperationId: text("erasure_operation_id").notNull().unique(),
		erasedAt: timestamp("erased_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("workspace_tombstones_org_erased_idx").on(
			table.organizationId,
			table.erasedAt,
		),
	],
);

export const erasureHoldSubjectKind = pgEnum(
	"erasure_hold_subject_kind",
	ERASURE_HOLD_SUBJECT_KINDS,
);

/**
 * Auditable legal-hold lifecycle for organization and workspace erasure.
 *
 * This table deliberately has no FK to either deletable root. The subject and
 * organization identifiers become minimized tombstone references after purge,
 * while release and evidence-redaction clocks remain reviewable. Placement
 * fields are immutable by service contract; release only fills the nullable
 * release tuple once.
 */
export const erasureHolds = pgTable(
	"erasure_holds",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("hold_")),
		subjectKind: erasureHoldSubjectKind("subject_kind").notNull(),
		subjectId: text("subject_id").notNull(),
		organizationTombstoneId: text("organization_tombstone_id").notNull(),
		reasonCode: text("reason_code").notNull(),
		reasonSummary: text("reason_summary").notNull(),
		legalAuthorityRef: text("legal_authority_ref").notNull(),
		placedBy: text("placed_by").notNull(),
		placedAt: timestamp("placed_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		releasedBy: text("released_by"),
		releasedAt: timestamp("released_at", { withTimezone: true }),
		releaseReasonSummary: text("release_reason_summary"),
		evidenceCiphertext: text("evidence_ciphertext"),
		evidenceRedactedAt: timestamp("evidence_redacted_at", {
			withTimezone: true,
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		check(
			"erasure_holds_target_tuple_check",
			sql`(${table.subjectKind} = 'organization'
					AND ${table.subjectId} = ${table.organizationTombstoneId})
				OR (${table.subjectKind} = 'workspace'
					AND ${table.subjectId} <> ${table.organizationTombstoneId})`,
		),
		check(
			"erasure_holds_reason_code_check",
			sql`${table.reasonCode} ~ '^[a-z][a-z0-9_]{0,63}$'`,
		),
		check(
			"erasure_holds_placement_text_check",
			sql`length(btrim(${table.reasonSummary})) > 0
				AND length(${table.reasonSummary}) <= 500
				AND length(btrim(${table.legalAuthorityRef})) > 0
				AND length(${table.legalAuthorityRef}) <= 256
				AND length(btrim(${table.placedBy})) > 0
				AND length(${table.placedBy}) <= 256`,
		),
		check(
			"erasure_holds_release_tuple_check",
			sql`(${table.releasedBy} IS NULL
					AND ${table.releasedAt} IS NULL
					AND ${table.releaseReasonSummary} IS NULL)
				OR (${table.releasedBy} IS NOT NULL
					AND ${table.releasedAt} IS NOT NULL
					AND length(btrim(${table.releaseReasonSummary})) > 0
					AND length(${table.releaseReasonSummary}) <= 500
					AND length(${table.releasedBy}) <= 256)`,
		),
		check(
			"erasure_holds_timestamp_order_check",
			sql`${table.placedAt} >= ${table.createdAt}
				AND (${table.releasedAt} IS NULL OR ${table.releasedAt} >= ${table.placedAt})`,
		),
		check(
			"erasure_holds_evidence_redaction_check",
			sql`(${table.evidenceCiphertext} IS NULL
					OR octet_length(${table.evidenceCiphertext}) <= 65536)
				AND (${table.evidenceRedactedAt} IS NULL
					OR (${table.evidenceCiphertext} IS NULL
						AND ${table.releasedAt} IS NOT NULL
						AND ${table.evidenceRedactedAt} >= ${table.releasedAt}))`,
		),
		uniqueIndex("erasure_holds_active_subject_uniq")
			.on(table.subjectKind, table.subjectId)
			.where(sql`${table.releasedAt} IS NULL`),
		index("erasure_holds_active_organization_idx")
			.on(table.organizationTombstoneId, table.subjectKind, table.subjectId)
			.where(sql`${table.releasedAt} IS NULL`),
		index("erasure_holds_released_evidence_idx").on(
			table.releasedAt,
			table.evidenceRedactedAt,
		),
		index("erasure_holds_released_evidence_retention_idx")
			.on(table.releasedAt, table.id)
			.where(
				sql`${table.releasedAt} IS NOT NULL AND ${table.evidenceRedactedAt} IS NULL`,
			),
	],
);

/**
 * Durable, idempotent cleanup intent for external object stores.
 *
 * One row represents one exact key, one resumable prefix, or one typed Queue
 * rescue subject. The row is committed with the database erasure that made the
 * object unreachable, then a scheduled worker performs the external delete
 * under a fenced lease. Tombstone locators deliberately have no FK so cleanup
 * survives deletion of the owning subject and tenant.
 */
export const externalSubjectCleanupJobs = pgTable(
	"external_subject_cleanup_jobs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("escj_")),
		organizationId: text("organization_id"),
		workspaceId: text("workspace_id"),
		subjectKind: text("subject_kind", {
			enum: [...EXTERNAL_SUBJECT_CLEANUP_SUBJECT_KINDS],
		}).notNull(),
		subjectId: text("subject_id").notNull(),
		operation: text("operation", {
			enum: [
				"delete_exact",
				"delete_prefix",
				"purge_rescue_subject",
				"delete_short_link",
			],
		}).notNull(),
		bucket: text("bucket", {
			enum: [
				"avatar",
				"media",
				"thumbnail",
				"queue_rescue",
				"short_link_provider",
			],
		}).notNull(),
		objectLocator: text("object_locator"),
		prefixLocator: text("prefix_locator"),
		externalProvider: text("external_provider", {
			enum: ["dub", "short_io", "bitly"],
		}),
		providerRef: jsonb("provider_ref").$type<Record<string, unknown>>(),
		credentialCiphertext: text("credential_ciphertext"),
		cursor: text("cursor"),
		status: text("status", {
			enum: ["pending", "processing", "completed", "manual_review"],
		})
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		deadlineAt: timestamp("deadline_at", { withTimezone: true })
			.notNull()
			.default(sql`now() + interval '7 days'`),
		lastError: text("last_error"),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		purgeAt: timestamp("purge_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		check(
			"external_subject_cleanup_jobs_subject_kind_check",
			sql`${table.subjectKind} IN ('user', 'contact', 'account', 'organization', 'workspace')`,
		),
		check(
			"external_subject_cleanup_jobs_operation_check",
			sql`${table.operation} IN ('delete_exact', 'delete_prefix', 'purge_rescue_subject', 'delete_short_link')`,
		),
		check(
			"external_subject_cleanup_jobs_bucket_check",
			sql`${table.bucket} IN ('avatar', 'media', 'thumbnail', 'queue_rescue', 'short_link_provider')`,
		),
		check(
			"external_subject_cleanup_jobs_status_check",
			sql`${table.status} IN ('pending', 'processing', 'completed', 'manual_review')`,
		),
		check(
			"external_subject_cleanup_jobs_subject_tuple_check",
			sql`(${table.subjectKind} = 'user' AND ${table.workspaceId} IS NULL)
				OR (${table.subjectKind} IN ('contact', 'account')
					AND ${table.organizationId} IS NOT NULL)
				OR (${table.subjectKind} = 'organization'
					AND ${table.organizationId} = ${table.subjectId}
					AND ${table.workspaceId} IS NULL)
				OR (${table.subjectKind} = 'workspace'
					AND ${table.organizationId} IS NOT NULL
					AND ${table.workspaceId} = ${table.subjectId})`,
		),
		check(
			"external_subject_cleanup_jobs_locator_tuple_check",
			sql`(${table.operation} = 'delete_exact'
					AND ${table.bucket} IN ('avatar', 'media', 'thumbnail')
					AND ${table.objectLocator} IS NOT NULL
					AND ${table.prefixLocator} IS NULL
					AND ${table.cursor} IS NULL
					AND ${table.externalProvider} IS NULL
					AND ${table.providerRef} IS NULL
					AND ${table.credentialCiphertext} IS NULL)
				OR (${table.operation} = 'delete_prefix'
					AND ${table.bucket} IN ('avatar', 'media', 'thumbnail')
					AND ${table.objectLocator} IS NULL
					AND ${table.prefixLocator} IS NOT NULL
					AND ${table.externalProvider} IS NULL
					AND ${table.providerRef} IS NULL
					AND ${table.credentialCiphertext} IS NULL)
				OR (${table.operation} = 'purge_rescue_subject'
					AND ${table.bucket} = 'queue_rescue'
					AND ${table.organizationId} IS NOT NULL
					AND ${table.subjectKind} IN ('user', 'contact', 'account', 'workspace')
					AND ${table.objectLocator} IS NULL
					AND ${table.prefixLocator} IS NULL
					AND ${table.externalProvider} IS NULL
					AND ${table.providerRef} IS NULL
					AND ${table.credentialCiphertext} IS NULL)
				OR (${table.operation} = 'delete_short_link'
					AND ${table.bucket} = 'short_link_provider'
					AND ${table.organizationId} IS NOT NULL
					AND ${table.subjectKind} IN ('organization', 'workspace')
					AND ${table.objectLocator} IS NULL
					AND ${table.prefixLocator} IS NULL
					AND ${table.cursor} IS NULL
					AND ${table.externalProvider} IN ('dub', 'short_io', 'bitly')
					AND jsonb_typeof(${table.providerRef}) = 'object'
					AND ${table.providerRef}->>'provider' = ${table.externalProvider}
					AND (
						(${table.status} = 'completed'
							AND ${table.credentialCiphertext} IS NULL)
						OR (${table.status} <> 'completed'
							AND ${table.credentialCiphertext} IS NOT NULL
							AND ${table.credentialCiphertext} LIKE 'enc:v2:%'
							AND length(${table.credentialCiphertext}) BETWEEN 1 AND 8192)
					))`,
		),
		check(
			"external_subject_cleanup_jobs_locator_syntax_check",
			sql`(${table.objectLocator} IS NULL
					OR (length(${table.objectLocator}) BETWEEN 1 AND 1024
						AND ${table.objectLocator} !~ '(^/|//|(^|/)\\.\\.?(/|$)|[[:cntrl:]])'
						AND ${table.objectLocator} !~ '/$'))
				AND (${table.prefixLocator} IS NULL
					OR (length(${table.prefixLocator}) BETWEEN 1 AND 1024
						AND ${table.prefixLocator} !~ '(^/|//|(^|/)\\.\\.?(/|$)|[[:cntrl:]])'
						AND ${table.prefixLocator} ~ '/$'))`,
		),
		check(
			"external_subject_cleanup_jobs_bucket_locator_check",
			sql`${table.bucket} IN ('queue_rescue', 'short_link_provider')
				OR (
					${table.bucket} = 'avatar'
					AND COALESCE(${table.objectLocator}, ${table.prefixLocator})
						~ '^(account|user|organization)/[^/]+/'
				)
				OR (
					${table.bucket} = 'thumbnail'
					AND (
						${table.prefixLocator} IS NOT NULL
						OR ${table.objectLocator} ~ '\\.avif$'
					)
				)
				OR (
					${table.bucket} = 'media'
					AND COALESCE(${table.objectLocator}, ${table.prefixLocator})
						!~ '^(account|user|organization|queue-rescue)/'
				)`,
		),
		check(
			"external_subject_cleanup_jobs_counters_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"external_subject_cleanup_jobs_lease_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"external_subject_cleanup_jobs_terminal_check",
			sql`(${table.status} = 'completed'
					AND ${table.completedAt} IS NOT NULL
					AND ${table.purgeAt} IS NOT NULL)
				OR (${table.status} <> 'completed'
					AND ${table.completedAt} IS NULL
					AND ${table.purgeAt} IS NULL)`,
		),
		check(
			"external_subject_cleanup_jobs_error_check",
			sql`${table.lastError} IS NULL OR length(${table.lastError}) BETWEEN 1 AND 1000`,
		),
		check(
			"external_subject_cleanup_jobs_timestamp_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND ${table.deadlineAt} > ${table.createdAt}
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})
				AND (${table.purgeAt} IS NULL OR ${table.purgeAt} >= ${table.completedAt})`,
		),
		uniqueIndex("external_subject_cleanup_jobs_identity_uniq")
			.on(
				table.operation,
				table.bucket,
				sql`COALESCE(${table.objectLocator}, '')`,
				sql`COALESCE(${table.prefixLocator}, '')`,
				sql`(CASE WHEN ${table.operation} = 'purge_rescue_subject'
				THEN COALESCE(${table.organizationId}, '') ELSE '' END)`,
				sql`(CASE WHEN ${table.operation} = 'purge_rescue_subject'
				THEN ${table.subjectKind} ELSE '' END)`,
				sql`(CASE WHEN ${table.operation} = 'purge_rescue_subject'
				THEN ${table.subjectId} ELSE '' END)`,
				sql`(CASE WHEN ${table.operation} = 'delete_short_link'
				THEN COALESCE(${table.externalProvider}, '') ELSE '' END)`,
				sql`(CASE WHEN ${table.operation} = 'delete_short_link'
				THEN COALESCE(${table.providerRef}::text, '') ELSE '' END)`,
				sql`(CASE WHEN ${table.operation} = 'delete_short_link'
				THEN COALESCE(${table.organizationId}, '') ELSE '' END)`,
			)
			.where(sql`${table.status} <> 'completed'`),
		index("external_subject_cleanup_jobs_due_idx").on(
			table.status,
			sql`COALESCE(${table.organizationId}, (${table.subjectKind} || ':') || ${table.subjectId})`,
			table.nextAttemptAt,
			table.id,
		),
		index("external_subject_cleanup_jobs_deadline_idx")
			.on(
				sql`COALESCE(${table.organizationId}, (${table.subjectKind} || ':') || ${table.subjectId})`,
				table.deadlineAt,
				table.id,
			)
			.where(sql`${table.status} IN ('pending', 'processing')`),
		index("external_subject_cleanup_jobs_lease_idx").on(
			table.status,
			table.leaseExpiresAt,
		),
		index("external_subject_cleanup_jobs_subject_idx").on(
			table.subjectKind,
			table.subjectId,
		),
		index("external_subject_cleanup_jobs_manual_review_idx")
			.on(table.updatedAt, table.id)
			.where(sql`${table.status} = 'manual_review'`),
		index("external_subject_cleanup_jobs_retention_idx").on(
			table.purgeAt,
			table.id,
		),
	],
);

/**
 * Bounded control state for the canonical high-growth retention executor.
 *
 * There is exactly one row per executable handler. Rows are updated in place:
 * this relation is scheduler authority and backlog evidence, not an
 * ever-growing execution log. The runtime registry test proves exact handler
 * equality and the lease token fences overlapping Cron invocations.
 */
export const retentionDrainRuns = pgTable(
	"retention_drain_runs",
	{
		handlerId: text("handler_id").primaryKey(),
		status: text("status", {
			enum: ["idle", "running", "manual_review"],
		})
			.notNull()
			.default("idle"),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		cursorDueAt: timestamp("cursor_due_at", { withTimezone: true }),
		cursorRowId: text("cursor_row_id"),
		lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
		lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
		rowsLastRun: integer("rows_last_run").notNull().default(0),
		backlogOldestDueAt: timestamp("backlog_oldest_due_at", {
			withTimezone: true,
		}),
		consecutiveMoreDue: integer("consecutive_more_due").notNull().default(0),
		lastErrorCode: text("last_error_code"),
	},
	(table) => [
		check(
			"retention_drain_runs_handler_id_check",
			sql`length(${table.handlerId}) BETWEEN 1 AND 100
				AND ${table.handlerId} ~ '^[a-z][a-z0-9_]*$'`,
		),
		check(
			"retention_drain_runs_status_check",
			sql`${table.status} IN ('idle', 'running', 'manual_review')`,
		),
		check(
			"retention_drain_runs_counters_check",
			sql`${table.leaseToken} >= 0
				AND ${table.rowsLastRun} >= 0
				AND ${table.consecutiveMoreDue} >= 0`,
		),
		check(
			"retention_drain_runs_lease_check",
			sql`(${table.status} = 'running'
					AND ${table.leaseExpiresAt} IS NOT NULL
					AND ${table.lastStartedAt} IS NOT NULL
					AND ${table.leaseExpiresAt} > ${table.lastStartedAt})
				OR (${table.status} <> 'running'
					AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"retention_drain_runs_cursor_check",
			sql`(${table.cursorDueAt} IS NULL AND ${table.cursorRowId} IS NULL)
				OR (${table.cursorDueAt} IS NOT NULL
					AND ${table.cursorRowId} IS NOT NULL
					AND length(${table.cursorRowId}) BETWEEN 1 AND 256)`,
		),
		check(
			"retention_drain_runs_completion_check",
			sql`${table.lastFinishedAt} IS NULL
				OR (${table.lastStartedAt} IS NOT NULL
					AND ${table.lastFinishedAt} >= ${table.lastStartedAt})`,
		),
		check(
			"retention_drain_runs_manual_review_check",
			sql`${table.status} <> 'manual_review'
				OR (${table.backlogOldestDueAt} IS NOT NULL
					AND ${table.lastFinishedAt} IS NOT NULL)`,
		),
		check(
			"retention_drain_runs_error_code_check",
			sql`${table.lastErrorCode} IS NULL
				OR (length(${table.lastErrorCode}) BETWEEN 1 AND 100
					AND ${table.lastErrorCode} ~ '^[a-z][a-z0-9_]*$')`,
		),
		index("retention_drain_runs_continuation_idx")
			.on(table.status, table.backlogOldestDueAt, table.handlerId)
			.where(sql`${table.backlogOldestDueAt} IS NOT NULL`),
		index("retention_drain_runs_lease_idx")
			.on(table.leaseExpiresAt, table.handlerId)
			.where(sql`${table.status} = 'running'`),
	],
);

/**
 * Append-only evidence for an authenticated operator's lifecycle decision.
 *
 * It deliberately has no FK to a deletable tenant or user. The relation stores
 * only tombstone-compatible identifiers and sanitized state summaries, so the
 * evidence can survive the target row and tenant while a database trigger
 * rejects UPDATE and DELETE.
 */
export const operatorResolutionEvidence = pgTable(
	"operator_resolution_evidence",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ore_")),
		organizationId: text("organization_id"),
		targetType: text("target_type", {
			enum: [...OPERATOR_RESOLUTION_TARGET_TYPES],
		}).notNull(),
		targetId: text("target_id").notNull(),
		action: text("action", {
			enum: [...OPERATOR_RESOLUTION_ACTIONS],
		}).notNull(),
		reasonCode: text("reason_code", {
			enum: [...OPERATOR_RESOLUTION_REASON_CODES],
		}).notNull(),
		reasonDigest: text("reason_digest").notNull(),
		actorUserId: text("actor_user_id").notNull(),
		beforeState: jsonb("before_state")
			.$type<OperatorResolutionState>()
			.notNull(),
		afterState: jsonb("after_state").$type<OperatorResolutionState>().notNull(),
		targetUpdatedAtBefore: timestamp("target_updated_at_before", {
			withTimezone: true,
		}).notNull(),
		targetUpdatedAtAfter: timestamp("target_updated_at_after", {
			withTimezone: true,
		}).notNull(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		check(
			"operator_resolution_evidence_target_type_check",
			sql`${table.targetType} IN ('automation_effect', 'automation_binding', 'automation_conversion_event', 'stripe_event', 'billing_operation', 'tenant_erasure_job', 'workspace_erasure_job', 'account_revocation_job', 'external_subject_cleanup_job', 'short_link_creation', 'customer_webhook_delivery', 'tool_job', 'whatsapp_phone_provisioning_operation', 'whatsapp_phone_release_operation', 'whatsapp_phone_billing_operation', 'ad_creation_operation', 'ad_mutation_operation')`,
		),
		check(
			"operator_resolution_evidence_action_check",
			sql`${table.action} IN ('mark_succeeded', 'mark_not_applied', 'retry', 'abandon')`,
		),
		check(
			"operator_resolution_evidence_target_action_check",
			sql`(${table.targetType} = 'automation_effect'
					AND ${table.action} IN ('mark_succeeded', 'mark_not_applied'))
				OR (${table.targetType} = 'automation_binding'
					AND ${table.action} IN ('mark_succeeded', 'mark_not_applied', 'retry'))
				OR (${table.targetType} = 'automation_conversion_event'
					AND ${table.action} = 'retry')
				OR (${table.targetType} = 'stripe_event'
					AND ${table.action} IN ('retry', 'abandon'))
				OR (${table.targetType} = 'billing_operation'
					AND ${table.action} IN ('mark_succeeded', 'mark_not_applied', 'retry', 'abandon'))
				OR (${table.targetType} IN ('tenant_erasure_job', 'workspace_erasure_job')
					AND ${table.action} = 'retry')
				OR (${table.targetType} = 'account_revocation_job'
					AND ${table.action} IN ('mark_succeeded', 'mark_not_applied', 'abandon'))
				OR (${table.targetType} = 'external_subject_cleanup_job'
					AND ${table.action} IN ('mark_succeeded', 'retry'))
				OR (${table.targetType} = 'short_link_creation'
					AND ${table.action} IN ('mark_succeeded', 'mark_not_applied'))
						OR (${table.targetType} = 'customer_webhook_delivery'
							AND ${table.action} IN ('mark_succeeded', 'mark_not_applied', 'retry', 'abandon'))
					OR (${table.targetType} = 'tool_job'
						AND ${table.action} IN ('mark_not_applied', 'abandon'))
					OR (${table.targetType} = 'whatsapp_phone_provisioning_operation'
					AND ${table.action} IN ('mark_succeeded', 'mark_not_applied', 'retry'))
				OR (${table.targetType} = 'whatsapp_phone_release_operation'
					AND ${table.action} IN ('mark_succeeded', 'mark_not_applied', 'retry'))
				OR (${table.targetType} = 'ad_creation_operation'
					AND ${table.action} IN ('mark_succeeded', 'mark_not_applied', 'retry'))
				OR (${table.targetType} = 'whatsapp_phone_billing_operation'
					AND ${table.action} IN ('mark_succeeded', 'mark_not_applied'))
				OR (${table.targetType} = 'ad_mutation_operation'
					AND ${table.action} IN ('mark_succeeded', 'mark_not_applied', 'retry'))`,
		),
		check(
			"operator_resolution_evidence_identity_check",
			sql`length(btrim(${table.targetId})) BETWEEN 1 AND 255
				AND (${table.organizationId} IS NULL
					OR length(btrim(${table.organizationId})) BETWEEN 1 AND 255)
				AND length(btrim(${table.actorUserId})) BETWEEN 1 AND 255`,
		),
		check(
			"operator_resolution_evidence_reason_check",
			sql`${table.reasonCode} IN ('operator_asserted_succeeded', 'operator_asserted_not_applied', 'operator_requested_retry', 'operator_abandoned')
				AND ${table.reasonDigest} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"operator_resolution_evidence_state_check",
			sql`jsonb_typeof(${table.beforeState}) = 'object'
				AND jsonb_typeof(${table.afterState}) = 'object'
				AND NOT jsonb_path_exists(${table.beforeState}, '$.* ? (@.type() == "object" || @.type() == "array")')
				AND NOT jsonb_path_exists(${table.afterState}, '$.* ? (@.type() == "object" || @.type() == "array")')`,
		),
		check(
			"operator_resolution_evidence_stripe_abandon_check",
			sql`NOT (${table.targetType} = 'stripe_event' AND ${table.action} = 'abandon')
				OR COALESCE((${table.afterState}->>'reconciliation_reference_sha256' ~ '^[0-9a-f]{64}$'
					AND ${table.afterState}->>'status' = 'failed'
					AND ${table.afterState}->>'error_class' = 'permanent'
					AND ${table.afterState}->>'operator_retry_requested' = 'false'
					AND NOT (${table.afterState} ? 'provider_reference')), FALSE)`,
		),
		check(
			"operator_resolution_evidence_timestamp_order_check",
			sql`${table.targetUpdatedAtAfter} >= ${table.targetUpdatedAtBefore}
				AND ${table.resolvedAt} >= ${table.targetUpdatedAtAfter}`,
		),
		index("operator_resolution_evidence_target_idx").on(
			table.targetType,
			table.targetId,
			table.resolvedAt,
			table.id,
		),
		index("operator_resolution_evidence_org_resolved_idx").on(
			table.organizationId,
			table.resolvedAt,
			table.id,
		),
		index("operator_resolution_evidence_resolved_idx").on(
			table.resolvedAt,
			table.id,
		),
		index("operator_resolution_evidence_actor_resolved_idx").on(
			table.actorUserId,
			table.resolvedAt,
		),
	],
);

/**
 * Optional operator prose is encrypted and independently erasable. The
 * append-only evidence row keeps only a closed reason code and SHA-256 digest.
 */
export const operatorResolutionNotes = pgTable(
	"operator_resolution_notes",
	{
		evidenceId: text("evidence_id")
			.primaryKey()
			.references(() => operatorResolutionEvidence.id, {
				onDelete: "cascade",
			}),
		organizationId: text("organization_id"),
		noteCiphertext: text("note_ciphertext").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		check(
			"operator_resolution_notes_ciphertext_check",
			sql`${table.noteCiphertext} LIKE 'enc:v2:%'`,
		),
		check(
			"operator_resolution_notes_expiry_check",
			sql`${table.expiresAt} = ${table.createdAt} + interval '90 days'`,
		),
		index("operator_resolution_notes_expiry_idx").on(
			table.expiresAt,
			table.evidenceId,
		),
		index("operator_resolution_notes_org_idx").on(
			table.organizationId,
			table.evidenceId,
		),
	],
);

/** Durable, retryable workspace erasure state that survives workspace purge. */
export const workspaceErasureJobs = pgTable(
	"workspace_erasure_jobs",
	{
		workspaceId: text("workspace_id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		erasureOperationId: text("erasure_operation_id")
			.notNull()
			.unique()
			.$defaultFn(() => generateId("wse_")),
		status: text("status", {
			enum: [
				"pending",
				"processing",
				"held",
				"manual_review",
				"failed",
				"purged",
			],
		})
			.notNull()
			.default("pending"),
		requestedBy: text("requested_by"),
		auditSnapshot: jsonb("audit_snapshot").notNull().default(sql`'{}'::jsonb`),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		lastError: text("last_error"),
		requestedAt: timestamp("requested_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		agedAlertedAt: timestamp("aged_alerted_at", { withTimezone: true }),
		operatorRetryRequestedAt: timestamp("operator_retry_requested_at", {
			withTimezone: true,
		}),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		unique("workspace_erasure_jobs_workspace_org_scope_uniq").on(
			table.workspaceId,
			table.organizationId,
			table.scopeKey,
		),
		check(
			"workspace_erasure_jobs_status_check",
			sql`${table.status} IN ('pending', 'processing', 'held', 'manual_review', 'failed', 'purged')`,
		),
		check(
			"workspace_erasure_jobs_counters_nonnegative_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"workspace_erasure_jobs_completion_check",
			sql`${table.status} <> 'purged' OR ${table.completedAt} IS NOT NULL`,
		),
		check(
			"workspace_erasure_jobs_lease_state_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"workspace_erasure_jobs_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.requestedAt}
				AND (${table.agedAlertedAt} IS NULL OR ${table.agedAlertedAt} >= ${table.requestedAt})
				AND (${table.operatorRetryRequestedAt} IS NULL OR ${table.operatorRetryRequestedAt} >= ${table.requestedAt})
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.requestedAt})`,
		),
		check(
			"workspace_erasure_jobs_operator_retry_check",
			sql`${table.operatorRetryRequestedAt} IS NULL
				OR (${table.status} = 'failed'
					AND ${table.leaseExpiresAt} IS NULL
					AND ${table.completedAt} IS NULL)`,
		),
		index("workspace_erasure_jobs_org_status_idx").on(
			table.organizationId,
			table.status,
		),
		index("workspace_erasure_jobs_due_idx").on(
			table.status,
			table.nextAttemptAt,
			table.leaseExpiresAt,
		),
	],
);

/** Bounded checkpoints for each independently retryable erasure phase. */
export const workspaceErasureSteps = pgTable(
	"workspace_erasure_steps",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("wes_")),
		workspaceId: text("workspace_id").notNull(),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		stepKey: text("step_key").notNull(),
		status: text("status", {
			enum: ["pending", "processing", "completed", "failed", "manual_review"],
		})
			.notNull()
			.default("pending"),
		cursor: jsonb("cursor"),
		rowsDeleted: integer("rows_deleted").notNull().default(0),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.workspaceId, table.organizationId, table.scopeKey],
			foreignColumns: [
				workspaceErasureJobs.workspaceId,
				workspaceErasureJobs.organizationId,
				workspaceErasureJobs.scopeKey,
			],
			name: "workspace_erasure_steps_job_org_scope_fk",
		}).onDelete("cascade"),
		uniqueIndex("workspace_erasure_steps_workspace_key_uniq").on(
			table.workspaceId,
			table.stepKey,
		),
		check(
			"workspace_erasure_steps_status_check",
			sql`${table.status} IN ('pending', 'processing', 'completed', 'failed', 'manual_review')`,
		),
		check(
			"workspace_erasure_steps_counters_nonnegative_check",
			sql`${table.rowsDeleted} >= 0 AND ${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"workspace_erasure_steps_lease_state_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"workspace_erasure_steps_completion_check",
			sql`(${table.status} = 'completed' AND ${table.completedAt} IS NOT NULL)
				OR (${table.status} <> 'completed' AND ${table.completedAt} IS NULL)`,
		),
		check(
			"workspace_erasure_steps_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
		),
		index("workspace_erasure_steps_due_idx").on(
			table.status,
			table.nextAttemptAt,
			table.leaseExpiresAt,
		),
		index("workspace_erasure_steps_completed_retention_idx")
			.on(table.completedAt, table.id)
			.where(sql`${table.status} = 'completed'`),
	],
);

/**
 * Non-billing organization behavior and its compare-and-swap revision. Audit
 * actors are nullable because service-key and user-driven changes are distinct.
 */
export const organizationSettings = pgTable(
	"organization_settings",
	{
		organizationId: text("organization_id")
			.primaryKey()
			.references(() => organization.id, { onDelete: "cascade" }),
		requireWorkspaceId: boolean("require_workspace_id")
			.notNull()
			.default(false),
		revision: integer("revision").notNull().default(0),
		updatedByUserId: text("updated_by_user_id").references(() => user.id, {
			onDelete: "set null",
		}),
		updatedByApiKeyId: text("updated_by_api_key_id").references(
			() => apikey.id,
			{ onDelete: "set null" },
		),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		check(
			"organization_settings_revision_nonnegative_check",
			sql`${table.revision} >= 0`,
		),
		check(
			"organization_settings_single_actor_check",
			sql`${table.updatedByUserId} IS NULL OR ${table.updatedByApiKeyId} IS NULL`,
		),
		check(
			"organization_settings_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}`,
		),
	],
);

export interface QueueScheduleSlot {
	day_of_week: number;
	time: string;
	timezone: string;
}

/**
 * Authoritative posting schedule configuration. KV may cache this relation for
 * short reads, but never owns it: the prior no-TTL JSON blob could disappear,
 * outlive tenant erasure, or lose concurrent writes.
 *
 * Slots stay JSONB because they are a small atomic configuration value with no
 * independent identity or query path. The API validates the complete
 * day/time/timezone shape; PostgreSQL enforces a non-empty array and the one
 * default schedule per tenant invariant.
 */
export const queueSchedules = pgTable(
	"queue_schedules",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("qs_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name"),
		slots: jsonb("slots").$type<QueueScheduleSlot[]>().notNull(),
		isDefault: boolean("is_default").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("queue_schedules_id_org_uniq").on(table.id, table.organizationId),
		uniqueIndex("queue_schedules_one_default_per_org_uniq")
			.on(table.organizationId)
			.where(sql`${table.isDefault} = true`),
		check(
			"queue_schedules_name_check",
			sql`${table.name} IS NULL OR (length(btrim(${table.name})) > 0 AND length(${table.name}) <= 255)`,
		),
		check(
			"queue_schedules_slots_check",
			sql`jsonb_typeof(${table.slots}) = 'array' AND jsonb_array_length(${table.slots}) > 0`,
		),
		check(
			"queue_schedules_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}`,
		),
		index("queue_schedules_org_created_idx").on(
			table.organizationId,
			table.createdAt,
			table.id,
		),
	],
);

/**
 * Durable tenant-deletion state. It intentionally has no FK to auth.organization
 * so the final cleanup receipt and audit snapshot survive organization purge.
 */
export const tenantDeletionJobs = pgTable(
	"tenant_deletion_jobs",
	{
		organizationId: text("organization_id").primaryKey(),
		status: text("status", {
			enum: [
				"pending",
				"processing",
				"tombstoned",
				"waiting_external",
				"held",
				"manual_review",
				"failed",
				"purged",
			],
		})
			.notNull()
			.default("pending"),
		requestedBy: text("requested_by"),
		auditSnapshot: jsonb("audit_snapshot").notNull().default(sql`'{}'::jsonb`),
		cleanupPayload: jsonb("cleanup_payload")
			.notNull()
			.default(sql`'{}'::jsonb`),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		leaseToken: integer("lease_token").notNull().default(0),
		lastError: text("last_error"),
		requestedAt: timestamp("requested_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		agedAlertedAt: timestamp("aged_alerted_at", { withTimezone: true }),
		operatorRetryRequestedAt: timestamp("operator_retry_requested_at", {
			withTimezone: true,
		}),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		check(
			"tenant_deletion_jobs_status_check",
			sql`${table.status} IN ('pending', 'processing', 'tombstoned', 'waiting_external', 'held', 'manual_review', 'failed', 'purged')`,
		),
		check(
			"tenant_deletion_jobs_attempts_nonnegative_check",
			sql`${table.attempts} >= 0`,
		),
		check(
			"tenant_deletion_jobs_lease_token_nonnegative_check",
			sql`${table.leaseToken} >= 0`,
		),
		check(
			"tenant_deletion_jobs_lease_state_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"tenant_deletion_jobs_completion_check",
			sql`(${table.status} = 'purged' AND ${table.completedAt} IS NOT NULL)
				OR (${table.status} <> 'purged' AND ${table.completedAt} IS NULL)`,
		),
		check(
			"tenant_deletion_jobs_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.requestedAt}
				AND (${table.agedAlertedAt} IS NULL OR ${table.agedAlertedAt} >= ${table.requestedAt})
				AND (${table.operatorRetryRequestedAt} IS NULL OR ${table.operatorRetryRequestedAt} >= ${table.requestedAt})
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.requestedAt})`,
		),
		check(
			"tenant_deletion_jobs_operator_retry_check",
			sql`${table.operatorRetryRequestedAt} IS NULL
				OR (${table.status} = 'failed'
					AND ${table.leaseExpiresAt} IS NULL
					AND ${table.completedAt} IS NULL)`,
		),
		index("tenant_deletion_jobs_due_idx").on(table.status, table.nextAttemptAt),
	],
);

/** Resumable, bounded progress for each independently retryable purge phase. */
export const tenantDeletionSteps = pgTable(
	"tenant_deletion_steps",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("tds_")),
		organizationId: text("organization_id").notNull(),
		stepKey: text("step_key").notNull(),
		status: text("status", {
			enum: ["pending", "processing", "completed", "failed", "manual_review"],
		})
			.notNull()
			.default("pending"),
		cursor: jsonb("cursor"),
		rowsDeleted: integer("rows_deleted").notNull().default(0),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.organizationId],
			foreignColumns: [tenantDeletionJobs.organizationId],
			name: "tenant_deletion_steps_job_fk",
		}).onDelete("cascade"),
		uniqueIndex("tenant_deletion_steps_org_key_uniq").on(
			table.organizationId,
			table.stepKey,
		),
		check(
			"tenant_deletion_steps_status_check",
			sql`${table.status} IN ('pending', 'processing', 'completed', 'failed', 'manual_review')`,
		),
		check(
			"tenant_deletion_steps_counters_nonnegative_check",
			sql`${table.rowsDeleted} >= 0 AND ${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"tenant_deletion_steps_lease_state_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"tenant_deletion_steps_completion_check",
			sql`(${table.status} = 'completed' AND ${table.completedAt} IS NOT NULL)
				OR (${table.status} <> 'completed' AND ${table.completedAt} IS NULL)`,
		),
		check(
			"tenant_deletion_steps_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
		),
		index("tenant_deletion_steps_due_idx").on(
			table.status,
			table.nextAttemptAt,
			table.leaseExpiresAt,
		),
		index("tenant_deletion_steps_completed_retention_idx")
			.on(table.completedAt, table.id)
			.where(sql`${table.status} = 'completed'`),
	],
);

export const inviteTokens = pgTable(
	"invite_tokens",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("inv_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		createdBy: text("created_by")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		createdByPrincipalId: text("created_by_principal_id").notNull(),
		issuerCredentialVersion: text("issuer_credential_version")
			.default(LEGACY_CREDENTIAL_VERSION)
			.notNull(),
		tokenHash: varchar("token_hash", { length: 64 }).notNull(),
		scopeMode: text("scope_mode", {
			enum: ["all", "selected"],
		}).notNull(),
		role: text("role", { enum: [...INVITE_TOKEN_ROLES] }).notNull(),
		used: boolean("used").notNull().generatedAlwaysAs(sql`used_at IS NOT NULL`),
		// Stable pseudonymous principal evidence deliberately has no FK: deleting
		// the redeemed member must not make the exact consumption tuple invalid.
		usedBy: text("used_by"),
		redeemedByUserId: text("redeemed_by_user_id").references(() => user.id, {
			onDelete: "set null",
		}),
		usedAt: timestamp("used_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.createdByPrincipalId, table.organizationId],
			foreignColumns: [
				organizationPrincipals.id,
				organizationPrincipals.organizationId,
			],
			name: "invite_tokens_issuer_principal_org_fk",
		}).onDelete("cascade"),
		unique("invite_tokens_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeMode,
		),
		uniqueIndex("invite_tokens_hash_idx").on(table.tokenHash),
		check(
			"invite_tokens_hash_check",
			sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"invite_tokens_scope_mode_check",
			sql`${table.scopeMode} IN ('all', 'selected')`,
		),
		check(
			"invite_tokens_role_check",
			sql`${table.role} IN ('owner', 'admin', 'member')`,
		),
		check(
			"invite_tokens_consumption_tuple_check",
			sql`(${table.usedAt} IS NULL AND ${table.usedBy} IS NULL)
				OR (${table.usedAt} IS NOT NULL AND ${table.usedBy} IS NOT NULL)`,
		),
		check(
			"invite_tokens_expiry_window_check",
			sql`${table.expiresAt} > ${table.createdAt}
				AND (
					(${table.role} = 'owner'
						AND ${table.expiresAt} <= ${table.createdAt} + interval '24 hours')
					OR (${table.role} IN ('admin', 'member')
						AND ${table.expiresAt} <= ${table.createdAt} + interval '7 days')
				)`,
		),
		check(
			"invite_tokens_used_timestamp_order_check",
			sql`${table.usedAt} IS NULL
				OR (${table.usedAt} >= ${table.createdAt}
					AND ${table.usedAt} < ${table.expiresAt})`,
		),
		index("invite_tokens_org_created_idx").on(
			table.organizationId,
			table.createdAt,
			table.id,
		),
		index("invite_tokens_expiry_idx").on(table.expiresAt, table.id),
	],
);

/**
 * Immutable workspace evidence captured when a selected-scope token is minted.
 * Redemption copies these rows into principal_workspace_grants atomically.
 */
export const inviteTokenWorkspaces = pgTable(
	"invite_token_workspaces",
	{
		organizationId: text("organization_id").notNull(),
		inviteTokenId: text("invite_token_id").notNull(),
		workspaceId: text("workspace_id").notNull(),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		scopeMode: text("scope_mode", { enum: ["selected"] })
			.notNull()
			.default("selected"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		primaryKey({
			name: "invite_token_workspaces_pkey",
			columns: [table.organizationId, table.inviteTokenId, table.workspaceId],
		}),
		foreignKey({
			columns: [table.inviteTokenId, table.organizationId, table.scopeMode],
			foreignColumns: [
				inviteTokens.id,
				inviteTokens.organizationId,
				inviteTokens.scopeMode,
			],
			name: "invite_token_workspaces_selected_token_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "invite_token_workspaces_workspace_org_fk",
		}).onDelete("cascade"),
		check(
			"invite_token_workspaces_scope_mode_check",
			sql`${table.scopeMode} = 'selected'`,
		),
		index("invite_token_workspaces_workspace_idx").on(
			table.organizationId,
			table.workspaceId,
			table.inviteTokenId,
		),
		index("invite_token_workspaces_retention_idx").on(
			table.inviteTokenId,
			table.workspaceId,
		),
	],
);

export const socialAccounts = pgTable(
	"social_accounts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("acc_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		platform: platformEnum("platform").notNull(),
		platformAccountId: text("platform_account_id").notNull(),
		webhookAccountId: text("webhook_account_id"), // platform ID used in webhook entry.id (e.g. Instagram app-scoped IGUID)
		username: text("username"),
		displayName: text("display_name"),
		avatarUrl: text("avatar_url"),
		accessToken: text("access_token"), // encrypted: AES-256-GCM
		refreshToken: text("refresh_token"), // encrypted: AES-256-GCM
		// Monotonic credential-source fence. Connector writes and provider refreshes
		// advance it; encryption-key rotation deliberately does not.
		tokenVersion: integer("token_version").notNull().default(0),
		tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
		scopes: text("scopes").array(),
		metadata: jsonb("metadata"), // custom data (e.g. reseller customer mapping)
		lifecycleStatus: text("lifecycle_status", {
			enum: ["active", "disconnecting", "disconnected"],
		})
			.notNull()
			.default("active"),
		disconnectRequestedAt: timestamp("disconnect_requested_at", {
			withTimezone: true,
		}),
		disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
		disconnectReason: text("disconnect_reason"),
		schedulingPreferences: jsonb("scheduling_preferences").$type<{
			posting_windows?: Array<{
				day_of_week: number;
				start_hour: number;
				end_hour: number;
			}>;
			max_posts_per_day?: number;
			min_gap_minutes?: number;
		}>(),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		connectedAt: timestamp("connected_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("social_accounts_id_org_uniq").on(table.id, table.organizationId),
		unique("social_accounts_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		unique("social_accounts_id_org_scope_platform_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
			table.platform,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "social_accounts_workspace_org_fk",
		}),
		check(
			"social_accounts_lifecycle_status_check",
			sql`${table.lifecycleStatus} IN ('active', 'disconnecting', 'disconnected')`,
		),
		check(
			"social_accounts_token_version_nonnegative_check",
			sql`${table.tokenVersion} >= 0`,
		),
		check(
			"social_accounts_disconnect_timestamps_check",
			sql`(${table.lifecycleStatus} = 'active' AND ${table.disconnectedAt} IS NULL)
				OR (${table.lifecycleStatus} = 'disconnecting' AND ${table.disconnectRequestedAt} IS NOT NULL AND ${table.disconnectedAt} IS NULL)
				OR (${table.lifecycleStatus} = 'disconnected' AND ${table.disconnectRequestedAt} IS NOT NULL AND ${table.disconnectedAt} IS NOT NULL)`,
		),
		uniqueIndex("social_accounts_org_platform_account_idx").on(
			table.organizationId,
			table.platform,
			table.platformAccountId,
		),
		index("social_accounts_org_idx").on(table.organizationId),
		index("social_accounts_webhook_id_idx").on(
			table.platform,
			table.webhookAccountId,
		),
		index("social_accounts_workspace_idx").on(table.workspaceId),
		index("social_accounts_org_lifecycle_idx").on(
			table.organizationId,
			table.lifecycleStatus,
		),
		// Twilio BYOC webhooks authenticate by their signed AccountSid. Keeping
		// this partial avoids adding write/storage overhead for other platforms.
		index("social_accounts_sms_webhook_route_idx")
			.on(table.platformAccountId)
			.where(
				sql`${table.platform} = 'sms' AND ${table.lifecycleStatus} = 'active'`,
			),
		// Daily token-refresh cron scans accounts by expiry.
		index("social_accounts_token_expiry_idx")
			.on(table.tokenExpiresAt)
			.where(sql`${table.lifecycleStatus} = 'active'`),
	],
);

/**
 * Durable provider-token revocation work. The ciphertext is retained here until
 * remote revocation succeeds (or is explicitly classified as manual-only), so
 * a local disconnect never destroys the sole credential needed for cleanup.
 */
export const accountRevocationJobs = pgTable(
	"account_revocation_jobs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("arj_")),
		accountId: text("account_id").notNull().unique(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		platform: platformEnum("platform").notNull(),
		accessTokenCiphertext: text("access_token_ciphertext"),
		refreshTokenCiphertext: text("refresh_token_ciphertext"),
		// Independent grant fence. Ciphertext may change during key rotation while
		// this source version remains stable. Callers must bind every job to the
		// exact grant being revoked; there is no meaningful fallback version.
		sourceTokenVersion: integer("source_token_version").notNull(),
		status: text("status", {
			enum: [
				"pending",
				"processing",
				"retry",
				"unknown",
				"manual_required",
				"succeeded",
				"abandoned",
			],
		})
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		lastError: text("last_error"),
		providerResponse: jsonb("provider_response"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.accountId, table.organizationId],
			foreignColumns: [socialAccounts.id, socialAccounts.organizationId],
			name: "account_revocation_jobs_account_org_fk",
		}).onDelete("cascade"),
		check(
			"account_revocation_jobs_status_check",
			sql`${table.status} IN ('pending', 'processing', 'retry', 'unknown', 'manual_required', 'succeeded', 'abandoned')`,
		),
		check(
			"account_revocation_jobs_counters_nonnegative_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0 AND ${table.sourceTokenVersion} >= 0`,
		),
		check(
			"account_revocation_jobs_lease_state_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"account_revocation_jobs_completion_check",
			sql`(${table.status} IN ('manual_required', 'succeeded', 'abandoned') AND ${table.completedAt} IS NOT NULL)
				OR (${table.status} NOT IN ('manual_required', 'succeeded', 'abandoned') AND ${table.completedAt} IS NULL)`,
		),
		check(
			"account_revocation_jobs_terminal_redaction_check",
			sql`${table.status} NOT IN ('manual_required', 'succeeded', 'abandoned')
				OR (${table.accessTokenCiphertext} IS NULL AND ${table.refreshTokenCiphertext} IS NULL)`,
		),
		check(
			"account_revocation_jobs_request_boundary_check",
			sql`(${table.status} NOT IN ('pending', 'retry')
					OR ${table.requestMayHaveBeenSentAt} IS NULL)
				AND (${table.status} <> 'unknown'
					OR ${table.requestMayHaveBeenSentAt} IS NOT NULL)`,
		),
		check(
			"account_revocation_jobs_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND (${table.requestMayHaveBeenSentAt} IS NULL OR ${table.requestMayHaveBeenSentAt} >= ${table.createdAt})
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
		),
		index("account_revocation_jobs_due_idx").on(
			table.status,
			table.nextAttemptAt,
			table.createdAt,
			table.id,
		),
		index("account_revocation_jobs_org_idx").on(table.organizationId),
		index("account_revocation_jobs_retention_idx")
			.on(table.completedAt, table.id)
			.where(
				sql`${table.status} IN ('manual_required', 'succeeded', 'abandoned')
					AND ${table.completedAt} IS NOT NULL`,
			),
	],
);

/**
 * Durable per-account OAuth refresh coordination state.
 *
 * `request_may_have_been_sent` and `unknown` deliberately have no automatic
 * lease-reclaim path: a rotating refresh token may already have been consumed
 * by the provider. A reconnect or another authoritative token write advances
 * `social_accounts.token_version`, which safely supersedes the old operation.
 */
export const tokenRefreshOperations = pgTable(
	"token_refresh_operations",
	{
		accountId: text("account_id")
			.primaryKey()
			.references(() => socialAccounts.id, { onDelete: "cascade" }),
		operationId: text("operation_id").notNull(),
		state: text("state")
			.$type<
				| "claimed_pre_request"
				| "request_may_have_been_sent"
				| "succeeded"
				| "unknown"
			>()
			.notNull(),
		fencingToken: integer("fencing_token").notNull().default(0),
		sourceTokenVersion: integer("source_token_version").notNull(),
		attempts: integer("attempts").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		startedAt: timestamp("started_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		lastError: text("last_error"),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("token_refresh_operations_operation_id_idx").on(
			table.operationId,
		),
		check(
			"token_refresh_operations_state_check",
			sql`${table.state} IN ('claimed_pre_request', 'request_may_have_been_sent', 'succeeded', 'unknown')`,
		),
		check(
			"token_refresh_operations_counters_nonnegative_check",
			sql`${table.fencingToken} >= 0 AND ${table.sourceTokenVersion} >= 0 AND ${table.attempts} >= 0`,
		),
		check(
			"token_refresh_operations_state_fields_check",
			sql`(${table.state} = 'claimed_pre_request'
					AND ${table.leaseExpiresAt} IS NOT NULL
					AND ${table.requestMayHaveBeenSentAt} IS NULL
					AND ${table.completedAt} IS NULL)
				OR (${table.state} = 'request_may_have_been_sent'
					AND ${table.leaseExpiresAt} IS NULL
					AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
					AND ${table.completedAt} IS NULL)
				OR (${table.state} = 'succeeded'
					AND ${table.leaseExpiresAt} IS NULL
					AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
					AND ${table.completedAt} IS NOT NULL)
				OR (${table.state} = 'unknown'
					AND ${table.leaseExpiresAt} IS NULL
					AND ${table.requestMayHaveBeenSentAt} IS NOT NULL)`,
		),
		check(
			"token_refresh_operations_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.startedAt}
				AND (${table.requestMayHaveBeenSentAt} IS NULL OR ${table.requestMayHaveBeenSentAt} >= ${table.startedAt})
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt})`,
		),
		index("token_refresh_operations_retention_idx")
			.on(
				sql`COALESCE(${table.completedAt}, ${table.updatedAt})`,
				table.accountId,
			)
			.where(sql`${table.state} IN ('succeeded', 'unknown')`),
	],
);

/** Explicit parent for an ordered, workspace-consistent publishing thread. */
export const postThreads = pgTable(
	"post_threads",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		revision: integer("revision").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("post_threads_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "post_threads_workspace_org_fk",
		}).onDelete("restrict"),
		check(
			"post_threads_revision_nonnegative_check",
			sql`${table.revision} >= 0`,
		),
		index("post_threads_org_scope_idx").on(
			table.organizationId,
			table.scopeKey,
		),
	],
);

export const posts = pgTable(
	"posts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("post_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		content: text("content"),
		status: postStatusEnum("status").notNull().default("draft"),
		revision: integer("revision").notNull().default(0),
		scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		timezone: text("timezone").notNull().default("UTC"),
		platformOverrides: jsonb("platform_overrides"),
		recycledFromId: text("recycled_from_id").references(
			(): AnyPgColumn => posts.id,
			{ onDelete: "set null" },
		),
		createdBy: text("created_by").references(() => user.id, {
			onDelete: "set null",
		}),
		// Aggregated metrics snapshot for fast Sent tab display
		metricsSnapshot: jsonb("metrics_snapshot")
			.$type<{
				impressions?: number;
				reach?: number;
				likes?: number;
				comments?: number;
				shares?: number;
				saves?: number;
				clicks?: number;
				views?: number;
				engagement_rate?: number;
			}>()
			.default({}),
		metricsCollectedAt: timestamp("metrics_collected_at", {
			withTimezone: true,
		}),
		metricsNextPollAt: timestamp("metrics_next_poll_at", {
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
		metricsPollAttempts: integer("metrics_poll_attempts").notNull().default(0),
		metricsPollLastError: text("metrics_poll_last_error"),
		metricsPollLastErrorClass: text("metrics_poll_last_error_class", {
			enum: ["transient", "rate_limited", "permanent"],
		}),
		// Scheduler-owned analytics claim. Freshness remains in
		// metrics_collected_at; queue redelivery must claim started_at before a
		// provider read and completion is fenced by the observation window.
		metricsRefreshWindowStart: timestamp("metrics_refresh_window_start", {
			withTimezone: true,
		}),
		metricsRefreshLeaseExpiresAt: timestamp(
			"metrics_refresh_lease_expires_at",
			{ withTimezone: true },
		),
		metricsRefreshStartedAt: timestamp("metrics_refresh_started_at", {
			withTimezone: true,
		}),
		notes: text("notes"),
		// Threading support
		threadGroupId: text("thread_group_id"), // UUID grouping all posts in a thread (null = standalone)
		threadPosition: integer("thread_position"), // 0-based order within thread (null = standalone)
		threadDelayMs: integer("thread_delay_ms").default(0), // delay before publishing this item (ms, relative to previous)
		terminalReason: jsonb("terminal_reason").$type<{
			code: string;
			message: string;
			failed_position?: number;
		}>(),
		publishLeaseId: text("publish_lease_id"),
		publishLeaseExpiresAt: timestamp("publish_lease_expires_at", {
			withTimezone: true,
		}),
		publishAttempts: integer("publish_attempts").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("posts_id_org_uniq").on(table.id, table.organizationId),
		unique("posts_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "posts_workspace_org_fk",
		}),
		foreignKey({
			columns: [table.threadGroupId, table.organizationId, table.scopeKey],
			foreignColumns: [
				postThreads.id,
				postThreads.organizationId,
				postThreads.scopeKey,
			],
			name: "posts_thread_org_scope_fk",
		}),
		check(
			"posts_thread_fields_pair_check",
			sql`(${table.threadGroupId} IS NULL) = (${table.threadPosition} IS NULL)`,
		),
		check(
			"posts_thread_position_nonnegative_check",
			sql`${table.threadPosition} IS NULL OR ${table.threadPosition} >= 0`,
		),
		check(
			"posts_thread_delay_nonnegative_check",
			sql`${table.threadDelayMs} IS NULL OR ${table.threadDelayMs} >= 0`,
		),
		check(
			"posts_publish_attempts_nonnegative_check",
			sql`${table.publishAttempts} >= 0`,
		),
		check(
			"posts_metrics_poll_state_check",
			sql`${table.metricsPollAttempts} >= 0
				AND (${table.metricsPollLastErrorClass} IS NULL
					OR ${table.metricsPollLastErrorClass} IN ('transient', 'rate_limited', 'permanent'))`,
		),
		check("posts_revision_nonnegative_check", sql`${table.revision} >= 0`),
		check(
			"posts_metrics_refresh_claim_check",
			sql`(${table.metricsRefreshLeaseExpiresAt} IS NULL
					AND ${table.metricsRefreshStartedAt} IS NULL)
				OR (${table.metricsRefreshLeaseExpiresAt} IS NOT NULL
					AND ${table.metricsRefreshWindowStart} IS NOT NULL
					AND (${table.metricsRefreshStartedAt} IS NULL
						OR ${table.metricsRefreshStartedAt} <= ${table.metricsRefreshLeaseExpiresAt}))`,
		),
		uniqueIndex("posts_thread_position_uniq")
			.on(
				table.organizationId,
				table.scopeKey,
				table.threadGroupId,
				table.threadPosition,
			)
			.where(sql`${table.threadGroupId} IS NOT NULL`),
		index("posts_org_created_idx").on(table.organizationId, table.createdAt),
		index("posts_org_published_idx").on(
			table.organizationId,
			table.publishedAt,
		),
		index("posts_workspace_idx").on(table.workspaceId),
		index("posts_org_workspace_created_idx").on(
			table.organizationId,
			table.workspaceId,
			table.createdAt,
		),
		index("posts_status_scheduled_idx").on(table.status, table.scheduledAt),
		index("posts_publish_lease_idx").on(
			table.status,
			table.publishLeaseExpiresAt,
		),
		index("posts_recycled_from_idx").on(table.recycledFromId),
		index("posts_thread_group_idx").on(
			table.threadGroupId,
			table.threadPosition,
		),
		// Supports GET /v1/posts, which orders + cursors on
		// coalesce(published_at, created_at) DESC. Neither single-column index
		// above can satisfy the expression, so the list endpoint top-N sorts
		// the whole org partition without this.
		index("posts_org_effective_date_idx").on(
			table.organizationId,
			sql`coalesce(${table.publishedAt}, ${table.createdAt}) desc`,
			sql`${table.id} desc`,
		),
		// Cron metrics-refresh scan: published posts ordered by collection time.
		index("posts_metrics_refresh_idx")
			.on(table.metricsNextPollAt, table.metricsRefreshLeaseExpiresAt)
			.where(sql`${table.status} = 'published'`),
	],
);

export const threadExecutions = pgTable(
	"thread_executions",
	{
		threadGroupId: text("thread_group_id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		status: text("status", {
			enum: ["queued", "in_flight", "completed", "failed", "unknown"],
		})
			.notNull()
			.default("queued"),
		leaseId: text("lease_id"),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		currentPosition: integer("current_position").notNull().default(0),
		attempts: integer("attempts").notNull().default(0),
		failedPosition: integer("failed_position"),
		failure: jsonb("failure").$type<{ code: string; message: string }>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "thread_executions_workspace_org_fk",
		}),
		foreignKey({
			columns: [table.threadGroupId, table.organizationId, table.scopeKey],
			foreignColumns: [
				postThreads.id,
				postThreads.organizationId,
				postThreads.scopeKey,
			],
			name: "thread_executions_thread_org_scope_fk",
		}).onDelete("cascade"),
		check(
			"thread_executions_status_check",
			sql`${table.status} IN ('queued', 'in_flight', 'completed', 'failed', 'unknown')`,
		),
		check(
			"thread_executions_counters_nonnegative_check",
			sql`${table.currentPosition} >= 0 AND ${table.attempts} >= 0 AND (${table.failedPosition} IS NULL OR ${table.failedPosition} >= 0)`,
		),
		check(
			"thread_executions_lease_pair_check",
			sql`(${table.leaseId} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"thread_executions_in_flight_check",
			sql`${table.status} <> 'in_flight'
				OR (${table.leaseId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
		),
		check(
			"thread_executions_failure_check",
			sql`${table.failedPosition} IS NULL OR ${table.failure} IS NOT NULL`,
		),
		check(
			"thread_executions_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}`,
		),
		index("thread_executions_org_status_idx").on(
			table.organizationId,
			table.status,
			table.leaseExpiresAt,
		),
		index("thread_executions_status_lease_idx").on(
			table.status,
			table.leaseExpiresAt,
		),
		index("thread_executions_retention_idx")
			.on(table.updatedAt, table.threadGroupId)
			.where(sql`${table.status} IN ('completed', 'failed', 'unknown')`),
	],
);

/**
 * Bot-mediated Telegram ownership challenges. The workspace chosen by the
 * authenticated initiator is persisted here so the later unauthenticated bot
 * event can only create an account in that authoritative scope.
 */
export const telegramConnectionChallenges = pgTable(
	"telegram_connection_challenges",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		apiKeyId: text("api_key_id").notNull(),
		authoritySessionId: text("authority_session_id").references(
			() => session.id,
			{ onDelete: "cascade" },
		),
		initialWorkspaceScope: jsonb("initial_workspace_scope").notNull(),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		status: text("status", {
			enum: ["pending", "processing", "connected"],
		})
			.notNull()
			.default("pending"),
		chatId: text("chat_id"),
		chatTitle: text("chat_title"),
		accountId: text("account_id").references(() => socialAccounts.id, {
			onDelete: "set null",
		}),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.apiKeyId, table.organizationId],
			foreignColumns: [apikey.id, apikey.organizationId],
			name: "telegram_connection_challenges_api_key_org_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "telegram_connection_challenges_workspace_org_fk",
		}).onDelete("restrict"),
		foreignKey({
			columns: [table.accountId, table.organizationId, table.scopeKey],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
			],
			name: "telegram_connection_challenges_account_org_scope_fk",
		}),
		check(
			"telegram_connection_challenges_initial_scope_check",
			sql`${table.initialWorkspaceScope} = '"all"'::jsonb OR (jsonb_typeof(${table.initialWorkspaceScope}) = 'array' AND jsonb_array_length(${table.initialWorkspaceScope}) > 0)`,
		),
		check(
			"telegram_connection_challenges_status_check",
			sql`${table.status} IN ('pending', 'processing', 'connected')`,
		),
		check(
			"telegram_connection_challenges_expiry_check",
			sql`${table.expiresAt} > ${table.createdAt}`,
		),
		check(
			"telegram_connection_challenges_completion_check",
			sql`${table.status} <> 'connected' OR (${table.accountId} IS NOT NULL AND ${table.chatId} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`,
		),
		index("telegram_connection_challenges_org_scope_status_idx").on(
			table.organizationId,
			table.scopeKey,
			table.status,
		),
		index("telegram_connection_challenges_org_workspace_idx").on(
			table.organizationId,
			table.workspaceId,
		),
		index("telegram_connection_challenges_api_key_status_idx").on(
			table.apiKeyId,
			table.status,
		),
		index("telegram_connection_challenges_expiry_idx").on(
			table.expiresAt,
			table.id,
		),
	],
);

/**
 * Resolve the later-declared attempt tuple without weakening the inferred
 * table types. Drizzle evaluates table extra-config callbacks after the module
 * has initialized, so the circular current-projection/audit relationship is
 * safe to resolve here.
 */
function currentPublishAttemptIdentityColumns(): [
	AnyPgColumn,
	AnyPgColumn,
	AnyPgColumn,
] {
	return [
		publishAttempts.id,
		publishAttempts.postTargetId,
		publishAttempts.publishOperationId,
	];
}

export const postTargets = pgTable(
	"post_targets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("pt_")),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		postId: text("post_id").notNull(),
		socialAccountId: text("social_account_id").notNull(),
		platform: platformEnum("platform").notNull(),
		status: postStatusEnum("status").notNull().default("draft"),
		publishOperationId: text("publish_operation_id")
			.notNull()
			.$defaultFn(() => generateId("pubop_")),
		deliveryState: text("delivery_state", {
			enum: ["queued", "in_flight", "succeeded", "failed", "unknown"],
		})
			.notNull()
			.default("queued"),
		attemptId: text("attempt_id"),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		platformPostId: text("platform_post_id"),
		/** Last provider-confirmed body, which can diverge after a partial edit. */
		confirmedContent: text("confirmed_content"),
		editRevision: integer("edit_revision").notNull().default(0),
		lastEditedAt: timestamp("last_edited_at", { withTimezone: true }),
		platformPostIdHistory: jsonb("platform_post_id_history")
			.$type<
				Array<{
					id: string;
					replaced_at: string;
					operation_id: string;
				}>
			>()
			.notNull()
			.default([]),
		platformUrl: text("platform_url"),
		providerDisposition: text("provider_disposition", {
			enum: [
				"published",
				"provider_draft",
				"sent",
				"delivered",
				"scheduled",
				"accepted",
				"processing",
				"pending_review",
				"awaiting_user_action",
				"partial",
				"failed",
				"outcome_unknown",
			],
		}),
		providerOperationId: text("provider_operation_id"),
		providerState: text("provider_state"),
		providerEffects:
			jsonb("provider_effects").$type<
				Array<{
					name: string;
					status: "succeeded" | "failed" | "unsupported" | "outcome_unknown";
					provider_id?: string;
					error?: { code: string; message: string };
				}>
			>(),
		nextReconcileAt: timestamp("next_reconcile_at", { withTimezone: true }),
		reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
		error: text("error"),
		errorCode: text("error_code"),
		errorDetail: text("error_detail"),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("post_targets_id_publish_operation_uniq").on(
			table.id,
			table.publishOperationId,
		),
		unique("post_targets_id_post_org_scope_platform_uniq").on(
			table.id,
			table.postId,
			table.organizationId,
			table.scopeKey,
			table.platform,
		),
		foreignKey({
			columns: [table.postId, table.organizationId, table.scopeKey],
			foreignColumns: [posts.id, posts.organizationId, posts.scopeKey],
			name: "post_targets_post_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [
				table.socialAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
				socialAccounts.platform,
			],
			name: "post_targets_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.attemptId, table.id, table.publishOperationId],
			foreignColumns: currentPublishAttemptIdentityColumns(),
			name: "post_targets_current_attempt_identity_fk",
		}),
		check(
			"post_targets_delivery_state_check",
			sql`${table.deliveryState} IN ('queued', 'in_flight', 'succeeded', 'failed', 'unknown')`,
		),
		check(
			"post_targets_delivery_projection_check",
			sql`(${table.deliveryState} = 'queued')
				OR (${table.deliveryState} = 'in_flight'
					AND ${table.status} = 'publishing'
					AND ${table.attemptId} IS NOT NULL
					AND ${table.claimedAt} IS NOT NULL
					AND ${table.leaseExpiresAt} IS NOT NULL
					AND ${table.requestMayHaveBeenSentAt} IS NULL)
				OR (${table.deliveryState} = 'unknown'
					AND ${table.status} = 'publishing'
					AND ${table.attemptId} IS NOT NULL
					AND ${table.claimedAt} IS NOT NULL
					AND ${table.requestMayHaveBeenSentAt} IS NOT NULL)
				OR (${table.deliveryState} = 'succeeded'
					AND (
						(${table.status} = 'published' AND ${table.publishedAt} IS NOT NULL)
						OR (${table.status}::text = 'provider_draft'
							AND ${table.providerDisposition} = 'provider_draft'
							AND ${table.publishedAt} IS NULL)
					))
				OR (${table.deliveryState} = 'failed' AND ${table.status} = 'failed')`,
		),
		check(
			"post_targets_lease_order_check",
			sql`${table.leaseExpiresAt} IS NULL OR (${table.claimedAt} IS NOT NULL AND ${table.leaseExpiresAt} > ${table.claimedAt})`,
		),
		check(
			"post_targets_reconcile_attempts_nonnegative_check",
			sql`${table.reconcileAttempts} >= 0 AND ${table.editRevision} >= 0`,
		),
		check(
			"post_targets_edit_projection_check",
			sql`(${table.lastEditedAt} IS NULL AND ${table.editRevision} = 0)
				OR (${table.lastEditedAt} IS NOT NULL
					AND ${table.editRevision} > 0
					AND ${table.lastEditedAt} <= ${table.updatedAt})`,
		),
		check(
			"post_targets_platform_id_history_check",
			sql`jsonb_typeof(${table.platformPostIdHistory}) = 'array'`,
		),
		check(
			"post_targets_provider_disposition_check",
			sql`${table.providerDisposition} IS NULL OR ${table.providerDisposition} IN ('published', 'provider_draft', 'sent', 'delivered', 'scheduled', 'accepted', 'processing', 'pending_review', 'awaiting_user_action', 'partial', 'failed', 'outcome_unknown')`,
		),
		uniqueIndex("post_targets_publish_operation_idx").on(
			table.publishOperationId,
		),
		uniqueIndex("post_targets_post_account_idx").on(
			table.postId,
			table.socialAccountId,
		),
		index("post_targets_post_status_idx").on(table.postId, table.status),
		index("post_targets_social_account_id_idx").on(table.socialAccountId),
		index("post_targets_updated_at_idx").on(table.updatedAt),
		index("post_targets_reconcile_due_idx")
			.on(table.nextReconcileAt, table.id)
			.where(
				sql`${table.deliveryState} = 'unknown' AND ${table.nextReconcileAt} IS NOT NULL`,
			),
	],
);

export const publishAttempts = pgTable(
	"publish_attempts",
	{
		id: text("id").primaryKey(),
		publishOperationId: text("publish_operation_id").notNull(),
		postTargetId: text("post_target_id").notNull(),
		state: text("state", {
			enum: ["in_flight", "succeeded", "failed", "unknown"],
		}).notNull(),
		claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
		leaseExpiresAt: timestamp("lease_expires_at", {
			withTimezone: true,
		}).notNull(),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		providerPostId: text("provider_post_id"),
		providerOperationId: text("provider_operation_id"),
		providerDisposition: text("provider_disposition", {
			enum: [
				"published",
				"provider_draft",
				"sent",
				"delivered",
				"scheduled",
				"accepted",
				"processing",
				"pending_review",
				"awaiting_user_action",
				"partial",
				"failed",
				"outcome_unknown",
			],
		}),
		providerState: text("provider_state"),
		providerEffects:
			jsonb("provider_effects").$type<
				Array<{
					name: string;
					status: "succeeded" | "failed" | "unsupported" | "outcome_unknown";
					provider_id?: string;
					error?: { code: string; message: string };
				}>
			>(),
		error: text("error"),
	},
	(table) => [
		unique("publish_attempts_id_target_operation_uniq").on(
			table.id,
			table.postTargetId,
			table.publishOperationId,
		),
		foreignKey({
			columns: [table.postTargetId, table.publishOperationId],
			foreignColumns: [postTargets.id, postTargets.publishOperationId],
			name: "publish_attempts_target_operation_fk",
		}).onDelete("cascade"),
		check(
			"publish_attempts_state_check",
			sql`${table.state} IN ('in_flight', 'succeeded', 'failed', 'unknown')`,
		),
		check(
			"publish_attempts_lease_order_check",
			sql`${table.leaseExpiresAt} > ${table.claimedAt}`,
		),
		check(
			"publish_attempts_completion_check",
			sql`(${table.state} = 'in_flight' AND ${table.completedAt} IS NULL)
				OR (${table.state} IN ('succeeded', 'failed', 'unknown')
					AND ${table.completedAt} IS NOT NULL)`,
		),
		check(
			"publish_attempts_timestamp_order_check",
			sql`${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.claimedAt}`,
		),
		check(
			"publish_attempts_provider_disposition_check",
			sql`${table.providerDisposition} IS NULL OR ${table.providerDisposition} IN ('published', 'provider_draft', 'sent', 'delivered', 'scheduled', 'accepted', 'processing', 'pending_review', 'awaiting_user_action', 'partial', 'failed', 'outcome_unknown')`,
		),
		index("publish_attempts_target_claimed_idx").on(
			table.postTargetId,
			table.claimedAt,
		),
		index("publish_attempts_retention_idx")
			.on(table.completedAt, table.id)
			.where(
				sql`${table.state} IN ('succeeded', 'failed', 'unknown')
					AND ${table.completedAt} IS NOT NULL`,
			),
	],
);

export const publishOutbox = pgTable(
	"publish_outbox",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("out_")),
		operationId: text("operation_id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		postId: text("post_id"),
		kind: text("kind", { enum: [...PUBLISH_OUTBOX_KINDS] }).notNull(),
		payload: jsonb("payload").notNull(),
		status: text("status", { enum: ["pending", "dispatching", "dispatched"] })
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		availableAt: timestamp("available_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.postId, table.organizationId],
			foreignColumns: [posts.id, posts.organizationId],
			name: "publish_outbox_post_org_fk",
		}).onDelete("cascade"),
		check(
			"publish_outbox_kind_check",
			sql`${table.kind} IN ('publish', 'publish_thread', 'notification', 'post_completion')`,
		),
		check(
			"publish_outbox_status_check",
			sql`${table.status} IN ('pending', 'dispatching', 'dispatched')`,
		),
		check(
			"publish_outbox_attempts_nonnegative_check",
			sql`${table.attempts} >= 0`,
		),
		check(
			"publish_outbox_dispatch_completion_check",
			sql`${table.status} <> 'dispatched' OR ${table.dispatchedAt} IS NOT NULL`,
		),
		uniqueIndex("publish_outbox_operation_idx").on(table.operationId),
		index("publish_outbox_pending_idx").on(table.status, table.availableAt),
		// Supports bounded retention cleanup without scanning pending work.
		index("publish_outbox_retention_idx").on(
			table.status,
			table.dispatchedAt,
			table.id,
		),
	],
);

export const postRecyclingConfigs = pgTable(
	"post_recycling_configs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("rc_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		sourcePostId: text("source_post_id").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		gap: integer("gap").notNull(),
		gapFreq: recycleGapFreqEnum("gap_freq").notNull(),
		startDate: timestamp("start_date", { withTimezone: true }).notNull(),
		expireCount: integer("expire_count"),
		expireDate: timestamp("expire_date", { withTimezone: true }),
		contentVariations: jsonb("content_variations")
			.$type<string[]>()
			.default([]),
		recycleCount: integer("recycle_count").notNull().default(0),
		contentVariationIndex: integer("content_variation_index")
			.notNull()
			.default(0),
		nextRecycleAt: timestamp("next_recycle_at", { withTimezone: true }),
		lastRecycledAt: timestamp("last_recycled_at", { withTimezone: true }),
		processingState: text("processing_state", {
			enum: ["pending", "processing", "transient_failure", "terminal_failure"],
		})
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		retryAt: timestamp("retry_at", { withTimezone: true }),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("post_recycling_configs_id_org_uniq").on(
			table.id,
			table.organizationId,
		),
		foreignKey({
			columns: [table.sourcePostId, table.organizationId],
			foreignColumns: [posts.id, posts.organizationId],
			name: "post_recycling_configs_post_org_fk",
		}).onDelete("cascade"),
		check(
			"post_recycling_configs_state_check",
			sql`${table.processingState} IN ('pending', 'processing', 'transient_failure', 'terminal_failure')`,
		),
		check(
			"post_recycling_configs_numeric_check",
			sql`${table.gap} > 0
				AND (${table.expireCount} IS NULL OR ${table.expireCount} > 0)
				AND ${table.recycleCount} >= 0
				AND ${table.contentVariationIndex} >= 0
				AND ${table.attempts} >= 0
				AND ${table.leaseToken} >= 0`,
		),
		index("post_recycling_configs_org_idx").on(table.organizationId),
		index("post_recycling_configs_enabled_next_idx").on(
			table.enabled,
			table.processingState,
			table.nextRecycleAt,
		),
		uniqueIndex("post_recycling_configs_source_post_idx").on(
			table.sourcePostId,
		),
	],
);

export const recyclingOccurrences = pgTable(
	"recycling_occurrences",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("rco_")),
		operationId: text("operation_id").notNull(),
		configId: text("config_id").notNull(),
		organizationId: text("organization_id").notNull(),
		scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
		status: text("status", {
			enum: [
				"processing",
				"committed",
				"transient_failure",
				"terminal_failure",
				"unknown",
			],
		}).notNull(),
		postId: text("post_id").references(() => posts.id, {
			onDelete: "set null",
		}),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.configId, table.organizationId],
			foreignColumns: [
				postRecyclingConfigs.id,
				postRecyclingConfigs.organizationId,
			],
			name: "recycling_occurrences_config_org_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.postId, table.organizationId],
			foreignColumns: [posts.id, posts.organizationId],
			name: "recycling_occurrences_post_org_fk",
		}),
		check(
			"recycling_occurrences_status_check",
			sql`${table.status} IN ('processing', 'committed', 'transient_failure', 'terminal_failure', 'unknown')`,
		),
		uniqueIndex("recycling_occurrences_config_scheduled_idx").on(
			table.configId,
			table.scheduledFor,
		),
		index("recycling_occurrences_post_idx").on(table.postId),
		index("recycling_occurrences_retention_idx")
			.on(table.completedAt, table.id)
			.where(
				sql`${table.status} IN ('committed', 'terminal_failure', 'unknown')
					AND ${table.completedAt} IS NOT NULL`,
			),
	],
);

/**
 * Immutable customer-owned object-store location. Routing fields never change:
 * changing endpoint/bucket/prefix creates another row, while lifecycle columns
 * only record whether this location ever became active and when it retired.
 */
export const storageLocations = pgTable(
	"storage_locations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("sloc_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		provider: text("provider", { enum: ["s3"] })
			.notNull()
			.default("s3"),
		endpoint: text("endpoint").notNull(),
		bucket: text("bucket").notNull(),
		region: text("region").notNull().default("auto"),
		keyPrefix: text("key_prefix").notNull().default("relayapi"),
		forcePathStyle: boolean("force_path_style").notNull().default(false),
		activatedAt: timestamp("activated_at", { withTimezone: true }),
		retiredAt: timestamp("retired_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("storage_locations_id_org_uniq").on(table.id, table.organizationId),
		unique("storage_locations_media_locator_uniq").on(
			table.id,
			table.organizationId,
			table.bucket,
			table.region,
		),
		uniqueIndex("storage_locations_definition_uniq")
			.on(
				table.organizationId,
				table.endpoint,
				table.bucket,
				table.region,
				table.keyPrefix,
				table.forcePathStyle,
			)
			.where(sql`${table.retiredAt} IS NULL`),
		uniqueIndex("storage_locations_org_active_uniq")
			.on(table.organizationId)
			.where(
				sql`${table.activatedAt} IS NOT NULL AND ${table.retiredAt} IS NULL`,
			),
		index("storage_locations_org_created_idx").on(
			table.organizationId,
			table.createdAt,
			table.id,
		),
		check("storage_locations_provider_check", sql`${table.provider} = 's3'`),
		check(
			"storage_locations_endpoint_check",
			sql`${table.endpoint} ~ '^https://' AND ${table.endpoint} !~ '[?#]'`,
		),
		check(
			"storage_locations_key_prefix_check",
			sql`length(${table.keyPrefix}) BETWEEN 1 AND 200
				AND ${table.keyPrefix} !~ '(^/|/$|\\.\\.)'`,
		),
		check(
			"storage_locations_lifecycle_check",
			sql`${table.retiredAt} IS NULL
				OR (${table.activatedAt} IS NOT NULL AND ${table.retiredAt} >= ${table.activatedAt})`,
		),
	],
);

/**
 * Versioned encrypted credentials for one immutable location. Only one tenant
 * credential may be staged and one may be active. Retired versions remain
 * usable for media pinned to them until those objects have been drained.
 */
export const storageCredentials = pgTable(
	"storage_credentials",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("scred_")),
		locationId: text("location_id").notNull(),
		organizationId: text("organization_id").notNull(),
		version: integer("version").notNull(),
		accessKeyId: text("access_key_id").notNull(), // encrypted: AES-256-GCM
		secretAccessKey: text("secret_access_key").notNull(), // encrypted: AES-256-GCM
		state: text("state", {
			enum: ["staged", "active", "retired", "failed"],
		})
			.notNull()
			.default("staged"),
		probeToken: text("probe_token"),
		probeLeaseExpiresAt: timestamp("probe_lease_expires_at", {
			withTimezone: true,
		}),
		lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
		lastErrorCode: text("last_error_code"),
		activatedAt: timestamp("activated_at", { withTimezone: true }),
		retiredAt: timestamp("retired_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.locationId, table.organizationId],
			foreignColumns: [storageLocations.id, storageLocations.organizationId],
			name: "storage_credentials_location_org_fk",
		}).onDelete("restrict"),
		unique("storage_credentials_location_org_version_uniq").on(
			table.locationId,
			table.organizationId,
			table.version,
		),
		uniqueIndex("storage_credentials_org_active_uniq")
			.on(table.organizationId)
			.where(sql`${table.state} = 'active'`),
		uniqueIndex("storage_credentials_org_staged_uniq")
			.on(table.organizationId)
			.where(sql`${table.state} = 'staged'`),
		index("storage_credentials_location_state_idx").on(
			table.locationId,
			table.state,
			table.version,
		),
		check("storage_credentials_version_check", sql`${table.version} > 0`),
		check(
			"storage_credentials_state_check",
			sql`${table.state} IN ('staged', 'active', 'retired', 'failed')`,
		),
		check(
			"storage_credentials_probe_lease_check",
			sql`(${table.probeToken} IS NULL AND ${table.probeLeaseExpiresAt} IS NULL)
				OR (${table.state} = 'staged'
					AND ${table.probeToken} IS NOT NULL
					AND ${table.probeLeaseExpiresAt} IS NOT NULL)`,
		),
		check(
			"storage_credentials_state_shape_check",
			sql`(${table.state} = 'staged'
					AND ${table.lastTestedAt} IS NULL
					AND ${table.lastErrorCode} IS NULL
					AND ${table.activatedAt} IS NULL
					AND ${table.retiredAt} IS NULL)
				OR (${table.state} = 'active'
					AND ${table.probeToken} IS NULL
					AND ${table.probeLeaseExpiresAt} IS NULL
					AND ${table.lastTestedAt} IS NOT NULL
					AND ${table.lastErrorCode} IS NULL
					AND ${table.activatedAt} IS NOT NULL
					AND ${table.retiredAt} IS NULL)
				OR (${table.state} = 'retired'
					AND ${table.probeToken} IS NULL
					AND ${table.probeLeaseExpiresAt} IS NULL
					AND ${table.lastTestedAt} IS NOT NULL
					AND ${table.lastErrorCode} IS NULL
					AND ${table.activatedAt} IS NOT NULL
					AND ${table.retiredAt} IS NOT NULL
					AND ${table.retiredAt} >= ${table.activatedAt})
				OR (${table.state} = 'failed'
					AND ${table.probeToken} IS NULL
					AND ${table.probeLeaseExpiresAt} IS NULL
					AND ${table.lastTestedAt} IS NOT NULL
					AND ${table.lastErrorCode} IS NOT NULL
					AND ${table.activatedAt} IS NULL
					AND ${table.retiredAt} IS NULL)`,
		),
	],
);

export const media = pgTable(
	"media",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("med_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		filename: text("filename").notNull(),
		mimeType: text("mime_type").notNull(),
		size: integer("size").notNull(),
		storageKey: text("storage_key").notNull(),
		storageProvider: storageProviderEnum("storage_provider")
			.notNull()
			.default("r2"),
		// A row pins the physical object location chosen at creation time. The
		// binding/config is only a router for that locator; it must never silently
		// reinterpret old keys after a regional or BYOS topology change.
		storageBucketLocator: text("storage_bucket_locator").notNull(),
		storageRegion: text("storage_region").notNull(),
		storageLocationId: text("storage_location_id"),
		storageCredentialVersion: integer("storage_credential_version"),
		url: text("url"),
		// Durable, hyper-optimized preview. Stored in a separate, never-expiring R2
		// bucket so card/list previews survive after the full-res original is purged
		// by the relayapi-media lifecycle rule. thumbnailUrl is a stable public URL.
		thumbnailKey: text("thumbnail_key"),
		thumbnailStorageProvider: storageProviderEnum("thumbnail_storage_provider"),
		thumbnailStorageBucketLocator: text("thumbnail_storage_bucket_locator"),
		thumbnailStorageRegion: text("thumbnail_storage_region"),
		thumbnailUrl: text("thumbnail_url"),
		thumbnailStatus: text("thumbnail_status", {
			enum: [
				"pending",
				"generated",
				"unsupported",
				"source_missing",
				"transient_failure",
			],
		})
			.notNull()
			.default("pending"),
		thumbnailAttempts: integer("thumbnail_attempts").notNull().default(0),
		thumbnailNextRetryAt: timestamp("thumbnail_next_retry_at", {
			withTimezone: true,
		}),
		thumbnailLastError: text("thumbnail_last_error"),
		// Lifecycle deletion removes only the full-resolution R2 object. The row
		// and any durable thumbnail remain as the media-library source of truth.
		originalDeletedAt: timestamp("original_deleted_at", { withTimezone: true }),
		// Explicit user deletion is a durable two-object state machine. Keep the
		// row and both keys until R2 confirms deletion of the original and public
		// thumbnail; the scheduled reconciler retries any interrupted attempt.
		deletionRequestedAt: timestamp("deletion_requested_at", {
			withTimezone: true,
		}),
		originalDeletionConfirmedAt: timestamp("original_deletion_confirmed_at", {
			withTimezone: true,
		}),
		thumbnailDeletionConfirmedAt: timestamp("thumbnail_deletion_confirmed_at", {
			withTimezone: true,
		}),
		deletionAttempts: integer("deletion_attempts").notNull().default(0),
		deletionNextRetryAt: timestamp("deletion_next_retry_at", {
			withTimezone: true,
		}),
		deletionLastError: text("deletion_last_error"),
		width: integer("width"),
		height: integer("height"),
		duration: integer("duration"),
		uploadedBy: text("uploaded_by").references(() => user.id, {
			onDelete: "set null",
		}),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		status: text("status", {
			enum: [
				"pending",
				"uploading",
				"upload_failed",
				"ready",
				"deleting",
				"deletion_failed",
			],
		})
			.notNull()
			.default("ready"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("media_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "media_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.storageLocationId,
				table.organizationId,
				table.storageBucketLocator,
				table.storageRegion,
			],
			foreignColumns: [
				storageLocations.id,
				storageLocations.organizationId,
				storageLocations.bucket,
				storageLocations.region,
			],
			name: "media_storage_location_org_locator_fk",
		}).onDelete("restrict"),
		foreignKey({
			columns: [
				table.storageLocationId,
				table.organizationId,
				table.storageCredentialVersion,
			],
			foreignColumns: [
				storageCredentials.locationId,
				storageCredentials.organizationId,
				storageCredentials.version,
			],
			name: "media_storage_credential_org_version_fk",
		}).onDelete("restrict"),
		check(
			"media_status_check",
			sql`${table.status} IN ('pending', 'uploading', 'upload_failed', 'ready', 'deleting', 'deletion_failed')`,
		),
		check(
			"media_thumbnail_status_check",
			sql`${table.thumbnailStatus} IN ('pending', 'generated', 'unsupported', 'source_missing', 'transient_failure')`,
		),
		check(
			"media_numeric_check",
			sql`${table.size} >= 0
				AND ${table.thumbnailAttempts} >= 0
				AND ${table.deletionAttempts} >= 0
				AND (${table.width} IS NULL OR ${table.width} > 0)
				AND (${table.height} IS NULL OR ${table.height} > 0)
				AND (${table.duration} IS NULL OR ${table.duration} >= 0)`,
		),
		check(
			"media_storage_locator_check",
			sql`length(btrim(${table.storageBucketLocator})) > 0
				AND length(${table.storageBucketLocator}) <= 255
				AND length(btrim(${table.storageRegion})) > 0
				AND length(${table.storageRegion}) <= 128
				AND (${table.storageProvider} <> 'r2'
					OR ${table.storageRegion} IN ('default', 'eu'))`,
		),
		check(
			"media_storage_authority_check",
			sql`(${table.storageProvider} = 'r2'
					AND ${table.storageLocationId} IS NULL
					AND ${table.storageCredentialVersion} IS NULL)
				OR (${table.storageProvider} = 'byos'
					AND ${table.storageLocationId} IS NOT NULL
					AND ${table.storageCredentialVersion} IS NOT NULL
					AND ${table.storageCredentialVersion} > 0)`,
		),
		check(
			"media_thumbnail_storage_locator_check",
			sql`(
					${table.thumbnailKey} IS NULL
					AND ${table.thumbnailStorageProvider} IS NULL
					AND ${table.thumbnailStorageBucketLocator} IS NULL
					AND ${table.thumbnailStorageRegion} IS NULL
				) OR (
					${table.thumbnailKey} IS NOT NULL
					AND ${table.thumbnailStorageProvider} IS NOT NULL
					AND ${table.thumbnailStorageProvider} = 'r2'
					AND ${table.thumbnailStorageBucketLocator} IS NOT NULL
					AND length(btrim(${table.thumbnailStorageBucketLocator})) > 0
					AND length(${table.thumbnailStorageBucketLocator}) <= 255
					AND ${table.thumbnailStorageRegion} IS NOT NULL
					AND ${table.thumbnailStorageRegion} IN ('default', 'eu')
				)`,
		),
		check(
			"media_thumbnail_projection_check",
			sql`(${table.thumbnailStatus} <> 'generated'
					OR (${table.thumbnailKey} IS NOT NULL
						AND ${table.thumbnailUrl} IS NOT NULL))
				AND (${table.thumbnailUrl} IS NULL
					OR ${table.thumbnailStatus} = 'generated')`,
		),
		index("media_org_idx").on(table.organizationId),
		index("media_workspace_idx").on(table.workspaceId),
		uniqueIndex("media_storage_key_uniq").on(
			table.storageProvider,
			sql`COALESCE(${table.storageLocationId}, '')`,
			table.storageBucketLocator,
			table.storageRegion,
			table.storageKey,
		),
		index("media_thumbnail_retry_idx").on(
			table.thumbnailStatus,
			table.thumbnailNextRetryAt,
		),
		index("media_upload_reconcile_idx").on(table.status, table.createdAt),
		index("media_deletion_retry_idx").on(
			table.status,
			table.deletionNextRetryAt,
		),
	],
);

/** Durable authority for resumable single-part and multipart media uploads. */
export const mediaUploadSessions = pgTable(
	"media_upload_sessions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("mup_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		mediaId: text("media_id").notNull(),
		mode: text("mode", { enum: ["single", "multipart"] }).notNull(),
		expectedSize: integer("expected_size").notNull(),
		expectedMimeType: text("expected_mime_type").notNull(),
		partSize: integer("part_size"),
		partCount: integer("part_count"),
		multipartUploadIdCiphertext: text("multipart_upload_id_ciphertext"),
		status: text("status", {
			enum: [
				"created",
				"uploading",
				"completing",
				"completed",
				"aborting",
				"aborted",
				"failed",
				"expired",
			],
		})
			.notNull()
			.default("created"),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		lastErrorCode: text("last_error_code"),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "media_upload_sessions_workspace_org_fk",
		}),
		foreignKey({
			columns: [table.mediaId, table.organizationId, table.scopeKey],
			foreignColumns: [media.id, media.organizationId, media.scopeKey],
			name: "media_upload_sessions_media_org_scope_fk",
		}).onDelete("cascade"),
		uniqueIndex("media_upload_sessions_media_uniq").on(table.mediaId),
		index("media_upload_sessions_org_status_idx").on(
			table.organizationId,
			table.status,
		),
		index("media_upload_sessions_expiry_idx").on(
			table.status,
			table.expiresAt,
			table.leaseExpiresAt,
			table.id,
		),
		check(
			"media_upload_sessions_mode_check",
			sql`${table.mode} IN ('single', 'multipart')`,
		),
		check(
			"media_upload_sessions_status_check",
			sql`${table.status} IN ('created', 'uploading', 'completing', 'completed', 'aborting', 'aborted', 'failed', 'expired')`,
		),
		check(
			"media_upload_sessions_size_check",
			sql`${table.expectedSize} > 0 AND ${table.expectedSize} <= ${ddlIntegerLiteral(200 * 1024 * 1024)}`,
		),
		check(
			"media_upload_sessions_multipart_shape_check",
			sql`(${table.mode} = 'single'
					AND ${table.partSize} IS NULL
					AND ${table.partCount} IS NULL
					AND ${table.multipartUploadIdCiphertext} IS NULL)
				OR (${table.mode} = 'multipart'
					AND ${table.partSize} >= ${ddlIntegerLiteral(5 * 1024 * 1024)}
					AND ${table.partCount} > 1
					AND (
						(${table.status} IN ('created', 'uploading', 'completing', 'aborting')
							AND ${table.multipartUploadIdCiphertext} LIKE 'enc:v2:%')
						OR (${table.status} IN ('completed', 'aborted', 'expired')
							AND ${table.multipartUploadIdCiphertext} IS NULL)
						OR ${table.status} = 'failed'
					))`,
		),
		check(
			"media_upload_sessions_completion_check",
			sql`(${table.status} = 'completed') = (${table.completedAt} IS NOT NULL)`,
		),
		check(
			"media_upload_sessions_lease_check",
			sql`${table.leaseToken} >= 0
				AND (${table.status} IN ('completing', 'aborting')) = (${table.leaseExpiresAt} IS NOT NULL)`,
		),
		check(
			"media_upload_sessions_timestamp_check",
			sql`${table.expiresAt} > ${table.createdAt}
				AND ${table.updatedAt} >= ${table.createdAt}
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
		),
	],
);

/** Durable orchestration state for media normalization and cover generation. */
export const mediaProcessingJobs = pgTable(
	"media_processing_jobs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("mproc_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		mediaId: text("media_id").notNull(),
		operation: text("operation", {
			enum: ["normalize", "provider_variant", "cover"],
		}).notNull(),
		profile: text("profile").notNull(),
		options: jsonb("options").$type<Record<string, unknown>>().notNull(),
		optionsHash: varchar("options_hash", { length: 64 }).notNull(),
		sourceEtag: text("source_etag").notNull(),
		processorVersion: text("processor_version").notNull(),
		status: text("status", {
			enum: ["pending", "processing", "completed", "failed", "manual_review"],
		})
			.notNull()
			.default("pending"),
		workflowId: text("workflow_id"),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		lastErrorCode: text("last_error_code"),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "media_processing_jobs_workspace_org_fk",
		}),
		foreignKey({
			columns: [table.mediaId, table.organizationId, table.scopeKey],
			foreignColumns: [media.id, media.organizationId, media.scopeKey],
			name: "media_processing_jobs_media_org_scope_fk",
		}).onDelete("cascade"),
		unique("media_processing_jobs_id_org_scope_media_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
			table.mediaId,
		),
		uniqueIndex("media_processing_jobs_request_uniq").on(
			table.mediaId,
			table.operation,
			table.profile,
			table.optionsHash,
			table.sourceEtag,
			table.processorVersion,
		),
		index("media_processing_jobs_due_idx").on(
			table.status,
			table.nextAttemptAt,
			table.leaseExpiresAt,
		),
		check(
			"media_processing_jobs_state_check",
			sql`${table.operation} IN ('normalize', 'provider_variant', 'cover')
				AND ${table.status} IN ('pending', 'processing', 'completed', 'failed', 'manual_review')`,
		),
		check(
			"media_processing_jobs_counter_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"media_processing_jobs_lease_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"media_processing_jobs_completion_check",
			sql`(${table.status} = 'completed') = (${table.completedAt} IS NOT NULL)`,
		),
	],
);

/** Immutable provider-ready artifacts derived from one retained media source. */
export const mediaDerivatives = pgTable(
	"media_derivatives",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("mder_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		mediaId: text("media_id").notNull(),
		processingJobId: text("processing_job_id").notNull(),
		kind: text("kind", { enum: [...MEDIA_DERIVATIVE_KINDS] }).notNull(),
		profile: text("profile").notNull(),
		optionsHash: varchar("options_hash", { length: 64 }).notNull(),
		storageKey: text("storage_key").notNull(),
		mimeType: text("mime_type").notNull(),
		size: integer("size").notNull(),
		width: integer("width"),
		height: integer("height"),
		duration: integer("duration"),
		checksumSha256: varchar("checksum_sha256", { length: 64 }).notNull(),
		status: text("status", {
			enum: ["processing", "ready", "failed", "deleting"],
		})
			.notNull()
			.default("processing"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		readyAt: timestamp("ready_at", { withTimezone: true }),
		deleteAfter: timestamp("delete_after", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "media_derivatives_workspace_org_fk",
		}),
		foreignKey({
			columns: [table.mediaId, table.organizationId, table.scopeKey],
			foreignColumns: [media.id, media.organizationId, media.scopeKey],
			name: "media_derivatives_media_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [
				table.processingJobId,
				table.organizationId,
				table.scopeKey,
				table.mediaId,
			],
			foreignColumns: [
				mediaProcessingJobs.id,
				mediaProcessingJobs.organizationId,
				mediaProcessingJobs.scopeKey,
				mediaProcessingJobs.mediaId,
			],
			name: "media_derivatives_processing_job_org_scope_media_fk",
		}).onDelete("cascade"),
		uniqueIndex("media_derivatives_profile_uniq").on(
			table.mediaId,
			table.kind,
			table.profile,
			table.optionsHash,
		),
		uniqueIndex("media_derivatives_storage_key_uniq").on(table.storageKey),
		index("media_derivatives_cleanup_idx").on(
			table.status,
			table.deleteAfter,
			table.id,
		),
		check(
			"media_derivatives_state_check",
			sql`${table.kind} IN (${sql.join(
				MEDIA_DERIVATIVE_KINDS.map((value) => ddlTextLiteral(value)),
				sql`, `,
			)})
				AND ${table.status} IN ('processing', 'ready', 'failed', 'deleting')`,
		),
		check(
			"media_derivatives_numeric_check",
			sql`${table.size} >= 0
				AND (${table.width} IS NULL OR ${table.width} > 0)
				AND (${table.height} IS NULL OR ${table.height} > 0)
				AND (${table.duration} IS NULL OR ${table.duration} >= 0)`,
		),
		check(
			"media_derivatives_checksum_check",
			sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"media_derivatives_ready_check",
			sql`(${table.status} = 'ready') = (${table.readyAt} IS NOT NULL)`,
		),
	],
);

export const webhookEndpoints = pgTable(
	"webhook_endpoints",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("wh_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		// Restrict (never set-null): durable erasure must delete this row explicitly.
		// Setting workspace_id to NULL would silently promote the endpoint to an
		// organization-wide receiver.
		workspaceId: text("workspace_id"),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		url: text("url").notNull(),
		secretCiphertext: text("secret_ciphertext").notNull(),
		secretKeyId: text("secret_key_id").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		events: text("events").array(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("webhook_endpoints_id_org_uniq").on(table.id, table.organizationId),
		unique("webhook_endpoints_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "webhook_endpoints_workspace_org_fk",
		}).onDelete("restrict"),
		index("webhook_endpoints_org_idx").on(
			table.organizationId,
			table.createdAt,
			table.id,
		),
		index("webhook_endpoints_workspace_idx").on(table.workspaceId),
	],
);

export const webhookEvents = pgTable(
	"webhook_events",
	{
		id: text("id").primaryKey(),
		// Stable logical occurrence supplied by the producer. Unlike a payload
		// hash, this preserves distinct events whose bodies happen to be equal.
		occurrenceId: text("occurrence_id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		event: text("event").notNull(),
		payload: jsonb("payload").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("webhook_events_id_org_uniq").on(table.id, table.organizationId),
		unique("webhook_events_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "webhook_events_workspace_org_fk",
		}),
		uniqueIndex("webhook_events_org_occurrence_idx").on(
			table.organizationId,
			table.occurrenceId,
		),
		// Occurrence lookup is covered by the unique index above; use the second
		// event index for the bounded, cross-tenant retention scan because no
		// request path lists webhook events directly by organization and time.
		index("webhook_events_retention_idx").on(table.createdAt, table.id),
	],
);

export const webhookDeliveries = pgTable(
	"webhook_deliveries",
	{
		id: text("id").primaryKey(),
		webhookEventId: text("webhook_event_id").notNull(),
		webhookId: text("webhook_id").notNull(),
		organizationId: text("organization_id").notNull(),
		status: text("status", {
			enum: [
				"pending",
				"in_flight",
				"succeeded",
				"failed",
				"unknown",
				"manual_review",
				"unresolved",
			],
		})
			.notNull()
			.default("pending"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		attempts: integer("attempts").notNull().default(0),
		repairAttempts: integer("repair_attempts").notNull().default(0),
		repairDeadlineAt: timestamp("repair_deadline_at", {
			withTimezone: true,
		})
			.notNull()
			.default(sql`now() + interval '24 hours'`),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		statusCode: integer("status_code"),
		responseTimeMs: integer("response_time_ms"),
		manualReviewReason: text("manual_review_reason", {
			enum: ["pre_http_repair_exhausted", "http_outcome_unknown"],
		}),
		manualReviewUntil: timestamp("manual_review_until", {
			withTimezone: true,
		}),
		operatorIntervenedAt: timestamp("operator_intervened_at", {
			withTimezone: true,
		}),
		operatorRetryRequestedAt: timestamp("operator_retry_requested_at", {
			withTimezone: true,
		}),
		error: text("error"),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		// Queue handoff is separately leased from HTTP delivery. This turns the
		// delivery ledger into a recoverable outbox without holding a DB lease
		// across the Queue binding call.
		dispatchLeaseId: text("dispatch_lease_id"),
		dispatchLeaseExpiresAt: timestamp("dispatch_lease_expires_at", {
			withTimezone: true,
		}),
		nextDispatchAt: timestamp("next_dispatch_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
		dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("webhook_deliveries_id_org_uniq").on(table.id, table.organizationId),
		foreignKey({
			columns: [table.webhookEventId, table.organizationId],
			foreignColumns: [webhookEvents.id, webhookEvents.organizationId],
			name: "webhook_deliveries_event_org_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.webhookId, table.organizationId],
			foreignColumns: [webhookEndpoints.id, webhookEndpoints.organizationId],
			name: "webhook_deliveries_endpoint_org_fk",
		}).onDelete("cascade"),
		uniqueIndex("webhook_deliveries_event_endpoint_idx").on(
			table.webhookEventId,
			table.webhookId,
		),
		check(
			"webhook_deliveries_status_check",
			sql`${table.status} IN ('pending', 'in_flight', 'succeeded', 'failed', 'unknown', 'manual_review', 'unresolved')`,
		),
		check(
			"webhook_deliveries_counters_nonnegative_check",
			sql`${table.attempts} >= 0 AND ${table.repairAttempts} >= 0 AND ${table.dispatchAttempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"webhook_deliveries_http_attempt_budget_check",
			sql`${table.attempts} <= 9
					AND (${table.attempts} <= 8
						OR ${table.operatorRetryRequestedAt} IS NOT NULL)`,
		),
		check(
			"webhook_deliveries_repair_deadline_check",
			sql`${table.repairDeadlineAt} > ${table.createdAt}
					AND (${table.operatorIntervenedAt} IS NULL
						OR ${table.operatorIntervenedAt} >= ${table.createdAt})
					AND (${table.operatorRetryRequestedAt} IS NULL
						OR ${table.operatorRetryRequestedAt} >= ${table.createdAt})`,
		),
		check(
			"webhook_deliveries_operator_intervention_check",
			sql`${table.operatorRetryRequestedAt} IS NULL
					OR ${table.operatorIntervenedAt} = ${table.operatorRetryRequestedAt}`,
		),
		check(
			"webhook_deliveries_http_values_check",
			sql`(${table.statusCode} IS NULL OR (${table.statusCode} >= 100 AND ${table.statusCode} <= 599)) AND (${table.responseTimeMs} IS NULL OR ${table.responseTimeMs} >= 0)`,
		),
		check(
			"webhook_deliveries_terminal_completion_check",
			sql`(${table.status} IN ('succeeded', 'failed', 'unresolved')
						AND ${table.completedAt} IS NOT NULL
						AND ${table.manualReviewReason} IS NULL
						AND ${table.manualReviewUntil} IS NULL)
					OR (${table.status} = 'manual_review'
						AND ${table.completedAt} IS NULL
						AND ${table.leaseExpiresAt} IS NULL
						AND (
							(${table.manualReviewReason} = 'pre_http_repair_exhausted'
								AND ${table.requestMayHaveBeenSentAt} IS NULL
								AND ${table.manualReviewUntil} > ${table.repairDeadlineAt}
								AND ${table.manualReviewUntil} <= ${table.repairDeadlineAt} + interval '90 days')
							OR (${table.manualReviewReason} = 'http_outcome_unknown'
								AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
								AND ${table.manualReviewUntil} > ${table.requestMayHaveBeenSentAt}
								AND ${table.manualReviewUntil} <= ${table.requestMayHaveBeenSentAt} + interval '90 days')
						))
					OR (${table.status} NOT IN ('succeeded', 'failed', 'manual_review', 'unresolved')
						AND ${table.completedAt} IS NULL
						AND ${table.manualReviewReason} IS NULL
						AND ${table.manualReviewUntil} IS NULL)`,
		),
		check(
			"webhook_deliveries_unknown_boundary_check",
			sql`${table.status} <> 'unknown'
					OR ${table.requestMayHaveBeenSentAt} IS NOT NULL`,
		),
		check(
			"webhook_deliveries_lease_state_check",
			sql`(${table.status} = 'in_flight'
						AND ${table.leaseExpiresAt} IS NOT NULL
						AND ${table.requestMayHaveBeenSentAt} IS NULL)
					OR (${table.status} = 'unknown'
						AND ${table.leaseExpiresAt} IS NOT NULL
						AND ${table.requestMayHaveBeenSentAt} IS NOT NULL)
					OR (${table.status} NOT IN ('in_flight', 'unknown')
						AND ${table.leaseExpiresAt} IS NULL)`,
		),
		index("webhook_deliveries_webhook_idx").on(table.webhookId),
		index("webhook_deliveries_status_idx").on(
			table.status,
			table.leaseExpiresAt,
		),
		index("webhook_deliveries_dispatch_idx").on(
			table.status,
			table.nextDispatchAt,
			table.dispatchLeaseExpiresAt,
		),
		index("webhook_deliveries_retention_idx")
			.on(table.completedAt, table.id)
			.where(sql`${table.status} IN ('succeeded', 'failed', 'unresolved')`),
		index("webhook_deliveries_manual_review_expiry_idx")
			.on(table.manualReviewUntil, table.id)
			.where(sql`${table.status} = 'manual_review'`),
	],
);

export const webhookLogs = pgTable(
	"webhook_logs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("whl_")),
		webhookId: text("webhook_id").notNull(),
		webhookEventId: text("webhook_event_id").notNull(),
		deliveryId: text("delivery_id"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		attemptOrdinal: integer("attempt_ordinal").notNull(),
		attemptKind: text("attempt_kind", {
			enum: [...WEBHOOK_ATTEMPT_KINDS],
		}).notNull(),
		outcome: text("outcome", {
			enum: [...WEBHOOK_ATTEMPT_OUTCOMES],
		}).notNull(),
		statusCode: integer("status_code"),
		responseTimeMs: integer("response_time_ms").notNull(),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.webhookId, table.organizationId],
			foreignColumns: [webhookEndpoints.id, webhookEndpoints.organizationId],
			name: "webhook_logs_endpoint_org_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.webhookEventId, table.organizationId],
			foreignColumns: [webhookEvents.id, webhookEvents.organizationId],
			name: "webhook_logs_event_org_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.deliveryId, table.organizationId],
			foreignColumns: [webhookDeliveries.id, webhookDeliveries.organizationId],
			name: "webhook_logs_delivery_org_fk",
		}).onDelete("cascade"),
		check(
			"webhook_logs_attempt_kind_check",
			sql`${table.attemptKind} IN ('delivery', 'test')`,
		),
		check(
			"webhook_logs_outcome_check",
			sql`${table.outcome} IN ('succeeded', 'retry_scheduled', 'failed', 'unknown')`,
		),
		check(
			"webhook_logs_attempt_identity_check",
			sql`(${table.attemptKind} = 'delivery'
					AND ${table.deliveryId} IS NOT NULL
					AND ${table.attemptOrdinal} > 0)
				OR (${table.attemptKind} = 'test'
					AND ${table.deliveryId} IS NULL
					AND ${table.attemptOrdinal} = 1)`,
		),
		check(
			"webhook_logs_http_values_check",
			sql`${table.responseTimeMs} >= 0
				AND ((${table.outcome} = 'succeeded'
						AND ${table.statusCode} BETWEEN 200 AND 299
						AND ${table.error} IS NULL)
					OR (${table.outcome} IN ('retry_scheduled', 'failed')
						AND ${table.statusCode} BETWEEN 100 AND 599
						AND ${table.statusCode} NOT BETWEEN 200 AND 299
						AND ${table.error} IS NOT NULL)
					OR (${table.outcome} = 'unknown'
						AND ${table.statusCode} IS NULL
						AND ${table.error} IS NOT NULL))`,
		),
		uniqueIndex("webhook_logs_delivery_attempt_uniq")
			.on(table.deliveryId, table.attemptOrdinal)
			.where(sql`${table.deliveryId} IS NOT NULL`),
		// Replaces the webhook_id-only index: event deletion/retention is the hot
		// cleanup path, while endpoint deletion is rare and history is bounded.
		index("webhook_logs_event_created_idx").on(
			table.webhookEventId,
			table.createdAt,
		),
		index("webhook_logs_org_created_idx").on(
			table.organizationId,
			table.createdAt,
			table.id,
		),
		index("webhook_logs_retention_idx").on(table.createdAt, table.id),
	],
);

export const postAnalytics = pgTable(
	"post_analytics",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("pa_")),
		postTargetId: text("post_target_id")
			.notNull()
			.references(() => postTargets.id, { onDelete: "cascade" }),
		platform: platformEnum("platform").notNull(),
		impressions: integer("impressions").default(0),
		reach: integer("reach").default(0),
		likes: integer("likes").default(0),
		comments: integer("comments").default(0),
		shares: integer("shares").default(0),
		saves: integer("saves").default(0),
		clicks: integer("clicks").default(0),
		views: integer("views").default(0),
		// Deterministic scheduler-owned identity. Queue redelivery and a crash
		// between history and freshness writes upsert this same observation.
		observationWindowStart: timestamp("observation_window_start", {
			withTimezone: true,
		}).notNull(),
		collectedAt: timestamp("collected_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"post_analytics_counts_nonnegative_check",
			sql`(${table.impressions} IS NULL OR ${table.impressions} >= 0)
				AND (${table.reach} IS NULL OR ${table.reach} >= 0)
				AND (${table.likes} IS NULL OR ${table.likes} >= 0)
				AND (${table.comments} IS NULL OR ${table.comments} >= 0)
				AND (${table.shares} IS NULL OR ${table.shares} >= 0)
				AND (${table.saves} IS NULL OR ${table.saves} >= 0)
				AND (${table.clicks} IS NULL OR ${table.clicks} >= 0)
				AND (${table.views} IS NULL OR ${table.views} >= 0)`,
		),
		index("post_analytics_target_collected_idx").on(
			table.postTargetId,
			table.collectedAt,
			table.id,
		),
		uniqueIndex("post_analytics_target_window_uniq").on(
			table.postTargetId,
			table.observationWindowStart,
		),
		index("post_analytics_retention_idx").on(table.collectedAt, table.id),
	],
);

// ---------------------------------------------------------------------------
// Connection logs (tracks connect/disconnect/refresh/error events)
// ---------------------------------------------------------------------------

export const connectionLogs = pgTable(
	"connection_logs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("clog_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		socialAccountId: text("social_account_id").references(
			() => socialAccounts.id,
			{ onDelete: "set null" },
		),
		platform: platformEnum("platform").notNull(),
		event: text("event").notNull(), // connected, disconnected, token_refreshed, error
		message: text("message"),
		snapshot: jsonb("snapshot"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("connection_logs_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("connection_logs_retention_idx").on(table.createdAt, table.id),
	],
);

// ---------------------------------------------------------------------------
// API request logs (per-request logging for abuse detection and user inspection)
// ---------------------------------------------------------------------------

export const apiRequestLogs = pgTable(
	"api_request_logs",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		organizationId: text("organization_id").notNull(),
		apiKeyId: text("api_key_id").notNull(),
		method: varchar("method", { length: 7 }).notNull(),
		path: text("path").notNull(),
		statusCode: smallint("status_code").notNull(),
		responseTimeMs: integer("response_time_ms").notNull(),
		billable: boolean("billable").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"api_request_logs_id_safe_integer_check",
			sql`${table.id} BETWEEN 1 AND 9007199254740991`,
		),
		check(
			"api_request_logs_http_values_check",
			sql`${table.statusCode} BETWEEN 100 AND 599 AND ${table.responseTimeMs} >= 0`,
		),
		index("api_request_logs_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("api_request_logs_api_key_idx").on(table.apiKeyId),
		index("api_request_logs_retention_idx").on(table.createdAt, table.id),
	],
);

// Durable terminal record for queue messages that are intentionally ACKed
// (invalid/permanent input or an ambiguous external outcome). Infrastructure
// failures are retried into the configured DLQ instead of being inserted here
// and discarded. Operators can inspect and explicitly replay resolved records.
export const queueFailures = pgTable(
	"queue_failures",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("qf_")),
		queueName: text("queue_name").notNull(),
		messageId: text("message_id").notNull(),
		// A raw platform receipt can fan out to more than one tenant. Singleton
		// failures use the same representation so authorization has one indexed path.
		organizationIds: text("organization_ids")
			.array()
			.notNull()
			.default(sql`ARRAY[]::text[]`),
		workspaceIds: text("workspace_ids")
			.array()
			.notNull()
			.default(sql`ARRAY[]::text[]`),
		userIds: text("user_ids").array().notNull().default(sql`ARRAY[]::text[]`),
		contactIds: text("contact_ids")
			.array()
			.notNull()
			.default(sql`ARRAY[]::text[]`),
		accountIds: text("account_ids")
			.array()
			.notNull()
			.default(sql`ARRAY[]::text[]`),
		operationId: text("operation_id"),
		failureKind: text("failure_kind", {
			enum: [...QUEUE_FAILURE_KINDS],
		}).notNull(),
		status: text("status", {
			enum: [
				"unresolved",
				"replay_claimed",
				"replay_unknown",
				"replayed",
				"dismissed",
			],
		})
			.notNull()
			.default("unresolved"),
		attempts: integer("attempts").notNull(),
		payloadCiphertext: text("payload_ciphertext"),
		payloadKeyId: text("payload_key_id"),
		payloadExpiresAt: timestamp("payload_expires_at", { withTimezone: true })
			.notNull()
			.default(sql`now() + interval '30 days'`),
		payloadRedactedAt: timestamp("payload_redacted_at", {
			withTimezone: true,
		}),
		purgeAt: timestamp("purge_at", { withTimezone: true })
			.notNull()
			.default(sql`now() + interval '90 days'`),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		replayClaimToken: text("replay_claim_token"),
		replayClaimExpiresAt: timestamp("replay_claim_expires_at", {
			withTimezone: true,
		}),
		replayRequestedAt: timestamp("replay_requested_at", {
			withTimezone: true,
		}),
		replayError: text("replay_error"),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("queue_failures_queue_message_idx").on(
			table.queueName,
			table.messageId,
		),
		check(
			"queue_failures_kind_check",
			sql`${table.failureKind} IN ('permanent_input', 'unknown_external_outcome', 'dead_letter')`,
		),
		check(
			"queue_failures_status_check",
			sql`${table.status} IN ('unresolved', 'replay_claimed', 'replay_unknown', 'replayed', 'dismissed')`,
		),
		check(
			"queue_failures_attempts_nonnegative_check",
			sql`${table.attempts} >= 0`,
		),
		check(
			"queue_failures_replay_claim_check",
			sql`${table.status} <> 'replay_claimed'
				OR (${table.replayClaimToken} IS NOT NULL
					AND ${table.replayClaimExpiresAt} IS NOT NULL
					AND ${table.replayRequestedAt} IS NOT NULL)`,
		),
		check(
			"queue_failures_resolution_check",
			sql`(${table.status} IN ('replayed', 'dismissed') AND ${table.resolvedAt} IS NOT NULL)
				OR (${table.status} NOT IN ('replayed', 'dismissed') AND ${table.resolvedAt} IS NULL)`,
		),
		check(
			"queue_failures_payload_lifecycle_check",
			sql`(${table.payloadCiphertext} IS NOT NULL
					AND ${table.payloadKeyId} IS NOT NULL
					AND ${table.payloadRedactedAt} IS NULL)
				OR (${table.payloadCiphertext} IS NULL
					AND ${table.payloadKeyId} IS NULL
					AND ${table.payloadRedactedAt} IS NOT NULL)`,
		),
		check(
			"queue_failures_retention_clock_check",
			sql`${table.payloadExpiresAt} > ${table.createdAt}
				AND ${table.purgeAt} >= ${table.payloadExpiresAt}
				AND (${table.payloadRedactedAt} IS NULL
					OR ${table.payloadRedactedAt} >= ${table.createdAt})`,
		),
		index("queue_failures_status_created_idx").on(
			table.status,
			table.createdAt,
		),
		index("queue_failures_operation_idx").on(table.operationId),
		index("queue_failures_organization_ids_idx").using(
			"gin",
			table.organizationIds,
		),
		index("queue_failures_workspace_ids_idx").using("gin", table.workspaceIds),
		index("queue_failures_user_ids_idx").using("gin", table.userIds),
		index("queue_failures_contact_ids_idx").using("gin", table.contactIds),
		index("queue_failures_account_ids_idx").using("gin", table.accountIds),
		index("queue_failures_replay_claim_idx").on(
			table.status,
			table.replayClaimExpiresAt,
		),
		index("queue_failures_payload_expiry_idx").on(
			table.payloadExpiresAt,
			table.id,
		),
		index("queue_failures_purge_idx").on(table.purgeAt, table.id),
	],
);

export const emailDeliveries = pgTable(
	"email_deliveries",
	{
		id: text("id").primaryKey(),
		intent: text("intent", {
			enum: ["organization", "auth_user"],
		}).notNull(),
		organizationId: text("organization_id").references(() => organization.id, {
			onDelete: "cascade",
		}),
		authUserId: text("auth_user_id").references(() => user.id, {
			onDelete: "cascade",
		}),
		subjectUserId: text("subject_user_id").references(() => user.id, {
			onDelete: "set null",
		}),
		// The queue carries only the ledger id. Recipient, subject, and
		// rendered content stay in this owned, application-encrypted envelope.
		envelopeCiphertext: text("envelope_ciphertext"),
		envelopeKeyId: text("envelope_key_id"),
		status: text("status", {
			enum: [
				"pending",
				"processing",
				"unknown",
				"sent",
				"failed",
				"manual_review",
			],
		})
			.notNull()
			.default("pending"),
		providerAttempts: integer("provider_attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		deadlineAt: timestamp("deadline_at", { withTimezone: true })
			.notNull()
			.default(sql`now() + interval '23 hours'`),
		dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
		dispatchLeaseToken: integer("dispatch_lease_token").notNull().default(0),
		dispatchLeaseExpiresAt: timestamp("dispatch_lease_expires_at", {
			withTimezone: true,
		}),
		nextDispatchAt: timestamp("next_dispatch_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		queuedAt: timestamp("queued_at", { withTimezone: true }),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		providerMessageId: text("provider_message_id"),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true })
			.notNull()
			.default(sql`now() + interval '30 days'`),
		purgeAt: timestamp("purge_at", { withTimezone: true })
			.notNull()
			.default(sql`now() + interval '90 days'`),
		redactedAt: timestamp("redacted_at", { withTimezone: true }),
	},
	(table) => [
		check(
			"email_deliveries_intent_owner_check",
			sql`(${table.intent} = 'organization'
					AND ${table.organizationId} IS NOT NULL
					AND ${table.authUserId} IS NULL)
				OR (${table.intent} = 'auth_user'
					AND ${table.organizationId} IS NULL
					AND ${table.authUserId} IS NOT NULL)`,
		),
		check(
			"email_deliveries_status_check",
			sql`${table.status} IN ('pending', 'processing', 'unknown', 'sent', 'failed', 'manual_review')`,
		),
		check(
			"email_deliveries_attempts_nonnegative_check",
			sql`${table.providerAttempts} >= 0
				AND ${table.leaseToken} >= 0
				AND ${table.dispatchAttempts} >= 0
				AND ${table.dispatchLeaseToken} >= 0`,
		),
		check(
			"email_deliveries_dispatch_lease_check",
			sql`${table.dispatchLeaseExpiresAt} IS NULL
				OR ${table.status} IN ('pending', 'unknown')`,
		),
		check(
			"email_deliveries_state_fields_check",
			sql`(${table.status} = 'pending'
					AND ${table.completedAt} IS NULL
					AND ${table.leaseExpiresAt} IS NULL
					AND ${table.requestMayHaveBeenSentAt} IS NULL)
				OR (${table.status} = 'processing'
					AND ${table.completedAt} IS NULL
					AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} = 'unknown'
					AND ${table.completedAt} IS NULL
					AND ${table.leaseExpiresAt} IS NULL
					AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
				)
				OR (${table.status} IN ('sent', 'failed', 'manual_review')
					AND ${table.leaseExpiresAt} IS NULL
					AND ${table.completedAt} IS NOT NULL)`,
		),
		check(
			"email_deliveries_timestamp_order_check",
			sql`${table.expiresAt} > ${table.createdAt}
				AND ${table.deadlineAt} > ${table.createdAt}
				AND ${table.deadlineAt} <= ${table.expiresAt}
				AND ${table.purgeAt} >= ${table.expiresAt}
				AND (${table.queuedAt} IS NULL OR ${table.queuedAt} >= ${table.createdAt})
				AND (${table.requestMayHaveBeenSentAt} IS NULL OR ${table.requestMayHaveBeenSentAt} >= ${table.createdAt})
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})
				AND (${table.redactedAt} IS NULL OR ${table.redactedAt} >= ${table.createdAt})`,
		),
		check(
			"email_deliveries_envelope_lifecycle_check",
			sql`(${table.envelopeCiphertext} IS NOT NULL
					AND ${table.envelopeKeyId} IS NOT NULL
					AND ${table.redactedAt} IS NULL)
				OR (${table.envelopeCiphertext} IS NULL
					AND ${table.envelopeKeyId} IS NULL
					AND ${table.redactedAt} IS NOT NULL)`,
		),
		index("email_deliveries_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("email_deliveries_auth_user_created_idx").on(
			table.authUserId,
			table.createdAt,
		),
		index("email_deliveries_subject_user_idx").on(table.subjectUserId),
		index("email_deliveries_pending_dispatch_idx")
			.on(
				table.nextDispatchAt,
				table.deadlineAt,
				table.dispatchLeaseExpiresAt,
				table.organizationId,
				table.createdAt,
				table.id,
			)
			.where(sql`${table.status} IN ('pending', 'unknown')`),
		index("email_deliveries_processing_lease_idx")
			.on(table.leaseExpiresAt, table.id)
			.where(sql`${table.status} = 'processing'`),
		index("email_deliveries_deadline_idx")
			.on(table.deadlineAt, table.id)
			.where(sql`${table.status} IN ('pending', 'processing', 'unknown')`),
		index("email_deliveries_expiry_idx").on(table.expiresAt, table.id),
		index("email_deliveries_purge_idx").on(table.purgeAt, table.id),
	],
);

export const idempotencyReceipts = pgTable(
	"idempotency_receipts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("idem_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		method: varchar("method", { length: 7 }).notNull(),
		route: text("route").notNull(),
		// Keep the unique index bounded even when the diagnostic route contains a
		// long query string. The middleware still compares the exact route.
		routeHash: varchar("route_hash", { length: 64 }).notNull(),
		idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
		requestHash: text("request_hash").notNull(),
		state: text("state", {
			enum: ["in_progress", "completed", "unknown"],
		})
			.notNull()
			.default("in_progress"),
		resourceId: text("resource_id"),
		responseStatus: integer("response_status"),
		responseBodyCiphertext: text("response_body_ciphertext"),
		responseContentType: text("response_content_type"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		lastError: text("last_error"),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		uniqueIndex("idempotency_receipts_scope_key_idx").on(
			table.organizationId,
			table.method,
			table.routeHash,
			table.idempotencyKey,
		),
		check(
			"idempotency_receipts_state_check",
			sql`${table.state} IN ('in_progress', 'completed', 'unknown')`,
		),
		check(
			"idempotency_receipts_response_status_check",
			sql`${table.responseStatus} IS NULL OR ${table.responseStatus} BETWEEN 100 AND 599`,
		),
		check(
			"idempotency_receipts_completion_check",
			sql`(${table.state} = 'in_progress'
					AND ${table.responseStatus} IS NULL
					AND ${table.responseBodyCiphertext} IS NULL
					AND ${table.responseContentType} IS NULL
					AND ${table.completedAt} IS NULL)
				OR (${table.state} = 'completed'
					AND ${table.responseStatus} IS NOT NULL
					AND ${table.responseBodyCiphertext} IS NOT NULL
					AND ${table.completedAt} IS NOT NULL)
				OR (${table.state} = 'unknown' AND ${table.completedAt} IS NULL)`,
		),
		check(
			"idempotency_receipts_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND ${table.expiresAt} > ${table.createdAt}
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
		),
		index("idempotency_receipts_expiry_idx").on(table.expiresAt, table.id),
		index("idempotency_receipts_state_created_idx").on(
			table.state,
			table.createdAt,
		),
	],
);

/**
 * Strongly-consistent, single-use capabilities. Raw bearer values are never
 * stored; payloads (including OAuth PKCE verifiers) are context-encrypted.
 */
export const oneTimeCapabilities = pgTable(
	"one_time_capabilities",
	{
		id: text("id").primaryKey(),
		kind: text("kind", {
			enum: [...ONE_TIME_CAPABILITY_KINDS],
		}).notNull(),
		organizationId: text("organization_id").references(() => organization.id, {
			onDelete: "cascade",
		}),
		payloadCiphertext: text("payload_ciphertext").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
	},
	(table) => [
		check(
			"one_time_capabilities_kind_check",
			sql`${table.kind} IN ('oauth_state', 'websocket_ticket')`,
		),
		index("one_time_capabilities_expiry_idx").on(table.expiresAt, table.id),
		index("one_time_capabilities_org_kind_idx").on(
			table.organizationId,
			table.kind,
		),
	],
);

// ---------------------------------------------------------------------------
// Organization subscriptions
// Pricing: Free (200 API calls/mo hard limit) → Pro $5/mo (10K calls) + $1/1K overage
// ---------------------------------------------------------------------------

export const organizationSubscriptions = pgTable(
	"organization_subscriptions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("sub_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id)
			.unique(),
		// Row existence is settings/storage, not proof of a Stripe trial.
		status: subscriptionStatusEnum("status").notNull().default("cancelled"),
		source: text("source", {
			enum: ["stripe", "complimentary"],
		})
			.notNull()
			.default("stripe"),
		delinquentAt: timestamp("delinquent_at", { withTimezone: true }),
		graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
		trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
		currentPeriodStart: timestamp("current_period_start", {
			withTimezone: true,
		})
			.defaultNow()
			.notNull(),
		currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
		stripeCustomerId: text("stripe_customer_id"),
		stripeCheckoutSessionId: text("stripe_checkout_session_id"),
		stripeSubscriptionId: text("stripe_subscription_id"),
		stripeMeteredItemId: text("stripe_metered_item_id"),
		cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
		aiEnabled: boolean("ai_enabled").notNull().default(false),
		// NULL inherits the current plan default. A concrete value (including
		// zero) is an organization-specific support/operator override.
		dailyToolLimitOverride: integer("daily_tool_limit_override"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("org_subs_stripe_sub_id_idx").on(table.stripeSubscriptionId),
		uniqueIndex("org_subs_stripe_customer_id_idx").on(table.stripeCustomerId),
		check(
			"organization_subscriptions_daily_tool_limit_override_check",
			sql`${table.dailyToolLimitOverride} IS NULL OR ${table.dailyToolLimitOverride} >= 0`,
		),
		check(
			"organization_subscriptions_period_check",
			sql`${table.currentPeriodEnd} IS NULL OR ${table.currentPeriodEnd} > ${table.currentPeriodStart}`,
		),
		check(
			"organization_subscriptions_source_check",
			sql`${table.source} IN ('stripe', 'complimentary')`,
		),
		check(
			"organization_subscriptions_stripe_authority_check",
			sql`(${table.source} = 'complimentary'
					AND ${table.status} IN ('active', 'cancelled')
					AND ${table.stripeSubscriptionId} IS NULL
					AND ${table.stripeMeteredItemId} IS NULL)
				OR (${table.source} = 'stripe'
					AND (${table.status} = 'cancelled'
						OR (${table.status} IN ('active', 'trialing', 'past_due')
							AND ${table.stripeCustomerId} IS NOT NULL
							AND ${table.stripeSubscriptionId} IS NOT NULL)))`,
		),
		check(
			"organization_subscriptions_past_due_check",
			sql`(${table.status} = 'past_due') =
					(${table.delinquentAt} IS NOT NULL AND ${table.graceEndsAt} IS NOT NULL)
				AND (${table.status} = 'past_due'
					OR (${table.delinquentAt} IS NULL AND ${table.graceEndsAt} IS NULL))
				AND (${table.graceEndsAt} IS NULL
					OR ${table.graceEndsAt} = ${table.delinquentAt} + INTERVAL '14 days')`,
		),
	],
);

/**
 * Crash-safe Stripe Checkout creation. The partial unique index allows only
 * one live checkout workflow for an organization while retaining terminal
 * history for reconciliation and support.
 */
export const subscriptionCheckoutOperations = pgTable(
	"subscription_checkout_operations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("sco_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		status: text("status", {
			enum: [
				"pending",
				"creating",
				"unknown",
				"created",
				"completed",
				"blocked",
				"failed",
				"expired",
			],
		})
			.notNull()
			.default("pending"),
		stripeCustomerId: text("stripe_customer_id"),
		stripeCheckoutSessionId: text("stripe_checkout_session_id"),
		stripeCheckoutUrl: text("stripe_checkout_url"),
		idempotencyKey: text("idempotency_key").notNull().unique(),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		sessionExpiresAt: timestamp("session_expires_at", { withTimezone: true }),
		attempts: integer("attempts").notNull().default(0),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("subscription_checkout_operations_active_org_uniq")
			.on(table.organizationId)
			.where(
				sql`${table.status} IN ('pending', 'creating', 'unknown', 'created')`,
			),
		uniqueIndex("subscription_checkout_operations_session_uniq").on(
			table.stripeCheckoutSessionId,
		),
		index("subscription_checkout_operations_status_lease_idx").on(
			table.status,
			table.leaseExpiresAt,
		),
		index("subscription_checkout_operations_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("subscription_checkout_operations_retention_idx").on(
			table.updatedAt,
			table.id,
		),
		check(
			"subscription_checkout_operations_status_check",
			sql`${table.status} IN ('pending', 'creating', 'unknown', 'created', 'completed', 'blocked', 'failed', 'expired')`,
		),
		check(
			"subscription_checkout_operations_counters_nonnegative_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"subscription_checkout_operations_state_fields_check",
			sql`(${table.status} <> 'creating' OR ${table.leaseExpiresAt} IS NOT NULL)
				AND (${table.status} <> 'created'
					OR (${table.stripeCustomerId} IS NOT NULL
						AND ${table.stripeCheckoutSessionId} IS NOT NULL
						AND ${table.stripeCheckoutUrl} IS NOT NULL
						AND ${table.sessionExpiresAt} IS NOT NULL))
				AND (${table.status} <> 'completed'
					OR (${table.stripeCheckoutSessionId} IS NOT NULL AND ${table.completedAt} IS NOT NULL))
				AND (${table.status} <> 'expired' OR ${table.sessionExpiresAt} IS NOT NULL)`,
		),
		check(
			"subscription_checkout_operations_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND (${table.sessionExpiresAt} IS NULL OR ${table.sessionExpiresAt} > ${table.createdAt})
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
		),
	],
);

/**
 * Durable Stripe webhook inbox. The raw provider row is the processing fence
 * for 90 days; a detached SHA-256 receipt preserves replay rejection through
 * the one-year provider window without retaining the event ID or payload.
 */
export const stripeEvents = pgTable(
	"stripe_events",
	{
		id: text("id").primaryKey(),
		// Immutable, set-once tenant attribution. This deliberately has no FK:
		// the raw provider receipt must survive organization deletion until the
		// retention worker has written its minimized financial receipt.
		organizationId: text("organization_id"),
		type: text("type").notNull(),
		objectId: text("object_id"),
		customerId: text("customer_id"),
		subscriptionId: text("subscription_id"),
		payload: jsonb("payload").notNull(),
		status: text("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		lastError: text("last_error"),
		lastErrorClass: text("last_error_class"),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		stripeCreatedAt: timestamp("stripe_created_at", {
			withTimezone: true,
		}).notNull(),
		receivedAt: timestamp("received_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		processedAt: timestamp("processed_at", { withTimezone: true }),
		manualReviewAt: timestamp("manual_review_at", { withTimezone: true }),
		operatorRetryRequestedAt: timestamp("operator_retry_requested_at", {
			withTimezone: true,
		}),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"stripe_events_status_check",
			sql`${table.status} IN ('pending', 'processing', 'succeeded', 'failed', 'manual_review')`,
		),
		check(
			"stripe_events_counters_nonnegative_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"stripe_events_error_class_check",
			sql`${table.lastErrorClass} IS NULL
				OR ${table.lastErrorClass} IN ('transient', 'permanent', 'unresolved', 'retry_exhausted', 'age_exhausted')`,
		),
		check(
			"stripe_events_lease_state_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"stripe_events_completion_check",
			sql`(${table.status} = 'succeeded' AND ${table.processedAt} IS NOT NULL AND ${table.manualReviewAt} IS NULL)
				OR (${table.status} = 'manual_review' AND ${table.processedAt} IS NULL AND ${table.manualReviewAt} IS NOT NULL)
				OR (${table.status} NOT IN ('succeeded', 'manual_review') AND ${table.processedAt} IS NULL AND ${table.manualReviewAt} IS NULL)`,
		),
		check(
			"stripe_events_operator_retry_check",
			sql`${table.operatorRetryRequestedAt} IS NULL
				OR (${table.status} = 'failed'
					AND ${table.processedAt} IS NULL
					AND ${table.manualReviewAt} IS NULL
					AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"stripe_events_terminal_failure_check",
			sql`NOT (${table.status} = 'failed' AND ${table.lastErrorClass} = 'permanent')
				OR (${table.payload} = '{}'::jsonb
					AND ${table.processedAt} IS NULL
					AND ${table.manualReviewAt} IS NULL
					AND ${table.operatorRetryRequestedAt} IS NULL
					AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"stripe_events_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.receivedAt}
				AND (${table.processedAt} IS NULL OR ${table.processedAt} >= ${table.receivedAt})
				AND (${table.manualReviewAt} IS NULL OR ${table.manualReviewAt} >= ${table.receivedAt})
				AND (${table.operatorRetryRequestedAt} IS NULL OR ${table.operatorRetryRequestedAt} >= ${table.receivedAt})`,
		),
		index("stripe_events_status_due_idx").on(
			table.status,
			table.nextAttemptAt,
			table.receivedAt,
			table.id,
		),
		index("stripe_events_processing_lease_idx")
			.on(table.leaseExpiresAt, table.id)
			.where(sql`${table.status} = 'processing'`),
		index("stripe_events_retention_idx").on(table.receivedAt, table.id),
		index("stripe_events_organization_retention_idx").on(
			table.organizationId,
			table.receivedAt,
			table.id,
		),
	],
);

/**
 * One short-lived provider aggregate lease per organization. Stripe event IDs
 * deduplicate delivery; this separate fence serializes canonical reads and
 * applies across all base/add-on events for the same customer.
 */
export const stripeOrganizationLeases = pgTable(
	"stripe_organization_leases",
	{
		organizationId: text("organization_id")
			.primaryKey()
			.references(() => organization.id, { onDelete: "cascade" }),
		leaseToken: integer("lease_token").notNull().default(0),
		ownerEventId: text("owner_event_id"),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		check(
			"stripe_organization_leases_numeric_check",
			sql`${table.leaseToken} >= 0`,
		),
		check(
			"stripe_organization_leases_state_check",
			sql`(${table.ownerEventId} IS NULL AND ${table.leaseExpiresAt} IS NULL)
				OR (${table.ownerEventId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
		),
		index("stripe_organization_leases_expiry_idx").on(
			table.leaseExpiresAt,
			table.organizationId,
		),
	],
);

/** Durable side effects emitted by billing-state transactions. */
export const billingOutbox = pgTable(
	"billing_outbox",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		kind: text("kind", { enum: [...BILLING_OUTBOX_KINDS] }).notNull(),
		payload: jsonb("payload").notNull(),
		status: text("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		lastError: text("last_error"),
		lastErrorClass: text("last_error_class"),
		processedAt: timestamp("processed_at", { withTimezone: true }),
		manualReviewAt: timestamp("manual_review_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"billing_outbox_kind_check",
			sql`${table.kind} IN ('auth_cache.refresh', 'payment_failed.notify', 'subscription.cancel')`,
		),
		check(
			"billing_outbox_status_check",
			sql`${table.status} IN ('pending', 'processing', 'succeeded', 'failed', 'manual_review')`,
		),
		check(
			"billing_outbox_counters_nonnegative_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"billing_outbox_lease_state_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"billing_outbox_completion_check",
			sql`(${table.status} = 'succeeded'
					AND ${table.processedAt} IS NOT NULL
					AND ${table.manualReviewAt} IS NULL)
				OR (${table.status} = 'manual_review'
					AND ${table.processedAt} IS NULL
					AND ${table.manualReviewAt} IS NOT NULL)
				OR (${table.status} NOT IN ('succeeded', 'manual_review')
					AND ${table.processedAt} IS NULL
					AND ${table.manualReviewAt} IS NULL)`,
		),
		check(
			"billing_outbox_error_class_check",
			sql`${table.lastErrorClass} IS NULL
				OR ${table.lastErrorClass} IN ('transient', 'permanent', 'retry_exhausted')`,
		),
		check(
			"billing_outbox_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND (${table.processedAt} IS NULL OR ${table.processedAt} >= ${table.createdAt})
				AND (${table.manualReviewAt} IS NULL OR ${table.manualReviewAt} >= ${table.createdAt})`,
		),
		index("billing_outbox_status_due_idx").on(
			table.status,
			table.nextAttemptAt,
		),
		index("billing_outbox_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("billing_outbox_retention_idx").on(table.updatedAt, table.id),
	],
);

// ---------------------------------------------------------------------------
// Usage authority.
// ---------------------------------------------------------------------------

/**
 * Immutable financial/quota authority for one contiguous entitlement window.
 * A Stripe provider cycle can contain multiple RelayAPI periods after a
 * mid-cycle plan, pricing, or delinquency transition.
 */
export const billingPeriods = pgTable(
	"billing_periods",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("bp_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "restrict" }),
		source: text("source", {
			enum: ["stripe", "complimentary"],
		}).notNull(),
		billable: boolean("billable").notNull(),
		quotaMode: text("quota_mode", {
			enum: ["hard", "metered", "unlimited"],
		}).notNull(),
		providerCycleAnchor: timestamp("provider_cycle_anchor", {
			withTimezone: true,
		}).notNull(),
		periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
		periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
		// Immutable agreement identity. Never infer an ended period's Stripe
		// target from the organization's current subscription: a customer may
		// churn, retain a separately-billed add-on, or subscribe again.
		stripeCustomerId: text("stripe_customer_id"),
		stripeSubscriptionId: text("stripe_subscription_id"),
		stripeProductId: text("stripe_product_id"),
		stripePriceId: text("stripe_price_id"),
		stripePriceRole: text("stripe_price_role", { enum: ["base"] }),
		rateCardVersion: text("rate_card_version"),
		taxBehavior: text("tax_behavior", {
			enum: ["inclusive", "exclusive", "unspecified"],
		}),
		taxCode: text("tax_code"),
		discountable: boolean("discountable"),
		cycleAllowance: bigint("cycle_allowance", { mode: "number" }),
		includedUnits: bigint("included_units", { mode: "number" }),
		pricePerThousandUnitsCents: integer("price_per_thousand_units_cents"),
		basePriceCents: integer("base_price_cents").notNull().default(0),
		currency: varchar("currency", { length: 3 }).notNull().default("usd"),
		state: text("state", {
			enum: [
				"open",
				"closed",
				"claimed",
				"settled",
				"released",
				"written_off",
				"void",
			],
		})
			.notNull()
			.default("open"),
		committedUnitsSnapshot: bigint("committed_units_snapshot", {
			mode: "number",
		}),
		effectiveIncludedUnitsSnapshot: bigint(
			"effective_included_units_snapshot",
			{ mode: "number" },
		),
		overageUnitsSnapshot: bigint("overage_units_snapshot", {
			mode: "number",
		}),
		amountCentsSnapshot: integer("amount_cents_snapshot"),
		invoiceId: text("invoice_id"),
		stripeInvoiceId: text("stripe_invoice_id"),
		releaseCount: integer("release_count").notNull().default(0),
		revision: integer("revision").notNull().default(0),
		closedAt: timestamp("closed_at", { withTimezone: true }),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		settledAt: timestamp("settled_at", { withTimezone: true }),
		releasedAt: timestamp("released_at", { withTimezone: true }),
		writtenOffAt: timestamp("written_off_at", { withTimezone: true }),
		writeOffReason: text("write_off_reason"),
		writeOffEvidence: jsonb("write_off_evidence"),
		voidedAt: timestamp("voided_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("billing_periods_id_org_uniq").on(table.id, table.organizationId),
		unique("billing_periods_id_org_window_uniq").on(
			table.id,
			table.organizationId,
			table.periodStart,
			table.periodEnd,
		),
		uniqueIndex("billing_periods_org_start_live_uniq")
			.on(table.organizationId, table.periodStart)
			.where(sql`${table.state} <> 'void'`),
		index("billing_periods_org_cycle_idx").on(
			table.organizationId,
			table.providerCycleAnchor,
			table.periodStart,
		),
		index("billing_periods_state_end_idx").on(
			table.state,
			table.periodEnd,
			table.organizationId,
			table.id,
		),
		index("billing_periods_retention_idx").on(table.periodEnd, table.id),
		check(
			"billing_periods_window_check",
			sql`${table.periodEnd} > ${table.periodStart}
				AND ${table.providerCycleAnchor} <= ${table.periodStart}`,
		),
		check(
			"billing_periods_source_check",
			sql`${table.source} IN ('stripe', 'complimentary')`,
		),
		check(
			"billing_periods_stripe_price_role_check",
			sql`${table.stripePriceRole} IS NULL OR ${table.stripePriceRole} IN ('base')`,
		),
		check(
			"billing_periods_agreement_shape_check",
			sql`(${table.source} = 'stripe'
					AND ${table.stripeCustomerId} IS NOT NULL
					AND ${table.stripeSubscriptionId} IS NOT NULL
					AND ${table.stripeProductId} IS NOT NULL
					AND ${table.stripePriceId} IS NOT NULL
					AND ${table.stripePriceRole} = 'base'
					AND ${table.rateCardVersion} IS NOT NULL
					AND ${table.taxBehavior} IN ('inclusive', 'exclusive', 'unspecified')
					AND ${table.discountable} IS NOT NULL)
				OR (${table.source} = 'complimentary'
					AND ${table.stripeCustomerId} IS NULL
					AND ${table.stripeSubscriptionId} IS NULL
					AND ${table.stripeProductId} IS NULL
					AND ${table.stripePriceId} IS NULL
					AND ${table.stripePriceRole} IS NULL
					AND ${table.rateCardVersion} IS NULL
					AND ${table.taxBehavior} IS NULL
					AND ${table.taxCode} IS NULL
					AND ${table.discountable} IS NULL)`,
		),
		check(
			"billing_periods_quota_mode_check",
			sql`${table.quotaMode} IN ('hard', 'metered', 'unlimited')`,
		),
		check(
			"billing_periods_quota_shape_check",
			sql`(${table.quotaMode} = 'unlimited'
					AND ${table.cycleAllowance} IS NULL
					AND ${table.includedUnits} IS NULL)
				OR (${table.quotaMode} IN ('hard', 'metered')
					AND ${table.cycleAllowance} IS NOT NULL
					AND ${table.cycleAllowance} >= 0
					AND ${table.includedUnits} IS NOT NULL
					AND ${table.includedUnits} >= 0)`,
		),
		check(
			"billing_periods_billing_shape_check",
			sql`(${table.billable}
					AND ${table.source} = 'stripe'
					AND ${table.quotaMode} = 'metered'
					AND ${table.pricePerThousandUnitsCents} IS NOT NULL
					AND ${table.pricePerThousandUnitsCents} >= 0)
				OR (NOT ${table.billable} AND ${table.pricePerThousandUnitsCents} IS NULL)`,
		),
		check("billing_periods_currency_check", sql`${table.currency} = 'usd'`),
		check(
			"billing_periods_numeric_check",
			sql`${table.basePriceCents} >= 0
				AND ${table.releaseCount} BETWEEN 0 AND 1
				AND ${table.revision} >= 0
				AND (${table.cycleAllowance} IS NULL OR ${table.cycleAllowance} <= 9007199254740991)
				AND (${table.includedUnits} IS NULL OR ${table.includedUnits} <= 9007199254740991)
				AND (${table.committedUnitsSnapshot} IS NULL OR ${table.committedUnitsSnapshot} BETWEEN 0 AND 9007199254740991)
				AND (${table.effectiveIncludedUnitsSnapshot} IS NULL OR ${table.effectiveIncludedUnitsSnapshot} BETWEEN 0 AND 9007199254740991)
				AND (${table.overageUnitsSnapshot} IS NULL OR ${table.overageUnitsSnapshot} BETWEEN 0 AND 9007199254740991)
				AND (${table.amountCentsSnapshot} IS NULL OR ${table.amountCentsSnapshot} >= 0)`,
		),
		check(
			"billing_periods_state_check",
			sql`${table.state} IN ('open', 'closed', 'claimed', 'settled', 'released', 'written_off', 'void')`,
		),
		check(
			"billing_periods_state_shape_check",
			sql`(${table.state} = 'open'
					AND ${table.closedAt} IS NULL
					AND ${table.claimedAt} IS NULL
					AND ${table.settledAt} IS NULL
					AND ${table.releasedAt} IS NULL
					AND ${table.writtenOffAt} IS NULL
					AND ${table.writeOffReason} IS NULL
					AND ${table.writeOffEvidence} IS NULL
					AND ${table.voidedAt} IS NULL
					AND ${table.committedUnitsSnapshot} IS NULL
					AND ${table.effectiveIncludedUnitsSnapshot} IS NULL
					AND ${table.overageUnitsSnapshot} IS NULL
					AND ${table.amountCentsSnapshot} IS NULL
					AND ${table.invoiceId} IS NULL
					AND ${table.stripeInvoiceId} IS NULL)
				OR (${table.state} = 'closed'
					AND ${table.closedAt} IS NOT NULL
					AND ${table.claimedAt} IS NULL
					AND ${table.settledAt} IS NULL
					AND ${table.releasedAt} IS NULL
					AND ${table.writtenOffAt} IS NULL
					AND ${table.writeOffReason} IS NULL
					AND ${table.writeOffEvidence} IS NULL
					AND ${table.voidedAt} IS NULL
					AND ${table.committedUnitsSnapshot} IS NULL
					AND ${table.effectiveIncludedUnitsSnapshot} IS NULL
					AND ${table.overageUnitsSnapshot} IS NULL
					AND ${table.amountCentsSnapshot} IS NULL
					AND ${table.invoiceId} IS NULL
					AND ${table.stripeInvoiceId} IS NULL)
				OR (${table.state} = 'claimed'
					AND ${table.closedAt} IS NOT NULL
					AND ${table.claimedAt} IS NOT NULL
					AND ${table.settledAt} IS NULL
					AND ${table.releasedAt} IS NULL
					AND ${table.writtenOffAt} IS NULL
					AND ${table.writeOffReason} IS NULL
					AND ${table.writeOffEvidence} IS NULL
					AND ${table.voidedAt} IS NULL
					AND ${table.committedUnitsSnapshot} IS NOT NULL
					AND ${table.effectiveIncludedUnitsSnapshot} IS NOT NULL
					AND ${table.overageUnitsSnapshot} IS NOT NULL
					AND ${table.amountCentsSnapshot} IS NOT NULL
					AND ${table.invoiceId} IS NULL
					AND ${table.stripeInvoiceId} IS NULL)
				OR (${table.state} = 'settled'
					AND ${table.closedAt} IS NOT NULL
					AND ${table.claimedAt} IS NOT NULL
					AND ${table.settledAt} IS NOT NULL
					AND ${table.releasedAt} IS NULL
					AND ${table.writtenOffAt} IS NULL
					AND ${table.writeOffReason} IS NULL
					AND ${table.writeOffEvidence} IS NULL
					AND ${table.voidedAt} IS NULL
					AND ${table.committedUnitsSnapshot} IS NOT NULL
					AND ${table.effectiveIncludedUnitsSnapshot} IS NOT NULL
					AND ${table.overageUnitsSnapshot} IS NOT NULL
					AND ${table.amountCentsSnapshot} IS NOT NULL
					AND (
						(${table.amountCentsSnapshot} = 0
							AND ${table.invoiceId} IS NULL
							AND ${table.stripeInvoiceId} IS NULL)
						OR (${table.invoiceId} IS NOT NULL
							AND ${table.stripeInvoiceId} IS NOT NULL)
					))
				OR (${table.state} = 'released'
					AND ${table.closedAt} IS NOT NULL
					AND ${table.claimedAt} IS NOT NULL
					AND ${table.settledAt} IS NULL
					AND ${table.releasedAt} IS NOT NULL
					AND ${table.writtenOffAt} IS NULL
					AND ${table.writeOffReason} IS NULL
					AND ${table.writeOffEvidence} IS NULL
					AND ${table.voidedAt} IS NULL
					AND ${table.releaseCount} = 1
					AND ${table.committedUnitsSnapshot} IS NOT NULL
					AND ${table.effectiveIncludedUnitsSnapshot} IS NOT NULL
					AND ${table.overageUnitsSnapshot} IS NOT NULL
					AND ${table.amountCentsSnapshot} IS NOT NULL
					AND ${table.invoiceId} IS NULL
					AND ${table.stripeInvoiceId} IS NULL)
				OR (${table.state} = 'written_off'
					AND ${table.closedAt} IS NOT NULL
					AND ${table.claimedAt} IS NOT NULL
					AND ${table.settledAt} IS NULL
					AND ${table.releasedAt} IS NULL
					AND ${table.writtenOffAt} IS NOT NULL
					AND length(${table.writeOffReason}) > 0
					AND ${table.writeOffEvidence} IS NOT NULL
					AND ${table.voidedAt} IS NULL
					AND ${table.committedUnitsSnapshot} IS NOT NULL
					AND ${table.effectiveIncludedUnitsSnapshot} IS NOT NULL
					AND ${table.overageUnitsSnapshot} IS NOT NULL
					AND ${table.amountCentsSnapshot} IS NOT NULL
					AND ${table.invoiceId} IS NULL
					AND ${table.stripeInvoiceId} IS NULL)
				OR (${table.state} = 'void'
					AND ${table.voidedAt} IS NOT NULL
					AND ${table.closedAt} IS NULL
					AND ${table.claimedAt} IS NULL
					AND ${table.settledAt} IS NULL
					AND ${table.releasedAt} IS NULL
					AND ${table.writtenOffAt} IS NULL
					AND ${table.writeOffReason} IS NULL
					AND ${table.writeOffEvidence} IS NULL
					AND ${table.committedUnitsSnapshot} IS NULL
					AND ${table.effectiveIncludedUnitsSnapshot} IS NULL
					AND ${table.overageUnitsSnapshot} IS NULL
					AND ${table.amountCentsSnapshot} IS NULL
					AND ${table.invoiceId} IS NULL
					AND ${table.stripeInvoiceId} IS NULL)`,
		),
	],
);

/**
 * Hot-path quota projection. PostgreSQL derives committed/reserved counters
 * from the authoritative usage_reservations ledger with statement triggers.
 */
export const usageBuckets = pgTable(
	"usage_buckets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ub_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		billingPeriodId: text("billing_period_id"),
		metric: text("metric").notNull().default("successful_mutation"),
		periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
		periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
		quotaMode: text("quota_mode", {
			enum: ["hard", "metered", "unlimited"],
		})
			.notNull()
			.default("hard"),
		includedUnits: bigint("included_units", { mode: "number" }),
		committedUnits: bigint("committed_units", { mode: "number" })
			.notNull()
			.default(0),
		reservedUnits: bigint("reserved_units", { mode: "number" })
			.notNull()
			.default(0),
		revision: integer("revision").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("usage_buckets_id_org_uniq").on(table.id, table.organizationId),
		foreignKey({
			columns: [
				table.billingPeriodId,
				table.organizationId,
				table.periodStart,
				table.periodEnd,
			],
			foreignColumns: [
				billingPeriods.id,
				billingPeriods.organizationId,
				billingPeriods.periodStart,
				billingPeriods.periodEnd,
			],
			name: "usage_buckets_billing_period_window_fk",
		})
			.onUpdate("no action")
			.onDelete("restrict"),
		uniqueIndex("usage_buckets_org_metric_period_uniq").on(
			table.organizationId,
			table.metric,
			table.periodStart,
		),
		check(
			"usage_buckets_period_check",
			sql`${table.periodEnd} > ${table.periodStart}`,
		),
		check(
			"usage_buckets_counters_nonnegative_check",
			sql`${table.committedUnits} BETWEEN 0 AND 9007199254740991
				AND ${table.reservedUnits} BETWEEN 0 AND 9007199254740991
				AND ${table.revision} >= 0`,
		),
		check(
			"usage_buckets_quota_shape_check",
			sql`(${table.quotaMode} = 'unlimited' AND ${table.includedUnits} IS NULL)
				OR (${table.quotaMode} IN ('hard', 'metered')
					AND ${table.includedUnits} IS NOT NULL
					AND ${table.includedUnits} BETWEEN 0 AND 9007199254740991)`,
		),
		check(
			"usage_buckets_period_authority_check",
			sql`${table.billingPeriodId} IS NULL
				OR (${table.metric} = 'successful_mutation'
					AND ${table.quotaMode} IN ('hard', 'metered'))`,
		),
		check(
			"usage_buckets_metered_authority_check",
			sql`${table.quotaMode} <> 'metered' OR ${table.billingPeriodId} IS NOT NULL`,
		),
		index("usage_buckets_org_period_end_idx").on(
			table.organizationId,
			table.periodEnd,
		),
		index("usage_buckets_retention_idx").on(table.periodEnd, table.id),
	],
);

/** Durable reserve/commit/release ledger for one billable mutation. */
export const usageReservations = pgTable(
	"usage_reservations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ur_")),
		organizationId: text("organization_id").notNull(),
		bucketId: text("bucket_id").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		// `units` is the immutable reservation size N. A successful bulk request
		// may commit only K units; the difference N-K is released implicitly.
		units: bigint("units", { mode: "number" }).notNull().default(1),
		committedUnits: bigint("committed_units", { mode: "number" }),
		state: text("state", {
			enum: ["reserved", "parked", "committed", "released"],
		})
			.notNull()
			.default("reserved"),
		disposition: text("disposition", {
			enum: [
				"pending",
				"pre_boundary",
				"rejected",
				"proven_not_applied",
				"settled",
				"unknown",
				"written_off",
			],
		})
			.notNull()
			.default("pending"),
		responseStatus: integer("response_status"),
		source: text("source").notNull().default("api"),
		reservedAt: timestamp("reserved_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		writeOffReason: text("write_off_reason"),
		writeOffEvidence: jsonb("write_off_evidence"),
		writtenOffAt: timestamp("written_off_at", { withTimezone: true }),
		finalizedAt: timestamp("finalized_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.bucketId, table.organizationId],
			foreignColumns: [usageBuckets.id, usageBuckets.organizationId],
			name: "usage_reservations_bucket_org_fk",
		}).onDelete("restrict"),
		uniqueIndex("usage_reservations_org_idempotency_uniq").on(
			table.organizationId,
			table.idempotencyKey,
		),
		unique("usage_reservations_id_org_uniq").on(table.id, table.organizationId),
		check(
			"usage_reservations_units_positive_check",
			sql`${table.units} BETWEEN 1 AND 9007199254740991`,
		),
		check(
			"usage_reservations_committed_units_check",
			sql`${table.committedUnits} IS NULL
				OR ${table.committedUnits} BETWEEN 0 AND LEAST(${table.units}, 9007199254740991)`,
		),
		check(
			"usage_reservations_state_check",
			sql`${table.state} IN ('reserved', 'parked', 'committed', 'released')`,
		),
		check(
			"usage_reservations_finalization_check",
			sql`(${table.state} = 'reserved'
						AND ${table.disposition} = 'pending'
						AND ${table.committedUnits} IS NULL
						AND ${table.writeOffReason} IS NULL
						AND ${table.writeOffEvidence} IS NULL
						AND ${table.writtenOffAt} IS NULL
						AND ${table.finalizedAt} IS NULL)
					OR (${table.state} = 'parked'
						AND ${table.disposition} = 'unknown'
						AND ${table.committedUnits} IS NULL
						AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
						AND ${table.writeOffReason} IS NULL
						AND ${table.writeOffEvidence} IS NULL
						AND ${table.writtenOffAt} IS NULL
						AND ${table.finalizedAt} IS NULL)
					OR (${table.state} = 'released'
						AND ${table.disposition} = 'pre_boundary'
						AND ${table.committedUnits} = 0
						AND ${table.requestMayHaveBeenSentAt} IS NULL
						AND ${table.writeOffReason} IS NULL
						AND ${table.writeOffEvidence} IS NULL
						AND ${table.writtenOffAt} IS NULL
						AND ${table.finalizedAt} IS NOT NULL)
					OR (${table.state} = 'released'
						AND ${table.disposition} = 'rejected'
						AND ${table.committedUnits} = 0
						AND ${table.responseStatus} BETWEEN 400 AND 499
						AND ${table.writeOffReason} IS NULL
						AND ${table.writeOffEvidence} IS NULL
						AND ${table.writtenOffAt} IS NULL
						AND ${table.finalizedAt} IS NOT NULL)
					OR (${table.state} = 'released'
						AND ${table.disposition} = 'proven_not_applied'
						AND ${table.committedUnits} = 0
						AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
						AND ${table.responseStatus} BETWEEN 500 AND 599
						AND ${table.writeOffReason} IS NULL
						AND ${table.writeOffEvidence} IS NULL
						AND ${table.writtenOffAt} IS NULL
						AND ${table.finalizedAt} IS NOT NULL)
					OR (${table.state} = 'released'
						AND ${table.disposition} = 'written_off'
						AND ${table.committedUnits} = 0
						AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
						AND length(${table.writeOffReason}) > 0
						AND ${table.writeOffEvidence} IS NOT NULL
						AND ${table.writtenOffAt} IS NOT NULL
						AND ${table.finalizedAt} = ${table.writtenOffAt})
					OR (${table.state} = 'committed'
						AND ${table.disposition} = 'settled'
						AND ${table.committedUnits} IS NOT NULL
						AND ${table.writeOffReason} IS NULL
						AND ${table.writeOffEvidence} IS NULL
						AND ${table.writtenOffAt} IS NULL
						AND ${table.finalizedAt} IS NOT NULL)`,
		),
		check(
			"usage_reservations_boundary_timestamp_check",
			sql`${table.requestMayHaveBeenSentAt} IS NULL
					OR ${table.requestMayHaveBeenSentAt} >= ${table.reservedAt}`,
		),
		check(
			"usage_reservations_response_status_check",
			sql`${table.responseStatus} IS NULL OR (${table.responseStatus} >= 100 AND ${table.responseStatus} <= 599)`,
		),
		index("usage_reservations_bucket_state_idx").on(
			table.bucketId,
			table.state,
		),
		index("usage_reservations_reserved_age_idx")
			.on(table.reservedAt, table.id)
			.where(sql`${table.state} = 'reserved'`),
		index("usage_reservations_parked_age_idx")
			.on(table.reservedAt, table.id)
			.where(sql`${table.state} = 'parked'`),
		index("usage_reservations_retention_idx").on(table.bucketId, table.id),
	],
);

/**
 * Settlement-aware allowance edges for reservations that outlive a billing
 * period split. The source reservation keeps its original rate attribution;
 * every later successor can independently hold N while the outcome is
 * unresolved and permanently debit only the eventual committed K.
 */
export const usageReservationCarryovers = pgTable(
	"usage_reservation_carryovers",
	{
		sourceReservationId: text("source_reservation_id").notNull(),
		organizationId: text("organization_id").notNull(),
		successorBucketId: text("successor_bucket_id").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		primaryKey({
			name: "usage_reservation_carryovers_pk",
			columns: [table.sourceReservationId, table.successorBucketId],
		}),
		foreignKey({
			columns: [table.sourceReservationId, table.organizationId],
			foreignColumns: [usageReservations.id, usageReservations.organizationId],
			name: "usage_reservation_carryovers_source_org_fk",
		})
			.onUpdate("no action")
			.onDelete("cascade"),
		foreignKey({
			columns: [table.successorBucketId, table.organizationId],
			foreignColumns: [usageBuckets.id, usageBuckets.organizationId],
			name: "usage_reservation_carryovers_successor_org_fk",
		})
			.onUpdate("no action")
			.onDelete("cascade"),
		index("usage_reservation_carryovers_successor_idx").on(
			table.successorBucketId,
			table.sourceReservationId,
		),
		index("usage_reservation_carryovers_source_idx").on(
			table.sourceReservationId,
			table.successorBucketId,
		),
	],
);

// ---------------------------------------------------------------------------
// Invoices (monthly billing records)
// ---------------------------------------------------------------------------

export const invoices = pgTable(
	"invoices",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("inv_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		status: invoiceStatusEnum("status").notNull().default("draft"),
		periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
		periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
		basePriceCents: integer("base_price_cents").notNull().default(0),
		apiCallsCount: bigint("api_calls_count", { mode: "number" })
			.notNull()
			.default(0),
		apiCallsIncluded: bigint("api_calls_included", { mode: "number" })
			.notNull()
			.default(10000),
		overageCalls: bigint("overage_calls", { mode: "number" })
			.notNull()
			.default(0),
		overageCostCents: integer("overage_cost_cents").notNull().default(0),
		totalCents: integer("total_cents").notNull().default(0),
		currency: varchar("currency", { length: 3 }).notNull().default("usd"),
		stripeInvoiceId: text("stripe_invoice_id").unique(),
		stripeHostedUrl: text("stripe_hosted_url"),
		firstPaymentFailedAt: timestamp("first_payment_failed_at", {
			withTimezone: true,
		}),
		finalizedAt: timestamp("finalized_at", { withTimezone: true }),
		paidAt: timestamp("paid_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("invoices_id_org_uniq").on(table.id, table.organizationId),
		index("invoices_org_period_idx").on(
			table.organizationId,
			table.periodStart,
		),
		index("invoices_org_first_failure_idx").on(
			table.organizationId,
			table.firstPaymentFailedAt,
		),
		index("invoices_retention_idx").on(
			sql`COALESCE(${table.paidAt}, ${table.finalizedAt}, ${table.periodEnd}, ${table.updatedAt})`,
			table.id,
		),
		check(
			"invoices_period_order_check",
			sql`${table.periodEnd} > ${table.periodStart}`,
		),
		check(
			"invoices_amounts_nonnegative_check",
			sql`${table.basePriceCents} >= 0
				AND ${table.apiCallsCount} >= 0
				AND ${table.apiCallsIncluded} >= 0
				AND ${table.overageCalls} >= 0
				AND ${table.overageCostCents} >= 0
				AND ${table.totalCents} >= 0`,
		),
		check(
			"invoices_usage_safe_integer_check",
			sql`${table.apiCallsCount} <= 9007199254740991
				AND ${table.apiCallsIncluded} <= 9007199254740991
				AND ${table.overageCalls} <= 9007199254740991`,
		),
		check(
			"invoices_failure_not_draft_check",
			sql`${table.firstPaymentFailedAt} IS NULL OR ${table.status} <> 'draft'`,
		),
		check("invoices_currency_check", sql`${table.currency} = 'usd'`),
	],
);

/**
 * Durable Stripe mutation state. Each operation owns exactly one billing
 * period, so unknown Stripe outcomes can be reconciled without a second
 * settlement lifecycle.
 */
export const billingOperations = pgTable(
	"billing_operations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("bop_")),
		organizationId: text("organization_id").notNull(),
		billingPeriodId: text("billing_period_id").notNull(),
		kind: text("kind", { enum: ["cycle", "catchup"] })
			.notNull()
			.default("cycle"),
		status: text("status").notNull().default("pending"),
		stripeCustomerId: text("stripe_customer_id").notNull(),
		stripeSubscriptionId: text("stripe_subscription_id").notNull(),
		stripeInvoiceId: text("stripe_invoice_id"),
		stripeInvoiceItemId: text("stripe_invoice_item_id"),
		invoiceIdempotencyKey: text("invoice_idempotency_key").unique(),
		idempotencyKey: text("idempotency_key").notNull().unique(),
		attemptRevision: integer("attempt_revision").notNull().default(1),
		amountCents: integer("amount_cents").notNull(),
		currency: varchar("currency", { length: 3 }).notNull().default("usd"),
		description: text("description").notNull(),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		lastError: text("last_error"),
		lastErrorClass: text("last_error_class"),
		operatorRetryRequestedAt: timestamp("operator_retry_requested_at", {
			withTimezone: true,
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		unique("billing_operations_id_org_uniq").on(table.id, table.organizationId),
		uniqueIndex("billing_operations_period_kind_uniq").on(
			table.billingPeriodId,
			table.kind,
		),
		foreignKey({
			columns: [table.billingPeriodId, table.organizationId],
			foreignColumns: [billingPeriods.id, billingPeriods.organizationId],
			name: "billing_operations_billing_period_org_fk",
		}).onDelete("restrict"),
		check(
			"billing_operations_status_check",
			sql`${table.status} IN ('invoice_preparing', 'invoice_unknown', 'pending', 'processing', 'failed', 'unknown', 'succeeded', 'terminal_failed', 'manual_review', 'released', 'written_off')`,
		),
		check(
			"billing_operations_kind_check",
			sql`${table.kind} IN ('cycle', 'catchup')`,
		),
		check(
			"billing_operations_kind_shape_check",
			sql`(${table.kind} = 'cycle'
					AND ${table.stripeInvoiceId} IS NOT NULL
					AND ${table.invoiceIdempotencyKey} IS NULL
					AND ${table.status} NOT IN ('invoice_preparing', 'invoice_unknown'))
				OR (${table.kind} = 'catchup'
					AND ${table.invoiceIdempotencyKey} IS NOT NULL
					AND ((${table.status} IN ('invoice_preparing', 'invoice_unknown')
							AND ${table.stripeInvoiceId} IS NULL)
						OR (${table.status} IN ('pending', 'processing', 'failed', 'unknown', 'succeeded', 'terminal_failed', 'released')
							AND ${table.stripeInvoiceId} IS NOT NULL)
						OR ${table.status} IN ('manual_review', 'written_off')))`,
		),
		check(
			"billing_operations_numeric_check",
			sql`${table.amountCents} >= 0
				AND ${table.attemptRevision} > 0
				AND ${table.attempts} >= 0
				AND ${table.leaseToken} >= 0`,
		),
		check("billing_operations_currency_check", sql`${table.currency} = 'usd'`),
		check(
			"billing_operations_lease_state_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"billing_operations_completion_check",
			sql`(${table.status} = 'succeeded'
					AND ${table.stripeInvoiceItemId} IS NOT NULL
					AND ${table.completedAt} IS NOT NULL)
				OR (${table.status} IN ('terminal_failed', 'manual_review', 'released', 'written_off')
					AND ${table.completedAt} IS NOT NULL)
				OR (${table.status} NOT IN ('succeeded', 'terminal_failed', 'manual_review', 'released', 'written_off')
					AND ${table.completedAt} IS NULL)`,
		),
		check(
			"billing_operations_operator_retry_check",
			sql`${table.operatorRetryRequestedAt} IS NULL
				OR (${table.status} = 'unknown'
					AND ${table.completedAt} IS NULL
					AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"billing_operations_error_class_check",
			sql`${table.lastErrorClass} IS NULL
				OR ${table.lastErrorClass} IN ('transient', 'unknown', 'permanent', 'retry_exhausted', 'age_exhausted')`,
		),
		check(
			"billing_operations_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND (${table.operatorRetryRequestedAt} IS NULL OR ${table.operatorRetryRequestedAt} >= ${table.createdAt})
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
		),
		index("billing_operations_status_due_idx").on(
			table.status,
			table.nextAttemptAt,
		),
		index("billing_operations_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("billing_operations_retention_idx").on(table.updatedAt, table.id),
	],
);

/**
 * Revisioned provider attempts for one settlement operation. Economic and
 * targeting fields are immutable once inserted; retrying an ambiguous request
 * reuses this row and idempotency key. A corrected payload requires a new
 * revision after the previous revision has provider evidence that it did not
 * apply.
 */
export const billingOperationAttempts = pgTable(
	"billing_operation_attempts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("boa_")),
		organizationId: text("organization_id").notNull(),
		billingOperationId: text("billing_operation_id").notNull(),
		revision: integer("revision").notNull(),
		status: text("status", {
			enum: [
				"prepared",
				"requesting",
				"unknown",
				"succeeded",
				"rejected",
				"written_off",
			],
		})
			.notNull()
			.default("prepared"),
		stripeCustomerId: text("stripe_customer_id").notNull(),
		stripeSubscriptionId: text("stripe_subscription_id").notNull(),
		stripeInvoiceId: text("stripe_invoice_id").notNull(),
		stripeInvoiceItemId: text("stripe_invoice_item_id"),
		idempotencyKey: text("idempotency_key").notNull().unique(),
		amountCents: integer("amount_cents").notNull(),
		currency: varchar("currency", { length: 3 }).notNull().default("usd"),
		description: text("description").notNull(),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		providerEvidence: jsonb("provider_evidence"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.billingOperationId, table.organizationId],
			foreignColumns: [billingOperations.id, billingOperations.organizationId],
			name: "billing_operation_attempts_operation_org_fk",
		}).onDelete("restrict"),
		uniqueIndex("billing_operation_attempts_operation_revision_uniq").on(
			table.billingOperationId,
			table.revision,
		),
		check(
			"billing_operation_attempts_status_check",
			sql`${table.status} IN ('prepared', 'requesting', 'unknown', 'succeeded', 'rejected', 'written_off')`,
		),
		check(
			"billing_operation_attempts_numeric_check",
			sql`${table.revision} > 0 AND ${table.amountCents} >= 0`,
		),
		check(
			"billing_operation_attempts_currency_check",
			sql`${table.currency} = 'usd'`,
		),
		check(
			"billing_operation_attempts_state_shape_check",
			sql`(${table.status} = 'prepared'
					AND ${table.requestMayHaveBeenSentAt} IS NULL
					AND ${table.stripeInvoiceItemId} IS NULL
					AND ${table.providerEvidence} IS NULL
					AND ${table.resolvedAt} IS NULL)
				OR (${table.status} = 'requesting'
					AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
					AND ${table.stripeInvoiceItemId} IS NULL
					AND ${table.providerEvidence} IS NULL
					AND ${table.resolvedAt} IS NULL)
				OR (${table.status} = 'unknown'
					AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
					AND ${table.stripeInvoiceItemId} IS NULL
					AND ${table.resolvedAt} IS NULL)
				OR (${table.status} = 'succeeded'
					AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
					AND ${table.stripeInvoiceItemId} IS NOT NULL
					AND ${table.providerEvidence} IS NOT NULL
					AND ${table.resolvedAt} IS NOT NULL)
				OR (${table.status} IN ('rejected', 'written_off')
					AND ${table.providerEvidence} IS NOT NULL
					AND ${table.resolvedAt} IS NOT NULL)`,
		),
		check(
			"billing_operation_attempts_timestamp_order_check",
			sql`(${table.requestMayHaveBeenSentAt} IS NULL OR ${table.requestMayHaveBeenSentAt} >= ${table.createdAt})
				AND (${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.createdAt})`,
		),
		index("billing_operation_attempts_operation_status_idx").on(
			table.billingOperationId,
			table.status,
		),
		index("billing_operation_attempts_retention_idx").on(
			table.createdAt,
			table.id,
		),
	],
);

// ---------------------------------------------------------------------------
// Dunning events (tracks payment failure notifications)
// ---------------------------------------------------------------------------

export const dunningEvents = pgTable(
	"dunning_events",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("dun_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		invoiceId: text("invoice_id").references(() => invoices.id),
		stripeInvoiceId: text("stripe_invoice_id"),
		event: text("event").notNull(), // "reminder_1d", "reminder_7d", "deactivated_14d"
		status: text("status", {
			enum: ["pending", "processing", "sent", "failed", "terminal_failed"],
		})
			.notNull()
			.default("pending"),
		deliveryIdempotencyKey: text("delivery_idempotency_key").notNull().unique(),
		dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
		providerMessageId: text("provider_message_id"),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		deadlineAt: timestamp("deadline_at", { withTimezone: true })
			.notNull()
			.default(sql`now() + interval '24 hours'`),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		lastError: text("last_error"),
		deactivationStatus: text("deactivation_status", {
			enum: [
				"not_applicable",
				"pending",
				"processing",
				"unknown",
				"succeeded",
				"failed",
				"manual_review",
			],
		})
			.notNull()
			.default("not_applicable"),
		deactivationOperationId: text("deactivation_operation_id").unique(),
		deactivationRequestedAt: timestamp("deactivation_requested_at", {
			withTimezone: true,
		}),
		deactivationConfirmedAt: timestamp("deactivation_confirmed_at", {
			withTimezone: true,
		}),
		deactivationProviderResponse: jsonb("deactivation_provider_response"),
		deactivationLastError: text("deactivation_last_error"),
		sentAt: timestamp("sent_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.invoiceId, table.organizationId],
			foreignColumns: [invoices.id, invoices.organizationId],
			name: "dunning_events_invoice_org_fk",
		}),
		uniqueIndex("dunning_events_invoice_event_uniq")
			.on(table.invoiceId, table.event)
			.where(sql`${table.invoiceId} IS NOT NULL`),
		uniqueIndex("dunning_events_stripe_invoice_event_uniq")
			.on(table.stripeInvoiceId, table.event)
			.where(sql`${table.stripeInvoiceId} IS NOT NULL`),
		check(
			"dunning_events_identity_check",
			sql`${table.invoiceId} IS NOT NULL OR ${table.stripeInvoiceId} IS NOT NULL`,
		),
		check(
			"dunning_events_event_check",
			sql`${table.event} IN ('reminder_1d', 'reminder_7d', 'deactivated_14d')`,
		),
		check(
			"dunning_events_status_check",
			sql`${table.status} IN ('pending', 'processing', 'sent', 'failed', 'terminal_failed')`,
		),
		check(
			"dunning_events_deactivation_status_check",
			sql`${table.deactivationStatus} IN ('not_applicable', 'pending', 'processing', 'unknown', 'succeeded', 'failed', 'manual_review')`,
		),
		check(
			"dunning_events_counters_nonnegative_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"dunning_events_delivery_state_check",
			sql`(${table.status} = 'sent' AND ${table.sentAt} IS NOT NULL)
				OR (${table.status} <> 'sent' AND ${table.sentAt} IS NULL)`,
		),
		check(
			"dunning_events_processing_lease_check",
			sql`${table.status} <> 'processing' OR ${table.leaseExpiresAt} IS NOT NULL`,
		),
		check(
			"dunning_events_deactivation_state_check",
			sql`(
				${table.event} <> 'deactivated_14d'
				AND ${table.deactivationStatus} = 'not_applicable'
				AND ${table.deactivationOperationId} IS NULL
				AND ${table.deactivationRequestedAt} IS NULL
				AND ${table.deactivationConfirmedAt} IS NULL
				AND ${table.deactivationProviderResponse} IS NULL
				AND ${table.deactivationLastError} IS NULL
			) OR (
				${table.event} = 'deactivated_14d'
				AND ${table.deactivationStatus} IN ('pending', 'processing', 'unknown', 'succeeded', 'failed', 'manual_review')
				AND ${table.deactivationOperationId} IS NOT NULL
				AND (
					(${table.deactivationStatus} = 'succeeded' AND ${table.deactivationConfirmedAt} IS NOT NULL)
					OR (${table.deactivationStatus} <> 'succeeded' AND ${table.deactivationConfirmedAt} IS NULL)
				)
			)`,
		),
		index("dunning_events_org_idx").on(table.organizationId),
		index("dunning_events_invoice_id_idx").on(table.invoiceId),
		index("dunning_events_status_due_idx").on(
			table.status,
			table.dueAt,
			table.nextAttemptAt,
			table.organizationId,
			table.leaseExpiresAt,
		),
		index("dunning_events_retention_idx").on(table.updatedAt, table.id),
	],
);

/**
 * Detached, minimized evidence for financial reconciliation and retention.
 *
 * This relation deliberately has no foreign keys: tenant erasure removes the
 * live organization and all operational billing state while these tombstoned
 * facts remain independently drainable. Provider identifiers are represented
 * only by SHA-256 digests. UPDATE is rejected by a generated database trigger;
 * DELETE remains available to the bounded retention worker.
 */
export const financialRetentionReceipts = pgTable(
	"financial_retention_receipts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("frr_")),
		sourceKind: text("source_kind", {
			enum: [...FINANCIAL_RETENTION_SOURCE_KINDS],
		}).notNull(),
		sourceId: varchar("source_id", { length: 128 }).notNull(),
		organizationTombstoneId: text("organization_tombstone_id"),
		retentionClass: text("retention_class", {
			enum: [...FINANCIAL_RETENTION_CLASSES],
		}).notNull(),
		status: text("status", {
			enum: [...FINANCIAL_RETENTION_STATUSES],
		}).notNull(),
		periodStart: timestamp("period_start", { withTimezone: true }),
		periodEnd: timestamp("period_end", { withTimezone: true }),
		amountCents: integer("amount_cents"),
		currency: varchar("currency", { length: 3 }),
		quantity: bigint("quantity", { mode: "number" }),
		includedQuantity: bigint("included_quantity", { mode: "number" }),
		overageQuantity: bigint("overage_quantity", { mode: "number" }),
		providerReferenceDigest: varchar("provider_reference_digest", {
			length: 64,
		}),
		retentionAnchorAt: timestamp("retention_anchor_at", {
			withTimezone: true,
		}).notNull(),
		recordedAt: timestamp("recorded_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		retainedUntil: timestamp("retained_until", {
			withTimezone: true,
		}).notNull(),
	},
	(table) => [
		uniqueIndex("financial_retention_receipts_tenant_source_uniq")
			.on(table.sourceKind, table.sourceId, table.organizationTombstoneId)
			.where(sql`${table.organizationTombstoneId} IS NOT NULL`),
		uniqueIndex("financial_retention_receipts_global_source_uniq")
			.on(table.sourceKind, table.sourceId)
			.where(sql`${table.organizationTombstoneId} IS NULL`),
		index("financial_retention_receipts_org_expiry_idx").on(
			table.organizationTombstoneId,
			table.retainedUntil,
			table.id,
		),
		index("financial_retention_receipts_expiry_idx").on(
			table.retainedUntil,
			table.id,
		),
		check(
			"financial_retention_receipts_source_kind_check",
			sql`${table.sourceKind} IN ('subscription_snapshot', 'invoice', 'usage_bucket', 'billing_period', 'billing_operation', 'phone_billing_operation', 'dunning_event', 'checkout_operation', 'billing_outbox', 'stripe_event_financial', 'stripe_event_global')`,
		),
		check(
			"financial_retention_receipts_retention_class_check",
			sql`${table.retentionClass} IN ('financial_7_years', 'usage_25_months', 'provider_receipt_1_year')`,
		),
		check(
			"financial_retention_receipts_status_check",
			sql`${table.status} IN ('active', 'pending', 'succeeded', 'failed', 'unknown', 'manual_review', 'cancelled', 'paid', 'void', 'settled', 'released', 'written_off')`,
		),
		check(
			"financial_retention_receipts_identity_check",
			sql`length(btrim(${table.sourceId})) BETWEEN 1 AND 128
				AND (
					${table.sourceKind} NOT IN ('stripe_event_financial', 'stripe_event_global')
					OR ${table.sourceId} ~ '^[0-9a-f]{64}$'
				)
				AND (
					(${table.sourceKind} = 'stripe_event_global'
						AND ${table.organizationTombstoneId} IS NULL)
					OR (${table.sourceKind} <> 'stripe_event_global'
						AND ${table.organizationTombstoneId} IS NOT NULL)
				)`,
		),
		check(
			"financial_retention_receipts_provider_digest_check",
			sql`${table.providerReferenceDigest} IS NULL
				OR ${table.providerReferenceDigest} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"financial_retention_receipts_provider_digest_source_check",
			sql`(${table.sourceKind} = 'usage_bucket'
					AND ${table.providerReferenceDigest} IS NULL)
				OR (${table.sourceKind} IN ('billing_period', 'billing_operation', 'phone_billing_operation', 'dunning_event', 'checkout_operation', 'stripe_event_financial', 'stripe_event_global')
					AND ${table.providerReferenceDigest} IS NOT NULL)
				OR ${table.sourceKind} IN ('subscription_snapshot', 'invoice', 'billing_outbox')`,
		),
		check(
			"financial_retention_receipts_period_check",
			sql`(
					${table.periodStart} IS NULL
					AND ${table.periodEnd} IS NULL
				) OR (
					${table.periodStart} IS NOT NULL
					AND ${table.periodEnd} IS NOT NULL
					AND ${table.periodEnd} > ${table.periodStart}
				)`,
		),
		check(
			"financial_retention_receipts_amount_currency_check",
			sql`(
					${table.amountCents} IS NULL
					AND ${table.currency} IS NULL
				) OR (
					${table.amountCents} IS NOT NULL
					AND ${table.currency} IS NOT NULL
					AND ${table.amountCents} >= 0
					AND ${table.currency} ~ '^[a-z]{3}$'
				)`,
		),
		check(
			"financial_retention_receipts_quantities_check",
			sql`(${table.quantity} IS NULL OR ${table.quantity} BETWEEN 0 AND 9007199254740991)
				AND (${table.includedQuantity} IS NULL OR ${table.includedQuantity} BETWEEN 0 AND 9007199254740991)
				AND (${table.overageQuantity} IS NULL OR ${table.overageQuantity} BETWEEN 0 AND 9007199254740991)`,
		),
		check(
			"financial_retention_receipts_class_check",
			sql`(${table.sourceKind} = 'usage_bucket'
					AND ${table.retentionClass} = 'usage_25_months')
				OR (${table.sourceKind} = 'stripe_event_global'
					AND ${table.retentionClass} = 'provider_receipt_1_year')
				OR (${table.sourceKind} NOT IN ('usage_bucket', 'stripe_event_global')
					AND ${table.retentionClass} = 'financial_7_years')`,
		),
		check(
			"financial_retention_receipts_status_source_check",
			sql`(${table.sourceKind} = 'subscription_snapshot'
					AND ${table.status} IN ('active', 'failed', 'cancelled'))
				OR (${table.sourceKind} = 'invoice'
					AND ${table.status} IN ('pending', 'paid', 'void'))
				OR (${table.sourceKind} = 'usage_bucket'
					AND ${table.status} IN ('pending', 'settled', 'released', 'void', 'written_off'))
				OR (${table.sourceKind} = 'billing_period'
					AND ${table.status} IN ('pending', 'settled', 'released', 'void', 'written_off'))
				OR (${table.sourceKind} = 'billing_operation'
					AND ${table.status} IN ('pending', 'succeeded', 'failed', 'unknown', 'manual_review', 'released', 'written_off'))
				OR (${table.sourceKind} = 'phone_billing_operation'
					AND ${table.status} IN ('pending', 'succeeded', 'unknown', 'manual_review'))
				OR (${table.sourceKind} = 'dunning_event'
					AND ${table.status} IN ('pending', 'succeeded', 'failed', 'unknown', 'manual_review'))
				OR (${table.sourceKind} = 'checkout_operation'
					AND ${table.status} = 'unknown')
				OR (${table.sourceKind} = 'billing_outbox'
					AND ${table.status} = 'manual_review')
				OR (${table.sourceKind} = 'stripe_event_financial'
					AND ${table.status} IN ('failed', 'manual_review'))
				OR (${table.sourceKind} = 'stripe_event_global'
					AND ${table.status} IN ('pending', 'succeeded', 'failed', 'manual_review'))`,
		),
		check(
			"financial_retention_receipts_value_shape_check",
			sql`(${table.sourceKind} = 'subscription_snapshot'
					AND ${table.periodStart} IS NULL
					AND ${table.periodEnd} IS NULL
					AND ${table.amountCents} IS NULL
					AND ${table.currency} IS NULL
					AND ${table.quantity} IS NULL
					AND ${table.includedQuantity} IS NULL
					AND ${table.overageQuantity} IS NULL)
				OR (${table.sourceKind} = 'invoice'
					AND ${table.periodStart} IS NOT NULL
					AND ${table.amountCents} IS NOT NULL
					AND ${table.quantity} IS NOT NULL
					AND ${table.includedQuantity} IS NOT NULL
					AND ${table.overageQuantity} IS NOT NULL)
				OR (${table.sourceKind} = 'usage_bucket'
					AND ${table.periodStart} IS NOT NULL
					AND ${table.amountCents} IS NULL
					AND ${table.quantity} IS NOT NULL
					AND ${table.includedQuantity} IS NOT NULL
					AND ${table.overageQuantity} IS NOT NULL)
				OR (${table.sourceKind} = 'billing_period'
					AND ${table.periodStart} IS NOT NULL
					AND ${table.amountCents} IS NOT NULL
					AND ${table.quantity} IS NOT NULL
					AND ${table.includedQuantity} IS NOT NULL
					AND ${table.overageQuantity} IS NOT NULL)
				OR (${table.sourceKind} = 'billing_operation'
					AND ${table.periodStart} IS NOT NULL
					AND ${table.amountCents} IS NOT NULL
					AND ${table.quantity} IS NOT NULL
					AND ${table.includedQuantity} IS NULL
					AND ${table.overageQuantity} IS NULL)
				OR (${table.sourceKind} = 'phone_billing_operation'
					AND ${table.periodStart} IS NULL
					AND ${table.periodEnd} IS NULL
					AND ${table.amountCents} IS NULL
					AND ${table.currency} IS NULL
					AND ${table.quantity} IS NOT NULL
					AND ${table.includedQuantity} IS NULL
					AND ${table.overageQuantity} IS NULL)
				OR (${table.sourceKind} IN ('dunning_event', 'checkout_operation', 'billing_outbox', 'stripe_event_financial', 'stripe_event_global')
					AND ${table.periodStart} IS NULL
					AND ${table.amountCents} IS NULL
					AND ${table.quantity} IS NULL
					AND ${table.includedQuantity} IS NULL
					AND ${table.overageQuantity} IS NULL)`,
		),
		check(
			"financial_retention_receipts_retention_clock_check",
			sql`${table.retainedUntil} > ${table.recordedAt}
				AND (
					(${table.retentionClass} = 'financial_7_years'
						AND ${table.retainedUntil} = ${table.retentionAnchorAt} + INTERVAL '7 years')
					OR (${table.retentionClass} = 'usage_25_months'
						AND ${table.retainedUntil} = ${table.retentionAnchorAt} + INTERVAL '25 months')
					OR (${table.retentionClass} = 'provider_receipt_1_year'
						AND ${table.retainedUntil} = ${table.retentionAnchorAt} + INTERVAL '1 year')
				)`,
		),
	],
);

// ---------------------------------------------------------------------------
// User preferences (timezone, language, etc.)
// ---------------------------------------------------------------------------

export const userPreferences = pgTable(
	"user_preferences",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("upref_")),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" })
			.unique(),
		timezone: text("timezone").notNull().default("UTC"),
		language: text("language").notNull().default("en"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"user_preferences_timezone_shape_check",
			sql`length(btrim(${table.timezone})) BETWEEN 1 AND 128`,
		),
		check(
			"user_preferences_language_check",
			sql`${table.language} IN ('en', 'es', 'fr', 'de', 'ja', 'zh')`,
		),
		check(
			"user_preferences_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}`,
		),
	],
);

// ---------------------------------------------------------------------------
// Notifications (in-app notifications for users)
// ---------------------------------------------------------------------------

export const notifications = pgTable(
	"notifications",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("notif_")),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		type: text("type", { enum: [...NOTIFICATION_TYPES] }).notNull(),
		title: text("title").notNull(),
		body: text("body").notNull(),
		data: jsonb("data"), // arbitrary payload: { postId, accountId, platform, ... }
		occurrenceId: text("occurrence_id"),
		read: boolean("read").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"notifications_type_check",
			sql`${table.type} IN ('post_failed', 'post_published', 'account_disconnected', 'payment_failed', 'usage_warning', 'weekly_digest', 'marketing', 'streak_warning', 'automation_notice')`,
		),
		foreignKey({
			columns: [table.userId, table.organizationId],
			foreignColumns: [member.userId, member.organizationId],
			name: "notifications_member_fk",
		}).onDelete("cascade"),
		index("notifications_user_created_idx").on(table.userId, table.createdAt),
		index("notifications_user_read_idx").on(table.userId, table.read),
		uniqueIndex("notifications_user_occurrence_uniq")
			.on(table.userId, table.organizationId, table.occurrenceId)
			.where(sql`${table.occurrenceId} IS NOT NULL`),
		index("notifications_retention_idx").on(table.createdAt, table.id),
	],
);

// ---------------------------------------------------------------------------
// Notification preferences (per-user, per-organization channel settings)
// ---------------------------------------------------------------------------

export const notificationPreferences = pgTable(
	"notification_preferences",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("npref_")),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		postFailures: jsonb("post_failures")
			.notNull()
			.default({ push: true, email: true }),
		postPublished: jsonb("post_published")
			.notNull()
			.default({ push: true, email: false }),
		accountDisconnects: jsonb("account_disconnects")
			.notNull()
			.default({ push: true, email: true }),
		paymentAlerts: jsonb("payment_alerts")
			.notNull()
			.default({ push: true, email: true }),
		usageAlerts: jsonb("usage_alerts")
			.notNull()
			.default({ push: true, email: true }),
		weeklyDigest: jsonb("weekly_digest")
			.notNull()
			.default({ push: false, email: false }),
		marketing: jsonb("marketing")
			.notNull()
			.default({ push: false, email: false }),
		streakWarnings: jsonb("streak_warnings")
			.notNull()
			.default({ push: true, email: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.userId, table.organizationId],
			foreignColumns: [member.userId, member.organizationId],
			name: "notification_preferences_member_fk",
		}).onDelete("cascade"),
		uniqueIndex("notification_preferences_user_org_idx").on(
			table.userId,
			table.organizationId,
		),
	],
);

// ---------------------------------------------------------------------------
// Inbox — Conversations & Messages (unified across all platforms)
// ---------------------------------------------------------------------------

export const conversationTypeEnum = pgEnum(
	"conversation_type",
	INBOX_CONVERSATION_TYPES,
);

export const conversationStatusEnum = pgEnum("conversation_status", [
	"open",
	"archived",
	"snoozed",
]);

export const inboxConversations = pgTable(
	"inbox_conversations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("conv_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		accountId: text("account_id").notNull(),
		platform: platformEnum("platform").notNull(),
		type: conversationTypeEnum("type").notNull(),
		platformConversationId: text("platform_conversation_id").notNull(),
		// Context
		postId: text("post_id"),
		postPlatformId: text("post_platform_id"),
		// Participant
		participantName: text("participant_name"),
		participantPlatformId: text("participant_platform_id"),
		participantAvatar: text("participant_avatar"),
		participantAvatarObjectKey: text("participant_avatar_object_key"),
		participantMetadata: jsonb("participant_metadata").default({}),
		// State
		status: conversationStatusEnum("status").notNull().default("open"),
		priority: text("priority").default("normal"),
		labels: text("labels").array().default([]),
		unreadCount: integer("unread_count").notNull().default(0),
		messageCount: integer("message_count").notNull().default(0),
		// Preview
		lastMessageText: text("last_message_text"),
		lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
		lastMessageDirection: text("last_message_direction", {
			enum: [...INBOX_DIRECTIONS],
		}),
		// AI enrichment
		sentimentAvg: integer("sentiment_avg"),
		// Contact link
		contactId: text("contact_id").references(() => contacts.id, {
			onDelete: "set null",
		}),
		// Stable HMAC over organization + internal contact ID. The retained
		// identity-key fingerprint detects accidental replacement of the key ring
		// that makes a post-FK-null subject undiscoverable.
		contactSubjectLocator: text("contact_subject_locator"),
		contactSubjectIdentityKeyFingerprint: text(
			"contact_subject_identity_key_fingerprint",
		),
		assignedUserId: text("assigned_user_id").references(() => user.id, {
			onDelete: "set null",
		}),
		closedAt: timestamp("closed_at", { withTimezone: true }),
		contentExpiresAt: timestamp("content_expires_at", { withTimezone: true }),
		contentRedactedAt: timestamp("content_redacted_at", {
			withTimezone: true,
		}),
		// Timestamps
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("inbox_conversations_id_org_uniq").on(
			table.id,
			table.organizationId,
		),
		unique("inbox_conversations_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "inbox_conversations_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.accountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
				socialAccounts.platform,
			],
			name: "inbox_conversations_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.contactId, table.organizationId, table.scopeKey],
			foreignColumns: [contacts.id, contacts.organizationId, contacts.scopeKey],
			name: "inbox_conversations_contact_org_scope_fk",
		}),
		check(
			"inbox_conversations_counts_nonnegative_check",
			sql`${table.unreadCount} >= 0 AND ${table.messageCount} >= 0`,
		),
		check(
			"inbox_conversations_sentiment_range_check",
			sql`${table.sentimentAvg} IS NULL OR ${table.sentimentAvg} BETWEEN -100 AND 100`,
		),
		check(
			"inbox_conversations_last_message_direction_check",
			sql`${table.lastMessageDirection} IS NULL OR ${table.lastMessageDirection} IN ('inbound', 'outbound')`,
		),
		check(
			"inbox_conversations_contact_subject_locator_check",
			sql`(${table.contactSubjectLocator} IS NULL
					AND ${table.contactSubjectIdentityKeyFingerprint} IS NULL)
				OR (${table.contactSubjectLocator} ~ '^[0-9a-f]{64}$'
					AND ${table.contactSubjectIdentityKeyFingerprint} ~ '^[0-9a-f]{64}$')`,
		),
		check(
			"inbox_conversations_avatar_object_key_check",
			sql`${table.participantAvatarObjectKey} IS NULL
				OR (
					length(${table.participantAvatarObjectKey}) BETWEEN 1 AND 1024
					AND ${table.participantAvatarObjectKey} !~ '(^/|//|(^|/)\\.\\.?(/|$)|[[:cntrl:]])'
					AND ${table.participantAvatarObjectKey} !~ '/$'
					AND ${table.participantAvatarObjectKey} !~ '^(account|user|organization|queue-rescue)/'
				)`,
		),
		check(
			"inbox_conversations_close_retention_check",
			sql`(${table.status} = 'archived'
					AND ${table.closedAt} IS NOT NULL
					AND ${table.contentExpiresAt} IS NOT NULL
					AND ${table.contentExpiresAt} >= ${table.closedAt})
				OR (${table.status} <> 'archived'
					AND ${table.closedAt} IS NULL
					AND ${table.contentExpiresAt} IS NULL)`,
		),
		check(
			"inbox_conversations_retention_timestamp_check",
			sql`(${table.contentRedactedAt} IS NULL
					OR ${table.contentRedactedAt} >= ${table.createdAt})
				AND (${table.closedAt} IS NULL OR ${table.closedAt} >= ${table.createdAt})`,
		),
		index("inbox_conv_workspace_idx").on(table.workspaceId),
		index("inbox_conv_org_status_idx").on(table.organizationId, table.status),
		index("inbox_conv_org_updated_idx").on(
			table.organizationId,
			table.updatedAt,
			table.id,
		),
		index("inbox_conv_account_idx").on(table.accountId),
		index("inbox_conv_org_platform_idx").on(
			table.organizationId,
			table.platform,
		),
		uniqueIndex("inbox_conv_account_platform_id_idx").on(
			table.accountId,
			table.platformConversationId,
		),
		index("inbox_conv_org_workspace_idx").on(
			table.organizationId,
			table.workspaceId,
		),
		index("inbox_conv_contact_idx").on(table.contactId),
		index("inbox_conv_contact_subject_idx").on(
			table.organizationId,
			table.contactSubjectLocator,
		),
		index("inbox_conv_assigned_user_idx").on(table.assignedUserId),
		// Match the exact COALESCE + id ordering used by the bounded stale-close
		// claim; an index on last_message_at alone cannot serve rows with no
		// messages or the deterministic keyset order.
		index("inbox_conv_open_activity_idx")
			.on(sql`COALESCE(${table.lastMessageAt}, ${table.createdAt})`, table.id)
			.where(sql`${table.status} = 'open'`),
		index("inbox_conv_content_retention_due_idx")
			.on(table.contentExpiresAt, table.id)
			.where(
				sql`${table.status} = 'archived' AND ${table.contentRedactedAt} IS NULL`,
			),
	],
);

export const inboxMessages = pgTable(
	"inbox_messages",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("msg_")),
		conversationId: text("conversation_id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		accountId: text("account_id").notNull().default(""),
		platform: platformEnum("platform").notNull().default("twitter"),
		platformMessageId: text("platform_message_id").notNull(),
		// Content
		authorName: text("author_name"),
		authorPlatformId: text("author_platform_id"),
		authorAvatarUrl: text("author_avatar_url"),
		text: text("text"),
		direction: text("direction", { enum: [...INBOX_DIRECTIONS] }).notNull(),
		attachments: jsonb("attachments").default([]),
		// AI enrichment
		sentimentScore: integer("sentiment_score"),
		classification: text("classification"),
		// Platform-specific
		platformData: jsonb("platform_data").default({}),
		isHidden: boolean("is_hidden").default(false),
		isLiked: boolean("is_liked").default(false),
		editRevision: integer("edit_revision").notNull().default(0),
		editedAt: timestamp("edited_at", { withTimezone: true }),
		providerReadAt: timestamp("provider_read_at", { withTimezone: true }),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
		contentRedactedAt: timestamp("content_redacted_at", {
			withTimezone: true,
		}),
		// Timestamps
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"inbox_messages_direction_check",
			sql`${table.direction} IN ('inbound', 'outbound')`,
		),
		foreignKey({
			columns: [table.conversationId, table.organizationId, table.scopeKey],
			foreignColumns: [
				inboxConversations.id,
				inboxConversations.organizationId,
				inboxConversations.scopeKey,
			],
			name: "inbox_messages_conversation_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [
				table.accountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
				socialAccounts.platform,
			],
			name: "inbox_messages_account_org_scope_platform_fk",
		}),
		check(
			"inbox_messages_sentiment_range_check",
			sql`${table.sentimentScore} IS NULL OR ${table.sentimentScore} BETWEEN -100 AND 100`,
		),
		check(
			"inbox_messages_content_redaction_check",
			sql`${table.contentRedactedAt} IS NULL
				OR ${table.contentRedactedAt} >= ${table.createdAt}`,
		),
		check(
			"inbox_messages_edit_state_check",
			sql`${table.editRevision} >= 0
				AND (${table.editedAt} IS NULL OR (${table.editRevision} > 0 AND ${table.editedAt} >= ${table.createdAt}))
				AND (${table.providerReadAt} IS NULL OR ${table.providerReadAt} >= ${table.createdAt})
				AND (${table.deletedAt} IS NULL OR ${table.deletedAt} >= ${table.createdAt})
				AND ${table.updatedAt} >= ${table.createdAt}`,
		),
		index("inbox_msg_conv_created_idx").on(
			table.conversationId,
			table.createdAt,
		),
		index("inbox_msg_org_created_idx").on(
			table.organizationId,
			table.createdAt,
			table.id,
		),
		uniqueIndex("inbox_msg_account_platform_dedup_idx").on(
			table.platform,
			table.accountId,
			table.platformMessageId,
		),
		index("inbox_msg_platform_message_id_idx").on(table.platformMessageId),
		index("inbox_msg_content_retention_pending_idx")
			.on(table.conversationId, table.id)
			.where(sql`${table.contentRedactedAt} IS NULL`),
		// Backs the leading-wildcard ILIKE in inbox message search. Requires the
		// pg_trgm extension (enabled in the generated migration).
		index("inbox_msg_text_trgm_idx").using(
			"gin",
			sql`${table.text} gin_trgm_ops`,
		),
	],
);

/** Durable provider boundary for published edits and social/WhatsApp actions. */
export const socialMutationOperations = pgTable(
	"social_mutation_operations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("smut_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		accountId: text("account_id").notNull(),
		platform: platformEnum("platform").notNull(),
		targetType: text("target_type", {
			enum: [...SOCIAL_MUTATION_TARGET_TYPES],
		}).notNull(),
		targetId: text("target_id").notNull(),
		kind: text("kind", {
			enum: [...SOCIAL_MUTATION_KINDS],
		}).notNull(),
		operationKeyHash: varchar("operation_key_hash", { length: 64 }).notNull(),
		requestHash: varchar("request_hash", { length: 64 }).notNull(),
		requestPayload: jsonb("request_payload")
			.$type<Record<string, unknown>>()
			.notNull(),
		status: text("status", {
			enum: [
				"pending",
				"processing",
				"request_may_have_been_sent",
				"unknown",
				"completed",
				"failed",
			],
		})
			.notNull()
			.default("pending"),
		phase: text("phase", {
			enum: ["provider", "projection", "completed"],
		})
			.notNull()
			.default("provider"),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		providerConfirmedAt: timestamp("provider_confirmed_at", {
			withTimezone: true,
		}),
		providerOperationId: text("provider_operation_id"),
		providerResult: jsonb("provider_result").$type<Record<string, unknown>>(),
		attempts: integer("attempts").notNull().default(0),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "social_mutation_operations_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.accountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
				socialAccounts.platform,
			],
			name: "social_mutation_operations_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		uniqueIndex("social_mutation_operations_org_key_uniq").on(
			table.organizationId,
			table.targetType,
			table.targetId,
			table.operationKeyHash,
		),
		uniqueIndex("social_mutation_operations_target_active_uniq")
			.on(table.organizationId, table.targetType, table.targetId)
			.where(
				sql`${table.status} IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown')`,
			),
		index("social_mutation_operations_due_idx").on(
			table.status,
			table.leaseExpiresAt,
			table.updatedAt,
		),
		check(
			"social_mutation_operations_target_check",
			sql`${table.targetType} IN (${sql.join(
				SOCIAL_MUTATION_TARGET_TYPES.map((value) => ddlTextLiteral(value)),
				sql`, `,
			)})`,
		),
		check(
			"social_mutation_operations_kind_check",
			sql`${table.kind} IN (${sql.join(
				SOCIAL_MUTATION_KINDS.map((value) => ddlTextLiteral(value)),
				sql`, `,
			)})`,
		),
		check(
			"social_mutation_operations_status_check",
			sql`${table.status} IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'completed', 'failed')`,
		),
		check(
			"social_mutation_operations_phase_check",
			sql`${table.phase} IN ('provider', 'projection', 'completed')`,
		),
		check(
			"social_mutation_operations_counter_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"social_mutation_operations_lease_check",
			sql`(${table.status} IN ('processing', 'request_may_have_been_sent') AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} NOT IN ('processing', 'request_may_have_been_sent') AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"social_mutation_operations_boundary_check",
			sql`${table.status} <> 'request_may_have_been_sent' OR ${table.requestMayHaveBeenSentAt} IS NOT NULL`,
		),
		check(
			"social_mutation_operations_completion_check",
			sql`(${table.status} = 'completed'
					AND ${table.phase} = 'completed'
					AND ${table.providerConfirmedAt} IS NOT NULL
					AND ${table.completedAt} IS NOT NULL)
				OR (${table.status} <> 'completed'
					AND ${table.phase} <> 'completed'
					AND ${table.completedAt} IS NULL)`,
		),
	],
);

/**
 * Account-scoped WhatsApp Group projection. Provider group IDs are never
 * accepted directly by mutation routes without resolving this exact tenant,
 * workspace, account, and platform tuple first.
 */
export const whatsappGroups = pgTable(
	"whatsapp_groups",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("wg_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		accountId: text("account_id").notNull(),
		platform: platformEnum("platform").notNull().default("whatsapp"),
		providerGroupId: text("provider_group_id"),
		subject: text("subject").notNull(),
		description: text("description"),
		joinApprovalMode: text("join_approval_mode", {
			enum: ["approval_required", "auto_approve"],
		}),
		lifecycleStatus: text("lifecycle_status", {
			enum: [
				"creating",
				"active",
				"suspended",
				"deleting",
				"deleted",
				"failed",
			],
		})
			.notNull()
			.default("creating"),
		providerRequestId: text("provider_request_id"),
		// Group invite links grant join access and are encrypted at rest.
		inviteLinkCiphertext: text("invite_link_ciphertext"),
		participantCount: integer("participant_count"),
		providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }),
		lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "whatsapp_groups_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.accountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
				socialAccounts.platform,
			],
			name: "whatsapp_groups_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		uniqueIndex("whatsapp_groups_account_provider_uniq")
			.on(table.accountId, table.providerGroupId)
			.where(sql`${table.providerGroupId} IS NOT NULL`),
		index("whatsapp_groups_org_status_idx").on(
			table.organizationId,
			table.lifecycleStatus,
			table.id,
		),
		index("whatsapp_groups_provider_request_idx")
			.on(table.accountId, table.providerRequestId)
			.where(sql`${table.providerRequestId} IS NOT NULL`),
		check(
			"whatsapp_groups_platform_check",
			sql`${table.platform} = 'whatsapp'`,
		),
		check(
			"whatsapp_groups_status_check",
			sql`${table.lifecycleStatus} IN ('creating', 'active', 'suspended', 'deleting', 'deleted', 'failed')`,
		),
		check(
			"whatsapp_groups_join_approval_check",
			sql`${table.joinApprovalMode} IS NULL OR ${table.joinApprovalMode} IN ('approval_required', 'auto_approve')`,
		),
		check(
			"whatsapp_groups_participant_count_check",
			sql`${table.participantCount} IS NULL OR ${table.participantCount} BETWEEN 0 AND 8`,
		),
		check(
			"whatsapp_groups_provider_identity_check",
			sql`${table.lifecycleStatus} IN ('creating', 'failed')
				OR ${table.providerGroupId} IS NOT NULL`,
		),
		check(
			"whatsapp_groups_timestamp_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND (${table.lastSyncedAt} IS NULL OR ${table.lastSyncedAt} >= ${table.createdAt})`,
		),
	],
);

/** Encrypted aliases needed for WhatsApp's phone-optional BSUID transition. */
export const whatsappIdentityAliases = pgTable(
	"whatsapp_identity_aliases",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("wai_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		accountId: text("account_id").notNull(),
		platform: platformEnum("platform").notNull().default("whatsapp"),
		conversationId: text("conversation_id"),
		bsuidHash: varchar("bsuid_hash", { length: 64 }).notNull(),
		bsuidCiphertext: text("bsuid_ciphertext").notNull(),
		parentBsuidHash: varchar("parent_bsuid_hash", { length: 64 }),
		parentBsuidCiphertext: text("parent_bsuid_ciphertext"),
		waIdHash: varchar("wa_id_hash", { length: 64 }),
		waIdCiphertext: text("wa_id_ciphertext"),
		usernameCiphertext: text("username_ciphertext"),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "whatsapp_identity_aliases_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.accountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
				socialAccounts.platform,
			],
			name: "whatsapp_identity_aliases_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.conversationId, table.organizationId, table.scopeKey],
			foreignColumns: [
				inboxConversations.id,
				inboxConversations.organizationId,
				inboxConversations.scopeKey,
			],
			name: "whatsapp_identity_aliases_conversation_org_scope_fk",
		}).onDelete("cascade"),
		uniqueIndex("whatsapp_identity_aliases_account_bsuid_uniq").on(
			table.accountId,
			table.bsuidHash,
		),
		index("whatsapp_identity_aliases_wa_id_idx").on(
			table.accountId,
			table.waIdHash,
		),
		check(
			"whatsapp_identity_aliases_hash_check",
			sql`${table.platform} = 'whatsapp'
				AND ${table.bsuidHash} ~ '^[0-9a-f]{64}$'
				AND (${table.parentBsuidHash} IS NULL OR ${table.parentBsuidHash} ~ '^[0-9a-f]{64}$')
				AND (${table.waIdHash} IS NULL OR ${table.waIdHash} ~ '^[0-9a-f]{64}$')`,
		),
		check(
			"whatsapp_identity_aliases_ciphertext_check",
			sql`${table.bsuidCiphertext} LIKE 'enc:v2:%'
				AND (${table.parentBsuidCiphertext} IS NULL OR ${table.parentBsuidCiphertext} LIKE 'enc:v2:%')
				AND (${table.waIdCiphertext} IS NULL OR ${table.waIdCiphertext} LIKE 'enc:v2:%')
				AND (${table.usernameCiphertext} IS NULL OR ${table.usernameCiphertext} LIKE 'enc:v2:%')`,
		),
		check(
			"whatsapp_identity_aliases_pair_check",
			sql`(${table.parentBsuidHash} IS NULL) = (${table.parentBsuidCiphertext} IS NULL)
				AND (${table.waIdHash} IS NULL) = (${table.waIdCiphertext} IS NULL)`,
		),
	],
);

export const inboundWebhookEvents = pgTable(
	"inbound_webhook_events",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("iwe_")),
		provider: text("provider").notNull(),
		deliveryKey: text("delivery_key").notNull(),
		payloadCiphertext: text("payload_ciphertext").notNull(),
		payloadKeyId: text("payload_key_id").notNull(),
		contentType: text("content_type"),
		signatureMetadata: jsonb("signature_metadata"),
		// Filled by the queue-side dispatcher as it emits normalized tenant work.
		// Some provider deliveries legitimately fan out to multiple organizations.
		organizationIds: text("organization_ids")
			.array()
			.notNull()
			.default(sql`ARRAY[]::text[]`),
		status: text("status", {
			enum: [
				"received",
				"queued",
				"processing",
				"completed",
				"failed",
				"exhausted",
			],
		})
			.notNull()
			.default("received"),
		attempts: integer("attempts").notNull().default(0),
		receivedAt: timestamp("received_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		processedAt: timestamp("processed_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		manualReviewUntil: timestamp("manual_review_until", {
			withTimezone: true,
		}),
		redactedAt: timestamp("redacted_at", { withTimezone: true }),
		lastError: text("last_error"),
	},
	(table) => [
		uniqueIndex("inbound_webhook_events_delivery_idx").on(
			table.provider,
			table.deliveryKey,
		),
		index("inbound_webhook_events_status_idx").on(
			table.status,
			table.receivedAt,
		),
		index("inbound_webhook_events_reconcile_idx").on(
			table.status,
			table.claimedAt,
			table.attempts,
			table.receivedAt,
		),
		check(
			"inbound_webhook_events_status_check",
			sql`${table.status} IN ('received', 'queued', 'processing', 'completed', 'failed', 'exhausted')`,
		),
		check(
			"inbound_webhook_events_attempts_nonnegative_check",
			sql`${table.attempts} >= 0`,
		),
		check(
			"inbound_webhook_events_retention_check",
			sql`${table.expiresAt} > ${table.receivedAt} AND (${table.manualReviewUntil} IS NULL OR ${table.manualReviewUntil} <= ${table.receivedAt} + interval '90 days')`,
		),
		check(
			"inbound_webhook_events_processing_check",
			sql`${table.status} <> 'processing' OR ${table.claimedAt} IS NOT NULL`,
		),
		check(
			"inbound_webhook_events_completion_check",
			sql`(${table.status} = 'completed'
					AND ${table.claimedAt} IS NOT NULL
					AND ${table.processedAt} IS NOT NULL)
				OR (${table.status} <> 'completed' AND ${table.processedAt} IS NULL)`,
		),
		check(
			"inbound_webhook_events_timestamp_order_check",
			sql`(${table.claimedAt} IS NULL OR ${table.claimedAt} >= ${table.receivedAt})
				AND (${table.processedAt} IS NULL OR ${table.processedAt} >= ${table.claimedAt})
				AND (${table.redactedAt} IS NULL OR ${table.redactedAt} >= ${table.receivedAt})`,
		),
		index("inbound_webhook_events_expiry_idx").on(table.expiresAt, table.id),
		index("inbound_webhook_events_receipt_retention_idx")
			.on(table.receivedAt, table.id)
			.where(sql`${table.redactedAt} IS NOT NULL`),
	],
);

export const inboxEventEffects = pgTable(
	"inbox_event_effects",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ief_")),
		organizationId: text("organization_id").notNull(),
		accountId: text("account_id").notNull(),
		platformEventId: text("platform_event_id").notNull(),
		effect: text("effect", {
			enum: ["automation", "customer_webhook", "realtime"],
		}).notNull(),
		status: text("status", {
			enum: ["pending", "in_flight", "unknown", "completed"],
		})
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		startedAt: timestamp("started_at", { withTimezone: true }),
		// Set immediately before invoking the effect. An expired lease with this
		// still NULL is safe to retry; a non-NULL value requires reconciliation.
		effectStartedAt: timestamp("effect_started_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		error: text("error"),
		replayPayload: jsonb("replay_payload"),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.accountId, table.organizationId],
			foreignColumns: [socialAccounts.id, socialAccounts.organizationId],
			name: "inbox_event_effects_account_org_fk",
		}).onDelete("cascade"),
		uniqueIndex("inbox_event_effects_dedup_idx").on(
			table.organizationId,
			table.accountId,
			table.platformEventId,
			table.effect,
		),
		check(
			"inbox_event_effects_effect_check",
			sql`${table.effect} IN ('automation', 'customer_webhook', 'realtime')`,
		),
		check(
			"inbox_event_effects_status_check",
			sql`${table.status} IN ('pending', 'in_flight', 'unknown', 'completed')`,
		),
		check(
			"inbox_event_effects_counters_nonnegative_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"inbox_event_effects_lease_state_check",
			sql`(${table.status} = 'in_flight'
					AND ${table.leaseExpiresAt} IS NOT NULL
					AND ${table.startedAt} IS NOT NULL
					AND ${table.completedAt} IS NULL)
				OR (${table.status} <> 'in_flight' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"inbox_event_effects_completion_check",
			sql`${table.status} <> 'completed' OR ${table.completedAt} IS NOT NULL`,
		),
		check(
			"inbox_event_effects_timestamp_order_check",
			sql`(${table.effectStartedAt} IS NULL OR (${table.startedAt} IS NOT NULL AND ${table.effectStartedAt} >= ${table.startedAt}))
				AND (${table.completedAt} IS NULL OR (${table.startedAt} IS NOT NULL AND ${table.completedAt} >= ${table.startedAt}))`,
		),
		index("inbox_event_effects_status_idx").on(
			table.status,
			table.nextAttemptAt,
		),
		index("inbox_event_effects_lease_idx").on(
			table.status,
			table.leaseExpiresAt,
		),
		index("inbox_event_effects_retention_idx")
			.on(sql`COALESCE(${table.completedAt}, ${table.updatedAt})`, table.id)
			.where(sql`${table.status} IN ('completed', 'unknown')`),
	],
);

export const inboxConversationNotes = pgTable(
	"inbox_conversation_notes",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("note_")),
		conversationId: text("conversation_id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		actorType: text("actor_type", {
			enum: [...INBOX_NOTE_ACTOR_TYPES],
		}).notNull(),
		actorId: text("actor_id").notNull(),
		userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
		text: text("text").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.conversationId, table.organizationId],
			foreignColumns: [
				inboxConversations.id,
				inboxConversations.organizationId,
			],
			name: "inbox_conversation_notes_conversation_org_fk",
		}).onDelete("cascade"),
		index("inbox_note_conv_created_idx").on(
			table.conversationId,
			table.createdAt,
		),
		index("inbox_note_org_idx").on(table.organizationId),
		index("inbox_note_user_idx").on(table.userId),
		index("inbox_note_actor_idx").on(table.actorType, table.actorId),
		check(
			"inbox_note_actor_type_check",
			sql`${table.actorType} IN ('dashboard_user', 'service')`,
		),
		check(
			"inbox_note_actor_user_check",
			sql`(${table.actorType} = 'service' AND ${table.userId} IS NULL) OR (${table.actorType} = 'dashboard_user' AND (${table.userId} IS NULL OR ${table.actorId} = ${table.userId}))`,
		),
	],
);

// ---------------------------------------------------------------------------
// Auto-Post Rules (RSS / Feed auto-posting)
// ---------------------------------------------------------------------------

export const autoPostRules = pgTable(
	"auto_post_rules",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("apr_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),

		// Configuration
		name: text("name").notNull(),
		feedUrl: text("feed_url").notNull(),
		pollingIntervalMinutes: integer("polling_interval_minutes")
			.notNull()
			.default(60),

		// Content options
		contentTemplate: text("content_template"), // supports {{title}}, {{url}}, {{description}}, {{published_date}}
		appendFeedUrl: boolean("append_feed_url").notNull().default(true),

		// Targeting
		accountIds: jsonb("account_ids").$type<string[]>().notNull().default([]),

		// State
		status: text("status", {
			enum: ["active", "paused", "error"],
		})
			.notNull()
			.default("paused"),
		lastProcessedUrl: text("last_processed_url"),
		lastProcessedAt: timestamp("last_processed_at", { withTimezone: true }),
		lastError: text("last_error"),
		consecutiveErrors: integer("consecutive_errors").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),

		// Timestamps
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("auto_post_rules_id_org_uniq").on(table.id, table.organizationId),
		unique("auto_post_rules_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "auto_post_rules_workspace_org_fk",
		}),
		check(
			"auto_post_rules_status_check",
			sql`${table.status} IN ('active', 'paused', 'error')`,
		),
		check(
			"auto_post_rules_numeric_check",
			sql`${table.pollingIntervalMinutes} > 0
				AND ${table.consecutiveErrors} >= 0
				AND ${table.leaseToken} >= 0`,
		),
		check(
			"auto_post_rules_lease_state_check",
			sql`${table.leaseExpiresAt} IS NULL OR ${table.status} = 'active'`,
		),
		check(
			"auto_post_rules_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}`,
		),
		index("auto_post_rules_org_status_idx").on(
			table.organizationId,
			table.status,
		),
		index("auto_post_rules_workspace_idx").on(table.workspaceId),
	],
);

export const autoPostFeedItems = pgTable(
	"auto_post_feed_items",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("afi_")),
		operationId: text("operation_id").notNull(),
		ruleId: text("rule_id").notNull(),
		organizationId: text("organization_id").notNull(),
		canonicalFeedItemId: text("canonical_feed_item_id").notNull(),
		sourceItemId: text("source_item_id"),
		canonicalUrl: text("canonical_url"),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		status: text("status", {
			enum: [
				"ignored",
				"processing",
				"committed",
				"transient_failure",
				"terminal_failure",
				"unknown",
			],
		}).notNull(),
		postId: text("post_id").references(() => posts.id, {
			onDelete: "set null",
		}),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.ruleId, table.organizationId],
			foreignColumns: [autoPostRules.id, autoPostRules.organizationId],
			name: "auto_post_feed_items_rule_org_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.postId, table.organizationId],
			foreignColumns: [posts.id, posts.organizationId],
			name: "auto_post_feed_items_post_org_fk",
		}),
		uniqueIndex("auto_post_feed_items_rule_canonical_idx").on(
			table.ruleId,
			table.canonicalFeedItemId,
		),
		check(
			"auto_post_feed_items_status_check",
			sql`${table.status} IN ('ignored', 'processing', 'committed', 'transient_failure', 'terminal_failure', 'unknown')`,
		),
		check(
			"auto_post_feed_items_completion_check",
			sql`(${table.status} = 'processing' AND ${table.completedAt} IS NULL)
				OR (${table.status} <> 'processing' AND ${table.completedAt} IS NOT NULL)`,
		),
		check(
			"auto_post_feed_items_committed_post_check",
			sql`${table.status} <> 'committed' OR ${table.postId} IS NOT NULL`,
		),
		check(
			"auto_post_feed_items_timestamp_order_check",
			sql`${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt}`,
		),
		index("auto_post_feed_items_post_idx").on(table.postId),
		index("auto_post_feed_items_retention_idx")
			.on(sql`COALESCE(${table.completedAt}, ${table.createdAt})`, table.id)
			.where(sql`${table.status} <> 'processing'`),
	],
);

export const whatsappPhoneNumbers = pgTable(
	"whatsapp_phone_numbers",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("wpn_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		socialAccountId: text("social_account_id").references(
			() => socialAccounts.id,
			{ onDelete: "set null" },
		),
		phoneNumber: text("phone_number").notNull(),
		provider: text("provider").notNull().default("telnyx"),
		providerNumberId: text("provider_number_id"),
		telnyxOrderId: text("telnyx_order_id"),
		waPhoneNumberId: text("wa_phone_number_id"),
		status: text("status").notNull().default("purchasing"),
		verificationMethod: text("verification_method"),
		stripePhoneSubscriptionId: text("stripe_phone_subscription_id"),
		stripeSubscriptionItemId: text("stripe_subscription_item_id"),
		monthlyCostCents: integer("monthly_cost_cents").notNull().default(200),
		country: text("country").notNull().default("US"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("wa_phone_numbers_id_org_uniq").on(table.id, table.organizationId),
		uniqueIndex("wa_phone_numbers_telnyx_order_uniq").on(table.telnyxOrderId),
		uniqueIndex("wa_phone_numbers_provider_number_uniq").on(
			table.providerNumberId,
		),
		uniqueIndex("wa_phone_numbers_meta_number_uniq").on(table.waPhoneNumberId),
		check(
			"wa_phone_numbers_status_check",
			sql`${table.status} IN ('purchasing', 'pending_verification', 'verified', 'active', 'releasing', 'released')`,
		),
		check(
			"wa_phone_numbers_numeric_check",
			sql`${table.monthlyCostCents} >= 0`,
		),
		check(
			"wa_phone_numbers_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}`,
		),
		index("wa_phone_numbers_org_idx").on(table.organizationId),
		index("wa_phone_numbers_status_idx").on(table.status),
	],
);

/**
 * Organization-scoped serialization authority for the dedicated phone add-on
 * subscription. Every quantity mutation converges this single desired/applied
 * pair, preventing concurrent absolute Stripe updates from regressing quantity.
 */
export const whatsappPhoneBillingOperations = pgTable(
	"whatsapp_phone_billing_operations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("wpb_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" })
			.unique(),
		state: text("state", {
			enum: [
				"pending",
				"processing",
				"request_may_have_been_sent",
				"unknown",
				"waiting_payment",
				"applied",
				"manual_review",
			],
		})
			.notNull()
			.default("pending"),
		desiredQuantity: integer("desired_quantity").notNull(),
		appliedQuantity: integer("applied_quantity").notNull().default(0),
		stripeCustomerId: text("stripe_customer_id"),
		stripeCheckoutSessionId: text("stripe_checkout_session_id"),
		stripeSubscriptionId: text("stripe_subscription_id"),
		stripeSubscriptionItemId: text("stripe_subscription_item_id"),
		stripeLatestInvoiceId: text("stripe_latest_invoice_id"),
		idempotencyKey: text("idempotency_key").notNull().unique(),
		revision: integer("revision").notNull().default(1),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		lastError: text("last_error"),
		appliedAt: timestamp("applied_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("wa_phone_billing_id_org_uniq").on(table.id, table.organizationId),
		check(
			"wa_phone_billing_status_check",
			sql`${table.state} IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'waiting_payment', 'applied', 'manual_review')`,
		),
		check(
			"wa_phone_billing_numeric_check",
			sql`${table.desiredQuantity} >= 0
				AND ${table.appliedQuantity} >= 0
				AND ${table.revision} > 0
				AND ${table.leaseToken} >= 0
				AND ${table.attempts} >= 0`,
		),
		check(
			"wa_phone_billing_lease_check",
			sql`(${table.state} IN ('processing', 'request_may_have_been_sent')
					AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.state} NOT IN ('processing', 'request_may_have_been_sent')
					AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"wa_phone_billing_boundary_check",
			sql`${table.state} <> 'request_may_have_been_sent'
				OR ${table.requestMayHaveBeenSentAt} IS NOT NULL`,
		),
		check(
			"wa_phone_billing_applied_check",
			sql`(${table.state} = 'applied'
					AND ${table.desiredQuantity} = ${table.appliedQuantity}
					AND ${table.appliedAt} IS NOT NULL)
				OR (${table.state} <> 'applied' AND ${table.appliedAt} IS NULL)`,
		),
		check(
			"wa_phone_billing_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND (${table.requestMayHaveBeenSentAt} IS NULL OR ${table.requestMayHaveBeenSentAt} >= ${table.createdAt})
				AND (${table.appliedAt} IS NULL OR ${table.appliedAt} >= ${table.createdAt})`,
		),
		index("wa_phone_billing_status_due_idx").on(
			table.state,
			table.nextAttemptAt,
			table.organizationId,
		),
		index("wa_phone_billing_lease_idx")
			.on(table.leaseExpiresAt, table.organizationId)
			.where(
				sql`${table.state} IN ('processing', 'request_may_have_been_sent')`,
			),
	],
);

/**
 * Revisioned economic evidence for the organization phone add-on authority.
 * Quantity, customer, and idempotency identity are inserted once per revision;
 * only the provider-observation state advances. A new external payload always
 * receives a new row and idempotency key after the prior revision is proven
 * not applied.
 */
export const whatsappPhoneBillingAttempts = pgTable(
	"whatsapp_phone_billing_attempts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("wpba_")),
		organizationId: text("organization_id").notNull(),
		phoneBillingOperationId: text("phone_billing_operation_id").notNull(),
		revision: integer("revision").notNull(),
		status: text("status", {
			enum: [
				"prepared",
				"requesting",
				"unknown",
				"waiting_payment",
				"applied",
				"confirmed_not_applied",
				"manual_review",
			],
		})
			.notNull()
			.default("prepared"),
		desiredQuantity: integer("desired_quantity").notNull(),
		priorAppliedQuantity: integer("prior_applied_quantity").notNull(),
		stripeCustomerId: text("stripe_customer_id").notNull(),
		stripeCheckoutSessionId: text("stripe_checkout_session_id"),
		stripeSubscriptionId: text("stripe_subscription_id"),
		stripeSubscriptionItemId: text("stripe_subscription_item_id"),
		stripeLatestInvoiceId: text("stripe_latest_invoice_id"),
		idempotencyKey: text("idempotency_key").notNull().unique(),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		providerEvidence:
			jsonb("provider_evidence").$type<Record<string, unknown>>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.phoneBillingOperationId, table.organizationId],
			foreignColumns: [
				whatsappPhoneBillingOperations.id,
				whatsappPhoneBillingOperations.organizationId,
			],
			name: "wa_phone_billing_attempts_operation_org_fk",
		}).onDelete("cascade"),
		uniqueIndex("wa_phone_billing_attempts_operation_revision_uniq").on(
			table.phoneBillingOperationId,
			table.revision,
		),
		check(
			"wa_phone_billing_attempts_status_check",
			sql`${table.status} IN ('prepared', 'requesting', 'unknown', 'waiting_payment', 'applied', 'confirmed_not_applied', 'manual_review')`,
		),
		check(
			"wa_phone_billing_attempts_numeric_check",
			sql`${table.revision} > 0
				AND ${table.desiredQuantity} >= 0
				AND ${table.priorAppliedQuantity} >= 0`,
		),
		check(
			"wa_phone_billing_attempts_state_shape_check",
			sql`(${table.status} = 'prepared'
					AND ${table.requestMayHaveBeenSentAt} IS NULL
					AND ${table.providerEvidence} IS NULL
					AND ${table.resolvedAt} IS NULL)
				OR (${table.status} IN ('requesting', 'unknown')
					AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
					AND ${table.resolvedAt} IS NULL)
				OR (${table.status} = 'waiting_payment'
					AND ${table.providerEvidence} IS NOT NULL
					AND ${table.resolvedAt} IS NULL)
				OR (${table.status} IN ('applied', 'confirmed_not_applied')
					AND ${table.providerEvidence} IS NOT NULL
					AND ${table.resolvedAt} IS NOT NULL)
				OR (${table.status} = 'manual_review'
					AND ${table.providerEvidence} IS NOT NULL
					AND ${table.resolvedAt} IS NULL)`,
		),
		check(
			"wa_phone_billing_attempts_timestamp_check",
			sql`(${table.requestMayHaveBeenSentAt} IS NULL OR ${table.requestMayHaveBeenSentAt} >= ${table.createdAt})
				AND (${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.createdAt})`,
		),
		index("wa_phone_billing_attempts_operation_status_idx").on(
			table.phoneBillingOperationId,
			table.status,
		),
		index("wa_phone_billing_attempts_retention_idx").on(
			table.createdAt,
			table.id,
		),
	],
);

/**
 * One durable, idempotent purchase operation per phone resource. Provider
 * results live on the phone; claim/retry/request data lives only on this row.
 */
export const whatsappPhoneProvisioningOperations = pgTable(
	"whatsapp_phone_provisioning_operations",
	{
		provisioningOperationId: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("wpo_")),
		phoneNumberId: text("phone_number_id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		provisioningUsageReservationId: text("usage_reservation_id"),
		provisioningOperationKeyHash: varchar("idempotency_key_hash", {
			length: 64,
		}).notNull(),
		provisioningRequestHash: varchar("request_hash", {
			length: 64,
		}).notNull(),
		provisioningSourceAccountId: text("source_account_id").notNull(),
		provisioningSourceWabaId: text("source_waba_id").notNull(),
		provisioningVerifiedName: text("verified_name"),
		provisioningState: text("status", {
			enum: [
				"pending",
				"processing",
				"waiting_external",
				"request_may_have_been_sent",
				"unknown",
				"manual_review",
				"completed",
				"failed",
				"cancelled",
			],
		})
			.notNull()
			.default("pending"),
		provisioningPhase: text("phase", {
			enum: [
				"selected",
				"telnyx_order",
				"billing",
				"meta_registration",
				"completed",
			],
		})
			.notNull()
			.default("selected"),
		provisioningLeaseToken: integer("lease_token").notNull().default(0),
		provisioningLeaseExpiresAt: timestamp("lease_expires_at", {
			withTimezone: true,
		}),
		provisioningRequestMayHaveBeenSentAt: timestamp(
			"request_may_have_been_sent_at",
			{ withTimezone: true },
		),
		provisioningAttempts: integer("attempts").notNull().default(0),
		provisioningNextAttemptAt: timestamp("next_attempt_at", {
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
		provisioningLastError: text("last_error"),
		stripeCheckoutSessionId: text("stripe_checkout_session_id"),
		stripeCheckoutUrl: text("stripe_checkout_url"),
		provisioningDetailExpiresAt: timestamp("detail_expires_at", {
			withTimezone: true,
		}),
		provisioningDetailRedactedAt: timestamp("detail_redacted_at", {
			withTimezone: true,
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.phoneNumberId, table.organizationId],
			foreignColumns: [
				whatsappPhoneNumbers.id,
				whatsappPhoneNumbers.organizationId,
			],
			name: "wa_phone_provisioning_phone_org_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.provisioningUsageReservationId, table.organizationId],
			foreignColumns: [usageReservations.id, usageReservations.organizationId],
			name: "wa_phone_provisioning_usage_reservation_org_fk",
		})
			.onUpdate("no action")
			.onDelete("restrict"),
		uniqueIndex("wa_phone_provisioning_phone_uniq").on(table.phoneNumberId),
		uniqueIndex("wa_phone_provisioning_usage_reservation_uniq")
			.on(table.provisioningUsageReservationId)
			.where(sql`${table.provisioningUsageReservationId} IS NOT NULL`),
		uniqueIndex("wa_phone_provisioning_org_key_uniq").on(
			table.organizationId,
			table.provisioningOperationKeyHash,
		),
		check(
			"wa_phone_provisioning_status_check",
			sql`${table.provisioningState} IN ('pending', 'processing', 'waiting_external', 'request_may_have_been_sent', 'unknown', 'manual_review', 'completed', 'failed', 'cancelled')`,
		),
		check(
			"wa_phone_provisioning_phase_check",
			sql`${table.provisioningPhase} IN ('selected', 'telnyx_order', 'billing', 'meta_registration', 'completed')`,
		),
		check(
			"wa_phone_provisioning_numeric_check",
			sql`${table.provisioningLeaseToken} >= 0
				AND ${table.provisioningAttempts} >= 0`,
		),
		check(
			"wa_phone_provisioning_lease_state_check",
			sql`(${table.provisioningState} IN ('processing', 'request_may_have_been_sent')
					AND ${table.provisioningLeaseExpiresAt} IS NOT NULL)
				OR (${table.provisioningState} NOT IN ('processing', 'request_may_have_been_sent')
					AND ${table.provisioningLeaseExpiresAt} IS NULL)`,
		),
		check(
			"wa_phone_provisioning_boundary_check",
			sql`${table.provisioningState} <> 'request_may_have_been_sent'
				OR ${table.provisioningRequestMayHaveBeenSentAt} IS NOT NULL`,
		),
		check(
			"wa_phone_provisioning_completion_check",
			sql`${table.provisioningState} <> 'completed'
				OR ${table.provisioningPhase} = 'completed'`,
		),
		check(
			"wa_phone_provisioning_detail_retention_check",
			sql`(${table.provisioningState} IN ('completed', 'cancelled')
					AND ${table.provisioningVerifiedName} IS NULL
					AND ${table.provisioningDetailExpiresAt} IS NOT NULL
					AND (${table.provisioningDetailRedactedAt} IS NULL
						OR (${table.stripeCheckoutUrl} IS NULL
							AND ${table.provisioningDetailRedactedAt} >= ${table.provisioningDetailExpiresAt})))
				OR (${table.provisioningState} NOT IN ('completed', 'cancelled')
					AND length(btrim(${table.provisioningVerifiedName})) > 0
					AND ${table.provisioningDetailExpiresAt} IS NULL
					AND ${table.provisioningDetailRedactedAt} IS NULL)`,
		),
		check(
			"wa_phone_provisioning_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND (${table.provisioningRequestMayHaveBeenSentAt} IS NULL
					OR ${table.provisioningRequestMayHaveBeenSentAt} >= ${table.createdAt})
				AND (${table.provisioningDetailExpiresAt} IS NULL
					OR ${table.provisioningDetailExpiresAt} >= ${table.createdAt})`,
		),
		index("wa_phone_provisioning_status_due_idx").on(
			table.provisioningState,
			table.provisioningNextAttemptAt,
			table.provisioningLeaseExpiresAt,
		),
		index("wa_phone_provisioning_org_idx").on(table.organizationId),
		index("wa_phone_provisioning_detail_expiry_idx")
			.on(table.provisioningDetailExpiresAt, table.provisioningOperationId)
			.where(sql`${table.provisioningDetailRedactedAt} IS NULL`),
		index("wa_phone_provisioning_evidence_retention_idx")
			.on(table.provisioningDetailExpiresAt, table.provisioningOperationId)
			.where(
				sql`${table.provisioningState} IN ('completed', 'cancelled')
					AND ${table.provisioningDetailRedactedAt} IS NOT NULL`,
			),
	],
);

/**
 * Independent release operation. Snapshot credentials and provider outcomes
 * are isolated from the phone entity and shred at terminal completion.
 */
export const whatsappPhoneReleaseOperations = pgTable(
	"whatsapp_phone_release_operations",
	{
		releaseOperationId: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("wro_")),
		phoneNumberId: text("phone_number_id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		releaseUsageReservationId: text("usage_reservation_id"),
		releaseReason: text("reason", {
			enum: ["user_requested", "tenant_deleted"],
		}).notNull(),
		// Non-cascading credential locators preserve the exact user authority that
		// admitted a user-requested destructive release. Tenant-deletion cleanup is
		// system-authorized and intentionally leaves this snapshot null.
		releaseAuthorityKeyId: text("authority_key_id"),
		releaseAuthorityPrincipalId: text("authority_principal_id"),
		releaseAuthorityPrincipalType: text("authority_principal_type", {
			enum: ["service", "dashboard_user"],
		}),
		releaseAuthorityUserId: text("authority_user_id"),
		releaseAuthorityMemberId: text("authority_member_id"),
		releaseAuthoritySessionId: text("authority_session_id"),
		releaseAuthorityWorkspaceId: text("authority_workspace_id"),
		releaseAuthorityRequiresAllWorkspaceScope: boolean(
			"authority_requires_all_workspace_scope",
		),
		releaseAuthorityCredentialVersion: text("authority_credential_version"),
		releaseAuthorityAdmittedAt: timestamp("authority_admitted_at", {
			withTimezone: true,
		}),
		releaseAuthorityRevision: integer("authority_revision"),
		releaseAuthorityRevokedAt: timestamp("authority_revoked_at", {
			withTimezone: true,
		}),
		releasePriorPhoneStatus: text("prior_phone_status", {
			enum: [
				"purchasing",
				"pending_verification",
				"verified",
				"active",
				"releasing",
			],
		}).notNull(),
		releaseState: text("status", {
			enum: [
				"pending",
				"processing",
				"request_may_have_been_sent",
				"unknown",
				"revocation_pending",
				"manual_review",
				"completed",
				"failed",
				"cancelled",
			],
		})
			.notNull()
			.default("pending"),
		releasePhase: text("phase", {
			enum: ["meta", "stripe", "telnyx", "completed"],
		})
			.notNull()
			.default("meta"),
		releaseMetaStatus: text("meta_status", {
			enum: ["pending", "not_required", "confirmed", "unknown"],
		}).notNull(),
		releaseStripeStatus: text("stripe_status", {
			enum: ["pending", "not_required", "confirmed", "unknown"],
		}).notNull(),
		releaseTelnyxStatus: text("telnyx_status", {
			enum: ["pending", "not_required", "confirmed", "unknown"],
		}).notNull(),
		releaseSourceAccountId: text("source_account_id"),
		releaseSourceTokenVersion: integer("source_token_version"),
		releaseAccessTokenCiphertext: text("access_token_ciphertext"),
		releaseLeaseToken: integer("lease_token").notNull().default(0),
		releaseLeaseExpiresAt: timestamp("lease_expires_at", {
			withTimezone: true,
		}),
		releaseRequestMayHaveBeenSentAt: timestamp(
			"request_may_have_been_sent_at",
			{ withTimezone: true },
		),
		releaseAttempts: integer("attempts").notNull().default(0),
		releaseNextAttemptAt: timestamp("next_attempt_at", {
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
		releaseLastError: text("last_error"),
		releaseRequestedAt: timestamp("requested_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		releasedAt: timestamp("completed_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.phoneNumberId, table.organizationId],
			foreignColumns: [
				whatsappPhoneNumbers.id,
				whatsappPhoneNumbers.organizationId,
			],
			name: "wa_phone_release_phone_org_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.releaseUsageReservationId, table.organizationId],
			foreignColumns: [usageReservations.id, usageReservations.organizationId],
			name: "wa_phone_release_usage_reservation_org_fk",
		})
			.onUpdate("no action")
			.onDelete("restrict"),
		uniqueIndex("wa_phone_release_phone_uniq").on(table.phoneNumberId),
		uniqueIndex("wa_phone_release_usage_reservation_uniq")
			.on(table.releaseUsageReservationId)
			.where(sql`${table.releaseUsageReservationId} IS NOT NULL`),
		check(
			"wa_phone_release_reason_check",
			sql`${table.releaseReason} IN ('user_requested', 'tenant_deleted')`,
		),
		check(
			"wa_phone_release_status_check",
			sql`${table.releaseState} IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'revocation_pending', 'manual_review', 'completed', 'failed', 'cancelled')`,
		),
		check(
			"wa_phone_release_prior_phone_status_check",
			sql`${table.releasePriorPhoneStatus} IN ('purchasing', 'pending_verification', 'verified', 'active', 'releasing')`,
		),
		check(
			"wa_phone_release_authority_check",
			sql`(${table.releaseReason} = 'tenant_deleted'
					AND ${table.releaseAuthorityKeyId} IS NULL
					AND ${table.releaseAuthorityPrincipalId} IS NULL
					AND ${table.releaseAuthorityPrincipalType} IS NULL
					AND ${table.releaseAuthorityUserId} IS NULL
					AND ${table.releaseAuthorityMemberId} IS NULL
					AND ${table.releaseAuthoritySessionId} IS NULL
					AND ${table.releaseAuthorityWorkspaceId} IS NULL
					AND ${table.releaseAuthorityRequiresAllWorkspaceScope} IS NULL
					AND ${table.releaseAuthorityCredentialVersion} IS NULL
					AND ${table.releaseAuthorityAdmittedAt} IS NULL
					AND ${table.releaseAuthorityRevision} IS NULL
					AND ${table.releaseAuthorityRevokedAt} IS NULL)
				OR (${table.releaseReason} = 'user_requested'
					AND ${table.releaseAuthorityKeyId} IS NOT NULL
					AND ${table.releaseAuthorityPrincipalId} IS NOT NULL
					AND ${table.releaseAuthorityPrincipalType} IN ('service', 'dashboard_user')
					AND (${table.releaseAuthorityPrincipalType} = 'dashboard_user') = (${table.releaseAuthorityUserId} IS NOT NULL)
					AND (${table.releaseAuthorityPrincipalType} = 'dashboard_user') = (${table.releaseAuthorityMemberId} IS NOT NULL)
					AND (${table.releaseAuthorityPrincipalType} = 'dashboard_user') = (${table.releaseAuthoritySessionId} IS NOT NULL)
					AND ${table.releaseAuthorityRequiresAllWorkspaceScope} IS NOT NULL
					AND (${table.releaseAuthorityWorkspaceId} IS NULL) = ${table.releaseAuthorityRequiresAllWorkspaceScope}
					AND ${table.releaseAuthorityCredentialVersion} IS NOT NULL
					AND ${table.releaseAuthorityAdmittedAt} IS NOT NULL
					AND ${table.releaseAuthorityRevision} > 0)`,
		),
		check(
			"wa_phone_release_phase_check",
			sql`${table.releasePhase} IN ('meta', 'stripe', 'telnyx', 'completed')`,
		),
		check(
			"wa_phone_release_provider_status_check",
			sql`${table.releaseMetaStatus} IN ('pending', 'not_required', 'confirmed', 'unknown')
				AND ${table.releaseStripeStatus} IN ('pending', 'not_required', 'confirmed', 'unknown')
				AND ${table.releaseTelnyxStatus} IN ('pending', 'not_required', 'confirmed', 'unknown')`,
		),
		check(
			"wa_phone_release_numeric_check",
			sql`(${table.releaseSourceTokenVersion} IS NULL OR ${table.releaseSourceTokenVersion} >= 0)
				AND ${table.releaseLeaseToken} >= 0
				AND ${table.releaseAttempts} >= 0`,
		),
		check(
			"wa_phone_release_source_check",
			sql`(${table.releaseSourceAccountId} IS NULL
					AND ${table.releaseSourceTokenVersion} IS NULL
					AND ${table.releaseAccessTokenCiphertext} IS NULL)
				OR (${table.releaseSourceAccountId} IS NOT NULL
					AND ${table.releaseSourceTokenVersion} IS NOT NULL
					AND ${table.releaseAccessTokenCiphertext} IS NOT NULL)`,
		),
		check(
			"wa_phone_release_lease_state_check",
			sql`(${table.releaseState} IN ('processing', 'request_may_have_been_sent')
					AND ${table.releaseLeaseExpiresAt} IS NOT NULL)
				OR (${table.releaseState} NOT IN ('processing', 'request_may_have_been_sent')
					AND ${table.releaseLeaseExpiresAt} IS NULL)`,
		),
		check(
			"wa_phone_release_boundary_check",
			sql`${table.releaseState} <> 'request_may_have_been_sent'
				OR ${table.releaseRequestMayHaveBeenSentAt} IS NOT NULL`,
		),
		check(
			"wa_phone_release_completion_check",
			sql`(${table.releaseState} = 'completed'
					AND ${table.releasePhase} = 'completed'
					AND ${table.releaseMetaStatus} IN ('confirmed', 'not_required')
					AND ${table.releaseStripeStatus} IN ('confirmed', 'not_required')
					AND ${table.releaseTelnyxStatus} IN ('confirmed', 'not_required')
					AND ${table.releasedAt} IS NOT NULL
					AND ${table.releaseAccessTokenCiphertext} IS NULL)
				OR (${table.releaseState} <> 'completed'
					AND ${table.releasedAt} IS NULL)`,
		),
		check(
			"wa_phone_release_revocation_check",
			sql`(${table.releaseState} IN ('revocation_pending', 'cancelled')) = (${table.releaseAuthorityRevokedAt} IS NOT NULL)`,
		),
		check(
			"wa_phone_release_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.releaseRequestedAt}
				AND (${table.releaseAuthorityAdmittedAt} IS NULL OR ${table.releaseAuthorityAdmittedAt} <= ${table.releaseRequestedAt})
				AND (${table.releaseAuthorityRevokedAt} IS NULL OR ${table.releaseAuthorityRevokedAt} >= ${table.releaseAuthorityAdmittedAt})
				AND (${table.releaseRequestMayHaveBeenSentAt} IS NULL
					OR ${table.releaseRequestMayHaveBeenSentAt} >= ${table.releaseRequestedAt})
				AND (${table.releasedAt} IS NULL
					OR ${table.releasedAt} >= ${table.releaseRequestedAt})`,
		),
		index("wa_phone_release_status_due_idx").on(
			table.releaseState,
			table.releaseNextAttemptAt,
			table.releaseLeaseExpiresAt,
		),
		index("wa_phone_release_org_idx").on(table.organizationId),
		index("wa_phone_release_retention_idx")
			.on(table.releasedAt, table.releaseOperationId)
			.where(sql`${table.releaseState} = 'completed'`),
	],
);

// =====================
// Custom Fields
// =====================

export const customFieldDefinitions = pgTable(
	"custom_field_definitions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("cfd_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		type: text("type", { enum: [...CUSTOM_FIELD_TYPES] }).notNull(),
		options: jsonb("options"), // string[] for select type
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("custom_field_definitions_id_org_uniq").on(
			table.id,
			table.organizationId,
		),
		unique("custom_field_definitions_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "custom_field_definitions_workspace_org_fk",
		}),
		uniqueIndex("custom_field_defs_org_scope_slug_uniq").on(
			table.organizationId,
			table.scopeKey,
			table.slug,
		),
		check(
			"custom_field_definitions_type_check",
			sql`${table.type} IN ('text', 'number', 'date', 'boolean', 'select')`,
		),
		check(
			"custom_field_definitions_options_by_type_check",
			sql`(${table.type} = 'select'
					AND ${table.options} IS NOT NULL
					AND jsonb_typeof(${table.options}) = 'array'
					AND jsonb_array_length(${table.options}) > 0
					AND NOT jsonb_path_exists(
						${table.options},
						'$[*] ? (@.type() != "string" || @ like_regex "^[[:space:]]*$")'
					))
				OR (${table.type} <> 'select' AND ${table.options} IS NULL)`,
		),
		index("custom_field_defs_org_idx").on(table.organizationId),
		index("custom_field_defs_workspace_idx").on(table.workspaceId),
	],
);

export const customFieldValues = pgTable(
	"custom_field_values",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("cfv_")),
		definitionId: text("definition_id").notNull(),
		contactId: text("contact_id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		definitionScopeKey: text("definition_scope_key")
			.notNull()
			.default(ORGANIZATION_SCOPE_KEY),
		value: text("value").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [
				table.definitionId,
				table.organizationId,
				table.definitionScopeKey,
			],
			foreignColumns: [
				customFieldDefinitions.id,
				customFieldDefinitions.organizationId,
				customFieldDefinitions.scopeKey,
			],
			name: "custom_field_values_definition_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.contactId, table.organizationId, table.scopeKey],
			foreignColumns: [contacts.id, contacts.organizationId, contacts.scopeKey],
			name: "custom_field_values_contact_org_scope_fk",
		}).onDelete("cascade"),
		check(
			"custom_field_values_definition_scope_check",
			sql`${table.definitionScopeKey} = 'org' OR ${table.definitionScopeKey} = ${table.scopeKey}`,
		),
		uniqueIndex("custom_field_values_def_contact_idx").on(
			table.definitionId,
			table.contactId,
		),
		index("custom_field_values_contact_idx").on(table.contactId),
	],
);

// ---------------------------------------------------------------------------
// Contacts — Unified contact registry (replaces WhatsApp-only contacts)
// ---------------------------------------------------------------------------

export const contacts = pgTable(
	"contacts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ct_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id"),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		// Direct identifiers and freeform metadata are AES-256-GCM envelopes.
		// Equality/substring capabilities use purpose-isolated keyed projections;
		// plaintext never reaches PostgreSQL.
		nameCiphertext: text("name_ciphertext"),
		nameHash: text("name_hash"),
		nameSearchTokens: text("name_search_tokens")
			.array()
			.notNull()
			.default(sql`ARRAY[]::text[]`),
		emailCiphertext: text("email_ciphertext"),
		emailHash: text("email_hash"),
		emailSearchTokens: text("email_search_tokens")
			.array()
			.notNull()
			.default(sql`ARRAY[]::text[]`),
		phoneCiphertext: text("phone_ciphertext"),
		phoneHash: text("phone_hash"),
		phoneSearchTokens: text("phone_search_tokens")
			.array()
			.notNull()
			.default(sql`ARRAY[]::text[]`),
		metadataCiphertext: text("metadata_ciphertext"),
		searchIdentityKeyFingerprint: text(
			"search_identity_key_fingerprint",
		).notNull(),
		tags: text("tags").array().notNull().default([]),
		// Public global preference/projection only. Delivery authority lives in the
		// canonical per-channel consent state populated by API/automation writes.
		optedIn: boolean("opted_in").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("contacts_id_org_uniq").on(table.id, table.organizationId),
		unique("contacts_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "contacts_workspace_org_fk",
		}).onDelete("restrict"),
		index("contacts_org_idx").on(table.organizationId),
		index("contacts_workspace_idx").on(table.workspaceId),
		index("contacts_org_created_idx").on(
			table.organizationId,
			table.createdAt,
			table.id,
		),
		index("contacts_org_workspace_created_idx").on(
			table.organizationId,
			table.workspaceId,
			table.createdAt,
			table.id,
		),
		uniqueIndex("contacts_scope_email_hash_uniq")
			.on(table.organizationId, table.scopeKey, table.emailHash)
			.where(sql`${table.emailHash} IS NOT NULL`),
		uniqueIndex("contacts_scope_phone_hash_uniq")
			.on(table.organizationId, table.scopeKey, table.phoneHash)
			.where(sql`${table.phoneHash} IS NOT NULL`),
		index("contacts_scope_name_hash_idx").on(
			table.organizationId,
			table.scopeKey,
			table.nameHash,
		),
		index("contacts_name_search_tokens_idx").using(
			"gin",
			table.nameSearchTokens,
		),
		index("contacts_email_search_tokens_idx").using(
			"gin",
			table.emailSearchTokens,
		),
		index("contacts_phone_search_tokens_idx").using(
			"gin",
			table.phoneSearchTokens,
		),
		check(
			"contacts_name_protected_tuple_check",
			sql`(${table.nameCiphertext} IS NULL
					AND ${table.nameHash} IS NULL
					AND cardinality(${table.nameSearchTokens}) = 0)
				OR (${table.nameCiphertext} ~ '^enc:v2:[A-Za-z0-9_-]{1,32}:'
					AND ${table.nameHash} ~ '^[0-9a-f]{64}$'
					AND cardinality(${table.nameSearchTokens}) BETWEEN 0 AND 765
					AND (cardinality(${table.nameSearchTokens}) = 0
						OR array_to_string(${table.nameSearchTokens}, '')
							~ '^([0-9a-f]{32})+$'))`,
		),
		check(
			"contacts_email_protected_tuple_check",
			sql`(${table.emailCiphertext} IS NULL
					AND ${table.emailHash} IS NULL
					AND cardinality(${table.emailSearchTokens}) = 0)
				OR (${table.emailCiphertext} ~ '^enc:v2:[A-Za-z0-9_-]{1,32}:'
					AND ${table.emailHash} ~ '^[0-9a-f]{64}$'
					AND cardinality(${table.emailSearchTokens}) BETWEEN 0 AND 957
					AND (cardinality(${table.emailSearchTokens}) = 0
						OR array_to_string(${table.emailSearchTokens}, '')
							~ '^([0-9a-f]{32})+$'))`,
		),
		check(
			"contacts_phone_protected_tuple_check",
			sql`(${table.phoneCiphertext} IS NULL
					AND ${table.phoneHash} IS NULL
					AND cardinality(${table.phoneSearchTokens}) = 0)
				OR (${table.phoneCiphertext} ~ '^enc:v2:[A-Za-z0-9_-]{1,32}:'
					AND ${table.phoneHash} ~ '^[0-9a-f]{64}$'
					AND cardinality(${table.phoneSearchTokens}) BETWEEN 1 AND 237
					AND array_to_string(${table.phoneSearchTokens}, '')
						~ '^([0-9a-f]{32})+$')`,
		),
		check(
			"contacts_metadata_ciphertext_check",
			sql`${table.metadataCiphertext} IS NULL
				OR ${table.metadataCiphertext}
					~ '^enc:v2:[A-Za-z0-9_-]{1,32}:'`,
		),
		check(
			"contacts_search_identity_key_fingerprint_check",
			sql`${table.searchIdentityKeyFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
	],
);

export const contactChannels = pgTable(
	"contact_channels",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("cc_")),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		contactId: text("contact_id").notNull(),
		socialAccountId: text("social_account_id").notNull(),
		platform: platformEnum("platform").notNull(),
		identifierCiphertext: text("identifier_ciphertext").notNull(),
		identifierHash: text("identifier_hash").notNull(),
		identityKeyFingerprint: text("identity_key_fingerprint").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.contactId, table.organizationId, table.scopeKey],
			foreignColumns: [contacts.id, contacts.organizationId, contacts.scopeKey],
			name: "contact_channels_contact_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [
				table.socialAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
				socialAccounts.platform,
			],
			name: "contact_channels_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		index("contact_channels_contact_idx").on(table.contactId),
		index("contact_channels_platform_account_contact_idx").on(
			table.platform,
			table.socialAccountId,
			table.contactId,
		),
		uniqueIndex("contact_channels_account_identifier_idx").on(
			table.socialAccountId,
			table.identifierHash,
		),
		check(
			"contact_channels_identifier_ciphertext_check",
			sql`${table.identifierCiphertext}
				~ '^enc:v2:[A-Za-z0-9_-]{1,32}:'`,
		),
		check(
			"contact_channels_identifier_hash_check",
			sql`${table.identifierHash} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"contact_channels_identity_key_fingerprint_check",
			sql`${table.identityKeyFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
	],
);

/** Immutable, auditable consent and withdrawal evidence. */
export const contactConsentEvents = pgTable(
	"contact_consent_events",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("cce_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		contactId: text("contact_id").references(() => contacts.id, {
			onDelete: "set null",
		}),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "set null",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		orderingHlc: bigint("ordering_hlc", { mode: "bigint" }).notNull(),
		orderingRegion: text("ordering_region").notNull().default("home"),
		channel: text("channel").notNull(),
		purpose: text("purpose").notNull(),
		status: text("status", {
			enum: ["granted", "denied"],
		}).notNull(),
		logicalIdentifierHash: text("logical_identifier_hash").notNull(),
		identifierHash: text("identifier_hash").notNull(),
		identifierKeyVersion: text("identifier_key_version").notNull(),
		identifierMasked: text("identifier_masked"),
		source: text("source").notNull(),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
		evidence: jsonb("evidence"),
		policyVersion: text("policy_version"),
		jurisdiction: text("jurisdiction"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("contact_consent_events_id_org_uniq").on(
			table.id,
			table.organizationId,
		),
		unique("contact_consent_events_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		unique("contact_consent_events_ordering_tuple_uniq").on(
			table.orderingHlc,
			table.orderingRegion,
			table.id,
		),
		unique("contact_consent_events_projection_source_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
			table.orderingHlc,
			table.orderingRegion,
		),
		check(
			"contact_consent_events_status_check",
			sql`${table.status} IN ('granted', 'denied')`,
		),
		check(
			"contact_consent_events_channel_canonical_check",
			sql`${table.channel} <> '' AND ${table.channel} = lower(btrim(${table.channel}))`,
		),
		check(
			"contact_consent_events_purpose_canonical_check",
			sql`${table.purpose} <> '' AND ${table.purpose} = lower(btrim(${table.purpose}))`,
		),
		check(
			"contact_consent_events_logical_identifier_hash_check",
			sql`${table.logicalIdentifierHash} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"contact_consent_events_identifier_hash_check",
			sql`${table.identifierHash} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"contact_consent_events_identifier_key_version_check",
			sql`${table.identifierKeyVersion} ~ '^[A-Za-z0-9_-]{1,32}$' AND ${table.identifierKeyVersion} <> 'identity'`,
		),
		check(
			"contact_consent_events_ordering_hlc_positive_check",
			sql`${table.orderingHlc} > 0`,
		),
		check(
			"contact_consent_events_ordering_region_check",
			sql`${table.orderingRegion} ~ '^[a-z0-9][a-z0-9_-]{0,31}$'`,
		),
		check(
			"contact_consent_events_timestamp_order_check",
			sql`${table.occurredAt} <= ${table.createdAt} + interval '5 minutes'`,
		),
		foreignKey({
			columns: [table.contactId, table.organizationId, table.scopeKey],
			foreignColumns: [contacts.id, contacts.organizationId, contacts.scopeKey],
			name: "contact_consent_events_contact_org_scope_fk",
		}),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "contact_consent_events_workspace_org_fk",
		}),
		index("contact_consent_events_contact_idx").on(
			table.contactId,
			table.occurredAt,
		),
		index("contact_consent_events_identifier_idx").on(
			table.organizationId,
			table.channel,
			table.purpose,
			table.logicalIdentifierHash,
			table.occurredAt,
		),
		index("contact_consent_events_supersession_idx").on(
			table.organizationId,
			table.channel,
			table.purpose,
			table.logicalIdentifierHash,
			table.orderingHlc,
			table.orderingRegion,
			table.id,
		),
		index("contact_consent_events_org_ordering_idx").on(
			table.organizationId,
			table.orderingHlc,
			table.orderingRegion,
			table.id,
		),
		index("contact_consent_events_retention_idx")
			.on(table.occurredAt, table.id)
			.where(
				sql`${table.contactId} IS NOT NULL
					OR ${table.identifierMasked} IS NOT NULL
					OR ${table.evidence} IS NOT NULL`,
			),
	],
);

/** Current consent projection used for indexed bulk send authorization. */
export const contactConsentStates = pgTable(
	"contact_consent_states",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ccs_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "set null",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		channel: text("channel").notNull(),
		purpose: text("purpose").notNull(),
		logicalIdentifierHash: text("logical_identifier_hash").notNull(),
		identifierHash: text("identifier_hash").notNull(),
		identifierKeyVersion: text("identifier_key_version").notNull(),
		identityKeyFingerprint: text("identity_key_fingerprint").notNull(),
		status: text("status", {
			enum: ["granted", "denied"],
		}).notNull(),
		source: text("source").notNull(),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
		policyVersion: text("policy_version"),
		jurisdiction: text("jurisdiction"),
		lastEventId: text("last_event_id").notNull(),
		lastOrderingHlc: bigint("last_ordering_hlc", {
			mode: "bigint",
		}).notNull(),
		lastOrderingRegion: text("last_ordering_region").notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		foreignKey({
			columns: [
				table.lastEventId,
				table.organizationId,
				table.scopeKey,
				table.lastOrderingHlc,
				table.lastOrderingRegion,
			],
			foreignColumns: [
				contactConsentEvents.id,
				contactConsentEvents.organizationId,
				contactConsentEvents.scopeKey,
				contactConsentEvents.orderingHlc,
				contactConsentEvents.orderingRegion,
			],
			name: "contact_consent_states_projection_source_fk",
		}),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "contact_consent_states_workspace_org_fk",
		}),
		uniqueIndex("contact_consent_states_identifier_idx").on(
			table.organizationId,
			table.channel,
			table.purpose,
			table.logicalIdentifierHash,
		),
		uniqueIndex("contact_consent_states_versioned_identifier_idx").on(
			table.organizationId,
			table.channel,
			table.purpose,
			table.identifierKeyVersion,
			table.identifierHash,
		),
		index("contact_consent_states_denied_identifier_idx")
			.on(
				table.organizationId,
				table.channel,
				table.purpose,
				table.logicalIdentifierHash,
			)
			.where(sql`${table.status} = 'denied'`),
		check(
			"contact_consent_states_ordering_hlc_positive_check",
			sql`${table.lastOrderingHlc} > 0`,
		),
		check(
			"contact_consent_states_ordering_region_check",
			sql`${table.lastOrderingRegion} ~ '^[a-z0-9][a-z0-9_-]{0,31}$'`,
		),
		check(
			"contact_consent_states_status_check",
			sql`${table.status} IN ('granted', 'denied')`,
		),
		check(
			"contact_consent_states_channel_canonical_check",
			sql`${table.channel} <> '' AND ${table.channel} = lower(btrim(${table.channel}))`,
		),
		check(
			"contact_consent_states_purpose_canonical_check",
			sql`${table.purpose} <> '' AND ${table.purpose} = lower(btrim(${table.purpose}))`,
		),
		check(
			"contact_consent_states_logical_identifier_hash_check",
			sql`${table.logicalIdentifierHash} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"contact_consent_states_identifier_hash_check",
			sql`${table.identifierHash} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"contact_consent_states_identifier_key_version_check",
			sql`${table.identifierKeyVersion} ~ '^[A-Za-z0-9_-]{1,32}$' AND ${table.identifierKeyVersion} <> 'identity'`,
		),
		check(
			"contact_consent_states_identity_key_fingerprint_check",
			sql`${table.identityKeyFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"contact_consent_states_timestamp_order_check",
			sql`${table.occurredAt} <= ${table.updatedAt} + interval '5 minutes'`,
		),
	],
);

// =====================
// Broadcasts (platform-agnostic)
// =====================

export const broadcasts = pgTable(
	"broadcasts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("bc_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		socialAccountId: text("social_account_id").notNull(),
		platform: platformEnum("platform").notNull(),
		name: text("name"),
		description: text("description"),
		status: text("status").notNull().default("draft"),
		revision: integer("revision").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		messageText: text("message_text"),
		templateName: text("template_name"),
		templateLanguage: text("template_language").default("en_US"),
		templateComponents: jsonb("template_components"),
		recipientCount: integer("recipient_count").notNull().default(0),
		sentCount: integer("sent_count").notNull().default(0),
		failedCount: integer("failed_count").notNull().default(0),
		scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("broadcasts_id_org_uniq").on(table.id, table.organizationId),
		unique("broadcasts_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "broadcasts_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.socialAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
				socialAccounts.platform,
			],
			name: "broadcasts_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		check(
			"broadcasts_status_check",
			sql`${table.status} IN ('draft', 'scheduled', 'sending', 'sent', 'partially_failed', 'requires_attention', 'failed', 'cancelled')`,
		),
		check(
			"broadcasts_counts_nonnegative_check",
			sql`${table.recipientCount} >= 0 AND ${table.sentCount} >= 0 AND ${table.failedCount} >= 0 AND ${table.revision} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"broadcasts_counts_bounded_check",
			sql`${table.sentCount} + ${table.failedCount} <= ${table.recipientCount}`,
		),
		check(
			"broadcasts_schedule_state_check",
			sql`${table.status} <> 'scheduled' OR (${table.scheduledAt} IS NOT NULL AND ${table.recipientCount} > 0)`,
		),
		check(
			"broadcasts_lease_state_check",
			sql`${table.leaseExpiresAt} IS NULL OR ${table.status} = 'sending'`,
		),
		check(
			"broadcasts_terminal_timestamp_check",
			sql`${table.status} NOT IN ('sent', 'partially_failed', 'requires_attention', 'failed', 'cancelled') OR ${table.completedAt} IS NOT NULL`,
		),
		check(
			"broadcasts_content_check",
			sql`(${table.platform} = 'whatsapp' AND ${table.templateName} IS NOT NULL)
				OR (${table.platform} <> 'whatsapp' AND ${table.messageText} IS NOT NULL)`,
		),
		index("broadcasts_org_idx").on(table.organizationId),
		index("broadcasts_workspace_idx").on(table.workspaceId),
		index("broadcasts_status_idx").on(table.status),
		index("broadcasts_org_status_idx").on(table.organizationId, table.status),
		index("broadcasts_status_scheduled_idx").on(
			table.status,
			table.scheduledAt,
		),
		index("broadcasts_status_lease_idx").on(table.status, table.leaseExpiresAt),
		index("broadcasts_retention_idx")
			.on(table.completedAt, table.id)
			.where(sql`${table.completedAt} IS NOT NULL`),
	],
);

export const broadcastRecipients = pgTable(
	"broadcast_recipients",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("bcr_")),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		broadcastId: text("broadcast_id").notNull(),
		contactId: text("contact_id").references(() => contacts.id, {
			onDelete: "set null",
		}),
		contactIdentifier: text("contact_identifier"),
		contactIdentifierHash: text("contact_identifier_hash").notNull(),
		variables: jsonb("variables"),
		piiErasedAt: timestamp("pii_erased_at", { withTimezone: true }),
		status: text("status").notNull().default("pending"),
		deliveryState: text("delivery_state", {
			enum: [
				"pending",
				"in_flight",
				"succeeded",
				"failed",
				"unknown",
				"cancelled",
			],
		})
			.notNull()
			.default("pending"),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		messageId: text("message_id"),
		error: text("error"),
		sentAt: timestamp("sent_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.broadcastId, table.organizationId, table.scopeKey],
			foreignColumns: [
				broadcasts.id,
				broadcasts.organizationId,
				broadcasts.scopeKey,
			],
			name: "broadcast_recipients_broadcast_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.contactId, table.organizationId, table.scopeKey],
			foreignColumns: [contacts.id, contacts.organizationId, contacts.scopeKey],
			name: "broadcast_recipients_contact_org_scope_fk",
		}),
		check(
			"broadcast_recipients_status_check",
			sql`${table.status} IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled')`,
		),
		check(
			"broadcast_recipients_delivery_state_check",
			sql`${table.deliveryState} IN ('pending', 'in_flight', 'succeeded', 'failed', 'unknown', 'cancelled')`,
		),
		check(
			"broadcast_recipients_status_delivery_check",
			sql`(${table.status} = 'pending' AND ${table.deliveryState} = 'pending')
				OR (${table.status} = 'sending' AND ${table.deliveryState} IN ('in_flight', 'unknown'))
				OR (${table.status} = 'sent' AND ${table.deliveryState} = 'succeeded')
				OR (${table.status} = 'failed' AND ${table.deliveryState} = 'failed')
				OR (${table.status} = 'unknown' AND ${table.deliveryState} = 'unknown')
				OR (${table.status} = 'cancelled' AND ${table.deliveryState} = 'cancelled')`,
		),
		check(
			"broadcast_recipients_claim_state_check",
			sql`${table.status} <> 'sending' OR ${table.claimedAt} IS NOT NULL`,
		),
		check(
			"broadcast_recipients_pii_tuple_check",
			sql`(${table.contactIdentifier} IS NOT NULL AND ${table.piiErasedAt} IS NULL)
				OR (${table.contactIdentifier} IS NULL AND ${table.piiErasedAt} IS NOT NULL)`,
		),
		check(
			"broadcast_recipients_sendable_identity_check",
			sql`(${table.status} = 'pending'
					OR (${table.status} = 'sending'
						AND ${table.requestMayHaveBeenSentAt} IS NULL))
				IS NOT TRUE
				OR ${table.contactIdentifier} IS NOT NULL`,
		),
		index("broadcast_recipients_contact_idx").on(table.contactId),
		index("broadcast_recipients_identifier_hash_idx").on(
			table.contactIdentifierHash,
		),
		index("broadcast_recipients_claim_idx").on(
			table.broadcastId,
			table.status,
			table.id,
		),
		index("broadcast_recipients_pii_retention_idx")
			.on(table.broadcastId, table.status, table.id)
			.where(sql`${table.piiErasedAt} IS NULL`),
		index("broadcast_recipients_outcome_retention_idx")
			.on(table.broadcastId, table.status, table.id)
			.where(sql`${table.piiErasedAt} IS NOT NULL`),
		uniqueIndex("broadcast_recipients_identity_uniq").on(
			table.broadcastId,
			table.organizationId,
			table.scopeKey,
			table.contactIdentifierHash,
		),
	],
);

// ---------------------------------------------------------------------------
// Ads enums
// ---------------------------------------------------------------------------

export const adPlatformEnum = pgEnum("ad_platform", [
	"meta",
	"google",
	"tiktok",
	"linkedin",
	"pinterest",
	"twitter",
]);

export const adStatusEnum = pgEnum("ad_status", [
	"draft",
	"pending_review",
	"active",
	"paused",
	"completed",
	"rejected",
	"cancelled",
]);

export const adObjectiveEnum = pgEnum("ad_objective", [
	"awareness",
	"traffic",
	"engagement",
	"leads",
	"conversions",
	"video_views",
]);

export const adConnectionStatusEnum = pgEnum("ad_connection_status", [
	"pending",
	"active",
	"expired",
	"revoked",
	"error",
]);

export const audienceTypeEnum = pgEnum("audience_type", AD_AUDIENCE_TYPES);

export const ideaMediaTypeEnum = pgEnum("idea_media_type", IDEA_MEDIA_TYPES);

export const ideaActivityActionEnum = pgEnum("idea_activity_action", [
	"created",
	"moved",
	"assigned",
	"commented",
	"converted",
	"updated",
	"media_added",
	"media_removed",
	"tagged",
	"untagged",
]);

// ---------------------------------------------------------------------------
// Ads tables
// ---------------------------------------------------------------------------

/**
 * Dedicated advertising authorization. Paid-media credentials are deliberately
 * separate from social publishing credentials so scope/revocation boundaries
 * cannot bleed between the two products.
 */
export const adConnections = pgTable(
	"ad_connections",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("adconn_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		platform: adPlatformEnum("platform").notNull(),
		providerPrincipalId: text("provider_principal_id").notNull(),
		displayName: text("display_name"),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		tokenSecret: text("token_secret"),
		accessTokenExpiresAt: timestamp("access_token_expires_at", {
			withTimezone: true,
		}),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
			withTimezone: true,
		}),
		scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`),
		status: adConnectionStatusEnum("status").notNull().default("pending"),
		credentialVersion: integer("credential_version").notNull().default(1),
		metadata: jsonb("metadata"),
		refreshLeaseExpiresAt: timestamp("refresh_lease_expires_at", {
			withTimezone: true,
		}),
		lastRefreshAttemptAt: timestamp("last_refresh_attempt_at", {
			withTimezone: true,
		}),
		lastError: text("last_error"),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("ad_connections_id_org_uniq").on(table.id, table.organizationId),
		unique("ad_connections_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		unique("ad_connections_id_org_scope_platform_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
			table.platform,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ad_connections_workspace_org_fk",
		}),
		uniqueIndex("ad_connections_principal_scope_uniq").on(
			table.organizationId,
			table.scopeKey,
			table.platform,
			table.providerPrincipalId,
		),
		index("ad_connections_org_status_idx").on(
			table.organizationId,
			table.status,
		),
		index("ad_connections_refresh_due_idx").on(
			table.status,
			table.accessTokenExpiresAt,
			table.refreshLeaseExpiresAt,
		),
		check(
			"ad_connections_credential_version_check",
			sql`${table.credentialVersion} > 0`,
		),
		check(
			"ad_connections_revocation_state_check",
			sql`(${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL)
				OR (${table.status} <> 'revoked' AND ${table.revokedAt} IS NULL)`,
		),
	],
);

/** Links a dedicated ad connection to platform ad accounts (1:N). */
export const adAccounts = pgTable(
	"ad_accounts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("adacc_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		adConnectionId: text("ad_connection_id"),
		// Transitional boost identity only. New provider authority comes from
		// ad_connection_id. The legacy composite FK remains for existing rows but,
		// because this column is nullable, does not authorize dedicated connections.
		socialAccountId: text("social_account_id"),
		platform: adPlatformEnum("platform").notNull(),
		platformAdAccountId: text("platform_ad_account_id").notNull(),
		name: text("name"),
		currency: varchar("currency", { length: 3 }),
		timezone: text("timezone"),
		status: text("status").default("active"),
		capabilities: jsonb("capabilities"),
		capabilitiesCheckedAt: timestamp("capabilities_checked_at", {
			withTimezone: true,
		}),
		metadata: jsonb("metadata"),
		// Read-only provider synchronization. The due clock is independent from
		// freshness and from the enqueue/consumer lease so overlapping crons and
		// at-least-once Queue delivery cannot multiply provider reads.
		lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
		nextSyncAt: timestamp("next_sync_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		syncGeneration: integer("sync_generation").notNull().default(0),
		syncLeaseExpiresAt: timestamp("sync_lease_expires_at", {
			withTimezone: true,
		}),
		syncStartedAt: timestamp("sync_started_at", { withTimezone: true }),
		syncAttempts: integer("sync_attempts").notNull().default(0),
		syncLastError: text("sync_last_error"),
		syncLastErrorClass: text("sync_last_error_class"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("ad_accounts_id_org_uniq").on(table.id, table.organizationId),
		unique("ad_accounts_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		unique("ad_accounts_id_org_scope_platform_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
			table.platform,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ad_accounts_workspace_org_fk",
		}),
		foreignKey({
			columns: [table.socialAccountId, table.organizationId, table.scopeKey],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
			],
			name: "ad_accounts_social_account_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [
				table.adConnectionId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				adConnections.id,
				adConnections.organizationId,
				adConnections.scopeKey,
				adConnections.platform,
			],
			name: "ad_accounts_connection_org_scope_platform_fk",
		}).onDelete("restrict"),
		uniqueIndex("ad_accounts_org_platform_id_idx").on(
			table.organizationId,
			table.platform,
			table.platformAdAccountId,
		),
		index("ad_accounts_org_idx").on(table.organizationId),
		index("ad_accounts_workspace_idx").on(table.workspaceId),
		index("ad_accounts_social_account_idx").on(table.socialAccountId),
		index("ad_accounts_connection_idx").on(table.adConnectionId),
		index("ad_accounts_status_idx").on(table.status),
		index("ad_accounts_sync_due_idx").on(
			table.status,
			table.nextSyncAt,
			table.syncLeaseExpiresAt,
			table.organizationId,
			table.id,
		),
		check(
			"ad_accounts_authority_check",
			sql`${table.adConnectionId} IS NOT NULL OR ${table.socialAccountId} IS NOT NULL`,
		),
		check(
			"ad_accounts_sync_counters_check",
			sql`${table.syncGeneration} >= 0 AND ${table.syncAttempts} >= 0`,
		),
		check(
			"ad_accounts_sync_claim_check",
			sql`(${table.syncLeaseExpiresAt} IS NULL AND ${table.syncStartedAt} IS NULL)
				OR (${table.syncLeaseExpiresAt} IS NOT NULL
					AND (${table.syncStartedAt} IS NULL
						OR ${table.syncStartedAt} <= ${table.syncLeaseExpiresAt}))`,
		),
		check(
			"ad_accounts_sync_error_class_check",
			sql`${table.syncLastErrorClass} IS NULL
				OR ${table.syncLastErrorClass} IN ('transient', 'rate_limited', 'permanent')`,
		),
		check(
			"ad_accounts_currency_check",
			sql`${table.currency} IS NULL OR ${table.currency} ~ '^[A-Z]{3}$'`,
		),
	],
);

/** Provider identities an ad account is authorized to promote. */
export const adAccountPromotableIdentities = pgTable(
	"ad_account_promotable_identities",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("adident_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		adAccountId: text("ad_account_id").notNull(),
		socialAccountId: text("social_account_id").references(
			() => socialAccounts.id,
			{ onDelete: "set null" },
		),
		providerIdentityId: text("provider_identity_id").notNull(),
		identityType: text("identity_type", {
			enum: AD_PROMOTABLE_IDENTITY_TYPES,
		}).notNull(),
		displayName: text("display_name"),
		status: text("status", {
			enum: AD_PROMOTABLE_IDENTITY_STATUSES,
		})
			.notNull()
			.default("active"),
		capabilities: jsonb("capabilities"),
		metadata: jsonb("metadata"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ad_account_identities_workspace_org_fk",
		}),
		foreignKey({
			columns: [table.adAccountId, table.organizationId, table.scopeKey],
			foreignColumns: [
				adAccounts.id,
				adAccounts.organizationId,
				adAccounts.scopeKey,
			],
			name: "ad_account_identities_account_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.socialAccountId, table.organizationId, table.scopeKey],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
			],
			name: "ad_account_identities_social_account_org_scope_fk",
		}),
		check(
			"ad_account_identities_identity_type_check",
			sql`${table.identityType} IN ('social_account', 'facebook_page', 'instagram_account', 'linkedin_organization', 'pinterest_profile', 'tiktok_identity', 'x_user')`,
		),
		check(
			"ad_account_identities_status_check",
			sql`${table.status} IN ('active', 'revoked', 'unavailable')`,
		),
		uniqueIndex("ad_account_identities_provider_uniq").on(
			table.adAccountId,
			table.identityType,
			table.providerIdentityId,
		),
		index("ad_account_identities_social_idx").on(table.socialAccountId),
		index("ad_account_identities_account_idx").on(table.adAccountId),
	],
);

/** Top-level campaign grouping */
export const adCampaigns = pgTable(
	"ad_campaigns",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("camp_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		adAccountId: text("ad_account_id").notNull(),
		platform: adPlatformEnum("platform").notNull(),
		platformCampaignId: text("platform_campaign_id"),
		name: text("name").notNull(),
		objective: adObjectiveEnum("objective").notNull(),
		status: adStatusEnum("status").notNull().default("draft"),
		dailyBudgetCents: integer("daily_budget_cents"),
		lifetimeBudgetCents: integer("lifetime_budget_cents"),
		currency: varchar("currency", { length: 3 }),
		startDate: timestamp("start_date", { withTimezone: true }),
		endDate: timestamp("end_date", { withTimezone: true }),
		isExternal: boolean("is_external").notNull().default(false),
		metadata: jsonb("metadata"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("ad_campaigns_id_org_uniq").on(table.id, table.organizationId),
		unique("ad_campaigns_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		unique("ad_campaigns_id_account_org_uniq").on(
			table.id,
			table.adAccountId,
			table.organizationId,
		),
		unique("ad_campaigns_id_account_org_scope_uniq").on(
			table.id,
			table.adAccountId,
			table.organizationId,
			table.scopeKey,
		),
		unique("ad_campaigns_id_account_org_scope_platform_uniq").on(
			table.id,
			table.adAccountId,
			table.organizationId,
			table.scopeKey,
			table.platform,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ad_campaigns_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.adAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				adAccounts.id,
				adAccounts.organizationId,
				adAccounts.scopeKey,
				adAccounts.platform,
			],
			name: "ad_campaigns_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		check(
			"ad_campaigns_budget_check",
			sql`(${table.dailyBudgetCents} IS NULL OR ${table.dailyBudgetCents} > 0)
				AND (${table.lifetimeBudgetCents} IS NULL OR ${table.lifetimeBudgetCents} > 0)`,
		),
		check(
			"ad_campaigns_currency_check",
			sql`${table.currency} IS NULL OR ${table.currency} ~ '^[A-Z]{3}$'`,
		),
		check(
			"ad_campaigns_date_order_check",
			sql`${table.endDate} IS NULL OR ${table.startDate} IS NULL OR ${table.endDate} >= ${table.startDate}`,
		),
		index("ad_campaigns_org_idx").on(table.organizationId),
		index("ad_campaigns_workspace_idx").on(table.workspaceId),
		index("ad_campaigns_ad_account_idx").on(table.adAccountId),
		uniqueIndex("ad_campaigns_account_platform_id_idx").on(
			table.adAccountId,
			table.platformCampaignId,
		),
		index("ad_campaigns_org_status_idx").on(table.organizationId, table.status),
	],
);

/** Individual ad units within campaigns */
export const ads = pgTable(
	"ads",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ad_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		campaignId: text("campaign_id")
			.notNull()
			.references(() => adCampaigns.id, { onDelete: "cascade" }),
		adAccountId: text("ad_account_id")
			.notNull()
			.references(() => adAccounts.id, { onDelete: "cascade" }),
		platform: adPlatformEnum("platform").notNull(),
		platformAdId: text("platform_ad_id"),
		name: text("name").notNull(),
		status: adStatusEnum("status").notNull().default("draft"),
		// Creative
		headline: text("headline"),
		body: text("body"),
		callToAction: text("call_to_action"),
		linkUrl: text("link_url"),
		imageUrl: text("image_url"),
		videoUrl: text("video_url"),
		// Boost mode: references a published post.
		// A boost references either a RelayAPI post target (boostPostTargetId) or
		// a natively-published post synced into external_posts (boostExternalPostId).
		boostPostTargetId: text("boost_post_target_id").references(
			() => postTargets.id,
			{ onDelete: "set null" },
		),
		boostExternalPostId: text("boost_external_post_id").references(
			() => externalPosts.id,
			{ onDelete: "set null" },
		),
		boostPlatformPostId: text("boost_platform_post_id"),
		// Targeting (JSONB for cross-platform flexibility)
		targeting: jsonb("targeting"),
		// Budget
		dailyBudgetCents: integer("daily_budget_cents"),
		lifetimeBudgetCents: integer("lifetime_budget_cents"),
		startDate: timestamp("start_date", { withTimezone: true }),
		endDate: timestamp("end_date", { withTimezone: true }),
		durationDays: integer("duration_days"),
		isExternal: boolean("is_external").notNull().default(false),
		metadata: jsonb("metadata"),
		// Metrics are a separate read-only poll from the account listing above.
		// Keeping per-ad due state prevents one large account from replaying every
		// metrics read when a later database/log write fails.
		metricsUpdatedAt: timestamp("metrics_updated_at", {
			withTimezone: true,
		}),
		metricsNextPollAt: timestamp("metrics_next_poll_at", {
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
		metricsPollGeneration: integer("metrics_poll_generation")
			.notNull()
			.default(0),
		metricsPollLeaseExpiresAt: timestamp("metrics_poll_lease_expires_at", {
			withTimezone: true,
		}),
		metricsPollStartedAt: timestamp("metrics_poll_started_at", {
			withTimezone: true,
		}),
		metricsPollAttempts: integer("metrics_poll_attempts").notNull().default(0),
		metricsPollLastError: text("metrics_poll_last_error"),
		metricsPollLastErrorClass: text("metrics_poll_last_error_class"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("ads_id_org_uniq").on(table.id, table.organizationId),
		unique("ads_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		unique("ads_id_account_org_scope_platform_uniq").on(
			table.id,
			table.adAccountId,
			table.organizationId,
			table.scopeKey,
			table.platform,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ads_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.adAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				adAccounts.id,
				adAccounts.organizationId,
				adAccounts.scopeKey,
				adAccounts.platform,
			],
			name: "ads_account_org_scope_platform_fk",
		}),
		foreignKey({
			columns: [
				table.campaignId,
				table.adAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				adCampaigns.id,
				adCampaigns.adAccountId,
				adCampaigns.organizationId,
				adCampaigns.scopeKey,
				adCampaigns.platform,
			],
			name: "ads_campaign_account_org_scope_platform_fk",
		}),
		check(
			"ads_budget_duration_check",
			sql`(${table.dailyBudgetCents} IS NULL OR ${table.dailyBudgetCents} > 0)
				AND (${table.lifetimeBudgetCents} IS NULL OR ${table.lifetimeBudgetCents} > 0)
				AND (${table.durationDays} IS NULL OR ${table.durationDays} > 0)`,
		),
		check(
			"ads_date_order_check",
			sql`${table.endDate} IS NULL OR ${table.startDate} IS NULL OR ${table.endDate} >= ${table.startDate}`,
		),
		index("ads_org_idx").on(table.organizationId),
		index("ads_workspace_idx").on(table.workspaceId),
		index("ads_campaign_idx").on(table.campaignId),
		index("ads_org_campaign_idx").on(table.organizationId, table.campaignId),
		uniqueIndex("ads_account_platform_ad_id_idx").on(
			table.adAccountId,
			table.platformAdId,
		),
		index("ads_org_status_idx").on(table.organizationId, table.status),
		index("ads_boost_post_idx").on(table.boostPostTargetId),
		index("ads_boost_external_post_idx").on(table.boostExternalPostId),
		index("ads_metrics_poll_due_idx").on(
			table.metricsNextPollAt,
			table.metricsPollLeaseExpiresAt,
			table.organizationId,
			table.id,
		),
		check(
			"ads_metrics_poll_counters_check",
			sql`${table.metricsPollGeneration} >= 0 AND ${table.metricsPollAttempts} >= 0`,
		),
		check(
			"ads_metrics_poll_claim_check",
			sql`(${table.metricsPollLeaseExpiresAt} IS NULL
					AND ${table.metricsPollStartedAt} IS NULL)
				OR (${table.metricsPollLeaseExpiresAt} IS NOT NULL
					AND (${table.metricsPollStartedAt} IS NULL
						OR ${table.metricsPollStartedAt} <= ${table.metricsPollLeaseExpiresAt}))`,
		),
		check(
			"ads_metrics_poll_error_class_check",
			sql`${table.metricsPollLastErrorClass} IS NULL
				OR ${table.metricsPollLastErrorClass} IN ('transient', 'rate_limited', 'permanent')`,
		),
	],
);

/**
 * Durable pre-provider ledger for operations that can create active paid
 * objects. The request and correlation marker are committed before the first
 * platform call; unknown outcomes are reconciled, never blindly replayed.
 */
export const adCreationOperations = pgTable(
	"ad_creation_operations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("adop_")),
		organizationId: text("organization_id").notNull(),
		usageReservationId: text("usage_reservation_id"),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		adAccountId: text("ad_account_id").notNull(),
		kind: text("kind", {
			enum: [...AD_CREATION_OPERATION_KINDS],
		}).notNull(),
		operationKeyHash: varchar("operation_key_hash", { length: 64 }).notNull(),
		requestHash: varchar("request_hash", { length: 64 }).notNull(),
		requestPayload: jsonb("request_payload").notNull(),
		authorityKeyId: text("authority_key_id").notNull(),
		authorityPrincipalId: text("authority_principal_id").notNull(),
		authorityPrincipalType: text("authority_principal_type", {
			enum: ["service", "dashboard_user"],
		}).notNull(),
		authorityUserId: text("authority_user_id"),
		authorityMemberId: text("authority_member_id"),
		authoritySessionId: text("authority_session_id"),
		authorityWorkspaceId: text("authority_workspace_id"),
		authorityRequiresAllWorkspaceScope: boolean(
			"authority_requires_all_workspace_scope",
		).notNull(),
		authorityCredentialVersion: text("authority_credential_version").notNull(),
		authorityAdmittedAt: timestamp("authority_admitted_at", {
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
		authorityRevision: integer("authority_revision").notNull().default(1),
		authorityRevokedAt: timestamp("authority_revoked_at", {
			withTimezone: true,
		}),
		status: text("status", {
			enum: [
				"pending",
				"processing",
				"request_may_have_been_sent",
				"unknown",
				"reconciling",
				"revocation_pending",
				"manual_review",
				"completed",
				"failed",
				"cancelled",
			],
		})
			.notNull()
			.default("pending"),
		phase: text("phase", {
			enum: ["campaign", "ad_set", "creative", "ad", "activation", "completed"],
		})
			.notNull()
			.default("campaign"),
		platform: adPlatformEnum("platform").notNull(),
		platformCampaignId: text("platform_campaign_id"),
		platformAdSetId: text("platform_ad_set_id"),
		platformCreativeId: text("platform_creative_id"),
		platformAdId: text("platform_ad_id"),
		localCampaignId: text("local_campaign_id").references(
			() => adCampaigns.id,
			{ onDelete: "set null" },
		),
		localAdId: text("local_ad_id").references(() => ads.id, {
			onDelete: "set null",
		}),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("ad_creation_operations_org_key_uniq").on(
			table.organizationId,
			table.kind,
			table.operationKeyHash,
		),
		foreignKey({
			columns: [table.usageReservationId, table.organizationId],
			foreignColumns: [usageReservations.id, usageReservations.organizationId],
			name: "ad_creation_operations_usage_reservation_org_fk",
		})
			.onUpdate("no action")
			.onDelete("restrict"),
		uniqueIndex("ad_creation_operations_usage_reservation_uniq")
			.on(table.usageReservationId)
			.where(sql`${table.usageReservationId} IS NOT NULL`),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ad_creation_operations_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.adAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				adAccounts.id,
				adAccounts.organizationId,
				adAccounts.scopeKey,
				adAccounts.platform,
			],
			name: "ad_creation_operations_account_org_scope_platform_fk",
		}),
		foreignKey({
			columns: [
				table.localCampaignId,
				table.adAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				adCampaigns.id,
				adCampaigns.adAccountId,
				adCampaigns.organizationId,
				adCampaigns.scopeKey,
				adCampaigns.platform,
			],
			name: "ad_creation_operations_campaign_account_scope_platform_fk",
		}),
		foreignKey({
			columns: [
				table.localAdId,
				table.adAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				ads.id,
				ads.adAccountId,
				ads.organizationId,
				ads.scopeKey,
				ads.platform,
			],
			name: "ad_creation_operations_ad_account_scope_platform_fk",
		}),
		check(
			"ad_creation_operations_kind_check",
			sql`${table.kind} IN ('create_campaign', 'create_ad', 'boost_post')`,
		),
		check(
			"ad_creation_operations_status_check",
			sql`${table.status} IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'reconciling', 'revocation_pending', 'manual_review', 'completed', 'failed', 'cancelled')`,
		),
		check(
			"ad_creation_operations_authority_check",
			sql`${table.authorityPrincipalType} IN ('service', 'dashboard_user')
					AND (${table.authorityPrincipalType} = 'dashboard_user') = (${table.authorityUserId} IS NOT NULL)
					AND (${table.authorityPrincipalType} = 'dashboard_user') = (${table.authorityMemberId} IS NOT NULL)
					AND (${table.authorityPrincipalType} = 'dashboard_user') = (${table.authoritySessionId} IS NOT NULL)
				AND (${table.authorityWorkspaceId} IS NULL) = ${table.authorityRequiresAllWorkspaceScope}
				AND ${table.authorityRevision} > 0
				AND (${table.status} IN ('revocation_pending', 'cancelled')) = (${table.authorityRevokedAt} IS NOT NULL)`,
		),
		check(
			"ad_creation_operations_phase_check",
			sql`${table.phase} IN ('campaign', 'ad_set', 'creative', 'ad', 'activation', 'completed')`,
		),
		check(
			"ad_creation_operations_counters_nonnegative_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"ad_creation_operations_lease_state_check",
			sql`(${table.status} IN ('processing', 'request_may_have_been_sent', 'reconciling')
					AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} NOT IN ('processing', 'request_may_have_been_sent', 'reconciling')
					AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"ad_creation_operations_request_boundary_check",
			sql`${table.status} <> 'request_may_have_been_sent'
				OR ${table.requestMayHaveBeenSentAt} IS NOT NULL`,
		),
		check(
			"ad_creation_operations_completion_check",
			sql`(${table.status} = 'completed'
					AND ${table.phase} = 'completed'
					AND ${table.completedAt} IS NOT NULL)
				OR (${table.status} <> 'completed'
					AND ${table.phase} <> 'completed'
					AND ${table.completedAt} IS NULL)`,
		),
		check(
			"ad_creation_operations_timestamp_order_check",
			sql`${table.authorityAdmittedAt} <= ${table.createdAt}
				AND ${table.updatedAt} >= ${table.createdAt}
				AND (${table.authorityRevokedAt} IS NULL OR ${table.authorityRevokedAt} >= ${table.authorityAdmittedAt})
				AND (${table.requestMayHaveBeenSentAt} IS NULL OR ${table.requestMayHaveBeenSentAt} >= ${table.createdAt})
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
		),
		index("ad_creation_operations_due_idx").on(
			table.status,
			table.nextAttemptAt,
			table.leaseExpiresAt,
		),
		index("ad_creation_operations_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("ad_creation_operations_retention_idx")
			.on(sql`COALESCE(${table.completedAt}, ${table.updatedAt})`, table.id)
			.where(
				sql`${table.status} IN ('completed', 'failed', 'unknown', 'revocation_pending', 'manual_review', 'cancelled')`,
			),
	],
);

/**
 * Durable authority for mutations of existing paid provider objects. Local ad
 * state is projected only after a confirmed provider response (or an explicit
 * operator decision); ambiguous responses remain fenced and discoverable.
 */
export const adMutationOperations = pgTable(
	"ad_mutation_operations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("admut_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		usageReservationId: text("usage_reservation_id"),
		targetType: text("target_type", {
			enum: ["ad", "campaign"],
		}).notNull(),
		targetId: text("target_id").notNull(),
		kind: text("kind", {
			enum: ["update_ad", "cancel_ad", "update_campaign", "cancel_campaign"],
		}).notNull(),
		platform: adPlatformEnum("platform").notNull(),
		operationKeyHash: varchar("operation_key_hash", { length: 64 }).notNull(),
		requestHash: varchar("request_hash", { length: 64 }).notNull(),
		requestPayload: jsonb("request_payload")
			.$type<Record<string, unknown>>()
			.notNull(),
		requiresLiveAuthority: boolean("requires_live_authority")
			.notNull()
			.default(true),
		authorityKeyId: text("authority_key_id").notNull(),
		authorityPrincipalId: text("authority_principal_id").notNull(),
		authorityPrincipalType: text("authority_principal_type", {
			enum: ["service", "dashboard_user"],
		}).notNull(),
		authorityUserId: text("authority_user_id"),
		authorityMemberId: text("authority_member_id"),
		authoritySessionId: text("authority_session_id"),
		authorityWorkspaceId: text("authority_workspace_id"),
		authorityRequiresAllWorkspaceScope: boolean(
			"authority_requires_all_workspace_scope",
		).notNull(),
		authorityCredentialVersion: text("authority_credential_version").notNull(),
		authorityAdmittedAt: timestamp("authority_admitted_at", {
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
		authorityRevision: integer("authority_revision").notNull().default(1),
		authorityRevokedAt: timestamp("authority_revoked_at", {
			withTimezone: true,
		}),
		status: text("status", {
			enum: [
				"pending",
				"processing",
				"request_may_have_been_sent",
				"unknown",
				"reconciling",
				"revocation_pending",
				"manual_review",
				"completed",
				"failed",
				"cancelled",
			],
		})
			.notNull()
			.default("pending"),
		phase: text("phase", {
			enum: ["provider", "projection", "completed"],
		})
			.notNull()
			.default("provider"),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		providerConfirmedAt: timestamp("provider_confirmed_at", {
			withTimezone: true,
		}),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("ad_mutation_operations_org_key_uniq").on(
			table.organizationId,
			table.targetType,
			table.targetId,
			table.operationKeyHash,
		),
		uniqueIndex("ad_mutation_operations_target_active_uniq")
			.on(table.organizationId, table.targetType, table.targetId)
			.where(
				sql`${table.status} IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'reconciling', 'revocation_pending', 'manual_review')`,
			),
		foreignKey({
			columns: [table.usageReservationId, table.organizationId],
			foreignColumns: [usageReservations.id, usageReservations.organizationId],
			name: "ad_mutation_operations_usage_reservation_org_fk",
		})
			.onUpdate("no action")
			.onDelete("restrict"),
		uniqueIndex("ad_mutation_operations_usage_reservation_uniq")
			.on(table.usageReservationId)
			.where(sql`${table.usageReservationId} IS NOT NULL`),
		check(
			"ad_mutation_operations_target_check",
			sql`${table.targetType} IN ('ad', 'campaign')`,
		),
		check(
			"ad_mutation_operations_kind_check",
			sql`${table.kind} IN ('update_ad', 'cancel_ad', 'update_campaign', 'cancel_campaign')`,
		),
		check(
			"ad_mutation_operations_target_kind_check",
			sql`(${table.targetType} = 'ad' AND ${table.kind} IN ('update_ad', 'cancel_ad'))
				OR (${table.targetType} = 'campaign' AND ${table.kind} IN ('update_campaign', 'cancel_campaign'))`,
		),
		check(
			"ad_mutation_operations_status_check",
			sql`${table.status} IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'reconciling', 'revocation_pending', 'manual_review', 'completed', 'failed', 'cancelled')`,
		),
		check(
			"ad_mutation_operations_authority_check",
			sql`${table.authorityPrincipalType} IN ('service', 'dashboard_user')
					AND (${table.authorityPrincipalType} = 'dashboard_user') = (${table.authorityUserId} IS NOT NULL)
					AND (${table.authorityPrincipalType} = 'dashboard_user') = (${table.authorityMemberId} IS NOT NULL)
					AND (${table.authorityPrincipalType} = 'dashboard_user') = (${table.authoritySessionId} IS NOT NULL)
				AND (${table.authorityWorkspaceId} IS NULL) = ${table.authorityRequiresAllWorkspaceScope}
				AND ${table.authorityRevision} > 0
				AND (${table.status} IN ('revocation_pending', 'cancelled')) = (${table.authorityRevokedAt} IS NOT NULL)`,
		),
		check(
			"ad_mutation_operations_phase_check",
			sql`${table.phase} IN ('provider', 'projection', 'completed')`,
		),
		check(
			"ad_mutation_operations_counters_check",
			sql`${table.leaseToken} >= 0 AND ${table.attempts} >= 0`,
		),
		check(
			"ad_mutation_operations_lease_check",
			sql`(${table.status} IN ('processing', 'request_may_have_been_sent', 'reconciling')
					AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} NOT IN ('processing', 'request_may_have_been_sent', 'reconciling')
					AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"ad_mutation_operations_boundary_check",
			sql`${table.status} <> 'request_may_have_been_sent'
				OR ${table.requestMayHaveBeenSentAt} IS NOT NULL`,
		),
		check(
			"ad_mutation_operations_projection_check",
			sql`${table.phase} = 'provider'
				OR ${table.providerConfirmedAt} IS NOT NULL`,
		),
		check(
			"ad_mutation_operations_completion_check",
			sql`(${table.status} = 'completed'
					AND ${table.phase} = 'completed'
					AND ${table.completedAt} IS NOT NULL)
				OR (${table.status} <> 'completed'
					AND ${table.phase} <> 'completed'
					AND ${table.completedAt} IS NULL)`,
		),
		check(
			"ad_mutation_operations_timestamp_check",
			sql`${table.authorityAdmittedAt} <= ${table.createdAt}
				AND ${table.updatedAt} >= ${table.createdAt}
				AND (${table.authorityRevokedAt} IS NULL OR ${table.authorityRevokedAt} >= ${table.authorityAdmittedAt})
				AND (${table.requestMayHaveBeenSentAt} IS NULL OR ${table.requestMayHaveBeenSentAt} >= ${table.createdAt})
				AND (${table.providerConfirmedAt} IS NULL OR ${table.providerConfirmedAt} >= ${table.createdAt})
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
		),
		index("ad_mutation_operations_due_idx").on(
			table.status,
			table.nextAttemptAt,
			table.leaseExpiresAt,
		),
		index("ad_mutation_operations_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("ad_mutation_operations_retention_idx")
			.on(sql`COALESCE(${table.completedAt}, ${table.updatedAt})`, table.id)
			.where(
				sql`${table.status} IN ('completed', 'failed', 'unknown', 'revocation_pending', 'manual_review', 'cancelled')`,
			),
	],
);

/** Daily time-series metrics for each ad */
export const adMetrics = pgTable(
	"ad_metrics",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("adm_")),
		adId: text("ad_id")
			.notNull()
			.references(() => ads.id, { onDelete: "cascade" }),
		date: timestamp("date", { withTimezone: true }).notNull(),
		impressions: integer("impressions").default(0),
		reach: integer("reach").default(0),
		clicks: integer("clicks").default(0),
		spendCents: integer("spend_cents").default(0),
		conversions: integer("conversions").default(0),
		videoViews: integer("video_views").default(0),
		engagement: integer("engagement").default(0),
		ctr: integer("ctr"), // basis points (0.0123 = 123)
		cpcCents: integer("cpc_cents"),
		cpmCents: integer("cpm_cents"),
		demographics: jsonb("demographics"),
		collectedAt: timestamp("collected_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"ad_metrics_values_nonnegative_check",
			sql`(${table.impressions} IS NULL OR ${table.impressions} >= 0)
				AND (${table.reach} IS NULL OR ${table.reach} >= 0)
				AND (${table.clicks} IS NULL OR ${table.clicks} >= 0)
				AND (${table.spendCents} IS NULL OR ${table.spendCents} >= 0)
				AND (${table.conversions} IS NULL OR ${table.conversions} >= 0)
				AND (${table.videoViews} IS NULL OR ${table.videoViews} >= 0)
				AND (${table.engagement} IS NULL OR ${table.engagement} >= 0)
				AND (${table.ctr} IS NULL OR ${table.ctr} >= 0)
				AND (${table.cpcCents} IS NULL OR ${table.cpcCents} >= 0)
				AND (${table.cpmCents} IS NULL OR ${table.cpmCents} >= 0)`,
		),
		uniqueIndex("ad_metrics_ad_date_idx").on(table.adId, table.date),
		index("ad_metrics_ad_idx").on(table.adId),
		index("ad_metrics_retention_idx").on(table.date, table.id),
	],
);

/** Custom audiences for targeting */
export const adAudiences = pgTable(
	"ad_audiences",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("aud_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		adAccountId: text("ad_account_id").notNull(),
		platform: adPlatformEnum("platform").notNull(),
		platformAudienceId: text("platform_audience_id"),
		name: text("name").notNull(),
		type: audienceTypeEnum("type").notNull(),
		description: text("description"),
		size: integer("size"),
		sourceAudienceId: text("source_audience_id"),
		lookalikeSpec: jsonb("lookalike_spec"),
		retargetingRule: jsonb("retargeting_rule"),
		status: text("status").default("pending"),
		metadata: jsonb("metadata"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("ad_audiences_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ad_audiences_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.adAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				adAccounts.id,
				adAccounts.organizationId,
				adAccounts.scopeKey,
				adAccounts.platform,
			],
			name: "ad_audiences_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		index("ad_audiences_org_idx").on(table.organizationId),
		index("ad_audiences_workspace_idx").on(table.workspaceId),
		index("ad_audiences_ad_account_idx").on(table.adAccountId),
		index("ad_audiences_platform_id_idx").on(table.platformAudienceId),
		// Conflict target for upserting audiences discovered from the platform.
		// platformAudienceId is nullable; Postgres treats NULLs as distinct, so
		// RelayAPI-created rows still pending a platform id never collide.
		uniqueIndex("ad_audiences_account_platform_audience_idx").on(
			table.adAccountId,
			table.platformAudienceId,
		),
		check(
			"ad_audiences_size_nonnegative_check",
			sql`${table.size} IS NULL OR ${table.size} >= 0`,
		),
	],
);

/** Hashed user data for customer list audiences */
export const adAudienceUsers = pgTable(
	"ad_audience_users",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("aau_")),
		audienceId: text("audience_id")
			.notNull()
			.references(() => adAudiences.id, { onDelete: "cascade" }),
		emailHash: text("email_hash"),
		phoneHash: text("phone_hash"),
		addedAt: timestamp("added_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"ad_audience_users_identifier_present_check",
			sql`${table.emailHash} IS NOT NULL OR ${table.phoneHash} IS NOT NULL`,
		),
		check(
			"ad_audience_users_email_hash_check",
			sql`${table.emailHash} IS NULL OR ${table.emailHash} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"ad_audience_users_phone_hash_check",
			sql`${table.phoneHash} IS NULL OR ${table.phoneHash} ~ '^[0-9a-f]{64}$'`,
		),
		index("ad_audience_users_audience_idx").on(table.audienceId),
		uniqueIndex("ad_audience_users_email_uniq")
			.on(table.audienceId, table.emailHash)
			.where(sql`${table.emailHash} IS NOT NULL`),
		uniqueIndex("ad_audience_users_phone_uniq")
			.on(table.audienceId, table.phoneHash)
			.where(sql`${table.phoneHash} IS NOT NULL`),
	],
);

/** Provider lead-form metadata. Lead payloads are stored separately and encrypted. */
export const adLeadForms = pgTable(
	"ad_lead_forms",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("adform_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		adAccountId: text("ad_account_id").notNull(),
		platform: adPlatformEnum("platform").notNull(),
		providerFormId: text("provider_form_id").notNull(),
		name: text("name"),
		status: text("status", {
			enum: ["draft", "active", "archived", "unknown"],
		})
			.notNull()
			.default("unknown"),
		configuration: jsonb("configuration")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("ad_lead_forms_id_org_scope_account_platform_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
			table.adAccountId,
			table.platform,
		),
		unique("ad_lead_forms_org_account_provider_uniq").on(
			table.organizationId,
			table.adAccountId,
			table.providerFormId,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ad_lead_forms_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.adAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				adAccounts.id,
				adAccounts.organizationId,
				adAccounts.scopeKey,
				adAccounts.platform,
			],
			name: "ad_lead_forms_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		check(
			"ad_lead_forms_status_check",
			sql`${table.status} IN ('draft', 'active', 'archived', 'unknown')`,
		),
		check(
			"ad_lead_forms_configuration_check",
			sql`jsonb_typeof(${table.configuration}) = 'object'`,
		),
		index("ad_lead_forms_account_created_idx").on(
			table.adAccountId,
			table.createdAt,
			table.id,
		),
	],
);

/** Encrypted, short-retention lead inbox. */
export const adLeads = pgTable(
	"ad_leads",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("adlead_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		adAccountId: text("ad_account_id").notNull(),
		platform: adPlatformEnum("platform").notNull(),
		leadFormId: text("lead_form_id"),
		providerLeadId: text("provider_lead_id").notNull(),
		status: text("status", { enum: ["new", "promoted", "dismissed"] })
			.notNull()
			.default("new"),
		payloadCiphertext: text("payload_ciphertext").notNull(),
		contactId: text("contact_id"),
		providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("ad_leads_org_account_provider_uniq").on(
			table.organizationId,
			table.adAccountId,
			table.providerLeadId,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ad_leads_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.adAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				adAccounts.id,
				adAccounts.organizationId,
				adAccounts.scopeKey,
				adAccounts.platform,
			],
			name: "ad_leads_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [
				table.leadFormId,
				table.organizationId,
				table.scopeKey,
				table.adAccountId,
				table.platform,
			],
			foreignColumns: [
				adLeadForms.id,
				adLeadForms.organizationId,
				adLeadForms.scopeKey,
				adLeadForms.adAccountId,
				adLeadForms.platform,
			],
			name: "ad_leads_form_org_scope_account_platform_fk",
		}).onDelete("restrict"),
		foreignKey({
			columns: [table.contactId, table.organizationId, table.scopeKey],
			foreignColumns: [contacts.id, contacts.organizationId, contacts.scopeKey],
			name: "ad_leads_contact_org_scope_fk",
		}).onDelete("restrict"),
		check(
			"ad_leads_status_check",
			sql`${table.status} IN ('new', 'promoted', 'dismissed')`,
		),
		check(
			"ad_leads_ciphertext_check",
			sql`${table.payloadCiphertext} LIKE 'enc:v2:%'`,
		),
		check(
			"ad_leads_retention_check",
			sql`${table.expiresAt} > ${table.createdAt}
				AND ${table.expiresAt} <= ${table.createdAt} + interval '30 days'`,
		),
		check(
			"ad_leads_promotion_check",
			sql`(${table.status} = 'promoted') = (${table.contactId} IS NOT NULL)`,
		),
		index("ad_leads_account_created_idx").on(
			table.adAccountId,
			table.createdAt,
			table.id,
		),
		index("ad_leads_expiry_idx").on(table.expiresAt, table.id),
	],
);

/** Tenant-scoped destination and mapping for server-side conversion delivery. */
export const adConversionRules = pgTable(
	"ad_conversion_rules",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("adcr_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		adAccountId: text("ad_account_id").notNull(),
		platform: adPlatformEnum("platform").notNull(),
		name: text("name").notNull(),
		eventName: text("event_name").notNull(),
		providerDestinationId: text("provider_destination_id").notNull(),
		configuration: jsonb("configuration")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		enabled: boolean("enabled").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("ad_conversion_rules_id_org_scope_account_platform_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
			table.adAccountId,
			table.platform,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ad_conversion_rules_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.adAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				adAccounts.id,
				adAccounts.organizationId,
				adAccounts.scopeKey,
				adAccounts.platform,
			],
			name: "ad_conversion_rules_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		check(
			"ad_conversion_rules_configuration_check",
			sql`jsonb_typeof(${table.configuration}) = 'object'`,
		),
		index("ad_conversion_rules_account_enabled_idx").on(
			table.adAccountId,
			table.enabled,
		),
	],
);

/** Durable, encrypted conversion-delivery outbox. */
export const adConversionEvents = pgTable(
	"ad_conversion_events",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("adconv_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		adAccountId: text("ad_account_id").notNull(),
		platform: adPlatformEnum("platform").notNull(),
		conversionRuleId: text("conversion_rule_id").notNull(),
		eventId: text("event_id").notNull(),
		operationKeyHash: varchar("operation_key_hash", { length: 64 }).notNull(),
		requestHash: varchar("request_hash", { length: 64 }).notNull(),
		payloadCiphertext: text("payload_ciphertext"),
		status: text("status", {
			enum: [
				"pending",
				"processing",
				"request_may_have_been_sent",
				"unknown",
				"completed",
				"failed",
				"cancelled",
			],
		})
			.notNull()
			.default("pending"),
		providerEventId: text("provider_event_id"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", {
			withTimezone: true,
		}).defaultNow(),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		unique("ad_conversion_events_org_rule_operation_uniq").on(
			table.organizationId,
			table.conversionRuleId,
			table.operationKeyHash,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ad_conversion_events_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.conversionRuleId,
				table.organizationId,
				table.scopeKey,
				table.adAccountId,
				table.platform,
			],
			foreignColumns: [
				adConversionRules.id,
				adConversionRules.organizationId,
				adConversionRules.scopeKey,
				adConversionRules.adAccountId,
				adConversionRules.platform,
			],
			name: "ad_conversion_events_rule_org_scope_account_platform_fk",
		}).onDelete("cascade"),
		check(
			"ad_conversion_events_status_check",
			sql`${table.status} IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'completed', 'failed', 'cancelled')`,
		),
		check(
			"ad_conversion_events_hash_check",
			sql`${table.operationKeyHash} ~ '^[0-9a-f]{64}$'
				AND ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"ad_conversion_events_ciphertext_check",
			sql`${table.payloadCiphertext} IS NULL OR ${table.payloadCiphertext} LIKE 'enc:v2:%'`,
		),
		check(
			"ad_conversion_events_payload_lifecycle_check",
			sql`${table.status} IN ('completed', 'failed', 'cancelled')
				OR ${table.payloadCiphertext} IS NOT NULL`,
		),
		check(
			"ad_conversion_events_counters_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"ad_conversion_events_lease_check",
			sql`(${table.status} IN ('processing', 'request_may_have_been_sent')) = (${table.leaseExpiresAt} IS NOT NULL)`,
		),
		check(
			"ad_conversion_events_request_boundary_check",
			sql`${table.status} <> 'request_may_have_been_sent'
				OR ${table.requestMayHaveBeenSentAt} IS NOT NULL`,
		),
		check(
			"ad_conversion_events_completion_check",
			sql`(${table.status} IN ('completed', 'failed', 'cancelled')) = (${table.completedAt} IS NOT NULL)`,
		),
		uniqueIndex("ad_conversion_events_rule_active_uniq")
			.on(table.organizationId, table.conversionRuleId, table.eventId)
			.where(
				sql`${table.status} IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown')`,
			),
		index("ad_conversion_events_due_idx").on(
			table.status,
			table.nextAttemptAt,
			table.leaseExpiresAt,
			table.id,
		),
	],
);

/** Resolve the later-initialized composite self-reference without widening table inference. */
function adAdvancedResourceParentColumns(): [
	AnyPgColumn,
	AnyPgColumn,
	AnyPgColumn,
	AnyPgColumn,
	AnyPgColumn,
	AnyPgColumn,
] {
	return [
		adAdvancedResources.id,
		adAdvancedResources.organizationId,
		adAdvancedResources.scopeKey,
		adAdvancedResources.adAccountId,
		adAdvancedResources.platform,
		adAdvancedResources.kind,
	];
}

/** Linked provider assets, catalogs, product sets, and messaging experiences. */
export const adAdvancedResources = pgTable(
	"ad_advanced_resources",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		adAccountId: text("ad_account_id").notNull(),
		platform: adPlatformEnum("platform").notNull(),
		kind: text("kind", {
			enum: [...AD_ADVANCED_RESOURCE_KINDS],
		}).notNull(),
		providerResourceId: text("provider_resource_id"),
		parentId: text("parent_id"),
		// A non-null parent is valid only for product sets, and the generated
		// discriminator makes their composite FK target a catalog in the same
		// tenant/account/platform rather than merely any advanced resource ID.
		parentResourceClass: text("parent_resource_class").generatedAlwaysAs(
			sql`CASE WHEN parent_id IS NULL THEN NULL ELSE 'catalog' END`,
		),
		name: text("name"),
		status: text("status", {
			enum: ["linked", "unavailable", "archived"],
		})
			.notNull()
			.default("linked"),
		configuration: jsonb("configuration")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("ad_advanced_resources_id_org_scope_account_platform_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
			table.adAccountId,
			table.platform,
		),
		unique("ad_advanced_resources_parent_target_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
			table.adAccountId,
			table.platform,
			table.kind,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ad_advanced_resources_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.adAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				adAccounts.id,
				adAccounts.organizationId,
				adAccounts.scopeKey,
				adAccounts.platform,
			],
			name: "ad_advanced_resources_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [
				table.parentId,
				table.organizationId,
				table.scopeKey,
				table.adAccountId,
				table.platform,
				table.parentResourceClass,
			],
			foreignColumns: adAdvancedResourceParentColumns(),
			name: "ad_advanced_resources_parent_org_scope_account_platform_kind_fk",
		}).onDelete("restrict"),
		check(
			"ad_advanced_resources_kind_check",
			sql`${table.kind} IN (${sql.join(
				AD_ADVANCED_RESOURCE_KINDS.map((value) => ddlTextLiteral(value)),
				sql`, `,
			)})`,
		),
		check(
			"ad_advanced_resources_status_check",
			sql`${table.status} IN ('linked', 'unavailable', 'archived')`,
		),
		check(
			"ad_advanced_resources_parent_check",
			sql`(${table.kind} = 'product_set') = (${table.parentId} IS NOT NULL)`,
		),
		check(
			"ad_advanced_resources_configuration_check",
			sql`jsonb_typeof(${table.configuration}) = 'object'`,
		),
		uniqueIndex("ad_advanced_resources_provider_uniq")
			.on(table.adAccountId, table.kind, table.providerResourceId)
			.where(sql`${table.providerResourceId} IS NOT NULL`),
		index("ad_advanced_resources_account_kind_idx").on(
			table.adAccountId,
			table.kind,
			table.createdAt,
		),
	],
);

/** Durable provider reporting job with bounded normalized results. */
export const adReportJobs = pgTable(
	"ad_report_jobs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("adrep_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		adAccountId: text("ad_account_id").notNull(),
		platform: adPlatformEnum("platform").notNull(),
		operationKeyHash: varchar("operation_key_hash", { length: 64 }).notNull(),
		requestHash: varchar("request_hash", { length: 64 }).notNull(),
		requestPayload: jsonb("request_payload")
			.$type<Record<string, unknown>>()
			.notNull(),
		status: text("status", {
			enum: [
				"pending",
				"submitting",
				"provider_pending",
				"downloading",
				"completed",
				"failed",
				"unknown",
				"cancelled",
			],
		})
			.notNull()
			.default("pending"),
		providerJobId: text("provider_job_id"),
		resultObjectKey: text("result_object_key"),
		rowCount: integer("row_count"),
		resultExpiresAt: timestamp("result_expires_at", { withTimezone: true }),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", {
			withTimezone: true,
		}).defaultNow(),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		unique("ad_report_jobs_id_org_uniq").on(table.id, table.organizationId),
		unique("ad_report_jobs_org_operation_uniq").on(
			table.organizationId,
			table.operationKeyHash,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ad_report_jobs_workspace_org_fk",
		}),
		foreignKey({
			columns: [
				table.adAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				adAccounts.id,
				adAccounts.organizationId,
				adAccounts.scopeKey,
				adAccounts.platform,
			],
			name: "ad_report_jobs_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		check(
			"ad_report_jobs_status_check",
			sql`${table.status} IN ('pending', 'submitting', 'provider_pending', 'downloading', 'completed', 'failed', 'unknown', 'cancelled')`,
		),
		check(
			"ad_report_jobs_hash_check",
			sql`${table.operationKeyHash} ~ '^[0-9a-f]{64}$'
				AND ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"ad_report_jobs_request_check",
			sql`jsonb_typeof(${table.requestPayload}) = 'object'`,
		),
		check(
			"ad_report_jobs_counters_check",
			sql`${table.attempts} >= 0
				AND ${table.leaseToken} >= 0
				AND (${table.rowCount} IS NULL OR ${table.rowCount} >= 0)`,
		),
		check(
			"ad_report_jobs_request_boundary_check",
			sql`${table.status} <> 'submitting'
				OR ${table.requestMayHaveBeenSentAt} IS NOT NULL`,
		),
		check(
			"ad_report_jobs_completion_check",
			sql`(${table.status} IN ('completed', 'failed', 'cancelled')) = (${table.completedAt} IS NOT NULL)`,
		),
		index("ad_report_jobs_due_idx").on(
			table.status,
			table.nextAttemptAt,
			table.leaseExpiresAt,
			table.id,
		),
		index("ad_report_jobs_result_expiry_idx").on(
			table.resultExpiresAt,
			table.id,
		),
		index("ad_report_jobs_terminal_retention_idx").on(
			table.status,
			table.updatedAt,
			table.id,
		),
	],
);

/** Canonical rows projected from provider-specific report output. */
export const adReportRows = pgTable(
	"ad_report_rows",
	{
		organizationId: text("organization_id").notNull(),
		reportJobId: text("report_job_id").notNull(),
		rowNumber: integer("row_number").notNull(),
		dimensions: jsonb("dimensions")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		metrics: jsonb("metrics")
			.$type<Record<string, string | number | null>>()
			.notNull()
			.default({}),
	},
	(table) => [
		primaryKey({ columns: [table.reportJobId, table.rowNumber] }),
		foreignKey({
			columns: [table.reportJobId, table.organizationId],
			foreignColumns: [adReportJobs.id, adReportJobs.organizationId],
			name: "ad_report_rows_job_org_fk",
		}).onDelete("cascade"),
		check("ad_report_rows_number_check", sql`${table.rowNumber} > 0`),
		check(
			"ad_report_rows_payload_check",
			sql`jsonb_typeof(${table.dimensions}) = 'object'
				AND jsonb_typeof(${table.metrics}) = 'object'`,
		),
	],
);

/** Tracks external ad sync runs */
export const adSyncLogs = pgTable(
	"ad_sync_logs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("aslog_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		adAccountId: text("ad_account_id").notNull(),
		platform: adPlatformEnum("platform").notNull(),
		syncType: text("sync_type", { enum: [...AD_SYNC_TYPES] }).notNull(),
		adsCreated: integer("ads_created").notNull().default(0),
		adsUpdated: integer("ads_updated").notNull().default(0),
		metricsUpdated: integer("metrics_updated").notNull().default(0),
		error: text("error"),
		startedAt: timestamp("started_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [
				table.adAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				adAccounts.id,
				adAccounts.organizationId,
				adAccounts.scopeKey,
				adAccounts.platform,
			],
			name: "ad_sync_logs_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		check(
			"ad_sync_logs_type_check",
			sql`${table.syncType} IN ('external_listing')`,
		),
		check(
			"ad_sync_logs_counts_nonnegative_check",
			sql`${table.adsCreated} >= 0 AND ${table.adsUpdated} >= 0 AND ${table.metricsUpdated} >= 0`,
		),
		index("ad_sync_logs_org_idx").on(table.organizationId, table.startedAt),
		index("ad_sync_logs_ad_account_idx").on(table.adAccountId),
		index("ad_sync_logs_retention_idx")
			.on(table.completedAt, table.id)
			.where(sql`${table.completedAt} IS NOT NULL`),
	],
);

// ---------------------------------------------------------------------------
// External Posts (native posts fetched from platform APIs)
// ---------------------------------------------------------------------------

/** Posts published natively on platforms, synced via API for the Sent tab */
export const externalPosts = pgTable(
	"external_posts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("xp_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		socialAccountId: text("social_account_id")
			.notNull()
			.references(() => socialAccounts.id, { onDelete: "cascade" }),
		platform: platformEnum("platform").notNull(),

		// Platform identity
		platformPostId: text("platform_post_id").notNull(),
		platformUrl: text("platform_url"),

		// Content
		content: text("content"),
		mediaUrls: jsonb("media_urls").$type<string[]>().default([]),
		mediaType: text("media_type"), // "image" | "video" | "carousel" | "text" | "reel" | "story"
		// Provider media URLs are ephemeral (Meta CDN URLs commonly expire). Keep
		// them as source/fallback data, but render the durable preview below first.
		thumbnailUrl: text("thumbnail_url"),
		previewThumbnailKey: text("preview_thumbnail_key"),
		previewStorageProvider: storageProviderEnum("preview_storage_provider"),
		previewStorageBucketLocator: text("preview_storage_bucket_locator"),
		previewStorageRegion: text("preview_storage_region"),
		previewThumbnailUrl: text("preview_thumbnail_url"),
		previewStatus: text("preview_status", {
			enum: [
				"pending",
				"processing",
				"generated",
				"unsupported",
				"source_missing",
				"transient_failure",
			],
		})
			.notNull()
			.default("pending"),
		previewAttempts: integer("preview_attempts").notNull().default(0),
		previewNextRetryAt: timestamp("preview_next_retry_at", {
			withTimezone: true,
		}),
		previewLastError: text("preview_last_error"),

		// Platform-specific raw data
		platformData: jsonb("platform_data")
			.$type<Record<string, unknown>>()
			.default({}),

		// Engagement metrics (refreshed periodically)
		metrics: jsonb("metrics")
			.$type<{
				impressions?: number;
				reach?: number;
				likes?: number;
				comments?: number;
				shares?: number;
				saves?: number;
				clicks?: number;
				views?: number;
			}>()
			.default({}),
		metricsUpdatedAt: timestamp("metrics_updated_at", {
			withTimezone: true,
		}),
		// Poll ownership is independent from freshness. Producers reserve due rows
		// in one UPDATE ... RETURNING statement and consumers fence completion by
		// generation, so overlapping crons cannot multiply provider reads.
		metricsNextPollAt: timestamp("metrics_next_poll_at", {
			withTimezone: true,
		}).defaultNow(),
		metricsPollGeneration: integer("metrics_poll_generation")
			.notNull()
			.default(0),
		metricsPollLeaseExpiresAt: timestamp("metrics_poll_lease_expires_at", {
			withTimezone: true,
		}),
		metricsPollStartedAt: timestamp("metrics_poll_started_at", {
			withTimezone: true,
		}),
		metricsPollAttempts: integer("metrics_poll_attempts").notNull().default(0),
		metricsPollLastError: text("metrics_poll_last_error"),
		metricsPollLastErrorClass: text("metrics_poll_last_error_class"),

		// Internal notes (same format as posts.notes)
		notes: text("notes"),

		// Timestamps
		publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("external_posts_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "external_posts_workspace_org_fk",
		}).onDelete("restrict"),
		foreignKey({
			columns: [
				table.socialAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
				socialAccounts.platform,
			],
			name: "external_posts_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		// Dedup: one external post per account + platform post ID
		uniqueIndex("external_posts_account_platform_post_idx").on(
			table.socialAccountId,
			table.platformPostId,
		),
		// Sent tab query: org + published_at descending
		index("external_posts_org_published_idx").on(
			table.organizationId,
			table.publishedAt,
		),
		// listPosts media lookup: platform_post_id IN (...) AND organization_id = X
		index("external_posts_org_platform_post_idx").on(
			table.organizationId,
			table.platformPostId,
		),
		// Workspace filtering
		index("external_posts_workspace_idx").on(table.workspaceId),
		// Metrics poll scheduler: due time remains separate from true freshness.
		index("external_posts_metrics_poll_due_idx").on(
			table.metricsNextPollAt,
			table.metricsPollLeaseExpiresAt,
			table.id,
		),
		// Platform filter
		index("external_posts_org_platform_idx").on(
			table.organizationId,
			table.platform,
		),
		index("external_posts_account_published_idx").on(
			table.socialAccountId,
			table.publishedAt,
		),
		index("external_posts_retention_idx").on(table.publishedAt, table.id),
		index("external_posts_preview_retry_idx").on(
			table.previewStatus,
			table.previewNextRetryAt,
		),
		check(
			"external_posts_preview_status_check",
			sql`${table.previewStatus} IN ('pending', 'processing', 'generated', 'unsupported', 'source_missing', 'transient_failure')`,
		),
		check(
			"external_posts_preview_attempts_nonnegative_check",
			sql`${table.previewAttempts} >= 0`,
		),
		check(
			"external_posts_preview_storage_locator_check",
			sql`(
					${table.previewThumbnailKey} IS NULL
					AND ${table.previewStorageProvider} IS NULL
					AND ${table.previewStorageBucketLocator} IS NULL
					AND ${table.previewStorageRegion} IS NULL
				) OR (
					${table.previewThumbnailKey} IS NOT NULL
					AND ${table.previewStorageProvider} IS NOT NULL
					AND ${table.previewStorageProvider} = 'r2'
					AND ${table.previewStorageBucketLocator} IS NOT NULL
					AND length(btrim(${table.previewStorageBucketLocator})) > 0
					AND length(${table.previewStorageBucketLocator}) <= 255
					AND ${table.previewStorageRegion} IS NOT NULL
					AND ${table.previewStorageRegion} IN ('default', 'eu')
				)`,
		),
		check(
			"external_posts_preview_projection_check",
			sql`(${table.previewStatus} <> 'generated'
					OR (${table.previewThumbnailKey} IS NOT NULL
						AND ${table.previewThumbnailUrl} IS NOT NULL))
				AND (${table.previewThumbnailUrl} IS NULL
					OR ${table.previewStatus} = 'generated')`,
		),
		check(
			"external_posts_metrics_poll_claim_check",
			sql`(${table.metricsPollLeaseExpiresAt} IS NULL
						AND ${table.metricsPollStartedAt} IS NULL)
					OR (${table.metricsPollLeaseExpiresAt} IS NOT NULL
						AND (${table.metricsPollStartedAt} IS NULL
							OR ${table.metricsPollStartedAt} <= ${table.metricsPollLeaseExpiresAt}))`,
		),
		check(
			"external_posts_metrics_poll_generation_nonnegative_check",
			sql`${table.metricsPollGeneration} >= 0 AND ${table.metricsPollAttempts} >= 0`,
		),
		check(
			"external_posts_metrics_poll_error_class_check",
			sql`${table.metricsPollLastErrorClass} IS NULL
				OR ${table.metricsPollLastErrorClass} IN ('transient', 'rate_limited', 'permanent')`,
		),
	],
);

// ---------------------------------------------------------------------------
// Social Account Sync State (adaptive polling for external post sync)
// ---------------------------------------------------------------------------

/** Tracks per-account sync state for external post fetching */
export const socialAccountSyncState = pgTable(
	"social_account_sync_state",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("sync_")),
		socialAccountId: text("social_account_id").notNull().unique(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		platform: platformEnum("platform").notNull(),

		// Sync state
		enabled: boolean("enabled").notNull().default(true),
		lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
		lastPostFoundAt: timestamp("last_post_found_at", { withTimezone: true }),
		nextSyncAt: timestamp("next_sync_at", { withTimezone: true }),
		pollGeneration: integer("poll_generation").notNull().default(0),
		pollLeaseExpiresAt: timestamp("poll_lease_expires_at", {
			withTimezone: true,
		}),
		pollStartedAt: timestamp("poll_started_at", { withTimezone: true }),

		// Adaptive polling interval (seconds): 3600 (1h) → 86400 (24h)
		pollIntervalSec: integer("poll_interval_sec").notNull().default(3600),
		consecutiveEmptyPolls: integer("consecutive_empty_polls")
			.notNull()
			.default(0),

		// Cursor/pagination state for incremental sync
		syncCursor: text("sync_cursor"),

		// Rate limit tracking
		rateLimitResetAt: timestamp("rate_limit_reset_at", {
			withTimezone: true,
		}),
		rateLimitRemaining: integer("rate_limit_remaining"),

		// Error tracking
		lastError: text("last_error"),
		lastErrorClass: text("last_error_class"),
		consecutiveErrors: integer("consecutive_errors").notNull().default(0),
		lastErrorAt: timestamp("last_error_at", { withTimezone: true }),

		// Stats
		totalPostsSynced: integer("total_posts_synced").notNull().default(0),
		totalSyncRuns: integer("total_sync_runs").notNull().default(0),

		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [
				table.socialAccountId,
				table.organizationId,
				table.scopeKey,
				table.platform,
			],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
				socialAccounts.platform,
			],
			name: "social_account_sync_state_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		check(
			"social_account_sync_state_counters_nonnegative_check",
			sql`${table.pollGeneration} >= 0
				AND ${table.pollIntervalSec} > 0
				AND ${table.consecutiveEmptyPolls} >= 0
				AND ${table.consecutiveErrors} >= 0
				AND ${table.totalPostsSynced} >= 0
				AND ${table.totalSyncRuns} >= 0
				AND (${table.rateLimitRemaining} IS NULL OR ${table.rateLimitRemaining} >= 0)`,
		),
		check(
			"social_account_sync_state_claim_check",
			sql`(${table.pollLeaseExpiresAt} IS NULL AND ${table.pollStartedAt} IS NULL)
				OR (${table.pollLeaseExpiresAt} IS NOT NULL
					AND (${table.pollStartedAt} IS NULL
						OR ${table.pollStartedAt} <= ${table.pollLeaseExpiresAt}))`,
		),
		check(
			"social_account_sync_state_error_class_check",
			sql`${table.lastErrorClass} IS NULL
				OR ${table.lastErrorClass} IN ('transient', 'rate_limited', 'permanent')`,
		),
		// Cron query: find accounts due for sync
		index("sync_state_enabled_next_idx").on(
			table.enabled,
			table.nextSyncAt,
			table.pollLeaseExpiresAt,
			table.organizationId,
			table.id,
		),
		// Org filter
		index("sync_state_org_idx").on(table.organizationId),
		index("social_account_sync_error_retention_idx")
			.on(table.lastErrorAt, table.id)
			.where(sql`${table.lastError} IS NOT NULL`),
	],
);

// ---------------------------------------------------------------------------
// Content Templates & Signatures
// ---------------------------------------------------------------------------

export const contentTemplates = pgTable(
	"content_templates",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("tmpl_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		name: text("name").notNull(),
		description: text("description"),
		content: text("content").notNull(),
		platformOverrides:
			jsonb("platform_overrides").$type<Record<string, string>>(),
		tags: jsonb("tags").$type<string[]>().default([]),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("content_templates_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		uniqueIndex("content_templates_org_scope_name_uniq").on(
			table.organizationId,
			table.scopeKey,
			table.name,
		),
		index("content_templates_org_idx").on(table.organizationId),
		index("content_templates_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("content_templates_workspace_idx").on(table.workspaceId),
	],
);

// ---------------------------------------------------------------------------
// Cross-Post Actions
// ---------------------------------------------------------------------------

export const crossPostActions = pgTable(
	"cross_post_actions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("cpa_")),
		operationId: text("operation_id")
			.notNull()
			.$defaultFn(() => generateId("cpo_")),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		postId: text("post_id").notNull(),
		sourceTargetId: text("source_target_id").notNull(),
		sourcePlatform: platformEnum("source_platform")
			.notNull()
			.default("twitter"),

		actionType: text("action_type", {
			enum: [...CROSS_POST_ACTION_TYPES],
		}).notNull(),
		targetAccountId: text("target_account_id").notNull(),
		targetPlatform: platformEnum("target_platform")
			.notNull()
			.default("twitter"),
		content: text("content"),
		delayMinutes: integer("delay_minutes").notNull().default(0),

		// State
		status: text("status", {
			enum: [
				"pending",
				"processing",
				"executing",
				"retry",
				"executed",
				"failed",
				"unknown",
				"cancelled",
			],
		})
			.notNull()
			.default("pending"),
		// Product schedule and operational retry timing are deliberately separate:
		// provider/readiness retries may move next_attempt_at but never scheduled_for.
		scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
		nextAttemptAt: timestamp("next_attempt_at", {
			withTimezone: true,
		}).notNull(),
		executedAt: timestamp("executed_at", { withTimezone: true }),
		resultPostId: text("result_post_id"),
		error: text("error"),
		attempts: integer("attempts").notNull().default(0),
		readinessChecks: integer("readiness_checks").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		completedAt: timestamp("completed_at", { withTimezone: true }),

		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("cross_post_actions_operation_idx").on(table.operationId),
		foreignKey({
			columns: [
				table.sourceTargetId,
				table.postId,
				table.organizationId,
				table.scopeKey,
				table.sourcePlatform,
			],
			foreignColumns: [
				postTargets.id,
				postTargets.postId,
				postTargets.organizationId,
				postTargets.scopeKey,
				postTargets.platform,
			],
			name: "cross_post_actions_source_post_org_scope_platform_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [
				table.targetAccountId,
				table.organizationId,
				table.scopeKey,
				table.targetPlatform,
			],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
				socialAccounts.platform,
			],
			name: "cross_post_actions_target_account_org_scope_platform_fk",
		}).onDelete("cascade"),
		check(
			"cross_post_actions_type_check",
			sql`${table.actionType} IN ('repost', 'comment', 'quote')`,
		),
		check(
			"cross_post_actions_status_check",
			sql`${table.status} IN ('pending', 'processing', 'executing', 'retry', 'executed', 'failed', 'unknown', 'cancelled')`,
		),
		check(
			"cross_post_actions_platform_check",
			sql`${table.sourcePlatform} = ${table.targetPlatform}`,
		),
		check(
			"cross_post_actions_counters_nonnegative_check",
			sql`${table.delayMinutes} >= 0 AND ${table.attempts} >= 0 AND ${table.readinessChecks} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"cross_post_actions_lease_state_check",
			sql`(${table.status} IN ('processing', 'executing') AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} NOT IN ('processing', 'executing') AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"cross_post_actions_request_boundary_check",
			sql`${table.status} <> 'executing' OR ${table.requestMayHaveBeenSentAt} IS NOT NULL`,
		),
		check(
			"cross_post_actions_completion_check",
			sql`(${table.status} IN ('executed', 'failed', 'unknown', 'cancelled')
					AND ${table.completedAt} IS NOT NULL)
				OR (${table.status} NOT IN ('executed', 'failed', 'unknown', 'cancelled')
					AND ${table.completedAt} IS NULL)`,
		),
		check(
			"cross_post_actions_execution_check",
			sql`${table.status} <> 'executed' OR ${table.executedAt} IS NOT NULL`,
		),
		check(
			"cross_post_actions_timestamp_order_check",
			sql`(${table.requestMayHaveBeenSentAt} IS NULL OR ${table.requestMayHaveBeenSentAt} >= ${table.createdAt})
				AND ${table.nextAttemptAt} >= ${table.scheduledFor}
				AND (${table.executedAt} IS NULL OR ${table.executedAt} >= ${table.createdAt})
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
		),
		index("cross_post_actions_post_idx").on(table.postId),
		index("cross_post_actions_source_target_idx").on(table.sourceTargetId),
		index("cross_post_actions_target_account_idx").on(table.targetAccountId),
		index("cross_post_actions_due_idx").on(
			table.status,
			table.nextAttemptAt,
			table.leaseExpiresAt,
		),
		index("cross_post_actions_retention_idx")
			.on(table.completedAt, table.id)
			.where(
				sql`${table.status} IN ('executed', 'failed', 'unknown', 'cancelled')
					AND ${table.completedAt} IS NOT NULL`,
			),
	],
);

export const signatures = pgTable(
	"signatures",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("sig_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		name: text("name").notNull(),
		content: text("content").notNull(),
		isDefault: boolean("is_default").notNull().default(false),
		position: text("position", { enum: ["append", "prepend"] })
			.notNull()
			.default("append"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("signatures_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		uniqueIndex("signatures_org_scope_name_uniq").on(
			table.organizationId,
			table.scopeKey,
			table.name,
		),
		uniqueIndex("signatures_org_scope_default_uniq")
			.on(table.organizationId, table.scopeKey)
			.where(sql`${table.isDefault} = true`),
		index("signatures_org_idx").on(table.organizationId),
		index("signatures_workspace_idx").on(table.workspaceId),
	],
);

// ---------------------------------------------------------------------------
// Short Link Management
// ---------------------------------------------------------------------------

/**
 * Immutable provider credentials retained while historical short links still
 * need analytics or erasure. Rotation creates a new version and retires the
 * prior version; it never overwrites ciphertext needed by an existing link.
 */
export const shortLinkCredentials = pgTable(
	"short_link_credentials",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("slcred_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		provider: text("provider", {
			enum: ["dub", "short_io", "bitly"],
		}).notNull(),
		version: integer("version").notNull(),
		apiKeyCiphertext: text("api_key_ciphertext").notNull(),
		state: text("state", { enum: ["active", "retired"] })
			.notNull()
			.default("active"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		retiredAt: timestamp("retired_at", { withTimezone: true }),
	},
	(table) => [
		unique("short_link_credentials_id_org_provider_version_uniq").on(
			table.id,
			table.organizationId,
			table.provider,
			table.version,
		),
		unique("short_link_credentials_org_provider_version_uniq").on(
			table.organizationId,
			table.provider,
			table.version,
		),
		uniqueIndex("short_link_credentials_org_active_uniq")
			.on(table.organizationId)
			.where(sql`${table.state} = 'active'`),
		check("short_link_credentials_version_check", sql`${table.version} > 0`),
		check(
			"short_link_credentials_ciphertext_check",
			sql`${table.apiKeyCiphertext} LIKE 'enc:v2:%'
				AND length(${table.apiKeyCiphertext}) BETWEEN 1 AND 8192`,
		),
		check(
			"short_link_credentials_state_check",
			sql`${table.state} IN ('active', 'retired')`,
		),
		check(
			"short_link_credentials_state_tuple_check",
			sql`(${table.state} = 'active' AND ${table.retiredAt} IS NULL)
				OR (${table.state} = 'retired' AND ${table.retiredAt} IS NOT NULL
					AND ${table.retiredAt} >= ${table.createdAt})`,
		),
	],
);

export const shortLinkConfigs = pgTable(
	"short_link_configs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("slc_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id)
			.unique(),

		// Preference: always shorten, ask user, or never
		mode: text("mode", { enum: ["always", "ask", "never"] })
			.notNull()
			.default("never"),

		// Provider
		provider: text("provider", {
			enum: ["relayapi", "dub", "short_io", "bitly"],
		}),
		domain: text("domain"), // custom short domain (e.g. "link.mybrand.com")
		providerConfigVersion: integer("provider_config_version")
			.notNull()
			.default(1),
		credentialVersion: integer("credential_version"),

		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.organizationId, table.provider, table.credentialVersion],
			foreignColumns: [
				shortLinkCredentials.organizationId,
				shortLinkCredentials.provider,
				shortLinkCredentials.version,
			],
			name: "short_link_configs_credential_version_fk",
		}).onDelete("restrict"),
		check(
			"short_link_configs_version_check",
			sql`${table.providerConfigVersion} > 0
				AND (${table.credentialVersion} IS NULL OR ${table.credentialVersion} > 0)`,
		),
		check(
			"short_link_configs_provider_credential_check",
			sql`(${table.provider} IS NULL AND ${table.credentialVersion} IS NULL)
				OR (${table.provider} = 'relayapi' AND ${table.credentialVersion} IS NULL)
				OR (${table.provider} IN ('dub', 'short_io', 'bitly')
					AND ${table.credentialVersion} IS NOT NULL)`,
		),
		index("short_link_configs_org_idx").on(table.organizationId),
	],
);

export const shortLinks = pgTable(
	"short_links",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("sl_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),

		originalUrl: text("original_url").notNull(),
		provider: text("provider", {
			enum: ["relayapi", "dub", "short_io", "bitly"],
		})
			.notNull()
			.default("relayapi"),
		providerConfigVersion: integer("provider_config_version")
			.notNull()
			.default(1),
		credentialVersion: integer("credential_version"),
		providerRef: jsonb("provider_ref")
			.$type<Record<string, unknown>>()
			.notNull(),
		creationStatus: text("creation_status", {
			enum: ["pending", "active", "manual_review"],
		})
			.notNull()
			.default("pending"),
		creationFence: integer("creation_fence").notNull().default(0),
		creationStartedAt: timestamp("creation_started_at", {
			withTimezone: true,
		}),
		creationCompletedAt: timestamp("creation_completed_at", {
			withTimezone: true,
		}),
		creationLastError: text("creation_last_error"),
		shortCode: text("short_code"),
		shortUrl: text("short_url"),

		// Optional association to a post
		postId: text("post_id").references(() => posts.id, {
			onDelete: "set null",
		}),

		// Cached click count (refreshed periodically)
		clickCount: integer("click_count").notNull().default(0),
		lastClickSyncAt: timestamp("last_click_sync_at", {
			withTimezone: true,
		}),
		nextClickSyncAt: timestamp("next_click_sync_at", {
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
		clickSyncGeneration: integer("click_sync_generation").notNull().default(0),
		clickSyncLeaseExpiresAt: timestamp("click_sync_lease_expires_at", {
			withTimezone: true,
		}),
		clickSyncStartedAt: timestamp("click_sync_started_at", {
			withTimezone: true,
		}),
		clickSyncAttempts: integer("click_sync_attempts").notNull().default(0),
		clickSyncLastError: text("click_sync_last_error"),
		clickSyncLastErrorClass: text("click_sync_last_error_class"),

		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("short_links_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "short_links_workspace_org_fk",
		}).onDelete("restrict"),
		foreignKey({
			columns: [table.postId, table.organizationId, table.scopeKey],
			foreignColumns: [posts.id, posts.organizationId, posts.scopeKey],
			name: "short_links_post_org_scope_fk",
		}),
		foreignKey({
			columns: [table.organizationId, table.provider, table.credentialVersion],
			foreignColumns: [
				shortLinkCredentials.organizationId,
				shortLinkCredentials.provider,
				shortLinkCredentials.version,
			],
			name: "short_links_credential_version_fk",
		}).onDelete("restrict"),
		uniqueIndex("short_links_provider_code_uniq")
			.on(table.provider, table.shortCode)
			.where(
				sql`${table.provider} = 'relayapi' AND ${table.shortCode} IS NOT NULL`,
			),
		uniqueIndex("short_links_short_url_uniq")
			.on(table.shortUrl)
			.where(sql`${table.shortUrl} IS NOT NULL`),
		check(
			"short_links_creation_status_check",
			sql`${table.creationStatus} IN ('pending', 'active', 'manual_review')`,
		),
		check(
			"short_links_provider_ref_check",
			sql`jsonb_typeof(${table.providerRef}) = 'object'
				AND octet_length(${table.providerRef}::text) <= 2048
				AND ${table.providerRef}->>'provider' = ${table.provider}
				AND (
					(${table.provider} = 'relayapi'
						AND jsonb_typeof(${table.providerRef}->'shortCode') = 'string'
						AND length(${table.providerRef}->>'shortCode') BETWEEN 1 AND 180)
					OR (${table.provider} = 'dub'
						AND jsonb_typeof(${table.providerRef}->'externalId') = 'string'
						AND length(${table.providerRef}->>'externalId') BETWEEN 1 AND 180)
					OR (${table.provider} IN ('short_io', 'bitly')
						AND jsonb_typeof(${table.providerRef}->'intentId') = 'string'
						AND length(${table.providerRef}->>'intentId') BETWEEN 1 AND 180)
				)
				AND (
					NOT (
						${table.creationStatus} = 'active'
						OR (${table.creationStatus} = 'manual_review'
							AND ${table.shortUrl} IS NOT NULL)
					)
					OR (${table.provider} = 'relayapi'
						AND ${table.providerRef}->>'shortCode' = ${table.shortCode})
					OR (${table.provider} = 'dub')
					OR (${table.provider} = 'short_io'
						AND jsonb_typeof(${table.providerRef}->'idString') = 'string'
						AND length(${table.providerRef}->>'idString') BETWEEN 1 AND 180
						AND jsonb_typeof(${table.providerRef}->'domainId') = 'number')
					OR (${table.provider} = 'bitly'
						AND jsonb_typeof(${table.providerRef}->'bitlink') = 'string'
						AND length(${table.providerRef}->>'bitlink') BETWEEN 1 AND 512
						AND jsonb_typeof(${table.providerRef}->'editedOrCustom') = 'boolean')
				)`,
		),
		check(
			"short_links_creation_state_check",
			sql`${table.providerConfigVersion} > 0
				AND ${table.creationFence} >= 0
				AND (
					(${table.creationStatus} = 'pending'
						AND ${table.provider} <> 'relayapi'
						AND ${table.creationFence} > 0
						AND ${table.shortCode} IS NULL
						AND ${table.shortUrl} IS NULL
						AND ${table.creationStartedAt} IS NOT NULL
						AND ${table.creationCompletedAt} IS NULL
						AND ${table.creationLastError} IS NULL)
					OR (${table.creationStatus} = 'active'
						AND ${table.shortCode} IS NOT NULL
						AND ${table.shortUrl} IS NOT NULL
						AND ${table.shortUrl} ~ '^https?://'
						AND ${table.creationCompletedAt} IS NOT NULL
						AND ${table.creationLastError} IS NULL
						AND (
							(${table.provider} = 'relayapi'
								AND ${table.creationFence} = 0
								AND ${table.creationStartedAt} IS NULL)
							OR (${table.provider} <> 'relayapi'
								AND ${table.creationFence} > 0
								AND ${table.creationStartedAt} IS NOT NULL
								AND ${table.creationCompletedAt} >= ${table.creationStartedAt})
						))
					OR (${table.creationStatus} = 'manual_review'
						AND ${table.provider} <> 'relayapi'
						AND ${table.creationFence} > 0
						AND (
							(${table.shortCode} IS NULL
								AND ${table.shortUrl} IS NULL)
							OR (${table.shortCode} IS NOT NULL
								AND ${table.shortUrl} IS NOT NULL
								AND ${table.shortUrl} ~ '^https?://')
						)
						AND ${table.creationStartedAt} IS NOT NULL
						AND ${table.creationCompletedAt} IS NOT NULL
						AND ${table.creationCompletedAt} >= ${table.creationStartedAt}
						AND ${table.creationLastError} IS NOT NULL)
				)`,
		),
		check(
			"short_links_credential_version_check",
			sql`(${table.provider} = 'relayapi' AND ${table.credentialVersion} IS NULL)
				OR (${table.provider} IN ('dub', 'short_io', 'bitly')
					AND ${table.credentialVersion} IS NOT NULL
					AND ${table.credentialVersion} > 0)`,
		),
		check(
			"short_links_click_count_nonnegative_check",
			sql`${table.clickCount} >= 0`,
		),
		index("short_links_org_idx").on(table.organizationId),
		index("short_links_post_idx").on(table.postId),
		index("short_links_created_sync_idx").on(
			table.createdAt,
			table.lastClickSyncAt,
		),
		index("short_links_click_sync_due_idx").on(
			table.nextClickSyncAt,
			table.clickSyncLeaseExpiresAt,
			table.organizationId,
			table.id,
		),
		check(
			"short_links_click_sync_counters_check",
			sql`${table.clickSyncGeneration} >= 0 AND ${table.clickSyncAttempts} >= 0`,
		),
		check(
			"short_links_click_sync_claim_check",
			sql`(${table.clickSyncLeaseExpiresAt} IS NULL
					AND ${table.clickSyncStartedAt} IS NULL)
				OR (${table.clickSyncLeaseExpiresAt} IS NOT NULL
					AND (${table.clickSyncStartedAt} IS NULL
						OR ${table.clickSyncStartedAt} <= ${table.clickSyncLeaseExpiresAt}))`,
		),
		check(
			"short_links_click_sync_error_class_check",
			sql`${table.clickSyncLastErrorClass} IS NULL
				OR ${table.clickSyncLastErrorClass} IN ('transient', 'rate_limited', 'permanent')`,
		),
	],
);

// ---------------------------------------------------------------------------
// Posting Streaks — tracks org-level posting streak state
// ---------------------------------------------------------------------------

export const orgStreaks = pgTable(
	"org_streaks",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("strk_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id)
			.unique(),

		// Current streak
		streakStartedAt: timestamp("streak_started_at", { withTimezone: true }),
		lastPostAt: timestamp("last_post_at", { withTimezone: true }),
		currentStreakDays: integer("current_streak_days").notNull().default(0),

		// History
		bestStreakDays: integer("best_streak_days").notNull().default(0),
		totalStreaksBroken: integer("total_streaks_broken").notNull().default(0),

		// Notification state
		warningEmailSentAt: timestamp("warning_email_sent_at", {
			withTimezone: true,
		}),

		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"org_streaks_counts_check",
			sql`${table.currentStreakDays} >= 0
				AND ${table.bestStreakDays} >= ${table.currentStreakDays}
				AND ${table.totalStreaksBroken} >= 0`,
		),
		check(
			"org_streaks_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND (${table.lastPostAt} IS NULL OR ${table.streakStartedAt} IS NULL OR ${table.lastPostAt} >= ${table.streakStartedAt})`,
		),
		index("org_streaks_org_idx").on(table.organizationId),
		index("org_streaks_last_post_idx").on(table.lastPostAt),
	],
);

// ---------------------------------------------------------------------------
// Content Planning — Tags, Idea Groups, Ideas, and related tables
// ---------------------------------------------------------------------------

export const tags = pgTable(
	"tags",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("tag_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		name: text("name").notNull(),
		color: text("color").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("tags_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "tags_workspace_org_fk",
		}),
		index("tags_org_idx").on(table.organizationId),
		index("tags_workspace_idx").on(table.workspaceId),
	],
);

export const ideaGroups = pgTable(
	"idea_groups",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("idg_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		name: text("name").notNull(),
		position: integer("position").notNull().default(0),
		color: text("color"),
		isDefault: boolean("is_default").notNull().default(false),
		revision: integer("revision").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("idea_groups_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "idea_groups_workspace_org_fk",
		}),
		uniqueIndex("idea_groups_default_per_scope_uniq")
			.on(table.organizationId, table.scopeKey)
			.where(sql`${table.isDefault} = true`),
		uniqueIndex("idea_groups_scope_position_uniq").on(
			table.organizationId,
			table.scopeKey,
			table.position,
		),
		check(
			"idea_groups_position_nonnegative_check",
			sql`${table.position} >= 0`,
		),
		check(
			"idea_groups_revision_nonnegative_check",
			sql`${table.revision} >= 0`,
		),
		index("idea_groups_org_idx").on(table.organizationId),
		index("idea_groups_workspace_idx").on(table.workspaceId),
		index("idea_groups_workspace_position_idx").on(
			table.workspaceId,
			table.position,
		),
	],
);

export const ideas = pgTable(
	"ideas",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("idea_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		title: text("title"),
		content: text("content"),
		groupId: text("group_id").notNull(),
		groupScopeKey: text("group_scope_key")
			.notNull()
			.default(ORGANIZATION_SCOPE_KEY),
		position: integer("position").notNull().default(0),
		revision: integer("revision").notNull().default(0),
		assignedTo: text("assigned_to").references(() => user.id, {
			onDelete: "set null",
		}),
		convertedToPostId: text("converted_to_post_id"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("ideas_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		unique("ideas_id_org_uniq").on(table.id, table.organizationId),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ideas_workspace_org_fk",
		}),
		foreignKey({
			columns: [table.groupId, table.organizationId, table.groupScopeKey],
			foreignColumns: [
				ideaGroups.id,
				ideaGroups.organizationId,
				ideaGroups.scopeKey,
			],
			name: "ideas_group_org_scope_fk",
		}),
		foreignKey({
			columns: [table.convertedToPostId, table.organizationId, table.scopeKey],
			foreignColumns: [posts.id, posts.organizationId, posts.scopeKey],
			name: "ideas_converted_post_org_scope_fk",
		}).onDelete("restrict"),
		check(
			"ideas_group_visibility_check",
			sql`${table.groupScopeKey} = 'org' OR ${table.groupScopeKey} = ${table.scopeKey}`,
		),
		uniqueIndex("ideas_group_position_uniq").on(
			table.groupId,
			table.organizationId,
			table.scopeKey,
			table.position,
		),
		check("ideas_position_nonnegative_check", sql`${table.position} >= 0`),
		check("ideas_revision_nonnegative_check", sql`${table.revision} >= 0`),
		index("ideas_org_idx").on(table.organizationId),
		index("ideas_workspace_idx").on(table.workspaceId),
		index("ideas_group_position_idx").on(table.groupId, table.position),
		index("ideas_assigned_to_idx").on(table.assignedTo),
		index("ideas_org_created_idx").on(
			table.organizationId,
			table.createdAt,
			table.id,
		),
	],
);

/**
 * Idempotent Idea-to-post conversion claim. A unique Idea row is claimed before
 * inserting a draft so retries cannot create orphan duplicate posts.
 */
export const ideaConversionOperations = pgTable(
	"idea_conversion_operations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("icv_")),
		ideaId: text("idea_id").notNull(),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		idempotencyKey: text("idempotency_key").notNull(),
		postId: text("post_id"),
		status: text("status", {
			enum: ["pending", "processing", "succeeded", "failed"],
		})
			.notNull()
			.default("pending"),
		revision: integer("revision").notNull().default(0),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.ideaId, table.organizationId, table.scopeKey],
			foreignColumns: [ideas.id, ideas.organizationId, ideas.scopeKey],
			name: "idea_conversion_operations_idea_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.postId, table.organizationId, table.scopeKey],
			foreignColumns: [posts.id, posts.organizationId, posts.scopeKey],
			name: "idea_conversion_operations_post_org_scope_fk",
		}).onDelete("restrict"),
		uniqueIndex("idea_conversion_operations_idea_uniq").on(table.ideaId),
		uniqueIndex("idea_conversion_operations_org_idempotency_uniq").on(
			table.organizationId,
			table.idempotencyKey,
		),
		uniqueIndex("idea_conversion_operations_post_uniq").on(table.postId),
		check(
			"idea_conversion_operations_status_check",
			sql`${table.status} IN ('pending', 'processing', 'succeeded', 'failed')`,
		),
		check(
			"idea_conversion_operations_counters_nonnegative_check",
			sql`${table.revision} >= 0 AND ${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"idea_conversion_operations_completion_check",
			sql`${table.status} <> 'succeeded' OR (${table.postId} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`,
		),
		index("idea_conversion_operations_claim_idx").on(
			table.status,
			table.leaseExpiresAt,
		),
		index("idea_conversion_operations_retention_idx")
			.on(sql`COALESCE(${table.completedAt}, ${table.updatedAt})`, table.id)
			.where(sql`${table.status} IN ('succeeded', 'failed')`),
	],
);

export const ideaMedia = pgTable(
	"idea_media",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("idm_")),
		ideaId: text("idea_id").notNull(),
		mediaId: text("media_id").notNull(),
		organizationId: text("organization_id").notNull(),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		type: ideaMediaTypeEnum("type").notNull(),
		alt: text("alt"),
		position: integer("position").notNull().default(0),
		// Direct Idea uploads are deleted with the Idea. Successful conversion
		// clears this flag for copied attachments so the resulting post keeps a
		// durable media-library row after the Idea is removed.
		deleteWithIdea: boolean("delete_with_idea").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("idea_media_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.ideaId, table.organizationId, table.scopeKey],
			foreignColumns: [ideas.id, ideas.organizationId, ideas.scopeKey],
			name: "idea_media_idea_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.mediaId, table.organizationId, table.scopeKey],
			foreignColumns: [media.id, media.organizationId, media.scopeKey],
			name: "idea_media_media_org_scope_fk",
		}).onDelete("restrict"),
		uniqueIndex("idea_media_idea_position_uniq").on(
			table.ideaId,
			table.position,
		),
		uniqueIndex("idea_media_media_uniq").on(table.mediaId),
		check("idea_media_position_nonnegative_check", sql`${table.position} >= 0`),
		index("idea_media_idea_idx").on(table.ideaId),
		index("idea_media_workspace_idx").on(table.workspaceId),
	],
);

export const ideaComments = pgTable(
	"idea_comments",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("idc_")),
		ideaId: text("idea_id").notNull(),
		organizationId: text("organization_id").notNull(),
		authorPrincipalId: text("author_principal_id").notNull(),
		content: text("content").notNull(),
		parentId: text("parent_id"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("idea_comments_id_idea_org_uniq").on(
			table.id,
			table.ideaId,
			table.organizationId,
		),
		foreignKey({
			columns: [table.ideaId, table.organizationId],
			foreignColumns: [ideas.id, ideas.organizationId],
			name: "idea_comments_idea_org_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.authorPrincipalId, table.organizationId],
			foreignColumns: [
				organizationPrincipals.id,
				organizationPrincipals.organizationId,
			],
			name: "idea_comments_author_principal_org_fk",
		}),
		foreignKey({
			columns: [table.parentId, table.ideaId, table.organizationId],
			foreignColumns: [table.id, table.ideaId, table.organizationId],
			name: "idea_comments_parent_idea_org_fk",
		}).onDelete("cascade"),
		index("idea_comments_idea_created_idx").on(
			table.organizationId,
			table.ideaId,
			table.createdAt,
			table.id,
		),
		index("idea_comments_parent_idx").on(table.organizationId, table.parentId),
		index("idea_comments_author_idx").on(
			table.organizationId,
			table.authorPrincipalId,
		),
	],
);

export const ideaTags = pgTable(
	"idea_tags",
	{
		ideaId: text("idea_id").notNull(),
		tagId: text("tag_id").notNull(),
		tagScopeKey: text("tag_scope_key")
			.notNull()
			.default(ORGANIZATION_SCOPE_KEY),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		// Parent-projected scope: the composite idea FK is authoritative. Keeping
		// only its typed scope key avoids a second workspace ownership source.
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
	},
	(table) => [
		primaryKey({ columns: [table.ideaId, table.tagId] }),
		foreignKey({
			columns: [table.ideaId, table.organizationId, table.scopeKey],
			foreignColumns: [ideas.id, ideas.organizationId, ideas.scopeKey],
			name: "idea_tags_idea_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.tagId, table.organizationId, table.tagScopeKey],
			foreignColumns: [tags.id, tags.organizationId, tags.scopeKey],
			name: "idea_tags_tag_org_scope_fk",
		}).onDelete("cascade"),
		check(
			"idea_tags_tag_visibility_check",
			sql`${table.tagScopeKey} = 'org' OR ${table.tagScopeKey} = ${table.scopeKey}`,
		),
		index("idea_tags_org_tag_idea_idx").on(
			table.organizationId,
			table.tagId,
			table.ideaId,
		),
	],
);

export const postTags = pgTable(
	"post_tags",
	{
		postId: text("post_id")
			.notNull()
			.references(() => posts.id, { onDelete: "cascade" }),
		tagId: text("tag_id").notNull(),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		tagScopeKey: text("tag_scope_key")
			.notNull()
			.default(ORGANIZATION_SCOPE_KEY),
	},
	(table) => [
		foreignKey({
			columns: [table.postId, table.organizationId, table.scopeKey],
			foreignColumns: [posts.id, posts.organizationId, posts.scopeKey],
			name: "post_tags_post_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.tagId, table.organizationId, table.tagScopeKey],
			foreignColumns: [tags.id, tags.organizationId, tags.scopeKey],
			name: "post_tags_tag_org_scope_fk",
		}).onDelete("cascade"),
		check(
			"post_tags_tag_visibility_check",
			sql`${table.tagScopeKey} = 'org' OR ${table.tagScopeKey} = ${table.scopeKey}`,
		),
		primaryKey({
			columns: [table.organizationId, table.tagId, table.postId],
			name: "post_tags_pk",
		}),
		index("post_tags_org_post_tag_idx").on(
			table.organizationId,
			table.postId,
			table.tagId,
		),
	],
);

export const ideaActivity = pgTable(
	"idea_activity",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ida_")),
		ideaId: text("idea_id").notNull(),
		organizationId: text("organization_id").notNull(),
		actorPrincipalId: text("actor_principal_id").notNull(),
		action: ideaActivityActionEnum("action").notNull(),
		metadata: jsonb("metadata").$type<Record<string, unknown>>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.ideaId, table.organizationId],
			foreignColumns: [ideas.id, ideas.organizationId],
			name: "idea_activity_idea_org_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.actorPrincipalId, table.organizationId],
			foreignColumns: [
				organizationPrincipals.id,
				organizationPrincipals.organizationId,
			],
			name: "idea_activity_actor_principal_org_fk",
		}),
		index("idea_activity_idea_created_idx").on(
			table.organizationId,
			table.ideaId,
			table.createdAt,
			table.id,
		),
		index("idea_activity_actor_idx").on(
			table.organizationId,
			table.actorPrincipalId,
		),
		index("idea_activity_retention_idx").on(table.createdAt, table.id),
	],
);

// ---------------------------------------------------------------------------
// Automations (Manychat-parity rebuild — port-based graph, v1 schema)
// See docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md
// ---------------------------------------------------------------------------

export const automationStatusEnum = pgEnum("automation_status", [
	"draft",
	"active",
	"paused",
	"archived",
]);

export const automationChannelEnum = pgEnum("automation_channel", [
	"instagram",
	"facebook",
	"whatsapp",
	"telegram",
	"tiktok",
]);

export const automationBindingTypeEnum = pgEnum(
	"automation_binding_type",
	AUTOMATION_BINDING_TYPES,
);

export const automationRunStatusEnum = pgEnum("automation_run_status", [
	"active",
	"waiting",
	"completed",
	"exited",
	"failed",
]);

export const automations = pgTable(
	"automations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("auto_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		name: text("name").notNull(),
		description: text("description"),
		channel: automationChannelEnum("channel").notNull(),
		status: automationStatusEnum("status").notNull().default("draft"),
		graph: jsonb("graph")
			.notNull()
			.default(
				sql`'{"schema_version":1,"root_node_key":null,"nodes":[],"edges":[]}'::jsonb`,
			),
		createdFromTemplate: text("created_from_template"),
		templateConfig: jsonb("template_config"),
		totalEnrolled: integer("total_enrolled").notNull().default(0),
		totalCompleted: integer("total_completed").notNull().default(0),
		totalExited: integer("total_exited").notNull().default(0),
		totalFailed: integer("total_failed").notNull().default(0),
		lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
		validationErrors: jsonb("validation_errors"),
		createdBy: text("created_by").references(() => user.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("automations_id_org_uniq").on(table.id, table.organizationId),
		unique("automations_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "automations_workspace_org_fk",
		}),
		check(
			"automations_counters_check",
			sql`${table.totalEnrolled} >= 0
				AND ${table.totalCompleted} >= 0
				AND ${table.totalExited} >= 0
				AND ${table.totalFailed} >= 0
				AND ${table.totalCompleted} + ${table.totalExited} + ${table.totalFailed} <= ${table.totalEnrolled}`,
		),
		check(
			"automations_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}`,
		),
		index("idx_automations_org_status").on(table.organizationId, table.status),
		index("idx_automations_org_workspace").on(
			table.organizationId,
			table.workspaceId,
		),
		index("idx_automations_template")
			.on(table.createdFromTemplate)
			.where(sql`${table.createdFromTemplate} IS NOT NULL`),
	],
);

/** Write-only encrypted credentials referenced by automation graph actions. */
export const automationSecrets = pgTable(
	"automation_secrets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("asec_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		automationId: text("automation_id").notNull(),
		nodeKey: text("node_key").notNull(),
		actionId: text("action_id").notNull(),
		kind: text("kind", { enum: [...AUTOMATION_SECRET_KINDS] })
			.notNull()
			.default("webhook_out"),
		ciphertext: text("ciphertext").notNull(),
		keyId: text("key_id").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		check(
			"automation_secrets_kind_check",
			sql`${table.kind} IN ('webhook_out', 'http_request')`,
		),
		foreignKey({
			columns: [table.automationId, table.organizationId],
			foreignColumns: [automations.id, automations.organizationId],
			name: "automation_secrets_automation_org_fk",
		}).onDelete("cascade"),
		uniqueIndex("automation_secrets_action_uniq").on(
			table.automationId,
			table.nodeKey,
			table.actionId,
		),
		index("automation_secrets_org_automation_idx").on(
			table.organizationId,
			table.automationId,
		),
	],
);

export const automationEntrypoints = pgTable(
	"automation_entrypoints",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("aep_")),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		automationId: text("automation_id").notNull(),
		channel: automationChannelEnum("channel").notNull(),
		kind: text("kind", {
			enum: [...AUTOMATION_ENTRYPOINT_KINDS],
		}).notNull(),
		status: text("status").notNull().default("active"),
		socialAccountId: text("social_account_id").references(
			() => socialAccounts.id,
			{ onDelete: "set null" },
		),
		config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
		filters: jsonb("filters"),
		allowReentry: boolean("allow_reentry").notNull().default(true),
		reentryCooldownMin: integer("reentry_cooldown_min").notNull().default(60),
		dailyCap: integer("daily_cap"),
		priority: integer("priority").notNull().default(100),
		specificity: integer("specificity").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("automation_entrypoints_id_automation_org_uniq").on(
			table.id,
			table.automationId,
			table.organizationId,
		),
		unique("automation_entrypoints_id_automation_org_scope_uniq").on(
			table.id,
			table.automationId,
			table.organizationId,
			table.scopeKey,
		),
		unique("automation_entrypoints_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.automationId, table.organizationId, table.scopeKey],
			foreignColumns: [
				automations.id,
				automations.organizationId,
				automations.scopeKey,
			],
			name: "automation_entrypoints_automation_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.socialAccountId, table.organizationId, table.scopeKey],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
			],
			name: "automation_entrypoints_account_org_scope_fk",
		}),
		check(
			"automation_entrypoints_kind_check",
			sql`${table.kind} IN ('dm_received', 'comment_created', 'story_reply', 'story_mention', 'live_comment', 'ad_click', 'ref_link_click', 'share_to_dm', 'schedule', 'field_changed', 'tag_applied', 'tag_removed', 'conversion_event', 'webhook_inbound')`,
		),
		check(
			"automation_entrypoints_kind_identity_config_check",
			sql`jsonb_typeof(${table.config}) = 'object'
				AND (${table.kind} NOT IN (
						'ref_link_click',
						'schedule',
						'field_changed',
						'tag_applied',
						'tag_removed',
						'conversion_event'
					)
					OR ${table.socialAccountId} IS NULL)
				AND CASE ${table.kind}
					WHEN 'dm_received' THEN
						${table.config} - ARRAY['keywords', 'match_mode', 'case_sensitive', 'first_message_only'] = '{}'::jsonb
						AND (NOT (${table.config} ? 'match_mode') OR ${table.config}->>'match_mode' IN ('exact', 'contains', 'regex'))
						AND (NOT (${table.config} ? 'case_sensitive') OR jsonb_typeof(${table.config}->'case_sensitive') = 'boolean')
						AND (NOT (${table.config} ? 'first_message_only') OR jsonb_typeof(${table.config}->'first_message_only') = 'boolean')
						AND (NOT (${table.config} ? 'keywords') OR jsonb_typeof(${table.config}->'keywords') = 'array')
					WHEN 'comment_created' THEN
						${table.config} - ARRAY['keywords', 'match_mode', 'case_sensitive', 'post_ids', 'include_replies'] = '{}'::jsonb
						AND (NOT (${table.config} ? 'match_mode') OR ${table.config}->>'match_mode' IN ('exact', 'contains', 'regex'))
						AND (NOT (${table.config} ? 'case_sensitive') OR jsonb_typeof(${table.config}->'case_sensitive') = 'boolean')
						AND (NOT (${table.config} ? 'post_ids') OR ${table.config}->'post_ids' = 'null'::jsonb OR jsonb_typeof(${table.config}->'post_ids') = 'array')
						AND (NOT (${table.config} ? 'include_replies') OR jsonb_typeof(${table.config}->'include_replies') = 'boolean')
						AND (NOT (${table.config} ? 'keywords') OR jsonb_typeof(${table.config}->'keywords') = 'array')
					WHEN 'story_reply' THEN
						${table.config} - ARRAY['keywords', 'match_mode', 'case_sensitive', 'story_ids'] = '{}'::jsonb
						AND (NOT (${table.config} ? 'match_mode') OR ${table.config}->>'match_mode' IN ('exact', 'contains', 'regex'))
						AND (NOT (${table.config} ? 'case_sensitive') OR jsonb_typeof(${table.config}->'case_sensitive') = 'boolean')
						AND (NOT (${table.config} ? 'story_ids') OR ${table.config}->'story_ids' = 'null'::jsonb OR jsonb_typeof(${table.config}->'story_ids') = 'array')
						AND (NOT (${table.config} ? 'keywords') OR jsonb_typeof(${table.config}->'keywords') = 'array')
					WHEN 'story_mention' THEN
						${table.config} - ARRAY['keywords', 'match_mode', 'case_sensitive', 'story_ids'] = '{}'::jsonb
						AND (NOT (${table.config} ? 'match_mode') OR ${table.config}->>'match_mode' IN ('exact', 'contains', 'regex'))
						AND (NOT (${table.config} ? 'case_sensitive') OR jsonb_typeof(${table.config}->'case_sensitive') = 'boolean')
						AND (NOT (${table.config} ? 'story_ids') OR ${table.config}->'story_ids' = 'null'::jsonb OR jsonb_typeof(${table.config}->'story_ids') = 'array')
						AND (NOT (${table.config} ? 'keywords') OR jsonb_typeof(${table.config}->'keywords') = 'array')
					WHEN 'live_comment' THEN
						${table.config} - ARRAY['keywords', 'match_mode', 'case_sensitive'] = '{}'::jsonb
						AND (NOT (${table.config} ? 'match_mode') OR ${table.config}->>'match_mode' IN ('exact', 'contains', 'regex'))
						AND (NOT (${table.config} ? 'case_sensitive') OR jsonb_typeof(${table.config}->'case_sensitive') = 'boolean')
						AND (NOT (${table.config} ? 'keywords') OR jsonb_typeof(${table.config}->'keywords') = 'array')
					WHEN 'ad_click' THEN
						${table.config} - 'ad_ids' = '{}'::jsonb
						AND (NOT (${table.config} ? 'ad_ids') OR ${table.config}->'ad_ids' = 'null'::jsonb OR jsonb_typeof(${table.config}->'ad_ids') = 'array')
					WHEN 'ref_link_click' THEN
						${table.config} ? 'ref_url_ids'
						AND ${table.config} - 'ref_url_ids' = '{}'::jsonb
						AND jsonb_typeof(${table.config}->'ref_url_ids') = 'array'
						AND ${table.config}->'ref_url_ids' <> '[]'::jsonb
					WHEN 'share_to_dm' THEN ${table.config} = '{}'::jsonb
					WHEN 'schedule' THEN
						${table.config} ?& ARRAY['cron', 'timezone']
						AND ${table.config} - ARRAY['cron', 'timezone'] = '{}'::jsonb
						AND jsonb_typeof(${table.config}->'cron') = 'string'
						AND length(btrim(${table.config}->>'cron')) > 0
						AND jsonb_typeof(${table.config}->'timezone') = 'string'
						AND length(btrim(${table.config}->>'timezone')) > 0
					WHEN 'field_changed' THEN
						${table.config} ? 'field_keys'
						AND ${table.config} - ARRAY['field_keys', 'from', 'to'] = '{}'::jsonb
						AND jsonb_typeof(${table.config}->'field_keys') = 'array'
						AND ${table.config}->'field_keys' <> '[]'::jsonb
					WHEN 'tag_applied' THEN
						${table.config} ? 'tag_ids'
						AND ${table.config} - 'tag_ids' = '{}'::jsonb
						AND jsonb_typeof(${table.config}->'tag_ids') = 'array'
						AND ${table.config}->'tag_ids' <> '[]'::jsonb
					WHEN 'tag_removed' THEN
						${table.config} ? 'tag_ids'
						AND ${table.config} - 'tag_ids' = '{}'::jsonb
						AND jsonb_typeof(${table.config}->'tag_ids') = 'array'
						AND ${table.config}->'tag_ids' <> '[]'::jsonb
					WHEN 'conversion_event' THEN
						${table.config} ? 'event_names'
						AND ${table.config} - 'event_names' = '{}'::jsonb
						AND jsonb_typeof(${table.config}->'event_names') = 'array'
						AND ${table.config}->'event_names' <> '[]'::jsonb
					WHEN 'webhook_inbound' THEN
						${table.config} ?& ARRAY['webhook_slug', 'webhook_secret', 'contact_lookup']
						AND ${table.config} - ARRAY['webhook_slug', 'webhook_secret', 'contact_lookup', 'payload_mapping'] = '{}'::jsonb
						AND jsonb_typeof(${table.config}->'webhook_slug') = 'string'
						AND length(btrim(${table.config}->>'webhook_slug')) > 0
						AND jsonb_typeof(${table.config}->'webhook_secret') = 'string'
						AND length(btrim(${table.config}->>'webhook_secret')) > 0
						AND jsonb_typeof(${table.config}->'contact_lookup') = 'object'
						AND (NOT (${table.config} ? 'payload_mapping') OR jsonb_typeof(${table.config}->'payload_mapping') = 'object')
					ELSE false
				END`,
		),
		check(
			"automation_entrypoints_status_check",
			sql`${table.status} IN ('active', 'paused', 'disabled')`,
		),
		check(
			"automation_entrypoints_numeric_check",
			sql`${table.reentryCooldownMin} >= 0
				AND (${table.dailyCap} IS NULL OR ${table.dailyCap} > 0)
				AND ${table.specificity} >= 0`,
		),
		check(
			"automation_entrypoints_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}`,
		),
		index("idx_automation_entrypoints_automation").on(table.automationId),
		index("idx_automation_entrypoints_match").on(
			table.channel,
			table.kind,
			table.status,
		),
		index("idx_automation_entrypoints_account_match").on(
			table.socialAccountId,
			table.kind,
			table.status,
		),
		// Inbound-webhook slug must be globally unique and is looked up by slug on
		// every trigger. Backs the app-level uniqueness check and the keyed lookup.
		uniqueIndex("idx_automation_entrypoints_webhook_slug")
			.on(sql`(${table.config}->>'webhook_slug')`)
			.where(sql`${table.kind} = 'webhook_inbound'`),
	],
);

/**
 * Atomic calendar-day admission counter for one entrypoint. The matcher bumps
 * this row inside the same transaction that creates the run, so concurrent
 * webhook deliveries cannot overshoot a configured daily cap.
 */
export const automationEntrypointDailyCounts = pgTable(
	"automation_entrypoint_daily_counts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("aedc_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		entrypointId: text("entrypoint_id").notNull(),
		// UTC calendar day, not a timestamp or format-convention string.
		day: date("day", { mode: "string" }).notNull(),
		count: integer("count").notNull().default(0),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		foreignKey({
			columns: [table.entrypointId, table.organizationId, table.scopeKey],
			foreignColumns: [
				automationEntrypoints.id,
				automationEntrypoints.organizationId,
				automationEntrypoints.scopeKey,
			],
			name: "automation_entrypoint_daily_counts_entrypoint_org_scope_fk",
		}).onDelete("cascade"),
		uniqueIndex("automation_entrypoint_daily_counts_entrypoint_day_uniq").on(
			table.entrypointId,
			table.day,
		),
		check(
			"automation_entrypoint_daily_counts_count_check",
			sql`${table.count} >= 0`,
		),
		index("automation_entrypoint_daily_counts_org_day_idx").on(
			table.organizationId,
			table.day,
		),
		index("automation_entrypoint_daily_counts_retention_idx").on(
			table.day,
			table.id,
		),
	],
);

/**
 * Short-lived replay receipts for signed public automation webhooks.
 *
 * A digest is the replay key. The bounded request body is retained only as
 * context-bound ciphertext so accepted work can be reconciled after a crash;
 * plaintext customer payloads never enter this ledger. The unique
 * entrypoint/digest pair is the atomic barrier before contact/enrollment work.
 */
export const automationWebhookReceipts = pgTable(
	"automation_webhook_receipts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("awhr_")),
		organizationId: text("organization_id").notNull(),
		automationId: text("automation_id").notNull(),
		entrypointId: text("entrypoint_id").notNull(),
		requestDigest: varchar("request_digest", { length: 64 }).notNull(),
		signatureTimestamp: text("signature_timestamp").notNull(),
		payloadCiphertext: text("payload_ciphertext").notNull(),
		status: text("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		runId: text("run_id"),
		lastError: text("last_error"),
		receivedAt: timestamp("received_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.entrypointId, table.automationId, table.organizationId],
			foreignColumns: [
				automationEntrypoints.id,
				automationEntrypoints.automationId,
				automationEntrypoints.organizationId,
			],
			name: "automation_webhook_receipts_entrypoint_auto_org_fk",
		}).onDelete("cascade"),
		uniqueIndex("automation_webhook_receipts_entrypoint_digest_uniq").on(
			table.entrypointId,
			table.requestDigest,
		),
		check(
			"automation_webhook_receipts_status_check",
			sql`${table.status} IN ('pending', 'processing', 'failed', 'succeeded', 'terminal_failed')`,
		),
		check(
			"automation_webhook_receipts_counters_nonnegative_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"automation_webhook_receipts_lease_state_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"automation_webhook_receipts_completion_check",
			sql`(${table.status} IN ('succeeded', 'terminal_failed') AND ${table.completedAt} IS NOT NULL)
				OR (${table.status} NOT IN ('succeeded', 'terminal_failed') AND ${table.completedAt} IS NULL)`,
		),
		check(
			"automation_webhook_receipts_success_run_check",
			sql`${table.status} <> 'succeeded' OR ${table.runId} IS NOT NULL`,
		),
		check(
			"automation_webhook_receipts_retention_check",
			sql`${table.expiresAt} > ${table.receivedAt}
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.receivedAt})`,
		),
		index("automation_webhook_receipts_expiry_idx").on(
			table.expiresAt,
			table.id,
		),
		index("automation_webhook_receipts_status_due_idx").on(
			table.status,
			table.nextAttemptAt,
		),
		index("automation_webhook_receipts_org_received_idx").on(
			table.organizationId,
			table.receivedAt,
		),
	],
);

export const automationBindings = pgTable(
	"automation_bindings",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("abnd_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		socialAccountId: text("social_account_id").notNull(),
		channel: automationChannelEnum("channel").notNull(),
		bindingType: automationBindingTypeEnum("binding_type").notNull(),
		automationId: text("automation_id").notNull(),
		config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
		status: text("status").notNull().default("active"),
		desiredActive: boolean("desired_active").notNull().default(true),
		deleteAfterSync: boolean("delete_after_sync").notNull().default(false),
		syncRevision: integer("sync_revision").notNull().default(0),
		lastSyncedRevision: integer("last_synced_revision").notNull().default(0),
		syncAttempts: integer("sync_attempts").notNull().default(0),
		syncDispatchGeneration: integer("sync_dispatch_generation")
			.notNull()
			.default(0),
		syncNextAttemptAt: timestamp("sync_next_attempt_at", {
			withTimezone: true,
		}).defaultNow(),
		syncLeaseExpiresAt: timestamp("sync_lease_expires_at", {
			withTimezone: true,
		}),
		syncStartedAt: timestamp("sync_started_at", { withTimezone: true }),
		syncRequestMayHaveBeenSentAt: timestamp(
			"sync_request_may_have_been_sent_at",
			{ withTimezone: true },
		),
		lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
		syncError: text("sync_error"),
		syncErrorClass: text("sync_error_class"),
		syncErrorAt: timestamp("sync_error_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("automation_bindings_id_org_uniq").on(
			table.id,
			table.organizationId,
		),
		unique("automation_bindings_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "automation_bindings_workspace_org_fk",
		}),
		foreignKey({
			columns: [table.socialAccountId, table.organizationId, table.scopeKey],
			foreignColumns: [
				socialAccounts.id,
				socialAccounts.organizationId,
				socialAccounts.scopeKey,
			],
			name: "automation_bindings_account_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.automationId, table.organizationId, table.scopeKey],
			foreignColumns: [
				automations.id,
				automations.organizationId,
				automations.scopeKey,
			],
			name: "automation_bindings_automation_org_scope_fk",
		}).onDelete("cascade"),
		check(
			"automation_bindings_status_check",
			sql`${table.status} IN ('active', 'paused', 'pending_sync', 'sync_failed', 'inactive')`,
		),
		check(
			"automation_bindings_sync_counters_check",
			sql`${table.syncRevision} >= 0
				AND ${table.lastSyncedRevision} >= 0
				AND ${table.lastSyncedRevision} <= ${table.syncRevision}
				AND ${table.syncAttempts} >= 0
				AND ${table.syncDispatchGeneration} >= 0`,
		),
		check(
			"automation_bindings_sync_claim_check",
			sql`(${table.syncLeaseExpiresAt} IS NULL AND ${table.syncStartedAt} IS NULL)
				OR (${table.syncLeaseExpiresAt} IS NOT NULL
					AND (${table.syncStartedAt} IS NULL
						OR ${table.syncStartedAt} <= ${table.syncLeaseExpiresAt}))`,
		),
		check(
			"automation_bindings_sync_error_class_check",
			sql`${table.syncErrorClass} IS NULL
				OR ${table.syncErrorClass} IN ('transient', 'permanent', 'unknown')`,
		),
		check(
			"automation_bindings_sync_error_tuple_check",
			sql`(${table.syncError} IS NULL AND ${table.syncErrorAt} IS NULL)
				OR (${table.syncError} IS NOT NULL AND ${table.syncErrorAt} IS NOT NULL)`,
		),
		check(
			"automation_bindings_sync_boundary_check",
			sql`${table.syncRequestMayHaveBeenSentAt} IS NULL
				OR ${table.syncStartedAt} IS NOT NULL
				OR ${table.syncErrorClass} = 'unknown'`,
		),
		check(
			"automation_bindings_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}`,
		),
		uniqueIndex("automation_bindings_social_account_binding_type_uniq").on(
			table.socialAccountId,
			table.bindingType,
		),
		index("idx_automation_bindings_lookup").on(
			table.socialAccountId,
			table.bindingType,
			table.status,
		),
		index("idx_automation_bindings_automation").on(table.automationId),
		index("automation_bindings_sync_due_idx").on(
			table.syncNextAttemptAt,
			table.syncLeaseExpiresAt,
			table.organizationId,
			table.id,
		),
		index("automation_bindings_sync_error_retention_idx")
			.on(table.syncErrorAt, table.id)
			.where(sql`${table.syncError} IS NOT NULL`),
	],
);

export const automationRuns = pgTable(
	"automation_runs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("arun_")),
		automationId: text("automation_id").notNull(),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		revision: integer("revision").notNull().default(0),
		entrypointId: text("entrypoint_id").references(
			() => automationEntrypoints.id,
			{ onDelete: "set null" },
		),
		bindingId: text("binding_id").references(() => automationBindings.id, {
			onDelete: "set null",
		}),
		contactId: text("contact_id").notNull(),
		conversationId: text("conversation_id").references(
			() => inboxConversations.id,
			{ onDelete: "set null" },
		),
		triggerOccurrenceId: text("trigger_occurrence_id"),
		status: automationRunStatusEnum("status").notNull().default("active"),
		currentNodeKey: text("current_node_key"),
		currentPortKey: text("current_port_key"),
		context: jsonb("context").notNull().default(sql`'{}'::jsonb`),
		waitingUntil: timestamp("waiting_until", { withTimezone: true }),
		waitingFor: text("waiting_for"),
		exitReason: text("exit_reason"),
		startedAt: timestamp("started_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("automation_runs_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		unique("automation_runs_id_automation_org_scope_uniq").on(
			table.id,
			table.automationId,
			table.organizationId,
			table.scopeKey,
		),
		unique("automation_runs_id_auto_contact_org_scope_uniq").on(
			table.id,
			table.automationId,
			table.contactId,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.automationId, table.organizationId, table.scopeKey],
			foreignColumns: [
				automations.id,
				automations.organizationId,
				automations.scopeKey,
			],
			name: "automation_runs_automation_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [
				table.entrypointId,
				table.automationId,
				table.organizationId,
				table.scopeKey,
			],
			foreignColumns: [
				automationEntrypoints.id,
				automationEntrypoints.automationId,
				automationEntrypoints.organizationId,
				automationEntrypoints.scopeKey,
			],
			name: "automation_runs_entrypoint_auto_org_scope_fk",
		}),
		foreignKey({
			columns: [table.bindingId, table.organizationId, table.scopeKey],
			foreignColumns: [
				automationBindings.id,
				automationBindings.organizationId,
				automationBindings.scopeKey,
			],
			name: "automation_runs_binding_org_scope_fk",
		}),
		foreignKey({
			columns: [table.contactId, table.organizationId, table.scopeKey],
			foreignColumns: [contacts.id, contacts.organizationId, contacts.scopeKey],
			name: "automation_runs_contact_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.conversationId, table.organizationId, table.scopeKey],
			foreignColumns: [
				inboxConversations.id,
				inboxConversations.organizationId,
				inboxConversations.scopeKey,
			],
			name: "automation_runs_conversation_org_scope_fk",
		}),
		check(
			"automation_runs_revision_nonnegative_check",
			sql`${table.revision} >= 0`,
		),
		check(
			"automation_runs_waiting_for_check",
			sql`${table.waitingFor} IS NULL OR ${table.waitingFor} IN ('input', 'delay', 'inbound_event', 'external_event')`,
		),
		check(
			"automation_runs_wait_state_check",
			sql`${table.status} <> 'waiting' OR ${table.waitingFor} IS NOT NULL`,
		),
		check(
			"automation_runs_completion_check",
			sql`(${table.status} IN ('completed', 'exited', 'failed')
					AND ${table.completedAt} IS NOT NULL
					AND ${table.exitReason} IS NOT NULL)
				OR (${table.status} IN ('active', 'waiting') AND ${table.completedAt} IS NULL)`,
		),
		check(
			"automation_runs_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.startedAt}
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt})`,
		),
		index("idx_automation_runs_auto_status").on(
			table.automationId,
			table.status,
		),
		index("idx_automation_runs_contact_auto").on(
			table.contactId,
			table.automationId,
		),
		index("idx_automation_runs_sweeper").on(table.status, table.waitingUntil),
		index("idx_automation_runs_org_started").on(
			table.organizationId,
			sql`${table.startedAt} DESC`,
		),
		index("idx_automation_runs_entrypoint").on(table.entrypointId),
		index("idx_automation_runs_binding").on(table.bindingId),
		index("idx_automation_runs_conversation").on(table.conversationId),
		uniqueIndex("idx_automation_runs_active_uniq")
			.on(table.contactId, table.automationId)
			.where(sql`"status" IN ('active', 'waiting')`),
		uniqueIndex("idx_automation_runs_trigger_occurrence_uniq").on(
			table.automationId,
			table.triggerOccurrenceId,
		),
		index("idx_automation_runs_contact_occurrence")
			.on(table.organizationId, table.contactId, table.triggerOccurrenceId)
			.where(sql`${table.triggerOccurrenceId} IS NOT NULL`),
		index("automation_runs_retention_idx")
			.on(table.completedAt, table.id)
			.where(
				sql`${table.status} IN ('completed', 'exited', 'failed')
					AND ${table.completedAt} IS NOT NULL`,
			),
	],
);

export const AUTOMATION_CONVERSION_DISPATCH_STATUSES = [
	"pending",
	"processing",
	"succeeded",
	"manual_review",
] as const;

/**
 * Conversion facts and their durable internal-trigger handoff.
 *
 * The conversion identity/value columns are immutable facts. Dispatch columns
 * form a fenced outbox on the same lifecycle row so a committed conversion can
 * never be lost between persistence and downstream automation enrollment.
 */
export const automationConversionEvents = pgTable(
	"automation_conversion_events",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("acv_")),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		automationId: text("automation_id").notNull(),
		runId: text("run_id").notNull(),
		contactId: text("contact_id").notNull(),
		occurrenceId: text("occurrence_id").notNull(),
		eventName: text("event_name").notNull(),
		value: text("value"),
		currency: varchar("currency", { length: 3 }),
		channel: text("channel").notNull(),
		socialAccountId: text("social_account_id"),
		conversationId: text("conversation_id"),
		eventDepth: integer("event_depth").notNull().default(0),
		metadata: jsonb("metadata"),
		dispatchStatus: text("dispatch_status", {
			enum: [...AUTOMATION_CONVERSION_DISPATCH_STATUSES],
		})
			.notNull()
			.default("pending"),
		dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
		dispatchLeaseToken: integer("dispatch_lease_token").notNull().default(0),
		dispatchLeaseExpiresAt: timestamp("dispatch_lease_expires_at", {
			withTimezone: true,
		}),
		nextDispatchAt: timestamp("next_dispatch_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		dispatchDeadlineAt: timestamp("dispatch_deadline_at", {
			withTimezone: true,
		})
			.notNull()
			.default(sql`CURRENT_TIMESTAMP + interval '7 days'`),
		dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
		lastDispatchError: text("last_dispatch_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		foreignKey({
			columns: [
				table.runId,
				table.automationId,
				table.contactId,
				table.organizationId,
				table.scopeKey,
			],
			foreignColumns: [
				automationRuns.id,
				automationRuns.automationId,
				automationRuns.contactId,
				automationRuns.organizationId,
				automationRuns.scopeKey,
			],
			name: "automation_conversion_events_run_auto_contact_org_scope_fk",
		})
			.onUpdate("cascade")
			.onDelete("cascade"),
		uniqueIndex("automation_conversion_events_occurrence_uniq").on(
			table.occurrenceId,
		),
		check(
			"automation_conversion_events_channel_check",
			sql`${table.channel} IN ('instagram', 'facebook', 'whatsapp', 'telegram')`,
		),
		check(
			"automation_conversion_events_dispatch_status_check",
			sql`${table.dispatchStatus} IN ('pending', 'processing', 'succeeded', 'manual_review')`,
		),
		check(
			"automation_conversion_events_dispatch_counters_check",
			sql`${table.eventDepth} >= 0
				AND ${table.dispatchAttempts} >= 0
				AND ${table.dispatchLeaseToken} >= 0`,
		),
		check(
			"automation_conversion_events_dispatch_state_check",
			sql`(${table.dispatchStatus} = 'pending'
						AND ${table.dispatchLeaseExpiresAt} IS NULL
						AND ${table.dispatchedAt} IS NULL)
					OR (${table.dispatchStatus} = 'processing'
						AND ${table.dispatchAttempts} > 0
						AND ${table.dispatchLeaseExpiresAt} IS NOT NULL
						AND ${table.dispatchedAt} IS NULL)
					OR (${table.dispatchStatus} = 'succeeded'
						AND ${table.dispatchLeaseExpiresAt} IS NULL
						AND ${table.dispatchedAt} IS NOT NULL
						AND ${table.lastDispatchError} IS NULL)
					OR (${table.dispatchStatus} = 'manual_review'
						AND ${table.dispatchLeaseExpiresAt} IS NULL
						AND ${table.dispatchedAt} IS NULL
						AND ${table.lastDispatchError} IS NOT NULL)`,
		),
		check(
			"automation_conversion_events_dispatch_timestamps_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND ${table.dispatchDeadlineAt} > ${table.createdAt}
				AND ${table.nextDispatchAt} >= ${table.createdAt}
				AND (${table.dispatchLeaseExpiresAt} IS NULL
					OR ${table.dispatchLeaseExpiresAt} >= ${table.createdAt})
				AND (${table.dispatchedAt} IS NULL
					OR ${table.dispatchedAt} >= ${table.createdAt})`,
		),
		index("automation_conversion_events_dispatch_due_idx")
			.on(
				table.dispatchStatus,
				table.nextDispatchAt,
				table.dispatchLeaseExpiresAt,
				table.id,
			)
			.where(sql`${table.dispatchStatus} IN ('pending', 'processing')`),
		index("automation_conversion_events_dispatch_deadline_idx")
			.on(table.dispatchDeadlineAt, table.id)
			.where(sql`${table.dispatchStatus} IN ('pending', 'processing')`),
		index("automation_conversion_events_manual_review_idx")
			.on(table.updatedAt, table.id)
			.where(sql`${table.dispatchStatus} = 'manual_review'`),
		index("automation_conversion_events_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("automation_conversion_events_contact_created_idx").on(
			table.contactId,
			table.createdAt,
		),
		index("automation_conversion_events_retention_idx")
			.on(table.createdAt, table.id)
			.where(sql`${table.dispatchStatus} = 'succeeded'`),
	],
);

/**
 * Exclusive claim for one graph-node visit. Workers must insert/claim this row
 * before any provider call; retries reuse the same visit identity.
 */
export const automationNodeExecutions = pgTable(
	"automation_node_executions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("anx_")),
		runId: text("run_id").notNull(),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		runRevision: integer("run_revision").notNull(),
		visitOrdinal: integer("visit_ordinal").notNull(),
		nodeKey: text("node_key").notNull(),
		status: text("status", {
			enum: ["claimed", "succeeded", "failed", "unknown"],
		})
			.notNull()
			.default("claimed"),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		result: jsonb("result"),
		error: jsonb("error"),
		claimedAt: timestamp("claimed_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("automation_node_executions_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.runId, table.organizationId, table.scopeKey],
			foreignColumns: [
				automationRuns.id,
				automationRuns.organizationId,
				automationRuns.scopeKey,
			],
			name: "automation_node_executions_run_org_scope_fk",
		}).onDelete("cascade"),
		uniqueIndex("automation_node_executions_visit_uniq").on(
			table.runId,
			table.runRevision,
			table.visitOrdinal,
		),
		check(
			"automation_node_executions_status_check",
			sql`${table.status} IN ('claimed', 'succeeded', 'failed', 'unknown')`,
		),
		check(
			"automation_node_executions_counters_nonnegative_check",
			sql`${table.runRevision} >= 0 AND ${table.visitOrdinal} >= 0 AND ${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"automation_node_executions_state_fields_check",
			sql`(${table.status} = 'claimed'
					AND ${table.leaseExpiresAt} IS NOT NULL
					AND ${table.completedAt} IS NULL)
				OR (${table.status} IN ('succeeded', 'failed', 'unknown')
					AND ${table.leaseExpiresAt} IS NULL
					AND ${table.completedAt} IS NOT NULL)`,
		),
		check(
			"automation_node_executions_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.claimedAt}
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.claimedAt})`,
		),
		index("automation_node_executions_claim_idx").on(
			table.status,
			table.leaseExpiresAt,
		),
		index("automation_node_executions_retention_idx")
			.on(table.completedAt, table.id)
			.where(
				sql`${table.status} IN ('succeeded', 'failed', 'unknown')
					AND ${table.completedAt} IS NOT NULL`,
			),
	],
);

/** Durable idempotency and outcome ledger for each external node effect. */
export const automationEffects = pgTable(
	"automation_effects",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("aef_")),
		nodeExecutionId: text("node_execution_id").notNull(),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		effectKey: text("effect_key").notNull(),
		kind: text("kind", {
			enum: [...AUTOMATION_EFFECT_KINDS],
		}).notNull(),
		providerIdempotencyKey: text("provider_idempotency_key").notNull(),
		status: text("status", {
			enum: ["claimed", "in_flight", "succeeded", "failed", "unknown"],
		})
			.notNull()
			.default("claimed"),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		providerReference: text("provider_reference"),
		result: jsonb("result"),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.nodeExecutionId, table.organizationId, table.scopeKey],
			foreignColumns: [
				automationNodeExecutions.id,
				automationNodeExecutions.organizationId,
				automationNodeExecutions.scopeKey,
			],
			name: "automation_effects_execution_org_scope_fk",
		}).onDelete("cascade"),
		uniqueIndex("automation_effects_execution_key_uniq").on(
			table.nodeExecutionId,
			table.effectKey,
		),
		uniqueIndex("automation_effects_provider_idempotency_uniq").on(
			table.providerIdempotencyKey,
		),
		check(
			"automation_effects_status_check",
			sql`${table.status} IN ('claimed', 'in_flight', 'succeeded', 'failed', 'unknown')`,
		),
		check(
			"automation_effects_kind_check",
			sql`${table.kind} IN ('message_block', 'http_request', 'automation_action')`,
		),
		check(
			"automation_effects_counters_nonnegative_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"automation_effects_state_fields_check",
			sql`(${table.status} = 'claimed'
						AND ${table.leaseExpiresAt} IS NOT NULL
						AND ${table.requestMayHaveBeenSentAt} IS NULL
						AND ${table.completedAt} IS NULL)
					OR (${table.status} = 'in_flight'
						AND ${table.leaseExpiresAt} IS NOT NULL
						AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
						AND ${table.completedAt} IS NULL)
					OR (${table.status} IN ('succeeded', 'failed', 'unknown')
						AND ${table.leaseExpiresAt} IS NULL
						AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
						AND ${table.completedAt} IS NOT NULL)`,
		),
		check(
			"automation_effects_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND (${table.requestMayHaveBeenSentAt} IS NULL OR ${table.requestMayHaveBeenSentAt} >= ${table.createdAt})
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
		),
		index("automation_effects_claim_idx").on(
			table.status,
			table.leaseExpiresAt,
		),
		index("automation_effects_retention_idx")
			.on(table.completedAt, table.id)
			.where(
				sql`${table.status} IN ('succeeded', 'failed', 'unknown')
					AND ${table.completedAt} IS NOT NULL`,
			),
	],
);

export const AUTOMATION_STEP_OUTCOMES = [
	"ok",
	"wait_input",
	"wait_delay",
	"wait_event",
	"end",
	"failed",
	"graph_changed",
] as const;
export const AUTOMATION_STEP_FAILURE_OUTCOME = "failed" as const;

// Intentionally ordinary (non-partitioned) for the first production baseline.
// Add partitioning only after measured volume justifies the operational burden.
export const automationStepRuns = pgTable(
	"automation_step_runs",
	{
		id: bigserial("id", { mode: "bigint" }).primaryKey(),
		runId: text("run_id").notNull(),
		automationId: text("automation_id").notNull(),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		nodeKey: text("node_key").notNull(),
		nodeKind: text("node_kind", {
			enum: [...AUTOMATION_NODE_KINDS],
		}).notNull(),
		enteredViaPortKey: text("entered_via_port_key"),
		exitedViaPortKey: text("exited_via_port_key"),
		outcome: text("outcome", {
			enum: [...AUTOMATION_STEP_OUTCOMES],
		}).notNull(),
		durationMs: integer("duration_ms").notNull().default(0),
		payload: jsonb("payload"),
		error: jsonb("error"),
		executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			columns: [
				table.runId,
				table.automationId,
				table.organizationId,
				table.scopeKey,
			],
			foreignColumns: [
				automationRuns.id,
				automationRuns.automationId,
				automationRuns.organizationId,
				automationRuns.scopeKey,
			],
			name: "automation_step_runs_run_auto_org_scope_fk",
		}).onDelete("cascade"),
		check(
			"automation_step_runs_node_kind_check",
			sql`${table.nodeKind} IN ('message', 'input', 'delay', 'wait_event', 'condition', 'randomizer', 'action_group', 'http_request', 'start_automation', 'social_profile_check', 'goto', 'end', 'unknown')`,
		),
		check(
			"automation_step_runs_outcome_check",
			sql`${table.outcome} IN ('ok', 'wait_input', 'wait_delay', 'wait_event', 'end', 'failed', 'graph_changed')`,
		),
		check(
			"automation_step_runs_duration_nonnegative_check",
			sql`${table.durationMs} >= 0`,
		),
		index("idx_step_runs_run_time").on(
			table.runId,
			sql`${table.executedAt} DESC`,
		),
		index("idx_step_runs_auto_time").on(table.automationId, table.executedAt),
		index("automation_step_runs_org_time_idx").on(
			table.organizationId,
			table.executedAt,
			table.id,
		),
		index("automation_step_runs_org_scope_time_idx").on(
			table.organizationId,
			table.scopeKey,
			table.executedAt,
			table.id,
		),
		index("idx_step_runs_node_time").on(table.nodeKey, table.executedAt),
		index("idx_step_runs_executed_brin").using("brin", table.executedAt),
		index("automation_step_runs_retention_idx").on(table.executedAt, table.id),
	],
);

export const automationScheduledJobs = pgTable(
	"automation_scheduled_jobs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("asj_")),
		occurrenceId: text("occurrence_id")
			.notNull()
			.$defaultFn(() => generateId("aso_")),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull(),
		runId: text("run_id"),
		jobType: text("job_type", {
			enum: [...AUTOMATION_SCHEDULED_JOB_TYPES],
		}).notNull(),
		automationId: text("automation_id").notNull(),
		entrypointId: text("entrypoint_id"),
		runAt: timestamp("run_at", { withTimezone: true }).notNull(),
		status: text("status", {
			enum: ["pending", "processing", "done", "failed", "unknown"],
		})
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		effectStartedAt: timestamp("effect_started_at", { withTimezone: true }),
		payload: jsonb("payload"),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("idx_scheduled_jobs_occurrence_uniq").on(table.occurrenceId),
		foreignKey({
			columns: [
				table.runId,
				table.automationId,
				table.organizationId,
				table.scopeKey,
			],
			foreignColumns: [
				automationRuns.id,
				automationRuns.automationId,
				automationRuns.organizationId,
				automationRuns.scopeKey,
			],
			name: "automation_scheduled_jobs_run_auto_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [
				table.entrypointId,
				table.automationId,
				table.organizationId,
				table.scopeKey,
			],
			foreignColumns: [
				automationEntrypoints.id,
				automationEntrypoints.automationId,
				automationEntrypoints.organizationId,
				automationEntrypoints.scopeKey,
			],
			name: "automation_scheduled_jobs_entrypoint_auto_org_scope_fk",
		}).onDelete("cascade"),
		check(
			"automation_scheduled_jobs_status_check",
			sql`${table.status} IN ('pending', 'processing', 'done', 'failed', 'unknown')`,
		),
		check(
			"automation_scheduled_jobs_counters_nonnegative_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"automation_scheduled_jobs_type_check",
			sql`${table.jobType} IN ('resume_run', 'input_timeout', 'event_timeout', 'internal_event', 'scheduled_trigger', 'webhook_reception_failure')`,
		),
		check(
			"automation_scheduled_jobs_parent_union_check",
			sql`(${table.jobType} IN ('resume_run', 'input_timeout', 'event_timeout', 'internal_event')
					AND ${table.runId} IS NOT NULL
					AND ${table.entrypointId} IS NULL)
				OR (${table.jobType} IN ('scheduled_trigger', 'webhook_reception_failure')
					AND ${table.runId} IS NULL
					AND ${table.entrypointId} IS NOT NULL)`,
		),
		check(
			"automation_scheduled_jobs_internal_event_payload_check",
			sql`${table.jobType} <> 'internal_event'
				OR (
					jsonb_typeof(${table.payload}) = 'object'
					AND ${table.payload}->>'version' = '1'
					AND ${table.payload}->>'kind' IN ('tag_applied', 'tag_removed', 'field_changed')
					AND length(btrim(${table.payload}->>'action_id')) BETWEEN 1 AND 512
					AND jsonb_typeof(${table.payload}->'event_depth') = 'number'
					AND (${table.payload}->>'event_depth')::integer BETWEEN 1 AND 5
					AND (
						(
							${table.payload}->>'kind' IN ('tag_applied', 'tag_removed')
							AND length(btrim(${table.payload}->>'tag_id')) BETWEEN 1 AND 512
						)
						OR (
							${table.payload}->>'kind' = 'field_changed'
							AND length(btrim(${table.payload}->>'field_key')) BETWEEN 1 AND 512
							AND ${table.payload} ? 'field_value_before'
							AND ${table.payload} ? 'field_value_after'
						)
					)
				)`,
		),
		check(
			"automation_scheduled_jobs_lease_state_check",
			sql`(${table.status} = 'processing'
					AND ${table.claimedAt} IS NOT NULL
					AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"automation_scheduled_jobs_unknown_boundary_check",
			sql`(${table.effectStartedAt} IS NULL
					OR ${table.jobType} = 'webhook_reception_failure')
				AND (${table.status} <> 'unknown'
					OR (${table.jobType} = 'webhook_reception_failure'
						AND ${table.effectStartedAt} IS NOT NULL))`,
		),
		index("idx_scheduled_jobs_sweep").on(
			table.status,
			table.runAt,
			table.leaseExpiresAt,
		),
		index("idx_scheduled_jobs_run").on(table.runId),
		index("idx_scheduled_jobs_automation").on(table.automationId),
		index("idx_scheduled_jobs_entrypoint").on(table.entrypointId),
		index("idx_scheduled_jobs_org_status_due").on(
			table.organizationId,
			table.status,
			table.runAt,
			table.id,
		),
		index("automation_scheduled_jobs_retention_idx")
			.on(table.runAt, table.id)
			.where(sql`${table.status} IN ('done', 'failed', 'unknown')`),
	],
);

export const automationContactControls = pgTable(
	"automation_contact_controls",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("acc_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		contactId: text("contact_id").notNull(),
		automationId: text("automation_id"),
		pauseReason: text("pause_reason"),
		pausedUntil: timestamp("paused_until", { withTimezone: true }),
		pausedByUserId: text("paused_by_user_id").references(() => user.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		foreignKey({
			columns: [table.contactId, table.organizationId],
			foreignColumns: [contacts.id, contacts.organizationId],
			name: "automation_contact_controls_contact_org_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.automationId, table.organizationId],
			foreignColumns: [automations.id, automations.organizationId],
			name: "automation_contact_controls_automation_org_fk",
		}).onDelete("cascade"),
		uniqueIndex("idx_contact_controls_per_auto")
			.on(table.contactId, table.automationId)
			.where(sql`"automation_id" IS NOT NULL`),
		uniqueIndex("idx_contact_controls_global")
			.on(table.contactId)
			.where(sql`"automation_id" IS NULL`),
		index("idx_contact_controls_contact").on(table.contactId),
		index("idx_contact_controls_expiry")
			.on(table.pausedUntil)
			.where(sql`${table.pausedUntil} IS NOT NULL`),
	],
);

// ---------------------------------------------------------------------------
// Segments + Subscription lists (used by flow conditions and broadcast targeting)
// ---------------------------------------------------------------------------

export const segments = pgTable(
	"segments",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("seg_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		name: text("name").notNull(),
		description: text("description"),
		// Static segments have no filter. Dynamic filters are validated by the API
		// and evaluated from contact/custom-field state rather than materialized.
		filter: jsonb("filter"),
		isDynamic: boolean("is_dynamic").notNull().default(true),
		memberCount: integer("member_count").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("segments_id_org_uniq").on(table.id, table.organizationId),
		unique("segments_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		unique("segments_static_membership_parent_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
			table.isDynamic,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "segments_workspace_org_fk",
		}),
		check(
			"segments_member_count_nonnegative_check",
			sql`${table.memberCount} >= 0`,
		),
		check(
			"segments_filter_mode_check",
			sql`(NOT ${table.isDynamic} AND ${table.filter} IS NULL)
				OR (${table.isDynamic}
					AND ${table.filter} IS NOT NULL
					AND jsonb_typeof(${table.filter}) = 'object'
					AND (${table.filter} - 'all' - 'any' - 'none') = '{}'::jsonb
					AND (
						CASE WHEN jsonb_typeof(${table.filter} -> 'all') = 'array'
							THEN jsonb_array_length(${table.filter} -> 'all') ELSE 0 END
						+ CASE WHEN jsonb_typeof(${table.filter} -> 'any') = 'array'
							THEN jsonb_array_length(${table.filter} -> 'any') ELSE 0 END
						+ CASE WHEN jsonb_typeof(${table.filter} -> 'none') = 'array'
							THEN jsonb_array_length(${table.filter} -> 'none') ELSE 0 END
					) BETWEEN 1 AND 50
					AND (${table.filter} -> 'all' IS NULL OR jsonb_typeof(${table.filter} -> 'all') = 'array')
					AND (${table.filter} -> 'any' IS NULL OR jsonb_typeof(${table.filter} -> 'any') = 'array')
					AND (${table.filter} -> 'none' IS NULL OR jsonb_typeof(${table.filter} -> 'none') = 'array'))`,
		),
		check(
			"segments_dynamic_member_count_zero_check",
			sql`NOT ${table.isDynamic} OR ${table.memberCount} = 0`,
		),
		index("segments_org_idx").on(table.organizationId),
		index("segments_workspace_idx").on(table.workspaceId),
	],
);

export const contactSegmentMemberships = pgTable(
	"contact_segment_memberships",
	{
		contactId: text("contact_id").notNull(),
		segmentId: text("segment_id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		// Projected from segments.is_dynamic. The false CHECK plus composite FK
		// makes this relation structurally incapable of storing dynamic matches.
		segmentIsDynamic: boolean("segment_is_dynamic").notNull().default(false),
		source: text("source").notNull().default("manual"),
		createdByUserId: text("created_by_user_id").references(() => user.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.contactId, table.organizationId, table.scopeKey],
			foreignColumns: [contacts.id, contacts.organizationId, contacts.scopeKey],
			name: "contact_segment_memberships_contact_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [
				table.segmentId,
				table.organizationId,
				table.scopeKey,
				table.segmentIsDynamic,
			],
			foreignColumns: [
				segments.id,
				segments.organizationId,
				segments.scopeKey,
				segments.isDynamic,
			],
			name: "contact_segment_memberships_static_segment_fk",
		}).onDelete("cascade"),
		primaryKey({
			columns: [table.contactId, table.segmentId],
			name: "contact_segment_memberships_pk",
		}),
		index("contact_segment_memberships_org_idx").on(table.organizationId),
		index("contact_segment_memberships_segment_idx").on(table.segmentId),
		index("contact_segment_memberships_contact_idx").on(table.contactId),
		check(
			"contact_segment_memberships_static_only_check",
			sql`${table.segmentIsDynamic} = false`,
		),
	],
);

export const subscriptionLists = pgTable(
	"subscription_lists",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("sublist_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		name: text("name").notNull(),
		channel: automationChannelEnum("channel").notNull(),
		description: text("description"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("subscription_lists_id_org_uniq").on(table.id, table.organizationId),
		unique("subscription_lists_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "subscription_lists_workspace_org_fk",
		}),
		index("subscription_lists_org_idx").on(table.organizationId),
	],
);

export const contactSubscriptionSourceEnum = pgEnum(
	"contact_subscription_source",
	["automation", "manual", "import", "api"],
);

export const contactSubscriptionEventTypeEnum = pgEnum(
	"contact_subscription_event_type",
	CONTACT_SUBSCRIPTION_EVENT_TYPES,
);

/**
 * Append-only evidence for every subscription-list state authority change.
 *
 * `contact_id` deliberately is not a foreign key to the live contact row:
 * contact merges delete the source row but must not rewrite or cascade-delete
 * its history. Privacy erasure explicitly drains the complete merge lineage.
 */
export const contactSubscriptionEvents = pgTable(
	"contact_subscription_events",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("subevt_")),
		ingestionSequence: bigserial("ingestion_sequence", {
			mode: "bigint",
		}).notNull(),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		contactId: text("contact_id").notNull(),
		listId: text("list_id").notNull(),
		type: contactSubscriptionEventTypeEnum("type").notNull(),
		source: contactSubscriptionSourceEnum("source").notNull(),
		actorId: text("actor_id"),
		mergedFromContactId: text("merged_from_contact_id"),
		occurredAt: timestamp("occurred_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.listId, table.organizationId, table.scopeKey],
			foreignColumns: [
				subscriptionLists.id,
				subscriptionLists.organizationId,
				subscriptionLists.scopeKey,
			],
			name: "contact_subscription_events_list_org_scope_fk",
		}).onDelete("cascade"),
		unique("contact_subscription_events_ingestion_sequence_uniq").on(
			table.ingestionSequence,
		),
		unique("contact_subscription_events_projection_source_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
			table.listId,
			table.contactId,
			table.type,
			table.source,
			table.occurredAt,
			table.ingestionSequence,
		),
		check(
			"contact_subscription_events_sequence_positive_check",
			sql`${table.ingestionSequence} > 0`,
		),
		check(
			"contact_subscription_events_merge_origin_check",
			sql`${table.mergedFromContactId} IS NULL
				OR ${table.mergedFromContactId} <> ${table.contactId}`,
		),
		check(
			"contact_subscription_events_timestamp_order_check",
			sql`${table.occurredAt} <= ${table.createdAt} + interval '5 minutes'`,
		),
		index("contact_subscription_events_org_list_occurred_idx").on(
			table.organizationId,
			table.listId,
			table.occurredAt,
			table.id,
		),
		index("contact_subscription_events_org_contact_occurred_idx").on(
			table.organizationId,
			table.contactId,
			table.occurredAt,
			table.id,
		),
		index("contact_subscription_events_merge_lineage_idx")
			.on(table.organizationId, table.mergedFromContactId, table.contactId)
			.where(sql`${table.mergedFromContactId} IS NOT NULL`),
	],
);

/**
 * Indexed current-state projection. The wide source foreign key is
 * intentional: the state, source, clock, tenant/scope identity, and sequence
 * must all come from one exact immutable event.
 */
export const contactSubscriptions = pgTable(
	"contact_subscriptions",
	{
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		contactId: text("contact_id").notNull(),
		listId: text("list_id").notNull(),
		state: contactSubscriptionEventTypeEnum("state").notNull(),
		subscribedAt: timestamp("subscribed_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
		source: contactSubscriptionSourceEnum("source").notNull(),
		lastEventId: text("last_event_id").notNull(),
		lastEventSequence: bigint("last_event_sequence", {
			mode: "bigint",
		}).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.contactId, table.organizationId, table.scopeKey],
			foreignColumns: [contacts.id, contacts.organizationId, contacts.scopeKey],
			name: "contact_subscriptions_contact_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.listId, table.organizationId, table.scopeKey],
			foreignColumns: [
				subscriptionLists.id,
				subscriptionLists.organizationId,
				subscriptionLists.scopeKey,
			],
			name: "contact_subscriptions_list_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [
				table.lastEventId,
				table.organizationId,
				table.scopeKey,
				table.listId,
				table.contactId,
				table.state,
				table.source,
				table.updatedAt,
				table.lastEventSequence,
			],
			foreignColumns: [
				contactSubscriptionEvents.id,
				contactSubscriptionEvents.organizationId,
				contactSubscriptionEvents.scopeKey,
				contactSubscriptionEvents.listId,
				contactSubscriptionEvents.contactId,
				contactSubscriptionEvents.type,
				contactSubscriptionEvents.source,
				contactSubscriptionEvents.occurredAt,
				contactSubscriptionEvents.ingestionSequence,
			],
			name: "contact_subscriptions_projection_source_fk",
		}),
		check(
			"contact_subscriptions_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.subscribedAt}
				AND (${table.unsubscribedAt} IS NULL
					OR (${table.unsubscribedAt} >= ${table.subscribedAt}
						AND ${table.updatedAt} >= ${table.unsubscribedAt}))`,
		),
		check(
			"contact_subscriptions_state_check",
			sql`(${table.state} = 'subscribed' AND ${table.unsubscribedAt} IS NULL)
				OR (${table.state} = 'unsubscribed' AND ${table.unsubscribedAt} IS NOT NULL)`,
		),
		check(
			"contact_subscriptions_sequence_positive_check",
			sql`${table.lastEventSequence} > 0`,
		),
		primaryKey({
			columns: [table.organizationId, table.listId, table.contactId],
			name: "contact_subscriptions_pk",
		}),
		index("contact_subscriptions_org_contact_list_idx").on(
			table.organizationId,
			table.contactId,
			table.listId,
		),
		index("contact_subscriptions_org_list_updated_idx").on(
			table.organizationId,
			table.listId,
			table.updatedAt,
			table.contactId,
		),
		index("contact_subscriptions_org_list_active_idx")
			.on(table.organizationId, table.listId, table.updatedAt, table.contactId)
			.where(sql`${table.unsubscribedAt} IS NULL`),
		index("contact_subscriptions_org_list_unsubscribed_idx")
			.on(table.organizationId, table.listId, table.updatedAt, table.contactId)
			.where(sql`${table.unsubscribedAt} IS NOT NULL`),
	],
);

// ---------------------------------------------------------------------------
// AI Knowledge Base (powers ai_agent nodes)
// `vector` is a baseline-required extension. The public provider registry is
// closed so every row can use the single HNSW cosine index below.
// ---------------------------------------------------------------------------

export const aiKnowledgeBases = pgTable(
	"ai_knowledge_bases",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("kb_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		name: text("name").notNull(),
		description: text("description"),
		embeddingProvider: text("embedding_provider")
			.notNull()
			.default(AI_EMBEDDING_PROVIDER),
		embeddingModel: text("embedding_model")
			.notNull()
			.default(AI_EMBEDDING_MODEL),
		embeddingDimensions: integer("embedding_dimensions")
			.notNull()
			.default(AI_EMBEDDING_DIMENSIONS),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("ai_knowledge_bases_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ai_knowledge_bases_workspace_org_fk",
		}).onDelete("restrict"),
		check(
			"ai_knowledge_bases_embedding_registry_check",
			sql`${table.embeddingProvider} = ${ddlTextLiteral(AI_EMBEDDING_PROVIDER)} AND ${table.embeddingModel} = ${ddlTextLiteral(AI_EMBEDDING_MODEL)} AND ${table.embeddingDimensions} = ${ddlIntegerLiteral(AI_EMBEDDING_DIMENSIONS)}`,
		),
		index("ai_knowledge_bases_org_idx").on(table.organizationId),
	],
);

export const aiKnowledgeDocuments = pgTable(
	"ai_knowledge_documents",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("kbd_")),
		kbId: text("kb_id").notNull(),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		sourceType: text("source_type", {
			enum: [...AI_KNOWLEDGE_SOURCE_TYPES],
		}).notNull(),
		sourceUrl: text("source_url"),
		sourceMediaId: text("source_media_id"),
		sourceText: text("source_text"),
		title: text("title"),
		status: text("status", {
			enum: [
				"pending",
				"in_flight",
				"ready",
				"retryable_failure",
				"terminal_failure",
			],
		})
			.notNull()
			.default("pending"),
		attemptId: text("attempt_id"),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		deadlineAt: timestamp("deadline_at", { withTimezone: true })
			.notNull()
			.default(sql`now() + interval '24 hours'`),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		lastCrawledAt: timestamp("last_crawled_at", { withTimezone: true }),
		contentHash: text("content_hash"),
		lastErrorCode: text("last_error_code"),
		lastError: text("last_error"),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("ai_knowledge_documents_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.kbId, table.organizationId, table.scopeKey],
			foreignColumns: [
				aiKnowledgeBases.id,
				aiKnowledgeBases.organizationId,
				aiKnowledgeBases.scopeKey,
			],
			name: "ai_knowledge_documents_kb_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.sourceMediaId, table.organizationId, table.scopeKey],
			foreignColumns: [media.id, media.organizationId, media.scopeKey],
			name: "ai_knowledge_documents_media_org_scope_fk",
		}).onDelete("restrict"),
		check(
			"ai_knowledge_documents_source_type_check",
			sql`${table.sourceType} IN ('url', 'media', 'text')`,
		),
		check(
			"ai_knowledge_documents_source_check",
			sql`(${table.sourceType} = 'url' AND ${table.sourceUrl} IS NOT NULL AND ${table.sourceMediaId} IS NULL AND ${table.sourceText} IS NULL) OR (${table.sourceType} = 'media' AND ${table.sourceUrl} IS NULL AND ${table.sourceMediaId} IS NOT NULL AND ${table.sourceText} IS NULL) OR (${table.sourceType} = 'text' AND ${table.sourceUrl} IS NULL AND ${table.sourceMediaId} IS NULL AND ${table.sourceText} IS NOT NULL)`,
		),
		check(
			"ai_knowledge_documents_status_check",
			sql`${table.status} IN ('pending', 'in_flight', 'ready', 'retryable_failure', 'terminal_failure')`,
		),
		check(
			"ai_knowledge_documents_attempt_count_check",
			sql`${table.attemptCount} BETWEEN 0 AND ${ddlIntegerLiteral(AI_KNOWLEDGE_DOCUMENT_MAX_ATTEMPTS)}`,
		),
		check(
			"ai_knowledge_documents_deadline_check",
			sql`${table.deadlineAt} > ${table.createdAt}`,
		),
		check(
			"ai_knowledge_documents_lease_check",
			sql`(${table.status} = 'in_flight' AND ${table.attemptId} IS NOT NULL AND ${table.claimedAt} IS NOT NULL AND ${table.leaseExpiresAt} > ${table.claimedAt}) OR (${table.status} <> 'in_flight' AND ${table.attemptId} IS NULL AND ${table.claimedAt} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"ai_knowledge_documents_terminal_check",
			sql`(${table.status} = 'pending' AND ${table.completedAt} IS NULL AND ${table.lastErrorCode} IS NULL AND ${table.lastError} IS NULL AND ${table.contentHash} IS NULL)
				OR (${table.status} = 'in_flight' AND ${table.completedAt} IS NULL AND ${table.lastErrorCode} IS NULL AND ${table.lastError} IS NULL)
				OR (${table.status} = 'retryable_failure' AND ${table.completedAt} IS NULL AND ${table.lastErrorCode} IS NOT NULL AND ${table.lastError} IS NOT NULL)
				OR (${table.status} = 'ready' AND ${table.completedAt} IS NOT NULL AND ${table.lastCrawledAt} IS NOT NULL AND ${table.contentHash} IS NOT NULL AND ${table.lastErrorCode} IS NULL AND ${table.lastError} IS NULL)
				OR (${table.status} = 'terminal_failure' AND ${table.completedAt} IS NOT NULL AND ${table.lastErrorCode} IS NOT NULL AND ${table.lastError} IS NOT NULL)`,
		),
		check(
			"ai_knowledge_documents_content_hash_check",
			sql`${table.contentHash} IS NULL OR ${table.contentHash} ~ '^[0-9a-f]{64}$'`,
		),
		index("ai_knowledge_documents_kb_idx").on(table.kbId),
		index("ai_knowledge_documents_due_idx").on(
			table.status,
			table.nextAttemptAt,
			table.id,
		),
		index("ai_knowledge_documents_deadline_idx").on(table.deadlineAt, table.id),
		index("ai_knowledge_documents_failure_retention_idx")
			.on(table.completedAt, table.id)
			.where(sql`${table.status} = 'terminal_failure'`),
	],
);

export const aiKnowledgeChunks = pgTable(
	"ai_knowledge_chunks",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("kbc_")),
		documentId: text("document_id").notNull(),
		kbId: text("kb_id").notNull(),
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		content: text("content").notNull(),
		contentHash: text("content_hash").notNull(),
		embedding: vector("embedding", {
			dimensions: AI_EMBEDDING_DIMENSIONS,
		}).notNull(),
		chunkIndex: integer("chunk_index").notNull(),
		tokenCount: integer("token_count"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.documentId, table.organizationId, table.scopeKey],
			foreignColumns: [
				aiKnowledgeDocuments.id,
				aiKnowledgeDocuments.organizationId,
				aiKnowledgeDocuments.scopeKey,
			],
			name: "ai_knowledge_chunks_document_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.kbId, table.organizationId, table.scopeKey],
			foreignColumns: [
				aiKnowledgeBases.id,
				aiKnowledgeBases.organizationId,
				aiKnowledgeBases.scopeKey,
			],
			name: "ai_knowledge_chunks_kb_org_scope_fk",
		}).onDelete("cascade"),
		uniqueIndex("ai_knowledge_chunks_document_index_uniq").on(
			table.documentId,
			table.chunkIndex,
		),
		check(
			"ai_knowledge_chunks_counts_nonnegative_check",
			sql`${table.chunkIndex} >= 0 AND (${table.tokenCount} IS NULL OR ${table.tokenCount} >= 0)`,
		),
		check(
			"ai_knowledge_chunks_content_hash_check",
			sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
		),
		index("ai_knowledge_chunks_doc_idx").on(table.documentId),
		index("ai_knowledge_chunks_kb_idx").on(table.kbId),
		index("ai_knowledge_chunks_embedding_hnsw_idx").using(
			"hnsw",
			table.embedding.op("vector_cosine_ops"),
		),
	],
);

export const aiAgents = pgTable(
	"ai_agents",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ai_ag_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		name: text("name").notNull(),
		persona: text("persona"),
		guardrails: jsonb("guardrails")
			.$type<{
				version: 1;
				blockedTopics: string[];
				fallbackMessage: string;
			}>()
			.notNull()
			.default({
				version: 1,
				blockedTopics: [],
				fallbackMessage:
					"I can’t help with that request. A team member can take over.",
			}),
		provider: text("provider").notNull().default(AI_INFERENCE_PROVIDER),
		model: text("model").notNull().default(AI_INFERENCE_MODEL),
		kbId: text("kb_id").references(() => aiKnowledgeBases.id, {
			onDelete: "set null",
		}),
		handoffStrategy: jsonb("handoff_strategy")
			.$type<{
				version: 1;
				keywords: string[];
				confidenceThreshold: number;
			}>()
			.notNull()
			.default({
				version: 1,
				keywords: [],
				confidenceThreshold: 0.6,
			}),
		handoffPrincipalId: text("handoff_principal_id"),
		temperature: real("temperature").notNull().default(0.7),
		maxTokens: integer("max_tokens").notNull().default(1024),
		enabled: boolean("enabled").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("ai_agents_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ai_agents_workspace_org_fk",
		}).onDelete("restrict"),
		foreignKey({
			columns: [table.kbId, table.organizationId, table.scopeKey],
			foreignColumns: [
				aiKnowledgeBases.id,
				aiKnowledgeBases.organizationId,
				aiKnowledgeBases.scopeKey,
			],
			name: "ai_agents_kb_org_scope_fk",
		}),
		foreignKey({
			columns: [table.handoffPrincipalId, table.organizationId],
			foreignColumns: [
				organizationPrincipals.id,
				organizationPrincipals.organizationId,
			],
			name: "ai_agents_handoff_principal_org_fk",
		}).onDelete("restrict"),
		check(
			"ai_agents_parameters_check",
			sql`${table.temperature} >= 0 AND ${table.temperature} <= 2 AND ${table.maxTokens} BETWEEN 1 AND 8192`,
		),
		check(
			"ai_agents_model_registry_check",
			sql`${table.provider} = ${ddlTextLiteral(AI_INFERENCE_PROVIDER)} AND ${table.model} = ${ddlTextLiteral(AI_INFERENCE_MODEL)}`,
		),
		check(
			"ai_agents_guardrails_shape_check",
			sql`jsonb_typeof(${table.guardrails}) = 'object'
				AND (${table.guardrails} - 'version' - 'blockedTopics' - 'fallbackMessage') = '{}'::jsonb
				AND ${table.guardrails}->>'version' = '1'
				AND jsonb_typeof(${table.guardrails}->'blockedTopics') = 'array'
				AND jsonb_array_length(${table.guardrails}->'blockedTopics') <= 100
				AND NOT jsonb_path_exists(
					${table.guardrails}->'blockedTopics',
					'$[*] ? (@.type() != "string" || @ like_regex "^$" || @ like_regex "^.{121}" flag "s")'
				)
				AND jsonb_typeof(${table.guardrails}->'fallbackMessage') = 'string'
				AND length(${table.guardrails}->>'fallbackMessage') BETWEEN 1 AND 1000`,
		),
		check(
			"ai_agents_handoff_shape_check",
			sql`jsonb_typeof(${table.handoffStrategy}) = 'object'
				AND (${table.handoffStrategy} - 'version' - 'keywords' - 'confidenceThreshold') = '{}'::jsonb
				AND ${table.handoffStrategy}->>'version' = '1'
				AND jsonb_typeof(${table.handoffStrategy}->'keywords') = 'array'
				AND jsonb_array_length(${table.handoffStrategy}->'keywords') <= 100
				AND NOT jsonb_path_exists(
					${table.handoffStrategy}->'keywords',
					'$[*] ? (@.type() != "string" || @ like_regex "^$" || @ like_regex "^.{121}" flag "s")'
				)
				AND jsonb_typeof(${table.handoffStrategy}->'confidenceThreshold') = 'number'
				AND (${table.handoffStrategy}->>'confidenceThreshold')::real BETWEEN 0 AND 1`,
		),
		index("ai_agents_org_idx").on(table.organizationId),
	],
);

// ---------------------------------------------------------------------------
// Growth tools (Ref URLs, QR codes, Landing pages)
// ---------------------------------------------------------------------------

export const landingPages = pgTable(
	"landing_pages",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("lp_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		slug: text("slug").notNull(),
		title: text("title").notNull(),
		config: jsonb("config").notNull(),
		automationId: text("automation_id").references(() => automations.id, {
			onDelete: "set null",
		}),
		visits: bigint("visits", { mode: "number" }).notNull().default(0),
		conversions: bigint("conversions", { mode: "number" }).notNull().default(0),
		enabled: boolean("enabled").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("landing_pages_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "landing_pages_workspace_org_fk",
		}).onDelete("restrict"),
		foreignKey({
			columns: [table.automationId, table.organizationId, table.scopeKey],
			foreignColumns: [
				automations.id,
				automations.organizationId,
				automations.scopeKey,
			],
			name: "landing_pages_automation_org_scope_fk",
		}),
		uniqueIndex("landing_pages_org_scope_slug_uniq").on(
			table.organizationId,
			table.scopeKey,
			table.slug,
		),
		check(
			"landing_pages_slug_format_check",
			sql`${table.slug} ~ '^[a-z0-9][a-z0-9_-]{0,99}$'`,
		),
		check(
			"landing_pages_config_version_check",
			sql`jsonb_typeof(${table.config}) = 'object'
				AND ${table.config} ->> 'version' = '1'`,
		),
		check(
			"landing_pages_counts_nonnegative_check",
			sql`${table.visits} BETWEEN 0 AND 9007199254740991
				AND ${table.conversions} BETWEEN 0 AND 9007199254740991`,
		),
		check(
			"landing_pages_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}`,
		),
		index("landing_pages_automation_idx").on(table.automationId),
	],
);

export const refUrls = pgTable(
	"ref_urls",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ref_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		slug: text("slug").notNull(),
		destinationType: text("destination_type", {
			enum: [...REF_URL_DESTINATION_TYPES],
		}).notNull(),
		destinationUrl: text("destination_url"),
		landingPageId: text("landing_page_id"),
		automationId: text("automation_id").references(() => automations.id, {
			onDelete: "set null",
		}),
		uses: bigint("uses", { mode: "number" }).notNull().default(0),
		enabled: boolean("enabled").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("ref_urls_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "ref_urls_workspace_org_fk",
		}).onDelete("restrict"),
		foreignKey({
			columns: [table.automationId, table.organizationId, table.scopeKey],
			foreignColumns: [
				automations.id,
				automations.organizationId,
				automations.scopeKey,
			],
			name: "ref_urls_automation_org_scope_fk",
		}),
		foreignKey({
			columns: [table.landingPageId, table.organizationId, table.scopeKey],
			foreignColumns: [
				landingPages.id,
				landingPages.organizationId,
				landingPages.scopeKey,
			],
			name: "ref_urls_landing_page_org_scope_fk",
		}).onDelete("restrict"),
		uniqueIndex("ref_urls_org_scope_slug_uniq").on(
			table.organizationId,
			table.scopeKey,
			table.slug,
		),
		check(
			"ref_urls_slug_format_check",
			sql`${table.slug} ~ '^[a-z0-9][a-z0-9_-]{0,99}$'`,
		),
		check(
			"ref_urls_destination_type_check",
			sql`${table.destinationType} IN ('https_url', 'landing_page')`,
		),
		check(
			"ref_urls_destination_union_check",
			sql`(${table.destinationType} = 'https_url'
					AND ${table.destinationUrl} IS NOT NULL
					AND ${table.destinationUrl} ~ '^https://'
					AND ${table.landingPageId} IS NULL)
				OR (${table.destinationType} = 'landing_page'
					AND ${table.destinationUrl} IS NULL
					AND ${table.landingPageId} IS NOT NULL)`,
		),
		check(
			"ref_urls_uses_safe_integer_check",
			sql`${table.uses} BETWEEN 0 AND 9007199254740991`,
		),
		check(
			"ref_urls_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}`,
		),
		index("ref_urls_automation_idx").on(table.automationId),
		index("ref_urls_landing_page_idx").on(table.landingPageId),
	],
);

export const qrCodes = pgTable(
	"qr_codes",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("qr_")),
		publicId: text("public_id")
			.notNull()
			.unique()
			.$defaultFn(() => generateId("qrp_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		refUrlId: text("ref_url_id").notNull(),
		label: text("label").notNull(),
		campaignKey: text("campaign_key"),
		scanCount: bigint("scan_count", { mode: "number" }).notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("qr_codes_id_org_scope_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
		),
		foreignKey({
			columns: [table.refUrlId, table.organizationId, table.scopeKey],
			foreignColumns: [refUrls.id, refUrls.organizationId, refUrls.scopeKey],
			name: "qr_codes_ref_url_org_scope_fk",
		}).onDelete("cascade"),
		uniqueIndex("qr_codes_ref_url_label_uniq").on(
			table.refUrlId,
			sql`lower(${table.label})`,
		),
		check(
			"qr_codes_scan_count_safe_integer_check",
			sql`${table.scanCount} BETWEEN 0 AND 9007199254740991`,
		),
		check(
			"qr_codes_public_id_format_check",
			sql`${table.publicId} ~ '^qrp_[0-9a-f]{32}$'`,
		),
		check(
			"qr_codes_label_check",
			sql`length(btrim(${table.label})) BETWEEN 1 AND 120`,
		),
		check(
			"qr_codes_campaign_key_check",
			sql`${table.campaignKey} IS NULL OR ${table.campaignKey} ~ '^[a-z0-9][a-z0-9_-]{0,99}$'`,
		),
		check(
			"qr_codes_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}`,
		),
		index("qr_codes_org_scope_created_idx").on(
			table.organizationId,
			table.scopeKey,
			table.createdAt,
			table.id,
		),
		index("qr_codes_ref_url_idx").on(table.refUrlId),
	],
);

/**
 * Immutable public-growth occurrence plus its durable automation-dispatch
 * state. One row is the idempotency fence for aggregate counters and the
 * outbox work item, so a request can never commit a count without its event.
 */
export const publicGrowthEvents = pgTable(
	"public_growth_events",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("pge_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		eventType: text("event_type", {
			enum: [...PUBLIC_GROWTH_EVENT_TYPES],
		}).notNull(),
		refUrlId: text("ref_url_id"),
		qrCodeId: text("qr_code_id"),
		landingPageId: text("landing_page_id"),
		contactId: text("contact_id"),
		contactOrganizationId: text("contact_organization_id"),
		contactScopeKey: text("contact_scope_key"),
		automationId: text("automation_id"),
		automationOrganizationId: text("automation_organization_id"),
		automationScopeKey: text("automation_scope_key"),
		idempotencyHash: varchar("idempotency_hash", { length: 64 }).notNull(),
		status: text("status", {
			enum: ["pending", "processing", "retry", "succeeded", "failed"],
		})
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		lastError: text("last_error"),
		occurredAt: timestamp("occurred_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		foreignKey({
			columns: [table.refUrlId, table.organizationId, table.scopeKey],
			foreignColumns: [refUrls.id, refUrls.organizationId, refUrls.scopeKey],
			name: "public_growth_events_ref_url_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.qrCodeId, table.organizationId, table.scopeKey],
			foreignColumns: [qrCodes.id, qrCodes.organizationId, qrCodes.scopeKey],
			name: "public_growth_events_qr_code_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.landingPageId, table.organizationId, table.scopeKey],
			foreignColumns: [
				landingPages.id,
				landingPages.organizationId,
				landingPages.scopeKey,
			],
			name: "public_growth_events_landing_page_org_scope_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [
				table.contactId,
				table.contactOrganizationId,
				table.contactScopeKey,
			],
			foreignColumns: [contacts.id, contacts.organizationId, contacts.scopeKey],
			name: "public_growth_events_contact_org_scope_fk",
		}).onDelete("set null"),
		foreignKey({
			columns: [
				table.automationId,
				table.automationOrganizationId,
				table.automationScopeKey,
			],
			foreignColumns: [
				automations.id,
				automations.organizationId,
				automations.scopeKey,
			],
			name: "public_growth_events_automation_org_scope_fk",
		}).onDelete("set null"),
		uniqueIndex("public_growth_events_idempotency_uniq").on(
			table.organizationId,
			table.eventType,
			sql`COALESCE(${table.refUrlId}, ${table.qrCodeId}, ${table.landingPageId})`,
			table.idempotencyHash,
		),
		check(
			"public_growth_events_type_check",
			sql`${table.eventType} IN ('ref_visit', 'qr_scan', 'landing_view', 'landing_conversion')`,
		),
		check(
			"public_growth_events_target_union_check",
			sql`(${table.eventType} = 'ref_visit'
					AND ${table.refUrlId} IS NOT NULL
					AND ${table.qrCodeId} IS NULL
					AND ${table.landingPageId} IS NULL)
				OR (${table.eventType} = 'qr_scan'
					AND ${table.refUrlId} IS NULL
					AND ${table.qrCodeId} IS NOT NULL
					AND ${table.landingPageId} IS NULL)
				OR (${table.eventType} IN ('landing_view', 'landing_conversion')
					AND ${table.refUrlId} IS NULL
					AND ${table.qrCodeId} IS NULL
					AND ${table.landingPageId} IS NOT NULL)`,
		),
		check(
			"public_growth_events_contact_scope_check",
			sql`(${table.contactId} IS NULL
					AND ${table.contactOrganizationId} IS NULL
					AND ${table.contactScopeKey} IS NULL)
				OR (${table.contactId} IS NOT NULL
					AND ${table.contactOrganizationId} = ${table.organizationId}
					AND ${table.contactScopeKey} = ${table.scopeKey})`,
		),
		check(
			"public_growth_events_automation_scope_check",
			sql`(${table.automationId} IS NULL
					AND ${table.automationOrganizationId} IS NULL
					AND ${table.automationScopeKey} IS NULL)
				OR (${table.automationId} IS NOT NULL
					AND ${table.automationOrganizationId} = ${table.organizationId}
					AND ${table.automationScopeKey} = ${table.scopeKey})`,
		),
		check(
			"public_growth_events_idempotency_hash_check",
			sql`${table.idempotencyHash} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"public_growth_events_status_check",
			sql`${table.status} IN ('pending', 'processing', 'retry', 'succeeded', 'failed')`,
		),
		check(
			"public_growth_events_counters_check",
			sql`${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"public_growth_events_lease_state_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"public_growth_events_terminal_state_check",
			sql`(${table.status} IN ('succeeded', 'failed') AND ${table.completedAt} IS NOT NULL)
				OR (${table.status} NOT IN ('succeeded', 'failed') AND ${table.completedAt} IS NULL)`,
		),
		check(
			"public_growth_events_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.occurredAt}
				AND ${table.nextAttemptAt} >= ${table.occurredAt}
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.occurredAt})`,
		),
		index("public_growth_events_due_dispatch_idx")
			.on(table.nextAttemptAt, table.organizationId, table.occurredAt, table.id)
			.where(sql`${table.status} IN ('pending', 'retry')`),
		index("public_growth_events_stale_lease_idx")
			.on(
				table.leaseExpiresAt,
				table.organizationId,
				table.occurredAt,
				table.id,
			)
			.where(sql`${table.status} = 'processing'`),
		index("public_growth_events_ref_target_idx")
			.on(table.refUrlId, table.organizationId, table.scopeKey)
			.where(sql`${table.refUrlId} IS NOT NULL`),
		index("public_growth_events_qr_target_idx")
			.on(table.qrCodeId, table.organizationId, table.scopeKey)
			.where(sql`${table.qrCodeId} IS NOT NULL`),
		index("public_growth_events_landing_target_idx")
			.on(table.landingPageId, table.organizationId, table.scopeKey)
			.where(sql`${table.landingPageId} IS NOT NULL`),
		index("public_growth_events_automation_idx")
			.on(
				table.automationId,
				table.automationOrganizationId,
				table.automationScopeKey,
			)
			.where(sql`${table.automationId} IS NOT NULL`),
		index("public_growth_events_contact_idx").on(
			table.organizationId,
			table.contactId,
			table.contactScopeKey,
			table.occurredAt,
		),
		index("public_growth_events_retention_idx")
			.on(table.completedAt, table.id)
			.where(sql`${table.status} IN ('succeeded', 'failed')`),
	],
);

// ---------------------------------------------------------------------------
// Async tools
// PostgreSQL is the durable lifecycle authority. Queue carries only this row's
// identifier; request/result detail is encrypted by the application and is
// shredded on the fixed terminal retention clock.
// ---------------------------------------------------------------------------

export const toolJobs = pgTable(
	"tool_jobs",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: [...TOOL_JOB_KINDS] }).notNull(),
		status: text("status", {
			enum: ["pending", "processing", "completed", "failed", "manual_review"],
		})
			.notNull()
			.default("pending"),
		requestCiphertext: text("request_ciphertext"),
		resultCiphertext: text("result_ciphertext"),
		errorCiphertext: text("error_ciphertext"),
		errorCode: text("error_code"),
		usageReservationId: text("usage_reservation_id").notNull(),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		purgeAt: timestamp("purge_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		foreignKey({
			columns: [table.usageReservationId, table.organizationId],
			foreignColumns: [usageReservations.id, usageReservations.organizationId],
			name: "tool_jobs_usage_reservation_org_fk",
		}).onDelete("cascade"),
		uniqueIndex("tool_jobs_usage_reservation_uniq").on(
			table.usageReservationId,
		),
		check(
			"tool_jobs_kind_check",
			sql`${table.kind} IN ('download', 'transcript')`,
		),
		check(
			"tool_jobs_status_check",
			sql`${table.status} IN ('pending', 'processing', 'completed', 'failed', 'manual_review')`,
		),
		check(
			"tool_jobs_counters_check",
			sql`${table.attempts} BETWEEN 0 AND 3 AND ${table.leaseToken} >= 0`,
		),
		check(
			"tool_jobs_lease_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"tool_jobs_payload_state_check",
			sql`(${table.status} = 'pending'
						AND ${table.requestMayHaveBeenSentAt} IS NULL
						AND ${table.requestCiphertext} IS NOT NULL
						AND ${table.resultCiphertext} IS NULL
						AND ${table.errorCiphertext} IS NULL
						AND ${table.errorCode} IS NULL
						AND ${table.completedAt} IS NULL)
					OR (${table.status} = 'processing'
						AND ${table.requestCiphertext} IS NOT NULL
						AND ${table.resultCiphertext} IS NULL
						AND ${table.errorCiphertext} IS NULL
					AND ${table.errorCode} IS NULL
					AND ${table.completedAt} IS NULL)
					OR (${table.status} = 'completed'
						AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
						AND ${table.requestCiphertext} IS NULL
						AND ${table.resultCiphertext} IS NOT NULL
					AND ${table.errorCiphertext} IS NULL
						AND ${table.errorCode} IS NULL
						AND ${table.completedAt} IS NOT NULL)
					OR (${table.status} = 'manual_review'
						AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
						AND ${table.requestCiphertext} IS NOT NULL
						AND ${table.resultCiphertext} IS NULL
						AND ${table.errorCiphertext} IS NOT NULL
						AND ${table.errorCode} = 'PROVIDER_OUTCOME_UNKNOWN'
						AND ${table.completedAt} IS NOT NULL)
					OR (${table.status} = 'failed'
					AND ${table.requestCiphertext} IS NULL
					AND ${table.resultCiphertext} IS NULL
					AND ${table.errorCiphertext} IS NOT NULL
					AND ${table.errorCode} IS NOT NULL
					AND ${table.completedAt} IS NOT NULL)`,
		),
		check(
			"tool_jobs_ciphertext_check",
			sql`(${table.requestCiphertext} IS NULL OR ${table.requestCiphertext} LIKE 'enc:v2:%')
				AND (${table.resultCiphertext} IS NULL OR ${table.resultCiphertext} LIKE 'enc:v2:%')
				AND (${table.errorCiphertext} IS NULL OR ${table.errorCiphertext} LIKE 'enc:v2:%')`,
		),
		check(
			"tool_jobs_timestamps_check",
			sql`${table.deadlineAt} > ${table.createdAt}
					AND ${table.purgeAt} > ${table.createdAt}
					AND ${table.nextAttemptAt} >= ${table.createdAt}
					AND (${table.lastEnqueuedAt} IS NULL OR ${table.lastEnqueuedAt} >= ${table.createdAt})
					AND (${table.requestMayHaveBeenSentAt} IS NULL OR ${table.requestMayHaveBeenSentAt} >= ${table.createdAt})
					AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
		),
		index("tool_jobs_due_idx")
			.on(table.nextAttemptAt, table.id)
			.where(sql`${table.status} = 'pending'`),
		index("tool_jobs_pending_deadline_idx")
			.on(table.deadlineAt, table.id)
			.where(sql`${table.status} = 'pending'`),
		index("tool_jobs_stale_lease_idx")
			.on(table.leaseExpiresAt, table.id)
			.where(
				sql`${table.status} = 'processing' AND ${table.requestMayHaveBeenSentAt} IS NULL`,
			),
		index("tool_jobs_armed_lease_idx")
			.on(table.leaseExpiresAt, table.deadlineAt, table.id)
			.where(
				sql`${table.status} = 'processing' AND ${table.requestMayHaveBeenSentAt} IS NOT NULL`,
			),
		index("tool_jobs_org_created_idx").on(
			table.organizationId,
			table.createdAt,
			table.id,
		),
		index("tool_jobs_purge_idx").on(table.purgeAt, table.id),
	],
);
