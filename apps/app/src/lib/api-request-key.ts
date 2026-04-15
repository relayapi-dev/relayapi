export type ApiQueryValue = string | number | boolean | null | undefined;

export type ApiQuery = Record<string, ApiQueryValue>;

export function buildApiRequestKey(
	path: string | null,
	query?: ApiQuery,
): string | null {
	if (!path) return null;

	const url = new URL(
		path.startsWith("/")
			? `https://relayapi.local${path}`
			: `https://relayapi.local/${path}`,
	);
	const params = new URLSearchParams(url.search);

	if (query) {
		for (const key of Object.keys(query).sort()) {
			const value = query[key];
			if (value === undefined || value === null || value === "") continue;
			params.set(key, String(value));
		}
	}

	const search = params.toString();
	return `${url.pathname.replace(/^\//, "")}${search ? `?${search}` : ""}`;
}
