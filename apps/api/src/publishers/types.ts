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
	};
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

/**
 * Classify an error thrown during publishing into a structured PublishResult.
 * Errors with messages starting with "TOKEN_EXPIRED:", "RATE_LIMITED:", or
 * "PLATFORM_ERROR:" are classified with the corresponding code.
 * All other errors become PUBLISH_FAILED.
 */
export function classifyPublishError(err: unknown): PublishResult {
	const message = err instanceof Error ? err.message : "Unknown error";
	const prefixes = ["TOKEN_EXPIRED", "RATE_LIMITED", "PLATFORM_ERROR", "CONTENT_ERROR"] as const;
	for (const prefix of prefixes) {
		if (message.startsWith(`${prefix}:`)) {
			return {
				success: false,
				error: {
					code: prefix,
					message: message.slice(prefix.length + 2), // strip "PREFIX: "
				},
			};
		}
	}
	return {
		success: false,
		error: {
			code: "PUBLISH_FAILED",
			message,
		},
	};
}
