import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWranglerDeploy } from "../../scripts/prepare-wrangler-deploy";

const baseConfig = {
	name: "relayapi-app",
	main: "entry.mjs",
	no_bundle: true,
	assets: { binding: "ASSETS", directory: "../client" },
	vars: { IDENTITY_DELETION_CONTRACT_VERSION: "0005" },
	kv_namespaces: [{ binding: "SESSION" }],
	compatibility_date: "2026-07-18",
	compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
};

async function withConfig(
	config: Record<string, unknown>,
	run: (path: string) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "relayapi-wrangler-config-"));
	try {
		const path = join(directory, "wrangler.json");
		await writeFile(path, `${JSON.stringify(config)}\n`, "utf8");
		await run(path);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe("Astro Wrangler deploy config compatibility", () => {
	it("removes only the retired generated legacy_env field", async () => {
		await withConfig({ ...baseConfig, legacy_env: true }, async (path) => {
			expect(await prepareWranglerDeploy(path)).toBe(true);
			const prepared = JSON.parse(await readFile(path, "utf8"));
			expect(prepared).toEqual(baseConfig);
			expect(Object.hasOwn(prepared, "legacy_env")).toBe(false);
		});
	});

	it("is an idempotent no-op after upstream stops emitting the field", async () => {
		await withConfig(baseConfig, async (path) => {
			const before = await readFile(path, "utf8");
			expect(await prepareWranglerDeploy(path)).toBe(false);
			expect(await readFile(path, "utf8")).toBe(before);
		});
	});

	it("restores the security-critical compatibility flag omitted by Astro", async () => {
		await withConfig(
			{ ...baseConfig, compatibility_flags: ["nodejs_compat"] },
			async (path) => {
				expect(await prepareWranglerDeploy(path)).toBe(true);
				const prepared = JSON.parse(await readFile(path, "utf8"));
				expect(prepared.compatibility_flags).toEqual(
					baseConfig.compatibility_flags,
				);
			},
		);
	});

	it("fails closed for an unexpected legacy_env value", async () => {
		await withConfig({ ...baseConfig, legacy_env: false }, async (path) => {
			await expect(prepareWranglerDeploy(path)).rejects.toThrow(
				"unexpected generated legacy_env",
			);
		});
	});

	it("fails closed before deploy when Astro changes the Worker target", async () => {
		await withConfig({ ...baseConfig, name: "wrong-worker" }, async (path) => {
			await expect(prepareWranglerDeploy(path)).rejects.toThrow(
				"unexpected Wrangler deploy configuration",
			);
		});
	});

	it("fails closed without the reviewed identity-deletion contract marker", async () => {
		await withConfig({ ...baseConfig, vars: {} }, async (path) => {
			await expect(prepareWranglerDeploy(path)).rejects.toThrow(
				"unexpected Wrangler deploy configuration",
			);
		});
	});
});
