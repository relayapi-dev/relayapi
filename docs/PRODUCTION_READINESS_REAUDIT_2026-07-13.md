# RelayAPI Production Readiness Re-audit — 2026-07-13

**Repository:** RelayAPI

## Post-audit remediation update — 2026-07-13

> This section records the remediation pass performed after the reviewed
> snapshot below. The original findings and evidence are intentionally retained
> as a historical audit record. “Repository remediated” means the code,
> configuration, migration, tests, or release gate now exists in this working
> tree; it does not substitute for deployment or external operational evidence.

**Repository outcome:** every R-01–R-37 finding now has an in-repository
remediation and a focused regression or release gate. No known finding remains
without a repository-side treatment.

**Current release decision:** **NO-GO pending external closure.** Production was
not deployed or mutated during this pass. A read-only live Cloudflare check
still fails on required resources and secrets, credential incident-response
work cannot be proven from the repository, the production database has not been
migrated or restore-rehearsed here, and production-like memory/latency/provider
evidence is still required.

### Finding disposition

| Disposition | Findings | Meaning / remaining evidence |
|---|---|---|
| Repository remediated and locally verified | R-01, R-03, R-04, R-06–R-10, R-14, R-17–R-29, R-31, R-32, R-34, R-36, R-37 | Authentication/tenancy, encryption, SSRF, webhook verification, crash-safe state machines, idempotency, deletion, principal-bound dashboard credentials, checkout, integration/API contracts, consent/billing, atomic one-time claims, safe regex/cursors/wakeups, generated Worker types/workerd coverage, deterministic docs, durable completion effects, logging, and n8n parity have code and focused tests. |
| Repository remediated; security/operational closure remains | R-05, R-11–R-13, R-15, R-16, R-30, R-33, R-35 | Secret references/redaction, Queue rescue, phone/ad operations, credential scanning, migration sequencing, audit/SBOM policy, downloader immutability, and live-resource verification are implemented. Closure still requires the rotations, live resources, provider reconciliation, backup/restore/migration, time-bounded advisory follow-up, artifact promotion, and drills listed below. |
| Repository mitigated; production performance proof remains | R-02 | Media reads/uploads are byte-bounded and streamed, locally streaming targets are serialized, and publish work respects the Worker connection budget without a global Queue throughput cap. Production-like peak-memory and 1/5/20-target load evidence is still required. |

### Performance-preserving implementation notes

- URL-forwarding and text-only publish targets remain parallel at up to six
  tasks while locally streaming media work is serialized separately. Since
  April 2026, Workers count only requests waiting for response headers toward
  the six-connection allowance and queue any excess request, so a media stream
  does not need to reduce lightweight-task concurrency.
- Publish Queue batching is one message per invocation for isolate-memory
  isolation, but `max_concurrency` is deliberately not capped, preserving
  Cloudflare autoscaling across posts.
- Publish-outbox claims are bulk `FOR UPDATE SKIP LOCKED` operations, the cron
  drains bounded multiple batches, and cleanup uses the new
  `(status, dispatched_at, id)` index. The populated PostgreSQL query plan uses
  an index-only scan for that retention selector.
- Customer-webhook endpoint filtering now happens in SQL, selects only IDs,
  batches every matching endpoint without an arbitrary organization-wide cap,
  and uses `INSERT … RETURNING` to remove one query from the normal dispatch
  path.
- Dashboard SDK caching is bounded and prunes on misses, so a hot cache hit
  remains a single `Map` lookup.
- `/openapi.json` now lazily caches only the serialized document per isolate.
  In the same local synthetic suite, its 10-request average fell from about
  72 ms to 9.5 ms; unrelated Worker cold starts do not generate the spec.

These controls are designed to remove the reported failure modes without
serializing unrelated work or adding request-path database round trips. The
local performance suite passes all 36 thresholds, but it is not a substitute
for production p50/p95/p99, connection-pressure, throughput, and peak-isolate
memory measurements.

### Post-remediation validation

| Check | Result |
|---|---|
| Full API suite via the required isolated runner | **PASS — 106 files, 987 tests, 0 failures.** |
| Dashboard suite | **PASS — 222 tests, 0 failures.** |
| Workerd integration suite | **PASS — 3 files, 9 tests, 0 failures.** |
| Zapier / n8n contract suites | **PASS — 14 / 1 tests, 0 failures.** |
| TypeScript and SDK | **PASS** across db, auth, SDK build, MCP, API, app, docs, CLI, n8n, and Zapier; final API recheck also passed. |
| Biome lint and repository secret guard | **PASS** with 43 pre-existing non-blocking style warnings, no lint errors, and no findings in the tracked plus non-ignored-untracked current tree. |
| OpenAPI/docs | **PASS** — pinned artifact matches the checkout; 381 operations across 45 tags; docs typecheck and production build pass. |
| App production build | **PASS.** |
| Wrangler deploy dry runs | **PASS** — API 4,600.82 KiB raw / 1,204.85 KiB gzip; app 11,650.42 / 2,374.50 KiB; docs 27,584.08 / 3,691.85 KiB. |
| PostgreSQL 17 migration | **PASS** on a disposable clean PostgreSQL 17.9 database, including a second idempotent migrate, all 101 public and 8 auth tables, `pg_trgm`, and exact migration history. The configured remote database was not touched because its required SSH tunnel was unavailable. |
| Migration identity | **PASS** — the single pre-launch `0000_baseline` SHA-256 is `2dacd857f75a634b0b9cd2ba6339fbdb59c4465f59818120784db14384ff9258`; its manifest and Drizzle metadata checks pass. |
| Secret regression, dependency policy, downloader provenance | **PASS** — credentialed database URLs are detected/redacted; the current repository tree has no findings; 11 dependency-policy tests and the live audit pass with 69 exact, current, time-bounded exception scopes; the downloader publication requests an SBOM for its immutable image digest. |
| Release-evidence gate | **PASS** for both missing-evidence rejection and a synthetic current-evidence acceptance test. This does not claim a real production backup or restore rehearsal exists. |
| Production health | **PASS** for the read-only `/health` contract. The new checkout was not deployed, so post-deploy OpenAPI equality was not claimed. |
| Live Cloudflare release gate | **FAIL / release blocked** — see the external closure list immediately below. |

### External closure required before GO

1. Revoke/rotate the development database credential identified by R-15,
   determine whether repository history must be scrubbed, and retain a clean
   full-history Gitleaks result after rotation. Repository literal removal does
   not revoke an already exposed credential.
2. Revoke the prior Cloudflare OAuth grant/session if that has not already been
   done. During the first read-only inventory attempt, Wrangler authentication
   material appeared in local tool output; the verifier was then hardened to
   reject whitespace-bearing tokens, redact failures, and suppress fetch/header
   details, and the session was reauthenticated before the successful retry.
3. Bring the live Cloudflare account into conformance with
   `apps/api/production-resources.json`. The read-only retry confirmed that
   Hyperdrive caching is disabled and the existing media/thumbnail lifecycle
   checks pass, but it also confirmed these blockers:

   - `relayapi-queue-rescue-ledger` does not exist;
   - the complete primary Queue → DLQ → rescue topology and reviewed consumers
     are not deployed, including the customer-webhook and rescue queues and
     multiple missing DLQs;
   - the media bucket notification does not cover the reviewed create and
     delete action set with one unfiltered rule;
   - `RESEND_API_KEY` is absent and the enabled WhatsApp group is missing
     `WHATSAPP_CONFIG_ID`.

4. Produce and restore-rehearse a production backup, verify live migration
   history/hash/catalog and tenant mismatch counts, run the online-index
   preflight, apply the reviewed migration, deploy through the protected
   sequence, and retain rollback evidence. Do not run an improvised live
   migration from a developer shell.
5. Run production-like publish tests for 1, 5, and 20 targets, worst-case media,
   scheduler/outbox load, database connections, p50/p95/p99 latency, throughput,
   and peak isolate memory. Confirm no regression against a recorded baseline.
6. Exercise provider ownership and reconciliation for publish, paid ads,
   Stripe, Telnyx/WhatsApp phone lifecycle, token refresh/revocation, and tenant
   deletion, including crashes before/after every provider boundary.
7. Retain an R2 upload/head/delete canary and a controlled
   Queue → DLQ → rescue-ledger drill with backlog/failure alarms. The verifier is
   intentionally read-only and cannot prove those end-to-end paths.
8. Rotate any automation credentials previously stored inline, close or renew
   dependency exceptions before their expiry, validate the downloader lock in
   its release environment, and promote only immutable reviewed artifacts.

**Reviewed snapshot:** `7a29b43a829b346f10f77c35f76966d63ec74179` (`main`, clean before this report)

**Prior report checked:** `docs/PRODUCTION_READINESS_DEEP_AUDIT_2026-07-12.md`
**Reviewed snapshot decision:** **NO-GO for production**

## Executive verdict

The prior report's conclusion that all 20 findings were fixed and verified is not supported by the current repository.

Of the original 20 findings:

- **5 are verified fixed** in the repository: F-02, F-09, F-11, F-13, and F-16.
- **1 has its core fix in place but an incomplete regression gate:** F-01.
- **13 remain partial:** F-03 through F-08, F-10, F-12, F-14, and F-17 through F-20.
- **1 has a material integration regression:** F-15.

The expanded pass records **2 critical findings, 20 confirmed high findings, 1 unverified high release gate, 12 medium findings, and 2 lower-severity findings**. Several deliberately overlap an original F-item so the remaining failure mode has an actionable evidence trail.

The whole-repository pass also found release blockers that were absent or understated in the prior report. The most urgent are:

1. Telegram webhook authentication and Telegram account ownership can be bypassed.
2. Media publishing can deterministically exceed Cloudflare Workers' 128 MB isolate memory limit.
3. Account-token encryption writes and reads disagree on AES-GCM additional authenticated data (AAD).
4. Automation HTTP actions expose server-side request forgery (SSRF), and automation credentials are stored and returned in plaintext.
5. YouTube and Twilio webhook verification fails open when optional secrets are absent.
6. Cross-tenant relational integrity remains bypassable in Ideas.
7. Several paid or externally visible operations still lack crash-safe idempotency and reconciliation.
8. A plaintext development database credential is committed in 18 tracked integration tests.

Passing tests do not invalidate these findings. Most are crash-window, concurrency, configuration, authorization-contract, or platform-runtime defects that the current unit suites do not exercise.

## Scope and method

This re-audit covered the full tracked repository, including:

- `apps/api`, `apps/app`, `apps/docs`, `apps/cli`, and `apps/downloader`;
- `packages/db`, `packages/auth`, `packages/sdk`, `packages/mcp`, and published integrations;
- Drizzle schema, baseline migration, migration verifier, GitHub Actions, Wrangler configuration, Queue/DLQ topology, R2 media lifecycle, Hyperdrive use, authentication, billing, encryption, webhooks, automations, and external-provider state machines;
- tests, type checks, lint, builds, dependency audit, clean PostgreSQL migration replay, Wrangler type checks, and dry-run deploy bundles.

The review combined static data-flow analysis, schema/catalog comparison, concurrency and failure-boundary analysis, focused test review, and current official platform documentation.

### Important limitations

- No production database, production Cloudflare account, Stripe account, Telegram bot, Twilio account, Telnyx account, Meta account, or other provider account was mutated or inspected.
- The required SSH tunnel was unavailable, so no live migration hash, live catalog, restore rehearsal, or live tenant-mismatch query was run.
- Hyperdrive query-cache settings, R2 lifecycle rules, R2 event notification wiring, custom domains, Queue backlogs, and deployed secrets are external state and remain unverified.
- No production-like load test or p50/p95/p99 benchmark was run.
- This is a repository-level readiness assessment, not an attestation of deployed state.

## Original F-01 through F-20 verification

Legend:

- **FIXED** — implementation and proportionate local verification support the original fix.
- **CORE FIXED / GATE INCOMPLETE** — the immediate defect is fixed, but the claimed regression or deployment assurance is narrower than stated.
- **PARTIAL** — meaningful remediation exists, but a material failure mode remains.
- **REGRESSED** — the remediation introduced or preserved a directly conflicting runtime contract.

| ID | Re-audit status | Verification result |
|---|---|---|
| **F-01 Migration history** | **CORE FIXED / GATE INCOMPLETE** | The tracked baseline and journal exist (`packages/db/drizzle/0000_production_baseline.sql:1-2`, `packages/db/drizzle/meta/_journal.json:1-13`). A fresh local PostgreSQL migration, a second no-op migration, and `db:verify` passed. However, `packages/db/scripts/verify-migrations.ts:60-145,283-409` compares table/column names plus selected objects, not every type, nullability rule, default, PK, unique, FK, delete action, check, and index claimed by the old report. No live hash preflight or restore rehearsal exists. |
| **F-02 Automation partition horizon** | **FIXED** | `automation_step_runs` is now an ordinary table with a normal bigint primary key. The schema, baseline, verifier, and clean local catalog agree (`packages/db/src/schema.ts:4026-4051`; `verify-migrations.ts:285-312`). |
| **F-03 Tenant relational ownership** | **PARTIAL** | Composite ownership constraints and scoped code were added to the originally cited automation, WhatsApp, segment, and subscription paths. Ideas remains cross-tenant attachable: arbitrary foreign group/tag IDs are accepted and foreign tag metadata can be returned (`apps/api/src/routes/ideas.ts:97-118,446-517,572-603,717-781`; `packages/db/src/schema.ts:3571-3640,3682-3693`). |
| **F-04 Organization/workspace authorization** | **PARTIAL** | Recursive workspace-ID validation, route permission checks, CSV/bulk persistence, and ad analytics scoping were added. The test matrix covers selected routers, not every ID-addressed route. Ideas still lacks organization/workspace validation for group/tag associations, and failure/replay administration is organization-only rather than workspace-aware. |
| **F-05 Publication crash safety and idempotency** | **PARTIAL** | Durable target attempts, leases, operation IDs, and an outbox exist. A rejected provider promise becomes `PUBLISH_ERROR` at `apps/api/src/services/publisher-runner.ts:436-446`, while the ambiguous-outcome branch only recognizes other codes at `:480-517`; it can therefore mark a possibly-sent request definitively failed. Thread parent claiming also has a competing-worker race. |
| **F-06 SDK/request duplication** | **PARTIAL** | The SDK reuses a stable idempotency key across retries, CORS permits it, and duplicate targets are deduplicated. Server receipts are committed before the business operation, expiry is never enforced, thrown handlers leave permanent `in_progress`, and non-JSON bodies all hash as `null` (`apps/api/src/middleware/idempotency.ts:7,68-161`; `body-cache.ts:15-31`). |
| **F-07 Durable inbound webhook acceptance/effects** | **PARTIAL** | Verified raw bodies and Queue handoff are persisted. Per-effect processing changes `pending` to `unknown` before the effect and swallows failures, with no reconciler or replay payload (`apps/api/src/services/inbox-event-processor.ts:35-77`). Exhausted raw receipts are not visible through the organization-scoped replay API. |
| **F-08 Deletion lifecycle** | **PARTIAL** | Tombstones, revocation jobs, and tenant deletion state exist. Account revocation checks the credential before provider I/O but clears the account after provider I/O without a credential-version fence (`apps/api/src/services/account-revocation.ts:167-245`), so reconnect can race and lose new credentials. Tenant deletion does not release Telnyx/Meta phone resources. |
| **F-09 Atomic post mutations** | **FIXED** | Create, update, delete, bulk-item, and CSV-item post mutations use transactions around the post and dependent state (`apps/api/src/routes/posts.ts:1628-1721,2239-2326,2448-2475,2814-2860,3974-4017`). |
| **F-10 Broadcast/customer webhook delivery** | **PARTIAL** | Broadcast and WhatsApp delivery state machines improved, and customer webhook rows are durable. Customer events use a content hash rather than an occurrence ID, business commit → webhook ledger → Queue handoff is not atomic, pre-network claims can strand, and 429/5xx responses are terminal rather than retried (`apps/api/src/services/webhook-delivery.ts:61-120,167-187,239-285`). |
| **F-11 Webhook signing-secret durability** | **FIXED** | Normal delivery secrets are strongly generated, context-encrypted in PostgreSQL, returned once, rotatable, and fail closed on decryption. The explicit test-webhook endpoint is unsigned by design, so the literal “never unsigned” wording should not be used for that diagnostic path. |
| **F-12 Contacts and consent** | **PARTIAL** | Consent ledgers and send-time enforcement exist. Automation `opt_in_channel`/`opt_out_channel` writes a custom-field convention that the send-time consent service never reads (`apps/api/src/services/automations/actions/subscription.ts:6-12,98-176`). Those actions do not grant or suppress actual sends. |
| **F-13 External ad/Stripe identities** | **FIXED** | Account-scoped unique constraints and account-aware upserts exist for the cited ad and Stripe identities, and focused external-identity tests pass. Live data reconciliation was not possible. |
| **F-14 Billing authority and operations** | **PARTIAL** | Canonical Stripe fetches, durable receipts, shared policy, billing operations, and an outbox exist. Scheduled usage still trusts a local active/trialing row without the shared billing policy (`apps/api/src/services/scheduled-post-usage.ts:24-49`); several claims lack lease fencing; unresolved checkout events can be logged and treated as successfully processed. |
| **F-15 Encryption rotation** | **REGRESSED** | Token refresh encrypts account tokens with AAD (`apps/api/src/services/token-refresh-coordinator.ts:638-661`), while many readers decrypt without it (`apps/api/src/lib/accounts.ts:9-31`, publishers, inbox, analytics, WhatsApp). Rotation also handles account tokens without AAD (`apps/api/src/services/encryption-rotation.ts:76-103`). A successful refresh can make downstream token use fail. |
| **F-16 Scheduled generators** | **FIXED** | RSS, recycling, cross-post, and scheduled automation generation now use leases/occurrence IDs and transactional dependent writes. One failed automation contact can still leave a page `unknown` without continuation, but the original duplicate-generation defect is structurally addressed. |
| **F-17 Queues, DLQs, and replay** | **PARTIAL** | Primary queues now have DLQs and explicit routing. DLQ consumers have no rescue DLQ, replay send/status update is non-atomic, several invalid messages are acknowledged without a durable record, raw webhook failures lack a usable replay path, and non-idempotent ad creation still has an unavoidable provider/DB ambiguity. |
| **F-18 Media lifecycle** | **PARTIAL** | Typed thumbnail outcomes, durable retry state, backfill, reconciliation, and create-before-R2 intent are present. Explicit deletion removes R2 objects and the DB row concurrently while swallowing thumbnail failure, so a never-expiring public thumbnail can be orphaned (`apps/api/src/routes/media.ts:648-658`; `apps/api/src/services/media-reliability.ts:283-290`). External R2 configuration is unverified. |
| **F-19 Token refresh concurrency** | **PARTIAL** | The core exclusion, fence, source-CAS, and unknown-outcome model is materially improved and its focused tests pass. A hard crash after the provider boundary can remain permanently stuck with no reconciler, and refreshed ciphertext is unusable by context-free readers because of F-15. |
| **F-20 Thread/email outcomes** | **PARTIAL** | The 24-hour Queue delay and durable target/email ledgers are present. Thread parent claiming can reclaim an already-publishing post and then mark it failed while the first worker succeeds (`apps/api/src/services/thread-publisher.ts:178-205,225-268,442-466`). Some completion effects are detached, and the direct email fallback has no idempotency key. |

## New and residual release blockers

The following findings are independently reproducible from the reviewed source. “Release blocker” means the issue should be fixed or explicitly disabled before production traffic.

### R-01 — CRITICAL — Telegram authentication and account ownership are bypassable

**Evidence**

- `POST /webhooks/platform/telegram/:secret` accepts a request whenever the caller-supplied header equals the caller-supplied URL parameter (`apps/api/src/routes/platform-webhooks.ts:919-947`). Neither value is compared to server-held secret material in that branch.
- The accepted body is persisted and later resolves accounts using a caller-supplied Telegram chat ID (`:949-958,1006-1040`), permitting forged inbound events and automation triggers for a known chat.
- `POST /v1/connect/telegram/direct` accepts an arbitrary `chat_id` without proving that the tenant controls it (`apps/api/src/routes/connect.ts:264-288,1454-1477`).
- Publishing substitutes the shared `TELEGRAM_BOT_TOKEN` for that account (`apps/api/src/services/publisher-runner.ts:313-320`). A tenant that knows a chat/channel ID where the shared bot has privileges can attach it and publish through the bot.
- The intended challenge flow only writes and polls `telegram-code:*` (`connect.ts:1394-1451`); no repository code consumes the code and completes ownership verification.

Telegram documents that the `secret_token` supplied at webhook registration is returned in `X-Telegram-Bot-Api-Secret-Token`; the receiver must compare it with the server's expected value, not another request value: [Telegram Bot API — setWebhook](https://core.telegram.org/bots/api#setwebhook).

**Required fix**

Disable direct connect until a bot-driven, high-entropy, organization-bound and chat-bound ownership challenge is complete. Store one server-held expected webhook secret and compare the header directly to it in constant time. Add negative tests for matching attacker-controlled path/header values and foreign chat IDs.

### R-02 — CRITICAL — Media publishing can exceed the Worker isolate memory limit

**Evidence**

- The publish Queue processes five posts concurrently (`apps/api/src/queues/publish.ts:7-25`).
- Each post then starts every target publisher concurrently using `Promise.allSettled` (`apps/api/src/services/publisher-runner.ts:303-427`).
- Media sources may be arbitrary HTTP(S) URLs (`apps/api/src/schemas/posts.ts:14-32,119-132`), and the shared safe-fetch helper has no byte limit (`apps/api/src/lib/fetch-public-url.ts:4-17`).
- Publishers fully buffer media: YouTube permits 200 MB, X permits 512 MB video, Bluesky permits 100 MB video, Facebook has uncapped video buffers, and Snapchat creates additional encryption copies (`apps/api/src/publishers/youtube.ts:32-45,69-75,170-178`; `twitter.ts:123-143`; `bluesky.ts:261-296`; `facebook.ts:223-242,278-300`; `snapchat.ts:129-163`).
- Direct upload also buffers an absent/zero-`Content-Length` body before applying its 50 MB check, and the dashboard proxy always buffers the request (`apps/api/src/routes/media.ts:372-413`; `apps/app/src/pages/api/media/upload.ts:16-22`).

Cloudflare's current limit is **128 MB per isolate**, shared by concurrent work: [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/).

**Impact**

A single accepted 200 MB media item cannot be safely buffered in a Worker. Several smaller concurrent targets can have the same result: isolate OOM, unrelated failures, Queue retries, and unstable publishing.

**Required fix**

Use streaming/resumable provider uploads, implement byte-counting response readers, reject oversized declared bodies before reading, impose a hard response limit even when `Content-Length` is missing, cap target concurrency, and lower Queue concurrency for memory-heavy jobs. Prefer presigned direct uploads over the dashboard proxy.

### R-03 — HIGH — Account-token encryption has incompatible AAD contracts

Token refresh writes context-bound ciphertext using `{ recordId: account.id, field }` (`apps/api/src/services/token-refresh-coordinator.ts:638-661`). Numerous runtime readers call `maybeDecrypt` without that context, including `apps/api/src/lib/accounts.ts:9-31`, `routes/inbox-helpers.ts:16-54,60-108`, `services/inbox-backfill.ts:42`, analytics, WhatsApp, and publisher paths. Initial connection writes are also generally context-free (`routes/connect.ts:882-903`), creating a mixed database contract.

Rotation processes account tokens without AAD (`apps/api/src/services/encryption-rotation.ts:76-103`) and can repeatedly select the same first 50 rows for other encrypted tables (`:128-177`). Revocation jobs copy account ciphertext but later decrypt without account/field context. Context-bound idempotency responses and revocation ciphertext are not comprehensively rotated.

**Impact:** the first successful refresh can make inbox, analytics, publishing, messaging, disconnect, and revocation fail. Rotation can wedge, and a provider token intended for revocation can remain live.

**Required fix:** create one account-token read/write API used by every connector, publisher, inbox path, refresh path, revocation job, and rotation job. Always supply identical AAD, with an explicit legacy fallback only for known legacy ciphertext. Track a credential version independent of ciphertext bytes, inventory every encrypted column, paginate by a stable key, and test connect → refresh → every consumer → rotate → disconnect/revoke.

### R-04 — HIGH — Automation HTTP nodes expose SSRF and unbounded response ingestion

`http_request` interpolates user/contact data into an arbitrary URL, calls raw `fetch`, follows the runtime's redirect behavior, and reads the full response into automation context (`apps/api/src/services/automations/nodes/http-request.ts:30-74`). Its configurable timeout has no upper bound. `webhook_out` also performs raw `fetch` without the repository's SSRF guard (`apps/api/src/services/automations/actions/webhook.ts:58-98`) and intentionally swallows network errors as successful action completion.

**Impact:** an authorized tenant can target private, loopback, link-local, or cloud-internal services reachable from the Worker; redirects/DNS changes can bypass simple validation; an unbounded response can consume isolate memory; failed outbound actions are recorded as successful.

**Required fix:** require HTTP(S), use `isBlockedUrlWithDns` plus `fetchPublicUrl`, reject redirects, re-check resolved destinations, cap request and response bytes, bound timeouts, and record a durable failed/unknown action outcome instead of swallowing it.

### R-05 — HIGH — Automation credentials are plaintext at rest and readable through the API

`webhook_out` accepts bearer tokens, basic passwords, and HMAC secrets directly in graph configuration (`apps/api/src/schemas/automation-actions.ts:82-95`). The full graph is stored as unencrypted JSONB (`packages/db/src/schema.ts:3767-3787`; `apps/api/src/routes/automations.ts:921-945`) and returned by `GET /automations/{id}` (`routes/automations.ts:66-94,516-550`). A read-only API key can therefore retrieve outbound credentials.

**Required fix:** replace inline values with encrypted secret references, make secret input write-only, redact every response and log, migrate existing graphs, rotate credentials that have been stored in graphs, and add tests that no credential appears in list/get/simulation/run payloads.

### R-06 — HIGH — YouTube and Twilio webhook verification fails open

YouTube verifies `X-Hub-Signature` only when `YOUTUBE_HUB_SECRET` is present; otherwise it accepts the body (`apps/api/src/routes/platform-webhooks.ts:669-724`). Twilio similarly verifies only when `TWILIO_AUTH_TOKEN` exists and otherwise routes arbitrary form bodies (`:1047-1158`). Both environment fields are optional (`apps/api/src/types.ts:86-95`).

There is also an availability mismatch: initial YouTube connection calls `subscribeYouTubeChannel` without the configured secret and swallows subscription failure (`apps/api/src/services/inbox-event-processor.ts:347-362`), while daily renewal supplies the secret and the inbound route then requires a signature (`services/webhook-subscription.ts:321-370`).

Twilio states that all inbound requests are signed with `X-Twilio-Signature`: [Twilio webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security). WebSub signs deliveries when the subscriber supplies `hub.secret`: [W3C WebSub authenticated distribution](https://www.w3.org/TR/websub/#x-hub-signature).

**Required fix:** model each integration as disabled or enabled-with-required-secret; fail startup/deployment validation when an enabled route has no secret; fail closed at the route; include `hub.secret` in initial and renewal subscriptions; throw/retry failed subscription work.

### R-07 — HIGH — Ideas still permits cross-tenant relations

Idea creation accepts arbitrary `group_id` and `tag_ids` without tenant/workspace validation (`apps/api/src/routes/ideas.ts:446-517`). Update replaces tag relations without validation (`:572-603`), move loads the target group without organization predicates (`:717-781`), and tag metadata is joined without an organization predicate (`:97-118`). The schema uses independent FKs rather than tenant-composite constraints for these relations (`packages/db/src/schema.ts:3571-3640,3682-3693`).

**Impact:** a caller with a disclosed foreign ID can associate an idea with another tenant's group/tag, read tag metadata, create referential blockers in the victim tenant, and leave partially created state when later association writes fail.

**Required fix:** add parent uniqueness and child FKs on tenant-composite keys, carry organization/workspace ownership on join rows where needed, validate every group/tag in one scoped query, and transact the idea plus all relations.

### R-08 — HIGH — Publish and thread outcome classification can enable duplicate or contradictory results

When a publisher promise rejects, `publisher-runner` synthesizes `PUBLISH_ERROR` (`apps/api/src/services/publisher-runner.ts:436-446`). The ambiguous-provider branch recognizes only `PLATFORM_ERROR`, `RATE_LIMITED`, and `PUBLISH_FAILED` (`:480-517`), so `PUBLISH_ERROR` falls into the definitive-failure path even if the request crossed the provider boundary.

Thread processing accepts both `scheduled` and `publishing` parents and claims against a freshly read timestamp (`apps/api/src/services/thread-publisher.ts:178-205`). A redelivery can therefore enter while the first worker is publishing; its target claim fails, counts remain zero, and it can mark the parent failed while the first worker succeeds (`:225-268,442-466`). An early “no targets” path also leaves thread execution in flight, and completion webhook dispatch is detached.

**Required fix:** classify exceptions by whether provider I/O began, default post-boundary exceptions to `unknown`, reconcile using stable operation IDs, restrict thread parent claim to a fenced lease owner, and make every execution/parent transition conditional on the same fence.

### R-09 — HIGH — Customer and inbound webhook effects are not crash-complete

Customer webhook event IDs hash only organization, event name, and payload (`apps/api/src/services/webhook-delivery.ts:61-85`), so distinct identical occurrences collapse permanently. Event/delivery commit and Queue send are separate (`:88-120`) with no pending dispatcher. A crash after `pending → in_flight` but before `unknown` strands the row; redelivery sees it is not pending and acknowledges. Every HTTP response, including 429 and 5xx, is terminal (`:167-187,239-285`).

Inbound per-effect processing similarly writes `unknown` before the side effect, catches and swallows failure, and lets the raw receipt complete (`apps/api/src/services/inbox-event-processor.ts:35-77`). The effect row has no raw payload/receipt pointer and no reconciler.

**Required fix:** require a caller-generated stable occurrence ID, use a transactional outbox or pending dispatcher, add fenced pre-boundary leases, distinguish retryable HTTP responses, store sufficient replay input, and build reconcilers for `pending`, expired `in_flight`, and `unknown`.

### R-10 — HIGH — Idempotency receipts never expire and can wedge permanently

The middleware writes a nominal 30-day `expiresAt` but never checks it on conflict (`apps/api/src/middleware/idempotency.ts:7,75-135`), and no cleanup service references the table. The unique key therefore prevents reuse forever. The receipt commits before the route; a thrown handler or crash leaves permanent `in_progress`. Completed 500 responses can be replayed indefinitely.

The request hash uses only `parsedBody` (`:68-73`). The body cache sets every raw, multipart, CSV, and invalid JSON body to `null` (`apps/api/src/middleware/body-cache.ts:15-31`), so different bodies with the same key are indistinguishable. Context-encrypted response bodies are absent from rotation.

**Required fix:** atomically replace expired receipts, add retention and stuck-receipt reconciliation, hash a bounded raw-body digest for every content type, decide which response classes are replayable, and include receipt ciphertext in key rotation.

### R-11 — HIGH — Queue/DLQ paths can still lose, hide, or duplicate work

This is a collection of independently confirmed terminal-path defects:

- DLQ consumers have three retries and no rescue DLQ (`apps/api/wrangler.jsonc:231-279`). If PostgreSQL remains unavailable, `consumeDeadLetterQueue` retries until Cloudflare permanently deletes the message (`apps/api/src/queues/dead-letter.ts:13-35`). Cloudflare confirms that exhausted messages without another DLQ are deleted: [Queues dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/).
- Replay sends first and then marks the failure replayed without an atomic claim (`apps/api/src/services/queue-replay.ts:17-28,87-105`), allowing concurrent or crash-window duplicate replays.
- Raw inbox messages contain only `receipt_id`; generic failure recording cannot derive an organization, while list/replay requires one (`services/inbound-webhook-acceptance.ts:5-9,65-73`; `queues/failures.ts:28-45`; `routes/queue.ts:482-505`). No failed-receipt reconciler exists.
- WhatsApp delivery-status processing uses `Promise.allSettled` and ignores rejected DB updates, after which the raw receipt completes (`services/inbox-event-processor.ts:1859-1913`; `queues/inbox.ts:46-66`).
- Tools Queue wraps all message handlers in an uninspected `Promise.allSettled`; if terminal-state persistence throws, the handler can return successfully and implicitly acknowledge the message (`apps/api/src/queues/tools.ts:17-22,47-55`).
- Publish, refresh, sync, media, and deprecated automation consumers acknowledge some malformed/unknown messages without a durable `permanent_input` record.

**Required fix:** provide a non-lossy rescue sink, atomically claim failures before replay, make replay operation-aware for every external side effect, add raw-receipt reconciliation, inspect every settled result, and persist a terminal record before acknowledging malformed input.

### R-12 — HIGH — WhatsApp phone provisioning can duplicate charges and leak resources

The purchase “lock” is a non-atomic KV `get` followed by `put` (`apps/api/src/routes/whatsapp-phone-provisioning.ts:388-397`). Concurrent requests can both pass the subsequent DB checks and order a real Telnyx number (`:401-466`). Telnyx purchase occurs before a durable local operation is created; Stripe and Meta steps follow serially, so a crash can lose the purchased number or strand a `purchasing` row. Release catches provider failures but still marks the row `released` (`:878-913`). Tenant deletion does not release Telnyx/Meta phone resources (`apps/api/src/services/tenant-deletion.ts:79-122`).

Cloudflare KV is eventually consistent and is not intended for atomic read/write workflows: [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

**Required fix:** create a durable, unique provisioning operation before provider I/O; claim it with a PostgreSQL lease/fence or Durable Object; persist explicit provider phases and unknown outcomes; reconcile by provider operation ID; never mark released until every mandatory release is confirmed; include phone resources in tenant deletion.

### R-13 — HIGH — Paid ad creation has an unresolved provider/DB ambiguity

`create_ad` and `boost_post` invoke platforms that can create active spend before local rows exist. The Queue code explicitly documents that these operations are not idempotent and drops caught failures as `unknown_external_outcome` to avoid duplicate spend (`apps/api/src/queues/ads.ts:94-126`). That handles a thrown error conservatively, but a Worker crash after provider acceptance causes at-least-once Queue redelivery with no durable pre-provider operation to suppress a second campaign. `createCampaign` calls the adapter before inserting its row (`apps/api/src/services/ad-service.ts:370-425`).

**Required fix:** persist a unique operation and request payload before provider I/O, pass a provider idempotency/correlation key where available, write `request_may_have_been_sent` before the boundary, and reconcile provider state before any replay. Do not expose automatic paid-object creation until that state machine is complete.

### R-14 — HIGH — Media deletion can leave public thumbnails indefinitely

The explicit delete route deletes the original, thumbnail, DB row, and cache entry in parallel and swallows thumbnail deletion failure (`apps/api/src/routes/media.ts:648-658`). The R2 `DeleteObject` handler deletes the DB row first and also swallows thumbnail failure (`apps/api/src/services/media-reliability.ts:283-290`). Thumbnails are intentionally public and have no lifecycle expiry.

**Impact:** after the DB row/storage mapping is gone, retries cannot find the object to finish deletion. A user-deleted media preview can remain publicly accessible indefinitely.

**Required fix:** retain a deletion tombstone and both object keys until both R2 deletions are confirmed; retry with durable state; expose/alert terminal deletion failures; only remove the row after storage cleanup.

### R-15 — HIGH — A plaintext database credential is committed in tracked tests

A fallback PostgreSQL DSN containing a username and password is committed in **18** integration tests. The value is intentionally not reproduced here. Locations include:

- `apps/api/src/__tests__/automation-actions.test.ts:29`
- `automation-day-in-the-life.test.ts:71`
- `automation-e2e-integration.test.ts:65`
- `automation-e2e.test.ts:49`
- `automation-entrypoint-filters.test.ts:47`
- `automation-event-kinds.test.ts:39`
- `automation-inbox-pipeline.test.ts:46`
- `automation-input-resume.test.ts:332`
- `automation-integration-actions.test.ts:49`
- `automation-interactive-resume.test.ts:32`
- `automation-message-handler.test.ts:31`
- `automation-non-persisted-events.test.ts:55`
- `automation-routes.test.ts:51`
- `automation-runner.test.ts:26`
- `automation-scheduled-trigger.test.ts:34`
- `automation-trigger-matcher.test.ts:47`
- `automation-webhook-trigger.test.ts:35`
- `usage-timeseries.test.ts:26`

The DSN targets the documented local SSH-forward port, so it should be treated as a potentially live development database credential, not harmless test data. The local structural guard passed, while the configured guard/Gitleaks rules do not detect this credential pattern, demonstrating a detection gap.

**Required incident response:** revoke/rotate the underlying database credential first; remove all fallback literals and require the environment variable; assess and, if appropriate, scrub repository history; add a custom DSN rule and regression fixture that catches credential-bearing connection strings without logging the secret.

### R-16 — HIGH — API deployment is not sequenced with production migration

`.github/workflows/deploy-api.yml:14-20` triggers when `packages/db/**` changes, but its gate only typechecks/tests and then deploys the Worker (`:45-78`). `.github/workflows/ci-db-migrations.yml:27-52` migrates an ephemeral CI database only. No workflow or runbook enforces production migration before schema-dependent code deploys.

The migration verifier also provides less coverage than its name implies: `packages/db/scripts/verify-migrations.ts:60-145` compares table/column names, then checks selected indexes/enums/constraints at `:283-409`. It does not comprehensively compare types, nullability, defaults, PKs, uniques, FKs, delete actions, checks, and every index. Independent static extraction found 244 FK entries on each side and no named-entry mismatch, but that is not a full proof of every action/type; the defect is the future regression gate and release sequence.

**Required fix:** protect one release sequence: clean replay/full catalog diff → production backup/restore readiness → expand migration → catalog/smoke verification → Worker deploy → contract cleanup later. Add a rollback/runbook and deploy-time migration hash check.

### R-17 — HIGH — Organization members can obtain a persistent organization-wide API credential

`apps/app/src/pages/api/bootstrap-key.ts:41-52` checks only that a user and organization exist, then creates a read/write, all-workspace key and stores the raw key in KV without expiry (`:105-145`). `reveal-key.ts:19-55` lets the same broad audience retrieve it. The auth role model gives ordinary members no organization/member management rights (`packages/auth/src/permissions.ts:11-30`), but these routes perform no owner/admin role check.

Separately, API-key administration itself requires only ordinary write permission plus all-workspace scope (`apps/api/src/routes/api-keys.ts:13-21`). Such a key can mint equivalent persistent keys and delete other keys (`:168-275`).

**Impact:** an ordinary member can copy a credential that works outside the dashboard and can survive that member's session or membership removal. A compromised write key can persist access by minting another key.

**Required fix:** stop exposing the shared dashboard credential; proxy dashboard operations server-side or issue short-lived, user-bound credentials. Require a dedicated `manage_api_keys` permission and owner/admin authorization, bind keys to a principal, and revoke that principal's keys when membership ends.

### R-18 — HIGH — Dashboard checkout can create duplicate active Stripe subscriptions

Customer creation uses an idempotency key, but Checkout Session creation does not (`apps/app/src/pages/api/billing/checkout.ts:37-83`). The route neither blocks an existing active/trialing subscription nor records a unique pending checkout. Concurrent clicks can complete two Stripe subscriptions while one local row tracks only one.

**Required fix:** create a durable pending-checkout operation, use a stable Stripe idempotency key, query canonical customer subscriptions before creating another, enforce one active/pending subscription per organization, and reconcile duplicates.

### R-19 — HIGH — Mailchimp datacenter parsing permits host injection

The connector derives a datacenter from `api_key.split("-").pop()` and interpolates it directly into a URL (`apps/api/src/routes/connect.ts:1180-1203`). The schema accepts any string (`apps/api/src/schemas/connect.ts:112-114`). A suffix containing URL delimiters can turn `.api.mailchimp.com` into a path/query component and change the actual destination. The derived value is persisted and reused by the publisher and account routes (`apps/api/src/publishers/mailchimp.ts:23-32`; `routes/accounts.ts:2411-2415,2526-2529`).

**Required fix:** validate the documented datacenter grammar (for example `^[a-z]{2}[0-9]+$`), build via `URL`, and assert that the final hostname is exactly `${dc}.api.mailchimp.com` before every request.

### R-20 — HIGH — Inbound automation webhooks remain replayable

Legacy body-only HMAC remains accepted indefinitely, and timestamp protection is optional (`apps/api/src/services/automations/webhook-receiver.ts:316-407`). Even timestamped requests have no atomic nonce/digest receipt, so one signed request can be repeated within the five-minute window and repeatedly enroll a contact (`:448-484`). The public route buffers the entire body before any size check (`apps/api/src/routes/automation-webhook-trigger.ts:14-27`).

**Required fix:** require timestamped signatures after a migration period, persist a unique signed-request digest/nonce with TTL before enrollment, reject duplicates atomically, and enforce a body-size limit while streaming.

### R-21 — HIGH — Account and tenant deletion still lack complete fencing

`account-revocation` verifies the current credential before provider I/O but clears credentials/status later using only account/job IDs (`apps/api/src/services/account-revocation.ts:167-245`). A reconnect during the provider call can therefore have its new credentials erased by the stale worker. Re-encryption can also look like a credential change because reconnect detection compares ciphertext rather than an independent credential version. Tenant deletion terminal writes similarly lack lease fencing, and phone-provider resources are omitted.

**Required fix:** persist and compare a monotonic credential version/source hash at the final write, fence every lease transition, make revocation jobs reference the grant being revoked, and reconcile every external tenant resource before terminal deletion.

### R-22 — HIGH — The published Zapier integration's primary workflows do not match the API

The existing four Zapier tests pass, but they cover authentication only (`packages/integrations/zapier-app/test/authentication.test.ts:1-87`). Confirmed contract failures are:

- Create Post maps IDs to `{ account_id }` objects (`packages/integrations/zapier-app/src/creates/createPost.ts:4-8`), while the API requires an array of strings (`apps/api/src/schemas/posts.ts:61-67,126-129`).
- Five trigger unsubscribe handlers call `DELETE /v1/webhooks` with an ID in the body (for example `packages/integrations/zapier-app/src/triggers/postPublished.ts:17-25`); the API exposes only `DELETE /v1/webhooks/{id}` (`apps/api/src/routes/webhooks.ts:152-170,477-505`).
- Upload Media only obtains a presigned URL and returns without uploading bytes or confirming the object (`packages/integrations/zapier-app/src/creates/uploadMedia.ts:3-17`; required confirmation at `apps/api/src/routes/media.ts:226-244`).
- `.github/workflows/publish-zapier.yml:20-36` builds, validates, and pushes without running tests.

**Impact:** Create Post fails validation, unsubscribe leaks webhook subscriptions, and the advertised upload action does not produce usable media.

**Required fix:** send string target IDs, correct unsubscribe URLs, implement upload plus confirmation (or rename the action honestly), add action/trigger contract tests, and require them before `zapier push`.

## Additional medium and low findings

### R-23 — MEDIUM — Automation channel opt-in/opt-out does not affect consent enforcement

`opt_in_channel` and `opt_out_channel` write a `__channel_opt_out_*` custom field (`apps/api/src/services/automations/actions/subscription.ts:98-176`). The consent ledger and `getAllowedRecipientHashes` do not read that convention, so the actions neither grant consent nor suppress sends.

**Fix:** route these actions through the canonical consent service and ledger, record provenance, and cover action → attempted send with integration tests.

### R-24 — MEDIUM — Billing recovery and local-trial authority remain incomplete

`apps/api/src/services/scheduled-post-usage.ts:24-49` treats any local active/trialing subscription row and its period as authoritative rather than applying the shared billing policy. Stripe event claims and billing-outbox terminal updates lack lease fencing, and an unresolvable checkout event can be logged and completed without durable manual-resolution state.

**Fix:** use one canonical billing decision for request and scheduled work, fence claims/terminal writes, and retain unresolved canonical events for operator reconciliation.

### R-25 — MEDIUM — OAuth state and WebSocket tickets are not atomically single-use

OAuth consumes KV with `get → put/delete` (`apps/api/src/routes/oauth-callback.ts:37-58`; `routes/connect.ts:2953-2982`). WebSocket ticket redemption does `get → delete` (`routes/websocket.ts:29-43`) while ticket issuance uses a 60-second KV TTL (`:58-65`). Concurrent requests can both consume the same capability; a newly issued key may also be invisible in another location for its entire lifetime.

Cloudflare documents that KV changes can take 60 seconds or more to become visible globally and recommends stronger storage for atomic operations: [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

**Fix:** atomically claim one-time capabilities in a Durable Object or SQL `UPDATE ... WHERE used_at IS NULL`, and validate the absolute stored expiry.

### R-26 — MEDIUM — API/SDK contracts have multiple confirmed mismatches

- `ideas.uploadMedia()` sends a plain object, manually sets `multipart/form-data`, and falls through to JSON encoding (`packages/sdk/src/resources/ideas.ts:77-83,288-291`; `internal/request-options.ts:84-91`). The API requires real multipart `File` data (`apps/api/src/routes/ideas.ts:949-993`).
- Post creation accepts `template_id`, `template_variables`, and `skip_signature` (`apps/api/src/schemas/posts.ts:143-146`), but SDK `PostCreateParams` omits them (`packages/sdk/src/resources/posts/posts.ts:1385-1445`).
- API target status includes `partial`, platform values include four newsletter platforms, and post responses include `metrics`; corresponding SDK response unions omit them.
- The media route's OpenAPI body declares `application/octet-stream`, but runtime rejects that MIME type (`apps/api/src/routes/media.ts:31-49,112-133,349-369`). The SDK defaults to the rejected header (`packages/sdk/src/resources/media.ts:55-70`).
- API CI does not build or parity-check the SDK (`.github/workflows/ci-api.yml:6-34`).

**Fix:** correct multipart construction with the existing upload helper, model allowed media types accurately, regenerate/repair SDK types, and add an OpenAPI/API/SDK contract gate to every API route/schema change.

### R-27 — MEDIUM — User-configured JavaScript regular expressions can exhaust Queue CPU

Inbound automation matching runs raw `new RegExp(k).test(text)` on user-controlled patterns and inbound content (`apps/api/src/services/automations/trigger-matcher.ts:170-191`; `input-resume.ts:178-194`). Pattern/keyword schemas lack practical size/count bounds (`schemas/automation-entrypoints.ts:14-17`).

**Fix:** use a linear-time engine such as RE2, or reject unsafe constructs; cap pattern length, keyword count, and tested input length.

### R-28 — MEDIUM — Timestamp-only cursors can omit tied rows

Posts use strict `< timestamp`, order only by timestamp, and emit only that timestamp (`apps/api/src/routes/posts.ts:808-819,865-882,1072-1080`). The same pattern exists in Ideas (`routes/ideas.ts:261-283,353-355`), inbox conversations/messages (`services/inbox-persistence.ts:326-345,457-474`), webhooks (`routes/webhooks.ts:261-299`), and API keys (`routes/api-keys.ts:112-160`). Rows tied at the page boundary can be skipped forever.

**Fix:** order by `(timestamp DESC, id DESC)`, encode both in an opaque versioned cursor, and reject malformed cursors instead of silently treating them as page one.

### R-29 — MEDIUM — Automation pause/unpause has a missed-wakeup race

`runLoop` reads an active pause and only then parks the run as `waiting/external_event` (`apps/api/src/services/automations/runner.ts:78-99`). Unpause can delete the control after that read but before the park; `resumeExternalEventRuns` sees no parked row (`:574-620`), and the first worker then parks forever. No reconciler wakes orphaned external-event waits.

**Fix:** combine pause validation and parking under a versioned/transactional protocol, or re-check after parking and add a scheduled reconciler for waits with no active pause.

### R-30 — MEDIUM — Dependency audit fails and no audit gate exists

`bun audit --json` reported **47 advisories across 18 package names: 18 high, 22 moderate, and 7 low**. Exposure is mixed:

- Direct API Hono is newer than the implicated range; an older nested Hono appears under MCP, which currently uses stdio rather than HTTP.
- `fast-uri`, `form-data`, `qs`, and `uuid` occur under MCP, n8n, or Zapier dependency graphs and need runtime-specific review.
- `sigstore`, `tar`, `tmp`, `yeoman-environment`, and some `undici`/`ws` copies are mainly build/publishing toolchains.

The presence of a high advisory is not proof that the production API exposes the vulnerable path, but the failed audit and absence of an allowlisted CI policy are still supply-chain gaps.

**Fix:** update direct/transitive dependencies, produce separate deployed-runtime and build-tool SBOMs, document temporary exceptions with owners/expiry, and add a lockfile audit gate.

### R-31 — MEDIUM — Worker binding drift and platform semantics are not CI-tested

API and docs generated types pass `wrangler types --check`, but the app has no generated `worker-configuration.d.ts` and its check fails. It hand-casts bindings via `Record<string, unknown>` (`apps/app/src/env.d.ts:3-5`; `middleware/index.ts:52-64`). API/docs CI runs TypeScript but not `wrangler types --check`.

There is no `@cloudflare/vitest-pool-workers` suite. Queue ACK/retry/DLQ behavior, KV consistency, R2 notifications, Durable Object WebSockets, and scheduled events are therefore tested mainly with Bun mocks rather than workerd.

**Fix:** generate and consume `Cloudflare.Env` for every Worker, run `wrangler types --check` in CI, and add focused workerd integration tests.

### R-32 — MEDIUM — Docs/OpenAPI builds are non-reproducible from the source revision

`apps/docs/scripts/generate-docs.ts:6-36` fetches `https://api.relayapi.dev/openapi.json`, and the normal build regenerates the tracked API reference from that live response (`apps/docs/package.json:6-14`). During this audit, a clean source build succeeded but changed a tracked usage index because the deployed spec differed from the checkout; that generated change was removed after verification.

`AGENTS.md:38-39,93`, `CLAUDE.md:38-39,93`, and `README.md:211-214` also describe a missing `export-openapi` script and missing `sync-openapi` workflow.

**Impact:** the same commit can build different docs over time, a docs build depends on production availability/state, and maintainers cannot run the documented source-contract workflow.

**Fix:** generate and validate OpenAPI deterministically from the checked-out API, build docs from a pinned artifact, compare it with production separately, and update synchronized repository instructions.

### R-33 — MEDIUM — Downloader production artifacts are mutable and unreproducible

Python dependencies have only lower bounds and no lock/hashes (`apps/downloader/pyproject.toml:5-12`). The Dockerfile uses a mutable base, installs whatever resolves that day, runs as root, and has no healthcheck (`apps/downloader/Dockerfile:1-12`). Publishing updates `latest`, while VPS setup defaults to that tag and pulls/restarts it daily (`apps/downloader/setup-vps.sh:50-54,318-363`).

**Fix:** lock dependencies with hashes, pin the base by digest, run non-root with a healthcheck/read-only hardening, publish immutable commit/digest references, and make promotion/rollback explicit.

### R-34 — MEDIUM — Required follow-up effects are detached from Queue success

Examples include first analytics refresh (`apps/api/src/queues/publish.ts:129-134`), completed-thread webhook fan-out (`apps/api/src/services/thread-publisher.ts:520-549`), and streak/notification updates (`services/publisher-runner.ts:692-697,946-975`). Queue work can be acknowledged before those promises become durable, allowing cancellation after the main result is committed.

**Fix:** await the effect before ACK or enqueue it through a durable outbox/Queue. Do not use floating promises for required business effects.

### R-35 — UNVERIFIED HIGH RELEASE GATE — Hyperdrive and R2 external settings

The repository cannot prove two production-critical settings:

1. Hyperdrive query caching is enabled by default and does not invalidate cached reads after writes: [Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/). The same binding is used for auth, billing, claims, leases, and read-after-write paths; the external binding must be verified cache-disabled (or consistency-sensitive traffic must use a separate cache-disabled binding).
2. R2 lifecycle and event notifications are assumed but not provisioned/validated in-repo. `isMediaEventMessage` checks only action/object key and does not verify expected account/bucket (`apps/api/src/services/media-reliability.ts:44-52,175-193`).

**Release action:** verify both settings in the live account, capture evidence, add IaC or a deployment smoke check, and reject R2 events from unexpected bucket/account values.

### R-36 — LOW/MEDIUM — Logging is 100% sampled and includes sensitive identifiers

API and app configure persistent invocation logs at 100% (`apps/api/wrangler.jsonc:26-39`; `apps/app/wrangler.jsonc:8-21`). WebSocket tickets travel in URL query parameters (`apps/api/src/routes/websocket.ts:29,71`), and app middleware logs email addresses (`apps/app/src/middleware/index.ts:155-167`).

**Fix:** choose intentional sampling/retention, keep capabilities out of URLs or redact them, remove direct PII, and alert on durable failure-ledger/DLQ metrics.

### R-37 — LOW — n8n advertises a filter value rejected by the API

n8n offers and sends post status `partial` (`packages/integrations/n8n-node/nodes/RelayApi/RelayApi.node.ts:235-249,416-423`), while the API list-filter enum excludes it (`apps/api/src/schemas/common.ts:68-80`).

**Fix:** add `partial` to the API filter or remove it from n8n, then add a contract test.

## Validation performed

All results below are from the reviewed snapshot unless marked otherwise.

| Check | Result |
|---|---|
| Full API suite: `cd apps/api && bun run test` | **PASS — 54 files, 685 tests, 0 failures.** The isolated runner was used as required. |
| Dashboard suite: `cd apps/app && bun test` | **PASS — 210 tests, 0 failures.** |
| Focused F-01–F-20 remediation suite | **PASS — 11 files, 171 tests, 0 failures.** |
| Zapier suite: `cd packages/integrations/zapier-app && bun run test` | **PASS — 4 tests, 0 failures.** Coverage is authentication-only and does not exercise the broken workflows in R-22. |
| TypeScript | **PASS** for db, auth, MCP, API, app, docs, CLI, n8n, and Zapier via direct project checks. |
| SDK build | **PASS.** This does not provide API/SDK parity; R-26 is a semantic contract mismatch. |
| Lint: `bun run lint` | **PASS with 52 warnings.** Secret structural guard passed; Biome checked 1,165 files. |
| Fresh PostgreSQL migration | **PASS** on disposable PostgreSQL 17: first migration succeeded, second invocation was a no-op, and `db:verify` passed. |
| Migrated catalog summary | **95 public tables, 8 auth tables, `pg_trgm`, ordinary `automation_step_runs`.** |
| App production build | **PASS.** |
| Docs production build | **PASS, but regenerated one tracked API index from live production drift.** The generated change was removed; see R-32. |
| API Wrangler type check | **PASS** — generated types current. |
| Docs Wrangler type check | **PASS** — generated types current. |
| App Wrangler type check | **FAIL** — no generated `worker-configuration.d.ts`; see R-31. |
| Wrangler deploy dry run — API | **PASS** — about 4.43 MB raw / 1.16 MB gzip. |
| Wrangler deploy dry run — app | **PASS** — about 11.57 MB raw / 2.36 MB gzip. |
| Wrangler deploy dry run — docs | **PASS** — about 26.58 MB raw / 3.63 MB gzip; 827 asset files. |
| `bun audit --json` | **FAIL — 47 advisories: 18 high, 22 moderate, 7 low.** See R-30 for exposure qualification. |
| Repository secret guard | **PASS but incomplete** — it did not detect the tracked database credential in R-15. |

### What the passing checks establish

- The baseline can create the reviewed schema on a clean PostgreSQL 17 instance and can be replayed.
- Current TypeScript source compiles, API/app tests are green, and all three Workers can be bundled.
- Many previous fixes are real: ordinary automation step storage, transactional post mutations, account-scoped external identities, generator occurrence/lease handling, durable email outcomes, primary Queue routing, and normal customer webhook secret storage.

### What the passing checks do not establish

- Correct behavior under Worker isolate memory pressure, workerd Queue ACK/retry semantics, KV propagation, provider timeouts, hard crashes, or concurrent redelivery.
- Production database/catalog state, migration ordering, backup/restore viability, or live tenant mismatch counts.
- Production Hyperdrive cache mode, R2 lifecycle/event notification wiring, Queue backlog/DLQ alarms, or deployed secret presence.
- Provider ownership, provider-side idempotency, Stripe/Telnyx reconciliation, or complete account deletion.
- API/SDK/Zapier/n8n semantic parity.
- Production-like latency, throughput, connection pressure, or p50/p95/p99 regression.

## Verified sound areas

The audit also confirmed several important strengths:

- The current schema is not generally “missing foreign keys.” Static inventory found extensive FK coverage and the baseline's named FK inventory aligned with the Drizzle schema. The remaining issue is that some multi-tenant relationships—most notably Ideas—need **composite tenant ownership keys**, not merely an FK to an unscoped ID.
- Meta/WhatsApp HMAC and Stripe webhook signature verification fail closed.
- Customer webhook signing secrets are strongly generated, context-encrypted, redacted, and rotatable.
- API keys are SHA-256 hashed before lookup; authentication checks enabled/expiry/organization lifecycle and has a bounded KV auth-cache TTL.
- The SDK creates one idempotency key per non-GET JSON operation and reuses it across transport retries.
- All primary queues have explicit routing and configured DLQs.
- The email consumer has a durable sent/unknown/failed ledger and Resend idempotency handling.
- Durable Object WebSockets use the Hibernation API.
- Cron dispatch is gated by the exact cron expression.
- Thumbnail generation now has typed outcomes, durable retry state, backfill, and reconciliation.
- Database clients are created within request/job scope rather than retaining live database connections globally.

These strengths reduce risk, but they do not offset the release blockers above.

## Required release plan

### P0 — block production launch

1. Disable Telegram webhook/direct-connect publishing until R-01 is fixed and adversarial tests pass.
2. Revoke/rotate the committed database credential, remove the literals, and close the secret-scanning gap.
3. Unify the account-token AAD contract and run the full connect/refresh/use/rotate/revoke matrix.
4. Stream and byte-bound media, then prove worst-case memory stays below the Worker limit with production-like concurrency.
5. Fail closed for YouTube/Twilio and validate required deployed secrets.
6. Put all automation outbound HTTP through the SSRF/size/timeout guard and migrate/redact automation secrets.
7. Add composite Ideas ownership validation/FKs and transactional relation writes.
8. Make paid/external operations crash-safe: ads, WhatsApp phone provisioning/release, Stripe checkout, publishing, and account deletion.
9. Repair Queue/DLQ/replay, raw inbound reconciliation, customer webhook outbox/leases, and media deletion tombstones.
10. Fix or unpublish the broken Zapier workflows.

### P1 — required before general availability

1. Couple production migration and Worker deployment; expand the catalog verifier and rehearse restore/rollback.
2. Replace the shared revealable dashboard key with user-bound capability and add API-key management permission.
3. Repair SDK/OpenAPI/media contracts and add parity gates for SDK, Zapier, and n8n.
4. Move OAuth/WebSocket one-time claims to atomic storage.
5. Fix consent actions, billing recovery, stable pagination, and automation missed wakeups.
6. Add Worker binding type checks and workerd integration tests to CI.
7. Resolve or explicitly time-bound dependency advisories.
8. Verify and capture live Hyperdrive/R2 configuration.

### P2 — operational hardening

1. Pin and harden downloader builds/deployments.
2. Make docs generation deterministic from the reviewed source revision.
3. Remove detached required effects; add alarms for unknown outcomes, stuck leases, failed raw receipts, pending webhook deliveries, DLQ sink failures, deletion tombstones, and billing operations.
4. Define log sampling/redaction and remove capabilities/PII from loggable URLs/messages.

## Evidence required to change the decision to GO

A new GO review should require all of the following, not only green unit tests:

- adversarial Telegram, Twilio, YouTube, automation SSRF, tenant-ID, replay, and credential-redaction tests;
- workerd tests for Queue ACK/retry/DLQ, KV alternatives, R2 events, scheduled handlers, and Durable Objects;
- deterministic fault injection before/after provider request, provider response, Queue send, DB commit, lease expiry, reconnect, R2 deletion, and Worker termination;
- clean migration plus full catalog diff, backup restore rehearsal, live migration hash/catalog preflight, and ordered deployment evidence;
- provider reconciliation tests for publish, ads, Stripe, Telnyx, token refresh, account revocation, and tenant deletion;
- production-like media memory/load tests and database p50/p95/p99/throughput/connection measurements;
- SDK, Zapier, n8n, and docs contract tests generated from the same checked-out OpenAPI artifact;
- live evidence that Hyperdrive caching is safe for consistency-sensitive paths and R2 lifecycle/notifications target the expected queues;
- a clean secret scan after credential rotation/removal and an audit/SBOM policy with no unexplained release-blocking advisories.

## Official references used

- [Cloudflare Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Cloudflare Queues batching, retries, and acknowledgements](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Cloudflare Queues dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [Cloudflare Queues consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)
- [Cloudflare Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [Cloudflare Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
- [Cloudflare R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)
- [Cloudflare generated Worker TypeScript types](https://developers.cloudflare.com/workers/languages/typescript/)
- [Cloudflare Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Telegram Bot API — setWebhook](https://core.telegram.org/bots/api#setwebhook)
- [Twilio webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security)
- [W3C WebSub signatures](https://www.w3.org/TR/websub/#x-hub-signature)

## Final conclusion

The remediation pass made substantial, valuable progress, and the repository is much closer to a reliable system than the original defect list suggests. It is nevertheless **not production-ready** at this snapshot. The prior report should not be used as a release sign-off: only five of its 20 findings are cleanly verified fixed, one has an incomplete assurance gate, 13 remain partial, and the encryption work has a runtime-breaking contract mismatch.

The decision can change after the P0 items are fixed and the failure-boundary/live-configuration evidence above exists. Until then, the correct release posture is **NO-GO**.
