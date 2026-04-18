# F11 - API CI only runs a subset of tests, so known failing suites are not enforced

Severity: medium
Status: ✅ Fixed

## Summary

The API CI workflow runs only four named test files. At least two other committed test files fail locally right now, but CI never executes them, so those regressions are invisible to the main gate.

## Affected Files

- `.github/workflows/ci-api.yml:26-31`
- `apps/api/src/__tests__/performance.test.ts`
- `apps/api/src/__tests__/usage-tracking.test.ts`

## Local Evidence

- [ci-api.yml](/Users/zank/Developer/majestico/relayapi/.github/workflows/ci-api.yml:26) runs only:
  - `connect-oauth.test.ts`
  - `unit.test.ts`
  - `auth.test.ts`
  - `publishers.test.ts`
- The repository contains additional committed API tests under `apps/api/src/__tests__/`, including `performance.test.ts` and `usage-tracking.test.ts`.
- Running `bun test src/__tests__/usage-tracking.test.ts src/__tests__/performance.test.ts` in `apps/api` failed during this audit:
  - `usage-tracking.test.ts`: expected bulk usage count `3`, received `1`
  - `performance.test.ts`: runtime import failure for `cloudflare:workers`

## External Confirmation

- GitHub’s workflow docs state that the `run` step executes the command listed in the workflow, nothing more: https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-your-workflow-do/add-scripts
- GitHub’s workflow syntax reference for `run` is: https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions

## Why This Is a Bug

- CI currently gives a false sense of coverage: green does not mean the checked-in test suite is green.
- This is directly relevant to already-documented issues, because the omitted suites are the ones catching the usage-metering and Workers-runtime problems.
- Regressions can accumulate in non-gated test files until someone runs them manually.

## Recommended Fix

1. Decide which API tests are expected to pass in ordinary CI and run all of them by default.
2. If Workers-runtime tests need a separate environment, split them into a dedicated job instead of omitting them entirely.
3. Avoid enumerating only a hand-picked subset of files unless there is a documented allowlist with a clear rationale.
