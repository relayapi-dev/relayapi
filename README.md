<p align="center">
  <img src="apps/app/public/favicon.svg" width="80" alt="RelayAPI" />
</p>

<h1 align="center">RelayAPI</h1>

<p align="center">
  <strong>Unified social media API — post, engage, and automate across 20 platforms with a single API.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@relayapi/sdk"><img src="https://img.shields.io/npm/v/@relayapi/sdk.svg?label=sdk" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/platforms-20-blue" alt="20 platforms" />
  <img src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/TypeScript-100%25-blue" alt="TypeScript" />
  <a href="https://docs.relayapi.dev"><img src="https://img.shields.io/badge/docs-relayapi.dev-green" alt="Documentation" /></a>
</p>

<p align="center">
  <a href="https://docs.relayapi.dev">Documentation</a> ·
  <a href="https://relayapi.dev">Dashboard</a> ·
  <a href="https://www.npmjs.com/package/@relayapi/sdk">SDK</a>
</p>

---

## Supported Platforms

| Social | Messaging | Newsletter |
|--------|-----------|------------|
| Twitter/X · Instagram · Facebook · LinkedIn · TikTok · YouTube · Pinterest · Reddit · Bluesky · Threads · Mastodon · Snapchat · Google Business · Discord | Telegram · WhatsApp · SMS | Beehiiv · ConvertKit · Mailchimp |

## Why RelayAPI?

|  | Direct Platform APIs | RelayAPI |
|---|---|---|
| **Integration effort** | 20 different APIs, SDKs, auth flows | 1 unified REST API |
| **Authentication** | Manage each OAuth flow separately | Single `/connect` endpoint |
| **Pagination** | Different format per platform | Consistent cursor-based |
| **Media handling** | Varies per platform | One upload endpoint, post everywhere |
| **Webhooks** | Register on each platform | Unified webhook system |
| **Rate limits** | Track per-platform | Managed for you |

## Features

- **Multi-platform posting** — publish to 20 platforms from a single endpoint
- **Unified inbox** — comments, reviews, and replies across all platforms in one place
- **Analytics** — cross-platform metrics, best posting times, and content decay tracking
- **Automation** — auto-post rules, sequences, engagement rules, and comment automations
- **Advertising** — manage ads across Meta, Google, TikTok, LinkedIn, Pinterest, and Twitter
- **Media management** — upload once, attach to any post (R2 storage with presigned URLs)
- **Webhooks** — real-time notifications for platform events with delivery logs
- **Queue & scheduling** — smart scheduling with queue slots and optimal time suggestions
- **URL shortening** — built-in short links with click tracking
- **Content templates** — reusable templates with signatures
- **WhatsApp** — bulk messaging and phone number provisioning
- **Integrations** — n8n, Make.com, and Zapier connectors

## Quick Start

### Install the SDK

```bash
npm install @relayapi/sdk
```

### Post to multiple platforms

```typescript
import Relay from '@relayapi/sdk';

const client = new Relay({
  apiKey: process.env['RELAY_API_KEY'],
});

// Create a post
await client.posts.create({
  text: 'Hello from RelayAPI!',
  account_ids: ['acc_...'],
});

// List all posts
const posts = await client.posts.list();
console.log(posts.data);
```

### Unified inbox

```typescript
// Fetch comments across all platforms
const comments = await client.inbox.list();

// Reply to a comment
await client.inbox.reply(commentId, {
  text: 'Thanks for the feedback!',
});
```

### Analytics

```typescript
const metrics = await client.analytics.retrieve({
  account_id: 'acc_...',
});
```

The SDK supports Node.js 20+, Deno, Bun, Cloudflare Workers, and Vercel Edge Runtime. Full SDK reference at [`packages/sdk`](packages/sdk/README.md).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **API** | [Hono](https://hono.dev) + [Zod-OpenAPI](https://github.com/honojs/middleware/tree/main/packages/zod-openapi) |
| **Runtime** | [Cloudflare Workers](https://workers.cloudflare.com) |
| **Database** | PostgreSQL via [Drizzle ORM](https://orm.drizzle.team) + [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) |
| **Storage** | [Cloudflare R2](https://developers.cloudflare.com/r2/) |
| **Auth** | [Better Auth](https://www.better-auth.com) with Google OAuth + API keys |
| **Dashboard** | [Astro](https://astro.build) (SSR on Cloudflare) |
| **Docs** | [Next.js](https://nextjs.org) + [Fumadocs](https://fumadocs.vercel.app) |
| **SDK** | TypeScript, auto-generated with [Stainless](https://www.stainless.com) |
| **Monorepo** | [Bun](https://bun.sh) workspaces |

## Project Structure

```
apps/
  api/           Hono REST API (Cloudflare Workers)
  app/           Astro dashboard (SSR)
  docs/          Next.js documentation site
  cli/           CLI tool
  downloader/    Python FastAPI media downloader microservice
packages/
  sdk/           TypeScript SDK (@relayapi/sdk)
  db/            Drizzle ORM schema & migrations
  auth/          Better Auth config
  integrations/  n8n, Make.com, Zapier connectors
  config/        Shared configuration
```

## Self-Hosting

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- PostgreSQL 15+
- Cloudflare account (for Workers, R2, KV, Hyperdrive, and Queues)

### Setup

1. **Clone the repository**

```bash
git clone https://github.com/relayapi-dev/relayapi.git
cd relayapi
```

2. **Install dependencies**

```bash
bun install
```

3. **Configure environment variables**

Copy and fill in the required environment variables for each app:

- `apps/api/` — Cloudflare bindings, database connection, OAuth credentials for each platform
- `apps/app/` — Dashboard config, auth settings
- `packages/db/` — PostgreSQL connection string

4. **Set up the database**

```bash
bun run db:generate   # Generate Drizzle migrations
bun run db:migrate    # Apply migrations
```

5. **Start development servers**

```bash
bun run dev:api       # API on localhost:8789
bun run dev:app       # Dashboard on localhost:4321
bun run dev:docs      # Docs site
```

6. **Deploy to Cloudflare**

Each app deploys independently via Wrangler. See the individual `wrangler.jsonc` files for binding configuration. CI/CD via GitHub Actions is included — push to `main` triggers deployment for changed apps.

### Cloudflare Bindings Required

| Binding | Type | Purpose |
|---------|------|---------|
| `HYPERDRIVE` | Hyperdrive | PostgreSQL connection pooling |
| `MEDIA_BUCKET` | R2 | Media file storage |
| `KV` | KV Namespace | API key cache (24h TTL) |
| `PUBLISH_QUEUE` | Queue | Async job processing |

## API Documentation

The API is fully documented with OpenAPI. When running the dev server, Swagger UI is available at `/docs`.

- **API Reference**: [docs.relayapi.dev](https://docs.relayapi.dev)
- **OpenAPI Spec**: auto-exported via `bun run --filter api export-openapi`

### API Conventions

- **Auth**: Bearer token with `rlay_live_*` (production) or `rlay_test_*` (test) prefixed API keys
- **Resource IDs**: Nanoid with prefixes — `ws_`, `acc_`, `post_`, `med_`, `wh_`
- **Pagination**: Cursor-based with `next_cursor` and `has_more` (limit 1–100, default 20)
- **Errors**: `{ error: { code, message, details? } }`
- **Multi-tenancy**: Resources scoped by `workspace_id` (optional on list/create endpoints)

## Contributing

Contributions are welcome. This section covers the full developer loop — running the stack locally, debugging, and the conventions you should follow.

### 1. Fork and branch

```bash
git clone https://github.com/<your-fork>/relayapi.git
cd relayapi
git checkout -b feat/my-feature
```

### 2. Running the stack locally

**Prerequisites**: [Bun](https://bun.sh) v1.0+, Node.js 20+, SSH access to the dev database host (request from a maintainer).

```bash
bun install
```

**Open an SSH tunnel to the database before starting any dev server.** The Postgres instance is not exposed publicly — the tunnel forwards `localhost:5433` to the remote Postgres on port 5432.

- In VS Code: run the `SSH Tunnel to Database` task (Terminal → Run Task).
- Manual command lives in `.vscode/tasks.json`.

Wrangler picks up the tunnel via `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` (set in `.vscode/settings.json`), which makes Hyperdrive emulate locally against `localhost:5433`.

Then start the app(s) you are working on:

| Command | What it runs | URL |
|---------|--------------|-----|
| `bun run dev:api` | Hono API on Wrangler | `http://localhost:8789` |
| `bun run dev:app` | Astro dashboard | `http://localhost:4321` |
| `bun run dev:docs` | Next.js docs site | `http://localhost:3000` |
| `bun run dev:cli` | CLI tool in watch mode | — |

### 3. Seeding a dev user

Set `SEED_USER_EMAIL` and `SEED_USER_PASSWORD` in your environment, then:

```bash
bun run scripts/seed.ts
```

Sign in at `http://localhost:4321/app` with those credentials.

### 4. Database workflow

```bash
bun run db:generate   # Generate a Drizzle migration from schema changes
bun run db:migrate    # Apply pending migrations to the tunnelled DB
bun run db:studio     # Open Drizzle Studio against the tunnelled DB
```

### 5. Debugging

- **API requests**: hit `http://localhost:8789/docs` for Swagger UI, or use `curl` with a `rlay_test_*` API key.
- **Wrangler logs**: `bun run dev:api` streams Worker logs, including `console.log`, bindings, and queue activity.
- **Database state**: `bun run db:studio` opens a browser UI for inspecting rows.
- **Dashboard**: the Astro dev server supports hot reload; use browser devtools for client state and the terminal for SSR logs.
- **OAuth flows**: test locally by setting `APP_URL=http://localhost:4321` and registering `http://localhost:8789/v1/connect/<platform>/callback` in the platform's developer console.
- **Queues**: Wrangler emulates queues locally; check terminal output for `PUBLISH_QUEUE` consumer runs.
- **Type errors**: `bun run typecheck` runs all packages. Use `bun run typecheck:api` (or `:app`, `:db`, etc.) to narrow down.

### 6. Checks before opening a PR

```bash
bun run typecheck            # All packages & apps compile
bun test --cwd apps/api      # API unit tests
```

Biome handles formatting and linting — most editors pick up `biome.json` automatically.

### 7. Submit the PR

Open a pull request against `main`. CI runs typecheck and deploys the relevant app when the PR is merged.

## Best Practices

Follow these — they are enforced in code review.

### Commits

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`.
- `feat(sdk):` / `fix(sdk):` trigger an automated SDK release via release-please. Use `feat(sdk)!:` or a `BREAKING CHANGE` footer for majors.

### API-first architecture

- `apps/api` is the product. It must run autonomously without `apps/app`.
- Never leak dashboard-specific assumptions (auth flows, response shapes, bootstrap payloads) into the API.
- If a dashboard page is slow, fix it in `apps/app` first (shell cost, middleware, hydration) before proposing API-side changes.

### Dashboard rules (`apps/app`)

- All calls from `apps/app` to `apps/api` **must** go through `@relayapi/sdk`. No raw `fetch('/v1/...')`, no ad hoc HTTP clients. If the SDK is missing an endpoint, extend the SDK first.
- Keep the multi-page navigation model — do not replace it with a client-side SPA router unless explicitly agreed.
- Internal Astro `/api/*` routes should stay minimal (just what's needed for `user.id`, active org, or dashboard API key lookup). Authorization is enforced downstream by the API.

### SDK updates

When you change an API route or schema in `apps/api/src/routes/` or `apps/api/src/schemas/`, update the matching SDK resource in `packages/sdk/src/resources/` in the same PR. This is not optional — the SDK is published automatically and must stay in sync.

### Monorepo hygiene

- Never add dependencies to the root `package.json`. Install in the specific workspace (`apps/<name>` or `packages/<name>`). The root is reserved for workspace tooling like Biome.
- Shared code goes in `packages/` — do not cross-import between apps.

### OAuth changes

Before touching `apps/api/src/config/oauth.ts`, `apps/api/src/routes/connect.ts`, or `apps/api/src/services/token-refresh.ts`:

1. Fetch the **official platform documentation** (e.g. `developers.facebook.com`, `docs.x.com`). Do not guess URLs or field names.
2. Update the comment block above the platform config with the doc URL, section name, and verbatim endpoint/method/field names.
3. For Meta platforms, verify the Graph API version against the [changelog](https://developers.facebook.com/docs/graph-api/changelog/versions/).
4. When touching OAuth, re-verify every platform's config — API versions expire.

### Data model

- All resources are scoped by `workspace_id`. Always filter by it.
- Sensitive columns (tokens, secrets) are encrypted with AES-256-GCM — use the existing helpers, don't store plaintext.
- Business tables live in the `public` schema; auth tables in `auth` are owned by Better Auth — don't modify the auth schema manually.

### Security

- Never log or commit secrets, access tokens, or API keys.
- Validate all input with Zod schemas at the route boundary.
- Use the existing rate-limit middleware — don't bypass it for "just this one endpoint."

## License

MIT
