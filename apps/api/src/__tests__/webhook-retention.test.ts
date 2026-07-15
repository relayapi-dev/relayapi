import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const queries: SQL[] = [];

mock.module("@relayapi/db", () => ({
	createDb: () => ({
		execute: async (query: SQL) => {
			queries.push(query);
			return [{ id: "whe_deleted" }];
		},
	}),
}));

const { cleanupCustomerWebhookHistory, CUSTOMER_WEBHOOK_RETENTION_DAYS } =
	await import("../services/webhook-retention");

import type { Env } from "../types";

const env = {
	HYPERDRIVE: { connectionString: "postgres://unused" },
} as unknown as Env;

beforeEach(() => {
	queries.length = 0;
});

describe("customer webhook history retention", () => {
	it("deletes only expired events whose deliveries are all terminal", async () => {
		const now = new Date("2026-07-13T12:00:00.000Z");
		expect(await cleanupCustomerWebhookHistory(env, 250, now)).toBe(1);
		expect(CUSTOMER_WEBHOOK_RETENTION_DAYS).toBe(7);

		const captured = queries[0];
		if (!captured) throw new Error("cleanup query was not executed");
		const query = new PgDialect().sqlToQuery(captured);
		const normalized = query.sql.replace(/\s+/g, " ");
		expect(normalized).toContain(
			`delivery.status NOT IN ('succeeded', 'failed')`,
		);
		expect(normalized).toContain("delivery.webhook_event_id = event.id");
		expect(normalized).toContain(
			"delivery.organization_id = event.organization_id",
		);
		expect(normalized).toContain("log.created_at >= $2");
		expect(normalized).toContain("FOR UPDATE OF event SKIP LOCKED");
		expect(query.params).toEqual([
			new Date("2026-07-06T12:00:00.000Z"),
			new Date("2026-07-06T12:00:00.000Z"),
			250,
		]);
	});

	it("caps each cleanup statement to a bounded batch", async () => {
		await cleanupCustomerWebhookHistory(env, Number.MAX_SAFE_INTEGER);
		const captured = queries[0];
		if (!captured) throw new Error("cleanup query was not executed");
		const query = new PgDialect().sqlToQuery(captured);
		expect(query.params.at(-1)).toBe(5_000);
	});
});
