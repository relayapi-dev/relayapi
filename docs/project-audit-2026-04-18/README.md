# Project Audit 2026-04-18

This folder captures a repo-wide bug hunt based on local verification, targeted manual review, and official documentation lookup.

An explicit online recheck for every finding is recorded in [online-verification.md](./online-verification.md).

## Findings Index

- [F01 - LinkedIn organization lookup uses the wrong endpoint and response shape](./findings/F01-linkedin-organization-lookups.md)
- [F02 - `auth.test.ts` is broken after KV miss rehydration was added](./findings/F02-auth-test-mock-regression.md)
- [F03 - Root workspace globs omit nested integration packages](./findings/F03-workspace-glob-omits-integrations.md)
- [F04 - Usage metering undercounts non-`/bulk` multi-item endpoints](./findings/F04-usage-metering-bulk-endpoints.md)
- [F05 - Full API performance tests fail outside the Workers runtime](./findings/F05-durable-object-test-runtime.md)
- [F06 - Docs site metadata lacks `metadataBase`](./findings/F06-docs-metadata-base.md)
- [F07 - LinkedIn version pins are duplicated and already drifted from the latest doc version](./findings/F07-linkedin-version-drift.md)
- [F08 - Dashboard post notes panel calls a missing Astro API route](./findings/F08-post-notes-route-missing.md)
- [F09 - Selective post unpublish drops the `platforms` body before it reaches the API](./findings/F09-unpublish-platform-selection-dropped.md)
- [F10 - The published SDK is materially behind the live OpenAPI surface](./findings/F10-sdk-openapi-drift-more-endpoints.md)
- [F11 - API CI only runs a subset of tests, so known failing suites are not enforced](./findings/F11-api-ci-skips-failing-tests.md)

## Verification Snapshot

- `bun run typecheck` at repo root: passed.
- `bun test` in `apps/api`: failed.
- `bun test src/__tests__/auth.test.ts` in `apps/api`: failed.
- `bun test src/__tests__/performance.test.ts` in `apps/api`: failed.
- `bun test src/__tests__/usage-tracking.test.ts` in `apps/api`: failed.
- `bun test src/__tests__/usage-tracking.test.ts src/__tests__/performance.test.ts` in `apps/api`: failed.
- `bun run build` in `packages/sdk`: passed.
- `bun run typecheck` and `bun run build` in `packages/mcp`: passed.
- `bun run build` in `packages/integrations/n8n-node`: failed after root install because `n8n-workflow` was missing.
- `bun test` in `packages/integrations/zapier-app`: failed after root install because `zapier-platform-core` was missing.
- `bun run build:next` in `apps/docs`: passed with `metadataBase` warnings.
- `bun run build` in `apps/app`: blocked by the documented Hyperdrive local connection requirement, treated as an environment prerequisite rather than a new bug.
- `python3 -m compileall app` in `apps/downloader`: passed.

More detail is in [coverage.md](./coverage.md) and [sources.md](./sources.md).

## Scope Notes

- The review focused on executable code, build/test paths, workflows, and config across `apps/*`, `packages/*`, and `.github/workflows`.
- A second pass compared dashboard fetch targets, Astro API files, SDK resources, and the hosted OpenAPI surface to find route/signature drift that typecheck does not catch.
- Generated and reference-heavy docs content under `apps/docs/content` was build-validated, not read line-by-line.
- Platform API findings were checked against official vendor docs only.
