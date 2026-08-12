import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { auditDurableDomains } from "../src/domain-contract-audit";
import {
	ORGANIZATION_PROVISIONING_CONTRACT,
	PARENT_IDENTITY_PROJECTION_FUNCTION,
	PARENT_IDENTITY_PROJECTIONS,
	SEGMENT_MEMBER_COUNT_CONTRACT,
	WORKSPACE_REQUIREMENT_CONTRACT,
	workspaceRequirementTriggerName,
} from "../src/provisioning-contracts";
import * as schema from "../src/schema";
import { SCHEMA_SCOPE_CONTRACTS } from "../src/schema-contracts";
import { auditSchemaInvariants } from "../src/schema-invariant-audit";
import { USAGE_BUCKET_PROJECTION_CONTRACT } from "../src/usage-projection-contract";
import { stripSqlComments } from "./migration-policy-contract";
import { readBaselineGeneration } from "./rebuild-baseline";
import { AUTOMATION_CONVERSION_EVENT_FACT_CONTRACT } from "./render-automation-conversion-event-invariant-sql";
import {
	auditDatabaseExtensionLifecycle,
	auditDatabasePrerequisiteRegistries,
	BASELINE_PREAMBLE_MARKER,
	COLLAPSE_BASELINE_EXTENSION_SCHEMAS,
	COLLAPSE_BASELINE_EXTENSIONS,
	COLLAPSE_BASELINE_SCHEMAS,
	renderBaselinePreambleSql,
} from "./render-baseline-preamble-sql";
import { CONTACT_SUBSCRIPTION_EVENT_APPEND_ONLY_CONTRACT } from "./render-contact-subscription-event-invariant-sql";
import { CUSTOM_MIGRATION_SQL_MARKER } from "./render-custom-migration-sql";

const failures: string[] = [];
failures.push(...auditDatabasePrerequisiteRegistries());

type MigrationJournal = {
	entries: Array<{ tag: string }>;
};

function normalizeMigrationSql(source: string): string {
	return stripSqlComments(source)
		.replace(/"([a-z_][a-z0-9_]*)"/gi, "$1")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

function countOccurrences(source: string, fragment: string): number {
	let count = 0;
	let offset = 0;
	while (true) {
		const index = source.indexOf(fragment, offset);
		if (index === -1) return count;
		count += 1;
		offset = index + fragment.length;
	}
}

const migrationDirectory = process.env.RELAYAPI_VERIFY_MIGRATION_DIRECTORY
	? resolve(process.env.RELAYAPI_VERIFY_MIGRATION_DIRECTORY)
	: fileURLToPath(new URL("../drizzle", import.meta.url));
const baselineGenerationPath = process.env.RELAYAPI_VERIFY_BASELINE_GENERATION
	? resolve(process.env.RELAYAPI_VERIFY_BASELINE_GENERATION)
	: fileURLToPath(new URL("../baseline-generation.json", import.meta.url));
const baselineGeneration = readBaselineGeneration(baselineGenerationPath);
const baselineFilename = `${baselineGeneration.baseline.tag}.sql`;
const baselineSqlSource = readFileSync(
	join(migrationDirectory, baselineFilename),
	"utf8",
);
const migrationJournal = JSON.parse(
	readFileSync(join(migrationDirectory, "meta", "_journal.json"), "utf8"),
) as MigrationJournal;
const rawMigrationSqlByTag = Object.fromEntries(
	migrationJournal.entries.map(({ tag }) => [
		tag,
		readFileSync(join(migrationDirectory, `${tag}.sql`), "utf8"),
	]),
);
const migrationSqlByTag = Object.fromEntries(
	Object.entries(rawMigrationSqlByTag).map(([tag, source]) => [
		tag,
		normalizeMigrationSql(source),
	]),
);
const migrationSql = Object.values(migrationSqlByTag).join(" ");
const provisioning = ORGANIZATION_PROVISIONING_CONTRACT;
const workspaceRequirement = WORKSPACE_REQUIREMENT_CONTRACT;

failures.push(
	...auditDatabaseExtensionLifecycle(rawMigrationSqlByTag, {
		migrationOrder: migrationJournal.entries.map(({ tag }) => tag),
	}),
);
if (!baselineSqlSource.startsWith(renderBaselinePreambleSql())) {
	failures.push(
		`${baselineFilename} must start with the generated database preamble`,
	);
}
if (countOccurrences(baselineSqlSource, BASELINE_PREAMBLE_MARKER) !== 1) {
	failures.push(
		`${baselineFilename} must contain exactly one generated database preamble marker`,
	);
}
for (const schemaName of COLLAPSE_BASELINE_SCHEMAS) {
	const statement = `CREATE SCHEMA IF NOT EXISTS "${schemaName}";`;
	if (countOccurrences(baselineSqlSource, statement) !== 1) {
		failures.push(
			`${baselineFilename} must contain exactly one required preamble statement: ${statement}`,
		);
	}
}
for (const extensionName of COLLAPSE_BASELINE_EXTENSIONS) {
	const statement = `CREATE EXTENSION IF NOT EXISTS "${extensionName}" WITH SCHEMA "${COLLAPSE_BASELINE_EXTENSION_SCHEMAS[extensionName]}";`;
	if (countOccurrences(baselineSqlSource, statement) !== 1) {
		failures.push(
			`${baselineFilename} must contain exactly one required preamble statement: ${statement}`,
		);
	}
}
if (countOccurrences(baselineSqlSource, CUSTOM_MIGRATION_SQL_MARKER) !== 1) {
	failures.push(
		`${baselineFilename} must contain exactly one generated non-declarative contract block`,
	);
}
const requiredBaselineFragments = [
	`function ${provisioning.functionSchema}.${provisioning.functionName}`,
	`trigger ${provisioning.triggerName}`,
	`after insert on ${provisioning.organizationSchema}.${provisioning.organizationTable}`,
	`for each row execute function ${provisioning.functionSchema}.${provisioning.functionName}()`,
	`insert into public.${provisioning.settingsTable} (organization_id)`,
	`insert into public.${provisioning.workspaceTable} (id, organization_id, name, slug, lifecycle_status)`,
	`insert into public.${provisioning.ideaGroupTable} (id, organization_id, workspace_id, name, position, is_default, revision)`,
	"on conflict (organization_id) do nothing",
	"gen_random_uuid()",
	`'${provisioning.initialWorkspaceName.toLowerCase()}'`,
	`'${provisioning.initialWorkspaceSlug.toLowerCase()}'`,
	`'${provisioning.defaultIdeaGroupName.toLowerCase()}'`,
	"where not exists",
	"select id from auth.organization",
];
for (const fragment of requiredBaselineFragments) {
	if (!migrationSql.includes(fragment)) {
		failures.push(
			`migration history lacks organization provisioning contract fragment: ${fragment}`,
		);
	}
}
for (const tableName of [
	provisioning.settingsTable,
	provisioning.workspaceTable,
	provisioning.ideaGroupTable,
]) {
	const fragment = `insert into public.${tableName}`;
	if (countOccurrences(migrationSql, fragment) < 2) {
		failures.push(
			`migration history must provision and backfill ${tableName} (expected at least two INSERT statements)`,
		);
	}
}

const projectionFunction = PARENT_IDENTITY_PROJECTION_FUNCTION;
for (const fragment of [
	`function ${projectionFunction.functionSchema}.${projectionFunction.functionName}`,
	"set search_path = pg_catalog, public",
	"new := jsonb_populate_record(new, projected_values)",
	"where parent_row.id = $1 and parent_row.organization_id = $2",
]) {
	if (!migrationSql.includes(fragment)) {
		failures.push(
			`migration history lacks parent identity projection fragment: ${fragment}`,
		);
	}
}
for (const contract of PARENT_IDENTITY_PROJECTIONS) {
	const mapping = contract.projections
		.map(({ parentColumn, childColumn }) => `${parentColumn}:${childColumn}`)
		.join(",");
	for (const fragment of [
		`trigger ${contract.triggerName}`,
		`on public.${contract.childTable}`,
		`'${contract.parentTable}', '${contract.childParentColumn}', '${mapping}'`,
	]) {
		if (!migrationSql.includes(fragment)) {
			failures.push(
				`migration history lacks ${contract.triggerName} projection fragment: ${fragment}`,
			);
		}
	}
}

for (const fragment of [
	`function ${workspaceRequirement.functionSchema}.${workspaceRequirement.functionName}`,
	`from public.${workspaceRequirement.settingsTable} as settings_row`,
	`select settings_row.${workspaceRequirement.settingsColumn}`,
	`from public.${workspaceRequirement.workspaceTable} as workspace_row`,
	"workspace_row.lifecycle_status",
	`workspace_state <> '${workspaceRequirement.activeWorkspaceState}'`,
	"inactive_row and tg_op = 'update'",
	"new.workspace_id is not distinct from old.workspace_id",
	"for share",
	"new.workspace_id is not null",
	"errcode = '23514'",
]) {
	if (!migrationSql.includes(fragment)) {
		failures.push(
			`migration history lacks Require Workspace ID policy fragment: ${fragment}`,
		);
	}
}
for (const tableName of workspaceRequirement.tables) {
	const triggerName = workspaceRequirementTriggerName(tableName);
	for (const fragment of [
		`trigger ${triggerName}`,
		`on public.${tableName}`,
		`execute function ${workspaceRequirement.functionSchema}.${workspaceRequirement.functionName}`,
	]) {
		if (!migrationSql.includes(fragment)) {
			failures.push(
				`migration history lacks ${triggerName} policy fragment: ${fragment}`,
			);
		}
	}
}

const segmentCount = SEGMENT_MEMBER_COUNT_CONTRACT;
for (const fragment of [
	`function ${segmentCount.functionSchema}.${segmentCount.functionName}`,
	`trigger ${segmentCount.triggerName}`,
	`on public.${segmentCount.membershipTable}`,
	`update public.${segmentCount.segmentTable} as segment_row`,
	`from public.${segmentCount.membershipTable} as membership_row`,
	"set member_count = member_count + 1",
	"set member_count = member_count - 1",
]) {
	if (!migrationSql.includes(fragment)) {
		failures.push(
			`migration history lacks segment member-count contract fragment: ${fragment}`,
		);
	}
}

const usageProjection = USAGE_BUCKET_PROJECTION_CONTRACT;
for (const fragment of [
	`function ${usageProjection.projectionFunctionSchema}.${usageProjection.projectionFunctionName}`,
	`trigger ${usageProjection.triggers.insert.name}`,
	`trigger ${usageProjection.triggers.update.name}`,
	`trigger ${usageProjection.triggers.delete.name}`,
	`trigger ${usageProjection.triggers.bucketGuard.name}`,
	`referencing new table as ${usageProjection.triggers.insert.newTransitionTable}`,
	`referencing old table as ${usageProjection.triggers.update.oldTransitionTable} new table as ${usageProjection.triggers.update.newTransitionTable}`,
	"for each statement",
	"sum(reserved_delta)::bigint",
	"sum(committed_delta)::bigint",
	`set_config('${usageProjection.ownershipMarker}', 'on', true)`,
	`set_config('${usageProjection.ownershipMarker}', 'off', true)`,
	"pg_trigger_depth() < 2",
	`coalesce(current_setting('${usageProjection.ownershipMarker}', true), 'off') <> 'on'`,
	`function ${usageProjection.guardFunctionSchema}.${usageProjection.guardFunctionName}`,
	"usage bucket counters are owned by usage_reservations",
]) {
	if (!migrationSql.includes(fragment)) {
		failures.push(
			`migration history lacks usage bucket projection fragment: ${fragment}`,
		);
	}
}

const conversionFact = AUTOMATION_CONVERSION_EVENT_FACT_CONTRACT;
for (const fragment of [
	`function ${conversionFact.functionSchema}.${conversionFact.functionName}`,
	`trigger ${conversionFact.triggerName}`,
	`before update on ${conversionFact.tableSchema}.${conversionFact.tableName}`,
	"automation conversion fact columns are immutable",
	...conversionFact.immutableColumns.map(
		(column) => `old.${column} is distinct from new.${column}`,
	),
]) {
	if (!migrationSql.includes(fragment)) {
		failures.push(
			`migration history lacks automation conversion fact invariant fragment: ${fragment}`,
		);
	}
}

const subscriptionEvent = CONTACT_SUBSCRIPTION_EVENT_APPEND_ONLY_CONTRACT;
for (const fragment of [
	`function ${subscriptionEvent.functionSchema}.${subscriptionEvent.functionName}`,
	`trigger ${subscriptionEvent.triggerName}`,
	`before update on ${subscriptionEvent.tableSchema}.${subscriptionEvent.tableName}`,
	"contact subscription events are append-only",
]) {
	if (!migrationSql.includes(fragment)) {
		failures.push(
			`migration history lacks contact subscription event invariant fragment: ${fragment}`,
		);
	}
}

const configs: Array<ReturnType<typeof getTableConfig>> = [];
for (const value of Object.values(schema)) {
	if (!is(value, PgTable)) continue;
	const config = getTableConfig(value);
	if ((config.schema ?? "public") === "public") configs.push(config);
}
const tables = new Map(configs.map((table) => [table.name, table]));
const invariantAudit = auditSchemaInvariants(configs);
failures.push(...invariantAudit.failures);
const domainAudit = auditDurableDomains(
	Object.values(schema)
		.filter((value) => is(value, PgTable))
		.map((value) => getTableConfig(value)),
);
failures.push(...domainAudit.failures);

const projectionTriggerNames = new Set<string>();
for (const contract of PARENT_IDENTITY_PROJECTIONS) {
	if (projectionTriggerNames.has(contract.triggerName)) {
		failures.push(`duplicate projection trigger ${contract.triggerName}`);
	}
	projectionTriggerNames.add(contract.triggerName);

	const child = tables.get(contract.childTable);
	const parent = tables.get(contract.parentTable);
	if (!child) {
		failures.push(`${contract.triggerName} child table is missing`);
		continue;
	}
	if (!parent) {
		failures.push(`${contract.triggerName} parent table is missing`);
		continue;
	}
	const childColumns = new Set(child.columns.map((column) => column.name));
	const parentColumns = new Set(parent.columns.map((column) => column.name));
	for (const columnName of [contract.childParentColumn, "organization_id"]) {
		if (!childColumns.has(columnName)) {
			failures.push(`${contract.triggerName} child lacks ${columnName}`);
		}
	}
	for (const columnName of ["id", "organization_id"]) {
		if (!parentColumns.has(columnName)) {
			failures.push(`${contract.triggerName} parent lacks ${columnName}`);
		}
	}
	for (const { parentColumn, childColumn } of contract.projections) {
		if (!parentColumns.has(parentColumn)) {
			failures.push(
				`${contract.triggerName} parent lacks projected ${parentColumn}`,
			);
		}
		if (!childColumns.has(childColumn)) {
			failures.push(
				`${contract.triggerName} child lacks projected ${childColumn}`,
			);
		}
	}
}

for (const tableName of workspaceRequirement.tables) {
	const table = tables.get(tableName);
	if (!table) {
		failures.push(
			`Require Workspace ID contract references missing ${tableName}`,
		);
		continue;
	}
	const columns = new Set(table.columns.map((column) => column.name));
	for (const required of ["organization_id", "workspace_id"]) {
		if (!columns.has(required)) {
			failures.push(
				`Require Workspace ID table ${tableName} lacks ${required}`,
			);
		}
	}
	const inactiveState = workspaceRequirement.inactiveStates[tableName];
	if (inactiveState && !columns.has(inactiveState.column)) {
		failures.push(
			`Require Workspace ID inactive-state contract for ${tableName} lacks ${inactiveState.column}`,
		);
	}

	const requirementTrigger = workspaceRequirementTriggerName(tableName);
	if (!requirementTrigger.startsWith("zz_require_workspace_")) {
		failures.push(
			`${requirementTrigger} must retain the zz_require_workspace_ prefix`,
		);
	}
	for (const projection of PARENT_IDENTITY_PROJECTIONS.filter(
		(contract) => contract.childTable === tableName,
	)) {
		// PostgreSQL fires same-kind triggers in alphabetical name order. Parent
		// identity must be projected before workspace policy evaluates the row.
		if (projection.triggerName >= requirementTrigger) {
			failures.push(
				`${requirementTrigger} must sort after ${projection.triggerName} on ${tableName}`,
			);
		}
	}
}

const contracts = new Map<string, (typeof SCHEMA_SCOPE_CONTRACTS)[number]>();
for (const contract of SCHEMA_SCOPE_CONTRACTS) {
	if (contracts.has(contract.tableName)) {
		failures.push(`duplicate contract for ${contract.tableName}`);
	}
	contracts.set(contract.tableName, contract);
	if (!tables.has(contract.tableName)) {
		failures.push(`contract references missing table ${contract.tableName}`);
	}
}

for (const table of configs) {
	const columnNames = new Set(table.columns.map((column) => column.name));
	if (
		(columnNames.has("workspace_id") || columnNames.has("scope_key")) &&
		!contracts.has(table.name)
	) {
		failures.push(
			`${table.name} has workspace/scope identity but no schema contract`,
		);
	}
}

for (const contract of SCHEMA_SCOPE_CONTRACTS) {
	const table = tables.get(contract.tableName);
	if (!table || contract.class === "tombstone") continue;
	const columns = new Map(table.columns.map((column) => [column.name, column]));

	const requiredColumns =
		contract.class === "organization_definition"
			? ["organization_id"]
			: ["organization_id", "scope_key"];
	for (const required of requiredColumns) {
		if (!columns.has(required)) {
			failures.push(`${table.name} (${contract.class}) lacks ${required}`);
		}
	}

	if (contract.class === "organization_definition") {
		for (const forbidden of ["workspace_id", "scope_key"]) {
			if (columns.has(forbidden)) {
				failures.push(
					`${table.name} (${contract.class}) must remain organization-global and cannot expose ${forbidden}`,
				);
			}
		}
		const hasOrganizationIdentity = table.uniqueConstraints.some(
			(constraint) => {
				const names = constraint.columns.map((column) => column.name);
				return (
					names.length === 2 &&
					names[0] === "id" &&
					names[1] === "organization_id"
				);
			},
		);
		if (!hasOrganizationIdentity) {
			failures.push(
				`${table.name} lacks UNIQUE (id, organization_id) organization-global identity`,
			);
		}
		continue;
	}

	if (
		(contract.class === "operational_root" ||
			contract.class === "shared_definition") &&
		!columns.has("workspace_id")
	) {
		failures.push(`${table.name} (${contract.class}) lacks workspace_id`);
	}

	if (
		contract.class === "operational_root" ||
		contract.class === "shared_definition"
	) {
		const scopeKey = columns.get("scope_key");
		if (!scopeKey?.notNull || !scopeKey.generated) {
			failures.push(
				`${table.name}.scope_key must be a NOT NULL generated column`,
			);
		}

		const hasIdentityUnique = table.uniqueConstraints.some((constraint) => {
			const names = constraint.columns.map((column) => column.name);
			return (
				names.length === 3 &&
				names[0] === "id" &&
				names[1] === "organization_id" &&
				names[2] === "scope_key"
			);
		});
		if (!hasIdentityUnique) {
			failures.push(
				`${table.name} lacks UNIQUE (id, organization_id, scope_key)`,
			);
		}
	}

	for (const foreignKey of table.foreignKeys) {
		const reference = foreignKey.reference();
		const localNames = reference.columns.map((column) => column.name);
		if (
			localNames.includes("workspace_id") &&
			foreignKey.onDelete === "set null"
		) {
			const contract = contracts.get(table.name);
			const intentionalAuditDetach =
				contract?.class === "audit_evidence" &&
				"workspaceDetachOnDelete" in contract &&
				contract.workspaceDetachOnDelete === true &&
				localNames.length === 1;
			if (!intentionalAuditDetach) {
				failures.push(
					`${table.name}.${foreignKey.getName()} promotes workspace ownership with ON DELETE SET NULL`,
				);
			}
		}
	}
}

if (failures.length > 0) {
	throw new Error(
		`Schema contract verification failed:\n${failures
			.map((failure) => `- ${failure}`)
			.join("\n")}`,
	);
}

console.log(
	`Schema contracts verified (${SCHEMA_SCOPE_CONTRACTS.length} scope contracts, ${configs.length} public tables, ${invariantAudit.candidates.length} invariant candidates, ${invariantAudit.exceptionCount} documented exceptions, ${domainAudit.candidates.length} durable domain contracts).`,
);
