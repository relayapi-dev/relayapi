# RelayAPI production-readiness deep audit

**Audit date:** 2026-07-12  
**Repository:** `/Users/zank/Developer/majestico/relayapi`  
**Focus:** irreversible schema mistakes, tenant isolation, data lifecycle, external side-effect correctness, crash recovery, and production migration safety  
**Decision:** **Do not treat the current repository migration history or external-side-effect pipeline as production-safe yet.**

## Executive conclusion

The repository has a strong amount of defensive code, good test coverage for ordinary request behavior, and several recent fixes for previously identified performance problems. Typecheck and the functional suites pass; the API's wall-clock performance thresholds were not stable on the final rerun, as recorded below. Even a fully green ordinary suite would not be enough for production readiness because the most consequential defects live between components: database-to-Queue handoffs, Queue-to-platform calls, tenant IDs stored as independent foreign keys, deletion cascades, and migration history.

This audit found **eight release blockers** and **twelve high-priority production risks**. The two most urgent facts are independently reproducible:

1. A fresh database cannot apply the checked-in migration chain through migration `0035`; `automation_run_status` and the automation tables are created twice.
2. If the live database followed the `0032` branch, `automation_step_runs` has no partition accepting timestamps on or after **2026-08-01**. The audit date is 2026-07-12.

The migration conflict also means the repository cannot prove the live database's automation schema. A database that received `0032` has a partitioned step-run table. A database that received `0035` has a non-partitioned table. The required SSH tunnel was unavailable during this audit, so the live ledger and catalog could not be compared. That inspection is the first deployment gate, not an optional follow-up.

The next systemic issue is that many rows independently store `organization_id`, `workspace_id`, and related resource IDs. Ordinary foreign keys prove that each ID exists, but not that the IDs belong to the same tenant. Several routes then rely on ID secrecy or partial route-level checks. This is already exploitable in manual automation enrollment, legacy WhatsApp broadcasts, ad analytics, nested bulk posts, and direct-ID routes used with workspace-scoped API keys.

Finally, publishing and messaging make irreversible external calls without a durable, idempotent state machine spanning the database and Cloudflare Queues. Cloudflare Queues are explicitly at-least-once, so duplicate delivery is expected behavior, not an edge case. The current compare-and-swap logic prevents one narrow concurrent race but cannot distinguish "not sent" from "provider accepted, Worker died before persistence." That ambiguity can create duplicate social posts, duplicate broadcast messages, duplicate automations, or permanently stranded work.

## What “no performance regression” can honestly mean

A literal guarantee that an integrity fix cannot influence performance in any way is impossible. A unique index has write-maintenance cost; a foreign key performs a check; durable acceptance requires a write or Queue operation. Claiming otherwise would be misleading.

The remedies below are designed around a stricter practical rule:

- do not add serial network calls to normal user-facing read paths;
- fold authorization predicates into queries that already run;
- use batched validation rather than per-row checks;
- move retries and reconciliation off request paths;
- let deduplication reduce duplicate work;
- use indexes that also serve the lookup path they protect;
- confine extra work to failure, migration, deletion, or background paths where possible;
- for the few correctness boundaries that require one durable write, benchmark and gate the change before rollout.

Performance classifications used below:

- **A — improves or is effectively neutral:** removes duplicate work, narrows an existing query, or changes only CI/deployment.
- **B — no normal hot-path regression expected:** adds work only to background, failure, deletion, or rare cache-miss paths.
- **C — correctness requires a measured write/coordination cost:** cannot honestly be zero-cost; must pass a p50/p95/p99 and throughput gate before production.

## Release blockers

### F-01 — CRITICAL: the migration chain is not replayable and permits two incompatible automation schemas

**Evidence**

- The journal orders `0030` through `0035` sequentially: `packages/db/drizzle/meta/_journal.json:215-255`.
- `0030_drop_legacy_automations.sql:2-20` drops the legacy automation tables and types.
- `0031_automation_enums.sql:1-4` creates `automation_run_status`.
- `0032_automation_tables.sql:2-165` creates the replacement automation tables, including a partitioned `automation_step_runs`.
- `0035_early_songbird.sql:1-68` creates `automation_run_status`, `automation_entrypoints`, `automation_runs`, `automation_scheduled_jobs`, and `automation_step_runs` again.
- `0035` was generated from a different snapshot lineage; there are no equivalent snapshots for the hand-written `0030`–`0034` branch.

**Reproduction**

A temporary local PostgreSQL 17 database was created, the repository's required `auth` schema bootstrap was applied, and the SQL files were manually replayed in journal order to isolate the first bad file. Migrations `0000` through `0034` succeeded in that diagnostic replay. `0035_early_songbird.sql:1` failed deterministically with:

```text
ERROR: type "automation_run_status" already exists
```

Therefore an empty database cannot reach `0041` from this repository. The actual Drizzle PostgreSQL migrator wraps the unapplied batch in a transaction, so a real run starting before `0030` should fail at `0035` and roll back that pending batch; it must not be assumed to leave a durable database at `0034`. An existing environment at `0041` must have skipped, backfilled, or otherwise altered one branch or its migration ledger. Repository code alone cannot establish which physical schema is live.

**Production consequence**

- Disaster recovery into a clean database is broken.
- A new environment cannot be provisioned reproducibly.
- A future migration can be authored against the wrong physical table shape.
- Blindly repairing the ledger can either rerun destructive SQL or mark unapplied DDL as applied.

**Safe remediation**

1. Freeze schema deployment.
2. Back up the live database and verify restore before changing any ledger or DDL.
3. Inspect `drizzle.__drizzle_migrations`, `pg_class`, `pg_constraint`, `pg_indexes`, and `pg_partitioned_table` through the required tunnel.
4. If there is no authoritative production data, replace the historical chain with one canonical baseline and prove empty install plus schema introspection in CI.
5. If authoritative data exists, do not rewrite the live ledger blindly. Create a handwritten append-only reconciliation migration after `0041`, based on the observed catalog. Drizzle snapshots do not model the partitioning difference, so generated diffs are insufficient here.
6. A migration after `0041` helps only databases whose ledgers already passed `0041`; a clean database still dies at `0035`. Define and test a separate supported clean-install baseline.
7. If any authoritative environment still contains pre-`0030` automation data, do not run the unconditional `DROP TABLE ... CASCADE`. Export/transform that data or obtain an explicit, documented loss decision first.
8. Add CI that provisions empty PostgreSQL, bootstraps `auth`, applies every migration, and compares the catalog to the intended Drizzle schema.

**Performance:** A. Deployment/CI only; no runtime cost.

### F-02 — CRITICAL: the partitioned automation branch stops accepting writes on 2026-08-01

**Evidence**

- `0032_automation_tables.sql:115-130` partitions `automation_step_runs` by `executed_at`.
- `0032_automation_tables.sql:132-144` creates only April, May, June, and July 2026 partitions. The last upper bound is `2026-08-01`.
- There is no default partition and no migration, cron, or administrative job that creates later partitions.
- `packages/db/src/schema.ts:2810-2814` acknowledges that future partitions must be added.
- The automation runner writes a step result after executing the node side effect (`apps/api/src/services/automations/runner.ts:190-204` and the later insert path around `:800`).

**Production consequence**

If production has the `0032` shape, the first step-run insert on or after 2026-08-01 UTC fails with “no partition of relation found.” A message/contact mutation can already have happened before the log insert fails; retry can then repeat that external action.

**Safe remediation**

1. First determine whether the live table is partitioned; the migration split makes this conditional but urgent.
2. If partitioned, pre-create a long future horizon before August; only then add a default partition as an emergency buffer.
3. Add automated partition creation at least six months ahead plus an alert when the horizon falls below 60 days or the default partition receives any row.
4. Rehearse the default-partition evacuation procedure. Once the default contains timestamps for a future month, attaching the normal monthly partition can scan/lock or fail because of overlapping rows; detach/evacuate/create/reattach under a controlled maintenance plan.
5. Do not let a step-log failure blindly retry an already-completed external node action; use the side-effect state model in F-05.

**Performance:** A/B. Proper future partitions preserve pruning. The default partition is an emergency buffer, not the steady-state destination.

### F-03 — CRITICAL: tenant ownership is not encoded in relational keys

The dominant schema pattern stores tenant and resource IDs independently. For example, `automation_runs` has separate FKs for organization, automation, contact, entrypoint, binding, and conversation (`packages/db/src/schema.ts:2749-2773`). These constraints prove existence, not common ownership.

**Confirmed exploit paths**

1. **Manual automation enrollment**
   - `apps/api/src/routes/automations.ts:998-1032` scopes the automation but passes caller-supplied `contact_id`, `entrypoint_id`, and `social_account_id` directly to `enrollContact`.
   - `apps/api/src/services/automations/runner.ts:589-592` hydrates the contact by ID alone.
   - `apps/api/src/services/automations/runner.ts:438-451` writes a caller-organization run referencing that foreign contact.
   - `apps/api/src/services/automations/nodes/message.ts:289-319` resolves the contact channel and social account/token without an organization predicate.
   - The result can expose foreign contact context and send using another tenant's connected account.

2. **Legacy WhatsApp broadcasts**
   - `whatsapp_broadcasts.organization_id` and `social_account_id` are independent (`packages/db/src/schema.ts:1293-1299`).
   - The still-live create route accepts `account_id` and inserts it without ownership validation (`apps/api/src/routes/whatsapp.ts:892-923`).
   - The processor loads the account/token by account ID alone (`apps/api/src/services/whatsapp-broadcast-processor.ts:154-165`).

3. **Automation relationship actions**
   - Segment and subscription actions accept arbitrary related IDs (`apps/api/src/services/automations/actions/segment.ts:18+`, `subscription.ts:53+`).
   - Contact-channel creation can associate a contact with a globally valid social account without proving shared tenant/workspace (`apps/api/src/routes/contacts.ts:857+`).

Random 128-bit IDs reduce accidental discovery, but ID secrecy is not authorization.

**Safe remediation**

1. Immediately add tenant/workspace predicates to the exposed application paths.
2. Audit existing mismatches with joins; quarantine ambiguous rows rather than deleting them.
3. Add parent uniqueness on `(id, organization_id)` and, where appropriate, `(id, organization_id, workspace_id)`.
4. Add matching composite foreign keys from child rows. For relation tables, carry `organization_id` explicitly and constrain both parents to it.
5. Stage large constraints with supporting indexes, `NOT VALID`, then `VALIDATE CONSTRAINT`; enforce application writes before validating old rows.
6. Add invariant tests that deliberately mix IDs from two organizations and two workspaces.

The contact predicate can be folded into the current hydration query. Entrypoint/account/segment/list relationships require query restructuring, such as a joined authorization query or `INSERT ... SELECT`; they can still be validated in one round trip rather than N per ID. Composite indexes can also serve authorization joins.

**Performance:** C for database enforcement because indexes/FKs add small write cost; A for folding predicates into existing reads. This cost must be measured, not denied.

### F-04 — CRITICAL: organization/workspace authorization is bypassable on several ID-addressed paths

This is distinct from F-03. Even where organization ownership is checked, workspace-scoped API keys are intended to be capabilities for only selected workspaces. Global middleware sees only a caller-supplied query or top-level body `workspace_id` (`apps/api/src/middleware/permissions.ts:49-115`, `workspace-validation.ts:25-63`). It cannot authorize the actual workspace of an ID-addressed row.

**Confirmed paths**

- **Cross-organization ad analytics:** `GET /v1/ads/{id}/analytics` does not read `orgId` (`apps/api/src/routes/ads.ts:825-875`). Stored metrics query only `ad_id` (`apps/api/src/services/ad-analytics.ts:101-131`). The live path loads the ad/account/token only by ad ID (`:193-223`) and calls the provider. Any authenticated tenant with a leaked ad ID can read spend/conversion data and force a live request using the victim token.
- **Workspace-scoped direct-ID routes:** broadcast get/update/recipient/schedule/cancel (`routes/broadcasts.ts:421-491,532-710,785-885`), auto-post get/update/activate/pause (`routes/auto-post-rules.ts:387-579`), custom-field update (`routes/custom-fields.ts:251-279`), media get/delete (`routes/media.ts:486-581`), and ad/campaign reads or mutations (`routes/ads.ts:559-633,1383-1489`) generally check organization but not the API key's permitted workspace. Ad mutations can change budgets/status or cancel a live ad in another workspace of the same organization.
- **Nested bulk workspaces:** middleware reads only top-level `body.workspace_id`, while `POST /posts/bulk` stores each `posts[].workspace_id` directly (`routes/posts.ts:451-470,2607-2675`). A scoped key can pass an allowed query workspace while nesting another workspace; an all-workspace key can even reference a foreign organization's workspace because the DB stores independent organization/workspace FKs.
- **CSV posts:** a `workspace_id` query can satisfy middleware, but the handler stores `workspaceId: null` (`routes/posts.ts:3781-3786`), creating records a scoped key cannot later access while “now” publication still proceeds.

**Safe remediation**

- Centralize `loadAuthorized<Resource>` helpers that add organization and `workspace_id IN key_scope` to the existing SELECT/UPDATE.
- Pass organization and scope into both stored and live ad-analytics service methods.
- Recursively collect bulk workspace IDs and validate them in one batched query; handlers must consume the validated set.
- Add the composite relational guarantees from F-03.
- Generate a route-matrix test: all direct-ID methods × all-workspace key × allowed scoped key × denied scoped key × foreign organization.

**Performance:** A. These are predicates on existing queries or one batch validation per bulk request; they reduce returned rows and unwanted provider calls.

### F-05 — CRITICAL: external publication has no crash-safe, idempotent state machine

Cloudflare documents that Queues use **at-least-once delivery** and recommends stable IDs/idempotency for duplicate-sensitive work: [Cloudflare Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).

**Three independent failure windows exist**

1. **Claim is immediately reclaimable**
   - `publishPostById` accepts both `scheduled` and `publishing` (`apps/api/src/services/publisher-runner.ts:448-479`).
   - A duplicate that reads after the first claim sees the new timestamp and can successfully claim the fresh `publishing` row again. The timestamp CAS only excludes consumers that read the same old value.

2. **Provider accepted, DB did not record it**
   - Platform calls occur before provider results are persisted (`publisher-runner.ts:132-243`, flush around `:270-271`; thread equivalent `thread-publisher.ts:160-279`).
   - If the Worker dies or the DB update fails after provider acceptance, redelivery sees an actionable target and republishes. The system cannot distinguish “request never reached provider” from “post is live but result is unknown.”

3. **DB state commits before Queue acceptance**
   - Scheduler changes posts to `publishing` before enqueue (`services/scheduler.ts:41-58`) and discards every `sendBatch` failure using `Promise.allSettled` (`:113-119`). Its selector only sees `scheduled`, so those rows are stranded.
   - Immediate create/update/retry/bulk/CSV use detached `waitUntil(PUBLISH_QUEUE.send(...))` after state is committed (`routes/posts.ts:1845-1858,2268-2281,2513-2544,2704-2720,3827-3840`).
   - Thread creation also commits before Queue send.

Terminal publish retries can mark a post failed even when the provider side effect may already be live (`queues/publish.ts:145-168`), and the publish queue has no DLQ (`wrangler.jsonc:163-167`).

**Safe remediation**

- Introduce explicit `queued`, `in_flight`, `succeeded`, `failed`, and `unknown` target attempt states.
- Give every target a stable `publish_operation_id`, `attempt_id`, `claimed_at`, and lease expiry.
- A normal consumer may claim only `queued`; only an expired pre-request lease may be automatically reclaimed.
- Once request transmission may have happened, interruption becomes `unknown`, not automatically retryable. Reconcile with the provider or require explicit/manual resolution when the provider lacks lookup/idempotency support.
- Send the stable operation ID to provider idempotency mechanisms wherever supported.
- Add a transactional outbox row in the same transaction as post/target state. A background dispatcher performs Queue sends and marks outbox rows dispatched.
- Add a DLQ plus a replay tool that respects `unknown` states.

The outbox insert can be batched into the existing transaction. It replaces the unsafe handoff; it should not add a serial provider call to the request path.

**Performance:** C for one local outbox insert; B/A afterward because Queue dispatch remains asynchronous and duplicate platform work falls.

### F-06 — CRITICAL: the SDK and request model can create duplicate posts before Queue processing even starts

**Evidence**

- The SDK defaults to two retries (`packages/sdk/src/client.ts:545-577`).
- It retries connection failures and 408/409/429/5xx for all HTTP methods (`client.ts:767-795,920-940`).
- `RequestOptions.idempotencyKey` exists, but `Relay.idempotencyHeader` is never assigned; the header is emitted only if that property exists (`client.ts:1035-1039`).
- The API has no idempotency ledger, and CORS allows only `Authorization` and `Content-Type` (`apps/api/src/app.ts:97-105`).
- A lost response after post creation can make the SDK repeat the POST and create another post/outbox job.
- Independently, target resolution deduplicates literal selector strings, not resolved account IDs (`services/target-resolver.ts:55-65`). `['twitter', 'acc_X']` or `['twitter', 'ws_A']` can create two rows for one account. `post_targets` has no unique `(post_id, social_account_id)` (`packages/db/src/schema.ts:473-501`), and the publisher processes every row.

**Safe remediation**

1. Immediately disable automatic retries for unsafe SDK methods unless explicitly opted in.
2. Add a server idempotency ledger keyed by `(organization_id, idempotency_key)`, with request hash, state, resource ID, and replayable response metadata.
3. Only then wire `Idempotency-Key` through SDK and CORS.
4. Deduplicate resolved targets by account ID before persistence.
5. Audit current duplicate targets, preserve distinct already-published remote IDs in an audit/reconciliation table, consolidate, then add unique `(post_id, social_account_id)`.

**Performance:** A/B. Disabling unsafe retries and in-memory dedup reduce work. The ledger requires one indexed write for opted-in mutations but prevents whole duplicate requests; benchmark under the write workload.

### F-07 — CRITICAL: inbound platform events are acknowledged before durable acceptance and can rerun side effects after dedup

**Acknowledgement gap**

Facebook/Instagram, YouTube, WhatsApp, Telegram, and SMS handlers verify the request, place the real work in `executionCtx.waitUntil`, and return 2xx first (`apps/api/src/routes/platform-webhooks.ts:246-274,644-652,747-755,872-882,1007-1018`). Account lookup, normalization, and Queue sends happen later. If any of that fails, the provider has already received success and will not retry. `waitUntil` extends work after the response but is not a durable acceptance log; see [Cloudflare Context API](https://developers.cloudflare.com/workers/runtime-apis/context/).

**Deduplication gap**

- `inbox_messages` correctly has unique `(conversation_id, platform_message_id)` (`packages/db/src/schema.ts:1175-1178`).
- `insertMessage` returns `null` on conflict (`services/inbox-persistence.ts:192-228`).
- `inbox-event-processor.ts:451-467` ignores that return value, then still dispatches automation (`:489-510`), customer webhook, and realtime work (`:532-576`). A duplicate provider/Queue event can therefore run auto-replies and automation actions again even though the message row is deduplicated.

**Terminal loss**

The inbox consumer explicitly ACKs at its local attempt threshold and has no DLQ (`queues/inbox.ts:6-35`, `wrangler.jsonc:183-186`). A short database outage can permanently discard inbound messages.

**Safe remediation**

- After signature verification, synchronously await one raw-event Queue send or one `inbound_webhook_events` insert before returning 2xx; return a retryable non-2xx if durable acceptance fails.
- Move account lookup, normalization, and fan-out to the raw-event consumer.
- Key the raw inbox by provider/account/event ID and retain payload, signature metadata, received time, attempts, and processing state.
- If message insertion conflicts, skip downstream side effects. For non-message events, use the raw-event ledger as the dedup boundary.
- Add an inbox DLQ, alerting, and controlled replay. Do not manually ACK infrastructure failures at the configured retry limit.

One binding operation is the minimum correctness boundary. It adds provider-facing acknowledgement latency but removes multiple DB/KV/fan-out operations from the request and should improve tail reliability.

**Performance:** C for the one awaited durable accept; likely A for total work/tail latency after moving normalization off-request. Must be benchmarked against provider timeout budgets.

### F-08 — CRITICAL: deletion semantics can erase history, leave live work running, or half-delete a tenant

There is no coherent lifecycle distinction between disconnecting credentials, deleting a workspace, deleting a tenant, and deleting historical data.

**Connected-account deletion erases durable history**

- The account delete endpoint calls `deleteConnectedAccountGraph` (`apps/api/src/routes/accounts.ts:576-609`).
- The helper transaction deletes every `post_target`, ad, campaign, audience, sync log, and finally `social_accounts` (`apps/api/src/lib/delete-account.ts:78-112`).
- Cascades additionally erase inbox conversations/messages, broadcasts, external posts, contact channels, bindings, analytics, and related history (examples at `packages/db/src/schema.ts:1067-1069,1549-1551,1991-1993`).

Disconnecting OAuth credentials should not destroy published URLs/IDs, inbox history, ad history, or compliance records.

**Workspace deletion leaves external work active**

- Workspace deletion only changes scheduled posts to drafts, then deletes the workspace (`routes/workspaces.ts:290-325`).
- Auto-post rules, broadcasts, and automations use `ON DELETE SET NULL` (`schema.ts:1237-1239,1546-1548,2613-2615`). Their background selectors do not require a workspace, so active RSS publishing, broadcasts, and automations can continue after deletion.

**Organization deletion is non-transactional and normally fails after destructive partial work**

- Admin deletion removes subscription and member rows before deleting the organization (`apps/app/src/pages/api/admin/organizations.ts:328-369`).
- Most business tables reference the organization with restrictive/default behavior, so a non-empty organization makes the final delete fail.
- The organization is left without subscription/members while its data remains. API-key organization linkage is not a DB FK, so revocation/cleanup is not structurally guaranteed.

**Safe remediation**

- Make `social_accounts` a durable identity. Mark it `disconnecting` and exclude it from all active work, durably attempt/reconcile provider revocation, then clear credentials and mark it `disconnected`. Do not erase the only token before remote revocation succeeds; a forced local disconnect should retain a protected revocation-retry record until token expiry.
- Split durable identity/history from replaceable credential material.
- Implement workspace deletion as a transaction/state machine that pauses/cancels every operational child before final deletion. Use `RESTRICT`/`CASCADE` for live configuration and `SET NULL` only for immutable history.
- Implement tenant deletion as `active -> deleting -> tombstoned/purged`: revoke keys and KV, stop external work, export/retain required financial/compliance records, delete owned data in an explicit graph, and use an outbox for Stripe/R2/platform cleanup.
- Never indiscriminately change every FK to cascade.

**Performance:** B. These are rare administrative paths. Active-account partial indexes can keep ordinary queries as selective as today.

## High-priority production risks

### F-09 — HIGH: post mutations are not atomic and can return failure after committing destructive state

- PATCH updates the parent post first (`routes/posts.ts:2181-2186`), resolves targets afterward, and can return `400 NO_VALID_TARGETS` (`:2188-2212`). A request can therefore return failure after changing a post to `publishing`, without enqueueing it.
- Bulk create inserts the post and targets in separate operations (`:2668-2702`) and catches errors (`:2749-2751`), leaving parent rows or partial state.
- Delete removes children outside a transaction (`:2389-2397`) even though the schema already defines cascades; a later failure returns 500 after data loss.

**Remediation:** resolve/validate before mutation; update parent and replace targets in one transaction; insert bulk parent/targets/outbox atomically; delete the parent and rely on verified cascades. **Performance:** A — no additional queries and parent-only deletion is cheaper.

### F-10 — HIGH: broadcasts and customer webhooks have ambiguous duplicate/loss windows

**Broadcasts**

- Recipients are marked `sending`, the external send occurs, and the result is stored afterward (`services/broadcast-processor.ts:193-291`; WhatsApp equivalent `whatsapp-broadcast-processor.ts:188-275`).
- A stale sweep resets `sending` to `pending` (`broadcast-processor.ts:135-164`). If the provider accepted before a crash, that reset duplicates the send.
- An ordinary exception marks the whole broadcast `failed` (`:61-76`), so remaining pending recipients are abandoned.

**Customer webhooks**

- Delivery tries three times inline, then only logs (`services/webhook-delivery.ts:92-143`); per-endpoint failures are swallowed by `Promise.allSettled` (`:148-180`).
- The business state can be committed before fan-out, and no durable logical event/per-endpoint delivery record guarantees replay. A redispatch generates a new delivery ID, weakening receiver deduplication.

**Remediation:** use stable recipient/delivery operation IDs and `pending/in_flight/succeeded/unknown/failed`; never reset an attempted unknown outcome blindly; write logical webhook event plus unique per-endpoint deliveries transactionally with business state; Queue delivery with backoff and stable IDs. **Performance:** C for a batched outbox write, A for publish latency because inline webhook HTTP retries move out of the publisher.

### F-11 — HIGH: webhook signing secrets have a non-recoverable dual-write failure

- The endpoint row stores only a hash (`packages/db/src/schema.ts:591-620`).
- Creation inserts Postgres first, then writes the only encrypted raw secret to KV (`routes/webhooks.ts:302-334`).
- Delivery reads KV; when missing, it deliberately sends unsigned (`services/webhook-delivery.ts:56-89`).

A DB success/KV failure leaves an enabled endpoint that can never sign. KV loss or delayed visibility has the same effect.

**Remediation:** add encrypted recoverable secret ciphertext/key version to Postgres as source of truth; backfill from KV; disable/rotate endpoints whose secret cannot be recovered; optionally cache in KV; never downgrade silently to unsigned. A DB fallback is only a cache-miss path, or eliminate the KV read entirely if the endpoint row already carries ciphertext. **Performance:** A/B — can remove a KV read from delivery.

### F-12 — HIGH: contact deletion creates orphans and the consent schema cannot prove channel consent

**Referential defect**

- `contact_subscriptions.contact_id` has no FK (`packages/db/src/schema.ts:3007-3023`).
- `broadcast_recipients.contact_id` also lacks a FK (`schema.ts:1590+`).
- Normal contact deletion deletes only the contact (`routes/contacts.ts:767-793`). Merge code explicitly works around the missing subscription FK (`:1392-1407`).

**Consent defect**

- Consent is one global boolean that defaults true (`schema.ts:1471+`; create route `contacts.ts:638+`).
- There is no channel, purpose, source, timestamp, evidence, policy version, or jurisdiction.
- Broadcast contact resolution does not filter the global opt-in (`broadcasts.ts:583-598`).

**Remediation:** clean existing subscription orphans, add `ON DELETE CASCADE`; null orphan recipient contact IDs then add `ON DELETE SET NULL`; introduce a consent event/current-state model keyed by contact, channel, and purpose. Preserve and classify any auditable import/provider evidence before treating otherwise-unproven true values as `legacy_unknown`; never invent consent timestamps during backfill. Define enforcement for contact recipients, raw phone/identifier APIs, legacy WhatsApp broadcasts, automations, and direct sends. Use an indexed current-state table and enforce bulk consent while constructing work, not once per provider send. **Performance:** A/B — the subscription PK already begins with `contact_id`; indexed bulk consent resolution stays off the per-send path.

### F-13 — HIGH: external identity keys are not unique, enabling split-brain billing and ad state

- `ad_campaigns.platform_campaign_id` and `ads.platform_ad_id` have ordinary indexes only (`schema.ts:1758+,1827+`). Ad sync performs prefetch/check then insert (`services/ad-sync.ts:112-170,261+`), so concurrent cron/manual sync can create duplicate representations of one remote object.
- `organization_subscriptions.stripe_customer_id` and `stripe_subscription_id` are non-unique (`schema.ts:770-788`). Webhooks use `.limit(1)` lookups (`routes/stripe-webhooks.ts:133-140,203-211`), so a duplicate maps a payment event to an arbitrary organization.

**Remediation:** reconcile duplicates without deleting history; reparent metrics/children; add partial unique `(ad_account_id, platform_campaign_id)` and `(ad_account_id, platform_ad_id)` where non-null; add partial unique Stripe customer/subscription indexes; replace ad sync check-then-insert with `ON CONFLICT DO UPDATE`. On populated tables, build unique indexes in a separately controlled out-of-transaction `CREATE UNIQUE INDEX CONCURRENTLY` phase, then attach/enforce constraints in the append-only migration; the normal Drizzle migration transaction cannot run concurrent index creation and a normal blocking build can stop writes. **Performance:** A/C — identity lookups become faster; remote-object writes pay normal unique-index maintenance.

### F-14 — HIGH: billing state lacks a durable, ordered event model and disagrees about what “Pro” means

- Stripe dedup is a KV get-then-put (`routes/stripe-webhooks.ts:61-87`), not an atomic durable event receipt.
- Subscription/invoice events are applied in arrival order with no stored Stripe event/object version (`:203-257,344-435`). A delayed older payment-failed event can regress a newer paid/active state. Stripe does not guarantee webhook ordering; see [Stripe webhook best practices](https://docs.stripe.com/webhooks).
- API auth hydration treats only `active` as Pro (`middleware/auth.ts:124-141`), while dashboard billing/bootstrap treats `active` or `trialing` as Pro (`apps/app/src/lib/billing-logic.ts:289-306`, `pages/api/bootstrap-key.ts:79-84`). A trial can oscillate between Pro/free after cache refresh, changing feature access and billing-period selection.
- Dashboard billing helpers rewrite auth cache entries with 86,400-second TTL (`billing-logic.ts:394-399`, `pages/api/billing/sync.ts:159-164`), contradicting the API's 600-second revocation backstop.
- Overage invoice creation stores local `billedAt` only after Stripe succeeds (`services/invoice-generator.ts:105-130`). If local persistence fails and retry occurs after Stripe's idempotency retention, an invoice item can duplicate.

**Remediation:** add a Postgres `stripe_events` inbox keyed by event ID. If receipt is acknowledged before processing, give the inbox leases, retries, terminal/failed state, alerting, and an outbox for KV/notification effects; never hold a DB transaction across Stripe/KV/email calls. For ambiguous or out-of-order events, retrieve current Stripe object state or apply explicitly defined local transition rules—`event.created` is not a universal monotonic object version and can tie. Define the authoritative trial source and expiry first: the schema defaults status to `trialing` while `trial_ends_at` is nullable, so blindly treating every default row as Pro can create an indefinite trial. Then share the one entitlement predicate. Centralize cache TTL and clamp to key expiry; add a durable billing operation keyed by usage record and reconcile Stripe items by metadata on unknown outcomes. **Performance:** C for one indexed event receipt; processing can move asynchronously and normal API reads remain unchanged.

### F-15 — HIGH: encrypted values cannot be safely rotated to a new key

`apps/api/src/lib/crypto.ts:4-77` stores only `enc:<iv+ciphertext+tag>` and decrypts every row with the one current environment key. No key ID/version is present. Rotating `ENCRYPTION_KEY` makes old tokens unreadable; a one-shot rewrite cannot safely resume or tell which rows already moved. Sensitive social tokens, BYOS credentials, short-link keys, and webhook secrets are affected.

**Remediation:** first move KV-only webhook secrets to the durable source described in F-11; missing secrets require endpoint-secret rotation, not re-encryption. Use a versioned envelope such as `enc:v2:<key-id>:...`; dual-read and active-key-write; re-encrypt in resumable batches; retain old keys until no ciphertext references them; bind new ciphertext to row ID and field name as AES-GCM AAD. Re-encryption must use compare-and-swap (`UPDATE ... WHERE ciphertext = old_ciphertext`) so it cannot overwrite a newer token written by refresh/reconnect; retry skipped rows, inventory plaintext legacy values separately, and throttle batches. **Performance:** A/B — prefix parsing is negligible and each read still performs one AES-GCM decrypt; background rotation is off-path.

### F-16 — HIGH: scheduled generators use cursors/claims that can skip or duplicate work

- **Cross-post actions:** claim by setting `executedAt`, while selection requires it to be null (`services/cross-post-processor.ts:23-58`). A crash leaves a pending row permanently excluded; a crash after provider success creates an ambiguous side effect.
- **RSS auto-post:** due rules are not atomically claimed, post/targets are created, Queue is sent, and only afterward is the feed cursor advanced (`services/auto-post-processor.ts:230-253,366-407`). Overlap or crash can duplicate a feed item. There is no per-item ledger.
- **Recycling:** `nextRecycleAt` advances before post/target work (`services/recycling-processor.ts:57-158`). A crash can skip a cycle or leave a targetless post.
- **Automation scheduled jobs:** stale crashes can be reclaimed, but an ordinary transient exception immediately marks the job failed (`services/automations/scheduler.ts:59-135`); successor creation is select-then-insert without a unique occurrence key (`:529-564`).

**Remediation:** explicit leases and stable operation/item IDs; unique `(rule_id, canonical_feed_item_id)` and unique scheduled occurrence keys; one short DB transaction for claim/cursor/post/targets/outbox; distinguish transient retryable, terminal, and unknown external outcomes. **Performance:** B/C — short indexed background transactions only; prevents duplicate provider work.

### F-17 — HIGH: Queue exhaustion paths silently discard work instead of preserving it for recovery

- Publish and inbox queues have no DLQ (`wrangler.jsonc:163-167,183-186`).
- Consumers manually ACK terminal attempts (`queues/publish.ts:151-168`, `queues/inbox.ts:20-26`). If the terminal status update also fails, the message is still ACKed.
- Email has a configured DLQ, but its consumer manually ACKs the final attempt, bypassing the DLQ (`queues/email.ts:17-20`).
- Unknown queue names default to the publish consumer (`queues/index.ts:57-62`), which is unsafe routing behavior.

**Remediation:** configure DLQs for durable business events; remove manual final ACK for infrastructure failures; classify permanent input errors separately; alert and provide controlled replay; make queue routing explicit and reject unknown names. **Performance:** B — failure paths only.

### F-18 — HIGH: media lifecycle/transient thumbnail failures can become permanent data loss

- Media cleanup has no DLQ (`wrangler.jsonc:157-162`). Lifecycle DB failures are retried only a few times (`queues/media-cleanup.ts:47-60`).
- Thumbnail generation collapses all failures to `null` (`lib/thumbnails.ts:74-130`). Backfill converts null into an empty-string sentinel (`services/thumbnail-backfill.ts:53-67`), so transient Images/Media/R2 errors are never retried.
- Once the original lifecycle-deletes, a missing durable thumbnail can lead to deletion of the media row, losing historical metadata/preview.

**Remediation:** add media DLQ plus reconciliation; typed outcomes (`generated`, `unsupported`, `source_missing`, `transient_failure`); attempts/next-retry/status columns; only terminal unsupported/missing outcomes stop retry; preserve the media row with `original_deleted_at`. **Performance:** B — normal rendering unchanged; recovery work only.

### F-19 — HIGH: token refresh locking is not mutually exclusive

Both cron and request-time refresh use KV read-then-put locks (`services/token-refresh.ts:117-147,338-390`). KV is not an atomic put-if-absent mutex and is not immediately globally consistent. Two isolates can refresh the same rotating/single-use token concurrently; the last DB writer can overwrite a newer credential with an older or invalid one.

**Remediation:** per-account Durable Object coordination or a database lease/version CAS; do not hold a DB transaction across provider HTTP; persist returned credentials only if the caller still owns the lease and token version. **Performance:** C on the rare near-expiry refresh path only; no ordinary request cost when tokens are valid.

### F-20 — HIGH: thread and email terminal states do not match real external outcomes

- A failed thread position stops and ACKs the chain, while all downstream posts remain `scheduled`; the normal scheduler intentionally excludes non-root thread items (`thread-publisher.ts:307-335`, `queues/publish.ts:69-75`, `services/scheduler.ts:28-32`). Users see permanently scheduled downstream items.
- Email queue messages already carry a stable UUID (`lib/email-queue/producer.ts:16-28`), but the Resend call omits it as an idempotency key (`lib/email-queue/consumer.ts:7-26`). Provider acceptance followed by Worker death can duplicate an email. The final ACK also bypasses the configured DLQ.

**Remediation:** transactionally mark downstream thread items `skipped/cancelled` with reason and maintain a thread aggregate state; pass the message UUID to Resend idempotency; let final email failures reach the DLQ. **Performance:** B/A — failure-path thread update and effectively zero-cost email header.

## Production-safe remediation order

### Gate 0 — freeze and inventory

1. Stop schema deployment and do not run the current migration chain against production.
2. Open the required SSH tunnel, take a verified backup, and inventory migration ledger plus physical automation table shape.
3. Confirm whether `automation_step_runs` is partitioned and create August+ partitions immediately if it is.
4. Record live Hyperdrive caching state. Cloudflare enables eligible query caching by default and does not invalidate cached SELECTs after writes; auth, permissions, billing, leases, and claims require a cache-disabled binding if caching is enabled. See [Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/). The June audit says the current production binding was disabled, but deployment should verify rather than assume.

### Gate 1 — close active authorization/external-side-effect holes

1. Patch ad analytics organization/workspace predicates.
2. Patch manual automation enrollment, recipient resolution, legacy WhatsApp broadcast, and relationship IDs.
3. Enforce workspace scope in every direct-ID route and nested bulk item.
4. Disable unsafe SDK mutation retries until server idempotency exists.
5. Deduplicate resolved post targets.

These are mostly query predicate/in-memory changes and can be deployed before the larger schema work.

### Gate 2 — make handoffs durable

1. Add publish target attempts and a transactional outbox.
2. Add raw inbound event durable acceptance and inbox DLQ.
3. Add durable customer webhook events/deliveries.
4. Convert broadcast recipients and cross-post actions to explicit lease/unknown states.
5. Add recovery/reconciliation jobs before enabling automatic stale-work repair.

Do not add a generic “reset publishing after N minutes” job first. Without an `unknown` state and provider reconciliation, it converts stuck records into duplicate external posts.

### Gate 3 — repair schema invariants without data loss

For every new uniqueness/FK invariant:

1. Run a read-only mismatch/duplicate report and save it with the deployment artifact.
2. Decide a deterministic reconciliation policy; preserve remote IDs/history in an audit table.
3. Deploy application-side enforcement.
4. Build supporting indexes using the least-blocking method supported by the migration runner.
5. Add FKs as `NOT VALID`, validate after cleanup, then enforce new nullability/uniqueness.
6. Rehearse rollback/restore on a production-sized copy.

Priority order: tenant composites, post target uniqueness, external ad/Stripe identity uniqueness, contact FKs, then lifecycle constraints.

### Gate 4 — lifecycle and cryptographic hardening

1. Replace account hard deletion with disconnect state.
2. Implement workspace/organization deletion state machines.
3. Introduce versioned encryption and rotate in resumable batches.
4. Add consent ledger/current state.
5. Add durable Stripe event and billing-operation ledgers.

## Required validation before production

### Database and migration gates

- Empty PostgreSQL install reaches the latest migration.
- Upgrade test from every supported deployed baseline reaches the same catalog.
- Schema diff checks tables, columns, types, defaults, PKs, uniques, FKs, indexes, partitioning, and extensions.
- Partition-horizon test fails CI if less than 120 days are available.
- Restore rehearsal proves backups are usable.
- Live preflight asserts expected migration hashes/catalog before every migration.

### Tenant and authorization gates

- Generate fixtures for two organizations, two workspaces each, and all-workspace/allowed/denied keys.
- Test every ID-addressed GET/POST/PATCH/DELETE and every related-resource ID with cross-org and cross-workspace substitutions.
- Add database queries that assert zero tenant-composite mismatches.

### Failure-injection gates

At each irreversible call, force a crash/failure:

- before Queue send, after DB commit;
- after Queue acceptance, before ACK;
- before provider request, after request transmission, after provider success, before DB result write;
- after a subset of a broadcast batch;
- after Stripe success, before local billing update;
- after webhook endpoint insert, before secret persistence;
- after account/workspace/tenant lifecycle step N.

Each test must prove one of: exactly one side effect, a durable `unknown` state, or safe manual reconciliation. “Eventually no longer stuck” is insufficient if it can duplicate a real post.

### Performance gates

No remediation should ship based only on theoretical neutrality. Capture production-like before/after results for:

- p50/p95/p99 API latency and error rate for post create/update/list, auth, inbox ingestion, and ad routes;
- Queue throughput, redelivery rate, outbox lag, and DB connections;
- insert/update throughput for tables receiving new unique/composite indexes;
- provider webhook acknowledgement latency after durable raw enqueue;
- broadcast/publish throughput and duplicate suppression rate;
- index sizes and query plans for tenant-scoped lookups.

Use a no-regression release gate for ordinary read paths. For the few class-C correctness writes, agree an explicit budget rather than claiming zero physical cost; the expected user-facing trade is a small local write instead of data loss or duplicate external activity.

## Validation performed during this audit

| Check | Result |
|---|---|
| Root `bun run typecheck` | Passed |
| API isolated suite (`cd apps/api && bun run test`) | First pass: 45 files, 542 passed, 0 failed. Final isolated rerun after concurrent worktree changes: 539 passed and 3 wall-clock threshold failures, all in `performance.test.ts` (OAuth state generation, queue preview, OpenAPI generation); no functional assertion failed. A parallel rerun had 5 timing failures, confirming that this benchmark is load-sensitive in the shared audit environment. |
| Dashboard suite (`cd apps/app && bun test`) | Passed: 210 tests, 0 failures |
| Fresh local PostgreSQL migration replay | Failed deterministically at `0035` with duplicate `automation_run_status` |
| Live database catalog/ledger inspection | Not performed: required SSH tunnel on `localhost:5433` was down |
| Biome lint | Not a clean validation signal: installed CLI was 2.5.3 while the config schema reported a different version during the run; lint also reported existing errors/warnings |
| Cloudflare runtime types | Compared against current `@cloudflare/workers-types` downloaded during review |

The passing tests do not invalidate the findings. They mostly exercise handlers with mocked modules and normal success/failure returns; they do not replay all migrations, mix tenant IDs, inject crashes between external calls and persistence, simulate staggered at-least-once deliveries, or verify deletion graphs.

## Double-check record

Every reported item was rechecked against its schema constraint and its call/worker path. The highest-risk findings were independently found by more than one review pass:

- migration split and partition horizon: migration replay plus independent schema review;
- tenant composite gap: schema review plus route/service review;
- duplicate publishing/stranded handoff: publisher review plus async/Queue review;
- duplicate target resolution: schema, API, and publisher review;
- webhook secret loss: route/schema review plus delivery-worker review;
- contact orphan behavior: schema review plus contact delete/merge path review;
- destructive account/workspace/tenant lifecycle: schema cascades plus endpoint/service review.

### Candidates checked and deliberately not promoted

- Ordinary single-post target resolution does scope accounts by organization; the confirmed defects are overlapping selectors, nested workspace IDs, and missing composite integrity.
- Thread creation is transactional and deduplicates accounts; the remaining defects are Queue handoff and downstream terminal state.
- Usage records already have unique `(organization_id, period_start)` and atomic upserts.
- Active/waiting duplicate automation enrollment is protected by a partial unique index; it does not protect cross-tenant related IDs.
- Inbox message/conversation and external-post platform identity dedup indexes exist; the inbox bug is that downstream side effects ignore the dedup no-op.
- Media integer size is safe under the current 50 MB upload cap.
- Business timestamps are generally timezone-aware; no high-confidence timezone storage defect was found.
- Resource IDs have sufficient entropy; collision risk is not production-significant.
- Missing database RLS was not treated as a standalone defect because the application currently uses one role. Composite tenant integrity remains necessary.
- Hyperdrive client lifecycle is request-scoped and consistent with Workers guidance; no global connection defect was confirmed.
- Cron schedules are gated by exact cron expression; overlap alone is not the confirmed issue. The affected jobs lack idempotent claims/item ledgers.
- Main publish messages currently set `usage_tracked: true`; no retry-based usage double-charge was confirmed on that path.
- R2 event action names and inspected Queue payload serialization are valid.

## Scope and limitations

The audit covered the repository's database schema and all migration files, API route/middleware patterns, auth/billing, publishing, threads, automations, inbox/platform webhooks, broadcasts, media lifecycle, queues/crons, dashboard administrative deletion/billing helpers, and SDK retry behavior. It prioritized logic that can create cross-tenant access, irreversible external side effects, silent loss, unrecoverable encrypted data, or dangerous post-production migrations. Cosmetic issues and small UI defects were intentionally excluded.

The live database, Cloudflare Queue backlog/DLQs, production KV contents, Stripe objects, and provider-side posts were not inspected. The SSH tunnel requirement was respected; no remote database command was run while it was unavailable. Because the working tree changed concurrently during the audit, this report cites the file contents present at final verification time and does not overwrite or revert those unrelated changes.
