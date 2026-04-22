# Automation Rebuild — Plan 6: Audit Round 3 Follow-up

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Context:** Third round of independent auditing surfaced 8 more confirmed bugs after Plan 5. 30 total post-initial-build bugs across 3 audit rounds. Pattern: unit tests pass, integration paths break.

**Goal:** close the 8 findings + add a "day in the life" end-to-end test that exercises realistic multi-step flow lifecycle — the meta-test that would have caught most of the gap.

**Git policy:** User handles git. Each task ends with `STOP — user commits at their discretion`.

## The 8 findings (severity-ranked)

### CRITICAL

- **F1:** Schedule entrypoints don't self-arm. Create/update only persists the row; no initial `scheduled_trigger` job inserted. New schedules never fire.
- **F2:** Account-scoped runs don't pin `socialAccountId`. Matcher/binding/webhook pass raw env; `ctx.env.socialAccountId` is undefined in production. Multi-account workspaces reply via the wrong account.
- **F5:** TikTok is vaporware. Catalog advertises tiktok for DMs + bindings, but no webhook route, no event normalizer, `sendTikTokDM` is a success-returning no-op.

### HIGH

- **F6:** Run context stale after in-flow tag/field mutations. Actions update DB but don't patch `run.context.tags` / `run.context.fields`. Same-run "tag_add A → condition on A" branches wrong.
- **F8:** Dashboard autosave treats 422 as hard failure. API returns 422 with canonical graph + validation + (possibly paused) status; client ignores body, throws error.

### MEDIUM

- **F3:** `webhook_inbound.auto_create_contact` is dead. Schema exposes it but `default_workspace_id` is never injected; auto-create always returns null.
- **F4:** Schedule timezone ignored. `computeNextCronRun` is UTC-only; `config.timezone` is stored but never used.

### MED-LOW

- **F7:** File inputs lose attachment metadata. Resume collapses attachment to boolean; capture stores literal `"(file)"`. No mime/size validation, no payload persistence.

---

## Task List

### Phase R9 — CRITICAL path fixes

- [ ] **Task 1 (F1): Seed initial `scheduled_trigger` job on schedule-entrypoint activation**

**Files:**
- `apps/api/src/routes/automation-entrypoints.ts` — create + update handlers
- `apps/api/src/services/automations/scheduler.ts` — export a shared helper
- `apps/api/src/routes/automations.ts` — automation activate handler (`POST /automations/{id}/activate`)

**Behavior:** the first `scheduled_trigger` job for a schedule entrypoint must be inserted when:
1. A schedule entrypoint is CREATED with `status: "active"` AND the parent automation's `status === "active"`
2. A schedule entrypoint is UPDATED from `paused → active` (or via automation activation) AND parent active
3. An automation with schedule entrypoints transitions to `status: "active"`

**Approach:**

Export from `scheduler.ts`:
```ts
export async function armScheduleEntrypoint(
  db: Database,
  entrypointId: string,
): Promise<{ queued: boolean; runAt?: Date; reason?: string }>;
```

Behavior:
- Load entrypoint by id
- If kind !== "schedule" or status !== "active" → return `{ queued: false, reason: "not_active" }`
- Load automation → if status !== "active" → return `{ queued: false, reason: "automation_not_active" }`
- Compute `nextRun = computeNextCronRun(cfg.cron, new Date(), cfg.timezone)` (timezone fix comes in Task 4)
- Call `insertNextScheduledJobIfNotExists(db, entrypointId, nextRun)` (existing helper)
- Return `{ queued: true, runAt: nextRun }`

Wire into:
- `routes/automation-entrypoints.ts` create handler — after successful insert, if `kind === "schedule" && status === "active"`, call `armScheduleEntrypoint`
- Update handler — same check after update
- `routes/automations.ts` activate handler — after flipping automation status to active, find all schedule entrypoints on this automation and arm each

**Tests:**
- Add to `automation-scheduled-trigger.test.ts`: create a schedule entrypoint with an active automation → assert one pending `automation_scheduled_jobs` row exists
- Pause-then-resume the entrypoint → assert a new job exists (only if none already pending)
- Pause automation → activate schedule entrypoint → assert NO job (automation isn't active)
- Activate paused automation with 2 schedule entrypoints → assert 2 jobs queued

- STOP

---

- [ ] **Task 2 (F2): Pin `socialAccountId` into `env` at enrollment**

**Files:**
- `apps/api/src/services/automations/trigger-matcher.ts:490` — `enrollContact` call site
- `apps/api/src/services/automations/binding-router.ts:139, 182` — both binding-enroll call sites
- `apps/api/src/services/automations/webhook-receiver.ts:362` — webhook enroll
- `apps/api/src/services/automations/runner.ts` — `enrollContact` stores `socialAccountId` into `run.context` (or into env) so `runLoop` propagates it
- `apps/api/src/services/automations/nodes/message.ts:229` — confirm `ctx.env.socialAccountId` is the right read path
- `apps/api/src/services/inbox-event-processor.ts` — confirm `event.socialAccountId` is always populated

**Approach:**

Two options:
- **(A)** Add `socialAccountId` to `ctx.env` via enrollContact: `env: { ...args.env, socialAccountId: args.socialAccountId }`. Current `message.ts:229` reads `ctx.env.socialAccountId` already.
- **(B)** Store on `run.context._triggering_social_account_id` and have `message.ts` read from there.

Pick (A) — matches existing code shape. Implementation:

Update `enrollContact` signature to accept `socialAccountId: string | null` as a top-level arg. In the function body:
```ts
const env = {
  ...(args.env ?? {}),
  socialAccountId: args.socialAccountId ?? undefined,
};
```

Pass this env into `runLoop` when executing, AND also persist on `run.context._triggering_social_account_id` so subsequent `runLoop` resumes (via scheduler or input resume) can rebuild env:

```ts
const initialContext = {
  ...hydrated,
  _triggering_social_account_id: args.socialAccountId ?? null,
  ...contextOverrides,
};
```

Update `runLoop` to reconstruct env's `socialAccountId` from `run.context._triggering_social_account_id` when it's not already in env:
```ts
const effectiveEnv = {
  ...env,
  socialAccountId: env.socialAccountId ?? run.context?._triggering_social_account_id,
};
```

Update all 4 call sites of `enrollContact` to pass `socialAccountId: event.socialAccountId ?? null` (trigger-matcher, binding-router both sites, webhook-receiver, manual enroll via `routes/automations.ts`).

**Tests:**
- Add to `automation-inbox-pipeline.test.ts`: seed 2 IG accounts on same workspace, create automation with entrypoint scoped to account A, send inbound event for account A, assert the outbound message used account A's token (mock `sendMessage` and verify accessToken matches account A).

- STOP

---

- [ ] **Task 3 (F5): TikTok honesty — remove from catalog and runtime enum**

**Decision to lock: drop TikTok entirely from v1.** The infrastructure isn't there; leaving it in the catalog is operator deception. We can add it in v1.1 or v2 when we have real TikTok Business Messaging API integration.

**Files:**
- `apps/api/src/routes/_automation-catalog.ts` — remove "tiktok" from every channels array
- `apps/api/src/schemas/automations.ts` — remove from `AutomationChannelSchema` enum
- `apps/api/src/schemas/automation-entrypoints.ts` — remove from `EntrypointCreateSchema` channel enum
- `packages/db/src/schema.ts` — remove from `automationChannelEnum` IF we can (requires migration; check if any rows exist)
- `packages/db/drizzle/0034_drop_tiktok_channel.sql` — new migration to alter the enum (careful — Postgres enum alter is nontrivial; may need DROP TYPE + CREATE TYPE + ALTER COLUMN pattern)
- `apps/api/src/services/message-sender.ts:632` — remove `sendTikTokDM` or throw an explicit error if called
- `apps/api/src/services/automations/templates/follow-to-dm.ts` — remove tiktok from supported channels
- `apps/api/src/services/automations/platforms/index.ts` — remove tiktok capabilities entry
- `apps/api/src/services/inbox-event-processor.ts` — remove any tiktok branches (if present)
- `apps/docs/content/docs/guides/automations/*.mdx` — remove tiktok references
- `apps/app/src/**` — drop tiktok from any channel pickers

**Migration strategy for the enum (important):**
Postgres doesn't allow `ALTER TYPE automation_channel DROP VALUE`. Options:
- **(a)** Leave enum value in DB (no migration); just drop from TS enum and catalog so new rows can't be created with tiktok. Existing rows (if any) would fail to parse. For pre-launch, safe to just verify no rows exist and move on.
- **(b)** Full enum rename dance: create new enum, alter column, drop old enum. Heavy.

Go with (a). Since pre-launch, there won't be tiktok automation rows. Add a migration that RAISES if any automations.channel = 'tiktok' exist (safety check):
```sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM automations WHERE channel = 'tiktok') THEN
    RAISE EXCEPTION 'Cannot drop tiktok channel: % automation rows still use it', (SELECT count(*) FROM automations WHERE channel = 'tiktok');
  END IF;
END $$;
```

Migration `0034` as a guard only — no ALTER TYPE. TS enum drops tiktok at compile time.

**Tests:**
- Catalog test: assert no "tiktok" appears in any channels array
- Schema test: creating an entrypoint with `channel: "tiktok"` → Zod rejects

- STOP

---

### Phase R10 — HIGH path fixes

- [ ] **Task 4 (F4): Timezone-aware cron**

**Files:**
- `apps/api/src/services/automations/scheduler.ts:307, 500` — `computeNextCronRun` signature + usage

**Approach:**

Check if `date-fns-tz` or similar is installed (`bun pm ls date-fns-tz`). If not, install or use a manual offset approach.

Update `computeNextCronRun(cron: string, from: Date, timezone?: string): Date | null`:
- Default timezone to `"UTC"`
- If `date-fns-tz` available: convert `from` to the target timezone, do the cron arithmetic there, convert back to UTC for storage
- If not: support a static set of common IANA zones (America/New_York, Europe/London, etc.) with hand-computed DST-aware offsets — or require `date-fns-tz` as a dep

Simplest correct path: install `date-fns-tz` (small, well-maintained). Check cost of install.

Update the schedule entrypoint dispatcher (scheduler.ts:307) to pass `cfg.timezone` through:
```ts
const nextRun = cfg.cron ? computeNextCronRun(cfg.cron, new Date(), cfg.timezone) : null;
```

**Tests:**
- Unit test: `computeNextCronRun("0 9 * * *", new Date("2026-04-22T12:00:00Z"), "America/New_York")` → expect next 13:00 UTC (9am ET = 13:00 UTC during DST)
- Test UTC behavior unchanged: `computeNextCronRun("0 9 * * *", ..., "UTC")` works as before

- STOP

---

- [ ] **Task 5 (F6): Same-run context refresh on tag/field mutations**

**Files:**
- `apps/api/src/services/automations/actions/tag.ts` — after tag_add / tag_remove succeeds, patch `ctx.context.tags`
- `apps/api/src/services/automations/actions/field.ts` — after field_set / field_clear succeeds, patch `ctx.context.fields`
- `apps/api/src/services/automations/runner.ts` — persist `ctx.context` back to `automation_runs.context` at the end of each step (if it isn't already)

**Approach:**

`tag_add`:
```ts
// after DB update succeeds
if (!wasPresent) {
  ctx.context.tags = [...(ctx.context.tags ?? []), tag];
}
```

`tag_remove`:
```ts
if (wasPresent) {
  ctx.context.tags = (ctx.context.tags ?? []).filter((t: string) => t !== tag);
}
```

`field_set`:
```ts
ctx.context.fields = { ...(ctx.context.fields ?? {}), [fieldKey]: value };
```

`field_clear`:
```ts
if (ctx.context.fields) {
  const fields = { ...ctx.context.fields };
  delete fields[fieldKey];
  ctx.context.fields = fields;
}
```

Verify `runner.ts` already writes `ctx.context` back to the run's `context` column after each iteration (via `UPDATE automation_runs SET context = ...`). If not, add it.

**Tests:**
- New test in `automation-integration-actions.test.ts`: flow `action_group [tag_add "premium"] → condition (tags contains "premium") → branch(true): message → end`. Enroll contact with NO tags. Assert: condition evaluates true, premium branch taken. This proves same-run context refresh works.

- STOP

---

### Phase R11 — MEDIUM + LOW

- [ ] **Task 6 (F3): Wire `default_workspace_id` for webhook auto_create_contact**

**Files:**
- `apps/api/src/services/automations/webhook-receiver.ts:156-210` — `resolveContact` and its cfg input

**Approach:**

The webhook entrypoint is scoped to an organization (from the automation). Pick option:
- **(a)** Auto-resolve from the organization's default workspace at webhook arrival
- **(b)** Require `default_workspace_id` on the webhook_inbound entrypoint config

Pick (a) — simpler for operators. In `receiveAutomationWebhook`:

```ts
// Before calling resolveContact, look up the org's default workspace
const workspace = await db.query.workspaces.findFirst({
  where: eq(workspaces.organizationId, organizationId),
  orderBy: asc(workspaces.createdAt),
});
const defaultWorkspaceId = workspace?.id ?? null;

// Pass into contact_lookup cfg
const contactId = await resolveContact(db, {
  ...cfg,
  default_workspace_id: defaultWorkspaceId,
}, organizationId);
```

If the org has no workspace, `auto_create_contact` returns null with a clear "no_default_workspace" reason (surface in the response body for debugging).

**Tests:**
- Add to `automation-webhook-trigger.test.ts`: webhook with `auto_create_contact: true` for an email that doesn't exist → assert contact created in the org's default workspace + run enrolled.

- STOP

---

- [ ] **Task 7 (F8): Dashboard autosave handles 422 correctly**

**File:** `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx:348`

**Current behavior:** any non-2xx → `throw new Error(...)` → local graph state stale.

**New behavior:** distinguish 422 (save succeeded but graph is invalid) from other failures:

```ts
async function defaultSave(automationId, graph) {
  const res = await fetch(`/api/automations/${automationId}/graph`, { ... });
  if (res.status === 422) {
    // Server saved canonical graph + force-paused. Apply returned state to local store.
    const body = await res.json();
    return {
      canonical_graph: body.graph,
      validation: body.validation,
      automation_status: body.automation?.status,
      saved: true,
    };
  }
  if (res.ok) {
    const body = await res.json();
    return {
      canonical_graph: body.graph,
      validation: body.validation,
      automation_status: body.automation?.status,
      saved: true,
    };
  }
  // genuine error — network, 5xx, 401, etc.
  let message = `Failed to save graph (HTTP ${res.status})`;
  try {
    const body = await res.json();
    if (body?.error?.message) message = body.error.message;
  } catch {}
  throw new Error(message);
}
```

The caller (autosave hook) then applies `canonical_graph` + `validation.errors`/`warnings` + `automation_status` to the graph store.

**Test:** hard to test without RTL; add a helper function for the parsing logic and test it in `automation-autosave.test.ts` (pure function — given a Response-like object, returns the right shape).

- STOP

---

- [ ] **Task 8 (F7): File attachment metadata capture**

**Files:**
- `apps/api/src/services/inbox-event-processor.ts:794` — `hasAttachment = Boolean(event.attachment)` — pass the full attachment instead
- `apps/api/src/services/automations/input-resume.ts:48-72` — resolveInputResume file path

**Approach:**

Change the `resumeWaitingRunOnInput` signature to accept the full attachment object:
```ts
export async function resumeWaitingRunOnInput(
  db: Database,
  runId: string,
  inboundText: string,
  attachment: { id?: string; url?: string; filename?: string; mime_type?: string; size_bytes?: number } | null,
  env: Record<string, any>,
): Promise<boolean>;
```

Update `inbox-event-processor.ts` call site to pass `event.attachment ?? null`.

In `resolveInputResume`, update the file branch:
```ts
if (config.input_type === "file") {
  if (attachment) {
    // Enforce config constraints
    if (config.accepted_mime_types?.length && !config.accepted_mime_types.includes(attachment.mime_type)) {
      return canRetry ? { port: "retry" } : { port: "invalid" };
    }
    if (config.max_size_mb && attachment.size_bytes && attachment.size_bytes > config.max_size_mb * 1024 * 1024) {
      return canRetry ? { port: "retry" } : { port: "invalid" };
    }
    return {
      port: "captured",
      capturedValue: attachment, // store full object, not "(file)"
    };
  }
  return canRetry ? { port: "retry" } : { port: "invalid" };
}
```

Update `InputConfig` type in `nodes/input.ts` to include `accepted_mime_types?: string[]` and `max_size_mb?: number`.

**Tests:**
- Update `automation-input-resume.test.ts` file-branch test to assert captured value is the attachment object
- Add mime/size validation tests

- STOP

---

### Phase R12 — "Day in the life" end-to-end test + verification

- [ ] **Task 9: Day-in-the-life end-to-end test**

**File:** `apps/api/src/__tests__/automation-day-in-the-life.test.ts` (NEW)

A single big test that exercises most of the system end-to-end. The meta-test that would have caught most of the 30 bugs found across audits.

**Scenario:**

1. **Setup:** 2 IG accounts (A + B) in the same workspace, 3 contacts (none tagged), 1 custom field `first_name` definition
2. **Create automation** via `POST /v1/automations` with template `comment_to_dm`:
   - Channel: IG
   - Account: A
   - Post IDs: post_foo
   - Keywords: ["info"]
   - DM content: text block with button "subscribe" + button "cancel"
3. **Assert** automation has graph, entrypoints, correct template
4. **Assert** schedule entrypoint (if any) self-armed — N/A for comment_to_dm but verify no stray jobs
5. **Activate** automation via `POST /activate`. Assert status="active".
6. **Synthesize comment_created event** for contact 1 on post_foo via account A → call `processInboxEvent` (full queue consumer path)
7. **Assert** contact 1 enrolled, action_group ran (public reply), message sent via **account A's token** (F2 fix)
8. **Verify** run is `waiting` for interactive input at the message node
9. **Synthesize button-click event**: contact 1 taps "subscribe" → `processInboxEvent`
10. **Assert** run advances via `button.subscribe` port (F1-era fix from Plan 5)
11. **Next flow:** a follow-up automation reacts to `tag_applied: ["subscribed"]`. Create + activate.
12. **First flow's action_group adds tag "subscribed"** then `condition` checks `tags contains "subscribed"`:
    - Without F6 fix: condition is false (stale context)
    - With F6 fix: condition is true, message sent
13. **Assert** second automation enrolled via internal `tag_applied` event (Plan 4 fix)
14. **Verify welcome scope:** contact 2 DMs account A (first-ever). Assert welcome_message binding fires, NOT default_reply (Plan 5 fix)
15. **Force-pause via bad edit:** PATCH the first automation's graph with an orphan node → API returns 422 with canonical graph + `status: "paused"`
16. **Client-side assertion (via autosave parser):** feed the 422 response through the autosave helper, assert it applies `canonical_graph` + `status: paused` (F8 fix)
17. **Fix the graph** via a valid PUT → status can be re-activated (F8 follow-through)
18. **Schedule flow:** create a third automation with a schedule entrypoint (cron `0 9 * * *`, timezone `America/New_York`, tag filter `subscribed`). Activate.
19. **Assert** initial `scheduled_trigger` job queued (F1 fix)
20. **Insert a job with `run_at = past`** manually → scheduler dispatch → matching contacts enrolled (including contact 1 who's tagged subscribed)
21. **Assert** the next scheduled job was queued for tomorrow 9am ET (= 13:00/14:00 UTC depending on DST) (F4 fix)

Mock `sendMessage` via `ctx.env.sendTransport` per existing pattern. Verify per-step assertions.

If some steps require features that overlap other fixes, skip the assertion for that step but note it in comments.

- STOP

---

- [ ] **Task 10: Final verification + completion report**

1. `bun run typecheck` — clean monorepo
2. `cd packages/sdk && bun run build` — clean
3. `bun test apps/api/src/__tests__/automation-*` — 226+ green (new tests added)
4. `bun test apps/app/src/` — 197 (or 178 + 2 pre-existing)
5. Write `docs/superpowers/AUTOMATION_REBUILD_AUDIT_ROUND3_REPORT_2026-04-22.md` — per-finding status, test counts, remaining concerns

- STOP

---

## Execution

Suggested unit grouping:
- **Unit RR10:** Tasks 1 + 2 + 4 (schedule self-arm + account pinning + timezone — all schedule/match/env path)
- **Unit RR11:** Tasks 3 + 5 + 6 (TikTok removal + same-run context + auto_create_contact wiring)
- **Unit RR12:** Tasks 7 + 8 + 9 + 10 (client 422 + file attachment + day-in-the-life test + final verification)
