/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	adAdvancedResources,
	mediaDerivatives,
	mediaProcessingJobs,
} from "./schema";

function columnNames(columns: readonly { name: string }[]): string[] {
	return columns.map(({ name }) => name);
}

test("media derivatives belong to their exact tenant-scoped processing job", () => {
	const jobConfig = getTableConfig(mediaProcessingJobs);
	expect(jobConfig.uniqueConstraints.map(({ name }) => name)).toContain(
		"media_processing_jobs_id_org_scope_media_uniq",
	);

	const derivativeConfig = getTableConfig(mediaDerivatives);
	const foreignKey = derivativeConfig.foreignKeys.find(
		(candidate) =>
			candidate.reference().name ===
			"media_derivatives_processing_job_org_scope_media_fk",
	);
	expect(foreignKey).toBeDefined();
	if (!foreignKey) throw new Error("Missing tenant-scoped processing-job FK");
	const reference = foreignKey.reference();
	expect(columnNames(reference.columns)).toEqual([
		"processing_job_id",
		"organization_id",
		"scope_key",
		"media_id",
	]);
	expect(columnNames(reference.foreignColumns)).toEqual([
		"id",
		"organization_id",
		"scope_key",
		"media_id",
	]);
});

test("product sets can reference only a same-tenant catalog parent", () => {
	const config = getTableConfig(adAdvancedResources);
	const parentClass = config.columns.find(
		(column) => column.name === "parent_resource_class",
	);
	expect(parentClass?.generated).toBeDefined();

	const foreignKey = config.foreignKeys.find(
		(candidate) =>
			candidate.reference().name ===
			"ad_advanced_resources_parent_org_scope_account_platform_kind_fk",
	);
	expect(foreignKey).toBeDefined();
	if (!foreignKey) throw new Error("Missing tenant-scoped catalog-parent FK");
	const reference = foreignKey.reference();
	expect(columnNames(reference.columns)).toEqual([
		"parent_id",
		"organization_id",
		"scope_key",
		"ad_account_id",
		"platform",
		"parent_resource_class",
	]);
	expect(columnNames(reference.foreignColumns)).toEqual([
		"id",
		"organization_id",
		"scope_key",
		"ad_account_id",
		"platform",
		"kind",
	]);
});
