import {
	ensureResponseContentLength,
	fetchPublicUrl,
} from "../lib/fetch-public-url";
import {
	createStreamingMultipartFilesBody,
	type StreamingMultipartFile,
} from "../lib/multipart-stream";
import {
	classifyPublishError,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
} from "./types";

// Official docs: https://docs.discord.com/developers/reference#uploading-files
// Section "Uploading Files" says the limit is per attachment, defaults to
// 10 MiB, and may be higher by user/server tier. Discord does not expose that
// tier through an incoming webhook, so this is only a defensive streaming cap;
// Discord remains authoritative for the actual per-attachment allowance.
const DISCORD_FILE_MAX_BYTES = 500 * 1024 * 1024;

/**
 * Discord publisher.
 * Uses Discord webhook URLs for posting. The webhook URL is stored as the access_token
 * on the social account (format: https://discord.com/api/webhooks/{id}/{token}).
 *
 * Discord webhooks don't require OAuth — the URL itself contains the auth token.
 * No separate authentication needed.
 */

interface DiscordEmbed {
	title?: string;
	description?: string;
	url?: string;
	color?: number;
	image?: { url: string };
	thumbnail?: { url: string };
	footer?: { text: string };
	author?: { name: string };
	fields?: Array<{ name: string; value: string }>;
	timestamp?: string;
}

function discordEmbedText(
	container: Record<string, unknown>,
	key: string,
	path: string,
	limit: number,
	required = false,
): string {
	const value = container[key];
	if (value === undefined && !required) return "";
	if (typeof value !== "string") {
		throw new Error(`CONTENT_ERROR: Discord embed ${path} must be a string.`);
	}
	if (value.length > limit) {
		throw new Error(
			`CONTENT_ERROR: Discord embed ${path} exceeds the ${limit}-character limit.`,
		);
	}
	return value;
}

/**
 * Validate and count every text-bearing embed field without trusting the
 * caller-supplied target_options shape.
 * Official docs: https://docs.discord.com/developers/resources/message#embed-limits
 * Section "Embed Limits" defines the per-field limits, at most 25 fields, and
 * a combined 6,000 characters across all embeds.
 */
export function getDiscordEmbedTextLength(embeds: unknown[]): number {
	let totalChars = 0;
	for (const [embedIndex, rawEmbed] of embeds.entries()) {
		if (!rawEmbed || typeof rawEmbed !== "object" || Array.isArray(rawEmbed)) {
			throw new Error(
				`CONTENT_ERROR: Discord embed ${embedIndex} must be an object.`,
			);
		}
		const embed = rawEmbed as Record<string, unknown>;
		totalChars += discordEmbedText(
			embed,
			"title",
			`${embedIndex}.title`,
			256,
		).length;
		totalChars += discordEmbedText(
			embed,
			"description",
			`${embedIndex}.description`,
			4096,
		).length;

		for (const [key, textKey, limit] of [
			["footer", "text", 2048],
			["author", "name", 256],
		] as const) {
			const nested = embed[key];
			if (nested !== undefined) {
				if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
					throw new Error(
						`CONTENT_ERROR: Discord embed ${embedIndex}.${key} must be an object.`,
					);
				}
				totalChars += discordEmbedText(
					nested as Record<string, unknown>,
					textKey,
					`${embedIndex}.${key}.${textKey}`,
					limit,
					true,
				).length;
			}
		}

		const fields = embed.fields;
		if (fields !== undefined) {
			if (!Array.isArray(fields)) {
				throw new Error(
					`CONTENT_ERROR: Discord embed ${embedIndex}.fields must be an array.`,
				);
			}
			if (fields.length > 25) {
				throw new Error(
					`CONTENT_ERROR: Discord embed ${embedIndex} exceeds the 25-field limit.`,
				);
			}
			for (const [fieldIndex, rawField] of fields.entries()) {
				if (
					!rawField ||
					typeof rawField !== "object" ||
					Array.isArray(rawField)
				) {
					throw new Error(
						`CONTENT_ERROR: Discord embed ${embedIndex}.fields.${fieldIndex} must be an object.`,
					);
				}
				const field = rawField as Record<string, unknown>;
				totalChars += discordEmbedText(
					field,
					"name",
					`${embedIndex}.fields.${fieldIndex}.name`,
					256,
					true,
				).length;
				totalChars += discordEmbedText(
					field,
					"value",
					`${embedIndex}.fields.${fieldIndex}.value`,
					1024,
					true,
				).length;
			}
		}
	}
	return totalChars;
}

export const discordPublisher: Publisher = {
	platform: "discord",

	async publish(request: PublishRequest): Promise<PublishResult> {
		const pendingFileResponses: Response[] = [];
		const cancelPendingFiles = async () => {
			await Promise.all(
				pendingFileResponses.map((response) =>
					response.body?.cancel().catch(() => {}),
				),
			);
			pendingFileResponses.length = 0;
		};
		try {
			const webhookUrl = request.account.access_token;
			if (!webhookUrl?.includes("discord.com/api/webhooks")) {
				throw new Error(
					"Invalid Discord webhook URL. Expected format: https://discord.com/api/webhooks/{id}/{token}",
				);
			}

			const opts = request.target_options;
			const content = (opts.content as string) ?? request.content ?? "";
			const username = opts.username as string | undefined;
			const avatarUrl = opts.avatar_url as string | undefined;

			// Build request body
			// Discord Webhook API: Execute Webhook
			// Docs: https://docs.discord.com/developers/resources/webhook#execute-webhook
			const body: Record<string, unknown> = {};

			if (content) {
				if (content.length > 2000) {
					return {
						success: false,
						error: {
							code: "CONTENT_TOO_LONG",
							message: `Content is ${content.length} characters. Discord limit is 2,000.`,
						},
					};
				}
				body.content = content;
			}

			if (username) {
				body.username = username;
			}
			if (avatarUrl) {
				body.avatar_url = avatarUrl;
			}

			// Handle media — prefer file uploads via multipart form-data for reliability
			// Discord Webhook API: Execute Webhook with file attachments
			// Docs: https://docs.discord.com/developers/resources/webhook#execute-webhook
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;

			const files: StreamingMultipartFile[] = [];
			const embeds: DiscordEmbed[] = [];

			if (media.length > 0) {
				if (media.length > 10) {
					// Official docs: https://docs.discord.com/developers/resources/webhook#execute-webhook
					// Section "Execute Webhook" permits at most 10 attachments.
					return {
						success: false,
						error: {
							code: "TOO_MANY_MEDIA",
							message: `Discord messages support at most 10 media items in this publisher; received ${media.length}.`,
						},
					};
				}
				for (const [i, item] of media.entries()) {
					const isVideo = item.type === "video";
					if (isVideo) {
						// Videos as link in content (Discord auto-embeds video URLs)
						const videoContent = `${body.content ?? ""}\n${item.url}`.trim();
						if (videoContent.length <= 2000) {
							body.content = videoContent;
						} else {
							// Same official Execute Webhook section: content is at most 2,000
							// characters. Never report success after dropping the video URL.
							await cancelPendingFiles();
							return {
								success: false,
								error: {
									code: "CONTENT_TOO_LONG",
									message:
										"Discord content plus attached video URLs exceeds the 2,000-character limit.",
								},
							};
						}
					} else {
						// Prepare a bounded response stream for one multipart attachment.
						try {
							const mediaUrl = item.url;
							let mediaRes = await fetchPublicUrl(mediaUrl, {
								timeout: 30_000,
								maxBytes: DISCORD_FILE_MAX_BYTES,
							});
							if (mediaRes.ok) {
								mediaRes = await ensureResponseContentLength(
									mediaRes,
									DISCORD_FILE_MAX_BYTES,
									() =>
										fetchPublicUrl(mediaUrl, {
											timeout: 30_000,
											maxBytes: DISCORD_FILE_MAX_BYTES,
										}),
								);
								const ext = item.url.split(".").pop()?.split("?")[0] ?? "png";
								files.push({
									fieldName: `files[${files.length}]`,
									filename: `image_${i}.${ext}`,
									contentType:
										mediaRes.headers.get("content-type") ??
										"application/octet-stream",
									response: mediaRes,
									maxBytes: DISCORD_FILE_MAX_BYTES,
									refetch: () =>
										fetchPublicUrl(mediaUrl, {
											timeout: 30_000,
											maxBytes: DISCORD_FILE_MAX_BYTES,
										}),
								});
								pendingFileResponses.push(mediaRes);
							} else {
								void mediaRes.body?.cancel().catch(() => {});
								throw new PublishError(
									`Discord attachment fetch failed (${mediaRes.status})`,
									{
										statusCode: mediaRes.status,
										detail: `HTTP ${mediaRes.status} ${mediaRes.statusText}`,
									},
								);
							}
						} catch (error) {
							throw error instanceof Error
								? error
								: new Error("Discord attachment fetch failed");
						}
					}
				}
			}

			if (embeds.length > 0) {
				body.embeds = embeds;
			}

			// Custom embeds from target_options — merge with media embeds
			if (opts.embeds) {
				const existing = (body.embeds as unknown[]) ?? [];
				const combined = [...existing, ...(opts.embeds as unknown[])];
				// Official Execute Webhook field `embeds`: array of up to 10 embeds.
				if (combined.length > 10) {
					await cancelPendingFiles();
					return {
						success: false,
						error: {
							code: "TOO_MANY_EMBEDS",
							message: `Discord supports at most 10 embeds; received ${combined.length}.`,
						},
					};
				}
				body.embeds = combined;
			}

			// Discord embed total character limit: 6,000 across all embeds
			// Docs: https://docs.discord.com/developers/resources/message#embed-object-embed-limits
			if (body.embeds) {
				const totalChars = getDiscordEmbedTextLength(body.embeds as unknown[]);
				if (totalChars > 6000) {
					await cancelPendingFiles();
					return {
						success: false,
						error: {
							code: "CONTENT_TOO_LONG",
							message: `Total embed text is ${totalChars} characters. Discord limit is 6,000.`,
						},
					};
				}
			}

			// Must have at least one of content, embeds, or files
			if (!body.content && !body.embeds && files.length === 0) {
				throw new Error(
					"Discord requires at least content, embeds, or files in the message.",
				);
			}

			// Send request — use multipart if files are present, JSON otherwise
			let res: Response;
			if (files.length > 0) {
				const multipart = await createStreamingMultipartFilesBody(
					[["payload_json", JSON.stringify(body)]],
					files,
				);
				pendingFileResponses.length = 0;
				const [responseOutcome, completionOutcome] = await Promise.allSettled([
					fetch(`${webhookUrl}?wait=true`, {
						method: "POST",
						headers: {
							"Content-Type": multipart.contentType,
							"Content-Length": multipart.contentLength.toString(),
						},
						body: multipart.body,
					}),
					multipart.completion,
				]);
				if (responseOutcome.status === "rejected") {
					throw completionOutcome.status === "rejected"
						? completionOutcome.reason
						: responseOutcome.reason;
				}
				res = responseOutcome.value;
				if (res.ok && completionOutcome.status === "rejected") {
					throw completionOutcome.reason;
				}
			} else {
				// Discord Webhook API: Execute Webhook
				// Docs: https://docs.discord.com/developers/resources/webhook#execute-webhook
				res = await fetch(`${webhookUrl}?wait=true`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
			}

			if (res.status === 429) {
				const retryAfter = res.headers.get("retry-after");
				const retryAfterSeconds = retryAfter
					? Number.parseFloat(retryAfter)
					: Number.NaN;
				throw new PublishError(
					`RATE_LIMITED: Discord rate limit exceeded. Retry after ${retryAfter ?? "unknown"} seconds.`,
					{
						statusCode: res.status,
						detail: `HTTP ${res.status} ${res.statusText}`,
						retryAfterMs:
							Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
								? retryAfterSeconds * 1000
								: undefined,
					},
				);
			}

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				const detail = (err as { message?: string }).message ?? res.statusText;
				const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
				throw new PublishError(`Discord webhook failed: ${detail}`, {
					statusCode: res.status,
					detail: raw,
				});
			}

			const result = (await res.json()) as {
				id?: string;
				channel_id?: string;
			};
			if (!result.id?.trim()) {
				throw new Error(
					"Discord returned a successful webhook response without a message ID.",
				);
			}

			// Try to get guild_id from the webhook info to build a jump URL
			// The unauthenticated endpoint requires both webhook ID and token in the URL
			let platformUrl: string | undefined;
			try {
				const webhookParts = webhookUrl.split("/webhooks/")[1]?.split("/");
				const webhookId = webhookParts?.[0];
				const webhookToken = webhookParts?.[1];
				if (webhookId && webhookToken) {
					const webhookInfo = await fetch(
						`https://discord.com/api/webhooks/${webhookId}/${webhookToken}`,
						{ headers: { "Content-Type": "application/json" } },
					);
					if (webhookInfo.ok) {
						const info = (await webhookInfo.json()) as { guild_id?: string };
						if (info.guild_id) {
							if (result.channel_id) {
								platformUrl = `https://discord.com/channels/${info.guild_id}/${result.channel_id}/${result.id}`;
							}
						}
					}
				}
			} catch {
				// Non-fatal — platform_url is optional
			}

			return {
				success: true,
				platform_post_id: result.id,
				platform_url: platformUrl,
				provider_outcome: {
					disposition: "published",
					platform_post_id: result.id,
					platform_url: platformUrl,
					provider_state: "created",
				},
			};
		} catch (err) {
			await cancelPendingFiles();
			return classifyPublishError(err, { safeToRetryRateLimit: true });
		}
	},
};
