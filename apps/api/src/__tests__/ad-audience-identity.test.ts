import { adAudienceUsers } from "@relayapi/db";
import { describe, expect, it } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { storedAudienceUsers } from "../services/ad-audience";

describe("ad audience durable identity", () => {
	it("uses SQL NULL for an absent hash so partial indexes do not collapse unrelated users", () => {
		expect(
			storedAudienceUsers("aud_1", [
				{ emailHash: "a".repeat(64) },
				{ emailHash: "b".repeat(64) },
				{ phoneHash: "c".repeat(64) },
				{},
			]),
		).toEqual([
			{
				audienceId: "aud_1",
				emailHash: "a".repeat(64),
				phoneHash: null,
			},
			{
				audienceId: "aud_1",
				emailHash: "b".repeat(64),
				phoneHash: null,
			},
			{
				audienceId: "aud_1",
				emailHash: null,
				phoneHash: "c".repeat(64),
			},
		]);
	});

	it("constrains every stored identifier to a SHA-256 hex digest", () => {
		const checks = getTableConfig(adAudienceUsers).checks.map(
			(check) => check.name,
		);
		expect(checks).toEqual(
			expect.arrayContaining([
				"ad_audience_users_identifier_present_check",
				"ad_audience_users_email_hash_check",
				"ad_audience_users_phone_hash_check",
			]),
		);
	});
});
