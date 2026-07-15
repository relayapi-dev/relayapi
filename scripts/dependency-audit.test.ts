import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AuditException,
	type AuditFinding,
	type AuditPolicy,
	collectFindings,
	evaluateAudit,
	parseLockfile,
} from "./dependency-audit";

const finding: AuditFinding = {
	advisory: "GHSA-aaaa-bbbb-cccc",
	package: "vulnerable-package",
	version: "1.2.3",
	dependencyPath: "parent/vulnerable-package",
	artifact: "apps/api",
	dependencyClass: "runtime",
	severity: "high",
	title: "Synthetic advisory",
	url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
};

const exception: AuditException = {
	advisory: finding.advisory,
	package: finding.package,
	version: finding.version,
	dependencyPath: finding.dependencyPath,
	artifact: finding.artifact,
	dependencyClass: finding.dependencyClass,
	expiresOn: "2026-07-31",
	reason: "Synthetic, exact exception for policy evaluation tests.",
};

function policy(exceptions: AuditException[] = [exception]): AuditPolicy {
	return {
		schemaVersion: 1,
		reviewedOn: "2026-07-13",
		documentation: "Exact synthetic exception contract.",
		exceptions,
	};
}

describe("dependency audit exception evaluation", () => {
	test("accepts only an exact, current finding scope", () => {
		const result = evaluateAudit(
			[finding],
			policy(),
			new Date("2026-07-20T12:00:00Z"),
		);

		expect(result.allowed).toEqual([finding]);
		expect(result.unmatched).toEqual([]);
		expect(result.expired).toEqual([]);
		expect(result.stale).toEqual([]);
		expect(result.policyErrors).toEqual([]);
	});

	test.each([
		["advisory", "GHSA-dddd-eeee-ffff"],
		["package", "other-package"],
		["version", "1.2.4"],
		["dependencyPath", "other-parent/vulnerable-package"],
		["artifact", "apps/app"],
		["dependencyClass", "development"],
	] as const)("rejects a finding with a changed %s", (field, value) => {
		const changed = { ...finding, [field]: value } as AuditFinding;
		const result = evaluateAudit(
			[changed],
			policy(),
			new Date("2026-07-20T12:00:00Z"),
		);

		expect(result.unmatched).toEqual([changed]);
		expect(result.stale).toEqual([exception]);
		expect(result.allowed).toEqual([]);
	});

	test("rejects expired and no-longer-observed exceptions", () => {
		const expired = evaluateAudit(
			[finding],
			policy(),
			new Date("2026-08-01T00:00:00Z"),
		);
		const stale = evaluateAudit([], policy(), new Date("2026-07-20T00:00:00Z"));

		expect(expired.expired).toEqual([{ finding, exception }]);
		expect(stale.stale).toEqual([exception]);
	});

	test("rejects exceptions longer than 30 days", () => {
		const tooLong = { ...exception, expiresOn: "2026-08-13" };
		const result = evaluateAudit(
			[{ ...finding }],
			policy([tooLong]),
			new Date("2026-07-20T00:00:00Z"),
		);

		expect(result.policyErrors).toContain(
			"exceptions[0] lasts 31 days; the maximum is 30.",
		);
	});
});

describe("Bun lock graph attribution", () => {
	const tempDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			tempDirectories
				.splice(0)
				.map((directory) => rm(directory, { recursive: true })),
		);
	});

	test("attributes vulnerable versions to exact install paths and dependency classes", async () => {
		const root = await mkdtemp(join(tmpdir(), "relayapi-dependency-audit-"));
		tempDirectories.push(root);
		await mkdir(join(root, "apps/api"), { recursive: true });
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({ name: "root", private: true, devDependencies: {} }),
		);
		await writeFile(
			join(root, "apps/api/package.json"),
			JSON.stringify({
				name: "@test/api",
				dependencies: { parent: "1.0.0" },
				devDependencies: { "dev-parent": "1.0.0" },
			}),
		);

		const lockfile = `{
  "lockfileVersion": 1,
  "packages": {
    "@test/api": ["@test/api@workspace:apps/api"],
    "parent": ["parent@1.0.0", "", { "dependencies": { "vulnerable-package": "1.2.3" } }],
    "parent/vulnerable-package": ["vulnerable-package@1.2.3", "", {}],
    "dev-parent": ["dev-parent@1.0.0", "", { "dependencies": { "vulnerable-package": "1.2.3" } }],
    "dev-parent/vulnerable-package": ["vulnerable-package@1.2.3", "", {}],
  }
}`;
		const audit = {
			"vulnerable-package": [
				{
					id: 1,
					url: finding.url,
					title: finding.title,
					severity: finding.severity,
					vulnerable_versions: "=1.2.3",
				},
			],
		};

		const result = await collectFindings(audit, lockfile, root);

		expect(result).toHaveLength(2);
		expect(result).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					dependencyPath: "parent/vulnerable-package",
					artifact: "apps/api",
					dependencyClass: "runtime",
				}),
				expect.objectContaining({
					dependencyPath: "dev-parent/vulnerable-package",
					artifact: "apps/api",
					dependencyClass: "development",
				}),
			]),
		);
	});

	test("parses aliased package keys without treating their names as path suffixes", () => {
		const parsed = parseLockfile(`{
  "lockfileVersion": 1,
  "packages": {
    "package-alias": ["real-package@1.0.0", "", {}],
  }
}`);

		expect(parsed.get("package-alias")).toMatchObject({
			name: "real-package",
			version: "1.0.0",
		});
	});
});
