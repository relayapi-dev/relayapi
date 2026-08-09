import { describe, expect, it } from "bun:test";
import { toServiceAdTargeting } from "../services/ad-targeting";

describe("public ad targeting conversion", () => {
	it("preserves every snake_case API field at the service boundary", () => {
		expect(
			toServiceAdTargeting({
				age_min: 21,
				age_max: 60,
				genders: ["female"],
				locations: [
					{ countries: ["GB"], cities: ["2420605"], radius_miles: 12 },
				],
				interests: [{ id: "interest_1", name: "Software" }],
				custom_audiences: ["aud_1"],
				excluded_audiences: ["aud_2"],
				languages: ["24"],
				placements: ["instagram"],
				platform_specific: { device_platforms: ["mobile"] },
			}),
		).toEqual({
			ageMin: 21,
			ageMax: 60,
			genders: ["female"],
			locations: [{ countries: ["GB"], cities: ["2420605"], radiusMiles: 12 }],
			interests: [{ id: "interest_1", name: "Software" }],
			customAudiences: ["aud_1"],
			excludedAudiences: ["aud_2"],
			languages: ["24"],
			placements: ["instagram"],
			platformSpecific: { device_platforms: ["mobile"] },
		});
	});
});
