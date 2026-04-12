# Docs

This folder is intentionally small.

It exists to capture stable repository-level decisions that are awkward to infer from the codebase at a glance. It is not a place for long audits, competitor analysis, one-off implementation plans, or notes about external tools.

## Source Of Truth

- API surface: `apps/api/src/routes/*`, `apps/api/src/schemas/*`, and the generated OpenAPI spec
- Runtime composition: `apps/api/src/index.ts`
- Repo workflow and guardrails: `AGENTS.md` and `CLAUDE.md`
- SDK surface: `packages/sdk/src/resources/*`

## Files

- `architecture.md` — system model, tenancy, auth, infrastructure, and local development constraints
- `capabilities.md` — supported platforms, connection model, and the major API domains currently present in the codebase

## Guardrails

- Keep this folder to a minimal set of files.
- Prefer deleting stale plans instead of archiving them here.
- Do not add competitor comparisons or references to external tools.
- If behavior changes, update code and OpenAPI first. Update this folder only when the repository-level decision or product surface has changed.
