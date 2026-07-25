import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { secretGroups } from "./secrets";
import { assertWorkerSecretBindings } from "./verify-cloudflare-worker-secrets";

const appSpec = secretGroups.production.files.find(
	(spec) => spec.cloudflareTarget === "app",
);
if (!appSpec) throw new Error("Missing app production secret manifest");
const apiSpec = secretGroups.production.files.find(
	(spec) => spec.cloudflareTarget === "api",
);
if (!apiSpec) throw new Error("Missing API production secret manifest");

const binding = (name: string) => ({ name, type: "secret_text" });

describe("Cloudflare Worker secret policy", () => {
	it("fails closed on additive secret drift without mutating in preflight", () => {
		for (const target of ["api", "app"]) {
			const workflow = readFileSync(
				new URL(`../.github/workflows/deploy-${target}.yml`, import.meta.url),
				"utf8",
			);
			const preflight = `secrets:cf:preflight -- ${target}`;
			const exactVerify = `secrets:cf:verify -- ${target}`;
			const firstVerify = workflow.indexOf(preflight);
			const deploy = workflow.indexOf(`secrets:cf:deploy -- ${target} --`);
			const secondVerify = workflow.indexOf(exactVerify, firstVerify + 1);
			expect(firstVerify).toBeGreaterThan(-1);
			expect(deploy).toBeGreaterThan(firstVerify);
			expect(secondVerify).toBeGreaterThan(deploy);
			expect(workflow).not.toContain("secrets:cf:prune");
		}
	});

	it("accepts all required app secrets without optional OAuth", () => {
		expect(() =>
			assertWorkerSecretBindings(appSpec, appSpec.required.map(binding)),
		).not.toThrow();
	});

	it("rejects missing required account-email delivery", () => {
		expect(() =>
			assertWorkerSecretBindings(
				appSpec,
				appSpec.required
					.filter((name) => name !== "RESEND_API_KEY")
					.map(binding),
			),
		).toThrow("RESEND_API_KEY");
	});

	it("rejects a partially configured provider group", () => {
		expect(() =>
			assertWorkerSecretBindings(appSpec, [
				...appSpec.required.map(binding),
				binding("GOOGLE_CLIENT_ID"),
			]),
		).toThrow("GOOGLE_CLIENT_SECRET");
	});

	it("accepts either provider that owns a shared verification token", () => {
		const required = apiSpec.required.map(binding);
		expect(() =>
			assertWorkerSecretBindings(apiSpec, [
				...required,
				binding("FACEBOOK_APP_ID"),
				binding("FACEBOOK_APP_SECRET"),
				binding("FACEBOOK_WEBHOOK_VERIFY_TOKEN"),
			]),
		).not.toThrow();
		expect(() =>
			assertWorkerSecretBindings(apiSpec, [
				...required,
				binding("WHATSAPP_APP_ID"),
				binding("WHATSAPP_APP_SECRET"),
				binding("WHATSAPP_CONFIG_ID"),
				binding("FACEBOOK_WEBHOOK_VERIFY_TOKEN"),
			]),
		).not.toThrow();
	});

	it("rejects an orphaned shared verification token", () => {
		expect(() =>
			assertWorkerSecretBindings(apiSpec, [
				...apiSpec.required.map(binding),
				binding("FACEBOOK_WEBHOOK_VERIFY_TOKEN"),
			]),
		).toThrow("without a complete provider group");
	});

	it("rejects stale or cross-target secret bindings", () => {
		expect(() =>
			assertWorkerSecretBindings(apiSpec, [
				...apiSpec.required.map(binding),
				binding("BETTER_AUTH_SECRET"),
			]),
		).toThrow("outside target allowlist");
		expect(() =>
			assertWorkerSecretBindings(appSpec, [
				...appSpec.required.map(binding),
				binding("ENCRYPTION_KEY"),
			]),
		).toThrow("outside target allowlist");
	});

	it("rejects an allowed optional group that the encrypted vault disabled", () => {
		const expected = [...apiSpec.required];
		expect(() =>
			assertWorkerSecretBindings(
				apiSpec,
				[
					...apiSpec.required.map(binding),
					binding("FACEBOOK_APP_ID"),
					binding("FACEBOOK_APP_SECRET"),
					binding("FACEBOOK_WEBHOOK_VERIFY_TOKEN"),
				],
				expected,
			),
		).toThrow("encrypted vault intent");
		expect(() =>
			assertWorkerSecretBindings(
				apiSpec,
				apiSpec.required.map(binding),
				expected,
			),
		).not.toThrow();
	});

	it("allows a missing intended binding only during deploy convergence", () => {
		const expected = [...appSpec.required];
		const live = appSpec.required
			.filter((name) => name !== "RESEND_API_KEY")
			.map(binding);
		expect(() =>
			assertWorkerSecretBindings(appSpec, live, expected, true),
		).not.toThrow();
		expect(() => assertWorkerSecretBindings(appSpec, live, expected)).toThrow(
			"RESEND_API_KEY",
		);
	});

	it("rejects a CryptoKey masquerading as a required text secret", () => {
		const values = appSpec.required.map(binding);
		const resend = values.find((value) => value.name === "RESEND_API_KEY");
		if (!resend) throw new Error("missing RESEND_API_KEY fixture");
		resend.type = "secret_key";
		expect(() => assertWorkerSecretBindings(appSpec, values)).toThrow(
			"unsupported Worker secret binding types",
		);
	});
});
