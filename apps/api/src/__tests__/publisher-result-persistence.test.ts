import { describe, expect, it } from "bun:test";
import { postTargets } from "@relayapi/db";
import {
	createPublishResultPersistenceGate,
	PUBLISH_RESULT_PERSIST_CONCURRENCY,
	persistPublishTaskResult,
	providerReconcileAt,
	settleAndPersistPublishTask,
} from "../services/publisher-runner";

function sqlReferencesColumn(value: unknown, column: string): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { name?: unknown; queryChunks?: unknown[] };
	if (candidate.name === column) return true;
	return (
		candidate.queryChunks?.some((chunk) =>
			sqlReferencesColumn(chunk, column),
		) ?? false
	);
}

function sqlHasParam(value: unknown, param: string): boolean {
	if (value === param) return true;
	if (!value || typeof value !== "object") return false;
	const candidate = value as { value?: unknown; queryChunks?: unknown[] };
	if (candidate.value === param) return true;
	return (
		candidate.queryChunks?.some((chunk) => sqlHasParam(chunk, param)) ?? false
	);
}

function persistenceDb(options: {
	targetSaved?: boolean;
	attemptSaved?: boolean;
}) {
	const events: string[] = [];
	const wheres: Record<string, unknown> = {};
	const sets: Record<string, Record<string, unknown>> = {};
	let committed = false;
	let rolledBack = false;

	const tx = {
		update(table: unknown) {
			const kind = table === postTargets ? "target" : "attempt";
			const chain = {
				set(values: Record<string, unknown>) {
					sets[kind] = values;
					return chain;
				},
				where(condition: unknown) {
					wheres[kind] = condition;
					return chain;
				},
				async returning() {
					events.push(kind);
					const saved =
						kind === "target"
							? options.targetSaved !== false
							: options.attemptSaved !== false;
					return saved ? [{ id: `${kind}_1` }] : [];
				},
			};
			return chain;
		},
	};
	const db = {
		async transaction<T>(work: (transaction: typeof tx) => Promise<T>) {
			events.push("begin");
			try {
				const result = await work(tx);
				committed = true;
				events.push("commit");
				return result;
			} catch (error) {
				rolledBack = true;
				events.push("rollback");
				throw error;
			}
		},
	};
	return {
		db,
		events,
		wheres,
		sets,
		committed: () => committed,
		rolledBack: () => rolledBack,
	};
}

const successInput = {
	postId: "post_1",
	organizationId: "org_1",
	parentLeaseId: "lease_1",
	postTargetId: "pt_1",
	attemptId: "pat_1",
	publishOperationId: "pubop_1",
	requestMayHaveBeenSent: true,
	result: {
		success: true as const,
		platform_post_id: "provider_1",
		platform_url: "https://social.example/provider_1",
	},
};

describe("publisher result persistence", () => {
	it("updates target and attempt atomically under attempt and parent fences", async () => {
		const state = persistenceDb({});

		expect(
			await persistPublishTaskResult(state.db as never, successInput),
		).toBe(true);
		expect(state.events).toEqual(["begin", "target", "attempt", "commit"]);
		expect(state.sets.target).toMatchObject({
			status: "published",
			deliveryState: "succeeded",
			platformPostId: "provider_1",
		});
		expect(state.sets.attempt).toMatchObject({
			state: "succeeded",
			providerPostId: "provider_1",
		});
		for (const column of [
			"post_id",
			"organization_id",
			"publish_operation_id",
			"attempt_id",
			"delivery_state",
		]) {
			expect(sqlReferencesColumn(state.wheres.target, column), column).toBe(
				true,
			);
		}
		for (const column of ["post_target_id", "publish_operation_id", "state"]) {
			expect(sqlReferencesColumn(state.wheres.attempt, column), column).toBe(
				true,
			);
		}
		for (const condition of Object.values(state.wheres)) {
			expect(sqlHasParam(condition, "post_1")).toBe(true);
			expect(sqlHasParam(condition, "org_1")).toBe(true);
			expect(sqlHasParam(condition, "lease_1")).toBe(true);
		}
	});

	it("rolls back the target transition when the attempt fence fails", async () => {
		const state = persistenceDb({ attemptSaved: false });

		await expect(
			persistPublishTaskResult(state.db as never, successInput),
		).rejects.toThrow("Post publish execution lease was lost");
		expect(state.committed()).toBe(false);
		expect(state.rolledBack()).toBe(true);
		expect(state.events).toEqual(["begin", "target", "attempt", "rollback"]);
	});

	it("does not touch an attempt after the target fence is lost", async () => {
		const state = persistenceDb({ targetSaved: false });

		expect(
			await persistPublishTaskResult(state.db as never, successInput),
		).toBe(false);
		expect(state.events).toEqual(["begin", "target", "commit"]);
		expect(state.sets.attempt).toBeUndefined();
	});

	it("persists accepted provider jobs without projecting them as published", async () => {
		const state = persistenceDb({});
		const saved = await persistPublishTaskResult(state.db as never, {
			...successInput,
			result: {
				success: true,
				provider_outcome: {
					disposition: "accepted",
					provider_operation_id: "job_123",
					provider_state: "queued",
				},
			},
		});

		expect(saved).toBe(true);
		expect(state.sets.target).toMatchObject({
			status: "publishing",
			deliveryState: "unknown",
			platformPostId: null,
			providerOperationId: "job_123",
			providerDisposition: "accepted",
			providerState: "queued",
		});
		expect(state.sets.target?.nextReconcileAt).toBeInstanceOf(Date);
		expect(state.sets.attempt).toMatchObject({
			state: "unknown",
			providerPostId: null,
			providerOperationId: "job_123",
			providerDisposition: "accepted",
		});
	});

	it("downgrades id-less terminal success to an unknown outcome", async () => {
		const state = persistenceDb({});
		await persistPublishTaskResult(state.db as never, {
			...successInput,
			result: {
				success: true,
				provider_outcome: {
					disposition: "published",
					provider_state: "complete",
				},
			},
		});

		expect(state.sets.target).toMatchObject({
			status: "publishing",
			deliveryState: "unknown",
			platformPostId: null,
			providerDisposition: "outcome_unknown",
			errorCode: "PUBLISH_OUTCOME_UNKNOWN",
		});
		expect(state.sets.target?.nextReconcileAt).toBeInstanceOf(Date);
		expect(state.sets.attempt).toMatchObject({
			state: "unknown",
			providerDisposition: "outcome_unknown",
		});
	});
});

describe("provider reconciliation scheduling", () => {
	it("schedules ambiguous and partial outcomes instead of stranding them", () => {
		const now = new Date("2026-07-18T12:00:00.000Z");
		for (const disposition of ["outcome_unknown", "partial"] as const) {
			expect(providerReconcileAt({ disposition }, now)?.toISOString()).toBe(
				"2026-07-18T12:01:00.000Z",
			);
		}
		expect(providerReconcileAt({ disposition: "failed" }, now)).toBeNull();
	});
});

describe("publisher settle-to-persist scheduling", () => {
	it("persists a fast result before another provider task settles", async () => {
		const slow = Promise.withResolvers<void>();
		const events: string[] = [];
		const slowTask = settleAndPersistPublishTask(
			async () => {
				await slow.promise;
				events.push("slow-settled");
				return "slow";
			},
			async () => events.push("slow-persisted"),
		);
		const fastTask = settleAndPersistPublishTask(
			async () => {
				events.push("fast-settled");
				return "fast";
			},
			async () => events.push("fast-persisted"),
		);

		await fastTask;
		expect(events).toEqual(["fast-settled", "fast-persisted"]);
		slow.resolve();
		await slowTask;
		expect(events).toEqual([
			"fast-settled",
			"fast-persisted",
			"slow-settled",
			"slow-persisted",
		]);
	});

	it("bounds concurrent result transactions", async () => {
		const gate = createPublishResultPersistenceGate();
		const release = Promise.withResolvers<void>();
		let active = 0;
		let maxActive = 0;
		const jobs = Array.from({ length: 8 }, () =>
			gate(async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				await release.promise;
				active--;
			}),
		);

		await Promise.resolve();
		await Promise.resolve();
		expect(maxActive).toBe(PUBLISH_RESULT_PERSIST_CONCURRENCY);
		release.resolve();
		await Promise.all(jobs);
		expect(maxActive).toBe(PUBLISH_RESULT_PERSIST_CONCURRENCY);
	});

	it("never repeats a provider task when result persistence fails", async () => {
		let providerCalls = 0;
		await expect(
			settleAndPersistPublishTask(
				async () => {
					providerCalls++;
					return "published";
				},
				async () => {
					throw new Error("database unavailable");
				},
			),
		).rejects.toThrow("database unavailable");
		expect(providerCalls).toBe(1);
	});
});
