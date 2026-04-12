import pc from "picocolors";
import { APIError } from "@relayapi/sdk";

export function outputJson(data: unknown): void {
	console.log(JSON.stringify(data, null, 2));
}

export function outputTable(
	rows: Record<string, unknown>[],
	columns?: string[],
): void {
	if (rows.length === 0) {
		console.log(pc.dim("No results."));
		return;
	}

	const cols = columns ?? Object.keys(rows[0]!);
	const widths = cols.map((col) =>
		Math.max(
			col.length,
			...rows.map((row) => String(row[col] ?? "").length),
		),
	);

	const header = cols.map((col, i) => col.padEnd(widths[i]!)).join("  ");
	const separator = widths.map((w) => "-".repeat(w)).join("  ");

	console.log(pc.bold(header));
	console.log(pc.dim(separator));
	for (const row of rows) {
		const line = cols
			.map((col, i) => String(row[col] ?? "").padEnd(widths[i]!))
			.join("  ");
		console.log(line);
	}
}

export function outputSuccess(message: string): void {
	console.log(pc.green(`✓ ${message}`));
}

export function outputError(err: unknown): void {
	if (err instanceof APIError) {
		const status = err.status ? `${err.status} ` : "";
		console.error(pc.red(`Error: ${status}${err.message}`));
	} else if (err instanceof Error) {
		console.error(pc.red(`Error: ${err.message}`));
	} else {
		console.error(pc.red(`Error: ${String(err)}`));
	}
}

export async function withErrorHandler<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		outputError(err);
		process.exit(1);
	}
}

export function isTableMode(opts: { table?: boolean }): boolean {
	return opts.table === true;
}

export function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return str.slice(0, max - 1) + "…";
}
