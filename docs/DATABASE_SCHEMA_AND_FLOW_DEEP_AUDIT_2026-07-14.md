# RelayAPI database schema and flow deep audit — 2026-07-14

**Scope:** `packages/db`, its migration/provisioning tooling, `packages/auth`, and the API/app/queue/cron flows that read or mutate the database.

**Reviewed state:** the original audit covers the working tree on 2026-07-14. The remediation matrix and validation sections were reconciled against the shared working tree on 2026-07-15. The original finding bodies remain as historical evidence; the matrix is the authoritative statement of current repository status.

**Overall verdict:** the TypeScript schema, generated Drizzle snapshot, non-declarative contracts, and sealed virgin baseline are now coherent at repository level. The deterministic baseline has SHA-256 `e51b5011b87fd41a5bbd936ad4b2efe864b02a9448db841d453c6042fe5890db`, represents 111 `public` and 9 `auth` tables, and passed first-apply, second no-op, exact catalog, ledger, provisioning, optional-workspace, parent-inheritance, and strict-workspace rejection checks on disposable PostgreSQL 17.9.

This is **not a production-readiness approval**. The remaining release-significant gates are:

1. every database carrying the superseded 42-entry development ledger is unsupported by the one-entry virgin baseline and must be proven outside the supported inventory or deliberately backed up, restore-tested, and recreated;
2. PostgreSQL 18 is the authoritative CI/production target, but a local PostgreSQL 18 replay and isolated PostgreSQL 18 backup restore were not run during this audit;
3. the exact production migration connection, Access/VPC topology, provisioning rollback, backup, and restore paths have not been exercised with deployed credentials;
4. representative production-volume load, lock-plan, provider reconciliation, and real-database crash/concurrency evidence remains external acceptance work for several otherwise durable flows;
5. the expand/backfill/contract machinery and forward-recovery runbook exist, but a real multi-release sequence has not yet exercised them.

The repository-side artifact contradiction is closed. The remaining gaps are cutover decisions and operational evidence, not a known mismatch between `schema.ts` and the virgin baseline.

## Decision and severity model

| Priority | Meaning used here |
|---|---|
| **P0 / critical or high blocker** | Can destroy upgrade continuity, duplicate externally visible effects, cross an authorization boundary, leave durable credentials after identity deletion, or prevent required production operations. Fix, prove an explicit safe precondition, or disable the affected flow before production. |
| **P1 / high** | Material correctness, privacy, billing, or lifecycle failure under realistic concurrency/failure conditions. |
| **P2 / medium** | Structural integrity gap, latent authorization footgun, operational fragility, or derived-state drift that should be scheduled before scale. |
| **P3 / hardening** | No current exploit or demonstrated failure, but an unsafe default or missing defense makes future changes risky. |

The migration cutover is **conditional critical**: it is acceptable only if every supported environment is provably disposable and is recreated from the new baseline. It is not an incremental migration for an existing database.

## Scope, method, and limitations

The review covered:

- all 109 Drizzle table declarations present in `packages/db/src/schema.ts` during the original audit, plus the remediation review of newly added contracts referenced in the status matrix;
- the generated baseline, Drizzle journal/snapshot, migration manifest, catalog verifier, and live-history verifier;
- `createDb`, `drizzle.config.ts`, `setup-postgres.sh`, seed behavior, CI migration jobs, and deployment ordering;
- organization/workspace ownership, composite foreign keys, deletion actions, uniqueness, state constraints, indexes, secrets, retention, and denormalized counters;
- auth organization/user/member/API-key lifecycles;
- posts, publishing, threads, media, Ideas, inbox, automations, broadcasts, contacts, consent, webhooks, billing, queues, crons, and tenant deletion;
- focused and full type checks/tests, deterministic baseline reconstruction, migration replay/catalog/behavior checks, and generated OpenAPI/docs validation.

This was static and disposable-database validation. The configured remote database was not connected to because the required SSH tunnel was not available. The final local replay used PostgreSQL 17.9; PostgreSQL 18 is configured in migration CI but was not available as a local server. No production database, Cloudflare account, R2 bucket, Queue, Stripe account, or social provider was mutated. External lifecycle rules, deployed secrets, live data shape, production query cardinalities, backup contents, and restore readiness therefore remain unverified.

## What is strong and should be preserved

The schema is not generally careless. Several patterns are unusually good:

- Core resources frequently use composite `(id, organization_id)` foreign keys, including posts/targets, customer webhooks, inbox conversations/messages, contacts/channels, automation relationships, and ad entities.
- Ideas/tags/groups use generated scope keys to represent organization-global versus workspace-local uniqueness without relying on PostgreSQL's `NULL` uniqueness semantics.
- Publishing, customer webhook delivery, billing, checkout, token revocation, and tenant deletion have durable operation records, leases/fencing tokens, explicit ambiguous-outcome states, or outboxes.
- Many queue consumers use occurrence IDs, `FOR UPDATE SKIP LOCKED`, and state predicates.
- Social/BYOS/webhook/automation secrets use application encryption and token versions rather than being returned as ordinary columns.
- Consent has immutable evidence, a current projection, and identifier-level suppression that survives contact deletion.
- API logs and customer webhook delivery logs have explicit retention machinery.
- Tenant deletion has a programmatic completeness/order test that enumerates organization-owned tables; the principal problem is scale and query shape, not omitted tables.
- The migration verifier checks substantially more than table names: columns/types/defaults/generated columns, indexes, PK/unique/FK/check constraints, delete actions, enums, `pg_trgm`, and the expected ordinary `automation_step_runs` table.
- `createDb` per request, `max: 5`, and prepared statements match current Hyperdrive guidance.

## Original system flow verdict map — 2026-07-14 snapshot

| Flow | Verdict | Main reason |
|---|---|---|
| Fresh schema/bootstrap | **Green** | Baseline replay, second no-op migration, exact catalog check, and live ledger check passed on disposable PostgreSQL 17. |
| Existing-database upgrade | **Red / conditional** | The previous 42-entry ledger is incompatible with the new one-entry baseline. |
| API key organization isolation | **Mostly green** | Organization predicates and composites are pervasive; workspace-consistency is incomplete on several relationship/action routes. |
| User/member/API-key deletion | **Red** | Ordinary user deletion is blocked by `NO ACTION` references; successful deletion can leave an authenticating API key. |
| Social account connect/use | **Amber** | Core account ownership is strong; workspace reassignment and some dependent flows can create mixed-workspace graphs. |
| Post create/schedule/publish | **Amber** | Durable target attempts/outbox/leases are strong; route update/delete races provider work and fixed leases do not renew. |
| Core media upload/delete | **Amber** | Durable upload intent/reconciliation is good; workspace is not persisted on upload/presign, and Ideas bypasses the durable media model. |
| Inbox read/mutate/AI | **Red** | Several provider actions and AI reads omit conversation/account/workspace binding. |
| Automation enrollment/execution | **Red** | External node effects occur before an execution fence; message failures can be treated as success; scheduled filter semantics are wrong. |
| Generic broadcasts (including WhatsApp) | **Runtime hardened; DDL pending** | One workspace-consistent runtime uses atomic bulk creation, canonical recipient identity, revision/lease fences, and cancellation-safe finalization; the committed baseline still lacks that contract. |
| Contacts/segments/custom fields | **Amber/red** | Organization integrity is good; workspace equality is not encoded or consistently validated across relationships and merge. |
| Consent/suppression | **Amber** | Strong evidence model, but future timestamps and historical-identifier deletion need correction; workspace scope is an unresolved policy decision. |
| Billing/usage/dunning | **Amber/red** | Durable Stripe operations exist; usage meters have conflicting writers and dunning/invoice invariants are incomplete. |
| Inbound/customer webhooks | **Amber** | Durable receipts/effects exist; raw inbound payload retention and some dedupe/workspace routing need work. |
| Tenant deletion | **Red at scale** | Complete graph, but one huge transaction plus missing indexes/query mismatch. |
| Production provisioning/deploy | **Red** | Private connectivity, Access configuration, SSH/firewall safety, role separation, and restore proof are not coherent end to end. |

## Remediation status matrix — reconciled 2026-07-15

This matrix is the authoritative current status; the individual finding bodies below preserve the original evidence and explain why each issue was filed.

- **Fixed in source + sealed DDL** means the intended schema/runtime contract exists in the working tree, is represented by the deterministic virgin baseline, and has at least focused static or unit coverage.
- **Decision / external** means closure requires an explicit product/operations decision or evidence outside this repository.
- **Open / partial** means at least one material runtime or acceptance requirement remains; it no longer means that the virgin artifact is stale.

> **Generated database artifact result:** `0000_baseline.sql`, `meta/0000_snapshot.json`, the journal, migration manifest, generated preamble, and non-declarative contract block are reconciled and byte-reproducible. The baseline is sealed against further destructive rebuilds and its manifest records SHA-256 `e51b5011b87fd41a5bbd936ad4b2efe864b02a9448db841d453c6042fe5890db`. Disposable PostgreSQL 17.9 replay verified 111 `public` tables, 9 `auth` tables, `pg_trgm` in `public`, the ordinary `automation_step_runs` table, all catalog contracts, and a 1/1 live ledger. This closes the repository artifact gate; it is not a substitute for the PostgreSQL 18 and production-operational gates below.

| ID | Current status | Evidence and remaining gap |
|---|---|---|
| **DB-01** | **Decision / external cutover** | `migration-policy.json` explicitly defines a virgin PostgreSQL 18 baseline and the live-history verifier fails closed. The baseline is sealed, deterministic, and locally replayed, but no signed supported-environment inventory or backup/restore/recreation evidence exists; an old 42-entry ledger still has no upgrade path. |
| **DB-02** | **Fixed in source + sealed DDL; external proof remains** | `automations/runner.ts` claims and arms the node/effect before the handler, persists replayable results/context, advances by revision CAS, and reconciles expired claims. The effect-ledger DDL is in the sealed baseline. Real-database crash/concurrency cases still require the SSH/production-major fixture; provider lookup cannot guarantee reconciliation for every adapter, there is no operator reconciliation endpoint, and the five-minute lease has no heartbeat. |
| **DB-03** | **Fixed in source** | `routes/inbox-helpers.ts`, `services/conversation-reply-authorization.ts`, `routes/inbox-feed.ts`, and `schema-flow-high-risk-guards.test.ts` resolve one organization/workspace/account/platform tuple before provider actions. |
| **DB-04** | **Fixed in source** | `apps/app/src/lib/user-deletion.ts` and `packages/auth/src/index.ts` centralize self-delete hooks, revoke dashboard keys/sessions, serialize owner checks, and preserve audit attribution. |
| **DB-05** | **Fixed in source** | `services/tenant-deletion.ts` now uses durable leased steps, bounded per-table batches/checkpoints, resumable shared-receipt cleanup, and tenant-safe redaction. Focused deletion tests pass; representative large-tenant interruption/load evidence is still an operational acceptance gate. |
| **DB-06** | **Open / external proof** | `.github/workflows/deploy-api.yml` now starts an Access-protected TCP tunnel and validates loopback port, TLS, and migrator role. The exact production runner/secrets/topology have not completed a demonstrated read-only preflight and disposable rehearsal. |
| **DB-07** | **Fixed in source** | `automations/nodes/message.ts` fails when required sends report errors instead of advancing or waiting for input; message-handler coverage exercises the behavior. |
| **DB-08** | **Fixed in source** | `automations/scheduler.ts` implements `all` as intersection and `any` as union, rejects unsupported filters, and uses deterministic schedule occurrences with focused tests. |
| **DB-09** | **Fixed in source + sealed DDL** | `routes/broadcasts.ts` and `services/broadcast-processor.ts` implement transactional creation, recipient locking, revision/lease CAS, account/provider fences, and cancellation-safe `unknown` outcomes. The sealed baseline contains the required columns, checks, indexes, and generic recipient identity. |
| **DB-10** | **Fixed in source + sealed DDL** | Legacy WhatsApp routes, processor, SDK resource, dashboard surface, cron wiring, schema exports, and physical tables are absent. WhatsApp campaigns use the generic broadcast graph only. |
| **DB-11** | **Fixed in source** | `routes/posts.ts`, `publisher-runner.ts`, and `thread-publisher.ts` use mutation CAS, retain provider history, and renew parent/thread fences. A single provider call still relies on its bounded request duration rather than a heartbeat within that call. |
| **DB-12** | **Fixed in source + sealed DDL** | Contact merge, fields, segments, linkers, and persistence now enforce exact scope, backed by composite organization/scope relationships in the sealed schema. |
| **DB-13** | **Fixed in source** | `routes/inbox-ai.ts` resolves the scoped conversation/account target before content is loaded or sent to the AI binding. |
| **DB-14** | **Fixed in source + sealed DDL** | Automation entrypoint/binding/webhook contact resolution validates the prospective workspace/account/automation tuple; composite scope contracts backstop future writes. |
| **DB-15** | **Fixed in source + sealed DDL** | Idea attachments reference exact-scope `media` rows, commit an upload intent before R2, reconcile both upload crash windows, and use the durable original/thumbnail deletion tombstone. Idea and attachment deletion retain provider-failure recovery instead of deleting URL-only rows. |
| **DB-16** | **Fixed in source + sealed DDL; external load proof remains** | `usage-meter.ts`, `usage-tracking.ts`, and `invoice-generator.ts` share authoritative usage buckets, reserve/commit/release rows, and immutable settlement snapshots. Focused and full suites pass; a real-database contention/load fixture remains desirable. |
| **DB-17** | **Fixed in source + sealed DDL** | `occurred_at` is bounded to five minutes in the route and service, with matching row-relative database checks; server ingestion sequence controls projection order; replacement/deletion suppresses retired identifiers. The approved consent boundary is organization-global on exact `(organization, channel, purpose, normalized identifier hash)`; workspace is provenance only. |
| **DB-18** | **Fixed in source + sealed DDL** | Inbound receipts are encrypted, expire with a capped manual-review extension, and are redacted in bounded cron/deletion flows while retaining durable delivery identity. |
| **DB-19** | **Fixed in source + sealed DDL; external provider proof remains** | `stripe-webhooks.ts` preserves provider finalization/first-failure time, invoice period is no longer falsely unique, and `dunning.ts` claims unique leased effects with stable delivery/cancellation keys and reconciliation. No live concurrent Stripe fixture was run. |
| **DB-20** | **Open / external proof** | `setup-postgres.sh` now provisions a loopback-only TLS origin for Workers VPC/Tunnel, preserves SSH/UFW state, and avoids an unprotected TCP publication. A real provision/VPC/rollback rehearsal is not evidenced. |
| **DB-21** | **Decision / external, partially fixed** | The setup script separates owner/migrator/no-DDL runtime roles and safely quotes validated inputs. Backups and restore rehearsal are explicitly delegated to an external system and must be proven before production data is accepted. |
| **DB-22** | **Tooling/runbook fixed; external exercise remains** | Append-only history, strict journal ordering, reviewed `baseline`/`expand`/`contract` phases, destructive-expand guards, sealed-baseline enforcement, and PostgreSQL 18 CI/deploy gates are implemented and tested. The forward-recovery runbook documents compatible release phases and failure handling. A real multi-release expand/backfill/contract sequence remains operational acceptance evidence. |
| **DB-23** | **Fixed in source + sealed DDL** | Cross-post source/target/account/platform/scope identity and durable attempt fencing are encoded in the schema, post routes, and `cross-post-processor.ts`. |
| **DB-24** | **Fixed in source + sealed DDL** | The machine audit covers 262 workflow-state/high-risk-numeric candidates: 253 by `CHECK`, 6 by PostgreSQL enum, 3 by documented exception, and 0 missing. The sealed baseline and catalog verifier contain those constraints. This does not replace domain transition tests or production-data validation. |
| **DB-25** | **Fixed in source + sealed DDL** | An explicit post-thread parent, paired nullability, nonnegative positions/delays, unique positions, and scoped execution relationships prevent malformed thread graphs. |
| **DB-26** | **Fixed in source** | `inbox-persistence.ts` inserts/deduplicates a message and updates the conversation projection in one transaction; the conflict path repairs an old partially committed projection. |
| **DB-27** | **Fixed in source + sealed DDL** | Member uniqueness, per-user advisory serialization, exact segment scope, and the generated trigger/reconciliation contract for `member_count` are present in the sealed baseline and verified catalog. |
| **DB-28** | **Fixed in source + sealed DDL** | `routes/accounts.ts` locks the account and rejects workspace reassignment when any dependent graph exists; composite scope FKs are the final backstop. |
| **DB-29** | **Fixed in source + sealed DDL** | Default groups are provisioned/upserted behind a partial unique invariant; reads are side-effect free. Conversion claims an organization idempotency key and creates the draft, ready-media snapshot, Idea link, ownership transfer, activity, and succeeded ledger row in one transaction. Integer positions, unique order keys, advisory locks, row locks, and revision CAS make group/Idea order changes atomic. |
| **DB-30** | **Fixed in source + sealed DDL** | Independent operational roots permit omitted `workspace_id` exactly when `Require Workspace ID` is off; strict mode requires it, while parent-bound creates inherit one authoritative non-null parent workspace. OAuth, secondary, headless, and Telegram connection flows bind the initiating API-key ID and immutable initial grant, revalidate live enabled/unexpired/write authorization and membership/policy/workspace under transaction locks, require the effective scope in both initial and live grants, and deny before credential/lifecycle mutation. Inbox notes use immutable authenticated actor identity. SDK, dashboard, OpenAPI, schema, and tests agree. |
| **DB-31** | **Fixed in source + sealed DDL** | The schema requires at least one ad-audience identifier and has separate partial unique indexes for canonical email and phone hashes. |
| **DB-32** | **Fixed in source + sealed DDL; external contention proof remains** | RelayAPI allocation performs bounded PostgreSQL insert-on-conflict retries against normalized provider/code identity and writes KV only after a durable insert. Redirect resolution atomically increments and returns the exact built-in row, ignores KV-only ghosts, and repairs stale/missing cache entries. Focused contention/cache tests pass; a live PostgreSQL allocator-contention fixture remains an acceptance improvement. |
| **DB-33** | **Fixed in source + sealed DDL** | Platform-message identity is keyed by provider/platform account/message ID consistently in persistence, webhook dedupe, and schema uniqueness. |
| **DB-34** | **Fixed in source + sealed DDL; external plan proof remains** | Missing relationship and tenant-purge leading indexes are present and catalog-verified. Populated `EXPLAIN (ANALYZE, BUFFERS)` and lock-volume evidence has not been run. |
| **DB-35** | **Fixed in source + sealed DDL** | Broad organization/scope/platform composite FKs and parent-identity projection contracts are defined in `schema.ts`, `schema-contracts.ts`, and `provisioning-contracts.ts`, emitted into the sealed baseline, and checked against the disposable catalog. |
| **DB-36** | **Fixed in source** | Append-only comparison, PostgreSQL 18 CI, conservative `work_mem`, and `fetch_types: true` are implemented. The seed now requires `NODE_ENV=development`, an explicit destructive-action acknowledgement, and a loopback PostgreSQL URL before client creation; it reuses the user/organization, transactionally upserts dependent rows, defaults workspace enforcement off, and creates only a cancelled/free-safe entitlement. Guard/idempotency contract tests pass; no database was seeded during this audit. |
| **DB-37** | **Fixed in source** | Better Auth sets `disableOrganizationDeletion: true` in `packages/auth/src/index.ts`. |
| **DB-38** | **Decision** | No RLS remains an explicit trust posture. Organization/workspace query-shape tests, a no-DDL runtime role, and composite scope contracts are mandatory compensating controls. |
| **DB-39** | **Fixed in source** | Better Auth enables `account.encryptOAuthTokens`, covering login-provider access, refresh, and ID tokens at rest. |
| **DB-40** | **Fixed in source + sealed DDL** | Contacts have a generated canonical email, scoped canonical uniqueness, and canonical lookups in the contact linker and automation webhook receiver. |

### Workspace requirement semantics

`Require Workspace ID` is the only switch that prevents new organization-scoped operational roots:

- when enabled, an independent create with an omitted ID is a `WORKSPACE_ID_REQUIRED` validation error;
- when disabled, an omitted ID is valid and an independent operational root is organization-scoped (`workspace_id IS NULL`), including for a non-empty workspace-scoped credential;
- organization-scoped rows are shared with every non-empty workspace grant, while a zero-grant credential sees nothing;
- a parent-bound create inherits one authoritative non-null parent workspace before strict-mode validation, so the caller need not redundantly send it in either policy mode;
- a null parent cannot satisfy strict mode, and mixed parent scopes fail rather than selecting one;
- an explicit workspace must still be active, tenant-owned, and inside the credential's grants;
- an operation must never silently choose the first workspace in a grant array;
- enabling strict mode is blocked while active unscoped operational graphs remain.

The policy and visibility rules are implemented and covered in `apps/api/src/lib/request-access.ts`, `apps/api/src/lib/workspace-scope.ts`, the root-writer inventory, and focused policy tests. Parent inheritance is wired for posts (including bulk/import paths), threads, broadcasts, contacts (including bulk), auto-post rules, and ref URLs. The contract tests require those call sites, reject mixed parent scopes, and never choose an arbitrary workspace grant. New operational-root writers and authoritative parent relationships must be added to the machine-readable inventory.

### Connection-flow scope preservation

Long-running connection flows apply the same optional/strict semantics without trusting stale callback or bot state:

- OAuth, headless, secondary-selection, manual credential, and Telegram starts record the initiating API-key ID, the chosen workspace (including intentional organization scope), and an immutable snapshot of the initial workspace grant;
- immediately before the durable account write, the transaction re-reads an active organization and the initiating key, requires the key to be enabled, unexpired, write-capable, and—when it represents a dashboard user—backed by current membership, then re-reads the workspace policy and exact active tenant-owned workspace under shared locks;
- the effective account workspace must be authorized by both the immutable initial grant and the live grant, so a later grant expansion cannot enlarge an in-flight capability and a later revocation takes effect immediately;
- reconnect omission preserves an existing account's workspace rather than moving it to organization scope; an explicit conflicting workspace is rejected, and rotation of an existing identity requires both grants to authorize its actual scope;
- secondary-selection state is isolated by organization, platform, and operation token (`pending-secondary:{organization}:{platform}:{connect_token}`), and Telegram uses an expiring durable challenge carrying the same initiator/scope identity;
- authorization is revalidated before token encryption, credential rotation, lifecycle reactivation, or account-scope mutation.

The focused connection/workspace matrix passed 10 files and 101 tests. This proves repository behavior and denial ordering; it does not claim atomic single-use semantics for eventually consistent KV or replace live provider testing.

### Runtime gaps that schema constraints cannot close

- DB-02's durable effect fence cannot make a provider reconcilable when that provider exposes no stable idempotency lookup; those outcomes remain manual-safe rather than guessed.
- Repository configuration cannot prove the deployed Access/VPC path, backup contents, or restore readiness (DB-06/DB-20/DB-21).
- PostgreSQL 17.9 replay cannot stand in for the authoritative PostgreSQL 18 replay/restore gate.
- Source tests and an empty-catalog replay cannot establish production-cardinality query plans, lock behavior, provider limits, or crash convergence.

---

# P0 findings — original evidence and remediation notes

Unless a paragraph is explicitly labeled as a remediation update, the problem statements below describe the 2026-07-14 snapshot and intentionally preserve why each finding was filed. They are not claims about the current tree; use the remediation matrix for current status.

## DB-01 — Conditional critical — the migration squash is not an upgrade path

**Evidence**

- The working tree deletes `0000_robust_manta.sql` through `0041_hard_naoko.sql` and introduces `packages/db/drizzle/0000_baseline.sql`.
- `packages/db/drizzle/meta/_journal.json:4-10` and `migration-manifest.json` describe one migration.
- `packages/db/scripts/verify-migration-history.ts:155-170` deliberately rejects a database whose applied ledger is longer than the checkout or whose positional hashes/timestamps differ.

**Failure mode**

Any environment that applied the former chain has 42 ledger rows. This checkout expects one different row, so preflight fails before migration. That fail-closed behavior is good—it prevents silent corruption—but it proves this is a destructive re-baseline, not an incremental upgrade.

**Required decision**

- If any environment/data must survive, restore the historical chain and append a reconciliation migration; never rewrite the applied prefix.
- If this is a pre-launch destructive reset, inventory every local/staging/production database, back it up, restore-test the backup, recreate each database, apply the baseline, and explicitly document that old ledgers are unsupported.
- Add a CI fixture with the last released ledger so upgrade compatibility is tested instead of inferred.

**Acceptance gate:** an old-ledger fixture upgrades without destructive reset, or a signed environment inventory proves there are no supported non-virgin databases and records the recreation/restore evidence.

## DB-02 — High blocker — automation external effects are executed before an exclusive claim

**Evidence**

- `apps/api/src/services/automations/runner.ts:64-75` reads the run and current node.
- The node handler crosses provider boundaries at `:181-234`.
- The step row is written at `:237-254`, and the optimistic run-state update happens only afterward at `:256-382`.
- Duplicate trigger delivery uses the unique trigger occurrence to avoid a second run row, but the losing caller reloads the existing run at `:566-585`; both callers then invoke `runLoop` at `:621`.
- `packages/db/src/schema.ts:4855-4881` has no unique run/node/visit/effect key.

**Failure mode**

Two workers can read the same node and both send a message, webhook, comment, tag mutation, or HTTP action. Only one later state CAS wins. A crash after provider success but before the step/state write also leaves the same node replayable. The active-run and trigger-occurrence unique indexes prevent duplicate *run rows*, not duplicate *effects*.

**Required fix**

Claim a durable `(run_id, node_key, run_revision/visit)` execution before invoking a handler. Record provider idempotency keys and effect state (`pending → in_flight → succeeded/failed/unknown`) in a unique ledger. Atomically commit the step result and run transition where possible; reconcile ambiguous provider outcomes rather than replaying blindly.

**Acceptance test:** force two concurrent `runLoop` calls and crashes immediately before/after the provider response. Exactly one provider request may be made, and the run must converge without duplicate advancement or a permanently active node.

## DB-03 — High blocker — inbox mutations mix independently authorized accounts and conversations

**Evidence**

- `getAccount` validates only the caller-supplied account against organization and workspace (`apps/api/src/routes/inbox-helpers.ts:16-49`).
- Send-message then loads a local conversation by only `(conversation_id, organization_id)` (`apps/api/src/routes/inbox-feed.ts:692-727`; the WhatsApp branch is at `:933-1057`).
- There is no fence requiring `conversation.account_id = account_id`, matching platform, or conversation workspace in the caller's scope before provider I/O.
- The same independent lookup pattern affects typing (`:1112-1203`), reactions (`:1258-1502`), and message deletion (`:1553-1667`).

**Failure mode**

A key scoped to workspace B can supply B's valid account plus a known conversation from workspace A. The route reads A's recipient, sends through B's credentials, and can persist the outbound message into A's conversation. Organization scoping prevents cross-organization access, but workspace is an explicit authorization boundary in this product.

**Required fix**

Load the action target through one scoped join: message → conversation → social account. Require matching organization, workspace, platform, lifecycle status, and the supplied account ID before any provider call. Prefer deriving the account from the conversation rather than accepting both identifiers.

**Acceptance test:** a workspace-B key using a B account with an A conversation/message must receive 403/404, make zero provider calls, and write zero messages or state changes.

## DB-04 — High blocker — user deletion is internally inconsistent and can leave a live API credential

**Evidence**

- The profile UI invokes `authClient.deleteUser` (`apps/app/src/components/dashboard/pages/profile-page.tsx:293-309`), but `packages/auth/src/index.ts` does not enable Better Auth `user.deleteUser`; the installed endpoint rejects it.
- Admin deletion is exposed by the installed `admin()` plugin. Ordinary user references such as `invite_tokens.created_by`, `posts.created_by`, and `media.uploaded_by` use `NO ACTION`/default delete behavior (`packages/db/src/schema.ts:382-390,615,1098`), so users with normal history cannot be removed.
- When those blockers are absent, member rows cascade but `auth.apikey.referenceId` has no user FK and Better Auth's user deletion does not remove it.
- API-key auth validates the enabled key and active organization without requiring the referenced user or membership to still exist (`apps/api/src/middleware/auth.ts:78-109,142-166`).

**Failure mode**

Deletion either fails for ordinary users, or succeeds for a lightly used/sole owner while leaving an ownerless organization and an enabled API key that continues authenticating. The membership-removal revocation hook does not run for raw user deletion.

**Required fix**

Define a single user-deletion service. Before deleting identity rows, revoke/cache-invalidate every API key and session, resolve sole-owner organizations, anonymize or `SET NULL` nullable attribution, and explicitly handle non-null audit identities. Wire both profile and admin flows through it and either enable Better Auth self-delete with hooks or remove the misleading UI.

**Acceptance test:** delete a user with posts, media, invites, memberships, and API keys. The operation must complete or return a documented ownership conflict; every old key must fail immediately, no organization may be ownerless, and audit history must retain only the intended anonymized identity.

## DB-05 — High blocker — tenant deletion is complete but not scalable or resumable

**Evidence**

- `apps/api/src/services/tenant-deletion.ts:806-895` performs the entire database purge in one transaction: shared-ledger cleanup, 83 organization-table deletes, organization deletion, and job finalization.
- Cloudflare currently limits Hyperdrive statements to 60 seconds; over-limit statements are terminated ([Hyperdrive limits](https://developers.cloudflare.com/hyperdrive/platform/limits/)).
- Fifteen purge tables lack an organization-leading usable btree index: `auth.invitation`, `post_targets`, `publish_outbox`, `recycling_occurrences`, `webhook_deliveries`, `notifications`, `notification_preferences`, `auto_post_feed_items`, `custom_field_values`, `contact_channels`, `broadcast_recipients`, `automation_entrypoints`, `automation_bindings`, `automation_contact_controls`, and `contact_subscriptions`.
- Shared-ledger predicates use `${org} = ANY(organization_ids)` at `tenant-deletion.ts:832-856`. A populated PostgreSQL 17 `EXPLAIN` reproduced a sequential scan; `organization_ids @> ARRAY[org]::text[]` used the existing GIN index for `queue_failures`. `inbound_webhook_events` has no matching GIN index.

**Failure mode**

A large tenant can cause any one of the unbounded `DELETE` statements to exceed the query limit, rolling back the entire 83-statement transaction and preventing it from reaching `purged`. The number of statements alone does not violate the 60-second limit—the limit is per statement—but the all-or-nothing transaction also holds work/locks for its full duration. Repeated global scans increase lock time and impact other tenants.

**Required fix**

Make purge a resumable state machine with `(table, last_primary_key)` checkpoints and bounded batches/transactions. Add organization-leading indexes or delete high-volume children through indexed parent IDs. Rewrite array containment to the GIN-compatible form and add the inbound-event GIN index. Keep final organization deletion/job completion atomic only after all batches and external cleanup are complete.

**Acceptance test:** populate a representative large tenant plus unrelated tenants, interrupt every batch boundary, and prove bounded statement duration, resumability, no unrelated scans/locks, and zero surviving tenant-owned rows.

## DB-06 — High blocker — the production migration job has no demonstrated path to the private database

**Evidence**

- `packages/db/setup-postgres.sh:243-244` binds PostgreSQL to localhost and the firewall setup opens SSH only.
- Local repository instructions require an SSH forward (`.vscode/tasks.json:7-13`).
- `.github/workflows/deploy-api.yml:218-253` invokes the history verifier, Drizzle migration, and catalog verifier directly on a GitHub-hosted runner using `PRODUCTION_DATABASE_URL`, with no SSH forward, WARP, private runner, or client-side `cloudflared` step.
- Cloudflare documents that published non-HTTP/TCP applications require client-side `cloudflared`; TCP is transported over WebSocket via `cloudflared access tcp` ([published application protocols](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)). Hyperdrive's private connection is for Workers, not a raw PostgreSQL endpoint for Drizzle on GitHub.

**Failure mode**

Unless the secret points to a separate publicly reachable database—which would contradict the provisioned architecture—the required preflight/migration job cannot connect. This is a conditional topology finding because secret contents and deployed networking were not inspected, but the repository contains no coherent path.

**Required fix**

Provide a least-privilege migration path: a trusted private runner, short-lived SSH tunnel with pinned host key/deploy key, Workers VPC/private routing, or client-side `cloudflared`/WARP with Access service credentials. Test the path with a read-only preflight and document which endpoint `PRODUCTION_DATABASE_URL` represents.

---

# P1 findings — original evidence and remediation notes

## DB-07 — Automation message errors advance the flow as if delivery succeeded

`apps/api/src/services/automations/platforms/index.ts:254-272` catches provider failures into `errors[]`. `nodes/message.ts:97-159` includes that array in the payload but always returns `advance` or `wait_input`; it never returns `fail` when every required block failed. The runner then records a successful outcome. An interactive node can park waiting for a reply to a message that was never delivered. Treat zero successful required sends as failure/error-port, define partial-send semantics, and add a durable retry/outbox before parking.

## DB-08 — Scheduled automation recipient filters do not implement their declared logic

`apps/api/src/services/automations/scheduler.ts:713-777` flattens both `all` and `any` predicates and unions matches, ignoring predicate operators. An `all: [tag A, segment B]` schedule therefore enrolls A **or** B, which can send messages to unintended contacts. In addition, a page is marked effect-started before contacts are processed; one per-contact error can leave the whole page `unknown` and non-retryable (`:591-659`). Compile `all` as intersection and `any` as union, reject unsupported operators, snapshot/keyset the audience, and retry per deterministic contact occurrence after DB-02 is fixed.

## DB-09 — Remediated in source and sealed baseline — Broadcast state races

> Remediation update: the runtime and schema changes described here are present in the sealed virgin baseline and passed static contract and disposable-catalog verification. The paragraphs below explain the resolved race and remain as design evidence.

The surviving generic flow now commits immediate parent-and-recipient creation in one transaction. Recipient additions lock and revalidate the parent, insert exact organization/scope tuples, and advance the aggregate count and revision atomically. Update, delete, send, schedule, cancel, account-disconnect, and tenant-deletion transitions carry status/revision predicates; cancellation advances the revision, clears the lease, marks pre-boundary recipients `cancelled`, and freezes post-boundary recipients as `unknown` so no cancelled parent retains orphan `sending` rows.

The processor now claims a monotonically increasing parent lease token and revision, atomically claims recipient chunks, renews and proves the lease at every phase, and joins the exact active account organization/scope/platform tuple immediately before each provider chunk. Expired pre-request claims can retry; expired post-boundary claims become `unknown`. Finalization writes only while the same `sending` revision and lease remain current, and publishes realtime completion only when that guarded update succeeds. Canonical identifier hashes provide one durable recipient identity per exact broadcast scope.

## DB-10 — Remediated in source and sealed baseline — Retired WhatsApp-specific broadcast subsystem

> Remediation update: the sealed baseline and snapshot no longer create the legacy WhatsApp broadcast tables. This closes retirement for virgin databases; DB-01 still forbids treating the baseline as an upgrade for any database with the old 42-entry ledger.

The duplicate WhatsApp-specific tables, schema exports, routes, processor, cron task, SDK resource, dashboard proxies/tab, tests/mocks, and OpenAPI operations were removed. WhatsApp campaigns now use only the generic `broadcasts` and `broadcast_recipients` path. The retained bulk-send compatibility endpoint writes that generic graph transactionally and derives its scope from a locked active WhatsApp account. The generic campaign dialog now creates the draft, adds exact contact recipients, and only then calls the generic send/schedule action; WhatsApp accounts select an approved template instead of posting a text-only payload that the generic contract rejects.

All WhatsApp account lookups now require active lifecycle state. The generic processor revalidates account lifecycle, token version, tenant scope, and platform immediately before provider delivery, so disconnect/cancellation fences the next chunk and cannot be overwritten by late parent finalization.

## DB-11 — Post update/delete can race publishing; parent leases are fixed and not renewed

Post update and delete perform a status read and later write/delete without a version/state CAS (`apps/api/src/routes/posts.ts:2331-2523,2662-2684`). The scheduler can concurrently claim `scheduled → publishing`, and the publisher can cross the provider boundary (`scheduler.ts:41-80`; `publisher-runner.ts:746-794`). A route can therefore overwrite a publishing record or cascade its target/attempt/outbox rows while an external request is live.

Standalone and thread parent leases are fixed at 30 minutes and are not renewed by a heartbeat (`publisher-runner.ts:1370-1393`; `thread-publisher.ts:63-106`). If any provider operation can legitimately remain active beyond that window, reconciliation can invalidate its fence and prevent a later success from persisting; this lease-duration half is a conditional hardening concern because no execution longer than 30 minutes was reproduced. Add state/revision predicates to mutations, preserve external-effect history through deletion, forbid unsafe edits after claim, and either prove a bounded maximum provider duration or renew/model resumable operations.

## DB-12 — Workspace equality is not a graph invariant for contacts and dependents

Confirmed paths include:

- Contact merge authorizes source and target independently but does not require the same workspace, then reparents channels, custom values, recipients, conversations, automation runs/controls, segment memberships, and subscriptions (`apps/api/src/routes/contacts.ts:1776-1987`).
- Custom-field value routes load the contact by workspace but the definition only by organization/slug (`:2018-2189`).
- Segment add/remove validates contact and segment independently, not as one workspace tuple (`:1430-1535`).
- Phone/email/name contact matching is organization-wide and conversation linking does not enforce workspace equality (`apps/api/src/services/contact-linker.ts:20-105`; `inbox-persistence.ts:179-198`).

Most child FKs enforce only common organization, so these operations can durably cross-link workspaces. Require identical workspace for workspace-local relationships or implement an explicit graph move; for intentionally organization-global definitions, allow `definition.workspace_id IS NULL OR definition.workspace_id = contact.workspace_id`. Encode `(id, organization_id, workspace_scope_key)` composites where practical, using the Ideas scope-key pattern.

## DB-13 — Inbox AI omits caller workspace scope

Suggest/summarize routes pass only organization and conversation ID (`apps/api/src/routes/inbox-ai.ts:174-183,238-243`). The service calls `getConversationWithMessages` without the optional workspace scope (`apps/api/src/services/inbox-ai.ts:184-204,253-279`), even though the helper enforces it when provided (`inbox-persistence.ts:383-405`). A scoped key knowing another workspace's conversation ID can cause that content to be read and sent to the AI binding. Thread `c.get("workspaceScope")` through both routes/services and fail before loading messages.

## DB-14 — Automation binding/entrypoint/webhook contact resolution can bridge workspaces

- Entrypoint create validates related records, but PATCH accepts a new `socialAccountId` without the equivalent prospective-tuple validation (`apps/api/src/routes/automation-entrypoints.ts:507-523,655`).
- Binding PATCH independently checks organization records but permits an arbitrary/null workspace and does not validate the final automation/account/workspace tuple (`automation-bindings.ts:528-614`).
- Public automation webhook contact resolution searches email/phone/custom fields across the organization; platform-ID lookup omits the entrypoint account; auto-create defaults to the oldest organization workspace rather than the automation workspace (`services/automations/webhook-receiver.ts:188-370`).

The runner's later workspace check is a useful compensating control but produces wrong matches, unusable contacts, and retries. Validate the entire tuple transactionally and resolve/create strictly in the automation workspace and entrypoint account.

## DB-15 — Idea media durability (remediated in source)

`idea_media` is now an exact `(idea, organization, scope)` attachment to an exact `(media, organization, scope)` durable object; it no longer stores an unowned raw URL. Upload commits the core `media(status = 'uploading')` row and uniquely positioned attachment before R2. A failed PUT remains `upload_failed`; the scheduled upload reconciler uses R2 `HEAD` to finish accepted objects or atomically remove stale absent intents. An R2 success followed by a failed final DB write is therefore recoverable without URL inference.

Idea/attachment deletion first commits the existing two-object deletion tombstone, preserves upload/delete races with a delayed retry, and then performs best-effort provider cleanup. The scheduled deletion reconciler remains authoritative after request failure. Ready originals and durable thumbnails come from the shared media lifecycle, and converted attachments clear Idea ownership so deleting the Idea cannot remove post media. The schema and custom projection contracts are present in the sealed baseline; real PostgreSQL/R2 crash injection remains an external acceptance improvement.

## DB-16 — Usage quota and billing writers disagree on what one row means

There are three incompatible concerns in one `(organization_id, period_start)` `usage_records` row (`packages/db/src/schema.ts:1770-1808`): API calls, ordinary post creation, and scheduled generated posts.

- Middleware inserts `postsIncluded = callsIncluded` and atomically increments API calls in PostgreSQL (`apps/api/src/middleware/usage-tracking.ts:191-220`).
- Post creation uses `PRICING.proCallsIncluded` as the post allowance and the API-call per-thousand price for post overage (`routes/posts.ts:1833-1861`).
- Scheduled generation uses subscription `postsIncluded` and `pricePerPostCents` (`services/scheduled-post-usage.ts:18-103`).
- Free-plan enforcement uses non-atomic KV read-modify-write before the handler (`usage-tracking.ts:280-375`), while only successful responses reach the DB writer (`:383-415`). Concurrent requests lose increments; rejected/failed calls consume the KV quota but not the billing source of truth.

Split meters by explicit kind or make one authoritative transactional meter with immutable plan/rate snapshots. Decide whether attempts or successful operations consume quota, and project headers/notifications from that authority. Add concurrency, plan-change, failed-request, and scheduled/ordinary-post tests.

## DB-17 — Consent projection ordering, lifecycle, and boundary policy (remediated in source)

The original API accepted arbitrary `occurred_at`, so a far-future grant could freeze later real denials. The route and shared service now reject evidence more than five minutes ahead, while the schema checks the same row-relative five-minute allowance rather than contradicting it. Projection uses a server-assigned ingestion sequence; the caller timestamp remains immutable evidence but is no longer ordering authority.

Contact replacement and deletion now collect and deny retired/historical identifiers before detaching them, so a removed address cannot retain a grant and later authorize a raw-recipient send.

The product decision is explicit: compliance state and suppression are organization-global for exact `(organization_id, channel, purpose, identifier_hash)`. Event/state workspace columns remain provenance for the evidence that most recently drove the projection; they are not part of uniqueness or send authorization. A denial therefore blocks the same normalized recipient/channel/purpose across the organization, and a grant/denial in one workspace cannot coexist with the opposite state in another. Schema-introspection and authorization-source tests lock this rule.

Inbound discovery still does not silently grant marketing or automation consent. Reactive customer-service replies use the separate bounded inbound-conversation capability and honor organization-global `purpose = 'service'` suppression. This is the approved conservative contract, not an implicit broad grant.

## DB-18 — Raw inbound webhook payloads have no retention or tenant-safe redaction contract

`inbound_webhook_events.payload` stores the raw body as plaintext with no expiry column (`packages/db/src/schema.ts:2247-2300`), and no cleanup path was found. Failed/unrouted rows can have an empty `organization_ids` array and therefore cannot be associated with a later tenant purge. Shared-event tenant cleanup removes an organization ID but, unlike `queue_failures`, does not redact the raw payload (`tenant-deletion.ts:829-856`). Define provider-specific retention, minimize or encrypt raw bodies, expire completed/exhausted receipts, and redact shared payloads when any tenant scope is removed.

## DB-19 — Stripe invoice/dunning invariants can reject valid events or postpone enforcement

`invoices` is unique both by Stripe invoice ID and `(organization_id, period_start)` (`packages/db/src/schema.ts:1892-1927`). If Stripe emits multiple invoices/prorations with the same period start for one organization, the second can conflict even though webhook upsert targets only `stripe_invoice_id` (`apps/api/src/routes/stripe-webhooks.ts:329-356`); this collision is product/event-shape dependent and should be reproduced with fixtures. Independently and conclusively, every non-draft invoice event rewrites `finalizedAt` to local processing time, while dunning calculates age from that field (`services/dunning.ts:38-83`), so repeated failure events reset the 1/7/14-day clock.

Finally, dunning uses select-before-send-before-insert and has no unique `(invoice_id, event)` constraint (`dunning.ts:50-150`; `schema.ts:1934-1954`). Overlapping crons can duplicate rows and cancellation calls; email idempotency only partially mitigates this. Use Stripe's immutable finalized/first-failure timestamp, model invoice identity independently of usage periods, and claim each logical dunning event with a unique outbox record before external work.

## DB-20 — Provisioning does not match current private-Hyperdrive security requirements

`packages/db/setup-postgres.sh:577-674` creates a published TCP tunnel/DNS record but no Access application or Service Auth token, then prints a Hyperdrive connection with a port and no Access client credentials. Current Cloudflare guidance says a private Tunnel path must be protected by Access Service Auth; manual Hyperdrive creation supplies `--access-client-id` and `--access-client-secret` and omits the port. Workers VPC is the recommended alternative ([private database via Tunnel](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/), [Workers VPC](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database-vpc/)).

The same script asks for an arbitrary SSH port, resets UFW and opens only that port (`:59,117-124`), but never changes `sshd` to listen on it (`:134-168`). Choosing a non-22 value can lock out the operator; `ufw reset` also destroys unrelated rules. Provision Access/VPC explicitly, preserve firewall state, configure and verify a second SSH listener before closing the old port, and include a tested rollback path.

## DB-21 — Database role, setup input, and backup design violate the script's own safety claims

- The same PostgreSQL role becomes database owner/schema creator/migrator and Worker runtime user, with schema `CREATE` (`setup-postgres.sh:315-350,672-674`). A runtime credential compromise can alter/drop application objects. Split owner, migrator, and no-DDL runtime roles.
- Operator-provided passwords/identifiers are interpolated directly into SQL/config/API JSON (`:315-350`); an ordinary quote can abort a partially completed server setup. Validate identifiers and pass/quote values through safe psql mechanisms.
- AWS CLI installation failures are swallowed; generated backup uses `set -e`, making its later `$?` branch unreachable; setup performs no upload/checksum/restore test (`:416-492`). A deployment boolean is not restore evidence. Fail closed and rehearse a restore.
- Printed instructions name `wrangler.toml`, port 5432, `DATABASE_URL`, and a package-local `bun run db:migrate`, while this repo uses `wrangler.jsonc`, local port 5433, the Hyperdrive local override, and package script `migrate`. The printed command was executed and failed with `Script not found "db:migrate"`.

## DB-22 — Migration-before-deploy requires an explicit expand/contract policy

The manual production workflow applies migrations while the old Worker still serves traffic, then deploys new code (`.github/workflows/deploy-api.yml:239-257`). If deploy or smoke checks fail, comments explicitly decline automatic rollback because the old code may not be compatible (`:292-298`). Any destructive rename/drop/semantic contract change can break the old live Worker during the gap and indefinitely after a failed deploy. Enforce expand → compatible deploy/backfill → contract across releases, lint/block destructive migrations in the pre-deploy phase, and retain a tested forward-recovery runbook.

Remediation update: `docs/DATABASE_MIGRATION_AND_FORWARD_RECOVERY_RUNBOOK.md` now defines the virgin boundary, compatible expand/deploy/backfill/contract sequence, forward-only failure handling, stop conditions, and release evidence. CI/deploy enforce an append-only manifest prefix, contiguous and strictly ordered journal identity, exactly one immutable baseline phase, reviewed later `expand`/`contract` phases, a contract marker, and conservative destructive-SQL rejection for expand migrations. The baseline builder has exclusive-write/crash-recovery guards and is now sealed. Repository tooling is complete; the outstanding evidence is an actual multi-release exercise, not a missing policy or runbook.

## DB-23 — Cross-post actions can choose a foreign workspace or wrong publisher/account pair

Post creation validates cross-post target accounts by organization, not post/caller workspace (`apps/api/src/routes/posts.ts:1988-2033`). The processor picks an arbitrary published source target with `.limit(1)`, loads the target account separately, then chooses the publisher from the source platform while supplying target-account credentials (`services/cross-post-processor.ts:219-355`). A multi-platform post can pair a Facebook source/publisher with Twitter credentials, and a scoped caller can schedule through another workspace account. Store an explicit source target/platform and require source post, target account, action platform, organization, and workspace to match. Also separate readiness polling from provider attempts; current not-ready polls consume the finite attempt budget (`:71-125,219-242`).

---

# P2 findings — original evidence and remediation notes

## DB-24 — Database state and numeric invariants are mostly TypeScript-only

> Original 2026-07-14 evidence: the then-current baseline contained zero `CHECK` constraints. The current sealed baseline no longer has this condition.

The original schema had 19 PostgreSQL enums, but dozens of other state fields used Drizzle `text(..., { enum: [...] })`; that option is a TypeScript type hint and generated ordinary unconstrained `text`. There were 35 columns literally named `status`, in addition to `state`, `delivery_state`, `phase`, `outcome`, and related fields.

Invalid state written by SQL, a migration, a buggy worker, or an older binary can be invisible to sweepers that query only known values. Highest-risk examples are tenant deletion, account revocation, inbound receipts, broadcast recipients, automation jobs, billing operations, and WhatsApp provisioning. Numeric invariants are likewise absent: attempts/counts/costs/durations can be negative, and period end can precede start.

Add targeted checks for stable workflow states and invariants (`attempts >= 0`, counts/costs nonnegative, `period_end > period_start`, valid null/state combinations). Use PostgreSQL enums only where the value set is genuinely stable; use `CHECK ... NOT VALID` plus data validation for evolving production tables.

Remediation update: a schema-wide machine audit now classifies 262 durable workflow-state and high-risk numeric candidates. It reports 253 covered by `CHECK`, 6 by PostgreSQL enum, 3 by documented exception, and 0 missing; it also fails when an exception becomes stale or a new unconstrained candidate appears. Static schema-contract verification and disposable-catalog verification confirm the generated constraints. Domain-specific state-transition tests and populated production-data validation remain complementary gates.

## DB-25 — Thread structure is implicit and can represent impossible graphs

`posts.thread_group_id`, `thread_position`, and `thread_delay_ms` have no constraints (`packages/db/src/schema.ts:635-637`). There is no rule that group and position are both null or both present, no nonnegative delay/position check, and no unique `(organization_id, thread_group_id, thread_position)`. `thread_executions.thread_group_id` is a standalone global primary key rather than a composite relationship to a thread parent. The publisher orders/advances positions and therefore assumes these invariants. Introduce an explicit thread parent or at minimum null-pair, nonnegative, and partial unique constraints; test duplicate/gapped/malformed positions.

## DB-26 — Inbox message insertion and conversation projection are not atomic

`apps/api/src/services/inbox-persistence.ts:217-240` inserts/deduplicates a message. Conversation preview, message count, unread count, and timestamps are updated separately at `:249-281`. A crash after insert leaves stale derived state; retry conflicts on the message and returns at `:244-246`, permanently skipping repair. Use one transaction/CTE or make the conflict path reconcile the projection. Add a periodic consistency query if counters remain denormalized.

## DB-27 — Segment and membership derived invariants drift

- `auth.member` lacks unique `("userId", "organizationId")` (`packages/db/src/schema.ts:195-214`). Application-side already-member checks are raceable; duplicate rows distort owner/free-organization counts and authorization. Add the unique constraint after dedupe.
- Free-organization enforcement is a select-then-create hook with an acknowledged TOCTOU (`packages/auth/src/index.ts:170-185`); simultaneous creates can exceed the cap. If it is a billing invariant, serialize it with a transaction/advisory lock.
- `segments.member_count` is updated separately from membership rows (`apps/api/src/services/segment-memberships.ts:112-188`), automation segment actions do not update it (`services/automations/actions/segment.ts:28-58`), and contact merge/delete cascades bypass it. Derive the count, maintain it in the same transaction/trigger, or reconcile it.
- Notification/user/organization pairs are not backed by membership identity, so application validation is the only guarantee that a notified user still belongs to the tenant.

## DB-28 — Account workspace reassignment changes the parent but not its graph

`apps/api/src/routes/accounts.ts:777-824` changes only `social_accounts.workspace_id`. Conversations, contact channels, broadcasts, automation entrypoints/bindings, post targets, and other children retain their prior workspace identity; most FKs guarantee only organization equality. The route requires an all-workspaces key, which is a useful authorization control, but the resulting graph can still be internally contradictory. Either prohibit reassignment while dependents exist or implement one explicit, transactional graph move with a dry-run inventory.

## DB-29 — Ideas conversion/default-group/order atomicity (remediated in source)

- Conversion requires a stable organization-scoped idempotency key and expected Idea revision. An advisory key fence plus unique operation identities serialize cross-Idea key reuse. One transaction inserts the draft, copies only ready retained originals into `_media`, links the exact-scope post, transfers attachment lifetime, writes activity, and marks the operation succeeded; a replay returns the same post.
- Organization provisioning creates the global `Unassigned` group, legacy backfill fills only missing defaults, and a partial unique `(organization_id, scope_key) WHERE is_default` is the final race fence. GET is read-only; write fallback uses an advisory lock and conflict-safe insert.
- Group and Idea positions are nonnegative integers with exact-scope unique indexes. Create/upload allocation, move, delete, and reorder use deterministic advisory locks plus transactions. Two-phase temporary positions avoid immediate-unique collisions, while revision CAS makes stale client writes return `409`.
- Relation validation takes key-share locks, group deletion moves all Ideas and deletes the group in one transaction, and group delete/reorder use one lock order to avoid a cycle. The source, SDK, dashboard, sealed baseline, and verified disposable catalog agree.

## DB-30 — Operational creation and authenticated note attribution (remediated in source)

The operational-create resolver now makes `Require Workspace ID` the only policy that forbids a new organization-scoped operational root. Optional mode permits organization scope; independent strict-mode creates require an ID; parent-bound routes first inherit one authoritative non-null parent scope in either mode. Explicit IDs remain active/tenant/grant validated. Ref URL relationships and authorization-before-mutation are hardened.

Inbox-note identity is no longer supplied by the client. Strict create/update bodies accept only `text`, delete has no actor query, and the route derives `dashboard_user/principal_id` or `service/api_key_id` from authenticated context. The note stores immutable `actor_type`/`actor_id`; `user_id` is nullable display attribution with `ON DELETE SET NULL`. Update/delete compare the authenticated actor before mutation and repeat the exact actor predicate in the write. The SDK and dashboard no longer transmit `user_id`, and the UI exposes delete only for the matching dashboard actor. These columns and constraints are present in the sealed baseline.

Connection writers carry the initiating API-key ID and immutable initial workspace grant through OAuth, headless/secondary, manual, and Telegram flows. The mutation transaction revalidates the live enabled/unexpired/write key, dashboard membership where applicable, organization policy, and active tenant workspace under locks. Both the initial and live grants must authorize the effective existing/new account scope; reconnect omission preserves an existing workspace and an explicit mismatch cannot silently move it. Scope denial happens before credential rotation or lifecycle reactivation.

## DB-31 — PostgreSQL `NULL` uniqueness is wrong for ad audience identities

`ad_audience_users` uniquely indexes `(audience_id, email_hash, phone_hash)`, while both hashes are nullable (`packages/db/src/schema.ts:3693-3718`). In PostgreSQL, `NULL` values are distinct, so repeated email-only or phone-only rows do not conflict, and a both-null row is allowed. Add an at-least-one-identifier check and partial unique indexes for email and phone (or an intentional `NULLS NOT DISTINCT` design).

## DB-32 — Database-authoritative short-link identity and allocation (remediated in source)

The source schema now uniquely identifies both `(provider, short_code)` and `short_url`. The built-in allocator proposes a code, inserts the complete durable row with `ON CONFLICT DO NOTHING`, and retries when another allocator wins; no KV availability check participates in identity. KV is written only after PostgreSQL accepts the exact code/target, and cache failure cannot create a ghost authority.

Redirects update-and-return the exact `provider = 'relayapi' AND short_code = ?` row, making the click increment and target resolution one PostgreSQL statement. A missing durable row is 404 even if KV contains a ghost; missing or stale KV is repaired from the returned DB target. Manual shortening does not insert the already-durable built-in result twice, and post shortening attaches the existing exact rows to the new post while third-party results retain their local insert path. In-memory contention/cache tests cover allocator losers, concurrent exact-code clicks, cache misses, and KV ghosts. The exact identities are present in the sealed baseline; a live PostgreSQL allocator-contention fixture remains an acceptance improvement.

## DB-33 — Platform-message dedupe has a global-key mismatch

The schema's durable uniqueness is `(conversation_id, platform_message_id)`, but webhook dedupe queries only `platform_message_id`, and outbound KV uses a global `outbound-mid:${mid}` key (`apps/api/src/routes/platform-webhooks.ts:540-608`; `packages/db/src/schema.ts:2233-2237`). If provider message IDs are only account/page scoped, one tenant/account can suppress another. Key all dedupe by provider + social account + platform message ID (and organization/conversation where required).

## DB-34 — Missing relationship/index coverage makes integrity operations expensive

Beyond the tenant-purge indexes in DB-05, several FK paths lack a supporting leading index and can force child-table scans during parent update/delete:

- `webhook_deliveries.webhook_id`;
- `automation_runs.entrypoint_id`, `binding_id`, and `conversation_id`;
- `automation_scheduled_jobs.automation_id` and `entrypoint_id`;
- `auto_post_feed_items.post_id`;
- `recycling_occurrences.post_id`;
- `post_tags.tag_id` (the PK begins with `post_id`).

Add indexes based on real parent-delete volume, prioritizing webhook and automation ledgers. Validate with populated `EXPLAIN (ANALYZE, BUFFERS)`, not only catalog existence.

## DB-35 — Several relationships enforce organization but not workspace/platform compatibility

> Original 2026-07-14 structural review list. The current composite/projection contracts are summarized in the matrix and verified against the sealed disposable catalog.

The following is a structural review list, not a claim that every route is currently exploitable. Application code supplies compensating checks for some paths, but direct SQL, future code, and incomplete update routes can create invalid tuples.

| Relationship family | Missing invariant |
|---|---|
| `post_targets`, cross-post actions, external posts | Account/post workspace and declared platform must agree with the social account. |
| Inbox conversations/messages | Conversation account, workspace, and platform must agree; messages derive that scope. |
| Contact fields, segment memberships, subscriptions | Contact and definition/segment/list workspace must agree. |
| Automation scheduled jobs/runs/bindings/entrypoints | Automation, account, contact, conversation, and workspace must form one tuple. |
| AI agents/knowledge bases | Agent, knowledge base, and workspace should be organization/workspace consistent. |
| Ads, boosts, sync state/logs | Ad/social account and post/workspace/platform ownership should be composite. |
| Short links, QR/ref URLs, signatures/templates | Referenced post/automation/workspace should share tenant scope. |
| WhatsApp phone rows and generic WhatsApp broadcasts | Account, organization, workspace, scope key, and platform must agree. |

Where nullable organization-global scope is intentional, use a generated scope key such as `coalesce(workspace_id, '__organization__')` and composite unique/FKs. Where the child can derive workspace/platform, prefer not storing a second independently mutable copy.

## DB-36 — Migration and provisioning gates prove current consistency, not all release invariants

> Original 2026-07-14 evidence follows. The remediation update after the list is authoritative for repository state.

- `--write-manifest` can regenerate hashes for an edited historical migration; CI compares the regenerated current text to the committed current manifest, not to the merge-base/released prefix. Enforce append-only history against `main` or a protected release artifact.
- Production setup targets PostgreSQL 18, while migration CI and deploy disposable gates use PostgreSQL 17. Align on the production major or matrix 17/18 with 18 authoritative.
- `work_mem = total RAM / 100` combined with 100 connections and parallel workers can multiply into host OOM. Keep global `work_mem` conservative and tune analytic jobs per session.
- `scripts/seed.ts` now checks `NODE_ENV=development`, an exact acknowledgement string, a PostgreSQL protocol, and a loopback host before constructing the client. It reuses the normalized-email user and slugged organization, transactionally upserts membership/settings/subscription, preserves a previously changed workspace policy on rerun, and inserts only a cancelled/free-safe subscription with AI disabled. The guard is unit-tested; the seed was not run against a database during this audit.
- `createDb` sets `fetch_types: false` even though the schema uses PostgreSQL arrays. Cloudflare says to disable type fetching only when arrays are not used ([Postgres.js with Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/)). Drizzle's declared array selects currently decode correctly and no failing raw-array query was found, so this is a latent footgun rather than an active defect.

Remediation update: append-only verification compares the protected manifest prefix from an explicit, available base commit and fails closed in CI; journal and policy tests enforce strict identity and phase boundaries; both migration CI and the deploy disposable gate use PostgreSQL 18; global `work_mem` is conservative; `fetch_types` is enabled; and the guarded, idempotent seed defaults `Require Workspace ID` off and creates no active paid entitlement. PostgreSQL 18 production restore and live provisioning evidence remain external.

---

# P3 hardening and explicit non-findings — original evidence and remediation notes

## DB-37 — Better Auth's alternate organization-delete route should be explicitly disabled

The organization plugin is configured without `disableOrganizationDeletion: true` or a delete hook (`packages/auth/src/index.ts:164-208`), so installed Better Auth exposes `/organization/delete`. However, an independent permission check confirmed that owner, admin, and member roles all lack the required `organization:delete` permission; normal callers are currently denied. This is **not an active deletion bypass** in the reviewed tree.

Still disable the route and add a regression test. Otherwise a future role permission change silently activates a direct adapter deletion that bypasses RelayAPI's durable `requestTenantDeletion` cleanup.

Remediation update: Better Auth now sets `disableOrganizationDeletion: true`; organization erasure remains on RelayAPI's durable deletion path.

## DB-38 — No row-level security is a deliberate trust posture, not automatically a bug

The baseline enables no RLS policies. RelayAPI relies on API middleware, organization predicates, workspace-scope helpers, and composite FKs. This can be reasonable for a single tightly controlled runtime role, but it means one missed predicate has full cross-tenant blast radius. DB-03/DB-13 demonstrate that application-only scoping can be missed. If RLS is not adopted, maintain query-shape tests and composite scope constraints as mandatory release gates; if it is adopted, introduce it incrementally with separate migrator/runtime roles and explicit background-worker policies.

## DB-39 — Better Auth OAuth tokens have no RelayAPI encryption hook

`auth.account.accessToken`, `refreshToken`, and `idToken` are ordinary text columns. The custom `social_accounts` integration credentials are encrypted, but no custom at-rest encryption hook was found for Better Auth login-provider tokens. This may be an accepted Better Auth/database-disk-encryption trust decision; document it, minimize scopes, restrict DB/log access, and verify whether application-layer encryption is compatible with Better Auth before changing it.

Remediation update: Better Auth now enables `account.encryptOAuthTokens`, covering login-provider access, refresh, and ID tokens at rest.

## DB-40 — Email identity is not canonicalized consistently

Contact workspace/email uniqueness uses the raw email while consent hashing normalizes it. `Alice@example.com` and `alice@example.com` can be separate contacts sharing one consent/suppression identity. Store a canonical email alongside display/original form and use it for uniqueness, lookup, and consent identity.

Remediation update: contacts now have a generated canonical email, exact-scope canonical uniqueness, and canonical lookups in contact linking and automation webhook resolution; the sealed baseline contains the generated column and indexes.

---

# Original schema-wide observations — historical design context

## Tenant model

The effective hierarchy is:

```text
auth.organization
└── public.workspaces (optional scope for many resources)
    ├── social accounts → post targets / inbox / broadcasts / automations
    ├── contacts → channels / consent / fields / segments / runs
    ├── posts → targets / attempts / outbox / analytics / media URLs
    └── ideas / tags / groups / templates / AI / ads
```

`organization_id` is generally authoritative. `workspace_id` is a secondary authorization boundary but is nullable on many organization-global resources. The strongest pattern is a composite FK containing both the resource ID and organization ID, plus a generated workspace scope key where `NULL` has semantic meaning. The weakest pattern is independently stored `organization_id`, `workspace_id`, platform, and parent IDs with only simple FKs; these columns can each be valid while their combination is impossible.

The recommended rule is: **validate and constrain the tuple, not each ID separately**. For each child, either derive organization/workspace/platform from the parent, or reference a parent composite unique key that includes every stored scope discriminator.

## Deletion model

There are three distinct deletion semantics and they should remain explicit:

1. **ordinary child cleanup** through FK cascade/set-null;
2. **external account/resource revocation** through durable operations and ambiguous-outcome reconciliation;
3. **tenant/user erasure** through a resumable orchestration that revokes credentials, handles external providers/storage, then removes/anonymizes database data.

Current bugs arise when a framework's direct delete or an ordinary cascade is used for category 2/3. Better Auth user deletion, legacy broadcast deletion, post deletion during provider work, and Idea media deletion all need lifecycle services rather than bare row deletion.

## State-machine model

The repository often models provider uncertainty correctly with `in_flight`, `unknown`, lease tokens, operation IDs, and reconciliation. The inconsistent areas share one pattern: the database is updated **after** the external effect without a pre-effect fence or durable effect row. Automation nodes, dunning, some broadcast transitions, and Idea/R2 operations should reuse the established publish/billing/outbox patterns rather than inventing one-off sequences.

## Derived data model

The following values are caches/projections, not independent facts:

- inbox conversation counts/preview/unread;
- segment `member_count`;
- broadcast parent recipient/sent/failed/delivered/read counts;
- automation aggregate counters;
- usage overage totals/costs;
- post metrics snapshots.

Every derived value needs exactly one of: transactional maintenance with its source row, database trigger/generated query, or an explicit reconciliation job. Currently inbox, segments, and some broadcast/usage fields have multiple or non-atomic writers.

---

# Original recommended remediation order — historical

The waves below preserve the 2026-07-14 prioritization and explain the order in which the repository remediations were approached. They are not the current to-do list: their source and virgin-artifact work is represented by the authoritative status matrix above.

## Wave 0 — resolve release identity and close direct authorization/effect blockers

1. Decide DB-01: incremental migration chain versus destructive virgin reset.
2. Land DB-02's node/effect ledger DDL and complete its real-database crash/provider-reconciliation acceptance; keep DB-07 delivery error semantics.
3. Replace inbox account/conversation/message lookups with one workspace/platform/account-scoped join (DB-03) and pass workspace scope into Inbox AI (DB-13).
4. Centralize user deletion, revoke API keys/cache first, and enforce owner succession (DB-04).
5. Establish and exercise the production migration network path (DB-06).

## Wave 1 — make destructive and provider flows recoverable

1. Batch/checkpoint tenant deletion and add purge indexes/GIN predicates (DB-05).
2. Fence broadcast parent/account state and create parent+recipients atomically (DB-09/DB-10).
3. CAS post mutation against publish state and renew leases (DB-11).
4. Apply the reconciled DB-15/DB-29 Idea media/order/conversion DDL and run the real-PostgreSQL contention fixture.
5. Fix provisioning Access/SSH/roles/backups and expand/contract deploy sequencing (DB-20–DB-22).

## Wave 2 — enforce workspace graph consistency and billing authority

1. Add same-workspace checks/composites for contact, automation, account, inbox, cross-post, and related graphs (DB-12/DB-14/DB-23/DB-28/DB-35).
2. Split or redesign usage meters and freeze rate/allowance snapshots (DB-16).
3. Correct Stripe invoice/dunning identity and claims (DB-19).
4. Land and replay the DB-17 organization-global consent identity and timestamp-check DDL.
5. Define inbound payload retention/redaction (DB-18).

## Wave 3 — constraints, reconciliation, and operational polish

Reconcile the generated DDL for targeted state/numeric/thread constraints, note actors, consent and ad/short-link uniqueness, missing FK indexes, derived-state reconciliation, default-group uniqueness, and canonical email. Retain append-only migration CI, PostgreSQL 18 testing, the guarded seed/tuning defaults, and the explicit hardening controls in DB-24–DB-40.

## Remaining acceptance order — 2026-07-15

1. Produce a signed inventory proving that no supported persistent environment carries the superseded 42-entry ledger; otherwise back up, checksum, restore-test, and deliberately recreate each affected pre-launch environment. Do not rewrite or infer its ledger.
2. Replay the sealed baseline on disposable PostgreSQL 18, repeat the no-op/history/catalog/behavior checks, then restore a real backup into isolated PostgreSQL 18 and run the same verification plus application smoke tests.
3. Exercise a read-only preflight and disposable migration through the exact production Access/VPC runner, TLS settings, secrets, and migrator role.
4. Rehearse provisioning and rollback on the intended host/network, including preservation of SSH/firewall state and validation that the runtime role has no DDL authority.
5. Run representative large-tenant deletion/load plans, allocator/billing/provider concurrency, and crash-boundary reconciliation fixtures with production-like cardinality and provider limits.
6. Exercise one real expand → compatible deploy → bounded backfill → later contract sequence and record the forward-recovery evidence required by the runbook.

The sealed baseline must not be destructively rebuilt to satisfy any of these gates. Future schema changes are append-only expand/contract migrations.

---

# Required regression and release gates

The following tests would materially close the gaps; table-existence tests alone will not.

| Gate | Required scenario |
|---|---|
| Migration continuity | Verify a signed supported-environment inventory that excludes the superseded 42-entry ledger, or deliberately back up, restore-test, and recreate each affected pre-launch environment. The sealed baseline is not an upgrade path. |
| Production-major replay | Apply the sealed baseline twice on disposable PostgreSQL 18; require 1/1 history, exact catalog/contracts, provisioning behavior, optional organization scope, parent inheritance, and strict-mode rejection. |
| Expand/contract exercise | Apply one reviewed expand migration with old code live, complete a bounded resumable backfill, deploy compatible code, then apply a separately reviewed contract migration in a later release and exercise forward recovery. |
| Automation fencing | Two concurrent workers plus crashes before/after every provider boundary; assert one durable effect and one provider idempotency key. |
| Workspace mutation matrix | For every inbox/contact/automation/broadcast action, combine A-resource IDs with a B-scoped key/account and assert no read, write, or provider call. |
| User deletion | Delete sole/non-sole owners with posts/media/invites/API keys and verify key/cache revocation, ownership, audit anonymization, and idempotent retry. |
| Tenant purge scale | Large tenant + unrelated tenants, populated query plans, forced interruption at each batch, bounded statements, complete resume. |
| Broadcast crash matrix | Parent creation, recipient insert, claim, provider request, cancellation, disconnect, result persistence, and finalization interruption points. |
| Publish mutation race | Concurrent schedule claim with update/delete; long-running upload beyond lease; success must persist or become a reconcilable unknown without duplicate send. |
| Billing concurrency | Bursty free quota, failed requests, plan changes, scheduled plus ordinary posts, multiple invoices in one period, overlapping dunning crons. |
| R2 lifecycle | Idea/core media create, DB failure, R2 failure, lifecycle original deletion, explicit delete, tenant delete, and reconciler convergence. |
| Catalog/invariants | On PostgreSQL 18, re-run exact catalog comparison and populate invalid-state/negative/thread/workspace-mismatch fixtures to prove the sealed constraints reject them. |
| Private migration path | Read-only history/catalog check from the exact protected runner/network identity used for production, followed by a disposable migration rehearsal. |
| Restore readiness | Produce backup, checksum it, restore into isolated PostgreSQL of the production major, run exact catalog/history and application smoke tests. |

---

# Original validation performed — 2026-07-14 audit snapshot

| Check | Result |
|---|---|
| `bun run typecheck:db` | **PASS** |
| `bun run typecheck:auth` | **PASS** |
| `cd apps/api && bun run tsc --noEmit` | **PASS** |
| `bunx biome lint packages/db packages/auth` | **PASS** — 16 files |
| `bun run db:migration-manifest` | **PASS** — one reviewed entry |
| Fresh generated Drizzle SQL versus committed baseline | **PASS** modulo intentional schema/extension preamble and statement ordering/newline differences |
| Disposable PostgreSQL 17 first baseline application | **PASS** |
| Disposable PostgreSQL 17 second migration application | **PASS / no-op** |
| `db:verify` against disposable PostgreSQL 17 | **PASS** — 101 public + 8 auth tables, `pg_trgm`, expected ordinary `automation_step_runs` |
| Live history verifier against disposable PostgreSQL 17 | **PASS** — 1/1 |
| Focused API suites | **PASS** — 8 files, 157 tests, 0 failures |

The focused API set was: billing flows/operations/policy, Ideas tenant relations, scheduled generator reliability, tenant isolation, usage tracking, and workspace deletion minimization. These passing checks support the strong controls described earlier; they do not simulate the concurrency, crash, or mixed-workspace-ID scenarios in the open findings.

## Remediation validation update — 2026-07-15

| Check | Result and evidentiary limit |
|---|---|
| Deterministic virgin artifact | **PASS.** `baseline:rebuild:check` reproduced `0000_baseline.sql`, snapshot, journal, policy, manifest, preamble, and generated custom SQL from `schema.ts`; baseline SHA-256 is `e51b5011b87fd41a5bbd936ad4b2efe864b02a9448db841d453c6042fe5890db`. `baseline:sealed:check` passed and write mode refused the sealed lifecycle. |
| Baseline-builder contract suite | **PASS — 13 tests, 0 failures.** Covers deterministic composition, duplicate/missing contract rejection, complete sealed-policy identity, write confirmation, locking, verified replacement, and rollback behavior. Portable directory rename is still explicitly documented as not power-loss atomic. |
| Migration-history/policy contract suite | **PASS — 12 tests, 0 failures.** Covers strict journal order/identity, the single-baseline boundary, later expand/contract phases, unknown phases, and comment-obfuscated destructive-expand detection. The protected manifest also hashes historical snapshots and journal metadata, and the mutating runner rechecks every ledger hash under its migration advisory lock. |
| Static manifest/policy/schema contracts | **PASS.** One reviewed migration; 60 scope/provisioning contracts; 111 `public` tables; 262 invariant candidates with 253 `CHECK`, 6 PostgreSQL-enum, 3 documented-exception, and 0 missing decisions. |
| Disposable PostgreSQL 17.9 replay | **PASS.** First migration applied, second run was a no-op, live history was 1/1, and exact catalog verification found 111 `public` plus 9 `auth` tables, `pg_trgm` in `public`, all checks/FKs/indexes/triggers, and ordinary `automation_step_runs`. This is not PostgreSQL 18 evidence. |
| Disposable behavior transaction | **PASS.** Organization insert provisioned settings, active `General` workspace, and default `Unassigned` Idea group; optional mode accepted an independent `workspace_id IS NULL` row; a parent-bound broadcast inherited its account workspace; strict mode rejected an independent null-workspace row with `check_violation` and persisted nothing. The transaction was rolled back. |
| Full monorepo type check | **PASS.** Database, auth, SDK build, MCP, API Worker types/TypeScript, dashboard, docs, CLI, n8n, Zapier, and published integrations compiled together. |
| Full isolated API suite | **PASS — 121 files, 1,107 tests, 0 failures.** This includes billing/media/mock regressions as well as the schema/flow remediations; DB-fixture suites still depend on their documented fixture availability. |
| Focused connection/workspace matrix | **PASS — 10 files, 101 tests, 0 failures.** Covers credential writes, auth, OAuth, secondary/headless state, Telegram scope, optional/strict policy, deletion minimization, and cron/deletion ordering. It is not a live provider fixture. |
| Dashboard suite | **PASS — 229 tests, 0 failures.** Confirms the updated SDK/dashboard contracts and workspace behavior. |
| OpenAPI and generated docs | **PASS — deterministic spec with 377 operations across 45 tags.** Workspace policy, note actors, consent behavior, and connection inputs are represented in generated API documentation. |
| Production Access/VPC migration connection | **NOT RUN.** Required deployed secrets and external topology were not inspected or mutated. |
| Local PostgreSQL 18 replay | **NOT RUN.** PostgreSQL 18 is configured as the authoritative CI/deploy migration service, but no local PostgreSQL 18 server or container was available for this audit. |
| Backup checksum and isolated PostgreSQL 18 restore rehearsal | **NOT RUN.** Backup operation and restore evidence are explicitly external to this repository. |

The artifact and source checks close the previous baseline-dependent portions of DB-02, DB-09/10, DB-12, DB-14–19, DB-23–25, DB-27–35, and DB-40. They do not close DB-01's environment cutover decision, DB-06/20/21's deployed topology and disaster-recovery evidence, DB-22's real multi-release exercise, or the load/provider/crash acceptance limits called out in the matrix.

## Final assessment

The source model and sealed virgin artifact are now coherent: organization ownership, optional/strict workspace policy, connection initiator/grant fencing, organization-global consent authority, authenticated audit actors, database-authoritative built-in short links, durable Idea object/conversion flows, and the non-declarative trigger/provisioning contracts agree across source, SDK/dashboard, generated documentation, baseline, snapshot, and the disposable PostgreSQL 17.9 catalog.

It still cannot be called production-ready or a deployed control set. The next safe sequence is to resolve the supported-environment inventory, replay and restore-test on PostgreSQL 18, exercise the exact protected production migration/provisioning path, prove backup/restore readiness, run the production-like load/provider/crash fixtures, and complete one real expand/backfill/contract release. The sealed baseline must remain immutable throughout that work.
