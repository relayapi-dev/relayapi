import type {
	Context,
	ErrorHandler,
	MiddlewareHandler,
	NotFoundHandler,
} from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env, Variables } from "../types";

type ApiContext = Context<{ Bindings: Env; Variables: Variables }>;
type ErrorDetails = Array<{
	code?: string;
	message: string;
	path?: Array<string | number>;
}>;

const statusDefaults: Record<number, { code: string; message: string }> = {
	400: { code: "BAD_REQUEST", message: "The request is invalid" },
	401: { code: "UNAUTHORIZED", message: "Authentication is required" },
	403: {
		code: "FORBIDDEN",
		message: "You do not have permission to perform this action",
	},
	404: { code: "NOT_FOUND", message: "The requested resource was not found" },
	405: {
		code: "METHOD_NOT_ALLOWED",
		message: "The request method is not allowed",
	},
	409: {
		code: "CONFLICT",
		message: "The request conflicts with the current resource state",
	},
	413: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large" },
	415: {
		code: "UNSUPPORTED_MEDIA_TYPE",
		message: "The request media type is not supported",
	},
	422: { code: "VALIDATION_ERROR", message: "Request validation failed" },
	429: { code: "RATE_LIMITED", message: "Too many requests" },
	500: { code: "INTERNAL_ERROR", message: "An internal error occurred" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStandardError(value: unknown): boolean {
	return (
		isRecord(value) &&
		isRecord(value.error) &&
		typeof value.error.code === "string" &&
		typeof value.error.message === "string"
	);
}

function validationDetails(value: unknown): ErrorDetails | undefined {
	if (!isRecord(value) || value.success !== false || !isRecord(value.error)) {
		return undefined;
	}
	let issues: unknown = value.error.issues;
	if (!Array.isArray(issues) && typeof value.error.message === "string") {
		try {
			issues = JSON.parse(value.error.message);
		} catch {
			return undefined;
		}
	}
	if (!Array.isArray(issues)) return undefined;
	const details = issues.flatMap((issue): ErrorDetails => {
		if (!isRecord(issue) || typeof issue.message !== "string") return [];
		const path = Array.isArray(issue.path)
			? issue.path.filter(
					(part): part is string | number =>
						typeof part === "string" || typeof part === "number",
				)
			: undefined;
		return [
			{
				message: issue.message,
				...(typeof issue.code === "string" ? { code: issue.code } : {}),
				...(path ? { path } : {}),
			},
		];
	});
	return details.length > 0 ? details : undefined;
}

function errorResponse(
	_c: ApiContext,
	status: number,
	code: string,
	message: string,
	details?: ErrorDetails,
	previous?: Response,
): Response {
	const headers = new Headers(previous?.headers);
	headers.set("Content-Type", "application/json; charset=UTF-8");
	headers.delete("Content-Length");
	return new Response(
		JSON.stringify({
			error: {
				code,
				message,
				...(details ? { details: { issues: details } } : {}),
			},
		}),
		{ status, headers },
	);
}

export const errorContractMiddleware: MiddlewareHandler<{
	Bindings: Env;
	Variables: Variables;
}> = async (c, next) => {
	await next();
	const response = c.res;
	if (response.status < 400) return;
	if (response.status >= 500) {
		c.res = errorResponse(
			c,
			response.status,
			"INTERNAL_ERROR",
			"An internal error occurred",
			undefined,
			response,
		);
		return;
	}

	const contentType = response.headers.get("content-type") ?? "";
	let parsed: unknown;
	let text = "";
	try {
		if (contentType.includes("json")) parsed = await response.clone().json();
		else text = await response.clone().text();
	} catch {
		// A broken error body is replaced with the stable public contract below.
	}
	if (isStandardError(parsed)) return;

	const details = validationDetails(parsed);
	if (details) {
		c.res = errorResponse(
			c,
			response.status,
			"VALIDATION_ERROR",
			"Request validation failed",
			details,
			response,
		);
		return;
	}

	const malformedJson = text === "Malformed JSON in request body";
	const malformedForm = text.startsWith("Malformed FormData request");
	const fallback = statusDefaults[response.status] ?? {
		code: "REQUEST_ERROR",
		message: "The request could not be completed",
	};
	c.res = errorResponse(
		c,
		response.status,
		malformedJson
			? "MALFORMED_JSON"
			: malformedForm
				? "MALFORMED_FORM"
				: fallback.code,
		malformedJson
			? "Malformed JSON in request body"
			: malformedForm
				? "Malformed form data in request body"
				: fallback.message,
		undefined,
		response,
	);
};

export const apiErrorHandler: ErrorHandler<{
	Bindings: Env;
	Variables: Variables;
}> = (error, c) => {
	if (error instanceof HTTPException && error.status < 500) {
		const fallback = statusDefaults[error.status] ?? {
			code: "REQUEST_ERROR",
			message: "The request could not be completed",
		};
		const malformedJson = error.message === "Malformed JSON in request body";
		return errorResponse(
			c,
			error.status,
			malformedJson ? "MALFORMED_JSON" : fallback.code,
			malformedJson ? error.message : fallback.message,
		);
	}
	console.error(
		JSON.stringify({
			message: "unhandled API error",
			error_type: error instanceof Error ? error.name : "unknown",
			path: new URL(c.req.url).pathname,
		}),
	);
	return errorResponse(c, 500, "INTERNAL_ERROR", "An internal error occurred");
};

export const apiNotFoundHandler: NotFoundHandler<{
	Bindings: Env;
	Variables: Variables;
}> = (c) =>
	errorResponse(c, 404, "NOT_FOUND", "The requested resource was not found");
