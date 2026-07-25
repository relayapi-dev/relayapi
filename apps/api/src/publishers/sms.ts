import {
	classifyPublishError,
	type ProviderEffect,
	type Publisher,
	type PublishRequest,
	type PublishResult,
} from "./types";

/**
 * SMS publisher via Twilio.
 *
 * Users bring their own Twilio credentials:
 * - account.access_token = Twilio Auth Token
 * - account.platform_account_id = Twilio Account SID
 *
 * target_options:
 * - phone_numbers: string[] — recipients (required)
 * - from_number: string — Twilio phone number e.g. +15017122661 (required)
 */

const TWILIO_API = "https://api.twilio.com/2010-04-01";

export const smsPublisher: Publisher = {
	platform: "sms",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const accountSid = request.account.platform_account_id;
			const authToken = request.account.access_token;
			const opts = request.target_options;

			const fromNumber = opts.from_number as string | undefined;

			if (!fromNumber) {
				throw new Error(
					"Missing from_number. Provide it in target_options or account metadata.",
				);
			}

			const phoneNumbers = opts.phone_numbers as string[] | undefined;
			if (!phoneNumbers || phoneNumbers.length === 0) {
				throw new Error(
					"Missing phone_numbers in target_options. Provide at least one recipient.",
				);
			}

			const body = (opts.content as string) ?? request.content ?? "";
			// Official docs: https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource
			// Request body field `Body` has a maximum of 1,600 characters.
			if (body.length > 1600) {
				return {
					success: false,
					error: {
						code: "CONTENT_TOO_LONG",
						message: `SMS body is ${body.length} characters. Twilio limit is 1,600.`,
					},
				};
			}

			// Handle media (MMS) — Twilio supports up to 10 MediaUrl per message
			const media = (opts.media as Array<{ url: string }>) ?? request.media;
			// Same official section, request field `MediaUrl`: up to 10 values.
			if (media.length > 10) {
				return {
					success: false,
					error: {
						code: "TOO_MANY_MEDIA",
						message: `Twilio MMS supports at most 10 media URLs; received ${media.length}.`,
					},
				};
			}
			const mediaUrls = media.map((m) => m.url);

			// Twilio requires either a Body or at least one MediaUrl
			if (!body && mediaUrls.length === 0) {
				throw new Error(
					"SMS requires either a body or at least one media URL.",
				);
			}

			// Basic auth: Account SID : Auth Token
			const credentials = btoa(`${accountSid}:${authToken}`);

			const results: Array<{
				phone: string;
				sid: string | null;
				status: string | null;
				error: string | null;
			}> = [];

			for (const phone of phoneNumbers) {
				const params = new URLSearchParams({
					To: phone,
					From: fromNumber,
				});
				// Body is optional for MMS (media-only messages)
				if (body) {
					params.set("Body", body);
				}

				// Add media URLs for MMS
				for (const url of mediaUrls) {
					params.append("MediaUrl", url);
				}

				// Twilio Messages API: Send an SMS/MMS message
				// Docs: https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource
				const res = await fetch(
					`${TWILIO_API}/Accounts/${accountSid}/Messages.json`,
					{
						method: "POST",
						headers: {
							Authorization: `Basic ${credentials}`,
							"Content-Type": "application/x-www-form-urlencoded",
						},
						body: params.toString(),
					},
				);

				if (res.ok) {
					const data = (await res.json()) as { sid?: string; status?: string };
					if (data.sid?.trim()) {
						results.push({
							phone,
							sid: data.sid,
							status: data.status ?? "accepted",
							error: null,
						});
					} else {
						results.push({
							phone,
							sid: null,
							status: data.status ?? "accepted_without_sid",
							error: "Twilio response did not include a Message SID",
						});
					}
				} else {
					const err = (await res.json().catch(() => ({}))) as {
						code?: number;
						message?: string;
					};
					results.push({
						phone,
						sid: null,
						status: "rejected",
						error: err.code
							? `[${err.code}] ${err.message ?? "Unknown error"}`
							: (err.message ?? `HTTP ${res.status}`),
					});
				}
			}

			const sent = results.filter((r) => r.sid !== null).length;
			const unknown = results.filter(
				(result) => result.status === "accepted_without_sid",
			).length;
			const effects: ProviderEffect[] = results.map((result, index) => ({
				name: `recipient_${index + 1}`,
				status: result.sid
					? "succeeded"
					: result.status === "accepted_without_sid"
						? "outcome_unknown"
						: "failed",
				...(result.sid ? { provider_id: result.sid } : {}),
				...(result.error
					? {
							error: {
								code: "SMS_DELIVERY_REJECTED",
								message: result.error,
							},
						}
					: {}),
			}));

			if (sent === 0 && unknown > 0) {
				return {
					success: false,
					provider_outcome: {
						disposition: "outcome_unknown",
						provider_state: `${unknown}_accepted_without_sid`,
						effects,
					},
					error: {
						code: "PUBLISH_OUTCOME_UNKNOWN",
						message:
							"Twilio accepted at least one message without returning its Message SID.",
					},
				};
			}

			if (sent === 0) {
				return {
					success: false,
					provider_outcome: {
						disposition: "failed",
						provider_state: "all_rejected",
						effects,
					},
					error: {
						code: "SMS_DELIVERY_REJECTED",
						message: `All SMS failed. First error: ${results[0]?.error ?? "Unknown"}`,
					},
				};
			}

			const successful = results.filter(
				(result): result is typeof result & { sid: string } =>
					result.sid !== null,
			);
			const onlyId = successful.length === 1 ? successful[0]?.sid : undefined;
			if (sent !== results.length) {
				return {
					success: false,
					platform_post_id: onlyId,
					provider_outcome: {
						disposition: "partial",
						platform_post_id: onlyId,
						provider_state: `${sent}_accepted_${results.length - sent}_rejected`,
						effects,
					},
					error: {
						code: "PARTIAL_DELIVERY",
						message: `${sent} of ${results.length} Twilio messages were accepted.`,
					},
				};
			}

			const statuses = successful.map((result) =>
				(result.status ?? "accepted").toLowerCase(),
			);
			const disposition = statuses.every((status) => status === "delivered")
				? ("delivered" as const)
				: statuses.every(
							(status) => status === "sent" || status === "delivered",
						)
					? ("sent" as const)
					: ("accepted" as const);

			return {
				success: true,
				platform_post_id: onlyId,
				platform_url: undefined,
				provider_outcome: {
					disposition,
					platform_post_id: onlyId,
					provider_operation_id: onlyId,
					provider_state: [...new Set(statuses)].join(","),
					effects,
				},
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
