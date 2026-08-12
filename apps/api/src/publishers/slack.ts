import { fetchPublicUrl, readResponseBytes } from "../lib/fetch-public-url";
import { parseSlackWebhookUrl } from "../lib/slack-webhook";
import type { MediaAttachment } from "./types";
import {
	classifyPublishError,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
} from "./types";

const SLACK_TEXT_MAX_CHARS = 40_000;
const SLACK_BLOCKS_MAX = 50;
const SLACK_ATTACHMENTS_MAX = 100;
const SLACK_IMAGE_URL_MAX_CHARS = 3_000;
const SLACK_IMAGE_ALT_MAX_CHARS = 2_000;
const SLACK_SECTION_TEXT_MAX_CHARS = 3_000;
const SLACK_RESPONSE_MAX_BYTES = 8 * 1024;
// Relay defensive ceiling. Slack documents per-object/count limits but no
// stable incoming-webhook request-byte maximum; this prevents oversized JSON
// from consuming an isolate or being sent to an endpoint that cannot use it.
const SLACK_PAYLOAD_MAX_BYTES = 1024 * 1024;

function asObjectArray(
	value: unknown,
	field: "blocks" | "attachments",
	maxItems: number,
): Array<Record<string, unknown>> {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error(`CONTENT_ERROR: Slack ${field} must be an array.`);
	}
	if (value.length > maxItems) {
		throw new Error(
			`CONTENT_ERROR: Slack supports at most ${maxItems} ${field}; received ${value.length}.`,
		);
	}
	for (const [index, item] of value.entries()) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error(
				`CONTENT_ERROR: Slack ${field}[${index}] must be an object.`,
			);
		}
	}
	return value as Array<Record<string, unknown>>;
}

function slackMediaBlock(
	media: MediaAttachment,
	index: number,
): Record<string, unknown> {
	if (!media.type) {
		throw new Error(
			"CONTENT_ERROR: Slack media must have a normalized image, GIF, video, or document type.",
		);
	}
	if (media.type === "image" || media.type === "gif") {
		if (media.url.length > SLACK_IMAGE_URL_MAX_CHARS) {
			throw new Error(
				`CONTENT_ERROR: Slack image URLs support at most ${SLACK_IMAGE_URL_MAX_CHARS} characters.`,
			);
		}
		const altText =
			media.alt_text?.trim() ||
			`${media.type === "gif" ? "GIF" : "Image"} attachment ${index + 1}`;
		if (altText.length > SLACK_IMAGE_ALT_MAX_CHARS) {
			throw new Error(
				`CONTENT_ERROR: Slack image alt text supports at most ${SLACK_IMAGE_ALT_MAX_CHARS} characters.`,
			);
		}
		return {
			type: "image",
			image_url: media.url,
			alt_text: altText,
		};
	}

	const label =
		media.type === "video" ? "Video attachment" : "Document attachment";
	const safeUrl = media.url.replace(/\|/g, "%7C").replace(/>/g, "%3E");
	const text = `<${safeUrl}|${label} ${index + 1}>`;
	if (text.length > SLACK_SECTION_TEXT_MAX_CHARS) {
		throw new Error(
			`CONTENT_ERROR: Slack media links support at most ${SLACK_SECTION_TEXT_MAX_CHARS} characters.`,
		);
	}
	return {
		type: "section",
		text: { type: "mrkdwn", text },
	};
}

function slackErrorCode(detail: string): string {
	if (detail === "invalid_payload" || detail === "no_text") {
		return "CONTENT_ERROR";
	}
	if (
		[
			"invalid_token",
			"no_active_hooks",
			"no_service",
			"no_service_id",
			"no_team",
			"team_disabled",
		].includes(detail)
	) {
		return "ACCOUNT_RECONNECT_REQUIRED";
	}
	return "SLACK_REJECTED";
}

async function boundedSlackResponseText(response: Response): Promise<string> {
	const bytes = await readResponseBytes(response, SLACK_RESPONSE_MAX_BYTES);
	return new TextDecoder().decode(bytes).trim();
}

/**
 * Slack Incoming Webhooks:
 * https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
 * Sections "Use your incoming webhook URL to post a message", "Making it
 * fancy", "Posting your message as a reply in a thread", and "Handling errors".
 */
export const slackPublisher: Publisher = {
	platform: "slack",

	async publish(request: PublishRequest): Promise<PublishResult> {
		let crossedProviderBoundary = false;
		try {
			const opts = request.target_options;
			const content =
				(opts.content as string | undefined) ?? request.content ?? "";
			if (content.length > SLACK_TEXT_MAX_CHARS) {
				return {
					success: false,
					error: {
						code: "CONTENT_TOO_LONG",
						message: `Slack text is ${content.length} characters; RelayAPI's non-truncating limit is ${SLACK_TEXT_MAX_CHARS}.`,
					},
				};
			}

			const customBlocks = asObjectArray(
				opts.blocks,
				"blocks",
				SLACK_BLOCKS_MAX,
			);
			const attachments = asObjectArray(
				opts.attachments,
				"attachments",
				SLACK_ATTACHMENTS_MAX,
			);
			const media =
				(opts.media as MediaAttachment[] | undefined) ?? request.media;
			const mediaBlocks = media.map(slackMediaBlock);
			const blocks = [...customBlocks, ...mediaBlocks];
			if (blocks.length > SLACK_BLOCKS_MAX) {
				return {
					success: false,
					error: {
						code: "TOO_MANY_BLOCKS",
						message: `Slack messages support at most ${SLACK_BLOCKS_MAX} blocks including generated media blocks; received ${blocks.length}.`,
					},
				};
			}
			if (!content && blocks.length === 0 && attachments.length === 0) {
				return {
					success: false,
					error: {
						code: "EMPTY_POST",
						message: "Slack requires text, blocks, attachments, or media.",
					},
				};
			}

			const payload: Record<string, unknown> = {};
			if (content) payload.text = content;
			if (blocks.length > 0) payload.blocks = blocks;
			if (attachments.length > 0) payload.attachments = attachments;
			if (typeof opts.thread_ts === "string" && opts.thread_ts.trim()) {
				payload.thread_ts = opts.thread_ts.trim();
			}
			if (typeof opts.unfurl_links === "boolean") {
				payload.unfurl_links = opts.unfurl_links;
			}
			if (typeof opts.unfurl_media === "boolean") {
				payload.unfurl_media = opts.unfurl_media;
			}

			const payloadJson = JSON.stringify(payload);
			const payloadBytes = new TextEncoder().encode(payloadJson).byteLength;
			if (payloadBytes > SLACK_PAYLOAD_MAX_BYTES) {
				return {
					success: false,
					error: {
						code: "PAYLOAD_TOO_LARGE",
						message: `Slack payload is ${payloadBytes} bytes; RelayAPI allows at most ${SLACK_PAYLOAD_MAX_BYTES}.`,
					},
				};
			}

			const webhookUrl = parseSlackWebhookUrl(request.account.access_token).url;
			crossedProviderBoundary = true;
			const response = await fetchPublicUrl(webhookUrl, {
				method: "POST",
				redirect: "error",
				timeout: 30_000,
				timeoutThroughBody: true,
				headers: { "Content-Type": "application/json; charset=utf-8" },
				body: payloadJson,
			});
			const detail = await boundedSlackResponseText(response);

			if (response.status === 429) {
				const retryAfterSeconds = Number(response.headers.get("retry-after"));
				return {
					success: false,
					outcome: { disposition: "definitive_rejection" },
					retry: {
						disposition: "safe_to_retry",
						...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
							? { after_ms: Math.floor(retryAfterSeconds * 1000) }
							: {}),
					},
					error: {
						code: "RATE_LIMITED",
						message:
							"Slack rejected the webhook because its posting rate limit was exceeded.",
					},
				};
			}

			if (!response.ok) {
				if (response.status >= 400 && response.status < 500) {
					return {
						success: false,
						outcome: { disposition: "definitive_rejection" },
						error: {
							code: slackErrorCode(detail),
							message: `Slack rejected the incoming webhook: ${detail || `HTTP ${response.status}`}.`,
						},
					};
				}
				throw new PublishError(
					`Slack incoming webhook returned HTTP ${response.status}.`,
					{
						statusCode: response.status,
						detail: `HTTP ${response.status}\n${detail}`,
					},
				);
			}

			if (detail !== "ok") {
				return {
					success: false,
					provider_outcome: {
						disposition: "outcome_unknown",
						provider_state: detail || "empty_success_response",
					},
					error: {
						code: "PUBLISH_OUTCOME_UNKNOWN",
						message:
							"Slack returned HTTP 200 without its documented ok confirmation.",
					},
				};
			}

			return {
				success: true,
				provider_outcome: {
					disposition: "published",
					provider_state: "ok",
					resource_id_unavailable: true,
				},
			};
		} catch (error) {
			const result = classifyPublishError(error);
			if (!crossedProviderBoundary) return result;
			return {
				...result,
				provider_outcome: {
					disposition: "outcome_unknown",
					provider_state: "request_outcome_unavailable",
				},
			};
		}
	},
};
