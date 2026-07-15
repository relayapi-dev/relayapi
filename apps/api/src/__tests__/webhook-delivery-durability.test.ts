import { describe, expect, it } from "bun:test";
import {
	webhookDeliveries,
	webhookEndpoints,
	webhookEvents,
} from "@relayapi/db";
import { PgDialect } from "drizzle-orm/pg-core";
import {
	dispatchWebhookEvent,
	isRetryableWebhookStatus,
	parseWebhookRetryAfter,
	persistWebhookEventInTransaction,
	webhookEventIdForOccurrence,
	webhookRetryDelaySeconds,
} from "../services/webhook-delivery";

const matchingEndpoint = (id: string) => ({
	id,
	organizationId: "org_1",
	workspaceId: "ws_1",
	url: "https://example.com/hook",
	secretCiphertext: "encrypted",
	enabled: true,
	events: ["post.published"],
});

describe("customer webhook occurrence identity", () => {
	it("is stable for a producer retry but distinct for equal-payload occurrences", async () => {
		const first = await webhookEventIdForOccurrence("org_1", "order:42:paid");
		const retry = await webhookEventIdForOccurrence("org_1", "order:42:paid");
		const secondOccurrence = await webhookEventIdForOccurrence(
			"org_1",
			"order:43:paid",
		);

		expect(retry).toBe(first);
		expect(secondOccurrence).not.toBe(first);
		expect(first).toStartWith("whe_");
	});

	it("namespaces occurrence IDs by organization", async () => {
		const first = await webhookEventIdForOccurrence("org_1", "same");
		const otherTenant = await webhookEventIdForOccurrence("org_2", "same");
		expect(otherTenant).not.toBe(first);
	});

	it("rejects non-connect producers that omit a stable occurrence ID", async () => {
		const unsafeDispatch = dispatchWebhookEvent as unknown as (
			...args: unknown[]
		) => Promise<void>;
		await expect(
			unsafeDispatch({}, {}, "org_1", "post.published", { post_id: "p_1" }),
		).rejects.toThrow("Webhook occurrenceId is required");
	});

	it("persists the event and endpoint fan-out through the caller transaction", async () => {
		const inserted: Array<{ table: unknown; values: unknown }> = [];
		const selectedTables: unknown[] = [];
		const tx = {
			select: () => ({
				from: (table: unknown) => ({
					where: () => {
						selectedTables.push(table);
							return {
								orderBy: async () => [matchingEndpoint("wh_1")],
							};
					},
				}),
			}),
			insert: (table: unknown) => ({
				values: (values: unknown) => {
					inserted.push({ table, values });
					return {
						onConflictDoNothing: () => ({
							returning: async () => [{ id: "whe_1" }],
						}),
						returning: async () => [
							{ id: "whd_inserted", organizationId: "org_1" },
						],
					};
				},
			}),
		};

		const persisted = await persistWebhookEventInTransaction(
			tx as never,
			"org_1",
			"post.published",
			{ post_id: "post_1" },
			{ workspaceId: "ws_1", occurrenceId: "post:post_1:published" },
		);

		expect(inserted.map(({ table }) => table)).toEqual([
			webhookEvents,
			webhookDeliveries,
		]);
		// The normal path reuses INSERT ... RETURNING and performs no second
		// webhook_deliveries SELECT.
		expect(selectedTables).toEqual([webhookEndpoints]);
		expect(persisted.occurrenceId).toBe("post:post_1:published");
		expect(persisted.deliveries).toEqual([
			{ id: "whd_inserted", organizationId: "org_1" },
		]);
	});

	it("pushes tenant, enabled, workspace, and event matching into the SQL query", async () => {
		let endpointWhere: Parameters<PgDialect["sqlToQuery"]>[0] | null = null;
		const tx = {
			select: () => ({
				from: () => ({
					where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
						endpointWhere = condition;
						return { orderBy: async () => [] };
					},
				}),
			}),
		};

		await persistWebhookEventInTransaction(
			tx as never,
			"org_1",
			"post.published",
			{},
			{ workspaceId: "ws_1", occurrenceId: "post:post_1:published" },
		);

		if (!endpointWhere)
			throw new Error("endpoint WHERE clause was not captured");
		const query = new PgDialect().sqlToQuery(endpointWhere);
		expect(query.sql).toContain('"webhook_endpoints"."organization_id" = $1');
		expect(query.sql).toContain('"webhook_endpoints"."enabled" = $2');
		expect(query.sql).toContain(
			'("webhook_endpoints"."workspace_id" is null or "webhook_endpoints"."workspace_id" = $3)',
		);
		expect(query.sql).toContain(
			'("webhook_endpoints"."events" is null or cardinality("webhook_endpoints"."events") = 0 or $4 = ANY("webhook_endpoints"."events"))',
		);
		expect(query.params).toEqual(["org_1", true, "ws_1", "post.published"]);
	});

	it("persists every matching endpoint when fan-out exceeds one Queue batch", async () => {
		const endpoints = Array.from({ length: 101 }, (_, index) =>
			matchingEndpoint(`wh_${index}`),
		);
		let deliveryRows = 0;
		const tx = {
			select: () => ({
				from: () => ({
					where: () => ({
						orderBy: async () => endpoints,
					}),
				}),
			}),
			insert: (table: unknown) => ({
				values: (values: unknown) => {
					if (table === webhookDeliveries) {
						deliveryRows = (values as unknown[]).length;
					}
					return {
						onConflictDoNothing: () => ({
							returning: async () => [{ id: "whe_1" }],
						}),
						returning: async () =>
							(values as Array<{ id: string; organizationId: string }>).map(
								({ id, organizationId }) => ({ id, organizationId }),
							),
					};
				},
			}),
		};

		const persisted = await persistWebhookEventInTransaction(
			tx as never,
			"org_1",
			"post.published",
			{},
			{ workspaceId: "ws_1", occurrenceId: "post:post_1:published" },
		);
		expect(deliveryRows).toBe(101);
		expect(persisted.deliveries).toHaveLength(101);
	});

	it("keeps the original endpoint snapshot on an idempotent occurrence retry", async () => {
		const selectedTables: unknown[] = [];
		const insertedTables: unknown[] = [];
		const tx = {
			select: () => ({
				from: (table: unknown) => ({
					where: () => {
						selectedTables.push(table);
						if (table === webhookEndpoints) {
							return {
								orderBy: async () => [matchingEndpoint("wh_added_later")],
							};
						}
						if (table === webhookEvents) {
							return {
								limit: async () => [
									{
										event: "post.published",
										payload: { post_id: "post_1" },
										workspaceId: "ws_1",
									},
								],
							};
						}
						return Promise.resolve([
							{ id: "whd_pending", organizationId: "org_1" },
						]);
					},
				}),
			}),
			insert: (table: unknown) => ({
				values: () => {
					insertedTables.push(table);
					return {
						onConflictDoNothing: () =>
							table === webhookEvents
								? { returning: async () => [] }
								: Promise.resolve(),
					};
				},
			}),
		};

		const persisted = await persistWebhookEventInTransaction(
			tx as never,
			"org_1",
			"post.published",
			{ post_id: "post_1" },
			{ workspaceId: "ws_1", occurrenceId: "post:post_1:published" },
		);

		expect(selectedTables).toEqual([
			webhookEndpoints,
			webhookEvents,
			webhookDeliveries,
		]);
		expect(insertedTables).toEqual([webhookEvents]);
		expect(persisted.deliveries).toEqual([
			{ id: "whd_pending", organizationId: "org_1" },
		]);
	});
});

describe("customer webhook retry policy", () => {
	it("retries rate limits and server responses, but not definitive 4xx responses", () => {
		expect(isRetryableWebhookStatus(429)).toBe(true);
		expect(isRetryableWebhookStatus(500)).toBe(true);
		expect(isRetryableWebhookStatus(503)).toBe(true);
		expect(isRetryableWebhookStatus(400)).toBe(false);
		expect(isRetryableWebhookStatus(404)).toBe(false);
	});

	it("honors bounded Retry-After seconds and dates", () => {
		const now = Date.parse("2026-07-13T12:00:00.000Z");
		expect(parseWebhookRetryAfter("120", now)).toBe(120);
		expect(parseWebhookRetryAfter("999999", now)).toBe(3_600);
		expect(parseWebhookRetryAfter("Mon, 13 Jul 2026 12:02:00 GMT", now)).toBe(
			120,
		);
		expect(parseWebhookRetryAfter("not-a-date", now)).toBeNull();
	});

	it("uses capped exponential backoff without a valid Retry-After", () => {
		expect(webhookRetryDelaySeconds(1, null)).toBe(30);
		expect(webhookRetryDelaySeconds(4, null)).toBe(240);
		expect(webhookRetryDelaySeconds(20, null)).toBe(3_600);
	});
});
