# Automation Rewrite Audit 6

Date: 2026-04-17

Scope re-checked:

- runner, scheduler, trigger matcher, templates, automations routes
- user-input validation and resume flow
- inbox event normalization / resume bridge
- flow builder, simulator, run history, autosave
- rewrite/docs status pages

## Findings

### 1. High — `user_input_file` still cannot work end-to-end

The new validator and retry logic are implemented, but the inbox bridge still never supplies file metadata or a file payload to `resumeFromInput()`.

What the current code does:

- `NormalizedInboxEvent` only carries `text` plus generic message metadata; there is no attachment/file field in the normalized shape.
- `dispatchAutomationMatch()` resumes paused input flows with `resumeFromInput(env, pending, event.text ?? "")`.
- `validateInput("user_input_file", ...)` explicitly requires `fileMeta` (`mime_type` and/or `size_bytes`) and otherwise returns `expected a file upload`.
- The WhatsApp normalizer turns inbound media into text placeholders such as `[Image]`, `[Video]`, or `[Document: ...]` instead of structured file data.

Impact:

- A real file upload can never satisfy a `user_input_file` node.
- The enrollment will retry until attempts are exhausted, then route to `no_match`.
- The docs currently describe `user_input_file` as supported, but the runtime ingestion path does not provide the data needed to validate or store it.

Relevant code:

- `apps/api/src/services/inbox-event-processor.ts:26-42`
- `apps/api/src/services/inbox-event-processor.ts:337-346`
- `apps/api/src/services/inbox-event-processor.ts:655-683`
- `apps/api/src/services/inbox-event-processor.ts:697-708`
- `apps/api/src/services/automations/runner.ts:285-338`
- `apps/api/src/services/automations/nodes/user-input-validation.ts:131-153`
- `apps/docs/content/docs/guides/automations/nodes.mdx:68-75`

### 2. Low — `AUTOMATION_REWRITE.md` still contradicts itself on legacy cleanup status

The status summary says legacy cleanup is complete, but the dedicated Phase 4b section still says it is not started.

Examples:

- `docs/AUTOMATION_REWRITE.md:117` says legacy routes were deleted as part of Phase 4b.
- `docs/AUTOMATION_REWRITE.md:136-140` still marks Phase 4b as `Not started` and describes the deletes as pending.

This is documentation drift, not a runtime bug.

## Re-checks that now look fixed

I re-verified the issues from the earlier audits that were most likely to regress:

- branch labels are authorable in the Flow Builder
- scheduler stale-claim recovery uses `claimedAt`
- timeout enqueue rollback restores the waiting row on queue failure
- simulator panel matches `{ path, terminated }`
- run history highlights by `node_key`
- autosave/save concurrency protections are in place
- `smart_delay.quiet_hours` is implemented
- workspace-scope checks are present on single-resource routes
- PATCH-then-publish ordering is fixed
- template responses now return stored edge metadata
- explicit missing simulate versions return 404
- stubbed node types are rejected at create time and documented as unsupported

## Verification

- `bun run typecheck` — passed
- `bun test apps/api/src/__tests__/automations.test.ts` — passed (`56/56`)
