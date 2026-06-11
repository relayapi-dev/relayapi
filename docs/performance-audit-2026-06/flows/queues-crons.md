# Background Processing: Queues, Crons, and Durable Objects

## Overview

All background work in `apps/api` flows through three Cloudflare Workers entry points exported from `apps/api/src/index.ts`:

- `queue(batch, env)` → `handleQueueBatch` (`apps/api/src/queues/index.ts:12`) — dispatches 9 queue consumers by `batch.queue` name.
- `scheduled(event, env, ctx)` → `handleScheduled` (`apps/api/src/scheduled/index.ts:24`) — dispatches cron work by `event.cron`.
- `RealtimeDO` (`apps/api/src/durable-objects/post-updates.ts`) — one WebSocket-hibernation DO per organization for dashboard realtime events; receives internal `POST /notify` calls from crons/consumers via `notifyRealtime` (`apps/api/src/lib/notify-post-update.ts:36-52`).

Cron triggers (`apps/api/wrangler.jsonc:59-68`): `*/1 * * * *`, `*/5 * * * *`, `*/30 * * * *`, `0 0 1 * *`, `0 9 * * *`, `0 9 * * 1`.

Queues (`apps/api/wrangler.jsonc:87-179`):

| Queue | batch | retries | concurrency | DLQ |
|---|---|---|---|---|
| relayapi-publish | 10 | 3 | (default) | — |
| relayapi-media-cleanup | 10 | 3 | (default) | — |
| relayapi-email | 1 (timeout 1s) | 5 | 1 | relayapi-email-dlq |
| relayapi-refresh | 10 | 3 | 5 | — |
| relayapi-inbox | 10 | 5 | 5 | — |
| relayapi-tools | 5 | 3 | 3 | — |
| relayapi-ads | 5 | 3 | 3 | — |
| relayapi-sync | 5 | 3 | 5 | — |
| relayapi-automation | 10 | 3 | 5 | relayapi-automation-dlq (deprecated consumer, acks everything) |

**Critical structural fact**: the "every minute" block in `handleScheduled` (`scheduled/index.ts:30-36`) is **not guarded by `event.cron`**. Cloudflare fires one `scheduled` event *per matching cron expression*, so:

- minutes divisible by 5 → **2 concurrent events** (`*/1`, `*/5`) each run all 7 every-minute tasks;
- minutes 0/30 → **3 concurrent events**;
- daily 09:00 → **4 concurrent events**; Monday 09:00 → **5**; 1st-of-month 00:00 → **4**.

Every concurrent event re-runs `processScheduledPosts`, `processRecyclingPosts`, `processScheduledBroadcasts`, `processScheduledWhatsAppBroadcasts`, `processCrossPostActions`, `processAutomationSchedule`, `processAutomationInputTimeouts` — duplicating DB scans, KV usage increments, queue sends, and opening duplicate-publish race windows (see Performance notes).

---

## Step-by-step trace

### A. Every-minute cron tasks (run on EVERY cron event, `scheduled/index.ts:30-36`)

#### A1. `processScheduledPosts` (`services/scheduler.ts:15-104`)
1. `createDb(env.HYPERDRIVE.connectionString)` — new postgres client (`packages/db/src/client.ts:18-25`, `max: 5`, `prepare: true`).
2. `SELECT id, organization_id, thread_group_id, thread_position FROM posts WHERE status='scheduled' AND scheduled_at <= now() AND (thread_group_id IS NULL OR thread_position=0) ORDER BY scheduled_at LIMIT 50` (`scheduler.ts:18-35`; uses `posts_status_scheduled_idx`, `schema.ts:435`).
3. If due posts: `SELECT id, post_id FROM post_targets WHERE post_id IN (...)` (`scheduler.ts:41-44`).
4. KV `incrementUsage` once per org (`scheduler.ts:63-67`) — **non-atomic read-modify-write**: `KV.get` + `KV.put` per org (`middleware/usage-tracking.ts:24-32`).
5. One `PUBLISH_QUEUE.send` per due post (`scheduler.ts:70-89`) — `publish_thread` for thread roots (no `usage_tracked` flag), `publish` with `usage_tracked: true` for standalone posts.
6. One DO `stub.fetch("http://internal/notify")` per org (`scheduler.ts:94-103`).

**Note**: the cron does NOT claim posts (status stays `scheduled` until the queue consumer claims). Duplicate cron events therefore double-enqueue the same posts and double-increment KV usage.

#### A2. `processRecyclingPosts` (`services/recycling-processor.ts:18-45`)
1. New DB client. `SELECT * FROM post_recycling_configs WHERE enabled AND next_recycle_at <= now() ORDER BY next_recycle_at LIMIT 20` (idx `post_recycling_configs_enabled_next_idx`).
2. **Serial** per config (`for` loop, line 35): atomic claim `UPDATE ... SET next_recycle_at=<future> WHERE id=? AND next_recycle_at=? RETURNING` (line 60-69) — duplicate-safe. Then per config: up to 2 expiry `UPDATE`s, `SELECT posts` (source), `SELECT post_targets`, `INSERT posts RETURNING`, `INSERT post_targets`, KV usage get+put, `PUBLISH_QUEUE.send`, DO notify, `UPDATE config`, optional disable `UPDATE`, then `dispatchWebhookEvent` (awaited — see webhook cost below).

#### A3. `processScheduledBroadcasts` (`services/broadcast-processor.ts:18-206`)
1. New DB client. `SELECT * FROM broadcasts WHERE status='scheduled' AND scheduled_at <= now() ORDER BY scheduled_at LIMIT 5` (idx `broadcasts_status_scheduled_idx`).
2. Up to 5 broadcasts run **in parallel** (`Promise.allSettled`, line 37). Per broadcast (`executeBroadcast`):
   - `SELECT social_accounts` (1 row), `refreshTokenIfNeeded` (may do: KV lock get/put, external token POST 15s timeout, encrypt, `UPDATE social_accounts`, KV delete), `UPDATE broadcasts SET status='sending'`, DO notify.
   - **Recipient loop** (lines 121-190): cursor-paginated `SELECT broadcast_recipients ... LIMIT 50`; 50 parallel external `sendMessage` calls; 50 parallel `UPDATE broadcast_recipients`; then `setTimeout(1000)` between batches. **No per-tick budget — the entire broadcast is sent inside the cron invocation.** A 10,000-recipient broadcast = 200 batches ≈ 200s of sleep + send time + 400+ subrequests.
   - Final `UPDATE broadcasts` + DO notify.

#### A4. `processScheduledWhatsAppBroadcasts` (`services/whatsapp-broadcast-processor.ts:37-251`)
Same shape as A3 but **correctly budgeted**: `MAX_RECIPIENTS_PER_TICK = 200` across all broadcasts, chunks of 25 with 500ms inter-chunk sleeps; in-flight broadcasts resume next tick (`status='sending'` picked up again). Per broadcast: claim `UPDATE`, 1 account `SELECT` + decrypt, chunked sends/updates, 2-3 `count(*)` queries to finalize.

#### A5. `processCrossPostActions` (`services/cross-post-processor.ts:22-174`)
1. New DB client. `SELECT * FROM cross_post_actions WHERE status='pending' AND execute_at <= now() LIMIT 10` (idx `cross_post_actions_status_idx`).
2. **Serial** per action (line 37): atomic claim `UPDATE` (lines 41-46, duplicate-safe), `SELECT posts`, `SELECT post_targets`, `SELECT social_accounts`, `refreshTokenIfNeeded`, **1 external publisher call** (repost/comment/quote), `UPDATE cross_post_actions`, awaited `dispatchWebhookEvent`. Worst case 10 × (external call + webhook retries) fully serialized.

#### A6. `processAutomationSchedule` → `processScheduledJobs` (`services/automations/scheduler.ts:43-120`)
1. New DB client. Stale reclaim: `UPDATE automation_scheduled_jobs SET status='pending' ... WHERE status='processing' AND claimed_at < now()-5min` (lines 52-59).
2. Batch claim with `FOR UPDATE SKIP LOCKED ... LIMIT 50` CTE + `UPDATE ... RETURNING` (lines 63-86; idx `idx_scheduled_jobs_sweep`) — concurrency-safe across duplicate cron events.
3. **Serial** per job (line 91): `dispatchJob` →
   - `resume_run`: `runLoop(db, run_id, env)` (`automations/runner.ts:49`) — loops up to **`MAX_VISITS_PER_LOOP = 200`** node visits (`runner.ts:33`), each visit re-`SELECT`s the run row + pause-check query + node execution (DB writes, possible external message sends).
   - `input_timeout`: 2 `SELECT`s (run, automation) + `UPDATE` + possible `runLoop`.
   - `scheduled_trigger` (`dispatchScheduledTrigger`, lines 283-376): 2 `SELECT`s, idempotent next-run insert (1 `SELECT` + 1 `INSERT`), contact enumeration (1 `SELECT` per filter predicate, **no LIMIT** — full matching contact set), then **serial** `matchAndEnrollOrBinding` per contact (line 343).
   - Final per-job `UPDATE automation_scheduled_jobs SET status='done'|'failed'`.

#### A7. `processAutomationInputTimeouts` (`scheduler.ts:250-255`) — documented no-op, returns 0.

### B. `*/5 * * * *` block (`scheduled/index.ts:57-63`)

#### B1. `enqueueExternalPostSync` (`services/external-post-sync/cron.ts:29-180`)
- `SELECT ... FROM social_account_sync_state WHERE enabled AND next_sync_at <= now() AND (rate_limit_reset_at IS NULL OR <= now()) ORDER BY next_sync_at LIMIT 500` (idx `sync_state_enabled_next_idx`) → `SYNC_QUEUE.sendBatch` in chunks of 100. **`next_sync_at` is NOT bumped at enqueue time** — only the consumer updates it after the sync completes (`sync.ts:192-209`). If the queue backlog exceeds 5 minutes, the same accounts are re-enqueued every tick.
- Metrics scan (lines 93-151): keyset loop over `external_posts` (`publishedAt > now-7d AND (metricsUpdatedAt IS NULL OR < now-6h) AND id > cursor ORDER BY id LIMIT 500`, up to 5 pages / 2500 rows per tick) → grouped per account into `refresh_metrics` messages of ≤50 post IDs → `sendBatch`. Same no-claim-at-enqueue issue (`metricsUpdatedAt` only updated by consumer). Ordering by `id` while filtering on `publishedAt`/`metricsUpdatedAt` means the planner walks the PK and filters — the existing `external_posts_metrics_updated_idx` (single column, `schema.ts:2004`) cannot serve this query shape.

#### B2. `enqueueAnalyticsRefresh` (`services/analytics-refresh.ts:102-241`)
- Internal: `SELECT FROM posts WHERE status='published' AND published_at > now-14d AND EXISTS(post_targets published with platform_post_id) ORDER BY metrics_collected_at LIMIT 200` (lines 120-142; the `ORDER BY metrics_collected_at` has no supporting index → sort over all published-in-14d posts). Filter by decaying schedule in JS, then `SYNC_QUEUE.sendBatch` (`refresh_internal_metrics` messages).
- External: `SELECT FROM external_posts WHERE published_at > now-14d ORDER BY metrics_updated_at LIMIT 500`, group by account, `sendBatch` of `refresh_external_metrics_batch` (≤50 IDs).
- Same enqueue-without-claim duplication risk as B1.

#### B3. `processAutoPostRules` (`services/auto-post-processor.ts:230-420`)
- `SELECT * FROM auto_post_rules WHERE status='active' AND (last_processed_at + interval due) LIMIT 10`.
- **Serial** per rule: SSRF DNS check + **external RSS fetch (10s timeout)** + XML parse (CPU), then per new item (≤5): `INSERT posts RETURNING`, `INSERT post_targets`, KV usage get+put, `PUBLISH_QUEUE.send`, awaited `dispatchWebhookEvent`; final `UPDATE auto_post_rules`. Worst case ≈ 10 × (10s fetch + webhook retries) serialized.

#### B4. `checkStreaks` (`services/streak.ts:117-234`)
- 2 `SELECT`s on `org_streaks` (warning + expiry windows; expiry select has **no LIMIT**, lines 170-178; idx `org_streaks_last_post_idx`).
- Serial per warned/expired streak: org-members `SELECT` + prefs `SELECT`, fire-and-forget `sendNotification` per member (each creates **its own DB client** + 2 `SELECT`s + `INSERT notifications` + optional email render + `EMAIL_QUEUE.send`, `notification-manager.ts:83-160`), `UPDATE org_streaks`, `dispatchWebhookEvent`, DO notify.

#### B5. `syncShortLinkClicks` (`services/short-link-click-sync.ts:17-97`)
- `SELECT short_links JOIN short_link_configs WHERE created_at > now-7d AND (last_click_sync_at IS NULL OR < now-1h) LIMIT 200` (idx `short_links_created_sync_idx`).
- Serial per org: AES decrypt of API key, **1 external provider API call**, then ≤20-concurrent `UPDATE short_links` per link.

### C. `*/30 * * * *`: `syncAllExternalAds` (`services/ad-sync.ts:285-327`)
- Keyset-paged `SELECT id, organization_id FROM ad_accounts WHERE status='active' ... LIMIT 100`.
- Per account: **individual `ADS_QUEUE.send`** in a serial loop (lines 309-320) — N serial queue-send subrequests instead of `sendBatch`.

### D. `0 9 * * *` (daily)
1. **`processDunning`** (`services/dunning.ts:27-168`): `SELECT org_subscriptions WHERE status='past_due' LIMIT 100`; **serial per sub**: invoice `SELECT` (+fallback `SELECT`), dunning-events `SELECT`, owner-email `SELECT` (member⋈user), org-name `SELECT`, then per stage: email enqueue (`EMAIL_QUEUE.send`) + `INSERT dunning_events`; day-14: **Stripe API `subscriptions.cancel`** + email + insert. ≈5 queries + up to 1 external call per sub, serialized.
2. **`enqueueExpiringTokenRefresh`** (`services/token-refresh.ts:28-75`): keyset loop `SELECT id FROM social_accounts WHERE token_expires_at IS NOT NULL AND < now+7d AND platform NOT IN (7 no-expiry platforms) ORDER BY id LIMIT 1000` (**no index on `token_expires_at`** — PK-order scan with filter) → `REFRESH_QUEUE.sendBatch` (100/batch).
3. **`renewYouTubePubSubSubscriptions`** (`services/webhook-subscription.ts:322-349`): `SELECT platform_account_id FROM social_accounts WHERE platform='youtube'` (no limit) → **serial external POST** to `pubsubhubbub.appspot.com` per channel.
4. **`cleanupOldConversations`** (`services/inbox-maintenance.ts:17-39`): single `UPDATE inbox_conversations SET status='archived' WHERE status='open' AND last_message_at < now()-90d RETURNING id` — one statement, but `RETURNING` materializes every archived row just to log a count, and there is no `(status, last_message_at)` index (only `inbox_conv_org_status_idx`).

### E. `0 9 * * 1` (weekly): `processWeeklyDigest` (`services/weekly-digest.ts:21-115`)
- **Full scan** of `notification_preferences` (no WHERE, line 25-30), JS-filter to digest-enabled users.
- Batched well: 1 `member` `SELECT` (inArray), 1 grouped `posts` stats query for all orgs.
- Then **unbounded `Promise.allSettled` fan-out** of `sendNotification` per (user, org) — each opens its own DB client and performs 2 `SELECT`s + `INSERT` + optional email render + `EMAIL_QUEUE.send`. For N users×orgs this is 4-5N subrequests in a single invocation (1000-subrequest cap risk).

### F. `0 0 1 * *` (monthly): `generateInvoices` (`services/invoice-generator.ts:21-155`)
- Double-guarded (cron string + `now.getUTCDate() !== 1`). Paged scans of `organization_subscriptions`; serial per active sub: 1-2 `usage_records` `SELECT`s + optional Stripe `invoiceItems.create`; per inactive sub: `syncOrgKeysToKV` → `SELECT apikey` per org then serial `KV.get` + `KV.put` per key.

### G. Queue consumers

#### G1. `relayapi-publish` (`queues/publish.ts:21-144`)
- `mapConcurrently(batch.messages, 5, ...)` (`lib/concurrency.ts`).
- `publish` message → `handlePostPublish`: KV usage get+put if `usage_tracked` unset → `publishPostById` (`services/publisher-runner.ts:318-445`):
  - `SELECT posts` (1) → **claim** `UPDATE posts SET status='publishing' WHERE id=? AND status=<read status> RETURNING` (lines 336-342). **The claim accepts `publishing` → `publishing`** (line 331 allows both `scheduled` and `publishing`), so a second concurrently-delivered duplicate message can re-claim a post mid-publish; the only other guard is "any target already published → bail" (line 351), which doesn't hold during the in-flight window.
  - `SELECT post_targets`, `SELECT social_accounts` (batched, lines 345-368), → `publishToTargets`: R2 presign for media URLs, 1 batched `SELECT social_accounts`, per-account token decrypt (AES-GCM) + `refreshTokenIfNeeded` + **platform publish API call(s)** (parallel via task list), batched `UPDATE post_targets`, final `UPDATE posts` (metrics snapshot/status), DO notify, fire-and-forget `updateStreak` (1 `SELECT` + 1 upsert + webhooks) and `sendNotification`.
  - On success, fire-and-forget `scheduleFirstMetricsRefresh` → `SYNC_QUEUE.send` delayed 900s (`queues/publish.ts:128-130`).
- `publish_thread`/`publish_thread_item` → dynamic-imported `publishThreadPosition`, then chain: `PUBLISH_QUEUE.send` of next position with `delaySeconds`.
- Retry: `message.retry({ delaySeconds: 2 ** attempts })`, drop after 5 attempts.

#### G2. `relayapi-email` (`queues/email.ts`) — batch 1, concurrency 1; per message one Resend API call (`lib/email-queue/consumer.ts:14-21`). Global email throughput is intentionally serialized (~1 msg/invocation).

#### G3. `relayapi-refresh` (`queues/token-refresh.ts:14-44`) — `mapConcurrently(…, 10, …)`; per message `refreshAccountToken` (`services/token-refresh.ts:80-177`): new DB client, `SELECT social_accounts`, AES decrypt, **external token-refresh POST** (15s timeout), AES encrypt(s), **avatar re-fetch external GET** (10s) + **avatar download + R2 put** (`avatar-store.ts:29-56`) on every refresh, `UPDATE social_accounts`, `INSERT connection_logs` (via `logConnectionEvent`, which opens **another** DB client, `routes/connections.ts:41`). On refresh failure: org-member `SELECT` + N fire-and-forget `sendNotification` (each its own DB client). Note concurrency 10 > the 5-6 simultaneous-socket guidance the codebase itself documents (`queues/publish.ts:7-9`), with each message opening ≥2 postgres clients.

#### G4. `relayapi-inbox` (`queues/inbox.ts`) — one shared DB client per batch (good), **serial** per message → `processInboxEvent` (`services/inbox-event-processor.ts:275+`): per normalized event, `SELECT social_accounts`, conversation upsert, message insert, optional participant-profile **external fetch**, automation matching (`for` loop over waiting runs, line 882), webhook dispatch. Retry with exponential backoff, drop after 5 attempts.

#### G5. `relayapi-tools` (`queues/tools.ts`) — **serial** per message: `callDownloaderService` external call with **60s timeout**, then KV write (`completeToolJob`/`failToolJob`). A batch of 5 slow downloads = up to 5 minutes serialized; users polling job status wait behind earlier jobs in the batch.

#### G6. `relayapi-ads` (`queues/ads.ts`) — **serial** per message. `sync_external` → `syncExternalAds` (`services/ad-sync.ts:43-279`):
  - 1 join `SELECT` (ad account ⋈ social account), token resolve, **1 external platform call** listing all ads.
  - **Per external ad** (serial loop, lines 89-226): campaign `SELECT` + (`INSERT` or `UPDATE ... RETURNING`), ad `SELECT` + (`INSERT` or `UPDATE`) → **3-4 serial DB round trips per ad**.
  - Then `SELECT ads ... LIMIT 200` active ads; per ad `fetchAndStoreAdMetrics` (batches of 5 parallel): each = 1 join `SELECT` + token resolve + **1 external metrics call** + up to ~30 **serial daily upserts** into `ad_metrics` (`ad-analytics.ts:28-79`).
  - Final `INSERT ad_sync_logs`.
  - An account with 200 ads ≈ 600-800 serial DB round trips + 201 external calls + up to 6,000 upserts, every 30 minutes.
- `sync_metrics` → single-ad `fetchAndStoreAdMetrics` over a 30-day range.

#### G7. `relayapi-sync` (`queues/sync.ts`) — **serial** per message:
  - `sync_posts` → `syncExternalPosts` (`external-post-sync/sync.ts:31-264`): account `SELECT`, sync-state `SELECT` (+init insert), token refresh, up to **5 pages** of external `fetchPosts` (25/page); per page: 1 dedup `SELECT post_targets`, ≤10-concurrent upserts into `external_posts`; final sync-state `UPDATE`; one-time avatar re-host (external GET + R2 put + `UPDATE`); self re-enqueue if more pages.
  - `refresh_metrics` / `refresh_external_metrics_batch`: account `SELECT`, token refresh, posts `SELECT` (inArray), **1 batched external `fetchPostMetrics`**, ≤10-concurrent `UPDATE external_posts`.
  - `refresh_internal_metrics` → `refreshInternalPostMetrics` (`analytics-refresh.ts:247-391`): targets⋈accounts `SELECT`; then **serial per target**: token refresh + `fetcher.getPostMetrics(accessToken, accountId, range, 50)` — which (e.g. Instagram, `platform-analytics/instagram.ts:225-255`) fetches **up to 50 media items and then one insights call per item**, only to `.find()` the single matching post (`analytics-refresh.ts:328-341`) — plus 1 `INSERT post_analytics` per matched target; final `UPDATE posts` snapshot. Refreshing one post's metrics can cost ~51 external API calls per target.
  - `RateLimitError` → retry with provider-supplied delay (30-900s); others exponential backoff, drop after 3.

#### G8. `relayapi-media-cleanup` (`queues/media-cleanup.ts`) — R2 event notifications; shared DB client; serial `DELETE FROM media WHERE storage_key=?` per message.

#### G9. `relayapi-automation` (`queues/automation.ts`) — deprecated; acks all messages.

### H. Durable Object: `RealtimeDO` (`durable-objects/post-updates.ts`)
- `/notify`: JSON parse → `getWebSockets()` → `ws.send` per socket. O(connected sockets), no storage, hibernation-friendly. Cost: one DO wake per `notifyRealtime` call; crons call it per-org per-event (e.g. scheduler, broadcasts, streaks).

---

## Per-request work (representative paths, in order)

**One every-minute cron event (idle system, nothing due):**
1. 7 × `createDb` → 7 separate postgres clients (each up to 5 conns) through Hyperdrive in one invocation.
2. 7-8 SELECT/UPDATE statements: due-posts SELECT, recycling SELECT, broadcasts SELECT, WA broadcasts SELECT, cross-post SELECT, automation stale-reclaim UPDATE + claim CTE.
3. At :05/:10/... this doubles (2 events); at :00/:30 triples.

**One scheduled post publishing end-to-end:**
1. Cron: 1 posts SELECT + 1 targets SELECT + KV get/put (usage) + 1 queue send + 1 DO fetch.
2. Consumer: 1 posts SELECT, 1 claim UPDATE, 1 targets SELECT, 1 accounts SELECT, R2 presign (crypto), per-account AES-GCM decrypt + optional token refresh (KV get/put/delete + external POST + AES encrypt + UPDATE), N parallel platform publish calls, batched target UPDATEs, 1 posts UPDATE, 1 DO fetch, streak upsert (+2 queries), notification (new DB client + 2 SELECT + INSERT + optional email enqueue), 1 delayed SYNC_QUEUE send.

**One token refresh message:** 1 SELECT, 2-4 AES-GCM ops, 1 external token POST (15s timeout), 1 external avatar GET (10s), 1 avatar download (5s) + 1 R2 put, 1 UPDATE, 1 INSERT (connection log, separate DB client). Failure path adds 1 member SELECT + N×(new DB client + 2 SELECT + 1 INSERT + email enqueue).

**One `sync_external` ads message (200-ad account):** ~1 + 200×(1-2 SELECT + 1 INSERT/UPDATE ×2) + 1 SELECT + 200 external metrics calls + ≤6,000 ad_metrics upserts + 1 INSERT log.

---

## External calls

| Caller | Endpoint(s) | Timeout |
|---|---|---|
| token-refresh | api.x.com, linkedin.com, oauth2.googleapis.com, api.pinterest.com, graph.instagram.com, graph.threads.net, accounts.snapchat.com, reddit.com, open.tiktokapis.com | 15s |
| token-refresh avatars | platform profile/avatar endpoints + CDN download | 10s / 5s |
| publish consumer | all 21 platform publish APIs | per-publisher |
| sync consumer | platform post/metrics list APIs (paged) | per-fetcher |
| analytics internal refresh | platform media+insights APIs (≤51 calls/target) | per-fetcher |
| ads consumer | Meta/TikTok/etc. ads APIs (list + per-ad metrics) | per-adapter |
| auto-post | arbitrary RSS feed URLs (SSRF-guarded) | 10s |
| short links | dub/short.io/bitly click APIs | provider |
| webhooks | customer endpoints, 3 attempts × 5s + 1s/4s backoff (≈max 25s) | 5s |
| dunning/invoices | Stripe API | SDK default |
| YouTube renewal | pubsubhubbub.appspot.com (serial per channel) | none set |
| email consumer | Resend API | SDK default |
| inbox consumer | Graph profile enrichment fetches | none set |

---

## Performance notes

1. **[Critical] Unguarded every-minute block duplicates all per-minute work on overlapping cron fires** (`scheduled/index.ts:30-36`): 2× at every 5th minute, 3× at :00/:30, 4-5× at 09:00. Consequences: duplicated DB scans/KV writes/queue sends every overlap, double KV usage increments per org (`scheduler.ts:63-67` — billing impact), and a real duplicate-publish race because `publishPostById` allows `publishing→publishing` re-claims (`publisher-runner.ts:331-342`) while duplicate messages typically land in the same consumer batch and run concurrently. Fix: wrap lines 30-36 in `if (event.cron === "*/1 * * * *")` and make the `publishing` re-claim staleness-gated.
2. **[High] `refresh_internal_metrics` external-call amplification**: ~51 platform API calls to refresh one post target (`analytics-refresh.ts:328-341` + `platform-analytics/instagram.ts:235-255`). Burns platform rate limits that the sync pipeline also depends on.
3. **[High] Automation cron is serial and unbounded per item**: 50 claimed jobs × up to 200 `runLoop` visits each, all serial (`automations/scheduler.ts:91-117`, `runner.ts:33,58-63`), plus serial per-contact enrollment for scheduled triggers with no contact cap (`scheduler.ts:343-365`). One heavy job starves the tick; stalled jobs wait 5 minutes for stale reclaim.
4. **[High] Legacy broadcast processor sends whole broadcasts inline in the cron** with 1s sleeps per 50 recipients and no budget (`broadcast-processor.ts:121-190`) — large broadcasts risk hitting invocation limits and being stuck `sending`/marked failed; the WhatsApp processor (`whatsapp-broadcast-processor.ts:33-35`) already demonstrates the budgeted-resume fix.
5. **[High] Ads sync N+1**: 3-4 serial DB round trips per external ad + per-ad external metrics call + up to 30 serial upserts per ad (`ad-sync.ts:89-256`, `ad-analytics.ts:57-79`), every 30 minutes per account.
6. **[Medium] Enqueue-without-claim**: sync/analytics crons re-enqueue the same due rows if the consumer backlog exceeds 5 minutes (`external-post-sync/cron.ts:49-86`, `analytics-refresh.ts:113-241`) because `next_sync_at`/`metrics_updated_at` are only advanced by the consumer.
7. **[Medium] Serial queue sends in `syncAllExternalAds`** (`ad-sync.ts:309-320`) — use `sendBatch`.
8. **[Medium] Serial external POSTs in YouTube PubSub renewal** (`webhook-subscription.ts:336-348`).
9. **[Medium] DB-client churn**: every cron task and nested helper (`sendNotification`, `logConnectionEvent`, `deliverWebhook` log insert) opens its own postgres client; one cron event can open 7-15 clients against the documented ~6-socket Worker budget.
10. **[Medium] Awaited webhook delivery inside cron loops** can add up to ~25s per dead endpoint per item (`webhook-delivery.ts:84-109` awaited at `cross-post-processor.ts:142`, `recycling-processor.ts:202`, `auto-post-processor.ts:394`).
11. **[Medium] `*/5` index gaps**: `external_posts` keyset scan ordered by `id` with date predicates lacks a composite index (`cron.ts:115-135`); `posts ORDER BY metrics_collected_at` unindexed (`analytics-refresh.ts:141`); `social_accounts.token_expires_at` unindexed (daily scan, `token-refresh.ts:38-52`); `inbox_conversations (status, last_message_at)` unindexed (daily archive UPDATE).
12. **[Low] `cleanupOldConversations` RETURNING all archived ids** only to count them (`inbox-maintenance.ts:22-34`); `checkStreaks` expiry SELECT has no LIMIT (`streak.ts:170-178`); weekly digest full-scans `notification_preferences` and fan-outs unbounded notification work (`weekly-digest.ts:25-35,83-113`).
13. **[Low] Tools consumer serializes user-visible jobs**: up to 5 × 60s VPS calls per batch (`queues/tools.ts:17-27`); users polling KV job status wait behind earlier messages.
14. **KV usage counter is a non-atomic read-modify-write** (`usage-tracking.ts:24-32`) — concurrent crons/consumers (and the duplicate-cron issue above) can lose or double increments; KV last-write-wins makes the monthly usage figure approximate.
