import { describe, expect, test } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host automation conversion dispatch compatibility", () => {
	test("uses the baseline and existing every-minute scheduler without a new binding", async () => {
		const [readme, schema, dispatch, scheduled] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
			Bun.file(`${repositoryRoot}packages/db/src/schema.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/automation-conversion-dispatch.ts`,
			).text(),
			Bun.file(`${repositoryRoot}apps/api/src/scheduled/index.ts`).text(),
		]);

		expect(readme).toContain(
			"Automation conversion facts use their own PostgreSQL outbox columns",
		);
		expect(schema).toContain("dispatchStatus: text(\"dispatch_status\"");
		expect(dispatch).toContain("deferRun: true");
		expect(scheduled).toContain('name: "automation_conversion_dispatch"');
	});
});
