import { classifyPublishError, type Publisher, type PublishRequest, type PublishResult } from "./types";

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

			// Handle media (MMS) — Twilio supports up to 10 MediaUrl per message
			const media =
				(opts.media as Array<{ url: string }>) ?? request.media;
			const mediaUrls = media
				.slice(0, 10)
				.map((m) => m.url);

			// Twilio requires either a Body or at least one MediaUrl
			if (!body && mediaUrls.length === 0) {
				throw new Error(
					"SMS requires either a body or at least one media URL.",
				);
			}

			// Basic auth: Account SID : Auth Token
			const credentials = btoa(`${accountSid}:${authToken}`);

			const results: Array<{ phone: string; sid: string | null; error: string | null }> = [];
			let lastSid: string | null = null;

			for (const phone of phoneNumbers) {
				const params = new URLSearchParams({
					To: phone,
					From: fromNumber,
				});
				// Body is optional for MMS (media-only messages)
				if (body) {
					params.set("Body", body.slice(0, 1600)); // Twilio SMS limit: 1600 chars (auto-segments)
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
					const data = (await res.json()) as { sid: string };
					lastSid = data.sid;
					results.push({ phone, sid: data.sid, error: null });
				} else {
					const err = (await res.json().catch(() => ({}))) as {
						code?: number;
						message?: string;
					};
					results.push({
						phone,
						sid: null,
						error: err.code ? `[${err.code}] ${err.message ?? "Unknown error"}` : err.message ?? `HTTP ${res.status}`,
					});
				}
			}

			const sent = results.filter((r) => r.sid !== null).length;
			const failed = results.filter((r) => r.sid === null).length;

			if (sent === 0) {
				throw new Error(
					`All SMS failed. First error: ${results[0]?.error ?? "Unknown"}`,
				);
			}

			return {
				success: true,
				platform_post_id: lastSid ?? undefined,
				platform_url: undefined,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
