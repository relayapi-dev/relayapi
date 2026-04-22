# Automation System Deep Analysis and Rebuild Plan

> **DEPRECATED — historical planning artifact.** This document is one of the audits that informed the Manychat-parity automation rebuild. The current source of truth is [`docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md`](./superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md). The storage model, runner semantics, and API surface described here no longer match the shipped system. Kept for reference only — do not implement from this document.

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

Status: Completed on 2026-04-18

Implemented:

- real trigger config schemas in `/automations/schema`
- template input schemas in `/automations/schema`
- archive moved next to run history
- floating delete removed in favor of overflow step actions
- trigger account binding exposed in the editor
- trigger and message behavior clarified in UI
- condition node upgraded from raw JSON-only editing to a structured rule builder
- trigger card and step error states now surface validation failures directly

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

Status: In progress

Implemented so far:

- runtime catalog guard prevents supported triggers/templates from silently losing schemas
- shared automation manifest registry now powers the `/v1/automations/schema` trigger/node/template catalog
- manifest parity tests now cover integrity, published trigger/node visibility, and template coverage
- SDK contract updated for nullable trigger account binding
- schema endpoint now reflects real trigger/template shapes instead of placeholder empty objects

Still open:

- deeper manifest reuse across template materialization and remaining editor metadata surfaces
- broader parity tests beyond the current runtime guard

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

Status: Completed on 2026-04-18

Implemented:

- redesigned trigger and step cards around app + operation semantics
- explicit multi-output badges on cards
- branch-aware rendering for condition and other multi-output nodes
- branch columns with per-output add-step affordances
- node summaries improved
- overflow menus replace hover-delete affordances
- trigger-level validation errors now highlight the trigger card
- simulator branch controls now use known output labels when available

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

Status: In progress

Implemented so far:

- visual condition builder for `condition.if`
- data reference browser in the property panel for `contact.*` and `state.*` values
- static vs dynamic authoring modes for text-like fields
- merge-tag insertion at cursor for dynamic text fields
- JSON mapping editors for object/payload/body fields with merge-tag support
- array editors now support data-token insertion for focused string fields
- webhook endpoint picker for `webhook_out`
- runtime recursive templating for `field_set`, `http_request`, and `webhook_out`
- universal `message_text` now supports explicit recipient override via custom recipient identifiers

Still open:

- richer specialized editors for complex nested platform payloads beyond the generic array/object builders

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

Status: In progress

Implemented so far:

- run history now supports per-step detail inspection
- execution logs now persist structured payload metadata from the runner
- simulator branch choice UX improved
- builder now supports queuing a live test enrollment from the simulator panel
- builder now surfaces recent enrollment payloads as reusable trigger samples for live testing
- run history now supports rerunning an enrollment with the same contact/conversation/payload
- run history now surfaces the captured enrollment state for inspection and replay

Still open:

- broader step output previews and rerun workflows

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

Status: In progress

Implemented so far:

- `split_test` is now runtime-supported instead of stubbed
- `webhook_out` is now runtime-supported instead of stubbed
- `subscription_add` and `subscription_remove` are now runtime-supported instead of stubbed
- `segment_add` and `segment_remove` are now runtime-supported against real static segment memberships
- `conversation_assign` is now runtime-supported with user-only replace semantics
- `conversation_status` is now runtime-supported instead of stubbed
- `notify_admin` is now runtime-supported for in-app and email delivery
- runtime templating now covers outbound webhook payloads and HTTP request payloads
- inbox APIs now expose `assigned_user_id` and support manual reassignment
- contact APIs now expose `segment_ids` plus manual add/remove/list operations for static segment memberships

Still open:

- Switch
- Delay/Wait expansion beyond current nodes
- HTTP/subflow/loop/human approval rollout
- broader retry/error policy controls

Time: 3-6 weeks

Ship:

- Switch
- Delay/Wait
- HTTP
- Loop
- Subflow
- better retry/error policies

Success criteria:

- system becomes a credible automation platform rather than a narrow template runner

## Detailed Execution Plan

This section turns the phase roadmap into an execution program with explicit
dependencies, file ownership, and completion criteria. The purpose is to avoid
the previous ambiguity where "good progress" was treated like "finished".

### Program rule

Implementation should continue until one of these is true:

- every milestone below is complete and verified
- a real blocker requires a product or data-model decision
- local user changes conflict with the required implementation

Everything else should count as "continue".

### Definition of finished

The automation system should only be called "finished" for this rebuild when
all of the following are true:

- schema/catalog data comes from a single manifest model across runtime, schema
  endpoint, templates, SDK-facing metadata, and builder palette/forms
- no major automation node used in the product requires raw JSON to be usable
- operators can simulate, live test, inspect state, inspect per-step output,
  and rerun flows without touching the database manually
- the currently exposed node catalog is either runtime-supported or hidden
- missing core nodes (`conversation_assign`, segment membership ops, multi-path
  switching, richer wait controls) are either implemented or explicitly removed
  from the supported product scope
- verification exists at API, SDK, and builder levels so regressions are caught

### Milestone 1: Finish manifest unification

Goal:

- remove the remaining duplicated trigger/node/template catalog logic

Why first:

- every further editor and template improvement depends on trusted metadata

Implementation:

- move remaining template definitions in `apps/api/src/routes/automation-templates.ts`
  onto the shared manifest contract
- make the builder/template picker consume manifest-driven template metadata
  instead of route-local assumptions where possible
- extend `apps/api/src/services/automations/manifest.ts` to carry richer UI
  metadata where JSON Schema alone is insufficient
- keep `/v1/automations/schema` as the canonical machine-readable surface
- add tests that fail when:
  - a published node has no schema
  - a published trigger has no schema
  - a template exists in routes but not in the manifest
  - a stubbed node leaks into the published catalog

Likely files:

- `apps/api/src/services/automations/manifest.ts`
- `apps/api/src/routes/automations.ts`
- `apps/api/src/routes/automation-templates.ts`
- `packages/sdk/src/resources/automations.ts`
- `apps/app/src/components/dashboard/automation/template-picker-dialog.tsx`
- `apps/api/src/__tests__/automations.test.ts`

Done when:

- manifest is the single source of truth for published trigger/node/template metadata
- no route-local automation catalog duplication remains except intentional runtime wiring

### Milestone 2: Finish builder mapping UX

Goal:

- make complex nodes operable without raw JSON editing

Current status:

- good baseline exists for strings, JSON payloads, webhook payloads, recipient
  overrides, and array token insertion

Still required:

- specialized editors for common nested platform shapes:
  - WhatsApp template components
  - Telegram keyboards/polls
  - Instagram/Facebook buttons and quick replies
  - card/template element arrays
- manifest-level field hints for editor behavior:
  - `editor: "merge_text"`
  - `editor: "json_payload"`
  - `editor: "button_array"`
  - `editor: "template_components"`
- structured preview of the final mapped config before save where useful

Likely files:

- `apps/api/src/services/automations/manifest.ts`
- `apps/app/src/components/dashboard/automation/flow-builder/property-panel.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/data-references.ts`
- `apps/app/src/components/dashboard/automation/flow-builder/types.ts`

Done when:

- common social automation nodes can be configured visually
- raw JSON remains only as an advanced fallback, not the primary UX

### Milestone 3: Execution and testing tooling

Goal:

- make debugging self-serve from the builder

Current status:

- simulation exists
- live test enrollment exists
- recent samples exist
- rerun from history exists
- run state and per-step logs are visible

Still required:

- step output preview:
  - expose output/result payloads consistently in run logs
  - distinguish input, output, and state patch in the log model
- rerun from step where safe:
  - either via a dedicated rerun endpoint or a server-side replay helper
- action test workflow:
  - test a single node against a captured sample without advancing the full flow
- optional trigger sample pinning:
  - save a sample as a reusable named test fixture per automation

Likely files:

- `apps/api/src/routes/automations.ts`
- `apps/api/src/services/automations/runner.ts`
- `apps/api/src/services/automations/types.ts`
- `apps/app/src/components/dashboard/automation/flow-builder/run-history-panel.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/simulator-panel.tsx`
- `packages/sdk/src/resources/automations.ts`

Done when:

- a user can select a run, inspect state and step outputs, and replay a flow or
  step using captured data without manual API crafting

### Milestone 4: Data-model expansion for blocked runtime nodes

Goal:

- unblock the nodes that cannot be implemented safely with the current schema

Blocked today:

- `conversation_assign`
  - implemented: `inbox_conversations.assigned_user_id`
  - implemented: runtime handler and inbox API exposure
  - remaining gap: no team assignment in this phase
- `segment_add` / `segment_remove`
  - implemented: `contact_segment_memberships`
  - implemented: automation runtime handlers and contact API management surface
  - remaining gap: dynamic segments remain computed-only by design
- `subflow_call`
  - needs parent/child enrollment linkage and snapshot inheritance rules

Proposed schema work:

- completed: add `assigned_user_id` to `inbox_conversations`
- completed: add `contact_segment_memberships`
  - `contact_id`
  - `segment_id`
  - `source` (`manual`, `automation`, `import`, etc.)
  - `created_by_user_id`
  - timestamps
- add subflow linkage if subflow support remains in scope:
  - `parent_enrollment_id`
  - `resume_parent_on_child_complete` semantics

Likely files:

- `packages/db/src/schema.ts`
- generated migration files
- `apps/api/src/services/automations/nodes/conversation-assign.ts`
- `apps/api/src/services/automations/nodes/segment-actions.ts`
- `apps/api/src/services/automations/nodes/subflow-call.ts`
- `apps/api/src/services/automations/nodes/index.ts`
- `apps/api/src/schemas/automations.ts`

Done when:

- blocked nodes that depend on persistence can be implemented against a real
  model instead of fake runtime behavior
- remaining persistence blocker is limited to `subflow_call`

### Milestone 5: Control-flow expansion

Goal:

- close the gap between the current flow runner and a real automation engine

Required nodes:

- `switch`
  - multi-case successor to binary `condition`
  - explicit labeled outputs and default branch
- richer wait controls
  - `wait_until`
  - `wait_for_event`
  - clearer time-window semantics
- optional later tranche:
  - `loop`
  - `code`
  - `human_approval`

Required engine work:

- add new node types to the enum/schema/manifest
- support deterministic branch labels in simulator and builder
- ensure run logs capture branch choice and wait metadata

Likely files:

- `packages/db/src/schema.ts`
- `apps/api/src/schemas/automations.ts`
- `apps/api/src/services/automations/nodes/*.ts`
- `apps/api/src/services/automations/simulator.ts`
- `apps/app/src/components/dashboard/automation/flow-builder/*`

Done when:

- branching is not limited to binary conditions and weighted splits
- wait semantics cover the common automation cases without hacks

### Milestone 6: Reliability and policy controls

Goal:

- make failures predictable and operator-controlled

Required work:

- add per-node retry policy metadata:
  - max attempts
  - retry delay/backoff
  - timeout
- decide per-node failure behavior:
  - fail automation
  - continue on error
  - route to explicit error branch
- surface policy state in run logs and builder UI

Likely files:

- `apps/api/src/schemas/automations.ts`
- `apps/api/src/services/automations/runner.ts`
- `apps/app/src/components/dashboard/automation/flow-builder/property-panel.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/run-history-panel.tsx`

Done when:

- automation failures are configured intentionally instead of being implicit runner defaults

### Milestone 7: Template/editor/runtime convergence

Goal:

- eliminate the remaining split between quick-create templates and the generic builder

Required work:

- ensure every template is expressible as a normal manifest-backed automation graph
- ensure template forms are generated from the same input metadata model
- ensure generated template graphs use only supported nodes and labels
- add tests that create templates, read resulting graphs, and validate them
  against manifest expectations

Likely files:

- `apps/api/src/routes/automation-templates.ts`
- `apps/api/src/services/automations/manifest.ts`
- `apps/app/src/components/dashboard/automation/template-picker-dialog.tsx`
- `apps/api/src/__tests__/automations.test.ts`

Done when:

- templates are just a guided entry point into the same automation system, not a special path

### Milestone 8: Final QA and scope gate

Goal:

- close the rebuild with an explicit supported-product boundary

Required work:

- end-to-end smoke coverage for:
  - comment trigger → DM
  - DM keyword flow
  - condition branch
  - split test
  - webhook out
  - notify admin
  - history replay
- verify app/API/SDK typecheck cleanly together
- explicitly mark unsupported nodes as hidden/stubbed if they remain out of scope
- update docs to define:
  - supported trigger list
  - supported node list
  - unsupported/coming-later node list

Done when:

- the product has a truthful and test-backed automation scope

### Implementation order

This is the order implementation should follow from here:

1. Milestone 1: finish manifest unification
2. Milestone 3: finish execution/testing tooling
3. Milestone 4: add missing persistence model for blocked nodes
4. Milestone 5: add control-flow nodes once metadata and runtime base are stable
5. Milestone 2: finish specialized mapping editors in parallel where metadata is ready
6. Milestone 6: reliability and retry policy controls
7. Milestone 7: template/editor/runtime convergence
8. Milestone 8: final QA and scope gate

### Explicit blockers that require decisions

These were open blockers. Product decisions are now fixed and should be
treated as implementation requirements, not open questions:

- `conversation_assign`
  - scope: `user-only`
  - behavior: replace the current assignee
  - no team assignment in this phase
- `segment_add` / `segment_remove`
  - scope: manual/static segment memberships only
  - dynamic filter-based segments remain computed and read-only
- `subflow_call`
  - execution: synchronous
  - versioning: child version pinned when the parent is published
- `code`
  - removed from the current automation-platform scope
- `human_approval`
  - minimal version is approved for this program
  - support explicit users or org admins, with `approved` / `rejected` /
    `timed_out` branches
- supporting product surfaces
  - approved: assignment and manual segment state should be visible and
    manageable outside the raw node handlers where needed

### Verification rule per milestone

Every milestone should close with:

- relevant API tests
- app typecheck
- API typecheck
- SDK typecheck
- roadmap doc status update

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
