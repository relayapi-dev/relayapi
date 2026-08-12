**FULL-TREE ENGINEERING REVIEW**

# Repository Unfinished Features & Bug Map

*RelayAPI monorepo  |  Evidence captured 8 August 2026*

| **Audit attribute** | **Value** |
| --- | --- |
| **Audit baseline** | b4f3c349 — feat: harden platform and expand API capabilities |
| **Repository state** | main aligned with origin/main and ahead by 3 local commits; clean before this report was generated |
| **Review mode** | Full-tree inventory, targeted static analysis, historical-report reconciliation, tests, type checks, builds, and four concurrent reviewers (the session limit) |

> **Bottom line** The repository's broad automated quality gates are green, and the 20 serious items in the 3 August remediation report remain closed in source. The product is still not ready for public production traffic: this wider scan confirms 23 current defects (8 High), 18 explicit unfinished or gated capabilities, and 5 design risks. The most urgent work is entitlement correctness, self-host deployment safety, public API truthfulness, and the remaining pre-live environment gates.

| **confirmed defects** | **High severity** | **unfinished / gated items** | **tests passed** |
| --- | --- | --- | --- |
| **23** | **8** | **18** | **2,938** |

## 1. Executive conclusion

**Repository health:** strong automated baseline, incomplete production readiness.

The earlier whole-repository report closed its complete ledger of 20 serious repository-side findings and deterministic gates. This review does not reopen those remediations. It expands the scope into product truth surfaces, self-host operator safety, entitlement edge cases, accessibility, and explicit v1.1 deferrals. That broader lens found material new work.

- No Critical defect was confirmed in the current tree. No demonstrated cross-tenant escape, credential leak, provider double-mutation, or Cloudflare binding mismatch surfaced.

- Eight High defects require action before public launch: one entitlement bug, three self-host safety failures, and four public contract/pricing documentation failures.

- The current production launch record remains NO-GO, and a VPC resource field plus live PostgreSQL 18 acceptance remain concretely incomplete.

- The local quality signal is unusually strong: 2,938 tests passed, all workspace type checks passed, app and Workerd builds/tests passed, and OpenAPI/docs contract generation matched 432 operations across 56 tags.

- Passing tests do not cover the most important new findings: self-host failure transitions, marketing examples, the free-organization quota query, or live provider/database acceptance.

### Recommended remediation order

| **Priority** | **Workstream** | **Required outcome** |
| --- | --- | --- |
| **P0** | **Protect users and operators** | Fix B01 and B03-B05 first. These can mis-enforce billing or deploy/overwrite the wrong state. |
| **P0** | **Make the public contract truthful** | Correct B10-B13 and keep signup gated until the acquisition path and product claims match shipped behavior. |
| **P0** | **Close release gates** | Complete F02-F05: pre-live database recreation, PostgreSQL 18 acceptance, VPC/runtime-role verification, backup/restore, canaries, and approval. |
| **P1** | **Harden correctness and docs** | Fix B02, B06-B08, B14-B17, B19-B20, and B23; add focused tests at each boundary. |
| **P2** | **Finish product polish** | Address remaining Low defects, automation pickers, MCP HTTP, navigation, testimonials, CLI breadth, traces, and architecture deferrals. |

## 2. Scope, method, and confidence

- Inventory covered 2,567 tracked and untracked-visible repository files across apps, packages, docs, scripts, workflows, configuration, and generated contracts. Dependency directories and build output were excluded from source-marker analysis.

- Four concurrent reviewers were used because four is the session concurrency limit; the requested 1,000-agent fan-out is not available. Work was split across API/Workers, data/auth/self-host/operations, and product/docs/SDK/CLI/integrations, with the primary reviewer reconciling evidence.

- The 3 August serious-issue report, July launch-readiness record, schema audit, and June performance remediation record were compared with current source. Historical statements were not carried forward unless revalidated.

- Confirmed means current source directly demonstrates the behavior or mismatch. Unfinished means the code/docs explicitly defer, disable, omit, or gate the capability. Risk means the design is exposed but no failing execution was reproduced in this review.

- This is a high-confidence engineering audit, not a formal security certification. No production mutation, provider call, database recreation, secret operation, deployment, or destructive command was performed.

> **Important reconciliation** The prior report's statement that all 20 tracked serious repository issues were remediated is still supported. The 23 defects below are newly identified or outside that report's final ledger; they are not a claim that its fixes regressed.

## 3. Confirmed defect register

| **ID** | **Severity** | **Area** | **Finding** |
| --- | --- | --- | --- |
| **B01** | **High** | **Identity / billing** | Free-organization quota misclassifies owners and paid-equivalent organizations |
| **B02** | **Medium** | **Billing notifications** | Compound-role owners can miss dunning email |
| **B03** | **High** | **Self-host releases** | Self-host deployment can silently ignore the release lock |
| **B04** | **High** | **Self-host releases** | Worker rollout is non-atomic and lacks failed-smoke rollback |
| **B05** | **High** | **Self-host initialization** | self-host init destructively overwrites existing repository files |
| **B06** | **Medium** | **Self-host updates** | Generated updater can propose a downgrade |
| **B07** | **Medium** | **Self-host updates** | A stable release lock accepts prerelease versions |
| **B08** | **Medium** | **Cloudflare provisioning** | Self-host resource discovery ignores pagination |
| **B09** | **Low** | **Self-host cleanup** | Downloaded release trees are never removed |
| **B10** | **High** | **Marketing / API contract** | Webhooks product page advertises unsupported APIs and tooling |
| **B11** | **High** | **Marketing / API contract** | Analytics page uses nonexistent endpoints and overstates behavior |
| **B12** | **High** | **Pricing / entitlements** | Pricing copy contradicts enforced entitlements |
| **B13** | **High** | **Developer documentation** | Cross-post Actions guide does not match the SDK or API |
| **B14** | **Medium** | **AI documentation** | LLM markdown can select the wrong OpenAPI operation |
| **B15** | **Medium** | **Docs build reproducibility** | Documentation builds depend on the live production OpenAPI |
| **B16** | **Medium** | **Accessibility** | Closed docs feedback popup remains keyboard-focusable |
| **B17** | **Medium** | **Accessibility** | Dashboard contains recurring unlabeled icon-only buttons |
| **B18** | **Low** | **Docs UX** | Docs copy action mishandles transient fetch failures |
| **B19** | **Medium** | **Post templates** | Documented account_name template variable is not resolved |
| **B20** | **Medium** | **Post creation** | Invalid template or idea references can silently create empty-content posts |
| **B21** | **Low** | **Developer documentation** | Signature guide says implemented behavior is coming soon |
| **B22** | **Low** | **LinkedIn publishing** | LinkedIn disable_link_preview input is silently ignored |
| **B23** | **Medium** | **Inbound automation** | WhatsApp file-size caps have a known enforcement blind spot |

## 4. Detailed defect evidence

### Identity and billing

#### B01 — Free-organization quota misclassifies owners and paid-equivalent organizations  **[High]**

**Impact:** A compound-role owner such as owner,admin is omitted from the owned-organization count, so the two-free-organization cap can be bypassed. Conversely, valid trialing and past-due-with-grace organizations are counted as free even though the runtime entitlement policy treats them as Pro, so legitimate users can be blocked.

**Evidence:** packages/db/src/queries.ts:5-31; packages/auth/src/index.ts:292-329; packages/config/src/index.ts:41-48 and 316-393; apps/api/src/middleware/permissions.ts:83-110

**Recommended fix:** Tokenize roles through the shared role predicate and derive paid/free state from the canonical billing policy. Add focused tests for compound roles, complimentary plans, trials, grace periods, and concurrent reservations.

#### B02 — Compound-role owners can miss dunning email  **[Medium]**

**Impact:** The dunning recipient lookup requires the exact role string owner. An organization whose owner has a compound role can receive no billing warning even while the dunning workflow otherwise succeeds.

**Evidence:** apps/api/src/services/dunning.ts:807-817; packages/config/src/index.ts:41-48

**Recommended fix:** Use the shared token-aware role predicate and add a regression test for a compound-role owner.

### Self-host operator safety

#### B03 — Self-host deployment can silently ignore the release lock  **[High]**

**Impact:** When invoked from any directory that looks like the RelayAPI monorepo, source resolution deploys that checkout without proving it matches the locked release, tag, commit, or cleanliness state. Arbitrary main or dirty code can therefore be presented as the locked stable version.

**Evidence:** packages/self-host/src/types.ts:41-47; packages/self-host/src/source.ts:21-34; packages/self-host/README.md:18-25 and 185-189

**Recommended fix:** Resolve the lock by default. Permit local source only through an explicit override with a clear acknowledgement, and verify commit/tag/digest plus dirty state before deployment.

#### B04 — Worker rollout is non-atomic and lacks failed-smoke rollback  **[High]**

**Impact:** The CLI deploys Worker code before bulk secrets, then deploys and probes the API before doing the same for the dashboard. A first install can expose code without required secrets; an upgrade can expose new code with old secrets. A failed probe leaves the new API active or leaves mixed API/dashboard versions.

**Evidence:** packages/self-host/src/deploy.ts:248-264 and 388-411

**Recommended fix:** Stage complete versions with secrets, capture previous version IDs, promote only after preview/smoke validation, and implement a defined rollback or forward-repair path.

#### B05 — self-host init destructively overwrites existing repository files  **[High]**

**Impact:** Initialization checks only the selected config file, then unconditionally replaces two workflows, .env.example, and .gitignore. In an existing operator repository this can erase unrelated ignore rules and make previously ignored secrets or artifacts trackable.

**Evidence:** packages/self-host/src/index.ts:143-219; packages/self-host/src/scaffold.ts:117-187, especially 129-132

**Recommended fix:** Fail on conflicts by default, merge and deduplicate ignore entries, create generated files exclusively, and require an explicit force option with backups for replacement.

#### B06 — Generated updater can propose a downgrade  **[Medium]**

**Impact:** The generated workflow updates whenever latest differs from current rather than only when latest is newer. A manually ahead lock, alternate repository, or removed release can therefore produce a downgrade PR, which is unsafe with forward-only migrations.

**Evidence:** packages/self-host/src/scaffold.ts:82-93; packages/self-host/src/upgrade.ts:28-40

**Recommended fix:** Share one semantic-version comparator between the direct CLI and generated workflow, and update only when the candidate is strictly newer.

#### B07 — A stable release lock accepts prerelease versions  **[Medium]**

**Impact:** The lock requires channel stable but accepts versions such as 1.2.3-beta, while the custom comparator is not prerelease-aware. This weakens the stable-channel guarantee and can produce incorrect ordering.

**Evidence:** packages/self-host/src/config.ts:199-220; packages/self-host/src/scaffold.ts:43-51; packages/self-host/src/upgrade.ts:49-56

**Recommended fix:** Require strict x.y.z for stable locks or adopt one standards-compliant semver implementation everywhere.

#### B08 — Self-host resource discovery ignores pagination  **[Medium]**

**Impact:** KV, R2, Queue, and Hyperdrive discovery reads a single page. On a busy account, a canonical resource beyond that page can be missed, causing false drift, missed name collisions, or attempted duplicate creation.

**Evidence:** packages/self-host/src/cloudflare.ts:426-451 and 502-571; contrast apps/api/scripts/verify-cloudflare-production.ts:1170-1182, which exhausts Queue pages

**Recommended fix:** Exhaust page/cursor results for every resource type and prefer pinned immutable IDs once resources are reconciled.

#### B09 — Downloaded release trees are never removed  **[Low]**

**Impact:** A local deploy downloads and extracts a release, installs dependencies, and marks the source temporary, but the deployment path never uses that flag or removes the directory. Repeated deployments can consume substantial temporary storage.

**Evidence:** packages/self-host/src/source.ts:36-67; packages/self-host/src/deploy.ts:328-414

**Recommended fix:** Wrap the deployment in finally and remove temporary source roots after completion or failure.

### Public product and developer contract

#### B10 — Webhooks product page advertises unsupported APIs and tooling  **[High]**

**Impact:** The public product surface promises unsupported event types and wildcards, a caller-provided secret, batching, 30-day replay, SDK signature helpers, and a relayapi webhooks listen command. Copied examples fail validation or reference functionality that does not exist.

**Evidence:** apps/app/src/lib/api-data.ts:522, 552, 564, 584-594 and 667-692; packages/sdk/src/resources/webhooks.ts:62-109 and 255-290; apps/cli/src/index.ts:18-21

**Recommended fix:** Generate marketing examples from the pinned OpenAPI/SDK contract, add compile-and-contract tests for snippets, and separately roadmap any desired capabilities.

#### B11 — Analytics page uses nonexistent endpoints and overstates behavior  **[High]**

**Impact:** Examples call four paths absent from the pinned OpenAPI and promise retention, export, scheduled delivery, and refresh behavior not represented by the current API. Users following the examples receive 404 responses.

**Evidence:** apps/app/src/lib/api-data.ts:380-395, 419, 437, 461 and 486-501; apps/docs/openapi.json has no /v1/analytics/posts/{id}, /accounts, /overview, or /export paths

**Recommended fix:** Derive endpoint examples and capability copy from the pinned contract and gate future-facing copy behind explicit roadmap labels.

#### B12 — Pricing copy contradicts enforced entitlements  **[High]**

**Impact:** The pricing page says analytics and comments are always included while its own free-plan list excludes them and the dashboard enforces Pro gates. This creates a direct commercial and support mismatch.

**Evidence:** apps/app/src/pages/pricing.astro:10-19, 106 and 132-134; apps/app/src/components/dashboard/pages/analytics-page-new.tsx:184-185 and 242-255; inbox-comments-page.tsx:43 and 115-130

**Recommended fix:** Choose one entitlement policy, encode it in a shared product-plan source, and render both pricing copy and UI gates from that source.

#### B13 — Cross-post Actions guide does not match the SDK or API  **[High]**

**Impact:** The guide documents client.posts.crossPostActions, a get method, and a nested cancel route. The SDK exposes client.crossPostActions.listByPost() and cancel(), and no GET-by-ID endpoint exists. TypeScript examples fail and documented HTTP paths can return 404.

**Evidence:** apps/docs/content/docs/guides/cross-post-actions.mdx:107-121; packages/sdk/src/resources/cross-post-actions.ts:7-27

**Recommended fix:** Correct the guide and add compile-tested examples plus an OpenAPI path assertion in docs CI.

#### B14 — LLM markdown can select the wrong OpenAPI operation  **[Medium]**

**Impact:** The generator matches an operation only by its non-unique summary. Both idea-comment and inbox-comment deletion pages are titled Delete a comment, so generated markdown can describe the wrong endpoint.

**Evidence:** apps/docs/src/lib/llm-text.ts:18-31; apps/docs/content/docs/api-reference/ideas/deleteIdeaComment.mdx:2; apps/docs/content/docs/api-reference/inbox/deleteComment.mdx:2

**Recommended fix:** Carry operationId or an exact method/path key through generation and fail on duplicate or unresolved mappings.

#### B15 — Documentation builds depend on the live production OpenAPI  **[Medium]**

**Impact:** Static LLM routes fetch production without a status check or timeout even though docs generation has a pinned local specification. Builds are non-reproducible, cannot reliably run offline, and can mix live and pinned contracts.

**Evidence:** apps/docs/src/lib/llm-text.ts:1-7; apps/docs/src/lib/openapi.ts:3-8; apps/docs/src/app/llms.mdx/[[...slug]]/route.ts:21-46; apps/docs/src/app/llms-full.txt/route.ts:6-28

**Recommended fix:** Use the pinned local JSON for static generation. If a network fallback remains, add a bounded timeout, status/schema validation, and explicit drift reporting.

#### B18 — Docs copy action mishandles transient fetch failures  **[Low]**

**Impact:** The page action does not check response.ok and permanently caches a rejected promise, so one transient failure can leave copying broken for the lifetime of the page.

**Evidence:** apps/docs/src/components/ai/page-actions.tsx:25-40 and 64-70

**Recommended fix:** Validate HTTP status, surface a useful error, and clear failed cache entries so a later attempt can recover.

#### B21 — Signature guide says implemented behavior is coming soon  **[Low]**

**Impact:** The guide discourages use of server-side signature injection and skip_signature even though both are implemented in the API and SDK.

**Evidence:** apps/docs/content/docs/guides/signatures.mdx:55-57; apps/api/src/routes/posts.ts:1820-1842; apps/api/src/schemas/posts.ts:177-182; packages/sdk/src/resources/posts/posts.ts:1528-1530

**Recommended fix:** Update the guide from the pinned schema and add a docs freshness check for roadmap language attached to shipped fields.

### Accessibility and dashboard UX

#### B16 — Closed docs feedback popup remains keyboard-focusable  **[Medium]**

**Impact:** The popup is hidden only with opacity, scale, and pointer-events. Interactive descendants remain in the tab order, and the surface lacks dialog semantics, Escape handling, focus containment, and focus return.

**Evidence:** apps/docs/src/components/feedback-widget.tsx:51-183

**Recommended fix:** Unmount the closed surface or apply hidden/inert, then use an accessible dialog pattern with focus management and Escape support.

#### B17 — Dashboard contains recurring unlabeled icon-only buttons  **[Medium]**

**Impact:** Several common actions expose no accessible name, so screen readers announce unnamed buttons and users cannot determine the action reliably.

**Evidence:** apps/app/src/components/dashboard/pages/team-page.tsx:360-369; sent-post-card.tsx:342-346; queue-post-card.tsx:404-408; comment-actions.tsx:137-141; post-detail-modal.tsx:301-306

**Recommended fix:** Add meaningful aria-label values or visually hidden labels and introduce an accessibility assertion for icon-only controls.

### Publishing and automation correctness

#### B19 — Documented account_name template variable is not resolved  **[Medium]**

**Impact:** The public schema and guide call account_name a built-in variable, but create-post resolution replaces only date and caller-supplied values. Templates can publish the literal {{account_name}} token.

**Evidence:** apps/api/src/schemas/posts.ts:159-176; apps/docs/content/docs/guides/content-templates.mdx:33-42; apps/api/src/routes/posts.ts:1778-1796

**Recommended fix:** Resolve the variable at the correct per-account stage, or remove it from the contract if multi-target semantics are not defined. Add end-to-end template tests.

#### B20 — Invalid template or idea references can silently create empty-content posts  **[Medium]**

**Impact:** A missing template or idea produces no not-found error; template database errors are swallowed. The route can continue and insert a nullable content value, deferring failure or creating an unintended post instead of rejecting the request.

**Evidence:** apps/api/src/routes/posts.ts:1762-1800, 1803-1817 and 1969-1984; apps/api/src/schemas/posts.ts:118-183

**Recommended fix:** Reject missing references, distinguish dependency failures from optional enrichment, and validate effective content/media after source resolution and before insertion.

#### B22 — LinkedIn disable_link_preview input is silently ignored  **[Low]**

**Impact:** A caller can request link-preview suppression, but the publisher treats the option as a no-op. The request succeeds without honoring or warning about the caller's intent.

**Evidence:** apps/api/src/publishers/linkedin.ts:747-749

**Recommended fix:** Reject or omit the field for LinkedIn, or return a target-level warning that the provider cannot honor it.

#### B23 — WhatsApp file-size caps have a known enforcement blind spot  **[Medium]**

**Impact:** WhatsApp webhooks omit attachment size, making the user_input_file cap a no-op unless a later materialization step fetches the media and enforces a bound. Oversized content can therefore pass the trigger-level check.

**Evidence:** apps/api/src/services/inbox-event-processor.ts:1905-1910

**Recommended fix:** Enforce a bounded streaming/download limit when the media object is materialized, record the measured size, and route oversize input through the configured validation outcome.

## 5. Unfinished features and release gates

**These items are explicit gaps or gates, not necessarily defects.** They should be tracked separately so feature work does not obscure correctness fixes and release prerequisites.

| **ID** | **Priority** | **Area** | **Open capability / gate** | **Evidence** |
| --- | --- | --- | --- | --- |
| **F01** | **High** | **Public acquisition** | Signup is hard-disabled while landing and pricing CTAs still send users to /signup. | apps/app/src/components/auth/signup-form.tsx:12 and 95-117; landing/data.ts:373-376; pricing.astro:212-215 and 330-345 |
| **F02** | **High** | **Database cutover** | The sealed baseline still requires recreation and initialization of the disposable pre-live database before deployment. | docs/REPOSITORY_SERIOUS_ISSUES_ULTRASCAN_2026-08-02.md:5-15 and 44-56 |
| **F03** | **High** | **Database acceptance** | The PostgreSQL 18 baseline replay/catalog comparison and 46 database-backed race fixtures remain unrun. | docs/REPOSITORY_SERIOUS_ISSUES_ULTRASCAN_2026-08-02.md:56-64 and 144-150 |
| **F04** | **High** | **Production network** | The production resource manifest has no Hyperdrive VPC service ID, and the verifier intentionally rejects that state. | apps/api/production-resources.json:9-11; apps/api/scripts/verify-cloudflare-production.ts:442-465 |
| **F05** | **High** | **Launch operations** | The current launch record remains NO-GO pending environment verification: credentials and secrets, zone HTTPS, private database/runtime role, backup/restore rehearsal, load/provider canaries, and explicit approval. | docs/PRODUCTION_LAUNCH_READINESS_2026-07-18.md:3-15, 91-237 and 302-308 |
| **F06** | **Medium** | **MCP** | Streamable HTTP transport is explicitly unimplemented; the package supports stdio only. | packages/mcp/src/index.ts:7-31; packages/mcp/README.md:68-72 |
| **F07** | **Medium** | **Automation builder** | The message composer still requires a pasted public URL; media-library selection and upload are deferred. | apps/app/src/components/dashboard/automation/flow-builder/message-composer/block-editors.tsx:165-184 |
| **F08** | **Medium** | **Automation builder** | Subscription actions require a raw list ID; the dedicated list picker is deferred to v1.1. | apps/app/src/components/dashboard/automation/flow-builder/action-editor/action-forms/subscription.tsx:27-43 |
| **F09** | **Medium** | **Automation runtime** | Run context is hydrated only at enrollment and intentionally not refreshed on resume, so long-running flows can evaluate stale contact, tag, or custom-field state. | apps/api/src/services/automations/runner.ts:2099-2112 |
| **F10** | **Medium** | **Ads** | Meta targeting rejects cities, radius, languages, and platform_specific targeting even though they exist in the generic targeting model. | apps/api/src/services/ad-platforms/meta.ts:175-192 |
| **F11** | **Medium** | **Marketing navigation** | All blog cards and many footer items are dead # links rather than destinations or disabled roadmap labels. | apps/app/src/components/landing/BlogHighlights.astro:15-18; LandingFooter.astro:58-79 |
| **F12** | **Medium** | **Marketing trust** | Public testimonials are explicitly playful placeholders using fictional or public figures and are rendered on the landing page. | apps/app/src/components/landing/data.ts:1-4 and 205-248; TestimonialWall.astro:23-48 |
| **F13** | **Medium** | **Product positioning** | The hero reaches 21 by counting account/content variants, while pricing lists 17 names even though the repository has a broader 21-platform capability set. | apps/app/src/components/landing/data.ts:50-79; apps/app/src/pages/pricing.astro:72-74; README.md:31 |
| **F14** | **Medium** | **CLI** | The CLI covers auth, accounts, media, and posts only; most API resources have no CLI command surface. | apps/cli/src/index.ts:18-21 |
| **F15** | **Low** | **Generated SDK** | Generated internals retain TODOs for Cloudflare runtime detection, nested upload formats, and async upload chunk validation. | packages/sdk/src/internal/detect-platform.ts:107; uploads.ts:167; to-file.ts:136 |
| **F16** | **Medium** | **Architecture** | Tracked performance deferrals remain: a dedicated webhook queue, Worker decomposition, Durable Object counters, optional Hyperdrive caching, and streaming large uploads. | docs/performance-audit-2026-06/remediation-status.md:181-196 |
| **F17** | **Medium** | **Dependencies** | Dependency review is green only through 172 accepted exception paths covering 75 advisories; all exceptions expire on 2026-09-02. | scripts/dependency-audit-exceptions.json; docs/REPOSITORY_SERIOUS_ISSUES_ULTRASCAN_2026-08-02.md:62-64 |
| **F18** | **Low** | **Observability** | Worker logs are sampled, but distributed traces are disabled in the production config. | apps/api/wrangler.jsonc:55-68 |

### Feature-map interpretation

- F01-F05 are launch blockers or operational gates. They should have named owners, evidence requirements, and stop/go criteria rather than ordinary backlog status.

- F06-F10 are product capabilities with known scope limits. API schemas and marketing copy should expose those limits explicitly until implementation is complete.

- F11-F15 are product-polish and distribution gaps. They are visible to prospects and developers even though core API tests remain green.

- F16-F18 are tracked architecture, dependency, and observability debt. They should remain measurement-driven and must not be presented as current incidents.

## 6. Design and maintenance risks

| **ID** | **Risk** | **Why it matters** | **Evidence** |
| --- | --- | --- | --- |
| **R01** | **Supply-chain reproducibility** | The self-host lock has no commit or archive digest. Downloaded tag archives are not verified, so repeated deployments cannot prove byte identity. | packages/self-host/src/types.ts:41-47; packages/self-host/src/source.ts:36-51 |
| **R02** | **Network containment** | Self-host source, GitHub release, and Cloudflare calls have no explicit timeout; the archive download also has no response-size bound. | packages/self-host/src/source.ts:40-48; upgrade.ts:14-27; cloudflare.ts:358-396 |
| **R03** | **Documentation state** | The July schema audit still describes a pending generation collapse that the August report says is complete, and docs/README says the directory excludes long audits despite many being present. | docs/SCHEMA_OPTIMALITY_AUDIT_PRE_FREEZE_2026-07-27.md:1690-1769 and 2054-2065; docs/README.md:3-18 |
| **R04** | **Type-safety debt** | Lint passes with 44 warnings and two informational findings, including non-null assertions and repeated style/type-safety warnings. These are not current failures but enlarge the future regression surface. | Representative warnings: apps/api/src/lib/r2-presign.ts:286-287; apps/api/src/routes/workspaces.ts:269-272 |
| **R05** | **Coverage concentration** | The suite is broad, but no focused test covers the free-organization quota query, marketing snippets are not contract-compiled, and live provider/database acceptance is intentionally outside the local run. | packages/db/src/queries.ts:18-31; docs/REPOSITORY_SERIOUS_ISSUES_ULTRASCAN_2026-08-02.md:150 |

## 7. Validation ledger

**Automated result:** 2,938 passed tests, zero observed test failures, and 46 intentionally skipped database-backed cases. The docs production build was inconclusive and is not counted as a pass.

| **Check** | **Result** | **Evidence / count** |
| --- | --- | --- |
| **Repository TypeScript** | **PASS** | All configured workspaces: db, auth, SDK, MCP, API, app, docs, CLI, self-host, n8n, Zapier |
| **Biome lint** | **PASS with debt** | 0 errors; 44 warnings; 2 informational findings |
| **API isolated suite** | **PASS** | 2,027 passed; 46 database-backed cases skipped |
| **Workerd integration** | **PASS** | 20 passed after allowing the local loopback listener |
| **Dashboard** | **PASS** | 302 tests; production build passed |
| **Database** | **PASS** | 320 tests; 24,691 assertions |
| **Auth** | **PASS** | 30 tests |
| **Self-host** | **PASS** | 84 tests |
| **Root scripts** | **PASS** | 122 tests |
| **SDK / CLI / MCP** | **PASS** | 14 / 2 / 2 tests |
| **n8n / Zapier** | **PASS** | 1 / 14 tests and builds |
| **OpenAPI / docs contract** | **PASS** | 432 operations across 56 tags |
| **Docs production build** | **INCONCLUSIVE** | Remained at optimized build; stopped with exit 130. The live OpenAPI dependency is a credible but unproven cause. |

### What was not validated

- No live PostgreSQL 18 replay, catalog comparison, or 46-case database race suite; the required tunnel and database environment were unavailable.

- No production Cloudflare deployment, DNS/TLS mutation, secret rotation, VPC attachment, backup/restore exercise, or production smoke test.

- No live social-provider mutation or paid-ad spend; platform behavior was reviewed through code and existing tests only.

- The docs production build was stopped after it remained at Next.js optimized-build output. This is an unresolved validation gap, not proof of a compiler failure or proof that B15 caused the stall.

## 8. Current repository and report status

| **Record** | **Current status** | **Interpretation** |
| --- | --- | --- |
| **3 Aug serious-issue remediation** | **Repository work closed** | All 20 tracked items are recorded as remediated; retain the operator database recreation gate. |
| **18 Jul production launch readiness** | **NO-GO** | Still the current environment launch record until an evidence-backed replacement is approved. |
| **27 Jul schema optimality audit** | **Partly stale** | Its pending generation-collapse narrative is superseded by the sealed generation-1 baseline and should be marked historical. |
| **June performance remediation** | **Implemented + deferred** | Core remediation is complete; five architecture items remain explicit, measurement-driven deferrals. |
| **This 8 Aug full-tree audit** | **Current engineering backlog map** | Adds product-contract, self-host, entitlement, accessibility, and unfinished-feature coverage. |

## 9. Definition of done

1. All eight High defects have regression tests and are closed or explicitly accepted by a named owner with expiry and compensating controls.

1. Public marketing, pricing, docs examples, SDK, and OpenAPI are generated or contract-checked from shared sources; no copied example references an absent endpoint or method.

1. Self-host init is non-destructive, deployment is lock-verifiable and rollback-capable, secrets and code are staged atomically, and resource discovery is pagination-safe.

1. The disposable pre-live database is recreated from the sealed baseline; PostgreSQL 18 replay/catalog comparison and all 46 database fixtures pass with retained evidence.

1. Production VPC/runtime-role, secrets, HTTPS, backup/restore, load tests, provider canaries, and explicit go-live approval are verified in a superseding launch record.

1. Intentional gaps have honest capability labels, owners, priorities, and tests for rejection/warning behavior until implementation is complete.

## 10. Audit handoff

**Suggested first ticket bundle** Bundle B01-B02 as role/entitlement authority; B03-B09 as self-host release safety; B10-B15 and B19-B21 as contract truth; B16-B18 as accessibility/docs UX; and B22-B23 as provider-specific enforcement. Keep F02-F05 in a separate release-readiness epic with evidence attachments and explicit stop/go review.

*End of report*

## 11. Remediation addendum — 8 August 2026

**Outcome.** The full-tree audit above remains the discovery snapshot. The current working tree implements every confirmed defect B01–B23, closes or truthfully reclassifies most unfinished product items, and adds regression coverage for seven defects uncovered during integration review. No production infrastructure was mutated.

**Repository state.** Upstream was checked with a fast-forward-only pull and was already current. The audit baseline is commit 27ada25f. The remediation remains an uncommitted working-tree change because repository policy permits agents to run only read-only Git commands.

### 11.1 Confirmed-defect disposition

| **IDs** | **Status** | **Implemented result** |
| --- | --- | --- |
| B01–B02 | Closed | Owner-role tokenization, canonical paid-equivalent quota policy, and compound-owner dunning selection; focused DB/API tests. |
| B03 | Closed | Self-host deploys resolve and verify a sealed release archive; local source requires an explicit acknowledged override. |
| B04 | Closed | Worker code, bindings, and secrets are staged as inspected versions before traffic; failure yields defined forward-repair and guarded rollback instructions. |
| B05–B09 | Closed | Collision-safe init/backups, strict stable semver and no downgrade, paginated Cloudflare discovery, bounded downloads, and temporary-tree cleanup. |
| B10–B13 | Closed | Marketing, pricing, webhook/analytics examples, and cross-post documentation now match the shipped API/SDK contract. |
| B14–B18 | Closed | Pinned operation-ID docs generation, offline builds, accessible feedback dialog and icon buttons, and retryable copy cache. |
| B19–B20 | Closed | Template variables and per-target overrides are rendered consistently; bad idea/template references fail and effective content is validated. |
| B21–B23 | Closed | Signature copy corrected, LinkedIn link-preview behavior implemented, and WhatsApp file caps fail closed on authoritative metadata. |

### 11.2 Integration defects found and closed

| **ID** | **Severity** | **Finding** | **Disposition** |
| --- | --- | --- | --- |
| B24 | High | Bearer-invite signup authority could change between validation and claim. | Closed: the Better Auth transaction now locks and revalidates user, membership, tenant, principal, selected workspaces, and token CAS; race and rollback tests added. |
| B25 | High | A legacy workspace-scoped content template could be rendered from another authorized workspace. | Closed: workspace scope is asserted after lookup and before rendering; organization-global templates remain shared. |
| B26 | High | ID-anchor cursors were not consistently fenced to tenant, workspace, parent, and active filters. | Closed across 19 routes; malformed or out-of-scope anchors return INVALID_CURSOR (400). |
| B27 | Medium | Timestamp-only cursors could skip or duplicate equal-time rows and accepted malformed cursors. | Closed with precision-preserving (timestamp, id) keysets and strict decoding, including globally unique merged-inbox tie IDs. |
| B28 | High | A one-shot BYOS ReadableStream could be retried after partial consumption. | Closed: streaming PUTs have zero automatic retries; replayable bodies retain bounded retries. |
| B29 | High | Omitted optional secrets persisted in Cloudflare Worker versions. | Closed: stale secret names are staged for deletion, the exact candidate secret set and configuration digest are re-inspected, then traffic is promoted. |
| B30 | Medium | GitHub scaffold initialization could act inside an existing Git repository. | Closed: --github refuses existing repositories and non-empty/non-directory targets before writes, including with force. |

### 11.3 Unfinished-feature disposition

| **IDs** | **Status** | **Current interpretation** |
| --- | --- | --- |
| F01 | Closed / explicit posture | Hosted access is honestly invite-only; public CTAs request early access, while valid bearer invitations support transactional signup. |
| F06–F10 | Closed | Streamable HTTP MCP, automation media and subscription pickers, resume-time context refresh, and supported Meta targeting are implemented. |
| F11–F13 | Closed | Dead navigation, fictional testimonials, and platform-count positioning were replaced with truthful product content. |
| F15 | Closed | SDK runtime detection, nested multipart formats, async chunks, and one-shot retry behavior are hardened and tested. |
| F18 | Closed | Production API, dashboard, and self-host configurations enable sampled distributed traces. |
| F02–F05 | External launch gates | Disposable pre-live DB recreation; PostgreSQL 18 replay and 46 DB-backed fixtures; production VPC ID; credentialed secrets/TLS/role/backup/load/provider/approval evidence. |
| F14 | Intentional scope | Webhook commands were added, but broad CLI parity across the API remains a product-roadmap decision. |
| F16 | Intentional architecture | Remaining measurement-driven architecture deferrals stay outside this remediation; they are not treated as current defects. |
| F17 | Tracked dependency debt | 172 accepted paths covering 75 advisories remain time-bounded and expire 2 September 2026. |

### 11.4 Final validation ledger

**All locally executable validation completed without an observed failure.** Counts are shown per suite; the root scripts selection overlaps database script tests, so no misleading de-duplicated grand total is asserted.

| **Check** | **Result** | **Evidence** |
| --- | --- | --- |
| Repository TypeScript | PASS | db, auth, SDK, MCP, API, app, docs, CLI, self-host, n8n, and Zapier |
| Biome lint | PASS | 2,091 files; zero lint findings |
| API isolated | PASS | 2,107 passed; 46 DB-backed cases skipped; 0 failed |
| Workerd | PASS | 20 passed; 0 failed |
| Database / Auth | PASS | 325 / 41 passed; 0 failed |
| Dashboard | PASS | 313 tests and Astro production build |
| Docs | PASS | 5 tests; 432 operations / 56 tags; 1,649-page OpenNext production build |
| SDK / CLI / MCP | PASS | 21 / 8 / 9 passed; typechecks/builds pass |
| Self-host | PASS | 115 tests, TypeScript, build, and offline package smoke |
| n8n / Zapier | PASS | 1 / 14 passed; typechecks/builds pass |
| Root scripts selection | PASS | 365 passed; includes overlapping package database script tests |
| OpenAPI | PASS | Deterministic export matches the checked-out API |
| Diff hygiene | PASS | git diff --check clean; no production or provider mutation performed |

### 11.5 Remaining evidence before production

Recreate the disposable pre-live database from the sealed baseline and retain the cutover evidence.

Run PostgreSQL 18 replay/catalog comparison plus all 46 database-backed authority/race fixtures through the approved tunnel.

Populate and verify the production Hyperdrive VPC service identity; the manifest intentionally remains fail-closed until a real ID exists.

Complete credentialed production checks: exact Worker secret closure, DNS/TLS, private database and runtime role, backup/restore rehearsal, load tests, provider canaries, and explicit release approval.

Review or renew the 75-advisory dependency exception set before 2 September 2026.

Make an explicit roadmap decision for broad CLI parity and the remaining measurement-driven architecture deferrals.

**Final engineering conclusion.** The confirmed repository defects identified by this scan and its integration review are implemented and locally green. Production remains a controlled NO-GO until the external database, Cloudflare, credential, recovery, performance, provider, and approval evidence above is complete.  *Addendum generated and visually verified by the repository audit workflow.*
