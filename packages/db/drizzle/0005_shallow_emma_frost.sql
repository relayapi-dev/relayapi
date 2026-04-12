ALTER TABLE "posts" ADD COLUMN "metrics_snapshot" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "metrics_collected_at" timestamp with time zone;