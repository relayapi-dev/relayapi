function normalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, normalize(child)]),
		);
	}
	return value;
}

export function stableOperationJson(value: unknown): string {
	return JSON.stringify(normalize(value));
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export async function durableOperationHashes(
	organizationId: string,
	kind: string,
	operationKey: string,
	request: unknown,
): Promise<{ operationKeyHash: string; requestHash: string }> {
	const requestJson = stableOperationJson(request);
	const [operationKeyHash, requestHash] = await Promise.all([
		sha256Hex(`${organizationId}:${kind}:${operationKey}`),
		sha256Hex(requestJson),
	]);
	return { operationKeyHash, requestHash };
}
