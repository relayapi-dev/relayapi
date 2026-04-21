import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigserial,
	boolean,
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

// ---------------------------------------------------------------------------
// Auth schema (Better Auth owns these tables)
// ---------------------------------------------------------------------------

const authSchema = pgSchema("auth");

export const user = authSchema.table("user", {
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
});

export const session = authSchema.table("session", {
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
});

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
		index("apikey_referenceId_idx").on(table.referenceId),
		index("apikey_organizationId_idx").on(table.organizationId),
		index("apikey_key_idx").on(table.key),
	],
);

// ---------------------------------------------------------------------------
// Organization (Better Auth organization plugin)
// ---------------------------------------------------------------------------

export const organization = authSchema.table("organization", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	slug: text("slug").notNull().unique(),
	logo: text("logo"),
	metadata: text("metadata"),
	createdAt: timestamp("createdAt", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const member = authSchema.table("member", {
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
});

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
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("workspaces_org_idx").on(table.organizationId),
		index("workspaces_org_name_idx").on(table.organizationId, table.name),
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
		tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
		scopes: text("scopes").array(),
		metadata: jsonb("metadata"), // custom data (e.g. reseller customer mapping)
		schedulingPreferences: jsonb("scheduling_preferences")
			.$type<{
				posting_windows?: Array<{ day_of_week: number; start_hour: number; end_hour: number }>;
				max_posts_per_day?: number;
				min_gap_minutes?: number;
			}>(),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "set null",
		}),
		connectedAt: timestamp("connected_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("social_accounts_org_platform_account_idx").on(
			table.organizationId,
			table.platform,
			table.platformAccountId,
		),
		index("social_accounts_org_idx").on(table.organizationId),
		index("social_accounts_webhook_id_idx").on(table.platform, table.webhookAccountId),
		index("social_accounts_workspace_idx").on(table.workspaceId),
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
			onDelete: "set null",
		}),
		content: text("content"),
		status: postStatusEnum("status").notNull().default("draft"),
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
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
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
		index("posts_recycled_from_idx").on(table.recycledFromId),
		index("posts_thread_group_idx").on(table.threadGroupId, table.threadPosition),
	],
);

export const postTargets = pgTable(
	"post_targets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("pt_")),
		postId: text("post_id")
			.notNull()
			.references(() => posts.id, { onDelete: "cascade" }),
		socialAccountId: text("social_account_id")
			.notNull()
			.references(() => socialAccounts.id, { onDelete: "cascade" }),
		platform: platformEnum("platform").notNull(),
		status: postStatusEnum("status").notNull().default("draft"),
		platformPostId: text("platform_post_id"),
		platformUrl: text("platform_url"),
		error: text("error"),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("post_targets_post_status_idx").on(table.postId, table.status),
		index("post_targets_social_account_id_idx").on(table.socialAccountId),
		index("post_targets_updated_at_idx").on(table.updatedAt),
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
		sourcePostId: text("source_post_id")
			.notNull()
			.references(() => posts.id, { onDelete: "cascade" }),
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
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("post_recycling_configs_org_idx").on(table.organizationId),
		index("post_recycling_configs_enabled_next_idx").on(
			table.enabled,
			table.nextRecycleAt,
		),
		uniqueIndex("post_recycling_configs_source_post_idx").on(
			table.sourcePostId,
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
		url: text("url"),
		width: integer("width"),
		height: integer("height"),
		duration: integer("duration"),
		uploadedBy: text("uploaded_by").references(() => user.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "set null",
		}),
		status: text("status").notNull().default("ready"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("media_org_idx").on(table.organizationId),
		index("media_workspace_idx").on(table.workspaceId),
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
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "set null",
		}),
		url: text("url").notNull(),
		secret: text("secret").notNull(), // hashed
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
		index("webhook_endpoints_org_idx").on(table.organizationId),
		index("webhook_endpoints_workspace_idx").on(table.workspaceId),
	],
);

export const webhookLogs = pgTable(
	"webhook_logs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("whl_")),
		webhookId: text("webhook_id")
			.notNull()
			.references(() => webhookEndpoints.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		event: text("event").notNull(),
		payload: jsonb("payload"),
		statusCode: integer("status_code"),
		responseTimeMs: integer("response_time_ms"),
		success: boolean("success").notNull().default(false),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("webhook_logs_webhook_id_idx").on(table.webhookId),
		index("webhook_logs_org_created_idx").on(
			table.organizationId,
			table.createdAt,
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
		index("api_request_logs_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("api_request_logs_api_key_idx").on(table.apiKeyId),
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
		status: subscriptionStatusEnum("status").notNull().default("trialing"),
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
		requireWorkspaceId: boolean("require_workspace_id")
			.notNull()
			.default(false),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("org_subs_stripe_sub_id_idx").on(table.stripeSubscriptionId),
		index("org_subs_stripe_customer_id_idx").on(table.stripeCustomerId),
	],
);

// ---------------------------------------------------------------------------
// Usage records (monthly post count per org — source of truth for billing)
// Incremented atomically on each post create. One row per org per billing period.
// ---------------------------------------------------------------------------

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
	},
	(table) => [
		uniqueIndex("usage_records_org_period_idx").on(
			table.organizationId,
			table.periodStart,
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
		usageRecordId: text("usage_record_id").references(() => usageRecords.id),
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
		uniqueIndex("invoices_org_period_idx").on(
			table.organizationId,
			table.periodStart,
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
		sentAt: timestamp("sent_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("dunning_events_org_idx").on(table.organizationId),
		index("dunning_events_invoice_id_idx").on(table.invoiceId),
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
		read: boolean("read").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("notifications_user_created_idx").on(table.userId, table.createdAt),
		index("notifications_user_read_idx").on(table.userId, table.read),
	],
);

// ---------------------------------------------------------------------------
// Notification preferences (per-user channel settings)
// ---------------------------------------------------------------------------

export const notificationPreferences = pgTable("notification_preferences", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => generateId("npref_")),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" })
		.unique(),
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
});

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
			onDelete: "set null",
		}),
		accountId: text("account_id")
			.notNull()
			.references(() => socialAccounts.id, { onDelete: "cascade" }),
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
		index("inbox_conv_workspace_idx").on(table.workspaceId),
		index("inbox_conv_org_status_idx").on(table.organizationId, table.status),
		index("inbox_conv_org_updated_idx").on(
			table.organizationId,
			table.updatedAt,
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
		index("inbox_conv_org_workspace_idx").on(table.organizationId, table.workspaceId),
		index("inbox_conv_contact_idx").on(table.contactId),
		index("inbox_conv_assigned_user_idx").on(table.assignedUserId),
	],
);

export const inboxMessages = pgTable(
	"inbox_messages",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("msg_")),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => inboxConversations.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
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
		index("inbox_msg_conv_created_idx").on(
			table.conversationId,
			table.createdAt,
		),
		index("inbox_msg_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		uniqueIndex("inbox_msg_dedup_idx").on(
			table.conversationId,
			table.platformMessageId,
		),
		index("inbox_msg_platform_message_id_idx").on(
			table.platformMessageId,
		),
	],
);

export const inboxConversationNotes = pgTable(
	"inbox_conversation_notes",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("note_")),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => inboxConversations.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		text: text("text").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("inbox_note_conv_created_idx").on(
			table.conversationId,
			table.createdAt,
		),
		index("inbox_note_org_idx").on(table.organizationId),
		index("inbox_note_user_idx").on(table.userId),
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
			onDelete: "set null",
		}),

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

		// Timestamps
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("auto_post_rules_org_status_idx").on(
			table.organizationId,
			table.status,
		),
		index("auto_post_rules_workspace_idx").on(table.workspaceId),
	],
);

// ---------------------------------------------------------------------------
// WhatsApp — Broadcasts
// ---------------------------------------------------------------------------

export const whatsappBroadcasts = pgTable(
	"whatsapp_broadcasts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("wbc_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		socialAccountId: text("social_account_id")
			.notNull()
			.references(() => socialAccounts.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		status: text("status").notNull().default("draft"),
		templateName: text("template_name").notNull(),
		templateLanguage: text("template_language").notNull().default("en_US"),
		templateComponents: jsonb("template_components"),
		recipientCount: integer("recipient_count").notNull().default(0),
		sentCount: integer("sent_count").notNull().default(0),
		deliveredCount: integer("delivered_count").notNull().default(0),
		readCount: integer("read_count").notNull().default(0),
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
		index("wa_broadcasts_org_idx").on(table.organizationId),
		index("wa_broadcasts_status_idx").on(table.status),
	],
);

export const whatsappBroadcastRecipients = pgTable(
	"whatsapp_broadcast_recipients",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("wbr_")),
		broadcastId: text("broadcast_id")
			.notNull()
			.references(() => whatsappBroadcasts.id, { onDelete: "cascade" }),
		phone: text("phone").notNull(),
		variables: jsonb("variables"),
		status: text("status").notNull().default("pending"),
		messageId: text("message_id"),
		error: text("error"),
		sentAt: timestamp("sent_at", { withTimezone: true }),
		deliveredAt: timestamp("delivered_at", { withTimezone: true }),
		readAt: timestamp("read_at", { withTimezone: true }),
	},
	(table) => [
		index("wa_broadcast_recipients_broadcast_idx").on(table.broadcastId),
		index("wa_broadcast_recipients_msg_idx").on(table.messageId),
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
		waPhoneNumberId: text("wa_phone_number_id"),
		status: text("status").notNull().default("purchasing"),
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
		index("wa_phone_numbers_org_idx").on(table.organizationId),
		index("wa_phone_numbers_status_idx").on(table.status),
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
			onDelete: "set null",
		}),
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
		uniqueIndex("custom_field_defs_org_slug_idx").on(
			table.organizationId,
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
		definitionId: text("definition_id")
			.notNull()
			.references(() => customFieldDefinitions.id, { onDelete: "cascade" }),
		contactId: text("contact_id")
			.notNull()
			.references(() => contacts.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		value: text("value").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
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
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		name: text("name"),
		email: text("email"),
		phone: text("phone"),
		tags: text("tags").array().notNull().default([]),
		optedIn: boolean("opted_in").notNull().default(true),
		metadata: jsonb("metadata"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
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
		uniqueIndex("contacts_workspace_email_idx")
			.on(table.workspaceId, table.email)
			.where(sql`${table.email} IS NOT NULL`),
	],
);

export const contactChannels = pgTable(
	"contact_channels",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("cc_")),
		contactId: text("contact_id")
			.notNull()
			.references(() => contacts.id, { onDelete: "cascade" }),
		socialAccountId: text("social_account_id")
			.notNull()
			.references(() => socialAccounts.id, { onDelete: "cascade" }),
		platform: text("platform").notNull(),
		identifier: text("identifier").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
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
			onDelete: "set null",
		}),
		socialAccountId: text("social_account_id")
			.notNull()
			.references(() => socialAccounts.id, { onDelete: "cascade" }),
		platform: text("platform").notNull(),
		name: text("name"),
		description: text("description"),
		status: text("status").notNull().default("draft"),
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
		index("broadcasts_org_idx").on(table.organizationId),
		index("broadcasts_workspace_idx").on(table.workspaceId),
		index("broadcasts_status_idx").on(table.status),
		index("broadcasts_org_status_idx").on(table.organizationId, table.status),
		index("broadcasts_status_scheduled_idx").on(table.status, table.scheduledAt),
	],
);

export const broadcastRecipients = pgTable(
	"broadcast_recipients",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("bcr_")),
		broadcastId: text("broadcast_id")
			.notNull()
			.references(() => broadcasts.id, { onDelete: "cascade" }),
		contactId: text("contact_id"),
		contactIdentifier: text("contact_identifier").notNull(),
		variables: jsonb("variables"),
		status: text("status").notNull().default("pending"),
		messageId: text("message_id"),
		error: text("error"),
		sentAt: timestamp("sent_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("broadcast_recipients_broadcast_idx").on(table.broadcastId),
		index("broadcast_recipients_status_idx").on(
			table.broadcastId,
			table.status,
		),
		uniqueIndex("broadcast_recipients_dedup_idx").on(
			table.broadcastId,
			table.contactIdentifier,
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
			onDelete: "set null",
		}),
		socialAccountId: text("social_account_id")
			.notNull()
			.references(() => socialAccounts.id, { onDelete: "cascade" }),
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
			onDelete: "set null",
		}),
		adAccountId: text("ad_account_id")
			.notNull()
			.references(() => adAccounts.id, { onDelete: "cascade" }),
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
		index("ad_campaigns_org_idx").on(table.organizationId),
		index("ad_campaigns_workspace_idx").on(table.workspaceId),
		index("ad_campaigns_ad_account_idx").on(table.adAccountId),
		index("ad_campaigns_platform_id_idx").on(table.platformCampaignId),
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
			onDelete: "set null",
		}),
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
		// Boost mode: references a published post
		boostPostTargetId: text("boost_post_target_id").references(
			() => postTargets.id,
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
		index("ads_org_idx").on(table.organizationId),
		index("ads_workspace_idx").on(table.workspaceId),
		index("ads_campaign_idx").on(table.campaignId),
		index("ads_org_campaign_idx").on(table.organizationId, table.campaignId),
		index("ads_platform_ad_id_idx").on(table.platformAdId),
		index("ads_org_status_idx").on(table.organizationId, table.status),
		index("ads_boost_post_idx").on(table.boostPostTargetId),
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
			onDelete: "set null",
		}),
		adAccountId: text("ad_account_id")
			.notNull()
			.references(() => adAccounts.id, { onDelete: "cascade" }),
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
		index("ad_audiences_org_idx").on(table.organizationId),
		index("ad_audiences_workspace_idx").on(table.workspaceId),
		index("ad_audiences_ad_account_idx").on(table.adAccountId),
		index("ad_audiences_platform_id_idx").on(table.platformAudienceId),
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
		index("ad_audience_users_audience_idx").on(table.audienceId),
		uniqueIndex("ad_audience_users_dedup_idx").on(
			table.audienceId,
			table.emailHash,
			table.phoneHash,
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
		adAccountId: text("ad_account_id")
			.notNull()
			.references(() => adAccounts.id, { onDelete: "cascade" }),
		platform: adPlatformEnum("platform").notNull(),
		syncType: text("sync_type").notNull(),
		adsCreated: integer("ads_created").default(0),
		adsUpdated: integer("ads_updated").default(0),
		metricsUpdated: integer("metrics_updated").default(0),
		error: text("error"),
		startedAt: timestamp("started_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
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
			onDelete: "set null",
		}),
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
		thumbnailUrl: text("thumbnail_url"),

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
		socialAccountId: text("social_account_id")
			.notNull()
			.references(() => socialAccounts.id, { onDelete: "cascade" })
			.unique(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
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
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		description: text("description"),
		content: text("content").notNull(),
		platformOverrides: jsonb("platform_overrides").$type<Record<string, string>>(),
		tags: jsonb("tags").$type<string[]>().default([]),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
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

		postId: text("post_id")
			.notNull()
			.references(() => posts.id, { onDelete: "cascade" }),

		actionType: text("action_type", {
			enum: ["repost", "comment", "quote"],
		}).notNull(),
		targetAccountId: text("target_account_id")
			.notNull()
			.references(() => socialAccounts.id, { onDelete: "cascade" }),
		content: text("content"),
		delayMinutes: integer("delay_minutes").notNull().default(0),

		// State
		status: text("status", {
			enum: ["pending", "executed", "failed", "cancelled"],
		})
			.notNull()
			.default("pending"),
		executeAt: timestamp("execute_at", { withTimezone: true }).notNull(),
		executedAt: timestamp("executed_at", { withTimezone: true }),
		resultPostId: text("result_post_id"),
		error: text("error"),

		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("cross_post_actions_post_idx").on(table.postId),
		index("cross_post_actions_status_idx").on(table.status, table.executeAt),
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
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		content: text("content").notNull(),
		isDefault: boolean("is_default").notNull().default(false),
		position: text("position", { enum: ["append", "prepend"] }).notNull().default("append"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
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
	(table) => [
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

		originalUrl: text("original_url").notNull(),
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
		index("short_links_org_idx").on(table.organizationId),
		index("short_links_post_idx").on(table.postId),
		index("short_links_short_url_idx").on(table.shortUrl),
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
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		color: text("color").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
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
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		position: real("position").notNull().default(0),
		color: text("color"),
		isDefault: boolean("is_default").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
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
			onDelete: "set null",
		}),
		title: text("title"),
		content: text("content"),
		groupId: text("group_id")
			.notNull()
			.references(() => ideaGroups.id),
		position: real("position").notNull().default(0),
		assignedTo: text("assigned_to").references(() => user.id, {
			onDelete: "set null",
		}),
		convertedToPostId: text("converted_to_post_id").references(
			() => posts.id,
			{ onDelete: "set null" },
		),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("ideas_org_idx").on(table.organizationId),
		index("ideas_workspace_idx").on(table.workspaceId),
		index("ideas_group_position_idx").on(table.groupId, table.position),
		index("ideas_assigned_to_idx").on(table.assignedTo),
		index("ideas_org_created_idx").on(table.organizationId, table.createdAt),
	],
);

export const ideaMedia = pgTable(
	"idea_media",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("idm_")),
		ideaId: text("idea_id")
			.notNull()
			.references(() => ideas.id, { onDelete: "cascade" }),
		url: text("url").notNull(),
		type: ideaMediaTypeEnum("type").notNull(),
		alt: text("alt"),
		position: integer("position").notNull().default(0),
	},
	(table) => [index("idea_media_idea_idx").on(table.ideaId)],
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
		parentId: text("parent_id").references(
			(): AnyPgColumn => ideaComments.id,
			{ onDelete: "cascade" },
		),
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
		ideaId: text("idea_id")
			.notNull()
			.references(() => ideas.id, { onDelete: "cascade" }),
		tagId: text("tag_id")
			.notNull()
			.references(() => tags.id, { onDelete: "cascade" }),
	},
	(table) => [primaryKey({ columns: [table.ideaId, table.tagId] })],
);

export const postTags = pgTable(
	"post_tags",
	{
		postId: text("post_id")
			.notNull()
			.references(() => posts.id, { onDelete: "cascade" }),
		tagId: text("tag_id")
			.notNull()
			.references(() => tags.id, { onDelete: "cascade" }),
	},
	(table) => [primaryKey({ columns: [table.postId, table.tagId] })],
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
		index("idea_activity_idea_created_idx").on(
			table.ideaId,
			table.createdAt,
		),
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
			onDelete: "set null",
		}),
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
		index("idx_automations_org_status").on(table.organizationId, table.status),
		index("idx_automations_org_workspace").on(
			table.organizationId,
			table.workspaceId,
		),
		index("idx_automations_template")
			.on(table.createdFromTemplate)
			.where(sql`${table.createdFromTemplate} IS NOT NULL`),
		index("idx_automations_graph_gin").using("gin", table.graph),
	],
);

export const automationEntrypoints = pgTable(
	"automation_entrypoints",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("aep_")),
		automationId: text("automation_id")
			.notNull()
			.references(() => automations.id, { onDelete: "cascade" }),
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
			onDelete: "set null",
		}),
		socialAccountId: text("social_account_id")
			.notNull()
			.references(() => socialAccounts.id, { onDelete: "cascade" }),
		channel: automationChannelEnum("channel").notNull(),
		bindingType: automationBindingTypeEnum("binding_type").notNull(),
		automationId: text("automation_id")
			.notNull()
			.references(() => automations.id, { onDelete: "cascade" }),
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
		automationId: text("automation_id")
			.notNull()
			.references(() => automations.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		entrypointId: text("entrypoint_id").references(
			() => automationEntrypoints.id,
			{ onDelete: "set null" },
		),
		bindingId: text("binding_id").references(() => automationBindings.id, {
			onDelete: "set null",
		}),
		contactId: text("contact_id")
			.notNull()
			.references(() => contacts.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id").references(
			() => inboxConversations.id,
			{ onDelete: "set null" },
		),
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
		uniqueIndex("idx_automation_runs_active_uniq")
			.on(table.contactId, table.automationId)
			.where(sql`"status" IN ('active', 'waiting')`),
	],
);

// NOTE: automation_step_runs is partitioned by range on executed_at in Postgres;
// Drizzle doesn't natively represent partitions but the parent table is queried
// transparently. Monthly partitions (2026-04 .. 2026-07) are created in the
// handwritten migration 0032_automation_tables.sql — add future partitions via
// additional SQL migrations as time progresses.
export const automationStepRuns = pgTable(
	"automation_step_runs",
	{
		id: bigserial("id", { mode: "bigint" }).notNull(),
		runId: text("run_id").notNull(),
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
		primaryKey({ columns: [table.id, table.executedAt] }),
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
		status: text("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		payload: jsonb("payload"),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("idx_scheduled_jobs_sweep").on(table.status, table.runAt),
		index("idx_scheduled_jobs_run").on(table.runId),
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
		contactId: text("contact_id")
			.notNull()
			.references(() => contacts.id, { onDelete: "cascade" }),
		automationId: text("automation_id").references(() => automations.id, {
			onDelete: "cascade",
		}),
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
			onDelete: "set null",
		}),
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
		index("segments_org_idx").on(table.organizationId),
		index("segments_workspace_idx").on(table.workspaceId),
	],
);

export const contactSegmentMemberships = pgTable(
	"contact_segment_memberships",
	{
		contactId: text("contact_id")
			.notNull()
			.references(() => contacts.id, { onDelete: "cascade" }),
		segmentId: text("segment_id")
			.notNull()
			.references(() => segments.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		source: text("source").notNull().default("manual"),
		createdByUserId: text("created_by_user_id").references(() => user.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
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
			onDelete: "set null",
		}),
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
	(table) => [index("subscription_lists_org_idx").on(table.organizationId)],
);

export const contactSubscriptions = pgTable(
	"contact_subscriptions",
	{
		contactId: text("contact_id").notNull(),
		listId: text("list_id")
			.notNull()
			.references(() => subscriptionLists.id, { onDelete: "cascade" }),
		subscribedAt: timestamp("subscribed_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
		source: text("source"), // 'automation' | 'manual' | 'import' | 'api'
	},
	(table) => [
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
			onDelete: "set null",
		}),
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
	(table) => [index("ai_knowledge_bases_org_idx").on(table.organizationId)],
);

export const aiKnowledgeDocuments = pgTable(
	"ai_knowledge_documents",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("kbd_")),
		kbId: text("kb_id")
			.notNull()
			.references(() => aiKnowledgeBases.id, { onDelete: "cascade" }),
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
	(table) => [index("ai_knowledge_documents_kb_idx").on(table.kbId)],
);

export const aiKnowledgeChunks = pgTable(
	"ai_knowledge_chunks",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("kbc_")),
		documentId: text("document_id")
			.notNull()
			.references(() => aiKnowledgeDocuments.id, { onDelete: "cascade" }),
		kbId: text("kb_id")
			.notNull()
			.references(() => aiKnowledgeBases.id, { onDelete: "cascade" }),
		content: text("content").notNull(),
		embedding: real("embedding").array(), // 1536-dim float array; swap to pgvector in follow-up
		chunkIndex: integer("chunk_index").notNull(),
		tokenCount: integer("token_count"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
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
			onDelete: "set null",
		}),
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
	(table) => [index("ai_agents_org_idx").on(table.organizationId)],
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
			onDelete: "set null",
		}),
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
		uniqueIndex("ref_urls_org_slug_idx").on(table.organizationId, table.slug),
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
		refUrlId: text("ref_url_id")
			.notNull()
			.references(() => refUrls.id, { onDelete: "cascade" }),
		imageR2Key: text("image_r2_key"),
		scanCount: integer("scan_count").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [index("qr_codes_org_idx").on(table.organizationId)],
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
			onDelete: "set null",
		}),
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
		uniqueIndex("landing_pages_org_slug_idx").on(
			table.organizationId,
			table.slug,
		),
		index("landing_pages_automation_idx").on(table.automationId),
	],
);
