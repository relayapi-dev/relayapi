import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BASELINE_GENERATION } from "@relayapi/config";
import { prepareWranglerDeploy } from "../../scripts/prepare-wrangler-deploy";

const appRoot = resolve(import.meta.dir, "../..");
const baseConfig = {
	name: "relayapi-app",
	main: "entry.mjs",
	no_bundle: true,
	assets: { binding: "ASSETS", directory: "../client" },
	vars: {
		IDENTITY_DELETION_CONTRACT_VERSION: "identity-deletion-v1",
		BASELINE_GENERATION: String(BASELINE_GENERATION),
	},
	kv_namespaces: [{ binding: "KV", id: "test-kv-id" }],
	r2_buckets: [
		{
			binding: "AVATARS_BUCKET",
			bucket_name: "relayapi-avatars",
		},
		{
			binding: "PUBLIC_ASSETS",
			bucket_name: "relayapi-public-assets",
		},
		{
			binding: "QUEUE_RESCUE_BUCKET",
			bucket_name: "relayapi-queue-rescue-ledger",
		},
	],
	services: [
		{
			binding: "EMAIL_INTENTS",
			service: "relayapi",
			entrypoint: "EmailIntentEntrypoint",
		},
	],
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

describe("dashboard source storage configuration", () => {
	it("installs dependencies before the production baseline-generation guard", async () => {
		const workflow = await readFile(
			resolve(appRoot, "../../.github/workflows/deploy-app.yml"),
			"utf8",
		);
		const baselineGuard = workflow.slice(
			workflow.indexOf("  baseline-generation-guard:"),
			workflow.indexOf("  test:"),
		);
		const installDependencies = baselineGuard.indexOf(
			"run: bun install --frozen-lockfile",
		);
		const compareGenerations = baselineGuard.indexOf(
			"bun scripts/check-live-baseline-generation.ts --allow-initial-generation-bootstrap",
		);

		expect(installDependencies).toBeGreaterThan(0);
		expect(compareGenerations).toBeGreaterThan(installDependencies);
	});

	it("disables unused Astro sessions without provisioning SESSION KV", async () => {
		const astroConfigUrl = pathToFileURL(
			join(appRoot, "astro.config.mjs"),
		).href;
		const astroConfig = (await import(astroConfigUrl)).default as {
			session?: { driver?: { entrypoint?: string } };
		};
		const wranglerConfig = JSON.parse(
			await readFile(join(appRoot, "wrangler.jsonc"), "utf8"),
		) as {
			kv_namespaces?: Array<{ binding?: string }>;
		};

		expect(astroConfig.session?.driver?.entrypoint).toBe(
			"unstorage/drivers/null",
		);
		expect(
			wranglerConfig.kv_namespaces?.some(
				(namespace) => namespace.binding === "SESSION",
			),
		).toBe(false);
	});

	it("has no runtime consumer of the Astro Session API", async () => {
		const sourceFiles = new Bun.Glob("src/**/*.{astro,js,jsx,mjs,ts,tsx}");
		const astroSessionAccess = ["Astro", ".", "session"].join("");
		const offenders: string[] = [];

		for await (const relativePath of sourceFiles.scan({
			cwd: appRoot,
			onlyFiles: true,
		})) {
			if (relativePath.includes("/__tests__/")) continue;
			const source = await readFile(join(appRoot, relativePath), "utf8");
			if (source.includes(astroSessionAccess)) offenders.push(relativePath);
		}

		expect(offenders).toEqual([]);
	});

	it("uses unqualified bindings for default-jurisdiction hosted buckets", async () => {
		const wranglerConfig = JSON.parse(
			await readFile(join(appRoot, "wrangler.jsonc"), "utf8"),
		) as {
			r2_buckets?: Array<Record<string, unknown>>;
			vars?: Record<string, unknown>;
		};

		expect(wranglerConfig.r2_buckets).toEqual(baseConfig.r2_buckets);
		expect(wranglerConfig.vars?.IDENTITY_DELETION_CONTRACT_VERSION).toBe(
			"identity-deletion-v1",
		);
		expect(wranglerConfig.vars?.BASELINE_GENERATION).toBe(
			String(BASELINE_GENERATION),
		);
	});
});

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

	it("removes Astro's empty generated Queue container", async () => {
		await withConfig(
			{
				...baseConfig,
				queues: {
					producers: [],
					consumers: [],
				},
			},
			async (path) => {
				expect(await prepareWranglerDeploy(path)).toBe(true);
				const prepared = JSON.parse(await readFile(path, "utf8"));
				expect(prepared).toEqual(baseConfig);
				expect(Object.hasOwn(prepared, "queues")).toBe(false);
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

	it("fails closed if Astro restores the top-level SESSION KV binding", async () => {
		await withConfig(
			{
				...baseConfig,
				kv_namespaces: [...baseConfig.kv_namespaces, { binding: "SESSION" }],
			},
			async (path) => {
				await expect(prepareWranglerDeploy(path)).rejects.toThrow(
					"forbidden SESSION KV binding",
				);
			},
		);
	});

	it("fails closed if Astro restores SESSION in preview bindings", async () => {
		await withConfig(
			{
				...baseConfig,
				previews: { kv_namespaces: [{ binding: "SESSION" }] },
			},
			async (path) => {
				await expect(prepareWranglerDeploy(path)).rejects.toThrow(
					"forbidden SESSION KV binding",
				);
			},
		);
	});

	it("fails closed if generated R2 jurisdiction drifts", async () => {
		await withConfig(
			{
				...baseConfig,
				r2_buckets: baseConfig.r2_buckets.map((binding) =>
					binding.binding === "AVATARS_BUCKET"
						? { ...binding, jurisdiction: "eu" }
						: binding,
				),
			},
			async (path) => {
				await expect(prepareWranglerDeploy(path)).rejects.toThrow(
					"unexpected Wrangler deploy configuration",
				);
			},
		);
	});

	it("fails closed if the private email-intent service binding is missing", async () => {
		const { services: _services, ...withoutService } = baseConfig;
		await withConfig(withoutService, async (path) => {
			await expect(prepareWranglerDeploy(path)).rejects.toThrow(
				"unexpected Wrangler deploy configuration",
			);
		});
	});

	it("fails closed if the private email-intent entrypoint drifts", async () => {
		await withConfig(
			{
				...baseConfig,
				services: [
					{
						...baseConfig.services[0],
						entrypoint: "WrongEntrypoint",
					},
				],
			},
			async (path) => {
				await expect(prepareWranglerDeploy(path)).rejects.toThrow(
					"unexpected Wrangler deploy configuration",
				);
			},
		);
	});

	it("fails closed if the app regains a direct Queue binding", async () => {
		await withConfig(
			{
				...baseConfig,
				queues: {
					producers: [{ binding: "EMAIL_QUEUE", queue: "relayapi-email" }],
				},
			},
			async (path) => {
				await expect(prepareWranglerDeploy(path)).rejects.toThrow(
					"unexpected Wrangler deploy configuration",
				);
			},
		);
	});

	it("fails closed for the migration-filename contract marker", async () => {
		await withConfig(
			{
				...baseConfig,
				vars: { IDENTITY_DELETION_CONTRACT_VERSION: "0005" },
			},
			async (path) => {
				await expect(prepareWranglerDeploy(path)).rejects.toThrow(
					"unexpected Wrangler deploy configuration",
				);
			},
		);
	});

	it("fails closed without the reviewed identity-deletion contract marker", async () => {
		await withConfig(
			{
				...baseConfig,
				vars: { BASELINE_GENERATION: String(BASELINE_GENERATION) },
			},
			async (path) => {
				await expect(prepareWranglerDeploy(path)).rejects.toThrow(
					"unexpected Wrangler deploy configuration",
				);
			},
		);
	});

	it("fails closed when the generated baseline generation drifts", async () => {
		await withConfig(
			{
				...baseConfig,
				vars: {
					...baseConfig.vars,
					BASELINE_GENERATION: String(BASELINE_GENERATION + 1),
				},
			},
			async (path) => {
				await expect(prepareWranglerDeploy(path)).rejects.toThrow(
					"unexpected Wrangler deploy configuration",
				);
			},
		);
	});
});
