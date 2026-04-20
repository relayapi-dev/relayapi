# Manychat Automation Greenfield Implementation Plan

Date: 2026-04-20

Status: This supersedes the earlier incremental plan. The design target now assumes no backward-compatibility requirement.

## Decision

Do not preserve the current automation schema just because it already exists.

If the goal is to design a serious Manychat-class automation system now, the correct move is:

1. Keep only the broad concepts that are still right:
   - automations
   - revisions
   - graph nodes
   - graph edges
   - entrypoints
   - runs
   - logs
2. Redesign the actual database model, API contract, runtime, and builder around the target product.
3. Ship the whole feature stack on the new model instead of layering more UI on top of a shape that is already wrong in several places.

## Executive Summary

The current system proves that RelayAPI can store and execute automation graphs. It does not prove that the current model is the right product model.

The main structural mismatches versus Manychat are:

- too many platform-specific node types
- no first-class port model
- edges keyed by labels instead of source/target ports
- atomic send nodes instead of composite message nodes with ordered blocks
- buttons and quick replies are payload details, not branchable graph objects
- triggers are too generic and do not distinguish flow entrypoints from product bindings like default reply or welcome message
- no first-class model for contact-level pause/resume
- no first-class product layer for quick automations, basic automations, preview, and insights

The correct target is not "make the current graph nicer." The correct target is:

- smaller core node vocabulary
- explicit ports
- one message node with many block types
- one action node with many actions
- entrypoints and bindings as separate concepts
- revision-pinned execution
- builder interactions mapped directly to the DB model

## Final Verdict

The DB should change materially.

If you want Manychat parity, these are not optional:

- replace label-based edges with port-based edges
- collapse the platform-specific send-node explosion into a smaller node system
- redesign message persistence around block composition
- redesign trigger persistence around entrypoints and bindings
- redesign execution state around revision-pinned runs and contact controls

The two UI gaps you called out are still real:

- node-to-node connections
- drag-to-create action popover

But in the greenfield plan they should be implemented on the new port model, not bolted onto the old label model.

## Product Target

The target product should cover these layers:

1. Flow Builder
   - canvas graph editing
   - direct port connections
   - drag-to-create nodes
   - reconnect edges
   - duplicate, copy/paste, multi-select, auto-arrange
2. Message Authoring
   - one message step with ordered blocks
   - buttons and quick replies that branch the graph
   - channel capability validation
3. Entrypoints
   - comments, DMs, story replies, story mentions, live comments, ads, ref links, keywords, schedules, field changes, tag changes
4. Basic Automations
   - default reply
   - welcome message
   - conversation starters
   - main menu
   - WhatsApp ice breakers
5. Rules
   - trigger + conditions + action group outside the main flow graph
6. Quick Automations
   - comment to DM
   - story leads
   - follower growth flows
   - follow to DM where channel support exists
7. Runtime and Inbox Controls
   - contact-level pause/resume
   - manual takeover
   - run inspector
8. Testing and Analytics
   - preview
   - live test
   - node-level metrics
   - product-level insights

## What To Keep Vs Replace

| Area | Keep | Replace |
|---|---|---|
| Automation resource concept | Yes | No reason to rename the product |
| Versioned publish model | Yes | Rework implementation around revisions |
| Graph concept | Yes | Rebuild graph storage around ports |
| `automation_nodes` shape | No | Too many atomic node types |
| `automation_edges` shape | No | Labels are the wrong primary routing primitive |
| `automation_triggers` shape | No | Needs entrypoints plus bindings |
| Enrollment/run concept | Yes | Rework state model and analytics |
| UI shell/layout | Mostly yes | Replace underlying graph interactions and editors |
| SDK automation resource | Yes | Replace contract surface to match new model |

## Target Architecture

### Core Principles

- Graph structure must be explicit and deterministic.
- Ports are first-class. Branching lives on ports, not edge labels.
- Messages are composite documents, not chains of tiny send nodes.
- Interactive elements must have stable IDs so edges can target them.
- Entrypoints are not the same thing as channel bindings.
- Draft editing and published execution must be revision-based.
- Channel-specific behavior should live in validation and runtime capability maps, not in dozens of separate node types.

### Node Vocabulary

Replace the current large enum surface with a compact core set:

- `message`
- `input`
- `delay`
- `condition`
- `randomizer`
- `action_group`
- `http_request`
- `ai_step`
- `start_automation`
- `goto`
- `end`

Optional later additions:

- `code_step`
- `agent_handoff`
- `custom_app_action`

This is closer to how Manychat behaves in practice. The product has a smaller conceptual step vocabulary than the current RelayAPI schema.

### Port Model

Every node exposes explicit ports.

Examples:

- `condition`
  - input: `in`
  - outputs: `true`, `false`
- `randomizer`
  - input: `in`
  - outputs: `variant.a`, `variant.b`, `variant.c`
- `input`
  - input: `in`
  - outputs: `captured`, `invalid`, `timeout`, `skip`
- `message`
  - input: `in`
  - outputs: `next`
  - optional interactive outputs:
    - `button.buy_now`
    - `button.learn_more`
    - `quick_reply.yes`
    - `quick_reply.no`
    - `no_response`
- `action_group`
  - input: `in`
  - outputs: `next`, `error`

This is the single most important schema change because it solves:

- direct node connections
- explicit branch handles
- buttons and quick replies as graph branches
- reconnect logic
- clean UI rendering
- predictable runtime traversal

## Proposed Target Database Schema

The recommendation is a hybrid model:

- normalize the graph structure and product bindings
- keep node internals typed in JSON
- keep message block internals inside node config, but every interactive child must have a stable key that maps to a port

### 1. `automations`

Purpose:

- top-level product object

Suggested fields:

- `id`
- `organization_id`
- `workspace_id`
- `name`
- `description`
- `channel_scope`
- `status`
- `draft_revision_id`
- `published_revision_id`
- `created_by`
- `created_at`
- `updated_at`

Notes:

- `channel_scope` can be one channel or `omnichannel`
- `status` should be product-level only: `draft`, `published`, `paused`, `archived`

### 2. `automation_revisions`

Purpose:

- immutable publish snapshots
- one mutable draft revision per automation

Suggested fields:

- `id`
- `automation_id`
- `number`
- `state`
  - `draft`
  - `published`
  - `archived`
- `root_node_id`
- `schema_version`
- `snapshot_hash`
- `published_at`
- `published_by`
- `created_at`
- `updated_at`

Notes:

- execution always pins to `revision_id`
- the draft builder edits rows under the draft revision

### 3. `automation_nodes`

Purpose:

- store the node graph

Suggested fields:

- `id`
- `revision_id`
- `key`
- `kind`
- `title`
- `config`
- `ui_state`
- `canvas_x`
- `canvas_y`
- `created_at`
- `updated_at`

Notes:

- `kind` is the compact node vocabulary, not 100-plus platform variants
- `config` is typed by `kind`
- `ui_state` can hold collapsed state, color hints, notes, selection metadata

### 4. `automation_ports`

Purpose:

- first-class routing points for the graph

Suggested fields:

- `id`
- `node_id`
- `key`
- `direction`
  - `input`
  - `output`
- `role`
  - `default`
  - `success`
  - `error`
  - `branch`
  - `interactive`
  - `timeout`
  - `invalid`
  - `skip`
- `label`
- `order_index`
- `config`

Notes:

- `key` must be stable
- interactive buttons and quick replies need stable keys that survive editing
- the builder renders handles directly from these rows

### 5. `automation_edges`

Purpose:

- connect output ports to input ports

Suggested fields:

- `id`
- `revision_id`
- `from_port_id`
- `to_port_id`
- `order_index`
- `metadata`
- `created_at`

Notes:

- remove the old `label` routing model
- remove `condition_expr` from edges
- branch logic belongs to node config and output ports

### 6. `automation_entrypoints`

Purpose:

- define actual flow entry triggers

Suggested fields:

- `id`
- `automation_id`
- `revision_id`
- `channel`
- `kind`
- `status`
- `social_account_id`
- `config`
- `filters`
- `asset_ref`
- `label`
- `priority`
- `created_at`
- `updated_at`

Examples of `kind`:

- `dm_received`
- `keyword`
- `comment_created`
- `story_reply`
- `story_mention`
- `live_comment`
- `ad_click`
- `ref_link_click`
- `share_to_dm`
- `follow`
- `schedule`
- `field_changed`
- `tag_applied`
- `tag_removed`
- `conversion_event`

Notes:

- entrypoints are flow entry triggers only
- default reply and welcome message do not belong here

### 7. `automation_bindings`

Purpose:

- bind an automation revision to a channel-owned product surface

Suggested fields:

- `id`
- `organization_id`
- `workspace_id`
- `social_account_id`
- `channel`
- `binding_type`
- `automation_id`
- `revision_id`
- `config`
- `status`
- `created_at`
- `updated_at`

Examples of `binding_type`:

- `default_reply`
- `welcome_message`
- `conversation_starter`
- `main_menu`
- `ice_breaker`

Notes:

- this is the clean separation Manychat implicitly has
- it prevents overloading trigger rows with product binding semantics

### 8. `automation_rules`

Purpose:

- global trigger-condition-action rules outside the flow graph

Suggested fields:

- `id`
- `organization_id`
- `workspace_id`
- `name`
- `status`
- `channel_scope`
- `trigger`
- `condition`
- `actions`
- `priority`
- `created_at`
- `updated_at`

Notes:

- rules are not the same resource as flow graphs
- they deserve a smaller specialized model

### 9. `automation_runs`

Purpose:

- track one execution instance pinned to a revision

Suggested fields:

- `id`
- `automation_id`
- `revision_id`
- `entrypoint_id`
- `binding_id`
- `organization_id`
- `contact_id`
- `conversation_id`
- `status`
  - `active`
  - `waiting`
  - `completed`
  - `exited`
  - `failed`
  - `paused`
- `current_node_id`
- `current_port_id`
- `context`
- `waiting_until`
- `pause_reason`
- `started_at`
- `completed_at`
- `updated_at`

Notes:

- replace the old enrollment shape with a run-first model
- `context` stores captured inputs, AI outputs, sticky randomizer decisions, request responses, and merge-tag state

### 10. `automation_step_runs`

Purpose:

- log every executed node and branch

Suggested fields:

- `id`
- `run_id`
- `node_id`
- `entered_via_port_id`
- `exited_via_port_id`
- `outcome`
- `duration_ms`
- `payload`
- `error`
- `executed_at`

Notes:

- this becomes the basis for run inspection and later analytics

### 11. `automation_scheduled_jobs`

Purpose:

- queue delayed resumptions and scheduled trigger executions

Suggested fields:

- `id`
- `run_id`
- `job_type`
- `run_at`
- `status`
- `attempts`
- `claimed_at`
- `payload`
- `created_at`

### 12. `automation_contact_controls`

Purpose:

- support Manychat-style pause/resume and manual takeover

Suggested fields:

- `id`
- `organization_id`
- `contact_id`
- `conversation_id`
- `channel`
- `status`
  - `active`
  - `paused`
  - `muted`
- `pause_reason`
- `paused_until`
- `paused_by_user_id`
- `config`
- `created_at`
- `updated_at`

### 13. `automation_test_sessions`

Purpose:

- support preview and live test flows

Suggested fields:

- `id`
- `automation_id`
- `revision_id`
- `channel`
- `operator_user_id`
- `contact_fixture_id`
- `status`
- `transcript`
- `created_at`
- `updated_at`

### 14. `automation_insight_rollups`

Purpose:

- optional pre-aggregated analytics for fast dashboards

Suggested fields:

- `id`
- `scope_type`
  - `automation`
  - `entrypoint`
  - `node`
  - `binding`
  - `experience`
- `scope_id`
- `bucket_start`
- `bucket_granularity`
- `metrics`
- `updated_at`

Notes:

- this can come after the initial runtime if needed
- if speed matters, derive analytics from `automation_step_runs` first and add rollups later

## Message Model

This is the second major schema decision after ports.

### Recommended `message` Node Shape

Store one `message` node with config similar to:

```json
{
  "channel": "instagram",
  "blocks": [
    {
      "id": "blk_text_intro",
      "type": "text",
      "text": "Hi {{first_name}}",
      "buttons": [
        {
          "id": "btn_book",
          "label": "Book now",
          "action": "branch"
        }
      ],
      "quick_replies": [
        {
          "id": "qr_yes",
          "label": "Yes"
        },
        {
          "id": "qr_no",
          "label": "No"
        }
      ]
    },
    {
      "id": "blk_image_offer",
      "type": "image",
      "media_ref": "med_123"
    }
  ],
  "fallback_behavior": {
    "on_no_response_port": "no_response"
  }
}
```

### Supported Block Types

Phase 1 target:

- `text`
- `image`
- `video`
- `audio`
- `file`
- `delay`
- `input`
- `card`
- `gallery`

Phase 2 target:

- `dynamic`
- `list`
- `template`

### Why This Model Is Better

- matches Manychat's authoring model
- reduces node sprawl
- keeps the canvas readable
- makes preview much easier
- lets buttons and quick replies map to ports cleanly

## Action Model

Manychat treats "Actions" as one block containing many tasks. RelayAPI should do the same.

### Recommended `action_group` Node Shape

Store one node with ordered actions:

```json
{
  "actions": [
    { "id": "a1", "type": "tag_add", "tag": "lead" },
    { "id": "a2", "type": "field_set", "field": "campaign", "value": "spring" },
    { "id": "a3", "type": "notify_admin", "channel": "in_app", "title": "New lead" }
  ]
}
```

### Required Action Coverage

Must-have:

- add/remove tag
- set/clear contact field
- set/clear bot or workspace field
- subscribe/unsubscribe sequence or list
- assign conversation
- open/close/snooze conversation
- notify admin
- external HTTP request
- webhook out
- delete contact
- opt-in/opt-out channel
- change menu
- log conversion event
- pause automations for contact
- resume automations for contact

This is cleaner than keeping one action per node and pretending chains are equivalent.

## Trigger And Binding Model

### Entrypoints

Entrypoints start a flow.

Examples:

- Instagram comment trigger
- story reply trigger
- keyword trigger
- DM received trigger
- scheduled trigger

### Bindings

Bindings attach a flow to a product surface owned by the channel integration.

Examples:

- default reply
- welcome message
- main menu item
- conversation starter
- WhatsApp ice breaker

### Why The Separation Matters

Without this split, the API and UI stay confused about whether the user is:

- configuring a trigger
- assigning a channel default behavior
- building a reusable automation
- setting up a productized quick automation

Manychat exposes these as different user concepts. RelayAPI should too.

## Quick Automation Product Layer

Quick automations should not just be templates.

They should be their own product resource built on top of flows.

### Recommended Resource

Add `automation_experiences`.

Suggested fields:

- `id`
- `type`
  - `comment_to_dm`
  - `story_leads`
  - `follower_growth`
  - `follow_to_dm`
- `organization_id`
- `workspace_id`
- `social_account_id`
- `automation_id`
- `revision_id`
- `status`
- `config`
- `insight_config`
- `created_at`
- `updated_at`

### Why It Matters

Manychat does not present these as raw flows. It presents them as guided products with:

- focused setup
- integrated asset picking
- guardrails
- dedicated analytics

RelayAPI needs the same product layer if it wants real parity.

## Runtime Model

### Execution Rules

- Every run is pinned to a published `revision_id`.
- The runtime resolves the next edge by looking at the current node's output port.
- Delays create scheduled jobs.
- Inputs suspend the run until a reply or timeout event arrives.
- Buttons and quick replies resume through their mapped interactive ports.
- Pause controls are checked before any step is executed.

### Sticky State

Store in `automation_runs.context`:

- captured inputs
- merge tag values
- sticky randomizer decisions
- split-test assignments
- HTTP responses
- AI outputs
- handoff flags

### Publishing

Recommended publish flow:

1. validate draft revision
2. compute derived ports from node config
3. enforce graph integrity
4. freeze a published revision
5. point entrypoints, bindings, and experiences to that revision

## API Plan

The current API should be replaced with a clearer split.

### Core Automation APIs

- `GET /v1/automations`
- `POST /v1/automations`
- `GET /v1/automations/{id}`
- `PATCH /v1/automations/{id}`
- `DELETE /v1/automations/{id}`
- `GET /v1/automations/{id}/draft`
- `PUT /v1/automations/{id}/draft`
- `POST /v1/automations/{id}/publish`
- `POST /v1/automations/{id}/pause`
- `POST /v1/automations/{id}/resume`
- `GET /v1/automations/{id}/revisions`

### Catalog APIs

- `GET /v1/automations/catalog`
- `GET /v1/automations/catalog/nodes`
- `GET /v1/automations/catalog/entrypoints`
- `GET /v1/automations/catalog/bindings`
- `GET /v1/automations/catalog/actions`

### Entrypoint APIs

- `GET /v1/automations/{id}/entrypoints`
- `POST /v1/automations/{id}/entrypoints`
- `PATCH /v1/automation-entrypoints/{entrypointId}`
- `DELETE /v1/automation-entrypoints/{entrypointId}`

### Binding APIs

- `GET /v1/automation-bindings`
- `PUT /v1/automation-bindings/{bindingType}`
- `DELETE /v1/automation-bindings/{bindingType}`

### Rule APIs

- `GET /v1/automation-rules`
- `POST /v1/automation-rules`
- `PATCH /v1/automation-rules/{id}`
- `DELETE /v1/automation-rules/{id}`

### Quick Automation APIs

- `GET /v1/automation-experiences`
- `POST /v1/automation-experiences`
- `GET /v1/automation-experiences/{id}`
- `PATCH /v1/automation-experiences/{id}`
- `POST /v1/automation-experiences/{id}/publish`

### Asset Picker APIs

Required examples:

- `GET /v1/social-accounts/{id}/instagram/posts`
- `GET /v1/social-accounts/{id}/instagram/stories`
- `GET /v1/social-accounts/{id}/instagram/ads`
- `GET /v1/social-accounts/{id}/instagram/live-media`
- `GET /v1/social-accounts/{id}/ref-links`

### Test And Preview APIs

- `POST /v1/automations/{id}/test-sessions`
- `POST /v1/automation-test-sessions/{id}/send`
- `GET /v1/automation-test-sessions/{id}`
- `POST /v1/automations/{id}/simulate`

### Insights APIs

- `GET /v1/automations/{id}/insights`
- `GET /v1/automation-entrypoints/{id}/insights`
- `GET /v1/automation-bindings/{id}/insights`
- `GET /v1/automation-experiences/{id}/insights`
- `GET /v1/automation-runs/{id}`

### Contact Control APIs

- `POST /v1/contacts/{id}/automation-pause`
- `POST /v1/contacts/{id}/automation-resume`
- `GET /v1/contacts/{id}/automation-state`

## UI Plan

The current overall UI direction is usable. Preserve the shell and visual language. Replace the interaction model underneath.

### Builder Canvas

Must-have:

- source and target handles from `automation_ports`
- direct node connection
- reconnect existing edges
- drag from handle into empty canvas to open insert menu
- branch-specific handles on condition, randomizer, input, and message nodes
- multi-select
- duplicate
- copy/paste
- auto-arrange

### Insert Menu

This should be the Manychat-like action popover you called out.

Requirements:

- opens on drag-to-empty-space
- grouped by category
- searchable
- channel-aware
- creates node and edge in one gesture

### Message Composer

Must-have:

- block list with reorder
- inline preview
- button editor
- quick reply editor
- card/gallery editor
- channel warnings
- block-level settings

### Entrypoint Setup UI

Must-have:

- searchable trigger list
- asset pickers for posts, stories, ads, live, ref links
- config forms per trigger kind
- status and activation controls

### Basic Automation UI

Must-have:

- dedicated pages or tabs for:
  - default reply
  - welcome message
  - conversation starters
  - main menu
  - ice breakers

### Quick Automation UI

Must-have:

- guided setup
- launch checklist
- go-live/pause controls
- focused analytics

### Insights UI

Must-have:

- automation-level metrics
- node-level overlays
- trigger and binding filters
- run inspector
- test session transcript viewer

## Repo Impact

The implementation will materially touch:

- [packages/db/src/schema.ts](/Users/zank/Developer/majestico/relayapi/packages/db/src/schema.ts:1)
- [apps/api/src/schemas/automations.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/schemas/automations.ts:1)
- [apps/api/src/routes/automations.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/routes/automations.ts:1)
- `apps/api/src/routes/automation-bindings.ts` or equivalent new routes
- `apps/api/src/routes/automation-rules.ts` or equivalent new routes
- `apps/api/src/routes/automation-experiences.ts` or equivalent new routes
- `apps/api/src/services/automations/*`
- [packages/sdk/src/resources/automations.ts](/Users/zank/Developer/majestico/relayapi/packages/sdk/src/resources/automations.ts:1)
- [apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx](/Users/zank/Developer/majestico/relayapi/apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx:1)
- [apps/app/src/components/dashboard/automation/flow-builder/property-panel.tsx](/Users/zank/Developer/majestico/relayapi/apps/app/src/components/dashboard/automation/flow-builder/property-panel.tsx:1)
- [apps/app/src/components/dashboard/automation/flow-builder/trigger-panel.tsx](/Users/zank/Developer/majestico/relayapi/apps/app/src/components/dashboard/automation/flow-builder/trigger-panel.tsx:1)
- [apps/app/src/components/dashboard/pages/automation-detail-page.tsx](/Users/zank/Developer/majestico/relayapi/apps/app/src/components/dashboard/pages/automation-detail-page.tsx:1)

## Detailed Implementation Plan

### Phase 0: Freeze The Target Model

Deliverables:

- approve the compact node vocabulary
- approve the port model
- approve the entrypoint vs binding split
- approve the message-block schema
- approve the action-group schema

Decision output:

- one architecture doc
- one ERD
- one OpenAPI draft for the new resources

Exit criteria:

- no unresolved product-model questions

### Phase 1: Rewrite The Database Schema

Deliverables:

- replace current automation graph tables with:
  - `automations`
  - `automation_revisions`
  - `automation_nodes`
  - `automation_ports`
  - `automation_edges`
  - `automation_entrypoints`
  - `automation_bindings`
  - `automation_rules`
  - `automation_runs`
  - `automation_step_runs`
  - `automation_scheduled_jobs`
  - `automation_contact_controls`
  - `automation_test_sessions`
  - optional `automation_experiences`
- add indexes for:
  - revision graph lookups
  - active entrypoints
  - scheduled jobs
  - contact controls
  - insights reads

Exit criteria:

- the DB shape matches the target architecture exactly

### Phase 2: Rewrite Validation, Catalogs, And Runtime

Deliverables:

- new Zod schemas for all node kinds
- derived-port generation from node config
- graph validation rules
- revision publish validator
- runtime dispatcher by compact node kind
- input wait/resume logic
- interactive reply routing
- pause/resume enforcement

Exit criteria:

- one published revision can execute end to end on the new model

### Phase 3: Rewrite The Automation API And SDK

Deliverables:

- new draft endpoints
- new entrypoint endpoints
- new binding endpoints
- new rule endpoints
- new insights endpoints
- new test-session endpoints
- SDK update for every route/schema change

Exit criteria:

- the dashboard can use only the SDK and no legacy automation contracts remain

### Phase 4: Rewrite The Builder Interaction Model

Deliverables:

- handles rendered from `automation_ports`
- node connection enabled
- edge reconnect enabled
- drag-to-create insert menu
- branch-specific handles
- keyboard delete
- duplicate
- copy/paste
- multi-select

Exit criteria:

- the builder feels structurally closer to Manychat even before message-composer work is finished

### Phase 5: Build The Message Composer And Action Editor

Deliverables:

- block-based message composer
- button and quick reply branch editor
- action-group editor
- channel capability warnings
- preview panel

Exit criteria:

- users can build realistic Manychat-style conversational steps without touching raw JSON-like forms

### Phase 6: Build Entrypoint, Binding, And Quick Automation Surfaces

Deliverables:

- trigger asset pickers
- default reply UI
- welcome message UI
- main menu UI
- conversation starters UI
- ice breaker UI
- quick automation guided flows

Exit criteria:

- the product covers both raw flow building and the higher-level automation surfaces users actually expect

### Phase 7: Add Insights, Preview, And Inbox Controls

Deliverables:

- run inspector
- node overlays
- automation insights
- quick automation insights
- test sessions
- contact-level pause/resume from inbox

Exit criteria:

- operators can safely run and debug automations in production

## Recommended Build Order

If you truly want to implement this in one cohesive push, the critical path is:

1. approve target DB and API shape
2. rewrite schema and validation
3. rebuild runtime on revision + port model
4. update SDK
5. switch builder to port-driven graph editing
6. build message composer and action editor
7. build entrypoint/binding/experience surfaces
8. add insights and preview

Do not start with UI-only polish on the old graph tables. That would create throwaway work.

## What This Means For The Earlier Findings

Updated answer to "do we need to touch the DB?":

- yes, decisively

Updated answer to "are node connections and drag popovers only UI work?":

- on the current system, mostly yes
- on the correct target system, they should be rebuilt on top of explicit ports

Updated answer to "does our current schema cover everything?":

- no
- it covers the broad idea of graph automation
- it does not cover the right product architecture for Manychat parity

## Sources

### RelayAPI local sources

- [packages/db/src/schema.ts](/Users/zank/Developer/majestico/relayapi/packages/db/src/schema.ts:1)
- [apps/api/src/schemas/automations.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/schemas/automations.ts:1)
- [apps/api/src/routes/automations.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/routes/automations.ts:1)
- [apps/api/src/services/automations/manifest.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/services/automations/manifest.ts:1)
- [apps/api/src/services/automations/nodes/index.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/services/automations/nodes/index.ts:1)
- [apps/api/src/services/automations/nodes/platforms/instagram.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/services/automations/nodes/platforms/instagram.ts:1)
- [packages/sdk/src/resources/automations.ts](/Users/zank/Developer/majestico/relayapi/packages/sdk/src/resources/automations.ts:1)
- [apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx](/Users/zank/Developer/majestico/relayapi/apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx:1)
- [apps/app/src/components/dashboard/automation/flow-builder/property-panel.tsx](/Users/zank/Developer/majestico/relayapi/apps/app/src/components/dashboard/automation/flow-builder/property-panel.tsx:1)
- [apps/app/src/components/dashboard/automation/flow-builder/trigger-panel.tsx](/Users/zank/Developer/majestico/relayapi/apps/app/src/components/dashboard/automation/flow-builder/trigger-panel.tsx:1)
- [apps/app/src/components/dashboard/pages/automation-detail-page.tsx](/Users/zank/Developer/majestico/relayapi/apps/app/src/components/dashboard/pages/automation-detail-page.tsx:1)

### Manychat official sources

- https://help.manychat.com/hc/en-us/articles/14281166306332-How-to-build-a-Manychat-automation
- https://help.manychat.com/hc/en-us/articles/14281196200604-Content-Block-types
- https://help.manychat.com/hc/en-us/articles/14281157003292-Buttons
- https://help.manychat.com/hc/en-us/articles/14281157129116-Quick-Reply-Buttons
- https://help.manychat.com/hc/en-us/articles/18362925739932-Data-Collection-Block
- https://help.manychat.com/hc/en-us/articles/14281142518556-Condition-Block
- https://help.manychat.com/hc/en-us/articles/14281151100060-Randomizer
- https://help.manychat.com/hc/en-us/articles/14281197046812-Smart-Delay
- https://help.manychat.com/hc/en-us/articles/14281157602716-Start-another-automation
- https://help.manychat.com/hc/en-us/articles/14281187288860-Manychat-AI-Step
- https://help.manychat.com/hc/en-us/articles/17636378650268-Actions
- https://help.manychat.com/hc/en-us/articles/14281285374364-Dev-Tools-External-request
- https://help.manychat.com/hc/en-us/articles/19957883687708-How-to-pause-all-automations
- https://help.manychat.com/hc/en-us/articles/14281316989724-Instagram-Post-and-Reel-Comments-Trigger
- https://help.manychat.com/hc/en-us/articles/13556930006428-Instagram-Story-Reply-Trigger
- https://help.manychat.com/hc/en-us/articles/14281309502108-Instagram-Story-Mention-Reply-trigger
- https://help.manychat.com/hc/en-us/articles/14281211785884-How-to-use-Keywords-Trigger-in-Manychat
- https://help.manychat.com/hc/en-us/articles/14281321942428-Instagram-Ads-Trigger
- https://help.manychat.com/hc/en-us/articles/14281275933724-Instagram-Live-Comments-Trigger
- https://help.manychat.com/hc/en-us/articles/14281276006684-Instagram-Ref-URL-Trigger
- https://help.manychat.com/hc/en-us/articles/23431135317916-Share-to-DM-trigger
- https://help.manychat.com/hc/en-us/articles/23096654243740-Follow-to-DM-on-Instagram-Say-Hi-to-New-Followers-BETA
- https://help.manychat.com/hc/en-us/articles/14281159586588-Default-Reply-in-Manychat
- https://help.manychat.com/hc/en-us/articles/14281185974940-Welcome-Message-in-Manychat
- https://help.manychat.com/hc/en-us/articles/14281160467228-Conversation-Starters-for-Facebook-Messenger
- https://help.manychat.com/hc/en-us/articles/14281211388444-Main-Menu-on-Facebook-and-Instagram
- https://help.manychat.com/hc/en-us/articles/16654065283100-Quick-Automation-Auto-DM-links-from-comments
- https://help.manychat.com/hc/en-us/articles/17988327505180-Quick-Automation-Generate-leads-with-stories
- https://help.manychat.com/hc/en-us/articles/20310878273692-Quick-Automation-Grow-followers-from-comments
- https://help.manychat.com/hc/en-us/articles/15406423857052-Ice-Breakers-for-WhatsApp
- https://help.manychat.com/hc/en-us/articles/14281198254620-How-to-preview-automations-in-Manychat
