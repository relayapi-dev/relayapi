/**
 * Bitly short link provider
 * Docs: https://dev.bitly.com/api-reference
 */
import type { ShortLinkProvider } from "./types";

const BITLY_API = "https://api-ssl.bitly.com/v4";

export const bitlyProvider: ShortLinkProvider = {
	shortLinkDomain: "bit.ly",

	async shorten(apiKey, domain, url) {
		const res = await fetch(`${BITLY_API}/shorten`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				long_url: url,
				...(domain ? { domain } : {}),
			}),
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Bitly API error (${res.status}): ${text}`);
		}

		const data = (await res.json()) as { link: string };
		return data.link;
	},

	async getClickCount(apiKey, shortUrl) {
		const counts = await this.getClickCounts(apiKey, [shortUrl]);
		return counts.get(shortUrl) ?? 0;
	},

	async getClickCounts(apiKey, shortUrls) {
		const result = new Map<string, number>();

		const tasks = shortUrls.map(async (shortUrl) => {
			try {
				// Bitly expects the bitlink without protocol
				const parsed = new URL(shortUrl);
				const bitlink = `${parsed.hostname}${parsed.pathname}`;

				const res = await fetch(
					`${BITLY_API}/bitlinks/${encodeURIComponent(bitlink)}/clicks/summary?unit=day&units=-1`,
					{
						headers: { Authorization: `Bearer ${apiKey}` },
					},
				);

				if (res.ok) {
					const data = (await res.json()) as { total_clicks: number };
					result.set(shortUrl, data.total_clicks ?? 0);
				}
			} catch {
				// Skip failed lookups
			}
		});

		await Promise.allSettled(tasks);
		return result;
	},
};
