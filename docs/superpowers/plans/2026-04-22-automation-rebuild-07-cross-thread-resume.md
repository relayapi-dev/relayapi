# Automation Rebuild — Plan 7: Cross-Thread Conversation Resume

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Context:** The day-in-the-life test surfaced a cross-thread conversation boundary bug in Plan 6. Similar gaps likely exist in other trigger→reply paths.

**Core bug:** comment-triggered flows park on `comment-thread` conversation; button-tap inbound arrives on `dm-thread` conversation; `resumeWaitingRunOnInteractive` filters by `conversation_id` and misses.

**Root cause category:** runs are pinned to the conversation that TRIGGERED them, but subsequent interactions can happen on a different conversation (usually DM). Affects:
- `comment_created` → DM button/quick reply
- `story_reply` → DM button/quick reply
- `story_mention` → DM
- `share_to_dm` — usually lands in DM already, but worth checking
- `follow` → DM (no originating conversation)
- `ad_click` → DM
- `scheduled_trigger` → DM (no originating conversation)
- `webhook_inbound` → DM (no originating conversation)
- `tag_applied` / `field_changed` internal → DM

Basically: any flow whose output is a DM but whose trigger wasn't a DM has this class of bug.

**Plan 7 approach:** run follows the conversation it's currently operating on. When the `message` node sends to a contact, update the run's `conversation_id` to the outbound conversation. Then resume lookups align automatically.

**Git policy:** User handles git. Each task ends with `STOP — user commits at their discretion`.

---

## Task list

### Phase R13 — Cross-thread resume fix

- [ ] **Task 1: Run follows outbound conversation in the message handler**

**Files:**
- `apps/api/src/services/automations/nodes/message.ts` — after successful send, update run's `conversation_id`
- `apps/api/src/services/automations/runner.ts` — `RunContext` exposes mutable `conversationId` (already does via `ctx.conversationId`); add helper to persist change
- `apps/api/src/services/inbox-persistence.ts` (preserved) or `apps/api/src/services/inbox-event-processor.ts` — find/create conversation helper for outbound send
- `apps/api/src/services/automations/platforms/index.ts` — returns the outbound conversation id (or the message handler derives it)

**Approach:**

When the `message` handler sends to a channel, the outbound message lands on a specific `inbox_conversations` row (identified by social_account + contact + channel). The handler should:

1. Resolve or create that conversation row (existing helper: check `inbox-persistence.ts` for an `upsertConversation` or `findOrCreateConversation` function; if none, locate the contact/conversation resolution pattern already used by outbound sends elsewhere — `broadcasts` or inbox replies probably have one)
2. If the resolved conversation id differs from the run's current `conversation_id`, update:
   - `ctx.conversationId = outboundConvoId` (so the rest of this loop iteration uses the new value)
   - `UPDATE automation_runs SET conversation_id = :outboundConvoId WHERE id = :runId`

Implementation sketch inside message.ts handler, after `dispatchAutomationMessage` returns:

```ts
// After successful send, ensure the run is tracking the DM conversation
const outboundConvoId = await resolveOutboundConversation({
  db: ctx.db,
  organizationId: ctx.organizationId,
  socialAccountId: recipient.socialAccountId,
  contactId: ctx.contactId,
  channel: ctx.channel,
});

if (outboundConvoId && outboundConvoId !== ctx.conversationId) {
  await ctx.db.update(automationRuns)
    .set({ conversationId: outboundConvoId, updatedAt: new Date() })
    .where(eq(automationRuns.id, ctx.runId));
  ctx.conversationId = outboundConvoId;
}
```

Where `resolveOutboundConversation` either reuses an existing helper (preferred — check inbox-persistence/inbox-event-processor) or implements a direct lookup:

```ts
async function resolveOutboundConversation(args: {
  db: Database;
  organizationId: string;
  socialAccountId: string;
  contactId: string;
  channel: string;
}): Promise<string | null> {
  const existing = await args.db.query.inboxConversations.findFirst({
    where: and(
      eq(inboxConversations.organizationId, args.organizationId),
      eq(inboxConversations.socialAccountId, args.socialAccountId),
      eq(inboxConversations.contactId, args.contactId),
      // Only "dm"-like threads, not "comment" or "story_reply" threads:
      inArray(inboxConversations.threadType, ["dm", "direct_message", "message"]),
    ),
    orderBy: [desc(inboxConversations.updatedAt)],
  });
  if (existing) return existing.id;

  // If no DM conversation yet, the inbox system creates it on first outbound.
  // Check if the outbound send path has a hook that returns the created convo id.
  // If not, return null and let subsequent inbound (which will create the convo via inbox-persistence) align naturally.
  return null;
}
```

**Key decision:** the outbound send itself may be what creates the DM conversation row. If so, the creation happens upstream of the handler's return. Check the outbound send paths (`broadcasts` / inbox replies) to see how they surface the conversation id. If they do, thread it back through `dispatchAutomationMessage` → `SendMessageResult` with an optional `conversation_id` field.

If none of the above exists cleanly, simpler fallback: **don't filter by `conversation_id` at all in the interactive/input resume lookups** — filter by `contact_id` + `social_account_id` only. Justification: any DM from this contact on this social account is meant for this run. Risks: if the same contact has two active runs on two different flows (rare but possible per the partial unique index on (contact, automation)), both could try to resume on the same reply. But those runs are on different automations — they won't interfere with each other's state.

**Go with the fallback** — it's simpler and more robust. Specifically:

- In `input-resume.ts`'s waiting-run query: filter by `contact_id` + `automation_id` + `status="waiting"` + `waiting_for="input"` — drop the `conversation_id` filter
- Same in `interactive-resume.ts`
- Same in the resume loop inside `inbox-event-processor.ts`

This means: if contact alice has ONE active run across all her automations, any inbound from alice on any conversation can resume it. If she has multiple active runs (different automations, each on their own conversation), each inbound is tried against all of them — interactive_payload matching will only succeed for the run whose current message node has a matching `button.<payload>` port. So false positives are naturally filtered by port matching.

For the rare case where two flows are both waiting for generic text input on alice → first-match wins (or we pick the oldest). Document this behavior.

**Tests:**

Update `automation-day-in-the-life.test.ts` Parts 2 + 3 to drive the full pipeline through `processInboxEvent` WITHOUT calling `resumeWaitingRunOnInteractive` directly. The button-tap on the DM-thread conversation should now resume the comment-triggered run.

Add an assertion: after the button tap, `automation_runs.conversation_id` for the run reflects the DM-thread conversation (if the "follow outbound" approach is taken) OR stays on the comment thread but still resumes (if the "drop conversation filter" approach is taken).

Also add a test for cross-contamination safety: two contacts alice + bob both have active runs in different automations; inbound from alice should only resume alice's runs.

- STOP

---

### Phase R14 — Adjacent audit

- [ ] **Task 2: Secondary independent audit**

Before declaring done, dispatch a short independent audit focused on conversation/resumption edges. Specifically:

Areas to probe:
1. **Follow-triggered flows:** `follow` events have no `conversation_id` on the trigger event (because follow isn't a conversation). How does the run's `conversation_id` get set? Does the send path create it?
2. **Scheduled-triggered flows:** same question — `scheduled_trigger` has no originating conversation. Do the outbound sends work correctly? Can the resulting run resume on user reply?
3. **Webhook_inbound flows:** external webhook has no conversation. Same question.
4. **Internal event (tag_applied / field_changed) flows:** the triggering contact may be in any conversation state. Same question.
5. **`start_automation` cross-flow:** if flow A triggers flow B via `start_automation`, does B inherit A's `conversation_id`? Is that correct behavior, or should B start fresh?

For each, open the code and trace:
- Where does `conversation_id` get assigned on the new run?
- When the run's message handler sends, does it use a conversation that exists or create one?
- When a user replies, does the resume lookup find the run?

Produce: CONFIRMED / PARTIAL / INCORRECT verdicts for any suspected issues. Don't fix — just diagnose.

This is a smaller audit than Plans 4/5/6 since we're scoping to the conversation lifecycle.

- STOP

---

- [ ] **Task 3: Fix whatever the audit surfaces**

Depending on Task 2 findings, apply targeted fixes. If Task 2 finds nothing, document that and move on.

- STOP

---

### Phase R15 — Verification

- [ ] **Task 4: Final verification + report**

1. `bun run typecheck` — clean
2. `cd packages/sdk && bun run build` — clean
3. `bun test apps/api/src/__tests__/automation-*` — 254+ green
4. `bun test apps/app/src/` — 186+ green
5. Write `docs/superpowers/AUTOMATION_REBUILD_ROUND4_REPORT_2026-04-22.md`:
   - Cross-thread resume fix details
   - Audit findings (Task 2) + any follow-on fixes
   - Cumulative test counts
   - Remaining known gaps

- STOP

---

## Self-Review

Scope is narrow: one known bug + targeted follow-up audit. Decision lock: drop `conversation_id` filter from resume lookups (simplest, most robust). Alternative "follow outbound conversation" approach documented for completeness; can revisit if the drop-filter approach has issues.

No TBDs. No placeholder tests.
