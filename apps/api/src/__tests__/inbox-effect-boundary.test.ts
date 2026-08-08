import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { runInboxEffectOnce } from "../services/inbox-event-processor";

function effectDb() {
	const updates: Array<Record<string, unknown>> = [];
	const db = {
		insert: () => ({
			values: () => ({
				onConflictDoUpdate: () => ({
					returning: async () => [{ id: "ief_1", leaseToken: 1 }],
				}),
			}),
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => {
				updates.push(values);
				return {
					where: () => ({
						returning: async () => [{ id: "ief_1" }],
					}),
				};
			},
		}),
	};
	return { db, updates };
}

const event = {
	organization_id: "org_1",
	account_id: "acc_1",
	platform_event_id: "event_1",
};
const replayPayload = {
	type: "telegram_webhook",
	platform: "telegram",
	platform_account_id: "tg_1",
	organization_id: "org_1",
	account_id: "acc_1",
	event_type: "message",
	payload: {},
	received_at: "2026-07-13T00:00:00.000Z",
};

describe("inbox effect boundary semantics", () => {
	it("replays persisted payloads directly instead of copying them into Queue", () => {
		const source = readFileSync(
			new URL("../services/inbox-effect-reconciler.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("await processInboxEvent(entry.body, env, db)");
		expect(source).not.toContain("env.INBOX_QUEUE.sendBatch");
	});

	it("retries customer-webhook outbox failures without marking an external outcome unknown", async () => {
		const { db, updates } = effectDb();
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				runInboxEffectOnce(
					db as never,
					event,
					"customer_webhook",
					replayPayload as never,
					async () => {
						throw new Error("database unavailable");
					},
				),
			).rejects.toThrow("database unavailable");
		} finally {
			errorSpy.mockRestore();
		}

		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({
			status: "pending",
			effectStartedAt: null,
			leaseExpiresAt: null,
			error: "database unavailable",
		});
	});

	it("keeps ambiguous automation failures terminally unknown", async () => {
		const { db, updates } = effectDb();
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				runInboxEffectOnce(
					db as never,
					event,
					"automation",
					replayPayload as never,
					async () => {
						throw new Error("provider outcome ambiguous");
					},
				),
			).rejects.toThrow("provider outcome ambiguous");
		} finally {
			errorSpy.mockRestore();
		}

		expect(updates).toHaveLength(2);
		expect(updates[0]?.effectStartedAt).toBeInstanceOf(Date);
		expect(updates[1]).toMatchObject({
			status: "unknown",
			leaseExpiresAt: null,
		});
	});
});
