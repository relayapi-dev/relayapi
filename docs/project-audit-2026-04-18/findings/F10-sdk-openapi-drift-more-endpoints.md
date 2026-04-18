# F10 - The published SDK is materially behind the live OpenAPI surface

Severity: medium

## Summary

The TypeScript SDK is missing multiple endpoints that are already mounted in the API and published in the hosted OpenAPI spec. This is not limited to one route: the gaps include an entire documented resource (`custom-fields`) plus several individual operations under posts and media.

## Affected Files

- `packages/sdk/src/resources/index.ts`
- `packages/sdk/src/resources/media.ts`
- `packages/sdk/src/resources/posts/posts.ts`
- `apps/api/src/index.ts:173-213`
- `apps/api/src/routes/custom-fields.ts`
- `apps/api/src/routes/media.ts:191-204`
- `apps/api/src/routes/posts.ts:2628-3652`

## Local Evidence

- [packages/sdk/src/resources/index.ts](/Users/zank/Developer/majestico/relayapi/packages/sdk/src/resources/index.ts:1) exports no `customFields` resource, and there is no `packages/sdk/src/resources/custom-fields.ts` file in the SDK tree.
- [packages/sdk/src/resources/media.ts](/Users/zank/Developer/majestico/relayapi/packages/sdk/src/resources/media.ts:1) has `list`, `retrieve`, `delete`, `getPresignURL`, and `upload`, but no `confirm`.
- [packages/sdk/src/resources/posts/posts.ts](/Users/zank/Developer/majestico/relayapi/packages/sdk/src/resources/posts/posts.ts:1) has no methods for:
  - `POST /v1/posts/bulk-csv`
  - `GET/PATCH /v1/posts/{id}/notes`
  - `POST /v1/posts/{id}/update-metadata`
- The API mounts and route files do define those endpoints:
  - [custom-fields router mount](/Users/zank/Developer/majestico/relayapi/apps/api/src/index.ts:196)
  - [custom-fields routes](/Users/zank/Developer/majestico/relayapi/apps/api/src/routes/custom-fields.ts:40)
  - [media confirm route](/Users/zank/Developer/majestico/relayapi/apps/api/src/routes/media.ts:191)
  - [post metadata update route](/Users/zank/Developer/majestico/relayapi/apps/api/src/routes/posts.ts:2628)
  - [post notes routes](/Users/zank/Developer/majestico/relayapi/apps/api/src/routes/posts.ts:3599)

## External Confirmation

- RelayAPI’s hosted OpenAPI spec currently publishes these paths:
  - `GET/POST /v1/custom-fields`
  - `POST /v1/media/confirm`
  - `POST /v1/posts/bulk-csv`
  - `GET/PATCH /v1/posts/{id}/notes`
  - `POST /v1/posts/{id}/update-metadata`
  Source: https://api.relayapi.dev/openapi.json
- Hosted docs pages also exist for at least:
  - https://docs.relayapi.dev/api-reference/custom-fields/listCustomFields
  - https://docs.relayapi.dev/api-reference/posts/getPostNotes

## Why This Is a Bug

- SDK consumers cannot call documented endpoints without bypassing the SDK.
- The app-side notes bug is a downstream symptom of this drift, not an isolated UI mistake.
- The repo’s own invariant says API route/schema changes should be mirrored into `packages/sdk`, so this drift is a maintenance regression.

## Recommended Fix

1. Regenerate or hand-update the SDK against the current hosted OpenAPI spec.
2. Add resources/methods for `custom-fields`, `media.confirm`, `posts.bulkCsvUpload`, `posts.getNotes`, `posts.updateNotes`, and `posts.updateMetadata`.
3. Add a parity check in CI that diffs mounted API paths against SDK path inventory so missing endpoints fail fast.
