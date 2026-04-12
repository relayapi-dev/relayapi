ALTER TYPE "public"."platform" ADD VALUE 'beehiiv';--> statement-breakpoint
ALTER TYPE "public"."platform" ADD VALUE 'convertkit';--> statement-breakpoint
ALTER TYPE "public"."platform" ADD VALUE 'mailchimp';--> statement-breakpoint
ALTER TYPE "public"."platform" ADD VALUE 'listmonk';--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "thread_group_id" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "thread_position" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "thread_delay_ms" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "scheduling_preferences" jsonb;--> statement-breakpoint
CREATE INDEX "posts_thread_group_idx" ON "posts" USING btree ("thread_group_id","thread_position");