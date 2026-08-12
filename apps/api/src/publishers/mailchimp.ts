import { buildMailchimpApiUrl, getMailchimpDatacenter } from "../lib/mailchimp";
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
 * Mailchimp publisher.
 * Creates and sends a campaign via the Mailchimp Marketing API.
 * The API key and its validated datacenter suffix come from access_token.
 *
 * Mailchimp Marketing API:
 * Docs: https://mailchimp.com/developer/marketing/api/
 */

function wrapInHtml(text: string): string {
	return text
		.split("\n\n")
		.map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
		.join("");
}

const MAILCHIMP_SCHEDULE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Official schema: https://us1.api.mailchimp.com/schema/3.0/Definitions/Campaigns/Actions/Schedule.json
 * Field `schedule_time` says campaigns may only be scheduled on the
 * quarter-hour (:00, :15, :30, :45). Round forward so delivery is never moved
 * earlier than the caller requested.
 */
export function normalizeMailchimpScheduleTime(value: string): string {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) {
		throw new Error(
			"CONTENT_ERROR: Mailchimp schedule_time must be a valid ISO 8601 date-time.",
		);
	}
	const rounded =
		Math.ceil(timestamp / MAILCHIMP_SCHEDULE_INTERVAL_MS) *
		MAILCHIMP_SCHEDULE_INTERVAL_MS;
	return new Date(rounded).toISOString();
}

interface MailchimpCampaignState {
	id?: string;
	archive_url?: string;
	status?: string;
}

function mailchimpCampaignResult(
	campaign: MailchimpCampaignState,
): PublishResult {
	const campaignId = campaign.id?.trim();
	if (!campaignId) {
		return {
			success: false,
			provider_outcome: {
				disposition: "outcome_unknown",
				provider_state: campaign.status ?? "missing_campaign_id",
			},
			error: {
				code: "PLATFORM_ERROR",
				message: "Mailchimp campaign response did not include an ID.",
			},
		};
	}

	const state = campaign.status?.toLowerCase() ?? "unknown";
	const shared = {
		provider_operation_id: campaignId,
		platform_post_id: campaignId,
		platform_url: campaign.archive_url,
		provider_state: state,
	};
	if (state === "sent") {
		return {
			success: true,
			platform_post_id: campaignId,
			platform_url: campaign.archive_url,
			provider_outcome: { disposition: "sent", ...shared },
		};
	}
	if (state === "schedule") {
		return {
			success: true,
			platform_post_id: campaignId,
			platform_url: campaign.archive_url,
			provider_outcome: { disposition: "scheduled", ...shared },
		};
	}
	if (state === "sending") {
		return {
			success: true,
			platform_post_id: campaignId,
			platform_url: campaign.archive_url,
			provider_outcome: { disposition: "processing", ...shared },
		};
	}
	if (state === "canceling") {
		return {
			success: true,
			platform_post_id: campaignId,
			platform_url: campaign.archive_url,
			provider_outcome: { disposition: "processing", ...shared },
		};
	}
	if (state === "canceled" || state === "cancelled" || state === "archived") {
		return {
			success: false,
			platform_post_id: campaignId,
			platform_url: campaign.archive_url,
			provider_outcome: { disposition: "failed", ...shared },
			error: {
				code: "MAILCHIMP_CAMPAIGN_NOT_SENT",
				message: `Mailchimp campaign ended with status ${state}.`,
			},
		};
	}
	if (state === "save" || state === "paused") {
		return {
			success: true,
			platform_post_id: campaignId,
			platform_url: campaign.archive_url,
			provider_outcome: { disposition: "accepted", ...shared },
		};
	}
	return {
		success: false,
		platform_post_id: campaignId,
		platform_url: campaign.archive_url,
		provider_outcome: {
			disposition: "outcome_unknown",
			...shared,
		},
		error: {
			code: "PLATFORM_ERROR",
			message: `Mailchimp returned an unrecognized campaign status: ${state}`,
		},
	};
}

export const mailchimpPublisher: Publisher = {
	platform: "mailchimp",

	async reconcile(request: ReconcileRequest): Promise<PublishResult> {
		try {
			const campaignId =
				request.platform_post_id ?? request.provider_operation_id;
			const apiKey = request.account.access_token;
			const datacenter = apiKey ? getMailchimpDatacenter(apiKey) : null;
			if (!campaignId || !apiKey || !datacenter) {
				throw new Error(
					"CONTENT_ERROR: Mailchimp reconciliation requires a campaign ID and valid API key.",
				);
			}
			const response = await fetch(
				buildMailchimpApiUrl(
					datacenter,
					`/3.0/campaigns/${encodeURIComponent(campaignId)}`,
				),
				{
					headers: { Authorization: `Basic ${btoa(`relayapi:${apiKey}`)}` },
				},
			);
			if (!response.ok) {
				const body = await readPublisherText(response);
				throw new PublishError(
					`Mailchimp campaign status failed (${response.status})`,
					{ statusCode: response.status, detail: body },
				);
			}
			const result = mailchimpCampaignResult(
				(await readPublisherJson(response)) as MailchimpCampaignState,
			);
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
						code: "MAILCHIMP_PARTIAL_OPERATION",
						message:
							"Mailchimp created the campaign but the requested content/send step did not complete.",
					},
				};
			}
			return result;
		} catch (err) {
			return classifyPublishError(err);
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		let campaignId = getSucceededProviderEffect(
			request,
			"campaign_created",
		)?.provider_id;
		let campaignUrl: string | undefined;
		let completedStage: "campaign_created" | "content_set" | undefined =
			campaignId
				? getSucceededProviderEffect(request, "content_set")
					? "content_set"
					: "campaign_created"
				: undefined;
		try {
			const apiKey = request.account.access_token;
			const datacenter = apiKey ? getMailchimpDatacenter(apiKey) : null;
			const opts = request.target_options;
			const media = Array.isArray(opts.media) ? opts.media : request.media;
			if (media.length > 0) {
				return {
					success: false,
					error: {
						code: "UNSUPPORTED_MEDIA_TYPE",
						message:
							"Mailchimp campaigns accept text or HTML content; Relay media attachments are not supported.",
					},
				};
			}

			if (!apiKey || !datacenter) {
				throw new Error(
					"CONTENT_ERROR: A Mailchimp API key with a valid datacenter suffix is required.",
				);
			}

			const authHeader = `Basic ${btoa(`relayapi:${apiKey}`)}`;

			const subject =
				(opts.subject as string) ??
				(request.content?.split("\n")[0]?.slice(0, 100) || "Newsletter Update");
			const previewText = (opts.preview_text as string) ?? "";
			const listId = opts.list_id as string | undefined;
			const contentHtml =
				(opts.content_html as string) ?? wrapInHtml(request.content ?? "");

			// Step 1: Find a list if not specified
			let targetListId = listId;
			if (!targetListId) {
				// Mailchimp API: Get Lists
				// Docs: https://mailchimp.com/developer/marketing/api/lists/get-lists-info/
				const listsRes = await fetch(
					buildMailchimpApiUrl(datacenter, "/3.0/lists?count=1"),
					{
						headers: { Authorization: authHeader },
					},
				);
				if (listsRes.ok) {
					const lists = (await readPublisherJson(listsRes)) as {
						lists?: Array<{ id: string }>;
					};
					targetListId = lists.lists?.[0]?.id;
				}
			}

			if (!targetListId) {
				throw new Error(
					"CONTENT_ERROR: No Mailchimp audience/list found. Create one or specify list_id.",
				);
			}

			const replyTo = (opts.from_email as string) ?? (opts.reply_to as string);
			if (!replyTo) {
				throw new Error(
					"CONTENT_ERROR: from_email is required for Mailchimp campaigns. Set it in target_options.",
				);
			}

			// Step 2: Create a campaign
			// Docs: https://mailchimp.com/developer/marketing/api/campaigns/add-campaign/
			let campaign: {
				id?: string;
				archive_url?: string;
				status?: string;
			} = { id: campaignId };
			if (!campaignId) {
				const campaignRes = await fetch(
					buildMailchimpApiUrl(datacenter, "/3.0/campaigns"),
					{
						method: "POST",
						headers: {
							Authorization: authHeader,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							type: "regular",
							recipients: { list_id: targetListId },
							settings: {
								subject_line: subject,
								preview_text: previewText,
								from_name: (opts.from_name as string) ?? "Newsletter",
								reply_to: replyTo,
							},
						}),
					},
				);

				if (!campaignRes.ok) {
					const err = (await readPublisherJson(campaignRes).catch(
						() => ({}),
					)) as {
						detail?: string;
						title?: string;
					};
					const detail = err?.detail ?? err?.title ?? campaignRes.statusText;
					const raw = `HTTP ${campaignRes.status}\n${JSON.stringify(err)}`;

					if (campaignRes.status === 401) {
						throw new PublishError(
							`TOKEN_EXPIRED: Mailchimp API key invalid: ${detail}`,
							{ statusCode: campaignRes.status, detail: raw },
						);
					}
					if (campaignRes.status === 429) {
						throw new PublishError(`RATE_LIMITED: ${detail}`, {
							statusCode: campaignRes.status,
							detail: raw,
						});
					}
					throw new PublishError(
						`Mailchimp create campaign failed (${campaignRes.status}): ${detail}`,
						{ statusCode: campaignRes.status, detail: raw },
					);
				}

				campaign = (await readPublisherJson(campaignRes)) as typeof campaign;
				campaignId = campaign.id;
				if (!campaignId) {
					throw new Error("Mailchimp: No campaign ID returned");
				}
				campaignUrl = campaign.archive_url;
				await recordProviderEffect(request, {
					name: "campaign_created",
					status: "succeeded",
					provider_id: campaignId,
				});
				completedStage = "campaign_created";
			}

			// Step 3: Set campaign content
			// Docs: https://mailchimp.com/developer/marketing/api/campaign-content/set-campaign-content/
			if (!getSucceededProviderEffect(request, "content_set")) {
				const contentRes = await fetch(
					buildMailchimpApiUrl(
						datacenter,
						`/3.0/campaigns/${encodeURIComponent(campaignId)}/content`,
					),
					{
						method: "PUT",
						headers: {
							Authorization: authHeader,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ html: contentHtml }),
					},
				);

				if (!contentRes.ok) {
					const err = (await readPublisherJson(contentRes).catch(
						() => ({}),
					)) as {
						detail?: string;
					};
					const raw = `HTTP ${contentRes.status}\n${JSON.stringify(err)}`;
					throw new PublishError(
						`Mailchimp set content failed: ${err?.detail ?? contentRes.statusText}`,
						{ statusCode: contentRes.status, detail: raw },
					);
				}
				await recordProviderEffect(request, {
					name: "content_set",
					status: "succeeded",
					provider_id: campaignId,
				});
			}
			completedStage = "content_set";

			// Step 4: Send or schedule the campaign
			const requestedScheduleTime = opts.schedule_time as string | undefined;
			const scheduleTime = requestedScheduleTime
				? normalizeMailchimpScheduleTime(requestedScheduleTime)
				: undefined;
			if (getSucceededProviderEffect(request, "send_or_schedule")) {
				// The mutation was already accepted before a retry/crash.
			} else if (scheduleTime) {
				// Mailchimp API: Schedule Campaign
				// Endpoint: POST /campaigns/{campaign_id}/actions/schedule
				// Docs: https://mailchimp.com/developer/marketing/api/campaigns/schedule-campaign/
				const scheduleRes = await fetch(
					buildMailchimpApiUrl(
						datacenter,
						`/3.0/campaigns/${encodeURIComponent(campaignId)}/actions/schedule`,
					),
					{
						method: "POST",
						headers: {
							Authorization: authHeader,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ schedule_time: scheduleTime }),
					},
				);

				if (!scheduleRes.ok) {
					const err = (await readPublisherJson(scheduleRes).catch(
						() => ({}),
					)) as {
						detail?: string;
					};
					const raw = `HTTP ${scheduleRes.status}\n${JSON.stringify(err)}`;
					throw new PublishError(
						`Mailchimp schedule failed: ${err?.detail ?? scheduleRes.statusText}`,
						{ statusCode: scheduleRes.status, detail: raw },
					);
				}
				await recordProviderEffect(request, {
					name: "send_or_schedule",
					status: "succeeded",
					provider_id: campaignId,
				});
			} else {
				// Docs: https://mailchimp.com/developer/marketing/api/campaigns/send-campaign/
				const sendRes = await fetch(
					buildMailchimpApiUrl(
						datacenter,
						`/3.0/campaigns/${encodeURIComponent(campaignId)}/actions/send`,
					),
					{
						method: "POST",
						headers: { Authorization: authHeader },
					},
				);

				if (!sendRes.ok) {
					const err = (await readPublisherJson(sendRes).catch(() => ({}))) as {
						detail?: string;
					};
					const raw = `HTTP ${sendRes.status}\n${JSON.stringify(err)}`;
					throw new PublishError(
						`Mailchimp send failed: ${err?.detail ?? sendRes.statusText}`,
						{ statusCode: sendRes.status, detail: raw },
					);
				}
				await recordProviderEffect(request, {
					name: "send_or_schedule",
					status: "succeeded",
					provider_id: campaignId,
				});
			}

			return {
				success: true,
				platform_post_id: campaignId,
				platform_url: campaign.archive_url,
				provider_outcome: {
					disposition: scheduleTime ? "scheduled" : "accepted",
					provider_operation_id: campaignId,
					platform_post_id: campaignId,
					platform_url: campaign.archive_url,
					provider_state: scheduleTime ? "schedule" : "send_requested",
					next_reconcile_at: scheduleTime,
				},
			};
		} catch (err) {
			const result = classifyPublishError(err, {
				definitiveHttpRejection: campaignId === undefined,
			});
			if (campaignId && completedStage) {
				return {
					...result,
					success: false,
					platform_post_id: campaignId,
					platform_url: campaignUrl,
					provider_outcome: {
						disposition: "partial",
						provider_operation_id: campaignId,
						platform_post_id: campaignId,
						platform_url: campaignUrl,
						provider_state: `partial:${completedStage}`,
						effects: [
							{
								name: "campaign_created",
								status: "succeeded",
								provider_id: campaignId,
							},
							...(completedStage === "content_set"
								? ([
										{
											name: "content_set",
											status: "succeeded" as const,
											provider_id: campaignId,
										},
									] as const)
								: []),
							{
								name:
									completedStage === "campaign_created"
										? "content_set"
										: "send_or_schedule",
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
