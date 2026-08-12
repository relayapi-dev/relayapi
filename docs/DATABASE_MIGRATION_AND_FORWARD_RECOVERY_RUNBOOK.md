# Database migration and forward-recovery runbook

RelayAPI deploys application code and PostgreSQL schema independently. Production
migrations therefore use expand/contract compatibility: a migration that runs
before a Worker deployment must remain compatible with the Worker already serving
traffic.

## Current state: fresh pre-live baseline

The pre-live development migration chain has been reset. The authoritative
migration directory now contains exactly:

- `0000_baseline.sql`
- `meta/0000_snapshot.json`
- `meta/_journal.json`
- `migration-manifest.json`
- `migration-policy.json`

The baseline is generated from the complete current Drizzle schema plus the
source-owned database preamble and non-declarative SQL renderers. It includes the
credential-containment work that had previously existed as pending `0008`, along
with every table, constraint, index, extension, function, and trigger required by
the current code.

`packages/db/baseline-generation.json` and
`packages/db/baseline-build-policy.json` declare sealed initial generation 1.
Hosted API, dashboard, and self-host Worker configuration also declare generation
1. The active manifest contains one migration with these fingerprints:

```text
0000 SQL SHA-256:     31420f76c33c6803473ed806219cd6f69847d14e6e160fb71b92ff507cbeaf28
0000 snapshot SHA-256: 7609b706f901baf909966ca3be56f9163a1ef8220fb3a085769a020277eaa35d
```

This baseline supports only a virgin database. It is not an upgrade migration for
any database that contains the former `0000`–`0008` development ledger.

The historical PostgreSQL 18 old-chain catalog fingerprint remains audit evidence
for the discarded development chain. It is deliberately not treated as evidence
for the new baseline because its manifest binding is different. Until a new
reviewed fingerprint is captured from a PostgreSQL 18 replay, live catalog checks
use the complete schema-derived verifier.

## What the repository reset did not do

No database was connected to, dropped, truncated, migrated, or recreated. No
Cloudflare Worker, Queue, KV namespace, or R2 bucket was changed. No Git state was
written. The operator remains responsible for recreating the pre-live database
and deciding whether any existing data needs a backup first.

## One-time Git protection bootstrap

The protected comparison base currently predates
`packages/db/baseline-generation.json`. CI therefore has one deliberately narrow
bootstrap rule for the commit that introduces the reset:

- the authorization must equal the exact `base-sha:HEAD-sha` edge;
- the base must be `HEAD`'s first parent;
- the result must be sealed generation 1;
- generation, build policy, manifest, and journal baseline identities must agree;
- the replacement history must contain exactly one baseline migration.

The CI workflows construct that exact authorization from their checked-out Git
edge. Once generation metadata is present on protected `main`, the bootstrap branch
is permanently unreachable and normal append-only prefix verification applies.

For a manual reproduction of that one transition:

```bash
MIGRATION_BASE_SHA=<full-base-sha> \
MIGRATION_PROTECTED_REF=<protected-ref-containing-base> \
RELAYAPI_PRELIVE_BASELINE_RESET=<full-base-sha>:<full-head-sha> \
  bun run --cwd packages/db migration:append-only
```

Do not reuse this environment variable for later schema work. It has no effect
after the protected base contains generation metadata.

## Repository verification before database recreation

Use the repository-pinned Bun version and run:

```bash
bun run --cwd packages/db baseline:rebuild:check
bun run --cwd packages/db baseline:sealed:check
bun run --cwd packages/db migration:manifest:check
bun run --cwd packages/db migration:policy:check
bun run --cwd packages/db migration:source-ownership
bun run --cwd packages/db verify:schema-contracts
bun run --cwd packages/db test:migration-contracts
bun run --cwd packages/db test:schema-invariants
```

`baseline:rebuild:check` independently regenerates the baseline from `schema.ts`
and the SQL renderers and requires byte-identical artifacts. It does not connect
to a database.

CI additionally starts the digest-pinned PostgreSQL 18 + pgvector service, applies
the one migration twice, verifies the complete live schema and non-declarative
catalog, and checks the exact Drizzle ledger hashes.

## Operator database recreation

This section is intentionally an operator checklist, not an automated destructive
command.

1. Confirm the target is the disposable pre-live environment. Record its exact
   account, host, database name, and current Worker versions.
2. Decide whether anything must be retained. If yes, create a backup and verify
   that it can be restored before continuing.
3. Stop or contain every writer: API, dashboard auth writes, scheduled jobs,
   Queue consumers, and any self-host runner using the target.
4. Recreate the database, or remove the old database and create a genuinely
   virgin replacement. Do not leave an empty `drizzle.__drizzle_migrations`
   ledger or old user objects in `auth`/`public`; the migration guard rejects
   those ambiguous states.
5. Provision separate migration and runtime roles. The migration role owns DDL.
   The runtime role must not own schema objects or have schema-creation rights.
6. Confirm PostgreSQL 18 and availability of `btree_gist`, `pg_trgm`, and `vector`.
   The baseline creates them in `public` and fails closed if a preinstalled
   extension is in the wrong schema.
7. Apply the baseline with the migration connection:

   ```bash
   bun run --cwd packages/db migrate
   bun run --cwd packages/db migrate
   bun run --cwd packages/db verify:migrations
   bun run --cwd packages/db migration:history:current
   ```

   The first run applies `0000`; the second proves idempotence. The remaining
   commands verify the full live catalog and exact ledger bytes.

8. Grant the runtime role only its reviewed runtime privileges, then verify that
   a rolled-back DDL probe fails for that role.
9. Deploy API and dashboard builds that both declare
   `BASELINE_GENERATION=1`, run their health/smoke checks, and only then resume
   scheduled work and Queue consumers.
10. Record the database identity, baseline hash, Worker version IDs, operator,
    timestamps, verification output, and backup/restore decision.

For hosted production, `.github/workflows/deploy-api.yml` applies production
migrations only on a reviewed `workflow_dispatch`; push deployments are code-only
and require the database to be current. The manual API workflow runs migration
and catalog verification before deploying the Worker. The required compatible
dashboard version ID remains an explicit input.

The user has chosen to recreate the database manually. Do not run
`packages/db/scripts/prelive-reset.ts` for this initial-baseline reset: that tool
belongs to the separately protected future generation-collapse procedure and can
also coordinate destructive Cloudflare state.

## Rules after the first persistent initialization

After any persistent environment has applied this `0000`, migration history is
append-only:

- never reopen `baseline-build-policy.json` to `pre-launch`;
- never rerun `--pre-live-reset`;
- never edit `0000_baseline.sql`, its snapshot, journal entry, or manifest hash;
- never delete or rewrite an applied Drizzle ledger row;
- add a new numbered expand or contract migration for every schema change;
- update the migration policy and manifest together;
- keep self-host compatibility notes/tests with API, auth, app, or database
  changes intended for operators.

The reset builder itself is fail-closed. `--pre-live-reset` requires both a
`pre-launch` policy and `--confirm-pre-launch-virgin-reset`; the policy is now
sealed, so another reset is refused. Its directory replacement is staged,
verified, and rollback-protected. A leftover `.baseline-backup-*` directory or
`.drizzle-baseline-rebuild.lock` is a stop condition requiring manual inspection.

## Ordinary release phases

1. **Expand** — add compatible nullable columns, tables, indexes, constraints,
   or dual-write support. Do not drop or rename objects read by the live Worker.
2. **Verify artifacts** — run manifest, append-only, policy, source-ownership,
   schema-contract, and PostgreSQL 18 replay checks.
3. **Apply the compatible migration** — use the migration role, never the
   runtime role.
4. **Deploy compatible code** — the new Worker must tolerate the full migration
   compatibility window.
5. **Backfill and reconcile** — use bounded, resumable, fenced work and verify
   invariants before switching reads.
6. **Contract later** — remove obsolete objects only after old code cannot
   receive traffic and the compatible-release prerequisite has been proven.

## Forward recovery

Never automatically roll a persistent database backward after a migration has
reached its catalog.

- **Initial baseline fails:** because this is still pre-live, preserve the exact
  error, recreate the disposable database, correct the repository or platform
  prerequisite, and replay from the beginning. Do not massage an empty or partial
  ledger into appearing current.
- **Later migration fails before commit:** preserve the error and ledger, stop
  releases, and prepare a reviewed forward fix.
- **Migration succeeds but Worker deploy fails:** keep or restore compatible code
  traffic and fix the Worker forward. Do not revert schema automatically.
- **New Worker is unhealthy:** direct traffic to a previously compatible Worker
  only when its compatibility with the applied schema is proven.
- **Backfill is interrupted:** resume from its durable checkpoint. Never blindly
  repeat an unfenced external effect or unbounded rewrite.
- **Contract migration incident:** stop further deploys and ship the smallest
  forward repair. Restore from backup only through the disaster-recovery process
  with an explicit data-loss decision.

## Stop conditions

Do not migrate when any of these are true:

- the target is not confirmed disposable/virgin for this reset;
- a required backup or restore rehearsal has not been accepted;
- the manifest, sealed-generation, append-only, policy, source-ownership, or
  schema verifier fails;
- PostgreSQL is not the reviewed major or required extensions are unavailable;
- the migration connection is actually the runtime role;
- writers are still active against a database being recreated;
- API and dashboard generation bindings disagree with repository generation;
- the old/new code compatibility window has not been demonstrated.
