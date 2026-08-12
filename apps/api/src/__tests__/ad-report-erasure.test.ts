import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	adReportOrganizationPrefix,
	deleteExactAdReportArtifacts,
	expectedAdReportObjectKey,
} from "../services/ad-report-artifact-cleanup";

describe("advanced ad report artifact erasure", () => {
	it("derives tenant-contained object identities and deletes persisted exact keys", async () => {
		const deleted: string[][] = [];
		const bucket = {
			delete: async (keys: string | string[]) => {
				deleted.push(Array.isArray(keys) ? keys : [keys]);
			},
		} as unknown as R2Bucket;
		const key = expectedAdReportObjectKey({
			organizationId: "org_1",
			jobId: "adrep_1",
		});

		await expect(
			deleteExactAdReportArtifacts(bucket, [
				{
					id: "adrep_1",
					organizationId: "org_1",
					resultObjectKey: key,
				},
				{
					id: "adrep_without_artifact",
					organizationId: "org_1",
					resultObjectKey: null,
				},
			]),
		).resolves.toBe(1);
		expect(deleted).toEqual([["ad-reports/org_1/adrep_1/result"]]);
		expect(adReportOrganizationPrefix("org_1")).toBe("ad-reports/org_1/");
	});

	it("fails closed when a stored projection points outside its exact job key", async () => {
		let called = false;
		const bucket = {
			delete: async () => {
				called = true;
			},
		} as unknown as R2Bucket;

		await expect(
			deleteExactAdReportArtifacts(bucket, [
				{
					id: "adrep_1",
					organizationId: "org_1",
					resultObjectKey: "ad-reports/org_2/adrep_1/result",
				},
			]),
		).rejects.toThrow("does not match its tenant/job projection");
		expect(called).toBe(false);
	});

	it("removes objects before their owning projections", () => {
		const tenant = readFileSync(
			new URL("../services/tenant-deletion.ts", import.meta.url),
			"utf8",
		);
		const workspace = readFileSync(
			new URL("../services/workspace-erasure.ts", import.meta.url),
			"utf8",
		);
		const adService = readFileSync(
			new URL("../services/ad-service.ts", import.meta.url),
			"utf8",
		);
		expect(tenant).toContain("adReportOrganizationPrefix(job.organizationId)");
		const tenantStepOrder = tenant.slice(
			tenant.indexOf("export function tenantDeletionStepKeys"),
			tenant.indexOf("interface CleanupPayload"),
		);
		expect(tenantStepOrder).toMatch(
			/TENANT_EXTERNAL_STEP[\s\S]*TENANT_PURGE_TABLES\.map/u,
		);

		const cleanup = workspace.slice(
			workspace.indexOf("async function deleteAdReportJobsBatch"),
			workspace.indexOf("async function deleteExternalPostsBatch"),
		);
		expect(cleanup.indexOf("deleteExactAdReportArtifacts")).toBeLessThan(
			cleanup.indexOf("db.delete(adReportJobs)"),
		);
		const accountCleanup = adService.slice(
			adService.indexOf("async function pruneUnmatchedAdAccounts"),
			adService.indexOf("export async function discoverAdAccounts"),
		);
		expect(accountCleanup).toContain(
			"resultObjectKey: adReportJobs.resultObjectKey",
		);
		expect(accountCleanup.indexOf("deleteExactAdReportArtifacts")).toBeLessThan(
			accountCleanup.indexOf("db.delete(adAccounts)"),
		);
	});
});
