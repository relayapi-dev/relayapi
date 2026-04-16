Keep `CLAUDE.md` and `AGENTS.md` in sync. Any change to one file must be applied to the other file at the same time.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RelayAPI is a unified social media API for posting to 17 platforms via a single API. TypeScript monorepo deployed on Cloudflare Workers.

## Commands

```bash
# Install dependencies
bun install

# Development
bun run dev:api       # API server on localhost:8787
bun run dev:app       # Astro dashboard
bun run dev:docs      # Next.js docs site

# Type checking
bun run typecheck     # All packages and apps

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
- **packages/db** — Drizzle ORM schema and client. Exports `createDb(connectionString)` and all schema tables. PostgreSQL via `postgres` driver.
- **packages/auth** — Better Auth setup with Google OAuth and API key plugin. Uses `@relayapi/db` for storage.

### API-First Principle

- **The API is the main product**: `apps/api` must work autonomously without `apps/app`. Treat the dashboard as a client of the API, not as the system that defines API architecture.
- **Do not couple the API to the dashboard**: Avoid app-specific assumptions, auth flows, response shapes, or infrastructure requirements leaking into `apps/api` unless the user explicitly asks for that tradeoff.
- **Fix dashboard overhead in the dashboard first**: When the problem is dashboard performance or UX, prefer reducing `apps/app` middleware, bootstrap, proxy, and hydration cost before proposing changes that make the API depend on the app.

### SSH Tunnel (required for local dev)

The database runs on a remote server. You **must** create an SSH tunnel before running the dev server, connecting to the database, or running migrations.

**VS Code:** Run the "SSH Tunnel to Database" task (Terminal > Run Task). It forwards `localhost:5433` to remote Postgres on port 5432.

**Manual:** See `.vscode/tasks.json` for the SSH tunnel command.

The `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` env var (set in `.vscode/settings.json`) points wrangler at `localhost:5433` to emulate Hyperdrive locally.

### Cloudflare Bindings (apps/api)

The API uses these Cloudflare bindings defined in `wrangler.jsonc`:
- **KV** — API key cache (24h TTL)
- **MEDIA_BUCKET** (R2) — Media file storage
- **HYPERDRIVE** — PostgreSQL connection pooling
- **PUBLISH_QUEUE** — Async job queue

### Key Patterns

- **Multi-tenancy**: All resources scoped by `workspace_id`. The `workspace_id` parameter is optional on list and create endpoints for posts, webhooks, inbox conversations, automation rules, comment automations, sequences, broadcasts, custom field definitions, and WhatsApp contacts. If omitted, operates across all workspaces.
- **API keys**: Bearer tokens prefixed `rlay_live_*` (production) or `rlay_test_*` (test). SHA-256 hashed before DB lookup. Cached in KV.
- **Resource IDs**: Nanoid with prefixes — `ws_`, `acc_`, `post_`, `med_`, `wh_`.
- **Pagination**: Cursor-based with `next_cursor` and `has_more`. Limit 1–100, default 20.
- **Error responses**: `{ error: { code, message, details? } }`.
- **Database schema**: Auth tables in `auth` schema (managed by Better Auth), business tables in `public` schema. Sensitive fields use AES-256-GCM encryption.
- **OpenAPI**: Routes defined with `@hono/zod-openapi`. Swagger UI served at `/docs`.

### CI/CD

GitHub Actions deploy each app independently on push to `main` when relevant paths change. All use Wrangler with `CLOUDFLARE_API_TOKEN` secret. The `sync-openapi` workflow auto-commits updated OpenAPI specs.

### SDK Releases

The SDK (`packages/sdk`) uses **release-please** for automated versioning and npm publishing. Commits must use **Conventional Commits** prefixes to trigger a release:
- `fix(sdk):` → patch bump (0.0.x)
- `feat(sdk):` → minor bump (0.x.0)
- `feat(sdk)!:` or `BREAKING CHANGE` → major bump (x.0.0)

Other prefixes (`chore:`, `docs:`, `refactor:`, etc.) are included in the next release but won't trigger one on their own. The flow is: push to main → release-please opens a PR → merge the PR → npm publish runs automatically.

## Dev Credentials

- **Dashboard login**: provide `SEED_USER_EMAIL` and `SEED_USER_PASSWORD` before running `scripts/seed.ts`
- **Dashboard URL**: `http://localhost:4321/app` (requires `bun run dev:app`)
- **API URL**: `http://localhost:8789` (requires `bun run dev:api`)

## Dashboard App Rules (`apps/app`)

- **Navigation architecture is intentional**: Do **not** replace dashboard page navigations with a persistent client router, SPA router, or a single `/app` shell that swaps route content without full document navigation, unless the user explicitly asks for that architectural change.
- **Always use the SDK for app-to-API calls**: In `apps/app`, any call to `apps/api` must go through `@relayapi/sdk`, not raw `/v1/*` calls, ad hoc `fetch` requests to the API, or custom HTTP clients. If the SDK lacks the needed endpoint, extend the SDK first, then use it from `apps/app`.
- **Shell performance comes first**: Do **not** add server-rendered `initial*Data` payload bootstrapping for dashboard pages as a default optimization. Prefer improving shell responsiveness, reducing client bootstrap cost, and trimming middleware/auth overhead first.
- **Internal app API auth should be minimal**: For internal Astro `/api/*` routes in `apps/app`, avoid full auth/session and full organization resolution when the route only needs minimal app-side context such as `user.id`, `session.activeOrganizationId`, or the dashboard API key lookup. The downstream API still enforces API-key authorization; app-side checks should stay minimal and route-specific.

## OAuth System Rules

**Before making ANY change** to `apps/api/src/config/oauth.ts`, `apps/api/src/routes/connect.ts` (OAuth flow), or `apps/api/src/services/token-refresh.ts`:

1. **Fetch and read the official docs** for the platform being changed. Only official platform documentation is allowed as a source (e.g. `developers.facebook.com`, `docs.x.com`, `learn.microsoft.com`, etc.). Never guess URLs, field names, or API versions.
2. **Find the exact section** in the docs that covers the endpoint or parameter being modified. Copy the relevant curl example or URL verbatim.
3. **Update the comment block** above the platform config in `oauth.ts` with:
   - The doc page URL where the information was found
   - The specific section/heading name
   - The exact endpoint URLs, HTTP methods, and field names as shown in the docs
4. **Check the Graph API version** at `https://developers.facebook.com/docs/graph-api/changelog/versions/` for any Facebook/Instagram/Threads changes. All `graph.facebook.com` and `graph.instagram.com` URLs must use a supported version.
5. **Verify every platform config** — not just the one being changed — whenever touching the OAuth system. API versions expire and docs change.

## Tool Rules

- **Git**: NEVER run ANY git write command. This includes `git commit`, `git push`, `git stash`, `git reset`, `git checkout`, `git restore`, `git clean`, `git rebase`, `git merge`, `git cherry-pick`, `git add`, or any other command that modifies git state. Only READ-ONLY git commands are allowed: `git status`, `git diff`, `git log`, `git show`, `git blame`. Only the user modifies git state.
- **Playwright screenshots**: Always save to `/tmp/` (e.g. `filename: "/tmp/screenshot.png"`). Never save screenshots or other artifacts in the repo directory.
- **Installing packages**: This is a monorepo with workspaces. NEVER install packages in the root `package.json`. Always install in the specific app/package that needs it (e.g. `cd apps/app && bun add <pkg>` or edit that app's `package.json` directly). The root `package.json` should only contain workspace-level tooling like `@biomejs/biome`.
- **SDK updates**: When modifying API routes or schemas (`apps/api/src/routes/`, `apps/api/src/schemas/`), always update the TypeScript SDK at `packages/sdk/src/resources/` to match. Don't ask — just do it.
