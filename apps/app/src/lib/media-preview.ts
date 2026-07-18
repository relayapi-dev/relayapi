import { useCallback, useEffect, useMemo, useState } from "react";

export function mediaPreviewCandidates(
	preferred: string | null | undefined,
	fallback: string | null | undefined,
): string[] {
	return [preferred, fallback].filter(
		(value, index, values): value is string =>
			Boolean(value) && values.indexOf(value) === index,
	);
}

/** Advances through a durable preview and one raw provider fallback. */
export function useMediaPreview(
	preferred: string | null | undefined,
	fallback: string | null | undefined,
) {
	const candidates = useMemo(
		() => mediaPreviewCandidates(preferred, fallback),
		[preferred, fallback],
	);
	const [candidateIndex, setCandidateIndex] = useState(0);

	useEffect(() => setCandidateIndex(0), [preferred, fallback]);

	const fail = useCallback(() => {
		setCandidateIndex((current) => Math.min(current + 1, candidates.length));
	}, [candidates.length]);

	return {
		src: candidates[candidateIndex] ?? null,
		fail,
		failed: candidates.length > 0 && candidateIndex >= candidates.length,
		hasCandidates: candidates.length > 0,
	};
}
