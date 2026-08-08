import { describe, expect, test } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host durable tool-job compatibility", () => {
	test("documents and provisions the identifier-only PostgreSQL lifecycle", async () => {
		const [readme, schema, queue, route, scheduled, wrangler] =
			await Promise.all([
				Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
				Bun.file(`${repositoryRoot}packages/db/src/schema.ts`).text(),
				Bun.file(`${repositoryRoot}apps/api/src/queues/tools.ts`).text(),
				Bun.file(`${repositoryRoot}apps/api/src/routes/tools.ts`).text(),
				Bun.file(`${repositoryRoot}apps/api/src/scheduled/index.ts`).text(),
				Bun.file(
					`${repositoryRoot}packages/self-host/src/wrangler-config.ts`,
				).text(),
			]);

		expect(readme).toContain("carries only `tool_job` identifiers");
		expect(readme).toContain("provider egress remains Queue-only");
		expect(schema).toContain("export const toolJobs = pgTable(");
		expect(schema).toContain('index("tool_jobs_pending_deadline_idx")');
		expect(schema).toContain('index("tool_jobs_armed_lease_idx")');
		expect(queue).not.toContain("payload: Record");
		expect(queue).not.toContain("endpoint: string");
		expect(route).toContain("pollToolJobUntilTerminal");
		expect(route).not.toContain("callDownloaderService");
		expect(scheduled).toContain(
			'{ name: "tool_jobs", run: () => maintainToolJobs(env) }',
		);
		expect(wrangler).toContain(
			'{ binding: "TOOLS_QUEUE", queue: cloudflareQueueName("tools") }',
		);
		expect(wrangler).toContain('consumer("tools", {');
		expect(wrangler).toContain("max_batch_timeout: 1");
	});
});
