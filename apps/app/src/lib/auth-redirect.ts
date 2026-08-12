const FALLBACK_AUTH_REDIRECT = "/app";

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint <= 0x1f || codePoint === 0x7f) return true;
	}
	return false;
}

/**
 * Accept only same-origin absolute paths for post-authentication navigation.
 *
 * `window.location` and Better Auth's OAuth callback both interpret values as
 * URLs, so checking only `startsWith("/")` is insufficient: protocol-relative
 * paths and backslashes can still escape the current origin in browsers.
 */
export function normalizeAuthRedirect(
	value: string | null | undefined,
	fallback = FALLBACK_AUTH_REDIRECT,
): string {
	if (!value?.startsWith("/") || value.startsWith("//")) {
		return fallback;
	}
	if (value.includes("\\") || containsControlCharacter(value)) return fallback;

	// Reject encoded variants as well, including double-encoded delimiters.
	let decoded = value;
	for (let pass = 0; pass < 3; pass += 1) {
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			decoded = next;
		} catch {
			return fallback;
		}
		if (
			decoded.startsWith("//") ||
			decoded.includes("\\") ||
			containsControlCharacter(decoded)
		) {
			return fallback;
		}
	}

	try {
		const sentinelOrigin = "https://relayapi.invalid";
		const parsed = new URL(value, sentinelOrigin);
		if (parsed.origin !== sentinelOrigin) return fallback;
		const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
		// URL parsing removes dot segments. A value such as
		// `/safe/%2e%2e//attacker.example` therefore normalizes to a
		// protocol-relative `//attacker.example`; validate the value that callers
		// will actually navigate to, not only the pre-normalized input.
		if (
			!normalized.startsWith("/") ||
			normalized.startsWith("//") ||
			normalized.includes("\\") ||
			containsControlCharacter(normalized)
		) {
			return fallback;
		}
		return normalized;
	} catch {
		return fallback;
	}
}
