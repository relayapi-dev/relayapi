# Performance Audit — Full Findings Appendix

Companion to [README.md](./README.md) and [fix-plan.md](./fix-plan.md).
Produced 2026-06-09/10 by a multi-agent audit (11 flow mappers + 7 antipattern
finders), then **fully verified on 2026-06-10** by a second 99-agent pass:
every previously unverified finding was re-checked against the working tree by
an independent adversarial reviewer agent. Final tally:

- **First pass confirmed: 26** (next section) — 3 since fixed, 1 partially
  addressed; see the ✅ markers.
- **Second pass verified: 89** deduplicated findings (78 confirmed, 11
  partial, **0 refuted**) covering all 142 previously unverified rows — the
  rows not re-verified individually were duplicates of first-pass findings or
  already fixed (see "Rows resolved without re-verification").
- **Low-severity notes: 40 verified** (39 confirmed, 1 partial); 9 further
  notes were duplicates of second-pass findings.

Statuses: **confirmed** = accurate in the current tree · **partial** = real
but scope corrected (correction noted inline) · ✅ **FIXED** = resolved by a
fix listed in README §5.

---

## Confirmed findings — first pass (26)

### [CRITICAL] POST /v1/posts/{id}/retry publishes to platforms inline, blocking the HTTP response

- **File:** `apps/api/src/routes/posts.ts`:2104
- **Category:** external-calls  |  **Breaking fix:** yes

The retry endpoint awaits publishToTargets() directly in the request handler, so the response blocks on every platform API call (Instagram/Threads/TikTok poll with escalating sleeps up to ~5 minutes for video), plus the awaited webhook dispatch (up to 3 attempts x 5s timeout with 1s/4s backoff sleeps) and DO notify inside publishToTargets. The codebase itself documents at posts.ts:1570-1575 that inline publishing causes frontend timeouts and duplicate retries, which is why single-post create enqueues to PUBLISH_QUEUE instead — retry never got the same treatment.

**Suggested fix:** Reset failed targets to 'publishing' (already done), then enqueue { type: 'publish', post_id, org_id, usage_tracked: true } to PUBLISH_QUEUE via c.executionCtx.waitUntil and return status 'publishing' immediately, mirroring the createPost 'now' path (posts.ts:1576-1583). publishPostById already filters to actionable targets, so the consumer handles the retry correctly.

---

### [CRITICAL] POST /v1/posts/bulk publishes 'now' items inline and serially, one item at a time

- **File:** `apps/api/src/routes/posts.ts`:2298
- **Category:** external-calls  |  **Breaking fix:** yes

bulkCreatePosts loops over up to 50 items; for each item with scheduled_at='now' it awaits publishToTargets() inside the for-loop before moving to the next item. Each call performs platform publishes (8-30+ seconds each per the project's own comment, minutes for video), DB updates, webhook delivery with retry sleeps, and a DO fetch — all serialized per item in the request. A 10-item 'now' bulk request can easily run for several minutes or hit Worker limits, and each item also issues 2 sequential INSERT round trips (posts at :2251, post_targets at :2284).

**Suggested fix:** Enqueue one PUBLISH_QUEUE message per 'now' item (usage_tracked handling as in createPost) and return per-item status 'publishing' instead of final results; batch the inserts (single multi-row INSERT for all posts, then one for all targets) to cut 2N sequential round trips to 2.

---

### [HIGH] Every mutating request stacks 3 serialized KV reads across three independent middleware

- **File:** `apps/api/src/app.ts`:154
- **Category:** sequential-awaits  |  **Breaking fix:** no

For a POST to a gated prefix like /v1/posts, three middleware each perform their own awaited KV.get strictly in sequence before the handler runs: workspaceValidationMiddleware reads ws-valid:{org}:{ws} (workspace-validation.ts:43-45), workspaceRequiredMiddleware reads org-settings:{org} (feature-gate.ts:41-44), and usageTrackingMiddleware reads usage:{org}:{month} (usage-tracking.ts:246). None of these reads depends on another — they only need orgId and the request body, both available right after auth + bodyCache — yet they execute sequentially because they live in separate middleware. Warm same-colo KV reads are sub-ms, but cold-tier KV reads cost tens of ms each; worst case this is 3 stacked cold reads (plus the auth apikey read = 4 serialized KV reads) before any handler work. Combined with the rate-limiter call, a POST performs 5 serialized external operations before the route handler.

**Suggested fix:** Add a prefetch step right after auth/bodyCache that issues all needed KV gets (ws-valid, org-settings, usage counter) in one Promise.all and stores results on context; have the downstream middleware consume the prefetched values instead of awaiting their own KV.get. Middleware order and route semantics stay identical.

---

### [HIGH] POST /v1/posts/bulk-csv publishes inline per row, up to 500 rows, with 2 sequential INSERTs per row

- **File:** `apps/api/src/routes/posts.ts`:3372
- **Category:** external-calls  |  **Breaking fix:** yes

The CSV bulk endpoint (max 500 rows) runs a serial per-row loop doing INSERT posts (:3315), INSERT post_targets (:3357), and for scheduled_at='now' rows an awaited inline publishToTargets — the same blocking platform-publish pattern as /bulk but at 10x the row cap. A large CSV of immediate posts will exceed any reasonable request duration and risks partial completion with no resume mechanism.

**Suggested fix:** Enqueue 'now' rows to PUBLISH_QUEUE instead of publishing inline, and accumulate validated rows into batched multi-row INSERTs (chunked, e.g. 100 rows per statement) instead of 2 round trips per row.

---

### [HIGH] GET /v1/posts orders and paginates by coalesce(published_at, created_at) with no supporting expression index

- **File:** `apps/api/src/routes/posts.ts`:648
- **Category:** db-index  |  **Breaking fix:** no

The hottest list endpoint sorts by `coalesce(posts.published_at, posts.created_at) DESC` and applies the cursor as `coalesce(...) < cursor` (posts.ts:592-595). The schema only has btree indexes on (organization_id, created_at) and (organization_id, published_at) (packages/db/src/schema.ts:424-428); neither can satisfy ordering or range filtering on the coalesce expression, so Postgres must read all of the org's matching rows and top-N sort on every page, for every dashboard posts-list request. Cost grows linearly with org post count.

**Suggested fix:** Add an expression index: CREATE INDEX posts_org_effective_date_idx ON posts (organization_id, (coalesce(published_at, created_at)) DESC). Drizzle supports sql`` expressions in index definitions, or add it via a custom migration.

---

### [HIGH] POST /v1/posts runs 3-5 independent lookup queries serially before a 6-10 statement interactive transaction

- **File:** `apps/api/src/routes/posts.ts`:1124
- **Category:** sequential-awaits  |  **Breaking fix:** no

Post creation serially awaits: resolveTargets accounts query (:1124), optional template query (:1180), optional idea query (:1219), signature query that runs on every create with content (:1236-1245), and short-link config query for Pro orgs (:1263). The signature and short-link lookups are independent of each other and of target resolution, yet each costs a full Worker->Hyperdrive->origin round trip. The subsequent db.transaction (:1323) then issues BEGIN + up to ~8 statements + COMMIT, each another serialized round trip (recycling validation alone adds 2 SELECTs inside the transaction). On a remote origin DB this stacks easily into 100ms+ on the primary write path.

**Suggested fix:** Run the independent lookups (accounts, template, idea, signature, shortLinkConfigs) in a single Promise.all, or fold them into one round trip (UNION/multiple result sets). Consider caching the org's default signature and short-link config in KV (they change rarely). Move recycling validation queries out of the transaction (they are reads).

---

### [HIGH] POST /v1/threads inserts posts and targets row-by-row: items x accounts sequential INSERT round trips

- **File:** `apps/api/src/routes/threads.ts`:283
- **Category:** n-plus-one  |  **Breaking fix:** no

createThread loops over body.items and awaits one INSERT posts per item, then a nested loop awaits one INSERT post_targets per account per item. A 10-item thread targeting 5 accounts performs 10 + 50 = 60 sequential DB round trips in the request handler, plus buildThreadResponse re-querying everything afterwards. Compare with createPost which bulk-inserts all targets in one statement (posts.ts:1400-1402).

**Suggested fix:** Build all post rows and all target rows in arrays, then issue two multi-row inserts: await db.insert(posts).values(allPostRows) and await db.insert(postTargets).values(allTargetRows). IDs are already generated client-side via generateId, so nothing depends on RETURNING.

---

### [HIGH] Thread publisher: N+1 query for previous platformPostIds and fully serialized per-target publishes/updates

- **File:** `apps/api/src/services/thread-publisher.ts`:172
- **Category:** n-plus-one  |  **Breaking fix:** no

publishThreadPosition already fetches all targets for all thread posts in one query (:97-106) but omits platformPostId, then for positions > 0 issues one SELECT per previous-position target just to read platformPostId (:172-176). It then publishes each target sequentially in a for-loop — each platform API call awaited one after another, each followed by its own UPDATE post_targets round trip (:200-301) — even though cross-account publishing within one thread position has no ordering dependency (reply chains are per-account via previousPlatformPostIds). Multi-account threads multiply wall-clock time linearly.

**Suggested fix:** Add platformPostId to the columns of the existing targets query at :97-106 and drop the per-target lookups. Parallelize the per-account publish loop within a position (Promise.allSettled keyed by socialAccountId, since reply chaining is per account) and batch the post_targets status UPDATEs.

---

### [HIGH] publishToTargets serially awaits webhook delivery (with retry sleeps) and Durable Object notify after publishing

- **File:** `apps/api/src/services/publisher-runner.ts`:296
- **Category:** blocking-non-critical-work  |  **Breaking fix:** no

After the post status update, publishToTargets awaits dispatchWebhookEvent and then notifyRealtime. dispatchWebhookEvent runs a SELECT on webhook_endpoints for every single publish even when the org has zero webhooks (webhook-delivery.ts:140-148), and each delivery does up to 3 attempts with 5s fetch timeouts plus 1s/4s backoff sleeps (webhook-delivery.ts:84-109) and a webhook_logs INSERT using yet another createDb client (webhook-delivery.ts:113). A slow customer endpoint holds the publish-queue consumer slot (PUBLISH_CONCURRENCY=5) for up to ~20 extra seconds per message, and adds the same latency to the request paths that call publishToTargets inline (retry, bulk, bulk-csv).

**Suggested fix:** Cache the org's enabled-webhook list in KV (invalidate on webhook CRUD) to skip the per-publish SELECT, and move delivery off the publish path — either an env.ctx.waitUntil-style detachment in the queue handler or a dedicated webhook-delivery queue. Run notifyRealtime concurrently with webhook dispatch rather than after it.

---

### [HIGH] Every-minute cron block runs on ALL six cron triggers, duplicating work and double-billing usage

> ✅ **FIXED** — README §5.1.1; gated on `event.cron === "*/1 * * * *"`, regression test `scheduled-cron-gating.test.ts`.

- **File:** `apps/api/src/scheduled/index.ts`:30
- **Category:** other  |  **Breaking fix:** no

The seven every-minute tasks (scheduled posts, recycling, broadcasts, WhatsApp broadcasts, cross-posts, automation jobs) are not guarded by `event.cron`. Cloudflare fires one scheduled event per matching cron expression, and wrangler.jsonc declares 6 crons (*/1, */5, */30, monthly, daily 9am, weekly Mon 9am). So at every 5th minute these tasks run 2x concurrently, 3x at :00/:30, and 4-5x at 09:00. Each duplicate run re-scans posts/broadcasts/cross-post tables, re-increments the KV usage counter per org (processScheduledPosts calls incrementUsage before enqueueing, so duplicates double-bill), re-sends duplicate PUBLISH_QUEUE messages for the same posts (the cron never claims posts; status stays 'scheduled' until the consumer claims), and doubles DO notify and Hyperdrive load. Tasks with atomic claims (recycling, cross-post, automation FOR UPDATE SKIP LOCKED) only waste the duplicate scan; processScheduledPosts has no claim and is fully duplicated.

**Suggested fix:** Wrap lines 30-36 in `if (event.cron === "*/1 * * * *") { ... }` so the every-minute tasks run exactly once per minute. No behavior change otherwise: the */1 trigger already fires at every minute the other crons fire.

---

### [HIGH] publishPostById allows publishing->publishing re-claim, so duplicate queue messages can double-publish a post

- **File:** `apps/api/src/services/publisher-runner.ts`:331
- **Category:** other  |  **Breaking fix:** no

The atomic claim accepts both 'scheduled' and 'publishing' as claimable states. When duplicate publish messages exist (guaranteed at 5-minute boundaries by the unguarded cron block, and possible from at-least-once queue delivery), both messages often land in the same consumer batch and run concurrently via mapConcurrently(…, 5). Message B can read status 'publishing' (set by A), succeed at the conditional UPDATE publishing->publishing, and the only remaining guard — 'any target already published' — does not hold while A's external platform calls are still in flight. Result: duplicate posts published to social platforms plus a full duplicate set of platform API calls, token refreshes, and DB writes.

**Suggested fix:** Make the 'publishing' re-claim staleness-gated: only allow re-claiming a 'publishing' post when updatedAt is older than a stuck-threshold (e.g. `and(eq(posts.status, "publishing"), lt(posts.updatedAt, new Date(Date.now() - 10*60_000)))`). Fresh duplicates then no-op while genuinely stuck posts remain retryable.

---

### [HIGH] refresh_internal_metrics fetches metrics for up to 50 posts (plus per-item insights calls) to extract one post's metrics

- **File:** `apps/api/src/services/analytics-refresh.ts`:328
- **Category:** external-calls  |  **Breaking fix:** no

refreshInternalPostMetrics loops serially over a post's targets and, per target, calls fetcher.getPostMetrics(token, accountId, range, 50) and then `.find()`s the single matching platform_post_id. Platform implementations (e.g. Instagram at services/platform-analytics/instagram.ts:235-255) fetch up to 50 media items and then issue one insights API call PER item. Refreshing one post target can therefore cost ~51 external API calls, of which 50 are discarded. This runs every 5 minutes for up to 200 internal posts (decaying schedule), multiplying platform rate-limit consumption that the external-post sync pipeline also depends on, and stretching SYNC queue consumer wall time.

**Suggested fix:** Add a single-post metrics method to the platform fetcher interface (most platforms support GET insights by media/post ID directly — e.g. Instagram /{media-id}/insights) and call it with target.platformPostId. Fall back to the windowed list fetch only for platforms without a per-post endpoint, and cache the windowed result across targets of the same account within one message.

---

### [HIGH] Automation job cron processes up to 50 claimed jobs strictly serially; one heavy run starves the tick

- **File:** `apps/api/src/services/automations/scheduler.ts`:91
- **Category:** sequential-awaits  |  **Breaking fix:** no

processScheduledJobs claims up to 50 jobs (FOR UPDATE SKIP LOCKED) then dispatches them one at a time in a for loop. A resume_run job invokes runLoop which performs up to MAX_VISITS_PER_LOOP=200 node visits, each re-SELECTing the run row plus a pause-check query plus node side effects (DB writes, external message sends). A scheduled_trigger job serially enrolls every matching contact with no cap (line 343: `for (const contactId of candidateIds) await matchAndEnrollOrBinding(...)`). One automation with a large contact filter or long graph can consume the whole 30s CPU / wall budget of the scheduled event, leaving the remaining claimed jobs stuck in 'processing' until the 5-minute stale reclaim, delaying all org automations.

**Suggested fix:** Process claimed jobs with bounded concurrency (e.g. mapConcurrently(claimed, 5, …)), cap per-tick contact enrollment for scheduled_trigger (process N contacts, re-enqueue a continuation job with the cursor), and reduce the claim batch size so a single tick stays well under the CPU limit.

---

### [HIGH] Broadcast processor sends entire broadcasts inline in the cron tick with 1s sleeps and no per-tick budget

- **File:** `apps/api/src/services/broadcast-processor.ts`:121
- **Category:** blocking-non-critical-work  |  **Breaking fix:** no

executeBroadcast loops over all pending recipients in batches of 50, with `setTimeout(1000)` between batches, entirely inside the scheduled event (via ctx.waitUntil). A 10,000-recipient broadcast is 200 batches ≈ 200s of pure sleep plus send time and 400+ subrequests in one cron invocation, risking the Workers invocation limits. If the invocation is terminated mid-broadcast the broadcast is left in status 'sending' forever (the picker only selects status 'scheduled', line 27), silently dropping the remainder. The sibling WhatsApp processor already solved this with MAX_RECIPIENTS_PER_TICK=200 and resumable 'sending' pickup (whatsapp-broadcast-processor.ts:33-55).

**Suggested fix:** Adopt the WhatsApp processor's pattern: add a per-tick recipient budget, include status 'sending' in the due-broadcast picker so interrupted broadcasts resume next minute, and finalize counts from persisted recipient statuses instead of in-memory accumulators.

---

### [HIGH] Ads sync is N+1: 3-4 serial DB round trips per external ad plus per-ad external metrics call and ~30 serial upserts

- **File:** `apps/api/src/services/ad-sync.ts`:89
- **Category:** n-plus-one  |  **Breaking fix:** no

syncExternalAds (ADS queue consumer, fed for every active ad account every 30 minutes) loops serially over every external ad: campaign SELECT + INSERT/UPDATE…RETURNING, then ad SELECT + INSERT/UPDATE. It then loads up to 200 active ads and calls fetchAndStoreAdMetrics per ad (batches of 5), each performing a join SELECT, a token resolve, one external platform metrics call, and up to ~30 serial daily upserts into ad_metrics (ad-analytics.ts:57-79). For a 200-ad account this is roughly 600-800 serial DB round trips, ~201 external API calls, and up to ~6,000 upserts per sync message, every 30 minutes — dominating Hyperdrive and queue-consumer wall time.

**Suggested fix:** Pre-fetch all existing campaigns/ads for the account in 2 bulk SELECTs keyed by platform IDs, then use multi-row INSERT … ON CONFLICT DO UPDATE for campaigns, ads, and ad_metrics daily points (single statement per table). Use the platform's bulk insights endpoint (e.g. Meta account-level insights with breakdown by ad) instead of one metrics call per ad where available.

---

### [MEDIUM] Auth cache-miss hydration runs 2 sequential DB queries plus an awaited KV put

> ✅ **FIXED** — README §5.2.4; single LEFT JOIN + KV write-back via `waitUntil`.

- **File:** `apps/api/src/middleware/auth.ts`:51
- **Category:** sequential-awaits  |  **Breaking fix:** no

On a KV miss for an API key, hydrateApiKey() issues two serialized DB round trips — the apikey lookup, then a dependent organization_subscriptions lookup — followed by an AWAITED KV.put before the request can proceed. The subscription query only needs organizationId and could be folded into the first query with a LEFT JOIN; the KV.put could be deferred via executionCtx.waitUntil (the function currently has no access to executionCtx, only env). With no Smart Placement configured, each DB query is a full edge-to-origin RTT (typically 50-150ms), so the miss path adds roughly 2x DB RTT + a KV write (~100-300ms total). Misses happen per key per colo-cache locality and whenever the 24h TTL lapses or invalidation fires, so this hits first-request latency for every key regularly. The hydration also allocates its own postgres client via getRequestDb(env) at auth.ts:49, separate from the one dbContextMiddleware creates two middleware later, so the miss path pays an extra lazy connection handshake too.

**Suggested fix:** Merge the two selects into a single LEFT JOIN query (apikey LEFT JOIN organization_subscriptions ON organizationId). Pass executionCtx into hydrateApiKey (or return the data and let authMiddleware do c.executionCtx.waitUntil(KV.put(...))) so the cache write-back happens off the response path. Reuse one db instance by moving dbContextMiddleware before authMiddleware or threading the client through.

---

### [MEDIUM] workspaceRequiredMiddleware performs the org-settings KV read before its free short-circuits

- **File:** `apps/api/src/middleware/feature-gate.ts`:41
- **Category:** external-calls  |  **Breaking fix:** no

On every POST to 8 route prefixes (/v1/posts, /v1/webhooks, /v1/broadcasts, /v1/custom-fields, /v1/ads, /v1/auto-post-rules, /v1/content-templates, /v1/threads), the middleware awaits KV.get(`org-settings:{orgId}`) FIRST, then checks whether the request already includes workspace_id in the query string or parsed body. A request that carries workspace_id passes unconditionally (lines 52-54 and 58-60 return next() regardless of the setting), so for those requests — and for the common case of orgs with no settings record at all, where the read is a guaranteed negative lookup — the KV round trip is pure waste on the hot create path.

**Suggested fix:** Reorder the checks: first test url.searchParams.has("workspace_id") and parsedBody.workspace_id (in-memory, free) and return next() if present; only fall through to the KV read when the request lacks a workspace_id AND the key has all-workspace scope. This removes the KV read from the common path with zero behavior change.

---

### [MEDIUM] Every API request (including GETs) writes a row to api_request_logs with no retention job

- **File:** `apps/api/src/middleware/usage-tracking.ts`:213
- **Category:** blocking-non-critical-work  |  **Breaking fix:** no

usageTrackingMiddleware defers a per-request INSERT into api_request_logs via waitUntil for GET/HEAD (usage-tracking.ts:213-224) and for all mutating requests (lines 338-356, alongside a usage_records upsert). It is latency-neutral (waitUntil) but means one origin-DB write per API call: at scale the log inserts become the dominant DB write load, each consuming a Hyperdrive pooled connection, and every invocation stays alive past the response to finish the write. The bigserial-keyed api_request_logs table (packages/db/src/schema.ts:679-701) has no cleanup: nothing in src/scheduled/index.ts or any queue consumer deletes from it, so it grows unboundedly, degrading its own indexes and backup/vacuum cost over time.

**Suggested fix:** Batch request logs instead of one INSERT per request — e.g. ship log entries to a Queue (or aggregate in a Durable Object) and flush in batches from the consumer; alternatively sample GET logging. Add a scheduled retention job (e.g. DELETE WHERE created_at < now() - interval '90 days' in monthly cron) to bound table growth.

---

### [MEDIUM] Monolithic worker bundle: 46 routers + all queue consumers + cron + DO loaded on every cold start

> ◐ **Partially addressed** — minify + dynamic imports cut the bundle 43 % (README §5.3); splitting consumers/crons into a second worker remains open (§6.9 / fix-plan P5).

- **File:** `apps/api/src/app.ts`:21
- **Category:** cold-start  |  **Breaking fix:** yes

app.ts statically imports ~46 route modules (app.ts:21-77), and index.ts additionally bundles every queue consumer (9 queues), the cron scheduler (6 cron schedules incl. one every minute), and the RealtimeDO into one worker. The API source is ~86k LOC, and @hono/zod-openapi builds Zod schemas + OpenAPI route definitions at module scope for every endpoint (e.g. routes/posts.ts alone defines 15+ createRoute() objects at import time). Every cold start — HTTP, queue batch, or cron tick — pays parse + module-init for the entire codebase before the first request can be served, inflating P99 latency for requests that land on fresh isolates.

**Suggested fix:** Measure init cost first (wrangler tail / startup CPU in dashboard). If material: split queue/cron consumers into a separate worker (same codebase, second wrangler config with its own entry) so HTTP isolates only carry route code, and/or defer heavy module-scope work (OpenAPI doc registry is only needed for /openapi.json).

---

### [MEDIUM] No Smart Placement: every DB query in handlers is a full edge-to-origin round trip

> ✅ **FIXED** — README §5.3.11; `"placement": {"mode": "smart"}` enabled. Re-measure once Cloudflare has observed traffic.

- **File:** `apps/api/wrangler.jsonc`:1
- **Category:** external-calls  |  **Breaking fix:** no

wrangler.jsonc contains no placement configuration (grep for "placement" returns nothing), so the worker executes in the ingress colo while the Postgres origin sits in one region behind Hyperdrive. Hyperdrive pools connections and caches prepared statements (client.ts sets prepare: true, fetch_types: false), but every uncached query still crosses edge-to-origin. The middleware chain is clean on the warm path (zero DB queries), but route handlers issue multiple sequential queries — e.g. listPosts runs the base page query then a dependent targets query then media presigning (routes/posts.ts:632-680) — multiplying the RTT for users far from the DB region. The auth cache-miss path (2 sequential queries) doubles it again.

**Suggested fix:** Evaluate enabling "placement": { "mode": "smart" } in wrangler.jsonc so multi-query request handlers run near the DB (Smart Placement specifically targets workers that make multiple round trips to one origin). Verify with real traffic that the added user-to-worker hop is outweighed by collapsed DB RTTs; Hyperdrive query caching remains complementary.

---

### [MEDIUM] Queue consumer fetches the same social accounts twice and opens 2-3 DB clients per message

- **File:** `apps/api/src/services/publisher-runner.ts`:74
- **Category:** sequential-awaits  |  **Breaking fix:** no

publishPostById selects {id, username} for all target accounts (publisher-runner.ts:359-368), then calls publishToTargets which immediately re-selects the full rows for the exact same account IDs (:74-77) on a freshly created second postgres client (:65). deliverWebhook later creates a third client for the log insert. Each publish message therefore pays one redundant DB round trip plus extra Hyperdrive connection setups.

**Suggested fix:** Have publishPostById fetch the full account rows once and pass them into publishToTargets (optional prefetchedAccounts param, like resolveTargets already supports), and thread a single Database instance through publishToTargets/dispatchWebhookEvent instead of calling createDb in each layer.

---

### [MEDIUM] @aws-sdk/client-s3 + s3-request-presigner statically imported into the worker entry (cold-start weight)

- **File:** `apps/api/src/lib/r2-presign.ts`:1
- **Category:** cold-start  |  **Breaking fix:** no

lib/r2-presign.ts statically imports the AWS SDK v3 S3 client and presigner; it is reached from routes/posts.ts (and routes/media.ts, services/publisher-runner.ts) which app.ts imports statically, so the full AWS SDK is bundled and parsed on every cold start of the entire API worker. The SDK is only used to compute SigV4 presigned GET/PUT URLs, which is a few hundred lines with aws4fetch or hand-rolled WebCrypto HMAC. This inflates bundle size and worker startup time for every route, not just media-bearing ones.

**Suggested fix:** Replace the AWS SDK with aws4fetch (tiny, Workers-native) or a minimal SigV4 query-presign implementation using crypto.subtle; alternatively switch GET presigns to R2 binding-served URLs. At minimum, keep the existing KV cache and verify bundle delta with `wrangler deploy --dry-run --outdir`.

---

### [MEDIUM] Publishers buffer entire media files into worker memory before re-upload

- **File:** `apps/api/src/publishers/twitter.ts`:130
- **Category:** other  |  **Breaking fix:** no

Most upload-style publishers download media from the presigned R2 URL with arrayBuffer()/blob() and hold the full payload in memory: twitter.ts:130, bluesky.ts:182/268, facebook.ts:228/283, linkedin.ts:42, mastodon.ts:45, pinterest.ts:189, reddit.ts:97, snapchat.ts:142, youtube.ts:42, discord.ts:89. Large videos (50-500MB) approach the Workers 128MB memory ceiling, extend per-message wall time on the publish consumer (which is capped at 5 concurrent publishes), and double bandwidth (R2 -> worker -> platform). Platforms that accept a URL (Instagram, Threads, TikTok pull-mode, Facebook file_url) already avoid this.

**Suggested fix:** Where the platform API supports it, stream the response body directly into the upload request (fetch body: mediaRes.body with chunked/resumable upload endpoints, e.g. YouTube resumable, Twitter chunked media upload already chunks but from an in-memory buffer) instead of materializing arrayBuffer(); otherwise enforce size limits per platform before download.

---

### [MEDIUM] Sync/analytics crons enqueue due rows without claiming them, re-enqueueing the same work when the backlog exceeds 5 minutes

- **File:** `apps/api/src/services/external-post-sync/cron.ts`:49
- **Category:** external-calls  |  **Breaking fix:** no

enqueueDueAccounts selects up to 500 sync-state rows where next_sync_at <= now and enqueues them, but next_sync_at is only advanced by the consumer after the sync completes (sync.ts:192-209). With SYNC queue throughput of 5 concurrent invocations × serial batches of 5, a multi-second per-account sync means a 500-account backlog takes longer than the 5-minute cron period, so the next tick re-selects and re-enqueues the same accounts — multiplying external platform API calls and queue depth. The same pattern exists in enqueueMetricsRefresh (metrics_updated_at only set by the consumer) and enqueueAnalyticsRefresh (analytics-refresh.ts:113-241, metrics_collected_at only set by the consumer).

**Suggested fix:** Claim at enqueue time: in the same statement (UPDATE … SET next_sync_at = now() + interval 'X' WHERE … RETURNING), or add an 'enqueued_at' marker checked by the selection predicate, so a row can only be enqueued once per consumer completion.

---

### [MEDIUM] syncAllExternalAds sends queue messages one-by-one instead of sendBatch

- **File:** `apps/api/src/services/ad-sync.ts`:311
- **Category:** sequential-awaits  |  **Breaking fix:** no

The 30-minute ads cron pages through active ad accounts (100/page) and awaits an individual ADS_QUEUE.send per account in a serial for loop — N serialized queue-send round trips (each a Cloudflare API subrequest) per cron run, where the token-refresh and sync crons in the same codebase already use sendBatch with 100-message chunks.

**Suggested fix:** Build the page's messages and call env.ADS_QUEUE.sendBatch(messages) once per page (CF limit 100 messages per batch, which matches PAGE_SIZE).

---

### [LOW] Scheduler cron enqueues due posts with up to 50 individual queue.send() calls instead of sendBatch

- **File:** `apps/api/src/services/scheduler.ts`:70
- **Category:** external-calls  |  **Breaking fix:** no

processScheduledPosts runs every minute and fires one PUBLISH_QUEUE.send() per due post (limit 50) inside Promise.allSettled. Each send is a separate Queues API subrequest; Cloudflare Queues supports sendBatch with up to 100 messages per call (already used in token-refresh.ts:59). At burst times (popular scheduling slots) this is 50 subrequests where 1 would do, adding latency and subrequest-count pressure to the cron invocation.

**Suggested fix:** Build the message array and call env.PUBLISH_QUEUE.sendBatch(messages.map(body => ({ body }))) in chunks of 100, as enqueueExpiringTokenRefresh already does.

---

## Rows resolved without re-verification

Of the original 142 unverified rows, 53 were not given their own second-pass
reviewer because they were either already fixed or duplicates/overlaps of
another finding. Mapping:

### Already fixed during the audit (8 rows → README §5)

| Original row | Resolution |
|---|---|
| Media list pagination broken (cursor never applied) | ✅ §5.1.2 — keyset pagination + `media-cursor.test.ts` |
| GET /v1/posts/{id}: post select serialized before targets/recycling | ✅ §5.2.5 — single parallel round trip |
| DELETE /v1/posts/{id}: child-table deletes serial | ✅ §5.2.6 — parallel deletes |
| GET /v1/inbox/conversations/{id}: conversation and messages serial | ✅ §5.2.7 — parallel fetch |
| react-email stack (3.05 MB) statically imported on the fetch hot path | ✅ §5.3.9 — dynamic `import()` |
| Stripe SDK (659 KiB) statically imported, evaluated at cold start | ✅ §5.3.10 — dynamic `import()` |
| Worker bundle shipped unminified (7,933 KiB raw) | ✅ §5.3.8 — `"minify": true` (−43 %) |
| API-key KV cache repopulation awaited inside auth middleware on miss | ✅ §5.2.4 — `waitUntil` write-back |

### Duplicates folded into other findings (≈45 rows)

| Original row(s) | Folded into |
|---|---|
| Cron broadcast processor: no per-tick budget / never resumes 'sending' / unbounded while(true) (2 rows) | First-pass [HIGH] `broadcast-processor.ts:121` |
| scheduled_trigger unbounded contact enrollment (2 rows) | First-pass [HIGH] `automations/scheduler.ts:91` |
| Queue consumers serialize on customer webhook endpoints (~20s) | First-pass [HIGH] `publisher-runner.ts:296` |
| Usage tracking writes 1–2 Postgres statements per request / api_request_logs unbounded (2 rows) | First-pass [MEDIUM] `usage-tracking.ts:213` |
| 3–5 serialized KV reads in the middleware stack | First-pass [HIGH] `app.ts:154` |
| Thread creation inserts posts/targets row-by-row | First-pass [HIGH] `threads.ts:283` |
| Bulk post creation sequential insert pairs per item | First-pass [CRITICAL] `posts.ts:2298` |
| CSV import 2+ serialized round trips per row | First-pass [HIGH] `posts.ts:3372` |
| Internal post metrics refresh over-fetches 50 posts per target | First-pass [HIGH] `analytics-refresh.ts:328` |
| Usage counter non-atomic KV read-modify-write (2 rows) | Acknowledged TODO in code; §6 decision (Durable Object counters) + low note below |
| Broadcast send synchronous fan-out (3 rows: critical + 2 high) | Second-pass V6 |
| GET /inbox/comments live Graph fan-out (2 rows) | Second-pass V32 |
| Inbox queue consumer serial batch / webhook-before-notify (3 rows) | Second-pass V34 |
| Automation webhook trigger runs inline (2 rows) | Second-pass V8 |
| best-time unbounded scan / KV cache bypass / floating put (4 rows) | Second-pass V18 |
| analytics channels fan-out, no SWR (2 rows) | Second-pass V20 |
| Meta webhook per-DM dedup chain / redundant per-entry lookup (2 rows) | Second-pass V47 |
| Token refresh 2s lock sleep, inline during unpublish (2 rows) | Second-pass V70 |
| OAuth callback serial enrichment chain — overlaps avatar/webhook/ads/IG rows | Second-pass V1–V5 |
| Low notes: outbound-mid KV writes; per-delivery pg client; delivery KV/DNS serialization; click undercount; token_expires_at index; per-idea UPDATEs; routes-with-inline-external-calls inventory (9 notes) | Second-pass V38, V50, V60, V63, V72; inventory superseded by V55 |

---

## Verified findings — second pass (89: 78 confirmed, 11 partial; 0 refuted)

Every previously unverified finding was re-checked against the current working
tree (including the fixes from README §5) by an independent adversarial
reviewer agent on 2026-06-10. "Partial" = the issue is real but the original
claim over- or under-stated scope; the corrected scope is noted. Severities
below are the **re-graded** ones (filed severity in parentheses when changed).
None of the second-pass findings kept a *critical* grade — the worst inline
work sits on connect/broadcast/ads/automation paths that are per-onboarding or
per-org-action rather than steady-state hot paths.

High: 17 · Medium: 44 · Low: 28

### [HIGH] (filed critical) OAuth browser callback blocks 302 redirect on synchronous customer webhook delivery (up to ~20s with retries)

- **File:** apps/api/src/routes/connect.ts:938; apps/api/src/routes/oauth-callback.ts:78-101; apps/api/src/services/webhook-delivery.ts:84-108
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V1_

The server-side OAuth callback (GET /connect/oauth/callback, apps/api/src/routes/oauth-callback.ts:78) awaits exchangeAndSaveAccount before issuing the 302 redirect at line 101, and for newly connected accounts that helper awaits dispatchWebhookEvent inline (apps/api/src/routes/connect.ts:938). deliverWebhook (apps/api/src/services/webhook-delivery.ts:84-108) makes up to 3 POST attempts to the customer's endpoint with 5s timeouts plus 1s and 4s backoff sleeps, then a webhookLogs DB insert — so a slow or dead endpoint hangs the user's browser mid-OAuth for up to ~20 seconds, and even a healthy endpoint adds an external HTTP round trip, a KV secret read, a DNS SSRF check, and a DB write before redirect. Every other account.connected dispatch in connect.ts (e.g. lines 1078, 1294, 1438) already defers via c.executionCtx.waitUntil; line 938 is the lone synchronous outlier because the shared helper has no access to the execution context. Impact is limited to new-account connects for orgs with an enabled matching webhook endpoint, so high rather than critical.

**Suggested fix:** Add an optional ctx?: ExecutionContext parameter to exchangeAndSaveAccount, pass c.executionCtx from both callers (oauth-callback.ts:78 and connect.ts:2844), and replace the await at connect.ts:938 with ctx?.waitUntil(dispatchWebhookEvent(...).catch(err => console.error(...))) ?? void dispatchWebhookEvent(...).catch(...), matching the waitUntil pattern already used elsewhere in the file. Optionally defer the adjacent logConnectionEvent calls the same way.

---

### [HIGH] (filed critical) OAuth callback awaits N-call ad-account discovery (Meta Marketing API fan-out) before issuing the user-facing 302 redirect

- **File:** apps/api/src/routes/connect.ts:1031-1040; apps/api/src/routes/oauth-callback.ts:78-101; apps/api/src/services/ad-service.ts:287-302; apps/api/src/services/ad-platforms/meta.ts:265-291
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V2_

exchangeAndSaveAccount (apps/api/src/routes/connect.ts:627) awaits discoverAdAccounts at connect.ts:1034 for every ad-capable single-select platform (instagram, twitter, tiktok), and the browser-facing GET /connect/oauth/callback (apps/api/src/routes/oauth-callback.ts:78) only sends its 302 redirect at line 101 after that await resolves. For Meta-mapped accounts, discoverAdAccounts performs one /me/adaccounts call plus, per discovered ad account, up to 10 paginated promote_pages requests and batched IG-resolution calls (meta.ts:265-291), throttled to concurrency 5 (ad-service.ts:287), plus multiple DB round trips — for a user with dozens of ad accounts this blocks the redirect for many seconds at 100ms-10s+ per external call. The result is never used in the response (errors are swallowed as non-critical at connect.ts:1036-1039), and the Facebook secondary-selection handler already defers the identical call via c.executionCtx.waitUntil (connect.ts:2011-2019), confirming inline awaiting is unnecessary. None of the audit fixes in the working tree touch this path; the await is present in the current code.

**Suggested fix:** Add an optional executionCtx?: ExecutionContext parameter to exchangeAndSaveAccount and replace the awaited block at connect.ts:1031-1040 with executionCtx.waitUntil(discoverAdAccounts(env, orgId, account.id).catch(err => console.error(...))), mirroring the existing pattern at connect.ts:2011-2019; pass c.executionCtx from both oauth-callback.ts:78 and the completeOAuth handler at connect.ts:2844. Alternatively, enqueue a new discover_ad_accounts message on the existing ADS_QUEUE (wrangler.jsonc:123) and handle it in consumeAdsQueue for retry semantics.

---

### [HIGH] OAuth callback blocks user-facing redirect on serial avatar re-host, inline webhook delivery, connection log, queue sends, IG subscriptions, sync-state upsert, and ad-account discovery

- **File:** apps/api/src/routes/connect.ts:921-1040 (post-upsert serial chain: 924 rehostAvatar, 938 dispatchWebhookEvent, 944/952 logConnectionEvent, 963 INBOX_QUEUE.send, 982-999 IG webhook subscriptions, 1005-1028 sync-state upsert + SYNC_QUEUE.send, 1034 discoverAdAccounts); apps/api/src/routes/connect.ts:656-711 vs 713-831 (long-lived token exchange serialized before profile fetch); callers: apps/api/src/routes/oauth-callback.ts:78-101, apps/api/src/routes/connect.ts:2844
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V5_

exchangeAndSaveAccount (apps/api/src/routes/connect.ts:627) sequentially awaits, after the account upsert: avatar re-host to R2 plus a follow-up DB update (lines 923-932), inline customer webhook delivery via dispatchWebhookEvent — which itself does a webhook-endpoints DB select and HTTP POSTs to customer endpoints (webhook-delivery.ts:132-165) — a connection-log DB insert (944/952), a YouTube queue send (963), two Instagram Graph subscription calls (982-999), a sync-state DB upsert plus SYNC_QUEUE send (1005-1028), and discoverAdAccounts which performs another DB select, an external ad-platform listAdAccounts call, and DB upserts (ad-service.ts:182+). Both callers block the user-visible response on this chain: the GET server-side callback holds the browser 302 redirect (oauth-callback.ts:78-101) and POST completeOAuth holds the JSON response (connect.ts:2844), adding roughly 4-6 DB round trips (~85-120ms each) plus 3+ external platform/customer HTTP calls (100ms-10s+ each) — typically 1-5s, worst case far more — of deferrable work to the most visible onboarding step. Additionally, the Meta/Threads/Instagram long-lived token exchange (656-711) completes before the profile fetch (713-831) even though the profile fetch works with the still-valid short-lived token, so the two external calls could overlap. The function receives only env (no ExecutionContext), so nothing can be deferred today, unlike the manual-connect routes in the same file that already wrap dispatchWebhookEvent and discoverAdAccounts in c.executionCtx.waitUntil (e.g. connect.ts:1078, 2001-2018).

**Suggested fix:** Add an optional waitUntil?: (p: Promise<unknown>) => void parameter to exchangeAndSaveAccount; both callers pass (p) => c.executionCtx.waitUntil(p). After the account upsert, move the entire side-effect block — avatar re-host + avatarUrl update, dispatchWebhookEvent, logConnectionEvent, YouTube/SYNC queue sends, Instagram webhook subscriptions, sync-state upsert, and discoverAdAccounts — into one deferred async function passed to waitUntil, running the independent pieces with Promise.allSettled (keep the existing try/catch logging). Return the response immediately after the upsert; account.avatar_url falls back to the raw CDN URL on first connect, which is already the documented best-effort behavior when re-host fails. Optionally, kick off the profile fetch with the short-lived token concurrently with the long-lived exchange via Promise.all in the Meta/Threads/Instagram branches (656-711).

---

### [HIGH] (filed critical) POST /v1/broadcasts/{id}/send sends the entire broadcast inline on the request path with unbounded recipient load and per-recipient UPDATEs

- **File:** apps/api/src/routes/broadcasts.ts:765-773 (unbounded SELECT), apps/api/src/routes/broadcasts.ts:779-813 (awaited send fan-out), apps/api/src/routes/broadcasts.ts:797-810 (per-recipient UPDATEs), apps/api/src/routes/broadcasts.ts:841 (response only after completion)
- **Verdict:** partial  |  **Breaking fix:** yes  |  _V6_
- **Scope correction:** Two details are overstated: there are no sleeps on this HTTP path (the 1s inter-batch sleep is only in the cron-only services/broadcast-processor.ts:189), and sends are not sequential — commit 30d5a41 already fans them out at concurrency 5 via mapConcurrently, making per-recipient wall-clock cost roughly 5x lower than a sequential-with-sleeps loop implies. The core issue (unbounded recipient load, entire send awaited before responding, one UPDATE per recipient) is accurate in the current tree.

POST /v1/broadcasts/{id}/send loads every pending recipient with no LIMIT (broadcasts.ts:765-773), then awaits all platform sends inline on the HTTP request via mapConcurrently at concurrency 5 (broadcasts.ts:779-813), issuing one unbatched UPDATE per recipient (~85-120ms DB RTT each, broadcasts.ts:797-810) before responding at line 841. At ~400ms+ per recipient (platform call 100ms-10s plus DB UPDATE) / 5 concurrent, a few hundred recipients exceeds Cloudflare's ~100s proxy timeout, and each platform call is a subrequest, so ~1000 recipients hits the Workers subrequest cap outright. If the request is cut off mid-send, the broadcast is wedged in "sending" forever — the guard at broadcasts.ts:726 rejects re-sending non-draft/scheduled broadcasts — with partial delivery and no recorded counts. An async path already exists: the cron-driven processScheduledBroadcasts (services/broadcast-processor.ts) processes recipients in LIMIT-ed keyset batches with batched DB updates and rate-limit sleeps, but the HTTP route does not use it.

**Suggested fix:** In the send handler, stop processing inline: validate, set status to "sending" (or "scheduled" with scheduledAt = now), and return the broadcast immediately in that state, delegating the fan-out to the existing cron-driven processScheduledBroadcasts batch path (or enqueue the broadcast id to a queue consumer that calls the same processor). Reuses existing batching/keyset/rate-limit code; also clears the wedged-"sending" failure mode since the cron can resume pending recipients.

---

### [HIGH] (filed critical) Automation runLoop issues 5 sequential DB round trips per node visited, re-fetching the graph JSONB every iteration

- **File:** apps/api/src/services/automations/runner.ts:61, apps/api/src/services/automations/runner.ts:76, apps/api/src/services/automations/runner.ts:93, apps/api/src/services/automations/runner.ts:197, apps/api/src/services/automations/runner.ts:320
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V7_

Each iteration of the while loop in runLoop (runner.ts:58-327) sequentially awaits 5 framework queries per graph node: re-fetch of the automation_runs row (line 61), a pause-control lookup (line 76), a re-fetch of the full automations row including the graph JSONB (line 93 — by design, per the comment "Load graph fresh on every iteration"), an automation_step_runs INSERT (line 197), and the optimistic automation_runs UPDATE (line 320), plus whatever the node handler itself queries. At ~85-120ms per Hyperdrive round trip this is ~450-600ms of pure framework overhead per node, ~5-6s for a 10-node path, and up to ~1000 round trips at the 200-visit cap (line 33). This blocks the user-facing POST /v1/automations/{id}/enroll response (routes/automations.ts:961 awaits enrollContact → runLoop), serializes cron-driven resume jobs (scheduler.ts:139 inside a sequential for-loop), and throttles the relayapi-inbox queue consumer (max_concurrency 5, queues/inbox.ts:24), so DM auto-reply throughput degrades directly with graph depth. There is no KV/memory caching, batching, or Promise.all parallelism anywhere in the loop.

**Suggested fix:** Cut per-node round trips from 5 to ~2 without changing run semantics: (1) drop the per-iteration run re-fetch — run identity fields (organizationId, contactId, automationId) are immutable, and updateRunOptimistic already does .returning(); extend it to return the updated row (updatedAt, currentNodeKey, currentPortKey, context) and carry run state locally across iterations, fetching the run only once before the loop; (2) issue the pause check and the automations/graph fetch with Promise.all (both depend only on immutable run fields); (3) issue writeStepRun and the run-state UPDATE with Promise.all (independent tables). Optionally cache the automations row for the duration of a single runLoop invocation if the per-iteration graph-edit pickup semantic can be relaxed, saving one more round trip per node.

---

### [HIGH] (filed critical) Public automation webhook trigger and manual enroll execute the full automation run synchronously on the HTTP request path

- **File:** apps/api/src/routes/automation-webhook-trigger.ts:21, apps/api/src/services/automations/webhook-receiver.ts:428, apps/api/src/services/automations/runner.ts:438, apps/api/src/routes/automations.ts:961
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V8_

POST /v1/webhooks/automation-trigger/:slug awaits receiveAutomationWebhook (automation-webhook-trigger.ts:21), which awaits enrollContact (webhook-receiver.ts:428), which awaits the entire runLoop (runner.ts:438) before the 202 is sent; the manual enroll endpoint POST /v1/automations/{id}/enroll (automations.ts:961, returns 201) has the identical shape. There is no waitUntil, queue, or any other deferral anywhere in this chain (verified by grep). runLoop executes up to 200 node visits, each costing at least 3 sequential DB round trips (run re-read, pause-control check, automation/graph re-read at runner.ts:61-95) plus the node handler, and send-message handlers make external platform calls (100ms-10s each) — so a modest graph holds the request open for multiple seconds at ~85-120ms per DB RTT. On the public webhook endpoint this means upstream webhook senders (typical 5-30s timeouts) can time out and retry, re-enrolling the same contact and duplicating sends, since there is no idempotency key. The only mitigating factor is that runLoop returns early when the run reaches a waiting state (delay/input nodes), so graphs that wait early respond faster than full completion; severity is re-graded from critical to high on that basis.

**Suggested fix:** Split enrollContact so the run-row insert (runner.ts:406-427) is separable from execution, then in both routes insert the run, respond immediately with run_id, and kick off runLoop via c.executionCtx.waitUntil(runLoop(db, runId, env)) — or enqueue { runId } to a queue consumer for retry semantics. Response bodies are unchanged and the webhook route already returns 202 Accepted, so async execution matches the documented contract; optionally add slug+payload-hash idempotency to dedupe upstream retries.

---

### [HIGH] Automation typing indicators and delay blocks sleep in-process inside the inbox queue consumer and cron job drain

- **File:** apps/api/src/services/automations/platforms/index.ts:182-184, 194-198, 379-381; apps/api/src/queues/inbox.ts:13-25; apps/api/src/services/automations/scheduler.ts:91-117
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V11_

dispatchAutomationMessage awaits a setTimeout-backed wait() for the typing indicator (platforms/index.ts:182-184) and for every in-message delay block (194-198), sleeping wall-clock in-process. These dispatches execute inside the relayapi-inbox queue consumer (queues/inbox.ts:13-25, max_batch_size 10 processed sequentially, max_concurrency 5), so one automation with delay blocks stalls the shared multi-tenant inbox pipeline, and inside the every-minute cron drain that processes up to 50 jobs sequentially (scheduler.ts:91-117). Bounds are not enforced: node config is z.record(z.string(), z.any()) (schemas/automation-graph.ts:99), MessageBlockSchema's 10s delay cap is never applied at write time, typing_indicator_seconds is uncapped, and the dispatcher only floors delays at 0 — so a single message node can sleep arbitrarily long. A cron tick whose cumulative sleeps exceed the 5-minute stale-claim window (scheduler.ts:52-59) gets its still-processing jobs reclaimed by the next tick, producing duplicate message sends.

**Suggested fix:** Clamp in-process waits in dispatchAutomationMessage: cap typingDelayMs and each delay block at 10s and cap total sleep per dispatch (e.g. 15s). Enforce MessageBlockSchema and a typing_indicator_seconds max(10) bound in the automation write routes so caps are validated at authoring time. For anything longer, split the message node at delay boundaries and park the run with a resume_run row in automation_scheduled_jobs (machinery already exists in scheduler.ts) instead of sleeping in the consumer.

---

### [HIGH] (filed critical) Live GET /v1/analytics/platforms/posts issues N sequential per-media Instagram insights calls with no caching

- **File:** apps/api/src/services/platform-analytics/instagram.ts:253-257; apps/api/src/routes/analytics.ts:1331; apps/api/src/schemas/analytics.ts:15-21
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V17_

In instagram.ts getPostMetrics (lines 253-257), after one /media list call, each media item triggers a separate awaited igFetch to /{item.id}/insights inside a sequential for-loop, producing N+1 third-party Graph API calls per invocation. The live route handler for GET /v1/analytics/platforms/posts (analytics.ts:1331) calls this directly with query.limit (default 20, max 100 per AnalyticsQuery in schemas/analytics.ts:15-21) and has no KV caching, unlike the sibling overview endpoint which caches via getCachedPlatformOverview (analytics.ts:979-1005). At 100ms-1s+ per Graph insights call (fetch-timeout default 10s), a default request blocks for roughly 2-20+ seconds of wall clock, and worst case issues 101 sequential subrequests. The same sequential per-post insights loop exists in threads.ts (~line 218), facebook.ts (~line 298), pinterest.ts (line 169), and twitter.ts, so the cost applies across platforms. Severity is high rather than critical: it is a latency problem on a live analytics endpoint, not a correctness, data-loss, or Workers-limit failure (awaited fetches do not consume CPU time, and 101 subrequests is within paid-plan caps).

**Suggested fix:** In instagram.ts getPostMetrics, replace the sequential for-loop with const results = await Promise.all(mediaItems.map(async (item) => { ... })) (Promise.all preserves order, so response semantics are unchanged); optionally chunk to ~10 concurrent calls to respect Meta rate limits. Apply the same parallelization to the matching loops in threads.ts, facebook.ts, pinterest.ts, and twitter.ts. Additionally, add a short-TTL (e.g. 10-15 min) KV cache in the getPlatformPosts handler keyed by account_id + date range + limit, mirroring the existing getCachedPlatformOverview pattern at analytics.ts:979-1005.

---

### [HIGH] GET /v1/analytics/posting-frequency loads the org's entire publish history unbounded and ignores all declared query filters

- **File:** apps/api/src/routes/analytics.ts:755-777 (also apps/api/src/schemas/analytics.ts:49-54)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V19_

The posting-frequency handler (apps/api/src/routes/analytics.ts:755-769) selects every published post joined to every post target for the org with no LIMIT and no date bounds, then (lines 776-777) passes the full target-id list into getLatestAnalyticsForTargets, an inArray + DISTINCT ON scan over the entire post_analytics snapshot history that can also exceed the postgres driver's parameter limit on very large orgs. All weekly/frequency bucketing then happens in Worker memory. The route's own OpenAPI schema (PostingFrequencyQuery, apps/api/src/schemas/analytics.ts:49-54) declares platform, account_id, from_date, and to_date filters, but the handler never reads c.req.valid("query"), so clients have no way to narrow the scan. Sibling analytics endpoints were capped during this audit via getOrgPostTargetIds (DEFAULT_TARGETS_LIMIT=1000 / MAX_TARGETS_LIMIT=5000, lines 200-243), but this handler bypasses that helper, leaving it the remaining unbounded full-history path; cost grows linearly with org lifetime (two sequential blocking queries, the second scanning all accumulated snapshots).

**Suggested fix:** Push the aggregation into SQL: one query that buckets by date_trunc('week', p.published_at), counts DISTINCT post ids per week, and sums engagement from a DISTINCT ON (post_target_id) ... ORDER BY collected_at DESC latest-snapshot CTE, grouped server-side so the Worker receives only ~one row per week-frequency bucket. While doing so, wire up the already-documented PostingFrequencyQuery filters (from_date/to_date/platform/account_id) into the WHERE clause. Response shape is unchanged, so the contract is preserved.

---

### [HIGH] GET /v1/ads/audiences blocks on synchronous Meta audience discovery + DB upserts on every list request, including pagination pages

- **File:** apps/api/src/routes/ads.ts:964-968; apps/api/src/services/ad-audience.ts:73-132; apps/api/src/services/ad-platforms/meta.ts:318-354
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V27_

The listAudiences handler (apps/api/src/routes/ads.ts:955-1004) awaits adAudienceService.discoverAudiences() at line 965 before running the local list query, on every request — including cursor-paginated follow-up pages, which re-trigger a full re-import per page. discoverAudiences (apps/api/src/services/ad-audience.ts:73-132) performs a blocking DB join for the ad account + token (~85-120ms), a Meta Graph customaudiences fetch (100ms to multiple seconds, meta.ts:318-354), and then sequential 100-row upsert round trips, adding roughly 300ms to several seconds of latency plus Meta rate-limit consumption per list call. There is no KV/TTL gating, no executionCtx.waitUntil deferral, and no cursor-based skip anywhere in ads.ts; the try/catch at lines 964-968 only makes failures non-fatal, it does not avoid the blocking cost. Net effect: a simple paginated read endpoint costs 3+ DB round trips and one external platform call per page instead of one DB query.

**Suggested fix:** In the listAudiences handler: (1) skip discovery entirely when `cursor` is set (subsequent pages re-read the same already-imported data), and (2) gate first-page discovery behind a short-TTL KV marker (e.g. key `ads:aud-discover:${orgId}:${ad_account_id}` with 5-10 min expirationTtl) and run it via c.executionCtx.waitUntil() so the response is served from the local table immediately. Data becomes eventually consistent within the TTL window; response shape, status codes, and pagination contract are unchanged.

---

### [HIGH] POST /v1/ads/accounts/{id}/sync runs the full external ads sync (Graph fetch + per-ad upserts + 200-ad metrics refresh) synchronously in the HTTP request, bypassing the existing ADS_QUEUE path

- **File:** apps/api/src/routes/ads.ts:1163; apps/api/src/services/ad-sync.ts:89-256; apps/api/src/queues/ads.ts:49-54
- **Verdict:** confirmed  |  **Breaking fix:** yes  |  _V28_

The handler at apps/api/src/routes/ads.ts:1163 directly awaits syncExternalAds(), which inside the HTTP request performs: one external Meta Graph fetch of up to 100 ads (meta.ts:978), then for each ad 2-4 sequential DB round trips (campaign select + insert/update, ad select + insert/update, ad-sync.ts:89-226), then a metrics refresh of up to 200 active ads in batches of 5 (ad-sync.ts:229-256) where each ad triggers a DB join select, token resolution, an external Graph insights call, and up to ~30 sequential daily-metric upserts (ad-analytics.ts:28-59+). At ~100ms DB RTT the upsert loop alone is ~40s for 100 ads, and the metrics phase adds 40 serial batches of external calls (100ms-10s each), so a populated account easily exceeds Cloudflare's ~100s response window and the request fails while a DB connection and worker stay pinned. An async path for this exact job already exists: the cron enqueues {type:"sync_external"} to ADS_QUEUE (ad-sync.ts:311-315) consumed in src/queues/ads.ts:49-54 — the manual endpoint simply bypasses it.

**Suggested fix:** In the triggerSync handler, replace the inline await with `await c.env.ADS_QUEUE.send({ type: "sync_external", org_id: orgId, ad_account_id: id })` (after validating the account exists/belongs to the org with a single SELECT) and return 202 with `{ status: "queued" }`; clients poll the adSyncLogs table (already written at ad-sync.ts:266-276) for completion counts. Update SyncResponse schema and the SDK accordingly.

---

### [HIGH] (filed critical) GET /v1/inbox/comments re-fetches up to ~60 live platform comment pages per request with no comment-level cache

- **File:** apps/api/src/routes/inbox.ts:888-922 (live comment fan-out), apps/api/src/routes/inbox.ts:844 (maxPostsToInspect cap), apps/api/src/routes/inbox.ts:853-869 and 484-529 (KV-cached posts wave)
- **Verdict:** partial  |  **Breaking fix:** no  |  _V32_
- **Scope correction:** Two inaccuracies: (1) the first wave (post discovery) is not uncached — getCachedPosts serves it from KV with a 5-minute TTL, so only the comment wave is uncached on the warm path; (2) "up to 30" understates the cap — maxPostsToInspect = max(limit*3, 30) yields up to 60 live comment fetches at the default limit=20 and scales to 300 at limit=100 (bounded by 5 posts per connected account). The core finding (no comment-level caching, full live fan-out repeated per request and per pagination page) is accurate.

GET /v1/inbox/comments (apps/api/src/routes/inbox.ts:840-956) discovers recent posts per account via getCachedPosts, which IS KV-cached with a 5-minute TTL (POSTS_CACHE_TTL, lines 457, 484-529), but then fetches comments live for every candidate post on every request (mapConcurrently(allPosts, 8, ...) at line 890 calling fetchFacebookComments/fetchInstagramComments/fetchYouTubeComments) with no comment caching anywhere in the file — the only KV keys are inbox-posts:*. The fan-out cap is maxPostsToInspect = Math.max(limit * 3, 30) (line 844) bounded by 5 posts per account, so at the default limit=20 an org with 12+ connected accounts triggers up to 60 live Graph/YouTube calls per request, and the time-cursor pagination (lines 934-946) re-runs the entire fan-out for every subsequent page. With platform calls at 100ms-10s+ and concurrency capped at 8, worst-case latency is 4-8 serial batches (multi-second p50/p95) plus Graph API rate-limit burn on every dashboard poll. Severity is high rather than critical: the fan-out is bounded, failures degrade to empty arrays, the post-discovery wave is already cached, and there is no DB or memory amplification.

**Suggested fix:** Add a short-TTL KV cache for comment pages mirroring the posts cache: key inbox-comments:{post_id}:{commentsPerPost}, TTL 60-120s, read before the platform fetch in the mapConcurrently callback at line 890 and written back on success; extend invalidateInboxCache (line 460) to also delete inbox-comments:* keys for the org's posts (or track keys per account) so reply/hide/delete mutations keep read-after-write freshness. Additionally clamp maxPostsToInspect at line 844 to a hard ceiling independent of limit (e.g. Math.min(Math.max(limit, 10) * 3, 30)) to keep worst-case subrequest count flat.

---

### [HIGH] N+1 latest-message queries in GET /v1/inbox/ai/priorities (one SELECT per conversation, pool-capped at 5 concurrent)

- **File:** apps/api/src/routes/inbox-ai.ts:303-322 (per-conversation SELECT at 305-313); packages/db/src/client.ts:24 (max: 5)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V33_

GET /v1/inbox/ai/priorities issues one SELECT against inbox_messages per conversation returned by listConversations (apps/api/src/routes/inbox-ai.ts:303-322), fetching only sentiment_score and classification of the newest message to compute priority_score. The queries are wrapped in Promise.all, but the postgres.js client is created with max: 5 connections (packages/db/src/client.ts:24), so N queries execute in ceil(N/5) serialized waves of ~85-120ms each: roughly +350-500ms at the default limit of 20 and up to ~2-2.5s at the max limit of 100 (PrioritiesQuery allows limit up to 100, apps/api/src/schemas/inbox-ai.ts:94-100). The composite index inbox_msg_conv_created_idx (conversation_id, created_at) already exists (packages/db/src/schema.ts:1118-1121), so each query is cheap server-side — the cost is purely the extra round trips, which a single batched query eliminates. Note the loop comment says "latest inbound message" but the query has no direction filter; it returns the latest message of any direction.

**Suggested fix:** Replace the per-conversation loop with one batched query: collect conv IDs, then run a single SELECT DISTINCT ON (conversation_id) sentiment_score, classification FROM inbox_messages WHERE conversation_id = ANY($ids) ORDER BY conversation_id, created_at DESC (via drizzle sql or a window-function subquery with inArray), build a Map keyed by conversation_id, and compute calculatePriorityScore from the map. This uses the existing inbox_msg_conv_created_idx and reduces N round trips to 1; response shape is unchanged.

---

### [HIGH] Inbox queue consumer serializes batch behind inline ~20s customer-webhook retry loops, delaying realtime notify and automation replies

- **File:** apps/api/src/queues/inbox.ts:13-31; apps/api/src/services/inbox-event-processor.ts:583,615; apps/api/src/services/webhook-delivery.ts:84-109
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V34_

consumeInboxQueue (apps/api/src/queues/inbox.ts:13-31) processes its batch of up to 10 messages strictly serially, awaiting processInboxEvent per message. Inside each event, dispatchWebhookEvent is awaited inline (inbox-event-processor.ts:583) before the independent dashboard realtime notify (notifyRealtime, line 615); deliverWebhook (webhook-delivery.ts:84-109) makes up to 3 attempts with a 5s fetch timeout each plus in-process setTimeout backoffs of 1s and 4s, so one dead or slow customer endpoint blocks ~20s per event. With max_concurrency 5 and max_batch_size 10 (wrangler.jsonc), a tenant with a failing webhook endpoint can stall a batch for minutes (worst case ~200s per invocation), delaying realtime inbox updates and DM automation auto-replies for every message queued behind it — including other tenants' events in the same batch. The queue entry point (src/index.ts:10) does not even receive ExecutionContext, so no waitUntil deferral exists on this path; the only existing parallelism is across endpoints within one event (Promise.allSettled, webhook-delivery.ts:150).

**Suggested fix:** Two minimal changes: (1) In consumeInboxQueue, process independent messages concurrently — await Promise.allSettled(batch.messages.map(async (message) => { ...existing ack/retry logic... })) — keeping per-message ack/retry semantics. (2) In processInboxEvent, stop blocking the realtime notify behind customer webhook delivery: run steps 3 and 4 together via await Promise.allSettled([dispatchWebhookEvent(...), notifyRealtime(...)]), or thread ExecutionContext from index.ts through handleQueueBatch and use ctx.waitUntil(dispatchWebhookEvent(...)) so the 20s retry tail never holds up batch progress. Optionally cap deliverWebhook's inline backoff (e.g. drop the 4s sleep) since failed deliveries are already logged, not retried via the queue.

---

### [HIGH] Bulk inbox action runs up to 100 sequential per-conversation UPDATEs (~10s worst-case latency)

- **File:** apps/api/src/routes/inbox-feed.ts:274-342 (loop; mark_read UPDATE at 312-315; updateConversation call at 323-329); apps/api/src/schemas/inbox-feed.ts:72 (max 100 targets); apps/api/src/services/inbox-persistence.ts:557-561 (single-row UPDATE)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V37_

POST /v1/inbox/bulk iterates `for (const conversationId of targets)` (inbox-feed.ts:274) and awaits one DB write per conversation: `mark_read` runs a direct `db.update(...)` per row (lines 312-315) and all other actions call `updateConversation`, a single-row `UPDATE ... RETURNING` (inbox-persistence.ts:557-561). The schema allows up to 100 targets (schemas/inbox-feed.ts:72), so at ~85-120ms per blocking Hyperdrive round trip a full batch costs ~8.5-12s of sequential wall-clock on a user-facing endpoint. A prior optimization already collapsed the label/unlabel reads into one pre-fetch SELECT (lines 250-272), but the writes remain strictly serial with no batching, Promise.all, or set-based UPDATE. Archive/unarchive/mark_read/set_priority apply identical values to every target, making them trivially batchable into one statement.

**Suggested fix:** For archive/unarchive/mark_read/set_priority, replace the loop with one set-based statement: `db.update(inboxConversations).set(...).where(and(inArray(inboxConversations.id, targets), eq(organizationId, orgId), <workspaceScope conds>)).returning({ id })`, then derive processed = returned ids and failed/errors from targets missing in the result. For label/unlabel, keep the existing pre-fetch, compute merged label arrays in JS, and run the per-row updates with Promise.all (or chunked Promise.all of ~10) instead of sequential awaits. Response shape {processed, failed, errors} is unchanged.

---

### [HIGH] 125 untimed external fetches on route request paths; fetchWithTimeout never used in routes/, including POST /v1/posts URL-shortener calls and OAuth token/profile exchanges

- **File:** apps/api/src/lib/fetch-timeout.ts:5; apps/api/src/routes/posts.ts:1293; apps/api/src/services/short-link-providers/bitly.ts:13; apps/api/src/services/short-link-providers/dub.ts:13; apps/api/src/services/short-link-providers/short-io.ts:26; apps/api/src/config/oauth.ts:454; apps/api/src/routes/connect.ts:731; apps/api/src/routes/gmb.ts:58; apps/api/src/routes/twitter-engagement.ts:196
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V55_

fetchWithTimeout (apps/api/src/lib/fetch-timeout.ts:5, AbortController with 10s default) is used throughout services/ but has zero call sites under src/routes/ or src/config/ — exactly 125 raw fetch() sites remain in route handlers (whatsapp.ts 27, inbox.ts 26, connect.ts 21, inbox-feed.ts 15, accounts.ts 12, posts.ts 8, twitter-engagement.ts 6, gmb.ts/reddit.ts and others the rest), all on synchronous request paths. The worst case is POST /v1/posts: posts.ts:1293 awaits shortenUrlsInContent inline, and the Dub/Bitly/Short.io providers issue bare fetches with no signal (dub.ts:13, bitly.ts:13, short-io.ts:26); the surrounding try/catch (posts.ts:1303) only catches thrown errors, so a hung third-party shortener stalls post creation indefinitely despite the explicit "should not block post creation" intent. OAuth code exchange (config/oauth.ts:454) and the profile fetch (routes/connect.ts:731) are likewise untimed, as are the GMB/Reddit/Twitter engagement proxies (gmb.ts:58 gmbFetch helper, reddit.ts:210/279, twitter-engagement.ts:196-345). Workers fetch has no built-in timeout, so any slow or stalled upstream pins the request open until the client gives up — an unbounded tail-latency and availability exposure on core endpoints.

**Suggested fix:** Mechanically replace bare fetch() with fetchWithTimeout across src/routes/, src/config/oauth.ts, and src/services/short-link-providers/* (import swap plus call-site rename; the wrapper's signature is fetch-compatible). Keep the 10s default for platform proxies, and pass a shorter explicit timeout (~5s) for the URL-shortener providers since their failure is already non-fatal to post creation. Add a lint guard (biome/grep CI check) forbidding bare fetch( under src/routes/ to prevent regression.

---

### [HIGH] GET /v1/posts/logs ignores incoming cursor: emits next_cursor but always returns page 1

- **File:** apps/api/src/routes/posts.ts:1071, apps/api/src/routes/posts.ts:1107
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V89_

GET /v1/posts/logs accepts a cursor query param via PaginationParams (apps/api/src/schemas/common.ts:40), but the handler destructures only { limit, from, to } (posts.ts:1071) and never applies the cursor to the query — the SELECT at posts.ts:1080-1099 always returns the newest `limit` rows ordered by desc(postTargets.updatedAt). Yet posts.ts:1107 still returns next_cursor (the last row's id) with has_more=true, so any client that follows the cursor receives the identical first page forever; rows beyond the first page are unreachable and auto-paginating clients loop indefinitely. The composite is also internally inconsistent: next_cursor is a row id while the sort key is updatedAt, so even passing it through could not work as a keyset value. This is the same bug class fixed for GET /v1/media in this audit (media.ts:244-248); the fix there did not cover this endpoint. listRecycledCopies (posts.ts:3654) has the same pattern but is lower traffic and outside this finding's scope.

**Suggested fix:** Mirror the media.ts keyset fix: destructure cursor at posts.ts:1071; if present and parseable as a date, push lt(postTargets.updatedAt, new Date(cursor)) into conditions; change line 1107 to next_cursor: hasMore ? (data.at(-1)?.updatedAt.toISOString() ?? null) : null. (Optionally use a (updatedAt, id) tuple keyset to avoid skips on equal timestamps.) Cursors are documented as opaque, and no existing client can hold a working cursor today, so changing its format from id to timestamp is safe.

---

### [MEDIUM] (filed high) OAuth callback redirect blocks on avatar re-host (external CDN fetch + R2 put + second DB UPDATE)

- **File:** apps/api/src/routes/connect.ts:921-932; apps/api/src/routes/oauth-callback.ts:78,101
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V3_

In exchangeAndSaveAccount, after the account upsert already persisted the raw CDN avatarUrl, lines 921-932 of apps/api/src/routes/connect.ts sequentially await rehostAvatar() (an external image fetch with a 5s timeout cap in src/services/avatar-store.ts, plus an R2 MEDIA_BUCKET.put) and then a second UPDATE on social_accounts (~85-120ms DB RTT). The OAuth callback handler awaits exchangeAndSaveAccount at oauth-callback.ts:78 before returning the user-facing 302 at line 101, so the browser redirect stalls roughly 200ms-5s on best-effort cosmetic work. The redirect itself only carries status/account_id (no avatar URL), so none of this work affects the response. exchangeAndSaveAccount receives only env (no ExecutionContext), so no waitUntil deferral is possible today; the same awaited pattern repeats in selectFacebookPage at connect.ts:1957-1967. Severity downgraded from high to medium: the path runs once per account connection, not on a hot path, and the fetch is bounded at 5s.

**Suggested fix:** Add an optional waitUntil?: (p: Promise<unknown>) => void param to exchangeAndSaveAccount; when provided, replace the awaited block at connect.ts:921-932 with waitUntil(rehostAvatar(env, account.id, avatarUrl).then((stable) => stable && db.update(socialAccounts).set({ avatarUrl: stable, updatedAt: new Date() }).where(eq(socialAccounts.id, account.id)))). Pass (p) => c.executionCtx.waitUntil(p) from oauth-callback.ts:78 and connect.ts:2844; apply the same deferral at connect.ts:1957-1967. The upsert already stores the raw CDN URL as the documented best-effort fallback, so the immediate response contract is unchanged.

---

### [MEDIUM] (filed high) Instagram OAuth connect blocks redirect on 2-3 serialized Graph webhook-subscription calls

- **File:** apps/api/src/routes/connect.ts:976-1001 (awaits at :982 and :996); apps/api/src/services/webhook-subscription.ts:259,281,207; apps/api/src/routes/oauth-callback.ts:78
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V4_

In exchangeAndSaveAccount (apps/api/src/routes/connect.ts:627), the Instagram branch at lines 976-1001 inline-awaits verifyInstagramWebhookSubscription (up to 2 sequential Graph fetches: GET /{app-id}/subscriptions check then POST create, webhook-subscription.ts:259/281) followed by subscribeInstagramAccount (1 POST /me/subscribed_apps, webhook-subscription.ts:207) — 2-3 serialized external Graph calls at ~100ms-10s+ each. Both callers await this function before responding: the user-facing browser redirect in oauth-callback.ts:78-101 and POST /v1/connect/{platform}/exchange at connect.ts:2844, so the OAuth callback redirect stalls 0.3-2s+ on these calls. The subscription results are only console.error'd on failure and never affect the response, so blocking is pure waste; the Facebook page flow already defers the identical operation via c.executionCtx.waitUntil(subscribeFacebookPage(...)) at connect.ts:2001-2010. Severity is medium rather than high because this is a low-frequency, one-time connect flow rather than a hot API path.

**Suggested fix:** Add an optional waitUntil?: (p: Promise<unknown>) => void param to exchangeAndSaveAccount, pass c.executionCtx.waitUntil.bind(c.executionCtx) from both call sites (oauth-callback.ts:78, connect.ts:2844), and wrap the Instagram subscription block (connect.ts:976-1001) in it — chaining the app-level and per-user calls inside one deferred async closure, mirroring the existing Facebook pattern at connect.ts:2001-2010. Fall back to fire-and-forget (void promise.catch(console.error)) when waitUntil is absent (tests).

---

### [MEDIUM] (filed high) Automation webhook slug resolved by fetching all active webhook entrypoints platform-wide and matching in JS instead of a keyed SQL lookup

- **File:** apps/api/src/services/automations/webhook-receiver.ts:319-337
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V9_

receiveAutomationWebhook (apps/api/src/services/automations/webhook-receiver.ts:319-332) selects every active `webhook_inbound` entrypoint across all tenants — joined to the full `automations` row including the potentially large `graph` jsonb — with no slug predicate and no LIMIT, then matches `config.webhook_slug` in JavaScript via `rows.find` (lines 334-337). The slug exists only inside the `config` jsonb; packages/db/src/schema.ts:2630-2642 and the drizzle migrations define no slug column or expression index, so a keyed lookup is currently impossible. The endpoint is mounted unauthenticated at /v1/webhooks/automation-trigger/:slug (apps/api/src/routes/automation-webhook-trigger.ts:14), so even random-slug probes that 404 pay the full platform-wide fetch. Today this is still a single ~85-120ms DB round trip, so current latency impact is small; the cost is O(active webhook entrypoints platform-wide) in rows transferred and worker memory per request, growing linearly with tenant count — hence medium rather than the filed high.

**Suggested fix:** Push the slug into SQL and bound the result: add `sql`${automationEntrypoints.config}->>'webhook_slug' = ${params.slug}`` to the where() clause and append `.limit(1)`, removing the JS `rows.find`. Add a partial expression index in schema.ts plus a migration: `CREATE INDEX idx_automation_entrypoints_webhook_slug ON automation_entrypoints ((config->>'webhook_slug')) WHERE kind = 'webhook_inbound'` (make it UNIQUE if slug uniqueness should be enforced). Optionally narrow the joined automation columns to id/organizationId/channel/status to stop fetching `graph`.

---

### [MEDIUM] (filed high) Trigger-matcher re-entry guard runs 1-2 sequential automation_runs queries per candidate (N+1) instead of one batched lookup

- **File:** apps/api/src/services/automations/trigger-matcher.ts:413-468
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V10_

In matchAndEnroll, the re-entry guard (apps/api/src/services/automations/trigger-matcher.ts:413-468) iterates survivors sequentially and per candidate awaits an active/waiting-run query (lines 419-433), then either a prior-run query when allowReentry is false (lines 437-447) or a cooldown query (lines 452-464) — 1-2 blocking DB round trips per candidate at ~85-120ms each, so 5 candidate entrypoints can add 0.5-1.2s per inbound event. All queries hit the same (contact_id, automation_id) key space covered by idx_automation_runs_contact_auto, so the data could be fetched in one aggregate query; nothing is batched, cached, or parallelized. The cost lands in the relayapi-inbox queue consumer (max_concurrency 5, wrangler.jsonc:160-165) and the scheduler's per-contact loop (apps/api/src/services/automations/scheduler.ts:358), delaying automation replies and throttling queue/cron throughput rather than blocking API responses — hence medium rather than high.

**Suggested fix:** Replace the per-candidate queries with one batched query before the loop: select automation_id, bool_or(status in ('active','waiting')) as has_active, count(*) as run_count, max(completed_at) as last_completed_at from automation_runs where contact_id = $contactId and automation_id = any($survivorAutomationIds) group by automation_id (uses idx_automation_runs_contact_auto). Then evaluate the three guards (active run, prior run, cooldown window) in memory per candidate inside the existing loop.

---

### [MEDIUM] Automation enrollment re-hydrates contact + custom fields already loaded by the trigger matcher (2 redundant sequential DB round trips per enrollment)

- **File:** apps/api/src/services/automations/trigger-matcher.ts:330-355, apps/api/src/services/automations/trigger-matcher.ts:490, apps/api/src/services/automations/runner.ts:387, apps/api/src/services/automations/runner.ts:454-499
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V12_

matchAndEnroll (trigger-matcher.ts:330-355) loads the contact row via db.query.contacts.findFirst and the custom-field slug/value map via a customFieldValues x customFieldDefinitions join to evaluate entrypoint filters, then calls enrollContact (trigger-matcher.ts:490) without passing that data along. enrollContact invokes buildInitialRunContext (runner.ts:387, 454-499), which re-executes the same two queries — contacts.findFirst at runner.ts:460 and the identical custom-fields join at runner.ts:470-485 — as sequential awaits. At ~85-120ms per blocking DB round trip, every successful enrollment pays ~170-240ms of redundant latency, on paths invoked per inbound message (inbox-event-processor.ts:798), per internal event, and per contact in the scheduler enrollment loop (scheduler.ts:358). The two queries inside buildInitialRunContext are also independent of each other but run sequentially, costing one extra round trip even for callers that legitimately need hydration (routes/automations.ts /enroll, webhook-receiver, binding-router, start-automation node).

**Suggested fix:** Add an optional prehydrated arg to enrollContact, e.g. `prehydrated?: { contact: Record<string, any> | null; tags: string[]; fields: Record<string, string> }`; when supplied, buildInitialRunContext skips its two queries and uses it directly. In matchAndEnroll, pass `{ contact: contactRow ?? null, tags: tagList, fields: fieldsMap as Record<string, string> }`. Independently, parallelize the contact and custom-field queries in buildInitialRunContext with Promise.all for the remaining callers. Internal service signature only — no API response change.

---

### [MEDIUM] Automation run counters rewrite the graph-bearing automations row; unused GIN index on automations.graph amplifies every write

- **File:** apps/api/src/services/automations/runner.ts:424-427; apps/api/src/services/automations/runner.ts:627-648; packages/db/src/schema.ts:2597
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V14_

Every automation enrollment issues an awaited UPDATE incrementing automations.total_enrolled (runner.ts:424-427), and every run exit issues another via incrementCounter (runner.ts:627-648), each adding a blocking ~85-120ms DB round trip in the run path and serializing concurrent runs of the same automation on a single hot row lock. That row also carries the graph JSONB plus four indexes including idx_automations_graph_gin (schema.ts:2597, migrations 0032/0035); frequent counter churn fills pages and defeats HOT updates, at which point each increment re-inserts GIN entries for the unchanged graph. A repo-wide search found no query using GIN-eligible operators (@>, ?, @?, @@, jsonb_path) on automations.graph — all reads fetch the full row by primary key — so the index serves nothing while taxing every graph save and every non-HOT counter update.

**Suggested fix:** Drop idx_automations_graph_gin: remove line 2597 from packages/db/src/schema.ts and generate a drizzle migration with DROP INDEX. Optionally, to keep the automations row cool, move the four run counters to a narrow automation_stats table keyed by automation_id (or derive them from automation_runs aggregates) so enrollment/exit writes never touch the graph-bearing row.

---

### [MEDIUM] Automation list endpoints return full graph/context JSONB for every row in the page

- **File:** apps/api/src/routes/automations.ts:209 (select *), apps/api/src/routes/automations.ts:71 (graph in serializer); apps/api/src/routes/automation-runs.ts:239 (select *), apps/api/src/routes/automation-runs.ts:78 (context in serializer)
- **Verdict:** confirmed  |  **Breaking fix:** yes  |  _V16_

GET /v1/automations (apps/api/src/routes/automations.ts:209-228) selects all columns from `automations` and serializeAutomation (lines 62-91) emits the full `graph` JSONB plus `template_config` and `validation_errors` for every row, up to 100 per page — flow graphs can be tens of KB each, so a 100-row page can move multi-MB payloads through Hyperdrive and Worker memory (128MB cap) when only name/status metadata is needed for listing. GET /v1/automations/{id}/runs (apps/api/src/routes/automation-runs.ts:239-260, limit max 100 at line 157-164) likewise selects all run columns and serializeRun (line 78) inlines the full `context` JSONB per run, even though the file's own header (line 7) designates GET /v1/automation-runs/{id} as the route that "includes context JSON". The cost is demonstrably paid today: the dashboard proxy apps/app/src/pages/api/contacts/[id]/active-automation-runs.ts:47-63 pages through automations.list with limit=100 (up to 5 pages) and keeps only id/name/channel/status, discarding up to 500 full graphs on every inbox automation-badge lookup. No column projection, field-selection parameter, or caching exists on either list route.

**Suggested fix:** In listAutomations, replace `db.select()` with an explicit column projection that omits `graph` (and optionally `template_config`/`validation_errors`), and drop `graph` from the list serializer/ListResponse schema — keep the full graph on GET /{id} which is documented as "Get an automation with its full graph". In the runs list handler, project all columns except `context` and remove it from the list item schema, keeping it on GET /v1/automation-runs/{id}. Optionally add an `include=graph`/`include=context` query param for clients that need the old shape. Update packages/sdk/src/resources/automations.ts and automation-runs.ts types to match.

---

### [MEDIUM] (filed high) GET /v1/analytics/best-time bypasses the 6h KV cache and runs an unbounded full-history scan; cache write-back is a cancellable floating promise

- **File:** apps/api/src/routes/analytics.ts:526-595; apps/api/src/services/best-time-cache.ts:39-41,57-69; apps/api/src/services/slot-finder.ts:142
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V18_

The GET /v1/analytics/best-time handler (apps/api/src/routes/analytics.ts:526-595) fetches every published post joined to its targets for the org with no LIMIT or date window, then runs a second latest-analytics query over all target IDs — two sequential blocking DB round trips (~170-240ms) plus row transfer that grows linearly with org history — while completely ignoring the existing 6h KV cache in best-time-cache.ts, whose only consumer is slot-finder.ts. The cached path duplicates the same unbounded scan on every miss (best-time-cache.ts:57-69), and its write-back is `void env.KV.put(...)` (best-time-cache.ts:39) — a floating promise with no ExecutionContext/waitUntil anywhere in the chain, so the Workers runtime can cancel it when the invocation ends, leaving the cache cold and forcing recomputation. This recomputation sits on the synchronous POST /v1/posts auto-schedule path (posts.ts:1142-1147 via findBestSlots at slot-finder.ts:142, strategy "smart"). Indexes (posts_org_published_idx, post_analytics_target_collected_idx) keep the queries index-assisted, so today's cost is roughly 200ms-plus-transfer rather than seconds — hence medium, not high — but it grows without bound as history accumulates.

**Suggested fix:** 1) Replace the duplicated computation in the getBestTime handler with `const data = await getCachedBestTimes(c.env, orgId, c.executionCtx)` (export BestTimeSlot shape already matches the response). 2) Add an optional `ctx?: ExecutionContext` parameter to getCachedBestTimes and replace `void env.KV.put(...)` with `ctx ? ctx.waitUntil(put) : await put`; pass the context from the analytics route and from the request handlers reaching slot-finder. 3) Bound the scan in computeBestTimes with `gte(posts.publishedAt, <now - 180 days>)` so cost stops growing with total history (uses posts_org_published_idx). Response shape and contract are unchanged; values may be up to 6h stale, consistent with the existing slot-finder consumer.

---

### [MEDIUM] (filed high) GET /v1/analytics/channels cold-cache fan-out: serialized multi-phase platform calls per account, concurrency 4, 5-min KV TTL with no stale-while-revalidate

- **File:** apps/api/src/routes/analytics.ts:1133 (concurrency cap), apps/api/src/routes/analytics.ts:50 and 993-1008 (TTL/cache path), apps/api/src/services/platform-analytics/instagram.ts:147-184, apps/api/src/services/platform-analytics/twitter.ts:84-116
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V20_

GET /v1/analytics/channels iterates all connected accounts via mapConcurrently(rawAccounts, 4, ...) (analytics.ts:1133) and on KV-cache miss blocks on each platform's getOverview. The Instagram fetcher makes 5 Graph calls in 3 serialized phases (Promise.all of 2 insights, then a followers fetch, then a previous-period Promise.all of 2 — instagram.ts:147-184), and Twitter is worse: a profile call plus up to 10 serialized paginated tweet-list calls (maxPages=10, twitter.ts:84-116), i.e. up to 11 external round trips per account at 100ms-10s+ each. The KV cache (analytics:overview:{id}:{from}:{to}, 300s TTL, analytics.ts:50, 993-1008) defers its write via waitUntil but has no stale-while-revalidate, so every TTL expiry pays the full blocking fan-out again; with >4 accounts the waves serialize, making multi-second cold responses routine. Mitigating factors: the route is Pro-gated, per-account errors are caught and degrade to null metrics, and repeat views within 5 minutes are warm — so this is a latency issue, not a correctness or resource-exhaustion one.

**Suggested fix:** Three small changes: (1) add stale-while-revalidate in getCachedPlatformOverview — store { data, fetchedAt } with a long expirationTtl (e.g. 24h); serve entries younger than 300s directly, and for older entries return the stale data immediately while refreshing via executionCtx.waitUntil; (2) collapse Instagram getOverview's 3 phases into one Promise.all (current insights, followers, previous-period sums are independent); (3) raise the mapConcurrently cap from 4 to 8-10 — well within paid-plan subrequest limits.

---

### [MEDIUM] Instagram getOverview serializes 3 independent external fetch waves, adding ~2 avoidable Graph API round trips per cache miss

- **File:** apps/api/src/services/platform-analytics/instagram.ts:147-184 (waves at 147, 169, 179)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V21_

In apps/api/src/services/platform-analytics/instagram.ts, getOverview awaits three mutually independent fetch waves in sequence: a Promise.all pair of current-period insights calls (lines 147-158), a followers_count profile fetch (lines 169-173), and a previous-period fetchInsightsSums call (lines 179-184, itself a Promise.all pair). None of the waves consumes another wave's output — prevRange is derived solely from dateRange (line 178) — so all six Graph API requests could run in one parallel wave. At 100ms-1s+ per Instagram Graph call, serialization adds roughly 200ms-2s of avoidable latency on each KV cache miss; the caller getCachedPlatformOverview (apps/api/src/routes/analytics.ts:979-1008) caches results for only 300s, and GET /channels fans this out across all connected accounts at concurrency 4 (analytics.ts:1133), so cold misses compound on multi-account workspaces.

**Suggested fix:** Compute prevRange before fetching, then collapse the three waves into one: const [[timeSeriesData, totalValueData], profileData, prev] = await Promise.all([Promise.all([igFetch(...reach...), igFetch(...total_value...)]), igFetch(graphHost, accessToken, `/${platformAccountId}?fields=followers_count`), fetchInsightsSums(graphHost, accessToken, platformAccountId, prevRange)]). Response shape and values are unchanged.

---

### [MEDIUM] GET /v1/analytics ignores its validated limit (and offset) params and always returns up to 1000 target rows

- **File:** apps/api/src/routes/analytics.ts:371-378 (call missing limit arg), apps/api/src/routes/analytics.ts:201,219 (DEFAULT_TARGETS_LIMIT=1000), apps/api/src/schemas/analytics.ts:15-22 (validated limit 1-100 default 20)
- **Verdict:** confirmed  |  **Breaking fix:** yes  |  _V22_

AnalyticsQuery validates limit (int 1-100, default 20) and offset, but the GET /v1/analytics handler never reads either: getOrgPostTargetIds is invoked at apps/api/src/routes/analytics.ts:371-378 without its sixth (limit) parameter, so it falls back to DEFAULT_TARGETS_LIMIT = 1000 (lines 201, 219). Every request therefore pulls up to 1000 target rows, runs a second DISTINCT ON query with an inArray of up to 1000 ids (getLatestAnalyticsForTargets, lines 342-357, called at line 396), and serializes up to 1000 entries in data — 50x the documented default of 20 — costing two DB round trips (~85-120ms each, the IN-list query scaling with target count) plus oversized JSON. Memory is bounded (cap 1000, hard max 5000) and overview totals are computed via a separate SQL aggregate with a truncated flag, so this is a per-request latency/payload waste rather than an unbounded blowup. account_id, post_id, and offset in the same schema are likewise validated and silently ignored; query.limit is only honored by the unrelated /analytics/platform/posts route (line 1335).

**Suggested fix:** Pass the validated limit through: getOrgPostTargetIds(db, orgId, query.from_date, query.to_date, query.platform, query.limit) in the GET / handler, and update the dashboard caller (apps/app/src/pages/api/analytics.ts) to request the rows it needs (schema max is 100). If shrinking the default payload from ~1000 to 20 rows must be avoided for existing clients, apply query.limit only when the raw param is present (c.req.query("limit") !== undefined), keeping the 1000-row cap otherwise. Also implement or drop the dead offset/account_id/post_id params so the OpenAPI contract matches behavior.

---

### [MEDIUM] (filed critical) GET /v1/ads/accounts?social_account_id= runs an unthrottled inline Meta discovery crawl (1 + N×(1-10+) Graph calls) before responding

- **File:** apps/api/src/routes/ads.ts:131-133; apps/api/src/services/ad-service.ts:286-302; apps/api/src/services/ad-platforms/meta.ts:265-305
- **Verdict:** partial  |  **Breaking fix:** no  |  _V26_
- **Scope correction:** Discovery does not run "on every list request": it is gated on the optional social_account_id query param (ads.ts:131). Without it — the default dashboard list and ad-account combobox path — the endpoint is a single DB query with no Graph calls. The expensive inline crawl is real but confined to filtered requests, and the only dashboard caller passing the param is an explicit user-triggered "Discover ad accounts" action, so filed severity critical overstates real-world frequency.

When GET /v1/ads/accounts receives the optional social_account_id query param, the handler awaits adService.discoverAdAccounts inline before its DB read (ads.ts:131-133). That discovery performs one Graph call to /me/adaccounts (meta.ts:225) plus, per discovered ad account, up to 10 paginated promote_pages calls and batched IG-resolution calls (meta.ts:265-305) at concurrency 5 (ad-service.ts:286-302), followed by upsert/prune writes — easily multiple seconds of blocked external calls and a large subrequest count for orgs with many ad accounts. There is no freshness throttle: promote_pages_synced_at is written (ad-service.ts:341) but never read, so every filtered list call re-crawls Meta even though OAuth connect already runs the same discovery deferred via waitUntil (connect.ts:2011-2019). The schema documents social_account_id only as "Filter by social account ID" (schemas/ads.ts:101-104), so API/SDK consumers using it as a routine filter unknowingly pay the full crawl on each request. Severity is moderated because the param is opt-in: the plain list path (no param) is a single keyset-paginated DB query, and the dashboard's default list and combobox never pass the param — only the explicit "Discover" action does (apps/app/src/components/dashboard/pages/ads-page.tsx:305).

**Suggested fix:** Gate the inline crawl behind a freshness check: before calling discoverAdAccounts in the list handler, skip it when a recent sync exists (read promote_pages_synced_at from the matching adAccounts rows, or a KV key like `ad-discovery:{orgId}:{socialAccountId}` with a 10-15 min TTL set at the end of discoverAdAccounts). Keep the first/stale call inline so the dashboard Discover flow still returns fresh data; document the side effect or add an explicit `refresh=true` param for forced re-discovery.

---

### [MEDIUM] (filed high) Ads cron re-fetches full 30-day insights window and re-upserts ~30 rows per ad for up to 200 ads per account every 30 minutes

- **File:** apps/api/src/services/ad-sync.ts:229-256; apps/api/src/services/ad-analytics.ts:57-90; apps/api/src/scheduled/index.ts:72-74
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V29_

The */30 cron (scheduled/index.ts:72-74) enqueues every active ad account, and each sync_external job (ad-sync.ts:229-256) selects up to 200 active ads and fetches a fixed 30-day insights window for every one of them — startDate is always thirtyDaysAgo with no watermark or incremental window, so 29+ days of unchanged historical data are re-fetched and re-written each cycle (up to 9,600 Meta insights calls per account per day against Meta's ad-account-level rate limits, which are shared with user-facing createAd/boostPost). Worse, fetchAndStoreAdMetrics (ad-analytics.ts:57-90) upserts the ~30 daily rows in a sequential for-loop, ~30 blocking DB round trips at ~85-120ms each (~3s per ad), so a 200-ad account costs ~6,200 DB round trips and 2-5+ minutes of wall time per sync; the queue consumer (queues/ads.ts:21) processes its batch of 5 messages sequentially, so a full batch approaches the 1,000-subrequest cap and the consumer duration limit, risking retries that repeat the entire fetch. Mitigations already present — queue deferral with max_concurrency 3, Promise.allSettled batches of 5, and the 200-ad limit — bound concurrency but do nothing to shrink the redundant window. Severity is medium rather than high because this is a background queue path that never blocks API requests; the real costs are Meta rate-limit burn and sustained DB write churn (~300k upserts/day for a maxed-out account).

**Suggested fix:** Two minimal changes: (1) in syncExternalAds, use a 3-day window (covers Meta attribution backfill) for the recurring 30-minute sync and run the full 30-day sweep only once per day (e.g., gate on the hour of day or on the last "full" adSyncLogs entry per account); (2) in fetchAndStoreAdMetrics, replace the per-day upsert loop with a single multi-row db.insert(adMetrics).values(result.daily.map(...)).onConflictDoUpdate using excluded.* references, collapsing ~30 sequential round trips per ad into one.

---

### [MEDIUM] (filed high) Ad metrics refresh issues ~30 sequential per-day upserts per ad and instantiates a new DB client per ad

- **File:** apps/api/src/services/ad-analytics.ts:25, apps/api/src/services/ad-analytics.ts:57-90, apps/api/src/services/ad-sync.ts:247-251
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V30_

fetchAndStoreAdMetrics (apps/api/src/services/ad-analytics.ts) calls createDb(env.HYPERDRIVE.connectionString) at line 25 on every invocation, and at lines 57-90 awaits one INSERT ... ON CONFLICT DO UPDATE per daily metric point in a sequential for-loop — both callers (ad-sync.ts:250 and queues/ads.ts:40) pass a 30-day window, so each ad costs a fresh postgres client plus ~30 blocking DB round trips (~3s at the measured ~100ms RTT). The metrics-refresh path in syncExternalAds (ad-sync.ts:229-256) runs this per ad for up to 200 active ads per account in batches of 5, triggered every 30 minutes by the */30 cron, so one large account spends minutes of pure DB latency and ~200 client connections per sync. The work is background, but it runs on the shared relayapi-ads queue (max_concurrency 3, max_batch_size 5 in wrangler.jsonc), so slow syncs delay user-initiated create_ad/boost_post messages, and 5 large sync_external messages in one consumer invocation (each opening up to 200 Hyperdrive connections plus platform calls) can approach the Workers subrequest cap. Severity downgraded from high to medium because no user-facing request path blocks on this code.

**Suggested fix:** 1) Replace the per-day loop (ad-analytics.ts:57-90) with a single multi-row upsert: db.insert(adMetrics).values(result.daily.map(...)).onConflictDoUpdate({ target: [adMetrics.adId, adMetrics.date], set: { impressions: sql`excluded.impressions`, ... collectedAt: new Date() } }) — collapses ~30 round trips to 1. 2) Add an optional db?: Database parameter to fetchAndStoreAdMetrics (defaulting to createDb for existing callers) and pass the already-created db from syncExternalAds (ad-sync.ts:48) so the refresh loop reuses one client per account instead of one per ad. Internal service signature only; no API response change.

---

### [MEDIUM] (filed high) Meta profile enrichment + avatar rehost block automation dispatch in inbox queue consumer (up to ~15s of serial external fetches)

- **File:** apps/api/src/services/inbox-event-processor.ts:444-556 (enrichment block ends line 541; dispatchAutomationMatch awaited at line 556); apps/api/src/services/avatar-store.ts:6,36; apps/api/src/queues/inbox.ts:13-31
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V35_

In processInboxEvent, the Meta participant-profile enrichment block (inbox-event-processor.ts:444-541) is awaited inline before automation dispatch (line 556): Instagram tries the full field set then retries with the minimal set (5s AbortController timeout each, lines 143/176-186), then rehostAvatar performs a third external fetch with a 5s timeout plus an R2 put (avatar-store.ts:6,36), followed by two DB UPDATEs — a worst case of ~15s and a typical cost of roughly 0.5-1.5s of external I/O before any auto-reply can even be matched. The gating conditions (needsIdentityRefresh at lines 438-442) make this fire on exactly the first inbound DM of every new Instagram/Facebook conversation — the same event that triggers welcome-message automations — and again every 24h via isStaleProfile. The consumer (queues/inbox.ts:13-31) processes its batch sequentially with max_batch_size 10 / max_concurrency 5, so one slow Meta call also head-of-line blocks automation dispatch for up to nine unrelated messages in the batch. Nothing in dispatchAutomationMatch consumes the enrichment output (ensureContactForAuthor uses the raw event.author?.name, line 713), so the ordering buys no correctness. Severity regraded from high to medium: the path is already async from webhook receipt, the fetches are abort-bounded, and the typical added latency is ~1s, with 15s only when Meta times out.

**Suggested fix:** Move the step-1b enrichment block to run after dispatchAutomationMatch (and the webhook/realtime dispatches), since automations only read the raw event fields; alternatively, accept the ExecutionContext in the queue handler (index.ts queue(batch, env, ctx)), thread it through consumeInboxQueue/processInboxEvent, and wrap the enrichment block in ctx.waitUntil so it completes off the critical path. Only caveat: the very first auto-reply's merge tags would see the unenriched participant name, which is already the case whenever enrichment fails.

---

### [MEDIUM] (filed high) Inbox comment mutations block the response on serialized cache invalidation (org-wide SELECT + KV deletes + DO notify)

- **File:** apps/api/src/routes/inbox.ts:460-482 (invalidateInboxCache); awaited call sites at apps/api/src/routes/inbox.ts:1118, 1140, 1164, 1233, 1289, 1344
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V36_

invalidateInboxCache (apps/api/src/routes/inbox.ts:460-482) runs three sequential stages: an org-wide SELECT of all social_accounts ids (~85-120ms DB round trip), N KV deletes (parallel among themselves via Promise.all), then an awaited Durable Object fetch to RealtimeDO via notifyRealtime. Six comment-mutation handlers (reply on FB/IG/YT at lines 1118/1140/1164, delete at 1233, hide at 1289, unhide at 1344) await this entire chain before returning their response, adding roughly 150-250ms of post-mutation latency. The work is explicitly best-effort — every stage swallows errors and is commented "non-critical" — so nothing in the response depends on it; the client response shape is identical whether it runs before or after the response. Severity is medium rather than high because these endpoints already block on an external platform API call (100ms-10s), making the invalidation a fractional rather than dominant cost.

**Suggested fix:** At each of the six call sites, replace `await invalidateInboxCache(c.env.KV, db, orgId, c.env)` with `c.executionCtx.waitUntil(invalidateInboxCache(c.env.KV, db, orgId, c.env))` so the response returns immediately. This is safe: the function already catches all errors internally, and db-context.ts never closes the request-scoped db client, so it remains usable inside waitUntil.

---

### [MEDIUM] Comment moderation endpoints fan out one platform write per org account (up to 50 parallel external calls per request)

- **File:** apps/api/src/routes/inbox.ts:1184-1191 (deleteComment), apps/api/src/routes/inbox.ts:1246-1251 (hideComment), apps/api/src/routes/inbox.ts:1301-1306 (unhideComment), apps/api/src/routes/inbox.ts:1358-1361 (likeComment), apps/api/src/routes/inbox.ts:1393-1396 (unlikeComment), apps/api/src/routes/inbox-helpers.ts:66 (maxAccounts=50 default)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V41_

The five comment moderation handlers (delete/hide/unhide/like/unlike, apps/api/src/routes/inbox.ts:1175-1412) receive only a comment_id (CommentIdParams, apps/api/src/schemas/inbox.ts:44-46, has no account_id), so they cannot resolve the owning account and instead load every org account via getAccountsForOrg (default cap maxAccounts=50, inbox-helpers.ts:66) and fire one platform write per platform-eligible candidate through Promise.allSettled, taking the first success. The calls are already parallel, so wall-clock cost is not 50x serial, but allSettled waits for the slowest call to settle (platform calls run 100ms-10s+), and each action burns up to ~50 Workers subrequests and Meta/YouTube rate-limit budget with N-1 guaranteed failures. likeComment has an additional correctness side effect: every Facebook page in the org that can access the comment likes it, not just one. On success, delete/hide/unhide also await invalidateInboxCache inline (lines 1233, 1289, 1344), adding another full-table account query (~100ms DB RTT) plus per-account KV deletes before responding.

**Suggested fix:** Add an optional account_id to CommentIdParams (additive query param) and target that single account when provided — callers that listed comments already know the owning account, since listComments returns results keyed by account. For the fan-out fallback, race candidates and return on first success (Promise.any semantics with AbortController to cancel losers) instead of awaiting allSettled, and move invalidateInboxCache into c.executionCtx.waitUntil so the cache purge does not block the response.

---

### [MEDIUM] Inbox message search uses leading-wildcard ILIKE with no trigram/FTS index on inbox_messages.text

- **File:** apps/api/src/services/inbox-persistence.ts:375 (query); packages/db/src/schema.ts:1117-1133 (index definitions); apps/api/src/routes/inbox-feed.ts:377 (caller)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V42_

searchMessages (apps/api/src/services/inbox-persistence.ts:375) filters with ilike(inboxMessages.text, `%q%`), a leading-wildcard pattern no btree index can serve, and the inbox_messages table (packages/db/src/schema.ts:1117-1133) carries only btree indexes — (conversation_id, created_at), (organization_id, created_at), the dedup unique index, and platform_message_id; no pg_trgm GIN or tsvector index exists anywhere in packages/db/drizzle/. The query is org-scoped with ORDER BY created_at DESC LIMIT ≤101, so Postgres can walk inbox_msg_org_created_idx backwards and stop early when matches are common, but a rare or non-matching term forces a heap scan of the org's entire message history — easily hundreds of ms to seconds once an active org accumulates 100k+ synced messages. This backs the synchronous user-facing GET /v1/inbox/search endpoint (apps/api/src/routes/inbox-feed.ts:377) with no caching or deferral in front of it.

**Suggested fix:** Add a trigram index in a new Drizzle migration: CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE INDEX inbox_msg_text_trgm_idx ON inbox_messages USING gin (text gin_trgm_ops); and mirror it in packages/db/src/schema.ts via index("inbox_msg_text_trgm_idx").using("gin", sql`${table.text} gin_trgm_ops`). The existing ILIKE query then uses the index unchanged (gin_trgm_ops supports ILIKE natively); optionally enforce a minimum query length of 3 chars, below which trigram indexes do not help.

---

### [MEDIUM] Inbox-feed routes serialize independent DB lookups (account/message/conversation, note creation) and repeat uncached FB/IG participants fetches

- **File:** apps/api/src/routes/inbox-feed.ts:1052-1085 (add reaction), apps/api/src/routes/inbox-feed.ts:1191-1223 (remove reaction), apps/api/src/routes/inbox-feed.ts:1329-1361 (delete message), apps/api/src/routes/inbox-feed.ts:625-658 (send message), apps/api/src/routes/inbox-feed.ts:1583-1653 (note creation), apps/api/src/routes/inbox-feed.ts:947-956 (typing participants fetch)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V44_

Several inbox-feed handlers execute mutually independent lookups serially. Add/remove reaction and delete-message each await getAccount (by account_id), an inboxMessages select (by message_id + conversation id), and an inboxConversations select (by conversation id) back-to-back (e.g. lines 1052, 1058, 1076), spending ~3 sequential DB round trips (~255-360ms at ~85-120ms each) where one parallel batch (~85-120ms) suffices. send-message awaits getAccount (line 625) before the conversation select (lines 639-644 for conv_ IDs, 800-809 for WhatsApp) even though that select depends only on the route param and orgId. Note creation performs four serial round trips — conversation check (1583), org-member check (1609), insert (1627), author select (1649) — where the conversation check, member check, and author lookup are independent and the member/author queries hit the same user. Additionally, FB/IG send and typing pay a blocking Graph API participants fetch (lines 647-657, 947-956) before the actual send; the typing handler issues it unconditionally for FB/IG, including local conv_ IDs where it can only 404. No caching, Promise.all, or waitUntil deferral exists on any of these paths.

**Suggested fix:** Use Promise.all for the independent lookups: in the reaction/delete handlers run getAccount, the inboxMessages select, and the inboxConversations select concurrently and check results in the existing order; in send-message start the conversation select alongside getAccount; in note creation run the conversation check concurrently with a member-check joined to the user table (replacing the separate author select). For FB/IG, persist or KV-cache the resolved recipient/participant platform ID keyed by Graph conversation ID to skip the participants fetch on repeat sends/typing, and short-circuit the typing participants fetch for conv_-prefixed IDs by reading participantPlatformId from the DB as send-message already does.

---

### [MEDIUM] Inbox post-list KV cache never stores empty results, so empty or failing accounts hit platform APIs on every inbox load; cache write is awaited inline

- **File:** apps/api/src/routes/inbox.ts:519-527 (empty-result guard and awaited kv.put), apps/api/src/routes/inbox.ts:858 and apps/api/src/routes/inbox.ts:982 (callers on GET /inbox/comments and GET /inbox/posts)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V45_

getCachedPosts (apps/api/src/routes/inbox.ts:484-529) only writes to KV when posts.length > 0 (line 519), so any Facebook/Instagram/YouTube account that returns zero posts re-fetches from the platform API (100ms-10s; YouTube makes two sequential calls, lines 407-427) on every GET /inbox/comments and GET /inbox/posts request, defeating the 5-minute cache entirely for those accounts. Worse, all three fetchers return [] on non-OK responses (lines 337, 373, 411, plus catch blocks), so accounts with expired/revoked tokens also bypass the cache and add a failing external call to the critical path of every inbox load. The kv.put on line 521 is additionally awaited inline on the response path; with concurrency capped at 6 (mapConcurrently, line 855), the slowest uncached account gates the whole response. Severity is medium: the cost is one external platform round trip per affected account per request, but only accounts with zero posts or broken tokens are affected.

**Suggested fix:** Cache empty results with a shorter negative-cache TTL: replace the `if (posts.length > 0)` guard with an unconditional kv.put using `expirationTtl: posts.length > 0 ? POSTS_CACHE_TTL : 60` (the existing `if (cached) return cached` check on line 494 already handles `[]` correctly since an empty array is truthy). Optionally pass `c.executionCtx` into getCachedPosts and wrap the kv.put in waitUntil to remove the write from the response path.

---

### [MEDIUM] GET /inbox/reviews re-discovers GMB account and location with 2 serialized Google API round trips per request despite both being persisted at connect time

- **File:** apps/api/src/routes/inbox.ts:1493-1521 (discovery), apps/api/src/routes/inbox.ts:1525 (reviews fetch); cf. apps/api/src/routes/connect.ts:2461 (metadata persisted at connect)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V46_

In the listReviews handler, the googlebusiness branch unconditionally awaits GET mybusinessaccountmanagement.googleapis.com/v1/accounts (inbox.ts:1493) and, when metadata.default_location_id is absent, a second serialized GET .../v1/{account}/locations (inbox.ts:1509) before the actual reviews fetch (inbox.ts:1525) — two extra external round trips (typically 100-500ms each) serialized in front of every reviews request per GMB account. The connect flow already persists both values in social_accounts.metadata as google_account_name and location_id (connect.ts:2461), but the handler only reads the differently-keyed default_location_id, which is set solely by the optional PUT gmb-location endpoint (accounts.ts:1588-1595), so accounts from the standard OAuth flow always hit the slow path. Even when default_location_id is set, the accounts-discovery call still fires and its result (gmbAccount.name, used only at line 1510) is discarded — pure wasted latency. There is no KV caching or metadata write-back of the discovered values; the same re-discovery pattern is duplicated in the backfill service (apps/api/src/services/inbox-backfill.ts:511-550), though that path is async and less latency-sensitive.

**Suggested fix:** In the googlebusiness branch of listReviews, read account.metadata.google_account_name and metadata.location_id (or default_location_id) first and build the v4 path as `${google_account_name}/${location_id}/reviews` directly, skipping both discovery fetches; move the accounts-discovery call inside the no-location fallback so it only runs when metadata is missing, and on fallback persist the discovered google_account_name/location into social_accounts.metadata via c.executionCtx.waitUntil so discovery happens at most once per account.

---

### [MEDIUM] WhatsApp status updates processed serially with per-status webhook-endpoint SELECT and blocking retried deliveries in the shared inbox queue consumer

- **File:** apps/api/src/services/inbox-event-processor.ts:1625-1657; apps/api/src/services/webhook-delivery.ts:140-148, 84-109, 113
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V49_

processWhatsAppStatuses (inbox-event-processor.ts:1625) loops serially over each WhatsApp status (sent/delivered/read/failed — roughly 3 per outbound message), awaiting one UPDATE round trip (~100ms) and then a full dispatchWebhookEvent per status. Each dispatch re-runs an uncached SELECT of the org's webhookEndpoints (webhook-delivery.ts:140-148) even when no endpoint subscribes to message.status_updated, and each delivery can block up to ~20s on a failing endpoint (3 attempts x 5s timeout plus 1s/4s setTimeout backoff, webhook-delivery.ts:84-109) before inserting a webhookLogs row over a brand-new createDb connection (line 113). This runs inside consumeInboxQueue (queues/inbox.ts:13-31), which processes batch messages serially with max_concurrency 5 on the same relayapi-inbox queue that carries inbound customer messages, so a WhatsApp broadcast's status flood (or one dead customer endpoint) backs up inbound message processing and automations. Endpoint deliveries within a single status are parallel via Promise.allSettled, but statuses themselves are strictly sequential at >=200ms (2 DB RTTs) each even in the best case.

**Suggested fix:** In processWhatsAppStatuses, fetch the org's enabled endpoints matching message.status_updated once before the loop; if none match, run only the status UPDATEs (and skip dispatch entirely). Run the per-status UPDATE+dispatch pipeline with Promise.allSettled (or at least batch the UPDATEs and dispatch deliveries concurrently) instead of awaiting each status sequentially, passing the pre-fetched endpoint list to deliverWebhook directly. Also reuse the caller's shared db handle for the webhookLogs insert in deliverWebhook instead of createDb per delivery.

---

### [MEDIUM] Webhook delivery blocks cron loops and queue consumers up to ~25s per dead endpoint, opens a new postgres client per delivery, and serializes independent KV/DNS checks

- **File:** apps/api/src/services/webhook-delivery.ts:57, apps/api/src/services/webhook-delivery.ts:73, apps/api/src/services/webhook-delivery.ts:84-109, apps/api/src/services/webhook-delivery.ts:113; apps/api/src/services/recycling-processor.ts:35-44,202; apps/api/src/services/cross-post-processor.ts:37,142; apps/api/src/services/auto-post-processor.ts:251,270; apps/api/src/services/publisher-runner.ts:296; apps/api/src/lib/ssrf-guard.ts:20-25
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V50_

deliverWebhook (webhook-delivery.ts:84-109) retries a dead endpoint inline: 3 attempts with a 5s fetch timeout each plus 1s and 4s setTimeout backoffs (20s), preceded by a serialized KV secret fetch (line 57) and a DoH SSRF DNS check (line 73) that can add ~5s cold (two DoH endpoints, 2.5s timeout each, cached only in a per-isolate Map at ssrf-guard.ts:25). This full ~25s worst case is awaited per item inside serial cron loops (recycling-processor.ts:35-44 awaits dispatchWebhookEvent at :202 for up to 20 due configs; same pattern in cross-post-processor.ts:37/:142 and auto-post-processor.ts:251/:270) and inside the publish queue consumer (publisher-runner.ts:296), where it holds one of only 5 consumer slots. Additionally, each delivery opens a brand-new postgres client via createDb at webhook-delivery.ts:113 solely to insert one webhook_logs row, even though dispatchWebhookEvent already receives a db handle it never passes down — adding an avoidable ~85-120ms+ connection-plus-insert round trip per delivery and leaking unclosed clients within the isolate.

**Suggested fix:** (1) Thread the existing db handle from dispatchWebhookEvent into deliverWebhook and use it for the log insert instead of createDb. (2) Parallelize the independent KV secret fetch and isBlockedUrlWithDns check with Promise.all. (3) Stop awaiting full delivery per item in cron loops and the publish consumer: fire dispatchWebhookEvent without await (with .catch logging) or collect promises and Promise.allSettled once at the end of the batch; longer-term, move delivery to a dedicated queue with native retry/backoff instead of in-process setTimeout sleeps.

---

### [MEDIUM] Webhook signing secret stored only in KV with 1-year TTL; deliveries silently go unsigned after expiry (no DB fallback)

- **File:** apps/api/src/routes/webhooks.ts:319-324; apps/api/src/services/webhook-delivery.ts:57-70
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V53_

Webhook creation stores only a one-way SHA-256 hash of the signing secret in Postgres (apps/api/src/routes/webhooks.ts:26-33, 301) and puts the sole recoverable copy (encrypted raw secret) in KV with expirationTtl: 86400 * 365 (webhooks.ts:319-324). At delivery time, deliverWebhook reads the secret from KV and, when the read returns null, silently skips the X-RelayAPI-Signature header and delivers the payload unsigned with no log or error (apps/api/src/services/webhook-delivery.ts:57-70). Because the DB holds only the hash, there is no fallback path: exactly 365 days after a webhook is created, every delivery to that endpoint loses its HMAC signature — consumers that verify signatures will reject events (silent data loss) and consumers that don't are exposed to spoofed payloads. The endpoint otherwise still appears healthy in webhook_logs, making the failure hard to diagnose.

**Suggested fix:** Persist the encrypted raw secret durably: add a column (e.g. secret_encrypted) to webhook_endpoints, write maybeEncrypt(rawSecret, ENCRYPTION_KEY) there at creation, and in deliverWebhook fall back to decrypting it on KV miss (re-populating KV via ctx.waitUntil as a cache). Alternatively, as a minimal stopgap, drop the expirationTtl from the KV put (deletion already cleans up the key) and log an error whenever rawSecret is null so unsigned deliveries are at least observable.

---

### [MEDIUM] (filed high) GET /v1/posts?include_external=true serializes the independent external-posts query after the internal posts/targets round trips

- **File:** apps/api/src/routes/posts.ts:632, apps/api/src/routes/posts.ts:794, apps/api/src/routes/posts.ts:885
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V54_

In the listPosts handler, fetchExternalPostItems is awaited only after the internal posts query (posts.ts:632) and the post-targets query (posts.ts:658 on the include=targets path, :838 on the lean path) — and after the external-media lookup (:709) when include=media — at posts.ts:794 and :885. The helper (posts.ts:929-941) depends solely on request params (workspace_id, account_id/account_ids, from, to, limit, cursor) and orgId, never on the internal query results, so this adds one fully avoidable serialized DB round trip (~85-120ms) to every include_external=true request, on top of the 2-3 inherently serial round trips the endpoint already needs. Severity is medium rather than high: the cost is a single ~100ms RTT, not an N+1 or multi-RTT chain. Side note: the lean-path call at :885 omits account_ids while the targets-path call at :794 passes it, so external posts are not filtered by account_ids on the lean path.

**Suggested fix:** Hoist the external fetch into a promise started before the internal posts query at posts.ts:632 — e.g. `const externalPromise = include_external === "true" && (!status || status === "published") ? fetchExternalPostItems(db, orgId, c, { workspace_id, account_id, account_ids: accountIdList, from, to, limit, cursor }) : null;` — then replace the two `const ext = await fetchExternalPostItems(...)` calls at :794 and :885 with `const ext = await externalPromise!`. (Passing account_ids in the shared call also fixes the lean-path filter omission; keep per-path params if strict behavior preservation is preferred.)

---

### [MEDIUM] Post logs and recycling endpoints serialize the post-ownership check before the child query, adding one blocking DB round trip each

- **File:** apps/api/src/routes/posts.ts:2661-2678 (GET /{id}/logs), apps/api/src/routes/posts.ts:3432-3449 (GET /{id}/recycling), apps/api/src/routes/posts.ts:3487-3505 (PUT /{id}/recycling), apps/api/src/routes/posts.ts:3590-3605 (DELETE /{id}/recycling), apps/api/src/routes/posts.ts:3616-3634 (GET /{id}/recycled-copies)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V57_

Five post sub-resource handlers in apps/api/src/routes/posts.ts run two sequential awaited DB queries keyed on the same route param: an ownership probe on posts (e.g. lines 2661-2665) followed by the child query (postTargets at 2674-2678, postRecyclingConfigs at 3445-3449 and 3501-3505, the delete at 3603-3605, recycled copies at 3629-3634). With this deployment's ~85-120ms DB round trip, each request pays roughly double the necessary DB latency (~200ms instead of ~100ms) even though the child queries are independent of the ownership result, which only gates the 404 response. The parallelization fix already applied during this audit covers GET /{id} (Promise.all at line 1656) and DELETE /{id}, but these five handlers remain serialized. The recycled-copies child query is already org-scoped and postRecyclingConfigs stores organizationId, so parallel execution leaks nothing across tenants.

**Suggested fix:** In each GET handler, fetch the ownership row and the child rows with one Promise.all and return 404 (discarding child results) when the post row is absent: logs (2661/2674), recycling (3432/3445), recycled-copies (3616/3629). In PUT /{id}/recycling, Promise.all the post select (3487) and existing-config select (3501) before running validateRecyclingConfig. In DELETE /{id}/recycling, scope the delete with and(eq(postRecyclingConfigs.sourcePostId, id), eq(postRecyclingConfigs.organizationId, orgId)) and run it in Promise.all with the post check used only for the 404.

---

### [MEDIUM] GET /v1/media presigns up to 100 view URLs per request, bypassing the existing KV presign cache

- **File:** apps/api/src/routes/media.ts:50-56, apps/api/src/routes/media.ts:271-274
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V58_

The GET /v1/media list handler signs a view URL for every returned record via a local getPresignedViewUrl helper (apps/api/src/routes/media.ts:50-56) that calls the AWS SDK's getSignedUrl directly, with no KV lookup; with FilterParams capping limit at 100 (default 20), that is up to 100 SigV4 signing chains of pure CPU per request, roughly 100-300ms of Worker CPU at the cap that Promise.all cannot parallelize. A KV presign cache already exists in apps/api/src/lib/r2-presign.ts (presignWithCache, lines 47-71, 50-min TTL with fire-and-forget writes) and is used by the posts, ideas, and publisher-runner code paths via presignRelayMediaUrls, but media.ts imports only getCachedR2Client and RELAY_R2_BUCKET, so the media list, GET /v1/media/{id} (line 474), and POST /v1/media/confirm (line 585) all sign uncached. Warm KV reads (~1ms, issued in parallel) would replace nearly all of this signing work on repeat list views. The keyset-pagination fix applied to media.ts during this audit did not change the presign path.

**Suggested fix:** Export presignWithCache from apps/api/src/lib/r2-presign.ts (or add an exported presignStorageKey(env, client, storageKey, expiresIn) wrapper) and have media.ts's getPresignedViewUrl delegate to it, passing c.env so the KV namespace is available. Keep the existing per-request Map dedup pattern if identical storage keys can repeat in one page. No response shape changes; cached URLs remain valid presigned URLs with at least 10 minutes of life, and the list response exposes no expires_in field.

---

### [MEDIUM] Short-link click counter is a lossy KV read-modify-write (1 write/sec/key, 60s colo read cache) that undercounts clicks

- **File:** apps/api/src/routes/short-link-redirect.ts:30-37; apps/api/src/services/short-link-providers/relayapi.ts:64-66
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V60_

The redirect handler at apps/api/src/routes/short-link-redirect.ts:30-37 increments the click counter with a KV get-then-put on `sl:${code}:clicks`, which cannot implement a reliable counter: Cloudflare KV is eventually consistent with a 60-second minimum colo read cache, and writes to a single key are capped at roughly 1/sec, with excess puts failing 429 — silently here, since the put runs unawaited inside waitUntil with no error handling. Concurrent clicks across colos (or two isolates in the same colo) read the same stale value and both write count+1, losing increments roughly in proportion to traffic. This lossy KV value is the source of truth: the built-in provider's getClickCount (apps/api/src/services/short-link-providers/relayapi.ts:64-66) reads it and it is surfaced to customers via GET /v1/short-links/{id}/stats and click_count in list responses; the shortLinks.clickCount DB column is only ever synced from this same number. The redirect path itself is unaffected (one warm KV read, ~1ms), so this is a data-accuracy defect rather than a latency one.

**Suggested fix:** Stop counting in KV. Minimal option: in the waitUntil, replace the KV get/put with an atomic SQL increment (UPDATE short_links SET click_count = click_count + 1 WHERE short_url ends with /r/{code} — ideally add an indexed short_code column), and point the relayapi provider's getClickCount/getClickCounts at shortLinks.clickCount; the ~100ms DB round trip is hidden by waitUntil. Alternatively aggregate clicks via Workers Analytics Engine (writeDataPoint per click) or a per-code Durable Object counter if DB write volume is a concern.

---

### [MEDIUM] POST /v1/ref-urls/{id}/click serializes 5+ blocking DB round trips; best-effort automation emit awaited inline

- **File:** apps/api/src/routes/ref-urls.ts:359-415 (awaits at 359, 371, 384, 391, 398)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V61_

The ref-URL click handler (apps/api/src/routes/ref-urls.ts:353-419) executes five sequential awaited DB operations on the common path: refUrls findFirst (L359), the uses-counter UPDATE...RETURNING (L371), an automations findFirst for the channel when the URL is bound (L384), a contacts findFirst for org validation (L391), and an inline-awaited emitInternalEvent (L398) whose matchAndEnroll issues at least one entrypoint-candidate query (services/automations/trigger-matcher.ts:299) and, when candidates exist, re-fetches the same contact (L330), loads custom-field values (L336), pause rows (L386), and runs per-candidate re-entry checks in a loop (L419-464). At ~85-120ms per round trip this is roughly 425-600ms minimum blocking latency, growing well past that when an entrypoint matches, even though the HTTP response depends only on the updated row from L371 and the emit is explicitly documented as best-effort (it never throws). Severity is medium because the caller is a server-to-server tracker invoked after the user has already been redirected, so the cost is throughput/timeout pressure rather than user-perceived redirect latency.

**Suggested fix:** Two minimal changes: (1) collapse the fetch+increment into one round trip — UPDATE ref_urls SET uses = uses + 1 WHERE id = $id AND organization_id = $org RETURNING *, then run the existing isWorkspaceScopeDenied check on the returned row (or add the workspace predicate to the WHERE to avoid counting denied clicks); (2) move the automation-channel lookup, contact validation, and emitInternalEvent into c.executionCtx.waitUntil(...) and return serialize(updated) immediately — the same deferral pattern already used for the KV write-back in middleware/auth.ts, and the request-scoped Drizzle client from db-context survives past the response. Optionally Promise.all the automation and contact lookups inside the deferred block. This drops blocking round trips from 5+ to 1.

---

### [MEDIUM] createIdea chains up to ~8 sequential DB round trips (group lookup, max-position, insert, tag/media inserts, two activity logs, re-fetch)

- **File:** apps/api/src/routes/ideas.ts:435-513 (key awaits: 448, 452, 458, 482, 489, 501, 503, 508)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V62_

POST /v1/ideas (apps/api/src/routes/ideas.ts:435-513) executes its DB work as a strictly sequential chain: ensureDefaultGroup when group_id is omitted (1-2 queries, idea-groups.ts:50-67), a SELECT max(position) (line 452), the idea INSERT (line 458), an ideaTags INSERT (line 482), an ideaMedia INSERT (line 489), two separate ideaActivity INSERTs via logActivity (lines 501 and 503), and finally a Promise.all re-fetch of tags+media (line 508) — the only parallelized step. A request with tags, media, and no group_id pays 8-9 blocking round trips; at ~85-120ms per Worker→Postgres RTT that is roughly 700-950ms of pure DB latency, and even a minimal request pays 4-5 RTTs (~400-500ms). The tag insert, media insert, and both activity-log inserts are mutually independent once the idea row exists, and the max-position read can be folded into the INSERT itself, so most of this chain is avoidable.

**Suggested fix:** (1) Replace the separate max-position SELECT with a scalar subquery in the INSERT (position: sql`COALESCE((SELECT MAX(position) FROM ideas WHERE group_id = ${groupId}), 0) + 1`), which also closes the read-then-write race. (2) After the idea INSERT, run the ideaTags insert, ideaMedia insert (with .returning() to capture rows), and both logActivity inserts in one Promise.all. (3) Build the response media from the .returning() rows instead of fetchIdeaMedia, and fetch tag details inside the same Promise.all — collapsing the chain to ~3 sequential RTTs (group resolve, idea insert, parallel batch). Response shape is unchanged.

---

### [MEDIUM] GET /v1/connections/logs ignores its cursor parameter (pagination loops forever) and runs a needless per-request COUNT for an undocumented field

- **File:** apps/api/src/routes/connections.ts:83, apps/api/src/routes/connections.ts:97-100, apps/api/src/routes/connections.ts:117
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V66_

The GET /v1/connections/logs handler destructures only { limit, from, to } from the validated query (connections.ts:83), so the cursor declared in PaginationParams (schemas/common.ts:40) and exposed in the SDK (packages/sdk/src/resources/connections.ts:65) is silently ignored — yet the route emits next_cursor (last row id, line 117) and has_more, so any client following pagination refetches page 1 forever, both a correctness bug and a source of repeated wasted DB round trips. Additionally, lines 97-100 run a count() query on every request whose result feeds a `total` field that is absent from both the ConnectionLogListResponse schema (lines 22-26) and the SDK type; the count is org-scoped and covered by connection_logs_org_created_idx and runs inside Promise.all (no extra serial round trip), but its DB-side cost grows linearly with the org's log volume (every token refresh/connect/error inserts a row) for zero documented benefit. has_more is already derived from the limit+1 fetch (line 104), so the count is entirely redundant.

**Suggested fix:** Mirror the media.ts keyset fix: read cursor from c.req.valid("query"), and when present push lt(connectionLogs.createdAt, new Date(cursor)) into baseConditions (guarding NaN); emit next_cursor as data.at(-1)?.createdAt.toISOString(). Delete the count() query, countRows/total, and the undocumented total response field (cursor tokens are documented as opaque and total is in neither the OpenAPI schema nor the SDK type, so no contract change).

---

### [MEDIUM] forceSync (POST /v1/accounts/sync) upserts sync state in a serial per-account loop — O(n) blocking DB round trips

- **File:** apps/api/src/routes/accounts.ts:2100-2117
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V68_

The forceSync handler (apps/api/src/routes/accounts.ts:2070-2135) loops over every syncable account and issues one awaited `db.insert(socialAccountSyncState).values(...).onConflictDoUpdate(...)` per account (lines 2100-2117), serially — no Promise.all and no multi-row insert. At ~85-120ms per DB round trip, an org with 20 connected accounts blocks ~2-2.5s before responding; the endpoint is user-facing (called from the dashboard posts page via the SDK at apps/app/src/components/dashboard/pages/posts-page.tsx:313). The queue side is already efficient — messages are batch-enqueued via `SYNC_QUEUE.sendBatch` in chunks of 100 (lines 2130-2132). The schema supports collapsing the loop: `social_account_sync_state.social_account_id` has a unique constraint (packages/db/src/schema.ts:2028-2031), and the conflict-update SET values are all constants, so a single multi-row upsert is semantically identical.

**Suggested fix:** Replace the per-account loop with one statement: build `const rows = syncable.map((a) => ({ socialAccountId: a.id, organizationId: orgId, platform: a.platform as any, nextSyncAt: now }))` and run a single `db.insert(socialAccountSyncState).values(rows).onConflictDoUpdate({ target: socialAccountSyncState.socialAccountId, set: { enabled: true, nextSyncAt: now, updatedAt: now } })`, then build `messages` from `syncable` as today. This turns n round trips into 1; response shape is unchanged.

---

### [MEDIUM] POST /accounts/{id}/sync blocks response on synchronous avatar re-fetch + R2 re-host before enqueueing the sync job

- **File:** apps/api/src/routes/accounts.ts:1985-2001 (blocking avatar block), apps/api/src/routes/accounts.ts:2030 (queue send)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V69_

The syncAccount handler (apps/api/src/routes/accounts.ts:1943) awaits, in sequence, fetchAvatarUrl — an external platform API call with a 10s timeout (services/token-refresh.ts:510-512) — then rehostAvatar, which downloads the CDN image with a 5s timeout and writes it to R2 (services/avatar-store.ts:36-48), then a socialAccounts UPDATE (~100ms DB round trip), all before the sync-state upsert and SYNC_QUEUE.send at line 2030. This adds typically several hundred ms to multiple seconds (worst case ~15s of fetch timeouts) of request latency on what is otherwise a trivial enqueue endpoint. The response body is just { success: true } and does not include the avatar URL, so none of this work is needed to produce the response, and nothing is deferred via c.executionCtx.waitUntil.

**Suggested fix:** Move the avatar refresh (lines 1987-2001: maybeDecrypt + fetchAvatarUrl + rehostAvatar + the avatarUrl UPDATE) into c.executionCtx.waitUntil((async () => { ... })()) so it runs after the response, keeping only the sync-state upsert and SYNC_QUEUE.send in the request path. Alternatively, fold the avatar refresh into the queue consumer's sync_posts job, which already holds the account context.

---

### [MEDIUM] Token refresh: fixed 2s sleep on lock contention (hit inline in unpublish/publish paths) and daily cron permanently re-enqueues dead accounts with daily notification spam

- **File:** apps/api/src/services/token-refresh.ts:218; apps/api/src/services/token-refresh.ts:38-41; apps/api/src/services/token-refresh.ts:105-137; apps/api/src/routes/posts.ts:2437; apps/api/src/scheduled/index.ts:50-52
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V70_

refreshTokenIfNeeded (token-refresh.ts:216-218) handles KV-lock contention with a fixed `setTimeout(…, 2000)` before re-reading the token from DB; this path runs inline in the user-facing unpublish handler (posts.ts:2437) and in queue consumers (publisher-runner.ts:141, broadcast/cross-post/analytics/external-sync), so a contended refresh adds a flat 2s of blocked wall time per occurrence — costly in publish queues where consumer concurrency is capped at 5. Separately, the daily 09:00 cron (scheduled/index.ts:50-52) enqueues every account with tokenExpiresAt < now+7d with no lower time bound and no failure marker (token-refresh.ts:38-41); social_accounts has no status/needs-reauth column (packages/db/src/schema.ts:323-369). When a refresh permanently fails (refreshToken returns null, e.g. revoked refresh token), refreshAccountToken (token-refresh.ts:105-137) sends an account_disconnected notification to every org member but never mutates the row, so the account is re-selected, re-enqueued, re-attempted against the external OAuth provider (100ms-10s each), and re-notifies all members every single day, forever. The queue's 5-retry cap (queues/token-refresh.ts:33-40) does not help because a null refresh result is a successful ack, not an error.

**Suggested fix:** (1) Replace the fixed 2s sleep with a short poll: loop up to ~4 iterations of 500ms, breaking as soon as `env.KV.get(lockKey)` returns null, then do the existing DB re-read. (2) In refreshAccountToken's failure branch, persist a needs-reauth marker (e.g. `metadata.needs_reauth_at` or clear refreshToken) and add `tokenExpiresAt > now - 24h OR marker absent`-style exclusion to enqueueExpiringTokenRefresh's WHERE clause (minimal variant: a lower bound such as tokenExpiresAt > now - 14 days stops the infinite tail); dedupe the disconnect notification with a per-account KV key (e.g. 7-day TTL) so members are notified once, not daily.

---

### [MEDIUM] Cron scan predicates lack supporting indexes: external_posts staleness keyset scan, posts/external_posts metrics ordering, social_accounts.token_expires_at, inbox archive (status, last_message_at)

- **File:** apps/api/src/services/external-post-sync/cron.ts:115-151; apps/api/src/services/analytics-refresh.ts:128-142,186-189; apps/api/src/services/token-refresh.ts:37-52; apps/api/src/services/inbox-maintenance.ts:22-34; packages/db/src/schema.ts:360-367,423-438,1064-1081,1985-2014
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V72_

Four background-cron queries filter or order on columns with no usable index. enqueueMetricsRefresh (external-post-sync/cron.ts:115-151, every 5 min, up to 5 pages of 500) keyset-scans external_posts ORDER BY id with filters on published_at — which has no standalone index, only org-/account-leading composites (schema.ts:1992, 2010) — and on metrics_updated_at, whose single-column index (schema.ts:2004) degenerates because "metrics_updated_at < now()-6h OR IS NULL" matches nearly every row older than 6 hours, forcing a near-full bitmap+sort or PK-order heap filter per page. The every-5-minute analytics refresh (analytics-refresh.ts:141, 188) orders by posts.metrics_collected_at and external_posts.metrics_updated_at after a status/published_at filter, and posts has no index on metrics_collected_at at all (schema.ts:423-438). The daily token-refresh scan on social_accounts.token_expires_at (token-refresh.ts:38-52) and the daily inbox archive UPDATE on status='open' AND last_message_at < 90d (inbox-maintenance.ts:28-33) both fall back to sequential scans since social_accounts and inbox_conversations only carry organization_id-leading or unrelated indexes (schema.ts:360-367, 1064-1081). All four are cron-path, so the cost is recurring load on the shared Hyperdrive Postgres that grows linearly with table size rather than direct request latency — the two 5-minute external_posts scans are the growth-sensitive ones, since external_posts accretes synced content from 21 platforms indefinitely.

**Suggested fix:** Add four index definitions in packages/db/src/schema.ts plus one generated Drizzle migration: (1) external_posts: index on (published_at, id) so the 7-day window plus id-keyset pagination in enqueueMetricsRefresh is index-served; (2) posts: partial index on (metrics_collected_at) WHERE status = 'published' (drizzle index(...).on(metricsCollectedAt).where(sql`status = 'published'`)) for the analytics-refresh ordering; (3) social_accounts: index on (token_expires_at); (4) inbox_conversations: partial index on (last_message_at) WHERE status = 'open' for the archive UPDATE. Purely additive migration, no query changes required.

---

### [MEDIUM] External post sync writes posts and metrics with single-row statements instead of batched SQL

- **File:** apps/api/src/services/external-post-sync/sync.ts:366, apps/api/src/services/external-post-sync/sync.ts:315
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V73_

upsertExternalPosts (sync.ts:366-399) issues one INSERT … ON CONFLICT DO UPDATE per post inside mapConcurrently(posts, 10, …); with 25 posts per page (sync.ts:140) and up to 5 pages per run, a sync can issue up to 125 single-row statements. Effective parallelism is capped at 5 by the postgres client pool (packages/db/src/client.ts: max: 5), so that is ~25 sequential round-trip waves at ~85-120ms each (~2-3s of DB wall time per run). refreshExternalPostMetrics (sync.ts:315-327) does the same with one UPDATE per post, up to 50 per queue message (METRICS_BATCH_SIZE=50 in cron.ts), and the cron enqueues up to 2,500 stale posts per 5-minute tick — up to ~2,500 avoidable round trips per tick on the relayapi-sync queue, which runs at max_concurrency 5. This is background work (no request-path latency; platform API calls often dominate), but it multiplies DB round trips ~25-50x per message, inflates billable Worker duration, and slows queue drain.

**Suggested fix:** In upsertExternalPosts, replace the mapConcurrently loop with a single multi-row db.insert(externalPosts).values(rows) using onConflictDoUpdate with sql`excluded."content"`-style references for the per-row SET columns (≤25 rows per call, one statement). In refreshExternalPostMetrics, replace the per-row UPDATE loop with one statement joining a VALUES list, e.g. UPDATE external_posts SET metrics = v.metrics::jsonb, metrics_updated_at = now() FROM (VALUES …) AS v(id, metrics) WHERE external_posts.id = v.id, via drizzle sql template.

---

### [MEDIUM] Broadcast processors write one UPDATE per recipient instead of set-based batch updates per chunk

- **File:** apps/api/src/services/broadcast-processor.ts:158-186; apps/api/src/services/whatsapp-broadcast-processor.ts:169-199
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V75_

Both cron broadcast processors persist per-recipient send results as one UPDATE statement per recipient: broadcast-processor.ts pushes a `db.update(broadcastRecipients)...where(eq(id))` per row (lines 165-182) and awaits them via Promise.all (line 186) for each 50-recipient chunk, and whatsapp-broadcast-processor.ts does the same for 25-recipient chunks (lines 174-199). The updates are issued in parallel, but createDb caps the postgres pool at max: 5 (packages/db/src/client.ts:24), so a 50-row chunk costs roughly 10 sequential waves of ~85-120ms round trips (~1s of DB time per chunk, on par with the deliberate 1s rate-limit sleep at line 189). Each update is also a Hyperdrive subrequest — the WhatsApp file's own budget comment (lines 29-33) counts 1 send + 1 update per recipient — so per-row writes consume half the per-invocation subrequest budget; the generic processor additionally has no per-tick recipient cap, so large broadcasts amplify both the wall time and the subrequest cost. Since rows carry distinct values (messageId/sentAt for successes, error text for failures), the chunk results can be collapsed into two set-based statements.

**Suggested fix:** In both processors, replace the per-row update loop with at most two statements per chunk: collect (id, message_id) pairs for successes and (id, error) pairs for failures, then run `UPDATE broadcast_recipients AS r SET status='sent', message_id=v.message_id, sent_at=now() FROM (VALUES ...) AS v(id, message_id) WHERE r.id = v.id` (via drizzle sql template) and the analogous statement for failures. This cuts a 50-recipient chunk from 50 UPDATE round trips/subrequests to 2.

---

### [MEDIUM] Tools queue consumer processes batch messages sequentially, stacking up to 60s external calls per job

- **File:** apps/api/src/queues/tools.ts:17-34 (config: apps/api/wrangler.jsonc:166-171)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V76_

consumeToolsQueue (apps/api/src/queues/tools.ts:17) iterates batch.messages in a plain for loop and awaits callDownloaderService with a 60_000ms timeout per message, so messages later in a batch wait behind every earlier call. With relayapi-tools configured at max_batch_size 5 and max_concurrency 3 (wrangler.jsonc:166-171), a batch of slow jobs can delay the last job by up to ~4 minutes and caps throughput at ~3 in-flight downloader calls. These jobs are user-visible: routes/tools.ts:791 and 907 return 202 with a poll_url, and clients poll KV job state until completion. The queue path only fires after the sync 20s call has already failed or timed out (routes/tools.ts:756-781), i.e. precisely when the downloader service is slow, so serialization compounds latency at the worst moment.

**Suggested fix:** Process the batch concurrently: extract the per-message body into a handleMessage(message, env) helper (keeping the existing per-message ack/retry logic) and replace the for loop with `await Promise.allSettled(batch.messages.map((m) => handleMessage(m, env)))`. Five concurrent fetches is well within Workers subrequest limits; no wrangler.jsonc change required.

---

### [MEDIUM] Auth middleware has no negative caching: every well-formed invalid API key triggers an unmetered blocking DB round trip before the 401

- **File:** apps/api/src/middleware/auth.ts:77-79, apps/api/src/middleware/auth.ts:113-117, apps/api/src/middleware/auth.ts:148-162, apps/api/src/app.ts:145
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V81_

On a KV cache miss, authMiddleware calls hydrateApiKey (auth.ts:148-155), which runs the apikey LEFT JOIN query and, for unknown/disabled/expired keys, returns null at auth.ts:77-79 without writing any tombstone to KV — the env.KV.put at auth.ts:113-117 only executes for valid keys. As a result, every request bearing the same well-formed invalid key (rlay_live_/rlay_test_ prefix) costs a blocking ~85-120ms DB round trip plus a Hyperdrive query before the 401 at auth.ts:157-162. The path is also completely unmetered: rateLimitMiddleware runs after auth (app.ts:145 vs 152) and keys on keyId, which only exists post-auth, so 401s short-circuit before any rate limiting. The lookup is index-backed (apikey_key_idx, packages/db/src/schema.ts:150), which caps DB-side cost, and the recent single-JOIN refactor halved the miss latency — but a misconfigured client or attacker replaying one revoked key still converts cheap requests into origin DB load 1:1; note a per-key negative cache does not cover an attacker generating fresh random keys (each is a new KV miss), which would additionally need pre-auth per-IP limiting at the WAF/Workers layer.

**Suggested fix:** In hydrateApiKey, when the lookup resolves invalid (auth.ts:77-79), write a negative sentinel to KV via the existing waitUntil hook — e.g. env.KV.put(`apikey:${hashedKey}`, '{"invalid":true}', { expirationTtl: 300 }) (KV minimum TTL is 60s) — and in authMiddleware treat the sentinel as an immediate 401 without hitting the DB. Delete the KV entry for a key's hash on key creation/re-enable (the active invalidation paths already delete on revoke), so a newly created key is never blocked by a stale tombstone. For the randomized-key variant, optionally add a Cloudflare WAF rate rule or per-IP RateLimit binding on 401 responses.

---

### [MEDIUM] API keys revoked/disabled outside the API's DELETE endpoint stay accepted for up to 24h via the KV auth cache

- **File:** apps/api/src/middleware/auth.ts:17, apps/api/src/middleware/auth.ts:146-162, packages/auth/src/index.ts:92, apps/api/src/routes/api-keys.ts:267
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V82_

authMiddleware fully trusts a KV hit on `apikey:<hash>` (auth.ts:146-162); the `enabled` flag is only checked during DB hydration (auth.ts:77) and the cached record carries no enabled field, so a key disabled or deleted in the DB keeps authenticating until the KV TTL of 86400s lapses (API_KEY_KV_TTL_SECONDS, auth.ts:17 — clamped only against key expiry, not revocation). The sole code path that deletes the KV record is the API's own DELETE /v1/api-keys/{id} (api-keys.ts:267); the Stripe webhook and invoice-generator paths only rewrite plan fields. Better Auth registers the apiKey() plugin with no hooks (packages/auth/src/index.ts:92) and its REST endpoints are publicly reachable through the dashboard's catch-all at apps/app/src/pages/api/auth/[...all].ts, so keys mutated there — or by direct DB/admin updates — bypass invalidation entirely; the dashboard bootstrap key even sets referenceId=user.id (bootstrap-key.ts:84), making it addressable via those endpoints. The recent auth.ts rework (LEFT JOIN hydration, waitUntil KV write-back) did not change this; its new comment (auth.ts:11-15) explicitly documents the 24h window as a "passive backstop". Severity stays medium: the primary dashboard revocation path does go through the API DELETE and invalidates immediately, but a 24h acceptance window for an out-of-band-revoked credential is a real security-staleness gap.

**Suggested fix:** Lower API_KEY_KV_TTL_SECONDS from 86400 to ~600-900s — the miss path is now a single LEFT JOIN (~100ms) with the KV write deferred via waitUntil, so per-key-per-colo rehydration once per window is cheap and bounds revocation staleness to minutes. Additionally, since all key management is supposed to flow through the API endpoints, drop the unused apiKey() plugin from packages/auth/src/index.ts (or block its routes in the [...all] handler) so Better Auth cannot mutate apikey rows without KV invalidation. Align the dashboard bootstrap-key 1-year `apikey:*` KV TTL (apps/app/src/pages/api/bootstrap-key.ts:101) with the same backstop (tracked as a separate finding).

---

### [MEDIUM] Missing indexes: auth.session.token, auth.user.email (unique), auth.member userId/organizationId, media.storage_key

- **File:** packages/db/src/schema.ts:58-75 (session), packages/db/src/schema.ts:43 (user.email), packages/db/src/schema.ts:169-181 (member), packages/db/src/schema.ts:547-550 (media indexes)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V83_

Drizzle schema and all migrations (packages/db/drizzle/0000_robust_manta.sql through 0037) define no index or unique constraint on auth.session.token, auth.user.email, or auth.member(userId/organizationId) — Postgres FKs do not auto-create indexes — and media has only media_org_idx and media_workspace_idx (schema.ts:547-550). Hot paths hitting these as sequential scans: Better Auth session lookup by token on every cookie-cache miss (cache TTL is 5 min, packages/auth/src/index.ts:56-59, so frequency is per-user-per-5-min rather than every request), member lookups in the session-create hook (packages/auth/src/index.ts:66-70) and notification fan-out (apps/api/src/services/notification-manager.ts:178-180), the upload-confirm UPDATE filtering on storage_key (apps/api/src/routes/media.ts:562-575), and the media-cleanup DELETE filtering on storage_key alone with no narrowing index at all (apps/api/src/queues/media-cleanup.ts:20). Today these scans are hidden inside the existing ~85-120ms DB round trip on small tables, so the marginal cost is low, but sessions and media grow without bound and the scans degrade linearly. user.email lacking UNIQUE is additionally a data-integrity gap (Better Auth assumes DB-level email uniqueness), not just a performance issue.

**Suggested fix:** In packages/db/src/schema.ts add table extras: uniqueIndex("session_token_idx").on(table.token) plus index("session_userId_idx").on(table.userId) on session; uniqueIndex("user_email_idx").on(table.email) on user (verify no duplicate emails exist before migrating); index("member_userId_idx").on(table.userId) and index("member_organizationId_idx").on(table.organizationId) on member; index("media_storage_key_idx").on(table.storageKey) on media. Then bun run db:generate and bun run db:migrate.

---

### [MEDIUM] (filed high) Posts page fetches unused list-view data under default calendar view and fetches WS ticket undeferred during hydration

- **File:** apps/app/src/components/dashboard/pages/posts-page.tsx:244 (All-tab list fetch gated only on tab), apps/app/src/components/dashboard/pages/posts-page.tsx:158 and :170 (queue + failed fetches), apps/app/src/components/dashboard/pages/posts-page.tsx:286 and apps/app/src/components/dashboard/calendar/calendar-view.tsx:54 (undeferred useRealtimeUpdates), apps/app/src/hooks/use-post-updates.ts:90 (/api/ws-info fetch)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V84_

The posts page's list-view hooks are gated only on the active tab, not the view mode: on the default load (All tab, viewMode defaults to "calendar" per dashboard-page.ts:91 and posts-page.tsx:96) the hook at posts-page.tsx:244 fetches /api/posts?limit=20&include=targets,media&include_external=true even though its result only renders in the list branch (line 596) and CalendarView fetches its own data via useCalendarPosts. On the Queue tab in calendar view it is two wasted requests (queue at line 158 plus failed-posts at line 170). Each wasted request is a full proxy round trip (browser to Astro worker to API worker to Postgres, ~100ms+ DB floor plus targets/media/external include queries) burned per page load; no initial*Data is passed from posts.astro, so the fetch always fires client-side. Separately, useRealtimeUpdates at posts-page.tsx:286 (and calendar-view.tsx:54) subscribes with no defer option, so the singleton connection manager fetches the single-use 60s WebSocket ticket from /api/ws-info synchronously during hydration on every full-document page navigation, competing with data fetches on the critical path — even though the hook supports deferral and streak-toast.tsx:54 already uses { defer: 4000 }.

**Suggested fix:** 1) Gate the list hooks on the rendered view: pass `activeTab === "all" && (viewMode === "list" || isMobile) ? "posts" : null` (and the equivalent for the queue and failed hooks with `activeTab === "queue"`) so list data only fetches when the list actually renders. 2) Add `{ defer: true }` to the useRealtimeUpdates calls in posts-page.tsx:286 and calendar-view.tsx:54 so the /api/ws-info ticket fetch happens after first paint, matching streak-toast.tsx. The per-navigation ticket re-fetch itself is inherent to single-use 60s tickets and need not change.

---

### [MEDIUM] (filed high) Calendar view fetches posts via up to 10 serialized cursor-paginated two-worker round trips (plus a concurrent 3-page drafts chain)

- **File:** apps/app/src/components/dashboard/calendar/use-calendar-posts.ts:82-165 (posts loop), apps/app/src/components/dashboard/calendar/use-calendar-posts.ts:183-215 (drafts loop), apps/app/src/pages/api/posts.ts:5-27 (proxy hop), apps/api/src/schemas/common.ts:41-47 (limit cap 100)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V85_

The calendar hook loads a month of posts via a do/while cursor loop (use-calendar-posts.ts:84-165) that awaits each page before requesting the next, up to MAX_PAGES=10 at limit=100; a second serialized loop fetches drafts up to 3 pages (lines 185-215). Cursor pagination makes these requests inherently sequential, and every page traverses two workers — browser -> Astro /api/posts proxy (apps/app/src/pages/api/posts.ts) -> SDK -> API worker -> Postgres (~100ms DB RTT) — so each page costs roughly 250-400ms and a busy month can take 3-4s of serialized fetching before the calendar renders. The API caps limit at 100 (apps/api/src/schemas/common.ts:45), so the client cannot reduce page count. Mitigations exist: the posts and drafts chains run concurrently (lines 223-226), MAX_PAGES bounds the worst case with a truncated flag, and workspaces with fewer than 100 posts in the visible range complete in a single page — so impact is limited to heavy-usage workspaces, warranting medium rather than high severity.

**Suggested fix:** Raise the posts list limit cap (e.g. max(500) in FilterParams/PaginationParams for the posts route, mirrored in packages/sdk) and have useCalendarPosts request limit=500, collapsing the worst case from 10 serialized pages to 2 while keeping the default at 20. Relaxing a validation maximum does not change response shape or behavior for existing clients.

---

### [MEDIUM] (filed high) Dashboard bootstrap writes apikey:* KV auth records with 1-year TTL, bypassing the API's 24h revocation backstop

- **File:** apps/app/src/pages/api/bootstrap-key.ts:100-102 (also apps/app/src/pages/api/billing/sync.ts:149-150, apps/app/src/pages/api/admin/organizations.ts:259-260 and 295-296, apps/app/src/lib/billing-logic.ts:342; contract at apps/api/src/middleware/auth.ts:17,24-29)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V86_

The dashboard bootstrap route writes the API-auth cache record `apikey:{hash}` with `expirationTtl: 86400 * 365` (bootstrap-key.ts:100-102) into the same KV namespace the API reads (both wrangler.jsonc files bind namespace c4e14913be2b41628ef71ae12561f7e8). The API explicitly defines `API_KEY_KV_TTL_SECONDS = 86400` (auth.ts:17) as a passive backstop so that keys disabled or mutated in the DB without an explicit KV delete stop working within 24h, and the auth middleware trusts any KV hit without a DB check (auth.ts:146-155). A dashboard key — full read/write, workspace_scope "all" (bootstrap-key.ts:92-93) — revoked out-of-band therefore keeps authenticating for up to a year. The same 365-day TTL appears in billing/sync.ts:149 and admin/organizations.ts:259/295, and billing-logic.ts:342 writes with no TTL at all (persists indefinitely); all API-side writers correctly use kvTtlForKey (api-keys.ts:229, stripe-webhooks.ts:453, invoice-generator.ts:177). Graded medium rather than high: it is a latent revocation gap, not a perf cost, and the common revocation paths (DELETE /v1/api-keys, Stripe webhook/invoice rewrites) actively delete or rewrite the entry with the 24h TTL.

**Suggested fix:** In all app-side writers (bootstrap-key.ts, billing/sync.ts, admin/organizations.ts, billing-logic.ts), write apikey:* entries with the API's 24h convention (replicate kvTtlForKey / 86400s) instead of 86400*365 or no TTL. Because the dashboard treats KV-entry presence as proof the key is valid (bootstrap-key.ts:46-53, dashboard-bootstrap.ts:53-58, dashboard-key-status.ts:31), also change that staleness probe to check the apikey DB row (exists + enabled) instead of KV presence, so a naturally expired 24h cache entry does not trigger needless key rotation; the API middleware already rehydrates expired entries from the DB on first use.

---

### [LOW] (filed medium) Tag/field/conversion actions block on an uncached trigger-matcher DB query per mutation, even when the org has no internal-event listeners

- **File:** apps/api/src/services/automations/internal-events.ts:55; apps/api/src/services/automations/trigger-matcher.ts:299-327; apps/api/src/services/automations/actions/tag.ts:103; apps/api/src/services/automations/actions/field.ts:130
- **Verdict:** partial  |  **Breaking fix:** no  |  _V13_
- **Scope correction:** The "full trigger-matcher pass" framing is exaggerated: with no listener entrypoints, matchAndEnroll early-returns after a single indexed query (trigger-matcher.ts:325-327) and the binding router skips all DB work for internal event kinds, so the waste is one ~100ms round trip per action, not the multi-query full pass. "Every tag/field action" is also overstated — handlers skip emission entirely on no-op mutations (tag already present/absent, field value unchanged: tag.ts:87,147; field.ts:128,175).

Every state-changing tag_add/tag_remove (actions/tag.ts:103,157), field_set/field_clear (actions/field.ts:130,176), and log_conversion_event (actions/conversion.ts:65) inline-awaits emitInternalEvent, which unconditionally runs matchAndEnrollOrBinding (internal-events.ts:55) with no caching of whether the organization has any tag_applied/field_changed/conversion_event entrypoints and no waitUntil/queue deferral. When no listeners exist the cost is bounded: matchAndEnroll early-returns "no_candidates" after one indexed SELECT (trigger-matcher.ts:299-327, idx_automation_entrypoints_match on channel/kind/status), and routeBinding does zero DB work for non-dm_received internal events (binding-router.ts:119-120,167) — so it is one wasted blocking DB round trip (~85-120ms via Hyperdrive), not a full matcher pass. The full pass (contact load, custom-field hydration, pause rows, per-candidate run checks) only executes when matching entrypoints actually exist, which is legitimate work. Still, a run with several tag/field actions pays ~100ms per action inside the automation run loop (webhook/inbox processing path) even in the common zero-listener case.

**Suggested fix:** Hydrate once per run (e.g. in buildInitialRunContext or enrollContact) the set of internal-event kinds with active, non-account-scoped entrypoints for the (organizationId, channel) — a single SELECT DISTINCT kind query — store it on ctx, and have emitInternalEvent skip the matcher when the event kind is absent from the set. Alternatively/additionally, defer emitInternalEvent via executionCtx.waitUntil so it never blocks the action chain.

---

### [LOW] (filed medium) Trigger matcher joins full automations rows (graph JSONB) per inbound event but only uses automation.id

- **File:** apps/api/src/services/automations/trigger-matcher.ts:299-323 (also apps/api/src/services/automations/binding-router.ts:80-98, apps/api/src/services/automations/runner.ts:372-381)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V15_

matchAndEnroll (trigger-matcher.ts:299-302) selects `{ entrypoint: automationEntrypoints, automation: automations }`, pulling every column of `automations` — including the `graph` JSONB (the full node/edge flow), `template_config`, and `validation_errors` (schema.ts:2565-2577) — and the join duplicates that payload once per candidate entrypoint row. This runs on every inbound DM/comment/story event that reaches automation dispatch (inbox-event-processor.ts:798 → matchAndEnrollOrBinding → matchAndEnroll), yet the only automation field the matcher reads is `id` (lines 416, 490-491); `status`/`organizationId` are needed only in the WHERE clause. The graph is dead weight here because enrollContact independently re-fetches the full automation row before creating the run (runner.ts:372-381). binding-router.ts findBinding (lines 80-98) has the identical pattern. Cost is wasted transfer and JSONB parse on an existing round trip rather than additional round trips, so real impact is a few ms per event unless graphs are large and entrypoints numerous — hence low, not medium.

**Suggested fix:** Narrow the joined projection to the columns actually consumed: in trigger-matcher.ts change the select to `{ entrypoint: automationEntrypoints, automation: { id: automations.id } }` (status and organizationId stay in the WHERE clause only), and apply the same `{ id: automations.id }` projection in binding-router.ts findBinding. No call-site changes needed beyond `row.automation.id` already in use.

---

### [LOW] (filed medium) GET /v1/analytics/content-decay ignores its documented days param and fetches all snapshots for a target with no window or LIMIT

- **File:** apps/api/src/routes/analytics.ts:600, apps/api/src/routes/analytics.ts:640-644 (schema: apps/api/src/schemas/analytics.ts:32-41)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V23_

ContentDecayQuery (apps/api/src/schemas/analytics.ts:32-41) defines a days param (1-90, default 30) that is documented in the OpenAPI spec, but the handler destructures only post_id (analytics.ts:600) and never uses it: the snapshot query (analytics.ts:640-644) selects every postAnalytics row for the target with no collected_at window and no LIMIT. The performance cost is modest in the current tree: the lone insert site is the analytics-refresh cron (services/analytics-refresh.ts:342), whose decaying schedule (analytics-refresh.ts:65-78) stops collecting 14 days after publish, capping lifetime snapshots at roughly 58 rows per target, and the query is fully covered by post_analytics_target_collected_idx (packages/db/src/schema.ts:636-639). The real defect is contract correctness — clients passing days=7 get identical output to days=90 — plus the response maps snapshot index to "day" regardless of actual collection cadence, so half_life_days is computed from snapshot count rather than elapsed days.

**Suggested fix:** In the getContentDecay handler, destructure days from c.req.valid("query"); add publishedAt to the target select at analytics.ts:622-626; then constrain the snapshot query with lte(postAnalytics.collectedAt, new Date((target.publishedAt ?? new Date(0)).getTime() + days * 86400_000)) and a defensive .limit(500). Default days=30 exceeds the 14-day collection horizon, so default responses are byte-identical; smaller days values start honoring the already-documented contract.

---

### [LOW] (filed medium) GET /v1/analytics/post-timeline fetches all snapshots full-width with no date bound and ignores its documented from_date/to_date params

- **File:** apps/api/src/routes/analytics.ts:679-748 (snapshot fetch at 706-709; query destructuring at 681); apps/api/src/schemas/analytics.ts:43-47
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V24_

The getPostTimeline handler (apps/api/src/routes/analytics.ts:679) runs `db.select().from(postAnalytics).where(inArray(postTargetId, targetIds))` (lines 706-709) with no column projection, no collected_at bound, and no LIMIT, then aggregates per-day in Worker memory (lines 712-741). PostTimelineQuery (apps/api/src/schemas/analytics.ts:43-47) documents optional `from_date`/`to_date` params, but the handler destructures only `post_id` (line 681), so clients passing date bounds silently get the full unfiltered timeline — a functional gap on top of the perf cost. Severity is capped, though: post_analytics rows are slim (id, target id, platform, 8 integers, collected_at — no jsonb; packages/db/src/schema.ts:613-641), and the only writer is the decaying refresh schedule (apps/api/src/services/analytics-refresh.ts:65-78) which stops at 14 days post-publish, bounding snapshots to roughly 58 per target (~1,200 rows for a 21-target post). The existing `post_analytics_target_collected_idx` (post_target_id, collected_at) composite index already serves both the current scan and a date-bounded variant, so the practical cost is one already-required DB round trip plus a modest row payload — low severity in this deployment.

**Suggested fix:** In the getPostTimeline handler: (1) destructure `from_date`/`to_date` from `c.req.valid("query")` and add `gte(postAnalytics.collectedAt, new Date(from_date))` / `lte(...)` conditions when present, honoring the already-documented contract; (2) replace the bare `db.select()` with a projection of only the seven columns used (collectedAt, impressions, likes, comments, shares, clicks, views). Optionally push the per-day aggregation into SQL (`date_trunc('day', collected_at)` + SUM ... GROUP BY) to return ~tens of rows instead of all snapshots; the (post_target_id, collected_at) index covers it.

---

### [LOW] (filed medium) GET /v1/analytics/platform/overview serializes KV cache check after account fetch/decrypt, but the DB fetch is required authorization

- **File:** apps/api/src/routes/analytics.ts:1222 (account fetch + eager decrypt), apps/api/src/routes/analytics.ts:975 (decrypt in getAccountWithToken), apps/api/src/routes/analytics.ts:993-1008 (KV check in getCachedPlatformOverview)
- **Verdict:** partial  |  **Breaking fix:** no  |  _V25_
- **Scope correction:** The ordering is real, but the implied cost is wrong: the account DB fetch (~100ms, the dominant cost) is the authorization check (org ownership, workspace scope, analytics scopes) and must run on every request because the KV cache key is not org-scoped — skipping it on cache hits would be a cross-tenant data leak. The genuinely avoidable costs are only the sub-millisecond AES-GCM decrypt (key import is memoized per isolate) and the ~1ms warm KV read that could overlap the DB query, so cache hits waste ~1-2ms, not a serialized DB round trip.

In GET /v1/analytics/platform/overview, getAccountWithToken (analytics.ts:1222) runs a DB select and eagerly AES-GCM-decrypts the access token (analytics.ts:975) before getCachedPlatformOverview checks KV (analytics.ts:995), so the decrypt and the KV round trip are strictly serialized after the ~85-120ms DB call even when the 300s overview cache hits. However, the account DB fetch cannot be moved after or skipped on a cache hit: the cache key `analytics:overview:{accountId}:{from}:{to}` (analytics.ts:993) is not org-scoped, and the DB row is what enforces org ownership, workspace scope (analytics.ts:1230), token presence, and analytics-scope checks — returning cached data before those checks would leak analytics across tenants. The decrypt itself is sub-millisecond (memoized CryptoKey import in apps/api/src/lib/crypto.ts:19-34), so the realizable saving is only overlapping the ~1ms warm (tens of ms cold) KV read with the DB query and skipping the decrypt on hits — roughly 1-2ms warm, not a DB round trip.

**Suggested fix:** In the getPlatformOverview handler, start the KV read concurrently with the account fetch — the cache key needs only query.account_id and the date range: kick off `const cachedPromise = c.env.KV.get(cacheKey, "json")` alongside the DB select, await the DB row, run all existing auth checks, then `await cachedPromise` and return it if present. Move `maybeDecrypt` into the cache-miss branch (e.g. have getCachedPlatformOverview accept the encrypted token plus encryptionKey and decrypt only before calling fetcher.getOverview). Keep every ownership/scope check on the DB row before any cached value is returned.

---

### [LOW] (filed medium) ad-service creates its own postgres clients per call instead of reusing the request-scoped db, duplicating clients and bypassing perf instrumentation

- **File:** apps/api/src/services/ad-service.ts:195, apps/api/src/services/ad-service.ts:380, apps/api/src/services/ad-service.ts:451, apps/api/src/services/ad-service.ts:597, apps/api/src/services/ad-service.ts:772, apps/api/src/services/ad-service.ts:824, apps/api/src/services/ad-service.ts:861 (callers: apps/api/src/routes/ads.ts:132,239,479,533,580,634,1257,1294; apps/api/src/routes/connect.ts:1034,2012)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V31_

Every exported function in apps/api/src/services/ad-service.ts (discoverAdAccounts, createCampaign, createAd, boostPost, updateAd, cancelAd, updateCampaignStatus) calls createDb(env.HYPERDRIVE.connectionString) internally, even though its request-path callers in routes/ads.ts and routes/connect.ts run behind dbContextMiddleware (app.ts:149) and already hold a request-scoped client in c.get("db") — ads.ts handlers use c.get("db") for their own queries, so these requests allocate a second postgres.js client per call. The latency cost is small: postgres.js connects lazily to the local Hyperdrive proxy (single-digit ms, not the ~100ms origin RTT), and every one of these functions also makes external ad-platform calls (100ms–10s) that dominate. The more concrete cost is that queries issued by service-created clients bypass the onQuery Server-Timing instrumentation wired in middleware/db-context.ts, so the new PERF_LOGS query counts undercount the ads/connect paths. Queue consumers (queues/ads.ts:27,31) call createAd/boostPost outside any Hono context, so an env-based fallback is still required.

**Suggested fix:** Add an optional db parameter to the ad-service exports, e.g. function signature (env: Env, orgId: string, params: ..., db: Database = createDb(env.HYPERDRIVE.connectionString)) or an explicit { db?: Database } option, and pass c.get("db") from routes/ads.ts and routes/connect.ts; queue consumers keep the createDb fallback. This restores one client per request and brings ad-service queries under the db-context perf instrumentation.

---

### [LOW] (filed high) Inbox FB/IG reply blocks response on serial outbound-mid dedup KV writes instead of deferring via waitUntil

- **File:** apps/api/src/routes/inbox-feed.ts:779-783
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V38_

In POST /v1/inbox/conversations/{id}/messages, the Facebook/Instagram branch loops over sentMids and serially awaits c.env.KV.put(`outbound-mid:${mid}`) for each (inbox-feed.ts:781-782) before returning the 200 response, while the realtime notification on the very next line (785) is correctly deferred via waitUntil. A text-only reply blocks on 1 KV write (~10-50ms); attachment replies block on N+2 serial writes since the attachments array has no .max() bound in SendMessageBody (apps/api/src/schemas/inbox.ts:101-109) and lastMessageId is double-pushed (lines 721/741 and again at 777), producing one duplicate write. Deferring these puts is safe: the outbound message row is already awaited into the DB before the loop (insertMessage, lines 767-776), and the webhook echo handler falls back to strongly-consistent DB mid checks when the KV key is absent (platform-webhooks.ts:426-434 and 469-477); KV is eventually consistent cross-colo anyway, so the DB layer is the real dedup guarantee. Net blocking cost is tens of ms on a handler dominated by serial Graph API sends (100ms-1s each), so the filed high severity is overstated.

**Suggested fix:** Replace the serial loop at inbox-feed.ts:781-783 with a deferred parallel write: c.executionCtx.waitUntil(Promise.all(sentMids.map((m) => c.env.KV.put(`outbound-mid:${m}`, "1", { expirationTtl: 300 })))). Optionally drop the duplicate sentMids.push(lastMessageId) at line 777 when the mid was already pushed in the attachment/text branches (dedupe via new Set(sentMids)).

---

### [LOW] (filed medium) First-inbound-on-channel welcome signal uses COUNT(*) over contact's full per-channel message history where an EXISTS probe suffices

- **File:** apps/api/src/services/inbox-event-processor.ts:382-406 (consumed at :555)
- **Verdict:** partial  |  **Breaking fix:** no  |  _V39_
- **Scope correction:** The claim double-counts: it describes two COUNT(*) computations ("first-inbound-on-channel check" and "the welcome-message signal also computes COUNT(*)"), but the current tree has exactly one — the pre-insert query in inbox-event-processor.ts serving both purposes. The binding-router's isFirstInboundOnChannel already uses an EXISTS-equivalent SELECT ... LIMIT 1 and is short-circuited by the eventHint on the webhook path. Severity also regraded medium→low: the blocking DB round trip (~85-120ms) remains regardless of COUNT vs EXISTS; only the linear server-side scan is avoidable, and this runs in the inbox queue consumer, not a latency-sensitive API route.

On every inbound DM with a linked contact, processInboxEvent runs a pre-insert query (apps/api/src/services/inbox-event-processor.ts:382-406) that computes COUNT(*) over inbox_messages joined to inbox_conversations for the contact's entire inbound history on that channel, but the only consumer is the boolean test preInsertInboundCount === 0 at line 555 — so an EXISTS/LIMIT 1 probe is sufficient. Because direction is not in any inbox_messages index (packages/db/src/schema.ts: inbox_msg_conv_created_idx covers conversationId+createdAt only), the aggregate visits every message row in the contact's conversations, so server-side cost grows linearly with contact history; the ~85-120ms round trip itself is incurred either way, capping the realistic saving at the scan portion (meaningful only for high-volume contacts on this queue-consumer path, not a user-facing route). There is only one such query: the welcome-message signal and the first-inbound-on-channel check are the same value, threaded as is_first_inbound_on_channel into the binding router, whose own DB fallback (apps/api/src/services/automations/binding-router.ts:49-65) already uses a .limit(1) existence probe and is bypassed entirely by the event hint at line 44 on this path.

**Suggested fix:** In apps/api/src/services/inbox-event-processor.ts:382-406, replace the COUNT(*) aggregate with an existence probe: select a constant (e.g. { one: sql`1` }) with the same join/where and .limit(1), then track a boolean hadPriorInboundOnChannel = rows.length > 0 instead of preInsertInboundCount, and set isFirstInboundOnChannel = event.type === "message" && hadPriorInboundOnChannel === false (preserving the null/skip semantics when contactId is absent). Optionally add direction to the inbox_messages index (conversationId, direction, createdAt) if heavy-history contacts remain slow.

---

### [LOW] (filed medium) Inbox backfill writes comments one-by-one (2-7 serial DB round trips each), but the backfill queue path has no producer and is currently unreachable

- **File:** apps/api/src/services/inbox-backfill.ts:118-204 (Facebook per-comment loop; same pattern at 255-346, 418-487, 592-623); apps/api/src/services/inbox-persistence.ts:97-229; apps/api/src/services/inbox-event-processor.ts:299-303; apps/api/src/routes/connect.ts:963
- **Verdict:** partial  |  **Breaking fix:** no  |  _V40_
- **Scope correction:** The "account-connect" trigger does not exist: grep shows no producer anywhere enqueues type:"backfill" -- only the type-union member (platform-webhooks.ts:41), the consumer dispatch (inbox-event-processor.ts:299), and the service file reference it. The serial-query pattern is exactly as described, but the path is unreachable dead code, so current real-world cost is zero (hence severity low, not medium). It becomes high the moment a producer is wired up.

processBackfill (apps/api/src/services/inbox-backfill.ts:22) walks up to 25 posts x 2 pages x 50 comments and, per comment, serially awaits upsertConversation then insertMessage (e.g. lines 168-204 for Facebook). Each comment costs 2-7 DB round trips: the conversation upsert plus 1-4 serial contact-linker lookups and an optional auto-link UPDATE (inbox-persistence.ts:103-165, contact-linker.ts:31-103), then the message insert plus a conversation-counter UPDATE (inbox-persistence.ts:180-226) -- up to ~17,500 serial queries (~100ms each) inside one queue message, far past consumer wall-clock limits. The conversation upsert is also redundantly repeated for every comment even though all comments on a post share one conversation row. However, no code in the tree ever enqueues a type:"backfill" message: connect.ts only sends youtube_subscribe (line 963) and platform-webhooks.ts only sends *_webhook/pubsub event types, so the path is dead code and account connect does not trigger it today.

**Suggested fix:** Before wiring any producer for type:"backfill", restructure the per-page write path: (1) hoist upsertConversation out of the comment loop -- one upsert per post/media/video, since all comments under a post share platformConversationId; (2) replace per-comment insertMessage with one multi-row INSERT ... ON CONFLICT DO NOTHING per page (50 rows) plus a single conversation UPDATE setting messageCount/lastMessage* from the batch; (3) skip or memoize findMatchingContact per participant during backfill. If the feature stays unimplemented, delete inbox-backfill.ts and the dispatch at inbox-event-processor.ts:299-303 instead.

---

### [LOW] (filed medium) Contact matching duplicated for new inbound authors with sequential org-scan SELECTs; contacts.phone/name unindexed

- **File:** apps/api/src/services/contact-linker.ts:31-103; apps/api/src/services/inbox-persistence.ts:145; apps/api/src/services/inbox-event-processor.ts:707; packages/db/src/schema.ts:1426-1443
- **Verdict:** partial  |  **Breaking fix:** no  |  _V43_
- **Scope correction:** Three overstatements: (1) max is 3 SELECTs per invocation, not 4 — the email branch never executes because neither call site passes participantMetadata; (2) matching runs twice only for the first message(s) from a not-yet-linked participant on the 4 automation channels — upsertConversation skips matching once conversation.contactId is set (inbox-persistence.ts:143) and ensureContactForAuthor is gated by AUTOMATION_CHANNELS (inbox-event-processor.ts:694), so steady state is one indexed SELECT plus one redundant channel-link SELECT; (3) the lookups are not unindexed — contacts_org_idx covers the organization_id predicate on every query (and email has a workspace-scoped unique index), so these are org-scoped index scans that only degrade for very large per-org contact counts. The path is also queue-consumer-only, not request-path latency, warranting a downgrade from medium to low.

findMatchingContact (contact-linker.ts:31-103) issues up to 3 sequentially awaited SELECTs (exact channel, phone, ILIKE name; the email branch is dead because no caller supplies participantMetadata), and for the first inbound message from an unlinked participant on an automation channel (instagram/facebook/whatsapp/telegram) the full miss chain runs twice: once in upsertConversation's auto-link (inbox-persistence.ts:145) and again inside ensureContactForAuthor (inbox-event-processor.ts:707 -> contact-linker.ts:129), with no result sharing, plus a redundant ensureChannelLink existence SELECT even on exact matches (contact-linker.ts:192-199). contacts.phone and contacts.name have no index (schema.ts:1426-1443) and the email lookup filters by organization_id so the (workspace_id, email) unique index is unusable, though every query is still served by contacts_org_idx as an org-scoped scan rather than a full-table scan. All of this runs only in the inbox queue consumer (queues/inbox.ts:24; max_concurrency 5, max_batch_size 10), so the ~6-9 sequential DB round trips (~0.6-1s at ~85-120ms RTT) per new-contact message cost background queue throughput and automation reply latency, not API request latency; steady state for already-linked contacts is 2 indexed queries.

**Suggested fix:** In processInboxEvent, pass conversation.contactId (when set) into dispatchAutomationMatch and let ensureContactForAuthor accept a pre-resolved contactId to skip re-matching; have ensureContactForAuthor backfill inboxConversations.contactId when it creates a contact so the next message's upsert skips matching too. In ensureContactForAuthor, skip ensureChannelLink when confidence === "exact". Optionally run the phone/name fallback SELECTs via Promise.all after an exact-channel miss, and add index("contacts_org_phone_idx").on(organizationId, phone) in packages/db/src/schema.ts for large orgs.

---

### [LOW] (filed medium) Meta webhook background processing serializes 4-5 dedup round trips per DM plus a redundant per-entry socialAccounts lookup

- **File:** apps/api/src/routes/platform-webhooks.ts:320-328, apps/api/src/routes/platform-webhooks.ts:461-509, apps/api/src/routes/platform-webhooks.ts:228
- **Verdict:** partial  |  **Breaking fix:** no  |  _V47_
- **Scope correction:** Two sub-claims are wrong: (1) the DB mid match is not unindexed — inbox_msg_platform_message_id_idx exists on inbox_messages.platform_message_id (schema.ts:1130, migration 0011), and the separate layer-4 text-equality join is index-assisted via inbox_conv_account_idx and inbox_msg_conv_created_idx with a 15s window; (2) all of this runs in ctx.waitUntil after the response is sent, so the serialized round trips cost background processing time only, not request latency — warranting low rather than medium severity.

processFacebookWebhook runs a per-entry DB select on socialAccounts for platformAccountId/webhookAccountId (platform-webhooks.ts:320-328) on every webhook entry — even when resolveAccount served the account from KV and even when the entry has no messaging events — plus a KV read for the cached IGSID (line 333). For every non-echo DM it then awaits a fully serialized dedup chain: KV outbound-mid get (line 463), DB mid-equality select (lines 469-473), DB recent-outbound text-match join (lines 484-499), KV msg-dedup get and put (lines 508-509), i.e. up to 2 DB round trips (~85-120ms each) and 3 KV ops back-to-back per message; the echo path (lines 417-438) similarly chains KV + DB + KV. However, the mid lookup is indexed (inbox_msg_platform_message_id_idx, packages/db/src/schema.ts:1130, created in drizzle/0011), the layer-4 join is bounded by inbox_conv_account_idx plus the (conversation_id, created_at) index with a 15-second window and LIMIT 1, and the entire function runs inside ctx.waitUntil after the 200 is returned to Meta (lines 228-230) — so the cost is ~200-300ms of background wall time delaying INBOX_QUEUE enqueue per DM, not webhook or API response latency.

**Suggested fix:** 1) Extend resolveAccount's KV-cached AccountLookup to also store platformAccountId and webhookAccountId, deleting the per-entry DB select at lines 320-328, and skip the IGSID KV read plus ID-set construction when entry.messaging is empty. 2) In the DM dedup chain, issue the independent probes concurrently — Promise.all([KV outbound-mid, KV msg-dedup, DB query]) — and merge layers 3 and 4 into a single DB query (platform_message_id = mid OR the 15s outbound-text match), reducing the chain to one DB round trip and one KV write per message.

---

### [LOW] (filed medium) Platform-webhook account resolution caches only positive lookups — unknown-account events query Postgres every time

- **File:** apps/api/src/routes/platform-webhooks.ts:92-157 (no negative caching at :149; positive-only KV writes at :140 and :155; repeated-miss call sites at :258, :607, :726, :829, :918-920)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V48_

resolveAccount in apps/api/src/routes/platform-webhooks.ts writes to KV only on successful lookups (lines 140 and 155, TTL 300s) and returns null at line 149 with no negative-cache entry, so every webhook event whose platform account ID is not in social_accounts performs a fresh Postgres query — two queries for Instagram, which falls through to the webhookAccountId lookup at lines 121-133, a path the code itself logs as recurring ("could not be resolved safely", line 144). This is a real but background-only cost: all POST handlers verify HMAC/secret before processing and the lookups run inside ctx.waitUntil (lines 228, 584, 680, 800, 898), so unknown-account events add ~85-240ms of Postgres round trips and Hyperdrive connections per event but never block webhook responses; disconnected-but-still-subscribed Meta accounts make this a continuous drip rather than an attacker-amplifiable flood. A side effect of the same gap: the SMS handler (lines 918-920) tries resolveAccount("sms", "+<number>") before the normalized form, and since the "+"-variant miss is never cached, every inbound SMS for a connected account pays one wasted DB query forever. Severity re-graded medium → low because the work is deferred, queries are point lookups, and endpoints are signature-gated.

**Suggested fix:** Cache negative lookups with a short TTL and a sentinel value in resolveAccount: read with `const raw = await env.KV.get(kvKey); if (raw === "miss") return null; if (raw) return JSON.parse(raw);` and at the `if (!account)` branch (line 149) add `await env.KV.put(kvKey, "miss", { expirationTtl: 60 })` before returning null. Keep the negative TTL short (60s) so newly connected accounts start resolving quickly, or delete the `platform-account:*` KV key on account connect/update. Optionally swap the SMS lookup order at lines 918-920 (normalized number first) to eliminate the guaranteed miss on every inbound SMS.

---

### [LOW] (filed medium) YouTube PubSubHubbub daily renewal issues one serial unbounded external POST per social_accounts row

- **File:** apps/api/src/services/webhook-subscription.ts:326-348 (caller: apps/api/src/scheduled/index.ts:53)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V51_

renewYouTubePubSubSubscriptions (apps/api/src/services/webhook-subscription.ts:322) selects every social_accounts row with platform="youtube" with no LIMIT or DISTINCT, then loops `for (const account of youtubeAccounts)` awaiting one fetch POST to pubsubhubbub.appspot.com per row (lines 336-341) — strictly serial, no Promise.all, no concurrency cap, and duplicate channel IDs (same channel in multiple workspaces) are re-subscribed once per row. It runs in the daily 9am cron under ctx.waitUntil (scheduled/index.ts:53), so it never blocks user requests; the cost is scalability: at 100ms-10s per external hub call, a few hundred accounts already takes minutes, and Workers' scheduled-handler limits (~15 min wall time, 1000 subrequests/invocation) would silently truncate renewals at scale, letting 10-day leases lapse and YouTube webhooks go dark. Severity downgraded from medium to low because it is background work with no user-facing latency and only bites at account counts well above current scale.

**Suggested fix:** In renewYouTubePubSubSubscriptions, dedupe channel IDs (use db.selectDistinct on platformAccountId, or a Set) and replace the serial loop with chunked parallelism, e.g. process the deduped list in slices of 10 via Promise.allSettled(slice.map(id => subscribeYouTubeChannel(id, callbackUrl))), logging failures per result. Optionally log a warning when the account count approaches the 1000-subrequest budget.

---

### [LOW] (filed medium) POST /v1/webhooks/test calls user-supplied URL with bare fetch and no timeout, unlike the 5s-capped delivery path

- **File:** apps/api/src/routes/webhooks.ts:474
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V52_

The testWebhook handler (apps/api/src/routes/webhooks.ts:435-516) awaits a bare `fetch(webhook.url, { method: "POST", redirect: "error", ... })` at line 474 with no AbortSignal, so a slow or hanging customer endpoint holds the Worker invocation open until Cloudflare's outbound fetch limit terminates it (potentially ~100s). The codebase already has `fetchWithTimeout` in apps/api/src/lib/fetch-timeout.ts, and the real delivery path in apps/api/src/services/webhook-delivery.ts:87-92 uses it with `timeout: 5_000`, so the test endpoint is inconsistently unbounded. Impact is contained: this is a low-traffic, user-triggered diagnostic endpoint that blocks only the caller's own request (SSRF is already mitigated at line 462 via isBlockedUrlWithDns), and the subsequent webhookLogs insert just records an inflated response_time_ms — hence low rather than medium severity.

**Suggested fix:** In apps/api/src/routes/webhooks.ts, import fetchWithTimeout from "../lib/fetch-timeout" and replace the bare fetch at line 474 with `fetchWithTimeout(webhook.url, { ..., timeout: 5_000 })`, matching webhook-delivery.ts. The existing catch block already maps an abort to success=false / statusCode=null, identical to today's connection-failure response shape.

---

### [LOW] (filed medium) POST /v1/posts/{id}/retry blocks on an awaited usage-counter KV read+write whose result is unused

- **File:** apps/api/src/routes/posts.ts:2037-2039 (incrementUsage defined at apps/api/src/middleware/usage-tracking.ts:15-35)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V56_

The retry handler calls `await incrementUsage(c.env.KV, orgId, failedTargets.length)` at apps/api/src/routes/posts.ts:2038, which sequentially awaits a KV get then a KV put (usage-tracking.ts:25-32), blocking the request for roughly 1ms (warm read) plus tens of ms for the put acknowledgment before the retry proceeds. The returned count is discarded and nothing downstream gates on it, so the await buys no correctness — the equivalent counter in usageTrackingMiddleware was already refactored to defer its KV put via waitUntil (usage-tracking.ts:249-253), and the same non-atomicity tradeoff is already documented there. Severity is low rather than medium because the handler then synchronously awaits publishToTargets (posts.ts:2109), which makes external platform calls costing 100ms-10s+, plus four DB round trips at ~85-120ms each, so the KV latency is a small fraction of total endpoint time.

**Suggested fix:** In the retry handler, replace `await incrementUsage(c.env.KV, orgId, failedTargets.length);` with `c.executionCtx.waitUntil(incrementUsage(c.env.KV, orgId, failedTargets.length));` — the return value is unused and the KV counter's get+put was never atomic anyway (the DB usageRecords counter remains billing's source of truth).

---

### [LOW] (filed medium) Public /avatars/:id route hits R2 on every request — no edge cache (Cache API) and only 1h browser TTL

- **File:** apps/api/src/routes/avatars.ts:13, apps/api/src/routes/avatars.ts:25
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V59_

The unauthenticated GET /avatars/:id handler (apps/api/src/routes/avatars.ts:9-29) performs MEDIA_BUCKET.get() on line 13 for every incoming request; there is no caches.default usage anywhere in apps/api/src, and on Workers a Cache-Control header alone never populates Cloudflare's edge cache, so every cold-client request pays a full Worker invocation plus an R2 GET (Class B op, ~10-50ms). The only mitigation is per-browser: Cache-Control: public, max-age=3600 (line 25) with ETag/If-None-Match 304 handling (lines 16-20) — and even the 304 path performs the R2 GET first instead of using R2's onlyIf conditional. Avatars are written once under a stable key by rehostAvatar (apps/api/src/services/avatar-store.ts:46) and rarely change, so they are ideal edge-cache candidates; dashboard inbox/account views reference many avatars per page, multiplying the cost. Graded low rather than medium: avatar loads are non-blocking img fetches off the API critical path, cheaper than a DB round trip, and partially absorbed by the 1h browser cache — the cost is mainly R2 op volume and image latency for cold clients.

**Suggested fix:** In the /avatars/:id handler, check caches.default.match(c.req.raw) first and return on hit; on miss, build the response as today, then c.executionCtx.waitUntil(caches.default.put(c.req.raw, response.clone())) before returning. Optionally raise Cache-Control to max-age=86400 and pass onlyIf: { etagDoesNotMatch: ifNoneMatch } to MEDIA_BUCKET.get() so R2 handles conditional 304s without fetching the body.

---

### [LOW] (filed medium) Idea group reorder and delete issue one UPDATE per row instead of a single set-based statement

- **File:** apps/api/src/routes/idea-groups.ts:334-345, apps/api/src/routes/idea-groups.ts:384-393
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V63_

POST /v1/idea-groups/reorder (apps/api/src/routes/idea-groups.ts:384-393) issues one UPDATE per group in the request body, and DELETE /v1/idea-groups/{id} (lines 328-345) first selects every idea in the group and then issues one UPDATE per idea to move it to the default group with a recomputed position. Both loops run under Promise.all and the postgres.js client is created with max: 5 (packages/db/src/client.ts:24), so wall-clock cost is ~ceil(N/5) DB round trips at ~85-120ms each rather than N — e.g. deleting a group containing 100 ideas costs ~20 sequential waves (~2s). N is unbounded on both paths: ReorderIdeaGroupsBody.groups has .min(1) but no .max(), and a deleted group can contain any number of ideas. Neither path runs in a transaction, so a partial failure leaves positions half-updated. Severity is low because both are infrequent, user-initiated actions and reorder N (kanban columns) is typically under 10.

**Suggested fix:** Collapse each loop into one set-based statement. Reorder: a single UPDATE joined to a VALUES list — UPDATE idea_groups g SET position = v.position, updated_at = now() FROM (VALUES ...) v(id, position) WHERE g.id = v.id AND g.organization_id = $org — via a drizzle sql`` template; also add .max(100) to ReorderIdeaGroupsBody.groups. Delete: replace the ideasToMove select + per-idea updates with one statement using a window function — WITH ranked AS (SELECT id, row_number() OVER (ORDER BY position) rn FROM ideas WHERE group_id = $deletedGroup) UPDATE ideas SET group_id = $defaultGroup, position = $maxPos + ranked.rn, updated_at = now() FROM ranked WHERE ideas.id = ranked.id.

---

### [LOW] (filed medium) Deprecated GET /v1/whatsapp/broadcasts returns all broadcasts unbounded (no limit, no cursor) and is still the path used by dashboard and SDK

- **File:** apps/api/src/routes/whatsapp.ts:834-843 (handler at 829); apps/api/src/schemas/whatsapp.ts:90-92, 216-218
- **Verdict:** confirmed  |  **Breaking fix:** yes  |  _V64_

GET /v1/whatsapp/broadcasts (apps/api/src/routes/whatsapp.ts:829-861) executes db.select().from(whatsappBroadcasts) filtered only by organizationId + socialAccountId with orderBy(desc(createdAt)) and no .limit() or cursor; AccountIdQuery (schemas/whatsapp.ts:216-218) accepts only account_id and BroadcastListResponse (90-92) is a bare data array with no next_cursor/has_more. The route is marked deprecated in favor of GET /v1/broadcasts, which already implements keyset pagination (routes/broadcasts.ts:374-414), yet the deprecated path remains the one called by the dashboard (apps/app/src/components/dashboard/pages/whatsapp-page.tsx:90) and the SDK (packages/sdk/src/resources/whatsapp/broadcasts.ts:28). Cost today is one indexed DB round trip (~100ms via wa_broadcasts_org_idx) with payload and serialization growing linearly forever as campaigns accumulate; broadcasts are low-cardinality user-created entities, so this is a slow-growth footgun rather than a hot-path cost, hence low rather than medium severity.

**Suggested fix:** Mirror the canonical route: add optional limit (default 50, max 100) and cursor to AccountIdQuery, apply .limit(limit + 1) with the same (createdAt, id) keyset predicate used in routes/broadcasts.ts:386-404, and add next_cursor/has_more to BroadcastListResponse (additive fields). Update packages/sdk/src/resources/whatsapp/broadcasts.ts list params to match. Alternatively, migrate the dashboard's whatsapp-page.tsx to GET /v1/broadcasts and hard-cap the deprecated route. Marked breaking because imposing a default limit truncates previously-complete responses for clients with more rows than the cap.

---

### [LOW] (filed medium) GET /v1/usage/logs runs an org-scoped COUNT over api_request_logs (no retention) on every page view

- **File:** apps/api/src/routes/usage.ts:201-205 (count query); apps/api/src/middleware/usage-tracking.ts:147 (one row per API call); packages/db/src/schema.ts:694-699 (covering index)
- **Verdict:** partial  |  **Breaking fix:** no  |  _V65_
- **Scope correction:** Two material inaccuracies: the endpoint is GET /v1/usage/logs, not /v1/usage/requests; and the COUNT is not an unscoped scan of the whole unbounded table — it is filtered to the caller's organization_id, fully covered by the (organization_id, created_at) composite index, and parallelized with the page query via Promise.all, so it adds no extra serial DB round trip. The genuinely confirmed parts are the per-page count execution and the total absence of retention on a one-row-per-API-call table.

GET /v1/usage/logs (apps/api/src/routes/usage.ts:201-205) executes a count() over api_request_logs on every page request to populate the required `total` field in the paginated response (usage.ts:168, 224). The table receives one row per authenticated /v1/* call via the usage-tracking middleware (apps/api/src/middleware/usage-tracking.ts:147) and no retention or pruning job exists anywhere in the codebase, so the count cost grows without bound over time. The cost is smaller than a naive full-table COUNT, though: the query is scoped to organization_id (plus optional from/to), is covered by the composite index api_request_logs_org_created_idx on (organization_id, created_at) (packages/db/src/schema.ts:694-699), and runs in Promise.all with the page query (usage.ts:194), so it adds no serial DB round trip today. It only becomes a latency problem for high-volume orgs that accumulate hundreds of thousands to millions of log rows; the unbounded table growth itself is the more durable issue.

**Suggested fix:** Add a retention cron in apps/api/src/scheduled/index.ts that deletes api_request_logs rows older than a fixed horizon (e.g. 90 days), bounding both table growth and the per-request count cost without changing the response contract. Optionally also default the count's `from` bound to the retention horizon so the index range scan stays capped.

---

### [LOW] (filed medium) OAuth callback flow allocates up to three separate postgres clients instead of reusing the request-scoped instance

- **File:** apps/api/src/routes/connect.ts:873; apps/api/src/routes/connections.ts:41; apps/api/src/lib/request-db.ts:11-14; apps/api/src/middleware/db-context.ts:29
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V67_

The authenticated POST /v1/connect/{platform}/complete flow constructs three separate postgres-js clients per request: dbContextMiddleware sets one via getRequestDb (app.ts:149, and lib/request-db.ts calls createDb fresh every time with no memoization), exchangeAndSaveAccount ignores it and calls createDb again (connect.ts:873), and logConnectionEvent creates a third (connections.ts:41); a fourth appears in auth middleware on a KV cache miss (auth.ts:53). The GET /connect/oauth/callback redirect path creates two (it mounts before dbContextMiddleware). This contradicts db-context.ts's own stated contract that downstream code should reuse c.get("db"). Real-world cost is modest: postgres-js connects lazily to Hyperdrive's edge pooler (handshake is a few ms, not an origin round trip), prepared-statement caching lives in Hyperdrive, and the callback is a rare user-interactive flow dominated by external platform calls (token exchange, profile fetch, avatar rehost: 100ms-10s+), so severity is low rather than the filed medium.

**Suggested fix:** Thread the existing client through instead of re-creating it: add a `db: Database` parameter to exchangeAndSaveAccount and logConnectionEvent; pass `c.get("db")` from the completeOAuth handler and create a single client in oauth-callback.ts's GET handler to pass down. Optionally memoize getRequestDb per-request (e.g. WeakMap keyed on the request/env) so auth-middleware cache-miss hydration shares the same client, and defer the logConnectionEvent insert via c.executionCtx.waitUntil so it no longer blocks the callback redirect.

---

### [LOW] (filed medium) Cron tasks each open a separate postgres client per scheduled event instead of sharing one

- **File:** apps/api/src/scheduled/index.ts:34-74; packages/db/src/client.ts:18-32; apps/api/src/services/notification-manager.ts:81
- **Verdict:** partial  |  **Breaking fix:** no  |  _V71_
- **Scope correction:** The "7-15 clients per scheduled event" count was only true before the cron-gating fix, when every block ran on all six triggers; in the current tree the maximum is 6 top-level clients on the */1 event (one task is a no-op), 5 on */5, fewer elsewhere. The implied cost is also overstated: createDb is deliberately per-call (packages/db/src/client.ts:5-16) because Workers cannot reuse sockets across requests and each client connects to Hyperdrive's local proxy in single-digit ms, not an 85-120ms origin round trip, and cron work has no user-facing latency.

Every cron entry point invoked from handleScheduled (apps/api/src/scheduled/index.ts:34-74) constructs its own Drizzle/postgres client via createDb(env.HYPERDRIVE.connectionString) — e.g. services/scheduler.ts:16, recycling-processor.ts:19, broadcast-processor.ts:19, whatsapp-broadcast-processor.ts:40, cross-post-processor.ts:23, automations/scheduler.ts:236 — and nested helpers such as sendNotification (services/notification-manager.ts:81) create yet another client per call; none are ever closed with .end(). After the cron gating fix, the worst single event (the */1 tick) now opens 6 top-level clients (processAutomationInputTimeouts is a no-op stub), and with each client configured max:5 the concurrent waitUntil tasks press against the Workers 6-simultaneous-connection cap and claim redundant Hyperdrive pool slots. The latency cost per client is small by documented design — packages/db/src/client.ts:5-16 notes each client connects to Hyperdrive's local proxy, not the origin DB — and the work is background-only with no user-facing latency, so this is a tidiness/connection-pressure issue rather than a measurable hot-path cost.

**Suggested fix:** In handleScheduled, create one client per event (const db = createDb(env.HYPERDRIVE.connectionString)) and thread it into each cron entry point as a parameter (the helper layers already accept db: ReturnType<typeof createDb>, e.g. broadcast-processor.ts:66, cross-post-processor.ts:177); likewise add an optional db parameter to sendNotification so per-notification client creation in loops (streak.ts:255/286) reuses the caller's client. Keep createDb per-invocation at the route layer per the documented Workers constraint.

---

### [LOW] (filed medium) Short-link click sync issues up to 200 per-row UPDATEs instead of one batched statement

- **File:** apps/api/src/services/short-link-click-sync.ts:86-92
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V74_

syncShortLinkClicks selects up to 200 short links (LIMIT 200 at apps/api/src/services/short-link-click-sync.ts:42) and then writes back click counts with one UPDATE per row inside mapConcurrently(links, 20, ...) at lines 86-92. The requested concurrency of 20 is capped at 5 by the postgres client (max: 5 in packages/db/src/client.ts:24), so a full batch costs roughly 40 sequential DB round trips (~3.5-5s at ~85-120ms each) plus 200 individual statements of origin-DB load every 5 minutes. Mitigating factors: it runs only from the */5 cron via ctx.waitUntil (apps/api/src/scheduled/index.ts:68), so no user request is ever blocked, and the per-link new-count values differ per row, so per-row writes are merely unbatched, not redundant. A single UPDATE ... FROM (VALUES ...) per org group would collapse this to one round trip per org.

**Suggested fix:** In the per-org loop, replace the mapConcurrently per-row updates with one batched raw statement per org: build (id, count) pairs and run `UPDATE short_links AS s SET click_count = v.count, last_click_sync_at = ${now} FROM (VALUES ...) AS v(id, count) WHERE s.id = v.id` via db.execute(sql`...`) (or unnest(${ids}::text[], ${counts}::int[])). One round trip per org instead of up to 200 total.

---

### [LOW] (filed medium) Weekly digest cron fetches all notification_preferences rows and filters opt-ins in JS

- **File:** apps/api/src/services/weekly-digest.ts:25-35
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V77_

processWeeklyDigest (apps/api/src/services/weekly-digest.ts:25-30) selects userId and weeklyDigest from notification_preferences with no WHERE clause, pulling every row platform-wide, then filters in JS (lines 32-35) for users with weekly digest push or email enabled. Since the schema default for weekly_digest is {push:false,email:false} (packages/db/src/schema.ts:970-972), most fetched rows are discarded, so result-set size scales with total users rather than opted-in users. Impact is bounded: the job runs once a week (cron "0 9 * * 1" gated at apps/api/src/scheduled/index.ts:58-61) inside ctx.waitUntil, blocks no user request, selects only two columns, and the downstream membership/stats queries are already batched with inArray and a single GROUP BY. The cost is wasted transfer and Worker memory (128MB cap) that grows linearly with the user base, not latency — hence low rather than medium severity.

**Suggested fix:** Push the opt-in filter into SQL with a jsonb containment predicate: add .where(sql`${notificationPreferences.weeklyDigest} @> '{"push":true}'::jsonb or ${notificationPreferences.weeklyDigest} @> '{"email":true}'::jsonb`) to the initial query and drop the JS filter (keep the wd null guard unnecessary since the column is NOT NULL). Optionally add a partial GIN/expression index on weekly_digest if the table grows large.

---

### [LOW] (filed medium) notifyRealtime wakes the per-org RealtimeDO on every event even with zero connected dashboard clients

- **File:** apps/api/src/lib/notify-post-update.ts:42-48; apps/api/src/durable-objects/post-updates.ts:15-27
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V78_

notifyRealtime (apps/api/src/lib/notify-post-update.ts:42-48) unconditionally resolves the per-org RealtimeDO stub and awaits a stub.fetch("http://internal/notify") round trip for every event; RealtimeDO.fetch (apps/api/src/durable-objects/post-updates.ts:15-27) must be instantiated just to call ctx.getWebSockets() and iterate an empty list when no dashboard WebSocket is connected. There is no presence flag or early-exit, so for API-only customers (the common case in an API-first product) every post create/update/delete, publish completion, broadcast status change, inbox event, streak update, and notification pays a wasted billed DO request plus wake. Impact is bounded: all HTTP-handler call sites defer via c.executionCtx.waitUntil (e.g. apps/api/src/routes/posts.ts:1584-1590, 1990-1992), so no user-facing latency is added; the inline awaits sit in queue consumers and services (apps/api/src/services/publisher-runner.ts:303, broadcast-processor.ts:112/205, inbox-event-processor.ts:615, notification-manager.ts:158/275) where a few-ms DO round trip is negligible next to platform calls. The cost is therefore DO request billing, wake duration, and one subrequest per event rather than measurable latency.

**Suggested fix:** Add a KV presence flag keyed by org: pass the org id to RealtimeDO on the WebSocket upgrade (apps/api/src/routes/websocket.ts:40-43, e.g. an internal header persisted to ctx.storage), have the DO put KV key `realtime-presence:{orgId}` (short TTL, refreshed on the existing ping handler) on accept and delete it in webSocketClose when getWebSockets() is empty. In notifyRealtime, early-return before the stub.fetch when the flag is absent (warm KV read ~1ms vs a DO wake). Accept that KV eventual consistency may drop events in the first seconds after connect — fine for refresh-hint events.

---

### [LOW] (filed medium) Module-scope Zod/OpenAPI route construction (368 createRoute calls, 50 statically imported route modules) evaluated on every cold start — measured ~125-130ms total module eval, ~60ms execution

- **File:** apps/api/src/app.ts:22-77 (static route imports), apps/api/src/app.ts:201-246 (mounts); apps/api/src/index.ts:1-19 (single entry bundling routes + queues + cron + DO)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V79_

apps/api/src/app.ts:22-77 statically imports 50 route modules, and 368 createRoute() calls across 44 route files (whatsapp.ts 27, connect.ts 24, accounts.ts 24, ads.ts 20, posts.ts 18) execute Zod schema + OpenAPI registry construction at module scope, so every fresh isolate (HTTP, queue batch, or cron tick — index.ts bundles all three into one worker) pays this before serving its first event. Quantified against the current tree with minify:true: the wrangler dry-run bundle is 4.4MB minified (1.21MB gzip), the app.ts route graph alone is 4.2MB of it, and Node module evaluation of the built bundle measures ~125-130ms total — CPU profiling attributes ~51ms to V8 source compilation and ~60ms to top-level execution, of which route/Zod construction is only a portion (the openapi registration helper itself samples ~1.5ms; the rest is spread across schema construction and dependency init such as drizzle and hono). This is a one-time per-isolate cost roughly equal to one DB round trip (~85-120ms), not a per-request cost, and cold starts are infrequent here: the every-minute cron trigger and smart placement keep isolates warm at the few locations serving traffic. Well under the 400ms Workers startup-CPU limit; material only to P99 of requests landing on fresh isolates.

**Suggested fix:** No urgent action. If cold-start P99 proves material in PERF_LOGS/wrangler tail data: (1) split queue/cron consumers into a second Worker (same codebase, separate wrangler config + entry without app.ts) so HTTP isolates only evaluate route code and vice versa; (2) optionally gate the /openapi.json doc generation (app.doc) and swaggerUI behind their handlers. Do not attempt to lazy-load individual routers — createRoute objects double as runtime request validators, so they cannot be dropped without replacing validation.

---

### [LOW] (filed medium) PERF_LOGS=1 hardcoded in production wrangler.jsonc keeps per-request instrumentation, SQL logging, and Server-Timing exposure on for every deploy

- **File:** apps/api/wrangler.jsonc:12 (also apps/api/wrangler.jsonc:22-30, apps/api/src/app.ts:95, apps/api/src/lib/perf.ts:109-133, apps/api/src/middleware/db-context.ts:19-27)
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V80_

apps/api/wrangler.jsonc:12 ships "PERF_LOGS": "1" in vars, so every production deploy enables perfLogMiddleware (app.ts:95): one structured console.log per request containing up to 50 SQL-statement prefixes (perf.ts:114-133, fed by the Drizzle logger in db-context.ts:25), plus a Server-Timing response header (perf.ts:109) that exposes internal middleware names, timings, and DB query counts to every API client. Combined with the observability block at wrangler.jsonc:22-30 (head_sampling_rate 1, persist true, invocation_logs true — which pre-dates the audit), 100% of these log lines are ingested and persisted, so Workers Logs volume/billing scales linearly with traffic. The runtime cost is negligible (a few performance.now() calls and one JSON.stringify; the perf DB path allocates a postgres client per request identically to the normal getRequestDb path), so the impact is log cost and minor information disclosure rather than latency. The config comment explicitly marks this as a temporary audit measure to be disabled, but as written it remains permanently on.

**Suggested fix:** Once audit measurements are done, set "PERF_LOGS": "0" or delete the vars entry in apps/api/wrangler.jsonc (re-enable ad hoc via `wrangler deploy --var PERF_LOGS:1` or `wrangler versions secret`/env override when profiling). Optionally lower observability.logs.head_sampling_rate below 1 if Workers Logs billing becomes material.

---

### [LOW] (filed medium) Dashboard bootstrap dedupes only in-flight requests; warm navigations fire 4 redundant background fetches (bootstrap + usage/streak/key-status)

- **File:** apps/app/src/lib/dashboard-bootstrap.ts:11-31; apps/app/src/components/dashboard/sidebar.tsx:346-352; apps/app/src/hooks/use-usage.tsx:116-118; apps/app/src/hooks/use-streak.tsx:119-121; apps/app/src/hooks/use-dashboard-api-key-status.ts:107-109
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V87_

fetchDashboardBootstrap (apps/app/src/lib/dashboard-bootstrap.ts:11-31) memoizes only the in-flight promise — `pending` is cleared in `finally` — so any caller after the first response refires a full /api/dashboard-bootstrap, which costs 1 DB count query plus two downstream API worker calls (usage + streaks, each with auth and DB round trips of ~100ms; see apps/app/src/pages/api/dashboard-bootstrap.ts:27-117). The sidebar always schedules a bootstrap via scheduleIdleTask with a 1500ms timeout (sidebar.tsx:346-352), so on cold loads it produces a second full bootstrap whenever the after-paint bootstrap from the hooks resolves before the idle callback fires (likely when requestIdleCallback is starved to its timeout by the dashboard's canvas animations). On warm-cache navigations (sessionStorage TTL 60s), use-usage.tsx:116-118, use-streak.tsx:119-121, and use-dashboard-api-key-status.ts:107-109 each take their cached branch and fire individual background refreshes to /api/usage, /api/streak, and /api/dashboard-key-status, while the sidebar still fetches the bootstrap that already contains all three values — 4 requests where 1 suffices, on every full-document dashboard navigation. Impact is backend load amplification (~2-4x on these status endpoints) rather than user-visible latency, since all fetches run post-paint/idle and never block rendering.

**Suggested fix:** In dashboard-bootstrap.ts, cache the resolved result with a short TTL (~30-60s, keyed by active org id) and return it to subsequent callers instead of clearing `pending` immediately; add a `force` option for explicit refetches. Then point the warm-cache background refreshes in use-usage.tsx, use-streak.tsx, and use-dashboard-api-key-status.ts at fetchDashboardBootstrap() instead of their individual endpoints, so the sidebar's single bootstrap call serves all four consumers per navigation.

---

### [LOW] (filed medium) Dashboard page views rebuild better-auth instance per request; getCookieCache fast path gated to internal /api/* routes only

- **File:** apps/app/src/middleware/index.ts:329, apps/app/src/middleware/index.ts:337, apps/app/src/middleware/index.ts:280-294; packages/auth/src/index.ts:55-60
- **Verdict:** confirmed  |  **Breaking fix:** no  |  _V88_

In apps/app/src/middleware/index.ts the standalone getCookieCache fast path (line 329) is gated on isInternalApiPath(path), so it only applies to /api/* (non-auth) routes; every /app/* page view falls through to getAuth().api.getSession() (line 337), and because `auth` is a request-scoped `let` with no module-level memoization (lines 261, 280-294), createAuth → betterAuth() with drizzleAdapter plus apiKey/admin/organization plugins is reconstructed on every dashboard navigation. The cost is bounded, however: better-auth's internal session.cookieCache is enabled with a 5-minute maxAge (packages/auth/src/index.ts:55-60), so getSession() on page views does not incur a DB round trip while that cookie is fresh — the wasted work is CPU-only instance construction and the heavier getSession pipeline (roughly single-digit-to-low-double-digit ms per view), versus the ~1ms HMAC-verify path used for /api/*. Since the dashboard intentionally uses full document navigations, this overhead lands on the TTFB of every page view, but it is well below the blocking-DB-RTT (~100ms) class, so it grades low rather than medium.

**Suggested fix:** Drop the isInternalApiPath(path) gate at apps/app/src/middleware/index.ts:329 so the getCookieCache fast path (keyed on cfEnv.BETTER_AUTH_SECRET) covers all session-resolving paths including /app/* page views; the existing fallback to getAuth().api.getSession() still runs whenever the 5-minute cookie cache is absent or expired, preserving cookie refresh and revocation semantics. Optionally also memoize the auth instance at module scope (keyed on the resolved baseURL, since `env` is already imported from cloudflare:workers) so the betterAuth construction cost is paid once per isolate instead of per request on cache-miss paths.

---

## Low-severity notes — verified (40)

Grouped verification, one reviewer per group. Verdict prefix per note.

### Middleware / usage tracking

- **confirmed** — Workspace-validation cache hit rate capped by 5-minute TTL on an unchanging fact _(apps/api/src/middleware/workspace-validation.ts:6)_
  WS_VALID_TTL_SECONDS = 300 (workspace-validation.ts:6) is still applied to every positive cache write (line 82), even though org-to-workspace membership never changes and the delete handler already invalidates the key (comment, lines 18-20). Hit rate is therefore still bounded by the 5-minute TTL.
- **confirmed** — incrementUsage is a non-atomic KV read-modify-write racing across crons and consumers _(apps/api/src/middleware/usage-tracking.ts:25-32)_
  incrementUsage still does kv.get then kv.put (usage-tracking.ts:25-32, 2 KV ops, last-write-wins), and concurrent callers race on the same usage:{org}:{month} key: queues/publish.ts:123, services/scheduler.ts:65, auto-post-processor.ts:383, recycling-processor.ts:156, posts.ts:2038, plus the middleware's own inline RMW at lines 246-253. The code comment (lines 240-242) acknowledges this with a Durable Objects TODO.
- **confirmed** — Blocking KV usage-counter read on every non-GET API request _(apps/api/src/middleware/usage-tracking.ts:246)_
  GET/HEAD exit early (lines 208-226), but every other method still synchronously awaits c.env.KV.get(usageKvKey) at usage-tracking.ts:246 before the handler runs (the read feeds the free-plan gate at line 304). Only the KV write was deferred via waitUntil (lines 249-253); the blocking read remains.
- **confirmed** — Bulk-unit body parsing serialized before the independent KV usage-counter read on billable POSTs _(apps/api/src/middleware/usage-tracking.ts:235-246)_
  await getUsageUnits(c) at usage-tracking.ts:235 completes before the independent KV.get at line 246 with no Promise.all; the KV key depends only on orgId/month, so they could run in parallel. The real parse cost is mostly /v1/posts/bulk-csv (clone+formData+CSV, lines 105-117) since JSON bulk paths usually reuse the cached parsedBody (lines 126-130), but the serialization itself is present on every billable POST.

### Posts / ideas

- **confirmed** — Account metadata setter endpoints decrypt both tokens they never use _(apps/api/src/lib/accounts.ts:25-26)_
  getOwnedAccount always decrypts accessToken and refreshToken (apps/api/src/lib/accounts.ts:25-26), and every metadata setter (e.g. setFacebookPage at apps/api/src/routes/accounts.ts:891-915, setRedditSubreddit at :1350-1374) passes ENCRYPTION_KEY yet only updates metadata and returns formatAccountResult (accounts.ts:754-776), which never touches the tokens.
- **confirmed** — listIdeaGroups runs an ensureDefaultGroup existence check (extra serialized query, possible write) on every GET _(apps/api/src/routes/idea-groups.ts:100)_
  listIdeaGroups awaits ensureDefaultGroup on every request (apps/api/src/routes/idea-groups.ts:100) before the list query at line 108; the helper does a serialized SELECT (lines 50-54) plus a conditional INSERT (lines 58-67).
- **confirmed** — retryPost: target status reset and accounts batch fetch are independent but serialized _(apps/api/src/routes/posts.ts:2066-2084)_
  The UPDATE resetting failed targets (apps/api/src/routes/posts.ts:2066-2069) and the socialAccounts batch SELECT (lines 2078-2084) both depend only on the in-memory failedTargets but run as sequential awaits; only the later post/targets refetch (line 2120) was parallelized.
- **confirmed** — Conversation detail returns a fixed 200-message thread with no pagination _(apps/api/src/services/inbox-persistence.ts:347)_
  getConversationWithMessages still hard-codes .limit(200) with no cursor or limit parameters (apps/api/src/services/inbox-persistence.ts:342-347); the already-applied fix only parallelized the conversation+messages fetch (line 336) and did not add pagination.

### Webhooks / Stripe / invites

- **confirmed** — GET /v1/webhooks/logs returns full payload blobs not declared in the response schema _(apps/api/src/routes/webhooks.ts:578)_
  Handler selects payload (full `select()` at webhooks.ts:528, explicit `payload: webhookLogs.payload` at :547) and returns `payload: l.payload` at :578, but the WebhookLogEntry response schema (:186-195) declares no payload field. zod-openapi does not strip undeclared response fields, so full payload blobs are sent over the wire.
- **confirmed** — Stripe webhook performs one serialized KV dedup read before returning 200 _(apps/api/src/routes/stripe-webhooks.ts:67)_
  The dedup read `await c.env.KV.get(dedupKey)` at stripe-webhooks.ts:67 is still awaited inline before the 200 response at :77; only the handler work and the KV put are deferred via waitUntil (:71-75). The serialized read remains in the current tree.
- **confirmed** — syncOrgKeysToKV loops KV get+put serially per API key on every plan transition _(apps/api/src/routes/stripe-webhooks.ts:446-457)_
  syncOrgKeysToKV (stripe-webhooks.ts:433) iterates `for (const k of orgKeys)` with `await env.KV.get` (:447) and `await env.KV.put` (:453) inside the loop — strictly serial per key, and it is awaited from every plan-transition call site (e.g. :183, :228, :271, :404).
- **partial** — Invite token creation runs 4 sequential DB queries where the first two are independent _(apps/api/src/routes/invite.ts:176-257)_
  There are indeed up to 4 sequential awaited DB queries (apikey lookup :176, member lookup :191, workspace validation :230 — conditional on scope, insert :257), but the first two are NOT independent: the member query filters on `creatorUserId` which comes from the apikey query's `referenceId` (:182,:194). They could be merged into one JOIN but cannot be parallelized as written.

### Short links / WebSocket / tools

- **confirmed** — Short-link redirect KV lookup does not extend edge caching for immutable short links _(apps/api/src/routes/short-link-redirect.ts:17)_
  KV.get(`sl:${code}`) at short-link-redirect.ts:17 passes no cacheTtl and the 302 at line 39 has no Cache-Control header; sl:{code} mappings are write-once (created with collision check in services/short-link-providers/relayapi.ts:46-52, never updated), so longer edge caching would be safe but is not used.
- **confirmed** — WebSocket upgrade serializes a KV delete before connecting to the Durable Object _(apps/api/src/routes/websocket.ts:39)_
  websocket.ts:39 has `await c.env.KV.delete(\`ws-ticket:${ticket}\`)` on the critical path before the Durable Object stub.fetch at lines 41-43; the delete is not deferred via waitUntil and this file was not touched by the applied fixes.
- **confirmed** — Tools download/transcript endpoints can hold the client for the full 20s sync window before still returning a 202 _(apps/api/src/routes/tools.ts:756-761)_
  handleDownload awaits callDownloaderService with a 20_000ms timeout (tools.ts:756-761) and on timeout falls through to enqueue and return 202 (lines 791-798); the transcript handler has the identical pattern (lines 875-880 and 907-914), so a slow VPS holds the client ~20s before the async 202.
- **confirmed** — GET /v1/automation-bindings returns all bindings for the org with no limit or pagination _(apps/api/src/routes/automation-bindings.ts:255-271)_
  ListQuery (automation-bindings.ts:201-206) accepts only filter params with no limit/cursor, the select at lines 255-271 has no .limit(), and ListResponse (line 208) is a bare data array with no next_cursor/has_more — the route (mounted at /v1/automation-bindings, app.ts:234) returns every matching org row.

### Cron services

- **confirmed** — Token refresh re-fetches and re-hosts the account avatar (2 external fetches + R2 put) on every refresh _(apps/api/src/services/token-refresh.ts:151-161)_
  Every successful refresh awaits fetchAvatarUrl (external platform API call, token-refresh.ts:154) then rehostAvatar, which fetches the CDN image bytes (avatar-store.ts:36) and writes them to R2 (avatar-store.ts:46) — no change-detection or skip-if-already-rehosted gating, and both run inline before the DB update rather than in waitUntil.
- **confirmed** — WhatsApp broadcast finalization runs three sequential COUNT(*) queries _(apps/api/src/services/whatsapp-broadcast-processor.ts:220-230)_
  countByStatus (whatsapp-broadcast-processor.ts:206-217) is awaited three times in sequence — pending at :220, sent at :229, failed at :230 — three round-trips that could be one GROUP BY status query or two parallel counts.
- **confirmed** — Streak expiry cron updates each expired streak row individually _(apps/api/src/services/streak.ts:180-194)_
  checkStreaks loops `for (const streak of expired)` and awaits a per-row UPDATE (streak.ts:183-194) whose SET clause is pure SQL (GREATEST/increment), so it could be a single bulk UPDATE ... WHERE id IN (...); the loop also serially awaits sendStreakBrokenNotifications per row (streak.ts:220).
- **confirmed** — Deprecated AUTOMATION_QUEUE binding and consumer still deployed _(apps/api/wrangler.jsonc:131-133,185-190)_
  The AUTOMATION_QUEUE producer binding (wrangler.jsonc:131-133) and relayapi-automation consumer (wrangler.jsonc:185-190) are still configured, routed in queues/index.ts:31 to the self-described deprecated ack-only consumer (queues/automation.ts:3-9), which states no code path sends to the queue and the binding should be removed once drained.

### Bundle / static imports / KV TTLs

- **confirmed** — dagre (63 KiB) statically bundled and evaluated at cold start, used only for automation template layout _(apps/api/src/services/automations/templates/_layout.ts:20)_
  Static `import dagre from "@dagrejs/dagre"` at _layout.ts:20 remains, reached by the fetch worker via app.ts -> routes/automations.ts:37 -> templates/index.ts -> every template builder. Its only use is autoLayoutGraph (dagre.layout at _layout.ts:84), so the library is bundled and module-evaluated at cold start for template layout alone.
- **confirmed** — fast-xml-parser (60 KiB) statically imported into the fetch worker via the auto-post-rules route _(apps/api/src/services/auto-post-processor.ts:10)_
  auto-post-processor.ts:10 statically imports XMLParser and instantiates it at module scope (line 33); routes/auto-post-rules.ts:18 statically imports parseFeed/validateFeedUrl from it and is mounted in app.ts:243, so fast-xml-parser is bundled into and evaluated by the fetch worker.
- **confirmed** — Resend client constructed per send call instead of module-cached in email-queue producer _(apps/api/src/lib/email-queue/producer.ts:41)_
  producer.ts:41 builds `new Resend(resendApiKey)` inside sendEmailDirect on every invocation with no module-level cache (and the Resend import at line 1 is still static, unlike the dynamically-imported Stripe/react-email fixes). Minor mitigant: this path only runs as the no-queue fallback (sendEmail, line 66-75).
- **confirmed** — org-settings:{orgId} KV entry written with no TTL — permanent staleness risk and dual source of truth _(apps/api/src/routes/org-settings.ts:173)_
  org-settings.ts:173-176 calls env.KV.put with no expirationTtl, while the same flag is also upserted into organizationSubscriptions (lines 129-138); middleware/feature-gate.ts:41-44 reads only the KV key with no DB fallback, so a missed or failed sync leaves the setting permanently stale.

### Analytics / misc

- **confirmed** — analytics.ts daily-metrics endpoint has no row cap for caller-supplied date ranges _(apps/api/src/routes/analytics.ts:435-451)_
  The getDailyMetrics handler (apps/api/src/routes/analytics.ts:424-451) runs the posts+targets JOIN with no .limit() and no clamp on the range, and DailyMetricsQuery (apps/api/src/schemas/analytics.ts:25-30) exposes only optional from_date/to_date with no cap, so an arbitrarily wide range loads every matching row (and feeds an unbounded targetIds list into getLatestAnalyticsForTargets at line 457).
- **confirmed** — Analytics platform-overview cache TTL of 300s with no stampede protection causes repeated external platform API calls _(apps/api/src/routes/analytics.ts:50,993-1008)_
  ANALYTICS_OVERVIEW_CACHE_TTL_SECONDS = 300 (apps/api/src/routes/analytics.ts:50) and getCachedPlatformOverview (lines 993-1008) is a plain KV get → external fetch → waitUntil put with no single-flight lock or stale-while-revalidate, so every 5-minute expiry (per account per date-range key) re-hits the platform API and concurrent misses each fetch independently.
- **confirmed** — inbox.ts deleteReviewReply tries Google Business accounts serially instead of in parallel _(apps/api/src/routes/inbox.ts:1666-1683)_
  The deleteReviewReply handler (apps/api/src/routes/inbox.ts:1659-1686) awaits the Google DELETE fetch inside a sequential `for (const account of accounts)` loop, returning on first success — unlike sibling inbox handlers that use mapConcurrently. Minor caveat: serial-until-first-success is N round trips only in the worst case, so impact is bounded by the org's googlebusiness account count.
- **confirmed** — inbox-event-processor.ts input-resume lookup loads full context JSONB for all waiting runs and filters in JS _(apps/api/src/services/inbox-event-processor.ts:836-873)_
  resumeWaitingRunForInput (apps/api/src/services/inbox-event-processor.ts:836-851) selects the entire automationRuns.context JSONB for every (org, contact, status=waiting, waiting_for=input) row, then filters by ctx._triggering_social_account_id in JS (lines 864-873) instead of a SQL ->> predicate. Scope is bounded per-contact, and the code comments (lines 853-863) document this as a deliberate defence-in-depth design, so severity is genuinely low.

### Schema indexes

- **confirmed** — media-cleanup queue deletes by unindexed media.storage_key with no org filter _(apps/api/src/queues/media-cleanup.ts:20)_
  apps/api/src/queues/media-cleanup.ts:20 runs db.delete(media).where(eq(media.storageKey, body.object.key)) with no organization_id filter, and the media table defines only media_org_idx and media_workspace_idx (packages/db/src/schema.ts:547-550) — no storage_key index exists in schema or any drizzle migration, so each queue message is a full-table scan.
- **confirmed** — broadcast_recipients.contact_id unindexed — contact merge scans the whole table _(apps/api/src/routes/contacts.ts:1247-1250)_
  apps/api/src/routes/contacts.ts:1247-1250 updates broadcast_recipients with where(eq(broadcastRecipients.contactId, sourceId)), but the table's only indexes are broadcast_id-leading (broadcast_idx, status_idx, dedup_idx at packages/db/src/schema.ts:1546-1556), so the merge update sequential-scans the whole table.
- **confirmed** — No index on auth.invitation(email, status) for the onboarding pending-invite check _(apps/app/src/middleware/index.ts:243-247)_
  apps/app/src/middleware/index.ts:243-247 queries invitation by eq(email) AND eq(status, 'pending'), while the auth.invitation table (packages/db/src/schema.ts:183-198) defines no secondary indexes at all and no migration (packages/db/drizzle/*.sql) adds one — only the PK and FK constraints exist.

### Dashboard (apps/app)

- **confirmed** — Dead SSE notifications route polls Postgres every 5s for up to 30 minutes per connection _(apps/app/src/pages/api/notifications/stream.ts:5-6,56-89)_
  Route exists with POLL_INTERVAL=5_000 and MAX_DURATION=30min (stream.ts:5-6), polling Postgres in the loop at lines 56-89. No consumer anywhere: zero matches for EventSource or 'notifications/stream' in apps/app/src/ outside the route and none in dist/client, so it is dead code.
- **confirmed** — three.js, @react-three/*, postprocessing, and tsparticles are dead dependencies shipping zero bytes but costing install/build time _(apps/app/package.json:29-30,36-38,46,56)_
  All six packages remain in apps/app/package.json (lines 29-30, 36-38, 46, 56) but their only importers — dither.tsx (via lazy-dither.tsx via workflow-connect-section.tsx, whose WorkflowConnectSection is never imported) and ui/sparkles.tsx (zero importers) — are unreachable from any page, and dist/client contains no three/tsparticles/postprocessing bytes.
- **confirmed** — Org-summary KV read is serialized after session resolution on every /app HTML view _(apps/app/src/middleware/index.ts:336-369)_
  Session resolution is awaited first (index.ts:336-346), then getOrganizationSummary is awaited (lines 361-369) which performs the KV read at line 182, gated on path.startsWith('/app') (lines 70-72). Only the KV write-back is deferred via waitUntil (line 218); the read remains serialized.
- **confirmed** — Always-loaded middleware server chunk is 1.6 MB (better-auth + drizzle + full schema), inflating cold start _(apps/app/dist/server/chunks/_virtual_astro_middleware_BT9K73qR.mjs (1,726,038 bytes))_
  The middleware chunk is 1.65 MB and bundles better-auth, drizzle, kysely, and the postgres driver; it also statically imports the full schema namespace (schema$2) from the 340 KB schema_DVdIv3QP.mjs chunk, pulled in by createDb's `import * as schema` in packages/db/src/client.ts:3,28-29. All of it loads on every cold start via src/middleware/index.ts:1-11 top-level imports.
- **confirmed** — Observability persists invocation logs at 100% sampling on all dashboard traffic _(apps/app/wrangler.jsonc:8-16)_
  apps/app/wrangler.jsonc:8-16 sets observability.logs to enabled:true, head_sampling_rate:1, persist:true, invocation_logs:true — 100% persisted invocation logging. This file is unmodified by the audit fixes (only apps/api/wrangler.jsonc was changed).

### Misc small serializations

- **confirmed** — ads.ts searchInterests resolves ad account and social account with two sequential queries plus in-handler dynamic imports _(apps/api/src/routes/ads.ts:804-844)_
  Handler awaits the adAccounts select (ads.ts:804-813) then the socialAccounts select (ads.ts:824-833) serially, with in-handler dynamic imports of @relayapi/db (ads.ts:823) and ../lib/crypto (ads.ts:842).
- **confirmed** — accounts.ts PATCH /v1/accounts/{id}: account select and workspace-ownership validation are independent queries executed serially _(apps/api/src/routes/accounts.ts:656,693)_
  The account select (accounts.ts:656-662) and the workspace-ownership select (accounts.ts:693-697) do not use each other's results but run serially; only the final update uses .returning() to avoid a re-select (accounts.ts:709).
- **confirmed** — whatsapp.ts profile-photo upload: account DB fetch serialized before the independent external image download _(apps/api/src/routes/whatsapp.ts:1735,1763)_
  getWhatsAppAccount is awaited at whatsapp.ts:1735 before the image download via fetchPublicUrl(body.photo_url) at whatsapp.ts:1763, which depends only on body.photo_url and could run in parallel.
- **confirmed** — Telnyx client and WhatsApp phone-provisioning Meta calls have no timeout _(apps/api/src/services/telnyx.ts:46; apps/api/src/routes/whatsapp-phone-provisioning.ts:516,651,738,764)_
  telnyxFetch uses bare fetch with no AbortSignal/timeout (telnyx.ts:46-53), and the Meta fetch calls in whatsapp-phone-provisioning.ts (lines 516, 651, 738, 764) likewise pass no signal or timeout.

