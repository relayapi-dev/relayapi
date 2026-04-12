import type { ShortLinkProvider } from "./short-link-providers";

const URL_REGEX = /https?:\/\/[^\s"'<>()]+/g;

export interface ShortenedUrl {
	original: string;
	short: string;
}

/**
 * Extract URLs from content, shorten them via the provider, and replace in text.
 * Uses Promise.allSettled — failed URLs are left as-is (graceful degradation).
 */
export async function shortenUrlsInContent(
	provider: ShortLinkProvider,
	apiKey: string,
	domain: string | null,
	content: string,
): Promise<{ content: string; shortenedUrls: ShortenedUrl[] }> {
	const rawMatches = content.match(URL_REGEX) || [];
	// Strip trailing punctuation that may follow a URL in natural language
	const urls = [...new Set(rawMatches.map((u) => u.replace(/[.,!?;:'")\]>]+$/, "")))];

	// Skip URLs already on the provider's short link domain
	const providerDomain = domain ?? provider.shortLinkDomain;
	const toShorten = urls.filter((url) => {
		try {
			return !new URL(url).hostname.endsWith(providerDomain);
		} catch {
			return true;
		}
	});

	if (toShorten.length === 0) {
		return { content, shortenedUrls: [] };
	}

	const results = await Promise.allSettled(
		toShorten.map(async (url) => {
			const short = await provider.shorten(apiKey, domain, url);
			return { original: url, short };
		}),
	);

	const shortenedUrls: ShortenedUrl[] = [];
	let processedContent = content;

	// Sort by descending original URL length to avoid substring collisions
	// (e.g. replacing "https://example.com" before "https://example.com/blog")
	const fulfilled = results
		.filter((r): r is PromiseFulfilledResult<ShortenedUrl> => r.status === "fulfilled")
		.sort((a, b) => b.value.original.length - a.value.original.length);

	for (const result of fulfilled) {
		processedContent = processedContent.replaceAll(
			result.value.original,
			result.value.short,
		);
		shortenedUrls.push(result.value);
	}

	return { content: processedContent, shortenedUrls };
}
