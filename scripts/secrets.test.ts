import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	isPlaceholder,
	secretGroups,
	selectCloudflareSecrets,
	unexpectedCloudflareSecretNames,
	validateEncryptionKeyRing,
	validateExampleValues,
	validateTargetValues,
	validateVaultStructure,
} from "./secrets";

describe("secret manifest validation", () => {
	it("stages secret sync as an undeployed Worker version", () => {
		const source = readFileSync(
			new URL("./secrets.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain('["versions", "secret", "bulk"');
		expect(source).not.toContain('["secret", "bulk"');
	});

	it("validates the runtime encryption key-ring grammar", () => {
		expect(() =>
			validateEncryptionKeyRing(
				`active=${"11".repeat(32)},old=${"22".repeat(32)}`,
			),
		).not.toThrow();
		expect(() => validateEncryptionKeyRing("11".repeat(32))).toThrow(
			/key-id=64-hex/,
		);
		expect(() => validateEncryptionKeyRing(`active=${"z".repeat(64)}`)).toThrow(
			/64 hexadecimal/,
		);
		expect(() =>
			validateEncryptionKeyRing(
				`active=${"11".repeat(32)},active=${"22".repeat(32)}`,
			),
		).toThrow(/duplicate key id/);
	});

	it("rejects placeholders without rejecting ordinary values", () => {
		expect(isPlaceholder("change-me-now")).toBe(true);
		expect(isPlaceholder("<replace-me>")).toBe(true);
		expect(isPlaceholder("https://service.invalid")).toBe(true);
		expect(isPlaceholder("real-secret-value")).toBe(false);
	});

	it("requires complete provider groups", () => {
		const spec = secretGroups.production.files.find(
			(file) => file.cloudflareTarget === "app",
		);
		if (!spec) throw new Error("missing app production manifest");
		expect(() =>
			validateTargetValues(spec, {
				BETTER_AUTH_SECRET: "auth-secret",
				RESEND_API_KEY: "resend-secret",
				STRIPE_SECRET_KEY: "stripe-secret",
				STRIPE_PRO_PRICE_ID: "price_123",
				GOOGLE_CLIENT_ID: "google-id",
			}),
		).toThrow("all or none");
	});

	it("supports provider groups that share a verification token", () => {
		const spec = secretGroups.production.files.find(
			(file) => file.cloudflareTarget === "api",
		);
		if (!spec) throw new Error("missing API production manifest");
		const required = Object.fromEntries(
			spec.required.map((key) => [
				key,
				key === "ENCRYPTION_KEY"
					? `active=${"11".repeat(32)}`
					: `${key.toLowerCase()}-value`,
			]),
		);
		expect(() =>
			validateTargetValues(spec, {
				...required,
				FACEBOOK_APP_ID: "facebook-id",
				FACEBOOK_APP_SECRET: "facebook-secret",
				FACEBOOK_WEBHOOK_VERIFY_TOKEN: "verify-token",
			}),
		).not.toThrow();
		expect(() =>
			validateTargetValues(spec, {
				...required,
				WHATSAPP_APP_ID: "whatsapp-id",
				WHATSAPP_APP_SECRET: "whatsapp-secret",
				WHATSAPP_CONFIG_ID: "whatsapp-config",
				FACEBOOK_WEBHOOK_VERIFY_TOKEN: "verify-token",
			}),
		).not.toThrow();
		expect(() =>
			validateTargetValues(spec, {
				...required,
				FACEBOOK_WEBHOOK_VERIFY_TOKEN: "orphaned-token",
			}),
		).toThrow("without a complete provider group");
	});

	it("rejects keys assigned to another Cloudflare target", () => {
		const spec = secretGroups.production.files.find(
			(file) => file.cloudflareTarget === "app",
		);
		if (!spec) throw new Error("missing app production manifest");
		expect(() =>
			validateTargetValues(spec, {
				BETTER_AUTH_SECRET: "auth-secret",
				RESEND_API_KEY: "resend-secret",
				STRIPE_SECRET_KEY: "stripe-secret",
				STRIPE_PRO_PRICE_ID: "price_123",
				ENCRYPTION_KEY: "api-only",
			}),
		).toThrow("outside its target allowlist");
	});

	it("identifies only deployed secret bindings outside the target allowlist", () => {
		const spec = secretGroups.production.files.find(
			(file) => file.cloudflareTarget === "api",
		);
		if (!spec) throw new Error("missing API production manifest");
		expect(
			unexpectedCloudflareSecretNames(spec, [
				{ name: "ENCRYPTION_KEY", type: "secret_text" },
				{ name: "API_BASE_URL", type: "secret_text" },
				{ name: "BETTER_AUTH_SECRET", type: "secret_text" },
				{ name: "PERF_LOGS", type: "plain_text" },
			]),
		).toEqual(["BETTER_AUTH_SECRET"]);
	});

	it("omits blank optional values from Cloudflare uploads", () => {
		const spec = secretGroups.production.files.find(
			(file) => file.cloudflareTarget === "app",
		);
		if (!spec) throw new Error("missing app production manifest");
		const selected = selectCloudflareSecrets(spec, {
			BETTER_AUTH_SECRET: "auth-secret",
			RESEND_API_KEY: "resend-secret",
			STRIPE_SECRET_KEY: "stripe-secret",
			STRIPE_PRO_PRICE_ID: "price_123",
			BETTER_AUTH_URL: "",
		});
		expect(selected).toEqual({
			BETTER_AUTH_SECRET: "auth-secret",
			RESEND_API_KEY: "resend-secret",
			STRIPE_SECRET_KEY: "stripe-secret",
			STRIPE_PRO_PRICE_ID: "price_123",
		});
	});

	it("allows placeholders only in examples and requires documented keys", () => {
		const spec = secretGroups.production.files.find(
			(file) => file.cloudflareTarget === "app",
		);
		if (!spec) throw new Error("missing app production manifest");
		expect(() =>
			validateExampleValues(spec, {
				BETTER_AUTH_SECRET: "replace-me",
				RESEND_API_KEY: "replace-me",
				STRIPE_SECRET_KEY: "replace-me",
				STRIPE_PRO_PRICE_ID: "replace-me",
			}),
		).not.toThrow();
		expect(() =>
			validateExampleValues(spec, {
				BETTER_AUTH_SECRET: "replace-me",
				RESEND_API_KEY: "replace-me",
				STRIPE_SECRET_KEY: "replace-me",
			}),
		).toThrow("STRIPE_PRO_PRICE_ID");
		expect(() =>
			validateExampleValues(spec, {
				BETTER_AUTH_SECRET: "a-real-secret",
				RESEND_API_KEY: "replace-me",
				STRIPE_SECRET_KEY: "replace-me",
				STRIPE_PRO_PRICE_ID: "replace-me",
			}),
		).toThrow("must use placeholders");
	});
});

describe("vault structure validation", () => {
	it("accepts ciphertext with the expected public key", () => {
		expect(
			validateVaultStructure(
				secretGroups.development,
				'DOTENV_PUBLIC_KEY_DEVELOPMENT="public"\nHELLO="encrypted:ciphertext"\n',
			),
		).toEqual({ HELLO: "encrypted:ciphertext" });
	});

	it("rejects plaintext and private keys", () => {
		expect(() =>
			validateVaultStructure(
				secretGroups.development,
				'DOTENV_PUBLIC_KEY_DEVELOPMENT="public"\nHELLO="plaintext"\n',
			),
		).toThrow("plaintext key HELLO");
		expect(() =>
			validateVaultStructure(
				secretGroups.development,
				'DOTENV_PUBLIC_KEY_DEVELOPMENT="public"\nDOTENV_PRIVATE_KEY_DEVELOPMENT="private"\nHELLO="encrypted:ciphertext"\n',
			),
		).toThrow("private key");
	});

	it("rejects a production key in a development vault", () => {
		expect(() =>
			validateVaultStructure(
				secretGroups.development,
				'DOTENV_PUBLIC_KEY_PRODUCTION="public"\nHELLO="encrypted:ciphertext"\n',
			),
		).toThrow("DOTENV_PUBLIC_KEY_DEVELOPMENT");
	});

	it("rejects duplicate vault assignments", () => {
		expect(() =>
			validateVaultStructure(
				secretGroups.development,
				'DOTENV_PUBLIC_KEY_DEVELOPMENT="public"\nHELLO="encrypted:first"\nHELLO="encrypted:second"\n',
			),
		).toThrow("duplicate assignment HELLO");
	});
});
