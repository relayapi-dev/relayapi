// Explicit allowlist — do not widen to wildcard subdomains. Any subdomain
// added here must be under our direct control, because the OAuth flow will
// hand a one-time code to whichever host the customer's redirect resolves to.
const ALLOWED_REDIRECT_HOSTS = new Set([
	"relayapi.dev",
	"app.relayapi.dev",
	"dashboard.relayapi.dev",
	"docs.relayapi.dev",
	"localhost",
]);

export function isAllowedCustomerRedirectUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		const hostAllowed =
			ALLOWED_REDIRECT_HOSTS.has(host) || host.endsWith(".localhost");

		if (!hostAllowed) return false;

		if (parsed.protocol === "https:") return true;
		return (
			parsed.protocol === "http:" &&
			(host === "localhost" || host.endsWith(".localhost"))
		);
	} catch {
		return false;
	}
}
