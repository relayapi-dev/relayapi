import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(
	resolve(import.meta.dir, "../.github/workflows/prelive-baseline-cutover.yml"),
	"utf8",
);
const inventoryWorkflow = readFileSync(
	resolve(
		import.meta.dir,
		"../.github/workflows/prelive-destructive-inventory.yml",
	),
	"utf8",
);
const lintWorkflow = readFileSync(
	resolve(import.meta.dir, "../.github/workflows/ci-lint.yml"),
	"utf8",
);
const preliveReset = readFileSync(
	resolve(import.meta.dir, "../packages/db/scripts/prelive-reset.ts"),
	"utf8",
);
const generationOneMigrationWorkflow = readFileSync(
	resolve(import.meta.dir, "../.github/workflows/ci-db-migrations.yml"),
	"utf8",
);
const requiredDatabaseFixtureRunner = readFileSync(
	resolve(import.meta.dir, "../apps/api/scripts/run-required-db-fixtures.ts"),
	"utf8",
);
const apiPackage = JSON.parse(
	readFileSync(resolve(import.meta.dir, "../apps/api/package.json"), "utf8"),
) as { scripts: Record<string, string> };
const productionSecretsExample = readFileSync(
	resolve(import.meta.dir, "../apps/api/.production.secrets.example"),
	"utf8",
);
const secretsScript = readFileSync(
	resolve(import.meta.dir, "../scripts/secrets.ts"),
	"utf8",
);
const providerInventoryProtectedSecrets = [
	"PRELIVE_EXPECTED_STRIPE_ACCOUNT_ID",
	"PRELIVE_EXPECTED_TELNYX_API_KEY_SHA256",
	"PRELIVE_PROVIDER_TERMINAL_REVERSAL_POLICY",
	"PRELIVE_STRIPE_BANK_TRANSFER_FUNDING_INSTRUCTIONS_ATTESTATION",
	"PRELIVE_STRIPE_LEGACY_RECEIVER_SOURCES_ATTESTATION",
	"PRELIVE_STRIPE_CONNECT_ATTESTATION",
	"PRELIVE_STRIPE_LIVE_PRICING_TABLES_ATTESTATION",
	"PRELIVE_STRIPE_ACCOUNT_DEDICATED_TO_RELAYAPI",
	"PRELIVE_STRIPE_UNSUPPORTED_PRODUCTS_DISABLED",
	"PRELIVE_TELNYX_ACCOUNT_DEDICATED_TO_RELAYAPI",
	"PRELIVE_TELNYX_UNSUPPORTED_PRODUCTS_DISABLED",
	"PRELIVE_TELNYX_SCHEDULED_PAYMENTS_ATTESTATION",
	"PRELIVE_TELNYX_AUTO_RECHARGE_ATTESTATION",
	"PRELIVE_META_WHATSAPP_OUTSTANDING_INVOICES_ZERO",
	"PRELIVE_META_WHATSAPP_AUTOMATIC_PAYMENTS_DISABLED",
] as const;
const databaseFixtureRoot = resolve(
	import.meta.dir,
	"../apps/api/src/__tests__",
);
const databaseFixtureMarker =
	"const databaseIt = CONNECTION_STRING ? it : it.skip;";
const databaseFixtureFiles = [
	...new Bun.Glob("**/*.test.ts").scanSync({
		cwd: databaseFixtureRoot,
		onlyFiles: true,
	}),
]
	.filter((file) =>
		readFileSync(resolve(databaseFixtureRoot, file), "utf8").includes(
			databaseFixtureMarker,
		),
	)
	.sort();
const databaseFixtureSources = databaseFixtureFiles.map((file) =>
	readFileSync(resolve(databaseFixtureRoot, file), "utf8"),
);

const workflowGuardCommand = [
	"bun test",
	"scripts/check-live-baseline-generation.test.ts",
	"scripts/generation-1-stamp-record.test.ts",
	"scripts/prelive-baseline-cutover-workflow.test.ts",
	"scripts/prelive-generation-1-stamp-workflow.test.ts",
	"scripts/prelive-cloudflare-cutover.test.ts",
].join(" ");

function position(fragment: string): number {
	const index = workflow.indexOf(fragment);
	expect(index).toBeGreaterThan(-1);
	return index;
}

function inventoryPosition(fragment: string): number {
	const index = inventoryWorkflow.indexOf(fragment);
	expect(index).toBeGreaterThan(-1);
	return index;
}

describe("pre-live baseline cutover workflow", () => {
	test("runs both workflow guards in ordinary CI and before cutover validation", () => {
		expect(lintWorkflow).toContain(
			"on:\n  push:\n    branches: [main]\n  pull_request:",
		);
		expect(lintWorkflow.replaceAll(/\s+/g, " ")).toContain(
			workflowGuardCommand,
		);
		const validationGuard = position(
			"Test baseline generation and cutover workflow guards",
		);
		const sealed = position(
			"Require the sealed, attested generation-2 collapse",
		);
		expect(validationGuard).toBeLessThan(sealed);
		expect(workflow.replaceAll(/\s+/g, " ")).toContain(workflowGuardCommand);
	});

	test("requires the exact protected main commit and an explicit wipe phrase", () => {
		expect(workflow).toContain("ref: main");
		expect(workflow).toContain(
			'[[ "$REVIEWED_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]',
		);
		expect(workflow).toContain(
			'test "$(git rev-parse HEAD)" = "$REVIEWED_COMMIT_SHA"',
		);
		expect(workflow).toContain("WIPE_DISPOSABLE_PRELIVE_GENERATION_1");
		expect(workflow).toContain("environment:\n      name: production");
		expect(workflow).toContain("generation_1_stamp_commit_sha:");
		expect(workflow).toContain("generation_1_stamp_run_id:");
		expect(workflow).toContain("generation_1_api_version_id:");
		expect(workflow).toContain("generation_1_app_version_id:");
		expect(workflow).toContain("expected_database_name:");
		expect(workflow).toContain("inventory_run_id:");
		expect(workflow).toContain("approved_inventory_sha256:");
		expect(workflow).toContain("inventory_confirmation:");
		expect(workflow).toContain('test "$GITHUB_REF" = "refs/heads/main"');
		expect(workflow).toContain('test "$GITHUB_SHA" = "$REVIEWED_COMMIT_SHA"');
		expect(workflow).toContain(
			"bun scripts/check-live-baseline-generation.ts --attest-cutover-stamp",
		);
		expect(workflow).toContain("grep -qx 'stamp_attested=true' \"$output\"");
		expect(workflow).toContain(
			"grep -qx 'api_worker_status=ready' \"$output\"",
		);
		expect(workflow).toContain(
			"grep -qx 'app_worker_status=ready' \"$output\"",
		);
		expect(workflow).toContain("actions: read");
		expect(workflow).toContain('.name == "Pre-live Generation-1 Worker Stamp"');
		expect(workflow).toContain(
			'.path == ".github/workflows/prelive-generation-1-stamp.yml"',
		);
		expect(workflow).toContain(
			'bun scripts/generation-1-stamp-record.ts --verify="$record"',
		);
		expect(
			workflow.match(
				/name: (?:Re-)?[Vv]erify the protected generation-1 stamp workflow record/g,
			),
		).toHaveLength(2);
	});

	test("requires a separately reviewed exact contained inventory before reset", () => {
		expect(inventoryWorkflow).toContain("name: Pre-live Destructive Inventory");
		expect(inventoryWorkflow).toContain("CAPTURE_CONTAINED_PRELIVE_INVENTORY");
		const preliminaryCapture = inventoryPosition(
			"Capture preliminary inventories before containment",
		);
		const strictEvidence = inventoryPosition(
			"Require prior strict evidence before accepting a reversal tail",
		);
		const preliminaryUpload = inventoryPosition(
			"Upload preliminary inventory before evaluating blockers",
		);
		const preliminaryGate = inventoryPosition(
			"Refuse containment while local or provider money-bearing resources remain",
		);
		const drain = inventoryPosition(
			"bun scripts/prelive-cloudflare-cutover.ts drain-on",
		);
		const converge = inventoryWorkflow.indexOf(
			"bun scripts/prelive-cloudflare-cutover.ts control-convergence-seconds",
			drain,
		);
		const resume = inventoryWorkflow.indexOf(
			"bun scripts/prelive-cloudflare-cutover.ts queues-resume",
			converge,
		);
		const hold = inventoryPosition('sleep "$hold_seconds"');
		const stableZero = inventoryPosition(
			"bun scripts/prelive-cloudflare-cutover.ts queues-verify-drained",
		);
		const pause = inventoryWorkflow.indexOf(
			"bun scripts/prelive-cloudflare-cutover.ts queues-pause",
			stableZero,
		);
		const maintenance = inventoryWorkflow.indexOf(
			"bun scripts/prelive-cloudflare-cutover.ts maintenance-on",
			pause,
		);
		const inventoryCapture = inventoryPosition(
			"Capture canonical Cloudflare, database, and provider inventories",
		);
		expect(strictEvidence).toBeLessThan(preliminaryCapture);
		expect(preliminaryCapture).toBeLessThan(preliminaryUpload);
		expect(preliminaryUpload).toBeLessThan(preliminaryGate);
		expect(preliminaryGate).toBeLessThan(drain);
		expect(drain).toBeLessThan(converge);
		expect(converge).toBeLessThan(resume);
		expect(resume).toBeLessThan(hold);
		expect(hold).toBeLessThan(stableZero);
		expect(stableZero).toBeLessThan(pause);
		expect(pause).toBeLessThan(maintenance);
		expect(maintenance).toBeLessThan(inventoryCapture);
		expect(inventoryWorkflow).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
			"prelive-destructive-inventory-${{ inputs.commit_sha }}",
		);
		expect(inventoryWorkflow).toContain("moneyBearingReferences == []");
		expect(inventoryWorkflow).toContain("unresolvedProviderOperations == []");
		expect(inventoryWorkflow).toContain("blockingResources == []");
		expect(inventoryWorkflow).toContain("providerSha256");
		expect(inventoryWorkflow).toContain("providerBlockingResourceCount");
		expect(inventoryWorkflow).toContain("capturedBeforeContainment: true");
		expect(inventoryWorkflow).toContain("stripeTerminalReversalPolicy");
		expect(inventoryWorkflow).toContain("strict_inventory_run_id:");
		expect(inventoryWorkflow).toContain("strict_preliminary_manifest_sha256:");
		expect(inventoryWorkflow).toContain("strict_inventory_confirmation:");
		expect(inventoryWorkflow).toContain("actions: read");
		expect(inventoryWorkflow).toContain(
			'test "$STRICT_INVENTORY_RUN_ID" != "$GITHUB_RUN_ID"',
		);
		expect(inventoryWorkflow).toContain(
			'.stripeTerminalReversalPolicy == "block_terminal_history"',
		);
		expect(inventoryWorkflow).toContain(
			'.stripe.terminalReversalPolicy == "block_terminal_history"',
		);
		expect(inventoryWorkflow).toContain("strictInventoryProvenance");
		expect(inventoryWorkflow).toContain("stripeTerminalTailSha256");
		expect(inventoryWorkflow).toContain(
			"PRELIVE_STRICT_STRIPE_TERMINAL_TAIL_SHA256=",
		);
		expect(inventoryWorkflow).toContain(
			'test "$terminal_tail_sha" = "$strict_terminal_tail_sha"',
		);
		for (const collection of [
			"paymentIntents",
			"charges",
			"refunds",
			"disputes",
			"topups",
			"payouts",
		]) {
			expect(inventoryWorkflow).toContain(
				`${collection}: (.stripe.${collection} | sort_by(.id))`,
			);
			expect(workflow).toContain(
				`${collection}: (.stripe.${collection} | sort_by(.id))`,
			);
		}
		expect(inventoryWorkflow).toContain(
			'jq -cS "$STRIPE_TERMINAL_TAIL_JQ" "$strict_provider"',
		);
		expect(inventoryWorkflow).toContain(
			'jq -cS "$STRIPE_TERMINAL_TAIL_JQ" "$provider_preliminary"',
		);
		expect(workflow.split("provider_terminal_tail_sha=")).toHaveLength(3);
		expect(workflow).toContain(
			".strictInventoryProvenance.stripeTerminalTailSha256",
		);
		expect(workflow).toContain(
			".strictInventoryProvenance.preliminaryManifestSha256",
		);
		expect(inventoryWorkflow).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
			"prelive-preliminary-inventory-${{ inputs.commit_sha }}",
		);
		const preliminaryUploadStep = inventoryWorkflow.slice(
			preliminaryUpload,
			preliminaryGate,
		);
		expect(preliminaryUploadStep).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
			"if: ${{ always() }}",
		);
		expect(preliminaryUploadStep).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
			"path: ${{ runner.temp }}/prelive-preliminary-inventory",
		);
		expect(preliminaryUploadStep).toContain("if-no-files-found: error");
		expect(inventoryWorkflow).toContain(
			"Initialize `PRELIVE_PROVIDER_TERMINAL_REVERSAL_POLICY` to",
		);
		expect(inventoryWorkflow).toContain("`block_terminal_history`");
		expect(inventoryWorkflow).toContain("`accept_network_reversal_tail`");
		expect(inventoryWorkflow).not.toContain("prelive:reset reset");
		expect(inventoryWorkflow).not.toContain("queues-purge");
		expect(inventoryWorkflow).not.toContain("r2-empty");
		expect(inventoryWorkflow).not.toContain("kv-clear");
		expect(inventoryWorkflow).not.toContain("r2-prepare");
		expect(inventoryWorkflow).not.toContain(
			"cloudflare:configure-queue-retention",
		);
		expect(inventoryWorkflow).toContain(
			"cloudflare:verify-prelive-prerequisites",
		);

		const artifact = position(
			"Re-verify and bind the reviewed contained inventory artifact",
		);
		const exactMatch = position(
			"Re-capture and exactly match the approved contained inventory",
		);
		const arm = position("prelive:reset arm-reset");
		const reset = position("bun run --cwd packages/db prelive:reset reset");
		expect(artifact).toBeLessThan(exactMatch);
		expect(exactMatch).toBeLessThan(arm);
		expect(arm).toBeLessThan(reset);
		expect(workflow).toContain("PRELIVE_APPROVED_INVENTORY_SHA256=");
		expect(workflow).toContain(
			"bun scripts/prelive-cloudflare-cutover.ts inventory-verify",
		);
		expect(workflow).toContain(
			"bun run --cwd packages/db prelive:inventory verify",
		);
		expect(workflow).toContain(
			"bun run --cwd apps/api prelive:provider-inventory verify",
		);
		expect(workflow).toContain("cloudflare:verify-prelive-prerequisites");
		expect(workflow).toContain("cloudflare:verify-prelive-contained");
		expect(workflow).not.toContain(
			"bun run --cwd apps/api cloudflare:verify-production",
		);
		expect(workflow).toContain("PRELIVE_APPROVED_PROVIDER_INVENTORY=");
		expect(workflow).toContain("PRELIVE_APPROVED_PROVIDER_INVENTORY_SHA256=");
		expect(preliveReset).toContain("approved_inventory_sha256");
		expect(preliveReset).toMatch(
			/required\(\s*"PRELIVE_APPROVED_INVENTORY_SHA256",?\s*\)/,
		);
	});

	test("injects inventory-only provider identity and attestation secrets at every capture", () => {
		for (const name of providerInventoryProtectedSecrets) {
			const mapping = `${name}: \${{ secrets.${name} }}`;
			expect(inventoryWorkflow.split(mapping)).toHaveLength(3);
			expect(workflow.split(mapping)).toHaveLength(2);
			expect(productionSecretsExample).not.toContain(name);
			expect(secretsScript).not.toContain(name);
		}
	});

	test("validates the sealed generation-2 baseline before destructive work", () => {
		expect(workflow).toContain("pgvector/pgvector:0.8.5-pg18-bookworm@sha256:");
		const sealed = position(
			"Require the sealed, attested generation-2 collapse",
		);
		const transition = position("Verify the Git-backed generation transition");
		const replay = position(
			"Replay the replacement baseline twice on a clean database",
		);
		const containment = position(
			"Re-assert the reviewed generation-2 containment record and paused Queues",
		);
		expect(sealed).toBeLessThan(transition);
		expect(transition).toBeLessThan(replay);
		expect(replay).toBeLessThan(containment);
		expect(workflow).toContain("jq -er '.transition.baseCommitSha'");
		expect(workflow).toContain(
			'git merge-base --is-ancestor "$GENERATION_1_STAMP_COMMIT_SHA" HEAD',
		);
		expect(workflow).toContain(
			'"$GENERATION_1_STAMP_COMMIT_SHA:packages/db/drizzle/migration-manifest.json"',
		);
		expect(workflow).toContain("jq -er '.transition.baseManifestSha256'");
		expect(workflow).toContain('MIGRATION_BASE_SHA="$base_sha"');
		expect(workflow).toContain(
			'test "$base_sha" = "$GENERATION_1_STAMP_COMMIT_SHA"',
		);
		expect(workflow).toContain(
			'test "$(git rev-parse HEAD^1)" = "$GENERATION_1_STAMP_COMMIT_SHA"',
		);
		expect(workflow).toContain(
			"bun run --cwd packages/db migration:append-only",
		);
		expect(workflow).toContain("migration:source-ownership");
		expect(workflow).toContain("catalog:fingerprint:verify-active");
		expect(workflow).toContain("migration:history:current");
		expect(inventoryWorkflow).not.toContain(
			"bun scripts/prelive-cloudflare-cutover.ts r2-prepare",
		);
	});

	test("requires all forty-six isolated generation-2 database cases after replay", () => {
		const replay = position(
			"Replay the replacement baseline twice on a clean database",
		);
		const fixtureGate = position(
			"Require all generation-2 database lifecycle fixtures",
		);
		const broadApiSuite = position(
			"Run isolated API suite and workerd contracts",
		);
		const destructiveCutover = position("\n  cutover:");
		expect(replay).toBeLessThan(fixtureGate);
		expect(fixtureGate).toBeLessThan(broadApiSuite);
		expect(fixtureGate).toBeLessThan(destructiveCutover);
		expect(workflow).toContain(
			"CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: postgresql://postgres:postgres@127.0.0.1:5432/relayapi_cutover_validation",
		);

		const fixtureStep = workflow.slice(
			workflow.lastIndexOf("- name:", fixtureGate),
			workflow.indexOf("- name:", fixtureGate + 1),
		);
		expect(fixtureStep).toContain('RELAYAPI_REQUIRE_DB_FIXTURES: "1"');
		expect(fixtureStep).toContain(
			"run: bun run --cwd apps/api test:db-fixtures:required",
		);
		expect(workflow.match(/test:db-fixtures:required/g)).toHaveLength(1);
		expect(generationOneMigrationWorkflow).not.toContain(
			"test:db-fixtures:required",
		);
		expect(generationOneMigrationWorkflow).not.toContain(
			"RELAYAPI_REQUIRE_DB_FIXTURES",
		);

		expect(apiPackage.scripts["test:db-fixtures:required"]).toBe(
			"bun run scripts/run-required-db-fixtures.ts",
		);
		expect(requiredDatabaseFixtureRunner).toContain(
			"const EXPECTED_TOTAL_CASES = 46;",
		);
		expect(requiredDatabaseFixtureRunner).toContain(
			"const registeredTotalCases = fixtures.reduce(",
		);
		expect(requiredDatabaseFixtureRunner).toContain(
			"registeredTotalCases !== EXPECTED_TOTAL_CASES",
		);
		expect(requiredDatabaseFixtureRunner).toContain(
			"contains ${registeredCases} databaseIt registrations",
		);
		expect(requiredDatabaseFixtureRunner).toContain(
			"discoveredDatabaseFixtures",
		);
		expect(requiredDatabaseFixtureRunner).toContain(
			"registeredDatabaseFixtures",
		);
		expect(requiredDatabaseFixtureRunner).toContain(
			"Required database fixture registration drifted",
		);
		expect(requiredDatabaseFixtureRunner).toContain('"--reporter=junit"');
		expect(requiredDatabaseFixtureRunner).toContain(
			"tests !== fixture.expectedCases",
		);
		expect(requiredDatabaseFixtureRunner).toContain("skipped !== 0");
		const registeredDatabaseFixtureFiles = [
			...requiredDatabaseFixtureRunner.matchAll(/file: "([^"]+\.test\.ts)"/g),
		]
			.map((match) => match[1])
			.sort();
		expect(registeredDatabaseFixtureFiles).toEqual(
			databaseFixtureFiles.map((file) => `src/__tests__/${file}`).sort(),
		);
		expect(
			[...requiredDatabaseFixtureRunner.matchAll(/expectedCases: (\d+)/g)].map(
				(match) => Number(match[1]),
			),
		).toEqual([20, 1, 2, 2, 7, 10, 4]);
		expect(
			databaseFixtureSources.map(
				(source) => source.match(/\bdatabaseIt\s*\(/g)?.length ?? 0,
			),
		).toEqual([20, 1, 2, 4, 2, 7, 10]);

		for (const source of databaseFixtureSources) {
			expect(source).toContain(
				'process.env.RELAYAPI_REQUIRE_DB_FIXTURES === "1"',
			);
			expect(source).toContain(
				"if (REQUIRE_DB_FIXTURES && !CONNECTION_STRING)",
			);
			expect(source).toContain(
				"const databaseIt = CONNECTION_STRING ? it : it.skip;",
			);
		}
	});

	test("required database fixtures fail closed instead of becoming local skips", () => {
		const requiredEnvironment = {
			RELAYAPI_REQUIRE_DB_FIXTURES: "1",
		};
		for (const file of databaseFixtureFiles) {
			const child = Bun.spawnSync(
				[
					process.execPath,
					"test",
					resolve(import.meta.dir, "../apps/api/src/__tests__", file),
				],
				{
					env: requiredEnvironment,
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const output = `${child.stdout.toString()}\n${child.stderr.toString()}`;
			expect(child.exitCode).not.toBe(0);
			expect(output).toContain(
				"RELAYAPI_REQUIRE_DB_FIXTURES=1 requires a PostgreSQL URL",
			);
		}

		const runner = Bun.spawnSync(
			[
				process.execPath,
				resolve(
					import.meta.dir,
					"../apps/api/scripts/run-required-db-fixtures.ts",
				),
			],
			{
				env: requiredEnvironment,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const runnerOutput = `${runner.stdout.toString()}\n${runner.stderr.toString()}`;
		expect(runner.exitCode).not.toBe(0);
		expect(runnerOutput).toContain(
			"Required database fixture gate needs a PostgreSQL URL",
		);
	});

	test("parses both JSONC Worker configs with Wrangler before checking generation", () => {
		expect(workflow).not.toMatch(
			/jq[^\n]*(?:apps\/api|apps\/app)\/wrangler\.jsonc/,
		);
		expect(workflow).toContain(
			'bun run --cwd apps/api wrangler types "$api_types"',
		);
		expect(workflow).toContain(
			'bun run --cwd apps/app wrangler types "$app_types"',
		);
		expect(workflow).toContain(
			`test "$(grep -Fc 'BASELINE_GENERATION: "2";' "$api_types")" -eq 1`,
		);
		expect(workflow).toContain(
			`test "$(grep -Fc 'BASELINE_GENERATION: "2";' "$app_types")" -eq 1`,
		);
	});

	test("reasserts containment and passes four gates before reset", () => {
		const maintenance = position(
			"bun scripts/prelive-cloudflare-cutover.ts maintenance-on",
		);
		const pause = position(
			"bun scripts/prelive-cloudflare-cutover.ts queues-pause",
		);
		const convergence = workflow.indexOf(
			"bun scripts/prelive-cloudflare-cutover.ts control-convergence-seconds",
			pause,
		);
		const gate1 = position("Containment gate 1/4:");
		const gate2 = position("Containment gate 2/4:");
		const gate3 = position("Containment gate 3/4:");
		const gate4 = position("Containment gate 4/4:");
		const arm = position("prelive:reset arm-reset");
		const reset = position("bun run --cwd packages/db prelive:reset reset");
		expect(maintenance).toBeLessThan(pause);
		expect(pause).toBeLessThan(convergence);
		expect(convergence).toBeLessThan(gate1);
		expect(gate1).toBeLessThan(gate2);
		expect(gate2).toBeLessThan(gate3);
		expect(gate3).toBeLessThan(gate4);
		expect(gate4).toBeLessThan(arm);
		expect(arm).toBeLessThan(reset);
		expect(workflow).toContain('test "$convergence_seconds" = "120"');
		expect(workflow.match(/Containment gate [1-4]\/4:/g)).toHaveLength(4);
		expect(workflow).toContain(
			"bun scripts/prelive-cloudflare-cutover.ts queues-verify-paused",
		);
		expect(workflow).toContain("https://api.relayapi.dev/health/control");
		expect(workflow).toContain("https://relayapi.dev/health/control");
		expect(workflow).toContain(
			"https://api.relayapi.dev/internal/cutover-smoke",
		);
		expect(workflow).toContain("https://relayapi.dev/internal/cutover-smoke");
		expect(workflow).not.toContain(
			"Wait the complete source-owned asynchronous execution envelope",
		);
	});

	test("verifies PostgreSQL completely before purging Queue, KV, or R2", () => {
		const reset = position("bun run --cwd packages/db prelive:reset reset");
		const migrate = workflow.indexOf(
			"bun run --cwd packages/db migrate",
			reset,
		);
		const verify = workflow.indexOf(
			"bun run --cwd packages/db verify:migrations",
			migrate,
		);
		const productionCatalog = workflow.indexOf(
			"bun run --cwd packages/db catalog:fingerprint:verify-active",
			verify,
		);
		const history = workflow.indexOf(
			"bun run --cwd packages/db migration:history:current",
			productionCatalog,
		);
		const grant = workflow.indexOf(
			"bun run --cwd packages/db prelive:reset grant-runtime",
			history,
		);
		const postflight = workflow.indexOf(
			"bun run --cwd packages/db prelive:reset postflight",
			grant,
		);
		const r2Empty = workflow.indexOf(
			"bun scripts/prelive-cloudflare-cutover.ts r2-empty",
			postflight,
		);
		const r2Settle = workflow.indexOf(
			"bun scripts/prelive-cloudflare-cutover.ts r2-event-settle-seconds",
			r2Empty,
		);
		const firstR2Verify = workflow.indexOf(
			"bun scripts/prelive-cloudflare-cutover.ts r2-verify-empty",
			r2Settle,
		);
		const kvClear = workflow.indexOf(
			"bun scripts/prelive-cloudflare-cutover.ts kv-clear",
			firstR2Verify,
		);
		const purge = workflow.indexOf(
			"bun scripts/prelive-cloudflare-cutover.ts queues-purge",
			kvClear,
		);
		const finalR2Verify = workflow.indexOf(
			"bun scripts/prelive-cloudflare-cutover.ts r2-verify-empty",
			purge,
		);
		const release = position(
			"Leave maintenance only after every contained cutover check passes",
		);
		expect(reset).toBeLessThan(migrate);
		expect(migrate).toBeLessThan(verify);
		expect(verify).toBeLessThan(productionCatalog);
		expect(productionCatalog).toBeLessThan(history);
		expect(history).toBeLessThan(grant);
		expect(grant).toBeLessThan(postflight);
		expect(postflight).toBeLessThan(r2Empty);
		expect(r2Empty).toBeLessThan(r2Settle);
		expect(r2Settle).toBeLessThan(firstR2Verify);
		expect(firstR2Verify).toBeLessThan(kvClear);
		expect(kvClear).toBeLessThan(purge);
		expect(purge).toBeLessThan(finalR2Verify);
		expect(finalR2Verify).toBeLessThan(release);
		expect(workflow).toContain('test "$r2_settle_seconds" = "60"');
		expect(workflow).toContain('sleep "$r2_settle_seconds"');
		const resetStep = workflow.slice(
			workflow.lastIndexOf(
				"- name: Reset PostgreSQL schemas and apply the single generation-2 baseline",
				reset,
			),
			workflow.indexOf(
				"- name: Deploy the exact generation-2 API with no rollback path",
				reset,
			),
		);
		expect(resetStep).toMatch(
			/CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: \$\{\{ secrets\.PRODUCTION_DATABASE_URL \}\}/,
		);
		expect(resetStep).toMatch(
			/PRELIVE_RUNTIME_DATABASE_URL: \$\{\{ secrets\.PRODUCTION_RUNTIME_DATABASE_URL \}\}/,
		);
		expect(preliveReset).toContain("assertRuntimeConnectionCannotDdl");
		expect(preliveReset).toContain("required(RUNTIME_CONNECTION_ENV)");
	});

	test("opens both Workers before releasing paused Queue consumers", () => {
		expect(workflow).toContain("timeout-minutes: 180");
		const maintenanceOff = position(
			"bun scripts/prelive-cloudflare-cutover.ts maintenance-off",
		);
		const convergenceContract = workflow.indexOf(
			"bun scripts/prelive-cloudflare-cutover.ts control-convergence-seconds",
			maintenanceOff,
		);
		const convergence = workflow.indexOf(
			'sleep "$convergence_seconds"',
			convergenceContract,
		);
		const apiOpen = workflow.indexOf(
			`jq -e '.status == "open"' "$api_body"`,
			convergence,
		);
		const appOpen = workflow.indexOf(
			`jq -e '.status == "open"' "$app_body"`,
			apiOpen,
		);
		const apiHealth = workflow.indexOf(
			"https://api.relayapi.dev/health >/dev/null",
			appOpen,
		);
		const appHealth = workflow.indexOf(
			"https://relayapi.dev/app >/dev/null",
			apiHealth,
		);
		const queuesResume = workflow.indexOf(
			"bun scripts/prelive-cloudflare-cutover.ts queues-resume",
			appHealth,
		);
		const recontain = position(
			"Re-contain a failed cutover without rolling back generation 2",
		);
		expect(maintenanceOff).toBeLessThan(convergence);
		expect(convergenceContract).toBeLessThan(convergence);
		expect(workflow).toContain('test "$convergence_seconds" = "120"');
		expect(convergence).toBeLessThan(apiOpen);
		expect(apiOpen).toBeLessThan(appOpen);
		expect(appOpen).toBeLessThan(apiHealth);
		expect(apiHealth).toBeLessThan(appHealth);
		expect(appHealth).toBeLessThan(queuesResume);
		expect(queuesResume).toBeLessThan(recontain);
	});

	test("binds reset authorization to exact database, old ledger, and one-use sentinel", () => {
		const prepare = position(
			"Prepare exact database identity, generation-1 ledger, and one-use sentinel",
		);
		const preflight = position(
			"Verify the exact database, migration role, ledger, and capabilities before maintenance",
		);
		const maintenance = position(
			"Re-assert the reviewed generation-2 containment record and paused Queues",
		);
		expect(prepare).toBeLessThan(preflight);
		expect(preflight).toBeLessThan(maintenance);
		expect(workflow).toContain(
			'git show "$base_sha:packages/db/drizzle/migration-manifest.json"',
		);
		expect(workflow).toContain("PRELIVE_EXPECTED_LEDGER_MANIFEST=");
		expect(workflow).toContain("PRELIVE_RESET_SENTINEL=");
		expect(workflow).toContain("PRELIVE_EXPECTED_DATABASE=");
		expect(workflow).toContain(
			"PRELIVE_RESET_CONFIRMATION: WIPE-DISPOSABLE-PRELIVE-GENERATION-2",
		);
	});

	test("has no generation rollback and re-contains every post-maintenance failure", () => {
		expect(workflow).not.toMatch(/\bwrangler rollback\b/);
		expect(workflow).not.toMatch(/\bgit (?:reset|checkout|restore)\b/);
		expect(workflow).toContain(
			"Re-contain a failed cutover without rolling back generation 2",
		);
		expect(workflow).toContain(
			"failure() && steps.containment.outputs.active == 'true'",
		);
	});
});
