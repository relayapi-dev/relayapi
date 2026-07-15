import { describe, expect, it } from "bun:test";
import {
	allocateRelayApiShortLink,
	type RelayApiShortLinkCache,
	type RelayApiShortLinkCandidate,
	type RelayApiShortLinkStore,
	resolveRelayApiRedirect,
} from "../services/short-link-providers/relayapi";

class MemoryStore implements RelayApiShortLinkStore {
	readonly links = new Map<
		string,
		RelayApiShortLinkCandidate & { clickCount: number }
	>();
	insertAttempts = 0;

	async insertCandidate(
		candidate: RelayApiShortLinkCandidate,
	): Promise<boolean> {
		this.insertAttempts++;
		// Yield so two allocators can contend for the same candidate.
		await Promise.resolve();
		if (this.links.has(candidate.shortCode)) return false;
		this.links.set(candidate.shortCode, { ...candidate, clickCount: 0 });
		return true;
	}

	async resolveAndIncrement(shortCode: string) {
		const row = this.links.get(shortCode);
		if (!row) return null;
		row.clickCount++;
		return { originalUrl: row.originalUrl, clickCount: row.clickCount };
	}

	async getClickCount(shortCode: string): Promise<number> {
		return this.links.get(shortCode)?.clickCount ?? 0;
	}
}

class MemoryCache implements RelayApiShortLinkCache {
	readonly values = new Map<string, string>();
	readonly operations: string[] = [];

	async get(key: string): Promise<string | null> {
		this.operations.push(`get:${key}`);
		return this.values.get(key) ?? null;
	}

	async put(key: string, value: string): Promise<void> {
		this.operations.push(`put:${key}:${value}`);
		this.values.set(key, value);
	}
}

function sequence(...codes: string[]): () => string {
	let index = 0;
	return () => codes[index++] ?? codes.at(-1) ?? "fallback1";
}

describe("RelayAPI short-link allocation", () => {
	it("uses the database conflict as the concurrency arbiter", async () => {
		const store = new MemoryStore();
		const cache = new MemoryCache();
		const common = {
			store,
			cache,
			baseUrl: "https://api.relayapi.dev",
			domain: null,
			organizationId: "org_1",
			workspaceId: null,
		};

		const [first, second] = await Promise.all([
			allocateRelayApiShortLink({
				...common,
				originalUrl: "https://example.com/first",
				generateCode: sequence("same001", "first01"),
			}),
			allocateRelayApiShortLink({
				...common,
				originalUrl: "https://example.com/second",
				generateCode: sequence("same001", "second1"),
			}),
		]);

		expect(first.shortCode).not.toBe(second.shortCode);
		expect(store.links.size).toBe(2);
		expect(store.insertAttempts).toBe(3);
		expect(cache.values.size).toBe(2);
		expect(cache.values.has("sl:same001")).toBe(true);
		expect(
			cache.operations.filter((operation) => operation.startsWith("put:")),
		).toHaveLength(2);
	});

	it("does not write KV for a database-rejected candidate", async () => {
		const operations: string[] = [];
		const store: RelayApiShortLinkStore = {
			async insertCandidate(candidate) {
				operations.push(`db:${candidate.shortCode}`);
				return candidate.shortCode === "winner1";
			},
			async resolveAndIncrement() {
				return null;
			},
			async getClickCount() {
				return 0;
			},
		};
		const cache: RelayApiShortLinkCache = {
			async get() {
				return null;
			},
			async put(key) {
				operations.push(`kv:${key}`);
			},
		};

		await allocateRelayApiShortLink({
			store,
			cache,
			baseUrl: "https://api.relayapi.dev",
			domain: null,
			organizationId: "org_1",
			workspaceId: "ws_1",
			originalUrl: "https://example.com",
			generateCode: sequence("loser01", "winner1"),
		});

		expect(operations).toEqual(["db:loser01", "db:winner1", "kv:sl:winner1"]);
	});
});

describe("RelayAPI redirect resolution", () => {
	it("resolves a cache miss from the exact database row and repairs KV", async () => {
		const store = new MemoryStore();
		const cache = new MemoryCache();
		await store.insertCandidate({
			organizationId: "org_1",
			workspaceId: null,
			originalUrl: "https://example.com/durable",
			shortCode: "durable1",
			shortUrl: "https://api.relayapi.dev/r/durable1",
		});

		const resolved = await resolveRelayApiRedirect({
			store,
			cache,
			shortCode: "durable1",
		});

		expect(resolved).toEqual({
			originalUrl: "https://example.com/durable",
			clickCount: 1,
		});
		expect(cache.values.get("sl:durable1")).toBe("https://example.com/durable");
	});

	it("ignores a KV ghost when PostgreSQL has no matching provider/code row", async () => {
		const store = new MemoryStore();
		const cache = new MemoryCache();
		cache.values.set("sl:ghost01", "https://attacker.example");

		expect(
			await resolveRelayApiRedirect({
				store,
				cache,
				shortCode: "ghost01",
			}),
		).toBeNull();
		expect(cache.operations).toEqual([]);
	});

	it("increments only the requested code under concurrent clicks", async () => {
		const store = new MemoryStore();
		const cache = new MemoryCache();
		for (const code of ["target01", "other001"]) {
			await store.insertCandidate({
				organizationId: "org_1",
				workspaceId: null,
				originalUrl: `https://example.com/${code}`,
				shortCode: code,
				shortUrl: `https://api.relayapi.dev/r/${code}`,
			});
		}

		await Promise.all(
			Array.from({ length: 20 }, () =>
				resolveRelayApiRedirect({ store, cache, shortCode: "target01" }),
			),
		);

		expect(await store.getClickCount("target01")).toBe(20);
		expect(await store.getClickCount("other001")).toBe(0);
	});
});

describe("PostgreSQL store contract", () => {
	it("uses insert-on-conflict and exact provider+code predicates", async () => {
		const source = await Bun.file(
			new URL("../services/short-link-providers/relayapi.ts", import.meta.url),
		).text();
		expect(source).toContain(".onConflictDoNothing()");
		expect(source).toContain('eq(shortLinks.provider, "relayapi")');
		expect(source).toContain("eq(shortLinks.shortCode, shortCode)");
		expect(source).not.toContain("shortLinks.shortUrl} LIKE");
	});
});
