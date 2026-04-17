CREATE TYPE "public"."automation_channel" AS ENUM('instagram', 'facebook', 'whatsapp', 'telegram', 'discord', 'sms', 'twitter', 'bluesky', 'threads', 'youtube', 'linkedin', 'mastodon', 'reddit', 'googlebusiness', 'beehiiv', 'kit', 'mailchimp', 'listmonk', 'pinterest', 'multi');--> statement-breakpoint
CREATE TYPE "public"."automation_enrollment_status" AS ENUM('active', 'waiting', 'completed', 'exited', 'failed');--> statement-breakpoint
CREATE TYPE "public"."automation_node_type" AS ENUM('trigger', 'message_text', 'message_media', 'message_file', 'user_input_text', 'user_input_email', 'user_input_phone', 'user_input_number', 'user_input_date', 'user_input_choice', 'user_input_file', 'condition', 'smart_delay', 'randomizer', 'split_test', 'goto', 'end', 'subflow_call', 'ai_step', 'ai_agent', 'ai_intent_router', 'tag_add', 'tag_remove', 'field_set', 'field_clear', 'subscription_add', 'subscription_remove', 'segment_add', 'segment_remove', 'notify_admin', 'conversation_assign', 'conversation_status', 'http_request', 'webhook_out', 'instagram_send_text', 'instagram_send_media', 'instagram_send_buttons', 'instagram_send_quick_replies', 'instagram_send_generic_template', 'instagram_typing', 'instagram_mark_seen', 'instagram_reply_to_comment', 'instagram_hide_comment', 'facebook_send_text', 'facebook_send_media', 'facebook_send_template', 'facebook_send_quick_replies', 'facebook_send_button_template', 'facebook_reply_to_comment', 'facebook_private_reply', 'facebook_hide_comment', 'facebook_sender_action', 'whatsapp_send_text', 'whatsapp_send_media', 'whatsapp_send_template', 'whatsapp_send_interactive', 'whatsapp_send_flow', 'whatsapp_send_location', 'whatsapp_send_contacts', 'whatsapp_react', 'whatsapp_mark_read', 'telegram_send_text', 'telegram_send_media', 'telegram_send_media_group', 'telegram_send_poll', 'telegram_send_location', 'telegram_send_keyboard', 'telegram_edit_message', 'telegram_pin_message', 'telegram_react', 'telegram_set_chat_action', 'discord_send_message', 'discord_send_embed', 'discord_send_components', 'discord_send_attachment', 'discord_react', 'discord_edit_message', 'discord_start_thread', 'sms_send', 'sms_send_mms', 'twitter_send_dm', 'twitter_send_dm_media', 'twitter_reply_to_tweet', 'twitter_like_tweet', 'twitter_retweet', 'bluesky_reply', 'bluesky_like', 'bluesky_repost', 'bluesky_send_dm', 'threads_reply_to_post', 'threads_hide_reply', 'youtube_reply_to_comment', 'youtube_send_live_chat', 'youtube_moderate_comment', 'linkedin_reply_to_comment', 'linkedin_react_to_post', 'mastodon_reply', 'mastodon_favourite', 'mastodon_boost', 'mastodon_send_dm', 'reddit_reply_to_comment', 'reddit_send_pm', 'reddit_reply_modmail', 'reddit_submit_post', 'googlebusiness_reply_to_review', 'googlebusiness_post_update', 'beehiiv_add_subscriber', 'beehiiv_publish_post', 'beehiiv_enroll_automation', 'kit_add_subscriber', 'kit_add_tag', 'kit_send_broadcast', 'mailchimp_add_member', 'mailchimp_add_tag', 'mailchimp_send_campaign', 'listmonk_add_subscriber', 'listmonk_send_campaign', 'pinterest_create_pin');--> statement-breakpoint
CREATE TYPE "public"."automation_status" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."automation_trigger_type" AS ENUM('instagram_dm', 'instagram_comment', 'instagram_story_reply', 'instagram_story_mention', 'instagram_mention', 'instagram_reaction', 'instagram_live_comment', 'instagram_postback', 'instagram_referral', 'facebook_dm', 'facebook_comment', 'facebook_mention', 'facebook_postback', 'facebook_reaction', 'facebook_optin', 'facebook_feed_post', 'whatsapp_message', 'whatsapp_keyword', 'whatsapp_button_click', 'whatsapp_list_reply', 'whatsapp_flow_submit', 'whatsapp_reaction', 'whatsapp_status_update', 'telegram_message', 'telegram_command', 'telegram_channel_post', 'telegram_callback_query', 'telegram_reaction', 'telegram_member_joined', 'telegram_chat_join_request', 'telegram_business_message', 'telegram_inline_query', 'discord_message', 'discord_dm', 'discord_reaction', 'discord_member_joined', 'discord_thread_created', 'discord_interaction', 'sms_received', 'twitter_dm', 'twitter_mention', 'twitter_reply', 'twitter_follow', 'twitter_like', 'twitter_retweet', 'twitter_quote', 'bluesky_dm', 'bluesky_reply', 'bluesky_mention', 'bluesky_follow', 'bluesky_like', 'threads_reply', 'threads_mention', 'threads_publish', 'youtube_comment', 'youtube_live_chat', 'youtube_new_video', 'linkedin_comment', 'linkedin_mention', 'linkedin_reaction', 'mastodon_mention', 'mastodon_reply', 'mastodon_boost', 'mastodon_follow', 'mastodon_favourite', 'reddit_comment', 'reddit_mention', 'reddit_new_post', 'reddit_modmail', 'reddit_dm', 'googlebusiness_new_review', 'googlebusiness_updated_review', 'googlebusiness_new_customer_media', 'googlebusiness_duplicate_location', 'googlebusiness_voice_of_merchant_updated', 'googlebusiness_google_update', 'beehiiv_subscription_created', 'beehiiv_subscription_confirmed', 'beehiiv_subscription_deleted', 'kit_subscriber_activate', 'kit_form_subscribe', 'kit_tag_add', 'mailchimp_subscribe', 'mailchimp_unsubscribe', 'scheduled_time', 'engagement_threshold', 'tag_applied', 'tag_removed', 'field_changed', 'external_api', 'manual', 'segment_entered', 'segment_left');--> statement-breakpoint
CREATE TABLE "ai_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"persona" text,
	"guardrails" text,
	"model" text DEFAULT 'claude-haiku-4-5' NOT NULL,
	"kb_id" text,
	"handoff_strategy" jsonb,
	"temperature" real DEFAULT 0.7,
	"max_tokens" integer DEFAULT 1024,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_knowledge_bases" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"description" text,
	"embedding_model" text DEFAULT 'text-embedding-3-small' NOT NULL,
	"embedding_dimensions" integer DEFAULT 1536 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_knowledge_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"kb_id" text NOT NULL,
	"content" text NOT NULL,
	"embedding" real[],
	"chunk_index" integer NOT NULL,
	"token_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_knowledge_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"kb_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text NOT NULL,
	"title" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_crawled_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"from_node_id" text NOT NULL,
	"to_node_id" text NOT NULL,
	"label" text DEFAULT 'next' NOT NULL,
	"edge_order" integer DEFAULT 0 NOT NULL,
	"condition_expr" jsonb
);
--> statement-breakpoint
CREATE TABLE "automation_enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"automation_version" integer NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" text,
	"conversation_id" text,
	"current_node_id" text,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "automation_enrollment_status" DEFAULT 'active' NOT NULL,
	"next_run_at" timestamp with time zone,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"exited_at" timestamp with time zone,
	"exit_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"key" text NOT NULL,
	"type" "automation_node_type" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"canvas_x" real,
	"canvas_y" real,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_run_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"enrollment_id" text NOT NULL,
	"node_id" text,
	"node_type" "automation_node_type",
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"branch_label" text,
	"duration_ms" integer,
	"error" text,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "automation_scheduled_ticks" (
	"id" text PRIMARY KEY NOT NULL,
	"enrollment_id" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" text
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"description" text,
	"status" "automation_status" DEFAULT 'draft' NOT NULL,
	"channel" "automation_channel" NOT NULL,
	"trigger_type" "automation_trigger_type" NOT NULL,
	"trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trigger_filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"social_account_id" text,
	"entry_node_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"published_version" integer,
	"exit_on_reply" boolean DEFAULT true NOT NULL,
	"allow_reentry" boolean DEFAULT false NOT NULL,
	"reentry_cooldown_min" integer,
	"total_enrolled" integer DEFAULT 0 NOT NULL,
	"total_completed" integer DEFAULT 0 NOT NULL,
	"total_exited" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_subscriptions" (
	"contact_id" text NOT NULL,
	"list_id" text NOT NULL,
	"subscribed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	"source" text,
	CONSTRAINT "contact_subscriptions_contact_id_list_id_pk" PRIMARY KEY("contact_id","list_id")
);
--> statement-breakpoint
CREATE TABLE "landing_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"config" jsonb NOT NULL,
	"automation_id" text,
	"visits" integer DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qr_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ref_url_id" text NOT NULL,
	"image_r2_key" text,
	"scan_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ref_urls" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"slug" text NOT NULL,
	"automation_id" text,
	"uses" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"description" text,
	"filter" jsonb NOT NULL,
	"is_dynamic" boolean DEFAULT true NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"channel" "automation_channel" NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_kb_id_ai_knowledge_bases_id_fk" FOREIGN KEY ("kb_id") REFERENCES "public"."ai_knowledge_bases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_bases" ADD CONSTRAINT "ai_knowledge_bases_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_bases" ADD CONSTRAINT "ai_knowledge_bases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_document_id_ai_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."ai_knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_kb_id_ai_knowledge_bases_id_fk" FOREIGN KEY ("kb_id") REFERENCES "public"."ai_knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_documents" ADD CONSTRAINT "ai_knowledge_documents_kb_id_ai_knowledge_bases_id_fk" FOREIGN KEY ("kb_id") REFERENCES "public"."ai_knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_edges" ADD CONSTRAINT "automation_edges_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_edges" ADD CONSTRAINT "automation_edges_from_node_id_automation_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."automation_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_edges" ADD CONSTRAINT "automation_edges_to_node_id_automation_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."automation_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_enrollments" ADD CONSTRAINT "automation_enrollments_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_enrollments" ADD CONSTRAINT "automation_enrollments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_nodes" ADD CONSTRAINT "automation_nodes_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run_logs" ADD CONSTRAINT "automation_run_logs_enrollment_id_automation_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."automation_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_scheduled_ticks" ADD CONSTRAINT "automation_scheduled_ticks_enrollment_id_automation_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."automation_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_subscriptions" ADD CONSTRAINT "contact_subscriptions_list_id_subscription_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."subscription_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_ref_url_id_ref_urls_id_fk" FOREIGN KEY ("ref_url_id") REFERENCES "public"."ref_urls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_urls" ADD CONSTRAINT "ref_urls_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_urls" ADD CONSTRAINT "ref_urls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_urls" ADD CONSTRAINT "ref_urls_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_lists" ADD CONSTRAINT "subscription_lists_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_lists" ADD CONSTRAINT "subscription_lists_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_agents_org_idx" ON "ai_agents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_bases_org_idx" ON "ai_knowledge_bases" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_doc_idx" ON "ai_knowledge_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_kb_idx" ON "ai_knowledge_chunks" USING btree ("kb_id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_documents_kb_idx" ON "ai_knowledge_documents" USING btree ("kb_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_edges_uniq_idx" ON "automation_edges" USING btree ("automation_id","from_node_id","label","edge_order");--> statement-breakpoint
CREATE INDEX "automation_edges_automation_idx" ON "automation_edges" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "automation_edges_from_idx" ON "automation_edges" USING btree ("from_node_id");--> statement-breakpoint
CREATE INDEX "automation_enrollments_scheduler_idx" ON "automation_enrollments" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "automation_enrollments_automation_idx" ON "automation_enrollments" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "automation_enrollments_contact_idx" ON "automation_enrollments" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "automation_enrollments_org_idx" ON "automation_enrollments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "automation_enrollments_waiting_contact_idx" ON "automation_enrollments" USING btree ("contact_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_nodes_automation_key_idx" ON "automation_nodes" USING btree ("automation_id","key");--> statement-breakpoint
CREATE INDEX "automation_nodes_automation_idx" ON "automation_nodes" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "automation_run_logs_enrollment_idx" ON "automation_run_logs" USING btree ("enrollment_id","executed_at");--> statement-breakpoint
CREATE INDEX "automation_scheduled_ticks_run_at_idx" ON "automation_scheduled_ticks" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_versions_auto_version_idx" ON "automation_versions" USING btree ("automation_id","version");--> statement-breakpoint
CREATE INDEX "automations_org_idx" ON "automations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "automations_workspace_idx" ON "automations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "automations_trigger_matcher_idx" ON "automations" USING btree ("organization_id","status","trigger_type");--> statement-breakpoint
CREATE INDEX "automations_account_idx" ON "automations" USING btree ("social_account_id");--> statement-breakpoint
CREATE INDEX "contact_subscriptions_list_idx" ON "contact_subscriptions" USING btree ("list_id");--> statement-breakpoint
CREATE UNIQUE INDEX "landing_pages_org_slug_idx" ON "landing_pages" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "landing_pages_automation_idx" ON "landing_pages" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "qr_codes_org_idx" ON "qr_codes" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ref_urls_org_slug_idx" ON "ref_urls" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "ref_urls_automation_idx" ON "ref_urls" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "segments_org_idx" ON "segments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "segments_workspace_idx" ON "segments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "subscription_lists_org_idx" ON "subscription_lists" USING btree ("organization_id");