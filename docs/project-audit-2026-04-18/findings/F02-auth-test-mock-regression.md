# F02 - `auth.test.ts` is broken after KV miss rehydration was added

Severity: high

## Summary

`authMiddleware` now rehydrates a missing KV cache entry from the database, but `auth.test.ts` still mocks `createDb` as an empty object. The repo's API CI workflow runs this file, so the stale mock is a real test regression.

## Affected Files

- `apps/api/src/middleware/auth.ts:44-105`
- `apps/api/src/__tests__/auth.test.ts:4-8`
- `apps/api/src/__tests__/auth.test.ts:93-101`
- `.github/workflows/ci-api.yml:35-37`

## Local Evidence

- [apps/api/src/middleware/auth.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/middleware/auth.ts:50) now calls `db.select(...).from(...).where(...).limit(1)` on KV misses.
- [apps/api/src/__tests__/auth.test.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/__tests__/auth.test.ts:4) still mocks `createDb: () => ({})`.
- Running `bun test src/__tests__/auth.test.ts` in `apps/api` fails with `TypeError: db.select is not a function`.
- [ci-api.yml](/Users/zank/Developer/majestico/relayapi/.github/workflows/ci-api.yml:35) explicitly includes `src/__tests__/auth.test.ts`.

## Official Confirmation

- Bun's `mock.module()` docs confirm the mock factory completely replaces the module export, so the test must supply a compatible surface.
- Drizzle's select docs confirm the middleware is using the expected `db.select().from().where().limit()` query-builder API.

## Why This Is a Bug

- The test no longer exercises the real KV-miss branch.
- A CI job that includes `auth.test.ts` can fail even when runtime code is correct.
- The broken mock hides whether DB rehydration works for missing API keys.

## Recommended Fix

1. Replace the empty `createDb` mock with the existing chainable mock DB helper from `apps/api/src/__tests__/__mocks__/db.ts`, or add the minimal `select().from().where().limit()` shape inline.
2. Add two explicit tests for the KV-miss path:
   - missing key in DB returns `401`
   - existing DB row hydrates KV and authenticates successfully
3. Keep the KV-hit tests as fast-path coverage.
