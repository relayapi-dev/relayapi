# Automation Rewrite Audit 2

Date: 2026-04-17

Scope:
- Re-reviewed the current automation rewrite after the latest implementation pass.
- Ran `bun run typecheck` at repo root. It passed.
- Ran `bun test apps/api/src/__tests__/automations.test.ts`. It passed.

## Verdict

The rewrite is much closer to complete, but there are still a few real bugs in the execution and access-control paths.

The main issues are:
- workspace-scoped API keys can still access single-resource automation/segment/AI-knowledge/ref-url records outside their workspace scope;
- `PATCH /v1/automations/{id}` can publish a stale snapshot when activating and changing trigger metadata in the same request;
- the timeout sweep can strand timed-out enrollments if queue enqueue fails;
- template create endpoints return fake edge metadata instead of the real stored edges;
- the simulate endpoint silently falls back to the current draft when the caller requests a nonexistent explicit version.

## Findings

### 1. High: single-resource endpoints still bypass workspace scoping for scoped API keys

Code refs:
- `apps/api/src/middleware/permissions.ts:51-113`
- `apps/api/src/lib/workspace-scope.ts:11-19`
- `apps/api/src/routes/automations.ts:337-351`
- `apps/api/src/routes/automations.ts:383-430`
- `apps/api/src/routes/automations.ts:463-489`
- `apps/api/src/routes/automations.ts:516-536`
- `apps/api/src/routes/automations.ts:561-577`
- `apps/api/src/routes/automations.ts:694-770`
- `apps/api/src/routes/automations.ts:805-933`
- `apps/api/src/routes/segments.ts:157-168`
- `apps/api/src/routes/segments.ts:193-220`
- `apps/api/src/routes/segments.ts:239-253`
- `apps/api/src/routes/ai-knowledge.ts:178-192`
- `apps/api/src/routes/ai-knowledge.ts:219-287`
- `apps/api/src/routes/ai-knowledge.ts:332-420`
- `apps/api/src/routes/ref-urls.ts:170-181`
- `apps/api/src/routes/ref-urls.ts:210-252`
- `apps/api/src/routes/ref-urls.ts:271-284`

Why this is a bug:
- `workspaceScopeMiddleware` only checks `workspace_id` in the query string or request body.
- `applyWorkspaceScope()` only helps list queries.
- the new single-resource routes load rows by `organizationId` + `id`, then explicitly say workspace enforcement is “deferred to middleware”.
- for scoped keys, that means a caller can fetch/update/delete a resource in another workspace as long as they know its ID.

Impact:
- scoped API keys are weaker than intended;
- the new automation-related resources do not honor workspace boundaries on single-resource endpoints.

### 2. High: activation via PATCH can publish the wrong snapshot

Code refs:
- `apps/api/src/routes/automations.ts:397-421`
- `apps/api/src/routes/automations.ts:423-429`
- `apps/api/src/routes/automations.ts:995-1060`

Why this is a bug:
- `updateAutomation()` builds `updates` from the incoming PATCH body;
- if `status` becomes `"active"` and `publishedVersion === null`, it calls `publishVersion(db, id)` before the update is written;
- `publishVersion()` snapshots the current automation header from the database;
- if the same PATCH also changes `trigger`, `channel`, `exit_on_reply`, or reentry settings, the first published snapshot does not include those changes.

Example:
- draft automation with trigger A;
- client sends one PATCH changing trigger A -> B and `status: "active"`;
- published snapshot still contains trigger A;
- row is updated to trigger B afterward.

Impact:
- the API can report one configuration while the runner executes another;
- first-time activation via PATCH can publish stale trigger metadata.

### 3. Medium: timeout resumption clears state before enqueueing, so queue failure can strand enrollments

Code refs:
- `apps/api/src/services/automations/scheduler.ts:97-115`

Why this is a bug:
- `processAutomationInputTimeouts()` first removes `_pending_input_*` markers and flips the enrollment to `active`;
- only after that does it enqueue the automation queue message with `resume_label: "timeout"`;
- if `env.AUTOMATION_QUEUE.send()` fails, the function does not restore the prior waiting state or timeout markers.

Impact:
- timed-out enrollments can get stuck in `active` with no pending queue message and no remaining timeout marker to reclaim them on the next sweep.

### 4. Medium: template endpoints return fabricated edge metadata instead of the actual stored edges

Code refs:
- `apps/api/src/routes/automation-templates.ts:104-113`
- `apps/api/src/routes/automation-templates.ts:163-170`

Why this is a bug:
- `materialize()` inserts real edge rows into `automation_edges`;
- but the response it returns does not read those rows back;
- instead it fabricates response edges with `id: ""` and `order: 0` for every edge.

Impact:
- the template endpoints do not actually return a correct `AutomationWithGraphResponse`;
- UI or MCP callers that trust the returned edge IDs/order will immediately have inconsistent local state.

### 5. Medium: simulate with an explicit nonexistent version silently falls back to the current draft

Code refs:
- `apps/api/src/routes/automations.ts:710-762`

Why this is a bug:
- the route comment says it prefers an explicit version, then the draft;
- implementation sets `targetVersion = body.version ?? auto.version`;
- if `body.version` is provided but not found in `automation_versions`, it silently builds a live snapshot from the current draft graph instead of returning an error.

Impact:
- callers can believe they simulated version `N` when they actually simulated the current draft;
- this is especially misleading for debugging historical published versions.

## Notes

- The previously flagged wait/resume bug appears fixed. `advanceEnrollment()` now supports `resumeLabel`, `resumeFromInput()` uses `captured`, and delayed ticks use `next`.
- The run-log endpoint now correctly checks org + automation ownership before returning logs.
- The old route mounts appear removed from `apps/api/src/index.ts`.

## Checks Run

- `bun run typecheck` — pass
- `bun test apps/api/src/__tests__/automations.test.ts` — pass

Test coverage gap:
- the current tests mostly cover simulator/schema behavior;
- none of the remaining bugs above are covered by tests yet.

## Recommended Next Fixes

1. Add `assertWorkspaceScope()` checks to every single-resource route that loads a row with `workspaceId`.
2. In `updateAutomation()`, apply the metadata update first, then publish from the updated row when activating.
3. Make timeout resume atomic enough to survive queue-send failure, or restore the waiting markers on enqueue failure.
4. Change template creation responses to load the stored graph back from the database before returning.
5. Make `/simulate` return `404` or `400` when an explicit `version` is requested but does not exist.
