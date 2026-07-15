import { XMLParser } from "fast-xml-parser";
import { fetchPublicUrl } from "../lib/fetch-public-url";
import { isBlockedUrlWithDns } from "../lib/ssrf-guard";

export interface FeedItem {
	sourceId?: string | null;
	title: string;
	url: string;
	description: string;
	publishedAt: Date | null;
	imageUrl: string | null;
}

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	isArray: (name) => ["item", "entry"].includes(name),
});

export const RSS_FEED_MAX_BYTES = 2 * 1024 * 1024;

export async function parseFeed(url: string): Promise<FeedItem[]> {
	const response = await fetchPublicUrl(url, {
		headers: { "User-Agent": "RelayAPI/1.0 (RSS Auto-Post)" },
		timeout: 10_000,
		timeoutThroughBody: true,
		maxBytes: RSS_FEED_MAX_BYTES,
	});
	if (!response.ok) throw new Error(`Feed returned HTTP ${response.status}`);

	const parsed = xmlParser.parse(await response.text());
	const rssItems = parsed?.rss?.channel?.item;
	if (rssItems) {
		return rssItems.map(parseRssItem).sort(byDateDesc);
	}
	const atomEntries = parsed?.feed?.entry;
	if (atomEntries) {
		return atomEntries.map(parseAtomEntry).sort(byDateDesc);
	}
	const rdfItems = parsed?.["rdf:RDF"]?.item;
	if (rdfItems) {
		return rdfItems.map(parseRssItem).sort(byDateDesc);
	}
	throw new Error("Unrecognized feed format — expected RSS or Atom");
}

function parseRssItem(item: Record<string, unknown>): FeedItem {
	const sourceId = textValue(item.guid) || null;
	return {
		sourceId,
		title: String(item.title || ""),
		url: String(item.link || sourceId || ""),
		description: stripHtml(
			String(item["content:encoded"] || item.description || item.content || ""),
		),
		publishedAt: parseDate(item.pubDate as string | undefined),
		imageUrl: extractImageUrl(item),
	};
}

function parseAtomEntry(entry: Record<string, unknown>): FeedItem {
	let url = "";
	const link = entry.link as
		| Record<string, string>
		| Record<string, string>[]
		| string
		| undefined;
	if (typeof link === "string") {
		url = link;
	} else if (Array.isArray(link)) {
		const alternate = link.find(
			(candidate) => candidate["@_rel"] === "alternate" || !candidate["@_rel"],
		);
		url = alternate?.["@_href"] || link[0]?.["@_href"] || "";
	} else if (link && typeof link === "object") {
		url = link["@_href"] || "";
	}

	const content = entry.content as Record<string, string> | string | undefined;
	const contentText =
		typeof content === "string" ? content : content?.["#text"] || "";
	return {
		sourceId: textValue(entry.id) || null,
		title: String(entry.title || ""),
		url,
		description: stripHtml(String(contentText || entry.summary || "")),
		publishedAt: parseDate(
			(entry.published || entry.updated) as string | undefined,
		),
		imageUrl: null,
	};
}

function textValue(value: unknown): string {
	if (typeof value === "string" || typeof value === "number") {
		return String(value).trim();
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return textValue(record["#text"] ?? record._text ?? record.value);
	}
	return "";
}

function extractImageUrl(item: Record<string, unknown>): string | null {
	const enclosure = item.enclosure as Record<string, string> | undefined;
	if (enclosure?.["@_type"]?.startsWith("image/")) {
		return enclosure["@_url"] || null;
	}
	const media = item["media:content"] as Record<string, string> | undefined;
	return media?.["@_url"] || null;
}

function stripHtml(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function parseDate(value: string | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function byDateDesc(a: FeedItem, b: FeedItem): number {
	return (b.publishedAt?.getTime() || 0) - (a.publishedAt?.getTime() || 0);
}

export function renderTemplate(
	template: string | null,
	item: FeedItem,
	appendUrl: boolean,
): string {
	let content = template || "{{title}}";
	content = content
		.replace(/\{\{title\}\}/g, item.title)
		.replace(/\{\{url\}\}/g, item.url)
		.replace(/\{\{description\}\}/g, item.description.slice(0, 500))
		.replace(/\{\{published_date\}\}/g, item.publishedAt?.toISOString() || "");
	if (appendUrl && item.url && !content.includes(item.url)) {
		content += `\n\n${item.url}`;
	}
	return content;
}

export async function validateFeedUrl(url: string): Promise<void> {
	const parsed = new URL(url);
	if (!["http:", "https:"].includes(parsed.protocol)) {
		throw new Error("Only HTTP(S) URLs are allowed");
	}
	if (await isBlockedUrlWithDns(url)) {
		throw new Error("Private/local URLs are not allowed");
	}
}

export function normalizeCanonicalFeedUrl(rawUrl: string): string | null {
	try {
		const url = new URL(rawUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hash = "";
		url.hostname = url.hostname.toLowerCase();
		if (
			(url.protocol === "https:" && url.port === "443") ||
			(url.protocol === "http:" && url.port === "80")
		) {
			url.port = "";
		}
		const sorted = [...url.searchParams.entries()].sort(
			([aKey, aValue], [bKey, bValue]) =>
				aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
		);
		url.search = "";
		for (const [key, value] of sorted) url.searchParams.append(key, value);
		if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
		return url.toString();
	} catch {
		return null;
	}
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function canonicalFeedItemIdentity(item: FeedItem): Promise<{
	canonicalFeedItemId: string;
	canonicalUrl: string | null;
}> {
	const sourceId = item.sourceId?.trim() || null;
	const canonicalUrl = normalizeCanonicalFeedUrl(item.url);
	const basis = sourceId
		? `id:${sourceId}`
		: canonicalUrl
			? `url:${canonicalUrl}`
			: `content:${item.title.trim()}\n${item.publishedAt?.toISOString() ?? ""}`;
	return { canonicalFeedItemId: await sha256Hex(basis), canonicalUrl };
}

export function rssFeedItemOperationId(
	ruleId: string,
	canonicalFeedItemId: string,
): string {
	return `rss:${ruleId}:${canonicalFeedItemId}`;
}
