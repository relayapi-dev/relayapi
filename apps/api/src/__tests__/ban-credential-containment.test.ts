import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(path: string): string {
	return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

describe("banned-user credential containment", () => {
	it("revalidates member credentials against the live user generation on misses and cache hits", () => {
		const auth = source("../middleware/auth.ts");

		expect(auth).toContain("keyCredentialVersion: apikey.credentialVersion");
		expect(auth).toContain("userCredentialVersion: user.credentialVersion");
		expect(auth).toContain(".leftJoin(user, eq(user.id, member.userId))");
		expect(auth.match(/hasActiveBan\(/g)?.length).toBeGreaterThanOrEqual(3);
		expect(
			auth.match(/normalizedCredentialVersion\(row\.keyCredentialVersion\)/g)
				?.length,
		).toBeGreaterThanOrEqual(1);
		expect(auth).toContain('row.principalKind === "service"');
		expect(auth).toContain('data.principal_type !== "dashboard_user"');
		expect(
			auth.match(/memberRole: member\.role/g)?.length,
		).toBeGreaterThanOrEqual(2);
		expect(
			auth.match(/hasCurrentDashboardCredentialPermissions\(/g)?.length,
		).toBeGreaterThanOrEqual(2);
		expect(auth).toContain(
			"permissionsMatch(row.permissions, data.permissions)",
		);
	});

	it("serializes dashboard and service issuers against every mutable authority row", () => {
		const route = source("../routes/api-keys.ts");

		expect(route.match(/\.for\("share"\)/g)?.length).toBeGreaterThanOrEqual(8);
		expect(route).toContain("credentialVersion: user.credentialVersion");
		expect(route).toContain(
			"hasActiveBan(lockedDashboardUser, finalAuthorityTime)",
		);
		expect(route).toContain(
			"lockedDashboardSession.expiresAt <= finalAuthorityTime",
		);
		expect(route.match(/eq\(apikey\.key, c\.get\("keyHash"\)\)/g)?.length).toBe(
			2,
		);
		expect(
			route.match(/hasCurrentDashboardCredentialPermissions\(/g)?.length,
		).toBe(1);
		expect(route).toContain("lockedDashboardKey.permissions");
		expect(route).toContain(
			"canManageOrganizationCredentials(lockedDashboardMember.role)",
		);
		expect(route).toContain(
			"hasApiKeyManagementAuthority(lockedServiceKey.permissions)",
		);
		expect(route).toContain('lockedServicePrincipal.scopeMode !== "all"');
		expect(route).toContain(
			'lockedServiceOrganization.lifecycleStatus !== "active"',
		);

		const dashboardLockOrder = [
			"const [lockedDashboardUser]",
			"const [lockedDashboardMember]",
			"const [lockedDashboardOrganization]",
			"const [lockedDashboardKey]",
			"const [lockedDashboardPrincipal]",
			"const [lockedDashboardSession]",
		].map((marker) => route.indexOf(marker));
		expect(dashboardLockOrder.every((offset) => offset >= 0)).toBe(true);
		expect(dashboardLockOrder).toEqual(
			[...dashboardLockOrder].sort((a, b) => a - b),
		);

		const serviceLockOrder = [
			"const [lockedServiceKey]",
			"const [lockedServicePrincipal]",
			"const [lockedServiceOrganization]",
		].map((marker) => route.indexOf(marker));
		expect(serviceLockOrder.every((offset) => offset >= 0)).toBe(true);
		expect(serviceLockOrder).toEqual(
			[...serviceLockOrder].sort((a, b) => a - b),
		);
		expect(serviceLockOrder.at(-1)).toBeLessThan(
			route.indexOf("await tx.insert(organizationPrincipals).values"),
		);

		expect(route).toContain("referenceId: null");
		expect(route).toContain("DASHBOARD_SESSION_AUTHORITY_HEADER");
		expect(route).toContain("eq(authSession.id, presentedSessionId)");
		expect(route).toContain("eq(authSession.userId, principalUserId)");
		expect(route).toContain("eq(authSession.activeOrganizationId, orgId)");
		expect(route).toContain("impersonatedBy: authSession.impersonatedBy");
		expect(route).toContain("lockedDashboardSession.impersonatedBy !== null");
		expect(route).toContain("sql`statement_timestamp()`");
		expect(route).toContain("created_by_principal_id: createdByPrincipal");
		expect(route).not.toContain("referenceId: createdByUserId");
		expect(route).toContain("markMutationInputNotApplied(c)");
		expect(route).not.toContain(
			"credentialVersion: issuer.userCredentialVersion",
		);
	});

	it("keeps dashboard credential rotation on the shared authority lock order", () => {
		const dashboardCredential = source(
			"../../../app/src/lib/dashboard-credential.ts",
		);
		const lockOrder = [
			"const [liveUser]",
			"const [liveMembership]",
			"const [liveOrganization]",
			'.for("update")',
			"const [livePrincipal]",
		].map((marker) => dashboardCredential.indexOf(marker));
		expect(lockOrder.every((offset) => offset >= 0)).toBe(true);
		expect(lockOrder).toEqual([...lockOrder].sort((a, b) => a - b));
		expect(dashboardCredential).toContain("eq(apikey.key, stalePrincipalHash)");
	});

	it("applies active temporary-ban and generation checks to invite bearer authentication", () => {
		const route = source("../routes/invite-redeem.ts");

		expect(route.match(/IS DISTINCT FROM TRUE/g)?.length).toBe(2);
		expect(route).toContain("apikey.credentialVersion");
		expect(route).toContain("user.credentialVersion");
		expect(route).toContain("LEGACY_CREDENTIAL_VERSION");
	});

	it("exposes only the sanitized creator principal attribution in API contracts", () => {
		const schema = source("../schemas/api-keys.ts");
		const sdk = source("../../../../packages/sdk/src/resources/api-keys.ts");

		expect(schema.match(/created_by_principal_id/g)?.length).toBe(2);
		expect(sdk.match(/created_by_principal_id/g)?.length).toBe(2);
	});
});
