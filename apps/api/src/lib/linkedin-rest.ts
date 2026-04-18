import { API_VERSIONS } from "../config/api-versions";

export const LINKEDIN_API_BASE = "https://api.linkedin.com";
export const LINKEDIN_REST_BASE = `${LINKEDIN_API_BASE}/rest`;
export const LINKEDIN_RESTLI_PROTOCOL_VERSION = "2.0.0";

type LinkedInOrgAclResponse = {
	elements?: Array<{
		organization?: string;
		organizationTarget?: string;
	}>;
};

type LinkedInOrganizationLookup = {
	id?: number | string;
	localizedName?: string;
	vanityName?: string;
	name?: {
		localized?: Record<string, string>;
		preferredLocale?: { language?: string; country?: string };
	};
};

type LinkedInOrganizationsLookupResponse = {
	results?: Record<string, LinkedInOrganizationLookup>;
};

export type LinkedInAccessibleOrganization = {
	id: string;
	urn: string;
	name: string;
	vanity_name: string | null;
	logo_url: string | null;
};

export function getLinkedInRestHeaders(
	accessToken: string,
	headers: Record<string, string> = {},
): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Linkedin-Version": API_VERSIONS.linkedin,
		"X-Restli-Protocol-Version": LINKEDIN_RESTLI_PROTOCOL_VERSION,
		...headers,
	};
}

export function extractLinkedInOrganizationId(
	organizationUrn: string | undefined,
): string | null {
	if (!organizationUrn) return null;
	const match = organizationUrn.match(
		/^urn:li:(?:organization|organizationBrand):([^:]+)$/,
	);
	return match?.[1] ?? null;
}

function readLinkedInOrganizationName(
	lookup: LinkedInOrganizationLookup | undefined,
	fallbackUrn: string,
): string {
	if (!lookup) return fallbackUrn;
	if (lookup.localizedName) return lookup.localizedName;

	const localized = lookup.name?.localized;
	if (!localized) return fallbackUrn;

	const preferred = lookup.name?.preferredLocale;
	if (preferred?.language && preferred?.country) {
		const preferredKey = `${preferred.language}_${preferred.country}`;
		if (localized[preferredKey]) return localized[preferredKey]!;
	}

	const firstLocalized = Object.values(localized)[0];
	return firstLocalized ?? fallbackUrn;
}

async function fetchLinkedInOrganizationLookups(
	accessToken: string,
	ids: string[],
): Promise<Map<string, LinkedInOrganizationLookup>> {
	if (ids.length === 0) return new Map();

	const res = await fetch(
		`${LINKEDIN_REST_BASE}/organizationsLookup?ids=List(${ids
			.map((id) => encodeURIComponent(id))
			.join(",")})`,
		{
			headers: getLinkedInRestHeaders(accessToken, {
				"Content-Type": "application/json",
			}),
		},
	);

	if (!res.ok) return new Map();

	const json = (await res.json()) as LinkedInOrganizationsLookupResponse;
	return new Map(Object.entries(json.results ?? {}));
}

export async function fetchLinkedInAccessibleOrganizations(
	accessToken: string,
): Promise<LinkedInAccessibleOrganization[]> {
	const aclRes = await fetch(
		`${LINKEDIN_REST_BASE}/organizationAcls?q=roleAssignee`,
		{
			headers: getLinkedInRestHeaders(accessToken, {
				"Content-Type": "application/json",
			}),
		},
	);

	if (!aclRes.ok) return [];

	const aclJson = (await aclRes.json()) as LinkedInOrgAclResponse;
	const organizations = new Map<string, { id: string; urn: string }>();

	for (const element of aclJson.elements ?? []) {
		const urn = element.organizationTarget ?? element.organization;
		const id = extractLinkedInOrganizationId(urn);
		if (!urn || !id || organizations.has(id)) continue;
		organizations.set(id, { id, urn });
	}

	const lookupById = await fetchLinkedInOrganizationLookups(
		accessToken,
		[...organizations.keys()],
	).catch(() => new Map<string, LinkedInOrganizationLookup>());

	return [...organizations.values()].map(({ id, urn }) => {
		const lookup = lookupById.get(id);
		return {
			id,
			urn,
			name: readLinkedInOrganizationName(lookup, urn),
			vanity_name: lookup?.vanityName ?? null,
			logo_url: null,
		};
	});
}
