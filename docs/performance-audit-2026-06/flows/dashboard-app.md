# Astro Dashboard App (apps/app)

## Overview

`apps/app` is the RelayAPI dashboard: an Astro 5 SSR app (`output: "server"`) deployed on Cloudflare Workers via `@astrojs/cloudflare` (`apps/app/astro.config.mjs:7-24`). It serves three kinds of traffic from one worker:

1. **Marketing pages** — `/`, `/pricing`, `/product/[slug]`, `/privacy`, `/terms` (`src/pages/*.astro`).
2. **Dashboard pages** — everything under `/app/*` (~35 pages in `src/pages/app/`). Each page is a thin `.astro` wrapper that mounts a single React island (`client:load`) wrapping `DashboardShell` + the page component. Navigation between pages is **full document navigation** (intentional MPA architecture per CLAUDE.md — no SPA router).
3. **Internal API routes** — ~150 endpoints under `/api/*` (`src/pages/api/`) that proxy browser requests to the main API (`apps/api`) through `@relayapi/sdk`, plus a handful of app-local routes (auth, notifications, avatars, billing).

Bindings (`apps/app/wrangler.jsonc`): `KV` (dashboard API key + org-summary cache), `HYPERDRIVE` (Postgres for Better Auth + notifications), `AVATARS_BUCKET` / `PUBLIC_ASSETS` (R2), `EMAIL_QUEUE` (invitation emails). Observability is enabled at `head_sampling_rate: 1` with persisted invocation logs (`wrangler.jsonc:8-22`).

The SDK is aliased to source in dev (`astro.config.mjs:16-22`) and `lib/relay.ts` builds per-org `Relay` clients from a raw key stored in KV (`dashboard-key:{orgId}`), cached in a module-level `Map` for 60s (`src/lib/relay.ts:9-10,38-60`).

### Entry points

- Every request → `src/middleware/index.ts` (`onRequest`, line 252).
- HTML pages → `.astro` pages → `Layout.astro` / `DashboardLayout.astro`.
- `/api/*` → Astro endpoint modules under `src/pages/api/`.
- `/api/auth/[...all]` → Better Auth handler (session, OAuth, organization plugin).

## Step-by-step trace: `GET /app/posts` (desktop, returning user)

### 1. Middleware (`src/middleware/index.ts:252-422`)

1. `isStaticAssetPath(path)` (line 255) — extension check; static assets short-circuit (in production Workers Assets serves `dist/client/_astro/*` before the worker anyway).
2. Lazy `getDb()` / `getAuth()` getters installed on `context.locals` via `Object.defineProperty` (lines 271-306). `createDb` builds a new postgres-js client per request (no I/O until first query; Hyperdrive holds the real pool — `packages/db/src/client.ts:19-33`, `prepare: true, max: 5, fetch_types: false`).
3. `shouldResolveSession("/app/posts")` → true (line 57-64).
   - `/app/*` is a **page** path, so the `getCookieCache` fast path (line 329-334, internal-API-only) is skipped. The middleware calls `getAuth().api.getSession({ headers, returnHeaders: true })` (line 337-346).
   - `getAuth()` constructs a **fresh `betterAuth(...)` instance per request** (middleware line 280-294 → `packages/auth/src/index.ts:35-126`: drizzle adapter, apiKey + admin + organization plugins, cookie cache enabled with `maxAge: 5*60`).
   - With a valid `session_data` cookie (< 5 min old), Better Auth validates the HMAC (WebCrypto) and returns the session **without any DB round trip**. With a stale/absent cookie cache it queries Postgres (session + user lookups via Hyperdrive) and re-issues the cookie via `authHeaders`.
4. `session.activeOrganizationId` is set for normal users (seeded at session creation by the `databaseHooks.session.create.before` hook — `packages/auth/src/index.ts:61-90`).
5. `shouldLoadOrganizationSummary("/app/posts")` → true → `getOrganizationSummary(db, KV, waitUntil, orgId)` (middleware lines 361-369 → 172-224):
   - **1 KV read** `org-summary:{orgId}` (10-min TTL). On hit: parse JSON, done. On miss: **1 DB select** on `auth.organization` + KV `put` deferred via `waitUntil`.
   - This KV read is **serialized after** session resolution (org id comes from the session).
6. Onboarding check (lines 392-406) is skipped when `activeOrganizationId` exists (the common case). Otherwise: **2 parallel DB queries** (`member`, `invitation`).
7. `finalize()` merges auth `set-cookie` headers and sets `Cache-Control: no-cache, no-store` on HTML (lines 312-324).

**Serialized I/O before SSR starts (warm path): 0 DB + 1 KV read.** Cold cookie-cache path: 1-2 DB round trips (Better Auth) → 1 KV read → possibly 1 more DB read on KV miss = up to ~4 serialized I/O hops before render.

### 2. Page render (`src/pages/app/posts.astro:1-21`)

- `getDashboardRouteContext(Astro.locals, Astro.url)` and `getPostsPageRouteState(Astro.url)` are pure functions over locals/query params (`src/lib/dashboard-page.ts:48-105`) — **no data fetching in the page frontmatter** (per CLAUDE.md: no `initial*Data` server bootstrapping).
- `DashboardLayout.astro` emits the document: inline font-fallback CSS variables, `<link rel="preconnect" href="https://api.relayapi.dev">`, imports `styles/globals.css`.
- `<PostsRouteApp client:load ... />` — Astro server-renders the React tree (DashboardShell → Sidebar → DashboardPageGuard → PostsPage skeleton) and ships the island. CPU-only.

First byte ≈ middleware I/O (above) + SSR CPU.

### 3. Client load & hydrate

- CSS: single compiled stylesheet `globals.BJ0dPmKE.css` (**168 KB raw**, includes the whole app's Tailwind output) — render-blocking.
- Fonts: `@fontsource-variable/geist` + `geist-mono` via CSS `@import` (`src/styles/globals.css:3-4`), self-hosted woff2 with unicode-range subsets; metric-compatible local fallbacks defined (`globals.css:6-22`). No `<link rel="preload">` for the latin subset.
- JS for /app/posts: `client.*.js` (react-dom, 182 KB) + `create-dashboard-route-app.*.js` (58 KB shell) + `posts-page.*.js` (44 KB) + shared chunks; `calendar-view.*.js` (68 KB) and `new-post-dialog.*.js` (47 KB) are `lazy()` chunks (`posts-page.tsx:58-68`). reactflow lives only in `automation-detail-route-app.*.js` (346 KB, statically imported by `automation-detail-page.tsx:36-38`, but route-chunked to `/app/automation/[id]`). No three.js / tsparticles chunks exist in the build (see Performance notes).

### 4. Post-hydration effects (default state: tab=`all`, view=`calendar`, desktop)

In rough firing order:

| # | Trigger | Request | Downstream work |
|---|---------|---------|-----------------|
| 1 | `usePaginatedApi("posts")` for the **"all" tab list** (`posts-page.tsx:244-253`) | `GET /api/posts?limit=20&include=targets,media&include_external=true` | middleware cookie-cache check → `requireClient` (KV `dashboard-key:` on cold isolate) → SDK `posts.list` → **external fetch to apps/api `/v1/posts`** → API auth (KV) + DB. **Result unused in calendar view** (rendered only when `viewMode==='list' \|\| isMobile`, line 596). |
| 2 | `useRealtimeUpdates` (`posts-page.tsx:286-288`, **no `defer`** → subscribes immediately, `use-post-updates.ts:147-156`) | `GET /api/ws-info` | `getRelayClient` (KV) → SDK `wsTicket.retrieve()` = **external API call**, then a **WebSocket handshake** to `wss://api.relayapi.dev/v1/ws?ticket=...`. Repeats on **every full-document navigation** (tickets are single-use, 60 s). |
| 3 | `UsageProvider` + `useDashboardApiKeyStatus` after paint (`use-usage.tsx:121-135`, `use-dashboard-api-key-status.ts:112-122`) | `GET /api/dashboard-bootstrap` (deduped in-flight via `lib/dashboard-bootstrap.ts:11-33`) | Route fans out in parallel (`api/dashboard-bootstrap.ts:27-117`): KV `dashboard-key:` + SHA-256 + KV `apikey:{hash}`; DB `count(notifications)`; SDK `usage.retrieve()` + `streaks.retrieve()` = **2 external API calls**. |
| 4 | `StreakProvider` after paint + 250 ms (`use-streak.tsx:124-134`) | shares #3 if still in flight; otherwise a **second** `/api/dashboard-bootstrap` | same as #3 |
| 5 | Sidebar notif badge at idle ≤ 1.5 s (`sidebar.tsx:346-352`) | `fetchDashboardBootstrap()` again — `pending` is cleared in `finally` (`lib/dashboard-bootstrap.ts:29-31`), so if #3 already resolved this is a **duplicate full bootstrap** (2 more API calls + DB count + KV) | same as #3 |
| 6 | `CalendarView` lazy chunk → `useCalendarPosts` (`use-calendar-posts.ts:223-226`) | `GET /api/posts?limit=100&from=...&to=...&include=media&include_external=true` — **sequential do/while pagination, up to 10 serialized pages** (`use-calendar-posts.ts:82-165`) | each page = browser → app worker → API worker → DB |
| 7 | `useCalendarPosts.fetchDrafts` (`use-calendar-posts.ts:178-215`) | `GET /api/posts?limit=100&status=draft&include=media` — up to 3 serialized pages | same chain |

**Warm-sessionStorage variant** (any navigation within 60 s of the previous one): usage/streak/key-status render from `sessionStorage`, but each schedules its own **individual background refresh** at idle — `GET /api/usage` (`use-usage.tsx:116-119`), `GET /api/streak` (`use-streak.tsx:119-121`), `GET /api/dashboard-key-status` (`use-dashboard-api-key-status.ts:107-109`) — *plus* the sidebar's `/api/dashboard-bootstrap` (#5). That is 4 internal requests fanning out to ~4 upstream API calls per navigation, all carrying data the single bootstrap endpoint already returns.

## Per-request work

### HTML page view `/app/posts` (warm)

1. Middleware: cookie-cache HMAC verify (WebCrypto) — CPU.
2. `betterAuth()` instance construction (per request) — CPU.
3. KV read `org-summary:{orgId}` — 1 I/O round trip (serialized after session).
4. SSR render of React shell — CPU.
5. (Cold variants add: 1-2 Postgres queries via Hyperdrive for session; 1 Postgres query for org summary + deferred KV put; 2 Postgres queries for the onboarding check when no active org.)

### Internal API route (e.g. `GET /api/posts`)

1. Middleware: `getCookieCache(request, secret)` (`middleware/index.ts:329-334`) — HMAC verify only, **no DB, no Better Auth instance** (fast path; falls back to full `getSession` if cookie cache is stale).
2. `requireClient` → `getRelayClient` (`lib/relay.ts:38-60`): module-cache hit (60 s TTL) or **1 KV read** `dashboard-key:{orgId}`.
3. SDK call → **1 external HTTPS fetch** to apps/api (which itself does KV auth lookup + Postgres).
4. JSON proxy back to the browser.

### `GET /api/dashboard-bootstrap` (per call)

- KV read `dashboard-key:{orgId}` (twice on a cold isolate: once at line 27, once inside `getRelayClient`), SHA-256 digest, KV read `apikey:{hash}` — serialized pair inside `keyStatusPromise`.
- 1 Postgres `count()` on `notifications` (app DB, Hyperdrive).
- 2 external API calls (`/v1/usage`, `/v1/streaks`) via SDK — parallel (`Promise.allSettled`).

### `GET /api/ws-info` (per page navigation)

- `getRelayClient` (KV on cold isolate) → SDK `wsTicket.retrieve()` = 1 external API call.

## External calls

- **apps/api (`https://api.relayapi.dev`)** — all data fetches, via `@relayapi/sdk` exclusively (audited: no raw `/v1/*` fetches anywhere in `src/pages/api/` or client components; the `/v1` strings in flow-builder files are comments). Per posts-page load: 1 wasted list call + N calendar pages + M draft pages + usage + streaks + ws-ticket ≈ **6-10 upstream API calls**.
- **WebSocket** `wss://.../v1/ws` — one per document, re-established per navigation.
- **Resend / EMAIL_QUEUE** — invitation emails only; `@react-email/render` + `resend` are dynamically imported inside the sender (`middleware/index.ts:113-118`), so the 1.7 MB email chunk stays off the request path.
- **Stripe** — billing routes only, separate lazy chunk (`stripe.esm.worker_*.mjs`, 627 KB).

## Performance notes

1. **Wasted `/api/posts` list fetch in calendar view (high).** The "all"/"queue" tab list hooks fire based on `activeTab` only (`posts-page.tsx:158,170,245`), while their results render only when `viewMode === "list" || isMobile` (`posts-page.tsx:596,670`). Default desktop state is `view=calendar` (`dashboard-page.ts:87-92`), so every default /app/posts load triggers one (all tab) or two (queue tab: scheduled + failed) full browser→app-worker→API-worker→DB chains whose payloads (20 posts with targets+media) are discarded, contending with the calendar's own fetches.
2. **Serial calendar pagination (high).** `useCalendarPosts` pages through the month sequentially at `limit=100`, up to 10 pages, then drafts up to 3 more (`use-calendar-posts.ts:82-165,178-215`). Each page is a 2-worker-hop round trip; for orgs with >100 posts/month the calendar paints only after the chain completes.
3. **Bootstrap dedup window is too narrow (medium).** `fetchDashboardBootstrap` only dedupes *in-flight* calls (`lib/dashboard-bootstrap.ts:28-31`); the sidebar re-invokes it at idle (`sidebar.tsx:346-352`), commonly producing a second full bootstrap (2 API calls + DB count + 2-3 KV ops) per page load. On warm-cache navigations the three providers additionally bypass bootstrap with individual `/api/usage`, `/api/streak`, `/api/dashboard-key-status` refreshes.
4. **WS ticket per navigation, undeferred (medium).** Pages call `useRealtimeUpdates` without `defer` (e.g. `posts-page.tsx:286`), so `/api/ws-info` + its upstream API call + the WS handshake race the critical data fetches during hydration, and repeat on every MPA navigation. `streak-toast.tsx:54` already shows the `defer: 4000` pattern.
5. **Per-request `betterAuth()` construction for page views (medium).** `getAuth()` (`middleware/index.ts:280-294`) rebuilds the full Better Auth instance (drizzle adapter, 3 plugins, route table) on every HTML request; config depends only on env + origin and could be memoized per isolate. The `getCookieCache` fast path is limited to `/api/*` (line 329) — page views always pay the full `api.getSession` pipeline.
6. **Cold start (low-medium).** The always-loaded middleware chunk is 1.6 MB (`dist/server/chunks/_virtual_astro_middleware_*.mjs`: better-auth + drizzle + full schema + zod), plus 676 KB worker entry. Heavy optional deps (react-email 1.7 MB, stripe 627 KB) are correctly lazy.
7. **Dead code / dead deps (low).** `SparklesCore` (`ui/sparkles.tsx`, tsparticles) and `workflow-connect-section.tsx` → `LazyDither` (three.js) are never imported; `three`, `@react-three/fiber`, `@react-three/postprocessing`, `postprocessing`, `@tsparticles/*` ship zero bytes to the build (verified: no `WebGLRenderer`/`tsParticles` strings in `dist/client`) but cost install/build time. `/api/notifications/stream` (SSE polling Postgres every 5 s for up to 30 min per connection) and `/api/notifications/unread-count` have no client references — superseded by the WebSocket.
8. **TTFB round trips are well controlled**: warm page view = 1 KV read + crypto + SSR CPU; internal API calls use the cookie-cache fast path and a 60 s SDK client cache. The org-summary KV read (10-min TTL) is the only serialized I/O on the warm HTML path.
9. **CLAUDE.md compliance**: navigation stays MPA (no SPA router) ✓; all app→API calls go through `@relayapi/sdk` ✓ (no violations found); internal `/api/*` auth is minimal (cookie cache only) ✓; no `initial*Data` server bootstrapping ✓ — fixes proposed here stay within those rules.
10. **Observability cost (low)**: `head_sampling_rate: 1` with `invocation_logs: true` + `persist: true` on all dashboard traffic (`wrangler.jsonc:8-22`).
