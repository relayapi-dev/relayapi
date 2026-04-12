/**
 * Built-in RelayAPI short link provider.
 *
 * Uses Cloudflare KV for fast redirects and the shortLinks DB table for tracking.
 * Short URLs are served at {API_BASE_URL}/r/{code}.
 * No third-party API keys required.
 */
import type { ShortLinkProvider } from "./types";

const CODE_LENGTH = 7;
const CODE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function generateShortCode(): string {
	const bytes = new Uint8Array(CODE_LENGTH);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => CODE_CHARS[b % CODE_CHARS.length])
		.join("");
}

/**
 * Create the built-in provider. Requires KV namespace and base URL at call time,
 * so this is a factory rather than a static object.
 */
export function createRelayApiProvider(
	kv: KVNamespace,
	baseUrl: string,
): ShortLinkProvider {
	// Normalize base URL (remove trailing slash)
	const base = baseUrl.replace(/\/$/, "");

	return {
		shortLinkDomain: new URL(base).hostname,

		async shorten(_apiKey, domain, url) {
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new Error("Short link targets must use http or https");
			}

			// Generate a unique short code (retry on collision)
			let code: string;
			let attempts = 0;
			do {
				code = generateShortCode();
				const existing = await kv.get(`sl:${code}`);
				if (!existing) break;
				attempts++;
			} while (attempts < 5);

			// Store redirect in KV (no expiry — permanent short links)
			await kv.put(`sl:${code}`, url);
			// Initialize click counter
			await kv.put(`sl:${code}:clicks`, "0");

			const shortDomain = domain ? `https://${domain}` : base;
			return `${shortDomain}/r/${code}`;
		},

		async getClickCount(_apiKey, shortUrl) {
			const code = extractCode(shortUrl);
			if (!code) return 0;

			const clicks = await kv.get(`sl:${code}:clicks`);
			return clicks ? parseInt(clicks, 10) : 0;
		},

		async getClickCounts(_apiKey, shortUrls) {
			const result = new Map<string, number>();

			const tasks = shortUrls.map(async (shortUrl) => {
				const code = extractCode(shortUrl);
				if (!code) return;

				const clicks = await kv.get(`sl:${code}:clicks`);
				result.set(shortUrl, clicks ? parseInt(clicks, 10) : 0);
			});

			await Promise.allSettled(tasks);
			return result;
		},
	};
}

/** Extract the short code from a relay short URL (e.g. https://api.relayapi.dev/r/aBc1234 → aBc1234) */
function extractCode(shortUrl: string): string | null {
	try {
		const url = new URL(shortUrl);
		const match = url.pathname.match(/^\/r\/([a-zA-Z0-9]+)$/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}
