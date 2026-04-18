# F03 - Root workspace globs omit nested integration packages

Severity: medium

## Summary

The root monorepo only declares `apps/*` and `packages/*` as workspaces. Nested integration packages under `packages/integrations/*` are not part of the Bun workspace, so a root `bun install` does not install their dependencies.

## Affected Files

- `package.json:4-19`
- `packages/integrations/n8n-node/package.json`
- `packages/integrations/zapier-app/package.json`

## Local Evidence

- [package.json](/Users/zank/Developer/majestico/relayapi/package.json:4) declares only `"apps/*"` and `"packages/*"`.
- `find packages -maxdepth 3 -name package.json` shows nested packages under `packages/integrations/`.
- After the repo's existing root install, `node_modules/zapier-platform-core` and `node_modules/n8n-workflow` were both missing.
- `bun test` in `packages/integrations/zapier-app` failed because `zapier-platform-core` was not found.
- `bun run build` in `packages/integrations/n8n-node` failed because `n8n-workflow` was not found.

## Official Confirmation

- Bun's workspace docs say `bun install` installs dependencies for all packages matched by the root `"workspaces"` field.
- The same docs show that Bun supports recursive globs such as `"packages/**"` when nested packages exist.

## Why This Is a Bug

- Local root bootstrap leaves integration packages half-installed.
- Local tests and builds for those packages fail even though the package manifests are valid.
- It is easy for developers to assume the repo is fully installed after `bun install` at the root when it is not.

## Recommended Fix

1. Expand the root workspace globs to include nested packages, for example `packages/**` or a narrower explicit pattern such as `packages/integrations/*`.
2. Re-run `bun install` from the repo root and verify that both integration packages can build or test without per-package installs.
3. Consider extending the root `typecheck` or build surface so these packages are not invisible to normal developer verification.

## Note

The publish workflows for these packages currently run `npm install` inside each package, so this is mainly a local developer and repo-bootstrap bug rather than a release-blocker for those workflows.
