**OPERATOR CHECKLIST**

# Remaining Production Readiness Steps

*Post-remediation runbook for converting locally complete code into an approved RelayAPI production release*

**Repository:** relayapi

**Prepared:** 8 August 2026

**Current position:** Code complete; production remains NO-GO pending external evidence

**Scope:** Source-control handoff, database, Cloudflare, recovery, canaries, dependencies, and release approval

> **Release rule.** Do not promote production traffic until every gate in this document is marked PASS, its evidence is retained, and an independent reviewer records an explicit GO.

## 1. Current position

**Complete:** The audit remediation, local typechecks, lint, API and package suites, OpenAPI generation, and production builds are green.

**Open:** The working tree still needs a user-controlled review and commit. Production database, Cloudflare, recovery, provider, dependency, and approval evidence has not been executed in this local session.

**Not blockers unless scope changes:** Broad CLI parity and measurement-driven architecture improvements remain roadmap decisions rather than confirmed defects.

## 2. Gate overview

| **Gate** | **Owner** | **Dependency** | **Pass signal** |
| --- | --- | --- | --- |
| 0. Source handoff | Maintainer | Code review | Reviewed commits and PR |
| 1. Baseline replay | DB + release | Gate 0 | PostgreSQL 18 catalog matches |
| 2. DB fixtures | DB + API | Gate 1 | Exactly 46 pass, none skip |
| 3. Private DB/VPC | Infra + DB | Gates 1–2 | Pinned VPC ID and verifier pass |
| 4. Secrets | Security + release | Gate 0 | Exact API/app secret sets |
| 5. DNS/TLS | Infra | Deployed candidates | Edge verification passes |
| 6. Backup/restore | DB + operations | Gate 1 | Restore succeeds; RPO/RTO recorded |
| 7. Load | Performance + ops | Gates 3–6 | Thresholds pass without backlog |
| 8. Provider canaries | Integrations + ops | Gates 3–6 | Controlled matrix passes |
| 9. Dependencies | Maintainers | Parallel; due 2 Sep | No expired or unmatched finding |
| 10. GO approval | Independent reviewer | All prior gates | Signed GO for exact versions |

### 2.1 Recommended execution order

1. Review and commit the working tree; open an independently reviewed pull request.

1. Run the protected PostgreSQL 18 baseline replay, then the required 46-case database fixture suite.

1. Converge the private database/VPC path, production secret intent, and DNS/TLS controls in parallel.

1. Complete backup/restore, load testing, and controlled provider canaries against the reviewed candidates.

1. Resolve or renew dependency exceptions before expiry, assemble the evidence packet, and hold the final GO/NO-GO review.

## 3. Execution checklist

### Gate 0 — User-controlled source review, commit, and PR

**Accountable role:** Repository maintainer; independent code reviewer

**Objective:** Convert the locally green working tree into reviewable, immutable Git history without mixing secrets or unrelated user work.

**Actions**

- [ ] Review the complete status and diff, including every untracked file; confirm all paths belong to this remediation.

- [ ] Run secret scanning and inspect generated artifacts before staging. Never stage plaintext production files, .env.keys, private keys, or credentials.

- [ ] Split the work into logical Conventional Commits where practical, retaining API/SDK and self-host compatibility changes together.

- [ ] Push a branch and open a pull request that names the audit report, validation results, external gates, and rollback considerations.

- [ ] Require an independent review; do not self-approve the production release path.

**Repository commands**

```bash
git status --short --branch
git diff --check
bun run typecheck
bun run lint
bun run --cwd apps/api test
bun run --cwd apps/api test:workerd
```

**Required completion evidence**

- Commit SHA(s), pull-request URL, reviewer identity, and approval timestamp.

- Final green CI links and a retained list of intentionally skipped external fixtures.

- Confirmation that no secret-bearing or unrelated file entered the commit.

> **STOP CONDITION.** Do not stage or rewrite the tree until a maintainer confirms the full diff. Any secret or unexplained path blocks the commit and requires remediation first.

### Gate 1 — Protected PostgreSQL 18 baseline replay and catalog proof

**Accountable role:** Database owner and release operator

**Objective:** Prove that the sealed baseline creates the reviewed database shape on PostgreSQL 18 before any production deployment.

**Actions**

- [ ] Confirm the target database is the explicitly disposable pre-live instance and that the reviewed inventory and source commit are exact.

- [ ] Use the protected cutover workflow and the database forward-recovery runbook; do not reproduce the destructive reset manually.

- [ ] Replay the sealed baseline under PostgreSQL 18, verify migration history and schema contracts, and compare the complete catalog fingerprint with reviewed evidence.

- [ ] Retain database identity, workflow run, source SHA, migration manifest, catalog digest, extension inventory, and generation evidence.

**Repository commands**

```bash
bun run db:verify-schema-contracts
bun run db:verify
# Protected workflow: .github/workflows/prelive-baseline-cutover.yml
# Runbook: docs/DATABASE_MIGRATION_AND_FORWARD_RECOVERY_RUNBOOK.md
```

**Required completion evidence**

- Successful protected workflow run bound to the exact reviewed commit and database identity.

- Matching catalog fingerprint, extension/version inventory, and contiguous migration ledger.

- Proof that no non-allowlisted schema, object, or extension remains.

> **STOP CONDITION.** Any identity mismatch, unexpected inventory, catalog drift, extension mismatch, or migration failure keeps production NO-GO. Follow forward recovery; do not improvise a down migration.

### Gate 2 — Required 46-case database authority and race suite

**Accountable role:** Database owner and API test operator

**Objective:** Execute every database-backed authority, lifecycle, and concurrency fixture that was skipped locally.

**Actions**

- [ ] Configure RELAYAPI_DB_SSH_TARGET and the loopback-only database URL through the approved command-scoped tunnel.

- [ ] Run the fail-closed required-fixture runner against PostgreSQL 18 after the baseline replay.

- [ ] Verify the discovered inventory remains exactly 46 cases and that no case is added, removed, skipped, or quarantined.

- [ ] Retain JUnit or equivalent machine-readable output with test names, database identity, source SHA, and timestamps.

**Repository commands**

```bash
bun run db:with-tunnel -- bun run --cwd apps/api test:db-fixtures:required
```

**Required completion evidence**

- Exactly 46 passed, zero failed, zero skipped.

- Fixture inventory and JUnit counts match the protected workflow contract.

- Tunnel ownership and target database identity are recorded without exposing credentials.

> **STOP CONDITION.** A missing tunnel, inventory drift, skip, flaky retry, or single failure blocks the release. Do not replace this gate with the ordinary isolated API suite.

### Gate 3 — Private database path and pinned Hyperdrive VPC service

**Accountable role:** Cloudflare infrastructure owner and database owner

**Objective:** Remove the legacy public database origin and prove that production Workers use the reviewed private/VPC path and no-DDL runtime role.

**Actions**

- [ ] Provision or identify the reviewed Workers VPC Service and private PostgreSQL TLS identity.

- [ ] Configure the no-DDL runtime role with only the permissions required by the API.

- [ ] Pin the real Hyperdrive VPC service ID in apps/api/production-resources.json; keep query caching explicitly disabled.

- [ ] Verify origin, TLS, runtime role, binding identity, and the absence of a public or legacy Access origin.

**Repository commands**

```bash
bun run --cwd apps/api cloudflare:verify-prerequisites
bun run --cwd apps/api cloudflare:verify-production
```

**Required completion evidence**

- Real pinned VPC service ID and redacted Hyperdrive configuration response.

- Successful production verifier output for origin, TLS, runtime role, bindings, Queues, and R2.

- Database network evidence demonstrating no public application path.

> **STOP CONDITION.** A null VPC ID, public origin, TLS identity mismatch, DDL-capable runtime role, or verifier drift keeps deployment fail-closed.

### Gate 4 — Production secret intent and exact Worker reconciliation

**Accountable role:** Security owner and protected release operator

**Objective:** Populate, encrypt, stage, and verify exact API and dashboard secret sets without cross-target or stale bindings.

**Actions**

- [ ] Import real production values only into the ignored per-Worker production files; never copy development placeholders.

- [ ] Encrypt the API and app production vaults with the production key, armor/native-store the key material, and validate ciphertext intent.

- [ ] Run non-mutating preflight for both targets; require complete provider groups and reject stale, cross-target, wrong-type, or unexpected names.

- [ ] Deploy only through the protected workflow, capture previous Worker version IDs, and promote the exact inspected candidates.

- [ ] Run post-deploy verification and retain names-only evidence; never include secret values in the release packet.

**Repository commands**

```bash
bun run secrets:encrypt -- production
bun run secrets:validate
bun run secrets:check
bun run secrets:cf:preflight -- api
bun run secrets:cf:preflight -- app
bun run secrets:cf:verify -- api
bun run secrets:cf:verify -- app
```

**Required completion evidence**

- Vault validation and sync-status output with no plaintext or key material.

- Exact intended-versus-deployed secret-name equality for API and app.

- Previous and promoted Worker version IDs plus the reviewed rollback/forward-repair path.

> **STOP CONDITION.** Any placeholder, missing required name, incomplete provider group, unexpected binding, or secret-value exposure blocks promotion and requires key/credential rotation if exposure occurred.

### Gate 5 — DNS, HTTPS, TLS, custom domains, and edge policy

**Accountable role:** Cloudflare zone owner and release operator

**Objective:** Prove that all public RelayAPI surfaces enforce the reviewed HTTPS and browser security policy.

**Actions**

- [ ] Enable and verify zone-wide Always Use HTTPS for relayapi.dev.

- [ ] Confirm the API, dashboard, docs, and thumbnail custom domains resolve to the exact reviewed Workers or R2 domain bindings.

- [ ] Verify certificates, minimum TLS policy, same-host redirects, HSTS and security headers, and removal of framework identity leakage.

- [ ] Run the edge and Cloudflare production verifiers against the deployed candidates before traffic promotion.

**Repository commands**

```bash
bun run edge:verify-production
bun run --cwd apps/api cloudflare:verify-production
```

**Required completion evidence**

- DNS records, certificate status, TLS policy, redirect chain, and security-header captures for each production hostname.

- Successful edge and Cloudflare production verification bound to exact Worker versions.

> **STOP CONDITION.** HTTP availability without a safe redirect, certificate or hostname mismatch, weak TLS, missing security policy, or unexpected route binding blocks release.

### Gate 6 — Backup, isolated restore, and recovery objectives

**Accountable role:** Database owner and operations lead

**Objective:** Demonstrate that production data can be restored into isolated PostgreSQL 18 within approved recovery objectives.

**Actions**

- [ ] Take and checksum a production-like backup using the approved provider mechanism.

- [ ] Restore it into an isolated PostgreSQL 18 target with no production traffic or provider credentials.

- [ ] Verify schema contracts, migration ledger, row-count/invariant samples, encryption-key availability, and application read/write smoke behavior.

- [ ] Measure backup age, restore duration, data-loss window, and operator steps; set and approve explicit RPO and RTO targets.

- [ ] Document the forward-recovery and containment decision if the primary deployment fails after migration.

**Required completion evidence**

- Backup checksum and provider job identity; no database contents or credentials in the packet.

- Successful isolated restore logs, schema verification, smoke results, measured RPO/RTO, and cleanup confirmation.

- Named recovery owner and reviewed incident/rollback procedure.

> **STOP CONDITION.** An unverified backup, failed restore, missing encryption authority, data-integrity mismatch, or unapproved RPO/RTO blocks launch.

### Gate 7 — Production-like load and failure-recovery test

**Accountable role:** Performance owner, API owner, and operations lead

**Objective:** Prove the reviewed release remains within agreed latency, error, queue, database, and storage limits at expected and peak launch traffic.

**Actions**

- [ ] Define pass thresholds before testing: p50/p95/p99 latency, throughput, error rate, queue backlog/age, database connections, memory, and recovery time.

- [ ] Exercise representative reads and writes, authenticated tenant isolation, uploads, publish queues, webhooks, dashboard requests, and recovery paths.

- [ ] Run expected-load, burst, soak, and controlled dependency-failure scenarios without using real customer data or uncontrolled provider mutations.

- [ ] Confirm queues drain, rescue/DLQ paths remain bounded, database pressure recovers, and observability traces support diagnosis.

**Required completion evidence**

- Versioned load plan, environment identity, workload profile, thresholds, dashboards, raw result archive, and analysis.

- No sustained backlog, resource exhaustion, tenant leakage, or unbounded retry behavior.

- Documented capacity margin and launch-day alert thresholds.

> **STOP CONDITION.** Do not redefine thresholds after seeing results. Any breached agreed threshold, growing backlog, integrity issue, or non-recovery requires remediation and a complete rerun.

### Gate 8 — Controlled social-provider and advertising canaries

**Accountable role:** Integrations owner, provider-account owner, and operations lead

**Objective:** Validate live provider contracts using controlled test identities while preventing unintended publication, messaging, or paid spend.

**Actions**

- [ ] Create a provider matrix naming each launch-critical platform, operation, test identity, expected result, cleanup, and rollback owner.

- [ ] Use private/draft/test destinations where supported; pre-approve any public post, message, WhatsApp action, or advertising spend cap.

- [ ] Exercise OAuth/token refresh, media validation/upload, publish or read path, webhook/callback reconciliation, error classification, and cleanup.

- [ ] Record provider request IDs and RelayAPI operation IDs after redaction; remove test content and verify no residual campaign or spend remains.

**Required completion evidence**

- Completed provider matrix with exact release version, account, operation, result, cleanup, and reviewer.

- Bounded request/operation evidence, provider-side confirmation, and zero unintended spend or audience exposure.

- Known provider limitation or waiver explicitly accepted by the launch owner.

> **STOP CONDITION.** Any uncontrolled publication, unexpected charge, credential leak, ambiguous provider outcome, failed cleanup, or contract drift blocks the affected provider and the release scope that depends on it.

### Gate 9 — Dependency advisory resolution before 2 September 2026

**Accountable role:** Dependency maintainers and security reviewer

**Objective:** Prevent the 172 accepted dependency paths covering 75 advisories from becoming expired, unreviewed security debt.

**Actions**

- [ ] Run the current dependency audit against the exact lockfile and classify every finding by artifact and runtime/development path.

- [ ] Prefer upgrading, replacing, removing, or isolating vulnerable packages; rerun typecheck, tests, builds, and package smokes after changes.

- [ ] If a finding cannot be removed, renew only the exact observed path with a current reason, compensating controls, reviewed date, and no more than 30 days of expiry.

- [ ] Delete stale exceptions and reject any unmatched, changed-version, changed-path, or expired entry.

**Repository commands**

```bash
bun scripts/dependency-audit.ts
bun test scripts/dependency-audit.test.ts
```

**Required completion evidence**

- Zero unmatched, expired, stale, or policy-invalid findings.

- Change and review record for every upgraded package or renewed exception.

- Green CI and package smoke evidence after dependency changes.

> **STOP CONDITION.** An expired exception, unmatched advisory, lockfile drift, or untested dependency upgrade blocks release until the policy is current and green.

### Gate 10 — Independent GO/NO-GO review and controlled promotion

**Accountable role:** Independent release approver; launch incident commander

**Objective:** Bind the launch decision to exact source and Worker versions, complete evidence, rollback authority, and monitored traffic promotion.

**Actions**

- [ ] Assemble a superseding launch-readiness record with every gate owner, PASS/FAIL state, evidence link, exception, and expiry.

- [ ] Verify production environment protections require at least one independent approval and prevent self-approval.

- [ ] Record exact source commit, database generation/catalog digest, API/app/docs Worker version IDs, configuration digests, and secret-name verification.

- [ ] Name the incident commander, rollback/forward-repair authority, monitoring window, alert thresholds, and stop triggers.

- [ ] Record an explicit GO or NO-GO. If GO, promote traffic through the protected release path and monitor the agreed window.

**Required completion evidence**

- Signed decision record naming approver, timestamp, exact versions, scope, evidence packet, and accepted exceptions.

- Protected-environment approval log and deployment/version history.

- Launch monitoring record and final stabilization or containment decision.

> **STOP CONDITION.** Missing evidence, self-approval, version ambiguity, expired exception, failed gate, or absent incident authority requires NO-GO. A green local suite alone is never release approval.

## 4. Final evidence packet

**Store together:** The packet should be immutable or versioned, access-controlled, and free of secret values or customer data.

- [ ] Source commit(s), pull request, independent review, and complete CI summary.

- [ ] Pre-live database identity, protected workflow run, migration ledger, PostgreSQL 18 catalog fingerprint, and 46-case test report.

- [ ] Hyperdrive/VPC, Worker binding, R2, Queue, DNS/TLS, and exact secret-name verification for the promoted versions.

- [ ] Backup checksum, isolated restore report, RPO/RTO measurements, and recovery owner.

- [ ] Load-test plan/results and provider-canary matrix with cleanup confirmation.

- [ ] Dependency audit result and any current, reviewed exceptions.

- [ ] Final GO/NO-GO record, incident commander, promotion plan, monitoring window, and stop/rollback triggers.

## 5. Definition of ready

RelayAPI is ready for production traffic only when **all eleven gates are PASS**, the dependency policy is current, the exact release is independently approved, and the launch operator has verified monitoring and containment authority. Until then, the correct status is NO-GO.

## 6. Repository references

- docs/RelayAPI_Repository_Unfinished_Features_and_Bugs_Audit_2026-08-08.md

- docs/REPOSITORY_SERIOUS_ISSUES_ULTRASCAN_2026-08-02.md

- docs/PRODUCTION_LAUNCH_READINESS_2026-07-18.md

- docs/DATABASE_MIGRATION_AND_FORWARD_RECOVERY_RUNBOOK.md

- .github/workflows/prelive-baseline-cutover.yml

- apps/api/production-resources.json

- apps/api/scripts/verify-cloudflare-production.ts

- scripts/dependency-audit-exceptions.json
