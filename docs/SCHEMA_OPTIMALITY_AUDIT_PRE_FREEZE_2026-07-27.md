# RelayAPI database and durable-state optimality audit — pre-freeze, 2026-07-27

> **Historical / superseded gate state.** This document preserves the July
> pre-freeze analysis and implementation evidence. Its proposed generation-2
> collapse and references to an eight-file generation-1 chain are no longer the
> current procedure. On 3 August 2026 the authorized pre-live reset landed one
> sealed generation-1 `0000_baseline`; use
> `REPOSITORY_SERIOUS_ISSUES_ULTRASCAN_2026-08-02.md` and
> `DATABASE_MIGRATION_AND_FORWARD_RECOVERY_RUNBOOK.md` for current status and
> operator steps. Sections explicitly labelled as chronological or original
> remain intentionally unchanged as historical evidence.

**Historical status at publication:** target-shape implementation complete;
the then-proposed generation-2 history replacement and destructive
stage/Cloudflare cutover remained intentionally unexecuted until generation 1
had a committed Git anchor
**Baseline premise:** no production database exists, stage will be wiped, and no self-hosted
operator database has ever run migrations `0000`–`0007`
**Feature premise:** every capability represented in the schema, live code, public API/SDK,
current documentation, or retained product specifications stays in scope; incomplete capabilities
are completed rather than deleted
**Review protocol:** repository inspection and executable checks by Codex, followed by independent
challenge/rebuttal rounds, a full-artifact gate, and successive focused closure passes with Claude
Opus at `xhigh` effort

---

## 0. Executive verdict

**Do not execute the previous version of this plan.** Its central warning was correct: a naive
migration squash would lose security-critical auth functions and triggers whose bodies lived only
in numbered migration files. It also found real runtime, consent, retry, and retention defects.
However, it was not a full-schema audit and was internally inconsistent in ways that made its
sequence unsafe.

At audit start the corrected conclusion was:

1. **The schema was not ready to freeze.** There were proven day-one correctness failures in Stripe
   recovery, analytics history, automation insights, account revocation, invitations, consent
   identity, public-avatar erasure, self-hosted installation, and half-built API capabilities.
2. **The migration chain was not safely squashable.** Custom auth objects were not rendered from
   source contracts; several checks read `0005` by filename; append-only relaxation could authorize
   itself unless anchored to the base revision; and the deploy workflow rejected any unsealed
   baseline.
3. **The answer is not “fewer tables everywhere.”** Four legacy shapes should be removed now
   (`usage_records`, `byos_configs`, `usage_bucket_settlements`, and `contact_suppressions`) after
   their capabilities move to `usage_buckets`, immutable storage locations/versioned credentials,
   `billing_periods`, and canonical denied consent state. Several apparent duplicates still earn
   their place: typed tenant/workspace erasure families, `automation_step_runs`, webhook delivery
   leases, publish attempts/outboxes, and per-recipient broadcast state.
4. **The durable-state boundary is larger than PostgreSQL.** The freeze covers 143 active
   PostgreSQL tables, five physical R2 buckets through seven bindings, 25 KV key families, three
   Workers Logs stores, 19 queue/DLQ/rescue consumers, one Durable Object namespace, external
   providers, and BYOS object stores.
5. **All represented half-built features had to be completed before the freeze.** This includes API
   bearer-invite redemption, subscription-list CRUD, post tags, QR codes, landing pages, AI
   ingestion/retrieval/agents, and BYOS upload/erasure behavior.

Those target-shape changes are now implemented. The baseline remains achievable without
compatibility migrations because there is no data and no operator history. The remaining collapse
is an operational generation transition, not unfinished schema design.

### Implementation closure — 2026-07-29

| Independent lens | Implemented result | Current status |
|---|---|---|
| Blank-slate shape | 143 active tables; `usage_records`, `byos_configs`, `usage_bucket_settlements`, and `contact_suppressions` were removed only after `usage_buckets`, immutable storage locations/versioned credentials, `billing_periods`, and canonical denied consent state preserved their capabilities. Typed erasure, webhook, publish, billing, QR, and historical timelines remain where their lifecycles differ | **Closed** |
| Runtime defects outside DDL | Stripe/billing breakers, live PostgreSQL credential/feature authority, cache-safe service-key revocation, corrected analytics observations/readers, automation effect accounting, bearer-invite redemption, avatar/object erasure, deployment-neutral retention, self-host migration connectivity, fixed cron scheduling, and full feature runtimes are implemented | **Closed** |
| Invariants by construction | Tenant/scope FKs, generated scope, closed domains, numeric/workflow checks, source-owned custom SQL, schema census, capability trace, purge graph, raw-SQL domain audit, contact-writer audit, and async conformance tests fail on drift | **Closed** |
| Privacy and retention | The executable registry covers 143 PostgreSQL stores, seven R2 bindings/five buckets, 25 source-derived KV families, 19 Queue paths, three Workers Logs stores, one no-storage Durable Object, and 34 provider contracts. The timed-store inventory is derived from every registry row marked `retentionExecution: "scheduled"` and must match the registered drains exactly. Holds, redaction, drains, external cleanup, and immutable operator evidence are implemented | **Closed**, with the accepted Workers Logs limitation below |
| Async lifecycle and cost | Provider mutations use fenced request boundaries/unknown outcomes. Every cost-bearing tool call is durable-first: HTTP performs no provider egress, Queue claims are the sole execution authority, the request polls durable state for at most 20 seconds before returning 200/202, and the database—not at-least-once delivery—bounds three attempts, the hard deadline, settlement, and manual review. Pollers use fair claims; Queue rescue terminates; customer-webhook replay is phase-aware and atomic; hosted and self-host physical Queue names normalize to one capability/role contract | **Closed** |
| Topology and residency | Hosted R2 is pinned to `default` at creation, all buckets receive a one-day incomplete-multipart abort rule, database object locators carry provider/bucket/region/key, and consent authority orders by `(ordering_hlc, ordering_region, event_id)` | **Closed for the selected single-home launch** |
| Post-freeze migration discipline | Migration-only SQL is source-owned, generation transitions are base-anchored and monotonic, every renderer is checked, candidate builds are deterministic, and old/candidate normalized catalogs are compared through exact committed evidence and an independently reviewed attestation. Generation 2 retains immutable collapse-boundary manifest/catalog/review evidence; exact normalized-catalog comparison applies at that boundary, while validated append-only descendants use the current schema-derived verifier. Migration-source ownership is enforced in CI/deploy, and self-host uses a verified migration URL | **Tooling closed; one-time collapse pending a committed generation-1 anchor** |

Successive Claude Opus `xhigh` closure challenges identified and then rechecked KV completeness,
the pre-HTTP webhook operator path, consent ordering, the generation-1 Git anchor, generation-aware
verification, candidate-catalog replay, dry-run bootstrap, commented-JSONC handling, application
generation guards, migration-source ownership, customer-webhook replay ambiguity, and self-host
Queue identity. Later terminal challenges closed PostgreSQL procedural-string parsing, exact
Git-base catalog authority, protected-cutover ordering, independent application/repository/live
generation checks, ordered extension update-path and ledger-prefix validation, the PostgreSQL
18+pgvector replay image, and an accidental catalog fingerprint pin to a provider-selected
extension version. The final same-session review additionally closed live lease/deadline handling,
billing and daily-tool authority healing, feature/key cache resurrection, one request-scoped
database client, DDL literal serialization, a cross-clock tool-job timestamp, and source-derived
registration of every protected database fixture. Every code/tooling finding is now implemented
and covered by executable tests.
The one operational prerequisite cannot be truthfully bypassed: the user must first commit the
sealed generation-1 metadata and old-chain catalog evidence, then run the generation-1-to-2
procedure against that full SHA. There is no remaining design disagreement for the owner to
arbitrate.

Cloudflare sampled Workers Logs remain provider-owned and cannot be selectively erased per subject.
The accepted product posture is allowlisted structured fields, no raw payloads or credentials,
10% sampling, and Cloudflare’s bounded retention (at most seven days). This is documented as a
platform limitation, not overclaimed as selective erasure.

Sections 2–8 preserve the pre-implementation finding/target language as review evidence. The table
above, §§9.3–9.8, and the gate state in §10 are the normative current status.

### Original day-one priority matrix (all code-level findings implemented)

Do not collapse these into a fake precision score. Rank first by how many axes are affected, then by
whether the failure is unbounded.

| Finding | Correctness | Privacy | Financial | Wallet amplification | Boundedness | Priority |
|---|---:|---:|---:|---:|---:|---|
| Stripe poison receipts starve later events | high | — | high | high | unbounded today | **P0** |
| Account disconnect retains and reuses credentials | high | high | — | medium | unbounded today | **P0** |
| User/org avatars survive erasure in public R2 | — | high | — | — | unbounded today | **P0** |
| Consent hash/canonicalization defects split authority | high | high | — | — | persistent | **P0** |
| Analytics stores duplicate cumulative snapshots and public readers sum them as deltas | high | — | medium | high | unbounded growth | **P0** |
| Automation insights counts every failure as success | high | — | — | — | persistent | **P0** |
| API invite tokens cannot be redeemed | high | — | — | — | permanent | **P0** |
| Self-host deployment invokes a database variable the migrator rejects | high | — | medium | — | permanent install failure | **P0** |
| Queue rescue self-handoff can bill forever and preserves raw personal payloads | medium | high | — | high | unbounded today | **P1** |
| Ad and short-link polling lack fair claims/backoff | medium | — | — | high | unbounded delivery | **P1** |
| Array-owned receipt purge exists but is not derived/proved; shared payload retention is exceptional | — | high | — | medium | mixed | **P1** |
| Billing operations and pre-HTTP webhook failures retry without an age circuit breaker | high | medium | high | medium | unbounded today | **P1** |
| Half-built lists/tags/landing/AI/BYOS capabilities | high | mixed | — | — | permanent | **P1** |
| Fixed-order cron tail starvation | risk, not observed | — | — | medium | bounded by handler | **P2** |
| Weekly digest runs Sunday and fails outside task logging | medium | — | — | low | weekly | **P2** |

---

## 1. Mandate, method, and proof boundary

### 1.1 Rules applied

- Migration cost is treated as zero. “This would require a migration” is never a reason to keep a
  shape.
- Product capability is fixed. A table may disappear only when its capability has a named,
  complete replacement.
- Similar column names do not prove a shared lifecycle. Consolidation is accepted only when
  authority, transitions, retention, access paths, and failure semantics align.
- “Keep it; it earns its place” is a positive finding.
- Runtime behavior is inspected independently from DDL because the squash repairs no service code.
- Legal claims are not invented. This audit selects a product posture for holds and erasure but
  does not call it a universal legal obligation.

### 1.2 Seven independent lenses

Every PostgreSQL table and durable store receives a disposition under each applicable lens:

1. **Blank-slate shape** — authority, normalization, duplication, and whether persisted state earns
   its lifecycle.
2. **What the squash does not fix** — day-one runtime correctness and user-visible failure.
3. **Invariants by construction** — keys, checks, generated projections, FKs, triggers, and derived
   contract tests.
4. **Privacy and retention** — personal-data fields, subject location, purge/redaction, holds,
   boundedness, and external copies.
5. **Async lifecycle and cost safety** — claim, fence, boundary, retry, unknown outcome, terminal
   state, fairness, and at-least-once amplification.
6. **Topology and residency** — database placement, object location, regional routing seams, and
   irreversible resource choices.
7. **Post-freeze migration discipline** — reproducibility, expand/contract policy, nontransactional
   DDL, self-host parity, and catalog verification.

### 1.3 Completeness is derived, not asserted

The PostgreSQL subject set is derived from every Drizzle `PgTable` export in
`packages/db/src/schema.ts`: **9 auth + 134 public = 143 active tables**. The full ledger in §3
also retains the four deliberately eliminated legacy shapes so capability preservation is
explicit.

The external subject set is derived from all Wrangler configurations plus key construction sites:

- five physical R2 buckets across seven bindings;
- the shared KV namespace and all 25 source-derived key prefixes;
- nine main queue families, nine DLQs, and the rescue queue;
- persisted Workers Logs for API, app, and docs Workers;
- `REALTIME` / `RealtimeDO`;
- Hyperdrive, rate-limit namespaces, Images, Media Transformations, Workers AI, edge caches, and
  external/BYOS storage.

This ledger is now executable. `privacy-retention-registry.test.ts` derives PostgreSQL, R2, Queue,
and Workers Logs coverage; `kv-privacy-source-coverage.test.ts` resolves actual production
`get`/`put`/`delete`/`list` key arguments; and `schema-freeze-capability-trace.test.ts` binds every
non-keep disposition to schema, runtime, API/SDK, retention, and test evidence.

### 1.4 Cross-model protocol

Each material claim was sent to Claude Opus 5 with exact repository paths and an instruction to
independently inspect rather than trust this audit. Responses used:

- **CONFIRMED** — independently reproduced;
- **REVISED** — direction survived but fact, scope, or remedy changed;
- **REFUTED** — evidence disproved the claim;
- **OWNER** — repository evidence could not settle product/risk policy.

Codex then challenged Claude’s conclusions, including the attempted removal of owner-role bearer
invites. Claude reversed that recommendation after the fixed-feature rule was reapplied. The
settled owner decisions are recorded in §6. The owner selected hosted R2 `default`; no owner
decision remains open.

### 1.5 Executed checks and honest limits

The numerical results below are the final post-remediation sweep of the current working tree.
The schema verifier reports **69 scope contracts, 128 public tables, 323 invariant candidates,
5 documented exceptions, and 41 durable-domain contracts**.

- `bun run --cwd packages/db test:schema-invariants` — passed: 68 tests, 21,547 assertions. Its
  derived input is 143 tables, including 134 public tables.
- `bun run --cwd packages/db test:migration-contracts` — passed: 92 tests, 544 assertions.
- `bun run --cwd packages/db test:baseline-builder` — passed: 22 tests, 120 assertions (also
  included in the migration-contract run).
- `bun run --cwd packages/db baseline:sealed:check`,
  `migration:source-ownership`, and `bun run db:verify-schema-contracts` — passed. The schema
  verifier reports 69 scope contracts, 128 public tables, 323 invariant candidates, 5 documented
  exceptions, and 41 durable-domain contracts.
- `bun run typecheck` — passed for the complete monorepo.
- `cd apps/api && bun run test` — passed: 197 files, 1,588 tests, 19 explicitly reported
  generation-2 database-fixture skips, and 0 failures. The skips are exactly billing-period
  boundary (1), BYOS lifecycle (2), daily-tool entitlement (4), email owner deletion (2),
  tool-job lifecycle (6), and usage-authority self-heal (4).
- `bun run --cwd apps/api test:db-fixtures:required` is a protected generation-2 gate. It
  recursively discovers the canonical database-gated fixture marker, exact-compares the discovered
  set with six registered files, and requires exactly 19 executed cases with zero skips/failures.
  It intentionally cannot run against the sealed generation-1 chain and is ordered after clean
  generation-2 replay but before destructive cutover.
- `bun run --cwd apps/api test:workerd` — passed: 3 files, 10 tests.
- `cd apps/app && bun test` — passed: 288 tests, 822 assertions, 0 failures.
- Self-host typecheck, 48 tests/248 assertions, build, and installed-package smoke — passed.
- SDK typecheck, 14 tests/24 assertions, build, and ESM/CommonJS/TypeScript package smoke — passed.
- OpenAPI checkout parity passed exactly. The five protected generation/cutover guard files passed
  37 tests/323 assertions; the cutover workflow file itself passed 11 tests/177 assertions.
- `bun run lint` — exited successfully with 48 warnings, 1 informational diagnostic, and no
  errors.
- Latest `@cloudflare/workers-types` retrieved during the final audit pass:
  `5.20260729.1`.

Only `baseline:rebuild:check` is intentionally red before Stage 3: it rejects the tracked
eight-file history because it is not yet the one-file generation-2 baseline. Generation-aware
`verify:schema-contracts` is now green against the sealed generation-1 contract. The remaining red
check is the correct transition stop, not a candidate-baseline result.

The generation-1 side of the catalog proof was executed in a disposable local, digest-pinned
PostgreSQL 18+pgvector instance. A clean first application of `0000`–`0007` passed, a second
application passed as an idempotent no-op, and the normalized old-chain capture contains **4,463
objects** with catalog fingerprint
`790b1ec1eacebaf5a37812003fc09332ee41e78275307f256079212a25ef4fe4`.
It is bound to generation-1 migration-manifest SHA-256
`e890e2d0bc231ec82f6aebb45465fe87c74fe247b19d1263d3f58c658a175d18`.

The remaining stop is concrete: `baseline-generation.json`, the manifest, and the captured
old-chain catalog evidence exist in the working tree but have no committed generation-1 Git
anchor. The agent may not create that anchor because repository policy forbids Git writes, and the
collapse tool correctly refuses to build or replay the generation-2 candidate without it. The
generation-2 scratch replay and active catalog comparison therefore remain unexecuted rather than
fabricated. The protected live database catalog, hosted Cloudflare resources, stage wipe, and
stage smoke flows were not exercised without their protected credentials. Actual provider
pgvector availability remains a doctor/preflight gate. All destructive/live actions remain Stage
4 work.

Cloudflare-specific conclusions were rechecked against current primary documentation:

- [Queues are at-least-once](https://developers.cloudflare.com/queues/reference/delivery-guarantees/);
- [retries are charged and `max_retries` defaults to three](https://developers.cloudflare.com/queues/configuration/batching-retries/);
- [Cron weekdays are 1=Sunday through 7=Saturday](https://developers.cloudflare.com/workers/configuration/cron-triggers/);
- [each Cron invocation has its own 15-minute wall-time limit](https://developers.cloudflare.com/workers/platform/limits/#wall-time-limits-by-invocation-type);
- [R2 jurisdiction cannot change after bucket creation](https://developers.cloudflare.com/r2/reference/data-location/);
- [Hyperdrive uses transaction-mode pooling](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/);
- [Workers Logs retain at most seven days](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

---

## 2. Validation of the superseded plan

### 2.1 Confirmed and load-bearing

#### The squash would drop auth identity invariants

Only `packages/db/drizzle/0005_atomic_identity_deletion.sql` contains the bodies for three auth
functions and their triggers. `AUTH_IDENTITY_INVARIANT_CONTRACTS` names the objects but does not
contain their SQL, and `render-custom-migration-sql.ts` does not render them.

Worse, `verify-migrations.ts:489-492`, the dashboard auth-security test, and the deploy workflow
read or name `0005` directly. Deleting numbered history before moving those bodies into
source-controlled render contracts removes both the objects and the verifier’s source of truth.

**Required:** move every function and trigger body into canonical render contracts first; tests
must inspect rendered output, never a numbered migration filename.

#### The history cannot currently be replaced safely

The current controls correctly block casual rewriting:

- baseline policy is `sealed`;
- rebuild write mode requires both an allowed lifecycle and explicit confirmation;
- the journal, manifest, policy, and SQL files must agree exactly;
- append-only verification compares the protected prefix byte-for-byte;
- `migrate` runs manifest, policy, and history checks before applying SQL;
- the deploy workflow requires `baseline:sealed:check`.

These are good controls. The collapse needs a first-class, base-anchored generation transition—not
a skipped check, actor exception, label, or temporary workflow edit.

#### Several runtime findings were correct

The previous report correctly found:

- the weekly digest cron uses Sunday while comments/tests say Monday;
- `usage_records` has readers but no producing writer;
- account revocation can replay a successful provider call;
- Meta binding sync writes the remote mutation before durable completion;
- retry timing overwrites user schedule on cross-post work;
- bare recipient hashes are weak pseudonyms;
- request-log pruning is hosted-only;
- contact consent purpose/channel values are not stored canonically.

### 2.2 Contradictions that made the plan non-executable

| Contradiction | Correct disposition |
|---|---|
| “Partition nothing” versus “`api_request_logs` is already decided: partition it” | Do not partition at birth; add the access/retention indexes and revisit from measured volume |
| “Exactly one baseline regeneration” versus regeneration in Stages 1 and 2 | Allow temporary candidate generation outside tracked history; commit exactly one normative sealed baseline |
| Stage 4 depended on decisions in later Stage 6 | Resolve every target shape before the collapse stage |
| Stage 5 was “runtime-only” but included new columns, indexes, and redaction clocks | Group schema + runtime + SDK + tests by dependency-complete behavior |
| Consent and scheduling work appeared in both Stages 2 and 5 | One implementation unit per invariant/lifecycle |
| R14–R17 were absent from the severity table | Rank all findings on the same independent axes |
| A long `pre-launch` interval was proposed | Keep main deployable; perform the authorized generation replacement in one coordinated sealed change |

### 2.3 Claims corrected or refuted

- **Dashboard DB boundary:** 22 files import `@relayapi/db`, but only six billing/admin business-data
  routes violate the API-first rule. Auth/session/credential bootstrap, user-local notifications,
  preferences, and the type declaration are not equivalent violations.
- **Catalog diff:** `verify-migrations.ts` checks one live catalog against code-derived
  expectations. It does not compare old-chain and candidate databases.
- **Erasure consolidation:** the proposed flat `erasure_jobs` table is worse. Workspace deletion
  requires a composite tenant/scope FK; tenant deletion deliberately must outlive its organization
  FK; statuses and completion checks differ.
- **`post_tags.workspace_id`:** adding it is backwards. `post_tags` already projects authoritative
  scope from its parent post through a composite FK.
- **`automation_step_runs` deletion:** refuted. It is a longer-lived analytical timeline with
  public readers and different indexes from the hot claim/CAS table.
- **Hyperdrive row-lock bug:** no present bug was found. Every bare `SELECT ... FOR UPDATE` is inside
  `db.transaction`; other sites use atomic CTE statements. Preserve this as a derived guardrail.
- **Cron “seven waves”:** `mapConcurrently` is a dynamic shared iterator, not fixed waves. Tail risk
  is structural but not observed, so it is not priority one.
- **External-post producers:** the single-update statement belongs to account-sync
  `enqueueDueAccounts` and protects only sequential ticks, not concurrent ownership. Metrics are
  weaker: `enqueueMetricsRefresh` pages with SELECT then separately bulk-updates freshness, while
  competing `enqueueExternalPostRefresh` performs SELECT/filter/enqueue with no claim at all. Both
  target the same rows/queue every five minutes. Consolidate them behind one due-state
  generation/fence and separate claim time from freshness.
- **Short-link amplification:** the prior 288,000/day figure was wrong. Batched calls yield 288/day
  for one affected tenant and at most 57,600/day for 200 one-link tenants per scheduled delivery.
  This path is direct Cron, not Queue; overlapping Cron invocations—not Queue redelivery—are its
  extra multiplier.
- **Four R2 buckets:** refuted. There are five physical buckets; the avatar bucket has two bindings
  and three incompatible key schemes.

---

## 3. PostgreSQL disposition ledger — 143 active tables plus four removed legacy shapes

“Keep” means the table has a distinct authority/lifecycle and earns its place. “Reshape” means the
capability remains but the virgin baseline should change. “Complete” means the represented
capability lacks a working product path. “Remove” is allowed only with the replacement named in the
row.

### 3.1 Auth and tenant control plane

| # | Subject | Capability | Disposition | Decisive freeze work |
|---:|---|---|---|---|
| 1 | `auth.user` | Identity and global admin role | **Keep** | Include user-avatar R2 keys in identity erasure; keep Better Auth-owned role domain external |
| 2 | `auth.session` | Authenticated sessions | **Keep** | Cascade from user and preserve Better Auth ownership |
| 3 | `auth.account` | OAuth/password identities | **Keep** | Preserve atomic last-identity deletion trigger and encrypted credential handling |
| 4 | `auth.verification` | Verification/reset tokens | **Reshape** | Add total expiry drain and identity-erasure locator; raw identifiers must not persist after expiry |
| 5 | `auth.apikey` | API credentials and workspace grants | **Reshape** | Keep hash lookup/KV invalidation; attach rotating credentials to a stable user/service principal and normalize scope mode plus workspace grants |
| 6 | `auth.organization` | Tenant root and lifecycle | **Keep** | Preserve active/deleting/tombstoned invariant and owner trigger |
| 7 | `auth.member` | Organization membership/roles | **Reshape** | Preserve role/owner invariants; create a stable member principal with durable scope mode/workspace grants, and let an owner bearer invite add a co-owner |
| 8 | `auth.organization_creation_reservation` | Race-safe organization quota claim | **Keep** | Add/verify expiry drain; this is a short-lived claim, not an organization snapshot |
| 9 | `auth.invitation` | Email-addressed Better Auth invitation | **Keep** | Keep distinct from bearer invite tokens and prune terminal/expired rows |
| 10 | `public.workspaces` | Operational tenant subdivision | **Keep** | Authoritative `(id, organization_id)` relationship remains the scope root |
| 11 | `public.workspace_tombstones` | Durable “workspace is gone” receipt | **Keep** | Retain minimized identifier/status evidence for fail-closed authorization |
| 12 | `public.workspace_erasure_jobs` | Durable workspace erasure lifecycle | **Keep typed** | Integrate legal holds, aged alerts, and shared transition factory without generic target columns |
| 13 | `public.workspace_erasure_steps` | Resumable workspace purge steps | **Keep typed** | Preserve composite workspace/org/scope FK and per-step leases |
| 14 | `public.organization_settings` | One organization policy row | **Keep** | One-row-per-tenant encoding is justified; keep workspace requirement as policy, not tenancy authority |
| 15 | `public.tenant_deletion_jobs` | Organization deletion receipt/workflow | **Keep typed** | Preserve no-FK-after-purge design; add legal holds, minimized evidence, and 24-hour aged alert |
| 16 | `public.tenant_deletion_steps` | Resumable organization purge steps | **Keep typed** | Preserve tenant-specific statuses/payloads and shared code factory only |
| 17 | `public.invite_tokens` | Shareable single-use API bearer invitations | **Reshape + complete** | Add atomic redeem; normalize token grants, copy them into durable principal grants, and constrain scope/role/consumption tuples |

### 3.2 Connections, publishing, media, and webhooks

| # | Subject | Capability | Disposition | Decisive freeze work |
|---:|---|---|---|---|
| 18 | `public.social_accounts` | Connected platform identity/credentials | **Keep** | Keep account authority; make object locator region-aware and disconnection independent of active token retention |
| 19 | `public.account_revocation_jobs` | Provider-side account disconnect | **Reshape** | Real lease token, attempt increment, persisted request boundary, 7-day terminal/manual policy |
| 20 | `public.token_refresh_operations` | Rotating-token provider boundary | **Keep** | It is the reference grant/fence lifecycle; source-token version is not a generic lease |
| 21 | `public.post_threads` | Ordered multi-post thread definition | **Keep** | Distinct composition root with tenant-safe children |
| 22 | `public.posts` | Canonical publishable content/schedule | **Keep** | Keep product schedule immutable from retry timing; retain parent scope authority |
| 23 | `public.thread_executions` | Durable execution of one thread publish | **Keep** | Separate execution lifecycle from reusable thread definition |
| 24 | `public.telegram_connection_challenges` | Short-lived Telegram connection proof | **Keep** | Enforce expiry drain and single-use terminal state |
| 25 | `public.post_targets` | Per-platform target/result | **Keep** | Necessary per-target state; fairness and claim indexes remain target-aware |
| 26 | `public.publish_attempts` | Fenced provider mutation attempt | **Keep** | Reference external-mutation boundary with known/unknown outcome |
| 27 | `public.publish_outbox` | Transactional enqueue handoff | **Keep** | Reference outbox lifecycle; do not merge with provider attempts |
| 28 | `public.post_recycling_configs` | Reusable recycling policy | **Keep** | Definition lifecycle differs from occurrences |
| 29 | `public.recycling_occurrences` | Idempotent recycling schedule receipt | **Keep** | Preserve deterministic occurrence uniqueness |
| 30 | `public.media` | Media metadata and object ownership | **Reshape** | Store explicit provider/bucket/region/key locator; preserve thumbnail after original lifecycle deletion |
| 31 | `public.webhook_endpoints` | Customer webhook configuration | **Keep** | Endpoint definition remains separate from events/deliveries |
| 32 | `public.webhook_events` | Transactional customer-event fan-out source | **Keep** | Add explicit retention; immutable event authority earns a separate lifecycle |
| 33 | `public.webhook_deliveries` | Per-endpoint HTTP delivery state | **Keep** | Dual batch/attempt fences are load-bearing; keep eight post-boundary HTTP attempts and add a 24-hour pre-boundary blocked/operator state |
| 34 | `public.webhook_logs` | Customer-visible per-HTTP-attempt history | **Reshape** | Tie each row to delivery + attempt ordinal/kind/outcome; model test attempts explicitly; preserve bounded TTL/redaction |
| 35 | `public.post_analytics` | Historical post-metric observations | **Reshape** | Define cumulative-snapshot semantics, deterministic window identity, correct timeline aggregation, and one fenced poll scheduler |
| 36 | `public.connection_logs` | Connection/OAuth operational history | **Keep** | Define TTL/redaction; do not retain provider identifiers indefinitely |

### 3.3 Operations, billing, and reliability

| # | Subject | Capability | Disposition | Decisive freeze work |
|---:|---|---|---|---|
| 37 | `public.api_request_logs` | API usage/security request log | **Keep, do not partition yet** | Add total hosted/self-host pruning and indexes for actual access paths |
| 38 | `public.queue_failures` | Replayable failed-message ledger | **Reshape** | Derive/test the existing array-owner handler; separate/encrypt/redact payload, add subject locators, expiry, and terminal/manual state |
| 39 | `public.email_deliveries` | Idempotent transactional email state | **Reshape** | Add tenant/subject locator, retention, and erasure behavior without coupling to billing |
| 40 | `public.idempotency_receipts` | API request replay protection | **Keep** | Bounded receipt lifecycle earns its place; verify TTL drain |
| 41 | `public.one_time_capabilities` | Short-lived privileged capability | **Keep** | Close capability kind domain and enforce expiry/consumption tuple |
| 42 | `public.organization_subscriptions` | Current billing entitlement | **Keep** | API-owned authority; dashboard must use API/SDK |
| 43 | `public.subscription_checkout_operations` | Checkout provider boundary | **Keep** | Durable external-operation lifecycle, not a subscription snapshot |
| 44 | `public.stripe_events` | Stripe webhook replay/processing ledger | **Reshape** | Retain existing fence/attempt increment; add ordered due eligibility, error class, backoff, and 12-or-24h manual review |
| 45 | `public.billing_outbox` | Transactional billing-event dispatch | **Keep** | Keep separate outbox lifecycle; close app-owned kind domain |
| 46 | `public.usage_buckets` | Maintained metering/quota window | **Keep** | Canonical usage source; snapshot included units on the active bucket |
| 47 | `public.usage_reservations` | Concurrency-safe quota reservation | **Keep** | Reservation lifecycle is distinct from settled usage; persist provider-boundary/disposition state and bind async tool work one-to-one so unknown egress charges conservatively rather than being reclaimed as free |
| 48 | `public.usage_records` | Legacy admin usage projection | **Remove** | Admin reads `usage_buckets`; rename/snapshot included units on the active bucket; remove the explicit tenant-purge registry entry |
| 49 | `public.byos_configs` | Customer-owned object storage configuration | **Remove + reshape** | The feature survives in immutable `storage_locations` plus versioned `storage_credentials`; media pins the exact tenant-safe location and credential version, so rotation and topology changes never reinterpret an existing object |
| 50 | `public.storage_locations` | Immutable customer-owned object routing | **Complete + reshape** | Insert endpoint/bucket/prefix changes as new locations, activate only after a staged probe succeeds, retire rather than overwrite, and bind media through exact tenant-safe location/bucket/region FKs |
| 51 | `public.storage_credentials` | Fenced customer-owned storage credential rotation | **Complete + reshape** | Stage and probe a new encrypted version, atomically activate it under a tenant lock, preserve the old active version on failure, and retain retired versions only while pinned objects or cleanup require them |
| 52 | `public.invoices` | Durable invoice read model | **Keep** | Provider-derived financial evidence; define retention and tenant deletion posture |
| 53 | `public.usage_bucket_settlements` | Idempotent usage settlement | **Remove + reshape** | The feature survives in `billing_periods`: its fenced `open → closed → claimed → settled/released` lifecycle, one billing operation per period, and stable Stripe idempotency key provide exact-once overage settlement without a second stacked state machine |
| 54 | `public.billing_periods` | Authoritative entitlement, quota, price, and settlement window | **Complete + reshape** | Make periods the immutable exact-window authority; enforce non-overlap, exact bucket binding, deterministic splits, USD snapshots, cancellation settlement, and fenced claim/retry transitions |
| 55 | `public.billing_operations` | Serialized billing mutations | **Reshape** | Keep provider boundary/history; schedule at stored due time and stop automatic reconciliation for manual review after 12 attempts or 24 hours |
| 56 | `public.dunning_events` | Dunning attempts and outcomes | **Keep** | Keep bounded financial evidence with retry/manual classification |

### 3.4 User state, inbox, contacts, consent, and broadcasts

| # | Subject | Capability | Disposition | Decisive freeze work |
|---:|---|---|---|---|
| 57 | `public.user_preferences` | User timezone/language preferences | **Keep + complete consumers** | Persistence is live; consume values where behavior promises localization/timezone |
| 58 | `public.notifications` | User notification inbox | **Keep** | User-scoped app state is legitimate; add retention/read cleanup |
| 59 | `public.notification_preferences` | Per-user notification controls | **Keep** | One-row-per-user policy earns its place |
| 60 | `public.inbox_conversations` | Synced conversation root | **Keep** | Distinct thread lifecycle; add participant-avatar object locator |
| 61 | `public.inbox_messages` | Durable inbound/outbound message history | **Keep** | Retention/search indexing and subject erasure must be explicit |
| 62 | `public.inbound_webhook_events` | Shared inbound provider receipt | **Reshape** | Derive/test the live shared-owner purge; separate/redact bounded payload and make the retained shared-row exception explicit |
| 63 | `public.inbox_event_effects` | Idempotent processing/effect receipt | **Keep** | Add stable automation occurrence identity and keep external effects component-scoped |
| 64 | `public.inbox_conversation_notes` | Internal conversation notes | **Keep** | Personal-data retention and author identity remain explicit |
| 65 | `public.auto_post_rules` | Feed-to-post automation definition | **Keep** | Definition is independent from feed-item occurrences |
| 66 | `public.auto_post_feed_items` | Idempotent feed-item occurrence | **Keep** | Deterministic source receipt prevents duplicate posts |
| 67 | `public.whatsapp_phone_numbers` | Phone resource plus provisioning/release | **Reshape** | Keep phone entity; move provisioning and release nullable state machines into typed operation tables |
| 68 | `public.custom_field_definitions` | Tenant-defined contact schema | **Reshape** | Close app-owned field type domain and validate select options by type |
| 69 | `public.custom_field_values` | Contact custom values | **Keep** | Definition/value separation and tenant-safe FKs earn place |
| 70 | `public.contacts` | Canonical contact identity/profile | **Reshape** | Add application-normalized E.164 `phone_canonical`, scoped partial uniqueness where authoritative, and use it in every linker; keep display phone separate |
| 71 | `public.contact_channels` | Contactable platform/email/phone identifiers | **Keep** | Normalize by channel, encrypt where appropriate, and locate for erasure |
| 72 | `public.contact_consent_events` | Ordered consent evidence | **Reshape** | Canonical open dimensions, versioned org HMAC, redaction fields, HLC tuple, and rotation-safe canonical logical identity |
| 73 | `public.contact_consent_states` | Current grant/denial authority | **Reshape** | Minimal denial authority plus an atomic key-rotation protocol proving deny→rotate→grant and deny→rotate→reimport |
| 74 | `public.contact_suppressions` | Duplicate absolute opt-out veto | **Remove** | Query canonical denied consent state in both authorization paths; remove explicit workspace/tenant purge-registry entries |
| 75 | `public.broadcasts` | Broadcast parent/campaign | **Keep** | Parent state differs from recipient delivery outcomes |
| 76 | `public.broadcast_recipients` | Per-recipient broadcast lifecycle | **Keep** | Necessary fan-out/fairness/idempotency state |

### 3.5 Ads, sync, content, ideas, and planning

| # | Subject | Capability | Disposition | Decisive freeze work |
|---:|---|---|---|---|
| 77 | `public.ad_accounts` | Connected advertising account | **Keep** | Provider account authority distinct from social account |
| 78 | `public.ad_campaigns` | Synced campaign | **Keep** | Parent for ads and campaign analytics |
| 79 | `public.ads` | Synced/created ad entity | **Keep** | Per-ad provider identity and status earn place |
| 80 | `public.ad_creation_operations` | Fenced provider ad mutation | **Keep** | External mutation operation with unknown outcome is justified |
| 81 | `public.ad_metrics` | Historical ad observations | **Keep + bound** | Define observation identity and retention; do not overwrite history |
| 82 | `public.ad_audiences` | Provider audience definition | **Keep** | Reusable audience lifecycle differs from upload users |
| 83 | `public.ad_audience_users` | Audience upload membership ledger | **Keep** | It is a write/upload ledger even without product SELECT readers |
| 84 | `public.ad_sync_logs` | Ad synchronization evidence | **Keep + bound** | Add TTL and avoid retrying all provider reads when final logging fails |
| 85 | `public.external_posts` | Provider-originated post mirror | **Keep** | Needed for sync, analytics, and inbox linkage |
| 86 | `public.social_account_sync_state` | Per-account sync cursors/due state | **Reshape** | Separate lease/generation from freshness and add fair due ordering |
| 87 | `public.content_templates` | Reusable content definition | **Keep** | Shared definition lifecycle is independent from posts |
| 88 | `public.cross_post_actions` | Cross-post mutation lifecycle | **Reshape** | Split immutable `scheduled_for` from mutable `next_attempt_at`; preserve boundary/outcome |
| 89 | `public.signatures` | Reusable prepend/append signature | **Keep** | Scope/default uniqueness earns place |
| 90 | `public.short_link_configs` | Current tenant short-link policy/provider pointer | **Keep** | One-row-per-org policy earns its place; it points at the current immutable provider/config and credential version without overwriting historical secret authority |
| 91 | `public.short_link_credentials` | Historical provider credential authority | **Complete + reshape** | Version encrypted credentials, retire rather than overwrite them, and keep an old version only while a pinned link or unresolved cleanup job needs it |
| 92 | `public.short_links` | Short URL mapping, creation intent, and click state | **Reshape** | Insert a fenced `pending` intent before provider egress; persist provider-specific identity plus config/credential versions; send ambiguous creation and unsupported cleanup to manual review; use historical credentials for polls and erasure |
| 93 | `public.org_streaks` | Organization posting streak aggregate | **Keep** | Compact derived aggregate feeds live streak-warning notifications; recomputable but cheap and bounded |
| 94 | `public.tags` | Shared tenant tag definition | **Keep** | Organization/workspace visibility authority |
| 95 | `public.idea_groups` | Planning group/board | **Keep** | Parent lifecycle distinct from ideas |
| 96 | `public.ideas` | Planned content idea | **Keep** | Product entity and scope root for idea children |
| 97 | `public.idea_conversion_operations` | Idempotent idea-to-post conversion | **Keep** | Conversion boundary prevents duplicate post creation |
| 98 | `public.idea_media` | Ordered idea/media association | **Keep** | Junction carries ordering and parent authority |
| 99 | `public.idea_comments` | Collaborative comments | **Reshape** | Use stable typed user/service-principal attribution; bind `(parent_id, idea_id)` to the same idea with a composite self-FK |
| 100 | `public.idea_tags` | Idea/tag association | **Reshape** | Project scope from parent idea; rewrite two workspace read predicates + two writes, replace the index, and remove the workspace purge entry so the idea FK cascade owns deletion |
| 101 | `public.post_tags` | Post/tag association | **Complete** | Keep parent-projected scope, add `(organization_id, tag_id, post_id)` index and API/SDK paths |
| 102 | `public.idea_activity` | Planning audit/activity timeline | **Keep + bound** | Use the same stable user/service-principal union as comments and retain a bounded audit timeline |

### 3.6 Automations, audiences, AI, and growth tools

| # | Subject | Capability | Disposition | Decisive freeze work |
|---:|---|---|---|---|
| 103 | `public.automations` | Automation graph definition/revision | **Keep** | Canonical reusable graph and scope authority |
| 104 | `public.automation_secrets` | Encrypted node credentials | **Reshape** | Close app-owned secret kind domain and preserve key-version rotation |
| 105 | `public.automation_entrypoints` | Trigger configuration | **Reshape** | Close kind domain and enforce kind-specific identity/config checks |
| 106 | `public.automation_entrypoint_daily_counts` | Daily admission cap | **Reshape** | Use PostgreSQL `date`; define UTC as the stored accounting day |
| 107 | `public.automation_webhook_receipts` | Idempotent webhook-trigger receipt | **Keep** | Durable-inbox accept/dedupe/lease/terminal/redaction lifecycle earns place |
| 108 | `public.automation_bindings` | Provider-side automation binding | **Reshape** | Revisioned desired/applied operation, transient/permanent/unknown outcome, manual resolution |
| 109 | `public.automation_runs` | One automation execution | **Keep** | Run root and revision authority |
| 110 | `public.automation_conversion_events` | Idempotent conversion signal | **Keep** | One fact/outbox row owns claim, fenced lease, bounded retry, deadline, terminal/manual review, and idempotent deferred enrollment |
| 111 | `public.automation_node_executions` | Hot node claim/CAS state | **Keep** | Pure orchestration stays retryable; no analytical indexes added |
| 112 | `public.automation_effects` | External side-effect ambiguity ledger | **Reshape** | One row per actual message block/action, never per pure node; immediate manual on unknown |
| 113 | `public.automation_step_runs` | Public run timeline and analytics | **Keep + fix** | Add projected org/scope and composite run+automation FK, retention, and constrained-literal reader test; fix `'fail'` versus `'failed'` |
| 114 | `public.automation_scheduled_jobs` | Resume/delay/input/event/trigger/failure work | **Reshape + complete** | Project org/scope, bind every job type to its authoritative parent tuple, make orchestration pure, and implement durable `webhook_reception_failure` capture |
| 115 | `public.automation_contact_controls` | Per-contact automation pause/opt-out | **Keep** | Distinct operational control from channel consent |
| 116 | `public.segments` | Reusable audience definition | **Keep** | Definition lifecycle distinct from computed membership |
| 117 | `public.contact_segment_memberships` | Static segment membership | **Keep** | Store only explicit static membership; dynamic segment membership/counts/filtering/scheduling are derived from a closed parameterized grammar |
| 118 | `public.subscription_lists` | Channel-scoped subscription audience | **Complete** | CRUD and membership API/SDK; consent stays orthogonal and is checked at send time |
| 119 | `public.contact_subscriptions` | Contact/list membership and unsubscribe state | **Keep** | Parent-projected scope; close `source`; “remove” sets `unsubscribed_at`, while re-add records/clears it under the versioned history rule |
| 120 | `public.ai_knowledge_bases` | Knowledge configuration | **Complete + reshape** | Explicit OpenAI embedding provider; supported registry begins with `text-embedding-3-small`/1536 |
| 121 | `public.ai_knowledge_documents` | Ingestion source/state | **Complete** | Real URL/file/text ingestion, processing lease, failure classification, retention |
| 122 | `public.ai_knowledge_chunks` | Searchable knowledge chunks | **Complete + reshape** | `vector(1536)` with HNSW `vector_cosine_ops`, chunk writer, cosine query, purge/retention |
| 123 | `public.ai_agents` | Inbox/automation AI agent configuration | **Complete + reshape** | Workers AI inference, explicit supported model registry/default, tenant-safe KB, guardrails, and no silent fallback |
| 124 | `public.ref_urls` | Trackable public visit/automation trigger | **Reshape + complete** | Define HTTPS/landing destination and public route; transactionally persist idempotent visit + counter + automation outbox |
| 125 | `public.qr_codes` | Per-placement QR identity and scans | **Complete + reshape** | Generate image on read; remove `image_r2_key`, the QR cursor phase/function/key family inside `revoke_external_resources`, and default the cursor to `account_dependents` |
| 126 | `public.landing_pages` | Public conversion page linked to automation | **Complete** | CRUD, selected org/workspace slug namespace, idempotent conversion/outbox transaction, config validation, SDK |

### 3.7 Baseline-completion relations that earn their place

| # | Subject | Capability | Disposition | Decisive freeze work |
|---:|---|---|---|---|
| 127 | `public.contact_subscription_events` | Append-only subscription transition history | **Keep** | Immutable event identity and explicit current-state provenance preserve consent/list history without making the event log a second mutable authority |
| 128 | `public.erasure_holds` | Organization/workspace erasure hold state | **Keep** | One typed hold state machine serializes placement/release against bounded erasure and retention roots |
| 129 | `public.external_subject_cleanup_jobs` | Durable external-object subject cleanup | **Keep** | Exact/prefix/rescue and provider-specific short-link cleanup share one fenced bounded lifecycle; copied short-link credentials clear immediately on success, while unsupported/unknown outcomes require evidence-backed manual resolution |
| 130 | `public.financial_retention_receipts` | Minimized detached financial evidence | **Keep** | Append-only tombstone-compatible evidence survives tenant purge without retaining provider URLs, payloads, or free-form errors |
| 131 | `public.invite_token_workspaces` | Invite workspace-grant set | **Keep** | Normalized child grants preserve bearer-invite capability and bind every workspace to the invite tenant |
| 132 | `public.operator_resolution_evidence` | Operator lifecycle-decision evidence | **Keep** | Detached append-only sanitized before/after evidence remains readable after target or tenant deletion |
| 133 | `public.operator_resolution_notes` | Bounded free-form operator rationale | **Complete + reshape** | Keep encrypted rationale outside append-only evidence, decrypt only before its exact 90-day expiry, rotate its key, and delete it on the scheduled clock while the closed reason code/digest remains |
| 134 | `public.organization_principals` | Stable tenant authorization principal | **Keep** | Key rotation and service/user identity share a stable revocable tenant principal instead of key-local grants |
| 135 | `public.principal_workspace_grants` | Principal workspace authorization | **Keep** | Normalized grants enforce tenant/workspace ownership and survive API-key rotation |
| 136 | `public.public_growth_events` | Public visit/scan/conversion occurrence | **Keep** | One idempotent occurrence/outbox transaction owns counters, contact linkage, and deferred automation handoff |
| 137 | `public.queue_schedules` | Posting schedule authority | **Keep** | PostgreSQL is the canonical tenant schedule; KV is a bounded invalidatable read projection only |
| 138 | `public.tool_jobs` | Durable async download/transcript work | **Keep** | Every HTTP call first persists encrypted work and an identifier-only Queue hint; only a database claim in the Queue consumer may cross the atomic usage/job provider boundary. HTTP polls durable state for up to 20 seconds and returns 200 or 202; PostgreSQL fences three attempts, the hard claim/arm deadline, late definitive reconciliation, unknown-outcome review, and terminal TTL |
| 139 | `public.whatsapp_phone_provisioning_operations` | WhatsApp phone provisioning reconciliation | **Keep** | Distinct read-before-retry provisioning phases and terminal manual review match provider semantics |
| 140 | `public.whatsapp_phone_release_operations` | WhatsApp phone release/deregistration reconciliation | **Keep** | Separate ambiguous deregistration boundary preserves explicit succeeded/not-applied operator decisions |
| 141 | `public.retention_drain_runs` | Durable per-handler retention continuation authority | **Complete** | Keep exactly one fenced control row per executable handler; persist ordered cursor progress, isolate handler failures, re-arm bounded continuations every minute, and escalate a 24-hour backlog-age SLO to operator-visible manual review |
| 142 | `public.billing_operation_attempts` | Immutable revisioned Stripe settlement attempts | **Complete** | Preserve every attempted economic payload and idempotency key as an immutable revision; an ambiguous request can be reconciled or explicitly written off, while corrected rebilling requires a fresh revision |
| 143 | `public.stripe_organization_leases` | Per-organization Stripe event serialization | **Complete** | Serialize all base and add-on subscription projections behind one monotonically fenced aggregate lease so concurrent webhook deliveries cannot restore an older canonical state |
| 144 | `public.whatsapp_phone_billing_attempts` | Immutable revisioned phone add-on billing attempts | **Complete** | Preserve each desired/prior quantity, Stripe identity, request boundary, provider observation, and idempotency key as one immutable revision; a new external request requires affirmative non-application proof and a fresh revision |
| 145 | `public.whatsapp_phone_billing_operations` | Dedicated phone add-on quantity authority | **Complete** | Converge the organization-wide desired and applied quantity for the dedicated phone subscription through one fenced provider-boundary state machine |
| 146 | `public.ad_mutation_operations` | Fenced paid-provider mutation authority | **Complete** | Record the mutation intent and provider boundary before I/O; project local ad or campaign state only after definitive provider evidence or an audited operator decision |
| 147 | `public.usage_reservation_carryovers` | Settlement-aware cross-period allowance evidence | **Complete** | Link every unresolved source reservation to each later successor bucket; hold N while ambiguous, debit only terminal K, prevent idempotency-key resurrection, and block tenant evidence materialization until the source terminalizes |
| 148 | `public.ad_connections` | Dedicated paid-media credential authority | **Keep** | Provider ad authorization is tenant/workspace scoped, encrypted independently from publishing credentials, revocable, versioned, and reusable across the exact ad accounts discovered from that principal |
| 149 | `public.ad_account_promotable_identities` | Provider-authorized promotion identity binding | **Keep** | A tenant-scoped child binding records only the closed provider identity type and exact provider ID that an ad account may promote; account deletion cascades it and publishing-identity deletion only nulls the optional display linkage |
| 150 | `public.media_upload_sessions` | Resumable single/multipart upload authority | **Keep** | One tenant-scoped row uses a monotonic lease-token fence for a 200 MiB direct upload, stores multipart authority encrypted, excludes live completion/abort leases while allowing stale takeover, shreds authority only on definitive completion/abort/expiry, and deletes terminal metadata after a bounded post-transition grace |
| 151 | `public.media_processing_jobs` | Media normalization/custom-cover orchestration | **Keep** | A canonical source ETag, processor version, profile, and options hash deduplicate durable Workflow handoff while preserving a fail-open original-media authority |
| 152 | `public.media_derivatives` | Private provider-ready media artifacts | **Keep** | Each immutable derivative binds to its source/job and exact R2 key, carries a closed kind and verified checksum, and drains bytes before projection on its explicit retention clock |
| 153 | `public.social_mutation_operations` | Published-edit and interaction provider boundary | **Keep** | One idempotent fenced row records the exact target/action request boundary, provider acknowledgement, and local projection phase so ambiguous mutations are never silently replayed |
| 154 | `public.whatsapp_groups` | WhatsApp group administration projection | **Keep** | Tenant-safe account binding, closed lifecycle/join-approval state, encrypted invite capability, and bounded participant projection support provider administration without leaking join authority |
| 155 | `public.whatsapp_identity_aliases` | WhatsApp BSUID/WA-ID/username identity bridge | **Keep** | Tenant-scoped HMAC locators plus AES-GCM ciphertext preserve the phone-optional identity transition without plaintext identifiers or cross-account alias collisions |
| 156 | `public.ad_lead_forms` | Provider lead-form projection | **Keep** | The provider form identity and bounded configuration belong to the exact tenant ad account and parent lead lifecycle |
| 157 | `public.ad_leads` | Short-lived encrypted advertising lead intake | **Keep** | Encrypted provider payload and identifying projection expire together after at most 30 days; optional promotion points to the canonical contact without extending intake retention |
| 158 | `public.ad_conversion_rules` | Conversion destination/mapping definition | **Keep** | A tenant-scoped rule binds the exact ad account/platform destination and configuration while delivery remains capability-gated until a provider processor is enabled |
| 159 | `public.ad_conversion_events` | Future-gated conversion-delivery outbox | **Keep** | The durable encrypted/fenced shape is retained behind an unsupported capability; no route may admit rows until provider delivery, ambiguity reconciliation, and terminal ciphertext shredding are executable |
| 160 | `public.ad_advanced_resources` | Linked creative/catalog/product/messaging resources | **Keep** | Closed resource kind/status domains, exact ad-account ownership, and catalog-only parent shape prevent polymorphic JSON from becoming a second resource authority |
| 161 | `public.ad_report_jobs` | Asynchronous TikTok/X/LinkedIn report authority | **Keep** | One idempotent job owns submit/poll/download leases, a tenant-derived private artifact key, seven-day result expiry, and a 90-day terminal metadata drain |
| 162 | `public.ad_report_rows` | Canonical normalized advertising report rows | **Keep** | Bounded normalized dimensions/metrics remain dependent on their exact tenant job and are deleted in finite chunks with the private result artifact |

The exact-coverage test derives the active Drizzle table set and requires these 158 active rows plus
only the four named removed legacy shapes: `public.byos_configs`,
`public.contact_suppressions`, `public.usage_bucket_settlements`, and
`public.usage_records`. Adding or removing a table now fails the audit gate until its capability
disposition is recorded.

---

## 4. Non-PostgreSQL durable-state ledger

### 4.1 R2: five physical buckets, seven bindings

| Physical bucket / binding | Current key families and data | Implemented invariant | Retention/topology |
|---|---|---|---|
| `relayapi-media` / `MEDIA_BUCKET` | Organization media originals; inbox participant avatars under `{organization}/{organization|workspaces/{workspace}}/conversations/{conversation}/avatar` | Database rows and transient avatar keys carry tenant/workspace ownership; erasure deletes the exact subject path | Objects expire after 30 days; incomplete multipart uploads abort after one day |
| `relayapi-avatars` / API `AVATAR_BUCKET` | Social-account avatars at `account/{accountId}/avatar` | Stable API URL is independent from the object key; account/workspace/tenant cleanup deletes the exact object | Durable for the account lifetime; incomplete multipart uploads abort after one day |
| `relayapi-avatars` / app `AVATARS_BUCKET` | User avatars under `user/{id}/`; organization logos under `organization/{id}/` | User deletion and tenant deletion drain bounded prefixes; public readers use stable application routes | Durable for subject lifetime; incomplete multipart uploads abort after one day |
| `relayapi-media-thumbnails` / `THUMBNAIL_BUCKET` | Durable optimized post/external-post previews | Rows store explicit provider/bucket/region/key locators; deletion persists external cleanup before removing the locator | Never expires while its owning row requires the preview; incomplete multipart uploads abort after one day |
| `relayapi-queue-rescue-ledger` / API + app `QUEUE_RESCUE_BUCKET` (two bindings) | Private application-encrypted terminal queue envelopes by typed subject | Origin identity and subject locators are persisted; erasure and attempt-40 terminalization use the same fence without self-handoff | 30-day object maximum; one-day incomplete-multipart abort |
| `relayapi-public-assets` / `PUBLIC_ASSETS` | Immutable public dashboard/landing build assets only | The registry and verifier reject treating this binding as a tenant-upload store | Durable build assets; one-day incomplete-multipart abort |

The binding-to-physical-resource map is part of the contract. Auditing only binding names would
miss that `AVATAR_BUCKET` and `AVATARS_BUCKET` share one bucket with deliberately disjoint typed
key spaces.

R2 jurisdiction is immutable after bucket creation. The selected `default` launch posture remains
one home region without a routing directory, but every database object reference carries an
explicit storage locator so adding jurisdiction-specific buckets later is additive. Hosted and
self-host provisioning verify the one-day all-prefix incomplete-multipart rule on every bucket;
media and rescue retain their independent 30-day object-expiry rules.

### 4.2 KV: authoritative data must never hide here

| Key family | Purpose | Lifecycle/erasure decision |
|---|---|---|
| `apikey:{hash}` including negative tombstones | Hashed API-key authorization cache: org, principal, permissions, grants, entitlement | TTL-bound; invalidate on key/principal/member/grant/tenant change |
| `dashboard-key:{organizationId}:{userId}` | AES-256-GCM dashboard bearer envelope bound to the exact pointer name | Twelve-hour maximum with renewal window; delete on membership, principal, user, or tenant revocation; raw bearer value never resides in KV |
| `control:maintenance:v1` | Non-personal baseline/cutover safety authority shared by API, app, and cutover tooling | Preserved across cache clears; changed only by the typed cutover procedure |
| `org-summary:{organizationId}` | Organization name, slug, and logo summary | Ten-minute TTL with update/admin/delete invalidation and tenant purge coverage |
| `org-settings:{organizationId}` | Workspace-policy revision hint | TTL-bound; invalidate on policy/tenant change |
| `ws-valid:{organizationId}:{workspaceId}` | Workspace-validity authorization hint | TTL-bound; invalidate on workspace state, membership/grant, and tenant changes |
| `queue-schedule:{organizationId}` | Derived schedule projection | Five-minute cache only; `public.queue_schedules` is authoritative and every mutation/delete invalidates the key |
| `pending-secondary:{organizationId}:{platform}:{token}` | Encrypted OAuth access/refresh token plus provider profile and initiating principal/scope | Ten-minute one-time state; delete on consume/error/expiry and locate by organization/principal |
| `pending-oauth:{state}` | Headless OAuth result including organization, principal, workspace, and provider result | Ten-minute one-time state; delete on consume/expiry and on identity/tenant erasure where enumerable |
| `platform-account:*` and `ig-sender-id:*` | Provider-identity → tenant/account routing, including negative entries | Short TTL; account/tenant invalidation and no credential/payload fields |
| `sync-dedup:*`, `msg-dedup:*`, and `outbound-mid:*` | Webhook/message dedupe and own-message recognition | Short TTL; typed account/message locator, bounded exception during subject erasure |
| `inbox-posts:*` and `inbox-comments:*` | Provider post/comment response caches containing names, text, avatars, and IDs | Short TTL; account/contact/post/tenant invalidation and explicit personal-data classification |
| `analytics-overview:*`, `analytics-posts:*`, and `best-time:*` | Derived metrics and provider post identifiers | Canonical one-family prefixes with finite TTL; account/post/tenant invalidation; PostgreSQL remains authoritative |
| `ad-discovery:*` | Provider account/audience discovery admission markers | One canonical ten-minute family; account/tenant locator and invalidation |
| `r2-presign:{expiry}:{storageKey}` | Presigned media URL carrying bucket/object authority | Maximum 50-minute TTL; delete with object/media/subject and never treat as harmless opaque cache data |
| `token-refresh-notified:*` | Account alert dedupe | Seven-day maximum; delete by account/tenant invalidation |
| `usage:*` and `usage-warning:*` | Monthly usage projection and notification suppression | 35-day bound; organization deletion; exact quota authority remains PostgreSQL |
| `short-link:{shortCode}` | Short-link destination URL projection | 24-hour TTL and bounded link/workspace/tenant invalidation; PostgreSQL remains authoritative |

This list is a source-derived family ledger, not a promise that TTL alone is erasure.
`kv-privacy-source-coverage.test.ts` statically resolves every production key passed to
`KV.get`/`put`/`delete`, requires an explicit runtime-validated family assertion for heterogeneous
dynamic invalidation lists, and compares the result exactly with all 25 registered KV stores. A
new or unresolved prefix fails the gate.

### 4.3 Queue topology and terminal loss

There are nine main consumer families (`media-cleanup`, `publish`, `email`, `refresh`, `inbox`,
`tools`, `ads`, `sync`, `customer-webhooks`), nine matching DLQs, and one rescue consumer.

Configured delivery counts are not application bounds. Cloudflare Queues are at-least-once, retry
deliveries are charged, and overlapping producers can enqueue the same logical work again.

| Layer | Configured behavior | Implemented application bound |
|---|---|---|
| Main | 3 retries for most; 5 for email/inbox/customer webhooks | Keep per-family budgets; consumer idempotency remains mandatory |
| DLQ | 3 retries, then rescue | Write PostgreSQL failure ledger; if unavailable, write deterministic R2 envelope |
| Rescue | `max_retries=40`; application attempts preserve the original identity and never create a fresh rescue message | Alerts at attempts 3, 10, 25, and 40; application attempt 40 emits sanitized terminal evidence, ACKs, and permits payload loss. Capped jittered backoff is under 9.1 hours nominally |

Alerts go to a configurable operations webhook, fall back to the deployment admin email, and always
emit structured Workers Logs metadata. Payloads must not be written to logs.

### 4.4 Workers Logs, Durable Objects, and infrastructure bindings

- **Workers Logs:** API and app persist 10%-sampled invocation/custom logs; docs persists
  10%-sampled framework logs with automatic invocation logs disabled. The registry records
  Cloudflare-owned retention (three days on Free, up to seven on Paid), field
  allowlists/redaction, and the fact that subject erasure cannot selectively delete sampled logs.
- **`RealtimeDO`:** the namespace is keyed by organization, but the class uses WebSocket
  Hibernation only and never calls `ctx.storage`; no durable application rows exist today. Keep the
  namespace and its append-only migration tag lane in the topology inventory.
- **Hyperdrive:** one shared configuration points both Workers at one origin. Transaction-mode
  pooling is safe for current lock sites. Add a source test: any bare `FOR UPDATE` must be inside an
  explicit transaction, and no provider/network await may occur before the locked write completes.
- **Rate limits, Images, Media Transformations, Workers AI:** these are not record stores, but their
  namespace/config identities and failure modes belong in the reproducibility ledger.
- **BYOS/external providers:** record object deletion responsibility, credential rotation, replay
  boundaries, provider retention, and failure escalation. Workspace erasure must not silently skip
  `storage_provider='byos'`.

---

## 5. Findings by independent lens

### 5.1 Blank-slate shape

#### Remove `usage_records`, preserve and repair usage administration

`usage_records` is a compatibility projection with dashboard readers and no row-producing writer.
The actual meter writes `usage_buckets`.

After removal:

- admin organization/subscription reads use an API-owned entitlement service backed by
  `billing_periods` plus their exact-window `usage_buckets`;
- `billing_periods` snapshot source, billability, quota mode, allowance, price, currency, and
  provider-cycle anchor; the bound bucket mirrors only quota shape and maintained counters;
- a mid-cycle entitlement change splits the period and carries the remaining provider-cycle
  allowance into its successor without rewriting already committed usage;
- the dashboard calls the service through `@relayapi/sdk`;
- no empty eager bucket is created solely for display.
- remove the reviewed `tenantPurgeTable("public", "usage_records")` registry entry and its derived
  contract expectation with the table.

The feature renders accurate usage instead of zero.

#### Remove `byos_configs`, preserve customer-owned object storage

The mutable singleton combined physical routing, credential material, probe state, and current
preference. Updating it could reinterpret an existing object's bucket/key through a new endpoint or
credential, and a failed test could damage the last working configuration.

After removal:

- `storage_locations` is the immutable physical endpoint/bucket/region/prefix definition; a
  location change inserts another row and activation retires the former row atomically;
- `storage_credentials` appends encrypted versions with a fenced
  `staged → active/failed` and `active → retired` lifecycle;
- the probe runs against the exact staged version outside the database transaction, then a
  tenant-scoped advisory lock and probe token fence activate it; failure terminalizes only the
  staged candidate, leaving the old active authority unchanged;
- every BYOS `media` row construction-enforces its organization-safe location, bucket, region, and
  credential version through composite foreign keys;
- ordinary read/write/delete/presign operations accept only the pinned active or retired
  credential; tenant erasure also walks staged/failed historical authorities because a failed probe
  may have written an object before cleanup became indeterminate;
- the existing configuration/test/upload/read/delete/erasure API capability and SDK surface remain
  intact. The implementation is smaller conceptually because “where is this object?” is immutable
  history rather than mutable current configuration.

#### Remove `usage_bucket_settlements`, preserve exact-once overage settlement

The settlement satellite duplicated lifecycle state already needed by the authoritative billing
window. `billing_periods` now owns the fenced
`open → closed → claimed → settled/released → closed` lifecycle, immutable USD price snapshots,
and final invoice reference. `billing_operations.billing_period_id` is unique, and Stripe uses a
stable period-derived idempotency key. Cancellation shortens the open window but leaves it eligible
for the ordinary final claim. The exact-once settlement capability therefore survives with one
fewer state machine and without coupling mutable usage counters to provider retries.

#### Remove `contact_suppressions`, preserve the absolute veto

`contact_consent_states` is already the authoritative projection of the immutable event ledger.
Out-of-order events that lose the projection CAS touch neither state nor suppression, so the
separate table adds no concurrency safety.

After removal:

- `getAllowedRecipientHashes` treats denied state as the veto when a grant is not otherwise
  required;
- service-reply authorization queries denied `service` state;
- an index supports `(organization_id, channel, purpose, identifier_hash)` denied lookups;
- contact deletion nulls the contact reference but preserves the organization-global denial
  matcher.
- remove `contact_suppressions` from both the reviewed `WORKSPACE_PURGE_TABLES` and tenant purge
  registries, with their derived contract expectations.

Truth table and user-facing opt-out behavior remain unchanged.

#### Keep the two typed erasure families

A flat `erasure_jobs(kind, target_id, workflow_payload)` abstraction is not optimal:

- workspace jobs require a composite workspace/organization/scope FK;
- tenant receipts intentionally have no organization FK so they survive deletion;
- status and completion invariants differ;
- generic JSON weakens construction-time typing;
- a shared core plus two subtype tables still totals four tables and adds joins.

Keep four typed tables. Extract shared TypeScript transition code and CHECK builders; reconsider a
shared database core only if a third erasure target appears.

#### Keep `automation_step_runs`

`automation_node_executions` is a hot claim/CAS row with lease and request-boundary fields.
`automation_step_runs` is a public, append-only timeline with node kind, entry/exit ports, duration,
`graph_changed`, three time-series indexes, and BRIN. Merging loads analytical indexes onto the
claim path and removes no duplicated capability.

Keep both, but add direct organization identity and retention to the timeline.

#### Reshape phone operations, not every async table

`whatsapp_phone_numbers` contains two independent nullable state machines for provisioning and
release. Keep the phone resource and move those operations into typed child operation tables.
Do not force publish attempts, outboxes, poll leases, and token-refresh grants into the same
abstraction: their ambiguity and authority differ.

#### Give authorization and attribution a stable principal

Today workspace grants live in credential metadata, dashboard credentials hardcode `all`, and an
invite token’s workspace list disappears as authority after redemption. API keys also double as
idea-comment actors, so credential rotation can erase attribution.

Add a stable organization principal root with typed member and service subtypes, an `all|selected`
scope mode, and normalized principal-workspace grants. Membership remains the role/owner authority;
credentials remain revocable authenticators. Both point to the stable principal, so invite
redemption can persist access and comments/activity can retain attribution without retaining a
usable key. This is a load-bearing common identity, not an attempt to merge member and service
credential lifecycles.

#### Move authoritative scheduling state out of KV

`queue-schedule:{organizationId}` has no TTL and contains schedule names, timezones, and slots.
That is product state, not a cache. Represent the schedule in a tenant/workspace-scoped PostgreSQL
resource with ordinary API/SDK lifecycle; KV may contain only a finite-TTL projection. This adds
authority where a hidden external row currently exists rather than adding a second source of truth.

#### Make public visits transactional rather than counters plus `waitUntil`

`ref_urls` has no destination, and its authenticated click endpoint commits the counter before
best-effort automation admission. Keep the definition, add a validated HTTPS-or-landing
destination, and add a compact idempotent visit occurrence/outbox relation. The public ref, QR, and
landing conversion paths all use that transaction; aggregate counters remain derived/maintained
read fields rather than the only evidence.

#### QR codes earn a table because multiplicity is a feature

One ref URL may have separately tracked storefront, flyer, or campaign QR codes. Keep `qr_codes`,
add a human label/campaign key and scope-safe uniqueness, route scans through the QR identity, and
retain `scan_count` per placement. Generate the image deterministically on read and remove
`image_r2_key`; no represented visual-variant state justifies durable image objects. The same
baseline change removes `deleteQrCodeObjectBatch`, removes `"qr_codes"` from the
`revoke_external_resources` cursor phase union, changes the initial cursor phase to
`"account_dependents"`, and removes the associated QR object-key family. There is no top-level QR
workspace-erasure step-key.

### 5.2 What the squash does not fix

#### P0 — Stripe recovery can poison-loop and starve financial work

`stripe-webhooks.ts:682-694` claims any `pending|failed` row plus expired processing rows, uses
`LIMIT 25`, has no due time, and has no ordering. The atomic claimant already increments
`attempts` and `lease_token`; the defect is that eligibility and escalation ignore both, so a
failed handler is immediately eligible next minute.

Nominal amplification is 25 × 1,440 = **36,000 attempts/day**. Twenty-five permanent failures may
occupy every page indefinitely, so later valid events are never selected. Some handlers perform
Stripe retrieves/lists, compounding cost.

Target:

- retain the existing attempt counter and lease-token fence;
- add `next_attempt_at` and error class;
- ordered claim by `(next_attempt_at, id)`;
- transient backoff;
- permanent terminal state;
- durable manual review after 12 attempts or 24 hours;
- no deletion of unresolved financial evidence.

#### P0 — account revocation can retain credentials forever

The current claim self-assigns `attempts`, uses the lease expiry as ownership, and can repeat a
successful provider call after a local write failure. Persistent 429/5xx responses leave the
account disconnecting and the active provider credential stored indefinitely.

Target:

- remove the credential from active account use immediately;
- keep only a restricted encrypted revocation payload;
- use a real lease token, attempt counter, pre-call boundary, and known/unknown result;
- retry provider cleanup for seven days, then manual review and cleanup-payload redaction.

#### P0 — analytics retries corrupt the time series

`post_analytics` has only a non-unique `(post_target_id, collected_at)` index. A crash after inserting
history but before updating freshness repeats provider reads and inserts a duplicate. Best-time
selection can be nondeterministic when timestamps tie, although its `Map` collapses tied rows per
target. The proven inflation is in public timeline readers: provider rows store cumulative totals,
but the readers sum each snapshot as though it were a delta, so totals grow even without a retry.

History is a fixed feature: public analytics routes read time ranges, and best-time logic derives
latest values from historical rows. Declare rows to be cumulative snapshots, use deterministic
`UNIQUE(post_target_id, observation_window_start)`, upsert the window, select latest/difference
snapshots correctly in timeline readers, and make ties deterministic. Consolidate
`enqueueMetricsRefresh` (`refresh_external_metrics_batch`) and
`enqueueExternalPostRefresh` (`refresh_metrics`) behind one canonical reservation-based poll
scheduler with a generation fence.

#### P0 — automation analytics reports failures as successes

The runner maps handler result `fail` to persisted `failed`; the CHECK permits `failed` and forbids
`fail`. `_automation-insights.ts:359` compares the persisted column to `'fail'`, so the predicate is
true for every legal row and `successes = count(*)`.

Fix the query and add a derived test that readers never compare a constrained column against a
literal outside its database domain.

#### P0 — API bearer invites cannot be accepted

The API creates and documents a one-time bearer token and returns `/invite/{rawToken}`. There is no
redeem endpoint. The dashboard page treats the value as a Better Auth invitation ID, so the two
systems do not interoperate.

Complete bearer redemption as one transaction:

1. authenticate the recipient;
2. hash and lock/CAS the unused, unexpired token;
3. revalidate the issuer still has sufficient role; owner links require the issuer still be owner;
4. create membership, its stable authorization principal, and durable principal workspace grants;
5. set `used_by`/`used_at` atomically;
6. record issuer, redeemer, role, scope, grants, and timestamps.

An owner token adds a co-owner. Owner tokens expire after 24 hours; other roles keep the documented
seven-day default. `invite_token_workspaces` is only immutable invitation evidence: it is copied
into normalized principal grants at redemption. Dashboard and service credentials derive their
scope from that durable authority rather than hardcoding `workspace_scope: 'all'`.

#### P0/P1 — half-built capabilities are not removable debt

- `subscription_lists` has no writer, while live automation subscribe/unsubscribe nodes validate
  list IDs that no API client can create.
- `post_tags` has no live read/write path.
- `landing_pages` has no CRUD, public render, or conversion path.
- `qr_codes` has erasure code but no creator/renderer.
- `ref_urls` CRUD is live, but the current authenticated “click” endpoint assumes a redirect
  already happened: the table has no destination, no public route, and increments before
  best-effort automation admission.
- AI knowledge bases/documents have public CRUD, but chunks have no writer/search path and agents
  have no live runtime.
- BYOS now has a product configuration/probe path and shared upload/read/delete/erasure routing;
  the freeze gate verifies immutable historical locators and failure-safe rotation rather than
  treating the former mutable singleton as completion.

Complete all of them in the target schema and API/SDK surface; do not move them “out of freeze
scope.”

#### P1 — two known-not-sent paths still retry without a review horizon

`billing_operations` stores an hourly retry time but is only processed around the daily invoice
run. Each unknown reconciliation can paginate Stripe invoice items from operation creation onward,
and neither attempt count nor age stops automatic work. Reuse the financial 12-attempt/24-hour
manual-review rule without deleting evidence.

Customer-webhook’s eight-attempt budget starts only after the HTTP request boundary. Indeterminate
DNS and signing-key decryption failures decrement the HTTP attempt and reschedule indefinitely.
Keep those known-not-sent failures outside the eight HTTP attempts, but add backoff and a 24-hour
`blocked`/operator-repair circuit breaker.

#### P2 — cron defects are real but not priority one

- `0 9 * * 1` is Sunday on Cloudflare, not Monday. Use `MON`.
- The weekly digest is outside `runScheduledTasks`, so failures are not captured by the common task
  logger.
- `0 0 1 * *` has no handler branch and should be removed with the test that asserts its no-op.
- `processAutomationInputTimeouts` is a documented no-op and should leave the every-minute list.
- Peak overlap creates 47 promises across separate Cron-trigger invocations: 26 every-minute
  entries (25 real), 12 five-minute entries, six daily entries, two direct half-hour promises, and
  one weekly promise. Each `runScheduledTasks` invocation owns its own four-worker iterator and
  15-minute wall budget. The direct tail risk is the fixed order inside the 26-entry every-minute
  invocation; the 47-promise peak creates cross-invocation database/provider contention.

Use singleton admission, staggered phases, per-task duration/oldest-due telemetry, and equal
round-robin tenant caps.

### 5.3 Invariants by construction

#### Replace naming heuristics with curated domain contracts

The current invariant audit primarily recognizes names ending in `status`, `state`, `phase`,
`outcome`, `waiting_for`, and numeric fields. Important app-owned domains such as
`custom_field_definitions.type`, `automation_entrypoints.kind`, `automation_secrets.kind`,
`invite_tokens.role`, inbox direction, billing-outbox kind, and one-time capability kind are
invisible.

Add `DOMAIN_CONTRACTS`, requiring every type/kind/role/direction-shaped durable column to declare
exactly one classification:

- `closed`: one canonical value set, DB CHECK, Zod/API equality test, and exhaustive runtime switch;
- `provider_passthrough`: open text with provider/rationale;
- `externally_owned`: Better Auth/provider domain intentionally not constrained locally.

Stale, duplicate, or missing entries fail the build.

#### Make tenant purge a total graph proof

The existing organization-deletion test discovers scalar `organization_id` columns and validates
some cascade paths. A wired `shared_receipts` step already deletes sole-owner rows and
`array_remove`s a departing organization from shared `queue_failures` and
`inbound_webhook_events`; that is real runtime coverage. The structural proof still misses:

- deriving and validating the semantics of `organization_ids text[]` instead of trusting a
  hand-maintained handler/test pair;
- ownerless personal data such as `auth.verification`, Stripe payloads, and email delivery rows;
- `automation_scheduled_jobs` rows where every nullable parent is null.

For every table, require exactly one:

1. direct typed purge handler;
2. an FK path to a purged parent where every hop cascades/sets null intentionally;
3. an array/shared-owner handler;
4. a documented retained-record exception with redaction and horizon.

The same proof must exist for user and workspace deletion.

#### Derive async conformance

Every table with claim/lease/freshness/request-boundary signatures declares one contract:

- external mutation;
- transactional outbox;
- poll/read synchronization;
- durable inbox/receipt;
- pure orchestration.

Fail if a freshness column doubles as a lease, a provider mutation lacks a persisted pre-call
boundary, pure orchestration carries an ambiguity boundary, or a bare `FOR UPDATE` escapes a
transaction. A durable inbox/receipt must atomically accept and deduplicate, lease processing,
finish in terminal/manual state, and redact/delete its payload on a declared clock; this is the
contract for Stripe, inbound-provider, and automation-webhook receipts rather than misclassifying
them as polls.

#### Specific DDL invariants

- `automation_entrypoint_daily_counts.day` becomes PostgreSQL `date`.
- `automation_step_runs` gains projected `(organization_id, scope_key)` and a composite tuple
  proving its `run_id` and redundant `automation_id` agree with the authoritative run.
- `automation_scheduled_jobs` gains projected `(organization_id, scope_key)` plus composite FKs
  tying each job type to its authoritative run or automation+entrypoint; a null-combination CHECK
  alone is insufficient.
- consent channel and purpose stay extensible text but must equal `lower(btrim(value))`.
- consent identifier rows carry HMAC key version.
- consent authority has one logical identifier independent of key version. Rotation atomically
  rewrites all current authority rows to the new active hash before retiring old-version lookup;
  tests prove `v1 deny → rotate → v2 grant` and `v1 deny → rotate → reimport`.
- invite scope/role and used fields are constrained; token workspace IDs move from JSON to a
  tenant-FK relation and redemption copies them into durable principal grants.
- user/member and service-key actions resolve to stable typed principals that survive credential
  rotation; `idea_comments` and `idea_activity` reference those principals.
- `idea_comments` adds unique `(id, idea_id)` plus composite self-FK
  `(parent_id, idea_id) → (id, idea_id)`; the one-level nesting rule remains a cheap derived/runtime
  test unless deeper replies become a represented capability.
- `idea_tags` adopts parent-projected scope like `post_tags`: rewrite the two read predicates and
  two writes in `ideas.ts`, replace its index, and remove only its reviewed
  `WORKSPACE_PURGE_TABLES` entry/contract so the composite idea FK cascade owns workspace purge.
  The tenant registry still keys on `organization_id` and remains.
- contacts store app-normalized E.164 `phone_canonical` with format CHECK and scoped partial
  uniqueness where phone is an identity authority; every linker uses it rather than raw equality
  or ad hoc digit stripping.

---

### 5.4 Privacy, erasure, retention, and legal holds

#### Personal data outside the database

1. **User avatars and organization logos are permanent orphans today.** The dashboard writes
   `{userId}.{ext}` and `org-{orgId}.{ext}` into the shared public avatar bucket. User deletion does
   no R2 work; tenant deletion deletes only `avatars/{accountId}` and `{organizationId}/` prefixes.
   Adopt typed prefixes and explicit purge steps.
2. **Inbox participant avatars are missed but bounded.** They are written as
   `avatars/{conversationId}` in the finite-lifecycle media bucket and are not deleted by workspace
   or tenant erasure. Add the key to conversation/tenant purge; document the approximately 30-day
   infrastructure fallback honestly.
3. **Short-link targets remain in KV indefinitely.** Add TTL and best-effort delete; PostgreSQL
   remains authoritative.
4. **Workers Logs are personal-data stores.** They contain linkable operational identifiers and
   cannot be selectively erased. Use structured allowlisted fields, never message bodies/tokens,
   record the external retention horizon, and make this an explicit erasure exception.

#### Residual database personal data

- `broadcast_recipients` stores raw recipient identifiers and variables. Both are needed until the
  provider boundary but not forever. Use encrypted nullable fields, a non-identifying display mask,
  `pii_erased_at`, and a state-aware shredder. Contact deletion cancels pre-boundary rows; unknown
  in-flight outcomes remain fenced and are never auto-retried.
- Inbox conversations/messages retain profile names, platform IDs, avatar URLs, authors, and text
  after `contact_id` becomes null. Nulling the FK must not make later subject discovery impossible.
  Add a stable protected subject locator, redact profile fields, and keep message text only for a
  documented bounded purpose.
- `auth.verification` contains raw identifiers/tokens and already has an expiry index but no drain.
  Implement the drain and identity-erasure path.
- `email_deliveries` needs organization ownership and terminal retention.
- Stripe payloads need a tenant-owned, redactable processing record plus a thin global event-ID
  replay receipt. Successful payload redaction remains immediate; failed/manual payloads receive a
  bounded escalation horizon.

Any public response that currently exposes a raw identifier after it becomes nullable/redacted is a
breaking API/SDK change and must be versioned or made nullable deliberately.

#### Derived personal-data and retention matrix

This is the launch inventory, derived over all 143 active tables rather than a sample of risky
columns. A row may group tables only when locator, purge, horizon, and hold treatment are the same.
“Entity” means until explicit resource/parent deletion; it is not a hidden promise of indefinite
retention. Horizons are product defaults for operator/counsel review, not claims that a law always
requires or permits that duration.

Legend: **H** = a tenant/workspace hold pauses destructive work; **M** = only minimized/redacted
evidence may survive; **N** = a hold never extends the secret/ephemeral data; **F** = financial
policy plus case-specific hold. User/contact erasure still removes direct identity as described
above.

##### Auth and tenant control plane

| Exact table(s) | Personal/sensitive data | Current locator/lifecycle defect | Target horizon and hold |
|---|---|---|---|
| `auth.user` | Name, email, image, ban reason | User locator works, but public avatar is missed | Account lifetime; erase identity/avatar, retain only justified pseudonymous audit reference (**M**) |
| `auth.session` | Bearer token, IP, user agent, impersonator | User cascade and expiry, but no total expiry drain proven | Exact expiry and immediate user deletion; never held (**N**) |
| `auth.account` | Provider identity, access/refresh/ID tokens, password | User cascade; credential lifetime follows identity | Revoke/shred at unlink/user deletion; never extend credentials (**N**) |
| `auth.verification` | Raw identifier and verification/reset value | No usable subject locator; expiry index has no drain | Add locator; drain within 24 hours of expiry and on identity erase (**N**) |
| `auth.apikey` | Credential hash, creator/principal, permissions, metadata | Tenant locator; creator semantics and JSON grants are incomplete | Active/explicit expiry only; normalized principal grants; synchronous KV invalidation (**N**) |
| `auth.organization`, `public.workspaces` | Names, slug/logo, description | Tenant/workspace roots; object key spaces are incomplete | Entity lifetime; typed R2 purge; deletion may pause under hold (**H**) |
| `auth.member` | User↔tenant role and authorization | User/tenant locators; workspace authority is not durable | Membership lifetime; stable principal + normalized grants; minimized role evidence only (**H/M**) |
| `auth.organization_creation_reservation` | User and desired slug | Ten-minute expiry is only opportunistically cleaned | Total ten-minute drain (**N**) |
| `auth.invitation` | Invitee email, inviter, role | Expiry exists; terminal rows have no total drain | Active until expiry; delete terminal/expired rows after 30 days (**H/M**) |
| `public.workspace_tombstones` | Workspace/org/operation identifiers | Intentionally survives workspace deletion | Minimized non-PII authorization receipt; service lifetime with named owner (**M**) |
| `public.workspace_erasure_jobs`, `public.workspace_erasure_steps` | Requester, snapshot, cursor, errors, object/provider locators | Job survives; steps cascade; no terminal clock | Raw while active/held; redact on completion, delete steps after 90 days, retain tombstone (**H/M**) |
| `public.organization_settings` | Updater attribution | Tenant-owned; updater can become null | Entity lifetime; pseudonymize attribution on identity erase (**H/M**) |
| `public.tenant_deletion_jobs`, `public.tenant_deletion_steps` | Requester, audit/cleanup payload, cursor, errors | Job deliberately survives tenant; steps have no terminal TTL | Raw while active/held; redact at completion, delete steps after 90 days, retain minimal receipt (**H/M**) |
| `public.invite_tokens` | Creator/consumer, token hash, grants | Tenant/user locators; no terminal drain | Delete 30 days after use/revocation/expiry; never retain usable token material (**H/M**) |

##### Connections, publishing, media, and customer webhooks

| Exact table(s) | Personal/sensitive data | Current locator/lifecycle defect | Target horizon and hold |
|---|---|---|---|
| `public.social_accounts` | Provider IDs/profile/avatar, encrypted tokens, metadata | Tenant/workspace/account locators | Profile for entity lifetime; shred active credentials on disconnect even if profile evidence is held (**H/N**) |
| `public.account_revocation_jobs` | Copied token ciphertext, provider response/error | Account/tenant locator; retry can persist forever | Destroy ciphertext on success or seven-day escalation; redacted outcome 90 days (**M/N**) |
| `public.token_refresh_operations` | Account/token version, provider-boundary error | Account cascade; no TTL | Terminal 30 days; unknown minimized evidence up to 90 days (**M**) |
| `public.post_threads`, `public.posts` | User content, notes, overrides, attribution | Tenant/workspace and parent locators | Entity lifetime; null/pseudonymize user attribution; purge on tenant/workspace delete (**H**) |
| `public.thread_executions`, `public.post_targets`, `public.publish_attempts` | Provider IDs/URLs/effects/errors | Parent/tenant locators; no low-level TTL | Keep target result with post; delete attempts/execution detail 90 days after terminal (**H/M**) |
| `public.telegram_connection_challenges` | Chat ID/title and scope | Fifteen-minute expiry | Exact expiry or immediate terminal deletion (**N**) |
| `public.publish_outbox` | Arbitrary payload and notification content | Tenant locator; dispatched drain exists | Preserve 30-day dispatched maximum; redact payload earlier when possible (**H**) |
| `public.post_recycling_configs` | Content variations/schedule | Parent/tenant locator | Entity lifetime (**H**) |
| `public.recycling_occurrences` | Generated post relation/error | Parent locator; no TTL | Terminal 90 days; aggregate stays on config (**H/M**) |
| `public.media` | Filename, uploader, URLs, object keys and bytes | Tenant/workspace locator; several external key schemes | Metadata/thumbnail entity lifetime; original under declared media policy; explicit region/bucket/key; hold-safe bucket/lifecycle path (**H**) |
| `public.webhook_endpoints` | Customer URL and secret ciphertext | Tenant/workspace locator | Endpoint entity lifetime; rotate/shred secret at disable/delete even under hold (**H/N**) |
| `public.webhook_events`, `public.webhook_deliveries`, `public.webhook_logs` | Event payload and per-attempt response/error history | Tenant/workspace/parent locators; current terminal cleanup is seven days | Seven-day terminal history; typed attempt rows; redact tokens/headers (**H**) |
| `public.post_analytics` | Linkable post metrics | Parent locator; unbounded | Deterministic snapshots; rolling 25 months or parent deletion (**H**) |
| `public.connection_logs` | Provider/account IDs and free-form message/snapshot | Tenant locator; unbounded | Allowlist/redact on write; 90 days (**H/M**) |

##### Operations, billing, and reliability

| Exact table(s) | Personal/sensitive data | Current locator/lifecycle defect | Target horizon and hold |
|---|---|---|---|
| `public.api_request_logs` | Tenant/key linkage and path | Tenant locator; 90-day pruning is hosted-invoice-only | Deployment-neutral 90 days; route template only, never raw query/token (**H**) |
| `public.queue_failures` | Arbitrary queue payload/error and shared owner array | Shared-owner purge exists; payload has no TTL/redaction | Encrypted/redactable payload 30 days; redacted metadata 90 days (**H/M**) |
| `public.email_deliveries` | Provider ID and indirect recipient linkage | No tenant/user/contact locator or TTL | Add locators; terminal 30 days; raw envelope lives in encrypted DB row, not Queue (**H/M**) |
| `public.idempotency_receipts` | Key/request hashes and encrypted response | Tenant locator; 30-day expiry/reconciler exists | Preserve exact 30-day replay window; never held (**N**) |
| `public.one_time_capabilities` | Encrypted privileged payload | Tenant locator and caller expiry | Exact expiry/claim deletion; never held (**N**) |
| `public.operator_resolution_evidence`, `public.operator_resolution_notes` | Closed reason code/digest/actor plus encrypted free-form rationale | Append-only evidence must outlive targets, but rationale conflicts with indefinite retention | Evidence keeps only the closed code/digest and sanitized state transition; encrypted note is key-rotated and deleted exactly 90 days after resolution, never hold-extended (**N/M**) |
| `public.organization_subscriptions` | Stripe customer/subscription/item IDs | Tenant current-state row | Active entitlement lifetime; history belongs in invoice/operation evidence (**F/M**) |
| `public.subscription_checkout_operations` | Stripe IDs, checkout URL, errors | Tenant locator; no terminal TTL | Redact URL at expiry; terminal operation 90 days (**M**) |
| `public.stripe_events` | Full payload and customer/object IDs | Global row lacks tenant erasure/redaction | Thin global event-ID receipt one year; successful payload immediate redaction; failed/manual payload 24-hour escalation (**M/F**) |
| `public.billing_outbox` | Billing payload/error | Tenant locator; no terminal TTL | Redact/delete terminal payload after 90 days; canonical financial rows retain evidence (**F/M**) |
| `public.usage_buckets`, `public.usage_reservations` | Tenant usage/idempotency/source | Tenant locator; no historical horizon | Rolling 25 months; invoiced aggregate moves to financial evidence (**F**) |
| `public.usage_records` | Duplicate usage projection | No writer/TTL | Remove after readers use `usage_buckets`; no capability loss |
| `public.storage_locations` | Endpoint, bucket, region, and key prefix | Immutable tenant locator; retained locations can reveal customer topology | Keep while media or cleanup pins the location; retire on topology change; delete after final pin/tenant cleanup (**M**) |
| `public.storage_credentials` | Encrypted access-key ID and secret plus probe/rotation state | Exact version is required for historical objects; mutable singleton rotation could destroy the last working authority | Encrypted append-only versions; failed stages never replace active; delete after the final pin and unresolved cleanup drain; credentials are minimized rather than preserved as hold evidence (**N/M**) |
| `public.invoices` | Periods, Stripe IDs/hosted URL, amounts | Tenant deletion currently removes; policy unspecified | Default seven years after close, configurable by jurisdiction/operator; expire hosted URL (**F**) |
| `public.billing_periods`, `public.billing_operations`, `public.dunning_events` | Entitlement/price snapshots, Stripe IDs, amounts, descriptions, responses/errors | Tenant/parent locators; period and operational horizons differ | Period aggregates 25 months after close and only after child usage/operation drain; redacted invoice evidence for the configured horizon; operational detail 90 days (**F**) |

##### Users, inbox, contacts, consent, and broadcasts

| Exact table(s) | Personal/sensitive data | Current locator/lifecycle defect | Target horizon and hold |
|---|---|---|---|
| `public.user_preferences` | Timezone/language | User cascade | User lifetime; immediate user deletion (**N**) |
| `public.notifications` | User, title/body/arbitrary data | User/tenant locator; unbounded | Read 90 days, unread 180 days, absolute one-year cap (**H/M**) |
| `public.notification_preferences` | User/org preference profile | User/tenant locator | Membership lifetime (**N**) |
| `public.inbox_conversations`, `public.inbox_messages` | Participant/author IDs, names, avatars, text, attachments, platform data | Tenant/workspace locator; contact FK can null and lose subject discovery; unbounded | Protected subject + avatar locator; delete/redact 90 days after close by default; subject erasure works after FK null (**H**) |
| `public.inbox_conversation_notes` | Internal text and actor | Parent locator; unbounded | Conversation horizon or one year, whichever is shorter; pseudonymize actor (**H**) |
| `public.inbound_webhook_events` | Encrypted raw payload, signatures/errors, shared owners | Shared-owner purge exists; 7/30/90-day payload clocks exist | Preserve 7-day complete, 30-day failed, 90-day manual payload clocks; minimized receipt one year (**H/M**) |
| `public.inbox_event_effects` | Replay payload, provider IDs/error | Parent/tenant locator; unbounded | Raw replay 30 days; redacted outcome 90 days (**H/M**) |
| `public.auto_post_rules` | Feed URL, content template, accounts | Tenant/workspace locator | Entity lifetime; reject/scrub embedded URL credentials (**H**) |
| `public.auto_post_feed_items` | Source/canonical URL and error | Parent locator; unbounded | Terminal 90 days; longer dedupe uses canonical hash only (**H/M**) |
| `public.whatsapp_phone_numbers` | Phone/provider IDs, checkout/provision/release payload and token ciphertext | Tenant locator; two embedded state machines, no TTL | Split operations; phone until release; shred secrets/URL within seven days terminal; redacted evidence one year (**H/N**) |
| `public.custom_field_definitions` | Tenant-defined names/options | Tenant/workspace locator | Entity lifetime (**H**) |
| `public.contacts`, `public.contact_channels`, `public.custom_field_values` | Name/email/phone/platform IDs, metadata/custom values | Tenant/workspace/contact locators; inconsistent phone canonicalization | Contact lifetime; encrypted normalized identifiers; total child subject locator; erase/anonymize on request (**H**) |
| `public.contact_consent_events` | Identifier hash/mask, evidence, policy/jurisdiction | Tenant/workspace locator; contact can null; unbounded | Mask/evidence/contact at most two years after supersession, then redact; retain only minimal denial authority (**H/M**) |
| `public.contact_consent_states` | Hash, current status, contact/policy | Tenant/workspace locator; unbounded | Grant while contact exists; denial until explicit grant or tenant deletion; rotation-safe logical identity (**M**) |
| `public.contact_suppressions` | Duplicate denial hash/reason | Tenant/workspace locator; unbounded | Remove only after every send path uses canonical denied consent state |
| `public.broadcasts` | Message/template content | Tenant/workspace locator | Campaign lifetime, default one year after completion (**H**) |
| `public.broadcast_recipients` | Raw identifier/hash, variables, provider outcome/error | Parent/tenant locator; contact can null; unbounded | Encrypt nullable PII; cancel pre-boundary on erase; shred PII 30 days terminal, redacted outcome one year (**H/M**) |

##### Ads, sync, content, ideas, and planning

| Exact table(s) | Personal/sensitive data | Current locator/lifecycle defect | Target horizon and hold |
|---|---|---|---|
| `public.ad_accounts`, `public.ad_campaigns`, `public.ads`, `public.ad_audiences` | Provider IDs, names, content/URLs, targeting metadata | Tenant/workspace entity locators | Entity lifetime; purge with tenant/workspace/account (**H**) |
| `public.ad_creation_operations` | Request payload, provider IDs, errors | Tenant/workspace locator; unbounded | Raw request 30 days; redacted terminal 90 days; unknown manual evidence up to one year (**H/M**) |
| `public.ad_metrics` | Demographic/linkable campaign observations | Parent locator; unbounded | Rolling 25 months; prove demographics are aggregate/non-identifying (**H**) |
| `public.ad_audience_users` | Email/phone hashes | Audience parent locator | Audience/upload lifetime, whichever is shorter; subject/audience erase (**H/M**) |
| `public.ad_sync_logs` | Provider/account and error | Parent/tenant locator; unbounded | 90 days (**H/M**) |
| `public.external_posts` | Public content, media URLs, notes, provider data | Tenant/workspace/account locator | Mirror lifetime or 25 months after publication; parent deletion authoritative (**H**) |
| `public.social_account_sync_state` | Provider cursor/rate/error | Account/tenant locator | Account lifetime; redact errors after 90 days (**M**) |
| `public.content_templates`, `public.signatures` | User-authored reusable content | Tenant/workspace locator | Entity lifetime (**H**) |
| `public.cross_post_actions` | Content, provider result/error | Parent/tenant locator; unbounded | Raw operation 90 days; result identity may remain with source post (**H/M**) |
| `public.short_link_configs` | Current provider/domain policy and immutable version pointer | Tenant locator | Entity policy; no credential material is stored in the singleton (**H**) |
| `public.short_link_credentials` | Versioned encrypted provider API key | Tenant/provider/version locator | Retire rather than overwrite; retain only while a pinned link or cleanup needs the exact version; never extend for a hold (**N/M**) |
| `public.short_links` | Destination/short URL, provider identity, creation ambiguity, and post | Tenant/workspace locator; provider object plus derived KV copy | Local intent precedes egress; entity lifetime; erasure copies only the required credential into a fenced cleanup job, invalidates RelayAPI KV, and routes unsupported/unknown provider cleanup to manual review (**H/M**) |
| `public.org_streaks` | Tenant activity dates/aggregate | Tenant locator | Tenant lifetime; no independent personal subject (**H**) |
| `public.tags`, `public.idea_groups` | User-defined names/colors | Tenant/workspace locator | Entity lifetime (**H**) |
| `public.ideas` | Title/content/assignee | Tenant/workspace locator; assignee nulls on user erase | Entity lifetime (**H**) |
| `public.idea_conversion_operations` | Post/result/error relation | Parent/tenant locator; unbounded | Terminal 90 days (**H/M**) |
| `public.idea_media`, `public.idea_tags`, `public.post_tags` | Associations and alt text | Parent/tenant locator | Parent lifetime; projected scope in target (**H**) |
| `public.idea_comments` | Actor and comment text | Parent locator; rotating API-key actor today | Parent lifetime; stable user/service principal; pseudonymize actor (**H**) |
| `public.idea_activity` | Actor/action/arbitrary metadata | Parent locator; unbounded | Redacted timeline one year; prohibit secrets/free-form payload excess (**H/M**) |

##### Automations, audiences, AI, and growth

| Exact table(s) | Personal/sensitive data | Current locator/lifecycle defect | Target horizon and hold |
|---|---|---|---|
| `public.automations`, `public.automation_entrypoints`, `public.automation_bindings` | Graph/config/filter/template, creator/account/provider config | Tenant/workspace locator | Definition lifetime; sync errors 90 days (**H**) |
| `public.automation_secrets` | Credential ciphertext/key version | Parent/tenant locator | Active only; rotate/shred on removal/tenant deletion; never held (**N**) |
| `public.automation_entrypoint_daily_counts` | Tenant/entrypoint daily activity | Parent/tenant locator; unbounded | Rolling 90 days (**H/M**) |
| `public.automation_webhook_receipts` | Encrypted payload, signature/error | Tenant/parent locator and 24-hour expiry | Preserve exact 24-hour expiry; never held (**N**) |
| `public.automation_runs` | Contact/conversation and arbitrary context | Tenant/parent locator; unbounded | Raw context 90 days terminal; minimized outcome one year (**H/M**) |
| `public.automation_conversion_events` | Contact/run, value and metadata | Tenant/parent locator; fenced outbox + manual-review state | Dispatch must succeed before arbitrary metadata is minimized at 90 days or the fact drains at 25 months; unresolved rows remain operator-visible (**H**) |
| `public.automation_node_executions`, `public.automation_effects`, `public.automation_step_runs`, `public.automation_scheduled_jobs` | Result/error/payload, provider reference/effect state | Parent-projected organization/scope with composite authority | Raw detail 90 days; minimized public timeline one year; scheduled payload terminal + 30 days (**H/M**) |
| `public.automation_contact_controls` | Contact, pausing actor/reason | Tenant/parent locator | Control lifetime; pseudonymize actor (**H**) |
| `public.segments`, `public.contact_segment_memberships`, `public.subscription_lists`, `public.contact_subscriptions`, `public.contact_subscription_events` | Audience filter/definitions, static memberships, unsubscribe state/history | Tenant/workspace/parent locators; dynamic membership derived | Definition/contact lifetime; preserve minimized unsubscribe under consent policy; immutable transition events have explicit current-state provenance (**H/M**) |
| `public.ai_knowledge_bases`, `public.ai_knowledge_documents`, `public.ai_knowledge_chunks`, `public.ai_agents` | Source/title, arbitrary ingested text/embedding, persona/guardrails | Tenant/workspace/parent locator; feature incomplete | Entity lifetime; source/object locator; chunks erase with document/subject; failures 90 days (**H**) |
| `public.ref_urls`, `public.qr_codes`, `public.landing_pages` | Destination/config, public events and automation linkage | Tenant/workspace/parent locator; public paths incomplete | Entity lifetime; visit occurrence PII minimized; QR image derived; config validated (**H**) |

External-store personal data is inventoried in §4: all seven R2 bindings, every live KV family, every
Queue/DLQ/rescue family, Workers Logs, and the no-storage `RealtimeDO`. Queue bodies must become
identifier-only: email stores an encrypted owned delivery envelope and queues its ID; inbox queues
the inbound receipt ID; ad mutations queue the operation ID; tools queue the job ID. Main messages
and DLQs are converged to 24 hours; rescue ends at application attempt 40.

The boundary remains honest: provider-side copies, Cloudflare backup/control-plane telemetry,
browser storage, and future AI/BYOS subprocessors cannot be proven from the repository. The
executable registry therefore includes a provider/subprocessor register with owner, data class,
region, deletion API/contract, maximum horizon, and last verification date.

#### Shared-owner receipts

`queue_failures.organization_ids` and `inbound_webhook_events.organization_ids` are arrays because
one provider receipt can affect multiple tenants. Array ownership is legitimate but cannot use FKs.

The current tenant `shared_receipts` step already implements the correct owner-removal behavior.
The freeze work is to derive it from the registry, prove it for both tables, and close payload
lifecycle gaps:

- delete the row when the departing organization is its only owner;
- otherwise `array_remove` that organization;
- keep only non-PII operational metadata in the shared row;
- place raw payload in a separately redactable field/object with clock and `redacted_at`;
- retain the inbound 7/30-day replay horizons explicitly;
- give queue failures a drain instead of indefinite raw JSON.

#### Consent evidence versus erasure

A versioned organization HMAC is pseudonymization, not anonymity. Emails and phone numbers remain
enumerable to a key holder, so this report does not call HMAC storage “erased.”

The selected minimum denial ledger:

- stores canonical channel/purpose, HMAC, key version, denial status, policy/jurisdiction, and
  timestamps;
- redacts `identifier_masked`, free-form `evidence`, and contact FK on approved erasure;
- remains until an explicit later grant or tenant deletion so a re-import cannot bypass the opt-out;
- supports legacy key versions during rotation;
- never claims organization-wide key destruction is subject-specific crypto-shredding.

No separate hard-bounce/provider block table is added without a represented authority source.
When that feature exists, it must remain distinct from user consent because a later grant must not
clear a provider safety block.

#### Legal holds

Add an auditable relation, not a job status:

`erasure_holds(id, subject_kind, subject_id, organization_id, reason_code, reason_summary,
legal_authority_ref, placed_by, placed_at, released_by, released_at, evidence_ciphertext,
evidence_redacted_at, created_at)`.

- Only a global system administrator may place or release a hold.
- Tenant owners may read the held state and a non-sensitive reason summary.
- `id` is an immutable primary key; `subject_kind` is closed to `organization|workspace`, and a
  typed trigger validates that the target exists at placement time.
- `UNIQUE(subject_kind, subject_id) WHERE released_at IS NULL` permits at most one active hold.
- `released_at` and `released_by` are both null or both non-null; release may occur only once and
  cannot alter placement fields.
- The hold does not FK to the deletable organization. It stores the minimized organization
  tombstone identifier needed to interpret a retained hold after erasure.
- The immutable audit row survives, but free-form evidence is encrypted, access-logged, and
  redacted on the configured post-release clock; actor IDs become minimized stable audit
  references under the same clock. “Never delete” applies to the minimal transition receipt, not
  unlimited prose or attachments.
- Holds apply to both tenant and workspace erasure.
- An erasure request is accepted and its job enters a visible held/paused condition; claim queries
  skip it and resume after release.
- Holds do not reuse `manual_review`, which denotes processing failure.
- Hold targets remain organization and workspace only. A hold also pauses registered destructive
  TTL/purge work for hold-eligible content in that target, but never extends sessions, credentials,
  verification tokens, one-time capabilities, idempotency windows, or cache/queue envelopes.
  User/contact erasure still removes direct identifiers; when their content is inside a held target,
  the handler pseudonymizes/minimizes the subject while preserving only the held evidence.

#### Total retention contract

Build one executable registry over PostgreSQL and external stores. Per subject it records:

- row policy: TTL delete, parent lifetime, entity lifetime, or retained record;
- field-level redaction clocks;
- user/tenant/workspace subject locator;
- purge mechanism: FK cascade, explicit delete, prefix delete, array removal, or exception;
- legal-hold eligibility;
- object key template and binding→physical-resource map;
- infrastructure-owned horizon and owner;
- external-provider/BYOS deletion obligation;
- owner and review date for every retained-record exception.

Generate only simple TTL SQL. State-machine/evidence tables keep explicit handlers. Fail CI for a
missing/stale table or binding, invalid clock/index, dangling key family, unregistered job, expired
exception, or parent chain that never reaches a real policy.

Highest-growth subjects requiring explicit drains include `connection_logs`, `queue_failures`,
`automation_step_runs`, `automation_runs.context`, `inbox_messages`, `notifications`,
`ad_sync_logs`, webhook history, verification tokens, and short-link KV entries. Move request-log
pruning out of hosted-only invoice generation into deployment-neutral maintenance.

The implemented contract does not keep a second hand-maintained timed-store list.
`timed-retention-store-inventory.ts` derives the complete scheduled set from registry rows whose
`retentionExecution` is `"scheduled"` and asserts exact one-to-one coverage by the maintenance
drains. This makes both omissions and stale drains executable failures while leaving state-machine
and evidence-table handlers explicit.

### 5.5 Asynchronous lifecycle uniformity and cost safety

#### Five canonical contracts, not one generic attempt table

| Contract | Required state | Use when |
|---|---|---|
| External mutation | Due time, fenced lease, persisted pre-call boundary, attempts, known/unknown/permanent outcome, manual resolution | A crash can leave a remote side effect that cannot be read back |
| Transactional outbox | Business transaction, dispatch lease, durable handoff, dispatched timestamp | The durable decision is committed and only delivery remains |
| Poll/read synchronization | Due time, poll lease/generation, error class, separate freshness timestamp | Provider call is read-only |
| Durable inbox/receipt | Atomic accept/dedupe, processing lease, terminal/manual outcome, payload redaction/expiry | An inbound provider event must survive acknowledgement and replay safely |
| Pure orchestration | Claim + CAS/revision only | No external side effect exists; ambiguity machinery would create false unknowns |

The previous “19 dialects → 8 families” count was not derived and is removed. A conformance test
should output the actual family count from table signatures and written exceptions.

#### Automation: narrow the effect boundary

The scheduled-job lease/revision fence mechanics are useful, but the outer effect boundary is not
sound. `resume_run`, `input_timeout`, and `event_timeout` mark an effect before database/CAS
orchestration, so a transient local failure creates a false `unknown`; known terminal writes do not
clear `effect_started_at` in the same transition.

The granularity is not sound:

- pure condition/delay/goto/end work receives external-effect machinery;
- one 200-contact scheduled page can share one effect marker;
- multi-block messages and action groups share a coarse boundary;
- inbox admission can mark an outer effect before durable automation occurrence identity exists.

Target:

- scheduled jobs and node execution become retryable pure orchestration after actual effects move
  to component rows; terminal transitions clear obsolete outer markers;
- each actual external message block/action gets one effect row/idempotency key;
- stable trigger/occurrence IDs are written before admission;
- unknown outcomes stop only the affected component immediately;
- an operator may mark sent/not-sent/retry with an audited decision;
- automatic retry never guesses that an unknown provider mutation failed.

#### Provider-poll amplification

All figures below are nominal. At-least-once redelivery and overlapping producers mean there is no
true ceiling.

- **External-post consumer:** up to five provider pages before progress persistence. Four deliveries
  can produce 20 page calls; an extra logical enqueue produces 40. The two metrics producers have
  no shared exclusive claim: one does paged SELECT then a separate bulk freshness update, and the
  other does SELECT/filter/enqueue with no claim. Consolidate `enqueueMetricsRefresh`
  (`refresh_external_metrics_batch`) and `enqueueExternalPostRefresh` (`refresh_metrics`) behind one
  producer generation/fence and persist consumer progress.
- **Ad sync:** no producer reservation. One account can cause one listing + 200 per-ad metric calls.
  Four deliveries yield 804 reads; one overlapping producer yields 1,608. A final log-insert failure
  currently replays all provider reads.
- **Short-link sync:** one batched call per organization every five minutes. Two hundred poison rows
  mean 288 calls/day if one tenant, up to 57,600/day if 200 tenants per scheduled delivery. This is
  direct Cron, so overlapping invocations—not Queue at-least-once delivery—are the extra
  multiplier. The page is unordered, unclaimed, and failures are silently swallowed.
- **Meta binding sync:** remote POST/DELETE precedes durable `last_synced_revision`; permanent 4xx is
  retried like 5xx. The reconciler plus queue deliveries can generate roughly 90 nominal mutations
  per day per permanent failure.

Apply same-statement due claims, independent freshness, error classification, backoff, fair tenant
ordering, and structured telemetry. Meta binding operations use desired/applied revision plus
transient/permanent/unknown outcomes.

#### Queue terminal policy

Main/DLQ idempotency remains the primary protection. Rescue is a last copy only while PostgreSQL and
R2 both fail.

The rescue consumer is configured for `max_retries: 40`, while application attempt 40 is the
authoritative terminal fence. Its capped jittered delay horizon through attempt 39 is 32,553
seconds (about 9.04 hours). Alert at attempts 3, 10, 25, and 40. Attempt 40 emits only terminal
metadata to Workers Logs and configured alerts, ACKs, and permits payload loss. Nominal end-to-end
totals are 48 deliveries for ordinary main queues and 50 for five-retry mains
(`4/6 main + 4 DLQ + 40 rescue`). These remain nominal—not hard exactly-once bounds—because the
platform is at-least-once and independent producers can still duplicate a logical operation. Preserve
original queue and message identity when Wrangler sends a raw DLQ message to rescue; never relabel
it `unknown-dlq`. This is an explicit owner decision: bounded loss is preferred to unbounded
self-reenqueue cost.

Customer-webhook replay is now classified by durable send phase rather than by a generic retry
counter:

- a delivery known not to have crossed the HTTP boundary may be operator-retried through one fenced
  transaction that resets the delivery and appends the replay ledger record atomically;
- replay does not directly send a Queue message, so a database failure cannot create an
  unrecorded enqueue;
- operator claim/release transitions are row-local and fenced;
- a pre-send infrastructure failure remains unresolved instead of being misreported as replayed;
- any possible send, including a lost local commit after the HTTP boundary, becomes
  `replay_unknown` and is never automatically retried;
- expired webhook work and expired generic Queue work retain separate terminal semantics; and
- a lost transaction result is resolved by rereading the durable ledger, including when the
  best-effort claim-release write also fails.

One canonical Queue identity normalizer maps hosted `relayapi-*` and self-host
`relayapi-selfhost-*` physical names to the same capability plus `source|dead-letter|rescue` role.
Dispatcher selection, replay/reconciliation, privacy scoping, media DLQ reconciliation, and rescue
classification all consume that contract; arbitrary suffixes are rejected.

#### Existing shapes that earn their place

- post/thread publishing has a durable pre-call boundary and terminal no-op behavior;
- publish, webhook, and billing outboxes are legitimate separate dispatch lifecycles;
- webhook delivery’s batch lease and per-HTTP-attempt fence serve different processes;
- known-not-sent webhook pre-boundary failures retain a separate 24-hour repair circuit breaker;
- RSS/recycling occurrence receipts prevent duplicate enrollment;
- broadcast parent/recipient state is required for per-recipient outcome/fairness;
- token refresh fencing protects rotating provider grants;
- dunning, queue replay, email idempotency, media reconciliation, and provider-outcome
  reconciliation remain distinct;
- billing-operation ambiguity retains financial evidence but leaves automatic work after the
  12-attempt/24-hour review threshold;
- erasure retries never discard, but alert when aged 24 hours;
- YouTube renewal needs chunked continuation at scale, not a new generic attempt model.

### 5.6 Topology and residency

The current runtime is intentionally single-origin:

- one PostgreSQL database behind one shared Hyperdrive configuration;
- Smart Placement near that origin;
- one organization-keyed realtime namespace;
- no organization placement directory;
- five existing R2 buckets, all pinned to the owner-selected `default` jurisdiction.

The selected posture is **single-region launch with future-ready seams**, not a prebuilt regional
control plane:

1. Add direct `organization_id` to independently claimed/high-volume work, including
   `automation_scheduled_jobs` and analytical timeline rows.
2. Replace implied R2 binding references with explicit `(provider, bucket_locator, region, key)`.
3. Use typed key namespaces so user, organization, account, conversation, media, and rescue objects
   can be routed/purged independently.
4. Replace database-local consent ordering authority with a lexicographically comparable HLC tuple:
   `(ordering_hlc bigint, ordering_region text, event_id text)`. Start with one `home` region; do not
   rely on a bare `bigserial` for cross-region conflict resolution.
5. Keep billing, auth identity, and the future placement directory as explicit global-control-plane
   candidates in the design record, but do not add the directory until residency is a real product
   requirement.

R2 jurisdiction must be chosen before each production bucket is created. There is no technical
middle ground: hosted buckets must be created as `eu` or default/global. The owner selected
`default`; hosted provisioning, live verification, self-host configuration, and the release lock
therefore encode that closed value before any bucket exists. Future regional storage uses new
buckets plus locators; it cannot move an existing bucket’s jurisdiction in place.

`RealtimeDO` stores no durable rows, so its first-location behavior is not currently a data-residency
anchor. The namespace/migration lane still belongs in the freeze inventory.

### 5.7 Post-freeze migration survivability

#### Capture and reproduce every custom object

Before deleting numbered history:

1. move all auth functions/triggers and other migration-only objects into source render contracts;
2. render the candidate baseline solely from those contracts;
3. update verifiers/tests to read every rendered output, never `0005` or another migration
   filename;
4. apply `0000`–`0007` to scratch database A and capture a normalized catalog fingerprint;
5. apply the candidate baseline to scratch database B;
6. compare schemas, tables, columns, defaults, generated expressions, constraints, indexes, enums,
   sequences, functions, triggers, extensions, and FK actions.

The implemented generation-aware verifier checks the legacy generation-1 SQL against its preserved
catalog evidence and checks the generation-2 collapse candidate against every current renderer plus
the complete code-derived schema contract. The separate catalog tooling records the old and
candidate catalogs, binds both to exact manifests, validates an independently reviewed difference
file byte for byte, and commits the exact one-entry collapse-boundary manifest as immutable
evidence. The collapse builder reads the generation-1 catalog evidence from the exact
`--base-sha`; a supplied capture path is only a byte-identical cross-check. The Git-backed
transition audit independently revalidates that base evidence and runs in the protected cutover
before replay. A current generation-2 manifest must be either the exact boundary bytes or a strict
append-only descendant with the same manifest format and protected prefix. Exact
normalized candidate-catalog comparison applies at the boundary; descendants rerun the current
schema-derived verifier. Normalization preserves schemas and all pinned or unknown extension
versions exactly, while a known intentionally unpinned observed version becomes the stable
`provider-default` policy.

#### Make baseline replacement a monotonic generation transition

The append-only verifier must read the base revision’s policy. A candidate cannot disable its own
protection.

Add a monotonic baseline generation/epoch:

- current and base generations may never decrease;
- a sealed generation cannot be reopened in place;
- the authorized pre-live collapse increments the generation and replaces history once;
- the replacement change lands already sealed;
- no later rewrite is authorized: once generation 2 is sealed, all changes use ordinary
  append-only migrations.

There is no long-lived `pre-launch` branch on `main`, so ordinary API deployment remains possible.
Scope `baseline:sealed:check` to database initialization/migration rather than every Worker code
deploy.

The shared application target is already generation 2, while the repository metadata and live
system remain generation 1. Automatic API/app deploys therefore fail closed during the prepared
interval; only the reviewed cutover can bridge exactly `1 → 2`. Migration-source ownership scans
the repository root `package.json`, `.github`, `apps`, `packages`, and `scripts` across the
executable/configuration extensions and is enforced by database CI, lint CI, API deploy, app
deploy, and the cutover workflow.

The first collapse dry run may emit a deterministic candidate manifest before candidate-catalog
evidence exists. It uses non-exported provisional metadata only to select generation-2 static
contracts; an actual write still requires the committed candidate catalog and exact reviewed
difference evidence. The build policy remains byte-identical to the committed generation-1 anchor,
so the candidate cannot grant itself a broader transition.

The collapse preamble has an immutable prerequisite registry (`auth`, `pg_trgm`, and `vector`).
Current extension name/schema/optional-version requirements are a separate publish-safe contract.
An append-ordered, migration-only lifecycle ledger owns exact create schema/optional-version,
ordered `UPDATE TO` targets, `SET SCHEMA` events, and the drop boundary for every lifecycle epoch.
An append-only historical probe registry retains every extension epoch needed by clean replay even
after a later migration retires it. A future extension, update, relocation, or retirement can
therefore be introduced by an ordinary append-only migration without changing frozen `0000`.

Generation-2 static verification is bidirectional: every lifecycle event must have one exact
executable DDL counterpart in its declared migration, every extension DDL statement must be in
the ledger, replayed final state must equal the active contract, and the publish-safe epoch
registry must equal the ordered lifecycle ledger. Bare `ALTER EXTENSION ... UPDATE`,
`CREATE/DROP ... CASCADE`, wrong owner/schema/version/order, and procedural dynamic extension DDL
are rejected. Procedural scanning decodes PostgreSQL E-string simple, octal, hexadecimal, Unicode,
and line-continuation escapes plus U& strings with default or custom `UESCAPE`, and correlates
fragments across statements and variables instead of inspecting isolated literals.

The generic self-host capability check proves provider `default_version` for an unpinned create,
explicit versions in `pg_available_extension_versions`, non-null reachability through
`pg_extension_update_paths` for every ordered target, migration-role manageability, and an actual
missing-extension create/update/drop replay inside a transaction that always rolls back. The
lock-scoped migrator then binds lifecycle events to tracked manifest positions, derives the
verified applied prefix from the migration ledger, and simulates only pending events from the
actual installed schema/version. It fails before mutation if a pending create would silently
accept an incompatible preinstall or if any remaining ordered update is unreachable; it never
guesses applied state from `pg_extension.extversion`. A pending `SET SCHEMA` additionally requires
the simulated installed version to be marked relocatable in
`pg_available_extension_versions`. Contract selection is generation-aware: sealed generation 1
binds its actual pg_trgm-only source, while generation 2 and its append-only descendants bind the
full publish-safe lifecycle registry, currently pg_trgm/vector. Immediately after migration and
before bootstrap/build/Worker deployment, a separate verifier requires the exact active managed
subset, schemas, and any pinned versions. Catalog fingerprints normalize observed versions only
for known, intentionally unpinned extensions; a pinned or unknown extension retains its exact
version.

#### Fix policy and self-host gaps before sealing

- Run statement classification on both expand and contract SQL.
- Contract migrations may use destructive statements only when reviewed metadata names the
  affected objects and compatible release prerequisite.
- Keep Drizzle’s transactional lane for now. With zero rows, blocking indexes are acceptable;
  future enum changes use multi-deploy expand/contract. Add a nontransactional advisory-locked lane
  only when measured lock time requires it.
- The supported post-freeze DDL path is `drizzle-kit generate` plus source-owned SQL renderers and
  the guarded migrator. `drizzle-kit push` is not a repository script, CI/deploy path, or runbook
  operation and currently has a full-schema FK dependency-order failure. Treat it as an unsupported
  convenience command, not evidence that append-only generation/migration is incapable.
- `packages/self-host/src/deploy.ts` currently sets `DATABASE_URL`, while the migrator reads only
  `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`. This is not a theoretical
  compatibility gap: the self-host deploy command invokes the migrator with only `DATABASE_URL`,
  and `packages/db/scripts/migrate.ts` throws before applying any migration. One-command self-host
  installation is therefore broken today. Add one documented
  `RELAYAPI_MIGRATION_DATABASE_URL`, keep the local variable as fallback, validate
  `sslmode=verify-full` for remote databases, and add a doctor/test.
- No operator database exists, so the old migration identity needs no compatibility bridge. The
  self-host release still needs a path-scoped compatibility note/test so future installs and
  upgrades work.

---

## 6. Freeze decisions

All rows are settled. The owner selected Cloudflare R2's `default` jurisdiction
before production bucket creation.

| Decision | Selected baseline |
|---|---|
| Feature boundary | Every capability represented in schema, code, API/SDK, current docs, or retained specs is fixed and must work |
| Existing data/history | No production data; stage wiped; no self-host operator has run `0000`–`0007` |
| Table removals | Remove `usage_records`, `byos_configs`, `usage_bucket_settlements`, and `contact_suppressions` only after their named replacements are live |
| Erasure schema | Keep typed workspace and tenant job/step families; share code/check factories |
| Legal holds | Typed audited relation/active partial uniqueness; global-admin writes; pauses tenant/workspace purge plus eligible retention; never extends secrets/ephemera |
| Consent after erasure | Versioned organization HMAC minimal denial ledger; redact masks/evidence; no separate suppression projection |
| Consent dimensions | Extensible canonical text plus CHECK, not a closed enum |
| Consent key rotation | One logical authority independent of hash version; atomically rehash current states before retiring old lookup |
| Invitation owner role | Preserve advertised capability; owner may mint; redeem adds a co-owner after issuer revalidation |
| Principal scope | Stable user/service principals with `all|selected` mode and normalized workspace grants; credentials derive scope |
| QR cardinality | Multiple labelled QR identities per ref URL with independent scans; deterministic image rendering |
| Public links | Ref destination + idempotent visit/outbox; org/workspace slug namespace; QR uses opaque public ID |
| Embeddings | OpenAI `text-embedding-3-small`/1536; pgvector HNSW with `vector_cosine_ops` |
| Agent inference | Workers AI provider; initial supported default `@cf/zai-org/glm-4.7-flash`; no silent fallback |
| Automation ambiguity | Per external block/action; unknown stops immediately for manual resolution |
| Stripe escalation | 12 attempts or 24 hours, then durable manual review |
| Provider revocation | Remove active credential immediately; retry cleanup seven days, then manual terminal handling |
| Erasure retry | Never discard; alert when aged 24 hours |
| Queue rescue | 40 application attempts/under 9.1 nominal hours; alert at 3/10/25/40, then ACK/permit loss; no self-handoff |
| Alert destination | Configurable operations webhook, admin-email fallback, structured Workers Logs evidence |
| Tenant fairness | Equal round-robin with per-tenant cap; no plan weighting |
| Queue schedule authority | Move no-TTL `queue-schedule:*` state to PostgreSQL; KV becomes a bounded cache |
| Residency | Single-home launch with direct tenant identity, explicit R2 locators, and region-safe consent ordering |
| R2 jurisdiction | **`default` (owner-selected). Provisioning and verification pin it before bucket creation. No in-place change is possible; future regions use new buckets** |
| `api_request_logs` | Do not partition at birth; prune and index |
| Nontransactional DDL | Do not add a second lane pre-live; use blocking indexes and expand/contract until measured lock time requires one |
| Baseline replacement | Exactly one authorized `1 → 2` history replacement; generation 2 lands sealed and all later work is append-only |
| Runtime generation | API, app, and self-host share the canonical generation-2 target; automatic deploys remain held while repository/live metadata are generation 1 |
| Catalog evidence | Commit old-chain evidence with the generation-1 anchor; commit exact collapse-boundary manifest, normalized candidate catalog, and reviewed difference evidence with generation 2. Boundary databases exact-match that normalized catalog; known intentionally unpinned extension versions encode `provider-default`, while schemas and pinned/unknown versions remain exact. Strict append-only descendants use current schema-derived catalog verification without mutating collapse evidence |

---

## 7. Implemented public interface and feature-completion contract

Every contract below now has schema, runtime, API schema/route, TypeScript SDK, retention/erasure,
and focused test evidence where applicable. The imperative wording is retained as the acceptance
specification against which the implementation is checked.

The freeze is incomplete until these represented interfaces work. Every API route/schema change
must update `packages/sdk/src/resources/` in the same implementation unit.

### 7.1 Invitations

- Keep directed Better Auth email invitations.
- Add `POST /v1/invite/tokens/redeem` for an authenticated recipient.
- Store workspace grants in a normalized `invite_token_workspaces` relation with composite tenant
  FKs.
- Create a stable organization principal for each member/service identity. Store
  `scope_mode=all|selected` plus normalized `principal_workspace_grants`; credentials reference the
  principal and may rotate without changing authorization or audit identity.
- `used` is derived from or constrained exactly with `used_at`/`used_by`.
- Redeem is one transaction: create/reuse member + principal, copy token scope into principal
  grants, consume the token, and return membership, organization, role, and effective workspace
  IDs.
- Owner tokens expire after 24 hours; admin/member tokens after seven days.
- Dashboard bearer links call the API through the SDK rather than treating a raw token as a Better
  Auth invitation ID.

### 7.2 Subscription lists and post tags

- Add `/v1/subscription-lists` CRUD and `/v1/subscription-lists/{id}/members` list/add/remove
  operations.
- “Remove member” is an update/upsert setting `unsubscribed_at`, not physical deletion. Re-add
  clears the current marker while the versioned subscription/consent audit preserves the prior
  unsubscribe transition.
- Lists remain channel-scoped audiences. Consent purpose is orthogonal and is enforced at send
  time; do not invent per-list consent authority.
- Add post tag list/attach/detach operations under the existing post resource, with SDK parity.
- `post_tags` keeps parent-projected scope and gains `(organization_id, tag_id, post_id)`.

### 7.3 QR and landing pages

- Complete `ref_urls` first. Add a closed destination union: validated HTTPS URL or tenant-safe
  landing-page FK. Public visits write an idempotent `ref_url_visit` occurrence and automation
  outbox in the same transaction as the counter; anonymous visits do not invent a raw
  client-supplied `contact_id`.
- Add `workspaces.slug` with `(organization_id, slug)` uniqueness. Public routes are
  `/r/{organization.slug}/o/{ref.slug}` or
  `/r/{organization.slug}/w/{workspace.slug}/{ref.slug}`.
- Add `/v1/qr-codes` CRUD with `ref_url_id`, label/campaign identity, and per-code scan count.
- Serve deterministic QR images without durable image objects. `/q/{opaque_public_qr_id}` writes
  one idempotent visit, atomically increments QR + ref counts, emits the durable automation outbox,
  and redirects to the ref destination.
- Remove `image_r2_key`, `deleteQrCodeObjectBatch`, the `"qr_codes"` cursor phase inside
  `revoke_external_resources`, and the QR R2 key family; default the remaining cursor to
  `"account_dependents"` as one atomic change.
- Add `/v1/landing-pages` CRUD.
- Serve pages at `/l/{organization.slug}/o/{page.slug}` or
  `/l/{organization.slug}/w/{workspace.slug}/{page.slug}`; current
  `(organization_id, scope_key, slug)` uniqueness remains authoritative.
- A conversion occurrence, counter update, contact create/resolve (when the validated form calls
  for it), and automation outbox commit transactionally under one idempotency key.
- Validate `config` as a versioned block/theme/form/CTA union rather than unconstrained JSON.

### 7.4 AI knowledge, agents, and BYOS

- Add `vector` to baseline-required extensions and self-host doctor preflight.
- Embeddings use the owner-selected OpenAI provider with
  `text-embedding-3-small`/1536. Add the hosted secret and explicit self-host provider/key
  configuration; never pretend the existing Workers AI binding supplies OpenAI embeddings.
- Restrict the public provider/model/dimension triple to the supported registry rather than
  accepting unindexable arbitrary dimensions.
- Implement document ingestion for URL, file/media, and text sources with a due/lease/failure state.
- Chunk, embed, and upsert `vector(1536)` rows; use HNSW `vector_cosine_ops` and the cosine operator
  with tenant/scope predicates.
- Agent inference uses the existing Workers AI binding with initial supported default
  `@cf/zai-org/glm-4.7-flash`, selected from the
  [current Workers AI catalog](https://developers.cloudflare.com/workers-ai/models/). Persist
  `provider` + `model`, reject unsupported pairs, and remove the archived runtime’s silent Llama
  fallback and invalid `claude-haiku-4-5` default.
- Add live AI-agent CRUD/runtime using the configured knowledge base, guardrails, handoff,
  temperature, and token limit.
- Preserve the completed BYOS configuration/test/upload/read/delete and erasure paths through the
  shared storage-locator interface. Locations are immutable, credentials are encrypted and
  versioned, and media pins both so later rotation cannot reinterpret historical objects.
- Self-host AI remains an explicit feature flag, but a build containing the pgvector-backed schema
  requires the extension preflight to pass.

### 7.5 Operator resolution and observability

- Complete `webhook_reception_failure`: signature/acceptance failures write a sanitized durable
  receipt (provider/account routing when known, request digest, typed reason, timestamp; no raw
  untrusted body), then schedule the matching automation entrypoint with a deterministic
  occurrence. Preserve the already-live `scheduled_trigger` path.
- Provide an authenticated operator surface for unknown automation effects, Meta binding outcomes,
  Stripe receipts/billing operations, pre-HTTP webhook blockers, aged erasure, and provider
  revocation.
- Actions are typed (`mark_succeeded`, `mark_not_applied`, `retry`, `abandon` only where allowed),
  require a reason, and write immutable audit evidence.
- Emit structured alerts through the configured webhook/email adapter without raw payloads or
  credentials.

### 7.6 Dashboard API boundary

Move the six billing/admin business-data paths that directly read `organization_subscriptions`,
`usage_records`, or checkout operations behind API-owned services and SDK methods. Keep minimal
dashboard-side auth/session/credential bootstrap and user-local notification/preferences storage
where no API business resource exists.

---

## 8. Dependency-correct implementation sequence

### Stage 0 — freeze evidence before touching history (**implemented; commit anchor pending**)

1. Preserve the current staged document/index; no Git write command is part of this plan.
2. Hosted R2 uses the owner-selected `default` jurisdiction; provisioning and live verification
   encode it before any production bucket exists.
3. Capture the normalized catalog fingerprint of a clean database built from `0000`–`0007`.
4. Export every custom function, trigger, enum, extension, generated expression, constraint, index,
   and FK action into the fingerprint.
5. Materialize the 143-active-table/store/async/privacy coverage ledgers as executable contracts.
6. Add failing tests for every confirmed P0 defect before its implementation.

### Stage 1 — make the migration system capable of one safe collapse (**implemented**)

1. Move migration-only auth SQL into canonical render contracts.
2. Remove numbered-filename dependencies from verifiers/tests/workflows.
3. Add base-anchored, monotonic baseline generations and an explicit authorized collapse mode.
4. Add the two-catalog comparator.
5. Scan both expand and contract migration statements.
6. Scope sealed-baseline enforcement to initialization/migration.
7. Fix the self-host migration URL/SSL contract and doctor test.

Main remains on the existing sealed generation throughout this preparation.

### Stage 2 — develop dependency-complete target-shape units on one collapse stack (**implemented**)

Each unit includes schema, runtime, API schema/routes, SDK, dashboard consumer, retention/erasure,
tests, and self-host compatibility note where applicable:

1. consent identity + minimal denial + suppression removal;
2. Stripe, account revocation, provider-boundary/manual-review state;
3. analytics observation identity and canonical scheduler;
4. automation per-component effects, scheduled-job invariants, and literal bug;
5. cross-store owner locators, avatar/short-link/rescue purge, full retention registry, legal holds;
6. usage source and dashboard API boundary;
7. stable principals, invite redemption, and normalized effective workspace grants;
8. subscription lists and post tags;
9. public ref visits, QR, landing pages, and durable automation outbox;
10. pgvector, explicit OpenAI embedding + Workers AI inference, ingestion/retrieval/agents, and BYOS;
11. polling fairness/backoff, scheduler consolidation, cron cleanup, and bounded rescue;
12. remaining curated domain/scope contracts, queue-schedule PostgreSQL authority, and phone
    operation split.

These schema-changing units must **not** merge independently to `main`: current CI applies the tracked
old chain and compares it with current Drizzle shape, so an untracked candidate would fail by
construction. Develop and validate the units on one dedicated collapse branch/stack, generating
candidate baselines into temporary/untracked output. Merge final code, baseline, journal/snapshot,
manifest, policy, and sealed generation atomically in Stage 3. The rejected alternative is a series
of temporary tracked migrations followed by another history rewrite.

### Stage 3 — write one normative baseline (**blocked on the committed generation-1 anchor**)

1. Resolve the exact committed generation-1 anchor and require its baseline generation, manifest,
   build policy, and `catalog-fingerprint-generation-1-old-chain.json` bytes. This must be the
   actual comparison base carrying the immediately preceding sealed generation:
   `transition.fromGeneration` must equal both the base generation and generation 2 minus one;
   an arbitrary older revision or skipped generation is invalid.
2. Generate one generation-2 baseline from the final schema plus every source-owned SQL renderer.
3. Apply that candidate to PostgreSQL 18 scratch database B and capture
   `catalog-fingerprint-generation-2-candidate.json`.
4. Review every old/candidate difference against a decision in this audit and seal the exact
   review bytes as `catalog-difference-review-generation-1-to-2.json`.
5. Replace `0000`–`0007`, journal, snapshots, manifest, generation metadata,
   `migration-manifest-generation-2-collapse-boundary.json`, candidate catalog, and
   catalog-difference review as one atomic repository change. The transition binds the boundary
   manifest bytes through `candidateManifestSha256`; the build policy must remain byte-identical
   to the generation-1 anchor.
6. Reverify the installed artifact set, hashes, and candidate catalog before removing the
   recoverable backup.
7. Land generation 2 already sealed; do not merge an unsealed, schema-without-SQL, or
   evidence-without-baseline interval. No later history replacement is authorized.

### Stage 4 — wipe stage and prove launch behavior (**pending after Stage 3**)

1. Wipe/recreate stage and apply the baseline with the migration role.
2. Run post-migration catalog, trigger/function, extension, scope, retention, and purge proofs.
3. Deploy API/app and run smoke flows for auth, membership, posting, webhook delivery, billing,
   automation, contact erasure, invite redemption, lists/tags, QR/landing, AI, and BYOS.
4. Exercise queue/DLQ/rescue and manual-resolution paths with injected provider/store failures.
5. Verify webhook + email alert delivery and payload redaction.
6. Only then declare the baseline frozen and begin ordinary append-only migrations.

---

## 9. Independent Claude Opus 5 validation

This audit was challenged point-by-point across independent Claude Opus 5 sessions at `xhigh`
effort, including full-artifact reads of the then-current document and repository. Claude did not author the
conclusions and was not given veto authority: its job was to find unsupported claims, missing
stores/readers, accidental feature deletion, incorrect arithmetic, and decisions that still
depended on migration cost. Codex then reconciled each challenge against repository evidence.
Claude performed static review; the executable checks in §1.5 were run by Codex. Section 10
distinguishes the green working-tree gates from the generation-2 catalog and live cutover gates
that correctly remain pending.

Sections 9.3–9.6 are chronological challenge records and include verdicts later superseded by
fixes. Section 9.8 is the normative final Claude verdict on the current bytes.

| Independent lens | Claude challenge | Reconciled result |
|---|---|---|
| Mandate and feature boundary | Distinguish true implementation consolidation from capability deletion; identify every removal replacement | Accepted. `usage_records`, `byos_configs`, `usage_bucket_settlements`, and `contact_suppressions` are removed only after their named replacements are live. All half-built represented features are completed |
| Blank-slate shape | Challenge duplicate state machines, snapshots, one-row encodings, junction scope, QR cardinality, and derivable aggregates individually | Accepted with selective consolidation. Typed erasure families, step runs, QR identities, historical analytics, settings, memberships, and streak aggregation earn their places; retry code and projected scope are normalized where lifecycle authority is shared |
| Runtime defects unaffected by squash | Recalculate retry amplification and check whether failures are reachable in live code | Accepted. Stripe starvation, revocation credential retention, analytics duplication, automation success miscount, ambiguous external effects, and queue rescue are ranked by first-user impact |
| Invariants by construction | Separate database-enforceable rules from facts that require an external provider or operational process | Accepted. Tenant/scope ownership, tuples, domains, dates, and deterministic identities become DDL contracts; external outcomes and retention execution use auditable state/tests instead of pretending a CHECK can prove them |
| Privacy, erasure, and retention | Inventory every PostgreSQL/external store; challenge absolute-erasure language and suppression minimization | Accepted with qualification. All current tables are grouped in the field/locator/horizon matrix; five physical R2 buckets/seven bindings, KV, Queues, Logs, and shared receipts are covered. Holds pause only their typed target/eligible content; secrets and ephemera still expire |
| Async lifecycle and cost safety | Challenge nominal retry bounds under at-least-once delivery, ambiguous provider effects, fairness, and self-requeue loops | Accepted. Multipliers are explicitly nominal, not hard bounds. Claims use fenced attempts/deadlines/outcome classes; unknown effects stop for an operator; equal tenant fairness is explicit; queue rescue ends in alert plus ACK/authorized loss |
| Residency and topology | Verify what is actually irreversible before first production state and avoid designing a speculative global control plane | Accepted. The launch remains single-home with direct tenant identity and explicit object locators. R2 jurisdiction is fixed before bucket creation; future placement gets new buckets and an ordering-safe consent design |
| Post-freeze migration discipline | Challenge the old/new catalog comparison, auth SQL ownership, sealed-history transition, self-host connection contract, and need for a nontransactional lane | Accepted. The old chain is captured as evidence, final code expectations govern intentional differences, custom SQL becomes source-owned, one generation is sealed atomically, self-host migration connectivity is fixed, and a second DDL lane is deferred until measured need |
| Public capability completion | Check invites, lists, tags, QR, landing pages, AI/pgvector, agents, BYOS, and operator resolution for an actual API/runtime/SDK path | Accepted. Section 7 is the minimum completion contract; a table plus unused schema is not treated as a finished feature |
| Complete table/store coverage | Compare the ledger with declarations and inspect every disposition | Accepted after a final full-document pass: all 143 active PostgreSQL tables appear once, with four removed legacy shapes retained as capability evidence, and every non-PostgreSQL durable store class is separately covered |

### 9.1 Challenges that changed the audit

- An early suggestion to forbid owner bearer invitations was reversed because the advertised owner
  capability is fixed. The baseline preserves it as atomic co-owner creation with issuer
  revalidation and a short expiry.
- An early QR/ref-URL fold was rejected once per-placement QR identity and scan counts were
  confirmed as a capability. Images are derived; QR identities remain.
- The R2 inventory was corrected from four to five physical buckets and seven Worker bindings.
- Migration verification was corrected from “the new catalog must equal the old catalog” to
  “capture the old catalog, then compare the new catalog with both that evidence and the intentional
  final code-derived contract.”
- The cron finding was corrected precisely: Cloudflare accepts numeric weekday `1`, but it means
  Sunday, so the expression is syntactically valid and semantically wrong for the intended Monday
  digest. The target remains `MON` (or `2`).
- The consent-denial HMAC was narrowed: it is versioned and organization-scoped, supports erasure
  without retaining direct contact identity, and is not claimed to make recognition or legal duties
  absolute.
- The first full-artifact pass tied `org_streaks` specifically to streak-warning notifications and
  removed an unsupported rate-limit claim from `auth.verification`.
- The final 1,610-line gate corrected the QR erasure target from a nonexistent top-level step-key to
  the cursor phase inside `revoke_external_resources`; distinguished the two weaker metrics
  producers; replaced the preliminary bucket-snapshot rename with authoritative, splittable
  `billing_periods`; promoted the
  then-broken self-host migrator to P0; named both removal registries; corrected `idea_tags`
  to two read predicates plus two writes and its workspace purge-registry consequence; qualified
  rescue totals as target-policy arithmetic; and left the current Workers AI model as a
  primary-documentation rather than repository fact.
- A focused Opus closure pass reproduced seven of those eight changes as clean, corrected the
  `idea_tags` count to two reads plus two writes, found its workspace purge-registry consequence,
  and caught the stale P0 summary, under-qualified migrator path, and producer/message-type naming.
  Those corrections are incorporated here; no design decision changed.

### 9.2 Owner-resolved R2 jurisdiction

The owner selected Cloudflare R2's `default` jurisdiction. The decision is now pinned across all
five production buckets, generated Worker bindings, self-host provisioning, live verification, and
the pre-live wipe workflow. It was not inferred from maintainer timezone or deployment location.
Because an existing bucket's jurisdiction cannot be changed in place, future regional placement
uses new buckets with explicit locators rather than mutating this launch topology.

### 9.3 Initial implementation closure challenge

This Claude CLI pass was invoked with `--model opus --effort xhigh` and independently inspected the
implemented schema, runtime, registries, migration tooling, and this audit. It reconfirmed the
earlier settled decisions and raised four concrete closure findings:

1. **KV completeness was asserted from a maintained list.** Resolved by
   `KV_PRIVACY_KEY_PREFIX_BY_STORE_ID`, canonical one-to-one prefixes, runtime assertions for
   heterogeneous invalidation lists, and `kv-privacy-source-coverage.test.ts`, which derives all 25
   families from production KV calls.
2. **Exhausted known-not-sent customer webhook repair had no operator resolution.** Resolved by an
   explicit `manual_review` state/reason, sanitized alert, admin target
   `customer_webhook_delivery`, retry-only fenced transition, and append-only resolution evidence.
   Rows with a recorded HTTP boundary remain outside this retry path.
3. **Consent ordering still depended on a database-local sequence.** Resolved by a positive HLC,
   closed region identifier, event-ID tie-break, composite projection provenance FK, lexicographic
   compare-and-set, and ordered supersession retention.
4. **Generation 1 has no committed Git anchor.** Confirmed and intentionally unresolved in the
   working tree. The collapse tool refuses a working-copy/self-attested base. Committing the sealed
   generation-1 metadata, manifest, old-chain catalog fingerprint, and tooling is a user Git action
   and the only truthful prerequisite to the generation-2 replacement.

Claude and Codex reached the same disposition on all four. No middle-ground or owner choice remains.

### 9.4 Successive tooling and runtime closure challenges

A later full-artifact Opus `xhigh` pass and independent Codex closure reviews found defects that
were invisible to a shape-only schema review:

1. **Generation-1 verification was comparing legacy SQL with the final Drizzle model.** The
   verifier is now generation-aware: generation 1 is checked against its preserved old-chain
   catalog, while generation 2 is checked against every current renderer and code-derived schema
   contract.
2. **Runtime generation fixtures duplicated `1` and `2`.** Runtime, workerd, configuration, and
   deployment fixtures now derive the target from the canonical `BASELINE_GENERATION`; the
   cutover checks both generated Worker binding types. Pure guard-function tests intentionally
   retain literal `1`/`2`/`3` cases so they exercise stale/current/future behavior independently
   of the configured target.
3. **The first collapse dry run required evidence that could exist only after that dry run.** A
   deterministic provisional verification record now permits candidate-manifest emission without
   weakening the final write, which still requires real catalog and review evidence.
4. **The cutover parsed commented Wrangler JSONC with `jq`.** Each Wrangler installation now parses
   its own config and emits temporary types; only real JSON artifacts are inspected with `jq`.
5. **Migration source ownership did not cover every executable/configuration source.** The scanner
   now covers the repository package scripts, `.github`, `apps`, `packages`, and `scripts`, and all
   relevant CI/deploy/cutover paths enforce it.
6. **A committed candidate fingerprint could drift from the database actually replayed in a
   workflow.** CI, production migration, and cutover now exact-verify the reviewed database at the
   collapse boundary; post-collapse descendants prove the immutable boundary prefix and rerun the
   current schema-derived catalog verifier.
7. **Customer-webhook replay mixed durable repair with Queue delivery and did not model every
   transaction ambiguity.** Replay is now atomic, phase-aware, fence-protected, and resolves a
   lost transaction result from the durable ledger without treating a possible send as safe.
8. **Self-host Queue names were not recognized by hosted-name dispatch/replay/privacy logic.** A
   shared physical-name normalizer now covers every self-host source, DLQ, rescue, and `inbox-raw`
   queue while rejecting unknown suffixes.

All eight findings were implemented and independently regression-tested. None changes a fixed
feature or a settled owner decision.

### 9.5 Final Lens-7 closure challenge

The next Opus `xhigh` pass returned **FAIL** even though it passed the eight requested closure
items. It found that the candidate catalog was being asked to serve two incompatible roles:
immutable authorization evidence for the `1 → 2` collapse and a permanently current exact-catalog
snapshot. Because the candidate fingerprint was bound to the live manifest and exact-compared
forever, the first append-only migration would change both manifest and catalog and become
unshippable. The same pass also found four related gaps: two root cutover/generation tests were not
run in CI, the production reset leg omitted the exact fingerprint check, adding a future required
extension changed the frozen baseline renderer, and an intentional deploy hold appeared as an
unannotated green skip.

The terminal-schema option was not an open owner decision: it directly contradicted this audit’s
fixed Lens-7 mandate and the settled “one squash, then append-only” decision. The compliant
reconciliation is now implemented:

1. `candidateManifestSha256` binds an immutable
   `migration-manifest-generation-2-collapse-boundary.json`; that file, generation metadata,
   candidate catalog, and exact review bytes install and roll back as one recoverable unit.
2. The active manifest must be either the exact boundary bytes or a strict descendant with the
   same manifest format and exact protected prefix. Same-length byte drift, a rewritten header or
   baseline entry, and shortened history fail closed.
3. `catalog:fingerprint:verify-active --require-boundary` exact-compares the normalized catalog of
   both clean and production cutover databases. Later descendants rerun full current
   schema-derived verification instead of mutating collapse evidence. Normalization changes only
   known intentionally unpinned observed extension versions to `provider-default`.
4. The immutable collapse preamble is separate from the active database prerequisite registry.
   The migration-only lifecycle ledger owns extension DDL; the self-host-safe contract exposes
   current requirements plus ordered create/update/drop epochs. Static replay enforces both
   contracts in both directions. The generic doctor validates provider capabilities and rollback
   replay, while the lock-scoped migrator validates tracked-source ownership and simulates only
   the ledger-derived pending suffix from actual installed state. Exact postflight validates the
   resulting active subset. Unregistered, out-of-owner, unpinned-update, `CASCADE`, and decoded
   procedural dynamic extension DDL all fail closed.
5. Ordinary CI and reviewed cutover run the root generation/cutover tests; the production reset
   verifies before grants or traffic; and a held automatic deployment emits a visible GitHub
   warning without turning the intentional hold into a failure.

### 9.6 Historical terminal boundary and extension-path closure

The terminal review found seven migration-boundary defects after the broader schema work was
already green. They are recorded separately so the final audit does not hide late corrections:

1. PostgreSQL E-string, U& string, variable-fragment, and cross-statement constructions could hide
   procedural extension DDL from a literal-only scanner. The scanner now decodes and correlates
   those forms, with adversarial fixtures for each escape family.
2. Collapse tooling could accept working-copy old-catalog evidence. Old-chain authority now comes
   only from the exact Git `--base-sha`; a supplied capture is merely a byte-identical cross-check.
3. The protected workflow did not prove that Git-backed transition before replay or destruction.
   It now pins the protected main commit, reads `transition.baseCommitSha`, runs the append-only
   comparison against that SHA, then runs source/schema contracts, applies the candidate twice on
   clean PostgreSQL 18+pgvector, and runs the catalog verifier with `--require-boundary`, all
   before maintenance.
4. Deployment could conflate the application target, repository generation, and live database
   generation. Those are now compared independently; the prepared `1 → 2` hold and an actual
   generation mismatch are distinct states.
5. Extension-name/version availability did not prove ordered reachability or pending state. Exact
   lifecycle epochs, update-path reachability, rollback replay, tracked-source binding, and
   generation-aware, lock-scoped migration-ledger-prefix simulation now cover the whole
   create/update/set-schema/drop path without making the valid generation-1 prepared interval red.
   A pending schema move also proves the current simulated version is relocatable through
   `pg_available_extension_versions`.
6. Clean PostgreSQL 18 replay used an image without pgvector even though the baseline creates
   `vector`. Database CI, deploy replay, and protected cutover now share one digest-pinned
   PG18+pgvector image, enforced by the workflow supply-chain verifier.
7. Catalog capture accidentally made a provider-selected unpinned extension version an exact
   boundary dependency. Known unpinned extensions now fingerprint a `provider-default` policy;
   explicitly pinned and unknown extension versions remain exact.

The terminal invocation against those then-current bytes used exactly:

```text
claude --print --model opus --effort xhigh --permission-mode plan
```

That invocation historically returned `You've hit your weekly limit · resets Jul 30 at 11am
(Europe/London)` before inference. This records the outcome of that attempt only; it is not a
claim about current Claude availability and it produced **no verdict**. It has now been superseded
by the completed same-session final Opus review in §9.8.

### 9.7 Post-implementation completeness challenge

An independent completeness pass after the migration-boundary work found additional acceptance
gaps. The following fixes are present and were rechecked by the final Opus review:

1. **Billing-period splits could invalidate already-authorized usage.** All term changes,
   complimentary transitions, and cancellation shortening now use one bucket-first boundary
   transition. It locks the authoritative bucket, preserves every reservation in its original
   window, advances the split to at least the latest `reserved_at`, and updates the period and
   bucket together under the deferred exact-window FK.
2. **Email erasure proof stopped at static/source coverage.**
   `email-delivery-owner-deletion.test.ts` now calls the real `deleteUserAtomically` transaction
   against PostgreSQL and proves both auth-user delivery cascade and organization-receipt subject
   detachment, envelope-key shredding, lease clearing, terminalization, and redaction.
3. **BYOS lifecycle proof was source-only.** `byos-lifecycle-db.test.ts` now exercises concurrent
   staging, failed rotation without loss of the active credential, and iteration across historical
   cleanup locators against PostgreSQL.
4. **Append-only Git topology failures lacked deterministic fixtures.**
   `migration-append-only-topology.ts` and its tests now cover missing history, non-ancestor and
   unreachable protected bases, skipped generation predecessors, one-time manifest bootstrap, and
   the previously reproduced protected-prefix failure at
   `9a7db173fda41715cc99377ed50c6f953d007434`.
5. **Tool costs and retries were not bound to the durable provider lifecycle.** Every cost-bearing
   request is now durable-first and Queue-only: the HTTP handler creates the `tool_job`, hands off
   only its identifier, polls PostgreSQL for at most 20 seconds, and returns 200/202 without
   provider egress. Each job owns one `usage_reservation`; the Queue claim arms both boundaries
   atomically before its single provider call, and terminal job/usage state settles in one
   transaction. The database permits at most three claims, rechecks the hard deadline at claim and
   arm with server time, never steals a live or armed lease, and reconciles a late definitive
   outcome only through the same fence. Unknown outcomes enter `manual_review`; terminal rows
   alone are pruned. `mark_not_applied` remains available only while the locked original bucket
   window is open; a closed window exposes only `abandon`.

### 9.8 Fresh final same-session Opus verification

Claude Code `2.1.220` resumed session `45910391-dfc3-430f-a87a-4798cc1ee7fc` against the final
working tree with model `claude-opus-5` (`--model opus --effort xhigh`) in read-only plan mode.
It independently re-read the implementation rather than trusting the earlier report.

The first final pass confirmed former findings F1–F6 closed: live tool leases cannot be stolen;
billing authority mismatch rolls back and self-heals once, including deterministic
Free→Paid→Free boundaries; database fixtures fail closed; tools are Queue-only with a reachable
200/202 lifecycle; pruning is terminal-only; and the usage projection requires both nested trigger
depth and a transaction-local marker. It also passed nullable daily-tool overrides and locking,
PostgreSQL-authoritative hosted Pro/AI gates, immediate service-key revocation despite an in-flight
KV hydrate, one request-scoped database client, safe DDL literal serialization, migration
generation guards, and all seven independent lenses. It explicitly found that the unsupported
`drizzle-kit push` FK-order failure is not a Lens-7 blocker because the supported/gated path is
`generate` plus source-owned renderers plus `migrate`.

That pass found one P3: `createToolJob` compared Worker-sourced `created_at` with a
database-defaulted `next_attempt_at`. Both now use the same application `now`; a source contract
and a real PostgreSQL fixture call the production creation path and prove equality. Raising that
file from five to six cases exposed a second P3 during follow-up: the protected database-fixture
allowlist was maintained by hand. The runner and workflow test now recursively derive every test
using the canonical database-gated marker, exact-compare discovery with registration, and require
**19 cases across six isolated files** with zero skips or failures.

The same Opus session re-inspected both remediations and returned:

- **all seven lenses: PASS**;
- **remaining P0–P3 findings: none**;
- **owner disagreements: none**.

The only remaining prerequisite is operational, not a schema/runtime dispute: the user-created,
committed generation-1 Git anchor required before generation-2 collapse.

---

## 10. Freeze acceptance gates (historical July snapshot)

The plan is not complete when the DDL merely parses. The baseline may be frozen only when every
gate below is executable and green.

**Gate state recorded 2026-07-29 (superseded on 2026-08-03):** the final post-remediation whole-tree sweep is green for
schema/privacy/source contracts, generation-aware migration verification, migration policy and
baseline-builder controls, monorepo typecheck/lint, isolated API, workerd, dashboard, SDK,
self-host, OpenAPI, and cutover-control tests; exact results are in §1.5. Claude Opus `xhigh`
returned PASS on all seven lenses with no remaining P0–P3 finding or owner disagreement.
`baseline:rebuild:check` remains intentionally transition-red because the tracked history is still
the sealed eight-file generation-1 chain. The append-only base comparison also requires an
explicit `MIGRATION_BASE_SHA`; it is not self-attested from the working tree. Clean PostgreSQL
18+pgvector generation-1 replay, idempotent reapplication, and exact old-chain catalog capture are
complete. The generation-2 candidate replay, its required 19-case PostgreSQL fixture gate, and
active-database fingerprint verification remain pending the user-created committed generation-1
anchor; hosted resource verification, stage wipe, and smoke/alert delivery remain Stage 3/4 gates.
Nothing below should be read as authorization to bypass either the Git-anchored generation
boundary or the protected live-system boundary.

### 10.1 Shape and coverage

- A derived schema-census test proves every declared table is present exactly once in the audit
  ledger. Current audited input: **143 active tables** (`auth`: 9, `public`: 134), plus the four
  named removed legacy shapes retained as capability evidence.
- A durable-store registry covers PostgreSQL, all R2 bucket/binding/key families, KV namespaces,
  Queue/DLQ paths, Workers Logs, provider copies, and any Durable Object introduced later.
- A capability trace maps every **Remove**, **Reshape**, and **Complete** row to runtime, API/SDK,
  retention/erasure, and test evidence.
- The final baseline declares every required extension, function, trigger, generated expression,
  enum/domain, constraint, index, and FK action from source-owned inputs.

### 10.2 Catalog and migration

- Scratch database A, built from the current `0000`–`0007` chain, produces the preserved normalized
  catalog fingerprint.
- Scratch database B, built from the candidate baseline, matches final code-derived expectations;
  every difference from A is linked to a decision in this audit.
- The committed old-chain fingerprint binds to the generation-1 manifest. Generation 2 commits
  the exact one-entry boundary manifest, binds its hash in transition metadata, and binds the
  candidate fingerprint to that immutable hash; the committed difference review binds to both
  catalog hashes and is re-read byte-for-byte before a write.
- Generation metadata binds the base commit, base manifest, base generation, unchanged build
  policy, both catalog hashes, and review hash. Installed files are rehashed after the atomic
  replacement and rollback/recovery paths are fault-tested.
- Migration-source ownership covers the root package scripts, `.github`, `apps`, `packages`, and
  `scripts`, and is enforced by CI, both Worker deploy paths, and cutover.
- At the protected cutover, `catalog:fingerprint:verify-active --require-boundary` exact-compares
  the database with the normalized candidate evidence. Known intentionally unpinned extension
  versions encode `provider-default`; schemas and pinned/unknown versions remain exact. A later
  generation-2 manifest is accepted only as a strict append-only descendant of the committed
  boundary, then the command reruns the current schema-derived migration/catalog verifier instead
  of rewriting historical evidence.
- A second application of the baseline/migrator is a no-op or cleanly reports already applied.
- Sealed-history checks, expand/contract statement scanning, base-anchored generation, and the
  self-host migration URL/SSL doctor all pass without filename-specific escape hatches.
- Stage is wiped and rebuilt from the one normative baseline; no production or operator data is
  assumed or migrated.

### 10.3 Invariants, privacy, and failure behavior

- Generated negative tests attempt cross-tenant and cross-workspace associations for every scoped
  FK family and prove rejection at the database boundary.
- Generated domain tests derive allowed literals from canonical application/schema registries and
  fail on drift.
- Identity, contact, tenant, and workspace erasure tests enumerate every registered PostgreSQL,
  R2, KV, log, and provider locator; legal-hold tests prove both tenant and workspace jobs pause and
  resume audibly.
- Retention workers prove bounded scans, due ordering, retry/backoff, alerting, deletion/redaction,
  and legal-hold exclusion. “A policy exists” is not accepted as proof that data drains.
- Fault injection covers crash-before-call, crash-after-call-before-local-commit, lease expiry,
  duplicate queue delivery, out-of-order events, provider timeout, rate limit, and permanent
  failure for each external-effect class.
- Queue replay fault injection separately covers a pre-Queue failure, a possible Queue-send
  ambiguity, a lost transaction result after commit, and failure of the best-effort claim-release
  write. Tests prove that known-not-sent work remains recoverable while possible sends never become
  automatic retries.
- Cost tests verify per-tenant caps and fair ordering. At-least-once infrastructure semantics remain
  part of the threat model even when application retry counts are exhausted.

### 10.4 Product and release

- API and SDK contract tests cover every completion path in section 7; dashboard callers use SDK
  methods for API-owned business data.
- API, app, and self-host build from the same canonical generation-2 target. Automatic deployments
  reject the prepared generation-1/2 mismatch, and the protected cutover permits only the reviewed
  `1 → 2` transition with generated Worker bindings proving both targets.
- Smoke tests cover auth, membership, posting, webhooks, billing, analytics, automations, contact
  consent/erasure, invitations, lists/tags, QR/landing, AI, BYOS, and operator resolution.
- `bun run typecheck`, repository lint, the isolated API suite, dashboard suite, database fixture
  suite through the command-scoped tunnel, and self-host doctor/tests are green.
- Structured operational alerts reach the configured webhook and admin-email fallback with
  secrets and personal payloads redacted.
- The final review proves `CLAUDE.md` and `AGENTS.md` remain synchronized and that no Git write
  command was performed by the agent.

### 10.5 Definition of done

The freeze is done only when the feature trace has no “schema only” capability, the store registry
has no unowned personal-data location, the async matrix has no unfenced external effect, the two
scratch catalogs reconcile intentionally, stage rebuilds from one sealed baseline, and all gates
above pass. After that point, ordinary changes are append-only migrations; there is no planned
second squash.

---
