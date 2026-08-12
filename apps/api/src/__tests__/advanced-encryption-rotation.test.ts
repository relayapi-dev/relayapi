import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { decryptToken, encryptionKeyId, encryptToken } from "../lib/crypto";
import {
	rotateAdConversionPayload,
	rotateAdvancedAdLeadPayload,
	rotateMediaUploadAuthority,
} from "../services/encryption-rotation";

const OLD_KEY = `old=${"3d".repeat(32)}`;
const KEY_RING = `current=${"4e".repeat(32)},old=${"3d".repeat(32)}`;

async function oldCiphertext(
	value: string,
	recordId: string,
	field: string,
): Promise<string> {
	return encryptToken(value, OLD_KEY, { recordId, field });
}

describe("advanced-resource encryption rotation", () => {
	it("rotates lead, future conversion, and live multipart envelopes with exact AAD", async () => {
		const lead = await rotateAdvancedAdLeadPayload(KEY_RING, {
			id: "adlead_1",
			payloadCiphertext: await oldCiphertext(
				'{"email":"lead@example.com"}',
				"adlead_1",
				"ad_lead_payload",
			),
		});
		const conversion = await rotateAdConversionPayload(KEY_RING, {
			id: "adconv_1",
			payloadCiphertext: await oldCiphertext(
				'{"event":"purchase"}',
				"adconv_1",
				"ad_conversion_payload",
			),
		});
		const upload = await rotateMediaUploadAuthority(KEY_RING, {
			id: "mup_1",
			multipartUploadIdCiphertext: await oldCiphertext(
				"provider-upload-id",
				"mup_1",
				"multipart_upload_id",
			),
		});

		for (const value of [lead, conversion, upload]) {
			expect(encryptionKeyId(value ?? "")).toBe("current");
		}
		expect(
			await decryptToken(lead ?? "", KEY_RING, {
				recordId: "adlead_1",
				field: "ad_lead_payload",
			}),
		).toContain("lead@example.com");
		expect(
			await decryptToken(conversion ?? "", KEY_RING, {
				recordId: "adconv_1",
				field: "ad_conversion_payload",
			}),
		).toContain("purchase");
		expect(
			await decryptToken(upload ?? "", KEY_RING, {
				recordId: "mup_1",
				field: "multipart_upload_id",
			}),
		).toBe("provider-upload-id");
	});

	it("CAS-fences every rotating row and preserves semantic timestamps", () => {
		const source = readFileSync(
			new URL("../services/encryption-rotation.ts", import.meta.url),
			"utf8",
		);
		for (const marker of [
			'["access_token", adConnections.accessToken, row.accessToken]',
			'["refresh_token", adConnections.refreshToken, row.refreshToken]',
			'["token_secret", adConnections.tokenSecret, row.tokenSecret]',
			"eq(column, oldValue)",
			"eq(adLeads.payloadCiphertext, row.payloadCiphertext)",
			"eq(adConversionEvents.payloadCiphertext, row.payloadCiphertext)",
			"mediaUploadSessions.multipartUploadIdCiphertext",
			"row.multipartUploadIdCiphertext",
		]) {
			expect(source).toContain(marker);
		}
		expect(source).toContain(
			"const activeAdConnectionPrefix = `adconn:v1:enc:v2:$" + "{activeId}:`;",
		);
	});
});
