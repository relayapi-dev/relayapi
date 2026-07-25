import { describe, expect, test } from "bun:test";
import { npmRegistryPackageUrl } from "./upgrade-catalog-helpers";

describe("npm registry package URL construction", () => {
	test("encodes the complete scoped package name as one path segment", () => {
		expect(npmRegistryPackageUrl("@scope/package")).toBe(
			"https://registry.npmjs.org/%40scope%2Fpackage",
		);
		expect(npmRegistryPackageUrl("unscoped-package")).toBe(
			"https://registry.npmjs.org/unscoped-package",
		);
	});

	test.each([
		"",
		"@scope",
		"@scope/",
		"@/package",
		"scope/package",
		"@scope/package/extra",
		"../package",
		"@scope/../package",
		"package?tag=latest",
		"package#fragment",
		"package name",
	])("rejects malformed package name %p", (name) => {
		expect(() => npmRegistryPackageUrl(name)).toThrow(
			"Invalid npm package name",
		);
	});

	test("rejects names beyond npm's package-name limit", () => {
		expect(() => npmRegistryPackageUrl("a".repeat(215))).toThrow(
			"Invalid npm package name",
		);
	});
});
