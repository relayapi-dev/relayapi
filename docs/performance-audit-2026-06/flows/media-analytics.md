# Media + Analytics + Short Links Flow

## Overview

This document traces three families of traffic in `apps/api` (Hono on Cloudflare Workers):

1. **Media** — upload (presign vs. proxy-through-worker), listing, confirmation, deletion, and public avatar serving from R2 (`MEDIA_BUCKET`).
2. **Analytics** — DB-backed post analytics (`/v1/analytics/*` over `posts`/`post_targets`/`post_analytics` tables), live platform analytics (`/v1/analytics/channels`, `/v1/analytics/platform/*` calling each platform's native API), background refresh (cron + queue), ad analytics, and the posting streak.
3. **Short links / ref URLs** — the latency-critical public redirect at `GET /r/:code`, the authenticated short-link CRUD/stats API, the built-in KV-backed shortener, third-party providers (dub/short.io/bitly), the click-sync cron, and ref-URL click tracking.

Entry points (mounted in `apps/api/src/app.ts`):

| Path | Auth | File |
|---|---|---|
| `GET /r/:code` | none (public, mounted at app.ts:118 **before** auth) | `src/routes/short-link-redirect.ts` |
| `GET /avatars/:id` | none (public, app.ts:130) | `src/routes/avatars.ts` |
| `/v1/media/*` | API key | `src/routes/media.ts` |
| `/v1/analytics/*` | API key + `proOnlyMiddleware` (app.ts:165) | `src/routes/analytics.ts` |
| `/v1/streak` | API key | `src/routes/streak.ts` |
| `/v1/short-links/*` | API key + `proOnlyMiddleware` (app.ts:169) + `requireAllWorkspaceScopeMiddleware` | `src/routes/short-links.ts` |
| `/v1/ref-urls/*` | API key | `src/routes/ref-urls.ts` |
| `/v1/ads/:id/analytics` | API key + `proOnlyMiddleware` | `src/routes/ads.ts` → `src/services/ad-analytics.ts` |

All `/v1/*` requests first pass the shared middleware chain (app.ts:140-193): `authMiddleware` (SHA-256 hash of bearer key + KV lookup, DB hydrate on miss — `src/middleware/auth.ts:31-80`), `dbContextMiddleware` (one Drizzle instance per request via Hyperdrive, `src/middleware/db-context.ts`), rate limit, read-only/permissions, body cache, workspace validation/scope, feature gates, usage tracking.

---

## Step-by-step trace

### A. Media upload — proxy through worker (`POST /v1/media/upload`)

File: `src/routes/media.ts:288-373`.

1. Read `filename` query param and `Content-Type` header (media.ts:290-292).
2. MIME allowlist check against `ALLOWED_MIME_TYPES` set (media.ts:295).
3. Size guard: rejects `Content-Length > 50MB` (media.ts:303-310).
4. Body selection (media.ts:312-333): if `c.req.raw.body` exists and `Content-Length > 0`, the **raw ReadableStream is passed straight to R2** (no buffering). Otherwise the body is buffered via `c.req.arrayBuffer()` (chunked uploads) and re-checked against 50MB.
5. Filename sanitization (regex chain, media.ts:336) and key construction `${orgId}/${generateId("file_")}/${safeFilename}` (media.ts:337).
6. **R2 PUT** via binding: `c.env.MEDIA_BUCKET.put(storageKey, body, { httpMetadata, customMetadata })` (media.ts:339-342). This blocks for the full upload duration (worker proxies the bytes).
7. **DB INSERT** into `media` (media.ts:348-355); on failure, compensating **R2 DELETE** (media.ts:358).
8. Response: `{ url: "https://media.relayapi.dev/<key>", type, size, filename }` (media.ts:364-372).

### B. Media upload — presigned (`POST /v1/media/presign` → client PUT → `POST /v1/media/confirm`)

Presign (`media.ts:385-443`):
1. MIME allowlist check (media.ts:390).
2. Env check for `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`CF_ACCOUNT_ID` (media.ts:397-403); falls back to a 400 telling the client to use direct upload.
3. `getCachedR2Client(env)` — module-level `Map` cache of the AWS `S3Client` keyed by credentials (`src/lib/r2-presign.ts:25-45`), so the SDK client survives across requests in a warm isolate.
4. `getSignedUrl(s3, PutObjectCommand, { expiresIn: 3600 })` — **pure CPU SigV4 signing, no network** (media.ts:411-419).
5. **DB INSERT** of a `status: "pending"` media row (media.ts:425-433).
6. Response `{ upload_url, url, expires_in }`. The client then PUTs directly to `https://<account>.r2.cloudflarestorage.com/...` — zero worker involvement for the bytes.

Confirm (`media.ts:509-591`):
1. Prefix check `storage_key.startsWith("${orgId}/")` (media.ts:515) — prevents cross-org R2 probing.
2. **R2 HEAD** `MEDIA_BUCKET.head(storage_key)` (media.ts:523).
3. MIME re-verification from R2 metadata; on violation **R2 DELETE** + 400 (media.ts:532-539).
4. Size re-check (50MB) with **R2 DELETE** on violation (media.ts:542-549).
5. **DB UPDATE** `media SET size, status='ready' WHERE storage_key = $1 AND organization_id = $2 AND status='pending' RETURNING *` (media.ts:552-565). ⚠️ There is **no index on `media.storage_key`** (schema only defines `media_org_idx`, `media_workspace_idx` — `packages/db/src/schema.ts:548-549`), so this filters via the org index then scans the org's media rows.
6. `getPresignedViewUrl` — another local SigV4 sign for the response URL (media.ts:574-575).

### C. Media list (`GET /v1/media`)

File: `src/routes/media.ts:228-286`.

1. Destructures **only** `{ limit, workspace_id }` from the validated query (media.ts:230). `FilterParams` extends `PaginationParams` which includes `cursor` (`src/schemas/common.ts:39-65`), but **`cursor` is never read or applied** to the query.
2. **DB SELECT** on `media` filtered by org + `status='ready'` (+ optional workspace OR-null), `ORDER BY created_at DESC LIMIT limit+1` (media.ts:243-258). No `(org, created_at)` composite index exists; sort happens on top of `media_org_idx`.
3. For each of up to 100 rows, `getPresignedViewUrl()` runs `getSignedUrl()` (media.ts:263-266) — parallel `Promise.all`, all CPU. ⚠️ This path does **not** use the KV presign cache that exists in `src/lib/r2-presign.ts:47-71` (`presignWithCache`, 50-min TTL) — that cache is only used by `presignRelayMediaUrls()` (posts-list path).
4. Response includes `next_cursor` computed from the last row id (media.ts:281) — which the handler will then ignore if echoed back, so **pagination never advances past page 1**.

### D. Avatar serving (`GET /avatars/:id`)

File: `src/routes/avatars.ts:9-29`. Public, no auth.

1. **R2 GET** `MEDIA_BUCKET.get("avatars/" + id)` (avatars.ts:13) — happens on *every* request, even when the client sent `If-None-Match`.
2. ETag compared **after** the GET; 304 returned without a body (avatars.ts:16-20).
3. Otherwise streams `object.body` with `Cache-Control: public, max-age=3600` (avatars.ts:22-28). ⚠️ A `Cache-Control` header alone does not populate the Cloudflare edge cache for Worker-generated responses — there is no `caches.default` usage, so every avatar `<img>` load is a full Worker invocation + R2 GET.

Avatar ingestion (`src/services/avatar-store.ts:29-55`, called from external-post-sync `sync.ts:214-231` and connect flows): external CDN fetch with 5s timeout → content-type check → ≤5MB buffer → **R2 PUT** under `avatars/{accountId}`. Background/best-effort only.

### E. DB-backed analytics (`/v1/analytics/...`)

File: `src/routes/analytics.ts`.

**`GET /v1/analytics/`** (analytics.ts:363-422):
1. `Promise.all` of two queries (good parallelism, analytics.ts:371-386):
   - `getOrgPostTargetIds` — `post_targets JOIN posts` filtered by org/date/platform, `ORDER BY posts.published_at DESC LIMIT 1000` (cap 5000) (analytics.ts:213-243). Uses `posts_org_published_idx`.
   - `getOrgAnalyticsOverview` — single raw SQL with `DISTINCT ON (post_target_id) ... ORDER BY post_target_id, collected_at DESC` + count CTE (analytics.ts:270-315). Single round trip, O(1) Worker memory.
2. `getLatestAnalyticsForTargets` — `selectDistinctOn` with `inArray(postAnalytics.postTargetId, targetIds)` (analytics.ts:336-358). Up to **5000 bind parameters** in one statement. Served by `post_analytics_target_collected_idx`.

**`GET /v1/analytics/daily-metrics`** (analytics.ts:424-524): one JOIN over posts+targets bounded by date range (default last 30 days, **no row limit** — caller-supplied ranges are unbounded), then one `DISTINCT ON` batch, then in-memory grouping.

**`GET /v1/analytics/best-time`** (analytics.ts:526-595): ⚠️ JOIN of **all** published posts + targets for the org — *no date filter, no LIMIT* (analytics.ts:531-543) — then `getLatestAnalyticsForTargets` with an `inArray` of **every target id the org has ever published** (analytics.ts:548-549). All rows are aggregated in Worker memory. A KV-cached equivalent exists (`src/services/best-time-cache.ts:27-44`, 6h TTL) **but is only used by `slot-finder.ts:142`** — the public route recomputes from scratch on every call.

**`GET /v1/analytics/posting-frequency`** (analytics.ts:750-869): same unbounded pattern — all published posts+targets (analytics.ts:755-769), full-history `inArray` batch (analytics.ts:776-777), in-memory ISO-week grouping.

**`GET /v1/analytics/content-decay`** (analytics.ts:598-677): 3 sequential queries — post ownership check → first target → **all** snapshots for that target (`select()` all columns, no limit) (analytics.ts:604-644).

**`GET /v1/analytics/post-timeline`** (analytics.ts:679-748): ownership check → targets → all snapshots for all targets (`select()` full rows, unbounded over time; snapshots accrue per refresh tick for 14 days, so bounded in practice to ~dozens/target).

**`GET /v1/analytics/youtube/daily-views`** (analytics.ts:871-929): `getOrgPostTargetIds` (capped 1000) → date-bounded snapshot scan. Bounded.

### F. Live platform analytics (`/v1/analytics/channels`, `/v1/analytics/platform/*`)

**`GET /v1/analytics/channels`** (analytics.ts:1111-1214):
1. **DB SELECT** all `social_accounts` for the org (no limit; orgs typically have ≤ dozens).
2. `mapConcurrently(rawAccounts, 4, ...)` (analytics.ts:1133) — per account:
   - AES-256-GCM decrypt of the access token (`maybeDecrypt`, analytics.ts:1145) — local crypto.
   - `getCachedPlatformOverview` (analytics.ts:979-1009): **KV GET** `analytics:overview:{accountId}:{from}:{to}`; on hit return; on miss → **live platform API call(s)** via `fetcher.getOverview(...)`, then **KV PUT** with `expirationTtl: 300` (5 min) inside `waitUntil`.
3. Totals summed in memory.

Per-platform `getOverview` cost on cache miss (example Instagram, `src/services/platform-analytics/instagram.ts:122-220`): **3 serialized phases** — (a) 2 parallel insights calls (reach + total_value metrics), (b) 1 followers-count call, (c) 2 parallel previous-period insights calls = **5 Graph API requests, ~3 sequential RTTs** per account.

**`GET /v1/analytics/platform/overview`** (analytics.ts:1217-1298): account lookup + decrypt → scope checks → same `getCachedPlatformOverview` (5-min KV cache).

**`GET /v1/analytics/platform/posts`** (analytics.ts:1301-1345): account lookup → `fetcher.getPostMetrics(...)` — **no KV cache**. For Instagram (instagram.ts:225-317): 1 media-list call then a **sequential `for` loop issuing one `/insights` call per post** (instagram.ts:253-258), default limit 20. Facebook (facebook.ts:298-310), Threads (threads.ts:218-222), and Pinterest (pinterest.ts:169-173) have the same sequential per-item fetch loop. Twitter/TikTok/LinkedIn/YouTube use batch/list endpoints (metrics come back in the list response or one stats call).

**`GET /v1/analytics/platform/audience` / `daily`** (analytics.ts:1348-1456): account lookup → 2-3 parallel platform calls — uncached but parallel.

### G. Background analytics refresh

`src/services/analytics-refresh.ts`:
- **Cron** `enqueueAnalyticsRefresh` (analytics-refresh.ts:102-241): two parallel candidate scans (internal posts ≤14d old needing refresh per decaying schedule, LIMIT 200; external posts LIMIT 500) → `SYNC_QUEUE.sendBatch` in chunks of 100.
- **Queue consumer** `refreshInternalPostMetrics` (analytics-refresh.ts:247-391): loads targets+accounts in one JOIN, then **sequentially per target**: token refresh check → ⚠️ `fetcher.getPostMetrics(accessToken, accountId, range, 50)` (analytics-refresh.ts:328-333) — i.e. fetches metrics for up to **50 posts** (for IG/FB/Threads/Pinterest that is 1 list call + up to 50 per-post insight calls) just to `find()` **one** post's metrics (analytics-refresh.ts:336-338) — then a per-target `INSERT INTO post_analytics`, and finally one `UPDATE posts SET metrics_snapshot`.
- `refreshExternalPostMetricsBatch` (analytics-refresh.ts:397-460): 1 account select → token refresh → 1 batched `fetchPostMetrics` per ≤50 posts → parallel per-post UPDATEs (`Promise.allSettled`).
- `scheduleFirstMetricsRefresh` (analytics-refresh.ts:466-480): queue send with 900s delay after publish.

### H. Ad analytics

`src/services/ad-analytics.ts`:
- **`GET /v1/ads/:id/analytics`** (`src/routes/ads.ts:738-770`): stored path first — `getAdAnalytics` is a single indexed select on `ad_metrics` (`ad_metrics_ad_date_idx`), `LIMIT 366` (ad-analytics.ts:124-129) — falls back to **live** `getAdAnalyticsLive` (3-table JOIN, token resolve, 1 platform insights call) when empty or breakdowns are requested.
- **`fetchAndStoreAdMetrics`** (queue + ad-sync, ad-analytics.ts:19-93): 1 JOIN select → token resolve → 1 platform call → ⚠️ **sequential per-day upsert loop** `for (const point of result.daily) { await db.insert(...).onConflictDoUpdate(...) }` (ad-analytics.ts:57-90) — up to 365 serialized DB round trips per ad per sync.

### I. Streak (`GET /v1/streak`)

`src/routes/streak.ts:37-85`: single indexed select on `org_streaks` (unique on `organization_id`, schema.ts:2284). Pure date math after that. Cheap and well-formed. The write path (`src/services/streak.ts:31-111`) runs on publish: 1 select + 1 upsert + fire-and-forget webhooks/realtime. The cron `checkStreaks` uses `org_streaks_last_post_idx`.

### J. Short link redirect — hot path (`GET /r/:code`)

`src/routes/short-link-redirect.ts:15-40`. Public, mounted before all auth middleware; only CORS + security headers run first.

1. **KV GET** `sl:{code}` (short-link-redirect.ts:17) — the *only* blocking I/O. No `cacheTtl` option, so the default 60s edge cache applies; long-tail codes pay a central-store read (~10-50 ms).
2. Protocol-safety check on the stored URL (pure CPU).
3. Click counting deferred via `waitUntil` (short-link-redirect.ts:30-37): ⚠️ **KV read-modify-write** — `KV.get("sl:{code}:clicks")` → `parseInt` → `KV.put(count+1)`. Not atomic (concurrent clicks lose counts) and bounded by KV's ~1 write/sec/key limit; a viral link drops most clicks and burns a KV read+write per hit.
4. `302` redirect returned immediately.

### K. Short link creation / stats / sync

- Built-in provider `shorten()` (`src/services/short-link-providers/relayapi.ts:35-58`): up to 5 **KV GET** collision probes + **2 sequential KV PUTs** (`sl:{code}` and `sl:{code}:clicks = "0"`). Runs on the publish path when auto-shortening is enabled (`src/services/short-link-service.ts:38-43` does parallel `Promise.allSettled` across URLs — good).
- `POST /v1/short-links/shorten` (short-links.ts:474-530): config select → decrypt key (third-party) → provider HTTP call (or KV ops) → 1 INSERT.
- `GET /v1/short-links/:id/stats` (short-links.ts:532-590): link select → config select → provider live click-count fetch (1 KV GET for built-in; 1 HTTP call for dub/short.io/bitly) → cached-count UPDATE in `waitUntil`. The two selects and the provider call are serialized.
- Cron `syncShortLinkClicks` (`src/services/short-link-click-sync.ts:17-97`): one JOIN (LIMIT 200, served by `short_links_created_sync_idx`) → per-org provider batch fetch → `mapConcurrently(links, 20, UPDATE)` per-row updates.

### L. Ref URLs (`POST /v1/ref-urls/:id/click`)

`src/routes/ref-urls.ts:353-419`: **5 serialized DB round trips** — ref-url `findFirst` → `UPDATE uses = uses + 1 RETURNING` → (if bound) automation `findFirst` → contact `findFirst` → `emitInternalEvent` (which itself queries entrypoints and writes runs). All single-row indexed lookups, but fully sequential on a request path that fires per end-user click.

---

## Per-request work

### `GET /r/:code` (hot path)
| # | Op | Blocking? |
|---|---|---|
| 1 | KV GET `sl:{code}` | yes (only blocking op) |
| 2 | KV GET `sl:{code}:clicks` | no (waitUntil) |
| 3 | KV PUT `sl:{code}:clicks` | no (waitUntil) |

### `GET /avatars/:id`
| # | Op |
|---|---|
| 1 | R2 GET `avatars/{id}` (even for conditional requests) |
| 2 | Stream body or 304 |

### `GET /v1/media` (after auth: 1 SHA-256 + 1 KV GET, usually no DB)
| # | Op |
|---|---|
| 1 | DB SELECT media (org, status, optional workspace) ORDER BY created_at LIMIT ≤101 |
| 2 | ≤100 × local SigV4 signs (CPU, parallel; no KV presign cache used) |

### `POST /v1/media/upload`
1 R2 PUT (streamed) → 1 DB INSERT (+ compensating R2 DELETE on failure).

### `POST /v1/media/presign` → `POST /v1/media/confirm`
Presign: 1 SigV4 sign (CPU) + 1 DB INSERT. Confirm: 1 R2 HEAD → 1 DB UPDATE by **unindexed `storage_key`** → 1 SigV4 sign (+ up to 1 R2 DELETE on policy violation).

### `GET /v1/analytics/` (DB analytics)
2 parallel DB queries (targets JOIN, DISTINCT-ON aggregate) + 1 batched DISTINCT-ON select with ≤5000 bind params.

### `GET /v1/analytics/best-time` / `posting-frequency`
1 **unbounded** posts×targets JOIN (full org history) + 1 DISTINCT-ON select over **all** target ids + full in-memory aggregation. No KV cache despite `best-time-cache.ts` existing.

### `GET /v1/analytics/channels`
1 DB SELECT accounts → per account (concurrency 4): 1 KV GET; on miss 2-5 platform HTTP calls (≤3 serialized RTTs) + 1 KV PUT (waitUntil).

### `GET /v1/analytics/platform/posts` (Instagram/Facebook/Threads/Pinterest)
1 DB SELECT account + 1 AES decrypt → 1 list HTTP call → **N sequential** per-post insights HTTP calls (N = limit, default 20-25). No caching.

### `POST /v1/ref-urls/:id/click`
5 serialized DB round trips (lookup, increment, automation lookup, contact lookup, event emit).

---

## External calls

| Caller | Destination | When |
|---|---|---|
| `platform-analytics/*.ts` | graph.facebook.com / graph.instagram.com / graph.threads.net / api.x.com / api.linkedin.com / youtube + yt-analytics googleapis / api.pinterest.com / open.tiktokapis.com / mybusiness googleapis / WhatsApp Graph | Live on `/v1/analytics/channels` (KV-cached 300s), `/v1/analytics/platform/*` (posts/audience/daily uncached), and queue refresh consumers. All via `fetchWithTimeout` (default 10s, `src/lib/fetch-timeout.ts:9`). |
| `ad-platforms/*` via `ad-analytics.ts` | Meta Marketing API etc. | `/v1/ads/:id/analytics` live fallback; ad-sync queue. |
| `short-link-providers/{dub,short-io,bitly}.ts` | api.dub.co / api.short.io / api-ssl.bitly.com | `/v1/short-links/shorten`, `/test`, `/:id/stats`, click-sync cron. |
| `avatar-store.ts` | Arbitrary platform CDN URL (5s timeout, 5MB cap) | Background re-host only. |
| R2 (binding) | MEDIA_BUCKET | upload PUT, confirm HEAD/DELETE, delete DELETE, avatar GET/PUT/DELETE. |
| R2 (S3 API) | `<account>.r2.cloudflarestorage.com` | Never called from the Worker — presigned URLs are signed locally; clients hit R2 directly. |
| KV | API-key cache, `sl:*` redirect + clicks, `analytics:overview:*` (300s), `best-time:*` (6h, slot-finder only), `r2-presign:*` (50min, posts list only) | per request as traced above. |

---

## Performance notes

1. **Hot path `/r/:code` is correctly minimal** (1 blocking KV read), but the click counter is a lossy KV read-modify-write under `waitUntil` — lost counts under concurrency and capped at ~1 write/sec/key. A Durable Object counter or Workers Analytics Engine datapoint would be both correct and cheaper at volume. The lookup KV read could pass `cacheTtl` (links are immutable) to extend edge caching beyond the 60s default.
2. **`/v1/analytics/platform/posts` issues N sequential third-party calls** (IG/FB/Threads/Pinterest) — the single worst request-path serialization found in this flow: 20 posts × ~200-400ms Graph RTT ≈ 4-8s and 21 subrequests, with zero caching.
3. **`/v1/analytics/best-time` and `/v1/analytics/posting-frequency` are unbounded** — full org history into Worker memory on every call; the 6h KV cache built for this exact computation (`best-time-cache.ts`) is bypassed by the route.
4. **Media list pagination is broken** (cursor accepted but ignored) and presigns up to 100 URLs per call without the existing KV presign cache.
5. **`media.storage_key` has no index** though `confirm` updates by it.
6. **Avatar serving does an R2 GET per request with no edge cache** (`Cache-Control` alone does not populate the Workers cache).
7. **Background paths waste platform quota**: `refreshInternalPostMetrics` fetches up to 50 posts' metrics to extract one; ad metric upserts run one DB round trip per day-row.
8. The 300s TTL on `analytics:overview:*` keeps `/channels` warm for dashboards refreshed more often than every 5 minutes, but a cold dashboard with many accounts pays ceil(N/4) × ~3 serialized platform RTTs.
