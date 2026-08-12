import { describe, expect, test } from "bun:test";
import { parsePostgresUrl } from "../src/cloudflare.js";
import { QUEUE_NAMES } from "../src/constants.js";
import {
	validateConfig,
	validateHyperdriveCaCertificateId,
	validateLock,
	withResolvedHyperdriveCaCertificateId,
} from "../src/config.js";
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
		publicHostname: "go.example.com",
		mediaHostname: "media.example.com",
		thumbnailHostname: "thumbs.example.com",
		r2Jurisdiction: "default",
	},
	features: { email: false, ai: true, downloader: false },
} satisfies SelfHostConfig;

describe("self-host configuration", () => {
	test("accepts a minimal non-secret operator config", () => {
		expect(validateConfig(baseConfig)).toEqual(baseConfig);
	});

	test("canonicalizes TikTok verified URL prefixes as non-secret publishing config", () => {
		expect(
			validateConfig({
				...baseConfig,
				publishing: {
					tiktokVerifiedUrlPrefixes: [
						"https://media.example.com/tiktok/",
						"https://media.example.com/tiktok/",
					],
				},
			}).publishing,
		).toEqual({
			tiktokVerifiedUrlPrefixes: ["https://media.example.com/tiktok/"],
		});

		for (const invalid of [
			"http://media.example.com/tiktok/",
			"https://user@media.example.com/tiktok/",
			"https://media.example.com:8443/tiktok/",
			"https://media.example.com/tiktok/?version=1",
			"https://media.example.com/tiktok/#media",
			"https://192.0.2.10/tiktok/",
			"https://[2001:db8::1]/tiktok/",
			"https://media.example.com/tiktok",
		]) {
			expect(() =>
				validateConfig({
					...baseConfig,
					publishing: { tiktokVerifiedUrlPrefixes: [invalid] },
				}),
			).toThrow("publishing.tiktokVerifiedUrlPrefixes[0]");
		}
	});

	test("upgrades an older config to explicit public-host and R2 defaults", () => {
		const legacy = structuredClone(baseConfig) as unknown as Record<
			string,
			unknown
		>;
		const cloudflare = legacy.cloudflare as Record<string, unknown>;
		delete cloudflare.publicHostname;
		delete cloudflare.r2Jurisdiction;
		expect(validateConfig(legacy).cloudflare).toMatchObject({
			publicHostname: "go.example.com",
			r2Jurisdiction: "default",
		});
	});

	test("accepts v1 resource pins from before media-processing queues existed", () => {
		const legacyQueues = Object.fromEntries(
			QUEUE_NAMES.filter(
				(name) =>
					name !== "media-processing" && name !== "media-processing-dlq",
			).map((name) => [name, `id-${name}`]),
		);
		const parsed = validateConfig({
			...baseConfig,
			resources: {
				kvNamespaceId: "kv-id",
				hyperdriveId: "hyperdrive-id",
				queues: legacyQueues,
			},
		});
		expect(parsed.resources?.queues.publish).toBe("id-publish");
		expect(parsed.resources?.queues["media-processing"]).toBeUndefined();
		expect(parsed.resources?.queues["media-processing-dlq"]).toBeUndefined();

		const missingLegacyQueue = structuredClone(legacyQueues);
		delete missingLegacyQueue.publish;
		expect(() =>
			validateConfig({
				...baseConfig,
				resources: {
					kvNamespaceId: "kv-id",
					hyperdriveId: "hyperdrive-id",
					queues: missingLegacyQueue,
				},
			}),
		).toThrow("resources.queues.publish");
	});

	test("validates and canonicalizes Hyperdrive CA certificate intent", () => {
		const certificateId = "A1111111-B222-4C33-8D44-E55555555555";
		expect(validateHyperdriveCaCertificateId(certificateId)).toBe(
			certificateId.toLowerCase(),
		);
		expect(
			validateConfig({
				...baseConfig,
				cloudflare: {
					...baseConfig.cloudflare,
					hyperdriveCaCertificateId: certificateId,
				},
			}).cloudflare.hyperdriveCaCertificateId,
		).toBe(certificateId.toLowerCase());
		expect(() => validateHyperdriveCaCertificateId("certificate-name")).toThrow(
			"Cloudflare certificate UUID",
		);
	});

	test("adopts legacy Hyperdrive CA intent once and rejects a conflicting pin", () => {
		const certificateId = "11111111-2222-4333-8444-555555555555";
		const resolved = withResolvedHyperdriveCaCertificateId(
			baseConfig,
			certificateId,
		);
		expect(resolved.cloudflare.hyperdriveCaCertificateId).toBe(certificateId);
		expect(baseConfig.cloudflare).not.toHaveProperty(
			"hyperdriveCaCertificateId",
		);
		expect(() =>
			withResolvedHyperdriveCaCertificateId(
				resolved,
				"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			),
		).toThrow("conflicts with relayapi.selfhost.json");
	});

	test("rejects unsupported R2 jurisdictions before provisioning", () => {
		expect(() =>
			validateConfig({
				...baseConfig,
				cloudflare: {
					...baseConfig.cloudflare,
					r2Jurisdiction: "fedramp",
				},
			}),
		).toThrow('must be "default" or "eu"');
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
		for (const version of [
			"main",
			"1.2.3-rc.1",
			"01.2.3",
			"1.02.3",
			"1.2.03",
		]) {
			expect(() =>
				validateLock({
					schemaVersion: 1,
					channel: "stable",
					version,
					sourceRepository: "relayapi-dev/relayapi",
					updatedAt: new Date().toISOString(),
				}),
			).toThrow("stable semantic version");
		}
		expect(
			validateLock({
				schemaVersion: 1,
				channel: "stable",
				version: "1.2.3",
				sourceRepository: "relayapi-dev/relayapi",
				sourceArchiveSha256: "A".repeat(64),
				updatedAt: new Date().toISOString(),
			}).sourceArchiveSha256,
		).toBe("a".repeat(64));
		expect(() =>
			validateLock({
				schemaVersion: 1,
				channel: "stable",
				version: "1.2.3",
				sourceRepository: "relayapi-dev/relayapi",
				sourceArchiveSha256: "not-a-digest",
				updatedAt: new Date().toISOString(),
			}),
		).toThrow("SHA-256 digest");
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
		expect(
			compareVersions("9007199254740993.0.0", "9007199254740992.999.999"),
		).toBeGreaterThan(0);
		expect(() => compareVersions("1.0.0-rc.1", "1.0.0")).toThrow(
			"stable semantic version",
		);
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
