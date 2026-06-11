# RelayAPI Performance Audit — June 2026

Deep analysis of every flow in `apps/api` and `apps/app`, with real latency
measurements taken against the **deployed production workers** via
`Server-Timing` instrumentation and `wrangler tail`.

**Contents of this directory:**

| File | What it is |
|---|---|
| `README.md` | This report — measurements, root causes, fixes applied, decisions to make |
| `findings.md` | Performance appendix — **verification complete 2026-06-10**: 26 first-pass confirmed + 89 second-pass verified (78 confirmed, 11 partial, 0 refuted) + 40 verified low-severity notes |
| `bug-findings.md` | **Correctness bugs** — dedicated 17-finder hunt (2026-06-10/11): 116 clustered confirmed bugs (10 critical, 55 high, 34 medium, 17 low); 157/157 verified claims survived adversarial review |
| `fix-plan.md` | Phased remediation plan covering every open finding **and bug**, with breaking changes and decisions flagged |
| `flows/*.md` | 11 detailed flow maps (request lifecycle, publishing, queues/crons, OAuth, inbox, automations, media/analytics, webhooks/billing, dashboard, DB schema, realtime) |

---

## 1. Executive summary

The API's middleware stack is **not** the problem — when KV is warm, auth +
rate-limit + permissions + usage tracking together cost **3–7 ms**. The cost
of nearly every endpoint is **DB round trips: ~85–120 ms each**, because the
worker runs at the requester's edge while Postgres sits behind
Hyperdrive → Cloudflare Access tunnel → `db.relayapi.dev`, and **Hyperdrive
query caching is disabled**. Every serialized query stacks another full round
trip.

What that means in practice (measured medians, inside the worker):

- Any single-SELECT list endpoint: **~95–140 ms**
- `GET /v1/usage` (2 serialized selects before the fix): **251 ms → 112 ms after fix**
- KV-only endpoints (`/v1/queue/slots`): **6–8 ms**
- Invalid API key probe: **~113 ms** (falls through to a DB lookup — see §6)

Eleven verified code fixes were applied (§5), the worker bundle was cut **43 %**
(7,933 → 4,491 KiB), a production cron double-execution bug was fixed, and the
test suite was repaired (522 → 532 passing, 0 failing) and wired into
test-gated CI deploys. The structural levers that remain — queue-based
publishing, Hyperdrive caching, Smart Placement, DB indexes — need product
decisions and are listed in §6.

**Verification is now complete** (2026-06-10, second 99-agent adversarial
pass): all 142 previously unverified findings and 49 low notes were re-checked
against the current tree — **0 were refuted**. 78 confirmed as filed, 11
confirmed with corrected scope, the rest were duplicates or already fixed.
Notably, none of the re-graded findings kept a *critical* severity: the
remaining inline-work problems sit on per-onboarding paths (OAuth connect),
per-org actions (broadcast send, ads sync), and queue consumers rather than
steady-state request hot paths. Three new correctness bugs were confirmed:
`GET /v1/posts/logs` and `GET /v1/connections/logs` ignore their `cursor`
params (pagination broken, same class as the fixed media bug), and webhook
signing secrets silently expire after the KV 1-year TTL. The full prioritized
remediation sequence is in [fix-plan.md](./fix-plan.md).

**A dedicated correctness-bug hunt followed** (2026-06-10/11, separate from
the performance pass): 17 specialized finder agents swept pagination, races,
transactional integrity, tenancy/authz, validation, error handling,
billing math, the publishing state machine, OAuth/token lifecycle, inbox
normalizers, the automations engine, cron date math, media/R2, webhook
verification, SSRF/redirects, SDK drift, dashboard internal routes, and
deletion paths. Every claim was adversarially verified; **none was refuted**.
Result: **116 confirmed bugs** ([bug-findings.md](./bug-findings.md)),
including 10 criticals — among them: monthly overage **never billed** in
normal operation (`invoice-generator.ts`), Stripe webhook events silently
lost on handler failure, bulk contact creation attaching channels to the
wrong contacts, automation delay nodes wedging runs forever, thread
publishing double-posting on queue redelivery, cross-tenant webhook
misrouting for multi-org platform accounts, a missing workspace-scope check
on unpublish, a forgeable automation-webhook HMAC after config edits, and
removed dashboard members retaining full org access. Remediation is staged
as P0-B in [fix-plan.md](./fix-plan.md).

---

## 2. Methodology

1. **Instrumentation** (kept in the codebase, off by default):
   - `apps/api/src/lib/perf.ts` — `perfLogMiddleware` (first middleware) +
     `timed()` wrappers around every `/v1/*` middleware. Emits a
     `Server-Timing` response header and one structured JSON log line per
     request (`{t:"perf", p, s, total_ms, spans, db_n, db_q, cold}`), visible
     in `wrangler tail` and the Workers dashboard.
   - `packages/db` `createDb()` gained an optional `onQuery` hook; the
     db-context middleware uses it to count every SQL statement per request.
   - Toggle: `PERF_LOGS` var in `apps/api/wrangler.jsonc` (currently `"1"` —
     **set to `"0"` when you're done observing**; overhead is one log line +
     header per request).
2. **Deployment**: `wrangler deploy --keep-vars` to the `relay` account
   (worker `relayapi`), tailed with `wrangler tail --format json`.
3. **Load**: curl batteries (5 runs per endpoint) against
   `api.relayapi.dev` with a **temporary read-only API key injected directly
   into KV** (synthetic org `org_perfaudit_claude`, `["read"]` permissions,
   1 h TTL — already expired). Caveat: the synthetic org has no rows, so
   handler times measure query/transport cost, not row serialization.
4. **Dashboard**: measured via the worker's invocation logs (`wallTime`/
   `cpuTime`) while requesting pages with and without a session.

### Audit artifacts that need cleanup (intentionally not deleted by the audit)

- Auth user **`perfaudit-claude@relayapi.dev`** ("Perf Audit (Claude temp)") and
  organization **"Perf Audit Claude TEMP"** (`YH6b2eM6tyUSMXFFejjDqqzljz5MsIUy`)
  — created to profile the authenticated dashboard. Delete when convenient.
- `api_request_logs` rows for `org_perfaudit_claude` (a few dozen GETs).
- The KV test key had a 1 h TTL and is gone on its own.

---

## 3. Measured results

### 3.1 API endpoints (median worker-internal time, warm KV)

| Endpoint | Before | After fixes | Blocking DB round trips |
|---|---|---|---|
| `GET /health` | ~0 ms | ~0 ms | 0 |
| `GET /v1/queue/slots` (KV only) | 8 ms | 6 ms | 0 |
| `GET /v1/posts` | 124 ms | 142/113 ms* | 1 |
| `GET /v1/accounts` | 116 ms | 112 ms | 1 |
| `GET /v1/usage` | **251 ms** | **112 ms** | 2 → 1 |
| `GET /v1/media` | 118 ms | 107 ms | 1 |
| `GET /v1/inbox/conversations` | 114 ms | 94 ms | 1 |
| `GET /v1/workspaces` … `/v1/tags` etc. | 95–135 ms | 98–113 ms | 1 |
| Invalid API key → 401 | 115–148 ms | ~113 ms | 1 |
| Auth (valid key, KV hit) | 3–7 ms | 3–4 ms | 0 |

\* run-to-run noise; each endpoint's floor is its single DB round trip.

The uniform ~100 ms floor **is** the Hyperdrive→origin round trip. Middleware
(auth KV read, rate-limiter binding, body cache, workspace checks, usage
counter) contributes single-digit ms in the warm case.

The `db_n=2` you'll see in perf logs for list endpoints = 1 blocking SELECT +
the `api_request_logs` INSERT, which is already deferred via `waitUntil` and
does not block the response.

### 3.2 Cold start / bundle

| Metric | Before | After |
|---|---|---|
| Bundle (raw) | 7,933 KiB (unminified) | **4,491 KiB** |
| Bundle (gzip) | 1,531 KiB | **1,192 KiB** |

Changes: `"minify": true`, react-email stack (was ~38 % of the bundle, on the
hot path via usage-tracking → notification-manager) and the Stripe SDK
(~660 KiB) now load via dynamic `import()` on first use.

### 3.3 Crons (from `wrangler tail`)

- `*/1` tick: ~960 ms avg, max 1.1 s per run — **and it was running on all six
  cron triggers**, not just `*/1` (fixed, §5.1).
- `*/5` tick: ~1.6 s.

### 3.4 Dashboard (`relayapi-app` worker, invocation logs)

| Page | wall (med) | CPU (med) | Note |
|---|---|---|---|
| `/` (marketing) | 159 ms | 74 ms | full SSR per request, no cache |
| `/login` | 163 ms | 75 ms | full SSR per request |
| `/app` (no session → 302) | 59 ms | 31 ms | |
| `/pricing` | 27 ms | 25 ms | |

TTFB from a client adds 0.1–2 s of network on top of these. Marketing/login
pages are identical for every visitor and are candidates for prerendering or
edge caching (§6.8). The authenticated `/app/*` flow (middleware → session →
org → SDK fetch chain) is mapped in `flows/dashboard-app.md`.

### 3.5 Misc

- `GET /openapi.json` is **826 KB** per request, generated per request
  (worker time is small; transfer dominates). Consider caching/static hosting.
- Production KV held **zero usage counters and 18 cached API keys** at audit
  time — i.e. near-zero authenticated API traffic. Perf work right now is
  about the floor (first-user experience), not throughput.

---

## 4. Root-cause analysis

1. **Geography + no caching, not query cost.** Single indexed SELECTs on empty
   tables cost ~100 ms — that's transport (edge worker → Hyperdrive pool →
   Access tunnel → origin), not Postgres. Hyperdrive config `relayapi-prod`
   has `"caching": {"disabled": true}`.
2. **Serialization multiplies the floor.** Every `await`ed independent query
   adds ~100 ms of wall time. This is why `/v1/usage` was 2.2× the cost of
   `/v1/posts`.
3. **The middleware chain is well-built.** KV-cached API keys (24 h TTL),
   KV-cached workspace validation (5 min), deferred usage writes — all
   confirmed cheap in production. The audit's middleware findings are about
   *stacked sequential KV reads* on mutating requests (3 independent reads
   across three middleware), worth ~"tens of ms" only on cold-tier KV reads.
4. **Heavy work rides HTTP request paths.** Retry/bulk/CSV publishing,
   broadcast fan-out, OAuth callback enrichment, ads discovery — all execute
   external calls inline before responding (see §6.1–6.3).
5. **Cold start was inflated** by an unminified 8 MB bundle with react-email +
   Stripe evaluated at startup.

---

## 5. Fixes applied in this audit (non-breaking, deployed + verified)

### 5.1 Correctness-adjacent

1. **Cron double-execution** (`apps/api/src/scheduled/index.ts`): the
   every-minute block (scheduled posts, recycling, broadcasts, cross-posts,
   automation scheduler) ran on **every** trigger — at :00 it ran 3×
   concurrently (`*/1` + `*/5` + `*/30`), racing post claims and double-billing
   cron invocations. Now gated on `event.cron === "*/1 * * * *"`. Regression
   test: `scheduled-cron-gating.test.ts`.
2. **`GET /v1/media` pagination was broken**: `cursor` was accepted but never
   applied, and `next_cursor` returned a `med_…` id that could never match the
   `createdAt` sort key — page 2 was unreachable. Fixed to keyset pagination on
   `created_at` (mirrors the posts fix from commit `918b226`). Regression
   test: `media-cursor.test.ts`.

### 5.2 Round-trip eliminations

3. **`GET /v1/usage`**: subscription + usage-record + KV counter now fetched in
   one parallel batch (was: subscription → *then* usage record). **251 → 112 ms.**
4. **Auth cache-miss hydration** (`middleware/auth.ts`): API-key row + org
   subscription fetched in **one LEFT JOIN** (was 2 serialized queries), and
   the KV repopulation write moved to `waitUntil`. Saves ~100 ms on every
   legitimate cache miss (new key first use / 24 h TTL expiry).
5. **`GET /v1/posts/{id}`**: post + targets + recycling config — all keyed on
   the path id — now one parallel round trip (was post → then children).
6. **`DELETE /v1/posts/{id}`**: the two child-table deletes run in parallel
   (3 → 2 round trips).
7. **`GET /v1/inbox/conversations/{id}`** (`services/inbox-persistence.ts`):
   conversation + messages fetched in parallel (both keyed on conversation id).

### 5.3 Cold start

8. `"minify": true` in `apps/api/wrangler.jsonc` (bundle −43 %).
9. react-email + templates moved behind dynamic `import()`
   (`lib/emails/render-notification.ts`, `services/email.ts`).
10. Stripe SDK moved behind dynamic `import()` (`services/stripe.ts`;
    `createStripeClient` is now async).
11. **Smart Placement enabled** (`"placement": {"mode": "smart"}`): since every
    handler is DB-bound against one origin, Cloudflare can run the worker near
    the DB instead of near the requester, attacking the ~100 ms/query floor
    directly. NOTE: takes effect only after Cloudflare observes traffic;
    verify in the dashboard (Workers → relayapi → Settings → Placement) and
    re-measure after a few hundred requests. Roll back by removing the key.

### 5.4 Instrumentation (new capability)

12. `lib/perf.ts` + `PERF_LOGS` var + per-query counting (see §2). Tests:
    `perf-instrumentation.test.ts`.

---

## 6. Decisions to raise — breaking changes / refactors (NOT done)

These are the big wins; each changes semantics, schema, or architecture.
Full per-finding details in [findings.md](./findings.md); the complete
phased execution sequence (including all non-breaking work) is in
[fix-plan.md](./fix-plan.md).

### 6.1 Move inline publishing to the queue ⚠️ response-semantics change
`POST /v1/posts/{id}/retry`, `POST /v1/posts/bulk` (items with
`scheduled_at: "now"`), and `POST /v1/posts/bulk-csv` (≤500 rows!) publish to
platforms **inline in the HTTP request**, serially per item. A large CSV of
"now" rows can exceed worker limits and partially complete with no resume.
Proposal: enqueue to `PUBLISH_QUEUE` and return `202` with per-item statuses.
Breaking: clients that read final publish results from the response body.

### 6.2 Broadcast fan-out on request path ⚠️
`POST /v1/broadcasts/{id}/send` sends to all recipients synchronously
(1 UPDATE per recipient, sleeps included). Same queue treatment as 6.1.

### 6.3 OAuth callback critical path (multiple unverified-but-consistent findings)
The callback awaits avatar re-host, customer-webhook delivery (with retry
sleeps), IG webhook subscriptions (3 Graph calls), and Meta ad-account
discovery **before redirecting the user's browser**. Proposal: persist the
connection, redirect immediately, run enrichment via `waitUntil`/queue.
Verify each before acting (`flows/oauth-connect.md`).

### 6.4 Enable Hyperdrive query caching ⚠️ read-after-write semantics
`relayapi-prod` has caching disabled. Enabling (default `max_age` 60 s) would
collapse repeated SELECTs to ~ms but introduces staleness windows — e.g. a
client that creates a post then immediately lists posts may not see it.
Decide per product tolerance; configurable via
`wrangler hyperdrive update 11180e4939824902a75753084dc6a8e9 --caching-disabled=false`.

### 6.5 Missing DB indexes (needs a migration + the SSH tunnel)
Highest-value candidates found by cross-referencing query sites with the
schema (details + query sites in `flows/db-schema.md` and findings.md):
- `auth.session.token` — looked up on **every dashboard page view** (seq scan).
- `auth.user.email` (unique) — every credential login.
- `auth.member (user_id)` — login + onboarding + notification fan-out.
- Expression index on `posts`: `coalesce(published_at, created_at) DESC`
  (+ `organization_id`) — the list-posts sort has no supporting index.
- `media.storage_key` — upload-confirm UPDATE.
- Inbox message search uses non-sargable `ILIKE '%q%'` — needs `pg_trgm` GIN
  if message search matters.

### 6.6 `api_request_logs` retention
One row per authenticated request, forever, with no retention job — the table
that `GET /v1/usage/requests` runs `COUNT(*)` over. Decide: TTL cron,
sampling for GETs, or move to Workers Analytics Engine.

### 6.7 Negative caching for invalid API keys
Every well-formed unknown key costs a ~100 ms DB probe (DoS-ish vector).
Cache "invalid" verdicts in KV for 60 s. Slight semantic note: a key created
and probed within the same minute could see a transient 401.

### 6.8 Dashboard follow-ups (respecting the app rules in CLAUDE.md)
- Prerender or edge-cache `/` and `/login` (identical for all visitors;
  74 ms CPU per view today).
- `posts-page.tsx` fetches the list-view data even when the default calendar
  view renders; calendar paginates `/api/posts` sequentially (up to 10
  round trips). Fix in `apps/app` (client behavior, no API change).
- `bootstrap-key.ts` writes `apikey:*` KV records with a **1-year TTL**,
  bypassing the API's 24 h revocation backstop — review (security-adjacent).
- `auth.session.token` index (6.5) is the single biggest authenticated-shell win.

### 6.9 Worker decomposition (large refactor)
46 routers + 9 queue consumers + 6 crons + DO in one worker. Splitting
consumers/crons from the HTTP API would shrink the hot bundle further and
isolate blast radius. Only worth it if cold starts still matter after §5.

### 6.10 Second-pass verified items needing a decision (added 2026-06-10)
- **`POST /v1/ads/accounts/{id}/sync` runs the full external sync inline**
  (V28) — should enqueue to the existing `ADS_QUEUE` and return `202`.
  Breaking: response no longer carries final sync results.
- **`GET /v1/ads/accounts` / `GET /v1/ads/audiences` run Meta discovery
  crawls inline per list request** (V26/V27) — move discovery to
  connect-time + background refresh; list endpoints read DB only.
- **Public automation webhook trigger runs the full automation inline**
  (V8) — enqueue the run; the route already returns `202`-shaped output,
  so this is semantics-compatible but changes timing.
- **Endpoints ignoring their documented params** — `GET /v1/analytics`
  ignores `limit`/`offset` (V22), `content-decay` ignores `days` (V23),
  `post-timeline` ignores date bounds (V24), `posting-frequency` ignores all
  filters (V19). Honoring them matches the documented contract but changes
  current observed responses.
- **Automation list payloads** — `GET /v1/automations` returns the full graph
  JSONB per row; `GET /v1/automations/{id}/runs` returns full run context
  JSONB (V16). Slimming is a response-shape change.
- **Deprecated `GET /v1/whatsapp/broadcasts` is unbounded** and still used by
  dashboard + SDK (V64) — needs a paginated replacement + client migration.

---

## 7. Test suite & CI

- **Root cause of the historic flakiness**: `bun test src/__tests__` runs all
  files in one process; five suites `mock.module("@relayapi/db", …)` globally
  and poisoned the automation suites (their failures never reproduced in
  isolation). New runner `apps/api/scripts/run-tests-isolated.ts` executes
  each file in its own process — `bun run test` now uses it
  (`test:single-process` keeps the old behavior).
- Suite status: **42 files, 532 pass, 0 fail, ~3 s** (DB-fixture suites
  self-skip without the SSH tunnel, so the suite is CI-safe).
- Repaired: `stripe-webhooks.test.ts` (mock was missing the
  `whatsappPhoneNumbers` export — pre-existing break), `auth.test.ts` +
  `__mocks__/db.ts` (mock now supports `leftJoin`).
- New: `perf-instrumentation.test.ts`, `scheduled-cron-gating.test.ts`,
  `media-cursor.test.ts`.
- **CI** (guidelab-style test-gated deploys, `.github/workflows/`):
  - `deploy-api.yml` — push to `main` → typecheck (db, auth, api) + isolated
    tests → `wrangler deploy --keep-vars`.
  - `deploy-app.yml` — push to `main` → typecheck + app tests → Astro build →
    `wrangler deploy --keep-vars` (build validated locally; wrangler resolves
    the generated `dist/server/wrangler.json`).
  - `ci-api.yml` / `ci-app.yml` — same checks on PRs only.
  - Requires repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
    (`3496f40fcd55a91da50ded8abea2cf7a`). Until those are set, deploys remain
    manual exactly as before.

---

## 8. How to reproduce a measurement

```bash
# Tail structured perf logs (PERF_LOGS=1 must be set on the worker)
CLOUDFLARE_ACCOUNT_ID=3496f40fcd55a91da50ded8abea2cf7a \
  bunx wrangler tail relayapi --format json | grep '"t":"perf"'

# Or read spans straight off any response
curl -sD - -o /dev/null -H "Authorization: Bearer $KEY" \
  https://api.relayapi.dev/v1/posts | grep -i server-timing
# server-timing: auth;dur=3.0, ratelimit;dur=0.0, …, handler;dur=116.0,
#                db;dur=0;desc="n=2", total;dur=120.0
```

Turn instrumentation off by setting `"PERF_LOGS": "0"` in
`apps/api/wrangler.jsonc` and redeploying.
