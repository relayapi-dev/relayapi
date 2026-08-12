import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	AD_REPORT_POLICY,
	dispatchAdvancedAdReportJob,
} from "../services/ad-report-jobs";
import type { Env } from "../types";

describe("advanced ad report durability policy", () => {
	it("dispatches only durable tenant and report identifiers", async () => {
		const bodies: unknown[] = [];
		const metrics = { backlogCount: 0, backlogBytes: 0 };
		const queue: Queue = {
			metrics: async () => metrics,
			send: async (body: unknown) => {
				bodies.push(body);
				return { metadata: { metrics } };
			},
			sendBatch: async () => ({ metadata: { metrics } }),
		};
		await dispatchAdvancedAdReportJob(
			{ ADS_QUEUE: queue } satisfies Pick<Env, "ADS_QUEUE">,
			{ organizationId: "org_1", reportJobId: "adrep_1" },
		);

		expect(bodies).toEqual([
			{
				type: "advanced_report",
				org_id: "org_1",
				report_job_id: "adrep_1",
			},
		]);
	});

	it("keeps downloads, decompression, rows, and leases finitely bounded", () => {
		expect(AD_REPORT_POLICY.providerDownloadMaxBytes).toBe(32 * 1024 * 1024);
		expect(AD_REPORT_POLICY.decompressedMaxBytes).toBe(64 * 1024 * 1024);
		expect(AD_REPORT_POLICY.maxAutomaticAttempts).toBeGreaterThan(1);
		expect(AD_REPORT_POLICY.leaseSeconds).toBeGreaterThan(0);
		expect(AD_REPORT_POLICY.resultRetentionDays).toBe(7);
		expect(AD_REPORT_POLICY.terminalJobRetentionDays).toBe(90);
		expect(AD_REPORT_POLICY.retentionRowBatch).toBe(5_000);
		expect(AD_REPORT_POLICY.retentionRowMaxPasses).toBe(20);
		expect(
			AD_REPORT_POLICY.retentionRowBatch *
				AD_REPORT_POLICY.retentionRowMaxPasses,
		).toBe(100_000);
	});

	it("mounts advanced routes before the generic ads router and keeps R2 private", () => {
		const app = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
		const config = readFileSync(
			new URL("../../wrangler.jsonc", import.meta.url),
			"utf8",
		);
		expect(app.indexOf('app.route("/v1/ads", adsAdvancedRouter)')).toBeLessThan(
			app.indexOf('app.route("/v1/ads", adsRouter)'),
		);
		expect(config).toContain('"binding": "AD_REPORT_BUCKET"');
		expect(config).toContain('"bucket_name": "relayapi-ad-reports"');
		expect(config).not.toMatch(
			/AD_REPORT_BUCKET[\s\S]{0,300}(?:custom_domain|preview_url|r2\.dev)/,
		);
	});
});
