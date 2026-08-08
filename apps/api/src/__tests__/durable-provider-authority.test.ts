import { describe, expect, it } from "bun:test";
import {
	adCreationOperations,
	adMutationOperations,
	whatsappPhoneReleaseOperations,
} from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";

async function source(path: string): Promise<string> {
	return Bun.file(new URL(path, import.meta.url)).text();
}

describe("durable provider authority boundaries", () => {
	it("persists the exact revocable actor, session, workspace and generation", () => {
		for (const table of [adCreationOperations, adMutationOperations]) {
			const columns = getTableConfig(table).columns.map(
				(column) => column.name,
			);
			expect(columns).toEqual(
				expect.arrayContaining([
					"authority_key_id",
					"authority_principal_id",
					"authority_principal_type",
					"authority_user_id",
					"authority_member_id",
					"authority_session_id",
					"authority_workspace_id",
					"authority_requires_all_workspace_scope",
					"authority_credential_version",
					"authority_admitted_at",
					"authority_revision",
					"authority_revoked_at",
				]),
			);
		}
		const releaseColumns = getTableConfig(
			whatsappPhoneReleaseOperations,
		).columns.map((column) => column.name);
		expect(releaseColumns).toEqual(
			expect.arrayContaining([
				"authority_member_id",
				"authority_session_id",
				"authority_workspace_id",
				"authority_requires_all_workspace_scope",
				"prior_phone_status",
			]),
		);
	});

	it("revalidates authority inside the transaction before the exact ad CAS", async () => {
		const [creation, mutation] = await Promise.all([
			source("../services/ad-creation-operations.ts"),
			source("../services/ad-mutation-operations.ts"),
		]);
		const creationBoundary = creation.slice(
			creation.indexOf("export async function markAdProviderBoundary"),
			creation.indexOf("export async function confirmAdProviderBoundary"),
		);
		const mutationBoundary = mutation.slice(
			mutation.indexOf("async function markBoundary"),
			mutation.indexOf("async function failBeforeBoundary"),
		);
		for (const boundary of [creationBoundary, mutationBoundary]) {
			expect(
				boundary.indexOf("revalidateDurableCredentialAuthority"),
			).toBeLessThan(boundary.indexOf(".update("));
			expect(boundary).toContain("authorityRevision");
			expect(boundary).toContain("leaseToken");
			expect(boundary).toContain('"manual_review"');
			expect(boundary).not.toContain('status: "revocation_pending"');
			expect(boundary).toContain('"cancelled"');
		}
		expect(mutationBoundary).toContain("current.requiresLiveAuthority");
		expect(mutationBoundary).not.toContain("claim.row.requiresLiveAuthority");
	});

	it("puts reconciled activation replay behind a fresh authority boundary", async () => {
		const creation = await source("../services/ad-creation-operations.ts");
		const resume = creation.slice(
			creation.indexOf("async function resumeReconciledOperation"),
			creation.indexOf("export async function reconcileAdCreationOperations"),
		);
		const correlation = resume.indexOf("isBoostActivated");
		const boundary = resume.indexOf(
			"await markAdProviderBoundary",
			correlation,
		);
		const activation = resume.indexOf(
			"await context.adapter.creation.activateBoost",
			correlation,
		);
		expect(correlation).toBeGreaterThan(-1);
		expect(boundary).toBeGreaterThan(correlation);
		expect(boundary).toBeLessThan(activation);
		expect(resume.slice(boundary, activation)).toContain('"activation"');
	});

	it("fails closed on prior actor ownership and exposes no reauthorization wire", async () => {
		const [route, creation, mutation] = await Promise.all([
			source("../routes/ads.ts"),
			source("../services/ad-creation-operations.ts"),
			source("../services/ad-mutation-operations.ts"),
		]);
		expect(route).not.toContain("idempotency-reauthorize");
		expect(creation).not.toContain("reauthorize");
		expect(mutation).not.toContain("reauthorize");
		for (const operationSource of [creation, mutation]) {
			expect(operationSource).toContain(
				"This Idempotency-Key belongs to a different or revoked credential authority; use a new key.",
			);
		}
	});

	it("fences user phone release provider and DB-only completion paths", async () => {
		const phone = await source("../services/phone-number-operations.ts");
		const stage = phone.slice(
			phone.indexOf("export async function stagePhoneRelease"),
			phone.indexOf("export async function stageTenantPhoneReleases"),
		);
		const sourceScope = stage.indexOf("const [sourceScope]");
		expect(sourceScope).toBeGreaterThan(-1);
		expect(stage.indexOf('.for("share")', sourceScope)).toBeLessThan(
			stage.indexOf("await authorityAdmission", sourceScope),
		);

		const providerBoundary = phone.slice(
			phone.indexOf("async function markReleaseBoundary"),
			phone.indexOf("async function confirmReleasePhase"),
		);
		expect(
			providerBoundary.indexOf("revalidateDurableCredentialAuthority"),
		).toBeLessThan(providerBoundary.indexOf(".update("));
		expect(providerBoundary).toContain("releaseAuthorityRevision");

		const dbAdvance = phone.slice(
			phone.indexOf("async function advanceReleaseWithoutProviderBoundary"),
			phone.indexOf("async function loadReleaseAccessToken"),
		);
		expect(
			dbAdvance.indexOf("revalidateDurableCredentialAuthority"),
		).toBeLessThan(dbAdvance.indexOf(".update("));
		expect(dbAdvance).toContain("releaseAuthorityRevision");

		const processing = phone.slice(
			phone.indexOf("export async function processPhoneRelease"),
			phone.indexOf("export async function processDuePhoneReleases"),
		);
		for (const phase of ["meta", "stripe", "telnyx", "completed"]) {
			expect(processing).toMatch(
				new RegExp(
					`advanceReleaseWithoutProviderBoundary\\([\\s\\S]{0,100}?claim,\\s*"${phase}"`,
				),
			);
		}
	});

	it("keeps tenant deletion as the only null-authority bypass", async () => {
		const phone = await source("../services/phone-number-operations.ts");
		const snapshot = phone.slice(
			phone.indexOf("function releaseAuthoritySnapshot"),
			phone.indexOf("function releaseAuthorityValues"),
		);
		expect(snapshot).toContain(
			'if (row.releaseReason === "tenant_deleted") return null',
		);
		const stage = phone.slice(
			phone.indexOf("export async function stagePhoneRelease"),
			phone.indexOf("export async function stageTenantPhoneReleases"),
		);
		expect(stage).toContain('if (reason === "user_requested")');
		expect(stage).toContain(
			"Phone release admission requires live billing authority",
		);
	});
});
