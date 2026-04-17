# Automation Rewrite Audit 3

Date: 2026-04-17

Scope reviewed:
- `apps/api` automation routes, runner, scheduler, trigger matcher, inbox bridge, template routes, platform handlers
- `apps/app` automation page and template picker
- `packages/sdk` automation/segment/AI knowledge/ref-url resources
- `packages/mcp`
- `packages/db` schema + migrations
- automation docs under `apps/docs` and `docs/AUTOMATION_REWRITE.md`

Checks run:
- `bun run typecheck` -> passed
- `bun test apps/api/src/__tests__/automations.test.ts` -> passed

## High

1. `user_input_*` nodes still do not send the prompt message before parking.

Evidence:
- `apps/api/src/schemas/automations.ts:439-446` makes `prompt` required.
- `apps/api/src/services/automations/nodes/user-input.ts:18-33` only writes `_pending_input_*` state and returns `wait_for_input`.
- `apps/api/src/services/automations/runner.ts:190-200` parks the enrollment immediately; there is no prompt-send path.

Impact:
- The contact never receives the question.
- The flow waits indefinitely unless the user sends an unrelated inbound message.

2. Waiting-input resumes are routed incorrectly.

Evidence:
- `apps/api/src/services/inbox-event-processor.ts:214-219` dispatches automations for every inbound normalized event, including comments.
- `apps/api/src/services/inbox-event-processor.ts:330-338` resumes a waiting flow before checking `event.type`.
- `apps/api/src/services/automations/trigger-matcher.ts:219-231` returns the first waiting enrollment for the contact with no ordering, conversation scoping, or channel scoping.

Impact:
- An inbound comment can satisfy a DM-style `user_input_*` wait.
- If the same contact has multiple waiting automations, the resumed enrollment is nondeterministic.

3. Workspace-scoped API keys can still read and mutate out-of-scope single-resource rows.

Evidence:
- Automations: `apps/api/src/routes/automations.ts:337-351`, `383-430`, `463-489`, `516-536`, `561-577`, `694-770`, `805-933`
- Segments: `apps/api/src/routes/segments.ts:157-252`
- AI knowledge: `apps/api/src/routes/ai-knowledge.ts:178-286`, `332-469`
- Ref URLs: `apps/api/src/routes/ref-urls.ts:170-283`
- The repo already has the correct helper at `apps/api/src/lib/workspace-scope.ts:27-44`, but these routes never call it.
- `apps/api/src/middleware/permissions.ts:51-112` only validates `workspace_id` supplied in the request, not the loaded row's `workspaceId`.

Impact:
- A workspace-scoped key can fetch, update, delete, simulate, and inspect enrollments/runs for resources in another workspace inside the same org.

4. `PATCH /v1/automations/{id}` can publish a stale snapshot.

Evidence:
- `apps/api/src/routes/automations.ts:397-421` calls `publishVersion(db, id)` before persisting the PATCH body.
- `apps/api/src/routes/automations.ts:995-1060` snapshots the currently stored automation row and graph.

Impact:
- A request that both changes trigger metadata and activates the automation can publish the old trigger/config while returning the new draft fields.

5. New enrollments can be orphaned if queue enqueue fails.

Evidence:
- `apps/api/src/services/automations/trigger-matcher.ts:142-168` inserts the enrollment, increments `totalEnrolled`, then calls `env.AUTOMATION_QUEUE.send(...)`.
- `apps/api/src/services/inbox-event-processor.ts:360-361` swallows the thrown error at the bridge layer.

Impact:
- The row remains `active` in the database, but no worker ever advances it.
- Metrics are incremented even though the run never starts.

6. Automation counters are materially wrong.

Evidence:
- `apps/api/src/services/automations/runner.ts:139-154` increments `totalCompleted` only for explicit `complete`.
- `apps/api/src/services/automations/runner.ts:210-223` marks implicit graph termination as `completed` without incrementing `totalCompleted`.
- `apps/api/src/services/automations/runner.ts:157-169` handles `exit` without incrementing `totalExited`.
- There is no other `totalExited` update path in the automation runtime.

Impact:
- `total_completed` undercounts common successful runs.
- `total_exited` stays wrong forever.

## Medium

7. Scheduler durability is still weak in two separate places.

Evidence:
- `apps/api/src/services/automations/scheduler.ts:20-48` marks due ticks as `processing`, but the sweep only selects `pending`; there is no reclaim path for stale `processing` rows if the worker dies after claim.
- `apps/api/src/services/automations/scheduler.ts:97-115` clears `_pending_input_*` markers and flips the enrollment back to `active` before queueing the timeout resume.

Impact:
- Claimed delay ticks can become permanently stranded in `processing`.
- Timed-out input waits can be lost if enqueue fails after the state is cleared.

8. Template creation UI says "Create draft", but every template is created active.

Evidence:
- `apps/app/src/components/dashboard/automation/template-picker-dialog.tsx:380-382` labels the button `Create draft`.
- `apps/api/src/routes/automation-templates.ts:66` defaults `status` to active.
- Each template route passes `status: "active"` at `243`, `302`, `362`, `414`, `466`, and `532`.

Impact:
- Users can unintentionally activate automations immediately from the dashboard.

9. `keyword-reply` accepts channels that the runtime does not actually support.

Evidence:
- `apps/api/src/schemas/automations.ts:1763-1770` accepts any `AutomationChannel`.
- `apps/api/src/routes/automation-templates.ts:336-350` falls back to `manual` for unsupported channels.
- `apps/app/src/components/dashboard/automation/template-picker-dialog.tsx:270-278` explicitly offers `sms`.
- `apps/api/src/services/message-sender.ts:35-56` has no `sms` or `discord` implementation for universal `message_text`.
- `packages/sdk/src/resources/automations.ts:511-519` also types `channel` as the full `AutomationChannel` union.

Impact:
- API/SDK callers can create "keyword reply" automations that never auto-trigger because they are silently converted to `manual`.
- The dashboard can create an active SMS keyword-reply automation whose `message_text` node fails at runtime because SMS is not supported by the universal sender.

10. Template responses still fabricate edge metadata instead of returning stored rows.

Evidence:
- `apps/api/src/routes/automation-templates.ts:104-113` inserts real edges.
- `apps/api/src/routes/automation-templates.ts:163-170` returns `id: ""` and `order: 0` for every edge rather than loading the inserted records back.

Impact:
- The response does not match the persisted graph.
- Callers that diff or edit by returned edge ids/orders are working from incorrect data.

11. `/v1/automations/{id}/simulate` still falls back to the draft when the caller requests a nonexistent version.

Evidence:
- `apps/api/src/routes/automations.ts:710-762`

Impact:
- Asking for a bad version number does not fail fast; it silently simulates the current draft instead, which is misleading for debugging and MCP usage.

12. WhatsApp `react` / `mark_read` nodes look for the wrong inbound message key.

Evidence:
- `apps/api/src/services/inbox-event-processor.ts:349-355` stores inbound message state as `message_id`.
- `apps/api/src/services/automations/nodes/platforms/whatsapp.ts:284-309` looks for `state.last_inbound_message_id`.

Impact:
- `whatsapp_react` and `whatsapp_mark_read` fail unless the flow author redundantly hardcodes `message_id` on the node.

13. `comment-to-dm` accepts `once_per_user`, but the server ignores it.

Evidence:
- Input schema: `apps/api/src/schemas/automations.ts:1739-1752`
- Dashboard body builder: `apps/app/src/components/dashboard/automation/template-picker-dialog.tsx:121-130`
- Template route: `apps/api/src/routes/automation-templates.ts:231-239` never stores or enforces `once_per_user`

Impact:
- The API surface suggests replay control exists for the template, but it has no effect.

14. The universal content-node docs overstate what is implemented.

Evidence:
- Docs claim broad support at `apps/docs/content/docs/guides/automations/nodes.mdx:25-26` and again at `:278`.
- `apps/api/src/services/automations/nodes/message-media.ts:1-12` is still a stub.
- `apps/api/src/services/message-sender.ts:35-56` only supports WhatsApp, Telegram, Twitter, Instagram, Facebook, and Reddit for `message_text`.

Impact:
- The docs advertise `message_text` / `message_media` as working on Discord and SMS, but the runtime does not support that today.

## Platform API Contract Issue (verified online)

15. `linkedin_reply_to_comment` is not constructing a valid LinkedIn comment-reply request.

Evidence:
- Local handler: `apps/api/src/services/automations/nodes/platforms/linkedin.ts:72-99`
- The handler only sends `{ actor, message }` and reads a `share_urn`.

Verified against official Microsoft docs:
- Comments API: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/network-update-social-actions?view=li-lms-2026-03
- LinkedIn's comment-reply example targets `POST /rest/socialActions/{commentUrn}/comments` and includes both the original post in `object` and the parent comment in `parentComment`.

Impact:
- The current node is shaped like "create a top-level comment", not "reply to an existing comment".
- Existing flows will fail or post to the wrong object once this node is exercised.

## Notes

- I did not find a new DB migration mismatch: the new automation/segment/AI knowledge/ref-url tables are created in `packages/db/drizzle/0023_marvelous_tomorrow_man.sql`, and `0024_fixed_scorpion.sql` only removes the legacy automation tables.
- `packages/mcp` and the new Astro proxy routes are thin wrappers over the backend behavior above. I did not find additional standalone correctness bugs there beyond inheriting the backend issues already listed.
