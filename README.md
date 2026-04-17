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
git clone https://github.com/nicely-gg/relayapi.git
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
bun run dev:api       # API on localhost:8787
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

Contributions are welcome! Here's how to get started:

1. **Fork** the repository
2. **Create a branch** for your feature or fix (`git checkout -b feat/my-feature`)
3. **Make your changes** — follow the existing code style (enforced by [Biome](https://biomejs.dev))
4. **Run type checks** to make sure everything compiles:

```bash
bun run typecheck
```

5. **Submit a pull request** against `main`

### Guidelines

- **Commit messages**: Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, etc.)
- **SDK changes**: If you modify API routes or schemas in `apps/api/src/`, update the corresponding SDK resources in `packages/sdk/src/resources/` to match
- **Packages**: Never install dependencies in the root `package.json` — always install in the specific app or package that needs them
- **OAuth changes**: When modifying OAuth configuration, always reference official platform documentation and update the comment blocks with source URLs

## License

MIT
