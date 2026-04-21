# Manychat-Parity Automation Rebuild — Design Specification

**Date:** 2026-04-21
**Status:** Design approved. Supersedes `docs/MANYCHAT_AUTOMATION_GAP_ANALYSIS_AND_PLAN_2026-04-20.md` and all prior audit documents.
**Scope:** Full greenfield rebuild of the automation system. Pre-launch platform, one big PR, no migration scripts.

---

## 1. Executive Summary

RelayAPI will ship a Manychat-equivalent automation system for five channels (Instagram, Facebook Messenger, WhatsApp, Telegram, TikTok DM). The rebuild replaces 13 legacy automation tables and seven enums with seven purpose-built tables, collapses a ~90-value node-type enum into a compact 10-kind vocabulary, introduces port-based edge routing as the graph's routing primitive, and rewrites the runtime, API, SDK, builder canvas, message composer, and action editor in a single cohesive push.

The system is designed around three principles:

1. **Graph structure is explicit.** Nodes have typed ports; edges connect `(node_key, port_key)` pairs. No label-based fallbacks, no implicit wiring.
2. **Messages are composite documents.** One `message` node hosts ordered blocks (text, image, video, card, gallery, delay) plus buttons and quick replies — replacing the sprawl of per-send-kind node types.
3. **Actions are grouped.** One `action_group` node hosts ordered side-effect actions with per-action error handling — replacing the chain-of-atomic-nodes pattern.

Existing subsystems to preserve: the trigger-matching algorithm, webhook signature verification, inbox-event-processor pipeline, merge-tag resolver, filter evaluator, and most of the flow-builder shell (canvas rendering, selection, auto-arrange).

Existing subsystems to rewrite: the runner, scheduler, simulator, node handlers, schemas, API routes, SDK automations resource, builder port model, property panel output-label logic.

Existing surfaces to drop entirely: all AI node kinds (archived for potential v2 reuse), the sequences/comment-automations/engagement-rules concepts (already obsolete), and the legacy `automation_experiences` concept collapsed into templates.

---

## 2. Locked Product & Architecture Decisions

This table captures every explicit decision made during design. All subsequent sections assume these.

| # | Decision |
|---|---|
| A1 | Channels: Instagram, Facebook Messenger, WhatsApp, Telegram, TikTok DM (5) |
| A2 | Broadcasts stay separate, untouched by this rebuild |
| A3 | Dev tools in v1: `http_request` node + `webhook_out` action. No code step, no custom apps |
| A4 | No AI nodes in v1. Archive existing `ai-runtime`, `ai-agent`, `ai-step`, `ai-intent-router` modules |
| A5 | All 4 quick-automation templates: `comment_to_dm`, `story_leads`, `follower_growth`, `follow_to_dm` |
| A6 | All 5 basic automations stored; `default_reply` + `welcome_message` wired live in v1; `conversation_starters` / `main_menu` / `ice_breakers` stubbed in v1, platform sync in v1.1 |
| B1 | No revisions. Single live graph per automation. No history, no rollback |
| B2 | Edits are instantly live (no draft/published split). In-flight runs continue on the current graph; if their current node disappears, exit with `exit_reason = "graph_changed"` |
| B3 | In-flight runs affected by edits exit cleanly with `graph_changed` reason |
| B4 | Contact pause: per-automation + global per-contact. `automation_contact_controls.automation_id` is nullable — `NULL` = global pause |
| B5 | Trigger conflict resolution: highest-priority entrypoint wins. Sort: `(specificity DESC, priority ASC, created_at ASC)`. Default `priority = 100`. Specificity is auto-derived by kind |
| B6 | Per-entrypoint reentry: `allow_reentry` (default `true`), `reentry_cooldown_min` (default `60`). Cooldown clock starts at prior run completion. Active runs always block reentry |
| B7 | `action_group` per-action `on_error: "abort" \| "continue"` (default `"abort"`). `error` port fires if any abort-marked action fails |
| B8 | `automation_step_runs` forever, monthly partitions on `executed_at`, explicit indexes. No TTL, no rollups in v1 |
| B9 | Real-time insights aggregation from `step_runs`. No rollups in v1. Lazy cache added only if a specific query proves slow |
| C1 | Pre-launch — drop all current automation tables cleanly, no migration script |
| C2 | Just nuke in-flight enrollments at cutover |
| C3 | SDK rewritten in place; release-please handles versioning automatically |
| C4 | One big PR on a long-lived greenfield branch |
| D1 | One monolithic design doc (this file) + one implementation plan |
| Storage | Single `graph` JSONB column on `automations`. No normalized node/port/edge rows. Atomic reads/writes at the row level |
| Experiences | Collapsed into templates. `automation_experiences` table dropped. Template kind stored as `automations.created_from_template` + `template_config` (JSONB, nullable) |
| Product IA | Automations is a top-level sidebar item pointing directly to the flows list. Bindings are managed as tabs inside the per-account detail page (reusing the existing accounts section) |

---

## 3. System Overview

```
┌─ Platform webhook (IG, FB, WhatsApp, Telegram, TikTok DM)
│
├─→ inbox-event-processor (preserved)
│       │
│       ├─→ INBOX_QUEUE       → inbox rendering (separate system)
│       │
│       └─→ AUTOMATION_QUEUE
│              │
│              ▼
│        ┌──────────────────────┐
│        │ Trigger Matcher      │  preserved logic:
│        │                      │   keyword matching, filter eval,
│        │                      │   account-scoped, reentry check
│        └──────────────────────┘
│              │
│              ▼
│        ┌──────────────────────┐
│        │ Runner               │  reads automations.graph JSONB
│        │  - port-based traversal
│        │  - action_group exec
│        │  - input wait/resume
│        │  - contact pause check
│        │  - writes step_runs
│        └──────────────────────┘
│              │
│              ├─→ node handler dispatch
│              │        │
│              │        └─→ platform send adapter
│              │
│              └─→ scheduler (delay nodes, input timeouts,
│                              scheduled-trigger firings)
```

Core storage (7 tables, detailed in Section 4):

- `automations` — one row per flow with `graph` JSONB column
- `automation_entrypoints` — flow entry triggers (keyword, DM, comment, webhook, …)
- `automation_bindings` — channel-surface attachments (default_reply, welcome, …)
- `automation_runs` — in-flight + completed runs
- `automation_step_runs` — per-node execution log, monthly partitions
- `automation_scheduled_jobs` — delayed resumptions, input timeouts, scheduled triggers
- `automation_contact_controls` — per-contact pause state (per-automation or global)

Preserved subsystems: trigger-matcher algorithm, webhook signature verification, inbox-event-processor, merge-tag resolver, filter evaluator, media upload/picker wiring, existing UI shell components (flows list, flow detail shell, property panel schema-driven form renderer, trigger panel dual-mode pattern, template picker dialog pattern, inbox chat-thread pause/resume).

Replaced subsystems: graph schema, node vocabulary, runner, scheduler, simulator, all node handlers, API routes, SDK automations resource, builder canvas port model, property panel output-label logic.

Dropped: 13 automation tables, 7 automation enums, all AI nodes and modules, sequences/comment-automations/engagement-rules concepts, the `automation_experiences` table concept.

---

## 4. Database Schema

### 4.1 Tables dropped at cutover

13 tables: `automations` (old), `automation_triggers`, `automation_nodes`, `automation_edges`, `automation_versions`, `automation_bindings` (old), `automation_enrollments`, `automation_contact_controls` (old), `automation_run_logs`, `automation_scheduled_ticks`.

7 enums, including the ~90-value `automation_node_type` and ~70-value `automation_trigger_type`.

### 4.2 New tables

Seven tables total.

| # | Table | Purpose |
|---|---|---|
| 1 | `automations` | One row per flow. Holds the entire graph in a `graph` JSONB column. |
| 2 | `automation_entrypoints` | Flow entry triggers — keyword, DM, comment, story, schedule, webhook, etc. |
| 3 | `automation_bindings` | Channel-surface attachments — default_reply, welcome_message, conversation_starter, main_menu, ice_breaker. |
| 4 | `automation_runs` | One row per in-flight or completed run. |
| 5 | `automation_step_runs` | One row per node execution. Partitioned monthly on `executed_at`. |
| 6 | `automation_scheduled_jobs` | Delayed resumptions, input timeouts, scheduled-trigger firings. |
| 7 | `automation_contact_controls` | Per-contact pause state (per-automation via `automation_id`, global when `automation_id IS NULL`). |

### 4.3 Enum policy

**Small and stable → Postgres enum (4 new enums):**

- `automation_status` — `draft` / `active` / `paused` / `archived`
- `automation_channel` — `instagram` / `facebook` / `whatsapp` / `telegram` / `tiktok`
- `automation_binding_type` — `default_reply` / `welcome_message` / `conversation_starter` / `main_menu` / `ice_breaker`
- `automation_run_status` — `active` / `waiting` / `completed` / `exited` / `failed`

**Open to evolution → text column with app-level validation (no enum):**

Node `kind`, port `key`, entrypoint `kind`, template kind, step-run `outcome`, run `exit_reason`, action `type`, pause `reason`. The previous ~90-value `automation_node_type` enum becomes a free text column — adding a node kind no longer requires a migration.

### 4.4 Table shapes (condensed)

#### `automations`

```
id                        text PK (prefix auto_)
organization_id           FK
workspace_id              FK nullable
name                      text
description               text nullable
channel                   automation_channel
status                    automation_status
graph                     jsonb                      -- full graph (Section 5)
created_from_template     text nullable              -- e.g. "comment_to_dm"
template_config           jsonb nullable             -- original wizard input
total_enrolled            int  default 0             -- counters (atomic ++)
total_completed           int  default 0
total_exited              int  default 0
total_failed              int  default 0
last_validated_at         timestamp nullable
validation_errors         jsonb nullable             -- non-null → auto-paused
created_by                FK user
created_at                timestamp
updated_at                timestamp
```

Indexes:

- `(organization_id, status)`
- `(organization_id, workspace_id)`
- GIN on `graph` (admin queries: "find automations using node kind X")
- Partial index on `(created_from_template)` where non-null

#### `automation_entrypoints`

```
id                        text PK (prefix aep_)
automation_id             FK
channel                   automation_channel         -- must match parent automation.channel
kind                      text                       -- dm_received, keyword, comment_created, …
status                    text                       -- active / paused
social_account_id         FK nullable                -- null = all accounts for channel
config                    jsonb                      -- kind-specific (keywords, post_ids, webhook_slug, …)
filters                   jsonb nullable             -- segment/tag/field predicates
allow_reentry             boolean default true
reentry_cooldown_min      int     default 60
priority                  int     default 100
specificity               int                        -- auto-derived (keyword 30, …, catch-all 0)
created_at                timestamp
updated_at                timestamp
```

Indexes:

- `(automation_id)`
- `(channel, kind, status)` — webhook match
- `(social_account_id, kind, status)` — account-scoped match

#### `automation_bindings`

```
id                        text PK (prefix abnd_)
organization_id           FK
workspace_id              FK nullable
social_account_id         FK
channel                   automation_channel
binding_type              automation_binding_type
automation_id             FK
config                    jsonb                      -- menu structure, starter labels, ice-breaker list
status                    text                       -- active / paused / pending_sync / sync_failed
last_synced_at            timestamp nullable
sync_error                text nullable
created_at                timestamp
updated_at                timestamp
```

Constraints:

- **Unique** `(social_account_id, binding_type)` — one binding per channel surface per account

Indexes:

- `(social_account_id, binding_type, status)` — runtime lookup
- `(automation_id)` — reverse lookup

#### `automation_runs`

```
id                        text PK (prefix arun_)
automation_id             FK
organization_id           FK
entrypoint_id             FK nullable
binding_id                FK nullable
contact_id                FK
conversation_id           FK nullable
status                    automation_run_status
current_node_key          text nullable
current_port_key          text nullable
context                   jsonb                      -- captured inputs, merge tags, sticky randomizer, HTTP responses, button payloads
waiting_until             timestamp nullable
waiting_for               text nullable              -- input / delay / external_event
exit_reason               text nullable
started_at                timestamp
completed_at              timestamp nullable
updated_at                timestamp
```

Indexes:

- `(automation_id, status)`
- `(contact_id, automation_id)` — reentry check
- `(status, waiting_until)` — scheduler sweep
- `(organization_id, started_at DESC)` — run history
- **Partial unique** `(contact_id, automation_id)` WHERE `status IN ('active', 'waiting')` — enforces at most one active run per (contact, automation)

#### `automation_step_runs`

```
id                        bigint PK (autoincrement)
run_id                    FK
automation_id             FK                         -- denormalized for fast analytics
node_key                  text
node_kind                 text                       -- denormalized for analytics
entered_via_port_key      text nullable
exited_via_port_key       text nullable
outcome                   text                       -- success / failed / skipped / waiting
duration_ms               int
payload                   jsonb                      -- node-specific metadata (HTTP response code, button clicked, rendered text)
error                     jsonb nullable
executed_at               timestamp                  -- PARTITION KEY
```

**Partitioned by RANGE on `executed_at`, monthly partitions.** Initial partitions created via the migration; a maintenance cron adds future partitions 3 months ahead.

Indexes (per partition):

- `(run_id, executed_at DESC)` — run inspector reads all steps for one run
- `(automation_id, executed_at)` — time-series insights
- `(node_key, executed_at)` — per-node canvas overlays
- BRIN `(executed_at)` — cheap time-bounded scans

#### `automation_scheduled_jobs`

```
id                        text PK (prefix asj_)
run_id                    FK nullable                -- null for scheduled-trigger jobs not yet enrolled
job_type                  text                       -- resume_run / input_timeout / scheduled_trigger / webhook_reception_failure
automation_id             FK
entrypoint_id             FK nullable                -- for scheduled_trigger kind
run_at                    timestamp
status                    text                       -- pending / processing / done / failed
attempts                  int default 0
claimed_at                timestamp nullable
payload                   jsonb
error                     text nullable
created_at                timestamp
```

Indexes:

- `(status, run_at)` — scheduler sweep
- `(run_id)` — cleanup

#### `automation_contact_controls`

```
id                        text PK (prefix acc_)
organization_id           FK
contact_id                FK
automation_id             FK nullable                -- NULL = global pause for all flows
pause_reason              text nullable              -- manual_takeover, user_reply, operator_paused, …
paused_until              timestamp nullable
paused_by_user_id         FK nullable
created_at                timestamp
updated_at                timestamp
```

Constraints (two partial unique indexes):

- UNIQUE `(contact_id, automation_id)` WHERE `automation_id IS NOT NULL` — at most one per-automation row per contact
- UNIQUE `(contact_id)` WHERE `automation_id IS NULL` — at most one global row per contact

Indexes:

- `(contact_id)` — runtime check: fetch all rows for a contact, runtime pauses if any match
- `(paused_until)` — sweep job to clear expired pauses

### 4.5 Preserved adjacent tables (not modified by this rebuild)

These tables remain intact; the new runtime reads from them: `contacts`, `conversations`, `inbox_messages`, `inbox_conversations`, `custom_field_definitions`, `custom_field_values`, `tags`, `contact_tags`, `segments`, `contact_segment_memberships`, `social_accounts`, `workspaces`, `organizations`, `subscription_lists`, `contact_subscriptions`, `ref_urls`, `qr_codes`, `landing_pages`, `broadcasts`, `whatsapp_broadcasts`, `ai_knowledge_bases`, `ai_knowledge_documents`, `ai_knowledge_chunks`, `ai_agents` (AI tables remain untouched even though AI nodes are dropped — inbox AI features may still use them).

---

## 5. Graph JSONB Shape

The entire node/port/edge structure lives in `automations.graph`.

### 5.1 Node vocabulary (10 kinds)

| # | Kind | Purpose |
|---|---|---|
| 1 | `message` | Rich composite message (text / image / video / audio / file / card / gallery / delay blocks + buttons + quick replies). Branchable via ports. |
| 2 | `input` | Capture a typed reply (text / email / phone / number / choice / file). |
| 3 | `delay` | Time-based wait (minutes / hours / days). |
| 4 | `condition` | Branch on a predicate expression (ANDs and ORs over contact fields / tags / segments / run context). |
| 5 | `randomizer` | Weighted random branch. |
| 6 | `action_group` | Ordered bundle of side-effect actions (tag_add / field_set / assign / notify / webhook_out / etc.). |
| 7 | `http_request` | External API call with `success` / `error` branches. |
| 8 | `start_automation` | Enroll the contact in another automation. Current flow continues via `next`. |
| 9 | `goto` | Jump to another node in the same graph (loops, shared tails). |
| 10 | `end` | Explicit termination. Optional — running out of edges also ends. |

### 5.2 Ports per kind

| Kind | Input ports | Output ports |
|---|---|---|
| `message` | `in` | `next`, `button.<id>` (per branch button), `quick_reply.<id>` (per QR), `no_response` (if wait_for_reply + timeout) |
| `input` | `in` | `captured`, `invalid`, `timeout`, `skip` |
| `delay` | `in` | `next` |
| `condition` | `in` | `true`, `false` |
| `randomizer` | `in` | `variant.<key>` (one per variant) |
| `action_group` | `in` | `next`, `error` (error only if ≥1 action has `on_error="abort"`) |
| `http_request` | `in` | `success`, `error` |
| `start_automation` | `in` | `next` |
| `goto` | `in` | — |
| `end` | `in` | — |

### 5.3 Message block types

Inside `message.config.blocks` (ordered array):

- `text` — plain text, merge tags supported, optional inline `buttons` array
- `image` — image + optional caption
- `video` — video + optional caption
- `audio` — audio file
- `file` — file attachment
- `card` — image + title + subtitle + up to 3 buttons
- `gallery` — array of cards (carousel, max 10)
- `delay` — in-message typing-indicator pause between blocks (0.5–10s)

Buttons have `type: branch | url | call | share`. Only `branch` creates a port. Quick replies are a flat array on the message (`config.quick_replies`), not per-block.

### 5.4 Action types (inside `action_group`)

- **Contact data:** `tag_add`, `tag_remove`, `field_set`, `field_clear`, `segment_add`, `segment_remove`
- **Subscriptions:** `subscribe_list`, `unsubscribe_list`, `opt_in_channel`, `opt_out_channel`
- **Conversation:** `assign_conversation`, `unassign_conversation`, `conversation_open`, `conversation_close`, `conversation_snooze`
- **External:** `webhook_out` (fire-and-forget), `notify_admin`, `log_conversion_event`
- **Automation controls:** `pause_automations_for_contact`, `resume_automations_for_contact`
- **Destructive:** `delete_contact`
- **v1.1 stub:** `change_main_menu` (visible in UI, disabled until platform sync ships)

Every action has `on_error: "abort" | "continue"` (default `"abort"`).

### 5.5 Graph JSON example

```json
{
  "schema_version": 1,
  "root_node_key": "greet",
  "nodes": [
    {
      "key": "greet",
      "kind": "message",
      "title": "Ask size",
      "canvas_x": 100,
      "canvas_y": 100,
      "config": {
        "blocks": [
          {
            "id": "blk_1",
            "type": "text",
            "text": "Hi {{contact.first_name}}! What size?",
            "buttons": [
              { "id": "btn_large", "type": "branch", "label": "Large" },
              { "id": "btn_small", "type": "branch", "label": "Small" }
            ]
          }
        ],
        "quick_replies": [],
        "wait_for_reply": true,
        "no_response_timeout_min": 60
      },
      "ports": [
        { "key": "in", "direction": "input" },
        { "key": "next", "direction": "output" },
        { "key": "button.btn_large", "direction": "output" },
        { "key": "button.btn_small", "direction": "output" },
        { "key": "no_response", "direction": "output" }
      ]
    },
    {
      "key": "order_large",
      "kind": "action_group",
      "config": {
        "actions": [
          { "id": "a1", "type": "tag_add", "tag": "ordered_large", "on_error": "abort" },
          { "id": "a2", "type": "field_set", "field": "last_order", "value": "large", "on_error": "abort" }
        ]
      },
      "ports": [
        { "key": "in", "direction": "input" },
        { "key": "next", "direction": "output" },
        { "key": "error", "direction": "output" }
      ]
    }
  ],
  "edges": [
    { "from_node": "greet", "from_port": "button.btn_large", "to_node": "order_large", "to_port": "in" },
    { "from_node": "greet", "from_port": "button.btn_small", "to_node": "order_small", "to_port": "in" }
  ]
}
```

### 5.6 Port derivation policy

Ports are **deterministic from node config**, not freeform. On every save the server runs a pure function `derivePorts(node) → Port[]` per node kind. For a message node, button and quick-reply ports derive from `config.blocks[*].buttons` and `config.quick_replies`. For an action_group, the `error` port exists iff any action has `on_error="abort"`. The derived port array overwrites `node.ports`.

Consequences:

- Deleting a button automatically removes its port; dangling edges are caught by the validator and auto-pruned with a warning
- Edges referencing non-existent ports are caught at save time
- The builder never hand-authors the `ports` array; it reads it from the JSON after the server round-trip

---

## 6. Entrypoint & Binding Taxonomy

### 6.1 Entrypoint kinds (16 total)

| Kind | IG | FB | WA | TG | TikTok |
|---|:-:|:-:|:-:|:-:|:-:|
| `dm_received` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `keyword` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `comment_created` | ✓ | ✓ | — | — | ✓ |
| `story_reply` | ✓ | ✓ | — | — | — |
| `story_mention` | ✓ | ✓ | — | — | — |
| `live_comment` | ✓ | ✓ | — | — | ✓ |
| `ad_click` | ✓ | ✓ | — | — | — |
| `ref_link_click` | ✓ | ✓ | — | — | — |
| `share_to_dm` | ✓ | — | — | — | — |
| `follow` | ✓ | — | — | — | ✓ |
| `schedule` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `field_changed` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `tag_applied` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `tag_removed` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `conversion_event` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `webhook_inbound` | ✓ | ✓ | ✓ | ✓ | ✓ |

### 6.2 Specificity ranking (for conflict resolution per B5)

- `keyword` (exact or regex) → 30
- `webhook_inbound` (unique URL slug) → 30
- Asset-filtered (e.g., `comment_created` with specific post_ids) → 25
- Filtered with tag/segment/field predicate → 20
- Account-scoped broad (`dm_received` on account X, no filter) → 10
- Catch-all (no account, no filter) → 0

### 6.3 Entrypoint config examples

- `keyword`: `{ keywords: string[], match_mode: "exact" | "contains" | "regex", case_sensitive: bool }`
- `comment_created`: `{ post_ids: string[] | null, keyword_filter?: string[], include_replies: bool }`
- `schedule`: `{ cron: string, timezone: string }`
- `field_changed`: `{ field: string, from?: any, to?: any }`
- `tag_applied` / `tag_removed`: `{ tag: string }`
- `ref_link_click`: `{ ref_url_id: string }`
- `webhook_inbound`:
  ```json
  {
    "webhook_slug": "auto-generated-nanoid",
    "webhook_secret": "enc_...",
    "contact_lookup": {
      "by": "email" | "phone" | "platform_id" | "custom_field" | "contact_id",
      "field_path": "$.customer.email",
      "custom_field_key": "shopify_customer_id",
      "auto_create_contact": true
    },
    "payload_mapping": {
      "order_id": "$.order.id",
      "order_total": "$.order.total"
    }
  }
  ```

### 6.4 Binding types (5 total)

| Type | Channels | v1 status |
|---|---|---|
| `default_reply` | IG, FB, WA, TG, TikTok | **Wired live** — inbox processor falls through to this binding when no entrypoint matches |
| `welcome_message` | IG, FB, WA, TG, TikTok | **Wired live** — fires on contact's first-ever inbound on the channel |
| `conversation_starter` | FB only | **Stubbed** — storage + UI; platform sync via `messenger_profile.ice_breakers` in v1.1 |
| `main_menu` | FB, IG | **Stubbed** — storage + UI; platform sync via `messenger_profile.persistent_menu` in v1.1 |
| `ice_breaker` | WA only | **Stubbed** — storage + UI; platform sync via WhatsApp Business API in v1.1 |

### 6.5 Binding config examples

- `default_reply`, `welcome_message`: `{}` — `automation_id` on the binding row is sufficient
- `conversation_starter`: `{ starters: [{ label, payload }] }` (max 4)
- `main_menu`: `{ items: [{ label, action: "postback" | "url", payload, sub_items? }] }` (max 3 levels deep)
- `ice_breaker`: `{ questions: [{ question, payload }] }`

### 6.6 Runtime match algorithm

On every inbound event:

1. Load candidate entrypoints: `(channel, kind, status='active')`, further filtered by `social_account_id` (if set) and the kind-specific `config` matcher.
2. Apply filter predicates (`filters` JSONB, evaluated by preserved `filter-eval.ts`).
3. Check reentry: if the contact has an active run for this `(automation_id, entrypoint_id)`, or a completed run within the cooldown window, skip this entrypoint.
4. Check contact controls: if this contact has a global pause row OR a per-automation pause row matching this automation, skip.
5. Sort candidates by `(specificity DESC, priority ASC, created_at ASC)`. Take the first.
6. Enroll contact → create `automation_runs` row. Dispatch to runner.
7. If **no entrypoint matches**, fall through to binding lookup: `default_reply` binding on `(social_account_id, channel)` — if present and active, enroll via the binding.
8. `welcome_message` binding fires only on the contact's first-ever inbound message on that channel (existing inbox_messages check).

### 6.7 Webhook reception

Public endpoint: `POST /v1/webhooks/automation-trigger/{webhook_slug}`.

1. Look up the entrypoint by `webhook_slug`.
2. Verify `X-Relay-Signature: sha256=<hmac>` against `webhook_secret`. 401 on mismatch.
3. Parse body, resolve contact via `contact_lookup` (JSONPath extraction + lookup by email/phone/platform_id/custom_field/contact_id; auto-create if configured).
4. Apply `payload_mapping` to produce initial `run.context`.
5. Enroll contact → create run. Return `202 { run_id }`.

---

## 7. Templates (formerly Experiences)

Templates are starter scaffolds for new automations. The create-automation dialog offers a grid of them. Picking a template opens a multi-step form (or a blank canvas for "Blank"); on submit, a `buildGraphFromTemplate(kind, config)` function generates the automation's `graph` and an initial entrypoint. The new automation is saved with `created_from_template = <kind>` and `template_config = <wizard input>` (observability only — the graph is authoritative after creation).

### 7.1 Template catalog (v1)

| Kind | Channel(s) | Description |
|---|---|---|
| `blank` | any | Empty flow, no entrypoint |
| `comment_to_dm` | IG, FB | Reply publicly + DM responder for post comments |
| `story_leads` | IG | Lead capture from story replies |
| `follower_growth` | IG | Contest flow — comment + share mechanics |
| `follow_to_dm` | IG, TikTok | Welcome DM on new follow |
| `welcome_flow` | any | Generic welcome scaffold (greeting + basic info) |
| `faq_bot` | any | Keyword-routed FAQ scaffold |
| `lead_capture` | any | Generic email/phone capture flow |

### 7.2 Template wizard forms

Each template kind has its own typed multi-step form. Example shapes:

- **comment_to_dm**: channel, account, post multi-picker, keyword filter (optional), public reply text, DM content (inline message composer), once-per-user toggle
- **story_leads**: channel (IG), account, story picker (optional — null = any story), DM content, capture field, success tag
- **follower_growth**: channel (IG), account, contest post, trigger keyword, public reply, DM with contest rules, entry requirements (tag friends / share)
- **follow_to_dm**: channel, account, DM content, daily cap, cooldown

### 7.3 Insights aggregation across templates

`GET /v1/automations/insights?created_from_template=comment_to_dm` rolls up metrics for all automations created from that template kind — across accounts and workspaces — via a single SQL aggregate over `step_runs` joined on `automations.created_from_template`.

---

## 8. Runtime Execution Model

### 8.1 Run lifecycle

```
       created
          │
          ▼
     ┌─active─┐←──────┐
     │        │       │
     ▼        ▼       │
  waiting  completed  │
     │     exited     │
     │     failed     │
     └────────────────┘
```

- `created` — trigger-matcher enrolls contact; row inserted
- `active` — runner executing nodes synchronously
- `waiting` — parked on input, delay, or external event
- `completed` — hit `end` node or ran out of outgoing edges
- `exited` — intentional or forced early termination (reentry skip, graph_changed, contact_paused, admin_stopped)
- `failed` — handler crash or infinite-loop cap

### 8.2 Exit reasons

Free-text, commonly: `completed`, `graph_changed`, `node_removed`, `contact_paused`, `reentry_cooldown`, `input_timeout`, `admin_stopped`, `handler_failure`, `infinite_loop_cap`.

### 8.3 Execution loop (one step)

For each node visit:

1. **Pause check.** Look up rows in `automation_contact_controls` for `(contact_id, automation_id)` OR `(contact_id, NULL)`. If any match with `paused_until IS NULL OR paused_until > now()` → set run to `waiting`, `waiting_for = "external_event"`, exit loop. Resume happens when a pause row is deleted.
2. **Load graph.** Read `automations.graph` JSONB once per loop iteration (cached for this iteration only — re-read on next iteration to catch edits).
3. **Locate node.** Find node by `current_node_key`. If missing → exit run with `exit_reason = "graph_changed"`, log `current_node_key` into step_runs.
4. **Dispatch handler.** `manifest[node.kind].handle(node, ctx)` returns one of:
   - `{ result: "advance", via_port: "next" }`
   - `{ result: "wait_input", timeout_at?: Date }`
   - `{ result: "wait_delay", resume_at: Date }`
   - `{ result: "end", exit_reason: "completed" }`
   - `{ result: "fail", error: Error }` — tries `error` port if present, else sets run to `failed`
5. **Write step_run.** Append to `automation_step_runs` with node_key, node_kind, port keys, outcome, duration, payload, error.
6. **Resolve next edge.** Find edge where `from_node == current_node.key && from_port == via_port`. If none → exit with `completed`. If found, update run: `current_node_key = next.to_node`, `current_port_key = next.to_port`. Loop.

### 8.4 Node handler interface

```ts
interface NodeHandler<Config, Payload> {
  kind: string;
  derivePorts(config: Config): Port[];
  validateConfig(config: Config, graph: Graph): ValidationError[];
  handle(node: Node, ctx: RunContext): Promise<HandlerResult<Payload>>;
}
```

The rewritten `manifest.ts` is a simple registry: `Record<NodeKind, NodeHandler>`. Adding a kind = implementing the interface + registering. No migrations, no enum changes.

### 8.5 Port-based edge resolution

```ts
function findNextNode(graph: Graph, from_node: string, from_port: string): Edge | null {
  return graph.edges.find(e => e.from_node === from_node && e.from_port === from_port) ?? null;
}
```

No label fallbacks. If a port has no outgoing edge, the run exits via `completed` (the operator chose not to handle that branch — fine).

### 8.6 Wait / resume

**Input wait:**

- Handler returns `wait_input` with optional timeout
- Runtime sets `run.status = "waiting"`, `run.waiting_for = "input"`, `run.waiting_until = timeout`
- Writes a `automation_scheduled_jobs` row: `job_type = "input_timeout"`, `run_at = timeout`
- When an inbound message arrives on the same conversation, the preserved `findWaitingEnrollment` logic (rewritten to query `automation_runs`) matches the run
- Input validation runs against the message text; on match → resume via `captured`. After max retries without match → resume via `invalid`. On timeout → resume via `timeout`.

**Delay wait:**

- Handler returns `wait_delay` with `resume_at`
- `run.status = "waiting"`, `run.waiting_for = "delay"`
- Scheduled job: `job_type = "resume_run"`, `run_at = resume_at`
- Scheduler sweep picks it up, re-enters the execution loop at the delay node's `next` port

### 8.7 Scheduler

- Runs every 15 seconds
- Batch-claims up to 200 pending jobs where `run_at <= now()` using `SELECT ... FOR UPDATE SKIP LOCKED`
- Marks claimed rows `status = "processing"`, `claimed_at = now()`
- Stale reclaim: rows in `processing` older than 5 minutes are re-queued (`attempts++`)
- Dispatches by `job_type`:
  - `resume_run` → re-enter execution loop
  - `input_timeout` → resume run via `timeout` port
  - `scheduled_trigger` → synthetic event dispatched through trigger-matcher as if a webhook fired
  - `webhook_reception_failure` → no-op (just a failure audit log)

### 8.8 Action group execution

Handler for `action_group`:

1. For each action in order, call its action dispatcher.
2. If an action throws:
   - `on_error = "abort"` → stop, return `{ result: "advance", via_port: "error" }`
   - `on_error = "continue"` → log failure in step_run payload, proceed to next action
3. If all actions completed (with or without continue-failures): `{ result: "advance", via_port: "next" }`.

Action dispatch is a registry `{ [action_type]: (action, ctx) => Promise<void> }` — analogous to the node handler registry.

### 8.9 HTTP request

- Builds request (URL, method, headers, body — supports merge tags)
- `fetch` with configurable timeout (default 15s)
- Stores response in `run.context[user_configured_key]`
- `advance` via `success` for 2xx, `error` for 4xx / 5xx / network / timeout

### 8.10 Concurrency & idempotency

- **One active run per (contact, automation)** enforced via partial unique index (Section 4.4 `automation_runs`). Prevents double-enrollment from near-simultaneous events.
- **Step-run writes are append-only** — no updates, no deletes.
- **Run state updates are optimistic** via `updated_at`: worker reads run, executes step, writes with `WHERE updated_at = :prior_updated_at`. Zero rows updated → another worker won; exit gracefully.
- **Infinite-loop cap**: max 200 node visits per execution-loop iteration → `failed` with `exit_reason = "infinite_loop_cap"`.

### 8.11 Graph-change safety

Because edits are instantly live (B2):

- Every loop iteration reads the current `graph` freshly
- If `current_node_key` doesn't exist → exit `graph_changed`
- If `current_port_key` doesn't exist on the node → exit `graph_changed`
- If an edge points to a nonexistent `to_node` → treated as `completed` (path ends, not failure)
- Validator (Section 10.9) auto-pauses the automation on save when the graph is broken, making this path rare

---

## 9. API Surface

All paths under `/v1`. Zod-OpenAPI style consistent with the repo.

### 9.1 Automations (core)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/automations` | List. Filters: `workspace_id`, `status`, `channel`, `created_from_template`, `q`. Cursor pagination. |
| `POST` | `/automations` | Create. Defaults: `status="draft"`, empty graph. Optional `template` field invokes `buildGraphFromTemplate`. |
| `GET` | `/automations/{id}` | Retrieve (full graph + entrypoints + bindings summary). |
| `PATCH` | `/automations/{id}` | Update metadata (name, description). Not the graph. |
| `PUT` | `/automations/{id}/graph` | Replace graph JSONB. Runs port derivation + validator. On validation failure, saves anyway + forces status to `paused` + returns 422 with `validation_errors`. |
| `DELETE` | `/automations/{id}` | Hard delete (cascades). |
| `POST` | `/automations/{id}/activate` | Set `status="active"`. Re-runs validator; 422 if invalid. |
| `POST` | `/automations/{id}/pause` | Set `status="paused"`. |
| `POST` | `/automations/{id}/resume` | Activate if validation passes. |
| `POST` | `/automations/{id}/archive` | Set `status="archived"`. |
| `POST` | `/automations/{id}/unarchive` | Back to `paused`. |
| `POST` | `/automations/{id}/enroll` | Manual enrollment (dashboard test, programmatic). Body: `{ contact_id, entrypoint_id?, context_overrides? }`. |
| `POST` | `/automations/{id}/simulate` | Dry-run. Body: `{ start_node_key?, test_context?, branch_choices? }`. No side effects. |

### 9.2 Entrypoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/automations/{id}/entrypoints` | List under automation. |
| `POST` | `/automations/{id}/entrypoints` | Create. |
| `GET` | `/automation-entrypoints/{id}` | Retrieve. |
| `PATCH` | `/automation-entrypoints/{id}` | Update. |
| `DELETE` | `/automation-entrypoints/{id}` | Remove. |
| `POST` | `/automation-entrypoints/{id}/rotate-secret` | For `webhook_inbound` only. Generates new secret; returns plaintext once. |

### 9.3 Webhook reception (public, signed)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/webhooks/automation-trigger/{webhook_slug}` | Third-party POST target. HMAC-verified. Returns `202 { run_id }` on success; `401` bad signature; `404` unknown slug; `422` contact lookup failure. |

### 9.4 Bindings

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/automation-bindings` | List. Filters: `social_account_id`, `binding_type`, `automation_id`. |
| `POST` | `/automation-bindings` | Create. Unique `(social_account_id, binding_type)`. Stubbed types default `status="pending_sync"`. |
| `GET` | `/automation-bindings/{id}` | Retrieve. |
| `PATCH` | `/automation-bindings/{id}` | Update. |
| `DELETE` | `/automation-bindings/{id}` | Remove. |

### 9.5 Runs & step runs

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/automations/{id}/runs` | List runs for an automation. Filters: `status`, `contact_id`, `started_after`, `started_before`. |
| `GET` | `/automation-runs/{id}` | Run detail. |
| `GET` | `/automation-runs/{id}/steps` | Step-run log. |
| `POST` | `/automation-runs/{id}/stop` | Force-exit. |

### 9.6 Contact controls

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/contacts/{id}/automation-controls` | List all pause rows. |
| `POST` | `/contacts/{id}/automation-pause` | Body: `{ automation_id?, pause_reason?, paused_until? }`. Missing `automation_id` = global. |
| `POST` | `/contacts/{id}/automation-resume` | Body: `{ automation_id? }`. |

### 9.7 Catalog

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/automations/catalog` | Bundled response: `{ node_kinds, entrypoint_kinds, binding_types, action_types, channel_capabilities, template_kinds }`. ETag-cached. |

### 9.8 Insights

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/automations/{id}/insights?period=` | Aggregates from `step_runs`. Returns totals, per-node stats, exit-reason breakdown. |
| `GET` | `/automations/insights?created_from_template=` | Roll up by template kind. |
| `GET` | `/automation-entrypoints/{id}/insights` | Same, scoped to entrypoint. |
| `GET` | `/automation-bindings/{id}/insights` | Same, scoped to binding. |

### 9.9 Shape conventions

- IDs: nanoid with prefixes — `auto_`, `aep_`, `abnd_`, `arun_`, `acc_`, `asj_`.
- Errors: `{ error: { code, message, details? } }`. Validation errors use `code: "validation_failed"` with `details: [{ node_key, port_key?, error_code, message }]`.
- Pagination: cursor-based, `next_cursor` + `has_more`, limit 1–100 (default 20).
- Multi-tenancy: all resources scoped by `workspace_id` (optional, org-wide when null — matches existing convention).

### 9.10 SDK surface

The SDK at `packages/sdk/src/resources/automations.ts` is rewritten to mirror this API:

- `relay.automations.*` — core CRUD + lifecycle + simulate + enroll + insights
- `relay.automationEntrypoints.*` — entrypoint CRUD + secret rotation
- `relay.automationBindings.*` — binding CRUD
- `relay.automationRuns.*` — runs + steps + stop
- `relay.automations.catalog()` — catalog fetch
- `relay.contacts.automationControls.*` — pause/resume + list

OpenAPI spec exported via the existing `bun run --filter api export-openapi` workflow.

---

## 10. Builder Interaction Model

### 10.1 What the builder manages

Local state: a single `graph` JSON object (Section 5). All canvas edits mutate this in memory. Saves are debounced to `PUT /v1/automations/{id}/graph` on blur / drag-end / keyboard pause (750ms). Saves send the whole graph; server re-derives ports and re-validates, returning the canonicalized graph + validation result.

React Flow stays the canvas engine. What changes: nodes, handles, and edges are produced from the graph's node/port/edge structure rather than label-derived config.

### 10.2 Port-driven handle rendering

For each node in `graph.nodes`:

- Input ports → left-side handles (`Position.Left`)
- Output ports → right-side handles (`Position.Right`)
- Handle `id` = port's `key`
- Handle label derived from port semantics: branch button label, quick reply label, condition `true`/`false`, input `captured`/`invalid`/`timeout`/`skip`, randomizer variant weight/name
- Color cues for branch-type ports (true=green, false=red, error=red, success=green)

Replaces the current `output-labels.ts` logic entirely. The builder no longer inspects node config to guess outputs — it reads the `ports` array.

### 10.3 Direct node-to-node connection

`onConnect` (React Flow callback):

- Validate: source is an output port, target is an input port, not a self-loop (unless target is `goto`), port keys exist on both nodes, source port has no existing outgoing edge (single-outgoing convention — second connection reassigns rather than duplicates)
- On valid: push edge into `graph.edges`
- On invalid: show a toast with the reason

### 10.4 Edge reconnect

On reconnect drag:

- Valid target handle → update edge's `to_node` / `to_port`
- Different source handle → update `from_node` / `from_port`
- Empty space → open the insert menu pre-filled with the source port

### 10.5 Drag-to-create insert menu

Triggered by dragging a connection from an output handle into empty canvas space:

- **Command-palette-style popover** at drop position
- **Search input** (net new)
- **Grouped catalog:**
  - Content: `message`, `input`, `delay`
  - Logic: `condition`, `randomizer`
  - Actions: `action_group`, `http_request`
  - Flow: `start_automation`, `goto`, `end`
- **Channel-aware filtering:** reads automation's `channel`. Unsupported block types surfaced as warnings in the composer (not filtered out of the kind menu — the `message` node kind is always offered).
- **Recent/frequent picks** pinned to top
- **Keyboard:** `/` or `Cmd+K` also opens the menu with a node selected
- On select: creates node with generated `key` at drop position + edge from source port to new node's `in`. Single atomic mutation, debounced save.

### 10.6 Branch-specific handles

- **Condition:** `true` (green), `false` (red)
- **Randomizer:** N dynamic `variant.<key>` handles, labeled with weight/name
- **Input:** `captured`, `invalid`, `timeout`, `skip` — color-coded
- **Message:** dynamic — `next`, `button.<id>` per branch button, `quick_reply.<id>` per QR, optional `no_response`. Message composer edits reflect immediately; orphan edges (from deleted buttons) are auto-pruned on save with a warning
- **HTTP request:** `success` (green), `error` (red)
- **Action group:** `next`, `error` (error port present only if at least one action has `on_error="abort"`)

### 10.7 Selection, clipboard, keyboard

- Single select (click), multi-select (Shift+click / Cmd+click), lasso (Cmd+drag or toolbar mode)
- Duplicate (`Cmd+D`): clones selected subgraph with new keys, offset 40px; internal edges cloned, external edges dropped
- Copy (`Cmd+C`): serializes selected subgraph to React Flow clipboard + `navigator.clipboard` as JSON (cross-automation paste)
- Paste (`Cmd+V`): parses clipboard, generates new keys to avoid collisions, positions at cursor
- Undo/redo (`Cmd+Z` / `Cmd+Shift+Z`): client-side JSON-snapshot stack, 50 entries, coalesced (300ms for move, 750ms for property edits)
- Select all (`Cmd+A`), delete (`Del`/`Backspace`), frame selection (`F`), reset zoom (`0`), force save (`Cmd+S`)

### 10.8 Auto-arrange (preserved, extended)

Current `computeAutoPositions()` algorithm stays. Extended: if a group is selected, auto-arrange only the selected subgraph.

### 10.9 Save & validation flow

```
PUT /v1/automations/{id}/graph
{ "graph": { schema_version, root_node_key, nodes, edges } }
```

Server:

1. Re-derive ports for every node via `derivePorts(node.kind, node.config)`; overwrite node `ports` array.
2. Run validator.
3. Persist. If validator failed, set `status = "paused"` and populate `validation_errors`.
4. Return: `{ graph: <canonicalized>, validation: { valid, errors, warnings }, automation: { status, validation_errors } }`.

Validator rules:

- Every non-root node has ≥1 incoming edge
- Every edge references an existing `(node, port)` pair on both ends
- Every `input` edge targets an existing input port on the target
- Every `output` edge originates from an existing output port on the source
- Root node kind is one of `message`, `action_group`, `condition`, `http_request`, `start_automation`, `end` (not `input` / `delay` / `goto` — those need a predecessor)
- No duplicate node keys
- No cycles unless at least one node in the cycle is a `goto` or an `input` (loops require a pause point)
- `start_automation` targets an existing automation (FK check)
- `goto` target exists in the same graph

Errors block activation. Warnings (orphaned button port, etc.) don't block.

### 10.10 What's preserved / rewritten

**Preserved** (light refactor):

- `automation-page.tsx` list view
- `automation-detail-page.tsx` shell
- `automation-new-page.tsx` create wizard (becomes the create-with-template dialog)
- `guided-flow.tsx` ReactFlow setup, auto-arrange, drag, zoom
- `property-panel.tsx` generic `FieldRow` / schema parser (used by non-message, non-action_group kinds)
- `trigger-panel.tsx` dual-mode shell, `AccountSearchCombobox`, `FilterGroupEditor`

**Rewritten:**

- `output-labels.ts` → replaced by port-rendering logic
- Edge creation / reconnect / insert handlers → ported to port model
- Property-panel output-label sections → replaced by message composer (Section 11) and action editor (Section 12)
- Insert menu → adds search, channel awareness
- Node catalog source → fetched from `/automations/catalog` instead of hardcoded

**Net new:**

- Multi-select + lasso
- Copy/paste clipboard
- Undo/redo stack
- Validation badge overlay + auto-pause banner
- Keyboard shortcut layer

---

## 11. Message Composer

Replaces the generic property panel when a `message` node is selected. Right-side panel, same physical slot as today's `property-panel.tsx`, 480px default width, user-resizable.

### 11.1 Right-panel structure (unified for all nodes)

```
┌────────────────────────────────────────┐
│ [Title input] [⋯ menu]                 │  node-level header (always shown)
│ Kind: <kind badge>                     │
├────────────────────────────────────────┤
│                                        │
│         KIND-SPECIFIC EDITOR           │  changes per kind
│                                        │
├────────────────────────────────────────┤
│ Node notes (collapsible)               │  ui_state.notes
│ Canvas color tag                       │  ui_state.color
└────────────────────────────────────────┘
```

For `message` nodes the editor is the composer; for `action_group` nodes it's the action editor; for all other kinds it's the existing schema-driven generic form.

### 11.2 Composer anatomy

```
Message: "Ask for size"
Channel: Instagram    [warnings if any]

  ⠿ Block 1: Text
      Hi {{contact.first_name}}! What size?
      [Add button] [Add quick reply]
      • Branch → Large
      • Branch → Small

  ⠿ Block 2: Image
      [media preview] [replace] [caption]

  [+ Add block ▼]     — text/image/video/audio/file/card/gallery/delay

Quick replies (message-level)
  • "Help"
  • "Menu"
  [+ Add quick reply]

☑ Wait for user reply
  Timeout: 60 minutes

[Preview] [Save]
```

### 11.3 Block editors

- **Text**: textarea + merge-tag picker (`@` autocomplete) + inline buttons
- **Image / Video / Audio / File**: media picker (upload / library / URL) + optional caption
- **Card**: image + title + subtitle + up to 3 buttons
- **Gallery**: repeater of up to 10 cards, reorderable
- **Delay**: 0.5–10s typing pause

### 11.4 Button editor

```
Label: [text]
Type:  [Branch | URL | Call | Share]

Branch → creates a port "button.<id>" on the message node
URL    → opens URL in browser (no port)
Call   → opens phone dialer (no port)
Share  → share the message (no port)
```

### 11.5 Quick replies

Flat list on the message (not per-block). Label (max 20 chars), optional emoji icon. Always creates `quick_reply.<id>` ports.

### 11.6 Message-level settings

- `wait_for_reply` — auto-true if any branch buttons or quick replies; otherwise explicitly toggleable
- `no_response_timeout_min` — shown only if `wait_for_reply`; creates the `no_response` port when set
- Typing-indicator delay before first block (0–5s)

### 11.7 Channel capability matrix

| Feature | IG | FB | WA | TG | TikTok |
|---|:-:|:-:|:-:|:-:|:-:|
| Buttons (branch) | ✓ (3) | ✓ (3) | ✓ (3) | ✓ inline kb | ✗ |
| Quick replies | ✓ (13) | ✓ (13) | ✗ | ✓ reply kb | ✗ |
| Card | ✓ | ✓ | ✗ | ✗ | ✗ |
| Gallery | ✓ (10) | ✓ (10) | ✗ | ✗ | ✗ |
| Image | ✓ | ✓ | ✓ | ✓ | ✓ |
| Video | ✓ | ✓ | ✓ | ✓ | ✓ |
| Audio | ✗ | ✓ | ✓ | ✓ | ✗ |
| File | ✗ | ✓ | ✓ | ✓ | ✗ |
| `delay` block | ✓ | ✓ | ✓ | ✓ | ✓ |

Unsupported features inline-warn on the block: "⚠ Gallery not supported on WhatsApp — this block will be skipped at send time." Doesn't block save; runtime skips silently.

### 11.8 Preview panel

Inline toggle. Renders a phone-frame mock styled per channel. Merge tags filled with placeholder data. Buttons and quick replies rendered as they'd appear on-device. No simulator invocation — pure client-side render. A separate "Run Simulator" action uses `POST /automations/{id}/simulate` and shows a step-by-step transcript.

### 11.9 Merge tag picker

Triggered by `@` or `{{` in any text field. Groups:

- **Contact** — `{{contact.first_name}}`, `{{contact.email}}`, `{{contact.custom_fields.<name>}}`
- **Context** — `{{context.<key>}}` (captured inputs, HTTP responses)
- **Run** — `{{run.id}}`, `{{run.started_at}}`
- **Account** — `{{account.name}}`, `{{account.handle}}`

Validated on save; unknown paths become warnings.

### 11.10 What this replaces

~1,500 LOC across `property-panel.tsx` (the sections handling `message_text`, `message_media`, `message_file`, interactive-node UIs, Telegram keyboards, WhatsApp lists) collapses into one coherent composer. The concept of "one node per block type" disappears — one `message` node hosts all block types.

---

## 12. Action Group Editor

Opens in the right panel when an `action_group` node is selected (same slot as the message composer, via the kind-specific editor dispatch in Section 11.1).

### 12.1 Anatomy

```
Actions: "Tag as lead"

  ⠿ 1. Add tag "lead"         On error: [Abort ▾]  [⋯][✕]
  ⠿ 2. Set field stage="new"  On error: [Abort ▾]  [⋯][✕]
  ⠿ 3. Subscribe "nurture"    On error: [Continue ▾] [⋯][✕]
  ⠿ 4. Notify admin           On error: [Continue ▾] [⋯][✕]

  [+ Add action ▾]

This node has:
  • next  — fires after all actions complete
  • error — fires if any `abort` action fails
```

### 12.2 Action catalog (grouped dropdown)

Full action list per Section 5.4. Groups: Contact data, Subscriptions, Conversation, External, Automation controls, Destructive, v1.1 stubs.

### 12.3 Per-action form

Each action type has a typed form. Examples:

- `tag_add`: `{ tag_id | new_tag_name }`
- `field_set`: `{ field_id, value }` (value supports merge tags)
- `webhook_out`: `{ url, method, headers, body, auth }`
- `assign_conversation`: `{ user_id | "round_robin" | "unassigned" }`

All free-text inputs support the merge-tag picker (same as composer).

### 12.4 Reorder / duplicate / delete

- Drag handle on each row
- Row menu: Duplicate, Move up, Move down, Delete
- Multi-select rows → bulk delete / bulk set `on_error`

### 12.5 Preview

"Dry-run actions" button posts to `/automations/{id}/simulate` with `start_node_key` set to the action group node and `execute_side_effects: false`. Shows a transcript of which actions would fire with resolved merge-tag values.

### 12.6 Port derivation

```
derivePorts(node: ActionGroupNode) = [
  { key: "in", direction: "input" },
  { key: "next", direction: "output" },
  ...(node.config.actions.some(a => a.on_error === "abort")
    ? [{ key: "error", direction: "output" }]
    : [])
]
```

### 12.7 What this replaces

Today's per-kind nodes in `apps/api/src/services/automations/nodes/` (`tag-add.ts`, `tag-remove.ts`, `field-set.ts`, `field-clear.ts`, `subscribe-list.ts`, etc., ~15 files) collapse into **one** handler `action-group.ts` + a small action dispatcher registry.

### 12.8 Reused from today

- Tag picker, field picker, user picker, subscription list picker (existing inbox/contact UIs)
- Webhook auth config patterns (existing platform integrations)

---

## 13. Product Surfaces

### 13.1 Sidebar nav

```
Dashboard sidebar
├─ Automations      → /automations (flows list, no sub-routes)
├─ Accounts         → /accounts (existing; per-account detail page has binding tabs)
```

### 13.2 `/automations` (flows list)

Preserved: current `automation-page.tsx`. Extensions:

- Column **Trigger summary** — e.g., "Keyword on IG (3 posts)" / "Webhook" / "Schedule: daily 9am"
- Column **Template badge** — for automations with `created_from_template` set, show the template kind
- Filter **created_from_template** — e.g., show all `comment_to_dm` flows
- Column **30d runs** — live count from step_runs
- Actions preserved: create, duplicate, archive, delete

### 13.3 `/automations/new` (create dialog)

Single dialog replacing the current `automation-new-page.tsx`. Grid layout:

- **Blank** card
- **Quick starts**: `comment_to_dm`, `story_leads`, `follower_growth`, `follow_to_dm`
- **Scaffolds**: `welcome_flow`, `faq_bot`, `lead_capture`
- (Future: custom saved templates)

Picking a template with a wizard opens a multi-step form in-dialog. On submit: creates the automation (`graph` pre-built, `created_from_template` set), creates the entrypoint, redirects to `/automations/{id}`. Operator edits freely from there; no regeneration semantic.

### 13.4 `/automations/{id}` (flow detail)

Preserved: `automation-detail-page.tsx` shell, toolbar, right-panel orchestration. Changes:

- **Left-side panel** (new slot): entrypoints list + bindings summary (which accounts this flow is bound to, and as what)
- **Right-side panel** (existing slot): kind-specific editor per Section 11.1
- **Header:** name, status badge (with inline validation errors if any), activate/pause/archive buttons
- **Tabs:** Canvas / Runs / Insights

Entrypoint panel layout:

```
Entrypoints (N)   [+ Add ▾]
  🔑 Keyword "pizza"   IG @majestico   specificity:30
  💬 DM received       IG @majestico   specificity:10
  🔗 Webhook           slug: auto-xyz123

Bindings (1)
  ⚡ Default reply  IG @majestico
  [manage at /accounts/@majestico#default-reply]
```

### 13.5 Binding tabs inside `/accounts/{id}`

Existing per-account detail page gets new tabs. Visible tabs filtered by channel capability:

- **Default Reply** — all channels
- **Welcome Message** — all channels
- **Main Menu** — FB + IG only
- **Conversation Starters** — FB only
- **Ice Breakers** — WA only

Each tab contains:

- Status pill (Active / Paused / Not set / v1.1 stub)
- **For live bindings (default reply, welcome):** automation picker + change/unbind buttons, 7-day runs + completion rate
- **For stubbed bindings:** the configuration editor (menu items, starter labels, ice-breaker questions) + greyed "Push to platform (v1.1)" tooltip

Navigation from a flow: "Bound to default_reply on @majestico" link deep-routes to `/accounts/@majestico?tab=default-reply`.

### 13.6 Reused vs net new

**Reused:**

- `AccountSearchCombobox`, `PostSearchCombobox`, `FilterGroupEditor`, `TagPicker`, `FieldPicker`
- Existing pagination + table primitives
- Existing `template-picker-dialog.tsx` dialog pattern (promoted to the full create dialog)

**Net new:**

- Left-side entrypoint panel on flow detail
- Binding tabs on per-account detail pages (5 net-new UI surfaces)
- Nested-items editor for main menu (reusable tree component)
- Multi-step template wizard inside create dialog
- Insights tab on flow detail
- Runs tab on flow detail + run inspector

---

## 14. Insights, Run Inspector, Simulator

All observability. Live aggregates from `automation_step_runs` per partitioned indexes — no rollups in v1.

### 14.1 Insights

Per-automation page tab renders:

- Period selector (24h / 7d / 30d / 90d / custom)
- Headline tiles: Enrolled / Completed / Exited / Failed / Avg time
- Runs-per-day line chart
- Completion funnel (enrolled → first reply → each key step)
- Exit-reason breakdown
- Per-entrypoint breakdown (if multiple entrypoints)

Per-entrypoint / per-binding insights: scoped subsets of the same data.

Template aggregation: `GET /automations/insights?created_from_template=X` rolls up across all automations with that template kind.

### 14.2 Canvas overlays

When viewing a flow with `status = active`, each node shows a small metric badge:

```
⚡ 312 · 94% → next
```

Click badge → mini popover with per-port breakdown. Color: green >90% success, yellow 70–90%, red <70%.

Powered by `GET /automations/{id}/insights?granularity=per_node&period=7d`.

### 14.3 Runs list & inspector

Flow detail's **Runs tab**:

- Table: contact, started, status, current node (if waiting), duration, exit reason
- Filters: status, contact, date range
- Click row → inspector panel

Inspector panel:

- Metadata: contact, automation, entrypoint, started, status, current node
- **Timeline**: chronological step_runs with status icons, node kind, duration
- **Context inspector**: snapshot of `run.context`
- **Show on canvas**: highlights current node
- **Stop run** → `POST /automation-runs/{id}/stop`

Transcript viewer (sub-tab of inspector): chat-bubble render of what contact saw and typed, styled per channel. Derived from `step_runs.payload` + `inbox_messages` joined by `conversation_id`.

### 14.4 Simulator

Two entry points:

- **Builder header `[Simulate ▶]`**: inline drawer, pick start node, enter test context, see step-by-step transcript
- **Action editor `[Preview]`**: dry-run of just the selected action_group node, shows actions that would fire with resolved merge-tag values

All simulator calls: `POST /automations/{id}/simulate`. No side effects.

### 14.5 Inbox surfaces

Preserved pause/resume UI in `chat-thread.tsx`. Extensions:

- **Automation badge** in conversation header: "⚡ Pizza Welcome Flow · step 3/7" — click opens run inspector for that run
- **Start an automation** button in inbox composer: picks from active flows filtered by channel, calls `POST /automations/{id}/enroll`
- Pause control stays; backed by `POST /contacts/{id}/automation-pause` with `automation_id = null` (global)

---

## 15. Code Preservation & Rewrite Map

### 15.1 Preserved (intact, re-wired)

Source code to keep as-is or with minimal adapter refactor:

- `apps/api/src/services/automations/trigger-matcher.ts` — `matchTriggerConfig` (keyword modes), `matchesTriggerFilters`, `findWaitingEnrollment` logic (renamed to `findWaitingRun`, adapted to `automation_runs`)
- `apps/api/src/services/automations/filter-eval.ts` — segment/tag/field predicate evaluation
- `apps/api/src/services/automations/merge-tags.ts` — merge-tag resolver
- `apps/api/src/routes/platform-webhooks.ts` — HMAC verification, INBOX_QUEUE / AUTOMATION_QUEUE dispatch, KV-cached account resolution
- `apps/api/src/services/inbox-event-processor.ts` — inbound event routing
- Media upload / picker wiring (R2 + existing media rows)
- Existing UI components: `AccountSearchCombobox`, `PostSearchCombobox`, `FilterGroupEditor`, `TagPicker`, `FieldPicker`, pagination primitives, chat-bubble rendering

### 15.2 Rewritten

- **Runtime:** `runner.ts`, `scheduler.ts`, `simulator.ts`, `manifest.ts`, every file under `apps/api/src/services/automations/nodes/`
- **API routes:** `apps/api/src/routes/automations.ts`, `automation-templates.ts` (split into `/automations`, `/automation-entrypoints`, `/automation-bindings`, `/automation-runs`, `/webhooks/automation-trigger`, `/contacts/{id}/automation-*`)
- **Schemas:** `apps/api/src/schemas/automations.ts` (all Zod schemas rebuilt per the new graph/port model)
- **SDK:** `packages/sdk/src/resources/automations.ts` + new files for `automationEntrypoints`, `automationBindings`, `automationRuns`
- **Builder UI:**
  - `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx` — handle rendering, edge creation, reconnect, insert menu
  - `apps/app/src/components/dashboard/automation/flow-builder/property-panel.tsx` — dispatch to message composer / action editor / generic form
  - `apps/app/src/components/dashboard/automation/flow-builder/output-labels.ts` — deleted; logic absorbed into port rendering
- **Template picker:** `apps/app/src/components/dashboard/automation/template-picker-dialog.tsx` → create-automation dialog with multi-step template wizards

### 15.3 Dropped

- **Code:** `apps/api/src/services/automations/nodes/ai-*.ts` (ai-runtime, ai-agent, ai-step, ai-intent-router) — archived for potential v2, not loaded
- **Tables:** 13 legacy automation tables (Section 4.1)
- **Enums:** 7 legacy enums
- **Concepts:** revisions, enrollments (renamed to runs), label-based edges, per-kind send nodes (all platform-specific sends collapse into message handler's platform dispatch), the standalone experiences table

### 15.4 Net new

- **Tables:** 7 (Section 4.2)
- **Code modules:**
  - `apps/api/src/services/automations/ports.ts` — port derivation per kind
  - `apps/api/src/services/automations/validator.ts` — graph integrity validator
  - `apps/api/src/services/automations/action-dispatcher.ts` — action registry for action_group
  - `apps/api/src/services/automations/templates/` — `buildGraphFromTemplate` per template kind
  - `apps/api/src/services/automations/webhook-receiver.ts` — HMAC + contact lookup for `webhook_inbound` entrypoints
- **UI components:**
  - Message composer (`message-composer.tsx` under flow-builder)
  - Action editor (`action-editor.tsx`)
  - Entrypoint panel (`entrypoint-panel.tsx`)
  - Binding tabs components (5 files per binding type)
  - Canvas metric overlays
  - Runs list + inspector + timeline + transcript viewer
  - Merge-tag picker component
  - Insert menu with search

---

## 16. Open Questions & v1.1 Deferred

### 16.1 Deferred to v1.1

- **Platform sync for stubbed bindings** — `main_menu`, `conversation_starter`, `ice_breaker` push to Meta / WhatsApp APIs
- **AI nodes re-introduction** — v2, not before parity is validated without them
- **Custom apps framework / code step** — when a partner use case demands it
- **Insight rollups / materialized cache** — when a specific insights query proves slow at scale
- **AI Replies / AI Comments bindings** — later AI feature expansion

### 16.2 Still to design during implementation

These are tactical decisions small enough to resolve in the implementation plan rather than this doc:

- Exact index names / migration script sequencing
- Tempo of the monthly-partition maintenance cron (creating new partitions ahead of time)
- Specific React Flow node component composition (custom node components per kind)
- Channel-specific validation strictness during save vs runtime (how hard to warn vs block)
- Insights chart component library choice (if the dashboard doesn't already have one)

### 16.3 Risks & mitigations

- **Risk:** Port derivation + validation on every `PUT /graph` is expensive for large flows. **Mitigation:** benchmark on a 100-node graph during Phase 2; if needed, accept partial updates later (not needed for v1).
- **Risk:** In-flight runs breaking after edits creates confusion. **Mitigation:** clear `graph_changed` exit reason + log on step_runs + visible in run inspector. Auto-pause on validation failure prevents most occurrences.
- **Risk:** `step_runs` table growth outpaces index maintenance. **Mitigation:** monthly partitioning from day one; BRIN index on `executed_at`; no TTL needed until scale demands it.
- **Risk:** Webhook signature verification failures silently drop events. **Mitigation:** `automation_scheduled_jobs` entries with `job_type = "webhook_reception_failure"` capture every failed reception for audit.

---

## 17. Summary

This rebuild replaces a label-based, enum-heavy, per-send-kind-node automation system with a port-based, compact-vocabulary, composite-node system spanning 5 channels and 16 entrypoint kinds. Seven tables replace 13. One `graph` JSONB column replaces normalized node/port/edge rows. Edits are instantly live with clean `graph_changed` fallbacks for in-flight runs. No revisions, no draft/published split. SDK rewritten in place. Builder canvas gets port handles, drag-to-create with search, multi-select, copy/paste, and undo. Message composer and action editor replace ~2,000 LOC of current property-panel sprawl. Basic automations get live-wired default_reply + welcome_message plus stubbed UI for conversation_starters / main_menu / ice_breakers pending platform sync in v1.1. All AI nodes are dropped from v1.

Ships as one cohesive PR on a long-lived greenfield branch. No migration scripts, no production data at risk — pre-launch cutover.

---

**End of specification.** Implementation plan follows in a separate document.
