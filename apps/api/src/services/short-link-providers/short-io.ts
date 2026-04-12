/**
 * Short.io short link provider
 *
 * Docs:
 * - Create link: https://developers.short.io/reference/post_links
 *   POST /links — body: { originalURL, domain } — response: { shortURL, idString, id, DomainId }
 * - Get link info: https://developers.short.io/reference/get_links-expand
 *   GET /links/expand?domain_id=<int>&path=<path> — response: { id, DomainId, idString, ... }
 * - Get click stats: https://developers.short.io/docs/getting-clicks-for-links-per-id
 *   GET https://api-v2.short.io/statistics/domain/{DomainId}/link_clicks?ids=<id>
 *   Response: { "<id>": <clicks> }
 */
import type { ShortLinkProvider } from "./types";

const SHORT_IO_API = "https://api.short.io";
const SHORT_IO_STATS_API = "https://api-v2.short.io";

export const shortIoProvider: ShortLinkProvider = {
	shortLinkDomain: "short.io",

	async shorten(apiKey, domain, url) {
		if (!domain) {
			throw new Error("Short.io requires a custom domain");
		}

		const res = await fetch(`${SHORT_IO_API}/links`, {
			method: "POST",
			headers: {
				Authorization: apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				originalURL: url,
				domain,
			}),
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Short.io API error (${res.status}): ${text}`);
		}

		const data = (await res.json()) as { shortURL: string };
		return data.shortURL;
	},

	async getClickCount(apiKey, shortUrl) {
		const counts = await this.getClickCounts(apiKey, [shortUrl]);
		return counts.get(shortUrl) ?? 0;
	},

	async getClickCounts(apiKey, shortUrls) {
		const result = new Map<string, number>();

		const tasks = shortUrls.map(async (shortUrl) => {
			try {
				const parsed = new URL(shortUrl);
				const path = parsed.pathname.slice(1); // remove leading /

				// Step 1: Get the link's numeric id and DomainId via /links/expand
				// The endpoint accepts domain (hostname string) or domain_id (integer)
				const expandRes = await fetch(
					`${SHORT_IO_API}/links/expand?domain=${encodeURIComponent(parsed.hostname)}&path=${encodeURIComponent(path)}`,
					{
						headers: { Authorization: apiKey },
					},
				);

				if (!expandRes.ok) return;

				const linkData = (await expandRes.json()) as {
					id: number;
					DomainId: number;
				};
				if (!linkData.id || !linkData.DomainId) return;

				// Step 2: Get click stats via the statistics endpoint
				const statsRes = await fetch(
					`${SHORT_IO_STATS_API}/statistics/domain/${linkData.DomainId}/link_clicks?ids=${linkData.id}`,
					{
						headers: { Authorization: apiKey },
					},
				);

				if (statsRes.ok) {
					const stats = (await statsRes.json()) as Record<string, number>;
					const clicks = stats[String(linkData.id)] ?? 0;
					result.set(shortUrl, clicks);
				}
			} catch {
				// Skip failed lookups
			}
		});

		await Promise.allSettled(tasks);
		return result;
	},
};
