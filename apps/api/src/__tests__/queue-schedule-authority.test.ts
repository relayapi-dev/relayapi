import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { queueSchedules } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { TENANT_PURGE_TABLES } from "../services/tenant-deletion";

describe("queue schedule authority", () => {
	it("stores one authoritative default per organization in PostgreSQL", () => {
		const config = getTableConfig(queueSchedules);
		expect(config.columns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"organization_id",
				"slots",
				"is_default",
				"created_at",
				"updated_at",
			]),
		);
		const defaultIndex = config.indexes.find(
			(index) =>
				index.config.name === "queue_schedules_one_default_per_org_uniq",
		);
		expect(defaultIndex?.config.unique).toBe(true);
		expect(defaultIndex?.config.where).toBeDefined();
		expect(config.checks.map((check) => check.name)).toContain(
			"queue_schedules_slots_check",
		);
		expect(
			TENANT_PURGE_TABLES.some(
				(entry) =>
					entry.schema === "public" && entry.table === "queue_schedules",
			),
		).toBe(true);
	});

	it("uses KV only as a bounded cache and reads slot finding through the authority", () => {
		const service = readFileSync(
			new URL("../services/queue-schedules.ts", import.meta.url),
			"utf8",
		);
		const routes = readFileSync(
			new URL("../routes/queue.ts", import.meta.url),
			"utf8",
		);
		const finder = readFileSync(
			new URL("../services/slot-finder.ts", import.meta.url),
			"utf8",
		);
		expect(service).toContain("expirationTtl: QUEUE_SCHEDULE_CACHE_TTL_SECONDS");
		expect(service).toContain("QUEUE_SCHEDULE_CACHE_VERSION");
		expect(service).toContain(".from(queueSchedules)");
		expect(service).toContain("pg_advisory_xact_lock");
		expect(routes).toContain("listQueueSchedules(c.get(\"db\"), c.env.KV");
		expect(routes).not.toContain("async function saveSchedules");
		expect(finder).toContain("listQueueSchedules(db, env.KV, orgId)");
		expect(finder).not.toContain('kv.get<StoredSchedule[]>');
	});
});
