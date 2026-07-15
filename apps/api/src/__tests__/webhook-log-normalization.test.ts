import { describe, expect, it } from "bun:test";
import { webhookEndpoints, webhookEvents, webhookLogs } from "@relayapi/db";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { webhookLogWorkspaceAccessCondition } from "../routes/webhooks";

describe("customer webhook log normalization", () => {
	it("stores event data once and fences both log parents by organization", () => {
		const table = getTableConfig(webhookLogs);
		expect(table.columns.map((column) => column.name)).toContain(
			"webhook_event_id",
		);
		expect(table.columns.map((column) => column.name)).not.toContain("event");
		expect(table.columns.map((column) => column.name)).not.toContain("payload");

		const endpointForeignKey = table.foreignKeys
			.find(
				(foreignKey) =>
					foreignKey.reference().foreignTable === webhookEndpoints,
			)
			?.reference();
		expect(endpointForeignKey?.columns.map((column) => column.name)).toEqual([
			"webhook_id",
			"organization_id",
		]);
		expect(
			endpointForeignKey?.foreignColumns.map((column) => column.name),
		).toEqual(["id", "organization_id"]);

		const eventForeignKey = table.foreignKeys
			.find(
				(foreignKey) => foreignKey.reference().foreignTable === webhookEvents,
			)
			?.reference();
		expect(eventForeignKey?.columns.map((column) => column.name)).toEqual([
			"webhook_event_id",
			"organization_id",
		]);
		expect(
			eventForeignKey?.foreignColumns.map((column) => column.name),
		).toEqual(["id", "organization_id"]);
	});

	it("requires both the endpoint and event workspace on scoped reads", () => {
		const condition = webhookLogWorkspaceAccessCondition(["ws_allowed"]);
		if (!condition) throw new Error("workspace condition was not built");
		const query = new PgDialect().sqlToQuery(condition);
		expect(query.sql).toContain('"webhook_endpoints"."workspace_id" in ($1)');
		expect(query.sql).toContain('"webhook_events"."workspace_id" in ($2)');
		expect(query.params).toEqual(["ws_allowed", "ws_allowed"]);
	});

	it("gives a zero-grant key no organization-scoped webhook logs", () => {
		const condition = webhookLogWorkspaceAccessCondition([]);
		if (!condition) throw new Error("workspace condition was not built");
		const query = new PgDialect().sqlToQuery(condition);
		expect(query.sql).toBe("(false and false)");
		expect(query.params).toEqual([]);
	});
});
