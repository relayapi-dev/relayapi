/**
 * Lightweight mock for the Drizzle DB used in billing code.
 *
 * Usage:
 *   const db = createMockDb();
 *   db._seed("organizationSubscriptions", [{ id: "sub_1", ... }]);
 *   // ... call handler that uses db ...
 *   expect(db._updates).toHaveLength(1);
 */

interface QueryCall {
	type: "select" | "update" | "insert";
	table?: string;
	set?: Record<string, unknown>;
	values?: Record<string, unknown>;
	where?: unknown;
}

type Row = Record<string, unknown>;

export function createMockDb() {
	const data = new Map<string, Row[]>();
	const calls: QueryCall[] = [];
	const updates: Array<{ table: string; set: Record<string, unknown>; where?: unknown }> = [];
	const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];

	function resolveTable(tableRef: unknown): string {
		// Drizzle table objects have a Symbol-keyed name. For our mock we use a simple mapping.
		if (tableRef && typeof tableRef === "object" && "_.name" in tableRef) {
			return (tableRef as { "_.name": string })["_.name"];
		}
		// Fallback: stringify
		const s = String(tableRef);
		if (s.includes("organization_subscriptions")) return "organizationSubscriptions";
		if (s.includes("invoices")) return "invoices";
		if (s.includes("apikey")) return "apikey";
		if (s.includes("usage_records")) return "usageRecords";
		if (s.includes("api_request_logs")) return "apiRequestLogs";
		if (s.includes("connection_logs")) return "connectionLogs";
		if (s.includes("social_accounts")) return "socialAccounts";
		if (s.includes("social_account_sync_state")) return "socialAccountSyncState";
		return s;
	}

	// Chainable select builder
	function selectChain(fields?: Record<string, unknown>) {
		let tableName = "";
		let filterFn: ((row: Row) => boolean) | null = null;
		let limitCount: number | null = null;
		const joins: Array<{ table: string; cols: [string, string] | null }> = [];

		const chain = {
			from(table: unknown) {
				tableName = resolveTable(table);
				return chain;
			},
			leftJoin(table: unknown, condition: unknown) {
				const cols =
					condition && typeof condition === "object" && "_joinCols" in condition
						? ((condition as { _joinCols: [string, string] })._joinCols as [
								string,
								string,
							])
						: null;
				joins.push({ table: resolveTable(table), cols });
				return chain;
			},
			where(condition: unknown) {
				// condition is the result of eq() — we store a filter function
				if (condition && typeof condition === "object" && "_filter" in condition) {
					filterFn = (condition as { _filter: (row: Row) => boolean })._filter;
				}
				return chain;
			},
			orderBy(_value: unknown) {
				return chain;
			},
			limit(n: number) {
				limitCount = n;
				return chain;
			},
			// Terminal: makes chain awaitable
			// biome-ignore lint/suspicious/noThenProperty: intentional thenable to make the mock query builder awaitable
			then(resolve: (value: Row[]) => void, reject?: (err: unknown) => void) {
				try {
					let rows = data.get(tableName) ?? [];
					if (filterFn) rows = rows.filter(filterFn);
					// Merge leftJoin rows: joined fields are added underneath the
					// main row's own fields (main row wins on name conflicts).
					if (joins.length > 0) {
						rows = rows.map((row) => {
							let merged = { ...row };
							for (const j of joins) {
								const joinRows = data.get(j.table) ?? [];
								const cols = j.cols;
								const match = cols
									? joinRows.find(
											(jr) =>
												jr[cols[0]] === row[cols[1]] ||
												jr[cols[1]] === row[cols[0]],
										)
									: undefined;
								if (match) merged = { ...match, ...merged };
							}
							return merged;
						});
					}
					if (fields && Object.keys(fields).length === 1 && "total" in fields) {
						calls.push({ type: "select", table: tableName });
						resolve([{ total: rows.length }]);
						return;
					}
					if (fields) {
						rows = rows.map((row) => {
							const mapped: Record<string, unknown> = {};
							for (const [alias, colRef] of Object.entries(fields)) {
								const colName = getColName(colRef);
								mapped[alias] = row[colName];
							}
							return mapped;
						});
					}
					if (limitCount !== null) rows = rows.slice(0, limitCount);
					calls.push({ type: "select", table: tableName });
					resolve(rows);
				} catch (err) {
					reject?.(err);
				}
			},
		};
		return chain;
	}

	// Chainable update builder
	function updateChain(table: unknown) {
		const tableName = resolveTable(table);
		let setData: Record<string, unknown> = {};
		let filterFn: ((row: Row) => boolean) | null = null;

		const chain = {
			set(values: Record<string, unknown>) {
				setData = values;
				return chain;
			},
			where(condition: unknown) {
				if (condition && typeof condition === "object" && "_filter" in condition) {
					filterFn = (condition as { _filter: (row: Row) => boolean })._filter;
				}
				return chain;
			},
			// biome-ignore lint/suspicious/noThenProperty: intentional thenable to make the mock query builder awaitable
			then(resolve: (value: undefined) => void, reject?: (err: unknown) => void) {
				try {
					// Apply updates to seeded data
					const rows = data.get(tableName) ?? [];
					for (const row of rows) {
						if (!filterFn || filterFn(row)) {
							Object.assign(row, setData);
						}
					}
					updates.push({ table: tableName, set: setData, where: filterFn });
					calls.push({ type: "update", table: tableName, set: setData });
					resolve(undefined);
				} catch (err) {
					reject?.(err);
				}
			},
		};
		return chain;
	}

	// Chainable insert builder
	function insertChain(table: unknown) {
		const tableName = resolveTable(table);
		let insertValues: Record<string, unknown> = {};
		let shouldReturn = false;

		const chain = {
			values(vals: Record<string, unknown>) {
				insertValues = vals;
				return chain;
			},
			onConflictDoUpdate(_opts: unknown) {
				// For testing, just do the insert
				return chain;
			},
			returning() {
				shouldReturn = true;
				return chain;
			},
			// biome-ignore lint/suspicious/noThenProperty: intentional thenable to make the mock query builder awaitable
			then(resolve: (value: Row[] | undefined) => void, reject?: (err: unknown) => void) {
				try {
					const now = new Date();
					const row = {
						id: `acc_mock_${Math.random().toString(36).slice(2, 10)}`,
						connectedAt: now,
						updatedAt: now,
						metadata: null,
						...insertValues,
					};
					const rows = data.get(tableName) ?? [];
					rows.push(row);
					data.set(tableName, rows);
					inserts.push({ table: tableName, values: insertValues });
					calls.push({ type: "insert", table: tableName, values: insertValues });
					resolve(shouldReturn ? [row] : undefined);
				} catch (err) {
					reject?.(err);
				}
			},
		};
		return chain;
	}

	return {
		select: (fields?: Record<string, unknown>) => selectChain(fields),
		update: (table: unknown) => updateChain(table),
		insert: (table: unknown) => insertChain(table),

		// Test helpers
		_seed(tableName: string, rows: Row[]) {
			data.set(tableName, [...rows]);
		},
		_getData(tableName: string): Row[] {
			return data.get(tableName) ?? [];
		},
		_calls: calls,
		_updates: updates,
		_inserts: inserts,
		_reset() {
			data.clear();
			calls.length = 0;
			updates.length = 0;
			inserts.length = 0;
		},
	};
}

/**
 * Mock `eq()` — returns an object with a _filter function
 * that compares a row field to a value.
 */
export function mockEq(column: unknown, value: unknown) {
	const colName = getColName(column);
	// Column-to-column comparison (a join condition): expose both column
	// names so selectChain.leftJoin can match rows across tables.
	if (value && typeof value === "object" && "name" in value) {
		return {
			_filter: () => false,
			_joinCols: [colName, (value as { name: string }).name] as [string, string],
		};
	}
	return {
		_filter: (row: Record<string, unknown>) => row[colName] === value,
	};
}

function getColName(colRef: unknown): string {
	if (colRef && typeof colRef === "object") {
		// Drizzle columns have a .name property
		if ("name" in colRef) return (colRef as { name: string }).name;
	}
	return String(colRef);
}

export type MockDb = ReturnType<typeof createMockDb>;
