import { describe, expect, mock, test } from "bun:test";
import { BASELINE_GENERATION } from "../../config/src/index.js";
import {
	deriveSelfHostSmokeCredential,
	probeWorkerDatabase,
} from "../src/deploy.js";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

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
