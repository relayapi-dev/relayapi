/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import {
	automationEntrypoints,
	automationRuns,
	automationScheduledJobs,
	customFieldDefinitions,
	ideaTags,
	webhookDeliveries,
	webhookLogs,
} from "./schema";

const dialect = new PgDialect();

function columnNames(columns: Array<{ name: string }>): string[] {
	return columns.map((column) => column.name);
}

function checkSql(table: PgTable, name: string): string {
	const check = getTableConfig(table).checks.find(
		(candidate) => candidate.name === name,
	);
	if (!check) throw new Error(`Missing CHECK ${name}`);
	return dialect.sqlToQuery(check.value).sql;
}

describe("pre-freeze construction optimality", () => {
	test("webhook history is one typed row per exact HTTP attempt", () => {
		const config = getTableConfig(webhookLogs);
		expect(columnNames(config.columns)).toEqual(
			expect.arrayContaining([
				"delivery_id",
				"attempt_ordinal",
				"attempt_kind",
				"outcome",
			]),
		);
		expect(columnNames(config.columns)).not.toContain("success");
		expect(webhookLogs.attemptKind.enumValues).toEqual(["delivery", "test"]);
		expect(webhookLogs.outcome.enumValues).toEqual([
			"succeeded",
			"retry_scheduled",
			"failed",
			"unknown",
		]);
		expect(
			config.foreignKeys.map((foreignKey) => ({
				local: columnNames(foreignKey.reference().columns),
				foreign: columnNames(foreignKey.reference().foreignColumns),
				name: foreignKey.reference().name,
			})),
		).toContainEqual({
			local: ["delivery_id", "organization_id"],
			foreign: ["id", "organization_id"],
			name: "webhook_logs_delivery_org_fk",
		});
		expect(
			config.indexes.find(
				(index) => index.config.name === "webhook_logs_delivery_attempt_uniq",
			)?.config.unique,
		).toBe(true);
		expect(
			getTableConfig(webhookDeliveries).uniqueConstraints.map(
				(constraint) => constraint.name,
			),
		).toContain("webhook_deliveries_id_org_uniq");
		const deliveryConfig = getTableConfig(webhookDeliveries);
		expect(columnNames(deliveryConfig.columns)).toContain(
			"manual_review_until",
		);
		expect(columnNames(deliveryConfig.columns)).toContain(
			"operator_retry_requested_at",
		);
		expect(webhookDeliveries.status.enumValues).toContain("unresolved");
		expect(webhookDeliveries.manualReviewReason.enumValues).toEqual([
			"pre_http_repair_exhausted",
			"http_outcome_unknown",
		]);
		expect(deliveryConfig.indexes.map((index) => index.config.name)).toContain(
			"webhook_deliveries_manual_review_expiry_idx",
		);
		const lifecycle = checkSql(
			webhookDeliveries,
			"webhook_deliveries_terminal_completion_check",
		);
		expect(lifecycle).toContain("manual_review_until");
		expect(lifecycle).toContain("repair_deadline_at");
		expect(lifecycle).toContain("request_may_have_been_sent_at");
		expect(lifecycle).toContain("interval '90 days'");
		expect(
			checkSql(webhookDeliveries, "webhook_deliveries_unknown_boundary_check"),
		).toContain("request_may_have_been_sent_at");
		expect(
			checkSql(webhookDeliveries, "webhook_deliveries_lease_state_check"),
		).toContain("lease_expires_at");
		expect(
			checkSql(
				webhookDeliveries,
				"webhook_deliveries_http_attempt_budget_check",
			),
		).toContain("operator_retry_requested_at");
		expect(
			checkSql(
				webhookDeliveries,
				"webhook_deliveries_operator_intervention_check",
			),
		).toContain("operator_intervened_at");
	});

	test("custom-field options are a type-dependent database invariant", () => {
		const sql = checkSql(
			customFieldDefinitions,
			"custom_field_definitions_options_by_type_check",
		);
		expect(sql).toContain("jsonb_array_length");
		expect(sql).toContain("jsonb_path_exists");
		expect(sql).toContain("type");
		expect(sql).toContain("select");
		expect(sql).toContain("options");
	});

	test("idea-tag scope is projected only from the authoritative idea", () => {
		const config = getTableConfig(ideaTags);
		expect(columnNames(config.columns)).not.toContain("workspace_id");
		expect(columnNames(config.columns)).toContain("scope_key");
		expect(
			config.foreignKeys.map((foreignKey) => ({
				local: columnNames(foreignKey.reference().columns),
				name: foreignKey.reference().name,
			})),
		).toContainEqual({
			local: ["idea_id", "organization_id", "scope_key"],
			name: "idea_tags_idea_org_scope_fk",
		});
		expect(
			config.foreignKeys.map((foreignKey) => foreignKey.getName()),
		).not.toContain("idea_tags_workspace_org_fk");
		expect(config.indexes.map((index) => index.config.name)).toContain(
			"idea_tags_org_tag_idea_idx",
		);
	});

	test("entrypoint identity and config validity are tied to kind", () => {
		const sql = checkSql(
			automationEntrypoints,
			"automation_entrypoints_kind_identity_config_check",
		);
		for (const marker of [
			"social_account_id",
			"ref_link_click",
			"schedule",
			"field_keys",
			"tag_ids",
			"event_names",
			"webhook_slug",
			"contact_lookup",
		]) {
			expect(sql).toContain(marker);
		}
		expect(sql).toContain("jsonb_typeof");
	});

	test("scheduled jobs project scope and bind each kind to one parent tuple", () => {
		const config = getTableConfig(automationScheduledJobs);
		const required = new Map(
			config.columns.map((column) => [column.name, column.notNull]),
		);
		expect(required.get("organization_id")).toBe(true);
		expect(required.get("scope_key")).toBe(true);
		expect(required.get("automation_id")).toBe(true);

		const foreignKeys = config.foreignKeys.map((foreignKey) => ({
			local: columnNames(foreignKey.reference().columns),
			foreign: columnNames(foreignKey.reference().foreignColumns),
			name: foreignKey.reference().name,
			onDelete: foreignKey.onDelete,
		}));
		expect(foreignKeys).toEqual(
			expect.arrayContaining([
				{
					local: ["run_id", "automation_id", "organization_id", "scope_key"],
					foreign: ["id", "automation_id", "organization_id", "scope_key"],
					name: "automation_scheduled_jobs_run_auto_org_scope_fk",
					onDelete: "cascade",
				},
				{
					local: [
						"entrypoint_id",
						"automation_id",
						"organization_id",
						"scope_key",
					],
					foreign: ["id", "automation_id", "organization_id", "scope_key"],
					name: "automation_scheduled_jobs_entrypoint_auto_org_scope_fk",
					onDelete: "cascade",
				},
			]),
		);
		const parentUnion = checkSql(
			automationScheduledJobs,
			"automation_scheduled_jobs_parent_union_check",
		);
		expect(parentUnion).toContain("resume_run");
		expect(parentUnion).toContain("internal_event");
		expect(parentUnion).toContain("scheduled_trigger");
		expect(parentUnion).toContain("webhook_reception_failure");
		const internalEventPayload = checkSql(
			automationScheduledJobs,
			"automation_scheduled_jobs_internal_event_payload_check",
		);
		expect(internalEventPayload).toContain("tag_applied");
		expect(internalEventPayload).toContain("tag_removed");
		expect(internalEventPayload).toContain("field_changed");
		expect(internalEventPayload).toContain("event_depth");
		expect(
			getTableConfig(automationRuns).uniqueConstraints.map(
				(constraint) => constraint.name,
			),
		).toContain("automation_runs_id_automation_org_scope_uniq");
	});
});
