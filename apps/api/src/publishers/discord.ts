import {
	DISCORD_THREAD_CONTEXT_EFFECT,
	isDiscordSnowflake,
} from "../lib/discord-message-context";
import { parseDiscordWebhookUrl } from "../lib/discord-webhook";
import {
	ensureResponseContentLength,
	fetchPublicUrl,
	readResponseJson,
} from "../lib/fetch-public-url";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import {
	createStreamingMultipartFilesBody,
	type StreamingMultipartFile,
} from "../lib/multipart-stream";
import { DiscordTargetOptions } from "../schemas/publisher-options";
import {
	classifyPublishError,
	mergeProviderEffects,
	type ProviderEffect,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
	recordProviderEffect,
} from "./types";

// Official docs: https://docs.discord.com/developers/reference#uploading-files
// Section "Uploading Files" says the limit is per attachment, defaults to
// 10 MiB, and may be higher by user/server tier. Discord does not expose that
// tier through an incoming webhook, so Relay must enforce the documented default
// rather than download hundreds of megabytes that the webhook will reject.
const DISCORD_FILE_MAX_BYTES = 10 * 1024 * 1024;
const DISCORD_RESPONSE_MAX_BYTES = 256 * 1024;

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

function normalizeDiscordPoll(
	value: unknown,
): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("CONTENT_ERROR: Discord poll must be an object.");
	}
	const poll = value as Record<string, unknown>;
	const rawQuestion = poll.question;
	if (
		!rawQuestion ||
		typeof rawQuestion !== "object" ||
		Array.isArray(rawQuestion) ||
		typeof (rawQuestion as Record<string, unknown>).text !== "string" ||
		((rawQuestion as Record<string, unknown>).text as string).length < 1 ||
		((rawQuestion as Record<string, unknown>).text as string).length > 300
	) {
		throw new Error(
			"CONTENT_ERROR: Discord poll question.text must be 1-300 characters.",
		);
	}
	if (
		!Array.isArray(poll.answers) ||
		poll.answers.length < 2 ||
		poll.answers.length > 10
	) {
		throw new Error("CONTENT_ERROR: Discord polls require 2-10 answers.");
	}
	const answers = poll.answers.map((rawAnswer, index) => {
		if (
			!rawAnswer ||
			typeof rawAnswer !== "object" ||
			Array.isArray(rawAnswer)
		) {
			throw new Error(
				`CONTENT_ERROR: Discord poll answer ${index + 1} must be an object.`,
			);
		}
		const rawMedia = (rawAnswer as Record<string, unknown>).poll_media;
		if (!rawMedia || typeof rawMedia !== "object" || Array.isArray(rawMedia)) {
			throw new Error(
				`CONTENT_ERROR: Discord poll answer ${index + 1}.poll_media must be an object.`,
			);
		}
		const media = rawMedia as Record<string, unknown>;
		if (
			typeof media.text !== "string" ||
			media.text.length < 1 ||
			media.text.length > 55
		) {
			throw new Error(
				`CONTENT_ERROR: Discord poll answer ${index + 1} text must be 1-55 characters.`,
			);
		}
		const normalizedMedia: Record<string, unknown> = { text: media.text };
		if (media.emoji !== undefined) {
			if (
				!media.emoji ||
				typeof media.emoji !== "object" ||
				Array.isArray(media.emoji)
			) {
				throw new Error(
					`CONTENT_ERROR: Discord poll answer ${index + 1} emoji must be an object.`,
				);
			}
			const emoji = media.emoji as Record<string, unknown>;
			const id =
				typeof emoji.id === "string" && emoji.id ? emoji.id : undefined;
			const name =
				typeof emoji.name === "string" && emoji.name ? emoji.name : undefined;
			if (Boolean(id) === Boolean(name) || (id && !isDiscordSnowflake(id))) {
				throw new Error(
					`CONTENT_ERROR: Discord poll answer ${index + 1} emoji requires exactly one valid id or name.`,
				);
			}
			normalizedMedia.emoji = {
				...(id ? { id } : {}),
				...(name ? { name } : {}),
			};
		}
		return { poll_media: normalizedMedia };
	});

	const normalized: Record<string, unknown> = {
		question: { text: (rawQuestion as Record<string, unknown>).text },
		answers,
	};
	if (poll.duration !== undefined) {
		if (
			typeof poll.duration !== "number" ||
			!Number.isInteger(poll.duration) ||
			poll.duration < 1 ||
			poll.duration > 768
		) {
			throw new Error(
				"CONTENT_ERROR: Discord poll duration must be 1-768 whole hours.",
			);
		}
		normalized.duration = poll.duration;
	}
	if (poll.allow_multiselect !== undefined) {
		if (typeof poll.allow_multiselect !== "boolean") {
			throw new Error(
				"CONTENT_ERROR: Discord poll allow_multiselect must be boolean.",
			);
		}
		normalized.allow_multiselect = poll.allow_multiselect;
	}
	if (poll.layout_type !== undefined) {
		if (poll.layout_type !== 1) {
			throw new Error(
				"CONTENT_ERROR: Discord poll layout_type currently supports only 1.",
			);
		}
		normalized.layout_type = 1;
	}
	return normalized;
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
			const webhookUrl = parseDiscordWebhookUrl(
				request.account.access_token,
			).url;

			const parsedOptions = DiscordTargetOptions.safeParse(
				request.target_options,
			);
			if (!parsedOptions.success) {
				const issue = parsedOptions.error.issues[0];
				const path = issue?.path.length ? ` ${issue.path.join(".")}` : "";
				throw new Error(
					`CONTENT_ERROR: Invalid Discord target option${path}: ${issue?.message ?? "validation failed"}.`,
				);
			}
			const opts = parsedOptions.data;
			const content = (opts.content as string) ?? request.content ?? "";
			const username = opts.username as string | undefined;
			const avatarUrl = opts.avatar_url as string | undefined;
			const threadId =
				typeof opts.thread_id === "string" && opts.thread_id.trim()
					? opts.thread_id.trim()
					: undefined;
			const threadName =
				typeof opts.thread_name === "string" && opts.thread_name.trim()
					? opts.thread_name.trim()
					: undefined;
			if (threadId && threadName) {
				throw new Error(
					"CONTENT_ERROR: Discord thread_id and thread_name are mutually exclusive.",
				);
			}
			if (opts.thread_id !== undefined && !isDiscordSnowflake(threadId)) {
				throw new Error(
					"CONTENT_ERROR: Discord thread_id must be a 17-20 digit snowflake.",
				);
			}

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
			if (opts.tts !== undefined) {
				if (typeof opts.tts !== "boolean") {
					throw new Error("CONTENT_ERROR: Discord tts must be boolean.");
				}
				if (opts.tts && !content) {
					throw new Error(
						"CONTENT_ERROR: Discord TTS messages require text content.",
					);
				}
				body.tts = opts.tts;
			}
			if (threadName) body.thread_name = threadName;
			if (opts.applied_tags !== undefined) {
				if (
					!Array.isArray(opts.applied_tags) ||
					opts.applied_tags.length > 5 ||
					opts.applied_tags.some(
						(tag) => typeof tag !== "string" || !isDiscordSnowflake(tag),
					)
				) {
					throw new Error(
						"CONTENT_ERROR: Discord applied_tags must contain at most five snowflake tag IDs.",
					);
				}
				if (opts.applied_tags.length > 0 && !threadName) {
					throw new Error(
						"CONTENT_ERROR: Discord applied_tags require thread_name for a new forum/media thread.",
					);
				}
				body.applied_tags = opts.applied_tags.map((tag) =>
					(tag as string).trim(),
				);
			}
			const poll = normalizeDiscordPoll(opts.poll);
			if (poll) body.poll = poll;

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

			// Must have at least one of content, embeds, poll, or files.
			// Official Execute Webhook docs: https://docs.discord.com/developers/resources/webhook#execute-webhook
			if (!body.content && !body.embeds && !body.poll && files.length === 0) {
				throw new Error(
					"Discord requires at least content, embeds, poll, or files in the message.",
				);
			}
			const executeUrl = new URL(webhookUrl);
			executeUrl.searchParams.set("wait", "true");
			if (threadId) executeUrl.searchParams.set("thread_id", threadId);

			// Send request — use multipart if files are present, JSON otherwise
			let res: Response;
			if (files.length > 0) {
				const multipart = await createStreamingMultipartFilesBody(
					[["payload_json", JSON.stringify(body)]],
					files,
				);
				pendingFileResponses.length = 0;
				const [responseOutcome, completionOutcome] = await Promise.allSettled([
					fetchWithTimeout(executeUrl, {
						method: "POST",
						redirect: "error",
						timeout: 30_000,
						timeoutThroughBody: true,
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
				res = await fetchWithTimeout(executeUrl, {
					method: "POST",
					redirect: "error",
					timeout: 30_000,
					timeoutThroughBody: true,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
			}

			if (res.status === 429) {
				const retryAfter = res.headers.get("retry-after");
				await res.body?.cancel().catch(() => {});
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
				const err = await readResponseJson<{ message?: string }>(
					res,
					DISCORD_RESPONSE_MAX_BYTES,
				).catch(() => ({}));
				const detail = (err as { message?: string }).message ?? res.statusText;
				const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
				throw new PublishError(`Discord webhook failed: ${detail}`, {
					statusCode: res.status,
					detail: raw,
				});
			}

			const result = await readResponseJson<{
				id?: string;
				channel_id?: string;
			}>(res, DISCORD_RESPONSE_MAX_BYTES);
			if (!result.id?.trim()) {
				throw new Error(
					"Discord returned a successful webhook response without a message ID.",
				);
			}

			let threadContextEffect: ProviderEffect | undefined;
			if (threadId || threadName) {
				const returnedChannelId = result.channel_id?.trim();
				const resolvedThreadId = returnedChannelId || threadId;
				const responseMatchesRequestedThread =
					!threadId || !returnedChannelId || returnedChannelId === threadId;
				threadContextEffect =
					responseMatchesRequestedThread && isDiscordSnowflake(resolvedThreadId)
						? {
								name: DISCORD_THREAD_CONTEXT_EFFECT,
								status: "succeeded",
								provider_id: resolvedThreadId.trim(),
							}
						: {
								name: DISCORD_THREAD_CONTEXT_EFFECT,
								status: "outcome_unknown",
								error: {
									code: "DISCORD_THREAD_CONTEXT_UNKNOWN",
									message:
										"Discord created the message without a trustworthy thread channel ID.",
								},
							};
				await recordProviderEffect(request, threadContextEffect);
			}

			// Try to get guild_id from the webhook info to build a jump URL
			// The unauthenticated endpoint requires both webhook ID and token in the URL
			let platformUrl: string | undefined;
			try {
				const webhookParts = webhookUrl.split("/webhooks/")[1]?.split("/");
				const webhookId = webhookParts?.[0];
				const webhookToken = webhookParts?.[1];
				if (webhookId && webhookToken) {
					const webhookInfo = await fetchWithTimeout(
						`https://discord.com/api/webhooks/${webhookId}/${webhookToken}`,
						{
							redirect: "error",
							timeout: 10_000,
							timeoutThroughBody: true,
						},
					);
					if (webhookInfo.ok) {
						const info = await readResponseJson<{ guild_id?: string }>(
							webhookInfo,
							DISCORD_RESPONSE_MAX_BYTES,
						);
						if (info.guild_id) {
							if (result.channel_id) {
								platformUrl = `https://discord.com/channels/${info.guild_id}/${result.channel_id}/${result.id}`;
							}
						}
					} else {
						await webhookInfo.body?.cancel().catch(() => {});
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
					effects: mergeProviderEffects(
						request.effect_recorder?.effects,
						threadContextEffect ? [threadContextEffect] : undefined,
					),
				},
			};
		} catch (err) {
			await cancelPendingFiles();
			return classifyPublishError(err, { safeToRetryRateLimit: true });
		}
	},
};
