# Webhooks + Billing Flow

## Overview

This document traces four related flows in `apps/api`:

1. **Outbound webhook delivery** — RelayAPI notifying customer endpoints of events (`post.published`, `account.connected`, `message.received`, etc.). Implemented in `apps/api/src/services/webhook-delivery.ts`, configured via `apps/api/src/routes/webhooks.ts` (`/v1/webhooks` CRUD + `/test` + `/logs`).
2. **Inbound platform webhooks** — Meta (Facebook/Instagram), YouTube PubSubHubbub, WhatsApp Cloud API, Telegram, Twilio SMS. Implemented in `apps/api/src/routes/platform-webhooks.ts`, mounted **without auth** at `/webhooks/platform` (`apps/api/src/app.ts:124`).
3. **Stripe webhooks + billing lifecycle** — `apps/api/src/routes/stripe-webhooks.ts` (mounted at `/webhooks/stripe`, `apps/api/src/app.ts:121`), `services/invoice-generator.ts` (monthly cron), `services/dunning.ts` (daily cron), `services/stripe.ts` (cached client).
4. **Usage tracking / metering** — `apps/api/src/middleware/usage-tracking.ts` (applied to all `/v1/*`, `apps/api/src/app.ts:193`), `middleware/feature-gate.ts`, read back via `routes/usage.ts`. Adjacent admin routes: `org-settings.ts`, `api-keys.ts`, `workspaces.ts`, `invite.ts`.

---

## Step-by-step trace

### 1. Outbound webhook delivery

**Entry point:** `dispatchWebhookEvent(env, db, orgId, event, data, workspaceId?)` — `src/services/webhook-delivery.ts:132`.

Call sites and invocation mode (this determines whether delivery blocks anything):

| Caller | Mode | Context |
|---|---|---|
| `src/routes/posts.ts:1612`, `:1875` (`post.scheduled`) | `c.executionCtx.waitUntil(...)` | API request — non-blocking ✓ |
| `src/routes/accounts.ts:599` (`account.disconnected`) | `waitUntil` | API request — non-blocking ✓ |
| `src/routes/connect.ts:938` (`account.connected`) | **`await`** | inside `exchangeAndSaveAccount()` (`connect.ts:627`) — runs **inline on the OAuth browser-redirect path** via `src/routes/oauth-callback.ts:78` and `connect.ts:2844` |
| `src/routes/connect.ts:1078–2634` (newsletter/api-key connects) | mostly `waitUntil` | non-blocking ✓ |
| `src/services/publisher-runner.ts:296` (`post.published/failed/partial`) | **`await`** | publish queue consumer — blocks the batch |
| `src/services/inbox-event-processor.ts:583`, `:1644` | **`await`** | inbox queue consumer — blocks the batch |
| `src/services/cross-post-processor.ts:142`, `:161`; `auto-post-processor.ts:270`, `:394`; `recycling-processor.ts:202` | **`await`** | cron/scheduled contexts |
| `src/services/streak.ts:78–196` | fire-and-forget | ✓ |
| `src/services/thread-publisher.ts:338` | `void` (fire-and-forget) | ✓ |

**Inside `dispatchWebhookEvent`** (`webhook-delivery.ts:132–165`):
1. `db.select().from(webhookEndpoints).where(orgId AND enabled)` — 1 DB query per event, fetches **full rows** (including hashed secret) for all enabled endpoints of the org (`:140–148`).
2. Event/workspace filtering happens in JS (`:152–158`), not SQL.
3. `Promise.allSettled` over `deliverWebhook` per matching endpoint (`:150`) — endpoints run in parallel; the awaiting caller still waits for the **slowest** endpoint.

**Inside `deliverWebhook`** (`webhook-delivery.ts:39–127`), per endpoint:
1. `generateId("whd_")` + `JSON.stringify` payload (`:45–53`).
2. `env.KV.get("webhook-secret:{id}")` — 1 KV read (`:57`).
3. `maybeDecrypt(...)` — AES-256-GCM decrypt (`:58`).
4. `signPayload` — HMAC-SHA256 importKey + sign (`:20–33`, `:68`).
5. **SSRF re-validation** `isBlockedUrlWithDns(webhook.url)` (`:73`) → `src/lib/ssrf-guard.ts:286`. On per-isolate DNS-cache miss (cache is an in-memory `Map`, 5-min TTL, `ssrf-guard.ts:19,25`): up to 2 DoH endpoints tried sequentially (`dns.google`, then `cloudflare-dns.com`, `:21–24, :211–232`), each doing **A + AAAA lookups in parallel** with a 2.5 s timeout each (`:20, :213–216`). Worst case ≈ 5 s of external DNS fetches per cold delivery.
6. **Retry loop** (`:84–109`): up to 3 `fetchWithTimeout` POSTs at 5 s timeout each (`:87–93`), with in-process `setTimeout` backoff sleeps of 1 s and 4 s between attempts (`:106–108`; the comment says "1s, 4s, 9s" but the third sleep never executes). Worst case for a dead endpoint: 5 + 1 + 5 + 4 + 5 = **~20 s wall time** (plus up to ~5 s DNS) per endpoint.
7. **Logging** (`:111–126`): `const db = createDb(env.HYPERDRIVE.connectionString)` — a **fresh postgres client per delivery** (the `db` handle held by `dispatchWebhookEvent` is not passed down) — then 1 `INSERT` into `webhookLogs`.

**Retry policy summary:** inline (in-process) retries only — 3 attempts, 5 s timeout, quadratic backoff (1 s, 4 s). No queue, no durable retry, no endpoint-level circuit breaker / auto-disable. Failed deliveries after 3 attempts are recorded in `webhookLogs` and dropped.

**Webhook CRUD** (`src/routes/webhooks.ts`):
- `POST /v1/webhooks` (`:276–337`): `assertScopedCreateWorkspace` → `isBlockedUrlWithDns` (DoH, up to ~5 s worst case) → SHA-256 hash of generated secret → 1 INSERT → `maybeEncrypt` (AES-GCM) → `KV.put("webhook-secret:{id}", …, ttl 1y)`.
- `POST /v1/webhooks/test` (`:435–516`): 1 DB select → `isBlockedUrlWithDns` → **bare `fetch(webhook.url)` with no timeout** (`:474`) → 1 INSERT into `webhookLogs`. A hung customer endpoint stalls this request until the platform-level fetch limit.
- `GET /v1/webhooks/logs` (`:518–586`): for `workspaceScope === "all"`, `select()` of full rows **including the `payload` JSON column** (`:527–529`), and the response includes `payload` per row (`:578`) even though `WebhookLogEntry` (`:186–195`) doesn't declare it — up to 100 payload blobs per page.

### 2. Inbound platform webhooks (`src/routes/platform-webhooks.ts`, no auth middleware)

All POST handlers follow the same shape: **read body → verify signature (CPU-only crypto) → `JSON.parse` → `ctx.waitUntil(process…)` → return 200.** There are **no DB or KV operations before the 200** on any platform handler (good — Meta requires a response within 5 s, noted at `:206`).

- **`POST /facebook`** (`:180–231`): `c.req.text()` → `verifyHmacSha256` against `FACEBOOK_APP_SECRET`, falling back to `INSTAGRAM_LOGIN_APP_SECRET` (`:190–199`) — at most 2 HMAC computations → `JSON.parse` → skip-check for FB-app Instagram events → `ctx.waitUntil(processFacebookWebhook(...))` (`:228`) → `200`.
- **`GET /facebook` / `GET /whatsapp`** (`:164–177`, `:650–663`): verify-token challenge via `safeEqual` (double HMAC, `:10–26`) — instant.
- **`POST /youtube`** (`:549–587`): optional HMAC (SHA-1/SHA-256) verify if `YOUTUBE_HUB_SECRET` set → `waitUntil(processYouTubeWebhook)` → `200`.
- **`POST /whatsapp`** (`:666–683`): HMAC verify → `waitUntil(processWhatsAppWebhook)` → `200`.
- **`POST /telegram/:secret`** (`:770–803`): header-secret `safeEqual`, or SHA-256-of-bot-token derivation (`:786–793`) → `waitUntil(processTelegramWebhook)` → `200`.
- **`POST /sms`** (`:854–904`): `parseBody()` (form) → Twilio HMAC-SHA1 over URL+sorted params (`:870–893`) → `waitUntil(processSmsWebhook)` → TwiML `200`.

**Deferred processing — `processFacebookWebhook`** (`:249–524`), the heaviest path:
1. `createDb(...)` once (`:255`).
2. Per `entry`:
   - `resolveAccount(env, platform, entry.id)` (`:92–157`): KV get `platform-account:{platform}:{id}` (TTL **300 s**); on miss 1–2 DB selects on `socialAccounts` (+ Instagram `webhookAccountId` fallback) + KV put.
   - **Extra DB select** of the same `socialAccounts` row to build `knownBusinessIds` (`:321–328`) — data that `resolveAccount` could have cached.
   - KV get `ig-sender-id:{accountId}` (`:333`).
   - Per `change`: `INBOX_QUEUE.send` (`:273`); for feed events a KV get/put `sync-dedup:{accountId}` + `SYNC_QUEUE.send` (`:294–309`).
   - Per `messaging` item (echo dedup, all **serial** in the loop):
     - Layer 1 (echo/known sender): KV get `outbound-mid:{mid}` (`:419`), DB select on `inboxMessages.platformMessageId` (`:426–430`, indexed via `inbox_msg_platform_message_id_idx`, `packages/db/src/schema.ts:1131`), KV get/put `msg-dedup:{mid}`, then `INBOX_QUEUE.send`.
     - Layers 2–4 (inbound): KV get `outbound-mid:{mid}` (`:463`) → DB select by `platformMessageId` (`:469–473`) → **DB join query** `inboxMessages ⋈ inboxConversations` matching outbound text within a 15 s window (`:484–499`) → KV get/put `msg-dedup` → `INBOX_QUEUE.send` (`:512`).
   - Worst case per inbound DM: **2 DB queries + 3–4 KV ops + 1 queue send**, sequential per message.
3. All of this is post-response (`waitUntil`) — it does not delay the 200, but it is O(entries × messages) serialized round trips per webhook POST at Meta delivery volume.

`processYouTubeWebhook` (`:589–643`), `processWhatsAppWebhook` (`:717–763`), `processTelegramWebhook` (`:821–847`), `processSmsWebhook` (`:906–939`): regex/loop parse → `resolveAccount` (KV-cached) → 1–2 `INBOX_QUEUE.send` (+ `SYNC_QUEUE.send` with KV dedup for YouTube). The SMS handler may call `resolveAccount` **twice** (`+`-prefixed and stripped, `:918–920`).

**Webhook subscription management** (`src/services/webhook-subscription.ts`) is connect-time / cron-time only: 1–2 Graph API or PubSubHubbub fetches per call. `renewYouTubePubSubSubscriptions` (`:322–349`, daily cron) loops **serially** over every YouTube account — one external fetch each.

### 3. Stripe webhooks (`src/routes/stripe-webhooks.ts`)

`POST /webhooks/stripe` (`:45–78`):
1. `createStripeClient` — module-cached singleton (`services/stripe.ts:3–13`), no per-request construction cost after first call.
2. `c.req.text()` → `stripe.webhooks.constructEventAsync` (WebCrypto HMAC verify, `:54–58`).
3. **1 serialized KV read pre-200**: dedup check `stripe-evt:{event.id}` (`:66–68`).
4. `ctx.waitUntil(handleEvent(event, env).then(() => KV.put(dedupKey, ttl 7d)))` (`:70–75`) → `200`. The dedup mark is only written **after** the handler succeeds, so retried events re-run `handleEvent` if it threw (handlers are individually idempotent-ish via upserts/status checks).

**`handleEvent`** (`:80–431`), deferred:
- `createDb` per event (`:81`).
- `checkout.session.completed`: Stripe API `subscriptions.retrieve` (external fetch) → 1–2 DB queries → `syncOrgKeysToKV`.
- `customer.subscription.updated`/`deleted`, `invoice.finalized`/`paid`/`payment_failed`: 1 select + 1–2 updates/inserts each, plus `syncOrgKeysToKV` on plan transitions and `sendNotificationToOrg` (fire-and-forget) on payment failure (`:413–424`).
- **`syncOrgKeysToKV`** (`:433–458`): SELECT all `apikey` rows for the org, then a **serial loop of KV get + KV put per key** (`:447–456`) to mutate the cached plan. O(2 × keys) sequential KV round trips, in `waitUntil`.

**Billing crons:**
- `generateInvoices` (`services/invoice-generator.ts:21–155`), gated to `event.cron === "0 0 1 * *"` (`src/scheduled/index.ts:39–41`) plus an internal `getUTCDate() !== 1` guard (`:25`). Batched (50/100) scans of `organizationSubscriptions`; per due sub: 1–2 `usageRecords` selects + optional Stripe `invoiceItems.create` (external), all **serial**. Per inactive sub: `syncOrgKeysToKV` (serial KV loop).
- `processDunning` (`services/dunning.ts:27–168`), daily 9am cron: select up to 100 past_due subs; per sub **5 serial DB queries** (unpaid invoice, dunning events, owner email join, org name, + insert) plus email-queue sends and Stripe `subscriptions.cancel` on day 14. Off hot path.
- Note: the "every minute" block in `src/scheduled/index.ts:29–36` is **not gated on `event.cron`**, so when the `*/5`, `*/30`, daily, weekly, or monthly cron expressions fire, the seven every-minute jobs (`processScheduledPosts`, `processRecyclingPosts`, broadcasts, cross-posts, automation schedule/timeouts) execute a **second/third concurrent time** in that minute.

### 4. Usage tracking write path (`src/middleware/usage-tracking.ts`, applied to all `/v1/*` at `app.ts:193`)

**GET/HEAD** (`:208–226`): handler runs first; afterwards `waitUntil(persistUsageAndLogs(...))` → **1 Postgres INSERT into `api_request_logs` per GET request** (billable=false).

**Non-GET** (`:228–357`), in order:
1. `getUsageUnits(c)` (`:235`, `:119–139`): for the 5 bulk endpoints, re-parses a clone of the JSON body (or full CSV parse for `/v1/posts/bulk-csv`, `:105–117`); for everything else returns 1 without body work.
2. **Serialized KV read** of the monthly counter `usage:{orgId}:{YYYY-MM}` (`:246`) — required for the free-plan gate and threshold detection; runs before the handler on **every billable request**. The KV **write** of the incremented counter is deferred via `waitUntil` (`:249–253`). (Read-modify-write is non-atomic; acknowledged in the comment at `:240–242`.)
3. Threshold notifications at 80%/100% — fully deferred, KV-deduped (`:256–301`).
4. Free-plan hard gate (`:304–329`): 403 without running the handler; still logs via `waitUntil`.
5. After `next()`: `waitUntil(persistUsageAndLogs(...))` (`:338–356`) → **2 Postgres statements per billable request** in `Promise.allSettled`: INSERT `api_request_logs` + upsert `usage_records` with `ON CONFLICT … apiCallsCount + units` (`:147–191`). The DB counter is the billing source of truth.

**Full middleware-stack ops on a hot `POST /v1/posts`** (order per `app.ts:140–193`):
1. `authMiddleware` — 1 KV get `apikey:{hash}` (`middleware/auth.ts:133`; DB fallback on miss).
2. `dbContextMiddleware` — `createDb` (allocation only; Hyperdrive pools TCP).
3. `rateLimitMiddleware` — CF rate-limiter binding call.
4. `bodyCacheMiddleware` — single body parse, cached.
5. `workspaceValidationMiddleware` — KV get `ws-valid:{org}:{ws}` per referenced workspace_id (DB fallback) (`middleware/workspace-validation.ts:42–64`).
6. `workspaceRequiredMiddleware` — **1 KV get `org-settings:{orgId}` on every POST** to posts/webhooks/broadcasts/custom-fields/ads/auto-post-rules/content-templates/threads (`middleware/feature-gate.ts:41–44`; route bindings `app.ts:173–180`).
7. `usageTrackingMiddleware` — 1 KV get (counter).

That is **3–5 serialized KV reads before the route handler executes** on a typical POST.

`GET /v1/usage` (`routes/usage.ts:45–135`): subscription select ∥ KV counter (parallel, `:55–62`), then 1 dependent `usageRecords` select. `GET /v1/usage/logs` (`:177–225`): rows select ∥ `COUNT(*)` over the org's full log history per page request.

### 5. Admin routes (light)

- `api-keys.ts`: create = optional workspace-validation select + SHA-256 + INSERT + KV put (`:156–246`); delete = select + KV delete + DB delete. All single-digit round trips.
- `workspaces.ts`: list = single `json_agg` join query (`:159–173`) ✓; update = UPDATE + a second select for account ids (`:245–267`); delete invalidates `ws-valid` KV via `waitUntil` (`:307`).
- `invite.ts`: create = **4 sequential DB queries** (apikey→referenceId, member role, workspace validation, INSERT) (`:176–266`); the first two are independent and could be parallelized. Low traffic.
- `org-settings.ts`: PATCH = upsert + KV put `org-settings:{orgId}` (no TTL) (`:129–142`, `:155–177`); GET = 1 select.

---

## Per-request work

### Outbound delivery (per `dispatchWebhookEvent` call)
| # | Op | Where |
|---|---|---|
| 1 | DB SELECT all enabled `webhook_endpoints` for org (full rows) | `webhook-delivery.ts:140` |
| per endpoint | KV GET `webhook-secret:{id}` | `:57` |
| per endpoint | AES-256-GCM decrypt + HMAC-SHA256 sign | `:58`, `:68` |
| per endpoint | DoH DNS A+AAAA (×1–2 endpoints, 2.5 s timeout) on isolate-cache miss | `:73` → `ssrf-guard.ts:211` |
| per endpoint | 1–3 external POSTs (5 s timeout) + 0–5 s of backoff sleeps | `:84–109` |
| per endpoint | `createDb` (new pg client) + INSERT `webhook_logs` | `:113–123` |

### Inbound Meta webhook (per POST)
Pre-200: body read + 1–2 HMAC verifies + `JSON.parse`. **Zero KV/DB/external ops.**
Post-200 (`waitUntil`): per entry — 1 KV get (+1–2 DB selects + 1 KV put on miss) + **1 redundant DB select** (`:321–328`) + 1 KV get; per message — up to 2 DB selects + 3–4 KV ops + 1 queue send, serial.

### Stripe webhook (per POST)
Pre-200: HMAC verify + **1 KV get** (dedup). Post-200: 1–4 DB queries, 0–1 Stripe API fetches, O(keys) serial KV get/put pairs, 1 KV put (dedup mark).

### Every authenticated API request (usage tracking)
- GET: 1 deferred DB INSERT (`api_request_logs`).
- non-GET: 1 **blocking** KV get + 1 deferred KV put + 2 deferred DB writes (`api_request_logs` INSERT + `usage_records` upsert), plus the `org-settings` KV get on gated POST routes.

## External calls

| Call | Trigger | Timeout / retry |
|---|---|---|
| Customer webhook endpoint POST | every dispatched event × endpoint | 5 s, 3 attempts, 1 s/4 s sleeps (`webhook-delivery.ts:87–108`) |
| DoH `dns.google` / `cloudflare-dns.com` | SSRF check per delivery / webhook create / update / test (isolate-cached 5 min) | 2.5 s each (`ssrf-guard.ts:20–24`) |
| Customer webhook endpoint POST (test) | `POST /v1/webhooks/test` | **no timeout** (`webhooks.ts:474`) |
| Stripe API (`subscriptions.retrieve`, `invoiceItems.create`, `subscriptions.cancel`) | checkout webhook (deferred), monthly invoice cron, dunning day-14 | Stripe SDK defaults |
| Meta Graph / PubSubHubbub subscribe | connect-time, daily YouTube renewal cron (serial per account) | none beyond fetch defaults |

## Performance notes

1. **`account.connected` webhook delivery is awaited on the OAuth browser-redirect path** (`connect.ts:938` via `oauth-callback.ts:78`). A slow/dead customer endpoint holds the end-user's browser on `/connect/oauth/callback` for up to ~20–25 s (3×5 s fetches + 5 s sleeps + cold DoH) before the 302 redirect. Should be `ctx.waitUntil`.
2. **Queue consumers serialize on customer endpoints**: `publisher-runner.ts:296` and `inbox-event-processor.ts:583/:1644` `await dispatchWebhookEvent`, so one failing endpoint adds up to ~20 s per message to publish/inbox queue processing (batch size 10), throttling throughput. In-process `setTimeout` backoff (`webhook-delivery.ts:107`) burns worker wall time; queue-native retries (separate delivery queue + `retry()`/DLQ) would be both more durable and non-blocking.
3. **Per-request Postgres writes**: usage tracking issues 1 INSERT per GET and 2 statements per non-GET — DB write QPS ≈ 1.5–2× API QPS through Hyperdrive. Deferred, so latency-safe, but a throughput/cost ceiling; candidates: batch via a queue, or Workers Analytics Engine for `api_request_logs`.
4. **Serialized KV reads stack pre-handler**: auth (1) + workspace-validation (0–2) + org-settings (1 on gated POSTs) + usage counter (1) = 3–5 sequential KV round trips per write request. The `org-settings` flag could live inside the `apikey:{hash}` KV record (which already carries plan/ai_enabled/scope), and the usage-counter get could run in parallel with `getUsageUnits`.
5. **Inbound platform webhooks return 200 fast** — only crypto + body parse pre-response on every handler; all KV/DB/queue work is in `waitUntil`. The only pre-200 storage op in any webhook receiver is Stripe's single dedup KV get.
6. **Deferred Meta processing is chatty**: redundant per-entry `socialAccounts` select (`platform-webhooks.ts:321–328`) duplicating data `resolveAccount` already fetched (extend the KV-cached lookup payload with `pid`/`wid`), short 300 s KV TTL on account resolution, and a serial 2-DB-query + 3-KV-op dedup chain per DM.
7. **`deliverWebhook` builds a fresh postgres client per delivery** (`webhook-delivery.ts:113`) instead of reusing the `db` its caller already holds.
8. **Cron overlap**: `scheduled/index.ts:29–36` runs the every-minute job set for *all six* cron expressions, so those jobs run 2–4× concurrently whenever `*/5`, `*/30`, daily/weekly/monthly triggers coincide with the minute tick — duplicated DB scans and a double-processing race window.
9. `POST /v1/webhooks/test` uses a bare `fetch` with no timeout (`webhooks.ts:474`); `GET /v1/webhooks/logs` returns full `payload` blobs in the list response (`webhooks.ts:527, :578`) despite the schema omitting them.
