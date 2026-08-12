import { mapConcurrently } from "../lib/concurrency";
import { readResponseJson } from "../lib/fetch-public-url";
import {
	classifyPublishError,
	getSucceededProviderEffect,
	type ProviderEffect,
	type Publisher,
	type PublishRequest,
	type PublishResult,
	type ReconcileRequest,
	recordProviderEffect,
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
const TWILIO_RESPONSE_MAX_BYTES = 256 * 1024;

interface TwilioMessageStatus {
	sid?: string;
	status?: string;
	error_code?: number | null;
	error_message?: string | null;
}

function twilioStatusKind(
	status: string,
): "delivered" | "sent" | "pending" | "failed" | "unknown" {
	switch (status.toLowerCase()) {
		case "delivered":
		case "read":
			return "delivered";
		case "sent":
			return "sent";
		case "accepted":
		case "scheduled":
		case "queued":
		case "sending":
			return "pending";
		case "failed":
		case "undelivered":
		case "canceled":
			return "failed";
		default:
			return "unknown";
	}
}

async function fetchTwilioMessageStatus(
	accountSid: string,
	authToken: string,
	messageSid: string,
): Promise<TwilioMessageStatus> {
	const credentials = btoa(`${accountSid}:${authToken}`);
	const res = await fetch(
		`${TWILIO_API}/Accounts/${encodeURIComponent(accountSid)}/Messages/${encodeURIComponent(messageSid)}.json`,
		{ headers: { Authorization: `Basic ${credentials}` } },
	);
	const data = await readResponseJson<
		TwilioMessageStatus & { code?: number; message?: string }
	>(res, TWILIO_RESPONSE_MAX_BYTES).catch(
		(): TwilioMessageStatus & { code?: number; message?: string } => ({}),
	);
	if (!res.ok) {
		throw new Error(
			`Twilio message status failed (${res.status}): ${data.message ?? res.statusText}`,
		);
	}
	return data;
}

export const smsPublisher: Publisher = {
	platform: "sms",

	async reconcile(request: ReconcileRequest): Promise<PublishResult> {
		const messageIds = [
			...request.effects.flatMap((effect) =>
				effect.provider_id?.trim() ? [effect.provider_id.trim()] : [],
			),
			...(request.provider_operation_id?.trim()
				? [request.provider_operation_id.trim()]
				: []),
			...(request.platform_post_id?.trim()
				? [request.platform_post_id.trim()]
				: []),
		].filter((id, index, all) => all.indexOf(id) === index);
		if (messageIds.length === 0) {
			return {
				success: false,
				provider_outcome: { disposition: "outcome_unknown" },
				error: {
					code: "MISSING_PROVIDER_OPERATION_ID",
					message: "Twilio reconciliation requires at least one Message SID.",
				},
			};
		}

		try {
			const statuses = await mapConcurrently(messageIds, 4, (id) =>
				fetchTwilioMessageStatus(
					request.account.platform_account_id,
					request.account.access_token,
					id,
				),
			);
			const kinds = statuses.map((item) =>
				twilioStatusKind(item.status ?? "unknown"),
			);
			const effects: ProviderEffect[] = statuses.map((item, index) => {
				const kind = kinds[index];
				const failed = kind === "failed";
				return {
					name: request.effects[index]?.name ?? `recipient_${index + 1}`,
					status: failed
						? "failed"
						: kind === "unknown" || kind === "pending"
							? "outcome_unknown"
							: "succeeded",
					provider_id: item.sid ?? messageIds[index],
					...(failed
						? {
								error: {
									code: item.error_code
										? `TWILIO_${item.error_code}`
										: "SMS_DELIVERY_FAILED",
									message:
										item.error_message ??
										`Twilio message entered ${item.status ?? "failed"} state.`,
								},
							}
						: {}),
				};
			});
			const providerState = statuses
				.map((item) => item.status ?? "unknown")
				.join(",");
			const onlyId = messageIds.length === 1 ? messageIds[0] : undefined;
			const failedCount = kinds.filter((kind) => kind === "failed").length;
			const unknownCount = kinds.filter((kind) => kind === "unknown").length;

			if (failedCount === kinds.length) {
				return {
					success: false,
					platform_post_id: onlyId,
					provider_outcome: {
						disposition: "failed",
						provider_operation_id: onlyId,
						platform_post_id: onlyId,
						provider_state: providerState,
						effects,
					},
					error: {
						code: "SMS_DELIVERY_FAILED",
						message: "Twilio reports that every message failed delivery.",
					},
				};
			}
			if (failedCount > 0) {
				return {
					success: false,
					platform_post_id: onlyId,
					provider_outcome: {
						disposition: "partial",
						provider_operation_id: onlyId,
						platform_post_id: onlyId,
						provider_state: providerState,
						effects,
					},
					error: {
						code: "PARTIAL_DELIVERY",
						message: `${failedCount} of ${kinds.length} Twilio messages failed delivery.`,
					},
				};
			}
			if (unknownCount > 0) {
				return {
					success: false,
					platform_post_id: onlyId,
					provider_outcome: {
						disposition: "outcome_unknown",
						provider_operation_id: onlyId,
						platform_post_id: onlyId,
						provider_state: providerState,
						effects,
					},
					error: {
						code: "PUBLISH_OUTCOME_UNKNOWN",
						message: "Twilio returned an undocumented message status.",
					},
				};
			}
			if (kinds.some((kind) => kind === "pending")) {
				return {
					success: true,
					platform_post_id: onlyId,
					provider_outcome: {
						disposition: "accepted",
						provider_operation_id: onlyId,
						platform_post_id: onlyId,
						provider_state: providerState,
						effects,
					},
				};
			}
			const disposition = kinds.every((kind) => kind === "delivered")
				? ("delivered" as const)
				: ("sent" as const);
			return {
				success: true,
				platform_post_id: onlyId,
				provider_outcome: {
					disposition,
					provider_operation_id: onlyId,
					platform_post_id: onlyId,
					provider_state: providerState,
					effects,
				},
			};
		} catch (error) {
			const result = classifyPublishError(error);
			return {
				...result,
				provider_outcome: {
					disposition: "outcome_unknown",
					provider_operation_id:
						messageIds.length === 1 ? messageIds[0] : undefined,
					platform_post_id: request.platform_post_id ?? undefined,
					provider_state: request.provider_state ?? undefined,
					effects: request.effects,
				},
			};
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const accountSid = request.account.platform_account_id;
			const authToken = request.account.access_token;
			const opts = request.target_options;

			const fromNumber =
				(request.account.metadata?.from_number as string | undefined) ??
				(request.account.metadata?.default_from_number as string | undefined);

			if (!fromNumber) {
				throw new Error(
					"Missing the connector-verified SMS sender. Reconnect this Twilio account.",
				);
			}
			if (
				typeof opts.from_number === "string" &&
				opts.from_number.trim() !== fromNumber
			) {
				return {
					success: false,
					error: {
						code: "SMS_SENDER_MISMATCH",
						message:
							"target_options.from_number does not match the sender verified by this SMS connection.",
					},
				};
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

			for (const [recipientIndex, phone] of phoneNumbers.entries()) {
				const effectName = `recipient_${recipientIndex + 1}`;
				const confirmed = getSucceededProviderEffect(request, effectName);
				if (confirmed?.provider_id) {
					results.push({
						phone,
						sid: confirmed.provider_id,
						status: "accepted",
						error: null,
					});
					continue;
				}
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
					const data = await readResponseJson<{
						sid?: string;
						status?: string;
					}>(res, TWILIO_RESPONSE_MAX_BYTES);
					if (data.sid?.trim()) {
						await recordProviderEffect(request, {
							name: effectName,
							status: "succeeded",
							provider_id: data.sid,
						});
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
					const err = await readResponseJson<{
						code?: number;
						message?: string;
					}>(res, TWILIO_RESPONSE_MAX_BYTES).catch(
						(): { code?: number; message?: string } => ({}),
					);
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
