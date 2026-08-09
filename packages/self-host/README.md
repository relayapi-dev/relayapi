# `@relayapi/self-host`

Provision and update a private RelayAPI installation in your own Cloudflare
account. The CLI keeps RelayAPI's Workers-native architecture; it does not try
to emulate Cloudflare bindings in Docker.

Hosted baseline-cutover controls remain compatible with self-hosted releases:
an absent control key is normal open operation, legacy maintenance records are
still accepted, and `draining` is never inferred from deployment mode. Operators
do not need to create or manage the hosted pre-live cutover record.

```bash
mkdir my-relayapi && cd my-relayapi
bunx @relayapi/self-host init \
  --hyperdrive-ca-certificate-id "<CLOUDFLARE_CA_CERTIFICATE_UUID>"
```

`init` asks for the initial administrator email, generates strong local auth
secrets with mode 0600, and writes a small operator repository containing:

- `relayapi.selfhost.json` — non-secret Cloudflare IDs, domains, feature flags,
  the immutable R2 jurisdiction (`default` or `eu`), and the exact non-secret
  Hyperdrive CA certificate ID
- `relayapi.lock.json` — the exact stable RelayAPI version and SHA-256 of its
  approved GitHub source archive
- a guarded deploy workflow that migrates before deploying
- a daily update workflow that proposes new stable versions as pull requests

`init` is collision-safe. It merges and deduplicates the required entries into
an existing `.gitignore`, and refuses to replace its config, lock, workflows,
`.env.example`, or local secrets when any already exist. An intentional
`init --force` first copies every replaced regular file into a mode-0700
`.relayapi/backups/init-*` directory; symlinks, symlinked managed directories,
and other non-regular targets are always rejected.

Set the values shown in `.env.example`, then run:

```bash
bunx @relayapi/self-host doctor
bunx @relayapi/self-host deploy
```

For a fully automated private GitHub repository, pass `--github owner/repo` to
`init` while authenticated with `gh`. Values already present in the environment
are uploaded with `gh secret set`; their values are never placed on command
lines or in the operator config. Run the `--github` form only in a new empty
directory: it refuses an existing `.git` path or any pre-existing entry, even
with `--force`, before it can alter Git state. Omit `--github` when adding the
collision-safe local scaffold to an existing directory.

The deployment is intentionally forward-only. There is no `destroy` command,
and database migrations are applied under RelayAPI's migration lock before the
Workers are updated.

An ordinary deploy never substitutes a RelayAPI-looking current working
directory for the reviewed lock. It downloads the lock's stable-tag archive
with a bounded timeout and size, verifies its SHA-256 before extraction, and
removes the temporary archive tree on success or failure. `--source` remains a
development override, but it is rejected unless paired with the explicit
`--allow-unsealed-source` acknowledgement and emits a warning that archive
verification is being bypassed. Legacy locks without `sourceArchiveSha256`
must run `upgrade` once to seal their current stable release before `doctor` or
`deploy` proceeds.

Cloudflare preserves existing secrets omitted from `--secrets-file`, so each
Worker rollout is staged as an undeployed version instead of assuming that the
file is replacement state. The CLI uploads the code and complete selected
secret values together, inspects that candidate's secret names, creates
undeployed secret-removal versions for every obsolete name, and verifies that
the final candidate has the exact desired name set and the same hashed script
and non-secret configuration. Only that exact version is then assigned 100% of
traffic; routes, schedules, and Queue consumers are reconciled immediately
afterward with `wrangler triggers deploy`. This removes an old Google or other
optional provider credential when its local value is removed without ever
printing secret values or temporarily activating an unverified candidate. See
Cloudflare's [secret upload semantics](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code)
and [Workers version commands](https://developers.cloudflare.com/workers/wrangler/commands/#versions).

The mode-0600 temporary secrets file and private rollout directory are removed
even when Wrangler fails. If staging, activation, trigger reconciliation, or a
binding smoke fails after migrations, the CLI does not blindly roll the
schema-sensitive release back: the error prints an idempotent forward-repair
command, commands to inspect each possibly activated Worker's deployment
history, and a version-ID-specific rollback command that is permitted only when
that release's compatibility notes authorize it. A failure before 100% traffic
activation explicitly reports that live traffic was unchanged.

`upgrade` accepts only stable `MAJOR.MINOR.PATCH` tags, compares arbitrarily
large numeric components without precision loss, follows GitHub release pages,
and never replaces a newer operator lock with an older available release. A
selected release is written only together with its archive SHA-256. The
generated update workflow delegates selection to this same implementation
instead of maintaining a separate shell comparator.

The migration role is supplied as `RELAYAPI_MIGRATION_DATABASE_URL`; the
separate no-DDL Worker role remains `RELAYAPI_RUNTIME_DATABASE_URL`.
Both URLs must target the same PostgreSQL 18 host, port, and database, use
different roles, and use `sslmode=verify-full` off loopback. Before any
Cloudflare resource is applied, `deploy` proves the exact database identity,
migration-role authority, runtime-role no-DDL boundary, and the vector(1536),
HNSW cosine, trigram GIN/similarity, and `btree_gist` text/range exclusion
operations inside a transaction that always rolls back. `doctor` runs the same
source-owned contract. Its Cloudflare
inspection uses the configured immutable R2 jurisdiction rather than silently
falling back to the default jurisdiction.

Before `init`, upload the PostgreSQL server's CA certificate bundle to
Cloudflare and retain its certificate UUID. Cloudflare requires that ID when
Hyperdrive uses `verify-ca` or `verify-full`; see Cloudflare's
[TLS certificates for Hyperdrive](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/).
The certificate ID is public configuration, not private key material.

```bash
npx wrangler cert upload certificate-authority \
  --ca-cert server-ca-chain.pem \
  --name RELAYAPI_DATABASE_CA
```

Hyperdrive is reconciled against the exact ID pinned in
`relayapi.selfhost.json`, not adopted again by mutable name. `plan`, `doctor`,
and dry-run deployment require `RELAYAPI_RUNTIME_DATABASE_URL` so they can fail
on a missing pinned configuration, a canonical-name collision, a host/port/
database/runtime-role change, or a TLS downgrade. Readable drift such as the
managed name, cache-disabled setting, or a TLS upgrade is repairable. Existing
client-certificate IDs are preserved. The CA certificate ID must exactly match
the configured trust anchor and is always supplied on create and reconciliation;
a conflicting change without an explicit rotation flag, or an existing
Hyperdrive without a CA pin, is rejected. The existing origin connection limit
is also preserved.
Legacy operator configs without the new field remain readable. On their next
real `configure` or `deploy`, the CLI adopts the CA ID already attached to the
exact pinned Hyperdrive and writes it to the operator config after successful
resource reconciliation. A legacy config cannot rotate directly to a different
explicit CA: first run without the rotation flag to persist the attached CA,
then request the new UUID. If the requested UUID is already attached, it is
safely adopted in one pass. A clean create still requires the explicit init flag;
`plan`, `doctor`, and dry runs never mutate the config. Because Cloudflare never
returns the database password, `doctor` explicitly cannot attest it and every
real deploy reapplies the complete origin credential with PATCH, then verifies
the fresh Cloudflare state before migrations or Worker deployment.

To rotate the server CA, upload the new regional CA bundle first, then preview
and apply the exact UUID explicitly. Do not edit `relayapi.selfhost.json` first:

```bash
bunx @relayapi/self-host plan \
  --hyperdrive-ca-certificate-id "<NEW_CLOUDFLARE_CA_CERTIFICATE_UUID>"
bunx @relayapi/self-host doctor \
  --hyperdrive-ca-certificate-id "<NEW_CLOUDFLARE_CA_CERTIFICATE_UUID>"
bunx @relayapi/self-host deploy \
  --hyperdrive-ca-certificate-id "<NEW_CLOUDFLARE_CA_CERTIFICATE_UUID>"
```

Only the exact `resources.hyperdriveId` may rotate; a resource found only by
name cannot. The plan reports `rotate`, `retain`, or legacy `adopt` intent. The
CLI PATCHes the CA while retaining the client certificate and origin connection
limit, verifies readable convergence, and writes the new UUID to the operator
config only after all Cloudflare reconciliation succeeds. A failed PATCH or dry
run leaves the file unchanged. If Cloudflare already reached the requested UUID
but local persistence was interrupted, rerunning the same command safely
records it as `retain`; if Cloudflare instead reports a third CA UUID, the CLI
stops rather than overwriting unexplained state.

Cloudflare documents that connection-parameter updates perform a fresh database
connection and an empty PostgreSQL test query before acceptance. `deploy` then
probes the API and dashboard through their real bindings, so the workflow does
not issue an undocumented pool restart. See Cloudflare's
[PATCH API](https://developers.cloudflare.com/api/resources/hyperdrive/subresources/configs/methods/edit/)
and [configuration troubleshooting](https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/).

After the API Worker code and secrets are atomically deployed, `deploy` calls the
protected cutover smoke with `?probe=database` and verifies
`current_database()` plus `current_user` through that Worker's actual
`HYPERDRIVE` binding. It also requires `ok: true`, an open runtime-control
state, and application/configured baseline generations matching the release.
The dashboard deploy and its equivalent probe happen only after the API probe
succeeds; the CLI does not print the final live message if either probe fails.
The smoke token is deterministically derived from the required high-entropy
`BETTER_AUTH_SECRET`; only its one-way digest is written to each generated
Wrangler config, so there is no additional operator secret. Hosted deployments
retain their independently managed cutover credential and normal smoke behavior.

For a same-role password rotation, change the database password and immediately
run `deploy` with the matching runtime URL. Cloudflare validates the connection
parameters before accepting the PATCH, and the binding smoke then proves
reachability and identity through the deployed Worker. A zero-downtime host,
database, or role migration requires a separate Hyperdrive configuration and
gradual Worker deployment; the v1 CLI deliberately rejects that change and does
not attempt a blind rollback.

Before migration, `doctor`—and `deploy` again immediately before invoking the
migration command—checks the append-only historical extension probe registry,
not only the extensions active in the target release. Every extension needed by
a clean replay must exist in `pg_available_extensions`, and every explicit
CREATE or UPDATE target must exist in `pg_available_extension_versions`. For an
unpinned CREATE, the provider's current default is the clean-replay starting
version. `doctor` checks `pg_extension_update_paths` for every ordered
clean-replay update target; a `NULL` path is an incompatible provider package,
including an unsupported downgrade. A missing extension is then actually
replayed through each create/update/drop epoch, in the schema used by that
epoch, inside a transaction that always rolls back. An installed known
extension may still be in an intermediate schema or version, but the migration
role must be able to manage it. The generic probe deliberately does not infer
which migrations have completed from that version.

The migration runner owns that decision. While holding the same one-session
advisory lock used for the Drizzle ledger mutation, it binds every lifecycle
event to the tracked migration SQL and verified ledger prefix, checks the real
installed state owned by that prefix, and simulates only pending CREATE,
UPDATE, SET SCHEMA, and DROP events. A future UPDATE target is never treated as
complete merely because `extversion` already equals it. Pending updates must
have an available exact target and a non-`NULL` path from the real current
version. Pending `SET SCHEMA` also requires the simulated installed version to
be marked relocatable by PostgreSQL. A provider-preinstalled extension may
satisfy `CREATE EXTENSION IF NOT EXISTS`, but it must be manageable and already
satisfy that CREATE's namespace contract; a pinned CREATE also requires the
exact pinned version. The simulated result must equal the active subset,
schemas, and pinned versions.

After the migration command succeeds, `deploy` performs a separate exact-state
check before bootstrap, dashboard build, or either Worker deployment. Among all
historically managed extensions, exactly the current active subset must remain,
in the required schemas and at any explicitly pinned versions. This separation
allows a migration to move or retire an extension without making its own
preflight impossible.

The binding is generation-aware, and every supported sealed generation now
selects the complete publish-safe lifecycle registry established by the
pre-live reset baseline.

AI remains an explicit feature flag. Enabling it also requires an
`OPENAI_API_KEY` for the fixed `text-embedding-3-small`/1536 embedding contract;
inference uses the provisioned Workers AI binding and the pinned supported
model rather than silently falling back to a different provider.

The pre-live authority baseline stores API and dashboard credentials behind
stable organization principals, normalizes selected workspace grants, and
redeems bearer invitations transactionally. Email signup with a bearer invite
now locks and revalidates the issuer generation, live role/principal, active
tenant, and every selected workspace inside Better Auth's user/account
transaction before claiming the token. A later signup failure rolls the claim
back, and a concurrent ban, role removal, tenant suspension, or workspace
deactivation either commits first and rejects signup or waits behind the
admitted transaction. Self-hosted updates require no new operator setting: the
version-pinned release migration installs this shape before either Worker is
deployed.

Dashboard-initiated OAuth and direct provider-account credential writes also
carry the exact current Better Auth session through the one-time flow and lock
it again in the credential-write transaction. Service-principal API keys carry
an explicit null session instead. Delayed Telegram bot challenges persist the
same nullable authority session and revalidate it before account creation, so a
logout or revocation invalidates an outstanding dashboard challenge. This
containment behavior is shared by hosted and self-hosted Workers and requires no
additional binding or secret.

Customer-owned object storage requires no new operator-level setting. The
baseline replaces the mutable BYOS singleton with immutable storage locations
and encrypted credential versions; every BYOS media row pins both. Rotating a
credential or changing an endpoint therefore stages and probes a new authority
before atomic activation, while existing objects continue to use their
historical location and credential until they are deleted.

Consent opt-outs use the current `contact_consent_states` denial as the
authoritative send veto; there is no separate suppression ledger. The
`ENCRYPTION_KEY` ring therefore includes an immutable
`identity=<64-hex-characters>` entry after the active key. During rotation, add
the new active key first and retain `identity` unchanged while the daily
rotation rewrites the versioned lookup HMACs. Never remove, replace, or move
`identity` to the first position: `doctor` rejects the invalid shapes and the
API fails closed if stored authority was created under another identity key.
Every entry must contain distinct key material. `deploy` applies the same ring
validation before its first PostgreSQL probe or Cloudflare API call, so direct
and automated deployments cannot bypass `doctor`.

Billing checkout, portal, status, and reconciliation are owned by the API
Worker. In self-hosted community mode the status endpoint reports the community
entitlement and Stripe mutations remain disabled, so operators do not configure
Stripe secrets or a Stripe price in either Worker.

The shared reset baseline also installs the durable provider-first ad mutation authority and its reconciler. Every provider write re-locks the exact active social/ad-account pair and resolves its current credential at the durable request boundary; multi-write Meta operations repeat that boundary between calls. Self-hosted community mode bypasses only the hosted Stripe entitlement check, never actor or provider-account revocation. Meta boolean mutation responses fail closed unless the provider explicitly returns `success: true`. Self-hosted phone-number operations continue to bypass Stripe; the hosted-only phone add-on price and quantity authority is inert in community mode.

Paid ad creation uses the same provider-effect evidence rules in hosted and
self-hosted deployments: campaign and ad-set IDs inherited from an existing
campaign are context, not a billable provider effect. Explicit targeting is
forwarded to Meta, and per-ad campaign/ad-set overrides are rejected when a
shared existing campaign is selected rather than being stored without effect.
Unsupported Meta targeting fields are rejected before a durable provider
boundary. Unsupported platform/currency, invalid budget, currency mismatch, and
stale boost-source preflights settle the current request at exact K=0. A
different-key active-mutation conflict also settles only its fresh reservation;
a same-key retry retains the existing operation's usage authority. Live
`manage_spend`/`manage_billing` gates run before idempotency replay, so changing
a dashboard member's financial role immediately blocks replay of an earlier
paid-operation response in every deployment mode.

Usage authority is deployment-mode neutral. The release migration installs the
same `billing_periods`/`usage_buckets` invariants and `btree_gist` overlap guard
for every operator, while community mutations use the explicit
`quota_mode='unlimited'` plus `included_units=NULL` shape. No integer sentinel,
Stripe period, or billable operation is manufactured for self-hosted traffic.
When a hosted API-key cache carries an older billing period, the usage path
rolls back the stale bucket transaction before resolving the current
`successful_mutation` period and bucket, retries that fully locked validation
once, and delete-invalidates the affected API-key caches. Administrative plan
changes likewise finish their database mutations before deleting organization
and API-key cache projections. These repairs are part of the shared Worker
binary and require no self-host setting; a matching community unlimited bucket
does not enter the billing-authority repair path.

The shared schema also retains settlement-aware usage carryover edges when a
billing authority is split with an unresolved reservation. Each successor
temporarily holds the original N units and permanently debits only the eventual
committed K; a released carryover source cannot be reused under the same
idempotency key. Community unlimited traffic normally has no paid transition,
but installs the same invariant so hosted-compatible administrative changes and
future stable updates cannot burn or duplicate usage across a boundary.

Request-side broadcast mutations and webhook definition/secret changes use the
same PostgreSQL-complete usage evidence in hosted and community deployments.
Broadcast provider delivery remains cron-owned, while webhook test delivery
remains an external boundary; only its missing, scope-denied, and blocked-URL
preflights settle as exact zero effect.

Provider-backed request routes use the same explicit mutation boundary in both
deployment modes: an acknowledged single-unit mutation commits K=1, a terminal
provider 4xx releases K=0, and transport, timeout, rate-limit, or 5xx ambiguity
stays parked. Multi-account fan-out commits if any candidate succeeds and parks
when no candidate succeeds but any acknowledgement is ambiguous.

Durable ad creation/mutation and WhatsApp phone provisioning/release operations
also carry an optional, same-organization usage-reservation provenance link.
Phone release staging fences the exact provisioning/release state, phase, lease
token, lease expiry, and provider-boundary timestamp before changing the parent
phone, so a concurrent community-mode provider worker cannot be overwritten or
silently lose a cleanup obligation. Tenant/workspace erasure supersedes every
nonterminal user release under null system authority, settles only proven
pre-provider usage at K=0, and preserves ambiguous/manual provider evidence;
workspace erasure snapshots those phone credentials before source-account
revocation shreds them. Purchase policy/availability rejection and
release lookup/state/CAS rejection are explicitly settled as zero-effect only
before a durable phone operation takes ownership; provider-boundary and adopted
operation outcomes remain parked for reconciliation. Verification endpoints
likewise release deterministic pre-provider and explicit Meta client rejections,
park transport/5xx ambiguity, and retain K=1 once code verification succeeds
even when the subsequent registration or local projection fails.
Each reservation can be owned by at most one operation of each kind, and the
restricting foreign key prevents retention or tenant erasure from silently
orphaning an operation whose provider outcome is still being reconciled.
At the 25-month usage-detail horizon, the bounded retention transaction detaches
all four links only for committed or released reservations immediately before
deleting them. Reserved or parked outcomes remain linked and inspectable.
Community unlimited mode installs the same linkage for migration compatibility;
it does not enable Stripe billing or manufacture a billable reservation.

Posting queue schedules are PostgreSQL-authoritative in the pre-live baseline.
The provisioned KV namespace keeps only a five-minute read cache, so KV loss,
expiry, or replacement cannot remove an operator's schedules and no extra
self-host setting is required.

The same baseline uses one typed row per webhook HTTP attempt, enforces
select-field options and automation trigger configuration in PostgreSQL,
projects automation-job and idea-tag tenancy from their authoritative parents,
and keeps explicit webhook test attempts. These are schema/runtime contracts,
not self-host configuration knobs; the version-pinned migration installs them
before either Worker deploys.

Background provider reads use the same database-owned due-time, fenced-lease,
bounded-attempt, and tenant-fair claim policy in hosted and self-hosted
deployments. External-post discovery, internal/external analytics, ad-account
and ad-metrics sync, short-link clicks, and automation-binding mutations do not
stack queue redelivery on top of application rescheduling. Exhausted automatic
work remains inspectable instead of retrying without limit. Queue rescue has a
40-attempt application fence, a worst-case nominal backoff under ten hours, and
staged operator alerts; set the optional
`OPERATIONS_ALERT_WEBHOOK_URL` secret to forward sanitized operational alerts,
or rely on structured Worker logs. Daily retention and ephemeral-auth cleanup
also run in both deployment modes. Built-in short-link KV projections expire
after 24 hours and are best-effort invalidated during bounded tenant/workspace
erasure; PostgreSQL remains redirect authority. Cross-post actions keep their
product `scheduled_for` separate from operational `next_attempt_at`, so a
provider/readiness retry cannot rewrite the user-visible schedule.

External short-link providers require no additional self-host binding. Their
API keys use immutable encrypted credential versions under `ENCRYPTION_KEY`;
each link starts as a durable local intent and pins the exact provider version.
Credential replacement is read-only-probed before activation, and
tenant/workspace erasure copies only the pinned ciphertext plus provider object
identity into the existing fenced cleanup lifecycle. Completed cleanup shreds
that copy, while provider outcomes that cannot truthfully claim deletion remain
available for operator review.

User-ban containment is also migration-first and needs no additional self-host
binding or secret. The release migration rotates the banned user's credential
generation in PostgreSQL, and dashboard/member API keys are accepted only while
their pinned generation still matches the live user. Independently issued
service-principal API keys deliberately remain organization credentials and are
not revoked merely because the user who originally created them is later banned.
The same migration pins both bearer invite tokens and Better Auth organization
invitations to the issuer generation, cancels pending invitations on a ban or
membership-authority change, and requires invitation acceptance plus membership
creation to commit atomically. The accepting user's live credential generation
and exact session or member API key are fenced in that grant transaction, while
the member-insert invariant rejects an actively banned target even for a missed
application path. Better Auth invitation creation and member-role updates also
lock and revalidate the actor's authoritative session, credential generation,
live organization role, and active tenant in the same transaction as the grant;
a concurrent ban, session deletion, or role demotion cannot mint an invitation
or restore authority from a stale request. Dashboard internal `/api/*` routes
also read the authoritative session instead of the five-minute signed-cookie
cache. Upgrade deployments therefore continue to apply database migrations
before either Worker without adding a binding or secret.

Content templates are organization-shared definitions in both deployment
modes. New create/update requests reject `workspace_id` instead of silently
ignoring it, and creating, updating, or deleting a template requires an
all-workspace credential. Legacy workspace-scoped rows remain readable during
upgrade compatibility, but applying one to a post rechecks the calling key's
workspace grant before any template content is rendered.
This contract adds no binding, secret, or migration.

Durable automation activation/graph, manual enrollment admission, entrypoint,
binding, active RSS-rule, short-link configuration, and BYOS staging/activation
mutations also fence the exact issuing key, principal, workspace grants, and dashboard session in the
same PostgreSQL transaction as the final state change. Organization-global
short-link and BYOS changes require all-workspace authority. Provider probes
remain outside database transactions, then the exact issuer and probe claim are
both revalidated for final activation. This behavior is deployment-mode neutral
and adds no self-host binding or secret.

Every provisioned Queue, including DLQs and the rescue Queue, is converged to a
24-hour message-retention horizon and the returned Cloudflare state is verified.
That equals the fixed Free-plan horizon and deliberately shortens the mutable
Paid-plan default, so changing plans cannot silently extend transient payload
residency. PostgreSQL and the encrypted rescue bucket remain the durable
authorities for inspectable failures.

Cloudflare discovery exhausts the documented page-number pagination for KV,
Queues, and Hyperdrive and the cursor pagination for R2 before deciding whether
a canonical resource exists. Cloudflare and GitHub JSON responses, release
archives, and every network wait are size- and time-bounded so a stalled or
unbounded upstream response cannot hold an operator deployment indefinitely.

Every provisioned R2 bucket also receives a one-day, all-prefix lifecycle for
incomplete multipart uploads. RelayAPI currently creates media with single PUT
operations, so this does not shorten any user-facing upload capability; it
prevents abandoned multipart parts created by future or operator tooling from
remaining billable for Cloudflare's longer default window. Media originals and
the encrypted queue-rescue ledger retain their separate 30-day object-expiry
rules, while avatar, thumbnail, and public-asset objects remain durable.

Automation message blocks persist durable `med_*` library IDs instead of
expiring signed URLs. Immediately before provider delivery, the API resolves
each ID through PostgreSQL, requires the current organization/workspace scope
and a ready, non-deleting original, then uses the configured media storage to
issue a fresh read URL. The direct-upload response includes that durable ID.
Self-hosted installs use their existing Hyperdrive, media bucket or BYOS
location, and storage credentials; this adds no binding, secret, resource, or
database migration. A one-shot BYOS upload stream is signed with transport
retries disabled; the durable upload row and reconciler recover ambiguous
provider outcomes without replaying a consumed request body.

Download and transcript execution uses the provisioned tools Queue, which
carries only `tool_job` identifiers. PostgreSQL owns the encrypted
request/result lifecycle, three-attempt fence, 15-minute processing deadline,
stale-lease recovery, and one-hour terminal-result TTL. The tools consumer uses
a one-second batch timeout so the HTTP request can briefly poll that durable
state for a fast result; provider egress remains Queue-only because an HTTP
`waitUntil()` tail is shorter than the provider deadline and is not a durable
execution boundary. The standard
`ENCRYPTION_KEY`, Hyperdrive, migration, Queue, and every-minute schedule are
the complete self-host contract; KV is no longer job authority and no new
operator setting is required.

Automation conversion facts use their own PostgreSQL outbox columns rather
than a second queue or receipt table. The every-minute API schedule reclaims
fenced dispatch leases, evaluates conversion entrypoints idempotently, and
defers any child run to the existing automation scheduler. Seven-day or
twelve-attempt exhaustion enters the same administrator resolution surface
with a safe retry-only action. This is deployment-mode neutral and requires no
additional self-host binding or secret.

Tag and custom-field automation actions use that same PostgreSQL scheduler for
durable internal events. The contact mutation and run-owned event are committed
together, and the every-minute scheduler performs occurrence-idempotent child
enrollment with a bounded event depth. Self-hosted installs inherit this from
the baseline, Hyperdrive, `ENCRYPTION_KEY`, and existing cron; there is no
additional Queue, KV namespace, bucket, secret, or operator setting.

The authenticated system-administrator API also exposes one sanitized
operator-resolution ledger for unknown automation effects, Meta binding
outcomes, Stripe receipts and billing operations, aged erasure jobs, and
provider revocation. Customer webhook work that exhausts its 24-hour
known-not-sent repair window enters an explicit manual-review target, emits the
same sanitized optional operator alert, and gives an operator 90 days to apply
an audited row-fenced retry or abandon decision. HTTP-ambiguous delivery
outcomes enter a separately typed review that permits received/not-received
resolution or one explicit reconciled retry, never automatic replay. At most
one operator retry can extend either lifecycle into one final bounded review;
unattended reviews terminalize as failed (known not sent) or unresolved
(ambiguous) when not held, then drain through the ordinary seven-day history
clock. Exhausted WhatsApp phone provisioning and release
operations appear as distinct targets: provisioning can restart only its
read-before-retry reconciliation, while ambiguous Meta deregistration requires
an explicit succeeded/not-applied decision. Resolution actions are
state-specific and row-fenced; customer-webhook operator intervention also
leaves a row-local fence that generic Queue replay cannot clear or bypass.
Unknown external mutations are never retried without an explicit operator
decision. Unsupported financial Stripe receipts remain parked until a safe
retry becomes available or an operator records an audited abandonment with a
provider-reconciliation reference; abandonment immediately redacts the raw
payload and retains only a SHA-256 reference digest in append-only evidence.
Unknown, manual-review, and terminal-failed billing operations likewise remain
operational until an explicit resolution or write-off instead of aging out at
the ordinary 90-day resolved-detail horizon. The release migration installs the
append-only database trigger and requires no additional self-host
configuration.

Consent projection order is a mergeable
`(ordering_hlc, ordering_region, event_id)` tuple rather than a
database-local sequence. The launch baseline allocates the `home` region under
the existing per-organization transaction lock; future regional writers can
advance from the greatest observed HLC without changing consent semantics.
Derived KV caches also use one canonical prefix per registered privacy family
(including `short-link:`, `analytics-overview:`, `analytics-posts:`,
`ad-discovery:`, and `usage-warning:`). PostgreSQL remains authoritative, so an
upgrade may discard older cache prefixes without migrating them.

Financial retention is also deployment-mode neutral. The release migration
installs one detached, immutable `financial_retention_receipts` relation; the
daily API schedule drains resolved checkout/billing/Stripe operational detail
after 90 days, usage detail after 25 months, invoices after seven years, and the thin
global SHA-256 Stripe event receipt after one year. Tenant erasure snapshots
minimized financial evidence before deleting current billing rows, and removes
raw Stripe rows attributable from the locked current billing state in that same
bounded step. Provider IDs, hosted checkout/invoice URLs, payloads, and
free-form errors are not copied into retained receipts, and active holds pause
only minimized financial rows, never those operational redaction clocks.
Community mode needs no Stripe secret or additional retention setting for this
contract.

The remaining domain retention clocks are deployment-mode neutral too. The
daily API schedule minimizes superseded consent detail after two years,
terminal broadcast-recipient PII after 30 days, sync/AI failure prose after 90
days, and phone-operation detail on its seven-day/one-year clocks; resolved
broadcasts and release evidence drain after one year, and provider-originated
post mirrors after 25 months. External-post deletion persists an exact
thumbnail cleanup job before removing its database locator, using the existing
thumbnail bucket and cleanup worker. The source-owned registry distinguishes
`pause` stores, whose destructive minimization and deletion both stop under a
matching hold, from `minimize` stores, whose raw PII or bearer-like detail still
shreds while the minimal evidence row is preserved. No self-host-only setting
or additional binding is required. The set of PostgreSQL stores requiring a
scheduled drain is derived from this source-owned privacy policy and compared
exactly with executable handler, cadence, batch, index, and test contracts, so
a later timed store cannot silently ship as documentation only.
