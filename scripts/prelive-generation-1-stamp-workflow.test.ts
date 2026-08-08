import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const generationPath = resolve(
	import.meta.dir,
	"../packages/db/baseline-generation.json",
);
const buildPolicyPath = resolve(
	import.meta.dir,
	"../packages/db/baseline-build-policy.json",
);
const workflow = readFileSync(
	resolve(
		import.meta.dir,
		"../.github/workflows/prelive-generation-1-stamp.yml",
	),
	"utf8",
);

function position(fragment: string): number {
	const index = workflow.indexOf(fragment);
	expect(index).toBeGreaterThan(-1);
	return index;
}

describe("pre-live generation-1 Worker stamp workflow", () => {
	test("runs only from the exact protected generation-1 main head", () => {
		expect(workflow).toContain("stamp_commit_sha:");
		expect(workflow).toContain("expected_database_name:");
		expect(workflow).toContain("CREATE_SCHEMA_COMPATIBLE_GENERATION_1_STAMP");
		expect(workflow).toContain("environment:\n      name: production");
		expect(workflow).toContain("ref: main");
		expect(workflow).toContain('test "$GITHUB_REF" = "refs/heads/main"');
		expect(workflow).toContain('test "$REF_PROTECTED" = "true"');
		expect(workflow).toContain(
			'test "$(git rev-parse HEAD)" = "$STAMP_COMMIT_SHA"',
		);
		expect(workflow).toContain(
			'test "$DISPATCH_COMMIT_SHA" = "$STAMP_COMMIT_SHA"',
		);
	});

	test("is permanently generation-1-only and requires cutover-safe controls", () => {
		expect(workflow).toContain(".generation == 1");
		expect(workflow).toContain('.lifecycle == "sealed"');
		expect(workflow).toContain('.transition.kind == "initial-baseline"');
		expect(workflow).not.toContain('.transition.kind == "bootstrap"');
		expect(workflow).toContain("authorizedCollapse.fromGeneration == 1");
		expect(workflow).toContain("authorizedCollapse.toGeneration == 2");
		expect(workflow).toContain("^export const BASELINE_GENERATION = 1;$");
		expect(workflow).toContain("relayapi:maintenance-smoke:cutover:v1:");
		expect(workflow).toContain("RUNTIME_CONTROL_CACHE_TTL_SECONDS !== 30");
		expect(workflow).toContain("PRELIVE_CONTROL_CONVERGENCE_SECONDS !== 120");
		expect(workflow).toContain("PRELIVE_R2_EVENT_SETTLE_SECONDS !== 60");
		expect(workflow).toContain('"/health/control"');
		expect(workflow).toContain('"/internal/cutover-smoke"');
		expect(workflow).toContain(
			`test "$(grep -Fc 'BASELINE_GENERATION: "1";' "$api_types")" -eq 1`,
		);
		expect(workflow).toContain(
			`test "$(grep -Fc 'BASELINE_GENERATION: "1";' "$app_types")" -eq 1`,
		);
	});

	test("executes both source predicates against their canonical metadata", () => {
		const predicates = new Map(
			[
				...workflow.matchAll(
					/jq -e '([\s\S]*?)' (packages\/db\/(?:baseline-generation|baseline-build-policy)\.json) >\/dev\/null/g,
				),
			].map((match) => [match[2], match[1]]),
		);
		for (const contract of [
			{
				path: generationPath,
				predicate: predicates.get("packages/db/baseline-generation.json"),
			},
			{
				path: buildPolicyPath,
				predicate: predicates.get("packages/db/baseline-build-policy.json"),
			},
		]) {
			expect(contract.predicate).toBeDefined();
			const result = spawnSync(
				"jq",
				["-e", contract.predicate ?? "", contract.path],
				{ encoding: "utf8" },
			);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		}
	});

	test("proves the existing generation-1 database without mutating it", () => {
		const tunnel = position(
			"Start the read-only generation-1 database verification tunnel",
		);
		const identity = position(
			"Prove the exact generation-1 database identity, ledger, and catalog",
		);
		const firstDeploy = position(
			"Deploy the source-pinned generation-1 App stamp",
		);
		expect(tunnel).toBeLessThan(identity);
		expect(identity).toBeLessThan(firstDeploy);
		expect(workflow).toContain("assertDatabaseIdentity");
		expect(workflow).toContain("assertSupportedPostgres");
		expect(workflow).toContain("verify:migrations");
		expect(workflow).toContain("catalog:fingerprint:verify-active");
		expect(workflow).toContain("migration:history:current");
		expect(workflow).toContain("assertRuntimeConnectionCannotDdl");
		expect(workflow).toMatch(
			/PRELIVE_RUNTIME_DATABASE_URL: \$\{\{ secrets\.PRODUCTION_RUNTIME_DATABASE_URL \}\}/,
		);
		expect(workflow).toContain(
			'decodeURIComponent(runtimeUrl.username) !== "relayapi_runtime"',
		);
		expect(workflow).not.toContain("packages/db migrate");
		expect(workflow).not.toContain("prelive:reset");
		expect(workflow).not.toContain("maintenance-on");
		expect(workflow).not.toContain("queues-purge");
		expect(workflow).not.toContain("kv-clear");
		expect(workflow).not.toContain("r2-empty");
	});

	test("refuses a generation rollback and stamps App then API from one SHA", () => {
		const liveGeneration = position(
			"Verify both currently active Workers are still generation 1",
		);
		const appDeploy = position(
			"Deploy the source-pinned generation-1 App stamp",
		);
		const apiDeploy = position(
			"Deploy the source-pinned generation-1 API stamp",
		);
		const attestation = position(
			"Attest both active generation-1 versions and their exact source",
		);
		expect(liveGeneration).toBeLessThan(appDeploy);
		expect(appDeploy).toBeLessThan(apiDeploy);
		expect(apiDeploy).toBeLessThan(attestation);
		expect(workflow).toContain("--require-live-generation-one");
		expect(
			workflow.match(/--tag "baseline-1-stamp-\$\{STAMP_COMMIT_SHA\}"/g),
		).toHaveLength(2);
		expect(
			workflow.match(/--message "Generation 1 stamp \$\{STAMP_COMMIT_SHA\}"/g),
		).toHaveLength(2);
		expect(workflow).not.toContain("wrangler rollback");
	});

	test("records exact source and version IDs in an immutable artifact", () => {
		const attestation = position(
			"Attest both active generation-1 versions and their exact source",
		);
		const createRecord = position(
			"Create the exact generation-1 stamp release record",
		);
		const upload = position(
			"Preserve the immutable generation-1 stamp release record",
		);
		const summary = position(
			"Record exact cutover inputs in the protected workflow summary",
		);
		expect(attestation).toBeLessThan(createRecord);
		expect(createRecord).toBeLessThan(upload);
		expect(upload).toBeLessThan(summary);
		expect(workflow).toContain("ACTUAL_GENERATION_1_STAMP_RUN_ID:");
		expect(workflow).toContain("ACTUAL_GENERATION_1_STAMP_COMMIT_SHA:");
		expect(workflow).toContain("ACTUAL_GENERATION_1_API_VERSION_ID:");
		expect(workflow).toContain("ACTUAL_GENERATION_1_APP_VERSION_ID:");
		expect(workflow).toContain(
			"actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
		);
		expect(workflow).toContain("retention-days: 90");
		expect(workflow).toContain("Artifact SHA-256:");
	});
});
