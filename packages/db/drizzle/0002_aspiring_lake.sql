ALTER TABLE "post_targets" ADD COLUMN "provider_disposition" text;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "provider_operation_id" text;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "provider_state" text;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "provider_effects" jsonb;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "next_reconcile_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "reconcile_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD COLUMN "provider_operation_id" text;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD COLUMN "provider_disposition" text;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD COLUMN "provider_state" text;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD COLUMN "provider_effects" jsonb;--> statement-breakpoint
CREATE INDEX "post_targets_reconcile_due_idx" ON "post_targets" USING btree ("next_reconcile_at","id") WHERE "post_targets"."delivery_state" = 'unknown' AND "post_targets"."next_reconcile_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_reconcile_attempts_nonnegative_check" CHECK ("post_targets"."reconcile_attempts" >= 0);
