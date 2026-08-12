/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { renderBillingPeriodInvariantSql } from "../scripts/render-billing-period-invariant-sql";
import {
	DATABASE_EXTENSION_INSTALLABILITY_PROBES,
	REQUIRED_DATABASE_EXTENSION_SCHEMAS,
	REQUIRED_DATABASE_EXTENSIONS,
} from "./database-prerequisites";
import { POSTGRES_PRIVACY_FIELD_CLASSIFICATIONS } from "./postgres-privacy-field-classifications";
import {
	billingPeriods,
	organizationSubscriptions,
	usageBuckets,
} from "./schema";

describe("locked billing authority", () => {
	it("keeps mutable subscription settings separate from period financial truth", () => {
		const config = getTableConfig(organizationSubscriptions);
		const columns = config.columns.map((column) => column.name);

		expect(columns).toEqual(
			expect.arrayContaining(["source", "delinquent_at", "grace_ends_at"]),
		);
		expect(columns).not.toEqual(
			expect.arrayContaining([
				"posts_included",
				"price_per_post_cents",
				"monthly_price_cents",
				"daily_tool_limit",
			]),
		);
		const dailyToolOverride = config.columns.find(
			(column) => column.name === "daily_tool_limit_override",
		);
		expect(dailyToolOverride).toBeDefined();
		expect(dailyToolOverride?.notNull).toBe(false);
		expect(dailyToolOverride?.hasDefault).toBe(false);
		expect(config.checks.map((constraint) => constraint.name)).toEqual(
				expect.arrayContaining([
					"organization_subscriptions_source_check",
					"organization_subscriptions_stripe_authority_check",
					"organization_subscriptions_past_due_check",
				"organization_subscriptions_daily_tool_limit_override_check",
			]),
		);
		const authorityCheck = config.checks.find(
			(constraint) =>
				constraint.name ===
				"organization_subscriptions_stripe_authority_check",
		);
		expect(authorityCheck).toBeDefined();
		if (!authorityCheck) throw new Error("Missing subscription authority check");
		const authoritySql = new PgDialect()
			.sqlToQuery(authorityCheck.value)
			.sql.replaceAll(/\s+/g, " ");
		expect(authoritySql).toContain(
			`"source" = 'complimentary' AND "organization_subscriptions"."status" IN ('active', 'cancelled')`,
		);
		expect(authoritySql).not.toContain(
			`"status" IN ('active', 'cancelled') AND "organization_subscriptions"."stripe_customer_id" IS NULL`,
		);
		expect(authoritySql).toContain(
			`"status" IN ('active', 'trialing', 'past_due') AND "organization_subscriptions"."stripe_customer_id" IS NOT NULL AND "organization_subscriptions"."stripe_subscription_id" IS NOT NULL`,
		);

		const classification =
			POSTGRES_PRIVACY_FIELD_CLASSIFICATIONS[
				"postgres:public.organization_subscriptions"
			];
		const classifiedColumns = Object.values(classification.columns).flat();
		expect(classifiedColumns).not.toEqual(
			expect.arrayContaining([
				"posts_included",
				"price_per_post_cents",
				"monthly_price_cents",
			]),
		);
	});

	it("encodes non-overlapping immutable periods and one operator release", () => {
		const config = getTableConfig(billingPeriods);
		const indexes = new Map(
			config.indexes.map((index) => [index.config.name, index.config]),
		);
		expect(
			config.uniqueConstraints.map((constraint) => constraint.name),
		).toEqual(
			expect.arrayContaining([
				"billing_periods_id_org_uniq",
				"billing_periods_id_org_window_uniq",
			]),
		);
		expect(indexes.get("billing_periods_org_start_live_uniq")?.unique).toBe(
			true,
		);
		expect(
			indexes.get("billing_periods_org_start_live_uniq")?.where,
		).toBeDefined();
		expect(config.columns.map((column) => column.name)).toContain(
			"release_count",
		);
		expect(config.columns.map((column) => column.name)).toContain(
			"effective_included_units_snapshot",
		);

		const sql = renderBillingPeriodInvariantSql();
		expect(sql).toContain("DEFERRABLE INITIALLY IMMEDIATE");
		expect(sql).toContain("billing_periods_live_window_excl");
		expect(sql).toContain("tstzrange(period_start, period_end, '[)')");
		expect(sql).toContain("billing_periods_authority_immutable");
		expect(sql).toContain("NEW.release_count = 1");
		expect(sql).toContain("billing period reclaim has already been used");
		expect(sql).toContain(
			"NEW.effective_included_units_snapshot IS DISTINCT FROM OLD.effective_included_units_snapshot",
		);
	});

	it("requires metered buckets to point at the exact period window", () => {
		const config = getTableConfig(usageBuckets);
		expect(config.checks.map((constraint) => constraint.name)).toContain(
			"usage_buckets_metered_authority_check",
		);
		expect(
			config.foreignKeys.map((foreignKey) => {
				const reference = foreignKey.reference();
				return {
					name: reference.name,
					local: reference.columns.map((column) => column.name),
					foreign: reference.foreignColumns.map((column) => column.name),
				};
			}),
		).toContainEqual({
			name: "usage_buckets_billing_period_window_fk",
			local: [
				"billing_period_id",
				"organization_id",
				"period_start",
				"period_end",
			],
			foreign: ["id", "organization_id", "period_start", "period_end"],
		});
	});

	it("provisions btree_gist for clean replay and self-host installs", () => {
		expect(REQUIRED_DATABASE_EXTENSIONS).toContain("btree_gist");
		expect(REQUIRED_DATABASE_EXTENSION_SCHEMAS.btree_gist).toBe("public");
		expect(
			DATABASE_EXTENSION_INSTALLABILITY_PROBES.btree_gist.versionEpochs,
		).toEqual([{ schema: "public", updateTargets: [], dropAfter: false }]);
	});
});
