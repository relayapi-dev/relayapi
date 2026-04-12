/**
 * Minimal RFC 4180-compliant CSV parser for Cloudflare Workers.
 * Handles quoted fields, escaped quotes (""), and newlines within quotes.
 * Returns an array of objects keyed by the header row.
 */
export function parseCsv(text: string): Record<string, string>[] {
	const rows = parseRows(text);
	if (rows.length === 0) return [];

	const headers = rows[0]!.map((h) => h.trim().toLowerCase());
	const results: Record<string, string>[] = [];

	for (let i = 1; i < rows.length; i++) {
		const row = rows[i]!;
		// Skip completely empty rows
		if (row.length === 1 && row[0]!.trim() === "") continue;

		const obj: Record<string, string> = {};
		for (let j = 0; j < headers.length; j++) {
			obj[headers[j]!] = (row[j] ?? "").trim();
		}
		results.push(obj);
	}

	return results;
}

function parseRows(text: string): string[][] {
	const rows: string[][] = [];
	let current: string[] = [];
	let field = "";
	let inQuotes = false;
	let i = 0;

	while (i < text.length) {
		const ch = text[i];

		if (inQuotes) {
			if (ch === '"') {
				// Escaped quote "" or end of quoted field
				if (i + 1 < text.length && text[i + 1] === '"') {
					field += '"';
					i += 2;
				} else {
					inQuotes = false;
					i++;
				}
			} else {
				field += ch;
				i++;
			}
		} else {
			if (ch === '"') {
				inQuotes = true;
				i++;
			} else if (ch === ",") {
				current.push(field);
				field = "";
				i++;
			} else if (ch === "\r" || ch === "\n") {
				current.push(field);
				field = "";
				rows.push(current);
				current = [];
				// Handle \r\n
				if (ch === "\r" && i + 1 < text.length && text[i + 1] === "\n") {
					i += 2;
				} else {
					i++;
				}
			} else {
				field += ch;
				i++;
			}
		}
	}

	// Final field/row
	if (field || current.length > 0) {
		current.push(field);
		rows.push(current);
	}

	return rows;
}
