import { classifyPublishError, type Publisher, type PublishRequest, type PublishResult } from "./types";

/**
 * ConvertKit (Kit) publisher.
 * Creates and sends a broadcast via the Kit API v4.
 * API key stored in access_token.
 *
 * Kit API v4:
 * - Create Broadcast: https://developers.kit.com/v4/broadcasts/create
 *   POST /v4/broadcasts
 *   Body: { email_template_id?, content, subject, description?, public?, send_at? }
 *   Headers: Authorization: Bearer {api_key}
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
			const subject = (opts.subject as string) ??
				(request.content?.split("\n")[0]?.slice(0, 100) || "Newsletter Update");
			const contentHtml = (opts.content_html as string) ??
				wrapInHtml(request.content ?? "");
			const previewText = opts.preview_text as string | undefined;

			// Kit API v4: Create Broadcast
			// Docs: https://developers.kit.com/v4/broadcasts/create
			const createBody: Record<string, unknown> = {
				subject,
				content: contentHtml,
			};
			if (previewText) {
				createBody.description = previewText;
			}

			// email_template_id replaces v3's email_layout_template
			const templateId = opts.email_template_id as number | undefined;
			if (templateId) {
				createBody.email_template_id = templateId;
			}

			// Set send_at to publish immediately (current time in ISO format)
			// Users can override via target_options.send_at
			const sendAt = opts.send_at as string | undefined;
			createBody.send_at = sendAt ?? new Date().toISOString();

			const createRes = await fetch(`${KIT_API}/broadcasts`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(createBody),
			});

			if (!createRes.ok) {
				const err = await createRes.json().catch(() => ({}));
				const detail = (err as any)?.errors?.[0]?.message ?? (err as any)?.error ?? (err as any)?.message ?? createRes.statusText;

				if (createRes.status === 401) {
					throw new Error(`TOKEN_EXPIRED: Kit credentials invalid: ${detail}`);
				}
				if (createRes.status === 429) {
					throw new Error(`RATE_LIMITED: ${detail}`);
				}
				throw new Error(`Kit create failed (${createRes.status}): ${detail}`);
			}

			const created = (await createRes.json()) as {
				broadcast?: { id?: number };
			};
			const broadcastId = created.broadcast?.id;
			if (!broadcastId) {
				throw new Error("Kit: No broadcast ID returned");
			}

			return {
				success: true,
				platform_post_id: String(broadcastId),
				platform_url: `https://app.kit.com/broadcasts/${broadcastId}`,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
