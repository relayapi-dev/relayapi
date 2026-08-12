export const ORGANIZATION_ROLE_RANK = {
	member: 0,
	admin: 1,
	owner: 2,
} as const;

export type OrganizationRole = keyof typeof ORGANIZATION_ROLE_RANK;

/** Better Auth can serialize multiple organization roles as a comma list. */
export function highestOrganizationRole(
	serializedRoles: string,
): OrganizationRole | null {
	let highest: OrganizationRole | null = null;
	for (const rawRole of serializedRoles.split(",")) {
		const role = rawRole.trim() as OrganizationRole;
		if (!(role in ORGANIZATION_ROLE_RANK)) continue;
		if (
			highest === null ||
			ORGANIZATION_ROLE_RANK[role] > ORGANIZATION_ROLE_RANK[highest]
		) {
			highest = role;
		}
	}
	return highest;
}

export function canAssignOrganizationRole(
	issuerRoles: string,
	requestedRole: OrganizationRole,
): boolean {
	const issuerRole = highestOrganizationRole(issuerRoles);
	return (
		issuerRole !== null &&
		ORGANIZATION_ROLE_RANK[issuerRole] >= ORGANIZATION_ROLE_RANK[requestedRole]
	);
}

export function higherOrganizationRole(
	currentRoles: string,
	requestedRole: OrganizationRole,
): OrganizationRole {
	const currentRole = highestOrganizationRole(currentRoles);
	if (
		currentRole &&
		ORGANIZATION_ROLE_RANK[currentRole] >= ORGANIZATION_ROLE_RANK[requestedRole]
	) {
		return currentRole;
	}
	return requestedRole;
}
