import { beforeEach, describe, expect, it, mock } from "bun:test";
import { CUSTOMER_WEBHOOK_MANUAL_REVIEW_WINDOW_MS } from "../lib/customer-webhook-policy";

type Row = Record<string, unknown>;
type Column = { name: string };
type Condition = (row: Row) => boolean;
type SqlValue = { resolve: (row: Row) => unknown };
type TestRows = {
	webhookDeliveries: Row[];
	webhookEndpoints: Row[];
	webhookEvents: Row[];
	webhookLogs: Row[];
	queueFailures: Row[];
};

const column = (name: string): Column => ({ name });
const table = (name: string, columns: string[]) =>
	Object.assign(
		{ _name: name, toString: () => name },
		Object.fromEntries(columns.map((name) => [name, column(name)])),
	);

const webhookDeliveries = table("webhookDeliveries", [
	"id",
	"webhookEventId",
	"webhookId",
	"organizationId",
	"status",
	"attempts",
	"repairAttempts",
	"repairDeadlineAt",
	"leaseToken",
	"leaseExpiresAt",
	"claimedAt",
	"requestMayHaveBeenSentAt",
	"completedAt",
	"statusCode",
	"responseTimeMs",
	"manualReviewReason",
	"manualReviewUntil",
	"operatorIntervenedAt",
	"operatorRetryRequestedAt",
	"error",
	"nextAttemptAt",
	"nextDispatchAt",
	"updatedAt",
]);
const webhookEndpoints = table("webhookEndpoints", [
	"id",
	"enabled",
	"url",
	"secretCiphertext",
]);
const webhookEvents = table("webhookEvents", [
	"id",
	"event",
	"payload",
	"createdAt",
]);
const webhookLogs = table("webhookLogs", ["id", "webhookEventId"]);
const queueFailures = table("queueFailures", [
	"queueName",
	"messageId",
	"attempts",
	"error",
	"organizationId",
	"organizationIds",
]);

function tableName(value: unknown): string {
	return (value as { _name: string })._name;
}

function applyValues(row: Row, values: Row): void {
	for (const [key, value] of Object.entries(values)) {
		row[key] =
			value && typeof value === "object" && "resolve" in value
				? (value as SqlValue).resolve(row)
				: value;
	}
}

function createDbDouble() {
	const rows: TestRows = {
		webhookDeliveries: [],
		webhookEndpoints: [],
		webhookEvents: [],
		webhookLogs: [],
		queueFailures: [],
	};
	const tableRows = (source: string): Row[] => {
		if (!Object.hasOwn(rows, source)) {
			throw new Error(`Unknown test table: ${source}`);
		}
		return rows[source as keyof TestRows];
	};

	const api = {
		select(fields?: Record<string, Column>) {
			let source = "";
			let condition: Condition = () => true;
			let limit = Number.POSITIVE_INFINITY;
			const chain = {
				from(value: unknown) {
					source = tableName(value);
					return chain;
				},
				where(value: Condition) {
					condition = value;
					return chain;
				},
				limit(value: number) {
					limit = value;
					return chain;
				},
				// biome-ignore lint/suspicious/noThenProperty: test double for an awaitable Drizzle builder
				then(resolve: (value: Row[]) => void) {
					const selected = tableRows(source)
						.filter(condition)
						.slice(0, limit)
						.map((row) => {
							if (!fields) return { ...row };
							return Object.fromEntries(
								Object.entries(fields).map(([alias, col]) => [
									alias,
									row[col.name],
								]),
							);
						});
					resolve(selected);
				},
			};
			return chain;
		},
		update(value: unknown) {
			const source = tableName(value);
			let values: Row = {};
			let condition: Condition = () => true;
			const apply = () => {
				const changed = tableRows(source).filter(condition);
				for (const row of changed) applyValues(row, values);
				return changed;
			};
			const chain = {
				set(next: Row) {
					values = next;
					return chain;
				},
				where(next: Condition) {
					condition = next;
					return chain;
				},
				returning(fields?: Record<string, Column>) {
					const changed = apply();
					if (!fields)
						return Promise.resolve(changed.map((row) => ({ ...row })));
					return Promise.resolve(
						changed.map((row) =>
							Object.fromEntries(
								Object.entries(fields).map(([alias, col]) => [
									alias,
									row[col.name],
								]),
							),
						),
					);
				},
				// biome-ignore lint/suspicious/noThenProperty: test double for an awaitable Drizzle builder
				then(resolve: () => void) {
					apply();
					resolve();
				},
			};
			return chain;
		},
		insert(value: unknown) {
			const source = tableName(value);
			let values: Row | Row[] = {};
			const chain = {
				values(next: Row | Row[]) {
					values = next;
					return chain;
				},
				// biome-ignore lint/suspicious/noThenProperty: test double for an awaitable Drizzle builder
				then(resolve: () => void) {
					tableRows(source).push(
						...(Array.isArray(values) ? values : [values]).map((row) => ({
							...row,
						})),
					);
					resolve();
				},
			};
			return chain;
		},
	};

	return {
		...api,
		transaction: async <T>(run: (tx: typeof api) => Promise<T>) => run(api),
		rows,
	};
}

let activeDb = createDbDouble();
let fetchCallCount = 0;
let lastRequest: RequestInit | undefined;
let fetchResult: () => Promise<Response> = async () => new Response(null);
let urlSafety: "allowed" | "blocked" | "indeterminate" = "allowed";
let decryptFailure: Error | null = null;
let operatorAlerts: Row[] = [];

mock.module("@relayapi/db", () => ({
	createDb: () => activeDb,
	webhookDeliveries,
	webhookEndpoints,
	webhookEvents,
	webhookLogs,
	queueFailures,
}));

mock.module("drizzle-orm", () => {
	const eq =
		(col: Column, value: unknown): Condition =>
		(row) =>
			row[col.name] === value;
	const and =
		(...conditions: Condition[]): Condition =>
		(row) =>
			conditions.every((condition) => condition(row));
	return {
		eq,
		and,
		or:
			(...conditions: Condition[]): Condition =>
			(row) =>
				conditions.some((condition) => condition(row)),
		lt:
			(col: Column, value: unknown): Condition =>
			(row) => {
				const left = row[col.name] as number | Date | null | undefined;
				return left != null && left < (value as number | Date);
			},
		lte:
			(col: Column, value: unknown): Condition =>
			(row) => {
				const left = row[col.name] as number | Date | null | undefined;
				return left != null && left <= (value as number | Date);
			},
		isNull:
			(col: Column): Condition =>
			(row) =>
				row[col.name] == null,
		isNotNull:
			(col: Column): Condition =>
			(row) =>
				row[col.name] != null,
		inArray:
			(col: Column, values: unknown[]): Condition =>
			(row) =>
				values.includes(row[col.name]),
		sql: (strings: TemplateStringsArray, ...values: unknown[]): SqlValue => ({
			resolve: (row) => {
				const col = values[0] as Column;
				return strings.join("").includes("+ 1")
					? Number(row[col.name] ?? 0) + 1
					: undefined;
			},
		}),
	};
});

mock.module("../lib/crypto", () => ({
	decryptToken: async () => {
		if (decryptFailure) throw decryptFailure;
		return "signing-secret";
	},
}));
mock.module("../lib/ssrf-guard", () => ({
	classifyPublicUrlWithDns: async () => urlSafety,
}));
mock.module("../lib/fetch-timeout", () => ({
	fetchWithTimeout: async (_url: string, init: RequestInit) => {
		fetchCallCount += 1;
		lastRequest = init;
		return fetchResult();
	},
}));
mock.module("../queues/failures", () => ({
	encryptQueueFailurePayload: async () => ({
		payloadCiphertext: "encrypted-test-payload",
		payloadKeyId: "test",
		payloadExpiresAt: new Date("2026-07-29T00:00:00.000Z"),
	}),
}));
mock.module("../services/operator-alerts", () => ({
	dispatchCustomerWebhookRepairExhaustedAlert: async (alert: Row) => {
		operatorAlerts.push(alert);
	},
}));

const { performWebhookDelivery, webhookDeliveryAttemptLimit } = await import(
	"../services/webhook-delivery"
);

import type { Env } from "../types";

const env = {
	HYPERDRIVE: { connectionString: "postgres://unused" },
	ENCRYPTION_KEY: "unused",
} as unknown as Env;

function seedDelivery(overrides: Row = {}): Row {
	const delivery = {
		id: "whd_1",
		webhookEventId: "whe_1",
		webhookId: "wh_1",
		organizationId: "org_1",
		status: "pending",
		attempts: 0,
		repairAttempts: 0,
		repairDeadlineAt: new Date(Date.now() + 24 * 60 * 60_000),
		leaseToken: 0,
		leaseExpiresAt: null,
		claimedAt: null,
		requestMayHaveBeenSentAt: null,
		completedAt: null,
		statusCode: null,
		responseTimeMs: null,
		manualReviewReason: null,
		manualReviewUntil: null,
		operatorIntervenedAt: null,
		operatorRetryRequestedAt: null,
		error: null,
		nextAttemptAt: new Date(Date.now() - 1_000),
		nextDispatchAt: new Date(Date.now() - 1_000),
		updatedAt: new Date(),
		...overrides,
	};
	activeDb.rows.webhookDeliveries.push(delivery);
	activeDb.rows.webhookEndpoints.push({
		id: "wh_1",
		enabled: true,
		url: "https://customer.example/webhook",
		secretCiphertext: "encrypted",
	});
	activeDb.rows.webhookEvents.push({
		id: "whe_1",
		event: "post.published",
		payload: { post_id: "post_1" },
		createdAt: new Date("2026-07-13T12:00:00.000Z"),
	});
	return delivery;
}

beforeEach(() => {
	activeDb = createDbDouble();
	fetchCallCount = 0;
	lastRequest = undefined;
	fetchResult = async () => new Response(null, { status: 200 });
	urlSafety = "allowed";
	decryptFailure = null;
	operatorAlerts = [];
});

describe("performWebhookDelivery", () => {
	it("adds exactly one HTTP attempt only after an audited operator retry", () => {
		expect(webhookDeliveryAttemptLimit(null)).toBe(8);
		expect(webhookDeliveryAttemptLimit(new Date())).toBe(9);
	});

	it("defers an indeterminate DNS result without disabling the endpoint", async () => {
		const delivery = seedDelivery();
		urlSafety = "indeterminate";

		expect(await performWebhookDelivery(env, "whd_1")).toBe("retry_scheduled");
		expect(delivery.status).toBe("pending");
		expect(delivery.attempts).toBe(0);
		expect(delivery.repairAttempts).toBe(1);
		expect(activeDb.rows.webhookEndpoints[0]?.enabled).toBe(true);
		expect(fetchCallCount).toBe(0);
	});

	it("defers a signing-key failure without disabling the endpoint", async () => {
		const delivery = seedDelivery();
		decryptFailure = new Error("Encryption key previous is not configured");

		expect(await performWebhookDelivery(env, "whd_1")).toBe("retry_scheduled");
		expect(delivery.status).toBe("pending");
		expect(delivery.attempts).toBe(0);
		expect(delivery.repairAttempts).toBe(1);
		expect(activeDb.rows.webhookEndpoints[0]?.enabled).toBe(true);
		expect(fetchCallCount).toBe(0);
	});

	it("terminates an unresolved pre-boundary repair at its durable deadline", async () => {
		const repairDeadlineAt = new Date(Date.now() - 1);
		const delivery = seedDelivery({
			repairDeadlineAt,
		});
		urlSafety = "indeterminate";

		expect(await performWebhookDelivery(env, "whd_1")).toBe("manual_review");
		expect(delivery.status).toBe("manual_review");
		expect(delivery.attempts).toBe(0);
		expect(delivery.repairAttempts).toBe(1);
		expect(delivery.completedAt).toBeNull();
		expect(delivery.manualReviewReason).toBe("pre_http_repair_exhausted");
		expect(delivery.manualReviewUntil).toEqual(
			new Date(
				repairDeadlineAt.getTime() + CUSTOMER_WEBHOOK_MANUAL_REVIEW_WINDOW_MS,
			),
		);
		expect(String(delivery.error)).toContain("automatic repair exhausted");
		expect(operatorAlerts).toEqual([
			expect.objectContaining({
				type: "customer_webhook_pre_boundary_repair_exhausted",
				organizationId: "org_1",
				deliveryId: "whd_1",
				repairAttempts: 1,
			}),
		]);
		expect(fetchCallCount).toBe(0);
	});

	it("schedules 429 for a durable retry and keeps the stable delivery ID", async () => {
		const delivery = seedDelivery();
		fetchResult = async () =>
			new Response(null, { status: 429, headers: { "Retry-After": "120" } });

		expect(await performWebhookDelivery(env, "whd_1")).toBe("retry_scheduled");
		expect(delivery.status).toBe("pending");
		expect(delivery.attempts).toBe(1);
		expect(delivery.statusCode).toBe(429);
		expect((delivery.nextAttemptAt as Date).getTime()).toBeGreaterThan(
			Date.now() + 110_000,
		);
		expect(
			new Headers(lastRequest?.headers).get("X-RelayAPI-Delivery-Id"),
		).toBe("whd_1");
		expect(activeDb.rows.webhookLogs).toHaveLength(1);
		expect(activeDb.rows.webhookLogs[0]).toEqual(
			expect.objectContaining({
				webhookEventId: "whe_1",
				webhookId: "wh_1",
				organizationId: "org_1",
			}),
		);
		expect(activeDb.rows.webhookLogs[0]).not.toHaveProperty("event");
		expect(activeDb.rows.webhookLogs[0]).not.toHaveProperty("payload");
	});

	it("treats a definitive 4xx response as terminal", async () => {
		const delivery = seedDelivery();
		fetchResult = async () => new Response(null, { status: 422 });

		expect(await performWebhookDelivery(env, "whd_1")).toBe("failed");
		expect(delivery.status).toBe("failed");
		expect(delivery.completedAt).toBeInstanceOf(Date);
		expect(delivery.statusCode).toBe(422);
	});

	it("stops retrying a server response at the durable attempt cap", async () => {
		const delivery = seedDelivery({ attempts: 7 });
		fetchResult = async () => new Response(null, { status: 503 });

		expect(await performWebhookDelivery(env, "whd_1")).toBe("failed");
		expect(delivery.attempts).toBe(8);
		expect(delivery.status).toBe("failed");
		expect(delivery.completedAt).toBeInstanceOf(Date);
	});

	it("retains an ambiguous transport failure as unknown", async () => {
		const delivery = seedDelivery();
		fetchResult = async () => {
			throw new DOMException("timed out", "TimeoutError");
		};

		expect(await performWebhookDelivery(env, "whd_1")).toBe("unknown");
		expect(delivery.status).toBe("manual_review");
		expect(delivery.requestMayHaveBeenSentAt).toBeInstanceOf(Date);
		expect(delivery.manualReviewReason).toBe("http_outcome_unknown");
		expect(
			(delivery.manualReviewUntil as Date).getTime() -
				(delivery.requestMayHaveBeenSentAt as Date).getTime(),
		).toBe(CUSTOMER_WEBHOOK_MANUAL_REVIEW_WINDOW_MS);
		expect(delivery.error).toBe("timed out");
	});

	it("does not claim a retry before its database schedule is due", async () => {
		seedDelivery({ nextAttemptAt: new Date(Date.now() + 60_000) });

		expect(await performWebhookDelivery(env, "whd_1")).toBe("not_due");
		expect(fetchCallCount).toBe(0);
	});

	it("reports a settled unknown row again until failure-ledger persistence succeeds", async () => {
		const requestMayHaveBeenSentAt = new Date();
		seedDelivery({
			status: "manual_review",
			attempts: 1,
			leaseExpiresAt: null,
			requestMayHaveBeenSentAt,
			manualReviewReason: "http_outcome_unknown",
			manualReviewUntil: new Date(
				requestMayHaveBeenSentAt.getTime() +
					CUSTOMER_WEBHOOK_MANUAL_REVIEW_WINDOW_MS,
			),
		});

		expect(await performWebhookDelivery(env, "whd_1")).toBe("unknown");
		expect(fetchCallCount).toBe(0);
	});

	it("allows only one worker to cross the HTTP boundary", async () => {
		const delivery = seedDelivery();
		let release!: () => void;
		fetchResult = () =>
			new Promise<Response>((resolve) => {
				release = () => resolve(new Response(null, { status: 200 }));
			});

		const first = performWebhookDelivery(env, "whd_1");
		for (let spin = 0; spin < 100 && fetchCallCount === 0; spin += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(fetchCallCount).toBe(1);
		expect(delivery.status).toBe("unknown");
		expect(await performWebhookDelivery(env, "whd_1")).toBe("not_due");
		release();
		expect(await first).toBe("succeeded");
		expect(delivery.status).toBe("succeeded");
	});
});
