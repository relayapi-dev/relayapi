# Realtime (WebSocket/DO) + Tools + Ads + Remaining Surface

## Overview

This flow document covers the realtime push surface and the "remaining" API surface of `apps/api`:

- **Realtime**: `GET /v1/ws-ticket` (ticket issuance), `GET /v1/ws` (WebSocket upgrade), the `RealtimeDO` Durable Object, and `notifyRealtime()` fan-out from posts/inbox/broadcast/streak/notification code paths.
- **Tools**: validation endpoints, media downloaders (7 platforms), YouTube transcript, the async tool-job lifecycle (KV + `TOOLS_QUEUE`), and the Python downloader VPS dependency.
- **Ads**: ad-account discovery, campaigns/ads CRUD, boost, analytics, audiences, interests, and the external ads sync (manual route + 30-min cron + `ADS_QUEUE`).
- **Misc routes**: `/health`, GMB (`/v1/accounts/{id}/gmb-*`), Reddit (`/v1/reddit/*`), Twitter engagement (`/v1/twitter/*`), signatures, content templates, ideas, idea groups, AI knowledge, and the inbox-AI service.

Entry points are mounted in `apps/api/src/app.ts`:
- `app.route("/v1/ws", websocketUpgrade)` at `src/app.ts:138` — mounted **before** the `/v1/*` auth middleware chain (handles its own ticket auth).
- `app.route("/v1/ws-ticket", websocketTicket)` at `src/app.ts:167` — behind the full `/v1/*` middleware chain (auth → db → ratelimit → readonly → bodycache → wsval → wsscope → usage; `src/app.ts:145–199`).
- `app.route("/health", health)` at `src/app.ts:120` — no auth, no DB.
- `/v1/tools`, `/v1/ads`, `/v1/accounts` (gmb piggybacks on the accounts prefix), `/v1/reddit`, `/v1/twitter`, `/v1/signatures`, `/v1/content-templates`, `/v1/ideas`, `/v1/idea-groups`, `/v1/ai-knowledge`, `/v1/inbox` (inbox-ai) — all behind the full `/v1/*` middleware chain.

---

## Step-by-step trace

### 1. WebSocket connect path

**Ticket issuance — `GET /v1/ws-ticket`** (`src/routes/websocket.ts:49–75`)
1. Full `/v1/*` middleware chain runs (auth incl. KV API-key cache / DB fallback, db context, rate limit, read-only check, body cache, workspace validation/scope, usage tracking) — `src/app.ts:145–199`.
2. `assertAllWorkspaceScope` (`websocket.ts:52`) — in-memory check, rejects workspace-scoped keys.
3. `crypto.randomUUID()` ticket generated (`websocket.ts:58`).
4. `KV.put("ws-ticket:" + ticket, {org_id, expires_at}, {expirationTtl: 60})` (`websocket.ts:61–65`) — **awaited**.
5. Returns `{ticket, expires_at, ws_url}`.

**Upgrade — `GET /v1/ws?ticket=...`** (`src/routes/websocket.ts:11–44`)
1. `Upgrade: websocket` header check (`websocket.ts:12–15`); raw `?token=` API keys explicitly rejected (`websocket.ts:17–27`).
2. `KV.get("ws-ticket:" + ticket, "json")` (`websocket.ts:34`) — 1 KV read.
3. `await KV.delete(...)` (`websocket.ts:39`) — 1 KV write, **serialized before** the DO connect (single-use ticket). Note KV deletes are eventually consistent globally anyway, so awaiting this buys little correctness.
4. DO routing: `c.env.REALTIME.idFromName(data.org_id)` → `stub.fetch(c.req.raw)` (`websocket.ts:41–43`). **DO usage pattern: one DO instance per organization**, addressed by `idFromName(orgId)`. The DO gets pinned to the region of first access; all subsequent connects/notifies from any colo pay an RTT to that location.

**Inside `RealtimeDO`** (`src/durable-objects/post-updates.ts`)
- Upgrade request: `new WebSocketPair()` + `this.ctx.acceptWebSocket(pair[1])` (`post-updates.ts:30–34`) — **WebSocket Hibernation API** (correct; DO sleeps between messages, no in-memory connection bookkeeping, no alarms).
- Client `ping` handled in `webSocketMessage` (`post-updates.ts:40–49`) — JSON parse + `pong`.
- Config: `wrangler.jsonc:32–44` — `REALTIME` binding, `new_sqlite_classes: ["RealtimeDO"]` (SQLite-backed; good). No storage is ever used; the DO is purely a connection broker.

### 2. Post-update notification fan-out

`notifyRealtime(env, orgId, event)` (`src/lib/notify-post-update.ts:36–52`):
1. `env.REALTIME.idFromName(orgId)` → `stub.fetch("http://internal/notify", {method: POST, body: JSON})` — **one DO round trip per event**, fire-and-forget semantics (errors swallowed) but the `fetch` itself is awaited by the caller.
2. In the DO (`post-updates.ts:15–27`): `request.json()`, `this.ctx.getWebSockets()`, `ws.send(payload)` loop. If **zero clients are connected, the DO is still woken from hibernation and billed**, and the caller still pays the RTT.

Callers (grep of `notifyRealtime`):
- `src/routes/posts.ts:1585, 1622, 1927, 1986, 2135, 2598` — all wrapped in `c.executionCtx.waitUntil(...)` → **off the response path** (good).
- `src/routes/inbox-feed.ts:785, 889` — `waitUntil` (good).
- `src/routes/inbox.ts:480` — `await notifyRealtime(...)` inside `invalidateInboxCache()` (`inbox.ts:460–482`), which is itself **awaited inline** at 6 call sites in comment reply/delete/hide/like handlers (`inbox.ts:1118, 1140, 1164, 1233, 1289, 1344`). `invalidateInboxCache` also does an org-wide `socialAccounts` SELECT plus one `KV.delete` per account before the DO notify — all serialized before the HTTP response.
- Queue/cron contexts (fine to await): `publisher-runner.ts:303`, `broadcast-processor.ts:55/112/205`, `whatsapp-broadcast-processor.ts:73/101/126/244`, `recycling-processor.ts:171`, `inbox-event-processor.ts:615`, `scheduler.ts:97`, `streak.ts:95/104/212`, `notification-manager.ts:166/283`.

### 3. Tool job lifecycle

**Sync-first download — `POST /v1/tools/{platform}/download`** (`src/routes/tools.ts:729–817`)
1. Full `/v1/*` middleware chain + `toolRateLimitMiddleware` (`src/middleware/tool-rate-limit.ts`) — 1 KV read for the daily counter; the counter write is deferred via `waitUntil` (`tool-rate-limit.ts:26–28`).
2. SSRF guard `isBlockedUrlWithDns(url)` (`tools.ts:736`; `src/lib/ssrf-guard.ts:286–298`) — for non-IP hostnames performs DNS-over-HTTPS lookups (`A` + `AAAA` in parallel, `ssrf-guard.ts:213–216`) with an in-isolate TTL cache (`ssrf-guard.ts:204–207`). Cold isolate / uncached host = 2 external DoH fetches.
3. Domain allowlist check (`tools.ts:743`, in-memory).
4. **Sync path**: `callDownloaderService(env, "/download", body, 20_000)` (`tools.ts:756–761`; `src/services/tool-service.ts:17–71`) — POST to the Python VPS (`DOWNLOADER_SERVICE_URL`) with `AbortController` timeout of **20 s**. If it answers in time → 200 with the result.
5. **Async fallback** (timeout or service down): `generateId("tj_")` → `createToolJob(KV, ...)` 1 KV put with 1 h TTL (`src/services/tool-jobs.ts:24–40`) → `TOOLS_QUEUE.send({type, job_id, org_id, endpoint, payload})` (`tools.ts:783–789`) → 202 + `poll_url`. Worst case a client waits the full 20 s and *then* receives a 202.
6. `POST /v1/tools/youtube/transcript` is the identical pattern (`tools.ts:854–915`).

**Queue consumer** (`src/queues/tools.ts:13–52`; wrangler `relayapi-tools`: `max_batch_size: 5, max_concurrency: 3, max_retries: 3`, `wrangler.jsonc:158–163`)
- Iterates the batch **sequentially**; per message: `callDownloaderService(..., 60_000)` → `completeToolJob` (KV get + put) or `failToolJob` (KV get + put). Retry with exponential `delaySeconds = 2 ** attempts`, fail-out after 3 attempts. Worst-case batch latency 5 × 60 s = 5 min (within the 15-min consumer budget).

**Polling — `GET /v1/tools/jobs/{job_id}`** (`tools.ts:945–1006`)
- Full middleware chain + 1 KV read (`getToolJob`, `tool-jobs.ts:82–87`); org ownership check in memory. Clients poll this endpoint (SDK-driven polling; the API itself has no push for tool jobs — tool completion does **not** go through `RealtimeDO`).

**Pure-CPU tool endpoints**: `/validate/post` (1 DB call via `resolveTargets`), `/validate/post-length` (no I/O), `/instagram/hashtag-checker` (static sets, no I/O), `/validate/media` (1–2 external HEAD/Range fetches with 5 s timeouts, `tools.ts:284–313`), `/validate/subreddit` (1 anonymous reddit.com fetch, no timeout, `tools.ts:396–403`), `/linkedin/resolve-mention` (1 DB select + decrypt + 1 LinkedIn REST call, `tools.ts:537–669`).

### 4. Ads flows

**`GET /v1/ads/accounts`** (`src/routes/ads.ts:126–204`)
1. If `social_account_id` is supplied, **`await adService.discoverAdAccounts(...)` runs inline** (`ads.ts:131–133`) before the DB read:
   - 1 DB select of the social account (`ad-service.ts:197–206`), token decrypt (`resolveAdsAccessToken` → AES-GCM `maybeDecrypt`, `ad-access-token.ts:126–151`),
   - Graph `GET /me/adaccounts` (`meta.ts:212–236`),
   - 1 DB select of all org Meta accounts (`ad-service.ts:253–268`),
   - **per ad account** `listPromotablePages` at concurrency 5 (`ad-service.ts:286–302`) — each is up to 10 paginated `promote_pages` Graph calls + ceil(pages/50) batched IG-lookup Graph calls (`meta.ts:257–312`),
   - chunked upsert of ad accounts (`ad-service.ts:79–123`), plus prune queries for unmatched accounts (`ad-service.ts:131–180`: 1 select + 2 parallel selects + delete/update).
2. Then the actual list query with JSONB containment filter on `metadata->'boostable_social_account_ids'` (`ads.ts:141–149`) and cursor pagination.

**`GET /v1/ads/audiences`** (`ads.ts:955–1004`) — **`await adAudienceService.discoverAudiences(...)` inline on every list** (`ads.ts:965`): 1 DB join select + token decrypt + 1 Graph `customaudiences` call (`meta.ts:318–354`) + chunked upsert (`ad-audience.ts:102–131`), then the local list query.

**`POST /v1/ads/boost`** (`ads.ts:629–661` → `ad-service.ts:576–758`): 1 DB select (external post or post-target join) → `getAccountWithToken` (1 join select + decrypt) → boostable-set guard → **5 sequential Meta calls + 2 parallel activation calls** (`meta.ts:489–592`: campaign, adset, creative, ad, then 2× status ACTIVE in `Promise.all`) → 2 DB inserts. All Meta calls capped at 20 s each (`META_FETCH_TIMEOUT_MS`, `meta.ts:38`).

**`GET /v1/ads/{id}/analytics`** (`ads.ts:738–770`): stored-metrics path = 1 select on `adMetrics` (≤366 rows); live path (`breakdowns` or empty store) = 1 join select + decrypt + 1–2 Graph insights calls (`ad-analytics.ts:182–273`).

**Manual sync — `POST /v1/ads/accounts/{id}/sync`** (`ads.ts:1158–1172`): **runs `adSync.syncExternalAds` synchronously in the request** (`ads.ts:1163`). See per-request work below — this is the heaviest endpoint in the audited surface.

**Cron sync** (`src/scheduled/index.ts:66–69`): every 30 min `syncAllExternalAds` pages `adAccounts` (status=active) 100 at a time and sends one `sync_external` message per account to `ADS_QUEUE` (`ad-sync.ts:285–327`). Consumer (`src/queues/ads.ts:17–86`; `max_batch_size: 5, max_concurrency: 3`, `wrangler.jsonc:164–169`) processes messages sequentially per batch; also handles `create_ad`, `boost_post`, `sync_metrics`, `upload_audience_users`.

**`syncExternalAds` internals** (`ad-sync.ts:43–279`):
1. 1 DB join select (ad account + social account) + token decrypt.
2. 1 Graph call `GET /act_X/ads?fields=...&limit=100` (`meta.ts:940–1010` — single page, max 100 ads, no pagination follow).
3. **Per external ad** (`ad-sync.ts:89–226`): SELECT campaign by platformCampaignId → INSERT or UPDATE campaign → SELECT ad by platformAdId → INSERT or UPDATE ad = **4 sequential DB round trips per ad** (up to ~400 for 100 ads).
4. Metrics refresh: select up to 200 active ads (`ad-sync.ts:229–239`), then `fetchAndStoreAdMetrics` in batches of 5 (`ad-sync.ts:247–256`). Each call = 1 DB join select + decrypt + 1 Graph insights call (30-day daily window) + **one sequential upsert per day-point** (`ad-analytics.ts:57–90` — up to 30 round trips per ad).
5. 1 INSERT into `adSyncLogs`.

### 5. Misc routes

- **`GET /health`** (`src/routes/health.ts:6`): static JSON, no I/O. ✔
- **GMB** (`src/routes/gmb.ts`): every handler = `getGmbContext` (1 DB select via `getOwnedAccount` + token decrypt) → 1 Google API proxy fetch via `gmbFetch` (`gmb.ts:52–90`) — **plain `fetch`, no timeout**.
- **Reddit** (`src/routes/reddit.ts:165–304`): 1 DB select + decrypt + 1 `oauth.reddit.com` fetch (no timeout). Pure proxy, cursor passthrough.
- **Twitter engagement** (`src/routes/twitter-engagement.ts`): 1 DB select + decrypt + 1 `api.twitter.com` fetch per action (no timeout).
- **Signatures / content templates / AI knowledge** (`signatures.ts`, `content-templates.ts`, `ai-knowledge.ts`): clean 1–3-query CRUD; transactions used for default-signature swaps; AI-knowledge cursor resolution costs one extra select when paginating (`ai-knowledge.ts:130–141`).
- **Ideas** (`src/routes/ideas.ts`): list path correctly batches tags+media in a parallel pair (`ideas.ts:301–320`) and presigns media via KV-cached R2 presigner (`lib/r2-presign.ts:47–71`, KV read per unique storage key, deferred KV write). Create path is ~8 sequential DB round trips (`ideas.ts:441–513`). Comments resolve actors with 2 batched selects (`ideas.ts:135–176`).
- **Idea groups** (`src/routes/idea-groups.ts`): `listIdeaGroups` runs `ensureDefaultGroup` (extra select, possible insert) on every GET (`idea-groups.ts:100`); `deleteIdeaGroup` re-positions moved ideas with one UPDATE per idea in `Promise.all` (`idea-groups.ts:334–345`).
- **Inbox AI** (`src/services/inbox-ai.ts`, `src/routes/inbox-ai.ts`): classify/suggest/summarize = 0–1 DB query + 1 Workers AI `ai.run()` (llama-3.1-8b) — latency dominated by inference (seconds), gated by `aiEnabledMiddleware`. `GET /v1/inbox/priorities` = `listConversations` (1 query) + **one latest-message query per conversation** in `Promise.all` (`inbox-ai.ts:303–315`).

---

## Per-request work (ordered, per flow)

**`GET /v1/ws-ticket`**: auth KV read (API-key cache) [+ DB on miss], rate-limit binding op, usage KV/DB ops (middleware chain) → 1 KV put (ticket). No DB in the handler itself.

**`GET /v1/ws` (connect)**: 1 KV read (ticket) → 1 KV delete (awaited) → 1 DO `fetch` (upgrade, held open as the socket). No DB, no crypto.

**`notifyRealtime` (per event)**: 1 DO `fetch` RTT (wakes hibernated DO) → JSON stringify + N `ws.send`. When called via `invalidateInboxCache` (inbox mutations): + 1 DB select (all org social accounts) + N parallel KV deletes, all serialized pre-response.

**`POST /v1/tools/{platform}/download`**: middleware (1 KV read counter, deferred put) → 0–4 DoH fetches (cached per isolate) → 1 VPS fetch (≤20 s) → [fallback] 1 KV put + 1 queue send. Consumer: 1 VPS fetch (≤60 s) + 1 KV get + 1 KV put. Poll: 1 KV get per poll.

**`GET /v1/ads/accounts?social_account_id=X`**: 1 DB select → 1 AES-GCM decrypt → 1 Graph call → 1 DB select (connected accounts) → up to ceil(N/5) × (≤11 Graph calls each) → ceil(N/100) DB upserts [+ up to 4 prune queries] → 1 DB list select. Without `social_account_id`: 1 DB list select only.

**`POST /v1/ads/accounts/{id}/sync`** (inline): 1 DB join select + decrypt → 1 Graph ads call → up to 100 × 4 sequential DB round trips → 1 DB select (active ads) → up to 200 × (1 DB join select + decrypt + 1 Graph insights call + ≤30 sequential DB upserts), batches of 5 → 1 DB insert (sync log). Worst case ≈ **6,400+ DB round trips and 201 Graph calls in one HTTP request**.

**`GET /v1/inbox/priorities`**: 1 DB query (conversations) + up-to-`limit` parallel DB queries (latest message each) → in-memory scoring/sort.

**Ideas create**: ≤2 DB (default group) + 1 DB (max position) + 1 insert + 0–1 tag insert + 0–1 media insert + 1–2 activity inserts + 2 parallel selects + 0–N KV reads (presign cache).

**GMB / Reddit / Twitter actions**: 1 DB select + 1 AES-GCM decrypt + 1 external fetch (no timeout).

---

## External calls

| Flow | Destination | Timeout | Notes |
|---|---|---|---|
| Tools download/transcript | Python VPS (`DOWNLOADER_SERVICE_URL`) | 20 s sync / 60 s queue | AbortController; falls back to queue on timeout |
| Tools SSRF guard | DoH endpoints (`ssrf-guard.ts`) | per-fetch | in-isolate TTL cache |
| Tools subreddit/media validate | reddit.com / arbitrary URL | none / 5 s | subreddit check has **no timeout** |
| LinkedIn mention resolver | `api.linkedin.com` | none | |
| Ads (all) | `graph.facebook.com` via `metaFetch` | 20 s (`meta.ts:38`) | consistent timeout — good |
| GMB | `mybusiness*.googleapis.com` | **none** (`gmb.ts:58`) | raw fetch |
| Reddit routes | `oauth.reddit.com` | **none** | raw fetch |
| Twitter engagement | `api.twitter.com` | **none** | raw fetch |
| Inbox AI | Workers AI binding (`@cf/meta/llama-3.1-8b-instruct`) | platform-managed | seconds per call |
| Realtime | `RealtimeDO` (per-org DO) | n/a | RTT to pinned DO location |

---

## Performance notes

1. **Inline Meta discovery on ads list endpoints is the dominant latency source.** `GET /v1/ads/accounts?social_account_id=…` serializes a multi-call Graph crawl (up to ~11 calls per ad account) plus DB upserts before reading the local table (`ads.ts:131–133`, `ad-service.ts:182–359`); `GET /v1/ads/audiences` serializes one Graph call + upserts on **every** request (`ads.ts:965`). Both store the data locally and already record `promote_pages_synced_at` — a staleness-gated background refresh (waitUntil/queue) would make these pure DB reads.
2. **`POST /v1/ads/accounts/{id}/sync` does a full external sync inline** — worst case thousands of sequential DB round trips + 200 Graph calls in one request; it should be enqueued to `ADS_QUEUE` (the consumer already supports `sync_external`).
3. **N+1 patterns**: per-ad campaign/ad upserts in `syncExternalAds` (`ad-sync.ts:91–226`), per-day metric upserts (`ad-analytics.ts:57–90`), per-conversation latest-message lookups in `/v1/inbox/priorities` (`inbox-ai.ts:303–315`), per-idea UPDATEs on group delete (`idea-groups.ts:334–345`).
4. **Realtime is structurally sound** (per-org DO, hibernation API, no polling anywhere in this surface — the only polling is client-side tool-job polling by design) but `notifyRealtime` pays a DO wake + RTT per event even with zero listeners, and the inbox mutation paths serialize cache invalidation + DO notify before responding (`inbox.ts:1118` etc.).
5. **Cron cost**: the 30-min ads cron re-fetches a 30-day insights window for up to 200 ads per account, 48×/day — heavy Meta API and DB-write cost for data that changes at most daily for past days.
6. **Missing fetch timeouts** on GMB/Reddit/Twitter proxies (the Meta adapter and tool service show the in-repo pattern to copy: `fetchWithTimeout` / AbortController).
7. **Cold start**: this surface adds `@aws-sdk/client-s3` + presigner (ideas media presign, shared with posts) to the bundle; the Meta ads adapter and tools are plain `fetch` code with negligible init cost. `RealtimeDO` is in the same worker script — no extra cold-start penalty beyond class registration.
