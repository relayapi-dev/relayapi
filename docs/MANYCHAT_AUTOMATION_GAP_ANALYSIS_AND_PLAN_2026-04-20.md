# Manychat Automation Gap Analysis And Plan

Date: 2026-04-20

## Scope

This document compares RelayAPI's current automation system against Manychat's current automation product, using:

- RelayAPI's local schema, API routes, runtime handlers, SDK surface, and dashboard builder
- Manychat's official Help Center documentation as of January-March 2026

The goal is not "copy Manychat blindly." The goal is to identify:

1. what Manychat can do today
2. what RelayAPI already covers
3. what is missing only in UI
4. what requires API or runtime work
5. what requires real schema extension

## Short Verdict

RelayAPI is already strong on workflow primitives:

- multi-trigger automations
- graph nodes and labeled edges
- versioned snapshots
- enrollments and run logs
- simulation
- a much broader aspirational cross-platform enum surface than Manychat

Manychat is still materially ahead on product completeness for social automation, especially:

- builder interaction model
- message authoring model
- interactive button/quick-reply branching
- trigger completeness for Instagram/Messenger growth use cases
- basic/channel-linked automations
- quick automation packaging
- analytics and in-channel testing

The two gaps you explicitly called out are real, and they are mostly UI problems:

- `Ability to connect nodes`: schema already supports this through `automation_edges`; API already supports it through graph replacement on `PATCH /v1/automations/{id}`; the missing piece is the builder interaction model.
- `Actions popover when dragging a new node`: schema and API are already sufficient; this is also mainly a builder UX task.

Those two can be shipped before any deeper schema rewrite.

## Current RelayAPI Baseline

### What exists today

From local code:

- `93` trigger enum values in schema/DB
- `118` node enum values in schema/DB
- `11` runtime-supported trigger types exposed in `/v1/automations/schema`
- `114` published node types exposed in `/v1/automations/schema`
- `4` stubbed node types: `ai_step`, `ai_agent`, `ai_intent_router`, `subflow_call`

Relevant local references:

- `packages/db/src/schema.ts`
- `apps/api/src/schemas/automations.ts`
- `apps/api/src/services/automations/manifest.ts`
- `apps/api/src/services/automations/nodes/index.ts`
- `apps/api/src/routes/automations.ts`
- `apps/app/src/components/dashboard/automation/flow-builder/*`

### RelayAPI strengths already in place

RelayAPI already has several core pieces Manychat-like systems need:

- graph persistence: `automations`, `automation_triggers`, `automation_nodes`, `automation_edges`
- versioning: `automation_versions`
- execution state: `automation_enrollments`, `automation_scheduled_ticks`
- per-node logs: `automation_run_logs`
- multi-trigger support
- dry-run simulation
- run history UI
- autosave + undo/redo in the editor

Important local references:

- `packages/db/src/schema.ts:2792-3055`
- `apps/api/src/routes/automations.ts:613-632`
- `apps/api/src/routes/automations.ts:1204-1336`
- `apps/api/src/routes/automations.ts:1338-1628`
- `apps/app/src/components/dashboard/pages/automation-detail-page.tsx:251-430`

### Important limitation in the current baseline

RelayAPI's schema surface is much larger than its runtime trigger surface.

- Runtime-exposed triggers are filtered through `PUBLISHED_AUTOMATION_TRIGGER_MANIFEST`
- Only triggers in `RUNTIME_SUPPORTED_TRIGGER_TYPES` reach the dashboard catalog today

Local references:

- `apps/api/src/services/automations/manifest.ts:328-341`
- `apps/api/src/services/automations/manifest.ts:95-129`
- `apps/api/src/routes/automations.ts:613-632`

This means breadth in enums should not be mistaken for feature completeness.

## What Manychat Has Today

## Builder and Product Surface

From Manychat's official docs, the current product includes:

- Flow Builder and Basic Builder
- auto-arrange
- zoom/pan tools
- direct node connection by dragging from connection dots
- multi-select, copy/paste, Alt-drag copy, duplicate step
- AI Flow Builder assistant
- preview inside Manychat and inside native messengers
- automation analytics and trigger-filtered step insights

Official references:

- https://help.manychat.com/hc/en-us/articles/14281166306332-How-to-build-a-Manychat-automation
- https://help.manychat.com/hc/en-us/articles/14281198254620-How-to-preview-automations-in-Manychat
- https://help.manychat.com/hc/en-us/articles/14281111044124-Automation-tab-Overview

## Content / Message Model

Manychat's message nodes are block-based, not one-message-type-per-node.

Content blocks include:

- Text
- Image
- Delay
- Data Collection
- File
- Audio
- Video
- Card
- Gallery
- Messenger List
- Dynamic block

Manychat also lets users:

- mix multiple content blocks inside one message node
- reorder those blocks visually
- add buttons to text, card, and gallery blocks
- add quick replies to text blocks

Official references:

- https://help.manychat.com/hc/en-us/articles/14281196200604-Content-Block-types
- https://help.manychat.com/hc/en-us/articles/14281157003292-Buttons
- https://help.manychat.com/hc/en-us/articles/14281157129116-Quick-Reply-Buttons

## Interactive Controls

Manychat buttons can drive more than just URLs. Officially documented button types include:

- AI Step
- Open website
- Call number
- Buy button
- Perform Actions
- Condition
- Randomizer
- Smart Delay
- Start another Automation
- Select Existing Step

Quick replies support:

- up to 11 options
- linking to steps/actions/conditions/randomizers/smart delays
- follow-up if the contact does not engage
- retry if the reply is not one of the quick replies

Official references:

- https://help.manychat.com/hc/en-us/articles/14281157003292-Buttons
- https://help.manychat.com/hc/en-us/articles/14281157129116-Quick-Reply-Buttons

## Logic / Flow Steps

Manychat documents the following core logic steps:

- Action block
- Condition block
- Randomizer
- Smart Delay
- Start another automation
- AI Step

Important details:

- Each Action node can include multiple tasks
- Randomizer supports up to 6 variations
- Randomizer supports "Random path every time" behavior
- Smart Delay supports duration and date-based modes
- Smart Delay supports dynamic date offsets and continue windows
- Start another automation is a first-class reusable-flow primitive

Official references:

- https://help.manychat.com/hc/en-us/articles/14281166306332-How-to-build-a-Manychat-automation
- https://help.manychat.com/hc/en-us/articles/14281142518556-Condition-Block
- https://help.manychat.com/hc/en-us/articles/14281151100060-Randomizer
- https://help.manychat.com/hc/en-us/articles/14281197046812-Smart-Delay
- https://help.manychat.com/hc/en-us/articles/14281157602716-Start-another-automation
- https://help.manychat.com/hc/en-us/articles/14281187288860-Manychat-AI-Step

## Action Coverage

Manychat's official Actions docs currently describe:

- Add / Remove Tag
- Set / Clear User Field
- Delete Contact
- Set Channel Opt-in / Opt-out
- Set Bot Field
- Subscribe to Sequence / Unsubscribe from Sequence
- Make External Request
- Change Menu in Messenger
- Log Conversion Event
- Mark conversation Open / Closed
- Assign conversation
- Notify assignees
- Send event to Meta Conversions API
- integration-specific actions
- Pause all automations

Official references:

- https://help.manychat.com/hc/en-us/articles/17636378650268-Actions
- https://help.manychat.com/hc/en-us/articles/14281285374364-Dev-Tools-External-request
- https://help.manychat.com/hc/en-us/articles/19957883687708-How-to-pause-all-automations
- https://help.manychat.com/hc/en-us/articles/14281211388444-Main-Menu-on-Facebook-and-Instagram

## Trigger Coverage

Manychat currently exposes more productized trigger families than RelayAPI's runtime:

- comments on posts/reels
- story replies
- story mentions
- direct messages / keywords / AI intent matching
- ads triggers
- live comments
- referral links
- share-to-DM
- follow-to-DM beta
- default reply
- welcome message
- conversation starters
- main menu / ice breaker entry points
- keyword tab
- rules/global triggers:
  - date/time
  - tag applied / removed
  - sequence subscribed / unsubscribed
  - custom field changed
  - system field changed
  - new contact
  - conversion event

Official references:

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
- https://help.manychat.com/hc/en-us/articles/14281170185628-How-to-set-custom-rules-with-Triggers-Conditions-and-Actions

## Quick Automations and Basic Automations

Manychat has product layers above the raw flow graph:

- Quick Automations for Instagram growth cases
- Basic channel-linked automations

Quick Automation examples documented today:

- Auto-DM links from comments
- Generate leads with stories
- Grow followers from comments
- Follow to DM

Basic automations documented today:

- Default Reply
- Welcome Message
- Conversation Starters
- Main Menu
- Story Mention Reply
- WhatsApp Ice Breakers

Official references:

- https://help.manychat.com/hc/en-us/articles/16654065283100-Quick-Automation-Auto-DM-links-from-comments
- https://help.manychat.com/hc/en-us/articles/17988327505180-Quick-Automation-Generate-leads-with-stories
- https://help.manychat.com/hc/en-us/articles/20310878273692-Quick-Automation-Grow-followers-from-comments
- https://help.manychat.com/hc/en-us/articles/23096654243740-Follow-to-DM-on-Instagram-Say-Hi-to-New-Followers-BETA
- https://help.manychat.com/hc/en-us/articles/14281111044124-Automation-tab-Overview
- https://help.manychat.com/hc/en-us/articles/15406423857052-Ice-Breakers-for-WhatsApp

## Testing and Analytics

Manychat documents:

- in-product preview
- preview inside native messengers
- step insights
- trigger-filtered analytics
- metrics such as runs, sends, delivered, read, clicked, CTR, collected emails
- step stats on Smart Delay and automation performance screens

Official references:

- https://help.manychat.com/hc/en-us/articles/14281198254620-How-to-preview-automations-in-Manychat
- https://help.manychat.com/hc/en-us/articles/16654065283100-Quick-Automation-Auto-DM-links-from-comments
- https://help.manychat.com/hc/en-us/articles/17988327505180-Quick-Automation-Generate-leads-with-stories
- https://help.manychat.com/hc/en-us/articles/14281166306332-How-to-build-a-Manychat-automation

## Gap Matrix

| Area | Manychat today | RelayAPI today | Verdict | What must change |
|---|---|---|---|---|
| Graph wiring | Drag from connection dots to another step | Graph model exists, but `nodesConnectable={false}` and the builder inserts steps through popovers instead of arbitrary connections | Partial | UI only |
| Branch authoring | Conditions and random paths are visibly branchable | Labeled edges exist, but branch creation is not first-class in the canvas | Partial | UI only |
| Action popover while dragging | Core builder affordance | Edge/footer popovers exist, but not drag-to-create | Partial | UI only |
| Message node model | One message node can contain multiple ordered content blocks | Nodes are atomic, one payload shape per node | Missing | Schema + runtime + UI |
| Buttons / quick replies | Buttons can route to actions, conditions, delays, automations, existing steps; quick replies have no-response and retry behaviors | Button specs are only `postback` / `web_url`; quick replies/buttons send platform payloads but node outputs remain `next` only | Missing | Schema + runtime + UI |
| Data collection | Rich reply types, validation, no-response behavior, skip text, retries, actions on success | `user_input_*` exists for text/email/phone/number/date/choice/file with timeout and retry prompt | Partial | Schema + runtime + UI |
| Smart Delay | Duration, specific date, dynamic date, offsets, continue windows, contact timezone behavior | Only `duration_minutes` and optional `quiet_hours` | Partial | Schema + runtime + UI |
| Start another automation | First-class reusable automation call | `subflow_call` exists in schema but is stubbed out | Missing | Runtime + UI, minor API/schema confirmation |
| AI step | Live AI step and AI flow-builder assistant | AI nodes exist but are stubbed; no AI builder assistant | Missing | Runtime + UI + API |
| Multi-task action node | One action block can execute multiple actions | RelayAPI models one action per node; chaining can approximate behavior but not the editing model | Partial | UI first, optional schema bundle later |
| Action catalog | Contact deletion, channel opt-in/out, bot fields, menu change, conversion events, pause automations, integrations | Tag/field/subscription/segment/http/conversation/notify/webhook actions exist | Partial | Schema + runtime + API + UI |
| Trigger completeness | Story reply, story mention, comments, live, ads, ref URL, share-to-DM, follow-to-DM, basic automations, rules triggers | Enums exist for many triggers, but runtime-supported trigger catalog is only 11 types | Partial | Runtime + API + UI |
| Trigger config richness | Post pickers, next-post, include/exclude keywords, delay/react options, intent recognition, asset pickers | Minimal generic schemas for supported triggers; no asset pickers or advanced config surfaces | Partial | API + UI + some schema |
| Basic automations | Default reply, welcome, conversation starters, main menu, story mention reply, ice breakers | No channel-linked automation binding layer | Missing | Schema + API + UI |
| Quick automations | Dedicated guided setup and insights | Templates exist, but no comparable product layer; `follow-to-dm` is manual and story reply template is unavailable | Partial | API + UI + runtime |
| Preview / live test | Preview in product and native messenger | Dry-run simulator + manual enroll only | Partial | API + UI |
| Analytics | Runs, sends, delivered, read, clicked, CTR, collected emails, per-step insights | Only high-level automation totals plus enrollment/run logs | Partial | Data model + API + UI |
| Contact-level automation pause | Pause all automations per contact, resume from inbox | No per-contact pause state | Missing | Schema + runtime + API + inbox UI |
| Builder power tools | Auto-arrange, duplicate step, copy/paste, multi-select | Undo/redo exists; the rest are absent or minimal | Partial | UI only |

## Direct Answers To The Key Questions

### 1. Does the current schema cover "connect nodes"?

Yes.

The current graph schema already covers arbitrary node connection:

- `automation_edges` stores `from_node_id`, `to_node_id`, `label`, and `order`
- the dashboard already reads and writes edges
- `PATCH /v1/automations/{id}` already accepts replacement `edges`

Local references:

- `packages/db/src/schema.ts:2895-2924`
- `apps/api/src/schemas/automations.ts`
- `apps/app/src/components/dashboard/pages/automation-detail-page.tsx:251-301`

Verdict:

- no database change required
- no new API route required
- this is primarily a ReactFlow builder implementation task

### 2. Does the current schema cover the "actions popover when dragging a new node"?

Yes.

The step catalog already comes from `/v1/automations/schema`, and the canvas already has insertion menus on:

- edge overlays
- node footers
- trigger footer

Local references:

- `apps/api/src/routes/automations.ts:613-632`
- `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx:551-664`
- `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx:1020-1051`

Verdict:

- no schema change required
- no API change required
- implement as a canvas UX layer on top of existing schema

### 3. Does the current schema cover Manychat's message/content model?

No.

This is the biggest schema mismatch.

Manychat's message nodes are composite containers of ordered content blocks. RelayAPI's current node model is atomic. That means:

- no native multi-block message composer
- no true card/gallery/message-bundle semantics
- no inline block ordering model
- no true "first private reply block must be one content block" policy model

Local references:

- RelayAPI atomic node model:
  - `apps/api/src/schemas/automations.ts:521-527`
  - `apps/api/src/schemas/automations.ts:834-905`
  - `apps/api/src/schemas/automations.ts:816-832`
- Manychat composite message model:
  - https://help.manychat.com/hc/en-us/articles/14281196200604-Content-Block-types

Verdict:

- real schema extension is required for full Manychat parity

### 4. Does the current schema cover Manychat's interactive button and quick reply behavior?

No.

RelayAPI can send quick replies and buttons, but today they are outbound payloads, not first-class branch sources.

Important local evidence:

- output labels default to `next` for platform send nodes:
  - `apps/api/src/services/automations/manifest.ts:282-289`
- Instagram quick replies/buttons only send payloads:
  - `apps/api/src/services/automations/nodes/platforms/instagram.ts:204-265`

This means the current model does not yet capture:

- per-button next-step routing
- quick reply branch routing
- follow-up if no click
- retry if reply is not one of the options
- "select existing step" semantics from buttons

Verdict:

- this needs schema, runtime, and UI work

### 5. Does the current schema cover Manychat's trigger breadth?

Only partially.

The enum surface is broad, but runtime support is narrow.

This is the wrong kind of parity: declared breadth without working enrollment behavior.

Important local evidence:

- trigger enum list:
  - `packages/db/src/schema.ts:2492-2604`
- runtime config schemas only for a small set:
  - `apps/api/src/services/automations/manifest.ts:95-129`
- published trigger catalog filtered to runtime-supported entries:
  - `apps/api/src/services/automations/manifest.ts:328-341`

Verdict:

- trigger schema is not the main blocker
- runtime support, config schema completeness, and asset/config APIs are the main blockers

## Schema Coverage Assessment

## Covered Well Enough Already

These do not require schema changes for the first parity pass:

- graph edges and arbitrary node linking
- multi-trigger automations
- labeled branches
- versioned snapshots
- enrollments and run logs
- autosave and undo/redo workflow
- basic condition node structure
- basic tag/field/subscription/segment/inbox/http/webhook actions

## Partially Covered But Need Extension

These have a useful starting point, but not enough for Manychat parity:

- triggers: enum breadth exists, runtime support does not
- user input/data collection: foundation exists, missing reply types and no-response/skip semantics
- smart delay: duration exists, date-based and dynamic date modes do not
- randomization: weighted branches exist, sticky-vs-rerandomize behavior does not
- action catalog: partial but missing many productized tasks
- split testing: exists, but no real analytics loop

## Needs Real Schema Change

These are not just UI issues:

### Composite message / content-block node

Add a message container abstraction, likely something like:

- `platform_message`
- `blocks[]`
- block types such as `text`, `image`, `file`, `audio`, `video`, `card`, `gallery`, `delay`, `data_collection`, `dynamic`

### Interactive response routing

Add first-class interactive branch modeling, either via:

- nested button/quick-reply actions that reference next steps
- or response outputs on message nodes

The current payload-only button model is not sufficient.

### Richer trigger config schemas

Need structured config for:

- specific post / all posts / next post
- include / exclude keywords
- delay/reaction options
- asset identifiers for stories, posts, ads, ref links, menus
- follow-to-DM/share-to-DM capabilities where supported

### Smart delay modes

Need support for:

- fixed duration
- specific date
- dynamic date from field
- offset before/after field date
- day/time continue windows

### Expanded user-input types

Need support for:

- URL
- location
- image
- datetime
- first name / last name or system-field-targeted save modes
- skip behavior
- no-response behavior

### Channel-linked automation bindings

Need a product layer to bind automations to:

- default reply
- welcome message
- conversation starters
- main menu
- ice breakers
- story mention reply / similar channel-native entry points

This is not just another trigger row.

### Contact-level automation pauses

If RelayAPI wants Manychat-style manual takeover parity, it needs a per-contact or per-conversation pause state model.

### Optional later schema extension: action bundles

Manychat's "one action node with multiple tasks" can be approximated by chaining nodes. This does not need to be phase 1 schema work.

If you want strict parity and cleaner editing, add an action-bundle node later.

## What Is Missing From The API

Current API surface is useful but narrow. It is effectively:

- CRUD for automations
- publish/pause/resume/archive
- schema catalog
- simulate
- manual enroll
- enrollment list, sample list, run log list

Local reference:

- `packages/sdk/src/resources/automations.ts`

For Manychat parity, the missing API categories are:

### 1. Trigger-asset and trigger-config APIs

Needed for pickers and trigger setup such as:

- list Instagram posts/reels/stories eligible for a trigger
- select next post / live post / ad flow / ref link asset
- generate and manage referral links
- expose supported trigger constraints per channel
- expose first-private-reply restrictions and opt-in rules

### 2. Basic automation binding APIs

Needed to manage:

- default reply automation for a channel/account
- welcome message automation
- conversation starters and linked automations
- main menu items and linked automations
- WhatsApp ice breakers

### 3. Rules APIs

Needed to match Manychat's global rules layer:

- rule CRUD
- rule trigger catalog
- rule condition catalog
- rule action catalog
- rule activation/deactivation

### 4. Quick automation APIs

Needed to support dedicated guided products such as:

- comment-to-DM setup flows
- story lead flows
- follower-growth flows
- follow-to-DM setup
- guided update / stop / insights flows

RelayAPI templates are a starting point, but they are not yet a full quick-automation product.

### 5. Analytics and insights APIs

Needed for Manychat-style performance screens:

- automation-level insights
- per-trigger insights
- per-node insights
- delivery/read/click aggregates where supported
- quick automation specific metrics like collected emails and CTR

### 6. Live preview and live test APIs

Needed for:

- preview in native messenger
- test individual steps
- test external requests with sample contacts
- test trigger payload matching against a real asset

### 7. Contact-level automation pause/resume APIs

Needed for:

- pause automations for one contact/conversation
- resume early from inbox
- inspect why automations are paused

### 8. Optional API improvement: partial graph mutation endpoints

Not required for parity, but helpful later:

- add node
- connect nodes
- reconnect edge
- duplicate subtree
- auto-layout

These are optional because the current full-graph patch model is enough for the first UI pass.

## What Is Missing In The UI

## Immediate UI gaps

These are the most visible gaps against Manychat:

### 1. Direct node connection

Current state:

- handles are rendered
- connections are visually present
- but ReactFlow node connection is disabled

Local reference:

- `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx:1263-1289`

Needed:

- source handles per output
- target handles per node
- drag-to-connect
- reconnect edge
- connection validation

### 2. Add-step action popover during drag

Current state:

- edge hover popover exists
- footer/ghost add-step exists
- but not the Manychat-style drag-to-create interaction

Local references:

- `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx:551-664`
- `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx:1020-1051`

Needed:

- drag from a source handle into empty canvas
- show categorized insert menu near cursor
- create node and connect in one gesture

### 3. Explicit branch handles

Current state:

- multi-output nodes only show output labels as pills
- branches are not directly connectable from each output

Local references:

- `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx:862-891`
- `apps/api/src/services/automations/manifest.ts:282-289`

Needed:

- `yes` and `no` output ports on condition nodes
- branch ports on randomizer and split test
- `captured`, `no_match`, `timeout` output ports on user input nodes

### 4. Rich message composer

Current state:

- message editing is property-panel driven
- arrays and structured fields are generic forms
- no true Manychat-style message block editor

Local references:

- `apps/app/src/components/dashboard/automation/flow-builder/property-panel.tsx:387-500`

Needed:

- inline message preview
- add/reorder content blocks
- dedicated quick reply/button editor
- dedicated card/gallery editor
- channel capability warnings

### 5. Trigger picker richness

Current state:

- trigger picker is simple and clean
- but it lacks the Manychat-style asset-driven setup

Local references:

- `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx:206-314`
- `apps/app/src/components/dashboard/automation/flow-builder/trigger-panel.tsx:223-445`

Needed:

- searchable categorized trigger picker
- asset pickers for posts/stories/ads
- trigger-specific guardrails and preview
- direct activation toggle / status affordances

### 6. Builder power tools

Missing compared to Manychat:

- duplicate step
- copy/paste
- multi-select
- alt-drag copy
- auto-arrange

### 7. Analytics overlays

Missing compared to Manychat:

- per-step stats on the canvas
- automation insights panel
- trigger-filtered performance
- quick automation metrics UI

### 8. Live preview

Current simulator is useful for graph traversal, but it is not Manychat-style preview.

Missing:

- preview in native channel
- side-by-side live message preview with real interaction constraints

## What RelayAPI Already Does Better Or Differently

This comparison should stay fair.

RelayAPI already has some advantages:

- API-first automation resource surface
- versioned immutable snapshots
- run-log retrieval at the API layer
- simulation endpoint
- much broader platform ambition
- first-class database-backed graph objects

Manychat is more polished and more complete for social automation productization, but RelayAPI is not starting from zero.

This matters because it changes the plan:

- do not rewrite the graph model first
- exploit the existing graph model
- fix the product layer and runtime completeness around it

## Recommended Plan

## Phase 1: Ship The Two Biggest UI Wins First

Goal:

- close the most obvious builder gap quickly
- do not touch the database
- do not redesign the API

Deliverables:

1. Enable node-to-node connections in the canvas
2. Add per-output source handles
3. Add drag-to-create step menu when the user drags into empty space
4. Add edge reconnect and delete
5. Keep current `PATCH` full-graph save model

Why first:

- this addresses the most visible gap immediately
- local schema and API are already good enough
- this will make the builder feel substantially closer to Manychat without deep backend work

## Phase 2: Fix The Message Model

Goal:

- move from atomic message nodes to a real conversational message composer

Deliverables:

1. Define a composite message-step schema
2. Support ordered content blocks inside a message
3. Support block-level buttons and quick replies
4. Add dedicated message-composer UI
5. Encode channel capability rules in the schema catalog

Recommendation:

- do not try to fake Manychat's message model with chains of atomic nodes
- create a proper message container abstraction

## Phase 3: Make Interactive Controls First-Class

Goal:

- make buttons and quick replies actually drive automation structure

Deliverables:

1. Add per-button and per-quick-reply routing semantics
2. Add no-response follow-up behavior
3. Add retry-if-invalid-option behavior
4. Add "select existing step" semantics
5. Add trigger/runtime support for postbacks and reply payloads

Why this matters:

- Manychat's conversational UX depends heavily on interactive elements branching the flow
- without this, RelayAPI can send interactive controls but cannot model Manychat-like journeys

## Phase 4: Expand Trigger Runtime Coverage

Goal:

- turn enum breadth into working product breadth

Priority trigger families:

1. Instagram story reply
2. Instagram story mention
3. Instagram live comments
4. Instagram referral link
5. Instagram postback / quick reply click semantics
6. Facebook postback and opt-in
7. Scheduled and rules-style triggers
8. Share-to-DM / follow-to-DM only if platform access is truly available

Deliverables:

- working enrollment support
- complete trigger config schemas
- asset/config APIs
- dashboard trigger setup flows

## Phase 5: Close The Action Catalog Gap

Goal:

- cover the actions Manychat users expect in social automation

Priority actions:

1. Delete contact
2. Channel opt-in / opt-out
3. Bot/global field set/clear
4. Menu change
5. Conversion event / CAPI actions
6. Pause automations for a contact
7. Contact-level resume
8. optional integration action wrappers

Recommendation:

- keep one-action-per-node for phase 1 if it speeds delivery
- introduce action bundles only if users strongly need a Manychat-style action node

## Phase 6: Add Basic Automations And Rules

Goal:

- support the Manychat product layers above the flow graph

Deliverables:

1. Channel-linked automation bindings
2. Basic automation settings UI
3. Rules resource and execution model
4. Inbox/manual takeover pause state

This is the phase where RelayAPI stops being just a graph builder and starts becoming a complete social automation product.

## Phase 7: Add Quick Automations

Goal:

- package common flows into guided products instead of raw templates

Recommended quick automation set:

1. Comment to DM
2. Story leads
3. Grow followers from comments
4. Follow to DM

Deliverables:

- guided setup screens
- insights pages
- stop/go-live flows
- upgrade/fallback logic where a channel feature is limited

## Phase 8: Analytics, Testing, And AI

Goal:

- match Manychat's operational maturity

Deliverables:

1. automation insights endpoints
2. per-step statistics
3. native-channel preview/test flows
4. richer run inspector
5. AI step runtime
6. AI flow-builder assistant
7. subflow call / start automation runtime

## Recommended Priority Order

If the goal is fastest visible improvement with the best payoff:

1. Canvas wiring and drag-to-create
2. Per-output handles and branch authoring
3. Message model redesign
4. Interactive button/quick-reply routing
5. Trigger runtime expansion for Instagram-first use cases
6. Quick automation product layer
7. Basic automations and rules
8. Analytics and live preview
9. AI and subflows

## Final Assessment

If the benchmark is "Can RelayAPI already represent automation graphs?" then the answer is yes.

If the benchmark is "Can RelayAPI already match Manychat's current automation product?" the answer is no.

The biggest reason is not lack of edges or lack of nodes in the database. The biggest reason is that Manychat's product is built around:

- channel-native trigger completeness
- composite message authoring
- interactive response branching
- guided quick-automation setup
- channel-linked basic automations
- analytics and testing surfaces

RelayAPI's immediate path forward should be:

1. treat node connection and drag-to-create as UI-only fast wins
2. avoid rewriting the existing graph schema unnecessarily
3. invest next in the message model and interactive-control semantics
4. then expand trigger runtime coverage and product wrappers

That sequence gives the best leverage.

## Sources

### RelayAPI local sources

- `packages/db/src/schema.ts`
- `apps/api/src/schemas/automations.ts`
- `apps/api/src/routes/automations.ts`
- `apps/api/src/services/automations/manifest.ts`
- `apps/api/src/services/automations/nodes/index.ts`
- `apps/api/src/services/automations/nodes/platforms/instagram.ts`
- `apps/api/src/services/automations/nodes/randomizer.ts`
- `apps/api/src/services/automations/nodes/split-test.ts`
- `apps/api/src/services/automations/template-builders.ts`
- `packages/sdk/src/resources/automations.ts`
- `apps/app/src/components/dashboard/pages/automation-detail-page.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/property-panel.tsx`
- `apps/app/src/components/dashboard/automation/flow-builder/trigger-panel.tsx`

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
- https://help.manychat.com/hc/en-us/articles/14281170185628-How-to-set-custom-rules-with-Triggers-Conditions-and-Actions
- https://help.manychat.com/hc/en-us/articles/16654065283100-Quick-Automation-Auto-DM-links-from-comments
- https://help.manychat.com/hc/en-us/articles/17988327505180-Quick-Automation-Generate-leads-with-stories
- https://help.manychat.com/hc/en-us/articles/14281160467228-Conversation-Starters-for-Facebook-Messenger
- https://help.manychat.com/hc/en-us/articles/14281211388444-Main-Menu-on-Facebook-and-Instagram
- https://help.manychat.com/hc/en-us/articles/14281198254620-How-to-preview-automations-in-Manychat
- https://help.manychat.com/hc/en-us/articles/14281111044124-Automation-tab-Overview
