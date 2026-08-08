import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEncryptionKeyRing } from "../src/doctor.js";
import { generatedSecrets, writeScaffold } from "../src/scaffold.js";

describe("operator repository scaffold", () => {
	test("pins generated deployments to the supported Bun runtime", async () => {
		const directory = await mkdtemp(join(tmpdir(), "relayapi-self-host-"));
		try {
			await writeScaffold(join(directory, "relayapi.config.json"));
			const workflow = await readFile(
				join(directory, ".github", "workflows", "deploy-relayapi.yml"),
				"utf8",
			);

			expect(workflow).toContain('bun-version: "1.3.14"');
			expect(workflow).not.toContain('bun-version: "1.2.19"');
			expect(workflow).toContain("RELAYAPI_MIGRATION_DATABASE_URL");
			expect(workflow).not.toContain("RELAYAPI_DATABASE_URL");
			const environmentExample = await readFile(
				join(directory, ".env.example"),
				"utf8",
			);
			expect(environmentExample).toContain(
				"ENCRYPTION_KEY=active=<64-hex-characters>,identity=<retained-64-hex-characters>",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("generates distinct active and retained identity key material", () => {
		const { encryptionKey } = generatedSecrets();
		expect(() => validateEncryptionKeyRing(encryptionKey)).not.toThrow();
		const entries = new Map(
			encryptionKey
				.split(",")
				.map((entry) => entry.split("=") as [string, string]),
		);
		expect(entries.get("active")).toHaveLength(64);
		expect(entries.get("identity")).toHaveLength(64);
		expect(entries.get("active")).not.toBe(entries.get("identity"));
	});
});
