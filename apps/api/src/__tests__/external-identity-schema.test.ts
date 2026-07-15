import { describe, expect, it } from "bun:test";
import { adCampaigns, ads, organizationSubscriptions } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";

function uniqueColumns(
	table: Parameters<typeof getTableConfig>[0],
): string[][] {
	return getTableConfig(table)
		.indexes.filter((index) => index.config.unique)
		.map((index) =>
			index.config.columns.flatMap((column) => {
				const name = (column as { name?: unknown }).name;
				return typeof name === "string" ? [name] : [];
			}),
		);
}

describe("external identity constraints", () => {
	it("keys campaign and ad identities by their owning ad account", () => {
		expect(uniqueColumns(adCampaigns)).toContainEqual([
			"ad_account_id",
			"platform_campaign_id",
		]);
		expect(uniqueColumns(ads)).toContainEqual([
			"ad_account_id",
			"platform_ad_id",
		]);
	});

	it("prevents Stripe customer and subscription split-brain rows", () => {
		expect(uniqueColumns(organizationSubscriptions)).toContainEqual([
			"stripe_customer_id",
		]);
		expect(uniqueColumns(organizationSubscriptions)).toContainEqual([
			"stripe_subscription_id",
		]);
	});
});
