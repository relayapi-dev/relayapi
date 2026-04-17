# Automation Rewrite Audit

Date: 2026-04-17

Scope:
- Compared `docs/AUTOMATION_REWRITE.md` with the current repository state.
- Ran `bun run typecheck` at repo root. It passed across `db`, `auth`, `api`, `app`, `docs`, and `cli`.
- Re-checked external blocker and policy claims against official online sources.

## Verdict

Phase 1 is present in code, but the migration has not been generated yet.

Phase 2 is not safely runnable end-to-end yet. The main blocker is that waiting nodes (`smart_delay`, `user_input`) never advance correctly after the wait/resume step.

Phase 3 routes exist, but the Phase 3 gate in `AUTOMATION_REWRITE.md` is not met:
- the quick-create templates do not create working automations yet;
- the legacy routes still exist and are still mounted;
- the claimed `simulate` endpoint is not implemented.

## High-Confidence Issues

### 1. Critical: waiting nodes re-run themselves forever instead of advancing past the wait

Code refs:
- `apps/api/src/services/automations/runner.ts:52-57`
- `apps/api/src/services/automations/runner.ts:142-170`
- `apps/api/src/services/automations/runner.ts:173-195`
- `apps/api/src/services/automations/nodes/smart-delay.ts:3-13`
- `apps/api/src/services/automations/nodes/user-input.ts:12-33`

Why this is a real bug:
- when a node returns `wait` or `wait_for_input`, the runner stores `currentNodeId` as the waiting node itself;
- on the next queue tick / resume, `advanceEnrollment()` starts from that same node again;
- `smart_delay` computes a new future `next_run_at` every time it runs, so it can loop forever;
- `user_input` parks again every time it runs, so `resumeFromInput()` does not actually move to the next edge.

Impact:
- delays do not complete;
- input capture does not resume the graph;
- the Phase 2 runtime gate is currently not achievable.

### 2. High: scheduler can permanently orphan due ticks when more than 200 are ready

Code refs:
- `apps/api/src/services/automations/scheduler.ts:20-35`
- `apps/api/src/services/automations/scheduler.ts:41-54`

Why this is a real bug:
- the scheduler updates all due `automation_scheduled_ticks` rows to `processing`;
- it then only processes `claimed.slice(0, BATCH_SIZE)`;
- any extra claimed rows past the first 200 are left in `processing` and are never moved back to `pending`.

Impact:
- delayed automations can stall permanently under load.

### 3. High: run-log endpoint does not enforce org or automation ownership

Code refs:
- `apps/api/src/routes/automations.ts:727-774`

Why this is a real bug:
- `GET /v1/automations/{id}/enrollments/{enrollmentId}/runs` only filters by `enrollmentId`;
- it ignores both the `{id}` route param and the authenticated org;
- unlike the other automation routes, it does not verify that the enrollment belongs to the requested automation or the caller’s organization.

Impact:
- log data can leak across automations and potentially across orgs if an enrollment ID is discovered.

### 4. High: automations can become `active` without a published snapshot

Code refs:
- `apps/api/src/routes/automations.ts:393-397`
- `apps/api/src/routes/automations.ts:424-474`
- `apps/api/src/services/automations/trigger-matcher.ts:116-128`
- `apps/api/src/services/automations/runner.ts:42-49`

Why this is a real bug:
- `PATCH /v1/automations/{id}` can set `status: "active"` directly;
- `/resume` also sets status to `active`;
- neither path ensures `publishVersion()` has been called first;
- `matchAndEnroll()` will then create enrollments using `auto.version` / `publishedVersion`;
- the runner fails if that snapshot does not exist.

Impact:
- an automation can look active in the API while being unrunnable at execution time.

### 5. High: quick-create templates do not create working automations yet

Code refs:
- `apps/api/src/routes/automation-templates.ts:206-239`
- `apps/api/src/routes/automation-templates.ts:282-301`
- `apps/api/src/routes/automation-templates.ts:334-369`
- `apps/api/src/routes/automation-templates.ts:400-421`
- `apps/api/src/routes/automation-templates.ts:454-473`
- `apps/api/src/routes/automation-templates.ts:506-543`
- `apps/api/src/services/automations/nodes/index.ts:50-54`
- `apps/api/src/services/automations/nodes/index.ts:73-176`

Why this is a real bug:
- all of the templates create platform-specific send/action nodes such as `instagram_send_text`, `facebook_send_text`, `whatsapp_send_text`, etc.;
- those node types are still stubbed to fail with “not yet implemented (Phase 8)” in the node registry.

Extra mismatch:
- the `follow-to-dm` template is advertised as “DM new Instagram followers”, but it currently creates a `manual` trigger, not a follower trigger.
- code ref: `apps/api/src/routes/automation-templates.ts:406-407`

Impact:
- the current template endpoints can create records, but not “working automations” in the sense claimed by the Phase 3 gate.

### 6. Medium: enrollments list advertises cursor pagination but ignores the cursor

Code refs:
- `apps/api/src/routes/automations.ts:685-724`

Why this is a real bug:
- `cursor` is accepted in the query schema;
- it is never used in the query;
- `next_cursor` / `has_more` are returned, but requesting the next page with that cursor will not change the result set.

Impact:
- pagination is misleading / broken for enrollments.

### 7. Medium: `reentry_cooldown_min` is stored but never enforced

Code refs:
- `apps/api/src/routes/automations.ts:179-180`
- `apps/api/src/routes/automations.ts:401-402`
- `apps/api/src/services/automations/trigger-matcher.ts:104-113`

Why this is a real bug:
- the create/update API persists `reentry_cooldown_min`;
- the matcher only checks `allowReentry`;
- there is no cooldown-time comparison before re-enrollment.

Impact:
- behavior does not match the exposed API contract.

## Status/Plan Mismatches

### Legacy routes are still mounted

`AUTOMATION_REWRITE.md` says the old routes are deleted by Phase 3 and the Phase 3 gate says they should return 404.

Current code still mounts them:
- `apps/api/src/index.ts:202`
- `apps/api/src/index.ts:206`
- `apps/api/src/index.ts:211`
- `apps/api/src/index.ts:218`

That means `/v1/inbox/rules`, `/v1/comment-automations`, `/v1/sequences`, and `/v1/engagement-rules` are still live.

### The migration is still pending

The new schema exists in `packages/db/src/schema.ts`, but there is no new Drizzle migration containing the automation tables/enums under `packages/db/drizzle/`.

This part of the plan is accurate: user action is still required for migration generation/application.

### The `simulate` endpoint is mentioned but not present

`AUTOMATION_REWRITE.md` says `POST /v1/automations/:id/simulate` exists in schema and only handler wiring is deferred.

I could not find a `simulate` route or schema entry under:
- `apps/api/src/routes/automations.ts`
- `apps/api/src/schemas/automations.ts`

### The pgvector blocker is stale for the current code

`AUTOMATION_REWRITE.md` lists “pgvector extension enabled on Hyperdrive Postgres” as a blocker for the AI Knowledge Base.

Current schema explicitly does not require that yet:
- `packages/db/src/schema.ts:3442-3444`
- `packages/db/src/schema.ts:3514`

The code stores embeddings as `real[]` for now and defers pgvector to a follow-up.

## External Verification Notes

### Reddit

Verified:
- commercial Reddit API/data use requires explicit written approval / a separate agreement.

Official sources:
- Reddit Responsible Builder Policy: https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy
- Reddit Developer Terms: https://redditinc.com/policies/developer-terms

Relevant points:
- commercial use needs explicit written approval;
- monetized use requires a separate agreement with Reddit.

### LinkedIn

Verified:
- LinkedIn API permissions commonly require explicit approval;
- Community Management API requires product access / tier approval;
- `r_member_social` is currently a closed permission and Microsoft says they are not accepting access requests;
- in Development tier, social-action webhooks are disabled.

Official sources:
- Getting Access to LinkedIn APIs: https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access
- Community Management API migration guide: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-api-migration-guide?view=li-lms-2026-04
- Social Metadata API: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/social-metadata-api?view=li-lms-2025-11

Implication for the rewrite:
- the blocker is real, and member-level LinkedIn social reads are actually harder than the plan suggests because `r_member_social` is closed right now.

### Google Business Profile

Verified:
- API access still requires approval through the GBP API contact form;
- notifications are delivered through Cloud Pub/Sub;
- `DUPLICATE_LOCATION` and `VOICE_OF_MERCHANT_UPDATED` are valid notification types;
- Q&A notification types are deprecated because the Q&A API was discontinued on 2025-11-03.

Official sources:
- Prerequisites: https://developers.google.com/my-business/content/prereqs
- Notification setup: https://developers.google.com/my-business/content/notification-setup
- NotificationSetting reference: https://developers.google.com/my-business/reference/notifications/rest/v1/NotificationSetting

Additional policy risk:
- Google’s third-party policy says agencies/end-clients cannot programmatically use your Business Profile project through your own API; automatic/programmatic use by end-clients requires their own GBP project.

Official source:
- Business Profile APIs policies: https://developers.google.com/my-business/content/policies

Implication for the rewrite:
- “contact-form approval” is correct, but it is not the only blocker. There is also a product/policy constraint around third-party automation/proxying.

### Meta / Instagram / Messenger

Verified:
- Meta’s official Instagram API material says the `HUMAN_AGENT` tag allows responses within 7 days of the person’s message;
- apps must apply for the `Human Agent` permission;
- automated messages are explicitly disallowed for this tag.

Official source:
- Meta official Postman workspace, “Send a message with HUMAN_AGENT tag”: https://www.postman.com/meta/documentation/23987686-9386f468-7714-490f-9bfc-9442db5c8f00?entity=request-23987686-23eacf45-3728-4e41-bcc7-6d164959327c

Implication for the rewrite:
- the blocker text in `AUTOMATION_REWRITE.md` is too loose. `HUMAN_AGENT` does not simply unlock automated post-24h sends. Per Meta’s own docs, it is for human-agent support and automated messages are disallowed.

### Hyperdrive / pgvector

Verified:
- Hyperdrive supports existing Postgres databases; it is a connectivity layer, not the mechanism that installs pgvector;
- pgvector itself still requires the database extension to be installed and enabled with `CREATE EXTENSION vector`.

Official sources:
- Cloudflare Hyperdrive overview: https://developers.cloudflare.com/hyperdrive/
- pgvector: https://github.com/pgvector/pgvector

Implication for the rewrite:
- pgvector is a database-side requirement, not really a “Hyperdrive feature” blocker. More importantly, the current code has already avoided that blocker by storing embeddings as `real[]`.

## Recommended Order of Fixes

1. Fix wait/resume semantics in the runner before adding more automation features.
2. Fix scheduler claiming so delayed ticks cannot get stranded.
3. Add org + automation ownership checks to the run-log endpoint.
4. Prevent `active` status unless a published snapshot exists, or auto-publish on activation.
5. Either downgrade the template/gate claims in `AUTOMATION_REWRITE.md` or implement the missing platform node handlers first.
6. Update `AUTOMATION_REWRITE.md` to reflect the real external constraints, especially Meta `HUMAN_AGENT`, LinkedIn `r_member_social`, and GBP third-party policy limits.
