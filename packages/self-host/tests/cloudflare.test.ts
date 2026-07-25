import { afterEach, describe, expect, mock, test } from "bun:test";
import { CloudflareClient } from "../src/cloudflare.js";
import { QUEUE_NAMES, RESOURCE_NAMES } from "../src/constants.js";
import type { SelfHostConfig } from "../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function response(result: unknown): Response {
	return Response.json({ success: true, result, errors: [], messages: [] });
}

const config: SelfHostConfig = {
	schemaVersion: 1,
	instance: "relayapi",
	cloudflare: {
		accountId: "account-id",
		zoneId: "zone-id",
		rootDomain: "example.com",
		apiHostname: "api.example.com",
		appHostname: "app.example.com",
		mediaHostname: "media.example.com",
		thumbnailHostname: "thumbs.example.com",
	},
	features: { email: false, ai: false, downloader: false },
};

describe("Cloudflare provisioning", () => {
	test("creates a missing stack without placing credentials in URLs", async () => {
		const calls: Array<{
			url: string;
			method: string;
			body?: Record<string, unknown>;
			authorization: string | null;
		}> = [];
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				const body = init?.body ? JSON.parse(String(init.body)) : undefined;
				const headers = new Headers(init?.headers);
				calls.push({
					url,
					method,
					...(body ? { body } : {}),
					authorization: headers.get("authorization"),
				});

				if (method === "GET" && url.includes("/storage/kv/namespaces?")) {
					return response([]);
				}
				if (method === "GET" && url.includes("/r2/buckets?")) {
					return response({ buckets: [] });
				}
				if (method === "GET" && url.includes("/queues?")) return response([]);
				if (method === "GET" && url.includes("/hyperdrive/configs?")) {
					return response([]);
				}
				if (method === "POST" && url.endsWith("/storage/kv/namespaces")) {
					return response({ id: "kv-id", title: RESOURCE_NAMES.kv });
				}
				if (method === "POST" && url.endsWith("/r2/buckets")) {
					return response({ name: body?.name });
				}
				if (method === "POST" && url.endsWith("/queues")) {
					const name = String(body?.queue_name);
					return response({ queue_id: `id-${name}`, queue_name: name });
				}
				if (method === "POST" && url.endsWith("/hyperdrive/configs")) {
					return response({
						id: "hyperdrive-id",
						name: RESOURCE_NAMES.hyperdrive,
					});
				}
				if (method === "GET" && url.endsWith("/lifecycle")) {
					return response({
						rules: [{ id: "operator-owned-rule", enabled: true }],
					});
				}
				if (method === "PUT" && url.endsWith("/lifecycle")) {
					return response({});
				}
				if (method === "PUT" && url.includes("/event_notifications/r2/")) {
					return response({});
				}
				if (method === "GET" && url.endsWith("/domains/custom")) {
					return response({ domains: [] });
				}
				if (method === "POST" && url.endsWith("/domains/custom")) {
					return response({});
				}
				throw new Error(`Unhandled test request: ${method} ${url}`);
			}),
			{ preconnect: originalFetch.preconnect },
		);

		const client = new CloudflareClient(
			"account-id",
			"cloudflare-token",
			"https://cloudflare.test/client/v4",
		);
		const resources = await client.apply(
			config,
			[
				"postgresql://runtime",
				"super-secret@db.example.com/relay?sslmode=verify-full",
			].join(":"),
		);

		expect(resources.kvNamespaceId).toBe("kv-id");
		expect(resources.hyperdriveId).toBe("hyperdrive-id");
		expect(Object.keys(resources.queues)).toHaveLength(QUEUE_NAMES.length);
		expect(
			calls.every((call) => call.authorization === "Bearer cloudflare-token"),
		).toBe(true);
		expect(calls.some((call) => call.url.includes("super-secret"))).toBe(false);
		const hyperdriveCreate = calls.find(
			(call) =>
				call.method === "POST" && call.url.endsWith("/hyperdrive/configs"),
		);
		expect(hyperdriveCreate?.body).toMatchObject({
			origin: {
				host: "db.example.com",
				user: "runtime",
				password: "super-secret",
			},
			caching: { disabled: true },
		});
		const lifecycleUpdates = calls.filter(
			(call) => call.method === "PUT" && call.url.endsWith("/lifecycle"),
		);
		expect(lifecycleUpdates).toHaveLength(2);
		for (const update of lifecycleUpdates) {
			expect(update.body?.rules).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "operator-owned-rule" }),
				]),
			);
		}
	});
});
