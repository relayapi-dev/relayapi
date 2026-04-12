import { classifyPublishError, type Publisher, type PublishRequest, type PublishResult } from "./types";

const WA_API_BASE = "https://graph.facebook.com/v25.0";

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

	const data = (await res.json()) as WhatsAppMessageResponse;

	if (!res.ok || data.error) {
		const msg = data.error?.message ?? `WhatsApp API error: ${res.status}`;
		const code = data.error?.code;
		if (res.status === 401 || code === 190) {
			throw new Error(`TOKEN_EXPIRED: ${msg}`);
		}
		if (res.status === 429 || code === 4 || code === 80007) {
			throw new Error(`RATE_LIMITED: ${msg}`);
		}
		throw new Error(msg);
	}

	return data;
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
				const templateComponents = (opts.template_components as Array<Record<string, unknown>>) ?? [];

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
				const messageId = data.messages?.[0]?.id;

				return {
					success: true,
					platform_post_id: messageId,
				};
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
				return { success: true, platform_post_id: data.messages?.[0]?.id };
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
				return { success: true, platform_post_id: data.messages?.[0]?.id };
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
				return { success: true, platform_post_id: data.messages?.[0]?.id };
			}

			// Contact card message
			if (opts.contacts) {
				const contacts = opts.contacts as Array<{
					name: { formatted_name: string; first_name?: string; last_name?: string };
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
				return { success: true, platform_post_id: data.messages?.[0]?.id };
			}

			const content = (opts.content as string) ?? request.content ?? "";
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;

			// Media message
			if (media && media.length > 0) {
				const m = media[0]!;
				const mediaType = (
					["image", "video", "document", "audio"] as const
				).includes(m.type as never)
					? (m.type as "image" | "video" | "document" | "audio")
					: "image";

				// Use link-based media (simpler, no upload needed for public URLs)
				const mediaPayload: Record<string, unknown> = {
					link: m.url,
				};
				if (content && mediaType !== "audio") {
					mediaPayload.caption = content.slice(0, 1024);
				}
				// WhatsApp requires filename for document messages
				if (mediaType === "document") {
					const urlFilename = m.url.split("/").pop()?.split("?")[0] ?? "document";
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
				const messageId = data.messages?.[0]?.id;

				return {
					success: true,
					platform_post_id: messageId,
				};
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
			const messageId = data.messages?.[0]?.id;

			return {
				success: true,
				platform_post_id: messageId,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
