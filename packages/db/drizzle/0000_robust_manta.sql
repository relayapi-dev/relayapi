CREATE TYPE "public"."ad_objective" AS ENUM('awareness', 'traffic', 'engagement', 'leads', 'conversions', 'video_views');--> statement-breakpoint
CREATE TYPE "public"."ad_platform" AS ENUM('meta', 'google', 'tiktok', 'linkedin', 'pinterest', 'twitter');--> statement-breakpoint
CREATE TYPE "public"."ad_status" AS ENUM('draft', 'pending_review', 'active', 'paused', 'completed', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."audience_type" AS ENUM('customer_list', 'website', 'lookalike');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('open', 'archived', 'snoozed');--> statement-breakpoint
CREATE TYPE "public"."conversation_type" AS ENUM('comment_thread', 'dm', 'review');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'finalized', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('twitter', 'instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'pinterest', 'reddit', 'bluesky', 'threads', 'telegram', 'snapchat', 'googlebusiness', 'whatsapp', 'mastodon', 'discord', 'sms');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('draft', 'scheduled', 'publishing', 'published', 'failed', 'partial');--> statement-breakpoint
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
CREATE TABLE "ad_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"social_account_id" text NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"platform_ad_account_id" text NOT NULL,
	"name" text,
	"currency" varchar(3) DEFAULT 'USD',
	"timezone" text,
	"status" text DEFAULT 'active',
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_audience_users" (
	"id" text PRIMARY KEY NOT NULL,
	"audience_id" text NOT NULL,
	"email_hash" text,
	"phone_hash" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_audiences" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_sync_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ad_account_id" text NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"sync_type" text NOT NULL,
	"ads_created" integer DEFAULT 0,
	"ads_updated" integer DEFAULT 0,
	"metrics_updated" integer DEFAULT 0,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ads" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"message_id" text,
	"matched" boolean NOT NULL,
	"actions_executed" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"conditions" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"max_per_hour" integer DEFAULT 100,
	"cooldown_per_author_min" integer DEFAULT 60,
	"stop_after_match" boolean DEFAULT false,
	"total_executions" integer DEFAULT 0,
	"last_executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcast_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"broadcast_id" text NOT NULL,
	"contact_id" text,
	"contact_identifier" text NOT NULL,
	"variables" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"message_id" text,
	"error" text,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"social_account_id" text NOT NULL,
	"platform" text NOT NULL,
	"name" text,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "comment_automation_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"comment_id" text NOT NULL,
	"commenter_id" text NOT NULL,
	"commenter_name" text,
	"comment_text" text,
	"dm_sent" boolean DEFAULT false NOT NULL,
	"reply_sent" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comment_automations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"social_account_id" text NOT NULL,
	"platform" text NOT NULL,
	"post_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"match_mode" text DEFAULT 'contains' NOT NULL,
	"dm_message" text NOT NULL,
	"public_reply" text,
	"total_triggered" integer DEFAULT 0 NOT NULL,
	"last_triggered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"social_account_id" text,
	"platform" "platform" NOT NULL,
	"event" text NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_values" (
	"id" text PRIMARY KEY NOT NULL,
	"definition_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dunning_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"invoice_id" text,
	"stripe_invoice_id" text,
	"event" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"account_id" text NOT NULL,
	"platform" "platform" NOT NULL,
	"type" "conversation_type" NOT NULL,
	"platform_conversation_id" text NOT NULL,
	"post_id" text,
	"post_platform_id" text,
	"participant_name" text,
	"participant_platform_id" text,
	"participant_avatar" text,
	"status" "conversation_status" DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal',
	"labels" text[] DEFAULT '{}',
	"unread_count" integer DEFAULT 0 NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"last_message_text" text,
	"last_message_at" timestamp with time zone,
	"last_message_direction" text,
	"sentiment_avg" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"organization_id" text NOT NULL,
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"usage_record_id" text,
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
	"finalized_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id")
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
	"width" integer,
	"height" integer,
	"duration" integer,
	"uploaded_by" text,
	"workspace_id" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."member" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"organizationId" text NOT NULL,
	"role" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"post_failures" jsonb DEFAULT '{"push":true,"email":true}'::jsonb NOT NULL,
	"post_published" jsonb DEFAULT '{"push":true,"email":false}'::jsonb NOT NULL,
	"account_disconnects" jsonb DEFAULT '{"push":true,"email":true}'::jsonb NOT NULL,
	"payment_alerts" jsonb DEFAULT '{"push":true,"email":true}'::jsonb NOT NULL,
	"usage_alerts" jsonb DEFAULT '{"push":true,"email":true}'::jsonb NOT NULL,
	"weekly_digest" jsonb DEFAULT '{"push":false,"email":false}'::jsonb NOT NULL,
	"marketing" jsonb DEFAULT '{"push":false,"email":false}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_user_id_unique" UNIQUE("user_id")
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
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "organization_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"status" "subscription_status" DEFAULT 'trialing' NOT NULL,
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
	"require_workspace_id" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_subscriptions_organization_id_unique" UNIQUE("organization_id")
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
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"social_account_id" text NOT NULL,
	"platform" "platform" NOT NULL,
	"status" "post_status" DEFAULT 'draft' NOT NULL,
	"platform_post_id" text,
	"platform_url" text,
	"error" text,
	"published_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"content" text,
	"status" "post_status" DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"platform_overrides" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"contact_identifier" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_step_index" integer DEFAULT 0 NOT NULL,
	"steps_sent" integer DEFAULT 0 NOT NULL,
	"next_step_at" timestamp with time zone,
	"last_step_sent_at" timestamp with time zone,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"exited_at" timestamp with time zone,
	"exit_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence_id" text NOT NULL,
	"step_order" integer NOT NULL,
	"delay_minutes" integer NOT NULL,
	"message_type" text DEFAULT 'text' NOT NULL,
	"message_text" text,
	"template_name" text,
	"template_language" text DEFAULT 'en_US',
	"template_components" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"social_account_id" text NOT NULL,
	"platform" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"exit_on_reply" boolean DEFAULT true NOT NULL,
	"exit_on_unsubscribe" boolean DEFAULT true NOT NULL,
	"total_enrolled" integer DEFAULT 0 NOT NULL,
	"total_completed" integer DEFAULT 0 NOT NULL,
	"total_exited" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "social_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"platform" "platform" NOT NULL,
	"platform_account_id" text NOT NULL,
	"username" text,
	"display_name" text,
	"avatar_url" text,
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp with time zone,
	"scopes" text[],
	"metadata" jsonb,
	"workspace_id" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"events" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb,
	"status_code" integer,
	"response_time_ms" integer,
	"success" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_broadcast_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"broadcast_id" text NOT NULL,
	"phone" text NOT NULL,
	"variables" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"message_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "whatsapp_broadcasts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"social_account_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"template_name" text NOT NULL,
	"template_language" text DEFAULT 'en_US' NOT NULL,
	"template_components" jsonb,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"read_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_contact_group_members" (
	"contact_id" text NOT NULL,
	"group_id" text NOT NULL,
	CONSTRAINT "whatsapp_contact_group_members_contact_id_group_id_pk" PRIMARY KEY("contact_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "whatsapp_contact_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"social_account_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"social_account_id" text NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"email" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"opted_in" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_audience_users" ADD CONSTRAINT "ad_audience_users_audience_id_ad_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."ad_audiences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_audiences" ADD CONSTRAINT "ad_audiences_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_audiences" ADD CONSTRAINT "ad_audiences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_audiences" ADD CONSTRAINT "ad_audiences_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_metrics" ADD CONSTRAINT "ad_metrics_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_sync_logs" ADD CONSTRAINT "ad_sync_logs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_sync_logs" ADD CONSTRAINT "ad_sync_logs_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_boost_post_target_id_post_targets_id_fk" FOREIGN KEY ("boost_post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_message_id_inbox_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."inbox_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "byos_configs" ADD CONSTRAINT "byos_configs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_automation_logs" ADD CONSTRAINT "comment_automation_logs_automation_id_comment_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."comment_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_automation_logs" ADD CONSTRAINT "comment_automation_logs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_automations" ADD CONSTRAINT "comment_automations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_automations" ADD CONSTRAINT "comment_automations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_automations" ADD CONSTRAINT "comment_automations_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_logs" ADD CONSTRAINT "connection_logs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_logs" ADD CONSTRAINT "connection_logs_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_definition_id_custom_field_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."custom_field_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_contact_id_whatsapp_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."whatsapp_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_events" ADD CONSTRAINT "dunning_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_events" ADD CONSTRAINT "dunning_events_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_conversation_id_inbox_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."inbox_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."invitation" ADD CONSTRAINT "invitation_inviterId_user_id_fk" FOREIGN KEY ("inviterId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."invitation" ADD CONSTRAINT "invitation_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_usage_record_id_usage_records_id_fk" FOREIGN KEY ("usage_record_id") REFERENCES "public"."usage_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."member" ADD CONSTRAINT "member_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."member" ADD CONSTRAINT "member_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_analytics" ADD CONSTRAINT "post_analytics_post_target_id_post_targets_id_fk" FOREIGN KEY ("post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_webhook_id_webhook_endpoints_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_broadcast_recipients" ADD CONSTRAINT "whatsapp_broadcast_recipients_broadcast_id_whatsapp_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."whatsapp_broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_broadcasts" ADD CONSTRAINT "whatsapp_broadcasts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_broadcasts" ADD CONSTRAINT "whatsapp_broadcasts_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_contact_group_members" ADD CONSTRAINT "whatsapp_contact_group_members_contact_id_whatsapp_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."whatsapp_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_contact_group_members" ADD CONSTRAINT "whatsapp_contact_group_members_group_id_whatsapp_contact_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."whatsapp_contact_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_contact_groups" ADD CONSTRAINT "whatsapp_contact_groups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_contact_groups" ADD CONSTRAINT "whatsapp_contact_groups_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_contacts" ADD CONSTRAINT "whatsapp_contacts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_contacts" ADD CONSTRAINT "whatsapp_contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_contacts" ADD CONSTRAINT "whatsapp_contacts_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_accounts_org_platform_id_idx" ON "ad_accounts" USING btree ("organization_id","platform","platform_ad_account_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_org_idx" ON "ad_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_workspace_idx" ON "ad_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_social_account_idx" ON "ad_accounts" USING btree ("social_account_id");--> statement-breakpoint
CREATE INDEX "ad_audience_users_audience_idx" ON "ad_audience_users" USING btree ("audience_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_audience_users_dedup_idx" ON "ad_audience_users" USING btree ("audience_id","email_hash","phone_hash");--> statement-breakpoint
CREATE INDEX "ad_audiences_org_idx" ON "ad_audiences" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_audiences_workspace_idx" ON "ad_audiences" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ad_audiences_ad_account_idx" ON "ad_audiences" USING btree ("ad_account_id");--> statement-breakpoint
CREATE INDEX "ad_audiences_platform_id_idx" ON "ad_audiences" USING btree ("platform_audience_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_org_idx" ON "ad_campaigns" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_workspace_idx" ON "ad_campaigns" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_ad_account_idx" ON "ad_campaigns" USING btree ("ad_account_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_platform_id_idx" ON "ad_campaigns" USING btree ("platform_campaign_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_org_status_idx" ON "ad_campaigns" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_metrics_ad_date_idx" ON "ad_metrics" USING btree ("ad_id","date");--> statement-breakpoint
CREATE INDEX "ad_metrics_ad_idx" ON "ad_metrics" USING btree ("ad_id");--> statement-breakpoint
CREATE INDEX "ad_sync_logs_org_idx" ON "ad_sync_logs" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "ad_sync_logs_ad_account_idx" ON "ad_sync_logs" USING btree ("ad_account_id");--> statement-breakpoint
CREATE INDEX "ads_org_idx" ON "ads" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ads_workspace_idx" ON "ads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ads_campaign_idx" ON "ads" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "ads_platform_ad_id_idx" ON "ads" USING btree ("platform_ad_id");--> statement-breakpoint
CREATE INDEX "ads_org_status_idx" ON "ads" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "ads_boost_post_idx" ON "ads" USING btree ("boost_post_target_id");--> statement-breakpoint
CREATE INDEX "api_request_logs_org_id_desc_idx" ON "api_request_logs" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "api_request_logs_org_created_idx" ON "api_request_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "auth"."apikey" USING btree ("referenceId");--> statement-breakpoint
CREATE INDEX "apikey_organizationId_idx" ON "auth"."apikey" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "automation_logs_rule_idx" ON "automation_logs" USING btree ("rule_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_logs_org_idx" ON "automation_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_rules_org_enabled_idx" ON "automation_rules" USING btree ("organization_id","enabled");--> statement-breakpoint
CREATE INDEX "automation_rules_workspace_idx" ON "automation_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_broadcast_idx" ON "broadcast_recipients" USING btree ("broadcast_id");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_status_idx" ON "broadcast_recipients" USING btree ("broadcast_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_recipients_dedup_idx" ON "broadcast_recipients" USING btree ("broadcast_id","contact_identifier");--> statement-breakpoint
CREATE INDEX "broadcasts_org_idx" ON "broadcasts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "broadcasts_workspace_idx" ON "broadcasts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "broadcasts_status_idx" ON "broadcasts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "broadcasts_org_status_idx" ON "broadcasts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "comment_auto_logs_automation_idx" ON "comment_automation_logs" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_auto_logs_dedup_idx" ON "comment_automation_logs" USING btree ("automation_id","commenter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_automations_account_post_idx" ON "comment_automations" USING btree ("social_account_id","post_id");--> statement-breakpoint
CREATE INDEX "comment_automations_org_idx" ON "comment_automations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "comment_automations_workspace_idx" ON "comment_automations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "comment_automations_enabled_idx" ON "comment_automations" USING btree ("organization_id","enabled");--> statement-breakpoint
CREATE INDEX "connection_logs_org_created_idx" ON "connection_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_defs_org_slug_idx" ON "custom_field_definitions" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "custom_field_defs_org_idx" ON "custom_field_definitions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "custom_field_defs_workspace_idx" ON "custom_field_definitions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_values_def_contact_idx" ON "custom_field_values" USING btree ("definition_id","contact_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_contact_idx" ON "custom_field_values" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "dunning_events_org_idx" ON "dunning_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "dunning_events_invoice_id_idx" ON "dunning_events" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "inbox_conv_workspace_idx" ON "inbox_conversations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "inbox_conv_org_status_idx" ON "inbox_conversations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "inbox_conv_org_updated_idx" ON "inbox_conversations" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX "inbox_conv_account_idx" ON "inbox_conversations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "inbox_conv_org_platform_idx" ON "inbox_conversations" USING btree ("organization_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_conv_account_platform_id_idx" ON "inbox_conversations" USING btree ("account_id","platform_conversation_id");--> statement-breakpoint
CREATE INDEX "inbox_msg_conv_created_idx" ON "inbox_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "inbox_msg_org_created_idx" ON "inbox_messages" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_msg_dedup_idx" ON "inbox_messages" USING btree ("conversation_id","platform_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_period_idx" ON "invoices" USING btree ("organization_id","period_start");--> statement-breakpoint
CREATE INDEX "media_org_idx" ON "media" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "media_workspace_idx" ON "media" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_read_idx" ON "notifications" USING btree ("user_id","read");--> statement-breakpoint
CREATE INDEX "org_subs_stripe_sub_id_idx" ON "organization_subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "org_subs_stripe_customer_id_idx" ON "organization_subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "post_analytics_target_collected_idx" ON "post_analytics" USING btree ("post_target_id","collected_at");--> statement-breakpoint
CREATE INDEX "post_targets_post_id_idx" ON "post_targets" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_targets_post_status_idx" ON "post_targets" USING btree ("post_id","status");--> statement-breakpoint
CREATE INDEX "post_targets_social_account_id_idx" ON "post_targets" USING btree ("social_account_id");--> statement-breakpoint
CREATE INDEX "post_targets_updated_at_idx" ON "post_targets" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "posts_org_created_idx" ON "posts" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_workspace_idx" ON "posts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "posts_status_scheduled_idx" ON "posts" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_seq_contact_idx" ON "sequence_enrollments" USING btree ("sequence_id","contact_id");--> statement-breakpoint
CREATE INDEX "enrollments_next_step_idx" ON "sequence_enrollments" USING btree ("status","next_step_at");--> statement-breakpoint
CREATE INDEX "enrollments_org_idx" ON "sequence_enrollments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "enrollments_seq_status_idx" ON "sequence_enrollments" USING btree ("sequence_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_steps_seq_order_idx" ON "sequence_steps" USING btree ("sequence_id","step_order");--> statement-breakpoint
CREATE INDEX "sequences_org_idx" ON "sequences" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sequences_workspace_idx" ON "sequences" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sequences_org_status_idx" ON "sequences" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_org_platform_account_idx" ON "social_accounts" USING btree ("organization_id","platform","platform_account_id");--> statement-breakpoint
CREATE INDEX "social_accounts_org_idx" ON "social_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "social_accounts_workspace_idx" ON "social_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_org_period_idx" ON "usage_records" USING btree ("organization_id","period_start");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_org_idx" ON "webhook_endpoints" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_workspace_idx" ON "webhook_endpoints" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "webhook_logs_webhook_id_idx" ON "webhook_logs" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_logs_org_created_idx" ON "webhook_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "wa_broadcast_recipients_broadcast_idx" ON "whatsapp_broadcast_recipients" USING btree ("broadcast_id");--> statement-breakpoint
CREATE INDEX "wa_broadcast_recipients_msg_idx" ON "whatsapp_broadcast_recipients" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "wa_broadcasts_org_idx" ON "whatsapp_broadcasts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "wa_broadcasts_status_idx" ON "whatsapp_broadcasts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wa_contact_groups_org_idx" ON "whatsapp_contact_groups" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_contacts_account_phone_idx" ON "whatsapp_contacts" USING btree ("social_account_id","phone");--> statement-breakpoint
CREATE INDEX "wa_contacts_org_idx" ON "whatsapp_contacts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "wa_contacts_workspace_idx" ON "whatsapp_contacts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspaces_org_idx" ON "workspaces" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "workspaces_org_name_idx" ON "workspaces" USING btree ("organization_id","name");