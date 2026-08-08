import type { MutationEffectTracker } from "./mutation-effect";

/**
 * Provider responses that conclusively reject a mutation before applying it.
 * Timeout/early-data/rate-limit responses remain ambiguous because an upstream
 * or intermediary may have accepted the request before the response was lost.
 */
export function isDefinitiveProviderMutationRejection(status: number): boolean {
	return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

/**
 * Arm authoritative request-local evidence immediately before the final
 * single-unit provider mutation. A received success proves K=1 before response
 * parsing; a terminal 4xx proves K=0; transport, transient 4xx, redirect, and
 * 5xx outcomes park.
 *
 * Use this only for the route's final customer-visible effect. A route with
 * multiple independently billable provider effects needs a route-specific
 * aggregate instead of invoking this helper more than once with conflicting
 * outcomes. `tracked_complete` routes must also ensure that every other
 * customer-visible non-Postgres effect is represented.
 */
export async function trackSingleUnitProviderMutation(
	tracker: MutationEffectTracker | undefined,
	label: string,
	operation: () => Promise<Response>,
): Promise<Response> {
	const attempt = tracker?.begin(label);
	try {
		const response = await operation();
		if (response.ok) {
			attempt?.committed();
			tracker?.setAuthoritativeOutcome({ kind: "committed", units: 1 });
		} else if (isDefinitiveProviderMutationRejection(response.status)) {
			attempt?.notApplied();
			tracker?.setAuthoritativeOutcome({ kind: "not_applied" });
		} else {
			attempt?.unknown();
			tracker?.setAuthoritativeOutcome({ kind: "unknown" });
		}
		return response;
	} catch (error) {
		attempt?.unknown();
		tracker?.setAuthoritativeOutcome({ kind: "unknown" });
		throw error;
	}
}

/**
 * Collect a fan-out of alternative provider attempts for one logical unit.
 * Any acknowledged attempt proves K=1; otherwise any ambiguity parks; only an
 * empty fan-out or exclusively definitive rejections proves K=0.
 */
export class SingleUnitProviderMutationAggregate {
	readonly #tracker: MutationEffectTracker | undefined;
	#attempted = false;
	#committed = false;
	#ambiguous = false;

	constructor(tracker: MutationEffectTracker | undefined) {
		this.#tracker = tracker;
	}

	async track(
		label: string,
		operation: () => Promise<Response>,
	): Promise<Response> {
		this.#attempted = true;
		const attempt = this.#tracker?.begin(label);
		try {
			const response = await operation();
			if (response.ok) {
				attempt?.committed();
				this.#committed = true;
				// K=1 is final for a single-unit request as soon as any alternative
				// provider effect is acknowledged. Persist the proof before response
				// parsing or later local projection work can fail.
				this.#tracker?.setAuthoritativeOutcome({
					kind: "committed",
					units: 1,
				});
			} else if (isDefinitiveProviderMutationRejection(response.status)) {
				attempt?.notApplied();
			} else {
				attempt?.unknown();
				this.#ambiguous = true;
			}
			return response;
		} catch (error) {
			attempt?.unknown();
			this.#ambiguous = true;
			throw error;
		}
	}

	/**
	 * Track a provider binding whose acknowledgement is the resolved value rather
	 * than an HTTP Response. Resolution proves K=1 before callers parse the value;
	 * rejection remains ambiguous because bindings do not expose an HTTP status.
	 */
	async trackAcknowledged<T>(
		label: string,
		operation: () => Promise<T>,
	): Promise<T> {
		this.#attempted = true;
		const attempt = this.#tracker?.begin(label);
		try {
			const value = await operation();
			attempt?.committed();
			this.#committed = true;
			this.#tracker?.setAuthoritativeOutcome({
				kind: "committed",
				units: 1,
			});
			return value;
		} catch (error) {
			attempt?.unknown();
			this.#ambiguous = true;
			throw error;
		}
	}

	/** True once execution has crossed at least one provider boundary. */
	hasAttempts(): boolean {
		return this.#attempted;
	}

	/** Record an acknowledged non-provider alternative for the same logical unit. */
	markCommitted(): void {
		this.#committed = true;
		this.#tracker?.setAuthoritativeOutcome({ kind: "committed", units: 1 });
	}

	/** Whether any alternative has already acknowledged the logical mutation. */
	hasCommittedEffect(): boolean {
		return this.#committed;
	}

	finalize(): void {
		this.#tracker?.setAuthoritativeOutcome(
			this.#committed
				? { kind: "committed", units: 1 }
				: this.#ambiguous
					? { kind: "unknown" }
					: { kind: "not_applied" },
		);
	}
}
