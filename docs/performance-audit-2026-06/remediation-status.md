# Remediation Status — June 2026 Audit

Companion to [fix-plan.md](./fix-plan.md), [findings.md](./findings.md)
(performance) and [bug-findings.md](./bug-findings.md) (correctness). Records
what was actually applied to the working tree, what needs an operational step,
and what was deliberately deferred.

**Status as of 2026-06-11:** all confirmed findings remediated in code except
the deferred items in §3. Whole monorepo typechecks (0 errors); API suite
**533 pass / 0 fail**, dashboard suite **218 pass / 0 fail**.

The fixes were applied by parallel owner-agents over disjoint file clusters,
then integrated, then put through a 6-area adversarial review of the diffs
(billing / tenancy / publishing / automations / cursors / schema). The review
found 5 high regressions in the fixes themselves — all corrected and
re-verified (see §2).

---

## 1. What was applied (code complete)

- **116 confirmed correctness bugs** (10 critical, 55 high, …) — the criticals:
  overage-never-billed, Stripe-webhook event loss, bulk-contact channel
  misattribution, automation delay-node infinite re-park, thread double-post on
  redelivery, multi-org webhook misrouting, unpublish workspace-scope bypass,
  forgeable automation-webhook HMAC after PATCH, removed-member data access.
- **~115 performance findings** — serialization, N+1s, batching, cold-start
  (dynamic imports + minify already in §5), inline-external-call deferral, and
  the cursor/keyset pagination class across **13 list endpoints**
  (accounts, ads ×3, workspaces, api-keys, webhooks ×2, broadcasts, automations,
  automation-runs, custom-fields, auto-post-rules, cross-post-actions, segments,
  ref-urls, ai-knowledge, short-links, contacts, media).
- **The three maintainer decisions**, applied consistently:
  - **P4 breaking changes** — retry/bulk/bulk-csv → `202 publishing`,
    broadcast send + ads sync → `202 queued`, automations list slimmed,
    whatsapp broadcasts paginated. SDK + dashboard updated in lockstep.
  - **Billing aligned to the Stripe billing period** — the period is carried
    in the `apikey:*` KV record (auth hydration + every `syncOrgKeysToKV`
    call: subscription.updated/created/checkout), both write paths key
    `usage_records` on it (`resolveBillingPeriod`), the invoice cron bills
    closed unbilled periods **daily** and idempotently (`billed_at` + Stripe
    idempotency key + 30-min settle buffer), and `GET /v1/usage` reports the
    same window.
  - **Prevent-duplicate-connect** for platform accounts, with deterministic +
    multi-org-safe webhook account resolution and KV invalidation on
    disconnect.
- **DB migration `0040`** (`packages/db/drizzle/0040_round_kinsey_walden.sql`):
  posts `coalesce(published_at, created_at)` expression index, auth indexes
  (session.token, user.email, member ×2), `media.storage_key`,
  social-account token-expiry, inbox open-conversation + `pg_trgm` trigram
  (extension included), automation webhook-slug partial-unique index,
  `usage_records.billed_at` column, dropped the unused `automations.graph`
  GIN index, and the `webhook_endpoints.workspace_id` FK changed to `cascade`.

## 2. Review regressions found & corrected

The adversarial review of the diffs caught (and these were then fixed):

1. **Billing period staleness** — a stale cached period after a roll/upgrade
   could split a month's usage into two records, each granting a full
   allowance (under-billing). Fixed by stamping the period through every
   active KV path + the 30-min invoice settle buffer.
2. **Dropped `post.published/failed` webhooks** — the queue consumer's
   fire-and-forget dispatch had no `waitUntil`, so the runtime could cancel
   it. Reverted to awaited delivery (guaranteed; the dedicated webhook queue
   in §3 is the planned non-blocking version).
3. **Interactive (button/quick-reply) resume race** — not migrated to the
   optimistic CAS guard; fixed to use `updateRunOptimistic`.
4. **`resumeExternalEventRuns` defined but never called** — paused runs stayed
   wedged after unpause; wired into both unpause paths.
5. **`media.ts` cursor** dropped rows on `created_at` ties / microsecond
   truncation; switched to the composite `(created_at, id)` keyset.

Plus mediums: automation webhook replay-protection wired + `stale_timestamp`
handled, PATCH automation-entrypoints slug-collision returns 409 (not a 500),
delay-node no-edge completion increments `total_completed`.

## 3. Operational follow-ups (need you / a deploy step)

- **Run the migration with the SSH tunnel:** `bun run db:migrate`.
  - **Pre-flight before applying:** the new `idx_automation_entrypoints_webhook_slug`
    UNIQUE index will *fail to create* if production already has duplicate
    inbound-webhook slugs. Check + dedupe first:
    ```sql
    SELECT (config->>'webhook_slug') s, count(*)
    FROM automation_entrypoints WHERE kind='webhook_inbound'
    GROUP BY 1 HAVING count(*) > 1;
    ```
  - The `CREATE INDEX` statements are non-concurrent (they run in the drizzle
    transaction) and briefly lock their tables. Fine at current data volumes;
    for large `posts` / `inbox_messages` run those out-of-band with
    `CREATE INDEX CONCURRENTLY` if you prefer zero lock.
- **SDK regeneration:** the hand-maintained SDK resources are updated, but the
  Stainless-generated ones (`inbox/*`, `usage`, `connect`, `contacts`,
  `whatsapp/broadcasts`) need a spec re-export + regen (the `sync-openapi`
  workflow) to fully reflect the P4 changes and the new query params.
- **Deploy:** not done — these are production billing/tenancy changes; deploy
  with `wrangler deploy` after review and the migration. `PERF_LOGS` is `0`.

## 4. Deferred by design (perf / architectural — not regressions)

- **Webhook delivery → dedicated queue** with native retry/backoff. Today
  delivery is awaited on the publish/cron path (correct, bounded); the queue
  is the proper non-blocking version (replaces the in-process retry sleeps).
- **Worker decomposition** — split queue consumers + crons into a second
  worker. Gated on cold-start P99 measurement after the §5 bundle work.
- **Durable Object usage counters** — replace the non-atomic KV gate counter
  (the DB `usage_records` remains the billing source of truth).
- **Hyperdrive query caching** — product decision (≤60s read-after-write
  staleness vs collapsing the ~100ms query floor).
- **Streaming large media uploads** in publishers (vs buffering ≤128MB).
- A few parallelizations the agents left as too-risky-to-guess
  (thread-publisher per-account fan-out ordering; inbox-feed independent-lookup
  reordering where a 404 must still take precedence; `createPost`'s
  data-dependent content-assembly lookups).
