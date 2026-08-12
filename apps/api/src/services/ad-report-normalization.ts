import type { z } from "@hono/zod-openapi";
import type { AdReportProviderRequest } from "../schemas/ads-advanced";

export type AdReportRequest = z.infer<typeof AdReportProviderRequest>;
export type AdReportArtifactFormat = "csv" | "json";

export interface CanonicalAdReportRow {
	dimensions: Record<string, unknown>;
	metrics: Record<string, string | number | null>;
}

export const MAX_AD_REPORT_ROWS = 100_000;
export const MAX_AD_REPORT_COLUMNS = 256;
export const MAX_AD_REPORT_FIELD_CHARS = 64 * 1024;
export const MAX_AD_REPORT_JSON_ITEM_CHARS = 512 * 1024;
export const MAX_AD_REPORT_ROW_JSON_CHARS = 768 * 1024;

function reportParseError(message: string): Error {
	const error = new Error(message);
	error.name = "AdReportParseError";
	return error;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function scalarMetric(value: unknown): string | number | null | undefined {
	if (value === null) return null;
	if (typeof value === "string" || typeof value === "number") return value;
	if (typeof value === "boolean") return value ? 1 : 0;
	return undefined;
}

function csvMetric(value: string): string | number | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
		const parsed = Number(trimmed);
		if (Number.isFinite(parsed)) return parsed;
	}
	return value;
}

function assertCanonicalRowSize(row: CanonicalAdReportRow): void {
	if (JSON.stringify(row).length > MAX_AD_REPORT_ROW_JSON_CHARS) {
		throw reportParseError("A normalized report row exceeded the byte limit");
	}
}

async function* csvRecords(
	source: ReadableStream<Uint8Array>,
): AsyncGenerator<string[]> {
	const reader = source.getReader();
	const decoder = new TextDecoder();
	let field = "";
	let row: string[] = [];
	let inQuotes = false;
	let quotePending = false;
	let skipLf = false;
	let firstCharacter = true;
	let completed = false;

	const append = (value: string) => {
		field += value;
		if (field.length > MAX_AD_REPORT_FIELD_CHARS) {
			throw reportParseError("A report CSV field exceeded the byte limit");
		}
	};
	const finishField = () => {
		row.push(field);
		field = "";
		if (row.length > MAX_AD_REPORT_COLUMNS) {
			throw reportParseError("A report CSV row exceeded the column limit");
		}
	};

	try {
		for (;;) {
			const { done, value } = await reader.read();
			const chunk = decoder.decode(value, { stream: !done });
			for (const originalCharacter of chunk) {
				const character = originalCharacter;
				if (firstCharacter) {
					firstCharacter = false;
					if (character === "\uFEFF") continue;
				}
				if (skipLf) {
					skipLf = false;
					if (character === "\n") continue;
				}

				if (inQuotes) {
					if (!quotePending) {
						if (character === '"') quotePending = true;
						else append(character);
						continue;
					}
					if (character === '"') {
						append('"');
						quotePending = false;
						continue;
					}
					inQuotes = false;
					quotePending = false;
				}

				if (character === '"' && field.length === 0) {
					inQuotes = true;
					continue;
				}
				if (character === ",") {
					finishField();
					continue;
				}
				if (character === "\r" || character === "\n") {
					finishField();
					const completed = row;
					row = [];
					if (character === "\r") skipLf = true;
					yield completed;
					continue;
				}
				append(character);
			}
			if (done) {
				completed = true;
				break;
			}
		}
	} finally {
		if (!completed)
			await reader.cancel("CSV report parsing stopped").catch(() => {});
		reader.releaseLock();
	}

	if (inQuotes && !quotePending) {
		throw reportParseError("Report CSV ended inside a quoted field");
	}
	if (field.length > 0 || row.length > 0) {
		finishField();
		yield row;
	}
}

/**
 * Extract values from the first JSON array without retaining the complete
 * document. Provider report envelopes use a top-level data/elements array;
 * each individual value is independently capped before JSON.parse.
 */
async function* jsonArrayValues(
	source: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
	const reader = source.getReader();
	const decoder = new TextDecoder();
	let foundArray = false;
	let preludeInString = false;
	let preludeEscape = false;
	let item = "";
	let itemStarted = false;
	let itemDepth = 0;
	let itemInString = false;
	let itemEscape = false;
	let arrayEnded = false;
	let completed = false;

	const append = (character: string) => {
		item += character;
		if (item.length > MAX_AD_REPORT_JSON_ITEM_CHARS) {
			throw reportParseError(
				"A provider JSON report item exceeded the byte limit",
			);
		}
	};
	const parseItem = (): unknown => {
		const value = item.trim();
		item = "";
		itemStarted = false;
		itemDepth = 0;
		itemInString = false;
		itemEscape = false;
		if (!value)
			throw reportParseError("Provider JSON report contained an empty item");
		try {
			return JSON.parse(value) as unknown;
		} catch {
			throw reportParseError(
				"Provider JSON report contained an invalid array item",
			);
		}
	};

	try {
		for (;;) {
			const { done, value } = await reader.read();
			const chunk = decoder.decode(value, { stream: !done });
			for (const character of chunk) {
				if (arrayEnded) {
					if (!/\s/.test(character) && character !== "}" && character !== ",") {
						throw reportParseError("Provider JSON report had trailing data");
					}
					continue;
				}

				if (!foundArray) {
					if (preludeInString) {
						if (preludeEscape) preludeEscape = false;
						else if (character === "\\") preludeEscape = true;
						else if (character === '"') preludeInString = false;
						continue;
					}
					if (character === '"') preludeInString = true;
					else if (character === "[") foundArray = true;
					continue;
				}

				if (!itemStarted) {
					if (/\s/.test(character) || character === ",") continue;
					if (character === "]") {
						arrayEnded = true;
						continue;
					}
					itemStarted = true;
					append(character);
					if (character === '"') itemInString = true;
					else if (character === "{" || character === "[") itemDepth = 1;
					continue;
				}

				if (itemInString) {
					append(character);
					if (itemEscape) itemEscape = false;
					else if (character === "\\") itemEscape = true;
					else if (character === '"') itemInString = false;
					continue;
				}

				if (character === '"') {
					append(character);
					itemInString = true;
					continue;
				}
				if (character === "{" || character === "[") {
					append(character);
					itemDepth++;
					continue;
				}
				if (character === "}" || character === "]") {
					if (character === "]" && itemDepth === 0) {
						yield parseItem();
						arrayEnded = true;
						continue;
					}
					append(character);
					itemDepth--;
					if (itemDepth < 0) {
						throw reportParseError("Provider JSON report nesting was invalid");
					}
					continue;
				}
				if (character === "," && itemDepth === 0) {
					yield parseItem();
					continue;
				}
				append(character);
			}
			if (done) {
				completed = true;
				break;
			}
		}
	} finally {
		if (!completed)
			await reader.cancel("JSON report parsing stopped").catch(() => {});
		reader.releaseLock();
	}

	if (!foundArray)
		throw reportParseError("Provider JSON report omitted a result array");
	if (!arrayEnded)
		throw reportParseError(
			"Provider JSON report ended before its result array",
		);
}

function splitObject(
	value: Record<string, unknown>,
	metricNames: ReadonlySet<string>,
): CanonicalAdReportRow {
	const dimensions: Record<string, unknown> = {};
	const metrics: Record<string, string | number | null> = {};
	const nestedMetrics = objectValue(value.metrics);
	if (nestedMetrics) {
		for (const [name, metric] of Object.entries(nestedMetrics)) {
			const scalar = scalarMetric(metric);
			if (scalar !== undefined) metrics[name] = scalar;
		}
	}
	for (const [name, child] of Object.entries(value)) {
		if (name === "metrics" && nestedMetrics) continue;
		const scalar = scalarMetric(child);
		if (metricNames.has(name) && scalar !== undefined) metrics[name] = scalar;
		else dimensions[name] = child;
	}
	const row = { dimensions, metrics };
	assertCanonicalRowSize(row);
	return row;
}

function* jsonRows(
	value: unknown,
	request: AdReportRequest,
): Generator<CanonicalAdReportRow> {
	const object = objectValue(value);
	if (!object) {
		throw reportParseError("Provider JSON report rows must be objects");
	}
	if (request.platform === "twitter" && Array.isArray(object.id_data)) {
		if (object.id_data.length > 10_000) {
			throw reportParseError("An X report entity exceeded the point limit");
		}
		const parent = Object.fromEntries(
			Object.entries(object).filter(([name]) => name !== "id_data"),
		);
		for (const point of object.id_data) {
			const pointObject = objectValue(point);
			if (!pointObject) {
				throw reportParseError("An X report point was not an object");
			}
			const metricObject = objectValue(pointObject.metrics);
			if (!metricObject) {
				const normalized = splitObject(pointObject, new Set());
				normalized.dimensions = { ...parent, ...normalized.dimensions };
				assertCanonicalRowSize(normalized);
				yield normalized;
				continue;
			}

			// X's official analytics schema represents each metric as a time-series
			// array (including TOTAL, whose array has one element). Expand those
			// bounded arrays into canonical scalar rows rather than discarding them
			// or serializing an opaque array into the metrics map.
			let seriesLength = 0;
			for (const metric of Object.values(metricObject)) {
				if (Array.isArray(metric)) {
					seriesLength = Math.max(seriesLength, metric.length);
				}
			}
			seriesLength = Math.max(seriesLength, 1);
			if (seriesLength > 10_000) {
				throw reportParseError("An X report metric exceeded the point limit");
			}
			const pointDimensions = Object.fromEntries(
				Object.entries(pointObject).filter(([name]) => name !== "metrics"),
			);
			for (let timeIndex = 0; timeIndex < seriesLength; timeIndex++) {
				const metrics: Record<string, string | number | null> = {};
				for (const [name, metric] of Object.entries(metricObject)) {
					const candidate = Array.isArray(metric) ? metric[timeIndex] : metric;
					const scalar = scalarMetric(candidate);
					if (scalar === undefined && candidate !== undefined) {
						throw reportParseError(
							"An X report metric contained a non-scalar value",
						);
					}
					metrics[name] = scalar ?? null;
				}
				const normalized: CanonicalAdReportRow = {
					dimensions: {
						...parent,
						...pointDimensions,
						...(seriesLength > 1 ? { time_index: timeIndex } : {}),
					},
					metrics,
				};
				assertCanonicalRowSize(normalized);
				yield normalized;
			}
		}
		return;
	}
	const metricNames =
		request.platform === "tiktok"
			? new Set(request.metrics)
			: request.platform === "linkedin"
				? new Set(
						request.fields.filter(
							(name) =>
								![
									"pivotValues",
									"dateRange",
									"account",
									"campaign",
									"campaignGroup",
									"creative",
								].includes(name),
						),
					)
				: new Set<string>();
	yield splitObject(object, metricNames);
}

export async function* parseAdReportRows(
	source: ReadableStream<Uint8Array>,
	format: AdReportArtifactFormat,
	request: AdReportRequest,
): AsyncGenerator<CanonicalAdReportRow> {
	let emitted = 0;
	if (format === "csv") {
		let header: string[] | null = null;
		for await (const record of csvRecords(source)) {
			if (!header) {
				header = record.map((name) => name.trim());
				if (
					header.length === 0 ||
					header.some((name) => !name) ||
					new Set(header).size !== header.length
				) {
					throw reportParseError("Report CSV header was empty or duplicated");
				}
				continue;
			}
			if (record.length === 1 && record[0]?.trim() === "") continue;
			if (record.length !== header.length) {
				throw reportParseError("Report CSV row did not match its header width");
			}
			const dimensions: Record<string, unknown> = {};
			const metrics: Record<string, string | number | null> = {};
			const metricNames =
				request.platform === "tiktok"
					? new Set(request.metrics)
					: new Set<string>();
			for (let index = 0; index < header.length; index++) {
				const name = header[index] as string;
				const value = record[index] ?? "";
				if (metricNames.has(name)) metrics[name] = csvMetric(value);
				else dimensions[name] = value;
			}
			const row = { dimensions, metrics };
			assertCanonicalRowSize(row);
			emitted++;
			if (emitted > MAX_AD_REPORT_ROWS) {
				throw reportParseError("Report exceeded the normalized row limit");
			}
			yield row;
		}
		if (!header) throw reportParseError("Report CSV omitted its header");
		return;
	}

	for await (const value of jsonArrayValues(source)) {
		for (const row of jsonRows(value, request)) {
			emitted++;
			if (emitted > MAX_AD_REPORT_ROWS) {
				throw reportParseError("Report exceeded the normalized row limit");
			}
			yield row;
		}
	}
}
