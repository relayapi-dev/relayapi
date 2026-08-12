import { GRAPH_BASE } from "../config/api-versions";
import { readPublisherJson } from "./provider-response";
import {
	classifyPublishError,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
} from "./types";

const WA_API_BASE = GRAPH_BASE.facebook;

interface WhatsAppMessageResponse {
	messaging_product: string;
	contacts?: Array<{ input: string; wa_id: string }>;
	messages?: Array<{ id: string }>;
	error?: { message: string; code: number };
}

async function waFetch(
	phoneNumberId: string,
	accessToken: string,
	body: Record<string, unknown>,
): Promise<WhatsAppMessageResponse> {
	// WhatsApp Cloud API — Send a message via the Business Platform
	// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages/
	const res = await fetch(`${WA_API_BASE}/${phoneNumberId}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	const data = (await readPublisherJson(res)) as WhatsAppMessageResponse;

	if (!res.ok || data.error) {
		const msg = data.error?.message ?? `WhatsApp API error: ${res.status}`;
		const code = data.error?.code;
		const raw = `HTTP ${res.status}\n${JSON.stringify(data)}`;
		if (res.status === 401 || code === 190) {
			throw new PublishError(`TOKEN_EXPIRED: ${msg}`, {
				statusCode: res.status,
				detail: raw,
			});
		}
		if (res.status === 429 || code === 4 || code === 80007) {
			throw new PublishError(`RATE_LIMITED: ${msg}`, {
				statusCode: res.status,
				detail: raw,
			});
		}
		throw new PublishError(msg, { statusCode: res.status, detail: raw });
	}

	return data;
}

function whatsappAccepted(data: WhatsAppMessageResponse): PublishResult {
	const messageId = data.messages?.[0]?.id?.trim();
	if (!messageId) {
		return {
			success: false,
			provider_outcome: {
				disposition: "outcome_unknown",
				provider_state: "accepted_without_message_id",
			},
			error: {
				code: "PUBLISH_OUTCOME_UNKNOWN",
				message:
					"WhatsApp accepted the request but did not return a message ID.",
			},
		};
	}
	return {
		success: true,
		platform_post_id: messageId,
		provider_outcome: {
			disposition: "accepted",
			reconciliation: "webhook",
			provider_operation_id: messageId,
			platform_post_id: messageId,
			provider_state: "accepted",
		},
	};
}

/**
 * Normalize a signed WhatsApp status webhook for the outbound post target.
 * The webhook route remains responsible for tenant/account lookup, signature
 * validation, deduplication, and the monotonic database transition.
 */
export function whatsappStatusResult(
	messageId: string,
	status: string,
	error?: { code?: string | number; message?: string },
): PublishResult {
	const providerState = status.toLowerCase();
	if (providerState === "failed") {
		return {
			success: false,
			platform_post_id: messageId,
			provider_outcome: {
				disposition: "failed",
				provider_operation_id: messageId,
				platform_post_id: messageId,
				provider_state: providerState,
			},
			error: {
				code: error?.code ? `WHATSAPP_${error.code}` : "WHATSAPP_FAILED",
				message: error?.message ?? "WhatsApp failed to send the message.",
			},
		};
	}
	if (providerState === "delivered" || providerState === "read") {
		return {
			success: true,
			platform_post_id: messageId,
			provider_outcome: {
				disposition: "delivered",
				provider_operation_id: messageId,
				platform_post_id: messageId,
				provider_state: providerState,
			},
		};
	}
	if (providerState === "sent") {
		return {
			success: true,
			platform_post_id: messageId,
			provider_outcome: {
				// Meta's `sent` status confirms hand-off to WhatsApp, not delivery to
				// the recipient. Keep the post nonterminal until delivered/read or
				// failed so Relay does not overstate delivery.
				disposition: "accepted",
				reconciliation: "webhook",
				provider_operation_id: messageId,
				platform_post_id: messageId,
				provider_state: providerState,
			},
		};
	}
	return {
		success: false,
		platform_post_id: messageId,
		provider_outcome: {
			disposition: "outcome_unknown",
			reconciliation: "webhook",
			provider_operation_id: messageId,
			platform_post_id: messageId,
			provider_state: providerState || "missing_status",
		},
		error: {
			code: "PUBLISH_OUTCOME_UNKNOWN",
			message: `WhatsApp returned an undocumented message status: ${status || "missing"}.`,
		},
	};
}

export const whatsappPublisher: Publisher = {
	platform: "whatsapp",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const accessToken = request.account.access_token;
			// platform_account_id is the WhatsApp Business Phone Number ID
			const phoneNumberId = request.account.platform_account_id;
			const opts = request.target_options;

			const to = opts.to as string | undefined;
			if (!to) {
				return {
					success: false,
					error: {
						code: "MISSING_RECIPIENT",
						message:
							"WhatsApp requires a 'to' phone number in target_options (E.164 format without +).",
					},
				};
			}

			// Template message (required for outbound outside 24h window)
			const templateName = opts.template_name as string | undefined;
			if (templateName) {
				const templateLang = (opts.template_language as string) ?? "en_US";
				const templateComponents =
					(opts.template_components as Array<Record<string, unknown>>) ?? [];

				const body: Record<string, unknown> = {
					messaging_product: "whatsapp",
					recipient_type: "individual",
					to,
					type: "template",
					template: {
						name: templateName,
						language: { code: templateLang },
						...(templateComponents.length > 0
							? { components: templateComponents }
							: {}),
					},
				};

				const data = await waFetch(phoneNumberId, accessToken, body);
				return whatsappAccepted(data);
			}

			// Interactive message (buttons or list)
			if (opts.interactive) {
				const interactive = opts.interactive as {
					type: "button" | "list";
					header?: { type: string; text?: string };
					body: { text: string };
					footer?: { text: string };
					action: unknown;
				};
				const body: Record<string, unknown> = {
					messaging_product: "whatsapp",
					recipient_type: "individual",
					to,
					type: "interactive",
					interactive,
				};
				const data = await waFetch(phoneNumberId, accessToken, body);
				return whatsappAccepted(data);
			}

			// Location message
			if (opts.location) {
				const location = opts.location as {
					latitude: number;
					longitude: number;
					name?: string;
					address?: string;
				};
				const body: Record<string, unknown> = {
					messaging_product: "whatsapp",
					recipient_type: "individual",
					to,
					type: "location",
					location,
				};
				const data = await waFetch(phoneNumberId, accessToken, body);
				return whatsappAccepted(data);
			}

			// Reaction message
			if (opts.reaction) {
				const reaction = opts.reaction as {
					message_id: string;
					emoji: string;
				};
				const body: Record<string, unknown> = {
					messaging_product: "whatsapp",
					recipient_type: "individual",
					to,
					type: "reaction",
					reaction,
				};
				const data = await waFetch(phoneNumberId, accessToken, body);
				return whatsappAccepted(data);
			}

			// Contact card message
			if (opts.contacts) {
				const contacts = opts.contacts as Array<{
					name: {
						formatted_name: string;
						first_name?: string;
						last_name?: string;
					};
					phones?: Array<{ phone: string; type?: string }>;
					emails?: Array<{ email: string; type?: string }>;
				}>;
				const body: Record<string, unknown> = {
					messaging_product: "whatsapp",
					recipient_type: "individual",
					to,
					type: "contacts",
					contacts,
				};
				const data = await waFetch(phoneNumberId, accessToken, body);
				return whatsappAccepted(data);
			}

			const content = (opts.content as string) ?? request.content ?? "";
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;
			if (media.length > 1) {
				// Official Meta docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api
				// Section "Request Syntax" -> each POST creates one message with one
				// selected type (image, video, document, audio, text, or template).
				return {
					success: false,
					error: {
						code: "TOO_MANY_MEDIA",
						message:
							"WhatsApp Cloud API sends one media message per request; provide at most one attachment.",
					},
				};
			}

			// Media message
			const m = media?.[0];
			if (m) {
				if (
					m.type &&
					!["image", "video", "document", "audio"].some(
						(type) => type === m.type,
					)
				) {
					// This publisher intentionally supports image, video, document, and
					// audio messages. WhatsApp also has a sticker message type, but RelayAPI
					// does not map its generic `gif` attachment type to that API shape.
					return {
						success: false,
						error: {
							code: "UNSUPPORTED_MEDIA_TYPE",
							message: `RelayAPI's WhatsApp publisher does not support ${m.type} media attachments.`,
						},
					};
				}
				const mediaType = (
					["image", "video", "document", "audio"] as const
				).includes(m.type as never)
					? (m.type as "image" | "video" | "document" | "audio")
					: "image";
				if (mediaType === "audio" && content.trim().length > 0) {
					return {
						success: false,
						error: {
							code: "AUDIO_CAPTION_UNSUPPORTED",
							message:
								"WhatsApp audio messages do not support captions; remove text content or use a non-audio attachment.",
						},
					};
				}

				// Use link-based media (simpler, no upload needed for public URLs)
				const mediaPayload: Record<string, unknown> = {
					link: m.url,
				};
				if (content && mediaType !== "audio") {
					// Official docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages#media-object
					// Section "Media object" -> caption maximum length is 1,024.
					if (content.length > 1024) {
						return {
							success: false,
							error: {
								code: "CONTENT_TOO_LONG",
								message: `WhatsApp media caption is ${content.length} characters. Limit is 1,024.`,
							},
						};
					}
					mediaPayload.caption = content;
				}
				// WhatsApp requires filename for document messages
				if (mediaType === "document") {
					const urlFilename =
						m.url.split("/").pop()?.split("?")[0] ?? "document";
					mediaPayload.filename = urlFilename;
				}

				const body: Record<string, unknown> = {
					messaging_product: "whatsapp",
					recipient_type: "individual",
					to,
					type: mediaType,
					[mediaType]: mediaPayload,
				};

				const data = await waFetch(phoneNumberId, accessToken, body);
				return whatsappAccepted(data);
			}

			// Text message
			if (!content) {
				return {
					success: false,
					error: {
						code: "EMPTY_CONTENT",
						message: "No content or media provided for WhatsApp message.",
					},
				};
			}

			if (content.length > 4096) {
				return {
					success: false,
					error: {
						code: "CONTENT_TOO_LONG",
						message: `Content is ${content.length} characters. WhatsApp limit is 4,096.`,
					},
				};
			}

			const body: Record<string, unknown> = {
				messaging_product: "whatsapp",
				recipient_type: "individual",
				to,
				type: "text",
				text: {
					preview_url: (opts.preview_url as boolean) ?? false,
					body: content,
				},
			};

			const data = await waFetch(phoneNumberId, accessToken, body);
			return whatsappAccepted(data);
		} catch (err) {
			return classifyPublishError(err, { safeToRetryRateLimit: true });
		}
	},
};
