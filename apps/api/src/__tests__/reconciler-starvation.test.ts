import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Env } from "../types";

type Row = Record<string, unknown>;
type RowContext = Record<string, Row>;

type Column = {
	kind: "column";
	table: string;
	name: string;
};

type Expression = {
	kind: "expression";
	evaluate: (context: RowContext) => unknown;
};

type SortExpression = {
	kind: "sort";
	column: Column;
};

type FakeTable = {
	_name: string;
	[key: string]: unknown;
};

function column(table: string, name: string): Column {
	return { kind: "column", table, name };
}

function table(name: string): FakeTable {
	return new Proxy(
		{ _name: name },
		{
			get(target, property) {
				if (property in target) return target[property as keyof typeof target];
				if (typeof property === "string") return column(name, property);
				return undefined;
			},
		},
	);
}

function expression(evaluate: (context: RowContext) => unknown): Expression {
	return { kind: "expression", evaluate };
}

function resolve(value: unknown, context: RowContext): unknown {
	if (
		value &&
		typeof value === "object" &&
		"kind" in value &&
		value.kind === "column"
	) {
		const ref = value as Column;
		return context[ref.table]?.[ref.name];
	}
	if (
		value &&
		typeof value === "object" &&
		"kind" in value &&
		value.kind === "expression"
	) {
		return (value as Expression).evaluate(context);
	}
	return value;
}

function comparable(value: unknown): unknown {
	return value instanceof Date ? value.getTime() : value;
}

function compare(left: unknown, right: unknown): number {
	const a = comparable(left);
	const b = comparable(right);
	if (a == null && b == null) return 0;
	if (a == null) return 1;
	if (b == null) return -1;
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

const automationBindings = table("automationBindings");
const automationContactControls = table("automationContactControls");
const automationEffects = table("automationEffects");
const automationEntrypoints = table("automationEntrypoints");
const automationNodeExecutions = table("automationNodeExecutions");
const automationRuns = table("automationRuns");
const automationScheduledJobs = table("automationScheduledJobs");
const automationStepRuns = table("automationStepRuns");
const automations = table("automations");
const contacts = table("contacts");
const customFieldDefinitions = table("customFieldDefinitions");
const customFieldValues = table("customFieldValues");
const inboxConversations = table("inboxConversations");
const posts = table("posts");
const postTargets = table("postTargets");
const publishOutbox = table("publishOutbox");
const socialAccounts = table("socialAccounts");

class FakeSelect {
	private condition: Expression | undefined;
	private limitCount: number | undefined;
	private sortExpressions: SortExpression[] = [];
	private source: FakeTable | undefined;

	constructor(
		private readonly db: FakeDb,
		private readonly fields: Record<string, unknown> | undefined,
	) {}

	from(source: FakeTable): this {
		this.source = source;
		return this;
	}

	where(condition: Expression | undefined): this {
		this.condition = condition;
		return this;
	}

	orderBy(...sortExpressions: SortExpression[]): this {
		this.sortExpressions = sortExpressions;
		return this;
	}

	limit(limit: number): this {
		this.limitCount = limit;
		return this;
	}

	hasMatch(outerContext: RowContext): boolean {
		return this.sourceRows(outerContext).length > 0;
	}

	private sourceRows(outerContext: RowContext = {}): Row[] {
		if (!this.source) throw new Error("select source is missing");
		const tableName = this.source._name;
		let rows = this.db.rows(tableName).filter((row) => {
			const context = { ...outerContext, [tableName]: row };
			return this.condition ? Boolean(this.condition.evaluate(context)) : true;
		});
		if (this.sortExpressions.length > 0) {
			rows = [...rows].sort((left, right) => {
				for (const sort of this.sortExpressions) {
					const result = compare(
						resolve(sort.column, { [tableName]: left }),
						resolve(sort.column, { [tableName]: right }),
					);
					if (result !== 0) return result;
				}
				return 0;
			});
		}
		if (this.limitCount !== undefined) rows = rows.slice(0, this.limitCount);
		return rows;
	}

	private execute(): Row[] {
		if (!this.source) throw new Error("select source is missing");
		const tableName = this.source._name;
		const rows = this.sourceRows();
		if (!this.fields) return rows.map((row) => ({ ...row }));
		return rows.map((row) => {
			const context = { [tableName]: row };
			return Object.fromEntries(
				Object.entries(this.fields ?? {}).map(([key, value]) => [
					key,
					resolve(value, context),
				]),
			);
		});
	}

	// biome-ignore lint/suspicious/noThenProperty: intentional query-builder thenable
	then<TResult1 = Row[], TResult2 = never>(
		onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
	}
}

class FakeDb {
	private readonly data = new Map<string, Row[]>();

	readonly query = {
		automationRuns: {
			findFirst: async ({ where }: { where: Expression }) =>
				this.rows("automationRuns").find((row) =>
					Boolean(where.evaluate({ automationRuns: row })),
				),
		},
	};

	seed(tableName: string, rows: Row[]): void {
		this.data.set(
			tableName,
			rows.map((row) => ({ ...row })),
		);
	}

	rows(tableName: string): Row[] {
		return this.data.get(tableName) ?? [];
	}

	select(fields?: Record<string, unknown>): FakeSelect {
		return new FakeSelect(this, fields);
	}

	update(source: FakeTable) {
		let patch: Row = {};
		let condition: Expression | undefined;
		const apply = () => {
			const changed = this.rows(source._name).filter((row) => {
				const matches = condition
					? Boolean(condition.evaluate({ [source._name]: row }))
					: true;
				if (matches) Object.assign(row, patch);
				return matches;
			});
			return changed;
		};
		const chain = {
			set: (values: Row) => {
				patch = values;
				return chain;
			},
			where: (where: Expression) => {
				condition = where;
				return chain;
			},
			returning: (fields?: Record<string, unknown>) => {
				const changed = apply();
				if (!fields) return Promise.resolve(changed);
				return Promise.resolve(
					changed.map((row) =>
						Object.fromEntries(
							Object.entries(fields).map(([key, value]) => [
								key,
								resolve(value, { [source._name]: row }),
							]),
						),
					),
				);
			},
		};
		return chain;
	}

	insert(source: FakeTable) {
		let values: Row = {};
		let inserted = false;
		const apply = () => {
			if (inserted) return;
			inserted = true;
			this.rows(source._name).push({ ...values });
		};
		const chain = {
			values: (nextValues: Row) => {
				values = nextValues;
				return chain;
			},
			onConflictDoNothing: () => chain,
			// biome-ignore lint/suspicious/noThenProperty: intentional query-builder thenable
			then: <TResult1 = void, TResult2 = never>(
				onfulfilled?:
					| ((value: undefined) => TResult1 | PromiseLike<TResult1>)
					| null,
				onrejected?:
					| ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
					| null,
			): Promise<TResult1 | TResult2> => {
				apply();
				return Promise.resolve(undefined).then(onfulfilled, onrejected);
			},
		};
		return chain;
	}

	transaction<T>(callback: (tx: FakeDb) => Promise<T>): Promise<T> {
		return callback(this);
	}
}

let activeDb = new FakeDb();
const dispatchPublishOutbox = mock(async () => 0);

mock.module("@relayapi/db", () => ({
	automationBindings,
	automationContactControls,
	automationEffects,
	automationEntrypoints,
	automationNodeExecutions,
	automationRuns,
	automationScheduledJobs,
	automationStepRuns,
	automations,
	contacts,
	createDb: () => activeDb,
	customFieldDefinitions,
	customFieldValues,
	inboxConversations,
	posts,
	postTargets,
	publishOutbox,
	socialAccounts,
}));

mock.module("drizzle-orm", () => ({
	and: (...conditions: Array<Expression | undefined>) =>
		expression((context) =>
			conditions.every(
				(condition) => !condition || Boolean(condition.evaluate(context)),
			),
		),
	asc: (value: Column): SortExpression => ({ kind: "sort", column: value }),
	eq: (left: unknown, right: unknown) =>
		expression((context) => resolve(left, context) === resolve(right, context)),
	gt: (left: unknown, right: unknown) =>
		expression(
			(context) => compare(resolve(left, context), resolve(right, context)) > 0,
		),
	inArray: (left: unknown, values: unknown[]) =>
		expression((context) => values.includes(resolve(left, context))),
	isNotNull: (value: unknown) =>
		expression((context) => resolve(value, context) != null),
	isNull: (value: unknown) =>
		expression((context) => resolve(value, context) == null),
	lte: (left: unknown, right: unknown) =>
		expression(
			(context) =>
				compare(resolve(left, context), resolve(right, context)) <= 0,
		),
	notExists: (query: FakeSelect) =>
		expression((context) => !query.hasMatch(context)),
	or: (...conditions: Expression[]) =>
		expression((context) =>
			conditions.some((condition) => Boolean(condition.evaluate(context))),
		),
	sql: () => expression(() => true),
}));

mock.module("../services/automations/manifest", () => ({
	getHandler: () => undefined,
}));

mock.module("../services/publish-outbox", () => ({
	dispatchPublishOutbox,
	publishOutboxRow: (values: Row) => values,
}));

const { reconcileExternalEventWaits } = await import(
	"../services/automations/runner"
);
const { reconcilePostPublishExecutions } = await import(
	"../services/post-publish-reconciler"
);

describe("bounded reconciler starvation", () => {
	beforeEach(() => {
		activeDb = new FakeDb();
		dispatchPublishOutbox.mockClear();
	});

	it("finds an eligible automation run beyond a full batch of active pauses", async () => {
		const updatedAt = new Date("2026-07-13T12:00:00.000Z");
		const pausedRuns = Array.from({ length: 100 }, (_, index) => ({
			id: `run_paused_${index.toString().padStart(3, "0")}`,
			organizationId: "org_1",
			contactId: `contact_${index.toString().padStart(3, "0")}`,
			automationId: "auto_1",
			status: "waiting",
			waitingFor: "external_event",
			updatedAt: new Date(updatedAt.getTime() + index),
		}));
		const eligibleRun = {
			id: "run_eligible",
			organizationId: "org_1",
			contactId: "contact_eligible",
			automationId: "auto_1",
			status: "waiting",
			waitingFor: "external_event",
			updatedAt: new Date(updatedAt.getTime() + 1_000),
		};
		activeDb.seed("automationRuns", [...pausedRuns, eligibleRun]);
		activeDb.seed(
			"automationContactControls",
			pausedRuns.map((run, index) => ({
				id: `pause_${index}`,
				organizationId: run.organizationId,
				contactId: run.contactId,
				automationId: run.automationId,
				pausedUntil: null,
			})),
		);
		activeDb.seed("automationScheduledJobs", []);

		const result = await reconcileExternalEventWaits(
			activeDb as never,
			{},
			100,
		);

		expect(result).toEqual({ scanned: 1, resumed: 1 });
		expect(
			activeDb.rows("automationRuns").find((row) => row.id === "run_eligible")
				?.status,
		).toBe("active");
		expect(
			activeDb
				.rows("automationRuns")
				.filter((row) => String(row.id).startsWith("run_paused_"))
				.every((row) => row.status === "waiting"),
		).toBe(true);
		expect(activeDb.rows("automationScheduledJobs")).toHaveLength(1);
	});

	it("finds expired work beyond a full post batch and ignores null leases", async () => {
		const now = Date.now();
		const blockedPosts = Array.from({ length: 30 }, (_, index) => ({
			id: `post_blocked_${index.toString().padStart(3, "0")}`,
			organizationId: "org_1",
			status: "publishing",
			publishLeaseId: `lease_blocked_${index}`,
			publishLeaseExpiresAt: new Date(now - 120_000 + index),
			publishAttempts: 1,
			updatedAt: new Date(now - 120_000 + index),
		}));
		const nullLeasePosts = Array.from({ length: 30 }, (_, index) => ({
			id: `post_unknown_${index.toString().padStart(3, "0")}`,
			organizationId: "org_1",
			status: "publishing",
			publishLeaseId: null,
			publishLeaseExpiresAt: null,
			publishAttempts: 1,
			updatedAt: new Date(now - 86_400_000 + index),
		}));
		const eligiblePost = {
			id: "post_eligible",
			organizationId: "org_1",
			status: "publishing",
			publishLeaseId: "lease_eligible",
			publishLeaseExpiresAt: new Date(now - 60_000),
			publishAttempts: 2,
			updatedAt: new Date(now - 60_000),
		};
		activeDb.seed("posts", [...blockedPosts, ...nullLeasePosts, eligiblePost]);
		activeDb.seed("postTargets", [
			...blockedPosts.map((post, index) => ({
				id: `target_blocked_${index}`,
				postId: post.id,
				deliveryState: "in_flight",
				requestMayHaveBeenSentAt: null,
				leaseExpiresAt: new Date(now + 3_600_000),
			})),
			...nullLeasePosts.map((post, index) => ({
				id: `target_unknown_${index}`,
				postId: post.id,
				deliveryState: "unknown",
				requestMayHaveBeenSentAt: new Date(now - 86_400_000),
				leaseExpiresAt: null,
			})),
			{
				id: "target_eligible",
				postId: eligiblePost.id,
				deliveryState: "queued",
				requestMayHaveBeenSentAt: null,
				leaseExpiresAt: null,
			},
		]);
		activeDb.seed("publishOutbox", []);

		const env = {
			HYPERDRIVE: { connectionString: "postgresql://test.invalid/test" },
		} as Env;
		expect(await reconcilePostPublishExecutions(env)).toBe(1);
		expect(await reconcilePostPublishExecutions(env)).toBe(0);

		expect(
			activeDb.rows("posts").find((row) => row.id === eligiblePost.id)
				?.publishLeaseId,
		).toBeNull();
		expect(
			activeDb
				.rows("posts")
				.filter((row) => String(row.id).startsWith("post_blocked_"))
				.every((row) => row.publishLeaseId != null),
		).toBe(true);
		expect(
			activeDb
				.rows("posts")
				.filter((row) => String(row.id).startsWith("post_unknown_"))
				.every((row) => row.terminalReason === undefined),
		).toBe(true);
		expect(activeDb.rows("publishOutbox")).toHaveLength(1);
		expect(dispatchPublishOutbox).toHaveBeenCalledTimes(1);
	});
});
