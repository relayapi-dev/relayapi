const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 2048;
const MAX_ID_LENGTH = 512;
const TIMESTAMP_PATTERN =
	/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

export interface TimestampIdCursor {
	timestamp: string;
	id: string;
}

export class InvalidPaginationCursorError extends Error {
	constructor() {
		super("Invalid pagination cursor");
		this.name = "InvalidPaginationCursorError";
	}
}

function toBase64Url(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new InvalidPaginationCursorError();
	}
	const padded = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	try {
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, (character) =>
			character.charCodeAt(0),
		);
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new InvalidPaginationCursorError();
	}
}

/**
 * Encodes the complete descending keyset `(timestamp, id)` in a versioned,
 * opaque cursor. Resource ids are the deterministic tie-breaker for rows that
 * share a timestamp.
 */
export function encodeTimestampIdCursor(
	timestamp: Date | string,
	id: string,
): string {
	const timestampText =
		timestamp instanceof Date ? timestamp.toISOString() : timestamp;
	const date = new Date(timestampText);
	if (
		Number.isNaN(date.getTime()) ||
		!TIMESTAMP_PATTERN.test(timestampText) ||
		id.length === 0 ||
		id.length > MAX_ID_LENGTH ||
		id.includes("\0")
	) {
		throw new InvalidPaginationCursorError();
	}

	return toBase64Url(
		JSON.stringify({
			version: CURSOR_VERSION,
			timestamp: timestampText,
			id,
		}),
	);
}

/**
 * Strictly decodes a cursor. Callers must turn this error into HTTP 400 rather
 * than silently restarting pagination at page one.
 */
export function decodeTimestampIdCursor(cursor: string): TimestampIdCursor {
	if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
		throw new InvalidPaginationCursorError();
	}

	let value: unknown;
	try {
		value = JSON.parse(fromBase64Url(cursor));
	} catch (error) {
		if (error instanceof InvalidPaginationCursorError) throw error;
		throw new InvalidPaginationCursorError();
	}

	if (!value || typeof value !== "object") {
		throw new InvalidPaginationCursorError();
	}
	const candidate = value as Record<string, unknown>;
	if (
		candidate.version !== CURSOR_VERSION ||
		typeof candidate.timestamp !== "string" ||
		typeof candidate.id !== "string" ||
		candidate.id.length === 0 ||
		candidate.id.length > MAX_ID_LENGTH ||
		candidate.id.includes("\0")
	) {
		throw new InvalidPaginationCursorError();
	}

	const date = new Date(candidate.timestamp);
	if (
		Number.isNaN(date.getTime()) ||
		!TIMESTAMP_PATTERN.test(candidate.timestamp)
	) {
		throw new InvalidPaginationCursorError();
	}

	return { timestamp: candidate.timestamp, id: candidate.id };
}

export const INVALID_CURSOR_BODY = {
	error: {
		code: "INVALID_CURSOR",
		message: "The pagination cursor is invalid or unsupported",
	},
} as const;
