import { is } from "drizzle-orm";
import {
	type getTableConfig,
	PgDialect,
	PgEnumColumn,
	PgEnumObjectColumn,
} from "drizzle-orm/pg-core";
import {
	SCHEMA_INVARIANT_EXCEPTIONS,
	type SchemaInvariantCategory,
	type SchemaInvariantException,
} from "./schema-contracts";

type PublicTableConfig = ReturnType<typeof getTableConfig>;
type PublicColumn = PublicTableConfig["columns"][number];

export type SchemaInvariantCandidate = {
	tableName: string;
	columnName: string;
	category: SchemaInvariantCategory;
	coveredBy: "check" | "pg_enum" | "exception" | "missing";
};

export type SchemaInvariantAudit = {
	failures: string[];
	candidates: SchemaInvariantCandidate[];
	exceptionCount: number;
};

const WORKFLOW_STATE_COLUMN = /(^|_)(status|state|phase|outcome)$/;

function isHighRiskNumeric(column: PublicColumn): boolean {
	return (
		(column.dataType === "number" || column.dataType === "bigint") &&
		column.name !== "id"
	);
}

/**
 * Naming is deliberately conservative for string fields: status/state/phase
 * and outcome represent a durable finite workflow vocabulary. Numeric values
 * are deliberately broad because a negative counter, cost, attempt, position,
 * revision or provider metric is almost always corrupt durable state.
 */
export function classifySchemaInvariantColumn(
	column: PublicColumn,
): SchemaInvariantCategory | undefined {
	if (
		column.dataType === "string" &&
		(WORKFLOW_STATE_COLUMN.test(column.name) || column.name === "waiting_for")
	) {
		return "workflow_state";
	}
	if (isHighRiskNumeric(column)) return "high_risk_numeric";
	return undefined;
}

function columnReference(columnName: string): string {
	return `"${columnName.replaceAll('"', '""')}"`;
}

function exceptionKey(
	exception: Pick<
		SchemaInvariantException,
		"tableName" | "columnName" | "category"
	>,
): string {
	return `${exception.category}:${exception.tableName}.${exception.columnName}`;
}

function isPostgresEnum(column: PublicColumn): boolean {
	return is(column, PgEnumColumn) || is(column, PgEnumObjectColumn);
}

export function auditSchemaInvariants(
	configs: readonly PublicTableConfig[],
	exceptions: readonly SchemaInvariantException[] = SCHEMA_INVARIANT_EXCEPTIONS,
): SchemaInvariantAudit {
	const failures: string[] = [];
	const candidates: SchemaInvariantCandidate[] = [];
	const dialect = new PgDialect();
	const tables = new Map(configs.map((config) => [config.name, config]));
	const exceptionKeys = new Set<string>();

	for (const exception of exceptions) {
		const key = exceptionKey(exception);
		if (exceptionKeys.has(key)) {
			failures.push(`duplicate schema invariant exception ${key}`);
		}
		exceptionKeys.add(key);
		if (exception.rationale.trim().length < 20) {
			failures.push(`${key} must have a meaningful rationale`);
		}

		const table = tables.get(exception.tableName);
		const column = table?.columns.find(
			(candidate) => candidate.name === exception.columnName,
		);
		if (!table) {
			failures.push(`${key} references a missing table`);
			continue;
		}
		if (!column) {
			failures.push(`${key} references a missing column`);
			continue;
		}
		const category = classifySchemaInvariantColumn(column);
		if (category !== exception.category) {
			failures.push(
				`${key} is stale: the column is classified as ${category ?? "not an invariant candidate"}`,
			);
		}
	}

	for (const table of configs) {
		const checkSql = table.checks.map((constraint) =>
			dialect.sqlToQuery(constraint.value).sql.toLowerCase(),
		);

		for (const column of table.columns) {
			const category = classifySchemaInvariantColumn(column);
			if (!category) continue;

			const reference = columnReference(column.name.toLowerCase());
			const checkCovered = checkSql.some((sql) => sql.includes(reference));
			const enumCovered =
				category === "workflow_state" && isPostgresEnum(column);
			const key = exceptionKey({
				tableName: table.name,
				columnName: column.name,
				category,
			});
			const exceptionCovered = exceptionKeys.has(key);

			let coveredBy: SchemaInvariantCandidate["coveredBy"] = "missing";
			if (checkCovered) coveredBy = "check";
			else if (enumCovered) coveredBy = "pg_enum";
			else if (exceptionCovered) coveredBy = "exception";

			candidates.push({
				tableName: table.name,
				columnName: column.name,
				category,
				coveredBy,
			});

			if (exceptionCovered && (checkCovered || enumCovered)) {
				failures.push(
					`${key} is stale because the column is now covered by ${checkCovered ? "a CHECK" : "a PostgreSQL enum"}`,
				);
			} else if (coveredBy === "missing") {
				failures.push(
					category === "workflow_state"
						? `${table.name}.${column.name} is durable workflow state without a PostgreSQL enum, CHECK, or documented exception`
						: `${table.name}.${column.name} is a durable numeric value without a CHECK or documented exception`,
				);
			}
		}
	}

	return {
		failures,
		candidates,
		exceptionCount: exceptions.length,
	};
}
