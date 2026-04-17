# Automation System Rewrite — Implementation Plan & Status

**Goal**: Replace `sequences` / `commentAutomations` / `engagementRules` / `automationRules` with a unified flow-based "automations" engine. No backwards compatibility (no production users yet).

**Last updated**: 2026-04-17

---

## Phase 0 — Pre-work

External blockers to confirm before Phase 8:

- [ ] Reddit developer app pre-approval (commercial use).
- [ ] LinkedIn Community Management API approval (`r_member_social`).
- [ ] Google Business Profile API access (contact-form approval).
- [ ] Meta app review for `HUMAN_AGENT` permission (post-24h IG/Messenger sends).
- [ ] pgvector extension enabled on Hyperdrive Postgres (needed for AI Knowledge Base).

---

## Phase 1 — Schema foundation

**Status**: ⚠️ Code complete — user must run migration

**Completed**:
- ✅ `packages/db/src/schema.ts` — appended 17 new tables, 5 new pgEnums (automation_trigger_type with ~82 values, automation_node_type with ~117 values, automation_status, automation_enrollment_status, automation_channel). Old tables retained until Phase 3/4/6.
- ✅ `apps/api/src/schemas/automations.ts` — full Zod discriminated union for node types, trigger spec, edge spec, full `AutomationCreateSpec`, template inputs, schema introspection response.
- ✅ `bun run typecheck` passes.

**User action required** (needs SSH tunnel to remote Postgres):
```bash
bun run db:generate  # review migration diff
bun run db:migrate
```

**Files**:
- `packages/db/src/schema.ts` — drop old tables, add new tables + enums.
- `apps/api/src/schemas/automations.ts` — Zod discriminated unions.
- `apps/api/src/lib/ids.ts` — new ID prefixes.

**Drops**: `sequences`, `sequence_steps`, `sequence_enrollments`, `comment_automations`, `comment_automation_logs`, `engagement_rules`, `engagement_rule_logs`, `automation_rules`, `automation_logs`.

**Adds (17 tables)**: `automations`, `automation_nodes`, `automation_edges`, `automation_versions`, `automation_enrollments`, `automation_run_logs`, `automation_scheduled_ticks`, `segments`, `subscription_lists`, `contact_subscriptions`, `ai_knowledge_bases`, `ai_knowledge_documents`, `ai_knowledge_chunks`, `ai_agents`, `ref_urls`, `qr_codes`, `landing_pages`.

**Enums**: `automation_trigger_type_enum` (~80 values), `automation_node_type_enum` (~125 values), `automation_status_enum`, `automation_enrollment_status_enum`, `automation_channel_enum`.

**User action required after code is written**:
- Run `bun run db:generate` (requires SSH tunnel).
- Review generated migration.
- Run `bun run db:migrate`.

**Gate**: `bun run typecheck` passes; migration generates cleanly.

---

## Phase 2 — Runtime engine

**Status**: ✅ Code complete (tests deferred)

**Completed**:
- ✅ `wrangler.jsonc` — `AUTOMATION_QUEUE` producer + consumer (`relayapi-automation` queue) with DLQ.
- ✅ `types.ts` — `AUTOMATION_QUEUE: Queue` binding.
- ✅ `services/automations/types.ts` — queue message shape, snapshot shape, NodeHandler contract, execution result union.
- ✅ `services/automations/runner.ts` — state machine: loads snapshot, dispatches node handlers, writes run logs, advances/parks/completes/exits, resolves edges by label, `MAX_STEPS_PER_TICK` cap with re-enqueue, `resumeFromInput` for user-input resumption.
- ✅ `services/automations/trigger-matcher.ts` — `matchAndEnroll()` queries candidates by org+status+trigger_type, matches keywords/post_id/filters, re-entry guard, enrollment + queue dispatch. `findWaitingEnrollment()` for input resumption.
- ✅ `services/automations/scheduler.ts` — cron-triggered sweep of `automation_scheduled_ticks` and waiting enrollments; timeout sweep for input-parked enrollments.
- ✅ `services/automations/merge-tags.ts` — `{{contact.x}} / {{state.y}}` substitution.
- ✅ `services/automations/filter-eval.ts` — predicate engine for conditions + trigger_filters.
- ✅ `services/automations/nodes/` — 14 universal handlers implemented: trigger, end, goto, condition, smart_delay, randomizer, message_text, message_media (stub), tag_add, tag_remove, field_set, field_clear, http_request, user_input (shared by 7 subtypes).
- ✅ Platform-specific node handlers stubbed via registry; throw `Phase 8 not implemented` when invoked.
- ✅ `queues/automation.ts` registered in `queues/index.ts`.
- ✅ Scheduler wired into `scheduled/index.ts` every-minute cron.
- ✅ `bun run typecheck` passes.

**Deferred**:
- Unit tests (≥15 planned). Will add once Phase 3 API is in place so tests can exercise the full path.
- `platform-webhooks.ts` hook — calling `matchAndEnroll` from the inbound webhook path. Single call site; leaving for Phase 8 alongside per-platform trigger normalization.
- Prompt send before `user_input` parks — currently just parks. Needs a small tweak to delegate to message_text first.

**Files**:
- `apps/api/src/queue/automation-runner.ts` — queue consumer.
- `apps/api/src/services/automation-trigger-matcher.ts`.
- `apps/api/src/services/automation-nodes/` — one handler per node type (~30 universal + ~95 platform-specific, built incrementally).
- `apps/api/src/services/automation-scheduler.ts` — cron sweeper.
- `apps/api/src/services/automation-engine.ts` — enrollment state machine.
- `apps/api/src/routes/platform-webhooks.ts` — modified to fan out to trigger matcher.
- `wrangler.jsonc` — add `AUTOMATION_QUEUE`, cron trigger.

**Tests**: ≥15 unit tests (linear, conditions, delays, randomizer, user-input, goto, dedup, versioning, filters, keyword match, HTTP node, tag actions).

**Gate**: Fake webhook → enrollment → DM sent → run log written.

---

## Phase 3 — API surface

**Status**: ✅ Core complete (secondary CRUD routes deferred)

**Completed**:
- ✅ `apps/api/src/routes/automations.ts` — full CRUD + publish/pause/resume/archive/delete + `/schema` introspection + enrollments list + run logs list. Single-blob create accepts the full automation spec with keyed nodes + edges. Validates duplicate keys and unknown edge references with Levenshtein suggestions.
- ✅ `apps/api/src/routes/automation-templates.ts` — six quick-create endpoints: `/comment-to-dm`, `/welcome-dm`, `/keyword-reply`, `/follow-to-dm`, `/story-reply`, `/giveaway`. Each takes a handful of fields and expands into the full graph.
- ✅ `apps/api/src/lib/automation-errors.ts` — Levenshtein + structured error helper.
- ✅ Registered in `apps/api/src/index.ts`: `/v1/automations` + `/v1/automations/templates`.
- ✅ `bun run typecheck` passes across all packages.

**Note on workspace scope**: Workspace-level enforcement deferred (was causing Hono OpenAPI return-type widening conflicts). Org-level auth is enforced by middleware; workspace scoping can be layered back in a Phase 3b pass.

**Deferred to Phase 3b** (same pattern, straightforward follow-ups):
- `segments.ts` — CRUD for contact segments.
- `ai-knowledge.ts` — CRUD for KB + documents + chunks.
- `ref-urls.ts` — CRUD for ref URLs + QR codes + landing pages.
- Dedicated `automation-enrollments.ts`, `automation-runs.ts` standalone routes (currently nested under `/automations/:id/enrollments` which covers the common case).
- `POST /v1/automations/:id/simulate` — Playground endpoint. Exists in schema; handler wiring deferred until the runner's dry-run mode is added.

**User action required**: none for this phase; but Phase 1's migration must be run (`bun run db:generate && bun run db:migrate`) before these routes will actually work.

**Files**:
- `apps/api/src/routes/automations.ts` — CRUD + publish + pause + simulate + `/schema`.
- `apps/api/src/routes/automation-templates.ts` — quick-create templates.
- `apps/api/src/routes/automation-enrollments.ts`.
- `apps/api/src/routes/automation-runs.ts`.
- `apps/api/src/routes/segments.ts`.
- `apps/api/src/routes/ai-knowledge.ts`.
- `apps/api/src/routes/ref-urls.ts`.
- `apps/api/src/lib/automation-errors.ts` — Levenshtein suggestions on unknown_* errors.
- **Delete**: `sequences.ts`, `comment-automations.ts`, `engagement-rules.ts`, `automation.ts`.

**Gate**: `POST /v1/automations/templates/comment-to-dm` creates a working automation; `GET /v1/automations/schema` returns the full catalog; deleted routes 404.

---

## Phase 4 — SDK update

**Status**: ☐ Not started

**Files**:
- `packages/sdk/src/resources/automations.ts` (+ enrollments, runs, segments, ai-knowledge, ref-urls).
- **Delete** SDK resources: `sequences.ts`, `comment-automations.ts`, `engagement-rules.ts`, `automation-rules.ts`.
- `packages/sdk/src/types/automation.ts` — re-export discriminated-union types.

**Commit format**: `feat(sdk)!: add automations resource, remove legacy automation resources` → release-please major bump.

**User action required**: merge release-please PR to publish new major to npm.

**Gate**: typecheck passes across api, app, sdk.

---

## Phase 5 — Docs site

**Status**: ☐ Not started

**Files** (`apps/docs/content/docs/guides/automations/`):
- `index.mdx` — Overview.
- `triggers.mdx` — Full trigger catalog.
- `nodes.mdx` — Full node catalog.
- `templates.mdx` — Quick-create templates.
- `ai-agent.mdx` — KB + persona + handoff.
- `mcp-server.mdx` — AI agent usage via MCP.
- `flow-builder.mdx` — Dashboard walkthrough.
- `testing-with-simulator.mdx` — Playground usage.
- `cookbook/` — comment-to-dm, welcome-dm, giveaway, abandoned-cart, drip-sequence, follow-to-dm.

**Per-platform pages** (`apps/docs/content/docs/platforms/`): 21 pages documenting setup, supported triggers, supported nodes, limits.

**Gate**: `bun run dev:docs` renders all pages; API reference matches OpenAPI.

---

## Phase 6 — Dashboard UI

**Status**: ☐ Not started

**Files**:
- `apps/app/src/components/dashboard/dashboard-shell.tsx` — add Automation sidebar entry.
- `apps/app/src/pages/app/automation/index.astro` + `[id].astro`.
- `apps/app/src/components/dashboard/route-apps/automation-route-app.tsx`.
- `apps/app/src/components/dashboard/automation/` — list, template picker, flow builder (React Flow), property panels, simulator, run history.

**Dependencies**: `@xyflow/react`, `dagre`.

**Deletes**:
- `apps/app/src/components/dashboard/campaigns/sequences-*`.
- `apps/app/src/components/dashboard/campaigns/comment-automation-*`.
- `apps/app/src/components/dashboard/campaigns/engagement-rule-*`.

**Gate**: Create an automation from a template → publish → trigger in dev → DM fires → run history shows highlighted path.

---

## Phase 7 — MCP server

**Status**: ☐ Not started

**Files** (`packages/mcp/`):
- `src/index.ts` — server entry (stdio + http).
- `src/tools/` — 10 tools: list/get/create/create_from_template/update/publish/pause/simulate/list_runs/schema.
- `src/client.ts` — wraps `@relayapi/sdk`.
- `README.md`.

**User action required**: publish `@relayapi/mcp-server` to npm.

**Gate**: Claude Code connects to MCP server → calls `get_automation_schema` → creates automation from template → appears in dashboard.

---

## Phase 8 — Platform coverage

**Status**: ☐ Not started (per-platform sub-tasks below)

Per-platform: doc re-read → triggers → send nodes → webhook wiring → platform docs page → 3 integration tests.

- [ ] instagram (1.5d)
- [ ] whatsapp (1.5d)
- [ ] facebook/messenger (1d, skip deprecated tags)
- [ ] telegram (0.5d)
- [ ] discord (1d)
- [ ] twitter/x (1d)
- [ ] sms — twilio+telnyx (0.5d)
- [ ] bluesky (1d)
- [ ] threads (0.5d)
- [ ] youtube — incl. PubSubHubbub (1d)
- [ ] mastodon (0.5d)
- [ ] reddit (1d, blocked on pre-approval)
- [ ] linkedin (0.5d)
- [ ] googlebusiness (0.5d)
- [ ] kit (0.5d)
- [ ] mailchimp (0.5d, form-encoded webhooks)
- [ ] beehiiv (0.5d)
- [ ] listmonk / pinterest (0.5d, outbound-only)

---

## Cross-cutting

- [ ] `apps/api/src/services/platform-rate-limiter.ts` — KV token buckets per platform.
- [ ] `usageRecords` wiring for automation execution billing.
- [ ] CI workflow `publish-mcp-server.yml`.

---

## Timeline

- Critical path (IG + WA + Telegram demoable): ~15 working days.
- Feature complete (all 21 platforms + MCP + docs): ~25 working days.

---

## Status legend

- ☐ Not started
- 🔄 In progress
- ✅ Complete (code)
- ⚠️ Complete pending user action (DB migration, OAuth setup, npm publish)
