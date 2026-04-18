# F07 - LinkedIn version pins are duplicated and already drifted from the latest doc version

Severity: low

## Summary

The repo intends to keep third-party API versions centralized, but LinkedIn is pinned to `202603` in the central config and also hardcoded in multiple runtime files. Official docs now list April 2026 (`202604`) as the latest version.

## Affected Files

- `apps/api/src/config/api-versions.ts:22-23`
- `apps/api/src/routes/tools.ts:608-615`
- `apps/api/src/publishers/linkedin.ts:4-6`
- `apps/api/src/services/platform-analytics/linkedin.ts:80-86`

## Local Evidence

- [api-versions.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/config/api-versions.ts:23) sets `linkedin: "202603"`.
- [routes/tools.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/routes/tools.ts:613) hardcodes `"Linkedin-Version": "202603"`.
- [publishers/linkedin.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/publishers/linkedin.ts:5) hardcodes `const LINKEDIN_VERSION = "202603"`.
- [platform-analytics/linkedin.ts](/Users/zank/Developer/majestico/relayapi/apps/api/src/services/platform-analytics/linkedin.ts:84) hardcodes the same value again.

## Official Confirmation

- LinkedIn's versioning docs say every versioned Marketing API request must send a `Linkedin-Version` header in `YYYYMM` format.
- The same doc currently lists April 2026 as the latest documented version (`202604`).

## Why This Is a Bug

- This is a drift bug, not a confirmed outage: `202603` is probably still supported, but the repo's single-source-of-truth rule is already violated.
- When the team eventually bumps the version, the hardcoded copies are easy to miss and can leave different LinkedIn features on different versions.

## Recommended Fix

1. Decide whether to bump LinkedIn to `202604` after validating the affected endpoints.
2. Import the version from `API_VERSIONS.linkedin` everywhere instead of hardcoding it.
3. Add a grep-based or test-based guard that fails if `Linkedin-Version` is duplicated outside the central version config.
