import { describe, expect, it } from "bun:test";
import { MutationEffectTracker } from "../lib/mutation-effect";
import {
	isDefinitiveProviderMutationRejection,
	SingleUnitProviderMutationAggregate,
	trackSingleUnitProviderMutation,
} from "../lib/mutation-provider-boundary";

function completeTracker() {
	const tracker = new MutationEffectTracker();
	tracker.markRouteEntered();
	tracker.markCoverageComplete();
	return tracker;
}

describe("single-unit provider mutation evidence", () => {
	it("classifies only terminal provider 4xx as definitive rejection", () => {
		expect(isDefinitiveProviderMutationRejection(400)).toBe(true);
		expect(isDefinitiveProviderMutationRejection(409)).toBe(true);
		expect(isDefinitiveProviderMutationRejection(408)).toBe(false);
		expect(isDefinitiveProviderMutationRejection(425)).toBe(false);
		expect(isDefinitiveProviderMutationRejection(429)).toBe(false);
		expect(isDefinitiveProviderMutationRejection(500)).toBe(false);
	});

	it("records provider success before response parsing", async () => {
		const tracker = completeTracker();
		const response = await trackSingleUnitProviderMutation(
			tracker,
			"provider.create",
			async () => new Response("not-json", { status: 201 }),
		);
		await expect(response.json()).rejects.toBeDefined();
		expect(tracker.outcome(1)).toEqual({ kind: "committed", units: 1 });
		expect(tracker.routeAuthoritativeOutcome(1)).toEqual({
			kind: "committed",
			units: 1,
		});
	});

	it("releases terminal rejection and parks transient or transport ambiguity", async () => {
		const rejected = completeTracker();
		await trackSingleUnitProviderMutation(
			rejected,
			"provider.reject",
			async () => new Response(null, { status: 422 }),
		);
		expect(rejected.outcome(1)).toEqual({ kind: "not_applied" });

		const transient = completeTracker();
		await trackSingleUnitProviderMutation(
			transient,
			"provider.transient",
			async () => new Response(null, { status: 503 }),
		);
		expect(transient.outcome(1)).toEqual({ kind: "unknown" });

		const transport = completeTracker();
		await expect(
			trackSingleUnitProviderMutation(
				transport,
				"provider.transport",
				async () => {
					throw new Error("connection lost");
				},
			),
		).rejects.toThrow("connection lost");
		expect(transport.outcome(1)).toEqual({ kind: "unknown" });
	});

	it("rejects a second provider boundary that contradicts final evidence", async () => {
		const tracker = completeTracker();
		await trackSingleUnitProviderMutation(
			tracker,
			"provider.final",
			async () => new Response(null, { status: 204 }),
		);
		await expect(
			trackSingleUnitProviderMutation(
				tracker,
				"provider.illegal-second-final",
				async () => new Response(null, { status: 500 }),
			),
		).rejects.toThrow("cannot regress");
		expect(tracker.outcome(1)).toEqual({ kind: "committed", units: 1 });
	});
});

describe("single-unit provider fan-out evidence", () => {
	it("prefers one success over other rejected or ambiguous candidates", async () => {
		const tracker = completeTracker();
		const aggregate = new SingleUnitProviderMutationAggregate(tracker);
		await Promise.allSettled([
			aggregate.track(
				"provider.reject",
				async () => new Response(null, { status: 404 }),
			),
			aggregate.track("provider.ambiguous", async () => {
				throw new Error("lost response");
			}),
			aggregate.track(
				"provider.success",
				async () => new Response(null, { status: 204 }),
			),
		]);
		aggregate.finalize();
		expect(tracker.outcome(1)).toEqual({ kind: "committed", units: 1 });
	});

	it("records fan-out success before finalization or later projection work", async () => {
		const tracker = completeTracker();
		const aggregate = new SingleUnitProviderMutationAggregate(tracker);
		await aggregate.track(
			"provider.success",
			async () => new Response(null, { status: 204 }),
		);

		expect(aggregate.hasCommittedEffect()).toBe(true);
		expect(tracker.routeAuthoritativeOutcome(1)).toEqual({
			kind: "committed",
			units: 1,
		});
	});

	it("records a resolved provider binding before callers validate its value", async () => {
		const tracker = completeTracker();
		const aggregate = new SingleUnitProviderMutationAggregate(tracker);
		const value = await aggregate.trackAcknowledged(
			"provider.binding",
			async () => ({ response: "not-json" }),
		);

		expect(() => JSON.parse(value.response)).toThrow();
		expect(aggregate.hasAttempts()).toBe(true);
		expect(tracker.routeAuthoritativeOutcome(1)).toEqual({
			kind: "committed",
			units: 1,
		});

		const ambiguousTracker = completeTracker();
		const ambiguous = new SingleUnitProviderMutationAggregate(ambiguousTracker);
		await expect(
			ambiguous.trackAcknowledged("provider.binding", async () => {
				throw new Error("binding rejected");
			}),
		).rejects.toThrow("binding rejected");
		ambiguous.finalize();
		expect(ambiguousTracker.outcome(1)).toEqual({ kind: "unknown" });
	});

	it("accepts an acknowledged local alternative as K=1", () => {
		const tracker = completeTracker();
		const aggregate = new SingleUnitProviderMutationAggregate(tracker);
		aggregate.markCommitted();
		aggregate.finalize();
		expect(tracker.outcome(1)).toEqual({ kind: "committed", units: 1 });
	});

	it("distinguishes all-rejected and ambiguous fan-outs", async () => {
		const rejectedTracker = completeTracker();
		const rejected = new SingleUnitProviderMutationAggregate(rejectedTracker);
		await rejected.track(
			"provider.reject",
			async () => new Response(null, { status: 403 }),
		);
		rejected.finalize();
		expect(rejectedTracker.outcome(1)).toEqual({ kind: "not_applied" });

		const ambiguousTracker = completeTracker();
		const ambiguous = new SingleUnitProviderMutationAggregate(ambiguousTracker);
		await ambiguous.track(
			"provider.ambiguous",
			async () => new Response(null, { status: 503 }),
		);
		ambiguous.finalize();
		expect(ambiguousTracker.outcome(1)).toEqual({ kind: "unknown" });
	});
});
