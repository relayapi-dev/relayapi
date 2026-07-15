const ORGANIZATION_CREDENTIAL_ADMIN_ROLES = new Set(["owner", "admin"]);

export type DashboardCredentialPermission =
	| "read"
	| "write"
	| "manage_api_keys";

export function canManageOrganizationCredentials(
	role: string | null | undefined,
): boolean {
	return (role ?? "")
		.split(",")
		.some((candidate) =>
			ORGANIZATION_CREDENTIAL_ADMIN_ROLES.has(candidate.trim()),
		);
}

export function getDashboardCredentialPermissions(
	role: string | null | undefined,
): DashboardCredentialPermission[] {
	const permissions: DashboardCredentialPermission[] = ["read", "write"];
	if (canManageOrganizationCredentials(role)) {
		permissions.push("manage_api_keys");
	}
	return permissions;
}

export function hasCurrentDashboardCredentialPermissions(
	storedPermissions: string | null | undefined,
	role: string | null | undefined,
): boolean {
	return (
		storedPermissions === getDashboardCredentialPermissions(role).join(",")
	);
}
