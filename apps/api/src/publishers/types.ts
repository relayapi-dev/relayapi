import type { Platform } from "../schemas/common";

export interface MediaAttachment {
	url: string;
	type?: "image" | "video" | "gif" | "document";
	alt_text?: string;
}

export interface PublishRequest {
	/**
	 * Stable application operation id. A publisher forwards it only when the
	 * provider exposes an idempotency control for the relevant mutation.
	 */
	operation_id: string;
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
	/** The provider explicitly rejected the request before a visible effect. */
	outcome?: { disposition: "definitive_rejection" };
	/**
	 * Internal retry directive. Publishers may set this only when the provider
	 * explicitly rejected the mutating request and the complete publish operation
	 * has not produced an externally visible effect.
	 */
	retry?: {
		disposition: "safe_to_retry";
		after_ms?: number;
	};
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
	retryAfterMs?: number;
	/** Raw failure context, e.g. `"HTTP 400\n{...platform json...}"`. Sanitized before storage. */
	detail?: string;
	constructor(
		message: string,
		opts?: {
			code?: PublishErrorCode;
			statusCode?: number;
			detail?: string;
			retryAfterMs?: number;
		},
	) {
		super(message);
		this.name = "PublishError";
		this.code = opts?.code;
		this.statusCode = opts?.statusCode;
		this.detail = opts?.detail;
		this.retryAfterMs = opts?.retryAfterMs;
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
	repost?(
		account: EngagementAccount,
		platformPostId: string,
	): Promise<EngagementActionResult>;
	comment?(
		account: EngagementAccount,
		platformPostId: string,
		text: string,
	): Promise<EngagementActionResult>;
	quote?(
		account: EngagementAccount,
		platformPostId: string,
		text: string,
	): Promise<EngagementActionResult>;
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
export function classifyPublishError(
	err: unknown,
	options: {
		safeToRetryRateLimit?: boolean;
		definitiveHttpRejection?: boolean;
	} = {},
): PublishResult {
	const message = err instanceof Error ? err.message : "Unknown error";
	const detail =
		err instanceof PublishError && err.detail
			? sanitizeErrorDetail(err.detail)
			: undefined;
	const detailField = detail ? { detail } : {};
	const structuredHttpRejection =
		err instanceof PublishError &&
		typeof err.statusCode === "number" &&
		err.statusCode >= 400 &&
		err.statusCode < 500 &&
		err.statusCode !== 408;
	// Outcome classification and rate-limit retry permission are deliberately
	// separate. A caller opting into a safe 429 replay must not cause every other
	// 4xx from a multi-step publish to be labelled a definitive rejection.
	const outcome =
		structuredHttpRejection && options.definitiveHttpRejection === true
			? ({ disposition: "definitive_rejection" } as const)
			: undefined;

	const prefixes = [
		"TOKEN_EXPIRED",
		"RATE_LIMITED",
		"PLATFORM_ERROR",
		"CONTENT_ERROR",
	] as const;
	for (const prefix of prefixes) {
		if (message.startsWith(`${prefix}:`)) {
			const retry =
				prefix === "RATE_LIMITED" &&
				options.safeToRetryRateLimit === true &&
				structuredHttpRejection
					? {
							disposition: "safe_to_retry" as const,
							...(typeof err.retryAfterMs === "number" &&
							Number.isFinite(err.retryAfterMs) &&
							err.retryAfterMs >= 0
								? { after_ms: Math.floor(err.retryAfterMs) }
								: {}),
						}
					: undefined;
			return {
				success: false,
				...(outcome ? { outcome } : {}),
				...(retry ? { retry } : {}),
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
		...(outcome ? { outcome } : {}),
		error: {
			code: (err instanceof PublishError && err.code) || "PUBLISH_FAILED",
			message,
			...detailField,
		},
	};
}
