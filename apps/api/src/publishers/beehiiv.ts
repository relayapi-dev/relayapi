import { classifyPublishError, type Publisher, type PublishRequest, type PublishResult } from "./types";

/**
 * Beehiiv publisher.
 * Publishes content as a newsletter post via the Beehiiv API.
 * The API key is stored as access_token, publication_id in metadata.
 *
 * Beehiiv API v2:
 * - Create Post: https://developers.beehiiv.com/api-reference/posts/create
 *   POST /v2/publications/{publicationId}/posts
 *   Body: { title (required), body_content (raw HTML), subtitle, status: "confirmed"|"draft" }
 *   Response: { data: { id } }
 * - Show Post: https://developers.beehiiv.com/api-reference/posts/show
 *   GET /v2/publications/{publicationId}/posts/{postId}
 *   Response: { data: { id, web_url, slug, ... } }
 */

const BEEHIIV_API = "https://api.beehiiv.com/v2";

function wrapInHtml(text: string): string {
	return text
		.split("\n\n")
		.map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
		.join("");
}

export const beehiivPublisher: Publisher = {
	platform: "beehiiv",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const apiKey = request.account.access_token;
			const metadata = request.account.metadata ?? undefined;
			const publicationId =
				(metadata?.publication_id as string) ?? request.account.platform_account_id;

			if (!apiKey || !publicationId) {
				throw new Error("CONTENT_ERROR: Beehiiv API key and publication ID are required.");
			}

			const opts = request.target_options;

			// Newsletter-specific fields from target_options
			const subject = (opts.subject as string) ??
				(request.content?.split("\n")[0]?.slice(0, 100) || "Newsletter Update");
			const previewText = opts.preview_text as string | undefined;
			const bodyContent = (opts.content_html as string) ??
				wrapInHtml(request.content ?? "");

			// Add images from media as inline HTML if not already in content_html
			let finalContent = bodyContent;
			if (request.media.length > 0 && !opts.content_html) {
				const imgHtml = request.media
					.filter((m) => !m.type || m.type === "image")
					.map((m) => `<img src="${m.url}" style="max-width:100%;">`)
					.join("");
				finalContent = imgHtml + finalContent;
			}

			// Beehiiv Create Post API
			// Docs: https://developers.beehiiv.com/api-reference/posts/create
			// Field: body_content (NOT content_html) for raw HTML
			// Field: subtitle is web subtitle (not email preview text)
			const body: Record<string, unknown> = {
				title: subject,
				body_content: finalContent,
				status: "confirmed", // send immediately
			};

			if (previewText) {
				body.subtitle = previewText;
			}

			// Scheduling: if scheduled_at is provided, use "draft" status and set scheduled_at
			// Docs: https://developers.beehiiv.com/api-reference/posts/create
			const scheduledAt = opts.scheduled_at as string | undefined;
			if (scheduledAt) {
				body.status = "draft";
				body.scheduled_at = scheduledAt;
			}

			const thumbnailUrl = opts.thumbnail_image_url as string | undefined;
			if (thumbnailUrl) {
				body.thumbnail_image_url = thumbnailUrl;
			}

			const contentTags = opts.content_tags as string[] | undefined;
			if (contentTags && contentTags.length > 0) {
				body.content_tags = contentTags;
			}

			const res = await fetch(
				`${BEEHIIV_API}/publications/${publicationId}/posts`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				},
			);

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				const detail = (err as any)?.errors?.[0]?.message ?? (err as any)?.message ?? res.statusText;

				if (res.status === 401) {
					throw new Error(`TOKEN_EXPIRED: Beehiiv API key is invalid: ${detail}`);
				}
				if (res.status === 429) {
					throw new Error(`RATE_LIMITED: ${detail}`);
				}
				throw new Error(`Beehiiv publish failed (${res.status}): ${detail}`);
			}

			// Create Post response only returns { data: { id } }
			// web_url requires a follow-up GET request
			const result = (await res.json()) as {
				data?: { id?: string };
			};

			const postId = result.data?.id;
			let platformUrl: string | undefined;

			// Fetch the post to get web_url
			if (postId) {
				try {
					const getRes = await fetch(
						`${BEEHIIV_API}/publications/${publicationId}/posts/${postId}`,
						{ headers: { Authorization: `Bearer ${apiKey}` } },
					);
					if (getRes.ok) {
						const postData = (await getRes.json()) as {
							data?: { web_url?: string };
						};
						platformUrl = postData.data?.web_url ?? undefined;
					}
				} catch {
					// Non-fatal — platform_url is optional
				}
			}

			return {
				success: true,
				platform_post_id: postId,
				platform_url: platformUrl,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
