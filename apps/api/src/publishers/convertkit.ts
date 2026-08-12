import { readPublisherJson, readPublisherText } from "./provider-response";
import {
	classifyPublishError,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
	type ReconcileRequest,
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

	async reconcile(request: ReconcileRequest): Promise<PublishResult> {
		try {
			const broadcastId =
				request.platform_post_id ?? request.provider_operation_id;
			if (!broadcastId || !request.account.access_token) {
				throw new Error(
					"CONTENT_ERROR: Kit reconciliation requires a broadcast ID and API key.",
				);
			}
			// Official docs: https://developers.kit.com/api-reference/broadcasts/get-stats-for-a-broadcast
			// GET /v4/broadcasts/{broadcast_id}/stats returns `stats.status` and
			// send progress without creating or updating the broadcast.
			const response = await fetch(
				`${KIT_API}/broadcasts/${encodeURIComponent(broadcastId)}/stats`,
				{
					headers: { "X-Kit-Api-Key": request.account.access_token },
				},
			);
			if (!response.ok) {
				const body = await readPublisherText(response);
				throw new PublishError(
					`Kit broadcast status failed (${response.status})`,
					{ statusCode: response.status, detail: body },
				);
			}
			const data = (await readPublisherJson(response)) as {
				broadcast?: {
					id?: number;
					stats?: { status?: string; progress?: number };
				};
			};
			const id = data.broadcast?.id?.toString() ?? broadcastId;
			const status = data.broadcast?.stats?.status?.toLowerCase() ?? "unknown";
			const shared = {
				provider_operation_id: id,
				platform_post_id: id,
				provider_state: status,
			};
			if (["sent", "finished", "completed"].includes(status)) {
				return {
					success: true,
					platform_post_id: id,
					provider_outcome: { disposition: "sent", ...shared },
				};
			}
			if (status === "sending") {
				return {
					success: true,
					platform_post_id: id,
					provider_outcome: { disposition: "processing", ...shared },
				};
			}
			if (status === "scheduled") {
				return {
					success: true,
					platform_post_id: id,
					provider_outcome: { disposition: "scheduled", ...shared },
				};
			}
			if (status === "draft") {
				return {
					success: false,
					platform_post_id: id,
					provider_outcome: { disposition: "failed", ...shared },
					error: {
						code: "PROVIDER_DRAFT_REQUIRES_MANUAL_ACTION",
						message:
							"Kit reports this broadcast as a draft; RelayAPI cannot advance or track provider drafts.",
					},
				};
			}
			return {
				success: false,
				platform_post_id: id,
				provider_outcome: { disposition: "outcome_unknown", ...shared },
				error: {
					code: "PUBLISH_OUTCOME_UNKNOWN",
					message: `Kit returned an unrecognized broadcast status: ${status}`,
				},
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const apiKey = request.account.access_token;
			const opts = request.target_options;
			if (opts.send_at === null) {
				return {
					success: false,
					error: {
						code: "PROVIDER_DRAFT_UNSUPPORTED",
						message:
							'RelayAPI does not create Kit provider drafts; use top-level scheduled_at: "draft" for a local Relay draft, or provide a send_at timestamp.',
					},
				};
			}
			const media = Array.isArray(opts.media) ? opts.media : request.media;
			if (media.length > 0) {
				return {
					success: false,
					error: {
						code: "UNSUPPORTED_MEDIA_TYPE",
						message:
							"Kit broadcasts accept text or HTML content; Relay media attachments are not supported.",
					},
				};
			}

			if (!apiKey) {
				throw new Error("CONTENT_ERROR: Kit API key is required.");
			}

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
			const templateId = opts.email_template_id;
			if (
				templateId !== undefined &&
				(typeof templateId !== "number" ||
					!Number.isSafeInteger(templateId) ||
					templateId < 1)
			) {
				return {
					success: false,
					error: {
						code: "INVALID_EMAIL_TEMPLATE_ID",
						message: "Kit email_template_id must be a positive integer.",
					},
				};
			}
			if (templateId !== undefined) {
				createBody.email_template_id = templateId;
			}

			// The official section documents null as a provider draft and a timestamp
			// as a scheduled send. RelayAPI rejects drafts until it can represent that
			// lifecycle terminally. Default one minute ahead to avoid a network-delayed
			// "now" timestamp becoming a past timestamp.
			const requestedSendAt = opts.send_at as string | undefined;
			const effectiveSendAt =
				requestedSendAt ?? new Date(Date.now() + 60_000).toISOString();
			createBody.send_at = effectiveSendAt;

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
				const err = (await readPublisherJson(createRes).catch(() => ({}))) as {
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

			const created = (await readPublisherJson(createRes)) as {
				// Official response schema, field `broadcast.public_url`.
				broadcast?: {
					id?: number;
					public_url?: string | null;
					status?: string;
					send_at?: string | null;
				};
			};
			const broadcastId = created.broadcast?.id;
			if (!broadcastId) {
				throw new Error("Kit: No broadcast ID returned");
			}

			const platformUrl =
				created.broadcast?.public_url ??
				`https://app.kit.com/broadcasts/${broadcastId}`;
			if (created.broadcast?.status?.toLowerCase() === "draft") {
				return {
					success: false,
					platform_post_id: String(broadcastId),
					platform_url: platformUrl,
					provider_outcome: {
						disposition: "failed",
						provider_operation_id: String(broadcastId),
						platform_post_id: String(broadcastId),
						platform_url: platformUrl,
						provider_state: "draft",
					},
					error: {
						code: "PROVIDER_DRAFT_REQUIRES_MANUAL_ACTION",
						message:
							"Kit created a draft instead of the requested scheduled broadcast; RelayAPI will not report it as published or poll it indefinitely.",
					},
				};
			}
			return {
				success: true,
				platform_post_id: String(broadcastId),
				platform_url: platformUrl,
				provider_outcome: {
					disposition: "scheduled",
					provider_operation_id: String(broadcastId),
					platform_post_id: String(broadcastId),
					platform_url: platformUrl,
					provider_state: created.broadcast?.status ?? "scheduled",
					next_reconcile_at:
						created.broadcast?.send_at ?? String(effectiveSendAt),
				},
			};
		} catch (err) {
			return classifyPublishError(err, { safeToRetryRateLimit: true });
		}
	},
};
