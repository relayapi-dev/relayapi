import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { decryptToken, encryptionKeyId, encryptToken } from "../lib/crypto";
import {
	rotateSocialProjectionRequestPayload,
	rotateWhatsAppGroupInviteLink,
	rotateWhatsAppIdentityAliasValues,
} from "../services/encryption-rotation";
import {
	decryptSocialProjectionPayload,
	encryptSocialProjectionPayload,
} from "../services/social-mutation-projection";

const OLD_KEY = `old=${"1a".repeat(32)}`;
const KEY_RING = `current=${"2b".repeat(32)},old=${"1a".repeat(32)}`;

describe("social and WhatsApp encryption rotation", () => {
	it("rotates target-bound social projection content", async () => {
		const identity = {
			organizationId: "org_1",
			targetType: "inbox_message" as const,
			targetId: "msg_1",
			kind: "message_edit" as const,
		};
		const oldCiphertext = await encryptSocialProjectionPayload(
			OLD_KEY,
			identity,
			{ text: "private edit" },
		);
		const requestPayload = {
			conversation_id: "conv_1",
			projection_payload_ciphertext: oldCiphertext,
		};
		const rotated = await rotateSocialProjectionRequestPayload(KEY_RING, {
			...identity,
			requestPayload,
		});

		expect(rotated).not.toBeNull();
		expect(
			encryptionKeyId(String(rotated?.projection_payload_ciphertext)),
		).toBe("current");
		expect(rotated?.conversation_id).toBe("conv_1");
		expect(
			await decryptSocialProjectionPayload(
				KEY_RING,
				identity,
				String(rotated?.projection_payload_ciphertext),
			),
		).toEqual({ text: "private edit" });
	});

	it("rotates invite links and every optional identity alias with exact AAD", async () => {
		const groupCiphertext = await encryptToken(
			"https://chat.whatsapp.test/invite",
			OLD_KEY,
			{ recordId: "wg_1", field: "whatsapp_group_invite_link" },
		);
		const rotatedGroup = await rotateWhatsAppGroupInviteLink(KEY_RING, {
			id: "wg_1",
			inviteLinkCiphertext: groupCiphertext,
		});
		expect(encryptionKeyId(String(rotatedGroup))).toBe("current");
		expect(
			await decryptToken(String(rotatedGroup), KEY_RING, {
				recordId: "wg_1",
				field: "whatsapp_group_invite_link",
			}),
		).toContain("/invite");

		const aliasId = "wai_1";
		const encrypted = async (value: string, field: string) =>
			encryptToken(value, OLD_KEY, { recordId: aliasId, field });
		const rotatedAlias = await rotateWhatsAppIdentityAliasValues(KEY_RING, {
			id: aliasId,
			bsuidCiphertext: await encrypted("bsuid", "whatsapp_identity_bsuid"),
			parentBsuidCiphertext: await encrypted(
				"parent",
				"whatsapp_identity_parent_bsuid",
			),
			waIdCiphertext: await encrypted("wa-id", "whatsapp_identity_wa_id"),
			usernameCiphertext: await encrypted(
				"username",
				"whatsapp_identity_username",
			),
		});
		expect(rotatedAlias).not.toBeNull();
		for (const ciphertext of Object.values(rotatedAlias ?? {})) {
			expect(encryptionKeyId(String(ciphertext))).toBe("current");
		}
		expect(
			await decryptToken(String(rotatedAlias?.bsuidCiphertext), KEY_RING, {
				recordId: aliasId,
				field: "whatsapp_identity_bsuid",
			}),
		).toBe("bsuid");
	});

	it("uses complete-document and complete-ciphertext CAS fences", () => {
		const source = readFileSync(
			new URL("../services/encryption-rotation.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain(
			"socialMutationOperations.requestPayload} IS NOT DISTINCT FROM",
		);
		expect(source).toContain(
			"whatsappIdentityAliases.usernameCiphertext} IS NOT DISTINCT FROM",
		);
		expect(source).toContain("eq(whatsappGroups.inviteLinkCiphertext");
	});
});
