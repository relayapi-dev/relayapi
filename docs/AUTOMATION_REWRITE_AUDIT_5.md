# Automation Rewrite Audit 5

Date: 2026-04-17

Scope re-audited:
- `apps/api/src/routes/automations.ts`
- `apps/api/src/routes/automation-templates.ts`
- `apps/api/src/schemas/automations.ts`
- `apps/api/src/services/automations/**`
- `apps/api/src/services/inbox-event-processor.ts`
- `apps/app/src/components/dashboard/automation/flow-builder/**`
- `apps/app/src/components/dashboard/pages/automation-detail-page.tsx`
- `packages/sdk/src/resources/automations.ts`
- `apps/docs/content/docs/guides/automations/nodes.mdx`
- `docs/AUTOMATION_REWRITE.md`
- `packages/db/src/schema.ts`

## Findings

### 1. High — `user_input_*` still ignores subtype validation, retry flow, and `no_match`

The prompt-send/wait path exists, but the actual validation logic is still missing. The handler itself explicitly says validation and retry are a later follow-up, and `resumeFromInput()` simply writes whatever inbound text arrived and always resumes via `captured`. That means `user_input_email`, `user_input_phone`, `user_input_choice`, `min_length`, `max_attempts`, `retry_prompt`, and the advertised `no_match` branch do not work as specified.

Relevant code:
- `apps/api/src/services/automations/nodes/user-input.ts:8-16`
- `apps/api/src/services/automations/nodes/user-input.ts:17-99`
- `apps/api/src/services/automations/runner.ts:254-284`
- `apps/api/src/schemas/automations.ts:439-493`
- `apps/docs/content/docs/guides/automations/nodes.mdx:52-76`

Impact:
- Invalid emails / phones / numbers / choices are silently accepted.
- `retry_prompt`, `max_attempts`, and `no_match` edges are dead configuration.

### 2. High — several node types are still exposed as supported even though the runtime intentionally stubs them

The schema and docs still expose AI, logic-extra, and ops nodes such as `ai_step`, `ai_agent`, `ai_intent_router`, `split_test`, `subflow_call`, `subscription_add`, `segment_add`, `notify_admin`, `conversation_assign`, `conversation_status`, and `webhook_out`. But the runtime registry still maps them to a generic `not yet implemented` failure handler.

Relevant code:
- `apps/api/src/services/automations/nodes/index.ts:276-307`
- `apps/api/src/schemas/automations.ts:141-163`
- `apps/api/src/schemas/automations.ts:532-688`
- `apps/docs/content/docs/guides/automations/nodes.mdx:121-245`

Impact:
- Users can create and publish graphs that only fail at execution time.
- The editor/schema/docs overstate what is actually implemented.

### 3. High — save/autosave concurrency in the editor can still lose newer edits

The attempted `editVersion` guard is still ineffective because each async save callback compares against the stale `editVersion` value captured in its own closure, so `setDirty(...)` still clears on an older save response even if newer edits happened afterward. On top of that, manual save always calls `refetchAutomation()`, and the `fetched` effect fully replaces `draft` and clears `dirty`, so an old server snapshot can overwrite newer local edits made while the save was in flight. The autosave hook also drops a pending save if its timer fires while another save is still running, because it just returns when `savingRef.current` is true and does not re-arm itself.

Relevant code:
- `apps/app/src/components/dashboard/pages/automation-detail-page.tsx:103-111`
- `apps/app/src/components/dashboard/pages/automation-detail-page.tsx:256-289`
- `apps/app/src/components/dashboard/pages/automation-detail-page.tsx:326-340`
- `apps/app/src/components/dashboard/automation/flow-builder/use-autosave.ts:23-45`

Impact:
- A user can keep editing during save/publish and have those newer edits marked saved or overwritten.
- Autosave can silently stop saving the latest draft until the next edit happens.

### 4. Medium — the step-cap requeue path can still strand active enrollments if queue send fails

When the runner hits `MAX_STEPS_PER_TICK`, it first updates the enrollment row and only then sends the follow-up `advance` queue message. If that queue send throws, there is no rollback or recovery path, so the enrollment remains `active` with updated state but no future worker scheduled to continue it.

Relevant code:
- `apps/api/src/services/automations/runner.ts:242-251`

Impact:
- Long chains / loops that legitimately hit the step cap can get stuck forever on a transient queue failure.

### 5. Low — `docs/AUTOMATION_REWRITE.md` is still stale in a few places

The implementation-status doc still says the simulate endpoint is not implemented and still treats the simulator guide as blocked on Phase 3b, even though the route and dashboard panel now exist.

Relevant code/docs:
- `docs/AUTOMATION_REWRITE.md:102-105`
- `docs/AUTOMATION_REWRITE.md:157-160`

Impact:
- The status doc is still not a reliable source of truth for current implementation state.

## Checks run

- `bun run typecheck`
- `bun test apps/api/src/__tests__/automations.test.ts`

Both pass on the current tree.
