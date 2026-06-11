# API Request Lifecycle (apps/api)

## Overview

This flow traces what happens to every authenticated request against the RelayAPI worker (`apps/api`), from the Cloudflare Workers `fetch` entry point through the full middleware chain, up to the point where the route handler runs — using `GET /v1/posts` and `POST /v1/posts` as the reference requests.

**Entry points** (`apps/api/src/index.ts:7-17`):

- `fetch: app.fetch` — HTTP traffic, delegates to the Hono `OpenAPIHono` app built in `apps/api/src/app.ts`.
- `queue(batch, env)` — all 9+ queue consumers (`src/queues/index.ts`).
- `scheduled(event, env, ctx)` — 6 cron triggers (`src/scheduled/index.ts`).
- `RealtimeDO` Durable Object export.

All three entry points live in **one worker bundle**: `app.ts` statically imports ~46 route modules (`app.ts:21-77`), and `index.ts` additionally pulls in every queue consumer, the scheduler, and the DO. Total API source is ~86k lines of TypeScript (excluding tests). Every cold start — whether for an HTTP request, a cron tick, or a queue batch — parses and initializes the entire bundle, including module-scope `createRoute(...)` Zod/OpenAPI schema construction for every endpoint in the codebase.

**Unauthenticated routes** mounted before the auth middleware (`app.ts:115-137`): `/health`, `/r` (short links), `/webhooks/stripe`, `/webhooks/platform`, `/connect/oauth`, `/avatars`, `/v1/ws` (ticket-authenticated upgrade), `/v1/webhooks/automation-trigger` (HMAC). Everything else under `/v1/*` goes through the chain below.

**Bindings used on the request path** (`wrangler.jsonc`): `KV` (API-key cache, usage counters, workspace-validity cache, org settings), `HYPERDRIVE` (Postgres pooling), `FREE_RATE_LIMITER` / `PRO_RATE_LIMITER` (CF Rate Limiting bindings, namespace 1001/1002, 100/min and 1000/min). No Smart Placement is configured in `wrangler.jsonc` — the worker runs in the ingress colo while the origin Postgres sits behind Hyperdrive in one region.

## Step-by-step trace

Middleware registration order for `/v1/*` (`apps/api/src/app.ts`):

| # | Registration | File | Applies to |
|---|---|---|---|
| 0 | `app.onError` (`app.ts:82`) | app.ts | error fallback only |
| 1 | `cors({origin:"*"})` (`app.ts:93-102`) | hono/cors | `*` |
| 2 | `securityHeadersMiddleware` (`app.ts:105`) | middleware/security-headers.ts | `*` |
| 3 | `authMiddleware` (`app.ts:140`) | middleware/auth.ts | `/v1/*` |
| 4 | `dbContextMiddleware` (`app.ts:144`) | middleware/db-context.ts | `/v1/*` |
| 5 | `rateLimitMiddleware` (`app.ts:147`) | middleware/rate-limit.ts | `/v1/*` |
| 6 | `readOnlyMiddleware` (`app.ts:150`) | middleware/permissions.ts | `/v1/*` |
| 7 | `bodyCacheMiddleware` (`app.ts:154`) | middleware/body-cache.ts | `/v1/*` |
| 8 | `workspaceValidationMiddleware` (`app.ts:157`) | middleware/workspace-validation.ts | `/v1/*` |
| 9 | `workspaceScopeMiddleware` (`app.ts:159`) | middleware/permissions.ts | `/v1/*` |
| — | `/v1/ws-ticket` route mounted here (`app.ts:162`) — it therefore **skips** everything below (feature gates, usage tracking) | | |
| 10 | `proOnlyMiddleware` (`app.ts:165-170`) | middleware/feature-gate.ts | `/v1/analytics/*`, `/v1/inbox/*`, `/v1/custom-fields/*`, `/v1/ads/*`, `/v1/short-links/*`, `/v1/auto-post-rules/*` |
| 11 | `workspaceRequiredMiddleware` (`app.ts:173-180`) | middleware/feature-gate.ts | `/v1/posts/*`, `/v1/webhooks/*`, `/v1/broadcasts/*`, `/v1/custom-fields/*`, `/v1/ads/*`, `/v1/auto-post-rules/*`, `/v1/content-templates/*`, `/v1/threads/*` |
| 12 | `toolRateLimitMiddleware` (`app.ts:183-184`) | middleware/tool-rate-limit.ts | `/v1/tools/*/download`, `/v1/tools/youtube/transcript` |
| 13 | `aiEnabledMiddleware` (`app.ts:187-190`) | middleware/feature-gate.ts | 4 `/v1/inbox/*` AI endpoints |
| 14 | `usageTrackingMiddleware` (`app.ts:193`) | middleware/usage-tracking.ts | `/v1/*` |
| 15 | Route handlers (`app.ts:196-241`) | routes/* | |

### 1. CORS (`app.ts:93-102`)
Pure in-memory header work; `OPTIONS` preflight short-circuits here with `maxAge: 86400`. No I/O.

### 2. Security headers (`middleware/security-headers.ts:4-13`)
`await next()` then sets 4 static headers. No I/O.

### 3. Auth (`middleware/auth.ts:109-169`)
1. Reads `Authorization` header; rejects if not `Bearer rlay_live_*`/`rlay_test_*` (`auth.ts:113-130`). In-memory.
2. **Crypto:** `hashKey(token)` — one `crypto.subtle.digest("SHA-256", …)` plus hex-encoding via `Array.from(...).map(...).join("")` (`auth.ts:31-38`). Microseconds; runs on **every** `/v1` request.
3. **KV read (serialized, every request):** `c.env.KV.get(`apikey:${hashedKey}`, "json")` (`auth.ts:133`).
4. **Cache hit** (normal case): values copied into context vars `orgId`, `keyId`, `permissions`, `workspaceScope`, `plan`, `callsIncluded`, `aiEnabled`, `dailyToolLimit` (`auth.ts:160-167`). No DB touch.
5. **Cache miss** → `hydrateApiKey(env, hashedKey)` (`auth.ts:45-107`):
   - Creates its **own** postgres client via `getRequestDb(env)` (`auth.ts:49`) — separate from the one `dbContextMiddleware` creates two steps later.
   - **DB round trip 1:** `select … from apikey where key = hashedKey limit 1` (`auth.ts:51-62`).
   - **DB round trip 2 (sequential, depends only on `organizationId`):** `select … from organization_subscriptions where organization_id = … limit 1` (`auth.ts:67-75`).
   - **KV write (awaited on the request path):** `await env.KV.put("apikey:…", …, { expirationTtl: kvTtlForKey(...) })` (`auth.ts:102-104`). TTL is 24h (`API_KEY_KV_TTL_SECONDS = 86400`, `auth.ts:17`), clamped to the key's own expiry, min 60s (`auth.ts:24-29`).
6. Expiry re-check from cached `expires_at` (`auth.ts:149`). In-memory.

**Cached:** API-key record in KV for 24h (passive backstop; explicit invalidation paths exist for delete/Stripe events per the comment at `auth.ts:10-16`).

### 4. DB context (`middleware/db-context.ts:14-20`)
`c.set("db", getRequestDb(c.env))` — `getRequestDb` (`lib/request-db.ts:11-14`) calls `createDb(env.HYPERDRIVE.connectionString)` (`packages/db/src/client.ts:19-26`):

```ts
const client = postgres(connectionString, {
    prepare: true,       // Hyperdrive caches prepared statements
    max: 5,
    fetch_types: false,  // skips the type-metadata round trip
});
return drizzle(client, { schema });
```

- A **new postgres-js client + Drizzle instance is allocated per request** (plus an extra one inside `hydrateApiKey` on auth-cache miss, and another inside `sendNotificationToOrg` if a usage threshold fires). No socket is opened here — postgres-js connects lazily on the first query.
- The client is **never `.end()`ed**; the runtime tears sockets down when the invocation (including `waitUntil` work) finishes. This is the documented Workers/Hyperdrive pattern: the TCP connection goes to Hyperdrive's pooler, not the origin DB, so per-request connect cost is the in-/near-colo handshake to Hyperdrive plus Postgres auth against the pooler — paid once per request on the **first query** (which, for a warm-KV GET, is the route handler's first query; the middleware chain itself does zero DB work).

### 5. Rate limit (`middleware/rate-limit.ts:4-29`)
**One Rate Limiting binding call (serialized, every request):** `await limiter.limit({ key: keyId })` against `FREE_RATE_LIMITER` or `PRO_RATE_LIMITER` selected by plan (`rate-limit.ts:11-14`). This is colo-local state (CF ratelimit binding), typically sub-millisecond, but it is strictly ordered after the auth KV read because it needs `keyId`.

### 6. Read-only enforcement (`middleware/permissions.ts:12-26`)
Checks `permissions` array from context. No I/O.

### 7. Body cache (`middleware/body-cache.ts:15-33`)
- GET/HEAD/DELETE: sets `parsedBody = null`. No I/O.
- POST/PUT/PATCH with a JSON content type: `await c.req.json()` — buffers and parses the **entire** body before any downstream middleware runs, stores it as `parsedBody` (`body-cache.ts:24-25`). Hono caches the underlying body, so later Zod validators do not re-read the stream. CPU-bound, scales with payload size.

### 8. Workspace validation (`middleware/workspace-validation.ts:22-89`)
Only active when the request carries a `workspace_id` (query string, parsed at `workspace-validation.ts:27`, or JSON body via `parsedBody`, `:30-33`). When present:
- **KV read(s) (serialized):** `KV.get("ws-valid:{orgId}:{wsId}")` for each unique id, in parallel via `Promise.all` (`workspace-validation.ts:43-45`). TTL 5 minutes (`WS_VALID_TTL_SECONDS = 300`, `:6`).
- **On cache miss → DB round trip (serialized):** `select id from workspaces where organization_id = ? and id in (...)` (`workspace-validation.ts:54-63`) using the shared `c.get("db")` client — for a warm-KV request this is the request's first actual DB query and therefore also pays the lazy postgres-client connect.
- **KV write (deferred):** positive results written back via `c.executionCtx.waitUntil(...)` (`workspace-validation.ts:78-86`). Off the hot path — good.

### 9. Workspace scope (`middleware/permissions.ts:51-113`)
Keys with `workspaceScope === "all"` (the default) pass through immediately (`permissions.ts:57-59`). Scoped keys do in-memory checks of query string / `parsedBody`. No I/O.

### 10. Pro-only gate (`middleware/feature-gate.ts:5-22`) — gated prefixes only
Reads `plan` from context. No I/O.

### 11. Workspace-required gate (`middleware/feature-gate.ts:29-91`) — 8 prefixes incl. `/v1/posts/*`, POST only
- **KV read (serialized, every POST to these prefixes):** `KV.get("org-settings:{orgId}", "json")` (`feature-gate.ts:41-44`). This read happens **before** the cheap in-memory short-circuits — even when the request already carries `workspace_id` (which passes unconditionally at `:53-54` / `:60`), and even when the key has all-workspace scope and the org has no settings record (the overwhelmingly common case, which is a KV negative lookup every time).

### 12. Tool rate limit (`middleware/tool-rate-limit.ts:9-43`) — tools endpoints only
**KV read (serialized):** `KV.get("tool-usage:{orgId}:{date}")`; the increment `KV.put` is deferred via `waitUntil` (`tool-rate-limit.ts:26-28`).

### 13. AI gate (`middleware/feature-gate.ts:93-110`) — 4 inbox AI endpoints
Context read only. No I/O.

### 14. Usage tracking (`middleware/usage-tracking.ts:201-357`)
Two branches:

**GET/HEAD** (`usage-tracking.ts:208-226`): runs `next()` first (handler executes), then defers one **DB insert** into `api_request_logs` via `waitUntil` (`:213-224`). Not billed, no KV ops, nothing serialized before the handler.

**POST/PUT/PATCH/DELETE** (`usage-tracking.ts:228-357`):
1. `getUsageUnits(c)` (`:235`, impl `:119-139`): for 5 specific bulk JSON paths counts array items from `parsedBody` (fallback: `c.req.raw.clone().json()`); for `/v1/posts/bulk-csv` clones the body and parses the whole CSV (`countBulkCsvUnits`, `:105-117`). For everything else returns 1 with no I/O.
2. **KV read (serialized, every billable request):** `KV.get("usage:{orgId}:{YYYY-MM}")` (`:246`). The increment `KV.put` (TTL 35 days) is deferred via `waitUntil` (`:249-253`).
3. Threshold notifications (80%/100%): entirely inside `waitUntil` (`:267-298`) — KV dedup read, `sendNotificationToOrg` (its own postgres client + member/prefs queries + email queue), KV dedup write. Off the hot path.
4. Free-plan hard limit check against the pre-increment count (`:304-329`) — returns 403 without running the handler; still logs via deferred DB insert.
5. Sets `X-Usage-Count` / `X-Usage-Limit` headers, runs the handler, then defers **two DB writes in parallel** (`persistUsageAndLogs`, `:141-199`): an `api_request_logs` insert and a `usage_records` upsert (`onConflictDoUpdate` with SQL-side counters — the billing source of truth).

### 15. Route handler (e.g. `listPosts`, `routes/posts.ts:557`)
Uses the shared `c.get("db")` (`posts.ts:571`). Base list = 1 query (`posts.ts:632-649`); `include=targets` and `include=media` each add one batched `inArray` query (no N+1). First query pays the lazy postgres→Hyperdrive connect.

## Per-request work

### `GET /v1/posts` — warm caches, no `workspace_id`, scope `"all"` (the hot path)

Strictly serialized, in order, **before the handler**:

1. SHA-256 digest of the API key (in-isolate crypto, ~µs) — `auth.ts:132`
2. **KV read** `apikey:{sha256}` — `auth.ts:133`
3. postgres-js/Drizzle client allocation (no I/O) — `db-context.ts:18`
4. **Rate-limit binding call** `limiter.limit({key: keyId})` — `rate-limit.ts:14`
5. (readOnly / bodyCache / wsValidation / wsScope / usageTracking-GET: all no-ops, in-memory)
6. Handler runs → **DB query 1** (posts page; also pays the lazy connect to Hyperdrive on this first query), plus 1–2 more batched queries if `include=targets,media`.

After the response (deferred, `waitUntil`):
- **DB insert** into `api_request_logs` (`usage-tracking.ts:213-224`) — one origin DB write per request, including every GET.

**Total serialized external ops pre-handler: 2** (1 KV read + 1 ratelimit call). **Total per-request DB ops: handler queries + 1 deferred log insert.**

### `GET /v1/posts?workspace_id=ws_…` — adds:
- **+1 serialized KV read** `ws-valid:{orgId}:{wsId}` (`workspace-validation.ts:43-45`)
- on 5-min-TTL miss: **+1 serialized DB query** against `workspaces` (`workspace-validation.ts:54-63`); KV write-back deferred.

### `POST /v1/posts` — warm caches, `workspace_id` in body

Strictly serialized before the handler:

1. SHA-256 digest (in-isolate)
2. **KV read** `apikey:{hash}` — `auth.ts:133`
3. **Rate-limit binding call** — `rate-limit.ts:14`
4. Full body buffered + `JSON.parse` — `body-cache.ts:24`
5. **KV read** `ws-valid:{orgId}:{wsId}` — `workspace-validation.ts:43-45` (miss → **+1 DB query**)
6. **KV read** `org-settings:{orgId}` — `feature-gate.ts:41-44`
7. **KV read** `usage:{orgId}:{month}` — `usage-tracking.ts:246`
8. Handler runs (its own DB queries + queue sends etc.)

Deferred (`waitUntil`): usage-counter KV put (`usage-tracking.ts:249-253`), ws-valid KV put on miss, `api_request_logs` insert + `usage_records` upsert in parallel (`usage-tracking.ts:338-356`), threshold-notification pipeline if crossed.

**Total serialized external ops pre-handler: 5** (1 KV + 1 ratelimit + 3 KV) — items 5–7 are independent of each other but execute sequentially because they live in three separate middleware.

### Auth cache-miss path (first request per key per ~24h per KV-cache locality) — adds, all serialized:
1. KV read (miss) — `auth.ts:133`
2. **DB round trip:** `apikey` lookup — `auth.ts:51-62`
3. **DB round trip:** `organization_subscriptions` lookup — `auth.ts:67-75` (sequential after #2, though it only needs `organizationId`; could be a single joined query)
4. **Awaited KV write** `apikey:{hash}` — `auth.ts:102` (not deferred; no `executionCtx` is available inside `hydrateApiKey`)

Since the worker colo is typically far from the origin DB region (no Smart Placement; Hyperdrive pools connections but every query is still a full edge→origin round trip), this miss path realistically adds 2 × (edge→DB RTT) + a KV write — easily 100–300ms.

### Crypto operations on the request path
- 1 × SHA-256 per request (`auth.ts:31-38`).
- AES-256-GCM (`lib/crypto.ts`) does **not** run in the middleware chain; it runs in route handlers/services that touch social-account tokens. The AES `CryptoKey` import is memoized per isolate (`crypto.ts:19-34`), so per-decrypt cost is one `subtle.decrypt` + base64 decode.

## External calls

| Call | Where | When | Serialized? |
|---|---|---|---|
| KV `get apikey:{hash}` | auth.ts:133 | every `/v1` request | yes |
| KV `put apikey:{hash}` (TTL ≤24h) | auth.ts:102 | auth cache miss | **yes (awaited)** |
| Postgres: `apikey` select | auth.ts:51-62 | auth cache miss | yes |
| Postgres: `organization_subscriptions` select | auth.ts:67-75 | auth cache miss | yes, sequential after previous |
| Rate Limiting binding `limit()` | rate-limit.ts:14 | every `/v1` request | yes |
| KV `get ws-valid:{org}:{ws}` (×N unique ids, parallel) | workspace-validation.ts:43-45 | request carries workspace_id | yes |
| Postgres: `workspaces` select | workspace-validation.ts:54-63 | ws-valid cache miss | yes |
| KV `put ws-valid:*` (TTL 300s) | workspace-validation.ts:78-86 | ws-valid cache miss | no (waitUntil) |
| KV `get org-settings:{org}` | feature-gate.ts:41-44 | every POST to 8 route prefixes | yes |
| KV `get tool-usage:{org}:{day}` | tool-rate-limit.ts:22 | tools endpoints | yes |
| KV `put tool-usage:*` (TTL 48h) | tool-rate-limit.ts:26-28 | tools endpoints | no (waitUntil) |
| KV `get usage:{org}:{month}` | usage-tracking.ts:246 | every non-GET `/v1` request | yes |
| KV `put usage:*` (TTL 35d) | usage-tracking.ts:249-253 | every non-GET | no (waitUntil) |
| Postgres: `api_request_logs` insert | usage-tracking.ts:146-155 | **every** `/v1` request (GET and non-GET) | no (waitUntil) |
| Postgres: `usage_records` upsert | usage-tracking.ts:167-190 | every non-GET | no (waitUntil, parallel with log insert) |
| KV get/put `usage_warning:*` + notification fan-out (DB + email queue) | usage-tracking.ts:267-298 | only on 80%/100% threshold crossing | no (waitUntil) |

## Performance notes

1. **Hot-path floor is good:** a warm GET pays exactly 1 KV read + 1 ratelimit call + SHA-256 before the handler. The expensive work (usage/log persistence, KV counter writes, cache write-backs, notifications) is consistently pushed to `waitUntil`.
2. **POSTs stack 3 extra serialized KV reads** (`ws-valid`, `org-settings`, `usage`) across three independent middleware. Warm same-colo KV reads are ~sub-ms, but cold-cache KV reads go to upper tiers (tens of ms each); worst case this is 3 sequential cold reads before any handler work. They have no data dependencies on each other and could be prefetched in parallel right after auth.
3. **`org-settings` KV read order:** `workspaceRequiredMiddleware` performs the KV read before its free short-circuits. Requests that already include `workspace_id` (query or body) pass regardless of the setting, so checking those first would eliminate the KV read on the common path entirely.
4. **Auth-miss hydration is 2 sequential DB queries + 1 awaited KV put.** The subscription lookup can be folded into the apikey lookup with a `LEFT JOIN`, and the KV put can be deferred (thread `executionCtx` through). On an edge→origin RTT of 50–150ms this halves miss-path latency.
5. **One origin-DB write per request** (`api_request_logs`), including unbilled GETs. Latency-safe (waitUntil) but it consumes a Hyperdrive pooled connection + an origin write for every API call, keeps every invocation alive past response, and the `bigserial` table has **no retention/cleanup job** (nothing in `src/scheduled/index.ts` or any queue consumer touches `apiRequestLogs`). At meaningful traffic this becomes the dominant DB write load and an unbounded table.
6. **Per-request postgres client:** `createDb()` per request is the sanctioned Workers/Hyperdrive pattern (`packages/db/src/client.ts` is correctly configured: `prepare: true`, `fetch_types: false`). The first query of each request pays the connect-to-Hyperdrive handshake. Up to 3 distinct clients can be allocated in one request (db-context + auth-miss + notification fan-out), each opening its own connection.
7. **No Smart Placement** in `wrangler.jsonc`. Route handlers that issue multiple sequential DB queries (e.g. listPosts with includes: up to 3) multiply the edge→origin RTT; Smart Placement (or batching queries) would cut that multiplication.
8. **Cold start:** single bundle contains all 46 routers (with module-scope `createRoute` Zod/OpenAPI construction), all queue consumers, the cron scheduler, and the DO (~86k LOC source). Every cron tick (one fires **every minute**, `wrangler.jsonc` `"*/1 * * * *"`) and queue batch keeps re-using/spawning this same heavyweight isolate.
9. **Body buffering:** `bodyCacheMiddleware` fully buffers+parses JSON bodies before validation middleware; acceptable for JSON API payloads, and multipart bodies are skipped. `getUsageUnits` re-clones the raw body only for 5 bulk endpoints when `parsedBody` is absent and parses the entire CSV for `/v1/posts/bulk-csv` synchronously before the handler.
10. **`/v1/ws-ticket` mount position** (`app.ts:162`) means it intentionally bypasses feature gates and usage tracking but still pays auth + ratelimit + body/workspace middleware.
