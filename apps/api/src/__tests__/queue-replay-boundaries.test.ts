import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Env } from "../types";

type Row = Record<string, unknown>;
type Column = { name: string };
type Expression = { resolve: (row: Row) => unknown };
type Table = { _name: keyof Store } & Record<string, Column>;
type Store = {
	emailDeliveries: Row[];
	inboundWebhookEvents: Row[];
	postTargets: Row[];
	queueFailures: Row[];
	webhookDeliveries: Row[];
};

const expression = (resolve: (row: Row) => unknown): Expression => ({
	resolve,
});
const column = (name: string): Column => ({ name });
const table = (name: keyof Store, columns: string[]): Table =>
	Object.assign(
		{ _name: name },
		Object.fromEntries(columns.map((name) => [name, column(name)])),
	) as Table;

const emailDeliveries = table("emailDeliveries", [
	"id",
	"status",
	"leaseExpiresAt",
	"requestMayHaveBeenSentAt",
	"providerMessageId",
	"error",
	"completedAt",
	"nextAttemptAt",
	"nextDispatchAt",
	"dispatchLeaseExpiresAt",
]);
const inboundWebhookEvents = table("inboundWebhookEvents", [
	"id",
	"status",
	"attempts",
	"claimedAt",
	"organizationIds",
]);
const postTargets = table("postTargets", [
	"id",
	"postId",
	"organizationId",
	"deliveryState",
]);
const queueFailures = table("queueFailures", [
	"id",
	"queueName",
	"messageId",
	"organizationIds",
	"failureKind",
	"status",
	"replayClaimToken",
	"replayClaimExpiresAt",
	"replayRequestedAt",
	"replayError",
	"resolvedAt",
]);
const webhookDeliveries = table("webhookDeliveries", [
	"id",
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
	"dispatchLeaseId",
	"dispatchLeaseExpiresAt",
	"nextDispatchAt",
	"lastEnqueuedAt",
	"dispatchAttempts",
	"updatedAt",
]);

function resolveValue(value: unknown, row: Row): unknown {
	return value &&
		typeof value === "object" &&
		"resolve" in value &&
		typeof (value as Expression).resolve === "function"
		? (value as Expression).resolve(row)
		: value;
}

function tableName(value: unknown): keyof Store {
	return (value as Table)._name;
}

function cloneStore(store: Store): Store {
	return structuredClone(store);
}

function replaceStore(target: Store, source: Store): void {
	for (const name of Object.keys(target) as Array<keyof Store>) {
		target[name] = source[name];
	}
}

type DbControls = {
	failNextUpdateTable: keyof Store | null;
	throwNextUpdateTable: keyof Store | null;
	beforeTransaction: ((draft: Store, committed: Store) => void) | null;
	loseCommitResponse: boolean;
};

function createDbDouble(initial: Store) {
	const rows = initial;
	const controls: DbControls = {
		failNextUpdateTable: null,
		throwNextUpdateTable: null,
		beforeTransaction: null,
		loseCommitResponse: false,
	};

	const createApi = (store: Store) => {
		const api = {
			select(fields?: Record<string, Column>) {
				let source: keyof Store;
				let condition = (_row: Row) => true;
				let requestedLimit = Number.POSITIVE_INFINITY;
				const chain = {
					from(value: unknown) {
						source = tableName(value);
						return chain;
					},
					where(value: Expression) {
						condition = (row: Row) => Boolean(value.resolve(row));
						return chain;
					},
					orderBy(..._values: unknown[]) {
						return chain;
					},
					limit(value: number) {
						requestedLimit = value;
						return chain;
					},
					// biome-ignore lint/suspicious/noThenProperty: awaitable Drizzle test double
					then(
						resolve: (value: Row[]) => void,
						reject: (error: unknown) => void,
					) {
						try {
							const selected = store[source]
								.filter(condition)
								.slice(0, requestedLimit)
								.map((row) => {
									if (!fields) return { ...row };
									return Object.fromEntries(
										Object.entries(fields).map(([alias, selectedColumn]) => [
											alias,
											row[selectedColumn.name],
										]),
									);
								});
							resolve(selected);
						} catch (error) {
							reject(error);
						}
					},
				};
				return chain;
			},
			update(value: unknown) {
				const source = tableName(value);
				let values: Row = {};
				let condition = (_row: Row) => true;
				let applied: Row[] | null = null;
				const apply = () => {
					if (applied) return applied;
					if (controls.throwNextUpdateTable === source) {
						controls.throwNextUpdateTable = null;
						throw new Error(`connection unavailable updating ${source}`);
					}
					if (controls.failNextUpdateTable === source) {
						controls.failNextUpdateTable = null;
						applied = [];
						return applied;
					}
					applied = store[source].filter(condition);
					for (const row of applied) {
						for (const [key, next] of Object.entries(values)) {
							row[key] = resolveValue(next, row);
						}
					}
					return applied;
				};
				const chain = {
					set(next: Row) {
						values = next;
						return chain;
					},
					where(next: Expression) {
						condition = (row: Row) => Boolean(next.resolve(row));
						return chain;
					},
					async returning(fields?: Record<string, Column>) {
						const changed = apply();
						if (!fields) return changed.map((row) => ({ ...row }));
						return changed.map((row) =>
							Object.fromEntries(
								Object.entries(fields).map(([alias, selectedColumn]) => [
									alias,
									row[selectedColumn.name],
								]),
							),
						);
					},
					// biome-ignore lint/suspicious/noThenProperty: awaitable Drizzle test double
					then(
						resolve: (value: undefined) => void,
						reject: (error: unknown) => void,
					) {
						try {
							apply();
							resolve(undefined);
						} catch (error) {
							reject(error);
						}
					},
				};
				return chain;
			},
		};
		return api;
	};

	const db = {
		...createApi(rows),
		async transaction<T>(
			run: (tx: ReturnType<typeof createApi>) => Promise<T>,
		): Promise<T> {
			const draft = cloneStore(rows);
			controls.beforeTransaction?.(draft, rows);
			const result = await run(createApi(draft));
			replaceStore(rows, draft);
			if (controls.loseCommitResponse) {
				controls.loseCommitResponse = false;
				controls.throwNextUpdateTable = "queueFailures";
				throw new Error("connection ended after COMMIT");
			}
			return result;
		},
		controls,
		rows,
	};
	return db;
}

let activeDb = createDbDouble(emptyStore());
let replayPayload: Record<string, unknown> = {};

mock.module("@relayapi/db", () => ({
	createDb: () => activeDb,
	emailDeliveries,
	inboundWebhookEvents,
	postTargets,
	queueFailures,
	webhookDeliveries,
}));

mock.module("drizzle-orm", () => ({
	and: (...values: Expression[]) =>
		expression((row) => values.every((value) => Boolean(value.resolve(row)))),
	asc: (value: unknown) => value,
	eq: (selectedColumn: Column, value: unknown) =>
		expression((row) => row[selectedColumn.name] === resolveValue(value, row)),
	inArray: (selectedColumn: Column, values: unknown[]) =>
		expression((row) => values.includes(row[selectedColumn.name])),
	isNull: (selectedColumn: Column) =>
		expression((row) => row[selectedColumn.name] == null),
	lt: (selectedColumn: Column, value: unknown) =>
		expression(
			(row) =>
				(row[selectedColumn.name] as Date | number) <
				(resolveValue(value, row) as Date | number),
		),
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
		const source = strings.join("?");
		if (source.includes("@> ARRAY[")) {
			const selectedColumn = values[0] as Column;
			const member = values[1];
			return expression(
				(row) =>
					Array.isArray(row[selectedColumn.name]) &&
					(row[selectedColumn.name] as unknown[]).includes(member),
			);
		}
		if (source.includes("= ARRAY[")) {
			const selectedColumn = values[0] as Column;
			const member = values[1];
			return expression((row) => {
				const actual = row[selectedColumn.name];
				return (
					Array.isArray(actual) && actual.length === 1 && actual[0] === member
				);
			});
		}
		if (source.includes("+ 1")) {
			const selectedColumn = values[0] as Column;
			return expression((row) => Number(row[selectedColumn.name] ?? 0) + 1);
		}
		throw new Error(`Unhandled SQL expression in queue replay test: ${source}`);
	},
}));

mock.module("../queues/failures", () => ({
	decryptQueueFailurePayload: async () => replayPayload,
}));

mock.module("../services/ad-creation-operations", () => ({
	getAdCreationReplayState: async () => "safe",
}));

const { reconcileQueueReplayClaims, replayQueueFailure } = await import(
	"../services/queue-replay"
);

let sendCalls = 0;
let sendError: Error | null = null;
const queueMetrics = { backlogCount: 0, backlogBytes: 0 };
const queue: Queue = {
	async metrics() {
		return queueMetrics;
	},
	async send(_payload: unknown) {
		sendCalls += 1;
		if (sendError) throw sendError;
		return { metadata: { metrics: queueMetrics } };
	},
	async sendBatch(messages) {
		for (const _message of messages) sendCalls += 1;
		if (sendError) throw sendError;
		return { metadata: { metrics: queueMetrics } };
	},
};

const env = {
	HYPERDRIVE: { connectionString: "postgres://unused" },
	PUBLISH_QUEUE: queue,
	EMAIL_QUEUE: queue,
	REFRESH_QUEUE: queue,
	INBOX_QUEUE: queue,
	TOOLS_QUEUE: queue,
	ADS_QUEUE: queue,
	SYNC_QUEUE: queue,
	CUSTOMER_WEBHOOK_QUEUE: queue,
} as unknown as Env;

function emptyStore(): Store {
	return {
		emailDeliveries: [],
		inboundWebhookEvents: [],
		postTargets: [],
		queueFailures: [],
		webhookDeliveries: [],
	};
}

function failure(queueName: string): Row {
	return {
		id: "qf_1",
		queueName,
		messageId: "msg_1",
		organizationIds: ["org_1"],
		failureKind: "dead_letter",
		status: "unresolved",
		replayClaimToken: null,
		replayClaimExpiresAt: null,
		replayRequestedAt: null,
		replayError: null,
		resolvedAt: null,
	};
}

function webhookDelivery(): Row {
	return {
		id: "whd_1",
		organizationId: "org_1",
		status: "failed",
		attempts: 8,
		repairAttempts: 12,
		repairDeadlineAt: new Date("2026-07-30T00:00:00.000Z"),
		leaseToken: 4,
		operatorIntervenedAt: null,
		operatorRetryRequestedAt: null,
	};
}

beforeEach(() => {
	activeDb = createDbDouble(emptyStore());
	replayPayload = {};
	sendCalls = 0;
	sendError = null;
});

describe("queue replay boundary classification", () => {
	it("releases a reset conflict as known-not-sent", async () => {
		activeDb.rows.queueFailures.push(failure("relayapi-email-dlq"));
		activeDb.rows.emailDeliveries.push({
			id: "email_1",
			status: "failed",
		});
		replayPayload = { id: "email_1" };
		activeDb.controls.failNextUpdateTable = "emailDeliveries";

		const result = await replayQueueFailure(env, "qf_1", "org_1");

		expect(result.replayed).toBe(false);
		expect(result.reason).toContain("before the Queue send boundary");
		expect(sendCalls).toBe(0);
		expect(activeDb.rows.queueFailures[0]?.status).toBe("unresolved");
		expect(activeDb.rows.queueFailures[0]?.replayClaimToken).toBeNull();
	});

	it("marks a Queue send error as externally ambiguous", async () => {
		activeDb.rows.queueFailures.push(failure("relayapi-publish-dlq"));
		replayPayload = { post_id: "post_1" };
		sendError = new Error("binding response lost");

		const result = await replayQueueFailure(env, "qf_1", "org_1");

		expect(result.replayed).toBe(false);
		expect(result.outcomeUnknown).toBe(true);
		expect(result.reason).toContain("outcome is unknown");
		expect(sendCalls).toBe(1);
		expect(activeDb.rows.queueFailures[0]?.status).toBe("replay_unknown");
	});

	it("replays a self-host DLQ through the canonical capability binding", async () => {
		activeDb.rows.queueFailures.push(failure("relayapi-selfhost-publish-dlq"));
		replayPayload = { post_id: "post_1" };

		const result = await replayQueueFailure(env, "qf_1", "org_1");

		expect(result).toEqual({ replayed: true });
		expect(sendCalls).toBe(1);
		expect(activeDb.rows.queueFailures[0]?.status).toBe("replayed");
	});

	it("commits the customer-webhook reset and ledger resolution atomically", async () => {
		activeDb.rows.queueFailures.push(failure("relayapi-customer-webhooks-dlq"));
		activeDb.rows.webhookDeliveries.push(webhookDelivery());
		replayPayload = { delivery_id: "whd_1" };

		const result = await replayQueueFailure(env, "qf_1", "org_1");

		expect(result).toEqual({ replayed: true });
		expect(sendCalls).toBe(0);
		expect(activeDb.rows.webhookDeliveries[0]?.status).toBe("pending");
		expect(activeDb.rows.webhookDeliveries[0]?.leaseToken).toBe(5);
		expect(activeDb.rows.queueFailures[0]?.status).toBe("replayed");
	});

	it("rolls back the webhook reset when the ledger fence is lost", async () => {
		activeDb.rows.queueFailures.push(failure("relayapi-customer-webhooks-dlq"));
		activeDb.rows.webhookDeliveries.push(webhookDelivery());
		replayPayload = { delivery_id: "whd_1" };
		activeDb.controls.beforeTransaction = () => {
			activeDb.controls.failNextUpdateTable = "queueFailures";
		};

		const result = await replayQueueFailure(env, "qf_1", "org_1");

		expect(result.replayed).toBe(false);
		expect(sendCalls).toBe(0);
		expect(activeDb.rows.webhookDeliveries[0]?.status).toBe("failed");
		expect(activeDb.rows.queueFailures[0]?.status).toBe("unresolved");
	});

	it("preserves a concurrent operator fence and releases the replay claim", async () => {
		activeDb.rows.queueFailures.push(failure("relayapi-customer-webhooks-dlq"));
		activeDb.rows.webhookDeliveries.push(webhookDelivery());
		replayPayload = { delivery_id: "whd_1" };
		const intervenedAt = new Date("2026-07-28T12:00:00.000Z");
		activeDb.controls.beforeTransaction = (draft, committed) => {
			const draftDelivery = draft.webhookDeliveries[0];
			const committedDelivery = committed.webhookDeliveries[0];
			if (!draftDelivery || !committedDelivery) {
				throw new Error("webhook replay fixture is missing");
			}
			draftDelivery.operatorIntervenedAt = intervenedAt;
			committedDelivery.operatorIntervenedAt = intervenedAt;
		};

		const result = await replayQueueFailure(env, "qf_1", "org_1");

		expect(result.replayed).toBe(false);
		expect(sendCalls).toBe(0);
		expect(activeDb.rows.webhookDeliveries[0]?.operatorIntervenedAt).toEqual(
			intervenedAt,
		);
		expect(activeDb.rows.queueFailures[0]?.status).toBe("unresolved");
	});

	it("resolves a lost COMMIT response from the atomically updated ledger", async () => {
		activeDb.rows.queueFailures.push(failure("relayapi-customer-webhooks-dlq"));
		activeDb.rows.webhookDeliveries.push(webhookDelivery());
		replayPayload = { delivery_id: "whd_1" };
		activeDb.controls.loseCommitResponse = true;

		const result = await replayQueueFailure(env, "qf_1", "org_1");

		expect(result).toEqual({ replayed: true });
		expect(sendCalls).toBe(0);
		expect(activeDb.rows.webhookDeliveries[0]?.status).toBe("pending");
		expect(activeDb.rows.queueFailures[0]?.status).toBe("replayed");
		expect(activeDb.rows.queueFailures[0]?.replayClaimExpiresAt).toBeNull();
	});

	it("reopens only expired atomic webhook claims", async () => {
		const expiredAt = new Date("2020-01-01T00:00:00.000Z");
		activeDb.rows.queueFailures.push(
			{
				...failure("relayapi-selfhost-customer-webhooks-dlq"),
				id: "qf_webhook",
				status: "replay_claimed",
				replayClaimToken: "claim_webhook",
				replayClaimExpiresAt: expiredAt,
			},
			{
				...failure("relayapi-selfhost-publish-dlq"),
				id: "qf_publish",
				status: "replay_claimed",
				replayClaimToken: "claim_publish",
				replayClaimExpiresAt: expiredAt,
			},
		);

		const reconciled = await reconcileQueueReplayClaims(env);

		expect(reconciled).toBe(2);
		expect(activeDb.rows.queueFailures[0]?.status).toBe("unresolved");
		expect(activeDb.rows.queueFailures[0]?.replayClaimToken).toBeNull();
		expect(activeDb.rows.queueFailures[1]?.status).toBe("replay_unknown");
	});
});
