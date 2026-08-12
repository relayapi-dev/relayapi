import { readPublisherJson } from "./provider-response";
import {
	classifyPublishError,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
	type ReconcileRequest,
} from "./types";

/**
 * Beehiiv publisher.
 * Publishes content as a newsletter post via the Beehiiv API.
 * The API key is stored as access_token, publication_id in metadata.
 *
 * Beehiiv API v2:
 * - Create Post: https://developers.beehiiv.com/api-reference/posts/create
 *   POST /v2/publications/{publicationId}/posts
 *   Body: { title (required), body_content (raw HTML), status: "confirmed"|"draft" }
 *   Response: { data: { id } }
 * - Show Post: https://developers.beehiiv.com/api-reference/posts/show
 *   GET /v2/publications/{publicationId}/posts/{postId}
 *   Response: { data: { id, status, publish_date, web_url, slug, ... } }
 *   Send API builds return HTTP 202 until the post resource is available.
 * - List Posts: https://developers.beehiiv.com/api-reference/posts/index
 *   The documented post statuses are draft, confirmed, and archived.
 */

const BEEHIIV_API = "https://api.beehiiv.com/v2";

function wrapInHtml(text: string): string {
	return text
		.split("\n\n")
		.map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
		.join("");
}

function getPublicationId(account: PublishRequest["account"]): string {
	// The selected publication is connection-owned identity. Public metadata
	// updates must never redirect the stored API key to a different publication.
	return account.platform_account_id;
}

function nextReconcileAt(
	retryAfter: string | null,
	fallbackSeconds = 5,
): string {
	const now = Date.now();
	if (retryAfter !== null) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return new Date(now + Math.floor(seconds * 1000)).toISOString();
		}
		const absolute = Date.parse(retryAfter);
		if (Number.isFinite(absolute) && absolute > now) {
			return new Date(absolute).toISOString();
		}
	}
	return new Date(now + fallbackSeconds * 1000).toISOString();
}

function requestedScheduleMs(providerState: string | null): number | null {
	if (!providerState?.startsWith("scheduled:")) return null;
	const parsed = Date.parse(providerState.slice("scheduled:".length));
	return Number.isFinite(parsed) ? parsed : null;
}

function providerPublishMs(publishDate: number | undefined): number | null {
	if (
		typeof publishDate !== "number" ||
		!Number.isFinite(publishDate) ||
		publishDate <= 0
	) {
		return null;
	}
	return Math.floor(publishDate * 1000);
}

export const beehiivPublisher: Publisher = {
	platform: "beehiiv",

	async reconcile(request: ReconcileRequest): Promise<PublishResult> {
		const postId = request.provider_operation_id?.trim();
		if (!postId) {
			return {
				success: false,
				provider_outcome: {
					disposition: "outcome_unknown",
					effects: [...request.effects],
				},
				error: {
					code: "MISSING_PROVIDER_OPERATION_ID",
					message: "Beehiiv reconciliation requires the created post ID.",
				},
			};
		}

		try {
			const publicationId = getPublicationId(request.account);
			const res = await fetch(
				`${BEEHIIV_API}/publications/${encodeURIComponent(publicationId)}/posts/${encodeURIComponent(postId)}`,
				{
					headers: {
						Authorization: `Bearer ${request.account.access_token}`,
					},
				},
			);

			// Official Show Post docs: a newly-created Send API post returns 202
			// with Retry-After while its asynchronous build is still in progress.
			if (res.status === 202) {
				await res.body?.cancel().catch(() => {});
				return {
					success: true,
					platform_post_id: postId,
					provider_outcome: {
						disposition: request.provider_state?.startsWith("scheduled:")
							? "scheduled"
							: "processing",
						provider_operation_id: postId,
						platform_post_id: postId,
						provider_state:
							request.provider_state ?? "post_creation_processing",
						next_reconcile_at: nextReconcileAt(res.headers.get("retry-after")),
						effects: [...request.effects],
					},
				};
			}

			const responseBody = (await readPublisherJson(res).catch(() => ({}))) as {
				code?: string;
				message?: string;
				errors?: Array<{ code?: string; message?: string }>;
				data?: {
					id?: string;
					status?: string;
					web_url?: string;
					preview_url?: string;
					publish_date?: number;
				};
			};
			const errorCode = responseBody.code ?? responseBody.errors?.[0]?.code;
			if (res.status === 404 && errorCode === "POST_CREATION_FAILED") {
				return {
					success: false,
					provider_outcome: {
						disposition: "failed",
						provider_operation_id: postId,
						platform_post_id: postId,
						provider_state: errorCode,
						effects: [...request.effects],
					},
					error: {
						code: errorCode,
						message:
							responseBody.message ??
							responseBody.errors?.[0]?.message ??
							"Beehiiv failed to build the post.",
					},
				};
			}
			if (!res.ok) {
				const detail =
					responseBody.message ??
					responseBody.errors?.[0]?.message ??
					res.statusText;
				if (res.status === 401) {
					throw new PublishError(`TOKEN_EXPIRED: ${detail}`, {
						statusCode: res.status,
					});
				}
				if (res.status === 429) {
					throw new PublishError(`RATE_LIMITED: ${detail}`, {
						statusCode: res.status,
					});
				}
				throw new PublishError(`Beehiiv post lookup failed: ${detail}`, {
					statusCode: res.status,
				});
			}

			const data = responseBody.data;
			if (!data?.id) {
				return {
					success: false,
					provider_outcome: {
						disposition: "outcome_unknown",
						provider_operation_id: postId,
						platform_post_id: postId,
						provider_state: "missing_post_id",
						effects: [...request.effects],
					},
					error: {
						code: "PUBLISH_OUTCOME_UNKNOWN",
						message: "Beehiiv returned a post without its ID.",
					},
				};
			}

			const providerStatus = data.status?.trim().toLowerCase();
			const platformUrl = data.web_url ?? data.preview_url;
			const evidence = {
				provider_operation_id: postId,
				platform_post_id: data.id,
				platform_url: platformUrl,
				provider_state: providerStatus ?? "missing_status",
				effects: [...request.effects],
			};

			// Official List Posts status enum: draft is not scheduled and archived is
			// no longer active. Neither is evidence that Relay's requested send
			// published, so retain the provider ID and terminalize truthfully.
			if (providerStatus === "draft" || providerStatus === "archived") {
				const archived = providerStatus === "archived";
				return {
					success: false,
					platform_post_id: data.id,
					platform_url: platformUrl,
					provider_outcome: {
						disposition: "failed",
						...evidence,
					},
					error: {
						code: archived
							? "PROVIDER_ARCHIVED"
							: "PROVIDER_DRAFT_REQUIRES_MANUAL_ACTION",
						message: archived
							? "Beehiiv reports that the created post is archived and no longer active."
							: "Beehiiv reports that the created post is still a draft; publish it manually or create a new confirmed post.",
					},
				};
			}

			// HTTP 202 is Beehiiv's documented build-in-progress response. Keep a
			// defensive nonterminal mapping if a rollout exposes the same state in a
			// 200 JSON body; it can never be mistaken for publication.
			if (
				providerStatus === "processing" ||
				providerStatus === "pending" ||
				providerStatus === "building"
			) {
				return {
					success: true,
					platform_post_id: data.id,
					platform_url: platformUrl,
					provider_outcome: {
						disposition: "processing",
						...evidence,
						next_reconcile_at: nextReconcileAt(null),
					},
				};
			}

			if (providerStatus !== "confirmed") {
				return {
					success: false,
					platform_post_id: data.id,
					platform_url: platformUrl,
					provider_outcome: {
						disposition: "outcome_unknown",
						...evidence,
						next_reconcile_at: nextReconcileAt(null),
					},
					error: {
						code: "PUBLISH_OUTCOME_UNKNOWN",
						message: `Beehiiv returned an unrecognized post status: ${providerStatus ?? "missing"}.`,
					},
				};
			}

			const canonicalPublishMs = providerPublishMs(data.publish_date);
			const scheduledMs =
				canonicalPublishMs ?? requestedScheduleMs(request.provider_state);
			if (scheduledMs !== null && scheduledMs > Date.now()) {
				return {
					success: true,
					platform_post_id: data.id,
					platform_url: platformUrl,
					provider_outcome: {
						disposition: "scheduled",
						...evidence,
						next_reconcile_at: new Date(scheduledMs).toISOString(),
					},
				};
			}

			return {
				success: true,
				platform_post_id: data.id,
				platform_url: platformUrl,
				provider_outcome: {
					disposition: "published",
					...evidence,
				},
			};
		} catch (error) {
			const result = classifyPublishError(error);
			return {
				...result,
				provider_outcome: {
					disposition: "outcome_unknown",
					provider_operation_id: postId,
					platform_post_id: request.platform_post_id ?? postId,
					provider_state: request.provider_state ?? undefined,
					effects: [...request.effects],
				},
			};
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const apiKey = request.account.access_token;
			const publicationId = getPublicationId(request.account);

			if (!apiKey || !publicationId) {
				throw new Error(
					"CONTENT_ERROR: Beehiiv API key and publication ID are required.",
				);
			}

			const opts = request.target_options;
			const media = Array.isArray(opts.media) ? opts.media : request.media;
			const unsupportedMedia = media.find(
				(item) =>
					item.type !== undefined &&
					item.type !== "image" &&
					item.type !== "gif",
			);
			if (unsupportedMedia) {
				return {
					success: false,
					error: {
						code: "UNSUPPORTED_MEDIA_TYPE",
						message: "Beehiiv inline media supports image attachments only.",
					},
				};
			}

			// Newsletter-specific fields from target_options
			const subject =
				(opts.subject as string) ??
				(request.content?.split("\n")[0]?.slice(0, 100) || "Newsletter Update");
			const previewText = opts.preview_text as string | undefined;
			const bodyContent =
				(opts.content_html as string) ?? wrapInHtml(request.content ?? "");

			// Add images from media as inline HTML if not already in content_html
			let finalContent = bodyContent;
			if (media.length > 0 && !opts.content_html) {
				const imgHtml = media
					.filter((m) => !m.type || m.type === "image" || m.type === "gif")
					.map((m) => `<img src="${m.url}" style="max-width:100%;">`)
					.join("");
				finalContent = imgHtml + finalContent;
			}

			// Beehiiv Create Post API.
			// Official docs: https://developers.beehiiv.com/api-reference/posts/create
			// Section "Request" -> body_content, email_settings, status, scheduled_at.
			const body: Record<string, unknown> = {
				title: subject,
				body_content: finalContent,
				status: "confirmed", // send immediately
			};

			// Section "Request" -> email_settings uses these exact field names;
			// subtitle is a separate web-post field and is not email preview text.
			body.email_settings = {
				email_subject_line: subject,
				...(previewText ? { email_preview_text: previewText } : {}),
			};

			// Section "Request" -> status: confirmed publishes immediately or at
			// scheduled_at; the docs explicitly state that a draft cannot be scheduled.
			const scheduledAt = opts.scheduled_at as string | undefined;
			if (scheduledAt) {
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
				const err = (await readPublisherJson(res).catch(() => ({}))) as {
					errors?: Array<{ message?: string }>;
					message?: string;
				};
				const detail =
					err?.errors?.[0]?.message ?? err?.message ?? res.statusText;
				const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;

				if (res.status === 401) {
					throw new PublishError(
						`TOKEN_EXPIRED: Beehiiv API key is invalid: ${detail}`,
						{ statusCode: res.status, detail: raw },
					);
				}
				if (res.status === 429) {
					throw new PublishError(`RATE_LIMITED: ${detail}`, {
						statusCode: res.status,
						detail: raw,
					});
				}
				throw new PublishError(
					`Beehiiv publish failed (${res.status}): ${detail}`,
					{ statusCode: res.status, detail: raw },
				);
			}

			// Create Post response only returns { data: { id } }
			// web_url requires a follow-up GET request
			const result = (await readPublisherJson(res)) as {
				data?: { id?: string };
			};

			const postId = result.data?.id?.trim();
			if (!postId) {
				return {
					success: false,
					provider_outcome: {
						disposition: "outcome_unknown",
						provider_state: "accepted_without_post_id",
					},
					error: {
						code: "PUBLISH_OUTCOME_UNKNOWN",
						message:
							"Beehiiv accepted the post but did not return the required post ID.",
					},
				};
			}

			return {
				success: true,
				platform_post_id: postId,
				provider_outcome: scheduledAt
					? {
							disposition: "scheduled",
							provider_operation_id: postId,
							platform_post_id: postId,
							provider_state: `scheduled:${scheduledAt}`,
							// First confirm Beehiiv's asynchronous post build. Once Show
							// Post returns the resource, reconcile() parks until send time.
							next_reconcile_at: nextReconcileAt(null),
						}
					: {
							disposition: "processing",
							provider_operation_id: postId,
							platform_post_id: postId,
							provider_state: "post_creation_processing",
							next_reconcile_at: nextReconcileAt(null),
						},
			};
		} catch (err) {
			return classifyPublishError(err, { safeToRetryRateLimit: true });
		}
	},
};
