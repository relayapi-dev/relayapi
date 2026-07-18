import { describe, expect, it } from "bun:test";
import {
	type OrganizationMenuItem,
	reconcileOrganizationMenuItems,
} from "./organization-menu";

const majestico: OrganizationMenuItem = {
	id: "org_majestico",
	name: "Majestico",
	slug: "majestico",
};

const testOrganization: OrganizationMenuItem = {
	id: "org_test",
	name: "Test",
	slug: "test",
};

describe("reconcileOrganizationMenuItems", () => {
	it("keeps the verified current organization when no list is available", () => {
		expect(reconcileOrganizationMenuItems(majestico, [])).toEqual([majestico]);
	});

	it("adds a missing current organization before fetched memberships", () => {
		expect(
			reconcileOrganizationMenuItems(majestico, [testOrganization]),
		).toEqual([majestico, testOrganization]);
	});

	it("preserves fetched order and refreshed current-organization metadata", () => {
		const refreshedMajestico = {
			...majestico,
			name: "Majestico Updated",
			logo: "https://example.com/majestico.png",
		};

		expect(
			reconcileOrganizationMenuItems(majestico, [
				testOrganization,
				refreshedMajestico,
			]),
		).toEqual([testOrganization, refreshedMajestico]);
	});

	it("removes duplicate fetched organizations", () => {
		expect(
			reconcileOrganizationMenuItems(null, [majestico, majestico]),
		).toEqual([majestico]);
	});
});
