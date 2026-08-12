import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RESOURCE_NAMES } from "../src/constants.js";
import type { SelfHostConfig } from "../src/types.js";
import { apiWranglerConfig } from "../src/wrangler-config.js";

const config: SelfHostConfig = {
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
		hyperdriveCaCertificateId: "11111111-2222-4333-8444-555555555555",
	},
	features: { email: false, ai: false, downloader: false },
	resources: {
		kvNamespaceId: "kv-id",
		hyperdriveId: "hyperdrive-id",
		queues: {} as NonNullable<SelfHostConfig["resources"]>["queues"],
	},
};

describe("self-hosted advanced report artifacts", () => {
	test("binds a dedicated operator-owned private report bucket", () => {
		expect(RESOURCE_NAMES.buckets.adReports).toBe(
			"relayapi-selfhost-ad-reports",
		);
		const generated = apiWranglerConfig(config, "/source") as {
			r2_buckets: Array<{
				binding: string;
				bucket_name: string;
				jurisdiction?: string;
			}>;
		};
		expect(generated.r2_buckets).toContainEqual({
			binding: "AD_REPORT_BUCKET",
			bucket_name: RESOURCE_NAMES.buckets.adReports,
		});
	});

	test("converges eight-day expiry and documents the seven-day API horizon", () => {
		const cloudflare = readFileSync(
			new URL("../src/cloudflare.ts", import.meta.url),
			"utf8",
		);
		const readme = readFileSync(
			new URL("../README.md", import.meta.url),
			"utf8",
		);
		expect(cloudflare).toContain(
			'{ id: "relayapi-ad-report-expiry", expireDays: 8 }',
		);
		expect(readme).toContain("relayapi-selfhost-ad-reports");
		expect(readme).toContain("eight-day storage-side expiry");
		expect(readme).toContain("seven-day result horizon");
	});
});
