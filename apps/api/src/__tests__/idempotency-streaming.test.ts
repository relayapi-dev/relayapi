import { describe, expect, it } from "bun:test";
import { idempotencyReceipts } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { ResponseTooLargeError } from "../lib/fetch-public-url";
import {
	bindReceiptRoute,
	idempotencyMiddleware,
	replayBodyForStatus,
	trackRequestDigest,
} from "../middleware/idempotency";
import type { Env, Variables } from "../types";

function hex(value: ArrayBuffer): string {
	return Array.from(new Uint8Array(value), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

describe("idempotency request digest streaming", () => {
	it("uses a bounded route digest in the unique receipt index", () => {
		const uniqueColumns = getTableConfig(idempotencyReceipts)
			.indexes.filter((index) => index.config.unique)
			.map((index) =>
				index.config.columns.flatMap((column) =>
					typeof (column as { name?: unknown }).name === "string"
						? [(column as { name: string }).name]
						: [],
				),
			);

		expect(uniqueColumns).toContainEqual([
			"organization_id",
			"method",
			"route_hash",
			"idempotency_key",
		]);
		expect(uniqueColumns.flat()).not.toContain("route");
	});

	it("does not touch receipts or the database when no key is supplied", async () => {
		const app = new Hono<{ Bindings: Env; Variables: Variables }>();
		const unavailableDb = new Proxy({} as Variables["db"], {
			get() {
				throw new Error("database access is not allowed");
			},
		});
		app.use("*", async (c, next) => {
			c.set("db", unavailableDb);
			await next();
		});
		app.use("*", idempotencyMiddleware);
		app.post("/mutation", (c) => c.json({ ok: true }));

		const response = await app.request("/mutation", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value: 1 }),
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean };
		expect(body).toEqual({ ok: true });
	});

	it("binds receipt routes to a canonical authorization boundary", async () => {
		const authorization = {
			orgId: "org_1",
			keyId: "key_1",
			permissions: ["write", "read", "write"],
			workspaceScope: ["ws_2", "ws_1", "ws_2"],
		} satisfies Pick<
			Variables,
			"orgId" | "keyId" | "permissions" | "workspaceScope"
		>;
		const route = "/v1/posts?workspace_id=ws_1";
		const bound = await bindReceiptRoute("POST", route, authorization);
		const reordered = await bindReceiptRoute("POST", route, {
			...authorization,
			permissions: ["read", "write"],
			workspaceScope: ["ws_1", "ws_2"],
		});

		expect(bound).toBe(reordered);
		expect(bound.startsWith(`${route}\nrelay-authorization:`)).toBe(true);
		expect(bound).not.toContain(authorization.keyId);
		expect(
			await bindReceiptRoute("POST", route, {
				...authorization,
				keyId: "key_2",
			}),
		).not.toBe(bound);
		expect(
			await bindReceiptRoute("POST", route, {
				...authorization,
				orgId: "org_2",
			}),
		).not.toBe(bound);
		expect(
			await bindReceiptRoute("POST", route, {
				...authorization,
				workspaceScope: ["ws_1"],
			}),
		).not.toBe(bound);
	});

	it("preserves the streamed body and hashes its exact bytes", async () => {
		const chunks = ["first-", "second-", "third"];
		const encoder = new TextEncoder();
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				const next = chunks.shift();
				if (next === undefined) return controller.close();
				controller.enqueue(encoder.encode(next));
			},
		});
		const tracked = trackRequestDigest(
			new Request("https://api.example.test/v1/media", {
				method: "POST",
				body: source,
				duplex: "half",
			} as RequestInit & { duplex: "half" }),
		);

		const body = await tracked.request.text();
		const expected = hex(
			await crypto.subtle.digest("SHA-256", encoder.encode(body)),
		);
		expect(body).toBe("first-second-third");
		expect(await tracked.digest).toBe(expected);
	});

	it("rejects an oversized declaration before reading the stream", () => {
		const request = new Request("https://api.example.test/v1/media", {
			method: "POST",
			body: "x",
			headers: { "content-length": String(65 * 1024 * 1024) },
		});
		expect(() => trackRequestDigest(request)).toThrow(ResponseTooLargeError);
	});

	it("replays null-body statuses without constructing an illegal body", () => {
		for (const status of [204, 205, 304]) {
			const replay = new Response(replayBodyForStatus(status, ""), { status });
			expect(replay.status).toBe(status);
			expect(replay.body).toBeNull();
		}
		expect(replayBodyForStatus(200, "{}")).toBe("{}");
	});
});
