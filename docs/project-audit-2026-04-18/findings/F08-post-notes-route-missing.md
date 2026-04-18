# F08 - Dashboard post notes panel calls a missing Astro API route

Severity: high
Status: ✅ Fixed

## Summary

The dashboard notes panel issues `GET` and `PATCH` requests to `/api/posts/:id/notes`, but `apps/app` does not define that Astro endpoint. The backend API and public docs both expose `/v1/posts/{id}/notes`, so the UI feature is wired to a route that does not exist in the app layer.

## Affected Files

- `apps/app/src/components/dashboard/pages/posts/notes-panel.tsx:22`
- `apps/app/src/components/dashboard/pages/posts/notes-panel.tsx:56`
- `apps/api/src/routes/posts.ts:3599-3644`
- `apps/docs/content/docs/api-reference/posts/getPostNotes.mdx`
- `apps/docs/content/docs/api-reference/posts/updatePostNotes.mdx`

## Local Evidence

- [notes-panel.tsx](/Users/zank/Developer/majestico/relayapi/apps/app/src/components/dashboard/pages/posts/notes-panel.tsx:22) fetches `GET /api/posts/${postId}/notes`.
- The same component [PATCHes the same path](/Users/zank/Developer/majestico/relayapi/apps/app/src/components/dashboard/pages/posts/notes-panel.tsx:56).
- The `apps/app/src/pages/api/posts` tree contains handlers for `[id]`, `logs`, `retry`, `unpublish`, `cross-post-actions`, and `bulk`, but there is no `apps/app/src/pages/api/posts/[id]/notes.ts`.
- [apps/api/src/routes/posts.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/routes/posts.ts:3599) defines `getPostNotes`.
- [apps/api/src/routes/posts.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/routes/posts.ts:3623) defines `updatePostNotes`.

## External Confirmation

- Astro’s official routing docs say each file under `src/pages/` becomes an endpoint based on its file path: https://docs.astro.build/en/basics/astro-pages/
- Astro’s endpoint docs show server endpoints are handled by explicit `src/pages/...` files: https://docs.astro.build/en/guides/endpoints/
- RelayAPI’s hosted docs expose the notes endpoint:
  - https://docs.relayapi.dev/api-reference/posts/getPostNotes
  - https://api.relayapi.dev/openapi.json

## Why This Is a Bug

- The notes UI can only hit a 404 from `apps/app`, because the route file does not exist.
- This is not just dead code: the backend contract is live and documented, so the missing app proxy is the broken link.
- Because the dashboard swallows fetch errors, the failure presents as a silent non-working notes panel instead of an obvious crash.

## Recommended Fix

1. Add `apps/app/src/pages/api/posts/[id]/notes.ts` with `GET` and `PATCH` handlers.
2. Extend `packages/sdk/src/resources/posts/posts.ts` with `getNotes(id)` and `updateNotes(id, body)` so the app route can stay SDK-backed.
3. Add a small app-level test or route smoke check to ensure every dashboard fetch target under `/api/posts/*` has a matching Astro endpoint.
