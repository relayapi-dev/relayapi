import type { HonoRequest } from "hono/request";
import {
	parseContentLength,
	ResponseTooLargeError,
	readRequestBytes,
} from "./fetch-public-url";

export type RequestBodyMediaType =
	| "application/json"
	| "application/x-www-form-urlencoded"
	| "multipart/form-data";

export class UnsupportedRequestMediaTypeError extends Error {
	constructor() {
		super("The request media type is not supported");
		this.name = "UnsupportedRequestMediaTypeError";
	}
}

function requestMediaType(request: Request): string | null {
	const contentType = request.headers.get("content-type");
	if (!contentType) return null;
	const mediaType = (contentType.split(";", 1)[0] ?? "").trim().toLowerCase();
	return mediaType || null;
}

/**
 * Reject unsupported or declared-oversize bodies without consuming their
 * streams. A missing, malformed, compressed, zero, or dishonest length remains
 * subject to the streamed limit in materializeBoundedRequestBody().
 */
export function preflightBoundedRequestBody(
	request: Request,
	maxBytes: number,
	allowedMediaTypes: readonly RequestBodyMediaType[],
): RequestBodyMediaType {
	const mediaType = requestMediaType(request);
	if (
		!mediaType ||
		!allowedMediaTypes.includes(mediaType as RequestBodyMediaType)
	) {
		throw new UnsupportedRequestMediaTypeError();
	}

	const declaredBytes = parseContentLength(request.headers);
	if (declaredBytes !== null && declaredBytes > maxBytes) {
		void request.body?.cancel().catch(() => {});
		throw new ResponseTooLargeError(maxBytes, declaredBytes);
	}
	return mediaType as RequestBodyMediaType;
}

/** Buffer a deliberately small route body with both declared and streamed caps. */
export function materializeBoundedRequestBody(
	request: Request,
	maxBytes: number,
): Promise<ArrayBuffer> {
	return readRequestBytes(request, maxBytes);
}

/**
 * Seed Hono's replay cache without replacing the raw Request. Hono's runtime
 * cache stores promises even though its public declaration currently exposes
 * the resolved body types.
 */
export function seedBoundedRequestBody(
	request: Pick<HonoRequest, "bodyCache">,
	bytes: ArrayBuffer,
): void {
	Object.assign(request.bodyCache, {
		arrayBuffer: Promise.resolve(bytes),
	});
}

/** Preserve parsed multipart compatibility while keeping arrayBuffer first. */
export function seedBoundedRequestFormData(
	request: Pick<HonoRequest, "bodyCache">,
	formData: FormData,
): void {
	Object.assign(request.bodyCache, {
		formData: Promise.resolve(formData),
	});
}
