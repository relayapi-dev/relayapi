# Automation System Deep Analysis and Rebuild Plan

Date: 2026-04-18

## Scope

This document audits the current RelayAPI automation system, answers the issues raised in the dashboard screenshots, benchmarks the product against Zapier and major open-source workflow builders, and proposes a practical rebuild plan.

The goal is not to ship a cosmetic patch. The current system has real product, schema, runtime, and editor gaps. Fixing it properly requires treating automation as a workflow platform, not just a list of nodes.

## Executive Summary

RelayAPI's current automation builder is functionally below the level implied by its schema and significantly below the level expected by users coming from Zapier, n8n, or Activepieces.

The biggest problems are structural:

1. The schema catalog and the runtime do not match.
2. Trigger and node setup are only partially schema-driven.
3. Complex node configuration falls back to raw JSON instead of guided UI.
4. Branching exists in the execution model but is weak in the editor.
5. The editor lacks first-class concepts for sample data, mapping, per-output handles, testing, and execution inspection.
6. Several current cards and panel interactions communicate the wrong mental model to the user.

Directly cloning "all of Zapier" is not realistic as a single feature request. The correct target is:

- Zapier-grade guided editing and onboarding
- n8n-grade data mapping and execution debugging
- Activepieces-grade modern flow UX
- Node-RED-grade explicit branching/debug concepts
- RelayAPI-specific focus on social/contact automations

## Direct Answers To The Issues Raised

### 1. Why does `instagram_comment` show no configuration in the editor?

Because the live automation schema endpoint currently returns an empty trigger config schema for all runtime-supported triggers.

Current implementation:

```ts
apps/api/src/routes/automations.ts:555-565
```

```ts
triggers: AUTOMATION_TRIGGER_TYPES.filter((t) =>
  RUNTIME_SUPPORTED_TRIGGER_TYPES.has(t),
).map((t) => ({
  type: t,
  description: describeTrigger(t),
  channel: channelForTrigger(t),
  tier: tierForTrigger(t),
  transport: transportForTrigger(t),
  config_schema: {},
  output_labels: ["next"],
}))
```

This means the editor has nothing to render for trigger-specific setup.

However, the Instagram comment template does create real trigger config:

```ts
apps/api/src/routes/automation-templates.ts:245-254
```

```ts
trigger: {
  type: "instagram_comment",
  account_id: body.account_id,
  config: {
    keywords: body.keywords,
    match_mode: body.match_mode,
    post_id: body.post_id ?? null,
  },
  filters: {},
}
```

Conclusion:

- The template flow works because it bypasses the broken generic schema-driven setup.
- The manual builder looks incomplete because the trigger catalog is incomplete.

### 2. Why does `message_text` have no recipient field? How does it know where to send?

Today it resolves the recipient implicitly from the enrolled contact and the automation channel.

Current implementation:

```ts
apps/api/src/services/automations/nodes/message-text.ts:18-68
```

Behavior:

- It reads the automation `channel` from the snapshot.
- It requires `trigger.account_id`.
- It requires `enrollment.contact_id`.
- It finds the enrolled contact's `contactChannels` row for the same platform.
- It uses `chan.identifier` as `recipientId`.

So the current behavior is:

- "Send to the contact that entered the automation on this channel."

That runtime behavior is defensible for a default, but the product is wrong because:

- The UI does not explain this.
- The node does not expose recipient mode.
- There is no override for "send to another contact", "send to a mapped account id", or "send to a custom identifier".

Recommendation:

- Keep `trigger_contact` as the default recipient mode.
- Expose recipient strategy explicitly in the node config.

### 3. What should users write in the `condition.if` field? JavaScript?

No. It is not JavaScript. It is a structured predicate object.

Runtime:

```ts
apps/api/src/services/automations/nodes/condition.ts:6-57
```

Schema:

```ts
apps/api/src/schemas/automations.ts:415,557
```

The condition handler reads `ctx.node.config.if` as a `FilterGroup` and returns the `yes` or `no` output label.

The current editor is the real problem:

```ts
apps/app/src/components/dashboard/automation/flow-builder/property-panel.tsx:371-372,401-466
```

Object fields are rendered with a raw JSON textarea. So users are being asked to author predicate objects manually, which is not acceptable for a product trying to feel like Zapier.

Recommendation:

- Default UI: visual rule builder
- Advanced mode: JSON editor
- Never present the visual builder as a raw `if` textbox

### 4. Why is there no real 2-way split path?

The data model already supports labeled edges, and condition nodes already emit `yes` or `no`. The editor does not expose branching as a first-class authoring flow.

Relevant editor behavior:

```ts
apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx:259-399
```

What the code does today:

- It renders a linear chain nicely when one child exists.
- It can render multiple branches if they already exist.
- When no children exist, it shows one generic add-step button using `parentEdgeLabel ?? "next"`.

What it does not do:

- It does not show explicit output handles for each node output.
- It does not show `yes` and `no` branch creation affordances on condition nodes.
- It does not help the user build a branch group.
- It does not make branching discoverable.

Recommendation:

- Every node with multiple outputs must render output handles.
- Condition nodes must expose `yes` and `no` as visible ports.
- Add-step should be per output, not generic.

### 5. Why does the card feel unprofessional compared with Zapier?

Because the current card presents internal node metadata rather than product-level workflow semantics.

Current card implementation:

```ts
apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx:547-625
```

Current card problems:

- Large generic pill using node type string
- Title uses node `key`, which feels internal
- Weak app identity
- Weak action/trigger identity
- Status/error affordances are layered onto the same top-right area
- Delete action floats over the card

Zapier's cards communicate:

- app identity
- event/action name
- clearer hierarchy
- explicit edit/manage affordances
- stronger workflow-scaffolding feel

Recommendation:

- Redesign cards around `App + Event/Action + Summary + Status`.
- Move destructive actions into a menu.
- Use outputs/ports visually.

### 6. Why does the delete button cover the error badge?

Because both are currently placed in the same top-right space.

Current implementation:

```ts
apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx:591-622
```

- Error badge is rendered in the header row.
- Delete button is absolutely positioned at `top-2 right-2`.

Recommendation:

- Reserve top-right for status only.
- Put delete inside an overflow menu in the header or footer.
- Never allow destructive controls to overlap status/error indicators.

### 7. Move archive button to the right of run history

Current toolbar order:

```ts
apps/app/src/components/dashboard/pages/automation-detail-page.tsx:598-668
```

The Archive button is currently at the far right after Publish. If we keep Archive as a quick action, it should sit adjacent to Run history. Better still:

- Run history
- Archive
- separator
- Save
- Pause/Resume
- Publish

## Current State Audit

### 1. Catalog/runtime mismatch

The schema advertises a much larger system than the runtime/editor properly support.

Current counts from `apps/api/src/schemas/automations.ts`:

- Trigger types declared: `93`
- Node types declared: `118`
- Runtime-supported triggers: `9`
- Stubbed node types filtered out of the catalog: `13`

Relevant declarations:

```ts
apps/api/src/schemas/automations.ts:139
apps/api/src/schemas/automations.ts:164
```

This causes a recurring product problem:

- the system appears larger than it is
- some concepts exist in docs or schema only
- some concepts exist in templates only
- some concepts exist in runtime only

Recommendation:

- Generate the dashboard catalog from the actual runtime manifests
- Do not maintain parallel, partially divergent definitions

### 2. Trigger configuration is not really schema-driven today

The current generic schema endpoint is returning empty trigger config schemas, while the template APIs hardcode inputs per template.

This is a classic smell:

- schema-driven editor on paper
- hand-authored forms in practice

The template picker currently leans on custom forms instead of a fully trustworthy shared schema contract.

Recommendation:

- One source of truth for trigger and node manifests
- One source of truth for template input manifests

### 3. Complex configuration is raw JSON instead of guided UI

`condition.if` is the clearest example, but the issue is broader:

- object typed fields become JSON textareas
- advanced logic has no builder UX
- there is no data picker or path picker

This is acceptable only as an advanced fallback. It is not acceptable as the default authoring path.

### 4. Branching is runtime-capable but editor-hostile

There is a graph model with labeled edges, but no strong editor affordances for:

- explicit outputs
- branch creation
- branch naming
- branch ordering
- branch default/fallback paths
- branch merge/rejoin

### 5. Execution and test ergonomics are thin

The builder includes simulator/history panels, but the overall workflow product still lacks mature concepts that tools like Zapier and n8n treat as foundational:

- step test records
- sample data capture
- field mapping explorer
- per-step input/output inspection
- rerun from a step
- clear branch outcome visualization

### 6. Card and toolbar design currently undersell the product

The screenshots show a system that visually communicates:

- generic cards
- incomplete node setup
- overlapping actions
- missing branch mental model

Even if the backend were stronger, the current editor UI would still look immature.

## Competitive Analysis

## Zapier

Zapier should be treated as the primary UX benchmark, not because every feature should be copied, but because it solves the exact product problem you are trying to solve: guided automation authoring for non-technical and semi-technical users.

Key product patterns from official docs:

- Visual editor that shows the full workflow as a flow diagram
- Filters for stop/continue logic
- Paths for true multi-branch logic
- Delay steps with multiple delay modes
- Code steps for Python and JavaScript
- Zap history for run inspection
- Notes for documenting steps and the whole automation
- Webhooks with strong guided testing

Important behaviors from the docs:

- Paths automatically create two branches initially and let the user add more
- Filters stop the workflow instead of branching
- Paths evaluate based on sample data and branch rules
- History is a first-class management surface

What to copy:

- Guided setup structure
- App/event naming hierarchy
- Explicit branch UX
- Strong run history
- Better step documentation
- Polished action cards

What not to copy blindly:

- Zapier still hides some power behind product boundaries
- RelayAPI needs stronger social/contact semantics than generic business app automation

## n8n

n8n is the best benchmark for data mapping, expressions, executions, and technical flexibility.

Key product patterns from official docs:

- Expressions are first-class
- Data mapping supports drag-and-drop from previous node outputs
- IF node and Switch node clearly distinguish binary and multi-route logic
- Wait node supports resume patterns
- Error workflows are explicit
- Executions and debug of past runs are core workflow concepts
- Sub-workflows are first-class

What to copy:

- Data mapping panel
- Expression mode
- Execution inspection model
- Distinct IF vs Switch node pattern
- Reusable subflows

What not to copy blindly:

- n8n can become too technical for your target user
- RelayAPI should not default to n8n-level complexity for every step

## Activepieces

Activepieces is the best benchmark for a modern no-code workflow UX that still supports advanced users.

Key product patterns from official docs and repo:

- Vertical builder
- Data insert panel for previous-step outputs
- Sample data generation before mapping
- Branches, loops, code, human-in-the-loop, retries, HTTP
- Versioned flows
- Strong "test before mapping" workflow

What to copy:

- Test data generation discipline
- Dynamic value insertion
- Vertical flow clarity
- Modern step setup feel

## Node-RED

Node-RED is older, but it remains one of the clearest references for explicit flow wiring and debugging.

Key product patterns from official docs:

- Clear workspace/palette/sidebar mental model
- Debug sidebar
- Info sidebar
- Wires/ports make flow direction unambiguous
- Subflows reduce visual complexity

What to copy:

- Explicit ports/outputs
- Better debug surfaces
- Subflow mindset

## Automatisch

Automatisch is useful as a reference point for an open-source Zapier alternative, but it is not the product bar you should target.

What it demonstrates:

- A simpler app/trigger/action flow model
- Connection-driven configuration
- Workflow authoring for common SaaS automation cases

Use it as a baseline comparator, not as the main north star.

## Kestra

Kestra is valuable as a reference for orchestration architecture, versioning, retries, subflows, and declarative flow definitions. It is not the right direct UX benchmark for your dashboard because it is more engineering-oriented and code-first.

What to copy:

- Strong flow model
- Versioning discipline
- Retry/error semantics
- reusable workflow building blocks

## Product Direction Recommendation

The right target is not "copy Zapier pixel by pixel".

The right target is:

- Zapier's guided authoring model
- n8n's data and execution model
- Activepieces' modern builder ergonomics
- Node-RED's explicit output/branch/debug clarity
- RelayAPI's social/contact specialization

## Functional Gaps To Close

### P0: correctness gaps

These are bugs or product-breaking mismatches:

- Trigger catalog must expose real trigger config schemas
- Template inputs must come from the same manifest model as the generic editor
- Condition nodes must get a visual builder
- Branch outputs must be authorable in the editor
- Message recipient behavior must be visible in the UI
- Archive button placement must be fixed
- Delete/error overlap must be fixed

### P1: workflow authoring fundamentals

- Explicit output handles
- Per-output add-step controls
- Step cards with app identity and operation naming
- First-class branch groups
- First-class fallback/default branch
- Better node summaries

### P2: data mapping and testing

- Sample event capture for triggers
- Test action / test step
- Previous-step data browser
- Insert variable/path picker
- expression mode
- static value vs dynamic value toggle

### P3: execution visibility

- Step-by-step run inspector
- branch decisions in history
- step input/output snapshots
- per-step logs
- rerun from failed step where safe

### P4: platform features

- Switch node
- Delay/Wait node
- Webhook trigger/action parity
- Code node
- loop/repeat/for-each node
- merge/join semantics
- subflows
- human approval node

## Proposed Schema Evolution

The current schema is too close to raw configuration storage and not rich enough for a professional editor.

Introduce a versioned manifest model.

### 1. Node manifest

```ts
type AutomationNodeManifest = {
  type: string;
  kind: "trigger" | "action" | "logic" | "flow_control" | "developer";
  app?: {
    id: string;
    name: string;
    icon?: string;
    brandColor?: string;
  };
  operation: {
    key: string;
    label: string;
    description?: string;
  };
  category: string;
  configSchema: JsonSchema;
  uiSchema?: UiSchema;
  mappingSchema?: MappingSchema;
  outputs: Array<{
    key: string;
    label: string;
    kind?: "success" | "error" | "branch" | "default";
  }>;
  capabilities?: {
    supportsTest?: boolean;
    supportsSampleData?: boolean;
    supportsDynamicValues?: boolean;
    supportsRetryPolicy?: boolean;
    supportsContinueOnError?: boolean;
  };
  defaults?: Record<string, unknown>;
  docs?: {
    summary?: string;
    setupGuideUrl?: string;
  };
};
```

### 2. Trigger manifest

Add:

- account requirements
- sample data strategy
- transport mode
- polling vs webhook
- config schema
- filters schema

```ts
type AutomationTriggerManifest = {
  type: string;
  channel: string;
  transport: "event" | "poll" | "webhook";
  accountBinding: {
    required: boolean;
    supportedChannels?: string[];
  };
  configSchema: JsonSchema;
  uiSchema?: UiSchema;
  sampleData?: {
    mode: "fetch" | "listen" | "mock";
  };
  outputs: [{ key: "next", label: "Next" }];
};
```

### 3. Recipient model for messaging nodes

Current implicit behavior should become an explicit default:

```ts
type MessageRecipientConfig =
  | { mode: "trigger_contact" }
  | { mode: "contact_field"; field: string }
  | { mode: "custom_identifier"; value: ValueBinding }
  | { mode: "conversation_participant"; role?: "sender" | "last_replier" };
```

### 4. Predicate model for logic nodes

Do not expose a raw `if` blob as the primary contract. Keep structured predicates, but support richer operators and UI metadata.

```ts
type PredicateGroup = {
  combinator: "all" | "any" | "none";
  rules: Array<PredicateRule | PredicateGroup>;
};

type PredicateRule = {
  left: ValueBinding;
  operator:
    | "exists"
    | "not_exists"
    | "equals"
    | "not_equals"
    | "contains"
    | "not_contains"
    | "starts_with"
    | "ends_with"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "in"
    | "not_in"
    | "matches_regex";
  right?: ValueBinding;
};
```

### 5. Value binding model

This is required if you want Zapier/n8n-grade dynamic mapping.

```ts
type ValueBinding =
  | { mode: "static"; value: unknown }
  | { mode: "path"; path: string }
  | { mode: "template"; template: string }
  | { mode: "expression"; expression: string };
```

### 6. Edge model

Make edge outputs explicit.

```ts
type AutomationEdge = {
  from: string;
  output: string;
  to: string;
  metadata?: {
    branchLabel?: string;
    isFallback?: boolean;
  };
};
```

### 7. Execution model

Per-step inspection must be designed into the schema now.

```ts
type StepExecutionRecord = {
  nodeKey: string;
  status: "pending" | "running" | "success" | "filtered" | "skipped" | "failed";
  output?: string;
  startedAt?: string;
  finishedAt?: string;
  inputSnapshot?: unknown;
  outputSnapshot?: unknown;
  logs?: Array<{ level: "info" | "warn" | "error"; message: string }>;
  error?: {
    code?: string;
    message: string;
    details?: unknown;
  };
};
```

## Editor Rebuild Plan

## 1. Redesign the step card

Target card anatomy:

- top-left: app icon or internal logic icon
- first line: app name or logic family
- second line: operation label
- optional summary line
- top-right: status/menu area
- bottom/side: visible output handles

Examples:

- `Instagram` / `New comment`
- `Messaging` / `Send message`
- `Logic` / `If contact has tag`

Remove:

- internal-feeling raw node key as primary title
- floating delete icon on hover

Add:

- overflow menu
- clearer selected state
- clearer error state
- optional "configured / incomplete / error" badges

## 2. Make outputs visible

Every node should expose its outputs visually.

Examples:

- Trigger: `next`
- Condition: `yes`, `no`
- Switch: `case 1`, `case 2`, `default`
- Send message: `next`, optionally `error` if continue-on-error is enabled

This is the missing foundation for a real branch UX.

## 3. Replace raw object editing with purpose-built editors

Required editors:

- trigger config form
- condition builder
- delay builder
- recipient selector
- dynamic mapping field
- test/sample data panel

Advanced mode can still expose raw JSON, but it must be behind an "Advanced" affordance.

## 4. Add a data panel

This is essential.

Panel should show:

- trigger sample payload
- previous step outputs
- contact fields
- captured state
- built-in variables

Interactions:

- click to insert path
- drag to map into field
- toggle between static and dynamic values

## 5. Make branching authorable

Required UX:

- click `+` on a node output handle
- select node type for that output
- condition node auto-creates `yes` and `no` placeholders
- switch node can add/remove cases
- branch names editable

## 6. Improve right panel model

Right panel should be able to show:

- setup
- test
- output data
- run history for selected step
- notes

For triggers:

- account binding
- trigger config
- test trigger
- sample event capture

For actions:

- setup
- dynamic mapping
- test action
- last test result

## Runtime And Backend Plan

## 1. Build a manifest registry

Create one source of truth that powers:

- API schema catalog
- dashboard forms
- template wizard forms
- docs generation
- runtime validation

This registry should be derived from actual runtime-supported handlers, not maintained separately by hand.

## 2. Add schema parity tests

Add automated tests that fail if:

- a runtime-supported trigger has empty `config_schema`
- a node exists in the editor catalog without a handler
- a template references unknown node types
- a node output label is used in edges but missing in the manifest

## 3. Add sample data/test endpoints

Needed endpoints:

- test trigger
- fetch latest sample event
- test node with sample input
- validate workflow

## 4. Enrich execution logging

Persist enough execution detail for:

- node-by-node history
- branch result visualization
- mapping/debug support
- support troubleshooting

## 5. Normalize message delivery semantics

Messaging nodes should not silently rely on hidden conventions. The execution engine can still default intelligently, but the contract must be explicit and inspectable.

## New Node Set Recommendation

Prioritize a smaller, excellent node set before expanding breadth.

### Core triggers

- Instagram comment
- Instagram DM
- Instagram story reply
- Follower added
- Webhook catch
- Schedule

### Core messaging/actions

- Send message text
- Send message template
- Reply to comment
- Add tag
- Remove tag
- Set field
- Create/update contact
- HTTP request

### Core logic

- Filter
- If
- Switch
- Delay
- Wait for event
- Loop/for-each

### Advanced

- Code
- Webhook response / outgoing webhook
- Subflow
- Human approval

## Phased Delivery Plan

## Phase 0: Stop the bleeding

Time: 3-5 days

Ship:

- real trigger config schemas in `/automations/schema`
- move Archive next to Run history
- move delete into overflow menu
- prevent error/status overlap
- explain default message recipient in UI
- basic condition helper text: "This is a rule object, not JavaScript"

Success criteria:

- Instagram comment trigger becomes configurable in the generic editor
- message text no longer feels mysterious
- obvious card polish issues are fixed

## Phase 1: Schema and catalog integrity

Time: 1-2 weeks

Ship:

- manifest registry
- schema parity tests
- template forms backed by manifest inputs
- runtime/editor/docs catalog alignment

Success criteria:

- one source of truth
- no empty trigger config schemas for supported triggers

## Phase 2: Editor UX overhaul

Time: 2-3 weeks

Ship:

- redesigned step cards
- output handles
- branch authoring
- node summary improvements
- overflow menus

Success criteria:

- condition nodes support visible `yes/no` flow authoring
- cards look professional and productized

## Phase 3: Data mapping and condition builder

Time: 2-3 weeks

Ship:

- data panel
- path insertion
- static vs dynamic field modes
- visual condition builder
- advanced JSON fallback

Success criteria:

- users can build conditions without writing JSON manually
- message nodes can map dynamic content and recipient values

## Phase 4: Test and execution experience

Time: 2-3 weeks

Ship:

- trigger test/sample capture
- action test
- step output preview
- richer run history
- per-step execution detail

Success criteria:

- debugging moves from support-only to self-serve

## Phase 5: Workflow platform expansion

Time: 3-6 weeks

Ship:

- Switch
- Delay/Wait
- HTTP
- Code
- Loop
- Subflow
- better retry/error policies

Success criteria:

- system becomes a credible automation platform rather than a narrow template runner

## Reality Check

"Replicate the full functionality of Zapier" is a multi-quarter program, not a patch.

A credible first target is:

- excellent social automation workflows
- professional workflow editor
- first-class branching
- first-class testing and history
- explicit dynamic mapping

That is enough to move the product from "feels incomplete" to "feels like a real automation platform".

## Recommended Immediate Work Items

If implementation starts now, this is the order I would use:

1. Fix trigger config schemas for supported triggers.
2. Add manifest parity tests so this cannot regress.
3. Move Archive next to Run history.
4. Remove floating delete and replace with overflow menu.
5. Redesign cards around app + operation semantics.
6. Introduce visible outputs and condition branch handles.
7. Ship a real condition builder.
8. Add sample data and mapping panel.

## Source Notes

External analysis was based on official product docs and official repositories.

### Zapier

- Zap editor: https://help.zapier.com/hc/en-us/articles/16722578092429-Use-the-editor-to-build-and-view-your-Zaps
- Filters: https://help.zapier.com/hc/en-us/articles/8496276332557-Add-conditions-to-Zaps-with-filters
- Paths: https://help.zapier.com/hc/en-us/articles/8496288555917-Add-branching-logic-to-Zaps-with-paths
- Filter vs Paths: https://help.zapier.com/hc/en-us/articles/8496180919949-Filter-and-path-rules-in-Zaps
- Delay: https://help.zapier.com/hc/en-us/articles/8496288754829-Add-delays-to-Zaps
- Code: https://help.zapier.com/hc/en-us/articles/8496326417549-Use-Python-code-in-Zaps
- Webhooks trigger: https://help.zapier.com/hc/en-us/articles/8496288690317-Trigger-Zaps-from-webhooks
- Zap history: https://help.zapier.com/hc/en-us/articles/8496291148685-View-and-manage-your-Zap-history
- Assets/folders: https://help.zapier.com/hc/en-us/articles/39703663119117-View-all-assets-in-your-Zapier-account
- Manage folders/assets: https://help.zapier.com/hc/en-us/articles/8496326119565-Manage-your-Zaps
- Notes: https://help.zapier.com/hc/en-us/articles/16791272000525

### n8n

- Repo: https://github.com/n8n-io/n8n
- Data mapping: https://docs.n8n.io/data/data-mapping/
- Mapping UI: https://docs.n8n.io/data/data-mapping/data-mapping-ui/
- IF node: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.if/
- Switch node: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.switch/
- Wait node: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.wait/
- Error handling: https://docs.n8n.io/flow-logic/error-handling/
- Sub-workflows: https://docs.n8n.io/flow-logic/subworkflows/
- Executions: https://docs.n8n.io/workflows/executions/
- Debug past executions: https://docs.n8n.io/workflows/executions/debug/

### Activepieces

- Repo: https://github.com/activepieces/activepieces
- Product site: https://www.activepieces.com/
- Building flows: https://www.activepieces.com/docs/flows/building-flows
- Passing data: https://www.activepieces.com/docs/flows/passing-data
- Publishing/versioning: https://www.activepieces.com/docs/flows/publishing-flows
- Version history: https://www.activepieces.com/docs/flows/versioning
- Flow control: https://www.activepieces.com/docs/build-pieces/piece-reference/flow-control
- Human in the loop: https://www.activepieces.com/docs/handbook/teams/human-in-loop

### Node-RED

- Repo: https://github.com/node-red/node-red
- Editor overview: https://nodered.org/docs/user-guide/editor/
- Workspace/subflows: https://nodered.org/docs/user-guide/editor/workspace/
- Palette: https://nodered.org/docs/user-guide/editor/palette/
- Info sidebar: https://nodered.org/docs/user-guide/editor/sidebar/info
- Debug sidebar: https://nodered.org/docs/user-guide/editor/sidebar/debug
- Messages: https://nodered.org/docs/user-guide/messages
- Core nodes: https://nodered.org/docs/user-guide/nodes

### Automatisch

- Repo: https://github.com/automatisch/automatisch
- Docs: https://automatisch.io/docs/
- Create flow guide: https://automatisch.io/docs/guide/create-flow

### Kestra

- Repo: https://github.com/kestra-io/kestra
- Docs: https://kestra.io/docs/
- UI flows: https://kestra.io/docs/ui/flows
- Workflow components: https://kestra.io/docs/workflow-components

## Appendix: Local Code References

- `apps/api/src/routes/automations.ts`
- `apps/api/src/routes/automation-templates.ts`
- `apps/api/src/services/automations/nodes/message-text.ts`
- `apps/api/src/services/automations/nodes/condition.ts`
- `apps/api/src/schemas/automations.ts`
- `apps/app/src/components/dashboard/pages/automation-detail-page.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/property-panel.tsx`
- `apps/app/src/components/dashboard/automation/template-picker-dialog.tsx`
