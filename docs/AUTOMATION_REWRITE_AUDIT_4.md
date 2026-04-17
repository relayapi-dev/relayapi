# Automation Rewrite Audit 4

Date: 2026-04-17

Scope reviewed:
- `apps/api/src/routes/automations.ts`
- `apps/api/src/routes/automation-templates.ts`
- `apps/api/src/schemas/automations.ts`
- `apps/api/src/services/automations/**`
- `apps/api/src/services/inbox-event-processor.ts`
- `apps/app/src/components/dashboard/automation/flow-builder/**`
- `apps/app/src/components/dashboard/pages/automation-*.tsx`
- `apps/app/src/pages/api/automations/**`
- `packages/sdk/src/resources/automations.ts`
- `apps/docs/content/docs/guides/automations/nodes.mdx`
- `docs/AUTOMATION_REWRITE.md`

## Findings

### 1. High — the Flow Builder still cannot author labeled branches, so core control-flow nodes are effectively broken

The canvas hard-codes every newly created edge to `label: "next"` and there is no edge editor anywhere in the current UI to change that label later. The runtime resolves control flow by label (`yes`, `no`, `captured`, `timeout`, custom randomizer branches, etc.), so conditions, user-input timeout/no-match branches, randomizers, split tests, AI handoff branches, and similar nodes cannot be wired correctly from the shipped editor.

Relevant code:
- `apps/app/src/components/dashboard/automation/flow-builder/flow-builder.tsx:218-229`
- `apps/app/src/components/dashboard/automation/flow-builder/flow-builder.tsx:273-283`
- `apps/app/src/components/dashboard/automation/flow-builder/edge-components.tsx:9-18`
- `apps/api/src/services/automations/runner.ts:305-320`
- `apps/api/src/services/automations/simulator.ts:172-194`

Impact:
- Users can publish graphs that look connected in the editor but terminate incorrectly at runtime because the required branch labels were never created.

### 2. High — stale scheduled ticks are reclaimed using `runAt` instead of a claim timestamp, which can duplicate work

The scheduler's stale-processing recovery resets any `processing` tick whose `runAt` is older than five minutes. `runAt` is the scheduled execution time, not the time the row was claimed. A legitimately claimed delay tick with an old scheduled time can therefore be reclaimed while it is still being processed, causing duplicate `advance` enqueues.

Relevant code:
- `apps/api/src/services/automations/scheduler.ts:24-40`
- `packages/db/src/schema.ts:2970-2991`

Impact:
- Delayed enrollments can be resumed twice.
- Any non-idempotent downstream node can execute twice.

### 3. Medium — the Simulator panel is wired to an obsolete API contract and currently renders no real results

The dashboard simulator still posts old request fields (`contact_id`, `trigger_payload`) and expects an old response shape (`executed`, `final_status`). The API now returns `{ path, terminated }`. The Astro proxy passes the API response through unchanged, so the panel receives data but does not read it correctly.

Relevant code:
- `apps/app/src/components/dashboard/automation/flow-builder/simulator-panel.tsx:7-18`
- `apps/app/src/components/dashboard/automation/flow-builder/simulator-panel.tsx:61-79`
- `apps/app/src/components/dashboard/automation/flow-builder/simulator-panel.tsx:185-194`
- `apps/app/src/pages/api/automations/[id]/simulate.ts:4-11`
- `apps/api/src/routes/automations.ts:692-808`
- `apps/api/src/services/automations/simulator.ts:24-46`

Impact:
- The simulator panel shows an empty or misleading result even though the API succeeds.
- Highlighted paths from simulation do not work.

### 4. Medium — the Run History panel uses the wrong identifiers and status/outcome enums, so its highlighting and badges are inaccurate

Run-history highlighting uses `node_id` values from the API, but the canvas highlights by node key. Separately, the panel styles outcomes as `success/fail/error` and enrollment statuses as `running/cancelled`, while the backend emits values like `ok`, `failed`, `complete`, `exit`, `active`, and `exited`.

Relevant code:
- `apps/app/src/components/dashboard/automation/flow-builder/run-history-panel.tsx:59-73`
- `apps/app/src/components/dashboard/automation/flow-builder/run-history-panel.tsx:133-136`
- `apps/app/src/components/dashboard/automation/flow-builder/run-history-panel.tsx:224-245`
- `apps/api/src/routes/automations.ts:995-1005`
- `apps/api/src/services/automations/runner.ts:334-351`

Impact:
- Executed paths from run logs do not highlight on the canvas.
- Successful and failed steps are rendered with incorrect neutral styling.
- `active` / `exited` enrollments do not get the intended status color treatment.

### 5. Medium — autosave can mark newer edits as saved even when they were made after the request started

`silentSave()` always calls `setDirty(false)` when the request returns. If a user keeps editing while that save is in flight, those newer edits are still marked clean when the earlier response resolves. The autosave hook also only schedules on the `dirty` boolean transition, not on each content change, so it behaves as "save 10s after first edit" instead of a true debounce from the latest edit.

Relevant code:
- `apps/app/src/components/dashboard/pages/automation-detail-page.tsx:260-271`
- `apps/app/src/components/dashboard/automation/flow-builder/use-autosave.ts:23-35`

Impact:
- The editor can clear the unsaved indicator while there are still local changes not reflected on the server.

### 6. Medium — `smart_delay.quiet_hours` is exposed in the schema/docs but ignored by the runtime

The schema supports `quiet_hours` and the docs describe it as delaying sends outside off-hours, but the handler still ignores that field entirely and always schedules `now + duration_minutes`.

Relevant code:
- `apps/api/src/schemas/automations.ts:503-514`
- `apps/api/src/services/automations/nodes/smart-delay.ts:3-13`
- `apps/docs/content/docs/guides/automations/nodes.mdx:97-105`

Impact:
- Automations can send during the exact quiet windows the API/docs suggest they avoid.

### 7. Medium — the Property Panel cannot correctly edit array-shaped node fields

The schema parser only recognizes `string`, `number`, `boolean`, `enum`, and `object`. Array fields fall back to a plain text input, which breaks common node configs like `user_input_choice.choices`, button arrays, keyboard rows, contact lists, and other structured arrays.

Relevant code:
- `apps/app/src/components/dashboard/automation/flow-builder/property-panel.tsx:9-57`
- `apps/api/src/schemas/automations.ts:479-486`
- `apps/api/src/schemas/automations.ts:904-914`
- `apps/api/src/schemas/automations.ts:935-938`

Impact:
- Several node types are present in the editor but not realistically configurable through the shipped property UI.

### 8. Low — `message_media` / `message_file` still silently skip sending

The universal media/file node handler still just advances the graph and stores a warning in state instead of failing or sending anything. That behavior is easy to miss because the enrollment appears to succeed.

Relevant code:
- `apps/api/src/services/automations/nodes/message-media.ts:3-12`
- `apps/api/src/services/automations/nodes/index.ts:132-134`

Impact:
- Graphs using `message_media` or `message_file` can look successful while no outbound message is actually sent.

### 9. Low — the rewrite/status docs are no longer in sync with the current code

The implementation plan doc still says `/v1/automations/:id/simulate` is not implemented and still describes Phase 6 as a plan, while the route and dashboard surfaces now exist. There are also stale comments in the template route claiming `instagram_reply_to_comment` is still stubbed even though the handler is present.

Relevant code/docs:
- `docs/AUTOMATION_REWRITE.md:39`
- `docs/AUTOMATION_REWRITE.md:188-257`
- `apps/api/src/routes/automation-templates.ts:220-224`
- `apps/api/src/services/automations/nodes/platforms/instagram.ts:351-389`

Impact:
- The status doc is no longer a reliable source of truth for what has actually shipped.

## Checks run

- `bun run typecheck`
- `bun test apps/api/src/__tests__/automations.test.ts`

Both currently pass.
