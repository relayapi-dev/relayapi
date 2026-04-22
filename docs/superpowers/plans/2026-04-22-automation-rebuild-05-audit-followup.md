# Automation Rebuild — Plan 5: Audit Follow-up

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Spec:** `docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md`
**Plans 1+2+3+4:** complete. Independent audit on 2026-04-22 surfaced 13 new issues + 1 Plan 4 fix that didn't survive (welcome ordering bug masked by test setup).

**Goal:** close the 13 audit findings + add the missing test coverage that allowed two critical bugs to slip through.

**Critical theme:** the existing e2e tests bypass `processInboxEvent`. The most important new test added in this plan is one that drives the full inbox-event-processor pipeline.

**Git policy:** User handles git. Each task ends with `STOP — user commits at their discretion`.

---

## The 13 audit findings (per /superpowers/specs)

### CRITICAL

- **B1:** Interactive `message`-node buttons / quick replies never resume the run. `resumeWaitingRunOnInput` short-circuits with `if (node.kind !== "input") return "race"`. The `button.<id>` / `quick_reply.<id>` ports are dead in production.
- **B2:** `welcome_message` binding never fires. `processInboxEvent` inserts the inbox message BEFORE `dispatchAutomationMatch`, so `isFirstInboundOnChannel` always sees ≥1 prior row. Welcome scope check (correct in `binding-router.ts`) is defeated by call ordering.

### HIGH

- **B3:** `keyword` entrypoint kind is in the catalog + schema but the matcher only reads event kind. `deriveInboundEventKind` never emits `"keyword"`. Operators creating `kind: "keyword"` entrypoints get nothing. Workaround exists (`dm_received` + `keywords` config) but the catalog misleads.
- **B4:** `scheduled_trigger` doesn't reschedule on failure. Next-job insert only on success branch. Transient DB error during contact enumeration permanently kills the schedule.

### MEDIUM

- **B5:** `tag_add` emits `tag_applied` even when the tag is already present. Same for `field_set` when value unchanged. Causes spurious downstream enrollments.
- **B6:** `webhook_out` action with `auth.mode = "hmac"` and missing `secret` silently sends unsigned.
- **B7:** Webhook `platform_id` contact lookup lacks org scope — potential cross-tenant contact resolution.
- **B8:** `start_automation` node and manual `/enroll` route enroll into paused/archived target automations.
- **B9:** `follow-to-dm` template emits `max_sends_per_day` / `cooldown_between_sends_ms` / `skip_if_already_messaged` that the matcher never reads — operator UX trap.
- **B10:** `change_main_menu` action throws unconditionally but is in the catalog + validator-accepted. Derails any action_group that wires it.

### LOW

- **B11:** `_input_retries` counter never cleaned up after captured/invalid/skip — unbounded growth across input nodes in long flows.
- **B12:** Simulator `action_group` ignores `forced` port choice — always returns `next`.
- **B13:** Stubbed bindings (`conversation_starter`, `main_menu`, `ice_breaker`) accepted by API and stored but silently no-op at runtime. Catalog admits "stubbed" but no runtime warning.

### Documentation

- **D1:** `apps/app/TESTING_AUTOMATIONS.md` references a `keyword_dm` template that doesn't exist in `templates/index.ts`.

---

## Task List

### Phase R5 — Critical interactive + welcome fixes

- [ ] **Task 1: Fix B1 — interactive button / quick-reply resume**

**Files:**
- `apps/api/src/services/automations/input-resume.ts` (or new sibling `interactive-resume.ts`)
- `apps/api/src/services/inbox-event-processor.ts`
- `apps/api/src/services/automations/nodes/message.ts` (verify wait_input return on interactive blocks)

**Behavior:** when a message arrives that's a button/quick-reply tap (typically carrying a `payload` or `interactive_payload`), find waiting runs whose `current_node_key` is a `message` node and resolve the matching port:

1. In `inbox-event-processor.ts`, when a normalized inbox event has an `interactive_payload` field (button postback / quick reply title / WhatsApp interactive button reply / Telegram callback_query data), BEFORE the normal text-input resume path:
   - Find waiting runs for the contact + conversation
   - For each waiting run with `current_node_key` matching a `message` node:
     - Look at the message node's `ports` for a `button.<payload>` or `quick_reply.<payload>` matching the interactive payload
     - If found, advance the run via that port (set `current_node_key` / `current_port_key` to the destination of the edge from that port, set status active, then call `runLoop`)
     - If not found, fall through to text-input resume (treat as plain text)

2. Add a new helper:
```ts
// apps/api/src/services/automations/interactive-resume.ts
export async function resumeWaitingRunOnInteractive(
  db: Database,
  runId: string,
  interactivePayload: string,
  env: Record<string, any>,
): Promise<"resumed" | "no_match" | "race">;
```

3. Update `inbox-event-processor.ts` so the resumption flow tries:
   - Interactive resume FIRST if event has `interactive_payload`
   - Input resume next if event has text
   - Entrypoint matching last if neither resumed

**Important — extracting the interactive_payload:** check what `processInboxEvent` already exposes per platform:
- Meta IG/FB: `message.quick_reply.payload` for quick replies; `messaging[].postback.payload` for button postbacks
- WhatsApp: `interactive.button_reply.id` or `interactive.list_reply.id`
- Telegram: `callback_query.data`
- TikTok: not applicable

`platform-webhooks.ts` (preserved) may need to forward these fields; if it doesn't, extend the normalized event shape.

**Tests:**
- New: `apps/api/src/__tests__/automation-interactive-resume.test.ts` — for each platform, simulate a button/quick_reply tap event, assert run advances via correct port to the right next node
- Add to `automation-e2e-integration.test.ts`: scenario with a message that has 2 buttons (`button.yes`, `button.no`) → simulate `interactive_payload: "yes"` → assert run advances to the yes branch's destination

- STOP

---

- [ ] **Task 2: Fix B2 — welcome_message ordering bug**

**File:**
- `apps/api/src/services/inbox-event-processor.ts` — capture `is_conversation_start` BEFORE inserting the message
- `apps/api/src/services/automations/binding-router.ts` — accept `isConversationStart` as event metadata; trust it over the inbox_messages query

**Approach:**

Currently `processInboxEvent`:
1. Inserts message via `insertMessage` (line ~318)
2. Calls `dispatchAutomationMatch` (line ~448)

`binding-router.isFirstInboundOnChannel` (lines 36-52) queries `inbox_messages` and counts. After insert, count is ≥1.

Fix:
1. In `processInboxEvent`, capture the conversation's existing message count BEFORE the insert (the upsert function likely returns this; check the insertMessage return value).
2. Pass `isFirstInboundOnChannel: boolean` as a field on the `InboundEvent` (extend the type in `trigger-matcher.ts`).
3. In `binding-router.ts`, change `isFirstInboundOnChannel` to:
   ```ts
   if (typeof event.isFirstInboundOnChannel === "boolean") return event.isFirstInboundOnChannel;
   // fallback to DB query (for callers like manual enroll that don't set the flag)
   ```

This way:
- Production path: `processInboxEvent` sets the flag correctly based on pre-insert count.
- Tests calling `matchAndEnrollOrBinding` directly: still work via the fallback DB query.

**Tests:**
- Update `automation-e2e-integration.test.ts:706-829`: add a test that goes through `processInboxEvent` (not directly through `matchAndEnrollOrBinding`) — produce a synthetic queue payload, dispatch it, assert welcome fires on first inbound and NOT on second.
- This test would have caught B2 originally.

- STOP

---

- [ ] **Task 3: Add full processInboxEvent integration test**

**File:** `apps/api/src/__tests__/automation-inbox-pipeline.test.ts` (new)

This is the test gap that allowed B1 and B2 to slip through. Drive the FULL pipeline:

1. Seed organization, social account, contact, conversation
2. Create automation + entrypoint + welcome binding
3. Construct a synthetic inbox queue message (matching what `platform-webhooks.ts` enqueues)
4. Call `processInboxEvent` directly (the queue consumer entry point)
5. Verify:
   - `inbox_messages` row inserted
   - `automation_runs` row created
   - Welcome fired on first inbound, NOT on second
   - Button postback advances waiting run via correct port
   - Text reply to an input node captures correctly

Multiple sub-tests covering each scenario.

If `processInboxEvent` requires Cloudflare-specific bindings (queues, KV, R2), mock them minimally in a test fixture file `apps/api/src/__tests__/fixtures/cf-bindings.ts`.

- STOP

---

### Phase R6 — Catalog cleanup + scheduled trigger reliability

- [ ] **Task 4: Fix B3 — remove dead `keyword` entrypoint kind**

**Files:**
- `apps/api/src/routes/_automation-catalog.ts` — remove `keyword` from ENTRYPOINT_KINDS
- `apps/api/src/schemas/automation-entrypoints.ts` — remove from `EntrypointKindSchema` enum and `EntrypointConfigByKind` registry
- `apps/api/src/services/automations/trigger-matcher.ts` — remove the dead `case "keyword":` branch if any
- `apps/app/src/components/dashboard/automation/flow-builder/entrypoint-panel.tsx` — confirm UI doesn't offer it (drop if it does)
- Documentation: `apps/docs/content/docs/guides/automations/triggers.mdx` — remove keyword as a kind, document the `dm_received` + `keywords` config workflow as the canonical pattern

**Test:**
- Existing tests that create a keyword entrypoint → migrate to use `dm_received` + `keywords` config, OR delete if redundant
- Add: attempting to POST `/automation-entrypoints` with `kind: "keyword"` → 422 schema error

- STOP

---

- [ ] **Task 5: Fix B4 — scheduled_trigger reschedule on failure**

**File:** `apps/api/src/services/automations/scheduler.ts:280-360` (around `scheduled_trigger` dispatch)

Currently the next-job insert is on the success path only. Change to:
1. Compute next run time + INSERT next job FIRST (before doing any enrollment work)
2. Then run the enrollment loop
3. If enrollment loop throws, the next job is already queued — schedule continues

OR:
1. Use a try/finally so the next-job insert always runs

Pick the cleaner approach. Verify the next-job insert is idempotent on retry (the same scheduled_trigger job firing twice shouldn't queue two next-runs).

**Test:**
- `automation-scheduled-trigger.test.ts`: add a test where contact enumeration is mocked to throw → assert the job is marked failed BUT the next scheduled job is queued anyway.

- STOP

---

### Phase R7 — Quick-win bug fixes (B5-B13)

- [ ] **Task 6: B5 — skip internal event emission on no-op tag/field changes**

**Files:**
- `apps/api/src/services/automations/actions/tag.ts:55-95` — check if tag is already present (or absent) before emitting
- `apps/api/src/services/automations/actions/field.ts:90-150` — check if value is already === before emitting

For `tag_add`: only emit `tag_applied` if `existing.tags` did NOT include the tag.
For `tag_remove`: only emit `tag_removed` if `existing.tags` DID include the tag.
For `field_set`: only emit `field_changed` if `existing.value !== new value`.
For `field_clear`: only emit if `existing.value !== null/undefined`.

**Test:** add a regression test: tag a contact with "lead", create flow listening for `tag_applied: ["lead"]`, run `tag_add "lead"` again → assert no new run for the listener flow.

- STOP

---

- [ ] **Task 7: B6 — webhook_out HMAC requires secret**

**File:** `apps/api/src/services/automations/actions/webhook.ts:60-80`

Change:
```ts
if (auth.mode === "hmac" && auth.secret) { /* sign */ }
```
to:
```ts
if (auth.mode === "hmac") {
  if (!auth.secret) throw new Error("webhook_out: hmac auth requires secret");
  /* sign */
}
```

Throwing makes the action obey its `on_error` setting (abort defaults to error port; continue logs and proceeds).

**Test:** unit test — webhook_out with `mode:hmac, secret:undefined` throws.

- STOP

---

- [ ] **Task 8: B7 — webhook_receiver platform_id lookup org scope**

**File:** `apps/api/src/services/automations/webhook-receiver.ts:225-240`

Current: looks up `contact_channels` by identifier without joining to `contacts.organizationId`.

Fix: inner-join `contacts` and add `eq(contacts.organizationId, organizationId)`.

```ts
const cc = await db
  .select({ contactId: contactChannels.contactId })
  .from(contactChannels)
  .innerJoin(contacts, eq(contactChannels.contactId, contacts.id))
  .where(and(
    eq(contactChannels.identifier, value as string),
    eq(contacts.organizationId, organizationId),
  ))
  .limit(1);
return cc[0]?.contactId ?? null;
```

**Test:** seed two orgs, both with a contact whose platform_id = "abc123" — webhook for org A's entrypoint must resolve org A's contact only.

- STOP

---

- [ ] **Task 9: B8 — status check in start_automation + manual enroll**

**Files:**
- `apps/api/src/services/automations/nodes/start-automation.ts`
- `apps/api/src/routes/automations.ts` (`/enroll` route)

Before calling `enrollContact`, load the target automation and verify `status === "active"`. If not:
- `start_automation` node: return `{ result: "fail", error: "target automation not active" }` so the action_group's `on_error` controls behavior
- `/enroll` route: return 422 `{ error: { code: "automation_not_active", message: "Cannot enroll into a non-active automation" } }`

**Tests:**
- `start_automation` with paused target → run exits via error port (or fail status)
- `/enroll` with paused target → 422 response

- STOP

---

- [ ] **Task 10: B9 — clean up follow-to-dm template config**

**File:** `apps/api/src/services/automations/templates/follow-to-dm.ts`

The template emits `max_sends_per_day`, `cooldown_between_sends_ms`, `skip_if_already_messaged` on the entrypoint config — these are NEVER read by the matcher.

Fix options (pick one):
- **(a)** Remove these fields from the emitted entrypoint config. They become operator-facing UX-only inputs that don't affect anything.
- **(b)** Implement them in the matcher: rate-limit per (automation_id, social_account_id) per day; cooldown between enrollments; check `inbox_messages` for prior outbound to decide skip.

Option (a) is the smaller fix. Pick (a). Document the unused inputs as "TODO v1.1: rate limiting" in the template.

**Test:** updated template test asserts emitted entrypoint config has only the keys the matcher reads.

- STOP

---

- [ ] **Task 11: B10 — block change_main_menu in validator**

**File:** `apps/api/src/services/automations/validator.ts`

When validating an `action_group` node's `actions[]`, if any action has `type: "change_main_menu"`, add a validation error:
```ts
{
  node_key: <node>,
  code: "action_unavailable",
  message: 'Action "change_main_menu" requires v1.1 platform sync — not yet available'
}
```

This makes the action_group invalid → automation auto-pauses → operator sees a clear error. Better than a runtime exception.

Also update the catalog: mark `change_main_menu` as `disabled: true` (extend the action catalog entry shape) so the dashboard greys it out in the action picker.

**Test:** `validateGraph` with a `change_main_menu` action returns the error.

- STOP

---

- [ ] **Task 12: B11 — clean up `_input_retries` counter**

**File:** `apps/api/src/services/automations/input-resume.ts:226-260`

After a captured/invalid/skip resolution, delete the entry for the just-processed node:
```ts
const updatedRetries = { ...retryMap };
delete updatedRetries[node.key];
updatedContext._input_retries = Object.keys(updatedRetries).length > 0 ? updatedRetries : undefined;
```

(If empty, remove the key entirely — keeps context clean.)

**Test:** existing input-resume test asserts `_input_retries[node.key]` is undefined after captured.

- STOP

---

- [ ] **Task 13: B12 — simulator action_group respects `forced` choice**

**File:** `apps/api/src/services/automations/simulator.ts:283-291`

Currently always returns `next`. If `branchChoices[node.key]` is set and equals `"error"`, return `error` instead.

**Test:** simulator test asserts `branch_choices: { [actionGroupKey]: "error" }` exits via `error`.

- STOP

---

- [ ] **Task 14: B13 — surface stubbed binding warnings**

**File:** `apps/api/src/routes/automation-bindings.ts`

When creating a binding with `binding_type` in `["conversation_starter", "main_menu", "ice_breaker"]`, set `status: "pending_sync"` (already done) AND include in the response a `warnings: [{ code: "binding_pending_sync", message: "..." }]` field so the dashboard can show a banner.

Already partially done — just confirm the response includes the warning. If not, add it.

**Test:** integration test creating a stubbed binding asserts `status === "pending_sync"` and the warning is in the response.

- STOP

---

- [ ] **Task 15: D1 — fix TESTING_AUTOMATIONS.md typo**

**File:** `apps/app/TESTING_AUTOMATIONS.md`

Find the `keyword_dm` reference and replace with the correct template name (likely `comment_to_dm` or one of the actual templates from `templates/index.ts`). Verify all template names mentioned in the doc match the actual registry.

- STOP

---

### Phase R8 — Final verification

- [ ] **Task 16: Final verification + completion report**

Run:
1. `bun run typecheck` — clean
2. `cd packages/sdk && bun run build` — clean
3. `bun test apps/api/src/__tests__/automation-*` — all green (198+ from Plan 4 + new tests)
4. `bun test apps/app/src/` — still 178 (or 197 if path-alias issue resolved)
5. Write `docs/superpowers/AUTOMATION_REBUILD_AUDIT_FOLLOWUP_REPORT_2026-04-22.md`:
   - Per-issue (B1-B13 + D1) status
   - New test counts
   - Remaining concerns

- STOP

---

## Self-Review

Spec coverage: B1-B13 mapped 1:1 to Tasks 1-14, plus D1 (Task 15) and verification (Task 16). The new processInboxEvent integration test (Task 3) addresses the test-gap meta-issue.

No TBDs.

Type consistency: `InboundEvent` extended with `isFirstInboundOnChannel?: boolean` (Task 2) and `interactive_payload?: string` (Task 1). Both optional, backward-compatible.

---

## Execution

Suggested unit grouping:
- **Unit RR7:** Tasks 1 + 2 + 3 (interactive resume + welcome ordering + processInboxEvent test — all touch event pipeline)
- **Unit RR8:** Tasks 4 + 5 + 11 + 13 + 15 (catalog cleanup + scheduler reschedule + validator block + simulator forced + doc fix)
- **Unit RR9:** Tasks 6 + 7 + 8 + 9 + 10 + 12 + 14 + 16 (no-op skip + hmac required + org scope + status check + template config + retry cleanup + binding warnings + final verification)
