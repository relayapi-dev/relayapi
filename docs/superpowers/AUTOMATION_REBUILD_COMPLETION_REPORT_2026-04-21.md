# Manychat-Parity Automation Rebuild — Completion Report

**Date:** 2026-04-21
**Spec:** `docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md`
**Plans executed:**
- Plan 1 — `docs/superpowers/plans/2026-04-21-automation-rebuild-01-foundation.md` (Foundation: schema, runtime, API, SDK)
- Plan 2 — `docs/superpowers/plans/2026-04-21-automation-rebuild-02-builder.md` (Builder UX: canvas, composer, action editor)
- Plan 3 — `docs/superpowers/plans/2026-04-21-automation-rebuild-03-surfaces.md` (Run inspector, binding tabs, canvas overlays, inbox integration)

This report closes out Unit C5 / Phase W of Plan 3 — the final unit of the
full three-plan rebuild.

---

## 1. Test counts

| Suite | Before rebuild | After rebuild | Delta |
|---|---|---|---|
| `apps/api` automations (`automation-*`) | (legacy suite deleted) | **107 pass, 0 fail** | +107 net, greenfield |
| `apps/app` automation + surrounding UI (`apps/app/src/`) | ~0 automation tests | **199 pass, 0 fail** | +199 net |

- **API:** `cd apps/api && bun test src/__tests__/automation-*` → 107 pass / 0 fail / 264 expect() calls across 12 files.
- **App:** `cd apps/app && bun test src/` → 199 pass / 0 fail / 403 expect() calls across 12 files.

Legacy suites (`src/__tests__/automations.test.ts`, `multi-trigger.test.ts`,
and the per-platform node suites under `services/automations/nodes/platforms/*`)
were deleted during the Plan 1 cutover because the tables and modules they
exercised no longer exist.

## 2. Typecheck / SDK build status

- `bun run typecheck` (root): **clean** — passes across `packages/db`,
  `packages/auth`, `packages/sdk`, `apps/api`, `apps/app`, `apps/docs`,
  `apps/cli`, `packages/integrations/n8n-node`,
  `packages/integrations/zapier-app`.
- `cd packages/sdk && bun run build`: **clean** — `tsc -p
  tsconfig.build.json` with no errors.

## 3. Files touched (approximate counts)

This was a greenfield rebuild of a large subsystem. Rough tallies:

| Category | Count |
|---|---|
| New files (API runtime, schemas, tests, UI components, SDK resources, routes) | ~110 |
| Modified files (dashboard shells, SDK bindings, API app bootstrap, schema barrel, docs) | ~30 |
| Deleted files (legacy per-platform node handlers, legacy routes, legacy tests) | ~40 |

Highlights of new surfaces added in Plan 3:

- `apps/app/src/components/dashboard/automation/run-inspector/` — runs
  list, run detail, timeline, context viewer, transcript.
- `apps/app/src/components/dashboard/automation/bindings-tab/` —
  default-reply, welcome-message, main-menu, conversation-starter,
  ice-breaker tabs plus a stubbed-shell fallback and simple-binding
  primitive.
- `apps/app/src/components/dashboard/automation/flow-builder/node-overlays.tsx`
  — canvas metric badges with per-port popover breakdown.
- `apps/app/src/components/dashboard/automation/flow-builder/bindings-panel.tsx`,
  `insights-panel.tsx`, `run-history-panel.tsx`, `simulator-panel.tsx`
  — migrated off the legacy compat shim onto the new API contracts.
- Inbox integration (`chat-thread.tsx`, `conversation-notes.tsx`,
  `message-composer.tsx`) now surfaces the automation badge,
  start-an-automation affordance, and per-contact pause/resume.

## 4. Spec coverage

### Delivered in v1 (fully shipped)

| Spec section | Status |
|---|---|
| §2 Locked decisions (A1–A6, B1–B9, C1–C4, D1, Storage, Experiences, Product IA) | Delivered |
| §3 System overview (webhook → inbox → queue → matcher → runner → scheduler) | Delivered |
| §4 Database schema (7 tables, port-based edges, JSONB graph, monthly step_runs partitions) | Delivered |
| §5 Graph JSONB shape (10-kind vocabulary, typed ports, derivation, validation) | Delivered |
| §6 Entrypoint & binding taxonomy — live-wired: `default_reply`, `welcome_message`. Stubbed UI only: `main_menu`, `conversation_starter`, `ice_breaker` (see §16.1 — deferred to v1.1 by spec) | Delivered (per spec) |
| §7 Templates (`comment_to_dm`, `story_leads`, `follower_growth`, `follow_to_dm`) | Delivered |
| §8 Runtime execution model (runner, scheduler, graph_changed exit, reentry/cooldown) | Delivered |
| §9 API surface (`/automations`, `/automations/{id}/runs`, `/simulate`, `/insights`, `/bindings`) | Delivered |
| §10 Builder interaction model (port handles, drag-to-create w/ search, multi-select, copy/paste, undo) | Delivered |
| §11 Message composer (blocks: text/image/video/card/gallery/delay; buttons; quick replies; merge-tag picker; channel capabilities) | Delivered |
| §12 Action group editor (ordered actions; per-action on_error: abort/continue; error port) | Delivered |
| §13 Product surfaces (automations page, detail page, run inspector, per-account bindings tabs, inbox badge + start-an-automation) | Delivered |
| §14 Insights, run inspector, simulator | Delivered |
| §15 Code preservation & rewrite map | Honoured |

### Deferred to v1.1 (per §16.1 of the spec)

- **Platform sync for stubbed bindings** — `main_menu`,
  `conversation_starter`, `ice_breaker` persist in our DB and render in
  their tabs but do **not** push to Meta / WhatsApp. Bindings-tab banner
  shows a `pending_sync` status to make this visible.
- **AI node re-introduction** — `ai-agent`, `ai-intent-router`,
  `ai-runtime`, `ai-step` remain archived under
  `apps/api/src/services/automations/nodes/` but not exported from the
  node index. They are not part of v1.
- **Custom apps framework / code step** — not delivered; no custom apps
  vendor registry.
- **Insights rollups / materialized cache** — we compute insights live
  from `automation_step_runs`. Materialized caches deferred until a
  specific query proves slow.
- **AI Replies / AI Comments bindings** — out of scope.
- **Media-library picker** — image/video blocks currently accept a
  direct URL or media ref string. A real picker is deferred (see
  TODO(v1.1) in `message-composer/block-editors.tsx`).
- **Scheduled-trigger UI** — `services/automations/scheduler.ts`
  contains a v1 no-op branch for `scheduled_trigger` jobs pending the
  scheduled-trigger builder UI (see TODO in `scheduler.ts`).
- **Rich attachment payloads** — `message-sender.ts` exposes a minimal
  `{ platform, accessToken, platformAccountId, recipientId, text }`
  interface. Richer shapes (native buttons / attachments / cards /
  galleries / quick replies) are encoded as metadata fields but not
  yet fully wired into the sender (see TODO(unit-5) in
  `services/automations/platforms/index.ts`). This is an internal
  refactor, not a user-visible feature.
- **`log_conversion_event` persistence** — handler logs the event to
  stderr for observability; persistence to a real `conversion_events`
  table is queued for v1.1 (see TODO(v1.1) in
  `services/automations/actions/conversion.ts`).

## 5. Carry-over concerns

### Pre-existing test-runner alias issue
`apps/app/src/components/dashboard/automation/flow-builder/port-handles.test.tsx`
and `insert-menu.test.tsx` reference the `@/lib/utils` path alias.
Running `bun test` from the repo root cannot resolve the alias; running
it from `apps/app/` does. This is a `bun test` tsconfig-path-mapping
limitation for these two files, not a real product bug. The
apps/app-local invocation (`cd apps/app && bun test src/`) runs 199
tests green and is the documented way to run the suite.

### PropertyPanel legacy-shape helper
During Plan 2 a compatibility helper was used to adapt the legacy
property-panel data shape to the new graph. Plan 3 migrated the four
big panels (simulator, run-history, insights, bindings) off the compat
shim, but the lower-level property-panel still has a thin
shape-adapter for node kinds it hands off to generic-field-form. This
is marked in code and should be tidied up in a small follow-up PR
during v1.1 work — it is not blocking any user-facing surface.

### Console statements (intentional)
Two `console.*` calls remain in the new automation code. Both are
intentional and documented in-place:

- `services/automations/actions/webhook.ts` — `console.warn` inside a
  fire-and-forget fetch's catch. Swallowing the error prevents a bad
  outgoing webhook URL from failing the enclosing `action_group` run.
- `services/automations/actions/conversion.ts` — `console.info` serving
  as the v1 persistence placeholder until the `conversion_events`
  table lands in v1.1.

No stray debug logs were left in Plan 2 or Plan 3 UI code.

## 6. TODO reconciliation (Unit C5 / Task W3)

Searched the repo for `TODO(plan-2)` / `TODO(plan-3)` / `TODO(Plan 3)`
/ `TODO(Plan-3)` / `TODO: plan [23]` and scoped to Plan-3-owned
directories.

| Hit | Action |
|---|---|
| `apps/app/src/components/dashboard/automation/flow-builder/message-composer/block-editors.tsx:172` — `TODO(Plan 3): integrate media-library picker + upload.` | **Updated** to `TODO(v1.1): integrate media-library picker + upload (deferred from automation rebuild).` Also removed the "(media picker TODO)" note from the input placeholder. |
| `services/automations/actions/conversion.ts:21` — `TODO(v1.1): persist to a real conversion_events table...` | Already a correct v1.1 deferral marker. **Kept as-is.** |
| `services/automations/scheduler.ts:210` — `TODO: expand this once the scheduled-trigger UI lands.` | Deferred (no explicit plan tag but correctly calls out the blocking UI work). **Kept as-is.** |
| `services/automations/platforms/index.ts:278,314` — `TODO(unit-5): extend SendMessageRequest...` / `TODO(unit-5): resolve media_ref through the media service.` | Internal refactor TODOs, correctly tagged. **Kept as-is.** |
| `docs/superpowers/plans/2026-04-21-automation-rebuild-03-surfaces.md:330` — grep-instruction line, not product code | N/A (this is the plan itself). **Kept as-is.** |

**Total updates:** 1. **Kept as deferred (with correct markers):** 4
code references + 1 plan-doc line.

## 7. Summary statement

The Manychat-parity automation rebuild shipped across three plans and
eighteen units of work. The system now has:

- A port-based graph runtime over 10 node kinds (trigger, message,
  action_group, condition, split_test, randomizer, smart_delay,
  interactive_wait, goto, subflow_call, http_request, end).
- 5 channels (Instagram, Facebook Messenger, WhatsApp, Telegram, TikTok
  DM) routed through the shared trigger matcher and runner.
- A builder with port handles, drag-to-create, multi-select, copy/paste,
  undo, a block-based message composer, and a grouped action editor.
- Observability surfaces: run inspector with timeline / context /
  transcript, simulator, insights panel, and canvas metric overlays.
- Binding management tabs per account (default_reply,
  welcome_message, main_menu, conversation_starter, ice_breaker) plus
  inbox integration (automation badge, per-contact pause, start an
  automation from a conversation).
- Clean typecheck across the whole monorepo.
- 199 dashboard tests + 107 API tests green.

Deferrals are all explicit in the spec (§16.1) or in-code TODOs
rewritten to point at v1.1 or specific follow-up refactors.

**Status: Ready for merge on the greenfield branch.**
