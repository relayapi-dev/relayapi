import { describe, expect, it } from "bun:test";
import { dispatchAutomationMessage } from "../services/automations/platforms";
import type {
	AutomationExternalEffectDescriptor,
	RunContext,
} from "../services/automations/types";
import type { SendMessageRequest } from "../services/message-sender";

describe("automation component effect accounting", () => {
	it("creates one external effect boundary per actual message block", async () => {
		const descriptors: AutomationExternalEffectDescriptor[] = [];
		const requests: SendMessageRequest[] = [];
		const executeExternalEffect: NonNullable<
			RunContext["executeExternalEffect"]
		> = async (descriptor, operation) => {
			descriptors.push(descriptor);
			const outcome = await operation(`provider:${descriptor.effectKey}`);
			if (outcome.outcome === "failed") throw new Error(outcome.error);
			return outcome.value;
		};

		const result = await dispatchAutomationMessage({
			channel: "telegram",
			socialAccountId: "acc_1",
			recipient: {
				contactId: "ct_1",
				platformContactId: "chat_1",
			},
			blocks: [
				{ id: "b1", type: "text", text: "first" },
				{ id: "pause", type: "delay", seconds: 0 },
				{ id: "b2", type: "text", text: "second" },
			],
			credentials: {
				accessToken: "token",
				platformAccountId: "page_1",
			},
			executeExternalEffect,
			sendTransport: async (request) => {
				requests.push(request);
				return {
					success: true,
					messageId: `message_${requests.length}`,
				};
			},
		});

		expect(descriptors).toEqual([
			{ effectKey: "message-block:b1", kind: "message_block" },
			{ effectKey: "message-block:b2", kind: "message_block" },
		]);
		expect(requests.map((request) => request.idempotencyKey)).toEqual([
			"provider:message-block:b1",
			"provider:message-block:b2",
		]);
		expect(result.errors).toEqual([]);
		expect(result.sent).toEqual([
			{ blockId: "b1", providerMessageId: "message_1" },
			{ blockId: "pause", skipped: true, reason: "delay_block" },
			{ blockId: "b2", providerMessageId: "message_2" },
		]);
	});
});
