# Inbox + Messaging Flow

## Overview

The inbox/messaging subsystem ingests events from 6 platform webhook families (Facebook, Instagram, YouTube PubSub, WhatsApp Cloud API, Telegram, Twilio SMS), funnels them through a Cloudflare Queue (`INBOX_QUEUE` / `relayapi-inbox`), normalizes them, persists conversations + messages to Postgres (via Hyperdrive), triggers the automation engine, dispatches customer webhooks, and pushes realtime updates to dashboard clients via a Durable Object. On the read side, the API exposes a conversation feed, full-thread fetch, message search, stats, AI endpoints, and live comment/review fetching that proxies platform APIs. Broadcasts (generic + legacy WhatsApp-specific) fan out template/DM sends to recipient lists, driven either synchronously from the API request or by the every-minute cron.

**Entry points**

| Entry | File | Notes |
|---|---|---|
| `POST /webhooks/facebook` (FB+IG) | `apps/api/src/routes/platform-webhooks.ts:180` | HMAC verify, ack immediately, `ctx.waitUntil(processFacebookWebhook)` |
| `POST /webhooks/whatsapp` | `apps/api/src/routes/platform-webhooks.ts:666` | same pattern |
| `POST /webhooks/telegram/:secret` | `apps/api/src/routes/platform-webhooks.ts:770` | |
| `POST /webhooks/sms` (Twilio) | `apps/api/src/routes/platform-webhooks.ts:854` | |
| `POST /webhooks/youtube` (PubSub) | `apps/api/src/routes/platform-webhooks.ts:549` | |
| Queue consumer | `apps/api/src/queues/inbox.ts:8` (`consumeInboxQueue`) | `max_batch_size: 10, max_retries: 5` (wrangler.jsonc) |
| Inbox feed routes (`/v1/inbox/conversations*`, `/search`, `/stats`, `/bulk`, notes) | `apps/api/src/routes/inbox-feed.ts` | |
| Comments/reviews routes (`/v1/inbox/comments*`, `/reviews*`) | `apps/api/src/routes/inbox.ts` | live platform proxying + KV post cache |
| Inbox AI routes (`/classify`, `/suggest-reply`, `/summarize`, `/priorities`) | `apps/api/src/routes/inbox-ai.ts` | Workers AI llama-3.1-8b |
| Contacts / segments / tags / custom-fields CRUD | `apps/api/src/routes/contacts.ts`, `segments.ts`, `tags.ts`, `custom-fields.ts` | |
| Broadcasts API | `apps/api/src/routes/broadcasts.ts`, `apps/api/src/routes/whatsapp.ts` (deprecated WA-specific) | |
| Cron (every minute) | `apps/api/src/scheduled/index.ts:32-33` → `processScheduledBroadcasts`, `processScheduledWhatsAppBroadcasts` | |

## Step-by-step trace

### A. Platform webhook → queue

Using Facebook/Instagram as the richest example (`platform-webhooks.ts:180-524`):

1. `POST /webhooks/facebook` reads the raw body and verifies HMAC-SHA256 against `FACEBOOK_APP_SECRET`, falling back to `INSTAGRAM_LOGIN_APP_SECRET` (`platform-webhooks.ts:190-199`). Two `crypto.subtle` HMAC ops worst case.
2. Responds `200` immediately; the real work happens in `ctx.waitUntil(processFacebookWebhook(parsed, env))` (`platform-webhooks.ts:228`).
3. `processFacebookWebhook` (`:249`) creates a fresh Drizzle client (`createDb`, postgres.js `max: 5, prepare: true` — `packages/db/src/client.ts:18`), then per `entry`:
   - `resolveAccount` (`:92`): KV get `platform-account:{platform}:{id}` → on miss 1–2 DB SELECTs on `social_accounts` (+ Instagram `webhookAccountId` fallback), KV put (TTL 300s).
   - Per `changes[]` item: `INBOX_QUEUE.send(...)` (`:273`), plus possible `SYNC_QUEUE.send` gated by KV dedup key (`:294-309`).
   - Echo-detection prelude: 1 DB SELECT for the account's known IDs (`:321-328`), 1 KV get `ig-sender-id:{accountId}` (`:333`).
   - Per `messaging[]` item (every DM): up to 4 dedup layers — KV get `outbound-mid:{mid}` (`:463`), DB SELECT `inbox_messages` by `platformMessageId` (indexed, `:469-473`), **Layer-4 text-match DB SELECT** joining `inbox_messages ⋈ inbox_conversations` on `(accountId, direction='outbound', text = msgText, createdAt > NOW()-15s)` (`:484-499`), KV get + KV put `msg-dedup:{mid}` (`:508-509`), then `INBOX_QUEUE.send` (`:512`).

WhatsApp (`:717-763`), Telegram (`:821-847`), SMS (`:906-939`) and YouTube (`:589-643`) follow the same resolve-account → enqueue pattern with 1 KV get (+1 DB select on miss) per entry.

### B. Queue consumer → event processing

`consumeInboxQueue` (`apps/api/src/queues/inbox.ts:8-32`):

- Creates **one shared db client** per batch, then iterates `batch.messages` **serially** (`for (const message of batch.messages) { ... await processInboxEvent(...) }`). A batch is up to 10 messages; one slow message head-of-line-blocks the other 9.
- On error: `message.retry({ delaySeconds: 2 ** attempts })`; ≥5 attempts → ack+discard.

`processInboxEvent` (`apps/api/src/services/inbox-event-processor.ts:275-621`):

1. Special routing: `youtube_subscribe` → PubSub subscribe fetch; `backfill` → dynamic-import `inbox-backfill`; `whatsapp_webhook`+`statuses` → `processWhatsAppStatuses`.
2. `normalizeEvent` (`:929`) — pure CPU, maps raw payload to `NormalizedInboxEvent[]` (FB/IG comment/DM/echo/follow/referral, WhatsApp messages, Telegram, SMS).
3. **Per normalized event** (loop at `:323`):
   - **DB SELECT 1** — social account `(workspaceId, accessToken)` by id (`:330-337`).
   - If comment/message: `upsertConversation` (`inbox-persistence.ts:97-168`) — **DB INSERT ... ON CONFLICT DO UPDATE ... RETURNING** on `inbox_conversations` (unique `(accountId, platformConversationId)`), then if `contactId` is null → `findMatchingContact` (`contact-linker.ts:20-106`): up to **4 sequential SELECTs** (channel exact match join, phone eq, email eq, name `ILIKE`) + possible **UPDATE** to link the contact (`inbox-persistence.ts:155-159`).
   - If inbound DM with a linked contact: **`COUNT(*)` over `inbox_messages ⋈ inbox_conversations`** for `(org, platform, contactId, direction='inbound')` to compute `preInsertInboundCount` for the welcome-message binding (`inbox-event-processor.ts:382-406`).
   - `insertMessage` (`inbox-persistence.ts:174-229`) — **DB INSERT ... ON CONFLICT DO NOTHING ... RETURNING** on `inbox_messages` + **DB UPDATE** of the parent conversation (preview text, counters).
   - **Step 1b — Meta participant profile enrichment** (`inbox-event-processor.ts:425-541`), runs for IG/FB DMs when name/avatar missing or profile >24h stale:
     - `maybeDecrypt` access token (AES-256-GCM, key memoized — `lib/crypto.ts:19-34`).
     - Instagram: full-field profile fetch, on failure a second minimal-field fetch (each with 5s abort timer) (`:165-186`). Facebook: 1 fetch (`:212-269`).
     - `rehostAvatar` (`avatar-store.ts:29-55`): external fetch of the avatar (5s timeout) + **R2 put** `MEDIA_BUCKET`.
     - **DB UPDATE** `inbox_conversations` (participant metadata/name/avatar) + **DB UPDATE** `inbox_messages` (all inbound rows for that author in the conversation) (`:503-533`).
   - **Step 2 — Automation dispatch** (`dispatchAutomationMatch`, `:676-802`, inbound only, channels {instagram, facebook, whatsapp, telegram}):
     - `ensureContactForAuthor` (`contact-linker.ts:119-183`): **re-runs `findMatchingContact`** (up to 4 SELECTs again), then either `ensureChannelLink` (1 SELECT + maybe 1 INSERT) or social-account `findFirst` + contact INSERT + channel INSERT.
     - For messages: `resumeWaitingRunForInput` (`:829-923`) — 1 SELECT on `automation_runs` (`(org, contact, status='waiting', waitingFor='input')`), then per waiting run sequential `resumeWaitingRunOnInteractive` / `resumeWaitingRunOnInput` calls (each does its own run/node reads + sends).
     - Otherwise `matchAndEnrollOrBinding` (`automations/binding-router.ts:212`): `matchAndEnroll` (`trigger-matcher.ts` — ~3–7 SELECTs: entrypoints+automations join, contact, custom field values, pauses, active-run/reentry checks) and on no-match `routeBinding` (first-inbound check uses the pre-insert hint, then 1–2 binding SELECTs, possible `enrollContact` which starts the runner → outbound platform send fetches).
   - **Step 3 — Customer webhook dispatch** (`dispatchWebhookEvent`, `webhook-delivery.ts:132-165`): **DB SELECT all enabled `webhook_endpoints` for the org**, then `Promise.allSettled` of `deliverWebhook` per matching endpoint. Each delivery: KV get `webhook-secret:{id}`, `maybeDecrypt`, HMAC sign, DNS-based SSRF check, **up to 3 POSTs with 5s timeout each and `setTimeout` backoff sleeps of 1s and 4s awaited inline** (`:84-109`), then `createDb(...)` (a brand-new postgres client) + **INSERT `webhook_logs`** (`:113-123`). All of this is awaited by `processInboxEvent` before step 4.
   - **Step 4 — Realtime notify** (`notify-post-update.ts:36-52`): Durable Object `REALTIME.idFromName(orgId)` + `stub.fetch("http://internal/notify")`, awaited (errors caught).

`processWhatsAppStatuses` (`inbox-event-processor.ts:1617-1659`): serial `for` over statuses; per status one **UPDATE `inbox_messages` ... WHERE platformMessageId = :id** (indexed by `inbox_msg_platform_message_id_idx`) with `jsonb_set`, then a full `dispatchWebhookEvent` (endpoint SELECT + deliveries). WhatsApp emits sent/delivered/read → up to 3 statuses per outbound message.

### C. Backfill (account connect)

`processBackfill` (`apps/api/src/services/inbox-backfill.ts:22-76`): new db client, account SELECT, token decrypt, then per-platform: FB fetches 25 posts then per post up to 2 pages × 50 comments; per comment a serial `upsertConversation` + `insertMessage` pair (2–7 queries each) (`:118-211`). IG/YouTube/GMB analogous. Worst case ≈ 25 posts × 100 comments × ~4 queries ≈ 10k serial DB round trips in one queue message. Note `inbox-backfill.ts:233,286` hardcode `v25.0` rather than using `API_VERSIONS`.

### D. Read path — feed/search/stats/detail

- `GET /v1/inbox/conversations` (`inbox-feed.ts:161-190` → `listConversations`, `inbox-persistence.ts:235-308`): **1 SELECT** on `inbox_conversations` ordered by `updatedAt DESC` (`inbox_conv_org_updated_idx`), limit+1, cursor = ISO timestamp. No N+1 — single query, serializer only.
- `GET /v1/inbox/conversations/{id}` (`inbox-feed.ts:473-499` → `getConversationWithMessages`, `inbox-persistence.ts:314-351`): 1 conversation SELECT + 1 messages SELECT **fixed `limit(200)`, no pagination params**.
- `GET /v1/inbox/search` (`searchMessages`, `inbox-persistence.ts:357-424`): 1 SELECT with **`ILIKE '%q%'` on `inbox_messages.text`** (plus optional IN-subqueries for workspace/platform). No trigram/FTS index exists on `text` → seq scan over the org's messages.
- `GET /v1/inbox/stats` (`getInboxStats`, `:430-510`): single GROUP BY query. Good.
- `POST /v1/inbox/bulk` (`inbox-feed.ts:220-345`): one pre-fetch SELECT for labels, then **per-target serial `updateConversation` UPDATE** (N targets → N UPDATEs).
- Notes CRUD: 2–4 queries each, org-member validation via `findFirst`.
- `POST /v1/inbox/conversations/{id}/messages` (send): account SELECT + token decrypt → recipient lookup (DB for `conv_*` ids, else Graph `?fields=participants` fetch) → 1–N Graph send POSTs → `insertMessage` (2 queries) → **serial KV puts `outbound-mid:{mid}`** per sent mid (`inbox-feed.ts:781-783`) → DO notify via `waitUntil`. WhatsApp branch analogous (`:788-891`).
- Reactions/delete/typing: message SELECT + conversation SELECT + 1 platform fetch each.

### E. Read path — comments (live platform proxy)

`GET /v1/inbox/comments` (`inbox.ts:840-956`):
1. `getAccountsForOrg` (`inbox-helpers.ts:60-104`): 1 SELECT (up to 50 accounts) + AES-GCM decrypt per token.
2. Posts per account via `getCachedPosts` (`inbox.ts:484-529`): KV get `inbox-posts:{accountId}`; on miss 1–2 platform fetches (FB published_posts / IG media / YT channels+playlistItems), KV put TTL 300s.
3. Sorts all posts, truncates to `maxPostsToInspect = max(limit*3, 30)` (`:844,883`).
4. **Per post** fetches comments live (`mapConcurrently(allPosts, 8, ...)` `:890`): 1 Graph/YouTube fetch per post, **no caching of comments** — every page load re-fetches up to 30 posts' comments.
5. In-memory sort + time-cursor pagination (cursor causes the same full fan-out again, then filters client-side in the worker).

Moderation routes (`deleteComment` `:1175-1237`, `hideComment`, `unhideComment`, `likeComment`) fan the write out to **every** candidate account (`Promise.allSettled` over up to 50 accounts) because `comment_id` does not identify the owning account; first success wins; then `invalidateInboxCache` (1 SELECT + N parallel KV deletes + DO notify).

### F. Read path — Inbox AI

- `POST /classify`, `/suggest-reply`, `/summarize` (`inbox-ai.ts`): 0–2 DB queries (`getConversationWithMessages`) + 1 Workers AI `ai.run` call (llama-3.1-8b) — model latency dominates.
- `GET /v1/inbox/ai/priorities` (`inbox-ai.ts:279-335`): `listConversations` (1 query, up to 100 rows) then **`Promise.all` over conversations, each issuing its own `SELECT sentimentScore, classification FROM inbox_messages WHERE conversationId = ? ORDER BY createdAt DESC LIMIT 1`** (`:303-313`) — classic N+1 (up to 100 extra queries through a `max: 5` connection pool → ~20 serialized waves).

### G. Contacts / segments / tags / custom fields

- `GET /v1/contacts` (`contacts.ts:455-600`): optional cursor SELECT, main SELECT (limit+1), then channels SELECT (`inArray`) and segment-membership SELECT fetched **in parallel** — no N+1. Search uses `ILIKE` on name/phone/email (no indexes; see notes).
- Contact merge (`:1161-1272`): 2 raw DELETE-dup statements + 2 bulk UPDATE...RETURNING + 2 parallel UPDATEs + 1 DELETE — bounded.
- Bulk create (`:1038-1100`): batched 500-row INSERTs + batched channel INSERTs. Good.
- Segments/tags/custom-fields: simple 1–3 query CRUD; `segment-memberships.ts` uses `inArray` batch lookups (no N+1).

### H. Broadcast fan-out

Three distinct paths:

1. **Synchronous (generic)** — `POST /v1/broadcasts/{id}/send` (`broadcasts.ts:708-842`): broadcast SELECT → account SELECT + decrypt → status UPDATE → **`SELECT * FROM broadcast_recipients WHERE status='pending'` with NO LIMIT** (`:765-773`) → `mapConcurrently(recipients, 5, sendMessage + per-recipient UPDATE)` (`:779-813`) → final UPDATE. All on the HTTP request path: ~2 subrequests per recipient (1 platform POST + 1 DB UPDATE). 500 recipients ≈ 1,000+ subrequests and minutes of wall time — exceeds Workers' subrequest/wall-clock limits and the client's patience.
2. **Cron (generic)** — `processScheduledBroadcasts` (`broadcast-processor.ts:18-206`): picks ≤5 broadcasts with `status='scheduled'` (note: a broadcast left in `sending` by a crashed run is **never re-picked**), runs them concurrently; per broadcast: account SELECT + `refreshTokenIfNeeded` + cursor-paged batches of 50 → `Promise.allSettled(50 × sendMessage)` → 50 individual UPDATEs (`Promise.all`) → **`await setTimeout(1000)` between batches** (`:189`). No per-tick recipient budget — a 5k-recipient broadcast = 100 chunks ≈ 100s+ inside one cron invocation.
3. **Cron (WhatsApp legacy)** — `processScheduledWhatsAppBroadcasts` (`whatsapp-broadcast-processor.ts:37-251`): the corrected design — picks `scheduled` **or `sending`** (resumable), global `MAX_RECIPIENTS_PER_TICK = 200`, chunk 25, 500ms inter-chunk delay; finalizes via three sequential `COUNT(*)` queries (`:206-232`). `POST /v1/whatsapp/broadcasts/{id}/send` and `/bulk-send` only mark `scheduled` and return (async by design).

`sendMessage` (`message-sender.ts:98-130`) routes to per-platform senders, all `fetchWithTimeout(…, 10s)` — WhatsApp Cloud, Telegram Bot API, X DM, IG/FB Messenger Send API, Reddit compose.

## Per-request work

### Inbound IG/FB DM, end to end (typical worst case, cache-warm KV)

Webhook handler (background via `waitUntil`): 2 HMAC ops, JSON parse, 1 KV get (account), 1 DB SELECT (known IDs), 1 KV get (ig-sender-id), per message: 1 KV get (outbound-mid) + 1 DB SELECT (mid dedup) + 1 DB SELECT (text-match dedup join) + 1 KV get + 1 KV put (msg-dedup) + 1 queue send.

Queue consumer, per message: 1 DB SELECT (account) → 1 upsert (conversation) → 0–4 SELECT + 0–1 UPDATE (contact link) → 1 COUNT join (first-inbound) → 1 INSERT + 1 UPDATE (message + conversation counters) → [enrichment: 1 decrypt, 1–2 Graph fetches (5s timeout each), 1 avatar fetch + 1 R2 put, 2 UPDATEs] → [automations: 0–4 SELECT (contact re-match) + 0–2 INSERT, 1 SELECT (waiting runs) or 3–7 SELECTs (trigger match) + binding SELECTs + possible enroll/runner sends] → 1 SELECT (webhook endpoints) + per endpoint [1 KV get, 1 decrypt, 1 HMAC, DNS check, 1–3 POSTs with up to 5s sleeps, 1 new pg client, 1 INSERT webhook_logs] → 1 DO fetch (realtime).

Total: **roughly 10–25 DB round trips, 3–6 KV ops, 0–4 external fetches, 1 R2 put, 1 DO fetch per inbound message — all sequential, ×10 messages per serially-processed batch.**

### GET /v1/inbox/conversations
1 DB SELECT. (Auth middleware adds its own KV/DB work, out of scope here.)

### GET /v1/inbox/ai/priorities
1 DB SELECT + **N DB SELECTs (N = page size, ≤100)**.

### GET /v1/inbox/comments (KV post-cache warm)
1 DB SELECT (accounts) + N token decrypts + A KV gets (posts) + **min(30, posts) live comment fetches** + sort. Cache-cold adds 1–2 platform fetches + 1 KV put per account.

### POST /v1/broadcasts/{id}/send
3 DB SELECTs + 1 decrypt + 1 UPDATE + **R platform POSTs + R DB UPDATEs (R = all pending recipients, unbounded)** + 1 final UPDATE.

## External calls

| Caller | Endpoint | Timeout |
|---|---|---|
| inbox-event-processor enrichment | `graph.instagram.com|graph.facebook.com/{psid}?fields=…` (×1–2) | 5s abort |
| avatar-store | platform CDN avatar URL → R2 | 5s |
| webhook-delivery | customer endpoint URL (×1–3 attempts) | 5s each + 1s/4s sleeps |
| webhook-subscription | YouTube PubSubHubbub hub | — |
| inbox.ts comments/posts/reviews | Graph API, YouTube Data API, Google My Business (2–3 chained calls for GMB) | none (default fetch) |
| inbox-feed send/typing/reactions/delete | Graph Send API, WhatsApp Cloud `/messages`, Telegram Bot API, X API | none |
| message-sender (broadcasts/automations) | WhatsApp/Telegram/X/IG/FB/Reddit send endpoints | 10s |
| whatsapp.ts routes | WABA template/profile/flows/phone endpoints (1–5 chained calls; profile-photo upload does 5) | none |
| whatsapp-phone-provisioning | Telnyx (search/order/release), Stripe (subscription item / checkout), Meta phone register/verify | none |
| inbox-ai | Workers AI `@cf/meta/llama-3.1-8b-instruct` | platform-managed |
| notifyRealtime | Durable Object `REALTIME` fetch | — |

## Performance notes

1. **`POST /v1/broadcasts/{id}/send` is an unbounded synchronous fan-out** (`broadcasts.ts:765-813`). No LIMIT on the recipients SELECT; 2+ subrequests per recipient on the request path. The deprecated WhatsApp equivalent was already converted to async (`whatsapp.ts:1006-1010` comment documents exactly this failure mode) but the primary generic route was not.
2. **`GET /v1/inbox/ai/priorities` N+1** — one latest-message SELECT per conversation (`inbox-ai.ts:303-313`); replaceable with one `DISTINCT ON (conversation_id)` / lateral-join query.
3. **Queue consumer serializes the batch and awaits webhook delivery retries inline** (`queues/inbox.ts:13`, `webhook-delivery.ts:107`, awaited at `inbox-event-processor.ts:583`). A single dead customer endpoint costs ~24s (3×5s timeouts + 1s+4s sleeps) per event, ×10 events per batch → minutes of inbox lag and retry pressure.
4. **Profile enrichment + avatar rehost run before automation dispatch** (`inbox-event-processor.ts:425-541` precedes `:546-568`), so up to ~15s of Meta/CDN fetches delay auto-replies that should feel instant.
5. **Contact matching runs twice per inbound event** (once in `upsertConversation` for unlinked conversations, again in `ensureContactForAuthor`), each up to 4 sequential SELECTs, and `contacts.phone` / `contacts.email` / `contacts.name` have **no supporting indexes** (`packages/db/src/schema.ts:1426-1444`) — the phone/email/name probes are org-scoped seq scans repeated on every message.
6. **`COUNT(*)` where `EXISTS` suffices** for the first-inbound-on-channel signal (`inbox-event-processor.ts:382-406`) — scans a contact's entire message history per inbound DM.
7. **`searchMessages` uses non-sargable `ILIKE '%q%'`** with no trigram/FTS index (`inbox-persistence.ts:371`).
8. **`GET /v1/inbox/comments` re-fetches comments live for up to 30 posts per request** (`inbox.ts:844-922`); posts are KV-cached but comments never are, and cursor pagination repeats the whole fan-out.
9. **Generic cron broadcast processor lacks a per-tick budget and crash-resume** (`broadcast-processor.ts:24-31` only selects `status='scheduled'`; `:189` sleeps 1s per 50 recipients inside the invocation), unlike the WhatsApp processor.
10. **Layer-4 echo dedup query per inbound FB/IG DM** (`platform-webhooks.ts:484-499`) joins messages⋈conversations on text equality with no supporting index — per-message cost grows with account history.
11. **Fixed 200-message thread fetch with no pagination** (`inbox-persistence.ts:348`) and the deprecated `GET /v1/whatsapp/broadcasts` with no LIMIT (`whatsapp.ts:834-843`) inflate payloads.
12. Minor: serial KV puts for sent mids (`inbox-feed.ts:781-783`); `deliverWebhook` creates a fresh postgres client per delivery for one log INSERT (`webhook-delivery.ts:113`); WhatsApp finalization runs 3 sequential COUNTs (`whatsapp-broadcast-processor.ts:206-232`); comment moderation fans writes to all ≤50 org accounts (`inbox.ts:1191-1230`).
