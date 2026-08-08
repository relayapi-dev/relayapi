import { describe, expect, it } from "bun:test";
import { BASELINE_GENERATION } from "@relayapi/config";
import {
	assertWorkerDeployment,
	assertWorkerDomain,
} from "./verify-cloudflare-worker-deployment";

const appBindings = [
	{ name: "ASSETS", type: "assets" },
	{
		name: "IDENTITY_DELETION_CONTRACT_VERSION",
		type: "plain_text",
		text: "identity-deletion-v1",
	},
	{
		name: "BASELINE_GENERATION",
		type: "plain_text",
		text: String(BASELINE_GENERATION),
	},
	{
		name: "AVATARS_BUCKET",
		type: "r2_bucket",
		bucket_name: "relayapi-avatars",
	},
	{
		name: "EMAIL_INTENTS",
		type: "service",
		service: "relayapi",
		entrypoint: "EmailIntentEntrypoint",
	},
	{
		name: "HYPERDRIVE",
		type: "hyperdrive",
		id: "11180e4939824902a75753084dc6a8e9",
	},
	{ name: "IMAGES", type: "images" },
	{
		name: "KV",
		type: "kv_namespace",
		namespace_id: "c4e14913be2b41628ef71ae12561f7e8",
	},
	{
		name: "PUBLIC_ASSETS",
		type: "r2_bucket",
		bucket_name: "relayapi-public-assets",
	},
];

const runtime = {
	compatibility_date: "2026-07-18",
	compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
	usage_model: "standard",
};

const appObservability = {
	observability: {
		enabled: true,
		head_sampling_rate: 0.1,
		logs: {
			enabled: true,
			head_sampling_rate: 0.1,
			persist: true,
			invocation_logs: true,
		},
		traces: {
			enabled: false,
			persist: false,
			head_sampling_rate: 0.01,
		},
	},
};

describe("deployed browser Worker identity", () => {
	it("accepts the reviewed app version and custom domain", () => {
		expect(() =>
			assertWorkerDeployment(
				"app",
				{ resources: { bindings: appBindings, script_runtime: runtime } },
				appObservability,
			),
		).not.toThrow();
		expect(() =>
			assertWorkerDomain("app", [
				{
					hostname: "relayapi.dev",
					service: "relayapi-app",
					zone_name: "relayapi.dev",
				},
			]),
		).not.toThrow();
	});

	it("rejects a missing SSRF flag, retired binding, or wrong domain", () => {
		expect(() =>
			assertWorkerDeployment(
				"app",
				{
					resources: {
						bindings: appBindings,
						script_runtime: {
							...runtime,
							compatibility_flags: ["nodejs_compat"],
						},
					},
				},
				appObservability,
			),
		).toThrow("runtime");
		expect(() =>
			assertWorkerDeployment(
				"app",
				{
					resources: {
						bindings: [
							...appBindings,
							{ name: "RETIRED", type: "plain_text", text: "1" },
						],
						script_runtime: runtime,
					},
				},
				appObservability,
			),
		).toThrow("bindings");
		expect(() =>
			assertWorkerDomain("app", [
				{
					hostname: "relayapi.dev",
					service: "wrong-worker",
					zone_name: "relayapi.dev",
				},
			]),
		).toThrow("relayapi-app");
	});

	it("accepts only the docs assets binding", () => {
		expect(() =>
			assertWorkerDeployment(
				"docs",
				{
					resources: {
						bindings: [{ name: "ASSETS", type: "assets" }],
						script_runtime: runtime,
					},
				},
				{ observability: { enabled: true } },
			),
		).not.toThrow();
		expect(() =>
			assertWorkerDeployment(
				"docs",
				{
					resources: {
						bindings: [
							{ name: "ASSETS", type: "assets" },
							{ name: "STALE_SECRET", type: "secret_text" },
						],
						script_runtime: runtime,
					},
				},
				{ observability: { enabled: true } },
			),
		).toThrow("must not have secret bindings");
	});
});
