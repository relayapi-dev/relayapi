# Automation Rebuild — Plan 4: Integration Repair

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Spec:** `docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md`
**Plans 1+2+3:** complete (107 api + 197 app tests passing in isolation). But integration verification surfaced 9 confirmed bugs that prevent end-to-end execution.

**Goal:** Make the automation system actually work end-to-end. Wire boundary handoffs that fell into the cracks between Plans 1-3 units.

**Architecture:** No new architecture. Targeted fixes at integration boundaries.

**Git policy:** User handles git. Each task ends with `STOP — user commits at their discretion`.

---

## The 9 confirmed bugs (severity-ranked)

1. **CRITICAL:** `ctx.env.db` never populated — every DB-using node/action throws
2. **CRITICAL:** `input` node never advances — runs loop forever or stay parked
3. **CRITICAL:** Buttons / cards / quick replies / galleries flattened to text — no native interactivity sent
4. **CRITICAL:** Only `dm_received` + `comment_created` events ever produced — 13 of 16 entrypoint kinds inert
5. **CRITICAL:** Schema config keys ≠ matcher config keys (`keyword_filter` vs `keywords`, etc.) — entrypoint filters silently no-op
6. **HIGH (Secondary):** Contact / tags / fields not hydrated into `run.context` — merge tags blank, predicates over contact state evaluate as null
7. **MEDIUM-HIGH:** Webhook custom_field lookup uses `findFirst` without value filter — wrong contact resolved
8. **MEDIUM:** Simulator port keys don't match runtime port keys (`yes`/`no` vs `true`/`false`, `branches` vs `variants`)
9. **MEDIUM:** `welcome_message` binding fires on comments + story replies (spec: DMs only)

---

## Task List (ordered by criticality + dependencies)

### Phase R1 — Critical-path runtime fixes

- [ ] **Task 1: Wire `db` into env at every enrollContact / runLoop call site**

**Files to modify:**
- `apps/api/src/services/automations/runner.ts` — `enrollContact`, `runLoop`, scheduler entry
- `apps/api/src/services/inbox-event-processor.ts:550, 657` — both `matchAndEnrollOrBinding` and `runLoop` calls
- `apps/api/src/routes/automations.ts:839` and `apps/api/src/routes/automation-webhook-trigger.ts` — manual enroll, webhook enroll
- `apps/api/src/services/automations/scheduler.ts` — when scheduler resumes a run

**Approach:** every site that calls `enrollContact(db, args)` or `runLoop(db, runId, env)` must pass `env` augmented with the `db` handle. Two patterns to consider:

A) Mutate `env` to include `db`: `runLoop(db, runId, { ...env, db })`. Simple, slightly leaky.

B) Add `db` as a separate param: change `RunContext` to carry `db` natively rather than under `env.db`. Cleaner.

Pick **B**. Add `db: Db` as a top-level field on `RunContext`. Update `runner.ts`'s `RunContext` build site (line ~137) to set `db: db`. Update all handlers/actions to read `ctx.db` instead of `ctx.env.db`.

Concrete edits:
- `apps/api/src/services/automations/types.ts` — add `db: Db` to `RunContext` type. Import `Db` type from the existing project pattern (look at how `runner.ts` uses Db).
- `apps/api/src/services/automations/runner.ts:137` — set `db` on the constructed ctx.
- Grep for `ctx.env?.db` and `ctx.env.db` across `apps/api/src/services/automations/` and replace with `ctx.db`. Files to expect:
  - `nodes/message.ts:239`
  - `nodes/start-automation.ts:27`
  - `actions/{tag,field,segment,subscription,conversation,notify,automation-controls,contact,conversion,change-main-menu}.ts` (all action files)

**Test:** add an integration test that creates an automation with a tag_add action and verifies the tag is actually added in the DB. File: `apps/api/src/__tests__/automation-integration-actions.test.ts`.

- STOP

---

- [ ] **Task 2: Implement input wait/resume properly**

**Files:**
- `apps/api/src/services/automations/runner.ts` — add resume logic
- `apps/api/src/services/automations/nodes/input.ts` — add validation + port-resolution helpers
- `apps/api/src/services/inbox-event-processor.ts:643` — wire inbound message into runner's resume path

**Behavior** (per spec §8.6):

When an inbound message arrives on a conversation, find runs in `status='waiting' AND waiting_for='input'` for that contact. For each:

1. Read the run's `current_node_key` and the node's `config` (input type, validation, choices, retries, skip_allowed).
2. Validate the inbound text:
   - `text` — accept as-is, save to `ctx.context[config.field]`
   - `email` — validate via regex; if invalid, retry counter
   - `phone` — validate via regex
   - `number` — parse; on NaN, invalid
   - `choice` — match against `config.choices[*].match` (array of normalized strings); save the matched choice's value
   - `file` — accept if message has a media attachment
3. Determine port:
   - On valid → store value at `ctx.context[config.field]`, advance via `captured`
   - On invalid + retries available → re-prompt (re-emit the input node), increment retry counter in `ctx.context._input_retries[node.key]`
   - On invalid + retries exhausted → advance via `invalid`
   - Special phrase "skip" (case-insensitive) when `config.skip_allowed === true` → advance via `skip`
4. Find the edge `{from_node: current_node_key, from_port: <selected_port>}`. If found, set `current_node_key`/`current_port_key`, call `runLoop`. If not found, exit run with `completed`.
5. The `timeout` port is fired by the scheduler's `input_timeout` job (already implemented per spec §8.7); verify the scheduler resolves the right port and re-enters runLoop.

**Approach:**

Add `apps/api/src/services/automations/input-resume.ts` with:

```ts
export type InputResumeOutcome = {
  port: "captured" | "invalid" | "skip";
  capturedValue?: any;
  retryNext?: boolean;
};

export function resolveInputResume(
  inputConfig: InputConfig,
  inboundText: string,
  hasAttachment: boolean,
  retryCount: number
): InputResumeOutcome;

export async function resumeWaitingRunOnInput(
  db: Db,
  runId: string,
  inboundText: string,
  hasAttachment: boolean,
  env: Record<string, any>
): Promise<void>;
```

`resumeWaitingRunOnInput` does:
1. Loads the run + automation graph
2. Calls `resolveInputResume` against the current node's config
3. If `retryNext` is true, re-emits `wait_input` (no advance, increment `ctx.context._input_retries[node.key]`)
4. Otherwise updates run state: `current_node_key`/`current_port_key` to the next node via the chosen port, sets context.<field> to capturedValue, then calls `runLoop(db, runId, env)`

Then update `inbox-event-processor.ts` to:
- After matching inbound message to entrypoints (existing flow), ALSO check for waiting runs for the same contact: query `automation_runs WHERE contact_id = X AND conversation_id = Y AND status = 'waiting' AND waiting_for = 'input'`
- For each: call `resumeWaitingRunOnInput`
- This must happen BEFORE entrypoint matching to avoid double-firing (a reply to an in-flight flow shouldn't also enroll the contact in a new flow)

**Test:** `apps/api/src/__tests__/automation-input-resume.test.ts` — verifies email validation, retry exhaustion, skip path, captured path, timeout path. Use real DB.

Update `nodes/input.ts` to remove the misleading comment about Unit 4 — input handler stays as `wait_input`-only; resumption happens in the resume path.

- STOP

---

- [ ] **Task 3: Fix entrypoint config schema/matcher key drift**

**Files:**
- `apps/api/src/schemas/automation-entrypoints.ts` — schema definitions
- `apps/api/src/services/automations/trigger-matcher.ts` — config consumers
- `apps/api/src/services/automations/templates/{comment-to-dm,story-leads,follower-growth,follow-to-dm,faq-bot,welcome-flow,lead-capture}.ts` — template config emitters

**Approach:** the matcher reads `keywords`, `field_keys`, `tag_ids`, `ref_url_ids`, `event_names`. The schema validates `keyword_filter`, `field`, `tag`, `ref_url_id`, `event_name`.

**Decision: align both to the matcher's keys** (plural arrays are more flexible than single-value fields).

Schema changes:
- `KeywordEntrypointConfig` — already correct (`keywords`)
- `CommentCreatedEntrypointConfig` — rename `keyword_filter` → `keywords` (matcher already reads `config.keywords`)
- `StoryReplyEntrypointConfig` — rename `keyword_filter` → `keywords`
- `FieldChangedEntrypointConfig` — rename `field` → `field_keys` (array)
- `TagEntrypointConfig` — rename `tag` → `tag_ids` (array of tag IDs OR tag names — pick one; check matcher to see what it expects). Matcher reads `config.tag_ids` — confirm if it expects names or IDs by reading the eval logic.
- `RefLinkEntrypointConfig` — rename `ref_url_id` → `ref_url_ids` (array)
- `ConversionEventEntrypointConfig` — rename `event_name` → `event_names` (array)

Template fixes:
- `comment-to-dm.ts:67` — emit `keywords`, not `keyword_filter`
- `story-leads.ts:135` — emit `keywords`, not `keyword_filter`
- `follower-growth.ts` — same fix if applicable

**Test:** `apps/api/src/__tests__/automation-entrypoint-filters.test.ts` — for each entrypoint kind with a filter, create an entrypoint, fire a synthetic event that should/shouldn't match, assert correct behavior. Use real DB.

- STOP

---

- [ ] **Task 4: Hydrate contact + tags + fields into run context at enrollment**

**Files:**
- `apps/api/src/services/automations/trigger-matcher.ts:461`, `binding-router.ts:129,163`, `routes/automations.ts:839` (manual enroll), `webhook-receiver.ts` (webhook enroll), `scheduler.ts` (scheduled enroll)
- `apps/api/src/services/automations/runner.ts` — `enrollContact` must hydrate

**Approach:** centralize hydration in `enrollContact`. Add a helper:

```ts
async function buildRunContext(db: Db, contactId: string, organizationId: string, additionalOverrides: Record<string, any> = {}) {
  const contact = await db.query.contacts.findFirst({ where: ... });
  const tags = await db.query.contactTags.findMany({ where: ..., with: { tag: true } });
  const fieldRows = await db.query.customFieldValues.findMany({ where: ..., with: { definition: true } });
  return {
    contact: contact ? { id, first_name, last_name, email, phone, ... } : null,
    tags: tags.map(t => t.tag.name),
    fields: Object.fromEntries(fieldRows.map(r => [r.definition.key, r.value])),
    ...additionalOverrides,
  };
}
```

Call from `enrollContact` to seed `automation_runs.context` at row creation.

Also update `runLoop` to RE-hydrate on resume (in case tags/fields changed mid-flow). Actually, only hydrate on enroll for v1 — re-hydrate in v1.1 if needed. Otherwise we'd need a costly query per step.

**Test:** add to the existing integration test — assert `{{contact.first_name}}` resolves correctly in a sent message.

- STOP

---

### Phase R2 — Critical-path event surface

- [ ] **Task 5: Expand inbox-event-processor to emit all relevant event kinds**

**Files:**
- `apps/api/src/services/inbox-event-processor.ts` — `deriveInboundEventKind` and event payload builder
- `apps/api/src/routes/platform-webhooks.ts` (preserved) — verify what raw payload data is available per platform

**Approach:** the inbox processor currently maps `event.type === "comment"` → `comment_created`, `event.type === "message"` → `dm_received`, returns null for everything else. Expand to cover:

- Story replies — usually arrive as a special message with `is_story_reply` or similar metadata. Map to `story_reply`.
- Story mentions — Instagram mentions in stories. Map to `story_mention`.
- Follow events — `follow` webhook from Meta or TikTok. Map to `follow`.
- Live comments — `live_comment` webhook. Map to `live_comment`.
- Share-to-DM — Instagram-only event when a user shares a post to a DM. Map to `share_to_dm`.
- Ad click — when a user opens a CTM ad. Map to `ad_click`.
- Ref link click — internal trigger when a tracked ref URL is clicked. Map to `ref_link_click`.
- Tag applied / removed — fired by the action_group's `tag_add`/`tag_remove` action handlers OR by manual tagging in the inbox (instrument the tag mutation paths).
- Field changed — fired by `field_set` / `field_clear` action OR by manual field editing.
- Conversion event — fired by `log_conversion_event` action OR by external API.

**Strategy:** for v1, focus on the platform-driven events (`story_reply`, `story_mention`, `follow`, `live_comment`, `share_to_dm`, `ad_click`). The internal events (`tag_*`, `field_*`, `conversion_event`, `ref_link_click`) require an event bus from the action handlers — add a small `emitInternalEvent(kind, payload)` helper that the action handlers call after mutating contact state, which routes through `matchAndEnroll` synchronously.

`platform-webhooks.ts` already handles raw HMAC verification + INBOX_QUEUE/AUTOMATION_QUEUE dispatch; check what raw payload fields it exposes for each platform. If a field needed for `story_reply` / `share_to_dm` isn't currently in the inbox event payload, extend the inbox event type and pass it through.

**Test:** unit tests with synthetic payload variants for each new event kind. `apps/api/src/__tests__/automation-event-kinds.test.ts`.

- STOP

---

- [ ] **Task 6: Implement scheduled_trigger dispatch**

**Files:**
- `apps/api/src/services/automations/scheduler.ts:205` — replace the no-op
- `apps/api/src/services/automations/trigger-matcher.ts` — may need a "synthetic event for scheduled enrollment" path

**Approach:** when a scheduled job with `job_type = "scheduled_trigger"` fires:

1. Load the entrypoint by `entrypoint_id`. Verify it's `kind: "schedule"` and `status: "active"`.
2. Determine the contact set to enroll. The entrypoint's `filters` JSONB defines which contacts qualify (e.g., "all contacts tagged 'newsletter'"). Use `filter-eval.ts` to evaluate against each candidate.
3. Enumerate matching contacts. Strategy:
   - If `filters` references tags → query contacts with those tags
   - If `filters` references segments → query contact_segment_memberships
   - If no filter → ENTIRE org's contacts (probably too aggressive — for v1, REQUIRE a filter for `schedule` entrypoints; reject publish if filters is null)
4. For each contact, call `enrollContact` with a synthetic event payload `{ kind: "schedule", contactId, scheduledAt: now }`.
5. Reschedule the job for the next cron iteration (parse `entrypoint.config.cron`, compute next run time, INSERT a new `automation_scheduled_jobs` row with `job_type = "scheduled_trigger"`).

For cron parsing: use a small library or a minimal helper that supports the most common patterns (`0 9 * * *` → daily at 9am UTC, etc.). If no library is installed, write a minimal parser for the most common patterns and TODO more advanced ones.

**Test:** `apps/api/src/__tests__/automation-scheduler-trigger.test.ts` — insert a scheduled entrypoint matching specific tags, fire the scheduler, assert correct contacts enrolled + next job inserted.

- STOP

---

### Phase R3 — Native interactive messages (channel-by-channel)

- [ ] **Task 7: Extend SendMessageRequest + dispatcher to carry native interactive payloads**

**Files:**
- `apps/api/src/services/message-sender.ts` — extend `SendMessageRequest` with native button / quick_reply / attachment / card / gallery fields
- Per-platform send functions inside `message-sender.ts` (`sendInstagramDM`, `sendFacebookMessage`, `sendWhatsApp`, `sendTelegram`, `sendTwitterDM`, `sendRedditMessage`) — encode the new fields into each platform's API payload
- `apps/api/src/services/automations/platforms/index.ts` — stop flattening; pass structured fields through

**Approach:** the new request shape:

```ts
export interface SendMessageRequest {
  platform: string;
  accessToken: string;
  platformAccountId: string;
  recipientId: string;
  text?: string;
  // Net new:
  attachments?: Array<{ type: "image" | "video" | "audio" | "file"; url: string; caption?: string }>;
  buttons?: Array<{ id: string; type: "branch" | "url" | "call" | "share"; label: string; url?: string; phone?: string }>;
  quick_replies?: Array<{ id: string; label: string; icon?: string }>;
  card?: { image_url?: string; title: string; subtitle?: string; buttons?: Button[] };
  gallery?: Array<{ image_url?: string; title: string; subtitle?: string; buttons?: Button[] }>;
  templateName?: string;
  templateLanguage?: string;
  templateComponents?: any;
}
```

Per-platform encoding (reference: existing platform-webhooks.ts and per-platform routes for API shape patterns):

- **Instagram (Graph API):** buttons → `attachment.type=template, payload.template_type=button`, gallery → `template_type=generic`, quick_replies → `quick_replies[]`. Documented at https://developers.facebook.com/docs/messenger-platform/instagram/features/quick-replies (Meta docs are referenced in CLAUDE.md OAuth rules)
- **Facebook Messenger:** same as Instagram (shared template payload format)
- **WhatsApp:** buttons → `interactive.type=button`, quick_replies not supported (skip), gallery not supported (skip), templates use existing `templateName`/`templateComponents`
- **Telegram:** buttons → `reply_markup.inline_keyboard`, quick_replies → `reply_markup.keyboard`
- **TikTok DM:** very limited; just send text. Buttons/quick_replies silently skipped.

For URLs and media, current `attachments` flow may need new payload fields per platform.

**Important:** check the existing `apps/api/src/routes/whatsapp.ts` and similar inbox-reply paths — if they already handle interactive payloads, reuse the encoding logic. If not, this is a substantial change touching real platform APIs.

**Adapter side** (`apps/api/src/services/automations/platforms/index.ts`):
- Drop the text-flattening in card/gallery handling
- Build a single `SendMessageRequest` per message node call, populated with `attachments[]`, `card`, `gallery`, `buttons`, `quick_replies` from the rendered blocks
- Pass to `sendMessage` once (the current code calls send N times for N blocks — refactor to send once per node with the composite shape, OR keep per-block sends but pass interactive fields on the LAST block)

**Test:** `apps/api/src/__tests__/automation-platform-encoding.test.ts` — for each platform, given a message with a button, assert the encoded API payload matches the expected platform-specific shape. Mock `fetch` so the test doesn't hit real APIs.

This is the largest task in the plan. Estimated 4-6 hours of focused work.

- STOP

---

### Phase R4 — Bug cleanup

- [ ] **Task 8: Tighten webhook custom_field contact lookup**

**Files:**
- `apps/api/src/services/automations/webhook-receiver.ts:248-266`

**Approach:** the current code does `findFirst` over all rows for the definition, then compares to the incoming value. Should filter by value in SQL.

For string values (the common case):
```ts
const fv = await db.query.customFieldValues.findFirst({
  where: and(
    eq(customFieldValues.organizationId, organizationId),
    eq(customFieldValues.definitionId, def.id),
    sql`${customFieldValues.value}::text = ${typeof value === "string" ? `"${value}"` : JSON.stringify(value)}`,
  ),
});
```

For non-string values, JSONB equality may need `=` operator with proper casting. Read the existing `custom_field_values.value` column type — if it's JSONB, use `value @> $val`. If it's text, use direct equality.

If multiple contacts could match, return null (ambiguous lookup) or pick the most-recently-updated. Document the choice.

**Test:** add to `apps/api/src/__tests__/automation-webhook-trigger.test.ts` — create 3 contacts with different values for the same field; verify the webhook resolves the correct one.

- STOP

---

- [ ] **Task 9: Align simulator port keys with runtime**

**Files:**
- `apps/api/src/services/automations/simulator.ts:194, 227`

**Approach:** literal find-and-replace:
- Line 194: `exitPort: ok ? "yes" : "no"` → `exitPort: ok ? "true" : "false"`
- Line 227: `cfg.branches` → `cfg.variants` (and adjust the variant exit port to `variant.${chosen.key}` not just the key alone)

Also walk `simulator.ts` for other port-key string mismatches by comparing against the runtime handlers + `derivePorts`. For each node kind, the simulator must use the same port keys.

**Test:** add tests that simulate a graph and verify the chosen edges match what the runtime would pick.

- STOP

---

- [ ] **Task 10: Constrain welcome_message binding to dm_received only**

**Files:**
- `apps/api/src/services/automations/binding-router.ts:99-103`

**Approach:** change:
```ts
const isInboundMessage =
    event.kind === "dm_received" ||
    event.kind === "comment_created" ||
    event.kind === "story_reply";
```
to:
```ts
const isInboundMessage = event.kind === "dm_received";
```

Per spec §6.6 step 8.

**Test:** existing or new — verify a `comment_created` event doesn't fire `welcome_message` binding.

- STOP

---

### Phase R5 — Real integration tests

- [ ] **Task 11: Add real end-to-end integration tests**

**File:**
- `apps/api/src/__tests__/automation-e2e-integration.test.ts` (new — distinct from existing `automation-e2e.test.ts` which is unit-mocked)

**Scenarios** (each requires real DB via tunnel; mock platform send via `ctx.env.sendTransport`):

1. **Lead capture flow:** create flow `message → input(email) → action_group [tag_add, field_set] → message → end`. Enroll a contact. Simulate inbox reply with valid email. Assert: tag added, field set, second message sent, run completed.
2. **Keyword DM trigger:** create automation with `dm_received` entrypoint + keyword filter `["pizza"]`. Send a synthetic inbox event with text "pizza". Assert: contact enrolled, message sent.
3. **Comment-to-DM flow:** create the comment_to_dm template. Send a synthetic comment event. Assert: action_group fires (public reply queued or whatever it does), DM sent, run advances or completes.
4. **Welcome message binding:** new contact's first DM. Assert: welcome flow triggered, NOT default reply.
5. **Webhook entrypoint:** create webhook_inbound entrypoint, POST a signed payload, verify HMAC validation, contact lookup by email, run created with payload mapped into context.
6. **Scheduled trigger:** create schedule entrypoint with cron + tag filter. Insert a scheduled job at past time. Run scheduler. Assert: matching contacts enrolled.
7. **Branch resolution:** create flow with condition node where predicate evaluates `{{contact.tags}}` contains "premium". Run with one contact tagged premium and one not. Assert different paths taken.
8. **Per-action error handling:** create action_group with one `webhook_out` action that 500s with `on_error: "continue"`, followed by `tag_add`. Run. Assert: tag added, run advances via `next` (not `error`).

These tests will FAIL until Tasks 1-10 are done. Run them as a regression suite at the end.

- STOP

---

- [ ] **Task 12: Final verification + report**

Run:
- `bun run typecheck` — clean
- `bun test apps/api/src/__tests__/automation-*` — all green including new integration tests
- `bun test apps/app/src/` — still 197+ green
- `cd packages/sdk && bun run build` — clean

Update `apps/app/TESTING_AUTOMATIONS.md` to remove any "known broken" notes for these issues.

Update `docs/superpowers/AUTOMATION_REBUILD_COMPLETION_REPORT_2026-04-21.md` (or write a new one for 2026-04-22) noting the integration repair completion + which integration tests now pass.

- STOP

---

## Self-Review

Spec coverage: §6.6 (welcome binding), §8.6 (input wait/resume), §8.7 (scheduler), §6.1 (entrypoint kinds wire-up), §11 (interactive messages). All addressed.

No TBDs.

Type consistency: `RunContext.db` added; matcher config keys aligned to `keywords`/`field_keys`/`tag_ids`/`ref_url_ids`/`event_names`; SendMessageRequest extended with native interactive fields.

---

## Execution

Execute via subagent-driven-development. Critical-path tasks (1-5) MUST land before others — dependent flows.

Suggested unit grouping:
- **Unit RR1:** Tasks 1 + 4 (db wiring + context hydration — both touch runner/enrollContact)
- **Unit RR2:** Tasks 2 + 9 + 10 (input resume + simulator alignment + welcome scope — all in services/automations)
- **Unit RR3:** Task 3 + Task 8 (config key drift + webhook lookup — both schema-touching)
- **Unit RR4:** Task 5 + Task 6 (event surface expansion + scheduled trigger — both event-emission)
- **Unit RR5:** Task 7 (interactive payloads — biggest, channel-by-channel)
- **Unit RR6:** Task 11 + Task 12 (integration tests + final verification)
