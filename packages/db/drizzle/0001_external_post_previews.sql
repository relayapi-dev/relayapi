ALTER TABLE "external_posts" ADD COLUMN "preview_thumbnail_key" text;--> statement-breakpoint
ALTER TABLE "external_posts" ADD COLUMN "preview_thumbnail_url" text;--> statement-breakpoint
ALTER TABLE "external_posts" ADD COLUMN "preview_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "external_posts" ADD COLUMN "preview_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "external_posts" ADD COLUMN "preview_next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "external_posts" ADD COLUMN "preview_last_error" text;--> statement-breakpoint
CREATE INDEX "external_posts_preview_retry_idx" ON "external_posts" USING btree ("preview_status","preview_next_retry_at");--> statement-breakpoint
ALTER TABLE "external_posts" ADD CONSTRAINT "external_posts_preview_status_check" CHECK ("external_posts"."preview_status" IN ('pending', 'processing', 'generated', 'unsupported', 'source_missing', 'transient_failure'));--> statement-breakpoint
ALTER TABLE "external_posts" ADD CONSTRAINT "external_posts_preview_attempts_nonnegative_check" CHECK ("external_posts"."preview_attempts" >= 0);
