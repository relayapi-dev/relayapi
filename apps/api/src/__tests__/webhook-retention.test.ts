import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const queries: SQL[] = [];

mock.module("@relayapi/db", () => ({
	createDb: () => {
		const execute = async (query: SQL) => {
			const ordinal = queries.length;
			queries.push(query);
			if (ordinal === 1) {
				return [{ id: "whe_due", organization_id: "org_due" }];
			}
			if (ordinal === 3 || ordinal === 6) return [{ id: "whe_due" }];
			return [];
		};
		return {
			execute,
			transaction: async (
				callback: (tx: { execute: typeof execute }) => unknown,
			) => callback({ execute }),
		};
	},
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

		expect(queries).toHaveLength(7);
		const expiryQuery = queries[0];
		const candidateQuery = queries[1];
		const lockedQuery = queries[3];
		const logDeleteQuery = queries[4];
		const deliveryDeleteQuery = queries[5];
		const eventDeleteQuery = queries[6];
		if (
			!expiryQuery ||
			!candidateQuery ||
			!lockedQuery ||
			!logDeleteQuery ||
			!deliveryDeleteQuery ||
			!eventDeleteQuery
		) {
			throw new Error("cleanup transaction did not execute every phase");
		}
		const dialect = new PgDialect();
		const expiry = dialect.sqlToQuery(expiryQuery).sql.replace(/\s+/g, " ");
		expect(expiry).toContain("delivery.status = 'manual_review'");
		expect(expiry).toContain(
			"'pre_http_repair_exhausted', 'http_outcome_unknown'",
		);
		expect(expiry).toContain("delivery.manual_review_until <=");
		expect(expiry).toContain("FOR UPDATE OF delivery SKIP LOCKED");
		expect(expiry).toContain("FOR SHARE OF tenant");
		expect(expiry).toContain("FROM erasure_holds AS hold");
		expect(expiry).toContain("THEN 'unresolved'");
		expect(dialect.sqlToQuery(expiryQuery).params).toContain(250);
		const query = dialect.sqlToQuery(candidateQuery);
		const normalized = query.sql.replace(/\s+/g, " ");
		expect(normalized).toContain(
			`delivery.status NOT IN ('succeeded', 'failed', 'unresolved')`,
		);
		expect(normalized).toContain("delivery.completed_at IS NULL");
		expect(normalized).toContain("delivery.completed_at >=");
		expect(normalized).toContain("delivery.webhook_event_id = event.id");
		expect(normalized).toContain(
			"delivery.organization_id = event.organization_id",
		);
		expect(normalized).toContain("FROM erasure_holds AS hold");
		expect(normalized).toContain(
			"hold.organization_tombstone_id = event.organization_id",
		);
		expect(normalized).toContain("hold.subject_id = event.workspace_id");
		expect(normalized).toContain("log.created_at >=");
		expect(query.params).toContainEqual(new Date("2026-07-06T12:00:00.000Z"));
		expect(query.params).toContain(250);

		expect(dialect.sqlToQuery(lockedQuery).sql).toContain(
			"FOR UPDATE OF event SKIP LOCKED",
		);
		expect(dialect.sqlToQuery(logDeleteQuery).sql).toContain(
			"DELETE FROM webhook_logs",
		);
		const deliveryDelete = dialect
			.sqlToQuery(deliveryDeleteQuery)
			.sql.replace(/\s+/g, " ");
		expect(deliveryDelete).toContain("DELETE FROM webhook_deliveries");
		expect(deliveryDelete).toContain("log.delivery_id = delivery.id");
		const eventDelete = dialect
			.sqlToQuery(eventDeleteQuery)
			.sql.replace(/\s+/g, " ");
		expect(eventDelete).toContain("DELETE FROM webhook_events");
		expect(eventDelete).toContain(
			"FROM webhook_deliveries AS delivery WHERE delivery.webhook_event_id = event.id",
		);
	});

	it("caps every physical child/root cleanup statement to a bounded batch", async () => {
		await cleanupCustomerWebhookHistory(env, Number.MAX_SAFE_INTEGER);
		const dialect = new PgDialect();
		for (const ordinal of [0, 1, 4, 5, 6]) {
			const captured = queries[ordinal];
			if (!captured)
				throw new Error(`cleanup query ${ordinal} was not executed`);
			expect(dialect.sqlToQuery(captured).params).toContain(5_000);
		}
	});
});
