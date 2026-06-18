/**
 * Error helpers for automation endpoints.
 * Levenshtein-distance suggestions on unknown_* errors make MCP/AI debugging easier.
 */

export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	const cols = b.length + 1;
	// Flat row-major matrix, keeping behavior identical to the prior number[][]
	// implementation while avoiding non-null assertions. Every (i, j) used below
	// is provably in-bounds, so the `?? 0` fallback in `at` is never taken.
	const matrix = new Float64Array((a.length + 1) * cols);
	const at = (i: number, j: number): number => matrix[i * cols + j] ?? 0;
	const set = (i: number, j: number, value: number): void => {
		matrix[i * cols + j] = value;
	};
	for (let i = 0; i <= a.length; i++) set(i, 0, i);
	for (let j = 0; j <= b.length; j++) set(0, j, j);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			set(
				i,
				j,
				Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost),
			);
		}
	}
	return at(a.length, b.length);
}

export function suggest(
	needle: string,
	haystack: readonly string[],
	maxDistance = 4,
): string | undefined {
	let best: { candidate: string; distance: number } | undefined;
	for (const candidate of haystack) {
		const d = levenshtein(needle.toLowerCase(), candidate.toLowerCase());
		if (d <= maxDistance && (!best || d < best.distance)) {
			best = { candidate, distance: d };
		}
	}
	return best?.candidate;
}

export interface AutomationError {
	code: string;
	message: string;
	details?: Record<string, unknown>;
}

export function automationError(
	code: string,
	message: string,
	opts?: {
		path?: string;
		suggestion?: string;
		details?: Record<string, unknown>;
	},
): { error: AutomationError } {
	const details: Record<string, unknown> = { ...(opts?.details ?? {}) };
	if (opts?.path) details.path = opts.path;
	if (opts?.suggestion) details.suggestion = opts.suggestion;
	return {
		error: {
			code,
			message,
			...(Object.keys(details).length > 0 && { details }),
		},
	};
}
