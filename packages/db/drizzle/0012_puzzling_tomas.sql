CREATE TABLE "auto_post_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"description" text,
	"content" text NOT NULL,
	"platform_overrides" jsonb,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cross_post_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"action_type" text NOT NULL,
	"target_account_id" text NOT NULL,
	"content" text,
	"delay_minutes" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"execute_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"result_post_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_rule_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"post_target_id" text NOT NULL,
	"check_number" integer NOT NULL,
	"metric_value" integer,
	"threshold_met" boolean NOT NULL,
	"action_taken" boolean NOT NULL,
	"result_post_id" text,
	"error" text,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"account_id" text NOT NULL,
	"trigger_metric" text NOT NULL,
	"trigger_threshold" integer NOT NULL,
	"action_type" text NOT NULL,
	"action_account_id" text,
	"action_content" text,
	"check_interval_minutes" integer DEFAULT 360 NOT NULL,
	"max_checks" integer DEFAULT 3 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_streaks_organization_id_unique" UNIQUE("organization_id")
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
	"original_url" text NOT NULL,
	"short_url" text NOT NULL,
	"post_id" text,
	"click_count" integer DEFAULT 0 NOT NULL,
	"last_click_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signatures" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"position" text DEFAULT 'append' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "streak_warnings" jsonb DEFAULT '{"push":true,"email":true}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "auto_post_rules" ADD CONSTRAINT "auto_post_rules_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_post_rules" ADD CONSTRAINT "auto_post_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_templates" ADD CONSTRAINT "content_templates_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_templates" ADD CONSTRAINT "content_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_post_actions" ADD CONSTRAINT "cross_post_actions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_post_actions" ADD CONSTRAINT "cross_post_actions_target_account_id_social_accounts_id_fk" FOREIGN KEY ("target_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_rule_logs" ADD CONSTRAINT "engagement_rule_logs_rule_id_engagement_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."engagement_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_rule_logs" ADD CONSTRAINT "engagement_rule_logs_post_target_id_post_targets_id_fk" FOREIGN KEY ("post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_rules" ADD CONSTRAINT "engagement_rules_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_rules" ADD CONSTRAINT "engagement_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_rules" ADD CONSTRAINT "engagement_rules_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_rules" ADD CONSTRAINT "engagement_rules_action_account_id_social_accounts_id_fk" FOREIGN KEY ("action_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_streaks" ADD CONSTRAINT "org_streaks_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_link_configs" ADD CONSTRAINT "short_link_configs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auto_post_rules_org_status_idx" ON "auto_post_rules" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "auto_post_rules_workspace_idx" ON "auto_post_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "content_templates_org_idx" ON "content_templates" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "content_templates_org_created_idx" ON "content_templates" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "content_templates_workspace_idx" ON "content_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "cross_post_actions_post_idx" ON "cross_post_actions" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "cross_post_actions_status_idx" ON "cross_post_actions" USING btree ("status","execute_at");--> statement-breakpoint
CREATE INDEX "engagement_rule_logs_rule_idx" ON "engagement_rule_logs" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "engagement_rule_logs_post_idx" ON "engagement_rule_logs" USING btree ("post_target_id");--> statement-breakpoint
CREATE INDEX "engagement_rules_org_idx" ON "engagement_rules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "engagement_rules_account_idx" ON "engagement_rules" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "engagement_rules_workspace_idx" ON "engagement_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "org_streaks_org_idx" ON "org_streaks" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "org_streaks_last_post_idx" ON "org_streaks" USING btree ("last_post_at");--> statement-breakpoint
CREATE INDEX "short_link_configs_org_idx" ON "short_link_configs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "short_links_org_idx" ON "short_links" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "short_links_post_idx" ON "short_links" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "short_links_short_url_idx" ON "short_links" USING btree ("short_url");--> statement-breakpoint
CREATE INDEX "signatures_org_idx" ON "signatures" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "signatures_workspace_idx" ON "signatures" USING btree ("workspace_id");