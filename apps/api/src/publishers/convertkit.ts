import {
	classifyPublishError,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
} from "./types";

/**
 * ConvertKit (Kit) publisher.
 * Creates and sends a broadcast via the Kit API v4.
 * API key stored in access_token.
 *
 * Kit API v4:
 * - Create Broadcast: https://developers.kit.com/api-reference/broadcasts/create-a-broadcast
 *   POST /v4/broadcasts
 *   Body: { email_template_id?, content, subject, preview_text?, public?, send_at? }
 *   Headers: X-Kit-Api-Key: {api_key}
 * - V3 is deprecated: https://developers.kit.com/api-reference/upgrading-to-v4
 */

const KIT_API = "https://api.kit.com/v4";

function wrapInHtml(text: string): string {
	return text
		.split("\n\n")
		.map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
		.join("");
}

export const convertkitPublisher: Publisher = {
	platform: "convertkit",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const apiKey = request.account.access_token;

			if (!apiKey) {
				throw new Error("CONTENT_ERROR: Kit API key is required.");
			}

			const opts = request.target_options;
			const subject =
				(opts.subject as string) ??
				(request.content?.split("\n")[0]?.slice(0, 100) || "Newsletter Update");
			const contentHtml =
				(opts.content_html as string) ?? wrapInHtml(request.content ?? "");
			const previewText = opts.preview_text as string | undefined;

			// Kit API v4: Create Broadcast.
			// Official docs: https://developers.kit.com/api-reference/broadcasts/create-a-broadcast
			// Section "Create a broadcast": POST https://api.kit.com/v4/broadcasts
			// with content, subject, preview_text, public, published_at, and send_at.
			const createBody: Record<string, unknown> = {
				subject,
				content: contentHtml,
			};
			if (previewText) {
				createBody.preview_text = previewText;
			}
			if (typeof opts.public === "boolean") {
				createBody.public = opts.public;
			}
			if (typeof opts.published_at === "string") {
				createBody.published_at = opts.published_at;
			}

			// email_template_id replaces v3's email_layout_template
			const templateId = opts.email_template_id as number | undefined;
			if (templateId) {
				createBody.email_template_id = templateId;
			}

			// The official section documents null as a draft and a timestamp as a
			// scheduled send; it does not expose a separate immediate-send action.
			// Default one minute ahead to use the documented scheduling behavior and
			// avoid a network-delayed "now" timestamp becoming a past timestamp.
			// Users can override the schedule through target_options.send_at.
			const sendAt = opts.send_at as string | undefined;
			createBody.send_at =
				sendAt ?? new Date(Date.now() + 60_000).toISOString();

			const createRes = await fetch(`${KIT_API}/broadcasts`, {
				method: "POST",
				headers: {
					// Same official section, cURL example: `X-Kit-Api-Key`.
					"X-Kit-Api-Key": apiKey,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(createBody),
			});

			if (!createRes.ok) {
				const err = (await createRes.json().catch(() => ({}))) as {
					errors?: Array<{ message?: string }>;
					error?: string;
					message?: string;
				};
				const detail =
					err?.errors?.[0]?.message ??
					err?.error ??
					err?.message ??
					createRes.statusText;
				const raw = `HTTP ${createRes.status}\n${JSON.stringify(err)}`;

				if (createRes.status === 401) {
					throw new PublishError(
						`TOKEN_EXPIRED: Kit credentials invalid: ${detail}`,
						{ statusCode: createRes.status, detail: raw },
					);
				}
				if (createRes.status === 429) {
					throw new PublishError(`RATE_LIMITED: ${detail}`, {
						statusCode: createRes.status,
						detail: raw,
					});
				}
				throw new PublishError(
					`Kit create failed (${createRes.status}): ${detail}`,
					{ statusCode: createRes.status, detail: raw },
				);
			}

			const created = (await createRes.json()) as {
				// Official response schema, field `broadcast.public_url`.
				broadcast?: { id?: number; public_url?: string | null };
			};
			const broadcastId = created.broadcast?.id;
			if (!broadcastId) {
				throw new Error("Kit: No broadcast ID returned");
			}

			return {
				success: true,
				platform_post_id: String(broadcastId),
				platform_url:
					created.broadcast?.public_url ??
					`https://app.kit.com/broadcasts/${broadcastId}`,
			};
		} catch (err) {
			return classifyPublishError(err, { safeToRetryRateLimit: true });
		}
	},
};
