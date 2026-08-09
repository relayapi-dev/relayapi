// The contact-context refresh runs *after* the resume path has already CAS'd
// the run out of `waiting`, so the inbound message or scheduled job that woke
// it is gone. Two properties therefore have to hold, and neither is covered by
// the merge unit tests:
//
//   1. A refresh failure must not abort runLoop. An abort would leave the run
//      `active` with no scheduled job and no claimed node execution, and
//      neither reconciler can see that state (one requires a claimed node
//      execution at the current revision, the other only scans `waiting`), so
//      the run would be stranded forever and the active/waiting unique index
//      would block the contact from ever re-enrolling.
//   2. The refresh must not consume a revision. Node-execution claims are keyed
//      by (run_id, run_revision, visit_ordinal), so a bump would orphan an
//      in-flight claim and let a retried resume re-execute the node under a
//      fresh effect idempotency key.

import { describe, expect, it } from "bun:test";
import {
	automationContactControls,
	automationRuns,
	type Database,
} from "@relayapi/db";
import { runLoop } from "../services/automations/runner";

type RunState = {
	id: string;
	organizationId: string;
	automationId: string;
	contactId: string;
	status: string;
	revision: number;
	currentNodeKey: string | null;
	currentPortKey: string | null;
	conversationId: string | null;
	exitReason: string | null;
	context: Record<string, unknown>;
};

function refreshHarness() {
	const run: RunState = {
		id: "arun_1",
		organizationId: "org_1",
		automationId: "auto_1",
		contactId: "ct_1",
		status: "active",
		revision: 7,
		// A null current node makes the loop complete the run on this visit, so
		// the test observes whether the loop got past the refresh at all.
		currentNodeKey: null,
		currentPortKey: null,
		conversationId: null,
		exitReason: null,
		context: { tags: ["stale"], trigger: { kind: "comment" } },
	};
	const runUpdates: Array<Record<string, unknown>> = [];

	function updateBuilder(table: unknown) {
		return {
			set(patch: Record<string, unknown>) {
				if (table === automationRuns) runUpdates.push(patch);
				const apply = () => {
					if (table !== automationRuns) return [{ id: run.id }];
					if (patch.revision !== undefined) run.revision += 1;
					if (typeof patch.status === "string") run.status = patch.status;
					if (patch.context !== undefined) {
						run.context = patch.context as Record<string, unknown>;
					}
					if (typeof patch.exitReason === "string") {
						run.exitReason = patch.exitReason;
					}
					return [{ id: run.id }];
				};
				return {
					// Run updates are read back via .returning(); the automation
					// counter update is awaited directly.
					where: (): unknown =>
						table === automationRuns
							? { returning: async () => apply() }
							: Promise.resolve().then(apply),
				};
			},
		};
	}

	const db = {
		query: {
			automationRuns: { findFirst: async () => ({ ...run }) },
			automations: {
				findFirst: async () => ({
					id: "auto_1",
					organizationId: "org_1",
					workspaceId: null,
					channel: "instagram",
					graph: {
						schema_version: 1,
						root_node_key: null,
						nodes: [],
						edges: [],
					},
				}),
			},
		},
		select: () => ({
			from: (table: unknown) => ({
				where: () => ({
					limit: async () =>
						table === automationContactControls ? [] : [{ id: "x" }],
				}),
			}),
		}),
		update: updateBuilder,
		async transaction<T>(callback: (tx: unknown) => Promise<T>) {
			return callback({ update: updateBuilder, select: db.select });
		},
	} as unknown as Database;

	return { db, run, runUpdates };
}

describe("automation resume context refresh durability", () => {
	it("advances the run when the refresh cannot be performed", async () => {
		const { db, runUpdates } = refreshHarness();

		// No ENCRYPTION_KEY: the refresh throws before it can read the contact.
		// Before this was guarded, that exception escaped runLoop entirely.
		const result = await runLoop(db, "arun_1", {}, {
			refreshContactContext: true,
		});

		expect(result.status).toBe("completed");
		// The run still reached a terminal write rather than being abandoned.
		expect(runUpdates.some((patch) => patch.status === "completed")).toBe(true);
	});

	it("never consumes a revision to persist a refreshed snapshot", async () => {
		const { db, runUpdates } = refreshHarness();

		await runLoop(
			db,
			"arun_1",
			{ ENCRYPTION_KEY: "k".repeat(32) },
			{ refreshContactContext: true },
		);

		// Any write that carries `context` but no other run-state field is the
		// refresh snapshot; it must leave the node-execution replay fence intact.
		const snapshotWrites = runUpdates.filter(
			(patch) => patch.context !== undefined && patch.status === undefined,
		);
		for (const patch of snapshotWrites) {
			expect(patch.revision).toBeUndefined();
		}
	});
});
