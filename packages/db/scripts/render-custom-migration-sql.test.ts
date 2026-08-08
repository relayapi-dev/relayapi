/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
	AUTH_IDENTITY_INVARIANT_CONTRACTS,
	ORGANIZATION_PROVISIONING_CONTRACT,
	PARENT_IDENTITY_PROJECTION_FUNCTION,
	PARENT_IDENTITY_PROJECTIONS,
	SEGMENT_MEMBER_COUNT_CONTRACT,
	WORKSPACE_REQUIREMENT_CONTRACT,
	workspaceRequirementTriggerName,
} from "../src/provisioning-contracts";
import { renderCustomMigrationSql } from "./render-custom-migration-sql";
import { STRIPE_EVENT_ATTRIBUTION_INVARIANT_CONTRACT } from "./render-stripe-event-attribution-invariant-sql";

const sql = renderCustomMigrationSql();

describe("inline custom migration SQL contracts", () => {
	test("renders organization provisioning with the current required workspace shape", () => {
		const contract = ORGANIZATION_PROVISIONING_CONTRACT;
		expect(sql).toContain(
			`CREATE OR REPLACE FUNCTION "${contract.functionSchema}"."${contract.functionName}"()`,
		);
		expect(sql).toContain(
			`INSERT INTO public."${contract.workspaceTable}" (id, organization_id, name, slug, lifecycle_status)`,
		);
		expect(sql).toContain(`'${contract.initialWorkspaceSlug}'`);
		expect(sql).toContain(`CREATE TRIGGER "${contract.triggerName}"`);
		expect(sql).toContain(
			`INSERT INTO public."${contract.ideaGroupTable}" (id, organization_id, workspace_id, name, position, is_default, revision)`,
		);
	});

	test("renders every parent-identity projection from the canonical registry", () => {
		const projection = PARENT_IDENTITY_PROJECTION_FUNCTION;
		expect(sql).toContain(
			`CREATE OR REPLACE FUNCTION "${projection.functionSchema}"."${projection.functionName}"()`,
		);
		for (const contract of PARENT_IDENTITY_PROJECTIONS) {
			const mapping = contract.projections
				.map(
					({ parentColumn, childColumn }) => `${parentColumn}:${childColumn}`,
				)
				.join(",");
			expect(sql).toContain(`CREATE TRIGGER "${contract.triggerName}"`);
			expect(sql).toContain(`ON public."${contract.childTable}"`);
			expect(sql).toContain(
				`'${contract.parentTable}', '${contract.childParentColumn}', '${mapping}'`,
			);
		}
	});

	test("renders every workspace-requirement trigger from the canonical registry", () => {
		const contract = WORKSPACE_REQUIREMENT_CONTRACT;
		expect(sql).toContain(
			`CREATE OR REPLACE FUNCTION "${contract.functionSchema}"."${contract.functionName}"()`,
		);
		expect(sql).toContain(
			`FROM public."${contract.workspaceTable}" AS workspace_row`,
		);
		expect(sql).toContain(`SELECT settings_row."${contract.settingsColumn}"`);
		for (const tableName of contract.tables) {
			expect(sql).toContain(
				`CREATE TRIGGER "${workspaceRequirementTriggerName(tableName)}"`,
			);
			expect(sql).toContain(`ON public."${tableName}"`);
		}
	});

	test("renders the segment member-count trigger and deterministic backfill", () => {
		const contract = SEGMENT_MEMBER_COUNT_CONTRACT;
		expect(sql).toContain(
			`CREATE OR REPLACE FUNCTION "${contract.functionSchema}"."${contract.functionName}"()`,
		);
		expect(sql).toContain(`CREATE TRIGGER "${contract.triggerName}"`);
		expect(sql).toContain("SET member_count = member_count + 1");
		expect(sql).toContain("SET member_count = member_count - 1");
		expect(sql).toContain(
			`UPDATE public."${contract.segmentTable}" AS segment_row`,
		);
		expect(sql).toContain(
			`FROM public."${contract.membershipTable}" AS membership_row`,
		);
	});

	test("renders immutable Stripe event tenant attribution", () => {
		const contract = STRIPE_EVENT_ATTRIBUTION_INVARIANT_CONTRACT;
		expect(sql).toContain(
			`CREATE OR REPLACE FUNCTION "${contract.functionSchema}"."${contract.functionName}"()`,
		);
		expect(sql).toContain(`CREATE TRIGGER "${contract.triggerName}"`);
		expect(sql).toContain(
			"Stripe event organization attribution is immutable once set",
		);
	});

	test("emits administrator impersonation revocation into baseline SQL", () => {
		const contract =
			AUTH_IDENTITY_INVARIANT_CONTRACTS.administratorImpersonationRevocation;
		const sessionContract =
			AUTH_IDENTITY_INVARIANT_CONTRACTS.originatingSessionImpersonationRevocation;
		expect(sql).toContain(
			`CREATE OR REPLACE FUNCTION "${contract.functionSchema}"."${contract.functionName}"()`,
		);
		expect(sql).toContain(`CREATE TRIGGER "${contract.triggerName}"`);
		expect(sql).toContain(
			`CREATE OR REPLACE FUNCTION "${sessionContract.functionSchema}"."${sessionContract.functionName}"()`,
		);
		expect(sql).toContain(`CREATE TRIGGER "${sessionContract.triggerName}"`);
		expect(sql).toContain('AFTER DELETE ON "auth"."session"');
		expect(sql).toContain('IF OLD."impersonatedBy" IS NOT NULL THEN');
		expect(sql).toContain(
			'WHERE impersonation_session."impersonatedBy" IS NOT NULL',
		);
	});
});
