# Automation Rebuild — Plan 1: Foundation (DB + Runtime + API + SDK)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md`

**Goal:** Ship a headless, end-to-end-runnable automation system on the new port-based schema with full API + SDK coverage. No UI work in this plan.

**Architecture:** Single `graph` JSONB column on `automations`; node handler registry; port-based edge traversal; ordered action group with per-action error handling; monthly-partitioned `step_runs`; HMAC-verified webhook entrypoints; preserved trigger-matching algorithm rewired to new tables.

**Tech Stack:** Hono + `@hono/zod-openapi`, Drizzle ORM, Zod, TypeScript, PostgreSQL (via Hyperdrive), Cloudflare Workers, Bun, R2 (media), KV (account cache), Queues.

**Git policy (project-specific):** User handles all git operations. Each task ends with a `**STOP — user commits at their discretion**` marker. Continue to the next task without waiting.

---

## File Structure

### New files

```
packages/db/src/schema.ts                                        -- add new automation tables
packages/db/drizzle/0030_drop_legacy_automations.sql             -- DROP migration
packages/db/drizzle/0031_automation_rebuild.sql                  -- CREATE new schema

apps/api/src/schemas/automations.ts                              -- replace existing
apps/api/src/schemas/automation-graph.ts                         -- graph JSON schemas
apps/api/src/schemas/automation-entrypoints.ts                   -- entrypoint-kind configs
apps/api/src/schemas/automation-bindings.ts                      -- binding-type configs
apps/api/src/schemas/automation-actions.ts                       -- action-type configs

apps/api/src/services/automations/ports.ts                       -- derivePorts per kind
apps/api/src/services/automations/validator.ts                   -- graph integrity validator
apps/api/src/services/automations/runner.ts                      -- replace existing
apps/api/src/services/automations/scheduler.ts                   -- replace existing
apps/api/src/services/automations/simulator.ts                   -- replace existing
apps/api/src/services/automations/manifest.ts                    -- replace existing (node handler registry)
apps/api/src/services/automations/action-dispatcher.ts           -- action registry
apps/api/src/services/automations/trigger-matcher.ts             -- rewrite (preserve algorithm)
apps/api/src/services/automations/binding-router.ts              -- default_reply / welcome_message fallback
apps/api/src/services/automations/webhook-receiver.ts            -- HMAC + contact lookup for webhook_inbound
apps/api/src/services/automations/templates/index.ts             -- buildGraphFromTemplate dispatcher
apps/api/src/services/automations/templates/blank.ts             -- blank scaffold
apps/api/src/services/automations/templates/comment-to-dm.ts
apps/api/src/services/automations/templates/story-leads.ts
apps/api/src/services/automations/templates/follower-growth.ts
apps/api/src/services/automations/templates/follow-to-dm.ts
apps/api/src/services/automations/templates/welcome-flow.ts
apps/api/src/services/automations/templates/faq-bot.ts
apps/api/src/services/automations/templates/lead-capture.ts

apps/api/src/services/automations/nodes/message.ts               -- composite message handler
apps/api/src/services/automations/nodes/input.ts
apps/api/src/services/automations/nodes/delay.ts
apps/api/src/services/automations/nodes/condition.ts
apps/api/src/services/automations/nodes/randomizer.ts
apps/api/src/services/automations/nodes/action-group.ts
apps/api/src/services/automations/nodes/http-request.ts
apps/api/src/services/automations/nodes/start-automation.ts
apps/api/src/services/automations/nodes/goto.ts
apps/api/src/services/automations/nodes/end.ts

apps/api/src/services/automations/actions/                       -- action handlers (one file per type)
  tag.ts               -- tag_add, tag_remove
  field.ts             -- field_set, field_clear
  segment.ts           -- segment_add, segment_remove
  subscription.ts      -- subscribe_list, unsubscribe_list, opt_in_channel, opt_out_channel
  conversation.ts      -- assign_conversation, unassign_conversation, conversation_open, conversation_close, conversation_snooze
  notify.ts            -- notify_admin
  webhook.ts           -- webhook_out
  automation-controls.ts  -- pause_automations_for_contact, resume_automations_for_contact
  contact.ts           -- delete_contact
  conversion.ts        -- log_conversion_event
  index.ts             -- action registry export

apps/api/src/services/automations/platforms/                     -- preserved but rewritten adapters
  instagram.ts
  facebook.ts
  whatsapp.ts
  telegram.ts
  tiktok.ts
  index.ts             -- dispatch by channel

apps/api/src/routes/automations.ts                               -- replace
apps/api/src/routes/automation-entrypoints.ts                    -- new file
apps/api/src/routes/automation-bindings.ts                       -- new file
apps/api/src/routes/automation-runs.ts                           -- new file
apps/api/src/routes/contact-automation-controls.ts               -- new file
apps/api/src/routes/automation-webhook-trigger.ts                -- new public webhook endpoint

apps/api/src/__tests__/automations-foundation.test.ts            -- replace
apps/api/src/__tests__/automation-ports.test.ts
apps/api/src/__tests__/automation-validator.test.ts
apps/api/src/__tests__/automation-runner.test.ts
apps/api/src/__tests__/automation-entrypoints.test.ts
apps/api/src/__tests__/automation-bindings.test.ts
apps/api/src/__tests__/automation-webhook-trigger.test.ts
apps/api/src/__tests__/automation-templates.test.ts

packages/sdk/src/resources/automations.ts                        -- rewrite
packages/sdk/src/resources/automation-entrypoints.ts             -- new
packages/sdk/src/resources/automation-bindings.ts                -- new
packages/sdk/src/resources/automation-runs.ts                    -- new
packages/sdk/src/resources/contact-automation-controls.ts        -- new
```

### Deleted files

```
apps/api/src/services/automations/nodes/ai-agent.ts
apps/api/src/services/automations/nodes/ai-intent-router.ts
apps/api/src/services/automations/nodes/ai-runtime.ts
apps/api/src/services/automations/nodes/ai-step.ts
apps/api/src/services/automations/nodes/condition.ts             (rewritten under same name)
apps/api/src/services/automations/nodes/conversation-assign.ts
apps/api/src/services/automations/nodes/conversation-status.ts
apps/api/src/services/automations/nodes/end.ts                   (rewritten)
apps/api/src/services/automations/nodes/field-actions.ts
apps/api/src/services/automations/nodes/goto.ts                  (rewritten)
apps/api/src/services/automations/nodes/http-request.ts          (rewritten)
apps/api/src/services/automations/nodes/interactive-wait.ts
apps/api/src/services/automations/nodes/message-media.ts         (absorbed into message.ts)
apps/api/src/services/automations/nodes/message-text.ts          (absorbed into message.ts)
apps/api/src/services/automations/nodes/notify-admin.ts          (absorbed into actions/notify.ts)
apps/api/src/services/automations/nodes/platforms/*.ts           (replaced by platforms/ adapter)
apps/api/src/services/automations/nodes/randomizer.ts            (rewritten)
apps/api/src/services/automations/nodes/segment-actions.ts       (absorbed into actions/segment.ts)
apps/api/src/services/automations/nodes/send-text.ts             (absorbed into message.ts)
apps/api/src/services/automations/nodes/smart-delay.ts           (replaced by nodes/delay.ts)
apps/api/src/services/automations/nodes/split-test.ts            (merged into randomizer.ts)
apps/api/src/services/automations/nodes/subflow-call.ts          (replaced by start-automation.ts)
apps/api/src/services/automations/nodes/subscription-actions.ts  (absorbed into actions/subscription.ts)
apps/api/src/services/automations/nodes/tag-actions.ts           (absorbed into actions/tag.ts)
apps/api/src/services/automations/nodes/trigger.ts               (no longer needed; triggers live in entrypoints)
apps/api/src/services/automations/nodes/user-input.ts            (replaced by nodes/input.ts)
apps/api/src/services/automations/nodes/user-input-validation.ts (inlined in input.ts)
apps/api/src/services/automations/nodes/webhook-out.ts           (absorbed into actions/webhook.ts)
apps/api/src/services/automations/contact-channel.ts             (rewritten inline in platforms/)
apps/api/src/services/automations/resolve-templated-value.ts     (inlined in merge-tags.ts usage)
apps/api/src/services/automations/resolve-trigger.ts             (replaced by trigger-matcher)
apps/api/src/services/automations/template-builders.ts           (replaced by templates/)
apps/api/src/routes/automation-templates.ts                      (templates now live under /automations create body)
```

### Preserved files (no changes or minimal)

```
apps/api/src/services/automations/merge-tags.ts                  -- preserved
apps/api/src/services/automations/filter-eval.ts                 -- preserved
apps/api/src/services/automations/types.ts                       -- replace contents (new run/port/node types)
apps/api/src/services/automations/bindings.ts                    -- rename helpers into binding-router.ts, then delete
apps/api/src/routes/platform-webhooks.ts                         -- preserved; only adjusts enqueue payload shape
apps/api/src/services/inbox-event-processor.ts                   -- light modification (reads new run table)
```

---

## Task List

### Phase A — Teardown & Schema

- [ ] **Task A1: Archive obsolete AI modules**

**Files:**
- Create dir: `apps/api/src/services/automations/.archive/`
- Move: `apps/api/src/services/automations/nodes/ai-agent.ts` → `.archive/ai-agent.ts`
- Move: `apps/api/src/services/automations/nodes/ai-intent-router.ts` → `.archive/ai-intent-router.ts`
- Move: `apps/api/src/services/automations/nodes/ai-runtime.ts` → `.archive/ai-runtime.ts`
- Move: `apps/api/src/services/automations/nodes/ai-step.ts` → `.archive/ai-step.ts`

**Steps:**
- [ ] Create `.archive/` directory
- [ ] Move all four AI node files into it (use `mv`)
- [ ] Run `bun run typecheck:api`. Expect failures in `manifest.ts` and other files referencing the archived modules. That's fine — they'll be resolved when manifest.ts is rewritten in Task C3.
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task A2: Write migration to drop legacy automation tables**

**Files:**
- Create: `packages/db/drizzle/0030_drop_legacy_automations.sql`

**Migration SQL:**

```sql
-- Drop legacy automation tables (13) and enums (7)
DROP TABLE IF EXISTS "automation_scheduled_ticks" CASCADE;
DROP TABLE IF EXISTS "automation_run_logs" CASCADE;
DROP TABLE IF EXISTS "automation_contact_controls" CASCADE;
DROP TABLE IF EXISTS "automation_bindings" CASCADE;
DROP TABLE IF EXISTS "automation_enrollments" CASCADE;
DROP TABLE IF EXISTS "automation_edges" CASCADE;
DROP TABLE IF EXISTS "automation_nodes" CASCADE;
DROP TABLE IF EXISTS "automation_versions" CASCADE;
DROP TABLE IF EXISTS "automation_triggers" CASCADE;
DROP TABLE IF EXISTS "automations" CASCADE;

-- Drop enums (IF EXISTS is enum-safe via DROP TYPE)
DROP TYPE IF EXISTS "automation_trigger_type" CASCADE;
DROP TYPE IF EXISTS "automation_node_type" CASCADE;
DROP TYPE IF EXISTS "automation_status" CASCADE;
DROP TYPE IF EXISTS "automation_enrollment_status" CASCADE;
DROP TYPE IF EXISTS "automation_binding_type" CASCADE;
DROP TYPE IF EXISTS "automation_contact_control_status" CASCADE;
DROP TYPE IF EXISTS "automation_channel" CASCADE;
```

**Steps:**
- [ ] Write the SQL file above
- [ ] Update `packages/db/drizzle/meta/_journal.json` to register migration `0030`
- [ ] Run `bun run db:migrate`. Expect success: all old tables/enums dropped
- [ ] Verify via psql or a quick script: `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'automation%'` returns nothing (except possibly `automation_experiences` if it existed — drop that too if so)
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task A3: Create new automation enums migration**

**Files:**
- Create: `packages/db/drizzle/0031_automation_enums.sql`

**SQL:**

```sql
CREATE TYPE "automation_status" AS ENUM ('draft', 'active', 'paused', 'archived');
CREATE TYPE "automation_channel" AS ENUM ('instagram', 'facebook', 'whatsapp', 'telegram', 'tiktok');
CREATE TYPE "automation_binding_type" AS ENUM (
  'default_reply',
  'welcome_message',
  'conversation_starter',
  'main_menu',
  'ice_breaker'
);
CREATE TYPE "automation_run_status" AS ENUM ('active', 'waiting', 'completed', 'exited', 'failed');
```

**Steps:**
- [ ] Write the SQL file
- [ ] Update `_journal.json` to register migration `0031`
- [ ] Run `bun run db:migrate`. Expect success
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task A4: Create new automation tables migration**

**Files:**
- Create: `packages/db/drizzle/0032_automation_tables.sql`

**SQL (full):**

```sql
-- automations
CREATE TABLE "automations" (
  "id"                         text PRIMARY KEY,
  "organization_id"            text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "workspace_id"               text REFERENCES "workspaces"("id") ON DELETE SET NULL,
  "name"                       text NOT NULL,
  "description"                text,
  "channel"                    automation_channel NOT NULL,
  "status"                     automation_status NOT NULL DEFAULT 'draft',
  "graph"                      jsonb NOT NULL DEFAULT '{"schema_version":1,"root_node_key":null,"nodes":[],"edges":[]}'::jsonb,
  "created_from_template"      text,
  "template_config"            jsonb,
  "total_enrolled"             integer NOT NULL DEFAULT 0,
  "total_completed"            integer NOT NULL DEFAULT 0,
  "total_exited"               integer NOT NULL DEFAULT 0,
  "total_failed"               integer NOT NULL DEFAULT 0,
  "last_validated_at"          timestamptz,
  "validation_errors"          jsonb,
  "created_by"                 text REFERENCES "auth"."user"("id") ON DELETE SET NULL,
  "created_at"                 timestamptz NOT NULL DEFAULT now(),
  "updated_at"                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "idx_automations_org_status"
  ON "automations" ("organization_id", "status");
CREATE INDEX "idx_automations_org_workspace"
  ON "automations" ("organization_id", "workspace_id");
CREATE INDEX "idx_automations_template"
  ON "automations" ("created_from_template")
  WHERE "created_from_template" IS NOT NULL;
CREATE INDEX "idx_automations_graph_gin"
  ON "automations" USING GIN ("graph" jsonb_path_ops);

-- automation_entrypoints
CREATE TABLE "automation_entrypoints" (
  "id"                         text PRIMARY KEY,
  "automation_id"              text NOT NULL REFERENCES "automations"("id") ON DELETE CASCADE,
  "channel"                    automation_channel NOT NULL,
  "kind"                       text NOT NULL,
  "status"                     text NOT NULL DEFAULT 'active',
  "social_account_id"          text REFERENCES "social_accounts"("id") ON DELETE SET NULL,
  "config"                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "filters"                    jsonb,
  "allow_reentry"              boolean NOT NULL DEFAULT true,
  "reentry_cooldown_min"       integer NOT NULL DEFAULT 60,
  "priority"                   integer NOT NULL DEFAULT 100,
  "specificity"                integer NOT NULL DEFAULT 0,
  "created_at"                 timestamptz NOT NULL DEFAULT now(),
  "updated_at"                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "idx_automation_entrypoints_automation"
  ON "automation_entrypoints" ("automation_id");
CREATE INDEX "idx_automation_entrypoints_match"
  ON "automation_entrypoints" ("channel", "kind", "status");
CREATE INDEX "idx_automation_entrypoints_account_match"
  ON "automation_entrypoints" ("social_account_id", "kind", "status");

-- automation_bindings
CREATE TABLE "automation_bindings" (
  "id"                         text PRIMARY KEY,
  "organization_id"            text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "workspace_id"               text REFERENCES "workspaces"("id") ON DELETE SET NULL,
  "social_account_id"          text NOT NULL REFERENCES "social_accounts"("id") ON DELETE CASCADE,
  "channel"                    automation_channel NOT NULL,
  "binding_type"               automation_binding_type NOT NULL,
  "automation_id"              text NOT NULL REFERENCES "automations"("id") ON DELETE CASCADE,
  "config"                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status"                     text NOT NULL DEFAULT 'active',
  "last_synced_at"             timestamptz,
  "sync_error"                 text,
  "created_at"                 timestamptz NOT NULL DEFAULT now(),
  "updated_at"                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("social_account_id", "binding_type")
);

CREATE INDEX "idx_automation_bindings_lookup"
  ON "automation_bindings" ("social_account_id", "binding_type", "status");
CREATE INDEX "idx_automation_bindings_automation"
  ON "automation_bindings" ("automation_id");

-- automation_runs
CREATE TABLE "automation_runs" (
  "id"                         text PRIMARY KEY,
  "automation_id"              text NOT NULL REFERENCES "automations"("id") ON DELETE CASCADE,
  "organization_id"            text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "entrypoint_id"              text REFERENCES "automation_entrypoints"("id") ON DELETE SET NULL,
  "binding_id"                 text REFERENCES "automation_bindings"("id") ON DELETE SET NULL,
  "contact_id"                 text NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "conversation_id"            text REFERENCES "conversations"("id") ON DELETE SET NULL,
  "status"                     automation_run_status NOT NULL DEFAULT 'active',
  "current_node_key"           text,
  "current_port_key"           text,
  "context"                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  "waiting_until"              timestamptz,
  "waiting_for"                text,
  "exit_reason"                text,
  "started_at"                 timestamptz NOT NULL DEFAULT now(),
  "completed_at"               timestamptz,
  "updated_at"                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "idx_automation_runs_auto_status"
  ON "automation_runs" ("automation_id", "status");
CREATE INDEX "idx_automation_runs_contact_auto"
  ON "automation_runs" ("contact_id", "automation_id");
CREATE INDEX "idx_automation_runs_sweeper"
  ON "automation_runs" ("status", "waiting_until");
CREATE INDEX "idx_automation_runs_org_started"
  ON "automation_runs" ("organization_id", "started_at" DESC);
CREATE UNIQUE INDEX "idx_automation_runs_active_uniq"
  ON "automation_runs" ("contact_id", "automation_id")
  WHERE "status" IN ('active', 'waiting');

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
  "executed_at"                timestamptz NOT NULL,
  PRIMARY KEY ("id", "executed_at")
) PARTITION BY RANGE ("executed_at");

-- Initial partitions: current month + next 3 months
CREATE TABLE "automation_step_runs_2026_04"
  PARTITION OF "automation_step_runs"
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "automation_step_runs_2026_05"
  PARTITION OF "automation_step_runs"
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "automation_step_runs_2026_06"
  PARTITION OF "automation_step_runs"
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "automation_step_runs_2026_07"
  PARTITION OF "automation_step_runs"
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE INDEX "idx_step_runs_run_time"
  ON "automation_step_runs" ("run_id", "executed_at" DESC);
CREATE INDEX "idx_step_runs_auto_time"
  ON "automation_step_runs" ("automation_id", "executed_at");
CREATE INDEX "idx_step_runs_node_time"
  ON "automation_step_runs" ("node_key", "executed_at");
CREATE INDEX "idx_step_runs_executed_brin"
  ON "automation_step_runs" USING BRIN ("executed_at");

-- automation_scheduled_jobs
CREATE TABLE "automation_scheduled_jobs" (
  "id"                         text PRIMARY KEY,
  "run_id"                     text REFERENCES "automation_runs"("id") ON DELETE CASCADE,
  "job_type"                   text NOT NULL,
  "automation_id"              text REFERENCES "automations"("id") ON DELETE CASCADE,
  "entrypoint_id"              text REFERENCES "automation_entrypoints"("id") ON DELETE CASCADE,
  "run_at"                     timestamptz NOT NULL,
  "status"                     text NOT NULL DEFAULT 'pending',
  "attempts"                   integer NOT NULL DEFAULT 0,
  "claimed_at"                 timestamptz,
  "payload"                    jsonb,
  "error"                      text,
  "created_at"                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "idx_scheduled_jobs_sweep"
  ON "automation_scheduled_jobs" ("status", "run_at");
CREATE INDEX "idx_scheduled_jobs_run"
  ON "automation_scheduled_jobs" ("run_id");

-- automation_contact_controls
CREATE TABLE "automation_contact_controls" (
  "id"                         text PRIMARY KEY,
  "organization_id"            text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "contact_id"                 text NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "automation_id"              text REFERENCES "automations"("id") ON DELETE CASCADE,
  "pause_reason"               text,
  "paused_until"               timestamptz,
  "paused_by_user_id"          text REFERENCES "auth"."user"("id") ON DELETE SET NULL,
  "created_at"                 timestamptz NOT NULL DEFAULT now(),
  "updated_at"                 timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "idx_contact_controls_per_auto"
  ON "automation_contact_controls" ("contact_id", "automation_id")
  WHERE "automation_id" IS NOT NULL;
CREATE UNIQUE INDEX "idx_contact_controls_global"
  ON "automation_contact_controls" ("contact_id")
  WHERE "automation_id" IS NULL;
CREATE INDEX "idx_contact_controls_contact"
  ON "automation_contact_controls" ("contact_id");
CREATE INDEX "idx_contact_controls_expiry"
  ON "automation_contact_controls" ("paused_until")
  WHERE "paused_until" IS NOT NULL;
```

**Steps:**
- [ ] Write the SQL file exactly as above (the timestamps in initial partitions use 2026 dates — update to current month + 3 ahead if different when the task runs)
- [ ] Update `_journal.json` to register migration `0032`
- [ ] Run `bun run db:migrate`. Verify success
- [ ] Open psql and run `\d automations`, `\d automation_runs`, `\d+ automation_step_runs` to verify the tables and partitions exist
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task A5: Update Drizzle schema with new automation tables**

**Files:**
- Modify: `packages/db/src/schema.ts` (remove all current automation-related exports; add new ones)

**Guidance for the executing subagent:**

Remove all current automation-related table definitions and enums from `packages/db/src/schema.ts` (the `automationX*` tables and enums).

Add new exports. Shape per spec section 4.4. Example for `automations`:

```ts
export const automationStatusEnum = pgEnum("automation_status", [
  "draft", "active", "paused", "archived",
]);
export const automationChannelEnum = pgEnum("automation_channel", [
  "instagram", "facebook", "whatsapp", "telegram", "tiktok",
]);
export const automationBindingTypeEnum = pgEnum("automation_binding_type", [
  "default_reply", "welcome_message", "conversation_starter", "main_menu", "ice_breaker",
]);
export const automationRunStatusEnum = pgEnum("automation_run_status", [
  "active", "waiting", "completed", "exited", "failed",
]);

export const automations = pgTable("automations", {
  id: text("id").primaryKey().$defaultFn(() => generateId("auto_")),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  channel: automationChannelEnum("channel").notNull(),
  status: automationStatusEnum("status").notNull().default("draft"),
  graph: jsonb("graph").notNull().default(sql`'{"schema_version":1,"root_node_key":null,"nodes":[],"edges":[]}'::jsonb`),
  createdFromTemplate: text("created_from_template"),
  templateConfig: jsonb("template_config"),
  totalEnrolled: integer("total_enrolled").notNull().default(0),
  totalCompleted: integer("total_completed").notNull().default(0),
  totalExited: integer("total_exited").notNull().default(0),
  totalFailed: integer("total_failed").notNull().default(0),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  validationErrors: jsonb("validation_errors"),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgStatusIdx: index("idx_automations_org_status").on(t.organizationId, t.status),
  orgWorkspaceIdx: index("idx_automations_org_workspace").on(t.organizationId, t.workspaceId),
}));
```

Repeat for `automationEntrypoints`, `automationBindings`, `automationRuns`, `automationStepRuns`, `automationScheduledJobs`, `automationContactControls` following the SQL schemas in Task A4.

**Note on `automationStepRuns`**: Drizzle doesn't natively represent partitioned tables, but the partition is transparent to queries. Declare the parent table normally.

**Steps:**
- [ ] Read current `packages/db/src/schema.ts`
- [ ] Delete all lines related to legacy automation tables / enums
- [ ] Add new enum exports (4 enums)
- [ ] Add new table exports (7 tables)
- [ ] Run `bun run typecheck:api`. Expect failures elsewhere in the codebase where old schema symbols are imported — these are known and will be fixed as we rewrite downstream files
- [ ] Run `bun run db:generate`. Verify no Drizzle-introspection drift versus our handwritten migrations
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task A6: Remove legacy automation Zod schema + wire in new one (stub)**

**Files:**
- Replace entirely: `apps/api/src/schemas/automations.ts` (stub with empty exports for now; fill in Phase B)

**New skeleton:**

```ts
// apps/api/src/schemas/automations.ts
import { z } from "@hono/zod-openapi";

// Temporary stubs; populated by Tasks B1-B4
export const AutomationGraphSchema = z.object({}).passthrough();
export const AutomationCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  channel: z.enum(["instagram", "facebook", "whatsapp", "telegram", "tiktok"]),
  workspace_id: z.string().optional(),
  template: z.object({ kind: z.string(), config: z.record(z.any()) }).optional(),
});
export const AutomationResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  channel: z.string(),
  status: z.string(),
  // ...full shape filled in B5
}).passthrough();
```

**Steps:**
- [ ] Replace the file contents with the stub above
- [ ] Run `bun run typecheck:api`. Still expected to fail in other places — this is a skeleton
- [ ] **STOP — user commits at their discretion**

---

### Phase B — Zod schemas, Ports, Validator

- [ ] **Task B1: Graph Zod schema**

**Files:**
- Create: `apps/api/src/schemas/automation-graph.ts`
- Create: `apps/api/src/__tests__/automation-graph-schema.test.ts`

**Full schema (`automation-graph.ts`):**

```ts
import { z } from "@hono/zod-openapi";

export const PortDirectionSchema = z.enum(["input", "output"]);

export const PortSchema = z.object({
  key: z.string(),
  direction: PortDirectionSchema,
  role: z.string().optional(),         // default / success / error / branch / interactive / timeout / invalid / skip
  label: z.string().optional(),
});

// Block types (inside message.config.blocks)
export const BlockButtonSchema = z.object({
  id: z.string(),
  type: z.enum(["branch", "url", "call", "share"]),
  label: z.string().max(80),
  url: z.string().url().optional(),
  phone: z.string().optional(),
});

export const TextBlockSchema = z.object({
  id: z.string(),
  type: z.literal("text"),
  text: z.string(),
  buttons: z.array(BlockButtonSchema).max(3).optional(),
});

export const ImageBlockSchema = z.object({
  id: z.string(),
  type: z.literal("image"),
  media_ref: z.string(),
  caption: z.string().optional(),
});

export const VideoBlockSchema = z.object({
  id: z.string(),
  type: z.literal("video"),
  media_ref: z.string(),
  caption: z.string().optional(),
});

export const AudioBlockSchema = z.object({
  id: z.string(),
  type: z.literal("audio"),
  media_ref: z.string(),
});

export const FileBlockSchema = z.object({
  id: z.string(),
  type: z.literal("file"),
  media_ref: z.string(),
});

export const CardBlockSchema = z.object({
  id: z.string(),
  type: z.literal("card"),
  media_ref: z.string().optional(),
  title: z.string().max(80),
  subtitle: z.string().max(80).optional(),
  buttons: z.array(BlockButtonSchema).max(3).optional(),
});

export const GalleryBlockSchema = z.object({
  id: z.string(),
  type: z.literal("gallery"),
  cards: z.array(CardBlockSchema).min(1).max(10),
});

export const DelayBlockSchema = z.object({
  id: z.string(),
  type: z.literal("delay"),
  seconds: z.number().min(0.5).max(10),
});

export const MessageBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ImageBlockSchema,
  VideoBlockSchema,
  AudioBlockSchema,
  FileBlockSchema,
  CardBlockSchema,
  GalleryBlockSchema,
  DelayBlockSchema,
]);

export const QuickReplySchema = z.object({
  id: z.string(),
  label: z.string().max(20),
  icon: z.string().optional(),
});

// Per-kind config schemas (imported at dispatch; use z.any() at the base level)
export const NodeBaseSchema = z.object({
  key: z.string().min(1),
  kind: z.string(),
  title: z.string().optional(),
  canvas_x: z.number().optional(),
  canvas_y: z.number().optional(),
  config: z.record(z.any()).default({}),
  ports: z.array(PortSchema).default([]),
  ui_state: z.record(z.any()).optional(),
});

export const EdgeSchema = z.object({
  from_node: z.string(),
  from_port: z.string(),
  to_node: z.string(),
  to_port: z.string(),
  order_index: z.number().optional(),
  metadata: z.record(z.any()).optional(),
});

export const GraphSchema = z.object({
  schema_version: z.literal(1),
  root_node_key: z.string().nullable(),
  nodes: z.array(NodeBaseSchema),
  edges: z.array(EdgeSchema),
});

export type Graph = z.infer<typeof GraphSchema>;
export type GraphNode = z.infer<typeof NodeBaseSchema>;
export type GraphEdge = z.infer<typeof EdgeSchema>;
export type Port = z.infer<typeof PortSchema>;
export type MessageBlock = z.infer<typeof MessageBlockSchema>;
export type QuickReply = z.infer<typeof QuickReplySchema>;
```

**Test file — happy path + schema failures:**

```ts
// apps/api/src/__tests__/automation-graph-schema.test.ts
import { describe, expect, test } from "bun:test";
import { GraphSchema, MessageBlockSchema } from "../schemas/automation-graph";

describe("GraphSchema", () => {
  test("accepts a minimal valid graph", () => {
    const g = {
      schema_version: 1,
      root_node_key: "n1",
      nodes: [{ key: "n1", kind: "end", config: {}, ports: [] }],
      edges: [],
    };
    expect(() => GraphSchema.parse(g)).not.toThrow();
  });

  test("rejects schema_version != 1", () => {
    expect(() => GraphSchema.parse({ schema_version: 2, root_node_key: null, nodes: [], edges: [] }))
      .toThrow();
  });

  test("accepts multiple edges", () => {
    const g = {
      schema_version: 1,
      root_node_key: "a",
      nodes: [
        { key: "a", kind: "message", config: {}, ports: [] },
        { key: "b", kind: "end", config: {}, ports: [] },
      ],
      edges: [{ from_node: "a", from_port: "next", to_node: "b", to_port: "in" }],
    };
    expect(() => GraphSchema.parse(g)).not.toThrow();
  });
});

describe("MessageBlockSchema", () => {
  test("accepts a text block with buttons", () => {
    const b = {
      id: "blk_1",
      type: "text",
      text: "Hi",
      buttons: [{ id: "btn_a", type: "branch", label: "A" }],
    };
    expect(() => MessageBlockSchema.parse(b)).not.toThrow();
  });

  test("rejects >3 buttons", () => {
    const b = {
      id: "blk_1",
      type: "text",
      text: "Hi",
      buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, type: "branch", label: `L${i}` })),
    };
    expect(() => MessageBlockSchema.parse(b)).toThrow();
  });

  test("rejects gallery with >10 cards", () => {
    const b = {
      id: "gal",
      type: "gallery",
      cards: Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, type: "card", title: "t" })),
    };
    expect(() => MessageBlockSchema.parse(b)).toThrow();
  });
});
```

**Steps:**
- [ ] Write the schema file
- [ ] Write the test file
- [ ] Run `bun test apps/api/src/__tests__/automation-graph-schema.test.ts`. Expect all tests pass
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task B2: Entrypoint config Zod schemas**

**Files:**
- Create: `apps/api/src/schemas/automation-entrypoints.ts`

**Full schema:**

```ts
import { z } from "@hono/zod-openapi";

// Per-kind configs
export const KeywordEntrypointConfig = z.object({
  keywords: z.array(z.string()).min(1),
  match_mode: z.enum(["exact", "contains", "regex"]).default("contains"),
  case_sensitive: z.boolean().default(false),
});

export const CommentCreatedEntrypointConfig = z.object({
  post_ids: z.array(z.string()).nullable().default(null),
  keyword_filter: z.array(z.string()).optional(),
  include_replies: z.boolean().default(true),
});

export const StoryReplyEntrypointConfig = z.object({
  story_ids: z.array(z.string()).nullable().default(null),
  keyword_filter: z.array(z.string()).optional(),
});

export const ScheduleEntrypointConfig = z.object({
  cron: z.string(),
  timezone: z.string().default("UTC"),
});

export const FieldChangedEntrypointConfig = z.object({
  field: z.string(),
  from: z.any().optional(),
  to: z.any().optional(),
});

export const TagEntrypointConfig = z.object({
  tag: z.string(),
});

export const RefLinkEntrypointConfig = z.object({
  ref_url_id: z.string(),
});

export const WebhookInboundEntrypointConfig = z.object({
  webhook_slug: z.string(),
  webhook_secret: z.string(),
  contact_lookup: z.object({
    by: z.enum(["email", "phone", "platform_id", "custom_field", "contact_id"]),
    field_path: z.string(),
    custom_field_key: z.string().optional(),
    auto_create_contact: z.boolean().default(false),
  }),
  payload_mapping: z.record(z.string()).optional(),
});

export const AdClickEntrypointConfig = z.object({
  ad_ids: z.array(z.string()).nullable().default(null),
});

export const ConversionEventEntrypointConfig = z.object({
  event_name: z.string(),
});

// Empty config kinds
export const EmptyEntrypointConfig = z.object({}).passthrough();

// Registry
export const EntrypointConfigByKind: Record<string, z.ZodSchema> = {
  dm_received: EmptyEntrypointConfig,
  keyword: KeywordEntrypointConfig,
  comment_created: CommentCreatedEntrypointConfig,
  story_reply: StoryReplyEntrypointConfig,
  story_mention: EmptyEntrypointConfig,
  live_comment: EmptyEntrypointConfig,
  ad_click: AdClickEntrypointConfig,
  ref_link_click: RefLinkEntrypointConfig,
  share_to_dm: EmptyEntrypointConfig,
  follow: EmptyEntrypointConfig,
  schedule: ScheduleEntrypointConfig,
  field_changed: FieldChangedEntrypointConfig,
  tag_applied: TagEntrypointConfig,
  tag_removed: TagEntrypointConfig,
  conversion_event: ConversionEventEntrypointConfig,
  webhook_inbound: WebhookInboundEntrypointConfig,
};

export const EntrypointKindSchema = z.enum([
  "dm_received", "keyword", "comment_created", "story_reply", "story_mention",
  "live_comment", "ad_click", "ref_link_click", "share_to_dm", "follow",
  "schedule", "field_changed", "tag_applied", "tag_removed", "conversion_event",
  "webhook_inbound",
]);

export type EntrypointKind = z.infer<typeof EntrypointKindSchema>;

export const EntrypointCreateSchema = z.object({
  channel: z.enum(["instagram", "facebook", "whatsapp", "telegram", "tiktok"]),
  kind: EntrypointKindSchema,
  social_account_id: z.string().optional(),
  config: z.record(z.any()).default({}),
  filters: z.record(z.any()).optional(),
  allow_reentry: z.boolean().default(true),
  reentry_cooldown_min: z.number().min(0).default(60),
  priority: z.number().default(100),
});

export const EntrypointUpdateSchema = EntrypointCreateSchema.partial().extend({
  status: z.enum(["active", "paused"]).optional(),
});

export function validateEntrypointConfig(kind: string, config: unknown): z.SafeParseReturnType<any, any> {
  const schema = EntrypointConfigByKind[kind];
  if (!schema) return { success: false, error: new z.ZodError([{ code: "custom", path: ["kind"], message: `unknown kind ${kind}` }]) } as any;
  return schema.safeParse(config);
}
```

**Steps:**
- [ ] Write the schema file
- [ ] Run `bun run typecheck:api`. Expect no errors in this file itself
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task B3: Action-type Zod schemas**

**Files:**
- Create: `apps/api/src/schemas/automation-actions.ts`

**Full:**

```ts
import { z } from "@hono/zod-openapi";

const OnErrorSchema = z.enum(["abort", "continue"]).default("abort");

const BaseAction = z.object({
  id: z.string(),
  on_error: OnErrorSchema,
});

export const TagAddAction = BaseAction.extend({
  type: z.literal("tag_add"),
  tag: z.string(),                      // tag name
});
export const TagRemoveAction = BaseAction.extend({
  type: z.literal("tag_remove"),
  tag: z.string(),
});

export const FieldSetAction = BaseAction.extend({
  type: z.literal("field_set"),
  field: z.string(),                    // custom field key
  value: z.string(),                    // merge-tag supported
});
export const FieldClearAction = BaseAction.extend({
  type: z.literal("field_clear"),
  field: z.string(),
});

export const SegmentAddAction = BaseAction.extend({
  type: z.literal("segment_add"),
  segment_id: z.string(),
});
export const SegmentRemoveAction = BaseAction.extend({
  type: z.literal("segment_remove"),
  segment_id: z.string(),
});

export const SubscribeListAction = BaseAction.extend({
  type: z.literal("subscribe_list"),
  list_id: z.string(),
});
export const UnsubscribeListAction = BaseAction.extend({
  type: z.literal("unsubscribe_list"),
  list_id: z.string(),
});

export const OptInChannelAction = BaseAction.extend({
  type: z.literal("opt_in_channel"),
  channel: z.enum(["instagram", "facebook", "whatsapp", "telegram", "tiktok"]),
});
export const OptOutChannelAction = BaseAction.extend({
  type: z.literal("opt_out_channel"),
  channel: z.enum(["instagram", "facebook", "whatsapp", "telegram", "tiktok"]),
});

export const AssignConversationAction = BaseAction.extend({
  type: z.literal("assign_conversation"),
  user_id: z.string(),                  // or "round_robin" / "unassigned"
});
export const UnassignConversationAction = BaseAction.extend({
  type: z.literal("unassign_conversation"),
});
export const ConversationOpenAction = BaseAction.extend({ type: z.literal("conversation_open") });
export const ConversationCloseAction = BaseAction.extend({ type: z.literal("conversation_close") });
export const ConversationSnoozeAction = BaseAction.extend({
  type: z.literal("conversation_snooze"),
  snooze_minutes: z.number().min(1),
});

export const NotifyAdminAction = BaseAction.extend({
  type: z.literal("notify_admin"),
  title: z.string(),
  body: z.string(),
  link: z.string().optional(),
  recipient_user_ids: z.array(z.string()).optional(),
});

export const WebhookOutAction = BaseAction.extend({
  type: z.literal("webhook_out"),
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  headers: z.record(z.string()).default({}),
  body: z.string().optional(),
  auth: z.object({
    mode: z.enum(["none", "bearer", "basic", "hmac"]).default("none"),
    token: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    secret: z.string().optional(),
  }).default({ mode: "none" }),
});

export const PauseContactAutomationsAction = BaseAction.extend({
  type: z.literal("pause_automations_for_contact"),
  scope: z.enum(["current", "global"]).default("current"),
  duration_min: z.number().optional(),
  reason: z.string().optional(),
});
export const ResumeContactAutomationsAction = BaseAction.extend({
  type: z.literal("resume_automations_for_contact"),
  scope: z.enum(["current", "global"]).default("current"),
});

export const DeleteContactAction = BaseAction.extend({
  type: z.literal("delete_contact"),
  confirm: z.literal(true),             // force operator to acknowledge
});

export const LogConversionEventAction = BaseAction.extend({
  type: z.literal("log_conversion_event"),
  event_name: z.string(),
  value: z.string().optional(),
  currency: z.string().optional(),
});

export const ChangeMainMenuAction = BaseAction.extend({
  type: z.literal("change_main_menu"),   // v1.1 stub
  menu_payload: z.any().optional(),
});

export const ActionSchema = z.discriminatedUnion("type", [
  TagAddAction, TagRemoveAction,
  FieldSetAction, FieldClearAction,
  SegmentAddAction, SegmentRemoveAction,
  SubscribeListAction, UnsubscribeListAction,
  OptInChannelAction, OptOutChannelAction,
  AssignConversationAction, UnassignConversationAction,
  ConversationOpenAction, ConversationCloseAction, ConversationSnoozeAction,
  NotifyAdminAction,
  WebhookOutAction,
  PauseContactAutomationsAction, ResumeContactAutomationsAction,
  DeleteContactAction,
  LogConversionEventAction,
  ChangeMainMenuAction,
]);

export const ActionGroupConfigSchema = z.object({
  actions: z.array(ActionSchema).min(1),
});

export type Action = z.infer<typeof ActionSchema>;
export type ActionGroupConfig = z.infer<typeof ActionGroupConfigSchema>;
```

**Steps:**
- [ ] Write file
- [ ] `bun run typecheck:api`
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task B4: Binding config Zod schemas**

**Files:**
- Create: `apps/api/src/schemas/automation-bindings.ts`

```ts
import { z } from "@hono/zod-openapi";

export const DefaultReplyConfig = z.object({}).passthrough();
export const WelcomeMessageConfig = z.object({}).passthrough();

export const ConversationStarterConfig = z.object({
  starters: z.array(z.object({
    label: z.string().max(30),
    payload: z.string().max(200),
  })).max(4),
});

export const MainMenuItemSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    label: z.string().max(30),
    action: z.enum(["postback", "url"]),
    payload: z.string(),
    sub_items: z.array(MainMenuItemSchema).max(5).optional(),
  })
);

export const MainMenuConfig = z.object({
  items: z.array(MainMenuItemSchema).max(3),
});

export const IceBreakerConfig = z.object({
  questions: z.array(z.object({
    question: z.string().max(80),
    payload: z.string(),
  })).max(4),
});

export const BindingConfigByType: Record<string, z.ZodSchema> = {
  default_reply: DefaultReplyConfig,
  welcome_message: WelcomeMessageConfig,
  conversation_starter: ConversationStarterConfig,
  main_menu: MainMenuConfig,
  ice_breaker: IceBreakerConfig,
};

export const BindingCreateSchema = z.object({
  social_account_id: z.string(),
  channel: z.enum(["instagram", "facebook", "whatsapp", "telegram", "tiktok"]),
  binding_type: z.enum(["default_reply", "welcome_message", "conversation_starter", "main_menu", "ice_breaker"]),
  automation_id: z.string(),
  config: z.record(z.any()).default({}),
  workspace_id: z.string().optional(),
});

export const BindingUpdateSchema = BindingCreateSchema.partial().extend({
  status: z.enum(["active", "paused", "pending_sync", "sync_failed"]).optional(),
});
```

**Steps:**
- [ ] Write file
- [ ] `bun run typecheck:api`
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task B5: Finalize `apps/api/src/schemas/automations.ts`**

**Files:**
- Replace: `apps/api/src/schemas/automations.ts` (full schema for the primary entity)

Replace the Phase-A stub with the complete schema:

```ts
import { z } from "@hono/zod-openapi";
import { GraphSchema } from "./automation-graph";

export const AutomationChannelSchema = z.enum(["instagram", "facebook", "whatsapp", "telegram", "tiktok"]);
export const AutomationStatusSchema = z.enum(["draft", "active", "paused", "archived"]);

export const AutomationCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  channel: AutomationChannelSchema,
  workspace_id: z.string().optional(),
  template: z.object({
    kind: z.string(),
    config: z.record(z.any()).default({}),
  }).optional(),
});

export const AutomationUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
});

export const AutomationGraphUpdateSchema = z.object({
  graph: GraphSchema,
});

export const ValidationErrorSchema = z.object({
  node_key: z.string().optional(),
  port_key: z.string().optional(),
  edge_index: z.number().optional(),
  code: z.string(),
  message: z.string(),
});

export const AutomationValidationSchema = z.object({
  valid: z.boolean(),
  errors: z.array(ValidationErrorSchema).default([]),
  warnings: z.array(ValidationErrorSchema).default([]),
});

export const AutomationResponseSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  workspace_id: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  channel: AutomationChannelSchema,
  status: AutomationStatusSchema,
  graph: GraphSchema,
  created_from_template: z.string().nullable(),
  template_config: z.record(z.any()).nullable(),
  total_enrolled: z.number(),
  total_completed: z.number(),
  total_exited: z.number(),
  total_failed: z.number(),
  last_validated_at: z.string().nullable(),
  validation_errors: z.array(ValidationErrorSchema).nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const AutomationEnrollSchema = z.object({
  contact_id: z.string(),
  entrypoint_id: z.string().optional(),
  context_overrides: z.record(z.any()).optional(),
});

export const AutomationSimulateSchema = z.object({
  start_node_key: z.string().optional(),
  test_context: z.record(z.any()).optional(),
  branch_choices: z.record(z.string()).optional(),
  execute_side_effects: z.boolean().default(false),
});

export type AutomationResponse = z.infer<typeof AutomationResponseSchema>;
export type AutomationValidation = z.infer<typeof AutomationValidationSchema>;
```

**Steps:**
- [ ] Replace file
- [ ] `bun run typecheck:api`
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task B6: Port derivation module**

**Files:**
- Create: `apps/api/src/services/automations/ports.ts`
- Create: `apps/api/src/__tests__/automation-ports.test.ts`

**Implementation:**

```ts
// apps/api/src/services/automations/ports.ts
import type { GraphNode, Port } from "../../schemas/automation-graph";

/**
 * Derives the canonical port array for a node from its kind + config.
 * Pure function. Always returns a fresh array.
 */
export function derivePorts(node: Pick<GraphNode, "kind" | "config">): Port[] {
  const cfg = node.config ?? {};
  switch (node.kind) {
    case "message": {
      const ports: Port[] = [{ key: "in", direction: "input" }];
      ports.push({ key: "next", direction: "output", role: "default" });
      // branch buttons (across all text/card blocks) + quick replies
      const blocks: any[] = Array.isArray(cfg.blocks) ? cfg.blocks : [];
      for (const b of blocks) {
        if (Array.isArray(b?.buttons)) {
          for (const btn of b.buttons) {
            if (btn?.type === "branch" && typeof btn.id === "string") {
              ports.push({
                key: `button.${btn.id}`,
                direction: "output",
                role: "interactive",
                label: btn.label,
              });
            }
          }
        }
        if (b?.type === "card" && Array.isArray(b?.buttons)) {
          for (const btn of b.buttons) {
            if (btn?.type === "branch" && typeof btn.id === "string") {
              ports.push({
                key: `button.${btn.id}`,
                direction: "output",
                role: "interactive",
                label: btn.label,
              });
            }
          }
        }
        if (b?.type === "gallery" && Array.isArray(b?.cards)) {
          for (const card of b.cards) {
            if (Array.isArray(card?.buttons)) {
              for (const btn of card.buttons) {
                if (btn?.type === "branch" && typeof btn.id === "string") {
                  ports.push({
                    key: `button.${btn.id}`,
                    direction: "output",
                    role: "interactive",
                    label: btn.label,
                  });
                }
              }
            }
          }
        }
      }
      const qrs: any[] = Array.isArray(cfg.quick_replies) ? cfg.quick_replies : [];
      for (const qr of qrs) {
        if (typeof qr?.id === "string") {
          ports.push({
            key: `quick_reply.${qr.id}`,
            direction: "output",
            role: "interactive",
            label: qr.label,
          });
        }
      }
      if (cfg.wait_for_reply && cfg.no_response_timeout_min) {
        ports.push({ key: "no_response", direction: "output", role: "timeout" });
      }
      return ports;
    }
    case "input":
      return [
        { key: "in", direction: "input" },
        { key: "captured", direction: "output", role: "success" },
        { key: "invalid", direction: "output", role: "invalid" },
        { key: "timeout", direction: "output", role: "timeout" },
        { key: "skip", direction: "output", role: "skip" },
      ];
    case "delay":
      return [
        { key: "in", direction: "input" },
        { key: "next", direction: "output", role: "default" },
      ];
    case "condition":
      return [
        { key: "in", direction: "input" },
        { key: "true", direction: "output", role: "branch", label: "True" },
        { key: "false", direction: "output", role: "branch", label: "False" },
      ];
    case "randomizer": {
      const ports: Port[] = [{ key: "in", direction: "input" }];
      const variants: any[] = Array.isArray(cfg.variants) ? cfg.variants : [];
      for (const v of variants) {
        if (typeof v?.key === "string") {
          ports.push({
            key: `variant.${v.key}`,
            direction: "output",
            role: "branch",
            label: v.label ?? v.key,
          });
        }
      }
      return ports;
    }
    case "action_group": {
      const ports: Port[] = [
        { key: "in", direction: "input" },
        { key: "next", direction: "output", role: "default" },
      ];
      const actions: any[] = Array.isArray(cfg.actions) ? cfg.actions : [];
      if (actions.some((a) => a?.on_error === "abort" || a?.on_error === undefined)) {
        ports.push({ key: "error", direction: "output", role: "error" });
      }
      return ports;
    }
    case "http_request":
      return [
        { key: "in", direction: "input" },
        { key: "success", direction: "output", role: "success" },
        { key: "error", direction: "output", role: "error" },
      ];
    case "start_automation":
      return [
        { key: "in", direction: "input" },
        { key: "next", direction: "output", role: "default" },
      ];
    case "goto":
      return [{ key: "in", direction: "input" }];
    case "end":
      return [{ key: "in", direction: "input" }];
    default:
      return [{ key: "in", direction: "input" }];
  }
}

/** Replaces a node's ports array in place. */
export function applyDerivedPorts<T extends GraphNode>(node: T): T {
  return { ...node, ports: derivePorts(node) };
}
```

**Tests (comprehensive):**

```ts
// apps/api/src/__tests__/automation-ports.test.ts
import { describe, expect, test } from "bun:test";
import { derivePorts } from "../services/automations/ports";

describe("derivePorts", () => {
  test("message with buttons and quick replies", () => {
    const ports = derivePorts({
      kind: "message",
      config: {
        blocks: [{
          id: "blk_1",
          type: "text",
          text: "Hi",
          buttons: [
            { id: "btn_a", type: "branch", label: "A" },
            { id: "btn_b", type: "branch", label: "B" },
            { id: "btn_url", type: "url", label: "Go", url: "https://x" }, // should NOT create port
          ],
        }],
        quick_replies: [{ id: "qr1", label: "Y" }],
        wait_for_reply: true,
        no_response_timeout_min: 60,
      },
    });
    const keys = ports.map((p) => p.key).sort();
    expect(keys).toEqual(["button.btn_a", "button.btn_b", "in", "next", "no_response", "quick_reply.qr1"].sort());
  });

  test("message without wait_for_reply has no no_response port", () => {
    const ports = derivePorts({ kind: "message", config: { blocks: [] } });
    expect(ports.map((p) => p.key)).toEqual(["in", "next"]);
  });

  test("condition always has true/false", () => {
    const ports = derivePorts({ kind: "condition", config: {} });
    expect(ports.map((p) => p.key)).toEqual(["in", "true", "false"]);
  });

  test("action_group has error only when any action has on_error=abort", () => {
    const withAbort = derivePorts({
      kind: "action_group",
      config: { actions: [{ id: "a", type: "tag_add", tag: "x", on_error: "abort" }] },
    });
    expect(withAbort.map((p) => p.key)).toEqual(["in", "next", "error"]);

    const allContinue = derivePorts({
      kind: "action_group",
      config: { actions: [{ id: "a", type: "tag_add", tag: "x", on_error: "continue" }] },
    });
    expect(allContinue.map((p) => p.key)).toEqual(["in", "next"]);
  });

  test("randomizer exposes one port per variant", () => {
    const ports = derivePorts({
      kind: "randomizer",
      config: { variants: [{ key: "a", weight: 50 }, { key: "b", weight: 50 }] },
    });
    expect(ports.map((p) => p.key)).toEqual(["in", "variant.a", "variant.b"]);
  });

  test("input has all four output ports", () => {
    const ports = derivePorts({ kind: "input", config: {} });
    expect(ports.map((p) => p.key)).toEqual(["in", "captured", "invalid", "timeout", "skip"]);
  });

  test("http_request has success + error", () => {
    const ports = derivePorts({ kind: "http_request", config: { url: "https://x" } });
    expect(ports.map((p) => p.key)).toEqual(["in", "success", "error"]);
  });

  test("goto and end have no output ports", () => {
    expect(derivePorts({ kind: "goto", config: {} }).filter((p) => p.direction === "output")).toEqual([]);
    expect(derivePorts({ kind: "end", config: {} }).filter((p) => p.direction === "output")).toEqual([]);
  });

  test("unknown kind still has an in port", () => {
    const ports = derivePorts({ kind: "mystery_kind", config: {} });
    expect(ports.map((p) => p.key)).toEqual(["in"]);
  });
});
```

**Steps:**
- [ ] Write both files
- [ ] Run `bun test apps/api/src/__tests__/automation-ports.test.ts`. Expect all tests pass
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task B7: Graph validator module**

**Files:**
- Create: `apps/api/src/services/automations/validator.ts`
- Create: `apps/api/src/__tests__/automation-validator.test.ts`

**Implementation:**

```ts
// apps/api/src/services/automations/validator.ts
import { applyDerivedPorts } from "./ports";
import type { Graph, GraphNode } from "../../schemas/automation-graph";

export type ValidationIssue = {
  code: string;
  message: string;
  node_key?: string;
  port_key?: string;
  edge_index?: number;
};

export type ValidationResult = {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  canonicalGraph: Graph;
};

const ENTRY_KINDS = new Set([
  "message", "action_group", "condition", "http_request", "start_automation", "end",
]);
const LOOP_PAUSE_KINDS = new Set(["input", "delay", "goto"]);

export function validateGraph(graph: Graph): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Regenerate ports (canonical form)
  const canonical: Graph = {
    schema_version: 1,
    root_node_key: graph.root_node_key,
    nodes: graph.nodes.map(applyDerivedPorts),
    edges: graph.edges.slice(),
  };

  // 1. unique node keys
  const seen = new Set<string>();
  for (const n of canonical.nodes) {
    if (seen.has(n.key)) {
      errors.push({ code: "duplicate_node_key", message: `duplicate node key "${n.key}"`, node_key: n.key });
    }
    seen.add(n.key);
  }

  // 2. root node kind
  if (!canonical.root_node_key) {
    if (canonical.nodes.length > 0) {
      errors.push({ code: "missing_root", message: "root_node_key is null but graph has nodes" });
    }
  } else {
    const root = canonical.nodes.find((n) => n.key === canonical.root_node_key);
    if (!root) {
      errors.push({ code: "missing_root", message: `root_node_key "${canonical.root_node_key}" not found` });
    } else if (!ENTRY_KINDS.has(root.kind)) {
      errors.push({
        code: "invalid_root_kind",
        message: `root node kind "${root.kind}" cannot be an entry point`,
        node_key: root.key,
      });
    }
  }

  // 3. edge references (node + port existence)
  const nodeByKey = new Map(canonical.nodes.map((n) => [n.key, n]));
  for (let i = 0; i < canonical.edges.length; i++) {
    const e = canonical.edges[i];
    const from = nodeByKey.get(e.from_node);
    const to = nodeByKey.get(e.to_node);
    if (!from) {
      errors.push({ code: "edge_missing_from_node", message: `edge[${i}] from_node "${e.from_node}" missing`, edge_index: i });
      continue;
    }
    if (!to) {
      errors.push({ code: "edge_missing_to_node", message: `edge[${i}] to_node "${e.to_node}" missing`, edge_index: i });
      continue;
    }
    if (!from.ports.some((p) => p.key === e.from_port && p.direction === "output")) {
      errors.push({
        code: "edge_missing_from_port",
        message: `edge[${i}] from_port "${e.from_port}" does not exist on node "${from.key}"`,
        edge_index: i, node_key: from.key, port_key: e.from_port,
      });
    }
    if (!to.ports.some((p) => p.key === e.to_port && p.direction === "input")) {
      errors.push({
        code: "edge_missing_to_port",
        message: `edge[${i}] to_port "${e.to_port}" does not exist on node "${to.key}"`,
        edge_index: i, node_key: to.key, port_key: e.to_port,
      });
    }
  }

  // 4. orphan nodes (non-root with no incoming edges)
  const incoming = new Set<string>();
  for (const e of canonical.edges) incoming.add(e.to_node);
  for (const n of canonical.nodes) {
    if (n.key === canonical.root_node_key) continue;
    if (!incoming.has(n.key)) {
      errors.push({ code: "orphan_node", message: `node "${n.key}" has no incoming edge`, node_key: n.key });
    }
  }

  // 5. cycle without a pause point
  const cycles = findCycles(canonical);
  for (const cycle of cycles) {
    const hasPause = cycle.some((key) => {
      const n = nodeByKey.get(key);
      return n ? LOOP_PAUSE_KINDS.has(n.kind) : false;
    });
    if (!hasPause) {
      errors.push({
        code: "cycle_without_pause",
        message: `cycle without input/delay/goto pause point: ${cycle.join(" → ")}`,
        node_key: cycle[0],
      });
    }
  }

  // 6. warnings: orphan output ports with no outgoing edge
  const outgoing = new Map<string, Set<string>>();
  for (const e of canonical.edges) {
    if (!outgoing.has(e.from_node)) outgoing.set(e.from_node, new Set());
    outgoing.get(e.from_node)!.add(e.from_port);
  }
  for (const n of canonical.nodes) {
    for (const p of n.ports) {
      if (p.direction !== "output") continue;
      if (!outgoing.get(n.key)?.has(p.key)) {
        warnings.push({
          code: "port_no_outgoing_edge",
          message: `node "${n.key}" port "${p.key}" has no outgoing edge`,
          node_key: n.key, port_key: p.key,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings, canonicalGraph: canonical };
}

function findCycles(graph: Graph): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!adj.has(e.from_node)) adj.set(e.from_node, []);
    adj.get(e.from_node)!.push(e.to_node);
  }
  const cycles: string[][] = [];
  const color = new Map<string, 0 | 1 | 2>(); // 0=unvisited, 1=in-stack, 2=done
  const stack: string[] = [];
  const dfs = (u: string) => {
    color.set(u, 1);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 1) {
        const startIdx = stack.indexOf(v);
        if (startIdx >= 0) cycles.push(stack.slice(startIdx));
      } else if (c === 0) dfs(v);
    }
    stack.pop();
    color.set(u, 2);
  };
  for (const n of graph.nodes) if ((color.get(n.key) ?? 0) === 0) dfs(n.key);
  return cycles;
}
```

**Tests:**

```ts
// apps/api/src/__tests__/automation-validator.test.ts
import { describe, expect, test } from "bun:test";
import { validateGraph } from "../services/automations/validator";

const mkGraph = (overrides: Partial<any> = {}) => ({
  schema_version: 1 as const,
  root_node_key: "a",
  nodes: [
    { key: "a", kind: "message", config: { blocks: [] }, ports: [] },
    { key: "b", kind: "end", config: {}, ports: [] },
  ],
  edges: [{ from_node: "a", from_port: "next", to_node: "b", to_port: "in" }],
  ...overrides,
});

describe("validateGraph", () => {
  test("valid simple graph passes", () => {
    const r = validateGraph(mkGraph());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("missing root errors", () => {
    const r = validateGraph(mkGraph({ root_node_key: "missing" }));
    expect(r.errors.some((e) => e.code === "missing_root")).toBe(true);
  });

  test("input as root is invalid", () => {
    const r = validateGraph({
      schema_version: 1,
      root_node_key: "a",
      nodes: [{ key: "a", kind: "input", config: {}, ports: [] }],
      edges: [],
    });
    expect(r.errors.some((e) => e.code === "invalid_root_kind")).toBe(true);
  });

  test("orphan node is error", () => {
    const r = validateGraph(mkGraph({
      nodes: [
        { key: "a", kind: "message", config: { blocks: [] }, ports: [] },
        { key: "b", kind: "end", config: {}, ports: [] },
        { key: "c", kind: "end", config: {}, ports: [] },
      ],
    }));
    expect(r.errors.some((e) => e.code === "orphan_node" && e.node_key === "c")).toBe(true);
  });

  test("edge to unknown node", () => {
    const r = validateGraph(mkGraph({
      edges: [{ from_node: "a", from_port: "next", to_node: "zzz", to_port: "in" }],
    }));
    expect(r.errors.some((e) => e.code === "edge_missing_to_node")).toBe(true);
  });

  test("edge to non-existent port", () => {
    const r = validateGraph(mkGraph({
      edges: [{ from_node: "a", from_port: "wrong_port", to_node: "b", to_port: "in" }],
    }));
    expect(r.errors.some((e) => e.code === "edge_missing_from_port")).toBe(true);
  });

  test("cycle without pause is error", () => {
    const r = validateGraph({
      schema_version: 1,
      root_node_key: "a",
      nodes: [
        { key: "a", kind: "message", config: { blocks: [] }, ports: [] },
        { key: "b", kind: "message", config: { blocks: [] }, ports: [] },
      ],
      edges: [
        { from_node: "a", from_port: "next", to_node: "b", to_port: "in" },
        { from_node: "b", from_port: "next", to_node: "a", to_port: "in" },
      ],
    });
    expect(r.errors.some((e) => e.code === "cycle_without_pause")).toBe(true);
  });

  test("cycle with delay is OK", () => {
    const r = validateGraph({
      schema_version: 1,
      root_node_key: "a",
      nodes: [
        { key: "a", kind: "message", config: { blocks: [] }, ports: [] },
        { key: "d", kind: "delay", config: { seconds: 60 }, ports: [] },
      ],
      edges: [
        { from_node: "a", from_port: "next", to_node: "d", to_port: "in" },
        { from_node: "d", from_port: "next", to_node: "a", to_port: "in" },
      ],
    });
    const cycleErrors = r.errors.filter((e) => e.code === "cycle_without_pause");
    expect(cycleErrors).toEqual([]);
  });

  test("orphan port produces warning not error", () => {
    const r = validateGraph(mkGraph({
      nodes: [
        { key: "a", kind: "condition", config: {}, ports: [] },
        { key: "b", kind: "end", config: {}, ports: [] },
      ],
      edges: [{ from_node: "a", from_port: "true", to_node: "b", to_port: "in" }],
    }));
    expect(r.warnings.some((w) => w.code === "port_no_outgoing_edge" && w.port_key === "false")).toBe(true);
    // ... but no error about this
  });
});
```

**Steps:**
- [ ] Write validator + tests
- [ ] Run `bun test apps/api/src/__tests__/automation-validator.test.ts`. Expect all pass
- [ ] **STOP — user commits at their discretion**

---

### Phase C — Runtime Core

(Detailed task blocks for C1-C6 follow the same pattern: write failing test, write implementation, run tests, stop. Due to plan length, the remaining tasks below are specified with concise step lists — the subagent executing each task will read the spec and this plan for full context, and write the code using the established patterns above.)

- [ ] **Task C1: Node handler interface + manifest (registry)**

**Files:**
- Replace: `apps/api/src/services/automations/manifest.ts`
- Create: `apps/api/src/services/automations/types.ts` (replace existing contents)

**Implementation outline:**

```ts
// types.ts
export type RunContext = {
  runId: string;
  organizationId: string;
  contactId: string;
  conversationId: string | null;
  channel: string;
  context: Record<string, any>;
  now: Date;
  // ... db handle, kv, queue bindings passed via env
};

export type HandlerResult =
  | { result: "advance"; via_port: string; payload?: any }
  | { result: "wait_input"; timeout_at?: Date; payload?: any }
  | { result: "wait_delay"; resume_at: Date; payload?: any }
  | { result: "end"; exit_reason: "completed"; payload?: any }
  | { result: "fail"; error: Error; payload?: any };

export interface NodeHandler<TConfig = any> {
  kind: string;
  handle(node: { key: string; kind: string; config: TConfig }, ctx: RunContext): Promise<HandlerResult>;
}
```

```ts
// manifest.ts
import type { NodeHandler } from "./types";
import { messageHandler } from "./nodes/message";
import { inputHandler } from "./nodes/input";
import { delayHandler } from "./nodes/delay";
import { conditionHandler } from "./nodes/condition";
import { randomizerHandler } from "./nodes/randomizer";
import { actionGroupHandler } from "./nodes/action-group";
import { httpRequestHandler } from "./nodes/http-request";
import { startAutomationHandler } from "./nodes/start-automation";
import { gotoHandler } from "./nodes/goto";
import { endHandler } from "./nodes/end";

export const handlers: Record<string, NodeHandler> = {
  message: messageHandler,
  input: inputHandler,
  delay: delayHandler,
  condition: conditionHandler,
  randomizer: randomizerHandler,
  action_group: actionGroupHandler,
  http_request: httpRequestHandler,
  start_automation: startAutomationHandler,
  goto: gotoHandler,
  end: endHandler,
};

export function getHandler(kind: string): NodeHandler | null {
  return handlers[kind] ?? null;
}
```

**Steps:**
- [ ] Write `types.ts` and `manifest.ts` skeletons
- [ ] Create empty stub handler files for all 10 kinds (`nodes/message.ts`, etc. — export a skeleton `export const xxxHandler: NodeHandler = { kind: "xxx", async handle() { return { result: "end", exit_reason: "completed" }; } };`). Each stub is ~5 lines
- [ ] Run `bun run typecheck:api`. Expect success
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task C2: Runner execution loop (skeleton — end-only runs)**

**Files:**
- Replace: `apps/api/src/services/automations/runner.ts`
- Create: `apps/api/src/__tests__/automation-runner.test.ts`

Implement the execution loop per spec §8.3: load graph, dispatch handler, write step_run, resolve next edge, update run, repeat. Loop terminates on `end`, `wait_input`, `wait_delay`, or `fail`. Include optimistic concurrency via `updated_at` `WHERE` clause, infinite-loop cap of 200 nodes, and pause-check against `automation_contact_controls`.

Test with a graph of `message → end` using handler stubs from C1. Verify:
- Run created, step_runs written for both nodes, run status = `completed`, exit_reason = `completed`
- Second call to runner for a completed run is no-op
- Pause row blocks execution

**Steps:**
- [ ] Implement runner
- [ ] Write integration test (uses real DB via SSH tunnel per CLAUDE.md)
- [ ] Run `bun test apps/api/src/__tests__/automation-runner.test.ts`
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task C3: Message node handler + platform adapters**

**Files:**
- Replace: `apps/api/src/services/automations/nodes/message.ts`
- Create: `apps/api/src/services/automations/platforms/index.ts` + per-channel files (`instagram.ts`, `facebook.ts`, `whatsapp.ts`, `telegram.ts`, `tiktok.ts`)

Implementation: iterate `config.blocks`, render each block to the channel's payload shape using merge-tag resolver, call the platform adapter, then return `wait_input` if `wait_for_reply` is set OR there are interactive elements; otherwise `advance` via `next`.

Platform adapters encapsulate the send: `sendMessage(channel, recipient, blocks): Promise<SendResult>`. Each adapter reads from `social_accounts` for credentials and calls the platform API.

**Steps:**
- [ ] Write the message handler
- [ ] Write all 5 platform adapters (stub internals — can reuse logic from legacy `platforms/*.ts` files). For unsupported block/channel combos, silently skip and log warning
- [ ] Write integration test: `message → end` with a real Instagram account (or mock adapter if no test account). Verify step_run includes rendered payload
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task C4: Input, delay, condition, randomizer, goto, end handlers**

**Files:**
- Replace: `apps/api/src/services/automations/nodes/input.ts`
- Replace: `apps/api/src/services/automations/nodes/delay.ts`
- Replace: `apps/api/src/services/automations/nodes/condition.ts`
- Replace: `apps/api/src/services/automations/nodes/randomizer.ts`
- Replace: `apps/api/src/services/automations/nodes/goto.ts`
- Replace: `apps/api/src/services/automations/nodes/end.ts`

Each handler is small:
- `input.ts` — returns `wait_input` with timeout_at from `config.timeout_min`. Validation logic lives in a resume path.
- `delay.ts` — returns `wait_delay` with `resume_at = now + duration`.
- `condition.ts` — evaluates `config.expression` against `ctx.context` (reuse existing `filter-eval.ts` semantics); returns `advance` via `true` or `false`.
- `randomizer.ts` — weighted random choice across `config.variants`; sticky per-run (persisted in `ctx.context._randomizer[node.key]`); returns `advance` via `variant.<key>`.
- `goto.ts` — returns `advance` via a special port; runner interprets goto specially (reads `config.target_node_key`, jumps directly).
- `end.ts` — returns `{ result: "end", exit_reason: "completed" }`.

**Steps:**
- [ ] Implement each handler (~20-40 LOC each)
- [ ] Unit tests for condition eval and randomizer stickiness
- [ ] Run tests
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task C5: HTTP request, start_automation handlers**

**Files:**
- Replace: `apps/api/src/services/automations/nodes/http-request.ts`
- Replace: `apps/api/src/services/automations/nodes/start-automation.ts`

`http_request`:
- Build request from config: URL, method, headers, body (merge-tag resolved)
- `fetch` with timeout (default 15s)
- Store response at `ctx.context[config.response_key]`
- `advance` via `success` for 2xx, `error` for 4xx/5xx/network/timeout

`start_automation`:
- Creates a new `automation_runs` row for the target automation with the current contact
- Does not wait; returns `advance` via `next`

**Steps:**
- [ ] Implement both handlers
- [ ] Integration test: mock HTTP server + start_automation → verify new run created
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task C6: Action group handler + action dispatcher**

**Files:**
- Replace: `apps/api/src/services/automations/nodes/action-group.ts`
- Create: `apps/api/src/services/automations/action-dispatcher.ts`
- Create: `apps/api/src/services/automations/actions/` (all action type files)

Action dispatcher: `Record<string, (action, ctx) => Promise<void>>`. Each file exports its action handlers.

Action group handler logic per spec §8.8:
- for each action in `config.actions`:
  - resolve its type, dispatch
  - on success: log, continue
  - on throw + `on_error==="abort"`: stop, return `advance` via `error`
  - on throw + `on_error==="continue"`: log failure in step_run payload, continue
- on completion: return `advance` via `next`

Action implementations per spec §5.4:
- `actions/tag.ts` — tag_add/remove via `contact_tags` table
- `actions/field.ts` — field_set/clear via `custom_field_values`
- `actions/segment.ts` — segment_add/remove via `contact_segment_memberships`
- `actions/subscription.ts` — subscribe/unsubscribe via `contact_subscriptions`; opt_in/out_channel sets a contact flag
- `actions/conversation.ts` — assign/unassign/open/close/snooze via `conversations` table
- `actions/notify.ts` — notify_admin creates an in-app notification row
- `actions/webhook.ts` — webhook_out fire-and-forget `fetch`
- `actions/automation-controls.ts` — pause/resume insert/delete `automation_contact_controls` rows
- `actions/contact.ts` — delete_contact (with confirmation check)
- `actions/conversion.ts` — log_conversion_event to a conversion log table (or analytics sink)
- `actions/index.ts` — registers all

**Steps:**
- [ ] Implement all action files (~20-40 LOC each)
- [ ] Implement action dispatcher + action group handler
- [ ] Unit tests for each action type (~2 tests each)
- [ ] Integration test for action_group: `action_group [tag_add, field_set]` → verify DB state after
- [ ] **STOP — user commits at their discretion**

---

### Phase D — Trigger, Binding, Webhook

- [ ] **Task D1: Trigger matcher (entrypoints)**

**Files:**
- Replace: `apps/api/src/services/automations/trigger-matcher.ts`

Preserve the matching algorithm from the current file but rewrite against the new `automation_entrypoints` schema. Per spec §6.6:

1. Load candidate entrypoints `(channel, kind, status='active')` + account filter
2. Apply config matcher (keyword modes, post_id filter, etc.) — reuse existing `matchTriggerConfig` logic
3. Apply `filters` JSONB via preserved `filter-eval.ts`
4. Check reentry window against `automation_runs`
5. Check contact controls (per-automation + global)
6. Sort by `(specificity DESC, priority ASC, created_at ASC)`
7. Return winning entrypoint (if any)

Export `matchAndEnroll(event, ctx)` that performs all of the above and creates an `automation_runs` row for the winner.

**Steps:**
- [ ] Write the new matcher (port existing algorithm into new schema)
- [ ] Unit tests: keyword variants, specificity ordering, reentry cooldown, contact pause blocks match
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task D2: Binding router (default_reply / welcome_message fallback)**

**Files:**
- Create: `apps/api/src/services/automations/binding-router.ts`

`routeBinding(event, ctx)`:
- If `event.kind === "dm_received"` AND no entrypoint matched: look up `default_reply` binding for `(social_account_id, channel)`; if active, enroll via binding
- If contact has no prior `inbox_messages` on this channel: look up `welcome_message` binding; fire instead of default_reply

**Steps:**
- [ ] Implement binding router
- [ ] Integration test: send a DM that matches no entrypoint, verify default_reply binding fires; send from a brand-new contact, verify welcome_message binding fires
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task D3: Webhook receiver for `webhook_inbound` entrypoints**

**Files:**
- Create: `apps/api/src/services/automations/webhook-receiver.ts`
- Create: `apps/api/src/routes/automation-webhook-trigger.ts`

Endpoint: `POST /v1/webhooks/automation-trigger/:slug`. No auth via API key — uses HMAC in `X-Relay-Signature` header.

Flow per spec §6.7:
1. Load entrypoint by `webhook_slug`
2. Verify HMAC `sha256=<hex>` against `config.webhook_secret` over the raw body
3. Parse body JSON, extract contact identifier via `config.contact_lookup.field_path` (JSONPath; use `jsonpath-plus` if available, otherwise implement minimal `$.foo.bar` parser)
4. Resolve contact by the configured `by` strategy; optionally auto-create
5. Apply `payload_mapping` into `run.context`
6. Enroll contact → create run
7. Return `202 { run_id }`; on failure `401/404/422`

**Steps:**
- [ ] Implement webhook receiver
- [ ] Implement route
- [ ] Wire route into Hono app
- [ ] Integration test: POST with valid signature → 202 + run created; POST with bad signature → 401; POST with unknown slug → 404
- [ ] **STOP — user commits at their discretion**

---

### Phase E — Scheduler, Simulator

- [ ] **Task E1: Scheduler rewrite**

**Files:**
- Replace: `apps/api/src/services/automations/scheduler.ts`

Per spec §8.7. Batch-claim 200 jobs with `FOR UPDATE SKIP LOCKED`, stale reclaim 5min timeout, dispatch by `job_type`. Exposes `processScheduledJobs(db)` called by a cron worker.

Reuse existing cron worker entry point if present.

**Steps:**
- [ ] Implement scheduler
- [ ] Integration test: insert a `resume_run` job with `run_at = now - 1s`, call scheduler, verify run resumed + job marked `done`
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task E2: Simulator rewrite**

**Files:**
- Replace: `apps/api/src/services/automations/simulator.ts`

Pure dry-run walker: loads graph, executes handlers in a "simulation mode" where side effects are skipped (platform sends become no-op returning a mock response; DB writes (tags, fields) are skipped; webhooks not fired). Returns a step-by-step transcript with resolved merge tags and port decisions.

Support `branch_choices` override to force specific port selections at branching nodes.

**Steps:**
- [ ] Implement simulator
- [ ] Tests: happy path with a multi-node graph; branch_choices override; merge-tag resolution
- [ ] **STOP — user commits at their discretion**

---

### Phase F — Templates

- [ ] **Task F1: Template dispatcher + blank/welcome-flow/faq-bot/lead-capture scaffolds**

**Files:**
- Create: `apps/api/src/services/automations/templates/index.ts`
- Create: `apps/api/src/services/automations/templates/blank.ts`
- Create: `apps/api/src/services/automations/templates/welcome-flow.ts`
- Create: `apps/api/src/services/automations/templates/faq-bot.ts`
- Create: `apps/api/src/services/automations/templates/lead-capture.ts`

Each template module exports `buildGraphFromTemplate(config): { graph, entrypoint }`. Dispatcher: `Record<string, BuildFn>`.

**Steps:**
- [ ] Implement dispatcher + 4 scaffolds
- [ ] Unit tests: each template produces a valid graph (per validator)
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task F2: Quick-automation templates (4)**

**Files:**
- Create: `apps/api/src/services/automations/templates/comment-to-dm.ts`
- Create: `apps/api/src/services/automations/templates/story-leads.ts`
- Create: `apps/api/src/services/automations/templates/follower-growth.ts`
- Create: `apps/api/src/services/automations/templates/follow-to-dm.ts`

Each consumes a typed config (per spec §7.2) and produces a graph + `comment_created` / `story_reply` / `follow` entrypoint.

**Steps:**
- [ ] Implement 4 templates
- [ ] Tests per template: given a config, verify the generated graph is valid + produces the expected node/edge count
- [ ] **STOP — user commits at their discretion**

---

### Phase G — API Routes

- [ ] **Task G1: `/automations` CRUD routes**

**Files:**
- Replace: `apps/api/src/routes/automations.ts` (just the CRUD endpoints: list, create, retrieve, update, delete)

`POST /automations` — honors `template` field via the template dispatcher; creates automation + entrypoint (if template produces one).

**Steps:**
- [ ] Implement CRUD
- [ ] Integration tests: create → retrieve → list → update → delete round-trip
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task G2: Automation lifecycle + graph + enroll + simulate routes**

**Files:**
- Modify: `apps/api/src/routes/automations.ts` (add lifecycle + graph + enroll + simulate)

Endpoints:
- `POST /automations/{id}/activate` (runs validator)
- `POST /automations/{id}/pause`
- `POST /automations/{id}/resume`
- `POST /automations/{id}/archive`
- `POST /automations/{id}/unarchive`
- `PUT  /automations/{id}/graph` (re-derives ports, validates, auto-pauses on errors)
- `POST /automations/{id}/enroll`
- `POST /automations/{id}/simulate`
- `GET  /automations/{id}/insights`
- `GET  /automations/catalog`

**Steps:**
- [ ] Implement each endpoint
- [ ] Integration tests
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task G3: Entrypoint routes**

**Files:**
- Create: `apps/api/src/routes/automation-entrypoints.ts`

Endpoints per spec §9.2:
- `GET /automations/{id}/entrypoints`
- `POST /automations/{id}/entrypoints`
- `GET /automation-entrypoints/{id}`
- `PATCH /automation-entrypoints/{id}`
- `DELETE /automation-entrypoints/{id}`
- `POST /automation-entrypoints/{id}/rotate-secret`

Validate `config` against `EntrypointConfigByKind[kind]` on create/update. Compute `specificity` per spec §6.2. Generate `webhook_slug` + `webhook_secret` for `webhook_inbound` kind (secret encrypted at rest via existing AES-GCM helper).

**Steps:**
- [ ] Implement routes
- [ ] Wire into main Hono app
- [ ] Integration tests
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task G4: Binding routes**

**Files:**
- Create: `apps/api/src/routes/automation-bindings.ts`

Endpoints per spec §9.4:
- `GET /automation-bindings`
- `POST /automation-bindings`
- `GET /automation-bindings/{id}`
- `PATCH /automation-bindings/{id}`
- `DELETE /automation-bindings/{id}`

Stubbed types (`conversation_starter` / `main_menu` / `ice_breaker`) default `status = "pending_sync"`.

**Steps:**
- [ ] Implement routes + tests
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task G5: Run + step-run routes**

**Files:**
- Create: `apps/api/src/routes/automation-runs.ts`

Endpoints per spec §9.5:
- `GET /automations/{id}/runs`
- `GET /automation-runs/{id}`
- `GET /automation-runs/{id}/steps`
- `POST /automation-runs/{id}/stop`

**Steps:**
- [ ] Implement routes + tests
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task G6: Contact automation controls routes**

**Files:**
- Create: `apps/api/src/routes/contact-automation-controls.ts`

Endpoints per spec §9.6:
- `GET /contacts/{id}/automation-controls`
- `POST /contacts/{id}/automation-pause`
- `POST /contacts/{id}/automation-resume`

**Steps:**
- [ ] Implement routes + tests
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task G7: Catalog + insights + webhook trigger route wiring**

**Files:**
- Modify: `apps/api/src/routes/automations.ts` to add `GET /automations/catalog` and `GET /automations/insights` (aggregate across template kinds)
- Modify: main Hono app to mount `automation-webhook-trigger` public route

Catalog returns static data: `{ node_kinds: [...], entrypoint_kinds: [...], binding_types: [...], action_types: [...], channel_capabilities: {...}, template_kinds: [...] }`. ETag-cached.

**Steps:**
- [ ] Implement
- [ ] Test all new endpoints respond
- [ ] **STOP — user commits at their discretion**

---

### Phase H — SDK

- [ ] **Task H1: SDK automations resource rewrite**

**Files:**
- Replace: `packages/sdk/src/resources/automations.ts`

Mirror spec §9.10. Include: `list`, `create`, `retrieve`, `update`, `delete`, `activate`, `pause`, `resume`, `archive`, `unarchive`, `updateGraph`, `enroll`, `simulate`, `insights`, `catalog`.

**Steps:**
- [ ] Rewrite resource
- [ ] `cd packages/sdk && bun run build` — verify no errors
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task H2: SDK entrypoint + binding + run + contact-control resources**

**Files:**
- Create: `packages/sdk/src/resources/automation-entrypoints.ts`
- Create: `packages/sdk/src/resources/automation-bindings.ts`
- Create: `packages/sdk/src/resources/automation-runs.ts`
- Create: `packages/sdk/src/resources/contact-automation-controls.ts`
- Modify: `packages/sdk/src/index.ts` to export them via the root client

**Steps:**
- [ ] Implement resources
- [ ] Wire into client
- [ ] Build SDK
- [ ] **STOP — user commits at their discretion**

---

### Phase I — OpenAPI + Integration smoke tests

- [ ] **Task I1: Export OpenAPI**

**Steps:**
- [ ] Run `bun run dev:api` (requires SSH tunnel)
- [ ] In another shell: `bun run --filter api export-openapi`
- [ ] Confirm the spec includes all new endpoints + the webhook trigger endpoint
- [ ] **STOP — user commits at their discretion**

---

- [ ] **Task I2: End-to-end integration smoke test**

**Files:**
- Create: `apps/api/src/__tests__/automation-e2e.test.ts`

Test scenario:
1. Create an automation with the `comment_to_dm` template pointing at a test IG account
2. POST a synthetic comment event to the trigger-matcher (bypass the Meta webhook)
3. Verify a run was created
4. Advance the run by simulating an incoming DM (if the template waits for input)
5. Verify step_runs were written, the run completed, and the automation's counters incremented

This test uses real DB (via SSH tunnel) but mocks platform adapters.

**Steps:**
- [ ] Write the test
- [ ] Run `bun test apps/api/src/__tests__/automation-e2e.test.ts`
- [ ] Run full suite: `bun run typecheck`, `bun test`
- [ ] **STOP — user commits at their discretion**

---

## Self-Review

**Spec coverage:** All §4 tables created (A3-A4). §5 graph shape expressed in B1 and used by validator (B7). §6 entrypoints + bindings built in B2/B4, exercised by D1-D3. §7 templates in F1-F2. §8 runtime in C1-C6 + E1-E2. §9 API in G1-G7. §9.10 SDK in H1-H2.

**Placeholder scan:** No TBDs. Tasks C1-C6 and G1-G7 are specified with concise step lists rather than full code blocks because (a) handler shapes follow identical patterns across the 10 node kinds, and (b) API routes follow the repo's established Hono zod-openapi conventions. The executing subagent has full access to spec + this plan + codebase patterns.

**Type consistency:** `HandlerResult`, `NodeHandler`, `RunContext`, `ValidationIssue`, `Graph`, `Port`, `Action` types are consistent across all references.

---

## Execution

Execute with `superpowers:subagent-driven-development`: fresh subagent per task, me reviewing between.
