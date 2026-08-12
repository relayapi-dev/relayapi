/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import {
	EXECUTABLE_POSTGRES_RETENTION_CONTRACTS,
	HIGH_GROWTH_POSTGRES_RETENTION_CONTRACTS,
	validateExecutablePostgresRetentionContracts,
} from "./executable-retention-contracts";
import { getPrivacyRetentionStore } from "./privacy-retention-registry";
import * as schema from "./schema";
import { POSTGRES_TIMED_RETENTION_STORE_IDS } from "./timed-retention-store-inventory";

const repoRoot = new URL("../../../", import.meta.url).pathname;

function regexEscape(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tableIndexes(): Map<string, Set<string>> {
	return new Map(
		Object.values(schema).flatMap((value) => {
			if (!is(value, PgTable)) return [];
			const table = getTableConfig(value);
			return [
				[
					`postgres:${table.schema ?? "public"}.${table.name}`,
					new Set(
						table.indexes.flatMap((index) =>
							index.config.name ? [index.config.name] : [],
						),
					),
				],
			] as const;
		}),
	);
}

describe("executable PostgreSQL retention contracts", () => {
	test("are complete, uniquely keyed, bounded, and linked to privacy stores", () => {
		expect(validateExecutablePostgresRetentionContracts()).toEqual([]);
		expect(EXECUTABLE_POSTGRES_RETENTION_CONTRACTS.length).toBeGreaterThan(0);

		const storeIds = EXECUTABLE_POSTGRES_RETENTION_CONTRACTS.map(
			(contract) => contract.storeId,
		);
		const handlerIds = EXECUTABLE_POSTGRES_RETENTION_CONTRACTS.map(
			(contract) => contract.handler.id,
		);
		expect(new Set(storeIds).size).toBe(storeIds.length);
		expect(new Set(handlerIds).size).toBe(handlerIds.length);

		for (const contract of EXECUTABLE_POSTGRES_RETENTION_CONTRACTS) {
			const privacyStore = getPrivacyRetentionStore(contract.storeId);
			expect(privacyStore).toBeDefined();
			if (!privacyStore) {
				throw new Error(`Missing privacy store: ${contract.storeId}`);
			}
			expect(contract.holdTreatment).toBe(privacyStore.legalHold);
			expect(contract.batch.rows).toBeLessThanOrEqual(5_000);
			expect(contract.batch.maxPasses).toBeLessThanOrEqual(20);
			expect(contract.batch.orderBy.at(-1)?.trim()).not.toBe("");
			expect(
				contract.horizons.minimize ?? contract.horizons.delete,
			).not.toBeNull();
		}
	});

	test("names real exported handlers, executable tests, and scheduled tasks", async () => {
		for (const contract of EXECUTABLE_POSTGRES_RETENTION_CONTRACTS) {
			const handlerSource = Bun.file(`${repoRoot}${contract.handler.source}`);
			const testSource = Bun.file(`${repoRoot}${contract.handler.testSource}`);
			const cadenceSource = Bun.file(`${repoRoot}${contract.cadence.source}`);
			expect(await handlerSource.exists()).toBe(true);
			expect(await testSource.exists()).toBe(true);
			expect(await cadenceSource.exists()).toBe(true);

			const handlerText = await handlerSource.text();
			expect(handlerText).toMatch(
				new RegExp(
					`export\\s+(?:(?:async\\s+)?function|const|class)\\s+${regexEscape(contract.handler.exportName)}\\b`,
				),
			);
			expect(await testSource.text()).toContain(contract.handler.testMarker);
			const cadenceText = await cadenceSource.text();
			expect(cadenceText).toContain(contract.cadence.taskName);
			expect(cadenceText).toContain(contract.cadence.cron);
		}
	});

	test("pins a real supporting index for every executable drain", () => {
		const indexes = tableIndexes();
		for (const contract of EXECUTABLE_POSTGRES_RETENTION_CONTRACTS) {
			const contractIndexes = [
				{
					indexName: contract.batch.indexName,
					indexStoreId: contract.batch.indexStoreId,
				},
				...(contract.batch.additionalIndexes ?? []),
			];
			for (const index of contractIndexes) {
				const indexStoreId = index.indexStoreId ?? contract.storeId;
				expect(
					indexes.get(indexStoreId)?.has(index.indexName),
					`${contract.storeId} lacks ${index.indexName} on ${indexStoreId}`,
				).toBe(true);
			}
		}
	});

	test("exactly covers the independent timed-store inventory", () => {
		const policyInventory = [...POSTGRES_TIMED_RETENTION_STORE_IDS].sort();
		const executableInventory = EXECUTABLE_POSTGRES_RETENTION_CONTRACTS.map(
			(contract) => contract.storeId,
		).sort();
		expect(executableInventory).toEqual(policyInventory);
	});

	test("rejects duplicate stores and duplicate handler ownership", () => {
		const contract = HIGH_GROWTH_POSTGRES_RETENTION_CONTRACTS[0];
		expect(contract).toBeDefined();
		if (!contract) return;
		expect(
			validateExecutablePostgresRetentionContracts([contract, contract]),
		).toEqual([
			`duplicate retention store: ${contract.storeId}`,
			`duplicate retention handler: ${contract.handler.id}`,
		]);
	});
});
