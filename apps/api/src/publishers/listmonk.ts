import { fetchPublicUrl } from "../lib/fetch-public-url";
import {
	listmonkApiUrl,
	parseListmonkInstanceUrl,
} from "../lib/listmonk-instance";
import { readPublisherJson, readPublisherText } from "./provider-response";
import {
	classifyPublishError,
	getSucceededProviderEffect,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
	type ReconcileRequest,
	recordProviderEffect,
} from "./types";

/**
 * ListMonk publisher.
 * Creates and sends a campaign via a self-hosted ListMonk instance.
 * Basic auth credentials in access_token (base64), instance URL in metadata.
 *
 * ListMonk API:
 * Docs: https://listmonk.app/docs/apis/campaigns/
 */

const LISTMONK_RESPONSE_MAX_BYTES = 512 * 1024;

function listmonkFetch(
	instanceUrl: string,
	path: string,
	authorization: string,
	init: RequestInit = {},
): Promise<Response> {
	return fetchPublicUrl(listmonkApiUrl(instanceUrl, path), {
		...init,
		redirect: "error",
		timeout: 30_000,
		timeoutThroughBody: true,
		maxBytes: LISTMONK_RESPONSE_MAX_BYTES,
		headers: {
			Authorization: authorization,
			...(init.headers ?? {}),
		},
	});
}

function connectedListmonkInstance(account: PublishRequest["account"]): string {
	try {
		return parseListmonkInstanceUrl(account.platform_account_id);
	} catch {
		throw new PublishError(
			"This Listmonk connection has no valid immutable instance URL. Reconnect the account before publishing.",
			{ code: "ACCOUNT_RECONNECT_REQUIRED" },
		);
	}
}

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
			const instanceUrl = connectedListmonkInstance(request.account);
			if (!campaignId || !instanceUrl || !request.account.access_token) {
				throw new Error(
					"CONTENT_ERROR: Listmonk reconciliation requires a campaign ID, instance URL, and credentials.",
				);
			}
			const response = await listmonkFetch(
				instanceUrl,
				`/api/campaigns/${encodeURIComponent(campaignId)}`,
				`Basic ${request.account.access_token}`,
			);
			if (!response.ok) {
				const body = await readPublisherText(response);
				throw new PublishError(
					`Listmonk campaign status failed (${response.status})`,
					{ statusCode: response.status, detail: body },
				);
			}
			const data = (await readPublisherJson(response)) as {
				data?: ListmonkCampaignState;
			};
			const result = listmonkCampaignResult(instanceUrl, data.data ?? {});
			if (
				request.provider_state?.startsWith("partial:") &&
				result.provider_outcome?.disposition === "accepted"
			) {
				return {
					success: false,
					platform_post_id: result.platform_post_id,
					platform_url: result.platform_url,
					provider_outcome: {
						disposition: "failed",
						provider_operation_id: campaignId,
						platform_post_id: result.platform_post_id,
						platform_url: result.platform_url,
						provider_state: request.provider_state,
						effects: request.effects,
					},
					error: {
						code: "LISTMONK_PARTIAL_OPERATION",
						message:
							"Listmonk created the campaign but the requested start/schedule step did not complete.",
					},
				};
			}
			return result;
		} catch (err) {
			return classifyPublishError(err);
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		let createdCampaignId = getSucceededProviderEffect(
			request,
			"campaign_created",
		)?.provider_id;
		let createdCampaignUrl: string | undefined;
		try {
			const authToken = request.account.access_token; // base64(user:pass)
			const instanceUrl = connectedListmonkInstance(request.account);
			const opts = request.target_options;
			const media = Array.isArray(opts.media) ? opts.media : request.media;
			if (media.length > 0) {
				return {
					success: false,
					error: {
						code: "UNSUPPORTED_MEDIA_TYPE",
						message:
							"Listmonk campaigns accept text or HTML content; Relay media attachments are not supported.",
					},
				};
			}
			if (createdCampaignId) {
				createdCampaignUrl = `${instanceUrl}/campaigns/${createdCampaignId}`;
			}

			if (!authToken || !instanceUrl) {
				throw new Error(
					"CONTENT_ERROR: ListMonk credentials and instance URL are required.",
				);
			}

			const authHeader = `Basic ${authToken}`;
			const subject =
				(opts.subject as string) ??
				(request.content?.split("\n")[0]?.slice(0, 100) || "Newsletter Update");
			const contentHtml =
				(opts.content_html as string) ?? wrapInHtml(request.content ?? "");
			const listId = opts.list_id;
			const templateId = opts.template_id;
			for (const [name, value] of [
				["list_id", listId],
				["template_id", templateId],
			] as const) {
				if (
					value !== undefined &&
					(typeof value !== "number" ||
						!Number.isSafeInteger(value) ||
						value < 1)
				) {
					return {
						success: false,
						error: {
							code: "INVALID_LISTMONK_ID",
							message: `Listmonk ${name} must be a positive integer.`,
						},
					};
				}
			}
			const sendAt = opts.send_at as string | undefined;

			// Find a list if not specified
			let targetListIds: number[] = typeof listId === "number" ? [listId] : [];
			if (targetListIds.length === 0) {
				// ListMonk API: Get Lists
				// Docs: https://listmonk.app/docs/apis/lists/
				const listsRes = await listmonkFetch(
					instanceUrl,
					"/api/lists?per_page=1",
					authHeader,
				);
				if (listsRes.ok) {
					const lists = (await readPublisherJson(listsRes)) as {
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

			if (typeof templateId === "number") {
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

			if (!createdCampaignId) {
				const createRes = await listmonkFetch(
					instanceUrl,
					"/api/campaigns",
					authHeader,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify(body),
					},
				);

				if (!createRes.ok) {
					const err = (await readPublisherJson(createRes).catch(
						() => ({}),
					)) as {
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

				const created = (await readPublisherJson(createRes)) as {
					data?: { id?: number; uuid?: string };
				};
				const campaignId = created.data?.id;
				if (!campaignId) {
					throw new Error("ListMonk: No campaign ID returned");
				}
				createdCampaignId = String(campaignId);
				createdCampaignUrl = `${instanceUrl}/campaigns/${campaignId}`;
				await recordProviderEffect(request, {
					name: "campaign_created",
					status: "succeeded",
					provider_id: createdCampaignId,
				});
			}
			const campaignId = Number(createdCampaignId);
			if (!Number.isSafeInteger(campaignId) || campaignId < 1) {
				throw new Error("ListMonk: Recorded campaign ID is invalid");
			}

			// Step 2: Start or schedule the campaign.
			// Official docs: https://listmonk.app/docs/apis/campaigns/
			// Section "PUT /api/campaigns/{campaign_id}/status" -> the request body
			// contains only `status`; `send_at` belongs to campaign creation above.
			const targetStatus = sendAt ? "scheduled" : "running";
			const statusRes = getSucceededProviderEffect(request, "start_or_schedule")
				? null
				: await listmonkFetch(
						instanceUrl,
						`/api/campaigns/${campaignId}/status`,
						authHeader,
						{
							method: "PUT",
							headers: {
								"Content-Type": "application/json",
							},
							body: JSON.stringify({ status: targetStatus }),
						},
					);

			if (statusRes && !statusRes.ok) {
				const err = (await readPublisherJson(statusRes).catch(() => ({}))) as {
					message?: string;
				};
				const raw = `HTTP ${statusRes.status}\n${JSON.stringify(err)}`;
				throw new PublishError(
					`ListMonk start campaign failed: ${err?.message ?? statusRes.statusText}`,
					{ statusCode: statusRes.status, detail: raw },
				);
			}
			if (statusRes) {
				await recordProviderEffect(request, {
					name: "start_or_schedule",
					status: "succeeded",
					provider_id: String(campaignId),
				});
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
			const result = classifyPublishError(err, {
				definitiveHttpRejection: createdCampaignId === undefined,
			});
			if (createdCampaignId) {
				return {
					...result,
					success: false,
					platform_post_id: createdCampaignId,
					platform_url: createdCampaignUrl,
					provider_outcome: {
						disposition: "partial",
						provider_operation_id: createdCampaignId,
						platform_post_id: createdCampaignId,
						platform_url: createdCampaignUrl,
						provider_state: "partial:campaign_created",
						effects: [
							{
								name: "campaign_created",
								status: "succeeded",
								provider_id: createdCampaignId,
							},
							{
								name: "start_or_schedule",
								status: "outcome_unknown",
								...(result.error ? { error: result.error } : {}),
							},
						],
					},
				};
			}
			return result;
		}
	},
};
