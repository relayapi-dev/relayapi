# Automation Rebuild — Plan 3: Product Surfaces + Observability

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Spec:** `docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md` — §13 (Product Surfaces), §14 (Insights/Run Inspector/Simulator)

**Plans 1+2 status:** complete. Backend: 107 tests green. App: 120 tests green. Full monorepo typecheck clean. Detail page wired with live canvas, composer, action editor, entrypoint panel. Create-automation dialog works. Some panels (SimulatorPanel, BindingsPanel, RunHistoryPanel, InsightsPanel) still operate on legacy-shape inputs via a compat shim in the detail page — Plan 3 migrates them to the new API contracts and ships the remaining observability UIs.

**Goal:** Migrate simulator / run-history / bindings / insights panels to the new contracts, ship the run inspector + transcript viewer, add canvas metric overlays, build binding-management tabs inside the per-account (connections) page, and wire the inbox's automation badge + enroll-contact affordances.

**Architecture:** Existing dashboard + existing inbox UI. Reuse components from Plans 1 + 2. The run inspector is a new surface (two-column pane: runs list + selected-run detail). Binding tabs live inside the existing per-account detail page.

**Tech Stack:** React 19 + Astro + Tailwind + SDK. Same as Plans 1 + 2.

**Git policy:** User handles all git. Each task ends with `STOP — user commits at their discretion`.

---

## File Structure

### New files

- `apps/app/src/components/dashboard/automation/run-inspector/index.tsx`
- `apps/app/src/components/dashboard/automation/run-inspector/runs-list.tsx`
- `apps/app/src/components/dashboard/automation/run-inspector/run-detail.tsx`
- `apps/app/src/components/dashboard/automation/run-inspector/timeline.tsx`
- `apps/app/src/components/dashboard/automation/run-inspector/context-viewer.tsx`
- `apps/app/src/components/dashboard/automation/run-inspector/transcript.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/node-overlays.tsx`
- `apps/app/src/components/dashboard/automation/bindings-tab/index.tsx`
- `apps/app/src/components/dashboard/automation/bindings-tab/default-reply.tsx`
- `apps/app/src/components/dashboard/automation/bindings-tab/welcome-message.tsx`
- `apps/app/src/components/dashboard/automation/bindings-tab/main-menu.tsx`
- `apps/app/src/components/dashboard/automation/bindings-tab/conversation-starter.tsx`
- `apps/app/src/components/dashboard/automation/bindings-tab/ice-breaker.tsx`
- `apps/app/src/components/dashboard/inbox/automation-badge.tsx`

### Files to modify

- `apps/app/src/components/dashboard/automation/flow-builder/simulator-panel.tsx` — migrate to new simulator API
- `apps/app/src/components/dashboard/automation/flow-builder/run-history-panel.tsx` — migrate to `/automations/{id}/runs`
- `apps/app/src/components/dashboard/automation/flow-builder/insights-panel.tsx` — migrate to `/automations/{id}/insights`
- `apps/app/src/components/dashboard/automation/flow-builder/bindings-panel.tsx` — new bindings list / inline link to connections tab
- `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx` — add node overlay layer
- `apps/app/src/components/dashboard/pages/automation-detail-page.tsx` — drop compat shim; wire real panels directly
- `apps/app/src/components/dashboard/pages/connections-page.tsx` — add binding tabs per account
- `apps/app/src/components/dashboard/inbox/chat-thread.tsx` — add automation badge + "Start automation" button

---

## Task List

### Phase R — Panel migrations (drop legacy compat shim)

- [ ] **Task R1: Simulator panel migration**

`simulator-panel.tsx` currently operates on legacy shape. Rewrite to call `POST /api/automations/{id}/simulate` directly. Accept optional `startNodeKey`, `testContext`, `branchChoices` inputs. Render the response's `steps[]` as a vertical list with node keys, outcomes, and payloads.

Delete references to `resolveLegacyNodeOutputLabels` from this file.

Tests: if composer.test.ts pattern works, add pure-helper tests for formatting the transcript.

- STOP

---

- [ ] **Task R2: Run history panel migration**

`run-history-panel.tsx` → calls `GET /api/automations/{id}/runs` with filters: status, contact_id, started_after/before. Paginated table with cursor. Row click opens the Run Inspector (Phase S).

Replace any legacy enrollment shape with `AutomationRun` response shape.

- STOP

---

- [ ] **Task R3: Insights panel migration**

`insights-panel.tsx` → calls `GET /api/automations/{id}/insights?period=...`. Period selector (24h / 7d / 30d / 90d). Render the response:
- Tile row: enrolled / completed / exited / failed / avg_duration
- Exit reason breakdown (stacked bar or list)
- Per-entrypoint breakdown (table)
- Per-node summary (table, `node_kind` / `executions` / `success_rate`)

Chart components: use the existing dashboard chart library (check what's already used in the analytics pages; match it). If none, use plain HTML tables/bars for v1.

- STOP

---

- [ ] **Task R4: Bindings panel rewrite**

`bindings-panel.tsx` in the flow-builder context now just **shows which accounts this flow is bound to** (informational) and deep-links to the per-account bindings tab for editing.

Read bindings via `GET /api/automation-bindings?automation_id={id}`. Render a simple list:
`⚡ default_reply · IG @handle · [manage]` where "manage" links to `/app/connections/{account_id}#default-reply`.

No inline editing in this panel; editing happens in the per-account bindings tabs (Phase T).

- STOP

---

- [ ] **Task R5: Drop compat shim from detail page**

`automation-detail-page.tsx` — remove `buildLegacyDetail()` and the legacy-shape synthesis. All panels now consume the new API shape directly.

Verify each panel still renders correctly with the new shape. If any panel still needs legacy inputs, back it out to "coming soon" until it's migrated.

- STOP

---

### Phase S — Run Inspector

- [ ] **Task S1: Runs list**

`run-inspector/runs-list.tsx` — table of runs. Uses `GET /api/automations/{id}/runs`. Row click selects a run for the detail pane.

Columns: contact (show name), started_at (human-friendly relative time), status (badge), current_node_key (if waiting), duration, exit_reason. Filter controls: status (active/waiting/completed/exited/failed), date range.

Cursor pagination. Loading + empty states.

- STOP

---

- [ ] **Task S2: Run detail shell + timeline**

`run-inspector/run-detail.tsx` — header with run metadata (automation name, contact, entrypoint, started, status, current node).

`run-inspector/timeline.tsx` — vertical list of step_runs. Each step shows:
- Icon (step kind)
- Node title / kind
- Outcome (success/failed/skipped/waiting)
- Duration
- Expand click → shows `payload` JSON + `error` if any

Fetch: `GET /api/automation-runs/{id}` (metadata) + `GET /api/automation-runs/{id}/steps` (timeline).

- STOP

---

- [ ] **Task S3: Context viewer + transcript viewer**

`run-inspector/context-viewer.tsx` — read-only JSON tree view of `run.context`. Collapsible keys.

`run-inspector/transcript.tsx` — chat-bubble rendering: each message step's rendered text (outbound) and each captured input (inbound) as chat bubbles in channel styling. Reuse the `ChannelFrame` from `message-composer/preview.tsx` where styling applies.

Derived from step_runs (outbound messages' payload) + inbox_messages (inbound — fetch via `GET /api/conversations/{conversation_id}/messages` if the endpoint exists; otherwise skip inbound side and note TODO).

- STOP

---

- [ ] **Task S4: Run inspector entry point**

`run-inspector/index.tsx` — two-column layout: `runs-list` on the left, `run-detail` on the right. URL-driven selection via query param `?run_id=X`.

Wire into the detail page's Runs tab — replace the current `RunHistoryPanel` usage.

Also wire a "View on canvas" button in run-detail that switches to the Canvas tab and highlights the run's `current_node_key` on the graph.

- STOP

---

- [ ] **Task S5: Force-stop action**

In run-detail, add a "Stop run" button for runs in `active` or `waiting` state. Calls `POST /api/automation-runs/{id}/stop`. Confirm via dialog before submitting.

- STOP

---

### Phase T — Binding tabs inside per-account page

- [ ] **Task T1: Bindings tab container**

`bindings-tab/index.tsx` — a set of tabs inside `connections-page.tsx`'s per-account view. Tabs per binding type filtered by account's channel capability (per spec §13.5):
- Default Reply — all channels
- Welcome Message — all channels
- Main Menu — FB + IG only
- Conversation Starter — FB only
- Ice Breaker — WA only

Top-level route: `/app/connections/{account_id}?tab=default-reply` etc.

Each tab is a separate component (T2-T6). Tabs are filtered by the account's channel (read from the account row).

- STOP

---

- [ ] **Task T2: Default reply + Welcome message tabs**

`default-reply.tsx` and `welcome-message.tsx`. These are essentially the same UI with different binding_type:
- Shows current binding (automation picker + status badge + 7d runs + completion rate)
- "Change automation" — dropdown of flows filtered to the account's channel
- "Unbind" button
- If no binding exists, show "Not configured" + "Add binding" CTA

Uses `GET /api/automation-bindings?social_account_id={id}&binding_type=default_reply` and `POST /api/automation-bindings` / `PATCH` / `DELETE`.

Insights preview (inline): fetch `GET /api/automation-bindings/{id}/insights?period=7d` if binding exists.

- STOP

---

- [ ] **Task T3: Main menu tab (stubbed platform sync)**

`main-menu.tsx` — nested item editor. Up to 3 levels deep (per spec §6.5). Each item has: label (max 30), action (postback/url), payload, optional sub_items.

UI: tree editor (reuse any existing tree component if available; otherwise build a simple one with add-item/remove-item/indent buttons).

v1.1 note: display a warning banner: "Main menu will be pushed to Meta when v1.1 platform sync ships. For now, your configuration is saved."

Save via `POST`/`PATCH /api/automation-bindings` with `binding_type = "main_menu"`, `config = { items: [...] }`, `status = "pending_sync"`.

- STOP

---

- [ ] **Task T4: Conversation starters tab (FB only)**

`conversation-starter.tsx` — up to 4 starters. Label (max 30) + payload (free text referencing automations by slug or ID).

Same stubbed-platform-sync behavior as T3.

- STOP

---

- [ ] **Task T5: Ice breakers tab (WA only)**

`ice-breaker.tsx` — up to 4 questions. Question text (max 80) + payload.

Same stubbed-platform-sync behavior.

- STOP

---

- [ ] **Task T6: Mount tabs in connections-page**

`connections-page.tsx` — when a per-account detail is shown, add the `<BindingsTab>` component. Tabs visible based on channel.

Deep-link support: reading `?tab=X` from the URL selects the correct tab.

- STOP

---

### Phase U — Canvas overlays

- [ ] **Task U1: Node metric overlays**

`flow-builder/node-overlays.tsx` — given an `automationId` + period + graph, fetch `GET /api/automations/{id}/insights?period=...&granularity=per_node`. Attach a small badge to each canvas node showing execution count + success rate. Color:
- green if success > 90%
- yellow 70-90%
- red < 70%
- grey if no executions

Click badge → mini popover with per-port breakdown (execution count per `exited_via_port_key`).

Wire into `guided-flow.tsx`. Only show when the automation is `active` (saves bandwidth on draft/archived flows).

- STOP

---

### Phase V — Inbox integration

- [ ] **Task V1: Automation badge in inbox header**

`inbox/automation-badge.tsx` — shows in the conversation header. Fetch any active run for the contact (e.g., `GET /api/contacts/{contact_id}/automation-state` if exists, OR query runs via `/api/automations/runs?contact_id=...` — use the actual available endpoint).

If an active run exists: `⚡ [Automation name] · step X/Y`. Click → open run inspector in a drawer (or navigate to `/app/automation/{automationId}?tab=runs&run_id=...`).

Wire into `chat-thread.tsx`'s header area.

- STOP

---

- [ ] **Task V2: "Start an automation" action**

Add a button in `chat-thread.tsx`'s composer footer (or in a header menu): "Start an automation for this contact". Clicking opens a picker modal — active flows for this conversation's channel. Selecting one calls `POST /api/automations/{id}/enroll` with the current `contact_id`. Toast success/error.

- STOP

---

- [ ] **Task V3: Pause/resume button refresh**

`chat-thread.tsx` already has pause/resume per earlier work. Verify it uses the new `contacts/{id}/automation-pause|resume` proxies (from Unit B1). If not, migrate.

- STOP

---

### Phase W — Verification

- [ ] **Task W1: Typecheck + test suite**

- `bun run typecheck` — clean monorepo
- `cd packages/sdk && bun run build` — clean
- `bun test apps/app/src/` — all green (expect 120+ tests with new ones from Plan 3)
- `bun test apps/api/src/__tests__/automation-*` — all green (107 preserved)

- STOP

---

- [ ] **Task W2: Manual E2E checklist update**

Extend `apps/app/TESTING_AUTOMATIONS.md` with the Plan 3 surfaces:
- Run inspector flow (create run, view timeline, stop run)
- Binding tab flow (per-account bindings)
- Inbox badge flow (active run shows in inbox)

- STOP

---

- [ ] **Task W3: Remove any Plan-2 TODOs that this plan resolves**

Grep for `TODO(Plan 3)` / `TODO(plan-3)` / `TODO: plan 3` across the codebase. For each: either resolve inline or add a more specific TODO referencing a future plan if we're deferring.

- STOP

---

## Self-Review

Spec coverage for §13, §14 confirmed across R*, S*, T*, U*, V* tasks.

No TBDs.

Type consistency: all new components pull types from the SDK's response types (AutomationRun, AutomationStepRun, AutomationBinding, AutomationInsights).

---

## Execution

Execute via `superpowers:subagent-driven-development`.
