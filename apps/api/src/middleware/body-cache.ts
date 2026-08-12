import { createMiddleware } from "hono/factory";
import {
	materializeBoundedRequestBody,
	seedBoundedRequestBody,
	seedBoundedRequestFormData,
} from "../lib/bounded-request-body";
import { ResponseTooLargeError } from "../lib/fetch-public-url";
import type { Env, Variables } from "../types";

export const MAX_AUTHENTICATED_JSON_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_BULK_CSV_MULTIPART_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_IDEA_MEDIA_MULTIPART_BODY_BYTES = 3 * 1024 * 1024;

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isJsonContentType(contentType: string | undefined): boolean {
	if (!contentType) return false;
	const mimeType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
	return mimeType === "application/json" || mimeType.endsWith("+json");
}

function isMultipartContentType(contentType: string | undefined): boolean {
	if (!contentType) return false;
	const mimeType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
	return mimeType === "multipart/form-data";
}

function hasUnsupportedContentEncoding(value: string | undefined): boolean {
	if (!value) return false;
	return value
		.split(",")
		.map((encoding) => encoding.trim().toLowerCase())
		.filter(Boolean)
		.some((encoding) => encoding !== "identity");
}

function multipartBodyLimit(
	method: string,
	path: string,
	contentType: string | undefined,
): number | null {
	if (method !== "POST" || !isMultipartContentType(contentType)) return null;
	if (/^\/v1\/posts\/bulk-csv\/?$/.test(path)) {
		return MAX_BULK_CSV_MULTIPART_BODY_BYTES;
	}
	if (/^\/v1\/ideas\/[^/]+\/media\/?$/.test(path)) {
		return MAX_IDEA_MEDIA_MULTIPART_BODY_BYTES;
	}
	return null;
}

function parsedObject(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * Bounds authenticated bodies that are intentionally materialized in the
 * Worker, then seeds Hono's byte cache so validation, workspace enforcement,
 * usage accounting, and idempotency all replay the exact same source bytes.
 * Raw media and signed public webhooks deliberately bypass this middleware.
 */
export const bodyCacheMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const contentType = c.req.header("content-type");
	const jsonBody =
		BODY_METHODS.has(c.req.method) && isJsonContentType(contentType);
	const multipartLimit = multipartBodyLimit(
		c.req.method,
		c.req.path,
		contentType,
	);
	const bodyLimit = jsonBody
		? MAX_AUTHENTICATED_JSON_BODY_BYTES
		: multipartLimit;

	c.set("parsedBody", null);
	if (bodyLimit !== null) {
		// Some clients (including the bundled n8n node) retain a JSON content
		// type on bodyless DELETE requests. An absent body is not malformed JSON;
		// leave parsedBody null and let the route decide whether a body is required.
		if (c.req.raw.body === null) {
			await next();
			return;
		}
		if (hasUnsupportedContentEncoding(c.req.header("content-encoding"))) {
			void c.req.raw.body?.cancel().catch(() => {});
			return c.json(
				{
					error: {
						code: "UNSUPPORTED_CONTENT_ENCODING",
						message: "Compressed request bodies are not supported.",
					},
				},
				415,
			);
		}

		try {
			const bytes = await materializeBoundedRequestBody(c.req.raw, bodyLimit);
			seedBoundedRequestBody(c.req, bytes);
			if (jsonBody) {
				c.set("parsedBody", parsedObject(await c.req.json<unknown>()));
			} else {
				const formData = await new Response(bytes, {
					headers: c.req.raw.headers,
				}).formData();
				seedBoundedRequestFormData(c.req, formData);
			}
		} catch (error) {
			if (error instanceof ResponseTooLargeError) {
				const limitMiB = bodyLimit / (1024 * 1024);
				return c.json(
					{
						error: {
							code: "PAYLOAD_TOO_LARGE",
							message: `Request body exceeds the ${limitMiB} MiB limit.`,
						},
					},
					413,
				);
			}
			if (!jsonBody) {
				return c.text("Malformed FormData request body", 400);
			}
			// Reject before idempotency/usage middleware can reserve anything. The
			// outer error-contract middleware preserves the established public code.
			return c.text("Malformed JSON in request body", 400);
		}
	}
	await next();
});
