CREATE TABLE "external_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
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
	"published_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_account_sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"social_account_id" text NOT NULL,
	"organization_id" text NOT NULL,
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
	CONSTRAINT "social_account_sync_state_social_account_id_unique" UNIQUE("social_account_id")
);
--> statement-breakpoint
ALTER TABLE "external_posts" ADD CONSTRAINT "external_posts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_posts" ADD CONSTRAINT "external_posts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_posts" ADD CONSTRAINT "external_posts_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_sync_state" ADD CONSTRAINT "social_account_sync_state_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_sync_state" ADD CONSTRAINT "social_account_sync_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_posts_account_platform_post_idx" ON "external_posts" USING btree ("social_account_id","platform_post_id");--> statement-breakpoint
CREATE INDEX "external_posts_org_published_idx" ON "external_posts" USING btree ("organization_id","published_at");--> statement-breakpoint
CREATE INDEX "external_posts_workspace_idx" ON "external_posts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "external_posts_metrics_updated_idx" ON "external_posts" USING btree ("metrics_updated_at");--> statement-breakpoint
CREATE INDEX "external_posts_org_platform_idx" ON "external_posts" USING btree ("organization_id","platform");--> statement-breakpoint
CREATE INDEX "sync_state_enabled_next_idx" ON "social_account_sync_state" USING btree ("enabled","next_sync_at");--> statement-breakpoint
CREATE INDEX "sync_state_org_idx" ON "social_account_sync_state" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "posts_org_published_idx" ON "posts" USING btree ("organization_id","published_at");