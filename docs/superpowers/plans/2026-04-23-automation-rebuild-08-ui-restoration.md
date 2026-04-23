# Automation Rebuild — Plan 8: UI Restoration (pre-b367320 layout)

**Context:** Plans 1-7 landed a correct backend but the detail page layout regressed. b367320 introduced permanent left + right sidebars. Operator feedback: confusing, step down, doesn't match Manychat. Restore the pre-b367320 single-canvas layout WHILE keeping the new backend.

**Reference commit:** `218f7139` (last good UI). File of interest: `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx` + `trigger-panel.tsx`.

## What the old UI did

1. **Canvas took full width** by default
2. **Trigger was a canvas node** (`TriggerFlowNode`): rich "When..." card rendered at the graph root, containing:
   - ⚡ icon + "When..." header
   - Each entrypoint as a tappable row (platform icon, label, summary)
   - "+ New Trigger" button inside the card
   - "Then" label at the bottom
   - Right-edge handle connecting to the first flow node
3. **Right panel was conditional**:
   - Click a step → `<PropertyPanel>`
   - Click the trigger card → `<TriggerPanel>`
   - Click an entrypoint item inside the trigger card → `<TriggerPanel>` opens on that entrypoint
   - Click "+ Simulator" / "+ Bindings" in toolbar → panels swap in
   - Click empty canvas → panel hides, canvas goes full-width

## Goal

Bring this layout back on top of Plans 1-7 backend:
- Port-based graph (preserve)
- Graph store `useGraphStore` (preserve)
- Message composer, action editor, run inspector, insights (preserve)
- Template system, catalog, autosave (preserve)
- API + SDK (preserve — no changes)

Only the detail page layout + trigger-node rendering change.

## Critical constraints

1. NEVER run git commands (except read-only).
2. All API calls via the SDK/proxies (already established).
3. Do not break the 264+ automation tests.

## Tasks

### Task 1: Synthesize the trigger canvas node

**File:** `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx`

Add a synthetic `"__trigger"` virtual node prepended to the ReactFlow node list. It is NOT stored in `graph.nodes` — it's built from the automation's entrypoints (fetched from `/api/automations/{id}/entrypoints`).

Signature additions to `GuidedFlow` props:
```ts
interface GuidedFlowProps {
  // existing props...
  entrypoints: Array<AutomationEntrypoint>;    // new
  onAddEntrypoint?(kind: string): void;        // new
  onSelectTrigger?(entrypointId: string | null): void;  // null = select "trigger" card itself; non-null = select a specific entrypoint
}
```

Add a new React Flow node type `"trigger"`:
```ts
const nodeTypes = { canvas: CanvasNode, trigger: TriggerNode };
```

`TriggerNode` component — port from the old `TriggerFlowNode` at 218f7139 `guided-flow.tsx:668-770`. Styling stays identical. Swap the old `automation.triggers` field to the new `entrypoints` prop.

Wiring:
- The trigger node's ReactFlow `id = "__trigger"`
- Position: fixed above the canvas bounding box (e.g., `{ x: 40, y: 100 }`). Don't auto-layout it.
- Right-side source handle → virtual edge to `graph.root_node_key` (if set)
- When graph has no root_node_key (empty flow), show a placeholder "+ Add first step" prompt instead of an edge

Synthesize the trigger edge in `rfEdges`:
```ts
const triggerEdge = graph.root_node_key ? {
  id: "__trigger→" + graph.root_node_key,
  source: "__trigger",
  target: graph.root_node_key,
  sourceHandle: "out",
  targetHandle: "in",
} : null;
```

The trigger node is **draggable** (like in the old UI). If the user drags it, persist the position in a small local state (no graph mutation — it's virtual).

Remove the constraint that prevents clicking an empty port from opening the insert menu when the source is the trigger node — it should work the same.

### Task 2: Restore TriggerPanel

**File:** `apps/app/src/components/dashboard/automation/flow-builder/trigger-panel.tsx` (RECREATE — was deleted in b367320)

Start from the old file:
```bash
git show 218f7139:apps/app/src/components/dashboard/automation/flow-builder/trigger-panel.tsx
```

Adapt to the NEW entrypoint model:
- `automation.triggers` → prop `entrypoints: AutomationEntrypoint[]`
- Old trigger config JSON shape → new entrypoint config per kind (see `apps/api/src/schemas/automation-entrypoints.ts`)
- `onAddTrigger(type)` / `onUpdateTrigger(id, patch)` / `onRemoveTrigger(id)` → call the new proxies:
  - `POST /api/automations/{id}/entrypoints`
  - `PATCH /api/automation-entrypoints/{id}`
  - `DELETE /api/automation-entrypoints/{id}`
- Use `useAutomationCatalog()` for the kind picker
- Preserve the `AccountSearchCombobox` + `PostSearchCombobox` + `FilterGroupEditor` integrations (they still exist)

Keep the dual-mode UI (list → detail drill-down) from the old file. Optional: if a specific entrypoint id is selected, go straight to detail mode.

### Task 3: Detail page layout restoration

**File:** `apps/app/src/components/dashboard/pages/automation-detail-page.tsx`

**Remove:**
- The left `<EntrypointPanel>` block (lines ~500-509 currently)
- Any reference to `EntrypointPanel`

**Make right panel conditional:** show the panel container ONLY when `selectedNode != null` OR `sidePanel === "simulator" | "bindings" | "history"`.

Selection logic:
- User clicks a step node → `selectedNode = <node>`, panel shows `<PropertyPanel>` (which dispatches internally to message composer / action editor / generic form)
- User clicks the trigger card → `selectedNode = "__trigger"` → panel shows `<TriggerPanel>` (list mode)
- User clicks an entrypoint row inside the trigger card → `selectedNode = "__trigger"`, `selectedEntrypointId = <id>` → panel shows `<TriggerPanel>` (detail mode, focused on that entrypoint)
- User clicks empty canvas → `selectedNode = null` → panel hides
- User clicks toolbar simulator/bindings → panel swaps

Layout:
```tsx
<div className="flex min-h-0 flex-1">
  <div className="flex-1 min-w-0">
    <GuidedFlow
      automationId={automation.id}
      channel={automation.channel}
      graphStore={graphStore}
      catalog={catalog.data}
      readOnly={readOnly}
      automationStatus={automation.status}
      entrypoints={entrypoints ?? []}
      onSelectTrigger={(entrypointId) => {
        setSelectedKey("__trigger");
        setSelectedEntrypointId(entrypointId);
      }}
      onAddEntrypoint={(kind) => {
        // opens TriggerPanel in add mode
      }}
    />
  </div>
  {rightPanel && (
    <div className="w-[420px] shrink-0 border-l border-border bg-background">
      {/* Dispatch to the right panel content */}
    </div>
  )}
</div>
```

**Keep:** tabs (Canvas / Runs / Insights), toolbar buttons, header, validation banner.

### Task 4: Fix node dragging

Verify the existing canvas actually allows node dragging. Likely cause of "can't move nodes":
- Check `CanvasNode` component — any `onMouseDown` with `stopPropagation` that blocks React Flow's drag start?
- Verify `draggable: !readOnly` passes through correctly

If there's a bug, fix it. Otherwise confirm working.

### Task 5: Wire entrypoints into the detail page

**File:** `apps/app/src/components/dashboard/pages/automation-detail-page.tsx`

Fetch entrypoints separately via `/api/automations/{id}/entrypoints` (existing proxy). Feed into `<GuidedFlow>` + `<TriggerPanel>`.

```ts
const { data: entrypointsData, refetch: refetchEntrypoints } = useApi<{ data: Entrypoint[] }>(
  `/api/automations/${automationId}/entrypoints`
);
```

When entrypoints change (add/update/delete from the TriggerPanel), call `refetchEntrypoints()` so the trigger card updates.

### Task 6: Delete unused files

After the restoration:
- `apps/app/src/components/dashboard/automation/flow-builder/entrypoint-panel.tsx` — no longer used. Delete.
- Any imports of `EntrypointPanel` → remove.

## Out of scope

- Backend changes (entrypoint API, matcher, runner, etc.) — all preserved
- Run inspector / insights tabs — preserved as-is
- Templates + create dialog — preserved as-is
- Message composer / action editor — preserved, still invoked from PropertyPanel
- Bindings panel — still a toolbar button; conditionally rendered right panel

## Verification

1. `bun run typecheck` — clean
2. `cd apps/app && bun test src/` — no regressions
3. `bun test apps/api/src/__tests__/automation-*` — still passing (backend untouched)
4. Manually:
   - Open a `comment_to_dm` automation
   - Verify: trigger card appears on canvas with entrypoints listed, "Then" label, connected to the message node via edge
   - Verify: click empty canvas → no right panel
   - Verify: click a step → PropertyPanel opens
   - Verify: click trigger card → TriggerPanel opens
   - Verify: click an entrypoint inside the trigger card → TriggerPanel opens on that entrypoint
   - Verify: nodes draggable; trigger card also draggable (position is local state, not persisted)
   - Verify: "+ New Trigger" button inside trigger card opens the kind picker and creates a new entrypoint via the API

## Execution

Single unit. Dispatch one subagent with the full plan.
