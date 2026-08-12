# RelayAPI production launch readiness — 2026-07-18

## Decision

**NO-GO for production traffic.**

The repository-side remediation and fail-closed release controls are implemented,
but the deployed environment is not yet conformant. This document is the current
launch record; the July 12–14 audit files are historical evidence, not release
approval.

No Worker was deployed, no production database migration was applied, and no
secret value was created, rotated, or deleted. Safe GitHub governance and exact
non-traffic-bearing Cloudflare Queue/R2 prerequisites were changed and verified
as recorded below.

## Repository controls now in place

- Production authentication is invitation-gated for password and first-time OAuth
  identities. Email verification, password recovery, account-deletion
  confirmation, authoritative organization-role checks, a shared atomic rate
  limiter, safe redirects, and sanitized proxy failures are covered by tests.
- API failures use the documented `{ error: { code, message, details? } }`
  contract, and unexpected 5xx failures do not expose internal or provider
  messages. Production HTTP requests are redirected to HTTPS by all three Workers;
  browser security headers are enforced by deploy smoke checks.
- Publishing records truthful provider lifecycle states, distinguishes accepted
  or ambiguous operations from terminal publication, persists evidence and
  per-effect outcomes, and reconciles nonterminal outcomes without repeating a
  provider mutation.
- Automation surfaces advertise only executable bindings, actions, entrypoints,
  and templates. Removed or unfinished features are rejected rather than accepted
  as no-ops.
- OpenAPI, generated documentation, SDK, CLI, MCP server, n8n, and Zapier contracts
  are gated in CI. Published packages have packed Node.js install/runtime smoke
  tests.
- Database history is append-only after a sealed baseline. Migrations are checked
  against a manifest and phase policy; CI is configured to replay them on clean
  PostgreSQL 18 and compare the full Drizzle catalog before deployment.
- Production deploy workflows require a protected `main` ref, the GitHub
  `production` environment, reviewed encrypted secret intent,
  migration/hash/catalog checks, and post-deploy smoke checks. Code-version
  rollback is automatic for app/docs and code-only API releases; exact
  non-versioned configuration is reverified and requires forward repair if it
  drifted. Schema-aware API releases always use reviewed forward recovery.
- Production secrets have per-target allowlists, complete provider-group checks,
  encrypted dotenvx vault support, strict encryption-key-ring validation, and
  safe-subset live binding verification before deployment and exact encrypted-
  vault name verification after deployment.
  Because Wrangler secret files are additive, stale or cross-target bindings
  fail the non-mutating preflight and require a separately reviewed versioned
  secret-removal change with rollback captured first.
- Critical workflow actions, Bun/Node toolchains, and database/tunnel container
  images are pinned to immutable reviewed revisions or digests. Release and
  publish permissions are scoped per job.
- Active Worker checks verify exact non-secret binding identities, runtime
  compatibility flags, observability/placement policy, cron triggers, and the
  API/dashboard/docs custom-domain mapping to the promoted Worker version.
- The reviewed Queue topology includes a DLQ for every primary consumer, a rescue
  Queue, and a finite-retention R2 rescue ledger. Media notifications cover object
  creation, copy, multipart completion, explicit deletion, and lifecycle deletion.

## Live Cloudflare changes completed

The following exact prerequisites were created or corrected in the RelayAPI
account:

- missing primary, DLQ, customer-webhook, and rescue Queues from
  `apps/api/production-resources.json`;
- `relayapi-queue-rescue-ledger` with a 30-day lifecycle rule;
- one unfiltered `relayapi-media` notification rule covering `PutObject`,
  `CopyObject`, `CompleteMultipartUpload`, `DeleteObject`, and
  `LifecycleDeletion`;
- the exact `relayapi-media` browser-upload CORS policy: origin
  `https://relayapi.dev`, method `PUT`, headers `Content-Type` and
  `If-None-Match`, and a 3,600-second maximum age;
- the `thumbs.relayapi.dev` custom-domain minimum TLS version was raised from 1.0
  to 1.2; ownership and SSL are active, and public `r2.dev` access remains
  disabled for every reviewed private bucket;
- an R2 write/read/delete canary on the rescue ledger. The temporary canary object
  was explicitly deleted and its absence was confirmed.

These resources are prerequisites only. Their consumers and bindings become
active with the reviewed Worker deployment, and the end-to-end failure drill is
still required.

## Blocking external closure

Every item in this section is a launch stop condition.

### 1. GitHub release authority lacks independent review and deploy credentials

The following live safeguards are now enabled:

- `main` requires a pull request, enforces protection for administrators, signed
  commits, linear history, and resolved conversations, and rejects force pushes
  and deletion;
- `main` requires the branch to be current and requires these exact checks:
  `Biome Lint`, `Gitleaks`, `Analyze (actions)`,
  `Analyze (javascript-typescript)`, and `Analyze (python)`; all five contexts
  are bound to the GitHub Actions app;
- the `production` environment is restricted to `main` and names the only current
  collaborator, `zanhk`, as reviewer; administrators cannot bypass the
  environment, but self-review remains allowed;
- default Actions permissions are read-only and Actions cannot approve pull
  requests;
- immutable SHA pinning for Actions is enforced;
- Dependabot automated security updates, GitHub secret scanning and push
  protection, private vulnerability reporting, and CodeQL default setup are
  enabled.

Launch remains blocked because the repository has only one collaborator, so the
current zero-approval pull-request rule and self-reviewable production
environment cannot provide independent review. Add a second trusted maintainer
or team, then require at least one independent pull-request approval and disable
self-approval for production deployments.

The first CodeQL default-setup run completed for Actions, JavaScript/TypeScript,
and Python. Nine findings whose sinks exist only in test fixtures were reviewed
and dismissed with `used in tests` evidence. However, the current remote default
branch still has 15 open CodeQL alerts: nine workflow-permission findings, two
login-redirect findings, two feed-parser findings, one dependency-audit parser
finding, and one catalog-upgrade encoding finding. The working tree contains the
corresponding remediations, but that does not close or prove the remote alerts.
Because direct pushes to `main` are blocked, publish the work on a branch, pass
the required checks, merge it through the protected pull-request path, and retain
a post-merge CodeQL rescan showing the default-branch alerts closed or otherwise
reviewed with specific evidence.

The `production` environment still has no secret or variable, and repository
Actions secrets contain only `CLAWHUB_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and
`CLOUDFLARE_API_TOKEN`. Add the workflow secrets documented at the top of each
deployment/release workflow. At minimum the current workflows also require
`DOTENVX_ARMOR_TOKEN`, the protected production database URL/hostname/CA/Access
credentials, and `NPM_TOKEN` for package publication. GitHub's additional
non-provider secret-pattern and validity checks could not be enabled with the
current organization/license controls; the repository's pinned Gitleaks workflow
remains the required complementary scan.

### 2. Production secrets are incomplete

`bun run secrets:check` reports both production vaults as unconfigured. Live
Worker inspection also reports:

- API: missing `RESEND_API_KEY`; the enabled WhatsApp provider set is missing
  `WHATSAPP_CONFIG_ID`;
- dashboard: missing `RESEND_API_KEY`.

The API Worker also carries the dashboard-only `BETTER_AUTH_SECRET` and retired
`AUTOMATION_QUEUE` binding. The protected release rejects out-of-policy secrets
and unexpected non-secret bindings without mutating production during
preflight; do not bypass those gates. Remove the stale secret in a separately
reviewed versioned secret change, with the current 100%-traffic version captured
for rollback. The retired queue binding is removed only by the reviewed Worker
deployment after every other prerequisite passes.

Create real production values in the per-target plaintext files, validate and
encrypt them, commit only the `.vault` files, store the production armor key in
GitHub, and let the protected deploy converge missing intended names. Do not copy
development values. `secrets:cf:sync` only stages an undeployed candidate and is
not required for the normal bootstrap path.

Rotate any credential previously exposed in repository history or local tool
output before relying on it.

### 3. HTTPS is not enforced at the zone

All three live HTTP origins currently fail the same-host 301/308 redirect gate.
The API HTTPS response carries HSTS, but the live dashboard and docs responses do
not; the live docs response also exposes `x-powered-by`. The reviewed local
Workers and deploy checks address those response-header gaps, but they are not
live until the protected deployment succeeds.

The local Cloudflare OAuth grant can read the zone but cannot update zone
settings, so it cannot safely enable this setting. Finish this with a token that
has Zone Settings Edit authority, or explicitly authorize use of a signed-in
browser session for this single setting.

An authorized operator must enable **Always Use HTTPS** for `relayapi.dev`, deploy
the reviewed Workers, and make each command below pass. Do not weaken the
verifier to accommodate the current state.

```bash
bun run edge:verify-production -- api
bun run edge:verify-production -- app
bun run edge:verify-production -- docs
```

### 4. Database transport and migration evidence are incomplete

The current Hyperdrive configuration still uses a legacy public database origin.
The remotely managed `relayapi-db` Cloudflare Tunnel is healthy, but no Cloudflare
VPC service exists, and the private TLS hostname/resolver/certificate identity
plus no-DDL `relayapi_runtime` credential were not available. Production
migrations `0002`–`0007` were not applied by this work.

Before launch:

1. expose PostgreSQL only through the reviewed private/VPC path;
2. bind Hyperdrive to the VPC service with the no-DDL runtime role and keep query
   caching disabled, then replace the null `hyperdriveVpcServiceId` launch
   blocker in `apps/api/production-resources.json` with that exact reviewed ID;
3. take and checksum a production backup, restore it into isolated PostgreSQL 18,
   and pass migration-history, catalog, tenant-integrity, and application smokes;
4. inventory any environment carrying an unsupported superseded migration ledger;
5. run the manual protected deployment so reviewed expand migrations complete
   before the schema-dependent Worker is promoted;
6. retain the workflow evidence and exercise one real
   expand → compatible deploy/backfill → later contract release.

### 5. Operational acceptance has not been demonstrated

The exact media CORS and thumbnail TLS policies are now live and covered by the
production prerequisite verifier. The remaining operational acceptance evidence
has not been produced.

Retain dated evidence for:

- a controlled primary Queue → DLQ → rescue Queue → R2 ledger drill, replay, and
  alarm verification;
- provider sandbox tests and crash-boundary reconciliation for publishing, ads,
  Stripe, Telnyx/WhatsApp phone lifecycle, token refresh/revocation, webhooks, and
  tenant deletion;
- production-like 1/5/20-target publishing with worst-case media, scheduler/outbox
  load, database connection pressure, p50/p95/p99 latency, throughput, and peak
  isolate memory;
- backup restore-time and recovery-point objectives plus an operator-owned
  rollback/forward-recovery rehearsal;
- dependency-exception renewal/removal, credential scanning after rotations, and
  immutable-artifact/SBOM checks in the release environment.

The current dependency audit passes with 65 exact, time-bounded exceptions: 34
runtime and 31 development exceptions covering 47 distinct advisories. Every
exception expires on 2026-08-12. Before launch, assign an owner and a documented
remediation or explicit risk-acceptance decision to each runtime exception; do
not treat a green exception-filtered audit as proof that the underlying risk is
absent. Re-run the audit from the promoted revision and retain its exact report.

## Protected launch sequence

1. Close credential incidents and configure production vaults without committing
   plaintext.
2. Publish the working tree on a branch and merge it through the protected pull
   request path. The five stable security/lint checks and immutable-action
   enforcement are already active; make them pass, retain the post-merge CodeQL
   rescan that disposes of the 15 current default-branch alerts, add independent
   review authority, require at least one approval, disable production
   self-review, and configure deployment secrets and npm publishing authority.
3. Build the private database/VPC path and no-DDL runtime role; verify Hyperdrive
   and Cloudflare prerequisites read-only.
4. Complete the PostgreSQL 18 backup/restore rehearsal and provider/load
   acceptance evidence, and record owners plus remediation or explicit
   risk-acceptance decisions for the 34 runtime dependency exceptions.
5. Enable zone-wide Always Use HTTPS.
6. While production traffic is still stopped, deploy the reviewed dashboard
   auth compatibility build first so organization creation commits its owner in
   one transaction. Capture its sole active 100%-traffic Worker version ID. Do
   not apply migration `0005` against the old dashboard.
7. Run the API workflow manually in the protected environment so migrations
   `0002`–`0007`, catalog verification, and the schema-dependent API deployment
   complete together, passing the captured app ID as the required
   `compatible_app_version_id` input. The workflow verifies that exact active app
   version carries identity-deletion contract marker `0005` before migration.
   Then deploy/re-verify the final dashboard and docs builds.
8. Require all post-deploy checks below to pass, then run the Queue rescue and
   provider canaries. If any check fails, stop traffic promotion and follow the
   workflow's rollback or database forward-recovery path.

## Required post-deploy checks

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run secrets:check
bun run --cwd apps/api openapi:compare-production
: "${API_VERSION_ID:?set API_VERSION_ID to the captured promoted API version}"
EXPECTED_WORKER_VERSION_ID="$API_VERSION_ID" bun run --cwd apps/api cloudflare:verify-production
bun run secrets:cf:verify -- api
bun run secrets:cf:verify -- app
bun run edge:verify-production -- api
bun run edge:verify-production -- app
bun run edge:verify-production -- docs
```

Run the database checks **inside the protected workflow-owned Cloudflare Access
tunnel**, with its production connection string already set. Do not use the root
developer SSH-tunnel wrappers for production evidence:

```bash
bun run --cwd packages/db migration:history:current
bun run --cwd packages/db verify:migrations
```

The app/docs workflows also pass their captured release version IDs to
`scripts/verify-cloudflare-worker-deployment.ts`; retain that output as evidence
that each hostname maps to the reviewed Worker and runtime configuration.

Also run the API isolated suite, app suite, workerd suite, package smokes, and the
documented production smoke endpoints from the exact promoted revision.

## GO criteria

RelayAPI is GO only when every blocker above has named evidence, the protected
workflows are green on the promoted revision, live Cloudflare and edge verifiers
pass without exceptions, production migration hashes/catalog are current, and the
operator records an explicit go/no-go approval. A green local suite alone is not
release approval.
