-- RelayAPI required database preamble (generated).
CREATE SCHEMA IF NOT EXISTS "auth";
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO PUBLIC;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA "public";
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public";
--> statement-breakpoint
DO $relay_verify_extension_schema$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_extension extension_row
		JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = extension_row.extnamespace
		WHERE extension_row.extname = 'btree_gist'
			AND namespace_row.nspname = 'public'
	) THEN
		RAISE EXCEPTION 'required extension btree_gist must be installed in schema public';
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_extension extension_row
		JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = extension_row.extnamespace
		WHERE extension_row.extname = 'pg_trgm'
			AND namespace_row.nspname = 'public'
	) THEN
		RAISE EXCEPTION 'required extension pg_trgm must be installed in schema public';
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_extension extension_row
		JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = extension_row.extnamespace
		WHERE extension_row.extname = 'vector'
			AND namespace_row.nspname = 'public'
	) THEN
		RAISE EXCEPTION 'required extension vector must be installed in schema public';
	END IF;
END;
$relay_verify_extension_schema$;
--> statement-breakpoint
CREATE TYPE "public"."ad_objective" AS ENUM('awareness', 'traffic', 'engagement', 'leads', 'conversions', 'video_views');--> statement-breakpoint
CREATE TYPE "public"."ad_platform" AS ENUM('meta', 'google', 'tiktok', 'linkedin', 'pinterest', 'twitter');--> statement-breakpoint
CREATE TYPE "public"."ad_status" AS ENUM('draft', 'pending_review', 'active', 'paused', 'completed', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."audience_type" AS ENUM('customer_list', 'website', 'lookalike');--> statement-breakpoint
CREATE TYPE "public"."automation_binding_type" AS ENUM('default_reply', 'welcome_message', 'get_started', 'main_menu', 'ice_breaker');--> statement-breakpoint
CREATE TYPE "public"."automation_channel" AS ENUM('instagram', 'facebook', 'whatsapp', 'telegram', 'tiktok');--> statement-breakpoint
CREATE TYPE "public"."automation_run_status" AS ENUM('active', 'waiting', 'completed', 'exited', 'failed');--> statement-breakpoint
CREATE TYPE "public"."automation_status" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."contact_subscription_event_type" AS ENUM('subscribed', 'unsubscribed');--> statement-breakpoint
CREATE TYPE "public"."contact_subscription_source" AS ENUM('automation', 'manual', 'import', 'api');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('open', 'archived', 'snoozed');--> statement-breakpoint
CREATE TYPE "public"."conversation_type" AS ENUM('comment_thread', 'dm', 'review');--> statement-breakpoint
CREATE TYPE "public"."erasure_hold_subject_kind" AS ENUM('organization', 'workspace');--> statement-breakpoint
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
	"lease_token" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"last_error" text,
	"provider_response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "account_revocation_jobs_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "account_revocation_jobs_status_check" CHECK ("account_revocation_jobs"."status" IN ('pending', 'processing', 'retry', 'unknown', 'manual_required', 'succeeded', 'abandoned')),
	CONSTRAINT "account_revocation_jobs_counters_nonnegative_check" CHECK ("account_revocation_jobs"."attempts" >= 0 AND "account_revocation_jobs"."lease_token" >= 0 AND "account_revocation_jobs"."source_token_version" >= 0),
	CONSTRAINT "account_revocation_jobs_lease_state_check" CHECK (("account_revocation_jobs"."status" = 'processing' AND "account_revocation_jobs"."lease_expires_at" IS NOT NULL)
				OR ("account_revocation_jobs"."status" <> 'processing' AND "account_revocation_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "account_revocation_jobs_completion_check" CHECK (("account_revocation_jobs"."status" IN ('manual_required', 'succeeded', 'abandoned') AND "account_revocation_jobs"."completed_at" IS NOT NULL)
				OR ("account_revocation_jobs"."status" NOT IN ('manual_required', 'succeeded', 'abandoned') AND "account_revocation_jobs"."completed_at" IS NULL)),
	CONSTRAINT "account_revocation_jobs_terminal_redaction_check" CHECK ("account_revocation_jobs"."status" NOT IN ('manual_required', 'succeeded', 'abandoned')
				OR ("account_revocation_jobs"."access_token_ciphertext" IS NULL AND "account_revocation_jobs"."refresh_token_ciphertext" IS NULL)),
	CONSTRAINT "account_revocation_jobs_request_boundary_check" CHECK (("account_revocation_jobs"."status" NOT IN ('pending', 'retry')
					OR "account_revocation_jobs"."request_may_have_been_sent_at" IS NULL)
				AND ("account_revocation_jobs"."status" <> 'unknown'
					OR "account_revocation_jobs"."request_may_have_been_sent_at" IS NOT NULL)),
	CONSTRAINT "account_revocation_jobs_timestamp_order_check" CHECK ("account_revocation_jobs"."updated_at" >= "account_revocation_jobs"."created_at"
				AND ("account_revocation_jobs"."request_may_have_been_sent_at" IS NULL OR "account_revocation_jobs"."request_may_have_been_sent_at" >= "account_revocation_jobs"."created_at")
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
	"currency" varchar(3),
	"timezone" text,
	"status" text DEFAULT 'active',
	"metadata" jsonb,
	"last_sync_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_generation" integer DEFAULT 0 NOT NULL,
	"sync_lease_expires_at" timestamp with time zone,
	"sync_started_at" timestamp with time zone,
	"sync_attempts" integer DEFAULT 0 NOT NULL,
	"sync_last_error" text,
	"sync_last_error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_accounts_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "ad_accounts_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "ad_accounts_id_org_scope_platform_uniq" UNIQUE("id","organization_id","scope_key","platform"),
	CONSTRAINT "ad_accounts_sync_counters_check" CHECK ("ad_accounts"."sync_generation" >= 0 AND "ad_accounts"."sync_attempts" >= 0),
	CONSTRAINT "ad_accounts_sync_claim_check" CHECK (("ad_accounts"."sync_lease_expires_at" IS NULL AND "ad_accounts"."sync_started_at" IS NULL)
				OR ("ad_accounts"."sync_lease_expires_at" IS NOT NULL
					AND ("ad_accounts"."sync_started_at" IS NULL
						OR "ad_accounts"."sync_started_at" <= "ad_accounts"."sync_lease_expires_at"))),
	CONSTRAINT "ad_accounts_sync_error_class_check" CHECK ("ad_accounts"."sync_last_error_class" IS NULL
				OR "ad_accounts"."sync_last_error_class" IN ('transient', 'rate_limited', 'permanent')),
	CONSTRAINT "ad_accounts_currency_check" CHECK ("ad_accounts"."currency" IS NULL OR "ad_accounts"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "ad_audience_users" (
	"id" text PRIMARY KEY NOT NULL,
	"audience_id" text NOT NULL,
	"email_hash" text,
	"phone_hash" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_audience_users_identifier_present_check" CHECK ("ad_audience_users"."email_hash" IS NOT NULL OR "ad_audience_users"."phone_hash" IS NOT NULL),
	CONSTRAINT "ad_audience_users_email_hash_check" CHECK ("ad_audience_users"."email_hash" IS NULL OR "ad_audience_users"."email_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ad_audience_users_phone_hash_check" CHECK ("ad_audience_users"."phone_hash" IS NULL OR "ad_audience_users"."phone_hash" ~ '^[0-9a-f]{64}$')
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
	"currency" varchar(3),
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
	CONSTRAINT "ad_campaigns_budget_check" CHECK (("ad_campaigns"."daily_budget_cents" IS NULL OR "ad_campaigns"."daily_budget_cents" > 0)
				AND ("ad_campaigns"."lifetime_budget_cents" IS NULL OR "ad_campaigns"."lifetime_budget_cents" > 0)),
	CONSTRAINT "ad_campaigns_currency_check" CHECK ("ad_campaigns"."currency" IS NULL OR "ad_campaigns"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "ad_campaigns_date_order_check" CHECK ("ad_campaigns"."end_date" IS NULL OR "ad_campaigns"."start_date" IS NULL OR "ad_campaigns"."end_date" >= "ad_campaigns"."start_date")
);
--> statement-breakpoint
CREATE TABLE "ad_creation_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"usage_reservation_id" text,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"ad_account_id" text NOT NULL,
	"kind" text NOT NULL,
	"operation_key_hash" varchar(64) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"request_payload" jsonb NOT NULL,
	"authority_key_id" text NOT NULL,
	"authority_principal_id" text NOT NULL,
	"authority_principal_type" text NOT NULL,
	"authority_user_id" text,
	"authority_member_id" text,
	"authority_session_id" text,
	"authority_workspace_id" text,
	"authority_requires_all_workspace_scope" boolean NOT NULL,
	"authority_credential_version" text NOT NULL,
	"authority_admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authority_revision" integer DEFAULT 1 NOT NULL,
	"authority_revoked_at" timestamp with time zone,
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
	CONSTRAINT "ad_creation_operations_status_check" CHECK ("ad_creation_operations"."status" IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'reconciling', 'revocation_pending', 'manual_review', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "ad_creation_operations_authority_check" CHECK ("ad_creation_operations"."authority_principal_type" IN ('service', 'dashboard_user')
					AND ("ad_creation_operations"."authority_principal_type" = 'dashboard_user') = ("ad_creation_operations"."authority_user_id" IS NOT NULL)
					AND ("ad_creation_operations"."authority_principal_type" = 'dashboard_user') = ("ad_creation_operations"."authority_member_id" IS NOT NULL)
					AND ("ad_creation_operations"."authority_principal_type" = 'dashboard_user') = ("ad_creation_operations"."authority_session_id" IS NOT NULL)
				AND ("ad_creation_operations"."authority_workspace_id" IS NULL) = "ad_creation_operations"."authority_requires_all_workspace_scope"
				AND "ad_creation_operations"."authority_revision" > 0
				AND ("ad_creation_operations"."status" IN ('revocation_pending', 'cancelled')) = ("ad_creation_operations"."authority_revoked_at" IS NOT NULL)),
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
	CONSTRAINT "ad_creation_operations_timestamp_order_check" CHECK ("ad_creation_operations"."authority_admitted_at" <= "ad_creation_operations"."created_at"
				AND "ad_creation_operations"."updated_at" >= "ad_creation_operations"."created_at"
				AND ("ad_creation_operations"."authority_revoked_at" IS NULL OR "ad_creation_operations"."authority_revoked_at" >= "ad_creation_operations"."authority_admitted_at")
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
CREATE TABLE "ad_mutation_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"usage_reservation_id" text,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"kind" text NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"operation_key_hash" varchar(64) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"request_payload" jsonb NOT NULL,
	"requires_live_authority" boolean DEFAULT true NOT NULL,
	"authority_key_id" text NOT NULL,
	"authority_principal_id" text NOT NULL,
	"authority_principal_type" text NOT NULL,
	"authority_user_id" text,
	"authority_member_id" text,
	"authority_session_id" text,
	"authority_workspace_id" text,
	"authority_requires_all_workspace_scope" boolean NOT NULL,
	"authority_credential_version" text NOT NULL,
	"authority_admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authority_revision" integer DEFAULT 1 NOT NULL,
	"authority_revoked_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"phase" text DEFAULT 'provider' NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"provider_confirmed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ad_mutation_operations_target_check" CHECK ("ad_mutation_operations"."target_type" IN ('ad', 'campaign')),
	CONSTRAINT "ad_mutation_operations_kind_check" CHECK ("ad_mutation_operations"."kind" IN ('update_ad', 'cancel_ad', 'update_campaign', 'cancel_campaign')),
	CONSTRAINT "ad_mutation_operations_target_kind_check" CHECK (("ad_mutation_operations"."target_type" = 'ad' AND "ad_mutation_operations"."kind" IN ('update_ad', 'cancel_ad'))
				OR ("ad_mutation_operations"."target_type" = 'campaign' AND "ad_mutation_operations"."kind" IN ('update_campaign', 'cancel_campaign'))),
	CONSTRAINT "ad_mutation_operations_status_check" CHECK ("ad_mutation_operations"."status" IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'reconciling', 'revocation_pending', 'manual_review', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "ad_mutation_operations_authority_check" CHECK ("ad_mutation_operations"."authority_principal_type" IN ('service', 'dashboard_user')
					AND ("ad_mutation_operations"."authority_principal_type" = 'dashboard_user') = ("ad_mutation_operations"."authority_user_id" IS NOT NULL)
					AND ("ad_mutation_operations"."authority_principal_type" = 'dashboard_user') = ("ad_mutation_operations"."authority_member_id" IS NOT NULL)
					AND ("ad_mutation_operations"."authority_principal_type" = 'dashboard_user') = ("ad_mutation_operations"."authority_session_id" IS NOT NULL)
				AND ("ad_mutation_operations"."authority_workspace_id" IS NULL) = "ad_mutation_operations"."authority_requires_all_workspace_scope"
				AND "ad_mutation_operations"."authority_revision" > 0
				AND ("ad_mutation_operations"."status" IN ('revocation_pending', 'cancelled')) = ("ad_mutation_operations"."authority_revoked_at" IS NOT NULL)),
	CONSTRAINT "ad_mutation_operations_phase_check" CHECK ("ad_mutation_operations"."phase" IN ('provider', 'projection', 'completed')),
	CONSTRAINT "ad_mutation_operations_counters_check" CHECK ("ad_mutation_operations"."lease_token" >= 0 AND "ad_mutation_operations"."attempts" >= 0),
	CONSTRAINT "ad_mutation_operations_lease_check" CHECK (("ad_mutation_operations"."status" IN ('processing', 'request_may_have_been_sent', 'reconciling')
					AND "ad_mutation_operations"."lease_expires_at" IS NOT NULL)
				OR ("ad_mutation_operations"."status" NOT IN ('processing', 'request_may_have_been_sent', 'reconciling')
					AND "ad_mutation_operations"."lease_expires_at" IS NULL)),
	CONSTRAINT "ad_mutation_operations_boundary_check" CHECK ("ad_mutation_operations"."status" <> 'request_may_have_been_sent'
				OR "ad_mutation_operations"."request_may_have_been_sent_at" IS NOT NULL),
	CONSTRAINT "ad_mutation_operations_projection_check" CHECK ("ad_mutation_operations"."phase" = 'provider'
				OR "ad_mutation_operations"."provider_confirmed_at" IS NOT NULL),
	CONSTRAINT "ad_mutation_operations_completion_check" CHECK (("ad_mutation_operations"."status" = 'completed'
					AND "ad_mutation_operations"."phase" = 'completed'
					AND "ad_mutation_operations"."completed_at" IS NOT NULL)
				OR ("ad_mutation_operations"."status" <> 'completed'
					AND "ad_mutation_operations"."phase" <> 'completed'
					AND "ad_mutation_operations"."completed_at" IS NULL)),
	CONSTRAINT "ad_mutation_operations_timestamp_check" CHECK ("ad_mutation_operations"."authority_admitted_at" <= "ad_mutation_operations"."created_at"
				AND "ad_mutation_operations"."updated_at" >= "ad_mutation_operations"."created_at"
				AND ("ad_mutation_operations"."authority_revoked_at" IS NULL OR "ad_mutation_operations"."authority_revoked_at" >= "ad_mutation_operations"."authority_admitted_at")
				AND ("ad_mutation_operations"."request_may_have_been_sent_at" IS NULL OR "ad_mutation_operations"."request_may_have_been_sent_at" >= "ad_mutation_operations"."created_at")
				AND ("ad_mutation_operations"."provider_confirmed_at" IS NULL OR "ad_mutation_operations"."provider_confirmed_at" >= "ad_mutation_operations"."created_at")
				AND ("ad_mutation_operations"."completed_at" IS NULL OR "ad_mutation_operations"."completed_at" >= "ad_mutation_operations"."created_at"))
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
	CONSTRAINT "ad_sync_logs_type_check" CHECK ("ad_sync_logs"."sync_type" IN ('external_listing')),
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
	"metrics_updated_at" timestamp with time zone,
	"metrics_next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metrics_poll_generation" integer DEFAULT 0 NOT NULL,
	"metrics_poll_lease_expires_at" timestamp with time zone,
	"metrics_poll_started_at" timestamp with time zone,
	"metrics_poll_attempts" integer DEFAULT 0 NOT NULL,
	"metrics_poll_last_error" text,
	"metrics_poll_last_error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ads_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "ads_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "ads_id_account_org_scope_platform_uniq" UNIQUE("id","ad_account_id","organization_id","scope_key","platform"),
	CONSTRAINT "ads_budget_duration_check" CHECK (("ads"."daily_budget_cents" IS NULL OR "ads"."daily_budget_cents" > 0)
				AND ("ads"."lifetime_budget_cents" IS NULL OR "ads"."lifetime_budget_cents" > 0)
				AND ("ads"."duration_days" IS NULL OR "ads"."duration_days" > 0)),
	CONSTRAINT "ads_date_order_check" CHECK ("ads"."end_date" IS NULL OR "ads"."start_date" IS NULL OR "ads"."end_date" >= "ads"."start_date"),
	CONSTRAINT "ads_metrics_poll_counters_check" CHECK ("ads"."metrics_poll_generation" >= 0 AND "ads"."metrics_poll_attempts" >= 0),
	CONSTRAINT "ads_metrics_poll_claim_check" CHECK (("ads"."metrics_poll_lease_expires_at" IS NULL
					AND "ads"."metrics_poll_started_at" IS NULL)
				OR ("ads"."metrics_poll_lease_expires_at" IS NOT NULL
					AND ("ads"."metrics_poll_started_at" IS NULL
						OR "ads"."metrics_poll_started_at" <= "ads"."metrics_poll_lease_expires_at"))),
	CONSTRAINT "ads_metrics_poll_error_class_check" CHECK ("ads"."metrics_poll_last_error_class" IS NULL
				OR "ads"."metrics_poll_last_error_class" IN ('transient', 'rate_limited', 'permanent'))
);
--> statement-breakpoint
CREATE TABLE "ai_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name" text NOT NULL,
	"persona" text,
	"guardrails" jsonb DEFAULT '{"version":1,"blockedTopics":[],"fallbackMessage":"I can’t help with that request. A team member can take over."}'::jsonb NOT NULL,
	"provider" text DEFAULT 'workers_ai' NOT NULL,
	"model" text DEFAULT '@cf/zai-org/glm-4.7-flash' NOT NULL,
	"kb_id" text,
	"handoff_strategy" jsonb DEFAULT '{"version":1,"keywords":[],"confidenceThreshold":0.6}'::jsonb NOT NULL,
	"handoff_principal_id" text,
	"temperature" real DEFAULT 0.7 NOT NULL,
	"max_tokens" integer DEFAULT 1024 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_agents_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "ai_agents_parameters_check" CHECK ("ai_agents"."temperature" >= 0 AND "ai_agents"."temperature" <= 2 AND "ai_agents"."max_tokens" BETWEEN 1 AND 8192),
	CONSTRAINT "ai_agents_model_registry_check" CHECK ("ai_agents"."provider" = E'workers_ai' AND "ai_agents"."model" = E'@cf/zai-org/glm-4.7-flash'),
	CONSTRAINT "ai_agents_guardrails_shape_check" CHECK (jsonb_typeof("ai_agents"."guardrails") = 'object'
				AND ("ai_agents"."guardrails" - 'version' - 'blockedTopics' - 'fallbackMessage') = '{}'::jsonb
				AND "ai_agents"."guardrails"->>'version' = '1'
				AND jsonb_typeof("ai_agents"."guardrails"->'blockedTopics') = 'array'
				AND jsonb_array_length("ai_agents"."guardrails"->'blockedTopics') <= 100
				AND NOT jsonb_path_exists(
					"ai_agents"."guardrails"->'blockedTopics',
					'$[*] ? (@.type() != "string" || @ like_regex "^$" || @ like_regex "^.{121}" flag "s")'
				)
				AND jsonb_typeof("ai_agents"."guardrails"->'fallbackMessage') = 'string'
				AND length("ai_agents"."guardrails"->>'fallbackMessage') BETWEEN 1 AND 1000),
	CONSTRAINT "ai_agents_handoff_shape_check" CHECK (jsonb_typeof("ai_agents"."handoff_strategy") = 'object'
				AND ("ai_agents"."handoff_strategy" - 'version' - 'keywords' - 'confidenceThreshold') = '{}'::jsonb
				AND "ai_agents"."handoff_strategy"->>'version' = '1'
				AND jsonb_typeof("ai_agents"."handoff_strategy"->'keywords') = 'array'
				AND jsonb_array_length("ai_agents"."handoff_strategy"->'keywords') <= 100
				AND NOT jsonb_path_exists(
					"ai_agents"."handoff_strategy"->'keywords',
					'$[*] ? (@.type() != "string" || @ like_regex "^$" || @ like_regex "^.{121}" flag "s")'
				)
				AND jsonb_typeof("ai_agents"."handoff_strategy"->'confidenceThreshold') = 'number'
				AND ("ai_agents"."handoff_strategy"->>'confidenceThreshold')::real BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "ai_knowledge_bases" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"embedding_provider" text DEFAULT 'openai' NOT NULL,
	"embedding_model" text DEFAULT 'text-embedding-3-small' NOT NULL,
	"embedding_dimensions" integer DEFAULT 1536 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_knowledge_bases_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "ai_knowledge_bases_embedding_registry_check" CHECK ("ai_knowledge_bases"."embedding_provider" = E'openai' AND "ai_knowledge_bases"."embedding_model" = E'text-embedding-3-small' AND "ai_knowledge_bases"."embedding_dimensions" = 1536)
);
--> statement-breakpoint
CREATE TABLE "ai_knowledge_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"kb_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"chunk_index" integer NOT NULL,
	"token_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_knowledge_chunks_counts_nonnegative_check" CHECK ("ai_knowledge_chunks"."chunk_index" >= 0 AND ("ai_knowledge_chunks"."token_count" IS NULL OR "ai_knowledge_chunks"."token_count" >= 0)),
	CONSTRAINT "ai_knowledge_chunks_content_hash_check" CHECK ("ai_knowledge_chunks"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "ai_knowledge_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"kb_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"source_type" text NOT NULL,
	"source_url" text,
	"source_media_id" text,
	"source_text" text,
	"title" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"last_crawled_at" timestamp with time zone,
	"content_hash" text,
	"last_error_code" text,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_knowledge_documents_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "ai_knowledge_documents_source_type_check" CHECK ("ai_knowledge_documents"."source_type" IN ('url', 'media', 'text')),
	CONSTRAINT "ai_knowledge_documents_source_check" CHECK (("ai_knowledge_documents"."source_type" = 'url' AND "ai_knowledge_documents"."source_url" IS NOT NULL AND "ai_knowledge_documents"."source_media_id" IS NULL AND "ai_knowledge_documents"."source_text" IS NULL) OR ("ai_knowledge_documents"."source_type" = 'media' AND "ai_knowledge_documents"."source_url" IS NULL AND "ai_knowledge_documents"."source_media_id" IS NOT NULL AND "ai_knowledge_documents"."source_text" IS NULL) OR ("ai_knowledge_documents"."source_type" = 'text' AND "ai_knowledge_documents"."source_url" IS NULL AND "ai_knowledge_documents"."source_media_id" IS NULL AND "ai_knowledge_documents"."source_text" IS NOT NULL)),
	CONSTRAINT "ai_knowledge_documents_status_check" CHECK ("ai_knowledge_documents"."status" IN ('pending', 'in_flight', 'ready', 'retryable_failure', 'terminal_failure')),
	CONSTRAINT "ai_knowledge_documents_attempt_count_check" CHECK ("ai_knowledge_documents"."attempt_count" BETWEEN 0 AND 8),
	CONSTRAINT "ai_knowledge_documents_deadline_check" CHECK ("ai_knowledge_documents"."deadline_at" > "ai_knowledge_documents"."created_at"),
	CONSTRAINT "ai_knowledge_documents_lease_check" CHECK (("ai_knowledge_documents"."status" = 'in_flight' AND "ai_knowledge_documents"."attempt_id" IS NOT NULL AND "ai_knowledge_documents"."claimed_at" IS NOT NULL AND "ai_knowledge_documents"."lease_expires_at" > "ai_knowledge_documents"."claimed_at") OR ("ai_knowledge_documents"."status" <> 'in_flight' AND "ai_knowledge_documents"."attempt_id" IS NULL AND "ai_knowledge_documents"."claimed_at" IS NULL AND "ai_knowledge_documents"."lease_expires_at" IS NULL)),
	CONSTRAINT "ai_knowledge_documents_terminal_check" CHECK (("ai_knowledge_documents"."status" = 'pending' AND "ai_knowledge_documents"."completed_at" IS NULL AND "ai_knowledge_documents"."last_error_code" IS NULL AND "ai_knowledge_documents"."last_error" IS NULL AND "ai_knowledge_documents"."content_hash" IS NULL)
				OR ("ai_knowledge_documents"."status" = 'in_flight' AND "ai_knowledge_documents"."completed_at" IS NULL AND "ai_knowledge_documents"."last_error_code" IS NULL AND "ai_knowledge_documents"."last_error" IS NULL)
				OR ("ai_knowledge_documents"."status" = 'retryable_failure' AND "ai_knowledge_documents"."completed_at" IS NULL AND "ai_knowledge_documents"."last_error_code" IS NOT NULL AND "ai_knowledge_documents"."last_error" IS NOT NULL)
				OR ("ai_knowledge_documents"."status" = 'ready' AND "ai_knowledge_documents"."completed_at" IS NOT NULL AND "ai_knowledge_documents"."last_crawled_at" IS NOT NULL AND "ai_knowledge_documents"."content_hash" IS NOT NULL AND "ai_knowledge_documents"."last_error_code" IS NULL AND "ai_knowledge_documents"."last_error" IS NULL)
				OR ("ai_knowledge_documents"."status" = 'terminal_failure' AND "ai_knowledge_documents"."completed_at" IS NOT NULL AND "ai_knowledge_documents"."last_error_code" IS NOT NULL AND "ai_knowledge_documents"."last_error" IS NOT NULL)),
	CONSTRAINT "ai_knowledge_documents_content_hash_check" CHECK ("ai_knowledge_documents"."content_hash" IS NULL OR "ai_knowledge_documents"."content_hash" ~ '^[0-9a-f]{64}$')
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
	CONSTRAINT "api_request_logs_id_safe_integer_check" CHECK ("api_request_logs"."id" BETWEEN 1 AND 9007199254740991),
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
	"organizationId" text NOT NULL,
	"principalId" text NOT NULL,
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
	"credentialVersion" text,
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
	"desired_active" boolean DEFAULT true NOT NULL,
	"delete_after_sync" boolean DEFAULT false NOT NULL,
	"sync_revision" integer DEFAULT 0 NOT NULL,
	"last_synced_revision" integer DEFAULT 0 NOT NULL,
	"sync_attempts" integer DEFAULT 0 NOT NULL,
	"sync_dispatch_generation" integer DEFAULT 0 NOT NULL,
	"sync_next_attempt_at" timestamp with time zone DEFAULT now(),
	"sync_lease_expires_at" timestamp with time zone,
	"sync_started_at" timestamp with time zone,
	"sync_request_may_have_been_sent_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"sync_error" text,
	"sync_error_class" text,
	"sync_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_bindings_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "automation_bindings_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "automation_bindings_status_check" CHECK ("automation_bindings"."status" IN ('active', 'paused', 'pending_sync', 'sync_failed', 'inactive')),
	CONSTRAINT "automation_bindings_sync_counters_check" CHECK ("automation_bindings"."sync_revision" >= 0
				AND "automation_bindings"."last_synced_revision" >= 0
				AND "automation_bindings"."last_synced_revision" <= "automation_bindings"."sync_revision"
				AND "automation_bindings"."sync_attempts" >= 0
				AND "automation_bindings"."sync_dispatch_generation" >= 0),
	CONSTRAINT "automation_bindings_sync_claim_check" CHECK (("automation_bindings"."sync_lease_expires_at" IS NULL AND "automation_bindings"."sync_started_at" IS NULL)
				OR ("automation_bindings"."sync_lease_expires_at" IS NOT NULL
					AND ("automation_bindings"."sync_started_at" IS NULL
						OR "automation_bindings"."sync_started_at" <= "automation_bindings"."sync_lease_expires_at"))),
	CONSTRAINT "automation_bindings_sync_error_class_check" CHECK ("automation_bindings"."sync_error_class" IS NULL
				OR "automation_bindings"."sync_error_class" IN ('transient', 'permanent', 'unknown')),
	CONSTRAINT "automation_bindings_sync_error_tuple_check" CHECK (("automation_bindings"."sync_error" IS NULL AND "automation_bindings"."sync_error_at" IS NULL)
				OR ("automation_bindings"."sync_error" IS NOT NULL AND "automation_bindings"."sync_error_at" IS NOT NULL)),
	CONSTRAINT "automation_bindings_sync_boundary_check" CHECK ("automation_bindings"."sync_request_may_have_been_sent_at" IS NULL
				OR "automation_bindings"."sync_started_at" IS NOT NULL
				OR "automation_bindings"."sync_error_class" = 'unknown'),
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
CREATE TABLE "automation_conversion_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"automation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"occurrence_id" text NOT NULL,
	"event_name" text NOT NULL,
	"value" text,
	"currency" varchar(3),
	"channel" text NOT NULL,
	"social_account_id" text,
	"conversation_id" text,
	"event_depth" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"dispatch_status" text DEFAULT 'pending' NOT NULL,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"dispatch_lease_token" integer DEFAULT 0 NOT NULL,
	"dispatch_lease_expires_at" timestamp with time zone,
	"next_dispatch_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatch_deadline_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP + interval '7 days' NOT NULL,
	"dispatched_at" timestamp with time zone,
	"last_dispatch_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_conversion_events_channel_check" CHECK ("automation_conversion_events"."channel" IN ('instagram', 'facebook', 'whatsapp', 'telegram')),
	CONSTRAINT "automation_conversion_events_dispatch_status_check" CHECK ("automation_conversion_events"."dispatch_status" IN ('pending', 'processing', 'succeeded', 'manual_review')),
	CONSTRAINT "automation_conversion_events_dispatch_counters_check" CHECK ("automation_conversion_events"."event_depth" >= 0
				AND "automation_conversion_events"."dispatch_attempts" >= 0
				AND "automation_conversion_events"."dispatch_lease_token" >= 0),
	CONSTRAINT "automation_conversion_events_dispatch_state_check" CHECK (("automation_conversion_events"."dispatch_status" = 'pending'
						AND "automation_conversion_events"."dispatch_lease_expires_at" IS NULL
						AND "automation_conversion_events"."dispatched_at" IS NULL)
					OR ("automation_conversion_events"."dispatch_status" = 'processing'
						AND "automation_conversion_events"."dispatch_attempts" > 0
						AND "automation_conversion_events"."dispatch_lease_expires_at" IS NOT NULL
						AND "automation_conversion_events"."dispatched_at" IS NULL)
					OR ("automation_conversion_events"."dispatch_status" = 'succeeded'
						AND "automation_conversion_events"."dispatch_lease_expires_at" IS NULL
						AND "automation_conversion_events"."dispatched_at" IS NOT NULL
						AND "automation_conversion_events"."last_dispatch_error" IS NULL)
					OR ("automation_conversion_events"."dispatch_status" = 'manual_review'
						AND "automation_conversion_events"."dispatch_lease_expires_at" IS NULL
						AND "automation_conversion_events"."dispatched_at" IS NULL
						AND "automation_conversion_events"."last_dispatch_error" IS NOT NULL)),
	CONSTRAINT "automation_conversion_events_dispatch_timestamps_check" CHECK ("automation_conversion_events"."updated_at" >= "automation_conversion_events"."created_at"
				AND "automation_conversion_events"."dispatch_deadline_at" > "automation_conversion_events"."created_at"
				AND "automation_conversion_events"."next_dispatch_at" >= "automation_conversion_events"."created_at"
				AND ("automation_conversion_events"."dispatch_lease_expires_at" IS NULL
					OR "automation_conversion_events"."dispatch_lease_expires_at" >= "automation_conversion_events"."created_at")
				AND ("automation_conversion_events"."dispatched_at" IS NULL
					OR "automation_conversion_events"."dispatched_at" >= "automation_conversion_events"."created_at"))
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
	CONSTRAINT "automation_effects_kind_check" CHECK ("automation_effects"."kind" IN ('message_block', 'http_request', 'automation_action')),
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
						AND "automation_effects"."request_may_have_been_sent_at" IS NOT NULL
						AND "automation_effects"."completed_at" IS NOT NULL)),
	CONSTRAINT "automation_effects_timestamp_order_check" CHECK ("automation_effects"."updated_at" >= "automation_effects"."created_at"
				AND ("automation_effects"."request_may_have_been_sent_at" IS NULL OR "automation_effects"."request_may_have_been_sent_at" >= "automation_effects"."created_at")
				AND ("automation_effects"."completed_at" IS NULL OR "automation_effects"."completed_at" >= "automation_effects"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "automation_entrypoint_daily_counts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"entrypoint_id" text NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_entrypoint_daily_counts_count_check" CHECK ("automation_entrypoint_daily_counts"."count" >= 0)
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
	"daily_cap" integer,
	"priority" integer DEFAULT 100 NOT NULL,
	"specificity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_entrypoints_id_automation_org_uniq" UNIQUE("id","automation_id","organization_id"),
	CONSTRAINT "automation_entrypoints_id_automation_org_scope_uniq" UNIQUE("id","automation_id","organization_id","scope_key"),
	CONSTRAINT "automation_entrypoints_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "automation_entrypoints_kind_check" CHECK ("automation_entrypoints"."kind" IN ('dm_received', 'comment_created', 'story_reply', 'story_mention', 'live_comment', 'ad_click', 'ref_link_click', 'share_to_dm', 'schedule', 'field_changed', 'tag_applied', 'tag_removed', 'conversion_event', 'webhook_inbound')),
	CONSTRAINT "automation_entrypoints_kind_identity_config_check" CHECK (jsonb_typeof("automation_entrypoints"."config") = 'object'
				AND ("automation_entrypoints"."kind" NOT IN (
						'ref_link_click',
						'schedule',
						'field_changed',
						'tag_applied',
						'tag_removed',
						'conversion_event'
					)
					OR "automation_entrypoints"."social_account_id" IS NULL)
				AND CASE "automation_entrypoints"."kind"
					WHEN 'dm_received' THEN
						"automation_entrypoints"."config" - ARRAY['keywords', 'match_mode', 'case_sensitive', 'first_message_only'] = '{}'::jsonb
						AND (NOT ("automation_entrypoints"."config" ? 'match_mode') OR "automation_entrypoints"."config"->>'match_mode' IN ('exact', 'contains', 'regex'))
						AND (NOT ("automation_entrypoints"."config" ? 'case_sensitive') OR jsonb_typeof("automation_entrypoints"."config"->'case_sensitive') = 'boolean')
						AND (NOT ("automation_entrypoints"."config" ? 'first_message_only') OR jsonb_typeof("automation_entrypoints"."config"->'first_message_only') = 'boolean')
						AND (NOT ("automation_entrypoints"."config" ? 'keywords') OR jsonb_typeof("automation_entrypoints"."config"->'keywords') = 'array')
					WHEN 'comment_created' THEN
						"automation_entrypoints"."config" - ARRAY['keywords', 'match_mode', 'case_sensitive', 'post_ids', 'include_replies'] = '{}'::jsonb
						AND (NOT ("automation_entrypoints"."config" ? 'match_mode') OR "automation_entrypoints"."config"->>'match_mode' IN ('exact', 'contains', 'regex'))
						AND (NOT ("automation_entrypoints"."config" ? 'case_sensitive') OR jsonb_typeof("automation_entrypoints"."config"->'case_sensitive') = 'boolean')
						AND (NOT ("automation_entrypoints"."config" ? 'post_ids') OR "automation_entrypoints"."config"->'post_ids' = 'null'::jsonb OR jsonb_typeof("automation_entrypoints"."config"->'post_ids') = 'array')
						AND (NOT ("automation_entrypoints"."config" ? 'include_replies') OR jsonb_typeof("automation_entrypoints"."config"->'include_replies') = 'boolean')
						AND (NOT ("automation_entrypoints"."config" ? 'keywords') OR jsonb_typeof("automation_entrypoints"."config"->'keywords') = 'array')
					WHEN 'story_reply' THEN
						"automation_entrypoints"."config" - ARRAY['keywords', 'match_mode', 'case_sensitive', 'story_ids'] = '{}'::jsonb
						AND (NOT ("automation_entrypoints"."config" ? 'match_mode') OR "automation_entrypoints"."config"->>'match_mode' IN ('exact', 'contains', 'regex'))
						AND (NOT ("automation_entrypoints"."config" ? 'case_sensitive') OR jsonb_typeof("automation_entrypoints"."config"->'case_sensitive') = 'boolean')
						AND (NOT ("automation_entrypoints"."config" ? 'story_ids') OR "automation_entrypoints"."config"->'story_ids' = 'null'::jsonb OR jsonb_typeof("automation_entrypoints"."config"->'story_ids') = 'array')
						AND (NOT ("automation_entrypoints"."config" ? 'keywords') OR jsonb_typeof("automation_entrypoints"."config"->'keywords') = 'array')
					WHEN 'story_mention' THEN
						"automation_entrypoints"."config" - ARRAY['keywords', 'match_mode', 'case_sensitive', 'story_ids'] = '{}'::jsonb
						AND (NOT ("automation_entrypoints"."config" ? 'match_mode') OR "automation_entrypoints"."config"->>'match_mode' IN ('exact', 'contains', 'regex'))
						AND (NOT ("automation_entrypoints"."config" ? 'case_sensitive') OR jsonb_typeof("automation_entrypoints"."config"->'case_sensitive') = 'boolean')
						AND (NOT ("automation_entrypoints"."config" ? 'story_ids') OR "automation_entrypoints"."config"->'story_ids' = 'null'::jsonb OR jsonb_typeof("automation_entrypoints"."config"->'story_ids') = 'array')
						AND (NOT ("automation_entrypoints"."config" ? 'keywords') OR jsonb_typeof("automation_entrypoints"."config"->'keywords') = 'array')
					WHEN 'live_comment' THEN
						"automation_entrypoints"."config" - ARRAY['keywords', 'match_mode', 'case_sensitive'] = '{}'::jsonb
						AND (NOT ("automation_entrypoints"."config" ? 'match_mode') OR "automation_entrypoints"."config"->>'match_mode' IN ('exact', 'contains', 'regex'))
						AND (NOT ("automation_entrypoints"."config" ? 'case_sensitive') OR jsonb_typeof("automation_entrypoints"."config"->'case_sensitive') = 'boolean')
						AND (NOT ("automation_entrypoints"."config" ? 'keywords') OR jsonb_typeof("automation_entrypoints"."config"->'keywords') = 'array')
					WHEN 'ad_click' THEN
						"automation_entrypoints"."config" - 'ad_ids' = '{}'::jsonb
						AND (NOT ("automation_entrypoints"."config" ? 'ad_ids') OR "automation_entrypoints"."config"->'ad_ids' = 'null'::jsonb OR jsonb_typeof("automation_entrypoints"."config"->'ad_ids') = 'array')
					WHEN 'ref_link_click' THEN
						"automation_entrypoints"."config" ? 'ref_url_ids'
						AND "automation_entrypoints"."config" - 'ref_url_ids' = '{}'::jsonb
						AND jsonb_typeof("automation_entrypoints"."config"->'ref_url_ids') = 'array'
						AND "automation_entrypoints"."config"->'ref_url_ids' <> '[]'::jsonb
					WHEN 'share_to_dm' THEN "automation_entrypoints"."config" = '{}'::jsonb
					WHEN 'schedule' THEN
						"automation_entrypoints"."config" ?& ARRAY['cron', 'timezone']
						AND "automation_entrypoints"."config" - ARRAY['cron', 'timezone'] = '{}'::jsonb
						AND jsonb_typeof("automation_entrypoints"."config"->'cron') = 'string'
						AND length(btrim("automation_entrypoints"."config"->>'cron')) > 0
						AND jsonb_typeof("automation_entrypoints"."config"->'timezone') = 'string'
						AND length(btrim("automation_entrypoints"."config"->>'timezone')) > 0
					WHEN 'field_changed' THEN
						"automation_entrypoints"."config" ? 'field_keys'
						AND "automation_entrypoints"."config" - ARRAY['field_keys', 'from', 'to'] = '{}'::jsonb
						AND jsonb_typeof("automation_entrypoints"."config"->'field_keys') = 'array'
						AND "automation_entrypoints"."config"->'field_keys' <> '[]'::jsonb
					WHEN 'tag_applied' THEN
						"automation_entrypoints"."config" ? 'tag_ids'
						AND "automation_entrypoints"."config" - 'tag_ids' = '{}'::jsonb
						AND jsonb_typeof("automation_entrypoints"."config"->'tag_ids') = 'array'
						AND "automation_entrypoints"."config"->'tag_ids' <> '[]'::jsonb
					WHEN 'tag_removed' THEN
						"automation_entrypoints"."config" ? 'tag_ids'
						AND "automation_entrypoints"."config" - 'tag_ids' = '{}'::jsonb
						AND jsonb_typeof("automation_entrypoints"."config"->'tag_ids') = 'array'
						AND "automation_entrypoints"."config"->'tag_ids' <> '[]'::jsonb
					WHEN 'conversion_event' THEN
						"automation_entrypoints"."config" ? 'event_names'
						AND "automation_entrypoints"."config" - 'event_names' = '{}'::jsonb
						AND jsonb_typeof("automation_entrypoints"."config"->'event_names') = 'array'
						AND "automation_entrypoints"."config"->'event_names' <> '[]'::jsonb
					WHEN 'webhook_inbound' THEN
						"automation_entrypoints"."config" ?& ARRAY['webhook_slug', 'webhook_secret', 'contact_lookup']
						AND "automation_entrypoints"."config" - ARRAY['webhook_slug', 'webhook_secret', 'contact_lookup', 'payload_mapping'] = '{}'::jsonb
						AND jsonb_typeof("automation_entrypoints"."config"->'webhook_slug') = 'string'
						AND length(btrim("automation_entrypoints"."config"->>'webhook_slug')) > 0
						AND jsonb_typeof("automation_entrypoints"."config"->'webhook_secret') = 'string'
						AND length(btrim("automation_entrypoints"."config"->>'webhook_secret')) > 0
						AND jsonb_typeof("automation_entrypoints"."config"->'contact_lookup') = 'object'
						AND (NOT ("automation_entrypoints"."config" ? 'payload_mapping') OR jsonb_typeof("automation_entrypoints"."config"->'payload_mapping') = 'object')
					ELSE false
				END),
	CONSTRAINT "automation_entrypoints_status_check" CHECK ("automation_entrypoints"."status" IN ('active', 'paused', 'disabled')),
	CONSTRAINT "automation_entrypoints_numeric_check" CHECK ("automation_entrypoints"."reentry_cooldown_min" >= 0
				AND ("automation_entrypoints"."daily_cap" IS NULL OR "automation_entrypoints"."daily_cap" > 0)
				AND "automation_entrypoints"."specificity" >= 0),
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
	"result" jsonb,
	"error" jsonb,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_node_executions_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "automation_node_executions_status_check" CHECK ("automation_node_executions"."status" IN ('claimed', 'succeeded', 'failed', 'unknown')),
	CONSTRAINT "automation_node_executions_counters_nonnegative_check" CHECK ("automation_node_executions"."run_revision" >= 0 AND "automation_node_executions"."visit_ordinal" >= 0 AND "automation_node_executions"."attempts" >= 0 AND "automation_node_executions"."lease_token" >= 0),
	CONSTRAINT "automation_node_executions_state_fields_check" CHECK (("automation_node_executions"."status" = 'claimed'
					AND "automation_node_executions"."lease_expires_at" IS NOT NULL
					AND "automation_node_executions"."completed_at" IS NULL)
				OR ("automation_node_executions"."status" IN ('succeeded', 'failed', 'unknown')
					AND "automation_node_executions"."lease_expires_at" IS NULL
					AND "automation_node_executions"."completed_at" IS NOT NULL)),
	CONSTRAINT "automation_node_executions_timestamp_order_check" CHECK ("automation_node_executions"."updated_at" >= "automation_node_executions"."claimed_at"
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
	CONSTRAINT "automation_runs_id_automation_org_scope_uniq" UNIQUE("id","automation_id","organization_id","scope_key"),
	CONSTRAINT "automation_runs_id_auto_contact_org_scope_uniq" UNIQUE("id","automation_id","contact_id","organization_id","scope_key"),
	CONSTRAINT "automation_runs_revision_nonnegative_check" CHECK ("automation_runs"."revision" >= 0),
	CONSTRAINT "automation_runs_waiting_for_check" CHECK ("automation_runs"."waiting_for" IS NULL OR "automation_runs"."waiting_for" IN ('input', 'delay', 'inbound_event', 'external_event')),
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
	"organization_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"run_id" text,
	"job_type" text NOT NULL,
	"automation_id" text NOT NULL,
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
	CONSTRAINT "automation_scheduled_jobs_type_check" CHECK ("automation_scheduled_jobs"."job_type" IN ('resume_run', 'input_timeout', 'event_timeout', 'internal_event', 'scheduled_trigger', 'webhook_reception_failure')),
	CONSTRAINT "automation_scheduled_jobs_parent_union_check" CHECK (("automation_scheduled_jobs"."job_type" IN ('resume_run', 'input_timeout', 'event_timeout', 'internal_event')
					AND "automation_scheduled_jobs"."run_id" IS NOT NULL
					AND "automation_scheduled_jobs"."entrypoint_id" IS NULL)
				OR ("automation_scheduled_jobs"."job_type" IN ('scheduled_trigger', 'webhook_reception_failure')
					AND "automation_scheduled_jobs"."run_id" IS NULL
					AND "automation_scheduled_jobs"."entrypoint_id" IS NOT NULL)),
	CONSTRAINT "automation_scheduled_jobs_internal_event_payload_check" CHECK ("automation_scheduled_jobs"."job_type" <> 'internal_event'
				OR (
					jsonb_typeof("automation_scheduled_jobs"."payload") = 'object'
					AND "automation_scheduled_jobs"."payload"->>'version' = '1'
					AND "automation_scheduled_jobs"."payload"->>'kind' IN ('tag_applied', 'tag_removed', 'field_changed')
					AND length(btrim("automation_scheduled_jobs"."payload"->>'action_id')) BETWEEN 1 AND 512
					AND jsonb_typeof("automation_scheduled_jobs"."payload"->'event_depth') = 'number'
					AND ("automation_scheduled_jobs"."payload"->>'event_depth')::integer BETWEEN 1 AND 5
					AND (
						(
							"automation_scheduled_jobs"."payload"->>'kind' IN ('tag_applied', 'tag_removed')
							AND length(btrim("automation_scheduled_jobs"."payload"->>'tag_id')) BETWEEN 1 AND 512
						)
						OR (
							"automation_scheduled_jobs"."payload"->>'kind' = 'field_changed'
							AND length(btrim("automation_scheduled_jobs"."payload"->>'field_key')) BETWEEN 1 AND 512
							AND "automation_scheduled_jobs"."payload" ? 'field_value_before'
							AND "automation_scheduled_jobs"."payload" ? 'field_value_after'
						)
					)
				)),
	CONSTRAINT "automation_scheduled_jobs_lease_state_check" CHECK (("automation_scheduled_jobs"."status" = 'processing'
					AND "automation_scheduled_jobs"."claimed_at" IS NOT NULL
					AND "automation_scheduled_jobs"."lease_expires_at" IS NOT NULL)
				OR ("automation_scheduled_jobs"."status" <> 'processing' AND "automation_scheduled_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "automation_scheduled_jobs_unknown_boundary_check" CHECK (("automation_scheduled_jobs"."effect_started_at" IS NULL
					OR "automation_scheduled_jobs"."job_type" = 'webhook_reception_failure')
				AND ("automation_scheduled_jobs"."status" <> 'unknown'
					OR ("automation_scheduled_jobs"."job_type" = 'webhook_reception_failure'
						AND "automation_scheduled_jobs"."effect_started_at" IS NOT NULL)))
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_secrets_kind_check" CHECK ("automation_secrets"."kind" IN ('webhook_out', 'http_request'))
);
--> statement-breakpoint
CREATE TABLE "automation_step_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"automation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"node_key" text NOT NULL,
	"node_kind" text NOT NULL,
	"entered_via_port_key" text,
	"exited_via_port_key" text,
	"outcome" text NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"error" jsonb,
	"executed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "automation_step_runs_node_kind_check" CHECK ("automation_step_runs"."node_kind" IN ('message', 'input', 'delay', 'wait_event', 'condition', 'randomizer', 'action_group', 'http_request', 'start_automation', 'social_profile_check', 'goto', 'end', 'unknown')),
	CONSTRAINT "automation_step_runs_outcome_check" CHECK ("automation_step_runs"."outcome" IN ('ok', 'wait_input', 'wait_delay', 'wait_event', 'end', 'failed', 'graph_changed')),
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
CREATE TABLE "billing_operation_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"billing_operation_id" text NOT NULL,
	"revision" integer NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_invoice_id" text NOT NULL,
	"stripe_invoice_item_id" text,
	"idempotency_key" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'usd' NOT NULL,
	"description" text NOT NULL,
	"request_may_have_been_sent_at" timestamp with time zone,
	"provider_evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "billing_operation_attempts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "billing_operation_attempts_status_check" CHECK ("billing_operation_attempts"."status" IN ('prepared', 'requesting', 'unknown', 'succeeded', 'rejected', 'written_off')),
	CONSTRAINT "billing_operation_attempts_numeric_check" CHECK ("billing_operation_attempts"."revision" > 0 AND "billing_operation_attempts"."amount_cents" >= 0),
	CONSTRAINT "billing_operation_attempts_currency_check" CHECK ("billing_operation_attempts"."currency" = 'usd'),
	CONSTRAINT "billing_operation_attempts_state_shape_check" CHECK (("billing_operation_attempts"."status" = 'prepared'
					AND "billing_operation_attempts"."request_may_have_been_sent_at" IS NULL
					AND "billing_operation_attempts"."stripe_invoice_item_id" IS NULL
					AND "billing_operation_attempts"."provider_evidence" IS NULL
					AND "billing_operation_attempts"."resolved_at" IS NULL)
				OR ("billing_operation_attempts"."status" = 'requesting'
					AND "billing_operation_attempts"."request_may_have_been_sent_at" IS NOT NULL
					AND "billing_operation_attempts"."stripe_invoice_item_id" IS NULL
					AND "billing_operation_attempts"."provider_evidence" IS NULL
					AND "billing_operation_attempts"."resolved_at" IS NULL)
				OR ("billing_operation_attempts"."status" = 'unknown'
					AND "billing_operation_attempts"."request_may_have_been_sent_at" IS NOT NULL
					AND "billing_operation_attempts"."stripe_invoice_item_id" IS NULL
					AND "billing_operation_attempts"."resolved_at" IS NULL)
				OR ("billing_operation_attempts"."status" = 'succeeded'
					AND "billing_operation_attempts"."request_may_have_been_sent_at" IS NOT NULL
					AND "billing_operation_attempts"."stripe_invoice_item_id" IS NOT NULL
					AND "billing_operation_attempts"."provider_evidence" IS NOT NULL
					AND "billing_operation_attempts"."resolved_at" IS NOT NULL)
				OR ("billing_operation_attempts"."status" IN ('rejected', 'written_off')
					AND "billing_operation_attempts"."provider_evidence" IS NOT NULL
					AND "billing_operation_attempts"."resolved_at" IS NOT NULL)),
	CONSTRAINT "billing_operation_attempts_timestamp_order_check" CHECK (("billing_operation_attempts"."request_may_have_been_sent_at" IS NULL OR "billing_operation_attempts"."request_may_have_been_sent_at" >= "billing_operation_attempts"."created_at")
				AND ("billing_operation_attempts"."resolved_at" IS NULL OR "billing_operation_attempts"."resolved_at" >= "billing_operation_attempts"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "billing_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"billing_period_id" text NOT NULL,
	"kind" text DEFAULT 'cycle' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_invoice_id" text,
	"stripe_invoice_item_id" text,
	"invoice_idempotency_key" text,
	"idempotency_key" text NOT NULL,
	"attempt_revision" integer DEFAULT 1 NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'usd' NOT NULL,
	"description" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"last_error_class" text,
	"operator_retry_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "billing_operations_invoice_idempotency_key_unique" UNIQUE("invoice_idempotency_key"),
	CONSTRAINT "billing_operations_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "billing_operations_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "billing_operations_status_check" CHECK ("billing_operations"."status" IN ('invoice_preparing', 'invoice_unknown', 'pending', 'processing', 'failed', 'unknown', 'succeeded', 'terminal_failed', 'manual_review', 'released', 'written_off')),
	CONSTRAINT "billing_operations_kind_check" CHECK ("billing_operations"."kind" IN ('cycle', 'catchup')),
	CONSTRAINT "billing_operations_kind_shape_check" CHECK (("billing_operations"."kind" = 'cycle'
					AND "billing_operations"."stripe_invoice_id" IS NOT NULL
					AND "billing_operations"."invoice_idempotency_key" IS NULL
					AND "billing_operations"."status" NOT IN ('invoice_preparing', 'invoice_unknown'))
				OR ("billing_operations"."kind" = 'catchup'
					AND "billing_operations"."invoice_idempotency_key" IS NOT NULL
					AND (("billing_operations"."status" IN ('invoice_preparing', 'invoice_unknown')
							AND "billing_operations"."stripe_invoice_id" IS NULL)
						OR ("billing_operations"."status" IN ('pending', 'processing', 'failed', 'unknown', 'succeeded', 'terminal_failed', 'released')
							AND "billing_operations"."stripe_invoice_id" IS NOT NULL)
						OR "billing_operations"."status" IN ('manual_review', 'written_off')))),
	CONSTRAINT "billing_operations_numeric_check" CHECK ("billing_operations"."amount_cents" >= 0
				AND "billing_operations"."attempt_revision" > 0
				AND "billing_operations"."attempts" >= 0
				AND "billing_operations"."lease_token" >= 0),
	CONSTRAINT "billing_operations_currency_check" CHECK ("billing_operations"."currency" = 'usd'),
	CONSTRAINT "billing_operations_lease_state_check" CHECK (("billing_operations"."status" = 'processing' AND "billing_operations"."lease_expires_at" IS NOT NULL)
				OR ("billing_operations"."status" <> 'processing' AND "billing_operations"."lease_expires_at" IS NULL)),
	CONSTRAINT "billing_operations_completion_check" CHECK (("billing_operations"."status" = 'succeeded'
					AND "billing_operations"."stripe_invoice_item_id" IS NOT NULL
					AND "billing_operations"."completed_at" IS NOT NULL)
				OR ("billing_operations"."status" IN ('terminal_failed', 'manual_review', 'released', 'written_off')
					AND "billing_operations"."completed_at" IS NOT NULL)
				OR ("billing_operations"."status" NOT IN ('succeeded', 'terminal_failed', 'manual_review', 'released', 'written_off')
					AND "billing_operations"."completed_at" IS NULL)),
	CONSTRAINT "billing_operations_operator_retry_check" CHECK ("billing_operations"."operator_retry_requested_at" IS NULL
				OR ("billing_operations"."status" = 'unknown'
					AND "billing_operations"."completed_at" IS NULL
					AND "billing_operations"."lease_expires_at" IS NULL)),
	CONSTRAINT "billing_operations_error_class_check" CHECK ("billing_operations"."last_error_class" IS NULL
				OR "billing_operations"."last_error_class" IN ('transient', 'unknown', 'permanent', 'retry_exhausted', 'age_exhausted')),
	CONSTRAINT "billing_operations_timestamp_order_check" CHECK ("billing_operations"."updated_at" >= "billing_operations"."created_at"
				AND ("billing_operations"."operator_retry_requested_at" IS NULL OR "billing_operations"."operator_retry_requested_at" >= "billing_operations"."created_at")
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
	"last_error_class" text,
	"processed_at" timestamp with time zone,
	"manual_review_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_outbox_kind_check" CHECK ("billing_outbox"."kind" IN ('auth_cache.refresh', 'payment_failed.notify', 'subscription.cancel')),
	CONSTRAINT "billing_outbox_status_check" CHECK ("billing_outbox"."status" IN ('pending', 'processing', 'succeeded', 'failed', 'manual_review')),
	CONSTRAINT "billing_outbox_counters_nonnegative_check" CHECK ("billing_outbox"."attempts" >= 0 AND "billing_outbox"."lease_token" >= 0),
	CONSTRAINT "billing_outbox_lease_state_check" CHECK (("billing_outbox"."status" = 'processing' AND "billing_outbox"."lease_expires_at" IS NOT NULL)
				OR ("billing_outbox"."status" <> 'processing' AND "billing_outbox"."lease_expires_at" IS NULL)),
	CONSTRAINT "billing_outbox_completion_check" CHECK (("billing_outbox"."status" = 'succeeded'
					AND "billing_outbox"."processed_at" IS NOT NULL
					AND "billing_outbox"."manual_review_at" IS NULL)
				OR ("billing_outbox"."status" = 'manual_review'
					AND "billing_outbox"."processed_at" IS NULL
					AND "billing_outbox"."manual_review_at" IS NOT NULL)
				OR ("billing_outbox"."status" NOT IN ('succeeded', 'manual_review')
					AND "billing_outbox"."processed_at" IS NULL
					AND "billing_outbox"."manual_review_at" IS NULL)),
	CONSTRAINT "billing_outbox_error_class_check" CHECK ("billing_outbox"."last_error_class" IS NULL
				OR "billing_outbox"."last_error_class" IN ('transient', 'permanent', 'retry_exhausted')),
	CONSTRAINT "billing_outbox_timestamp_order_check" CHECK ("billing_outbox"."updated_at" >= "billing_outbox"."created_at"
				AND ("billing_outbox"."processed_at" IS NULL OR "billing_outbox"."processed_at" >= "billing_outbox"."created_at")
				AND ("billing_outbox"."manual_review_at" IS NULL OR "billing_outbox"."manual_review_at" >= "billing_outbox"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "billing_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source" text NOT NULL,
	"billable" boolean NOT NULL,
	"quota_mode" text NOT NULL,
	"provider_cycle_anchor" timestamp with time zone NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_product_id" text,
	"stripe_price_id" text,
	"stripe_price_role" text,
	"rate_card_version" text,
	"tax_behavior" text,
	"tax_code" text,
	"discountable" boolean,
	"cycle_allowance" bigint,
	"included_units" bigint,
	"price_per_thousand_units_cents" integer,
	"base_price_cents" integer DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'usd' NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"committed_units_snapshot" bigint,
	"effective_included_units_snapshot" bigint,
	"overage_units_snapshot" bigint,
	"amount_cents_snapshot" integer,
	"invoice_id" text,
	"stripe_invoice_id" text,
	"release_count" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"written_off_at" timestamp with time zone,
	"write_off_reason" text,
	"write_off_evidence" jsonb,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_periods_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "billing_periods_id_org_window_uniq" UNIQUE("id","organization_id","period_start","period_end"),
	CONSTRAINT "billing_periods_window_check" CHECK ("billing_periods"."period_end" > "billing_periods"."period_start"
				AND "billing_periods"."provider_cycle_anchor" <= "billing_periods"."period_start"),
	CONSTRAINT "billing_periods_source_check" CHECK ("billing_periods"."source" IN ('stripe', 'complimentary')),
	CONSTRAINT "billing_periods_stripe_price_role_check" CHECK ("billing_periods"."stripe_price_role" IS NULL OR "billing_periods"."stripe_price_role" IN ('base')),
	CONSTRAINT "billing_periods_agreement_shape_check" CHECK (("billing_periods"."source" = 'stripe'
					AND "billing_periods"."stripe_customer_id" IS NOT NULL
					AND "billing_periods"."stripe_subscription_id" IS NOT NULL
					AND "billing_periods"."stripe_product_id" IS NOT NULL
					AND "billing_periods"."stripe_price_id" IS NOT NULL
					AND "billing_periods"."stripe_price_role" = 'base'
					AND "billing_periods"."rate_card_version" IS NOT NULL
					AND "billing_periods"."tax_behavior" IN ('inclusive', 'exclusive', 'unspecified')
					AND "billing_periods"."discountable" IS NOT NULL)
				OR ("billing_periods"."source" = 'complimentary'
					AND "billing_periods"."stripe_customer_id" IS NULL
					AND "billing_periods"."stripe_subscription_id" IS NULL
					AND "billing_periods"."stripe_product_id" IS NULL
					AND "billing_periods"."stripe_price_id" IS NULL
					AND "billing_periods"."stripe_price_role" IS NULL
					AND "billing_periods"."rate_card_version" IS NULL
					AND "billing_periods"."tax_behavior" IS NULL
					AND "billing_periods"."tax_code" IS NULL
					AND "billing_periods"."discountable" IS NULL)),
	CONSTRAINT "billing_periods_quota_mode_check" CHECK ("billing_periods"."quota_mode" IN ('hard', 'metered', 'unlimited')),
	CONSTRAINT "billing_periods_quota_shape_check" CHECK (("billing_periods"."quota_mode" = 'unlimited'
					AND "billing_periods"."cycle_allowance" IS NULL
					AND "billing_periods"."included_units" IS NULL)
				OR ("billing_periods"."quota_mode" IN ('hard', 'metered')
					AND "billing_periods"."cycle_allowance" IS NOT NULL
					AND "billing_periods"."cycle_allowance" >= 0
					AND "billing_periods"."included_units" IS NOT NULL
					AND "billing_periods"."included_units" >= 0)),
	CONSTRAINT "billing_periods_billing_shape_check" CHECK (("billing_periods"."billable"
					AND "billing_periods"."source" = 'stripe'
					AND "billing_periods"."quota_mode" = 'metered'
					AND "billing_periods"."price_per_thousand_units_cents" IS NOT NULL
					AND "billing_periods"."price_per_thousand_units_cents" >= 0)
				OR (NOT "billing_periods"."billable" AND "billing_periods"."price_per_thousand_units_cents" IS NULL)),
	CONSTRAINT "billing_periods_currency_check" CHECK ("billing_periods"."currency" = 'usd'),
	CONSTRAINT "billing_periods_numeric_check" CHECK ("billing_periods"."base_price_cents" >= 0
				AND "billing_periods"."release_count" BETWEEN 0 AND 1
				AND "billing_periods"."revision" >= 0
				AND ("billing_periods"."cycle_allowance" IS NULL OR "billing_periods"."cycle_allowance" <= 9007199254740991)
				AND ("billing_periods"."included_units" IS NULL OR "billing_periods"."included_units" <= 9007199254740991)
				AND ("billing_periods"."committed_units_snapshot" IS NULL OR "billing_periods"."committed_units_snapshot" BETWEEN 0 AND 9007199254740991)
				AND ("billing_periods"."effective_included_units_snapshot" IS NULL OR "billing_periods"."effective_included_units_snapshot" BETWEEN 0 AND 9007199254740991)
				AND ("billing_periods"."overage_units_snapshot" IS NULL OR "billing_periods"."overage_units_snapshot" BETWEEN 0 AND 9007199254740991)
				AND ("billing_periods"."amount_cents_snapshot" IS NULL OR "billing_periods"."amount_cents_snapshot" >= 0)),
	CONSTRAINT "billing_periods_state_check" CHECK ("billing_periods"."state" IN ('open', 'closed', 'claimed', 'settled', 'released', 'written_off', 'void')),
	CONSTRAINT "billing_periods_state_shape_check" CHECK (("billing_periods"."state" = 'open'
					AND "billing_periods"."closed_at" IS NULL
					AND "billing_periods"."claimed_at" IS NULL
					AND "billing_periods"."settled_at" IS NULL
					AND "billing_periods"."released_at" IS NULL
					AND "billing_periods"."written_off_at" IS NULL
					AND "billing_periods"."write_off_reason" IS NULL
					AND "billing_periods"."write_off_evidence" IS NULL
					AND "billing_periods"."voided_at" IS NULL
					AND "billing_periods"."committed_units_snapshot" IS NULL
					AND "billing_periods"."effective_included_units_snapshot" IS NULL
					AND "billing_periods"."overage_units_snapshot" IS NULL
					AND "billing_periods"."amount_cents_snapshot" IS NULL
					AND "billing_periods"."invoice_id" IS NULL
					AND "billing_periods"."stripe_invoice_id" IS NULL)
				OR ("billing_periods"."state" = 'closed'
					AND "billing_periods"."closed_at" IS NOT NULL
					AND "billing_periods"."claimed_at" IS NULL
					AND "billing_periods"."settled_at" IS NULL
					AND "billing_periods"."released_at" IS NULL
					AND "billing_periods"."written_off_at" IS NULL
					AND "billing_periods"."write_off_reason" IS NULL
					AND "billing_periods"."write_off_evidence" IS NULL
					AND "billing_periods"."voided_at" IS NULL
					AND "billing_periods"."committed_units_snapshot" IS NULL
					AND "billing_periods"."effective_included_units_snapshot" IS NULL
					AND "billing_periods"."overage_units_snapshot" IS NULL
					AND "billing_periods"."amount_cents_snapshot" IS NULL
					AND "billing_periods"."invoice_id" IS NULL
					AND "billing_periods"."stripe_invoice_id" IS NULL)
				OR ("billing_periods"."state" = 'claimed'
					AND "billing_periods"."closed_at" IS NOT NULL
					AND "billing_periods"."claimed_at" IS NOT NULL
					AND "billing_periods"."settled_at" IS NULL
					AND "billing_periods"."released_at" IS NULL
					AND "billing_periods"."written_off_at" IS NULL
					AND "billing_periods"."write_off_reason" IS NULL
					AND "billing_periods"."write_off_evidence" IS NULL
					AND "billing_periods"."voided_at" IS NULL
					AND "billing_periods"."committed_units_snapshot" IS NOT NULL
					AND "billing_periods"."effective_included_units_snapshot" IS NOT NULL
					AND "billing_periods"."overage_units_snapshot" IS NOT NULL
					AND "billing_periods"."amount_cents_snapshot" IS NOT NULL
					AND "billing_periods"."invoice_id" IS NULL
					AND "billing_periods"."stripe_invoice_id" IS NULL)
				OR ("billing_periods"."state" = 'settled'
					AND "billing_periods"."closed_at" IS NOT NULL
					AND "billing_periods"."claimed_at" IS NOT NULL
					AND "billing_periods"."settled_at" IS NOT NULL
					AND "billing_periods"."released_at" IS NULL
					AND "billing_periods"."written_off_at" IS NULL
					AND "billing_periods"."write_off_reason" IS NULL
					AND "billing_periods"."write_off_evidence" IS NULL
					AND "billing_periods"."voided_at" IS NULL
					AND "billing_periods"."committed_units_snapshot" IS NOT NULL
					AND "billing_periods"."effective_included_units_snapshot" IS NOT NULL
					AND "billing_periods"."overage_units_snapshot" IS NOT NULL
					AND "billing_periods"."amount_cents_snapshot" IS NOT NULL
					AND (
						("billing_periods"."amount_cents_snapshot" = 0
							AND "billing_periods"."invoice_id" IS NULL
							AND "billing_periods"."stripe_invoice_id" IS NULL)
						OR ("billing_periods"."invoice_id" IS NOT NULL
							AND "billing_periods"."stripe_invoice_id" IS NOT NULL)
					))
				OR ("billing_periods"."state" = 'released'
					AND "billing_periods"."closed_at" IS NOT NULL
					AND "billing_periods"."claimed_at" IS NOT NULL
					AND "billing_periods"."settled_at" IS NULL
					AND "billing_periods"."released_at" IS NOT NULL
					AND "billing_periods"."written_off_at" IS NULL
					AND "billing_periods"."write_off_reason" IS NULL
					AND "billing_periods"."write_off_evidence" IS NULL
					AND "billing_periods"."voided_at" IS NULL
					AND "billing_periods"."release_count" = 1
					AND "billing_periods"."committed_units_snapshot" IS NOT NULL
					AND "billing_periods"."effective_included_units_snapshot" IS NOT NULL
					AND "billing_periods"."overage_units_snapshot" IS NOT NULL
					AND "billing_periods"."amount_cents_snapshot" IS NOT NULL
					AND "billing_periods"."invoice_id" IS NULL
					AND "billing_periods"."stripe_invoice_id" IS NULL)
				OR ("billing_periods"."state" = 'written_off'
					AND "billing_periods"."closed_at" IS NOT NULL
					AND "billing_periods"."claimed_at" IS NOT NULL
					AND "billing_periods"."settled_at" IS NULL
					AND "billing_periods"."released_at" IS NULL
					AND "billing_periods"."written_off_at" IS NOT NULL
					AND length("billing_periods"."write_off_reason") > 0
					AND "billing_periods"."write_off_evidence" IS NOT NULL
					AND "billing_periods"."voided_at" IS NULL
					AND "billing_periods"."committed_units_snapshot" IS NOT NULL
					AND "billing_periods"."effective_included_units_snapshot" IS NOT NULL
					AND "billing_periods"."overage_units_snapshot" IS NOT NULL
					AND "billing_periods"."amount_cents_snapshot" IS NOT NULL
					AND "billing_periods"."invoice_id" IS NULL
					AND "billing_periods"."stripe_invoice_id" IS NULL)
				OR ("billing_periods"."state" = 'void'
					AND "billing_periods"."voided_at" IS NOT NULL
					AND "billing_periods"."closed_at" IS NULL
					AND "billing_periods"."claimed_at" IS NULL
					AND "billing_periods"."settled_at" IS NULL
					AND "billing_periods"."released_at" IS NULL
					AND "billing_periods"."written_off_at" IS NULL
					AND "billing_periods"."write_off_reason" IS NULL
					AND "billing_periods"."write_off_evidence" IS NULL
					AND "billing_periods"."committed_units_snapshot" IS NULL
					AND "billing_periods"."effective_included_units_snapshot" IS NULL
					AND "billing_periods"."overage_units_snapshot" IS NULL
					AND "billing_periods"."amount_cents_snapshot" IS NULL
					AND "billing_periods"."invoice_id" IS NULL
					AND "billing_periods"."stripe_invoice_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "broadcast_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"broadcast_id" text NOT NULL,
	"contact_id" text,
	"contact_identifier" text,
	"contact_identifier_hash" text NOT NULL,
	"variables" jsonb,
	"pii_erased_at" timestamp with time zone,
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
	CONSTRAINT "broadcast_recipients_claim_state_check" CHECK ("broadcast_recipients"."status" <> 'sending' OR "broadcast_recipients"."claimed_at" IS NOT NULL),
	CONSTRAINT "broadcast_recipients_pii_tuple_check" CHECK (("broadcast_recipients"."contact_identifier" IS NOT NULL AND "broadcast_recipients"."pii_erased_at" IS NULL)
				OR ("broadcast_recipients"."contact_identifier" IS NULL AND "broadcast_recipients"."pii_erased_at" IS NOT NULL)),
	CONSTRAINT "broadcast_recipients_sendable_identity_check" CHECK (("broadcast_recipients"."status" = 'pending'
					OR ("broadcast_recipients"."status" = 'sending'
						AND "broadcast_recipients"."request_may_have_been_sent_at" IS NULL))
				IS NOT TRUE
				OR "broadcast_recipients"."contact_identifier" IS NOT NULL)
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
	"identifier_ciphertext" text NOT NULL,
	"identifier_hash" text NOT NULL,
	"identity_key_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_channels_identifier_ciphertext_check" CHECK ("contact_channels"."identifier_ciphertext"
				~ '^enc:v2:[A-Za-z0-9_-]{1,32}:'),
	CONSTRAINT "contact_channels_identifier_hash_check" CHECK ("contact_channels"."identifier_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "contact_channels_identity_key_fingerprint_check" CHECK ("contact_channels"."identity_key_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "contact_consent_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" text,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"ordering_hlc" bigint NOT NULL,
	"ordering_region" text DEFAULT 'home' NOT NULL,
	"channel" text NOT NULL,
	"purpose" text NOT NULL,
	"status" text NOT NULL,
	"logical_identifier_hash" text NOT NULL,
	"identifier_hash" text NOT NULL,
	"identifier_key_version" text NOT NULL,
	"identifier_masked" text,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"evidence" jsonb,
	"policy_version" text,
	"jurisdiction" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_consent_events_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "contact_consent_events_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "contact_consent_events_ordering_tuple_uniq" UNIQUE("ordering_hlc","ordering_region","id"),
	CONSTRAINT "contact_consent_events_projection_source_uniq" UNIQUE("id","organization_id","scope_key","ordering_hlc","ordering_region"),
	CONSTRAINT "contact_consent_events_status_check" CHECK ("contact_consent_events"."status" IN ('granted', 'denied')),
	CONSTRAINT "contact_consent_events_channel_canonical_check" CHECK ("contact_consent_events"."channel" <> '' AND "contact_consent_events"."channel" = lower(btrim("contact_consent_events"."channel"))),
	CONSTRAINT "contact_consent_events_purpose_canonical_check" CHECK ("contact_consent_events"."purpose" <> '' AND "contact_consent_events"."purpose" = lower(btrim("contact_consent_events"."purpose"))),
	CONSTRAINT "contact_consent_events_logical_identifier_hash_check" CHECK ("contact_consent_events"."logical_identifier_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "contact_consent_events_identifier_hash_check" CHECK ("contact_consent_events"."identifier_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "contact_consent_events_identifier_key_version_check" CHECK ("contact_consent_events"."identifier_key_version" ~ '^[A-Za-z0-9_-]{1,32}$' AND "contact_consent_events"."identifier_key_version" <> 'identity'),
	CONSTRAINT "contact_consent_events_ordering_hlc_positive_check" CHECK ("contact_consent_events"."ordering_hlc" > 0),
	CONSTRAINT "contact_consent_events_ordering_region_check" CHECK ("contact_consent_events"."ordering_region" ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
	CONSTRAINT "contact_consent_events_timestamp_order_check" CHECK ("contact_consent_events"."occurred_at" <= "contact_consent_events"."created_at" + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE "contact_consent_states" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"channel" text NOT NULL,
	"purpose" text NOT NULL,
	"logical_identifier_hash" text NOT NULL,
	"identifier_hash" text NOT NULL,
	"identifier_key_version" text NOT NULL,
	"identity_key_fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"policy_version" text,
	"jurisdiction" text,
	"last_event_id" text NOT NULL,
	"last_ordering_hlc" bigint NOT NULL,
	"last_ordering_region" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_consent_states_ordering_hlc_positive_check" CHECK ("contact_consent_states"."last_ordering_hlc" > 0),
	CONSTRAINT "contact_consent_states_ordering_region_check" CHECK ("contact_consent_states"."last_ordering_region" ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
	CONSTRAINT "contact_consent_states_status_check" CHECK ("contact_consent_states"."status" IN ('granted', 'denied')),
	CONSTRAINT "contact_consent_states_channel_canonical_check" CHECK ("contact_consent_states"."channel" <> '' AND "contact_consent_states"."channel" = lower(btrim("contact_consent_states"."channel"))),
	CONSTRAINT "contact_consent_states_purpose_canonical_check" CHECK ("contact_consent_states"."purpose" <> '' AND "contact_consent_states"."purpose" = lower(btrim("contact_consent_states"."purpose"))),
	CONSTRAINT "contact_consent_states_logical_identifier_hash_check" CHECK ("contact_consent_states"."logical_identifier_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "contact_consent_states_identifier_hash_check" CHECK ("contact_consent_states"."identifier_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "contact_consent_states_identifier_key_version_check" CHECK ("contact_consent_states"."identifier_key_version" ~ '^[A-Za-z0-9_-]{1,32}$' AND "contact_consent_states"."identifier_key_version" <> 'identity'),
	CONSTRAINT "contact_consent_states_identity_key_fingerprint_check" CHECK ("contact_consent_states"."identity_key_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "contact_consent_states_timestamp_order_check" CHECK ("contact_consent_states"."occurred_at" <= "contact_consent_states"."updated_at" + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE "contact_segment_memberships" (
	"contact_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"segment_is_dynamic" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_segment_memberships_pk" PRIMARY KEY("contact_id","segment_id"),
	CONSTRAINT "contact_segment_memberships_static_only_check" CHECK ("contact_segment_memberships"."segment_is_dynamic" = false)
);
--> statement-breakpoint
CREATE TABLE "contact_subscription_events" (
	"id" text PRIMARY KEY NOT NULL,
	"ingestion_sequence" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"contact_id" text NOT NULL,
	"list_id" text NOT NULL,
	"type" "contact_subscription_event_type" NOT NULL,
	"source" "contact_subscription_source" NOT NULL,
	"actor_id" text,
	"merged_from_contact_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_subscription_events_ingestion_sequence_uniq" UNIQUE("ingestion_sequence"),
	CONSTRAINT "contact_subscription_events_projection_source_uniq" UNIQUE("id","organization_id","scope_key","list_id","contact_id","type","source","occurred_at","ingestion_sequence"),
	CONSTRAINT "contact_subscription_events_sequence_positive_check" CHECK ("contact_subscription_events"."ingestion_sequence" > 0),
	CONSTRAINT "contact_subscription_events_merge_origin_check" CHECK ("contact_subscription_events"."merged_from_contact_id" IS NULL
				OR "contact_subscription_events"."merged_from_contact_id" <> "contact_subscription_events"."contact_id"),
	CONSTRAINT "contact_subscription_events_timestamp_order_check" CHECK ("contact_subscription_events"."occurred_at" <= "contact_subscription_events"."created_at" + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE "contact_subscriptions" (
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"contact_id" text NOT NULL,
	"list_id" text NOT NULL,
	"state" "contact_subscription_event_type" NOT NULL,
	"subscribed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	"source" "contact_subscription_source" NOT NULL,
	"last_event_id" text NOT NULL,
	"last_event_sequence" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_subscriptions_pk" PRIMARY KEY("organization_id","list_id","contact_id"),
	CONSTRAINT "contact_subscriptions_timestamp_order_check" CHECK ("contact_subscriptions"."updated_at" >= "contact_subscriptions"."subscribed_at"
				AND ("contact_subscriptions"."unsubscribed_at" IS NULL
					OR ("contact_subscriptions"."unsubscribed_at" >= "contact_subscriptions"."subscribed_at"
						AND "contact_subscriptions"."updated_at" >= "contact_subscriptions"."unsubscribed_at"))),
	CONSTRAINT "contact_subscriptions_state_check" CHECK (("contact_subscriptions"."state" = 'subscribed' AND "contact_subscriptions"."unsubscribed_at" IS NULL)
				OR ("contact_subscriptions"."state" = 'unsubscribed' AND "contact_subscriptions"."unsubscribed_at" IS NOT NULL)),
	CONSTRAINT "contact_subscriptions_sequence_positive_check" CHECK ("contact_subscriptions"."last_event_sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name_ciphertext" text,
	"name_hash" text,
	"name_search_tokens" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"email_ciphertext" text,
	"email_hash" text,
	"email_search_tokens" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"phone_ciphertext" text,
	"phone_hash" text,
	"phone_search_tokens" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"metadata_ciphertext" text,
	"search_identity_key_fingerprint" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"opted_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "contacts_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "contacts_name_protected_tuple_check" CHECK (("contacts"."name_ciphertext" IS NULL
					AND "contacts"."name_hash" IS NULL
					AND cardinality("contacts"."name_search_tokens") = 0)
				OR ("contacts"."name_ciphertext" ~ '^enc:v2:[A-Za-z0-9_-]{1,32}:'
					AND "contacts"."name_hash" ~ '^[0-9a-f]{64}$'
					AND cardinality("contacts"."name_search_tokens") BETWEEN 0 AND 765
					AND (cardinality("contacts"."name_search_tokens") = 0
						OR array_to_string("contacts"."name_search_tokens", '')
							~ '^([0-9a-f]{32})+$'))),
	CONSTRAINT "contacts_email_protected_tuple_check" CHECK (("contacts"."email_ciphertext" IS NULL
					AND "contacts"."email_hash" IS NULL
					AND cardinality("contacts"."email_search_tokens") = 0)
				OR ("contacts"."email_ciphertext" ~ '^enc:v2:[A-Za-z0-9_-]{1,32}:'
					AND "contacts"."email_hash" ~ '^[0-9a-f]{64}$'
					AND cardinality("contacts"."email_search_tokens") BETWEEN 0 AND 957
					AND (cardinality("contacts"."email_search_tokens") = 0
						OR array_to_string("contacts"."email_search_tokens", '')
							~ '^([0-9a-f]{32})+$'))),
	CONSTRAINT "contacts_phone_protected_tuple_check" CHECK (("contacts"."phone_ciphertext" IS NULL
					AND "contacts"."phone_hash" IS NULL
					AND cardinality("contacts"."phone_search_tokens") = 0)
				OR ("contacts"."phone_ciphertext" ~ '^enc:v2:[A-Za-z0-9_-]{1,32}:'
					AND "contacts"."phone_hash" ~ '^[0-9a-f]{64}$'
					AND cardinality("contacts"."phone_search_tokens") BETWEEN 1 AND 237
					AND array_to_string("contacts"."phone_search_tokens", '')
						~ '^([0-9a-f]{32})+$')),
	CONSTRAINT "contacts_metadata_ciphertext_check" CHECK ("contacts"."metadata_ciphertext" IS NULL
				OR "contacts"."metadata_ciphertext"
					~ '^enc:v2:[A-Za-z0-9_-]{1,32}:'),
	CONSTRAINT "contacts_search_identity_key_fingerprint_check" CHECK ("contacts"."search_identity_key_fingerprint" ~ '^[0-9a-f]{64}$')
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
	"scheduled_for" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
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
				AND "cross_post_actions"."next_attempt_at" >= "cross_post_actions"."scheduled_for"
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
	CONSTRAINT "custom_field_definitions_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "custom_field_definitions_type_check" CHECK ("custom_field_definitions"."type" IN ('text', 'number', 'date', 'boolean', 'select')),
	CONSTRAINT "custom_field_definitions_options_by_type_check" CHECK (("custom_field_definitions"."type" = 'select'
					AND "custom_field_definitions"."options" IS NOT NULL
					AND jsonb_typeof("custom_field_definitions"."options") = 'array'
					AND jsonb_array_length("custom_field_definitions"."options") > 0
					AND NOT jsonb_path_exists(
						"custom_field_definitions"."options",
						'$[*] ? (@.type() != "string" || @ like_regex "^[[:space:]]*$")'
					))
				OR ("custom_field_definitions"."type" <> 'select' AND "custom_field_definitions"."options" IS NULL))
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
	"due_at" timestamp with time zone NOT NULL,
	"provider_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
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
	CONSTRAINT "dunning_events_deactivation_status_check" CHECK ("dunning_events"."deactivation_status" IN ('not_applicable', 'pending', 'processing', 'unknown', 'succeeded', 'failed', 'manual_review')),
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
	"intent" text NOT NULL,
	"organization_id" text,
	"auth_user_id" text,
	"subject_user_id" text,
	"envelope_ciphertext" text,
	"envelope_key_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone DEFAULT now() + interval '23 hours' NOT NULL,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"dispatch_lease_token" integer DEFAULT 0 NOT NULL,
	"dispatch_lease_expires_at" timestamp with time zone,
	"next_dispatch_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL,
	"purge_at" timestamp with time zone DEFAULT now() + interval '90 days' NOT NULL,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "email_deliveries_intent_owner_check" CHECK (("email_deliveries"."intent" = 'organization'
					AND "email_deliveries"."organization_id" IS NOT NULL
					AND "email_deliveries"."auth_user_id" IS NULL)
				OR ("email_deliveries"."intent" = 'auth_user'
					AND "email_deliveries"."organization_id" IS NULL
					AND "email_deliveries"."auth_user_id" IS NOT NULL)),
	CONSTRAINT "email_deliveries_status_check" CHECK ("email_deliveries"."status" IN ('pending', 'processing', 'unknown', 'sent', 'failed', 'manual_review')),
	CONSTRAINT "email_deliveries_attempts_nonnegative_check" CHECK ("email_deliveries"."provider_attempts" >= 0
				AND "email_deliveries"."lease_token" >= 0
				AND "email_deliveries"."dispatch_attempts" >= 0
				AND "email_deliveries"."dispatch_lease_token" >= 0),
	CONSTRAINT "email_deliveries_dispatch_lease_check" CHECK ("email_deliveries"."dispatch_lease_expires_at" IS NULL
				OR "email_deliveries"."status" IN ('pending', 'unknown')),
	CONSTRAINT "email_deliveries_state_fields_check" CHECK (("email_deliveries"."status" = 'pending'
					AND "email_deliveries"."completed_at" IS NULL
					AND "email_deliveries"."lease_expires_at" IS NULL
					AND "email_deliveries"."request_may_have_been_sent_at" IS NULL)
				OR ("email_deliveries"."status" = 'processing'
					AND "email_deliveries"."completed_at" IS NULL
					AND "email_deliveries"."lease_expires_at" IS NOT NULL)
				OR ("email_deliveries"."status" = 'unknown'
					AND "email_deliveries"."completed_at" IS NULL
					AND "email_deliveries"."lease_expires_at" IS NULL
					AND "email_deliveries"."request_may_have_been_sent_at" IS NOT NULL
				)
				OR ("email_deliveries"."status" IN ('sent', 'failed', 'manual_review')
					AND "email_deliveries"."lease_expires_at" IS NULL
					AND "email_deliveries"."completed_at" IS NOT NULL)),
	CONSTRAINT "email_deliveries_timestamp_order_check" CHECK ("email_deliveries"."expires_at" > "email_deliveries"."created_at"
				AND "email_deliveries"."deadline_at" > "email_deliveries"."created_at"
				AND "email_deliveries"."deadline_at" <= "email_deliveries"."expires_at"
				AND "email_deliveries"."purge_at" >= "email_deliveries"."expires_at"
				AND ("email_deliveries"."queued_at" IS NULL OR "email_deliveries"."queued_at" >= "email_deliveries"."created_at")
				AND ("email_deliveries"."request_may_have_been_sent_at" IS NULL OR "email_deliveries"."request_may_have_been_sent_at" >= "email_deliveries"."created_at")
				AND ("email_deliveries"."completed_at" IS NULL OR "email_deliveries"."completed_at" >= "email_deliveries"."created_at")
				AND ("email_deliveries"."redacted_at" IS NULL OR "email_deliveries"."redacted_at" >= "email_deliveries"."created_at")),
	CONSTRAINT "email_deliveries_envelope_lifecycle_check" CHECK (("email_deliveries"."envelope_ciphertext" IS NOT NULL
					AND "email_deliveries"."envelope_key_id" IS NOT NULL
					AND "email_deliveries"."redacted_at" IS NULL)
				OR ("email_deliveries"."envelope_ciphertext" IS NULL
					AND "email_deliveries"."envelope_key_id" IS NULL
					AND "email_deliveries"."redacted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "erasure_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_kind" "erasure_hold_subject_kind" NOT NULL,
	"subject_id" text NOT NULL,
	"organization_tombstone_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_summary" text NOT NULL,
	"legal_authority_ref" text NOT NULL,
	"placed_by" text NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by" text,
	"released_at" timestamp with time zone,
	"release_reason_summary" text,
	"evidence_ciphertext" text,
	"evidence_redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erasure_holds_target_tuple_check" CHECK (("erasure_holds"."subject_kind" = 'organization'
					AND "erasure_holds"."subject_id" = "erasure_holds"."organization_tombstone_id")
				OR ("erasure_holds"."subject_kind" = 'workspace'
					AND "erasure_holds"."subject_id" <> "erasure_holds"."organization_tombstone_id")),
	CONSTRAINT "erasure_holds_reason_code_check" CHECK ("erasure_holds"."reason_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "erasure_holds_placement_text_check" CHECK (length(btrim("erasure_holds"."reason_summary")) > 0
				AND length("erasure_holds"."reason_summary") <= 500
				AND length(btrim("erasure_holds"."legal_authority_ref")) > 0
				AND length("erasure_holds"."legal_authority_ref") <= 256
				AND length(btrim("erasure_holds"."placed_by")) > 0
				AND length("erasure_holds"."placed_by") <= 256),
	CONSTRAINT "erasure_holds_release_tuple_check" CHECK (("erasure_holds"."released_by" IS NULL
					AND "erasure_holds"."released_at" IS NULL
					AND "erasure_holds"."release_reason_summary" IS NULL)
				OR ("erasure_holds"."released_by" IS NOT NULL
					AND "erasure_holds"."released_at" IS NOT NULL
					AND length(btrim("erasure_holds"."release_reason_summary")) > 0
					AND length("erasure_holds"."release_reason_summary") <= 500
					AND length("erasure_holds"."released_by") <= 256)),
	CONSTRAINT "erasure_holds_timestamp_order_check" CHECK ("erasure_holds"."placed_at" >= "erasure_holds"."created_at"
				AND ("erasure_holds"."released_at" IS NULL OR "erasure_holds"."released_at" >= "erasure_holds"."placed_at")),
	CONSTRAINT "erasure_holds_evidence_redaction_check" CHECK (("erasure_holds"."evidence_ciphertext" IS NULL
					OR octet_length("erasure_holds"."evidence_ciphertext") <= 65536)
				AND ("erasure_holds"."evidence_redacted_at" IS NULL
					OR ("erasure_holds"."evidence_ciphertext" IS NULL
						AND "erasure_holds"."released_at" IS NOT NULL
						AND "erasure_holds"."evidence_redacted_at" >= "erasure_holds"."released_at")))
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
	"preview_thumbnail_key" text,
	"preview_storage_provider" "storage_provider",
	"preview_storage_bucket_locator" text,
	"preview_storage_region" text,
	"preview_thumbnail_url" text,
	"preview_status" text DEFAULT 'pending' NOT NULL,
	"preview_attempts" integer DEFAULT 0 NOT NULL,
	"preview_next_retry_at" timestamp with time zone,
	"preview_last_error" text,
	"platform_data" jsonb DEFAULT '{}'::jsonb,
	"metrics" jsonb DEFAULT '{}'::jsonb,
	"metrics_updated_at" timestamp with time zone,
	"metrics_next_poll_at" timestamp with time zone DEFAULT now(),
	"metrics_poll_generation" integer DEFAULT 0 NOT NULL,
	"metrics_poll_lease_expires_at" timestamp with time zone,
	"metrics_poll_started_at" timestamp with time zone,
	"metrics_poll_attempts" integer DEFAULT 0 NOT NULL,
	"metrics_poll_last_error" text,
	"metrics_poll_last_error_class" text,
	"notes" text,
	"published_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_posts_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "external_posts_preview_status_check" CHECK ("external_posts"."preview_status" IN ('pending', 'processing', 'generated', 'unsupported', 'source_missing', 'transient_failure')),
	CONSTRAINT "external_posts_preview_attempts_nonnegative_check" CHECK ("external_posts"."preview_attempts" >= 0),
	CONSTRAINT "external_posts_preview_storage_locator_check" CHECK ((
					"external_posts"."preview_thumbnail_key" IS NULL
					AND "external_posts"."preview_storage_provider" IS NULL
					AND "external_posts"."preview_storage_bucket_locator" IS NULL
					AND "external_posts"."preview_storage_region" IS NULL
				) OR (
					"external_posts"."preview_thumbnail_key" IS NOT NULL
					AND "external_posts"."preview_storage_provider" IS NOT NULL
					AND "external_posts"."preview_storage_provider" = 'r2'
					AND "external_posts"."preview_storage_bucket_locator" IS NOT NULL
					AND length(btrim("external_posts"."preview_storage_bucket_locator")) > 0
					AND length("external_posts"."preview_storage_bucket_locator") <= 255
					AND "external_posts"."preview_storage_region" IS NOT NULL
					AND "external_posts"."preview_storage_region" IN ('default', 'eu')
				)),
	CONSTRAINT "external_posts_preview_projection_check" CHECK (("external_posts"."preview_status" <> 'generated'
					OR ("external_posts"."preview_thumbnail_key" IS NOT NULL
						AND "external_posts"."preview_thumbnail_url" IS NOT NULL))
				AND ("external_posts"."preview_thumbnail_url" IS NULL
					OR "external_posts"."preview_status" = 'generated')),
	CONSTRAINT "external_posts_metrics_poll_claim_check" CHECK (("external_posts"."metrics_poll_lease_expires_at" IS NULL
						AND "external_posts"."metrics_poll_started_at" IS NULL)
					OR ("external_posts"."metrics_poll_lease_expires_at" IS NOT NULL
						AND ("external_posts"."metrics_poll_started_at" IS NULL
							OR "external_posts"."metrics_poll_started_at" <= "external_posts"."metrics_poll_lease_expires_at"))),
	CONSTRAINT "external_posts_metrics_poll_generation_nonnegative_check" CHECK ("external_posts"."metrics_poll_generation" >= 0 AND "external_posts"."metrics_poll_attempts" >= 0),
	CONSTRAINT "external_posts_metrics_poll_error_class_check" CHECK ("external_posts"."metrics_poll_last_error_class" IS NULL
				OR "external_posts"."metrics_poll_last_error_class" IN ('transient', 'rate_limited', 'permanent'))
);
--> statement-breakpoint
CREATE TABLE "external_subject_cleanup_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"workspace_id" text,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"operation" text NOT NULL,
	"bucket" text NOT NULL,
	"object_locator" text,
	"prefix_locator" text,
	"external_provider" text,
	"provider_ref" jsonb,
	"credential_ciphertext" text,
	"cursor" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"deadline_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"purge_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_subject_cleanup_jobs_subject_kind_check" CHECK ("external_subject_cleanup_jobs"."subject_kind" IN ('user', 'contact', 'account', 'organization', 'workspace')),
	CONSTRAINT "external_subject_cleanup_jobs_operation_check" CHECK ("external_subject_cleanup_jobs"."operation" IN ('delete_exact', 'delete_prefix', 'purge_rescue_subject', 'delete_short_link')),
	CONSTRAINT "external_subject_cleanup_jobs_bucket_check" CHECK ("external_subject_cleanup_jobs"."bucket" IN ('avatar', 'media', 'thumbnail', 'queue_rescue', 'short_link_provider')),
	CONSTRAINT "external_subject_cleanup_jobs_status_check" CHECK ("external_subject_cleanup_jobs"."status" IN ('pending', 'processing', 'completed', 'manual_review')),
	CONSTRAINT "external_subject_cleanup_jobs_subject_tuple_check" CHECK (("external_subject_cleanup_jobs"."subject_kind" = 'user' AND "external_subject_cleanup_jobs"."workspace_id" IS NULL)
				OR ("external_subject_cleanup_jobs"."subject_kind" IN ('contact', 'account')
					AND "external_subject_cleanup_jobs"."organization_id" IS NOT NULL)
				OR ("external_subject_cleanup_jobs"."subject_kind" = 'organization'
					AND "external_subject_cleanup_jobs"."organization_id" = "external_subject_cleanup_jobs"."subject_id"
					AND "external_subject_cleanup_jobs"."workspace_id" IS NULL)
				OR ("external_subject_cleanup_jobs"."subject_kind" = 'workspace'
					AND "external_subject_cleanup_jobs"."organization_id" IS NOT NULL
					AND "external_subject_cleanup_jobs"."workspace_id" = "external_subject_cleanup_jobs"."subject_id")),
	CONSTRAINT "external_subject_cleanup_jobs_locator_tuple_check" CHECK (("external_subject_cleanup_jobs"."operation" = 'delete_exact'
					AND "external_subject_cleanup_jobs"."bucket" IN ('avatar', 'media', 'thumbnail')
					AND "external_subject_cleanup_jobs"."object_locator" IS NOT NULL
					AND "external_subject_cleanup_jobs"."prefix_locator" IS NULL
					AND "external_subject_cleanup_jobs"."cursor" IS NULL
					AND "external_subject_cleanup_jobs"."external_provider" IS NULL
					AND "external_subject_cleanup_jobs"."provider_ref" IS NULL
					AND "external_subject_cleanup_jobs"."credential_ciphertext" IS NULL)
				OR ("external_subject_cleanup_jobs"."operation" = 'delete_prefix'
					AND "external_subject_cleanup_jobs"."bucket" IN ('avatar', 'media', 'thumbnail')
					AND "external_subject_cleanup_jobs"."object_locator" IS NULL
					AND "external_subject_cleanup_jobs"."prefix_locator" IS NOT NULL
					AND "external_subject_cleanup_jobs"."external_provider" IS NULL
					AND "external_subject_cleanup_jobs"."provider_ref" IS NULL
					AND "external_subject_cleanup_jobs"."credential_ciphertext" IS NULL)
				OR ("external_subject_cleanup_jobs"."operation" = 'purge_rescue_subject'
					AND "external_subject_cleanup_jobs"."bucket" = 'queue_rescue'
					AND "external_subject_cleanup_jobs"."organization_id" IS NOT NULL
					AND "external_subject_cleanup_jobs"."subject_kind" IN ('user', 'contact', 'account', 'workspace')
					AND "external_subject_cleanup_jobs"."object_locator" IS NULL
					AND "external_subject_cleanup_jobs"."prefix_locator" IS NULL
					AND "external_subject_cleanup_jobs"."external_provider" IS NULL
					AND "external_subject_cleanup_jobs"."provider_ref" IS NULL
					AND "external_subject_cleanup_jobs"."credential_ciphertext" IS NULL)
				OR ("external_subject_cleanup_jobs"."operation" = 'delete_short_link'
					AND "external_subject_cleanup_jobs"."bucket" = 'short_link_provider'
					AND "external_subject_cleanup_jobs"."organization_id" IS NOT NULL
					AND "external_subject_cleanup_jobs"."subject_kind" IN ('organization', 'workspace')
					AND "external_subject_cleanup_jobs"."object_locator" IS NULL
					AND "external_subject_cleanup_jobs"."prefix_locator" IS NULL
					AND "external_subject_cleanup_jobs"."cursor" IS NULL
					AND "external_subject_cleanup_jobs"."external_provider" IN ('dub', 'short_io', 'bitly')
					AND jsonb_typeof("external_subject_cleanup_jobs"."provider_ref") = 'object'
					AND "external_subject_cleanup_jobs"."provider_ref"->>'provider' = "external_subject_cleanup_jobs"."external_provider"
					AND (
						("external_subject_cleanup_jobs"."status" = 'completed'
							AND "external_subject_cleanup_jobs"."credential_ciphertext" IS NULL)
						OR ("external_subject_cleanup_jobs"."status" <> 'completed'
							AND "external_subject_cleanup_jobs"."credential_ciphertext" IS NOT NULL
							AND "external_subject_cleanup_jobs"."credential_ciphertext" LIKE 'enc:v2:%'
							AND length("external_subject_cleanup_jobs"."credential_ciphertext") BETWEEN 1 AND 8192)
					))),
	CONSTRAINT "external_subject_cleanup_jobs_locator_syntax_check" CHECK (("external_subject_cleanup_jobs"."object_locator" IS NULL
					OR (length("external_subject_cleanup_jobs"."object_locator") BETWEEN 1 AND 1024
						AND "external_subject_cleanup_jobs"."object_locator" !~ '(^/|//|(^|/)\.\.?(/|$)|[[:cntrl:]])'
						AND "external_subject_cleanup_jobs"."object_locator" !~ '/$'))
				AND ("external_subject_cleanup_jobs"."prefix_locator" IS NULL
					OR (length("external_subject_cleanup_jobs"."prefix_locator") BETWEEN 1 AND 1024
						AND "external_subject_cleanup_jobs"."prefix_locator" !~ '(^/|//|(^|/)\.\.?(/|$)|[[:cntrl:]])'
						AND "external_subject_cleanup_jobs"."prefix_locator" ~ '/$'))),
	CONSTRAINT "external_subject_cleanup_jobs_bucket_locator_check" CHECK ("external_subject_cleanup_jobs"."bucket" IN ('queue_rescue', 'short_link_provider')
				OR (
					"external_subject_cleanup_jobs"."bucket" = 'avatar'
					AND COALESCE("external_subject_cleanup_jobs"."object_locator", "external_subject_cleanup_jobs"."prefix_locator")
						~ '^(account|user|organization)/[^/]+/'
				)
				OR (
					"external_subject_cleanup_jobs"."bucket" = 'thumbnail'
					AND (
						"external_subject_cleanup_jobs"."prefix_locator" IS NOT NULL
						OR "external_subject_cleanup_jobs"."object_locator" ~ '\.avif$'
					)
				)
				OR (
					"external_subject_cleanup_jobs"."bucket" = 'media'
					AND COALESCE("external_subject_cleanup_jobs"."object_locator", "external_subject_cleanup_jobs"."prefix_locator")
						!~ '^(account|user|organization|queue-rescue)/'
				)),
	CONSTRAINT "external_subject_cleanup_jobs_counters_check" CHECK ("external_subject_cleanup_jobs"."attempts" >= 0 AND "external_subject_cleanup_jobs"."lease_token" >= 0),
	CONSTRAINT "external_subject_cleanup_jobs_lease_check" CHECK (("external_subject_cleanup_jobs"."status" = 'processing' AND "external_subject_cleanup_jobs"."lease_expires_at" IS NOT NULL)
				OR ("external_subject_cleanup_jobs"."status" <> 'processing' AND "external_subject_cleanup_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "external_subject_cleanup_jobs_terminal_check" CHECK (("external_subject_cleanup_jobs"."status" = 'completed'
					AND "external_subject_cleanup_jobs"."completed_at" IS NOT NULL
					AND "external_subject_cleanup_jobs"."purge_at" IS NOT NULL)
				OR ("external_subject_cleanup_jobs"."status" <> 'completed'
					AND "external_subject_cleanup_jobs"."completed_at" IS NULL
					AND "external_subject_cleanup_jobs"."purge_at" IS NULL)),
	CONSTRAINT "external_subject_cleanup_jobs_error_check" CHECK ("external_subject_cleanup_jobs"."last_error" IS NULL OR length("external_subject_cleanup_jobs"."last_error") BETWEEN 1 AND 1000),
	CONSTRAINT "external_subject_cleanup_jobs_timestamp_check" CHECK ("external_subject_cleanup_jobs"."updated_at" >= "external_subject_cleanup_jobs"."created_at"
				AND "external_subject_cleanup_jobs"."deadline_at" > "external_subject_cleanup_jobs"."created_at"
				AND ("external_subject_cleanup_jobs"."completed_at" IS NULL OR "external_subject_cleanup_jobs"."completed_at" >= "external_subject_cleanup_jobs"."created_at")
				AND ("external_subject_cleanup_jobs"."purge_at" IS NULL OR "external_subject_cleanup_jobs"."purge_at" >= "external_subject_cleanup_jobs"."completed_at"))
);
--> statement-breakpoint
CREATE TABLE "financial_retention_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" varchar(128) NOT NULL,
	"organization_tombstone_id" text,
	"retention_class" text NOT NULL,
	"status" text NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"amount_cents" integer,
	"currency" varchar(3),
	"quantity" bigint,
	"included_quantity" bigint,
	"overage_quantity" bigint,
	"provider_reference_digest" varchar(64),
	"retention_anchor_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retained_until" timestamp with time zone NOT NULL,
	CONSTRAINT "financial_retention_receipts_source_kind_check" CHECK ("financial_retention_receipts"."source_kind" IN ('subscription_snapshot', 'invoice', 'usage_bucket', 'billing_period', 'billing_operation', 'phone_billing_operation', 'dunning_event', 'checkout_operation', 'billing_outbox', 'stripe_event_financial', 'stripe_event_global')),
	CONSTRAINT "financial_retention_receipts_retention_class_check" CHECK ("financial_retention_receipts"."retention_class" IN ('financial_7_years', 'usage_25_months', 'provider_receipt_1_year')),
	CONSTRAINT "financial_retention_receipts_status_check" CHECK ("financial_retention_receipts"."status" IN ('active', 'pending', 'succeeded', 'failed', 'unknown', 'manual_review', 'cancelled', 'paid', 'void', 'settled', 'released', 'written_off')),
	CONSTRAINT "financial_retention_receipts_identity_check" CHECK (length(btrim("financial_retention_receipts"."source_id")) BETWEEN 1 AND 128
				AND (
					"financial_retention_receipts"."source_kind" NOT IN ('stripe_event_financial', 'stripe_event_global')
					OR "financial_retention_receipts"."source_id" ~ '^[0-9a-f]{64}$'
				)
				AND (
					("financial_retention_receipts"."source_kind" = 'stripe_event_global'
						AND "financial_retention_receipts"."organization_tombstone_id" IS NULL)
					OR ("financial_retention_receipts"."source_kind" <> 'stripe_event_global'
						AND "financial_retention_receipts"."organization_tombstone_id" IS NOT NULL)
				)),
	CONSTRAINT "financial_retention_receipts_provider_digest_check" CHECK ("financial_retention_receipts"."provider_reference_digest" IS NULL
				OR "financial_retention_receipts"."provider_reference_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "financial_retention_receipts_provider_digest_source_check" CHECK (("financial_retention_receipts"."source_kind" = 'usage_bucket'
					AND "financial_retention_receipts"."provider_reference_digest" IS NULL)
				OR ("financial_retention_receipts"."source_kind" IN ('billing_period', 'billing_operation', 'phone_billing_operation', 'dunning_event', 'checkout_operation', 'stripe_event_financial', 'stripe_event_global')
					AND "financial_retention_receipts"."provider_reference_digest" IS NOT NULL)
				OR "financial_retention_receipts"."source_kind" IN ('subscription_snapshot', 'invoice', 'billing_outbox')),
	CONSTRAINT "financial_retention_receipts_period_check" CHECK ((
					"financial_retention_receipts"."period_start" IS NULL
					AND "financial_retention_receipts"."period_end" IS NULL
				) OR (
					"financial_retention_receipts"."period_start" IS NOT NULL
					AND "financial_retention_receipts"."period_end" IS NOT NULL
					AND "financial_retention_receipts"."period_end" > "financial_retention_receipts"."period_start"
				)),
	CONSTRAINT "financial_retention_receipts_amount_currency_check" CHECK ((
					"financial_retention_receipts"."amount_cents" IS NULL
					AND "financial_retention_receipts"."currency" IS NULL
				) OR (
					"financial_retention_receipts"."amount_cents" IS NOT NULL
					AND "financial_retention_receipts"."currency" IS NOT NULL
					AND "financial_retention_receipts"."amount_cents" >= 0
					AND "financial_retention_receipts"."currency" ~ '^[a-z]{3}$'
				)),
	CONSTRAINT "financial_retention_receipts_quantities_check" CHECK (("financial_retention_receipts"."quantity" IS NULL OR "financial_retention_receipts"."quantity" BETWEEN 0 AND 9007199254740991)
				AND ("financial_retention_receipts"."included_quantity" IS NULL OR "financial_retention_receipts"."included_quantity" BETWEEN 0 AND 9007199254740991)
				AND ("financial_retention_receipts"."overage_quantity" IS NULL OR "financial_retention_receipts"."overage_quantity" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "financial_retention_receipts_class_check" CHECK (("financial_retention_receipts"."source_kind" = 'usage_bucket'
					AND "financial_retention_receipts"."retention_class" = 'usage_25_months')
				OR ("financial_retention_receipts"."source_kind" = 'stripe_event_global'
					AND "financial_retention_receipts"."retention_class" = 'provider_receipt_1_year')
				OR ("financial_retention_receipts"."source_kind" NOT IN ('usage_bucket', 'stripe_event_global')
					AND "financial_retention_receipts"."retention_class" = 'financial_7_years')),
	CONSTRAINT "financial_retention_receipts_status_source_check" CHECK (("financial_retention_receipts"."source_kind" = 'subscription_snapshot'
					AND "financial_retention_receipts"."status" IN ('active', 'failed', 'cancelled'))
				OR ("financial_retention_receipts"."source_kind" = 'invoice'
					AND "financial_retention_receipts"."status" IN ('pending', 'paid', 'void'))
				OR ("financial_retention_receipts"."source_kind" = 'usage_bucket'
					AND "financial_retention_receipts"."status" IN ('pending', 'settled', 'released', 'void', 'written_off'))
				OR ("financial_retention_receipts"."source_kind" = 'billing_period'
					AND "financial_retention_receipts"."status" IN ('pending', 'settled', 'released', 'void', 'written_off'))
				OR ("financial_retention_receipts"."source_kind" = 'billing_operation'
					AND "financial_retention_receipts"."status" IN ('pending', 'succeeded', 'failed', 'unknown', 'manual_review', 'released', 'written_off'))
				OR ("financial_retention_receipts"."source_kind" = 'phone_billing_operation'
					AND "financial_retention_receipts"."status" IN ('pending', 'succeeded', 'unknown', 'manual_review'))
				OR ("financial_retention_receipts"."source_kind" = 'dunning_event'
					AND "financial_retention_receipts"."status" IN ('pending', 'succeeded', 'failed', 'unknown', 'manual_review'))
				OR ("financial_retention_receipts"."source_kind" = 'checkout_operation'
					AND "financial_retention_receipts"."status" = 'unknown')
				OR ("financial_retention_receipts"."source_kind" = 'billing_outbox'
					AND "financial_retention_receipts"."status" = 'manual_review')
				OR ("financial_retention_receipts"."source_kind" = 'stripe_event_financial'
					AND "financial_retention_receipts"."status" IN ('failed', 'manual_review'))
				OR ("financial_retention_receipts"."source_kind" = 'stripe_event_global'
					AND "financial_retention_receipts"."status" IN ('pending', 'succeeded', 'failed', 'manual_review'))),
	CONSTRAINT "financial_retention_receipts_value_shape_check" CHECK (("financial_retention_receipts"."source_kind" = 'subscription_snapshot'
					AND "financial_retention_receipts"."period_start" IS NULL
					AND "financial_retention_receipts"."period_end" IS NULL
					AND "financial_retention_receipts"."amount_cents" IS NULL
					AND "financial_retention_receipts"."currency" IS NULL
					AND "financial_retention_receipts"."quantity" IS NULL
					AND "financial_retention_receipts"."included_quantity" IS NULL
					AND "financial_retention_receipts"."overage_quantity" IS NULL)
				OR ("financial_retention_receipts"."source_kind" = 'invoice'
					AND "financial_retention_receipts"."period_start" IS NOT NULL
					AND "financial_retention_receipts"."amount_cents" IS NOT NULL
					AND "financial_retention_receipts"."quantity" IS NOT NULL
					AND "financial_retention_receipts"."included_quantity" IS NOT NULL
					AND "financial_retention_receipts"."overage_quantity" IS NOT NULL)
				OR ("financial_retention_receipts"."source_kind" = 'usage_bucket'
					AND "financial_retention_receipts"."period_start" IS NOT NULL
					AND "financial_retention_receipts"."amount_cents" IS NULL
					AND "financial_retention_receipts"."quantity" IS NOT NULL
					AND "financial_retention_receipts"."included_quantity" IS NOT NULL
					AND "financial_retention_receipts"."overage_quantity" IS NOT NULL)
				OR ("financial_retention_receipts"."source_kind" = 'billing_period'
					AND "financial_retention_receipts"."period_start" IS NOT NULL
					AND "financial_retention_receipts"."amount_cents" IS NOT NULL
					AND "financial_retention_receipts"."quantity" IS NOT NULL
					AND "financial_retention_receipts"."included_quantity" IS NOT NULL
					AND "financial_retention_receipts"."overage_quantity" IS NOT NULL)
				OR ("financial_retention_receipts"."source_kind" = 'billing_operation'
					AND "financial_retention_receipts"."period_start" IS NOT NULL
					AND "financial_retention_receipts"."amount_cents" IS NOT NULL
					AND "financial_retention_receipts"."quantity" IS NOT NULL
					AND "financial_retention_receipts"."included_quantity" IS NULL
					AND "financial_retention_receipts"."overage_quantity" IS NULL)
				OR ("financial_retention_receipts"."source_kind" = 'phone_billing_operation'
					AND "financial_retention_receipts"."period_start" IS NULL
					AND "financial_retention_receipts"."period_end" IS NULL
					AND "financial_retention_receipts"."amount_cents" IS NULL
					AND "financial_retention_receipts"."currency" IS NULL
					AND "financial_retention_receipts"."quantity" IS NOT NULL
					AND "financial_retention_receipts"."included_quantity" IS NULL
					AND "financial_retention_receipts"."overage_quantity" IS NULL)
				OR ("financial_retention_receipts"."source_kind" IN ('dunning_event', 'checkout_operation', 'billing_outbox', 'stripe_event_financial', 'stripe_event_global')
					AND "financial_retention_receipts"."period_start" IS NULL
					AND "financial_retention_receipts"."amount_cents" IS NULL
					AND "financial_retention_receipts"."quantity" IS NULL
					AND "financial_retention_receipts"."included_quantity" IS NULL
					AND "financial_retention_receipts"."overage_quantity" IS NULL)),
	CONSTRAINT "financial_retention_receipts_retention_clock_check" CHECK ("financial_retention_receipts"."retained_until" > "financial_retention_receipts"."recorded_at"
				AND (
					("financial_retention_receipts"."retention_class" = 'financial_7_years'
						AND "financial_retention_receipts"."retained_until" = "financial_retention_receipts"."retention_anchor_at" + INTERVAL '7 years')
					OR ("financial_retention_receipts"."retention_class" = 'usage_25_months'
						AND "financial_retention_receipts"."retained_until" = "financial_retention_receipts"."retention_anchor_at" + INTERVAL '25 months')
					OR ("financial_retention_receipts"."retention_class" = 'provider_receipt_1_year'
						AND "financial_retention_receipts"."retained_until" = "financial_retention_receipts"."retention_anchor_at" + INTERVAL '1 year')
				))
);
--> statement-breakpoint
CREATE TABLE "idea_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"idea_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"actor_principal_id" text NOT NULL,
	"action" "idea_activity_action" NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idea_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"idea_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"author_principal_id" text NOT NULL,
	"content" text NOT NULL,
	"parent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idea_comments_id_idea_org_uniq" UNIQUE("id","idea_id","organization_id")
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
	"scope_key" text DEFAULT 'org' NOT NULL,
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
	CONSTRAINT "ideas_id_org_uniq" UNIQUE("id","organization_id"),
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
	"participant_avatar_object_key" text,
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
	"contact_subject_locator" text,
	"contact_subject_identity_key_fingerprint" text,
	"assigned_user_id" text,
	"closed_at" timestamp with time zone,
	"content_expires_at" timestamp with time zone,
	"content_redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_conversations_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "inbox_conversations_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "inbox_conversations_counts_nonnegative_check" CHECK ("inbox_conversations"."unread_count" >= 0 AND "inbox_conversations"."message_count" >= 0),
	CONSTRAINT "inbox_conversations_sentiment_range_check" CHECK ("inbox_conversations"."sentiment_avg" IS NULL OR "inbox_conversations"."sentiment_avg" BETWEEN -100 AND 100),
	CONSTRAINT "inbox_conversations_last_message_direction_check" CHECK ("inbox_conversations"."last_message_direction" IS NULL OR "inbox_conversations"."last_message_direction" IN ('inbound', 'outbound')),
	CONSTRAINT "inbox_conversations_contact_subject_locator_check" CHECK (("inbox_conversations"."contact_subject_locator" IS NULL
					AND "inbox_conversations"."contact_subject_identity_key_fingerprint" IS NULL)
				OR ("inbox_conversations"."contact_subject_locator" ~ '^[0-9a-f]{64}$'
					AND "inbox_conversations"."contact_subject_identity_key_fingerprint" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "inbox_conversations_avatar_object_key_check" CHECK ("inbox_conversations"."participant_avatar_object_key" IS NULL
				OR (
					length("inbox_conversations"."participant_avatar_object_key") BETWEEN 1 AND 1024
					AND "inbox_conversations"."participant_avatar_object_key" !~ '(^/|//|(^|/)\.\.?(/|$)|[[:cntrl:]])'
					AND "inbox_conversations"."participant_avatar_object_key" !~ '/$'
					AND "inbox_conversations"."participant_avatar_object_key" !~ '^(account|user|organization|queue-rescue)/'
				)),
	CONSTRAINT "inbox_conversations_close_retention_check" CHECK (("inbox_conversations"."status" = 'archived'
					AND "inbox_conversations"."closed_at" IS NOT NULL
					AND "inbox_conversations"."content_expires_at" IS NOT NULL
					AND "inbox_conversations"."content_expires_at" >= "inbox_conversations"."closed_at")
				OR ("inbox_conversations"."status" <> 'archived'
					AND "inbox_conversations"."closed_at" IS NULL
					AND "inbox_conversations"."content_expires_at" IS NULL)),
	CONSTRAINT "inbox_conversations_retention_timestamp_check" CHECK (("inbox_conversations"."content_redacted_at" IS NULL
					OR "inbox_conversations"."content_redacted_at" >= "inbox_conversations"."created_at")
				AND ("inbox_conversations"."closed_at" IS NULL OR "inbox_conversations"."closed_at" >= "inbox_conversations"."created_at"))
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
	"content_redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_messages_direction_check" CHECK ("inbox_messages"."direction" IN ('inbound', 'outbound')),
	CONSTRAINT "inbox_messages_sentiment_range_check" CHECK ("inbox_messages"."sentiment_score" IS NULL OR "inbox_messages"."sentiment_score" BETWEEN -100 AND 100),
	CONSTRAINT "inbox_messages_content_redaction_check" CHECK ("inbox_messages"."content_redacted_at" IS NULL
				OR "inbox_messages"."content_redacted_at" >= "inbox_messages"."created_at")
);
--> statement-breakpoint
CREATE TABLE "auth"."invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"inviterId" text NOT NULL,
	"issuerCredentialVersion" text DEFAULT 'legacy-v1' NOT NULL,
	"organizationId" text NOT NULL,
	"role" text,
	"status" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_token_workspaces" (
	"organization_id" text NOT NULL,
	"invite_token_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"scope_mode" text DEFAULT 'selected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_token_workspaces_pkey" PRIMARY KEY("organization_id","invite_token_id","workspace_id"),
	CONSTRAINT "invite_token_workspaces_scope_mode_check" CHECK ("invite_token_workspaces"."scope_mode" = 'selected')
);
--> statement-breakpoint
CREATE TABLE "invite_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"issuer_credential_version" text DEFAULT 'legacy-v1' NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"scope_mode" text NOT NULL,
	"role" text NOT NULL,
	"used" boolean GENERATED ALWAYS AS (used_at IS NOT NULL) STORED NOT NULL,
	"used_by" text,
	"redeemed_by_user_id" text,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_tokens_id_org_scope_uniq" UNIQUE("id","organization_id","scope_mode"),
	CONSTRAINT "invite_tokens_hash_check" CHECK ("invite_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "invite_tokens_scope_mode_check" CHECK ("invite_tokens"."scope_mode" IN ('all', 'selected')),
	CONSTRAINT "invite_tokens_role_check" CHECK ("invite_tokens"."role" IN ('owner', 'admin', 'member')),
	CONSTRAINT "invite_tokens_consumption_tuple_check" CHECK (("invite_tokens"."used_at" IS NULL AND "invite_tokens"."used_by" IS NULL)
				OR ("invite_tokens"."used_at" IS NOT NULL AND "invite_tokens"."used_by" IS NOT NULL)),
	CONSTRAINT "invite_tokens_expiry_window_check" CHECK ("invite_tokens"."expires_at" > "invite_tokens"."created_at"
				AND (
					("invite_tokens"."role" = 'owner'
						AND "invite_tokens"."expires_at" <= "invite_tokens"."created_at" + interval '24 hours')
					OR ("invite_tokens"."role" IN ('admin', 'member')
						AND "invite_tokens"."expires_at" <= "invite_tokens"."created_at" + interval '7 days')
				)),
	CONSTRAINT "invite_tokens_used_timestamp_order_check" CHECK ("invite_tokens"."used_at" IS NULL
				OR ("invite_tokens"."used_at" >= "invite_tokens"."created_at"
					AND "invite_tokens"."used_at" < "invite_tokens"."expires_at"))
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"base_price_cents" integer DEFAULT 0 NOT NULL,
	"api_calls_count" bigint DEFAULT 0 NOT NULL,
	"api_calls_included" bigint DEFAULT 10000 NOT NULL,
	"overage_calls" bigint DEFAULT 0 NOT NULL,
	"overage_cost_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'usd' NOT NULL,
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
	CONSTRAINT "invoices_usage_safe_integer_check" CHECK ("invoices"."api_calls_count" <= 9007199254740991
				AND "invoices"."api_calls_included" <= 9007199254740991
				AND "invoices"."overage_calls" <= 9007199254740991),
	CONSTRAINT "invoices_failure_not_draft_check" CHECK ("invoices"."first_payment_failed_at" IS NULL OR "invoices"."status" <> 'draft'),
	CONSTRAINT "invoices_currency_check" CHECK ("invoices"."currency" = 'usd')
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
	"visits" bigint DEFAULT 0 NOT NULL,
	"conversions" bigint DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landing_pages_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "landing_pages_slug_format_check" CHECK ("landing_pages"."slug" ~ '^[a-z0-9][a-z0-9_-]{0,99}$'),
	CONSTRAINT "landing_pages_config_version_check" CHECK (jsonb_typeof("landing_pages"."config") = 'object'
				AND "landing_pages"."config" ->> 'version' = '1'),
	CONSTRAINT "landing_pages_counts_nonnegative_check" CHECK ("landing_pages"."visits" BETWEEN 0 AND 9007199254740991
				AND "landing_pages"."conversions" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "landing_pages_timestamp_order_check" CHECK ("landing_pages"."updated_at" >= "landing_pages"."created_at")
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
	"storage_bucket_locator" text NOT NULL,
	"storage_region" text NOT NULL,
	"storage_location_id" text,
	"storage_credential_version" integer,
	"url" text,
	"thumbnail_key" text,
	"thumbnail_storage_provider" "storage_provider",
	"thumbnail_storage_bucket_locator" text,
	"thumbnail_storage_region" text,
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
				AND ("media"."duration" IS NULL OR "media"."duration" >= 0)),
	CONSTRAINT "media_storage_locator_check" CHECK (length(btrim("media"."storage_bucket_locator")) > 0
				AND length("media"."storage_bucket_locator") <= 255
				AND length(btrim("media"."storage_region")) > 0
				AND length("media"."storage_region") <= 128
				AND ("media"."storage_provider" <> 'r2'
					OR "media"."storage_region" IN ('default', 'eu'))),
	CONSTRAINT "media_storage_authority_check" CHECK (("media"."storage_provider" = 'r2'
					AND "media"."storage_location_id" IS NULL
					AND "media"."storage_credential_version" IS NULL)
				OR ("media"."storage_provider" = 'byos'
					AND "media"."storage_location_id" IS NOT NULL
					AND "media"."storage_credential_version" IS NOT NULL
					AND "media"."storage_credential_version" > 0)),
	CONSTRAINT "media_thumbnail_storage_locator_check" CHECK ((
					"media"."thumbnail_key" IS NULL
					AND "media"."thumbnail_storage_provider" IS NULL
					AND "media"."thumbnail_storage_bucket_locator" IS NULL
					AND "media"."thumbnail_storage_region" IS NULL
				) OR (
					"media"."thumbnail_key" IS NOT NULL
					AND "media"."thumbnail_storage_provider" IS NOT NULL
					AND "media"."thumbnail_storage_provider" = 'r2'
					AND "media"."thumbnail_storage_bucket_locator" IS NOT NULL
					AND length(btrim("media"."thumbnail_storage_bucket_locator")) > 0
					AND length("media"."thumbnail_storage_bucket_locator") <= 255
					AND "media"."thumbnail_storage_region" IS NOT NULL
					AND "media"."thumbnail_storage_region" IN ('default', 'eu')
				)),
	CONSTRAINT "media_thumbnail_projection_check" CHECK (("media"."thumbnail_status" <> 'generated'
					OR ("media"."thumbnail_key" IS NOT NULL
						AND "media"."thumbnail_url" IS NOT NULL))
				AND ("media"."thumbnail_url" IS NULL
					OR "media"."thumbnail_status" = 'generated'))
);
--> statement-breakpoint
CREATE TABLE "auth"."member" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"organizationId" text NOT NULL,
	"role" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_id_organization_uniq" UNIQUE("id","organizationId"),
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" IN ('post_failed', 'post_published', 'account_disconnected', 'payment_failed', 'usage_warning', 'weekly_digest', 'marketing', 'streak_warning', 'automation_notice'))
);
--> statement-breakpoint
CREATE TABLE "one_time_capabilities" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"organization_id" text,
	"payload_ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "one_time_capabilities_kind_check" CHECK ("one_time_capabilities"."kind" IN ('oauth_state', 'websocket_ticket'))
);
--> statement-breakpoint
CREATE TABLE "operator_resolution_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"action" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_digest" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"before_state" jsonb NOT NULL,
	"after_state" jsonb NOT NULL,
	"target_updated_at_before" timestamp with time zone NOT NULL,
	"target_updated_at_after" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_resolution_evidence_target_type_check" CHECK ("operator_resolution_evidence"."target_type" IN ('automation_effect', 'automation_binding', 'automation_conversion_event', 'stripe_event', 'billing_operation', 'tenant_erasure_job', 'workspace_erasure_job', 'account_revocation_job', 'external_subject_cleanup_job', 'short_link_creation', 'customer_webhook_delivery', 'tool_job', 'whatsapp_phone_provisioning_operation', 'whatsapp_phone_release_operation', 'whatsapp_phone_billing_operation', 'ad_creation_operation', 'ad_mutation_operation')),
	CONSTRAINT "operator_resolution_evidence_action_check" CHECK ("operator_resolution_evidence"."action" IN ('mark_succeeded', 'mark_not_applied', 'retry', 'abandon')),
	CONSTRAINT "operator_resolution_evidence_target_action_check" CHECK (("operator_resolution_evidence"."target_type" = 'automation_effect'
					AND "operator_resolution_evidence"."action" IN ('mark_succeeded', 'mark_not_applied'))
				OR ("operator_resolution_evidence"."target_type" = 'automation_binding'
					AND "operator_resolution_evidence"."action" IN ('mark_succeeded', 'mark_not_applied', 'retry'))
				OR ("operator_resolution_evidence"."target_type" = 'automation_conversion_event'
					AND "operator_resolution_evidence"."action" = 'retry')
				OR ("operator_resolution_evidence"."target_type" = 'stripe_event'
					AND "operator_resolution_evidence"."action" IN ('retry', 'abandon'))
				OR ("operator_resolution_evidence"."target_type" = 'billing_operation'
					AND "operator_resolution_evidence"."action" IN ('mark_succeeded', 'mark_not_applied', 'retry', 'abandon'))
				OR ("operator_resolution_evidence"."target_type" IN ('tenant_erasure_job', 'workspace_erasure_job')
					AND "operator_resolution_evidence"."action" = 'retry')
				OR ("operator_resolution_evidence"."target_type" = 'account_revocation_job'
					AND "operator_resolution_evidence"."action" IN ('mark_succeeded', 'mark_not_applied', 'abandon'))
				OR ("operator_resolution_evidence"."target_type" = 'external_subject_cleanup_job'
					AND "operator_resolution_evidence"."action" IN ('mark_succeeded', 'retry'))
				OR ("operator_resolution_evidence"."target_type" = 'short_link_creation'
					AND "operator_resolution_evidence"."action" IN ('mark_succeeded', 'mark_not_applied'))
						OR ("operator_resolution_evidence"."target_type" = 'customer_webhook_delivery'
							AND "operator_resolution_evidence"."action" IN ('mark_succeeded', 'mark_not_applied', 'retry', 'abandon'))
					OR ("operator_resolution_evidence"."target_type" = 'tool_job'
						AND "operator_resolution_evidence"."action" IN ('mark_not_applied', 'abandon'))
					OR ("operator_resolution_evidence"."target_type" = 'whatsapp_phone_provisioning_operation'
					AND "operator_resolution_evidence"."action" IN ('mark_succeeded', 'mark_not_applied', 'retry'))
				OR ("operator_resolution_evidence"."target_type" = 'whatsapp_phone_release_operation'
					AND "operator_resolution_evidence"."action" IN ('mark_succeeded', 'mark_not_applied', 'retry'))
				OR ("operator_resolution_evidence"."target_type" = 'ad_creation_operation'
					AND "operator_resolution_evidence"."action" IN ('mark_succeeded', 'mark_not_applied', 'retry'))
				OR ("operator_resolution_evidence"."target_type" = 'whatsapp_phone_billing_operation'
					AND "operator_resolution_evidence"."action" IN ('mark_succeeded', 'mark_not_applied'))
				OR ("operator_resolution_evidence"."target_type" = 'ad_mutation_operation'
					AND "operator_resolution_evidence"."action" IN ('mark_succeeded', 'mark_not_applied', 'retry'))),
	CONSTRAINT "operator_resolution_evidence_identity_check" CHECK (length(btrim("operator_resolution_evidence"."target_id")) BETWEEN 1 AND 255
				AND ("operator_resolution_evidence"."organization_id" IS NULL
					OR length(btrim("operator_resolution_evidence"."organization_id")) BETWEEN 1 AND 255)
				AND length(btrim("operator_resolution_evidence"."actor_user_id")) BETWEEN 1 AND 255),
	CONSTRAINT "operator_resolution_evidence_reason_check" CHECK ("operator_resolution_evidence"."reason_code" IN ('operator_asserted_succeeded', 'operator_asserted_not_applied', 'operator_requested_retry', 'operator_abandoned')
				AND "operator_resolution_evidence"."reason_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "operator_resolution_evidence_state_check" CHECK (jsonb_typeof("operator_resolution_evidence"."before_state") = 'object'
				AND jsonb_typeof("operator_resolution_evidence"."after_state") = 'object'
				AND NOT jsonb_path_exists("operator_resolution_evidence"."before_state", '$.* ? (@.type() == "object" || @.type() == "array")')
				AND NOT jsonb_path_exists("operator_resolution_evidence"."after_state", '$.* ? (@.type() == "object" || @.type() == "array")')),
	CONSTRAINT "operator_resolution_evidence_stripe_abandon_check" CHECK (NOT ("operator_resolution_evidence"."target_type" = 'stripe_event' AND "operator_resolution_evidence"."action" = 'abandon')
				OR COALESCE(("operator_resolution_evidence"."after_state"->>'reconciliation_reference_sha256' ~ '^[0-9a-f]{64}$'
					AND "operator_resolution_evidence"."after_state"->>'status' = 'failed'
					AND "operator_resolution_evidence"."after_state"->>'error_class' = 'permanent'
					AND "operator_resolution_evidence"."after_state"->>'operator_retry_requested' = 'false'
					AND NOT ("operator_resolution_evidence"."after_state" ? 'provider_reference')), FALSE)),
	CONSTRAINT "operator_resolution_evidence_timestamp_order_check" CHECK ("operator_resolution_evidence"."target_updated_at_after" >= "operator_resolution_evidence"."target_updated_at_before"
				AND "operator_resolution_evidence"."resolved_at" >= "operator_resolution_evidence"."target_updated_at_after")
);
--> statement-breakpoint
CREATE TABLE "operator_resolution_notes" (
	"evidence_id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"note_ciphertext" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operator_resolution_notes_ciphertext_check" CHECK ("operator_resolution_notes"."note_ciphertext" LIKE 'enc:v2:%'),
	CONSTRAINT "operator_resolution_notes_expiry_check" CHECK ("operator_resolution_notes"."expires_at" = "operator_resolution_notes"."created_at" + interval '90 days')
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
CREATE TABLE "organization_principals" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"member_id" text,
	"service_name" text,
	"scope_mode" text NOT NULL,
	"lifecycle_status" text DEFAULT 'active' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_principals_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "organization_principals_id_org_scope_uniq" UNIQUE("id","organization_id","scope_mode"),
	CONSTRAINT "organization_principals_kind_check" CHECK ("organization_principals"."kind" IN ('member', 'service')),
	CONSTRAINT "organization_principals_scope_mode_check" CHECK ("organization_principals"."scope_mode" IN ('all', 'selected')),
	CONSTRAINT "organization_principals_lifecycle_status_check" CHECK ("organization_principals"."lifecycle_status" IN ('active', 'disabled')),
	CONSTRAINT "organization_principals_identity_tuple_check" CHECK (("organization_principals"."kind" = 'member'
					AND "organization_principals"."service_name" IS NULL
					AND (
						"organization_principals"."member_id" IS NOT NULL
						OR "organization_principals"."lifecycle_status" = 'disabled'
					))
				OR ("organization_principals"."kind" = 'service'
					AND "organization_principals"."member_id" IS NULL
					AND length(btrim("organization_principals"."service_name")) BETWEEN 1 AND 120)),
	CONSTRAINT "organization_principals_lifecycle_check" CHECK (("organization_principals"."lifecycle_status" = 'active' AND "organization_principals"."disabled_at" IS NULL)
				OR ("organization_principals"."lifecycle_status" = 'disabled' AND "organization_principals"."disabled_at" IS NOT NULL)),
	CONSTRAINT "organization_principals_timestamp_order_check" CHECK ("organization_principals"."updated_at" >= "organization_principals"."created_at"
				AND ("organization_principals"."disabled_at" IS NULL OR "organization_principals"."disabled_at" >= "organization_principals"."created_at"))
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
	"source" text DEFAULT 'stripe' NOT NULL,
	"delinquent_at" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone DEFAULT now() NOT NULL,
	"current_period_end" timestamp with time zone,
	"stripe_customer_id" text,
	"stripe_checkout_session_id" text,
	"stripe_subscription_id" text,
	"stripe_metered_item_id" text,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"ai_enabled" boolean DEFAULT false NOT NULL,
	"daily_tool_limit_override" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_subscriptions_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "organization_subscriptions_daily_tool_limit_override_check" CHECK ("organization_subscriptions"."daily_tool_limit_override" IS NULL OR "organization_subscriptions"."daily_tool_limit_override" >= 0),
	CONSTRAINT "organization_subscriptions_period_check" CHECK ("organization_subscriptions"."current_period_end" IS NULL OR "organization_subscriptions"."current_period_end" > "organization_subscriptions"."current_period_start"),
	CONSTRAINT "organization_subscriptions_source_check" CHECK ("organization_subscriptions"."source" IN ('stripe', 'complimentary')),
	CONSTRAINT "organization_subscriptions_stripe_authority_check" CHECK (("organization_subscriptions"."source" = 'complimentary'
					AND "organization_subscriptions"."status" IN ('active', 'cancelled')
					AND "organization_subscriptions"."stripe_subscription_id" IS NULL
					AND "organization_subscriptions"."stripe_metered_item_id" IS NULL)
				OR ("organization_subscriptions"."source" = 'stripe'
					AND ("organization_subscriptions"."status" = 'cancelled'
						OR ("organization_subscriptions"."status" IN ('active', 'trialing', 'past_due')
							AND "organization_subscriptions"."stripe_customer_id" IS NOT NULL
							AND "organization_subscriptions"."stripe_subscription_id" IS NOT NULL)))),
	CONSTRAINT "organization_subscriptions_past_due_check" CHECK (("organization_subscriptions"."status" = 'past_due') =
					("organization_subscriptions"."delinquent_at" IS NOT NULL AND "organization_subscriptions"."grace_ends_at" IS NOT NULL)
				AND ("organization_subscriptions"."status" = 'past_due'
					OR ("organization_subscriptions"."delinquent_at" IS NULL AND "organization_subscriptions"."grace_ends_at" IS NULL))
				AND ("organization_subscriptions"."grace_ends_at" IS NULL
					OR "organization_subscriptions"."grace_ends_at" = "organization_subscriptions"."delinquent_at" + INTERVAL '14 days'))
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
	"observation_window_start" timestamp with time zone NOT NULL,
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
	CONSTRAINT "post_tags_pk" PRIMARY KEY("organization_id","tag_id","post_id"),
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
	"provider_disposition" text,
	"provider_operation_id" text,
	"provider_state" text,
	"provider_effects" jsonb,
	"next_reconcile_at" timestamp with time zone,
	"reconcile_attempts" integer DEFAULT 0 NOT NULL,
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
	CONSTRAINT "post_targets_lease_order_check" CHECK ("post_targets"."lease_expires_at" IS NULL OR ("post_targets"."claimed_at" IS NOT NULL AND "post_targets"."lease_expires_at" > "post_targets"."claimed_at")),
	CONSTRAINT "post_targets_reconcile_attempts_nonnegative_check" CHECK ("post_targets"."reconcile_attempts" >= 0),
	CONSTRAINT "post_targets_provider_disposition_check" CHECK ("post_targets"."provider_disposition" IS NULL OR "post_targets"."provider_disposition" IN ('published', 'sent', 'delivered', 'scheduled', 'accepted', 'processing', 'pending_review', 'awaiting_user_action', 'partial', 'failed', 'outcome_unknown'))
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
	"metrics_next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metrics_poll_attempts" integer DEFAULT 0 NOT NULL,
	"metrics_poll_last_error" text,
	"metrics_poll_last_error_class" text,
	"metrics_refresh_window_start" timestamp with time zone,
	"metrics_refresh_lease_expires_at" timestamp with time zone,
	"metrics_refresh_started_at" timestamp with time zone,
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
	CONSTRAINT "posts_metrics_poll_state_check" CHECK ("posts"."metrics_poll_attempts" >= 0
				AND ("posts"."metrics_poll_last_error_class" IS NULL
					OR "posts"."metrics_poll_last_error_class" IN ('transient', 'rate_limited', 'permanent'))),
	CONSTRAINT "posts_revision_nonnegative_check" CHECK ("posts"."revision" >= 0),
	CONSTRAINT "posts_metrics_refresh_claim_check" CHECK (("posts"."metrics_refresh_lease_expires_at" IS NULL
					AND "posts"."metrics_refresh_started_at" IS NULL)
				OR ("posts"."metrics_refresh_lease_expires_at" IS NOT NULL
					AND "posts"."metrics_refresh_window_start" IS NOT NULL
					AND ("posts"."metrics_refresh_started_at" IS NULL
						OR "posts"."metrics_refresh_started_at" <= "posts"."metrics_refresh_lease_expires_at")))
);
--> statement-breakpoint
CREATE TABLE "principal_workspace_grants" (
	"organization_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"scope_mode" text DEFAULT 'selected' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principal_workspace_grants_pkey" PRIMARY KEY("organization_id","principal_id","workspace_id"),
	CONSTRAINT "principal_workspace_grants_scope_mode_check" CHECK ("principal_workspace_grants"."scope_mode" = 'selected')
);
--> statement-breakpoint
CREATE TABLE "public_growth_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"event_type" text NOT NULL,
	"ref_url_id" text,
	"qr_code_id" text,
	"landing_page_id" text,
	"contact_id" text,
	"contact_organization_id" text,
	"contact_scope_key" text,
	"automation_id" text,
	"automation_organization_id" text,
	"automation_scope_key" text,
	"idempotency_hash" varchar(64) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_growth_events_type_check" CHECK ("public_growth_events"."event_type" IN ('ref_visit', 'qr_scan', 'landing_view', 'landing_conversion')),
	CONSTRAINT "public_growth_events_target_union_check" CHECK (("public_growth_events"."event_type" = 'ref_visit'
					AND "public_growth_events"."ref_url_id" IS NOT NULL
					AND "public_growth_events"."qr_code_id" IS NULL
					AND "public_growth_events"."landing_page_id" IS NULL)
				OR ("public_growth_events"."event_type" = 'qr_scan'
					AND "public_growth_events"."ref_url_id" IS NULL
					AND "public_growth_events"."qr_code_id" IS NOT NULL
					AND "public_growth_events"."landing_page_id" IS NULL)
				OR ("public_growth_events"."event_type" IN ('landing_view', 'landing_conversion')
					AND "public_growth_events"."ref_url_id" IS NULL
					AND "public_growth_events"."qr_code_id" IS NULL
					AND "public_growth_events"."landing_page_id" IS NOT NULL)),
	CONSTRAINT "public_growth_events_contact_scope_check" CHECK (("public_growth_events"."contact_id" IS NULL
					AND "public_growth_events"."contact_organization_id" IS NULL
					AND "public_growth_events"."contact_scope_key" IS NULL)
				OR ("public_growth_events"."contact_id" IS NOT NULL
					AND "public_growth_events"."contact_organization_id" = "public_growth_events"."organization_id"
					AND "public_growth_events"."contact_scope_key" = "public_growth_events"."scope_key")),
	CONSTRAINT "public_growth_events_automation_scope_check" CHECK (("public_growth_events"."automation_id" IS NULL
					AND "public_growth_events"."automation_organization_id" IS NULL
					AND "public_growth_events"."automation_scope_key" IS NULL)
				OR ("public_growth_events"."automation_id" IS NOT NULL
					AND "public_growth_events"."automation_organization_id" = "public_growth_events"."organization_id"
					AND "public_growth_events"."automation_scope_key" = "public_growth_events"."scope_key")),
	CONSTRAINT "public_growth_events_idempotency_hash_check" CHECK ("public_growth_events"."idempotency_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "public_growth_events_status_check" CHECK ("public_growth_events"."status" IN ('pending', 'processing', 'retry', 'succeeded', 'failed')),
	CONSTRAINT "public_growth_events_counters_check" CHECK ("public_growth_events"."attempts" >= 0 AND "public_growth_events"."lease_token" >= 0),
	CONSTRAINT "public_growth_events_lease_state_check" CHECK (("public_growth_events"."status" = 'processing' AND "public_growth_events"."lease_expires_at" IS NOT NULL)
				OR ("public_growth_events"."status" <> 'processing' AND "public_growth_events"."lease_expires_at" IS NULL)),
	CONSTRAINT "public_growth_events_terminal_state_check" CHECK (("public_growth_events"."status" IN ('succeeded', 'failed') AND "public_growth_events"."completed_at" IS NOT NULL)
				OR ("public_growth_events"."status" NOT IN ('succeeded', 'failed') AND "public_growth_events"."completed_at" IS NULL)),
	CONSTRAINT "public_growth_events_timestamp_order_check" CHECK ("public_growth_events"."updated_at" >= "public_growth_events"."occurred_at"
				AND "public_growth_events"."next_attempt_at" >= "public_growth_events"."occurred_at"
				AND ("public_growth_events"."completed_at" IS NULL OR "public_growth_events"."completed_at" >= "public_growth_events"."occurred_at"))
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
	"provider_operation_id" text,
	"provider_disposition" text,
	"provider_state" text,
	"provider_effects" jsonb,
	"error" text,
	CONSTRAINT "publish_attempts_id_target_operation_uniq" UNIQUE("id","post_target_id","publish_operation_id"),
	CONSTRAINT "publish_attempts_state_check" CHECK ("publish_attempts"."state" IN ('in_flight', 'succeeded', 'failed', 'unknown')),
	CONSTRAINT "publish_attempts_lease_order_check" CHECK ("publish_attempts"."lease_expires_at" > "publish_attempts"."claimed_at"),
	CONSTRAINT "publish_attempts_completion_check" CHECK (("publish_attempts"."state" = 'in_flight' AND "publish_attempts"."completed_at" IS NULL)
				OR ("publish_attempts"."state" IN ('succeeded', 'failed', 'unknown')
					AND "publish_attempts"."completed_at" IS NOT NULL)),
	CONSTRAINT "publish_attempts_timestamp_order_check" CHECK ("publish_attempts"."completed_at" IS NULL OR "publish_attempts"."completed_at" >= "publish_attempts"."claimed_at"),
	CONSTRAINT "publish_attempts_provider_disposition_check" CHECK ("publish_attempts"."provider_disposition" IS NULL OR "publish_attempts"."provider_disposition" IN ('published', 'sent', 'delivered', 'scheduled', 'accepted', 'processing', 'pending_review', 'awaiting_user_action', 'partial', 'failed', 'outcome_unknown'))
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
	"public_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"ref_url_id" text NOT NULL,
	"label" text NOT NULL,
	"campaign_key" text,
	"scan_count" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qr_codes_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "qr_codes_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "qr_codes_scan_count_safe_integer_check" CHECK ("qr_codes"."scan_count" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "qr_codes_public_id_format_check" CHECK ("qr_codes"."public_id" ~ '^qrp_[0-9a-f]{32}$'),
	CONSTRAINT "qr_codes_label_check" CHECK (length(btrim("qr_codes"."label")) BETWEEN 1 AND 120),
	CONSTRAINT "qr_codes_campaign_key_check" CHECK ("qr_codes"."campaign_key" IS NULL OR "qr_codes"."campaign_key" ~ '^[a-z0-9][a-z0-9_-]{0,99}$'),
	CONSTRAINT "qr_codes_timestamp_order_check" CHECK ("qr_codes"."updated_at" >= "qr_codes"."created_at")
);
--> statement-breakpoint
CREATE TABLE "queue_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"queue_name" text NOT NULL,
	"message_id" text NOT NULL,
	"organization_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"workspace_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"user_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"contact_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"account_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"operation_id" text,
	"failure_kind" text NOT NULL,
	"status" text DEFAULT 'unresolved' NOT NULL,
	"attempts" integer NOT NULL,
	"payload_ciphertext" text,
	"payload_key_id" text,
	"payload_expires_at" timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL,
	"payload_redacted_at" timestamp with time zone,
	"purge_at" timestamp with time zone DEFAULT now() + interval '90 days' NOT NULL,
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
				OR ("queue_failures"."status" NOT IN ('replayed', 'dismissed') AND "queue_failures"."resolved_at" IS NULL)),
	CONSTRAINT "queue_failures_payload_lifecycle_check" CHECK (("queue_failures"."payload_ciphertext" IS NOT NULL
					AND "queue_failures"."payload_key_id" IS NOT NULL
					AND "queue_failures"."payload_redacted_at" IS NULL)
				OR ("queue_failures"."payload_ciphertext" IS NULL
					AND "queue_failures"."payload_key_id" IS NULL
					AND "queue_failures"."payload_redacted_at" IS NOT NULL)),
	CONSTRAINT "queue_failures_retention_clock_check" CHECK ("queue_failures"."payload_expires_at" > "queue_failures"."created_at"
				AND "queue_failures"."purge_at" >= "queue_failures"."payload_expires_at"
				AND ("queue_failures"."payload_redacted_at" IS NULL
					OR "queue_failures"."payload_redacted_at" >= "queue_failures"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "queue_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text,
	"slots" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_schedules_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "queue_schedules_name_check" CHECK ("queue_schedules"."name" IS NULL OR (length(btrim("queue_schedules"."name")) > 0 AND length("queue_schedules"."name") <= 255)),
	CONSTRAINT "queue_schedules_slots_check" CHECK (jsonb_typeof("queue_schedules"."slots") = 'array' AND jsonb_array_length("queue_schedules"."slots") > 0),
	CONSTRAINT "queue_schedules_timestamp_order_check" CHECK ("queue_schedules"."updated_at" >= "queue_schedules"."created_at")
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
	"destination_type" text NOT NULL,
	"destination_url" text,
	"landing_page_id" text,
	"automation_id" text,
	"uses" bigint DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ref_urls_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "ref_urls_slug_format_check" CHECK ("ref_urls"."slug" ~ '^[a-z0-9][a-z0-9_-]{0,99}$'),
	CONSTRAINT "ref_urls_destination_type_check" CHECK ("ref_urls"."destination_type" IN ('https_url', 'landing_page')),
	CONSTRAINT "ref_urls_destination_union_check" CHECK (("ref_urls"."destination_type" = 'https_url'
					AND "ref_urls"."destination_url" IS NOT NULL
					AND "ref_urls"."destination_url" ~ '^https://'
					AND "ref_urls"."landing_page_id" IS NULL)
				OR ("ref_urls"."destination_type" = 'landing_page'
					AND "ref_urls"."destination_url" IS NULL
					AND "ref_urls"."landing_page_id" IS NOT NULL)),
	CONSTRAINT "ref_urls_uses_safe_integer_check" CHECK ("ref_urls"."uses" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "ref_urls_timestamp_order_check" CHECK ("ref_urls"."updated_at" >= "ref_urls"."created_at")
);
--> statement-breakpoint
CREATE TABLE "retention_drain_runs" (
	"handler_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"cursor_due_at" timestamp with time zone,
	"cursor_row_id" text,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"rows_last_run" integer DEFAULT 0 NOT NULL,
	"backlog_oldest_due_at" timestamp with time zone,
	"consecutive_more_due" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	CONSTRAINT "retention_drain_runs_handler_id_check" CHECK (length("retention_drain_runs"."handler_id") BETWEEN 1 AND 100
				AND "retention_drain_runs"."handler_id" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "retention_drain_runs_status_check" CHECK ("retention_drain_runs"."status" IN ('idle', 'running', 'manual_review')),
	CONSTRAINT "retention_drain_runs_counters_check" CHECK ("retention_drain_runs"."lease_token" >= 0
				AND "retention_drain_runs"."rows_last_run" >= 0
				AND "retention_drain_runs"."consecutive_more_due" >= 0),
	CONSTRAINT "retention_drain_runs_lease_check" CHECK (("retention_drain_runs"."status" = 'running'
					AND "retention_drain_runs"."lease_expires_at" IS NOT NULL
					AND "retention_drain_runs"."last_started_at" IS NOT NULL
					AND "retention_drain_runs"."lease_expires_at" > "retention_drain_runs"."last_started_at")
				OR ("retention_drain_runs"."status" <> 'running'
					AND "retention_drain_runs"."lease_expires_at" IS NULL)),
	CONSTRAINT "retention_drain_runs_cursor_check" CHECK (("retention_drain_runs"."cursor_due_at" IS NULL AND "retention_drain_runs"."cursor_row_id" IS NULL)
				OR ("retention_drain_runs"."cursor_due_at" IS NOT NULL
					AND "retention_drain_runs"."cursor_row_id" IS NOT NULL
					AND length("retention_drain_runs"."cursor_row_id") BETWEEN 1 AND 256)),
	CONSTRAINT "retention_drain_runs_completion_check" CHECK ("retention_drain_runs"."last_finished_at" IS NULL
				OR ("retention_drain_runs"."last_started_at" IS NOT NULL
					AND "retention_drain_runs"."last_finished_at" >= "retention_drain_runs"."last_started_at")),
	CONSTRAINT "retention_drain_runs_manual_review_check" CHECK ("retention_drain_runs"."status" <> 'manual_review'
				OR ("retention_drain_runs"."backlog_oldest_due_at" IS NOT NULL
					AND "retention_drain_runs"."last_finished_at" IS NOT NULL)),
	CONSTRAINT "retention_drain_runs_error_code_check" CHECK ("retention_drain_runs"."last_error_code" IS NULL
				OR (length("retention_drain_runs"."last_error_code") BETWEEN 1 AND 100
					AND "retention_drain_runs"."last_error_code" ~ '^[a-z][a-z0-9_]*$'))
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"filter" jsonb,
	"is_dynamic" boolean DEFAULT true NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segments_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "segments_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "segments_static_membership_parent_uniq" UNIQUE("id","organization_id","scope_key","is_dynamic"),
	CONSTRAINT "segments_member_count_nonnegative_check" CHECK ("segments"."member_count" >= 0),
	CONSTRAINT "segments_filter_mode_check" CHECK ((NOT "segments"."is_dynamic" AND "segments"."filter" IS NULL)
				OR ("segments"."is_dynamic"
					AND "segments"."filter" IS NOT NULL
					AND jsonb_typeof("segments"."filter") = 'object'
					AND ("segments"."filter" - 'all' - 'any' - 'none') = '{}'::jsonb
					AND (
						CASE WHEN jsonb_typeof("segments"."filter" -> 'all') = 'array'
							THEN jsonb_array_length("segments"."filter" -> 'all') ELSE 0 END
						+ CASE WHEN jsonb_typeof("segments"."filter" -> 'any') = 'array'
							THEN jsonb_array_length("segments"."filter" -> 'any') ELSE 0 END
						+ CASE WHEN jsonb_typeof("segments"."filter" -> 'none') = 'array'
							THEN jsonb_array_length("segments"."filter" -> 'none') ELSE 0 END
					) BETWEEN 1 AND 50
					AND ("segments"."filter" -> 'all' IS NULL OR jsonb_typeof("segments"."filter" -> 'all') = 'array')
					AND ("segments"."filter" -> 'any' IS NULL OR jsonb_typeof("segments"."filter" -> 'any') = 'array')
					AND ("segments"."filter" -> 'none' IS NULL OR jsonb_typeof("segments"."filter" -> 'none') = 'array'))),
	CONSTRAINT "segments_dynamic_member_count_zero_check" CHECK (NOT "segments"."is_dynamic" OR "segments"."member_count" = 0)
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
	"domain" text,
	"provider_config_version" integer DEFAULT 1 NOT NULL,
	"credential_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "short_link_configs_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "short_link_configs_version_check" CHECK ("short_link_configs"."provider_config_version" > 0
				AND ("short_link_configs"."credential_version" IS NULL OR "short_link_configs"."credential_version" > 0)),
	CONSTRAINT "short_link_configs_provider_credential_check" CHECK (("short_link_configs"."provider" IS NULL AND "short_link_configs"."credential_version" IS NULL)
				OR ("short_link_configs"."provider" = 'relayapi' AND "short_link_configs"."credential_version" IS NULL)
				OR ("short_link_configs"."provider" IN ('dub', 'short_io', 'bitly')
					AND "short_link_configs"."credential_version" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "short_link_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"version" integer NOT NULL,
	"api_key_ciphertext" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "short_link_credentials_id_org_provider_version_uniq" UNIQUE("id","organization_id","provider","version"),
	CONSTRAINT "short_link_credentials_org_provider_version_uniq" UNIQUE("organization_id","provider","version"),
	CONSTRAINT "short_link_credentials_version_check" CHECK ("short_link_credentials"."version" > 0),
	CONSTRAINT "short_link_credentials_ciphertext_check" CHECK ("short_link_credentials"."api_key_ciphertext" LIKE 'enc:v2:%'
				AND length("short_link_credentials"."api_key_ciphertext") BETWEEN 1 AND 8192),
	CONSTRAINT "short_link_credentials_state_check" CHECK ("short_link_credentials"."state" IN ('active', 'retired')),
	CONSTRAINT "short_link_credentials_state_tuple_check" CHECK (("short_link_credentials"."state" = 'active' AND "short_link_credentials"."retired_at" IS NULL)
				OR ("short_link_credentials"."state" = 'retired' AND "short_link_credentials"."retired_at" IS NOT NULL
					AND "short_link_credentials"."retired_at" >= "short_link_credentials"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "short_links" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"original_url" text NOT NULL,
	"provider" text DEFAULT 'relayapi' NOT NULL,
	"provider_config_version" integer DEFAULT 1 NOT NULL,
	"credential_version" integer,
	"provider_ref" jsonb NOT NULL,
	"creation_status" text DEFAULT 'pending' NOT NULL,
	"creation_fence" integer DEFAULT 0 NOT NULL,
	"creation_started_at" timestamp with time zone,
	"creation_completed_at" timestamp with time zone,
	"creation_last_error" text,
	"short_code" text,
	"short_url" text,
	"post_id" text,
	"click_count" integer DEFAULT 0 NOT NULL,
	"last_click_sync_at" timestamp with time zone,
	"next_click_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
	"click_sync_generation" integer DEFAULT 0 NOT NULL,
	"click_sync_lease_expires_at" timestamp with time zone,
	"click_sync_started_at" timestamp with time zone,
	"click_sync_attempts" integer DEFAULT 0 NOT NULL,
	"click_sync_last_error" text,
	"click_sync_last_error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "short_links_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key"),
	CONSTRAINT "short_links_creation_status_check" CHECK ("short_links"."creation_status" IN ('pending', 'active', 'manual_review')),
	CONSTRAINT "short_links_provider_ref_check" CHECK (jsonb_typeof("short_links"."provider_ref") = 'object'
				AND octet_length("short_links"."provider_ref"::text) <= 2048
				AND "short_links"."provider_ref"->>'provider' = "short_links"."provider"
				AND (
					("short_links"."provider" = 'relayapi'
						AND jsonb_typeof("short_links"."provider_ref"->'shortCode') = 'string'
						AND length("short_links"."provider_ref"->>'shortCode') BETWEEN 1 AND 180)
					OR ("short_links"."provider" = 'dub'
						AND jsonb_typeof("short_links"."provider_ref"->'externalId') = 'string'
						AND length("short_links"."provider_ref"->>'externalId') BETWEEN 1 AND 180)
					OR ("short_links"."provider" IN ('short_io', 'bitly')
						AND jsonb_typeof("short_links"."provider_ref"->'intentId') = 'string'
						AND length("short_links"."provider_ref"->>'intentId') BETWEEN 1 AND 180)
				)
				AND (
					NOT (
						"short_links"."creation_status" = 'active'
						OR ("short_links"."creation_status" = 'manual_review'
							AND "short_links"."short_url" IS NOT NULL)
					)
					OR ("short_links"."provider" = 'relayapi'
						AND "short_links"."provider_ref"->>'shortCode' = "short_links"."short_code")
					OR ("short_links"."provider" = 'dub')
					OR ("short_links"."provider" = 'short_io'
						AND jsonb_typeof("short_links"."provider_ref"->'idString') = 'string'
						AND length("short_links"."provider_ref"->>'idString') BETWEEN 1 AND 180
						AND jsonb_typeof("short_links"."provider_ref"->'domainId') = 'number')
					OR ("short_links"."provider" = 'bitly'
						AND jsonb_typeof("short_links"."provider_ref"->'bitlink') = 'string'
						AND length("short_links"."provider_ref"->>'bitlink') BETWEEN 1 AND 512
						AND jsonb_typeof("short_links"."provider_ref"->'editedOrCustom') = 'boolean')
				)),
	CONSTRAINT "short_links_creation_state_check" CHECK ("short_links"."provider_config_version" > 0
				AND "short_links"."creation_fence" >= 0
				AND (
					("short_links"."creation_status" = 'pending'
						AND "short_links"."provider" <> 'relayapi'
						AND "short_links"."creation_fence" > 0
						AND "short_links"."short_code" IS NULL
						AND "short_links"."short_url" IS NULL
						AND "short_links"."creation_started_at" IS NOT NULL
						AND "short_links"."creation_completed_at" IS NULL
						AND "short_links"."creation_last_error" IS NULL)
					OR ("short_links"."creation_status" = 'active'
						AND "short_links"."short_code" IS NOT NULL
						AND "short_links"."short_url" IS NOT NULL
						AND "short_links"."short_url" ~ '^https?://'
						AND "short_links"."creation_completed_at" IS NOT NULL
						AND "short_links"."creation_last_error" IS NULL
						AND (
							("short_links"."provider" = 'relayapi'
								AND "short_links"."creation_fence" = 0
								AND "short_links"."creation_started_at" IS NULL)
							OR ("short_links"."provider" <> 'relayapi'
								AND "short_links"."creation_fence" > 0
								AND "short_links"."creation_started_at" IS NOT NULL
								AND "short_links"."creation_completed_at" >= "short_links"."creation_started_at")
						))
					OR ("short_links"."creation_status" = 'manual_review'
						AND "short_links"."provider" <> 'relayapi'
						AND "short_links"."creation_fence" > 0
						AND (
							("short_links"."short_code" IS NULL
								AND "short_links"."short_url" IS NULL)
							OR ("short_links"."short_code" IS NOT NULL
								AND "short_links"."short_url" IS NOT NULL
								AND "short_links"."short_url" ~ '^https?://')
						)
						AND "short_links"."creation_started_at" IS NOT NULL
						AND "short_links"."creation_completed_at" IS NOT NULL
						AND "short_links"."creation_completed_at" >= "short_links"."creation_started_at"
						AND "short_links"."creation_last_error" IS NOT NULL)
				)),
	CONSTRAINT "short_links_credential_version_check" CHECK (("short_links"."provider" = 'relayapi' AND "short_links"."credential_version" IS NULL)
				OR ("short_links"."provider" IN ('dub', 'short_io', 'bitly')
					AND "short_links"."credential_version" IS NOT NULL
					AND "short_links"."credential_version" > 0)),
	CONSTRAINT "short_links_click_count_nonnegative_check" CHECK ("short_links"."click_count" >= 0),
	CONSTRAINT "short_links_click_sync_counters_check" CHECK ("short_links"."click_sync_generation" >= 0 AND "short_links"."click_sync_attempts" >= 0),
	CONSTRAINT "short_links_click_sync_claim_check" CHECK (("short_links"."click_sync_lease_expires_at" IS NULL
					AND "short_links"."click_sync_started_at" IS NULL)
				OR ("short_links"."click_sync_lease_expires_at" IS NOT NULL
					AND ("short_links"."click_sync_started_at" IS NULL
						OR "short_links"."click_sync_started_at" <= "short_links"."click_sync_lease_expires_at"))),
	CONSTRAINT "short_links_click_sync_error_class_check" CHECK ("short_links"."click_sync_last_error_class" IS NULL
				OR "short_links"."click_sync_last_error_class" IN ('transient', 'rate_limited', 'permanent'))
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
	"poll_generation" integer DEFAULT 0 NOT NULL,
	"poll_lease_expires_at" timestamp with time zone,
	"poll_started_at" timestamp with time zone,
	"poll_interval_sec" integer DEFAULT 3600 NOT NULL,
	"consecutive_empty_polls" integer DEFAULT 0 NOT NULL,
	"sync_cursor" text,
	"rate_limit_reset_at" timestamp with time zone,
	"rate_limit_remaining" integer,
	"last_error" text,
	"last_error_class" text,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"last_error_at" timestamp with time zone,
	"total_posts_synced" integer DEFAULT 0 NOT NULL,
	"total_sync_runs" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_account_sync_state_social_account_id_unique" UNIQUE("social_account_id"),
	CONSTRAINT "social_account_sync_state_counters_nonnegative_check" CHECK ("social_account_sync_state"."poll_generation" >= 0
				AND "social_account_sync_state"."poll_interval_sec" > 0
				AND "social_account_sync_state"."consecutive_empty_polls" >= 0
				AND "social_account_sync_state"."consecutive_errors" >= 0
				AND "social_account_sync_state"."total_posts_synced" >= 0
				AND "social_account_sync_state"."total_sync_runs" >= 0
				AND ("social_account_sync_state"."rate_limit_remaining" IS NULL OR "social_account_sync_state"."rate_limit_remaining" >= 0)),
	CONSTRAINT "social_account_sync_state_claim_check" CHECK (("social_account_sync_state"."poll_lease_expires_at" IS NULL AND "social_account_sync_state"."poll_started_at" IS NULL)
				OR ("social_account_sync_state"."poll_lease_expires_at" IS NOT NULL
					AND ("social_account_sync_state"."poll_started_at" IS NULL
						OR "social_account_sync_state"."poll_started_at" <= "social_account_sync_state"."poll_lease_expires_at"))),
	CONSTRAINT "social_account_sync_state_error_class_check" CHECK ("social_account_sync_state"."last_error_class" IS NULL
				OR "social_account_sync_state"."last_error_class" IN ('transient', 'rate_limited', 'permanent'))
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
CREATE TABLE "storage_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"location_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"version" integer NOT NULL,
	"access_key_id" text NOT NULL,
	"secret_access_key" text NOT NULL,
	"state" text DEFAULT 'staged' NOT NULL,
	"probe_token" text,
	"probe_lease_expires_at" timestamp with time zone,
	"last_tested_at" timestamp with time zone,
	"last_error_code" text,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_credentials_location_org_version_uniq" UNIQUE("location_id","organization_id","version"),
	CONSTRAINT "storage_credentials_version_check" CHECK ("storage_credentials"."version" > 0),
	CONSTRAINT "storage_credentials_state_check" CHECK ("storage_credentials"."state" IN ('staged', 'active', 'retired', 'failed')),
	CONSTRAINT "storage_credentials_probe_lease_check" CHECK (("storage_credentials"."probe_token" IS NULL AND "storage_credentials"."probe_lease_expires_at" IS NULL)
				OR ("storage_credentials"."state" = 'staged'
					AND "storage_credentials"."probe_token" IS NOT NULL
					AND "storage_credentials"."probe_lease_expires_at" IS NOT NULL)),
	CONSTRAINT "storage_credentials_state_shape_check" CHECK (("storage_credentials"."state" = 'staged'
					AND "storage_credentials"."last_tested_at" IS NULL
					AND "storage_credentials"."last_error_code" IS NULL
					AND "storage_credentials"."activated_at" IS NULL
					AND "storage_credentials"."retired_at" IS NULL)
				OR ("storage_credentials"."state" = 'active'
					AND "storage_credentials"."probe_token" IS NULL
					AND "storage_credentials"."probe_lease_expires_at" IS NULL
					AND "storage_credentials"."last_tested_at" IS NOT NULL
					AND "storage_credentials"."last_error_code" IS NULL
					AND "storage_credentials"."activated_at" IS NOT NULL
					AND "storage_credentials"."retired_at" IS NULL)
				OR ("storage_credentials"."state" = 'retired'
					AND "storage_credentials"."probe_token" IS NULL
					AND "storage_credentials"."probe_lease_expires_at" IS NULL
					AND "storage_credentials"."last_tested_at" IS NOT NULL
					AND "storage_credentials"."last_error_code" IS NULL
					AND "storage_credentials"."activated_at" IS NOT NULL
					AND "storage_credentials"."retired_at" IS NOT NULL
					AND "storage_credentials"."retired_at" >= "storage_credentials"."activated_at")
				OR ("storage_credentials"."state" = 'failed'
					AND "storage_credentials"."probe_token" IS NULL
					AND "storage_credentials"."probe_lease_expires_at" IS NULL
					AND "storage_credentials"."last_tested_at" IS NOT NULL
					AND "storage_credentials"."last_error_code" IS NOT NULL
					AND "storage_credentials"."activated_at" IS NULL
					AND "storage_credentials"."retired_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "storage_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text DEFAULT 's3' NOT NULL,
	"endpoint" text NOT NULL,
	"bucket" text NOT NULL,
	"region" text DEFAULT 'auto' NOT NULL,
	"key_prefix" text DEFAULT 'relayapi' NOT NULL,
	"force_path_style" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_locations_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "storage_locations_media_locator_uniq" UNIQUE("id","organization_id","bucket","region"),
	CONSTRAINT "storage_locations_provider_check" CHECK ("storage_locations"."provider" = 's3'),
	CONSTRAINT "storage_locations_endpoint_check" CHECK ("storage_locations"."endpoint" ~ '^https://' AND "storage_locations"."endpoint" !~ '[?#]'),
	CONSTRAINT "storage_locations_key_prefix_check" CHECK (length("storage_locations"."key_prefix") BETWEEN 1 AND 200
				AND "storage_locations"."key_prefix" !~ '(^/|/$|\.\.)'),
	CONSTRAINT "storage_locations_lifecycle_check" CHECK ("storage_locations"."retired_at" IS NULL
				OR ("storage_locations"."activated_at" IS NOT NULL AND "storage_locations"."retired_at" >= "storage_locations"."activated_at"))
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"type" text NOT NULL,
	"object_id" text,
	"customer_id" text,
	"subscription_id" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"last_error_class" text,
	"lease_expires_at" timestamp with time zone,
	"stripe_created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"manual_review_at" timestamp with time zone,
	"operator_retry_requested_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_events_status_check" CHECK ("stripe_events"."status" IN ('pending', 'processing', 'succeeded', 'failed', 'manual_review')),
	CONSTRAINT "stripe_events_counters_nonnegative_check" CHECK ("stripe_events"."attempts" >= 0 AND "stripe_events"."lease_token" >= 0),
	CONSTRAINT "stripe_events_error_class_check" CHECK ("stripe_events"."last_error_class" IS NULL
				OR "stripe_events"."last_error_class" IN ('transient', 'permanent', 'unresolved', 'retry_exhausted', 'age_exhausted')),
	CONSTRAINT "stripe_events_lease_state_check" CHECK (("stripe_events"."status" = 'processing' AND "stripe_events"."lease_expires_at" IS NOT NULL)
				OR ("stripe_events"."status" <> 'processing' AND "stripe_events"."lease_expires_at" IS NULL)),
	CONSTRAINT "stripe_events_completion_check" CHECK (("stripe_events"."status" = 'succeeded' AND "stripe_events"."processed_at" IS NOT NULL AND "stripe_events"."manual_review_at" IS NULL)
				OR ("stripe_events"."status" = 'manual_review' AND "stripe_events"."processed_at" IS NULL AND "stripe_events"."manual_review_at" IS NOT NULL)
				OR ("stripe_events"."status" NOT IN ('succeeded', 'manual_review') AND "stripe_events"."processed_at" IS NULL AND "stripe_events"."manual_review_at" IS NULL)),
	CONSTRAINT "stripe_events_operator_retry_check" CHECK ("stripe_events"."operator_retry_requested_at" IS NULL
				OR ("stripe_events"."status" = 'failed'
					AND "stripe_events"."processed_at" IS NULL
					AND "stripe_events"."manual_review_at" IS NULL
					AND "stripe_events"."lease_expires_at" IS NULL)),
	CONSTRAINT "stripe_events_terminal_failure_check" CHECK (NOT ("stripe_events"."status" = 'failed' AND "stripe_events"."last_error_class" = 'permanent')
				OR ("stripe_events"."payload" = '{}'::jsonb
					AND "stripe_events"."processed_at" IS NULL
					AND "stripe_events"."manual_review_at" IS NULL
					AND "stripe_events"."operator_retry_requested_at" IS NULL
					AND "stripe_events"."lease_expires_at" IS NULL)),
	CONSTRAINT "stripe_events_timestamp_order_check" CHECK ("stripe_events"."updated_at" >= "stripe_events"."received_at"
				AND ("stripe_events"."processed_at" IS NULL OR "stripe_events"."processed_at" >= "stripe_events"."received_at")
				AND ("stripe_events"."manual_review_at" IS NULL OR "stripe_events"."manual_review_at" >= "stripe_events"."received_at")
				AND ("stripe_events"."operator_retry_requested_at" IS NULL OR "stripe_events"."operator_retry_requested_at" >= "stripe_events"."received_at"))
);
--> statement-breakpoint
CREATE TABLE "stripe_organization_leases" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"owner_event_id" text,
	"lease_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_organization_leases_numeric_check" CHECK ("stripe_organization_leases"."lease_token" >= 0),
	CONSTRAINT "stripe_organization_leases_state_check" CHECK (("stripe_organization_leases"."owner_event_id" IS NULL AND "stripe_organization_leases"."lease_expires_at" IS NULL)
				OR ("stripe_organization_leases"."owner_event_id" IS NOT NULL AND "stripe_organization_leases"."lease_expires_at" IS NOT NULL))
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
	"authority_session_id" text,
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
	"aged_alerted_at" timestamp with time zone,
	"operator_retry_requested_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "tenant_deletion_jobs_status_check" CHECK ("tenant_deletion_jobs"."status" IN ('pending', 'processing', 'tombstoned', 'waiting_external', 'held', 'manual_review', 'failed', 'purged')),
	CONSTRAINT "tenant_deletion_jobs_attempts_nonnegative_check" CHECK ("tenant_deletion_jobs"."attempts" >= 0),
	CONSTRAINT "tenant_deletion_jobs_lease_token_nonnegative_check" CHECK ("tenant_deletion_jobs"."lease_token" >= 0),
	CONSTRAINT "tenant_deletion_jobs_lease_state_check" CHECK (("tenant_deletion_jobs"."status" = 'processing' AND "tenant_deletion_jobs"."lease_expires_at" IS NOT NULL)
				OR ("tenant_deletion_jobs"."status" <> 'processing' AND "tenant_deletion_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "tenant_deletion_jobs_completion_check" CHECK (("tenant_deletion_jobs"."status" = 'purged' AND "tenant_deletion_jobs"."completed_at" IS NOT NULL)
				OR ("tenant_deletion_jobs"."status" <> 'purged' AND "tenant_deletion_jobs"."completed_at" IS NULL)),
	CONSTRAINT "tenant_deletion_jobs_timestamp_order_check" CHECK ("tenant_deletion_jobs"."updated_at" >= "tenant_deletion_jobs"."requested_at"
				AND ("tenant_deletion_jobs"."aged_alerted_at" IS NULL OR "tenant_deletion_jobs"."aged_alerted_at" >= "tenant_deletion_jobs"."requested_at")
				AND ("tenant_deletion_jobs"."operator_retry_requested_at" IS NULL OR "tenant_deletion_jobs"."operator_retry_requested_at" >= "tenant_deletion_jobs"."requested_at")
				AND ("tenant_deletion_jobs"."completed_at" IS NULL OR "tenant_deletion_jobs"."completed_at" >= "tenant_deletion_jobs"."requested_at")),
	CONSTRAINT "tenant_deletion_jobs_operator_retry_check" CHECK ("tenant_deletion_jobs"."operator_retry_requested_at" IS NULL
				OR ("tenant_deletion_jobs"."status" = 'failed'
					AND "tenant_deletion_jobs"."lease_expires_at" IS NULL
					AND "tenant_deletion_jobs"."completed_at" IS NULL))
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
CREATE TABLE "tool_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"request_ciphertext" text,
	"result_ciphertext" text,
	"error_ciphertext" text,
	"error_code" text,
	"usage_reservation_id" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_enqueued_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"purge_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_jobs_kind_check" CHECK ("tool_jobs"."kind" IN ('download', 'transcript')),
	CONSTRAINT "tool_jobs_status_check" CHECK ("tool_jobs"."status" IN ('pending', 'processing', 'completed', 'failed', 'manual_review')),
	CONSTRAINT "tool_jobs_counters_check" CHECK ("tool_jobs"."attempts" BETWEEN 0 AND 3 AND "tool_jobs"."lease_token" >= 0),
	CONSTRAINT "tool_jobs_lease_check" CHECK (("tool_jobs"."status" = 'processing' AND "tool_jobs"."lease_expires_at" IS NOT NULL)
				OR ("tool_jobs"."status" <> 'processing' AND "tool_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "tool_jobs_payload_state_check" CHECK (("tool_jobs"."status" = 'pending'
						AND "tool_jobs"."request_may_have_been_sent_at" IS NULL
						AND "tool_jobs"."request_ciphertext" IS NOT NULL
						AND "tool_jobs"."result_ciphertext" IS NULL
						AND "tool_jobs"."error_ciphertext" IS NULL
						AND "tool_jobs"."error_code" IS NULL
						AND "tool_jobs"."completed_at" IS NULL)
					OR ("tool_jobs"."status" = 'processing'
						AND "tool_jobs"."request_ciphertext" IS NOT NULL
						AND "tool_jobs"."result_ciphertext" IS NULL
						AND "tool_jobs"."error_ciphertext" IS NULL
					AND "tool_jobs"."error_code" IS NULL
					AND "tool_jobs"."completed_at" IS NULL)
					OR ("tool_jobs"."status" = 'completed'
						AND "tool_jobs"."request_may_have_been_sent_at" IS NOT NULL
						AND "tool_jobs"."request_ciphertext" IS NULL
						AND "tool_jobs"."result_ciphertext" IS NOT NULL
					AND "tool_jobs"."error_ciphertext" IS NULL
						AND "tool_jobs"."error_code" IS NULL
						AND "tool_jobs"."completed_at" IS NOT NULL)
					OR ("tool_jobs"."status" = 'manual_review'
						AND "tool_jobs"."request_may_have_been_sent_at" IS NOT NULL
						AND "tool_jobs"."request_ciphertext" IS NOT NULL
						AND "tool_jobs"."result_ciphertext" IS NULL
						AND "tool_jobs"."error_ciphertext" IS NOT NULL
						AND "tool_jobs"."error_code" = 'PROVIDER_OUTCOME_UNKNOWN'
						AND "tool_jobs"."completed_at" IS NOT NULL)
					OR ("tool_jobs"."status" = 'failed'
					AND "tool_jobs"."request_ciphertext" IS NULL
					AND "tool_jobs"."result_ciphertext" IS NULL
					AND "tool_jobs"."error_ciphertext" IS NOT NULL
					AND "tool_jobs"."error_code" IS NOT NULL
					AND "tool_jobs"."completed_at" IS NOT NULL)),
	CONSTRAINT "tool_jobs_ciphertext_check" CHECK (("tool_jobs"."request_ciphertext" IS NULL OR "tool_jobs"."request_ciphertext" LIKE 'enc:v2:%')
				AND ("tool_jobs"."result_ciphertext" IS NULL OR "tool_jobs"."result_ciphertext" LIKE 'enc:v2:%')
				AND ("tool_jobs"."error_ciphertext" IS NULL OR "tool_jobs"."error_ciphertext" LIKE 'enc:v2:%')),
	CONSTRAINT "tool_jobs_timestamps_check" CHECK ("tool_jobs"."deadline_at" > "tool_jobs"."created_at"
					AND "tool_jobs"."purge_at" > "tool_jobs"."created_at"
					AND "tool_jobs"."next_attempt_at" >= "tool_jobs"."created_at"
					AND ("tool_jobs"."last_enqueued_at" IS NULL OR "tool_jobs"."last_enqueued_at" >= "tool_jobs"."created_at")
					AND ("tool_jobs"."request_may_have_been_sent_at" IS NULL OR "tool_jobs"."request_may_have_been_sent_at" >= "tool_jobs"."created_at")
					AND ("tool_jobs"."completed_at" IS NULL OR "tool_jobs"."completed_at" >= "tool_jobs"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "usage_buckets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"billing_period_id" text,
	"metric" text DEFAULT 'successful_mutation' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"quota_mode" text DEFAULT 'hard' NOT NULL,
	"included_units" bigint,
	"committed_units" bigint DEFAULT 0 NOT NULL,
	"reserved_units" bigint DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_buckets_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "usage_buckets_period_check" CHECK ("usage_buckets"."period_end" > "usage_buckets"."period_start"),
	CONSTRAINT "usage_buckets_counters_nonnegative_check" CHECK ("usage_buckets"."committed_units" BETWEEN 0 AND 9007199254740991
				AND "usage_buckets"."reserved_units" BETWEEN 0 AND 9007199254740991
				AND "usage_buckets"."revision" >= 0),
	CONSTRAINT "usage_buckets_quota_shape_check" CHECK (("usage_buckets"."quota_mode" = 'unlimited' AND "usage_buckets"."included_units" IS NULL)
				OR ("usage_buckets"."quota_mode" IN ('hard', 'metered')
					AND "usage_buckets"."included_units" IS NOT NULL
					AND "usage_buckets"."included_units" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "usage_buckets_period_authority_check" CHECK ("usage_buckets"."billing_period_id" IS NULL
				OR ("usage_buckets"."metric" = 'successful_mutation'
					AND "usage_buckets"."quota_mode" IN ('hard', 'metered'))),
	CONSTRAINT "usage_buckets_metered_authority_check" CHECK ("usage_buckets"."quota_mode" <> 'metered' OR "usage_buckets"."billing_period_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "usage_reservation_carryovers" (
	"source_reservation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"successor_bucket_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_reservation_carryovers_pk" PRIMARY KEY("source_reservation_id","successor_bucket_id")
);
--> statement-breakpoint
CREATE TABLE "usage_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"bucket_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"units" bigint DEFAULT 1 NOT NULL,
	"committed_units" bigint,
	"state" text DEFAULT 'reserved' NOT NULL,
	"disposition" text DEFAULT 'pending' NOT NULL,
	"response_status" integer,
	"source" text DEFAULT 'api' NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_may_have_been_sent_at" timestamp with time zone,
	"write_off_reason" text,
	"write_off_evidence" jsonb,
	"written_off_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "usage_reservations_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "usage_reservations_units_positive_check" CHECK ("usage_reservations"."units" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "usage_reservations_committed_units_check" CHECK ("usage_reservations"."committed_units" IS NULL
				OR "usage_reservations"."committed_units" BETWEEN 0 AND LEAST("usage_reservations"."units", 9007199254740991)),
	CONSTRAINT "usage_reservations_state_check" CHECK ("usage_reservations"."state" IN ('reserved', 'parked', 'committed', 'released')),
	CONSTRAINT "usage_reservations_finalization_check" CHECK (("usage_reservations"."state" = 'reserved'
						AND "usage_reservations"."disposition" = 'pending'
						AND "usage_reservations"."committed_units" IS NULL
						AND "usage_reservations"."write_off_reason" IS NULL
						AND "usage_reservations"."write_off_evidence" IS NULL
						AND "usage_reservations"."written_off_at" IS NULL
						AND "usage_reservations"."finalized_at" IS NULL)
					OR ("usage_reservations"."state" = 'parked'
						AND "usage_reservations"."disposition" = 'unknown'
						AND "usage_reservations"."committed_units" IS NULL
						AND "usage_reservations"."request_may_have_been_sent_at" IS NOT NULL
						AND "usage_reservations"."write_off_reason" IS NULL
						AND "usage_reservations"."write_off_evidence" IS NULL
						AND "usage_reservations"."written_off_at" IS NULL
						AND "usage_reservations"."finalized_at" IS NULL)
					OR ("usage_reservations"."state" = 'released'
						AND "usage_reservations"."disposition" = 'pre_boundary'
						AND "usage_reservations"."committed_units" = 0
						AND "usage_reservations"."request_may_have_been_sent_at" IS NULL
						AND "usage_reservations"."write_off_reason" IS NULL
						AND "usage_reservations"."write_off_evidence" IS NULL
						AND "usage_reservations"."written_off_at" IS NULL
						AND "usage_reservations"."finalized_at" IS NOT NULL)
					OR ("usage_reservations"."state" = 'released'
						AND "usage_reservations"."disposition" = 'rejected'
						AND "usage_reservations"."committed_units" = 0
						AND "usage_reservations"."response_status" BETWEEN 400 AND 499
						AND "usage_reservations"."write_off_reason" IS NULL
						AND "usage_reservations"."write_off_evidence" IS NULL
						AND "usage_reservations"."written_off_at" IS NULL
						AND "usage_reservations"."finalized_at" IS NOT NULL)
					OR ("usage_reservations"."state" = 'released'
						AND "usage_reservations"."disposition" = 'proven_not_applied'
						AND "usage_reservations"."committed_units" = 0
						AND "usage_reservations"."request_may_have_been_sent_at" IS NOT NULL
						AND "usage_reservations"."response_status" BETWEEN 500 AND 599
						AND "usage_reservations"."write_off_reason" IS NULL
						AND "usage_reservations"."write_off_evidence" IS NULL
						AND "usage_reservations"."written_off_at" IS NULL
						AND "usage_reservations"."finalized_at" IS NOT NULL)
					OR ("usage_reservations"."state" = 'released'
						AND "usage_reservations"."disposition" = 'written_off'
						AND "usage_reservations"."committed_units" = 0
						AND "usage_reservations"."request_may_have_been_sent_at" IS NOT NULL
						AND length("usage_reservations"."write_off_reason") > 0
						AND "usage_reservations"."write_off_evidence" IS NOT NULL
						AND "usage_reservations"."written_off_at" IS NOT NULL
						AND "usage_reservations"."finalized_at" = "usage_reservations"."written_off_at")
					OR ("usage_reservations"."state" = 'committed'
						AND "usage_reservations"."disposition" = 'settled'
						AND "usage_reservations"."committed_units" IS NOT NULL
						AND "usage_reservations"."write_off_reason" IS NULL
						AND "usage_reservations"."write_off_evidence" IS NULL
						AND "usage_reservations"."written_off_at" IS NULL
						AND "usage_reservations"."finalized_at" IS NOT NULL)),
	CONSTRAINT "usage_reservations_boundary_timestamp_check" CHECK ("usage_reservations"."request_may_have_been_sent_at" IS NULL
					OR "usage_reservations"."request_may_have_been_sent_at" >= "usage_reservations"."reserved_at"),
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
	"credentialVersion" text DEFAULT 'legacy-v1' NOT NULL,
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
	CONSTRAINT "user_preferences_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "user_preferences_timezone_shape_check" CHECK (length(btrim("user_preferences"."timezone")) BETWEEN 1 AND 128),
	CONSTRAINT "user_preferences_language_check" CHECK ("user_preferences"."language" IN ('en', 'es', 'fr', 'de', 'ja', 'zh')),
	CONSTRAINT "user_preferences_timestamp_order_check" CHECK ("user_preferences"."updated_at" >= "user_preferences"."created_at")
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"repair_attempts" integer DEFAULT 0 NOT NULL,
	"repair_deadline_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"status_code" integer,
	"response_time_ms" integer,
	"manual_review_reason" text,
	"manual_review_until" timestamp with time zone,
	"operator_intervened_at" timestamp with time zone,
	"operator_retry_requested_at" timestamp with time zone,
	"error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatch_lease_id" text,
	"dispatch_lease_expires_at" timestamp with time zone,
	"next_dispatch_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_enqueued_at" timestamp with time zone,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "webhook_deliveries_status_check" CHECK ("webhook_deliveries"."status" IN ('pending', 'in_flight', 'succeeded', 'failed', 'unknown', 'manual_review', 'unresolved')),
	CONSTRAINT "webhook_deliveries_counters_nonnegative_check" CHECK ("webhook_deliveries"."attempts" >= 0 AND "webhook_deliveries"."repair_attempts" >= 0 AND "webhook_deliveries"."dispatch_attempts" >= 0 AND "webhook_deliveries"."lease_token" >= 0),
	CONSTRAINT "webhook_deliveries_http_attempt_budget_check" CHECK ("webhook_deliveries"."attempts" <= 9
					AND ("webhook_deliveries"."attempts" <= 8
						OR "webhook_deliveries"."operator_retry_requested_at" IS NOT NULL)),
	CONSTRAINT "webhook_deliveries_repair_deadline_check" CHECK ("webhook_deliveries"."repair_deadline_at" > "webhook_deliveries"."created_at"
					AND ("webhook_deliveries"."operator_intervened_at" IS NULL
						OR "webhook_deliveries"."operator_intervened_at" >= "webhook_deliveries"."created_at")
					AND ("webhook_deliveries"."operator_retry_requested_at" IS NULL
						OR "webhook_deliveries"."operator_retry_requested_at" >= "webhook_deliveries"."created_at")),
	CONSTRAINT "webhook_deliveries_operator_intervention_check" CHECK ("webhook_deliveries"."operator_retry_requested_at" IS NULL
					OR "webhook_deliveries"."operator_intervened_at" = "webhook_deliveries"."operator_retry_requested_at"),
	CONSTRAINT "webhook_deliveries_http_values_check" CHECK (("webhook_deliveries"."status_code" IS NULL OR ("webhook_deliveries"."status_code" >= 100 AND "webhook_deliveries"."status_code" <= 599)) AND ("webhook_deliveries"."response_time_ms" IS NULL OR "webhook_deliveries"."response_time_ms" >= 0)),
	CONSTRAINT "webhook_deliveries_terminal_completion_check" CHECK (("webhook_deliveries"."status" IN ('succeeded', 'failed', 'unresolved')
						AND "webhook_deliveries"."completed_at" IS NOT NULL
						AND "webhook_deliveries"."manual_review_reason" IS NULL
						AND "webhook_deliveries"."manual_review_until" IS NULL)
					OR ("webhook_deliveries"."status" = 'manual_review'
						AND "webhook_deliveries"."completed_at" IS NULL
						AND "webhook_deliveries"."lease_expires_at" IS NULL
						AND (
							("webhook_deliveries"."manual_review_reason" = 'pre_http_repair_exhausted'
								AND "webhook_deliveries"."request_may_have_been_sent_at" IS NULL
								AND "webhook_deliveries"."manual_review_until" > "webhook_deliveries"."repair_deadline_at"
								AND "webhook_deliveries"."manual_review_until" <= "webhook_deliveries"."repair_deadline_at" + interval '90 days')
							OR ("webhook_deliveries"."manual_review_reason" = 'http_outcome_unknown'
								AND "webhook_deliveries"."request_may_have_been_sent_at" IS NOT NULL
								AND "webhook_deliveries"."manual_review_until" > "webhook_deliveries"."request_may_have_been_sent_at"
								AND "webhook_deliveries"."manual_review_until" <= "webhook_deliveries"."request_may_have_been_sent_at" + interval '90 days')
						))
					OR ("webhook_deliveries"."status" NOT IN ('succeeded', 'failed', 'manual_review', 'unresolved')
						AND "webhook_deliveries"."completed_at" IS NULL
						AND "webhook_deliveries"."manual_review_reason" IS NULL
						AND "webhook_deliveries"."manual_review_until" IS NULL)),
	CONSTRAINT "webhook_deliveries_unknown_boundary_check" CHECK ("webhook_deliveries"."status" <> 'unknown'
					OR "webhook_deliveries"."request_may_have_been_sent_at" IS NOT NULL),
	CONSTRAINT "webhook_deliveries_lease_state_check" CHECK (("webhook_deliveries"."status" = 'in_flight'
						AND "webhook_deliveries"."lease_expires_at" IS NOT NULL
						AND "webhook_deliveries"."request_may_have_been_sent_at" IS NULL)
					OR ("webhook_deliveries"."status" = 'unknown'
						AND "webhook_deliveries"."lease_expires_at" IS NOT NULL
						AND "webhook_deliveries"."request_may_have_been_sent_at" IS NOT NULL)
					OR ("webhook_deliveries"."status" NOT IN ('in_flight', 'unknown')
						AND "webhook_deliveries"."lease_expires_at" IS NULL))
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
	"delivery_id" text,
	"organization_id" text NOT NULL,
	"attempt_ordinal" integer NOT NULL,
	"attempt_kind" text NOT NULL,
	"outcome" text NOT NULL,
	"status_code" integer,
	"response_time_ms" integer NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_logs_attempt_kind_check" CHECK ("webhook_logs"."attempt_kind" IN ('delivery', 'test')),
	CONSTRAINT "webhook_logs_outcome_check" CHECK ("webhook_logs"."outcome" IN ('succeeded', 'retry_scheduled', 'failed', 'unknown')),
	CONSTRAINT "webhook_logs_attempt_identity_check" CHECK (("webhook_logs"."attempt_kind" = 'delivery'
					AND "webhook_logs"."delivery_id" IS NOT NULL
					AND "webhook_logs"."attempt_ordinal" > 0)
				OR ("webhook_logs"."attempt_kind" = 'test'
					AND "webhook_logs"."delivery_id" IS NULL
					AND "webhook_logs"."attempt_ordinal" = 1)),
	CONSTRAINT "webhook_logs_http_values_check" CHECK ("webhook_logs"."response_time_ms" >= 0
				AND (("webhook_logs"."outcome" = 'succeeded'
						AND "webhook_logs"."status_code" BETWEEN 200 AND 299
						AND "webhook_logs"."error" IS NULL)
					OR ("webhook_logs"."outcome" IN ('retry_scheduled', 'failed')
						AND "webhook_logs"."status_code" BETWEEN 100 AND 599
						AND "webhook_logs"."status_code" NOT BETWEEN 200 AND 299
						AND "webhook_logs"."error" IS NOT NULL)
					OR ("webhook_logs"."outcome" = 'unknown'
						AND "webhook_logs"."status_code" IS NULL
						AND "webhook_logs"."error" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_phone_billing_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"phone_billing_operation_id" text NOT NULL,
	"revision" integer NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"desired_quantity" integer NOT NULL,
	"prior_applied_quantity" integer NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_checkout_session_id" text,
	"stripe_subscription_id" text,
	"stripe_subscription_item_id" text,
	"stripe_latest_invoice_id" text,
	"idempotency_key" text NOT NULL,
	"request_may_have_been_sent_at" timestamp with time zone,
	"provider_evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "whatsapp_phone_billing_attempts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "wa_phone_billing_attempts_status_check" CHECK ("whatsapp_phone_billing_attempts"."status" IN ('prepared', 'requesting', 'unknown', 'waiting_payment', 'applied', 'confirmed_not_applied', 'manual_review')),
	CONSTRAINT "wa_phone_billing_attempts_numeric_check" CHECK ("whatsapp_phone_billing_attempts"."revision" > 0
				AND "whatsapp_phone_billing_attempts"."desired_quantity" >= 0
				AND "whatsapp_phone_billing_attempts"."prior_applied_quantity" >= 0),
	CONSTRAINT "wa_phone_billing_attempts_state_shape_check" CHECK (("whatsapp_phone_billing_attempts"."status" = 'prepared'
					AND "whatsapp_phone_billing_attempts"."request_may_have_been_sent_at" IS NULL
					AND "whatsapp_phone_billing_attempts"."provider_evidence" IS NULL
					AND "whatsapp_phone_billing_attempts"."resolved_at" IS NULL)
				OR ("whatsapp_phone_billing_attempts"."status" IN ('requesting', 'unknown')
					AND "whatsapp_phone_billing_attempts"."request_may_have_been_sent_at" IS NOT NULL
					AND "whatsapp_phone_billing_attempts"."resolved_at" IS NULL)
				OR ("whatsapp_phone_billing_attempts"."status" = 'waiting_payment'
					AND "whatsapp_phone_billing_attempts"."provider_evidence" IS NOT NULL
					AND "whatsapp_phone_billing_attempts"."resolved_at" IS NULL)
				OR ("whatsapp_phone_billing_attempts"."status" IN ('applied', 'confirmed_not_applied')
					AND "whatsapp_phone_billing_attempts"."provider_evidence" IS NOT NULL
					AND "whatsapp_phone_billing_attempts"."resolved_at" IS NOT NULL)
				OR ("whatsapp_phone_billing_attempts"."status" = 'manual_review'
					AND "whatsapp_phone_billing_attempts"."provider_evidence" IS NOT NULL
					AND "whatsapp_phone_billing_attempts"."resolved_at" IS NULL)),
	CONSTRAINT "wa_phone_billing_attempts_timestamp_check" CHECK (("whatsapp_phone_billing_attempts"."request_may_have_been_sent_at" IS NULL OR "whatsapp_phone_billing_attempts"."request_may_have_been_sent_at" >= "whatsapp_phone_billing_attempts"."created_at")
				AND ("whatsapp_phone_billing_attempts"."resolved_at" IS NULL OR "whatsapp_phone_billing_attempts"."resolved_at" >= "whatsapp_phone_billing_attempts"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_phone_billing_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"desired_quantity" integer NOT NULL,
	"applied_quantity" integer DEFAULT 0 NOT NULL,
	"stripe_customer_id" text,
	"stripe_checkout_session_id" text,
	"stripe_subscription_id" text,
	"stripe_subscription_item_id" text,
	"stripe_latest_invoice_id" text,
	"idempotency_key" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_phone_billing_operations_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "whatsapp_phone_billing_operations_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "wa_phone_billing_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "wa_phone_billing_status_check" CHECK ("whatsapp_phone_billing_operations"."state" IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'waiting_payment', 'applied', 'manual_review')),
	CONSTRAINT "wa_phone_billing_numeric_check" CHECK ("whatsapp_phone_billing_operations"."desired_quantity" >= 0
				AND "whatsapp_phone_billing_operations"."applied_quantity" >= 0
				AND "whatsapp_phone_billing_operations"."revision" > 0
				AND "whatsapp_phone_billing_operations"."lease_token" >= 0
				AND "whatsapp_phone_billing_operations"."attempts" >= 0),
	CONSTRAINT "wa_phone_billing_lease_check" CHECK (("whatsapp_phone_billing_operations"."state" IN ('processing', 'request_may_have_been_sent')
					AND "whatsapp_phone_billing_operations"."lease_expires_at" IS NOT NULL)
				OR ("whatsapp_phone_billing_operations"."state" NOT IN ('processing', 'request_may_have_been_sent')
					AND "whatsapp_phone_billing_operations"."lease_expires_at" IS NULL)),
	CONSTRAINT "wa_phone_billing_boundary_check" CHECK ("whatsapp_phone_billing_operations"."state" <> 'request_may_have_been_sent'
				OR "whatsapp_phone_billing_operations"."request_may_have_been_sent_at" IS NOT NULL),
	CONSTRAINT "wa_phone_billing_applied_check" CHECK (("whatsapp_phone_billing_operations"."state" = 'applied'
					AND "whatsapp_phone_billing_operations"."desired_quantity" = "whatsapp_phone_billing_operations"."applied_quantity"
					AND "whatsapp_phone_billing_operations"."applied_at" IS NOT NULL)
				OR ("whatsapp_phone_billing_operations"."state" <> 'applied' AND "whatsapp_phone_billing_operations"."applied_at" IS NULL)),
	CONSTRAINT "wa_phone_billing_timestamp_order_check" CHECK ("whatsapp_phone_billing_operations"."updated_at" >= "whatsapp_phone_billing_operations"."created_at"
				AND ("whatsapp_phone_billing_operations"."request_may_have_been_sent_at" IS NULL OR "whatsapp_phone_billing_operations"."request_may_have_been_sent_at" >= "whatsapp_phone_billing_operations"."created_at")
				AND ("whatsapp_phone_billing_operations"."applied_at" IS NULL OR "whatsapp_phone_billing_operations"."applied_at" >= "whatsapp_phone_billing_operations"."created_at"))
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
	"verification_method" text,
	"stripe_phone_subscription_id" text,
	"stripe_subscription_item_id" text,
	"monthly_cost_cents" integer DEFAULT 200 NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_phone_numbers_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "wa_phone_numbers_status_check" CHECK ("whatsapp_phone_numbers"."status" IN ('purchasing', 'pending_verification', 'verified', 'active', 'releasing', 'released')),
	CONSTRAINT "wa_phone_numbers_numeric_check" CHECK ("whatsapp_phone_numbers"."monthly_cost_cents" >= 0),
	CONSTRAINT "wa_phone_numbers_timestamp_order_check" CHECK ("whatsapp_phone_numbers"."updated_at" >= "whatsapp_phone_numbers"."created_at")
);
--> statement-breakpoint
CREATE TABLE "whatsapp_phone_provisioning_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"phone_number_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"usage_reservation_id" text,
	"idempotency_key_hash" varchar(64) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"source_account_id" text NOT NULL,
	"source_waba_id" text NOT NULL,
	"verified_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"phase" text DEFAULT 'selected' NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"stripe_checkout_session_id" text,
	"stripe_checkout_url" text,
	"detail_expires_at" timestamp with time zone,
	"detail_redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_phone_provisioning_status_check" CHECK ("whatsapp_phone_provisioning_operations"."status" IN ('pending', 'processing', 'waiting_external', 'request_may_have_been_sent', 'unknown', 'manual_review', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "wa_phone_provisioning_phase_check" CHECK ("whatsapp_phone_provisioning_operations"."phase" IN ('selected', 'telnyx_order', 'billing', 'meta_registration', 'completed')),
	CONSTRAINT "wa_phone_provisioning_numeric_check" CHECK ("whatsapp_phone_provisioning_operations"."lease_token" >= 0
				AND "whatsapp_phone_provisioning_operations"."attempts" >= 0),
	CONSTRAINT "wa_phone_provisioning_lease_state_check" CHECK (("whatsapp_phone_provisioning_operations"."status" IN ('processing', 'request_may_have_been_sent')
					AND "whatsapp_phone_provisioning_operations"."lease_expires_at" IS NOT NULL)
				OR ("whatsapp_phone_provisioning_operations"."status" NOT IN ('processing', 'request_may_have_been_sent')
					AND "whatsapp_phone_provisioning_operations"."lease_expires_at" IS NULL)),
	CONSTRAINT "wa_phone_provisioning_boundary_check" CHECK ("whatsapp_phone_provisioning_operations"."status" <> 'request_may_have_been_sent'
				OR "whatsapp_phone_provisioning_operations"."request_may_have_been_sent_at" IS NOT NULL),
	CONSTRAINT "wa_phone_provisioning_completion_check" CHECK ("whatsapp_phone_provisioning_operations"."status" <> 'completed'
				OR "whatsapp_phone_provisioning_operations"."phase" = 'completed'),
	CONSTRAINT "wa_phone_provisioning_detail_retention_check" CHECK (("whatsapp_phone_provisioning_operations"."status" IN ('completed', 'cancelled')
					AND "whatsapp_phone_provisioning_operations"."verified_name" IS NULL
					AND "whatsapp_phone_provisioning_operations"."detail_expires_at" IS NOT NULL
					AND ("whatsapp_phone_provisioning_operations"."detail_redacted_at" IS NULL
						OR ("whatsapp_phone_provisioning_operations"."stripe_checkout_url" IS NULL
							AND "whatsapp_phone_provisioning_operations"."detail_redacted_at" >= "whatsapp_phone_provisioning_operations"."detail_expires_at")))
				OR ("whatsapp_phone_provisioning_operations"."status" NOT IN ('completed', 'cancelled')
					AND length(btrim("whatsapp_phone_provisioning_operations"."verified_name")) > 0
					AND "whatsapp_phone_provisioning_operations"."detail_expires_at" IS NULL
					AND "whatsapp_phone_provisioning_operations"."detail_redacted_at" IS NULL)),
	CONSTRAINT "wa_phone_provisioning_timestamp_order_check" CHECK ("whatsapp_phone_provisioning_operations"."updated_at" >= "whatsapp_phone_provisioning_operations"."created_at"
				AND ("whatsapp_phone_provisioning_operations"."request_may_have_been_sent_at" IS NULL
					OR "whatsapp_phone_provisioning_operations"."request_may_have_been_sent_at" >= "whatsapp_phone_provisioning_operations"."created_at")
				AND ("whatsapp_phone_provisioning_operations"."detail_expires_at" IS NULL
					OR "whatsapp_phone_provisioning_operations"."detail_expires_at" >= "whatsapp_phone_provisioning_operations"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_phone_release_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"phone_number_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"usage_reservation_id" text,
	"reason" text NOT NULL,
	"authority_key_id" text,
	"authority_principal_id" text,
	"authority_principal_type" text,
	"authority_user_id" text,
	"authority_member_id" text,
	"authority_session_id" text,
	"authority_workspace_id" text,
	"authority_requires_all_workspace_scope" boolean,
	"authority_credential_version" text,
	"authority_admitted_at" timestamp with time zone,
	"authority_revision" integer,
	"authority_revoked_at" timestamp with time zone,
	"prior_phone_status" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"phase" text DEFAULT 'meta' NOT NULL,
	"meta_status" text NOT NULL,
	"stripe_status" text NOT NULL,
	"telnyx_status" text NOT NULL,
	"source_account_id" text,
	"source_token_version" integer,
	"access_token_ciphertext" text,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_phone_release_reason_check" CHECK ("whatsapp_phone_release_operations"."reason" IN ('user_requested', 'tenant_deleted')),
	CONSTRAINT "wa_phone_release_status_check" CHECK ("whatsapp_phone_release_operations"."status" IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'revocation_pending', 'manual_review', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "wa_phone_release_prior_phone_status_check" CHECK ("whatsapp_phone_release_operations"."prior_phone_status" IN ('purchasing', 'pending_verification', 'verified', 'active', 'releasing')),
	CONSTRAINT "wa_phone_release_authority_check" CHECK (("whatsapp_phone_release_operations"."reason" = 'tenant_deleted'
					AND "whatsapp_phone_release_operations"."authority_key_id" IS NULL
					AND "whatsapp_phone_release_operations"."authority_principal_id" IS NULL
					AND "whatsapp_phone_release_operations"."authority_principal_type" IS NULL
					AND "whatsapp_phone_release_operations"."authority_user_id" IS NULL
					AND "whatsapp_phone_release_operations"."authority_member_id" IS NULL
					AND "whatsapp_phone_release_operations"."authority_session_id" IS NULL
					AND "whatsapp_phone_release_operations"."authority_workspace_id" IS NULL
					AND "whatsapp_phone_release_operations"."authority_requires_all_workspace_scope" IS NULL
					AND "whatsapp_phone_release_operations"."authority_credential_version" IS NULL
					AND "whatsapp_phone_release_operations"."authority_admitted_at" IS NULL
					AND "whatsapp_phone_release_operations"."authority_revision" IS NULL
					AND "whatsapp_phone_release_operations"."authority_revoked_at" IS NULL)
				OR ("whatsapp_phone_release_operations"."reason" = 'user_requested'
					AND "whatsapp_phone_release_operations"."authority_key_id" IS NOT NULL
					AND "whatsapp_phone_release_operations"."authority_principal_id" IS NOT NULL
					AND "whatsapp_phone_release_operations"."authority_principal_type" IN ('service', 'dashboard_user')
					AND ("whatsapp_phone_release_operations"."authority_principal_type" = 'dashboard_user') = ("whatsapp_phone_release_operations"."authority_user_id" IS NOT NULL)
					AND ("whatsapp_phone_release_operations"."authority_principal_type" = 'dashboard_user') = ("whatsapp_phone_release_operations"."authority_member_id" IS NOT NULL)
					AND ("whatsapp_phone_release_operations"."authority_principal_type" = 'dashboard_user') = ("whatsapp_phone_release_operations"."authority_session_id" IS NOT NULL)
					AND "whatsapp_phone_release_operations"."authority_requires_all_workspace_scope" IS NOT NULL
					AND ("whatsapp_phone_release_operations"."authority_workspace_id" IS NULL) = "whatsapp_phone_release_operations"."authority_requires_all_workspace_scope"
					AND "whatsapp_phone_release_operations"."authority_credential_version" IS NOT NULL
					AND "whatsapp_phone_release_operations"."authority_admitted_at" IS NOT NULL
					AND "whatsapp_phone_release_operations"."authority_revision" > 0)),
	CONSTRAINT "wa_phone_release_phase_check" CHECK ("whatsapp_phone_release_operations"."phase" IN ('meta', 'stripe', 'telnyx', 'completed')),
	CONSTRAINT "wa_phone_release_provider_status_check" CHECK ("whatsapp_phone_release_operations"."meta_status" IN ('pending', 'not_required', 'confirmed', 'unknown')
				AND "whatsapp_phone_release_operations"."stripe_status" IN ('pending', 'not_required', 'confirmed', 'unknown')
				AND "whatsapp_phone_release_operations"."telnyx_status" IN ('pending', 'not_required', 'confirmed', 'unknown')),
	CONSTRAINT "wa_phone_release_numeric_check" CHECK (("whatsapp_phone_release_operations"."source_token_version" IS NULL OR "whatsapp_phone_release_operations"."source_token_version" >= 0)
				AND "whatsapp_phone_release_operations"."lease_token" >= 0
				AND "whatsapp_phone_release_operations"."attempts" >= 0),
	CONSTRAINT "wa_phone_release_source_check" CHECK (("whatsapp_phone_release_operations"."source_account_id" IS NULL
					AND "whatsapp_phone_release_operations"."source_token_version" IS NULL
					AND "whatsapp_phone_release_operations"."access_token_ciphertext" IS NULL)
				OR ("whatsapp_phone_release_operations"."source_account_id" IS NOT NULL
					AND "whatsapp_phone_release_operations"."source_token_version" IS NOT NULL
					AND "whatsapp_phone_release_operations"."access_token_ciphertext" IS NOT NULL)),
	CONSTRAINT "wa_phone_release_lease_state_check" CHECK (("whatsapp_phone_release_operations"."status" IN ('processing', 'request_may_have_been_sent')
					AND "whatsapp_phone_release_operations"."lease_expires_at" IS NOT NULL)
				OR ("whatsapp_phone_release_operations"."status" NOT IN ('processing', 'request_may_have_been_sent')
					AND "whatsapp_phone_release_operations"."lease_expires_at" IS NULL)),
	CONSTRAINT "wa_phone_release_boundary_check" CHECK ("whatsapp_phone_release_operations"."status" <> 'request_may_have_been_sent'
				OR "whatsapp_phone_release_operations"."request_may_have_been_sent_at" IS NOT NULL),
	CONSTRAINT "wa_phone_release_completion_check" CHECK (("whatsapp_phone_release_operations"."status" = 'completed'
					AND "whatsapp_phone_release_operations"."phase" = 'completed'
					AND "whatsapp_phone_release_operations"."meta_status" IN ('confirmed', 'not_required')
					AND "whatsapp_phone_release_operations"."stripe_status" IN ('confirmed', 'not_required')
					AND "whatsapp_phone_release_operations"."telnyx_status" IN ('confirmed', 'not_required')
					AND "whatsapp_phone_release_operations"."completed_at" IS NOT NULL
					AND "whatsapp_phone_release_operations"."access_token_ciphertext" IS NULL)
				OR ("whatsapp_phone_release_operations"."status" <> 'completed'
					AND "whatsapp_phone_release_operations"."completed_at" IS NULL)),
	CONSTRAINT "wa_phone_release_revocation_check" CHECK (("whatsapp_phone_release_operations"."status" IN ('revocation_pending', 'cancelled')) = ("whatsapp_phone_release_operations"."authority_revoked_at" IS NOT NULL)),
	CONSTRAINT "wa_phone_release_timestamp_order_check" CHECK ("whatsapp_phone_release_operations"."updated_at" >= "whatsapp_phone_release_operations"."requested_at"
				AND ("whatsapp_phone_release_operations"."authority_admitted_at" IS NULL OR "whatsapp_phone_release_operations"."authority_admitted_at" <= "whatsapp_phone_release_operations"."requested_at")
				AND ("whatsapp_phone_release_operations"."authority_revoked_at" IS NULL OR "whatsapp_phone_release_operations"."authority_revoked_at" >= "whatsapp_phone_release_operations"."authority_admitted_at")
				AND ("whatsapp_phone_release_operations"."request_may_have_been_sent_at" IS NULL
					OR "whatsapp_phone_release_operations"."request_may_have_been_sent_at" >= "whatsapp_phone_release_operations"."requested_at")
				AND ("whatsapp_phone_release_operations"."completed_at" IS NULL
					OR "whatsapp_phone_release_operations"."completed_at" >= "whatsapp_phone_release_operations"."requested_at"))
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
	"aged_alerted_at" timestamp with time zone,
	"operator_retry_requested_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workspace_erasure_jobs_erasure_operation_id_unique" UNIQUE("erasure_operation_id"),
	CONSTRAINT "workspace_erasure_jobs_workspace_org_scope_uniq" UNIQUE("workspace_id","organization_id","scope_key"),
	CONSTRAINT "workspace_erasure_jobs_status_check" CHECK ("workspace_erasure_jobs"."status" IN ('pending', 'processing', 'held', 'manual_review', 'failed', 'purged')),
	CONSTRAINT "workspace_erasure_jobs_counters_nonnegative_check" CHECK ("workspace_erasure_jobs"."attempts" >= 0 AND "workspace_erasure_jobs"."lease_token" >= 0),
	CONSTRAINT "workspace_erasure_jobs_completion_check" CHECK ("workspace_erasure_jobs"."status" <> 'purged' OR "workspace_erasure_jobs"."completed_at" IS NOT NULL),
	CONSTRAINT "workspace_erasure_jobs_lease_state_check" CHECK (("workspace_erasure_jobs"."status" = 'processing' AND "workspace_erasure_jobs"."lease_expires_at" IS NOT NULL)
				OR ("workspace_erasure_jobs"."status" <> 'processing' AND "workspace_erasure_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "workspace_erasure_jobs_timestamp_order_check" CHECK ("workspace_erasure_jobs"."updated_at" >= "workspace_erasure_jobs"."requested_at"
				AND ("workspace_erasure_jobs"."aged_alerted_at" IS NULL OR "workspace_erasure_jobs"."aged_alerted_at" >= "workspace_erasure_jobs"."requested_at")
				AND ("workspace_erasure_jobs"."operator_retry_requested_at" IS NULL OR "workspace_erasure_jobs"."operator_retry_requested_at" >= "workspace_erasure_jobs"."requested_at")
				AND ("workspace_erasure_jobs"."completed_at" IS NULL OR "workspace_erasure_jobs"."completed_at" >= "workspace_erasure_jobs"."requested_at")),
	CONSTRAINT "workspace_erasure_jobs_operator_retry_check" CHECK ("workspace_erasure_jobs"."operator_retry_requested_at" IS NULL
				OR ("workspace_erasure_jobs"."status" = 'failed'
					AND "workspace_erasure_jobs"."lease_expires_at" IS NULL
					AND "workspace_erasure_jobs"."completed_at" IS NULL))
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
	"slug" text NOT NULL,
	"description" text,
	"lifecycle_status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"erasure_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "workspaces_org_slug_uniq" UNIQUE("organization_id","slug"),
	CONSTRAINT "workspaces_slug_format_check" CHECK ("workspaces"."slug" ~ '^[a-z0-9][a-z0-9_-]{0,99}$'),
	CONSTRAINT "workspaces_lifecycle_status_check" CHECK ("workspaces"."lifecycle_status" IN ('active', 'archived', 'erasing')),
	CONSTRAINT "workspaces_revision_nonnegative_check" CHECK ("workspaces"."revision" >= 0),
	CONSTRAINT "workspaces_lifecycle_timestamps_check" CHECK (("workspaces"."lifecycle_status" <> 'archived' OR "workspaces"."archived_at" IS NOT NULL)
				AND ("workspaces"."lifecycle_status" <> 'erasing' OR "workspaces"."erasure_requested_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "ad_creation_operations" ADD CONSTRAINT "ad_creation_operations_usage_reservation_org_fk" FOREIGN KEY ("usage_reservation_id","organization_id") REFERENCES "public"."usage_reservations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creation_operations" ADD CONSTRAINT "ad_creation_operations_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creation_operations" ADD CONSTRAINT "ad_creation_operations_account_org_scope_platform_fk" FOREIGN KEY ("ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ad_accounts"("id","organization_id","scope_key","platform") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creation_operations" ADD CONSTRAINT "ad_creation_operations_campaign_account_scope_platform_fk" FOREIGN KEY ("local_campaign_id","ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ad_campaigns"("id","ad_account_id","organization_id","scope_key","platform") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creation_operations" ADD CONSTRAINT "ad_creation_operations_ad_account_scope_platform_fk" FOREIGN KEY ("local_ad_id","ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ads"("id","ad_account_id","organization_id","scope_key","platform") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_metrics" ADD CONSTRAINT "ad_metrics_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_mutation_operations" ADD CONSTRAINT "ad_mutation_operations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_mutation_operations" ADD CONSTRAINT "ad_mutation_operations_usage_reservation_org_fk" FOREIGN KEY ("usage_reservation_id","organization_id") REFERENCES "public"."usage_reservations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_handoff_principal_org_fk" FOREIGN KEY ("handoff_principal_id","organization_id") REFERENCES "public"."organization_principals"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_bases" ADD CONSTRAINT "ai_knowledge_bases_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_bases" ADD CONSTRAINT "ai_knowledge_bases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_bases" ADD CONSTRAINT "ai_knowledge_bases_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_document_org_scope_fk" FOREIGN KEY ("document_id","organization_id","scope_key") REFERENCES "public"."ai_knowledge_documents"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_kb_org_scope_fk" FOREIGN KEY ("kb_id","organization_id","scope_key") REFERENCES "public"."ai_knowledge_bases"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_documents" ADD CONSTRAINT "ai_knowledge_documents_kb_org_scope_fk" FOREIGN KEY ("kb_id","organization_id","scope_key") REFERENCES "public"."ai_knowledge_bases"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_documents" ADD CONSTRAINT "ai_knowledge_documents_media_org_scope_fk" FOREIGN KEY ("source_media_id","organization_id","scope_key") REFERENCES "public"."media"("id","organization_id","scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."apikey" ADD CONSTRAINT "apikey_referenceId_user_id_fk" FOREIGN KEY ("referenceId") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."apikey" ADD CONSTRAINT "apikey_principal_org_fk" FOREIGN KEY ("principalId","organizationId") REFERENCES "public"."organization_principals"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "automation_conversion_events" ADD CONSTRAINT "automation_conversion_events_run_auto_contact_org_scope_fk" FOREIGN KEY ("run_id","automation_id","contact_id","organization_id","scope_key") REFERENCES "public"."automation_runs"("id","automation_id","contact_id","organization_id","scope_key") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "automation_effects" ADD CONSTRAINT "automation_effects_execution_org_scope_fk" FOREIGN KEY ("node_execution_id","organization_id","scope_key") REFERENCES "public"."automation_node_executions"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_entrypoint_daily_counts" ADD CONSTRAINT "automation_entrypoint_daily_counts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_entrypoint_daily_counts" ADD CONSTRAINT "automation_entrypoint_daily_counts_entrypoint_org_scope_fk" FOREIGN KEY ("entrypoint_id","organization_id","scope_key") REFERENCES "public"."automation_entrypoints"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "automation_scheduled_jobs" ADD CONSTRAINT "automation_scheduled_jobs_run_auto_org_scope_fk" FOREIGN KEY ("run_id","automation_id","organization_id","scope_key") REFERENCES "public"."automation_runs"("id","automation_id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_scheduled_jobs" ADD CONSTRAINT "automation_scheduled_jobs_entrypoint_auto_org_scope_fk" FOREIGN KEY ("entrypoint_id","automation_id","organization_id","scope_key") REFERENCES "public"."automation_entrypoints"("id","automation_id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_secrets" ADD CONSTRAINT "automation_secrets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_secrets" ADD CONSTRAINT "automation_secrets_automation_org_fk" FOREIGN KEY ("automation_id","organization_id") REFERENCES "public"."automations"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_step_runs" ADD CONSTRAINT "automation_step_runs_run_auto_org_scope_fk" FOREIGN KEY ("run_id","automation_id","organization_id","scope_key") REFERENCES "public"."automation_runs"("id","automation_id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_webhook_receipts" ADD CONSTRAINT "automation_webhook_receipts_entrypoint_auto_org_fk" FOREIGN KEY ("entrypoint_id","automation_id","organization_id") REFERENCES "public"."automation_entrypoints"("id","automation_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_operation_attempts" ADD CONSTRAINT "billing_operation_attempts_operation_org_fk" FOREIGN KEY ("billing_operation_id","organization_id") REFERENCES "public"."billing_operations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_operations" ADD CONSTRAINT "billing_operations_billing_period_org_fk" FOREIGN KEY ("billing_period_id","organization_id") REFERENCES "public"."billing_periods"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_outbox" ADD CONSTRAINT "billing_outbox_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_org_scope_fk" FOREIGN KEY ("broadcast_id","organization_id","scope_key") REFERENCES "public"."broadcasts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_account_org_scope_platform_fk" FOREIGN KEY ("social_account_id","organization_id","scope_key","platform") REFERENCES "public"."social_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_logs" ADD CONSTRAINT "connection_logs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_logs" ADD CONSTRAINT "connection_logs_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_channels" ADD CONSTRAINT "contact_channels_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_channels" ADD CONSTRAINT "contact_channels_account_org_scope_platform_fk" FOREIGN KEY ("social_account_id","organization_id","scope_key","platform") REFERENCES "public"."social_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_events" ADD CONSTRAINT "contact_consent_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_events" ADD CONSTRAINT "contact_consent_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_events" ADD CONSTRAINT "contact_consent_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_events" ADD CONSTRAINT "contact_consent_events_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_events" ADD CONSTRAINT "contact_consent_events_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_states" ADD CONSTRAINT "contact_consent_states_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_states" ADD CONSTRAINT "contact_consent_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_states" ADD CONSTRAINT "contact_consent_states_projection_source_fk" FOREIGN KEY ("last_event_id","organization_id","scope_key","last_ordering_hlc","last_ordering_region") REFERENCES "public"."contact_consent_events"("id","organization_id","scope_key","ordering_hlc","ordering_region") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consent_states" ADD CONSTRAINT "contact_consent_states_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segment_memberships" ADD CONSTRAINT "contact_segment_memberships_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segment_memberships" ADD CONSTRAINT "contact_segment_memberships_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segment_memberships" ADD CONSTRAINT "contact_segment_memberships_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segment_memberships" ADD CONSTRAINT "contact_segment_memberships_static_segment_fk" FOREIGN KEY ("segment_id","organization_id","scope_key","segment_is_dynamic") REFERENCES "public"."segments"("id","organization_id","scope_key","is_dynamic") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_subscription_events" ADD CONSTRAINT "contact_subscription_events_list_org_scope_fk" FOREIGN KEY ("list_id","organization_id","scope_key") REFERENCES "public"."subscription_lists"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_subscriptions" ADD CONSTRAINT "contact_subscriptions_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_subscriptions" ADD CONSTRAINT "contact_subscriptions_list_org_scope_fk" FOREIGN KEY ("list_id","organization_id","scope_key") REFERENCES "public"."subscription_lists"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_subscriptions" ADD CONSTRAINT "contact_subscriptions_projection_source_fk" FOREIGN KEY ("last_event_id","organization_id","scope_key","list_id","contact_id","state","source","updated_at","last_event_sequence") REFERENCES "public"."contact_subscription_events"("id","organization_id","scope_key","list_id","contact_id","type","source","occurred_at","ingestion_sequence") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_auth_user_id_user_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_posts" ADD CONSTRAINT "external_posts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_posts" ADD CONSTRAINT "external_posts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_posts" ADD CONSTRAINT "external_posts_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_posts" ADD CONSTRAINT "external_posts_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_posts" ADD CONSTRAINT "external_posts_account_org_scope_platform_fk" FOREIGN KEY ("social_account_id","organization_id","scope_key","platform") REFERENCES "public"."social_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_activity" ADD CONSTRAINT "idea_activity_idea_org_fk" FOREIGN KEY ("idea_id","organization_id") REFERENCES "public"."ideas"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_activity" ADD CONSTRAINT "idea_activity_actor_principal_org_fk" FOREIGN KEY ("actor_principal_id","organization_id") REFERENCES "public"."organization_principals"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_comments" ADD CONSTRAINT "idea_comments_idea_org_fk" FOREIGN KEY ("idea_id","organization_id") REFERENCES "public"."ideas"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_comments" ADD CONSTRAINT "idea_comments_author_principal_org_fk" FOREIGN KEY ("author_principal_id","organization_id") REFERENCES "public"."organization_principals"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_comments" ADD CONSTRAINT "idea_comments_parent_idea_org_fk" FOREIGN KEY ("parent_id","idea_id","organization_id") REFERENCES "public"."idea_comments"("id","idea_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_conversion_operations" ADD CONSTRAINT "idea_conversion_operations_idea_org_scope_fk" FOREIGN KEY ("idea_id","organization_id","scope_key") REFERENCES "public"."ideas"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_conversion_operations" ADD CONSTRAINT "idea_conversion_operations_post_org_scope_fk" FOREIGN KEY ("post_id","organization_id","scope_key") REFERENCES "public"."posts"("id","organization_id","scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_groups" ADD CONSTRAINT "idea_groups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_groups" ADD CONSTRAINT "idea_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_groups" ADD CONSTRAINT "idea_groups_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_media" ADD CONSTRAINT "idea_media_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_media" ADD CONSTRAINT "idea_media_idea_org_scope_fk" FOREIGN KEY ("idea_id","organization_id","scope_key") REFERENCES "public"."ideas"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_media" ADD CONSTRAINT "idea_media_media_org_scope_fk" FOREIGN KEY ("media_id","organization_id","scope_key") REFERENCES "public"."media"("id","organization_id","scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_tags" ADD CONSTRAINT "idea_tags_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_tags" ADD CONSTRAINT "idea_tags_idea_org_scope_fk" FOREIGN KEY ("idea_id","organization_id","scope_key") REFERENCES "public"."ideas"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_tags" ADD CONSTRAINT "idea_tags_tag_org_scope_fk" FOREIGN KEY ("tag_id","organization_id","tag_scope_key") REFERENCES "public"."tags"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "invite_token_workspaces" ADD CONSTRAINT "invite_token_workspaces_selected_token_fk" FOREIGN KEY ("invite_token_id","organization_id","scope_mode") REFERENCES "public"."invite_tokens"("id","organization_id","scope_mode") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_token_workspaces" ADD CONSTRAINT "invite_token_workspaces_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_redeemed_by_user_id_user_id_fk" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_issuer_principal_org_fk" FOREIGN KEY ("created_by_principal_id","organization_id") REFERENCES "public"."organization_principals"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_automation_org_scope_fk" FOREIGN KEY ("automation_id","organization_id","scope_key") REFERENCES "public"."automations"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_storage_location_org_locator_fk" FOREIGN KEY ("storage_location_id","organization_id","storage_bucket_locator","storage_region") REFERENCES "public"."storage_locations"("id","organization_id","bucket","region") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_storage_credential_org_version_fk" FOREIGN KEY ("storage_location_id","organization_id","storage_credential_version") REFERENCES "public"."storage_credentials"("location_id","organization_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."member" ADD CONSTRAINT "member_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."member" ADD CONSTRAINT "member_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_member_fk" FOREIGN KEY ("user_id","organization_id") REFERENCES "auth"."member"("userId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_member_fk" FOREIGN KEY ("user_id","organization_id") REFERENCES "auth"."member"("userId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_capabilities" ADD CONSTRAINT "one_time_capabilities_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_resolution_notes" ADD CONSTRAINT "operator_resolution_notes_evidence_id_operator_resolution_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."operator_resolution_evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_streaks" ADD CONSTRAINT "org_streaks_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."organization_creation_reservation" ADD CONSTRAINT "organization_creation_reservation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_principals" ADD CONSTRAINT "organization_principals_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_principals" ADD CONSTRAINT "organization_principals_member_org_fk" FOREIGN KEY ("member_id","organization_id") REFERENCES "auth"."member"("id","organizationId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_current_attempt_identity_fk" FOREIGN KEY ("attempt_id","id","publish_operation_id") REFERENCES "public"."publish_attempts"("id","post_target_id","publish_operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_threads" ADD CONSTRAINT "post_threads_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_threads" ADD CONSTRAINT "post_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_threads" ADD CONSTRAINT "post_threads_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_recycled_from_id_posts_id_fk" FOREIGN KEY ("recycled_from_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_thread_org_scope_fk" FOREIGN KEY ("thread_group_id","organization_id","scope_key") REFERENCES "public"."post_threads"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_workspace_grants" ADD CONSTRAINT "principal_workspace_grants_selected_principal_fk" FOREIGN KEY ("principal_id","organization_id","scope_mode") REFERENCES "public"."organization_principals"("id","organization_id","scope_mode") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_workspace_grants" ADD CONSTRAINT "principal_workspace_grants_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_growth_events" ADD CONSTRAINT "public_growth_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_growth_events" ADD CONSTRAINT "public_growth_events_ref_url_org_scope_fk" FOREIGN KEY ("ref_url_id","organization_id","scope_key") REFERENCES "public"."ref_urls"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_growth_events" ADD CONSTRAINT "public_growth_events_qr_code_org_scope_fk" FOREIGN KEY ("qr_code_id","organization_id","scope_key") REFERENCES "public"."qr_codes"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_growth_events" ADD CONSTRAINT "public_growth_events_landing_page_org_scope_fk" FOREIGN KEY ("landing_page_id","organization_id","scope_key") REFERENCES "public"."landing_pages"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_growth_events" ADD CONSTRAINT "public_growth_events_contact_org_scope_fk" FOREIGN KEY ("contact_id","contact_organization_id","contact_scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_growth_events" ADD CONSTRAINT "public_growth_events_automation_org_scope_fk" FOREIGN KEY ("automation_id","automation_organization_id","automation_scope_key") REFERENCES "public"."automations"("id","organization_id","scope_key") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_target_operation_fk" FOREIGN KEY ("post_target_id","publish_operation_id") REFERENCES "public"."post_targets"("id","publish_operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_outbox" ADD CONSTRAINT "publish_outbox_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_outbox" ADD CONSTRAINT "publish_outbox_post_org_fk" FOREIGN KEY ("post_id","organization_id") REFERENCES "public"."posts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_ref_url_org_scope_fk" FOREIGN KEY ("ref_url_id","organization_id","scope_key") REFERENCES "public"."ref_urls"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_schedules" ADD CONSTRAINT "queue_schedules_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recycling_occurrences" ADD CONSTRAINT "recycling_occurrences_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recycling_occurrences" ADD CONSTRAINT "recycling_occurrences_config_org_fk" FOREIGN KEY ("config_id","organization_id") REFERENCES "public"."post_recycling_configs"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recycling_occurrences" ADD CONSTRAINT "recycling_occurrences_post_org_fk" FOREIGN KEY ("post_id","organization_id") REFERENCES "public"."posts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_urls" ADD CONSTRAINT "ref_urls_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_urls" ADD CONSTRAINT "ref_urls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_urls" ADD CONSTRAINT "ref_urls_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_urls" ADD CONSTRAINT "ref_urls_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_urls" ADD CONSTRAINT "ref_urls_automation_org_scope_fk" FOREIGN KEY ("automation_id","organization_id","scope_key") REFERENCES "public"."automations"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_urls" ADD CONSTRAINT "ref_urls_landing_page_org_scope_fk" FOREIGN KEY ("landing_page_id","organization_id","scope_key") REFERENCES "public"."landing_pages"("id","organization_id","scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_link_configs" ADD CONSTRAINT "short_link_configs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_link_configs" ADD CONSTRAINT "short_link_configs_credential_version_fk" FOREIGN KEY ("organization_id","provider","credential_version") REFERENCES "public"."short_link_credentials"("organization_id","provider","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_link_credentials" ADD CONSTRAINT "short_link_credentials_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_post_org_scope_fk" FOREIGN KEY ("post_id","organization_id","scope_key") REFERENCES "public"."posts"("id","organization_id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_credential_version_fk" FOREIGN KEY ("organization_id","provider","credential_version") REFERENCES "public"."short_link_credentials"("organization_id","provider","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_sync_state" ADD CONSTRAINT "social_account_sync_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_sync_state" ADD CONSTRAINT "social_account_sync_state_account_org_scope_platform_fk" FOREIGN KEY ("social_account_id","organization_id","scope_key","platform") REFERENCES "public"."social_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_credentials" ADD CONSTRAINT "storage_credentials_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."storage_locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_organization_leases" ADD CONSTRAINT "stripe_organization_leases_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_checkout_operations" ADD CONSTRAINT "subscription_checkout_operations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_lists" ADD CONSTRAINT "subscription_lists_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_lists" ADD CONSTRAINT "subscription_lists_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_lists" ADD CONSTRAINT "subscription_lists_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connection_challenges" ADD CONSTRAINT "telegram_connection_challenges_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connection_challenges" ADD CONSTRAINT "telegram_connection_challenges_authority_session_id_session_id_fk" FOREIGN KEY ("authority_session_id") REFERENCES "auth"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "tool_jobs" ADD CONSTRAINT "tool_jobs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_jobs" ADD CONSTRAINT "tool_jobs_usage_reservation_org_fk" FOREIGN KEY ("usage_reservation_id","organization_id") REFERENCES "public"."usage_reservations"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_buckets" ADD CONSTRAINT "usage_buckets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_buckets" ADD CONSTRAINT "usage_buckets_billing_period_window_fk" FOREIGN KEY ("billing_period_id","organization_id","period_start","period_end") REFERENCES "public"."billing_periods"("id","organization_id","period_start","period_end") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservation_carryovers" ADD CONSTRAINT "usage_reservation_carryovers_source_org_fk" FOREIGN KEY ("source_reservation_id","organization_id") REFERENCES "public"."usage_reservations"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservation_carryovers" ADD CONSTRAINT "usage_reservation_carryovers_successor_org_fk" FOREIGN KEY ("successor_bucket_id","organization_id") REFERENCES "public"."usage_buckets"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_delivery_org_fk" FOREIGN KEY ("delivery_id","organization_id") REFERENCES "public"."webhook_deliveries"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_phone_billing_attempts" ADD CONSTRAINT "wa_phone_billing_attempts_operation_org_fk" FOREIGN KEY ("phone_billing_operation_id","organization_id") REFERENCES "public"."whatsapp_phone_billing_operations"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_phone_billing_operations" ADD CONSTRAINT "whatsapp_phone_billing_operations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_phone_numbers" ADD CONSTRAINT "whatsapp_phone_numbers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_phone_numbers" ADD CONSTRAINT "whatsapp_phone_numbers_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_phone_provisioning_operations" ADD CONSTRAINT "whatsapp_phone_provisioning_operations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_phone_provisioning_operations" ADD CONSTRAINT "wa_phone_provisioning_phone_org_fk" FOREIGN KEY ("phone_number_id","organization_id") REFERENCES "public"."whatsapp_phone_numbers"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_phone_provisioning_operations" ADD CONSTRAINT "wa_phone_provisioning_usage_reservation_org_fk" FOREIGN KEY ("usage_reservation_id","organization_id") REFERENCES "public"."usage_reservations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_phone_release_operations" ADD CONSTRAINT "whatsapp_phone_release_operations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_phone_release_operations" ADD CONSTRAINT "wa_phone_release_phone_org_fk" FOREIGN KEY ("phone_number_id","organization_id") REFERENCES "public"."whatsapp_phone_numbers"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_phone_release_operations" ADD CONSTRAINT "wa_phone_release_usage_reservation_org_fk" FOREIGN KEY ("usage_reservation_id","organization_id") REFERENCES "public"."usage_reservations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_erasure_steps" ADD CONSTRAINT "workspace_erasure_steps_job_org_scope_fk" FOREIGN KEY ("workspace_id","organization_id","scope_key") REFERENCES "public"."workspace_erasure_jobs"("workspace_id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_revocation_jobs_due_idx" ON "account_revocation_jobs" USING btree ("status","next_attempt_at","created_at","id");--> statement-breakpoint
CREATE INDEX "account_revocation_jobs_org_idx" ON "account_revocation_jobs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "account_revocation_jobs_retention_idx" ON "account_revocation_jobs" USING btree ("completed_at","id") WHERE "account_revocation_jobs"."status" IN ('manual_required', 'succeeded', 'abandoned')
					AND "account_revocation_jobs"."completed_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_accounts_org_platform_id_idx" ON "ad_accounts" USING btree ("organization_id","platform","platform_ad_account_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_org_idx" ON "ad_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_workspace_idx" ON "ad_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_social_account_idx" ON "ad_accounts" USING btree ("social_account_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_status_idx" ON "ad_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ad_accounts_sync_due_idx" ON "ad_accounts" USING btree ("status","next_sync_at","sync_lease_expires_at","organization_id","id");--> statement-breakpoint
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
CREATE UNIQUE INDEX "ad_creation_operations_usage_reservation_uniq" ON "ad_creation_operations" USING btree ("usage_reservation_id") WHERE "ad_creation_operations"."usage_reservation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ad_creation_operations_due_idx" ON "ad_creation_operations" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "ad_creation_operations_org_created_idx" ON "ad_creation_operations" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "ad_creation_operations_retention_idx" ON "ad_creation_operations" USING btree (COALESCE("completed_at", "updated_at"),"id") WHERE "ad_creation_operations"."status" IN ('completed', 'failed', 'unknown', 'revocation_pending', 'manual_review', 'cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX "ad_metrics_ad_date_idx" ON "ad_metrics" USING btree ("ad_id","date");--> statement-breakpoint
CREATE INDEX "ad_metrics_ad_idx" ON "ad_metrics" USING btree ("ad_id");--> statement-breakpoint
CREATE INDEX "ad_metrics_retention_idx" ON "ad_metrics" USING btree ("date","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_mutation_operations_org_key_uniq" ON "ad_mutation_operations" USING btree ("organization_id","target_type","target_id","operation_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_mutation_operations_target_active_uniq" ON "ad_mutation_operations" USING btree ("organization_id","target_type","target_id") WHERE "ad_mutation_operations"."status" IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'reconciling', 'revocation_pending', 'manual_review');--> statement-breakpoint
CREATE UNIQUE INDEX "ad_mutation_operations_usage_reservation_uniq" ON "ad_mutation_operations" USING btree ("usage_reservation_id") WHERE "ad_mutation_operations"."usage_reservation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ad_mutation_operations_due_idx" ON "ad_mutation_operations" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "ad_mutation_operations_org_created_idx" ON "ad_mutation_operations" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "ad_mutation_operations_retention_idx" ON "ad_mutation_operations" USING btree (COALESCE("completed_at", "updated_at"),"id") WHERE "ad_mutation_operations"."status" IN ('completed', 'failed', 'unknown', 'revocation_pending', 'manual_review', 'cancelled');--> statement-breakpoint
CREATE INDEX "ad_sync_logs_org_idx" ON "ad_sync_logs" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "ad_sync_logs_ad_account_idx" ON "ad_sync_logs" USING btree ("ad_account_id");--> statement-breakpoint
CREATE INDEX "ad_sync_logs_retention_idx" ON "ad_sync_logs" USING btree ("completed_at","id") WHERE "ad_sync_logs"."completed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ads_org_idx" ON "ads" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ads_workspace_idx" ON "ads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ads_campaign_idx" ON "ads" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "ads_org_campaign_idx" ON "ads" USING btree ("organization_id","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ads_account_platform_ad_id_idx" ON "ads" USING btree ("ad_account_id","platform_ad_id");--> statement-breakpoint
CREATE INDEX "ads_org_status_idx" ON "ads" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "ads_boost_post_idx" ON "ads" USING btree ("boost_post_target_id");--> statement-breakpoint
CREATE INDEX "ads_boost_external_post_idx" ON "ads" USING btree ("boost_external_post_id");--> statement-breakpoint
CREATE INDEX "ads_metrics_poll_due_idx" ON "ads" USING btree ("metrics_next_poll_at","metrics_poll_lease_expires_at","organization_id","id");--> statement-breakpoint
CREATE INDEX "ai_agents_org_idx" ON "ai_agents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_bases_org_idx" ON "ai_knowledge_bases" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_knowledge_chunks_document_index_uniq" ON "ai_knowledge_chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_doc_idx" ON "ai_knowledge_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_kb_idx" ON "ai_knowledge_chunks" USING btree ("kb_id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_embedding_hnsw_idx" ON "ai_knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "ai_knowledge_documents_kb_idx" ON "ai_knowledge_documents" USING btree ("kb_id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_documents_due_idx" ON "ai_knowledge_documents" USING btree ("status","next_attempt_at","id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_documents_deadline_idx" ON "ai_knowledge_documents" USING btree ("deadline_at","id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_documents_failure_retention_idx" ON "ai_knowledge_documents" USING btree ("completed_at","id") WHERE "ai_knowledge_documents"."status" = 'terminal_failure';--> statement-breakpoint
CREATE INDEX "api_request_logs_org_created_idx" ON "api_request_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "api_request_logs_api_key_idx" ON "api_request_logs" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "api_request_logs_retention_idx" ON "api_request_logs" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "apikey_principal_idx" ON "auth"."apikey" USING btree ("organizationId","principalId","createdAt");--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "auth"."apikey" USING btree ("referenceId");--> statement-breakpoint
CREATE INDEX "apikey_organizationId_idx" ON "auth"."apikey" USING btree ("organizationId","createdAt","id");--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "auth"."apikey" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "auto_post_feed_items_rule_canonical_idx" ON "auto_post_feed_items" USING btree ("rule_id","canonical_feed_item_id");--> statement-breakpoint
CREATE INDEX "auto_post_feed_items_post_idx" ON "auto_post_feed_items" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "auto_post_feed_items_retention_idx" ON "auto_post_feed_items" USING btree (COALESCE("completed_at", "created_at"),"id") WHERE "auto_post_feed_items"."status" <> 'processing';--> statement-breakpoint
CREATE INDEX "auto_post_rules_org_status_idx" ON "auto_post_rules" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "auto_post_rules_workspace_idx" ON "auto_post_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_bindings_social_account_binding_type_uniq" ON "automation_bindings" USING btree ("social_account_id","binding_type");--> statement-breakpoint
CREATE INDEX "idx_automation_bindings_lookup" ON "automation_bindings" USING btree ("social_account_id","binding_type","status");--> statement-breakpoint
CREATE INDEX "idx_automation_bindings_automation" ON "automation_bindings" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "automation_bindings_sync_due_idx" ON "automation_bindings" USING btree ("sync_next_attempt_at","sync_lease_expires_at","organization_id","id");--> statement-breakpoint
CREATE INDEX "automation_bindings_sync_error_retention_idx" ON "automation_bindings" USING btree ("sync_error_at","id") WHERE "automation_bindings"."sync_error" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_contact_controls_per_auto" ON "automation_contact_controls" USING btree ("contact_id","automation_id") WHERE "automation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_contact_controls_global" ON "automation_contact_controls" USING btree ("contact_id") WHERE "automation_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_contact_controls_contact" ON "automation_contact_controls" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_contact_controls_expiry" ON "automation_contact_controls" USING btree ("paused_until") WHERE "automation_contact_controls"."paused_until" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_conversion_events_occurrence_uniq" ON "automation_conversion_events" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "automation_conversion_events_dispatch_due_idx" ON "automation_conversion_events" USING btree ("dispatch_status","next_dispatch_at","dispatch_lease_expires_at","id") WHERE "automation_conversion_events"."dispatch_status" IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "automation_conversion_events_dispatch_deadline_idx" ON "automation_conversion_events" USING btree ("dispatch_deadline_at","id") WHERE "automation_conversion_events"."dispatch_status" IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "automation_conversion_events_manual_review_idx" ON "automation_conversion_events" USING btree ("updated_at","id") WHERE "automation_conversion_events"."dispatch_status" = 'manual_review';--> statement-breakpoint
CREATE INDEX "automation_conversion_events_org_created_idx" ON "automation_conversion_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_conversion_events_contact_created_idx" ON "automation_conversion_events" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_conversion_events_retention_idx" ON "automation_conversion_events" USING btree ("created_at","id") WHERE "automation_conversion_events"."dispatch_status" = 'succeeded';--> statement-breakpoint
CREATE UNIQUE INDEX "automation_effects_execution_key_uniq" ON "automation_effects" USING btree ("node_execution_id","effect_key");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_effects_provider_idempotency_uniq" ON "automation_effects" USING btree ("provider_idempotency_key");--> statement-breakpoint
CREATE INDEX "automation_effects_claim_idx" ON "automation_effects" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "automation_effects_retention_idx" ON "automation_effects" USING btree ("completed_at","id") WHERE "automation_effects"."status" IN ('succeeded', 'failed', 'unknown')
					AND "automation_effects"."completed_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_entrypoint_daily_counts_entrypoint_day_uniq" ON "automation_entrypoint_daily_counts" USING btree ("entrypoint_id","day");--> statement-breakpoint
CREATE INDEX "automation_entrypoint_daily_counts_org_day_idx" ON "automation_entrypoint_daily_counts" USING btree ("organization_id","day");--> statement-breakpoint
CREATE INDEX "automation_entrypoint_daily_counts_retention_idx" ON "automation_entrypoint_daily_counts" USING btree ("day","id");--> statement-breakpoint
CREATE INDEX "idx_automation_entrypoints_automation" ON "automation_entrypoints" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "idx_automation_entrypoints_match" ON "automation_entrypoints" USING btree ("channel","kind","status");--> statement-breakpoint
CREATE INDEX "idx_automation_entrypoints_account_match" ON "automation_entrypoints" USING btree ("social_account_id","kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automation_entrypoints_webhook_slug" ON "automation_entrypoints" USING btree (("config"->>'webhook_slug')) WHERE "automation_entrypoints"."kind" = 'webhook_inbound';--> statement-breakpoint
CREATE UNIQUE INDEX "automation_node_executions_visit_uniq" ON "automation_node_executions" USING btree ("run_id","run_revision","visit_ordinal");--> statement-breakpoint
CREATE INDEX "automation_node_executions_claim_idx" ON "automation_node_executions" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "automation_node_executions_retention_idx" ON "automation_node_executions" USING btree ("completed_at","id") WHERE "automation_node_executions"."status" IN ('succeeded', 'failed', 'unknown')
					AND "automation_node_executions"."completed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_automation_runs_auto_status" ON "automation_runs" USING btree ("automation_id","status");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_contact_auto" ON "automation_runs" USING btree ("contact_id","automation_id");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_sweeper" ON "automation_runs" USING btree ("status","waiting_until");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_org_started" ON "automation_runs" USING btree ("organization_id","started_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_automation_runs_entrypoint" ON "automation_runs" USING btree ("entrypoint_id");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_binding" ON "automation_runs" USING btree ("binding_id");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_conversation" ON "automation_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automation_runs_active_uniq" ON "automation_runs" USING btree ("contact_id","automation_id") WHERE "status" IN ('active', 'waiting');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automation_runs_trigger_occurrence_uniq" ON "automation_runs" USING btree ("automation_id","trigger_occurrence_id");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_contact_occurrence" ON "automation_runs" USING btree ("organization_id","contact_id","trigger_occurrence_id") WHERE "automation_runs"."trigger_occurrence_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "automation_runs_retention_idx" ON "automation_runs" USING btree ("completed_at","id") WHERE "automation_runs"."status" IN ('completed', 'exited', 'failed')
					AND "automation_runs"."completed_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_scheduled_jobs_occurrence_uniq" ON "automation_scheduled_jobs" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_jobs_sweep" ON "automation_scheduled_jobs" USING btree ("status","run_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_scheduled_jobs_run" ON "automation_scheduled_jobs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_jobs_automation" ON "automation_scheduled_jobs" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_jobs_entrypoint" ON "automation_scheduled_jobs" USING btree ("entrypoint_id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_jobs_org_status_due" ON "automation_scheduled_jobs" USING btree ("organization_id","status","run_at","id");--> statement-breakpoint
CREATE INDEX "automation_scheduled_jobs_retention_idx" ON "automation_scheduled_jobs" USING btree ("run_at","id") WHERE "automation_scheduled_jobs"."status" IN ('done', 'failed', 'unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "automation_secrets_action_uniq" ON "automation_secrets" USING btree ("automation_id","node_key","action_id");--> statement-breakpoint
CREATE INDEX "automation_secrets_org_automation_idx" ON "automation_secrets" USING btree ("organization_id","automation_id");--> statement-breakpoint
CREATE INDEX "idx_step_runs_run_time" ON "automation_step_runs" USING btree ("run_id","executed_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_step_runs_auto_time" ON "automation_step_runs" USING btree ("automation_id","executed_at");--> statement-breakpoint
CREATE INDEX "automation_step_runs_org_time_idx" ON "automation_step_runs" USING btree ("organization_id","executed_at","id");--> statement-breakpoint
CREATE INDEX "automation_step_runs_org_scope_time_idx" ON "automation_step_runs" USING btree ("organization_id","scope_key","executed_at","id");--> statement-breakpoint
CREATE INDEX "idx_step_runs_node_time" ON "automation_step_runs" USING btree ("node_key","executed_at");--> statement-breakpoint
CREATE INDEX "idx_step_runs_executed_brin" ON "automation_step_runs" USING brin ("executed_at");--> statement-breakpoint
CREATE INDEX "automation_step_runs_retention_idx" ON "automation_step_runs" USING btree ("executed_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_webhook_receipts_entrypoint_digest_uniq" ON "automation_webhook_receipts" USING btree ("entrypoint_id","request_digest");--> statement-breakpoint
CREATE INDEX "automation_webhook_receipts_expiry_idx" ON "automation_webhook_receipts" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "automation_webhook_receipts_status_due_idx" ON "automation_webhook_receipts" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "automation_webhook_receipts_org_received_idx" ON "automation_webhook_receipts" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_automations_org_status" ON "automations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_automations_org_workspace" ON "automations" USING btree ("organization_id","workspace_id");--> statement-breakpoint
CREATE INDEX "idx_automations_template" ON "automations" USING btree ("created_from_template") WHERE "automations"."created_from_template" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_operation_attempts_operation_revision_uniq" ON "billing_operation_attempts" USING btree ("billing_operation_id","revision");--> statement-breakpoint
CREATE INDEX "billing_operation_attempts_operation_status_idx" ON "billing_operation_attempts" USING btree ("billing_operation_id","status");--> statement-breakpoint
CREATE INDEX "billing_operation_attempts_retention_idx" ON "billing_operation_attempts" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_operations_period_kind_uniq" ON "billing_operations" USING btree ("billing_period_id","kind");--> statement-breakpoint
CREATE INDEX "billing_operations_status_due_idx" ON "billing_operations" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "billing_operations_org_created_idx" ON "billing_operations" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "billing_operations_retention_idx" ON "billing_operations" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "billing_outbox_status_due_idx" ON "billing_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "billing_outbox_org_created_idx" ON "billing_outbox" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "billing_outbox_retention_idx" ON "billing_outbox" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_periods_org_start_live_uniq" ON "billing_periods" USING btree ("organization_id","period_start") WHERE "billing_periods"."state" <> 'void';--> statement-breakpoint
CREATE INDEX "billing_periods_org_cycle_idx" ON "billing_periods" USING btree ("organization_id","provider_cycle_anchor","period_start");--> statement-breakpoint
CREATE INDEX "billing_periods_state_end_idx" ON "billing_periods" USING btree ("state","period_end","organization_id","id");--> statement-breakpoint
CREATE INDEX "billing_periods_retention_idx" ON "billing_periods" USING btree ("period_end","id");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_contact_idx" ON "broadcast_recipients" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_identifier_hash_idx" ON "broadcast_recipients" USING btree ("contact_identifier_hash");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_claim_idx" ON "broadcast_recipients" USING btree ("broadcast_id","status","id");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_pii_retention_idx" ON "broadcast_recipients" USING btree ("broadcast_id","status","id") WHERE "broadcast_recipients"."pii_erased_at" IS NULL;--> statement-breakpoint
CREATE INDEX "broadcast_recipients_outcome_retention_idx" ON "broadcast_recipients" USING btree ("broadcast_id","status","id") WHERE "broadcast_recipients"."pii_erased_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_recipients_identity_uniq" ON "broadcast_recipients" USING btree ("broadcast_id","organization_id","scope_key","contact_identifier_hash");--> statement-breakpoint
CREATE INDEX "broadcasts_org_idx" ON "broadcasts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "broadcasts_workspace_idx" ON "broadcasts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "broadcasts_status_idx" ON "broadcasts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "broadcasts_org_status_idx" ON "broadcasts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "broadcasts_status_scheduled_idx" ON "broadcasts" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "broadcasts_status_lease_idx" ON "broadcasts" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "broadcasts_retention_idx" ON "broadcasts" USING btree ("completed_at","id") WHERE "broadcasts"."completed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "connection_logs_org_created_idx" ON "connection_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "connection_logs_retention_idx" ON "connection_logs" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "contact_channels_contact_idx" ON "contact_channels" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_channels_platform_account_contact_idx" ON "contact_channels" USING btree ("platform","social_account_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_channels_account_identifier_idx" ON "contact_channels" USING btree ("social_account_id","identifier_hash");--> statement-breakpoint
CREATE INDEX "contact_consent_events_contact_idx" ON "contact_consent_events" USING btree ("contact_id","occurred_at");--> statement-breakpoint
CREATE INDEX "contact_consent_events_identifier_idx" ON "contact_consent_events" USING btree ("organization_id","channel","purpose","logical_identifier_hash","occurred_at");--> statement-breakpoint
CREATE INDEX "contact_consent_events_supersession_idx" ON "contact_consent_events" USING btree ("organization_id","channel","purpose","logical_identifier_hash","ordering_hlc","ordering_region","id");--> statement-breakpoint
CREATE INDEX "contact_consent_events_org_ordering_idx" ON "contact_consent_events" USING btree ("organization_id","ordering_hlc","ordering_region","id");--> statement-breakpoint
CREATE INDEX "contact_consent_events_retention_idx" ON "contact_consent_events" USING btree ("occurred_at","id") WHERE "contact_consent_events"."contact_id" IS NOT NULL
					OR "contact_consent_events"."identifier_masked" IS NOT NULL
					OR "contact_consent_events"."evidence" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_consent_states_identifier_idx" ON "contact_consent_states" USING btree ("organization_id","channel","purpose","logical_identifier_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_consent_states_versioned_identifier_idx" ON "contact_consent_states" USING btree ("organization_id","channel","purpose","identifier_key_version","identifier_hash");--> statement-breakpoint
CREATE INDEX "contact_consent_states_denied_identifier_idx" ON "contact_consent_states" USING btree ("organization_id","channel","purpose","logical_identifier_hash") WHERE "contact_consent_states"."status" = 'denied';--> statement-breakpoint
CREATE INDEX "contact_segment_memberships_org_idx" ON "contact_segment_memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contact_segment_memberships_segment_idx" ON "contact_segment_memberships" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "contact_segment_memberships_contact_idx" ON "contact_segment_memberships" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_subscription_events_org_list_occurred_idx" ON "contact_subscription_events" USING btree ("organization_id","list_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "contact_subscription_events_org_contact_occurred_idx" ON "contact_subscription_events" USING btree ("organization_id","contact_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "contact_subscription_events_merge_lineage_idx" ON "contact_subscription_events" USING btree ("organization_id","merged_from_contact_id","contact_id") WHERE "contact_subscription_events"."merged_from_contact_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "contact_subscriptions_org_contact_list_idx" ON "contact_subscriptions" USING btree ("organization_id","contact_id","list_id");--> statement-breakpoint
CREATE INDEX "contact_subscriptions_org_list_updated_idx" ON "contact_subscriptions" USING btree ("organization_id","list_id","updated_at","contact_id");--> statement-breakpoint
CREATE INDEX "contact_subscriptions_org_list_active_idx" ON "contact_subscriptions" USING btree ("organization_id","list_id","updated_at","contact_id") WHERE "contact_subscriptions"."unsubscribed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "contact_subscriptions_org_list_unsubscribed_idx" ON "contact_subscriptions" USING btree ("organization_id","list_id","updated_at","contact_id") WHERE "contact_subscriptions"."unsubscribed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "contacts_org_idx" ON "contacts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contacts_workspace_idx" ON "contacts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "contacts_org_created_idx" ON "contacts" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "contacts_org_workspace_created_idx" ON "contacts" USING btree ("organization_id","workspace_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_scope_email_hash_uniq" ON "contacts" USING btree ("organization_id","scope_key","email_hash") WHERE "contacts"."email_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_scope_phone_hash_uniq" ON "contacts" USING btree ("organization_id","scope_key","phone_hash") WHERE "contacts"."phone_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "contacts_scope_name_hash_idx" ON "contacts" USING btree ("organization_id","scope_key","name_hash");--> statement-breakpoint
CREATE INDEX "contacts_name_search_tokens_idx" ON "contacts" USING gin ("name_search_tokens");--> statement-breakpoint
CREATE INDEX "contacts_email_search_tokens_idx" ON "contacts" USING gin ("email_search_tokens");--> statement-breakpoint
CREATE INDEX "contacts_phone_search_tokens_idx" ON "contacts" USING gin ("phone_search_tokens");--> statement-breakpoint
CREATE UNIQUE INDEX "content_templates_org_scope_name_uniq" ON "content_templates" USING btree ("organization_id","scope_key","name");--> statement-breakpoint
CREATE INDEX "content_templates_org_idx" ON "content_templates" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "content_templates_org_created_idx" ON "content_templates" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "content_templates_workspace_idx" ON "content_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cross_post_actions_operation_idx" ON "cross_post_actions" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "cross_post_actions_post_idx" ON "cross_post_actions" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "cross_post_actions_source_target_idx" ON "cross_post_actions" USING btree ("source_target_id");--> statement-breakpoint
CREATE INDEX "cross_post_actions_target_account_idx" ON "cross_post_actions" USING btree ("target_account_id");--> statement-breakpoint
CREATE INDEX "cross_post_actions_due_idx" ON "cross_post_actions" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "cross_post_actions_retention_idx" ON "cross_post_actions" USING btree ("completed_at","id") WHERE "cross_post_actions"."status" IN ('executed', 'failed', 'unknown', 'cancelled')
					AND "cross_post_actions"."completed_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_defs_org_scope_slug_uniq" ON "custom_field_definitions" USING btree ("organization_id","scope_key","slug");--> statement-breakpoint
CREATE INDEX "custom_field_defs_org_idx" ON "custom_field_definitions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "custom_field_defs_workspace_idx" ON "custom_field_definitions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_values_def_contact_idx" ON "custom_field_values" USING btree ("definition_id","contact_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_contact_idx" ON "custom_field_values" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dunning_events_invoice_event_uniq" ON "dunning_events" USING btree ("invoice_id","event") WHERE "dunning_events"."invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "dunning_events_stripe_invoice_event_uniq" ON "dunning_events" USING btree ("stripe_invoice_id","event") WHERE "dunning_events"."stripe_invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "dunning_events_org_idx" ON "dunning_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "dunning_events_invoice_id_idx" ON "dunning_events" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "dunning_events_status_due_idx" ON "dunning_events" USING btree ("status","due_at","next_attempt_at","organization_id","lease_expires_at");--> statement-breakpoint
CREATE INDEX "dunning_events_retention_idx" ON "dunning_events" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "email_deliveries_org_created_idx" ON "email_deliveries" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "email_deliveries_auth_user_created_idx" ON "email_deliveries" USING btree ("auth_user_id","created_at");--> statement-breakpoint
CREATE INDEX "email_deliveries_subject_user_idx" ON "email_deliveries" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "email_deliveries_pending_dispatch_idx" ON "email_deliveries" USING btree ("next_dispatch_at","deadline_at","dispatch_lease_expires_at","organization_id","created_at","id") WHERE "email_deliveries"."status" IN ('pending', 'unknown');--> statement-breakpoint
CREATE INDEX "email_deliveries_processing_lease_idx" ON "email_deliveries" USING btree ("lease_expires_at","id") WHERE "email_deliveries"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "email_deliveries_deadline_idx" ON "email_deliveries" USING btree ("deadline_at","id") WHERE "email_deliveries"."status" IN ('pending', 'processing', 'unknown');--> statement-breakpoint
CREATE INDEX "email_deliveries_expiry_idx" ON "email_deliveries" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "email_deliveries_purge_idx" ON "email_deliveries" USING btree ("purge_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "erasure_holds_active_subject_uniq" ON "erasure_holds" USING btree ("subject_kind","subject_id") WHERE "erasure_holds"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "erasure_holds_active_organization_idx" ON "erasure_holds" USING btree ("organization_tombstone_id","subject_kind","subject_id") WHERE "erasure_holds"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "erasure_holds_released_evidence_idx" ON "erasure_holds" USING btree ("released_at","evidence_redacted_at");--> statement-breakpoint
CREATE INDEX "erasure_holds_released_evidence_retention_idx" ON "erasure_holds" USING btree ("released_at","id") WHERE "erasure_holds"."released_at" IS NOT NULL AND "erasure_holds"."evidence_redacted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "external_posts_account_platform_post_idx" ON "external_posts" USING btree ("social_account_id","platform_post_id");--> statement-breakpoint
CREATE INDEX "external_posts_org_published_idx" ON "external_posts" USING btree ("organization_id","published_at");--> statement-breakpoint
CREATE INDEX "external_posts_org_platform_post_idx" ON "external_posts" USING btree ("organization_id","platform_post_id");--> statement-breakpoint
CREATE INDEX "external_posts_workspace_idx" ON "external_posts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "external_posts_metrics_poll_due_idx" ON "external_posts" USING btree ("metrics_next_poll_at","metrics_poll_lease_expires_at","id");--> statement-breakpoint
CREATE INDEX "external_posts_org_platform_idx" ON "external_posts" USING btree ("organization_id","platform");--> statement-breakpoint
CREATE INDEX "external_posts_account_published_idx" ON "external_posts" USING btree ("social_account_id","published_at");--> statement-breakpoint
CREATE INDEX "external_posts_retention_idx" ON "external_posts" USING btree ("published_at","id");--> statement-breakpoint
CREATE INDEX "external_posts_preview_retry_idx" ON "external_posts" USING btree ("preview_status","preview_next_retry_at");--> statement-breakpoint
CREATE UNIQUE INDEX "external_subject_cleanup_jobs_identity_uniq" ON "external_subject_cleanup_jobs" USING btree ("operation","bucket",COALESCE("object_locator", ''),COALESCE("prefix_locator", ''),CASE WHEN "operation" = 'purge_rescue_subject'
				THEN COALESCE("organization_id", '') ELSE '' END,CASE WHEN "operation" = 'purge_rescue_subject'
				THEN "subject_kind" ELSE '' END,CASE WHEN "operation" = 'purge_rescue_subject'
				THEN "subject_id" ELSE '' END,CASE WHEN "operation" = 'delete_short_link'
				THEN COALESCE("external_provider", '') ELSE '' END,CASE WHEN "operation" = 'delete_short_link'
				THEN COALESCE("provider_ref"::text, '') ELSE '' END,CASE WHEN "operation" = 'delete_short_link'
				THEN COALESCE("organization_id", '') ELSE '' END) WHERE "external_subject_cleanup_jobs"."status" <> 'completed';--> statement-breakpoint
CREATE INDEX "external_subject_cleanup_jobs_due_idx" ON "external_subject_cleanup_jobs" USING btree ("status",COALESCE("organization_id", "subject_kind" || ':' || "subject_id"),"next_attempt_at","id");--> statement-breakpoint
CREATE INDEX "external_subject_cleanup_jobs_deadline_idx" ON "external_subject_cleanup_jobs" USING btree (COALESCE("organization_id", "subject_kind" || ':' || "subject_id"),"deadline_at","id") WHERE "external_subject_cleanup_jobs"."status" IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "external_subject_cleanup_jobs_lease_idx" ON "external_subject_cleanup_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "external_subject_cleanup_jobs_subject_idx" ON "external_subject_cleanup_jobs" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "external_subject_cleanup_jobs_manual_review_idx" ON "external_subject_cleanup_jobs" USING btree ("updated_at","id") WHERE "external_subject_cleanup_jobs"."status" = 'manual_review';--> statement-breakpoint
CREATE INDEX "external_subject_cleanup_jobs_retention_idx" ON "external_subject_cleanup_jobs" USING btree ("purge_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_retention_receipts_tenant_source_uniq" ON "financial_retention_receipts" USING btree ("source_kind","source_id","organization_tombstone_id") WHERE "financial_retention_receipts"."organization_tombstone_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_retention_receipts_global_source_uniq" ON "financial_retention_receipts" USING btree ("source_kind","source_id") WHERE "financial_retention_receipts"."organization_tombstone_id" IS NULL;--> statement-breakpoint
CREATE INDEX "financial_retention_receipts_org_expiry_idx" ON "financial_retention_receipts" USING btree ("organization_tombstone_id","retained_until","id");--> statement-breakpoint
CREATE INDEX "financial_retention_receipts_expiry_idx" ON "financial_retention_receipts" USING btree ("retained_until","id");--> statement-breakpoint
CREATE INDEX "idea_activity_idea_created_idx" ON "idea_activity" USING btree ("organization_id","idea_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idea_activity_actor_idx" ON "idea_activity" USING btree ("organization_id","actor_principal_id");--> statement-breakpoint
CREATE INDEX "idea_activity_retention_idx" ON "idea_activity" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "idea_comments_idea_created_idx" ON "idea_comments" USING btree ("organization_id","idea_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idea_comments_parent_idx" ON "idea_comments" USING btree ("organization_id","parent_id");--> statement-breakpoint
CREATE INDEX "idea_comments_author_idx" ON "idea_comments" USING btree ("organization_id","author_principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_conversion_operations_idea_uniq" ON "idea_conversion_operations" USING btree ("idea_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_conversion_operations_org_idempotency_uniq" ON "idea_conversion_operations" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_conversion_operations_post_uniq" ON "idea_conversion_operations" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "idea_conversion_operations_claim_idx" ON "idea_conversion_operations" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idea_conversion_operations_retention_idx" ON "idea_conversion_operations" USING btree (COALESCE("completed_at", "updated_at"),"id") WHERE "idea_conversion_operations"."status" IN ('succeeded', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "idea_groups_default_per_scope_uniq" ON "idea_groups" USING btree ("organization_id","scope_key") WHERE "idea_groups"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "idea_groups_scope_position_uniq" ON "idea_groups" USING btree ("organization_id","scope_key","position");--> statement-breakpoint
CREATE INDEX "idea_groups_org_idx" ON "idea_groups" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idea_groups_workspace_idx" ON "idea_groups" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idea_groups_workspace_position_idx" ON "idea_groups" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_media_idea_position_uniq" ON "idea_media" USING btree ("idea_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_media_media_uniq" ON "idea_media" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "idea_media_idea_idx" ON "idea_media" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "idea_media_workspace_idx" ON "idea_media" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idea_tags_org_tag_idea_idx" ON "idea_tags" USING btree ("organization_id","tag_id","idea_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ideas_group_position_uniq" ON "ideas" USING btree ("group_id","organization_id","scope_key","position");--> statement-breakpoint
CREATE INDEX "ideas_org_idx" ON "ideas" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ideas_workspace_idx" ON "ideas" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ideas_group_position_idx" ON "ideas" USING btree ("group_id","position");--> statement-breakpoint
CREATE INDEX "ideas_assigned_to_idx" ON "ideas" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "ideas_org_created_idx" ON "ideas" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_receipts_scope_key_idx" ON "idempotency_receipts" USING btree ("organization_id","method","route_hash","idempotency_key");--> statement-breakpoint
CREATE INDEX "idempotency_receipts_expiry_idx" ON "idempotency_receipts" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "idempotency_receipts_state_created_idx" ON "idempotency_receipts" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_webhook_events_delivery_idx" ON "inbound_webhook_events" USING btree ("provider","delivery_key");--> statement-breakpoint
CREATE INDEX "inbound_webhook_events_status_idx" ON "inbound_webhook_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "inbound_webhook_events_reconcile_idx" ON "inbound_webhook_events" USING btree ("status","claimed_at","attempts","received_at");--> statement-breakpoint
CREATE INDEX "inbound_webhook_events_expiry_idx" ON "inbound_webhook_events" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "inbound_webhook_events_receipt_retention_idx" ON "inbound_webhook_events" USING btree ("received_at","id") WHERE "inbound_webhook_events"."redacted_at" IS NOT NULL;--> statement-breakpoint
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
CREATE INDEX "inbox_conv_contact_subject_idx" ON "inbox_conversations" USING btree ("organization_id","contact_subject_locator");--> statement-breakpoint
CREATE INDEX "inbox_conv_assigned_user_idx" ON "inbox_conversations" USING btree ("assigned_user_id");--> statement-breakpoint
CREATE INDEX "inbox_conv_open_activity_idx" ON "inbox_conversations" USING btree (COALESCE("last_message_at", "created_at"),"id") WHERE "inbox_conversations"."status" = 'open';--> statement-breakpoint
CREATE INDEX "inbox_conv_content_retention_due_idx" ON "inbox_conversations" USING btree ("content_expires_at","id") WHERE "inbox_conversations"."status" = 'archived' AND "inbox_conversations"."content_redacted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_event_effects_dedup_idx" ON "inbox_event_effects" USING btree ("organization_id","account_id","platform_event_id","effect");--> statement-breakpoint
CREATE INDEX "inbox_event_effects_status_idx" ON "inbox_event_effects" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "inbox_event_effects_lease_idx" ON "inbox_event_effects" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "inbox_event_effects_retention_idx" ON "inbox_event_effects" USING btree (COALESCE("completed_at", "updated_at"),"id") WHERE "inbox_event_effects"."status" IN ('completed', 'unknown');--> statement-breakpoint
CREATE INDEX "inbox_msg_conv_created_idx" ON "inbox_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "inbox_msg_org_created_idx" ON "inbox_messages" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_msg_account_platform_dedup_idx" ON "inbox_messages" USING btree ("platform","account_id","platform_message_id");--> statement-breakpoint
CREATE INDEX "inbox_msg_platform_message_id_idx" ON "inbox_messages" USING btree ("platform_message_id");--> statement-breakpoint
CREATE INDEX "inbox_msg_content_retention_pending_idx" ON "inbox_messages" USING btree ("conversation_id","id") WHERE "inbox_messages"."content_redacted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "inbox_msg_text_trgm_idx" ON "inbox_messages" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "invitation_email_status_expires_idx" ON "auth"."invitation" USING btree (lower("email"),"status","expiresAt");--> statement-breakpoint
CREATE INDEX "invitation_inviter_status_idx" ON "auth"."invitation" USING btree ("inviterId","status","id");--> statement-breakpoint
CREATE INDEX "invitation_retention_idx" ON "auth"."invitation" USING btree ("expiresAt","id");--> statement-breakpoint
CREATE INDEX "invite_token_workspaces_workspace_idx" ON "invite_token_workspaces" USING btree ("organization_id","workspace_id","invite_token_id");--> statement-breakpoint
CREATE INDEX "invite_token_workspaces_retention_idx" ON "invite_token_workspaces" USING btree ("invite_token_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_tokens_hash_idx" ON "invite_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invite_tokens_org_created_idx" ON "invite_tokens" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "invite_tokens_expiry_idx" ON "invite_tokens" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "invoices_org_period_idx" ON "invoices" USING btree ("organization_id","period_start");--> statement-breakpoint
CREATE INDEX "invoices_org_first_failure_idx" ON "invoices" USING btree ("organization_id","first_payment_failed_at");--> statement-breakpoint
CREATE INDEX "invoices_retention_idx" ON "invoices" USING btree (COALESCE("paid_at", "finalized_at", "period_end", "updated_at"),"id");--> statement-breakpoint
CREATE UNIQUE INDEX "landing_pages_org_scope_slug_uniq" ON "landing_pages" USING btree ("organization_id","scope_key","slug");--> statement-breakpoint
CREATE INDEX "landing_pages_automation_idx" ON "landing_pages" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "media_org_idx" ON "media" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "media_workspace_idx" ON "media" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_storage_key_uniq" ON "media" USING btree ("storage_provider",COALESCE("storage_location_id", ''),"storage_bucket_locator","storage_region","storage_key");--> statement-breakpoint
CREATE INDEX "media_thumbnail_retry_idx" ON "media" USING btree ("thumbnail_status","thumbnail_next_retry_at");--> statement-breakpoint
CREATE INDEX "media_upload_reconcile_idx" ON "media" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "media_deletion_retry_idx" ON "media" USING btree ("status","deletion_next_retry_at");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "auth"."member" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "auth"."member" USING btree ("organizationId");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_org_idx" ON "notification_preferences" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_read_idx" ON "notifications" USING btree ("user_id","read");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_occurrence_uniq" ON "notifications" USING btree ("user_id","organization_id","occurrence_id") WHERE "notifications"."occurrence_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notifications_retention_idx" ON "notifications" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "one_time_capabilities_expiry_idx" ON "one_time_capabilities" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "one_time_capabilities_org_kind_idx" ON "one_time_capabilities" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE INDEX "operator_resolution_evidence_target_idx" ON "operator_resolution_evidence" USING btree ("target_type","target_id","resolved_at","id");--> statement-breakpoint
CREATE INDEX "operator_resolution_evidence_org_resolved_idx" ON "operator_resolution_evidence" USING btree ("organization_id","resolved_at","id");--> statement-breakpoint
CREATE INDEX "operator_resolution_evidence_resolved_idx" ON "operator_resolution_evidence" USING btree ("resolved_at","id");--> statement-breakpoint
CREATE INDEX "operator_resolution_evidence_actor_resolved_idx" ON "operator_resolution_evidence" USING btree ("actor_user_id","resolved_at");--> statement-breakpoint
CREATE INDEX "operator_resolution_notes_expiry_idx" ON "operator_resolution_notes" USING btree ("expires_at","evidence_id");--> statement-breakpoint
CREATE INDEX "operator_resolution_notes_org_idx" ON "operator_resolution_notes" USING btree ("organization_id","evidence_id");--> statement-breakpoint
CREATE INDEX "org_streaks_org_idx" ON "org_streaks" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "org_streaks_last_post_idx" ON "org_streaks" USING btree ("last_post_at");--> statement-breakpoint
CREATE INDEX "organization_creation_reservation_user_expiry_idx" ON "auth"."organization_creation_reservation" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "organization_creation_reservation_expiry_idx" ON "auth"."organization_creation_reservation" USING btree ("expires_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_principals_member_uniq" ON "organization_principals" USING btree ("organization_id","member_id") WHERE "organization_principals"."kind" = 'member';--> statement-breakpoint
CREATE INDEX "organization_principals_org_kind_status_idx" ON "organization_principals" USING btree ("organization_id","kind","lifecycle_status");--> statement-breakpoint
CREATE UNIQUE INDEX "org_subs_stripe_sub_id_idx" ON "organization_subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_subs_stripe_customer_id_idx" ON "organization_subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "post_analytics_target_collected_idx" ON "post_analytics" USING btree ("post_target_id","collected_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "post_analytics_target_window_uniq" ON "post_analytics" USING btree ("post_target_id","observation_window_start");--> statement-breakpoint
CREATE INDEX "post_analytics_retention_idx" ON "post_analytics" USING btree ("collected_at","id");--> statement-breakpoint
CREATE INDEX "post_recycling_configs_org_idx" ON "post_recycling_configs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "post_recycling_configs_enabled_next_idx" ON "post_recycling_configs" USING btree ("enabled","processing_state","next_recycle_at");--> statement-breakpoint
CREATE UNIQUE INDEX "post_recycling_configs_source_post_idx" ON "post_recycling_configs" USING btree ("source_post_id");--> statement-breakpoint
CREATE INDEX "post_tags_org_post_tag_idx" ON "post_tags" USING btree ("organization_id","post_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "post_targets_publish_operation_idx" ON "post_targets" USING btree ("publish_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "post_targets_post_account_idx" ON "post_targets" USING btree ("post_id","social_account_id");--> statement-breakpoint
CREATE INDEX "post_targets_post_status_idx" ON "post_targets" USING btree ("post_id","status");--> statement-breakpoint
CREATE INDEX "post_targets_social_account_id_idx" ON "post_targets" USING btree ("social_account_id");--> statement-breakpoint
CREATE INDEX "post_targets_updated_at_idx" ON "post_targets" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "post_targets_reconcile_due_idx" ON "post_targets" USING btree ("next_reconcile_at","id") WHERE "post_targets"."delivery_state" = 'unknown' AND "post_targets"."next_reconcile_at" IS NOT NULL;--> statement-breakpoint
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
CREATE INDEX "posts_metrics_refresh_idx" ON "posts" USING btree ("metrics_next_poll_at","metrics_refresh_lease_expires_at") WHERE "posts"."status" = 'published';--> statement-breakpoint
CREATE INDEX "principal_workspace_grants_workspace_idx" ON "principal_workspace_grants" USING btree ("organization_id","workspace_id","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "public_growth_events_idempotency_uniq" ON "public_growth_events" USING btree ("organization_id","event_type",COALESCE("ref_url_id", "qr_code_id", "landing_page_id"),"idempotency_hash");--> statement-breakpoint
CREATE INDEX "public_growth_events_due_dispatch_idx" ON "public_growth_events" USING btree ("next_attempt_at","organization_id","occurred_at","id") WHERE "public_growth_events"."status" IN ('pending', 'retry');--> statement-breakpoint
CREATE INDEX "public_growth_events_stale_lease_idx" ON "public_growth_events" USING btree ("lease_expires_at","organization_id","occurred_at","id") WHERE "public_growth_events"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "public_growth_events_ref_target_idx" ON "public_growth_events" USING btree ("ref_url_id","organization_id","scope_key") WHERE "public_growth_events"."ref_url_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "public_growth_events_qr_target_idx" ON "public_growth_events" USING btree ("qr_code_id","organization_id","scope_key") WHERE "public_growth_events"."qr_code_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "public_growth_events_landing_target_idx" ON "public_growth_events" USING btree ("landing_page_id","organization_id","scope_key") WHERE "public_growth_events"."landing_page_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "public_growth_events_automation_idx" ON "public_growth_events" USING btree ("automation_id","automation_organization_id","automation_scope_key") WHERE "public_growth_events"."automation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "public_growth_events_contact_idx" ON "public_growth_events" USING btree ("organization_id","contact_id","contact_scope_key","occurred_at");--> statement-breakpoint
CREATE INDEX "public_growth_events_retention_idx" ON "public_growth_events" USING btree ("completed_at","id") WHERE "public_growth_events"."status" IN ('succeeded', 'failed');--> statement-breakpoint
CREATE INDEX "publish_attempts_target_claimed_idx" ON "publish_attempts" USING btree ("post_target_id","claimed_at");--> statement-breakpoint
CREATE INDEX "publish_attempts_retention_idx" ON "publish_attempts" USING btree ("completed_at","id") WHERE "publish_attempts"."state" IN ('succeeded', 'failed', 'unknown')
					AND "publish_attempts"."completed_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "publish_outbox_operation_idx" ON "publish_outbox" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "publish_outbox_pending_idx" ON "publish_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "publish_outbox_retention_idx" ON "publish_outbox" USING btree ("status","dispatched_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "qr_codes_ref_url_label_uniq" ON "qr_codes" USING btree ("ref_url_id",lower("label"));--> statement-breakpoint
CREATE INDEX "qr_codes_org_scope_created_idx" ON "qr_codes" USING btree ("organization_id","scope_key","created_at","id");--> statement-breakpoint
CREATE INDEX "qr_codes_ref_url_idx" ON "qr_codes" USING btree ("ref_url_id");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_failures_queue_message_idx" ON "queue_failures" USING btree ("queue_name","message_id");--> statement-breakpoint
CREATE INDEX "queue_failures_status_created_idx" ON "queue_failures" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "queue_failures_operation_idx" ON "queue_failures" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "queue_failures_organization_ids_idx" ON "queue_failures" USING gin ("organization_ids");--> statement-breakpoint
CREATE INDEX "queue_failures_workspace_ids_idx" ON "queue_failures" USING gin ("workspace_ids");--> statement-breakpoint
CREATE INDEX "queue_failures_user_ids_idx" ON "queue_failures" USING gin ("user_ids");--> statement-breakpoint
CREATE INDEX "queue_failures_contact_ids_idx" ON "queue_failures" USING gin ("contact_ids");--> statement-breakpoint
CREATE INDEX "queue_failures_account_ids_idx" ON "queue_failures" USING gin ("account_ids");--> statement-breakpoint
CREATE INDEX "queue_failures_replay_claim_idx" ON "queue_failures" USING btree ("status","replay_claim_expires_at");--> statement-breakpoint
CREATE INDEX "queue_failures_payload_expiry_idx" ON "queue_failures" USING btree ("payload_expires_at","id");--> statement-breakpoint
CREATE INDEX "queue_failures_purge_idx" ON "queue_failures" USING btree ("purge_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_schedules_one_default_per_org_uniq" ON "queue_schedules" USING btree ("organization_id") WHERE "queue_schedules"."is_default" = true;--> statement-breakpoint
CREATE INDEX "queue_schedules_org_created_idx" ON "queue_schedules" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "recycling_occurrences_config_scheduled_idx" ON "recycling_occurrences" USING btree ("config_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "recycling_occurrences_post_idx" ON "recycling_occurrences" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "recycling_occurrences_retention_idx" ON "recycling_occurrences" USING btree ("completed_at","id") WHERE "recycling_occurrences"."status" IN ('committed', 'terminal_failure', 'unknown')
					AND "recycling_occurrences"."completed_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ref_urls_org_scope_slug_uniq" ON "ref_urls" USING btree ("organization_id","scope_key","slug");--> statement-breakpoint
CREATE INDEX "ref_urls_automation_idx" ON "ref_urls" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "ref_urls_landing_page_idx" ON "ref_urls" USING btree ("landing_page_id");--> statement-breakpoint
CREATE INDEX "retention_drain_runs_continuation_idx" ON "retention_drain_runs" USING btree ("status","backlog_oldest_due_at","handler_id") WHERE "retention_drain_runs"."backlog_oldest_due_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "retention_drain_runs_lease_idx" ON "retention_drain_runs" USING btree ("lease_expires_at","handler_id") WHERE "retention_drain_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "segments_org_idx" ON "segments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "segments_workspace_idx" ON "segments" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_idx" ON "auth"."session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "auth"."session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "session_impersonatedBy_idx" ON "auth"."session" USING btree ("impersonatedBy");--> statement-breakpoint
CREATE INDEX "session_expires_idx" ON "auth"."session" USING btree ("expiresAt","id");--> statement-breakpoint
CREATE INDEX "short_link_configs_org_idx" ON "short_link_configs" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "short_link_credentials_org_active_uniq" ON "short_link_credentials" USING btree ("organization_id") WHERE "short_link_credentials"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "short_links_provider_code_uniq" ON "short_links" USING btree ("provider","short_code") WHERE "short_links"."provider" = 'relayapi' AND "short_links"."short_code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "short_links_short_url_uniq" ON "short_links" USING btree ("short_url") WHERE "short_links"."short_url" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "short_links_org_idx" ON "short_links" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "short_links_post_idx" ON "short_links" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "short_links_created_sync_idx" ON "short_links" USING btree ("created_at","last_click_sync_at");--> statement-breakpoint
CREATE INDEX "short_links_click_sync_due_idx" ON "short_links" USING btree ("next_click_sync_at","click_sync_lease_expires_at","organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "signatures_org_scope_name_uniq" ON "signatures" USING btree ("organization_id","scope_key","name");--> statement-breakpoint
CREATE UNIQUE INDEX "signatures_org_scope_default_uniq" ON "signatures" USING btree ("organization_id","scope_key") WHERE "signatures"."is_default" = true;--> statement-breakpoint
CREATE INDEX "signatures_org_idx" ON "signatures" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "signatures_workspace_idx" ON "signatures" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sync_state_enabled_next_idx" ON "social_account_sync_state" USING btree ("enabled","next_sync_at","poll_lease_expires_at","organization_id","id");--> statement-breakpoint
CREATE INDEX "sync_state_org_idx" ON "social_account_sync_state" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "social_account_sync_error_retention_idx" ON "social_account_sync_state" USING btree ("last_error_at","id") WHERE "social_account_sync_state"."last_error" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_org_platform_account_idx" ON "social_accounts" USING btree ("organization_id","platform","platform_account_id");--> statement-breakpoint
CREATE INDEX "social_accounts_org_idx" ON "social_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "social_accounts_webhook_id_idx" ON "social_accounts" USING btree ("platform","webhook_account_id");--> statement-breakpoint
CREATE INDEX "social_accounts_workspace_idx" ON "social_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "social_accounts_org_lifecycle_idx" ON "social_accounts" USING btree ("organization_id","lifecycle_status");--> statement-breakpoint
CREATE INDEX "social_accounts_sms_webhook_route_idx" ON "social_accounts" USING btree ("platform_account_id") WHERE "social_accounts"."platform" = 'sms' AND "social_accounts"."lifecycle_status" = 'active';--> statement-breakpoint
CREATE INDEX "social_accounts_token_expiry_idx" ON "social_accounts" USING btree ("token_expires_at") WHERE "social_accounts"."lifecycle_status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "storage_credentials_org_active_uniq" ON "storage_credentials" USING btree ("organization_id") WHERE "storage_credentials"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "storage_credentials_org_staged_uniq" ON "storage_credentials" USING btree ("organization_id") WHERE "storage_credentials"."state" = 'staged';--> statement-breakpoint
CREATE INDEX "storage_credentials_location_state_idx" ON "storage_credentials" USING btree ("location_id","state","version");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_locations_definition_uniq" ON "storage_locations" USING btree ("organization_id","endpoint","bucket","region","key_prefix","force_path_style") WHERE "storage_locations"."retired_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_locations_org_active_uniq" ON "storage_locations" USING btree ("organization_id") WHERE "storage_locations"."activated_at" IS NOT NULL AND "storage_locations"."retired_at" IS NULL;--> statement-breakpoint
CREATE INDEX "storage_locations_org_created_idx" ON "storage_locations" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "stripe_events_status_due_idx" ON "stripe_events" USING btree ("status","next_attempt_at","received_at","id");--> statement-breakpoint
CREATE INDEX "stripe_events_processing_lease_idx" ON "stripe_events" USING btree ("lease_expires_at","id") WHERE "stripe_events"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "stripe_events_retention_idx" ON "stripe_events" USING btree ("received_at","id");--> statement-breakpoint
CREATE INDEX "stripe_events_organization_retention_idx" ON "stripe_events" USING btree ("organization_id","received_at","id");--> statement-breakpoint
CREATE INDEX "stripe_organization_leases_expiry_idx" ON "stripe_organization_leases" USING btree ("lease_expires_at","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_checkout_operations_active_org_uniq" ON "subscription_checkout_operations" USING btree ("organization_id") WHERE "subscription_checkout_operations"."status" IN ('pending', 'creating', 'unknown', 'created');--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_checkout_operations_session_uniq" ON "subscription_checkout_operations" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE INDEX "subscription_checkout_operations_status_lease_idx" ON "subscription_checkout_operations" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "subscription_checkout_operations_org_created_idx" ON "subscription_checkout_operations" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "subscription_checkout_operations_retention_idx" ON "subscription_checkout_operations" USING btree ("updated_at","id");--> statement-breakpoint
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
CREATE INDEX "tenant_deletion_steps_completed_retention_idx" ON "tenant_deletion_steps" USING btree ("completed_at","id") WHERE "tenant_deletion_steps"."status" = 'completed';--> statement-breakpoint
CREATE INDEX "thread_executions_org_status_idx" ON "thread_executions" USING btree ("organization_id","status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "thread_executions_status_lease_idx" ON "thread_executions" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "thread_executions_retention_idx" ON "thread_executions" USING btree ("updated_at","thread_group_id") WHERE "thread_executions"."status" IN ('completed', 'failed', 'unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "token_refresh_operations_operation_id_idx" ON "token_refresh_operations" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "token_refresh_operations_retention_idx" ON "token_refresh_operations" USING btree (COALESCE("completed_at", "updated_at"),"account_id") WHERE "token_refresh_operations"."state" IN ('succeeded', 'unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "tool_jobs_usage_reservation_uniq" ON "tool_jobs" USING btree ("usage_reservation_id");--> statement-breakpoint
CREATE INDEX "tool_jobs_due_idx" ON "tool_jobs" USING btree ("next_attempt_at","id") WHERE "tool_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "tool_jobs_pending_deadline_idx" ON "tool_jobs" USING btree ("deadline_at","id") WHERE "tool_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "tool_jobs_stale_lease_idx" ON "tool_jobs" USING btree ("lease_expires_at","id") WHERE "tool_jobs"."status" = 'processing' AND "tool_jobs"."request_may_have_been_sent_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tool_jobs_armed_lease_idx" ON "tool_jobs" USING btree ("lease_expires_at","deadline_at","id") WHERE "tool_jobs"."status" = 'processing' AND "tool_jobs"."request_may_have_been_sent_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tool_jobs_org_created_idx" ON "tool_jobs" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "tool_jobs_purge_idx" ON "tool_jobs" USING btree ("purge_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_buckets_org_metric_period_uniq" ON "usage_buckets" USING btree ("organization_id","metric","period_start");--> statement-breakpoint
CREATE INDEX "usage_buckets_org_period_end_idx" ON "usage_buckets" USING btree ("organization_id","period_end");--> statement-breakpoint
CREATE INDEX "usage_buckets_retention_idx" ON "usage_buckets" USING btree ("period_end","id");--> statement-breakpoint
CREATE INDEX "usage_reservation_carryovers_successor_idx" ON "usage_reservation_carryovers" USING btree ("successor_bucket_id","source_reservation_id");--> statement-breakpoint
CREATE INDEX "usage_reservation_carryovers_source_idx" ON "usage_reservation_carryovers" USING btree ("source_reservation_id","successor_bucket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_reservations_org_idempotency_uniq" ON "usage_reservations" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "usage_reservations_bucket_state_idx" ON "usage_reservations" USING btree ("bucket_id","state");--> statement-breakpoint
CREATE INDEX "usage_reservations_reserved_age_idx" ON "usage_reservations" USING btree ("reserved_at","id") WHERE "usage_reservations"."state" = 'reserved';--> statement-breakpoint
CREATE INDEX "usage_reservations_parked_age_idx" ON "usage_reservations" USING btree ("reserved_at","id") WHERE "usage_reservations"."state" = 'parked';--> statement-breakpoint
CREATE INDEX "usage_reservations_retention_idx" ON "usage_reservations" USING btree ("bucket_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_idx" ON "auth"."user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "auth"."verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verification_value_idx" ON "auth"."verification" USING btree ("value");--> statement-breakpoint
CREATE INDEX "verification_expires_idx" ON "auth"."verification" USING btree ("expiresAt","id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_endpoint_idx" ON "webhook_deliveries" USING btree ("webhook_event_id","webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_idx" ON "webhook_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_dispatch_idx" ON "webhook_deliveries" USING btree ("status","next_dispatch_at","dispatch_lease_expires_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_retention_idx" ON "webhook_deliveries" USING btree ("completed_at","id") WHERE "webhook_deliveries"."status" IN ('succeeded', 'failed', 'unresolved');--> statement-breakpoint
CREATE INDEX "webhook_deliveries_manual_review_expiry_idx" ON "webhook_deliveries" USING btree ("manual_review_until","id") WHERE "webhook_deliveries"."status" = 'manual_review';--> statement-breakpoint
CREATE INDEX "webhook_endpoints_org_idx" ON "webhook_endpoints" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_workspace_idx" ON "webhook_endpoints" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_org_occurrence_idx" ON "webhook_events" USING btree ("organization_id","occurrence_id");--> statement-breakpoint
CREATE INDEX "webhook_events_retention_idx" ON "webhook_events" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_logs_delivery_attempt_uniq" ON "webhook_logs" USING btree ("delivery_id","attempt_ordinal") WHERE "webhook_logs"."delivery_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "webhook_logs_event_created_idx" ON "webhook_logs" USING btree ("webhook_event_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_logs_org_created_idx" ON "webhook_logs" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "webhook_logs_retention_idx" ON "webhook_logs" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_phone_billing_attempts_operation_revision_uniq" ON "whatsapp_phone_billing_attempts" USING btree ("phone_billing_operation_id","revision");--> statement-breakpoint
CREATE INDEX "wa_phone_billing_attempts_operation_status_idx" ON "whatsapp_phone_billing_attempts" USING btree ("phone_billing_operation_id","status");--> statement-breakpoint
CREATE INDEX "wa_phone_billing_attempts_retention_idx" ON "whatsapp_phone_billing_attempts" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "wa_phone_billing_status_due_idx" ON "whatsapp_phone_billing_operations" USING btree ("state","next_attempt_at","organization_id");--> statement-breakpoint
CREATE INDEX "wa_phone_billing_lease_idx" ON "whatsapp_phone_billing_operations" USING btree ("lease_expires_at","organization_id") WHERE "whatsapp_phone_billing_operations"."state" IN ('processing', 'request_may_have_been_sent');--> statement-breakpoint
CREATE UNIQUE INDEX "wa_phone_numbers_telnyx_order_uniq" ON "whatsapp_phone_numbers" USING btree ("telnyx_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_phone_numbers_provider_number_uniq" ON "whatsapp_phone_numbers" USING btree ("provider_number_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_phone_numbers_meta_number_uniq" ON "whatsapp_phone_numbers" USING btree ("wa_phone_number_id");--> statement-breakpoint
CREATE INDEX "wa_phone_numbers_org_idx" ON "whatsapp_phone_numbers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "wa_phone_numbers_status_idx" ON "whatsapp_phone_numbers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_phone_provisioning_phone_uniq" ON "whatsapp_phone_provisioning_operations" USING btree ("phone_number_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_phone_provisioning_usage_reservation_uniq" ON "whatsapp_phone_provisioning_operations" USING btree ("usage_reservation_id") WHERE "whatsapp_phone_provisioning_operations"."usage_reservation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_phone_provisioning_org_key_uniq" ON "whatsapp_phone_provisioning_operations" USING btree ("organization_id","idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "wa_phone_provisioning_status_due_idx" ON "whatsapp_phone_provisioning_operations" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "wa_phone_provisioning_org_idx" ON "whatsapp_phone_provisioning_operations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "wa_phone_provisioning_detail_expiry_idx" ON "whatsapp_phone_provisioning_operations" USING btree ("detail_expires_at","id") WHERE "whatsapp_phone_provisioning_operations"."detail_redacted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "wa_phone_provisioning_evidence_retention_idx" ON "whatsapp_phone_provisioning_operations" USING btree ("detail_expires_at","id") WHERE "whatsapp_phone_provisioning_operations"."status" IN ('completed', 'cancelled')
					AND "whatsapp_phone_provisioning_operations"."detail_redacted_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_phone_release_phone_uniq" ON "whatsapp_phone_release_operations" USING btree ("phone_number_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_phone_release_usage_reservation_uniq" ON "whatsapp_phone_release_operations" USING btree ("usage_reservation_id") WHERE "whatsapp_phone_release_operations"."usage_reservation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "wa_phone_release_status_due_idx" ON "whatsapp_phone_release_operations" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "wa_phone_release_org_idx" ON "whatsapp_phone_release_operations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "wa_phone_release_retention_idx" ON "whatsapp_phone_release_operations" USING btree ("completed_at","id") WHERE "whatsapp_phone_release_operations"."status" = 'completed';--> statement-breakpoint
CREATE INDEX "workspace_erasure_jobs_org_status_idx" ON "workspace_erasure_jobs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "workspace_erasure_jobs_due_idx" ON "workspace_erasure_jobs" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_erasure_steps_workspace_key_uniq" ON "workspace_erasure_steps" USING btree ("workspace_id","step_key");--> statement-breakpoint
CREATE INDEX "workspace_erasure_steps_due_idx" ON "workspace_erasure_steps" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "workspace_erasure_steps_completed_retention_idx" ON "workspace_erasure_steps" USING btree ("completed_at","id") WHERE "workspace_erasure_steps"."status" = 'completed';--> statement-breakpoint
CREATE INDEX "workspace_tombstones_org_erased_idx" ON "workspace_tombstones" USING btree ("organization_id","erased_at");--> statement-breakpoint
CREATE INDEX "workspaces_org_idx" ON "workspaces" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "workspaces_org_name_idx" ON "workspaces" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "workspaces_org_slug_idx" ON "workspaces" USING btree ("organization_id","slug");--> statement-breakpoint
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

	INSERT INTO public."workspaces" (id, organization_id, name, slug, lifecycle_status)
	SELECT 'ws_' || replace(gen_random_uuid()::text, '-', ''), NEW.id, 'General', 'general', 'active'
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

INSERT INTO public."workspaces" (id, organization_id, name, slug, lifecycle_status)
SELECT 'ws_' || replace(gen_random_uuid()::text, '-', ''), organization_row.id, 'General', 'general', 'active'
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
BEFORE INSERT OR UPDATE OF "idea_id", "organization_id", "scope_key"
ON public."idea_tags"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('ideas', 'idea_id', 'scope_key:scope_key');
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

DROP TRIGGER IF EXISTS "project_automation_entrypoint_daily_counts_entrypoint_id" ON public."automation_entrypoint_daily_counts";
--> statement-breakpoint
CREATE TRIGGER "project_automation_entrypoint_daily_counts_entrypoint_id"
BEFORE INSERT OR UPDATE OF "entrypoint_id", "organization_id", "scope_key"
ON public."automation_entrypoint_daily_counts"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('automation_entrypoints', 'entrypoint_id', 'scope_key:scope_key');
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

DROP TRIGGER IF EXISTS "project_automation_conversion_events_run_id" ON public."automation_conversion_events";
--> statement-breakpoint
CREATE TRIGGER "project_automation_conversion_events_run_id"
BEFORE INSERT OR UPDATE OF "run_id", "organization_id", "scope_key"
ON public."automation_conversion_events"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('automation_runs', 'run_id', 'scope_key:scope_key');
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

DROP TRIGGER IF EXISTS "project_automation_step_runs_run_id" ON public."automation_step_runs";
--> statement-breakpoint
CREATE TRIGGER "project_automation_step_runs_run_id"
BEFORE INSERT OR UPDATE OF "run_id", "organization_id", "automation_id", "scope_key"
ON public."automation_step_runs"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('automation_runs', 'run_id', 'automation_id:automation_id,scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_contact_segment_memberships_segment_id" ON public."contact_segment_memberships";
--> statement-breakpoint
CREATE TRIGGER "project_contact_segment_memberships_segment_id"
BEFORE INSERT OR UPDATE OF "segment_id", "organization_id", "scope_key", "segment_is_dynamic"
ON public."contact_segment_memberships"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('segments', 'segment_id', 'scope_key:scope_key,is_dynamic:segment_is_dynamic');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_contact_subscriptions_list_id" ON public."contact_subscriptions";
--> statement-breakpoint
CREATE TRIGGER "project_contact_subscriptions_list_id"
BEFORE INSERT OR UPDATE OF "list_id", "organization_id", "scope_key"
ON public."contact_subscriptions"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('subscription_lists', 'list_id', 'scope_key:scope_key');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "project_contact_subscription_events_list_id" ON public."contact_subscription_events";
--> statement-breakpoint
CREATE TRIGGER "project_contact_subscription_events_list_id"
BEFORE INSERT OR UPDATE OF "list_id", "organization_id", "scope_key"
ON public."contact_subscription_events"
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

DROP TRIGGER IF EXISTS "project_billing_operations_billing_period_id" ON public."billing_operations";
--> statement-breakpoint
CREATE TRIGGER "project_billing_operations_billing_period_id"
BEFORE INSERT OR UPDATE OF "billing_period_id", "organization_id", "amount_cents", "currency"
ON public."billing_operations"
FOR EACH ROW
EXECUTE FUNCTION "public"."project_parent_identity"('billing_periods', 'billing_period_id', 'amount_cents_snapshot:amount_cents,currency:currency');
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

CREATE OR REPLACE FUNCTION "auth"."enforce_active_organization_owner"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, auth
AS $relay_active_organization_owner$
BEGIN
	IF NEW.lifecycle_status = 'active' AND NOT EXISTS (
		SELECT 1
		FROM auth.member AS owner_member
		WHERE owner_member."organizationId" = NEW.id
			AND 'owner' = ANY(string_to_array(replace(owner_member.role, ' ', ''), ','))
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'an active organization must have at least one owner',
			DETAIL = NEW.id;
	END IF;
	RETURN NEW;
END;
$relay_active_organization_owner$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "enforce_active_organization_owner_at_commit" ON "auth"."organization";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "enforce_active_organization_owner_at_commit"
AFTER INSERT OR UPDATE OF "lifecycle_status"
ON "auth"."organization"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "auth"."enforce_active_organization_owner"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "auth"."enforce_active_member_user"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, auth
AS $relay_active_member_user$
DECLARE
	member_user_banned boolean;
	member_user_ban_expires timestamptz;
BEGIN
	SELECT member_user.banned, member_user."banExpires"
	INTO member_user_banned, member_user_ban_expires
	FROM auth."user" AS member_user
	WHERE member_user.id = NEW."userId"
	FOR SHARE;

	IF NOT FOUND
		OR (member_user_banned IS TRUE
			AND (member_user_ban_expires IS NULL OR member_user_ban_expires > statement_timestamp()))
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'members may only be added for active users',
			DETAIL = NEW."userId";
	END IF;
	RETURN NEW;
END;
$relay_active_member_user$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "enforce_active_member_user_before_insert" ON "auth"."member";
--> statement-breakpoint
CREATE TRIGGER "enforce_active_member_user_before_insert"
BEFORE INSERT ON "auth"."member"
FOR EACH ROW
EXECUTE FUNCTION "auth"."enforce_active_member_user"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "auth"."enforce_organization_owner_invariant"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, auth
AS $relay_owner_invariant$
DECLARE
	organization_state text;
	owner_exit boolean := false;
	membership_exit boolean := false;
BEGIN
	IF TG_OP = 'INSERT' THEN
		-- Check before the tuple exists. If tenant erasure already owns the
		-- organization row this waits for its commit, observes tombstoned state,
		-- and prevents a late FK-valid membership from reviving local access.
		SELECT organization_row.lifecycle_status
		INTO organization_state
		FROM auth.organization AS organization_row
		WHERE organization_row.id = NEW."organizationId"
		FOR SHARE;
		IF NOT FOUND OR organization_state <> 'active' THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				MESSAGE = 'members may only be added to active organizations',
				DETAIL = NEW."organizationId";
		END IF;
		RETURN NEW;
	END IF;

	membership_exit := TG_OP = 'DELETE';
	owner_exit := membership_exit
		AND 'owner' = ANY(string_to_array(replace(OLD.role, ' ', ''), ','));
	IF TG_OP = 'UPDATE' THEN
		membership_exit := NEW."organizationId" IS DISTINCT FROM OLD."organizationId";
		owner_exit := 'owner' = ANY(string_to_array(replace(OLD.role, ' ', ''), ','))
			AND (
				membership_exit
				OR NOT ('owner' = ANY(string_to_array(replace(NEW.role, ' ', ''), ',')))
			);
	END IF;

	IF owner_exit THEN
		-- A row-level BEFORE trigger begins after PostgreSQL has locked OLD's
		-- member tuple. Keep the universally enforceable order aligned with
		-- identity and tenant deletion: member -> advisory -> organization.
		PERFORM pg_advisory_xact_lock(hashtext('relayapi:org-owner:' || OLD."organizationId"));

		-- The no-op parent update is an MVCC serialization fence. Under
		-- REPEATABLE READ/SERIALIZABLE, a waiter with a stale snapshot aborts instead
		-- of validating against pre-lock owner state; READ COMMITTED sees the winner.
		UPDATE auth.organization AS organization_row
		SET lifecycle_status = organization_row.lifecycle_status
		WHERE organization_row.id = OLD."organizationId"
		RETURNING organization_row.lifecycle_status INTO organization_state;

		-- Durable organization erasure marks the tenant non-active before deleting
		-- it. Do not make its cascading member deletion preserve an owner.
		IF FOUND AND organization_state = 'active' AND NOT EXISTS (
			SELECT 1
			FROM auth.member AS other_member
			WHERE other_member."organizationId" = OLD."organizationId"
				AND other_member.id <> OLD.id
				AND 'owner' = ANY(string_to_array(replace(other_member.role, ' ', ''), ','))
		) THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				MESSAGE = 'an active organization must retain at least one owner',
				DETAIL = OLD."organizationId";
		END IF;
	END IF;

	-- Credential/session state changes in the same statement as the membership
	-- exit. A rejected invariant or later statement failure rolls these back.
	IF membership_exit THEN
		UPDATE auth.apikey AS key_row
		SET enabled = false, "updatedAt" = now()
		FROM public.organization_principals AS principal_row
		WHERE key_row."principalId" = principal_row.id
			AND key_row."organizationId" = principal_row.organization_id
			AND principal_row.organization_id = OLD."organizationId"
			AND principal_row.member_id = OLD.id;

		DELETE FROM public.invite_tokens AS token_row
		USING public.organization_principals AS principal_row
		WHERE token_row.created_by_principal_id = principal_row.id
			AND token_row.organization_id = principal_row.organization_id
			AND principal_row.organization_id = OLD."organizationId"
			AND principal_row.member_id = OLD.id;

		DELETE FROM public.principal_workspace_grants AS grant_row
		USING public.organization_principals AS principal_row
		WHERE grant_row.principal_id = principal_row.id
			AND grant_row.organization_id = principal_row.organization_id
			AND principal_row.organization_id = OLD."organizationId"
			AND principal_row.member_id = OLD.id;

		UPDATE public.organization_principals AS principal_row
		SET lifecycle_status = 'disabled',
			disabled_at = COALESCE(principal_row.disabled_at, now()),
			updated_at = now(),
			member_id = NULL
		WHERE principal_row.organization_id = OLD."organizationId"
			AND principal_row.member_id = OLD.id;

		UPDATE auth.session
		SET "activeOrganizationId" = NULL, "updatedAt" = now()
		WHERE "userId" = OLD."userId"
			AND "activeOrganizationId" = OLD."organizationId";
	END IF;

	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$relay_owner_invariant$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "enforce_organization_owner_before_write" ON "auth"."member";
--> statement-breakpoint
CREATE TRIGGER "enforce_organization_owner_before_write"
BEFORE INSERT OR DELETE OR UPDATE OF "role", "organizationId"
ON "auth"."member"
FOR EACH ROW
EXECUTE FUNCTION "auth"."enforce_organization_owner_invariant"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "auth"."invalidate_member_invitation_authority"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, auth
AS $relay_invalidate_member_invitation_authority$
BEGIN
	IF TG_OP = 'UPDATE'
		AND NEW."organizationId" IS NOT DISTINCT FROM OLD."organizationId"
		AND NEW.role IS NOT DISTINCT FROM OLD.role
	THEN
		RETURN NEW;
	END IF;

	-- A pending -> accepted update owns the invitation row as its
	-- linearization point. Do not wait in the reverse member -> invitation
	-- order. If any other operation owns a pending row, abort this authority
	-- change so the caller must retry after that row is observable.
	UPDATE auth.invitation AS invitation_row
	SET status = 'canceled'
	WHERE invitation_row.id IN (
		SELECT pending_invitation.id
		FROM auth.invitation AS pending_invitation
		WHERE pending_invitation."inviterId" = OLD."userId"
			AND pending_invitation."organizationId" = OLD."organizationId"
			AND pending_invitation.status = 'pending'
		FOR UPDATE SKIP LOCKED
	);
	IF EXISTS (
		SELECT 1
		FROM auth.invitation AS pending_invitation
		WHERE pending_invitation."inviterId" = OLD."userId"
			AND pending_invitation."organizationId" = OLD."organizationId"
			AND pending_invitation.status = 'pending'
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '40001',
			MESSAGE = 'invitation authority changed concurrently; retry membership mutation',
			DETAIL = OLD."organizationId";
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$relay_invalidate_member_invitation_authority$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "invalidate_member_invitation_authority" ON "auth"."member";
--> statement-breakpoint
CREATE TRIGGER "invalidate_member_invitation_authority"
BEFORE DELETE OR UPDATE OF "role", "organizationId"
ON "auth"."member"
FOR EACH ROW
EXECUTE FUNCTION "auth"."invalidate_member_invitation_authority"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "auth"."retire_dashboard_principals_before_user"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, auth
AS $relay_retire_dashboard_principals$
BEGIN
	UPDATE auth.apikey AS key_row
	SET enabled = false, "updatedAt" = now()
	FROM public.organization_principals AS principal_row, auth.member AS member_row
	WHERE key_row."principalId" = principal_row.id
		AND key_row."organizationId" = principal_row.organization_id
		AND principal_row.member_id = member_row.id
		AND member_row."userId" = OLD.id;

	DELETE FROM public.invite_tokens AS token_row
	USING public.organization_principals AS principal_row, auth.member AS member_row
	WHERE token_row.created_by_principal_id = principal_row.id
		AND token_row.organization_id = principal_row.organization_id
		AND principal_row.member_id = member_row.id
		AND member_row."userId" = OLD.id;

	DELETE FROM public.principal_workspace_grants AS grant_row
	USING public.organization_principals AS principal_row, auth.member AS member_row
	WHERE grant_row.principal_id = principal_row.id
		AND grant_row.organization_id = principal_row.organization_id
		AND principal_row.member_id = member_row.id
		AND member_row."userId" = OLD.id;

	UPDATE public.organization_principals AS principal_row
	SET lifecycle_status = 'disabled',
		disabled_at = COALESCE(principal_row.disabled_at, now()),
		updated_at = now(),
		member_id = NULL
	FROM auth.member AS member_row
	WHERE principal_row.member_id = member_row.id
		AND member_row."userId" = OLD.id;
	RETURN OLD;
END;
$relay_retire_dashboard_principals$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "retire_dashboard_principals_before_user" ON "auth"."user";
--> statement-breakpoint
CREATE TRIGGER "retire_dashboard_principals_before_user"
BEFORE DELETE ON "auth"."user"
FOR EACH ROW
EXECUTE FUNCTION "auth"."retire_dashboard_principals_before_user"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "auth"."rotate_user_credential_version_on_ban"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, auth
AS $relay_rotate_user_credential_version$
BEGIN
	IF (TG_OP = 'INSERT'
			AND NEW.banned IS TRUE
			AND (NEW."banExpires" IS NULL OR NEW."banExpires" > statement_timestamp()))
		OR (TG_OP = 'UPDATE'
			AND (OLD.banned IS DISTINCT FROM TRUE
				OR (OLD."banExpires" IS NOT NULL AND OLD."banExpires" <= statement_timestamp()))
			AND NEW.banned IS TRUE
			AND (NEW."banExpires" IS NULL OR NEW."banExpires" > statement_timestamp()))
	THEN
		NEW."credentialVersion" := gen_random_uuid()::text;

		-- Avoid a user-row/invitation-row lock inversion with an acceptance
		-- already in flight. Locked rows are left inert by the generation
		-- mismatch and can be removed by normal retention/cleanup later.
		UPDATE auth.invitation AS invitation_row
		SET status = 'canceled'
		WHERE invitation_row.id IN (
			SELECT pending_invitation.id
			FROM auth.invitation AS pending_invitation
			WHERE pending_invitation."inviterId" = NEW.id
				AND pending_invitation.status = 'pending'
			FOR UPDATE SKIP LOCKED
		);
	END IF;
	RETURN NEW;
END;
$relay_rotate_user_credential_version$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "rotate_user_credential_version_on_ban" ON "auth"."user";
--> statement-breakpoint
CREATE TRIGGER "rotate_user_credential_version_on_ban"
BEFORE INSERT OR UPDATE OF "banned", "banExpires"
ON "auth"."user"
FOR EACH ROW
EXECUTE FUNCTION "auth"."rotate_user_credential_version_on_ban"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "auth"."revoke_administrator_impersonation_sessions"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, auth
AS $relay_revoke_administrator_impersonation$
DECLARE
	actor_id text;
BEGIN
	IF TG_OP = 'DELETE' THEN
		actor_id := OLD.id;
	ELSIF (NEW.banned IS TRUE
			AND (NEW."banExpires" IS NULL OR NEW."banExpires" > statement_timestamp()))
		OR NOT ('admin' = ANY(string_to_array(replace(COALESCE(NEW.role, ''), ' ', ''), ',')))
	THEN
		actor_id := NEW.id;
	ELSE
		RETURN NEW;
	END IF;

	DELETE FROM auth.session AS impersonation_session
	WHERE impersonation_session."impersonatedBy" = actor_id;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$relay_revoke_administrator_impersonation$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "revoke_administrator_impersonation_sessions" ON "auth"."user";
--> statement-breakpoint
CREATE TRIGGER "revoke_administrator_impersonation_sessions"
AFTER DELETE OR UPDATE OF "role", "banned", "banExpires"
ON "auth"."user"
FOR EACH ROW
EXECUTE FUNCTION "auth"."revoke_administrator_impersonation_sessions"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "auth"."revoke_derived_impersonation_on_session_delete"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, auth
AS $relay_revoke_session_derived_impersonation$
BEGIN
	IF OLD."impersonatedBy" IS NOT NULL THEN
		RETURN OLD;
	END IF;

	DELETE FROM auth.session AS derived_impersonation_session
	WHERE derived_impersonation_session."impersonatedBy" = OLD."userId";
	RETURN OLD;
END;
$relay_revoke_session_derived_impersonation$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "revoke_derived_impersonation_on_session_delete" ON "auth"."session";
--> statement-breakpoint
CREATE TRIGGER "revoke_derived_impersonation_on_session_delete"
AFTER DELETE ON "auth"."session"
FOR EACH ROW
EXECUTE FUNCTION "auth"."revoke_derived_impersonation_on_session_delete"();
--> statement-breakpoint

-- Existing impersonation rows do not retain their originating session ID.
-- Fail secure at rollout by clearing every row whose provenance cannot be proven.
DELETE FROM auth.session AS impersonation_session
WHERE impersonation_session."impersonatedBy" IS NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "auth"."enforce_invitation_issuer_credential_generation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, auth
AS $relay_invitation_issuer_credential_generation$
DECLARE
	issuer_credential_version text;
	issuer_banned boolean;
	issuer_ban_expires timestamptz;
	issuer_member_role text;
BEGIN
	IF TG_OP = 'UPDATE' AND (
		NEW."inviterId" IS DISTINCT FROM OLD."inviterId"
		OR NEW."issuerCredentialVersion" IS DISTINCT FROM OLD."issuerCredentialVersion"
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'invitation issuer authority is immutable',
			DETAIL = NEW.id;
	END IF;

	IF TG_OP = 'INSERT' THEN
		SELECT issuer_user."credentialVersion", issuer_user.banned, issuer_user."banExpires", issuer_member.role
		INTO issuer_credential_version, issuer_banned, issuer_ban_expires, issuer_member_role
		FROM auth."user" AS issuer_user
		JOIN auth.member AS issuer_member
			ON issuer_member."userId" = issuer_user.id
			AND issuer_member."organizationId" = NEW."organizationId"
		JOIN auth.organization AS issuer_organization
			ON issuer_organization.id = issuer_member."organizationId"
			AND issuer_organization.lifecycle_status = 'active'
		WHERE issuer_user.id = NEW."inviterId"
		FOR SHARE OF issuer_user, issuer_member, issuer_organization;

		IF NOT FOUND
			OR (issuer_banned IS TRUE
				AND (issuer_ban_expires IS NULL OR issuer_ban_expires > statement_timestamp()))
		THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				MESSAGE = 'invitation issuer is not active',
				DETAIL = NEW.id;
		END IF;

		IF NOT (
			'owner' = ANY(string_to_array(replace(issuer_member_role, ' ', ''), ','))
			OR (
				'admin' = ANY(string_to_array(replace(issuer_member_role, ' ', ''), ','))
				AND NOT ('owner' = ANY(string_to_array(replace(COALESCE(NEW.role, ''), ' ', ''), ',')))
			)
		) THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				MESSAGE = 'invitation issuer lacks role authority',
				DETAIL = NEW.id;
		END IF;

		NEW."issuerCredentialVersion" := issuer_credential_version;
	ELSIF OLD.status = 'pending' AND NEW.status = 'accepted' THEN
		SELECT issuer_user."credentialVersion", issuer_user.banned, issuer_user."banExpires"
		INTO issuer_credential_version, issuer_banned, issuer_ban_expires
		FROM auth."user" AS issuer_user
		WHERE issuer_user.id = NEW."inviterId"
		FOR SHARE;

		IF NOT FOUND
			OR (issuer_banned IS TRUE
				AND (issuer_ban_expires IS NULL OR issuer_ban_expires > statement_timestamp()))
			OR NEW."issuerCredentialVersion" IS DISTINCT FROM issuer_credential_version
		THEN
			RETURN NULL;
		END IF;
	END IF;
	RETURN NEW;
END;
$relay_invitation_issuer_credential_generation$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "enforce_invitation_issuer_credential_generation" ON "auth"."invitation";
--> statement-breakpoint
CREATE TRIGGER "enforce_invitation_issuer_credential_generation"
BEFORE INSERT OR UPDATE OF "status", "inviterId", "issuerCredentialVersion"
ON "auth"."invitation"
FOR EACH ROW
EXECUTE FUNCTION "auth"."enforce_invitation_issuer_credential_generation"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.relayapi_guard_erasure_hold()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, auth
AS $relay_guard_erasure_hold$
DECLARE
	is_redaction boolean := false;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.subject_kind = 'organization' THEN
			PERFORM 1
			FROM auth.organization AS organization_row
			WHERE organization_row.id = NEW.subject_id
			FOR KEY SHARE;
			IF NEW.subject_id <> NEW.organization_tombstone_id OR NOT FOUND THEN
				RAISE EXCEPTION USING
					ERRCODE = '23503',
					MESSAGE = 'erasure hold organization target does not exist',
					DETAIL = NEW.subject_id;
			END IF;
		ELSIF NEW.subject_kind = 'workspace' THEN
			PERFORM 1
			FROM public.workspaces AS workspace_row
			WHERE workspace_row.id = NEW.subject_id
				AND workspace_row.organization_id = NEW.organization_tombstone_id
			FOR KEY SHARE;
			IF NOT FOUND THEN
				RAISE EXCEPTION USING
					ERRCODE = '23503',
					MESSAGE = 'erasure hold workspace target does not exist in the organization',
					DETAIL = NEW.subject_id;
			END IF;
		ELSE
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid erasure hold subject kind';
		END IF;
		RETURN NEW;
	END IF;

	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
		OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
		OR NEW.organization_tombstone_id IS DISTINCT FROM OLD.organization_tombstone_id
		OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
		OR NEW.placed_at IS DISTINCT FROM OLD.placed_at
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR NEW.released_at IS DISTINCT FROM OLD.released_at
			AND OLD.released_at IS NOT NULL
	THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'erasure hold identity and transition timestamps are immutable';
	END IF;

	is_redaction := OLD.released_at IS NOT NULL
		AND OLD.evidence_redacted_at IS NULL
		AND NEW.evidence_redacted_at IS NOT NULL;
	IF is_redaction THEN
		IF NEW.reason_summary <> '[redacted]'
			OR NEW.legal_authority_ref <> '[redacted]'
			OR NEW.placed_by <> '[redacted]'
			OR NEW.released_by <> '[redacted]'
			OR NEW.release_reason_summary <> '[redacted]'
			OR NEW.evidence_ciphertext IS NOT NULL
			OR NEW.released_at IS DISTINCT FROM OLD.released_at
		THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid erasure hold redaction transition';
		END IF;
		RETURN NEW;
	END IF;

	IF NEW.reason_summary IS DISTINCT FROM OLD.reason_summary
		OR NEW.legal_authority_ref IS DISTINCT FROM OLD.legal_authority_ref
		OR NEW.placed_by IS DISTINCT FROM OLD.placed_by
		OR NEW.evidence_ciphertext IS DISTINCT FROM OLD.evidence_ciphertext
		OR NEW.evidence_redacted_at IS DISTINCT FROM OLD.evidence_redacted_at
	THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'erasure hold placement fields are immutable';
	END IF;

	IF OLD.released_at IS NULL THEN
		IF NEW.released_at IS NULL
			OR NEW.released_by IS NULL
			OR NEW.release_reason_summary IS NULL
		THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'erasure hold may only be updated by a complete release transition';
		END IF;
	ELSE
		IF NEW.released_by IS DISTINCT FROM OLD.released_by
			OR NEW.release_reason_summary IS DISTINCT FROM OLD.release_reason_summary
		THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'erasure hold release may occur only once';
		END IF;
	END IF;
	RETURN NEW;
END;
$relay_guard_erasure_hold$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS relayapi_erasure_hold_guard ON public.erasure_holds;
--> statement-breakpoint
CREATE TRIGGER relayapi_erasure_hold_guard
BEFORE INSERT OR UPDATE ON public.erasure_holds
FOR EACH ROW
EXECUTE FUNCTION public.relayapi_guard_erasure_hold();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.relayapi_prevent_held_root_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_prevent_held_root_delete$
BEGIN
	IF TG_TABLE_SCHEMA = 'auth' THEN
		IF EXISTS (
			SELECT 1 FROM public.erasure_holds AS hold
			WHERE hold.organization_tombstone_id = OLD.id
				AND hold.released_at IS NULL
		) THEN
			RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'organization deletion is paused by an active erasure hold', DETAIL = OLD.id;
		END IF;
	ELSE
		IF EXISTS (
			SELECT 1 FROM public.erasure_holds AS hold
			WHERE hold.released_at IS NULL
				AND hold.organization_tombstone_id = OLD.organization_id
				AND (
					(hold.subject_kind = 'organization' AND hold.subject_id = OLD.organization_id)
					OR (hold.subject_kind = 'workspace' AND hold.subject_id = OLD.id)
				)
		) THEN
			RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'workspace deletion is paused by an active erasure hold', DETAIL = OLD.id;
		END IF;
	END IF;
	RETURN OLD;
END;
$relay_prevent_held_root_delete$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS relayapi_organization_hold_delete_guard ON auth.organization;
--> statement-breakpoint
CREATE TRIGGER relayapi_organization_hold_delete_guard
BEFORE DELETE ON auth.organization
FOR EACH ROW
EXECUTE FUNCTION public.relayapi_prevent_held_root_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS relayapi_workspace_hold_delete_guard ON public.workspaces;
--> statement-breakpoint
CREATE TRIGGER relayapi_workspace_hold_delete_guard
BEFORE DELETE ON public.workspaces
FOR EACH ROW
EXECUTE FUNCTION public.relayapi_prevent_held_root_delete();
--> statement-breakpoint

--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reject_contact_subscription_event_update"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_contact_subscription_event_append_only$
BEGIN
	RAISE EXCEPTION USING
		ERRCODE = '23514',
		MESSAGE = 'contact subscription events are append-only';
END;
$relay_contact_subscription_event_append_only$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "contact_subscription_events_append_only" ON "public"."contact_subscription_events";
--> statement-breakpoint
CREATE TRIGGER "contact_subscription_events_append_only"
BEFORE UPDATE ON "public"."contact_subscription_events"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_contact_subscription_event_update"();
--> statement-breakpoint

--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reject_operator_resolution_evidence_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_operator_resolution_evidence_append_only$
BEGIN
	RAISE EXCEPTION USING
		ERRCODE = '23514',
		MESSAGE = 'operator resolution evidence is append-only';
END;
$relay_operator_resolution_evidence_append_only$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "operator_resolution_evidence_append_only" ON "public"."operator_resolution_evidence";
--> statement-breakpoint
CREATE TRIGGER "operator_resolution_evidence_append_only"
BEFORE UPDATE OR DELETE ON "public"."operator_resolution_evidence"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_operator_resolution_evidence_mutation"();
--> statement-breakpoint

--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reject_financial_retention_receipt_update"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_financial_retention_receipt_immutable$
BEGIN
	RAISE EXCEPTION USING
		ERRCODE = '23514',
		MESSAGE = 'financial retention receipts are immutable';
END;
$relay_financial_retention_receipt_immutable$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "financial_retention_receipts_immutable" ON "public"."financial_retention_receipts";
--> statement-breakpoint
CREATE TRIGGER "financial_retention_receipts_immutable"
BEFORE UPDATE ON "public"."financial_retention_receipts"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_financial_retention_receipt_update"();
--> statement-breakpoint

--> statement-breakpoint
ALTER TABLE public.usage_buckets
	ALTER CONSTRAINT usage_buckets_billing_period_window_fk
	DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint

ALTER TABLE public.billing_periods
	ADD CONSTRAINT billing_periods_invoice_org_fk
	FOREIGN KEY (invoice_id, organization_id)
	REFERENCES public.invoices (id, organization_id)
	ON UPDATE NO ACTION ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE public.billing_periods
	ADD CONSTRAINT billing_periods_live_window_excl
	EXCLUDE USING gist (
		organization_id WITH =,
		tstzrange(period_start, period_end, '[)') WITH &&
	)
	WHERE (state <> 'void');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.enforce_billing_period_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_billing_period_transition$
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.source IS DISTINCT FROM OLD.source
		OR NEW.billable IS DISTINCT FROM OLD.billable
		OR NEW.quota_mode IS DISTINCT FROM OLD.quota_mode
		OR NEW.provider_cycle_anchor IS DISTINCT FROM OLD.provider_cycle_anchor
		OR NEW.period_start IS DISTINCT FROM OLD.period_start
		OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
		OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
		OR NEW.stripe_product_id IS DISTINCT FROM OLD.stripe_product_id
		OR NEW.stripe_price_id IS DISTINCT FROM OLD.stripe_price_id
		OR NEW.stripe_price_role IS DISTINCT FROM OLD.stripe_price_role
		OR NEW.rate_card_version IS DISTINCT FROM OLD.rate_card_version
		OR NEW.tax_behavior IS DISTINCT FROM OLD.tax_behavior
		OR NEW.tax_code IS DISTINCT FROM OLD.tax_code
		OR NEW.discountable IS DISTINCT FROM OLD.discountable
		OR NEW.cycle_allowance IS DISTINCT FROM OLD.cycle_allowance
		OR NEW.included_units IS DISTINCT FROM OLD.included_units
		OR NEW.price_per_thousand_units_cents IS DISTINCT FROM OLD.price_per_thousand_units_cents
		OR NEW.base_price_cents IS DISTINCT FROM OLD.base_price_cents
		OR NEW.currency IS DISTINCT FROM OLD.currency
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'billing period authority fields are immutable; split the period instead';
	END IF;

	IF NEW.period_end IS DISTINCT FROM OLD.period_end
		AND NOT (OLD.state = 'open'
			AND NEW.period_end < OLD.period_end
			AND NEW.period_end > OLD.period_start)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'an open billing period may only be shortened';
	END IF;

	IF NEW.release_count IS DISTINCT FROM OLD.release_count
		AND NOT (OLD.state = 'claimed'
			AND NEW.state = 'released'
			AND OLD.release_count = 0
			AND NEW.release_count = 1)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'a billing period permits exactly one operator release';
	END IF;

	IF OLD.state = 'claimed'
		AND NEW.state = 'released'
		AND OLD.release_count <> 0
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'billing period reclaim has already been used';
	END IF;

	IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
		(OLD.state = 'open' AND NEW.state IN ('closed', 'void'))
		OR (OLD.state = 'closed' AND NEW.state IN ('claimed', 'void'))
		OR (OLD.state = 'claimed' AND NEW.state IN ('settled', 'released', 'written_off'))
		OR (OLD.state = 'released' AND NEW.state IN ('closed', 'void'))
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = format('invalid billing period transition: %s -> %s', OLD.state, NEW.state);
	END IF;

	IF NOT (OLD.state = 'released' AND NEW.state = 'closed')
		AND (
			(OLD.committed_units_snapshot IS NOT NULL
				AND NEW.committed_units_snapshot IS DISTINCT FROM OLD.committed_units_snapshot)
			OR (OLD.effective_included_units_snapshot IS NOT NULL
				AND NEW.effective_included_units_snapshot IS DISTINCT FROM OLD.effective_included_units_snapshot)
			OR (OLD.overage_units_snapshot IS NOT NULL
				AND NEW.overage_units_snapshot IS DISTINCT FROM OLD.overage_units_snapshot)
			OR (OLD.amount_cents_snapshot IS NOT NULL
				AND NEW.amount_cents_snapshot IS DISTINCT FROM OLD.amount_cents_snapshot)
			OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at)
			OR (OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS DISTINCT FROM OLD.claimed_at)
			OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at)
			OR (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at)
			OR (OLD.written_off_at IS NOT NULL AND NEW.written_off_at IS DISTINCT FROM OLD.written_off_at)
			OR (OLD.write_off_reason IS NOT NULL AND NEW.write_off_reason IS DISTINCT FROM OLD.write_off_reason)
			OR (OLD.write_off_evidence IS NOT NULL AND NEW.write_off_evidence IS DISTINCT FROM OLD.write_off_evidence)
			OR (OLD.voided_at IS NOT NULL AND NEW.voided_at IS DISTINCT FROM OLD.voided_at)
			OR (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id)
			OR (OLD.stripe_invoice_id IS NOT NULL
				AND NEW.stripe_invoice_id IS DISTINCT FROM OLD.stripe_invoice_id)
		)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'billing period close and settlement evidence is immutable';
	END IF;

	NEW.revision := OLD.revision + 1;
	NEW.updated_at := statement_timestamp();
	RETURN NEW;
END;
$relay_billing_period_transition$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS enforce_billing_period_transition ON public.billing_periods;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_periods_authority_immutable ON public.billing_periods;
--> statement-breakpoint
CREATE TRIGGER billing_periods_authority_immutable
BEFORE UPDATE ON public.billing_periods
FOR EACH ROW
EXECUTE FUNCTION public.enforce_billing_period_authority();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.enforce_billing_operation_attempt_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_billing_operation_attempt$
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.billing_operation_id IS DISTINCT FROM OLD.billing_operation_id
		OR NEW.revision IS DISTINCT FROM OLD.revision
		OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
		OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
		OR NEW.stripe_invoice_id IS DISTINCT FROM OLD.stripe_invoice_id
		OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
		OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
		OR NEW.currency IS DISTINCT FROM OLD.currency
		OR NEW.description IS DISTINCT FROM OLD.description
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'billing attempt target and economic payload are immutable; create a new revision';
	END IF;

	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'prepared' AND NEW.status IN ('requesting', 'rejected', 'written_off'))
		OR (OLD.status = 'requesting' AND NEW.status IN ('unknown', 'succeeded', 'rejected'))
		OR (OLD.status = 'unknown' AND NEW.status IN ('requesting', 'succeeded', 'rejected', 'written_off'))
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = format('invalid billing attempt transition: %s -> %s', OLD.status, NEW.status);
	END IF;
	RETURN NEW;
END;
$relay_billing_operation_attempt$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS billing_operation_attempts_authority_immutable ON public.billing_operation_attempts;
--> statement-breakpoint
CREATE TRIGGER billing_operation_attempts_authority_immutable
BEFORE UPDATE ON public.billing_operation_attempts
FOR EACH ROW
EXECUTE FUNCTION public.enforce_billing_operation_attempt_authority();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.enforce_phone_billing_attempt_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_phone_billing_attempt$
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.phone_billing_operation_id IS DISTINCT FROM OLD.phone_billing_operation_id
		OR NEW.revision IS DISTINCT FROM OLD.revision
		OR NEW.desired_quantity IS DISTINCT FROM OLD.desired_quantity
		OR NEW.prior_applied_quantity IS DISTINCT FROM OLD.prior_applied_quantity
		OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
		OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'phone billing attempt target and economic payload are immutable; create a new revision';
	END IF;

	IF (OLD.stripe_checkout_session_id IS NOT NULL
			AND NEW.stripe_checkout_session_id IS DISTINCT FROM OLD.stripe_checkout_session_id)
		OR (OLD.stripe_subscription_id IS NOT NULL
			AND NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id)
		OR (OLD.stripe_subscription_item_id IS NOT NULL
			AND NEW.stripe_subscription_item_id IS DISTINCT FROM OLD.stripe_subscription_item_id)
		OR (OLD.stripe_latest_invoice_id IS NOT NULL
			AND NEW.stripe_latest_invoice_id IS DISTINCT FROM OLD.stripe_latest_invoice_id)
		OR (OLD.request_may_have_been_sent_at IS NOT NULL
			AND NEW.request_may_have_been_sent_at IS DISTINCT FROM OLD.request_may_have_been_sent_at)
		OR (OLD.resolved_at IS NOT NULL
			AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at)
		OR (OLD.provider_evidence IS NOT NULL
			AND (NEW.provider_evidence IS NULL OR NOT (NEW.provider_evidence @> OLD.provider_evidence)))
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'phone billing provider identity and evidence are append-only once observed';
	END IF;

	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'prepared' AND NEW.status IN ('requesting', 'waiting_payment', 'applied', 'confirmed_not_applied', 'manual_review'))
		OR (OLD.status = 'requesting' AND NEW.status IN ('unknown', 'waiting_payment', 'applied', 'confirmed_not_applied', 'manual_review'))
		OR (OLD.status = 'unknown' AND NEW.status IN ('waiting_payment', 'applied', 'confirmed_not_applied', 'manual_review'))
		OR (OLD.status = 'waiting_payment' AND NEW.status IN ('unknown', 'applied', 'confirmed_not_applied', 'manual_review'))
		OR (OLD.status = 'manual_review' AND NEW.status IN ('applied', 'confirmed_not_applied'))
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = format('invalid phone billing attempt transition: %s -> %s', OLD.status, NEW.status);
	END IF;
	RETURN NEW;
END;
$relay_phone_billing_attempt$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS whatsapp_phone_billing_attempts_authority_immutable ON public.whatsapp_phone_billing_attempts;
--> statement-breakpoint
CREATE TRIGGER whatsapp_phone_billing_attempts_authority_immutable
BEFORE UPDATE ON public.whatsapp_phone_billing_attempts
FOR EACH ROW
EXECUTE FUNCTION public.enforce_phone_billing_attempt_authority();
--> statement-breakpoint

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.enforce_storage_location_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_storage_location_immutability$
BEGIN
	IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.provider IS DISTINCT FROM OLD.provider
		OR NEW.endpoint IS DISTINCT FROM OLD.endpoint
		OR NEW.bucket IS DISTINCT FROM OLD.bucket
		OR NEW.region IS DISTINCT FROM OLD.region
		OR NEW.key_prefix IS DISTINCT FROM OLD.key_prefix
		OR NEW.force_path_style IS DISTINCT FROM OLD.force_path_style
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'storage location routing fields are immutable; insert a new location';
	END IF;

	IF OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'storage location activation is immutable';
	END IF;
	IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retired storage locations are terminal';
	END IF;
	RETURN NEW;
END;
$relay_storage_location_immutability$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS enforce_storage_location_immutability ON public.storage_locations;
--> statement-breakpoint
CREATE TRIGGER enforce_storage_location_immutability
BEFORE UPDATE ON public.storage_locations
FOR EACH ROW
EXECUTE FUNCTION public.enforce_storage_location_immutability();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.enforce_storage_credential_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_storage_credential_transition$
BEGIN
	IF NEW.location_id IS DISTINCT FROM OLD.location_id
		OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.version IS DISTINCT FROM OLD.version
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'storage credential identity is immutable; insert a new version';
	END IF;

	IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
		(OLD.state = 'staged' AND NEW.state IN ('active', 'failed'))
		OR (OLD.state = 'active' AND NEW.state = 'retired')
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = format('invalid storage credential transition: %s -> %s', OLD.state, NEW.state);
	END IF;
	NEW.updated_at := statement_timestamp();
	RETURN NEW;
END;
$relay_storage_credential_transition$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS enforce_storage_credential_transition ON public.storage_credentials;
--> statement-breakpoint
CREATE TRIGGER enforce_storage_credential_transition
BEFORE UPDATE ON public.storage_credentials
FOR EACH ROW
EXECUTE FUNCTION public.enforce_storage_credential_transition();
--> statement-breakpoint

--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."maintain_usage_bucket_projection"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_usage_bucket_projection$
BEGIN
	PERFORM set_config('relay.usage_projection', 'on', true);
	IF TG_OP = 'INSERT' THEN
		WITH deltas AS (
			SELECT
				bucket_id,
				SUM(reserved_delta)::bigint AS reserved_delta,
				SUM(committed_delta)::bigint AS committed_delta
			FROM (
			SELECT
				bucket_id,
				CASE WHEN state IN ('reserved', 'parked') THEN units ELSE 0 END AS reserved_delta,
				CASE WHEN state = 'committed' THEN committed_units ELSE 0 END AS committed_delta
			FROM "new_usage_reservations"
			) AS changes
			GROUP BY bucket_id
		)
		UPDATE "public"."usage_buckets" AS bucket
		SET
			reserved_units = bucket.reserved_units + deltas.reserved_delta,
			committed_units = bucket.committed_units + deltas.committed_delta,
			revision = bucket.revision + 1,
			updated_at = statement_timestamp()
		FROM deltas
		WHERE bucket.id = deltas.bucket_id
			AND (deltas.reserved_delta <> 0 OR deltas.committed_delta <> 0);
	ELSIF TG_OP = 'UPDATE' THEN
		WITH deltas AS (
			SELECT
				bucket_id,
				SUM(reserved_delta)::bigint AS reserved_delta,
				SUM(committed_delta)::bigint AS committed_delta
			FROM (
			SELECT
				bucket_id,
				-CASE WHEN state IN ('reserved', 'parked') THEN units ELSE 0 END AS reserved_delta,
				-CASE WHEN state = 'committed' THEN committed_units ELSE 0 END AS committed_delta
			FROM "old_usage_reservations"
			UNION ALL
			SELECT
				bucket_id,
				CASE WHEN state IN ('reserved', 'parked') THEN units ELSE 0 END AS reserved_delta,
				CASE WHEN state = 'committed' THEN committed_units ELSE 0 END AS committed_delta
			FROM "new_usage_reservations"
			) AS changes
			GROUP BY bucket_id
		)
		UPDATE "public"."usage_buckets" AS bucket
		SET
			reserved_units = bucket.reserved_units + deltas.reserved_delta,
			committed_units = bucket.committed_units + deltas.committed_delta,
			revision = bucket.revision + 1,
			updated_at = statement_timestamp()
		FROM deltas
		WHERE bucket.id = deltas.bucket_id
			AND (deltas.reserved_delta <> 0 OR deltas.committed_delta <> 0);
	ELSIF TG_OP = 'DELETE' THEN
		WITH deltas AS (
			SELECT
				bucket_id,
				SUM(reserved_delta)::bigint AS reserved_delta,
				SUM(committed_delta)::bigint AS committed_delta
			FROM (
			SELECT
				bucket_id,
				-CASE WHEN state IN ('reserved', 'parked') THEN units ELSE 0 END AS reserved_delta,
				-CASE WHEN state = 'committed' THEN committed_units ELSE 0 END AS committed_delta
			FROM "old_usage_reservations"
			) AS changes
			GROUP BY bucket_id
		)
		UPDATE "public"."usage_buckets" AS bucket
		SET
			reserved_units = bucket.reserved_units + deltas.reserved_delta,
			committed_units = bucket.committed_units + deltas.committed_delta,
			revision = bucket.revision + 1,
			updated_at = statement_timestamp()
		FROM deltas
		WHERE bucket.id = deltas.bucket_id
			AND (deltas.reserved_delta <> 0 OR deltas.committed_delta <> 0);
	END IF;
	PERFORM set_config('relay.usage_projection', 'off', true);
	RETURN NULL;
END;
$relay_usage_bucket_projection$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "usage_reservations_project_after_insert" ON "public"."usage_reservations";
--> statement-breakpoint
CREATE TRIGGER "usage_reservations_project_after_insert"
AFTER INSERT ON "public"."usage_reservations"
REFERENCING NEW TABLE AS "new_usage_reservations"
FOR EACH STATEMENT
EXECUTE FUNCTION "public"."maintain_usage_bucket_projection"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "usage_reservations_project_after_update" ON "public"."usage_reservations";
--> statement-breakpoint
CREATE TRIGGER "usage_reservations_project_after_update"
AFTER UPDATE ON "public"."usage_reservations"
REFERENCING OLD TABLE AS "old_usage_reservations" NEW TABLE AS "new_usage_reservations"
FOR EACH STATEMENT
EXECUTE FUNCTION "public"."maintain_usage_bucket_projection"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "usage_reservations_project_after_delete" ON "public"."usage_reservations";
--> statement-breakpoint
CREATE TRIGGER "usage_reservations_project_after_delete"
AFTER DELETE ON "public"."usage_reservations"
REFERENCING OLD TABLE AS "old_usage_reservations"
FOR EACH STATEMENT
EXECUTE FUNCTION "public"."maintain_usage_bucket_projection"();
--> statement-breakpoint

UPDATE "public"."usage_buckets" AS bucket
SET
	reserved_units = projection.reserved_units,
	committed_units = projection.committed_units,
	revision = bucket.revision + 1,
	updated_at = statement_timestamp()
FROM (
	SELECT
		bucket_row.id AS bucket_id,
		COALESCE(SUM(reservation.units) FILTER (WHERE reservation.state IN ('reserved', 'parked')), 0)::bigint AS reserved_units,
		COALESCE(SUM(reservation.committed_units) FILTER (WHERE reservation.state = 'committed'), 0)::bigint AS committed_units
	FROM "public"."usage_buckets" AS bucket_row
	LEFT JOIN "public"."usage_reservations" AS reservation
		ON reservation.bucket_id = bucket_row.id
	GROUP BY bucket_row.id
) AS projection
WHERE bucket.id = projection.bucket_id
	AND (
		bucket.reserved_units IS DISTINCT FROM projection.reserved_units
		OR bucket.committed_units IS DISTINCT FROM projection.committed_units
	);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."enforce_usage_bucket_projection_ownership"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_usage_bucket_projection_guard$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.reserved_units <> 0 OR NEW.committed_units <> 0 THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				MESSAGE = 'usage bucket counters must start at zero';
		END IF;
	ELSIF (
		NEW.reserved_units IS DISTINCT FROM OLD.reserved_units
		OR NEW.committed_units IS DISTINCT FROM OLD.committed_units
	) AND (
		pg_trigger_depth() < 2
		OR COALESCE(current_setting('relay.usage_projection', true), 'off') <> 'on'
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'usage bucket counters are owned by usage_reservations';
	END IF;
	RETURN NEW;
END;
$relay_usage_bucket_projection_guard$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "usage_buckets_projection_owned" ON "public"."usage_buckets";
--> statement-breakpoint
CREATE TRIGGER "usage_buckets_projection_owned"
BEFORE INSERT OR UPDATE OF "reserved_units", "committed_units"
ON "public"."usage_buckets"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_usage_bucket_projection_ownership"();
--> statement-breakpoint

--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."protect_automation_conversion_event_fact"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_automation_conversion_event_fact$
BEGIN
	IF (
		OLD."id" IS DISTINCT FROM NEW."id"
		OR 		OLD."organization_id" IS DISTINCT FROM NEW."organization_id"
		OR 		OLD."scope_key" IS DISTINCT FROM NEW."scope_key"
		OR 		OLD."automation_id" IS DISTINCT FROM NEW."automation_id"
		OR 		OLD."run_id" IS DISTINCT FROM NEW."run_id"
		OR 		OLD."occurrence_id" IS DISTINCT FROM NEW."occurrence_id"
		OR 		OLD."event_name" IS DISTINCT FROM NEW."event_name"
		OR 		OLD."value" IS DISTINCT FROM NEW."value"
		OR 		OLD."currency" IS DISTINCT FROM NEW."currency"
		OR 		OLD."channel" IS DISTINCT FROM NEW."channel"
		OR 		OLD."social_account_id" IS DISTINCT FROM NEW."social_account_id"
		OR 		OLD."conversation_id" IS DISTINCT FROM NEW."conversation_id"
		OR 		OLD."event_depth" IS DISTINCT FROM NEW."event_depth"
		OR 		OLD."created_at" IS DISTINCT FROM NEW."created_at"
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'automation conversion fact columns are immutable';
	END IF;
	RETURN NEW;
END;
$relay_automation_conversion_event_fact$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "automation_conversion_event_fact_immutable" ON "public"."automation_conversion_events";
--> statement-breakpoint
CREATE TRIGGER "automation_conversion_event_fact_immutable"
BEFORE UPDATE ON "public"."automation_conversion_events"
FOR EACH ROW
EXECUTE FUNCTION "public"."protect_automation_conversion_event_fact"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."enforce_stripe_event_organization_attribution"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $relay_stripe_event_attribution_immutable$
BEGIN
	IF OLD."organization_id" IS NOT NULL
		AND NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Stripe event organization attribution is immutable once set';
	END IF;
	RETURN NEW;
END;
$relay_stripe_event_attribution_immutable$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "stripe_events_organization_attribution_immutable" ON "public"."stripe_events";
--> statement-breakpoint
CREATE TRIGGER "stripe_events_organization_attribution_immutable"
BEFORE UPDATE OF "organization_id" ON "public"."stripe_events"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_stripe_event_organization_attribution"();
--> statement-breakpoint
