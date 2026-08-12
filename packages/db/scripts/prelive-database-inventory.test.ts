/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { is } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/schema";
import {
	buildCatalogFingerprint,
	type CatalogFingerprint,
} from "./catalog-fingerprint-contract";
import {
	assertInventoryContractRelations,
	assertResetGuardCatalogShape,
	assertReviewedGenerationOneCatalog,
	classifyGenerationOneLegacyUsageRecords,
	classifyGenerationOneUnsettledUsageBuckets,
	classifyMoneyBearingReferences,
	classifyUnresolvedProviderOperations,
	EXPECTED_RESET_GUARD_CATALOG_SIGNATURES,
	GENERATION_ONE_MONEY_BEARING_INVENTORY_CONTRACTS,
	GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS,
	type InventoryRow,
	MONEY_BEARING_INVENTORY_CONTRACTS,
	type MoneyBearingInventoryContract,
	PROVIDER_OPERATION_INVENTORY_CONTRACTS,
	type PreliveDatabaseInventory,
	type ProviderOperationInventoryContract,
} from "./prelive-database-inventory";
import {
	approvedDatabaseInventoryLockTargets,
	assertResetCatalogAllowlist,
	validateApprovedDatabaseInventoryArtifact,
} from "./prelive-reset";

function rows(relation: string, row: InventoryRow) {
	return new Map([[relation, [row]]]);
}

function providerRow(
	target: ProviderOperationInventoryContract,
	state: string,
	contracts: readonly ProviderOperationInventoryContract[] = PROVIDER_OPERATION_INVENTORY_CONTRACTS,
): InventoryRow {
	const row: InventoryRow = {
		id: "local_1",
		organization_id: "org_1",
	};
	for (const sourceContract of contracts) {
		const contract: ProviderOperationInventoryContract = sourceContract;
		if (contract.relation !== target.relation) continue;
		row[contract.localIdKey ?? "id"] = "local_1";
		row[contract.stateKey] = contract.terminalStates[0];
	}
	for (const providerKey of target.providerKeys) {
		row[providerKey] = `${providerKey}_1`;
	}
	row[target.stateKey] = state;
	return row;
}

const reviewedGenerationOneCatalog = JSON.parse(
	readFileSync(
		new URL(
			"../catalog-fingerprint-generation-1-old-chain.json",
			import.meta.url,
		),
		"utf8",
	),
) as CatalogFingerprint;

function generationOneRows(
	relationRows: Readonly<Record<string, readonly InventoryRow[]>>,
): Map<string, readonly InventoryRow[]> {
	return new Map(Object.entries(relationRows));
}

function catalogColumnNames(
	catalog: CatalogFingerprint,
	relation: string,
): Set<string> {
	const prefix = `${relation}.`;
	return new Set(
		catalog.objects
			.filter(
				(object) =>
					object.kind === "column" && object.identity.startsWith(prefix),
			)
			.map((object) => object.identity.slice(prefix.length)),
	);
}

function generationOneCatalogStateDomain(
	relation: string,
	stateKey: string,
): string[] | null {
	const column = reviewedGenerationOneCatalog.objects.find(
		(object) =>
			object.kind === "column" && object.identity === `${relation}.${stateKey}`,
	);
	if (!column) return null;
	const columnDefinition = JSON.parse(column.definition) as { type?: unknown };
	if (
		typeof columnDefinition.type === "string" &&
		columnDefinition.type !== "text"
	) {
		const enumPrefix = `public.${columnDefinition.type}.`;
		const labels = reviewedGenerationOneCatalog.objects
			.filter(
				(object) =>
					object.kind === "enum-label" &&
					object.identity.startsWith(enumPrefix),
			)
			.map((object) => object.identity.slice(enumPrefix.length));
		if (labels.length > 0) return labels.sort();
	}

	const escapedKey = stateKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const arrayPattern = new RegExp(
		`(?<![a-z_])${escapedKey} = ANY \\(ARRAY\\[([^\\]]*)\\]`,
		"g",
	);
	const equalityPattern = new RegExp(
		`(?<![a-z_])${escapedKey} = '([^']+)'::text`,
		"g",
	);
	const states = new Set<string>();
	for (const object of reviewedGenerationOneCatalog.objects) {
		if (
			object.kind !== "constraint" ||
			!object.identity.startsWith(`${relation}.`)
		) {
			continue;
		}
		const parsed = JSON.parse(object.definition) as { definition?: unknown };
		if (typeof parsed.definition !== "string") continue;
		for (const match of parsed.definition.matchAll(arrayPattern)) {
			for (const state of match[1]?.matchAll(/'([^']+)'::text/g) ?? []) {
				if (state[1]) states.add(state[1]);
			}
		}
		for (const match of parsed.definition.matchAll(equalityPattern)) {
			if (match[1]) states.add(match[1]);
		}
	}
	return states.size > 0 ? [...states].sort() : null;
}

function moneyRow(contract: MoneyBearingInventoryContract): InventoryRow {
	const row: InventoryRow = {
		id: "local_1",
		organization_id: "org_1",
		source: "stripe",
		billable: true,
		applied_quantity: 1,
		stripe_subscription_id: "sub_1",
		stripe_subscription_item_id: "si_1",
		platform_campaign_id: "campaign_1",
		platform_ad_set_id: "adset_1",
		platform_creative_id: "creative_1",
		platform_ad_id: "ad_1",
	};
	row[contract.localIdKey ?? "id"] = "local_1";
	return row;
}

describe("explicit provider-operation inventory contracts", () => {
	for (const sourceContract of PROVIDER_OPERATION_INVENTORY_CONTRACTS) {
		const contract: ProviderOperationInventoryContract = sourceContract;
		test(`${contract.kind} includes every blocking state`, () => {
			for (const state of contract.unresolvedStates) {
				const references = classifyUnresolvedProviderOperations(
					rows(contract.relation, providerRow(contract, state)),
				);
				expect(
					references.some(
						(reference) =>
							reference.kind === contract.kind && reference.status === state,
					),
				).toBe(true);
			}
		});

		test(`${contract.kind} excludes every terminal state`, () => {
			for (const state of contract.terminalStates) {
				const references = classifyUnresolvedProviderOperations(
					rows(contract.relation, providerRow(contract, state)),
				);
				expect(
					references.some((reference) => reference.kind === contract.kind),
				).toBe(false);
			}
		});

		test(`${contract.kind} rejects schema drift`, () => {
			expect(() =>
				classifyUnresolvedProviderOperations(
					rows(
						contract.relation,
						providerRow(contract, "new_unclassified_state"),
					),
				),
			).toThrow("unclassified state new_unclassified_state");
		});
	}

	test("covers every named money-path and analogous provider boundary", () => {
		const kinds = new Set<string>(
			PROVIDER_OPERATION_INVENTORY_CONTRACTS.map(({ kind }) => kind),
		);
		for (const kind of [
			"subscription_checkout_operation",
			"billing_operation",
			"billing_operation_attempt",
			"phone_billing_operation",
			"phone_billing_attempt",
			"dunning_delivery",
			"dunning_deactivation",
			"billing_outbox_operation",
			"stripe_inbox_event",
			"phone_provisioning_operation",
			"phone_release_operation",
			"account_revocation_operation",
			"ad_creation_operation",
			"ad_mutation_operation",
			"ad_report_operation",
			"ad_conversion_operation",
			"social_mutation_operation",
			"media_upload_operation",
			"media_processing_operation",
			"usage_reservation",
			"thread_publish_execution",
			"queue_failure_resolution",
			"publish_attempt",
			"webhook_delivery",
			"inbox_event_effect",
			"email_delivery",
			"broadcast_delivery",
			"automation_provider_effect",
			"external_subject_cleanup",
		]) {
			expect(kinds.has(kind)).toBe(true);
		}
	});
});

describe("explicit money-bearing inventory contracts", () => {
	for (const sourceContract of MONEY_BEARING_INVENTORY_CONTRACTS) {
		const contract: MoneyBearingInventoryContract = sourceContract;
		if (!contract.stateKey) continue;

		test(`${contract.kind} includes every money-bearing state`, () => {
			for (const state of contract.moneyBearingStates ?? []) {
				const row = moneyRow(contract);
				row[contract.stateKey ?? "status"] = state;
				const references = classifyMoneyBearingReferences(
					rows(contract.relation, row),
				);
				expect(
					references.some(
						(reference) =>
							reference.kind === contract.kind && reference.status === state,
					),
				).toBe(true);
			}
		});

		test(`${contract.kind} excludes every settled state`, () => {
			for (const state of contract.nonMoneyBearingStates ?? []) {
				const row = moneyRow(contract);
				row[contract.stateKey ?? "status"] = state;
				const references = classifyMoneyBearingReferences(
					rows(contract.relation, row),
				);
				expect(
					references.some((reference) => reference.kind === contract.kind),
				).toBe(false);
			}
		});

		test(`${contract.kind} rejects schema drift`, () => {
			const row = moneyRow(contract);
			row[contract.stateKey ?? "status"] = "new_unclassified_state";
			expect(() =>
				classifyMoneyBearingReferences(rows(contract.relation, row)),
			).toThrow("unclassified state new_unclassified_state");
		});
	}

	test("captures applied phone quantity and every provider ad identity", () => {
		const phone = classifyMoneyBearingReferences(
			rows("public.whatsapp_phone_billing_operations", {
				id: "wpb_1",
				organization_id: "org_1",
				state: "applied",
				applied_quantity: 1,
			}),
		);
		expect(phone.map(({ kind }) => kind)).toEqual([
			"applied_phone_billing_commitment",
		]);

		const adRows = new Map<string, InventoryRow[]>([
			[
				"public.ad_campaigns",
				[
					{
						id: "camp_1",
						organization_id: "org_1",
						status: "active",
						platform_campaign_id: "provider_campaign_1",
					},
				],
			],
			[
				"public.ads",
				[
					{
						id: "ad_1",
						organization_id: "org_1",
						status: "active",
						platform_ad_id: "provider_ad_1",
					},
				],
			],
			[
				"public.ad_creation_operations",
				[
					{
						id: "adop_1",
						organization_id: "org_1",
						status: "processing",
						platform_creative_id: "provider_creative_1",
					},
				],
			],
		]);
		expect(
			classifyMoneyBearingReferences(adRows).map(({ kind }) => kind),
		).toEqual([
			"partial_provider_ad_creation",
			"provider_ad_campaign",
			"provider_ad",
		]);
	});

	test("retained provider IDs do not revive zero or terminal commitments", () => {
		const terminalRows = new Map<string, InventoryRow[]>([
			[
				"public.organization_subscriptions",
				[
					{
						id: "sub_local_1",
						organization_id: "org_1",
						source: "stripe",
						status: "cancelled",
						stripe_subscription_id: "sub_retained",
					},
				],
			],
			[
				"public.whatsapp_phone_numbers",
				[
					{
						id: "wpn_1",
						organization_id: "org_1",
						status: "released",
						provider_number_id: "number_retained",
						stripe_phone_subscription_id: "phone_sub_retained",
					},
				],
			],
			[
				"public.whatsapp_phone_billing_operations",
				[
					{
						id: "wpb_1",
						organization_id: "org_1",
						state: "applied",
						applied_quantity: 0,
						stripe_subscription_id: "phone_sub_retained",
						stripe_subscription_item_id: "phone_item_retained",
					},
				],
			],
			[
				"public.ad_campaigns",
				[
					{
						id: "camp_1",
						organization_id: "org_1",
						status: "cancelled",
						platform_campaign_id: "campaign_retained",
					},
				],
			],
			[
				"public.ads",
				[
					{
						id: "ad_1",
						organization_id: "org_1",
						status: "completed",
						platform_ad_id: "ad_retained",
					},
				],
			],
			[
				"public.ad_creation_operations",
				[
					{
						id: "adop_1",
						organization_id: "org_1",
						status: "completed",
						platform_ad_id: "ad_retained",
					},
				],
			],
		]);
		expect(classifyMoneyBearingReferences(terminalRows)).toEqual([]);

		terminalRows.set("public.ad_creation_operations", [
			{
				id: "adop_1",
				organization_id: "org_1",
				status: "unknown",
				platform_ad_id: "possibly_created_ad",
			},
		]);
		expect(
			classifyMoneyBearingReferences(terminalRows).map(({ kind }) => kind),
		).toEqual(["partial_provider_ad_creation"]);
	});
});

describe("sealed generation-1 inventory contracts", () => {
	test("every contracted relation and referenced column exists in the reviewed old catalog", () => {
		const relationNames = new Set(
			reviewedGenerationOneCatalog.objects
				.filter((object) => object.kind === "relation")
				.map((object) => object.identity),
		);
		for (const sourceContract of [
			...GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS,
			...GENERATION_ONE_MONEY_BEARING_INVENTORY_CONTRACTS,
		]) {
			const contract:
				| ProviderOperationInventoryContract
				| MoneyBearingInventoryContract = sourceContract;
			expect(
				relationNames.has(contract.relation),
				`${contract.kind} relation ${contract.relation}`,
			).toBe(true);
			const columns = catalogColumnNames(
				reviewedGenerationOneCatalog,
				contract.relation,
			);
			for (const key of [
				contract.localIdKey ?? "id",
				contract.stateKey,
				...contract.providerKeys,
			]) {
				if (!key) continue;
				expect(
					columns.has(key),
					`${contract.kind} column ${contract.relation}.${key}`,
				).toBe(true);
			}
			if (contract.organizationIdKey) {
				expect(
					columns.has(contract.organizationIdKey),
					`${contract.kind} organization column ${contract.organizationIdKey}`,
				).toBe(true);
			}
		}

		const bespokeUsageColumns: Record<string, readonly string[]> = {
			"public.usage_buckets": [
				"id",
				"organization_id",
				"metric",
				"included_units",
				"committed_units",
			],
			"public.usage_bucket_settlements": [
				"id",
				"bucket_id",
				"state",
				"committed_units_snapshot",
				"invoice_id",
				"settlement_key",
			],
			"public.usage_records": [
				"id",
				"organization_id",
				"posts_count",
				"posts_included",
				"overage_posts",
				"overage_cost_cents",
				"api_calls_count",
				"api_calls_included",
				"overage_calls",
				"overage_calls_cost_cents",
				"billed_at",
			],
		};
		for (const [relation, requiredColumns] of Object.entries(
			bespokeUsageColumns,
		)) {
			expect(relationNames.has(relation), relation).toBe(true);
			const columns = catalogColumnNames(
				reviewedGenerationOneCatalog,
				relation,
			);
			for (const column of requiredColumns) {
				expect(columns.has(column), `${relation}.${column}`).toBe(true);
			}
		}
	});

	test("every catalog-enforced state domain is partitioned exactly", () => {
		const unconstrainedStateColumns = new Set([
			"public.ad_campaigns.status",
			"public.ads.status",
		]);
		for (const sourceContract of [
			...GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS,
			...GENERATION_ONE_MONEY_BEARING_INVENTORY_CONTRACTS,
		]) {
			const contract:
				| ProviderOperationInventoryContract
				| MoneyBearingInventoryContract = sourceContract;
			if (!contract.stateKey) continue;
			const catalogStates = generationOneCatalogStateDomain(
				contract.relation,
				contract.stateKey,
			);
			const key = `${contract.relation}.${contract.stateKey}`;
			if (!catalogStates) {
				expect(unconstrainedStateColumns.has(key), key).toBe(true);
				continue;
			}
			const contractStates =
				"unresolvedStates" in contract
					? [...contract.unresolvedStates, ...contract.terminalStates]
					: [
							...(contract.moneyBearingStates ?? []),
							...(contract.nonMoneyBearingStates ?? []),
						];
			expect([...new Set(contractStates)].sort(), key).toEqual(catalogStates);
		}
	});

	test("every old provider state is classified and embedded release null is skipped", () => {
		for (const sourceContract of GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS) {
			const contract: ProviderOperationInventoryContract = sourceContract;
			for (const state of contract.unresolvedStates) {
				const references = classifyUnresolvedProviderOperations(
					rows(
						contract.relation,
						providerRow(
							contract,
							state,
							GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS,
						),
					),
					GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS,
				);
				expect(
					references.some(
						(reference) =>
							reference.kind === contract.kind && reference.status === state,
					),
					`${contract.kind}:${state}`,
				).toBe(true);
			}
			for (const state of contract.terminalStates) {
				const references = classifyUnresolvedProviderOperations(
					rows(
						contract.relation,
						providerRow(
							contract,
							state,
							GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS,
						),
					),
					GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS,
				);
				expect(
					references.some((reference) => reference.kind === contract.kind),
					`${contract.kind}:${state}`,
				).toBe(false);
			}
		}

		const phoneRow = providerRow(
			GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS.find(
				(contract) => contract.kind === "generation_one_phone_provisioning",
			) as ProviderOperationInventoryContract,
			"completed",
			GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS,
		);
		phoneRow.release_state = null;
		expect(
			classifyUnresolvedProviderOperations(
				rows("public.whatsapp_phone_numbers", phoneRow),
				GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS,
			),
		).toEqual([]);
	});

	test("old paid subscriptions block without the nonexistent source column", () => {
		for (const status of ["trialing", "active", "past_due"]) {
			const references = classifyMoneyBearingReferences(
				rows("public.organization_subscriptions", {
					id: `sub_${status}`,
					organization_id: "org_1",
					status,
					stripe_customer_id: status === "active" ? null : "cus_1",
					stripe_subscription_id: status === "trialing" ? "sub_1" : null,
					stripe_metered_item_id: null,
				}),
				GENERATION_ONE_MONEY_BEARING_INVENTORY_CONTRACTS,
			);
			expect(references.map(({ kind }) => kind)).toEqual([
				"stripe_base_subscription",
			]);
		}
		expect(
			classifyMoneyBearingReferences(
				rows("public.organization_subscriptions", {
					id: "sub_cancelled",
					organization_id: "org_1",
					status: "cancelled",
					stripe_customer_id: "cus_retained",
					stripe_subscription_id: "sub_retained",
				}),
				GENERATION_ONE_MONEY_BEARING_INVENTORY_CONTRACTS,
			),
		).toEqual([]);
	});

	test("claimed settlements block and terminal settlements do not", () => {
		const contract = GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS.find(
			(candidate) => candidate.kind === "generation_one_usage_settlement",
		) as ProviderOperationInventoryContract;
		for (const state of ["claimed", "settled", "released"]) {
			const references = classifyUnresolvedProviderOperations(
				rows("public.usage_bucket_settlements", {
					id: `ubs_${state}`,
					organization_id: "org_1",
					bucket_id: "ub_1",
					state,
				}),
				[contract],
			);
			expect(references.length, state).toBe(state === "claimed" ? 1 : 0);
		}
	});

	test("old buckets expose unclaimed and post-settlement overage", () => {
		const classify = (
			bucket: InventoryRow,
			settlements: readonly InventoryRow[] = [],
		) =>
			classifyGenerationOneUnsettledUsageBuckets(
				generationOneRows({
					"public.usage_buckets": [
						{
							id: "ub_1",
							organization_id: "org_1",
							metric: "successful_mutation",
							included_units: 200,
							committed_units: 200,
							...bucket,
						},
					],
					"public.usage_bucket_settlements": settlements,
				}),
			);

		expect(classify({ committed_units: 201 })[0]).toMatchObject({
			localId: "ub_1",
			status: "unclaimed",
		});
		expect(
			classify({ committed_units: 250 }, [
				{
					id: "ubs_1",
					bucket_id: "ub_1",
					state: "settled",
					committed_units_snapshot: 250,
				},
			]),
		).toEqual([]);
		expect(
			classify({ committed_units: 275 }, [
				{
					id: "ubs_1",
					bucket_id: "ub_1",
					state: "settled",
					committed_units_snapshot: 250,
				},
			])[0],
		).toMatchObject({ status: "settled" });
		expect(
			classify({ committed_units: 225 }, [
				{
					id: "ubs_1",
					bucket_id: "ub_1",
					state: "released",
					committed_units_snapshot: 200,
				},
			])[0],
		).toMatchObject({ status: "released" });
		expect(() =>
			classify({ metric: "unknown_metric", committed_units: 201 }),
		).toThrow("unclassified metric unknown_metric");
		expect(() =>
			classify({ committed_units: 225 }, [
				{
					id: "ubs_1",
					bucket_id: "ub_1",
					state: "settled",
					committed_units_snapshot: "200",
				},
			]),
		).toThrow("invalid committed_units_snapshot");
	});

	test("legacy overage blocks even when its billed marker is present", () => {
		const classify = (row: InventoryRow) =>
			classifyGenerationOneLegacyUsageRecords(
				generationOneRows({
					"public.usage_records": [
						{
							id: "usage_1",
							organization_id: "org_1",
							posts_count: 0,
							posts_included: 1_000,
							overage_posts: 0,
							overage_calls_cost_cents: 0,
							overage_cost_cents: 0,
							api_calls_count: 0,
							api_calls_included: 10_000,
							overage_calls: 0,
							billed_at: null,
							...row,
						},
					],
				}),
			);
		expect(classify({ overage_calls_cost_cents: 100 })).toHaveLength(1);
		expect(classify({ overage_cost_cents: 50 })).toHaveLength(1);
		expect(
			classify({ overage_calls_cost_cents: 100, billed_at: "2026-01-01" }),
		).toEqual([expect.objectContaining({ status: "billed_marker_untrusted" })]);
		expect(classify({ api_calls_count: 10_001 })).toHaveLength(1);
		expect(classify({ posts_count: 1_001 })).toHaveLength(1);
		expect(classify({ overage_calls: 1 })).toHaveLength(1);
		expect(classify({ overage_posts: 1 })).toHaveLength(1);
		expect(classify({})).toEqual([]);
	});

	test("missing relations and any catalog drift fail closed", () => {
		const allRelations = new Map<string, readonly InventoryRow[]>();
		for (const contract of [
			...GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS,
			...GENERATION_ONE_MONEY_BEARING_INVENTORY_CONTRACTS,
		]) {
			allRelations.set(contract.relation, []);
		}
		expect(() =>
			assertInventoryContractRelations(
				allRelations,
				GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS,
				GENERATION_ONE_MONEY_BEARING_INVENTORY_CONTRACTS,
			),
		).not.toThrow();
		allRelations.delete("public.billing_operations");
		expect(() =>
			assertInventoryContractRelations(
				allRelations,
				GENERATION_ONE_PROVIDER_OPERATION_INVENTORY_CONTRACTS,
				GENERATION_ONE_MONEY_BEARING_INVENTORY_CONTRACTS,
			),
		).toThrow("public.billing_operations is absent");
		expect(() => classifyGenerationOneUnsettledUsageBuckets(new Map())).toThrow(
			"usage authority",
		);
		expect(() => classifyGenerationOneLegacyUsageRecords(new Map())).toThrow(
			"legacy usage authority",
		);

		expect(() =>
			assertReviewedGenerationOneCatalog(
				reviewedGenerationOneCatalog,
				reviewedGenerationOneCatalog,
			),
		).not.toThrow();
		const driftedCatalog = buildCatalogFingerprint({
			source: "old-chain",
			generation: 1,
			postgresMajor: reviewedGenerationOneCatalog.postgresMajor,
			migrationManifestSha256:
				reviewedGenerationOneCatalog.migrationManifestSha256,
			objects: [
				...reviewedGenerationOneCatalog.objects,
				{
					kind: "relation",
					identity: "public.unreviewed_money_table",
					definition: "{}",
				},
			],
		});
		expect(() =>
			assertReviewedGenerationOneCatalog(
				driftedCatalog,
				reviewedGenerationOneCatalog,
			),
		).toThrow("does not match reviewed generation-1 evidence");
	});
});

function schemaConfigs() {
	const configs: Array<ReturnType<typeof getTableConfig>> = [];
	for (const value of Object.values(schema)) {
		if (is(value, PgTable)) configs.push(getTableConfig(value));
	}
	return configs;
}

function declaredStates(
	config: ReturnType<typeof getTableConfig>,
	columnName: string,
): string[] {
	const column = config.columns.find(({ name }) => name === columnName);
	if (!column) throw new Error(`${config.name}.${columnName} is missing`);
	if (column.enumValues?.length) return [...column.enumValues].sort();

	const dialect = new PgDialect();
	const escapedColumn = columnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	for (const check of config.checks) {
		const sql = dialect.sqlToQuery(check.value).sql;
		const match = sql.match(
			new RegExp(`\\."${escapedColumn}"\\s+IN\\s+\\(([^)]*)\\)`, "i"),
		);
		if (!match?.[1]) continue;
		return [...match[1].matchAll(/'((?:''|[^'])+)'/g)]
			.map((entry) => entry[1]?.replaceAll("''", "'"))
			.filter((value): value is string => Boolean(value))
			.sort();
	}
	throw new Error(`${config.name}.${columnName} has no explicit state domain`);
}

test("every contracted state exactly covers the current schema domain", () => {
	const expected = new Map<string, Set<string>>();
	for (const sourceContract of PROVIDER_OPERATION_INVENTORY_CONTRACTS) {
		const contract: ProviderOperationInventoryContract = sourceContract;
		const key = `${contract.relation}.${contract.stateKey}`;
		expected.set(
			key,
			new Set([
				...(expected.get(key) ?? []),
				...contract.unresolvedStates,
				...contract.terminalStates,
			]),
		);
	}
	for (const sourceContract of MONEY_BEARING_INVENTORY_CONTRACTS) {
		const contract: MoneyBearingInventoryContract = sourceContract;
		if (!contract.stateKey) continue;
		const key = `${contract.relation}.${contract.stateKey}`;
		expected.set(
			key,
			new Set([
				...(expected.get(key) ?? []),
				...(contract.moneyBearingStates ?? []),
				...(contract.nonMoneyBearingStates ?? []),
			]),
		);
	}

	const configs = new Map(
		schemaConfigs().map((config) => [
			`${config.schema ?? "public"}.${config.name}`,
			config,
		]),
	);
	for (const [key, states] of expected) {
		const separator = key.lastIndexOf(".");
		const relation = key.slice(0, separator);
		const columnName = key.slice(separator + 1);
		const config = configs.get(relation);
		expect(
			config,
			`${relation} must exist in the current schema`,
		).toBeDefined();
		if (!config) continue;
		expect([...states].sort(), key).toEqual(declaredStates(config, columnName));
	}
});

function minimalInventory(
	overrides: Partial<PreliveDatabaseInventory> = {},
): PreliveDatabaseInventory {
	return {
		schemaVersion: 1,
		targetBaselineGeneration: 2,
		database: "relayapi",
		migrationManifestSha256: "a".repeat(64),
		catalog: {
			schemaVersion: 1,
			source: "old-chain",
			generation: 1,
			postgresMajor: 18,
			migrationManifestSha256: "a".repeat(64),
			catalogSha256: "b".repeat(64),
			objects: [],
		},
		tables: [],
		sequences: [],
		moneyBearingReferences: [],
		unresolvedProviderOperations: [],
		...overrides,
	};
}

test("reset lock planning rejects duplicates and sentinel relations", () => {
	expect(
		approvedDatabaseInventoryLockTargets(
			minimalInventory({
				tables: [{ relation: "public.example", rowCount: 0, rowsSha256: "a" }],
				sequences: [
					{
						relation: "drizzle.example_id_seq",
						lastValue: "1",
						isCalled: false,
					},
				],
			}),
		),
	).toEqual({
		tables: ["public.example"],
		sequences: ["drizzle.example_id_seq"],
	});
	expect(() =>
		approvedDatabaseInventoryLockTargets(
			minimalInventory({
				tables: [
					{
						relation: "relayapi_cutover_guard.reset_sentinel",
						rowCount: 1,
						rowsSha256: "a",
					},
				],
			}),
		),
	).toThrow("must exclude sentinel relation");
});

test("reset rejects any non-allowlisted user schema or extension", () => {
	const safe = minimalInventory();
	safe.catalog.objects = [
		{ kind: "schema", identity: "public", definition: "{}" },
		{ kind: "schema", identity: "auth", definition: "{}" },
		{ kind: "schema", identity: "drizzle", definition: "{}" },
		{ kind: "extension", identity: "vector", definition: "{}" },
	];
	expect(() => assertResetCatalogAllowlist(safe)).not.toThrow();

	const unsafe = structuredClone(safe);
	unsafe.catalog.objects.push({
		kind: "schema",
		identity: "forgotten",
		definition: "{}",
	});
	unsafe.catalog.objects.push({
		kind: "extension",
		identity: "unreviewed_extension",
		definition: "{}",
	});
	expect(() => assertResetCatalogAllowlist(unsafe)).toThrow(
		"schema:forgotten, extension:unreviewed_extension",
	);
});

test("database artifact and aggregate manifest digests are independent", () => {
	const source = JSON.stringify(minimalInventory());
	const databaseSha256 = createHash("sha256").update(source).digest("hex");
	const aggregateSha256 = "c".repeat(64);
	expect(
		validateApprovedDatabaseInventoryArtifact(source, {
			databaseInventorySha256: databaseSha256,
			aggregateInventorySha256: aggregateSha256,
		}),
	).toMatchObject({ databaseSha256, aggregateSha256 });
	expect(() =>
		validateApprovedDatabaseInventoryArtifact(source, {
			databaseInventorySha256: aggregateSha256,
			aggregateInventorySha256: aggregateSha256,
		}),
	).toThrow("file bytes do not match");
	expect(() =>
		validateApprovedDatabaseInventoryArtifact(source, {
			databaseInventorySha256: databaseSha256,
			aggregateInventorySha256: "not-a-digest",
		}),
	).toThrow("PRELIVE_APPROVED_INVENTORY_SHA256 must be a SHA-256 digest");
});

test("reset guard exclusion accepts only the exact sentinel schema", () => {
	const expectedObjects = EXPECTED_RESET_GUARD_CATALOG_SIGNATURES.map(
		(signature) => {
			const separator = signature.indexOf(":");
			return {
				kind: signature.slice(0, separator),
				identity: signature.slice(separator + 1),
				definition: "{}",
			};
		},
	);
	expect(
		assertResetGuardCatalogShape(expectedObjects, {
			allowAbsent: false,
			rowCount: 1,
		}),
	).toBe("ready");
	expect(
		assertResetGuardCatalogShape([], {
			allowAbsent: true,
			rowCount: null,
		}),
	).toBe("absent");
	expect(() =>
		assertResetGuardCatalogShape(
			[
				...expectedObjects,
				{
					kind: "relation",
					identity: "relayapi_cutover_guard.hidden_wipe_target",
					definition: "{}",
				},
			],
			{ allowAbsent: false, rowCount: 1 },
		),
	).toThrow("unexpected or missing objects");
	expect(() =>
		assertResetGuardCatalogShape(expectedObjects.slice(1), {
			allowAbsent: false,
			rowCount: 1,
		}),
	).toThrow("unexpected or missing objects");
	expect(() =>
		assertResetGuardCatalogShape(expectedObjects, {
			allowAbsent: false,
			rowCount: 2,
		}),
	).toThrow("exactly one sentinel row");
});

test("terminal reset recaptures under the destructive transaction gate", () => {
	const resetSource = readFileSync(
		new URL("./prelive-reset.ts", import.meta.url),
		"utf8",
	);
	const start = resetSource.indexOf("async function resetSchemas");
	const end = resetSource.indexOf("async function grantRuntime", start);
	const body = resetSource.slice(start, end);
	const positions = [
		"await sql.begin",
		"pg_advisory_xact_lock",
		"assertLiveResetGuardShape",
		"DELETE FROM relayapi_cutover_guard.reset_sentinel",
		"LOCK TABLE ONLY",
		"ALTER SEQUENCE",
		"DROP SCHEMA ",
		"captureDatabaseInventoryOnTransaction",
		"canonicalDatabaseInventory(actual)",
		"DROP EXTENSION IF EXISTS",
		"DROP SCHEMA IF EXISTS public CASCADE",
	].map((needle) => body.indexOf(needle));
	expect(positions.every((position) => position >= 0)).toBe(true);
	expect([...positions].sort((left, right) => left - right)).toEqual(positions);
	expect(body).not.toContain("consumeResetSentinel");
	expect(body).toContain(
		"any later failure rolls the schema\n\t\t// and sentinel row back with this same transaction",
	);

	const inventorySource = readFileSync(
		new URL("./prelive-database-inventory.ts", import.meta.url),
		"utf8",
	);
	expect(inventorySource).toContain(
		'"isolation level repeatable read read only"',
	);
	expect(inventorySource).toContain(
		"changed while the inventory snapshot was captured",
	);
	expect(inventorySource).not.toContain("function isUnresolvedStatus");
});
