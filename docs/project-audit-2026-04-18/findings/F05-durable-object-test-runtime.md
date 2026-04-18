# F05 - Full API performance tests fail outside the Workers runtime

Severity: medium
Status: ✅ Fixed

## Summary

The main API entrypoint re-exports a Durable Object that imports `DurableObject` from `cloudflare:workers`. Any Bun test that imports `apps/api/src/index.ts` directly now depends on a Cloudflare-only module and fails before the performance assertions even run.

## Affected Files

- `apps/api/src/index.ts:243-244`
- `apps/api/src/durable-objects/post-updates.ts:1-10`

## Local Evidence

- [index.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/index.ts:244) re-exports `RealtimeDO`.
- [post-updates.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/durable-objects/post-updates.ts:1) imports `DurableObject` from `cloudflare:workers`.
- Running `bun test src/__tests__/performance.test.ts` in `apps/api` fails with `Cannot find package 'cloudflare:workers'`.

## Official Confirmation

- Cloudflare's Durable Object docs show that `DurableObject` is imported from `cloudflare:workers`.
- Cloudflare's testing docs recommend the Workers Vitest integration for Worker code and specifically recommend `@cloudflare/vitest-pool-workers` for Durable Object tests so they run inside the Workers runtime.

## Why This Is a Bug

- `bun test` is no longer a reliable full-suite verification command for `apps/api`.
- The performance suite currently reports ten endpoint test failures, but the real root cause is an environment mismatch before those checks can execute.
- This creates confusing signal and makes local regression checking weaker.

## Recommended Fix

1. Split the plain Hono app construction from the Worker export so tests can import the app without importing the Durable Object module.
2. Or migrate Worker-level integration/performance tests to Cloudflare's Workers Vitest integration.
3. Keep Bun tests for pure schema, utility, and middleware units that do not rely on Worker-only modules.
