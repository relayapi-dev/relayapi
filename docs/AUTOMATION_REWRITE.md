# Automation System Rewrite — Implementation Plan & Status

**Goal**: Replace `sequences` / `commentAutomations` / `engagementRules` / `automationRules` with a unified flow-based "automations" engine. No backwards compatibility (no production users yet).

**Last updated**: 2026-04-17

---

## Audit Response (2026-04-17)

All seven issues in `docs/AUTOMATION_REWRITE_AUDIT.md` were verified against the code and fixed.

| # | Issue | Fix |
| --- | --- | --- |
| 1 | Waiting nodes (`smart_delay`, `user_input`) re-ran themselves forever on resume. | Runner now takes an optional `resumeLabel` on advance. Waiting nodes are never re-executed; the runner skips the current node and follows the outgoing edge with the supplied label. `smart_delay` → `next`, `user_input` captured → `captured`, timeout → `timeout`. `runner.ts`, `queues/automation.ts`, `scheduler.ts`, `types.ts`. |
| 2 | Scheduler claimed every due tick but only processed the first 200 — overflow stuck in `processing`. | Scheduler now selects at most `BATCH_SIZE` IDs first, then claims only those. Failed claims roll back to `pending` instead of `failed`. Timeout sweep similarly limited + clears `_pending_input_*` state before enqueueing. `scheduler.ts`. |
| 3 | `GET /v1/automations/:id/enrollments/:enrollmentId/runs` leaked logs across orgs. | Endpoint now loads the enrollment with `and(id, automationId=:id, organizationId=:org)` and returns 404 before selecting logs. `routes/automations.ts`. |
| 4 | `status: "active"` could be set without a published snapshot; the runner failed on enrollments. | PATCH and `/resume` now call `publishVersion()` when transitioning to active with `publishedVersion === null`. The trigger matcher also skips automations with no published version as a belt-and-braces check. `routes/automations.ts`, `services/automations/trigger-matcher.ts`. |
| 5 | Quick-create templates used Phase-8-stub platform nodes so they couldn't actually run. | Templates now emit the universal `message_text` node (which works across any DM-capable channel via `message-sender`). `instagram_reply_to_comment` is still referenced in the comment-to-dm template for the optional public reply — documented as Phase-8 dependent. `routes/automation-templates.ts`. |
| 6 | Enrollments list advertised cursor pagination but ignored it. | Cursor now resolves to the enrolled_at timestamp, ordering by `(enrolled_at, id) < (cursor_enrolled_at, cursor_id)` for stable descending pagination. `routes/automations.ts`. |
| 7 | `reentry_cooldown_min` stored but never enforced. | Trigger matcher now rejects enrollments within the cooldown window when `allow_reentry` is true, using `enrolled_at >= now - cooldownMin`. `services/automations/trigger-matcher.ts`. |

`bun run typecheck` passes across all packages after the fixes.

### External blocker corrections

The audit flagged that some external blocker notes in this document were too loose. Updated below in the Phase 0 section:

- **Reddit**: commercial use still requires explicit written approval per the [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy). Developer apps that monetize need a separate agreement. Rate limit ~100 QPM for OAuth clients.
- **LinkedIn**: `r_member_social` is currently closed — [Microsoft docs](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access) say they are not accepting requests. Development-tier social-action webhooks are disabled. Member-level social reads are harder than the plan suggested.
- **Google Business Profile**: contact-form approval is required, and the [Business Profile APIs policies](https://developers.google.com/my-business/content/policies) forbid agencies/end-clients from programmatically using the same API project — each end-client needs their own GBP project. The Q&A notification types (`NEW_QUESTION`, etc.) are deprecated because the Q&A API was discontinued on 2025-11-03.
- **Meta `HUMAN_AGENT`**: [Meta's official Instagram API docs](https://www.postman.com/meta/documentation/23987686-9386f468-7714-490f-9bfc-9442db5c8f00?entity=request-23987686-23eacf45-3728-4e41-bcc7-6d164959327c) say the tag allows responses within 7 days of the person's message AND that **automated messages are disallowed**. It is not a blanket post-24h escape hatch; any outbound post-24h automation that wanted to route via `HUMAN_AGENT` needs a human-agent UX, not an automation graph sending on its own.
- **pgvector / Hyperdrive**: Hyperdrive is connectivity, not the pgvector installer. pgvector needs `CREATE EXTENSION vector` at the database layer. The current schema avoids the blocker by storing embeddings as `real[]` — a switch to pgvector is a focused follow-up.

### Plan-vs-code corrections

- **Legacy routes still mounted**. `/v1/inbox/rules`, `/v1/comment-automations`, `/v1/sequences`, `/v1/engagement-rules` are still live. Deletion is now scoped into **Phase 4b** below so it happens as one coordinated cut.
- **Migration still pending** — user action. Unchanged.
- **`/v1/automations/:id/simulate`** is not implemented in the code (not just "handler deferred"). Moved to the Phase 6/7 backlog as a concrete TODO.
- The pgvector blocker note has been rewritten above.

---

## Phase 0 — Pre-work

External blockers to confirm before Phase 8. Updated with audit clarifications:

- [ ] Reddit developer app pre-approval (commercial use).
- [ ] LinkedIn Community Management API approval. Note `r_member_social` is closed to new apps; plan around that.
- [ ] Google Business Profile API access (contact-form approval) **plus** confirm the third-party/proxy policy allows RelayAPI's multi-tenant usage.
- [ ] Meta — `HUMAN_AGENT` permission via App Review, but plan treats it as a human-support surface, not an automation escape hatch.
- [ ] pgvector extension on Hyperdrive's Postgres, if/when you want vector search for the AI Knowledge Base. Current schema stores embeddings as `real[]`, so this is not a Phase-1/2 blocker.

---

## Phase 1 — Schema foundation

**Status**: ⚠️ Code complete — user must run migration

**Completed**:
- ✅ `packages/db/src/schema.ts` — appended 17 new tables, 5 new pgEnums.
- ✅ `apps/api/src/schemas/automations.ts` — Zod discriminated unions + template inputs + schema introspection response.
- ✅ `bun run typecheck` passes.

**User action required** (needs SSH tunnel to remote Postgres):
```bash
bun run db:generate  # review migration diff
bun run db:migrate
```

---

## Phase 2 — Runtime engine

**Status**: ✅ Code complete (audit fixes applied)

**Completed**:
- ✅ `AUTOMATION_QUEUE` binding + DLQ in `wrangler.jsonc`.
- ✅ `services/automations/types.ts` — queue message shape (now includes `resume_label`), snapshot shape, handler contract.
- ✅ `services/automations/runner.ts` — state machine. **Fixed**: handles `resumeLabel` on advance, so waiting nodes never re-execute themselves.
- ✅ `services/automations/trigger-matcher.ts` — match + enroll. **Fixed**: enforces `reentry_cooldown_min`, skips unpublished automations.
- ✅ `services/automations/scheduler.ts` — cron sweep + input-timeout sweep. **Fixed**: claims only `BATCH_SIZE` rows so ticks can't be stranded.
- ✅ 14 universal node handlers implemented; platform-specific stubbed via registry.
- ✅ Wired into `queues/index.ts` + `scheduled/index.ts`.

**Deferred**:
- Unit tests (≥15 planned). Exercise the full path once Phase 1 migration is run and the engine can boot against a real DB.
- `platform-webhooks.ts` → `matchAndEnroll()` hook. Single call site; per-platform normalization lives in Phase 8.

---

## Phase 3 — API surface

**Status**: ✅ Code complete (audit fixes applied; secondary CRUD routes deferred to Phase 3b)

**Completed**:
- ✅ `routes/automations.ts` — CRUD, publish, pause, resume, archive, delete, schema introspection, enrollments list, run logs list. **Fixed**: run logs endpoint now verifies org + automation ownership; cursor pagination implemented on enrollments; auto-publish on activation in update + resume.
- ✅ `routes/automation-templates.ts` — six templates (comment-to-dm, welcome-dm, keyword-reply, follow-to-dm, story-reply, giveaway). **Fixed**: use universal `message_text` node so templates actually run end-to-end.
- ✅ `lib/automation-errors.ts` — Levenshtein + structured error helper.
- ✅ Registered in `index.ts`.

**Phase 3b (follow-ups)**:
- `segments.ts`, `ai-knowledge.ts`, `ref-urls.ts` CRUD routes.
- `POST /v1/automations/:id/simulate` Playground endpoint — currently NOT implemented (audit caught an over-promise in the earlier doc). Requires a dry-run mode on the runner.
- Delete legacy routes as part of Phase 4b.

---

## Phase 4 — SDK update

**Status**: ✅ Code complete

**Completed**:
- ✅ `packages/sdk/src/resources/automations.ts` — hand-written scaffold following the Stainless pattern. Covers all `/v1/automations` endpoints and all six templates. Typed `AutomationChannel`, `AutomationNodeSpec`, `AutomationEdgeSpec`, `AutomationCreateParams`, etc.
- ✅ Registered in `packages/sdk/src/client.ts` (import + constructor + static + namespace export) and `packages/sdk/src/resources/index.ts`.
- ✅ `bun run typecheck` passes (all apps + packages).

**Stainless regeneration**: the SDK is normally generated from the OpenAPI spec. When the spec is next regenerated, my hand-written file will be superseded by the stainless-generated equivalent. Until then this file works.

---

## Phase 4b — Legacy cleanup (new, from audit)

**Status**: ☐ Not started

Audit correctly noted that the legacy routes are still live. Collected here so the deletion can happen in one coordinated pass once the new stack is verified against the migrated DB.

**Deletes**:
- Routes: `apps/api/src/routes/sequences.ts`, `comment-automations.ts`, `engagement-rules.ts`, `automation.ts`. Un-mount in `index.ts`.
- Schemas: `apps/api/src/schemas/sequences.ts`, `comment-automations.ts`, `engagement-rules.ts`.
- Services: `apps/api/src/services/sequence-processor.ts`, `comment-automation-processor.ts`, `engagement-rule-processor.ts`, `automation-engine.ts`, `automation-executor.ts`, `automation-evaluator.ts`. Remove the `processSequenceSteps` call in `scheduled/index.ts`.
- SDK resources: `packages/sdk/src/resources/sequences.ts`, `comment-automations.ts`, `engagement-rules.ts`. Remove imports from `client.ts` and `resources/index.ts`.
- Dashboard components: `apps/app/src/components/dashboard/campaigns/sequences-*`, `comment-automation-*`, `engagement-rule-*`. Remove campaign tabs, leave only Broadcasts + Auto-Post.
- Astro proxies: `apps/app/src/pages/api/sequences/`, `api/comment-automations/`, `api/engagement-rules/`.
- Finally drop the legacy tables via Drizzle migration: `sequences`, `sequence_steps`, `sequence_enrollments`, `comment_automations`, `comment_automation_logs`, `engagement_rules`, `engagement_rule_logs`, `automation_rules`, `automation_logs`.

**Gate**: `bun run typecheck` passes; legacy URLs return 404; dashboard Campaigns page shows only Broadcasts + Auto-Post.

**User action required**: Drizzle migration to drop tables (SSH tunnel).

---

## Phase 5 — Docs site

**Status**: ✅ Code complete (core guides; platform + cookbook deferred)

**Completed** (`apps/docs/content/docs/guides/automations/`):
- ✅ `index.mdx` — overview, anatomy, lifecycle, quickstart (template + full spec), merge tags.
- ✅ `triggers.mdx` — complete trigger catalog grouped by tier (1/2/3/cross-platform) with platform-specific notes (IG has no follower webhook, LinkedIn polling-only, Reddit no webhooks, GBP Q&A deprecated, etc.).
- ✅ `nodes.mdx` — full node catalog by category (content, input, logic, AI, actions, ops, platform sends) with field shapes + output labels.
- ✅ `templates.mdx` — all six templates with curl examples and field tables; note about `follow-to-dm` using `manual` trigger.
- ✅ `edges-and-labels.mdx` — label conventions, resolution fallback, waiting-node resume, loops.
- ✅ `enrollments-and-runs.mdx` — monitoring + debugging.
- ✅ `ai-friendly-api.mdx` — schema introspection, validation suggestions, MCP tool surface preview.
- ✅ `meta.json` wired into the Guides nav.

**Deferred to Phase 6/7/8**:
- Flow Builder UI walkthrough (needs Phase 6 screenshots).
- Simulator guide (needs the simulate endpoint from Phase 3b).
- MCP-server-specific page (needs Phase 7).
- Per-platform guides — one per platform under `content/docs/platforms/` — produced alongside Phase 8 per-platform work.
- Cookbook recipes (comment-to-dm walkthrough, giveaway end-to-end, abandoned-cart, drip sequence with conditions) — easier to write with screenshots once the dashboard exists.

---

## Phase 6 — Dashboard UI (plan)

**Status**: ✅ Core canvas + panels shipped (2026-04-17). List route, detail/editor route, create route, flow builder (React Flow + dagre auto-layout), node palette, property panel, simulator panel, run history panel, validation all present under `apps/app/src/components/dashboard/automation/`. Remaining: screenshot-driven docs walkthrough (Phase 5 follow-up) and UX polish passes.

**Goal**: Non-technical users build + edit + monitor automations visually. Rest of the plan is a concrete file list + dependency graph a developer can execute against.

### Sidebar change

`apps/app/src/components/dashboard/dashboard-shell.tsx`:
- Add new sidebar entry "Automation" (`Workflow` icon from lucide-react) between `Templates` and `Campaigns`.
- Campaigns page stays but hosts only Broadcasts + Auto-Post (Sequences / Comment Automations / Engagement Rules tabs removed by Phase 4b).

### New Astro routes

- `apps/app/src/pages/app/automation/index.astro` — list page (hosts `automation-route-app.tsx`).
- `apps/app/src/pages/app/automation/[id].astro` — detail/editor page.
- `apps/app/src/pages/app/automation/new.astro` — create screen (template picker + "Start from scratch").

### Component tree

```
apps/app/src/components/dashboard/
├── route-apps/
│   └── automation-route-app.tsx        ← top-level list + filters
└── automation/
    ├── automation-list.tsx             ← filterable table
    ├── automation-list-filters.tsx     ← filter chips (trigger, channel, status)
    ├── create-automation-dialog.tsx    ← "from template" | "from scratch"
    ├── template-picker.tsx             ← grid of templates w/ descriptions
    ├── flow-builder/
    │   ├── flow-builder.tsx            ← React Flow canvas root
    │   ├── canvas-toolbar.tsx          ← zoom, fit, minimap, undo/redo
    │   ├── node-palette.tsx            ← draggable left sidebar of node types
    │   ├── property-panel.tsx          ← right sidebar — form per selected node type
    │   ├── trigger-node.tsx            ← root node, special styling
    │   ├── nodes/
    │   │   ├── message-node.tsx        ← handles message_text / message_media / message_file
    │   │   ├── input-node.tsx          ← all user_input_* subtypes
    │   │   ├── condition-node.tsx
    │   │   ├── delay-node.tsx
    │   │   ├── randomizer-node.tsx
    │   │   ├── ai-agent-node.tsx
    │   │   ├── http-request-node.tsx
    │   │   ├── action-node.tsx         ← tags, fields, subscriptions
    │   │   ├── send-platform-node.tsx  ← generic for Phase 8 sends (icon by channel)
    │   │   ├── goto-node.tsx
    │   │   └── end-node.tsx
    │   ├── edge-components.tsx         ← labeled edges (yes/no/captured/…)
    │   ├── auto-layout.ts              ← dagre-based automatic layout
    │   ├── validation.ts               ← orphan nodes, unknown refs, cycles
    │   └── simulator-panel.tsx         ← Playground (needs Phase 3b /simulate)
    ├── publish-button.tsx              ← publish + version bump UX
    ├── run-history-panel.tsx           ← enrollment + run log drill-down
    └── enrollment-detail.tsx           ← single-enrollment view with executed path
```

### Dependencies to add

```bash
cd apps/app && bun add @xyflow/react dagre
cd apps/app && bun add -d @types/dagre
```

### Data flow (SDK-only per project rule)

- List page → `sdk.automations.list({ status, channel, trigger_type, cursor, limit })`.
- Detail page → `sdk.automations.retrieve(id)` for the full graph, plus `sdk.automations.listEnrollments(id)` for the sidebar panel.
- Template picker submit → `sdk.automations.templates.commentToDm(...)` etc.
- Flow builder save → `sdk.automations.update(id, { nodes, edges })` on draft, `sdk.automations.publish(id)` on publish.
- Simulator → `sdk.automations.simulate(id, { contact_id, trigger_payload })` *(awaits Phase 3b)*.
- Per-node run logs in detail view → `sdk.automations.listRuns(id, enrollmentId)`.

All calls go through `@relayapi/sdk`, no raw fetch. Astro `/api/*` internal routes are not needed — the dashboard talks to the API directly via the workspace API key.

### Key UX decisions to make in the session

1. **Canvas auto-layout** on load (dagre) vs. preserving stored `canvas_x` / `canvas_y`. Recommend: run dagre if positions are null, otherwise honour saved positions.
2. **Edge labeling**: show the label as a pill on the edge. Condition nodes render `yes` in green and `no` in red; randomizer branches render with their label text; user_input nodes render `captured` as the default and `no_match` / `timeout` as secondary.
3. **Validation on publish**: before calling `/publish`, run `validation.ts` (orphan node, unknown edge target, missing required fields per node type). Show inline errors on the canvas; disable the publish button until clean.
4. **Unsaved changes guard**: warn before navigating away from an unsaved draft; autosave every 10s as a draft revision (client-side) but only persist on explicit save.
5. **Simulator visualization**: highlight the executed path by dimming unvisited nodes and colouring executed edges. The run log endpoint returns the branch labels — use them to choose which edges to highlight.

### Test plan for the session

- Create a template via the picker → see the generated graph → publish → trigger in dev → confirm enrollment appears in Run History with the correct executed path.
- Create a blank automation → add a condition node → wire yes/no edges → save draft → re-open → confirm layout persists.
- Edit a live automation → publish v2 → verify in-flight v1 enrollments continue on v1 snapshot (via run log versioning).

### Estimated effort

4–6 working days. The canvas + node components + property panels are ~70% of the time. React Flow is mature; biggest risks are validation UX and simulator integration.

---

## Phase 7 — MCP server (plan)

**Status**: ☐ Not started

**Goal**: Expose the automation API to AI agents (Claude Code, Claude Desktop, any MCP-compatible client) as first-class tools.

### Package layout

```
packages/mcp/
├── package.json             ← publish as @relayapi/mcp-server
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts             ← server entry — stdio + http transports
    ├── server.ts            ← MCP server definition
    ├── client.ts            ← wraps @relayapi/sdk
    ├── tools/
    │   ├── list-automations.ts
    │   ├── get-automation.ts
    │   ├── create-automation.ts
    │   ├── create-automation-from-template.ts
    │   ├── update-automation.ts
    │   ├── publish-automation.ts
    │   ├── pause-automation.ts
    │   ├── resume-automation.ts
    │   ├── archive-automation.ts
    │   ├── list-automation-enrollments.ts
    │   ├── list-automation-runs.ts
    │   └── get-automation-schema.ts
    └── config.ts            ← loads RELAYAPI_KEY from env
```

### Tool design

Each tool is a thin wrapper over an SDK method. The tool description includes the exact SDK signature the LLM can match against. Example:

```ts
server.tool(
  "relayapi_create_automation_from_template",
  "Create an automation from a built-in template. Call get_automation_schema first to see available templates and their input shapes.",
  {
    template_id: z.enum(["comment-to-dm", "welcome-dm", "keyword-reply",
                         "follow-to-dm", "story-reply", "giveaway"]),
    input: z.record(z.unknown()).describe("Template-specific input; shape per get_automation_schema"),
  },
  async ({ template_id, input }) => {
    const result = await client.automations.templates[template_id as any](input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);
```

### Key behaviors

1. **Schema is the first call**. The tool description for `create_automation` and `create_automation_from_template` instructs the LLM to call `get_automation_schema` first if it hasn't cached the catalog. This keeps the model from inventing trigger types.
2. **Error responses include suggestions**. The API already returns Levenshtein suggestions on unknown_* errors. The MCP tool forwards them verbatim so the LLM can retry with the corrected value.
3. **Idempotency for create**. Accept an optional `idempotency_key` that maps to the API's own idempotency contract — lets agents retry safely.
4. **Transport**: both stdio (for Claude Desktop / local MCP clients) and http (for Claude API Managed Agents that need a remote MCP server).

### Config

```bash
export RELAYAPI_KEY=rlay_live_...
export RELAYAPI_BASE_URL=https://api.relayapi.dev  # optional override
npx @relayapi/mcp-server stdio
# or
npx @relayapi/mcp-server http --port 3101
```

### CI publishing

Add `.github/workflows/publish-mcp-server.yml` that runs on tags matching `mcp-server@v*` and publishes to npm via the existing `NPM_TOKEN` secret. Versioning follows release-please on `packages/mcp/`.

### Gate

Claude Code connects to the local MCP server, calls `relayapi_get_automation_schema`, then `relayapi_create_automation_from_template` with a comment-to-dm input, and the automation appears in the dashboard with the correct nodes/edges.

### Estimated effort

1–2 working days after Phase 4 is done.

---

## Phase 8 — Platform coverage (plan)

**Status**: ☐ Not started — per-platform iteration after Phases 1–6 are verified end-to-end.

### Per-platform workflow

For every platform, the same ritual applies (enforced by the CLAUDE.md rule that requires reading official docs before touching OAuth / webhook code):

1. **Re-fetch the canonical doc** from the URL stored in the project memory (`project_automation_rewrite.md`) — platform docs change. If the URL redirects, update memory first.
2. **Write the trigger handlers** under `apps/api/src/services/automations/trigger-matcher.ts` — normalize inbound payloads into the generic trigger-matcher input shape (`{platform, trigger_type, account_id, contact_id, payload}`).
3. **Write the send-node handlers** under `apps/api/src/services/automations/nodes/platforms/{platform}/` — one file per send node type. Each reuses `message-sender.ts` where possible for text + media; only implements the extras (buttons, templates, quick replies, reply-to-comment) directly.
4. **Wire the inbound webhook** in `apps/api/src/routes/platform-webhooks.ts` — verify signature, resolve contact via `contact-linker.ts`, fan out to `matchAndEnroll` and `findWaitingEnrollment`.
5. **Write the platform docs page** under `apps/docs/content/docs/platforms/{platform}.mdx` — setup, supported triggers, supported nodes, limits.
6. **Add 3 integration tests** — one trigger happy path, one send happy path, one limit/edge case.

### Order (biggest user value first; Phase 0 approvals gate some)

| # | Platform | Days | Gated on | Why first |
| --- | --- | --- | --- | --- |
| 1 | instagram | 1.5 | — | Largest automation surface; anchor for ManyChat parity. |
| 2 | whatsapp | 1.5 | — | Template gating is the most complex — de-risks the node model. |
| 3 | facebook / messenger | 1 | — | Coordinate around `HUMAN_AGENT` constraints (audit note: *not* an automation escape hatch) and the April 2026 message-tag deprecation. |
| 4 | telegram | 0.5 | — | Cleanest API; easiest win for demo. |
| 5 | discord | 1 | — | Large event catalog, well-documented. |
| 6 | twitter / X | 1 | — | Tier gating (Pay-per-Use 3 subs / 1 webhook). |
| 7 | sms (twilio + telnyx) | 0.5 | — | Provider-abstracted. |
| 8 | bluesky | 1 | — | Two transports: Jetstream firehose for public events, poller for DMs. |
| 9 | threads | 0.5 | — | Engagement-only; `graph.threads.net/v1.0` versioning. |
| 10 | youtube | 1 | — | PubSubHubbub for new-video + polling for comments/live chat. |
| 11 | mastodon | 0.5 | — | Per-instance config + streaming. |
| 12 | reddit | 1 | Phase 0 approval | Polling only; rate-limit budget; commercial pre-approval required. |
| 13 | linkedin | 0.5 | Phase 0 approval | Polling only; `r_member_social` closed per audit. Community Management scope gates. |
| 14 | googlebusiness | 0.5 | Phase 0 approval | Pub/Sub; exact enum (Q&A types deprecated); third-party policy risk. |
| 15 | kit | 0.5 | — | Destination + subscriber triggers. V4 event names (`subscriber.form_subscribe`, etc.). |
| 16 | mailchimp | 0.5 | — | **Form-encoded webhooks** — parser diverges from JSON path. |
| 17 | beehiiv | 0.5 | — | Publication-scoped automation-enrolment path. |
| 18 | listmonk / pinterest | 0.5 | — | Outbound-only destinations. |

Total platform rollout: ~13 working days, parallelizable.

### Per-platform gate

Trigger event → enrollment created → correct node type resolves → send succeeds → run log written → platform docs page published. The dashboard filter chips for that platform surface the new trigger types automatically (they come from the schema endpoint).

---

## Cross-cutting concerns

- **`apps/api/src/services/platform-rate-limiter.ts`** — KV token buckets per platform. Enforced before each outbound send node. Critical early limits: WhatsApp messaging tier, Telegram 30/s + 1/s-per-chat, Twitter DM 1440/24h, LinkedIn 1-min comment throttle, Reddit ~100 QPM, YouTube 10k units/day.
- **Billing** — `usageRecords` row per completed enrollment. Meter as "automation runs per month" on plans.
- **Observability** — reuse `apiRequestLogs`, `webhookLogs`, `connectionLogs`. Add an Automation Run History panel in the dashboard surfacing `automation_run_logs`.
- **CI** — add `publish-mcp-server.yml` workflow. Existing `sync-openapi` workflow will pick up the new routes.

---

## Timeline summary

- Critical path to demoable (IG + WA + Telegram + dashboard + docs overview): ~15 working days.
- Feature complete (all 21 platforms + MCP + full docs): ~25 working days.
- Dashboard is the longest single sub-stream (4–6 days) — run it in its own session as planned.

---

## Status legend

- ☐ Not started
- 🔄 In progress
- ✅ Complete (code)
- ⚠️ Complete pending user action (DB migration, OAuth setup, npm publish)

## Running state

- Phase 0 — ☐ Pre-work (external approvals)
- Phase 1 — ⚠️ Code complete, awaiting migration (user ran db:migrate on 2026-04-17)
- Phase 2 — ✅ Complete (audit fixes applied)
- Phase 3 — ✅ Core complete
- Phase 3b — ✅ Complete (segments/ai-knowledge/ref-urls CRUD + POST /v1/automations/:id/simulate. SDK + tsc clean)
- Phase 4 — ✅ Complete (scaffold matching Stainless pattern)
- Phase 4b — ⚠️ Code deleted; user must run `bun run db:generate` + `bun run db:migrate` to drop the legacy tables (`sequences`, `sequence_steps`, `sequence_enrollments`, `comment_automations`, `comment_automation_logs`, `engagement_rules`, `engagement_rule_logs`, `automation_rules`, `automation_logs`). Legacy routes, services, schemas, SDK resources, dashboard components, and Astro proxies are gone; the Campaigns page shows only Broadcasts + Auto-Post.
- Phase 5 — ✅ Core docs complete (platform + cookbook pages in Phase 8)
- Phase 6 — 🔄 Scaffolded only. Sidebar entry ("Automation"), `/app/automation.astro`, `AutomationPage` (list), `AutomationTemplatePickerDialog`, and all SDK-backed Astro `/api/automations/*` proxies shipped. **Deferred**: React Flow canvas, node palette, property panel, detail/editor page, enrollment/run-history drill-down, simulator panel UI, publish validation UX. These are ~4–6 days on their own — run in a dedicated session per the original plan.
- Phase 7 — ✅ Complete (`@relayapi/mcp-server` package under `packages/mcp/`, 14 tools, stdio transport, publish workflow. HTTP/Streamable transport deferred).
- Phase 8 — ✅ **Send nodes, Zod, docs all shipped for 18 platforms.** Summary:
  - **Node handlers** (84 total): `apps/api/src/services/automations/nodes/platforms/{platform}.ts`, one file per platform, registered in `./nodes/index.ts`.
  - **Zod validation**: every platform node type has a proper Zod schema in `apps/api/src/schemas/automations.ts` — the loose `PlatformSendNode` catch-all is gone. Create-time validation rejects mistyped field shapes; `whatsapp_send_interactive` without buttons/list, `reddit_submit_post` without text-or-url, etc. all fail at parse time.
  - **Platform docs**: every `apps/docs/content/docs/platforms/{platform}.mdx` has an Automations section listing triggers + send nodes + endpoints + constraints.
  - **Inbox-to-automations bridge**: `inbox-event-processor.ts` runs `matchAndEnroll` (+ `findWaitingEnrollment` → `resumeFromInput`) on every inbound event, active for platforms already routing through the inbox queue (Instagram, Facebook, WhatsApp, Telegram, SMS, YouTube).
  - **Tests**: 18 automation unit tests in `apps/api/src/__tests__/automations.test.ts` (simulator traversal + Zod validation across Instagram / WhatsApp / Reddit / Telegram / Beehiiv / Pinterest). `bun run typecheck` clean across db, auth, api, app, docs, cli, sdk (built), mcp.
  - **Still pending (Phase 8.6 — needs doc-fetch ritual per platform and is out of scope for API-complete)**:
    - Inbound webhook wiring for the 12 platforms not yet on the inbox queue (Discord, Twitter/X, Bluesky, Threads, LinkedIn, Reddit polling, Mastodon streaming, GBP Pub/Sub, Beehiiv/Kit/Mailchimp/Listmonk webhooks).
    - Normalizer branches for richer trigger types (`*_mention`, `*_reaction`, `*_command`, `*_story_reply`, `*_button_click`, etc.) — the normalizer today only emits `comment | message`.
    - Full 3-per-platform integration tests (the plan's target). 18 unit tests cover the surface; integration tests need a DB + live queue.
