CREATE TYPE "public"."recycle_gap_freq" AS ENUM('day', 'week', 'month');--> statement-breakpoint
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_phone_numbers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"social_account_id" text,
	"phone_number" text NOT NULL,
	"provider" text DEFAULT 'telnyx' NOT NULL,
	"provider_number_id" text,
	"wa_phone_number_id" text,
	"status" text DEFAULT 'purchasing' NOT NULL,
	"verification_method" text,
	"stripe_subscription_item_id" text,
	"monthly_cost_cents" integer DEFAULT 200 NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "recycled_from_id" text;--> statement-breakpoint
ALTER TABLE "post_recycling_configs" ADD CONSTRAINT "post_recycling_configs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_recycling_configs" ADD CONSTRAINT "post_recycling_configs_source_post_id_posts_id_fk" FOREIGN KEY ("source_post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_phone_numbers" ADD CONSTRAINT "whatsapp_phone_numbers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_phone_numbers" ADD CONSTRAINT "whatsapp_phone_numbers_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_recycling_configs_org_idx" ON "post_recycling_configs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "post_recycling_configs_enabled_next_idx" ON "post_recycling_configs" USING btree ("enabled","next_recycle_at");--> statement-breakpoint
CREATE UNIQUE INDEX "post_recycling_configs_source_post_idx" ON "post_recycling_configs" USING btree ("source_post_id");--> statement-breakpoint
CREATE INDEX "wa_phone_numbers_org_idx" ON "whatsapp_phone_numbers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "wa_phone_numbers_status_idx" ON "whatsapp_phone_numbers" USING btree ("status");--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_recycled_from_id_posts_id_fk" FOREIGN KEY ("recycled_from_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posts_recycled_from_idx" ON "posts" USING btree ("recycled_from_id");