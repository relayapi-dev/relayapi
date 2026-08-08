import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
	materializeBoundedRequestBody,
	preflightBoundedRequestBody,
	seedBoundedRequestBody,
} from "../../lib/bounded-request-body";
import { ResponseTooLargeError } from "../../lib/fetch-public-url";
import inviteRedeemRouter, {
	INVITE_REDEEM_MAX_BODY_BYTES,
} from "../../routes/invite-redeem";
import publicGrowthRouter, {
	LANDING_CONVERSION_MAX_BODY_BYTES,
	parseConversionRequest,
} from "../../routes/public-growth";
import type { Env } from "../../types";

const conversionUrl =
	"https://worker.test/l/org_test/org/o/lp_test/page/conversions";

function limiterEnv(success: boolean) {
	return {
		FREE_RATE_LIMITER: {
			limit: async () => ({ success }),
		},
	};
}

function jsonErrorCode(responseBody: unknown): string | undefined {
	if (!responseBody || typeof responseBody !== "object") return undefined;
	const error = Reflect.get(responseBody, "error");
	if (!error || typeof error !== "object") return undefined;
	const code = Reflect.get(error, "code");
	return typeof code === "string" ? code : undefined;
}

describe("bounded pre-auth request bodies in workerd", () => {
	it("runs the invite IP limiter before media-type and body checks", async () => {
		const response = await inviteRedeemRouter.fetch(
			new Request("https://worker.test/redeem", {
				method: "POST",
				headers: { "Content-Type": "text/plain" },
				body: "not json",
			}),
			limiterEnv(false) as never,
		);

		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("60");
		expect(jsonErrorCode(await response.json())).toBe("RATE_LIMITED");
	});

	it("rejects declared invite overflow and unsupported media before auth", async () => {
		const oversized = await inviteRedeemRouter.fetch(
			new Request("https://worker.test/redeem", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(INVITE_REDEEM_MAX_BODY_BYTES + 1),
				},
				body: "{}",
			}),
			limiterEnv(true) as never,
		);
		expect(oversized.status).toBe(413);
		expect(jsonErrorCode(await oversized.json())).toBe("PAYLOAD_TOO_LARGE");

		const unsupported = await inviteRedeemRouter.fetch(
			new Request("https://worker.test/redeem", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: "token=x",
			}),
			limiterEnv(true) as never,
		);
		expect(unsupported.status).toBe(415);
		expect(jsonErrorCode(await unsupported.json())).toBe(
			"UNSUPPORTED_MEDIA_TYPE",
		);
	});

	it("returns 401 without consuming unknown or understated unauthenticated bodies", async () => {
		for (const headers of [
			new Headers({ "Content-Type": "application/json" }),
			new Headers({
				"Content-Type": "application/json",
				"Content-Length": "1",
			}),
		]) {
			const request = new Request("https://worker.test/redeem", {
				method: "POST",
				headers,
				body: new Uint8Array(INVITE_REDEEM_MAX_BODY_BYTES + 1),
			});
			expect(request.bodyUsed).toBe(false);

			const response = await inviteRedeemRouter.fetch(
				request,
				limiterEnv(true) as never,
			);
			expect(response.status).toBe(401);
			expect(request.bodyUsed).toBe(false);
			expect(jsonErrorCode(await response.json())).toBe("UNAUTHORIZED");
		}
	});

	it("enforces streamed limits for dishonest and encoded lengths and cancels overflow", async () => {
		for (const headers of [
			new Headers({
				"Content-Type": "application/json",
				"Content-Length": "0",
			}),
			new Headers({
				"Content-Type": "application/json",
				"Content-Length": "invalid",
			}),
			new Headers({
				"Content-Type": "application/json",
				"Content-Length": "1",
				"Content-Encoding": "gzip",
			}),
		]) {
			let step = 0;
			let cancelled = false;
			const request = new Request("https://worker.test/bounded", {
				method: "POST",
				headers,
				body: new ReadableStream<Uint8Array>({
					pull(controller) {
						if (step++ === 0) {
							controller.enqueue(new Uint8Array(INVITE_REDEEM_MAX_BODY_BYTES));
						} else {
							controller.enqueue(new Uint8Array(1));
						}
					},
					cancel() {
						cancelled = true;
					},
				}),
			});
			preflightBoundedRequestBody(request, INVITE_REDEEM_MAX_BODY_BYTES, [
				"application/json",
			]);
			await expect(
				materializeBoundedRequestBody(request, INVITE_REDEEM_MAX_BODY_BYTES),
			).rejects.toBeInstanceOf(ResponseTooLargeError);
			expect(cancelled).toBe(true);
		}
	});

	it("keeps concurrent Hono body caches isolated while preserving raw requests", async () => {
		const cacheApp = new Hono();
		cacheApp.post("/", async (c) => {
			const raw = c.req.raw;
			preflightBoundedRequestBody(raw, 100, ["application/json"]);
			const bytes = await materializeBoundedRequestBody(raw, 100);
			seedBoundedRequestBody(c.req, bytes);
			await Promise.resolve();
			const parsed = await c.req.json<{ id: string }>();
			return c.json({ id: parsed.id, rawPreserved: raw === c.req.raw });
		});

		const [first, second] = await Promise.all([
			cacheApp.request("https://worker.test/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: "first" }),
			}),
			cacheApp.request("https://worker.test/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: "second" }),
			}),
		]);

		expect(await first.json()).toEqual({ id: "first", rawPreserved: true });
		expect(await second.json()).toEqual({ id: "second", rawPreserved: true });
	});
});

describe("public landing conversion body containment in workerd", () => {
	it("preserves bounded JSON, urlencoded, and multipart text compatibility", async () => {
		const parser = new Hono<{ Bindings: Env }>();
		parser.post("/", async (c) => {
			const outcome = await parseConversionRequest(c);
			if (!outcome.ok) return outcome.response;
			if (!outcome.parsed.success) return c.json({ valid: false }, 400);
			return c.json(outcome.parsed.data);
		});

		const json = await parser.request("https://worker.test/", {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify({
				idempotency_key: "json-one",
				fields: { name: "JSON Person" },
			}),
		});
		expect(json.status).toBe(200);
		expect(await json.json()).toEqual({
			idempotency_key: "json-one",
			fields: { name: "JSON Person" },
		});

		const urlencoded = await parser.request("https://worker.test/", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				idempotency_key: "form-one",
				name: "Form Person",
			}).toString(),
		});
		expect(urlencoded.status).toBe(200);
		expect(await urlencoded.json()).toEqual({
			idempotency_key: "form-one",
			fields: { name: "Form Person" },
		});

		const multipartBody = new FormData();
		multipartBody.set("idempotency_key", "multipart-one");
		multipartBody.set("name", "Multipart Person");
		const multipart = await parser.request("https://worker.test/", {
			method: "POST",
			body: multipartBody,
		});
		expect(multipart.status).toBe(200);
		expect(await multipart.json()).toEqual({
			idempotency_key: "multipart-one",
			fields: { name: "Multipart Person" },
		});
	});

	it("keeps the existing IP limiter ahead of containment", async () => {
		const response = await publicGrowthRouter.fetch(
			new Request(conversionUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(LANDING_CONVERSION_MAX_BODY_BYTES + 1),
				},
				body: "{}",
			}),
			limiterEnv(false) as never,
		);
		expect(response.status).toBe(429);
		expect(jsonErrorCode(await response.json())).toBe("RATE_LIMITED");
	});

	it("returns stable 413 and 415 errors before database resolution", async () => {
		const oversized = await publicGrowthRouter.fetch(
			new Request(conversionUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(LANDING_CONVERSION_MAX_BODY_BYTES + 1),
				},
				body: "{}",
			}),
			limiterEnv(true) as never,
		);
		expect(oversized.status).toBe(413);
		expect(jsonErrorCode(await oversized.json())).toBe("PAYLOAD_TOO_LARGE");

		const unsupported = await publicGrowthRouter.fetch(
			new Request(conversionUrl, {
				method: "POST",
				headers: { "Content-Type": "text/plain" },
				body: "idempotency_key=x",
			}),
			limiterEnv(true) as never,
		);
		expect(unsupported.status).toBe(415);
		expect(jsonErrorCode(await unsupported.json())).toBe(
			"UNSUPPORTED_MEDIA_TYPE",
		);
	});

	it("rejects an unknown-length streamed conversion above 16 KiB", async () => {
		const response = await publicGrowthRouter.fetch(
			new Request(conversionUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							new Uint8Array(LANDING_CONVERSION_MAX_BODY_BYTES),
						);
						controller.enqueue(new Uint8Array(1));
						controller.close();
					},
				}),
			}),
			limiterEnv(true) as never,
		);
		expect(response.status).toBe(413);
		expect(jsonErrorCode(await response.json())).toBe("PAYLOAD_TOO_LARGE");
	});

	it("rejects duplicate, unknown, and File form fields after bounded parsing", async () => {
		for (const body of [
			"idempotency_key=one&idempotency_key=two",
			"idempotency_key=one&unexpected=value",
		]) {
			const response = await publicGrowthRouter.fetch(
				new Request(conversionUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body,
				}),
				limiterEnv(true) as never,
			);
			expect(response.status).toBe(400);
		}

		const multipart = new FormData();
		multipart.set("idempotency_key", "one");
		multipart.set("name", new File(["file"], "name.txt"));
		const fileResponse = await publicGrowthRouter.fetch(
			new Request(conversionUrl, { method: "POST", body: multipart }),
			limiterEnv(true) as never,
		);
		expect(fileResponse.status).toBe(400);
	});
});
