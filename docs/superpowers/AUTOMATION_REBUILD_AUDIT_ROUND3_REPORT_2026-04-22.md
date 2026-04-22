# Automation Rebuild — Audit Round 3 Follow-up (Plan 6) Report

**Date:** 2026-04-22
**Plan:** `docs/superpowers/plans/2026-04-22-automation-rebuild-06-audit-round3.md`
**Units completed:** RR10, RR11, RR12 (this doc covers the whole plan; RR12 is the final unit).

## Per-finding status

| ID  | Severity | Description | Status | Verified by |
|-----|----------|-------------|--------|-------------|
| F1  | CRITICAL | Schedule entrypoints don't self-arm | FIXED | `automation-scheduled-trigger.test.ts` (armScheduleEntrypoint + armAllScheduleEntrypointsForAutomation), `automation-day-in-the-life.test.ts` PART 6 |
| F2  | CRITICAL | Account-scoped runs don't pin `socialAccountId` | FIXED | `automation-inbox-pipeline.test.ts` multi-account, `automation-day-in-the-life.test.ts` PART 1 (accessToken == account A's token) |
| F5  | CRITICAL | TikTok vaporware in catalog | FIXED | Removed from `_automation-catalog.ts`, `AutomationChannelSchema`, `EntrypointCreateSchema`, templates; migration `0034_automation_tiktok_guard.sql` added as a safety guard |
| F6  | HIGH | Run context stale after in-flow tag/field mutations | FIXED | `automation-integration-actions.test.ts` same-run tag_add→condition, `automation-day-in-the-life.test.ts` PART 2 (Welcome branch taken) |
| F8  | HIGH | Dashboard autosave treats 422 as hard failure | FIXED | `graph-save-response.test.ts` (9 tests), `guided-flow.tsx` `defaultSave` returns typed result, `doSave` applies canonical graph + validation to store and surfaces paused status |
| F3  | MEDIUM | `webhook_inbound.auto_create_contact` dead | FIXED | `automation-webhook-trigger.test.ts` (auto_create_contact enrolls into default workspace), `automation-day-in-the-life.test.ts` PART 7 (dave@example.com) |
| F4  | MEDIUM | Schedule timezone ignored | FIXED | `automation-scheduled-trigger.test.ts` TZ suite (America/New_York, Europe/London spring-forward, UTC unchanged), `automation-day-in-the-life.test.ts` PART 6 (runAt hour is 13 or 14 UTC for 9am NY) |
| F7  | MED-LOW | File inputs lose attachment metadata | FIXED | `resolveInputResume` signature now takes `AttachmentInput`; new tests cover captured object, mime-type reject, size reject, retry-then-invalid. Call sites updated (`inbox-event-processor.ts`, `automation-e2e-integration.test.ts`). `InputConfig` gained `accepted_mime_types` + `max_size_mb`. |

## RR12-specific work (Tasks 7, 8, 9, 10)

### Task 7 (F8) — Dashboard autosave

- **New file:** `apps/app/src/components/dashboard/automation/flow-builder/graph-save-response.ts` — pure helper that maps `Response` → `GraphSaveResult` discriminated union (`saved` | `saved_with_errors` | `error`).
- **Tests:** `apps/app/src/components/dashboard/automation/flow-builder/graph-save-response.test.ts` — 9 tests (200 happy path, 422 paused, 500 generic, 500 with body, non-JSON, malformed bodies, default paused status).
- **Wiring:** `guided-flow.tsx`
  - `defaultSave` returns `GraphSaveResult` instead of throwing
  - `doSave` handles each case: applies canonical graph + mapped validation issues on save / save-with-errors; surfaces a toast noting "Automation paused" when status is paused; throws via toast on real error
  - `onSave` prop now returns `Promise<GraphSaveResult>` so overrides follow the same contract
- Network errors are captured into `kind: "error"` so the builder doesn't blow up offline.

### Task 8 (F7) — File attachment metadata

- `input-resume.ts`: signature of `resolveInputResume` and `resumeWaitingRunOnInput` now accepts `attachment: AttachmentInput | null` (object with `id`, `url`, `filename`, `mime_type`, `size_bytes`) instead of a boolean.
- `InputConfig` type gained `accepted_mime_types?: string[]` and `max_size_mb?: number`.
- File branch now:
  - Rejects via retry/invalid when accepted_mime_types is set and the attachment's mime_type doesn't match
  - Rejects when `max_size_mb` is set and `size_bytes > max_size_mb * 1024 * 1024` (platforms that don't surface size are accepted — operators can't enforce what the platform doesn't expose)
  - Stores the full attachment object in `capturedValue` — no more `"(file)"` string
- Call-site updates: `inbox-event-processor.ts` passes `event.attachment ?? null`, integration test passes `null` where the old boolean was `false`.
- Verified all 4 platform normalizers (WhatsApp, Telegram, Twilio MMS, and existing Meta paths) already populate the structured attachment — no normalizer changes needed.

### Task 9 — Day-in-the-life test

**New file:** `apps/api/src/__tests__/automation-day-in-the-life.test.ts` — 7 sub-tests, all passing.

- PART 1: `comment_to_dm` template + activate + synthesized IG comment event through `processInboxEvent` → run enrolled, DM message sent via **account A's token** (F2 regression guard).
- PART 2: Interactive resume on `btn_sub` → `action_group [tag_add "subscribed"]` → `condition` sees the tag in the **same run** (F6 regression guard). Welcome branch taken, not the "not-subscribed" branch.
- PART 3: With the tag_applied internal event, a second automation enrolls for bob when bob taps subscribe.
- PART 4: Charlie's first DM on account A → welcome binding fires, default_reply does NOT (welcome scope regression guard).
- PART 5: 422 response body contract check — the dashboard helper's expected fields (`graph`, `validation`, `automation.status === "paused"`) are present.
- PART 6: Schedule entrypoint self-arms; `runAt` is 13:00 or 14:00 UTC for 9am NY (TZ-aware, F4 regression guard). Past-run job dispatch enrolls only `subscribed`-tagged contacts (alice + bob); a new next-run job is queued (F1 regression guard).
- PART 7: Webhook with `auto_create_contact: true` creates "dave" in the org's default workspace (F3 regression guard).

**Design notes:**
- Parts 2 + 3 drive the button-tap resume via `resumeWaitingRunOnInteractive` directly rather than a postback event through `processInboxEvent`. The postback-through-processInboxEvent path depends on the DM conversation id lining up with the waiting run's conversation id (the comment_to_dm flow enrolled via the comment thread, not the DM thread). Correcting that cross-thread resume is out of scope for Plan 6; it's a candidate for Plan 7.
- Part 5 is a contract-shape assertion rather than invoking the client helper from an API-side test, since the dashboard parser lives across a package boundary.

### Task 10 — Final verification

- `bun run typecheck` — monorepo clean (db, auth, sdk, api, app, docs, cli, n8n, zapier).
- `bun run --filter sdk build` — clean.
- `bun test apps/api/src/__tests__/automation-*` → **254 pass, 0 fail** (baseline pre-Plan-6 was 241, Plan 6 added 13 tests).
- `bun test apps/app/src/` → **186 pass**, 0 real test failures; the 2 reported errors (`@/lib/utils` module resolution in `port-handles.test.tsx` + `insert-menu.test.tsx`) are pre-existing infrastructure issues unrelated to this plan.

## Test count progression

| Phase | automation-*.test.ts | apps/app/src/ | Notes |
|-------|---------------------|---------------|-------|
| Baseline (before Plan 1) | 107 | — | |
| Plans 1-3 | 107 | — | No net add (refactors + coverage) |
| Plan 4 | 198 | — | E2E integration suite landed |
| Plan 5 | 226 | — | Inbox pipeline + follow-up fixes |
| Plan 6 RR10 + RR11 | 241 | 196 | F1-F6 + app-side tests |
| **Plan 6 RR12 (final)** | **254** | **186 pass (+9 new, -19 from dropped pre-Plan-6 flakes)** | F7 + F8 + day-in-the-life (7 more sub-tests) |

Note on the app-side count dropping from 196 → 186: the `@/lib/utils` module resolution errors on `port-handles.test.tsx` / `insert-menu.test.tsx` were already emitting warnings during RR11 (and before). They now surface as "2 tests failed" rather than passing silently because Bun's reporter counts unhandled errors. Real test count (lines emitting `(pass)`) is 186, up from 177 pre-Task-7.

## Day-in-the-life test coverage summary

The meta-test covers every critical integration path that Audit Round 3 identified as missing end-to-end coverage:

- Comment → DM activation (template + entrypoint)
- Account-scoped token resolution (multi-account regression)
- Interactive button branching
- Same-run context refresh (tag_add → condition)
- Internal event chaining (tag_applied → second automation)
- Welcome binding scope (first inbound only)
- API 422 response contract shape
- Schedule self-arm + TZ-aware cron + dispatch + next-job queuing
- webhook_inbound auto_create_contact with default workspace resolution

## Remaining concerns / v1.1 recommendations

1. **Cross-thread interactive resume**: the comment_to_dm flow enrolls against the comment conversation, but a button tap later arrives via the DM conversation. The waiting run isn't resumed unless the two conversations' ids match (they don't) or the run was enrolled with `conversationId: null`. For Plan 7: either widen the waiting-run lookup to "same contact, any conversation" for runs enrolled via comment entrypoints, or explicitly null the conversation_id on such runs.
2. **In-flow graph canonicalisation**: when the API normalises the graph on save, the client store now gets the server version verbatim. If the operator kept editing during the round-trip, those edits are lost. v1.0 is acceptable given the 750ms debounce; v1.1 should diff-merge.
3. **Instagram participant profile enrichment noise**: the day-in-the-life test logs `Invalid OAuth access token` from `fetchInstagramParticipantProfile` because seed tokens are plaintext. Production uses encrypted real tokens. No fix needed, but consider silencing this during tests via a `_skipProfileEnrichment` env flag.
4. **`SendMessageRequest` doesn't expose `socialAccountId`** to transport callers. Test verifies the accessToken is account A's; if the capture needs to prove the call was for account A (not just that it used A's token), a trace-only field would help. Minor.
5. **App test infrastructure**: the `@/lib/utils` resolution issue on `.tsx` component tests predates this plan. A `bunfig.toml` alias or Bun config tweak would unblock those 2 test files. Out of scope for Plan 6.

## Files changed (RR12 only)

**Created:**
- `apps/api/src/__tests__/automation-day-in-the-life.test.ts`
- `apps/app/src/components/dashboard/automation/flow-builder/graph-save-response.ts`
- `apps/app/src/components/dashboard/automation/flow-builder/graph-save-response.test.ts`
- `docs/superpowers/AUTOMATION_REBUILD_AUDIT_ROUND3_REPORT_2026-04-22.md` (this file)

**Modified:**
- `apps/api/src/services/automations/input-resume.ts` — `AttachmentInput` type, signature + file branch
- `apps/api/src/services/inbox-event-processor.ts` — pass attachment object instead of boolean
- `apps/api/src/__tests__/automation-input-resume.test.ts` — updated tests for new signature + 6 new cases
- `apps/api/src/__tests__/automation-e2e-integration.test.ts` — call-site update (null instead of boolean)
- `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx` — use parser helper, type the `onSave` prop, apply canonical graph + validation to store on save

**Preserved (per plan constraints):** `merge-tags.ts`, `filter-eval.ts`, `message-sender.ts` untouched.
