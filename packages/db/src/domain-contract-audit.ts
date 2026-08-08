import { is } from "drizzle-orm";
import {
	type getTableConfig,
	PgDialect,
	PgEnumColumn,
	PgEnumObjectColumn,
} from "drizzle-orm/pg-core";
import { DOMAIN_CONTRACTS, type DomainContract } from "./domain-contracts";

type TableConfig = ReturnType<typeof getTableConfig>;
type TableColumn = TableConfig["columns"][number];

export type DurableDomainCandidate = {
	schemaName: string;
	tableName: string;
	columnName: string;
	classification: DomainContract["classification"] | "missing" | "duplicate";
};

export type DurableDomainAudit = {
	failures: string[];
	candidates: DurableDomainCandidate[];
	contractCount: number;
};

const DURABLE_DOMAIN_COLUMN = /(^|_)(type|kind|role|direction)$/;

export function isDurableDomainColumn(column: TableColumn): boolean {
	return (
		column.dataType === "string" && DURABLE_DOMAIN_COLUMN.test(column.name)
	);
}

function tableKey(schemaName: string, tableName: string): string {
	return `${schemaName}.${tableName}`;
}

function domainKey(
	value: Pick<DomainContract, "schemaName" | "tableName" | "columnName">,
): string {
	return `${value.schemaName}.${value.tableName}.${value.columnName}`;
}

function isPostgresEnum(column: TableColumn): boolean {
	return is(column, PgEnumColumn) || is(column, PgEnumObjectColumn);
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Closed CHECK contracts deliberately use a dedicated `column IN (...)`
 * constraint. Parsing only that named constraint keeps tuple/state checks from
 * accidentally satisfying domain coverage.
 */
function extractCheckValues(
	checkSql: string,
	columnName: string,
): string[] | null {
	const column = escapeRegex(columnName);
	const match = checkSql.match(
		new RegExp(
			`(?:(?:"[^"]+"|[a-z_][a-z0-9_]*)\\.)?(?:"${column}"|${column})\\s+IN\\s*\\(([^)]*)\\)`,
			"i",
		),
	);
	if (!match?.[1]) return null;
	const values: string[] = [];
	const literal = /'((?:''|[^'])*)'/g;
	for (const value of match[1].matchAll(literal)) {
		values.push((value[1] ?? "").replaceAll("''", "'"));
	}
	return values.length > 0 ? values : null;
}

function sorted(values: readonly string[]): string[] {
	return [...values].sort();
}

export function auditDurableDomains(
	configs: readonly TableConfig[],
	contracts: readonly DomainContract[] = DOMAIN_CONTRACTS,
): DurableDomainAudit {
	const failures: string[] = [];
	const candidates: DurableDomainCandidate[] = [];
	const dialect = new PgDialect();
	const tables = new Map(
		configs.map((config) => [
			tableKey(config.schema ?? "public", config.name),
			config,
		]),
	);
	const contractsByColumn = new Map<string, DomainContract[]>();

	for (const contract of contracts) {
		const key = domainKey(contract);
		const existing = contractsByColumn.get(key);
		if (existing) existing.push(contract);
		else contractsByColumn.set(key, [contract]);

		const table = tables.get(tableKey(contract.schemaName, contract.tableName));
		if (!table) {
			failures.push(`${key} domain contract references a missing table`);
			continue;
		}
		const column = table.columns.find(
			(candidate) => candidate.name === contract.columnName,
		);
		if (!column) {
			failures.push(`${key} domain contract references a missing column`);
			continue;
		}
		if (!isDurableDomainColumn(column)) {
			failures.push(
				`${key} domain contract is stale: the column is not type/kind/role/direction-shaped text`,
			);
			continue;
		}

		if (contract.classification === "closed") {
			const distinctValues = new Set(contract.values);
			if (
				contract.values.length === 0 ||
				distinctValues.size !== contract.values.length
			) {
				failures.push(
					`${key} closed domain values must be non-empty and unique`,
				);
			}

			if (contract.database.kind === "pg_enum") {
				if (!isPostgresEnum(column)) {
					failures.push(
						`${key} must use PostgreSQL enum ${contract.database.enumName}`,
					);
				} else {
					if (column.getSQLType() !== contract.database.enumName) {
						failures.push(
							`${key} uses PostgreSQL enum ${column.getSQLType()}, expected ${contract.database.enumName}`,
						);
					}
					if (
						JSON.stringify(column.enumValues ?? []) !==
						JSON.stringify(contract.values)
					) {
						failures.push(
							`${key} PostgreSQL enum values ${JSON.stringify(column.enumValues ?? [])} do not equal canonical values ${JSON.stringify(contract.values)}`,
						);
					}
				}
				continue;
			}

			const constraintName = contract.database.constraintName;
			const matchingChecks = table.checks.filter(
				(check) => check.name === constraintName,
			);
			if (matchingChecks.length !== 1) {
				failures.push(
					`${key} must have exactly one CHECK named ${constraintName}`,
				);
				continue;
			}
			const matchingCheck = matchingChecks[0];
			if (!matchingCheck) continue;
			const checkSql = dialect.sqlToQuery(matchingCheck.value).sql;
			const checkValues = extractCheckValues(checkSql, column.name);
			if (!checkValues) {
				failures.push(
					`${key} CHECK ${constraintName} must contain a direct ${column.name} IN (...) domain`,
				);
			} else if (
				JSON.stringify(sorted(checkValues)) !==
				JSON.stringify(sorted(contract.values))
			) {
				failures.push(
					`${key} CHECK values ${JSON.stringify(checkValues)} do not equal canonical values ${JSON.stringify(contract.values)}`,
				);
			}
			continue;
		}

		if (contract.rationale.trim().length < 40) {
			failures.push(`${key} open-domain rationale must be meaningful`);
		}
		if (
			contract.classification === "provider_passthrough" &&
			contract.provider.trim().length < 3
		) {
			failures.push(`${key} provider_passthrough must name its provider`);
		}
		if (
			contract.classification === "externally_owned" &&
			contract.owner.trim().length < 3
		) {
			failures.push(`${key} externally_owned must name its owner`);
		}
	}

	for (const [key, entries] of contractsByColumn) {
		if (entries.length > 1) {
			failures.push(
				`${key} has ${entries.length} domain contracts; expected one`,
			);
		}
	}

	for (const table of configs) {
		const schemaName = table.schema ?? "public";
		for (const column of table.columns) {
			if (!isDurableDomainColumn(column)) continue;
			const key = domainKey({
				schemaName,
				tableName: table.name,
				columnName: column.name,
			});
			const matches = contractsByColumn.get(key) ?? [];
			const classification =
				matches.length === 0
					? "missing"
					: matches.length > 1
						? "duplicate"
						: (matches[0]?.classification ?? "missing");
			candidates.push({
				schemaName,
				tableName: table.name,
				columnName: column.name,
				classification,
			});
			if (matches.length === 0) {
				failures.push(`${key} is missing a DOMAIN_CONTRACTS entry`);
			}
		}
	}

	return {
		failures,
		candidates,
		contractCount: contracts.length,
	};
}
