export interface ShortLinkProvider {
	/** The default domain for this provider (used to skip already-shortened URLs) */
	shortLinkDomain: string;

	/** Create a short link for the given URL */
	shorten(
		apiKey: string,
		domain: string | null,
		url: string,
	): Promise<string>;

	/** Get click count for a single short URL */
	getClickCount(apiKey: string, shortUrl: string): Promise<number>;

	/** Get click counts for multiple short URLs (batch) */
	getClickCounts(
		apiKey: string,
		shortUrls: string[],
	): Promise<Map<string, number>>;
}

export type ShortLinkProviderType = "relayapi" | "dub" | "short_io" | "bitly";
