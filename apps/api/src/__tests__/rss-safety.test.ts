import { afterEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ResponseTooLargeError } from "../lib/fetch-public-url";
import autoPostRouter from "../routes/auto-post-rules";
import { parseFeed, RSS_FEED_MAX_BYTES } from "../services/feed-parser";
import type { Env, Variables } from "../types";

const originalFetch = globalThis.fetch;
const relayPresign =
	"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/relayapi-media/org_1/feed.xml?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=credential&X-Amz-Date=20260713T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=signature";

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("RSS resource bounds", () => {
	it("rejects an oversized declared feed before buffering it", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response("<rss />", {
					headers: { "content-length": String(RSS_FEED_MAX_BYTES + 1) },
				}),
		) as unknown as typeof fetch;

		await expect(parseFeed(relayPresign)).rejects.toBeInstanceOf(
			ResponseTooLargeError,
		);
	});

	it("enforces the feed limit when Content-Length is absent", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(RSS_FEED_MAX_BYTES));
							controller.enqueue(new Uint8Array([1]));
							controller.close();
						},
					}),
				),
		) as unknown as typeof fetch;

		await expect(parseFeed(relayPresign)).rejects.toBeInstanceOf(
			ResponseTooLargeError,
		);
	});

	it("returns every feed item that fits within the byte bound", async () => {
		const itemCount = 101;
		const items = Array.from({ length: itemCount }, (_, index) => {
			const published = new Date(index * 60_000).toUTCString();
			return `<item><guid>${index}</guid><title>Item ${index}</title><link>https://example.com/${index}</link><pubDate>${published}</pubDate></item>`;
		}).join("");
		const xml = `<rss><channel>${items}</channel></rss>`;
		globalThis.fetch = mock(
			async () =>
				new Response(xml, {
					headers: {
						"content-length": String(new TextEncoder().encode(xml).length),
					},
				}),
		) as unknown as typeof fetch;

		const parsed = await parseFeed(relayPresign);
		expect(parsed).toHaveLength(itemCount);
		expect(parsed[0]?.sourceId).toBe(String(itemCount - 1));
		expect(parsed.some((item) => item.sourceId === "0")).toBe(true);
	});
});

function sqlReferencesColumn(value: unknown, column: string): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { name?: unknown; queryChunks?: unknown[] };
	if (candidate.name === column) return true;
	return (
		candidate.queryChunks?.some((chunk) =>
			sqlReferencesColumn(chunk, column),
		) ?? false
	);
}

describe("RSS pause fencing", () => {
	it("invalidates an in-flight lease when a rule is paused", async () => {
		const now = new Date("2026-07-13T12:00:00.000Z");
		const rule = {
			id: "apr_test",
			organizationId: "org_test",
			workspaceId: null,
			name: "Feed",
			feedUrl: "https://example.com/feed.xml",
			pollingIntervalMinutes: 15,
			contentTemplate: "{{title}}",
			appendFeedUrl: true,
			accountIds: [],
			status: "active",
			consecutiveErrors: 0,
			lastProcessedUrl: null,
			lastProcessedAt: null,
			lastError: null,
			leaseToken: 4,
			leaseExpiresAt: new Date(now.getTime() + 60_000),
			createdAt: now,
			updatedAt: now,
		};
		let updateValues: Record<string, unknown> | undefined;
		const db = {
			select: () => ({
				from: () => ({
					where: () => ({ limit: async () => [rule] }),
				}),
			}),
			update: () => ({
				set: (values: Record<string, unknown>) => {
					updateValues = values;
					return {
						where: () => ({
							returning: async () => [
								{ ...rule, status: "paused", updatedAt: values.updatedAt },
							],
						}),
					};
				},
			}),
		};
		const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
		app.use("*", async (c, next) => {
			c.set("orgId", "org_test");
			c.set("workspaceScope", "all");
			c.set("db", db as never);
			await next();
		});
		app.route("/", autoPostRouter);

		const response = await app.request(
			"/apr_test/pause",
			{ method: "POST" },
			{} as Env,
		);
		expect(response.status).toBe(200);
		expect(updateValues?.status).toBe("paused");
		expect(updateValues?.leaseExpiresAt).toBeNull();
		expect(sqlReferencesColumn(updateValues?.leaseToken, "lease_token")).toBe(
			true,
		);
	});

	it("requires active status for every worker lease commit", async () => {
		const source = await Bun.file(
			new URL("../services/rss-generator.ts", import.meta.url),
		).text();
		expect(source).not.toContain('status: shouldPause ? "error" : "active"');
		expect(
			source.match(/eq\(autoPostRules\.status, "active"\)/g)?.length ?? 0,
		).toBeGreaterThanOrEqual(6);
	});
});
