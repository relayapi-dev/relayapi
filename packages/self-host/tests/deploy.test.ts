import { describe, expect, mock, test } from "bun:test";
import {
	access,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE_GENERATION } from "../../config/src/index.js";
import {
	deploy,
	deployWorker,
	deriveSelfHostSmokeCredential,
	probeWorkerDatabase,
	rolloutRecoveryError,
} from "../src/deploy.js";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;
const UPLOADED_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const RECONCILED_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const CONTAINER_VERSION_ID = "33333333-3333-4333-8333-333333333333";

function versionInspection(
	id: string,
	secretNames: readonly string[],
	overrides: { etag?: string; hyperdriveId?: string } = {},
): string {
	return JSON.stringify({
		id,
		resources: {
			bindings: [
				{
					name: "HYPERDRIVE",
					type: "hyperdrive",
					id: overrides.hyperdriveId ?? "hyperdrive-id",
				},
				...secretNames.map((name) => ({ name, type: "secret_text" })),
			],
			script: {
				etag: overrides.etag ?? "worker-script-sha256",
				handlers: ["fetch"],
				last_deployed_from: "wrangler",
			},
			script_runtime: {
				compatibility_date: "2026-08-01",
				compatibility_flags: ["nodejs_compat"],
			},
		},
	});
}

async function writeVersionUploadOutput(
	options: { env?: NodeJS.ProcessEnv } | undefined,
): Promise<void> {
	const path = options?.env?.WRANGLER_OUTPUT_FILE_PATH;
	if (!path)
		throw new Error("test runner did not receive Wrangler output path");
	await writeFile(
		path,
		`${JSON.stringify({
			type: "version-upload",
			version: 1,
			version_id: UPLOADED_VERSION_ID,
		})}\n`,
	);
}

async function appendDeployOutput(
	options: { env?: NodeJS.ProcessEnv } | undefined,
): Promise<void> {
	const path = options?.env?.WRANGLER_OUTPUT_FILE_PATH;
	if (!path)
		throw new Error("test runner did not receive Wrangler output path");
	await writeFile(
		path,
		`${JSON.stringify({
			type: "deploy",
			version: 1,
			version_id: CONTAINER_VERSION_ID,
		})}\n`,
		{ flag: "a" },
	);
}

function databaseAttestation(
	overrides: {
		ok?: boolean;
		status?: string;
		applicationBaselineGeneration?: number;
		configuredBaselineGeneration?: string;
	} = {},
) {
	return {
		ok: overrides.ok ?? true,
		control: {
			status: overrides.status ?? "open",
			application_baseline_generation:
				overrides.applicationBaselineGeneration ?? BASELINE_GENERATION,
			configured_baseline_generation:
				overrides.configuredBaselineGeneration ?? String(BASELINE_GENERATION),
		},
		database: { name: "relayapi", user: "relayapi_runtime" },
	};
}

describe("self-host database cutover smoke", () => {
	test("validates the complete encryption key ring before external preflight", async () => {
		const source = await Bun.file(
			`${repositoryRoot}packages/self-host/src/deploy.ts`,
		).text();
		expect(source).toContain(
			'validateEncryptionKeyRing(requiredEnvironment("ENCRYPTION_KEY"))',
		);
		expect(source.indexOf("validateEncryptionKeyRing(")).toBeLessThan(
			source.indexOf("await verifySelfHostDatabaseContract("),
		);
		expect(source.indexOf("validateEncryptionKeyRing(")).toBeLessThan(
			source.indexOf("new CloudflareClient("),
		);
	});

	test("derives a stable token and stores only its domain-separated digest", () => {
		const first = deriveSelfHostSmokeCredential("a-strong-secret-".repeat(4));
		const second = deriveSelfHostSmokeCredential("a-strong-secret-".repeat(4));
		const other = deriveSelfHostSmokeCredential("another-secret-".repeat(4));
		expect(first).toEqual(second);
		expect(first.token).not.toBe(first.digest);
		expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(other).not.toEqual(first);
		expect(() => deriveSelfHostSmokeCredential("too-short")).toThrow(
			"at least 32 bytes",
		);
	});

	test("accepts only the expected database identity from the no-store endpoint", async () => {
		const fetcher = Object.assign(
			mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://api.example.com/internal/cutover-smoke?probe=database",
				);
				expect(
					new Headers(init?.headers).get("x-relayapi-maintenance-smoke-bypass"),
				).toBe("derived-token");
				expect(init?.redirect).toBe("error");
				return Response.json(databaseAttestation(), {
					headers: { "Cache-Control": "no-store" },
				});
			}),
			{ preconnect: fetch.preconnect },
		);
		await expect(
			probeWorkerDatabase({
				label: "API",
				hostname: "api.example.com",
				token: "derived-token",
				expectedDatabase: "relayapi",
				expectedUser: "relayapi_runtime",
				fetcher,
			}),
		).resolves.toBeUndefined();
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	test("rejects blocked lifecycle states and baseline-generation mismatches", async () => {
		const scenarios = [
			{ label: "ok=false", body: databaseAttestation({ ok: false }) },
			{
				label: "blocked",
				body: databaseAttestation({ status: "blocked" }),
			},
			{
				label: "maintenance",
				body: databaseAttestation({ status: "maintenance" }),
			},
			{
				label: "draining",
				body: databaseAttestation({ status: "draining" }),
			},
			{
				label: "application baseline mismatch",
				body: databaseAttestation({
					applicationBaselineGeneration: BASELINE_GENERATION + 1,
				}),
			},
			{
				label: "configured baseline mismatch",
				body: databaseAttestation({
					configuredBaselineGeneration: String(BASELINE_GENERATION + 1),
				}),
			},
		] as const;

		for (const scenario of scenarios) {
			const fetcher = Object.assign(
				mock(async () =>
					Response.json(scenario.body, {
						headers: { "Cache-Control": "no-store" },
					}),
				),
				{ preconnect: fetch.preconnect },
			);
			await expect(
				probeWorkerDatabase({
					label: "API",
					hostname: "api.example.com",
					token: "derived-token",
					expectedDatabase: "relayapi",
					expectedUser: "relayapi_runtime",
					fetcher,
					retryDelaysMs: [],
				}),
			).rejects.toThrow(
				`API Worker database probe returned a non-open, generation-mismatched, or unexpected database attestation`,
			);
			expect(fetcher).toHaveBeenCalledTimes(1);
		}
	});
});

describe("self-host Worker rollout", () => {
	test("gates Cloudflare reconciliation behind sealed source verification", async () => {
		const source = await Bun.file(
			`${repositoryRoot}packages/self-host/src/deploy.ts`,
		).text();
		const deployBody = source.slice(
			source.indexOf("export async function deploy"),
		);
		const sourceGate = deployBody.indexOf("await withResolvedSource(");
		expect(sourceGate).toBeGreaterThanOrEqual(0);
		expect(sourceGate).toBeLessThan(
			deployBody.indexOf("reconcileCloudflareResources({"),
		);
	});

	test("requires an explicit acknowledgement for local source deployment", async () => {
		await expect(
			deploy({
				configPath: "/operator/relayapi.selfhost.json",
				nonInteractive: true,
				dryRun: false,
				force: false,
				source: "/checkout",
			}),
		).rejects.toThrow("requires --allow-unsealed-source");
	});

	test("activates only an inspected code-and-secret candidate and removes the secret file", async () => {
		const sourceRoot = await mkdtemp(join(tmpdir(), "relayapi-worker-source-"));
		let secretsPath = "";
		const commandKinds: string[] = [];
		try {
			await deployWorker({
				configPath: "/operator/.relayapi/generated/api.wrangler.json",
				secrets: { ENCRYPTION_KEY: "secret-value" },
				sourceRoot,
				version: "1.2.3",
				label: "API",
				runner: async (command, args, options) => {
					expect(command).toBe("bunx");
					expect(options?.cwd).toBe(sourceRoot);
					if (args.slice(0, 3).join(" ") === "wrangler versions upload") {
						commandKinds.push("upload");
						expect(args).toContain("--secrets-file");
						expect(args).toContain("--strict");
						expect(args.join(" ")).toContain("relayapi-1.2.3-api-");
						secretsPath = args[args.indexOf("--secrets-file") + 1] ?? "";
						expect(JSON.parse(await readFile(secretsPath, "utf8"))).toEqual({
							ENCRYPTION_KEY: "secret-value",
						});
						expect((await stat(secretsPath)).mode & 0o777).toBe(0o600);
						await writeVersionUploadOutput(options);
						return;
					}
					if (args.slice(0, 3).join(" ") === "wrangler versions deploy") {
						commandKinds.push("deploy");
						expect(args).toContain(`${UPLOADED_VERSION_ID}@100%`);
						expect(args).toContain("--yes");
						return;
					}
					if (args.slice(0, 3).join(" ") === "wrangler triggers deploy") {
						commandKinds.push("triggers");
						return;
					}
					throw new Error(`unexpected command: ${args.join(" ")}`);
				},
				captureRunner: async (_command, args) => {
					expect(args.slice(0, 3)).toEqual(["wrangler", "versions", "view"]);
					return versionInspection(UPLOADED_VERSION_ID, ["ENCRYPTION_KEY"]);
				},
			});
			expect(commandKinds).toEqual(["upload", "deploy", "triggers"]);
			await expect(access(secretsPath)).rejects.toThrow();
		} finally {
			await rm(sourceRoot, { recursive: true, force: true });
		}
	});

	test("preflights and applies Container images before accepting the final rollout", async () => {
		const sourceRoot = await mkdtemp(join(tmpdir(), "relayapi-worker-source-"));
		const commandKinds: string[] = [];
		try {
			await deployWorker({
				configPath: "/operator/.relayapi/generated/api.wrangler.json",
				secrets: { ENCRYPTION_KEY: "secret-value" },
				sourceRoot,
				version: "1.2.3",
				label: "API",
				deployContainers: true,
				runner: async (_command, args, options) => {
					if (
						args.slice(0, 2).join(" ") === "wrangler deploy" &&
						args.includes("--dry-run")
					) {
						commandKinds.push("container-preflight");
						expect(args).toContain("immediate");
						expect(options?.env?.DOCKER_DEFAULT_PLATFORM).toBe("linux/amd64");
						return;
					}
					if (args.slice(0, 3).join(" ") === "wrangler versions upload") {
						commandKinds.push("upload");
						await writeVersionUploadOutput(options);
						return;
					}
					if (args.slice(0, 3).join(" ") === "wrangler versions deploy") {
						commandKinds.push("candidate-deploy");
						return;
					}
					if (args.slice(0, 2).join(" ") === "wrangler deploy") {
						commandKinds.push("container-deploy");
						expect(args).toContain("--strict");
						expect(args).toContain("--secrets-file");
						expect(args).toContain("gradual");
						expect(options?.env?.DOCKER_DEFAULT_PLATFORM).toBe("linux/amd64");
						await appendDeployOutput(options);
						return;
					}
					if (args.slice(0, 3).join(" ") === "wrangler triggers deploy") {
						commandKinds.push("triggers");
						return;
					}
					throw new Error(`unexpected command: ${args.join(" ")}`);
				},
				captureRunner: async (_command, args) => {
					if (args[2] === "view" && args[3] === UPLOADED_VERSION_ID) {
						return versionInspection(UPLOADED_VERSION_ID, ["ENCRYPTION_KEY"]);
					}
					if (args[2] === "view" && args[3] === CONTAINER_VERSION_ID) {
						return versionInspection(CONTAINER_VERSION_ID, ["ENCRYPTION_KEY"]);
					}
					throw new Error(`unexpected capture command: ${args.join(" ")}`);
				},
			});
			expect(commandKinds).toEqual([
				"container-preflight",
				"upload",
				"container-deploy",
				"candidate-deploy",
				"triggers",
			]);
		} finally {
			await rm(sourceRoot, { recursive: true, force: true });
		}
	});

	test("removes the secret file when Wrangler fails", async () => {
		const sourceRoot = await mkdtemp(join(tmpdir(), "relayapi-worker-source-"));
		let secretsPath = "";
		try {
			await expect(
				deployWorker({
					configPath: "/operator/app.wrangler.json",
					secrets: { BETTER_AUTH_SECRET: "secret-value" },
					sourceRoot,
					version: "1.2.3",
					label: "dashboard",
					runner: async (_command, args) => {
						secretsPath = args[args.indexOf("--secrets-file") + 1] ?? "";
						throw new Error("upload failed");
					},
					captureRunner: async () => {
						throw new Error("capture should not run");
					},
				}),
			).rejects.toThrow("upload failed");
			await expect(access(secretsPath)).rejects.toThrow();
		} finally {
			await rm(sourceRoot, { recursive: true, force: true });
		}
	});

	test("removes obsolete Google secrets before activating the exact candidate", async () => {
		const sourceRoot = await mkdtemp(join(tmpdir(), "relayapi-worker-source-"));
		const calls: string[][] = [];
		const deletedNames: string[] = [];
		let finalTag = "";
		try {
			await deployWorker({
				configPath: "/operator/.relayapi/generated/app.wrangler.json",
				secrets: { BETTER_AUTH_SECRET: "desired-auth-value" },
				sourceRoot,
				version: "1.2.3",
				label: "dashboard",
				runner: async (_command, args, options) => {
					calls.push(args);
					if (args.slice(0, 3).join(" ") === "wrangler versions upload") {
						await writeVersionUploadOutput(options);
						return;
					}
					if (
						args.slice(0, 4).join(" ") === "wrangler versions secret delete"
					) {
						deletedNames.push(args[4] ?? "");
						finalTag = args[args.indexOf("--tag") + 1] ?? "";
						expect(options?.stdin).toBe("y\n");
						return;
					}
				},
				captureRunner: async (_command, args) => {
					if (args[2] === "view" && args[3] === UPLOADED_VERSION_ID) {
						return versionInspection(UPLOADED_VERSION_ID, [
							"BETTER_AUTH_SECRET",
							"GOOGLE_CLIENT_ID",
							"GOOGLE_CLIENT_SECRET",
						]);
					}
					if (args[2] === "list") {
						return JSON.stringify([
							{
								id: RECONCILED_VERSION_ID,
								annotations: { "workers/tag": finalTag },
							},
						]);
					}
					if (args[2] === "view" && args[3] === RECONCILED_VERSION_ID) {
						return versionInspection(RECONCILED_VERSION_ID, [
							"BETTER_AUTH_SECRET",
						]);
					}
					throw new Error(`unexpected capture command: ${args.join(" ")}`);
				},
			});
			expect(deletedNames).toEqual([
				"GOOGLE_CLIENT_ID",
				"GOOGLE_CLIENT_SECRET",
			]);
			expect(finalTag).toEndWith("-reconciled");
			expect(
				calls.some(
					(args) =>
						args.slice(0, 3).join(" ") === "wrangler versions deploy" &&
						args.includes(`${RECONCILED_VERSION_ID}@100%`),
				),
			).toBe(true);
			expect(
				calls.some(
					(args) => args.slice(0, 3).join(" ") === "wrangler triggers deploy",
				),
			).toBe(true);
			expect(JSON.stringify(calls)).not.toContain("desired-auth-value");
		} finally {
			await rm(sourceRoot, { recursive: true, force: true });
		}
	});

	test("fails closed with an actionable error when obsolete-secret removal does not converge", async () => {
		const sourceRoot = await mkdtemp(join(tmpdir(), "relayapi-worker-source-"));
		let finalTag = "";
		const activated: string[][] = [];
		try {
			await expect(
				deployWorker({
					configPath: "/operator/.relayapi/generated/app.wrangler.json",
					secrets: { BETTER_AUTH_SECRET: "desired-auth-value" },
					sourceRoot,
					version: "1.2.3",
					label: "dashboard",
					runner: async (_command, args, options) => {
						if (args.slice(0, 3).join(" ") === "wrangler versions upload") {
							await writeVersionUploadOutput(options);
							return;
						}
						if (
							args.slice(0, 4).join(" ") === "wrangler versions secret delete"
						) {
							finalTag = args[args.indexOf("--tag") + 1] ?? "";
							return;
						}
						activated.push(args);
					},
					captureRunner: async (_command, args) => {
						if (args[2] === "list") {
							return JSON.stringify([
								{
									id: RECONCILED_VERSION_ID,
									annotations: { "workers/tag": finalTag },
								},
							]);
						}
						if (args[3] === UPLOADED_VERSION_ID) {
							return versionInspection(UPLOADED_VERSION_ID, [
								"BETTER_AUTH_SECRET",
								"GOOGLE_CLIENT_SECRET",
							]);
						}
						return versionInspection(RECONCILED_VERSION_ID, [
							"BETTER_AUTH_SECRET",
							"GOOGLE_CLIENT_SECRET",
						]);
					},
				}),
			).rejects.toThrow(
				"dashboard Worker secret reconciliation did not converge (unexpected names: GOOGLE_CLIENT_SECRET); live traffic was not changed",
			);
			expect(activated).toEqual([]);
		} finally {
			await rm(sourceRoot, { recursive: true, force: true });
		}
	});

	test("identifies the obsolete binding when Wrangler cannot stage its removal", async () => {
		const sourceRoot = await mkdtemp(join(tmpdir(), "relayapi-worker-source-"));
		try {
			await expect(
				deployWorker({
					configPath: "/operator/.relayapi/generated/app.wrangler.json",
					secrets: { BETTER_AUTH_SECRET: "desired-auth-value" },
					sourceRoot,
					version: "1.2.3",
					label: "dashboard",
					runner: async (_command, args, options) => {
						if (args.slice(0, 3).join(" ") === "wrangler versions upload") {
							await writeVersionUploadOutput(options);
							return;
						}
						throw new Error("Wrangler unavailable");
					},
					captureRunner: async () =>
						versionInspection(UPLOADED_VERSION_ID, [
							"BETTER_AUTH_SECRET",
							"GOOGLE_CLIENT_SECRET",
						]),
				}),
			).rejects.toThrow(
				"dashboard Worker could not stage removal of obsolete secret binding GOOGLE_CLIENT_SECRET; live traffic was not changed",
			);
		} finally {
			await rm(sourceRoot, { recursive: true, force: true });
		}
	});

	test("describes forward repair and guarded rollback without attempting it", () => {
		const error = rolloutRecoveryError({
			stage: "dashboard Worker database probe",
			cause: new Error("HTTP 503"),
			version: "1.2.3",
			operatorConfigPath: "/operator/relayapi.selfhost.json",
			rollbackWorkerNames: ["relayapi-selfhost-app"],
		});
		expect(error.message).toContain("Forward repair");
		expect(error.message).toContain("@relayapi/self-host@1.2.3 deploy");
		expect(error.message).toContain("Database migrations are forward-only");
		expect(error.message).toContain("wrangler deployments list --name");
		expect(error.message).toContain(
			"wrangler rollback PREVIOUS_VERSION_ID --name",
		);
		expect(error.message).toContain("HTTP 503");
	});
});
