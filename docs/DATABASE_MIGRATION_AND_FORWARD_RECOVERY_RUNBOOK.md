# Database migration and forward-recovery runbook

RelayAPI deploys application code and PostgreSQL schema independently. Production
migrations therefore follow an expand/contract discipline: every migration applied
before a Worker deploy must remain compatible with the currently running Worker.

## Current baseline boundary

The `0000_baseline` migration is a destructive, pre-launch PostgreSQL 18 baseline.
It supports a virgin database only. The superseded development migration chain is
not an upgrade path. Do not apply this baseline over an existing RelayAPI catalog.

Before the first production initialization, independently inventory and preserve
any environment that might contain data. Backup storage, retention, and restore
rehearsal are operator responsibilities outside this repository.

## One-time virgin baseline build (completed)

The checked-in baseline completed its one-time build on 2026-07-15 and
`packages/db/baseline-build-policy.json` is now `sealed`. The baseline was rebuilt
only from an empty Drizzle staging directory. The builder
requires exactly one reviewed `baseline` policy entry, exactly one existing
`0000_baseline` history entry, and no unexpected migration files. It generates the
declarative schema, appends the generated non-declarative contracts exactly once,
normalizes the journal/tag/snapshot identity, writes a manifest that hashes the SQL
and Drizzle snapshot/journal metadata, and runs the static manifest, policy, and
schema-contract verifiers. It does not use shell redirection. Write mode takes an
exclusive local lock and refuses stale crash backups; if post-write verification
throws, it restores the prior directory. Once a replacement is verified, a backup
cleanup failure leaves the verified target installed for manual cleanup rather than
rolling back from a potentially partial backup.
Portable directory rename is not power-loss atomic: a terminated process can leave
a `.baseline-backup-*` directory or `.drizzle-baseline-rebuild.lock`. Treat either
as a stop condition, confirm that no writer is live, and manually inspect/restore
the backup before removing the marker and retrying.

Drizzle does not emit the required database prerequisites. The builder therefore
prepends one generated preamble before any declarative SQL: `CREATE SCHEMA IF NOT
EXISTS "auth"` for Better Auth tables and `CREATE EXTENSION IF NOT EXISTS
"pg_trgm" WITH SCHEMA "public"` for the `gin_trgm_ops` inbox-search index,
followed by a fail-closed namespace assertion for a pre-existing extension. Both
the builder and the static verifier reject missing or duplicate preamble
markers/statements. If a future Drizzle release starts generating either
prerequisite, rebuilding fails closed instead of appending it twice.

The read-only reproducibility modes remain available from the repository root:

```bash
bun run --cwd packages/db baseline:rebuild:dry-run
bun run --cwd packages/db baseline:rebuild:check
```

The following command was the explicit one-time pre-launch write operation:

```bash
bun run --cwd packages/db baseline:rebuild --confirm-pre-launch-virgin-reset
```

It is intentionally refused now that the lifecycle is sealed. Do not change the
lifecycle back to `pre-launch`; all later schema changes must be new, append-only
expand/contract migrations. Dry-run and check modes remain read-only.

This builder is not an upgrade, rebaseline, or data-preservation mechanism. Never
run write mode after any persistent database has applied `0000_baseline`.

## Required release phases

1. **Expand** — add nullable columns, tables, indexes, constraints, or dual-write
   support. Do not drop or rename objects read by the live Worker.
2. **Verify migration artifacts** — run the manifest, append-only, policy, schema
   contract, and PostgreSQL 18 replay checks.
3. **Apply the compatible migration** — use the migration role through Workers VPC
   or the Access-protected TCP administration path. The runtime role must not own
   schema objects or have DDL privileges.
4. **Deploy compatible code** — the new Worker must tolerate both pre-backfill and
   post-backfill rows. Observe error rate, queue retries, database locks, and the
   deployment smoke checks.
5. **Backfill and reconcile** — run bounded, resumable work with durable progress.
   Verify counts and invariants before changing reads to the new representation.
6. **Contract in a later release** — only after the old Worker version can no longer
   receive traffic and the backfill is verified may a separate migration make new
   fields required or remove obsolete objects.

## Commands

From the repository root:

```bash
bun run --cwd packages/db migration:manifest:check
bun run --cwd packages/db migration:append-only
bun run --cwd packages/db migration:policy:check
bun run --cwd packages/db verify:schema-contracts
bun run --cwd packages/db verify:migrations
```

`verify:migrations` must replay the complete migration directory on PostgreSQL 18,
run it a second time to prove there is no unapplied migration, and compare the live
catalog with the expected schema contracts. A local disposable PostgreSQL 18
container is appropriate for this gate; it is not production evidence.

## Failure and forward recovery

Never automatically roll a database backward after a migration has reached a live
catalog. Instead:

- **Migration fails before commit:** preserve the exact error and migration ledger.
  For the one-time virgin baseline, recreate the disposable database from scratch;
  Drizzle may have created an empty ledger outside the rolled-back migration, and
  the history guard intentionally refuses that ambiguous state. For a persistent
  environment, stop for reviewed forward recovery—never delete or rewrite its
  ledger merely to make a retry start.
- **Migration succeeds but Worker deploy fails:** keep the old Worker serving. The
  expand migration must be old-code compatible. Fix or roll forward the Worker.
- **New Worker is unhealthy:** direct traffic back to the previous compatible Worker
  version without reverting schema, then prepare a forward application fix.
- **Backfill is interrupted:** resume from its durable checkpoint. Never restart an
  unfenced external effect or an unbounded table rewrite blindly.
- **Contract migration causes an incident:** stop further deploys and ship the
  smallest forward repair that restores the required object/compatibility surface.
  Restore from backup only under the separate disaster-recovery procedure, with an
  explicit data-loss decision.

Record migration identifier, catalog checksum, operator, start/end time, affected
environment, validation output, deploy version, and any recovery action in the
release record.

## Stop conditions

Do not migrate when any of these are true:

- the manifest or append-only verifier fails;
- the SQL contains an unapproved destructive or contract-phase operation;
- the database is not confirmed as PostgreSQL 18 with TLS verification;
- the active connection is using the runtime role for DDL;
- a production catalog would receive the virgin baseline;
- a required backup/restore rehearsal has not been accepted by the operator;
- the old and new Worker compatibility window has not been demonstrated.
