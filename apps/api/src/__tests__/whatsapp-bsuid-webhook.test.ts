import { describe, expect, it } from "bun:test";
import type { Database } from "@relayapi/db";
import { encryptToken } from "../lib/crypto";
import {
	normalizeWhatsAppEvent,
	resolveWhatsAppGroupLifecycleStatus,
} from "../services/inbox-event-processor";
import {
	resolveWhatsAppOutboundBsuid,
	whatsappIdentityConversationKey,
} from "../services/whatsapp-identity";

const KEY_CONFIG = `v1=${"a".repeat(64)},identity=${"b".repeat(64)}`;

function queueMessage(payload: Record<string, unknown>) {
	return {
		type: "whatsapp_webhook" as const,
		platform: "whatsapp" as const,
		platform_account_id: "phone-number-id",
		organization_id: "org_1",
		account_id: "acc_wa",
		event_type: "messages",
		payload,
		received_at: "2026-08-10T10:00:00.000Z",
	};
}

describe("WhatsApp BSUID webhook normalization", () => {
	it("matches contacts by message BSUID before a legacy wa_id", () => {
		const [event] = normalizeWhatsAppEvent(
			queueMessage({
				messaging_product: "whatsapp",
				metadata: { phone_number_id: "phone-number-id" },
				contacts: [
					{
						profile: { name: "Wrong legacy match" },
						wa_id: "15550001111",
						user_id: "bsuid-other",
					},
					{
						profile: { name: "Correct BSUID", username: "correct.user" },
						wa_id: "15559999999",
						user_id: "bsuid-exact",
						parent_user_id: "bsuid-parent",
					},
				],
				messages: [
					{
						id: "wamid.1",
						from: "15550001111",
						from_user_id: "bsuid-exact",
						from_parent_user_id: "bsuid-parent",
						group_id: "group-1",
						timestamp: "1786356000",
						type: "interactive",
						interactive: {
							type: "nfm_reply",
							nfm_reply: {
								name: "lead_form",
								response_json: { private_answer: "yes" },
							},
						},
					},
				],
			}),
		);

		expect(event?.author?.name).toBe("Correct BSUID");
		expect(event?.author?.id).toBe("bsuid-exact");
		expect(event?.conversation_id).toBe("group-1");
		expect(event?.whatsapp_group_id).toBe("group-1");
		expect(event?.whatsapp_identity).toEqual({
			bsuid: "bsuid-exact",
			parentBsuid: "bsuid-parent",
			waId: "15550001111",
			username: "correct.user",
		});
		expect(event?.flow_response_metadata).toEqual({
			name: "lead_form",
			has_response: true,
		});
		expect(JSON.stringify(event?.flow_response_metadata)).not.toContain(
			"private_answer",
		);
	});

	it("does not persist a phone number as the display name for a BSUID sender", () => {
		const [event] = normalizeWhatsAppEvent(
			queueMessage({
				messaging_product: "whatsapp",
				metadata: { phone_number_id: "phone-number-id" },
				contacts: [
					{
						profile: {},
						wa_id: "15550002222",
						user_id: "bsuid-private",
					},
				],
				messages: [
					{
						id: "wamid.2",
						from: "15550002222",
						from_user_id: "bsuid-private",
						timestamp: "1786356000",
						type: "text",
						text: { body: "hello" },
					},
				],
			}),
		);

		expect(event?.author?.name).toBe("WhatsApp user");
		expect(event?.author?.name).not.toContain("15550002222");
	});

	it("derives stable tenant-separated conversation keys without raw BSUIDs", async () => {
		const first = await whatsappIdentityConversationKey(
			KEY_CONFIG,
			"org_1",
			"opaque-BSUID-Value",
		);
		const same = await whatsappIdentityConversationKey(
			KEY_CONFIG,
			"org_1",
			"opaque-BSUID-Value",
		);
		const otherTenant = await whatsappIdentityConversationKey(
			KEY_CONFIG,
			"org_2",
			"opaque-BSUID-Value",
		);

		expect(first).toBe(same);
		expect(first).not.toBe(otherTenant);
		expect(first).toMatch(/^bsuid_[0-9a-f]{64}$/);
		expect(first).not.toContain("opaque-BSUID-Value");
	});

	it("decrypts the exact conversation alias only at the outbound boundary", async () => {
		const aliasId = "wai_1";
		const bsuidCiphertext = await encryptToken("bsuid-outbound", KEY_CONFIG, {
			recordId: aliasId,
			field: "whatsapp_identity_bsuid",
		});
		const db = {
			select: () => ({
				from: () => ({
					where: () => ({
						orderBy: () => ({
							limit: async () => [{ id: aliasId, bsuidCiphertext }],
						}),
					}),
				}),
			}),
		} as unknown as Database;

		expect(
			await resolveWhatsAppOutboundBsuid(db, KEY_CONFIG, {
				organizationId: "org_1",
				accountId: "acc_wa",
				conversationId: "conv_1",
			}),
		).toBe("bsuid-outbound");
	});
});

describe("WhatsApp group lifecycle ordering", () => {
	it("does not revive deleting or deleted groups from stale create/suspend callbacks", () => {
		expect(
			resolveWhatsAppGroupLifecycleStatus("group_create", false, "deleting"),
		).toBe("deleting");
		expect(
			resolveWhatsAppGroupLifecycleStatus("group_suspend", false, "deleted"),
		).toBe("deleted");
		expect(
			resolveWhatsAppGroupLifecycleStatus(
				"group_suspend_cleared",
				false,
				"failed",
			),
		).toBe("failed");
	});

	it("applies successful lifecycle callbacks and preserves state on failures", () => {
		expect(
			resolveWhatsAppGroupLifecycleStatus("group_create", false, "creating"),
		).toBe("active");
		expect(
			resolveWhatsAppGroupLifecycleStatus("group_create", true, "creating"),
		).toBe("failed");
		expect(
			resolveWhatsAppGroupLifecycleStatus("group_suspend", false, "active"),
		).toBe("suspended");
		expect(
			resolveWhatsAppGroupLifecycleStatus(
				"group_suspend_cleared",
				false,
				"suspended",
			),
		).toBe("active");
		expect(
			resolveWhatsAppGroupLifecycleStatus("group_delete", true, "deleting"),
		).toBe("active");
		expect(
			resolveWhatsAppGroupLifecycleStatus("group_delete", false, "deleting"),
		).toBe("deleted");
	});
});
