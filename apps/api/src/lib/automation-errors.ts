/**
 * Error helpers for automation endpoints.
 * Levenshtein-distance suggestions on unknown_* errors make MCP/AI debugging easier.
 */

export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	const matrix: number[][] = Array.from({ length: a.length + 1 }, () =>
		Array(b.length + 1).fill(0),
	);
	for (let i = 0; i <= a.length; i++) matrix[i]![0] = i;
	for (let j = 0; j <= b.length; j++) matrix[0]![j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i]![j] = Math.min(
				matrix[i - 1]![j]! + 1,
				matrix[i]![j - 1]! + 1,
				matrix[i - 1]![j - 1]! + cost,
			);
		}
	}
	return matrix[a.length]![b.length]!;
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
