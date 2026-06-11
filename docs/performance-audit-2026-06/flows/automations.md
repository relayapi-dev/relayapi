# Automation Engine Flow

## Overview

The automation engine is a Manychat-parity flow runner: contacts are enrolled into graph-shaped automations (nodes + edges + ports) in response to inbound social events (DMs, comments, story replies, follows, ad clicks), internal events (tag/field changes, conversion events), external webhooks, manual API enrollment, or cron schedules. Runs walk the graph node-by-node, persisting state to PostgreSQL (via Hyperdrive) after every node, and park on `waiting` status for delays and user input, resumed later by the cron scheduler or the next inbound message.

**Entry points:**

| Entry | Path | Trigger |
|---|---|---|
| Inbound platform event | `apps/api/src/queues/inbox.ts:8` → `services/inbox-event-processor.ts:275` | INBOX_QUEUE consumer (webhooks enqueue; batch 10, concurrency 5, retries 5) |
| Internal events | `services/automations/internal-events.ts:30` (`emitInternalEvent`) | tag_add/tag_remove/field_set actions, ref-link clicks, inbox tagging |
| External webhook trigger | `routes/automation-webhook-trigger.ts:14` (POST `/v1/webhooks/automation-trigger/:slug`, no API-key auth, HMAC) | external systems |
| Manual enroll | `routes/automations.ts:938` (POST `/v1/automations/{id}/enroll`) | API/dashboard |
| Cron scheduler | `scheduled/index.ts:35` → `services/automations/scheduler.ts:235` (`processAutomationSchedule`, every minute) | `automation_scheduled_jobs` table |
| Deprecated queue | `queues/automation.ts:18` | AUTOMATION_QUEUE — dead; consumer only acks stray messages |

**Key modules:** `trigger-matcher.ts` (event → entrypoint matching), `binding-router.ts` (welcome/default-reply fallback), `runner.ts` (`enrollContact` + `runLoop` graph walk), `scheduler.ts` (job-table scheduler + cron math), `input-resume.ts` / `interactive-resume.ts` (wait resumption), `webhook-receiver.ts` (slug+HMAC inbound), `nodes/*` (10 node handlers), `actions/*` (12 action families), `platforms/index.ts` (block → `sendMessage` dispatch).

## Step-by-step trace

### 1. Trigger event (inbound DM example)

1. Platform webhook (Meta/WhatsApp/Telegram/Twilio) is received by `routes/platform-webhooks.ts` and enqueued onto `INBOX_QUEUE` (`relayapi-inbox`, max_batch_size 10, max_concurrency 5 — `wrangler.jsonc:147-152`).
2. `consumeInboxQueue` (`queues/inbox.ts:8`) creates one DB client per batch and processes messages **sequentially** in a `for` loop (`queues/inbox.ts:13`), ack/retry per message.
3. `processInboxEvent` (`inbox-event-processor.ts:275`):
   - normalizes the payload into 0..n `NormalizedInboxEvent`s (`normalizeEvent`, line 929);
   - per event: social-account lookup (line 330), `upsertConversation` (line 351), pre-insert inbound COUNT(*) for the welcome signal (lines 382-406), `insertMessage` (line 408);
   - optional Meta participant profile enrichment: 1–2 Graph API fetches with 5s timeouts + R2 avatar rehost + 2 UPDATEs (lines 444-541);
   - for inbound events → `dispatchAutomationMatch` (line 556).
4. `dispatchAutomationMatch` (`inbox-event-processor.ts:676`):
   - channel gate (instagram/facebook/whatsapp/telegram only, line 694) and `deriveInboundEventKind` (line 650);
   - `ensureContactForAuthor` (`contact-linker.ts:119`) — match contact (1–3 queries) or INSERT contact + contact_channel;
   - **resume precedence**: for `message` events, `resumeWaitingRunForInput` (line 829) queries all `waiting/input` runs for the contact (line 836), then per run tries `resumeWaitingRunOnInteractive` then `resumeWaitingRunOnInput`. If any run consumed the inbound, entrypoint matching is skipped;
   - otherwise builds an `InboundEvent` and calls `matchAndEnrollOrBinding` (line 798).

### 2. Matching (`trigger-matcher.ts:292` `matchAndEnroll`)

1. **Candidate query** (lines 299-323): `automation_entrypoints` INNER JOIN `automations` filtered by `(channel, kind, status='active', automations.status='active', organizationId, social_account_id IS NULL OR = event account)`. This is org-scoped — it does **not** scan all automations; it is indexed by `idx_automation_entrypoints_match (channel, kind, status)` (`packages/db/src/schema.ts:2632`). No candidates → `no_candidates`.
2. **Contact hydration** (lines 330-355): unconditional `contacts.findFirst` + a `custom_field_values ⋈ custom_field_definitions` select — executed even if no candidate has filters.
3. **Config + filter eval** (lines 357-378): in-memory keyword/post-id/tag-id matching (`matchesEntrypointConfig`) + `evaluateFilterGroup` (pure CPU).
4. **Pause check** (lines 386-401): one select on `automation_contact_controls` for the contact.
5. **Re-entry guard** (lines 413-468): **per surviving candidate**, up to 2 sequential `automation_runs` queries — active/waiting-run check (line 419), then either prior-run check (`allow_reentry=false`, line 437) or cooldown check (line 452). N+1 over finalists.
6. **Sort** by `(specificity DESC, priority ASC, created_at ASC)` (line 475), take first.
7. **Enroll** via `enrollContact` (line 490). On miss with `no_candidates`/`all_filtered`, `matchAndEnrollOrBinding` (`binding-router.ts:212`) falls through to `routeBinding`:
   - `isFirstInboundOnChannel` (DB fallback `binding-router.ts:49` — usually short-circuited by the pre-insert count hint);
   - `findBinding` select for `welcome_message`, then `default_reply` (`binding-router.ts:80`), each enrolling via `enrollContact` if found.

### 3. Enrollment (`runner.ts:344` `enrollContact`)

Sequential queries:
1. `automations.findFirst` (line 372) — full row incl. graph JSONB.
2. `buildInitialRunContext` (line 454): `contacts.findFirst` + custom-field select (duplicates the hydration the matcher already did; results are not passed through).
3. INSERT `automation_runs` (line 406) with full hydrated `context` JSONB (contact row + tags + fields + triggerEvent payload).
4. UPDATE `automations SET total_enrolled = total_enrolled + 1` (line 424) — hot-row write on the automation row.
5. `runLoop(db, runId, env)` (line 438) — **synchronous**; the caller blocks until the run completes or parks.

### 4. Run execution — graph walk (`runner.ts:49` `runLoop`)

Per node iteration (max 200 visits, `MAX_VISITS_PER_LOOP` line 33):
1. Re-read the run row (`automationRuns.findFirst`, line 61) — context JSONB included.
2. `findActivePause` select on `automation_contact_controls` (line 76 → 505).
3. Re-read the **entire automation row including the full graph JSONB** (line 93) — "so edits take effect immediately".
4. Locate current node in memory; dispatch handler via `getHandler` (`manifest.ts:30`).
5. `writeStepRun` — INSERT into `automation_step_runs` (line 197 → 650), one row per node visit, with payload/error JSONB. Partitioned table, 4 indexes + BRIN.
6. Apply result via `updateRunOptimistic` (line 575) — UPDATE `automation_runs` guarded by ms-truncated `updated_at` (line 600). Every advance rewrites the full `context` JSONB.

So the floor is **5 sequential DB round trips per node**, plus handler I/O. Terminal states add an `incrementCounter` UPDATE on `automations` (line 627). Run state is persisted to `automation_runs` **after every single node**, and a step-log row is written for every node visit — there is no batching or in-memory carry of run state between iterations.

### 5. Node handlers (per-node work)

- **message** (`nodes/message.ts:36`): merge-tag render (CPU); `resolveRecipient` — `contact_channels ⋈ contacts` select + `social_accounts` select + AES-GCM token decrypt (lines 254-292); `dispatchAutomationMessage` (`platforms/index.ts:159`) — **one external HTTP call per block** via `sendMessage` (`message-sender.ts:98`); `typing_indicator_seconds` and `delay` blocks do a literal in-process `await wait(ms)` (`platforms/index.ts:182-198`, unbounded `block.seconds`). Returns `wait_input` when buttons/quick replies/`wait_for_reply` are present.
- **input** (`nodes/input.ts`): pure — returns `wait_input` (+ `timeout_at`).
- **delay** (`nodes/delay.ts`): pure — returns `wait_delay` with `resume_at` (min 1s clamp).
- **condition** / **randomizer** / **goto** / **end**: pure CPU.
- **action_group** (`nodes/action-group.ts:23`): runs actions sequentially. Per action:
  - `tag_add`/`tag_remove` (`actions/tag.ts`): contact re-read (line 59) + UPDATE (line 69) + `emitInternalEvent` → full `matchAndEnrollOrBinding` recursion (depth-capped at 5, `internal-events.ts:19`).
  - `field_set` (`actions/field.ts`): definition select + value select + update/insert (3 round trips) + internal `field_changed` event.
  - `segment_add/remove`: 1 statement. `notify_admin`: member select + bulk notification insert. `webhook_out`: external fetch (awaited; HMAC via WebCrypto). `reply_to_comment` (`actions/comment.ts`): social-account select + decrypt + Graph API POST.
- **http_request** (`nodes/http-request.ts`): external fetch, default timeout 15s, response stored in run context.
- **start_automation** (`nodes/start-automation.ts`): automation select + nested **synchronous** `enrollContact` (child run executes fully before the parent advances).

### 6. Waits and resume

- `wait_delay` → run UPDATE to `waiting/delay` + INSERT `automation_scheduled_jobs (job_type='resume_run', run_at)` (`runner.ts:269-285`).
- `wait_input` with timeout → same + `job_type='input_timeout'` (`runner.ts:250-265`).
- **Scheduler** (`scheduler.ts:43` `processScheduledJobs`, cron `*/1 * * * *` via `scheduled/index.ts:35`):
  1. Stale-reclaim UPDATE (line 52, every tick).
  2. Batch claim 50 due jobs with `FOR UPDATE SKIP LOCKED` CTE-UPDATE (line 63).
  3. **Sequential** per-job dispatch (line 91): `resume_run` → `runLoop`; `input_timeout` → run+automation re-read, advance via `timeout` edge then `runLoop`, or exit; `scheduled_trigger` → see below. One status UPDATE per job (done/failed).
- **scheduled_trigger** (`scheduler.ts:283`): entrypoint + automation reads; next-occurrence job insert (idempotent ±1s window check, line 395); `enumerateContactsForScheduleFilter` (line 425) — loads **all** matching contact ids (tag `@>` or segment membership selects, **no LIMIT**); then a **sequential** `for` loop calling `matchAndEnrollOrBinding` per contact (lines 343-365), each of which runs the full match + enroll + `runLoop` pipeline in-process.
- **Inbound resume** (`inbox-event-processor.ts:829` → `input-resume.ts:206` / `interactive-resume.ts:50`): each resume re-reads run + automation (2 selects), resolves the port in memory, 1 run UPDATE, then re-enters `runLoop`.

### 7. External webhook trigger (`webhook-receiver.ts:309`)

1. **Slug lookup** (lines 319-337): selects **every** active `webhook_inbound` entrypoint joined to active automations **across all organizations** (the WHERE has no org or slug filter — slug lives inside `config` JSONB) and finds the slug in JS (`rows.find(... cfg.webhook_slug === params.slug)`, line 334). The `idx_automation_entrypoints_match (channel, kind, status)` index can't serve this (leading `channel` column not constrained).
2. Secret decrypt (AES-GCM) + HMAC-SHA256 verify (WebCrypto, constant-time compare).
3. Contact resolution (1-2 selects, optional INSERT for auto-create; optional default-workspace select).
4. `enrollContact` → **synchronous full `runLoop`** before the route returns its `202` (`automation-webhook-trigger.ts:21-35`).

## Per-request work

### Inbound DM that enrolls and runs a 4-node flow (message → action_group(tag_add) → delay), via queue consumer

In order:
1. SELECT social_accounts (processor :330)
2. SELECT/INSERT inbox_conversations (upsertConversation)
3. SELECT COUNT(*) inbox_messages ⋈ inbox_conversations — welcome pre-count (:384)
4. INSERT inbox_messages
5. (conditional) 1-2 Graph profile fetches + R2 put + 2 UPDATEs — enrichment
6. SELECT contacts (contact-linker match; up to 3 queries, or INSERT contact + channel)
7. SELECT automation_runs — waiting-input resume lookup (:836)
8. SELECT entrypoints ⋈ automations — candidates (matcher :299)
9. SELECT contacts (matcher hydration :330)
10. SELECT custom_field_values ⋈ definitions (:336)
11. SELECT automation_contact_controls — pause (:386)
12. Per finalist: 1-2 SELECT automation_runs — re-entry (:419, :437/:452)
13. SELECT automations (enrollContact :372)
14. SELECT contacts again (buildInitialRunContext :460)
15. SELECT custom_field_values again (:470)
16. INSERT automation_runs (:406)
17. UPDATE automations total_enrolled (:424)
18. — node 1 (message): SELECT run, SELECT controls, SELECT automations(graph); SELECT contact_channels⋈contacts, SELECT social_accounts, AES-GCM decrypt; N external send fetches (one per block, plus in-process sleeps for typing/delay blocks); INSERT step_run; UPDATE run
19. — node 2 (action_group/tag_add): SELECT run, SELECT controls, SELECT automations(graph); SELECT contacts, UPDATE contacts; internal `tag_applied` event → nested matchAndEnroll (≥4 more selects even with zero listeners); INSERT step_run; UPDATE run
20. — node 3 (delay): SELECT run, SELECT controls, SELECT automations(graph); INSERT step_run; UPDATE run (status=waiting); INSERT automation_scheduled_jobs
21. (back in processor) webhook dispatch + realtime notify

≈ **40-50 sequential DB round trips + 1-3 external fetches + 1-2 crypto ops** for one inbound DM, all serialized inside one queue-consumer message slot.

### Cron tick (every minute)
- 1 stale-reclaim UPDATE + 1 claim CTE-UPDATE; then per claimed job (≤50, sequential): full `runLoop` cost as above + 1 status UPDATE.

### Webhook trigger request
- 1 full-table-ish entrypoint scan + decrypt + HMAC + 2-4 contact selects + enrollment + **full synchronous runLoop** before the HTTP response.

### KV / R2 / Queue usage
- KV: none in the automation engine itself (API-key cache only on authed routes).
- R2: avatar rehost in the inbox processor (off automation core).
- Queues: INBOX_QUEUE is the only live queue feeding automations; AUTOMATION_QUEUE (`relayapi-automation`, batch 10/concurrency 5/DLQ) is deprecated — consumer just acks (`queues/automation.ts:18-29`) but the binding + consumer config remain in `wrangler.jsonc:117-120,170-176`.
- All wait/resume scheduling goes through the `automation_scheduled_jobs` Postgres table, not Cloudflare Queues.

## External calls

| Call | Where | Notes |
|---|---|---|
| Platform message sends (Meta Graph, WhatsApp Cloud, Telegram Bot API) | `platforms/index.ts:230` → `message-sender.ts:98` | One fetch per message block, sequential, awaited inside runLoop |
| Meta participant profile lookups | `inbox-event-processor.ts:147,225` | 5s timeout, up to 2 attempts (full then minimal field set) |
| `http_request` node | `nodes/http-request.ts` | Awaited, default 15s timeout, blocks the run loop |
| `webhook_out` action | `actions/webhook.ts` | Awaited fetch (errors swallowed), optional HMAC sign |
| `reply_to_comment` action | `actions/comment.ts` | Graph API POST |
| Outbound event webhooks | `inbox-event-processor.ts:583` (`dispatchWebhookEvent`) | After automation match, per event |

## Performance notes

1. **runLoop persistence floor is 5 sequential DB round trips per node** (`runner.ts:61,76,93,197,320`) — run re-read, pause check, full automation+graph re-read, step-run insert, optimistic run update. The graph JSONB is re-fetched per node (O(nodes × graph size) bytes). No batching of step-run inserts; full `context` JSONB rewritten on every advance.
2. **`enrollContact` + matcher double-hydrate the contact and custom fields** (`trigger-matcher.ts:330-355` then `runner.ts:460-485`) and hydration runs even when no entrypoint has filters.
3. **Re-entry guard is N+1** over finalists (`trigger-matcher.ts:414-468`) — could be one `inArray` query.
4. **Synchronous run execution on HTTP paths**: POST `/{id}/enroll` (`routes/automations.ts:961`) and the public webhook trigger (`webhook-receiver.ts:428`) block the response on the full graph walk, including external sends, 15s `http_request` timeouts, and literal `setTimeout` sleeps for typing/delay blocks.
5. **Webhook slug lookup is an unindexed platform-wide scan** with JS-side slug matching (`webhook-receiver.ts:319-337`).
6. **scheduled_trigger fan-out is unbounded and sequential in-process** (`scheduler.ts:343-365`; `enumerateContactsForScheduleFilter` has no LIMIT) — a schedule matching 10k contacts attempts 10k full enrollments in a single cron invocation.
7. **In-process sleeps** (`platforms/index.ts:182-198`) — `delay` blocks and typing indicators hold the queue-consumer invocation for arbitrary wall time; the batch (≤10 messages) is processed sequentially behind them (`queues/inbox.ts:13`).
8. **Hot-row counters on `automations`** — `total_enrolled` per enrollment (`runner.ts:424`) and `total_completed/failed` per terminal (`runner.ts:627`) rewrite the row that also carries the graph JSONB and a GIN index.
9. **Unused GIN index on `automations.graph`** (`schema.ts:2597`) — no JSONB-operator queries exist anywhere; pure write amplification on every graph save.
10. **Internal events always run the full matcher** (`internal-events.ts:55`) — every tag/field mutation in a flow costs ≥4 extra queries even with zero tag_applied/field_changed entrypoints in the org.
11. **Welcome pre-count uses COUNT(*)** over the contact's full message history per inbound DM (`inbox-event-processor.ts:384-406`); only `=== 0` is consumed — an EXISTS/LIMIT 1 suffices.
12. **Deprecated AUTOMATION_QUEUE** binding + consumer still deployed (`queues/automation.ts`, `wrangler.jsonc`) — dead config to remove.
13. Trigger matching itself is **not** a full-table scan per event: candidates are narrowed by `(channel, kind, status)` index + org filter via the join; per-kind config matching happens in JS over that candidate set.
