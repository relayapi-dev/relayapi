Keep `CLAUDE.md` and `AGENTS.md` in sync. Any change to one file must be applied to the other file at the same time.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RelayAPI is a unified social media API for posting to 21 platforms via a single API. TypeScript monorepo deployed on Cloudflare Workers.

## Commands

```bash
# Install dependencies
bun install

# Development
bun run dev:api       # API server on localhost:8789
bun run dev:app       # Astro dashboard
bun run dev:docs      # Next.js docs site

# Type checking
bun run typecheck     # All packages and apps

# Tests
cd apps/api && bun run test   # API suite — runs each file in its own process
cd apps/app && bun test       # Dashboard suite

# Linting (Biome)
bun run lint          # Biome lint across the repo (generated packages/sdk excluded)
bun run lint:fix      # Apply Biome safe lint fixes


# Database
bun run db:generate   # Generate Drizzle migrations
bun run db:migrate    # Run migrations

# OpenAPI
bun run --filter api export-openapi   # Export OpenAPI spec (requires dev server running)
```

## Architecture

### Monorepo Layout

- **apps/api** — Hono REST API on Cloudflare Workers. Routes under `src/routes/`, Zod-OpenAPI schemas under `src/schemas/`, auth middleware in `src/middleware/auth.ts`.
- **apps/app** — Astro dashboard (SSR via Cloudflare adapter). Stub state.
- **apps/docs** — Next.js documentation site using Fumadocs.
- **packages/self-host** — Published bootstrap/deployment CLI for one-command installs in an operator-owned Cloudflare account. It provisions bindings, emits per-instance Wrangler configs, applies migration-first deployments, and manages stable release locks/update PRs. Keep it separate from the API-client CLI in `apps/cli`.
- **packages/db** — Drizzle ORM schema and client. Exports `createDb(connectionString)` and all schema tables. PostgreSQL via `postgres` driver.
- **packages/auth** — Better Auth setup with Google OAuth and API key plugin. Uses `@relayapi/db` for storage.

### API-First Principle

- **The API is the main product**: `apps/api` must work autonomously without `apps/app`. Treat the dashboard as a client of the API, not as the system that defines API architecture.
- **Do not couple the API to the dashboard**: Avoid app-specific assumptions, auth flows, response shapes, or infrastructure requirements leaking into `apps/api` unless the user explicitly asks for that tradeoff.
- **Fix dashboard overhead in the dashboard first**: When the problem is dashboard performance or UX, prefer reducing `apps/app` middleware, bootstrap, proxy, and hydration cost before proposing changes that make the API depend on the app.

### Remote App Development and Command-Scoped Database Tunnel

The database runs on a remote server, but routine dashboard development does **not** connect to it. `bun run dev:app` runs the local Astro frontend against the deployed dashboard/auth backend and `https://api.relayapi.dev`; local `/api/*` requests are delegated to the deployed app, which continues to use the SDK and enforce its normal session, membership, and dashboard-credential checks. Deploy the dashboard once with `/api/dashboard-context` before using this mode; session resolution fails closed until that endpoint exists upstream. VS Code's **Debug App** uses `https://dev.relayapi.dev` through `apps/app/Caddyfile.local` so secure auth cookies work; complete the one-time hosts/Caddy setup documented in the README.

Commands that genuinely need PostgreSQL own the tunnel for their lifetime. `bun run dev:api`, `bun run db:migrate`, `bun run db:studio`, `bun run db:verify`, and the live migration-history commands open `127.0.0.1:5433`, run the child command, and close the tunnel on success, failure, or interruption. For another database command, use `bun run db:with-tunnel -- <command>`. Do not restore a persistent/background database tunnel task.

The ignored `apps/api/.dev.vars` supplies `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`, which must point to the loopback tunnel port, and the required `RELAYAPI_DB_SSH_TARGET`. Use an SSH config alias for the target so the real database host remains in `~/.ssh/config` outside the repository. The wrapper has no built-in host and refuses missing targets, non-loopback/mismatched database URLs, and an already-occupied local port.

### Secrets (Dotenvx + Armor)

Plaintext development files stay ignored and are mirrored by committed Dotenvx ciphertext vaults: `apps/api/.dev.vars.vault`, `apps/app/.dev.vars.vault`, and `packages/db/.env.vault`. The three development vaults share one development key. Production uses a separate key and target-separated `apps/{api,app}/.production.secrets.vault` files so values cannot cross Worker targets. Never commit `.env.keys`, a plaintext `.production.secrets`, or a private key; `meta-credentials/.env` is deliberately outside this workflow.

- On a maintainer machine, run `bunx dotenvx armor login`, `bun run secrets:native -- development`, then `bun run secrets:decrypt`. Armor supplies the portable key and the OS-native store (macOS Keychain, Linux Secret Service, or Windows Credential Manager) is the local fallback.
- After changing a plaintext development file, run `bun run secrets:encrypt -- development`. Use `bun run secrets:check` for decrypted sync status and `bun run secrets:validate` for keyless ciphertext-only validation.
- A fork owner runs `bun run secrets:init`, replaces required placeholders, encrypts, and armors keys in their own Armor account. They never receive RelayAPI's private keys or production values.
- Production is scaffolded, not populated from placeholders. Import real values into the ignored per-Worker files, run `bun run secrets:encrypt -- production`, then `bun run secrets:armor -- production` and `bun run secrets:native -- production`. A committed target vault plus protected `DOTENVX_ARMOR_TOKEN` is mandatory for API/app releases. Preflight allows missing vault-intended names so a protected deploy can bootstrap them, rejects stale/out-of-intent/wrong-type names, and post-deploy verification requires an exact vault-name match.
- `bun run secrets:cf:sync -- api|app` only creates an undeployed secret-version candidate. It is not the normal bootstrap/rotation release path; capture the current version, inspect the returned candidate, and explicitly promote it with rollback available if this advanced path is used. Cloudflare credentials and database-migration secrets remain GitHub environment secrets.
- If plaintext reaches Git or a private key is exposed, revoke/rotate the affected upstream credentials and rekey the vaults. Removing the commit alone is not remediation.

### Cloudflare Bindings (apps/api)

The API uses these Cloudflare bindings defined in `wrangler.jsonc`:
- **KV** — API key cache (24h TTL)
- **MEDIA_BUCKET** (R2) — Media file storage (full-res originals; ~30-day lifecycle rule)
- **THUMBNAIL_BUCKET** (R2) — Durable, never-expiring hyper-optimized post preview thumbnails (served publicly via `thumbs.relayapi.dev`)
- **IMAGES** — Cloudflare Images binding; generates tiny AVIF thumbnails from R2 bytes
- **MEDIA** — Media Transformations binding; extracts video poster frames
- **HYPERDRIVE** — PostgreSQL connection pooling
- **PUBLISH_QUEUE** — Async job queue

**Media previews**: card/list/calendar views render `media[].thumbnail` (durable) and fall back to the presigned original. Thumbnails are generated off-request in the `relayapi-media-cleanup` R2-event consumer on object-creation events (`apps/api/src/queues/media-cleanup.ts` + `apps/api/src/lib/thumbnails.ts`), which also preserves the media row + thumbnail when the original is lifecycle-deleted. A self-terminating `*/30` cron backfill (`apps/api/src/services/thumbnail-backfill.ts`) generates thumbnails for pre-existing media whose original is still in R2.

### Key Patterns

- **Multi-tenancy**: Every resource is organization-owned; operational resources may additionally carry a nullable `workspace_id`. `Require Workspace ID` controls only independent operational-root creation: when disabled, an omitted `workspace_id` creates an organization-scoped row; when enabled, independent roots require an explicit active, tenant-owned, authorized workspace. Parent-bound creates may inherit their authoritative parent's workspace in either mode. Organization-scoped rows are visible to credentials with at least one workspace grant, while zero-grant credentials see none. On list endpoints, an omitted workspace filter means all rows authorized by the credential, not an authorization bypass. Explicit workspace IDs are always grant-checked. Shared definitions remain organization-global.
- **API keys**: Bearer tokens prefixed `rlay_live_*` (production) or `rlay_test_*` (test). SHA-256 hashed before DB lookup. Cached in KV.
- **Resource IDs**: Nanoid with prefixes — `ws_`, `acc_`, `post_`, `med_`, `wh_`.
- **Pagination**: Cursor-based with `next_cursor` and `has_more`. Limit 1–100, default 20.
- **Error responses**: `{ error: { code, message, details? } }`.
- **Database schema**: Auth tables in `auth` schema (managed by Better Auth), business tables in `public` schema. Sensitive fields use AES-256-GCM encryption.
- **OpenAPI**: Routes defined with `@hono/zod-openapi`. Swagger UI served at `/docs`.

### CI/CD

GitHub Actions deploy each app independently on push to `main` when relevant paths change (`deploy-api.yml`, `deploy-app.yml`); a test job (typecheck + suite) gates every deploy, and `ci-api.yml`/`ci-app.yml` run the same checks on PRs. `ci-lint.yml` runs Biome lint repo-wide on every PR (fails on lint errors). All use Wrangler with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. The `sync-openapi` workflow auto-commits updated OpenAPI specs.

Biome config (`biome.json`): recommended ruleset; respects `.gitignore`; the generated `packages/sdk` (Stainless) is excluded from linting; Tailwind v4 CSS directives are enabled for the CSS parser.

**API tests must be run via `bun run test` in `apps/api`** (the `run-tests-isolated.ts` runner): plain `bun test src/__tests__` executes all files in one process, where `mock.module("@relayapi/db", …)` calls from the billing suites poison the automation suites with false failures. DB-fixture suites skip themselves when the SSH tunnel is down, so the suite passes without a database. To include those fixtures, run `bun run db:with-tunnel -- bun run --cwd apps/api test` from the repository root.

### SDK Releases

The SDK (`packages/sdk`) uses **release-please** for automated versioning and npm publishing. Commits must use **Conventional Commits** prefixes to trigger a release:
- `fix(sdk):` → patch bump (0.0.x)
- `feat(sdk):` → minor bump (0.x.0)
- `feat(sdk)!:` or `BREAKING CHANGE` → major bump (x.0.0)

Other prefixes (`chore:`, `docs:`, `refactor:`, etc.) are included in the next release but won't trigger one on their own. The flow is: push to main → release-please opens a PR → merge the PR → npm publish runs automatically.

### Self-Hosted Releases

`@relayapi/self-host` is released independently from `packages/self-host` with release-please and stable `self-host-vX.Y.Z` tags. Those tags pin the complete monorepo source deployed by operator repositories; self-host deployments must never fetch or deploy `main`. Keep `src/constants.ts`, `package.json`, and the self-host release manifest version synchronized through release-please. Generated operator update PRs change only `relayapi.lock.json`, and merging one runs database migrations before either Worker deploy.

Any API, app, auth, or database change intended for self-hosted operators must also include a compatibility note, test, or implementation change under `packages/self-host`; the self-host release is path-scoped, so this is what causes release-please to cut a new stable deployment tag.

Self-hosted community mode is enabled only by `DEPLOYMENT_MODE=self_hosted`. It grants community entitlements without Stripe while optional email, Workers AI, and downloader integrations remain explicit feature flags. Never infer self-host mode from missing Stripe secrets. The operator config is non-secret; database URLs, Cloudflare credentials, encryption/auth secrets, R2 S3 credentials, OAuth credentials, and optional integration keys stay in environment, Cloudflare Worker secrets, or GitHub Actions secrets. The v1 resource names are intentionally fixed to one managed instance per Cloudflare account, provisioning is idempotent/non-destructive, and there is no automated destroy or down-migration path.

## Dev Credentials

- **Dashboard login**: provide `NODE_ENV=development`, `SEED_USER_EMAIL`, `SEED_USER_PASSWORD`, and `RELAYAPI_ALLOW_LOCAL_SEED=I_UNDERSTAND_THIS_MODIFIES_MY_LOCAL_DATABASE`, then run `bun run db:with-tunnel -- bun run scripts/seed.ts`; the wrapper owns the tunnel and the idempotent seed rejects production/non-loopback URLs and creates no active paid entitlement
- **Dashboard URL**: `https://dev.relayapi.dev/app` (VS Code **Debug App**; one-time hosts/Caddy setup required). Port 4321 is the HTTP upstream, but authenticated remote-backend debugging should use the HTTPS hostname so secure cookies work.
- **API URL**: `http://localhost:8789` (`bun run dev:api` owns its database tunnel)

## Dashboard App Rules (`apps/app`)

- **Navigation architecture is intentional**: Do **not** replace dashboard page navigations with a persistent client router, SPA router, or a single `/app` shell that swaps route content without full document navigation, unless the user explicitly asks for that architectural change.
- **Always use the SDK for app-to-API calls**: In `apps/app`, any call to `apps/api` must go through `@relayapi/sdk`, not raw `/v1/*` calls, ad hoc `fetch` requests to the API, or custom HTTP clients. If the SDK lacks the needed endpoint, extend the SDK first, then use it from `apps/app`.
- **Shell performance comes first**: Do **not** add server-rendered `initial*Data` payload bootstrapping for dashboard pages as a default optimization. Prefer improving shell responsiveness, reducing client bootstrap cost, and trimming middleware/auth overhead first.
- **Internal app API auth should be minimal**: For internal Astro `/api/*` routes in `apps/app`, avoid full auth/session and full organization resolution when the route only needs minimal app-side context such as `user.id`, `session.activeOrganizationId`, or the dashboard API key lookup. The downstream API still enforces API-key authorization; app-side checks should stay minimal and route-specific.
- **Always use Tailwind for styling**: In `apps/app` (dashboard **and** the marketing landing under `src/components/landing/`), style with Tailwind v4 utility classes. Do **not** write bespoke CSS classes in `<style>` blocks or use inline `style="..."` attributes for component styling. Drive stateful/animated styling with `data-*` attributes + Tailwind variants (`data-[state=…]:`, `motion-reduce:`, etc.); put custom keyframes, colors, and tokens in the `@theme` block in `src/styles/globals.css` (see the `--animate-*` pattern) so they surface as utilities. Tailwind is loaded globally via `Layout.astro` → `globals.css`, so utilities work on every page including the landing.

## OAuth System Rules

**Before making ANY change** to `apps/api/src/config/oauth.ts`, `apps/api/src/routes/connect.ts` (OAuth flow), or `apps/api/src/services/token-refresh.ts`:

1. **Fetch and read the official docs** for the platform being changed. Only official platform documentation is allowed as a source (e.g. `developers.facebook.com`, `docs.x.com`, `learn.microsoft.com`, etc.). Never guess URLs, field names, or API versions.
2. **Find the exact section** in the docs that covers the endpoint or parameter being modified. Copy the relevant curl example or URL verbatim.
3. **Update the comment block** above the platform config in `oauth.ts` with:
   - The doc page URL where the information was found
   - The specific section/heading name
   - The exact endpoint URLs, HTTP methods, and field names as shown in the docs
4. **API versions live in `apps/api/src/config/api-versions.ts`** — the single source of truth for Meta Graph, Threads, Twitter, YouTube, Pinterest, TikTok, and LinkedIn version pins. All runtime code imports `API_VERSIONS` / `GRAPH_BASE` from this file. To bump a version, edit this file and let imports propagate; do not add new inline `v25.0` / `v1.0` strings elsewhere.
5. **Check the Graph API version** at `https://developers.facebook.com/docs/graph-api/changelog/versions/` before bumping `meta_graph` in `api-versions.ts`. All `graph.facebook.com` / `graph.instagram.com` URLs must route through `GRAPH_BASE.*`.
6. **Verify every platform config** — not just the one being changed — whenever touching the OAuth system. API versions expire and docs change.

## Tool Rules

- **Git**: NEVER run ANY git write command. This includes `git commit`, `git push`, `git stash`, `git reset`, `git checkout`, `git restore`, `git clean`, `git rebase`, `git merge`, `git cherry-pick`, `git add`, or any other command that modifies git state. Only READ-ONLY git commands are allowed: `git status`, `git diff`, `git log`, `git show`, `git blame`. Only the user modifies git state.
- **Playwright screenshots**: Always save to `/tmp/` (e.g. `filename: "/tmp/screenshot.png"`). Never save screenshots or other artifacts in the repo directory.
- **Installing packages**: This is a monorepo with workspaces. NEVER install packages in the root `package.json`. Always install in the specific app/package that needs it (e.g. `cd apps/app && bun add <pkg>` or edit that app's `package.json` directly). The root `package.json` holds only workspace-level tooling (e.g. `@biomejs/biome`) and the Bun dependency **catalog** (see below).
- **Dependency catalog (Bun)**: Shared dependency versions are centralized in the Bun catalog under `workspaces.catalog`. The private, Bun-installed packages — `apps/api`, `apps/app`, `apps/docs`, `packages/auth`, and `packages/db` — reference catalog versions with `"<pkg>": "catalog:"` instead of literal ranges. When adding or changing a dependency in one of these, set the version in the root catalog and use `"catalog:"` in the package (add the catalog entry first, or `bun install` fails to resolve the ref). Do **not** use `catalog:` in `apps/cli`, `packages/self-host`, `packages/sdk`, `packages/mcp`, or `packages/integrations/*` — they are published with npm, which does not understand the `catalog:` protocol; keep literal versions there. The Astro 7 packages (`astro`, `@astrojs/cloudflare`, `@astrojs/react`) are stable and live in the **default** catalog like everything else, referenced from `apps/app` as `"catalog:"` and tracking the npm `latest` dist-tag. Run `bun run deps:sync` to convert any literal-versioned deps in catalog-eligible packages to `catalog:` (it adds missing entries to the default catalog; `--dry-run` to preview). Run `bun run deps:upgrade` to bump catalog entries to their latest versions, then `bun install` — the default catalog resolves against the `latest` dist-tag, and named catalogs against their `CATALOG_DIST_TAG` (currently empty — add an entry to track a future named catalog against a pre-release tag); pass `--dry-run` to preview or `--force` to include held-back packages. `bun run packages:update` chains both steps (sync, then upgrade). The upgrade script keeps a `HELD` map for packages whose latest major needs a deliberate migration before bumping. TypeScript is currently held on 6.x because the official TypeScript 7 migration guidance says Astro and MDX projects must continue using TypeScript 6 until v7 exposes the stable programmatic API their tooling requires; standalone published packages that only invoke `tsc` may use TypeScript 7. Add any future hold with a reason, or pass `--force` to test held packages deliberately, and re-run `bun run typecheck` after any manual upgrade.
- **SDK updates**: When modifying API routes or schemas (`apps/api/src/routes/`, `apps/api/src/schemas/`), always update the TypeScript SDK at `packages/sdk/src/resources/` to match. Don't ask — just do it.

## Review

Claude will review your output once you are done.
