import { describe, expect, it } from "bun:test";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Hono } from "hono";
import {
	apiErrorHandler,
	apiNotFoundHandler,
	errorContractMiddleware,
} from "../middleware/error-contract";
import type { Env, Variables } from "../types";

function testApp() {
	const app = new Hono<{ Bindings: Env; Variables: Variables }>();
	app.onError(apiErrorHandler);
	app.notFound(apiNotFoundHandler);
	app.use("*", errorContractMiddleware);

	const child = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
	const route = createRoute({
		method: "post",
		path: "/items",
		request: {
			query: z.object({ limit: z.coerce.number().int().min(1) }),
			body: {
				required: true,
				content: {
					"application/json": { schema: z.object({ name: z.string().min(1) }) },
				},
			},
		},
		responses: { 200: { description: "ok" } },
	});
	child.openapi(route, (c) => c.json({ ok: true }, 200));
	child.get("/broken-response", (c) =>
		c.json({ message: "database password leaked" }, 500),
	);
	child.get("/standard-broken-response", (c) =>
		c.json(
			{
				error: {
					code: "META_API_ERROR",
					message: "provider response leaked a database password",
				},
			},
			500,
		),
	);
	child.get("/standard-upstream-response", (c) =>
		c.json(
			{
				error: {
					code: "UPSTREAM_UNAVAILABLE",
					message: "private upstream diagnostics",
				},
			},
			503,
		),
	);
	child.get("/thrown", () => {
		throw new Error("database password leaked");
	});
	app.route("/v1", child);
	return app;
}

describe("API error contract", () => {
	it("normalizes mounted-router validation failures", async () => {
		const response = await testApp().request("/v1/items?limit=zero", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "item" }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: {
				code: "VALIDATION_ERROR",
				message: "Request validation failed",
				details: { issues: [{ path: ["limit"] }] },
			},
		});
	});

	it("normalizes malformed JSON from mounted routers", async () => {
		const response = await testApp().request("/v1/items?limit=1", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{broken",
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as unknown;
		expect(body).toEqual({
			error: {
				code: "MALFORMED_JSON",
				message: "Malformed JSON in request body",
			},
		});
	});

	it("returns JSON for unknown routes", async () => {
		const response = await testApp().request("/missing");
		expect(response.status).toBe(404);
		const body = (await response.json()) as unknown;
		expect(body).toEqual({
			error: {
				code: "NOT_FOUND",
				message: "The requested resource was not found",
			},
		});
	});

	it("normalizes and hides nonstandard internal failures", async () => {
		const logs: string[] = [];
		const originalConsoleError = console.error;
		console.error = (...values: unknown[]) => logs.push(values.join(" "));
		try {
			for (const [path, status] of [
				["/v1/broken-response", 500],
				["/v1/standard-broken-response", 500],
				["/v1/standard-upstream-response", 503],
				["/v1/thrown", 500],
			] as const) {
				const response = await testApp().request(path);
				expect(response.status).toBe(status);
				const body = (await response.json()) as unknown;
				expect(body).toEqual({
					error: {
						code: "INTERNAL_ERROR",
						message: "An internal error occurred",
					},
				});
			}
		} finally {
			console.error = originalConsoleError;
		}
		expect(logs.join("\n")).not.toContain("database password leaked");
		expect(logs.join("\n")).not.toContain("private upstream diagnostics");
	});
});
