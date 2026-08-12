import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const apiRuntimeControl = readFileSync(
	resolve(repositoryRoot, "apps/api/src/lib/runtime-controls.ts"),
	"utf8",
);
const appRuntimeControl = readFileSync(
	resolve(repositoryRoot, "apps/app/src/lib/runtime-control.ts"),
	"utf8",
);

describe("self-host runtime-control compatibility", () => {
	it("keeps an absent control key open and accepts legacy maintenance records", () => {
		for (const source of [apiRuntimeControl, appRuntimeControl]) {
			expect(source).toContain('raw === null) return { status: "open"');
			expect(source).toContain("mode === undefined");
			expect(source).toContain('? "maintenance"');
			expect(source).toContain(': "open"');
		}
	});

	it("recognizes draining without inferring it for self-hosted instances", () => {
		expect(apiRuntimeControl).toContain('candidate.mode !== "draining"');
		expect(appRuntimeControl).toContain('record.mode !== "draining"');
		expect(apiRuntimeControl).toContain(
			'state.status === "open" || state.status === "draining"',
		);
	});

	it("keeps the normal smoke stable and gates the database probe to explicit self-host requests", () => {
		for (const source of [apiRuntimeControl, appRuntimeControl]) {
			expect(source).toContain('url.searchParams.get("probe") === "database"');
			expect(source).toContain('DEPLOYMENT_MODE === "self_hosted"');
			expect(source).toContain("SELECT current_database()");
			expect(source).toContain('code: "DATABASE_PROBE_FAILED"');
		}
	});
});
