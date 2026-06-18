export async function mapConcurrently<T, R>(
	items: readonly T[],
	limit: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];

	const concurrency = Math.max(1, Math.min(limit, items.length));
	const results = new Array<R>(items.length);
	// Shared iterator over [index, item] entries so each worker pulls the next
	// pending task; iterating preserves the original element (including any
	// legitimately-undefined values) without index-based non-null assertions.
	const entries = items.entries();

	const worker = async () => {
		for (const [index, item] of entries) {
			results[index] = await mapper(item, index);
		}
	};

	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	return results;
}
