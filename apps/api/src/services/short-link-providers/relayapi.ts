/**
 * Built-in RelayAPI short links.
 *
 * PostgreSQL is the authority for code allocation, redirect targets, and click
 * counts. KV is only a repairable redirect cache and is never consulted to
 * decide whether a code is available.
 */
import {
	assertKvPrivacyStoreKey,
	type Database,
	shortLinks,
} from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import type { ShortLinkProvider } from "./types";

const CODE_LENGTH = 7;
const CODE_CHARS =
	"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const MAX_ALLOCATION_ATTEMPTS = 16;
export const RELAY_API_SHORT_LINK_CACHE_TTL_SECONDS = 24 * 60 * 60;

export type RelayApiShortLinkCandidate = {
	organizationId: string;
	workspaceId: string | null;
	originalUrl: string;
	providerConfigVersion?: number;
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
	put(
		key: string,
		value: string,
		options: { expirationTtl: number },
	): Promise<void>;
	delete(key: string): Promise<void>;
}

export function relayApiShortLinkCacheKey(shortCode: string): string {
	return `short-link:${shortCode}`;
}

async function cacheRelayApiShortLink(
	cache: RelayApiShortLinkCache,
	shortCode: string,
	originalUrl: string,
): Promise<void> {
	await cache.put(relayApiShortLinkCacheKey(shortCode), originalUrl, {
		expirationTtl: RELAY_API_SHORT_LINK_CACHE_TTL_SECONDS,
	});
}

/**
 * Best-effort invalidation for durable link or owner erasure. PostgreSQL is
 * authoritative, so a failed KV delete cannot preserve a deleted redirect;
 * the finite TTL bounds the remaining derived copy.
 */
export async function invalidateRelayApiShortLinkCaches(
	cache: Pick<RelayApiShortLinkCache, "delete">,
	shortCodes: readonly string[],
): Promise<{ deleted: number; failed: number }> {
	const keys = [
		...new Set(
			shortCodes.map((shortCode) => relayApiShortLinkCacheKey(shortCode)),
		),
	];
	const results = await Promise.allSettled(
		keys.map((key) =>
			cache.delete(assertKvPrivacyStoreKey("kv:short-link", key)),
		),
	);
	const failed = results.filter(
		(result) => result.status === "rejected",
	).length;
	if (failed > 0) {
		console.error("[ShortLinks] Best-effort KV invalidation failed", {
			requested: keys.length,
			failed,
		});
	}
	return { deleted: keys.length - failed, failed };
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
			const now = new Date();
			const [inserted] = await db
				.insert(shortLinks)
				.values({
					organizationId: candidate.organizationId,
					workspaceId: candidate.workspaceId,
					originalUrl: candidate.originalUrl,
					provider: "relayapi",
					providerConfigVersion: candidate.providerConfigVersion ?? 1,
					credentialVersion: null,
					providerRef: {
						provider: "relayapi",
						shortCode: candidate.shortCode,
					},
					creationStatus: "active",
					creationCompletedAt: now,
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
	providerConfigVersion?: number;
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
		const shortUrl = `${shortDomain}/s/${shortCode}`;
		const inserted = await input.store.insertCandidate({
			organizationId: input.organizationId,
			workspaceId: input.workspaceId,
			originalUrl: input.originalUrl,
			providerConfigVersion: input.providerConfigVersion,
			shortCode,
			shortUrl,
		});
		if (!inserted) continue;

		// Cache only after PostgreSQL has durably accepted this exact code/target.
		try {
			await cacheRelayApiShortLink(input.cache, shortCode, input.originalUrl);
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
		const cached = await input.cache.get(
			relayApiShortLinkCacheKey(input.shortCode),
		);
		if (cached !== row.originalUrl) {
			await cacheRelayApiShortLink(
				input.cache,
				input.shortCode,
				row.originalUrl,
			);
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
	providerConfigVersion?: number;
}): ShortLinkProvider {
	const base = input.baseUrl.replace(/\/$/, "");
	const store = createRelayApiShortLinkStore(input.db);

	return {
		providerType: "relayapi",
		shortLinkDomain: new URL(base).hostname,

		async shorten(_apiKey, domain, url, _intentId) {
			const result = await allocateRelayApiShortLink({
				store,
				cache: input.kv,
				baseUrl: base,
				domain,
				organizationId: input.organizationId,
				workspaceId: input.workspaceId,
				originalUrl: url,
				providerConfigVersion: input.providerConfigVersion,
			});
			return {
				shortUrl: result.shortUrl,
				providerRef: {
					provider: "relayapi",
					shortCode: result.shortCode,
				},
			};
		},

		async probeCredential() {
			// The built-in provider has no external credential to probe.
		},

		async deleteLink(_apiKey, providerRef) {
			if (providerRef.provider !== "relayapi") {
				return {
					kind: "unknown",
					reason: "relayapi_provider_reference_mismatch",
				};
			}
			// Durable database deletion is performed in the owning transaction.
			return { kind: "deleted" };
		},

		async getClickCount(_apiKey, target) {
			const code =
				target.providerRef.provider === "relayapi"
					? target.providerRef.shortCode
					: extractCode(target.shortUrl);
			return code ? store.getClickCount(code) : 0;
		},

		async getClickCounts(_apiKey, targets) {
			const result = new Map<string, number>();
			await Promise.all(
				targets.map(async (target) => {
					const code =
						target.providerRef.provider === "relayapi"
							? target.providerRef.shortCode
							: extractCode(target.shortUrl);
					result.set(target.key, code ? await store.getClickCount(code) : 0);
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
		// /s is canonical; /r remains readable for links issued before the split.
		const match = url.pathname.match(/^\/(?:s|r)\/([a-zA-Z0-9]+)$/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}
