-- automations
CREATE TABLE "automations" (
  "id"                         text PRIMARY KEY NOT NULL,
  "organization_id"            text NOT NULL REFERENCES "auth"."organization"("id") ON DELETE CASCADE,
  "workspace_id"               text REFERENCES "workspaces"("id") ON DELETE SET NULL,
  "name"                       text NOT NULL,
  "description"                text,
  "channel"                    "automation_channel" NOT NULL,
  "status"                     "automation_status" NOT NULL DEFAULT 'draft',
  "graph"                      jsonb NOT NULL DEFAULT '{"schema_version":1,"root_node_key":null,"nodes":[],"edges":[]}'::jsonb,
  "created_from_template"      text,
  "template_config"            jsonb,
  "total_enrolled"             integer NOT NULL DEFAULT 0,
  "total_completed"            integer NOT NULL DEFAULT 0,
  "total_exited"               integer NOT NULL DEFAULT 0,
  "total_failed"               integer NOT NULL DEFAULT 0,
  "last_validated_at"          timestamp with time zone,
  "validation_errors"          jsonb,
  "created_by"                 text REFERENCES "auth"."user"("id") ON DELETE SET NULL,
  "created_at"                 timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                 timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX "idx_automations_org_status"
  ON "automations" ("organization_id", "status");--> statement-breakpoint
CREATE INDEX "idx_automations_org_workspace"
  ON "automations" ("organization_id", "workspace_id");--> statement-breakpoint
CREATE INDEX "idx_automations_template"
  ON "automations" ("created_from_template")
  WHERE "created_from_template" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_automations_graph_gin"
  ON "automations" USING GIN ("graph" jsonb_path_ops);--> statement-breakpoint

-- automation_entrypoints
CREATE TABLE "automation_entrypoints" (
  "id"                         text PRIMARY KEY NOT NULL,
  "automation_id"              text NOT NULL REFERENCES "automations"("id") ON DELETE CASCADE,
  "channel"                    "automation_channel" NOT NULL,
  "kind"                       text NOT NULL,
  "status"                     text NOT NULL DEFAULT 'active',
  "social_account_id"          text REFERENCES "social_accounts"("id") ON DELETE SET NULL,
  "config"                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "filters"                    jsonb,
  "allow_reentry"              boolean NOT NULL DEFAULT true,
  "reentry_cooldown_min"       integer NOT NULL DEFAULT 60,
  "priority"                   integer NOT NULL DEFAULT 100,
  "specificity"                integer NOT NULL DEFAULT 0,
  "created_at"                 timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                 timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX "idx_automation_entrypoints_automation"
  ON "automation_entrypoints" ("automation_id");--> statement-breakpoint
CREATE INDEX "idx_automation_entrypoints_match"
  ON "automation_entrypoints" ("channel", "kind", "status");--> statement-breakpoint
CREATE INDEX "idx_automation_entrypoints_account_match"
  ON "automation_entrypoints" ("social_account_id", "kind", "status");--> statement-breakpoint

-- automation_bindings
CREATE TABLE "automation_bindings" (
  "id"                         text PRIMARY KEY NOT NULL,
  "organization_id"            text NOT NULL REFERENCES "auth"."organization"("id") ON DELETE CASCADE,
  "workspace_id"               text REFERENCES "workspaces"("id") ON DELETE SET NULL,
  "social_account_id"          text NOT NULL REFERENCES "social_accounts"("id") ON DELETE CASCADE,
  "channel"                    "automation_channel" NOT NULL,
  "binding_type"               "automation_binding_type" NOT NULL,
  "automation_id"              text NOT NULL REFERENCES "automations"("id") ON DELETE CASCADE,
  "config"                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status"                     text NOT NULL DEFAULT 'active',
  "last_synced_at"             timestamp with time zone,
  "sync_error"                 text,
  "created_at"                 timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                 timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "automation_bindings_social_account_binding_type_uniq" UNIQUE ("social_account_id", "binding_type")
);--> statement-breakpoint

CREATE INDEX "idx_automation_bindings_lookup"
  ON "automation_bindings" ("social_account_id", "binding_type", "status");--> statement-breakpoint
CREATE INDEX "idx_automation_bindings_automation"
  ON "automation_bindings" ("automation_id");--> statement-breakpoint

-- automation_runs
CREATE TABLE "automation_runs" (
  "id"                         text PRIMARY KEY NOT NULL,
  "automation_id"              text NOT NULL REFERENCES "automations"("id") ON DELETE CASCADE,
  "organization_id"            text NOT NULL REFERENCES "auth"."organization"("id") ON DELETE CASCADE,
  "entrypoint_id"              text REFERENCES "automation_entrypoints"("id") ON DELETE SET NULL,
  "binding_id"                 text REFERENCES "automation_bindings"("id") ON DELETE SET NULL,
  "contact_id"                 text NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "conversation_id"            text REFERENCES "inbox_conversations"("id") ON DELETE SET NULL,
  "status"                     "automation_run_status" NOT NULL DEFAULT 'active',
  "current_node_key"           text,
  "current_port_key"           text,
  "context"                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  "waiting_until"              timestamp with time zone,
  "waiting_for"                text,
  "exit_reason"                text,
  "started_at"                 timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at"               timestamp with time zone,
  "updated_at"                 timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX "idx_automation_runs_auto_status"
  ON "automation_runs" ("automation_id", "status");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_contact_auto"
  ON "automation_runs" ("contact_id", "automation_id");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_sweeper"
  ON "automation_runs" ("status", "waiting_until");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_org_started"
  ON "automation_runs" ("organization_id", "started_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automation_runs_active_uniq"
  ON "automation_runs" ("contact_id", "automation_id")
  WHERE "status" IN ('active', 'waiting');--> statement-breakpoint

-- automation_step_runs (PARTITIONED by executed_at monthly)
CREATE TABLE "automation_step_runs" (
  "id"                         bigserial,
  "run_id"                     text NOT NULL,
  "automation_id"              text NOT NULL,
  "node_key"                   text NOT NULL,
  "node_kind"                  text NOT NULL,
  "entered_via_port_key"       text,
  "exited_via_port_key"        text,
  "outcome"                    text NOT NULL,
  "duration_ms"                integer NOT NULL DEFAULT 0,
  "payload"                    jsonb,
  "error"                      jsonb,
  "executed_at"                timestamp with time zone NOT NULL,
  PRIMARY KEY ("id", "executed_at")
) PARTITION BY RANGE ("executed_at");--> statement-breakpoint

-- Initial partitions: April 2026 through July 2026 (4 months covering 2026-04-01 to 2026-08-01)
CREATE TABLE "automation_step_runs_2026_04"
  PARTITION OF "automation_step_runs"
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');--> statement-breakpoint
CREATE TABLE "automation_step_runs_2026_05"
  PARTITION OF "automation_step_runs"
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');--> statement-breakpoint
CREATE TABLE "automation_step_runs_2026_06"
  PARTITION OF "automation_step_runs"
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');--> statement-breakpoint
CREATE TABLE "automation_step_runs_2026_07"
  PARTITION OF "automation_step_runs"
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');--> statement-breakpoint

CREATE INDEX "idx_step_runs_run_time"
  ON "automation_step_runs" ("run_id", "executed_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_step_runs_auto_time"
  ON "automation_step_runs" ("automation_id", "executed_at");--> statement-breakpoint
CREATE INDEX "idx_step_runs_node_time"
  ON "automation_step_runs" ("node_key", "executed_at");--> statement-breakpoint
CREATE INDEX "idx_step_runs_executed_brin"
  ON "automation_step_runs" USING BRIN ("executed_at");--> statement-breakpoint

-- automation_scheduled_jobs
CREATE TABLE "automation_scheduled_jobs" (
  "id"                         text PRIMARY KEY NOT NULL,
  "run_id"                     text REFERENCES "automation_runs"("id") ON DELETE CASCADE,
  "job_type"                   text NOT NULL,
  "automation_id"              text REFERENCES "automations"("id") ON DELETE CASCADE,
  "entrypoint_id"              text REFERENCES "automation_entrypoints"("id") ON DELETE CASCADE,
  "run_at"                     timestamp with time zone NOT NULL,
  "status"                     text NOT NULL DEFAULT 'pending',
  "attempts"                   integer NOT NULL DEFAULT 0,
  "claimed_at"                 timestamp with time zone,
  "payload"                    jsonb,
  "error"                      text,
  "created_at"                 timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX "idx_scheduled_jobs_sweep"
  ON "automation_scheduled_jobs" ("status", "run_at");--> statement-breakpoint
CREATE INDEX "idx_scheduled_jobs_run"
  ON "automation_scheduled_jobs" ("run_id");--> statement-breakpoint

-- automation_contact_controls
CREATE TABLE "automation_contact_controls" (
  "id"                         text PRIMARY KEY NOT NULL,
  "organization_id"            text NOT NULL REFERENCES "auth"."organization"("id") ON DELETE CASCADE,
  "contact_id"                 text NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "automation_id"              text REFERENCES "automations"("id") ON DELETE CASCADE,
  "pause_reason"               text,
  "paused_until"               timestamp with time zone,
  "paused_by_user_id"          text REFERENCES "auth"."user"("id") ON DELETE SET NULL,
  "created_at"                 timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                 timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX "idx_contact_controls_per_auto"
  ON "automation_contact_controls" ("contact_id", "automation_id")
  WHERE "automation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_contact_controls_global"
  ON "automation_contact_controls" ("contact_id")
  WHERE "automation_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_contact_controls_contact"
  ON "automation_contact_controls" ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_contact_controls_expiry"
  ON "automation_contact_controls" ("paused_until")
  WHERE "paused_until" IS NOT NULL;
