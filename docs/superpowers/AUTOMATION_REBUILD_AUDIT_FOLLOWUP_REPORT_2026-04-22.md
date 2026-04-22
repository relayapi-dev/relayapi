# Automation Rebuild — Audit Follow-Up Report (Plan 5)

**Date:** 2026-04-22
**Plan:** `docs/superpowers/plans/2026-04-22-automation-rebuild-05-audit-followup.md`
**Branch:** `main` (uncommitted)
**Engineer:** Claude Code (Opus 4.7, 1M context)

---

## Executive summary

Plan 5 carved the Plan-4 audit findings (B1-B13 + D1 + a carryover Meta
quick-reply extraction) into three review-gated implementation units:

- **RR7** — tactical refactors (manifest, port-key drift, internal event
  loop cap, etc.). Landed previously.
- **RR8** — correctness work on template builders + action_group error
  routing. Landed previously.
- **RR9** (this report) — seven quick-win audit fixes (Tasks 6, 7, 8, 9,
  10, 12, 14), the Meta quick-reply carryover, and final verification.

All B1-B13 + D1 issues are now closed or explicitly deferred with a tracked
note. **226 automation tests pass (up from 198 at the end of RR8, 107
pre-Plan-4).** Typecheck is clean across the monorepo; the SDK build is
clean; the dashboard test suite has no regressions.

---

## Per-issue status

| ID  | Title                                                        | Status | Unit | Notes |
| --- | ------------------------------------------------------------ | ------ | ---- | ----- |
| B1  | Interactive resume port-key match bug                        | DONE   | RR7  | |
| B2  | Inbox persistence ordering                                   | DONE   | RR7  | |
| B3  | Dedicated `keyword` entrypoint retired in favor of `dm_received` | DONE | RR7 | |
| B4  | Scheduled-trigger idempotency                                | DONE   | RR7  | |
| B5  | No-op tag/field mutations still emitted internal events       | DONE   | RR9  | Task 6 |
| B6  | `webhook_out` HMAC mode silently skipped signing when no secret | DONE | RR9 | Task 7 — now throws; routes via `on_error` |
| B7  | `webhook_receiver` `platform_id` lookup missing org scope    | DONE   | RR9  | Task 8 — joins through `contacts.organizationId` |
| B8  | `start_automation` + `/enroll` ignored target status         | DONE   | RR9  | Task 9 — node `fail` + 422 `automation_not_active` |
| B9  | `follow_to_dm` template persisted unread rate-limit fields    | DONE   | RR9  | Task 10 — stripped + TODO for v1.1 |
| B10 | action_group `error` port was unreachable                    | DONE   | RR8  | |
| B11 | `_input_retries` counter leaked across input resumes         | DONE   | RR9  | Task 12 |
| B12 | Simulator didn't honour `branchChoices` for action_group     | DONE   | RR8  | |
| B13 | Stubbed bindings looked "active" in API responses            | DONE   | RR9  | Task 14 — `warnings[]` with `binding_pending_sync` |
| D1  | Template-builder contract drift                              | DONE   | RR8  | |
| ⏩  | **Meta `message.quick_reply.payload`** extraction (RR7 carryover) | DONE | RR9 | |

---

## Files modified in RR9

### API runtime

- `apps/api/src/services/automations/actions/tag.ts` — read prior `tags[]`;
  skip `tag_applied` / `tag_removed` emission when the mutation was a no-op.
- `apps/api/src/services/automations/actions/field.ts` — skip
  `field_changed` when `field_set` value is unchanged, or when `field_clear`
  had nothing to delete.
- `apps/api/src/services/automations/actions/webhook.ts` — `hmac` auth now
  **throws** `webhook_out: hmac auth requires secret` when secret is
  missing. Error surfaces via the action_group's `on_error` setting.
- `apps/api/src/services/automations/webhook-receiver.ts` — `platform_id`
  contact lookup now joins through `contacts.organizationId` so one tenant's
  webhook cannot resolve another tenant's contact sharing the same
  platform identifier.
- `apps/api/src/services/automations/nodes/start-automation.ts` — loads
  the target automation and returns `result: "fail"` when `status !==
  "active"`. Also returns `fail` if the target belongs to a different org.
- `apps/api/src/services/automations/templates/follow-to-dm.ts` — emitted
  entrypoint config no longer carries `max_sends_per_day`,
  `cooldown_between_sends_ms`, `skip_if_already_messaged`. TODO comment
  flags these for v1.1 rate-limiting work.
- `apps/api/src/services/automations/input-resume.ts` — cleans
  `_input_retries[node.key]` from context after captured/invalid/skip
  resolution. Deletes the whole `_input_retries` key when empty.
- `apps/api/src/services/inbox-event-processor.ts` — added
  `quick_reply.payload` field to the `FacebookMessagingPayload` type;
  normalizers for Instagram + Facebook `messages` / `echo_messages` now
  populate `interactive_payload` from `message.quick_reply.payload`
  (falling back to `postback.payload`). Added `"quick_reply"` to the
  `interactive_kind` enum.

### API routes

- `apps/api/src/routes/automations.ts` — `POST /automations/{id}/enroll`
  returns 422 `{ code: "automation_not_active" }` when the automation's
  status isn't `active`.
- `apps/api/src/routes/automation-bindings.ts` — response schema gained an
  optional `warnings: Array<{ code, message }>` field. `serializeBinding`
  takes an `includeWarnings` opt; create + update routes pass `true` so
  stubbed binding types (`conversation_starter`, `main_menu`,
  `ice_breaker`) return a `binding_pending_sync` warning telling the
  dashboard the platform sync worker ships in v1.1. Helper
  `buildBindingWarnings` is exported for testability.

### Tests

- `apps/api/src/__tests__/automation-event-kinds.test.ts` — two new cases
  under "no-op tag/field mutations skip internal emission": a re-apply
  must NOT re-enroll a `tag_applied` listener, while a fresh tag on an
  untagged contact MUST.
- `apps/api/src/__tests__/automation-action-group.test.ts` — new case
  verifies `webhook_out` with `hmac` auth and missing secret routes via
  the action_group's `on_error: "abort"` error port.
- `apps/api/src/__tests__/automation-webhook-trigger.test.ts` — new case
  seeds two orgs sharing the platform identifier `abc123`; webhook
  resolves only the primary-org contact.
- `apps/api/src/__tests__/automation-runner.test.ts` — new case: a
  `start_automation` node pointing at a `paused` target exits the run via
  `handler_failure` (no error port wired).
- `apps/api/src/__tests__/automation-templates.test.ts` — regression
  asserting the `follow_to_dm` emitted entrypoint config has none of the
  v1.1 rate-limit keys.
- `apps/api/src/__tests__/automation-input-resume.test.ts` — extended the
  "captures a valid email" case to also assert
  `_input_retries.ask_email` is absent from the run context after
  capture.
- `apps/api/src/__tests__/automation-routes.test.ts` — unit test for
  `buildBindingWarnings`: stubbed types return one warning, wired types
  return `undefined`.
- `apps/api/src/__tests__/automation-inbox-pipeline.test.ts` — new
  section "3.6 Meta quick-reply payload" seeds an IG social account +
  IG contact + IG quick-reply graph, fires an `instagram_webhook`
  `messages` event whose `message.quick_reply.payload = "qr_yes"`,
  and asserts the run completes via the `quick_reply.qr_yes` port.

---

## Test counts

| Checkpoint       | Automation tests | Source |
| ---------------- | ---------------- | ------ |
| Pre-Plan-4       | 107              | plan doc |
| Post-Plan-4      | 198              | plan doc |
| Post-RR7/RR8     | 218              | plan doc |
| **Post-RR9**     | **226**          | this run |

Delta RR9: **+8 tests**, all pass.

Dashboard app tests: 197 pass, 0 fail (the "178 + 2 pre-existing failures"
figure from older plans is now moot — the path-alias issues were resolved
earlier in Plan 5).

---

## Verification commands run

- `bun run typecheck` — clean across db, auth, sdk, api, app, docs, cli,
  n8n, zapier.
- `cd packages/sdk && bun run build` — clean.
- `cd apps/api && bun test src/__tests__/automation-*` — 226 pass / 0 fail.
- `cd apps/app && bun test` — 197 pass / 0 fail.

---

## Remaining concerns

1. **Rate-limit fields on `follow_to_dm` template.** The matcher doesn't
   honour `max_sends_per_day`, `cooldown_between_sends_ms`, or
   `skip_if_already_messaged`. The template input still accepts these
   keys (the dashboard UI binds them) but they're dropped before
   persistence. A v1.1 ticket should restore them once the follow-entrypoint
   matcher wires the rate-limit machinery. The template file has a
   prominent TODO block.

2. **Stubbed bindings.** `conversation_starter`, `main_menu`, `ice_breaker`
   are persisted but do not push anything to Messenger / WhatsApp. The
   API response now carries `warnings: [{ code: "binding_pending_sync",
   ... }]` so dashboards can surface this. The actual platform sync
   worker is the next major unit of work.

3. **`start_automation` cross-org safety.** The node now refuses targets
   that don't belong to the current run's organization (returned `fail`
   with a specific error). No cross-org enrollment is possible from a
   flow — but operators can still cross-reference automations inside
   the same org. That's the intended behaviour.

4. **Meta quick-reply interactive_kind label.** The normalizer now sets
   `interactive_kind: "quick_reply"` for IG/FB quick replies, but other
   surfaces (Telegram, WhatsApp) still tag their quick-reply-equivalents
   as `button_click`. The interactive-resume path keys off the payload
   string, not the kind label, so this doesn't affect routing — but
   dashboards that group by `interactive_kind` will see the new value
   for FB/IG only.

---

## Recommended monitoring / v1.1 follow-ups

- **Emit metrics for `tag_add` / `field_set` no-op paths.** A counter
  tagged `automation.no_op.<kind>` would reveal how often action groups
  re-apply redundant state in the wild. Sudden spikes suggest an
  operator loop.
- **Alert on `binding_pending_sync` bindings older than N days.** Once
  the v1.1 sync worker lands, anything still in `pending_sync` is a
  sign the worker is stuck.
- **Add an integration test exercising the full `/v1/automations/{id}/enroll`
  route through the Hono app.** The current RR9 test asserts the
  route-handler logic via the `enrollContact` service path; a real HTTP
  test would also cover auth + workspace scoping.
- **Revisit `follow_to_dm` rate-limiting** alongside the broader
  entrypoint rate-limit subsystem. The stripped config fields are the
  minimum viable UX knobs Manychat exposes; v1.1 should wire them
  end-to-end (matcher + scheduler + telemetry).
- **Snapshot test the Meta normalizer `interactive_payload` extraction.**
  A dedicated table-driven test keyed off the Meta docs' example
  payloads would catch future schema drift (e.g. Threads / Messenger v26
  migrations).

---

*End of report.*
