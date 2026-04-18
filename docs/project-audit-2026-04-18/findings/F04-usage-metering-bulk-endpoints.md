# F04 - Usage metering undercounts non-`/bulk` multi-item endpoints

Severity: medium
Status: ✅ Fixed

## Summary

The usage middleware says bulk endpoints should cost one unit per item, but the implementation only looks for `POST` paths ending in `/bulk` and only counts `body.posts`. Several other multi-item endpoints are currently billed as one call.

## Affected Files

- `apps/api/src/middleware/usage-tracking.ts:157-166`
- `apps/api/src/routes/posts.ts:276-290`
- `apps/api/src/routes/posts.ts:2904-2915`
- `apps/api/src/routes/whatsapp.ts:86-95`
- `apps/api/src/routes/contacts.ts:258-285`
- `apps/api/src/routes/inbox-feed.ts:181-190`

## Local Evidence

- [usage-tracking.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/middleware/usage-tracking.ts:157) only increments `units` above `1` when the request path ends with `/bulk`.
- The same block only reads `parsedBody.posts`.
- [posts bulk CSV](/Users/zank/Developer/majestico/relayapi/apps/api/src/routes/posts.ts:2907) is `POST /bulk-csv` and is multipart, so it can never be counted through `parsedBody.posts`.
- [WhatsApp bulk send](/Users/zank/Developer/majestico/relayapi/apps/api/src/routes/whatsapp.ts:89) is `POST /bulk-send` and uses `recipients`.
- [Contacts bulk operations](/Users/zank/Developer/majestico/relayapi/apps/api/src/routes/contacts.ts:280) is `POST /bulk-operations` and uses `contact_ids`.

## External Confirmation

- RelayAPI's hosted OpenAPI spec currently publishes multiple public multi-item endpoints with distinct payload shapes:
  - `POST /v1/posts/bulk` with `posts`
  - `POST /v1/whatsapp/bulk-send` with `recipients`
  - `POST /v1/contacts/bulk-operations` with `contact_ids`
  - `POST /v1/inbox/bulk` with `targets`
  - `POST /v1/posts/bulk-csv` as a separate bulk upload path
  Source: https://api.relayapi.dev/openapi.json
- The billing rule itself is project-specific, but the live public contract confirms that the current middleware's `/bulk` plus `body.posts` heuristic does not cover all documented bulk-style endpoints.

## Why This Is a Bug

- If the intended contract is "one unit per item for bulk endpoints", only a subset of bulk endpoints are metered correctly.
- `bulk-csv` is especially risky because a large import can still bill as a single request.
- The current logic is also tightly coupled to prior body parsing, which is why the dedicated usage test currently fails when mounted without the body-cache middleware.

## Recommended Fix

1. Replace the suffix check with an explicit meter map keyed by route shape and payload field, for example:
   - `/v1/posts/bulk` -> `posts.length`
   - `/v1/whatsapp/bulk-send` -> `recipients.length`
   - `/v1/contacts/bulk-operations` -> `contact_ids.length`
2. For multipart CSV uploads, meter after parsing the file so the actual row count is known.
3. Add focused tests for every multi-item endpoint instead of assuming `/bulk` plus `posts`.
