# OAuth Connect + Token Lifecycle

## Overview

This flow covers how a customer connects a social account (21 platforms) and how access tokens are kept alive afterwards. Three sub-flows:

1. **Connect URL generation** — `GET /v1/connect/{platform}` returns an `auth_url`; state is parked in KV.
2. **Platform redirect → callback → token exchange → account upsert** — the provider redirects the browser to `GET /connect/oauth/callback` (no auth middleware), which runs the shared `exchangeAndSaveAccount()` and 302-redirects the user back to the customer's `redirect_url`. The same exchange logic is also reachable headlessly via `POST /v1/connect/{platform}`.
3. **Token refresh** — proactive (daily cron → `REFRESH_QUEUE` → `refreshAccountToken`) and on-demand (`refreshTokenIfNeeded` called from publish/sync/analytics/broadcast paths when a token expires within 5 minutes).

Key files:

- `apps/api/src/routes/connect.ts` — all connect routes + shared `exchangeAndSaveAccount()` (2,896 lines)
- `apps/api/src/routes/oauth-callback.ts` — browser-facing GET callback
- `apps/api/src/config/oauth.ts` — per-platform `OAUTH_CONFIGS`, `buildAuthUrl`, `exchangeCode`, PKCE/state helpers
- `apps/api/src/config/api-versions.ts` — pinned Meta/Threads/LinkedIn/etc. versions (`GRAPH_BASE.*`)
- `apps/api/src/services/token-refresh.ts` — cron enqueue, queue refresh, on-demand refresh
- `apps/api/src/services/ad-access-token.ts` — Meta ads user-token stored (encrypted) inside `social_accounts.metadata`; `sanitizeSocialAccountMetadata` strips it from API responses
- `apps/api/src/lib/crypto.ts` — AES-256-GCM `encryptToken`/`decryptToken`; imported `CryptoKey` is memoized per isolate (`keyCache`, crypto.ts:19)
- `apps/api/src/routes/accounts.ts`, `apps/api/src/routes/connections.ts` — account list/health/per-account endpoints and connection logs

Mounting (`apps/api/src/app.ts`):

- `app.route("/connect/oauth", oauthCallback)` at app.ts:127 — mounted **before** `/v1/*` auth/db middleware, so the callback handler has no request-scoped `db` and no API-key auth (state token is the auth).
- `app.route("/v1/connect", connect)` at app.ts:205 — behind the full `/v1/*` middleware stack (auth → dbContext → rateLimit → readOnly → bodyCache → workspaceValidation → workspaceScope → usageTracking).

## Step-by-step trace

### 1. Connect URL generation — `GET /v1/connect/{platform}` (connect.ts:2655)

1. Route-level middleware `assertWriteAccess` / `assertAllWorkspaceScope` (connect.ts:71–78) — in-memory checks.
2. Validate `redirect_url` against the static allowlist (`isAllowedCustomerRedirectUrl`, lib/customer-redirect.ts:12 — pure URL parse, no I/O).
3. Resolve `oauthConfig` from `OAUTH_CONFIGS[platform]` or `INSTAGRAM_DIRECT_CONFIG` when `method=direct` (connect.ts:2677–2680).
4. `generateStateToken()` (oauth.ts:340) — 32 random bytes, hex.
5. If `requiresPkce` (Twitter only): `generatePkce()` (oauth.ts:351) — one SHA-256 digest.
6. **KV.put** `oauth-state:{state}` with `{org_id, platform, method, redirect_url, code_verifier}`, TTL 600s (connect.ts:2718–2728). Awaited.
7. `buildAuthUrl()` (oauth.ts:377) — pure string building. Return `{ auth_url }`.

Per-request cost: standard `/v1` middleware (API-key KV lookup, etc.) + 1 KV write + ≤1 SHA-256. Cheap.

### 2. Provider redirect → `GET /connect/oauth/callback` (oauth-callback.ts:25)

1. **KV.get** `oauth-state:{state}` (oauth-callback.ts:36). Missing → 400.
2. **KV.delete** the state key (one-time use, oauth-callback.ts:46). Awaited, serialized before the exchange.
3. Re-validate `redirect_url` (oauth-callback.ts:49).
4. Provider error / missing code → immediate 302 back to customer with error params.
5. `await exchangeAndSaveAccount({...})` (oauth-callback.ts:78) — **the entire heavy pipeline below runs serially while the end-user's browser is blocked on a 302**.
6. 302 redirect with `status=success|pending_selection|error`.

### 3. `exchangeAndSaveAccount()` (connect.ts:627–1043) — serial pipeline

All of the following are sequential `await`s; nothing is deferred with `waitUntil` (the function has no access to an `ExecutionContext`):

1. **Token exchange** — `exchangeCode()` (oauth.ts:411): one external `fetch` POST to the platform token URL. Note: **bare `fetch`, no timeout** (oauth.ts:454), unlike the refresh paths which use `fetchWithTimeout(15s)`.
2. **Long-lived token exchange** (Meta family only), serialized after step 1:
   - Threads: `GET graph.threads.net/access_token?...` (connect.ts:660)
   - Instagram direct: `GET {GRAPH_BASE.instagram}/access_token?...` (connect.ts:683)
   - Facebook / Instagram-via-FB: `GET {GRAPH_BASE.facebook}/oauth/access_token?grant_type=fb_exchange_token...` (connect.ts:700)
3. **Profile fetch** — `fetch(oauthConfig.profileUrl)` (connect.ts:731), serialized after step 2 even though the short-lived token from step 1 would already authorize it. Bare `fetch`, no timeout.
4. Instagram-via-FB only: extra `GET /me/accounts?fields=instagram_business_account{...}` to resolve the IGBA (connect.ts:769).
5. **Branch A — secondary-selection platforms** (facebook, linkedin, pinterest, googlebusiness, snapchat; connect.ts:856–869): AES-GCM encrypt the user token → **KV.put** `pending-secondary:{orgId}:{platform}` (TTL 600) → return `pending_selection`. Flow continues later via the list/select endpoints (see §5).
6. **Branch B — single-step platforms**:
   1. `createDb(env.HYPERDRIVE.connectionString)` (connect.ts:873) — a **new postgres client**, even when invoked from `POST /v1/connect/{platform}` where `dbContextMiddleware` already created one.
   2. 2× AES-GCM encrypt (access + refresh token, connect.ts:876–877).
   3. **DB upsert** into `social_accounts` with `ON CONFLICT (org, platform, platform_account_id)` + `RETURNING` (connect.ts:880–909).
   4. **Avatar re-host** (connect.ts:923–932): `rehostAvatar()` = external fetch of the CDN image (5s timeout, avatar-store.ts:36) + **R2 put** + a **second DB UPDATE** of `social_accounts`. Awaited; "best-effort" but on the critical path.
   5. New-account detection (`updatedAt - connectedAt < 5000`, connect.ts:935), then:
      - `await dispatchWebhookEvent(...)` (connect.ts:938) — DB select of all enabled `webhook_endpoints` for the org, then for each matching endpoint `deliverWebhook()`: KV.get webhook secret + AES decrypt + HMAC sign + SSRF DNS check + up to **3 POST attempts with 5s timeout each and 1s/4s sleeps between attempts** (webhook-delivery.ts:84–108) + `webhook_logs` INSERT. All awaited inside the callback.
      - `await logConnectionEvent(...)` (connect.ts:944/952) — `createDb()` **again** (connections.ts:41) + 1 INSERT into `connection_logs`.
   6. YouTube: `INBOX_QUEUE.send` for PubSubHubbub subscribe (connect.ts:963) — queue send, cheap.
   7. Instagram: `await verifyInstagramWebhookSubscription(...)` (connect.ts:982) — **2 serialized Graph fetches** (check subscriptions, then create/update) — followed by `await subscribeInstagramAccount(...)` (connect.ts:996) — 1 more Graph POST. ~3 Graph round trips, all blocking.
   8. Sync-capable platforms: `social_account_sync_state` upsert + `SYNC_QUEUE.send` (connect.ts:1005–1028).
   9. Ads-capable platforms: `await discoverAdAccounts(env, orgId, account.id)` (connect.ts:1034) — see §4. Awaited (the comment says "non-critical", yet it is not deferred).

### 4. `discoverAdAccounts()` (services/ad-service.ts:182)

1. `createDb()` — third postgres client of the request (ad-service.ts:195).
2. DB select of the social account.
3. `resolveAdsAccessToken()` (ad-access-token.ts:126) — picks the encrypted Meta ads *user* token from `metadata.meta_ads_user_access_token` (Facebook) or `accessToken`, 1 AES decrypt.
4. `adapter.listAdAccounts(token, ...)` — external Marketing API fetch.
5. For Meta (`listPromotablePages` defined): DB select of **all** the org's facebook/instagram accounts, then `listPromotablePages` per ad account, batched at concurrency 5 (ad-service.ts:286–302) — **O(adAccounts/5) serialized rounds of external fetches** — then ad-account upserts.

### 5. Secondary selection (facebook pages / linkedin orgs / pinterest boards / GBP locations / snapchat profiles)

`GET /v1/connect/facebook/pages` (connect.ts:1791): KV.get pending token → AES decrypt → 1 Graph fetch `/me/accounts`. Similar shape for linkedin (`fetchLinkedInAccessibleOrganizations` = orgAcls + organizationsLookup, 2 fetches), pinterest (1), googlebusiness (**2 fetches + 1 KV.put** to persist `google_account_name`, connect.ts:2354–2385), snapchat (1).

`POST /v1/connect/facebook/pages` (connect.ts:1837):
1. KV.get pending → AES decrypt.
2. Graph `GET /me/accounts` (again — the page list is re-fetched rather than cached from the list call).
3. Graph `GET /{page}/picture` (avatar).
4. DB select existing account (for metadata merge) → `withMetaAdsUserAccessToken()` stores the **encrypted** user token + expiry inside `metadata` (ad-access-token.ts:104).
5. AES encrypt page token → DB upsert.
6. `await rehostAvatar(...)` + second DB UPDATE (connect.ts:1959–1966).
7. Webhook dispatch + connection log via `c.executionCtx.waitUntil` (connect.ts:1971–1996) — **correctly deferred here**, unlike `exchangeAndSaveAccount`.
8. `subscribeFacebookPage` and `discoverAdAccounts` via `waitUntil` (connect.ts:2001–2019) — also deferred.
9. `await KV.delete(pending-secondary:...)` → 201.

The other select endpoints (linkedin connect.ts:2076, pinterest :2220, GBP :2413, snapchat :2566) each do: KV.get → AES decrypt → **AES re-encrypt of the same plaintext** (e.g. connect.ts:2098–2099) → upsert → KV.delete; webhook/log deferred with `waitUntil`. Pinterest adds one profile fetch.

### 6. Other connect variants

- **Bluesky** (connect.ts:1208): 1 external `createSession` POST → encrypt app password → upsert → webhook/log via `waitUntil` (deferred — good).
- **Newsletter platforms** (beehiiv/convertkit/mailchimp/listmonk, connect.ts:1052–1205): 1 credential-validation fetch → encrypt → upsert → webhook via `waitUntil`. ListMonk additionally runs `isBlockedUrlWithDns` (a DNS-over-HTTPS lookup).
- **Telegram**: KV-code based; `initTelegram` 1 KV.put, `pollTelegram` 1 KV.get, direct connect = 1 upsert.
- **WhatsApp embedded signup** (connect.ts:1503): 3 serialized Graph fetches (token exchange → debug_token → phone_numbers) → encrypt → upsert → webhook/log/subscription verification all via `waitUntil` (deferred — good).

### 7. Token refresh — proactive (cron)

- `handleScheduled` (scheduled/index.ts:44–49): daily at 09:00 UTC → `enqueueExpiringTokenRefresh(env)`.
- `enqueueExpiringTokenRefresh` (token-refresh.ts:28): pages through `social_accounts` where `token_expires_at IS NOT NULL AND token_expires_at < now()+7d AND platform NOT IN (no-expiry list)` in batches of 1000 (keyset on `id`), sends to `REFRESH_QUEUE` in batches of 100. **No lower bound on `token_expires_at`** — accounts whose token expired months ago and that have no refresh path are re-selected and re-enqueued every day, forever. **No index on `token_expires_at`** (schema.ts:360–367: only org / (platform,webhook_account_id) / workspace indexes) → the daily scan cannot use an index for the range predicate.
- Queue consumer (queues/token-refresh.ts:14): concurrency 10 → `refreshAccountToken(env, accountId)` per message.
- `refreshAccountToken` (token-refresh.ts:80): DB select account → 2 AES decrypts → `refreshTokenDirect` (platform-specific external POST, `fetchWithTimeout` 15s) →
  - on failure: `connection_logs` INSERT + select **all org members** + `sendNotification` per member (fire-and-forget) — repeated **daily** for permanently dead accounts;
  - on success: 1–2 AES encrypts → `fetchAvatarUrl` (1 external fetch) → `rehostAvatar` (1 external fetch + R2 put) → DB UPDATE → `connection_logs` INSERT.

### 8. Token refresh — on-demand

`refreshTokenIfNeeded` (token-refresh.ts:191) is called from posting (`routes/posts.ts:2432`, `publisher-runner.ts:141`), analytics refresh, broadcast processor, cross-post processor, and external post sync.

1. `decryptAccountTokens` — 2 AES decrypts (key import memoized; sub-ms).
2. No `tokenExpiresAt` or >5 min remaining → return immediately (the common fast path: decrypt only).
3. Within 5 min of expiry: **KV.get** lock → if held: **fixed 2,000 ms sleep** (token-refresh.ts:218) + new `createDb()` + DB re-read + AES decrypt. If not held: **KV.put** lock (TTL 30s; get-then-put is not atomic, so the lock is advisory) → external refresh POST → 1–2 AES encrypts → new `createDb()` + DB UPDATE → **KV.delete** lock.

### 9. Account read endpoints (decryption audit)

- `GET /v1/accounts` (accounts.ts:425) and `GET /v1/accounts/health` (accounts.ts:312) select explicit column lists that **exclude** `access_token`/`refresh_token` — **no decryption on list paths**. Metadata is passed through `sanitizeSocialAccountMetadata` (strips the encrypted Meta ads token keys).
- `GET /v1/accounts/{id}` (accounts.ts:500) — same, no token columns.
- Per-account platform endpoints (`/{id}/facebook-pages`, `/linkedin-organizations`, `/pinterest-boards`, `/reddit-subreddits`, `/gmb-locations`, `/youtube-playlists`, `/tiktok-creator-info`) all call `getOwnedAccount` (lib/accounts.ts:9) which does `SELECT *` + decrypts **both** tokens. The GET variants need the access token (they call the platform). The **PUT metadata setters** (`setFacebookPage` accounts.ts:885, `setLinkedInOrg` :1012, `setPinterestBoard` :1157, `setRedditSubreddit` :1344, `setGmbLocation` :1571, `setYoutubePlaylist` :1729) also decrypt both tokens but never use them.
- `GET /v1/connections/logs` (connections.ts:81) runs the page query **and a full `COUNT(*)`** over the org's logs in parallel, and — despite returning `next_cursor` — never reads a cursor parameter (only `{limit, from, to}` at connections.ts:83), so pagination always returns page 1.

## Per-request work (browser OAuth callback, single-step platform, e.g. Twitter/TikTok/Threads — worst observed ordering)

| # | Operation | Where |
|---|-----------|-------|
| 1 | KV.get `oauth-state:*` | oauth-callback.ts:36 |
| 2 | KV.delete `oauth-state:*` | oauth-callback.ts:46 |
| 3 | External POST token exchange (no timeout) | oauth.ts:454 |
| 4 | (Meta family) external GET long-lived exchange | connect.ts:660/683/700 |
| 5 | External GET profile (no timeout) | connect.ts:731 |
| 6 | (IG-via-FB) external GET /me/accounts | connect.ts:769 |
| 7 | `createDb()` #1 (new postgres client) | connect.ts:873 |
| 8 | AES-GCM encrypt ×2 | connect.ts:876–877 |
| 9 | DB upsert `social_accounts` RETURNING | connect.ts:880 |
| 10 | External GET avatar (≤5s) + R2 put + DB UPDATE | connect.ts:924–929, avatar-store.ts:36–48 |
| 11 | DB select `webhook_endpoints` + per-endpoint: KV.get secret, AES decrypt, HMAC, DNS SSRF check, ≤3 POSTs (5s timeout each) with 1s/4s sleeps, DB INSERT `webhook_logs` | connect.ts:938, webhook-delivery.ts:57–123 |
| 12 | `createDb()` #2 + DB INSERT `connection_logs` | connect.ts:944, connections.ts:41 |
| 13 | (YouTube) queue send; (Instagram) 3 external Graph fetches for webhook subscription | connect.ts:963/982/996 |
| 14 | (sync platforms) DB upsert sync state + queue send | connect.ts:1005–1028 |
| 15 | (ads platforms) `createDb()` #3 + DB select ×2 + AES decrypt + external listAdAccounts + N/5 rounds of listPromotablePages + DB upserts | connect.ts:1034, ad-service.ts:182–330 |
| 16 | 302 redirect issued | oauth-callback.ts:101 |

Everything in rows 3–15 is serialized in front of the user's redirect.

## External calls

- **Token endpoints**: per-platform `tokenUrl` in `OAUTH_CONFIGS` (oauth.ts) — x.com, graph.facebook.com (v25.0 via `GRAPH_BASE`), api.instagram.com, linkedin.com, open.tiktokapis.com, oauth2.googleapis.com, api.pinterest.com, reddit.com, graph.threads.net, accounts.snapchat.com, mastodon.social.
- **Long-lived exchanges**: graph.threads.net, graph.instagram.com/v25.0, graph.facebook.com/v25.0.
- **Profile endpoints**: per-platform `profileUrl`.
- **Webhook subscriptions**: graph.facebook.com / graph.instagram.com (`/me/subscribed_apps`, `/{app}/subscriptions`).
- **Ad discovery**: Meta Marketing API (list ad accounts, promotable pages).
- **Avatar CDN fetches** + R2 (`MEDIA_BUCKET`) puts.
- **Customer webhook endpoints** (retry ×3, 5s timeout each).
- **Refresh endpoints** (token-refresh.ts): api.x.com, graph.instagram.com/v25.0, linkedin.com, open.tiktokapis.com, oauth2.googleapis.com, api.pinterest.com, graph.threads.net, accounts.snapchat.com, reddit.com — all `fetchWithTimeout(15s)`.

## Performance notes

1. **Critical:** `exchangeAndSaveAccount` awaits webhook dispatch (3 attempts × 5s + 1s/4s backoff per endpoint), connection-log insert, Instagram webhook subscription (3 Graph fetches), avatar re-host (5s fetch + R2 + extra UPDATE) and full ad-account discovery — all before the browser 302. Worst case adds tens of seconds; typical case adds 4–8 serialized external round trips (~1–4s) to every successful connect. The Bluesky/Telegram/WhatsApp/select-page handlers already use `c.executionCtx.waitUntil` for the same work; the shared function just needs a `waitUntil` parameter.
2. The long-lived token exchange and profile fetch (Meta family) are serialized though the profile fetch is valid with the short-lived token — `Promise.all` would save one Graph round trip.
3. `exchangeCode` and the profile fetch use bare `fetch` with no timeout; a hung provider stalls the callback until the Workers runtime kills it.
4. One callback creates up to three `postgres()` clients (`exchangeAndSaveAccount`, `logConnectionEvent`, `discoverAdAccounts`); each is a fresh connection to the Hyperdrive proxy.
5. On-demand refresh contention path sleeps a flat 2s (token-refresh.ts:218) — felt on publish fan-out when several targets share an account near expiry.
6. The daily refresh cron has no lower bound on `token_expires_at` and no failure marker: permanently-expired accounts are re-scanned, re-fetched, re-decrypted, re-attempted against the provider, and members re-notified **every day**; the scan itself has no usable index on `token_expires_at`.
7. Account list/get/health endpoints select explicit columns and never decrypt tokens — good. Only the PUT metadata setters decrypt tokens needlessly via `getOwnedAccount`'s `SELECT *`.
8. `GET /v1/connections/logs` runs an unbounded `COUNT(*)` per call and ignores its own cursor (always page 1).
9. AES-256-GCM cost is negligible: the imported key is memoized per isolate (crypto.ts:19–34); each encrypt/decrypt is a single SubtleCrypto call on a <1KB payload.
10. `POST /v1/accounts/sync` (forceSync, accounts.ts:2100–2117) upserts sync state in a serial per-account loop — O(n) DB round trips for large orgs.
