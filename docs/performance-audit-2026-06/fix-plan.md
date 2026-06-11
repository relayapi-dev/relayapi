# Remediation Plan — Performance + Correctness Audit June 2026

Sequenced action plan covering **every open finding** from
[findings.md](./findings.md) (26 first-pass confirmed + 89 second-pass
verified + 40 verified low notes; 12 fixes already applied per README §5)
and **every confirmed bug** from [bug-findings.md](./bug-findings.md)
(116 clustered correctness bugs from the dedicated 17-finder hunt).

Finding references: `V1`–`V89` = second-pass IDs in findings.md;
`FP:` = first-pass confirmed finding (by file); `B1`–`B116` = bug IDs in
bug-findings.md.

**How to read the phases**

| Phase | Risk | Needs |
|---|---|---|
| P0 — Correctness bugs (perf audit) | none (bug fixes) | nothing — do first |
| **P0-B — Correctness bugs (bug hunt)** | mostly none | do with P0; a few need decisions |
| P1 — Hot-path latency quick wins | none (non-breaking) | code review |
| P2 — Database indexes | low | SSH tunnel + one migration |
| P3 — Queue/cron/batching efficiency | low (internal) | code review |
| P4 — Move work off request paths | ⚠ semantics | **user decision per item** |
| P5 — Platform / product decisions | varies | **user decision** |

Phases P0–P3 are safe to execute immediately and incrementally; nothing in
them changes an API contract. P4/P5 items are listed with their exact
semantic change so they can be approved one by one.

---

## P0 — Correctness bugs (do first)

| # | Fix | Findings | Files |
|---|---|---|---|
| P0.1 | `GET /v1/posts/logs`: apply the incoming `cursor` (keyset on `created_at`, same pattern as the media fix). Add regression test. | V89 | `routes/posts.ts` |
| P0.2 | `GET /v1/connections/logs`: apply the `cursor`; drop the per-request unbounded `COUNT(*)` (undocumented field). Add regression test. | V66 | `routes/connections.ts` |
| P0.3 | Double-publish guard: gate the `publishing → publishing` re-claim on staleness (`updatedAt < now() - 10min`) so duplicate queue messages can no longer double-post to platforms. | FP: `publisher-runner.ts:331` | `services/publisher-runner.ts` |
| P0.4 | Webhook signing secrets: persist in DB (or R2/KV-without-TTL) with KV as cache — today the only copy expires silently after 1 year and deliveries go unsigned. | V53 | `routes/webhooks.ts` |
| P0.5 | Honor documented query params: `GET /v1/analytics` `limit`/`offset` (V22), `content-decay` `days` (V23), `post-timeline` `from_date`/`to_date` (V24), `posting-frequency` filters (V19). These are documented in the OpenAPI schema but ignored. *Technically observable change — but it restores the documented contract.* | V19 V22 V23 V24 | `routes/analytics.ts` |
| P0.6 | Set `PERF_LOGS: "0"` in `wrangler.jsonc` before the next deploy (leave the instrumentation in place, off by default). | V80 | `wrangler.jsonc` |
| P0.7 | Broadcast resume: include status `'sending'` in the due-broadcast picker with a per-tick recipient budget so an interrupted broadcast is not stranded forever (adopt the WhatsApp processor pattern). | FP: `broadcast-processor.ts:121` | `services/broadcast-processor.ts` |

## P0-B — Confirmed correctness bugs from the bug hunt (bug-findings.md)

Full details per bug in [bug-findings.md](./bug-findings.md). The 10
**criticals**, individually:

| # | Bug | Why critical |
|---|---|---|
| B1 | PATCH automation entrypoint clobbers the webhook HMAC secret with the public mask string (`automation-entrypoints.ts:457`) | inbound automation webhooks become forgeable after any config edit |
| B2 | `POST /v1/contacts/bulk` `returning()` index misalignment when rows conflict (`contacts.ts:1066`) | channels (phone/email) attached to the **wrong contacts** — cross-contact data corruption |
| B3 | Inbox FB/IG send-message resolves the conversation without org scoping (`inbox-feed.ts:642`) | cross-tenant message sending |
| B4 | `resolveAccount` picks an arbitrary account when one platform account is connected by multiple orgs (`platform-webhooks.ts:102`) | webhooks/DMs misrouted to the wrong tenant |
| B5 | `POST /v1/posts/{id}/unpublish` has no workspace-scope check (`posts.ts:2368`) | scoped keys can delete live platform content org-wide |
| B6 | Stripe webhook ACKs 200 then processes in `waitUntil` with no retry path (`stripe-webhooks.ts:71`) | failed handler = billing event lost forever (org paid but never upgraded) |
| B7 | Automation delay nodes never advance — resume re-dispatches the delay handler which re-parks the run (`automations/runner.ts:269`) | every automation with a delay node wedges permanently |
| B8 | Monthly overage billing races the subscription webhook (`invoice-generator.ts:38`) | overage **never billed** in normal operation; double-billed when webhooks lag |
| B9 | Thread publishing has no idempotency claim (`thread-publisher.ts:185`) | queue redelivery double-posts entire threads to platforms |
| B10 | Dashboard middleware trusts `activeOrganizationId` without membership re-check (`app:middleware/index.ts:352`) | **removed org members retain full data access** |

The 55 **highs**, grouped (B-numbers in bug-findings.md):

- **Billing & usage math** — usage window vs Stripe period mismatch
  (`GET /v1/usage` wrong/inflated numbers), `apiCallsIncluded` frozen at
  first write, overage-cost formula mismatch (up to 100×), publish-retry
  re-billing, scheduler re-charging on queue lag, invoice-generator re-billing
  fallback. Fixing B8 + these together is one coherent billing workstream.
- **Publishing state machine** — vacuous `published` for zero-target posts
  (false webhooks + streak credit), retry drops media attachments, retry
  recomputes status from the retried subset only, partial unpublish flips the
  whole post to `draft` while content is live, crash-interrupted publishes
  stuck in `publishing`, cross-post "claim" that never changes status,
  thread `delay_minutes > 720` exceeding the Queues delay cap.
- **Pagination cursor/sort mismatches** (same class as the fixed media bug) —
  `GET /v1/accounts`, ads campaigns/ads/audiences, workspaces, api-keys,
  webhooks + webhook logs (cursor never applied), GMB reviews page token
  reuse, composite-cursor microsecond truncation in contacts.
- **Tenancy / authz** — post sub-resource endpoints skip workspace scope,
  inbox AI priorities ignores workspace scope, presign helper signs any R2
  key from client-controlled URLs (cross-org read oracle), SSRF-guard
  userinfo/dotted-IP bypasses.
- **Webhook & event loss** — Meta webhook KV-dedup-mark written before the
  queue send (DM loss on enqueue failure), layer-4 echo dedup drops real
  inbound DMs matching recent outbound text, Telegram `callback_query`
  dropped at the route, inbox processor swallows DB failures while still
  emitting `message.received`.
- **Automations** — `input_timeout` port-name mismatch (`timeout` vs
  `no_response`), timeout jobs not bound to their wait instance, paused runs
  never resumed, scheduled-trigger not pinned to its entrypoint, webhook
  slugs not unique across orgs.
- **OAuth / tokens** — secondary-selection flows discard `refresh_token`
  (Google Business/Snapchat die in ~1h), NULL access token persisted on
  HTTP-200 error bodies, default `redirect_url` rejected by its own
  allowlist, token-refresh failure notification spam.
- **Contacts** — self-merge deletes the contact outright, merge
  cascade-deletes automation runs and opt-out/pause controls.
- **SDK / dashboard drift** — `whatsapp.groups` calls a nonexistent route,
  `media.upload` default content-type always rejected, phone-numbers route
  shadowed, dashboard upload never calls `/v1/media/confirm` (media stuck
  pending), admin plan change rewrites all historical usage periods,
  pro-trial orgs enforced as free.

Mediums (34) and lows (17) are enumerated in bug-findings.md; most ride along
with the workstreams above (they touch the same functions).

**Decisions needed within P0-B** (the rest is unambiguous bug-fixing):
- B4 (multi-org platform accounts): pick routing semantics — fan out webhook
  events to *all* orgs holding the account vs. rejecting duplicate connects.
- Billing window (B8 + usage mismatches): align `usage_records` to Stripe
  billing periods (right fix, touches several queries) vs. align Stripe
  reporting to calendar months (smaller, changes invoicing semantics).
- B10: add a membership re-check per request (small DB cost on every
  dashboard view — pair with the `auth.member` index from P2).

## P1 — Hot-path latency quick wins (non-breaking)

| # | Fix | Findings | Files |
|---|---|---|---|
| P1.1 | **OAuth callback deferral**: add `executionCtx` param to `exchangeAndSaveAccount`; move customer-webhook dispatch (V1), ad-account discovery (V2), avatar re-host (V3), IG webhook subscriptions (V4), connection logs + sync-state side work (V5) behind `waitUntil`. The user's 302 redirect then waits only on token exchange + account upsert. | V1–V5 | `routes/connect.ts`, `routes/oauth-callback.ts` |
| P1.2 | **Middleware KV consolidation**: reorder `workspaceRequiredMiddleware` to check `workspace_id` presence before its KV read; prefetch `ws-valid` / `org-settings` / usage counter in one `Promise.all` after auth and let downstream middleware consume the prefetch. | FP: `app.ts:154`, `feature-gate.ts:41` | `middleware/*` |
| P1.3 | **Parallelize independent queries** in handlers: posts `include_external` (V54), post logs/recycling ownership checks (V57), inbox-feed lookups incl. participants (V44), GMB reviews discovery reuse (V46), ref-urls click chain (V61), `createIdea` chain (V62), `POST /v1/posts` create-time lookups in one `Promise.all` (FP: posts.ts:1124), accounts PATCH + WhatsApp photo + searchInterests + invite (low notes). | V44 V46 V54 V57 V61 V62 + lows | routes |
| P1.4 | **Use the existing KV presign cache** in `GET /v1/media` (V58); add Cache API edge caching for `/avatars/:id` (V59) and immutable short links (low). | V58 V59 | `routes/media.ts`, `routes/avatars.ts` |
| P1.5 | **Defer non-critical work** via `waitUntil`: inbox comment cache invalidation (V36), outbound-mid dedup KV writes (V38), account-sync avatar re-host (V69), retry endpoint's unused usage KV ops (V56), best-time cache write-back (currently a cancellable floating promise, V18). | V18 V36 V38 V56 V69 | routes/services |
| P1.6 | **Timeout sweep**: route all external `fetch` calls on request paths through `fetchWithTimeout` — URL shorteners in `POST /v1/posts`, OAuth token/profile exchanges, GMB/Reddit/Twitter proxies, webhook test, Telnyx + WhatsApp provisioning. ~125 call sites; mechanical. | V52 V55 + lows | routes, `config/oauth.ts`, `services/telnyx.ts` |
| P1.7 | **Auth hardening**: 60s KV negative cache for invalid API keys (V81 — note: a key created and probed within the same minute can see one transient 401); document/mitigate the 24h revocation window for keys revoked outside the API (V82) — shorter KV TTL (e.g. 1h) or DB-side invalidation hook. | V81 V82 | `middleware/auth.ts` |
| P1.8 | **Kill the easy N+1s**: inbox-ai priorities via one `DISTINCT ON` / lateral join (V33); automation webhook slug as a keyed SQL lookup (V9); trigger-matcher re-entry guard batched into one `IN (...)` query (V10). | V9 V10 V33 | `routes/inbox-ai.ts`, `services/automations/*` |
| P1.9 | **Stripe webhook KV sync**: parallelize `syncOrgKeysToKV` per-key get+put loop (low note). | low | `routes/stripe-webhooks.ts` |

## P2 — Database indexes (one migration, needs the SSH tunnel)

Single Drizzle migration; verify each with `EXPLAIN` before/after. Candidates
confirmed by reading every query site:

```sql
-- Hottest: list-posts sort has no supporting index (FP: posts.ts:648)
CREATE INDEX posts_org_effective_date_idx
  ON posts (organization_id, (COALESCE(published_at, created_at)) DESC);

-- Dashboard auth path (V83)
CREATE INDEX session_token_idx        ON auth.session (token);
CREATE UNIQUE INDEX user_email_idx    ON auth."user" (email);
CREATE INDEX member_user_idx          ON auth.member (user_id);
CREATE INDEX member_org_idx           ON auth.member (organization_id);
CREATE INDEX invitation_email_status_idx ON auth.invitation (email, status);

-- Upload-confirm UPDATE + media-cleanup delete (V83, low)
CREATE INDEX media_storage_key_idx    ON media (storage_key);

-- Contact merge scan (low)
CREATE INDEX broadcast_recipients_contact_idx ON broadcast_recipients (contact_id);

-- Cron scan predicates (V72)
CREATE INDEX social_accounts_token_expiry_idx ON social_accounts (token_expires_at)
  WHERE token_expires_at IS NOT NULL;
-- + external_posts staleness keyset, metrics ordering, inbox archive
--   (status, last_message_at) — exact DDL in findings.md V72.

-- Inbound DM contact matching (V43) — if inbox is a priority
CREATE INDEX contacts_org_phone_idx ON contacts (organization_id, phone);
CREATE INDEX contacts_org_email_idx ON contacts (organization_id, email);
```

Also: **drop the unused GIN index on `automations.graph`** (V14) after
confirming zero scans in `pg_stat_user_indexes`. Decide separately on
`pg_trgm` for inbox message search (V42) — only if message search matters.

## P3 — Queue / cron / batching efficiency (non-breaking, internal)

| # | Fix | Findings |
|---|---|---|
| P3.1 | **Batch the row-by-row writers**: threads create (2 multi-row INSERTs instead of 60 round trips, FP threads.ts:283); bulk + bulk-csv inserts batched (independent of the P4 queue decision); broadcast + WhatsApp recipient status UPDATEs set-based (V75); short-link click sync (V74); external-post sync upserts (V73); idea-groups reorder (V63); streak expiry (low). | FP×3 V63 V73 V74 V75 |
| P3.2 | **`sendBatch` everywhere**: scheduler publishes (FP scheduler.ts:70), ads cron (FP ad-sync.ts:311). | FP×2 |
| P3.3 | **Claim-at-enqueue** for sync/metrics/analytics crons (advance `next_sync_at` in the enqueue UPDATE … RETURNING) so a slow backlog can't double-enqueue accounts. | FP external-post-sync/cron.ts:49 |
| P3.4 | **Webhook delivery off the publish path**: KV-cache each org's enabled-endpoint list (invalidate on webhook CRUD); dispatch deliveries via `waitUntil`/dedicated queue instead of awaiting 3×5s retries inside publish/inbox consumers and cron loops; run `notifyRealtime` concurrently; reuse one DB client (no per-delivery `createDb`); cache DoH SSRF lookups in KV. | FP publisher-runner.ts:296, V34 V49 V50 |
| P3.5 | **One DB client per invocation**: thread a single client through publishToTargets → dispatchWebhookEvent (FP publisher-runner.ts:74), connect flow (V67), ad-service (V31), cron tasks (V71); pass prefetched account rows into `publishToTargets`. | FP V31 V67 V71 |
| P3.6 | **Automation engine efficiency**: cache the graph + run row across `runLoop` iterations (V7); bounded concurrency + per-tick enrollment caps with continuation jobs in the scheduler (FP scheduler.ts:91); replace in-process typing/delay sleeps with scheduled resume jobs (V11); move run counters off the graph-bearing row (V14); select thin columns in trigger-matcher (V15); short-circuit internal-events when no listeners exist via a cached entrypoint bitmap (V13); reuse matcher hydration in enrollContact (V12). | V7 V11–V15, FP |
| P3.7 | **Analytics/ads refresh costs**: per-post insights call instead of 50-post window scan (FP analytics-refresh.ts:328); ads sync bulk SELECT/upsert + account-level insights with per-ad breakdown (FP ad-sync.ts:89, V29 V30); incremental insights window (yesterday+today) once a backfill exists (V29). | FP×2 V29 V30 |
| P3.8 | **Token refresh**: mark permanently-expired accounts (`needs_reauth`) instead of daily re-enqueue + notification spam; replace the fixed 2s lock sleep with short jittered retry; skip avatar re-host unless changed (low). | V70 + low |
| P3.9 | **Misc consumers**: tools queue — process batch with bounded parallelism (V76); inbox consumer — parallelize batch after P3.4 (V34); weekly digest — filter opt-ins in SQL (V77); PubSubHubbub renewal — bounded concurrency (V51); `notifyRealtime` — KV presence flag to skip DO wake with zero clients (V78); platform-webhooks — negative account-resolution cache (V48), batch the per-DM dedup chain (V47). | V34 V47 V48 V51 V76–V78 |

## P4 — Move work off request paths ⚠ needs sign-off per item

Each item changes what the HTTP response means. The publish queue,
infrastructure, and `202` patterns already exist — these are wiring changes,
not new architecture.

| # | Change | Today | After | Findings |
|---|---|---|---|---|
| P4.1 | **`POST /v1/posts/{id}/retry` → queue** | Blocks until every platform call finishes (up to ~5 min for video) | Returns `202` + `status: "publishing"` immediately; result via webhook/GET | FP posts.ts:2104 (CRITICAL) |
| P4.2 | **`POST /v1/posts/bulk` "now" items → queue** | Publishes serially inline, can exceed Worker limits | Per-item `status: "publishing"`; batch inserts stay synchronous | FP posts.ts:2298 (CRITICAL) |
| P4.3 | **`POST /v1/posts/bulk-csv` → queue** (≤500 rows!) | Inline publish per row, partial-completion risk with no resume | `202` + job status endpoint | FP posts.ts:3372 |
| P4.4 | **`POST /v1/broadcasts/{id}/send` → enqueue/cron** | Sends entire broadcast inline (unbounded recipients, 1s sleeps) | Marks `sending`, cron drains with per-tick budget (pattern exists in WhatsApp processor) | V6 |
| P4.5 | **Ads endpoints** | `GET accounts`/`audiences` crawl Meta inline per request; `POST sync` runs the full sync inline | Discovery at connect time + background refresh; list reads DB; sync enqueues to `ADS_QUEUE`, returns `202` | V26 V27 V28 |
| P4.6 | **Automation webhook trigger + manual enroll → enqueue** | Full run executes on the HTTP request before the `202` | Enqueue run, `202` immediately (public endpoint — also a DoS surface today) | V8 |
| P4.7 | **Inbox comments: cache + background refresh** | Up to ~60 live Graph page fetches per `GET /v1/inbox/comments` | Serve persisted/cached comments; refresh via queue; bound moderation fan-out | V32 V41 |
| P4.8 | **Live analytics: stale-while-revalidate** | Cache-miss = serialized multi-call platform fan-out in-request | Serve stale + revalidate in `waitUntil`; per-post insights endpoints | V17 V20 V21 |
| P4.9 | **Response slimming** | Automations list returns full graph JSONB; runs list returns full context JSONB | Summary shape + `?include=graph` opt-in | V16 |
| P4.10 | **WhatsApp broadcasts pagination** | Deprecated route returns all rows; dashboard + SDK still use it | Paginated route + migrate SDK/dashboard, then deprecate | V64 |

## P5 — Platform / product decisions

1. **Hyperdrive query caching** (currently disabled): enabling collapses
   repeated SELECTs to ~ms but introduces ≤60s read-after-write staleness.
   Single biggest lever on the ~100ms floor besides Smart Placement.
2. **Smart Placement**: already enabled (§5.3.11) — re-measure once
   Cloudflare has observed traffic; roll back if user-to-worker hop dominates.
3. **`api_request_logs` retention**: add monthly `DELETE < now()-90d` cron, or
   sample GETs, or move to Workers Analytics Engine; also fixes the
   `COUNT(*)` cost in `GET /v1/usage/logs` (V65).
4. **Durable Object usage counters**: replaces the acknowledged non-atomic KV
   read-modify-write (lossy under burst) and the per-request blocking KV read.
5. **Worker decomposition**: split queue consumers + crons into a second
   worker only if cold start still matters after the §5 bundle work
   (measured ~125–130ms module eval today, V79).
6. **Dashboard (`apps/app`) follow-ups** (respect CLAUDE.md app rules):
   fix `bootstrap-key.ts` 1-year KV TTL (**security-adjacent, recommend now**,
   V86); calendar-view double fetch + sequential pagination (V84 V85);
   bootstrap dedupe + redundant background refreshes (V87); session
   cookie-cache for page views (V88); delete dead SSE route, dead deps
   (three.js/tsparticles stack), reduce observability sampling, prerender
   `/` and `/login` (lows).
7. **Publisher memory**: stream large media uploads instead of buffering up
   to 128MB in-Worker (FP publishers/twitter.ts:130) — per-platform work,
   needs upload-API review per platform.
8. **`pg_trgm` for inbox search** (V42) — only if message search is a real
   feature; otherwise cap/redesign the search input.

---

## Suggested execution order

1. **Immediately**: the 10 P0-B criticals (B1–B10) + P0 (all) — every one is
   either data corruption, money, cross-tenant access, or silent loss.
2. **Week 1**: P0-B highs by workstream (billing → publishing state machine →
   pagination → tenancy → webhooks/automations → OAuth → SDK drift),
   interleaved with P1.1–P1.9.
3. **Week 1–2**: P2 migration (one PR, tunnel required), P3.1–P3.5,
   P0-B mediums riding along with their workstreams.
4. **Week 2+**: P3.6–P3.9 (automation/ads/analytics consumers).
5. **After sign-off**: P4 items one at a time, each with SDK + docs updates
   (per CLAUDE.md, SDK must be updated with any route/schema change).
6. **Ongoing**: P5 decisions as product calls.

## Decision checklist (the items raised to the user)

| Decision | Recommendation |
|---|---|
| P4.1–P4.3 publish-path queueing (changes response semantics) | **Yes** — the codebase itself documents inline publishing as the cause of timeouts/duplicate retries |
| P4.4 broadcast send → `202` | **Yes** — current path cannot survive large recipient lists |
| P4.5 ads discovery/sync async | **Yes** — discovery results are already persisted; reads should be DB-only |
| P4.6 automation trigger async | **Yes** — public endpoint executing unbounded work inline is also a DoS surface |
| P4.7/P4.8 inbox/analytics caching | Yes, with TTLs tuned per product tolerance |
| P4.9/P4.10 response slimming + pagination | Yes, coordinated with SDK release (conventional-commit `feat(sdk)`) |
| Hyperdrive caching (P5.1) | Try `max_age=60s` behind a measurement window; revert if read-after-write complaints |
| DO usage counters (P5.4) | Defer until real traffic; KV losses are bounded and acknowledged |
| Worker split (P5.5) | Defer; re-measure cold starts post-§5 |
| `bootstrap-key.ts` TTL fix (P5.6) | **Do now** — it silently extends revoked-key validity to 1 year for dashboard-minted keys |
