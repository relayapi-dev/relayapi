-- RelayAPI required database preamble (generated).
CREATE SCHEMA IF NOT EXISTS "auth";
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";
--> statement-breakpoint
DO $relay_verify_extension_schema$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_extension extension_row
		JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = extension_row.extnamespace
		WHERE extension_row.extname = 'pg_trgm'
			AND namespace_row.nspname = 'public'
	) THEN
		RAISE EXCEPTION 'required extension pg_trgm must be installed in schema public';
	END IF;
END;
$relay_verify_extension_schema$;
--> statement-breakpoint
CREATE TYPE "public"."ad_objective" AS ENUM('awareness', 'traffic', 'engagement', 'leads', 'conversions', 'video_views');--> statement-breakpoint
CREATE TYPE "public"."ad_platform" AS ENUM('meta', 'google', 'tiktok', 'linkedin', 'pinterest', 'twitter');--> statement-breakpoint
CREATE TYPE "public"."ad_status" AS ENUM('draft', 'pending_review', 'active', 'paused', 'completed', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."audience_type" AS ENUM('customer_list', 'website', 'lookalike');--> statement-breakpoint
CREATE TYPE "public"."automation_binding_type" AS ENUM('default_reply', 'welcome_message', 'conversation_starter', 'main_menu', 'ice_breaker');--> statement-breakpoint
CREATE TYPE "public"."automation_channel" AS ENUM('instagram', 'facebook', 'whatsapp', 'telegram', 'tiktok');--> statement-breakpoint
CREATE TYPE "public"."automation_run_status" AS ENUM('active', 'waiting', 'completed', 'exited', 'failed');--> statement-breakpoint
CREATE TYPE "public"."automation_status" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('open', 'archived', 'snoozed');--> statement-breakpoint
CREATE TYPE "public"."conversation_type" AS ENUM('comment_thread', 'dm', 'review');--> statement-breakpoint
CREATE TYPE "public"."idea_activity_action" AS ENUM('created', 'moved', 'assigned', 'commented', 'converted', 'updated', 'media_added', 'media_removed', 'tagged', 'untagged');--> statement-breakpoint
CREATE TYPE "public"."idea_media_type" AS ENUM('image', 'video', 'gif', 'document');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'finalized', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('twitter', 'instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'pinterest', 'reddit', 'bluesky', 'threads', 'telegram', 'snapchat', 'googlebusiness', 'whatsapp', 'mastodon', 'discord', 'sms', 'beehiiv', 'convertkit', 'mailchimp', 'listmonk');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('draft', 'scheduled', 'publishing', 'published', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."recycle_gap_freq" AS ENUM('day', 'week', 'month');--> statement-breakpoint
CREATE TYPE "public"."storage_provider" AS ENUM('r2', 'byos');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TABLE "auth"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"idToken" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_revocation_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"platform" "platform" NOT NULL,
	"access_token_ciphertext" text,
	"refresh_token_ciphertext" text,
	"source_token_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"provider_response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "account_revocation_jobs_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "account_revocation_jobs_status_check" CHECK ("account_revocation_jobs"."status" IN ('pending', 'processing', 'retry', 'manual_required', 'succeeded')),
	CONSTRAINT "account_revocation_jobs_counters_nonnegative_check" CHECK ("account_revocation_jobs"."attempts" >= 0 AND "account_revocation_jobs"."source_token_version" >= 0),
	CONSTRAINT "account_revocation_jobs_lease_state_check" CHECK (("account_revocation_jobs"."status" = 'processing' AND "account_revocation_jobs"."lease_expires_at" IS NOT NULL)
				OR ("account_revocation_jobs"."status" <> 'processing' AND "account_revocation_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "account_revocation_jobs_completion_check" CHECK (("account_revocation_jobs"."status" IN ('manual_required', 'succeeded') AND "account_revocation_jobs"."completed_at" IS NOT NULL)
				OR ("account_revocation_jobs"."status" NOT IN ('manual_required', 'succeeded') AND "account_revocation_jobs"."completed_at" IS NULL)),
	CONSTRAINT "account_revocation_jobs_success_redaction_check" CHECK ("account_revocation_jobs"."status" <> 'succeeded'
				OR ("account_revocation_jobs"."access_token_ciphertext" IS NULL AND "account_revocation_jobs"."refresh_token_ciphertext" IS NULL)),
	CONSTRAINT "account_revocation_jobs_timestamp_order_check" CHECK ("account_revocation_jobs"."updated_at" >= "account_revocation_jobs"."created_at"
				AND ("account_revocation_jobs"."completed_at" IS NULL OR "account_revocation_jobs"."completed_at" >= "account_revocation_jobs"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "ad_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"social_account_id" text NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"platform_ad_account_id" text NOT NULL,
	"name" text,
	"currency" varchar(3) DEFAULT 'USD',
	"timezone" text,
	"status" text DEFAULT 'active',
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_accounts_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "ad_accounts_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "ad_accounts_id_org_scope_platform_uniq" UNIQUE("id","organization_id","scope_key","platform")
);
--> statement-breakpoint
CREATE TABLE "ad_audience_users" (
	"id" text PRIMARY KEY NOT NULL,
	"audience_id" text NOT NULL,
	"email_hash" text,
	"phone_hash" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_audience_users_identifier_present_check" CHECK ("ad_audience_users"."email_hash" IS NOT NULL OR "ad_audience_users"."phone_hash" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "ad_audiences" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"ad_account_id" text NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"platform_audience_id" text,
	"name" text NOT NULL,
	"type" "audience_type" NOT NULL,
	"description" text,
	"size" integer,
	"source_audience_id" text,
	"lookalike_spec" jsonb,
	"retargeting_rule" jsonb,
	"status" text DEFAULT 'pending',
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_audiences_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "ad_audiences_size_nonnegative_check" CHECK ("ad_audiences"."size" IS NULL OR "ad_audiences"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ad_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"ad_account_id" text NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"platform_campaign_id" text,
	"name" text NOT NULL,
	"objective" "ad_objective" NOT NULL,
	"status" "ad_status" DEFAULT 'draft' NOT NULL,
	"daily_budget_cents" integer,
	"lifetime_budget_cents" integer,
	"currency" varchar(3) DEFAULT 'USD',
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"is_external" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_campaigns_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "ad_campaigns_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "ad_campaigns_id_account_org_uniq" UNIQUE("id","ad_account_id","organization_id"),
	CONSTRAINT "ad_campaigns_id_account_org_scope_uniq" UNIQUE("id","ad_account_id","organization_id","scope_key"),
	CONSTRAINT "ad_campaigns_id_account_org_scope_platform_uniq" UNIQUE("id","ad_account_id","organization_id","scope_key","platform"),
	CONSTRAINT "ad_campaigns_budget_check" CHECK (("ad_campaigns"."daily_budget_cents" IS NULL OR "ad_campaigns"."daily_budget_cents" >= 0)
				AND ("ad_campaigns"."lifetime_budget_cents" IS NULL OR "ad_campaigns"."lifetime_budget_cents" >= 0)),
	CONSTRAINT "ad_campaigns_date_order_check" CHECK ("ad_campaigns"."end_date" IS NULL OR "ad_campaigns"."start_date" IS NULL OR "ad_campaigns"."end_date" >= "ad_campaigns"."start_date")
);
--> statement-breakpoint
CREATE TABLE "ad_creation_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"ad_account_id" text NOT NULL,
	"kind" text NOT NULL,
	"operation_key_hash" varchar(64) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"request_payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"phase" text DEFAULT 'campaign' NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"platform_campaign_id" text,
	"platform_ad_set_id" text,
	"platform_creative_id" text,
	"platform_ad_id" text,
	"local_campaign_id" text,
	"local_ad_id" text,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ad_creation_operations_kind_check" CHECK ("ad_creation_operations"."kind" IN ('create_campaign', 'create_ad', 'boost_post')),
	CONSTRAINT "ad_creation_operations_status_check" CHECK ("ad_creation_operations"."status" IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'reconciling', 'manual_review', 'completed', 'failed')),
	CONSTRAINT "ad_creation_operations_phase_check" CHECK ("ad_creation_operations"."phase" IN ('campaign', 'ad_set', 'creative', 'ad', 'activation', 'completed')),
	CONSTRAINT "ad_creation_operations_counters_nonnegative_check" CHECK ("ad_creation_operations"."attempts" >= 0 AND "ad_creation_operations"."lease_token" >= 0),
	CONSTRAINT "ad_creation_operations_lease_state_check" CHECK (("ad_creation_operations"."status" IN ('processing', 'request_may_have_been_sent', 'reconciling')
					AND "ad_creation_operations"."lease_expires_at" IS NOT NULL)
				OR ("ad_creation_operations"."status" NOT IN ('processing', 'request_may_have_been_sent', 'reconciling')
					AND "ad_creation_operations"."lease_expires_at" IS NULL)),
	CONSTRAINT "ad_creation_operations_request_boundary_check" CHECK ("ad_creation_operations"."status" <> 'request_may_have_been_sent'
				OR "ad_creation_operations"."request_may_have_been_sent_at" IS NOT NULL),
	CONSTRAINT "ad_creation_operations_completion_check" CHECK (("ad_creation_operations"."status" = 'completed'
					AND "ad_creation_operations"."phase" = 'completed'
					AND "ad_creation_operations"."completed_at" IS NOT NULL)
				OR ("ad_creation_operations"."status" <> 'completed'
					AND "ad_creation_operations"."phase" <> 'completed'
					AND "ad_creation_operations"."completed_at" IS NULL)),
	CONSTRAINT "ad_creation_operations_timestamp_order_check" CHECK ("ad_creation_operations"."updated_at" >= "ad_creation_operations"."created_at"
				AND ("ad_creation_operations"."request_may_have_been_sent_at" IS NULL OR "ad_creation_operations"."request_may_have_been_sent_at" >= "ad_creation_operations"."created_at")
				AND ("ad_creation_operations"."completed_at" IS NULL OR "ad_creation_operations"."completed_at" >= "ad_creation_operations"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "ad_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"ad_id" text NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"impressions" integer DEFAULT 0,
	"reach" integer DEFAULT 0,
	"clicks" integer DEFAULT 0,
	"spend_cents" integer DEFAULT 0,
	"conversions" integer DEFAULT 0,
	"video_views" integer DEFAULT 0,
	"engagement" integer DEFAULT 0,
	"ctr" integer,
	"cpc_cents" integer,
	"cpm_cents" integer,
	"demographics" jsonb,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_metrics_values_nonnegative_check" CHECK (("ad_metrics"."impressions" IS NULL OR "ad_metrics"."impressions" >= 0)
				AND ("ad_metrics"."reach" IS NULL OR "ad_metrics"."reach" >= 0)
				AND ("ad_metrics"."clicks" IS NULL OR "ad_metrics"."clicks" >= 0)
				AND ("ad_metrics"."spend_cents" IS NULL OR "ad_metrics"."spend_cents" >= 0)
				AND ("ad_metrics"."conversions" IS NULL OR "ad_metrics"."conversions" >= 0)
				AND ("ad_metrics"."video_views" IS NULL OR "ad_metrics"."video_views" >= 0)
				AND ("ad_metrics"."engagement" IS NULL OR "ad_metrics"."engagement" >= 0)
				AND ("ad_metrics"."ctr" IS NULL OR "ad_metrics"."ctr" >= 0)
				AND ("ad_metrics"."cpc_cents" IS NULL OR "ad_metrics"."cpc_cents" >= 0)
				AND ("ad_metrics"."cpm_cents" IS NULL OR "ad_metrics"."cpm_cents" >= 0))
);
--> statement-breakpoint
CREATE TABLE "ad_sync_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"ad_account_id" text NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"sync_type" text NOT NULL,
	"ads_created" integer DEFAULT 0 NOT NULL,
	"ads_updated" integer DEFAULT 0 NOT NULL,
	"metrics_updated" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ad_sync_logs_counts_nonnegative_check" CHECK ("ad_sync_logs"."ads_created" >= 0 AND "ad_sync_logs"."ads_updated" >= 0 AND "ad_sync_logs"."metrics_updated" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ads" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"campaign_id" text NOT NULL,
	"ad_account_id" text NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"platform_ad_id" text,
	"name" text NOT NULL,
	"status" "ad_status" DEFAULT 'draft' NOT NULL,
	"headline" text,
	"body" text,
	"call_to_action" text,
	"link_url" text,
	"image_url" text,
	"video_url" text,
	"boost_post_target_id" text,
	"boost_external_post_id" text,
	"boost_platform_post_id" text,
	"targeting" jsonb,
	"daily_budget_cents" integer,
	"lifetime_budget_cents" integer,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"duration_days" integer,
	"is_external" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ads_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "ads_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "ads_id_account_org_scope_platform_uniq" UNIQUE("id","ad_account_id","organization_id","scope_key","platform"),
	CONSTRAINT "ads_budget_duration_check" CHECK (("ads"."daily_budget_cents" IS NULL OR "ads"."daily_budget_cents" >= 0)
				AND ("ads"."lifetime_budget_cents" IS NULL OR "ads"."lifetime_budget_cents" >= 0)
				AND ("ads"."duration_days" IS NULL OR "ads"."duration_days" > 0)),
	CONSTRAINT "ads_date_order_check" CHECK ("ads"."end_date" IS NULL OR "ads"."start_date" IS NULL OR "ads"."end_date" >= "ads"."start_date")
);
--> statement-breakpoint
CREATE TABLE "ai_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name" text NOT NULL,
	"persona" text,
	"guardrails" text,
	"model" text DEFAULT 'claude-haiku-4-5' NOT NULL,
	"kb_id" text,
	"handoff_strategy" jsonb,
	"temperature" real DEFAULT 0.7,
	"max_tokens" integer DEFAULT 1024,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_agents_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "ai_agents_parameters_check" CHECK (("ai_agents"."temperature" IS NULL OR ("ai_agents"."temperature" >= 0 AND "ai_agents"."temperature" <= 2)) AND ("ai_agents"."max_tokens" IS NULL OR "ai_agents"."max_tokens" > 0))
);
--> statement-breakpoint
CREATE TABLE "ai_knowledge_bases" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"embedding_model" text DEFAULT 'text-embedding-3-small' NOT NULL,
	"embedding_dimensions" integer DEFAULT 1536 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_knowledge_bases_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "ai_knowledge_bases_dimensions_positive_check" CHECK ("ai_knowledge_bases"."embedding_dimensions" > 0)
);
--> statement-breakpoint
CREATE TABLE "ai_knowledge_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"kb_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"content" text NOT NULL,
	"embedding" real[],
	"chunk_index" integer NOT NULL,
	"token_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_knowledge_chunks_counts_nonnegative_check" CHECK ("ai_knowledge_chunks"."chunk_index" >= 0 AND ("ai_knowledge_chunks"."token_count" IS NULL OR "ai_knowledge_chunks"."token_count" >= 0))
);
--> statement-breakpoint
CREATE TABLE "ai_knowledge_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"kb_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text NOT NULL,
	"title" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_crawled_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_knowledge_documents_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "ai_knowledge_documents_status_check" CHECK ("ai_knowledge_documents"."status" IN ('pending', 'processing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "api_request_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"api_key_id" text NOT NULL,
	"method" varchar(7) NOT NULL,
	"path" text NOT NULL,
	"status_code" smallint NOT NULL,
	"response_time_ms" integer NOT NULL,
	"billable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_request_logs_http_values_check" CHECK ("api_request_logs"."status_code" BETWEEN 100 AND 599 AND "api_request_logs"."response_time_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "auth"."apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"configId" text DEFAULT 'default',
	"name" text,
	"start" text,
	"prefix" text,
	"key" text NOT NULL,
	"referenceId" text,
	"organizationId" text,
	"refillInterval" text,
	"refillAmount" integer,
	"lastRefillAt" timestamp with time zone,
	"enabled" boolean DEFAULT true,
	"rateLimitEnabled" boolean DEFAULT false,
	"rateLimitTimeWindow" integer,
	"rateLimitMax" integer,
	"requestCount" integer DEFAULT 0,
	"remaining" integer,
	"lastRequest" timestamp with time zone,
	"expiresAt" timestamp with time zone,
	"permissions" text,
	"metadata" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apikey_id_organization_uniq" UNIQUE("id","organizationId")
);
--> statement-breakpoint
CREATE TABLE "auto_post_feed_items" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"canonical_feed_item_id" text NOT NULL,
	"source_item_id" text,
	"canonical_url" text,
	"published_at" timestamp with time zone,
	"status" text NOT NULL,
	"post_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "auto_post_feed_items_status_check" CHECK ("auto_post_feed_items"."status" IN ('ignored', 'processing', 'committed', 'transient_failure', 'terminal_failure', 'unknown')),
	CONSTRAINT "auto_post_feed_items_completion_check" CHECK (("auto_post_feed_items"."status" = 'processing' AND "auto_post_feed_items"."completed_at" IS NULL)
				OR ("auto_post_feed_items"."status" <> 'processing' AND "auto_post_feed_items"."completed_at" IS NOT NULL)),
	CONSTRAINT "auto_post_feed_items_committed_post_check" CHECK ("auto_post_feed_items"."status" <> 'committed' OR "auto_post_feed_items"."post_id" IS NOT NULL),
	CONSTRAINT "auto_post_feed_items_timestamp_order_check" CHECK ("auto_post_feed_items"."completed_at" IS NULL OR "auto_post_feed_items"."completed_at" >= "auto_post_feed_items"."created_at")
);
--> statement-breakpoint
CREATE TABLE "auto_post_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name" text NOT NULL,
	"feed_url" text NOT NULL,
	"polling_interval_minutes" integer DEFAULT 60 NOT NULL,
	"content_template" text,
	"append_feed_url" boolean DEFAULT true NOT NULL,
	"account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'paused' NOT NULL,
	"last_processed_url" text,
	"last_processed_at" timestamp with time zone,
	"last_error" text,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_post_rules_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "auto_post_rules_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "auto_post_rules_status_check" CHECK ("auto_post_rules"."status" IN ('active', 'paused', 'error')),
	CONSTRAINT "auto_post_rules_numeric_check" CHECK ("auto_post_rules"."polling_interval_minutes" > 0
				AND "auto_post_rules"."consecutive_errors" >= 0
				AND "auto_post_rules"."lease_token" >= 0),
	CONSTRAINT "auto_post_rules_lease_state_check" CHECK ("auto_post_rules"."lease_expires_at" IS NULL OR "auto_post_rules"."status" = 'active'),
	CONSTRAINT "auto_post_rules_timestamp_order_check" CHECK ("auto_post_rules"."updated_at" >= "auto_post_rules"."created_at")
);
--> statement-breakpoint
CREATE TABLE "automation_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"social_account_id" text NOT NULL,
	"channel" "automation_channel" NOT NULL,
	"binding_type" "automation_binding_type" NOT NULL,
	"automation_id" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_bindings_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "automation_bindings_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "automation_bindings_status_check" CHECK ("automation_bindings"."status" IN ('active', 'paused', 'pending_sync', 'sync_failed', 'inactive')),
	CONSTRAINT "automation_bindings_timestamp_order_check" CHECK ("automation_bindings"."updated_at" >= "automation_bindings"."created_at")
);
--> statement-breakpoint
CREATE TABLE "automation_contact_controls" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"automation_id" text,
	"pause_reason" text,
	"paused_until" timestamp with time zone,
	"paused_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_effects" (
	"id" text PRIMARY KEY NOT NULL,
	"node_execution_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"effect_key" text NOT NULL,
	"kind" text NOT NULL,
	"provider_idempotency_key" text NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"provider_reference" text,
	"result" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "automation_effects_status_check" CHECK ("automation_effects"."status" IN ('claimed', 'in_flight', 'succeeded', 'failed', 'unknown')),
	CONSTRAINT "automation_effects_counters_nonnegative_check" CHECK ("automation_effects"."attempts" >= 0 AND "automation_effects"."lease_token" >= 0),
	CONSTRAINT "automation_effects_state_fields_check" CHECK (("automation_effects"."status" = 'claimed'
					AND "automation_effects"."lease_expires_at" IS NOT NULL
					AND "automation_effects"."request_may_have_been_sent_at" IS NULL
					AND "automation_effects"."completed_at" IS NULL)
				OR ("automation_effects"."status" = 'in_flight'
					AND "automation_effects"."lease_expires_at" IS NOT NULL
					AND "automation_effects"."request_may_have_been_sent_at" IS NOT NULL
					AND "automation_effects"."completed_at" IS NULL)
				OR ("automation_effects"."status" IN ('succeeded', 'failed', 'unknown')
					AND "automation_effects"."lease_expires_at" IS NULL
					AND "automation_effects"."completed_at" IS NOT NULL)),
	CONSTRAINT "automation_effects_timestamp_order_check" CHECK ("automation_effects"."updated_at" >= "automation_effects"."created_at"
				AND ("automation_effects"."request_may_have_been_sent_at" IS NULL OR "automation_effects"."request_may_have_been_sent_at" >= "automation_effects"."created_at")
				AND ("automation_effects"."completed_at" IS NULL OR "automation_effects"."completed_at" >= "automation_effects"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "automation_entrypoints" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"automation_id" text NOT NULL,
	"channel" "automation_channel" NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"social_account_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"filters" jsonb,
	"allow_reentry" boolean DEFAULT true NOT NULL,
	"reentry_cooldown_min" integer DEFAULT 60 NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"specificity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_entrypoints_id_automation_org_uniq" UNIQUE("id","automation_id","organization_id"),
	CONSTRAINT "automation_entrypoints_id_automation_org_scope_uniq" UNIQUE("id","automation_id","organization_id","scope_key"),
	CONSTRAINT "automation_entrypoints_status_check" CHECK ("automation_entrypoints"."status" IN ('active', 'paused', 'disabled')),
	CONSTRAINT "automation_entrypoints_numeric_check" CHECK ("automation_entrypoints"."reentry_cooldown_min" >= 0 AND "automation_entrypoints"."specificity" >= 0),
	CONSTRAINT "automation_entrypoints_timestamp_order_check" CHECK ("automation_entrypoints"."updated_at" >= "automation_entrypoints"."created_at")
);
--> statement-breakpoint
CREATE TABLE "automation_node_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"run_revision" integer NOT NULL,
	"visit_ordinal" integer NOT NULL,
	"node_key" text NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"result" jsonb,
	"error" jsonb,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_node_executions_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "automation_node_executions_status_check" CHECK ("automation_node_executions"."status" IN ('claimed', 'in_flight', 'succeeded', 'failed', 'unknown')),
	CONSTRAINT "automation_node_executions_counters_nonnegative_check" CHECK ("automation_node_executions"."run_revision" >= 0 AND "automation_node_executions"."visit_ordinal" >= 0 AND "automation_node_executions"."attempts" >= 0 AND "automation_node_executions"."lease_token" >= 0),
	CONSTRAINT "automation_node_executions_state_fields_check" CHECK (("automation_node_executions"."status" = 'claimed'
					AND "automation_node_executions"."lease_expires_at" IS NOT NULL
					AND "automation_node_executions"."request_may_have_been_sent_at" IS NULL
					AND "automation_node_executions"."completed_at" IS NULL)
				OR ("automation_node_executions"."status" = 'in_flight'
					AND "automation_node_executions"."lease_expires_at" IS NOT NULL
					AND "automation_node_executions"."request_may_have_been_sent_at" IS NOT NULL
					AND "automation_node_executions"."completed_at" IS NULL)
				OR ("automation_node_executions"."status" IN ('succeeded', 'failed', 'unknown')
					AND "automation_node_executions"."lease_expires_at" IS NULL
					AND "automation_node_executions"."completed_at" IS NOT NULL)),
	CONSTRAINT "automation_node_executions_timestamp_order_check" CHECK ("automation_node_executions"."updated_at" >= "automation_node_executions"."claimed_at"
				AND ("automation_node_executions"."request_may_have_been_sent_at" IS NULL OR "automation_node_executions"."request_may_have_been_sent_at" >= "automation_node_executions"."claimed_at")
				AND ("automation_node_executions"."completed_at" IS NULL OR "automation_node_executions"."completed_at" >= "automation_node_executions"."claimed_at"))
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"entrypoint_id" text,
	"binding_id" text,
	"contact_id" text NOT NULL,
	"conversation_id" text,
	"trigger_occurrence_id" text,
	"status" "automation_run_status" DEFAULT 'active' NOT NULL,
	"current_node_key" text,
	"current_port_key" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"waiting_until" timestamp with time zone,
	"waiting_for" text,
	"exit_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_runs_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "automation_runs_revision_nonnegative_check" CHECK ("automation_runs"."revision" >= 0),
	CONSTRAINT "automation_runs_waiting_for_check" CHECK ("automation_runs"."waiting_for" IS NULL OR "automation_runs"."waiting_for" IN ('input', 'delay', 'external_event')),
	CONSTRAINT "automation_runs_wait_state_check" CHECK ("automation_runs"."status" <> 'waiting' OR "automation_runs"."waiting_for" IS NOT NULL),
	CONSTRAINT "automation_runs_completion_check" CHECK (("automation_runs"."status" IN ('completed', 'exited', 'failed')
					AND "automation_runs"."completed_at" IS NOT NULL
					AND "automation_runs"."exit_reason" IS NOT NULL)
				OR ("automation_runs"."status" IN ('active', 'waiting') AND "automation_runs"."completed_at" IS NULL)),
	CONSTRAINT "automation_runs_timestamp_order_check" CHECK ("automation_runs"."updated_at" >= "automation_runs"."started_at"
				AND ("automation_runs"."completed_at" IS NULL OR "automation_runs"."completed_at" >= "automation_runs"."started_at"))
);
--> statement-breakpoint
CREATE TABLE "automation_scheduled_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"occurrence_id" text NOT NULL,
	"run_id" text,
	"job_type" text NOT NULL,
	"automation_id" text,
	"entrypoint_id" text,
	"run_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"effect_started_at" timestamp with time zone,
	"payload" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_scheduled_jobs_status_check" CHECK ("automation_scheduled_jobs"."status" IN ('pending', 'processing', 'done', 'failed', 'unknown')),
	CONSTRAINT "automation_scheduled_jobs_counters_nonnegative_check" CHECK ("automation_scheduled_jobs"."attempts" >= 0 AND "automation_scheduled_jobs"."lease_token" >= 0),
	CONSTRAINT "automation_scheduled_jobs_type_check" CHECK ("automation_scheduled_jobs"."job_type" IN ('resume_run', 'input_timeout', 'scheduled_trigger', 'webhook_reception_failure')),
	CONSTRAINT "automation_scheduled_jobs_lease_state_check" CHECK (("automation_scheduled_jobs"."status" = 'processing'
					AND "automation_scheduled_jobs"."claimed_at" IS NOT NULL
					AND "automation_scheduled_jobs"."lease_expires_at" IS NOT NULL)
				OR ("automation_scheduled_jobs"."status" <> 'processing' AND "automation_scheduled_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "automation_scheduled_jobs_unknown_boundary_check" CHECK ("automation_scheduled_jobs"."status" <> 'unknown' OR "automation_scheduled_jobs"."effect_started_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "automation_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"automation_id" text NOT NULL,
	"node_key" text NOT NULL,
	"action_id" text NOT NULL,
	"kind" text DEFAULT 'webhook_out' NOT NULL,
	"ciphertext" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_step_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"automation_id" text NOT NULL,
	"node_key" text NOT NULL,
	"node_kind" text NOT NULL,
	"entered_via_port_key" text,
	"exited_via_port_key" text,
	"outcome" text NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"error" jsonb,
	"executed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "automation_step_runs_outcome_check" CHECK ("automation_step_runs"."outcome" IN ('ok', 'wait_input', 'wait_delay', 'end', 'failed', 'graph_changed')),
	CONSTRAINT "automation_step_runs_duration_nonnegative_check" CHECK ("automation_step_runs"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "automation_webhook_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"automation_id" text NOT NULL,
	"entrypoint_id" text NOT NULL,
	"request_digest" varchar(64) NOT NULL,
	"signature_timestamp" text NOT NULL,
	"payload_ciphertext" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"run_id" text,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "automation_webhook_receipts_status_check" CHECK ("automation_webhook_receipts"."status" IN ('pending', 'processing', 'failed', 'succeeded', 'terminal_failed')),
	CONSTRAINT "automation_webhook_receipts_counters_nonnegative_check" CHECK ("automation_webhook_receipts"."attempts" >= 0 AND "automation_webhook_receipts"."lease_token" >= 0),
	CONSTRAINT "automation_webhook_receipts_lease_state_check" CHECK (("automation_webhook_receipts"."status" = 'processing' AND "automation_webhook_receipts"."lease_expires_at" IS NOT NULL)
				OR ("automation_webhook_receipts"."status" <> 'processing' AND "automation_webhook_receipts"."lease_expires_at" IS NULL)),
	CONSTRAINT "automation_webhook_receipts_completion_check" CHECK (("automation_webhook_receipts"."status" IN ('succeeded', 'terminal_failed') AND "automation_webhook_receipts"."completed_at" IS NOT NULL)
				OR ("automation_webhook_receipts"."status" NOT IN ('succeeded', 'terminal_failed') AND "automation_webhook_receipts"."completed_at" IS NULL)),
	CONSTRAINT "automation_webhook_receipts_success_run_check" CHECK ("automation_webhook_receipts"."status" <> 'succeeded' OR "automation_webhook_receipts"."run_id" IS NOT NULL),
	CONSTRAINT "automation_webhook_receipts_retention_check" CHECK ("automation_webhook_receipts"."expires_at" > "automation_webhook_receipts"."received_at"
				AND ("automation_webhook_receipts"."completed_at" IS NULL OR "automation_webhook_receipts"."completed_at" >= "automation_webhook_receipts"."received_at"))
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"channel" "automation_channel" NOT NULL,
	"status" "automation_status" DEFAULT 'draft' NOT NULL,
	"graph" jsonb DEFAULT '{"schema_version":1,"root_node_key":null,"nodes":[],"edges":[]}'::jsonb NOT NULL,
	"created_from_template" text,
	"template_config" jsonb,
	"total_enrolled" integer DEFAULT 0 NOT NULL,
	"total_completed" integer DEFAULT 0 NOT NULL,
	"total_exited" integer DEFAULT 0 NOT NULL,
	"total_failed" integer DEFAULT 0 NOT NULL,
	"last_validated_at" timestamp with time zone,
	"validation_errors" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "automations_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "automations_counters_check" CHECK ("automations"."total_enrolled" >= 0
				AND "automations"."total_completed" >= 0
				AND "automations"."total_exited" >= 0
				AND "automations"."total_failed" >= 0
				AND "automations"."total_completed" + "automations"."total_exited" + "automations"."total_failed" <= "automations"."total_enrolled"),
	CONSTRAINT "automations_timestamp_order_check" CHECK ("automations"."updated_at" >= "automations"."created_at")
);
--> statement-breakpoint
CREATE TABLE "billing_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"usage_bucket_settlement_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_invoice_item_id" text,
	"idempotency_key" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'usd' NOT NULL,
	"description" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "billing_operations_usage_bucket_settlement_id_unique" UNIQUE("usage_bucket_settlement_id"),
	CONSTRAINT "billing_operations_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "billing_operations_status_check" CHECK ("billing_operations"."status" IN ('pending', 'processing', 'failed', 'unknown', 'succeeded', 'terminal_failed')),
	CONSTRAINT "billing_operations_numeric_check" CHECK ("billing_operations"."amount_cents" >= 0 AND "billing_operations"."attempts" >= 0 AND "billing_operations"."lease_token" >= 0),
	CONSTRAINT "billing_operations_lease_state_check" CHECK (("billing_operations"."status" = 'processing' AND "billing_operations"."lease_expires_at" IS NOT NULL)
				OR ("billing_operations"."status" <> 'processing' AND "billing_operations"."lease_expires_at" IS NULL)),
	CONSTRAINT "billing_operations_completion_check" CHECK ("billing_operations"."status" <> 'succeeded'
				OR ("billing_operations"."stripe_invoice_item_id" IS NOT NULL AND "billing_operations"."completed_at" IS NOT NULL)),
	CONSTRAINT "billing_operations_timestamp_order_check" CHECK ("billing_operations"."updated_at" >= "billing_operations"."created_at"
				AND ("billing_operations"."completed_at" IS NULL OR "billing_operations"."completed_at" >= "billing_operations"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "billing_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_outbox_status_check" CHECK ("billing_outbox"."status" IN ('pending', 'processing', 'succeeded', 'failed')),
	CONSTRAINT "billing_outbox_counters_nonnegative_check" CHECK ("billing_outbox"."attempts" >= 0 AND "billing_outbox"."lease_token" >= 0),
	CONSTRAINT "billing_outbox_lease_state_check" CHECK (("billing_outbox"."status" = 'processing' AND "billing_outbox"."lease_expires_at" IS NOT NULL)
				OR ("billing_outbox"."status" <> 'processing' AND "billing_outbox"."lease_expires_at" IS NULL)),
	CONSTRAINT "billing_outbox_completion_check" CHECK (("billing_outbox"."status" = 'succeeded' AND "billing_outbox"."processed_at" IS NOT NULL)
				OR ("billing_outbox"."status" <> 'succeeded' AND "billing_outbox"."processed_at" IS NULL)),
	CONSTRAINT "billing_outbox_timestamp_order_check" CHECK ("billing_outbox"."updated_at" >= "billing_outbox"."created_at"
				AND ("billing_outbox"."processed_at" IS NULL OR "billing_outbox"."processed_at" >= "billing_outbox"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "broadcast_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"broadcast_id" text NOT NULL,
	"contact_id" text,
	"contact_identifier" text NOT NULL,
	"contact_identifier_hash" text NOT NULL,
	"variables" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivery_state" text DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"message_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_recipients_status_check" CHECK ("broadcast_recipients"."status" IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled')),
	CONSTRAINT "broadcast_recipients_delivery_state_check" CHECK ("broadcast_recipients"."delivery_state" IN ('pending', 'in_flight', 'succeeded', 'failed', 'unknown', 'cancelled')),
	CONSTRAINT "broadcast_recipients_status_delivery_check" CHECK (("broadcast_recipients"."status" = 'pending' AND "broadcast_recipients"."delivery_state" = 'pending')
				OR ("broadcast_recipients"."status" = 'sending' AND "broadcast_recipients"."delivery_state" IN ('in_flight', 'unknown'))
				OR ("broadcast_recipients"."status" = 'sent' AND "broadcast_recipients"."delivery_state" = 'succeeded')
				OR ("broadcast_recipients"."status" = 'failed' AND "broadcast_recipients"."delivery_state" = 'failed')
				OR ("broadcast_recipients"."status" = 'unknown' AND "broadcast_recipients"."delivery_state" = 'unknown')
				OR ("broadcast_recipients"."status" = 'cancelled' AND "broadcast_recipients"."delivery_state" = 'cancelled')),
	CONSTRAINT "broadcast_recipients_claim_state_check" CHECK ("broadcast_recipients"."status" <> 'sending' OR "broadcast_recipients"."claimed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"social_account_id" text NOT NULL,
	"platform" "platform" NOT NULL,
	"name" text,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"message_text" text,
	"template_name" text,
	"template_language" text DEFAULT 'en_US',
	"template_components" jsonb,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcasts_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "broadcasts_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "broadcasts_status_check" CHECK ("broadcasts"."status" IN ('draft', 'scheduled', 'sending', 'sent', 'partially_failed', 'requires_attention', 'failed', 'cancelled')),
	CONSTRAINT "broadcasts_counts_nonnegative_check" CHECK ("broadcasts"."recipient_count" >= 0 AND "broadcasts"."sent_count" >= 0 AND "broadcasts"."failed_count" >= 0 AND "broadcasts"."revision" >= 0 AND "broadcasts"."lease_token" >= 0),
	CONSTRAINT "broadcasts_counts_bounded_check" CHECK ("broadcasts"."sent_count" + "broadcasts"."failed_count" <= "broadcasts"."recipient_count"),
	CONSTRAINT "broadcasts_schedule_state_check" CHECK ("broadcasts"."status" <> 'scheduled' OR ("broadcasts"."scheduled_at" IS NOT NULL AND "broadcasts"."recipient_count" > 0)),
	CONSTRAINT "broadcasts_lease_state_check" CHECK ("broadcasts"."lease_expires_at" IS NULL OR "broadcasts"."status" = 'sending'),
	CONSTRAINT "broadcasts_terminal_timestamp_check" CHECK ("broadcasts"."status" NOT IN ('sent', 'partially_failed', 'requires_attention', 'failed', 'cancelled') OR "broadcasts"."completed_at" IS NOT NULL),
	CONSTRAINT "broadcasts_content_check" CHECK (("broadcasts"."platform" = 'whatsapp' AND "broadcasts"."template_name" IS NOT NULL)
				OR ("broadcasts"."platform" <> 'whatsapp' AND "broadcasts"."message_text" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "byos_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"bucket" text NOT NULL,
	"region" text,
	"access_key_id" text NOT NULL,
	"secret_access_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "byos_configs_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "connection_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"social_account_id" text,
	"platform" "platform" NOT NULL,
	"event" text NOT NULL,
	"message" text,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"contact_id" text NOT NULL,
	"social_account_id" text NOT NULL,
	"platform" "platform" NOT NULL,
	"identifier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_consent_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" text,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"ingestion_sequence" bigserial NOT NULL,
	"channel" text NOT NULL,
	"purpose" text NOT NULL,
	"status" text NOT NULL,
	"identifier_hash" text NOT NULL,
	"identifier_masked" text,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"evidence" jsonb,
	"policy_version" text,
	"jurisdiction" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_consent_events_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "contact_consent_events_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "contact_consent_events_ingestion_sequence_uniq" UNIQUE("ingestion_sequence"),
	CONSTRAINT "contact_consent_events_projection_source_uniq" UNIQUE("id","organization_id","scope_key","ingestion_sequence"),
	CONSTRAINT "contact_consent_events_status_check" CHECK ("contact_consent_events"."status" IN ('granted', 'denied')),
	CONSTRAINT "contact_consent_events_sequence_positive_check" CHECK ("contact_consent_events"."ingestion_sequence" > 0),
	CONSTRAINT "contact_consent_events_timestamp_order_check" CHECK ("contact_consent_events"."occurred_at" <= "contact_consent_events"."created_at" + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE "contact_consent_states" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"contact_id" text,
	"channel" text NOT NULL,
	"purpose" text NOT NULL,
	"identifier_hash" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"policy_version" text,
	"jurisdiction" text,
	"last_event_id" text NOT NULL,
	"last_ingestion_sequence" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_consent_states_sequence_positive_check" CHECK ("contact_consent_states"."last_ingestion_sequence" > 0),
	CONSTRAINT "contact_consent_states_status_check" CHECK ("contact_consent_states"."status" IN ('granted', 'denied')),
	CONSTRAINT "contact_consent_states_timestamp_order_check" CHECK ("contact_consent_states"."occurred_at" <= "contact_consent_states"."updated_at" + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE "contact_segment_memberships" (
	"contact_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_segment_memberships_pk" PRIMARY KEY("contact_id","segment_id")
);
--> statement-breakpoint
CREATE TABLE "contact_subscriptions" (
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"contact_id" text NOT NULL,
	"list_id" text NOT NULL,
	"subscribed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	"source" text,
	CONSTRAINT "contact_subscriptions_contact_id_list_id_pk" PRIMARY KEY("contact_id","list_id")
);
--> statement-breakpoint
CREATE TABLE "contact_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"channel" text NOT NULL,
	"purpose" text NOT NULL,
	"identifier_hash" text NOT NULL,
	"source_event_id" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name" text,
	"email" text,
	"email_canonical" text GENERATED ALWAYS AS (CASE WHEN "email" IS NULL THEN NULL ELSE lower(btrim("email")) END) STORED,
	"phone" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"opted_in" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "contacts_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key")
);
--> statement-breakpoint
CREATE TABLE "content_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"content" text NOT NULL,
	"platform_overrides" jsonb,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_templates_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key")
);
--> statement-breakpoint
CREATE TABLE "cross_post_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"post_id" text NOT NULL,
	"source_target_id" text NOT NULL,
	"source_platform" "platform" DEFAULT 'twitter' NOT NULL,
	"action_type" text NOT NULL,
	"target_account_id" text NOT NULL,
	"target_platform" "platform" DEFAULT 'twitter' NOT NULL,
	"content" text,
	"delay_minutes" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"execute_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"result_post_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"readiness_checks" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cross_post_actions_type_check" CHECK ("cross_post_actions"."action_type" IN ('repost', 'comment', 'quote')),
	CONSTRAINT "cross_post_actions_status_check" CHECK ("cross_post_actions"."status" IN ('pending', 'processing', 'executing', 'retry', 'executed', 'failed', 'unknown', 'cancelled')),
	CONSTRAINT "cross_post_actions_platform_check" CHECK ("cross_post_actions"."source_platform" = "cross_post_actions"."target_platform"),
	CONSTRAINT "cross_post_actions_counters_nonnegative_check" CHECK ("cross_post_actions"."delay_minutes" >= 0 AND "cross_post_actions"."attempts" >= 0 AND "cross_post_actions"."readiness_checks" >= 0 AND "cross_post_actions"."lease_token" >= 0),
	CONSTRAINT "cross_post_actions_lease_state_check" CHECK (("cross_post_actions"."status" IN ('processing', 'executing') AND "cross_post_actions"."lease_expires_at" IS NOT NULL)
				OR ("cross_post_actions"."status" NOT IN ('processing', 'executing') AND "cross_post_actions"."lease_expires_at" IS NULL)),
	CONSTRAINT "cross_post_actions_request_boundary_check" CHECK ("cross_post_actions"."status" <> 'executing' OR "cross_post_actions"."request_may_have_been_sent_at" IS NOT NULL),
	CONSTRAINT "cross_post_actions_completion_check" CHECK (("cross_post_actions"."status" IN ('executed', 'failed', 'unknown', 'cancelled')
					AND "cross_post_actions"."completed_at" IS NOT NULL)
				OR ("cross_post_actions"."status" NOT IN ('executed', 'failed', 'unknown', 'cancelled')
					AND "cross_post_actions"."completed_at" IS NULL)),
	CONSTRAINT "cross_post_actions_execution_check" CHECK ("cross_post_actions"."status" <> 'executed' OR "cross_post_actions"."executed_at" IS NOT NULL),
	CONSTRAINT "cross_post_actions_timestamp_order_check" CHECK (("cross_post_actions"."request_may_have_been_sent_at" IS NULL OR "cross_post_actions"."request_may_have_been_sent_at" >= "cross_post_actions"."created_at")
				AND ("cross_post_actions"."executed_at" IS NULL OR "cross_post_actions"."executed_at" >= "cross_post_actions"."created_at")
				AND ("cross_post_actions"."completed_at" IS NULL OR "cross_post_actions"."completed_at" >= "cross_post_actions"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "custom_field_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_definitions_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "custom_field_definitions_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key")
);
--> statement-breakpoint
CREATE TABLE "custom_field_values" (
	"id" text PRIMARY KEY NOT NULL,
	"definition_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"definition_scope_key" text DEFAULT 'org' NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_values_definition_scope_check" CHECK ("custom_field_values"."definition_scope_key" = 'org' OR "custom_field_values"."definition_scope_key" = "custom_field_values"."scope_key")
);
--> statement-breakpoint
CREATE TABLE "dunning_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"invoice_id" text,
	"stripe_invoice_id" text,
	"event" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivery_idempotency_key" text NOT NULL,
	"provider_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"deactivation_status" text DEFAULT 'not_applicable' NOT NULL,
	"deactivation_operation_id" text,
	"deactivation_requested_at" timestamp with time zone,
	"deactivation_confirmed_at" timestamp with time zone,
	"deactivation_provider_response" jsonb,
	"deactivation_last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dunning_events_delivery_idempotency_key_unique" UNIQUE("delivery_idempotency_key"),
	CONSTRAINT "dunning_events_deactivation_operation_id_unique" UNIQUE("deactivation_operation_id"),
	CONSTRAINT "dunning_events_identity_check" CHECK ("dunning_events"."invoice_id" IS NOT NULL OR "dunning_events"."stripe_invoice_id" IS NOT NULL),
	CONSTRAINT "dunning_events_event_check" CHECK ("dunning_events"."event" IN ('reminder_1d', 'reminder_7d', 'deactivated_14d')),
	CONSTRAINT "dunning_events_status_check" CHECK ("dunning_events"."status" IN ('pending', 'processing', 'sent', 'failed', 'terminal_failed')),
	CONSTRAINT "dunning_events_counters_nonnegative_check" CHECK ("dunning_events"."attempts" >= 0 AND "dunning_events"."lease_token" >= 0),
	CONSTRAINT "dunning_events_delivery_state_check" CHECK (("dunning_events"."status" = 'sent' AND "dunning_events"."sent_at" IS NOT NULL)
				OR ("dunning_events"."status" <> 'sent' AND "dunning_events"."sent_at" IS NULL)),
	CONSTRAINT "dunning_events_processing_lease_check" CHECK ("dunning_events"."status" <> 'processing' OR "dunning_events"."lease_expires_at" IS NOT NULL),
	CONSTRAINT "dunning_events_deactivation_state_check" CHECK ((
				"dunning_events"."event" <> 'deactivated_14d'
				AND "dunning_events"."deactivation_status" = 'not_applicable'
				AND "dunning_events"."deactivation_operation_id" IS NULL
				AND "dunning_events"."deactivation_requested_at" IS NULL
				AND "dunning_events"."deactivation_confirmed_at" IS NULL
				AND "dunning_events"."deactivation_provider_response" IS NULL
				AND "dunning_events"."deactivation_last_error" IS NULL
			) OR (
				"dunning_events"."event" = 'deactivated_14d'
				AND "dunning_events"."deactivation_status" IN ('pending', 'processing', 'unknown', 'succeeded', 'failed', 'manual_review')
				AND "dunning_events"."deactivation_operation_id" IS NOT NULL
				AND (
					("dunning_events"."deactivation_status" = 'succeeded' AND "dunning_events"."deactivation_confirmed_at" IS NOT NULL)
					OR ("dunning_events"."deactivation_status" <> 'succeeded' AND "dunning_events"."deactivation_confirmed_at" IS NULL)
				)
			))
);
--> statement-breakpoint
CREATE TABLE "email_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"request_may_have_been_sent_at" timestamp with time zone,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "email_deliveries_status_check" CHECK ("email_deliveries"."status" IN ('pending', 'unknown', 'sent', 'failed')),
	CONSTRAINT "email_deliveries_attempts_nonnegative_check" CHECK ("email_deliveries"."attempts" >= 0),
	CONSTRAINT "email_deliveries_state_fields_check" CHECK (("email_deliveries"."status" = 'pending' AND "email_deliveries"."completed_at" IS NULL)
				OR ("email_deliveries"."status" = 'unknown'
					AND "email_deliveries"."completed_at" IS NULL)
				OR ("email_deliveries"."status" IN ('sent', 'failed')
					AND "email_deliveries"."request_may_have_been_sent_at" IS NOT NULL
					AND "email_deliveries"."completed_at" IS NOT NULL)),
	CONSTRAINT "email_deliveries_timestamp_order_check" CHECK (("email_deliveries"."request_may_have_been_sent_at" IS NULL OR "email_deliveries"."request_may_have_been_sent_at" >= "email_deliveries"."created_at")
				AND ("email_deliveries"."completed_at" IS NULL OR "email_deliveries"."completed_at" >= "email_deliveries"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "external_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"social_account_id" text NOT NULL,
	"platform" "platform" NOT NULL,
	"platform_post_id" text NOT NULL,
	"platform_url" text,
	"content" text,
	"media_urls" jsonb DEFAULT '[]'::jsonb,
	"media_type" text,
	"thumbnail_url" text,
	"platform_data" jsonb DEFAULT '{}'::jsonb,
	"metrics" jsonb DEFAULT '{}'::jsonb,
	"metrics_updated_at" timestamp with time zone,
	"notes" text,
	"published_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_posts_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key")
);
--> statement-breakpoint
CREATE TABLE "idea_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"idea_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" "idea_activity_action" NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idea_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"idea_id" text NOT NULL,
	"author_id" text NOT NULL,
	"content" text NOT NULL,
	"parent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idea_conversion_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"idea_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"idempotency_key" text NOT NULL,
	"post_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "idea_conversion_operations_status_check" CHECK ("idea_conversion_operations"."status" IN ('pending', 'processing', 'succeeded', 'failed')),
	CONSTRAINT "idea_conversion_operations_counters_nonnegative_check" CHECK ("idea_conversion_operations"."revision" >= 0 AND "idea_conversion_operations"."attempts" >= 0 AND "idea_conversion_operations"."lease_token" >= 0),
	CONSTRAINT "idea_conversion_operations_completion_check" CHECK ("idea_conversion_operations"."status" <> 'succeeded' OR ("idea_conversion_operations"."post_id" IS NOT NULL AND "idea_conversion_operations"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "idea_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"color" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idea_groups_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "idea_groups_position_nonnegative_check" CHECK ("idea_groups"."position" >= 0),
	CONSTRAINT "idea_groups_revision_nonnegative_check" CHECK ("idea_groups"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "idea_media" (
	"id" text PRIMARY KEY NOT NULL,
	"idea_id" text NOT NULL,
	"media_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"type" "idea_media_type" NOT NULL,
	"alt" text,
	"position" integer DEFAULT 0 NOT NULL,
	"delete_with_idea" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idea_media_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "idea_media_position_nonnegative_check" CHECK ("idea_media"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "idea_tags" (
	"idea_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"tag_scope_key" text DEFAULT 'org' NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	CONSTRAINT "idea_tags_idea_id_tag_id_pk" PRIMARY KEY("idea_id","tag_id"),
	CONSTRAINT "idea_tags_tag_visibility_check" CHECK ("idea_tags"."tag_scope_key" = 'org' OR "idea_tags"."tag_scope_key" = "idea_tags"."scope_key")
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"title" text,
	"content" text,
	"group_id" text NOT NULL,
	"group_scope_key" text DEFAULT 'org' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"assigned_to" text,
	"converted_to_post_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ideas_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "ideas_group_visibility_check" CHECK ("ideas"."group_scope_key" = 'org' OR "ideas"."group_scope_key" = "ideas"."scope_key"),
	CONSTRAINT "ideas_position_nonnegative_check" CHECK ("ideas"."position" >= 0),
	CONSTRAINT "ideas_revision_nonnegative_check" CHECK ("ideas"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "idempotency_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"method" varchar(7) NOT NULL,
	"route" text NOT NULL,
	"route_hash" varchar(64) NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'in_progress' NOT NULL,
	"resource_id" text,
	"response_status" integer,
	"response_body_ciphertext" text,
	"response_content_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_receipts_state_check" CHECK ("idempotency_receipts"."state" IN ('in_progress', 'completed', 'unknown')),
	CONSTRAINT "idempotency_receipts_response_status_check" CHECK ("idempotency_receipts"."response_status" IS NULL OR "idempotency_receipts"."response_status" BETWEEN 100 AND 599),
	CONSTRAINT "idempotency_receipts_completion_check" CHECK (("idempotency_receipts"."state" = 'in_progress'
					AND "idempotency_receipts"."response_status" IS NULL
					AND "idempotency_receipts"."response_body_ciphertext" IS NULL
					AND "idempotency_receipts"."response_content_type" IS NULL
					AND "idempotency_receipts"."completed_at" IS NULL)
				OR ("idempotency_receipts"."state" = 'completed'
					AND "idempotency_receipts"."response_status" IS NOT NULL
					AND "idempotency_receipts"."response_body_ciphertext" IS NOT NULL
					AND "idempotency_receipts"."completed_at" IS NOT NULL)
				OR ("idempotency_receipts"."state" = 'unknown' AND "idempotency_receipts"."completed_at" IS NULL)),
	CONSTRAINT "idempotency_receipts_timestamp_order_check" CHECK ("idempotency_receipts"."updated_at" >= "idempotency_receipts"."created_at"
				AND "idempotency_receipts"."expires_at" > "idempotency_receipts"."created_at"
				AND ("idempotency_receipts"."completed_at" IS NULL OR "idempotency_receipts"."completed_at" >= "idempotency_receipts"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "inbound_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"delivery_key" text NOT NULL,
	"payload_ciphertext" text NOT NULL,
	"payload_key_id" text NOT NULL,
	"content_type" text,
	"signature_metadata" jsonb,
	"organization_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"manual_review_until" timestamp with time zone,
	"redacted_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "inbound_webhook_events_status_check" CHECK ("inbound_webhook_events"."status" IN ('received', 'queued', 'processing', 'completed', 'failed', 'exhausted')),
	CONSTRAINT "inbound_webhook_events_attempts_nonnegative_check" CHECK ("inbound_webhook_events"."attempts" >= 0),
	CONSTRAINT "inbound_webhook_events_retention_check" CHECK ("inbound_webhook_events"."expires_at" > "inbound_webhook_events"."received_at" AND ("inbound_webhook_events"."manual_review_until" IS NULL OR "inbound_webhook_events"."manual_review_until" <= "inbound_webhook_events"."received_at" + interval '90 days')),
	CONSTRAINT "inbound_webhook_events_processing_check" CHECK ("inbound_webhook_events"."status" <> 'processing' OR "inbound_webhook_events"."claimed_at" IS NOT NULL),
	CONSTRAINT "inbound_webhook_events_completion_check" CHECK (("inbound_webhook_events"."status" = 'completed'
					AND "inbound_webhook_events"."claimed_at" IS NOT NULL
					AND "inbound_webhook_events"."processed_at" IS NOT NULL)
				OR ("inbound_webhook_events"."status" <> 'completed' AND "inbound_webhook_events"."processed_at" IS NULL)),
	CONSTRAINT "inbound_webhook_events_timestamp_order_check" CHECK (("inbound_webhook_events"."claimed_at" IS NULL OR "inbound_webhook_events"."claimed_at" >= "inbound_webhook_events"."received_at")
				AND ("inbound_webhook_events"."processed_at" IS NULL OR "inbound_webhook_events"."processed_at" >= "inbound_webhook_events"."claimed_at")
				AND ("inbound_webhook_events"."redacted_at" IS NULL OR "inbound_webhook_events"."redacted_at" >= "inbound_webhook_events"."received_at"))
);
--> statement-breakpoint
CREATE TABLE "inbox_conversation_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"user_id" text,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_note_actor_type_check" CHECK ("inbox_conversation_notes"."actor_type" IN ('dashboard_user', 'service')),
	CONSTRAINT "inbox_note_actor_user_check" CHECK (("inbox_conversation_notes"."actor_type" = 'service' AND "inbox_conversation_notes"."user_id" IS NULL) OR ("inbox_conversation_notes"."actor_type" = 'dashboard_user' AND ("inbox_conversation_notes"."user_id" IS NULL OR "inbox_conversation_notes"."actor_id" = "inbox_conversation_notes"."user_id")))
);
--> statement-breakpoint
CREATE TABLE "inbox_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"account_id" text NOT NULL,
	"platform" "platform" NOT NULL,
	"type" "conversation_type" NOT NULL,
	"platform_conversation_id" text NOT NULL,
	"post_id" text,
	"post_platform_id" text,
	"participant_name" text,
	"participant_platform_id" text,
	"participant_avatar" text,
	"participant_metadata" jsonb DEFAULT '{}'::jsonb,
	"status" "conversation_status" DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal',
	"labels" text[] DEFAULT '{}',
	"unread_count" integer DEFAULT 0 NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"last_message_text" text,
	"last_message_at" timestamp with time zone,
	"last_message_direction" text,
	"sentiment_avg" integer,
	"contact_id" text,
	"assigned_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_conversations_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "inbox_conversations_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "inbox_conversations_counts_nonnegative_check" CHECK ("inbox_conversations"."unread_count" >= 0 AND "inbox_conversations"."message_count" >= 0),
	CONSTRAINT "inbox_conversations_sentiment_range_check" CHECK ("inbox_conversations"."sentiment_avg" IS NULL OR "inbox_conversations"."sentiment_avg" BETWEEN -100 AND 100)
);
--> statement-breakpoint
CREATE TABLE "inbox_event_effects" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"platform_event_id" text NOT NULL,
	"effect" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"effect_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"replay_payload" jsonb,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_enqueued_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_event_effects_effect_check" CHECK ("inbox_event_effects"."effect" IN ('automation', 'customer_webhook', 'realtime')),
	CONSTRAINT "inbox_event_effects_status_check" CHECK ("inbox_event_effects"."status" IN ('pending', 'in_flight', 'unknown', 'completed')),
	CONSTRAINT "inbox_event_effects_counters_nonnegative_check" CHECK ("inbox_event_effects"."attempts" >= 0 AND "inbox_event_effects"."lease_token" >= 0),
	CONSTRAINT "inbox_event_effects_lease_state_check" CHECK (("inbox_event_effects"."status" = 'in_flight'
					AND "inbox_event_effects"."lease_expires_at" IS NOT NULL
					AND "inbox_event_effects"."started_at" IS NOT NULL
					AND "inbox_event_effects"."completed_at" IS NULL)
				OR ("inbox_event_effects"."status" <> 'in_flight' AND "inbox_event_effects"."lease_expires_at" IS NULL)),
	CONSTRAINT "inbox_event_effects_completion_check" CHECK ("inbox_event_effects"."status" <> 'completed' OR "inbox_event_effects"."completed_at" IS NOT NULL),
	CONSTRAINT "inbox_event_effects_timestamp_order_check" CHECK (("inbox_event_effects"."effect_started_at" IS NULL OR ("inbox_event_effects"."started_at" IS NOT NULL AND "inbox_event_effects"."effect_started_at" >= "inbox_event_effects"."started_at"))
				AND ("inbox_event_effects"."completed_at" IS NULL OR ("inbox_event_effects"."started_at" IS NOT NULL AND "inbox_event_effects"."completed_at" >= "inbox_event_effects"."started_at")))
);
--> statement-breakpoint
CREATE TABLE "inbox_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"account_id" text DEFAULT '' NOT NULL,
	"platform" "platform" DEFAULT 'twitter' NOT NULL,
	"platform_message_id" text NOT NULL,
	"author_name" text,
	"author_platform_id" text,
	"author_avatar_url" text,
	"text" text,
	"direction" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb,
	"sentiment_score" integer,
	"classification" text,
	"platform_data" jsonb DEFAULT '{}'::jsonb,
	"is_hidden" boolean DEFAULT false,
	"is_liked" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_messages_sentiment_range_check" CHECK ("inbox_messages"."sentiment_score" IS NULL OR "inbox_messages"."sentiment_score" BETWEEN -100 AND 100)
);
--> statement-breakpoint
CREATE TABLE "auth"."invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"inviterId" text NOT NULL,
	"organizationId" text NOT NULL,
	"role" text,
	"status" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_by" text NOT NULL,
	"token_hash" text NOT NULL,
	"scope" text NOT NULL,
	"scoped_workspace_ids" jsonb,
	"role" text NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"used_by" text,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"base_price_cents" integer DEFAULT 0 NOT NULL,
	"api_calls_count" integer DEFAULT 0 NOT NULL,
	"api_calls_included" integer DEFAULT 10000 NOT NULL,
	"overage_calls" integer DEFAULT 0 NOT NULL,
	"overage_cost_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"stripe_invoice_id" text,
	"stripe_hosted_url" text,
	"first_payment_failed_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id"),
	CONSTRAINT "invoices_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "invoices_period_order_check" CHECK ("invoices"."period_end" > "invoices"."period_start"),
	CONSTRAINT "invoices_amounts_nonnegative_check" CHECK ("invoices"."base_price_cents" >= 0
				AND "invoices"."api_calls_count" >= 0
				AND "invoices"."api_calls_included" >= 0
				AND "invoices"."overage_calls" >= 0
				AND "invoices"."overage_cost_cents" >= 0
				AND "invoices"."total_cents" >= 0),
	CONSTRAINT "invoices_failure_not_draft_check" CHECK ("invoices"."first_payment_failed_at" IS NULL OR "invoices"."status" <> 'draft')
);
--> statement-breakpoint
CREATE TABLE "landing_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"config" jsonb NOT NULL,
	"automation_id" text,
	"visits" integer DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landing_pages_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "landing_pages_counts_nonnegative_check" CHECK ("landing_pages"."visits" >= 0 AND "landing_pages"."conversions" >= 0 AND "landing_pages"."conversions" <= "landing_pages"."visits")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"storage_provider" "storage_provider" DEFAULT 'r2' NOT NULL,
	"url" text,
	"thumbnail_key" text,
	"thumbnail_url" text,
	"thumbnail_status" text DEFAULT 'pending' NOT NULL,
	"thumbnail_attempts" integer DEFAULT 0 NOT NULL,
	"thumbnail_next_retry_at" timestamp with time zone,
	"thumbnail_last_error" text,
	"original_deleted_at" timestamp with time zone,
	"deletion_requested_at" timestamp with time zone,
	"original_deletion_confirmed_at" timestamp with time zone,
	"thumbnail_deletion_confirmed_at" timestamp with time zone,
	"deletion_attempts" integer DEFAULT 0 NOT NULL,
	"deletion_next_retry_at" timestamp with time zone,
	"deletion_last_error" text,
	"width" integer,
	"height" integer,
	"duration" integer,
	"uploaded_by" text,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "media_status_check" CHECK ("media"."status" IN ('pending', 'uploading', 'upload_failed', 'ready', 'deleting', 'deletion_failed')),
	CONSTRAINT "media_thumbnail_status_check" CHECK ("media"."thumbnail_status" IN ('pending', 'generated', 'unsupported', 'source_missing', 'transient_failure')),
	CONSTRAINT "media_numeric_check" CHECK ("media"."size" >= 0
				AND "media"."thumbnail_attempts" >= 0
				AND "media"."deletion_attempts" >= 0
				AND ("media"."width" IS NULL OR "media"."width" > 0)
				AND ("media"."height" IS NULL OR "media"."height" > 0)
				AND ("media"."duration" IS NULL OR "media"."duration" >= 0))
);
--> statement-breakpoint
CREATE TABLE "auth"."member" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"organizationId" text NOT NULL,
	"role" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_user_organization_uniq" UNIQUE("userId","organizationId")
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"post_failures" jsonb DEFAULT '{"push":true,"email":true}'::jsonb NOT NULL,
	"post_published" jsonb DEFAULT '{"push":true,"email":false}'::jsonb NOT NULL,
	"account_disconnects" jsonb DEFAULT '{"push":true,"email":true}'::jsonb NOT NULL,
	"payment_alerts" jsonb DEFAULT '{"push":true,"email":true}'::jsonb NOT NULL,
	"usage_alerts" jsonb DEFAULT '{"push":true,"email":true}'::jsonb NOT NULL,
	"weekly_digest" jsonb DEFAULT '{"push":false,"email":false}'::jsonb NOT NULL,
	"marketing" jsonb DEFAULT '{"push":false,"email":false}'::jsonb NOT NULL,
	"streak_warnings" jsonb DEFAULT '{"push":true,"email":true}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"occurrence_id" text,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "one_time_capabilities" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"organization_id" text,
	"payload_ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "org_streaks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"streak_started_at" timestamp with time zone,
	"last_post_at" timestamp with time zone,
	"current_streak_days" integer DEFAULT 0 NOT NULL,
	"best_streak_days" integer DEFAULT 0 NOT NULL,
	"total_streaks_broken" integer DEFAULT 0 NOT NULL,
	"warning_email_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_streaks_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "org_streaks_counts_check" CHECK ("org_streaks"."current_streak_days" >= 0
				AND "org_streaks"."best_streak_days" >= "org_streaks"."current_streak_days"
				AND "org_streaks"."total_streaks_broken" >= 0),
	CONSTRAINT "org_streaks_timestamp_order_check" CHECK ("org_streaks"."updated_at" >= "org_streaks"."created_at"
				AND ("org_streaks"."last_post_at" IS NULL OR "org_streaks"."streak_started_at" IS NULL OR "org_streaks"."last_post_at" >= "org_streaks"."streak_started_at"))
);
--> statement-breakpoint
CREATE TABLE "auth"."organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"lifecycle_status" text DEFAULT 'active' NOT NULL,
	"deletion_requested_at" timestamp with time zone,
	"tombstoned_at" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organization_lifecycle_status_check" CHECK ("auth"."organization"."lifecycle_status" IN ('active', 'deleting', 'tombstoned')),
	CONSTRAINT "organization_lifecycle_timestamps_check" CHECK (("auth"."organization"."lifecycle_status" = 'active' AND "auth"."organization"."deletion_requested_at" IS NULL AND "auth"."organization"."tombstoned_at" IS NULL)
				OR ("auth"."organization"."lifecycle_status" = 'deleting' AND "auth"."organization"."deletion_requested_at" IS NOT NULL AND "auth"."organization"."tombstoned_at" IS NULL)
				OR ("auth"."organization"."lifecycle_status" = 'tombstoned' AND "auth"."organization"."deletion_requested_at" IS NOT NULL AND "auth"."organization"."tombstoned_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "auth"."organization_creation_reservation" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "organization_creation_reservation_user_slug_uniq" UNIQUE("user_id","slug"),
	CONSTRAINT "organization_creation_reservation_expiry_check" CHECK ("auth"."organization_creation_reservation"."expires_at" > "auth"."organization_creation_reservation"."created_at")
);
--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"require_workspace_id" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by_user_id" text,
	"updated_by_api_key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_settings_revision_nonnegative_check" CHECK ("organization_settings"."revision" >= 0),
	CONSTRAINT "organization_settings_single_actor_check" CHECK ("organization_settings"."updated_by_user_id" IS NULL OR "organization_settings"."updated_by_api_key_id" IS NULL),
	CONSTRAINT "organization_settings_timestamp_order_check" CHECK ("organization_settings"."updated_at" >= "organization_settings"."created_at")
);
--> statement-breakpoint
CREATE TABLE "organization_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"status" "subscription_status" DEFAULT 'cancelled' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"posts_included" integer DEFAULT 1000 NOT NULL,
	"price_per_post_cents" integer DEFAULT 1 NOT NULL,
	"monthly_price_cents" integer DEFAULT 500 NOT NULL,
	"current_period_start" timestamp with time zone DEFAULT now() NOT NULL,
	"current_period_end" timestamp with time zone,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_metered_item_id" text,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"ai_enabled" boolean DEFAULT false NOT NULL,
	"daily_tool_limit" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_subscriptions_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "organization_subscriptions_numeric_check" CHECK ("organization_subscriptions"."posts_included" >= 0
				AND "organization_subscriptions"."price_per_post_cents" >= 0
				AND "organization_subscriptions"."monthly_price_cents" >= 0
				AND "organization_subscriptions"."daily_tool_limit" >= 0),
	CONSTRAINT "organization_subscriptions_period_check" CHECK ("organization_subscriptions"."current_period_end" IS NULL OR "organization_subscriptions"."current_period_end" > "organization_subscriptions"."current_period_start")
);
--> statement-breakpoint
CREATE TABLE "post_analytics" (
	"id" text PRIMARY KEY NOT NULL,
	"post_target_id" text NOT NULL,
	"platform" "platform" NOT NULL,
	"impressions" integer DEFAULT 0,
	"reach" integer DEFAULT 0,
	"likes" integer DEFAULT 0,
	"comments" integer DEFAULT 0,
	"shares" integer DEFAULT 0,
	"saves" integer DEFAULT 0,
	"clicks" integer DEFAULT 0,
	"views" integer DEFAULT 0,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_analytics_counts_nonnegative_check" CHECK (("post_analytics"."impressions" IS NULL OR "post_analytics"."impressions" >= 0)
				AND ("post_analytics"."reach" IS NULL OR "post_analytics"."reach" >= 0)
				AND ("post_analytics"."likes" IS NULL OR "post_analytics"."likes" >= 0)
				AND ("post_analytics"."comments" IS NULL OR "post_analytics"."comments" >= 0)
				AND ("post_analytics"."shares" IS NULL OR "post_analytics"."shares" >= 0)
				AND ("post_analytics"."saves" IS NULL OR "post_analytics"."saves" >= 0)
				AND ("post_analytics"."clicks" IS NULL OR "post_analytics"."clicks" >= 0)
				AND ("post_analytics"."views" IS NULL OR "post_analytics"."views" >= 0))
);
--> statement-breakpoint
CREATE TABLE "post_recycling_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source_post_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"gap" integer NOT NULL,
	"gap_freq" "recycle_gap_freq" NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"expire_count" integer,
	"expire_date" timestamp with time zone,
	"content_variations" jsonb DEFAULT '[]'::jsonb,
	"recycle_count" integer DEFAULT 0 NOT NULL,
	"content_variation_index" integer DEFAULT 0 NOT NULL,
	"next_recycle_at" timestamp with time zone,
	"last_recycled_at" timestamp with time zone,
	"processing_state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_recycling_configs_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "post_recycling_configs_state_check" CHECK ("post_recycling_configs"."processing_state" IN ('pending', 'processing', 'transient_failure', 'terminal_failure')),
	CONSTRAINT "post_recycling_configs_numeric_check" CHECK ("post_recycling_configs"."gap" > 0
				AND ("post_recycling_configs"."expire_count" IS NULL OR "post_recycling_configs"."expire_count" > 0)
				AND "post_recycling_configs"."recycle_count" >= 0
				AND "post_recycling_configs"."content_variation_index" >= 0
				AND "post_recycling_configs"."attempts" >= 0
				AND "post_recycling_configs"."lease_token" >= 0)
);
--> statement-breakpoint
CREATE TABLE "post_tags" (
	"post_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"tag_scope_key" text DEFAULT 'org' NOT NULL,
	CONSTRAINT "post_tags_post_id_tag_id_pk" PRIMARY KEY("post_id","tag_id"),
	CONSTRAINT "post_tags_tag_visibility_check" CHECK ("post_tags"."tag_scope_key" = 'org' OR "post_tags"."tag_scope_key" = "post_tags"."scope_key")
);
--> statement-breakpoint
CREATE TABLE "post_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"post_id" text NOT NULL,
	"social_account_id" text NOT NULL,
	"platform" "platform" NOT NULL,
	"status" "post_status" DEFAULT 'draft' NOT NULL,
	"publish_operation_id" text NOT NULL,
	"delivery_state" text DEFAULT 'queued' NOT NULL,
	"attempt_id" text,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"platform_post_id" text,
	"platform_url" text,
	"error" text,
	"error_code" text,
	"error_detail" text,
	"published_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_targets_id_publish_operation_uniq" UNIQUE("id","publish_operation_id"),
	CONSTRAINT "post_targets_id_post_org_scope_platform_uniq" UNIQUE("id","post_id","organization_id","scope_key","platform"),
	CONSTRAINT "post_targets_delivery_state_check" CHECK ("post_targets"."delivery_state" IN ('queued', 'in_flight', 'succeeded', 'failed', 'unknown')),
	CONSTRAINT "post_targets_delivery_projection_check" CHECK (("post_targets"."delivery_state" = 'queued')
				OR ("post_targets"."delivery_state" = 'in_flight'
					AND "post_targets"."status" = 'publishing'
					AND "post_targets"."attempt_id" IS NOT NULL
					AND "post_targets"."claimed_at" IS NOT NULL
					AND "post_targets"."lease_expires_at" IS NOT NULL
					AND "post_targets"."request_may_have_been_sent_at" IS NULL)
				OR ("post_targets"."delivery_state" = 'unknown'
					AND "post_targets"."status" = 'publishing'
					AND "post_targets"."attempt_id" IS NOT NULL
					AND "post_targets"."claimed_at" IS NOT NULL
					AND "post_targets"."request_may_have_been_sent_at" IS NOT NULL)
				OR ("post_targets"."delivery_state" = 'succeeded'
					AND "post_targets"."status" = 'published'
					AND "post_targets"."published_at" IS NOT NULL)
				OR ("post_targets"."delivery_state" = 'failed' AND "post_targets"."status" = 'failed')),
	CONSTRAINT "post_targets_lease_order_check" CHECK ("post_targets"."lease_expires_at" IS NULL OR ("post_targets"."claimed_at" IS NOT NULL AND "post_targets"."lease_expires_at" > "post_targets"."claimed_at"))
);
--> statement-breakpoint
CREATE TABLE "post_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_threads_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "post_threads_revision_nonnegative_check" CHECK ("post_threads"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"content" text,
	"status" "post_status" DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"platform_overrides" jsonb,
	"recycled_from_id" text,
	"created_by" text,
	"metrics_snapshot" jsonb DEFAULT '{}'::jsonb,
	"metrics_collected_at" timestamp with time zone,
	"notes" text,
	"thread_group_id" text,
	"thread_position" integer,
	"thread_delay_ms" integer DEFAULT 0,
	"terminal_reason" jsonb,
	"publish_lease_id" text,
	"publish_lease_expires_at" timestamp with time zone,
	"publish_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posts_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "posts_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "posts_thread_fields_pair_check" CHECK (("posts"."thread_group_id" IS NULL) = ("posts"."thread_position" IS NULL)),
	CONSTRAINT "posts_thread_position_nonnegative_check" CHECK ("posts"."thread_position" IS NULL OR "posts"."thread_position" >= 0),
	CONSTRAINT "posts_thread_delay_nonnegative_check" CHECK ("posts"."thread_delay_ms" IS NULL OR "posts"."thread_delay_ms" >= 0),
	CONSTRAINT "posts_publish_attempts_nonnegative_check" CHECK ("posts"."publish_attempts" >= 0),
	CONSTRAINT "posts_revision_nonnegative_check" CHECK ("posts"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "publish_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"publish_operation_id" text NOT NULL,
	"post_target_id" text NOT NULL,
	"state" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"request_may_have_been_sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"provider_post_id" text,
	"error" text,
	CONSTRAINT "publish_attempts_state_check" CHECK ("publish_attempts"."state" IN ('in_flight', 'succeeded', 'failed', 'unknown')),
	CONSTRAINT "publish_attempts_lease_order_check" CHECK ("publish_attempts"."lease_expires_at" > "publish_attempts"."claimed_at"),
	CONSTRAINT "publish_attempts_completion_check" CHECK (("publish_attempts"."state" = 'in_flight' AND "publish_attempts"."completed_at" IS NULL)
				OR ("publish_attempts"."state" IN ('succeeded', 'failed', 'unknown')
					AND "publish_attempts"."completed_at" IS NOT NULL)),
	CONSTRAINT "publish_attempts_timestamp_order_check" CHECK ("publish_attempts"."completed_at" IS NULL OR "publish_attempts"."completed_at" >= "publish_attempts"."claimed_at")
);
--> statement-breakpoint
CREATE TABLE "publish_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"post_id" text,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publish_outbox_kind_check" CHECK ("publish_outbox"."kind" IN ('publish', 'publish_thread', 'notification', 'post_completion')),
	CONSTRAINT "publish_outbox_status_check" CHECK ("publish_outbox"."status" IN ('pending', 'dispatching', 'dispatched')),
	CONSTRAINT "publish_outbox_attempts_nonnegative_check" CHECK ("publish_outbox"."attempts" >= 0),
	CONSTRAINT "publish_outbox_dispatch_completion_check" CHECK ("publish_outbox"."status" <> 'dispatched' OR "publish_outbox"."dispatched_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "qr_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"ref_url_id" text NOT NULL,
	"image_r2_key" text,
	"scan_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qr_codes_scan_count_nonnegative_check" CHECK ("qr_codes"."scan_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "queue_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"queue_name" text NOT NULL,
	"message_id" text NOT NULL,
	"organization_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"operation_id" text,
	"failure_kind" text NOT NULL,
	"status" text DEFAULT 'unresolved' NOT NULL,
	"attempts" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replay_claim_token" text,
	"replay_claim_expires_at" timestamp with time zone,
	"replay_requested_at" timestamp with time zone,
	"replay_error" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "queue_failures_kind_check" CHECK ("queue_failures"."failure_kind" IN ('permanent_input', 'unknown_external_outcome', 'dead_letter')),
	CONSTRAINT "queue_failures_status_check" CHECK ("queue_failures"."status" IN ('unresolved', 'replay_claimed', 'replay_unknown', 'replayed', 'dismissed')),
	CONSTRAINT "queue_failures_attempts_nonnegative_check" CHECK ("queue_failures"."attempts" >= 0),
	CONSTRAINT "queue_failures_replay_claim_check" CHECK ("queue_failures"."status" <> 'replay_claimed'
				OR ("queue_failures"."replay_claim_token" IS NOT NULL
					AND "queue_failures"."replay_claim_expires_at" IS NOT NULL
					AND "queue_failures"."replay_requested_at" IS NOT NULL)),
	CONSTRAINT "queue_failures_resolution_check" CHECK (("queue_failures"."status" IN ('replayed', 'dismissed') AND "queue_failures"."resolved_at" IS NOT NULL)
				OR ("queue_failures"."status" NOT IN ('replayed', 'dismissed') AND "queue_failures"."resolved_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "recycling_occurrences" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"config_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"post_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "recycling_occurrences_status_check" CHECK ("recycling_occurrences"."status" IN ('processing', 'committed', 'transient_failure', 'terminal_failure', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "ref_urls" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"slug" text NOT NULL,
	"automation_id" text,
	"uses" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ref_urls_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "ref_urls_uses_nonnegative_check" CHECK ("ref_urls"."uses" >= 0)
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"filter" jsonb NOT NULL,
	"is_dynamic" boolean DEFAULT true NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segments_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "segments_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "segments_member_count_nonnegative_check" CHECK ("segments"."member_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "auth"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"token" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"activeOrganizationId" text,
	"impersonatedBy" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "short_link_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"mode" text DEFAULT 'never' NOT NULL,
	"provider" text,
	"api_key" text,
	"domain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "short_link_configs_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "short_links" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"original_url" text NOT NULL,
	"provider" text DEFAULT 'relayapi' NOT NULL,
	"short_code" text NOT NULL,
	"short_url" text NOT NULL,
	"post_id" text,
	"click_count" integer DEFAULT 0 NOT NULL,
	"last_click_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "short_links_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "short_links_click_count_nonnegative_check" CHECK ("short_links"."click_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "signatures" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"position" text DEFAULT 'append' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signatures_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key")
);
--> statement-breakpoint
CREATE TABLE "social_account_sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"social_account_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"platform" "platform" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_post_found_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone,
	"poll_interval_sec" integer DEFAULT 3600 NOT NULL,
	"consecutive_empty_polls" integer DEFAULT 0 NOT NULL,
	"sync_cursor" text,
	"rate_limit_reset_at" timestamp with time zone,
	"rate_limit_remaining" integer,
	"last_error" text,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"last_error_at" timestamp with time zone,
	"total_posts_synced" integer DEFAULT 0 NOT NULL,
	"total_sync_runs" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_account_sync_state_social_account_id_unique" UNIQUE("social_account_id"),
	CONSTRAINT "social_account_sync_state_counters_nonnegative_check" CHECK ("social_account_sync_state"."poll_interval_sec" > 0
				AND "social_account_sync_state"."consecutive_empty_polls" >= 0
				AND "social_account_sync_state"."consecutive_errors" >= 0
				AND "social_account_sync_state"."total_posts_synced" >= 0
				AND "social_account_sync_state"."total_sync_runs" >= 0
				AND ("social_account_sync_state"."rate_limit_remaining" IS NULL OR "social_account_sync_state"."rate_limit_remaining" >= 0))
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"platform" "platform" NOT NULL,
	"platform_account_id" text NOT NULL,
	"webhook_account_id" text,
	"username" text,
	"display_name" text,
	"avatar_url" text,
	"access_token" text,
	"refresh_token" text,
	"token_version" integer DEFAULT 0 NOT NULL,
	"token_expires_at" timestamp with time zone,
	"scopes" text[],
	"metadata" jsonb,
	"lifecycle_status" text DEFAULT 'active' NOT NULL,
	"disconnect_requested_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"disconnect_reason" text,
	"scheduling_preferences" jsonb,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_accounts_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "social_accounts_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "social_accounts_id_org_scope_platform_uniq" UNIQUE("id","organization_id","scope_key","platform"),
	CONSTRAINT "social_accounts_lifecycle_status_check" CHECK ("social_accounts"."lifecycle_status" IN ('active', 'disconnecting', 'disconnected')),
	CONSTRAINT "social_accounts_token_version_nonnegative_check" CHECK ("social_accounts"."token_version" >= 0),
	CONSTRAINT "social_accounts_disconnect_timestamps_check" CHECK (("social_accounts"."lifecycle_status" = 'active' AND "social_accounts"."disconnected_at" IS NULL)
				OR ("social_accounts"."lifecycle_status" = 'disconnecting' AND "social_accounts"."disconnect_requested_at" IS NOT NULL AND "social_accounts"."disconnected_at" IS NULL)
				OR ("social_accounts"."lifecycle_status" = 'disconnected' AND "social_accounts"."disconnect_requested_at" IS NOT NULL AND "social_accounts"."disconnected_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"object_id" text,
	"customer_id" text,
	"subscription_id" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"lease_expires_at" timestamp with time zone,
	"stripe_created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_events_status_check" CHECK ("stripe_events"."status" IN ('pending', 'processing', 'succeeded', 'failed', 'manual_review')),
	CONSTRAINT "stripe_events_counters_nonnegative_check" CHECK ("stripe_events"."attempts" >= 0 AND "stripe_events"."lease_token" >= 0),
	CONSTRAINT "stripe_events_lease_state_check" CHECK (("stripe_events"."status" = 'processing' AND "stripe_events"."lease_expires_at" IS NOT NULL)
				OR ("stripe_events"."status" <> 'processing' AND "stripe_events"."lease_expires_at" IS NULL)),
	CONSTRAINT "stripe_events_completion_check" CHECK ("stripe_events"."status" <> 'succeeded' OR "stripe_events"."processed_at" IS NOT NULL),
	CONSTRAINT "stripe_events_timestamp_order_check" CHECK ("stripe_events"."updated_at" >= "stripe_events"."received_at"
				AND ("stripe_events"."processed_at" IS NULL OR "stripe_events"."processed_at" >= "stripe_events"."received_at"))
);
--> statement-breakpoint
CREATE TABLE "subscription_checkout_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_customer_id" text,
	"stripe_checkout_session_id" text,
	"stripe_checkout_url" text,
	"idempotency_key" text NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"session_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "subscription_checkout_operations_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "subscription_checkout_operations_status_check" CHECK ("subscription_checkout_operations"."status" IN ('pending', 'creating', 'unknown', 'created', 'completed', 'blocked', 'failed', 'expired')),
	CONSTRAINT "subscription_checkout_operations_counters_nonnegative_check" CHECK ("subscription_checkout_operations"."attempts" >= 0 AND "subscription_checkout_operations"."lease_token" >= 0),
	CONSTRAINT "subscription_checkout_operations_state_fields_check" CHECK (("subscription_checkout_operations"."status" <> 'creating' OR "subscription_checkout_operations"."lease_expires_at" IS NOT NULL)
				AND ("subscription_checkout_operations"."status" <> 'created'
					OR ("subscription_checkout_operations"."stripe_customer_id" IS NOT NULL
						AND "subscription_checkout_operations"."stripe_checkout_session_id" IS NOT NULL
						AND "subscription_checkout_operations"."stripe_checkout_url" IS NOT NULL
						AND "subscription_checkout_operations"."session_expires_at" IS NOT NULL))
				AND ("subscription_checkout_operations"."status" <> 'completed'
					OR ("subscription_checkout_operations"."stripe_checkout_session_id" IS NOT NULL AND "subscription_checkout_operations"."completed_at" IS NOT NULL))
				AND ("subscription_checkout_operations"."status" <> 'expired' OR "subscription_checkout_operations"."session_expires_at" IS NOT NULL)),
	CONSTRAINT "subscription_checkout_operations_timestamp_order_check" CHECK ("subscription_checkout_operations"."updated_at" >= "subscription_checkout_operations"."created_at"
				AND ("subscription_checkout_operations"."session_expires_at" IS NULL OR "subscription_checkout_operations"."session_expires_at" > "subscription_checkout_operations"."created_at")
				AND ("subscription_checkout_operations"."completed_at" IS NULL OR "subscription_checkout_operations"."completed_at" >= "subscription_checkout_operations"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "subscription_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name" text NOT NULL,
	"channel" "automation_channel" NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_lists_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "subscription_lists_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key")
);
--> statement-breakpoint
CREATE TABLE "telegram_connection_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"api_key_id" text NOT NULL,
	"initial_workspace_scope" jsonb NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"chat_id" text,
	"chat_title" text,
	"account_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "telegram_connection_challenges_initial_scope_check" CHECK ("telegram_connection_challenges"."initial_workspace_scope" = '"all"'::jsonb OR (jsonb_typeof("telegram_connection_challenges"."initial_workspace_scope") = 'array' AND jsonb_array_length("telegram_connection_challenges"."initial_workspace_scope") > 0)),
	CONSTRAINT "telegram_connection_challenges_status_check" CHECK ("telegram_connection_challenges"."status" IN ('pending', 'processing', 'connected')),
	CONSTRAINT "telegram_connection_challenges_expiry_check" CHECK ("telegram_connection_challenges"."expires_at" > "telegram_connection_challenges"."created_at"),
	CONSTRAINT "telegram_connection_challenges_completion_check" CHECK ("telegram_connection_challenges"."status" <> 'connected' OR ("telegram_connection_challenges"."account_id" IS NOT NULL AND "telegram_connection_challenges"."chat_id" IS NOT NULL AND "telegram_connection_challenges"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "tenant_deletion_jobs" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text,
	"audit_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cleanup_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "tenant_deletion_jobs_status_check" CHECK ("tenant_deletion_jobs"."status" IN ('pending', 'processing', 'tombstoned', 'waiting_external', 'manual_review', 'failed', 'purged')),
	CONSTRAINT "tenant_deletion_jobs_attempts_nonnegative_check" CHECK ("tenant_deletion_jobs"."attempts" >= 0),
	CONSTRAINT "tenant_deletion_jobs_lease_token_nonnegative_check" CHECK ("tenant_deletion_jobs"."lease_token" >= 0),
	CONSTRAINT "tenant_deletion_jobs_lease_state_check" CHECK (("tenant_deletion_jobs"."status" = 'processing' AND "tenant_deletion_jobs"."lease_expires_at" IS NOT NULL)
				OR ("tenant_deletion_jobs"."status" <> 'processing' AND "tenant_deletion_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "tenant_deletion_jobs_completion_check" CHECK (("tenant_deletion_jobs"."status" = 'purged' AND "tenant_deletion_jobs"."completed_at" IS NOT NULL)
				OR ("tenant_deletion_jobs"."status" <> 'purged' AND "tenant_deletion_jobs"."completed_at" IS NULL)),
	CONSTRAINT "tenant_deletion_jobs_timestamp_order_check" CHECK ("tenant_deletion_jobs"."updated_at" >= "tenant_deletion_jobs"."requested_at"
				AND ("tenant_deletion_jobs"."completed_at" IS NULL OR "tenant_deletion_jobs"."completed_at" >= "tenant_deletion_jobs"."requested_at"))
);
--> statement-breakpoint
CREATE TABLE "tenant_deletion_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"step_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cursor" jsonb,
	"rows_deleted" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "tenant_deletion_steps_status_check" CHECK ("tenant_deletion_steps"."status" IN ('pending', 'processing', 'completed', 'failed', 'manual_review')),
	CONSTRAINT "tenant_deletion_steps_counters_nonnegative_check" CHECK ("tenant_deletion_steps"."rows_deleted" >= 0 AND "tenant_deletion_steps"."attempts" >= 0 AND "tenant_deletion_steps"."lease_token" >= 0),
	CONSTRAINT "tenant_deletion_steps_lease_state_check" CHECK (("tenant_deletion_steps"."status" = 'processing' AND "tenant_deletion_steps"."lease_expires_at" IS NOT NULL)
				OR ("tenant_deletion_steps"."status" <> 'processing' AND "tenant_deletion_steps"."lease_expires_at" IS NULL)),
	CONSTRAINT "tenant_deletion_steps_completion_check" CHECK (("tenant_deletion_steps"."status" = 'completed' AND "tenant_deletion_steps"."completed_at" IS NOT NULL)
				OR ("tenant_deletion_steps"."status" <> 'completed' AND "tenant_deletion_steps"."completed_at" IS NULL)),
	CONSTRAINT "tenant_deletion_steps_timestamp_order_check" CHECK ("tenant_deletion_steps"."updated_at" >= "tenant_deletion_steps"."created_at"
				AND ("tenant_deletion_steps"."completed_at" IS NULL OR "tenant_deletion_steps"."completed_at" >= "tenant_deletion_steps"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "thread_executions" (
	"thread_group_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"lease_id" text,
	"lease_expires_at" timestamp with time zone,
	"current_position" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failed_position" integer,
	"failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_executions_status_check" CHECK ("thread_executions"."status" IN ('queued', 'in_flight', 'completed', 'failed', 'unknown')),
	CONSTRAINT "thread_executions_counters_nonnegative_check" CHECK ("thread_executions"."current_position" >= 0 AND "thread_executions"."attempts" >= 0 AND ("thread_executions"."failed_position" IS NULL OR "thread_executions"."failed_position" >= 0)),
	CONSTRAINT "thread_executions_lease_pair_check" CHECK (("thread_executions"."lease_id" IS NULL) = ("thread_executions"."lease_expires_at" IS NULL)),
	CONSTRAINT "thread_executions_in_flight_check" CHECK ("thread_executions"."status" <> 'in_flight'
				OR ("thread_executions"."lease_id" IS NOT NULL AND "thread_executions"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "thread_executions_failure_check" CHECK ("thread_executions"."failed_position" IS NULL OR "thread_executions"."failure" IS NOT NULL),
	CONSTRAINT "thread_executions_timestamp_order_check" CHECK ("thread_executions"."updated_at" >= "thread_executions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "token_refresh_operations" (
	"account_id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"state" text NOT NULL,
	"fencing_token" integer DEFAULT 0 NOT NULL,
	"source_token_version" integer NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_may_have_been_sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_refresh_operations_state_check" CHECK ("token_refresh_operations"."state" IN ('claimed_pre_request', 'request_may_have_been_sent', 'succeeded', 'unknown')),
	CONSTRAINT "token_refresh_operations_counters_nonnegative_check" CHECK ("token_refresh_operations"."fencing_token" >= 0 AND "token_refresh_operations"."source_token_version" >= 0 AND "token_refresh_operations"."attempts" >= 0),
	CONSTRAINT "token_refresh_operations_state_fields_check" CHECK (("token_refresh_operations"."state" = 'claimed_pre_request'
					AND "token_refresh_operations"."lease_expires_at" IS NOT NULL
					AND "token_refresh_operations"."request_may_have_been_sent_at" IS NULL
					AND "token_refresh_operations"."completed_at" IS NULL)
				OR ("token_refresh_operations"."state" = 'request_may_have_been_sent'
					AND "token_refresh_operations"."lease_expires_at" IS NULL
					AND "token_refresh_operations"."request_may_have_been_sent_at" IS NOT NULL
					AND "token_refresh_operations"."completed_at" IS NULL)
				OR ("token_refresh_operations"."state" = 'succeeded'
					AND "token_refresh_operations"."lease_expires_at" IS NULL
					AND "token_refresh_operations"."request_may_have_been_sent_at" IS NOT NULL
					AND "token_refresh_operations"."completed_at" IS NOT NULL)
				OR ("token_refresh_operations"."state" = 'unknown'
					AND "token_refresh_operations"."lease_expires_at" IS NULL
					AND "token_refresh_operations"."request_may_have_been_sent_at" IS NOT NULL)),
	CONSTRAINT "token_refresh_operations_timestamp_order_check" CHECK ("token_refresh_operations"."updated_at" >= "token_refresh_operations"."started_at"
				AND ("token_refresh_operations"."request_may_have_been_sent_at" IS NULL OR "token_refresh_operations"."request_may_have_been_sent_at" >= "token_refresh_operations"."started_at")
				AND ("token_refresh_operations"."completed_at" IS NULL OR "token_refresh_operations"."completed_at" >= "token_refresh_operations"."started_at"))
);
--> statement-breakpoint
CREATE TABLE "usage_bucket_settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"bucket_id" text NOT NULL,
	"settlement_key" text NOT NULL,
	"invoice_id" text,
	"state" text DEFAULT 'claimed' NOT NULL,
	"committed_units_snapshot" integer NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'usd' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_bucket_settlements_settlement_key_unique" UNIQUE("settlement_key"),
	CONSTRAINT "usage_bucket_settlements_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "usage_bucket_settlements_state_check" CHECK ("usage_bucket_settlements"."state" IN ('claimed', 'settled', 'released')),
	CONSTRAINT "usage_bucket_settlements_numeric_check" CHECK ("usage_bucket_settlements"."committed_units_snapshot" >= 0 AND "usage_bucket_settlements"."amount_cents" >= 0 AND "usage_bucket_settlements"."revision" >= 0),
	CONSTRAINT "usage_bucket_settlements_finalization_check" CHECK (("usage_bucket_settlements"."state" = 'claimed' AND "usage_bucket_settlements"."invoice_id" IS NULL AND "usage_bucket_settlements"."settled_at" IS NULL AND "usage_bucket_settlements"."released_at" IS NULL)
				OR ("usage_bucket_settlements"."state" = 'settled' AND "usage_bucket_settlements"."invoice_id" IS NOT NULL AND "usage_bucket_settlements"."settled_at" IS NOT NULL AND "usage_bucket_settlements"."released_at" IS NULL)
				OR ("usage_bucket_settlements"."state" = 'released' AND "usage_bucket_settlements"."invoice_id" IS NULL AND "usage_bucket_settlements"."settled_at" IS NULL AND "usage_bucket_settlements"."released_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "usage_buckets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"metric" text DEFAULT 'successful_mutation' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"included_units" integer NOT NULL,
	"committed_units" integer DEFAULT 0 NOT NULL,
	"reserved_units" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_buckets_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "usage_buckets_period_check" CHECK ("usage_buckets"."period_end" > "usage_buckets"."period_start"),
	CONSTRAINT "usage_buckets_counters_nonnegative_check" CHECK ("usage_buckets"."included_units" >= 0 AND "usage_buckets"."committed_units" >= 0 AND "usage_buckets"."reserved_units" >= 0 AND "usage_buckets"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"posts_count" integer DEFAULT 0 NOT NULL,
	"posts_included" integer DEFAULT 1000 NOT NULL,
	"overage_posts" integer DEFAULT 0 NOT NULL,
	"overage_cost_cents" integer DEFAULT 0 NOT NULL,
	"api_calls_count" integer DEFAULT 0 NOT NULL,
	"api_calls_included" integer DEFAULT 10000 NOT NULL,
	"overage_calls" integer DEFAULT 0 NOT NULL,
	"overage_calls_cost_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"billed_at" timestamp with time zone,
	CONSTRAINT "usage_records_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "usage_records_period_check" CHECK ("usage_records"."period_end" > "usage_records"."period_start"),
	CONSTRAINT "usage_records_counts_nonnegative_check" CHECK ("usage_records"."posts_count" >= 0 AND "usage_records"."posts_included" >= 0 AND "usage_records"."overage_posts" >= 0 AND "usage_records"."overage_cost_cents" >= 0 AND "usage_records"."api_calls_count" >= 0 AND "usage_records"."api_calls_included" >= 0 AND "usage_records"."overage_calls" >= 0 AND "usage_records"."overage_calls_cost_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "usage_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"bucket_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"units" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"response_status" integer,
	"source" text DEFAULT 'api' NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "usage_reservations_units_positive_check" CHECK ("usage_reservations"."units" > 0),
	CONSTRAINT "usage_reservations_state_check" CHECK ("usage_reservations"."state" IN ('reserved', 'committed', 'released')),
	CONSTRAINT "usage_reservations_finalization_check" CHECK (("usage_reservations"."state" = 'reserved' AND "usage_reservations"."finalized_at" IS NULL) OR ("usage_reservations"."state" <> 'reserved' AND "usage_reservations"."finalized_at" IS NOT NULL)),
	CONSTRAINT "usage_reservations_response_status_check" CHECK ("usage_reservations"."response_status" IS NULL OR ("usage_reservations"."response_status" >= 100 AND "usage_reservations"."response_status" <= 599))
);
--> statement-breakpoint
CREATE TABLE "auth"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text,
	"banned" boolean,
	"banReason" text,
	"banExpires" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "auth"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_event_id" text NOT NULL,
	"webhook_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"status_code" integer,
	"response_time_ms" integer,
	"error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatch_lease_id" text,
	"dispatch_lease_expires_at" timestamp with time zone,
	"next_dispatch_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_enqueued_at" timestamp with time zone,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_status_check" CHECK ("webhook_deliveries"."status" IN ('pending', 'in_flight', 'succeeded', 'failed', 'unknown')),
	CONSTRAINT "webhook_deliveries_counters_nonnegative_check" CHECK ("webhook_deliveries"."attempts" >= 0 AND "webhook_deliveries"."dispatch_attempts" >= 0 AND "webhook_deliveries"."lease_token" >= 0),
	CONSTRAINT "webhook_deliveries_http_values_check" CHECK (("webhook_deliveries"."status_code" IS NULL OR ("webhook_deliveries"."status_code" >= 100 AND "webhook_deliveries"."status_code" <= 599)) AND ("webhook_deliveries"."response_time_ms" IS NULL OR "webhook_deliveries"."response_time_ms" >= 0))
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"url" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_key_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"events" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "webhook_endpoints_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"occurrence_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "webhook_events_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key")
);
--> statement-breakpoint
CREATE TABLE "webhook_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"webhook_event_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"status_code" integer,
	"response_time_ms" integer,
	"success" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_logs_http_values_check" CHECK (("webhook_logs"."status_code" IS NULL OR "webhook_logs"."status_code" BETWEEN 100 AND 599)
				AND ("webhook_logs"."response_time_ms" IS NULL OR "webhook_logs"."response_time_ms" >= 0))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_phone_numbers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"social_account_id" text,
	"phone_number" text NOT NULL,
	"provider" text DEFAULT 'telnyx' NOT NULL,
	"provider_number_id" text,
	"telnyx_order_id" text,
	"wa_phone_number_id" text,
	"status" text DEFAULT 'purchasing' NOT NULL,
	"provisioning_operation_id" text NOT NULL,
	"provisioning_operation_key_hash" varchar(64) NOT NULL,
	"provisioning_request_hash" varchar(64) NOT NULL,
	"provisioning_source_account_id" text,
	"provisioning_state" text DEFAULT 'pending' NOT NULL,
	"provisioning_phase" text DEFAULT 'selected' NOT NULL,
	"provisioning_request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provisioning_lease_token" integer DEFAULT 0 NOT NULL,
	"provisioning_lease_expires_at" timestamp with time zone,
	"provisioning_request_may_have_been_sent_at" timestamp with time zone,
	"provisioning_attempts" integer DEFAULT 0 NOT NULL,
	"provisioning_next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provisioning_last_error" text,
	"stripe_checkout_session_id" text,
	"stripe_checkout_url" text,
	"release_operation_id" text,
	"release_reason" text,
	"release_state" text,
	"release_phase" text,
	"release_meta_status" text,
	"release_stripe_status" text,
	"release_telnyx_status" text,
	"release_source_account_id" text,
	"release_source_token_version" integer,
	"release_access_token_ciphertext" text,
	"release_lease_token" integer DEFAULT 0 NOT NULL,
	"release_lease_expires_at" timestamp with time zone,
	"release_request_may_have_been_sent_at" timestamp with time zone,
	"release_attempts" integer DEFAULT 0 NOT NULL,
	"release_next_attempt_at" timestamp with time zone,
	"release_last_error" text,
	"release_requested_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"verification_method" text,
	"stripe_subscription_item_id" text,
	"monthly_cost_cents" integer DEFAULT 200 NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_phone_numbers_status_check" CHECK ("whatsapp_phone_numbers"."status" IN ('purchasing', 'pending_verification', 'verified', 'active', 'releasing', 'released')),
	CONSTRAINT "wa_phone_numbers_provisioning_state_check" CHECK ("whatsapp_phone_numbers"."provisioning_state" IN ('pending', 'processing', 'waiting_external', 'request_may_have_been_sent', 'unknown', 'manual_review', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "wa_phone_numbers_provisioning_phase_check" CHECK ("whatsapp_phone_numbers"."provisioning_phase" IN ('selected', 'telnyx_order', 'billing', 'meta_registration', 'completed')),
	CONSTRAINT "wa_phone_numbers_release_state_check" CHECK ("whatsapp_phone_numbers"."release_state" IS NULL OR "whatsapp_phone_numbers"."release_state" IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'manual_review', 'completed', 'failed')),
	CONSTRAINT "wa_phone_numbers_release_phase_check" CHECK ("whatsapp_phone_numbers"."release_phase" IS NULL OR "whatsapp_phone_numbers"."release_phase" IN ('meta', 'stripe', 'telnyx', 'completed')),
	CONSTRAINT "wa_phone_numbers_release_provider_status_check" CHECK (("whatsapp_phone_numbers"."release_meta_status" IS NULL OR "whatsapp_phone_numbers"."release_meta_status" IN ('pending', 'not_required', 'confirmed', 'unknown'))
				AND ("whatsapp_phone_numbers"."release_stripe_status" IS NULL OR "whatsapp_phone_numbers"."release_stripe_status" IN ('pending', 'not_required', 'confirmed', 'unknown'))
				AND ("whatsapp_phone_numbers"."release_telnyx_status" IS NULL OR "whatsapp_phone_numbers"."release_telnyx_status" IN ('pending', 'not_required', 'confirmed', 'unknown'))),
	CONSTRAINT "wa_phone_numbers_numeric_check" CHECK ("whatsapp_phone_numbers"."provisioning_lease_token" >= 0
				AND "whatsapp_phone_numbers"."provisioning_attempts" >= 0
				AND ("whatsapp_phone_numbers"."release_source_token_version" IS NULL OR "whatsapp_phone_numbers"."release_source_token_version" >= 0)
				AND "whatsapp_phone_numbers"."release_lease_token" >= 0
				AND "whatsapp_phone_numbers"."release_attempts" >= 0
				AND "whatsapp_phone_numbers"."monthly_cost_cents" >= 0),
	CONSTRAINT "wa_phone_numbers_provisioning_lease_state_check" CHECK (("whatsapp_phone_numbers"."provisioning_state" IN ('processing', 'request_may_have_been_sent')
					AND "whatsapp_phone_numbers"."provisioning_lease_expires_at" IS NOT NULL)
				OR ("whatsapp_phone_numbers"."provisioning_state" NOT IN ('processing', 'request_may_have_been_sent')
					AND "whatsapp_phone_numbers"."provisioning_lease_expires_at" IS NULL)),
	CONSTRAINT "wa_phone_numbers_provisioning_boundary_check" CHECK ("whatsapp_phone_numbers"."provisioning_state" <> 'request_may_have_been_sent'
				OR "whatsapp_phone_numbers"."provisioning_request_may_have_been_sent_at" IS NOT NULL),
	CONSTRAINT "wa_phone_numbers_provisioning_completion_check" CHECK ("whatsapp_phone_numbers"."provisioning_state" <> 'completed'
				OR ("whatsapp_phone_numbers"."provisioning_phase" = 'completed'
					AND "whatsapp_phone_numbers"."wa_phone_number_id" IS NOT NULL
					AND "whatsapp_phone_numbers"."status" IN ('pending_verification', 'verified', 'active', 'releasing', 'released'))),
	CONSTRAINT "wa_phone_numbers_release_identity_check" CHECK (("whatsapp_phone_numbers"."release_state" IS NULL
					AND "whatsapp_phone_numbers"."release_operation_id" IS NULL
					AND "whatsapp_phone_numbers"."release_reason" IS NULL
					AND "whatsapp_phone_numbers"."release_phase" IS NULL
					AND "whatsapp_phone_numbers"."release_meta_status" IS NULL
					AND "whatsapp_phone_numbers"."release_stripe_status" IS NULL
					AND "whatsapp_phone_numbers"."release_telnyx_status" IS NULL
					AND "whatsapp_phone_numbers"."release_requested_at" IS NULL)
				OR ("whatsapp_phone_numbers"."release_state" IS NOT NULL
					AND "whatsapp_phone_numbers"."release_operation_id" IS NOT NULL
					AND "whatsapp_phone_numbers"."release_reason" IN ('user_requested', 'tenant_deleted')
					AND "whatsapp_phone_numbers"."release_phase" IS NOT NULL
					AND "whatsapp_phone_numbers"."release_meta_status" IS NOT NULL
					AND "whatsapp_phone_numbers"."release_stripe_status" IS NOT NULL
					AND "whatsapp_phone_numbers"."release_telnyx_status" IS NOT NULL
					AND "whatsapp_phone_numbers"."release_requested_at" IS NOT NULL
					AND "whatsapp_phone_numbers"."release_next_attempt_at" IS NOT NULL)),
	CONSTRAINT "wa_phone_numbers_release_source_check" CHECK (("whatsapp_phone_numbers"."release_source_account_id" IS NULL) = ("whatsapp_phone_numbers"."release_source_token_version" IS NULL)),
	CONSTRAINT "wa_phone_numbers_release_lease_state_check" CHECK (("whatsapp_phone_numbers"."release_state" IN ('processing', 'request_may_have_been_sent')
					AND "whatsapp_phone_numbers"."release_lease_expires_at" IS NOT NULL)
				OR (COALESCE("whatsapp_phone_numbers"."release_state", '') NOT IN ('processing', 'request_may_have_been_sent')
					AND "whatsapp_phone_numbers"."release_lease_expires_at" IS NULL)),
	CONSTRAINT "wa_phone_numbers_release_boundary_check" CHECK ("whatsapp_phone_numbers"."release_state" <> 'request_may_have_been_sent'
				OR "whatsapp_phone_numbers"."release_request_may_have_been_sent_at" IS NOT NULL),
	CONSTRAINT "wa_phone_numbers_release_completion_check" CHECK (("whatsapp_phone_numbers"."release_state" = 'completed'
					AND "whatsapp_phone_numbers"."status" = 'released'
					AND "whatsapp_phone_numbers"."release_phase" = 'completed'
					AND "whatsapp_phone_numbers"."release_meta_status" IN ('confirmed', 'not_required')
					AND "whatsapp_phone_numbers"."release_stripe_status" IN ('confirmed', 'not_required')
					AND "whatsapp_phone_numbers"."release_telnyx_status" IN ('confirmed', 'not_required')
					AND "whatsapp_phone_numbers"."released_at" IS NOT NULL)
				OR ("whatsapp_phone_numbers"."release_state" IS DISTINCT FROM 'completed'
					AND "whatsapp_phone_numbers"."status" <> 'released'
					AND "whatsapp_phone_numbers"."released_at" IS NULL)),
	CONSTRAINT "wa_phone_numbers_timestamp_order_check" CHECK ("whatsapp_phone_numbers"."updated_at" >= "whatsapp_phone_numbers"."created_at"
				AND ("whatsapp_phone_numbers"."provisioning_request_may_have_been_sent_at" IS NULL OR "whatsapp_phone_numbers"."provisioning_request_may_have_been_sent_at" >= "whatsapp_phone_numbers"."created_at")
				AND ("whatsapp_phone_numbers"."release_requested_at" IS NULL OR "whatsapp_phone_numbers"."release_requested_at" >= "whatsapp_phone_numbers"."created_at")
				AND ("whatsapp_phone_numbers"."release_request_may_have_been_sent_at" IS NULL OR "whatsapp_phone_numbers"."release_request_may_have_been_sent_at" >= "whatsapp_phone_numbers"."release_requested_at")
				AND ("whatsapp_phone_numbers"."released_at" IS NULL OR "whatsapp_phone_numbers"."released_at" >= "whatsapp_phone_numbers"."release_requested_at"))
);
--> statement-breakpoint
CREATE TABLE "workspace_erasure_jobs" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"erasure_operation_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text,
	"audit_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workspace_erasure_jobs_erasure_operation_id_unique" UNIQUE("erasure_operation_id"),
	CONSTRAINT "workspace_erasure_jobs_workspace_org_scope_uniq" UNIQUE("workspace_id","organization_id","scope_key"),
	CONSTRAINT "workspace_erasure_jobs_status_check" CHECK ("workspace_erasure_jobs"."status" IN ('pending', 'processing', 'manual_review', 'failed', 'purged')),
	CONSTRAINT "workspace_erasure_jobs_counters_nonnegative_check" CHECK ("workspace_erasure_jobs"."attempts" >= 0 AND "workspace_erasure_jobs"."lease_token" >= 0),
	CONSTRAINT "workspace_erasure_jobs_completion_check" CHECK ("workspace_erasure_jobs"."status" <> 'purged' OR "workspace_erasure_jobs"."completed_at" IS NOT NULL),
	CONSTRAINT "workspace_erasure_jobs_lease_state_check" CHECK (("workspace_erasure_jobs"."status" = 'processing' AND "workspace_erasure_jobs"."lease_expires_at" IS NOT NULL)
				OR ("workspace_erasure_jobs"."status" <> 'processing' AND "workspace_erasure_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "workspace_erasure_jobs_timestamp_order_check" CHECK ("workspace_erasure_jobs"."updated_at" >= "workspace_erasure_jobs"."requested_at"
				AND ("workspace_erasure_jobs"."completed_at" IS NULL OR "workspace_erasure_jobs"."completed_at" >= "workspace_erasure_jobs"."requested_at"))
);
--> statement-breakpoint
CREATE TABLE "workspace_erasure_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"step_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cursor" jsonb,
	"rows_deleted" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workspace_erasure_steps_status_check" CHECK ("workspace_erasure_steps"."status" IN ('pending', 'processing', 'completed', 'failed', 'manual_review')),
	CONSTRAINT "workspace_erasure_steps_counters_nonnegative_check" CHECK ("workspace_erasure_steps"."rows_deleted" >= 0 AND "workspace_erasure_steps"."attempts" >= 0 AND "workspace_erasure_steps"."lease_token" >= 0),
	CONSTRAINT "workspace_erasure_steps_lease_state_check" CHECK (("workspace_erasure_steps"."status" = 'processing' AND "workspace_erasure_steps"."lease_expires_at" IS NOT NULL)
				OR ("workspace_erasure_steps"."status" <> 'processing' AND "workspace_erasure_steps"."lease_expires_at" IS NULL)),
	CONSTRAINT "workspace_erasure_steps_completion_check" CHECK (("workspace_erasure_steps"."status" = 'completed' AND "workspace_erasure_steps"."completed_at" IS NOT NULL)
				OR ("workspace_erasure_steps"."status" <> 'completed' AND "workspace_erasure_steps"."completed_at" IS NULL)),
	CONSTRAINT "workspace_erasure_steps_timestamp_order_check" CHECK ("workspace_erasure_steps"."updated_at" >= "workspace_erasure_steps"."created_at"
				AND ("workspace_erasure_steps"."completed_at" IS NULL OR "workspace_erasure_steps"."completed_at" >= "workspace_erasure_steps"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "workspace_tombstones" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"erasure_operation_id" text NOT NULL,
	"erased_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_tombstones_erasure_operation_id_unique" UNIQUE("erasure_operation_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"lifecycle_status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"erasure_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "workspaces_lifecycle_status_check" CHECK ("workspaces"."lifecycle_status" IN ('active', 'archived', 'erasing')),
	CONSTRAINT "workspaces_revision_nonnegative_check" CHECK ("workspaces"."revision" >= 0),
	CONSTRAINT "workspaces_lifecycle_timestamps_check" CHECK (("workspaces"."lifecycle_status" <> 'archived' OR "workspaces"."archived_at" IS NOT NULL)
				AND ("workspaces"."lifecycle_status" <> 'erasing' OR "workspaces"."erasure_requested_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_revocation_jobs" ADD CONSTRAINT "account_revocation_jobs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_revocation_jobs" ADD CONSTRAINT "account_revocation_jobs_account_org_fk" FOREIGN KEY ("account_id","organization_id") REFERENCES "public"."social_accounts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_social_account_org_scope_fk" FOREIGN KEY ("social_account_id","organization_id","scope_key") REFERENCES "public"."social_accounts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_audience_users" ADD CONSTRAINT "ad_audience_users_audience_id_ad_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."ad_audiences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_audiences" ADD CONSTRAINT "ad_audiences_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_audiences" ADD CONSTRAINT "ad_audiences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_audiences" ADD CONSTRAINT "ad_audiences_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_audiences" ADD CONSTRAINT "ad_audiences_account_org_scope_platform_fk" FOREIGN KEY ("ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ad_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_account_org_scope_platform_fk" FOREIGN KEY ("ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ad_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creation_operations" ADD CONSTRAINT "ad_creation_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creation_operations" ADD CONSTRAINT "ad_creation_operations_local_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("local_campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creation_operations" ADD CONSTRAINT "ad_creation_operations_local_ad_id_ads_id_fk" FOREIGN KEY ("local_ad_id") REFERENCES "public"."ads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creation_operations" ADD CONSTRAINT "ad_creation_operations_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creation_operations" ADD CONSTRAINT "ad_creation_operations_account_org_scope_platform_fk" FOREIGN KEY ("ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ad_accounts"("id","organization_id","scope_key","platform") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creation_operations" ADD CONSTRAINT "ad_creation_operations_campaign_account_scope_platform_fk" FOREIGN KEY ("local_campaign_id","ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ad_campaigns"("id","ad_account_id","organization_id","scope_key","platform") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creation_operations" ADD CONSTRAINT "ad_creation_operations_ad_account_scope_platform_fk" FOREIGN KEY ("local_ad_id","ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ads"("id","ad_account_id","organization_id","scope_key","platform") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_metrics" ADD CONSTRAINT "ad_metrics_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_sync_logs" ADD CONSTRAINT "ad_sync_logs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_sync_logs" ADD CONSTRAINT "ad_sync_logs_account_org_scope_platform_fk" FOREIGN KEY ("ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ad_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_boost_post_target_id_post_targets_id_fk" FOREIGN KEY ("boost_post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_boost_external_post_id_external_posts_id_fk" FOREIGN KEY ("boost_external_post_id") REFERENCES "public"."external_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_account_org_scope_platform_fk" FOREIGN KEY ("ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ad_accounts"("id","organization_id","scope_key","platform") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_campaign_account_org_scope_platform_fk" FOREIGN KEY ("campaign_id","ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ad_campaigns"("id","ad_account_id","organization_id","scope_key","platform") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_kb_id_ai_knowledge_bases_id_fk" FOREIGN KEY ("kb_id") REFERENCES "public"."ai_knowledge_bases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_kb_org_scope_fk" FOREIGN KEY ("kb_id","organization_id","scope_key") REFERENCES "public"."ai_knowledge_bases"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_bases" ADD CONSTRAINT "ai_knowledge_bases_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_bases" ADD CONSTRAINT "ai_knowledge_bases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_bases" ADD CONSTRAINT "ai_knowledge_bases_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_document_org_scope_fk" FOREIGN KEY ("document_id","organization_id","scope_key") REFERENCES "public"."ai_knowledge_documents"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_kb_org_scope_fk" FOREIGN KEY ("kb_id","organization_id","scope_key") REFERENCES "public"."ai_knowledge_bases"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_documents" ADD CONSTRAINT "ai_knowledge_documents_kb_org_scope_fk" FOREIGN KEY ("kb_id","organization_id","scope_key") REFERENCES "public"."ai_knowledge_bases"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_post_feed_items" ADD CONSTRAINT "auto_post_feed_items_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_post_feed_items" ADD CONSTRAINT "auto_post_feed_items_rule_org_fk" FOREIGN KEY ("rule_id","organization_id") REFERENCES "public"."auto_post_rules"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_post_feed_items" ADD CONSTRAINT "auto_post_feed_items_post_org_fk" FOREIGN KEY ("post_id","organization_id") REFERENCES "public"."posts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_post_rules" ADD CONSTRAINT "auto_post_rules_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_post_rules" ADD CONSTRAINT "auto_post_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_post_rules" ADD CONSTRAINT "auto_post_rules_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD CONSTRAINT "automation_bindings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD CONSTRAINT "automation_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD CONSTRAINT "automation_bindings_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD CONSTRAINT "automation_bindings_account_org_scope_fk" FOREIGN KEY ("social_account_id","organization_id","scope_key") REFERENCES "public"."social_accounts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD CONSTRAINT "automation_bindings_automation_org_scope_fk" FOREIGN KEY ("automation_id","organization_id","scope_key") REFERENCES "public"."automations"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_contact_controls" ADD CONSTRAINT "automation_contact_controls_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_contact_controls" ADD CONSTRAINT "automation_contact_controls_paused_by_user_id_user_id_fk" FOREIGN KEY ("paused_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_contact_controls" ADD CONSTRAINT "automation_contact_controls_contact_org_fk" FOREIGN KEY ("contact_id","organization_id") REFERENCES "public"."contacts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_contact_controls" ADD CONSTRAINT "automation_contact_controls_automation_org_fk" FOREIGN KEY ("automation_id","organization_id") REFERENCES "public"."automations"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_effects" ADD CONSTRAINT "automation_effects_execution_org_scope_fk" FOREIGN KEY ("node_execution_id","organization_id","scope_key") REFERENCES "public"."automation_node_executions"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_entrypoints" ADD CONSTRAINT "automation_entrypoints_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_entrypoints" ADD CONSTRAINT "automation_entrypoints_automation_org_scope_fk" FOREIGN KEY ("automation_id","organization_id","scope_key") REFERENCES "public"."automations"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_entrypoints" ADD CONSTRAINT "automation_entrypoints_account_org_scope_fk" FOREIGN KEY ("social_account_id","organization_id","scope_key") REFERENCES "public"."social_accounts"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_node_executions" ADD CONSTRAINT "automation_node_executions_run_org_scope_fk" FOREIGN KEY ("run_id","organization_id","scope_key") REFERENCES "public"."automation_runs"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_entrypoint_id_automation_entrypoints_id_fk" FOREIGN KEY ("entrypoint_id") REFERENCES "public"."automation_entrypoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_binding_id_automation_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."automation_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_conversation_id_inbox_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."inbox_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_org_scope_fk" FOREIGN KEY ("automation_id","organization_id","scope_key") REFERENCES "public"."automations"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_entrypoint_auto_org_scope_fk" FOREIGN KEY ("entrypoint_id","automation_id","organization_id","scope_key") REFERENCES "public"."automation_entrypoints"("id","automation_id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_binding_org_scope_fk" FOREIGN KEY ("binding_id","organization_id","scope_key") REFERENCES "public"."automation_bindings"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_conversation_org_scope_fk" FOREIGN KEY ("conversation_id","organization_id","scope_key") REFERENCES "public"."inbox_conversations"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_scheduled_jobs" ADD CONSTRAINT "automation_scheduled_jobs_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_scheduled_jobs" ADD CONSTRAINT "automation_scheduled_jobs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_scheduled_jobs" ADD CONSTRAINT "automation_scheduled_jobs_entrypoint_id_automation_entrypoints_id_fk" FOREIGN KEY ("entrypoint_id") REFERENCES "public"."automation_entrypoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_secrets" ADD CONSTRAINT "automation_secrets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_secrets" ADD CONSTRAINT "automation_secrets_automation_org_fk" FOREIGN KEY ("automation_id","organization_id") REFERENCES "public"."automations"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_step_runs" ADD CONSTRAINT "automation_step_runs_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_webhook_receipts" ADD CONSTRAINT "automation_webhook_receipts_entrypoint_auto_org_fk" FOREIGN KEY ("entrypoint_id","automation_id","organization_id") REFERENCES "public"."automation_entrypoints"("id","automation_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_operations" ADD CONSTRAINT "billing_operations_usage_bucket_settlement_org_fk" FOREIGN KEY ("usage_bucket_settlement_id","organization_id") REFERENCES "public"."usage_bucket_settlements"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_outbox" ADD CONSTRAINT "billing_outbox_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_org_scope_fk" FOREIGN KEY ("broadcast_id","organization_id","scope_key") REFERENCES "public"."broadcasts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_account_org_scope_platform_fk" FOREIGN KEY ("social_account_id","organization_id","scope_key","platform") REFERENCES "public"."social_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "byos_configs" ADD CONSTRAINT "byos_configs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_logs" ADD CONSTRAINT "connection_logs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_logs" ADD CONSTRAINT "connection_logs_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_channels" ADD CONSTRAINT "contact_channels_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_channels" ADD CONSTRAINT "contact_channels_account_org_scope_platform_fk" FOREIGN KEY ("social_account_id","organization_id","scope_key","platform") REFERENCES "public"."social_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_events" ADD CONSTRAINT "contact_consent_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_events" ADD CONSTRAINT "contact_consent_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_events" ADD CONSTRAINT "contact_consent_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_events" ADD CONSTRAINT "contact_consent_events_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_events" ADD CONSTRAINT "contact_consent_events_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_states" ADD CONSTRAINT "contact_consent_states_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_states" ADD CONSTRAINT "contact_consent_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_states" ADD CONSTRAINT "contact_consent_states_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_states" ADD CONSTRAINT "contact_consent_states_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_states" ADD CONSTRAINT "contact_consent_states_projection_source_fk" FOREIGN KEY ("last_event_id","organization_id","scope_key","last_ingestion_sequence") REFERENCES "public"."contact_consent_events"("id","organization_id","scope_key","ingestion_sequence") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_states" ADD CONSTRAINT "contact_consent_states_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segment_memberships" ADD CONSTRAINT "contact_segment_memberships_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segment_memberships" ADD CONSTRAINT "contact_segment_memberships_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segment_memberships" ADD CONSTRAINT "contact_segment_memberships_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segment_memberships" ADD CONSTRAINT "contact_segment_memberships_segment_org_scope_fk" FOREIGN KEY ("segment_id","organization_id","scope_key") REFERENCES "public"."segments"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_subscriptions" ADD CONSTRAINT "contact_subscriptions_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_subscriptions" ADD CONSTRAINT "contact_subscriptions_list_org_scope_fk" FOREIGN KEY ("list_id","organization_id","scope_key") REFERENCES "public"."subscription_lists"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_suppressions" ADD CONSTRAINT "contact_suppressions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_suppressions" ADD CONSTRAINT "contact_suppressions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_suppressions" ADD CONSTRAINT "contact_suppressions_event_org_scope_fk" FOREIGN KEY ("source_event_id","organization_id","scope_key") REFERENCES "public"."contact_consent_events"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_suppressions" ADD CONSTRAINT "contact_suppressions_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_templates" ADD CONSTRAINT "content_templates_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_templates" ADD CONSTRAINT "content_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_post_actions" ADD CONSTRAINT "cross_post_actions_source_post_org_scope_platform_fk" FOREIGN KEY ("source_target_id","post_id","organization_id","scope_key","source_platform") REFERENCES "public"."post_targets"("id","post_id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_post_actions" ADD CONSTRAINT "cross_post_actions_target_account_org_scope_platform_fk" FOREIGN KEY ("target_account_id","organization_id","scope_key","target_platform") REFERENCES "public"."social_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_definition_org_scope_fk" FOREIGN KEY ("definition_id","organization_id","definition_scope_key") REFERENCES "public"."custom_field_definitions"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_events" ADD CONSTRAINT "dunning_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_events" ADD CONSTRAINT "dunning_events_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_events" ADD CONSTRAINT "dunning_events_invoice_org_fk" FOREIGN KEY ("invoice_id","organization_id") REFERENCES "public"."invoices"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_posts" ADD CONSTRAINT "external_posts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_posts" ADD CONSTRAINT "external_posts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_posts" ADD CONSTRAINT "external_posts_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_posts" ADD CONSTRAINT "external_posts_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_posts" ADD CONSTRAINT "external_posts_account_org_scope_platform_fk" FOREIGN KEY ("social_account_id","organization_id","scope_key","platform") REFERENCES "public"."social_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_activity" ADD CONSTRAINT "idea_activity_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_comments" ADD CONSTRAINT "idea_comments_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_comments" ADD CONSTRAINT "idea_comments_parent_id_idea_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."idea_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_conversion_operations" ADD CONSTRAINT "idea_conversion_operations_idea_org_scope_fk" FOREIGN KEY ("idea_id","organization_id","scope_key") REFERENCES "public"."ideas"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_conversion_operations" ADD CONSTRAINT "idea_conversion_operations_post_org_scope_fk" FOREIGN KEY ("post_id","organization_id","scope_key") REFERENCES "public"."posts"("id","organization_id","scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_groups" ADD CONSTRAINT "idea_groups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_groups" ADD CONSTRAINT "idea_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_groups" ADD CONSTRAINT "idea_groups_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_media" ADD CONSTRAINT "idea_media_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_media" ADD CONSTRAINT "idea_media_idea_org_scope_fk" FOREIGN KEY ("idea_id","organization_id","scope_key") REFERENCES "public"."ideas"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_media" ADD CONSTRAINT "idea_media_media_org_scope_fk" FOREIGN KEY ("media_id","organization_id","scope_key") REFERENCES "public"."media"("id","organization_id","scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_tags" ADD CONSTRAINT "idea_tags_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_tags" ADD CONSTRAINT "idea_tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_tags" ADD CONSTRAINT "idea_tags_idea_org_scope_fk" FOREIGN KEY ("idea_id","organization_id","scope_key") REFERENCES "public"."ideas"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_tags" ADD CONSTRAINT "idea_tags_tag_org_scope_fk" FOREIGN KEY ("tag_id","organization_id","tag_scope_key") REFERENCES "public"."tags"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_tags" ADD CONSTRAINT "idea_tags_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_assigned_to_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_group_org_scope_fk" FOREIGN KEY ("group_id","organization_id","group_scope_key") REFERENCES "public"."idea_groups"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_converted_post_org_scope_fk" FOREIGN KEY ("converted_to_post_id","organization_id","scope_key") REFERENCES "public"."posts"("id","organization_id","scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_receipts" ADD CONSTRAINT "idempotency_receipts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversation_notes" ADD CONSTRAINT "inbox_conversation_notes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversation_notes" ADD CONSTRAINT "inbox_conversation_notes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversation_notes" ADD CONSTRAINT "inbox_conversation_notes_conversation_org_fk" FOREIGN KEY ("conversation_id","organization_id") REFERENCES "public"."inbox_conversations"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_assigned_user_id_user_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_account_org_scope_platform_fk" FOREIGN KEY ("account_id","organization_id","scope_key","platform") REFERENCES "public"."social_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_event_effects" ADD CONSTRAINT "inbox_event_effects_account_org_fk" FOREIGN KEY ("account_id","organization_id") REFERENCES "public"."social_accounts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_conversation_org_scope_fk" FOREIGN KEY ("conversation_id","organization_id","scope_key") REFERENCES "public"."inbox_conversations"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_account_org_scope_platform_fk" FOREIGN KEY ("account_id","organization_id","scope_key","platform") REFERENCES "public"."social_accounts"("id","organization_id","scope_key","platform") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."invitation" ADD CONSTRAINT "invitation_inviterId_user_id_fk" FOREIGN KEY ("inviterId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."invitation" ADD CONSTRAINT "invitation_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_used_by_user_id_fk" FOREIGN KEY ("used_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_automation_org_scope_fk" FOREIGN KEY ("automation_id","organization_id","scope_key") REFERENCES "public"."automations"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."member" ADD CONSTRAINT "member_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."member" ADD CONSTRAINT "member_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_member_fk" FOREIGN KEY ("user_id","organization_id") REFERENCES "auth"."member"("userId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_member_fk" FOREIGN KEY ("user_id","organization_id") REFERENCES "auth"."member"("userId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_capabilities" ADD CONSTRAINT "one_time_capabilities_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_streaks" ADD CONSTRAINT "org_streaks_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."organization_creation_reservation" ADD CONSTRAINT "organization_creation_reservation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_updated_by_api_key_id_apikey_id_fk" FOREIGN KEY ("updated_by_api_key_id") REFERENCES "auth"."apikey"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_analytics" ADD CONSTRAINT "post_analytics_post_target_id_post_targets_id_fk" FOREIGN KEY ("post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_recycling_configs" ADD CONSTRAINT "post_recycling_configs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_recycling_configs" ADD CONSTRAINT "post_recycling_configs_post_org_fk" FOREIGN KEY ("source_post_id","organization_id") REFERENCES "public"."posts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_tags" ADD CONSTRAINT "post_tags_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_tags" ADD CONSTRAINT "post_tags_post_org_scope_fk" FOREIGN KEY ("post_id","organization_id","scope_key") REFERENCES "public"."posts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_tags" ADD CONSTRAINT "post_tags_tag_org_scope_fk" FOREIGN KEY ("tag_id","organization_id","tag_scope_key") REFERENCES "public"."tags"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_post_org_scope_fk" FOREIGN KEY ("post_id","organization_id","scope_key") REFERENCES "public"."posts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_account_org_scope_platform_fk" FOREIGN KEY ("social_account_id","organization_id","scope_key","platform") REFERENCES "public"."social_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_threads" ADD CONSTRAINT "post_threads_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_threads" ADD CONSTRAINT "post_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_threads" ADD CONSTRAINT "post_threads_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_recycled_from_id_posts_id_fk" FOREIGN KEY ("recycled_from_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_thread_org_scope_fk" FOREIGN KEY ("thread_group_id","organization_id","scope_key") REFERENCES "public"."post_threads"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_target_operation_fk" FOREIGN KEY ("post_target_id","publish_operation_id") REFERENCES "public"."post_targets"("id","publish_operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_outbox" ADD CONSTRAINT "publish_outbox_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_outbox" ADD CONSTRAINT "publish_outbox_post_org_fk" FOREIGN KEY ("post_id","organization_id") REFERENCES "public"."posts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_ref_url_org_scope_fk" FOREIGN KEY ("ref_url_id","organization_id","scope_key") REFERENCES "public"."ref_urls"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recycling_occurrences" ADD CONSTRAINT "recycling_occurrences_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recycling_occurrences" ADD CONSTRAINT "recycling_occurrences_config_org_fk" FOREIGN KEY ("config_id","organization_id") REFERENCES "public"."post_recycling_configs"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recycling_occurrences" ADD CONSTRAINT "recycling_occurrences_post_org_fk" FOREIGN KEY ("post_id","organization_id") REFERENCES "public"."posts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_urls" ADD CONSTRAINT "ref_urls_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_urls" ADD CONSTRAINT "ref_urls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_urls" ADD CONSTRAINT "ref_urls_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_urls" ADD CONSTRAINT "ref_urls_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_urls" ADD CONSTRAINT "ref_urls_automation_org_scope_fk" FOREIGN KEY ("automation_id","organization_id","scope_key") REFERENCES "public"."automations"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_link_configs" ADD CONSTRAINT "short_link_configs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_post_org_scope_fk" FOREIGN KEY ("post_id","organization_id","scope_key") REFERENCES "public"."posts"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_sync_state" ADD CONSTRAINT "social_account_sync_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_sync_state" ADD CONSTRAINT "social_account_sync_state_account_org_scope_platform_fk" FOREIGN KEY ("social_account_id","organization_id","scope_key","platform") REFERENCES "public"."social_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_checkout_operations" ADD CONSTRAINT "subscription_checkout_operations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_lists" ADD CONSTRAINT "subscription_lists_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_lists" ADD CONSTRAINT "subscription_lists_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_lists" ADD CONSTRAINT "subscription_lists_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connection_challenges" ADD CONSTRAINT "telegram_connection_challenges_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connection_challenges" ADD CONSTRAINT "telegram_connection_challenges_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connection_challenges" ADD CONSTRAINT "telegram_connection_challenges_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connection_challenges" ADD CONSTRAINT "telegram_connection_challenges_api_key_org_fk" FOREIGN KEY ("api_key_id","organization_id") REFERENCES "auth"."apikey"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connection_challenges" ADD CONSTRAINT "telegram_connection_challenges_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connection_challenges" ADD CONSTRAINT "telegram_connection_challenges_account_org_scope_fk" FOREIGN KEY ("account_id","organization_id","scope_key") REFERENCES "public"."social_accounts"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_deletion_steps" ADD CONSTRAINT "tenant_deletion_steps_job_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."tenant_deletion_jobs"("organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_executions" ADD CONSTRAINT "thread_executions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_executions" ADD CONSTRAINT "thread_executions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_executions" ADD CONSTRAINT "thread_executions_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_executions" ADD CONSTRAINT "thread_executions_thread_org_scope_fk" FOREIGN KEY ("thread_group_id","organization_id","scope_key") REFERENCES "public"."post_threads"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_refresh_operations" ADD CONSTRAINT "token_refresh_operations_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_bucket_settlements" ADD CONSTRAINT "usage_bucket_settlements_bucket_org_fk" FOREIGN KEY ("bucket_id","organization_id") REFERENCES "public"."usage_buckets"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_bucket_settlements" ADD CONSTRAINT "usage_bucket_settlements_invoice_org_fk" FOREIGN KEY ("invoice_id","organization_id") REFERENCES "public"."invoices"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_buckets" ADD CONSTRAINT "usage_buckets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_bucket_org_fk" FOREIGN KEY ("bucket_id","organization_id") REFERENCES "public"."usage_buckets"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_org_fk" FOREIGN KEY ("webhook_event_id","organization_id") REFERENCES "public"."webhook_events"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_org_fk" FOREIGN KEY ("webhook_id","organization_id") REFERENCES "public"."webhook_endpoints"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_endpoint_org_fk" FOREIGN KEY ("webhook_id","organization_id") REFERENCES "public"."webhook_endpoints"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_event_org_fk" FOREIGN KEY ("webhook_event_id","organization_id") REFERENCES "public"."webhook_events"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_phone_numbers" ADD CONSTRAINT "whatsapp_phone_numbers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_phone_numbers" ADD CONSTRAINT "whatsapp_phone_numbers_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_erasure_steps" ADD CONSTRAINT "workspace_erasure_steps_job_org_scope_fk" FOREIGN KEY ("workspace_id","organization_id","scope_key") REFERENCES "public"."workspace_erasure_jobs"("workspace_id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_revocation_jobs_due_idx" ON "account_revocation_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "account_revocation_jobs_org_idx" ON "account_revocation_jobs" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_accounts_org_platform_id_idx" ON "ad_accounts" USING btree ("organization_id","platform","platform_ad_account_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_org_idx" ON "ad_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_workspace_idx" ON "ad_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_social_account_idx" ON "ad_accounts" USING btree ("social_account_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_status_idx" ON "ad_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ad_audience_users_audience_idx" ON "ad_audience_users" USING btree ("audience_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_audience_users_email_uniq" ON "ad_audience_users" USING btree ("audience_id","email_hash") WHERE "ad_audience_users"."email_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_audience_users_phone_uniq" ON "ad_audience_users" USING btree ("audience_id","phone_hash") WHERE "ad_audience_users"."phone_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ad_audiences_org_idx" ON "ad_audiences" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_audiences_workspace_idx" ON "ad_audiences" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ad_audiences_ad_account_idx" ON "ad_audiences" USING btree ("ad_account_id");--> statement-breakpoint
CREATE INDEX "ad_audiences_platform_id_idx" ON "ad_audiences" USING btree ("platform_audience_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_audiences_account_platform_audience_idx" ON "ad_audiences" USING btree ("ad_account_id","platform_audience_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_org_idx" ON "ad_campaigns" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_workspace_idx" ON "ad_campaigns" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_ad_account_idx" ON "ad_campaigns" USING btree ("ad_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_campaigns_account_platform_id_idx" ON "ad_campaigns" USING btree ("ad_account_id","platform_campaign_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_org_status_idx" ON "ad_campaigns" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_creation_operations_org_key_uniq" ON "ad_creation_operations" USING btree ("organization_id","kind","operation_key_hash");--> statement-breakpoint
CREATE INDEX "ad_creation_operations_due_idx" ON "ad_creation_operations" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "ad_creation_operations_org_created_idx" ON "ad_creation_operations" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_metrics_ad_date_idx" ON "ad_metrics" USING btree ("ad_id","date");--> statement-breakpoint
CREATE INDEX "ad_metrics_ad_idx" ON "ad_metrics" USING btree ("ad_id");--> statement-breakpoint
CREATE INDEX "ad_sync_logs_org_idx" ON "ad_sync_logs" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "ad_sync_logs_ad_account_idx" ON "ad_sync_logs" USING btree ("ad_account_id");--> statement-breakpoint
CREATE INDEX "ads_org_idx" ON "ads" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ads_workspace_idx" ON "ads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ads_campaign_idx" ON "ads" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "ads_org_campaign_idx" ON "ads" USING btree ("organization_id","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ads_account_platform_ad_id_idx" ON "ads" USING btree ("ad_account_id","platform_ad_id");--> statement-breakpoint
CREATE INDEX "ads_org_status_idx" ON "ads" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "ads_boost_post_idx" ON "ads" USING btree ("boost_post_target_id");--> statement-breakpoint
CREATE INDEX "ads_boost_external_post_idx" ON "ads" USING btree ("boost_external_post_id");--> statement-breakpoint
CREATE INDEX "ai_agents_org_idx" ON "ai_agents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_bases_org_idx" ON "ai_knowledge_bases" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_knowledge_chunks_document_index_uniq" ON "ai_knowledge_chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_doc_idx" ON "ai_knowledge_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_kb_idx" ON "ai_knowledge_chunks" USING btree ("kb_id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_documents_kb_idx" ON "ai_knowledge_documents" USING btree ("kb_id");--> statement-breakpoint
CREATE INDEX "api_request_logs_org_created_idx" ON "api_request_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "api_request_logs_api_key_idx" ON "api_request_logs" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "auth"."apikey" USING btree ("referenceId");--> statement-breakpoint
CREATE INDEX "apikey_organizationId_idx" ON "auth"."apikey" USING btree ("organizationId","createdAt","id");--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "auth"."apikey" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "auto_post_feed_items_rule_canonical_idx" ON "auto_post_feed_items" USING btree ("rule_id","canonical_feed_item_id");--> statement-breakpoint
CREATE INDEX "auto_post_feed_items_post_idx" ON "auto_post_feed_items" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "auto_post_rules_org_status_idx" ON "auto_post_rules" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "auto_post_rules_workspace_idx" ON "auto_post_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_bindings_social_account_binding_type_uniq" ON "automation_bindings" USING btree ("social_account_id","binding_type");--> statement-breakpoint
CREATE INDEX "idx_automation_bindings_lookup" ON "automation_bindings" USING btree ("social_account_id","binding_type","status");--> statement-breakpoint
CREATE INDEX "idx_automation_bindings_automation" ON "automation_bindings" USING btree ("automation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_contact_controls_per_auto" ON "automation_contact_controls" USING btree ("contact_id","automation_id") WHERE "automation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_contact_controls_global" ON "automation_contact_controls" USING btree ("contact_id") WHERE "automation_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_contact_controls_contact" ON "automation_contact_controls" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_contact_controls_expiry" ON "automation_contact_controls" USING btree ("paused_until") WHERE "automation_contact_controls"."paused_until" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_effects_execution_key_uniq" ON "automation_effects" USING btree ("node_execution_id","effect_key");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_effects_provider_idempotency_uniq" ON "automation_effects" USING btree ("provider_idempotency_key");--> statement-breakpoint
CREATE INDEX "automation_effects_claim_idx" ON "automation_effects" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_automation_entrypoints_automation" ON "automation_entrypoints" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "idx_automation_entrypoints_match" ON "automation_entrypoints" USING btree ("channel","kind","status");--> statement-breakpoint
CREATE INDEX "idx_automation_entrypoints_account_match" ON "automation_entrypoints" USING btree ("social_account_id","kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automation_entrypoints_webhook_slug" ON "automation_entrypoints" USING btree (("config"->>'webhook_slug')) WHERE "automation_entrypoints"."kind" = 'webhook_inbound';--> statement-breakpoint
CREATE UNIQUE INDEX "automation_node_executions_visit_uniq" ON "automation_node_executions" USING btree ("run_id","run_revision","visit_ordinal");--> statement-breakpoint
CREATE INDEX "automation_node_executions_claim_idx" ON "automation_node_executions" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_auto_status" ON "automation_runs" USING btree ("automation_id","status");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_contact_auto" ON "automation_runs" USING btree ("contact_id","automation_id");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_sweeper" ON "automation_runs" USING btree ("status","waiting_until");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_org_started" ON "automation_runs" USING btree ("organization_id","started_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_automation_runs_entrypoint" ON "automation_runs" USING btree ("entrypoint_id");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_binding" ON "automation_runs" USING btree ("binding_id");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_conversation" ON "automation_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automation_runs_active_uniq" ON "automation_runs" USING btree ("contact_id","automation_id") WHERE "status" IN ('active', 'waiting');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automation_runs_trigger_occurrence_uniq" ON "automation_runs" USING btree ("automation_id","trigger_occurrence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_scheduled_jobs_occurrence_uniq" ON "automation_scheduled_jobs" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_jobs_sweep" ON "automation_scheduled_jobs" USING btree ("status","run_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_scheduled_jobs_run" ON "automation_scheduled_jobs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_jobs_automation" ON "automation_scheduled_jobs" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_jobs_entrypoint" ON "automation_scheduled_jobs" USING btree ("entrypoint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_secrets_action_uniq" ON "automation_secrets" USING btree ("automation_id","node_key","action_id");--> statement-breakpoint
CREATE INDEX "automation_secrets_org_automation_idx" ON "automation_secrets" USING btree ("organization_id","automation_id");--> statement-breakpoint
CREATE INDEX "idx_step_runs_run_time" ON "automation_step_runs" USING btree ("run_id","executed_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_step_runs_auto_time" ON "automation_step_runs" USING btree ("automation_id","executed_at");--> statement-breakpoint
CREATE INDEX "idx_step_runs_node_time" ON "automation_step_runs" USING btree ("node_key","executed_at");--> statement-breakpoint
CREATE INDEX "idx_step_runs_executed_brin" ON "automation_step_runs" USING brin ("executed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_webhook_receipts_entrypoint_digest_uniq" ON "automation_webhook_receipts" USING btree ("entrypoint_id","request_digest");--> statement-breakpoint
CREATE INDEX "automation_webhook_receipts_expiry_idx" ON "automation_webhook_receipts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "automation_webhook_receipts_status_due_idx" ON "automation_webhook_receipts" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "automation_webhook_receipts_org_received_idx" ON "automation_webhook_receipts" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_automations_org_status" ON "automations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_automations_org_workspace" ON "automations" USING btree ("organization_id","workspace_id");--> statement-breakpoint
CREATE INDEX "idx_automations_template" ON "automations" USING btree ("created_from_template") WHERE "automations"."created_from_template" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "billing_operations_status_due_idx" ON "billing_operations" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "billing_operations_org_created_idx" ON "billing_operations" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "billing_outbox_status_due_idx" ON "billing_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "billing_outbox_org_created_idx" ON "billing_outbox" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_contact_idx" ON "broadcast_recipients" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_identifier_hash_idx" ON "broadcast_recipients" USING btree ("contact_identifier_hash");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_claim_idx" ON "broadcast_recipients" USING btree ("broadcast_id","status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_recipients_identity_uniq" ON "broadcast_recipients" USING btree ("broadcast_id","organization_id","scope_key","contact_identifier_hash");--> statement-breakpoint
CREATE INDEX "broadcasts_org_idx" ON "broadcasts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "broadcasts_workspace_idx" ON "broadcasts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "broadcasts_status_idx" ON "broadcasts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "broadcasts_org_status_idx" ON "broadcasts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "broadcasts_status_scheduled_idx" ON "broadcasts" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "broadcasts_status_lease_idx" ON "broadcasts" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "connection_logs_org_created_idx" ON "connection_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "contact_channels_contact_idx" ON "contact_channels" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_channels_platform_account_contact_idx" ON "contact_channels" USING btree ("platform","social_account_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_channels_account_identifier_idx" ON "contact_channels" USING btree ("social_account_id","identifier");--> statement-breakpoint
CREATE INDEX "contact_consent_events_contact_idx" ON "contact_consent_events" USING btree ("contact_id","occurred_at");--> statement-breakpoint
CREATE INDEX "contact_consent_events_identifier_idx" ON "contact_consent_events" USING btree ("organization_id","scope_key","channel","purpose","identifier_hash","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_consent_states_identifier_idx" ON "contact_consent_states" USING btree ("organization_id","channel","purpose","identifier_hash");--> statement-breakpoint
CREATE INDEX "contact_consent_states_contact_idx" ON "contact_consent_states" USING btree ("contact_id","channel","purpose");--> statement-breakpoint
CREATE INDEX "contact_segment_memberships_org_idx" ON "contact_segment_memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contact_segment_memberships_segment_idx" ON "contact_segment_memberships" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "contact_segment_memberships_contact_idx" ON "contact_segment_memberships" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_subscriptions_list_idx" ON "contact_subscriptions" USING btree ("list_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_suppressions_identifier_idx" ON "contact_suppressions" USING btree ("organization_id","channel","purpose","identifier_hash");--> statement-breakpoint
CREATE INDEX "contacts_org_idx" ON "contacts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contacts_workspace_idx" ON "contacts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "contacts_org_created_idx" ON "contacts" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "contacts_org_workspace_created_idx" ON "contacts" USING btree ("organization_id","workspace_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_scope_email_canonical_uniq" ON "contacts" USING btree ("organization_id","scope_key","email_canonical") WHERE "contacts"."email_canonical" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "content_templates_org_scope_name_uniq" ON "content_templates" USING btree ("organization_id","scope_key","name");--> statement-breakpoint
CREATE INDEX "content_templates_org_idx" ON "content_templates" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "content_templates_org_created_idx" ON "content_templates" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "content_templates_workspace_idx" ON "content_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cross_post_actions_operation_idx" ON "cross_post_actions" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "cross_post_actions_post_idx" ON "cross_post_actions" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "cross_post_actions_source_target_idx" ON "cross_post_actions" USING btree ("source_target_id");--> statement-breakpoint
CREATE INDEX "cross_post_actions_target_account_idx" ON "cross_post_actions" USING btree ("target_account_id");--> statement-breakpoint
CREATE INDEX "cross_post_actions_status_idx" ON "cross_post_actions" USING btree ("status","execute_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_defs_org_scope_slug_uniq" ON "custom_field_definitions" USING btree ("organization_id","scope_key","slug");--> statement-breakpoint
CREATE INDEX "custom_field_defs_org_idx" ON "custom_field_definitions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "custom_field_defs_workspace_idx" ON "custom_field_definitions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_values_def_contact_idx" ON "custom_field_values" USING btree ("definition_id","contact_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_contact_idx" ON "custom_field_values" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dunning_events_invoice_event_uniq" ON "dunning_events" USING btree ("invoice_id","event") WHERE "dunning_events"."invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "dunning_events_stripe_invoice_event_uniq" ON "dunning_events" USING btree ("stripe_invoice_id","event") WHERE "dunning_events"."stripe_invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "dunning_events_org_idx" ON "dunning_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "dunning_events_invoice_id_idx" ON "dunning_events" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "dunning_events_status_due_idx" ON "dunning_events" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "external_posts_account_platform_post_idx" ON "external_posts" USING btree ("social_account_id","platform_post_id");--> statement-breakpoint
CREATE INDEX "external_posts_org_published_idx" ON "external_posts" USING btree ("organization_id","published_at");--> statement-breakpoint
CREATE INDEX "external_posts_org_platform_post_idx" ON "external_posts" USING btree ("organization_id","platform_post_id");--> statement-breakpoint
CREATE INDEX "external_posts_workspace_idx" ON "external_posts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "external_posts_metrics_updated_idx" ON "external_posts" USING btree ("metrics_updated_at");--> statement-breakpoint
CREATE INDEX "external_posts_org_platform_idx" ON "external_posts" USING btree ("organization_id","platform");--> statement-breakpoint
CREATE INDEX "external_posts_account_published_idx" ON "external_posts" USING btree ("social_account_id","published_at");--> statement-breakpoint
CREATE INDEX "idea_activity_idea_idx" ON "idea_activity" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "idea_activity_idea_created_idx" ON "idea_activity" USING btree ("idea_id","created_at");--> statement-breakpoint
CREATE INDEX "idea_activity_actor_idx" ON "idea_activity" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idea_comments_idea_idx" ON "idea_comments" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "idea_comments_parent_idx" ON "idea_comments" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_conversion_operations_idea_uniq" ON "idea_conversion_operations" USING btree ("idea_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_conversion_operations_org_idempotency_uniq" ON "idea_conversion_operations" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_conversion_operations_post_uniq" ON "idea_conversion_operations" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "idea_conversion_operations_claim_idx" ON "idea_conversion_operations" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_groups_default_per_scope_uniq" ON "idea_groups" USING btree ("organization_id","scope_key") WHERE "idea_groups"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "idea_groups_scope_position_uniq" ON "idea_groups" USING btree ("organization_id","scope_key","position");--> statement-breakpoint
CREATE INDEX "idea_groups_org_idx" ON "idea_groups" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idea_groups_workspace_idx" ON "idea_groups" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idea_groups_workspace_position_idx" ON "idea_groups" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_media_idea_position_uniq" ON "idea_media" USING btree ("idea_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_media_media_uniq" ON "idea_media" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "idea_media_idea_idx" ON "idea_media" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "idea_media_workspace_idx" ON "idea_media" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idea_tags_org_tag_workspace_idx" ON "idea_tags" USING btree ("organization_id","tag_id","workspace_id","idea_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ideas_group_position_uniq" ON "ideas" USING btree ("group_id","organization_id","scope_key","position");--> statement-breakpoint
CREATE INDEX "ideas_org_idx" ON "ideas" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ideas_workspace_idx" ON "ideas" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ideas_group_position_idx" ON "ideas" USING btree ("group_id","position");--> statement-breakpoint
CREATE INDEX "ideas_assigned_to_idx" ON "ideas" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "ideas_org_created_idx" ON "ideas" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_receipts_scope_key_idx" ON "idempotency_receipts" USING btree ("organization_id","method","route_hash","idempotency_key");--> statement-breakpoint
CREATE INDEX "idempotency_receipts_expiry_idx" ON "idempotency_receipts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idempotency_receipts_state_created_idx" ON "idempotency_receipts" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_webhook_events_delivery_idx" ON "inbound_webhook_events" USING btree ("provider","delivery_key");--> statement-breakpoint
CREATE INDEX "inbound_webhook_events_status_idx" ON "inbound_webhook_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "inbound_webhook_events_reconcile_idx" ON "inbound_webhook_events" USING btree ("status","claimed_at","attempts","received_at");--> statement-breakpoint
CREATE INDEX "inbound_webhook_events_expiry_idx" ON "inbound_webhook_events" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "inbox_note_conv_created_idx" ON "inbox_conversation_notes" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "inbox_note_org_idx" ON "inbox_conversation_notes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "inbox_note_user_idx" ON "inbox_conversation_notes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "inbox_note_actor_idx" ON "inbox_conversation_notes" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "inbox_conv_workspace_idx" ON "inbox_conversations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "inbox_conv_org_status_idx" ON "inbox_conversations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "inbox_conv_org_updated_idx" ON "inbox_conversations" USING btree ("organization_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "inbox_conv_account_idx" ON "inbox_conversations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "inbox_conv_org_platform_idx" ON "inbox_conversations" USING btree ("organization_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_conv_account_platform_id_idx" ON "inbox_conversations" USING btree ("account_id","platform_conversation_id");--> statement-breakpoint
CREATE INDEX "inbox_conv_org_workspace_idx" ON "inbox_conversations" USING btree ("organization_id","workspace_id");--> statement-breakpoint
CREATE INDEX "inbox_conv_contact_idx" ON "inbox_conversations" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "inbox_conv_assigned_user_idx" ON "inbox_conversations" USING btree ("assigned_user_id");--> statement-breakpoint
CREATE INDEX "inbox_conv_open_last_message_idx" ON "inbox_conversations" USING btree ("last_message_at") WHERE "inbox_conversations"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_event_effects_dedup_idx" ON "inbox_event_effects" USING btree ("organization_id","account_id","platform_event_id","effect");--> statement-breakpoint
CREATE INDEX "inbox_event_effects_status_idx" ON "inbox_event_effects" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "inbox_event_effects_lease_idx" ON "inbox_event_effects" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "inbox_msg_conv_created_idx" ON "inbox_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "inbox_msg_org_created_idx" ON "inbox_messages" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_msg_account_platform_dedup_idx" ON "inbox_messages" USING btree ("platform","account_id","platform_message_id");--> statement-breakpoint
CREATE INDEX "inbox_msg_platform_message_id_idx" ON "inbox_messages" USING btree ("platform_message_id");--> statement-breakpoint
CREATE INDEX "inbox_msg_text_trgm_idx" ON "inbox_messages" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "invite_tokens_org_idx" ON "invite_tokens" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_tokens_hash_idx" ON "invite_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invoices_org_period_idx" ON "invoices" USING btree ("organization_id","period_start");--> statement-breakpoint
CREATE INDEX "invoices_org_first_failure_idx" ON "invoices" USING btree ("organization_id","first_payment_failed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "landing_pages_org_scope_slug_uniq" ON "landing_pages" USING btree ("organization_id","scope_key","slug");--> statement-breakpoint
CREATE INDEX "landing_pages_automation_idx" ON "landing_pages" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "media_org_idx" ON "media" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "media_workspace_idx" ON "media" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_storage_key_uniq" ON "media" USING btree ("storage_provider","storage_key");--> statement-breakpoint
CREATE INDEX "media_thumbnail_retry_idx" ON "media" USING btree ("thumbnail_status","thumbnail_next_retry_at");--> statement-breakpoint
CREATE INDEX "media_upload_reconcile_idx" ON "media" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "media_deletion_retry_idx" ON "media" USING btree ("status","deletion_next_retry_at");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "auth"."member" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "auth"."member" USING btree ("organizationId");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_org_idx" ON "notification_preferences" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_read_idx" ON "notifications" USING btree ("user_id","read");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_occurrence_uniq" ON "notifications" USING btree ("user_id","organization_id","occurrence_id") WHERE "notifications"."occurrence_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "one_time_capabilities_expiry_idx" ON "one_time_capabilities" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "one_time_capabilities_org_kind_idx" ON "one_time_capabilities" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE INDEX "org_streaks_org_idx" ON "org_streaks" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "org_streaks_last_post_idx" ON "org_streaks" USING btree ("last_post_at");--> statement-breakpoint
CREATE INDEX "organization_creation_reservation_user_expiry_idx" ON "auth"."organization_creation_reservation" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "org_subs_stripe_sub_id_idx" ON "organization_subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_subs_stripe_customer_id_idx" ON "organization_subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "post_analytics_target_collected_idx" ON "post_analytics" USING btree ("post_target_id","collected_at");--> statement-breakpoint
CREATE INDEX "post_recycling_configs_org_idx" ON "post_recycling_configs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "post_recycling_configs_enabled_next_idx" ON "post_recycling_configs" USING btree ("enabled","processing_state","next_recycle_at");--> statement-breakpoint
CREATE UNIQUE INDEX "post_recycling_configs_source_post_idx" ON "post_recycling_configs" USING btree ("source_post_id");--> statement-breakpoint
CREATE INDEX "post_tags_tag_idx" ON "post_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "post_targets_publish_operation_idx" ON "post_targets" USING btree ("publish_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "post_targets_post_account_idx" ON "post_targets" USING btree ("post_id","social_account_id");--> statement-breakpoint
CREATE INDEX "post_targets_post_status_idx" ON "post_targets" USING btree ("post_id","status");--> statement-breakpoint
CREATE INDEX "post_targets_social_account_id_idx" ON "post_targets" USING btree ("social_account_id");--> statement-breakpoint
CREATE INDEX "post_targets_updated_at_idx" ON "post_targets" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "post_threads_org_scope_idx" ON "post_threads" USING btree ("organization_id","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_thread_position_uniq" ON "posts" USING btree ("organization_id","scope_key","thread_group_id","thread_position") WHERE "posts"."thread_group_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "posts_org_created_idx" ON "posts" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_org_published_idx" ON "posts" USING btree ("organization_id","published_at");--> statement-breakpoint
CREATE INDEX "posts_workspace_idx" ON "posts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "posts_org_workspace_created_idx" ON "posts" USING btree ("organization_id","workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_status_scheduled_idx" ON "posts" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "posts_publish_lease_idx" ON "posts" USING btree ("status","publish_lease_expires_at");--> statement-breakpoint
CREATE INDEX "posts_recycled_from_idx" ON "posts" USING btree ("recycled_from_id");--> statement-breakpoint
CREATE INDEX "posts_thread_group_idx" ON "posts" USING btree ("thread_group_id","thread_position");--> statement-breakpoint
CREATE INDEX "posts_org_effective_date_idx" ON "posts" USING btree ("organization_id",coalesce("published_at", "created_at") desc,"id" desc);--> statement-breakpoint
CREATE INDEX "posts_metrics_refresh_idx" ON "posts" USING btree ("metrics_collected_at") WHERE "posts"."status" = 'published';--> statement-breakpoint
CREATE INDEX "publish_attempts_target_claimed_idx" ON "publish_attempts" USING btree ("post_target_id","claimed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_outbox_operation_idx" ON "publish_outbox" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "publish_outbox_pending_idx" ON "publish_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "publish_outbox_retention_idx" ON "publish_outbox" USING btree ("status","dispatched_at","id");--> statement-breakpoint
CREATE INDEX "qr_codes_org_idx" ON "qr_codes" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_failures_queue_message_idx" ON "queue_failures" USING btree ("queue_name","message_id");--> statement-breakpoint
CREATE INDEX "queue_failures_status_created_idx" ON "queue_failures" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "queue_failures_operation_idx" ON "queue_failures" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "queue_failures_organization_ids_idx" ON "queue_failures" USING gin ("organization_ids");--> statement-breakpoint
CREATE INDEX "queue_failures_replay_claim_idx" ON "queue_failures" USING btree ("status","replay_claim_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recycling_occurrences_config_scheduled_idx" ON "recycling_occurrences" USING btree ("config_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "recycling_occurrences_post_idx" ON "recycling_occurrences" USING btree ("post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ref_urls_org_scope_slug_uniq" ON "ref_urls" USING btree ("organization_id","scope_key","slug");--> statement-breakpoint
CREATE INDEX "ref_urls_automation_idx" ON "ref_urls" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "segments_org_idx" ON "segments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "segments_workspace_idx" ON "segments" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_idx" ON "auth"."session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "auth"."session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "short_link_configs_org_idx" ON "short_link_configs" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "short_links_provider_code_uniq" ON "short_links" USING btree ("provider","short_code");--> statement-breakpoint
CREATE UNIQUE INDEX "short_links_short_url_uniq" ON "short_links" USING btree ("short_url");--> statement-breakpoint
CREATE INDEX "short_links_org_idx" ON "short_links" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "short_links_post_idx" ON "short_links" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "short_links_created_sync_idx" ON "short_links" USING btree ("created_at","last_click_sync_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signatures_org_scope_name_uniq" ON "signatures" USING btree ("organization_id","scope_key","name");--> statement-breakpoint
CREATE UNIQUE INDEX "signatures_org_scope_default_uniq" ON "signatures" USING btree ("organization_id","scope_key") WHERE "signatures"."is_default" = true;--> statement-breakpoint
CREATE INDEX "signatures_org_idx" ON "signatures" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "signatures_workspace_idx" ON "signatures" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sync_state_enabled_next_idx" ON "social_account_sync_state" USING btree ("enabled","next_sync_at");--> statement-breakpoint
CREATE INDEX "sync_state_org_idx" ON "social_account_sync_state" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_org_platform_account_idx" ON "social_accounts" USING btree ("organization_id","platform","platform_account_id");--> statement-breakpoint
CREATE INDEX "social_accounts_org_idx" ON "social_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "social_accounts_webhook_id_idx" ON "social_accounts" USING btree ("platform","webhook_account_id");--> statement-breakpoint
CREATE INDEX "social_accounts_workspace_idx" ON "social_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "social_accounts_org_lifecycle_idx" ON "social_accounts" USING btree ("organization_id","lifecycle_status");--> statement-breakpoint
CREATE INDEX "social_accounts_sms_webhook_route_idx" ON "social_accounts" USING btree ("platform_account_id") WHERE "social_accounts"."platform" = 'sms' AND "social_accounts"."lifecycle_status" = 'active';--> statement-breakpoint
CREATE INDEX "social_accounts_token_expiry_idx" ON "social_accounts" USING btree ("token_expires_at") WHERE "social_accounts"."lifecycle_status" = 'active';--> statement-breakpoint
CREATE INDEX "stripe_events_status_lease_idx" ON "stripe_events" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_checkout_operations_active_org_uniq" ON "subscription_checkout_operations" USING btree ("organization_id") WHERE "subscription_checkout_operations"."status" IN ('pending', 'creating', 'unknown', 'created');--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_checkout_operations_session_uniq" ON "subscription_checkout_operations" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE INDEX "subscription_checkout_operations_status_lease_idx" ON "subscription_checkout_operations" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "subscription_checkout_operations_org_created_idx" ON "subscription_checkout_operations" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "subscription_lists_org_idx" ON "subscription_lists" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tags_org_idx" ON "tags" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tags_workspace_idx" ON "tags" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "telegram_connection_challenges_org_scope_status_idx" ON "telegram_connection_challenges" USING btree ("organization_id","scope_key","status");--> statement-breakpoint
CREATE INDEX "telegram_connection_challenges_org_workspace_idx" ON "telegram_connection_challenges" USING btree ("organization_id","workspace_id");--> statement-breakpoint
CREATE INDEX "telegram_connection_challenges_api_key_status_idx" ON "telegram_connection_challenges" USING btree ("api_key_id","status");--> statement-breakpoint
CREATE INDEX "telegram_connection_challenges_expiry_idx" ON "telegram_connection_challenges" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "tenant_deletion_jobs_due_idx" ON "tenant_deletion_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_deletion_steps_org_key_uniq" ON "tenant_deletion_steps" USING btree ("organization_id","step_key");--> statement-breakpoint
CREATE INDEX "tenant_deletion_steps_due_idx" ON "tenant_deletion_steps" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "thread_executions_org_status_idx" ON "thread_executions" USING btree ("organization_id","status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "thread_executions_status_lease_idx" ON "thread_executions" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "token_refresh_operations_operation_id_idx" ON "token_refresh_operations" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_bucket_settlements_bucket_uniq" ON "usage_bucket_settlements" USING btree ("bucket_id");--> statement-breakpoint
CREATE INDEX "usage_bucket_settlements_invoice_idx" ON "usage_bucket_settlements" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "usage_bucket_settlements_state_idx" ON "usage_bucket_settlements" USING btree ("state","claimed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_buckets_org_metric_period_uniq" ON "usage_buckets" USING btree ("organization_id","metric","period_start");--> statement-breakpoint
CREATE INDEX "usage_buckets_org_period_end_idx" ON "usage_buckets" USING btree ("organization_id","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_org_period_idx" ON "usage_records" USING btree ("organization_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_reservations_org_idempotency_uniq" ON "usage_reservations" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "usage_reservations_bucket_state_idx" ON "usage_reservations" USING btree ("bucket_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_idx" ON "auth"."user" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_endpoint_idx" ON "webhook_deliveries" USING btree ("webhook_event_id","webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_idx" ON "webhook_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_dispatch_idx" ON "webhook_deliveries" USING btree ("status","next_dispatch_at","dispatch_lease_expires_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_org_idx" ON "webhook_endpoints" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_workspace_idx" ON "webhook_endpoints" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_org_occurrence_idx" ON "webhook_events" USING btree ("organization_id","occurrence_id");--> statement-breakpoint
CREATE INDEX "webhook_events_retention_idx" ON "webhook_events" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "webhook_logs_event_created_idx" ON "webhook_logs" USING btree ("webhook_event_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_logs_org_created_idx" ON "webhook_logs" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_phone_numbers_provisioning_operation_uniq" ON "whatsapp_phone_numbers" USING btree ("provisioning_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_phone_numbers_provisioning_key_uniq" ON "whatsapp_phone_numbers" USING btree ("organization_id","provisioning_operation_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_phone_numbers_telnyx_order_uniq" ON "whatsapp_phone_numbers" USING btree ("telnyx_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_phone_numbers_release_operation_uniq" ON "whatsapp_phone_numbers" USING btree ("release_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_phone_numbers_provider_number_uniq" ON "whatsapp_phone_numbers" USING btree ("provider_number_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_phone_numbers_meta_number_uniq" ON "whatsapp_phone_numbers" USING btree ("wa_phone_number_id");--> statement-breakpoint
CREATE INDEX "wa_phone_numbers_org_idx" ON "whatsapp_phone_numbers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "wa_phone_numbers_status_idx" ON "whatsapp_phone_numbers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wa_phone_numbers_provisioning_due_idx" ON "whatsapp_phone_numbers" USING btree ("provisioning_state","provisioning_next_attempt_at","provisioning_lease_expires_at");--> statement-breakpoint
CREATE INDEX "wa_phone_numbers_release_due_idx" ON "whatsapp_phone_numbers" USING btree ("release_state","release_next_attempt_at","release_lease_expires_at");--> statement-breakpoint
CREATE INDEX "workspace_erasure_jobs_org_status_idx" ON "workspace_erasure_jobs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "workspace_erasure_jobs_due_idx" ON "workspace_erasure_jobs" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_erasure_steps_workspace_key_uniq" ON "workspace_erasure_steps" USING btree ("workspace_id","step_key");--> statement-breakpoint
CREATE INDEX "workspace_erasure_steps_due_idx" ON "workspace_erasure_steps" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "workspace_tombstones_org_erased_idx" ON "workspace_tombstones" USING btree ("organization_id","erased_at");--> statement-breakpoint
CREATE INDEX "workspaces_org_idx" ON "workspaces" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "workspaces_org_name_idx" ON "workspaces" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "workspaces_org_lifecycle_idx" ON "workspaces" USING btree ("organization_id","lifecycle_status");
--> statement-breakpoint
-- RelayAPI non-declarative database contracts (generated).
-- Append this output after the Drizzle-generated baseline objects.

CREATE OR REPLACE FUNCTION "public"."provision_organization_defaults"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, auth
AS $relay_provision_organization$
BEGIN
	INSERT INTO public."organization_settings" (organization_id)
	VALUES (NEW.id)
	ON CONFLICT (organization_id) DO NOTHING;

	INSERT INTO public."workspaces" (id, organization_id, name, lifecycle_status)
	SELECT 'ws_' || replace(gen_random_uuid()::text, '-', ''), NEW.id, 'General', 'active'
	WHERE NOT EXISTS (
		SELECT 1 FROM public."workspaces"
		WHERE organization_id = NEW.id
	);

	INSERT INTO public."idea_groups" (id, organization_id, workspace_id, name, position, is_default, revision)
	VALUES ('idg_' || replace(gen_random_uuid()::text, '-', ''), NEW.id, NULL, 'Unassigned', 0, true, 0)
	ON CONFLICT DO NOTHING;

	RETURN NEW;
END;
$relay_provision_organization$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "provision_organization_defaults_after_insert" ON "auth"."organization";
--> statement-breakpoint
CREATE TRIGGER "provision_organization_defaults_after_insert"
AFTER INSERT ON "auth"."organization"
FOR EACH ROW
EXECUTE FUNCTION "public"."provision_organization_defaults"();
--> statement-breakpoint

INSERT INTO public."organization_settings" (organization_id)
SELECT id FROM "auth"."organization"
ON CONFLICT (organization_id) DO NOTHING;
--> statement-breakpoint

INSERT INTO public."workspaces" (id, organization_id, name, lifecycle_status)
SELECT 'ws_' || replace(gen_random_uuid()::text, '-', ''), organization_row.id, 'General', 'active'
FROM "auth"."organization" AS organization_row
WHERE NOT EXISTS (
	SELECT 1 FROM public."workspaces" AS workspace_row
	WHERE workspace_row.organization_id = organization_row.id
);
--> statement-breakpoint

INSERT INTO public."idea_groups" (id, organization_id, workspace_id, name, position, is_default, revision)
SELECT 'idg_' || replace(gen_random_uuid()::text, '-', ''), organization_row.id, NULL, 'Unassigned',
	COALESCE((SELECT MAX(group_row.position) + 1 FROM public."idea_groups" AS group_row WHERE group_row.organization_id = organization_row.id AND group_row.workspace_id IS NULL), 0),
	true, 0
FROM "auth"."organization" AS organization_row
WHERE NOT EXISTS (
	SELECT 1 FROM public."idea_groups" AS default_group
	WHERE default_group.organization_id = organization_row.id
		AND default_group.workspace_id IS NULL
		AND default_group.is_default = true
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."project_parent_identity"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_project_parent$
DECLARE
	parent_id text;
	parent_row jsonb;
	projected_values jsonb := '{}'::jsonb;
	mapping text;
	parent_column text;
	child_column text;
BEGIN
	parent_id := to_jsonb(NEW) ->> TG_ARGV[1];
	IF parent_id IS NULL OR parent_id = '' THEN
		RAISE EXCEPTION USING
			ERRCODE = '23502',
			MESSAGE = format('%s.%s must identify its %s parent', TG_TABLE_NAME, TG_ARGV[1], TG_ARGV[0]);
	END IF;

	EXECUTE format(
		'SELECT to_jsonb(parent_row) FROM public.%I AS parent_row WHERE parent_row.id = $1 AND parent_row.organization_id = $2',
		TG_ARGV[0]
	)
	INTO parent_row
	USING parent_id, NEW.organization_id;

	IF parent_row IS NULL THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			MESSAGE = format('parent public.%s(%s, %s) does not exist', TG_ARGV[0], parent_id, NEW.organization_id);
	END IF;

	FOREACH mapping IN ARRAY string_to_array(TG_ARGV[2], ',') LOOP
		parent_column := split_part(mapping, ':', 1);
		child_column := split_part(mapping, ':', 2);
		IF parent_column = '' OR child_column = '' OR NOT (parent_row ? parent_column) THEN
			RAISE EXCEPTION 'invalid parent identity projection: %', mapping;
		END IF;
		projected_values := projected_values || jsonb_build_object(
			child_column,
			parent_row -> parent_column
		);
	END LOOP;

	NEW := jsonb_populate_record(NEW, projected_values);
	RETURN NEW;
END;
$relay_project_parent$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_thread_executions_thread_group_id" ON public."thread_executions";
--> statement-breakpoint
CREATE TRIGGER "project_thread_executions_thread_group_id"
BEFORE INSERT OR UPDATE OF "thread_group_id", "organization_id", "workspace_id"
ON public."thread_executions"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('post_threads', 'thread_group_id', 'workspace_id:workspace_id');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_post_targets_post_id" ON public."post_targets";
--> statement-breakpoint
CREATE TRIGGER "project_post_targets_post_id"
BEFORE INSERT OR UPDATE OF "post_id", "organization_id", "scope_key"
ON public."post_targets"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('posts', 'post_id', 'scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_post_targets_social_account_id" ON public."post_targets";
--> statement-breakpoint
CREATE TRIGGER "project_post_targets_social_account_id"
BEFORE INSERT OR UPDATE OF "social_account_id", "organization_id", "platform"
ON public."post_targets"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('social_accounts', 'social_account_id', 'platform:platform');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_cross_post_actions_source_target_id" ON public."cross_post_actions";
--> statement-breakpoint
CREATE TRIGGER "project_cross_post_actions_source_target_id"
BEFORE INSERT OR UPDATE OF "source_target_id", "organization_id", "post_id", "scope_key", "source_platform"
ON public."cross_post_actions"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('post_targets', 'source_target_id', 'post_id:post_id,scope_key:scope_key,platform:source_platform');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_cross_post_actions_target_account_id" ON public."cross_post_actions";
--> statement-breakpoint
CREATE TRIGGER "project_cross_post_actions_target_account_id"
BEFORE INSERT OR UPDATE OF "target_account_id", "organization_id", "target_platform"
ON public."cross_post_actions"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('social_accounts', 'target_account_id', 'platform:target_platform');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_inbox_conversations_account_id" ON public."inbox_conversations";
--> statement-breakpoint
CREATE TRIGGER "project_inbox_conversations_account_id"
BEFORE INSERT OR UPDATE OF "account_id", "organization_id", "workspace_id", "platform"
ON public."inbox_conversations"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('social_accounts', 'account_id', 'workspace_id:workspace_id,platform:platform');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_inbox_messages_conversation_id" ON public."inbox_messages";
--> statement-breakpoint
CREATE TRIGGER "project_inbox_messages_conversation_id"
BEFORE INSERT OR UPDATE OF "conversation_id", "organization_id", "scope_key", "account_id", "platform"
ON public."inbox_messages"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('inbox_conversations', 'conversation_id', 'scope_key:scope_key,account_id:account_id,platform:platform');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_custom_field_values_contact_id" ON public."custom_field_values";
--> statement-breakpoint
CREATE TRIGGER "project_custom_field_values_contact_id"
BEFORE INSERT OR UPDATE OF "contact_id", "organization_id", "scope_key"
ON public."custom_field_values"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('contacts', 'contact_id', 'scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_custom_field_values_definition_id" ON public."custom_field_values";
--> statement-breakpoint
CREATE TRIGGER "project_custom_field_values_definition_id"
BEFORE INSERT OR UPDATE OF "definition_id", "organization_id", "definition_scope_key"
ON public."custom_field_values"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('custom_field_definitions', 'definition_id', 'scope_key:definition_scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_contact_channels_contact_id" ON public."contact_channels";
--> statement-breakpoint
CREATE TRIGGER "project_contact_channels_contact_id"
BEFORE INSERT OR UPDATE OF "contact_id", "organization_id", "scope_key"
ON public."contact_channels"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('contacts', 'contact_id', 'scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_contact_channels_social_account_id" ON public."contact_channels";
--> statement-breakpoint
CREATE TRIGGER "project_contact_channels_social_account_id"
BEFORE INSERT OR UPDATE OF "social_account_id", "organization_id", "platform"
ON public."contact_channels"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('social_accounts', 'social_account_id', 'platform:platform');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_contact_consent_states_last_event_id" ON public."contact_consent_states";
--> statement-breakpoint
CREATE TRIGGER "project_contact_consent_states_last_event_id"
BEFORE INSERT OR UPDATE OF "last_event_id", "organization_id", "workspace_id"
ON public."contact_consent_states"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('contact_consent_events', 'last_event_id', 'workspace_id:workspace_id');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_contact_suppressions_source_event_id" ON public."contact_suppressions";
--> statement-breakpoint
CREATE TRIGGER "project_contact_suppressions_source_event_id"
BEFORE INSERT OR UPDATE OF "source_event_id", "organization_id", "workspace_id"
ON public."contact_suppressions"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('contact_consent_events', 'source_event_id', 'workspace_id:workspace_id');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_broadcasts_social_account_id" ON public."broadcasts";
--> statement-breakpoint
CREATE TRIGGER "project_broadcasts_social_account_id"
BEFORE INSERT OR UPDATE OF "social_account_id", "organization_id", "workspace_id", "platform"
ON public."broadcasts"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('social_accounts', 'social_account_id', 'workspace_id:workspace_id,platform:platform');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_broadcast_recipients_broadcast_id" ON public."broadcast_recipients";
--> statement-breakpoint
CREATE TRIGGER "project_broadcast_recipients_broadcast_id"
BEFORE INSERT OR UPDATE OF "broadcast_id", "organization_id", "scope_key"
ON public."broadcast_recipients"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('broadcasts', 'broadcast_id', 'scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_ad_accounts_social_account_id" ON public."ad_accounts";
--> statement-breakpoint
CREATE TRIGGER "project_ad_accounts_social_account_id"
BEFORE INSERT OR UPDATE OF "social_account_id", "organization_id", "workspace_id"
ON public."ad_accounts"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('social_accounts', 'social_account_id', 'workspace_id:workspace_id');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_ad_campaigns_ad_account_id" ON public."ad_campaigns";
--> statement-breakpoint
CREATE TRIGGER "project_ad_campaigns_ad_account_id"
BEFORE INSERT OR UPDATE OF "ad_account_id", "organization_id", "workspace_id", "platform"
ON public."ad_campaigns"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('ad_accounts', 'ad_account_id', 'workspace_id:workspace_id,platform:platform');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_ads_campaign_id" ON public."ads";
--> statement-breakpoint
CREATE TRIGGER "project_ads_campaign_id"
BEFORE INSERT OR UPDATE OF "campaign_id", "organization_id", "workspace_id", "ad_account_id", "platform"
ON public."ads"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('ad_campaigns', 'campaign_id', 'workspace_id:workspace_id,ad_account_id:ad_account_id,platform:platform');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_ad_creation_operations_ad_account_id" ON public."ad_creation_operations";
--> statement-breakpoint
CREATE TRIGGER "project_ad_creation_operations_ad_account_id"
BEFORE INSERT OR UPDATE OF "ad_account_id", "organization_id", "workspace_id", "platform"
ON public."ad_creation_operations"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('ad_accounts', 'ad_account_id', 'workspace_id:workspace_id,platform:platform');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_ad_audiences_ad_account_id" ON public."ad_audiences";
--> statement-breakpoint
CREATE TRIGGER "project_ad_audiences_ad_account_id"
BEFORE INSERT OR UPDATE OF "ad_account_id", "organization_id", "workspace_id", "platform"
ON public."ad_audiences"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('ad_accounts', 'ad_account_id', 'workspace_id:workspace_id,platform:platform');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_external_posts_social_account_id" ON public."external_posts";
--> statement-breakpoint
CREATE TRIGGER "project_external_posts_social_account_id"
BEFORE INSERT OR UPDATE OF "social_account_id", "organization_id", "workspace_id", "platform"
ON public."external_posts"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('social_accounts', 'social_account_id', 'workspace_id:workspace_id,platform:platform');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_ad_sync_logs_ad_account_id" ON public."ad_sync_logs";
--> statement-breakpoint
CREATE TRIGGER "project_ad_sync_logs_ad_account_id"
BEFORE INSERT OR UPDATE OF "ad_account_id", "organization_id", "scope_key", "platform"
ON public."ad_sync_logs"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('ad_accounts', 'ad_account_id', 'scope_key:scope_key,platform:platform');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_social_account_sync_state_social_account_id" ON public."social_account_sync_state";
--> statement-breakpoint
CREATE TRIGGER "project_social_account_sync_state_social_account_id"
BEFORE INSERT OR UPDATE OF "social_account_id", "organization_id", "scope_key", "platform"
ON public."social_account_sync_state"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('social_accounts', 'social_account_id', 'scope_key:scope_key,platform:platform');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_ideas_group_id" ON public."ideas";
--> statement-breakpoint
CREATE TRIGGER "project_ideas_group_id"
BEFORE INSERT OR UPDATE OF "group_id", "organization_id", "group_scope_key"
ON public."ideas"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('idea_groups', 'group_id', 'scope_key:group_scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_idea_conversion_operations_idea_id" ON public."idea_conversion_operations";
--> statement-breakpoint
CREATE TRIGGER "project_idea_conversion_operations_idea_id"
BEFORE INSERT OR UPDATE OF "idea_id", "organization_id", "scope_key"
ON public."idea_conversion_operations"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('ideas', 'idea_id', 'scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_idea_media_idea_id" ON public."idea_media";
--> statement-breakpoint
CREATE TRIGGER "project_idea_media_idea_id"
BEFORE INSERT OR UPDATE OF "idea_id", "organization_id", "workspace_id"
ON public."idea_media"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('ideas', 'idea_id', 'workspace_id:workspace_id');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_idea_tags_idea_id" ON public."idea_tags";
--> statement-breakpoint
CREATE TRIGGER "project_idea_tags_idea_id"
BEFORE INSERT OR UPDATE OF "idea_id", "organization_id", "workspace_id"
ON public."idea_tags"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('ideas', 'idea_id', 'workspace_id:workspace_id');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_idea_tags_tag_id" ON public."idea_tags";
--> statement-breakpoint
CREATE TRIGGER "project_idea_tags_tag_id"
BEFORE INSERT OR UPDATE OF "tag_id", "organization_id", "tag_scope_key"
ON public."idea_tags"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('tags', 'tag_id', 'scope_key:tag_scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_post_tags_post_id" ON public."post_tags";
--> statement-breakpoint
CREATE TRIGGER "project_post_tags_post_id"
BEFORE INSERT OR UPDATE OF "post_id", "organization_id", "scope_key"
ON public."post_tags"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('posts', 'post_id', 'scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_post_tags_tag_id" ON public."post_tags";
--> statement-breakpoint
CREATE TRIGGER "project_post_tags_tag_id"
BEFORE INSERT OR UPDATE OF "tag_id", "organization_id", "tag_scope_key"
ON public."post_tags"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('tags', 'tag_id', 'scope_key:tag_scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_automation_entrypoints_automation_id" ON public."automation_entrypoints";
--> statement-breakpoint
CREATE TRIGGER "project_automation_entrypoints_automation_id"
BEFORE INSERT OR UPDATE OF "automation_id", "organization_id", "scope_key"
ON public."automation_entrypoints"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('automations', 'automation_id', 'scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_automation_bindings_automation_id" ON public."automation_bindings";
--> statement-breakpoint
CREATE TRIGGER "project_automation_bindings_automation_id"
BEFORE INSERT OR UPDATE OF "automation_id", "organization_id", "workspace_id"
ON public."automation_bindings"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('automations', 'automation_id', 'workspace_id:workspace_id');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_automation_runs_automation_id" ON public."automation_runs";
--> statement-breakpoint
CREATE TRIGGER "project_automation_runs_automation_id"
BEFORE INSERT OR UPDATE OF "automation_id", "organization_id", "scope_key"
ON public."automation_runs"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('automations', 'automation_id', 'scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_automation_node_executions_run_id" ON public."automation_node_executions";
--> statement-breakpoint
CREATE TRIGGER "project_automation_node_executions_run_id"
BEFORE INSERT OR UPDATE OF "run_id", "organization_id", "scope_key"
ON public."automation_node_executions"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('automation_runs', 'run_id', 'scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_automation_effects_node_execution_id" ON public."automation_effects";
--> statement-breakpoint
CREATE TRIGGER "project_automation_effects_node_execution_id"
BEFORE INSERT OR UPDATE OF "node_execution_id", "organization_id", "scope_key"
ON public."automation_effects"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('automation_node_executions', 'node_execution_id', 'scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_contact_segment_memberships_segment_id" ON public."contact_segment_memberships";
--> statement-breakpoint
CREATE TRIGGER "project_contact_segment_memberships_segment_id"
BEFORE INSERT OR UPDATE OF "segment_id", "organization_id", "scope_key"
ON public."contact_segment_memberships"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('segments', 'segment_id', 'scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_contact_subscriptions_list_id" ON public."contact_subscriptions";
--> statement-breakpoint
CREATE TRIGGER "project_contact_subscriptions_list_id"
BEFORE INSERT OR UPDATE OF "list_id", "organization_id", "scope_key"
ON public."contact_subscriptions"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('subscription_lists', 'list_id', 'scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_ai_knowledge_documents_kb_id" ON public."ai_knowledge_documents";
--> statement-breakpoint
CREATE TRIGGER "project_ai_knowledge_documents_kb_id"
BEFORE INSERT OR UPDATE OF "kb_id", "organization_id", "scope_key"
ON public."ai_knowledge_documents"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('ai_knowledge_bases', 'kb_id', 'scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_ai_knowledge_chunks_document_id" ON public."ai_knowledge_chunks";
--> statement-breakpoint
CREATE TRIGGER "project_ai_knowledge_chunks_document_id"
BEFORE INSERT OR UPDATE OF "document_id", "organization_id", "scope_key", "kb_id"
ON public."ai_knowledge_chunks"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('ai_knowledge_documents', 'document_id', 'scope_key:scope_key,kb_id:kb_id');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_qr_codes_ref_url_id" ON public."qr_codes";
--> statement-breakpoint
CREATE TRIGGER "project_qr_codes_ref_url_id"
BEFORE INSERT OR UPDATE OF "ref_url_id", "organization_id", "scope_key"
ON public."qr_codes"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('ref_urls', 'ref_url_id', 'scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_billing_operations_usage_bucket_settlement_id" ON public."billing_operations";
--> statement-breakpoint
CREATE TRIGGER "project_billing_operations_usage_bucket_settlement_id"
BEFORE INSERT OR UPDATE OF "usage_bucket_settlement_id", "organization_id", "amount_cents", "currency"
ON public."billing_operations"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('usage_bucket_settlements', 'usage_bucket_settlement_id', 'amount_cents:amount_cents,currency:currency');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."enforce_workspace_requirement"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_require_workspace$
DECLARE
	require_workspace boolean;
	workspace_state text;
	inactive_row boolean;
BEGIN
	inactive_row := TG_NARGS >= 2
		AND TG_ARGV[0] <> ''
		AND (to_jsonb(NEW) ->> TG_ARGV[0]) = ANY(string_to_array(TG_ARGV[1], ','));

	IF inactive_row AND TG_OP = 'UPDATE' THEN
		IF NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
			AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
		THEN
			RETURN NEW;
		END IF;
	END IF;

	IF NEW.workspace_id IS NOT NULL THEN
		SELECT workspace_row.lifecycle_status
		INTO workspace_state
		FROM public."workspaces" AS workspace_row
		WHERE workspace_row.id = NEW.workspace_id
			AND workspace_row.organization_id = NEW.organization_id
		FOR SHARE;

		IF NOT FOUND THEN
			RAISE EXCEPTION USING
				ERRCODE = '23503',
				MESSAGE = format('workspace %s does not belong to organization %s', NEW.workspace_id, NEW.organization_id);
		END IF;
		IF workspace_state <> 'active' THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				MESSAGE = format('workspace %s is not active', NEW.workspace_id);
		END IF;
		RETURN NEW;
	END IF;

	SELECT settings_row."require_workspace_id"
	INTO require_workspace
	FROM public."organization_settings" AS settings_row
	WHERE settings_row.organization_id = NEW.organization_id
	FOR SHARE;

	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			MESSAGE = format('organization %s has no organization_settings row', NEW.organization_id);
	END IF;

	IF require_workspace THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = format('%s.workspace_id is required by organization policy', TG_TABLE_NAME);
	END IF;

	RETURN NEW;
END;
$relay_require_workspace$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_social_accounts" ON public."social_accounts";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_social_accounts"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id", "lifecycle_status"
ON public."social_accounts"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('lifecycle_status', 'disconnected');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_post_threads" ON public."post_threads";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_post_threads"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id"
ON public."post_threads"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_posts" ON public."posts";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_posts"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id"
ON public."posts"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_media" ON public."media";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_media"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id"
ON public."media"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_webhook_endpoints" ON public."webhook_endpoints";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_webhook_endpoints"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id"
ON public."webhook_endpoints"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_inbox_conversations" ON public."inbox_conversations";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_inbox_conversations"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id", "account_id", "status"
ON public."inbox_conversations"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('status', 'archived');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_auto_post_rules" ON public."auto_post_rules";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_auto_post_rules"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id"
ON public."auto_post_rules"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_contacts" ON public."contacts";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_contacts"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id"
ON public."contacts"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_broadcasts" ON public."broadcasts";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_broadcasts"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id", "social_account_id"
ON public."broadcasts"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_ad_accounts" ON public."ad_accounts";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_ad_accounts"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id", "social_account_id"
ON public."ad_accounts"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_ad_audiences" ON public."ad_audiences";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_ad_audiences"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id", "ad_account_id"
ON public."ad_audiences"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_short_links" ON public."short_links";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_short_links"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id"
ON public."short_links"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_ideas" ON public."ideas";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_ideas"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id"
ON public."ideas"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_automations" ON public."automations";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_automations"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id", "status"
ON public."automations"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('status', 'archived');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_segments" ON public."segments";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_segments"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id"
ON public."segments"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_subscription_lists" ON public."subscription_lists";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_subscription_lists"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id"
ON public."subscription_lists"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_ai_knowledge_bases" ON public."ai_knowledge_bases";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_ai_knowledge_bases"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id"
ON public."ai_knowledge_bases"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_ai_agents" ON public."ai_agents";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_ai_agents"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id"
ON public."ai_agents"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_ref_urls" ON public."ref_urls";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_ref_urls"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id"
ON public."ref_urls"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "zz_require_workspace_landing_pages" ON public."landing_pages";
--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_landing_pages"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id"
ON public."landing_pages"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."maintain_segment_member_count"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_segment_member_count$
BEGIN
	IF TG_OP = 'INSERT' THEN
		UPDATE public."segments"
		SET member_count = member_count + 1
		WHERE id = NEW.segment_id;
		RETURN NEW;
	ELSIF TG_OP = 'DELETE' THEN
		UPDATE public."segments"
		SET member_count = member_count - 1
		WHERE id = OLD.segment_id;
		RETURN OLD;
	ELSIF OLD.segment_id IS DISTINCT FROM NEW.segment_id THEN
		UPDATE public."segments"
		SET member_count = member_count - 1
		WHERE id = OLD.segment_id;
		UPDATE public."segments"
		SET member_count = member_count + 1
		WHERE id = NEW.segment_id;
	END IF;
	RETURN NEW;
END;
$relay_segment_member_count$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "maintain_segment_member_count_after_write" ON public."contact_segment_memberships";
--> statement-breakpoint
CREATE TRIGGER "maintain_segment_member_count_after_write"
AFTER INSERT OR DELETE OR UPDATE OF segment_id
ON public."contact_segment_memberships"
FOR EACH ROW
EXECUTE FUNCTION "public"."maintain_segment_member_count"();
--> statement-breakpoint

UPDATE public."segments" AS segment_row
SET member_count = (
	SELECT count(*)::integer
	FROM public."contact_segment_memberships" AS membership_row
	WHERE membership_row.segment_id = segment_row.id
);
--> statement-breakpoint
