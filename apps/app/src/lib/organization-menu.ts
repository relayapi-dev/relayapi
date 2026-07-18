export interface OrganizationMenuItem {
	id: string;
	name: string;
	slug: string;
	logo?: string | null;
}

/**
 * Keep the server-verified active organization visible while the full
 * membership list is loading or unavailable. A successful list response wins
 * for refreshed organization metadata and ordering.
 */
export function reconcileOrganizationMenuItems(
	current: OrganizationMenuItem | null,
	fetched: readonly OrganizationMenuItem[],
): OrganizationMenuItem[] {
	const seen = new Set<string>();
	const items = fetched.filter((organization) => {
		if (seen.has(organization.id)) return false;
		seen.add(organization.id);
		return true;
	});

	if (!current || seen.has(current.id)) return items;
	return [current, ...items];
}
