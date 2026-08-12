function isIpHostname(hostname: string): boolean {
	const unwrapped =
		hostname.startsWith("[") && hostname.endsWith("]")
			? hostname.slice(1, -1)
			: hostname;
	if (unwrapped.includes(":")) return true;
	return /^\d+(?:\.\d+){3}$/u.test(unwrapped);
}

/**
 * Validate and canonicalize a TikTok developer-console URL Prefix property.
 *
 * TikTok's Media Transfer Guide requires `https://` + a domain + a path that
 * ends in `/`. Keeping that trailing boundary is security-significant:
 * `https://example.com/media/` must not authorize `/media-evil/video.mp4`.
 */
export function parseTikTokVerifiedUrlPrefix(value: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		(url.port && url.port !== "443") ||
		url.search ||
		url.hash ||
		isIpHostname(url.hostname) ||
		!value.endsWith("/") ||
		!url.pathname.endsWith("/")
	) {
		throw new Error(
			"TikTok verified URL prefixes must use HTTPS, a domain (not an IP address), and a path ending in '/', without credentials, a non-default port, query, or fragment.",
		);
	}
	return url.toString();
}

export function matchesTikTokVerifiedUrlPrefix(
	value: string,
	prefixes: readonly string[],
): boolean {
	let mediaUrl: URL;
	try {
		mediaUrl = new URL(value);
	} catch {
		return false;
	}
	if (
		mediaUrl.protocol !== "https:" ||
		mediaUrl.username ||
		mediaUrl.password ||
		(mediaUrl.port && mediaUrl.port !== "443") ||
		mediaUrl.hash
	) {
		return false;
	}

	return prefixes.some((rawPrefix) => {
		try {
			const prefix = new URL(parseTikTokVerifiedUrlPrefix(rawPrefix));
			return (
				mediaUrl.origin === prefix.origin &&
				mediaUrl.pathname.startsWith(prefix.pathname)
			);
		} catch {
			return false;
		}
	});
}
