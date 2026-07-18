import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	bigserial,
	boolean,
	check,
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
} from "drizzle-orm/pg-core";

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
			.references(() => user.id),
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
	],
);

export const account = authSchema.table("account", {
	id: text("id").primaryKey(),
	userId: text("userId")
		.notNull()
		.references(() => user.id),
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

export const verification = authSchema.table("verification", {
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
});

export const apikey = authSchema.table(
	"apikey",
	{
		id: text("id").primaryKey(),
		configId: text("configId").default("default"),
		name: text("name"),
		start: text("start"),
		prefix: text("prefix"),
		key: text("key").notNull(), // hashed
		referenceId: text("referenceId"), // points to user.id (who created the key)
		organizationId: text("organizationId"), // the org this key belongs to
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
		createdAt: timestamp("createdAt", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("apikey_id_organization_uniq").on(table.id, table.organizationId),
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
	],
);

export const invitation = authSchema.table("invitation", {
	id: text("id").primaryKey(),
	email: text("email").notNull(),
	inviterId: text("inviterId")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	role: text("role"),
	status: text("status").notNull(),
	expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
	createdAt: timestamp("createdAt", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

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

export const platformEnum = pgEnum("platform", [
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
]);

export const postStatusEnum = pgEnum("post_status", [
	"draft",
	"scheduled",
	"publishing",
	"published",
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
		index("workspaces_org_lifecycle_idx").on(
			table.organizationId,
			table.lifecycleStatus,
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
			enum: ["pending", "processing", "manual_review", "failed", "purged"],
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
			sql`${table.status} IN ('pending', 'processing', 'manual_review', 'failed', 'purged')`,
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
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.requestedAt})`,
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
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		check(
			"tenant_deletion_jobs_status_check",
			sql`${table.status} IN ('pending', 'processing', 'tombstoned', 'waiting_external', 'manual_review', 'failed', 'purged')`,
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
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.requestedAt})`,
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
			.references(() => user.id),
		tokenHash: text("token_hash").notNull(),
		scope: text("scope").notNull(), // "all" | "workspaces"
		scopedWorkspaceIds: jsonb("scoped_workspace_ids").$type<string[]>(),
		role: text("role").notNull(), // "owner" | "admin" | "member"
		used: boolean("used").notNull().default(false),
		usedBy: text("used_by").references(() => user.id),
		usedAt: timestamp("used_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("invite_tokens_org_idx").on(table.organizationId),
		uniqueIndex("invite_tokens_hash_idx").on(table.tokenHash),
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
			enum: ["pending", "processing", "retry", "manual_required", "succeeded"],
		})
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
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
			sql`${table.status} IN ('pending', 'processing', 'retry', 'manual_required', 'succeeded')`,
		),
		check(
			"account_revocation_jobs_counters_nonnegative_check",
			sql`${table.attempts} >= 0 AND ${table.sourceTokenVersion} >= 0`,
		),
		check(
			"account_revocation_jobs_lease_state_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"account_revocation_jobs_completion_check",
			sql`(${table.status} IN ('manual_required', 'succeeded') AND ${table.completedAt} IS NOT NULL)
				OR (${table.status} NOT IN ('manual_required', 'succeeded') AND ${table.completedAt} IS NULL)`,
		),
		check(
			"account_revocation_jobs_success_redaction_check",
			sql`${table.status} <> 'succeeded'
				OR (${table.accessTokenCiphertext} IS NULL AND ${table.refreshTokenCiphertext} IS NULL)`,
		),
		check(
			"account_revocation_jobs_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
		),
		index("account_revocation_jobs_due_idx").on(
			table.status,
			table.nextAttemptAt,
		),
		index("account_revocation_jobs_org_idx").on(table.organizationId),
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
		createdBy: text("created_by").references(() => user.id),
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
		check("posts_revision_nonnegative_check", sql`${table.revision} >= 0`),
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
			.on(table.metricsCollectedAt)
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
		platformUrl: text("platform_url"),
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
					AND ${table.status} = 'published'
					AND ${table.publishedAt} IS NOT NULL)
				OR (${table.deliveryState} = 'failed' AND ${table.status} = 'failed')`,
		),
		check(
			"post_targets_lease_order_check",
			sql`${table.leaseExpiresAt} IS NULL OR (${table.claimedAt} IS NOT NULL AND ${table.leaseExpiresAt} > ${table.claimedAt})`,
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
		error: text("error"),
	},
	(table) => [
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
		index("publish_attempts_target_claimed_idx").on(
			table.postTargetId,
			table.claimedAt,
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
		kind: text("kind", {
			enum: ["publish", "publish_thread", "notification", "post_completion"],
		}).notNull(),
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
		url: text("url"),
		// Durable, hyper-optimized preview. Stored in a separate, never-expiring R2
		// bucket so card/list previews survive after the full-res original is purged
		// by the relayapi-media lifecycle rule. thumbnailUrl is a stable public URL.
		thumbnailKey: text("thumbnail_key"),
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
		uploadedBy: text("uploaded_by").references(() => user.id),
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
		index("media_org_idx").on(table.organizationId),
		index("media_workspace_idx").on(table.workspaceId),
		uniqueIndex("media_storage_key_uniq").on(
			table.storageProvider,
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
			enum: ["pending", "in_flight", "succeeded", "failed", "unknown"],
		})
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		statusCode: integer("status_code"),
		responseTimeMs: integer("response_time_ms"),
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
			sql`${table.status} IN ('pending', 'in_flight', 'succeeded', 'failed', 'unknown')`,
		),
		check(
			"webhook_deliveries_counters_nonnegative_check",
			sql`${table.attempts} >= 0 AND ${table.dispatchAttempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"webhook_deliveries_http_values_check",
			sql`(${table.statusCode} IS NULL OR (${table.statusCode} >= 100 AND ${table.statusCode} <= 599)) AND (${table.responseTimeMs} IS NULL OR ${table.responseTimeMs} >= 0)`,
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
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		statusCode: integer("status_code"),
		responseTimeMs: integer("response_time_ms"),
		success: boolean("success").notNull().default(false),
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
		check(
			"webhook_logs_http_values_check",
			sql`(${table.statusCode} IS NULL OR ${table.statusCode} BETWEEN 100 AND 599)
				AND (${table.responseTimeMs} IS NULL OR ${table.responseTimeMs} >= 0)`,
		),
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
		),
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
			"api_request_logs_http_values_check",
			sql`${table.statusCode} BETWEEN 100 AND 599 AND ${table.responseTimeMs} >= 0`,
		),
		index("api_request_logs_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("api_request_logs_api_key_idx").on(table.apiKeyId),
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
		operationId: text("operation_id"),
		failureKind: text("failure_kind", {
			enum: ["permanent_input", "unknown_external_outcome", "dead_letter"],
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
		payload: jsonb("payload").notNull(),
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
		index("queue_failures_status_created_idx").on(
			table.status,
			table.createdAt,
		),
		index("queue_failures_operation_idx").on(table.operationId),
		index("queue_failures_organization_ids_idx").using(
			"gin",
			table.organizationIds,
		),
		index("queue_failures_replay_claim_idx").on(
			table.status,
			table.replayClaimExpiresAt,
		),
	],
);

export const emailDeliveries = pgTable(
	"email_deliveries",
	{
		id: text("id").primaryKey(),
		status: text("status", {
			enum: ["pending", "unknown", "sent", "failed"],
		})
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		requestMayHaveBeenSentAt: timestamp("request_may_have_been_sent_at", {
			withTimezone: true,
		}),
		providerMessageId: text("provider_message_id"),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		check(
			"email_deliveries_status_check",
			sql`${table.status} IN ('pending', 'unknown', 'sent', 'failed')`,
		),
		check(
			"email_deliveries_attempts_nonnegative_check",
			sql`${table.attempts} >= 0`,
		),
		check(
			"email_deliveries_state_fields_check",
			sql`(${table.status} = 'pending' AND ${table.completedAt} IS NULL)
				OR (${table.status} = 'unknown'
					AND ${table.completedAt} IS NULL)
				OR (${table.status} IN ('sent', 'failed')
					AND ${table.requestMayHaveBeenSentAt} IS NOT NULL
					AND ${table.completedAt} IS NOT NULL)`,
		),
		check(
			"email_deliveries_timestamp_order_check",
			sql`(${table.requestMayHaveBeenSentAt} IS NULL OR ${table.requestMayHaveBeenSentAt} >= ${table.createdAt})
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
		),
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
		index("idempotency_receipts_expiry_idx").on(table.expiresAt),
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
		kind: text("kind", { enum: ["oauth_state", "websocket_ticket"] }).notNull(),
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
		index("one_time_capabilities_expiry_idx").on(table.expiresAt),
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
		trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
		postsIncluded: integer("posts_included").notNull().default(1000),
		pricePerPostCents: integer("price_per_post_cents").notNull().default(1),
		monthlyPriceCents: integer("monthly_price_cents").notNull().default(500),
		currentPeriodStart: timestamp("current_period_start", {
			withTimezone: true,
		})
			.defaultNow()
			.notNull(),
		currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
		stripeCustomerId: text("stripe_customer_id"),
		stripeSubscriptionId: text("stripe_subscription_id"),
		stripeMeteredItemId: text("stripe_metered_item_id"),
		cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
		aiEnabled: boolean("ai_enabled").notNull().default(false),
		dailyToolLimit: integer("daily_tool_limit").notNull().default(2),
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
			"organization_subscriptions_numeric_check",
			sql`${table.postsIncluded} >= 0
				AND ${table.pricePerPostCents} >= 0
				AND ${table.monthlyPriceCents} >= 0
				AND ${table.dailyToolLimit} >= 0`,
		),
		check(
			"organization_subscriptions_period_check",
			sql`${table.currentPeriodEnd} IS NULL OR ${table.currentPeriodEnd} > ${table.currentPeriodStart}`,
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
 * Durable Stripe webhook inbox. Stripe event IDs never expire locally and are
 * the atomic deduplication key; the lease fields make interrupted processing
 * recoverable without relying on eventually-consistent KV.
 */
export const stripeEvents = pgTable(
	"stripe_events",
	{
		id: text("id").primaryKey(),
		type: text("type").notNull(),
		objectId: text("object_id"),
		customerId: text("customer_id"),
		subscriptionId: text("subscription_id"),
		payload: jsonb("payload").notNull(),
		status: text("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		lastError: text("last_error"),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		stripeCreatedAt: timestamp("stripe_created_at", {
			withTimezone: true,
		}).notNull(),
		receivedAt: timestamp("received_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		processedAt: timestamp("processed_at", { withTimezone: true }),
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
			"stripe_events_lease_state_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"stripe_events_completion_check",
			sql`${table.status} <> 'succeeded' OR ${table.processedAt} IS NOT NULL`,
		),
		check(
			"stripe_events_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.receivedAt}
				AND (${table.processedAt} IS NULL OR ${table.processedAt} >= ${table.receivedAt})`,
		),
		index("stripe_events_status_lease_idx").on(
			table.status,
			table.leaseExpiresAt,
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
		kind: text("kind").notNull(),
		payload: jsonb("payload").notNull(),
		status: text("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		lastError: text("last_error"),
		processedAt: timestamp("processed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"billing_outbox_status_check",
			sql`${table.status} IN ('pending', 'processing', 'succeeded', 'failed')`,
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
			sql`(${table.status} = 'succeeded' AND ${table.processedAt} IS NOT NULL)
				OR (${table.status} <> 'succeeded' AND ${table.processedAt} IS NULL)`,
		),
		check(
			"billing_outbox_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND (${table.processedAt} IS NULL OR ${table.processedAt} >= ${table.createdAt})`,
		),
		index("billing_outbox_status_due_idx").on(
			table.status,
			table.nextAttemptAt,
		),
		index("billing_outbox_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
	],
);

// ---------------------------------------------------------------------------
// Usage authority and compatibility projection.
// ---------------------------------------------------------------------------

/** Authoritative quota bucket; counters are updated atomically with reservations. */
export const usageBuckets = pgTable(
	"usage_buckets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ub_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		metric: text("metric").notNull().default("successful_mutation"),
		periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
		periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
		includedUnits: integer("included_units").notNull(),
		committedUnits: integer("committed_units").notNull().default(0),
		reservedUnits: integer("reserved_units").notNull().default(0),
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
			sql`${table.includedUnits} >= 0 AND ${table.committedUnits} >= 0 AND ${table.reservedUnits} >= 0 AND ${table.revision} >= 0`,
		),
		index("usage_buckets_org_period_end_idx").on(
			table.organizationId,
			table.periodEnd,
		),
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
		units: integer("units").notNull().default(1),
		state: text("state", {
			enum: ["reserved", "committed", "released"],
		})
			.notNull()
			.default("reserved"),
		responseStatus: integer("response_status"),
		source: text("source").notNull().default("api"),
		reservedAt: timestamp("reserved_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
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
		check("usage_reservations_units_positive_check", sql`${table.units} > 0`),
		check(
			"usage_reservations_state_check",
			sql`${table.state} IN ('reserved', 'committed', 'released')`,
		),
		check(
			"usage_reservations_finalization_check",
			sql`(${table.state} = 'reserved' AND ${table.finalizedAt} IS NULL) OR (${table.state} <> 'reserved' AND ${table.finalizedAt} IS NOT NULL)`,
		),
		check(
			"usage_reservations_response_status_check",
			sql`${table.responseStatus} IS NULL OR (${table.responseStatus} >= 100 AND ${table.responseStatus} <= 599)`,
		),
		index("usage_reservations_bucket_state_idx").on(
			table.bucketId,
			table.state,
		),
	],
);

/**
 * Legacy compatibility projection for old billing/reporting readers. New live
 * mutation accounting and invoice settlement use usageBuckets/reservations.
 */
export const usageRecords = pgTable(
	"usage_records",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("usage_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
		periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
		postsCount: integer("posts_count").notNull().default(0),
		postsIncluded: integer("posts_included").notNull().default(1000),
		overagePosts: integer("overage_posts").notNull().default(0),
		overageCostCents: integer("overage_cost_cents").notNull().default(0),
		apiCallsCount: integer("api_calls_count").notNull().default(0),
		apiCallsIncluded: integer("api_calls_included").notNull().default(10000),
		overageCalls: integer("overage_calls").notNull().default(0),
		overageCallsCostCents: integer("overage_calls_cost_cents")
			.notNull()
			.default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		// NULL = overage for this period has not yet been billed to Stripe.
		// Set to the billing timestamp once an overage invoice item is created,
		// so the monthly invoice cron is idempotent and never double-bills.
		billedAt: timestamp("billed_at", { withTimezone: true }),
	},
	(table) => [
		unique("usage_records_id_org_uniq").on(table.id, table.organizationId),
		uniqueIndex("usage_records_org_period_idx").on(
			table.organizationId,
			table.periodStart,
		),
		check(
			"usage_records_period_check",
			sql`${table.periodEnd} > ${table.periodStart}`,
		),
		check(
			"usage_records_counts_nonnegative_check",
			sql`${table.postsCount} >= 0 AND ${table.postsIncluded} >= 0 AND ${table.overagePosts} >= 0 AND ${table.overageCostCents} >= 0 AND ${table.apiCallsCount} >= 0 AND ${table.apiCallsIncluded} >= 0 AND ${table.overageCalls} >= 0 AND ${table.overageCallsCostCents} >= 0`,
		),
	],
);

// ---------------------------------------------------------------------------
// BYOS (Bring Your Own Storage) configs
// ---------------------------------------------------------------------------

export const byosConfigs = pgTable("byos_configs", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => generateId("")),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id)
		.unique(),
	endpoint: text("endpoint").notNull(),
	bucket: text("bucket").notNull(),
	region: text("region"),
	accessKeyId: text("access_key_id").notNull(), // encrypted: AES-256-GCM
	secretAccessKey: text("secret_access_key").notNull(), // encrypted: AES-256-GCM
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

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
		apiCallsCount: integer("api_calls_count").notNull().default(0),
		apiCallsIncluded: integer("api_calls_included").notNull().default(10000),
		overageCalls: integer("overage_calls").notNull().default(0),
		overageCostCents: integer("overage_cost_cents").notNull().default(0),
		totalCents: integer("total_cents").notNull().default(0),
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
			"invoices_failure_not_draft_check",
			sql`${table.firstPaymentFailedAt} IS NULL OR ${table.status} <> 'draft'`,
		),
	],
);

/**
 * Exactly-once invoice settlement claim for a usage bucket. Multiple bucket
 * settlements may link to one invoice, while UNIQUE(bucket_id) makes a retry
 * resume the original claim instead of billing the same bucket twice.
 */
export const usageBucketSettlements = pgTable(
	"usage_bucket_settlements",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ubs_")),
		organizationId: text("organization_id").notNull(),
		bucketId: text("bucket_id").notNull(),
		settlementKey: text("settlement_key").notNull().unique(),
		invoiceId: text("invoice_id"),
		state: text("state", {
			enum: ["claimed", "settled", "released"],
		})
			.notNull()
			.default("claimed"),
		committedUnitsSnapshot: integer("committed_units_snapshot").notNull(),
		amountCents: integer("amount_cents").notNull().default(0),
		currency: varchar("currency", { length: 3 }).notNull().default("usd"),
		revision: integer("revision").notNull().default(0),
		claimedAt: timestamp("claimed_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		settledAt: timestamp("settled_at", { withTimezone: true }),
		releasedAt: timestamp("released_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("usage_bucket_settlements_id_org_uniq").on(
			table.id,
			table.organizationId,
		),
		foreignKey({
			columns: [table.bucketId, table.organizationId],
			foreignColumns: [usageBuckets.id, usageBuckets.organizationId],
			name: "usage_bucket_settlements_bucket_org_fk",
		}).onDelete("restrict"),
		foreignKey({
			columns: [table.invoiceId, table.organizationId],
			foreignColumns: [invoices.id, invoices.organizationId],
			name: "usage_bucket_settlements_invoice_org_fk",
		}).onDelete("restrict"),
		uniqueIndex("usage_bucket_settlements_bucket_uniq").on(table.bucketId),
		check(
			"usage_bucket_settlements_state_check",
			sql`${table.state} IN ('claimed', 'settled', 'released')`,
		),
		check(
			"usage_bucket_settlements_numeric_check",
			sql`${table.committedUnitsSnapshot} >= 0 AND ${table.amountCents} >= 0 AND ${table.revision} >= 0`,
		),
		check(
			"usage_bucket_settlements_finalization_check",
			sql`(${table.state} = 'claimed' AND ${table.invoiceId} IS NULL AND ${table.settledAt} IS NULL AND ${table.releasedAt} IS NULL)
				OR (${table.state} = 'settled' AND ${table.invoiceId} IS NOT NULL AND ${table.settledAt} IS NOT NULL AND ${table.releasedAt} IS NULL)
				OR (${table.state} = 'released' AND ${table.invoiceId} IS NULL AND ${table.settledAt} IS NULL AND ${table.releasedAt} IS NOT NULL)`,
		),
		index("usage_bucket_settlements_invoice_idx").on(table.invoiceId),
		index("usage_bucket_settlements_state_idx").on(
			table.state,
			table.claimedAt,
		),
	],
);

/**
 * Durable Stripe mutation state. Each operation owns exactly one usage-bucket
 * settlement, so unknown Stripe outcomes can be reconciled without falling
 * back to the legacy usage-record projection.
 */
export const billingOperations = pgTable(
	"billing_operations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("bop_")),
		organizationId: text("organization_id").notNull(),
		usageBucketSettlementId: text("usage_bucket_settlement_id")
			.notNull()
			.unique(),
		status: text("status").notNull().default("pending"),
		stripeCustomerId: text("stripe_customer_id").notNull(),
		stripeInvoiceItemId: text("stripe_invoice_item_id"),
		idempotencyKey: text("idempotency_key").notNull().unique(),
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
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.usageBucketSettlementId, table.organizationId],
			foreignColumns: [
				usageBucketSettlements.id,
				usageBucketSettlements.organizationId,
			],
			name: "billing_operations_usage_bucket_settlement_org_fk",
		}).onDelete("restrict"),
		check(
			"billing_operations_status_check",
			sql`${table.status} IN ('pending', 'processing', 'failed', 'unknown', 'succeeded', 'terminal_failed')`,
		),
		check(
			"billing_operations_numeric_check",
			sql`${table.amountCents} >= 0 AND ${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"billing_operations_lease_state_check",
			sql`(${table.status} = 'processing' AND ${table.leaseExpiresAt} IS NOT NULL)
				OR (${table.status} <> 'processing' AND ${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"billing_operations_completion_check",
			sql`${table.status} <> 'succeeded'
				OR (${table.stripeInvoiceItemId} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`,
		),
		check(
			"billing_operations_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
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
		providerMessageId: text("provider_message_id"),
		attempts: integer("attempts").notNull().default(0),
		leaseToken: integer("lease_token").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
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
			table.nextAttemptAt,
			table.leaseExpiresAt,
		),
	],
);

// ---------------------------------------------------------------------------
// User preferences (timezone, language, etc.)
// ---------------------------------------------------------------------------

export const userPreferences = pgTable("user_preferences", {
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
});

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
		type: text("type").notNull(), // post_failed, post_published, account_disconnected, payment_failed, usage_warning, weekly_digest, marketing
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

export const conversationTypeEnum = pgEnum("conversation_type", [
	"comment_thread",
	"dm",
	"review",
]);

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
		lastMessageDirection: text("last_message_direction"),
		// AI enrichment
		sentimentAvg: integer("sentiment_avg"),
		// Contact link
		contactId: text("contact_id").references(() => contacts.id, {
			onDelete: "set null",
		}),
		assignedUserId: text("assigned_user_id").references(() => user.id, {
			onDelete: "set null",
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
		index("inbox_conv_assigned_user_idx").on(table.assignedUserId),
		// Cron archive/sweep scans open conversations by recency.
		index("inbox_conv_open_last_message_idx")
			.on(table.lastMessageAt)
			.where(sql`${table.status} = 'open'`),
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
		direction: text("direction").notNull(),
		attachments: jsonb("attachments").default([]),
		// AI enrichment
		sentimentScore: integer("sentiment_score"),
		classification: text("classification"),
		// Platform-specific
		platformData: jsonb("platform_data").default({}),
		isHidden: boolean("is_hidden").default(false),
		isLiked: boolean("is_liked").default(false),
		// Timestamps
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
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
		// Backs the leading-wildcard ILIKE in inbox message search. Requires the
		// pg_trgm extension (enabled in the generated migration).
		index("inbox_msg_text_trgm_idx").using(
			"gin",
			sql`${table.text} gin_trgm_ops`,
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
			enum: ["dashboard_user", "service"],
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
		// The phone row is also the durable purchase ledger. Search is read-only;
		// this operation is committed before the first chargeable provider call.
		provisioningOperationId: text("provisioning_operation_id")
			.notNull()
			.$defaultFn(() => generateId("wpo_")),
		provisioningOperationKeyHash: varchar("provisioning_operation_key_hash", {
			length: 64,
		}).notNull(),
		provisioningRequestHash: varchar("provisioning_request_hash", {
			length: 64,
		}).notNull(),
		provisioningSourceAccountId: text("provisioning_source_account_id"),
		provisioningState: text("provisioning_state", {
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
		provisioningPhase: text("provisioning_phase", {
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
		provisioningRequest: jsonb("provisioning_request")
			.notNull()
			.default(sql`'{}'::jsonb`),
		provisioningLeaseToken: integer("provisioning_lease_token")
			.notNull()
			.default(0),
		provisioningLeaseExpiresAt: timestamp("provisioning_lease_expires_at", {
			withTimezone: true,
		}),
		provisioningRequestMayHaveBeenSentAt: timestamp(
			"provisioning_request_may_have_been_sent_at",
			{ withTimezone: true },
		),
		provisioningAttempts: integer("provisioning_attempts").notNull().default(0),
		provisioningNextAttemptAt: timestamp("provisioning_next_attempt_at", {
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
		provisioningLastError: text("provisioning_last_error"),
		stripeCheckoutSessionId: text("stripe_checkout_session_id"),
		stripeCheckoutUrl: text("stripe_checkout_url"),
		// Release is an independent fenced operation. Provider identities and the
		// source grant are snapshotted before account revocation can clear them.
		releaseOperationId: text("release_operation_id"),
		releaseReason: text("release_reason", {
			enum: ["user_requested", "tenant_deleted"],
		}),
		releaseState: text("release_state", {
			enum: [
				"pending",
				"processing",
				"request_may_have_been_sent",
				"unknown",
				"manual_review",
				"completed",
				"failed",
			],
		}),
		releasePhase: text("release_phase", {
			enum: ["meta", "stripe", "telnyx", "completed"],
		}),
		releaseMetaStatus: text("release_meta_status", {
			enum: ["pending", "not_required", "confirmed", "unknown"],
		}),
		releaseStripeStatus: text("release_stripe_status", {
			enum: ["pending", "not_required", "confirmed", "unknown"],
		}),
		releaseTelnyxStatus: text("release_telnyx_status", {
			enum: ["pending", "not_required", "confirmed", "unknown"],
		}),
		releaseSourceAccountId: text("release_source_account_id"),
		releaseSourceTokenVersion: integer("release_source_token_version"),
		releaseAccessTokenCiphertext: text("release_access_token_ciphertext"),
		releaseLeaseToken: integer("release_lease_token").notNull().default(0),
		releaseLeaseExpiresAt: timestamp("release_lease_expires_at", {
			withTimezone: true,
		}),
		releaseRequestMayHaveBeenSentAt: timestamp(
			"release_request_may_have_been_sent_at",
			{ withTimezone: true },
		),
		releaseAttempts: integer("release_attempts").notNull().default(0),
		releaseNextAttemptAt: timestamp("release_next_attempt_at", {
			withTimezone: true,
		}),
		releaseLastError: text("release_last_error"),
		releaseRequestedAt: timestamp("release_requested_at", {
			withTimezone: true,
		}),
		releasedAt: timestamp("released_at", { withTimezone: true }),
		verificationMethod: text("verification_method"),
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
		uniqueIndex("wa_phone_numbers_provisioning_operation_uniq").on(
			table.provisioningOperationId,
		),
		uniqueIndex("wa_phone_numbers_provisioning_key_uniq").on(
			table.organizationId,
			table.provisioningOperationKeyHash,
		),
		uniqueIndex("wa_phone_numbers_telnyx_order_uniq").on(table.telnyxOrderId),
		uniqueIndex("wa_phone_numbers_release_operation_uniq").on(
			table.releaseOperationId,
		),
		uniqueIndex("wa_phone_numbers_provider_number_uniq").on(
			table.providerNumberId,
		),
		uniqueIndex("wa_phone_numbers_meta_number_uniq").on(table.waPhoneNumberId),
		check(
			"wa_phone_numbers_status_check",
			sql`${table.status} IN ('purchasing', 'pending_verification', 'verified', 'active', 'releasing', 'released')`,
		),
		check(
			"wa_phone_numbers_provisioning_state_check",
			sql`${table.provisioningState} IN ('pending', 'processing', 'waiting_external', 'request_may_have_been_sent', 'unknown', 'manual_review', 'completed', 'failed', 'cancelled')`,
		),
		check(
			"wa_phone_numbers_provisioning_phase_check",
			sql`${table.provisioningPhase} IN ('selected', 'telnyx_order', 'billing', 'meta_registration', 'completed')`,
		),
		check(
			"wa_phone_numbers_release_state_check",
			sql`${table.releaseState} IS NULL OR ${table.releaseState} IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'manual_review', 'completed', 'failed')`,
		),
		check(
			"wa_phone_numbers_release_phase_check",
			sql`${table.releasePhase} IS NULL OR ${table.releasePhase} IN ('meta', 'stripe', 'telnyx', 'completed')`,
		),
		check(
			"wa_phone_numbers_release_provider_status_check",
			sql`(${table.releaseMetaStatus} IS NULL OR ${table.releaseMetaStatus} IN ('pending', 'not_required', 'confirmed', 'unknown'))
				AND (${table.releaseStripeStatus} IS NULL OR ${table.releaseStripeStatus} IN ('pending', 'not_required', 'confirmed', 'unknown'))
				AND (${table.releaseTelnyxStatus} IS NULL OR ${table.releaseTelnyxStatus} IN ('pending', 'not_required', 'confirmed', 'unknown'))`,
		),
		check(
			"wa_phone_numbers_numeric_check",
			sql`${table.provisioningLeaseToken} >= 0
				AND ${table.provisioningAttempts} >= 0
				AND (${table.releaseSourceTokenVersion} IS NULL OR ${table.releaseSourceTokenVersion} >= 0)
				AND ${table.releaseLeaseToken} >= 0
				AND ${table.releaseAttempts} >= 0
				AND ${table.monthlyCostCents} >= 0`,
		),
		check(
			"wa_phone_numbers_provisioning_lease_state_check",
			sql`(${table.provisioningState} IN ('processing', 'request_may_have_been_sent')
					AND ${table.provisioningLeaseExpiresAt} IS NOT NULL)
				OR (${table.provisioningState} NOT IN ('processing', 'request_may_have_been_sent')
					AND ${table.provisioningLeaseExpiresAt} IS NULL)`,
		),
		check(
			"wa_phone_numbers_provisioning_boundary_check",
			sql`${table.provisioningState} <> 'request_may_have_been_sent'
				OR ${table.provisioningRequestMayHaveBeenSentAt} IS NOT NULL`,
		),
		check(
			"wa_phone_numbers_provisioning_completion_check",
			sql`${table.provisioningState} <> 'completed'
				OR (${table.provisioningPhase} = 'completed'
					AND ${table.waPhoneNumberId} IS NOT NULL
					AND ${table.status} IN ('pending_verification', 'verified', 'active', 'releasing', 'released'))`,
		),
		check(
			"wa_phone_numbers_release_identity_check",
			sql`(${table.releaseState} IS NULL
					AND ${table.releaseOperationId} IS NULL
					AND ${table.releaseReason} IS NULL
					AND ${table.releasePhase} IS NULL
					AND ${table.releaseMetaStatus} IS NULL
					AND ${table.releaseStripeStatus} IS NULL
					AND ${table.releaseTelnyxStatus} IS NULL
					AND ${table.releaseRequestedAt} IS NULL)
				OR (${table.releaseState} IS NOT NULL
					AND ${table.releaseOperationId} IS NOT NULL
					AND ${table.releaseReason} IN ('user_requested', 'tenant_deleted')
					AND ${table.releasePhase} IS NOT NULL
					AND ${table.releaseMetaStatus} IS NOT NULL
					AND ${table.releaseStripeStatus} IS NOT NULL
					AND ${table.releaseTelnyxStatus} IS NOT NULL
					AND ${table.releaseRequestedAt} IS NOT NULL
					AND ${table.releaseNextAttemptAt} IS NOT NULL)`,
		),
		check(
			"wa_phone_numbers_release_source_check",
			sql`(${table.releaseSourceAccountId} IS NULL) = (${table.releaseSourceTokenVersion} IS NULL)`,
		),
		check(
			"wa_phone_numbers_release_lease_state_check",
			sql`(${table.releaseState} IN ('processing', 'request_may_have_been_sent')
					AND ${table.releaseLeaseExpiresAt} IS NOT NULL)
				OR (COALESCE(${table.releaseState}, '') NOT IN ('processing', 'request_may_have_been_sent')
					AND ${table.releaseLeaseExpiresAt} IS NULL)`,
		),
		check(
			"wa_phone_numbers_release_boundary_check",
			sql`${table.releaseState} <> 'request_may_have_been_sent'
				OR ${table.releaseRequestMayHaveBeenSentAt} IS NOT NULL`,
		),
		check(
			"wa_phone_numbers_release_completion_check",
			sql`(${table.releaseState} = 'completed'
					AND ${table.status} = 'released'
					AND ${table.releasePhase} = 'completed'
					AND ${table.releaseMetaStatus} IN ('confirmed', 'not_required')
					AND ${table.releaseStripeStatus} IN ('confirmed', 'not_required')
					AND ${table.releaseTelnyxStatus} IN ('confirmed', 'not_required')
					AND ${table.releasedAt} IS NOT NULL)
				OR (${table.releaseState} IS DISTINCT FROM 'completed'
					AND ${table.status} <> 'released'
					AND ${table.releasedAt} IS NULL)`,
		),
		check(
			"wa_phone_numbers_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.createdAt}
				AND (${table.provisioningRequestMayHaveBeenSentAt} IS NULL OR ${table.provisioningRequestMayHaveBeenSentAt} >= ${table.createdAt})
				AND (${table.releaseRequestedAt} IS NULL OR ${table.releaseRequestedAt} >= ${table.createdAt})
				AND (${table.releaseRequestMayHaveBeenSentAt} IS NULL OR ${table.releaseRequestMayHaveBeenSentAt} >= ${table.releaseRequestedAt})
				AND (${table.releasedAt} IS NULL OR ${table.releasedAt} >= ${table.releaseRequestedAt})`,
		),
		index("wa_phone_numbers_org_idx").on(table.organizationId),
		index("wa_phone_numbers_status_idx").on(table.status),
		index("wa_phone_numbers_provisioning_due_idx").on(
			table.provisioningState,
			table.provisioningNextAttemptAt,
			table.provisioningLeaseExpiresAt,
		),
		index("wa_phone_numbers_release_due_idx").on(
			table.releaseState,
			table.releaseNextAttemptAt,
			table.releaseLeaseExpiresAt,
		),
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
		type: text("type").notNull(), // text, number, date, boolean, select
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
		name: text("name"),
		email: text("email"),
		emailCanonical: text("email_canonical").generatedAlwaysAs(
			sql`CASE WHEN "email" IS NULL THEN NULL ELSE lower(btrim("email")) END`,
		),
		phone: text("phone"),
		tags: text("tags").array().notNull().default([]),
		// Public global preference/projection only. Delivery authority lives in the
		// canonical per-channel consent state populated by API/automation writes.
		optedIn: boolean("opted_in").notNull().default(false),
		metadata: jsonb("metadata"),
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
		uniqueIndex("contacts_scope_email_canonical_uniq")
			.on(table.organizationId, table.scopeKey, table.emailCanonical)
			.where(sql`${table.emailCanonical} IS NOT NULL`),
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
		identifier: text("identifier").notNull(),
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
			table.identifier,
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
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		ingestionSequence: bigserial("ingestion_sequence", {
			mode: "bigint",
		}).notNull(),
		channel: text("channel").notNull(),
		purpose: text("purpose").notNull(),
		status: text("status", {
			enum: ["granted", "denied"],
		}).notNull(),
		identifierHash: text("identifier_hash").notNull(),
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
		unique("contact_consent_events_ingestion_sequence_uniq").on(
			table.ingestionSequence,
		),
		unique("contact_consent_events_projection_source_uniq").on(
			table.id,
			table.organizationId,
			table.scopeKey,
			table.ingestionSequence,
		),
		check(
			"contact_consent_events_status_check",
			sql`${table.status} IN ('granted', 'denied')`,
		),
		check(
			"contact_consent_events_sequence_positive_check",
			sql`${table.ingestionSequence} > 0`,
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
			table.scopeKey,
			table.channel,
			table.purpose,
			table.identifierHash,
			table.occurredAt,
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
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		contactId: text("contact_id").references(() => contacts.id, {
			onDelete: "set null",
		}),
		channel: text("channel").notNull(),
		purpose: text("purpose").notNull(),
		identifierHash: text("identifier_hash").notNull(),
		status: text("status", {
			enum: ["granted", "denied"],
		}).notNull(),
		source: text("source").notNull(),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
		policyVersion: text("policy_version"),
		jurisdiction: text("jurisdiction"),
		lastEventId: text("last_event_id").notNull(),
		lastIngestionSequence: bigint("last_ingestion_sequence", {
			mode: "bigint",
		}).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		foreignKey({
			columns: [table.contactId, table.organizationId, table.scopeKey],
			foreignColumns: [contacts.id, contacts.organizationId, contacts.scopeKey],
			name: "contact_consent_states_contact_org_scope_fk",
		}),
		foreignKey({
			columns: [
				table.lastEventId,
				table.organizationId,
				table.scopeKey,
				table.lastIngestionSequence,
			],
			foreignColumns: [
				contactConsentEvents.id,
				contactConsentEvents.organizationId,
				contactConsentEvents.scopeKey,
				contactConsentEvents.ingestionSequence,
			],
			name: "contact_consent_states_projection_source_fk",
		}),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "contact_consent_states_workspace_org_fk",
		}).onDelete("restrict"),
		uniqueIndex("contact_consent_states_identifier_idx").on(
			table.organizationId,
			table.channel,
			table.purpose,
			table.identifierHash,
		),
		check(
			"contact_consent_states_sequence_positive_check",
			sql`${table.lastIngestionSequence} > 0`,
		),
		check(
			"contact_consent_states_status_check",
			sql`${table.status} IN ('granted', 'denied')`,
		),
		check(
			"contact_consent_states_timestamp_order_check",
			sql`${table.occurredAt} <= ${table.updatedAt} + interval '5 minutes'`,
		),
		index("contact_consent_states_contact_idx").on(
			table.contactId,
			table.channel,
			table.purpose,
		),
	],
);

/** Identifier-level suppression survives contact deletion and covers raw sends. */
export const contactSuppressions = pgTable(
	"contact_suppressions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("sup_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		channel: text("channel").notNull(),
		purpose: text("purpose").notNull(),
		identifierHash: text("identifier_hash").notNull(),
		sourceEventId: text("source_event_id").notNull(),
		reason: text("reason"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		foreignKey({
			columns: [table.sourceEventId, table.organizationId, table.scopeKey],
			foreignColumns: [
				contactConsentEvents.id,
				contactConsentEvents.organizationId,
				contactConsentEvents.scopeKey,
			],
			name: "contact_suppressions_event_org_scope_fk",
		}),
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "contact_suppressions_workspace_org_fk",
		}).onDelete("restrict"),
		uniqueIndex("contact_suppressions_identifier_idx").on(
			table.organizationId,
			table.channel,
			table.purpose,
			table.identifierHash,
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
		contactIdentifier: text("contact_identifier").notNull(),
		contactIdentifierHash: text("contact_identifier_hash").notNull(),
		variables: jsonb("variables"),
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
		index("broadcast_recipients_contact_idx").on(table.contactId),
		index("broadcast_recipients_identifier_hash_idx").on(
			table.contactIdentifierHash,
		),
		index("broadcast_recipients_claim_idx").on(
			table.broadcastId,
			table.status,
			table.id,
		),
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

export const audienceTypeEnum = pgEnum("audience_type", [
	"customer_list",
	"website",
	"lookalike",
]);

export const ideaMediaTypeEnum = pgEnum("idea_media_type", [
	"image",
	"video",
	"gif",
	"document",
]);

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

/** Links social accounts to platform ad accounts (1:N) */
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
		socialAccountId: text("social_account_id").notNull(),
		platform: adPlatformEnum("platform").notNull(),
		platformAdAccountId: text("platform_ad_account_id").notNull(),
		name: text("name"),
		currency: varchar("currency", { length: 3 }).default("USD"),
		timezone: text("timezone"),
		status: text("status").default("active"),
		metadata: jsonb("metadata"),
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
		uniqueIndex("ad_accounts_org_platform_id_idx").on(
			table.organizationId,
			table.platform,
			table.platformAdAccountId,
		),
		index("ad_accounts_org_idx").on(table.organizationId),
		index("ad_accounts_workspace_idx").on(table.workspaceId),
		index("ad_accounts_social_account_idx").on(table.socialAccountId),
		index("ad_accounts_status_idx").on(table.status),
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
		currency: varchar("currency", { length: 3 }).default("USD"),
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
			sql`(${table.dailyBudgetCents} IS NULL OR ${table.dailyBudgetCents} >= 0)
				AND (${table.lifetimeBudgetCents} IS NULL OR ${table.lifetimeBudgetCents} >= 0)`,
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
			sql`(${table.dailyBudgetCents} IS NULL OR ${table.dailyBudgetCents} >= 0)
				AND (${table.lifetimeBudgetCents} IS NULL OR ${table.lifetimeBudgetCents} >= 0)
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
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
		adAccountId: text("ad_account_id").notNull(),
		kind: text("kind", {
			enum: ["create_campaign", "create_ad", "boost_post"],
		}).notNull(),
		operationKeyHash: varchar("operation_key_hash", { length: 64 }).notNull(),
		requestHash: varchar("request_hash", { length: 64 }).notNull(),
		requestPayload: jsonb("request_payload").notNull(),
		status: text("status", {
			enum: [
				"pending",
				"processing",
				"request_may_have_been_sent",
				"unknown",
				"reconciling",
				"manual_review",
				"completed",
				"failed",
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
			sql`${table.status} IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'reconciling', 'manual_review', 'completed', 'failed')`,
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
			sql`${table.updatedAt} >= ${table.createdAt}
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
		index("ad_audience_users_audience_idx").on(table.audienceId),
		uniqueIndex("ad_audience_users_email_uniq")
			.on(table.audienceId, table.emailHash)
			.where(sql`${table.emailHash} IS NOT NULL`),
		uniqueIndex("ad_audience_users_phone_uniq")
			.on(table.audienceId, table.phoneHash)
			.where(sql`${table.phoneHash} IS NOT NULL`),
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
		syncType: text("sync_type").notNull(),
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
			"ad_sync_logs_counts_nonnegative_check",
			sql`${table.adsCreated} >= 0 AND ${table.adsUpdated} >= 0 AND ${table.metricsUpdated} >= 0`,
		),
		index("ad_sync_logs_org_idx").on(table.organizationId, table.startedAt),
		index("ad_sync_logs_ad_account_idx").on(table.adAccountId),
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
		// Metrics refresh: find recent posts needing metric updates
		index("external_posts_metrics_updated_idx").on(table.metricsUpdatedAt),
		// Platform filter
		index("external_posts_org_platform_idx").on(
			table.organizationId,
			table.platform,
		),
		index("external_posts_account_published_idx").on(
			table.socialAccountId,
			table.publishedAt,
		),
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
			sql`${table.pollIntervalSec} > 0
				AND ${table.consecutiveEmptyPolls} >= 0
				AND ${table.consecutiveErrors} >= 0
				AND ${table.totalPostsSynced} >= 0
				AND ${table.totalSyncRuns} >= 0
				AND (${table.rateLimitRemaining} IS NULL OR ${table.rateLimitRemaining} >= 0)`,
		),
		// Cron query: find accounts due for sync
		index("sync_state_enabled_next_idx").on(table.enabled, table.nextSyncAt),
		// Org filter
		index("sync_state_org_idx").on(table.organizationId),
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
			enum: ["repost", "comment", "quote"],
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
		executeAt: timestamp("execute_at", { withTimezone: true }).notNull(),
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
				AND (${table.executedAt} IS NULL OR ${table.executedAt} >= ${table.createdAt})
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
		),
		index("cross_post_actions_post_idx").on(table.postId),
		index("cross_post_actions_source_target_idx").on(table.sourceTargetId),
		index("cross_post_actions_target_account_idx").on(table.targetAccountId),
		index("cross_post_actions_status_idx").on(
			table.status,
			table.executeAt,
			table.leaseExpiresAt,
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
		apiKey: text("api_key"), // encrypted: AES-256-GCM
		domain: text("domain"), // custom short domain (e.g. "link.mybrand.com")

		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [index("short_link_configs_org_idx").on(table.organizationId)],
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
		provider: text("provider").notNull().default("relayapi"),
		shortCode: text("short_code").notNull(),
		shortUrl: text("short_url").notNull(),

		// Optional association to a post
		postId: text("post_id").references(() => posts.id, {
			onDelete: "set null",
		}),

		// Cached click count (refreshed periodically)
		clickCount: integer("click_count").notNull().default(0),
		lastClickSyncAt: timestamp("last_click_sync_at", {
			withTimezone: true,
		}),

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
		uniqueIndex("short_links_provider_code_uniq").on(
			table.provider,
			table.shortCode,
		),
		uniqueIndex("short_links_short_url_uniq").on(table.shortUrl),
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
		ideaId: text("idea_id")
			.notNull()
			.references(() => ideas.id, { onDelete: "cascade" }),
		authorId: text("author_id").notNull(),
		content: text("content").notNull(),
		parentId: text("parent_id").references((): AnyPgColumn => ideaComments.id, {
			onDelete: "cascade",
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idea_comments_idea_idx").on(table.ideaId),
		index("idea_comments_parent_idx").on(table.parentId),
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
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "restrict",
		}),
		scopeKey: text("scope_key")
			.notNull()
			.generatedAlwaysAs(workspaceScopeKeySql()),
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
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "idea_tags_workspace_org_fk",
		}),
		index("idea_tags_org_tag_workspace_idx").on(
			table.organizationId,
			table.tagId,
			table.workspaceId,
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
		primaryKey({ columns: [table.postId, table.tagId] }),
		index("post_tags_tag_idx").on(table.tagId),
	],
);

export const ideaActivity = pgTable(
	"idea_activity",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ida_")),
		ideaId: text("idea_id")
			.notNull()
			.references(() => ideas.id, { onDelete: "cascade" }),
		actorId: text("actor_id").notNull(),
		action: ideaActivityActionEnum("action").notNull(),
		metadata: jsonb("metadata").$type<Record<string, unknown>>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idea_activity_idea_idx").on(table.ideaId),
		index("idea_activity_idea_created_idx").on(table.ideaId, table.createdAt),
		index("idea_activity_actor_idx").on(table.actorId),
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

export const automationBindingTypeEnum = pgEnum("automation_binding_type", [
	"default_reply",
	"welcome_message",
	"conversation_starter",
	"main_menu",
	"ice_breaker",
]);

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
		kind: text("kind").notNull().default("webhook_out"),
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
		kind: text("kind").notNull(),
		status: text("status").notNull().default("active"),
		socialAccountId: text("social_account_id").references(
			() => socialAccounts.id,
			{ onDelete: "set null" },
		),
		config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
		filters: jsonb("filters"),
		allowReentry: boolean("allow_reentry").notNull().default(true),
		reentryCooldownMin: integer("reentry_cooldown_min").notNull().default(60),
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
			"automation_entrypoints_status_check",
			sql`${table.status} IN ('active', 'paused', 'disabled')`,
		),
		check(
			"automation_entrypoints_numeric_check",
			sql`${table.reentryCooldownMin} >= 0 AND ${table.specificity} >= 0`,
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
		index("automation_webhook_receipts_expiry_idx").on(table.expiresAt),
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
		lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
		syncError: text("sync_error"),
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
			sql`${table.waitingFor} IS NULL OR ${table.waitingFor} IN ('input', 'delay', 'external_event')`,
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
			sql`${table.status} IN ('claimed', 'in_flight', 'succeeded', 'failed', 'unknown')`,
		),
		check(
			"automation_node_executions_counters_nonnegative_check",
			sql`${table.runRevision} >= 0 AND ${table.visitOrdinal} >= 0 AND ${table.attempts} >= 0 AND ${table.leaseToken} >= 0`,
		),
		check(
			"automation_node_executions_state_fields_check",
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
					AND ${table.completedAt} IS NOT NULL)`,
		),
		check(
			"automation_node_executions_timestamp_order_check",
			sql`${table.updatedAt} >= ${table.claimedAt}
				AND (${table.requestMayHaveBeenSentAt} IS NULL OR ${table.requestMayHaveBeenSentAt} >= ${table.claimedAt})
				AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.claimedAt})`,
		),
		index("automation_node_executions_claim_idx").on(
			table.status,
			table.leaseExpiresAt,
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
		kind: text("kind").notNull(),
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
	],
);

// Intentionally ordinary (non-partitioned) for the first production baseline.
// Add partitioning only after measured volume justifies the operational burden.
export const automationStepRuns = pgTable(
	"automation_step_runs",
	{
		id: bigserial("id", { mode: "bigint" }).primaryKey(),
		runId: text("run_id")
			.notNull()
			.references(() => automationRuns.id, { onDelete: "cascade" }),
		automationId: text("automation_id").notNull(),
		nodeKey: text("node_key").notNull(),
		nodeKind: text("node_kind").notNull(),
		enteredViaPortKey: text("entered_via_port_key"),
		exitedViaPortKey: text("exited_via_port_key"),
		outcome: text("outcome").notNull(),
		durationMs: integer("duration_ms").notNull().default(0),
		payload: jsonb("payload"),
		error: jsonb("error"),
		executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		check(
			"automation_step_runs_outcome_check",
			sql`${table.outcome} IN ('ok', 'wait_input', 'wait_delay', 'end', 'failed', 'graph_changed')`,
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
		index("idx_step_runs_node_time").on(table.nodeKey, table.executedAt),
		index("idx_step_runs_executed_brin").using("brin", table.executedAt),
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
		runId: text("run_id").references(() => automationRuns.id, {
			onDelete: "cascade",
		}),
		jobType: text("job_type").notNull(),
		automationId: text("automation_id").references(() => automations.id, {
			onDelete: "cascade",
		}),
		entrypointId: text("entrypoint_id").references(
			() => automationEntrypoints.id,
			{ onDelete: "cascade" },
		),
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
			sql`${table.jobType} IN ('resume_run', 'input_timeout', 'scheduled_trigger', 'webhook_reception_failure')`,
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
			sql`${table.status} <> 'unknown' OR ${table.effectStartedAt} IS NOT NULL`,
		),
		index("idx_scheduled_jobs_sweep").on(
			table.status,
			table.runAt,
			table.leaseExpiresAt,
		),
		index("idx_scheduled_jobs_run").on(table.runId),
		index("idx_scheduled_jobs_automation").on(table.automationId),
		index("idx_scheduled_jobs_entrypoint").on(table.entrypointId),
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
		filter: jsonb("filter").notNull(), // e.g. {all:[{tag:'vip'}, {field:'country', op:'eq', v:'IT'}]}
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
		foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspaces.id, workspaces.organizationId],
			name: "segments_workspace_org_fk",
		}),
		check(
			"segments_member_count_nonnegative_check",
			sql`${table.memberCount} >= 0`,
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
			columns: [table.segmentId, table.organizationId, table.scopeKey],
			foreignColumns: [segments.id, segments.organizationId, segments.scopeKey],
			name: "contact_segment_memberships_segment_org_scope_fk",
		}).onDelete("cascade"),
		primaryKey({
			columns: [table.contactId, table.segmentId],
			name: "contact_segment_memberships_pk",
		}),
		index("contact_segment_memberships_org_idx").on(table.organizationId),
		index("contact_segment_memberships_segment_idx").on(table.segmentId),
		index("contact_segment_memberships_contact_idx").on(table.contactId),
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

export const contactSubscriptions = pgTable(
	"contact_subscriptions",
	{
		organizationId: text("organization_id").notNull(),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		contactId: text("contact_id").notNull(),
		listId: text("list_id").notNull(),
		subscribedAt: timestamp("subscribed_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
		source: text("source"), // 'automation' | 'manual' | 'import' | 'api'
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
		primaryKey({ columns: [table.contactId, table.listId] }),
		index("contact_subscriptions_list_idx").on(table.listId),
	],
);

// ---------------------------------------------------------------------------
// AI Knowledge Base (powers ai_agent nodes)
// Note: embeddings stored as real[] for Hyperdrive compatibility without pgvector.
// Migrate to pgvector + `vector(1536)` in a focused follow-up once extension is enabled.
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
		embeddingModel: text("embedding_model")
			.notNull()
			.default("text-embedding-3-small"),
		embeddingDimensions: integer("embedding_dimensions")
			.notNull()
			.default(1536),
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
			"ai_knowledge_bases_dimensions_positive_check",
			sql`${table.embeddingDimensions} > 0`,
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
		sourceType: text("source_type").notNull(), // 'url' | 'file' | 'text'
		sourceRef: text("source_ref").notNull(),
		title: text("title"),
		status: text("status").notNull().default("pending"), // pending | processing | ready | failed
		lastCrawledAt: timestamp("last_crawled_at", { withTimezone: true }),
		error: text("error"),
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
		check(
			"ai_knowledge_documents_status_check",
			sql`${table.status} IN ('pending', 'processing', 'ready', 'failed')`,
		),
		index("ai_knowledge_documents_kb_idx").on(table.kbId),
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
		embedding: real("embedding").array(), // 1536-dim float array; swap to pgvector in follow-up
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
		index("ai_knowledge_chunks_doc_idx").on(table.documentId),
		index("ai_knowledge_chunks_kb_idx").on(table.kbId),
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
		guardrails: text("guardrails"),
		model: text("model").notNull().default("claude-haiku-4-5"),
		kbId: text("kb_id").references(() => aiKnowledgeBases.id, {
			onDelete: "set null",
		}),
		handoffStrategy: jsonb("handoff_strategy"), // { keywords: [], confidenceThreshold: 0.6, assignTo: userId }
		temperature: real("temperature").default(0.7),
		maxTokens: integer("max_tokens").default(1024),
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
		check(
			"ai_agents_parameters_check",
			sql`(${table.temperature} IS NULL OR (${table.temperature} >= 0 AND ${table.temperature} <= 2)) AND (${table.maxTokens} IS NULL OR ${table.maxTokens} > 0)`,
		),
		index("ai_agents_org_idx").on(table.organizationId),
	],
);

// ---------------------------------------------------------------------------
// Growth tools (Ref URLs, QR codes, Landing pages)
// ---------------------------------------------------------------------------

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
		automationId: text("automation_id").references(() => automations.id, {
			onDelete: "set null",
		}),
		uses: integer("uses").notNull().default(0),
		enabled: boolean("enabled").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true })
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
		uniqueIndex("ref_urls_org_scope_slug_uniq").on(
			table.organizationId,
			table.scopeKey,
			table.slug,
		),
		check("ref_urls_uses_nonnegative_check", sql`${table.uses} >= 0`),
		index("ref_urls_automation_idx").on(table.automationId),
	],
);

export const qrCodes = pgTable(
	"qr_codes",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("qr_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		scopeKey: text("scope_key").notNull().default(ORGANIZATION_SCOPE_KEY),
		refUrlId: text("ref_url_id").notNull(),
		imageR2Key: text("image_r2_key"),
		scanCount: integer("scan_count").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.refUrlId, table.organizationId, table.scopeKey],
			foreignColumns: [refUrls.id, refUrls.organizationId, refUrls.scopeKey],
			name: "qr_codes_ref_url_org_scope_fk",
		}).onDelete("cascade"),
		check(
			"qr_codes_scan_count_nonnegative_check",
			sql`${table.scanCount} >= 0`,
		),
		index("qr_codes_org_idx").on(table.organizationId),
	],
);

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
		config: jsonb("config").notNull(), // page config: blocks, theme, form fields, cta
		automationId: text("automation_id").references(() => automations.id, {
			onDelete: "set null",
		}),
		visits: integer("visits").notNull().default(0),
		conversions: integer("conversions").notNull().default(0),
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
			"landing_pages_counts_nonnegative_check",
			sql`${table.visits} >= 0 AND ${table.conversions} >= 0 AND ${table.conversions} <= ${table.visits}`,
		),
		index("landing_pages_automation_idx").on(table.automationId),
	],
);
