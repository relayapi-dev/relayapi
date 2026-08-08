import type { Database } from "@relayapi/db";

/**
 * Request-local evidence for the customer-visible mutation whose usage was
 * reserved by usageTrackingMiddleware. Evidence is monotonic: an attempt
 * starts ambiguous and can be resolved exactly once.
 */
export type MutationEffectOutcome =
	| { kind: "no_evidence" }
	| { kind: "not_applied" }
	| { kind: "committed"; units: number }
	| { kind: "unknown" };

type AttemptState =
	| { kind: "pending" }
	| { kind: "not_applied" }
	| { kind: "committed"; units: number | null }
	| { kind: "unknown" };

export interface MutationEffectAttempt {
	committed(units?: number | null): void;
	notApplied(): void;
	unknown(): void;
}

function assertCommittedUnits(units: number | null): void {
	if (units !== null && (!Number.isSafeInteger(units) || units < 0)) {
		throw new Error(
			"Committed mutation-effect units must be a nonnegative safe integer",
		);
	}
}

export class MutationEffectTracker {
	readonly #attempts = new Map<number, AttemptState>();
	#nextAttempt = 0;
	#routeEntered = false;
	#coverageComplete = false;
	#authoritative: Exclude<
		MutationEffectOutcome,
		{ kind: "no_evidence" }
	> | null = null;

	begin(_label: string): MutationEffectAttempt {
		const id = ++this.#nextAttempt;
		this.#attempts.set(id, { kind: "pending" });
		let resolved = false;
		const resolve = (state: AttemptState) => {
			if (resolved) return;
			resolved = true;
			this.#attempts.set(id, state);
		};
		return {
			committed: (units = null) => {
				assertCommittedUnits(units);
				// Exact K=0 is proof that this attempt did not apply. Keeping it as a
				// committed state would make the single-unit dominance rule inflate K=0
				// into K=1.
				resolve(
					units === 0 ? { kind: "not_applied" } : { kind: "committed", units },
				);
			},
			notApplied: () => resolve({ kind: "not_applied" }),
			unknown: () => resolve({ kind: "unknown" }),
		};
	}

	/** Mark the exact point at which customer mutation code can begin. */
	markRouteEntered(): void {
		this.#routeEntered = true;
	}

	/**
	 * Declare that every customer-visible effect for this route is represented
	 * by the collected attempts. Omitted registration deliberately parks 5xx
	 * outcomes instead of treating unrelated SQL as complete effect evidence.
	 */
	markCoverageComplete(): void {
		this.#coverageComplete = true;
	}

	/**
	 * Use only when the route owns complete outcome evidence (for example a
	 * bulk transaction that returns its exact committed K). This deliberately
	 * supersedes lower-level SQL attempts from the same operation.
	 */
	setAuthoritativeOutcome(
		outcome:
			| { kind: "not_applied" }
			| { kind: "committed"; units: number }
			| { kind: "unknown" },
	): void {
		if (outcome.kind === "committed") assertCommittedUnits(outcome.units);
		if (this.#authoritative) {
			const same =
				this.#authoritative.kind === outcome.kind &&
				(this.#authoritative.kind !== "committed" ||
					(outcome.kind === "committed" &&
						this.#authoritative.units === outcome.units));
			if (!same) {
				throw new Error(
					"Authoritative mutation-effect evidence cannot regress",
				);
			}
			return;
		}
		this.#authoritative = outcome;
	}

	/** Return only explicit route-owned evidence, without coverage inference. */
	routeAuthoritativeOutcome(
		reservedUnits: number,
	): Exclude<MutationEffectOutcome, { kind: "no_evidence" }> | null {
		if (!Number.isSafeInteger(reservedUnits) || reservedUnits <= 0) {
			throw new Error(
				"Reserved mutation-effect units must be a positive safe integer",
			);
		}
		if (!this.#authoritative) return null;
		return this.#authoritative.kind === "committed" &&
			this.#authoritative.units > reservedUnits
			? { kind: "unknown" }
			: this.#authoritative;
	}

	/**
	 * Reconcile an exact route-owned bulk K with lower-level evidence. A response
	 * count may supply the precision that successful SQL attempts lack, but it
	 * must never erase an unresolved attempt or contradict an already exact
	 * effect count. Incomplete route coverage is permitted here because the
	 * caller is explicitly supplying the complete route-level outcome.
	 */
	reconcileAuthoritativeCommittedUnits(
		reservedUnits: number,
		committedUnits: number,
	): Exclude<MutationEffectOutcome, { kind: "no_evidence" }> {
		if (!Number.isSafeInteger(reservedUnits) || reservedUnits <= 0) {
			throw new Error(
				"Reserved mutation-effect units must be a positive safe integer",
			);
		}
		assertCommittedUnits(committedUnits);
		if (committedUnits > reservedUnits) return { kind: "unknown" };

		if (this.#authoritative) {
			if (this.#authoritative.kind === "unknown") return { kind: "unknown" };
			if (this.#authoritative.kind === "not_applied") {
				return committedUnits === 0
					? { kind: "not_applied" }
					: { kind: "unknown" };
			}
			return this.#authoritative.units === committedUnits
				? this.#authoritative
				: { kind: "unknown" };
		}

		if (!this.#routeEntered) {
			return committedUnits === 0
				? { kind: "not_applied" }
				: { kind: "unknown" };
		}

		let exactCommittedUnits = 0;
		for (const state of this.#attempts.values()) {
			if (state.kind === "pending" || state.kind === "unknown") {
				return { kind: "unknown" };
			}
			if (state.kind !== "committed" || state.units === null) continue;
			exactCommittedUnits += state.units;
			if (
				!Number.isSafeInteger(exactCommittedUnits) ||
				exactCommittedUnits > committedUnits
			) {
				return { kind: "unknown" };
			}
		}

		return committedUnits > 0
			? { kind: "committed", units: committedUnits }
			: { kind: "not_applied" };
	}

	/** Resolve all collected evidence against the immutable reservation N. */
	outcome(reservedUnits: number): MutationEffectOutcome {
		if (!Number.isSafeInteger(reservedUnits) || reservedUnits <= 0) {
			throw new Error(
				"Reserved mutation-effect units must be a positive safe integer",
			);
		}
		const authoritative = this.routeAuthoritativeOutcome(reservedUnits);
		if (authoritative) return authoritative;
		if (!this.#routeEntered) return { kind: "not_applied" };
		if (!this.#coverageComplete) return { kind: "unknown" };
		if (this.#attempts.size === 0) return { kind: "not_applied" };

		let knownCommitted = 0;
		let hasCommittedEffect = false;
		let hasUnknownCommittedUnits = false;
		let hasAmbiguousEffect = false;
		for (const state of this.#attempts.values()) {
			if (state.kind === "pending" || state.kind === "unknown") {
				hasAmbiguousEffect = true;
				continue;
			}
			if (state.kind !== "committed") continue;
			hasCommittedEffect = true;
			if (state.units === null) {
				hasUnknownCommittedUnits = true;
				continue;
			}
			knownCommitted += state.units;
			if (
				!Number.isSafeInteger(knownCommitted) ||
				knownCommitted > reservedUnits
			) {
				return { kind: "unknown" };
			}
		}
		// A single-unit reservation is already exact once any customer-visible
		// sub-effect is proven committed. A later ambiguous sub-effect cannot make
		// K exceed one, so it must not regress that proof.
		if (reservedUnits === 1 && hasCommittedEffect) {
			return { kind: "committed", units: 1 };
		}
		if (hasAmbiguousEffect) return { kind: "unknown" };
		if (hasUnknownCommittedUnits) {
			// For a single-unit mutation, proof that its transaction committed is
			// also exact K=1. Bulk mutations require route-owned K evidence.
			return reservedUnits === 1
				? { kind: "committed", units: 1 }
				: { kind: "unknown" };
		}
		return knownCommitted > 0
			? { kind: "committed", units: knownCommitted }
			: { kind: "not_applied" };
	}

	/** Idempotency may release its receipt only when every attempt rolled back. */
	isProvenNotApplied(): boolean {
		if (!this.#routeEntered) return true;
		if (this.#authoritative) return this.#authoritative.kind === "not_applied";
		if (!this.#coverageComplete) return false;
		return [...this.#attempts.values()].every(
			(state) => state.kind === "not_applied",
		);
	}
}

type TransactionScope = {
	attempt: MutationEffectAttempt | null;
	result: "none" | "proven_zero" | "may_have_effect" | "rejected";
	noteWrite(): void;
	noteFulfilled(value: unknown, returnsRows: boolean): void;
	noteRejected(): void;
	commit(): void;
};

function isProvenZeroRowWrite(value: unknown, returnsRows: boolean): boolean {
	// PostgreSQL drivers commonly represent successful non-RETURNING writes as
	// an empty array too. An empty result proves K=0 only when the route actually
	// requested affected rows with RETURNING.
	return returnsRows && Array.isArray(value) && value.length === 0;
}

function createTransactionScope(
	tracker: MutationEffectTracker,
	label: string,
): TransactionScope {
	return {
		attempt: null,
		result: "none",
		noteWrite() {
			this.attempt ??= tracker.begin(label);
		},
		noteFulfilled(value, returnsRows) {
			if (this.result === "rejected" || this.result === "may_have_effect")
				return;
			this.result = isProvenZeroRowWrite(value, returnsRows)
				? "proven_zero"
				: "may_have_effect";
		},
		noteRejected() {
			this.result = "rejected";
		},
		commit() {
			if (!this.attempt) return;
			if (this.result === "rejected") this.attempt.unknown();
			else if (this.result === "proven_zero") this.attempt.notApplied();
			else this.attempt.committed();
		},
	};
}

function wrapWriteBuilder<T extends object>(
	builder: T,
	start: () => MutationEffectAttempt | null,
	observer?: {
		fulfilled(value: unknown, returnsRows: boolean): void;
		rejected(): void;
	},
	initiallyReturnsRows = false,
): T {
	let attempt: MutationEffectAttempt | null = null;
	let returnsRows = initiallyReturnsRows;
	let proxy: T;
	const ensureAttempt = () => {
		attempt ??= start();
		return attempt;
	};
	proxy = new Proxy(builder, {
		get(target, property, receiver) {
			if (property === "then") {
				const originalThen = Reflect.get(target, property, target) as
					| ((
							fulfilled?: (value: unknown) => unknown,
							rejected?: (reason: unknown) => unknown,
					  ) => unknown)
					| undefined;
				if (!originalThen) return undefined;
				return (
					fulfilled?: (value: unknown) => unknown,
					rejected?: (reason: unknown) => unknown,
				) => {
					const current = ensureAttempt();
					return originalThen.call(
						target,
						(value: unknown) => {
							observer?.fulfilled(value, returnsRows);
							if (!observer) {
								if (isProvenZeroRowWrite(value, returnsRows)) {
									current?.notApplied();
								} else {
									current?.committed();
								}
							}
							return fulfilled ? fulfilled(value) : value;
						},
						(reason: unknown) => {
							// An autocommit statement can reach PostgreSQL and commit before
							// its acknowledgement is lost. Rejection alone is ambiguous.
							observer?.rejected();
							if (!observer) current?.unknown();
							if (rejected) return rejected(reason);
							throw reason;
						},
					);
				};
			}
			if (property === "catch") {
				return (rejected?: (reason: unknown) => unknown) =>
					Promise.resolve(proxy).catch(rejected);
			}
			if (property === "finally") {
				return (settled?: () => void) =>
					Promise.resolve(proxy).finally(settled);
			}
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (property === "returning") returnsRows = true;
				const result = Reflect.apply(value, target, args);
				if (result === target) return proxy;
				return result && typeof result === "object"
					? wrapWriteBuilder(result, ensureAttempt, observer, returnsRows)
					: result;
			};
		},
	});
	return proxy;
}

function instrumentDatabaseObject<T extends object>(
	db: T,
	tracker: MutationEffectTracker,
	scope?: TransactionScope,
): T {
	return new Proxy(db, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;

			if (property === "transaction") {
				return async (
					callback: (transaction: unknown) => Promise<unknown>,
					...args: unknown[]
				) => {
					const transactionScope = createTransactionScope(
						tracker,
						"postgres.transaction",
					);
					let callbackRejected = false;
					try {
						const result = await Reflect.apply(value, target, [
							async (transaction: object) => {
								try {
									return await callback(
										instrumentDatabaseObject(
											transaction,
											tracker,
											transactionScope,
										),
									);
								} catch (error) {
									callbackRejected = true;
									throw error;
								}
							},
							...args,
						]);
						transactionScope.commit();
						return result;
					} catch (error) {
						if (callbackRejected) transactionScope.attempt?.notApplied();
						else transactionScope.attempt?.unknown();
						throw error;
					}
				};
			}

			if (
				property === "insert" ||
				property === "update" ||
				property === "delete"
			) {
				return (...args: unknown[]) => {
					const builder = Reflect.apply(value, target, args) as object;
					return wrapWriteBuilder(
						builder,
						() => {
							if (scope) {
								scope.noteWrite();
								return null;
							}
							return tracker.begin(`postgres.${String(property)}`);
						},
						scope
							? {
									fulfilled: (result, returnsRows) =>
										scope.noteFulfilled(result, returnsRows),
									rejected: () => scope.noteRejected(),
								}
							: undefined,
					);
				};
			}

			return value.bind(target);
		},
	});
}

/** Instrument route-owned PostgreSQL writes without changing Drizzle's type. */
export function instrumentMutationDatabase(
	db: Database,
	tracker: MutationEffectTracker,
): Database {
	return instrumentDatabaseObject(db, tracker);
}

/**
 * Wrap an effect whose success is committed but whose rejected promise may
 * have lost its acknowledgement. Use authoritative evidence separately when
 * the provider or transaction protocol proves a terminal outcome.
 */
export async function trackAtomicMutation<T>(
	tracker: MutationEffectTracker,
	label: string,
	operation: () => Promise<T>,
	committedUnits: number | null = null,
): Promise<T> {
	const attempt = tracker.begin(label);
	try {
		const value = await operation();
		attempt.committed(committedUnits);
		return value;
	} catch (error) {
		attempt.unknown();
		throw error;
	}
}

/** Queue/provider errors are ambiguous unless the caller can prove rejection. */
export async function trackAmbiguousMutation<T>(
	tracker: MutationEffectTracker,
	label: string,
	operation: () => Promise<T>,
	committedUnits: number | null = null,
): Promise<T> {
	const attempt = tracker.begin(label);
	try {
		const value = await operation();
		attempt.committed(committedUnits);
		return value;
	} catch (error) {
		attempt.unknown();
		throw error;
	}
}

/**
 * Wrap the complete customer-visible effect when an acknowledgement proves
 * commit, while any rejected acknowledgement remains unknown.
 */
export async function trackAuthoritativeAmbiguousMutation<T>(
	tracker: MutationEffectTracker,
	operation: () => Promise<T>,
	committedUnits: number,
): Promise<T> {
	try {
		const value = await operation();
		tracker.setAuthoritativeOutcome({
			kind: "committed",
			units: committedUnits,
		});
		return value;
	} catch (error) {
		tracker.setAuthoritativeOutcome({ kind: "unknown" });
		throw error;
	}
}
