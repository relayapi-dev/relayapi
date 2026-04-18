# F06 - Docs site metadata lacks `metadataBase`

Severity: low to medium
Status: ✅ Fixed

## Summary

The docs app defines relative Open Graph and Twitter image paths in the root metadata export but does not set `metadataBase`. The build completes, but Next warns that it is resolving those URLs against `http://localhost:3000`.

## Affected Files

- `apps/docs/src/app/layout.tsx:9-25`

## Local Evidence

- [apps/docs/src/app/layout.tsx](/Users/zank/Developer/majestico/relayapi/apps/docs/src/app/layout.tsx:9) defines relative metadata values such as `images: ["/og.png"]`.
- `bun run build:next` in `apps/docs` completed with repeated warnings that `metadataBase` is not set and `http://localhost:3000` is being used for social metadata resolution.

## Official Confirmation

- Next.js documents `metadataBase` as the base URL for URL-based metadata fields.
- The same doc says `metadataBase` is typically set in the root layout and relative Open Graph image paths are composed against it.

## Why This Is a Bug

- Social previews can point at a localhost origin during build or produce incorrect absolute URLs for crawlers.
- The issue is already visible in the production build logs, so it is not speculative.

## Recommended Fix

1. Add `metadataBase` to the root metadata export in `apps/docs/src/app/layout.tsx`.
2. Use the canonical docs origin from configuration, for example an env var such as `NEXT_PUBLIC_SITE_URL`, with a safe production default.
3. Re-run `bun run build:next` and ensure the warning disappears.
