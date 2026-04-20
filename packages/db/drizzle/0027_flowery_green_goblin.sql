CREATE TABLE "automation_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"type" "automation_trigger_type" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"social_account_id" text,
	"label" text NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automations" DROP CONSTRAINT "automations_social_account_id_social_accounts_id_fk";
--> statement-breakpoint
DROP INDEX "automations_trigger_matcher_idx";--> statement-breakpoint
DROP INDEX "automations_account_idx";--> statement-breakpoint
ALTER TABLE "automation_enrollments" ADD COLUMN "trigger_id" text;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_triggers_automation_idx" ON "automation_triggers" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "automation_triggers_matcher_idx" ON "automation_triggers" USING btree ("type");--> statement-breakpoint
CREATE INDEX "automation_triggers_account_idx" ON "automation_triggers" USING btree ("social_account_id");--> statement-breakpoint
ALTER TABLE "automation_enrollments" ADD CONSTRAINT "automation_enrollments_trigger_id_automation_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."automation_triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_enrollments_trigger_idx" ON "automation_enrollments" USING btree ("trigger_id");--> statement-breakpoint
CREATE INDEX "automations_active_idx" ON "automations" USING btree ("organization_id","status");--> statement-breakpoint
-- Backfill: one automation_triggers row per existing automation, copying the
-- old trigger_* columns before we drop them. IDs use a pg-side pseudo-random
-- generator so pre-existing rows get stable unique keys.
INSERT INTO "automation_triggers" ("id", "automation_id", "type", "config", "filters", "social_account_id", "label", "order_index", "created_at", "updated_at")
SELECT
    'atrg_' || substr(md5(random()::text || a.id), 1, 22),
    a.id,
    a.trigger_type,
    a.trigger_config,
    a.trigger_filters,
    a.social_account_id,
    'Trigger #1',
    0,
    a.created_at,
    a.updated_at
FROM "automations" a;--> statement-breakpoint
-- Point each in-flight enrollment at its automation's (now sole) trigger so
-- the runtime can resolve account_id and per-trigger config from snapshot.
UPDATE "automation_enrollments" e
SET trigger_id = (
    SELECT t.id FROM "automation_triggers" t WHERE t.automation_id = e.automation_id LIMIT 1
);--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "trigger_type";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "trigger_config";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "trigger_filters";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "social_account_id";