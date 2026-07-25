# Automation builder — manual smoke-test checklist

This checklist covers the automation builder, preset creation, run inspector,
provider bindings, canvas overlays, and inbox integration. Playwright is not
installed in `apps/app`, so this remains the manual smoke-test source of truth.

## Prerequisites

1. `bun run dev:api` is running (API on `http://localhost:8789`); that command
   owns and closes its database tunnel automatically.
2. Set `REMOTE_DASHBOARD_ORIGIN=off` and
   `API_BASE_URL=http://localhost:8789` in `apps/app/.dev.vars` for this fully
   local app/API smoke test.
3. `bun run dev:app` is running (dashboard on `http://localhost:4321`).
4. You are logged in via `SEED_USER_EMAIL` / `SEED_USER_PASSWORD` and
   `scripts/seed.ts` has been run, so your workspace has at least one
   Instagram account connected.

## Checklist

### 1. Landing on the list

- [ ] Navigate to `http://localhost:4321/app/automation`.
- [ ] The page renders the automation list (or empty-state) without a
      client-side error in the browser console.
- [ ] A `[+ New automation]` button is visible near the page header.

### 2. Create-automation dialog

- [ ] Click `[+ New automation]`.
- [ ] A dialog opens with template tiles (`comment_to_dm`, `welcome_flow`,
      `story_leads`, `lead_capture`, etc.).
- [ ] Click the `Comment → DM` (`comment_to_dm`) tile.
- [ ] The dialog expands to the configuration step for that template.

### 3. Configure the template

Fill in the comment-to-DM template form:

- [ ] **Name:** `Test pizza`
- [ ] **Channel:** `instagram`
- [ ] **Account:** select the first Instagram account in the picker.
- [ ] **Public reply text:** e.g. `Thanks — check your DMs!`
- [ ] **DM message:** one text block with any content
      (e.g. `Here is the pizza recipe you asked for.`)
- [ ] Submit with `[Create]` / `[Save]`.

Expected behaviour:

- [ ] No visible error toast.
- [ ] The browser navigates to `/app/automation/{id}` (id is an
      `aut_…` nanoid).

### 4. Detail page renders the graph

On `/app/automation/{id}`:

- [ ] The left rail / canvas area renders a port-driven graph:
    - [ ] A **trigger** node (entrypoint) at the top.
    - [ ] An **action_group** node that posts the public comment reply.
    - [ ] A **message** node (the provider private reply) connected after it.
- [ ] The right rail shows the **Entrypoint panel** with the IG account
      picked during create, the post/keyword filters, admission controls, and
      status. The public reply is edited on the action node, not the trigger.

### 5. Selecting the message node

- [ ] Click the message node on the canvas.
- [ ] The right rail swaps to the **Message composer**:
    - [ ] Channel indicator reads `instagram`.
    - [ ] The text block shows the body you entered in step 3.
    - [ ] Block-level "+ Add block" / button-adding controls are present.
- [ ] Edit the text and click outside the block. The autosave indicator
      (top of canvas) should briefly show "Saving…" then "Saved".

### 6. Selecting the action_group node

- [ ] Click the `action_group` node on the canvas.
- [ ] The right rail swaps to the **Action editor**:
    - [ ] At least one action row is visible (public comment reply).
    - [ ] "+ Add action" is available.
- [ ] Click an action row — a form with the action's config appears below.

### 7. Activate the automation

- [ ] Click the **Activate** button (top-right of canvas toolbar).
- [ ] If the graph is valid:
    - [ ] Status chip flips to **Active**.
    - [ ] Toast says "Automation activated" (or similar).
- [ ] If the graph is invalid:
    - [ ] A validation error dialog / banner lists the missing fields.
    - [ ] Status stays at its prior value (draft/inactive).

### 8. Navigate away and back

- [ ] Click the "Back" / list link to return to `/app/automation`.
- [ ] The new automation appears in the list with the name `Test pizza` and
      the status you landed on in step 7.
- [ ] Open the row again — the builder hydrates the same graph from the API
      (no stale state, no 404).

## Plan 3 surfaces

The sections below extend the Plan 2 happy-path with the runs, bindings,
canvas observability, and inbox integration added in Plan 3. Prerequisites
(SSH tunnel, `dev:api`, `dev:app`, seeded workspace) are the same.

### 9. Run Inspector

- [ ] From `/app/automation/{id}`, switch to the **Runs** tab.
- [ ] The runs list renders (or shows an empty-state) without console
      errors.
- [ ] Click a run row. The run detail drawer / panel opens.
- [ ] Confirm the three inner tabs render content:
    - [ ] **Timeline** — step rows with status icons.
    - [ ] **Context** — JSON viewer with `contact`, `run.vars`, `trigger`.
    - [ ] **Transcript** — any outbound / inbound messages for the run.
- [ ] For a run whose `status` is `active` (paused on `wait_input` or
      `waiting_for_schedule`):
    - [ ] Click **Stop run** → confirm in the dialog.
    - [ ] The run's status chip transitions to `exited`.
    - [ ] A fresh timeline row records the stop step.
- [ ] Click **Show on canvas**:
    - [ ] The parent page switches to the **Canvas** tab.
    - [ ] The node corresponding to the run's `current_step_id` is
          highlighted with an outline / pulse.

### 10. Binding tabs (Connections)

From a run-inspector drawer or the flow's bindings panel, click
**Manage in account**. The browser should land on
`/app/connections/{id}?tab=default-reply`.

- [ ] **Default Reply** tab:
    - [ ] Automation picker lists the workspace's flows.
    - [ ] Select a flow → **Save** → toast + the tab lists the flow as
          the active binding.
    - [ ] Clear the binding → tab returns to an empty state.
- [ ] **Welcome Message** tab:
    - [ ] Select a flow → **Save** → the tab lists the active binding.
    - [ ] Pause and resume the binding; the status label follows the change.

- [ ] **Get Started** is offered only for Facebook. Save a payload and confirm
      its status moves from `pending_sync` to `active` after provider sync.
- [ ] **Main Menu** is offered for Instagram and Facebook. Facebook requires a
      synchronized Get Started binding first and allows at most three items.
- [ ] **Ice Breakers** is offered only for Instagram and accepts at most four
      question/payload pairs.
- [ ] Pause/resume provider bindings and confirm the desired state is applied
      only after the matching sync revision is acknowledged.

### 11. Canvas overlays (observability)

Open an automation that has recent runs.

- [ ] On the canvas, each non-container node carries a metric badge:
    - [ ] Color reflects success rate (green / amber / red).
    - [ ] Count reflects visits in the selected window.
- [ ] Toggle the period selector (24h / 7d / 30d / 90d):
    - [ ] Badges visibly refresh (counts may change).
- [ ] Click a badge:
    - [ ] A popover opens showing per-port breakdown (entries, exits,
          branch splits for condition / randomizer / split_test).

### 12. Inbox integration

Open an inbox conversation where the contact is currently enrolled in
an active run (seed or manual trigger one if needed).

- [ ] The conversation header shows an **Automation badge** with the
      flow name and the current step.
- [ ] Click the badge → browser navigates to the run inspector.
- [ ] In the composer toolbar, click **Start an automation**:
    - [ ] A picker modal opens with the workspace's automations.
    - [ ] Select a flow and confirm → success toast.
    - [ ] A new run appears in the run inspector for this contact.
- [ ] **Pause automations for this contact**:
    - [ ] Click the pause control in the conversation notes / header.
    - [ ] An `automation-paused` indicator is visible in the header.
- [ ] **Resume**:
    - [ ] Click resume → indicator clears; new automations can enroll.

## Raw-fetch check (developer verification)

The dashboard must never call `/v1/*` directly from component code. To
verify:

```bash
# From repo root — should return no matches.
grep -rE 'fetch\(["'"'"']/v1/' apps/app/src
```

All app-to-API calls should go through `/api/*` proxies in
`apps/app/src/pages/api/…`, which in turn use `@relayapi/sdk`.

## Known gaps

- No repository Playwright suite yet; retain these checks until equivalent
  browser assertions run in CI.
- The simulator panel (right rail "Simulate" button) is covered by unit
  tests only; smoke-testing it is optional here.

## Integration repair — 2026-04-22

All 9 integration bugs documented in Plan 4 are fixed and covered by
regression + real end-to-end integration tests. See
`docs/superpowers/AUTOMATION_REBUILD_INTEGRATION_REPAIR_REPORT_2026-04-22.md`
for per-bug status. Smoke-test scenarios (input resume, keyword DM,
comment-to-DM, welcome binding, webhook entrypoint, scheduled trigger,
branch routing, per-action error handling, cross-flow internal events,
cycle protection) are all exercised by
`apps/api/src/__tests__/automation-e2e-integration.test.ts`.
