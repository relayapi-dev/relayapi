# Online Verification 2026-04-18

This pass rechecked every finding in the audit against live public docs, official framework/vendor docs, or both on 2026-04-18.

## F01 - LinkedIn organization lookup endpoint/shape

- Status: confirmed.
- Docs checked:
  - LinkedIn Organization Access Control by Role: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role?view=li-lms-2026-02
  - LinkedIn Marketing API versioning: https://learn.microsoft.com/en-us/linkedin/marketing/versioning?view=li-lms-2026-03
- Result: LinkedIn documents `GET https://api.linkedin.com/rest/organizationAcls?q=roleAssignee` with `X-Restli-Protocol-Version: 2.0.0` and `Linkedin-Version`. Sample responses return organization URNs via `organization` or `organizationTarget`, not `organizationId`.

## F02 - `auth.test.ts` mock regression

- Status: confirmed.
- Docs checked:
  - Bun `mock.module()` docs: https://bun.sh/docs/test/mocks
  - Drizzle select API docs: https://orm.drizzle.team/docs/select
- Result: Bun mocks replace the target module export, so the test must provide a compatible `createDb()` surface. The runtime middleware now uses a Drizzle-style `select().from().where().limit()` chain, which the current `{}` mock cannot satisfy.

## F03 - workspace glob omission

- Status: confirmed.
- Docs checked:
  - Bun workspaces: https://bun.sh/docs/pm/workspaces
- Result: Bun installs packages matched by the root `workspaces` field and explicitly supports recursive patterns such as `packages/**`. That confirms `packages/*` excludes nested integration packages under `packages/integrations/*`.

## F04 - usage metering undercounts bulk-style endpoints

- Status: confirmed with an internal-contract caveat.
- Docs checked:
  - RelayAPI hosted OpenAPI spec: https://api.relayapi.dev/openapi.json
- Result: the live public spec still exposes multiple multi-item endpoints with different shapes: `posts`, `recipients`, `contact_ids`, `targets`, and multipart `/v1/posts/bulk-csv`. The billing rule itself is internal to RelayAPI, but the public contracts confirm the middleware heuristic does not cover all documented bulk-style endpoints.

## F05 - Durable Object tests require Workers runtime

- Status: confirmed.
- Docs checked:
  - Cloudflare Workers testing overview: https://developers.cloudflare.com/workers/testing/
  - Cloudflare Testing Durable Objects: https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/
  - Cloudflare Durable Object API import examples: https://developers.cloudflare.com/durable-objects/api/state/
- Result: Durable Objects are part of the Workers runtime and Cloudflare documents testing them inside the Workers/Vitest environment. That matches the observed Bun failure when `cloudflare:workers` is imported directly.

## F06 - missing `metadataBase`

- Status: confirmed.
- Docs checked:
  - Next.js Metadata API: https://nextjs.org/docs/app/api-reference/functions/generate-metadata
- Result: Next documents `metadataBase` as the root layout base URL for relative metadata fields. The build warning about resolving social URLs against localhost is consistent with the documented behavior.

## F07 - LinkedIn version drift and duplication

- Status: confirmed.
- Docs checked:
  - LinkedIn Marketing API versioning: https://learn.microsoft.com/en-us/linkedin/marketing/versioning?view=li-lms-2026-03
- Result: LinkedIn still requires the `Linkedin-Version` header and currently lists April 2026 (`202604`) as the latest version. The repo still duplicates `202603` in multiple runtime files, so the drift and single-source-of-truth violation both stand.

## F08 - missing Astro notes route

- Status: confirmed.
- Docs checked:
  - Astro pages: https://docs.astro.build/en/basics/astro-pages/
  - Astro endpoints: https://docs.astro.build/en/guides/endpoints/
  - RelayAPI hosted docs: https://docs.relayapi.dev/api-reference/posts/getPostNotes
  - RelayAPI hosted OpenAPI spec: https://api.relayapi.dev/openapi.json
- Result: Astro API routes are file-backed under `src/pages`, and the app has no `[id]/notes.ts` endpoint file. RelayAPI's public docs and live spec still expose `GET/PATCH /v1/posts/{id}/notes`, so the dashboard path is still missing its app-layer proxy.

## F09 - selective unpublish body is dropped

- Status: confirmed.
- Docs checked:
  - RelayAPI hosted docs: https://docs.relayapi.dev/api-reference/posts/unpublishPost
  - RelayAPI hosted OpenAPI spec: https://api.relayapi.dev/openapi.json
- Result: the live public contract still documents `POST /v1/posts/{id}/unpublish` with an optional JSON body containing `platforms`. The current app-to-SDK call path still passes `{ platforms }` as request options instead of as `body`, so the documented field is dropped before serialization.

## F10 - SDK/public API drift

- Status: confirmed.
- Docs checked:
  - RelayAPI hosted OpenAPI spec: https://api.relayapi.dev/openapi.json
  - RelayAPI docs - custom fields: https://docs.relayapi.dev/api-reference/custom-fields/listCustomFields
  - RelayAPI docs - post notes: https://docs.relayapi.dev/api-reference/posts/getPostNotes
- Result: the live public spec still publishes `/v1/custom-fields`, `/v1/media/confirm`, `/v1/posts/bulk-csv`, `/v1/posts/{id}/notes`, and `/v1/posts/{id}/update-metadata`. Those routes remain absent from the SDK resource surface.

## F11 - CI only runs a subset of API tests

- Status: confirmed.
- Docs checked:
  - GitHub Actions workflow syntax: https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions
  - GitHub Actions run steps: https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-your-workflow-do/add-scripts
- Result: GitHub Actions only executes the commands explicitly listed in `run` steps. Since the workflow names only four API test files, the other committed test files are not part of the gate unless a separate job adds them.
