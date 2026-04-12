const ALLOWED_REDIRECT_DOMAINS = ["relayapi.dev", "localhost"];

export function isAllowedCustomerRedirectUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		const hostAllowed = ALLOWED_REDIRECT_DOMAINS.some(
			(domain) => host === domain || host.endsWith(`.${domain}`),
		);

		if (!hostAllowed) return false;

		if (parsed.protocol === "https:") return true;
		return parsed.protocol === "http:" && (host === "localhost" || host.endsWith(".localhost"));
	} catch {
		return false;
	}
}
