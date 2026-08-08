# RelayAPI whole-repository serious-issue remediation verification — 2026-08-03

## Verdict

**The repository-side High blockers are remediated. Recreate and initialize the disposable pre-live database before deploying this migration reset.**

The full-tree and HEAD remediation pass now records:

- **0 Critical findings**.
- **20 serious findings or deterministic release gates tracked**.
- **20 remediated in the repository and locally verified**.
- **1 remaining operator release gate: recreate the pre-live database and apply the new baseline**.
- **0 pending severity decisions**. The maintainer elected to treat D-01 through D-05 as High blockers, and all five were implemented.

No additional serious product defect was found in the final rescan. The former mixed-generation stop was removed after the maintainer confirmed the environment is pre-live and explicitly chose to discard the development database. The repository now has one sealed, complete initial baseline; the only remaining action is the maintainer-owned database recreation and reviewed migration-first deployment.

The current Git HEAD is still `d371be451f37301c43b83bcc34986b49f02f0f35`. The remediations described here are worktree changes and have not been committed by this review.

## Status ledger

| ID | Serious issue or gate | Final status |
|---|---|---|
| R-01 | Migration generation, protected Worker stamp, and PostgreSQL 18 catalog transition | **Resolved in repository — disposable database recreation remains an operator release gate** |
| R-02 | Generated OpenAPI reference drift | **Resolved** |
| R-03 | Required PostgreSQL fixture inventory drift | **Resolved locally; live PostgreSQL 18 acceptance remains unrun** |
| R-04 | Dependency-review merge gate | **Resolved as a gate; 172 exact reviewed exceptions remain recorded** |
| S-01 | Invalid self-host encryption-key instructions and weak deploy preflight | **Resolved** |
| A-01 | Administrator impersonation surviving administrator/session revocation | **Resolved** |
| A-02 | Better Auth administrator mutations surviving actor demotion/revocation | **Resolved** |
| H-01 | Reversed Cloudflare WAF attack-score polarity | **Resolved** |
| H-02 | Cloudflare Queue failure examples implicitly acknowledging failed work | **Resolved** |
| H-03 | Sandbox tenant escape and shell injection examples | **Resolved** |
| H-04 | Unauthenticated TURN credential minting example | **Resolved** |
| H-05 | Caller-selected RealtimeKit privileged roles | **Resolved** |
| H-06 | Bearer-prefix-only authentication examples | **Resolved** |
| H-07 | Public caching of personalized responses | **Resolved** |
| H-08 | Credential disclosure through output, URLs, pipelines, or argv | **Resolved** |
| D-01 | Tenant deletion authority race | **Resolved** |
| D-02 | Global-admin and legal-hold mutation authority race | **Resolved** |
| D-03 | OAuth/Telegram/WhatsApp credential persistence after revocation | **Resolved** |
| D-04 | Paid-ad provider mutation after billing, actor, or account revocation | **Resolved** |
| D-05 | Irreversible WhatsApp phone-number release after authority revocation | **Resolved** |

## R-01 — resolved by the authorized pre-live baseline reset

The maintainer confirmed RelayAPI is still pre-live and authorized replacing the development chain rather than preserving an upgrade path. The repository migration directory now contains exactly one generated `0000_baseline` plus its snapshot, journal, manifest, and policy. The baseline is derived from the complete current Drizzle schema and all source-owned non-declarative renderers, including the former pending `0008` credential-containment behavior.

- `packages/db/baseline-generation.json` declares sealed initial generation 1.
- API, App, shared config, and self-host configuration all target generation 1.
- Baseline SQL SHA-256: `31420f76c33c6803473ed806219cd6f69847d14e6e160fb71b92ff507cbeaf28`.
- Snapshot SHA-256: `7609b706f901baf909966ca3be56f9163a1ef8220fb3a085769a020277eaa35d`.
- Rebuilding from `schema.ts` and renderers is byte-identical.
- The one-time append-only bootstrap is bound to the exact base-to-HEAD edge and becomes unreachable after generation metadata lands on protected `main`.
- Subsequent schema changes are ordinary append-only expand/contract migrations; the sealed `0000` must never be rewritten after persistent initialization.

The historical PostgreSQL 18 old-chain fingerprint remains non-authoritative audit evidence for the discarded chain. Because no PostgreSQL 18 service was available locally, current-baseline database replay/catalog verification remains a CI/operator deployment gate. The maintainer will recreate the database; this review did not connect to or mutate it. The exact procedure is maintained in [DATABASE_MIGRATION_AND_FORWARD_RECOVERY_RUNBOOK.md](./DATABASE_MIGRATION_AND_FORWARD_RECOVERY_RUNBOOK.md).

## Resolved serious product and release issues

### R-02, R-03, R-04, and S-01

- **R-02:** the pinned OpenAPI artifact and generated documentation now agree at 432 operations, 56 tags, and 56 generated categories. Both `openapi:check` and `docs:check` pass.
- **R-03:** the protected runner and workflow guard now discover the same seven PostgreSQL fixture files and exact case inventory: `20 + 1 + 2 + 2 + 7 + 10 + 4 = 46`. The gate rejects additions, removals, skips, and JUnit count drift. The live 46-case run remains a PostgreSQL 18 deployment gate because no database endpoint was available locally.
- **R-04:** dependency review now passes with 172 exact, current, time-bounded exception scopes and no unmatched advisory or artifact path. This closes the deterministic merge gate; it does not claim the recorded upstream advisories ceased to exist.
- **S-01:** self-host initialization documentation now creates distinct active and retained identity key material. Direct deploy validates the complete encryption key ring before database or Cloudflare work, so an operator cannot bypass `doctor` and deploy a ring without its identity anchor.

### A-01 and A-02 — administrator and impersonation containment

- A database-owned administrator revocation invariant removes derived impersonation sessions on active ban, administrator-role loss, administrator deletion, and rollout backfill.
- Deleting any normal originating session also removes every impersonation session derived from it. Derived-session deletion terminates without recursion.
- Core and Better Auth administrator session revocation paths use the same database invariant.
- Every mutating Better Auth administrator endpoint is inventory-checked and fenced by the exact live administrator and exact unexpired session. Sessionless administrator creation is intentionally rejected.
- Organization mutations use an authoritative session, stable actor/target lock ordering, live organization state, and current membership authority through commit.

These changes close both the surviving-impersonation path and the stale administrator request that could otherwise complete after ban or demotion.

### D-01 and D-02 — destructive tenant and legal authority

- Tenant deletion admission now carries the exact revocable actor/session authority through the authoritative transaction rather than trusting a route precheck.
- Cross-tenant administrator mutations and legal/erasure-hold transitions revalidate and serialize live global authority at their database effect boundary.
- A completed ban/demotion therefore wins over an in-flight irreversible deletion, hold release, or equivalent global mutation.

### D-03 — connection credential persistence

OAuth completion, Telegram connection, and WhatsApp credential/embedded-signup completion now bind persistence to the exact initiating dashboard session, current user generation, membership, workspace grant, and tenant state. Provider credentials cannot be committed from a pre-issued state after the initiating authority is revoked.

### D-04 — paid-ad provider boundary

A shared provider-write boundary now revalidates, for every external write:

- the durable operation's exact actor, session, credential generation, tenant, and workspace;
- the exact social account and ad account;
- a freshly resolved provider token; and
- for hosted spend-increasing actions, current eligible billing authority.

Self-host mode, emergency stops, and spend-decreasing actions bypass only the hosted billing entitlement check; they never bypass actor or account revocation. Multi-write creation and mutation flows revalidate between provider effects. Meta budget/targeting updates also refresh authority after their ad-set lookup and before the subsequent write, closing the final GET-to-POST token race. Loss of authority before an effect cancels with proven zero effect; loss after an ambiguous effect enters manual review.

### D-05 — phone-number release fencing

Tenant/workspace deletion can take over any nonterminal user release using exact compare-and-swap state, a new lease generation, cleared actor authority, and preserved provider evidence. Ambiguous or already-applied provider outcomes never become false zero-effect cancellations. Workspace phone release staging occurs before source-account credential revocation, existing tenant-deletion releases are not restaged, and due reconciliation continues to include them.

### H-01 through H-08 — Cloudflare skill safety

The repository-owned Cloudflare skill now:

- uses the correct low-is-malicious WAF score polarity;
- explicitly retries Queue failures instead of implicitly acknowledging them;
- isolates Sandbox tenants and keeps caller input out of shell syntax;
- requires real application authentication, authorization, and quotas before TURN minting;
- assigns RealtimeKit roles from server policy;
- never treats a `Bearer ` prefix as verified identity;
- excludes authenticated/personalized responses from public cache recipes; and
- keeps secrets out of logs, output, URLs, pipelines, and argv.

The skill safety suite also pins the patched local source to its exact folder hash, preventing silent replacement by the former unsafe vendored snapshot.

## Final verification ledger

All Bun checks below used the repository-pinned Bun 1.3.14 executable, including child processes spawned by the isolated API runner.

Passing checks:

- API isolated suite: **230 files, 2,027 passed, 46 skipped, 0 failed**. The 46 skips are the exact remote PostgreSQL fixture inventory described below.
- Worker runtime: **20/20 passed**.
- Dashboard: **302/302 passed**.
- Auth: **30/30 passed**.
- Database unit/contract suite: **320/320 passed**, 24,691 assertions.
- Self-host: **84/84 passed**.
- Root workflow, security, supply-chain, migration, and cutover contracts: **365/365 passed**.
- SDK: **14/14 passed**, with build and ESM/CommonJS/TypeScript package smoke.
- CLI **2/2**, MCP **2/2**, n8n **1/1**, Zapier **14/14**.
- Full monorepo typecheck passed for database, auth, SDK, MCP, API, dashboard, docs, CLI, self-host, n8n, and Zapier.
- Biome completed with **0 errors**. Non-blocking warnings and informational diagnostics did not meet this report's serious threshold.
- OpenAPI parity and generated docs passed at **432 operations / 56 tags / 56 categories**.
- Dashboard production build passed.
- Docs OpenNext production build passed, including all **1,649 static pages**.
- API, dashboard, and docs Wrangler upload dry-runs passed. No deployment occurred.
- Dependency audit passed with **172 exact current exceptions** and no new scope.
- Cloudflare skill safety passed **9/9**.
- Migration generation seal, one-entry manifest, source ownership, byte-identical baseline regeneration, and exact-edge one-time reset bootstrap passed.

Final repository hygiene checks passed: `git diff --check HEAD` is clean, and `AGENTS.md` is byte-identical to `CLAUDE.md`.

## Review status and limitations

The earlier audit's Claude Opus discussions remain historical evidence for the original findings. At the maintainer's request to conserve credits, **no new Claude instance was started for the final remediation review**. Independent Codex reviews were used during implementation and found one serious residual Meta GET-to-POST authority race; it was fixed and regression-tested. No Codex disagreement remains pending.

The maintainer will initiate the final Claude Opus review. If that review produces a substantive disagreement, the decision returns to the maintainer as requested.

The required PostgreSQL 18 environment was unavailable: `RELAYAPI_DB_SSH_TARGET` and a database URL were absent. Therefore the 46 database-backed race schedules and live replay/catalog comparison of the reset baseline were not executed. The runner inventory, fail-closed behavior, deterministic baseline rebuild, SQL renderers, migration contracts, and workflow ordering were verified locally, but they do not replace the PostgreSQL 18 deployment gate.

No production/provider mutation, Cloudflare deploy, package publication, credential rotation, destructive database operation, or Git write command was performed.
