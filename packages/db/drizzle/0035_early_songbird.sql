CREATE TYPE "public"."automation_run_status" AS ENUM('active', 'waiting', 'completed', 'exited', 'failed');--> statement-breakpoint
CREATE TABLE "automation_entrypoints" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"channel" "automation_channel" NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"social_account_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"filters" jsonb,
	"allow_reentry" boolean DEFAULT true NOT NULL,
	"reentry_cooldown_min" integer DEFAULT 60 NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"specificity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"entrypoint_id" text,
	"binding_id" text,
	"contact_id" text NOT NULL,
	"conversation_id" text,
	"status" "automation_run_status" DEFAULT 'active' NOT NULL,
	"current_node_key" text,
	"current_port_key" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"waiting_until" timestamp with time zone,
	"waiting_for" text,
	"exit_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_scheduled_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"job_type" text NOT NULL,
	"automation_id" text,
	"entrypoint_id" text,
	"run_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"payload" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_step_runs" (
	"id" bigserial NOT NULL,
	"run_id" text NOT NULL,
	"automation_id" text NOT NULL,
	"node_key" text NOT NULL,
	"node_kind" text NOT NULL,
	"entered_via_port_key" text,
	"exited_via_port_key" text,
	"outcome" text NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"error" jsonb,
	"executed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "automation_step_runs_id_executed_at_pk" PRIMARY KEY("id","executed_at")
);
--> statement-breakpoint
ALTER TABLE "automation_edges" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_enrollments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_nodes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_run_logs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_scheduled_ticks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_triggers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_versions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "automation_edges" CASCADE;--> statement-breakpoint
DROP TABLE "automation_enrollments" CASCADE;--> statement-breakpoint
DROP TABLE "automation_nodes" CASCADE;--> statement-breakpoint
DROP TABLE "automation_run_logs" CASCADE;--> statement-breakpoint
DROP TABLE "automation_scheduled_ticks" CASCADE;--> statement-breakpoint
DROP TABLE "automation_triggers" CASCADE;--> statement-breakpoint
DROP TABLE "automation_versions" CASCADE;--> statement-breakpoint
ALTER TABLE "automation_bindings" DROP CONSTRAINT "automation_bindings_trigger_id_automation_triggers_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_bindings" DROP CONSTRAINT "automation_bindings_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_bindings" DROP CONSTRAINT "automation_bindings_social_account_id_social_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_contact_controls" DROP CONSTRAINT "automation_contact_controls_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "automations" DROP CONSTRAINT "automations_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_bindings" ALTER COLUMN "binding_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."automation_binding_type";--> statement-breakpoint
CREATE TYPE "public"."automation_binding_type" AS ENUM('default_reply', 'welcome_message', 'conversation_starter', 'main_menu', 'ice_breaker');--> statement-breakpoint
ALTER TABLE "automation_bindings" ALTER COLUMN "binding_type" SET DATA TYPE "public"."automation_binding_type" USING "binding_type"::"public"."automation_binding_type";--> statement-breakpoint
ALTER TABLE "automation_bindings" ALTER COLUMN "channel" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "automation_entrypoints" ALTER COLUMN "channel" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "automations" ALTER COLUMN "channel" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "subscription_lists" ALTER COLUMN "channel" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."automation_channel";--> statement-breakpoint
CREATE TYPE "public"."automation_channel" AS ENUM('instagram', 'facebook', 'whatsapp', 'telegram', 'tiktok');--> statement-breakpoint
ALTER TABLE "automation_bindings" ALTER COLUMN "channel" SET DATA TYPE "public"."automation_channel" USING "channel"::"public"."automation_channel";--> statement-breakpoint
ALTER TABLE "automation_entrypoints" ALTER COLUMN "channel" SET DATA TYPE "public"."automation_channel" USING "channel"::"public"."automation_channel";--> statement-breakpoint
ALTER TABLE "automations" ALTER COLUMN "channel" SET DATA TYPE "public"."automation_channel" USING "channel"::"public"."automation_channel";--> statement-breakpoint
ALTER TABLE "subscription_lists" ALTER COLUMN "channel" SET DATA TYPE "public"."automation_channel" USING "channel"::"public"."automation_channel";--> statement-breakpoint
DROP INDEX "automation_bindings_org_idx";--> statement-breakpoint
DROP INDEX "automation_bindings_auto_idx";--> statement-breakpoint
DROP INDEX "automation_bindings_scope_idx";--> statement-breakpoint
DROP INDEX "automation_bindings_workspace_idx";--> statement-breakpoint
DROP INDEX "automation_contact_controls_org_idx";--> statement-breakpoint
DROP INDEX "automation_contact_controls_contact_idx";--> statement-breakpoint
DROP INDEX "automation_contact_controls_conversation_idx";--> statement-breakpoint
DROP INDEX "automation_contact_controls_auto_idx";--> statement-breakpoint
DROP INDEX "automations_org_idx";--> statement-breakpoint
DROP INDEX "automations_workspace_idx";--> statement-breakpoint
DROP INDEX "automations_active_idx";--> statement-breakpoint
ALTER TABLE "automation_bindings" ALTER COLUMN "social_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_contact_controls" ALTER COLUMN "contact_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD COLUMN "sync_error" text;--> statement-breakpoint
ALTER TABLE "automation_contact_controls" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "automation_contact_controls" ADD COLUMN "paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_contact_controls" ADD COLUMN "paused_by_user_id" text;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "graph" jsonb DEFAULT '{"schema_version":1,"root_node_key":null,"nodes":[],"edges":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "created_from_template" text;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "template_config" jsonb;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "total_failed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "last_validated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "validation_errors" jsonb;--> statement-breakpoint
ALTER TABLE "automation_entrypoints" ADD CONSTRAINT "automation_entrypoints_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_entrypoints" ADD CONSTRAINT "automation_entrypoints_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_entrypoint_id_automation_entrypoints_id_fk" FOREIGN KEY ("entrypoint_id") REFERENCES "public"."automation_entrypoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_binding_id_automation_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."automation_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_conversation_id_inbox_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."inbox_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_scheduled_jobs" ADD CONSTRAINT "automation_scheduled_jobs_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_scheduled_jobs" ADD CONSTRAINT "automation_scheduled_jobs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_scheduled_jobs" ADD CONSTRAINT "automation_scheduled_jobs_entrypoint_id_automation_entrypoints_id_fk" FOREIGN KEY ("entrypoint_id") REFERENCES "public"."automation_entrypoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_automation_entrypoints_automation" ON "automation_entrypoints" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "idx_automation_entrypoints_match" ON "automation_entrypoints" USING btree ("channel","kind","status");--> statement-breakpoint
CREATE INDEX "idx_automation_entrypoints_account_match" ON "automation_entrypoints" USING btree ("social_account_id","kind","status");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_auto_status" ON "automation_runs" USING btree ("automation_id","status");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_contact_auto" ON "automation_runs" USING btree ("contact_id","automation_id");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_sweeper" ON "automation_runs" USING btree ("status","waiting_until");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_org_started" ON "automation_runs" USING btree ("organization_id","started_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automation_runs_active_uniq" ON "automation_runs" USING btree ("contact_id","automation_id") WHERE "status" IN ('active', 'waiting');--> statement-breakpoint
CREATE INDEX "idx_scheduled_jobs_sweep" ON "automation_scheduled_jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "idx_scheduled_jobs_run" ON "automation_scheduled_jobs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_step_runs_run_time" ON "automation_step_runs" USING btree ("run_id","executed_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_step_runs_auto_time" ON "automation_step_runs" USING btree ("automation_id","executed_at");--> statement-breakpoint
CREATE INDEX "idx_step_runs_node_time" ON "automation_step_runs" USING btree ("node_key","executed_at");--> statement-breakpoint
CREATE INDEX "idx_step_runs_executed_brin" ON "automation_step_runs" USING brin ("executed_at");--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD CONSTRAINT "automation_bindings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD CONSTRAINT "automation_bindings_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_contact_controls" ADD CONSTRAINT "automation_contact_controls_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_contact_controls" ADD CONSTRAINT "automation_contact_controls_paused_by_user_id_user_id_fk" FOREIGN KEY ("paused_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_contact_controls" ADD CONSTRAINT "automation_contact_controls_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_bindings_social_account_binding_type_uniq" ON "automation_bindings" USING btree ("social_account_id","binding_type");--> statement-breakpoint
CREATE INDEX "idx_automation_bindings_lookup" ON "automation_bindings" USING btree ("social_account_id","binding_type","status");--> statement-breakpoint
CREATE INDEX "idx_automation_bindings_automation" ON "automation_bindings" USING btree ("automation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_contact_controls_per_auto" ON "automation_contact_controls" USING btree ("contact_id","automation_id") WHERE "automation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_contact_controls_global" ON "automation_contact_controls" USING btree ("contact_id") WHERE "automation_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_contact_controls_contact" ON "automation_contact_controls" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_contact_controls_expiry" ON "automation_contact_controls" USING btree ("paused_until") WHERE "automation_contact_controls"."paused_until" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_automations_org_status" ON "automations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_automations_org_workspace" ON "automations" USING btree ("organization_id","workspace_id");--> statement-breakpoint
CREATE INDEX "idx_automations_template" ON "automations" USING btree ("created_from_template") WHERE "automations"."created_from_template" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_automations_graph_gin" ON "automations" USING gin ("graph");--> statement-breakpoint
ALTER TABLE "automation_bindings" DROP COLUMN "trigger_id";--> statement-breakpoint
ALTER TABLE "automation_bindings" DROP COLUMN "enabled";--> statement-breakpoint
ALTER TABLE "automation_bindings" DROP COLUMN "created_by";--> statement-breakpoint
ALTER TABLE "automation_contact_controls" DROP COLUMN "conversation_id";--> statement-breakpoint
ALTER TABLE "automation_contact_controls" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "automation_contact_controls" DROP COLUMN "reason";--> statement-breakpoint
ALTER TABLE "automation_contact_controls" DROP COLUMN "expires_at";--> statement-breakpoint
ALTER TABLE "automation_contact_controls" DROP COLUMN "created_by";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "entry_node_id";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "published_version";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "exit_on_reply";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "allow_reentry";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "reentry_cooldown_min";--> statement-breakpoint
DROP TYPE "public"."automation_contact_control_status";--> statement-breakpoint
DROP TYPE "public"."automation_enrollment_status";--> statement-breakpoint
DROP TYPE "public"."automation_node_type";--> statement-breakpoint
DROP TYPE "public"."automation_trigger_type";