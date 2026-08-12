import { describe, expect, test } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host automation internal-event compatibility", () => {
	test("reuses the database scheduler and existing every-minute cron", async () => {
		const [readme, schema, internalEvents, scheduler, wrangler] =
			await Promise.all([
				Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
				Bun.file(`${repositoryRoot}packages/db/src/schema.ts`).text(),
				Bun.file(
					`${repositoryRoot}apps/api/src/services/automations/internal-events.ts`,
				).text(),
				Bun.file(
					`${repositoryRoot}apps/api/src/services/automations/scheduler.ts`,
				).text(),
				Bun.file(`${repositoryRoot}apps/api/wrangler.jsonc`).text(),
			]);

		expect(readme).toContain(
			"Tag and custom-field automation actions use that same PostgreSQL scheduler",
		);
		expect(schema).toContain("'internal_event'");
		expect(internalEvents).toContain("stageInternalEvent");
		expect(scheduler).toContain('case "internal_event"');
		expect(wrangler).toContain('"*/1 * * * *"');
		expect(wrangler).not.toContain("INTERNAL_EVENT_QUEUE");
	});
});
