# Correctness Bug Findings — June 2026

Companion to [README.md](./README.md), [findings.md](./findings.md)
(performance), and [fix-plan.md](./fix-plan.md). Produced 2026-06-10/11 by a
dedicated correctness-bug hunt: **17 specialized finders** (pagination, races,
transactions/integrity, authz/tenancy, validation, error handling,
billing/usage math, publishing state machine, OAuth/token lifecycle,
inbox/messaging, automations engine, cron/date math, media/R2, webhook
verification, SSRF/redirects, SDK drift, dashboard internal routes,
deletion/unpublish paths). Every finding was adversarially verified against
the working tree; **none of the 157 verified claims was refuted**. Findings
that multiple finders reported independently are clustered into one entry
(alternate phrasings noted) — independent rediscovery is itself a
confidence signal.

Verification rigor per entry:
- **[2-lens]** — two independent Fable reviewers (code-correctness +
  reachability/impact); both had to fail to refute.
- **[1-pass]** — one batched Sonnet reviewer per file group (used to finish
  within usage limits; same 0-refutation rate as the 2-lens pass, but treat
  borderline entries with marginally more skepticism).

Scope: performance issues live in findings.md, not here. Issues already filed
there (posts/connections cursor bugs, double-publish re-claim, KV-only
webhook secrets, ignored analytics params, non-atomic usage counter) are
excluded.

## Tally

**116 confirmed bugs** (157 verified claims clustered) —
Critical: 10 · High: 55 · Medium: 34 · Low: 17

By type: logic 28 · data-integrity 20 · validation 13 · drift 12 · billing 10 · authz 9 · pagination 9 · race 7 · error-handling 5 · security 3

## Index

| # | Sev | File | Bug |
|---|---|---|---|
| B1 | critical | `routes/automation-entrypoints.ts` | PATCH entrypoint config clobbers webhook HMAC secret with the public mask string, making inb… |
| B2 | critical | `routes/contacts.ts` | POST /v1/contacts/bulk: returning() index misalignment attaches channels to the wrong contac… |
| B3 | critical | `routes/inbox-feed.ts` | Inbox send-message (Facebook/Instagram) resolves the conversation without scoping to the cal… |
| B4 | critical | `routes/platform-webhooks.ts` | resolveAccount picks an arbitrary social account when the same platform account is connected… |
| B5 | critical | `routes/posts.ts` | POST /v1/posts/{id}/unpublish has no workspace-scope check — scoped keys can delete platform… |
| B6 | critical | `routes/stripe-webhooks.ts` | Stripe webhook returns 200 before processing; handleEvent runs in waitUntil without catch, s… |
| B7 | critical | `services/automations/runner.ts` | Delay nodes never advance: resume_run re-dispatches the delay handler, which re-parks the ru… |
| B8 | critical | `services/invoice-generator.ts` | Monthly overage billing races the subscription.updated webhook: in normal operation overage … |
| B9 | critical | `services/thread-publisher.ts` | Thread publishing has no idempotency claim or target-status check — retries/duplicate delive… |
| B10 | critical | `app:middleware/index.ts` | Removed org members retain full data access: middleware trusts activeOrganizationId without … |
| B11 | high | `app.ts` | GET /v1/whatsapp/phone-numbers: provisioning list route is shadowed by the WhatsApp Cloud-AP… |
| B12 | high | `lib/r2-presign.ts` | presignRelayMediaUrls is a cross-org R2 read oracle — signs any storage key from client-cont… |
| B13 | high | `lib/ssrf-guard.ts` | SSRF guard bypass: userinfo prefix + dotted-decimal private IPv4 are never blocked |
| B14 | high | `middleware/usage-tracking.ts` | usage_records.apiCallsIncluded is frozen at first write — plan changes mid-month corrupt sto… |
| B15 | high | `queues/publish.ts` | Publish-queue consumer re-increments the billed usage counter on every retry, and the PATCH … |
| B16 | high | `queues/publish.ts` | Thread items with delay_minutes > 720 exceed Cloudflare Queues' 12h delaySeconds cap, killin… |
| B17 | high | `routes/accounts.ts` | GET /v1/accounts: cursor filters on random id while sorting by connected_at — page 2 skips a… |
| B18 | high | `routes/ads.ts` | Ads list endpoints (campaigns, ads, audiences): cursor compares random ids while sorting by … |
| B19 | high | `routes/connect.ts` | Default redirect_url 'https://api.relayapi.dev/connect/callback' is rejected by the redirect… |
| B20 | high | `routes/connect.ts` | Secondary-selection OAuth flows discard refresh_token and tokenExpiresAt — Google Business a… |
| B21 | high | `routes/contacts.ts` | Merging a contact into itself deletes the contact and all its channels/field values |
| B22 | high | `routes/contacts.ts` | Contact merge cascade-deletes the source contact's automation runs and opt-out/pause control… |
| B23 | high | `routes/contacts.ts` | Composite (createdAt, id) cursors break on microsecond truncation — bulk-imported rows shari… |
| B24 | high | `routes/inbox-ai.ts` | GET /v1/inbox/priorities omits workspaceScope — workspace-restricted API keys read conversat… |
| B25 | high | `routes/inbox.ts` | GET /v1/inbox/reviews reuses one page token across all accounts/platforms — page 2 silently … |
| B26 | high | `routes/platform-webhooks.ts` | Meta webhook ingestion acks 200 then processes in waitUntil with no catch, and writes the ms… |
| B27 | high | `routes/platform-webhooks.ts` | Layer-4 echo dedup drops real inbound DMs whose text matches ANY recent outbound on the account |
| B28 | high | `routes/platform-webhooks.ts` | Telegram callback_query updates are dropped at the webhook route — inline-button automations… |
| B29 | high | `routes/posts.ts` | scheduled_at ignores the post's timezone field — offset-less timestamps are interpreted as UTC |
| B30 | high | `routes/posts.ts` | Rescheduling a post does not move its cross-post actions, which then permanently fail before… |
| B31 | high | `routes/posts.ts` | PATCH /v1/posts/{id} wipes all post targets when target resolution fails, and the delete+ins… |
| B32 | high | `routes/posts.ts` | Retry resets failed targets to 'publishing' before filtering out unresolvable accounts, stra… |
| B33 | high | `routes/posts.ts` | Retrying a failed post republishes it without its media attachments |
| B34 | high | `routes/posts.ts` | Unpublish sets the whole post to "draft" even when platform deletion failed or only some pla… |
| B35 | high | `routes/posts.ts` | Workspace-scoped API keys can read/modify posts outside their workspace via post sub-resourc… |
| B36 | high | `routes/posts.ts` | GET /v1/posts?include_external=true ignores the workspace_id filter for external posts, and … |
| B37 | high | `routes/usage.ts` | GET /v1/usage reports calendar-month KV usage against the Stripe billing cycle window — DB m… |
| B38 | high | `routes/webhooks.ts` | GET /v1/webhooks and GET /v1/webhooks/logs accept a cursor but never apply it — page 2 is un… |
| B39 | high | `schemas/queue.ts` | Queue slot timezone (and HH:MM range) never validated — one bad timezone stored in KV perman… |
| B40 | high | `services/analytics-refresh.ts` | Analytics refresh overwrites a post's metricsSnapshot with zeros when every platform fetch f… |
| B41 | high | `services/automations/nodes/message.ts` | Message node waits for interactive replies the channel never delivered (and plain wait_for_r… |
| B42 | high | `services/automations/runner.ts` | Runs parked by a contact pause (waiting/external_event) are never resumed — stuck forever ev… |
| B43 | high | `services/automations/scheduler.ts` | input_timeout jobs are not bound to the wait instance that created them — a stale job from a… |
| B44 | high | `services/automations/scheduler.ts` | input_timeout handler looks for port 'timeout' but message-node timeout port is 'no_response… |
| B45 | high | `services/automations/scheduler.ts` | Scheduled-trigger dispatch is not pinned to the firing entrypoint — contacts get routed to w… |
| B46 | high | `services/automations/webhook-receiver.ts` | Webhook trigger slugs are not unique-checked and are matched across all organizations — coll… |
| B47 | high | `services/broadcast-processor.ts` | Broadcast sender is not resumable — mid-run termination strands broadcasts in 'sending' fore… |
| B48 | high | `services/cross-post-processor.ts` | Cross-post action 'atomic claim' never changes status, so concurrent cron ticks double-execu… |
| B49 | high | `services/inbox-backfill.ts` | Facebook comment backfill stores the commenter's display NAME as participantPlatformId/autho… |
| B50 | high | `services/inbox-event-processor.ts` | welcome_message binding can never fire for brand-new contacts — first-inbound hint is always… |
| B51 | high | `services/inbox-event-processor.ts` | Inbox event processor swallows DB persistence failures and acks: inbound messages are perman… |
| B52 | high | `services/invoice-generator.ts` | usageRecords are calendar-month but billing periods are Stripe-anchored — overage billed ove… |
| B53 | high | `services/publisher-runner.ts` | Retry recomputes overall post status from only the retried targets, marking partially-live p… |
| B54 | high | `services/publisher-runner.ts` | publishPostById's published-target guard bails after claiming, leaving crash-interrupted pos… |
| B55 | high | `services/scheduler.ts` | Scheduler never claims due posts — usage is re-charged and publish messages re-enqueued on e… |
| B56 | high | `services/scheduler.ts` | processScheduledPosts never claims posts — queue lag >60s causes repeated re-enqueue and KV … |
| B57 | high | `services/token-refresh.ts` | Failed token refresh re-notifies every org member every day, forever, starting 7 days before… |
| B58 | high | `services/token-refresh.ts` | Token refresh persists NULL access token when the provider returns HTTP 200 with an error bo… |
| B59 | high | `services/webhook-delivery.ts` | Deleting a workspace silently converts its workspace-scoped webhook endpoints into org-wide … |
| B60 | high | `services/whatsapp-broadcast-processor.ts` | WhatsApp broadcast resume re-picks 'sending' rows without claiming recipients — overlapping … |
| B61 | high | `app:lib/upload-media.ts` | Dashboard presigned-upload flow never calls /v1/media/confirm — media rows stuck "pending" f… |
| B62 | high | `app:pages/api/admin/organizations.ts` | Admin plan change rewrites apiCallsIncluded for ALL usage periods, not just current |
| B63 | high | `app:pages/api/bootstrap-key.ts` | Pro-trial orgs are minted/enforced as free plan (trialing treated as free) |
| B64 | high | `pkg:sdk/src/resources/media.ts` | SDK media.upload defaults Content-Type to application/octet-stream, which the API MIME allow… |
| B65 | high | `pkg:sdk/src/resources/whatsapp/groups.ts` | SDK whatsapp.groups and dashboard Groups tab call /v1/whatsapp/groups, which does not exist … |
| B66 | medium | `middleware/usage-tracking.ts` | Free-plan hard limit is checked before adding the current request's units — one bulk request… |
| B67 | medium | `middleware/usage-tracking.ts` | Failed POST requests are billed at full unit count, including rejected bulk payloads and 404s |
| B68 | medium | `routes/analytics.ts` | GET /v1/analytics from_date/to_date are unvalidated strings — garbage input becomes Invalid … |
| B69 | medium | `routes/api-keys.ts` | GET /v1/api-keys accepts a cursor but ignores it — emits next_cursor yet always returns page 1 |
| B70 | medium | `routes/automation-bindings.ts` | Automation binding accepts arbitrary social_account_id, leaking another org's account identi… |
| B71 | medium | `routes/connect.ts` | GET /v1/connect/pending-data can never return data — nothing ever writes pending-oauth:* key… |
| B72 | medium | `routes/connect.ts` | Facebook page list/selection reads only the first Graph API page (default 25) — users with m… |
| B73 | medium | `routes/contacts.ts` | Contact merge is a 6-statement sequence with no transaction — partial failure leaves a half-… |
| B74 | medium | `routes/media.ts` | uploadMedia rejects its own declared content type — OpenAPI body is application/octet-stream… |
| B75 | medium | `routes/posts.ts` | Create-post usage upsert computes overageCostCents at 1000x: per-post overage multiplied by … |
| B76 | medium | `routes/posts.ts` | Scheduler/queue/retry publish usage is metered only in KV, never in the DB billing source of… |
| B77 | medium | `routes/queue.ts` | PUT /v1/queue/slots with set_as_default:false orphans the only default schedule, after which… |
| B78 | medium | `routes/tags.ts` | Timestamp-only cursors with strict lt and no id tie-break skip rows with equal created_at ac… |
| B79 | medium | `routes/threads.ts` | Thread creation inserts N posts + N×M targets without a transaction — partial threads persis… |
| B80 | medium | `routes/usage.ts` | Pagination cursors are unvalidated strings fed to Number()/new Date() — garbage cursor turns… |
| B81 | medium | `routes/workspaces.ts` | GET /v1/workspaces: cursor gt(id) does not match orderBy(name) — workspaces silently missing… |
| B82 | medium | `routes/workspaces.ts` | Scheduled posts in a deleted workspace are orphaned (workspace_id NULL) but still publish, a… |
| B83 | medium | `schemas/webhooks.ts` | Webhook event enum drift: six dispatched events (message.sent, thread.published, streak.*) a… |
| B84 | medium | `services/auto-post-processor.ts` | RSS auto-post dedup cursor written only after the whole item loop — mid-loop failure re-publ… |
| B85 | medium | `services/automations/filter-eval.ts` | Numeric condition operators never match custom fields — values are stored as text but gt/gte… |
| B86 | medium | `services/automations/input-resume.ts` | Input node number validation ignores configured min/max bounds |
| B87 | medium | `services/automations/scheduler.ts` | Stale 'processing' reclaim has no attempts cap and reclaims jobs whose worker is still runni… |
| B88 | medium | `services/contact-linker.ts` | ensureContactForAuthor stores Telegram numeric user IDs in contacts.phone; phone matching us… |
| B89 | medium | `services/inbox-event-processor.ts` | WhatsApp delivery statuses applied without ordering guard — late 'delivered' overwrites term… |
| B90 | medium | `services/inbox-persistence.ts` | upsertConversation COALESCE(new, existing) lets the raw scoped-ID clobber the enriched parti… |
| B91 | medium | `services/inbox-persistence.ts` | Out-of-order/backfilled inbox messages overwrite the conversation's lastMessage preview with… |
| B92 | medium | `services/streak.ts` | streak.milestone webhook and realtime event re-fire on every post made during a milestone day |
| B93 | medium | `services/token-refresh.ts` | Instagram accounts connected via Facebook Login are refreshed with grant_type=ig_refresh_tok… |
| B94 | medium | `services/token-refresh.ts` | Daily token-refresh cron re-enqueues permanently-expired accounts forever, re-notifying ever… |
| B95 | medium | `services/token-refresh.ts` | Token refresh paths bypass the per-account KV lock, letting concurrent refreshes burn single… |
| B96 | medium | `services/webhook-subscription.ts` | YouTube PubSub subscription registers no hub.secret, so X-Hub-Signature verification can nev… |
| B97 | medium | `services/whatsapp-broadcast-processor.ts` | Broadcast processors have no per-recipient claim: overlapping cron ticks send duplicate mess… |
| B98 | medium | `app:pages/api/invitations/[id]/resend.ts` | Invitation resend has no org membership/role check (IDOR + email-trigger) |
| B99 | medium | `pkg:sdk/src/resources/posts/posts.ts` | SDK posts types are stale: missing 'partial' target status, missing newsletter platforms, mi… |
| B100 | low | `queues/ads.ts` | Ads queue retries non-idempotent createAd/boostPost: a partial failure after the platform ca… |
| B101 | low | `queues/media-cleanup.ts` | media-cleanup queue consumer ignores the event's action (and bucket) — a create-event notifi… |
| B102 | low | `routes/inbox-feed.ts` | Inbox sendMessage reply_to param is documented in the API schema and SDK but silently ignore… |
| B103 | low | `routes/media.ts` | DELETE /v1/media/:id removes the R2 object without checking references from scheduled/draft … |
| B104 | low | `routes/media.ts` | Confirm-time MIME/size enforcement is optional — unconfirmed presigned uploads bypass the 50… |
| B105 | low | `routes/media.ts` | confirmMedia is not idempotent — a retried confirm after success returns 404, making clients… |
| B106 | low | `routes/oauth-callback.ts` | OAuth state one-time-use is unenforceable across colos: KV delete-after-read leaves a replay… |
| B107 | low | `schemas/automations.ts` | Automation/segment filter `op` is an unvalidated free string — any typo silently evaluates t… |
| B108 | low | `services/automations/runner.ts` | total_exited counter is never incremented — every exit path (graph_changed, automation_delet… |
| B109 | low | `services/automations/webhook-receiver.ts` | Inbound automation webhook HMAC covers only the body with no timestamp/nonce, allowing replay |
| B110 | low | `services/inbox-event-processor.ts` | WhatsApp batch normalizer attributes every message to contacts[0]'s profile name — wrong aut… |
| B111 | low | `services/recycling-validator.ts` | Monthly recycling gap uses setUTCMonth — configs created on the 29th-31st overflow into the … |
| B112 | low | `services/thread-publisher.ts` | Thread item with only skipped (non-threadable) targets is marked 'published', and thread.pub… |
| B113 | low | `services/weekly-digest.ts` | Weekly digest counts posts by createdAt instead of publish time — 'posts published this week… |
| B114 | low | `app:pages/api/on-demand-request.ts` | Unauthenticated on-demand-request endpoint sends emails with unescaped user input |
| B115 | low | `pkg:sdk/src/resources/inbox/inbox.ts` | API endpoints absent from the SDK: inbox stats/search/priorities, inbox AI (classify/suggest… |
| B116 | low | `pkg:sdk/src/resources/usage.ts` | SDK usage.retrieve() promises required rate_limit.current_minute that the API never returns |

---

### B1 [CRITICAL] PATCH entrypoint config clobbers webhook HMAC secret with the public mask string, making inbound automation webhooks forgeable

- **File:** apps/api/src/routes/automation-entrypoints.ts:457
- **Type:** security  |  **Verification:** 1-pass  |  **Finder:** webhook-verification

GET/list responses run config through maskSecret(), replacing webhook_secret with the literal SECRET_MASK = "••••" (line 41/47-48). The PATCH update handler accepts body.config wholesale: it validates it (webhook_secret is only z.string(), so "••••" passes) and writes resolvedConfig straight to the row (patch.config = resolvedConfig) with no logic to detect the mask or preserve/re-encrypt the existing secret. A normal read-modify-write — GET the entrypoint, tweak payload_mapping or contact_lookup, PATCH the whole config back — therefore stores webhook_secret = "••••" at rest. The receiver (webhook-receiver.ts:343-360) then takes that value, sees it does NOT start with "enc:", and uses it verbatim as the HMAC-SHA256 key. Anyone who knows the public webhook slug (it's in the URL) can now compute HMAC-SHA256("••••", body) and forge a valid x-relay-signature, triggering the automation with arbitrary payloads (e.g. auto_create_contact enrollments, DM sends, tag application) on the org's behalf. It also silently breaks the org's own legitimate integration (their real secret no longer matches).

**Evidence:** GET serialization applies maskSecret() at automation-entrypoints.ts:98, replacing webhook_secret with the literal `"••••"` string. The PATCH handler at lines 457-475 takes `body.config` wholesale when provided, passes it through validateEntrypointConfig (webhook_secret is only z.string() at schemas/automation-entrypoints.ts:62, so "••••" passes), and writes resolvedConfig directly to the DB with no mask-detection or secret-preservation logic. webhook-receiver.ts:350 only invokes decrypt for the `enc:` prefix, so `"••••"` is used verbatim as the HMAC-SHA256 key, making inbound webhook signatures forgeable by anyone who knows the public slug.

**Fix:** In the PATCH config-merge block (automation-entrypoints.ts:459-475), after merging, check `if (kind === 'webhook_inbound' && config.webhook_secret === SECRET_MASK) { config.webhook_secret = (existing.config as any).webhook_secret; }` to restore the stored (encrypted) secret before validation and persist.

---

### B2 [CRITICAL] POST /v1/contacts/bulk: returning() index misalignment attaches channels to the wrong contacts when duplicates are skipped

- **File:** apps/api/src/routes/contacts.ts:1066
- **Type:** data-integrity  |  **Verification:** 2-lens  |  **Finder:** pagination-cursors
- **Independently re-found as:** "Bulk contact create misattributes channels to the wrong contacts when any row conflicts"; "Bulk contact create attaches channels to the wrong contacts when any row conflicts"

POST /v1/contacts/bulk (bulkCreate handler, contacts.ts:1038): the batch is inserted with .onConflictDoNothing().returning({ id }) and channels are zipped by array index (insertedIds[j] vs batch[j]). RETURNING only yields rows actually inserted (duplicates skipped by the partial unique index on (workspace_id, email) are omitted), so after the first skipped row every later batch item is paired with the id of the contact created from the NEXT item: its contact_channels row (e.g. a WhatsApp phone number) is attached to the wrong contact. Additionally, the last N items of the batch (N = number of skips) get insertedIds[j] === undefined and silently lose their channels. Triggered whenever a bulk import contains at least one email that already exists in the workspace (or is duplicated within the batch) and any later item carries account_id/platform/identifier. The per-row predecessor (referenced by the comment at line 1070) was safe; the batching refactor introduced the misalignment.

**Evidence:** contacts.ts:1066 `const insertedIds = result.map((r) => r.id);` then 1077-1080 `for (let j = 0; j < batch.length; j++) { ... const contactId = insertedIds[j];` — result has fewer elements than batch whenever onConflictDoNothing skips a row, so insertedIds[j] no longer corresponds to batch[j].

**Fix:** In apps/api/src/routes/contacts.ts bulkCreate: pre-generate contact ids client-side and match returned ids by set membership instead of index. Import generateId from @relayapi/db (exported at packages/db/src/schema.ts:25), build values as `batch.map((item) => ({ id: generateId("ct_"), organizationId: orgId, ... }))`, keep `.onConflictDoNothing().returning({ id: contacts.id })`, then `const inserted = new Set(result.map((r) => r.id)); created += inserted.size;` and in the channel loop use `const contactId = values[j]!.id; if (inserted.has(contactId) && item.account_id && item.platform && item.identifier) { ... }`. This pairs each channel with the exact contact row generated for that batch item and naturally skips channels for duplicate contacts. Also update packages/sdk if any response shape changes (none needed here) and add a regression test in apps/api/src/__tests__ covering a batch with a mid-batch duplicate email.

---

### B3 [CRITICAL] Inbox send-message (Facebook/Instagram) resolves the conversation without scoping to the caller's org

- **File:** apps/api/src/routes/inbox-feed.ts:642
- **Type:** authz  |  **Verification:** 1-pass  |  **Finder:** authz-tenancy

In sendConversationMessage, the WhatsApp branch looks up the conversation with `and(eq(inboxConversations.id, conversationId), eq(inboxConversations.organizationId, orgId))` (L805-806), but the Facebook/Instagram branch for conv_-prefixed ids queries `eq(inboxConversations.id, conversationId)` with no organizationId filter (L642). A caller who supplies another org's conv_ id gets that conversation's participantPlatformId/platformConversationId used as the send recipient (L644), then a message is actually sent from the caller's own connected account to that foreign customer, and an outbound row is persisted referencing the foreign conversationId (L767-776). This is a missing tenant check that the sibling WhatsApp branch in the same handler correctly performs.

**Evidence:** inbox-feed.ts:639-643 queries `inboxConversations` with only `eq(inboxConversations.id, conversationId)` for `conv_`-prefixed IDs — no `organizationId` filter — allowing any authenticated org to supply another org's `conv_` ID and use that conversation's `participantPlatformId` as the send recipient. The sibling WhatsApp branch at lines 800-808 correctly adds `eq(inboxConversations.organizationId, orgId)`, confirming the omission in the FB/IG branch. Outbound message rows are then persisted with the foreign `conversationId` (line 767-776), corrupting cross-tenant inbox state.

**Fix:** Add `eq(inboxConversations.organizationId, orgId)` to the `.where()` clause on line 642 alongside the existing `eq(inboxConversations.id, conversationId)` predicate, mirroring the WhatsApp branch.

---

### B4 [CRITICAL] resolveAccount picks an arbitrary social account when the same platform account is connected by multiple orgs — webhooks misrouted to one tenant

- **File:** apps/api/src/routes/platform-webhooks.ts:102
- **Type:** data-integrity  |  **Verification:** 1-pass  |  **Finder:** inbox-messaging
- **Independently re-found as:** "platform-account KV lookup cache is never invalidated on account disconnect — inbound webhooks resolve to the deleted account for up to 5 minutes"

The socialAccounts unique index is (organizationId, platform, platformAccountId) (schema.ts:360-364), so two organizations can legitimately connect the same Facebook Page / WhatsApp number / IG account (e.g. agency + client). resolveAccount queries only by (platform, platformAccountId) with `.limit(1)` and no ORDER BY, then caches the arbitrary winner in KV for 300s. All inbox messages, comments, statuses, and automation triggers for that platform account are attributed to whichever org's row the planner returns first; the other org silently receives nothing, and the winner can flip between cache expiries, splitting a single customer thread across two tenants.

**Evidence:** platform-webhooks.ts:102-114 queries socialAccounts with only (platform, platformAccountId) and .limit(1) with no ORDER BY; schema.ts:360-364 confirms the unique index includes organizationId, so two orgs can legitimately share the same platformAccountId. The arbitrary first row is cached in KV for 300s (line 155), routing all inbound messages for that platform account to one org while the other org receives nothing.

**Fix:** Add organizationId to the query or, if truly needing cross-org lookup, return all matching accounts and fan-out the inbox event to each. The KV cache should store a list of AccountLookup entries keyed by platformAccountId and dispatch to all matching orgs.

---

### B5 [CRITICAL] POST /v1/posts/{id}/unpublish has no workspace-scope check — scoped keys can delete platform content in any workspace

- **File:** apps/api/src/routes/posts.ts:2368
- **Type:** authz  |  **Verification:** 1-pass  |  **Finder:** unpublish-delete-paths
- **Independently re-found as:** "unpublishPost does not enforce workspace scope, unlike every other post mutation"

Every other single-post mutation handler (getPost:1709, updatePost:1766, deletePost:1977, retryPost:2015) calls assertWorkspaceScope(c, post.workspaceId) after loading the post, but the unpublishPost handler (posts.ts:2368-2624) never does. The global workspaceScopeMiddleware only inspects a workspace_id query/body param, and the unpublish body contains only `platforms`, so it is a no-op here. An API key restricted to workspace A can therefore unpublish (i.e., issue real DELETE calls against Twitter/Facebook/Instagram/LinkedIn/Reddit/Pinterest and flip the post to draft) for any post in any other workspace of the org — a destructive cross-workspace operation.

**Evidence:** The `unpublishPost` handler at posts.ts:2368-2378 queries posts filtered only by `organizationId` (not `workspaceId`), and never calls `assertWorkspaceScope`, unlike `deletePost` (posts.ts:1977), `retryPost` (posts.ts:2015), `getPost` (posts.ts:1709), and `updatePost` (posts.ts:1766) which all call it. The `workspaceScopeMiddleware` at app.ts:164 checks only the `workspace_id` param/body field, which unpublish's body doesn't contain (`platforms` only), so it is a complete no-op here — a workspace-scoped key can issue real platform DELETE calls for any other workspace's published posts within the same org.

**Fix:** Add `const denied = assertWorkspaceScope(c, post.workspaceId); if (denied) return denied;` immediately after the post-not-found check at posts.ts:2387, mirroring the pattern in `deletePost`.

---

### B6 [CRITICAL] Stripe webhook returns 200 before processing; handleEvent runs in waitUntil without catch, so any failure permanently drops the billing event

- **File:** apps/api/src/routes/stripe-webhooks.ts:71
- **Type:** error-handling  |  **Verification:** 1-pass  |  **Finder:** error-handling
- **Independently re-found as:** "Stripe webhook returns 200 before processing; a failed handler permanently loses the event (org paid but never upgraded, past_due never cleared)"; "Stripe webhook ACKs 200 before processing — failed handlers are never retried, losing billing state transitions"; "Stripe webhook returns 200 before processing (waitUntil); any handler failure permanently drops the billing event"; "Stripe webhook handler runs in waitUntil after returning 200, so handler exceptions permanently lose billing state transitions with no retry"

The handler responds `{ received: true }` 200 immediately and runs `handleEvent(event, env).then(() => KV.put(dedupKey,...))` inside ctx.waitUntil with no .catch. If handleEvent fails transiently (Hyperdrive blip, Stripe subscriptions.retrieve error, KV outage), the rejection is silently discarded — but Stripe already received a 200 and will never retry, despite the code comment claiming 'Stripe retries failed webhooks for 3 days'. Consequences: a lost checkout.session.completed leaves a paying customer on the free plan; a lost invoice.payment_failed/subscription.deleted leaves a non-paying org with Pro entitlements in KV; a lost subscription.updated leaves period dates stale (which then perturbs invoice-generator).

**Evidence:** This is the same finding as [1]: stripe-webhooks.ts:71-77 runs `handleEvent` in `ctx.waitUntil` without `.catch` and returns 200 unconditionally. A rejection from handleEvent is unobserved, the dedup key is not written on failure, but Stripe won't retry because it already received a 2xx. Consequences include paying customers stuck on free plan or cancelled orgs retaining Pro entitlements.

**Fix:** Same fix as [1]: await handleEvent synchronously before responding, or add a `.catch` with a retry mechanism. Do not combine waitUntil fire-and-forget with an unconditional 200 for critical billing state changes.

---

### B7 [CRITICAL] Delay nodes never advance: resume_run re-dispatches the delay handler, which re-parks the run forever

- **File:** apps/api/src/services/automations/runner.ts:269
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** automations-engine

When a delay node returns wait_delay, runLoop sets status='waiting' and inserts a resume_run job, but leaves currentNodeKey pointing at the delay node. When the scheduler's resume_run job fires (scheduler.ts:137-147), it calls runLoop directly with no node advancement — runLoop re-dispatches the same delay handler, which unconditionally computes a fresh resume_at = now + full configured delay (nodes/delay.ts:24) and returns wait_delay again, re-parking the run and inserting another resume_run job. The run oscillates between waiting and the delay node forever: the post-delay branch is never executed, follow-up messages are never sent, and step_run rows plus scheduled jobs accumulate unboundedly (one per delay period). Contrast with input nodes, whose resume paths (input-resume.ts:317-328, scheduler input_timeout scheduler.ts:183-194) explicitly move currentNodeKey through an edge BEFORE calling runLoop — the delay resume path is missing that step. No test covers delay resume (automation-runner.test.ts has zero delay cases; automation-e2e.test.ts:240 explicitly notes 'no delay nodes').

**Evidence:** runner.ts:269-285 sets `status='waiting', waitingFor='delay'` and inserts a `resume_run` job but leaves `currentNodeKey` unchanged. scheduler.ts:137-139 dispatches `resume_run` by calling `runLoop(db, job.run_id, env)` with no node advancement. nodes/delay.ts:24 unconditionally computes a fresh `resume_at = now + delay` and returns `wait_delay` again, so the run parks forever and accumulates unbounded `automation_scheduled_jobs` rows. The `input_timeout` path in scheduler.ts:182-208 shows the correct pattern: it explicitly sets `currentNodeKey=timeoutEdge.to_node` before invoking `runLoop`.

**Fix:** In the `resume_run` scheduler handler, check if the run's `waitingFor='delay'` and `waitingUntil <= now`, then advance `currentNodeKey` to the next node via the delay node's outgoing edge before calling `runLoop` — mirroring the `input_timeout` path.

---

### B8 [CRITICAL] Monthly overage billing races the subscription.updated webhook: in normal operation overage is never billed; with lagging webhooks the same usage is billed repeatedly

- **File:** apps/api/src/services/invoice-generator.ts:38
- **Type:** billing  |  **Verification:** 2-lens  |  **Finder:** races-concurrency
- **Independently re-found as:** "Monthly overage billing is skipped for subs whose period was already rolled by the Stripe webhook (and double-billed when it was not)"; "Monthly Stripe overage reporting only fires for orgs with stale subscription rows — healthy subs are never billed for overage; stale subs can be re-billed the same overage every month"; "Overage is never billed: invoice generator's currentPeriodEnd <= now filter can never match webhook-rolled Stripe periods on a 1st-of-month cron"; "Monthly overage billing has no idempotency and races subscription period rollover: overage is silently never billed in the normal case, and double-billed when a renewal webhook is missed"; "Monthly overage billing cron never matches renewed subscriptions — Pro overage is never invoiced"

generateInvoices (cron `0 0 1 * *`) selects active subs with `currentPeriodEnd <= now` (invoice-generator.ts:38), but subscriptions are anniversary-based (no billing_cycle_anchor anywhere; checkout.ts creates a plain subscription) and webhooks/dashboard sync keep currentPeriodEnd pointing at the next future anniversary. So in normal operation no Stripe-backed sub ever matches at 00:00 UTC on the 1st, and since invoiceItems.create here is the only path that charges overage (no Stripe meter events exist), pro overage is deterministically never billed — silent revenue loss for every pro org. The converse double-charge path is real but conditional: it requires the renewal webhook to stay unprocessed past Stripe's 3-day retry window (and no dashboard billing-page visit, which self-heals the period via billing/status.ts and billing/sync.ts), in which case the stale row matches every month; the calendar-month-aligned usage records (usage-tracking.ts:160-165) never exact-match the anniversary-aligned currentPeriodStart, so the 'most recent completed period' fallback (lines 75-86) runs, and because invoiceItems.create has no idempotency key and nothing marks a usageRecord as billed, the SAME record is re-invoiced only when the org had no billable calls in the latest completed month. Net: deterministic revenue loss (the common case) plus a rare compound-failure double-charge. Severity high rather than critical because the common outcome harms the operator, not customers, and the customer-harm path needs a multi-day webhook outage.

**Evidence:** Selection: `lte(organizationSubscriptions.currentPeriodEnd, now)` (line 38) vs webhook roll `currentPeriodStart: period.start, currentPeriodEnd: period.end` on every customer.subscription.updated (stripe-webhooks.ts:220-221); billing side has no dedup: `await stripe.invoiceItems.create({ customer, amount: overageCostCents, … })` with no idempotency key and no billed-marker write on usageRecords.

**Fix:** Decouple overage billing from the Stripe period, since usage is calendar-month aligned: (1) in generateInvoices, drop the `lte(currentPeriodEnd, now)` filter and instead select all active Stripe-backed subs, then look up the usage record for the just-completed calendar month (periodStart = Date.UTC(year, month-1, 1)) directly; (2) add idempotency/dedup — pass `{ idempotencyKey: `overage:${sub.organizationId}:${periodStart.toISOString()}` }` as the second argument to stripe.invoiceItems.create, and add a billed marker to usage_records (e.g. `stripe_invoice_item_id` / `billed_at` columns in packages/db/src/schema.ts), set it after successful creation, and skip records where it is already set so neither cron re-runs nor stale fallbacks can double-bill; (3) remove the now-dead fallback most-recent-period query (lines 75-86) since the calendar-month lookup is exact.

---

### B9 [CRITICAL] Thread publishing has no idempotency claim or target-status check — retries/duplicate deliveries double-post entire thread positions

- **File:** apps/api/src/services/thread-publisher.ts:185
- **Type:** race  |  **Verification:** 1-pass  |  **Finder:** publishing-state-machine
- **Independently re-found as:** "Thread publisher has no claim or published-target guard — retried/duplicate publish_thread messages republish already-published thread items"; "Thread publisher has no idempotency: queue redelivery or retry after a partial failure republishes already-published thread items to the platforms"

publishThreadPosition publishes every target of every post in postsToPublish without checking whether the post or target is already 'published', and unlike publishPostById (which does an atomic claim and a published-target bail) there is no claim at all. Cloudflare Queues are at-least-once; additionally, handleThreadPublish in queues/publish.ts catches ANY error (e.g. a DB hiccup after a platform publish, or the PUBLISH_QUEUE.send for the next position failing) and calls message.retry(), which re-invokes publishThreadPosition with the same startPosition. Every retry re-publishes the already-published items to Twitter/Threads/etc. — up to 5 duplicate copies of each tweet in the position batch.

**Evidence:** This is the same missing-idempotency bug as [2] described from the at-least-once delivery angle. publishThreadPosition (thread-publisher.ts:185) fetches targets from DB with no status filter and publishes every one unconditionally; Cloudflare Queues' at-least-once guarantee means any duplicate delivery (no failure needed) re-publishes the full position batch to live platforms such as Twitter/Threads. The catch at queues/publish.ts:111 also retries on any error after the platform publish completes, up to 5 additional duplicates per position.

**Fix:** Same as [2]: add per-target status guard (skip if status === 'published') and an atomic claim in publishThreadPosition before any platform calls.

---

### B10 [CRITICAL] Removed org members retain full data access: middleware trusts activeOrganizationId without membership re-check

- **File:** apps/app/src/middleware/index.ts:352
- **Type:** authz  |  **Verification:** 1-pass  |  **Finder:** dashboard-internal-routes

The middleware sets `context.locals.organization` directly from `session.activeOrganizationId` with no verification that the user is still a member of that org, and for internal `/api/*` routes it reads the session from the 5-minute signed cookie cache (getCookieCache) rather than the DB. `requireClient` (api-utils.ts:51) — the gate for every data route (posts, accounts, media, contacts, inbox, automations, etc.) — only checks that `user` and `organization` are present; it never queries the member table. By contrast `requireBillingAdmin` (api-utils.ts:27) does re-query membership, showing the authors knew this check matters but applied it only to billing. Because better-auth's removeMember does not revoke the removed user's sessions or clear their `activeOrganizationId`, a user removed from an org keeps reading/writing that org's tenant data through the dashboard for the lifetime of their session (and the cookie-cache window makes even forced refreshes lag).

**Evidence:** `index.ts:352-359` builds `context.locals.organization` from `session.activeOrganizationId` with no membership query; `requireClient` in `api-utils.ts:54` only checks `!ctx.locals.user || !ctx.locals.organization` — it never queries the `member` table. better-auth's `removeMember` (called at `team-page.tsx:176`) does not revoke or clear the removed user's existing sessions, so removed users retain full cross-tenant read/write access through all data routes gated only by `requireClient` (posts, accounts, media, contacts, automations, etc.) for the session lifetime plus the 5-minute cookie-cache window.

**Fix:** Add a membership re-check in `requireClient` (or a dedicated middleware) that queries `member` for `(userId, organizationId)` and returns 403 if no row is found. Alternatively call better-auth's session revocation when removing a member.

---

### B11 [HIGH] GET /v1/whatsapp/phone-numbers: provisioning list route is shadowed by the WhatsApp Cloud-API list route — SDK phoneNumbers.list() always fails

- **File:** apps/api/src/app.ts:221
- **Type:** drift  |  **Verification:** 1-pass  |  **Finder:** sdk-drift

Two routers register GET handlers for the same effective path. app.ts mounts `whatsapp` at /v1/whatsapp (line 221) before `whatsappPhoneProvisioning` at /v1/whatsapp/phone-numbers (line 222). whatsapp.ts defines GET /phone-numbers (listWhatsAppPhoneNumbers, routes/whatsapp.ts:416-436) with a REQUIRED account_id query (AccountIdQuery, schemas/whatsapp.ts:216-218) returning the Cloud-API shape (id/phone_number/status active|inactive|pending/display_name). whatsapp-phone-provisioning.ts defines GET / (whatsappListProvisionedPhoneNumbers, lines 129-149) with optional status filter returning ProvisionedPhoneNumberListResponse. Since Hono runs the first registered match and its zod validator returns 400 on missing account_id, the provisioning list is unreachable: SDK whatsapp.phoneNumbers.list({status}) (which targets the provisioning shape, including monthly_cost_cents/provider/country) gets a 400 VALIDATION error, and even with account_id supplied it gets the wrong response shape.

**Evidence:** In apps/api/src/app.ts:221-222, the `whatsapp` router is mounted at `/v1/whatsapp` before `whatsappPhoneProvisioning` at `/v1/whatsapp/phone-numbers`; Hono matches routes in registration order. The whatsapp router has `GET /phone-numbers` (routes/whatsapp.ts:419) with AccountIdQuery requiring `account_id` (schemas/whatsapp.ts:216-218), so the SDK's `phoneNumbers.list()` call (packages/sdk/src/resources/whatsapp/phone-numbers.ts:17) without `account_id` always hits the whatsapp router and returns 400, never reaching the provisioning router; even with `account_id` present it returns the wrong Cloud-API response shape instead of the provisioning shape with monthly_cost_cents/provider/country.

**Fix:** Swap the mount order (put whatsappPhoneProvisioning before whatsapp) in app.ts:221-222, or rename the Cloud-API phone-numbers path to something distinct (e.g. `/cloud-phone-numbers`) so the two GET handlers don't collide.

---

### B12 [HIGH] presignRelayMediaUrls is a cross-org R2 read oracle — signs any storage key from client-controlled URLs with no ownership check

- **File:** apps/api/src/lib/r2-presign.ts:93
- **Type:** authz  |  **Verification:** 1-pass  |  **Finder:** media-r2
- **Independently re-found as:** "Filenames containing %, # or ? break the URL→storage-key round-trip, producing dead media URLs at publish time"

Post media URLs are arbitrary client input (schemas/posts.ts MediaItem accepts any http/https URL; stored verbatim in platformOverrides._media at posts.ts:1309-1313). Every read path — GET /v1/posts?include=media, ideas, and the publisher — runs them through presignRelayMediaUrls, which derives the storage key from the URL path and signs a GET for it with no check that the key belongs to the requesting org (r2-presign.ts:88-100). confirmMedia explicitly defends against exactly this ("SECURITY: Validate storage key belongs to this org to prevent cross-org R2 oracle", media.ts:524-530), but the presign path has no equivalent guard. Since media.relayapi.dev is NXDOMAIN, presigning is the only access path to the private bucket, so any org that learns another org's storage key (keys are embedded verbatim in presigned URL paths handed to third-party platforms and in post payloads/webhooks) can mint fresh 1-hour GET URLs for that object indefinitely using its own API key.

**Evidence:** r2-presign.ts:88-100 derives a storage key from any `media.relayapi.dev` URL and signs a fresh R2 GET with no ownership check, in contrast to the explicit `storage_key.startsWith(`${orgId}/`)` guard at media.ts:524-525. The MediaItem schema (schemas/posts.ts:16-26) accepts any http/https URL, so an attacker can include `https://media.relayapi.dev/victim-org/file_xxx/photo.jpg` in their own post and then call GET /v1/posts?include=media to receive a 1-hour presigned GET URL for the victim's private R2 object; because storage keys are embedded verbatim in presigned URL paths returned to third-party platforms, they are observable by platform operators and can be replayed indefinitely.

**Fix:** In `presignRelayMediaUrls`, after deriving `storageKey`, check that it starts with the current `orgId + '/'` (mirroring the confirmMedia guard) and skip signing (returning the original item unchanged) if it does not. The `orgId` can be threaded through as an optional parameter with a `null` fallback to preserve the existing behavior for internal callers that do not need the guard.

---

### B13 [HIGH] SSRF guard bypass: userinfo prefix + dotted-decimal private IPv4 are never blocked

- **File:** apps/api/src/lib/ssrf-guard.ts:266
- **Type:** security  |  **Verification:** 1-pass  |  **Finder:** ssrf-redirects
- **Independently re-found as:** "SSRF guard bypass: non-canonical private/loopback IPv6 literals are not blocked"

isBlockedUrl() blocks private IPv4 only via the BLOCKED_URL_PATTERNS regexes (lines 4-18), which are anchored to the start of the raw URL string ('^https?:\/\/10\.', '^https?:\/\/192\.168\.', etc.). It never runs a parsed dotted-decimal hostname through isPrivateIPv4(). isPrivateIPDecimal() (lines 31-63) only handles integer/octal/hex encodings, and its octal branch is gated on hostname.includes('.0') or /^0\d/. So a URL with a userinfo component such as http://x@192.168.1.1/, http://x@10.5.5.5/, http://x@172.16.9.9/, or even http://x@127.1.2.3/ defeats the anchored regexes (the string after '://' is 'x@192...'), and isPrivateIPDecimal returns false because none of those hosts contain '.0' or start with '0'. isBlockedUrlWithDns then hits 'if (isIpAddress(hostname)) return false' (line 293) and reports not-blocked. Every caller that relies on this guard accepts the URL: webhook create/update/test/delivery (webhooks.ts, webhook-delivery.ts:73), RSS feed fetch (auto-post-processor.ts:199), media validate and platform media downloads (tools.ts:284/736), listmonk instance URL (accounts.ts:2213/2251, listmonk.ts:33), and avatar/media fetches via fetchPublicUrl. The guard's core purpose (reject private/internal addresses) is silently defeated for the most common RFC1918 ranges and loopback.

**Evidence:** ssrf-guard.ts:267: `BLOCKED_URL_PATTERNS` regexes are anchored (`^https?:\/\/10\.` etc.) and tested against the raw URL string; a userinfo prefix (e.g. `http://x@192.168.1.1/`) shifts the private octet past the anchor, so all RFC1918/loopback raw-string tests miss. ssrf-guard.ts:276: `isPrivateIPDecimal()` only handles integer-, octal-, and hex-encoded hostnames — not standard dotted-decimal — so the parsed hostname `192.168.1.1` also returns false. ssrf-guard.ts:293: `isBlockedUrlWithDns` then hits `if (isIpAddress(hostname)) return false`, completing the bypass for every RFC1918 range and loopback.

**Fix:** In `isBlockedUrl()`, after parsing the URL, add `if (isIPv4Address(hostname)) { const n = ipv4ToInt(hostname); if (n !== null && isPrivateIPv4(n)) return true; }` to catch standard dotted-decimal private addresses regardless of userinfo. Alternatively, reject any URL whose `username` or `password` component is non-empty.

---

### B14 [HIGH] usage_records.apiCallsIncluded is frozen at first write — plan changes mid-month corrupt stored overage; posts-route insert seeds free orgs with the 10000 default

- **File:** apps/api/src/middleware/usage-tracking.ts:183
- **Type:** data-integrity  |  **Verification:** 1-pass  |  **Finder:** billing-usage
- **Independently re-found as:** "Overage cost formula mismatch: user-facing endpoints charge per started 1000-block, actual Stripe charge is pro-rated — up to 100x discrepancy"

The onConflictDoUpdate SET clause updates apiCallsCount/overageCalls/overageCallsCostCents but never apiCallsIncluded, so the included quota is whatever the first writer of the month inserted. A free org (200 included) that upgrades to pro mid-month keeps included=200, so every subsequent request records bogus overage (count-200) and inflated overageCallsCostCents; a pro org downgraded mid-month keeps 10000 and records zero overage. Worse, the posts route's competing upsert on the same (org, periodStart) row (posts.ts:1368-1376) inserts without apiCallsIncluded at all, leaving the schema default of 10000 — and since that transactional insert runs during the request while the middleware write is deferred via waitUntil, a free org whose first billable call of the month is a post create gets included=10000 for the whole month. These stored fields are consumed by the admin dashboard (apps/app/src/pages/api/admin/subscriptions.ts:57-58).

**Evidence:** `usage-tracking.ts:183-187` SET clause omits `apiCallsIncluded` — only `apiCallsCount`, `overageCalls`, `overageCallsCostCents`, `updatedAt` are updated on conflict. If `posts.ts:1368-1376` wins the race (runs inside the synchronous transaction while usage tracking is deferred via `waitUntil`) and creates the row first — it provides no `apiCallsIncluded`, so the schema default of `10000` (`schema.ts:772`) is used — then the middleware's subsequent upsert never corrects it; a free org (200 included) keeps `apiCallsIncluded=10000` for the entire month, corrupting the `overageCallsCostCents` stored value that `apps/app/src/pages/api/admin/subscriptions.ts:56-72` reads.

**Fix:** Add `apiCallsIncluded` to the `onConflictDoUpdate` SET clause in `usage-tracking.ts` so it's refreshed on every write; also fix the `posts.ts` insert to pass the correct `apiCallsIncluded` value from the request context rather than relying on the schema default.

---

### B15 [HIGH] Publish-queue consumer re-increments the billed usage counter on every retry, and the PATCH publish path double-bills even on success

- **File:** apps/api/src/queues/publish.ts:122
- **Type:** billing  |  **Verification:** 1-pass  |  **Finder:** error-handling
- **Independently re-found as:** "Publish queue terminal failure handling is dead code (attempts >= 5 vs wrangler max_retries 3, no DLQ): exhausted publishes vanish and posts stay 'publishing' with no failure record"; "Queue consumer charges usage before publishing and re-charges on every retry attempt"; "Queue publish retries re-increment KV usage on every attempt (up to 5x per post)"; "Publish queue increments the KV usage counter before publishing, so every retry and duplicate delivery re-bills the same post"

handlePostPublish runs `if (!body.usage_tracked) await incrementUsage(...)` BEFORE `publishPostById` inside the try; on any throw it calls message.retry(). Since body.usage_tracked is still false on redelivery, each retry re-increments the org's billed KV usage counter — a publish that fails 3 times before succeeding bills 4 units instead of 1. Worse, the only producer that sends usage_tracked:false is PATCH /v1/posts/{id} → status 'publishing' (posts.ts:1866-1871), and usageTrackingMiddleware already bills every mutating /v1/* request 1 unit (app.ts:198, usage-tracking.ts:243-253), so even a fully successful PATCH-triggered publish is billed twice — the create path explicitly sets usage_tracked:true with the comment 'middleware already incremented usage' (posts.ts:1581), which the PATCH path violates. This counter feeds the free-plan hard cap and the Pro overage shown by GET /v1/usage.

**Evidence:** posts.ts:1870 enqueues the PATCH-triggered publish with `usage_tracked: false`, while the `usageTrackingMiddleware` at app.ts:198 already bills the PATCH request itself; in contrast the POST create path at posts.ts:1581 sets `usage_tracked: true` to avoid this. On every retry, the message body is unchanged so `!body.usage_tracked` remains true and `incrementUsage` fires again (publish.ts:122-123), compounding the double-bill with up to 3 extra increments (max_retries: 3 in wrangler.jsonc).

**Fix:** Change posts.ts:1870 to `usage_tracked: true` so the PATCH-triggered publish matches the POST-triggered path; the middleware has already billed the request.

---

### B16 [HIGH] Thread items with delay_minutes > 720 exceed Cloudflare Queues' 12h delaySeconds cap, killing the chain and double-posting earlier items

- **File:** apps/api/src/queues/publish.ts:87
- **Type:** validation  |  **Verification:** 1-pass  |  **Finder:** publishing-state-machine

The thread schema allows delay_minutes up to 1440 (24h → nextDelayMs up to 86,400,000ms), but the consumer passes `delaySeconds: Math.ceil(result.nextDelayMs / 1000)` directly to PUBLISH_QUEUE.send. Cloudflare Queues rejects delaySeconds > 43200 (12 hours), so the send throws AFTER the current position was already published to the platforms. The catch handler then calls message.retry, which re-publishes the already-published position (no idempotency, see thread-publisher finding) up to 5 times, after which the message is dropped and the remaining thread items are never published (stuck 'scheduled' forever, since the scheduler skips threadPosition > 0).

**Evidence:** schemas/threads.ts:38 allows delay_minutes up to 1440, stored as threadDelayMs = 1440*60000 = 86,400,000ms at routes/threads.ts:294. queues/publish.ts:87 passes Math.ceil(result.nextDelayMs/1000) = 86,400 to PUBLISH_QUEUE.send, exceeding Cloudflare Queues' 43,200s hard limit. There is no cap or validation anywhere in the codebase, so the send throws after the position is already published, and the catch at line 100 retries the whole message.

**Fix:** Cap delaySeconds in queues/publish.ts:87 to Math.min(Math.ceil(result.nextDelayMs/1000), 43200), or lower the schema max on delay_minutes to 720 in schemas/threads.ts:38.

---

### B17 [HIGH] GET /v1/accounts: cursor filters on random id while sorting by connected_at — page 2 skips and duplicates accounts

- **File:** apps/api/src/routes/accounts.ts:451
- **Type:** pagination  |  **Verification:** 2-lens  |  **Finder:** pagination-cursors

listAccounts (accounts.ts:425-497) orders rows by desc(connectedAt) but applies the cursor as gt(id, cursor) and emits the last row's random id as next_cursor. Because successive cursors are monotonically increasing in id-space (each next_cursor row passed the previous gt filter), any account whose random id sorts below a cursor is permanently unreachable for the rest of the walk, while page-1 accounts whose id sorts above the cursor reappear as duplicates at the top of page 2; pagination can also report has_more=false before all accounts have been seen. Any org with more than `limit` (default 20) accounts gets duplicated and missing entries when paginating.

**Evidence:** if (cursor) { conditions.push(gt(socialAccounts.id, cursor)); } ... .orderBy(desc(socialAccounts.connectedAt)) — filter key (id) does not match sort key (connectedAt). Contrast with the healthCheck handler in the same file (lines 321/353) which correctly pairs gt(id) with orderBy(id).

**Fix:** Use keyset pagination on the actual sort key, matching the pattern already used in apps/api/src/routes/media.ts:242-291: make next_cursor the last row's connected_at ISO string (next_cursor: hasMore ? data.at(-1)?.connectedAt.toISOString() : null) and apply the incoming cursor as `const d = new Date(cursor); if (!Number.isNaN(d.getTime())) conditions.push(lt(socialAccounts.connectedAt, d));` instead of gt(socialAccounts.id, cursor). For full robustness against equal connected_at timestamps, use a composite cursor (connected_at, id) with orderBy(desc(connectedAt), desc(id)) and filter or(lt(connectedAt, d), and(eq(connectedAt, d), lt(id, cursorId))). Update packages/sdk if the cursor semantics are documented there.

---

### B18 [HIGH] Ads list endpoints (campaigns, ads, audiences): cursor compares random ids while sorting by created_at — pages skip and duplicate rows

- **File:** apps/api/src/routes/ads.ts:320
- **Type:** pagination  |  **Verification:** 2-lens  |  **Finder:** pagination-cursors

listCampaigns (apps/api/src/routes/ads.ts:320 filter, :326 sort, :367 cursor), listAds (:693, :699, :707), and listAudiences (:975, :981, :1001) paginate with `id < cursor` while sorting by desc(createdAt). Ids are random 16-byte hex from generateId (packages/db/src/schema.ts:25-32), so the filter slices the keyspace in an order unrelated to the sort: each subsequent page re-includes already-returned rows whose random id is less than the cursor and permanently excludes unreturned rows whose id is greater or equal. Additionally the orderBy has no id tiebreaker, so equal created_at rows are unstable. Any org with more than `limit` (max 100) campaigns, ads, or audiences gets duplicated and silently missing rows. listAdAccounts (ads.ts:158-166) shows the correct id-cursor/id-order pairing.

**Evidence:** ads.ts:320 `if (cursor) conditions.push(sql`${adCampaigns.id} < ${cursor}`);` followed by ads.ts:326 `.orderBy(desc(adCampaigns.createdAt))` — filter key and sort key disagree; identical pattern at 693/699 and 975/981. Note listAdAccounts (lines 159/166) gets it right by ordering by id.

**Fix:** For each of listCampaigns, listAds, listAudiences in apps/api/src/routes/ads.ts: keep the id as the opaque cursor but switch to composite keyset pagination — replace the cursor condition with sql`(${tbl.createdAt}, ${tbl.id}) < (SELECT created_at, id FROM ${tbl} WHERE id = ${cursor})` (or decode a `createdAt|id` composite cursor) and change the ordering to .orderBy(desc(tbl.createdAt), desc(tbl.id)) so the sort is total and matches the filter. Alternatively, the minimal fix is to copy listAdAccounts: `id > cursor` with .orderBy(tbl.id), at the cost of losing newest-first ordering. Apply the same change to the SDK docs/types if cursor semantics are documented there.

---

### B19 [HIGH] Default redirect_url 'https://api.relayapi.dev/connect/callback' is rejected by the redirect allowlist — starting OAuth without redirect_url always returns 400

- **File:** apps/api/src/routes/connect.ts:2662
- **Type:** validation  |  **Verification:** 1-pass  |  **Finder:** oauth-token-lifecycle

startOAuth defaults customerRedirectUrl to 'https://api.relayapi.dev/connect/callback' when query.redirect_url is omitted (it is optional in StartOAuthQuery, schemas/connect.ts:35-39), then immediately validates it with isAllowedCustomerRedirectUrl. ALLOWED_REDIRECT_HOSTS (lib/customer-redirect.ts:4-10) contains relayapi.dev, app.relayapi.dev, dashboard.relayapi.dev, docs.relayapi.dev and localhost — but NOT api.relayapi.dev. So any API customer calling GET /v1/connect/{platform} without redirect_url gets 400 INVALID_REDIRECT_URL; the documented-optional parameter is de facto required. The same default + check exists in completeOAuth (connect.ts:2747-2756).

**Evidence:** customer-redirect.ts:4-10 lists relayapi.dev, app.relayapi.dev, dashboard.relayapi.dev, docs.relayapi.dev, localhost — not api.relayapi.dev. connect.ts:2661-2665 defaults customerRedirectUrl to 'https://api.relayapi.dev/connect/callback' when query.redirect_url is absent, then immediately returns 400 INVALID_REDIRECT_URL. The same default + check is present in completeOAuth at 2747-2756, making redirect_url de facto required despite being declared optional.

**Fix:** Either add 'api.relayapi.dev' to ALLOWED_REDIRECT_HOSTS in customer-redirect.ts, or change the default fallback URL in both startOAuth and completeOAuth to a host that is already in the allowlist (e.g. 'https://app.relayapi.dev/connect/callback').

---

### B20 [HIGH] Secondary-selection OAuth flows discard refresh_token and tokenExpiresAt — Google Business and Snapchat connections die within ~1 hour, Pinterest within ~30 days

- **File:** apps/api/src/routes/connect.ts:859
- **Type:** data-integrity  |  **Verification:** 1-pass  |  **Finder:** oauth-token-lifecycle

For SECONDARY_SELECTION_PLATFORMS (facebook, linkedin, pinterest, googlebusiness, snapchat), exchangeAndSaveAccount stores only {access_token, profile_id, expires_at} in the pending-secondary KV entry — tokens.refresh_token is dropped on the floor (it is only referenced at connect.ts:877 in the single-select path). The select handlers (selectGBPLocation connect.ts:2453-2474, selectSnapchatProfile connect.ts:2592-2611, selectPinterestBoard connect.ts:2272-2295) then insert the account with neither refreshToken nor tokenExpiresAt. Because tokenExpiresAt is NULL, the refresh cron skips these accounts (token-refresh.ts:39 isNotNull filter) and refreshTokenIfNeeded returns the stored token unchanged (token-refresh.ts:206 'if (!account.tokenExpiresAt) return token'). Google access tokens expire in 1h, Snapchat in 1h, Pinterest in ~30d — after that, every API call for these accounts fails 401 forever and the refresh token needed to recover was never persisted; the user must fully reconnect.

**Evidence:** connect.ts:859-867 confirms the KV write for SECONDARY_SELECTION_PLATFORMS stores only {access_token, profile_id, expires_at} — no refresh_token. The insert for googlebusiness (2453-2463), snapchat (2592-2601), and pinterest (2272-2283) all omit both refreshToken and tokenExpiresAt fields. token-refresh.ts:39 filters on isNotNull(tokenExpiresAt), so these accounts are skipped by the refresh cron, and token-refresh.ts:206 returns the stored token unchanged when tokenExpiresAt is null — making expiry-based recovery impossible.

**Fix:** In the pending-secondary KV put (connect.ts:859-867), also store the refresh_token (encrypted) and expires_at. In each secondary-selection insert handler (selectGBPLocation, selectSnapchatProfile, selectPinterestBoard), read refresh_token and tokenExpiresAt from pendingData and include them in the .values() call.

---

### B21 [HIGH] Merging a contact into itself deletes the contact and all its channels/field values

- **File:** apps/api/src/routes/contacts.ts:1161
- **Type:** data-integrity  |  **Verification:** 2-lens  |  **Finder:** transactions-integrity
- **Independently re-found as:** "Self-merge (merge_contact_id == id) permanently deletes the contact and all its data"

POST /v1/contacts/{id}/merge never checks that merge_contact_id differs from the path id. When sourceId === targetId, the dedupe DELETE on contact_channels (routes/contacts.ts:1208-1216) matches every channel against itself and deletes all of them; the same pattern wipes all custom_field_values (1227-1235); line 1261 then deletes the contact row itself. Cascade deletes (schema.ts): custom_field_values, contact_channels, automation_runs (2711), automation_contact_controls (2828), contact_segment_memberships (2897). Two corrections to the original claim: inbox_conversations.contactId is onDelete "set null" (schema.ts:1050) so conversations are unlinked, not deleted, and broadcast_recipients.contact_id has no FK so it retains a dangling id. The call returns 200 with channels_moved: 0, fields_moved: 0 and no-op update counts. Severity is high rather than critical: the destruction is permanent and silent, but only triggerable by the caller against their own org's contact (no cross-tenant or privilege impact).

**Evidence:** Handler validates only existence/org of target (line 1168) and source (line 1186) — both resolve to the same row when ids are equal. Dedupe query: `DELETE FROM contact_channels WHERE contact_id = ${sourceId} AND (social_account_id, identifier) IN (SELECT ... WHERE contact_id = ${targetId})` (lines 1208-1216) deletes all channels when sourceId===targetId; line 1261 then `await db.delete(contacts).where(eq(contacts.id, sourceId))` deletes the contact.

**Fix:** In apps/api/src/routes/contacts.ts, immediately after extracting both ids (after line 1164), add: if (sourceId === targetId) { return c.json({ error: { code: "VALIDATION_ERROR", message: "merge_contact_id must be different from the target contact id" } }, 400); } — and add a 400 response with ErrorResponse to the mergeContact createRoute definition (line 381). Mirror the constraint in the SDK doc comment for merge_contact_id (packages/sdk/src/resources/contacts.ts:750). As hardening, wrap the multi-statement merge in a transaction so partial failures cannot leave a half-merged contact.

---

### B22 [HIGH] Contact merge cascade-deletes the source contact's automation runs and opt-out/pause controls, and orphans subscription-list rows

- **File:** apps/api/src/routes/contacts.ts:1261
- **Type:** data-integrity  |  **Verification:** 1-pass  |  **Finder:** inbox-messaging
- **Independently re-found as:** "Contact merge response drops the documented required field enrollments_updated; sequence/automation enrollments are cascade-deleted, not re-parented"; "Contact merge is non-transactional and silently cascade-deletes the source's automation runs, pause controls, and segment memberships"

POST /v1/contacts/{id}/merge re-parents only contact_channels, custom_field_values, broadcast_recipients, and inbox_conversations, then runs `db.delete(contacts).where(eq(contacts.id, sourceId))`. The schema has `automation_runs.contact_id ... onDelete: 'cascade'` (schema.ts:2709-2711) and `automation_contact_controls.contact_id ... onDelete: 'cascade'` (schema.ts:2826-2828), so the delete silently kills the source contact's active/waiting automation runs and erases their pause/opt-out controls — a merged contact who had opted out of automations becomes messageable again. contact_subscriptions.contact_id has no FK (schema.ts:2951), so the source's list subscriptions/unsubscribes are left orphaned rather than transferred. The sequence of statements is also not wrapped in a transaction, so a mid-way failure leaves a half-merged contact.

**Evidence:** The merge handler at contacts.ts:1204-1261 moves channels, field values, broadcast recipients, and inbox conversations but never touches `automation_runs` or `automation_contact_controls`; when the source contact is deleted at line 1261, cascade FKs at schema.ts:2709-2711 and 2826-2828 silently destroy the source's active/waiting automation runs and opt-out/pause controls. `contactSubscriptions.contactId` has no FK (schema.ts:2948-2951), so those rows are orphaned. The entire operation also lacks a transaction, so a failure mid-way yields a half-merged state.

**Fix:** Before deleting the source contact, re-parent automation_runs, automation_contact_controls (merging/deduplicating opt-out controls), and contact_subscriptions to targetId; wrap all merge steps in a single database transaction.

---

### B23 [HIGH] Composite (createdAt, id) cursors break on microsecond truncation — bulk-imported rows sharing a timestamp are skipped after the page boundary

- **File:** apps/api/src/routes/contacts.ts:529
- **Type:** pagination  |  **Verification:** 2-lens  |  **Finder:** pagination-cursors

The description is accurate with two refinements. (1) The skip window is slightly broader than exact ties: any row whose stored timestamp falls within the cursor row's millisecond (truncated value <= ts < actual cursor value) is excluded, so even non-bulk rows created in the same millisecond can be dropped; bulk import just makes it deterministic for up to 400 rows per 500-row batch with limit 100. (2) Two of the cited sites differ in form but not in effect: segments.ts:117 uses a row-value comparison `(createdAt, id) < ($cursor, $id)` and short-links.ts:404-412 uses drizzle `lt`/`eq` operators whose mapToDriverValue is `value.toISOString()` — both suffer the same millisecond truncation. All ~12 cited list endpoints share the defect.

**Evidence:** contacts.ts:522-529 — cursorRow.createdAt is a JS Date (ms) bound into `sql`(${contacts.createdAt} < ${cursorRow.createdAt} OR (${contacts.createdAt} = ${cursorRow.createdAt} AND ${contacts.id} < ${cursor}))``; schema.ts contacts.createdAt is `timestamp("created_at", { withTimezone: true }).defaultNow()` (µs precision); contacts.ts:1049-1064 bulk-inserts 500-row batches sharing one now().

**Fix:** Never round-trip the cursor timestamp through a JS Date. Minimal fix at each site: fetch the cursor row's created_at as raw text and bind it back with an explicit cast — e.g. `const [cursorRow] = await db.select({ createdAt: sql<string>\`${contacts.createdAt}::text\` }).from(contacts).where(eq(contacts.id, cursor)).limit(1);` then `sql\`(${contacts.createdAt}, ${contacts.id}) < (${cursorRow.createdAt}::timestamptz, ${cursor})\``, preserving microseconds exactly. Cleaner alternative that also removes the extra round trip: inline a scalar row subquery, `sql\`(${contacts.createdAt}, ${contacts.id}) < (SELECT c.created_at, c.id FROM contacts c WHERE c.id = ${cursor})\`` (guarding the no-such-cursor case, where the subquery yields NULL and the condition filters everything, by keeping the existence check or OR-ing `NOT EXISTS`). Apply the same change to broadcasts.ts:394, automations.ts:204, custom-fields.ts:224, auto-post-rules.ts:355, cross-post-actions.ts:117, segments.ts:117, ref-urls.ts:132, ai-knowledge.ts:138/437, short-links.ts:404-412, and automation-runs.ts:234, and add a regression test that bulk-inserts >limit rows with one timestamp and asserts page 2 returns the remainder.

---

### B24 [HIGH] GET /v1/inbox/priorities omits workspaceScope — workspace-restricted API keys read conversations from all workspaces

- **File:** apps/api/src/routes/inbox-ai.ts:292
- **Type:** authz  |  **Verification:** 2-lens  |  **Finder:** pagination-cursors

GET /v1/inbox/priorities (apps/api/src/routes/inbox-ai.ts:292) calls listConversations without workspaceScope, so the only enforced filter is organizationId (inbox-persistence.ts:246). A workspace-restricted API key therefore reads conversation previews (participant names, last message text, labels, counts) from all workspaces within its own organization — an intra-org (not cross-org) authz bypass. Exposure is limited to Pro orgs with AI enabled, since the route is gated by proOnlyMiddleware (app.ts:171) and aiEnabledMiddleware (app.ts:195). The global workspaceScopeMiddleware does not help: it only validates an explicitly supplied workspace_id param, which this route's query schema doesn't even accept.

**Evidence:** inbox-ai.ts:292-300 — the options object passed to listConversations has no workspaceScope key; inbox-persistence.ts:249 `if (filters?.workspaceScope && filters.workspaceScope !== "all")` is the only scope enforcement and is skipped when undefined.

**Fix:** In apps/api/src/routes/inbox-ai.ts:292, add workspaceScope to the listConversations options, matching inbox-feed.ts:179: `const result = await listConversations(db, orgId, { type, platform, status, accountId: account_id, labels: parsedLabels, cursor, limit, workspaceScope: c.get("workspaceScope") });`. Optionally add a regression test asserting a workspace-scoped key only sees its workspaces' (and NULL-workspace) conversations on /v1/inbox/priorities.

---

### B25 [HIGH] GET /v1/inbox/reviews reuses one page token across all accounts/platforms — page 2 silently drops other accounts' reviews

- **File:** apps/api/src/routes/inbox.ts:1604
- **Type:** pagination  |  **Verification:** 2-lens  |  **Finder:** pagination-cursors

Accurate as claimed. One precision: data loss starts on page 1, not just page 2 — with N accounts each fetched at pageSize=limit, up to N×limit reviews are merged and sliced to limit (inbox.ts:1613), and the discarded items are unrecoverable because next_cursor (the last account's platform token, line 1608) has already advanced past them for the surviving account while all other accounts get no cursor at all. On page 2, the shared token is invalid for every account except its originator (Google pageTokens are location/query-bound; Facebook after-cursors are edge-bound), and those 4xx responses are swallowed as empty arrays at 1528/1567/1598.

**Evidence:** inbox.ts:1523 `if (cursor) url += `&pageToken=${encodeURIComponent(cursor)}`` and 1565 `if (cursor) url += `&after=...`` applied inside mapConcurrently over ALL accounts; 1604-1615 aggregates `lastCursor` from whichever result had a cursor and returns `data: allReviews.slice(0, limit)`.

**Fix:** Replace the pass-through platform token with a composite cursor in apps/api/src/routes/inbox.ts listReviews: (1) decode incoming cursor as base64url JSON map { [account.id]: platformToken }; pass map[account.id] to that account's Google pageToken / Facebook after param, and if a cursor was supplied but the account has no entry, return { reviews: [], cursor: null } for it (exhausted) instead of reusing a foreign token; (2) build next_cursor by collecting every non-null per-account token into the map and base64url-encoding it (null only when the map is empty), replacing the lastCursor overwrite at 1606-1609; (3) avoid the lossy merge by fetching with a per-account pageSize (e.g. ceil(limit / accounts.length), min 5) or by returning the full merged set instead of slice(0, limit), and set has_more from the composite map. Mirror the cursor semantics in packages/sdk if the reviews resource documents cursor format.

---

### B26 [HIGH] Meta webhook ingestion acks 200 then processes in waitUntil with no catch, and writes the msg-dedup KV mark before the queue send — transient enqueue failure permanently loses DMs

- **File:** apps/api/src/routes/platform-webhooks.ts:228
- **Type:** error-handling  |  **Verification:** 1-pass  |  **Finder:** error-handling

POST /facebook (and the /whatsapp, /telegram, /sms, /youtube handlers) return 200 to the platform immediately and run the processor via `ctx.waitUntil(processFacebookWebhook(parsed, c.env))` with no .catch. Inside the processor, any thrown error (INBOX_QUEUE.send failure, KV error, DB blip in resolveAccount/echo-dedup queries) rejects the whole promise, abandoning all remaining entries/messages in the batch — and Meta got a 200 so it never redelivers. The inbound-DM path aggravates this: the dedup mark `msg-dedup:${mid}` is PUT (lines 508-509, also 437-438 for echoes) BEFORE `env.INBOX_QUEUE.send` (line 512), so if the send fails, any later delivery of the same mid (Meta's documented dual Page/Instagram-Login duplicate delivery) is skipped by the mark for 300s and the message is never ingested.

**Evidence:** platform-webhooks.ts:228 runs `ctx.waitUntil(processFacebookWebhook(parsed, c.env))` with no `.catch`, so any unhandled rejection (queue send failure, DB error) is silently swallowed and the route already returned 200. Lines 507-509 write `msg-dedup:${mid}` to KV before line 512 calls `INBOX_QUEUE.send`, so a transient queue failure after the KV write permanently marks the message as seen and any Meta retry is skipped, causing irreversible message loss.

**Fix:** Move the dedup KV write to after a successful `INBOX_QUEUE.send` (swap lines 509 and 512). Additionally add a `.catch(err => console.error(...))` to the `waitUntil` promise to surface failures.

---

### B27 [HIGH] Layer-4 echo dedup drops real inbound DMs whose text matches ANY recent outbound on the account

- **File:** apps/api/src/routes/platform-webhooks.ts:483
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** inbox-messaging

In the non-echo inbound path of processFacebookWebhook, 'Layer 4' treats an inbound message as a cross-subscription duplicate if any OUTBOUND message with identical text was created in the last 15s — scoped only by accountId, not by conversation or sender. If the business (or an automation/broadcast) sends 'Thanks!' to customer A and customer B sends an inbound 'Thanks!' (or the same customer echoes back a short reply like 'yes'/'ok') within 15s, the genuine inbound is skipped, its mid is written to msg-dedup KV, and since the route already returned 200 to Meta the message is permanently lost — never persisted, never webhook-dispatched, never run through automations.

**Evidence:** platform-webhooks.ts:484-504 (Layer 4) queries recent outbound messages scoped only to `accountId`, `direction=outbound`, and exact `text` match within 15 seconds — no conversation or sender filter. If the business sends 'Thanks!' to any customer and a different customer sends an inbound 'Thanks!' within 15s, the genuine inbound is dropped: the KV dedup mark is set (line 502) and the route already returned 200 to Meta, so the message is permanently lost.

**Fix:** Add a conversation-scoping condition to the Layer 4 query: join on `inboxConversations.platformConversationId = msg.sender.id` (or filter by `conversationId` derived from the current message's sender) to limit text-match dedup to the same conversation thread.

---

### B28 [HIGH] Telegram callback_query updates are dropped at the webhook route — inline-button automations can never resume

- **File:** apps/api/src/routes/platform-webhooks.ts:826
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** inbox-messaging

processTelegramWebhook bails with `if (!body.message) return;`. Telegram callback_query updates (inline keyboard button taps) carry no top-level `message` field — the message is nested under `callback_query.message` — so every button tap is silently discarded before it reaches the queue. The downstream normalizer normalizeTelegramEvent has a full `payload.callback_query` branch (inbox-event-processor.ts:1763-1789) that produces interactive_payload/button_click events for interactive-resume, but it is dead code: no callback_query ever gets enqueued. Telegram automations that park on branch buttons (`button.<id>` ports) wait forever.

**Evidence:** The `TelegramUpdate` interface (platform-webhooks.ts:805-819) declares only `message?` and no `callback_query` field; `processTelegramWebhook` (line 826) returns immediately when `body.message` is falsy. Telegram callback_query updates carry no top-level `message` field, so they always fail this guard and are dropped before being enqueued. The `callback_query` handler in `normalizeTelegramEvent` (inbox-event-processor.ts:1763-1789) is therefore dead code and inline-button automations can never receive button-click events.

**Fix:** Add `callback_query?: { id: string; from: ...; data?: string; message?: ... }` to the `TelegramUpdate` interface, then replace the early return at line 826 with `if (!body.message && !body.callback_query) return;` and route callback_query updates to the queue with `event_type: 'callback_query'`.

---

### B29 [HIGH] scheduled_at ignores the post's timezone field — offset-less timestamps are interpreted as UTC

- **File:** apps/api/src/routes/posts.ts:1162
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** publishing-state-machine

The API documents `timezone` as the 'IANA timezone for scheduling' (schemas/posts.ts:131) and the ScheduledAt validator accepts ISO strings without a UTC offset (e.g. '2026-06-15T10:00:00'), but the create handler just does `scheduledAt = new Date(body.scheduled_at)`, which on Workers resolves to UTC; the stored timezone is never used to convert the wall-clock time. A user scheduling '10:00' with timezone 'America/New_York' gets published at 10:00 UTC — 4 hours early. The same pattern exists in bulk create (posts.ts:2236), thread create (routes/threads.ts:262), and CSV import (which validates with the same CreatePostBody schema).

**Evidence:** At posts.ts:1162, `scheduledAt = new Date(body.scheduled_at)` parses the offset-less ISO string as UTC, and the `timezone` field stored at posts.ts:1332 is never consulted when computing the `scheduledAt` timestamp. The same pattern is repeated at posts.ts:2236 (bulk create) and at CSV import (posts.ts:3212 also uses `new Date(item.scheduled_at)` at posts.ts:3328). No conversion using a temporal library exists anywhere in the codebase.

**Fix:** Before calling `new Date()`, convert the wall-clock time using the IANA timezone: e.g. use `Temporal.ZonedDateTime.from({ ...Temporal.Instant.from(...).toZonedDateTimeISO(body.timezone) })` or a library like `date-fns-tz`'s `zonedTimeToUtc(body.scheduled_at, body.timezone)`. Apply the same fix in the bulk-create and CSV paths.

---

### B30 [HIGH] Rescheduling a post does not move its cross-post actions, which then permanently fail before the post publishes

- **File:** apps/api/src/routes/posts.ts:1813
- **Type:** data-integrity  |  **Verification:** 2-lens  |  **Finder:** transactions-integrity
- **Independently re-found as:** "PATCH /v1/posts/{id} accepts scheduled_at:"auto" but handler passes it to new Date() — Invalid Date into DB, 500 instead of auto-scheduling"

crossPostActions.executeAt is computed once at creation from scheduledAt (posts.ts:1504-1515). updatePost lets scheduled_at move to a later date, an earlier date, "now", or "draft" (posts.ts:1813-1823) but never updates the post's pending cross-post actions, and UpdatePostBody has no cross_post_actions field, so there is no API path to fix or recreate them (only DELETE /cross-post-actions/{id} to cancel). If the post is rescheduled later (or moved to draft), the cron processor claims the action at the stale executeAt, finds no published post target, and calls markFailed("No published post target found") — a terminal status the due-query never retries — so the repost/comment/quote never executes even after the post publishes. If rescheduled earlier or published via "now", the action instead fires at the wrong (stale) time instead of delay_minutes after actual publish. One correction to the original claim: published posts cannot be updated (status guard at posts.ts:1769), so the draft case is scheduled→draft, not "unpublishing".

**Evidence:** updatePost handles content/overrides/scheduled_at/targets only — no reference to crossPostActions anywhere between lines 1747-1957; cross-post-processor.ts lines 64-76 mark pending actions whose executeAt has passed as failed when no published target exists.

**Fix:** Two complementary changes: (1) In updatePost (posts.ts), when body.scheduled_at is set, update the post's pending cross-post actions in the same request: for a new date, `UPDATE cross_post_actions SET execute_at = newScheduledAt + delay_minutes minutes WHERE post_id = :id AND status = 'pending'` (e.g. drizzle .update().set({ executeAt: sql`...` }) or fetch+map); for "now", anchor executeAt to new Date() + delayMinutes; for "draft", either cancel pending actions or leave them and rely on (2). (2) Defense-in-depth in cross-post-processor.ts: when the parent post exists but has no published target and post.status is scheduled/draft/publishing, do not markFailed — instead release the claim and defer by pushing executeAt to max(now, post.scheduledAt) + delayMinutes (or simply skip without claiming), reserving terminal failure for posts in published/failed states that genuinely have no published target.

---

### B31 [HIGH] PATCH /v1/posts/{id} wipes all post targets when target resolution fails, and the delete+insert is not transactional

- **File:** apps/api/src/routes/posts.ts:1841
- **Type:** data-integrity  |  **Verification:** 2-lens  |  **Finder:** transactions-integrity

In updatePost (posts.ts:1747), when body.targets is a non-empty array (zod enforces min(1), so an empty array is rejected — the wipe requires at least one unresolvable value), the handler destructures only `resolved` from resolveTargets, discarding `failed`. It then unconditionally deletes all existing postTargets rows for the post and inserts replacements only if any targets resolved. If every requested target fails resolution (typo'd acc_ id, misspelled/unconnected platform, out-of-scope workspace — resolveTargets returns failures rather than throwing, target-resolver.ts:220), the post is left with zero targets, the response is 200 with empty targets, and a scheduled post will publish to nothing. createPost mitigates the same case by marking the post "failed" (posts.ts:1165-1173) and createThread rejects with 400 NO_VALID_TARGETS (threads.ts:218-230); updatePost has neither. Additionally, the delete and insert run as separate statements with no transaction, so an insert failure or worker termination between them also leaves the post target-less even when resolution succeeded.

**Evidence:** Lines 1833-1860: `const { resolved } = await resolveTargets(...)` (the `failed` array is not even destructured); `await db.delete(postTargets).where(eq(postTargets.postId, id));` runs before any check on `resolved.length`; insert is guarded by `if (targetValues.length > 0)`. Contrast with createThread (threads.ts:218) which returns 400 NO_VALID_TARGETS when `resolved.length === 0`.

**Fix:** In updatePost's targets branch (posts.ts:1833): (1) destructure `const { resolved, failed } = await resolveTargets(...)` and return 400 `{ error: { code: "NO_VALID_TARGETS", message: failed.map(f => `${f.key}: ${f.error.message}`).join("; ") } }` when `resolved.length === 0`, before touching postTargets (mirror threads.ts:218-230); (2) wrap the delete+insert in `await db.transaction(async (tx) => { await tx.delete(postTargets).where(eq(postTargets.postId, id)); if (targetValues.length > 0) await tx.insert(postTargets).values(targetValues); })`, matching the existing transaction pattern at posts.ts:1323. Optionally include the `failed` list in the success response for partial resolution, as createPost does.

---

### B32 [HIGH] Retry resets failed targets to 'publishing' before filtering out unresolvable accounts, stranding them un-retryable and billed

- **File:** apps/api/src/routes/posts.ts:2066
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** publishing-state-machine

The retry handler batch-updates ALL failed targets to status='publishing' (with error cleared), then fetches their social accounts filtered by existence and the API key's workspace scope, and silently skips (`continue`) targets whose account is missing or out of scope. Those skipped targets are never passed to publishToTargets, so they remain in 'publishing' forever; a subsequent retry only selects status='failed' targets, so they can never be retried. The usage charge at line 2038 (`incrementUsage(..., failedTargets.length)`) also bills for these never-attempted targets.

**Evidence:** At posts.ts:2064-2069 the batch `UPDATE postTargets SET status='publishing'` runs unconditionally for all failed target IDs before the account fetch at 2078-2084; the `continue` at 2090-2091 for missing/out-of-scope accounts leaves those rows permanently stuck in `publishing`, unreachable by the `status='failed'` filter on any future retry. Additionally, `incrementUsage` at line 2038 is called with `failedTargets.length` before any filtering, so never-attempted targets are still billed.

**Fix:** Fetch and filter accounts first (keeping only resolvable ones), then restrict the batch update to only those target IDs that will actually be retried. Move the `incrementUsage` call after filtering so it only charges for targets that will be passed to `publishToTargets`.

---

### B33 [HIGH] Retrying a failed post republishes it without its media attachments

- **File:** apps/api/src/routes/posts.ts:2114
- **Type:** logic  |  **Verification:** 2-lens  |  **Finder:** transactions-integrity
- **Independently re-found as:** "Retry endpoint republishes posts without their media attachments"

The claim is accurate as written. Media for every post (immediate or scheduled) is stored in posts.platformOverrides._media at creation (posts.ts:1309-1314). The queue/scheduler path extracts it (publisher-runner.ts:397-404), and the manual publish endpoint also strips/uses it (posts.ts:1916-1926), but POST /v1/posts/{id}/retry passes [] as mediaItems and the raw overrides (with _media) as targetOptions (posts.ts:2106-2117). publishToTargets only indexes targetOptions by platform key, so _media is silently ignored: text-tolerant platforms (Twitter/X, Facebook, LinkedIn) publish the post live without its images/video, media-required platforms (Instagram, Pinterest, TikTok) fail again, and the retry was already charged via incrementUsage (posts.ts:2038).

**Evidence:** Lines 2106-2117: `const targetOverrides = (post.platformOverrides as Record<string, Record<string, unknown>>) ?? null; const results = await publishToTargets(c.env, post.id, orgId, post.content, [], targetOverrides, ...)` — the 5th argument (mediaItems) is `[]`. Compare publishPostById: `const mediaItems = (Array.isArray(overrides._media) ? overrides._media : []) ...; const { _media: _, ...restOverrides } = overrides;` (publisher-runner.ts:397-401).

**Fix:** In the retry handler (apps/api/src/routes/posts.ts:2106-2117), replicate publishPostById's extraction: `const overrides = (post.platformOverrides as Record<string, unknown>) ?? {}; const mediaItems = (Array.isArray(overrides._media) ? overrides._media : []) as PublishRequest["media"]; const { _media: _, ...restOverrides } = overrides; const targetOverrides = (Object.keys(restOverrides).length > 0 ? restOverrides : null) as Record<string, Record<string, unknown>> | null;` then pass `mediaItems` and `targetOverrides` to publishToTargets instead of `[]` and the raw overrides. Preferably factor this into a shared helper (e.g. splitMediaFromOverrides) used by both publisher-runner.ts and the retry handler so the paths cannot drift.

---

### B34 [HIGH] Unpublish sets the whole post to "draft" even when platform deletion failed or only some platforms were unpublished

- **File:** apps/api/src/routes/posts.ts:2591
- **Type:** logic  |  **Verification:** 2-lens  |  **Finder:** transactions-integrity
- **Independently re-found as:** "Unpublish marks the post 'draft' even when every platform deletion failed or the platform is unsupported — content stays live while DB claims unpublished"; "Platform-filtered unpublish sets the entire post to 'draft' while other targets remain live, then republish permanently wedges the post in 'publishing'"

POST /v1/posts/{id}/unpublish flips posts.status to "draft" unconditionally (posts.ts:2589-2595). Corrupt states: (1) With body.platforms filtering a subset, remaining targets stay status="published" and live, but the post becomes "draft" — the remaining platforms can never be unpublished again (status gate at posts.ts:2388 requires "published"/"partial"), and re-scheduling the draft via updatePost WITH targets deletes all postTargets rows including the live ones (posts.ts:1841, destroying their platformPostId) and republishes to ALL platforms, duplicating content on platforms never unpublished; re-scheduling WITHOUT targets instead trips the guard at publisher-runner.ts:350-351 after the post is claimed into "publishing" (line 336-342), leaving it stuck in "publishing" forever. (2) When the platform DELETE fails, the target is set to "failed" (line 2569) while the content is still live, yet the post still returns 200 with status "draft" and there is no retry path. Note this failure mode is common: the deletion switch (lines 2462-2546) only implements 6 platforms (twitter/facebook/instagram/linkedin/reddit/pinterest); every other platform with a platformPostId always gets success=false → "failed", yet the post still flips to "draft".

**Evidence:** Lines 2589-2595: `await Promise.all([...updatePromises, db.update(posts).set({ status: "draft", updatedAt: new Date() }).where(eq(posts.id, id))])` — runs regardless of `val.success` (line 2569 sets failed targets to status "failed") and regardless of `selectedPlatforms` filtering at lines 2408-2412 leaving other targets published.

**Fix:** In the unpublish handler, derive the final post status from actual target outcomes instead of hardcoding "draft": after running updatePromises, re-fetch all targets for the post; if any target still has status "published" or any deletion failed, set posts.status to "partial" (or keep "published" when nothing was removed) instead of "draft", and only set "draft" when every previously published target was successfully removed. Additionally, keep failed-deletion targets as "published" with the error recorded (rather than "failed") so unpublish can be retried, and surface deletion failures in the response (e.g. per-target errors plus a top-level status reflecting reality). Optionally, make updatePost refuse to delete/rebuild targets whose status is "published" to prevent duplicate republishes from any path.

---

### B35 [HIGH] Workspace-scoped API keys can read/modify posts outside their workspace via post sub-resource endpoints

- **File:** apps/api/src/routes/posts.ts:2656
- **Type:** authz  |  **Verification:** 2-lens  |  **Finder:** authz-tenancy

The bypass is intra-organization: a key scoped to ws_A can read logs/notes and create/overwrite/delete recycling config or overwrite notes of a post in ws_B within the same org, given knowledge of the ws_B post ID (a post_/xp_ nanoid). It is not a cross-org breach. updatePostNotes/getPostNotes also operate on externalPosts (xp_ IDs), which likewise has a workspaceId column (schema.ts:1933) and is unguarded.

**Evidence:** getPostLogs L2661-2665 only does `and(eq(posts.id, id), eq(posts.organizationId, orgId))` with no assertWorkspaceScope; same in getRecyclingConfig (L3432-3436), putRecyclingConfig (L3487-3491), deleteRecyclingConfig (L3590-3594), listRecycledCopies (L3616-3620), getPostNotes (L3724-3728), updatePostNotes (L3760-3764). Contrast getPost which calls `const denied = assertWorkspaceScope(c, post.workspaceId); if (denied) return denied` at L1709.

**Fix:** In each of the 7 handlers, include workspaceId in the existence-check select and enforce scope after confirming the row exists, mirroring getPost: `const [post] = await db.select({ id: posts.id, workspaceId: posts.workspaceId, ... }).from(posts).where(...).limit(1); if (!post) return 404; const denied = assertWorkspaceScope(c, post.workspaceId); if (denied) return denied;`. For getPostNotes/updatePostNotes, also select externalPosts.workspaceId and call assertWorkspaceScope(c, ext.workspaceId) in the external-post branch before reading/writing.

---

### B36 [HIGH] GET /v1/posts?include_external=true ignores the workspace_id filter for external posts, and the lean branch also drops account_ids

- **File:** apps/api/src/routes/posts.ts:943
- **Type:** logic  |  **Verification:** 2-lens  |  **Finder:** pagination-cursors

GET /v1/posts?include_external=true&workspace_id=ws_X correctly filters internal posts by workspace (posts.ts:623-630) but merges in external posts from every workspace the API key can access, because fetchExternalPostItems (posts.ts:943-961) never uses filters.workspace_id — it only applies orgId, the key's workspaceScope (no-op for "all"-scope keys), account_id(s), from/to, and cursor. Separately, the lean branch (no include=targets) at posts.ts:885-892 omits account_ids: accountIdList from the call (the include=targets branch passes it at line 797), so ?include_external=true&account_ids=a,b without include=targets returns external posts unfiltered by account. Severity correction: this is wrong filtering, not an authorization breach — organizationId and the key's workspaceScope are still enforced, so only data the key is authorized to see leaks across the filter (intra-org, cross-workspace data pollution in a filtered timeline).

**Evidence:** posts.ts:943-961 — conditions built from orgId/applyWorkspaceScope/account_ids/account_id/from/to/cursor only; `filters.workspace_id` declared in the type (line 934) but never referenced. posts.ts:885-892 — lean-branch call passes { workspace_id, account_id, from, to, limit, cursor } without account_ids, unlike line 794-802.

**Fix:** In fetchExternalPostItems (apps/api/src/routes/posts.ts), mirror the internal-posts filter precedence (account_ids > account_id > workspace_id) by extending the existing else-if chain at lines 946-952 with: else if (filters.workspace_id) { conditions.push(or(eq(externalPosts.workspaceId, filters.workspace_id), eq(socialAccounts.workspaceId, filters.workspace_id))!); } — the query already left-joins socialAccounts (lines 982-985), and ORing with the account's workspace mirrors the internal query at posts.ts:623-630 while covering external_posts rows whose workspaceId was nulled by ON DELETE SET NULL. Then add account_ids: accountIdList to the lean-branch call at posts.ts:885-892 so it matches the include=targets call at 794-802. Add a regression test (e.g. in apps/api/src/__tests__/) asserting external posts are excluded when workspace_id or account_ids filters don't match.

---

### B37 [HIGH] GET /v1/usage reports calendar-month KV usage against the Stripe billing cycle window — DB match never succeeds for mid-month-anchored subs

- **File:** apps/api/src/routes/usage.ts:84
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** billing-usage
- **Independently re-found as:** "GET /v1/usage falsy `dbCallsCount || kvCount` fallback reports the full calendar-month KV count for non-calendar-aligned billing cycles, inflating usage and overage cost"

The handler matches the current usage record with `r.periodStart.getTime() === cycleStart.getTime()` where cycleStart = sub.currentPeriodStart (the Stripe anniversary timestamp), but usage_records.periodStart is only ever written as the calendar-month 1st 00:00 UTC. For every pro sub anchored mid-month (i.e. all of them, since checkout sets no anchor), the find returns undefined, dbCallsCount is 0, and `dbCallsCount || kvCount` falls back to the calendar-month KV counter. The response then presents that calendar-month count as usage for the Stripe cycle (cycle_start/cycle_end from the sub row): api_calls_used resets to ~0 on the 1st mid-cycle, includes pre-cycle calls early in the cycle, and overage_calls/overage_cost_cents are computed from the wrong window.

**Evidence:** usage-tracking.ts:160-162 always writes `periodStart = Date.UTC(y, m, 1)` (calendar 1st), but usage.ts:84-86 matches against `sub?.currentPeriodStart` from Stripe (e.g. June 15 00:00 UTC set at stripe-webhooks.ts:147/176/220). For any mid-month-anchored subscription the `.find()` never matches, `dbCallsCount` stays 0, and the `dbCallsCount || kvCount` fallback at line 96 always uses the calendar-month KV counter — so `api_calls_used` resets mid-cycle on the 1st and includes pre-cycle calls, making overage calculations wrong.

**Fix:** Either store `usageRecords.periodStart` as the Stripe period start (not calendar 1st) in usage-tracking, or in usage.ts query the most recent record with `periodStart <= cycleStart` and `periodEnd >= cycleStart` instead of a strict timestamp equality match.

---

### B38 [HIGH] GET /v1/webhooks and GET /v1/webhooks/logs accept a cursor but never apply it — page 2 is unreachable

- **File:** apps/api/src/routes/webhooks.ts:520
- **Type:** pagination  |  **Verification:** 2-lens  |  **Finder:** pagination-cursors

GET /v1/webhooks (listWebhooks) and GET /v1/webhooks/logs (getWebhookLogs) accept a cursor query param (WebhookListQuery extends PaginationParams at webhooks.ts:46; getWebhookLogs uses PaginationParams at webhooks.ts:211) and emit next_cursor when has_more (webhooks.ts:268, 581), but neither handler reads or applies it (webhooks.ts:232, 520). One correction to the original description: the emitted next_cursor is the last row's nanoid id, yet both queries ORDER BY createdAt DESC — so the current cursor value is not even a usable keyset key for the sort order. The fix must change the cursor to a createdAt-based value (matching the working implementation in media.ts:230-291) or resolve the id to its createdAt, not merely start reading the existing id cursor. Practical impact: webhook delivery logs beyond the first `limit` rows (max 100) within the 7-day window are unreachable via the API, and clients implementing the documented cursor loop spin forever on identical pages.

**Evidence:** webhooks.ts:520 `const { limit } = c.req.valid("query");` and webhooks.ts:232 `const { limit, workspace_id } = c.req.valid("query");` — no `cursor` variable anywhere in either handler, yet line 581/268 emit `next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null`.

**Fix:** In both handlers, adopt keyset pagination on createdAt as done in apps/api/src/routes/media.ts:230-291. listWebhooks (webhooks.ts:232): destructure cursor, and if present parse `new Date(cursor)` and push `lt(webhookEndpoints.createdAt, cursorDate)` into `conditions`; change line 268 to `next_cursor: hasMore ? (data.at(-1)?.createdAt.toISOString() ?? null) : null`. getWebhookLogs (webhooks.ts:520): destructure cursor, build a shared `gte(webhookLogs.createdAt, sevenDaysAgo)` + optional `lt(webhookLogs.createdAt, cursorDate)` condition list used in both the workspaceScope==="all" and scoped branches; change line 581 to emit the last row's createdAt ISO string. (Optionally add a tiebreaker on id for rows sharing a timestamp: order by createdAt desc, id desc and use a composite cursor.) No schema change needed — cursor already exists in PaginationParams — so no SDK schema update is required.

---

### B39 [HIGH] Queue slot timezone (and HH:MM range) never validated — one bad timezone stored in KV permanently 500s next-slot/preview/find-slot and POST /v1/posts with scheduled_at:"auto"

- **File:** apps/api/src/schemas/queue.ts:16
- **Type:** validation  |  **Verification:** 1-pass  |  **Finder:** input-validation

QueueSlot.timezone is `z.string()` with no IANA validation, and CreateQueueBody.timezone likewise. createSlots stores it straight into KV (routes/queue.ts:275-289) without ever touching Intl. Every reader then constructs `new Intl.DateTimeFormat("en-US", { timeZone: slot.timezone })` (routes/queue.ts:73, services/slot-finder.ts:52), which throws RangeError on an unknown zone. Since the schedule persists in KV, GET /v1/queue/next-slot, GET /v1/queue/preview, GET /v1/queue/find-slot, and any post/thread/bulk create with scheduled_at:"auto" 500 permanently until the schedule is deleted. The automation scheduler explicitly guards this exact failure (services/automations/scheduler.ts:523-530) — the queue paths do not. Additionally the time regex `/^\d{2}:\d{2}$/` (schemas/queue.ts:14) accepts "24:30" or "99:99", which produce Invalid Dates that fail the `target.getTime() > now.getTime()` check, so such slots are silently never scheduled.

**Evidence:** schemas/queue.ts:16 has `timezone: z.string()` with no IANA validation, and routes/queue.ts:73-76 / slot-finder.ts:52-55 both call `new Intl.DateTimeFormat('en-US', { timeZone: slot.timezone })` with zero try/catch around them. An invalid timezone written to KV via createSlots (routes/queue.ts:275-289) permanently breaks GET /v1/queue/next-slot, /preview, /find-slot, and any POST with scheduled_at:'auto' with an unhandled RangeError. The automation scheduler has this exact guard (scheduler.ts:526-530) but the queue paths do not.

**Fix:** Add `.refine(tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }, 'Invalid IANA timezone')` to `QueueSlot.timezone` and `CreateQueueBody.timezone` in schemas/queue.ts. Wrap the `new Intl.DateTimeFormat` calls in calculateUpcomingSlots and findBestSlots in try/catch that returns an empty array or skips the slot.

---

### B40 [HIGH] Analytics refresh overwrites a post's metricsSnapshot with zeros when every platform fetch fails or the post falls outside the 50-item window

- **File:** apps/api/src/services/analytics-refresh.ts:384
- **Type:** data-integrity  |  **Verification:** 1-pass  |  **Finder:** scheduled-crons

refreshInternalPostMetrics initializes `aggregated` to all zeros (lines 285-294) and only adds when a matching platform_post_id is found (line 340). The final `db.update(posts).set({ metricsSnapshot: ... })` at lines 384-390 runs unconditionally — even when zero targets produced metrics (token refresh failed, platform API error, or the post not among the 50 items returned by getPostMetrics for the date window at line 328-333). A transient platform outage therefore wipes a post's existing non-zero metricsSnapshot to all zeros on the Sent tab, and since metricsCollectedAt is also bumped, a post near the 14-day cutoff (analytics-refresh.ts:65-77) can have zeros frozen permanently with no further refresh.

**Evidence:** refreshInternalPostMetrics in analytics-refresh.ts:285-294 zero-initialises aggregated; token refresh failures at line 314 cause a continue skipping that target but leaving aggregated at zero, and the unconditional db.update at lines 383-390 still writes { impressions:0, reach:0, … } plus a fresh metricsCollectedAt — permanently overwriting previously captured non-zero snapshot data. The early-return guard at line 282 only fires when there are no published targets at all, not when all fetches fail. Posts within the 14-day window whose metricsCollectedAt is bumped to now will not be refreshed again until their next scheduled interval, so zeros can persist for hours or days.

**Fix:** Track whether any target produced a match (e.g. a boolean anyMatch flag) and skip the db.update call entirely when no metrics were collected; alternatively merge with the existing snapshot using a SQL COALESCE / JSON merge so that zero-valued fields from a failed run never overwrite non-zero stored values.

---

### B41 [HIGH] Message node waits for interactive replies the channel never delivered (and plain wait_for_reply text replies can never resume a message node) — runs wedge permanently

- **File:** apps/api/src/services/automations/nodes/message.ts:109
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** automations-engine

The wait decision `shouldWait = !!cfg.wait_for_reply || hasInteractive` counts quick replies and branch buttons without checking channel capabilities, while the dispatcher drops them: CHANNEL_SUPPORTS_QUICK_REPLIES.whatsapp === false (platforms/index.ts:144) and card/gallery blocks are skipped as unsupported_by_channel on whatsapp/telegram (platforms/index.ts:201-208, capability matrix 109-128). A WhatsApp message node with quick replies (or a card with branch buttons) parks the run waiting for a tap on UI that was never sent — the run can never resume: interactive-resume needs a matching button./quick_reply. port event that the platform can't produce, and text resume (input-resume.ts:233) returns 'race' for node.kind !== 'input'. The same wedge applies on every channel to wait_for_reply:true messages with no interactive elements and no timeout — no code path resumes a message-kind wait on a plain text reply. Wedged runs also block all future re-enrollment of that contact via the partial unique index on active/waiting runs.

**Evidence:** message.ts:109-111: `hasInteractive` is computed from `renderedBlocks` and `renderedQuickReplies` BEFORE `dispatchAutomationMessage` filters them by channel capability; on WhatsApp, `CHANNEL_SUPPORTS_QUICK_REPLIES.whatsapp === false` (platforms/index.ts:143) and `card`/`gallery` are false (platforms/index.ts:114-115), so a WhatsApp message with quick replies or card branch buttons sets `shouldWait = true` and parks the run, but no interactive UI was ever sent, making the run permanently unresumable. Additionally, any `wait_for_reply: true` message node with no timeout is unresumable via plain text because `resumeWaitingRunOnInput` returns `'race'` when `node.kind !== 'input'` (input-resume.ts:217-218) and `resumeWaitingRunOnInteractive` requires a matched port — no code path resumes a message-kind wait on a text reply.

**Fix:** Move the `hasInteractive` computation to after `dispatchAutomationMessage` returns, computing it from the actually-sent blocks (i.e., filtering by `CHANNEL_CAPABILITIES[channel]` and `CHANNEL_SUPPORTS_QUICK_REPLIES[channel]`). Also handle `wait_for_reply` plain-text resume in the inbox event processor or add a text-reply resume path for `message`-kind waiting runs.

---

### B42 [HIGH] Runs parked by a contact pause (waiting/external_event) are never resumed — stuck forever even after the pause expires or is removed

- **File:** apps/api/src/services/automations/runner.ts:76
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** automations-engine

runLoop's pause check parks the run with status='waiting', waitingFor='external_event', waitingUntil=null and returns. No resume mechanism exists for this state: the pause branch schedules no automation_scheduled_jobs row for pausedUntil expiry; the resume_automations_for_contact action (actions/automation-controls.ts:73-99) and the POST /{id}/automation-resume route (routes/contact-automation-controls.ts) only DELETE the control row without waking parked runs; input/interactive resume only handle waitingFor==='input'; and scheduled/index.ts runs no sweeper over waiting runs ('external_event' appears only in runner.ts:85). A run that hits an active pause (e.g. a resume_run job firing during a 30-minute pause_automations_for_contact) is wedged permanently, and because of the partial unique index idx_automation_runs_active_uniq on (contact_id, automation_id) WHERE status IN ('active','waiting') (schema.ts:2745-2747), the contact can never re-enroll in that automation again.

**Evidence:** runner.ts:82-89 parks a run with `status='waiting', waitingFor='external_event', waitingUntil=null` when a contact pause is active, but inserts no `automation_scheduled_jobs` row and no expiry-based wakeup. The `resume_automations_for_contact` action handler (automation-controls.ts:73-99) and the API route (contact-automation-controls.ts:288-327) only `DELETE` the control row — neither queries for parked runs with `waitingFor='external_event'` nor calls `runLoop` to wake them. The partial unique index on `(contact_id, automation_id) WHERE status IN ('active','waiting')` also permanently blocks re-enrollment.

**Fix:** After deleting the control row in both the action handler and the API route, query `automationRuns` for rows with `waitingFor='external_event'` scoped to the affected `(contactId, automationId|all)`, set them `status='active'`, and call `runLoop` for each.

---

### B43 [HIGH] input_timeout jobs are not bound to the wait instance that created them — a stale job from an earlier node kills a later indefinite wait

- **File:** apps/api/src/services/automations/scheduler.ts:149
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** automations-engine

When a run resumes from an input wait (user replied), the pending input_timeout job is left in the queue. When it later fires, the scheduler only checks (status==='waiting' && waitingFor==='input') and `waitingUntil > now`. If the run has since advanced to a DIFFERENT wait without a timeout — a second input node with no timeout_min, or a message node waiting on button taps (waitingUntil=null in both cases) — the null waitingUntil passes the guard, and the stale job either exits the run with 'input_timeout' or advances it through the new node's timeout edge even though that node's timeout never elapsed. Failure scenario: input A (timeout 30 min) answered in 5 min → flow proceeds to a buttons message waiting indefinitely → at the 30-minute mark A's stale job fires and marks the run exited; the contact's button taps are then dead. Neither the job payload (runner.ts:258-264 stores only result.payload) nor the run records which node/wait scheduled the timeout.

**Evidence:** scheduler.ts:155-161 guards against stale jobs only by checking `run.waitingFor === 'input'` and `run.waitingUntil > now`. A run that has advanced to a new message node with interactive buttons (wait_input with no timeout_at, so waitingUntil=null) passes both guards: status is still 'waiting', waitingFor is still 'input', and `null && ...` is falsy. The stale job from the previous node then exits or misroutes the run (scheduler.ts:195-207).

**Fix:** When creating the input_timeout job (runner.ts:258-264), store the current node key in the job payload; in scheduler.ts, reject the job if `run.currentNodeKey` does not match the node key stored in the job payload.

---

### B44 [HIGH] input_timeout handler looks for port 'timeout' but message-node timeout port is 'no_response' — wired no-response branches never fire, runs are exited instead

- **File:** apps/api/src/services/automations/scheduler.ts:179
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** automations-engine
- **Independently re-found as:** "input_timeout job and inbound input-resume both move a waiting run with unconditional UPDATEs — at the timeout boundary the run executes both branches"; "Timeout-fire vs. user-reply race: input_timeout and input/interactive resume advance runs with unguarded read-then-write updates"

Message nodes with wait_for_reply + no_response_timeout_min park via wait_input with a timeout_at (nodes/message.ts:113-117), and the runner enqueues a generic input_timeout job (runner.ts:257-264). When it fires, the scheduler searches for an edge with `from_port === "timeout"` from the current node, but derivePorts gives message nodes a timeout port keyed 'no_response' (ports.ts:69-71) — 'timeout' exists only on input nodes (ports.ts:79). The operator-wired no_response edge is therefore never found, and the run is unconditionally exited with exitReason='input_timeout' (scheduler.ts:195-207). Any reminder/follow-up branch hung off a message node's no_response port is dead code in production, and the run is killed instead of routed.

**Evidence:** scheduler.ts:178-179 searches for an edge with `from_port === 'timeout'` on input_timeout, but ports.ts:69-71 shows message nodes with wait_for_reply+no_response_timeout_min receive port key 'no_response', not 'timeout' — 'timeout' is only the input node's port (ports.ts:79). The timeout edge wired by operators to 'no_response' is never found, so the scheduler falls through to the else branch at scheduler.ts:195-207 and unconditionally exits the run with exitReason='input_timeout', making any no_response branch dead code.

**Fix:** In scheduler.ts input_timeout handler, look for both port keys: search for an edge with `from_port === 'timeout' || from_port === 'no_response'`, or determine the correct port name based on the node kind before searching.

---

### B45 [HIGH] Scheduled-trigger dispatch is not pinned to the firing entrypoint — contacts get routed to whichever schedule entrypoint sorts first

- **File:** apps/api/src/services/automations/scheduler.ts:343
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** automations-engine

dispatchScheduledTrigger enumerates contacts via the firing entrypoint's filters, then enrolls each through matchAndEnrollOrBinding with a generic kind='schedule' event. matchAndEnroll (trigger-matcher.ts:299-323) selects candidates by (channel, kind, status, org) only — it never filters by the entrypoint_id carried in event.payload — then sorts ALL active schedule entrypoints by specificity/priority/created_at and enrolls into the winner. With two or more active schedule entrypoints on the same org+channel (e.g. two different automations each with a daily cron and tag filters), every dispatch enrolls contacts into the same winning entrypoint's automation; the losing automation's schedule fires its job, enumerates its contacts, and then either enrolls them into the WRONG automation or is blocked by the re-entry/active-run guard — it silently never enrolls anyone into its own flow.

**Evidence:** dispatchScheduledTrigger (scheduler.ts:343-358) builds an event with `payload.entrypoint_id: ep.id` and calls matchAndEnrollOrBinding, which calls matchAndEnroll. The WHERE clause in trigger-matcher.ts:299-323 filters only by channel, kind='schedule', status, org, and optionally socialAccountId — it never consults payload.entrypoint_id. With two active 'schedule' entrypoints on the same org+channel, both dispatch loops enumerate their respective contacts but matchAndEnroll always picks the same highest-specificity entrypoint for everyone, silently ignoring the other entrypoint's automation.

**Fix:** Pass the entrypoint_id from the job into matchAndEnroll and add `eq(automationEntrypoints.id, event.payload.entrypoint_id)` to the WHERE clause when event.kind === 'schedule', or have dispatchScheduledTrigger call enrollContact directly (bypassing matchAndEnroll) since the target entrypoint is already known.

---

### B46 [HIGH] Webhook trigger slugs are not unique-checked and are matched across all organizations — colliding slugs make one tenant's webhook unreachable

- **File:** apps/api/src/services/automations/webhook-receiver.ts:334
- **Type:** validation  |  **Verification:** 1-pass  |  **Finder:** automations-engine

Entrypoint creation accepts an operator-supplied config.webhook_slug verbatim (only auto-generating when missing, routes/automation-entrypoints.ts:271-275) with no uniqueness check — slugs live inside the config jsonb so no DB constraint applies. The receiver loads ALL active webhook_inbound entrypoints across every organization and takes the first row whose config matches the slug via Array.find over an unordered result set. If two entrypoints (same org or different orgs) share a slug, which one is matched is arbitrary and can flip between requests/deploys; the shadowed entrypoint's callers get bad_signature (HMAC verified against the other tenant's secret) and that webhook silently stops triggering. A tenant can also deliberately register another tenant's known slug to disrupt their webhook deliveries.

**Evidence:** webhook-receiver.ts:319-338 fetches ALL active `webhook_inbound` entrypoints across every organization with no slug or org predicate, then resolves via `rows.find(r => cfg.webhook_slug === params.slug)`. The DB schema (packages/db/src/schema.ts:2617) stores `config` as plain `jsonb` with no unique index on any nested slug field, so duplicate slugs are not prevented. automation-entrypoints.ts:271-275 only auto-generates a slug when none is provided; user-supplied slugs pass through unchecked, enabling cross-tenant slug squatting that misdirects another tenant's webhook calls to a different org's secret (producing `bad_signature`) and silently suppresses their automation runs.

**Fix:** Add a uniqueness check before insert in the entrypoint creation route: query for any existing active `webhook_inbound` entrypoint whose `config->>'webhook_slug'` matches the requested slug and reject with a `CONFLICT` error if found. Also add a partial unique index on `(config->>'webhook_slug')` where `kind = 'webhook_inbound'` in the DB migration.

---

### B47 [HIGH] Broadcast sender is not resumable — mid-run termination strands broadcasts in 'sending' forever with unsent recipients

- **File:** apps/api/src/services/broadcast-processor.ts:27
- **Type:** data-integrity  |  **Verification:** 1-pass  |  **Finder:** scheduled-crons

processScheduledBroadcasts only picks broadcasts with status 'scheduled' (line 27). executeBroadcast sets status='sending' (line 110) then loops over ALL pending recipients with a 1s sleep per 50-recipient batch (lines 121-190) with no per-tick budget. A broadcast with a few thousand recipients exceeds the cron invocation's wall-clock limit; any termination (limit, deploy, eviction, unhandled worker abort) kills the loop before the final status write at line 195. The broadcast then stays 'sending' permanently: never re-selected (query requires 'scheduled'), pending recipients never sent, sentCount/failedCount/completedAt never written. The sibling whatsapp-broadcast-processor.ts was explicitly rewritten to fix exactly this (its header comments and the `or(status='sending')` re-pick at line 51 + MAX_RECIPIENTS_PER_TICK budget), but this generic processor was not.

**Evidence:** broadcast-processor.ts:24-28 queries only status='scheduled', so a broadcast set to 'sending' at line 110 is never re-picked on subsequent cron ticks. The unbounded while(true) loop at line 121 with a 1s sleep per batch at line 189 can exceed the Workers invocation wall-clock budget for large recipient lists; any termination leaves the broadcast stranded in 'sending' permanently, with sentCount/failedCount/completedAt never written. The sibling whatsapp-broadcast-processor.ts was explicitly fixed with or(status='sending') and a MAX_RECIPIENTS_PER_TICK budget (lines 51, 33), confirming the design gap in the generic processor.

**Fix:** Add or(eq(broadcasts.status, 'sending')) to the query predicate alongside a per-tick recipient budget constant (e.g. MAX_RECIPIENTS_PER_TICK=200), break out of the while loop when the budget is exhausted, and let subsequent cron ticks continue from the cursor — mirroring the whatsapp-broadcast-processor.ts pattern.

---

### B48 [HIGH] Cross-post action 'atomic claim' never changes status, so concurrent cron ticks double-execute reposts/comments/quotes

- **File:** apps/api/src/services/cross-post-processor.ts:41
- **Type:** race  |  **Verification:** 2-lens  |  **Finder:** races-concurrency

The description is accurate. One refinement: the double execution requires consecutive every-minute cron ticks to overlap (tick wall time > 60s), which is realistic because each action is processed serially with an awaited dispatchWebhookEvent that performs multiple HTTP attempts with quadratic backoff (webhook-delivery.ts:84-107) on top of refreshTokenIfNeeded (possible 2s KV-lock sleep + external token call) and the platform API call. Window per action: from the claim UPDATE until the status='executed' update (lines 132-139) or markFailed — the entire external-call duration. The executedAt 'claim marker' is dead weight: nothing in the SELECT or claim WHERE ever reads it. The perf audit (docs/performance-audit-2026-06/findings.md:132, flows/queues-crons.md:67) incorrectly labels this claim 'duplicate-safe'.

**Evidence:** Claim: `.update(crossPostActions).set({ executedAt: new Date() }).where(and(eq(crossPostActions.id, action.id), eq(crossPostActions.status, "pending")))` — the SET clause does not change status, and the schema enum is ["pending","executed","failed","cancelled"] with no 'processing' state (packages/db/src/schema.ts:2145-2149), so a second worker's identical WHERE still matches; the due-rows SELECT (lines 28-35) also has no executedAt/claim filter.

**Fix:** Make the claim a real compare-and-swap on executedAt: (1) add isNull(crossPostActions.executedAt) to the due SELECT's where (cross-post-processor.ts:29-34) and (2) add isNull(crossPostActions.executedAt) to the claim UPDATE's where (line 44), keeping SET { executedAt: new Date() }. The second worker's UPDATE then re-evaluates the predicate after the row lock, sees executed_at IS NOT NULL, matches 0 rows, and skips. Optionally add stale-claim recovery (re-claim rows where status='pending' AND executed_at < now() - interval '10 minutes') so actions orphaned by a worker eviction are retried, and fix the 'duplicate-safe' wording in docs/performance-audit-2026-06. Alternative (more invasive): add a 'processing' value to the status enum via migration and CAS pending->processing.

---

### B49 [HIGH] Facebook comment backfill stores the commenter's display NAME as participantPlatformId/authorPlatformId

- **File:** apps/api/src/services/inbox-backfill.ts:178
- **Type:** data-integrity  |  **Verification:** 1-pass  |  **Finder:** inbox-messaging

fetchAndStoreFacebookComments requests `from{name,picture}` (no id) and then sets `participantPlatformId: comment.from ? comment.from.name : null` and `authorPlatformId: comment.from ? comment.from.name : null` — a human display name in a column that everywhere else stores platform IDs. Identity matching downstream (contact_channels.identifier exact matches in findMatchingContact, the message-enrichment update keyed on authorPlatformId) treats it as an ID, so two different people named 'John Smith' are indistinguishable and the channel identifier never matches the real PSID-based channels created by the live webhook path, fragmenting the same person into multiple identities.

**Evidence:** inbox-backfill.ts:147 requests `from{name,picture}` (no `id` sub-field) for Facebook comments, so `comment.from.id` is always undefined. Lines 178 and 191 explicitly set `participantPlatformId: comment.from ? comment.from.name : null` and `authorPlatformId: comment.from ? comment.from.name : null`, storing a human display name in ID columns. Contrast with the Instagram path at lines 317/328 which correctly uses `comment.from?.id`.

**Fix:** Add `id` to the Facebook Graph API fields request: `fields=id,from{id,name,picture},message,created_time`. Then use `comment.from?.id ?? null` for `participantPlatformId` and `authorPlatformId`.

---

### B50 [HIGH] welcome_message binding can never fire for brand-new contacts — first-inbound hint is always false when the conversation is unlinked

- **File:** apps/api/src/services/inbox-event-processor.ts:377
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** inbox-messaging

processInboxEvent computes preInsertInboundCount only `if (direction === 'inbound' && event.type === 'message' && conversation.contactId)`. On a brand-new customer's first DM no contact exists yet (ensureContactForAuthor creates it later, in step 2), so conversation.contactId is null and preInsertInboundCount stays null. isFirstInboundOnChannel = `preInsertInboundCount === 0` → null !== 0 → false. binding-router.ts:44 `if (typeof eventHint === 'boolean') return eventHint;` trusts the always-boolean false hint, so the DB fallback never runs. On the second message the conversation gets linked but the count is already 1. Result: the welcome_message binding — whose primary purpose is greeting brand-new contacts — never fires for organically new contacts (default_reply fires instead); it only fires for pre-existing contacts matched by phone/email. The in-code comment at lines 372-376 even documents the opposite intent ('in which case the count is always 0 and the welcome fires').

**Evidence:** inbox-event-processor.ts:377-381: `preInsertInboundCount` is only computed when `conversation.contactId` is truthy; on a brand-new contact's first DM, `contactId` is null (ensureContactForAuthor runs later in step 2 of dispatchAutomationMatch), so `preInsertInboundCount` stays null. Line 554-555 evaluates `null === 0` as false, so `isFirstInboundOnChannel=false`. binding-router.ts:44 trusts the boolean hint and short-circuits before any DB fallback, meaning the `welcome_message` binding never fires for organically new contacts — directly contradicting the comment at lines 372-376.

**Fix:** Remove the `conversation.contactId` guard so `preInsertInboundCount` defaults to `0` (not `null`) when no contact is linked yet — a conversation with no linked contact has zero prior inbound messages by definition, which correctly triggers the welcome binding.

---

### B51 [HIGH] Inbox event processor swallows DB persistence failures and acks: inbound messages are permanently lost while a message.received webhook is still dispatched

- **File:** apps/api/src/services/inbox-event-processor.ts:421
- **Type:** error-handling  |  **Verification:** 1-pass  |  **Finder:** error-handling

Step 1 of processInboxEvent wraps upsertConversation/insertMessage in `try { ... } catch (err) { console.error("[inbox-processor] DB storage failed:", err); }` and continues. The queue consumer (queues/inbox.ts:23-25) then sees a normal return and acks the message, so a transient DB failure (Hyperdrive blip, pool exhaustion) permanently drops the customer's DM/comment from the inbox — the retry machinery that exists precisely for this (max_retries 5) never engages. Worse, execution falls through to step 3 and dispatches a `message.received`/`comment.received` outbound webhook (line 583) for a message that was never stored, so API consumers are told about data that does not exist, and automation dispatch runs with conversation=null.

**Evidence:** inbox-event-processor.ts:349-423: the try/catch around `upsertConversation`+`insertMessage` swallows errors with only `console.error`, and `queues/inbox.ts:25` acks the message on normal return — so any transient DB failure permanently drops the inbound message. Execution continues to step 3 (line 583) where `dispatchWebhookEvent` fires `message.received` for a message that was never stored, because the only guard is `!isPersistedEvent` (which only skips `follow`/`ad_click` events, not `message`).

**Fix:** Re-throw the caught error (or throw a new one) so the queue consumer at `queues/inbox.ts:26-29` sees a failure and calls `message.retry()` instead of `message.ack()`. The webhook dispatch can remain best-effort, but DB persistence must propagate failures to the retry mechanism.

---

### B52 [HIGH] usageRecords are calendar-month but billing periods are Stripe-anchored — overage billed over wrong window, stale records can be double-billed

- **File:** apps/api/src/services/invoice-generator.ts:68
- **Type:** billing  |  **Verification:** 1-pass  |  **Finder:** scheduled-crons
- **Independently re-found as:** "Invoice generator fallback can re-bill an already-billed period (no billed marker, periodStart never matches)"

Both writers of usageRecords use calendar-month UTC periodStart (usage-tracking.ts:160-165 `Date.UTC(y, m, 1)`; posts.ts:1365). The invoice generator first matches eq(usageRecords.periodStart, sub.currentPeriodStart) — which can never be equal for a sub anchored mid-month (Stripe timestamps include the checkout second), so it always falls through to the fallback (lines 75-86): 'most recent record with periodEnd <= now'. Consequences: (a) overage is computed over a calendar month, not the billing period the customer is being charged for; (b) nothing marks a usage record as already-reported, so if an org has zero API calls in the most recent month, the fallback re-selects an older record whose overage was already invoiced on a previous run and bills it AGAIN. Same root cause makes GET /v1/usage (routes/usage.ts:84-96) never find dbUsage for anchored subs, so it reports kvCount (calendar-month) against cycle_start/cycle_end of the Stripe period — mixed windows shown to the user.

**Evidence:** usage-tracking.ts:160-162 always writes periodStart as the UTC calendar-month 1st, while invoice-generator.ts:68 compares it to sub.currentPeriodStart which is a Stripe epoch timestamp; these values are structurally different for any non-1st-anchored sub, so the primary lookup always misses and falls through to the fallback (lines 75-86). The fallback returns the most-recent completed calendar-month record regardless of which Stripe billing period is being invoiced, so overage is computed over a calendar window rather than the Stripe billing window, and no 'already billed' guard exists (same root issue as claim [0]). The routes/usage.ts mismatch (calendar-month count shown against Stripe cycle_start/end) is a separate secondary symptom of the same root cause.

**Fix:** Align the two systems: write usageRecords with periodStart/End matching the Stripe subscription period (available from KV or the sub row's currentPeriodStart/End), or add a billedAt column to usageRecords to prevent re-selection, and fix the eq comparison to match calendar-month periodStart against a normalized calendar-month start derived from sub.currentPeriodStart.

---

### B53 [HIGH] Retry recomputes overall post status from only the retried targets, marking partially-live posts as "failed"

- **File:** apps/api/src/services/publisher-runner.ts:272
- **Type:** logic  |  **Verification:** 2-lens  |  **Finder:** transactions-integrity
- **Independently re-found as:** "Post with zero remaining targets is vacuously marked "published" — false post.published webhook, success notification, streak credit"; "Disconnecting an account leaves its scheduled posts behind; at publish time they are falsely marked 'published', billed, and a post.published webhook fires"; "Empty target set is vacuously treated as success: post flips to 'published' and fires post.published webhook with zero publishes"; "Retrying a 'partial' post that fails again illegally transitions it to 'failed', nulls publishedAt, and emits post.failed while content is live"

The claim is accurate as written. Additional precision: (a) the realtime dashboard notification (publisher-runner.ts:303) also pushes status "failed", and the post.failed webhook payload's `targets` field contains only the retried targets, so consumers cannot detect that part of the post is live; (b) the inverse direction is also slightly off — the webhook event and payload describe only the retried subset even when the retry succeeds (post.published fires with a partial targets map), though the resulting "published" post status happens to be correct since the non-retried targets were already published; (c) a related edge in the same code: if all failed targets reference deleted social accounts, retryPost calls publishToTargets with an empty targets array, and `[].every(...)` is vacuously true, setting the post to "published" and firing post.published without publishing anything.

**Evidence:** Lines 272-286: `const statuses = Object.values(responseTargets).map((t) => t.status); const finalStatus = statuses.every((s) => s === "published") ? "published" : statuses.every((s) => s === "failed") ? "failed" : "partial"; await db.update(posts).set({ status: finalStatus, ... })` — responseTargets contains only the targets in the `targets` argument, which retryPost restricts to `eq(postTargets.status, "failed")` (posts.ts:2034).

**Fix:** In publishToTargets (apps/api/src/services/publisher-runner.ts), after flushing dbUpdatePromises (line 269), derive the post-level status from the full DB state instead of the in-memory subset: `const allRows = await db.select({ status: postTargets.status }).from(postTargets).where(eq(postTargets.postId, postId)); const statuses = allRows.map((r) => r.status);` then keep the existing every-published / every-failed / partial logic. This is behavior-preserving for all other callers (which pass the complete target set, so DB rows equal the in-memory set after the flush) and fixes the retry path, including the webhook event selection at lines 289-294 and the realtime notification at line 303. It also fixes the vacuous-empty-array edge case since a post always has at least one target row.

---

### B54 [HIGH] publishPostById's published-target guard bails after claiming, leaving crash-interrupted posts stuck in 'publishing' with unpublished targets abandoned forever

- **File:** apps/api/src/services/publisher-runner.ts:351
- **Type:** error-handling  |  **Verification:** 1-pass  |  **Finder:** error-handling
- **Independently re-found as:** "Re-delivered publish of a partially-completed post is acked while leaving the post stuck in "publishing" and remaining targets unpublished"

After atomically re-claiming the post (lines 336-342, which sets status='publishing'), the function returns early if ANY target is already 'published': `if (targets.some((t) => t.status === "published")) return;`. If a previous attempt published some targets (postTargets flushed at publisher-runner.ts:269) and then crashed before the final posts.update (line 279), every redelivery re-claims the post, hits this guard, and returns — the post row stays 'publishing' forever, remaining scheduled/publishing targets are never attempted, and no post.published/post.partial webhook or notification ever fires. This is the complementary failure mode to the known publishing→publishing double-publish race (which is about re-publishing, not abandonment): even with the planned staleness gate (fix-plan P0.3), this guard still abandons partially-completed posts without finalizing them.

**Evidence:** publisher-runner.ts:336-342 atomically sets post status to 'publishing', then line 351 returns early (void) if any target is already 'published', leaving the post in 'publishing' forever with no finalization, no webhook, and remaining targets abandoned. Every redelivery re-claims the still-'publishing' row (line 331 allows 'publishing', line 339 WHERE status='publishing' succeeds), hits the guard, and returns again.

**Fix:** Replace the bail-out at line 351 with logic that checks whether ALL targets are already in a terminal state (published/failed) and, if so, finalizes the post status via publishToTargets or an inline db.update + webhook dispatch rather than returning silently.

---

### B55 [HIGH] Scheduler never claims due posts — usage is re-charged and publish messages re-enqueued on every cron tick while the queue lags

- **File:** apps/api/src/services/scheduler.ts:28
- **Type:** billing  |  **Verification:** 1-pass  |  **Finder:** publishing-state-machine

processScheduledPosts selects posts with status='scheduled' and scheduledAt <= now, charges incrementUsage per target, and enqueues publish messages — but never updates the posts' status. The status only changes when the queue consumer runs publishPostById's claim. If queue consumption lags more than one cron interval (backlog, consumer retry backoff, queue outage), the same posts are selected again next minute: usage is charged again (KV units per target, every tick) and duplicate messages are enqueued. For standalone posts the claim limits the damage to billing; for thread roots there is no claim at all (see thread finding), so this also produces full thread double-posting.

**Evidence:** scheduler.ts:15-104 selects posts with `status='scheduled'` and enqueues them (lines 70-89) plus charges usage (lines 63-67), but contains no `db.update(posts)` call; the status flip to `'publishing'` happens only inside the queue consumer (publisher-runner.ts:336-340). The cron fires every minute (scheduled/index.ts:34), so any queue backlog longer than 60 s causes the same posts to be re-selected, usage to be re-charged, and duplicate publish messages to be sent — including for thread-root posts where the thread publisher has no additional deduplication guard against double-enqueue.

**Fix:** After building `duePostIds`, issue `db.update(posts).set({ status: 'publishing' }).where(inArray(posts.id, duePostIds))` before enqueuing, so subsequent cron ticks no longer match the same rows. The consumer's existing optimistic-lock claim (publisher-runner.ts:336-342) still guards against at-least-once queue redelivery.

---

### B56 [HIGH] processScheduledPosts never claims posts — queue lag >60s causes repeated re-enqueue and KV usage over-counting every minute

- **File:** apps/api/src/services/scheduler.ts:63
- **Type:** billing  |  **Verification:** 1-pass  |  **Finder:** scheduled-crons

The every-minute cron selects posts with status='scheduled' and scheduledAt<=now (lines 26-35), increments the KV usage counter per org (lines 63-67), and enqueues publish messages — but never updates the posts (no claim, no status flip, no scheduledAt bump). Deduplication relies entirely on the queue consumer flipping status within 60 seconds. During any queue backlog or consumer outage, the same posts are re-selected every minute, each tick calling incrementUsage again: a 10-minute backlog inflates the org's KV usage counter 10x for those posts. For free-plan orgs that counter gates requests (usage-tracking.ts:304 FREE_LIMIT_REACHED), so the org is wrongly locked out. This is distinct from the known publisher-runner re-claim race (that is consumer-side double-publish) and from the known non-atomic KV counter TODO (this is a deterministic repeated increment, not a concurrency loss).

**Evidence:** This is the same root cause as claim [1]: scheduler.ts has no status update on the selected posts, so every cron tick during a queue backlog re-runs `incrementUsage` for each still-scheduled post (lines 63-67), inflating the KV counter by the full unit cost each minute. For free-plan orgs this prematurely triggers FREE_LIMIT_REACHED (usage-tracking.ts:304), locking them out for the rest of the month based on phantom usage.

**Fix:** Same fix as [1]: flip posts to `status='publishing'` inside `processScheduledPosts` before enqueuing, eliminating repeated selection and repeated usage increments across cron ticks.

---

### B57 [HIGH] Failed token refresh re-notifies every org member every day, forever, starting 7 days before the token has even expired

- **File:** apps/api/src/services/token-refresh.ts:106
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** oauth-token-lifecycle
- **Independently re-found as:** "Queue-consumer token refresh bypasses the per-account refresh lock — concurrent refreshes race on single-use rotating refresh tokens (Twitter/TikTok)"

The daily 9am cron (scheduled/index.ts:50-52) enqueues every account with tokenExpiresAt < now+7d with no lower bound and no 'refresh permanently failed' marker. When refreshTokenDirect returns null (LinkedIn accounts without programmatic-refresh approval have refreshToken NULL; Instagram-via-Facebook accounts always fail — see separate finding; revoked grants), refreshAccountToken logs a connection error and sends an 'Account token expired ... needs to be reconnected' notification to every org member (token-refresh.ts:116-136). Nothing clears tokenExpiresAt or marks the account, so the same account is re-enqueued and re-notifies all members every single day — starting while the token is still valid for up to 7 more days (the message 'token expired' is false at that point) and continuing indefinitely after expiry until the user reconnects or deletes the account.

**Evidence:** enqueueExpiringTokenRefresh (token-refresh.ts:38-42) has no lower bound on tokenExpiresAt and no failure-flag filter, so accounts whose refresh permanently failed are re-enqueued every day. refreshAccountToken (lines 105-137) sends an 'Account token expired' notification to every org member on each failure with no deduplication or persistent failure marker, and the 7-day window means the misleading 'expired' message fires while the token is still valid.

**Fix:** Add a refreshFailedAt (or similar) column to socialAccounts; on refresh failure set it and skip notification if it was set within the last N hours; exclude accounts where refreshFailedAt is recent from the cron enqueue query.

---

### B58 [HIGH] Token refresh persists NULL access token when the provider returns HTTP 200 with an error body (no access_token) — bricks the account

- **File:** apps/api/src/services/token-refresh.ts:141
- **Type:** data-integrity  |  **Verification:** 1-pass  |  **Finder:** oauth-token-lifecycle

refreshTikTok (token-refresh.ts:607-619) and refreshStandard (token-refresh.ts:432-433) cast res.json() to TokenResult without verifying data.access_token exists; TikTok's /v2/oauth/token/ endpoint is known to return errors (e.g. invalid_grant) in a 200 body as {error, error_description, log_id}. The result object is truthy, so refreshAccountToken passes the !result guard and runs updateData.accessToken = await maybeEncrypt(result.access_token, ...). maybeEncrypt(undefined) returns null (crypto.ts:85 'if (!plaintext) return plaintext ?? null'), so the DB update overwrites the still-stored (possibly still-working) access token with NULL. refreshTokenIfNeeded (token-refresh.ts:242) has the identical hole and additionally returns refreshed.access_token (undefined) to callers, which then send 'Bearer undefined' to the platform.

**Evidence:** refreshStandard (token-refresh.ts:432) and refreshTikTok (token-refresh.ts:609-618) cast res.json() to TokenResult without verifying access_token is a non-empty string; TikTok returns HTTP 200 with {error, error_description} on invalid_grant. maybeEncrypt(undefined, key) returns null per crypto.ts:85, so the DB update at line 141 overwrites the existing access token with NULL, bricking the account without any error being logged.

**Fix:** After obtaining data from res.json(), check that data.access_token is a non-empty string and return null otherwise, before constructing the TokenResult in both refreshStandard and refreshTikTok.

---

### B59 [HIGH] Deleting a workspace silently converts its workspace-scoped webhook endpoints into org-wide webhooks

- **File:** apps/api/src/services/webhook-delivery.ts:157
- **Type:** authz  |  **Verification:** 1-pass  |  **Finder:** unpublish-delete-paths

webhook_endpoints.workspace_id has onDelete: 'set null' (packages/db/src/schema.ts:562-564), and the dispatch filter treats a null workspaceId as 'receive everything': `if (w.workspaceId) return workspaceId === w.workspaceId && eventMatch; return eventMatch;`. So when DELETE /v1/workspaces/{id} removes a workspace, every webhook endpoint the customer deliberately scoped to that workspace becomes an org-wide endpoint and starts receiving events from all other workspaces — events the receiving system was never meant to see. The workspace delete handler (workspaces.ts:303-309) only invalidates the ws-valid KV key and relies on the FK behavior.

**Evidence:** packages/db/src/schema.ts:562-563 defines `webhookEndpoints.workspaceId` with `onDelete: 'set null'`, and apps/api/src/services/webhook-delivery.ts:155-157 treats a null `w.workspaceId` as org-wide delivery — falling through to `return eventMatch` after the workspace-scoped guard. When apps/api/src/routes/workspaces.ts:304 deletes a workspace, every webhook endpoint that was scoped to it silently becomes an org-wide endpoint that receives events from all other workspaces.

**Fix:** Change `onDelete: 'set null'` to `onDelete: 'cascade'` on `webhookEndpoints.workspaceId` in schema.ts so workspace deletion removes the scoped endpoints; alternatively add a `deletedAt IS NOT NULL` soft-delete guard or an explicit DB cascade delete in the workspaces delete handler.

---

### B60 [HIGH] WhatsApp broadcast resume re-picks 'sending' rows without claiming recipients — overlapping cron ticks can double-send messages

- **File:** apps/api/src/services/whatsapp-broadcast-processor.ts:51
- **Type:** race  |  **Verification:** 1-pass  |  **Finder:** scheduled-crons

The resumable design re-selects broadcasts in status 'sending' (line 51) every minute, and recipients are only marked sent/failed AFTER the platform send completes (lines 154-199) — there is no atomic recipient claim. Cloudflare cron invocations can overlap: a tick processing the full 200-recipient budget (8 chunks of 25 with 500ms inter-chunk sleeps plus WhatsApp API latency, lines 139-204) can exceed 60s when sends are slow. The next tick then picks the same 'sending' broadcast, reads the same still-'pending' recipients, and sends them again concurrently — recipients receive the WhatsApp template message twice. This is a different code path from the known publisher-runner publishing->publishing race.

**Evidence:** whatsapp-broadcast-processor.ts:96-106 only transitions `scheduled → sending`; broadcasts already in `sending` skip the claim step and are unconditionally re-picked. The `pending` recipient query at lines 140-150 has no row-level lock, so a slow in-flight tick (8 chunks × 25 recipients × 500 ms + WhatsApp API RTT easily exceeds 60 s) and a concurrent tick will both read the same pending rows and call `sendMessage` for the same recipients before either marks them `sent`, causing duplicate WhatsApp messages.

**Fix:** Add a per-recipient atomic claim: use `UPDATE ... SET status='sending' WHERE status='pending' AND broadcast_id=? RETURNING *` (or a `FOR UPDATE SKIP LOCKED` SELECT) so each recipient is claimed by exactly one tick. Alternatively, add a `locked_until` timestamp column that the processor sets before sending and checks before picking up broadcasts in `sending` status.

---

### B61 [HIGH] Dashboard presigned-upload flow never calls /v1/media/confirm — media rows stuck "pending" forever and invisible in the media library

- **File:** apps/app/src/lib/upload-media.ts:20
- **Type:** drift  |  **Verification:** 1-pass  |  **Finder:** media-r2

POST /v1/media/presign inserts a media row with status "pending" (media.ts:435-443) that only becomes "ready" via POST /v1/media/confirm (media.ts:562-575). The dashboard's uploadMedia helper does presign → PUT → return the url (upload-media.ts:10-28) and never calls confirm; it is used by new-post-dialog.tsx and inbox/message-composer.tsx. Consequence: every file uploaded through the post composer's presign path stays status=pending with size=0, and GET /v1/media filters `eq(media.status, "ready")` (media.ts:235), so these files never appear in the media library page (media-page.tsx:146-149 lists via /api/media). The file still works in the post itself because publishing presigns the URL directly without consulting the media table, masking the bug. It also means the confirm-time SEC-02 MIME and SEC-11 size re-verification never run for dashboard uploads.

**Evidence:** upload-media.ts:27 returns immediately after a successful PUT to the presign URL with no call to /api/media/confirm or any app-proxy equivalent. The presign handler (media.ts:435-443) inserts a row with status='pending', and listMedia (media.ts:235) filters with eq(media.status, 'ready'), so all files uploaded via the presign path in the dashboard stay permanently hidden from the media library. The direct-upload fallback path (upload.ts line 19) calls client.media.upload() which inserts a ready-status row, so only the presign path is broken.

**Fix:** After the PUT succeeds in upload-media.ts, extract the storage key from the URL and call POST /api/media/confirm (adding a matching app proxy route), or inline the confirm call via the SDK's client.media.confirm({ storage_key }).

---

### B62 [HIGH] Admin plan change rewrites apiCallsIncluded for ALL usage periods, not just current

- **File:** apps/app/src/pages/api/admin/organizations.ts:231
- **Type:** data-integrity  |  **Verification:** 1-pass  |  **Finder:** dashboard-internal-routes

When an admin changes an org's plan, the route updates `usageRecords.apiCallsIncluded` filtered only by `organizationId`, with no period filter — despite the comment stating it intends to update the current usage record. This retroactively overwrites the included-calls quota on all historical (closed) billing periods for that org, corrupting the basis for past overage calculations and any reporting/reconciliation that reads `apiCallsIncluded` per period.

**Evidence:** apps/app/src/pages/api/admin/organizations.ts:231-234 issues `db.update(usageRecords).set({ apiCallsIncluded }).where(eq(usageRecords.organizationId, organizationId))` with no period filter, despite the comment at line 228 stating it targets only the current usage record. The GET path at line 118 correctly adds `periodStart <= now AND periodEnd >= now` bounds — the POST path omits them entirely, overwriting apiCallsIncluded across all historical billing periods for the org.

**Fix:** Add a period filter matching the GET handler: append `.where(and(eq(usageRecords.organizationId, organizationId), lte(usageRecords.periodStart, now), gte(usageRecords.periodEnd, now)))` to the update at line 231. Import `and`, `lte`, `gte` from drizzle-orm at the top of the file.

---

### B63 [HIGH] Pro-trial orgs are minted/enforced as free plan (trialing treated as free)

- **File:** apps/app/src/pages/api/bootstrap-key.ts:66
- **Type:** billing  |  **Verification:** 1-pass  |  **Finder:** dashboard-internal-routes

When the dashboard mints the org's API key, the plan is derived as `sub?.status === "active" ? "pro" : "free"`, so any subscription in `trialing` status is bound to the free plan: KV gets `plan: "free"`, `calls_included: 200`, and the API rate limiter (rate-limit.ts) selects FREE_RATE_LIMITER (100 req/min) because it keys off `data.plan`. This contradicts the rest of the billing system: billing/sync.ts:52 treats `trialing` as pro (`isPro = newStatus === "active" || newStatus === "trialing"`), status.ts surfaces a real `trialing` status, and the Stripe webhook maps subscriptions to `trialing` but never calls syncOrgKeysToKV for it (it only upgrades KV on `newStatus === "active"`). The API's own backstop hydrateApiKey (apps/api/src/middleware/auth.ts:88) also re-derives `trialing` -> free on every KV cache miss, so even if billing/sync briefly sets pro, a rehydrate reverts it. Net effect: a customer on a Pro trial is silently throttled to 200 calls / 100 rpm and shown plan=free.

**Evidence:** Both `bootstrap-key.ts:66` and `auth.ts:88` compute `plan` as `sub?.status === 'active' ? 'pro' : 'free'`, so `trialing` maps to free/200 calls/free rate-limit. The Stripe webhook at `stripe-webhooks.ts:237` only calls `syncOrgKeysToKV` with `'pro'` when `newStatus === 'active'`, never on `trialing`. The one correct path (`billing/sync.ts:52`, `isPro = newStatus === 'active' || newStatus === 'trialing'`) requires a manual admin trigger and does not run automatically during trial activation.

**Fix:** Add `|| sub?.status === 'trialing'` to the plan ternary in both `bootstrap-key.ts:66` and `auth.ts:88`. In `stripe-webhooks.ts`, add a parallel `if (newStatus === 'trialing' && sub.status !== 'trialing')` block that calls `syncOrgKeysToKV` with `'pro'`.

---

### B64 [HIGH] SDK media.upload defaults Content-Type to application/octet-stream, which the API MIME allowlist always rejects

- **File:** packages/sdk/src/resources/media.ts:69
- **Type:** drift  |  **Verification:** 1-pass  |  **Finder:** sdk-drift

The generated SDK upload() sets `headers: buildHeaders([{ 'Content-Type': 'application/octet-stream' }, options?.headers])`, so the basic documented call `client.media.upload(file, { filename: 'x.png' })` sends Content-Type: application/octet-stream. The API upload handler validates the Content-Type header against ALLOWED_MIME_TYPES (images/videos/audio/pdf only — routes/media.ts:23-40) and returns 400 INVALID_CONTENT_TYPE for octet-stream (routes/media.ts:305-310). The allowlist was added after SDK generation, so the SDK's default invocation now always fails unless the caller knows to override headers in RequestOptions (the dashboard works only because apps/app/src/pages/api/media/upload.ts:19-21 explicitly forwards the real Content-Type).

**Evidence:** packages/sdk/src/resources/media.ts:69 sets Content-Type: application/octet-stream as the first argument to buildHeaders, which is overridable by options?.headers (second arg). But with no options passed, the default applies and apps/api/src/routes/media.ts:305 rejects it because ALLOWED_MIME_TYPES (lines 23-40) does not include application/octet-stream. Any caller using the documented basic form `client.media.upload(file, { filename })` will always get 400 INVALID_CONTENT_TYPE. The dashboard only works because apps/app/src/pages/api/media/upload.ts:19-21 explicitly overrides the Content-Type header.

**Fix:** In packages/sdk/src/resources/media.ts, add a `content_type: string` field to MediaUploadParams and use it in the headers: `buildHeaders([{ 'Content-Type': params.content_type }, options?.headers])`. Alternatively, remove the default Content-Type from buildHeaders so the caller's fetch engine sends the body's natural MIME type.

---

### B65 [HIGH] SDK whatsapp.groups and dashboard Groups tab call /v1/whatsapp/groups, which does not exist in the API

- **File:** packages/sdk/src/resources/whatsapp/groups.ts:14
- **Type:** drift  |  **Verification:** 1-pass  |  **Finder:** sdk-drift

The SDK ships a full Groups resource (create POST /v1/whatsapp/groups, list GET /v1/whatsapp/groups, delete DELETE /v1/whatsapp/groups/{id}), and the dashboard wires it up end-to-end: the WhatsApp page has a user-visible 'Groups' tab (apps/app/src/components/dashboard/pages/whatsapp-page.tsx:54,119) that calls the internal route apps/app/src/pages/api/whatsapp/groups.ts, which calls client.whatsapp.groups.list/create. But no route for 'groups' exists anywhere in apps/api/src/routes/ (grep for 'groups' in whatsapp.ts and 'whatsapp/groups' across apps/api/src returns nothing, and git log -S finds no removed route — it was never implemented). Every use of the Groups tab or SDK groups methods returns 404 from Hono's not-found handler.

**Evidence:** No route for `/v1/whatsapp/groups` exists anywhere in apps/api/src/routes/ — confirmed by grep returning zero results for 'groups' in whatsapp.ts and no groups route file at all. The SDK ships a full Groups resource (packages/sdk/src/resources/whatsapp/groups.ts:14,21,27), the dashboard wires a visible 'Groups' tab (whatsapp-page.tsx:54,119) through an internal Astro route (apps/app/src/pages/api/whatsapp/groups.ts:9), and the git log shows no removed route. Every call returns Hono's 404 not-found response.

**Fix:** Implement the three group routes (POST/GET /v1/whatsapp/groups and DELETE /v1/whatsapp/groups/{id}) in apps/api/src/routes/whatsapp.ts and mount them in app.ts, or remove the Groups tab and SDK resource entirely if the feature is not ready.

---

### B66 [MEDIUM] Free-plan hard limit is checked before adding the current request's units — one bulk request can blow past the cap by an arbitrary amount

- **File:** apps/api/src/middleware/usage-tracking.ts:304
- **Type:** validation  |  **Verification:** 1-pass  |  **Finder:** billing-usage

The free gate blocks only when countBefore >= callsIncluded, ignoring the units of the in-flight request. A free org at 199/200 can submit a single /v1/posts/bulk-csv upload with tens of thousands of rows (no row cap in the unit counter) or /v1/contacts/bulk-operations with 500 ids; the gate passes (199 < 200) and the request is fully processed, consuming far beyond the advertised hard limit in one shot. This is distinct from the acknowledged non-atomic KV read-modify-write: it is a deterministic single-request bypass, not a concurrency race.

**Evidence:** At usage-tracking.ts:304, the free-plan gate is `countBefore >= callsIncluded`, where `countBefore` is the KV counter before adding the request's units (computed at line 235). A free org sitting at exactly `callsIncluded - 1` passes the check regardless of how large `units` is (bulk CSV can be thousands of rows per getUsageUnits at line 119–138), so the org can consume far more than `callsIncluded` in a single request before being blocked on the next call.

**Fix:** Change the gate to `countBefore + units > callsIncluded` (or `newCount > callsIncluded`) so the check accounts for the in-flight request's full unit cost. Also cap `units` at a reasonable per-request maximum to prevent trivially large bulk uploads from consuming the entire month's quota in one call.

---

### B67 [MEDIUM] Failed POST requests are billed at full unit count, including rejected bulk payloads and 404s

- **File:** apps/api/src/middleware/usage-tracking.ts:338
- **Type:** billing  |  **Verification:** 1-pass  |  **Finder:** billing-usage

After next(), the middleware unconditionally persists a usage write with billable:true and the pre-computed units, never consulting c.res.status. getUsageUnits counts raw request-body items (array length / CSV rows) before validation, so a /v1/contacts/bulk-operations request with 500 ids that fails validation (400) bills 500 calls; a bulk-csv upload whose rows are all rejected bills every row; even a POST to a non-existent /v1/* path (Hono runs the middleware, then the 404 handler) bills 1 call. The KV counter at lines 246-253 is likewise incremented before the handler runs, so free-plan quota is consumed by requests that performed no work.

**Evidence:** After `await next()` at `usage-tracking.ts:336`, `persistUsageAndLogs` is unconditionally called with `billable: true` regardless of `c.res.status` (lines 338-355). `getUsageUnits` (lines 119-139) counts body items before validation, so a bulk POST with 500 items that fails Zod validation (400) writes 500 units to the DB and increments KV by 500 before the handler runs. The free-plan KV gate at line 304 uses `countBefore`, so even blocked free-plan requests have their KV counter incremented (though they're logged with `billable: false` in that path).

**Fix:** Check `c.res.status` after `await next()` and set `billable: false` (and skip the usage DB write) for 4xx/5xx responses, or at minimum for 400/404/422 status codes to avoid charging for client-error rejections.

---

### B68 [MEDIUM] GET /v1/analytics from_date/to_date are unvalidated strings — garbage input becomes Invalid Date SQL params and 500s the endpoint

- **File:** apps/api/src/routes/analytics.ts:222
- **Type:** validation  |  **Verification:** 1-pass  |  **Finder:** input-validation

AnalyticsQuery and DailyMetricsQuery declare from_date/to_date as plain `z.string().optional()` (schemas/analytics.ts:10-14, 28-29) with only a description claiming ISO 8601. The handlers pass them straight into Drizzle conditions (`gte(posts.publishedAt, new Date(startDate))` at analytics.ts:222-223) and raw SQL fragments (`sql`AND p.published_at >= ${new Date(startDate)}`` at 266-267), plus daily-metrics at 430-432. `new Date("last week")` is Invalid Date, whose serialization throws RangeError in postgres-js, so ?from_date=garbage produces a 500 instead of a 400 — distinct from the already-filed "params ignored" analytics issues, since these particular params ARE applied.

**Evidence:** schemas/analytics.ts:10-14 declares `from_date: z.string().optional()` with no `.datetime()` or date refinement, so any string passes Zod validation. analytics.ts:222-223 and :266-267 call `new Date(startDate)` directly; `new Date('garbage')` produces an Invalid Date, and calling `.toISOString()` on it (which postgres-js does when serializing the Date for the query) throws `RangeError: Invalid time value`, resulting in an unhandled 500 instead of a 400.

**Fix:** Add `.refine(v => !isNaN(Date.parse(v)), 'Invalid date')` (or use `.datetime({ offset: true })`) to `from_date`/`to_date` in all query schemas in schemas/analytics.ts.

---

### B69 [MEDIUM] GET /v1/api-keys accepts a cursor but ignores it — emits next_cursor yet always returns page 1

- **File:** apps/api/src/routes/api-keys.ts:109
- **Type:** pagination  |  **Verification:** 2-lens  |  **Finder:** pagination-cursors

GET /v1/api-keys accepts a `cursor` query param (via PaginationParams) and returns next_cursor/has_more, but the handler never reads or applies the cursor, so every request returns the newest `limit` keys. Additionally, the emitted cursor is the last key's id while the sort key is createdAt, so even if the id were applied it would not match the ordering. Orgs with more than `limit` keys (default 20) can never list beyond page 1, and clients following next_cursor loop on identical data since has_more stays true.

**Evidence:** api-keys.ts:109 `const { limit } = c.req.valid("query");` — cursor never read; line 149 `next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null` advertises pagination that does not work.

**Fix:** In apps/api/src/routes/api-keys.ts, mirror the keyset pattern from media.ts:242-291: (1) destructure `const { limit, cursor } = c.req.valid("query");` at line 109; (2) build conditions `[eq(apikey.organizationId, orgId)]` and, when cursor is a valid date, push `lt(apikey.createdAt, new Date(cursor))` (import `lt` from drizzle-orm), using `.where(and(...conditions))`; (3) change line 149 to `next_cursor: hasMore ? (data.at(-1)?.createdAt.toISOString() ?? null) : null` so the cursor matches the createdAt sort key. Update the SDK doc comment on `cursor` in packages/sdk/src/resources/api-keys.ts if it describes the cursor as a key id, and add a regression test modeled on apps/api/src/__tests__/media-cursor.test.ts.

---

### B70 [MEDIUM] Automation binding accepts arbitrary social_account_id, leaking another org's account identity via GET

- **File:** apps/api/src/routes/automation-bindings.ts:361
- **Type:** authz  |  **Verification:** 1-pass  |  **Finder:** authz-tenancy

createBinding validates that body.automation_id belongs to the org (L336-353) but inserts body.social_account_id directly (L361) with no check that the account belongs to the caller's org. updateBinding is worse: it patches socialAccountId, automationId, and workspaceId straight from the body (L478-485) with no ownership revalidation at all. getBinding then fetches the bound account with `eq(socialAccounts.id, scoped.row.socialAccountId)` and no organizationId filter (L425-434) and returns its username/displayName/avatarUrl; listBindings does the same via a leftJoin (L266-268). So a caller can create or PATCH a binding in their own org pointing at a victim org's social account id, then GET /v1/automation-bindings/{id} to read that foreign account's username/display name/avatar — data they otherwise cannot see. (The binding-router at services/automations/binding-router.ts:89-90 filters by organizationId AND socialAccountId, so automations are not hijacked; the impact is account-identity disclosure.)

**Evidence:** In `createBinding` (automation-bindings.ts:355-368), `body.social_account_id` is inserted directly without any check that the account belongs to the caller's org — only the automation is verified at L336-353. In `getBinding` (L425-434) the follow-up query is `eq(socialAccounts.id, scoped.row.socialAccountId)` with no `organizationId` filter, so `username`, `displayName`, and `avatarUrl` of a foreign org's social account are returned. The `listBindings` left-join (L266-268) has the same gap. `updateBinding` (L478-479) patches `socialAccountId` from the body with no ownership recheck.

**Fix:** After resolving the automation, add a DB check that `social_account_id` exists in `socialAccounts` with `eq(socialAccounts.organizationId, orgId)` before inserting or updating. In `getBinding`/`listBindings` add `eq(socialAccounts.organizationId, orgId)` to the join condition.

---

### B71 [MEDIUM] GET /v1/connect/pending-data can never return data — nothing ever writes pending-oauth:* keys, and the documented headless mode is ignored

- **File:** apps/api/src/routes/connect.ts:1461
- **Type:** drift  |  **Verification:** 1-pass  |  **Finder:** oauth-token-lifecycle

The getPendingData handler reads KV key pending-oauth:${token}, but a repo-wide search shows no code path ever writes a pending-oauth:* key (the only references are the read and delete in this handler). StartOAuthQuery also documents a headless flag ('returns data instead of redirecting', schemas/connect.ts:46-51) that the startOAuth handler never reads — only redirect_url and method are used (connect.ts:2658-2662). Result: the documented headless OAuth flow is entirely non-functional; every call to GET /v1/connect/pending-data returns 404 'Token not found or expired', and customers following the OpenAPI docs cannot make it work.

**Evidence:** A repo-wide grep confirms pending-oauth:* KV keys are only ever read (connect.ts:1461) and deleted (connect.ts:1472) — no code path ever writes one. The headless field in StartOAuthQuery (schemas/connect.ts:46-51) is documented but the startOAuth handler (connect.ts:2655-2739) never reads query.headless; it only uses redirect_url and method. Every call to GET /v1/connect/pending-data therefore returns 404 and the headless OAuth flow is entirely non-functional.

**Fix:** In the startOAuth handler, when query.headless === 'true', generate a one-time token, write the OAuth result data to KV under pending-oauth:{token}, and return the token in the response instead of auth_url; then update getPendingData to delete the key after returning it (already done at line 1472).

---

### B72 [MEDIUM] Facebook page list/selection reads only the first Graph API page (default 25) — users with more pages cannot connect pages beyond #25

- **File:** apps/api/src/routes/connect.ts:1866
- **Type:** pagination  |  **Verification:** 1-pass  |  **Finder:** oauth-token-lifecycle

Both listFacebookPages (connect.ts:1808-1810) and selectFacebookPage (connect.ts:1866-1876) fetch GRAPH_BASE/me/accounts once without a limit parameter and never follow paging.next. Graph API returns 25 results per page by default. An agency user managing more than 25 pages sees a truncated list, and selectFacebookPage's json.data.find(p => p.id === body.page_id) fails for any page not in the first 25, returning 404 'Page not found in user's pages' for a page the user legitimately administers.

**Evidence:** connect.ts:1866-1876 fetches GRAPH_BASE.facebook/me/accounts once with no limit or pagination cursor parameter; the Graph API returns 25 results per page by default. The subsequent json.data.find(p => p.id === body.page_id) at line 1876 only searches that first page, so any page beyond position 25 is not found, returning 404 NOT_FOUND even though the user legitimately administers it. The listFacebookPages handler at 1808-1810 has the same truncation issue for display.

**Fix:** Add a ?limit=200 query parameter to the /me/accounts fetch (Graph API allows up to 200), or implement paging.next cursor-following in both listFacebookPages and selectFacebookPage to collect all pages before searching.

---

### B73 [MEDIUM] Contact merge is a 6-statement sequence with no transaction — partial failure leaves a half-merged contact

- **File:** apps/api/src/routes/contacts.ts:1208
- **Type:** data-integrity  |  **Verification:** 2-lens  |  **Finder:** transactions-integrity

mergeContact (contacts.ts:1161-1272) executes dedupe-DELETE + re-parent UPDATE for channels, the same pair for custom field values, parallel UPDATEs for broadcastRecipients/inboxConversations, then DELETE of the source contact — all without a transaction. A mid-sequence failure (unique-violation TOCTOU on contact_channels_account_identifier_idx between lines 1208 and 1217, a transient DB error, or worker termination) leaves a durable half-merged state: the source contact survives but its channels/fields/conversations already point at the target, and the client receives a 500 despite durable mutations. Two corrections to the original claim: (1) a retry does NOT re-run the dedupe delete against rows now owned by target — both DELETEs filter on contact_id = sourceId, so the sequence is retry-idempotent and converges; (2) the broadcastRecipients UPDATE cannot deterministically violate broadcast_recipients_dedup_idx since that index is on (broadcast_id, contact_identifier), not contact_id. The cascade issue is confirmed and is deterministic on every merge, not just on failure: deleting the source contact cascade-destroys its automationRuns (history and active runs), automationContactControls (pause/suppression state), and contactSegmentMemberships (schema.ts:2711, 2828, 2897) without migration, and the handler neither migrates nor reports them.

**Evidence:** Lines 1208-1261: sequential `await db.execute(sql`DELETE FROM contact_channels ...`)`, `db.update(contactChannels)...`, `db.execute(sql`DELETE FROM custom_field_values...`)`, `db.update(customFieldValues)...`, `Promise.all([db.update(broadcastRecipients)..., db.update(inboxConversations)...])`, `db.delete(contacts)...` — no `db.transaction(...)` wrapper anywhere in the handler.

**Fix:** Wrap the entire merge sequence (both dedupe DELETEs, all re-parent UPDATEs, and the final source delete) in `await db.transaction(async (tx) => { ... })`, replacing every `db.` call with `tx.` — this makes the half-merged states impossible and turns the TOCTOU into a clean retryable rollback. Additionally, before deleting the source contact inside the same transaction, migrate the cascade-doomed tables with the same dedupe pattern already used for channels: re-parent contact_segment_memberships with ON CONFLICT (contact_id, segment_id) DO NOTHING, re-parent automation_contact_controls with dedupe against idx_contact_controls_per_auto/idx_contact_controls_global, and re-parent automation_runs with dedupe against idx_automation_runs_active_uniq (or explicitly cancel the source's active runs and re-parent only completed history), then include the migrated counts in the response.

---

### B74 [MEDIUM] uploadMedia rejects its own declared content type — OpenAPI body is application/octet-stream but the handler 400s it; SDK upload() fails by default

- **File:** apps/api/src/routes/media.ts:305
- **Type:** drift  |  **Verification:** 1-pass  |  **Finder:** media-r2

The uploadMedia route's OpenAPI definition declares the request body as `application/octet-stream` (media.ts:94-96) and the handler even defaults a missing Content-Type header to "application/octet-stream" (media.ts:302), but ALLOWED_MIME_TYPES (media.ts:23-40) does not include application/octet-stream, so the very content type the contract advertises is always rejected with 400 INVALID_CONTENT_TYPE. The generated SDK encodes this contract: packages/sdk/src/resources/media.ts:68 hardcodes `'Content-Type': 'application/octet-stream'` in upload(), and MediaUploadParams exposes no content-type parameter — so `client.media.upload(body, { filename })` as documented always returns 400 unless the caller knows to override headers via request options. Swagger UI "Try it out" on /docs fails the same way.

**Evidence:** SDK media.ts:68-69 calls buildHeaders([{ 'Content-Type': 'application/octet-stream' }, options?.headers]), and because the second entry overwrites the first (headers.ts:79), callers who pass options.headers with the real MIME type do work fine — the app proxy (upload.ts:20) does exactly this. However, a caller using the SDK as documented — client.media.upload(body, { filename }) with no options override — will send application/octet-stream, which is not in ALLOWED_MIME_TYPES (media.ts:23-40), causing a guaranteed 400. Swagger UI Try-it-out will also always 400 since the OpenAPI contract declares application/octet-stream.

**Fix:** Remove the hardcoded 'Content-Type': 'application/octet-stream' default from the SDK upload() method and require callers to pass the actual MIME type via options.headers, or add application/octet-stream as a passthrough alias in ALLOWED_MIME_TYPES only for the upload endpoint.

---

### B75 [MEDIUM] Create-post usage upsert computes overageCostCents at 1000x: per-post overage multiplied by the per-thousand price

- **File:** apps/api/src/routes/posts.ts:1382
- **Type:** billing  |  **Verification:** 1-pass  |  **Finder:** publishing-state-machine
- **Independently re-found as:** "Posts overage cost multiplies overage posts by pricePerThousandCallsCents per post (100x, missing /1000 or pricePerPostCents)"

The in-transaction usageRecords upsert sets `overageCostCents = GREATEST(0, postsCount + 1 - postsIncluded) * pricePerThousandCallsCents` — each overage post is charged the price of a thousand calls (100 cents instead of 0.1). The middleware's analogous formula (usage-tracking.ts:186) correctly divides by 1000 (`CEIL((count + units - included) / 1000.0) * price`). The stored overage cost in usage_records is inflated 1000x whenever postsCount exceeds postsIncluded; invoice-generator.ts recomputes from apiCallsCount so Stripe invoices are not directly affected, but any consumer of the usage_records column (dashboards, exports, future billing) gets wrong money data.

**Evidence:** At posts.ts:1382, `overageCostCents` is computed as `GREATEST(0, postsCount + 1 - postsIncluded) * 100` — each overage post is charged the full per-thousand-calls price (100 cents) instead of 0.1 cents; the correct formula used in usage-tracking.ts:186 divides by 1000. The `invoice-generator.ts` recomputes Stripe charges from `apiCallsCount` (line 88-96), so actual Stripe invoices are unaffected, but any dashboard or export reading `usage_records.overage_cost_cents` will show costs inflated 1000x.

**Fix:** Change posts.ts:1382 to divide by 1000: `GREATEST(0, ${usageRecords.postsCount} + 1 - ${usageRecords.postsIncluded}) * ${PRICING.pricePerThousandCallsCents} / 1000.0`.

---

### B76 [MEDIUM] Scheduler/queue/retry publish usage is metered only in KV, never in the DB billing source of truth

- **File:** apps/api/src/routes/posts.ts:2036
- **Type:** billing  |  **Verification:** 1-pass  |  **Finder:** billing-usage

incrementUsage (KV-only) is called for scheduled-post publishes (services/scheduler.ts:63-67, one unit per target), queue publishes (queues/publish.ts:122-123), retries (posts.ts:2036-2039, 'Charge usage for each failed target being retried'), auto-post rules and recycling. None of these write to usageRecords.apiCallsCount, yet usage-tracking.ts:240-241 states the DB counter 'remains the source of truth for billing' and invoice-generator bills from usageRecords.apiCallsCount. Result: pro orgs are shown (via KV/max in GET /v1/usage) and gated on usage that is never overage-billed, and free orgs are gated on counts that diverge from the recorded billing data — the explicit 'charge' on retry never reaches any invoice.

**Evidence:** Confirmed: `incrementUsage` (usage-tracking.ts:15-35) is KV-only; `persistUsageAndLogs` (usage-tracking.ts:141-199) is the sole writer of `usageRecords.apiCallsCount` and is only invoked from the request middleware chain. The retry path (posts.ts:2038), scheduler, and queue consumer call `incrementUsage` but never `persistUsageAndLogs`, so those publish units are absent from `apiCallsCount`. The invoice-generator (invoice-generator.ts:88-96) reads only `apiCallsCount` to compute and bill overage, so these units are never billed.

**Fix:** After calling `incrementUsage` in the retry/scheduler/queue paths, also upsert `usageRecords.apiCallsCount` using the same SQL as `persistUsageAndLogs` (usage-tracking.ts:184). Alternatively, extract a shared `persistBillableUsage(db, orgId, units)` helper and call it from all publish paths.

---

### B77 [MEDIUM] PUT /v1/queue/slots with set_as_default:false orphans the only default schedule, after which the update endpoint 404s forever

- **File:** apps/api/src/routes/queue.ts:318
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** input-validation

updateSlots locates the schedule to update by `schedules.findIndex((s) => s.is_default)` because the route has no ID parameter. The handler then sets `is_default: body.set_as_default ?? existing.is_default`, so a request with set_as_default:false demotes the only default schedule without promoting any other. Every subsequent PUT /v1/queue/slots then hits the `idx === -1` branch and returns 404 "No queue schedule found" even though schedules exist — the org can no longer update its schedule via the API (delete-and-recreate is the only recovery). getNextSlot/preview keep working only via their `?? schedules[0]` fallback.

**Evidence:** queue.ts:300 finds the schedule to update by `findIndex((s) => s.is_default)`, and line 318 writes `is_default: body.set_as_default ?? existing.is_default`, so a request with `set_as_default: false` demotes the only default schedule with no reassignment. Every subsequent PUT then hits idx === -1 and returns 404, permanently breaking schedule updates for the org.

**Fix:** Validate in the handler that `set_as_default` cannot be `false` when only one schedule exists (or when this is the current default and no other schedule exists), returning a 422. Alternatively, always force `is_default: true` when there is only one schedule.

---

### B78 [MEDIUM] Timestamp-only cursors with strict lt and no id tie-break skip rows with equal created_at across multiple list endpoints

- **File:** apps/api/src/routes/tags.ts:64
- **Type:** pagination  |  **Verification:** 2-lens  |  **Finder:** pagination-cursors

Timestamp-only keyset pagination with strict lt(createdAt) and no id tie-break affects tags.ts:64/71, signatures.ts:~271/278, content-templates.ts:~175/182, threads.ts:~377/390, ideas.ts (listIdeas ~264, comments ~1173, activity ~1518), and invite.ts:~129/145 — and additionally media.ts:247/265 and posts.ts:592-594/648 (same pattern, not cited). Because the cursor (and the postgres-js driver's JS Date values) are millisecond-truncated while timestamptz stores microseconds, the effective tie window is 1ms: any rows whose createdAt falls in the same millisecond as the page-boundary row but at or below the truncated cursor value are excluded from all subsequent pages and become unreachable. Exact ties (same transaction / batch inserts, e.g. the double logActivity insert in ideas.ts:501-503) hit the same skip. has_more is computed correctly on the boundary page, but the skipped rows are silently lost rather than surfaced later. Practical trigger probability is low per page boundary, but the loss is silent and unrecoverable through the API for programmatic consumers.

**Evidence:** tags.ts:63-65 `if (cursor) { conditions.push(lt(tags.createdAt, new Date(cursor))); }` with line 71 `.orderBy(desc(tags.createdAt))` (no id tie-break) and line 80-82 `next_cursor: data.at(-1)?.createdAt.toISOString()`.

**Fix:** Switch to composite keyset pagination: order by (createdAt DESC, id DESC) and make next_cursor the last row's id. On the next page, resolve the cursor entirely in SQL with a row-wise comparison so microsecond precision is preserved server-side, e.g. for tags: conditions.push(sql`(${tags.createdAt}, ${tags.id}) < (SELECT ${tags.createdAt}, ${tags.id} FROM ${tags} WHERE ${tags.id} = ${cursor})`) and .orderBy(desc(tags.createdAt), desc(tags.id)). Apply the same change to signatures, content-templates, threads (on posts), ideas list/comments/activity, invite tokens (replace the JS-side cursorRow lookup with the SQL row comparison), and also media.ts and posts.ts which share the defect. Keep accepting old timestamp cursors during transition (fall back to lt(createdAt) when the cursor parses as a date), and update packages/sdk pagination typings/docs if cursor semantics are documented.

---

### B79 [MEDIUM] Thread creation inserts N posts + N×M targets without a transaction — partial threads persist and can publish truncated

- **File:** apps/api/src/routes/threads.ts:283
- **Type:** data-integrity  |  **Verification:** 2-lens  |  **Finder:** transactions-integrity

createThread inserts N posts (2-25) and N×M postTargets via sequential awaits on a non-transactional db handle (threads.ts:283, 299). With a remote DB at ~100ms RTT this is up to ~100+ serial round-trips, a wide window for a transient failure (connection drop, pool eviction, worker termination) mid-loop. On failure the handler 500s but the prefix rows persist under the threadGroupId. Consequences differ by mode: (a) scheduled threads — the cron scheduler (scheduler.ts:72-79) enqueues the orphaned root at its scheduled time and publishThreadPosition publishes the truncated thread to social platforms, ending the chain at the last existing position and dispatching a thread.published webhook with the wrong item_count (thread-publisher.ts:345); (b) `scheduled_at: "now"` — the PUBLISH_QUEUE.send at threads.ts:312 never runs, so the partial posts are stuck in status "publishing" forever (no sweep recovers them), polluting lists and counts but not publishing; (c) a client retry creates a duplicate complete thread alongside the orphan. The original claim was correct except it implied the "now" partial could publish on retry — it cannot; only the scheduled path publishes truncated.

**Evidence:** Lines 274-309: `for (let i = 0; i < body.items.length; i++) { ... await db.insert(posts).values({ ... threadGroupId, threadPosition: i ... }); for (const account of uniqueAccounts) { await db.insert(postTargets).values({...}); } }` — sequential awaits on the plain `db` handle; the only transaction in the API routes is in posts.ts:1323 and signatures.ts.

**Fix:** In createThread (threads.ts:272-309), build the post rows and target rows in memory, then wrap persistence in a single transaction with batched multi-row inserts: `await db.transaction(async (tx) => { await tx.insert(posts).values(postRows); await tx.insert(postTargets).values(targetRows); });`. Keep the `c.env.PUBLISH_QUEUE.send` (line 312) after the transaction commits so a rollback never enqueues a publish. This also collapses ~100 sequential round-trips into 2, fixing a latency problem at the same time. Apply the same pattern to any equivalent update path if/when a thread update route is added (UpdateThreadBody is imported but currently unused). deleteThread's two-step delete (lines 464-467) is acceptable as-is because postTargets.postId has onDelete: "cascade" (schema.ts:449).

---

### B80 [MEDIUM] Pagination cursors are unvalidated strings fed to Number()/new Date() — garbage cursor turns into NaN/Invalid Date SQL params and a 500

- **File:** apps/api/src/routes/usage.ts:191
- **Type:** validation  |  **Verification:** 1-pass  |  **Finder:** input-validation

PaginationParams.cursor is plain `z.string().optional()`. GET /v1/usage/logs does `lt(apiRequestLogs.id, Number(cursor))` — a non-numeric cursor yields NaN, which postgres-js sends as "NaN" for a bigserial column, producing a DB error and a 500. The same class exists wherever cursors hit `new Date(cursor)` without a NaN guard: signatures.ts:271, ideas.ts:264/1173/1518, content-templates.ts:175, tags.ts:64, threads.ts:377, and the main posts list at posts.ts:594 — Invalid Date params throw RangeError in the driver's toISOString serialization. The media route was already fixed with exactly the missing guard (media.ts:244-248), confirming the bug class; inbox.ts:937/1005 degrade differently (NaN comparison silently returns an empty page instead of an error). Clients sending a stale/typoed cursor get 500 INTERNAL instead of 400.

**Evidence:** usage.ts:191 does `lt(apiRequestLogs.id, Number(cursor))` with no NaN guard; apiRequestLogs.id is bigserial (packages/db/src/schema.ts:682), so a non-numeric cursor yields Number(cursor)=NaN which postgres-js will send as a NaN literal for a bigserial column, producing a DB error and a 500. The identical class was already fixed in media.ts:244-248 with `!Number.isNaN(cursorDate.getTime())`, confirming the bug pattern exists and is fixable.

**Fix:** Add `if (cursor && !Number.isNaN(Number(cursor)))` guard before line 191 in usage.ts, mirroring the media.ts pattern; optionally add a Zod `.refine` on PaginationParams.cursor to return a 400 for invalid cursors.

---

### B81 [MEDIUM] GET /v1/workspaces: cursor gt(id) does not match orderBy(name) — workspaces silently missing from page 2

- **File:** apps/api/src/routes/workspaces.ts:156
- **Type:** pagination  |  **Verification:** 2-lens  |  **Finder:** pagination-cursors

listWorkspaces sorts by (name, id) but paginates with WHERE id > cursor, where cursor is the alphabetically-last row's random id. Since ids are random hex, id order is unrelated to name order. With more than `limit` workspaces: (a) page-1 rows whose ids exceed the new cursor are duplicated on page 2, and (b) any not-yet-returned workspace whose id is <= the cursor is excluded from that page and — because cursors strictly increase across pages — from all subsequent pages, i.e. permanently missing from pagination (~half the remaining rows dropped per page boundary on average). Note: the original Zeta/Beta example is impossible with static data (Beta sorts before Zeta and would appear on page 1 first), but the mechanism it illustrates is correct.

**Evidence:** workspaces.ts:155-156 `if (cursor) { conditions.push(gt(workspaces.id, cursor)); }` vs line 172 `.orderBy(workspaces.name, workspaces.id)`.

**Fix:** Make the cursor predicate match the (name, id) sort. Backward-compatible option keeping the opaque id cursor — replace lines 155-157 of apps/api/src/routes/workspaces.ts with a row-comparison keyset that resolves the cursor row's name via subquery: `conditions.push(sql`(${workspaces.name}, ${workspaces.id}) > ((select w.name from workspaces w where w.id = ${cursor}), ${cursor})`)`. Alternatively, encode a composite cursor (base64 of {name, id}) in next_cursor and translate it to `or(gt(name, n), and(eq(name, n), gt(id, i)))`. Add a pagination test seeding >limit workspaces with names anti-correlated to id order, asserting pages are disjoint and complete. Also audit the sibling pattern at apps/api/src/routes/accounts.ts:451-452/472, which has the same mismatch (gt(id, cursor) vs orderBy desc(connectedAt)).

---

### B82 [MEDIUM] Scheduled posts in a deleted workspace are orphaned (workspace_id NULL) but still publish, and scoped keys lose all ability to see or cancel them

- **File:** apps/api/src/routes/workspaces.ts:304
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** unpublish-delete-paths

DELETE /v1/workspaces/{id} just deletes the workspace row and relies on FK behavior; posts.workspace_id is onDelete 'set null' (schema.ts:380-382). Scheduled posts belonging to the deleted workspace keep status 'scheduled' and the cron scheduler (services/scheduler.ts:26-33) has no workspace condition, so they will still publish to their accounts after the workspace is gone. Worse, assertWorkspaceScope (lib/workspace-scope.ts:33) denies access whenever workspaceId is null for a scoped key, so any workspace-scoped API key — including one that was scoped to the deleted workspace — can no longer GET, update, or DELETE those posts to stop them; only an all-workspace key can.

**Evidence:** workspaces.ts:304 deletes the workspace row without cancelling or nullifying scheduled posts; posts.workspaceId becomes NULL via the FK onDelete:'set null' (schema.ts:380-381). scheduler.ts:26-33 queries only on `status='scheduled'` and `scheduledAt<=now` with no workspace filter, so those orphaned posts will still be enqueued and published. workspace-scope.ts:33 blocks any scoped key from accessing posts where workspaceId is null, so there is no API path to cancel them short of using an all-workspace key.

**Fix:** In the deleteWorkspace handler (workspaces.ts:304), before deleting, update all scheduled posts in that workspace to `status='cancelled'` (or delete them) so the scheduler never picks them up.

---

### B83 [MEDIUM] Webhook event enum drift: six dispatched events (message.sent, thread.published, streak.*) are not in WebhookEventEnum and can never be subscribed

- **File:** apps/api/src/schemas/webhooks.ts:6
- **Type:** drift  |  **Verification:** 1-pass  |  **Finder:** input-validation

dispatchWebhookEvent only delivers to endpoints whose stored events array includes the event name (webhook-delivery.ts:152-158), and CreateWebhookBody/UpdateWebhookBody validate events against WebhookEventEnum with min(1). The runtime dispatches "message.sent" (inbox-event-processor.ts:577-582), "thread.published" (thread-publisher.ts:338-343), "streak.started"/"streak.milestone" (streak.ts:78,88) and "streak.warning"/"streak.broken" (streak.ts:154-158,196-200), none of which appear in the enum — POST /v1/webhooks rejects them with a 400, so these events are dispatched into the void and are undeliverable to any API consumer. Conversely "engagement_rule.triggered" is in the enum but is never dispatched anywhere.

**Evidence:** WebhookEventEnum at webhooks.ts:6-21 omits 'message.sent', 'thread.published', 'streak.started', 'streak.milestone', 'streak.warning', and 'streak.broken'. CreateWebhookBody requires min(1) events validated against the enum, so no subscriber can register for these events. webhook-delivery.ts:154's `events.length === 0` escape hatch is unreachable because of the min(1) constraint, confirming all six dispatched events are undeliverable. The reverse is also true: 'engagement_rule.triggered' is in the enum but never dispatched.

**Fix:** Add the six missing event strings to WebhookEventEnum in apps/api/src/schemas/webhooks.ts and remove or dispatch 'engagement_rule.triggered' to close the reverse gap.

---

### B84 [MEDIUM] RSS auto-post dedup cursor written only after the whole item loop — mid-loop failure re-publishes already-posted feed items

- **File:** apps/api/src/services/auto-post-processor.ts:410
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** scheduled-crons

processRule creates posts and enqueues publishes for each new feed item (lines 351-407) but persists lastProcessedUrl only once, after all items succeed (step 5, lines 410-419). If item 2 of 3 throws (DB insert, PUBLISH_QUEUE.send, or KV error) — or the invocation is terminated — the catch in processAutoPostRules (lines 254-267) records the error and lastProcessedAt but NOT lastProcessedUrl. On the next poll, getNewItems returns the same items again and the rule re-creates and re-publishes posts that were already sent to social platforms, producing duplicate public posts.

**Evidence:** processRule in auto-post-processor.ts:351-407 iterates items and enqueues publishes before persisting lastProcessedUrl at lines 410-419; any exception thrown inside the loop (DB insert, KV increment, PUBLISH_QUEUE.send, webhook dispatch) propagates to the processAutoPostRules catch at lines 255-267, which updates consecutiveErrors and lastProcessedAt but never lastProcessedUrl. On the next poll getNewItems returns the same items (cursor unchanged), re-creating and re-publishing items that were already successfully enqueued in the interrupted run. In practice this requires a mid-loop failure which is rare but possible (transient DB error, KV rate-limit, queue full), and the duplicate re-publish risk is bounded to at most 5 items by the getNewItems cap.

**Fix:** Persist lastProcessedUrl incrementally inside the loop after each successfully processed item (or wrap the whole loop in a try that catches item-level errors while updating the cursor as items succeed), so a partial failure advances the dedup pointer past already-enqueued items.

---

### B85 [MEDIUM] Numeric condition operators never match custom fields — values are stored as text but gt/gte/lt/lte require typeof number, and eq is strict

- **File:** apps/api/src/services/automations/filter-eval.ts:68
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** automations-engine

Custom field values are hydrated into context as strings (buildInitialRunContext declares `fields: Record<string, string>` from the text column custom_field_values.value, runner.ts:486; matchAndEnroll builds the same map). evalPredicate's gt/gte/lt/lte demand `typeof actual === "number"`, so any condition node or entrypoint filter like { field: 'fields.age', op: 'gte', value: 18 } evaluates false for every contact regardless of the stored value — flows always take the false branch / filter out everyone. 'eq' uses strict ===, so a JSON predicate value of 30 never equals the stored "30" either. field_set also writes merge-tag-rendered strings (actions/field.ts:91,123), so even same-run values stay strings.

**Evidence:** filter-eval.ts:68-75 confirms `gt/gte/lt/lte` branches guard on `typeof actual === "number"`, but runner.ts:486 builds `fields: Record<string, string>` and trigger-matcher.ts:353 does the same (`fieldsMap[fr.slug] = fr.value` from a text DB column). A `fields.*` value is always a string, so all four numeric comparison operators permanently return false. The `eq` strict-equality issue is real for predicates where the operator stores a numeric JSON value (e.g. `{ value: 30 }`) since `"30" === 30` is false, but if the UI always stores string values for `eq` predicates it may work in practice.

**Fix:** In `evalPredicate`, coerce `actual` to a number before numeric comparisons: `case "gt": { const n = Number(actual); return !Number.isNaN(n) && n > Number(pred.value); }` (same for `gte/lt/lte`). For `eq`, either coerce both sides for numeric-type fields, or document that `eq` predicate values must match the stored string type.

---

### B86 [MEDIUM] Input node number validation ignores configured min/max bounds

- **File:** apps/api/src/services/automations/input-resume.ts:155
- **Type:** validation  |  **Verification:** 1-pass  |  **Finder:** automations-engine

InputConfig exposes `validation?: { pattern?: string; min?: number; max?: number }` (input-resume.ts:42, nodes/input.ts:14), but resolveInputResume's 'number' branch only checks Number.isNaN — config.validation.min/max are never read anywhere in the function (pattern is applied only in the default free-text branch). An operator configuring an input node with input_type 'number' and validation {min: 1, max: 10} will have '9999' or '-5' accepted and captured into ctx.context[config.field], flowing into conditions, merge tags, and outbound webhooks as valid data. Number('Infinity') is also accepted.

**Evidence:** input-resume.ts:155-163 shows the `number` case only rejects `Number.isNaN(n)`; there is no reference to `config.validation?.min` or `config.validation?.max` anywhere in that branch. The `pattern` check lives exclusively in the `default` (free-text) branch (lines 172-183). An operator who configures `{ input_type: 'number', validation: { min: 1, max: 10 } }` will have any out-of-range number (e.g. 9999, -5, Infinity) accepted and stored in context.

**Fix:** After the `Number.isNaN` check in the `number` branch, add: `const min = config.validation?.min; const max = config.validation?.max; if ((min !== undefined && n < min) || (max !== undefined && n > max)) { return canRetry ? { port: 'retry' } : { port: 'invalid' }; }`

---

### B87 [MEDIUM] Stale 'processing' reclaim has no attempts cap and reclaims jobs whose worker is still running — unbounded retries and duplicate side effects

- **File:** apps/api/src/services/automations/scheduler.ts:52
- **Type:** race  |  **Verification:** 1-pass  |  **Finder:** automations-engine

The reclaim UPDATE flips any processing row older than 5 minutes back to pending and increments attempts, but attempts is never checked anywhere — a job that consistently kills the worker before the failed-mark (CPU/wall-clock limit, OOM) is re-dispatched every cycle forever, re-executing side effects each time (messages re-sent by partially-executed runLoops, scheduled_trigger enrollments repeated). Separately, a legitimately long-running job — scheduled_trigger synchronously runs enrollContact→runLoop for every candidate contact and can easily exceed 5 minutes for large segments — gets reclaimed while the original worker is still mid-loop, so a second worker re-runs the same enrollment loop concurrently; runLoop's optimistic update only protects state writes, not handler side effects, so contacts can receive duplicate messages and the next-cron-run dedup window (±1s, scheduler.ts:391) can fork */N schedules when the duplicates land in different N-minute windows.

**Evidence:** scheduler.ts:52-59: the reclaim UPDATE increments `attempts` but `attempts` is never checked anywhere — no max-attempts guard exists in the schema (schema.ts:2803) or in `dispatchJob`. On Cloudflare Workers, a CPU/wall-clock hard kill leaves the row in `processing`; the reclaim then flips it back to `pending`, and the job is dispatched again indefinitely. The `scheduled_trigger` concurrent-execution scenario (two workers processing the same enrollment loop) is theoretically reachable for large segments, but Cloudflare's per-request CPU time limit (~50 ms CPU time on Bundled, 30s wall-clock on Unbound) makes it hard to exceed the 5-minute stale window in practice; the more realistic vector is a crash that repeatedly kills the worker at the same point.

**Fix:** Add a `max_attempts` column (default 5) to `automation_scheduled_jobs` and change the reclaim UPDATE to also set `status = 'failed'` (with an error message) when `attempts + 1 >= max_attempts`, preventing unbounded retries.

---

### B88 [MEDIUM] ensureContactForAuthor stores Telegram numeric user IDs in contacts.phone; phone matching uses exact string equality so E.164 '+' variants never link

- **File:** apps/api/src/services/contact-linker.ts:170
- **Type:** data-integrity  |  **Verification:** 1-pass  |  **Finder:** inbox-messaging

ensureContactForAuthor writes `phone: /^\+?\d{7,15}$/.test(authorId) ? authorId : null`. Telegram user IDs are plain integers (commonly 9-11 digits) and pass this regex, so every auto-created Telegram contact gets a bogus phone number equal to their Telegram user ID — which Priority-2 of findMatchingContact (`eq(contacts.phone, participantPlatformId)`, lines 51-66) can later use to auto-link an unrelated WhatsApp/SMS participant whose wa_id digits collide with that Telegram ID, attributing messages to the wrong contact. Conversely, real phone matching is exact-string: a WhatsApp wa_id ('393331234567', no '+') never matches a contact whose phone is stored E.164 ('+393331234567'), so known contacts get duplicated instead of linked.

**Evidence:** contact-linker.ts:170 applies `/^\+?\d{7,15}$/` to `authorId` with no platform check, so Telegram numeric IDs (9-11 digit integers) are written to `contacts.phone`. contact-linker.ts:51-58 performs an exact-string `eq(contacts.phone, participantPlatformId)` with no normalization, so a WhatsApp wa_id without a leading `+` never matches a contact whose phone was stored E.164 (with `+`), creating duplicate contacts for the same person.

**Fix:** Gate the phone regex on platform in `ensureContactForAuthor` (skip it for `telegram`, `instagram`, etc.). In `findMatchingContact`, normalize both sides to digits-only before the phone comparison.

---

### B89 [MEDIUM] WhatsApp delivery statuses applied without ordering guard — late 'delivered' overwrites terminal 'read'/'failed'

- **File:** apps/api/src/services/inbox-event-processor.ts:1628
- **Type:** data-integrity  |  **Verification:** 1-pass  |  **Finder:** inbox-messaging

processWhatsAppStatuses blindly writes the incoming status into platformData.wa_status for the matching platformMessageId. WhatsApp status webhooks are not ordering-guaranteed, and Cloudflare Queues are at-least-once with retry reordering — a 'delivered' (or 'sent') status processed after 'read' regresses the message's terminal state, and a retried 'sent' can overwrite 'failed'. The stale state is also re-dispatched to customer webhooks as message.status_updated, so API consumers see read → delivered transitions.

**Evidence:** inbox-event-processor.ts:1626-1637: `processWhatsAppStatuses` unconditionally overwrites `platformData.wa_status` via `jsonb_set` with no check against the currently stored status rank or timestamp, so a late-arriving or retried `delivered`/`sent` webhook can overwrite a terminal `read` or `failed` status. The updated status is also re-dispatched via `message.status_updated` webhook (line 1644), exposing read→delivered regressions to API consumers.

**Fix:** Before applying the update, compare the incoming status rank (sent < delivered < read) and timestamp against the stored value; use a `WHERE` clause or conditional update (`CASE WHEN ... THEN ... END`) to skip writes where the existing status is already terminal or newer.

---

### B90 [MEDIUM] upsertConversation COALESCE(new, existing) lets the raw scoped-ID clobber the enriched participant name on every inbound DM

- **File:** apps/api/src/services/inbox-persistence.ts:132
- **Type:** drift  |  **Verification:** 1-pass  |  **Finder:** inbox-messaging

The Instagram/Facebook DM normalizers set `author: { name: customerId, id: customerId }` (inbox-event-processor.ts:1347, 1159) because the webhook doesn't carry the display name. upsertConversation's conflict SET is `COALESCE(<new>, <existing>)` — new value wins when non-null — so each inbound message overwrites the previously enriched participantName (real name from the profile API) with the numeric scoped ID. The processor then detects the broken identity (isMissingParticipantIdentity: name === participantId) and re-fetches the profile, but whenever that fetch fails (expired token, consent error, rate limit, 5s timeout), the conversation is left displaying a numeric ID instead of the name it already had.

**Evidence:** inbox-persistence.ts:132 uses COALESCE(new, existing) which means a non-null incoming value wins; inbox-event-processor.ts:361 passes participantName from conversationPartner.name, which is set from event.author.name — and the normalizers at inbox-event-processor.ts:1159 and 1347 set author: { name: customerId, id: customerId } (numeric scoped ID) for inbound DMs. Every inbound DM thus overwrites a previously enriched real display name with the numeric ID, and the profile re-fetch at lines 496-511 only restores it if the Graph API call succeeds.

**Fix:** Swap the COALESCE argument order to COALESCE(existing, new) for participantName/participantAvatar so an already-enriched name is never overwritten by raw data, and only update those fields via the explicit profile-enrichment UPDATE path.

---

### B91 [MEDIUM] Out-of-order/backfilled inbox messages overwrite the conversation's lastMessage preview with older messages

- **File:** apps/api/src/services/inbox-persistence.ts:213
- **Type:** data-integrity  |  **Verification:** 2-lens  |  **Finder:** transactions-integrity
- **Independently re-found as:** "Backfill inflates unreadCount and regresses lastMessage preview — insertMessage applies live-message side effects to historical inserts"

insertMessage (apps/api/src/services/inbox-persistence.ts:178,213-226) sets lastMessageText/lastMessageAt/lastMessageDirection AND updatedAt to the inserted message's createdAt with no comparison against the existing lastMessageAt. Backfill callers (inbox-backfill.ts:196,331,453,471,614) pass historical platform timestamps in raw API order; the event processor (inbox-event-processor.ts:417) passes webhook timestamps, so late/out-of-order deliveries hit the same path. Deterministic repro: YouTube commentThreads default order=time returns newest threads first, and conversations are keyed per videoId (inbox-backfill.ts:429), so an older thread on the same video processed later overwrites a newer preview; Facebook page comments default to ranked (non-chronological) order; live webhooks interleaving with an async backfill also regress the preview. Impact: (1) conversation list ordering and cursor pagination break — listConversations orders by updatedAt desc (inbox-persistence.ts:298), which is regressed to the historical timestamp (the original claim said sorting uses lastMessageAt; it actually breaks via updatedAt set in the same statement); (2) stale last_message preview exposed via inbox-feed.ts:94 and inbox-ai.ts:65; (3) cleanupOldConversations (inbox-maintenance.ts:31) archives open conversations with lastMessageAt older than 90 days, so a backfilled old comment can wrongly auto-archive an active conversation. Self-heals on the next live message, which keeps severity at medium.

**Evidence:** Lines 213-226: `.set({ lastMessageText: data.text ?? null, lastMessageAt: now, lastMessageDirection: data.direction, messageCount: sql`... + 1`, ... }).where(eq(inboxConversations.id, data.conversationId))` — no comparison against the existing lastMessageAt.

**Fix:** In insertMessage's conversation update (inbox-persistence.ts:213-226), make the preview fields monotonic and keep updatedAt at wall-clock time: lastMessageAt: sql`GREATEST(COALESCE(${inboxConversations.lastMessageAt}, ${now.toISOString()}), ${now.toISOString()})`; lastMessageText: sql`CASE WHEN ${inboxConversations.lastMessageAt} IS NULL OR ${inboxConversations.lastMessageAt} <= ${now.toISOString()} THEN ${data.text ?? null} ELSE ${inboxConversations.lastMessageText} END`; lastMessageDirection: same CASE pattern returning ${data.direction} vs existing; messageCount/unreadCount increments unchanged; updatedAt: new Date() (actual insertion time, not data.createdAt) so backfilled rows do not regress list ordering — or, if backfilled conversations should sort by their historical activity, GREATEST(existing updatedAt, now). Add a regression test inserting messages with descending createdAt and asserting lastMessageAt/lastMessageText reflect the newest message.

---

### B92 [MEDIUM] streak.milestone webhook and realtime event re-fire on every post made during a milestone day

- **File:** apps/api/src/services/streak.ts:87
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** scheduled-crons

updateStreak runs after every successful publish and computes currentStreakDays as FLOOR(elapsed/86400)+1, which stays constant for all posts within the same 24h window. The milestone check `MILESTONE_DAYS.includes(streak.currentStreakDays)` has no dedup, so an org publishing 5 posts on its 7th streak day dispatches 5 streak.milestone webhooks and 5 realtime milestone events for the same milestone. Customers consuming the webhook see duplicate milestone events with identical current_streak_days.

**Evidence:** streak.ts:87 checks `MILESTONE_DAYS.includes(streak.currentStreakDays)` with no deduplication guard; the `orgStreaks` schema (schema.ts:2276-2312) has only `warningEmailSentAt` for notification dedup — there is no `lastMilestoneNotified` or equivalent column. Because `currentStreakDays` is `FLOOR(elapsed/86400)+1` (constant across the full milestone day), every call to `updateStreak` on that day fires both a `streak.milestone` webhook dispatch and a realtime event, so an org publishing N posts on day 7/30/100/365 sends N duplicate milestone notifications.

**Fix:** Add a `lastMilestoneDay` integer column to `org_streaks` and gate the dispatch: only fire when `streak.currentStreakDays > (streak.lastMilestoneDay ?? 0)`, then update `lastMilestoneDay` to `streak.currentStreakDays` in the same DB write.

---

### B93 [MEDIUM] Instagram accounts connected via Facebook Login are refreshed with grant_type=ig_refresh_token, which can never succeed for their Facebook user tokens

- **File:** apps/api/src/services/token-refresh.ts:294
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** oauth-token-lifecycle

refreshToken's 'instagram' case unconditionally calls refreshInstagram(account.accessToken), which hits graph.instagram.com/{v}/refresh_access_token with grant_type=ig_refresh_token. That grant only works for Instagram-Login (graph.instagram.com) tokens. Instagram accounts connected via Facebook Login store a Facebook long-lived user token (exchangeAndSaveAccount connect.ts:698-711, fb_exchange_token) with tokenExpiresAt ~60d, and nothing in the row distinguishes the two flows. For these accounts the refresh call always fails (wrong token type/host), so they fall into the daily 'reconnect needed' notification loop from day ~53 even though the token is still valid, and they can never be auto-extended.

**Evidence:** The `socialAccounts` table has no column to distinguish Instagram-Login vs Facebook-Login connections (packages/db/src/schema.ts:323-368). `refreshToken()` at token-refresh.ts:294-298 always calls `refreshInstagram()` which uses `grant_type=ig_refresh_token` on `graph.instagram.com` — a grant that only works for Instagram-Login (ig_exchange_token-derived) tokens. Accounts connected via Facebook Login (connect.ts:698-711) hold a Facebook user token from `fb_exchange_token`, so the refresh call will 400/fail every time, triggering the disconnect notification loop despite the token still being valid for ~60 days.

**Fix:** Store the connection method (e.g., a `connectionMethod` column or a `metadata.ig_type` flag) when saving the account, then branch in `refreshToken()` for `instagram`: if Facebook-Login, return `null` (same as the `facebook` case) so the existing token is used until it expires and the user reconnects.

---

### B94 [MEDIUM] Daily token-refresh cron re-enqueues permanently-expired accounts forever, re-notifying every org member daily

- **File:** apps/api/src/services/token-refresh.ts:40
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** scheduled-crons

enqueueExpiringTokenRefresh selects accounts with lt(tokenExpiresAt, sevenDaysFromNow) — this includes tokens that expired weeks or months ago, not just upcoming expiries. When refreshAccountToken fails (refresh token revoked, platform returned 4xx), it logs a connection error and sends an 'Account token expired' notification to every org member (lines 121-136), but nothing marks the account as failed/needs-reconnect or clears/advances tokenExpiresAt. The same dead account is therefore re-enqueued by the 9am cron every single day, and every member receives the same disconnect notification daily until they reconnect or delete the account — duplicated state churn and notification spam presented as new events.

**Evidence:** The Drizzle query at token-refresh.ts:38-41 uses `lt(socialAccounts.tokenExpiresAt, sevenDaysFromNow)` with no lower bound, so it selects all accounts whose `tokenExpiresAt` is in the past by any amount. When `refreshAccountToken` fails (result is null), it only logs and sends notifications (token-refresh.ts:105-137) and does NOT update the account row — no status flag, no `tokenExpiresAt` advancement, no `needsReconnect` marker exists in the schema (packages/db/src/schema.ts:323-368). The same failed account is therefore re-enqueued every day at 9am and every org member receives a duplicate disconnect notification daily.

**Fix:** On refresh failure, set a `needsReconnect` boolean column (or equivalent metadata flag) in `socialAccounts` and add `eq(socialAccounts.needsReconnect, false)` to the cron query; alternatively, advance `tokenExpiresAt` by 24h on failure to suppress re-enqueueing for one day and avoid notification spam.

---

### B95 [MEDIUM] Token refresh paths bypass the per-account KV lock, letting concurrent refreshes burn single-use rotating refresh tokens and clobber newer tokens

- **File:** apps/api/src/services/token-refresh.ts:80
- **Type:** race  |  **Verification:** 2-lens  |  **Finder:** races-concurrency

Two refresh paths bypass the per-account KV lock that refreshTokenIfNeeded uses to serialize token refreshes: (1) the queue consumer refreshAccountToken (token-refresh.ts:100) and (2) the publisher's inline TOKEN_EXPIRED retry (publisher-runner.ts:174), which also uses a refresh-token snapshot loaded at publish start and thus possibly stale. Every Twitter account (2h token TTL, always within the 7-day enqueue window) is enqueued by the daily 09:00 UTC cron, which fires at the same minute as the every-minute scheduled-post publisher and the every-5-minute analytics/external-sync crons, so lock-free queue refreshes regularly overlap locked publish/analytics refreshes of the same account. For platforms with single-use rotating refresh tokens, both paths POST the same stored token and the loser is rejected: refreshAccountToken then falsely logs an error connection event and notifies all org members the account "needs to be reconnected" (token-refresh.ts:106-137), the publish/analytics operation fails with the stale token, and per OAuth reuse-detection the provider may revoke the whole grant. CORRECTION to the original claim: the "stale result overwrites a newer rotated refresh_token during the 10s avatar-fetch window" clobber cannot occur under strict single-use rotation — double-success is impossible since the competitor's POST of the consumed token fails, so only one DB write happens; the clobber is only realizable for providers with a reuse grace window, and is harmless for non-rotating providers. The 10s avatar fetch + R2 rehost before the DB write (token-refresh.ts:154-164) still matters because it widens the window in which other paths read and burn the soon-to-be-stale refresh token.

**Evidence:** refreshAccountToken: `const result = await refreshTokenDirect(env, account.platform …)` (lines 100-103) with no `env.KV.get(lockKey)`/put anywhere in the function, while refreshTokenIfNeeded guards the identical operation with `token-refresh-lock:${account.id}` (lines 214-232); publisher-runner.ts:174 `const refreshed = await refreshTokenDirect(env, target.platform, { accessToken, refreshToken: decryptedRefresh })` likewise lock-free.

**Fix:** Route all three refresh paths through one locked helper: extract refreshAndPersist(env, accountId) that (a) acquires token-refresh-lock:{id} exactly as refreshTokenIfNeeded does (wait + re-read DB if held), (b) re-reads the socialAccounts row AFTER acquiring the lock and skips the provider call if updatedAt/tokenExpiresAt shows a fresh token was just written, (c) calls refreshToken and persists access/refresh/expiry immediately, releasing the lock in a finally block. Use it from refreshAccountToken and from the publisher TOKEN_EXPIRED retry (which should also re-read the stored access token first and retry the publish with it before refreshing, since a concurrent refresher may have already written a valid token). In refreshAccountToken, move the fetchAvatarUrl + rehostAvatar work to after the token DB write as a separate best-effort update so the new rotated refresh token is persisted within milliseconds of issuance instead of after a 10s avatar round-trip.

---

### B96 [MEDIUM] YouTube PubSub subscription registers no hub.secret, so X-Hub-Signature verification can never succeed when YOUTUBE_HUB_SECRET is set (and is skipped entirely when unset)

- **File:** apps/api/src/services/webhook-subscription.ts:77
- **Type:** drift  |  **Verification:** 1-pass  |  **Finder:** webhook-verification

subscribeYouTubeChannel() builds the PubSubHubbub subscribe body with hub.callback/topic/verify/mode/lease_seconds but omits hub.secret. WebSub hubs only attach an X-Hub-Signature header when the subscription registered a hub.secret. The POST /youtube handler, however, requires a signature whenever YOUTUBE_HUB_SECRET is configured: missing signature returns 403, and a present one is HMAC-checked against YOUTUBE_HUB_SECRET. Because no secret was ever registered with the hub, the hub never sends a signature, so with YOUTUBE_HUB_SECRET set every legitimate video notification is rejected (403, 'missing signature') and no YouTube webhooks/syncs are processed. With YOUTUBE_HUB_SECRET unset, the handler skips verification entirely and processes any spoofed POST for a channelId that resolves to an account. Either configuration is wrong: verification is impossible-by-construction, or absent.

**Evidence:** webhook-subscription.ts:77-83: `subscribeYouTubeChannel()` builds the PubSubHubbub subscribe body without `hub.secret`, so the YouTube hub never attaches `X-Hub-Signature` to deliveries. platform-webhooks.ts:557-561: when `YOUTUBE_HUB_SECRET` is set, the POST /youtube handler unconditionally requires a signature and returns 403 for any delivery lacking one — i.e., every legitimate delivery. With the env var unset, the handler accepts unauthenticated POSTs from anyone.

**Fix:** Pass `hub.secret: c.env.YOUTUBE_HUB_SECRET` (when set) in the `URLSearchParams` body inside `subscribeYouTubeChannel()`, ensuring the hub will sign its deliveries. The handler-side HMAC check is already correct and needs no change.

---

### B97 [MEDIUM] Broadcast processors have no per-recipient claim: overlapping cron ticks send duplicate messages to the same pending recipients

- **File:** apps/api/src/services/whatsapp-broadcast-processor.ts:140
- **Type:** race  |  **Verification:** 2-lens  |  **Finder:** races-concurrency

The duplicate-send race is real but only in whatsapp-broadcast-processor.ts. The processor intentionally re-picks broadcasts in status 'sending' (line 51) for resumability, selects recipients WHERE status='pending' with no claim (lines 140-150), and marks them sent/failed only after the external send settles (lines 169-199). The every-minute cron runs it via ctx.waitUntil (scheduled/index.ts:38) with no lock; Cloudflare gives cron invocations 15 minutes of wall time and does not serialize ticks, so any tick exceeding 60s (realistic under degraded Meta latency: 200-recipient budget / 25-per-chunk = 8 chunks, each bounded by the 10s sendMessage fetch timeout plus 500ms inter-chunk sleeps ≈ up to ~86s) overlaps the next tick, which re-reads the same still-pending rows and re-sends — customers receive duplicate (and per-message billed) WhatsApp template messages, and both ticks then race through the remaining pending rows chunk by chunk, multiplying duplicates. The sibling broadcast-processor.ts portion of the original claim is NOT a reachable duplicate-send race: its due query (lines 21-31) selects only status='scheduled', and the unguarded 'mark as sending' UPDATE (lines 108-111) lands at most ~17-40s after tick start (account fetch + refreshTokenIfNeeded use 10-15s fetch timeouts), long before the next tick's read at +60s. The missing eq(broadcasts.status,'scheduled') guard there is defense-in-depth hardening only.

**Evidence:** WA recipient fetch: `eq(whatsappBroadcastRecipients.status, "pending")` with no claim update before `sendMessage(...)` (lines 140-167) — rows are only flipped to sent/failed after the send settles (lines 169-199); broadcast-processor.ts claim: `.update(broadcasts).set({ status: "sending" …}).where(eq(broadcasts.id, broadcast.id))` (lines 108-111) without `eq(broadcasts.status, "scheduled")` or `.returning()` check.

**Fix:** In apps/api/src/services/whatsapp-broadcast-processor.ts, replace the select-then-send recipient loop with an atomic per-recipient claim: UPDATE whatsapp_broadcast_recipients SET status='sending', updated_at=now() WHERE id IN (SELECT id FROM whatsapp_broadcast_recipients WHERE broadcast_id=$1 AND status='pending' ORDER BY id LIMIT $chunk FOR UPDATE SKIP LOCKED) RETURNING *; send only to the returned rows, then flip them to sent/failed as today. Add a stale-claim sweep at the top of processBroadcast (rows in 'sending' with updated_at older than ~10 minutes revert to 'pending') so an evicted invocation cannot strand claimed rows, and include 'sending' in the pending-count check at line 220 so the broadcast is not finalized while claims are in flight. As cheap hardening, also make the broadcast-level claims compare-and-set: in whatsapp-broadcast-processor.ts lines 97-100 and broadcast-processor.ts lines 108-111 add eq(<table>.status, 'scheduled') to the WHERE and skip the broadcast if .returning() comes back empty.

---

### B98 [MEDIUM] Invitation resend has no org membership/role check (IDOR + email-trigger)

- **File:** apps/app/src/pages/api/invitations/[id]/resend.ts:10
- **Type:** authz  |  **Verification:** 1-pass  |  **Finder:** dashboard-internal-routes

The resend endpoint only checks `if (!currentUser)` and then looks the invitation up by id alone (`where(eq(invitation.id, id))`), with no verification that the caller belongs to — let alone is an owner/admin of — `invitation.organizationId`. Any authenticated user (including a member of an unrelated org) can resend any pending invitation by enumerating/guessing invitation IDs, re-triggering invite emails to the invitation's recipient. This bypasses the role gate that better-auth normally enforces for invitation creation (only owner/admin hold `invitation:create`).

**Evidence:** `resend.ts:9-11` performs only an `if (!currentUser)` check; the DB query at line 36 scopes the invitation lookup solely by `eq(invitation.id, id)` with no filter on `organizationId` or caller membership. Any authenticated user can resend any pending invitation by supplying its ID, triggering an email to the invitation's recipient from a potentially unrelated organization.

**Fix:** After fetching `row`, verify `row.organizationId` matches `context.locals.organization?.id` AND that the current user holds an owner/admin role in that org (reuse `requireBillingAdmin` or an equivalent member-role check) before sending the email.

---

### B99 [MEDIUM] SDK posts types are stale: missing 'partial' target status, missing newsletter platforms, missing template_id/template_variables/skip_signature params, missing metrics field

- **File:** packages/sdk/src/resources/posts/posts.ts:345
- **Type:** drift  |  **Verification:** 1-pass  |  **Finder:** sdk-drift

Several API-side schema changes never made it into the SDK posts resource. (1) API per-target status enum includes 'partial' (schemas/posts.ts:173) but every SDK Targets.status union omits it (posts.ts:345 etc.), so TS consumers exhaustively switching on target status mishandle real responses. (2) API PlatformEnum has 21 platforms including beehiiv/convertkit/mailchimp/listmonk (schemas/common.ts:3-25) and targets serialize those values, but SDK posts/analytics/inbox platform unions stop at 'sms' (17 values) — a post targeting a newsletter account returns platform values the SDK types claim impossible. (3) CreatePostBody accepts template_id, template_variables, and skip_signature (schemas/posts.ts:136-139), none of which exist on SDK PostCreateParams (posts.ts:1336-1396), so typed SDK users cannot use content templates or suppress signatures without casts. (4) API PostResponse includes an optional metrics snapshot (schemas/posts.ts:219) that the list handler populates (routes/posts.ts:783), absent from all SDK post response types. Similarly MediaListParams lacks workspace_id which the API accepts via FilterParams.

**Evidence:** Four confirmed divergences between API and SDK: (1) per-target `status` in PostCreateResponse.Targets (posts.ts:345), PostRetrieveResponse.Targets (posts.ts:491), and PostListResponse.Data.Targets (posts.ts:768) all omit `'partial'` while the API TargetResult enum includes it (schemas/posts.ts:173); (2) platform unions in all Targets interfaces stop at 'sms' (17 values) missing beehiiv/convertkit/mailchimp/listmonk present in API PlatformEnum (schemas/common.ts:3-25); (3) SDK PostCreateParams (posts.ts:1336-1396) lacks template_id, template_variables, and skip_signature which CreatePostBody defines (schemas/posts.ts:136-139); (4) API PostResponse includes `metrics` field (schemas/posts.ts:219) populated in routes/posts.ts:783 but absent from SDK PostRetrieveResponse and PostListResponse.Data. Top-level post `status` already includes 'partial' in the SDK; only per-target status is stale.

**Fix:** Regenerate the SDK from the OpenAPI spec (`bun run --filter api export-openapi` then re-run Stainless), or manually add the four missing elements: 'partial' to Targets.status unions, the four newsletter platforms to platform unions, template_id/template_variables/skip_signature to PostCreateParams, and a metrics optional field to PostRetrieveResponse and PostListResponse.Data.

---

### B100 [LOW] Ads queue retries non-idempotent createAd/boostPost: a partial failure after the platform call would create duplicate live campaigns/ads spending real budget (latent — no current producer)

- **File:** apps/api/src/queues/ads.ts:77
- **Type:** billing  |  **Verification:** 1-pass  |  **Finder:** error-handling

consumeAdsQueue retries 'create_ad' and 'boost_post' on any non-INVALID_STATE error (attempts < 3). createAd (ad-service.ts:471-544) first creates a live campaign and ad on the platform (adapter.createCampaign / adapter.createAd, status 'active' with budgets) and only then inserts the DB rows (lines 484, 547); there is no idempotency key or progress marker. If the DB insert fails transiently (or the invocation dies before ack), the retry re-executes the platform calls, creating a second active campaign/ad that spends money, while the first remains live but orphaned (no DB row, invisible to the API). Currently nothing sends create_ad/boost_post to ADS_QUEUE (only 'sync_external' from ad-sync.ts:311), so this is latent, but the consumer is wired and any future producer hits it.

**Evidence:** In ad-service.ts, `adapter.createCampaign` (line 471) and `adapter.createAd` (line 524) both execute before their respective `db.insert` calls (lines 484, 547). The queue consumer in queues/ads.ts:77-79 retries on any non-INVALID_STATE error up to 3 attempts, so a transient DB failure after the platform call would re-invoke both external spend-creating calls, orphaning the first live campaign/ad with no DB row. Claim's latency assessment is correct: ad-sync.ts only sends 'sync_external' to ADS_QUEUE; no current producer sends 'create_ad' or 'boost_post'.

**Fix:** Wrap each platform call + DB insert in a check-before-create pattern: query the DB for an existing row with the returned platformCampaignId/platformAdId before creating a new one, or persist a 'pending' DB record with a nonce before the platform call and update it after. Add an idempotency key (e.g. the queue message ID) to deduplicate retries.

---

### B101 [LOW] media-cleanup queue consumer ignores the event's action (and bucket) — a create-event notification rule would delete every fresh media row

- **File:** apps/api/src/queues/media-cleanup.ts:20
- **Type:** validation  |  **Verification:** 1-pass  |  **Finder:** media-r2

The consumer's message type includes `action` (R2 event notifications send PutObject/CopyObject/CompleteMultipartUpload/DeleteObject/LifecycleDeletion), but the handler unconditionally runs `db.delete(media).where(eq(media.storageKey, body.object.key))` for every message regardless of action or bucket. Correctness currently depends entirely on the dashboard-side notification rule being configured for delete actions only; if anyone ever adds object-creation events to the rule (or points another bucket's notifications at this queue), every upload would delete its own just-inserted media row, silently wiping the library. The delete also has no status/organization filter, though keys are effectively unique.

**Evidence:** media-cleanup.ts:17-26 unconditionally runs `db.delete(media).where(eq(media.storageKey, body.object.key))` for every queued message without ever reading `body.action` (declared at line 9). Correctness currently relies entirely on the R2 notification rule being wired for DeleteObject events only; if a PutObject/CopyObject/CompleteMultipartUpload event is ever added to that notification rule, every upload would immediately delete its own just-inserted DB row.

**Fix:** Add `if (body.action !== 'DeleteObject' && body.action !== 'LifecycleDeletion') { message.ack(); continue; }` at the top of the message loop before the DB delete.

---

### B102 [LOW] Inbox sendMessage reply_to param is documented in the API schema and SDK but silently ignored by the handler

- **File:** apps/api/src/routes/inbox-feed.ts:622
- **Type:** validation  |  **Verification:** 1-pass  |  **Finder:** sdk-drift

SendMessageBody declares `reply_to: z.string().optional().describe("Message ID to reply to")` (schemas/inbox.ts:116), and the SDK exposes MessageSendParams.reply_to (sdk inbox/conversations.ts:563). The POST /v1/inbox/conversations/{id}/messages handler destructures only { account_id, text, attachments, message_tag, quick_replies, template } and `reply_to` appears nowhere else in inbox-feed.ts or inbox.ts (grep returns zero hits). A client sending reply_to (e.g. to thread a WhatsApp reply via context.message_id or an IG/FB reply) gets a 200 success but the message is sent as a plain message with the reply association silently dropped — no error, no warning.

**Evidence:** inbox.ts:116 declares `reply_to: z.string().optional()` in `SendMessageBody`, and conversations.ts:563 exposes `MessageSendParams.reply_to`, but inbox-feed.ts:622 only destructures `{ account_id, text, attachments, message_tag, quick_replies, template }` and `reply_to` is never referenced anywhere in inbox-feed.ts. Clients sending `reply_to` receive a 200 success but the reply threading is silently dropped — no error is raised.

**Fix:** Either destructure and pass `reply_to` as `context: { message_id: reply_to }` in the Messenger/WhatsApp API payload, or remove it from the schema and SDK until it is implemented to avoid misleading callers.

---

### B103 [LOW] DELETE /v1/media/:id removes the R2 object without checking references from scheduled/draft posts, and leaves the presign KV cache stale

- **File:** apps/api/src/routes/media.ts:511
- **Type:** data-integrity  |  **Verification:** 1-pass  |  **Finder:** media-r2

deleteMedia deletes the R2 object and DB row immediately (media.ts:511-514) without checking whether the media URL is still referenced in any post's platformOverrides._media. A scheduled post referencing the file will only fail at publish time, when presignRelayMediaUrls signs a URL for the now-missing object and the platform fetch 404s — with no warning at delete time and a confusing platform-side error later. Additionally the cached presigned GET URL in KV (`r2-presign:3600:<key>`, TTL up to 50 min, r2-presign.ts:19-23,64) is not purged, so post list responses keep returning a URL that 404s for up to 50 minutes.

**Evidence:** media.ts:510-514 deletes the R2 object and DB row with no query against posts checking platformOverrides._media references, and no `env.KV.delete(presignKvKey(...))` call. A scheduled post referencing the deleted file will silently fail at publish time, and the KV-cached presigned URL (r2-presign.ts:53-68, TTL up to 50 min) continues to be served to list-endpoint callers until it expires.

**Fix:** Before deleting, query posts for any platformOverrides referencing the storageKey and return a 409 if any exist, or document as a soft-delete that only schedules R2 removal. On delete, call `env.KV.delete(presignKvKey(record.storageKey, 3600))` in the same Promise.all.

---

### B104 [LOW] Confirm-time MIME/size enforcement is optional — unconfirmed presigned uploads bypass the 50MB cap and re-verification but remain fully usable in posts

- **File:** apps/api/src/routes/media.ts:552
- **Type:** validation  |  **Verification:** 1-pass  |  **Finder:** media-r2

The SEC-02 MIME re-check and SEC-11 50MB size cap only execute inside POST /v1/media/confirm (media.ts:541-559). Nothing forces a client to call confirm: the presign response already returns the canonical `url` (media.ts:445-451), posts accept any http(s) URL as media (schemas/posts.ts MediaItem), and presignRelayMediaUrls signs whatever key the URL contains without ever consulting the media table or its status (r2-presign.ts:88-100). A client can presign (Content-Type is signature-pinned, but object size is not constrained by a presigned PUT), upload a multi-GB file, skip confirm, and attach the URL to posts — the size limit and the deferred MIME verification are never applied. The DB row stays "pending" with size 0, so any size-based accounting is also wrong.

**Evidence:** The confirm step is entirely optional: the presign response already returns the canonical URL (media.ts:445-451) which is usable in posts, and nothing in the publish path checks media.status. SEC-11 size enforcement and SEC-02 MIME re-verification (media.ts:541-559) are therefore bypassable by simply omitting the confirm call. This is a real design gap, but its severity is low because the presign itself validates the MIME type upfront (media.ts:400-405) and the R2 presigned URL is Content-Type-constrained by the signature, limiting the practical attack surface.

**Fix:** Either enforce confirm before a presigned media URL can be used in a post (check media.status='ready' when resolving media URLs at publish time), or add a background job that cleans up pending rows and enforce a TTL so unconfirmed uploads expire.

---

### B105 [LOW] confirmMedia is not idempotent — a retried confirm after success returns 404, making clients treat a successful upload as failed

- **File:** apps/api/src/routes/media.ts:577
- **Type:** error-handling  |  **Verification:** 1-pass  |  **Finder:** media-r2

The confirm UPDATE matches only rows with `status = 'pending'` (media.ts:568-574). If a client's first confirm succeeds but the response is lost (timeout/network) and the client retries — the standard pattern for a POST that callers are told to retry — the second call finds no pending row and returns 404 "No pending media record found" (media.ts:577-582), so the client concludes the upload failed even though the media is ready. There is no way to distinguish "already confirmed" from "never uploaded".

**Evidence:** confirmMedia (media.ts:568-574) filters on status='pending', so a retry of a successful confirm finds 0 rows updated and returns 404 (media.ts:577-582) with 'No pending media record found', which is indistinguishable from a never-uploaded key. This breaks the standard idempotent-POST retry pattern and can cause clients to incorrectly believe an upload failed. In practice, the dashboard never calls confirm at all (claim [0]), so this is only triggered by SDK/API users who retry on network failure.

**Fix:** In the confirm handler, after the UPDATE returns 0 rows, check whether a row exists with status='ready' for the same storage_key and orgId; if so, return 200 with the existing record instead of 404.

---

### B106 [LOW] OAuth state one-time-use is unenforceable across colos: KV delete-after-read leaves a replay window where a duplicated callback re-exchanges the code

- **File:** apps/api/src/routes/oauth-callback.ts:46
- **Type:** race  |  **Verification:** 1-pass  |  **Finder:** oauth-token-lifecycle

The GET callback reads oauth-state:${state} and then deletes it, but Workers KV is eventually consistent (~60s propagation) and get→delete is not atomic, so two near-simultaneous hits of the same callback URL (double-click, browser prefetch, corporate link scanners on the redirect URL) can both pass the state check and both call exchangeAndSaveAccount with the same authorization code. Per RFC 6749 §4.1.2 providers SHOULD revoke all tokens issued for a replayed code (Google does), so the duplicate request can cause the just-saved access/refresh tokens to be revoked server-side moments after a successful connect — the account row looks connected but its tokens are dead. The same window applies to the POST completeOAuth state consumption (connect.ts:2768-2795).

**Evidence:** oauth-callback.ts:36-46 does a non-atomic KV.get then KV.delete, creating a small race window (~milliseconds to seconds, not ~60s) where two near-simultaneous requests can both pass the stateData check before either delete propagates. Workers KV 'eventual consistency' for deletes is typically very fast on the same colo, but cross-colo delivery lag can extend the window. The practical impact is limited because OAuth providers (e.g. Google) reject replayed codes and revoke associated tokens, leaving the account row in a connected-but-invalid-token state.

**Fix:** Use a KV 'write then read' compare-and-swap by storing a claimed flag: before proceeding, attempt a conditional write (e.g. store a 'claimed' marker with a very short TTL and check if you won the race). Alternatively, move state to Durable Objects for atomic test-and-delete semantics.

---

### B107 [LOW] Automation/segment filter `op` is an unvalidated free string — any typo silently evaluates to false with no error

- **File:** apps/api/src/schemas/automations.ts:95
- **Type:** validation  |  **Verification:** 1-pass  |  **Finder:** input-validation

PredicateSchema declares `op: z.string()` instead of an enum, so POST /v1/segments and automation condition nodes accept ops like "equals", "==", or "greater_than". At evaluation time, evalPredicate's switch has a `default: return false` (filter-eval.ts:88-89), so the predicate silently fails for every contact: a segment built with a typoed op is permanently empty and a condition node always takes the false branch — with zero feedback to the user, since creation succeeded. Also, gt/gte/lt/lte require `typeof actual === "number"`, so numeric custom-field values stored as strings (custom field values are persisted as String(value), contacts.ts:1321/1366) never match numeric comparisons.

**Evidence:** automations.ts:93-97 declares `op: z.string()` with no enum constraint, so typos like 'equals' pass validation but hit the `default: return false` in filter-eval.ts:88-89 with no error. Additionally, `gt/gte/lt/lte` at filter-eval.ts:69-75 require `typeof actual === 'number'`, but contacts.ts:1321+1366 always stores custom field values as `String(value)`, so numeric custom-field comparisons silently return false even with valid ops.

**Fix:** Change `op: z.string()` to `op: z.enum(['eq','neq','contains','not_contains','starts_with','ends_with','gt','gte','lt','lte','in','not_in','exists','not_exists'])` in PredicateSchema; for numeric comparisons, coerce `actual` with `Number(actual)` before the comparison.

---

### B108 [LOW] total_exited counter is never incremented — every exit path (graph_changed, automation_deleted, input_timeout) skips it

- **File:** apps/api/src/services/automations/runner.ts:627
- **Type:** data-integrity  |  **Verification:** 1-pass  |  **Finder:** automations-engine

incrementCounter supports 'total_exited' (runner.ts:630,637) but no call site ever passes it: the graph_changed exit (runner.ts:134), automation_deleted exit (runner.ts:97-104), and the scheduler's input_timeout exit (scheduler.ts:195-207) all mark runs exited without bumping automations.total_exited, while total_completed/total_failed are bumped on their paths (runner.ts:117,222,246,295,316,339). The total_exited stat surfaced via GET automations (routes/automations.ts:82 `total_exited: row.totalExited`) is permanently 0, so the enrolled = completed + failed + exited + in-flight accounting visible to operators is wrong whenever runs exit.

**Evidence:** runner.ts:97-104 (automation_deleted exit) and runner.ts:122-135 (graph_changed exit) both call exitRun() with status='exited' but never follow with incrementCounter(..., 'total_exited'). scheduler.ts:195-207 (input_timeout exit) also directly updates the run to 'exited' without calling incrementCounter. The function at runner.ts:627-648 supports the 'total_exited' column but no call site passes it.

**Fix:** After each exitRun call that uses status='exited', add `await incrementCounter(db, run.automationId, 'total_exited')`. For the scheduler path (scheduler.ts:195-207), import and call incrementCounter after the direct DB update.

---

### B109 [LOW] Inbound automation webhook HMAC covers only the body with no timestamp/nonce, allowing replay

- **File:** apps/api/src/services/automations/webhook-receiver.ts:362
- **Type:** validation  |  **Verification:** 1-pass  |  **Finder:** webhook-verification

verifyHmacSha256 signs only params.rawBody; there is no signed timestamp, nonce, or seen-event dedup in receiveAutomationWebhook. A captured valid request (x-relay-signature + body) can be replayed indefinitely. Within the runner's reentry_cooldown_min the re-enrollment is suppressed, but once the cooldown elapses (or when allow_reentry is true with a short cooldown) each replay re-triggers the automation and re-runs its actions (DMs, tag changes, contact creation). Unlike Stripe's scheme, nothing binds the signature to a time window or single use.

**Evidence:** verifyHmacSha256 (webhook-receiver.ts:120-145) signs only `rawBody` with no timestamp or nonce, and `receiveAutomationWebhook` (lines 309-451) performs no dedup check on previously-seen signatures. An attacker who captures a valid `(rawBody, x-relay-signature)` pair can replay it indefinitely; the `reentry_cooldown_min` gating in `enrollContact` suppresses re-enrollment only within the cooldown window, so replays spaced beyond that window (or against automations with `allow_reentry: true`) re-trigger all actions.

**Fix:** Include a caller-supplied `X-Relay-Timestamp` header in the signed payload and reject requests where the timestamp deviates from server time by more than N seconds (e.g. 300). Optionally maintain a short-lived KV set of seen `(slug, signature)` pairs to reject within-window replays.

---

### B110 [LOW] WhatsApp batch normalizer attributes every message to contacts[0]'s profile name — wrong author/participant name for multi-sender batches

- **File:** apps/api/src/services/inbox-event-processor.ts:1590
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** inbox-messaging

normalizeWhatsAppEvent takes `const contact = value.contacts?.[0]` once and uses `contact?.profile?.name` as the author name for every message in the batch. WhatsApp Cloud API webhooks can batch messages from multiple senders in one change.value, with the contacts[] array carrying one entry per distinct wa_id. When that happens, messages from the second sender are normalized with the first sender's display name, which then becomes the second sender's conversation participantName (via upsertConversation) and message authorName.

**Evidence:** inbox-event-processor.ts:1590 confirms `const contact = value.contacts?.[0]` is captured once outside the loop; inbox-event-processor.ts:1601 uses `contact?.profile?.name ?? msg.from` for every message regardless of `msg.from`. WhatsApp Cloud API can batch messages from different senders in one `value`, each with a separate entry in `contacts[]`, so messages from the second sender get the first sender's display name as `authorName`.

**Fix:** Inside the loop, find the matching contact by `msg.from`: `const contact = value.contacts?.find(c => c.wa_id === msg.from)`. This ensures each message uses its own sender's profile name.

---

### B111 [LOW] Monthly recycling gap uses setUTCMonth — configs created on the 29th-31st overflow into the following month and drift

- **File:** apps/api/src/services/recycling-validator.ts:120
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** scheduled-crons

computeNextRecycleAt for gapFreq='month' does next.setUTCMonth(next.getUTCMonth() + gap). JavaScript normalizes overflowed days: Jan 31 + 1 month = Feb 31 → Mar 3 (Mar 2 in leap years), May 31 + 1 → Jul 1, etc. A monthly recycling config processed on the 29th-31st therefore skips the intended month entirely and permanently drifts to early-month dates (31st → 3rd → 3rd...), so a 'recycle every 1 month' post recycles ~31+N days later and the user-visible next_recycle_at in the post.recycled webhook (recycling-processor.ts:212-216) reflects the wrong schedule.

**Evidence:** recycling-validator.ts:120 calls `next.setUTCMonth(next.getUTCMonth() + gap)` on a `new Date()` (current time at processing) with no day-of-month clamping; recycling-processor.ts:54-58 passes `new Date()` as the `from` argument. If a recycling cron fires on a 31-day month (Jan 31, Mar 31, May 31, etc.), JavaScript normalises the overflow into the following month, causing a permanent day-of-month drift (31 → 3 → 3...) so monthly configs permanently misfire by 2–3 days.

**Fix:** Clamp the result day to the last day of the target month: after `next.setUTCMonth(next.getUTCMonth() + gap)`, if `next.getUTCDate()` differs from the intended day, set the date to 0 of the next month (i.e., last day of the intended month). Alternatively, compute the target month/year and use `new Date(Date.UTC(y, m, Math.min(originalDay, daysInMonth(y, m))))` to pin to the correct end-of-month day.

---

### B112 [LOW] Thread item with only skipped (non-threadable) targets is marked 'published', and thread.published fires despite mid-chain failures

- **File:** apps/api/src/services/thread-publisher.ts:305
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** publishing-state-machine

When every target of a non-root thread item is skipped as non-threadable, each target row is written status='failed' (error 'Platform does not support threading') yet the post itself is set status='published' with publishedAt, because `attemptedCount === 0` maps to 'published'. The post-level state ('published', has publishedAt) directly contradicts its own target rows (all 'failed') and nothing was actually published for that item. Additionally, the chain continues through 'partial' positions and the terminal branch dispatches the 'thread.published' webhook unconditionally, so consumers receive a success event for threads containing failed items.

**Evidence:** thread-publisher.ts:304-311: when all targets are skipped as non-threadable, `skipCount` increments but `attemptedCount === successCount + failCount === 0`, so `finalStatus = 'published'` — while the target rows were written `status='failed'` at line 215. Lines 334-350 then dispatch `thread.published` with no check on whether any position ended in failure or had only skipped targets.

**Fix:** Treat all-skipped items as 'skipped' (not 'published') or at minimum do not set `publishedAt` and do not dispatch `thread.published` if every item in the thread was either skipped or failed. Add a `hasRealSuccess` guard before the webhook dispatch at line 338.

---

### B113 [LOW] Weekly digest counts posts by createdAt instead of publish time — 'posts published this week' excludes pre-scheduled posts

- **File:** apps/api/src/services/weekly-digest.ts:62
- **Type:** logic  |  **Verification:** 1-pass  |  **Finder:** scheduled-crons

processWeeklyDigest aggregates `count(*) filter (where status='published')` over posts with createdAt in the past 7 days. A post created/scheduled 2+ weeks ago that actually published this week is excluded, while a post created this week is counted in this digest based on creation date. For orgs that schedule content in advance (the product's core use case), the Monday digest 'This week: N posts published, M failed' under-reports or misattributes activity.

**Evidence:** weekly-digest.ts:59-64 filters posts with `gte(posts.createdAt, weekAgo)` and `lte(posts.createdAt, now)` and counts by status='published'. The DB schema (schema.ts:386) confirms `publishedAt` is a separate column. A post created 3 weeks ago but published this week is excluded; a post created this week but in a terminal state is counted based on creation date, so the 'posts published this week' figure is wrong for advance-scheduled content.

**Fix:** Replace the `createdAt` window filter with `gte(posts.publishedAt, weekAgo)` and add `isNotNull(posts.publishedAt)` so only actually-published posts within the window are counted. Apply the same approach to the failed/partial counts using a separate `failedAt` timestamp or filter on `updatedAt` with a note that it is approximate.

---

### B114 [LOW] Unauthenticated on-demand-request endpoint sends emails with unescaped user input

- **File:** apps/app/src/pages/api/on-demand-request.ts:5
- **Type:** security  |  **Verification:** 1-pass  |  **Finder:** dashboard-internal-routes

The POST handler performs no authentication check (it reads `context.locals.user` only optionally) and sends an email to support@relayapi.dev built from raw request fields. Any unauthenticated internet caller can drive the support mailbox (spam/abuse), and `platform`, `name`, `email`, and `message` are interpolated into the HTML email body without escaping, allowing HTML/markup injection into the internally-rendered support email (phishing/spoofed content).

**Evidence:** apps/app/src/pages/api/on-demand-request.ts:5-15 performs no authentication check — the middleware (middleware/index.ts:326-372) resolves the session and sets `context.locals.user` for `/api/` paths but the route never inspects it. Lines 21-24 interpolate `${platform}`, `${name}`, `${email}`, `${message}` directly into the HTML body sent to the internal support inbox, allowing HTML injection. The impact is limited to internal staff viewing the support email, not user-facing data.

**Fix:** Add `if (!context.locals.user) return new Response(null, { status: 401 })` at the top of the POST handler, and HTML-escape the interpolated fields (e.g. replace `<`, `>`, `&`, `"` before insertion into the HTML string).

---

### B115 [LOW] API endpoints absent from the SDK: inbox stats/search/priorities, inbox AI (classify/suggest-reply/summarize), tools jobs/resolve-mention/transcript

- **File:** packages/sdk/src/resources/inbox/inbox.ts:44
- **Type:** drift  |  **Verification:** 1-pass  |  **Finder:** sdk-drift

Path-by-path diff of all 360 API routes vs all SDK client calls shows these live API endpoints have no SDK method at all: GET /v1/inbox/stats, GET /v1/inbox/search, GET /v1/inbox/priorities, POST /v1/inbox/classify, POST /v1/inbox/suggest-reply, POST /v1/inbox/summarize (inbox-feed.ts / inbox-ai.ts), GET /v1/tools/jobs/{job_id}, POST /v1/tools/linkedin/resolve-mention, POST /v1/tools/youtube/transcript (tools.ts). The SDK inbox resource only exposes comments/conversations/reviews (inbox.ts:44-46) and tools only exposes validate/instagram. CLAUDE.md mandates the SDK be kept in sync with API routes; today nothing in the dashboard calls these raw (no violation found in apps/app), but any consumer needing them must bypass the SDK.

**Evidence:** packages/sdk/src/resources/inbox/inbox.ts:43-47 exposes only comments/conversations/reviews, with no methods for the live API endpoints GET /v1/inbox/stats, /search, /priorities (inbox-feed.ts:354,412) and POST /v1/inbox/classify, /suggest-reply, /summarize (inbox-ai.ts). Similarly packages/sdk/src/resources/tools/tools.ts:23-26 exposes only validate/instagram, missing GET /v1/tools/jobs/{job_id}, POST /v1/tools/linkedin/resolve-mention, and POST /v1/tools/youtube/transcript (tools.ts:511,824,922). CLAUDE.md mandates SDK-API sync on every route change, making this a real policy violation with practical impact for any SDK consumer needing these features.

**Fix:** Add the missing SDK methods by generating or manually authoring the corresponding resource sub-classes: StatsAPI, SearchAPI, and an AI sub-resource for inbox; and Jobs, LinkedIn, YouTube sub-resources for tools.

---

### B116 [LOW] SDK usage.retrieve() promises required rate_limit.current_minute that the API never returns

- **File:** packages/sdk/src/resources/usage.ts:74
- **Type:** drift  |  **Verification:** 1-pass  |  **Finder:** sdk-drift

SDK UsageRetrieveResponse.RateLimit declares `current_minute: number` (required, 'API calls in the current rate-limit window') but the API's UsageResponse schema (schemas/usage.ts:26-28) and handler (routes/usage.ts:132-134) return only `rate_limit: { limit_per_minute }` — the per-minute counter was moved to the Cloudflare Rate Limiting binding ('counters managed by CF Rate Limiting binding', usage.ts:105) and the field was dropped from the API without regenerating the SDK. Any SDK consumer reading usage.rate_limit.current_minute gets undefined despite the type saying number.

**Evidence:** packages/sdk/src/resources/usage.ts:74 declares `current_minute: number` as a required field on RateLimit, but apps/api/src/routes/usage.ts:132-134 only returns `rate_limit: { limit_per_minute: rateLimitMax }` — `current_minute` is entirely absent from the API response. Any SDK consumer accessing `result.rate_limit.current_minute` will read `undefined` at runtime despite the TypeScript type declaring it `number`.

**Fix:** Remove `current_minute` from the SDK's `RateLimit` interface in packages/sdk/src/resources/usage.ts, or add it back to the API response in apps/api/src/routes/usage.ts if the metric is available.

---

