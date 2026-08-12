import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	attestCutoverStamp,
	attestWorkerGeneration,
	decideBaselineGeneration,
	formatDecisionWarning,
	inspectLiveWorker,
	readLiveBaselineGeneration,
	resolveApplicationBaselineGeneration,
	writeDecision,
} from "./check-live-baseline-generation";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("live baseline generation deploy guard", () => {
	it("holds prepared generation-2 code until the authorized cutover", () => {
		expect(
			resolveApplicationBaselineGeneration({
				applicationGeneration: 2,
				repositoryGeneration: 1,
				repositoryLifecycle: "sealed",
				policyLifecycle: "sealed",
				authorizedFromGeneration: 1,
				authorizedToGeneration: 2,
			}),
		).toBe(2);
		expect(() =>
			resolveApplicationBaselineGeneration({
				applicationGeneration: 3,
				repositoryGeneration: 1,
				repositoryLifecycle: "sealed",
				policyLifecycle: "sealed",
				authorizedFromGeneration: 1,
				authorizedToGeneration: 2,
			}),
		).toThrow("authorized immediate cutover target");
	});

	it("allows only a matching generation or the explicit generation-1 bootstrap", () => {
		expect(
			decideBaselineGeneration({
				applicationGeneration: 1,
				repositoryGeneration: 1,
				liveGeneration: null,
				allowInitialBootstrap: true,
			}),
		).toMatchObject({ allowed: true, reason: "initial-bootstrap" });
		expect(
			decideBaselineGeneration({
				applicationGeneration: 2,
				repositoryGeneration: 2,
				liveGeneration: 2,
				allowInitialBootstrap: false,
			}),
		).toMatchObject({ allowed: true, reason: "match" });
		for (const liveGeneration of [null, 1, 3]) {
			expect(
				decideBaselineGeneration({
					applicationGeneration: 2,
					repositoryGeneration: 2,
					liveGeneration,
					allowInitialBootstrap: true,
				}),
			).toMatchObject({ allowed: false, reason: "generation-mismatch" });
		}
	});

	it("never treats live generation 2 as compatible while repository metadata remains generation 1", () => {
		for (const liveGeneration of [null, 1, 2]) {
			expect(
				decideBaselineGeneration({
					applicationGeneration: 2,
					repositoryGeneration: 1,
					liveGeneration,
					allowInitialBootstrap: true,
				}),
			).toMatchObject({
				allowed: false,
				applicationGeneration: 2,
				repositoryGeneration: 1,
				liveGeneration,
				reason: "generation-mismatch",
			});
		}
	});

	it("emits a legible GitHub warning only for an intentional generation hold", () => {
		expect(
			formatDecisionWarning({
				allowed: false,
				applicationGeneration: 2,
				repositoryGeneration: 2,
				liveGeneration: 1,
				reason: "generation-mismatch",
			}),
		).toBe(
			"::warning title=Baseline generation deploy held::Automatic deploy held: application target generation 2, repository generation 2, and live API generation 1 are not mutually compatible. Use the protected pre-live baseline cutover workflow to advance generations.",
		);
		expect(
			formatDecisionWarning({
				allowed: true,
				applicationGeneration: 2,
				repositoryGeneration: 2,
				liveGeneration: 2,
				reason: "match",
			}),
		).toBeNull();
	});

	it("returns successfully while exposing every held decision output", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "baseline-generation-guard-"),
		);
		const output = join(directory, "github-output");
		const originalOutput = process.env.GITHUB_OUTPUT;
		const originalWarn = console.warn;
		const originalLog = console.log;
		let warning = "";
		try {
			process.env.GITHUB_OUTPUT = output;
			console.warn = (...values: unknown[]) => {
				warning = values.join(" ");
			};
			console.log = () => {};
			await expect(
				writeDecision({
					allowed: false,
					applicationGeneration: 2,
					repositoryGeneration: 2,
					liveGeneration: 1,
					reason: "generation-mismatch",
				}),
			).resolves.toBeUndefined();
			expect(await readFile(output, "utf8")).toBe(
				[
					"automatic_deploy_allowed=false",
					"application_generation=2",
					"repository_generation=2",
					"live_generation=1",
					"reason=generation-mismatch",
					"",
				].join("\n"),
			);
			expect(warning).toContain(
				"::warning title=Baseline generation deploy held::",
			);
		} finally {
			if (originalOutput === undefined) {
				delete process.env.GITHUB_OUTPUT;
			} else {
				process.env.GITHUB_OUTPUT = originalOutput;
			}
			console.warn = originalWarn;
			console.log = originalLog;
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("reads the active API Worker plain-text generation binding", async () => {
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith("/deployments")) {
					return Response.json({
						success: true,
						result: {
							deployments: [
								{ versions: [{ version_id: "version-1", percentage: 100 }] },
							],
						},
					});
				}
				if (url.endsWith("/versions/version-1")) {
					return Response.json({
						success: true,
						result: {
							resources: {
								bindings: [
									{
										name: "BASELINE_GENERATION",
										type: "plain_text",
										text: "2",
									},
								],
							},
						},
					});
				}
				throw new Error(`Unhandled request ${url}`);
			}),
			{ preconnect: originalFetch.preconnect },
		);
		expect(await readLiveBaselineGeneration("account", "token")).toBe(2);
	});

	it("fails closed on an ambiguous or malformed active deployment", async () => {
		globalThis.fetch = Object.assign(
			mock(async () =>
				Response.json({
					success: true,
					result: {
						deployments: [
							{
								versions: [
									{ version_id: "old", percentage: 50 },
									{ version_id: "new", percentage: 50 },
								],
							},
						],
					},
				}),
			),
			{ preconnect: originalFetch.preconnect },
		);
		await expect(
			readLiveBaselineGeneration("account", "token"),
		).rejects.toThrow("split_deployment");
		expect(await inspectLiveWorker("account", "token", "app")).toMatchObject({
			status: "hold",
			target: "app",
			reason: "split_deployment",
		});
	});

	it("attests exact API and App generation-1 version IDs and source SHA tags", async () => {
		const sourceSha = "a".repeat(40);
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL) => {
				const url = String(input);
				const target = url.includes("/relayapi-app/") ? "app" : "api";
				if (url.endsWith("/deployments")) {
					return Response.json({
						success: true,
						result: {
							deployments: [
								{
									versions: [
										{ version_id: `${target}-version`, percentage: 100 },
									],
								},
							],
						},
					});
				}
				if (url.includes("/versions/")) {
					return Response.json({
						success: true,
						result: {
							annotations: {
								"workers/tag": `baseline-1-stamp-${sourceSha}`,
								"workers/message": `Generation 1 stamp ${sourceSha}`,
							},
							resources: {
								bindings: [
									{
										name: "BASELINE_GENERATION",
										type: "plain_text",
										text: "1",
									},
								],
							},
						},
					});
				}
				throw new Error(`Unhandled request ${url}`);
			}),
			{ preconnect: originalFetch.preconnect },
		);
		await expect(
			attestCutoverStamp({
				accountId: "account",
				token: "token",
				sourceCommitSha: sourceSha,
				apiVersionId: "api-version",
				appVersionId: "app-version",
			}),
		).resolves.toMatchObject({ ok: true, holds: [] });
		await expect(
			attestWorkerGeneration({
				accountId: "account",
				token: "token",
				generation: 1,
			}),
		).resolves.toMatchObject({ ok: true, generation: 1, holds: [] });
		const held = await attestCutoverStamp({
			accountId: "account",
			token: "token",
			sourceCommitSha: sourceSha,
			apiVersionId: "wrong-api-version",
			appVersionId: "app-version",
		});
		expect(held.ok).toBeFalse();
		expect(held.holds).toContainEqual({
			target: "api",
			reason: "version_id_mismatch",
		});
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL) => {
				const url = String(input);
				const target = url.includes("/relayapi-app/") ? "app" : "api";
				if (url.endsWith("/deployments")) {
					return Response.json({
						success: true,
						result: {
							deployments: [
								{
									versions: [
										{ version_id: `${target}-version`, percentage: 100 },
									],
								},
							],
						},
					});
				}
				return Response.json({
					success: true,
					result: {
						annotations: {
							"workers/tag": `baseline-1-stamp-${sourceSha}`,
							"workers/message": "forged-message",
						},
						resources: {
							bindings: [
								{
									name: "BASELINE_GENERATION",
									type: "plain_text",
									text: "1",
								},
							],
						},
					},
				});
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const forged = await attestCutoverStamp({
			accountId: "account",
			token: "token",
			sourceCommitSha: sourceSha,
			apiVersionId: "api-version",
			appVersionId: "app-version",
		});
		expect(forged.holds).toContainEqual({
			target: "api",
			reason: "source_sha_message_mismatch",
		});
	});

	it("returns a typed hold for an absent worker", async () => {
		globalThis.fetch = Object.assign(
			mock(async () =>
				Response.json(
					{ success: false, errors: [{ message: "not found" }] },
					{ status: 404 },
				),
			),
			{ preconnect: originalFetch.preconnect },
		);
		expect(await inspectLiveWorker("account", "token", "app")).toMatchObject({
			status: "hold",
			target: "app",
			reason: "worker_absent",
		});
	});
});
