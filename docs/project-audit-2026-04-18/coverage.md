# Coverage Notes

## Commands Run

- `bun run typecheck`
- `bun test` in `apps/api`
- `bun test src/__tests__/auth.test.ts` in `apps/api`
- `bun test src/__tests__/performance.test.ts` in `apps/api`
- `bun test src/__tests__/usage-tracking.test.ts` in `apps/api`
- `bun test src/__tests__/usage-tracking.test.ts src/__tests__/performance.test.ts` in `apps/api`
- `bun test` in `apps/app`
- `bun run build` in `apps/app`
- `bun run build:next` in `apps/docs`
- `bun run build` in `packages/sdk`
- `bun run typecheck` in `packages/mcp`
- `bun run build` in `packages/mcp`
- `bun run build` in `packages/integrations/n8n-node`
- `bun test` in `packages/integrations/zapier-app`
- `python3 -m compileall app` in `apps/downloader`

## Areas Touched

- Root monorepo config and scripts.
- API middleware, routes, platform integrations, test suite, and worker entrypoint.
- Dashboard build path and shared SDK wiring.
- Dashboard fetch target parity vs Astro API routes.
- SDK resource parity vs mounted API routes and hosted OpenAPI spec.
- Docs build path and root metadata.
- SDK and MCP build/typecheck surfaces.
- Integration package install/build/test surfaces.
- Downloader Python import/compile sanity.
- GitHub workflows relevant to the failing paths.

## Notable Limits

- `apps/docs/content/**` contains thousands of generated or reference MDX files. They were build-validated but not manually reviewed one by one.
- `apps/app` production build could not be completed without the repo's documented local Hyperdrive setup. That was treated as an environment prerequisite, not as a new finding.
- This audit is a high-signal snapshot, not a formal proof that every line in the repo is bug-free.
- Live RelayAPI docs were queried via the hosted docs/OpenAPI endpoints to confirm public contract drift, but the docs site HTML is heavily client-rendered and not ideal for exhaustive scraping.
