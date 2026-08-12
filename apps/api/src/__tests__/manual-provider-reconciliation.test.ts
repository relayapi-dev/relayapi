import { describe, expect, it } from "bun:test";
import { postTargets, publishAttempts } from "@relayapi/db";
import { persistManualProviderReconciliation } from "../services/provider-reconciliation-persistence";

const providerEffects = [
	{
		name: "create_post",
		status: "outcome_unknown" as const,
		provider_id: "effect_1",
	},
];

function persistenceTransaction(options: { attemptSaved?: boolean } = {}) {
	const events: string[] = [];
	const sets = new Map<unknown, Record<string, unknown>>();
	const tx = {
		select() {
			let table: unknown;
			const chain = {
				from(value: unknown) {
					table = value;
					return chain;
				},
				where() {
					return chain;
				},
				for(mode: string) {
					expect(mode).toBe("update");
					return chain;
				},
				async limit() {
					expect(table).toBe(postTargets);
					events.push("target-lock");
					return [
						{
							id: "pt_1",
							attemptId: "pat_1",
							providerOperationId: "provider_job_1",
							providerState: "last_observed_state",
							providerEffects,
						},
					];
				},
			};
			return chain;
		},
		update(table: unknown) {
			const chain = {
				set(value: Record<string, unknown>) {
					sets.set(table, value);
					return chain;
				},
				where() {
					return chain;
				},
				async returning() {
					const kind = table === postTargets ? "target" : "attempt";
					events.push(kind);
					if (table === publishAttempts && options.attemptSaved === false) {
						return [];
					}
					return [{ id: `${kind}_1` }];
				},
			};
			return chain;
		},
	};
	return { tx, events, sets };
}

const baseInput = {
	targetId: "pt_1",
	postId: "post_1",
	organizationId: "org_1",
	publishOperationId: "pubop_1",
	observedAt: new Date("2026-07-18T15:00:00.000Z"),
};

describe("manual provider reconciliation truth", () => {
	it("projects manual success coherently to the target and exact attempt", async () => {
		const state = persistenceTransaction();
		expect(
			await persistManualProviderReconciliation(state.tx as never, {
				...baseInput,
				succeeded: true,
				providerPostId: "provider_post_1",
				providerUrl: "https://social.example/provider_post_1",
				errorCode: null,
				errorMessage: null,
			}),
		).toBe(true);

		const projection = {
			providerDisposition: "published",
			providerOperationId: "provider_job_1",
			providerState: "manually_confirmed_succeeded",
			providerEffects,
		};
		expect(state.sets.get(postTargets)).toMatchObject({
			status: "published",
			deliveryState: "succeeded",
			platformPostId: "provider_post_1",
			nextReconcileAt: null,
			...projection,
		});
		expect(state.sets.get(publishAttempts)).toMatchObject({
			state: "succeeded",
			providerPostId: "provider_post_1",
			...projection,
		});
		expect(state.events).toEqual(["target-lock", "target", "attempt"]);
	});

	it("projects manual failure without retaining an ambiguous disposition", async () => {
		const state = persistenceTransaction();
		expect(
			await persistManualProviderReconciliation(state.tx as never, {
				...baseInput,
				succeeded: false,
				providerPostId: null,
				providerUrl: null,
				errorCode: "PROVIDER_REJECTED",
				errorMessage: "Provider rejected the operation",
			}),
		).toBe(true);

		expect(state.sets.get(postTargets)).toMatchObject({
			status: "failed",
			deliveryState: "failed",
			providerDisposition: "failed",
			providerState: "manually_confirmed_failed",
			nextReconcileAt: null,
			errorCode: "PROVIDER_REJECTED",
		});
		expect(state.sets.get(publishAttempts)).toMatchObject({
			state: "failed",
			providerDisposition: "failed",
			providerState: "manually_confirmed_failed",
			error: "Provider rejected the operation",
		});
	});

	it("rolls back the target projection when the exact attempt fence is lost", async () => {
		const state = persistenceTransaction({ attemptSaved: false });
		const transactionEvents: string[] = [];
		const db = {
			async transaction<T>(work: (tx: typeof state.tx) => Promise<T>) {
				transactionEvents.push("begin");
				try {
					const result = await work(state.tx);
					transactionEvents.push("commit");
					return result;
				} catch (error) {
					transactionEvents.push("rollback");
					throw error;
				}
			},
		};

		await expect(
			db.transaction((tx) =>
				persistManualProviderReconciliation(tx as never, {
					...baseInput,
					succeeded: true,
					providerPostId: "provider_post_1",
					providerUrl: null,
					errorCode: null,
					errorMessage: null,
				}),
			),
		).rejects.toThrow("publish attempt transition was not persisted");
		expect(transactionEvents).toEqual(["begin", "rollback"]);
	});
});
