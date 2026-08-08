import { is, SQL } from "drizzle-orm";
import {
	getTableConfig,
	isPgEnum,
	PgDialect,
	PgTable,
} from "drizzle-orm/pg-core";
import postgres from "postgres";
import { REQUIRED_DATABASE_EXTENSION_VERSIONS } from "../src/database-prerequisites";
import {
	AUTH_IDENTITY_INVARIANT_CONTRACTS,
	ORGANIZATION_PROVISIONING_CONTRACT,
	PARENT_IDENTITY_PROJECTION_FUNCTION,
	PARENT_IDENTITY_PROJECTIONS,
	SEGMENT_MEMBER_COUNT_CONTRACT,
	WORKSPACE_REQUIREMENT_CONTRACT,
	workspaceRequirementTriggerName,
} from "../src/provisioning-contracts";
import * as schema from "../src/schema";
import { USAGE_BUCKET_PROJECTION_CONTRACT } from "../src/usage-projection-contract";
import { renderAuthIdentityInvariantSql } from "./render-auth-identity-invariant-sql";
import {
	AUTOMATION_CONVERSION_EVENT_FACT_CONTRACT,
	renderAutomationConversionEventInvariantSql,
} from "./render-automation-conversion-event-invariant-sql";
import {
	REQUIRED_BASELINE_EXTENSION_SCHEMAS,
	REQUIRED_BASELINE_EXTENSIONS,
	REQUIRED_BASELINE_SCHEMAS,
} from "./render-baseline-preamble-sql";
import {
	CONTACT_SUBSCRIPTION_EVENT_APPEND_ONLY_CONTRACT,
	renderContactSubscriptionEventInvariantSql,
} from "./render-contact-subscription-event-invariant-sql";
import { renderCustomMigrationSql } from "./render-custom-migration-sql";
import {
	FINANCIAL_RETENTION_RECEIPT_IMMUTABILITY_CONTRACT,
	renderFinancialRetentionReceiptInvariantSql,
} from "./render-financial-retention-receipt-invariant-sql";
import {
	OPERATOR_RESOLUTION_EVIDENCE_APPEND_ONLY_CONTRACT,
	renderOperatorResolutionEvidenceInvariantSql,
} from "./render-operator-resolution-evidence-invariant-sql";

const connectionString = (
	globalThis as typeof globalThis & {
		process?: { env?: Record<string, string | undefined> };
	}
).process?.env?.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;

if (!connectionString) {
	throw new Error(
		"CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE is not set",
	);
}

const databaseUrl: string = connectionString;

type CatalogTable = {
	schemaName: string;
	tableName: string;
	columns: CatalogColumn[];
};

type CatalogColumn = {
	name: string;
	type: string;
	notNull: boolean;
	defaultExpression: string | null;
	generatedExpression: string | null;
	generatedKind: "" | "s";
	identityKind: "" | "a" | "d";
};

type ActualCatalogRow = {
	schema_name: string;
	table_name: string;
	column_name: string;
	ordinal_position: number;
	formatted_type: string;
	not_null: boolean;
	default_expression: string | null;
	generated_expression: string | null;
	generated_kind: "" | "s";
	identity_kind: "" | "a" | "d";
};

type ExtensionCatalogRow = {
	extension_name: string;
	extension_schema: string;
	extension_version: string;
};

type IndexColumnDefinition = {
	expression: string;
	order: "asc" | "desc";
	nulls: "first" | "last";
	opClass: string | null;
};

type ExpectedIndex = {
	schemaName: string;
	tableName: string;
	name: string;
	unique: boolean;
	method: string;
	columns: IndexColumnDefinition[];
	predicate: string | null;
	storageParameters: string[];
};

type ActualIndex = {
	schema_name: string;
	table_name: string;
	index_name: string;
	unique: boolean;
	valid: boolean;
	ready: boolean;
	live: boolean;
	method: string;
	key_column_count: number;
	total_column_count: number;
	column_expressions: string[];
	column_orders: Array<"asc" | "desc">;
	column_nulls: Array<"first" | "last">;
	column_opclasses: Array<string | null>;
	predicate: string | null;
	storage_parameters: string[];
};

type ExpectedConstraint = {
	schemaName: string;
	tableName: string;
	name: string;
	type: "c" | "f" | "p" | "u";
	columns: string[];
	foreignSchema: string | null;
	foreignTable: string | null;
	foreignColumns: string[];
	onUpdate: string | null;
	onDelete: string | null;
	matchType: string | null;
	nullsNotDistinct: boolean;
	deferrable: boolean;
	initiallyDeferred: boolean;
	checkExpression: string | null;
	rawCheckExpression?: string;
};

type ActualConstraint = {
	schema_name: string;
	table_name: string;
	constraint_name: string;
	type: "c" | "f" | "p" | "u";
	validated: boolean;
	columns: string[];
	foreign_schema: string | null;
	foreign_table: string | null;
	foreign_columns: string[];
	on_update: string | null;
	on_delete: string | null;
	match_type: string | null;
	nulls_not_distinct: boolean;
	deferrable: boolean;
	initially_deferred: boolean;
	check_expression: string | null;
};

type AutomationTableRow = {
	relkind: string;
	relispartition: boolean;
	parent_count: number;
	child_count: number;
};

type AutomationPrimaryKeyRow = {
	column_names: string[];
};

type AutomationIdRow = {
	data_type: string;
	is_nullable: "YES" | "NO";
	column_default: string | null;
};

type IndexDefinitionRow = {
	indexname: string;
	indexdef: string;
};

type EnumValueRow = {
	schema_name: string;
	type_name: string;
	values: string[];
};

type DatabaseContractTriggerRow = {
	trigger_name: string;
	trigger_enabled: string;
	trigger_type: number;
	is_constraint_trigger: boolean;
	is_deferrable: boolean;
	initially_deferred: boolean;
	has_parent_trigger: boolean;
	old_transition_table: string | null;
	new_transition_table: string | null;
	trigger_argument_count: number;
	trigger_arguments_hex: string;
	has_when_predicate: boolean;
	watched_columns: string[];
	table_schema: string;
	table_name: string;
	function_schema: string;
	function_name: string;
	function_identity_arguments: string;
};

type GeneratedFunctionRow = {
	function_schema: string;
	function_name: string;
	identity_arguments: string;
	return_type: string;
	argument_count: number;
	language_name: string;
	function_kind: string;
	volatility: string;
	is_strict: boolean;
	security_definer: boolean;
	leakproof: boolean;
	parallel_safety: string;
	function_config: string[];
	function_source: string;
};

type OrganizationProvisioningCoverageRow = {
	settings_missing: number;
	workspaces_missing: number;
	default_idea_groups_missing: number;
};

type ExpectedDatabaseTrigger = {
	triggerName: string;
	tableSchema: string;
	tableName: string;
	functionSchema: string;
	functionName: string;
	triggerType: number;
	watchedColumns: string[];
	arguments: string[];
	oldTransitionTable?: string;
	newTransitionTable?: string;
	isConstraintTrigger?: boolean;
	isDeferrable?: boolean;
	isInitiallyDeferred?: boolean;
};

type ExpectedGeneratedFunction = {
	functionSchema: string;
	functionName: string;
	functionConfig: string[];
	functionSource: string;
};

type SegmentMemberCountCoverageRow = {
	mismatched: number;
};

type NonDrizzleRelationRow = {
	schema_name: string;
	relation_name: string;
	relation_kind: "v" | "m";
};

type RowPolicyRow = {
	schema_name: string;
	table_name: string;
	policy_name: string;
};

export function nonDrizzleDdlRegistry() {
	return {
		routines: expectedGeneratedFunctions().map(
			(contract) => `${contract.functionSchema}.${contract.functionName}()`,
		),
		triggers: expectedDatabaseTriggers().map(databaseTriggerKey),
		views: [] as string[],
		materializedViews: [] as string[],
		policies: [] as string[],
	};
}

type ExpectedEnum = {
	schemaName: string;
	typeName: string;
	values: string[];
};

// PostgreSQL pg_trigger.tgtype bit flags (src/include/commands/trigger.h).
// Comparing the complete bitmask rejects statement-level, INSTEAD OF,
// TRUNCATE, and extra-event variants rather than accepting a textual subset.
const TRIGGER_TYPE_ROW = 1;
const TRIGGER_TYPE_BEFORE = 2;
const TRIGGER_TYPE_INSERT = 4;
const TRIGGER_TYPE_DELETE = 8;
const TRIGGER_TYPE_UPDATE = 16;
const BEFORE_INSERT_ROW =
	TRIGGER_TYPE_ROW | TRIGGER_TYPE_BEFORE | TRIGGER_TYPE_INSERT;
const BEFORE_INSERT_OR_UPDATE_ROW =
	TRIGGER_TYPE_ROW |
	TRIGGER_TYPE_BEFORE |
	TRIGGER_TYPE_INSERT |
	TRIGGER_TYPE_UPDATE;
const AFTER_INSERT_ROW = TRIGGER_TYPE_ROW | TRIGGER_TYPE_INSERT;
const AFTER_INSERT_OR_UPDATE_ROW =
	TRIGGER_TYPE_ROW | TRIGGER_TYPE_INSERT | TRIGGER_TYPE_UPDATE;
const BEFORE_DELETE_ROW =
	TRIGGER_TYPE_ROW | TRIGGER_TYPE_BEFORE | TRIGGER_TYPE_DELETE;
const BEFORE_UPDATE_ROW =
	TRIGGER_TYPE_ROW | TRIGGER_TYPE_BEFORE | TRIGGER_TYPE_UPDATE;
const BEFORE_DELETE_OR_UPDATE_ROW =
	TRIGGER_TYPE_ROW |
	TRIGGER_TYPE_BEFORE |
	TRIGGER_TYPE_DELETE |
	TRIGGER_TYPE_UPDATE;
const AFTER_DELETE_ROW = TRIGGER_TYPE_ROW | TRIGGER_TYPE_DELETE;
const AFTER_DELETE_OR_UPDATE_ROW =
	TRIGGER_TYPE_ROW | TRIGGER_TYPE_DELETE | TRIGGER_TYPE_UPDATE;
const BEFORE_INSERT_DELETE_OR_UPDATE_ROW =
	TRIGGER_TYPE_ROW |
	TRIGGER_TYPE_BEFORE |
	TRIGGER_TYPE_INSERT |
	TRIGGER_TYPE_DELETE |
	TRIGGER_TYPE_UPDATE;
const AFTER_INSERT_DELETE_OR_UPDATE_ROW =
	TRIGGER_TYPE_ROW |
	TRIGGER_TYPE_INSERT |
	TRIGGER_TYPE_DELETE |
	TRIGGER_TYPE_UPDATE;
const AFTER_INSERT_STATEMENT = TRIGGER_TYPE_INSERT;
const AFTER_UPDATE_STATEMENT = TRIGGER_TYPE_UPDATE;
const AFTER_DELETE_STATEMENT = TRIGGER_TYPE_DELETE;

function uniqueValues(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function encodeTriggerArguments(values: readonly string[]): string {
	const bytes = new TextEncoder().encode(
		values.length === 0 ? "" : `${values.join("\0")}\0`,
	);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expectedDatabaseTriggers(): ExpectedDatabaseTrigger[] {
	const provisioning = ORGANIZATION_PROVISIONING_CONTRACT;
	const projectionFunction = PARENT_IDENTITY_PROJECTION_FUNCTION;
	const workspaceRequirement = WORKSPACE_REQUIREMENT_CONTRACT;
	const segmentCount = SEGMENT_MEMBER_COUNT_CONTRACT;
	const expected: ExpectedDatabaseTrigger[] = [
		{
			triggerName: provisioning.triggerName,
			tableSchema: provisioning.organizationSchema,
			tableName: provisioning.organizationTable,
			functionSchema: provisioning.functionSchema,
			functionName: provisioning.functionName,
			triggerType: AFTER_INSERT_ROW,
			watchedColumns: [],
			arguments: [],
		},
		{
			triggerName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.activeOrganizationOwner.triggerName,
			tableSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.activeOrganizationOwner.tableSchema,
			tableName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.activeOrganizationOwner.tableName,
			functionSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.activeOrganizationOwner
					.functionSchema,
			functionName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.activeOrganizationOwner.functionName,
			triggerType: AFTER_INSERT_OR_UPDATE_ROW,
			watchedColumns: [
				...AUTH_IDENTITY_INVARIANT_CONTRACTS.activeOrganizationOwner
					.watchedColumns,
			],
			arguments: [],
			isConstraintTrigger: true,
			isDeferrable: true,
			isInitiallyDeferred: true,
		},
		{
			triggerName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.activeMemberUser.triggerName,
			tableSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.activeMemberUser.tableSchema,
			tableName: AUTH_IDENTITY_INVARIANT_CONTRACTS.activeMemberUser.tableName,
			functionSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.activeMemberUser.functionSchema,
			functionName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.activeMemberUser.functionName,
			triggerType: BEFORE_INSERT_ROW,
			watchedColumns: [
				...AUTH_IDENTITY_INVARIANT_CONTRACTS.activeMemberUser.watchedColumns,
			],
			arguments: [],
		},
		{
			triggerName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.memberOwnerAndCredentialExit
					.triggerName,
			tableSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.memberOwnerAndCredentialExit
					.tableSchema,
			tableName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.memberOwnerAndCredentialExit
					.tableName,
			functionSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.memberOwnerAndCredentialExit
					.functionSchema,
			functionName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.memberOwnerAndCredentialExit
					.functionName,
			triggerType: BEFORE_INSERT_DELETE_OR_UPDATE_ROW,
			watchedColumns: [
				...AUTH_IDENTITY_INVARIANT_CONTRACTS.memberOwnerAndCredentialExit
					.watchedColumns,
			],
			arguments: [],
		},
		{
			triggerName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.userDashboardPrincipalCleanup
					.triggerName,
			tableSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.userDashboardPrincipalCleanup
					.tableSchema,
			tableName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.userDashboardPrincipalCleanup
					.tableName,
			functionSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.userDashboardPrincipalCleanup
					.functionSchema,
			functionName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.userDashboardPrincipalCleanup
					.functionName,
			triggerType: BEFORE_DELETE_ROW,
			watchedColumns: [],
			arguments: [],
		},
		{
			triggerName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.userBanCredentialRotation.triggerName,
			tableSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.userBanCredentialRotation.tableSchema,
			tableName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.userBanCredentialRotation.tableName,
			functionSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.userBanCredentialRotation
					.functionSchema,
			functionName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.userBanCredentialRotation
					.functionName,
			triggerType: BEFORE_INSERT_OR_UPDATE_ROW,
			watchedColumns: [
				...AUTH_IDENTITY_INVARIANT_CONTRACTS.userBanCredentialRotation
					.watchedColumns,
			],
			arguments: [],
		},
		{
			triggerName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.administratorImpersonationRevocation
					.triggerName,
			tableSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.administratorImpersonationRevocation
					.tableSchema,
			tableName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.administratorImpersonationRevocation
					.tableName,
			functionSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.administratorImpersonationRevocation
					.functionSchema,
			functionName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.administratorImpersonationRevocation
					.functionName,
			triggerType: AFTER_DELETE_OR_UPDATE_ROW,
			watchedColumns: [
				...AUTH_IDENTITY_INVARIANT_CONTRACTS
					.administratorImpersonationRevocation.watchedColumns,
			],
			arguments: [],
		},
		{
			triggerName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS
					.originatingSessionImpersonationRevocation.triggerName,
			tableSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS
					.originatingSessionImpersonationRevocation.tableSchema,
			tableName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS
					.originatingSessionImpersonationRevocation.tableName,
			functionSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS
					.originatingSessionImpersonationRevocation.functionSchema,
			functionName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS
					.originatingSessionImpersonationRevocation.functionName,
			triggerType: AFTER_DELETE_ROW,
			watchedColumns: [],
			arguments: [],
		},
		{
			triggerName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.memberInvitationAuthorityInvalidation
					.triggerName,
			tableSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.memberInvitationAuthorityInvalidation
					.tableSchema,
			tableName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.memberInvitationAuthorityInvalidation
					.tableName,
			functionSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.memberInvitationAuthorityInvalidation
					.functionSchema,
			functionName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.memberInvitationAuthorityInvalidation
					.functionName,
			triggerType: BEFORE_DELETE_OR_UPDATE_ROW,
			watchedColumns: [
				...AUTH_IDENTITY_INVARIANT_CONTRACTS
					.memberInvitationAuthorityInvalidation.watchedColumns,
			],
			arguments: [],
		},
		{
			triggerName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.invitationIssuerCredentialFence
					.triggerName,
			tableSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.invitationIssuerCredentialFence
					.tableSchema,
			tableName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.invitationIssuerCredentialFence
					.tableName,
			functionSchema:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.invitationIssuerCredentialFence
					.functionSchema,
			functionName:
				AUTH_IDENTITY_INVARIANT_CONTRACTS.invitationIssuerCredentialFence
					.functionName,
			triggerType: BEFORE_INSERT_OR_UPDATE_ROW,
			watchedColumns: [
				...AUTH_IDENTITY_INVARIANT_CONTRACTS.invitationIssuerCredentialFence
					.watchedColumns,
			],
			arguments: [],
		},
	];

	for (const contract of PARENT_IDENTITY_PROJECTIONS) {
		const mapping = contract.projections
			.map(({ parentColumn, childColumn }) => `${parentColumn}:${childColumn}`)
			.join(",");
		expected.push({
			triggerName: contract.triggerName,
			tableSchema: "public",
			tableName: contract.childTable,
			functionSchema: projectionFunction.functionSchema,
			functionName: projectionFunction.functionName,
			triggerType: BEFORE_INSERT_OR_UPDATE_ROW,
			watchedColumns: uniqueValues([
				contract.childParentColumn,
				"organization_id",
				...contract.projections.map(({ childColumn }) => childColumn),
			]),
			arguments: [contract.parentTable, contract.childParentColumn, mapping],
		});
	}

	for (const tableName of workspaceRequirement.tables) {
		const inactiveState = workspaceRequirement.inactiveStates[tableName];
		const inheritedParentColumns = PARENT_IDENTITY_PROJECTIONS.filter(
			(contract) =>
				contract.childTable === tableName &&
				contract.projections.some(
					({ childColumn }) => childColumn === "workspace_id",
				),
		).map(({ childParentColumn }) => childParentColumn);
		expected.push({
			triggerName: workspaceRequirementTriggerName(tableName),
			tableSchema: "public",
			tableName: tableName,
			functionSchema: workspaceRequirement.functionSchema,
			functionName: workspaceRequirement.functionName,
			triggerType: BEFORE_INSERT_OR_UPDATE_ROW,
			watchedColumns: uniqueValues([
				"workspace_id",
				"organization_id",
				...inheritedParentColumns,
				...(inactiveState ? [inactiveState.column] : []),
			]),
			arguments: [
				inactiveState?.column ?? "",
				inactiveState?.values.join(",") ?? "",
			],
		});
	}

	expected.push({
		triggerName: segmentCount.triggerName,
		tableSchema: "public",
		tableName: segmentCount.membershipTable,
		functionSchema: segmentCount.functionSchema,
		functionName: segmentCount.functionName,
		triggerType: AFTER_INSERT_DELETE_OR_UPDATE_ROW,
		watchedColumns: ["segment_id"],
		arguments: [],
	});
	const operatorEvidence = OPERATOR_RESOLUTION_EVIDENCE_APPEND_ONLY_CONTRACT;
	expected.push({
		triggerName: operatorEvidence.triggerName,
		tableSchema: operatorEvidence.tableSchema,
		tableName: operatorEvidence.tableName,
		functionSchema: operatorEvidence.functionSchema,
		functionName: operatorEvidence.functionName,
		triggerType: BEFORE_DELETE_OR_UPDATE_ROW,
		watchedColumns: [],
		arguments: [],
	});
	const subscriptionEvent = CONTACT_SUBSCRIPTION_EVENT_APPEND_ONLY_CONTRACT;
	expected.push({
		triggerName: subscriptionEvent.triggerName,
		tableSchema: subscriptionEvent.tableSchema,
		tableName: subscriptionEvent.tableName,
		functionSchema: subscriptionEvent.functionSchema,
		functionName: subscriptionEvent.functionName,
		triggerType: BEFORE_UPDATE_ROW,
		watchedColumns: [],
		arguments: [],
	});
	const financialReceipt = FINANCIAL_RETENTION_RECEIPT_IMMUTABILITY_CONTRACT;
	expected.push({
		triggerName: financialReceipt.triggerName,
		tableSchema: financialReceipt.tableSchema,
		tableName: financialReceipt.tableName,
		functionSchema: financialReceipt.functionSchema,
		functionName: financialReceipt.functionName,
		triggerType: BEFORE_UPDATE_ROW,
		watchedColumns: [],
		arguments: [],
	});
	const conversionFact = AUTOMATION_CONVERSION_EVENT_FACT_CONTRACT;
	expected.push({
		triggerName: conversionFact.triggerName,
		tableSchema: conversionFact.tableSchema,
		tableName: conversionFact.tableName,
		functionSchema: conversionFact.functionSchema,
		functionName: conversionFact.functionName,
		triggerType: BEFORE_UPDATE_ROW,
		watchedColumns: [],
		arguments: [],
	});
	const usageProjection = USAGE_BUCKET_PROJECTION_CONTRACT;
	expected.push(
		{
			triggerName: usageProjection.triggers.insert.name,
			tableSchema: usageProjection.tableSchema,
			tableName: usageProjection.reservationTable,
			functionSchema: usageProjection.projectionFunctionSchema,
			functionName: usageProjection.projectionFunctionName,
			triggerType: AFTER_INSERT_STATEMENT,
			watchedColumns: [],
			arguments: [],
			newTransitionTable: usageProjection.triggers.insert.newTransitionTable,
		},
		{
			triggerName: usageProjection.triggers.update.name,
			tableSchema: usageProjection.tableSchema,
			tableName: usageProjection.reservationTable,
			functionSchema: usageProjection.projectionFunctionSchema,
			functionName: usageProjection.projectionFunctionName,
			triggerType: AFTER_UPDATE_STATEMENT,
			watchedColumns: [],
			arguments: [],
			oldTransitionTable: usageProjection.triggers.update.oldTransitionTable,
			newTransitionTable: usageProjection.triggers.update.newTransitionTable,
		},
		{
			triggerName: usageProjection.triggers.delete.name,
			tableSchema: usageProjection.tableSchema,
			tableName: usageProjection.reservationTable,
			functionSchema: usageProjection.projectionFunctionSchema,
			functionName: usageProjection.projectionFunctionName,
			triggerType: AFTER_DELETE_STATEMENT,
			watchedColumns: [],
			arguments: [],
			oldTransitionTable: usageProjection.triggers.delete.oldTransitionTable,
		},
		{
			triggerName: usageProjection.triggers.bucketGuard.name,
			tableSchema: usageProjection.tableSchema,
			tableName: usageProjection.bucketTable,
			functionSchema: usageProjection.guardFunctionSchema,
			functionName: usageProjection.guardFunctionName,
			triggerType: BEFORE_INSERT_OR_UPDATE_ROW,
			watchedColumns: ["reserved_units", "committed_units"],
			arguments: [],
		},
	);

	return expected;
}

function extractGeneratedFunctionSource(
	renderedSql: string,
	functionSchema: string,
	functionName: string,
): string {
	const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
	const header = `CREATE OR REPLACE FUNCTION ${identifier(functionSchema)}.${identifier(functionName)}()`;
	const headerIndex = renderedSql.indexOf(header);
	if (headerIndex === -1) {
		throw new Error(`Generated migration SQL is missing ${header}`);
	}
	const functionSql = renderedSql.slice(headerIndex);
	const delimiterMatch = functionSql.match(/\nAS (\$[a-z0-9_]+\$)/i);
	const delimiter = delimiterMatch?.[1];
	if (delimiterMatch?.index === undefined || !delimiter) {
		throw new Error(`Generated migration SQL has no body for ${header}`);
	}
	const sourceStart =
		headerIndex + delimiterMatch.index + delimiterMatch[0].length;
	const sourceEnd = renderedSql.indexOf(`${delimiter};`, sourceStart);
	if (sourceEnd === -1) {
		throw new Error(
			`Generated migration SQL has no closing body for ${header}`,
		);
	}
	return renderedSql.slice(sourceStart, sourceEnd);
}

function expectedGeneratedFunctions(): ExpectedGeneratedFunction[] {
	const renderedSql = renderCustomMigrationSql();
	const generatedContracts = [
		{
			functionSchema: ORGANIZATION_PROVISIONING_CONTRACT.functionSchema,
			functionName: ORGANIZATION_PROVISIONING_CONTRACT.functionName,
			functionConfig: ["search_path=pg_catalog, public, auth"],
		},
		{
			functionSchema: PARENT_IDENTITY_PROJECTION_FUNCTION.functionSchema,
			functionName: PARENT_IDENTITY_PROJECTION_FUNCTION.functionName,
			functionConfig: ["search_path=pg_catalog, public"],
		},
		{
			functionSchema: WORKSPACE_REQUIREMENT_CONTRACT.functionSchema,
			functionName: WORKSPACE_REQUIREMENT_CONTRACT.functionName,
			functionConfig: ["search_path=pg_catalog, public"],
		},
		{
			functionSchema: SEGMENT_MEMBER_COUNT_CONTRACT.functionSchema,
			functionName: SEGMENT_MEMBER_COUNT_CONTRACT.functionName,
			functionConfig: ["search_path=pg_catalog, public"],
		},
	].map((contract) => ({
		...contract,
		functionSource: extractGeneratedFunctionSource(
			renderedSql,
			contract.functionSchema,
			contract.functionName,
		),
	}));
	const identityInvariantSql = renderAuthIdentityInvariantSql();
	const identityContracts = Object.values(
		AUTH_IDENTITY_INVARIANT_CONTRACTS,
	).map((contract) => ({
		functionSchema: contract.functionSchema,
		functionName: contract.functionName,
		functionConfig: ["search_path=pg_catalog, auth"],
		functionSource: extractGeneratedFunctionSource(
			identityInvariantSql,
			contract.functionSchema,
			contract.functionName,
		),
	}));
	const operatorEvidence = OPERATOR_RESOLUTION_EVIDENCE_APPEND_ONLY_CONTRACT;
	const operatorEvidenceSql = renderOperatorResolutionEvidenceInvariantSql();
	const subscriptionEvent = CONTACT_SUBSCRIPTION_EVENT_APPEND_ONLY_CONTRACT;
	const subscriptionEventSql = renderContactSubscriptionEventInvariantSql();
	const financialReceipt = FINANCIAL_RETENTION_RECEIPT_IMMUTABILITY_CONTRACT;
	const financialReceiptSql = renderFinancialRetentionReceiptInvariantSql();
	const conversionFact = AUTOMATION_CONVERSION_EVENT_FACT_CONTRACT;
	const conversionFactSql = renderAutomationConversionEventInvariantSql();
	const usageProjection = USAGE_BUCKET_PROJECTION_CONTRACT;
	return [
		...generatedContracts,
		...identityContracts,
		{
			functionSchema: operatorEvidence.functionSchema,
			functionName: operatorEvidence.functionName,
			functionConfig: ["search_path=pg_catalog, public"],
			functionSource: extractGeneratedFunctionSource(
				operatorEvidenceSql,
				operatorEvidence.functionSchema,
				operatorEvidence.functionName,
			),
		},
		{
			functionSchema: subscriptionEvent.functionSchema,
			functionName: subscriptionEvent.functionName,
			functionConfig: ["search_path=pg_catalog, public"],
			functionSource: extractGeneratedFunctionSource(
				subscriptionEventSql,
				subscriptionEvent.functionSchema,
				subscriptionEvent.functionName,
			),
		},
		{
			functionSchema: financialReceipt.functionSchema,
			functionName: financialReceipt.functionName,
			functionConfig: ["search_path=pg_catalog, public"],
			functionSource: extractGeneratedFunctionSource(
				financialReceiptSql,
				financialReceipt.functionSchema,
				financialReceipt.functionName,
			),
		},
		{
			functionSchema: conversionFact.functionSchema,
			functionName: conversionFact.functionName,
			functionConfig: ["search_path=pg_catalog, public"],
			functionSource: extractGeneratedFunctionSource(
				conversionFactSql,
				conversionFact.functionSchema,
				conversionFact.functionName,
			),
		},
		{
			functionSchema: usageProjection.projectionFunctionSchema,
			functionName: usageProjection.projectionFunctionName,
			functionConfig: ["search_path=pg_catalog, public"],
			functionSource: extractGeneratedFunctionSource(
				renderedSql,
				usageProjection.projectionFunctionSchema,
				usageProjection.projectionFunctionName,
			),
		},
		{
			functionSchema: usageProjection.guardFunctionSchema,
			functionName: usageProjection.guardFunctionName,
			functionConfig: ["search_path=pg_catalog, public"],
			functionSource: extractGeneratedFunctionSource(
				renderedSql,
				usageProjection.guardFunctionSchema,
				usageProjection.guardFunctionName,
			),
		},
	];
}

function databaseTriggerKey(
	trigger: Pick<
		ExpectedDatabaseTrigger,
		"tableSchema" | "tableName" | "triggerName"
	>,
): string {
	return `${trigger.tableSchema}.${trigger.tableName}.${trigger.triggerName}`;
}

function actualDatabaseTriggerKey(trigger: DatabaseContractTriggerRow): string {
	return `${trigger.table_schema}.${trigger.table_name}.${trigger.trigger_name}`;
}

const dialect = new PgDialect();
const enumTypeNames = [
	...new Set(
		Object.values(schema).flatMap((value) =>
			isPgEnum(value) ? [value.enumName] : [],
		),
	),
];
const implicitLiteralCastPattern = new RegExp(
	`('(?:''|[^'])*')::(?:(?:"?[a-z_][a-z0-9_$]*"?)\\.)?"?(?:text|character varying(?:\\(\\d+\\))?|${enumTypeNames
		.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|")})"?`,
	"gi",
);

function normalizeType(type: string): string {
	if (type === "bigserial") return "bigint";
	if (type === "character varying") return "varchar";
	return type.replace(/^character varying\((\d+)\)$/, "varchar($1)");
}

function truncateIdentifier(name: string): string {
	// Every declarative identifier in this schema is ASCII, so PostgreSQL's
	// 63-byte NAMEDATALEN limit is equivalent to a 63-character slice here.
	return name.slice(0, 63);
}

function quoteSqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function canonicalizeJsonLiteral(expression: string): string {
	const match = expression.trim().match(/^'((?:''|[^'])*)'::(?:jsonb|json)$/i);
	if (!match) return expression;
	try {
		const encoded = match[1];
		if (encoded === undefined) return expression;
		const parsed = JSON.parse(encoded.replaceAll("''", "'"));
		const type = expression.trim().toLowerCase().endsWith("::jsonb")
			? "jsonb"
			: "json";
		return `${quoteSqlLiteral(stableJson(parsed))}::${type}`;
	} catch {
		return expression;
	}
}

function normalizeOutsideStringLiterals(value: string): string {
	let normalized = "";
	let outside = "";
	const flushOutside = () => {
		normalized += outside
			.toLowerCase()
			.replace(/\s+/g, " ")
			.replace(/\s*(->>|->|#>>|#>|>=|<=|<>|=)\s*/g, "$1")
			.replace(/\(\s+/g, "(")
			.replace(/\s+\)/g, ")")
			.replace(/,\s*/g, ",");
		outside = "";
	};

	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character === '"') {
			flushOutside();
			let identifier = "";
			for (index += 1; index < value.length; index += 1) {
				const identifierCharacter = value[index];
				if (identifierCharacter !== '"') {
					identifier += identifierCharacter;
					continue;
				}
				if (value[index + 1] === '"') {
					identifier += '"';
					index += 1;
					continue;
				}
				break;
			}
			normalized += /^[a-z_][a-z0-9_$]*$/.test(identifier)
				? identifier
				: `"${identifier.replaceAll('"', '""')}"`;
			continue;
		}
		if (character !== "'") {
			outside += character;
			continue;
		}

		flushOutside();
		normalized += character;
		for (index += 1; index < value.length; index += 1) {
			const literalCharacter = value[index];
			normalized += literalCharacter;
			if (literalCharacter !== "'") continue;
			if (value[index + 1] === "'") {
				normalized += value[index + 1];
				index += 1;
				continue;
			}
			break;
		}
	}
	flushOutside();
	return normalized.trim();
}

function isWrappedExpression(value: string): boolean {
	if (!value.startsWith("(") || !value.endsWith(")")) return false;
	let depth = 0;
	let quoted = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character === "'") {
			if (quoted && value[index + 1] === "'") {
				index += 1;
				continue;
			}
			quoted = !quoted;
			continue;
		}
		if (quoted) continue;
		if (character === "(") depth += 1;
		if (character === ")") depth -= 1;
		if (depth === 0 && index < value.length - 1) return false;
	}
	return depth === 0 && !quoted;
}

function normalizeExpression(expression: string | null): string | null {
	if (expression === null) return null;
	let value = canonicalizeJsonLiteral(expression.trim());
	value = value.replace(implicitLiteralCastPattern, "$1");
	value = normalizeOutsideStringLiterals(value);
	value = value.replace(
		/\bnull::(?:(?:"[a-z_][a-z0-9_$]*"|[a-z_][a-z0-9_$]*)\.)?(?:"[a-z_][a-z0-9_$]*"|[a-z_][a-z0-9_$]*)(?:\[\])?(?:\(\d+(?:,\d+)?\))?/gi,
		"null",
	);
	value = value.replace(
		/([a-z0-9_."()]+)=any\s*\(array\[(.*?)\]\)/g,
		"$1 in ($2)",
	);
	while (isWrappedExpression(value)) value = value.slice(1, -1).trim();
	return value;
}

function identifierExpression(name: string): string {
	return /^[a-z_][a-z0-9_$]*$/.test(name)
		? name
		: `"${name.replaceAll('"', '""')}"`;
}

function renderSql(value: SQL): string {
	const rendered = dialect.sqlToQuery(value.inlineParams(), "indexes");
	if (rendered.params.length > 0) {
		throw new Error(`Schema SQL could not be inlined: ${rendered.sql}`);
	}
	return rendered.sql;
}

function expectedDefaultExpression(
	tableName: string,
	column: ReturnType<typeof tableConfigs>[number]["columns"][number],
): string | null {
	if (column.getSQLType() === "bigserial") {
		return normalizeExpression(
			`nextval(${quoteSqlLiteral(`${truncateIdentifier(`${tableName}_${column.name}_seq`)}`)}::regclass)`,
		);
	}
	if (column.default === undefined) return null;
	if (is(column.default, SQL))
		return normalizeExpression(renderSql(column.default));

	if (typeof column.default === "string") {
		return normalizeExpression(quoteSqlLiteral(column.default));
	}
	if (
		typeof column.default === "number" ||
		typeof column.default === "boolean"
	) {
		return normalizeExpression(String(column.default));
	}

	const encoded = column.mapToDriverValue(column.default);
	if (typeof encoded !== "string") {
		throw new Error(
			`Unsupported database default on ${tableName}.${column.name}`,
		);
	}
	return normalizeExpression(
		`${quoteSqlLiteral(encoded)}::${column.getSQLType()}`,
	);
}

function expectedGeneratedExpression(
	tableName: string,
	column: ReturnType<typeof tableConfigs>[number]["columns"][number],
): string | null {
	if (!column.generated) return null;
	const generated =
		typeof column.generated.as === "function"
			? column.generated.as()
			: column.generated.as;
	if (!is(generated, SQL)) {
		throw new Error(
			`Generated column ${tableName}.${column.name} is not declared with SQL`,
		);
	}
	return normalizeExpression(renderSql(generated));
}

function tableConfigs() {
	const configs: Array<ReturnType<typeof getTableConfig>> = [];
	for (const value of Object.values(schema)) {
		if (!is(value, PgTable)) continue;
		const table = getTableConfig(value);
		const schemaName = table.schema ?? "public";
		if (schemaName === "auth" || schemaName === "public") configs.push(table);
	}
	return configs;
}

function expectedEnumsFromSchema(): ExpectedEnum[] {
	const enums = new Map<string, ExpectedEnum>();
	for (const value of Object.values(schema)) {
		if (!isPgEnum(value)) continue;
		const enumType = {
			schemaName: value.schema ?? "public",
			typeName: value.enumName,
			values: [...value.enumValues],
		};
		if (enumType.schemaName !== "auth" && enumType.schemaName !== "public") {
			continue;
		}
		const key = `${enumType.schemaName}.${enumType.typeName}`;
		const existing = enums.get(key);
		if (existing && JSON.stringify(existing) !== JSON.stringify(enumType)) {
			throw new Error(`Conflicting Drizzle enums found for ${key}`);
		}
		enums.set(key, enumType);
	}
	return [...enums.values()].sort((left, right) =>
		`${left.schemaName}.${left.typeName}`.localeCompare(
			`${right.schemaName}.${right.typeName}`,
		),
	);
}

function expectedCatalog(): CatalogTable[] {
	const catalog = new Map<string, CatalogTable>();

	for (const table of tableConfigs()) {
		const schemaName = table.schema ?? "public";

		const key = `${schemaName}.${table.name}`;
		const entry: CatalogTable = {
			schemaName,
			tableName: table.name,
			columns: table.columns.map((column) => ({
				name: column.name,
				type: normalizeType(column.getSQLType()),
				notNull: column.notNull,
				defaultExpression: expectedDefaultExpression(table.name, column),
				generatedExpression: expectedGeneratedExpression(table.name, column),
				generatedKind: column.generated ? "s" : "",
				identityKind: column.generatedIdentity
					? column.generatedIdentity.type === "always"
						? "a"
						: "d"
					: "",
			})),
		};
		const existing = catalog.get(key);

		if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) {
			throw new Error(`Conflicting Drizzle exports found for ${key}`);
		}

		catalog.set(key, entry);
	}

	return [...catalog.values()].sort((left, right) =>
		`${left.schemaName}.${left.tableName}`.localeCompare(
			`${right.schemaName}.${right.tableName}`,
		),
	);
}

function expectedIndexColumn(
	column: ReturnType<
		typeof tableConfigs
	>[number]["indexes"][number]["config"]["columns"][number],
): IndexColumnDefinition {
	if (!is(column, SQL)) {
		const indexedColumn = column as {
			name?: string;
			indexConfig?: {
				order?: "asc" | "desc";
				nulls?: "first" | "last";
				opClass?: string;
			};
		};
		if (!indexedColumn.name) {
			throw new Error("Declarative index column has no name");
		}
		return {
			expression:
				normalizeExpression(identifierExpression(indexedColumn.name)) ??
				indexedColumn.name,
			order: indexedColumn.indexConfig?.order ?? "asc",
			nulls: indexedColumn.indexConfig?.nulls ?? "last",
			opClass: indexedColumn.indexConfig?.opClass ?? null,
		};
	}

	let expression = renderSql(column).trim();
	const nullsMatch = expression.match(/\s+nulls\s+(first|last)\s*$/i);
	const explicitNulls = nullsMatch?.[1]?.toLowerCase() as
		| "first"
		| "last"
		| undefined;
	if (nullsMatch) expression = expression.slice(0, nullsMatch.index).trim();

	const orderMatch = expression.match(/\s+(asc|desc)\s*$/i);
	const order = (orderMatch?.[1]?.toLowerCase() ?? "asc") as "asc" | "desc";
	if (orderMatch) expression = expression.slice(0, orderMatch.index).trim();

	const opClassMatch = expression.match(/\s+([a-z_][a-z0-9_]*_ops)\s*$/i);
	const opClass = opClassMatch?.[1]?.toLowerCase() ?? null;
	if (opClassMatch) expression = expression.slice(0, opClassMatch.index).trim();

	return {
		expression: normalizeExpression(expression) ?? expression,
		order,
		nulls: explicitNulls ?? (order === "desc" ? "first" : "last"),
		opClass,
	};
}

function declaredIndexesFromSchema(): ExpectedIndex[] {
	return tableConfigs().flatMap((table) => {
		const schemaName = table.schema ?? "public";
		return table.indexes.map((index) => {
			if (!index.config.name) {
				throw new Error(`Unnamed index found on ${schemaName}.${table.name}`);
			}
			return {
				schemaName,
				tableName: table.name,
				name: truncateIdentifier(index.config.name),
				unique: index.config.unique,
				method:
					typeof index.config.method === "string"
						? index.config.method
						: "btree",
				columns: index.config.columns.map(expectedIndexColumn),
				predicate: index.config.where
					? normalizeExpression(renderSql(index.config.where))
					: null,
				storageParameters: Object.entries(index.config.with ?? {})
					.map(([name, value]) => `${name}=${String(value)}`)
					.sort(),
			};
		});
	});
}

function expectedConstraints(): ExpectedConstraint[] {
	const constraints = new Map<string, ExpectedConstraint>();
	const add = (constraint: ExpectedConstraint) => {
		const normalizedConstraint = {
			...constraint,
			name: truncateIdentifier(constraint.name),
		};
		const key = `${normalizedConstraint.schemaName}.${normalizedConstraint.tableName}.${normalizedConstraint.name}`;
		const existing = constraints.get(key);
		if (
			existing &&
			JSON.stringify(existing) !== JSON.stringify(normalizedConstraint)
		) {
			throw new Error(`Conflicting Drizzle constraints found for ${key}`);
		}
		constraints.set(key, normalizedConstraint);
	};
	const base = (
		schemaName: string,
		tableName: string,
		name: string,
		type: ExpectedConstraint["type"],
		columns: string[],
	): ExpectedConstraint => ({
		schemaName,
		tableName,
		name,
		type,
		columns,
		foreignSchema: null,
		foreignTable: null,
		foreignColumns: [],
		onUpdate: null,
		onDelete: null,
		matchType: null,
		nullsNotDistinct: false,
		deferrable: false,
		initiallyDeferred: false,
		checkExpression: null,
	});

	for (const table of tableConfigs()) {
		const schemaName = table.schema ?? "public";
		const columnPrimaryKey = table.columns.filter((column) => column.primary);
		if (columnPrimaryKey.length > 0) {
			add(
				base(
					schemaName,
					table.name,
					`${table.name}_pkey`,
					"p",
					columnPrimaryKey.map((column) => column.name),
				),
			);
		}
		for (const primaryKey of table.primaryKeys) {
			add(
				base(
					schemaName,
					table.name,
					primaryKey.getName(),
					"p",
					primaryKey.columns.map((column) => column.name),
				),
			);
		}
		for (const foreignKey of table.foreignKeys) {
			const reference = foreignKey.reference();
			const foreignTable = getTableConfig(reference.foreignTable);
			add({
				...base(
					schemaName,
					table.name,
					foreignKey.getName(),
					"f",
					reference.columns.map((column) => column.name),
				),
				foreignSchema: foreignTable.schema ?? "public",
				foreignTable: foreignTable.name,
				foreignColumns: reference.foreignColumns.map((column) => column.name),
				onUpdate: foreignKey.onUpdate ?? "no action",
				onDelete: foreignKey.onDelete ?? "no action",
				matchType: "simple",
			});
		}
		for (const unique of table.uniqueConstraints) {
			const name = unique.getName();
			if (!name) {
				throw new Error(
					`Unnamed unique constraint on ${schemaName}.${table.name}`,
				);
			}
			add({
				...base(
					schemaName,
					table.name,
					name,
					"u",
					unique.columns.map((column) => column.name),
				),
				nullsNotDistinct: unique.nullsNotDistinct,
			});
		}
		for (const column of table.columns) {
			if (column.isUnique) {
				if (!column.uniqueName) {
					throw new Error(
						`Unique column ${schemaName}.${table.name}.${column.name} has no constraint name`,
					);
				}
				add({
					...base(schemaName, table.name, column.uniqueName, "u", [
						column.name,
					]),
					nullsNotDistinct: column.uniqueType === "not distinct",
				});
			}
		}
		for (const check of table.checks) {
			if (!check.name) {
				throw new Error(
					`Unnamed check constraint on ${schemaName}.${table.name}`,
				);
			}
			add({
				...base(schemaName, table.name, check.name, "c", []),
				checkExpression: normalizeExpression(renderSql(check.value)),
				rawCheckExpression: renderSql(check.value),
			});
		}
	}

	return [...constraints.values()];
}

function quotedIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

/**
 * PostgreSQL rewrites equivalent CHECK syntax when it stores a constraint
 * (BETWEEN, IN/NOT IN, casts, and redundant parentheses among others). Parse
 * each expected Drizzle expression through the same server/version deparser
 * before comparing it with the live catalog; textual regex normalization
 * cannot safely reproduce PostgreSQL operator precedence.
 */
async function canonicalizeExpectedCheckConstraints(
	client: ReturnType<typeof postgres>,
	constraints: ExpectedConstraint[],
): Promise<ExpectedConstraint[]> {
	const checksByTable = new Map<string, ExpectedConstraint[]>();
	for (const constraint of constraints) {
		if (constraint.type !== "c") continue;
		const key = `${constraint.schemaName}.${constraint.tableName}`;
		const checks = checksByTable.get(key) ?? [];
		checks.push(constraint);
		checksByTable.set(key, checks);
	}

	const canonical = new Map<string, string>();
	let tableIndex = 0;
	for (const checks of checksByTable.values()) {
		const sample = checks[0];
		if (!sample) continue;
		const temporaryTable = `relayapi_verify_checks_${tableIndex}`;
		tableIndex += 1;
		const temporaryQualified = `pg_temp.${quotedIdentifier(temporaryTable)}`;
		const sourceQualified = `${quotedIdentifier(sample.schemaName)}.${quotedIdentifier(sample.tableName)}`;
		await client.unsafe(
			`CREATE TEMP TABLE ${temporaryQualified} (LIKE ${sourceQualified})`,
		);
		try {
			const additions = checks
				.map((constraint) => {
					if (!constraint.rawCheckExpression) {
						throw new Error(
							`Expected CHECK ${constraint.schemaName}.${constraint.tableName}.${constraint.name} has no source expression`,
						);
					}
					return `ADD CONSTRAINT ${quotedIdentifier(constraint.name)} CHECK (${constraint.rawCheckExpression}) NOT VALID`;
				})
				.join(", ");
			await client.unsafe(`ALTER TABLE ${temporaryQualified} ${additions}`);
			const temporaryRegclass = `pg_temp.${temporaryTable}`;
			const rows = await client<
				Array<{ constraint_name: string; check_expression: string }>
			>`
				SELECT
					constraint_row.conname AS constraint_name,
					pg_get_expr(
						constraint_row.conbin,
						constraint_row.conrelid,
						true
					) AS check_expression
				FROM pg_constraint constraint_row
				WHERE constraint_row.conrelid = ${temporaryRegclass}::regclass
					AND constraint_row.contype = 'c'
			`;
			for (const row of rows) {
				canonical.set(
					`${sample.schemaName}.${sample.tableName}.${row.constraint_name}`,
					normalizeExpression(row.check_expression) ?? row.check_expression,
				);
			}
		} finally {
			await client.unsafe(`DROP TABLE IF EXISTS ${temporaryQualified}`);
		}
	}

	return constraints.map((constraint) => {
		if (constraint.type !== "c") return constraint;
		const key = `${constraint.schemaName}.${constraint.tableName}.${constraint.name}`;
		const expression = canonical.get(key);
		if (!expression) {
			throw new Error(`PostgreSQL did not deparse expected CHECK ${key}`);
		}
		return { ...constraint, checkExpression: expression };
	});
}

function groupActualCatalog(
	rows: ActualCatalogRow[],
): Map<string, ActualCatalogRow[]> {
	const catalog = new Map<string, ActualCatalogRow[]>();

	for (const row of rows) {
		const key = `${row.schema_name}.${row.table_name}`;
		const columns = catalog.get(key) ?? [];
		columns.push(row);
		catalog.set(key, columns);
	}

	return catalog;
}

function compareCatalog(
	expected: CatalogTable[],
	actual: Map<string, ActualCatalogRow[]>,
): string[] {
	const failures: string[] = [];
	const expectedKeys = new Set(
		expected.map((table) => `${table.schemaName}.${table.tableName}`),
	);

	for (const table of expected) {
		const key = `${table.schemaName}.${table.tableName}`;
		const actualColumns = actual.get(key);
		if (!actualColumns) {
			failures.push(`missing table ${key}`);
			continue;
		}

		const expectedColumns = new Set(table.columns.map((column) => column.name));
		const actualColumnSet = new Set(
			actualColumns.map((column) => column.column_name),
		);
		const missingColumns = table.columns.filter(
			(column) => !actualColumnSet.has(column.name),
		);
		const unexpectedColumns = actualColumns.filter(
			(column) => !expectedColumns.has(column.column_name),
		);

		if (missingColumns.length > 0) {
			failures.push(
				`${key} is missing columns: ${missingColumns.map((column) => column.name).join(", ")}`,
			);
		}
		if (unexpectedColumns.length > 0) {
			failures.push(
				`${key} has unexpected columns: ${unexpectedColumns.map((column) => column.column_name).join(", ")}`,
			);
		}

		const actualByName = new Map(
			actualColumns.map((column) => [column.column_name, column]),
		);
		for (const column of table.columns) {
			const actualColumn = actualByName.get(column.name);
			if (!actualColumn) continue;
			const actualType = normalizeType(actualColumn.formatted_type);
			if (actualType !== column.type) {
				failures.push(
					`${key}.${column.name} type is ${actualType}, expected ${column.type}`,
				);
			}
			if (actualColumn.not_null !== column.notNull) {
				failures.push(
					`${key}.${column.name} nullability differs from the Drizzle schema`,
				);
			}
			if (actualColumn.generated_kind !== column.generatedKind) {
				failures.push(
					`${key}.${column.name} generated-column kind differs from the Drizzle schema`,
				);
			}
			if (actualColumn.identity_kind !== column.identityKind) {
				failures.push(
					`${key}.${column.name} identity kind differs from the Drizzle schema`,
				);
			}
			const actualDefault = normalizeExpression(
				actualColumn.default_expression,
			);
			if (actualDefault !== column.defaultExpression) {
				failures.push(
					`${key}.${column.name} default is ${JSON.stringify(actualDefault)}, expected ${JSON.stringify(column.defaultExpression)}`,
				);
			}
			const actualGenerated = normalizeExpression(
				actualColumn.generated_expression,
			);
			if (actualGenerated !== column.generatedExpression) {
				failures.push(
					`${key}.${column.name} generated expression is ${JSON.stringify(actualGenerated)}, expected ${JSON.stringify(column.generatedExpression)}`,
				);
			}
		}
	}

	for (const key of [...actual.keys()].sort()) {
		if (!expectedKeys.has(key)) failures.push(`unexpected table ${key}`);
	}

	return failures;
}

async function verify(): Promise<void> {
	const sql = postgres(databaseUrl, {
		max: 1,
		prepare: false,
		connect_timeout: 10,
	});

	try {
		const failures: string[] = [];
		const expected = expectedCatalog();
		const requiredDatabaseSchemas = [
			...new Set(["public", ...REQUIRED_BASELINE_SCHEMAS]),
		];
		const expectedDeclaredIndexes = declaredIndexesFromSchema();
		const expectedDeclaredConstraints =
			await canonicalizeExpectedCheckConstraints(sql, expectedConstraints());
		const expectedEnumTypes = expectedEnumsFromSchema();

		const [
			requiredSchemas,
			extensions,
			catalogRows,
			automationTable,
			primaryKey,
			idColumn,
			criticalIndexes,
			enumValues,
			invalidConstraints,
			actualDeclaredIndexes,
			actualDeclaredConstraints,
			generatedFunctions,
			organizationProvisioningCoverage,
			databaseContractTriggers,
			nonDrizzleRelations,
			rowPolicies,
			segmentMemberCountCoverage,
		] = await Promise.all([
			sql<{ schema_name: string }[]>`
					SELECT schema_name
					FROM information_schema.schemata
					WHERE schema_name IN ${sql(requiredDatabaseSchemas)}
					ORDER BY schema_name
				`,
			sql<ExtensionCatalogRow[]>`
					SELECT
						extension_row.extname AS extension_name,
						namespace_row.nspname AS extension_schema,
						extension_row.extversion AS extension_version
					FROM pg_extension extension_row
					JOIN pg_namespace namespace_row
						ON namespace_row.oid = extension_row.extnamespace
					WHERE extension_row.extname IN ${sql(REQUIRED_BASELINE_EXTENSIONS)}
				`,
			sql<ActualCatalogRow[]>`
					SELECT
						n.nspname AS schema_name,
						c.relname AS table_name,
						a.attname AS column_name,
						a.attnum::integer AS ordinal_position,
						format_type(a.atttypid, a.atttypmod) AS formatted_type,
						a.attnotnull AS not_null,
						CASE
							WHEN a.attgenerated = '' THEN pg_get_expr(attribute_default.adbin, attribute_default.adrelid, true)
							ELSE NULL
						END AS default_expression,
						CASE
							WHEN a.attgenerated <> '' THEN pg_get_expr(attribute_default.adbin, attribute_default.adrelid, true)
							ELSE NULL
						END AS generated_expression,
						a.attgenerated::text AS generated_kind,
						a.attidentity::text AS identity_kind
					FROM pg_class c
					JOIN pg_namespace n ON n.oid = c.relnamespace
					JOIN pg_attribute a ON a.attrelid = c.oid
					LEFT JOIN pg_attrdef attribute_default
						ON attribute_default.adrelid = a.attrelid
						AND attribute_default.adnum = a.attnum
					WHERE n.nspname IN ('auth', 'public')
						AND c.relkind IN ('r', 'p')
						AND a.attnum > 0
						AND NOT a.attisdropped
					ORDER BY n.nspname, c.relname, a.attnum
				`,
			sql<AutomationTableRow[]>`
					SELECT
						c.relkind::text AS relkind,
						c.relispartition,
						(
							SELECT count(*)::integer
							FROM pg_inherits i
							WHERE i.inhrelid = c.oid
						) AS parent_count,
						(
							SELECT count(*)::integer
							FROM pg_inherits i
							WHERE i.inhparent = c.oid
						) AS child_count
					FROM pg_class c
					JOIN pg_namespace n ON n.oid = c.relnamespace
					WHERE n.nspname = 'public'
						AND c.relname = 'automation_step_runs'
				`,
			sql<AutomationPrimaryKeyRow[]>`
					SELECT array_agg(a.attname ORDER BY key_columns.ordinality)::text[] AS column_names
					FROM pg_constraint constraint_row
					JOIN pg_class c ON c.oid = constraint_row.conrelid
					JOIN pg_namespace n ON n.oid = c.relnamespace
					CROSS JOIN LATERAL unnest(constraint_row.conkey)
						WITH ORDINALITY AS key_columns(attnum, ordinality)
					JOIN pg_attribute a
						ON a.attrelid = c.oid
						AND a.attnum = key_columns.attnum
					WHERE n.nspname = 'public'
						AND c.relname = 'automation_step_runs'
						AND constraint_row.contype = 'p'
					GROUP BY constraint_row.oid
				`,
			sql<AutomationIdRow[]>`
					SELECT data_type, is_nullable, column_default
					FROM information_schema.columns
					WHERE table_schema = 'public'
						AND table_name = 'automation_step_runs'
						AND column_name = 'id'
				`,
			sql<IndexDefinitionRow[]>`
					SELECT indexname, indexdef
					FROM pg_indexes
					WHERE schemaname = 'public'
						AND indexname IN (
							'idx_contact_controls_per_auto',
							'idx_contact_controls_global',
							'idx_automation_entrypoints_webhook_slug',
							'idx_automation_runs_active_uniq',
							'idx_step_runs_executed_brin',
							'inbox_msg_text_trgm_idx',
							'publish_outbox_retention_idx',
							'social_accounts_sms_webhook_route_idx'
						)
				`,
			sql<EnumValueRow[]>`
					SELECT
						n.nspname AS schema_name,
						t.typname AS type_name,
						array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
					FROM pg_type t
					JOIN pg_enum e ON e.enumtypid = t.oid
					JOIN pg_namespace n ON n.oid = t.typnamespace
					WHERE n.nspname IN ('auth', 'public')
					GROUP BY n.nspname, t.typname
				`,
			sql<{ conname: string }[]>`
					SELECT conname
					FROM pg_constraint
					WHERE NOT convalidated
						AND connamespace IN (
							'auth'::regnamespace,
							'public'::regnamespace
					)
				`,
			sql<ActualIndex[]>`
					SELECT
						table_namespace.nspname AS schema_name,
						table_class.relname AS table_name,
						index_class.relname AS index_name,
						index_row.indisunique AS unique,
						index_row.indisvalid AS valid,
						index_row.indisready AS ready,
						index_row.indislive AS live,
						access_method.amname AS method,
						index_row.indnkeyatts::integer AS key_column_count,
						index_row.indnatts::integer AS total_column_count,
						ARRAY(
							SELECT pg_get_indexdef(index_row.indexrelid, position, true)
							FROM generate_series(1, index_row.indnkeyatts) AS position
							ORDER BY position
						)::text[] AS column_expressions,
						ARRAY(
							SELECT CASE
								WHEN (index_row.indoption[position - 1] & 1) = 1 THEN 'desc'
								ELSE 'asc'
							END
							FROM generate_series(1, index_row.indnkeyatts) AS position
							ORDER BY position
						)::text[] AS column_orders,
						ARRAY(
							SELECT CASE
								WHEN (index_row.indoption[position - 1] & 2) = 2 THEN 'first'
								ELSE 'last'
							END
							FROM generate_series(1, index_row.indnkeyatts) AS position
							ORDER BY position
						)::text[] AS column_nulls,
						ARRAY(
							SELECT CASE
								WHEN operator_class.opcdefault THEN NULL
								ELSE operator_class.opcname
							END
							FROM generate_series(1, index_row.indnkeyatts) AS position
							JOIN pg_opclass operator_class
								ON operator_class.oid = index_row.indclass[position - 1]
							ORDER BY position
						)::text[] AS column_opclasses,
						pg_get_expr(index_row.indpred, index_row.indrelid, true) AS predicate,
						coalesce(index_class.reloptions, ARRAY[]::text[]) AS storage_parameters
					FROM pg_index index_row
					JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
					JOIN pg_class table_class ON table_class.oid = index_row.indrelid
					JOIN pg_namespace table_namespace
						ON table_namespace.oid = table_class.relnamespace
					JOIN pg_am access_method ON access_method.oid = index_class.relam
					WHERE table_namespace.nspname IN ('auth', 'public')
						AND NOT EXISTS (
							SELECT 1 FROM pg_constraint constraint_row
							WHERE constraint_row.conindid = index_row.indexrelid
						)
				`,
			sql<ActualConstraint[]>`
					SELECT
						table_namespace.nspname AS schema_name,
						table_class.relname AS table_name,
						constraint_row.conname AS constraint_name,
						constraint_row.contype::text AS type,
						constraint_row.convalidated AS validated,
						ARRAY(
							SELECT column_attribute.attname
							FROM unnest(constraint_row.conkey)
								WITH ORDINALITY AS constraint_column(attnum, position)
							JOIN pg_attribute column_attribute
								ON column_attribute.attrelid = constraint_row.conrelid
								AND column_attribute.attnum = constraint_column.attnum
							ORDER BY constraint_column.position
						)::text[] AS columns,
						referenced_namespace.nspname AS foreign_schema,
						referenced_class.relname AS foreign_table,
						ARRAY(
							SELECT foreign_attribute.attname
							FROM unnest(constraint_row.confkey)
								WITH ORDINALITY AS foreign_column(attnum, position)
							JOIN pg_attribute foreign_attribute
								ON foreign_attribute.attrelid = constraint_row.confrelid
								AND foreign_attribute.attnum = foreign_column.attnum
							ORDER BY foreign_column.position
						)::text[] AS foreign_columns,
						CASE constraint_row.confupdtype
							WHEN 'a' THEN 'no action'
							WHEN 'r' THEN 'restrict'
							WHEN 'c' THEN 'cascade'
							WHEN 'n' THEN 'set null'
							WHEN 'd' THEN 'set default'
							ELSE NULL
						END AS on_update,
						CASE constraint_row.confdeltype
							WHEN 'a' THEN 'no action'
							WHEN 'r' THEN 'restrict'
							WHEN 'c' THEN 'cascade'
							WHEN 'n' THEN 'set null'
							WHEN 'd' THEN 'set default'
							ELSE NULL
						END AS on_delete,
						CASE constraint_row.confmatchtype
							WHEN 's' THEN 'simple'
							WHEN 'f' THEN 'full'
							WHEN 'p' THEN 'partial'
							ELSE NULL
						END AS match_type,
						coalesce(constraint_index.indnullsnotdistinct, false) AS nulls_not_distinct,
						constraint_row.condeferrable AS deferrable,
						constraint_row.condeferred AS initially_deferred,
						pg_get_expr(
							constraint_row.conbin,
							constraint_row.conrelid,
							true
						) AS check_expression
					FROM pg_constraint constraint_row
					JOIN pg_class table_class ON table_class.oid = constraint_row.conrelid
					JOIN pg_namespace table_namespace
						ON table_namespace.oid = table_class.relnamespace
					LEFT JOIN pg_class referenced_class
						ON referenced_class.oid = constraint_row.confrelid
					LEFT JOIN pg_namespace referenced_namespace
						ON referenced_namespace.oid = referenced_class.relnamespace
					LEFT JOIN pg_index constraint_index
						ON constraint_index.indexrelid = constraint_row.conindid
					WHERE table_namespace.nspname IN ('auth', 'public')
						AND constraint_row.contype IN ('c', 'f', 'p', 'u')
				`,
			sql<GeneratedFunctionRow[]>`
					SELECT
						function_namespace.nspname AS function_schema,
						function_row.proname AS function_name,
						pg_get_function_identity_arguments(function_row.oid) AS identity_arguments,
						function_row.prorettype::regtype::text AS return_type,
						function_row.pronargs::integer AS argument_count,
						language_row.lanname AS language_name,
						function_row.prokind::text AS function_kind,
						function_row.provolatile::text AS volatility,
						function_row.proisstrict AS is_strict,
						function_row.prosecdef AS security_definer,
						function_row.proleakproof AS leakproof,
						function_row.proparallel::text AS parallel_safety,
						coalesce(function_row.proconfig, ARRAY[]::text[]) AS function_config,
						function_row.prosrc AS function_source
					FROM pg_proc function_row
					JOIN pg_namespace function_namespace
						ON function_namespace.oid = function_row.pronamespace
					JOIN pg_language language_row
						ON language_row.oid = function_row.prolang
						WHERE function_namespace.nspname !~ '^pg_'
							AND function_namespace.nspname <> 'information_schema'
							AND NOT EXISTS (
								SELECT 1
								FROM pg_catalog.pg_depend dependency
								WHERE dependency.classid = 'pg_proc'::regclass
									AND dependency.objid = function_row.oid
									AND dependency.deptype = 'e'
							)
					ORDER BY
						function_namespace.nspname,
						function_row.proname,
						pg_get_function_identity_arguments(function_row.oid)
				`,
			sql<OrganizationProvisioningCoverageRow[]>`
					SELECT
						count(*) FILTER (
							WHERE settings.organization_id IS NULL
						)::integer AS settings_missing,
						count(*) FILTER (
							WHERE NOT EXISTS (
								SELECT 1
								FROM public.workspaces workspace_row
								WHERE workspace_row.organization_id = organization_row.id
							)
						)::integer AS workspaces_missing,
						count(*) FILTER (
							WHERE NOT EXISTS (
								SELECT 1
								FROM public.idea_groups group_row
								WHERE group_row.organization_id = organization_row.id
									AND group_row.workspace_id IS NULL
									AND group_row.is_default = true
							)
						)::integer AS default_idea_groups_missing
					FROM auth.organization organization_row
					LEFT JOIN public.organization_settings settings
						ON settings.organization_id = organization_row.id
				`,
			sql<DatabaseContractTriggerRow[]>`
					SELECT
							trigger_row.tgname AS trigger_name,
							trigger_row.tgenabled::text AS trigger_enabled,
							trigger_row.tgtype::integer AS trigger_type,
							(trigger_row.tgconstraint <> 0) AS is_constraint_trigger,
							trigger_row.tgdeferrable AS is_deferrable,
							trigger_row.tginitdeferred AS initially_deferred,
							(trigger_row.tgparentid <> 0) AS has_parent_trigger,
							trigger_row.tgoldtable::text AS old_transition_table,
							trigger_row.tgnewtable::text AS new_transition_table,
							trigger_row.tgnargs::integer AS trigger_argument_count,
						encode(trigger_row.tgargs, 'hex') AS trigger_arguments_hex,
						(trigger_row.tgqual IS NOT NULL) AS has_when_predicate,
						ARRAY(
							SELECT watched_attribute.attname
							FROM unnest(trigger_row.tgattr::smallint[])
								WITH ORDINALITY AS watched_column(attnum, position)
							JOIN pg_attribute watched_attribute
								ON watched_attribute.attrelid = trigger_row.tgrelid
								AND watched_attribute.attnum = watched_column.attnum
							ORDER BY watched_column.position
						)::text[] AS watched_columns,
						table_namespace.nspname AS table_schema,
						table_row.relname AS table_name,
						function_namespace.nspname AS function_schema,
						function_row.proname AS function_name,
						pg_get_function_identity_arguments(function_row.oid) AS function_identity_arguments
					FROM pg_trigger trigger_row
					JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
					JOIN pg_namespace table_namespace
						ON table_namespace.oid = table_row.relnamespace
					JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
					JOIN pg_namespace function_namespace
						ON function_namespace.oid = function_row.pronamespace
					WHERE NOT trigger_row.tgisinternal
						AND table_namespace.nspname !~ '^pg_'
						AND table_namespace.nspname <> 'information_schema'
						ORDER BY table_namespace.nspname, table_row.relname, trigger_row.tgname
					`,
			sql<NonDrizzleRelationRow[]>`
						SELECT
							namespace_row.nspname AS schema_name,
							relation_row.relname AS relation_name,
							relation_row.relkind::text AS relation_kind
						FROM pg_catalog.pg_class relation_row
						JOIN pg_catalog.pg_namespace namespace_row
							ON namespace_row.oid = relation_row.relnamespace
						WHERE namespace_row.nspname !~ '^pg_'
							AND namespace_row.nspname <> 'information_schema'
							AND relation_row.relkind IN ('v', 'm')
							AND NOT EXISTS (
								SELECT 1
								FROM pg_catalog.pg_depend dependency
								WHERE dependency.classid = 'pg_class'::regclass
									AND dependency.objid = relation_row.oid
									AND dependency.deptype = 'e'
							)
						ORDER BY namespace_row.nspname, relation_row.relname
					`,
			sql<RowPolicyRow[]>`
						SELECT
							namespace_row.nspname AS schema_name,
							relation_row.relname AS table_name,
							policy_row.polname AS policy_name
						FROM pg_catalog.pg_policy policy_row
						JOIN pg_catalog.pg_class relation_row
							ON relation_row.oid = policy_row.polrelid
						JOIN pg_catalog.pg_namespace namespace_row
							ON namespace_row.oid = relation_row.relnamespace
						WHERE namespace_row.nspname !~ '^pg_'
							AND namespace_row.nspname <> 'information_schema'
						ORDER BY namespace_row.nspname, relation_row.relname, policy_row.polname
					`,
			sql<SegmentMemberCountCoverageRow[]>`
					SELECT count(*)::integer AS mismatched
					FROM public.segments segment_row
					WHERE segment_row.member_count <> (
						SELECT count(*)::integer
						FROM public.contact_segment_memberships membership_row
						WHERE membership_row.segment_id = segment_row.id
					)
				`,
		]);

		const foundSchemas = new Set(requiredSchemas.map((row) => row.schema_name));
		for (const requiredSchema of requiredDatabaseSchemas) {
			if (!foundSchemas.has(requiredSchema)) {
				failures.push(`missing required schema ${requiredSchema}`);
			}
		}

		const extensionStates = new Map(
			extensions.map((row) => [
				row.extension_name,
				{
					schema: row.extension_schema,
					version: row.extension_version,
				},
			]),
		);
		for (const extensionName of REQUIRED_BASELINE_EXTENSIONS) {
			const actualState = extensionStates.get(extensionName);
			const expectedSchema = REQUIRED_BASELINE_EXTENSION_SCHEMAS[extensionName];
			const expectedVersion =
				REQUIRED_DATABASE_EXTENSION_VERSIONS[extensionName];
			if (!actualState) {
				failures.push(`required ${extensionName} extension is not installed`);
			} else if (actualState.schema !== expectedSchema) {
				failures.push(
					`required ${extensionName} extension is not installed in ${expectedSchema}`,
				);
			} else if (
				expectedVersion !== undefined &&
				actualState.version !== expectedVersion
			) {
				failures.push(
					`required ${extensionName} extension is at version ${actualState.version}, expected ${expectedVersion}`,
				);
			}
		}

		const expectedTriggers = expectedDatabaseTriggers();
		const expectedTriggerKeys = new Set(
			expectedTriggers.map(databaseTriggerKey),
		);
		const generatedTriggerRows = databaseContractTriggers;
		for (const expectedTrigger of expectedTriggers) {
			const expectedKey = databaseTriggerKey(expectedTrigger);
			const matches = generatedTriggerRows.filter(
				(row) => actualDatabaseTriggerKey(row) === expectedKey,
			);
			const actualTrigger = matches[0];
			if (matches.length !== 1 || !actualTrigger) {
				failures.push(`missing unique generated trigger ${expectedKey}`);
				continue;
			}

			if (actualTrigger.trigger_enabled !== "O") {
				failures.push(`${expectedKey} is not enabled for normal writes`);
			}
			if (actualTrigger.trigger_type !== expectedTrigger.triggerType) {
				failures.push(
					`${expectedKey} tgtype is ${actualTrigger.trigger_type}, expected ${expectedTrigger.triggerType}`,
				);
			}
			if (
				actualTrigger.is_constraint_trigger !==
					(expectedTrigger.isConstraintTrigger ?? false) ||
				actualTrigger.is_deferrable !==
					(expectedTrigger.isDeferrable ?? false) ||
				actualTrigger.initially_deferred !==
					(expectedTrigger.isInitiallyDeferred ?? false) ||
				actualTrigger.has_parent_trigger ||
				actualTrigger.old_transition_table !==
					(expectedTrigger.oldTransitionTable ?? null) ||
				actualTrigger.new_transition_table !==
					(expectedTrigger.newTransitionTable ?? null)
			) {
				failures.push(
					`${expectedKey} has unexpected constraint, deferral, inheritance, or transition-table metadata`,
				);
			}
			if (actualTrigger.has_when_predicate) {
				failures.push(`${expectedKey} has an unexpected WHEN predicate`);
			}
			if (
				JSON.stringify(actualTrigger.watched_columns) !==
				JSON.stringify(expectedTrigger.watchedColumns)
			) {
				failures.push(
					`${expectedKey} watches ${JSON.stringify(actualTrigger.watched_columns)}, expected ${JSON.stringify(expectedTrigger.watchedColumns)}`,
				);
			}
			if (
				actualTrigger.trigger_argument_count !==
				expectedTrigger.arguments.length
			) {
				failures.push(
					`${expectedKey} has ${actualTrigger.trigger_argument_count} trigger arguments, expected ${expectedTrigger.arguments.length}`,
				);
			}
			const expectedArgumentsHex = encodeTriggerArguments(
				expectedTrigger.arguments,
			);
			if (actualTrigger.trigger_arguments_hex !== expectedArgumentsHex) {
				failures.push(`${expectedKey} has unexpected trigger arguments`);
			}
			if (
				actualTrigger.function_schema !== expectedTrigger.functionSchema ||
				actualTrigger.function_name !== expectedTrigger.functionName ||
				actualTrigger.function_identity_arguments !== ""
			) {
				failures.push(
					`${expectedKey} invokes ${actualTrigger.function_schema}.${actualTrigger.function_name}(${actualTrigger.function_identity_arguments}), expected ${expectedTrigger.functionSchema}.${expectedTrigger.functionName}()`,
				);
			}
		}
		for (const actualTrigger of generatedTriggerRows) {
			const actualKey = actualDatabaseTriggerKey(actualTrigger);
			if (!expectedTriggerKeys.has(actualKey)) {
				failures.push(`unexpected RelayAPI generated trigger ${actualKey}`);
			}
		}

		const expectedFunctions = expectedGeneratedFunctions();
		const expectedFunctionKeys = new Set(
			expectedFunctions.map(
				(row) => `${row.functionSchema}.${row.functionName}()`,
			),
		);
		for (const expectedFunction of expectedFunctions) {
			const expectedKey = `${expectedFunction.functionSchema}.${expectedFunction.functionName}()`;
			const matches = generatedFunctions.filter(
				(row) =>
					row.function_schema === expectedFunction.functionSchema &&
					row.function_name === expectedFunction.functionName &&
					row.identity_arguments === "",
			);
			const actualFunction = matches[0];
			if (matches.length !== 1 || !actualFunction) {
				failures.push(`missing unique generated function ${expectedKey}`);
				continue;
			}

			const expectedCatalogAttributes = {
				returnType: "trigger",
				argumentCount: 0,
				languageName: "plpgsql",
				functionKind: "f",
				volatility: "v",
				isStrict: false,
				securityDefiner: false,
				leakproof: false,
				parallelSafety: "u",
				functionConfig: expectedFunction.functionConfig,
			};
			const actualCatalogAttributes = {
				returnType: actualFunction.return_type,
				argumentCount: actualFunction.argument_count,
				languageName: actualFunction.language_name,
				functionKind: actualFunction.function_kind,
				volatility: actualFunction.volatility,
				isStrict: actualFunction.is_strict,
				securityDefiner: actualFunction.security_definer,
				leakproof: actualFunction.leakproof,
				parallelSafety: actualFunction.parallel_safety,
				functionConfig: actualFunction.function_config,
			};
			if (
				JSON.stringify(actualCatalogAttributes) !==
				JSON.stringify(expectedCatalogAttributes)
			) {
				failures.push(
					`${expectedKey} catalog attributes differ: found ${JSON.stringify(actualCatalogAttributes)}, expected ${JSON.stringify(expectedCatalogAttributes)}`,
				);
			}
			if (actualFunction.function_source !== expectedFunction.functionSource) {
				failures.push(
					`${expectedKey} function source differs from the generator`,
				);
			}
		}
		for (const actualFunction of generatedFunctions) {
			const actualKey = `${actualFunction.function_schema}.${actualFunction.function_name}(${actualFunction.identity_arguments})`;
			if (!expectedFunctionKeys.has(actualKey)) {
				failures.push(`unexpected RelayAPI generated function ${actualKey}`);
			}
		}

		const provisioningCoverage = organizationProvisioningCoverage[0];
		if (!provisioningCoverage) {
			failures.push("could not inspect organization provisioning coverage");
		} else {
			if (provisioningCoverage.settings_missing !== 0) {
				failures.push(
					`${provisioningCoverage.settings_missing} organizations lack organization_settings`,
				);
			}
			if (provisioningCoverage.workspaces_missing !== 0) {
				failures.push(
					`${provisioningCoverage.workspaces_missing} organizations lack an initial workspace`,
				);
			}
			if (provisioningCoverage.default_idea_groups_missing !== 0) {
				failures.push(
					`${provisioningCoverage.default_idea_groups_missing} organizations lack a default Idea group`,
				);
			}
		}

		const segmentCoverage = segmentMemberCountCoverage[0];
		if (!segmentCoverage) {
			failures.push("could not inspect segment member_count coverage");
		} else if (segmentCoverage.mismatched !== 0) {
			failures.push(
				`${segmentCoverage.mismatched} segments have a stale member_count`,
			);
		}
		failures.push(...compareCatalog(expected, groupActualCatalog(catalogRows)));

		const actualIndexMap = new Map(
			actualDeclaredIndexes.map((index) => [
				`${index.schema_name}.${index.table_name}.${index.index_name}`,
				index,
			]),
		);
		const expectedIndexKeys = new Set<string>();
		for (const index of expectedDeclaredIndexes) {
			const key = `${index.schemaName}.${index.tableName}.${index.name}`;
			expectedIndexKeys.add(key);
			const actualIndex = actualIndexMap.get(key);
			if (!actualIndex) {
				failures.push(`missing declarative index ${key}`);
				continue;
			}
			if (!actualIndex.valid) failures.push(`${key} is not valid`);
			if (!actualIndex.ready) failures.push(`${key} is not ready`);
			if (!actualIndex.live) failures.push(`${key} is not live`);
			if (actualIndex.unique !== index.unique) {
				failures.push(`${key} uniqueness differs from the Drizzle schema`);
			}
			if (actualIndex.method !== index.method) {
				failures.push(
					`${key} uses ${actualIndex.method}, expected ${index.method}`,
				);
			}
			if (
				actualIndex.key_column_count !== index.columns.length ||
				actualIndex.total_column_count !== index.columns.length
			) {
				failures.push(
					`${key} has ${actualIndex.key_column_count} key/${actualIndex.total_column_count} total columns, expected ${index.columns.length} with no INCLUDE columns`,
				);
			}
			const actualColumns = actualIndex.column_expressions.map(
				(expression, position): IndexColumnDefinition => ({
					expression: normalizeExpression(expression) ?? expression,
					order: actualIndex.column_orders[position] ?? "asc",
					nulls: actualIndex.column_nulls[position] ?? "last",
					opClass:
						actualIndex.column_opclasses[position] === "NULL"
							? null
							: (actualIndex.column_opclasses[position] ?? null),
				}),
			);
			if (JSON.stringify(actualColumns) !== JSON.stringify(index.columns)) {
				failures.push(
					`${key} columns differ: found ${JSON.stringify(actualColumns)}, expected ${JSON.stringify(index.columns)}`,
				);
			}
			const actualPredicate = normalizeExpression(actualIndex.predicate);
			if (actualPredicate !== index.predicate) {
				failures.push(
					`${key} predicate is ${JSON.stringify(actualPredicate)}, expected ${JSON.stringify(index.predicate)}`,
				);
			}
			const actualStorageParameters = [
				...actualIndex.storage_parameters,
			].sort();
			if (
				JSON.stringify(actualStorageParameters) !==
				JSON.stringify(index.storageParameters)
			) {
				failures.push(
					`${key} storage parameters differ from the Drizzle schema`,
				);
			}
		}
		for (const key of actualIndexMap.keys()) {
			if (!expectedIndexKeys.has(key)) {
				failures.push(`unexpected declarative index ${key}`);
			}
		}

		const actualConstraintMap = new Map(
			actualDeclaredConstraints.map((constraint) => [
				`${constraint.schema_name}.${constraint.table_name}.${constraint.constraint_name}`,
				constraint,
			]),
		);
		const expectedConstraintKeys = new Set<string>();
		for (const constraint of expectedDeclaredConstraints) {
			const key = `${constraint.schemaName}.${constraint.tableName}.${constraint.name}`;
			expectedConstraintKeys.add(key);
			const actualConstraint = actualConstraintMap.get(key);
			if (!actualConstraint) {
				failures.push(`missing declarative constraint ${key}`);
				continue;
			}
			if (actualConstraint.type !== constraint.type) {
				failures.push(`${key} has an unexpected constraint type`);
			}
			if (!actualConstraint.validated) {
				failures.push(`${key} is not validated`);
			}
			const expectedDefinition = {
				columns: constraint.columns,
				foreignSchema: constraint.foreignSchema,
				foreignTable: constraint.foreignTable,
				foreignColumns: constraint.foreignColumns,
				onUpdate: constraint.onUpdate,
				onDelete: constraint.onDelete,
				matchType: constraint.matchType,
				nullsNotDistinct: constraint.nullsNotDistinct,
				deferrable: constraint.deferrable,
				initiallyDeferred: constraint.initiallyDeferred,
				checkExpression: constraint.checkExpression,
			};
			const actualDefinition = {
				columns: constraint.type === "c" ? [] : actualConstraint.columns,
				foreignSchema: actualConstraint.foreign_schema,
				foreignTable: actualConstraint.foreign_table,
				foreignColumns: actualConstraint.foreign_columns,
				onUpdate: actualConstraint.on_update,
				onDelete: actualConstraint.on_delete,
				matchType: actualConstraint.match_type,
				nullsNotDistinct: actualConstraint.nulls_not_distinct,
				deferrable: actualConstraint.deferrable,
				initiallyDeferred: actualConstraint.initially_deferred,
				checkExpression: normalizeExpression(actualConstraint.check_expression),
			};
			if (
				JSON.stringify(actualDefinition) !== JSON.stringify(expectedDefinition)
			) {
				failures.push(
					`${key} definition differs: found ${JSON.stringify(actualDefinition)}, expected ${JSON.stringify(expectedDefinition)}`,
				);
			}
		}
		for (const key of actualConstraintMap.keys()) {
			if (!expectedConstraintKeys.has(key)) {
				failures.push(`unexpected declarative constraint ${key}`);
			}
		}

		const table = automationTable[0];
		if (!table) {
			failures.push("automation_step_runs catalog row is missing");
		} else {
			if (table.relkind !== "r") {
				failures.push(
					`automation_step_runs must be an ordinary table (relkind=r), found ${table.relkind}`,
				);
			}
			if (
				table.relispartition ||
				table.parent_count !== 0 ||
				table.child_count !== 0
			) {
				failures.push(
					"automation_step_runs must not participate in partitioning",
				);
			}
		}

		if (
			primaryKey.length !== 1 ||
			primaryKey[0]?.column_names.join(",") !== "id"
		) {
			failures.push(
				"automation_step_runs must have exactly one primary key on (id)",
			);
		}

		const expectedIndexes = new Map<string, string[]>([
			[
				"idx_contact_controls_per_auto",
				["CREATE UNIQUE INDEX", "USING btree", "automation_id IS NOT NULL"],
			],
			[
				"idx_contact_controls_global",
				["CREATE UNIQUE INDEX", "USING btree", "automation_id IS NULL"],
			],
			[
				"idx_automation_entrypoints_webhook_slug",
				["CREATE UNIQUE INDEX", "webhook_slug", "kind = 'webhook_inbound'"],
			],
			[
				"idx_automation_runs_active_uniq",
				["CREATE UNIQUE INDEX", "status = ANY", "active", "waiting"],
			],
			["idx_step_runs_executed_brin", ["USING brin", "executed_at"]],
			["inbox_msg_text_trgm_idx", ["USING gin", "gin_trgm_ops"]],
			[
				"publish_outbox_retention_idx",
				["USING btree (status, dispatched_at, id)"],
			],
			[
				"social_accounts_sms_webhook_route_idx",
				[
					"USING btree (platform_account_id)",
					"platform = 'sms'::platform",
					"lifecycle_status = 'active'::text",
				],
			],
		]);
		const foundIndexes = new Map(
			criticalIndexes.map((row) => [row.indexname, row.indexdef]),
		);
		for (const [name, fragments] of expectedIndexes) {
			const definition = foundIndexes.get(name);
			if (!definition) {
				failures.push(`missing critical index ${name}`);
				continue;
			}
			for (const fragment of fragments) {
				if (!definition.includes(fragment)) {
					failures.push(`${name} does not preserve ${fragment}`);
				}
			}
		}

		const registry = nonDrizzleDdlRegistry();
		const actualViews = nonDrizzleRelations
			.filter((row) => row.relation_kind === "v")
			.map((row) => `${row.schema_name}.${row.relation_name}`)
			.sort();
		const actualMaterializedViews = nonDrizzleRelations
			.filter((row) => row.relation_kind === "m")
			.map((row) => `${row.schema_name}.${row.relation_name}`)
			.sort();
		const actualPolicies = rowPolicies
			.map((row) => `${row.schema_name}.${row.table_name}.${row.policy_name}`)
			.sort();
		for (const [kind, actualObjects, expectedObjects] of [
			["view", actualViews, registry.views],
			[
				"materialized view",
				actualMaterializedViews,
				registry.materializedViews,
			],
			["row policy", actualPolicies, registry.policies],
		] as const) {
			if (
				JSON.stringify(actualObjects) !==
				JSON.stringify([...expectedObjects].sort())
			) {
				failures.push(
					`non-Drizzle ${kind} registry differs: found ${JSON.stringify(actualObjects)}, expected ${JSON.stringify(expectedObjects)}`,
				);
			}
		}

		const foundEnums = new Map(
			enumValues.map((row) => [
				`${row.schema_name}.${row.type_name}`,
				row.values,
			]),
		);
		const expectedEnumKeys = new Set<string>();
		for (const enumType of expectedEnumTypes) {
			const key = `${enumType.schemaName}.${enumType.typeName}`;
			expectedEnumKeys.add(key);
			if (foundEnums.get(key)?.join("\0") !== enumType.values.join("\0")) {
				failures.push(`${key} enum values differ from the Drizzle schema`);
			}
		}
		for (const key of foundEnums.keys()) {
			if (!expectedEnumKeys.has(key)) failures.push(`unexpected enum ${key}`);
		}

		if (invalidConstraints.length > 0) {
			failures.push(
				`unvalidated constraints: ${invalidConstraints.map((row) => row.conname).join(", ")}`,
			);
		}

		const id = idColumn[0];
		if (
			id?.data_type !== "bigint" ||
			id.is_nullable !== "NO" ||
			!id.column_default?.startsWith("nextval(")
		) {
			failures.push(
				"automation_step_runs.id must be a non-null bigserial-style bigint",
			);
		}

		if (failures.length > 0) {
			throw new Error(
				`Migration verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
			);
		}

		const publicTableCount = expected.filter(
			(table) => table.schemaName === "public",
		).length;
		const authTableCount = expected.length - publicTableCount;
		console.log(
			`Migration catalog and full Drizzle schema verified (${publicTableCount} public tables, ${authTableCount} auth tables, ${REQUIRED_BASELINE_EXTENSIONS.join(", ")}, ordinary automation_step_runs).`,
		);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

await verify();
