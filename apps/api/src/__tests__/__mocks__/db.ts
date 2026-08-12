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
	type: "select" | "update" | "insert" | "delete";
	table?: string;
	set?: Record<string, unknown>;
	values?: Record<string, unknown>;
	where?: unknown;
}

type Row = Record<string, unknown>;

export function createMockDb() {
	const data = new Map<string, Row[]>();
	const calls: QueryCall[] = [];
	const updates: Array<{
		table: string;
		set: Record<string, unknown>;
		where?: unknown;
	}> = [];
	const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];

	function resolveTable(tableRef: unknown): string {
		// Drizzle table objects have a Symbol-keyed name. For our mock we use a simple mapping.
		if (tableRef && typeof tableRef === "object" && "_.name" in tableRef) {
			return (tableRef as { "_.name": string })["_.name"];
		}
		if (tableRef && typeof tableRef === "object") {
			const nameSymbol = Object.getOwnPropertySymbols(tableRef).find(
				(symbol) => String(symbol) === "Symbol(drizzle:Name)",
			);
			if (nameSymbol) {
				const name = (tableRef as Record<symbol, unknown>)[nameSymbol];
				if (name === "queue_schedules") return "queueSchedules";
			}
		}
		// Fallback: stringify
		const s = String(tableRef);
		if (s.includes("organization_subscriptions"))
			return "organizationSubscriptions";
		if (s.includes("invoices")) return "invoices";
		if (s.includes("billing_outbox")) return "billingOutbox";
		if (s.includes("stripe_events")) return "stripeEvents";
		if (s.includes("subscription_checkout_operations"))
			return "subscriptionCheckoutOperations";
		if (s.includes("billing_operation_attempts"))
			return "billingOperationAttempts";
		if (s.includes("billing_operations")) return "billingOperations";
		if (s.includes("billing_periods")) return "billingPeriods";
		if (s.includes("usage_buckets")) return "usageBuckets";
		if (s.includes("apikey")) return "apikey";
		if (s.includes("organization_principals")) return "organizationPrincipals";
		if (s.includes("principal_workspace_grants"))
			return "principalWorkspaceGrants";
		if (s.includes("api_request_logs")) return "apiRequestLogs";
		if (s.includes("queue_schedules")) return "queueSchedules";
		if (s.includes("connection_logs")) return "connectionLogs";
		if (s.includes("social_accounts")) return "socialAccounts";
		if (s.includes("social_account_sync_state"))
			return "socialAccountSyncState";
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
			innerJoin(table: unknown, condition: unknown) {
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
				if (
					condition &&
					typeof condition === "object" &&
					"_filter" in condition
				) {
					filterFn = (condition as { _filter: (row: Row) => boolean })._filter;
				}
				return chain;
			},
			orderBy(_value: unknown) {
				return chain;
			},
			for(_strength: string) {
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
					const aggregateSources: Record<string, string> = {
						committedUnits: "committedUnitsSnapshot",
						includedUnits: "cycleAllowance",
						overageUnits: "overageUnitsSnapshot",
						amountCents: "amountCentsSnapshot",
					};
					if (
						fields &&
						Object.entries(fields).some(
							([alias, colRef]) =>
								alias in aggregateSources &&
								colRef !== null &&
								typeof colRef === "object" &&
								"mockSql" in colRef,
						)
					) {
						const summary: Row = {};
						for (const alias of Object.keys(fields)) {
							const source = aggregateSources[alias];
							if (!source) continue;
							const values = rows.map((row) => Number(row[source] ?? 0));
							summary[alias] =
								alias === "includedUnits"
									? Math.max(0, ...values)
									: values.reduce((sum, value) => sum + value, 0);
						}
						calls.push({ type: "select", table: tableName });
						resolve([summary]);
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
		function applyUpdate(): Row[] {
			const rows = data.get(tableName) ?? [];
			const changed: Row[] = [];
			for (const row of rows) {
				if (!filterFn || filterFn(row)) {
					Object.assign(row, setData);
					changed.push(row);
				}
			}
			updates.push({
				table: tableName,
				set: setData,
				where: filterFn ?? undefined,
			});
			calls.push({ type: "update", table: tableName, set: setData });
			return changed;
		}

		const chain = {
			set(values: Record<string, unknown>) {
				setData = values;
				return chain;
			},
			where(condition: unknown) {
				if (
					condition &&
					typeof condition === "object" &&
					"_filter" in condition
				) {
					filterFn = (condition as { _filter: (row: Row) => boolean })._filter;
				}
				return chain;
			},
			returning(_fields?: Record<string, unknown>) {
				return Promise.resolve(applyUpdate());
			},
			// biome-ignore lint/suspicious/noThenProperty: intentional thenable to make the mock query builder awaitable
			then(
				resolve: (value: undefined) => void,
				reject?: (err: unknown) => void,
			) {
				try {
					applyUpdate();
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
		let insertValues: Record<string, unknown> | Record<string, unknown>[] = {};
		let shouldReturn = false;
		let conflictUpdate: { set?: Record<string, unknown> } | null = null;
		let conflictDoNothing = false;

		const chain = {
			values(vals: Record<string, unknown> | Record<string, unknown>[]) {
				insertValues = vals;
				return chain;
			},
			onConflictDoUpdate(opts: { set?: Record<string, unknown> }) {
				conflictUpdate = opts;
				return chain;
			},
			onConflictDoNothing(_opts?: unknown) {
				conflictDoNothing = true;
				return chain;
			},
			returning() {
				shouldReturn = true;
				return chain;
			},
			// biome-ignore lint/suspicious/noThenProperty: intentional thenable to make the mock query builder awaitable
			then(
				resolve: (value: Row[] | undefined) => void,
				reject?: (err: unknown) => void,
			) {
				try {
					const now = new Date();
					const valueRows = Array.isArray(insertValues)
						? insertValues
						: [insertValues];
					const rows = data.get(tableName) ?? [];
					const createdRows = valueRows.map((values) => ({
						id: `acc_mock_${Math.random().toString(36).slice(2, 10)}`,
						connectedAt: now,
						createdAt: now,
						updatedAt: now,
						metadata: null,
						status: "pending",
						attempts: 0,
						nextAttemptAt: now,
						...values,
					}));
					const returnedRows: Row[] = [];
					for (const [index, created] of createdRows.entries()) {
						const values = valueRows[index] ?? {};
						const existing = rows.find(
							(row) =>
								(values.id !== undefined && row.id === values.id) ||
								(values.stripeInvoiceId !== undefined &&
									row.stripeInvoiceId === values.stripeInvoiceId),
						);
						if (existing && conflictUpdate) {
							Object.assign(existing, conflictUpdate.set ?? {});
							updates.push({
								table: tableName,
								set: conflictUpdate.set ?? {},
							});
							returnedRows.push(existing);
							continue;
						}
						if (existing && conflictDoNothing) continue;
						rows.push(created);
						returnedRows.push(created);
						inserts.push({ table: tableName, values });
						calls.push({ type: "insert", table: tableName, values });
					}
					data.set(tableName, rows);
					resolve(shouldReturn ? returnedRows : undefined);
				} catch (err) {
					reject?.(err);
				}
			},
		};
		return chain;
	}

	function deleteChain(table: unknown) {
		const tableName = resolveTable(table);
		let filterFn: ((row: Row) => boolean) | null = null;
		const applyDelete = (): Row[] => {
			const rows = data.get(tableName) ?? [];
			const deleted = rows.filter((row) => !filterFn || filterFn(row));
			data.set(
				tableName,
				rows.filter((row) => filterFn && !filterFn(row)),
			);
			calls.push({ type: "delete", table: tableName });
			return deleted;
		};
		const chain = {
			where(condition: unknown) {
				if (
					condition &&
					typeof condition === "object" &&
					"_filter" in condition
				) {
					filterFn = (condition as { _filter: (row: Row) => boolean })._filter;
				}
				return chain;
			},
			returning() {
				return Promise.resolve(applyDelete());
			},
			// biome-ignore lint/suspicious/noThenProperty: intentional thenable to make the mock query builder awaitable
			then(
				resolve: (value: undefined) => void,
				reject?: (err: unknown) => void,
			) {
				try {
					applyDelete();
					resolve(undefined);
				} catch (error) {
					reject?.(error);
				}
			},
		};
		return chain;
	}

	const dbApi = {
		select: (fields?: Record<string, unknown>) => selectChain(fields),
		update: (table: unknown) => updateChain(table),
		insert: (table: unknown) => insertChain(table),
		delete: (table: unknown) => deleteChain(table),
		execute: async () => [],

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
	return {
		...dbApi,
		transaction: async <T>(callback: (tx: typeof dbApi) => Promise<T>) =>
			callback(dbApi),
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
			_joinCols: [colName, (value as { name: string }).name] as [
				string,
				string,
			],
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
