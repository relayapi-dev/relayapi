ALTER TABLE "ad_metrics" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "org_streaks" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;