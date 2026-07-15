import { describe, expect, it } from "bun:test";
import type { createDb } from "@relayapi/db";
import type { InboxQueueMessage } from "../routes/platform-webhooks";
import { processInboxEvent } from "../services/inbox-event-processor";
import type { Env } from "../types";

function inactiveAccountDb() {
	let selects = 0;
	const db = {
		select: () => {
			selects += 1;
			return {
				from: () => ({
					where: () => ({ limit: async () => [] }),
				}),
			};
		},
		update: () => {
			throw new Error("inactive account must not update inbox state");
		},
		insert: () => {
			throw new Error("inactive account must not create inbox state");
		},
	};
	return {
		db: db as unknown as ReturnType<typeof createDb>,
		selects: () => selects,
	};
}

describe("inbox account lifecycle fence", () => {
	it("drops normalized events after their account is no longer active", async () => {
		const tracked = inactiveAccountDb();
		const message = {
			type: "instagram_webhook",
			platform: "instagram",
			platform_account_id: "ig_business",
			organization_id: "org_deleted",
			account_id: "acc_disconnecting",
			event_type: "messages",
			payload: {
				sender: { id: "ig_sender" },
				recipient: { id: "ig_business" },
				timestamp: Date.now(),
				message: { mid: "mid_1", text: "late delivery" },
			},
			received_at: new Date().toISOString(),
		} as InboxQueueMessage;

		await processInboxEvent(message, {} as Env, tracked.db);

		expect(tracked.selects()).toBe(1);
	});

	it("drops WhatsApp status effects after their account is no longer active", async () => {
		const tracked = inactiveAccountDb();
		const message = {
			type: "whatsapp_webhook",
			platform: "whatsapp",
			platform_account_id: "wa_business",
			organization_id: "org_deleted",
			account_id: "acc_disconnecting",
			event_type: "statuses",
			payload: {
				statuses: [
					{
						id: "wamid.1",
						status: "delivered",
						timestamp: "1",
						recipient_id: "15555550123",
					},
				],
			},
			received_at: new Date().toISOString(),
		} as InboxQueueMessage;

		await processInboxEvent(message, {} as Env, tracked.db);

		expect(tracked.selects()).toBe(1);
	});
});
