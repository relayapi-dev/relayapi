/** Normalize the immutable public HTTPS base selected by the Listmonk connector. */
export function parseListmonkInstanceUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("Listmonk instance URL is invalid.");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"Listmonk instance URL must be HTTPS and cannot contain credentials, a query, or a fragment.",
		);
	}
	const pathname = url.pathname.replace(/\/+$/u, "");
	return `${url.origin}${pathname === "/" ? "" : pathname}`;
}

export function listmonkApiUrl(instanceUrl: string, path: string): string {
	const base = parseListmonkInstanceUrl(instanceUrl);
	return `${base}/${path.replace(/^\/+/, "")}`;
}
