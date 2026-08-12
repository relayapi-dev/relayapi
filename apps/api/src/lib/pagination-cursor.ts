const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 2048;
const MAX_ID_LENGTH = 512;
const TIMESTAMP_PATTERN =
	/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

export interface TimestampIdCursor {
	timestamp: string;
	id: string;
}

export type TimestampIdValue = TimestampIdCursor;

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
 * The single acceptance predicate for cursor timestamps. Returns the value
 * unchanged when it can be encoded into a cursor and ordered by
 * `compareTimestampIdDescending`; otherwise null.
 *
 * Callers holding unvalidated provider data should filter through this before
 * sorting or encoding, so a malformed timestamp is dropped at ingestion rather
 * than thrown at a page boundary.
 */
export function normalizeCursorTimestamp(value: unknown): string | null {
	if (typeof value !== "string") return null;
	if (!TIMESTAMP_PATTERN.test(value)) return null;
	if (Number.isNaN(new Date(value).getTime())) return null;
	return value;
}

/**
 * True for a pre-versioned raw-ISO cursor. Disjoint from a v1 cursor by
 * construction: every ISO timestamp contains ':', which is not in the
 * base64url alphabet a v1 cursor is drawn from.
 */
export function isLegacyIsoCursor(cursor: string): boolean {
	return normalizeCursorTimestamp(cursor) !== null;
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
	if (
		normalizeCursorTimestamp(timestampText) === null ||
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

/**
 * Non-throwing decode. A null result means the caller should reject the
 * request with `INVALID_CURSOR_BODY` and 400 rather than silently restarting
 * pagination at page one.
 */
export function tryDecodeTimestampIdCursor(
	cursor: string,
): TimestampIdCursor | null {
	try {
		return decodeTimestampIdCursor(cursor);
	} catch (error) {
		if (error instanceof InvalidPaginationCursorError) return null;
		throw error;
	}
}

function timestampToEpochMicros(value: string): number {
	const epochMs = new Date(value).getTime();
	if (Number.isNaN(epochMs)) throw new InvalidPaginationCursorError();
	const fractional = value.match(/\.(\d{1,6})/)?.[1] ?? "";
	const microsecondsAfterMillisecond = Number(
		fractional.padEnd(6, "0").slice(3, 6),
	);
	return epochMs * 1000 + microsecondsAfterMillisecond;
}

/**
 * Compares complete timestamp/id sort keys in the descending order used by
 * list endpoints. This preserves fractional timestamp precision beyond
 * JavaScript's millisecond Date representation.
 */
export function compareTimestampIdDescending(
	left: TimestampIdValue,
	right: TimestampIdValue,
): number {
	const leftTimestamp = timestampToEpochMicros(left.timestamp);
	const rightTimestamp = timestampToEpochMicros(right.timestamp);
	if (leftTimestamp !== rightTimestamp) {
		return leftTimestamp > rightTimestamp ? -1 : 1;
	}
	if (left.id === right.id) return 0;
	return left.id > right.id ? -1 : 1;
}

/** Returns true when an item belongs after a cursor in descending keyset order. */
export function isTimestampIdAfterCursor(
	item: TimestampIdValue,
	cursor: TimestampIdCursor,
): boolean {
	return compareTimestampIdDescending(item, cursor) > 0;
}

export type KeysetCursor =
	| { kind: "composite"; timestamp: string; id: string }
	/** A raw-ISO cursor minted before cursors became opaque. */
	| { kind: "legacy"; timestamp: string }
	| { kind: "invalid" };

/**
 * Decodes a cursor for the endpoints whose emitted format changed from a raw
 * ISO timestamp to an opaque composite cursor. Accepting the old format for one
 * release keeps clients that are mid-pagination across the deploy working.
 *
 * The two formats cannot be confused: a v1 cursor is drawn from the base64url
 * alphabet, and every ISO timestamp contains ':', which is not in it.
 *
 * A legacy cursor resolves to a timestamp-only keyset with no id tie-break,
 * which can skip rows sharing the boundary timestamp but never duplicates one —
 * exactly what the previous build did, so it is a faithful continuation rather
 * than a new defect.
 *
 * TODO(remove one release after the composite-cursor rollout): drop the legacy
 * branch and let these endpoints reject raw ISO cursors like every other route.
 */
export function decodeKeysetCursor(cursor: string): KeysetCursor {
	const composite = tryDecodeTimestampIdCursor(cursor);
	if (composite) return { kind: "composite", ...composite };
	const legacy = normalizeCursorTimestamp(cursor);
	if (legacy !== null) return { kind: "legacy", timestamp: legacy };
	return { kind: "invalid" };
}

export const INVALID_CURSOR_BODY = {
	error: {
		code: "INVALID_CURSOR",
		message: "The pagination cursor is invalid or unsupported",
	},
} as const;
