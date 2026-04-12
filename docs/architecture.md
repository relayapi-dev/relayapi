# Architecture

## Overview

RelayAPI is a TypeScript monorepo for a unified social publishing, messaging, newsletter, inbox, automation, and ads API. The backend is built around Cloudflare Workers and a PostgreSQL database.

## Monorepo Layout

- `apps/api` — Hono REST API with `@hono/zod-openapi`
- `apps/app` — Astro dashboard
- `apps/docs` — Next.js docs site
- `packages/db` — Drizzle schema and database client
- `packages/auth` — Better Auth integration for dashboard auth and org membership
- `packages/sdk` — TypeScript SDK

## Core Decisions

- The API contract is defined in code. Routes and schemas in `apps/api` are the canonical source for behavior.
- API requests are authenticated with Bearer API keys prefixed `rlay_live_*` or `rlay_test_*`.
- API keys are SHA-256 hashed before lookup and cached in Cloudflare KV.
- Better Auth manages user auth, organization membership, invitations, and API key lifecycle for the dashboard side.
- Tenancy is organization-scoped by API key. Many list and create endpoints accept optional `workspace_id` filters to narrow scope inside the authenticated organization.
- PostgreSQL access goes through Drizzle ORM and Cloudflare Hyperdrive.
- Background work is queue-driven. Publishing, refresh, webhook, and other async flows run through Cloudflare Queues.
- Media assets live in Cloudflare R2.
- Sensitive stored credentials use AES-256-GCM encryption.
- OpenAPI is generated from route definitions. Swagger UI is served from the API app at `/docs`.

## Core Infrastructure

- `KV` — API key cache and short-lived operational state
- `MEDIA_BUCKET` — R2 media storage
- `HYPERDRIVE` — PostgreSQL connection pooling
- `PUBLISH_QUEUE` — async publish pipeline

## Local Development Constraints

- The database is remote. An SSH tunnel to the database is required before running the API, using the DB, or applying migrations.
- The local Hyperdrive connection is expected to point at `localhost:5433`.
- Primary commands:
  - `bun install`
  - `bun run dev:api`
  - `bun run dev:app`
  - `bun run dev:docs`
  - `bun run typecheck`
  - `bun run db:migrate`

## Documentation Rules Worth Preserving

- Keep `AGENTS.md` and `CLAUDE.md` in sync.
- When changing the OAuth system, use official platform documentation only and update the source comments in the OAuth config accordingly.
- When modifying API routes or schemas, update the TypeScript SDK to match.
