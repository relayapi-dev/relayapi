const markdownCache = new Map<string, Promise<string>>();

export type MarkdownFetcher = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export async function fetchMarkdownContent(
	markdownUrl: string,
	request: MarkdownFetcher = fetch,
): Promise<string> {
	const cached = markdownCache.get(markdownUrl);
	if (cached) return cached;

	const pending = request(markdownUrl).then(async (response) => {
		if (!response.ok) {
			throw new Error(
				`Unable to load Markdown (${response.status} ${response.statusText})`,
			);
		}
		return response.text();
	});
	markdownCache.set(markdownUrl, pending);

	try {
		return await pending;
	} catch (error) {
		if (markdownCache.get(markdownUrl) === pending) {
			markdownCache.delete(markdownUrl);
		}
		throw error;
	}
}

export function clearMarkdownContentCache(): void {
	markdownCache.clear();
}
