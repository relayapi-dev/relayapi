import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeScaffold } from "../src/scaffold.js";

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
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
