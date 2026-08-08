import { describe, expect, it } from "bun:test";
import {
	contactSubscriptionEvents,
	contactSubscriptions,
	postTags,
} from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { SubscriptionListUpdateSpec } from "../schemas/subscription-lists";
import { projectContactSubscriptionTransition } from "../services/contact-subscription-transitions";

function columnNames(columns: Array<{ name: string }>): string[] {
	return columns.map((column) => column.name);
}

describe("subscription-list and post-tag database invariants", () => {
	it("makes post-tag identity tenant-safe and keeps a post-first access path", () => {
		const config = getTableConfig(postTags);
		expect(columnNames(config.primaryKeys[0]?.columns ?? [])).toEqual([
			"organization_id",
			"tag_id",
			"post_id",
		]);
		expect(
			config.indexes
				.find((index) => index.config.name === "post_tags_org_post_tag_idx")
				?.config.columns.map((column) => "name" in column && column.name),
		).toEqual(["organization_id", "post_id", "tag_id"]);
		expect(
			config.foreignKeys.map((foreignKey) =>
				columnNames(foreignKey.reference().columns),
			),
		).toEqual(
			expect.arrayContaining([
				["post_id", "organization_id", "scope_key"],
				["tag_id", "organization_id", "tag_scope_key"],
			]),
		);
	});

	it("closes membership sources and protects membership chronology", () => {
		const config = getTableConfig(contactSubscriptions);
		expect(contactSubscriptions.source.enumValues).toEqual([
			"automation",
			"manual",
			"import",
			"api",
		]);
		expect(columnNames(config.primaryKeys[0]?.columns ?? [])).toEqual([
			"organization_id",
			"list_id",
			"contact_id",
		]);
		expect(config.checks.map((constraint) => constraint.name)).toContain(
			"contact_subscriptions_timestamp_order_check",
		);
		expect(config.checks.map((constraint) => constraint.name)).toEqual(
			expect.arrayContaining([
				"contact_subscriptions_state_check",
				"contact_subscriptions_sequence_positive_check",
			]),
		);
		const projectionSource = config.foreignKeys.find(
			(foreignKey) =>
				foreignKey.getName() === "contact_subscriptions_projection_source_fk",
		);
		expect(columnNames(projectionSource?.reference().columns ?? [])).toEqual([
			"last_event_id",
			"organization_id",
			"scope_key",
			"list_id",
			"contact_id",
			"state",
			"source",
			"updated_at",
			"last_event_sequence",
		]);
		expect(
			columnNames(projectionSource?.reference().foreignColumns ?? []),
		).toEqual([
			"id",
			"organization_id",
			"scope_key",
			"list_id",
			"contact_id",
			"type",
			"source",
			"occurred_at",
			"ingestion_sequence",
		]);
	});

	it("anchors immutable evidence to list scope without coupling history to a live contact row", () => {
		const config = getTableConfig(contactSubscriptionEvents);
		expect(
			config.foreignKeys.map((foreignKey) => ({
				columns: columnNames(foreignKey.reference().columns),
				onDelete: foreignKey.onDelete,
			})),
		).toEqual(
			expect.arrayContaining([
				{
					columns: ["list_id", "organization_id", "scope_key"],
					onDelete: "cascade",
				},
			]),
		);
		expect(
			config.foreignKeys.some((foreignKey) =>
				columnNames(foreignKey.reference().columns).includes("contact_id"),
			),
		).toBe(false);
		expect(
			config.uniqueConstraints.map((constraint) => constraint.name),
		).toEqual(
			expect.arrayContaining([
				"contact_subscription_events_ingestion_sequence_uniq",
				"contact_subscription_events_projection_source_uniq",
			]),
		);
		expect(config.checks.map((constraint) => constraint.name)).toEqual(
			expect.arrayContaining([
				"contact_subscription_events_sequence_positive_check",
				"contact_subscription_events_merge_origin_check",
			]),
		);
		expect(contactSubscriptionEvents.type.enumValues).toEqual([
			"subscribed",
			"unsubscribed",
		]);
	});
});

describe("subscription-list transition semantics", () => {
	const first = new Date("2026-07-28T10:00:00.000Z");
	const removed = new Date("2026-07-28T11:00:00.000Z");
	const readded = new Date("2026-07-28T12:00:00.000Z");

	it("upserts an absent unsubscribe as inactive evidence", () => {
		expect(
			projectContactSubscriptionTransition(
				null,
				"unsubscribed",
				"api",
				removed,
			),
		).toEqual({
			state: "unsubscribed",
			subscribedAt: removed,
			unsubscribedAt: removed,
			source: "api",
			updatedAt: removed,
			transitioned: true,
		});
	});

	it("is idempotent in-place but opens a new interval on re-add", () => {
		const active = projectContactSubscriptionTransition(
			null,
			"subscribed",
			"api",
			first,
		);
		expect(
			projectContactSubscriptionTransition(
				active,
				"subscribed",
				"automation",
				removed,
			).transitioned,
		).toBe(false);

		const inactive = projectContactSubscriptionTransition(
			active,
			"unsubscribed",
			"automation",
			removed,
		);
		expect(inactive).toEqual({
			state: "unsubscribed",
			subscribedAt: first,
			unsubscribedAt: removed,
			source: "automation",
			updatedAt: removed,
			transitioned: true,
		});

		expect(
			projectContactSubscriptionTransition(
				inactive,
				"subscribed",
				"api",
				readded,
			),
		).toEqual({
			state: "subscribed",
			subscribedAt: readded,
			unsubscribedAt: null,
			source: "api",
			updatedAt: readded,
			transitioned: true,
		});

		expect(
			projectContactSubscriptionTransition(
				inactive,
				"unsubscribed",
				"api",
				readded,
				{ forceEvidence: true },
			),
		).toEqual({
			state: "unsubscribed",
			subscribedAt: first,
			unsubscribedAt: removed,
			source: "api",
			updatedAt: readded,
			transitioned: true,
		});
	});

	it("keeps list channel immutable and consent outside membership input", () => {
		expect(
			SubscriptionListUpdateSpec.safeParse({ channel: "whatsapp" }).success,
		).toBe(false);
		expect(
			SubscriptionListUpdateSpec.safeParse({
				name: "Customers",
				consent: true,
			}).success,
		).toBe(false);
	});

	it("records history atomically, keeps merges append-only, and never mutates consent", async () => {
		const [transitionSource, listRouteSource, contactRouteSource] =
			await Promise.all([
				Bun.file(
					new URL(
						"../services/contact-subscription-transitions.ts",
						import.meta.url,
					),
				).text(),
				Bun.file(
					new URL("../routes/subscription-lists.ts", import.meta.url),
				).text(),
				Bun.file(new URL("../routes/contacts.ts", import.meta.url)).text(),
			]);
		expect(transitionSource).toContain("db.transaction((tx)");
		expect(transitionSource).toContain(".insert(contactSubscriptionEvents)");
		expect(transitionSource).toContain("mergedFromContactId");
		expect(contactRouteSource).toContain(
			"mergeContactSubscriptionProjections(tx",
		);
		expect(contactRouteSource).not.toContain(
			".update(contactSubscriptionEvents)",
		);
		expect(listRouteSource).not.toContain("recordContactConsent");
		expect(listRouteSource).not.toContain("contactConsent");
	});
});
