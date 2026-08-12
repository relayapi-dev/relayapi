# Docs

This folder contains stable repository-level decisions, launch runbooks, and
dated engineering audits whose evidence must remain reviewable. Dated reports
are historical records: their own status banner and the newest verification
report determine whether their action lists are still current.

## Source Of Truth

- API surface: `apps/api/src/routes/*`, `apps/api/src/schemas/*`, and the generated OpenAPI spec
- Runtime composition: `apps/api/src/index.ts`
- Repo workflow and guardrails: `AGENTS.md` and `CLAUDE.md`
- SDK surface: `packages/sdk/src/resources/*`

## Files

- `architecture.md` — system model, tenancy, auth, infrastructure, and local development constraints
- `capabilities.md` — supported platforms, connection model, and the major API domains currently present in the codebase
- `PRODUCTION_LAUNCH_READINESS_2026-07-18.md` — current go/no-go decision, external stop conditions, and protected launch sequence
- `REPOSITORY_SERIOUS_ISSUES_ULTRASCAN_2026-08-02.md` — repository-side closure record and remaining operator-owned database gates
- `RelayAPI_Repository_Unfinished_Features_and_Bugs_Audit_2026-08-08.md` — latest broad feature/defect inventory and remediation baseline

## Guardrails

- Keep normative runbooks concise and distinguish them from dated evidence.
- Mark superseded reports prominently instead of presenting old gate state as current.
- Do not add competitor comparisons or references to external tools.
- If behavior changes, update code and OpenAPI first. Update this folder only when the repository-level decision or product surface has changed.
