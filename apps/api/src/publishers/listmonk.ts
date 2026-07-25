import { isBlockedUrlWithDns } from "../lib/ssrf-guard";
import {
	classifyPublishError,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
	type ReconcileRequest,
} from "./types";

/**
 * ListMonk publisher.
 * Creates and sends a campaign via a self-hosted ListMonk instance.
 * Basic auth credentials in access_token (base64), instance URL in metadata.
 *
 * ListMonk API:
 * Docs: https://listmonk.app/docs/apis/campaigns/
 */

function wrapInHtml(text: string): string {
	return text
		.split("\n\n")
		.map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
		.join("");
}

interface ListmonkCampaignState {
	id?: number;
	status?: string;
}

function listmonkCampaignResult(
	instanceUrl: string,
	campaign: ListmonkCampaignState,
): PublishResult {
	const campaignId = campaign.id;
	if (!Number.isSafeInteger(campaignId) || !campaignId) {
		return {
			success: false,
			provider_outcome: {
				disposition: "outcome_unknown",
				provider_state: campaign.status ?? "missing_campaign_id",
			},
			error: {
				code: "PLATFORM_ERROR",
				message: "Listmonk campaign response did not include a valid ID.",
			},
		};
	}
	const id = String(campaignId);
	const state = campaign.status?.toLowerCase() ?? "unknown";
	const shared = {
		provider_operation_id: id,
		platform_post_id: id,
		platform_url: `${instanceUrl}/campaigns/${id}`,
		provider_state: state,
	};
	if (state === "finished") {
		return {
			success: true,
			platform_post_id: id,
			platform_url: shared.platform_url,
			provider_outcome: { disposition: "sent", ...shared },
		};
	}
	if (state === "scheduled") {
		return {
			success: true,
			platform_post_id: id,
			platform_url: shared.platform_url,
			provider_outcome: { disposition: "scheduled", ...shared },
		};
	}
	if (state === "running") {
		return {
			success: true,
			platform_post_id: id,
			platform_url: shared.platform_url,
			provider_outcome: { disposition: "processing", ...shared },
		};
	}
	if (state === "draft" || state === "paused") {
		return {
			success: true,
			platform_post_id: id,
			platform_url: shared.platform_url,
			provider_outcome: { disposition: "accepted", ...shared },
		};
	}
	if (state === "cancelled" || state === "canceled") {
		return {
			success: false,
			platform_post_id: id,
			provider_outcome: { disposition: "failed", ...shared },
			error: {
				code: "PUBLISH_FAILED",
				message: `Listmonk campaign ended with status ${state}.`,
			},
		};
	}
	return {
		success: false,
		platform_post_id: id,
		provider_outcome: { disposition: "outcome_unknown", ...shared },
		error: {
			code: "PUBLISH_OUTCOME_UNKNOWN",
			message: `Listmonk returned an unrecognized campaign status: ${state}`,
		},
	};
}

export const listmonkPublisher: Publisher = {
	platform: "listmonk",

	async reconcile(request: ReconcileRequest): Promise<PublishResult> {
		try {
			const campaignId =
				request.platform_post_id ?? request.provider_operation_id;
			const instanceUrl =
				(request.account.metadata?.instance_url as string | undefined) ?? "";
			if (!campaignId || !instanceUrl || !request.account.access_token) {
				throw new Error(
					"CONTENT_ERROR: Listmonk reconciliation requires a campaign ID, instance URL, and credentials.",
				);
			}
			if (await isBlockedUrlWithDns(instanceUrl)) {
				throw new Error(
					"CONTENT_ERROR: ListMonk instance URL points to a blocked address.",
				);
			}
			const response = await fetch(
				`${instanceUrl}/api/campaigns/${encodeURIComponent(campaignId)}`,
				{
					headers: { Authorization: `Basic ${request.account.access_token}` },
					redirect: "error",
				},
			);
			if (!response.ok) {
				const body = await response.text();
				throw new PublishError(
					`Listmonk campaign status failed (${response.status})`,
					{ statusCode: response.status, detail: body },
				);
			}
			const data = (await response.json()) as { data?: ListmonkCampaignState };
			return listmonkCampaignResult(instanceUrl, data.data ?? {});
		} catch (err) {
			return classifyPublishError(err);
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const authToken = request.account.access_token; // base64(user:pass)
			const metadata = request.account.metadata ?? undefined;
			const instanceUrl = (metadata?.instance_url as string) ?? "";

			if (!authToken || !instanceUrl) {
				throw new Error(
					"CONTENT_ERROR: ListMonk credentials and instance URL are required.",
				);
			}

			if (await isBlockedUrlWithDns(instanceUrl)) {
				throw new Error(
					"CONTENT_ERROR: ListMonk instance URL points to a blocked address.",
				);
			}

			const authHeader = `Basic ${authToken}`;
			const opts = request.target_options;

			const subject =
				(opts.subject as string) ??
				(request.content?.split("\n")[0]?.slice(0, 100) || "Newsletter Update");
			const contentHtml =
				(opts.content_html as string) ?? wrapInHtml(request.content ?? "");
			const listId = opts.list_id as number | undefined;
			const templateId = opts.template_id as number | undefined;
			const sendAt = opts.send_at as string | undefined;

			// Find a list if not specified
			let targetListIds: number[] = listId ? [listId] : [];
			if (targetListIds.length === 0) {
				// ListMonk API: Get Lists
				// Docs: https://listmonk.app/docs/apis/lists/
				const listsRes = await fetch(`${instanceUrl}/api/lists?per_page=1`, {
					headers: { Authorization: authHeader },
					redirect: "error",
				});
				if (listsRes.ok) {
					const lists = (await listsRes.json()) as {
						data?: { results?: Array<{ id: number }> };
					};
					const firstList = lists.data?.results?.[0]?.id;
					if (firstList) targetListIds = [firstList];
				}
			}

			if (targetListIds.length === 0) {
				throw new Error(
					"CONTENT_ERROR: No ListMonk list found. Create one or specify list_id.",
				);
			}

			// Step 1: Create a campaign.
			// Official docs: https://listmonk.app/docs/apis/campaigns/
			// Section "POST /api/campaigns" -> request fields `send_at` and `headers`.
			const body: Record<string, unknown> = {
				name: subject,
				subject,
				body: contentHtml,
				content_type: "html",
				type: "regular",
				lists: targetListIds,
				...(sendAt ? { send_at: sendAt } : {}),
			};

			if (templateId) {
				body.template_id = templateId;
			}

			const fromEmail = opts.from_email as string | undefined;
			if (fromEmail) {
				body.from_email = fromEmail;
			}

			const altBody = opts.alt_body as string | undefined;
			if (altBody) {
				body.altbody = altBody;
			}

			const tags = opts.tags as string[] | undefined;
			if (tags && tags.length > 0) {
				body.tags = tags;
			}

			const headers = opts.headers as Record<string, string> | undefined;
			if (headers) {
				// The official example is an array of JSON key/value objects, e.g.
				// [{ "x-custom-header": "value" }], not `{ key, value }` records.
				body.headers = Object.entries(headers).map(([key, value]) => ({
					[key]: value,
				}));
			}

			const createRes = await fetch(`${instanceUrl}/api/campaigns`, {
				method: "POST",
				headers: {
					Authorization: authHeader,
					"Content-Type": "application/json",
				},
				redirect: "error",
				body: JSON.stringify(body),
			});

			if (!createRes.ok) {
				const err = (await createRes.json().catch(() => ({}))) as {
					message?: string;
				};
				const detail = err?.message ?? createRes.statusText;
				const raw = `HTTP ${createRes.status}\n${JSON.stringify(err)}`;

				if (createRes.status === 401) {
					throw new PublishError(
						`TOKEN_EXPIRED: ListMonk credentials invalid: ${detail}`,
						{ statusCode: createRes.status, detail: raw },
					);
				}
				throw new PublishError(
					`ListMonk create campaign failed (${createRes.status}): ${detail}`,
					{ statusCode: createRes.status, detail: raw },
				);
			}

			const created = (await createRes.json()) as {
				data?: { id?: number; uuid?: string };
			};
			const campaignId = created.data?.id;
			if (!campaignId) {
				throw new Error("ListMonk: No campaign ID returned");
			}

			// Step 2: Start or schedule the campaign.
			// Official docs: https://listmonk.app/docs/apis/campaigns/
			// Section "PUT /api/campaigns/{campaign_id}/status" -> the request body
			// contains only `status`; `send_at` belongs to campaign creation above.
			const targetStatus = sendAt ? "scheduled" : "running";
			const statusRes = await fetch(
				`${instanceUrl}/api/campaigns/${campaignId}/status`,
				{
					method: "PUT",
					headers: {
						Authorization: authHeader,
						"Content-Type": "application/json",
					},
					redirect: "error",
					body: JSON.stringify({ status: targetStatus }),
				},
			);

			if (!statusRes.ok) {
				const err = (await statusRes.json().catch(() => ({}))) as {
					message?: string;
				};
				const raw = `HTTP ${statusRes.status}\n${JSON.stringify(err)}`;
				throw new PublishError(
					`ListMonk start campaign failed: ${err?.message ?? statusRes.statusText}`,
					{ statusCode: statusRes.status, detail: raw },
				);
			}

			return {
				success: true,
				platform_post_id: String(campaignId),
				platform_url: `${instanceUrl}/campaigns/${campaignId}`,
				provider_outcome: {
					disposition: sendAt ? "scheduled" : "processing",
					provider_operation_id: String(campaignId),
					platform_post_id: String(campaignId),
					platform_url: `${instanceUrl}/campaigns/${campaignId}`,
					provider_state: targetStatus,
					next_reconcile_at: sendAt,
				},
			};
		} catch (err) {
			return classifyPublishError(err, { definitiveHttpRejection: true });
		}
	},
};
