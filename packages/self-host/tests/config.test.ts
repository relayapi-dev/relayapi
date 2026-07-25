import { describe, expect, test } from "bun:test";
import { parsePostgresUrl } from "../src/cloudflare.js";
import { validateConfig, validateLock } from "../src/config.js";
import type { SelfHostConfig } from "../src/types.js";
import { compareVersions } from "../src/upgrade.js";

const baseConfig = {
	schemaVersion: 1,
	instance: "relayapi",
	cloudflare: {
		accountId: "account-id",
		zoneId: "zone-id",
		rootDomain: "example.com",
		apiHostname: "api.example.com",
		appHostname: "app.example.com",
		mediaHostname: "media.example.com",
		thumbnailHostname: "thumbs.example.com",
	},
	features: { email: false, ai: true, downloader: false },
} satisfies SelfHostConfig;

describe("self-host configuration", () => {
	test("accepts a minimal non-secret operator config", () => {
		expect(validateConfig(baseConfig)).toEqual(baseConfig);
	});

	test("rejects a hostname outside the configured zone", () => {
		expect(() =>
			validateConfig({
				...baseConfig,
				cloudflare: {
					...baseConfig.cloudflare,
					apiHostname: "api.example.net",
				},
			}),
		).toThrow("must belong to example.com");
	});

	test("requires a stable semantic version lock", () => {
		expect(() =>
			validateLock({
				schemaVersion: 1,
				channel: "stable",
				version: "main",
				sourceRepository: "relayapi-dev/relayapi",
				updatedAt: new Date().toISOString(),
			}),
		).toThrow("semantic version");
	});

	test("requires a GitHub owner/repository source lock", () => {
		expect(() =>
			validateLock({
				schemaVersion: 1,
				channel: "stable",
				version: "1.2.3",
				sourceRepository: "https://github.com/relayapi-dev/relayapi",
				updatedAt: new Date().toISOString(),
			}),
		).toThrow("owner/repository");
	});

	test("compares stable versions numerically for update selection", () => {
		expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
		expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
	});
});

describe("PostgreSQL URL parsing", () => {
	test("extracts a TLS Hyperdrive origin without logging the password", () => {
		const databaseUrl = [
			"postgresql://relay_runtime:",
			"p%40ss",
			"@db.example.com:6432/relay?sslmode=verify-full",
		].join("");
		expect(parsePostgresUrl(databaseUrl)).toEqual({
			hostname: "db.example.com",
			port: 6432,
			database: "relay",
			username: "relay_runtime",
			password: "p@ss",
			sslmode: "verify-full",
		});
	});

	test("rejects a URL without a password", () => {
		expect(() =>
			parsePostgresUrl("postgresql://runtime@db.example.com/relay"),
		).toThrow("username, and password");
	});
});
