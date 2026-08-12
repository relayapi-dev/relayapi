import { describe, expect, it } from "bun:test";
import {
	posts,
	postTargets,
	publishAttempts,
	publishOutbox,
	threadExecutions,
} from "@relayapi/db";
import { persistTerminalProviderReconciliation } from "../services/provider-outcome-reconciler";

function reconciliationDb(options: {
	attemptSaved?: boolean;
	outboxFails?: boolean;
}) {
	const events: string[] = [];
	let insertedOutbox: Record<string, unknown> | undefined;
	const tx = {
		update(table: unknown) {
			const kind =
				table === postTargets
					? "target"
					: table === publishAttempts
						? "attempt"
						: "thread";
			const chain = {
				set() {
					return chain;
				},
				where() {
					return chain;
				},
				async returning() {
					events.push(kind);
					if (kind === "attempt" && options.attemptSaved === false) return [];
					return [{ id: `${kind}_1` }];
				},
			};
			return chain;
		},
		select() {
			let selectedTable: unknown;
			const chain = {
				from(table: unknown) {
					selectedTable = table;
					return chain;
				},
				where() {
					return chain;
				},
				for(mode: string) {
					expect(mode).toBe("update");
					if (selectedTable === posts) events.push("post-lock");
					else if (selectedTable === threadExecutions)
						events.push("thread-lock");
					else throw new Error("unexpected locked table");
					return chain;
				},
				async limit() {
					if (selectedTable === posts || selectedTable === threadExecutions)
						return [{ id: "scope_1" }];
					events.push("remaining-targets");
					return [];
				},
			};
			return chain;
		},
		insert(table: unknown) {
			expect(table).toBe(publishOutbox);
			const chain = {
				values(value: Record<string, unknown>) {
					insertedOutbox = value;
					return chain;
				},
				async onConflictDoNothing() {
					events.push("outbox");
					if (options.outboxFails) throw new Error("outbox insert failed");
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
				events.push("commit");
				return result;
			} catch (error) {
				events.push("rollback");
				throw error;
			}
		},
	};
	return { db, events, insertedOutbox: () => insertedOutbox };
}

const terminalInput = {
	candidate: {
		targetId: "pt_1",
		postId: "post_1",
		organizationId: "org_1",
		attemptId: "pat_1",
		publishOperationId: "pubop_1",
		threadGroupId: null,
		threadPosition: null,
	},
	attemptNumber: 2,
	observedAt: new Date("2026-07-18T12:00:00.000Z"),
	platformPostId: "provider_1",
	platformUrl: "https://social.example/provider_1",
	providerFields: {
		providerDisposition: "published" as const,
		providerOperationId: "job_1",
		providerState: "complete",
		providerEffects: null,
	},
	result: { success: true },
};

describe("terminal provider reconciliation durability", () => {
	it("locks the organization-owned parent post before any target mutation", async () => {
		const state = reconciliationDb({});
		await persistTerminalProviderReconciliation(
			state.db as never,
			terminalInput,
		);

		expect(state.events.slice(0, 3)).toEqual(["begin", "post-lock", "target"]);
	});

	it("commits target, attempt, and continuation outbox in one transaction", async () => {
		const state = reconciliationDb({});
		const result = await persistTerminalProviderReconciliation(
			state.db as never,
			terminalInput,
		);

		expect(result).toEqual({ saved: true, continuationQueued: true });
		expect(state.events).toEqual([
			"begin",
			"post-lock",
			"target",
			"attempt",
			"remaining-targets",
			"outbox",
			"commit",
		]);
		expect(state.insertedOutbox()).toMatchObject({
			organizationId: "org_1",
			postId: "post_1",
			kind: "publish",
		});
	});

	it("commits the thread transition and its continuation outbox in the same transaction", async () => {
		const state = reconciliationDb({});
		const result = await persistTerminalProviderReconciliation(
			state.db as never,
			{
				...terminalInput,
				candidate: {
					...terminalInput.candidate,
					threadGroupId: "thread_1",
					threadPosition: 3,
				},
			},
		);

		expect(result).toEqual({ saved: true, continuationQueued: true });
		expect(state.events).toEqual([
			"begin",
			"thread-lock",
			"post-lock",
			"target",
			"attempt",
			"remaining-targets",
			"thread",
			"outbox",
			"commit",
		]);
		expect(state.insertedOutbox()).toMatchObject({
			organizationId: "org_1",
			kind: "publish_thread",
			payload: {
				thread_group_id: "thread_1",
				position: 3,
			},
		});
	});

	it("rolls back terminal state when the attempt fence is lost", async () => {
		const state = reconciliationDb({ attemptSaved: false });
		await expect(
			persistTerminalProviderReconciliation(state.db as never, terminalInput),
		).rejects.toThrow("publish attempt transition was not persisted");
		expect(state.events).toEqual([
			"begin",
			"post-lock",
			"target",
			"attempt",
			"rollback",
		]);
	});

	it("rolls back terminal state when the continuation outbox cannot persist", async () => {
		const state = reconciliationDb({ outboxFails: true });
		await expect(
			persistTerminalProviderReconciliation(state.db as never, terminalInput),
		).rejects.toThrow("outbox insert failed");
		expect(state.events.at(-1)).toBe("rollback");
		expect(state.events).not.toContain("commit");
	});
});
