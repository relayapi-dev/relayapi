# Posts + Publishing Flow

## Overview

This flow covers the lifecycle of a post in RelayAPI: creation (single, bulk JSON, bulk CSV, thread), validation and target resolution, media handling (R2 presigning), scheduling (explicit timestamp, `now`, `draft`, `auto` slot-finding), queue production/consumption (`PUBLISH_QUEUE` → `relayapi-publish`), platform publishing (21 publishers), status updates, webhooks, and the cron-driven side flows (scheduler, recycling, cross-post actions, RSS auto-post).

**Entry points**

| Entry | File | Notes |
|---|---|---|
| `GET /v1/posts` (listPosts) | `apps/api/src/routes/posts.ts:557` | hottest read path |
| `GET /v1/posts/logs` | `apps/api/src/routes/posts.ts:1069` | |
| `POST /v1/posts` (createPost) | `apps/api/src/routes/posts.ts:1115` | hottest write path |
| `GET /v1/posts/{id}` | `apps/api/src/routes/posts.ts:1648` | |
| `PATCH /v1/posts/{id}` | `apps/api/src/routes/posts.ts:1745` | |
| `DELETE /v1/posts/{id}` | `apps/api/src/routes/posts.ts:1957` | |
| `POST /v1/posts/{id}/retry` | `apps/api/src/routes/posts.ts:1992` | publishes inline (!) |
| `POST /v1/posts/bulk` | `apps/api/src/routes/posts.ts:2163` | publishes inline (!) |
| `POST /v1/posts/{id}/unpublish` | `apps/api/src/routes/posts.ts:2363` | |
| `POST /v1/posts/bulk-csv` | `apps/api/src/routes/posts.ts:3003` | up to 500 rows, publishes inline (!) |
| `/{id}/recycling`, `/{id}/recycled-copies`, `/{id}/notes`, `/{id}/logs`, `/{id}/update-metadata` | `apps/api/src/routes/posts.ts` | sub-resources |
| `POST /v1/threads`, `GET/DELETE /v1/threads/*` | `apps/api/src/routes/threads.ts` | thread CRUD |
| `GET/POST/PUT/DELETE /v1/queue/*` | `apps/api/src/routes/queue.ts` | KV-backed schedules, slot finding |
| Cron (`* * * * *`) | `apps/api/src/scheduled/index.ts:30-36` | `processScheduledPosts`, `processRecyclingPosts`, `processCrossPostActions` |
| Cron (`*/5 * * * *`) | `apps/api/src/scheduled/index.ts:60` | `processAutoPostRules` (RSS) |
| Queue consumer `relayapi-publish` | `apps/api/src/queues/publish.ts:21` | `consumePublishQueue` |

All `/v1/*` requests first traverse the middleware stack in `apps/api/src/app.ts:140-180` (auth, dbContext — one shared `createDb` per request via `c.get("db")`, rate limit, read-only, body cache, workspace validation, workspace scope, workspace-required for `/v1/posts/*` and `/v1/threads/*`).

---

## Step-by-step trace

### 1. Create post → `POST /v1/posts` (`routes/posts.ts:1115`)

1. **Zod validation** of `CreatePostBody` via `@hono/zod-openapi` (route registration `posts.ts:146`).
2. **Target resolution** — `resolveTargets(db, orgId, body.targets, workspaceScope)` (`posts.ts:1124`; impl `services/target-resolver.ts:48`):
   - 1 DB query fetching **all** social accounts of the org (`target-resolver.ts:96-105`).
   - +1 DB query if any `ws_*` workspace targets (`target-resolver.ts:138-146`).
3. **Scheduling intent** (`posts.ts:1133-1163`): `"draft"` → null; `"now"` → `new Date()`; `"auto"` → dynamic-import `findBestSlot` (`services/slot-finder.ts:283`):
   - KV get `queue-schedule:{orgId}` (`slot-finder.ts:108-111`).
   - KV get best-time cache; on miss a DB JOIN over published posts (`services/best-time-cache.ts:27-44`).
   - 1 DB query for collision check over the candidate window (`slot-finder.ts:181-191`).
   - +1 DB query for the account's `schedulingPreferences` when `accountId` set (`slot-finder.ts:210-214`).
4. **Template resolution** — 1 DB query when `template_id` set (`posts.ts:1180-1189`).
5. **Idea resolution** — 1 DB query when `idea_id` set (`posts.ts:1219-1223`).
6. **Signature injection** — 1 DB query on *every* create with content unless `skip_signature` (`posts.ts:1236-1245`).
7. **URL shortening (Pro)** — 1 DB query for `shortLinkConfigs` (`posts.ts:1263-1267`), `maybeDecrypt` of provider API key (AES-256-GCM), then 1 external HTTP call per URL via the provider (`shortenUrlsInContent`, `posts.ts:1293`).
8. **Transaction** (`posts.ts:1323-1519`) — interactive `BEGIN…COMMIT` through Hyperdrive, each statement a serialized round trip:
   - `INSERT posts … RETURNING` (`posts.ts:1325-1338`)
   - `INSERT shortLinks` if URLs shortened (`posts.ts:1352-1360`)
   - `INSERT usageRecords … ON CONFLICT DO UPDATE` (skip drafts) (`posts.ts:1368-1385`)
   - bulk `INSERT postTargets` (`posts.ts:1400-1402`)
   - recycling (Pro): `validateRecyclingConfig` = 2 more queries (targets + active-config count, `services/recycling-validator.ts:38-80`) + `INSERT postRecyclingConfigs` (`posts.ts:1445-1461`)
   - cross-post actions: 1 SELECT to validate account ownership + 1 INSERT (`posts.ts:1479-1515`)
9. **Post-commit side effects** — all via `c.executionCtx.waitUntil` (non-blocking): idea conversion updates (2 queries, `posts.ts:1532-1545`); for `now`: `PUBLISH_QUEUE.send({type:"publish", usage_tracked:true})` (`posts.ts:1576-1583`) + `notifyRealtime` DO fetch (`posts.ts:1584-1590`); for `scheduled`: `dispatchWebhookEvent("post.scheduled")` (`posts.ts:1611-1618`).
10. **Response** — `presignMediaUrls` over `body.media` (KV get per unique storage key; AWS SigV4 HMAC sign on cache miss; `lib/r2-presign.ts:47-71`) then 201 JSON (`posts.ts:1592-1644`).

Key point: single-post `now` publishing is **asynchronous** (queue), so the response returns quickly; the comment at `posts.ts:1570-1575` documents why.

### 2. List posts → `GET /v1/posts` (`routes/posts.ts:557`)

- **Query 1**: page of posts, `WHERE organization_id = … [AND workspace scope] [AND status/from/to/account subquery] ORDER BY coalesce(published_at, created_at) DESC LIMIT limit+1` (`posts.ts:632-649`). Cursor predicate is `coalesce(published_at, created_at) < cursor` (`posts.ts:592-595`). **No expression index exists for the coalesce ordering** — only `posts_org_created_idx (organization_id, created_at)` and `posts_org_published_idx (organization_id, published_at)` (`packages/db/src/schema.ts:424-428`), so Postgres must scan all of the org's matching rows and top-N sort on every page.
- **Default (lean) response**: **Query 2** — `SELECT post_id, platform FROM post_targets WHERE post_id IN (page ids)` (`posts.ts:836-845`). No N+1. Then per-post `presignMediaUrls` only when `include=media` (parallel `Promise.all`, KV get per media item, `posts.ts:854-881`).
- **`include=targets`**: **Query 2'** — full targets JOIN social_accounts in one `inArray` query (`posts.ts:658-680`). **Query 3'** — `externalPosts` media lookup for published platform post IDs (only when `include=media`, `posts.ts:708-722`). Still no per-post N+1.
- **`include_external=true`**: +1 query over `external_posts` JOIN `social_accounts` (`posts.ts:963-988`), merged in memory by `mergeByPublishedAt` (`posts.ts:1009`).

**Total DB queries: 2 (lean) / 3–4 (targets+media+external).** The list endpoint is well batched; its costs are the un-indexed coalesce sort and the KV fan-out for presigned media (one KV get per unique media key, up to `limit × media-per-post`).

### 3. Scheduling → cron `processScheduledPosts` (`services/scheduler.ts:15`, every minute)

1. Query due posts: `status='scheduled' AND scheduled_at <= now() AND (thread_group_id IS NULL OR thread_position = 0) LIMIT 50` (`scheduler.ts:18-35`) — uses `posts_status_scheduled_idx`.
2. Batch-fetch targets for all due posts (1 query, `scheduler.ts:41-44`); usage units grouped per org → `incrementUsage` per org (KV get + KV put each, `scheduler.ts:62-67`).
3. **One `PUBLISH_QUEUE.send()` per post** (up to 50 individual sends in `Promise.allSettled`, `scheduler.ts:70-89`) — thread roots send `publish_thread`, standalone posts send `publish` with `usage_tracked:true`. `sendBatch` is not used.
4. One `notifyRealtime` DO fetch per org (`scheduler.ts:93-103`).

### 4. Queue consume → `consumePublishQueue` (`queues/publish.ts:21`)

`wrangler.jsonc` consumer: `max_batch_size: 10, max_retries: 3` for `relayapi-publish`. Messages are processed with `mapConcurrently(…, PUBLISH_CONCURRENCY=5)` (`publish.ts:25`).

**Per `publish` message** (`handlePostPublish`, `publish.ts:116`):
1. `incrementUsage` (KV get + put) when `usage_tracked` is false (`publish.ts:122-124`).
2. `publishPostById(env, post_id, org_id)` (`services/publisher-runner.ts:318`):
   - `createDb` (new postgres client #1 for this message).
   - Q1: `SELECT * FROM posts WHERE id … LIMIT 1` (`publisher-runner.ts:325-329`).
   - Q2: atomic claim `UPDATE posts SET status='publishing' WHERE id AND status=<prev> RETURNING` (`publisher-runner.ts:337-340`) — dedupes at-least-once delivery.
   - Q3: `SELECT * FROM post_targets WHERE post_id` (`publisher-runner.ts:345-348`).
   - Q4: `SELECT id, username FROM social_accounts WHERE id IN (…)` (`publisher-runner.ts:360-368`).
   - → `publishToTargets` (`publisher-runner.ts:56`):
     - `createDb` **again** (client #2, `publisher-runner.ts:65`).
     - `resolveMediaUrls` → `presignRelayMediaUrls` (KV get per unique media key; AWS SigV4 sign + fire-and-forget KV put on miss, `lib/r2-presign.ts:47-106`).
     - Q5: `SELECT * FROM social_accounts WHERE id IN (…)` (`publisher-runner.ts:74-77`) — **re-fetches the same accounts Q4 just fetched** (full rows this time).
     - Per account: `refreshTokenIfNeeded` (`services/token-refresh.ts:191`) — AES-GCM decrypt always; if token expires within 5 min: KV lock get/put, external token endpoint fetch, DB update, KV delete.
     - All `publisher.publish()` calls execute **in parallel** via `Promise.allSettled` (`publisher-runner.ts:210`). On `TOKEN_EXPIRED`, one inline refresh + retry (`publisher-runner.ts:170-197`).
     - Q6..n: one `UPDATE post_targets` per account, **batched** with `Promise.all` (`publisher-runner.ts:223-241, 269`).
     - Qn+1: `UPDATE posts SET status=<final>, published_at …` (`publisher-runner.ts:279-286`).
     - **`await dispatchWebhookEvent(…)`** (`publisher-runner.ts:296-300`; impl `services/webhook-delivery.ts:132`): Qn+2 `SELECT * FROM webhook_endpoints WHERE org AND enabled` runs on **every** publish even when the org has no webhooks; each matching endpoint then does KV get (raw secret), HMAC-SHA256 sign, SSRF DNS check, POST with 5s timeout × up to 3 attempts with 1s/4s sleeps (`webhook-delivery.ts:84-109`), then `createDb` (client #3) + `INSERT webhook_logs` (`webhook-delivery.ts:113-123`). Worst case ≈ 20s serialized into the consumer per slow endpoint.
     - **`await notifyRealtime(…)`** — Durable Object fetch, serialized after webhooks (`publisher-runner.ts:303`).
     - `updateStreak(…)` — fire-and-forget (floating promise) with 2–3 more DB queries (`publisher-runner.ts:307-310`, `services/streak.ts:31`).
   - If `post.createdBy`: `sendNotification` fire-and-forget (`publisher-runner.ts:417-444`).
3. `scheduleFirstMetricsRefresh` → `SYNC_QUEUE.send` with 900s delay (`publish.ts:128`, `services/analytics-refresh.ts:466-480`).
4. `message.ack()`; on error `message.retry({delaySeconds: 2**attempts})`, drop after 5 attempts (`publish.ts:133-143`).

**Per `publish_thread` / `publish_thread_item` message** (`handleThreadPublish`, `publish.ts:50`) → `publishThreadPosition` (`services/thread-publisher.ts:64`):
1. Q1: all thread posts for the group (`thread-publisher.ts:73-91`); Q2: all targets via `inArray` (`thread-publisher.ts:97-106`); Q3: all accounts via `inArray` (`thread-publisher.ts:122-134`).
2. For positions > 0: **one extra query per previous-position target** to fetch its `platformPostId` (`thread-publisher.ts:172-176`) — N+1; the column could have been selected in Q2.
3. For each post at the current position: `UPDATE posts SET status='publishing'` (`thread-publisher.ts:191-194`), then **for each target sequentially**: decrypt tokens, `publisher.publish()` (external), then `UPDATE post_targets` (`thread-publisher.ts:200-301`) — publishes and DB updates are fully serialized per account, no token refresh (uses `maybeDecrypt` directly).
4. `UPDATE posts SET status=<final>` per post (`thread-publisher.ts:312-319`); on thread completion `dispatchWebhookEvent("thread.published")` (void, `thread-publisher.ts:338-349`).
5. Next position with delay re-enqueued via `PUBLISH_QUEUE.send({delaySeconds})` (`publish.ts:78-97`).

### 5. Platform publish (`src/publishers/*`)

`getPublisher(platform)` is a static Map lookup (`publishers/index.ts:49`). Notable per-platform behavior on the consumer:

- **Media buffering into memory**: twitter (`twitter.ts:130`), bluesky (`bluesky.ts:182,268`), facebook video (`facebook.ts:228,283`), linkedin (`linkedin.ts:42`), mastodon (`mastodon.ts:45`), pinterest (`pinterest.ts:189`), reddit (`reddit.ts:97`), snapchat (`snapchat.ts:142`), youtube (`youtube.ts:42`), discord (`discord.ts:89`) — each downloads the media from the presigned R2 URL via `arrayBuffer()`/`blob()` and re-uploads to the platform.
- **Long polling loops**: instagram container status — escalating 2s/5s/10s/30s/60s waits up to 10 attempts (~4.8 min max) (`instagram.ts:106-139`); threads (`threads.ts:132`), tiktok (`tiktok.ts:54`), linkedin (`linkedin.ts:241`), pinterest 15s waits (`pinterest.ts:218`), bluesky video 5s (`bluesky.ts:335`), youtube backoff (`youtube.ts:167`), twitter media processing (`twitter.ts:283`). These hold a consumer concurrency slot (1 of 5) for the duration.

### 6. Status updates + webhooks

- Target-level statuses written in `publishToTargets` (batched) and `publishThreadPosition` (per-target).
- Post-level final status (`published`/`failed`/`partial`) written once per publish (`publisher-runner.ts:279-286`).
- Webhook events: `post.scheduled` (createPost, waitUntil), `post.published|failed|partial` (publishToTargets, awaited), `thread.published`, `post.recycled`, `auto_post.created`, `cross_post_action.executed|failed`.
- Realtime dashboard events via `notifyRealtime` → `RealtimeDO` fetch (`lib/notify-post-update.ts:36-52`).

### 7. Synchronous publish paths (no queue) — anomaly

Three request handlers call `publishToTargets` **inline** and block the HTTP response on platform publishing and webhook delivery:

- `POST /v1/posts/{id}/retry` (`posts.ts:2104-2112`)
- `POST /v1/posts/bulk` for items with `scheduled_at:"now"` (`posts.ts:2298-2307`), executed **serially per item** inside the row loop
- `POST /v1/posts/bulk-csv` for `now` rows (`posts.ts:3372-3381`), same serial pattern, up to 500 rows

This contradicts the design note at `posts.ts:1570-1575` ("Publishing can take 8-30+ seconds … Blocking the response causes frontend timeouts and duplicate retries") that motivated the queue for single-post creation.

### 8. Side flows (cron, every minute unless noted)

- **Recycling** (`services/recycling-processor.ts:18`): 1 query for due configs (limit 20); per config ~8–10 serialized queries (atomic claim, expiry checks, source post, source targets, insert post, insert targets, 2 config updates) + KV usage + `PUBLISH_QUEUE.send` + DO notify + awaited webhook dispatch.
- **Cross-post actions** (`services/cross-post-processor.ts:22`): 1 query (limit 10); per action: claim update, post lookup, published-target lookup, account lookup, token refresh, platform engagement call, status update, webhook — all serialized.
- **RSS auto-post** (`services/auto-post-processor.ts:230`, every 5 min): per rule (limit 10): external feed fetch + XML parse, accounts query, then per new item (max 5): `INSERT posts`, `INSERT post_targets`, KV usage, `PUBLISH_QUEUE.send`, awaited webhook — serialized.

### 9. Queue schedule routes (`routes/queue.ts`)

Pure KV reads/writes (`queue-schedule:{orgId}`, `queue.ts:31-48`) plus in-memory `Intl.DateTimeFormat` slot math (`queue.ts:55-132`). `GET /v1/queue/find-slot` → `findBestSlots` adds 1–2 DB queries + 1–2 KV gets (see §1.3). No DB on the other queue routes — cheap.

---

## Per-request work

### `GET /v1/posts` (limit 20, lean)
1. Middleware: auth (KV API-key cache, possible DB), per-request `createDb` (Hyperdrive local proxy connect), workspace scope.
2. DB SELECT posts page (un-indexed `coalesce` order — scans+sorts all org posts).
3. DB SELECT post_targets (platforms) for page ids.
4. (include=media) KV GET per unique media key; AWS SigV4 HMAC + fire-and-forget KV PUT per miss.
5. (include=targets) DB SELECT targets⋈accounts; (+media) DB SELECT external_posts media.
6. (include_external) DB SELECT external_posts⋈accounts.
7. JSON serialize.

### `POST /v1/posts` (scheduled, Pro, with signature, no template/idea)
1. Middleware (auth/scope) → shared `db`.
2. DB: accounts (resolveTargets) → signature → shortLinkConfigs — 3 serialized round trips.
3. (mode=auto) KV×2 + DB×1–3 for slot finding.
4. AES-GCM decrypt of short-link API key (+1 external call per shortened URL).
5. Interactive transaction: BEGIN, INSERT posts, [INSERT short_links], UPSERT usage_records, INSERT post_targets, [2 SELECT + INSERT recycling], [SELECT + INSERT cross-post], COMMIT — every statement a serialized Hyperdrive round trip (≈6–10).
6. waitUntil: queue send / webhook dispatch (DB SELECT webhook_endpoints + per-endpoint KV+HMAC+fetch+INSERT), DO notify.
7. KV GET per media key for response presign.

### Publish queue consumer, per `publish` message
1. KV GET+PUT usage (if untracked).
2. DB ×4 (post, claim, targets, accounts-lite) + DB ×1 duplicate full-accounts fetch.
3. KV GET per media key (presign), AWS HMAC on miss.
4. AES-GCM decrypt per account (access + refresh token); possible token-refresh: KV lock ops + external OAuth fetch + DB UPDATE.
5. External `publisher.publish()` per account in parallel (media downloaded into worker memory and re-uploaded for most platforms; polling loops for IG/Threads/TikTok/LinkedIn/Pinterest/YouTube/Twitter video).
6. DB UPDATE per target (parallel batch) + 1 post status UPDATE.
7. DB SELECT webhook_endpoints (always); per endpoint: KV GET secret, AES-GCM decrypt, HMAC sign, DNS SSRF check, external POST ×≤3 with 1s/4s sleeps, DB INSERT webhook_logs (3rd db client).
8. DO fetch (notifyRealtime), awaited.
9. Streak: DB ×2–3 (floating); notification: DB/email (floating).
10. SYNC_QUEUE send (metrics, delayed 900s).

### Cron `processScheduledPosts` (per minute)
DB ×2; KV ×2 per org; queue `send()` × up-to-50 (individual, not batched); DO fetch × org count.

## External calls

- **Platform APIs** (publish/delete/engagement): Twitter/X, Meta Graph (FB/IG/Threads), LinkedIn REST, Bluesky PDS, Mastodon instance, Reddit, Pinterest, TikTok, YouTube/Google, Telegram, Discord, WhatsApp, Snapchat, GMB, SMS (Telnyx), newsletter providers (beehiiv/convertkit/mailchimp/listmonk).
- **R2 presigned GET** URLs handed to platforms; media bytes also fetched **into** the worker for upload-style APIs.
- **OAuth token endpoints** on refresh (`services/token-refresh.ts`).
- **Customer webhook endpoints** (≤3 attempts, 5s timeout each).
- **Short-link providers** (dub/short.io/bitly/built-in) on create.
- **RSS feeds** (auto-post cron).
- **RealtimeDO** (Durable Object) per status change.

## Performance notes

1. **Inline publishing on request paths** — `retry`, `bulk`, `bulk-csv` block the response on platform publishes (minutes for video) + webhook retries, serially per item. The queue exists precisely for this (`posts.ts:1570-1575`).
2. **`GET /v1/posts` ordering** — `coalesce(published_at, created_at)` has no expression index; cursor+order force a scan/sort of all org posts per page.
3. **POST /v1/posts** issues 3–5 serialized pre-transaction queries (accounts, template, idea, signature, short-link config) plus a 6–10 statement interactive transaction — each a Hyperdrive→origin round trip.
4. **Queue consumer per-message overhead**: duplicate accounts fetch, 2–3 `createDb` clients, always-on webhook endpoint SELECT, awaited webhook delivery with backoff sleeps, awaited DO fetch.
5. **Thread publishing** is serial per target with per-target UPDATEs and an N+1 on previous `platformPostId`s; `POST /v1/threads` inserts posts/targets row-by-row (items × accounts sequential INSERTs).
6. **Scheduler** uses 50 individual `queue.send()` calls instead of `sendBatch` (100/batch limit).
7. **Cold start**: `@aws-sdk/client-s3` + `s3-request-presigner` statically imported into the worker entry via `routes/posts.ts` → `lib/r2-presign.ts` (and `routes/media.ts`) — large bundle parsed on every cold start; KV presign cache mitigates runtime HMAC cost but not startup cost.
8. **`incrementUsage`** is a non-atomic KV read-modify-write (2 KV ops per call; racy under concurrency) (`middleware/usage-tracking.ts:15-35`).
9. **`GET /v1/posts/logs`** accepts a `cursor` param and returns `next_cursor`, but never applies the cursor to the query (`posts.ts:1071-1099`) — pagination beyond page 1 returns the same rows (correctness, noted for completeness).
10. **Media buffering**: most publishers `arrayBuffer()` entire files in worker memory before re-upload — large videos approach Workers memory limits and extend consumer occupancy.
