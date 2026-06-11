# Data Layer: Schema, Client Creation, Index Coverage

## Overview

This flow maps RelayAPI's persistence layer end to end:

- **`packages/db/src/`** — single-file Drizzle schema (`schema.ts`, 3,174 lines, **82 tables**, **198 index definitions**), client factory (`client.ts`), and barrel export (`index.ts`).
- **`packages/auth/src/`** — Better Auth configuration (`index.ts`) using the Drizzle adapter over the same DB, with the `@better-auth/api-key`, `admin`, and `organization` plugins.
- **`apps/api`** — creates one request-scoped Drizzle client via `dbContextMiddleware`, but ~60 service/route call sites also call `createDb()` directly.
- **`apps/app`** — Astro middleware lazily creates a DB client + Better Auth instance per request for session resolution.

Entry points into the data layer:

1. `apps/api/src/middleware/db-context.ts:15` — per-request client, exposed as `c.get("db")` for all `/v1/*` routes.
2. `apps/api/src/middleware/auth.ts:45` (`hydrateApiKey`) — separate client created on KV cache miss (runs **before** `dbContextMiddleware`).
3. ~60 direct `createDb(env.HYPERDRIVE.connectionString)` call sites in `apps/api/src/services/*`, `routes/{connect,connections,stripe-webhooks,platform-webhooks,automation-webhook-trigger}.ts`, and `queues/*` (cron/queue consumers plus several request-path services).
4. `apps/app/src/middleware/index.ts:271-278` — lazy `getDb()` per dashboard request.

## Step-by-step trace

### 1. Client creation (`packages/db/src/client.ts:18-32`)

```ts
export function createDb(connectionString: string, opts?: { onQuery?: (sql: string) => void }) {
	const client = postgres(connectionString, {
		prepare: true,
		max: 5,
		fetch_types: false,
	});
	...
	return drizzle(client, { schema, logger: ... });
}
```

- `postgres` (postgres.js 3.4.9) client with `max: 5` connections, `prepare: true` (named prepared statements, supported by Hyperdrive), `fetch_types: false` (skips the type-metadata round trip — good).
- `drizzle(client, { schema })` (drizzle-orm 0.45.2) rebuilds the relational config map over **all 82 tables on every call**. The header comment ("Must be called per-request") is correct for Workers I/O isolation, but the function is called far more than once per request in practice (see Performance notes).
- **No `relations()` are defined anywhere in `schema.ts`** — relational API usage is limited to `db.query.<table>.findFirst({ where })` (no `with:` joins). All multi-table reads are manual `select().from().leftJoin()` or sequential queries.
- Clients are **never `.end()`ed**; sockets are abandoned to Hyperdrive's local proxy at request end.

### 2. API request path (`apps/api/src/app.ts:145-198`)

1. `authMiddleware` (`app.ts:145`) → KV `get apikey:{sha256}` (`middleware/auth.ts:133`). On miss → `hydrateApiKey` (`auth.ts:45`): creates **its own DB client** via `getRequestDb(env)` (`lib/request-db.ts:11-14`, no caching — fresh `createDb()` each call) and runs **2 sequential queries**: `apikey WHERE key = ?` (indexed: `apikey_key_idx`, migration `0021`) then `organization_subscriptions WHERE organization_id = ?` (unique index). Result cached in KV for ≤24h.
2. `dbContextMiddleware` (`app.ts:149`, `middleware/db-context.ts:15-32`) → creates the request-scoped client, `c.set("db", ...)`.
3. `rateLimitMiddleware` (`middleware/rate-limit.ts`) → Cloudflare Rate Limiting binding, no DB.
4. `workspaceValidationMiddleware` (`middleware/workspace-validation.ts:24`) → only when a `workspace_id` is present: parallel KV gets (`ws-valid:{org}:{ws}`, 5-min TTL); on miss, one `workspaces WHERE organization_id = ? AND id IN (...)` query (covered by `workspaces_org_idx`), KV puts deferred via `waitUntil`.
5. `usageTrackingMiddleware` (`middleware/usage-tracking.ts:201`) → non-GET: **blocking KV `get usage:{org}:{month}`** before the handler; KV put deferred. After the response, `persistUsageAndLogs` (`usage-tracking.ts:141-199`) runs in `waitUntil`: **1 INSERT into `api_request_logs` for every authenticated request (GET included)** plus an `INSERT ... ON CONFLICT DO UPDATE` on `usage_records` for billable requests.
6. Route handler uses `c.get("db")` — except where it calls service helpers that internally call `createDb()` again (e.g. `services/ad-service.ts:195,380,451,597,772,824,861`, `services/token-refresh.ts:29,81`, `routes/connections.ts:41`, `routes/connect.ts:873`).

### 3. Dashboard request path (`apps/app/src/middleware/index.ts:252-422`)

1. `getDb()` (`:271-278`) — lazy `createDb(HYPERDRIVE.connectionString)` per request.
2. `getAuth()` (`:280-294`) — lazy `createAuth(db, env)` → **full `betterAuth()` construction per request** (drizzle adapter + apiKey/admin/organization plugins, `packages/auth/src/index.ts:35-126`). Unavoidable per-request because the embedded DB client can't cross request boundaries on Workers, but it is pure-CPU overhead on every session-resolving request.
3. Session resolution (`:326-345`): internal `/api/*` paths first try the signed cookie cache (`getCookieCache`, no DB). Otherwise `auth.api.getSession()` — on cookie-cache miss (Better Auth `cookieCache.maxAge` = 5 min, `packages/auth/src/index.ts:55-60`) this issues `SELECT ... FROM auth.session WHERE token = ?` plus a user fetch. **`auth.session` has no index on `token`** (`packages/db/src/schema.ts:58-75`; verified: no `CREATE INDEX` on `session` in any of the 40 migrations) → sequential scan per lookup.
4. Org summary (`:361-369`, `getOrganizationSummary :172-224`): KV `org-summary:{orgId}` (10-min TTL) → on miss 1 query on `auth.organization` PK; KV put via `waitUntil`.
5. Onboarding check (`:392-406`, only when no active org): 2 parallel queries — `member WHERE userId = ?` (`:230-235`) and `invitation WHERE email = ? AND status = 'pending'` (`:244-247`). **Neither `auth.member` nor `auth.invitation` has any index** (FK constraints only, which do not create indexes in Postgres).
6. Session create hook (`packages/auth/src/index.ts:64-87`): `member WHERE userId = ? LIMIT 1` on every login — also unindexed.

## Per-request work

### apps/api `/v1/*` (warm KV, no workspace_id in request)

| # | Op | Detail |
|---|----|--------|
| 1 | KV read | `apikey:{sha256}` (auth) |
| 2 | Crypto | SHA-256 of bearer token (`auth.ts:31-38`) — cheap, WebCrypto |
| 3 | JS | `createDb()` — postgres.js client alloc + drizzle 82-table schema map (`db-context.ts`) |
| 4 | Rate limiter | CF binding call |
| 5 | KV read | `usage:{org}:{month}` — **blocking, non-GET only** (`usage-tracking.ts:246`) |
| 6 | DB | route handler queries (1–N; first query on the fresh client pays connection setup to the Hyperdrive proxy) |
| 7 | Crypto | AES-256-GCM decrypt of `social_accounts.access_token`/`refresh_token` wherever tokens are read (`lib/crypto.ts`; CryptoKey memoized per isolate at `crypto.ts:20-35`) |
| 8 | deferred KV write | usage counter put (`waitUntil`) |
| 9 | deferred DB write | `INSERT api_request_logs` (+ `usage_records` upsert if billable) via `waitUntil` (`usage-tracking.ts:146-191`) |

KV-miss auth adds: 1 extra `createDb()` + 2 sequential DB reads + 1 KV put.

### apps/app dashboard page (cookie cache cold)

1. `createDb()` + `betterAuth()` construction (CPU).
2. `SELECT auth.session WHERE token = ?` — **unindexed**.
3. `SELECT auth.user WHERE id = ?` (PK).
4. KV read `org-summary:{org}` (→ DB on miss, PK lookup).
5. (no active org only) `member WHERE userId` + `invitation WHERE email` — both unindexed.

## External calls

- **Hyperdrive** (`wrangler.jsonc:58-63`, binding `HYPERDRIVE`): all Postgres traffic; postgres.js connects to the zone-local Hyperdrive proxy, which pools origin connections server-side. `max: 5` per client × N clients per request is the worker-side ceiling.
- **Workers KV** (`KV`): API-key cache (24h TTL), usage counters (35d TTL), workspace-validation cache (5 min), org-summary cache (10 min), usage-warning dedup flags.
- No R2/queue ops originate from the data layer itself.

## Performance notes

### Index coverage — confirmed gaps (query site ↔ schema cross-reference)

The `public` schema is well-indexed (198 index definitions; org-scoped composites, partial unique indexes, a BRIN on the partitioned `automation_step_runs`, covering indexes for cursor pagination on `posts`/`contacts`/`external_posts`). The gaps are concentrated in the **`auth` schema**, which has **zero indexes besides primary keys and the three `apikey` indexes**:

| Missing index | Queried at | Frequency |
|---|---|---|
| `auth.session(token)` (should be UNIQUE) | Better Auth `getSession` — `apps/app/src/middleware/index.ts:337` | Every dashboard request on cookie-cache miss (5-min cache window) |
| `auth.member(userId)` | `packages/auth/src/index.ts:66-70` (every session create), `apps/app/src/middleware/index.ts:230-235`, `apps/api/src/routes/inbox-feed.ts:543,1609,1746,1879` | Login + onboarding + inbox assignment |
| `auth.member(organizationId)` | `apps/api/src/services/notification-manager.ts:185-188` (runs inside `waitUntil` for usage warnings), `services/token-refresh.ts:115-118`, `services/weekly-digest.ts` | Notification fan-out |
| `auth.user(email)` (should be UNIQUE) | Better Auth email/password sign-in | Every credential login |
| `auth.invitation(email, status)` | `apps/app/src/middleware/index.ts:244-247` | Onboarding-path only |
| `media(storage_key)` | `apps/api/src/queues/media-cleanup.ts:20` — `DELETE FROM media WHERE storage_key = ?` with **no org filter** → full-table scan per queue message | R2 lifecycle queue |
| `broadcast_recipients(contact_id)` | `apps/api/src/routes/contacts.ts:1249` (contact merge) | Rare |

Checked-and-fine examples: `apikey.key` (indexed, migration `0021`), `post_targets.platform_post_id` lookups always carry `social_account_id` which is indexed (`services/external-post-sync/sync.ts:342-350`), `inbox_messages` dedup/platform-id lookups (indexed), `social_accounts(platform, webhook_account_id)` for webhook routing (indexed), `contact_subscriptions(contact_id)` covered by composite PK prefix.

### Unindexable search patterns

Leading-wildcard `ILIKE '%term%'` cannot use btree indexes; all rely on the org-scoped index to bound the scan:

- `inbox_messages.text` — `services/inbox-persistence.ts:371` (largest table among these; org+created index bounds it but still scans all org messages).
- `contacts.name/phone/email` — `routes/contacts.ts:480-482`.
- `social_accounts.displayName/username` — `routes/accounts.ts:440-441`; `automations.name` — `routes/automations.ts:193`; `workspaces.name` — `routes/workspaces.ts:152` (all small per-org).

A `pg_trgm` GIN index on `inbox_messages.text` (or scoping search to recent messages) is the only one likely to matter.

### Write-side overhead

- **`idx_automations_graph_gin`** (`schema.ts:2597`): GIN index over the entire `automations.graph` jsonb document. No query in the codebase uses jsonb containment/path operators on `graph` (verified by grep — the only `@>` usages are on `ad_accounts.metadata`, `content_templates.tags`, `contacts.tags`). Every automation save re-indexes the whole graph for nothing.
- **`api_request_logs`**: one INSERT per authenticated request (`usage-tracking.ts:146-155`), bigserial PK + 2 btree indexes, **no pruning/retention job anywhere** (grep confirms no DELETE on `apiRequestLogs`) and no partitioning (unlike `automation_step_runs`, which is range-partitioned with a BRIN index). Unbounded growth; per-request origin write through Hyperdrive.

### Client lifecycle

- `dbContextMiddleware` correctly centralizes the request-scoped client, but request-path services bypass it: `routes/connections.ts:41`, `routes/connect.ts:873`, `services/ad-service.ts` (7 sites, called from `/v1/ads` handlers), `services/token-refresh.ts:29,81` (called when account tokens need refresh during a request), `services/slot-finder.ts:180`, `services/webhook-delivery.ts:113`, `services/notification-manager.ts:89,179`. Each extra `createDb()` = postgres.js pool alloc + drizzle 82-table map + fresh connection on first query (losing postgres.js's per-connection prepared-statement cache) + an orphaned socket (no `.end()`). Cron/queue consumers creating their own client is fine; doing it mid-request is waste.
- `getRequestDb` (`lib/request-db.ts:11-14`) does **not** memoize — `hydrateApiKey` and any other caller each get a new client.
- `max: 5` per client: Workers cap simultaneous outbound connections at 6 per request, so a request that touches 2+ clients can theoretically exceed the cap under parallel query load.

### Migrations

40 migrations, 2,375 total SQL lines — not bloated. Notable churn: `0023_marvelous_tomorrow_man.sql` (24KB) created a v0 automation system with two enum types containing **~120 and ~95 values** plus 10 tables; `0030_drop_legacy_automations.sql` dropped all of it eight days later and `0031/0032` rebuilt it. No runtime impact (dropped cleanly), but `0032` hand-creates monthly partitions for `automation_step_runs` only through **2026-07** — inserts will fail at the partition boundary unless new partitions are added (operational risk flagged in the schema comment at `schema.ts:2751-2755`).

### Encrypted columns (AES-256-GCM, `enc:` prefix, `apps/api/src/lib/crypto.ts`)

| Column | Site |
|---|---|
| `social_accounts.access_token`, `social_accounts.refresh_token` | `schema.ts:338-339` — decrypted on every publish/token-read (`lib/accounts.ts:24-26`) |
| `byos_configs.access_key_id`, `byos_configs.secret_access_key` | `schema.ts:807-808` |
| `short_link_configs.api_key` | `schema.ts:2218` |

CryptoKey import is memoized per isolate (`crypto.ts:20-35`), so decrypt cost is a single SubtleCrypto op per token — appropriately cheap.
