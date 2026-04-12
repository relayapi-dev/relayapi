import { classifyPublishError, type Publisher, type PublishRequest, type PublishResult } from "./types";

const GBP_API = "https://mybusiness.googleapis.com/v4";

async function gbpFetch(
	url: string,
	accessToken: string,
	options: RequestInit = {},
): Promise<Response> {
	const res = await fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			...(options.headers ?? {}),
		},
	});
	if (res.status === 401) throw new Error("TOKEN_EXPIRED: Google Business Profile token expired or invalid");
	if (res.status === 403) throw new Error("TOKEN_EXPIRED: Google Business Profile access forbidden — token may need refresh");
	if (res.status === 429) throw new Error("RATE_LIMITED: Google Business Profile rate limit exceeded");
	return res;
}

interface CallToAction {
	type: string;
	url?: string;
}

const VALID_CTA_TYPES = [
	"LEARN_MORE",
	"BOOK",
	"ORDER",
	"SHOP",
	"SIGN_UP",
	"CALL",
];

export const googleBusinessPublisher: Publisher = {
	platform: "googlebusiness",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const accessToken = request.account.access_token;
			const locationResourceName = request.account.platform_account_id;
			const opts = request.target_options;

			// Resolve content — target_options can override
			const content = (opts.content as string) ?? request.content ?? "";

			// Validate character limit
			if (content.length > 1500) {
				return {
					success: false,
					error: {
						code: "CONTENT_TOO_LONG",
						message: `Content is ${content.length} characters. Google Business Profile limit is 1,500.`,
					},
				};
			}

			// Resolve media
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;

			// Validate: max 1 media item
			if (media.length > 1) {
				return {
					success: false,
					error: {
						code: "TOO_MANY_MEDIA",
						message:
							"Google Business Profile supports a maximum of 1 image per post.",
					},
				};
			}

			// Build the local post body
			const postBody: Record<string, unknown> = {
				// topicType is required for all local posts
				// Valid types: STANDARD, EVENT, OFFER, ALERT
				// ALERT is for high-priority timely announcements
				// https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts
				topicType: (opts.topic_type as string) ?? "STANDARD",
			};

			// Summary (text content)
			if (content) {
				postBody.summary = content;
			}

			// Language code
			const languageCode = opts.language_code as string | undefined;
			if (languageCode) {
				postBody.languageCode = languageCode;
			}

			// EVENT and OFFER require an event schedule
			const topicType = postBody.topicType as string;
			if (topicType === "EVENT" || topicType === "OFFER") {
				const eventSchedule = opts.event as { title?: string; schedule?: { startDate: unknown; startTime?: unknown; endDate: unknown; endTime?: unknown } } | undefined;
				if (!eventSchedule?.schedule) {
					return {
						success: false,
						error: {
							code: "EVENT_REQUIRED",
							message: `Topic type "${topicType}" requires an event with a schedule in target_options.event.`,
						},
					};
				}
				postBody.event = eventSchedule;
			}

			// OFFER posts can include coupon/redemption details
			if (topicType === "OFFER") {
				const offer = opts.offer as { couponCode?: string; redeemOnlineUrl?: string; termsConditions?: string } | undefined;
				if (offer) {
					postBody.offer = offer;
				}
			}

			// Media — single image or video via sourceUrl
			// The localPosts API supports both PHOTO and VIDEO mediaFormat
			if (media.length === 1) {
				const mediaItem = media[0];
				const isVideo = mediaItem?.type === "video";
				postBody.media = [
					{
						mediaFormat: isVideo ? "VIDEO" : "PHOTO",
						sourceUrl: mediaItem?.url,
					},
				];
			}

			// Call to action
			const cta = opts.call_to_action as CallToAction | undefined;
			if (cta) {
				if (!VALID_CTA_TYPES.includes(cta.type)) {
					return {
						success: false,
						error: {
							code: "INVALID_CTA_TYPE",
							message: `Invalid call_to_action type "${cta.type}". Valid types: ${VALID_CTA_TYPES.join(", ")}`,
						},
					};
				}
				postBody.callToAction = {
					actionType: cta.type,
					// CALL action type uses the location's phone number, not a URL
					...(cta.type !== "CALL" && cta.url ? { url: cta.url } : {}),
				};
			}

			// Determine the parent resource name
			// The platform_account_id is the location resource name: accounts/{id}/locations/{id}
			// If location_id is provided in target_options, override the location part
			let parent = locationResourceName;
			const locationId = opts.location_id as string | undefined;
			if (locationId) {
				// Extract account part from platform_account_id
				const accountMatch = locationResourceName.match(/^(accounts\/[^/]+)/);
				if (accountMatch?.[1]) {
					parent = `${accountMatch[1]}/${locationId.startsWith("locations/") ? locationId : `locations/${locationId}`}`;
				}
			}

			// Create local post
			// Google Business Profile API — Create a local post for a location
			// https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts/create
			const res = await gbpFetch(
				`${GBP_API}/${parent}/localPosts`,
				accessToken,
				{
					method: "POST",
					body: JSON.stringify(postBody),
				},
			);

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				const detail =
					(err as { error?: { message?: string } }).error?.message ??
					res.statusText;
				throw new Error(`Google Business post creation failed: ${detail}`);
			}

			const result = (await res.json()) as {
				name?: string;
				searchUrl?: string;
			};

			// The post name is the resource identifier
			const postId = result.name;
			// Google Business posts don't have a direct public URL, but searchUrl may be available
			const platformUrl = result.searchUrl;

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
