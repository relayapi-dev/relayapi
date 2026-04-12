import {
	createDb,
	autoPostRules,
	posts,
	postTargets,
	socialAccounts,
	eq,
} from "@relayapi/db";
import { and, sql, isNull, or, inArray } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { dispatchWebhookEvent } from "./webhook-delivery";
import { fetchPublicUrl } from "../lib/fetch-public-url";
import { isBlockedUrlWithDns } from "../lib/ssrf-guard";
import { incrementUsage } from "../middleware/usage-tracking";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Feed item shape
// ---------------------------------------------------------------------------

export interface FeedItem {
	title: string;
	url: string;
	description: string;
	publishedAt: Date | null;
	imageUrl: string | null;
}

// ---------------------------------------------------------------------------
// Feed parser (CF Workers compatible via fast-xml-parser)
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	isArray: (name) => ["item", "entry"].includes(name),
});

export async function parseFeed(url: string): Promise<FeedItem[]> {
	const res = await fetchPublicUrl(url, {
		headers: { "User-Agent": "RelayAPI/1.0 (RSS Auto-Post)" },
		timeout: 10_000,
	});

	if (!res.ok) {
		throw new Error(`Feed returned HTTP ${res.status}`);
	}

	const text = await res.text();
	const parsed = xmlParser.parse(text);

	// RSS 2.0
	const rssItems = parsed?.rss?.channel?.item;
	if (rssItems) {
		return rssItems.map(parseRssItem).sort(byDateDesc);
	}

	// Atom
	const atomEntries = parsed?.feed?.entry;
	if (atomEntries) {
		return atomEntries.map(parseAtomEntry).sort(byDateDesc);
	}

	// RSS 1.0 (RDF)
	const rdfItems = parsed?.["rdf:RDF"]?.item;
	if (rdfItems) {
		return rdfItems.map(parseRssItem).sort(byDateDesc);
	}

	throw new Error("Unrecognized feed format — expected RSS or Atom");
}

function parseRssItem(item: Record<string, unknown>): FeedItem {
	return {
		title: String(item.title || ""),
		url: String(item.link || item.guid || ""),
		description: stripHtml(
			String(
				item["content:encoded"] ||
					item.description ||
					item.content ||
					"",
			),
		),
		publishedAt: parseDate(item.pubDate as string | undefined),
		imageUrl: extractImageUrl(item),
	};
}

function parseAtomEntry(entry: Record<string, unknown>): FeedItem {
	// Atom links can be objects or arrays of objects
	let url = "";
	const link = entry.link as
		| Record<string, string>
		| Record<string, string>[]
		| string
		| undefined;
	if (typeof link === "string") {
		url = link;
	} else if (Array.isArray(link)) {
		const alt = link.find(
			(l) => l["@_rel"] === "alternate" || !l["@_rel"],
		);
		url = alt?.["@_href"] || link[0]?.["@_href"] || "";
	} else if (link && typeof link === "object") {
		url = link["@_href"] || "";
	}

	const content = entry.content as Record<string, string> | string | undefined;
	const contentText =
		typeof content === "string"
			? content
			: content?.["#text"] || "";

	return {
		title: String(entry.title || ""),
		url,
		description: stripHtml(
			String(contentText || entry.summary || ""),
		),
		publishedAt: parseDate(
			(entry.published || entry.updated) as string | undefined,
		),
		imageUrl: null,
	};
}

function extractImageUrl(item: Record<string, unknown>): string | null {
	// RSS <enclosure> with image type
	const enclosure = item.enclosure as Record<string, string> | undefined;
	if (enclosure?.["@_type"]?.startsWith("image/")) {
		return enclosure["@_url"] || null;
	}
	// <media:content>
	const media = item["media:content"] as Record<string, string> | undefined;
	if (media?.["@_url"]) {
		return media["@_url"];
	}
	return null;
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

function parseDate(str: string | undefined): Date | null {
	if (!str) return null;
	const d = new Date(str);
	return Number.isNaN(d.getTime()) ? null : d;
}

function byDateDesc(a: FeedItem, b: FeedItem): number {
	return (b.publishedAt?.getTime() || 0) - (a.publishedAt?.getTime() || 0);
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

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
		.replace(
			/\{\{published_date\}\}/g,
			item.publishedAt?.toISOString() || "",
		);

	if (appendUrl && item.url && !content.includes(item.url)) {
		content += "\n\n" + item.url;
	}
	return content;
}

// ---------------------------------------------------------------------------
// SSRF validation
// ---------------------------------------------------------------------------

export async function validateFeedUrl(url: string): Promise<void> {
	const parsed = new URL(url);
	if (!["http:", "https:"].includes(parsed.protocol)) {
		throw new Error("Only HTTP(S) URLs are allowed");
	}
	if (await isBlockedUrlWithDns(url)) {
		throw new Error("Private/local URLs are not allowed");
	}
}

// ---------------------------------------------------------------------------
// New items detection (processes all new items, not just the newest)
// ---------------------------------------------------------------------------

function getNewItems(items: FeedItem[], lastProcessedUrl: string | null): FeedItem[] {
	// Filter out items with no URL — they can't be deduped
	const validItems = items.filter((item) => item.url);

	if (!lastProcessedUrl) {
		// First run — return only the newest item to avoid flooding
		return validItems.slice(0, 1);
	}

	const newItems: FeedItem[] = [];
	for (const item of validItems) {
		if (item.url === lastProcessedUrl) break;
		newItems.push(item);
	}
	// Cap at 5 to avoid flooding on first sync with a busy feed
	return newItems.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Cron processor — called from scheduled trigger
// ---------------------------------------------------------------------------

export async function processAutoPostRules(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();

	// Find rules that are due for a check
	const dueRules = await db
		.select()
		.from(autoPostRules)
		.where(
			and(
				eq(autoPostRules.status, "active"),
				or(
					isNull(autoPostRules.lastProcessedAt),
					sql`${autoPostRules.lastProcessedAt} + (${autoPostRules.pollingIntervalMinutes} * interval '1 minute') <= ${now.toISOString()}`,
				),
			),
		)
		.limit(10);

	if (dueRules.length === 0) return;

	for (const rule of dueRules) {
		try {
			await processRule(db, env, rule);
		} catch (err) {
			const newErrors = rule.consecutiveErrors + 1;
			const shouldPause = newErrors >= 5;
			await db
				.update(autoPostRules)
				.set({
					consecutiveErrors: newErrors,
					lastError:
						err instanceof Error ? err.message : String(err),
					lastProcessedAt: now,
					status: shouldPause ? "error" : "active",
					updatedAt: now,
				})
				.where(eq(autoPostRules.id, rule.id));

			if (shouldPause) {
				await dispatchWebhookEvent(
					env,
					db,
					rule.organizationId,
					"auto_post.error",
					{
						rule_id: rule.id,
						error:
							err instanceof Error
								? err.message
								: String(err),
					},
					rule.workspaceId,
				);
			}
		}
	}
}

async function processRule(
	db: ReturnType<typeof createDb>,
	env: Env,
	rule: typeof autoPostRules.$inferSelect,
): Promise<void> {
	// 1. Parse the feed
	const items = await parseFeed(rule.feedUrl);
	if (items.length === 0) {
		await db
			.update(autoPostRules)
			.set({
				lastProcessedAt: new Date(),
				consecutiveErrors: 0,
				updatedAt: new Date(),
			})
			.where(eq(autoPostRules.id, rule.id));
		return;
	}

	// 2. Find new items
	const newItems = getNewItems(items, rule.lastProcessedUrl);
	if (newItems.length === 0) {
		await db
			.update(autoPostRules)
			.set({
				lastProcessedAt: new Date(),
				consecutiveErrors: 0,
				updatedAt: new Date(),
			})
			.where(eq(autoPostRules.id, rule.id));
		return;
	}

	// 3. Resolve target accounts
	const accountConditions = [
		eq(socialAccounts.organizationId, rule.organizationId),
	];
	if (rule.accountIds && rule.accountIds.length > 0) {
		accountConditions.push(inArray(socialAccounts.id, rule.accountIds));
	}
	const accounts = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
		})
		.from(socialAccounts)
		.where(and(...accountConditions));

	if (accounts.length === 0) {
		await db
			.update(autoPostRules)
			.set({
				lastProcessedAt: new Date(),
				consecutiveErrors: 0,
				lastError: "No target accounts found",
				updatedAt: new Date(),
			})
			.where(eq(autoPostRules.id, rule.id));
		return;
	}

	// 4. Create posts for each new item (oldest first so they publish in order)
	for (const item of [...newItems].reverse()) {
		const content = renderTemplate(
			rule.contentTemplate,
			item,
			rule.appendFeedUrl,
		);

		// Create the post
		const [post] = await db
			.insert(posts)
			.values({
				organizationId: rule.organizationId,
				workspaceId: rule.workspaceId,
				content,
				status: "scheduled",
				scheduledAt: new Date(), // publish immediately
			})
			.returning();

		if (!post) continue;

		// Create targets
		await db.insert(postTargets).values(
			accounts.map((acc) => ({
				postId: post.id,
				socialAccountId: acc.id,
				platform: acc.platform,
				status: "scheduled" as const,
			})),
		);

		// Increment usage
		await incrementUsage(env.KV, rule.organizationId, accounts.length);

		// Enqueue for publishing
		await env.PUBLISH_QUEUE.send({
			type: "publish",
			post_id: post.id,
			org_id: rule.organizationId,
			usage_tracked: true,
		});

		// Dispatch webhook
		await dispatchWebhookEvent(
			env,
			db,
			rule.organizationId,
			"auto_post.created",
			{
				rule_id: rule.id,
				post_id: post.id,
				feed_item_url: item.url,
				feed_item_title: item.title,
			},
			rule.workspaceId,
		);
	}

	// 5. Update dedup state
	await db
		.update(autoPostRules)
		.set({
			lastProcessedUrl: newItems[0]!.url,
			lastProcessedAt: new Date(),
			consecutiveErrors: 0,
			lastError: null,
			updatedAt: new Date(),
		})
		.where(eq(autoPostRules.id, rule.id));
}
