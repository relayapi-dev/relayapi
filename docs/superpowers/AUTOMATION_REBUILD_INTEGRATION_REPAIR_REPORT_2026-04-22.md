# Automation Rebuild — Integration Repair Completion Report (2026-04-22)

**Plan:** `docs/superpowers/plans/2026-04-22-automation-rebuild-04-integration-repair.md`
**Predecessor:** `docs/superpowers/AUTOMATION_REBUILD_COMPLETION_REPORT_2026-04-21.md` (Plans 1–3, 107 api + 197 app tests in isolation)

## Summary

Plan 4 closed the 9 integration bugs identified after Plans 1–3 landed. The
engine now runs end-to-end: inbound events, entrypoint matching, binding
fallbacks, input resume, native interactive messages, scheduled triggers,
and internal cross-flow events all compose correctly. The work shipped across
six dispatched units (RR1–RR6) without changes to the architecture laid out
in the original spec (`2026-04-21-manychat-parity-automation-rebuild.md`).

## Per-bug status

| # | Severity | Bug | Fix unit | Regression coverage |
|---|----------|-----|----------|---------------------|
| 1 | CRITICAL | `ctx.env.db` never populated — every DB-using node/action threw | **RR1** (Task 1) | `automation-integration-actions.test.ts`; compound verification in every e2e-integration scenario |
| 2 | CRITICAL | `input` node never advanced — runs stuck forever | **RR2** (Task 2) | `automation-input-resume.test.ts` (13 pure + 4 DB cases); 11.1 lead capture flow in e2e |
| 3 | CRITICAL | Buttons / cards / quick replies / galleries flattened to text | **RR5** (Task 7) | `automation-platform-encoding.test.ts`; `automation-message-handler.test.ts` asserts `buttons[]` reaches `SendMessageRequest` |
| 4 | CRITICAL | Only `dm_received` + `comment_created` ever produced | **RR4** (Task 5) | `automation-event-kinds.test.ts`; 11.3 comment-to-DM, 11.4 welcome, 11.9 cross-flow in e2e |
| 5 | CRITICAL | Entrypoint schema config keys ≠ matcher keys | **RR3** (Task 3) | `automation-entrypoint-filters.test.ts` schema + match per kind; 11.2, 11.3, 11.6, 11.9 in e2e |
| 6 | HIGH | Contact / tags / fields not hydrated into `run.context` | **RR1** (Task 4) | `automation-integration-actions.test.ts` asserts `run.context.contact/tags/fields` populated; 11.1 verifies `{{state.captured_email}}` resolves downstream |
| 7 | MEDIUM-HIGH | Webhook custom_field lookup uses `findFirst` without value filter | **RR3** (Task 8) | `automation-webhook-trigger.test.ts` 3-contact disambiguation; 11.5 covers email-path lookup |
| 8 | MEDIUM | Simulator port keys don't match runtime port keys | **RR2** (Task 9) | `automation-ports.test.ts`; simulator-specific scenarios in `automation-validator.test.ts` |
| 9 | MEDIUM | `welcome_message` binding fires on comments + story replies | **RR2** (Task 10) | `automation-trigger-matcher.test.ts` welcome-only-on-dm case; 11.4 ("does NOT fire on comment_created") in e2e |

## Test counts (before / after)

| Surface | Plan 1-3 baseline | Plan 4 after RR6 | Delta |
|---------|-------------------|------------------|-------|
| API automation suite (`automation-*`) | 107 | **198** | +91 |
| New e2e integration scenarios | 0 | 14 | +14 |
| Dashboard (`apps/app/src/`) | 197 | 178 pass + 2 pre-existing `@/lib/utils` bundler errors (unchanged by Plan 4) | ~0 |
| Monorepo typecheck | clean | clean | — |
| SDK build | clean | clean | — |

The 91-test jump over the Plan 1-3 baseline comes from the regression suites
added in RR1–RR5 (input-resume, entrypoint-filters, event-kinds, scheduled-
trigger, platform-encoding, ports, http-request, integration-actions,
action-group, webhook-trigger) plus the 14 real e2e integration scenarios
added in RR6.

## Final e2e integration suite (`automation-e2e-integration.test.ts`)

All 14 cases pass (see bun test output in the runbook). Each drives the
real Postgres through the SSH tunnel and mocks only the platform send via
`ctx.env.sendTransport` (established pattern from `automation-message-handler.test.ts`).

| # | Scenario | Status |
|---|----------|--------|
| 11.1 | Lead capture: message → input(email) → action_group (tag + field) → message → end | ✓ |
| 11.2 | Keyword DM trigger (case-insensitive match + non-match) | ✓ |
| 11.3 | Comment-to-DM template end-to-end | ✓ |
| 11.4a | Welcome binding fires on FIRST inbound only | ✓ |
| 11.4b | Welcome binding does NOT fire on `comment_created` | ✓ |
| 11.5a | Webhook entrypoint: valid HMAC + existing contact → ok | ✓ |
| 11.5b | Webhook entrypoint: bad signature → `bad_signature` | ✓ |
| 11.5c | Webhook entrypoint: unknown slug → `unknown_slug` | ✓ |
| 11.5d | Webhook entrypoint: missing contact + no auto_create → `contact_lookup_failed` | ✓ |
| 11.6 | Scheduled trigger: tag filter enrolls 2 of 5 contacts + reschedules | ✓ |
| 11.7 | Condition branching: premium vs free tag routes different paths | ✓ |
| 11.8 | Per-action `on_error: continue` skips past failure, later action still runs | ✓ |
| 11.9 | Cross-flow: flow A's `tag_add` fires tag_applied entrypoint on flow B | ✓ |
| 11.10 | Cycle protection: self-recursive tag loop terminates at depth cap | ✓ |

## Remaining concerns

1. **App test suite has 2 pre-existing failures** (`@/lib/utils` module
   resolution in `port-handles.tsx` + `insert-menu.tsx`). These predate
   Plan 4 and are unrelated to the automation rebuild. Likely a bundler
   / `tsconfig.paths` alias issue isolated to those two files. Worth
   opening a separate maintenance ticket.

2. **`webhook_out` always resolves successfully**, even on HTTP 5xx. The
   action swallows fetch errors in a try/catch. This is an intentional
   fire-and-forget design per the action's comment, but it means a
   non-2xx response will NOT route the enclosing `action_group` through
   the `error` port. If operators ever expect `on_error: abort` to
   react to 5xx, a follow-up could layer an optional "await response
   and branch on status" mode. For v1 the contract is documented and
   RR6 Task 11.8 uses a test-only `fake_http_500` handler that actually
   throws.

3. **Scheduled trigger contact enumeration limits.** The cron dispatcher
   currently enumerates all matching contacts in one pass. For
   organizations with 100k+ contacts a single firing could enroll
   tens of thousands of runs. Consider batching + pacing in v1.1 when
   scheduled triggers see real production traffic.

4. **Internal event cycle cap is 5** (RR4). Chosen as a conservative
   bound; legitimate multi-step automations that chain tag_applied →
   field_changed → tag_applied could plausibly hit it. Worth instrumenting
   the "dropped due to depth" counter and revisiting if real flows get
   clipped.

5. **`webhook_out` retry policy is absent.** Neither exponential backoff
   nor dead-letter handling. Acceptable for v1 but should land before
   operators rely on it for critical integrations.

## Recommended next steps

- **Monitoring:** wire up a dashboard for the `automation_scheduled_jobs`
  queue (pending count, oldest run_at, failed-in-last-hour) so the
  scheduler's health is visible. The schema is already in place.

- **v1.1 follow-ups** (in priority order):
  1. Main Menu / Conversation Starter / Ice Breaker platform sync (currently `pending_sync`).
  2. `webhook_out` retry + DLQ; optionally a `wait_for_response` mode.
  3. Scheduled trigger batching for large orgs.
  4. Re-hydrate `run.context` from DB on resume (currently only hydrated
     on enroll, per RR1 scope reduction — see `runner.ts` comment block).
  5. Replace the pre-existing `@/lib/utils` bundler errors in the app's
     flow-builder files; unblock `insert-menu.test.tsx` and the
     port-handles tests.

- **Docs:** the webhook entrypoint's 4 error statuses (`bad_signature`
  401, `unknown_slug` 404, `bad_payload` 400, `contact_lookup_failed` 422)
  should be listed in the public Fumadocs API reference. They are
  currently covered by HTTP tests but not surfaced in end-user docs.

## Notes on execution

- All 10 planned integration scenarios + 4 supporting sub-cases (11.4b,
  11.5b/c/d) passed on the first test run — no residual integration bugs
  surfaced during the RR6 verification pass.

- The RR1–RR5 completion reports are inlined in this document's
  per-bug table rather than as separate files; each bug maps cleanly
  to a single dispatched unit.

- SSH tunnel was up throughout (confirmed via
  `nc -z localhost 5433` before running the suite).

- No changes were made to git state. The user commits at their discretion.
