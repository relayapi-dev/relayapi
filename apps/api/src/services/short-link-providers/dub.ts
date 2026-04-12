/**
 * Dub.co short link provider
 * Docs: https://dub.co/docs/api-reference
 */
import type { ShortLinkProvider } from "./types";

const DUB_API = "https://api.dub.co";

export const dubProvider: ShortLinkProvider = {
	shortLinkDomain: "dub.sh",

	async shorten(apiKey, domain, url) {
		const res = await fetch(`${DUB_API}/links`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				url,
				...(domain ? { domain } : {}),
			}),
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Dub API error (${res.status}): ${text}`);
		}

		const data = (await res.json()) as { shortLink: string };
		return data.shortLink;
	},

	async getClickCount(apiKey, shortUrl) {
		const counts = await this.getClickCounts(apiKey, [shortUrl]);
		return counts.get(shortUrl) ?? 0;
	},

	async getClickCounts(apiKey, shortUrls) {
		const result = new Map<string, number>();

		// Dub's analytics endpoint works per-link; batch by fetching link info
		const tasks = shortUrls.map(async (shortUrl) => {
			try {
				const linkUrl = new URL(shortUrl);
				const domain = linkUrl.hostname;
				const key = linkUrl.pathname.slice(1); // remove leading /

				const res = await fetch(
					`${DUB_API}/links/info?domain=${encodeURIComponent(domain)}&key=${encodeURIComponent(key)}`,
					{
						headers: { Authorization: `Bearer ${apiKey}` },
					},
				);

				if (res.ok) {
					const data = (await res.json()) as { clicks: number };
					result.set(shortUrl, data.clicks ?? 0);
				}
			} catch {
				// Skip failed lookups
			}
		});

		await Promise.allSettled(tasks);
		return result;
	},
};
