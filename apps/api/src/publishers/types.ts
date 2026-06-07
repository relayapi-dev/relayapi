import type { Platform } from "../schemas/common";

export interface MediaAttachment {
	url: string;
	type?: "image" | "video" | "gif" | "document";
	alt_text?: string;
}

export interface PublishRequest {
	content: string | null;
	media: MediaAttachment[];
	target_options: Record<string, unknown>;
	account: {
		id: string;
		platform: Platform;
		access_token: string;
		refresh_token: string | null;
		platform_account_id: string;
		username: string | null;
		metadata?: Record<string, unknown> | null;
	};
}

/**
 * Well-known error codes that the publisher runner uses for retry/refresh decisions.
 * Publishers should use these codes when returning errors:
 *
 * - TOKEN_EXPIRED: Access token is invalid/expired. Runner will refresh and retry.
 * - RATE_LIMITED: Platform rate limit hit. Runner will retry with backoff.
 * - CONTENT_ERROR: Bad content (too long, invalid format, policy violation). No retry.
 * - PLATFORM_ERROR: Transient platform error (5xx, timeout). Runner may retry.
 * - PUBLISH_FAILED: Generic/unknown failure. No automatic retry.
 *
 * Any other code string is treated as a non-retryable error.
 */
export type PublishErrorCode =
	| "TOKEN_EXPIRED"
	| "RATE_LIMITED"
	| "CONTENT_ERROR"
	| "PLATFORM_ERROR"
	| "PUBLISH_FAILED"
	| string;

export interface PublishResult {
	success: boolean;
	platform_post_id?: string;
	platform_url?: string;
	error?: {
		code: PublishErrorCode;
		message: string;
		/** Raw failure context (HTTP status + platform response), sanitized + truncated. */
		detail?: string;
	};
}

/**
 * Error thrown by publishers that carries structured failure context — the HTTP
 * status and raw platform response body — through to `classifyPublishError`, which
 * persists it as the post target's error detail. Throwing a plain `Error` remains
 * fully supported (message-only, prefix-classified) so publishers can adopt this
 * incrementally.
 */
export class PublishError extends Error {
	code?: PublishErrorCode;
	statusCode?: number;
	/** Raw failure context, e.g. `"HTTP 400\n{...platform json...}"`. Sanitized before storage. */
	detail?: string;
	constructor(
		message: string,
		opts?: { code?: PublishErrorCode; statusCode?: number; detail?: string },
	) {
		super(message);
		this.name = "PublishError";
		this.code = opts?.code;
		this.statusCode = opts?.statusCode;
		this.detail = opts?.detail;
	}
}

export interface EngagementAccount {
	access_token: string;
	refresh_token: string | null;
	platform_account_id: string;
	username: string | null;
}

export interface EngagementActionResult {
	success: boolean;
	platform_post_id?: string;
	error?: { code: PublishErrorCode; message: string };
}

export interface Publisher {
	platform: Platform;
	publish(request: PublishRequest): Promise<PublishResult>;
	repost?(account: EngagementAccount, platformPostId: string): Promise<EngagementActionResult>;
	comment?(account: EngagementAccount, platformPostId: string, text: string): Promise<EngagementActionResult>;
	quote?(account: EngagementAccount, platformPostId: string, text: string): Promise<EngagementActionResult>;
}

const MAX_DETAIL_LENGTH = 4096;

// Mask secret-bearing fields (query-string or JSON style) so raw platform error
// detail never leaks a token. `code` is intentionally NOT redacted — platforms use
// it for numeric error codes that are useful to surface.
const SENSITIVE_KEY_PATTERN =
	/("?\b(?:access_token|refresh_token|client_secret|password|api[_-]?key|secret|token)\b"?\s*[:=]\s*"?)([^"'&\s,}\]]+)/gi;

/**
 * Redact secrets and bound the size of raw error detail before it is persisted and
 * exposed via the public API. Runs server-side so every platform is protected at a
 * single chokepoint, regardless of which publisher produced the detail.
 */
export function sanitizeErrorDetail(detail: string): string {
	let out = detail.replace(SENSITIVE_KEY_PATTERN, "$1[REDACTED]");
	out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
	if (out.length > MAX_DETAIL_LENGTH) {
		out = `${out.slice(0, MAX_DETAIL_LENGTH)}… [truncated]`;
	}
	return out;
}

/**
 * Classify an error thrown during publishing into a structured PublishResult.
 * Message-prefix parsing is preserved for both plain `Error` and `PublishError`:
 * messages starting with "TOKEN_EXPIRED:", "RATE_LIMITED:", "PLATFORM_ERROR:", or
 * "CONTENT_ERROR:" are classified with the corresponding code; otherwise the code
 * falls back to a `PublishError`'s explicit `code` or "PUBLISH_FAILED". A
 * `PublishError`'s raw `detail` (sanitized + truncated) is attached when present.
 */
export function classifyPublishError(err: unknown): PublishResult {
	const message = err instanceof Error ? err.message : "Unknown error";
	const detail =
		err instanceof PublishError && err.detail ? sanitizeErrorDetail(err.detail) : undefined;
	const detailField = detail ? { detail } : {};

	const prefixes = ["TOKEN_EXPIRED", "RATE_LIMITED", "PLATFORM_ERROR", "CONTENT_ERROR"] as const;
	for (const prefix of prefixes) {
		if (message.startsWith(`${prefix}:`)) {
			return {
				success: false,
				error: {
					code: prefix,
					message: message.slice(prefix.length + 2), // strip "PREFIX: "
					...detailField,
				},
			};
		}
	}
	return {
		success: false,
		error: {
			code: (err instanceof PublishError && err.code) || "PUBLISH_FAILED",
			message,
			...detailField,
		},
	};
}
