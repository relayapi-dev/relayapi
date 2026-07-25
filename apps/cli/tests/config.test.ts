import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";

const originalHome = process.env.HOME;

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
});

describe("CLI credential storage", () => {
	it("writes credentials with owner-only permissions", () => {
		const home = mkdtempSync(join(tmpdir(), "relayapi-cli-"));
		process.env.HOME = home;

		saveConfig({ api_key: "rlay_test_example" });

		const directory = join(home, ".relayapi");
		const file = join(directory, "config.json");
		expect(statSync(directory).mode & 0o777).toBe(0o700);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(loadConfig().api_key).toBe("rlay_test_example");
	});

	it("migrates permissive permissions while loading an existing config", () => {
		const home = mkdtempSync(join(tmpdir(), "relayapi-cli-"));
		process.env.HOME = home;
		const directory = join(home, ".relayapi");
		mkdirSync(directory, { mode: 0o755 });
		saveConfig({ api_key: "rlay_test_example" });
		chmodSync(directory, 0o755);
		chmodSync(join(directory, "config.json"), 0o644);

		expect(loadConfig().api_key).toBe("rlay_test_example");
		expect(statSync(directory).mode & 0o777).toBe(0o700);
		expect(statSync(join(directory, "config.json")).mode & 0o777).toBe(0o600);
	});
});
