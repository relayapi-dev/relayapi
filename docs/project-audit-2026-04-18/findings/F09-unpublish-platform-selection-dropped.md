# F09 - Selective post unpublish drops the `platforms` body before it reaches the API

Severity: high

## Summary

The dashboard lets users choose which platforms to unpublish from, but the Astro proxy passes that JSON object into an SDK method whose second parameter is `RequestOptions`, not a request body. The result is that the `platforms` array is never serialized, so the API receives an empty body and behaves as “unpublish from all”.

## Affected Files

- `apps/app/src/components/dashboard/pages/posts-page.tsx:366-381`
- `apps/app/src/pages/api/posts/[id]/unpublish.ts:8-9`
- `packages/sdk/src/resources/posts/posts.ts:121-125`
- `packages/sdk/src/internal/request-options.ts:11-66`
- `apps/api/src/routes/posts.ts:323-347`

## Local Evidence

- [posts-page.tsx](/Users/zank/Developer/majestico/relayapi/apps/app/src/components/dashboard/pages/posts-page.tsx:366) sends `body: JSON.stringify({ platforms: [...unpublishSelected] })`.
- [posts/[id]/unpublish.ts](/Users/zank/Developer/majestico/relayapi/apps/app/src/pages/api/posts/[id]/unpublish.ts:9) calls `client.posts.unpublish(ctx.params.id!, body)`.
- In the SDK, [posts.unpublish()](/Users/zank/Developer/majestico/relayapi/packages/sdk/src/resources/posts/posts.ts:124) is declared as `unpublish(id: string, options?: RequestOptions)` and forwards `options` directly to `_client.post(...)`.
- [RequestOptions](/Users/zank/Developer/majestico/relayapi/packages/sdk/src/internal/request-options.ts:11) only serializes a body when it is nested under the `body` key.
- Because the Astro route passes `{ platforms: [...] }` as raw options instead of `{ body: { platforms: [...] } }`, the SDK ignores it during request construction.
- The API route itself explicitly expects an optional JSON body with a `platforms` array at [apps/api/src/routes/posts.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/routes/posts.ts:338).

## External Confirmation

- RelayAPI’s hosted OpenAPI spec declares `POST /v1/posts/{id}/unpublish` with an optional JSON request body containing `platforms`: https://api.relayapi.dev/openapi.json
- The hosted docs page for the same operation is: https://docs.relayapi.dev/api-reference/posts/unpublishPost

## Why This Is a Bug

- The UI suggests partial unpublish, but the proxy path strips the selection.
- This can produce a materially different result from what the operator chose, especially for multi-platform posts.
- It is a silent data-loss bug in the request path, not just a type mismatch.

## Recommended Fix

1. Change the SDK signature to `unpublish(id: string, body?: { platforms?: string[] }, options?: RequestOptions)`.
2. Send the request as `_client.post(path\`/v1/posts/${id}/unpublish\`, { body, ...options })`.
3. Keep the Astro route simple: read JSON once, pass it as the method body, and add a regression test that asserts the outgoing request preserves `platforms`.
