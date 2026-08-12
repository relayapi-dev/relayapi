import type { AdTargeting } from "./ad-platforms/types";

export interface ApiAdTargeting {
	age_min?: number;
	age_max?: number;
	genders?: ("male" | "female" | "all")[];
	locations?: {
		countries?: string[];
		cities?: string[];
		radius_miles?: number;
	}[];
	interests?: { id: string; name: string }[];
	custom_audiences?: string[];
	excluded_audiences?: string[];
	languages?: string[];
	placements?: string[];
	platform_specific?: Record<string, unknown>;
}

/** Convert the public snake_case API contract into the service-layer model. */
export function toServiceAdTargeting(
	targeting: ApiAdTargeting | undefined,
): AdTargeting | undefined {
	if (!targeting) return undefined;
	return {
		ageMin: targeting.age_min,
		ageMax: targeting.age_max,
		genders: targeting.genders,
		locations: targeting.locations?.map((location) => ({
			countries: location.countries,
			cities: location.cities,
			radiusMiles: location.radius_miles,
		})),
		interests: targeting.interests,
		customAudiences: targeting.custom_audiences,
		excludedAudiences: targeting.excluded_audiences,
		languages: targeting.languages,
		placements: targeting.placements,
		platformSpecific: targeting.platform_specific,
	};
}
