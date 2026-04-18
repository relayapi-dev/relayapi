# F01 - LinkedIn organization lookup uses the wrong endpoint and response shape

Severity: high

## Summary

Both LinkedIn organization-selection routes call `https://api.linkedin.com/v2/organizationAcls?q=roleAssignee` and then parse fields that the current official response does not return. That makes organization selection brittle at best and empty or malformed at worst.

## Affected Files

- `apps/api/src/routes/connect.ts:2030-2058`
- `apps/api/src/routes/accounts.ts:988-1014`

## Local Evidence

- [apps/api/src/routes/connect.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/routes/connect.ts:2034) uses `https://api.linkedin.com/v2/organizationAcls?q=roleAssignee` with only `Authorization`.
- [apps/api/src/routes/accounts.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/routes/accounts.ts:992) does the same.
- Both routes map each element as `{ id: String(e.organizationId), name: e.organization }`.
- The current code assumes a numeric `organizationId`, but the official response examples show `organization` or `organizationTarget` URNs instead.

## Official Confirmation

- LinkedIn's Organization Access Control docs show the current finder request as `GET https://api.linkedin.com/rest/organizationAcls?q=roleAssignee` and require both `X-Restli-Protocol-Version: 2.0.0` and `Linkedin-Version: {YYYYMM}`.
- The same doc's sample responses return organization URNs such as `urn:li:organization:1234123` and `organizationTarget`, not `organizationId`.
- LinkedIn's Marketing API versioning docs say versioned Marketing APIs use the `/rest` base path and every versioned call must include a `Linkedin-Version` header.

## Why This Is a Bug

- If LinkedIn rejects the legacy `v2` call, the UI receives an empty organization list.
- If the endpoint still responds, the current parser can produce `id: "undefined"` and `name` values that are just URNs instead of display names.
- The same broken assumption exists in both the OAuth secondary-selection flow and the account settings flow.

## Recommended Fix

1. Switch both routes to `https://api.linkedin.com/rest/organizationAcls?q=roleAssignee`.
2. Send `Linkedin-Version` and `X-Restli-Protocol-Version` headers from shared config.
3. Parse the returned organization URN or `organizationTarget` URN into an organization ID.
4. If the UI needs a readable name, resolve the URN through LinkedIn's organization lookup endpoint instead of treating the ACL payload as a name source.
5. Add tests that use the current documented response shape, not the old `organizationId` assumption.
