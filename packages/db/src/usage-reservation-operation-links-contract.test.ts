/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import {
	adCreationOperations,
	adMutationOperations,
	usageReservations,
	whatsappPhoneProvisioningOperations,
	whatsappPhoneReleaseOperations,
} from "./schema";

const dialect = new PgDialect();

const durableOperationLinks: readonly {
	name: string;
	table: PgTable;
	foreignKeyName: string;
	indexName: string;
}[] = [
	{
		name: "ad creation",
		table: adCreationOperations,
		foreignKeyName: "ad_creation_operations_usage_reservation_org_fk",
		indexName: "ad_creation_operations_usage_reservation_uniq",
	},
	{
		name: "ad mutation",
		table: adMutationOperations,
		foreignKeyName: "ad_mutation_operations_usage_reservation_org_fk",
		indexName: "ad_mutation_operations_usage_reservation_uniq",
	},
	{
		name: "WhatsApp phone provisioning",
		table: whatsappPhoneProvisioningOperations,
		foreignKeyName: "wa_phone_provisioning_usage_reservation_org_fk",
		indexName: "wa_phone_provisioning_usage_reservation_uniq",
	},
	{
		name: "WhatsApp phone release",
		table: whatsappPhoneReleaseOperations,
		foreignKeyName: "wa_phone_release_usage_reservation_org_fk",
		indexName: "wa_phone_release_usage_reservation_uniq",
	},
];

describe("durable provider-operation usage reservation provenance", () => {
	for (const operation of durableOperationLinks) {
		it(`${operation.name} binds at most once to a same-organization reservation`, () => {
			const config = getTableConfig(operation.table);
			const reservationColumn = config.columns.find(
				(column) => column.name === "usage_reservation_id",
			);
			expect(reservationColumn).toBeDefined();
			expect(reservationColumn?.notNull).toBe(false);

			const foreignKey = config.foreignKeys.find(
				(candidate) => candidate.reference().name === operation.foreignKeyName,
			);
			expect(foreignKey).toBeDefined();
			if (!foreignKey) throw new Error(`Missing ${operation.foreignKeyName}`);
			const reference = foreignKey.reference();
			expect(reference.columns.map((column) => column.name)).toEqual([
				"usage_reservation_id",
				"organization_id",
			]);
			expect(reference.foreignColumns.map((column) => column.name)).toEqual([
				"id",
				"organization_id",
			]);
			expect(reference.foreignTable).toBe(usageReservations);
			expect(foreignKey.onDelete).toBe("restrict");

			const uniqueIndex = config.indexes.find(
				(index) => index.config.name === operation.indexName,
			);
			expect(uniqueIndex?.config.unique).toBe(true);
			expect(uniqueIndex?.config.columns).toHaveLength(1);
			expect(uniqueIndex?.config.where).toBeDefined();
			if (!uniqueIndex?.config.where) {
				throw new Error(`Missing partial predicate on ${operation.indexName}`);
			}
			const predicate = dialect
				.sqlToQuery(uniqueIndex.config.where)
				.sql.toLowerCase();
			expect(predicate).toContain("usage_reservation_id");
			expect(predicate).toContain("is not null");
		});
	}
});
