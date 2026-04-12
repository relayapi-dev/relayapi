import { fetchPublicUrl } from "../lib/fetch-public-url";
import { classifyPublishError, type Publisher, type PublishRequest, type PublishResult } from "./types";

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
	timestamp?: string;
}

export const discordPublisher: Publisher = {
	platform: "discord",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const webhookUrl = request.account.access_token;
			if (!webhookUrl || !webhookUrl.includes("discord.com/api/webhooks")) {
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

			const fileBlobs: Array<{ blob: Blob; filename: string }> = [];
			const embeds: DiscordEmbed[] = [];

			if (media.length > 0) {
				for (const [i, item] of media.slice(0, 10).entries()) {
					const isVideo = item.type === "video";
					if (isVideo) {
						// Videos as link in content (Discord auto-embeds video URLs)
						const videoContent = `${body.content ?? ""}\n${item.url}`.trim();
						if (videoContent.length <= 2000) {
							body.content = videoContent;
						}
					} else {
						// Try to download image for file upload
						try {
							const mediaRes = await fetchPublicUrl(item.url, { timeout: 30_000 });
							if (mediaRes.ok) {
								const blob = await mediaRes.blob();
								const ext = item.url.split(".").pop()?.split("?")[0] ?? "png";
								fileBlobs.push({ blob, filename: `image_${i}.${ext}` });
							} else {
								// Fallback to embed URL
								embeds.push({ image: { url: item.url } });
							}
						} catch {
							// Fallback to embed URL
							embeds.push({ image: { url: item.url } });
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
				body.embeds = [...existing, ...(opts.embeds as unknown[])].slice(0, 10);
			}

			// Discord embed total character limit: 6,000 across all embeds
			// Docs: https://docs.discord.com/developers/resources/message#embed-object-embed-limits
			if (body.embeds) {
				let totalChars = 0;
				for (const embed of body.embeds as DiscordEmbed[]) {
					totalChars += (embed.title?.length ?? 0) + (embed.description?.length ?? 0);
				}
				if (totalChars > 6000) {
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
			if (!body.content && !body.embeds && fileBlobs.length === 0) {
				throw new Error(
					"Discord requires at least content, embeds, or files in the message.",
				);
			}

			// Send request — use multipart if files are present, JSON otherwise
			let res: Response;
			if (fileBlobs.length > 0) {
				const formData = new FormData();
				formData.append("payload_json", JSON.stringify(body));
				for (const [i, file] of fileBlobs.entries()) {
					formData.append(`files[${i}]`, file.blob, file.filename);
				}
				res = await fetch(`${webhookUrl}?wait=true`, {
					method: "POST",
					body: formData,
				});
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
				throw new Error(`RATE_LIMITED: Discord rate limit exceeded. Retry after ${retryAfter ?? "unknown"} seconds.`);
			}

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				const detail = (err as { message?: string }).message ?? res.statusText;
				throw new Error(`Discord webhook failed: ${detail}`);
			}

			const result = (await res.json()) as {
				id: string;
				channel_id: string;
			};

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
							platformUrl = `https://discord.com/channels/${info.guild_id}/${result.channel_id}/${result.id}`;
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
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
