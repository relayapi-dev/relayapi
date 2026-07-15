/**
 * Built-in RelayAPI short links.
 *
 * PostgreSQL is the authority for code allocation, redirect targets, and click
 * counts. KV is only a repairable redirect cache and is never consulted to
 * decide whether a code is available.
 */
import { type Database, shortLinks } from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import type { ShortLinkProvider } from "./types";

const CODE_LENGTH = 7;
const CODE_CHARS =
	"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const MAX_ALLOCATION_ATTEMPTS = 16;

export type RelayApiShortLinkCandidate = {
	organizationId: string;
	workspaceId: string | null;
	originalUrl: string;
	shortCode: string;
	shortUrl: string;
};

export type RelayApiResolvedLink = {
	originalUrl: string;
	clickCount: number;
};

export interface RelayApiShortLinkStore {
	insertCandidate(candidate: RelayApiShortLinkCandidate): Promise<boolean>;
	resolveAndIncrement(shortCode: string): Promise<RelayApiResolvedLink | null>;
	getClickCount(shortCode: string): Promise<number>;
}

export interface RelayApiShortLinkCache {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
}

function generateShortCode(): string {
	const bytes = new Uint8Array(CODE_LENGTH);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((byte) => CODE_CHARS[byte % CODE_CHARS.length])
		.join("");
}

function assertSafeTarget(url: string): void {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Short link targets must use http or https");
	}
}

export function createRelayApiShortLinkStore(
	db: Database,
): RelayApiShortLinkStore {
	return {
		async insertCandidate(candidate) {
			const [inserted] = await db
				.insert(shortLinks)
				.values({
					organizationId: candidate.organizationId,
					workspaceId: candidate.workspaceId,
					originalUrl: candidate.originalUrl,
					provider: "relayapi",
					shortCode: candidate.shortCode,
					shortUrl: candidate.shortUrl,
				})
				// The provider+code unique index arbitrates concurrent allocators. A
				// conflicting candidate returns no row, so the loser retries a new code.
				.onConflictDoNothing()
				.returning({ id: shortLinks.id });
			return Boolean(inserted);
		},

		async resolveAndIncrement(shortCode) {
			const [row] = await db
				.update(shortLinks)
				.set({ clickCount: sql`${shortLinks.clickCount} + 1` })
				.where(
					and(
						eq(shortLinks.provider, "relayapi"),
						eq(shortLinks.shortCode, shortCode),
					),
				)
				.returning({
					originalUrl: shortLinks.originalUrl,
					clickCount: shortLinks.clickCount,
				});
			return row ?? null;
		},

		async getClickCount(shortCode) {
			const [row] = await db
				.select({ clickCount: shortLinks.clickCount })
				.from(shortLinks)
				.where(
					and(
						eq(shortLinks.provider, "relayapi"),
						eq(shortLinks.shortCode, shortCode),
					),
				)
				.limit(1);
			return row?.clickCount ?? 0;
		},
	};
}

export async function allocateRelayApiShortLink(input: {
	store: RelayApiShortLinkStore;
	cache: RelayApiShortLinkCache;
	baseUrl: string;
	domain: string | null;
	organizationId: string;
	workspaceId: string | null;
	originalUrl: string;
	generateCode?: () => string;
	maxAttempts?: number;
}): Promise<{ shortCode: string; shortUrl: string }> {
	assertSafeTarget(input.originalUrl);
	const base = input.baseUrl.replace(/\/$/, "");
	const shortDomain = input.domain ? `https://${input.domain}` : base;
	const nextCode = input.generateCode ?? generateShortCode;
	const maxAttempts = input.maxAttempts ?? MAX_ALLOCATION_ATTEMPTS;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const shortCode = nextCode();
		const shortUrl = `${shortDomain}/r/${shortCode}`;
		const inserted = await input.store.insertCandidate({
			organizationId: input.organizationId,
			workspaceId: input.workspaceId,
			originalUrl: input.originalUrl,
			shortCode,
			shortUrl,
		});
		if (!inserted) continue;

		// Cache only after PostgreSQL has durably accepted this exact code/target.
		try {
			await input.cache.put(`sl:${shortCode}`, input.originalUrl);
		} catch (error) {
			console.error(
				`[ShortLinks] Failed to cache allocated code ${shortCode}:`,
				error,
			);
		}
		return { shortCode, shortUrl };
	}

	throw new Error("Unable to allocate a unique RelayAPI short code");
}

export async function resolveRelayApiRedirect(input: {
	store: RelayApiShortLinkStore;
	cache: RelayApiShortLinkCache;
	shortCode: string;
}): Promise<RelayApiResolvedLink | null> {
	const row = await input.store.resolveAndIncrement(input.shortCode);
	if (!row) return null;

	// A miss or stale/poisoned value is repaired from PostgreSQL. Redirect logic
	// never trusts the cache value over the durable row.
	try {
		const cached = await input.cache.get(`sl:${input.shortCode}`);
		if (cached !== row.originalUrl) {
			await input.cache.put(`sl:${input.shortCode}`, row.originalUrl);
		}
	} catch (error) {
		console.error(
			`[ShortLinks] Failed to repair cache for code ${input.shortCode}:`,
			error,
		);
	}

	return row;
}

/** Create the built-in provider with request-scoped database ownership. */
export function createRelayApiProvider(input: {
	db: Database;
	kv: KVNamespace;
	baseUrl: string;
	organizationId: string;
	workspaceId: string | null;
}): ShortLinkProvider {
	const base = input.baseUrl.replace(/\/$/, "");
	const store = createRelayApiShortLinkStore(input.db);

	return {
		shortLinkDomain: new URL(base).hostname,

		async shorten(_apiKey, domain, url) {
			const result = await allocateRelayApiShortLink({
				store,
				cache: input.kv,
				baseUrl: base,
				domain,
				organizationId: input.organizationId,
				workspaceId: input.workspaceId,
				originalUrl: url,
			});
			return result.shortUrl;
		},

		async getClickCount(_apiKey, shortUrl) {
			const code = extractCode(shortUrl);
			return code ? store.getClickCount(code) : 0;
		},

		async getClickCounts(_apiKey, shortUrls) {
			const result = new Map<string, number>();
			await Promise.all(
				shortUrls.map(async (shortUrl) => {
					const code = extractCode(shortUrl);
					result.set(shortUrl, code ? await store.getClickCount(code) : 0);
				}),
			);
			return result;
		},
	};
}

/** Extract a code from a RelayAPI short URL. */
export function extractRelayApiShortCode(shortUrl: string): string | null {
	return extractCode(shortUrl);
}

function extractCode(shortUrl: string): string | null {
	try {
		const url = new URL(shortUrl);
		const match = url.pathname.match(/^\/r\/([a-zA-Z0-9]+)$/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}
