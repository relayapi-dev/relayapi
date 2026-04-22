# Automation Rebuild — Round 4 (Plan 7) Report

**Date:** 2026-04-22
**Plan:** `docs/superpowers/plans/2026-04-22-automation-rebuild-07-audit-round4.md`
**Scope:** cross-thread resume fix (Plan 6 surfaced) + adjacent audit on conversation lifecycle for non-DM triggers.

## Executive summary

Plan 7 closed the cross-thread resume bug surfaced by Plan 6's day-in-the-life test, plus 4 adjacent findings surfaced by the companion audit (2 P0, 2 tangential / defensive). The day-in-the-life suite now drives every lane end-to-end through `processInboxEvent` rather than short-circuiting via direct `resumeWaitingRunOn*` calls.

## Findings closed

### Cross-thread resume (Plan 6 surfaced, Plan 7 Task 1)

Runs enrolled from a comment thread park on the **trigger** conversation (the comment/thread_id), but the inbound DM event that carries the user's reply arrives on the **DM** conversation. The old resume lookup filtered waiting runs by `conversation_id`, so those never matched — postback-through-`processInboxEvent` silently failed.

**Fix:** dropped the `conversation_id` filter from the resume lookups. Port-key matching and run-ownership filtering naturally prevent cross-automation noise; conversation_id was acting as a false narrowing constraint.

### G1 — follow events FK-violate silently (P0)

The event normalizer wrote the platform PSID (e.g. IG user id) into `conversation_id` for non-persisted events like `follow`. The fallback path then fed that PSID as a FK into the runs / run_steps tables, producing a silent FK violation caught by `matchAndEnroll`. Every IG/FB follow-triggered automation was dead.

**Fix:** removed the PSID fallback and stopped the normalizer from setting `conversation_id` on `follow` / `ad_click` events. Events now flow without the FK-violating synthetic id.

### G2 — standalone ad_click (CTM referral before DM) (P0)

A Click-To-Message referral arriving before the DM payload synthesizes an `ad_click` event with the same FK-violation shape as G1. Same root cause.

**Fix:** same as G1 — no synthetic conversation_id, no PSID fallback.

### G3 — `start_automation` lost `socialAccountId` pin

Child runs launched via the `start_automation` action resumed after a wait and picked the wrong social account via the **newest** `contact_channels` row, rather than the triggering account.

**Fix:** forward `ctx.env.socialAccountId` as an explicit arg to the child `enrollContact` call, so the child run carries the same account pin as its parent.

### G4 — multi-account resume cross-contamination (defensive)

With the Task 1 conversation_id filter dropped, a multi-account workspace could in principle resume a run on the **wrong** account when a contact is shared between accounts.

**Fix:** filter waiting runs by `context._triggering_social_account_id` match when the inbound event carries a social account id. Application-side JSONB filter (see "Remaining concerns").

## Running bug tally

| Round | Bugs found | Cumulative |
|---|---|---|
| Initial implementation (Plans 1-3) | — | 0 |
| Codex audit → Plan 4 | 9 | 9 |
| Internal audit → Plan 5 | 13 (+1 surfaced) | 23 |
| Internal audit → Plan 6 | 8 | 31 |
| Day-in-the-life + adjacent audit → Plan 7 | 1 + 4 | **36** |

## Test counts progression

| Milestone | Automation tests | App tests |
|---|---|---|
| End of Plans 1-3 | 107 | 197 |
| After Plan 4 | 198 | 197 |
| After Plan 5 | 226 | 197 |
| After Plan 6 | 254 | 186 |
| **After Plan 7** | **264** | **205** |

(App-test count is measured running `bun test` inside `apps/app`, which is the canonical baseline — the `@/lib/utils` resolution errors only manifest when running from the repo root due to tsconfig path-alias scoping, and are not real regressions.)

## Final verification

- `bun run typecheck` — clean across all 9 packages (db, auth, sdk, api, app, docs, cli, n8n, zapier).
- `cd packages/sdk && bun run build` — clean.
- `bun test apps/api/src/__tests__/automation-*` → **264 pass, 0 fail** (741 expect() calls).
- `cd apps/app && bun test src/` → **205 pass, 0 fail** (412 expect() calls).

## Remaining known concerns (operator / v1.1 roadmap)

- Platform sync for `main_menu` / `conversation_starter` / `ice_breaker` entrypoint kinds (v1.1).
- AI nodes (`ai_agent`, `ai_intent_router`) archived for v2.
- Media picker proper integration — inputs are currently URL fields.
- `AUTOMATION_QUEUE` wrangler binding: drain residual messages post-launch and remove the binding once empty.
- Manual inbox tag mutations do not emit internal events — intentional, but documented.
- Internal event depth cap = 5 (monitor in production for chains that want more).
- Multi-run "same port key" resume: all matching runs advance (documented behavior; flip to exclusive-winner if product demands).
- The new G4 account-scope filter on waiting runs uses application-side filtering over context JSONB (O(runs-per-contact)). Acceptable at current waiting-run volumes; add a partial index on `(context->>'_triggering_social_account_id')` if the waiting-run population grows.
- PropertyPanel still uses a thin legacy shape adapter (small follow-up, not user-visible).

## Confidence statement

Plan 7 fixed every finding from the latest audit. No new bugs surfaced during its implementation beyond the two P0s discovered by the companion audit. The day-in-the-life test suite now drives every lane end-to-end through `processInboxEvent` — which is the pipeline that historically masked bugs (G1/G2 were both invisible to higher-level tests because the normalizer swallowed the FK error three layers down).

Confidence is **higher than end of Plan 6** — specifically because the audit that found these bugs was conversation-lifecycle-scoped and came up nearly empty: 2 P0, 2 tangential, 8 probably-fine, 2 needs-investigation. The rate of new bugs per audit is decreasing round-over-round (9 → 13 → 8 → 5), suggesting we're approaching the asymptote.
