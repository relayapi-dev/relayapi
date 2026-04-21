# Automation Rebuild — Plan 2: Builder UX

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Spec:** `docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md` — §10, §11, §12
**Plan 1 status:** complete. 107 backend tests green, typecheck clean across monorepo, SDK rewritten + builds clean, OpenAPI spec contains all new routes. Some dashboard proxy files return 410 for endpoints that no longer exist (`/publish`, `/enrollments`) — Plan 2 migrates the UI callers.

**Goal:** Rebuild the flow-builder UI on the port-based graph model. Ship the message composer, action-group editor, and property-panel dispatch. Migrate the dashboard proxies to the new SDK surface.

**Architecture:** React + Astro dashboard (existing). ReactFlow canvas (preserved, rewritten port model). `/automations/{id}` is the flow detail page; the right-side panel dispatches to the kind-specific editor (composer for `message`, action editor for `action_group`, generic `FieldRow` form for others). Left-side panel holds entrypoints + binding summary. Saves debounced to `PUT /v1/automations/{id}/graph` via SDK.

**Tech Stack:** React 19, TypeScript, Astro SSR, ReactFlow, Tailwind, Zustand or similar for builder state, `@relayapi/sdk` for all API calls (per CLAUDE.md).

**Git policy:** User handles all git. Each task ends with `STOP — user commits at their discretion`.

---

## File Structure

### Files to keep (light refactor)

- `apps/app/src/components/dashboard/pages/automation-page.tsx` — list view; minor column updates
- `apps/app/src/components/dashboard/pages/automation-detail-page.tsx` — shell; refactor normalization layer for new graph shape
- `apps/app/src/components/dashboard/pages/automation-new-page.tsx` — **delete** (create dialog now modal-based from the list page)
- `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx` — canvas; rewrite handle + edge logic
- `apps/app/src/components/dashboard/automation/flow-builder/trigger-panel.tsx` — refactor for entrypoint list model
- `apps/app/src/components/dashboard/automation/flow-builder/filter-group-editor.tsx` — preserve
- `apps/app/src/components/dashboard/automation/flow-builder/insights-panel.tsx` — preserve; data source updated
- `apps/app/src/components/dashboard/automation/flow-builder/bindings-panel.tsx` — preserve shape; SDK update
- `apps/app/src/components/dashboard/automation/flow-builder/run-history-panel.tsx` — preserve; SDK update
- `apps/app/src/components/dashboard/automation/flow-builder/simulator-panel.tsx` — preserve; SDK update
- `apps/app/src/components/dashboard/automation/flow-builder/use-autosave.ts` — preserve
- `apps/app/src/components/dashboard/automation/flow-builder/use-history.ts` — preserve (undo/redo)
- `apps/app/src/components/dashboard/automation/flow-builder/validation.ts` + `validation.test.ts` — rewrite for new graph shape
- `apps/app/src/components/dashboard/automation/template-picker-dialog.tsx` — refactor into create-automation dialog

### Files to rewrite

- `apps/app/src/components/dashboard/automation/flow-builder/property-panel.tsx` — replace node-kind-specific forms with dispatch to composer / action editor / generic
- `apps/app/src/components/dashboard/automation/flow-builder/output-labels.ts` — delete (port labels come from graph.ports)
- `apps/app/src/components/dashboard/automation/flow-builder/data-references.ts` — keep helper but strip references to deleted node kinds
- `apps/app/src/components/dashboard/automation/flow-builder/trigger-ui.ts` — align to entrypoint kinds
- `apps/app/src/components/dashboard/automation/flow-builder/field-styles.ts` — preserve (styling)
- `apps/app/src/components/dashboard/automation/flow-builder/types.ts` — replace with port/graph types mirrored from SDK

### New files

- `apps/app/src/components/dashboard/automation/flow-builder/message-composer/index.tsx` (entry)
- `apps/app/src/components/dashboard/automation/flow-builder/message-composer/block-list.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/message-composer/block-editors.tsx` (per-type editors)
- `apps/app/src/components/dashboard/automation/flow-builder/message-composer/button-editor.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/message-composer/quick-reply-editor.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/message-composer/preview.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/message-composer/merge-tag-picker.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/action-editor/index.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/action-editor/action-list.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/action-editor/action-form.tsx` (generic form per action type)
- `apps/app/src/components/dashboard/automation/flow-builder/action-editor/preview.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/insert-menu.tsx` (drag-to-create popover)
- `apps/app/src/components/dashboard/automation/flow-builder/port-handles.tsx` (port-handle rendering)
- `apps/app/src/components/dashboard/automation/flow-builder/use-graph-store.ts` (local builder state)
- `apps/app/src/components/dashboard/automation/flow-builder/use-catalog.ts` (fetches + caches `/automations/catalog`)
- `apps/app/src/components/dashboard/automation/flow-builder/entrypoint-panel.tsx` (left-side, new slot)

### Dashboard proxy migration

- `apps/app/src/pages/api/automations/[id].ts` — update to new SDK methods
- `apps/app/src/pages/api/automations/[id]/activate.ts` — new
- `apps/app/src/pages/api/automations/[id]/pause.ts` — new
- `apps/app/src/pages/api/automations/[id]/resume.ts` — new
- `apps/app/src/pages/api/automations/[id]/archive.ts` — new
- `apps/app/src/pages/api/automations/[id]/unarchive.ts` — new
- `apps/app/src/pages/api/automations/[id]/graph.ts` — new (PUT)
- `apps/app/src/pages/api/automations/[id]/enroll.ts` — migrate (previously `/enrollments` likely)
- `apps/app/src/pages/api/automations/[id]/simulate.ts` — keep
- `apps/app/src/pages/api/automations/[id]/insights.ts` — keep
- `apps/app/src/pages/api/automations/[id]/runs.ts` — new
- `apps/app/src/pages/api/automations/[id]/entrypoints.ts` — new
- `apps/app/src/pages/api/automation-entrypoints/[id].ts` — new (GET/PATCH/DELETE)
- `apps/app/src/pages/api/automation-entrypoints/[id]/rotate-secret.ts` — new
- `apps/app/src/pages/api/automation-runs/[id].ts` — new
- `apps/app/src/pages/api/automation-runs/[id]/steps.ts` — new
- `apps/app/src/pages/api/automation-runs/[id]/stop.ts` — new
- `apps/app/src/pages/api/automation-bindings.ts` — list/create
- `apps/app/src/pages/api/automation-bindings/[id].ts` — get/patch/delete
- `apps/app/src/pages/api/contacts/[id]/automation-controls.ts` — list
- `apps/app/src/pages/api/contacts/[id]/automation-pause.ts` — post
- `apps/app/src/pages/api/contacts/[id]/automation-resume.ts` — post

---

## Task List

### Phase J — Proxy Migration

- [ ] **Task J1: Migrate dashboard API proxies to new SDK surface**

Delete any 410-Gone stubs created in Unit 9. Create the full set of proxies listed above, each a thin wrapper that calls the corresponding SDK method using the existing auth-forwarding pattern (check `apps/app/src/pages/api/contacts/[id].ts` for the reference pattern).

Per CLAUDE.md: NO raw fetches. Every proxy calls through `@relayapi/sdk`.

**Steps:**
- Read one existing proxy (e.g. `contacts/[id].ts`) for the pattern
- Create all proxy files listed above
- Delete any 410-Gone stub files (`publish.ts`, `enrollments.ts`, `contact-controls/pause.ts`, `contact-controls/resume.ts` if present)
- Run `bun run typecheck:app`. Expect clean.
- STOP — user commits

---

### Phase K — Graph Store & Catalog Wiring

- [ ] **Task K1: Graph store hook**

`use-graph-store.ts` — Zustand store (or equivalent; check if repo uses Zustand already or prefers React context + reducer):
```ts
type GraphStore = {
  graph: Graph;
  setGraph(graph: Graph): void;
  addNode(kind: string, position: { x: number; y: number }, connect?: { sourceNodeKey: string; sourcePortKey: string }): string;
  removeNodes(keys: string[]): void;
  moveNode(key: string, position: { x: number; y: number }): void;
  updateNodeConfig(key: string, config: any): void;
  addEdge(from_node: string, from_port: string, to_node: string, to_port: string): void;
  removeEdge(index: number): void;
  reconnectEdge(index: number, newEnd: { to_node: string; to_port: string } | { from_node: string; from_port: string }): void;
  // Undo/redo via use-history.ts (preserved)
  // Validation state: validationErrors, validationWarnings
};
```

Ports: graph state is the source of truth. The builder mutates the store; a debounced save pushes the graph to the API via SDK. On save response, the server-derived `ports` array replaces the client-side derivation (the server's `derivePorts` is authoritative).

Write a unit test: `use-graph-store.test.tsx` with add/remove/connect operations.

- Files: create `use-graph-store.ts`, `use-graph-store.test.tsx`
- STOP

---

- [ ] **Task K2: Catalog hook**

`use-catalog.ts` — fetches `/v1/automations/catalog` via SDK once per session, caches in-memory + localStorage with ETag. Returns `{ node_kinds, entrypoint_kinds, binding_types, action_types, channel_capabilities, template_kinds }`. Build consumers import from here; no hardcoded lists.

- Files: create `use-catalog.ts`
- STOP

---

### Phase L — Canvas (Port-Driven)

- [ ] **Task L1: Port-handle component**

`port-handles.tsx` — renders React Flow handles for a node based on its `ports` array. Input ports on the left, output ports on the right. Handle `id = port.key`. Color cues: `role: "branch"` green/red, `role: "error"` red, `role: "success"` green, `role: "interactive"` blue, default grey. Shows the port label next to the handle.

Write `port-handles.test.tsx`: given a node with 3 output ports, render returns 3 handles with correct ids.

- STOP

---

- [ ] **Task L2: Guided flow canvas rewrite**

Replace the edge-label-based canvas in `guided-flow.tsx`. Use port handles everywhere; remove label-based edge creation; use graph store.

Delete `output-labels.ts`.

`onConnect` handler: validate via existing `validation.ts` rules (rewritten in the next task) + commit via `addEdge`.

`onReconnect` handler: same.

Keep: selection, drag-to-move, auto-arrange (preserved), zoom controls.

- Files: modify `guided-flow.tsx`; delete `output-labels.ts`
- STOP

---

- [ ] **Task L3: Rewrite client-side validation**

`validation.ts` — mirror the server validator's rules in TypeScript. Same shape: duplicate node keys, orphans, edge references, cycles without pause, port ref existence, orphan port warnings.

Update `validation.test.ts`. Reuse the server spec file as reference.

- STOP

---

- [ ] **Task L4: Drag-to-create insert menu**

`insert-menu.tsx` — command-palette-style popover. Triggered:
- On `connectEnd` in empty canvas space (React Flow event)
- On `Cmd+K` / `/` when a node is selected
- Toolbar "+" button

Features:
- Search input (filters by name + synonyms)
- Category groups: Content / Logic / Actions / Flow
- Channel-aware hints (show which blocks are unsupported with a warning icon)
- Keyboard navigation (arrow keys + enter)
- Recent/frequent picks pinned (local storage)
- On select: calls `graphStore.addNode(kind, position, connect?)` — inserts node + optional connecting edge in one atomic mutation

- Files: `insert-menu.tsx`, `insert-menu.test.tsx`
- STOP

---

- [ ] **Task L5: Selection, clipboard, keyboard**

Add to `guided-flow.tsx`:
- Multi-select: Shift+click, Cmd+click, lasso (Cmd+drag)
- Delete key: removes selected nodes + their edges
- Cmd+D: duplicate selection (new keys generated; internal edges cloned)
- Cmd+C / Cmd+V: serialize selected subgraph to clipboard as JSON; paste rehydrates with new keys
- Cmd+Z / Cmd+Shift+Z: undo/redo via `use-history.ts` (preserved)
- Cmd+S: force-save via autosave hook
- F: frame selection
- 0: reset zoom

- STOP

---

### Phase M — Right Panel Dispatch

- [ ] **Task M1: Property panel dispatch**

Rewrite `property-panel.tsx` as a thin dispatcher:

```tsx
function PropertyPanel({ node, ...rest }: Props) {
  const Editor = node.kind === "message" ? MessageComposer
                : node.kind === "action_group" ? ActionEditor
                : GenericFieldForm;
  return (
    <div>
      <PanelHeader node={node} /* title, kind badge, menu */ />
      <Editor node={node} {...rest} />
      <PanelFooter node={node} /* notes, color */ />
    </div>
  );
}
```

`GenericFieldForm` is the existing `FieldRow` pattern — preserve for simple kinds (`delay`, `condition`, `randomizer`, `input`, `http_request`, `start_automation`, `goto`, `end`).

- Files: modify `property-panel.tsx`; extract `generic-field-form.tsx` from the existing code
- STOP

---

### Phase N — Message Composer

- [ ] **Task N1: Composer shell + block list**

`message-composer/index.tsx` — wraps `block-list`, `quick-reply-editor`, message-level settings.

`message-composer/block-list.tsx` — draggable reorderable list of blocks. Each block renders its editor via `block-editors.tsx` dispatch.

`[+ Add block ▾]` dropdown shows 8 block types, channel-aware (unsupported greyed out).

- Files: index.tsx, block-list.tsx
- STOP

---

- [ ] **Task N2: Per-block editors**

`block-editors.tsx` — one editor component per block type:
- Text: textarea + merge-tag picker + inline button editor
- Image/Video/Audio/File: media picker (reuse existing `apps/app` media upload if present; if not, for v1 use a URL text input with a TODO note)
- Card: image + title + subtitle + up to 3 buttons
- Gallery: repeater of up to 10 cards
- Delay: seconds slider

- STOP

---

- [ ] **Task N3: Button editor + quick-reply editor**

`button-editor.tsx` — modal or inline popover. Label, type (branch/url/call/share), URL/phone for the non-branch types. Branch buttons auto-create port (client-side preview; server derivation authoritative on save).

`quick-reply-editor.tsx` — message-level list. Label (max 20), optional emoji picker. Creates `quick_reply.<id>` ports.

- STOP

---

- [ ] **Task N4: Merge-tag picker**

`merge-tag-picker.tsx` — dropdown triggered by `@` or `{{` in any supported text input. Groups: Contact, Context, Run, Account. Inserts the tag string at cursor.

- STOP

---

- [ ] **Task N5: Channel capability warnings + preview**

Composer reads `use-catalog.ts` → `channel_capabilities` for the automation's channel. Unsupported block types show a yellow warning banner inline.

`preview.tsx` — phone-frame mock styled per channel. Renders merge-tag-resolved text, buttons, quick replies. Client-side only; no API call.

- STOP

---

- [ ] **Task N6: Composer message-level settings**

`wait_for_reply` toggle (auto-true if any interactive), `no_response_timeout_min` number input, `typing_indicator_seconds` slider.

- STOP

---

### Phase O — Action Editor

- [ ] **Task O1: Action list + reorder**

`action-editor/index.tsx` — top-level.
`action-editor/action-list.tsx` — draggable list of actions. Each row: action title (type + summary), on_error dropdown, ⋯ menu (duplicate / move / delete).

- STOP

---

- [ ] **Task O2: Per-action form**

`action-editor/action-form.tsx` — generic form that dispatches to a form-per-type. Each action type from `automation_actions.ts` schema gets a form:
- tag_add/remove → tag picker
- field_set → field picker + value (merge-tag aware)
- assign_conversation → user picker
- webhook_out → URL + method + headers + body + auth
- etc.

Reuse existing pickers (tag picker, field picker, user picker) from the inbox UI.

- STOP

---

- [ ] **Task O3: Action preview**

`action-editor/preview.tsx` — "Dry-run actions" button posts to `/v1/automations/{id}/simulate` with `start_node_key` set to this action node and `execute_side_effects: false`. Shows a transcript of what would fire with resolved merge-tag values.

- STOP

---

### Phase P — Detail Page & Left Panel

- [ ] **Task P1: Entrypoint panel**

`entrypoint-panel.tsx` — left-side, new slot in the flow detail page. Lists entrypoints + bindings. `+ Add ▾` picker uses catalog's `entrypoint_kinds` filtered by automation channel.

Each entrypoint click opens inline config form; SDK call updates row on save.

- STOP

---

- [ ] **Task P2: Flow detail page refactor**

`automation-detail-page.tsx` — add the left-side entrypoint panel slot; add tabs (Canvas / Runs / Insights); normalize graph response from SDK into the graph store.

Runs tab renders the run-inspector (next plan).
Insights tab renders `InsightsPanel` (existing, wire up new data).

- STOP

---

- [ ] **Task P3: Automations list page updates**

`automation-page.tsx` — add column "Trigger summary" (derived client-side from entrypoints), "Template badge" (from `created_from_template`), "30d runs" (from insights endpoint). Filter by `created_from_template`.

- STOP

---

- [ ] **Task P4: Create-with-template dialog**

Merge `automation-new-page.tsx` + `template-picker-dialog.tsx` into a single modal dialog triggered from the list page's `[+ New automation]` button. Grid of template cards; selecting a template opens a multi-step form.

Template-specific forms for `comment_to_dm`, `story_leads`, `follower_growth`, `follow_to_dm` (per spec §7.2). Reuse existing asset pickers (`AccountSearchCombobox`, `PostSearchCombobox`, `FilterGroupEditor`).

On submit: `automations.create({ template: { kind, config } })` via SDK → redirect to `/app/automations/{id}`.

Delete `automation-new-page.tsx`. Keep `template-picker-dialog.tsx` renamed to `create-automation-dialog.tsx`.

- STOP

---

### Phase Q — Integration & Tests

- [ ] **Task Q1: E2E smoke test**

Using Playwright (if repo has it) or a simpler integration test:
1. Open `/app/automations`
2. Click `+ New automation`, pick `comment_to_dm` template, fill config, submit
3. Land on flow detail page; see generated nodes
4. Click a message node → composer appears
5. Add a button, save → port appears on canvas
6. Draw an edge from the button port to a new end node
7. Activate automation → validator passes, status = active

- STOP

---

- [ ] **Task Q2: Typecheck + build**

`bun run typecheck` clean.
`cd packages/sdk && bun run build` clean.
`bun run dev:app` and manually verify the builder loads without errors (sanity check — subagent should describe what they saw if they ran it).

- STOP

---

## Self-Review

Spec coverage for §10 (builder interaction model), §11 (message composer), §12 (action editor), §13 (product surfaces list/detail) confirmed across Tasks L*, N*, O*, P*.

No TBDs.

Type consistency: all builder state types derive from the SDK's response types. Port/edge/block shapes match `automation-graph.ts` schema on the backend.

---

## Execution

Execute via `superpowers:subagent-driven-development`: one subagent per task, review between.
