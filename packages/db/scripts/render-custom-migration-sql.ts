import {
	ORGANIZATION_PROVISIONING_CONTRACT,
	PARENT_IDENTITY_PROJECTION_FUNCTION,
	PARENT_IDENTITY_PROJECTIONS,
	SEGMENT_MEMBER_COUNT_CONTRACT,
	WORKSPACE_REQUIREMENT_CONTRACT,
	workspaceRequirementTriggerName,
} from "../src/provisioning-contracts";
import { renderAuthIdentityInvariantSql } from "./render-auth-identity-invariant-sql";
import { renderAutomationConversionEventInvariantSql } from "./render-automation-conversion-event-invariant-sql";
import { renderBillingPeriodInvariantSql } from "./render-billing-period-invariant-sql";
import { renderContactSubscriptionEventInvariantSql } from "./render-contact-subscription-event-invariant-sql";
import { renderErasureHoldInvariantSql } from "./render-erasure-hold-invariant-sql";
import { renderFinancialRetentionReceiptInvariantSql } from "./render-financial-retention-receipt-invariant-sql";
import { renderOperatorResolutionEvidenceInvariantSql } from "./render-operator-resolution-evidence-invariant-sql";
import { renderStorageLocationInvariantSql } from "./render-storage-location-invariant-sql";
import { renderStripeEventAttributionInvariantSql } from "./render-stripe-event-attribution-invariant-sql";
import { renderUsageBucketProjectionSql } from "./render-usage-bucket-projection-sql";

export const CUSTOM_MIGRATION_SQL_MARKER =
	"-- RelayAPI non-declarative database contracts (generated).";

function identifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function qualified(schema: string, name: string): string {
	return `${identifier(schema)}.${identifier(name)}`;
}

const provisioning = ORGANIZATION_PROVISIONING_CONTRACT;
const projectionFunction = PARENT_IDENTITY_PROJECTION_FUNCTION;
const segmentCount = SEGMENT_MEMBER_COUNT_CONTRACT;
const workspaceRequirement = WORKSPACE_REQUIREMENT_CONTRACT;
const statementBreak = "--> statement-breakpoint";

const sql: string[] = [
	statementBreak,
	CUSTOM_MIGRATION_SQL_MARKER,
	"-- Append this output after the Drizzle-generated baseline objects.",
	"",
	`CREATE OR REPLACE FUNCTION ${qualified(provisioning.functionSchema, provisioning.functionName)}()`,
	"RETURNS trigger",
	"LANGUAGE plpgsql",
	"SET search_path = pg_catalog, public, auth",
	"AS $relay_provision_organization$",
	"BEGIN",
	`\tINSERT INTO public.${identifier(provisioning.settingsTable)} (organization_id)`,
	"\tVALUES (NEW.id)",
	"\tON CONFLICT (organization_id) DO NOTHING;",
	"",
	`\tINSERT INTO public.${identifier(provisioning.workspaceTable)} (id, organization_id, name, slug, lifecycle_status)`,
	`\tSELECT 'ws_' || replace(gen_random_uuid()::text, '-', ''), NEW.id, ${literal(provisioning.initialWorkspaceName)}, ${literal(provisioning.initialWorkspaceSlug)}, 'active'`,
	"\tWHERE NOT EXISTS (",
	`\t\tSELECT 1 FROM public.${identifier(provisioning.workspaceTable)}`,
	"\t\tWHERE organization_id = NEW.id",
	"\t);",
	"",
	`\tINSERT INTO public.${identifier(provisioning.ideaGroupTable)} (id, organization_id, workspace_id, name, position, is_default, revision)`,
	`\tVALUES ('idg_' || replace(gen_random_uuid()::text, '-', ''), NEW.id, NULL, ${literal(provisioning.defaultIdeaGroupName)}, 0, true, 0)`,
	"\tON CONFLICT DO NOTHING;",
	"",
	"\tRETURN NEW;",
	"END;",
	"$relay_provision_organization$;",
	statementBreak,
	"",
	`DROP TRIGGER IF EXISTS ${identifier(provisioning.triggerName)} ON ${qualified(provisioning.organizationSchema, provisioning.organizationTable)};`,
	statementBreak,
	`CREATE TRIGGER ${identifier(provisioning.triggerName)}`,
	`AFTER INSERT ON ${qualified(provisioning.organizationSchema, provisioning.organizationTable)}`,
	"FOR EACH ROW",
	`EXECUTE FUNCTION ${qualified(provisioning.functionSchema, provisioning.functionName)}();`,
	statementBreak,
	"",
	`INSERT INTO public.${identifier(provisioning.settingsTable)} (organization_id)`,
	`SELECT id FROM ${qualified(provisioning.organizationSchema, provisioning.organizationTable)}`,
	"ON CONFLICT (organization_id) DO NOTHING;",
	statementBreak,
	"",
	`INSERT INTO public.${identifier(provisioning.workspaceTable)} (id, organization_id, name, slug, lifecycle_status)`,
	`SELECT 'ws_' || replace(gen_random_uuid()::text, '-', ''), organization_row.id, ${literal(provisioning.initialWorkspaceName)}, ${literal(provisioning.initialWorkspaceSlug)}, 'active'`,
	`FROM ${qualified(provisioning.organizationSchema, provisioning.organizationTable)} AS organization_row`,
	"WHERE NOT EXISTS (",
	`\tSELECT 1 FROM public.${identifier(provisioning.workspaceTable)} AS workspace_row`,
	"\tWHERE workspace_row.organization_id = organization_row.id",
	");",
	statementBreak,
	"",
	`INSERT INTO public.${identifier(provisioning.ideaGroupTable)} (id, organization_id, workspace_id, name, position, is_default, revision)`,
	`SELECT 'idg_' || replace(gen_random_uuid()::text, '-', ''), organization_row.id, NULL, ${literal(provisioning.defaultIdeaGroupName)},`,
	`\tCOALESCE((SELECT MAX(group_row.position) + 1 FROM public.${identifier(provisioning.ideaGroupTable)} AS group_row WHERE group_row.organization_id = organization_row.id AND group_row.workspace_id IS NULL), 0),`,
	"\ttrue, 0",
	`FROM ${qualified(provisioning.organizationSchema, provisioning.organizationTable)} AS organization_row`,
	"WHERE NOT EXISTS (",
	`\tSELECT 1 FROM public.${identifier(provisioning.ideaGroupTable)} AS default_group`,
	"\tWHERE default_group.organization_id = organization_row.id",
	"\t\tAND default_group.workspace_id IS NULL",
	"\t\tAND default_group.is_default = true",
	");",
	statementBreak,
	"",
	`CREATE OR REPLACE FUNCTION ${qualified(projectionFunction.functionSchema, projectionFunction.functionName)}()`,
	"RETURNS trigger",
	"LANGUAGE plpgsql",
	"SET search_path = pg_catalog, public",
	"AS $relay_project_parent$",
	"DECLARE",
	"\tparent_id text;",
	"\tparent_row jsonb;",
	"\tprojected_values jsonb := '{}'::jsonb;",
	"\tmapping text;",
	"\tparent_column text;",
	"\tchild_column text;",
	"BEGIN",
	"\tparent_id := to_jsonb(NEW) ->> TG_ARGV[1];",
	"\tIF parent_id IS NULL OR parent_id = '' THEN",
	"\t\tRAISE EXCEPTION USING",
	"\t\t\tERRCODE = '23502',",
	"\t\t\tMESSAGE = format('%s.%s must identify its %s parent', TG_TABLE_NAME, TG_ARGV[1], TG_ARGV[0]);",
	"\tEND IF;",
	"",
	"\tEXECUTE format(",
	"\t\t'SELECT to_jsonb(parent_row) FROM public.%I AS parent_row WHERE parent_row.id = $1 AND parent_row.organization_id = $2',",
	"\t\tTG_ARGV[0]",
	"\t)",
	"\tINTO parent_row",
	"\tUSING parent_id, NEW.organization_id;",
	"",
	"\tIF parent_row IS NULL THEN",
	"\t\tRAISE EXCEPTION USING",
	"\t\t\tERRCODE = '23503',",
	"\t\t\tMESSAGE = format('parent public.%s(%s, %s) does not exist', TG_ARGV[0], parent_id, NEW.organization_id);",
	"\tEND IF;",
	"",
	"\tFOREACH mapping IN ARRAY string_to_array(TG_ARGV[2], ',') LOOP",
	"\t\tparent_column := split_part(mapping, ':', 1);",
	"\t\tchild_column := split_part(mapping, ':', 2);",
	"\t\tIF parent_column = '' OR child_column = '' OR NOT (parent_row ? parent_column) THEN",
	"\t\t\tRAISE EXCEPTION 'invalid parent identity projection: %', mapping;",
	"\t\tEND IF;",
	"\t\tprojected_values := projected_values || jsonb_build_object(",
	"\t\t\tchild_column,",
	"\t\t\tparent_row -> parent_column",
	"\t\t);",
	"\tEND LOOP;",
	"",
	"\tNEW := jsonb_populate_record(NEW, projected_values);",
	"\tRETURN NEW;",
	"END;",
	"$relay_project_parent$;",
	statementBreak,
	"",
];

for (const contract of PARENT_IDENTITY_PROJECTIONS) {
	const projectionArgument = contract.projections
		.map(({ parentColumn, childColumn }) => `${parentColumn}:${childColumn}`)
		.join(",");
	const watchedColumns = [
		contract.childParentColumn,
		"organization_id",
		...contract.projections.map(({ childColumn }) => childColumn),
	];
	const uniqueWatchedColumns = [...new Set(watchedColumns)];

	sql.push(
		`DROP TRIGGER IF EXISTS ${identifier(contract.triggerName)} ON public.${identifier(contract.childTable)};`,
		statementBreak,
		`CREATE TRIGGER ${identifier(contract.triggerName)}`,
		`BEFORE INSERT OR UPDATE OF ${uniqueWatchedColumns.map(identifier).join(", ")}`,
		`ON public.${identifier(contract.childTable)}`,
		"FOR EACH ROW",
		`EXECUTE FUNCTION ${qualified(projectionFunction.functionSchema, projectionFunction.functionName)}(${literal(contract.parentTable)}, ${literal(contract.childParentColumn)}, ${literal(projectionArgument)});`,
		statementBreak,
		"",
	);
}

sql.push(
	`CREATE OR REPLACE FUNCTION ${qualified(workspaceRequirement.functionSchema, workspaceRequirement.functionName)}()`,
	"RETURNS trigger",
	"LANGUAGE plpgsql",
	"SET search_path = pg_catalog, public",
	"AS $relay_require_workspace$",
	"DECLARE",
	"\trequire_workspace boolean;",
	"\tworkspace_state text;",
	"\tinactive_row boolean;",
	"BEGIN",
	"\tinactive_row := TG_NARGS >= 2",
	"\t\tAND TG_ARGV[0] <> ''",
	"\t\tAND (to_jsonb(NEW) ->> TG_ARGV[0]) = ANY(string_to_array(TG_ARGV[1], ','));",
	"",
	"\tIF inactive_row AND TG_OP = 'UPDATE' THEN",
	"\t\tIF NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id",
	"\t\t\tAND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id",
	"\t\tTHEN",
	"\t\t\tRETURN NEW;",
	"\t\tEND IF;",
	"\tEND IF;",
	"",
	"\tIF NEW.workspace_id IS NOT NULL THEN",
	"\t\tSELECT workspace_row.lifecycle_status",
	"\t\tINTO workspace_state",
	`\t\tFROM public.${identifier(workspaceRequirement.workspaceTable)} AS workspace_row`,
	"\t\tWHERE workspace_row.id = NEW.workspace_id",
	"\t\t\tAND workspace_row.organization_id = NEW.organization_id",
	"\t\tFOR SHARE;",
	"",
	"\t\tIF NOT FOUND THEN",
	"\t\t\tRAISE EXCEPTION USING",
	"\t\t\t\tERRCODE = '23503',",
	"\t\t\t\tMESSAGE = format('workspace %s does not belong to organization %s', NEW.workspace_id, NEW.organization_id);",
	"\t\tEND IF;",
	`\t\tIF workspace_state <> ${literal(workspaceRequirement.activeWorkspaceState)} THEN`,
	"\t\t\tRAISE EXCEPTION USING",
	"\t\t\t\tERRCODE = '23514',",
	"\t\t\t\tMESSAGE = format('workspace %s is not active', NEW.workspace_id);",
	"\t\tEND IF;",
	"\t\tRETURN NEW;",
	"\tEND IF;",
	"",
	`\tSELECT settings_row.${identifier(workspaceRequirement.settingsColumn)}`,
	"\tINTO require_workspace",
	`\tFROM public.${identifier(workspaceRequirement.settingsTable)} AS settings_row`,
	"\tWHERE settings_row.organization_id = NEW.organization_id",
	"\tFOR SHARE;",
	"",
	"\tIF NOT FOUND THEN",
	"\t\tRAISE EXCEPTION USING",
	"\t\t\tERRCODE = '23503',",
	"\t\t\tMESSAGE = format('organization %s has no organization_settings row', NEW.organization_id);",
	"\tEND IF;",
	"",
	"\tIF require_workspace THEN",
	"\t\tRAISE EXCEPTION USING",
	"\t\t\tERRCODE = '23514',",
	"\t\t\tMESSAGE = format('%s.workspace_id is required by organization policy', TG_TABLE_NAME);",
	"\tEND IF;",
	"",
	"\tRETURN NEW;",
	"END;",
	"$relay_require_workspace$;",
	statementBreak,
	"",
);

for (const tableName of workspaceRequirement.tables) {
	const inactiveState = workspaceRequirement.inactiveStates[tableName];
	const parentColumns = PARENT_IDENTITY_PROJECTIONS.filter(
		(contract) =>
			contract.childTable === tableName &&
			contract.projections.some(
				({ childColumn }) => childColumn === "workspace_id",
			),
	).map(({ childParentColumn }) => childParentColumn);
	const watchedColumns = [
		"workspace_id",
		"organization_id",
		...parentColumns,
		...(inactiveState ? [inactiveState.column] : []),
	];
	const triggerName = workspaceRequirementTriggerName(tableName);

	sql.push(
		`DROP TRIGGER IF EXISTS ${identifier(triggerName)} ON public.${identifier(tableName)};`,
		statementBreak,
		`CREATE TRIGGER ${identifier(triggerName)}`,
		`BEFORE INSERT OR UPDATE OF ${[...new Set(watchedColumns)].map(identifier).join(", ")}`,
		`ON public.${identifier(tableName)}`,
		"FOR EACH ROW",
		`EXECUTE FUNCTION ${qualified(workspaceRequirement.functionSchema, workspaceRequirement.functionName)}(${literal(inactiveState?.column ?? "")}, ${literal(inactiveState?.values.join(",") ?? "")});`,
		statementBreak,
		"",
	);
}

sql.push(
	`CREATE OR REPLACE FUNCTION ${qualified(segmentCount.functionSchema, segmentCount.functionName)}()`,
	"RETURNS trigger",
	"LANGUAGE plpgsql",
	"SET search_path = pg_catalog, public",
	"AS $relay_segment_member_count$",
	"BEGIN",
	"\tIF TG_OP = 'INSERT' THEN",
	`\t\tUPDATE public.${identifier(segmentCount.segmentTable)}`,
	"\t\tSET member_count = member_count + 1",
	"\t\tWHERE id = NEW.segment_id;",
	"\t\tRETURN NEW;",
	"\tELSIF TG_OP = 'DELETE' THEN",
	`\t\tUPDATE public.${identifier(segmentCount.segmentTable)}`,
	"\t\tSET member_count = member_count - 1",
	"\t\tWHERE id = OLD.segment_id;",
	"\t\tRETURN OLD;",
	"\tELSIF OLD.segment_id IS DISTINCT FROM NEW.segment_id THEN",
	`\t\tUPDATE public.${identifier(segmentCount.segmentTable)}`,
	"\t\tSET member_count = member_count - 1",
	"\t\tWHERE id = OLD.segment_id;",
	`\t\tUPDATE public.${identifier(segmentCount.segmentTable)}`,
	"\t\tSET member_count = member_count + 1",
	"\t\tWHERE id = NEW.segment_id;",
	"\tEND IF;",
	"\tRETURN NEW;",
	"END;",
	"$relay_segment_member_count$;",
	statementBreak,
	"",
	`DROP TRIGGER IF EXISTS ${identifier(segmentCount.triggerName)} ON public.${identifier(segmentCount.membershipTable)};`,
	statementBreak,
	`CREATE TRIGGER ${identifier(segmentCount.triggerName)}`,
	"AFTER INSERT OR DELETE OR UPDATE OF segment_id",
	`ON public.${identifier(segmentCount.membershipTable)}`,
	"FOR EACH ROW",
	`EXECUTE FUNCTION ${qualified(segmentCount.functionSchema, segmentCount.functionName)}();`,
	statementBreak,
	"",
	`UPDATE public.${identifier(segmentCount.segmentTable)} AS segment_row`,
	"SET member_count = (",
	"\tSELECT count(*)::integer",
	`\tFROM public.${identifier(segmentCount.membershipTable)} AS membership_row`,
	"\tWHERE membership_row.segment_id = segment_row.id",
	");",
	statementBreak,
	"",
);

export function renderCustomMigrationSql(): string {
	return `${sql.join("\n")}\n${renderAuthIdentityInvariantSql()}\n${renderErasureHoldInvariantSql()}\n${renderContactSubscriptionEventInvariantSql()}\n${renderOperatorResolutionEvidenceInvariantSql()}\n${renderFinancialRetentionReceiptInvariantSql()}\n${renderBillingPeriodInvariantSql()}\n${renderStorageLocationInvariantSql()}\n${renderUsageBucketProjectionSql()}\n${renderAutomationConversionEventInvariantSql()}\n${renderStripeEventAttributionInvariantSql()}`;
}

if (import.meta.main) {
	process.stdout.write(renderCustomMigrationSql());
}
