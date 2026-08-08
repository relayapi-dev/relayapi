/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("generation-2 candidate replay contract", () => {
	const replaySource = readFileSync(
		new URL("./replay-baseline-candidate.ts", import.meta.url),
		"utf8",
	);
	const rebuildSource = readFileSync(
		new URL("./rebuild-baseline.ts", import.meta.url),
		"utf8",
	);
	const migrateSource = readFileSync(
		new URL("./migrate.ts", import.meta.url),
		"utf8",
	);
	const liveVerifierSource = readFileSync(
		new URL("./verify-migrations.ts", import.meta.url),
		"utf8",
	);

	test("exports both candidate migration artifacts and generation metadata", () => {
		expect(rebuildSource).toContain(
			'writeArtifactSet(join(candidateStaging, "drizzle"), artifacts)',
		);
		expect(rebuildSource).toContain(
			"serializeJson(verificationGeneration)",
		);
		expect(rebuildSource).toContain(
			"candidate output already exists; refusing to overwrite",
		);
	});

	test("routes every verifier to the candidate and replays it twice on loopback", () => {
		expect(
			replaySource.match(/run\("scripts\/migrate\.ts"\);/g),
		).toHaveLength(2);
		expect(replaySource).toContain(
			'throw new Error("Candidate replay is restricted to a loopback PostgreSQL host")',
		);
		expect(replaySource).toContain(
			"RELAYAPI_VERIFY_MIGRATION_DIRECTORY: drizzleDirectory",
		);
		expect(replaySource).toContain(
			"RELAYAPI_VERIFY_BASELINE_GENERATION: generationPath",
		);
		expect(replaySource).toContain(
			'run("scripts/verify-schema-contracts.ts")',
		);
		expect(replaySource).toContain('run("scripts/verify-migrations.ts")');
		expect(replaySource).toContain(
			'run("scripts/verify-migration-history.ts", ["--live", "--require-current"])',
		);
		expect(replaySource).toContain("`--verify=${catalogOutput}`");
		expect(migrateSource).toContain("RELAYAPI_MIGRATION_DIRECTORY");
		expect(migrateSource).toContain("RELAYAPI_MIGRATION_GENERATION");
			expect(liveVerifierSource).not.toContain(
				"OLD_CHAIN_CATALOG_EVIDENCE_FILE",
			);
	});

	test("requires a virgin exact-name database and a new fingerprint path", () => {
		expect(replaySource).toContain(
			"Candidate replay database must be virgin",
		);
		expect(replaySource).toContain(
			"RELAYAPI_CANDIDATE_EXPECTED_DATABASE",
		);
		expect(replaySource).toContain(
			"Refusing to overwrite existing candidate catalog",
		);
	});
});
