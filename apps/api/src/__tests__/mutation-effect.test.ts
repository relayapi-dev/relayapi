import { describe, expect, it } from "bun:test";
import type { Database } from "@relayapi/db";
import {
	instrumentMutationDatabase,
	MutationEffectTracker,
} from "../lib/mutation-effect";
import { returnMutationInputNotApplied } from "../middleware/mutation-validation";

function writeBuilder(operation: () => Promise<unknown>) {
	const builder = {
		set() {
			return builder;
		},
		values() {
			return builder;
		},
		where() {
			return builder;
		},
		returning() {
			return builder;
		},
		// biome-ignore lint/suspicious/noThenProperty: intentional Drizzle double
		then(
			fulfilled?: (value: unknown) => unknown,
			rejected?: (reason: unknown) => unknown,
		) {
			return operation().then(fulfilled, rejected);
		},
	};
	return builder;
}

describe("request mutation-effect evidence", () => {
	it("returns shared preflight responses while proving K=0", () => {
		const tracker = new MutationEffectTracker();
		tracker.markRouteEntered();
		const response = new Response("rejected", { status: 404 });
		const context = {
			get(name: string) {
				return name === "mutationEffectTracker" ? tracker : undefined;
			},
		};

		expect(returnMutationInputNotApplied(context as never, response)).toBe(
			response,
		);
		expect(tracker.outcome(1)).toEqual({ kind: "not_applied" });
		expect(tracker.isProvenNotApplied()).toBe(true);
	});

	it("keeps an unresolved attempt unknown", () => {
		const tracker = new MutationEffectTracker();
		tracker.markRouteEntered();
		tracker.markCoverageComplete();
		tracker.begin("provider.call");
		expect(tracker.outcome(1)).toEqual({ kind: "unknown" });
		expect(tracker.isProvenNotApplied()).toBe(false);
	});

	it("aggregates exact bulk K and refuses an impossible K above N", () => {
		const tracker = new MutationEffectTracker();
		tracker.markRouteEntered();
		tracker.markCoverageComplete();
		const first = tracker.begin("bulk.first");
		const second = tracker.begin("bulk.second");
		first.committed(3);
		second.committed(2);
		expect(tracker.outcome(10)).toEqual({ kind: "committed", units: 5 });
		expect(tracker.outcome(4)).toEqual({ kind: "unknown" });
	});

	it("normalizes an exact committed K=0 attempt to not applied", () => {
		const tracker = new MutationEffectTracker();
		tracker.markRouteEntered();
		tracker.markCoverageComplete();
		tracker.begin("provider.noop").committed(0);

		expect(tracker.outcome(1)).toEqual({ kind: "not_applied" });
		expect(tracker.isProvenNotApplied()).toBe(true);
	});

	it("treats successful SQL as exact evidence only for a single-unit request", async () => {
		const tracker = new MutationEffectTracker();
		tracker.markRouteEntered();
		tracker.markCoverageComplete();
		const db = instrumentMutationDatabase(
			{
				update: () => writeBuilder(async () => []),
			} as unknown as Database,
			tracker,
		);
		await db
			.update({} as never)
			.set({})
			.where(undefined as never);
		expect(tracker.outcome(1)).toEqual({ kind: "committed", units: 1 });
		expect(tracker.outcome(10)).toEqual({ kind: "unknown" });
	});

	it("proves a RETURNING write with no affected rows was not applied", async () => {
		const tracker = new MutationEffectTracker();
		tracker.markRouteEntered();
		tracker.markCoverageComplete();
		const db = instrumentMutationDatabase(
			{
				update: () => writeBuilder(async () => []),
			} as unknown as Database,
			tracker,
		);

		await db
			.update({} as never)
			.set({})
			.where(undefined as never)
			.returning();

		expect(tracker.outcome(1)).toEqual({ kind: "not_applied" });
		expect(tracker.isProvenNotApplied()).toBe(true);
	});

	it("records a non-empty RETURNING write as committed", async () => {
		const tracker = new MutationEffectTracker();
		tracker.markRouteEntered();
		tracker.markCoverageComplete();
		const db = instrumentMutationDatabase(
			{
				update: () => writeBuilder(async () => [{ id: "row_1" }]),
			} as unknown as Database,
			tracker,
		);

		await db
			.update({} as never)
			.set({})
			.where(undefined as never)
			.returning();

		expect(tracker.outcome(1)).toEqual({ kind: "committed", units: 1 });
	});

	it("keeps a rejected autocommit statement ambiguous", async () => {
		const tracker = new MutationEffectTracker();
		tracker.markRouteEntered();
		tracker.markCoverageComplete();
		const db = instrumentMutationDatabase(
			{
				delete: () =>
					writeBuilder(async () => {
						throw new Error("statement rejected");
					}),
			} as unknown as Database,
			tracker,
		);
		await expect(
			Promise.resolve(db.delete({} as never).where(undefined as never)),
		).rejects.toThrow("statement rejected");
		expect(tracker.outcome(1)).toEqual({ kind: "unknown" });
		expect(tracker.isProvenNotApplied()).toBe(false);
	});

	it("distinguishes callback rollback from an ambiguous commit acknowledgement", async () => {
		const commitTracker = new MutationEffectTracker();
		commitTracker.markRouteEntered();
		commitTracker.markCoverageComplete();
		const committed = instrumentMutationDatabase(
			{
				transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
					callback({ insert: () => writeBuilder(async () => []) }),
			} as unknown as Database,
			commitTracker,
		);
		await committed.transaction(async (tx) => {
			await tx.insert({} as never).values({});
		});
		expect(commitTracker.outcome(1)).toEqual({ kind: "committed", units: 1 });

		const ambiguousTracker = new MutationEffectTracker();
		ambiguousTracker.markRouteEntered();
		ambiguousTracker.markCoverageComplete();
		const ambiguous = instrumentMutationDatabase(
			{
				transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
					await callback({ update: () => writeBuilder(async () => []) });
					throw new Error("commit acknowledgement lost");
				},
			} as unknown as Database,
			ambiguousTracker,
		);
		await expect(
			ambiguous.transaction(async (tx) => {
				await tx.update({} as never).set({});
			}),
		).rejects.toThrow("commit acknowledgement lost");
		expect(ambiguousTracker.outcome(1)).toEqual({ kind: "unknown" });

		const rollbackTracker = new MutationEffectTracker();
		rollbackTracker.markRouteEntered();
		rollbackTracker.markCoverageComplete();
		const rolledBack = instrumentMutationDatabase(
			{
				transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
					callback({ update: () => writeBuilder(async () => []) }),
			} as unknown as Database,
			rollbackTracker,
		);
		await expect(
			rolledBack.transaction(async (tx) => {
				await tx.update({} as never).set({});
				throw new Error("callback rollback");
			}),
		).rejects.toThrow("callback rollback");
		expect(rollbackTracker.outcome(1)).toEqual({ kind: "not_applied" });
	});

	it("proves a committed transaction of only zero-row RETURNING writes was not applied", async () => {
		const tracker = new MutationEffectTracker();
		tracker.markRouteEntered();
		tracker.markCoverageComplete();
		const db = instrumentMutationDatabase(
			{
				transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
					callback({ update: () => writeBuilder(async () => []) }),
			} as unknown as Database,
			tracker,
		);

		await db.transaction(async (tx) => {
			await tx
				.update({} as never)
				.set({})
				.where(undefined as never)
				.returning();
		});

		expect(tracker.outcome(1)).toEqual({ kind: "not_applied" });
		expect(tracker.isProvenNotApplied()).toBe(true);
	});

	it("parks incomplete route coverage and proves pre-route failure", () => {
		const preRoute = new MutationEffectTracker();
		expect(preRoute.isProvenNotApplied()).toBe(true);
		expect(preRoute.outcome(1)).toEqual({ kind: "not_applied" });

		const completeWithoutAttempts = new MutationEffectTracker();
		completeWithoutAttempts.markRouteEntered();
		completeWithoutAttempts.markCoverageComplete();
		expect(completeWithoutAttempts.outcome(1)).toEqual({
			kind: "not_applied",
		});
		expect(completeWithoutAttempts.isProvenNotApplied()).toBe(true);

		const incompleteWithoutAttempts = new MutationEffectTracker();
		incompleteWithoutAttempts.markRouteEntered();
		expect(incompleteWithoutAttempts.outcome(1)).toEqual({ kind: "unknown" });
		expect(incompleteWithoutAttempts.isProvenNotApplied()).toBe(false);

		const incomplete = new MutationEffectTracker();
		incomplete.markRouteEntered();
		const localRollback = incomplete.begin("postgres.transaction");
		localRollback.notApplied();
		expect(incomplete.outcome(1)).toEqual({ kind: "unknown" });
		expect(incomplete.isProvenNotApplied()).toBe(false);
	});

	it("lets an exact bulk K refine successful SQL but not erase ambiguity", () => {
		const refined = new MutationEffectTracker();
		refined.markRouteEntered();
		const successfulSql = refined.begin("postgres.transaction");
		successfulSql.committed();
		expect(refined.reconcileAuthoritativeCommittedUnits(10, 4)).toEqual({
			kind: "committed",
			units: 4,
		});

		const ambiguous = new MutationEffectTracker();
		ambiguous.markRouteEntered();
		ambiguous.begin("postgres.transaction").unknown();
		expect(ambiguous.reconcileAuthoritativeCommittedUnits(10, 4)).toEqual({
			kind: "unknown",
		});
	});

	it("parks a bulk K that contradicts exact route-owned evidence", () => {
		const lowerLevel = new MutationEffectTracker();
		lowerLevel.markRouteEntered();
		lowerLevel.begin("bulk.item").committed(3);
		expect(lowerLevel.reconcileAuthoritativeCommittedUnits(10, 2)).toEqual({
			kind: "unknown",
		});

		const authoritative = new MutationEffectTracker();
		authoritative.markRouteEntered();
		authoritative.setAuthoritativeOutcome({ kind: "committed", units: 2 });
		expect(authoritative.reconcileAuthoritativeCommittedUnits(10, 3)).toEqual({
			kind: "unknown",
		});
	});

	it("exposes only explicit route-owned evidence to successful settlement", () => {
		const inferred = new MutationEffectTracker();
		inferred.markRouteEntered();
		inferred.markCoverageComplete();
		inferred.begin("postgres.update").committed();
		expect(inferred.routeAuthoritativeOutcome(1)).toBeNull();

		const explicit = new MutationEffectTracker();
		explicit.setAuthoritativeOutcome({ kind: "not_applied" });
		expect(explicit.routeAuthoritativeOutcome(1)).toEqual({
			kind: "not_applied",
		});
	});
});
