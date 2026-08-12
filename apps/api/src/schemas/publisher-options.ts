import { z } from "@hono/zod-openapi";

function isHttpOrHttpsUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

export const PostMediaItem = z
	.object({
		url: z
			.string()
			.url()
			.refine(isHttpOrHttpsUrl, "URL must use http or https")
			.describe("Public URL of the media file"),
		type: z
			.enum(["image", "video", "gif", "document", "audio"])
			.optional()
			.describe(
				"Media type. When omitted, RelayAPI infers it before provider validation; ambiguous media is rejected.",
			),
		alt_text: z
			.string()
			.max(2_000)
			.optional()
			.describe(
				"Accessible description forwarded on platforms that support per-media alt text",
			),
		mime_type: z
			.string()
			.max(255)
			.optional()
			.describe("Authoritative media MIME type when known"),
		width: z.number().int().positive().optional(),
		height: z.number().int().positive().optional(),
		duration_ms: z.number().int().nonnegative().optional(),
		thumbnail: z
			.string()
			.optional()
			.describe(
				"Read-only durable preview URL. Ignored when supplied on write.",
			),
	})
	.openapi("PostMediaItem");

const UnknownObject = z.record(z.string(), z.unknown());
const MediaOverride = z.array(PostMediaItem).max(50).optional();
const UnsupportedMedia = z
	.array(PostMediaItem)
	.max(0, "This publisher does not support media attachments")
	.optional();
const ContentOverride = z.string().optional();
const ThreadItem = z
	.object({
		content: z.string(),
		media: z.array(PostMediaItem).max(10).optional(),
	})
	.catchall(z.unknown());

function compatibleOptions<T extends z.ZodRawShape>(name: string, shape: T) {
	return z.object(shape).catchall(z.unknown()).openapi(name);
}

export const TwitterTargetOptions = compatibleOptions("TwitterTargetOptions", {
	content: ContentOverride,
	media: MediaOverride,
	place_id: z
		.string()
		.min(1)
		.optional()
		.describe("X place ID forwarded as geo.place_id"),
	sensitive_media_warning: z
		.object({
			adult_content: z.boolean(),
			graphic_violence: z.boolean(),
			other: z.boolean(),
		})
		.optional()
		.describe("Sensitive-media labels applied to every uploaded attachment"),
	reply_to: z.string().optional(),
	reply_settings: z
		.enum(["following", "mentionedUsers", "subscribers", "verified"])
		.optional(),
	community_id: z.string().optional(),
	tagged_user_ids: z.array(z.string()).max(10).optional(),
	poll: z
		.object({
			options: z.array(z.string().min(1).max(25)).min(2).max(4),
			duration_minutes: z.number().int().min(5).max(10_080),
		})
		.optional(),
	thread: z.array(ThreadItem).min(1).max(100).optional(),
	paid_partnership: z.boolean().optional(),
	made_with_ai: z.boolean().optional(),
	share_with_followers: z.boolean().optional(),
});

export const InstagramTargetOptions = compatibleOptions(
	"InstagramTargetOptions",
	{
		content: ContentOverride,
		media: MediaOverride,
		content_type: z.enum(["feed", "reels", "story"]).optional(),
		first_comment: z.string().optional(),
		share_to_feed: z.boolean().optional(),
		collaborators: z.array(z.string()).max(3).optional(),
		user_tags: z
			.array(
				z.object({
					username: z.string().min(1),
					x: z.number().min(0).max(1),
					y: z.number().min(0).max(1),
					media_index: z.number().int().nonnegative().optional(),
				}),
			)
			.optional(),
		thumb_offset: z.number().int().nonnegative().optional(),
		cover_url: z
			.string()
			.url()
			.refine(isHttpOrHttpsUrl, "URL must use http or https")
			.optional()
			.describe("Public cover image URL for an Instagram Reel"),
		cover_media_id: z
			.string()
			.min(5)
			.startsWith("med_")
			.optional()
			.describe(
				"Relay media ID resolved to a fresh Instagram Reel cover URL at publish time",
			),
		cover_variant_id: z
			.string()
			.min(6)
			.startsWith("mder_")
			.optional()
			.describe(
				"Relay cover-variant ID resolved to a fresh Instagram Reel cover URL at publish time",
			),
		trial_params: z
			.object({
				graduation_strategy: z.enum(["MANUAL", "SS_PERFORMANCE"]),
			})
			.optional()
			.describe("Instagram Trial Reel graduation configuration"),
	},
);

const FacebookGeoKey = z
	.object({
		key: z.union([z.string().min(1), z.number().int()]),
	})
	.strict();
const FacebookCity = FacebookGeoKey.extend({
	radius: z.number().positive().optional(),
	distance_unit: z.enum(["kilometer", "mile"]).optional(),
});
const FacebookCustomLocation = z
	.object({
		latitude: z.number().min(-90).max(90),
		longitude: z.number().min(-180).max(180),
		radius: z.number().positive().optional(),
		distance_unit: z.enum(["kilometer", "mile"]).optional(),
	})
	.strict();
const FacebookGeoLocations = z
	.object({
		countries: z
			.array(z.string().regex(/^[A-Z]{2}$/))
			.max(25)
			.optional(),
		country_groups: z.array(z.string().min(1)).optional(),
		regions: z.array(FacebookGeoKey).optional(),
		cities: z.array(FacebookCity).optional(),
		zips: z.array(FacebookGeoKey).optional(),
		geo_markets: z.array(FacebookGeoKey).optional(),
		electoral_districts: z.array(FacebookGeoKey).optional(),
		custom_locations: z.array(FacebookCustomLocation).optional(),
		location_types: z.array(z.enum(["home", "recent"])).optional(),
	})
	.strict();
const FacebookStrictTargeting = z
	.object({
		geo_locations: FacebookGeoLocations.optional(),
		age_min: z
			.union([
				z.literal(13),
				z.literal(15),
				z.literal(18),
				z.literal(21),
				z.literal(25),
			])
			.optional(),
	})
	.strict();
const FacebookFeedTargeting = z
	.object({
		age_min: z.number().int().min(13).max(65).optional(),
		age_max: z.number().int().min(13).max(65).optional(),
		college_years: z.array(z.number().int()).optional(),
		education_statuses: z.array(z.number().int().min(1).max(3)).optional(),
		genders: z.array(z.number().int().min(1).max(2)).optional(),
		geo_locations: FacebookGeoLocations.optional(),
		interests: z.array(z.number().int().positive()).optional(),
		locales: z.array(z.number().int().positive()).optional(),
		relationship_statuses: z.array(z.number().int().min(1).max(4)).optional(),
	})
	.strict()
	.superRefine((targeting, ctx) => {
		if (
			targeting.age_min !== undefined &&
			targeting.age_max !== undefined &&
			targeting.age_min > targeting.age_max
		) {
			ctx.addIssue({
				code: "custom",
				path: ["age_max"],
				message: "Facebook feed_targeting age_max must be at least age_min",
			});
		}
	});

export const FacebookTargetOptions = compatibleOptions(
	"FacebookTargetOptions",
	{
		content: ContentOverride,
		media: MediaOverride,
		content_type: z.enum(["feed", "reel", "story"]).optional(),
		title: z.string().optional(),
		first_comment: z.string().optional(),
		published: z
			.boolean()
			.optional()
			.describe("Set false to create an unpublished Facebook feed post"),
		place_id: z
			.string()
			.regex(/^\d+$/, "Facebook place_id must be a numeric Graph object ID")
			.optional()
			.describe("Facebook Page/location ID forwarded as place"),
		targeting: FacebookStrictTargeting.optional().describe(
			"Strict audience targeting; people outside it cannot view the post",
		),
		feed_targeting: FacebookFeedTargeting.optional().describe(
			"Preferred News Feed audience; people outside it may still see the post",
		),
		reel_state: z.enum(["DRAFT", "SCHEDULED", "PUBLISHED"]).optional(),
		reel_scheduled_publish_time: z
			.string()
			.datetime({ offset: true })
			.optional(),
	},
);

export const LinkedInTargetOptions = compatibleOptions(
	"LinkedInTargetOptions",
	{
		content: ContentOverride,
		media: MediaOverride,
		document_title: z.string().max(400).optional(),
		first_comment: z.string().optional(),
		disable_link_preview: z.boolean().optional(),
	},
);

export const TikTokTargetOptions = compatibleOptions("TikTokTargetOptions", {
	content: ContentOverride,
	description: z
		.string()
		.max(4_000)
		.optional()
		.describe("Up to 2,200 characters for video or 4,000 for photo posts"),
	media: MediaOverride,
	publish_mode: z
		.enum(["direct", "inbox"])
		.optional()
		.describe(
			"Direct Post (default) or upload to the creator's TikTok inbox for completion",
		),
	privacy_level: z
		.enum([
			"PUBLIC_TO_EVERYONE",
			"MUTUAL_FOLLOW_FRIENDS",
			"FOLLOWER_OF_CREATOR",
			"SELF_ONLY",
		])
		.optional()
		.describe(
			"Explicit creator selection; RelayAPI verifies it against fresh TikTok creator info and applies no default",
		),
	allow_comment: z
		.boolean()
		.optional()
		.describe("Explicit creator choice; no default is applied"),
	allow_duet: z
		.boolean()
		.optional()
		.describe(
			"Explicit creator choice required when publishing a TikTok video",
		),
	allow_stitch: z
		.boolean()
		.optional()
		.describe(
			"Explicit creator choice required when publishing a TikTok video",
		),
	brand_content_toggle: z.boolean().optional(),
	brand_organic_toggle: z.boolean().optional(),
	content_preview_confirmed: z
		.literal(true)
		.optional()
		.describe("Attests that the creator previewed the exact content"),
	express_consent_given: z
		.literal(true)
		.optional()
		.describe(
			"Attests that the creator expressly consented after TikTok's required Music Usage Confirmation",
		),
	source_mode: z.enum(["file_upload", "pull_from_url"]).optional(),
	video_made_with_ai: z.boolean().optional(),
	auto_add_music: z.boolean().optional(),
	photo_cover_index: z.number().int().min(0).max(34).optional(),
	video_cover_timestamp_ms: z.number().int().nonnegative().optional(),
}).superRefine((options, ctx) => {
	const publishMode = options.publish_mode ?? "direct";
	if (publishMode === "direct") {
		for (const key of [
			"privacy_level",
			"allow_comment",
			"brand_content_toggle",
			"brand_organic_toggle",
		] as const) {
			if (options[key] === undefined) {
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: `TikTok Direct Post requires an explicit ${key} choice`,
				});
			}
		}
		for (const key of [
			"content_preview_confirmed",
			"express_consent_given",
		] as const) {
			if (options[key] !== true) {
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: `TikTok Direct Post requires ${key}`,
				});
			}
		}
		return;
	}

	for (const key of [
		"privacy_level",
		"allow_comment",
		"allow_duet",
		"allow_stitch",
		"brand_content_toggle",
		"brand_organic_toggle",
		"content_preview_confirmed",
		"express_consent_given",
		"video_made_with_ai",
		"auto_add_music",
		"video_cover_timestamp_ms",
	] as const) {
		if (options[key] !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: [key],
				message: `${key} is a Direct Post option and cannot be used with publish_mode inbox`,
			});
		}
	}
});

export const YouTubeTargetOptions = compatibleOptions("YouTubeTargetOptions", {
	content: ContentOverride,
	media: MediaOverride,
	title: z.string().min(1).max(100).optional(),
	visibility: z.enum(["public", "private", "unlisted"]).optional(),
	category_id: z.string().optional(),
	tags: z.array(z.string().max(500)).optional(),
	made_for_kids: z.boolean().optional(),
	contains_synthetic_media: z.boolean().optional(),
	publish_at: z.string().datetime({ offset: true }).optional(),
	notify_subscribers: z.boolean().optional(),
	playlist_id: z.string().optional(),
	first_comment: z.string().optional(),
});

export const PinterestTargetOptions = compatibleOptions(
	"PinterestTargetOptions",
	{
		content: ContentOverride,
		media: MediaOverride,
		board_id: z.string().optional(),
		title: z.string().max(100).optional(),
		link: z.string().url().optional(),
		alt_text: z.string().max(500).optional(),
		cover_image_url: z.string().url().optional(),
		cover_image_key_frame_time: z.number().nonnegative().optional(),
	},
);

export const RedditTargetOptions = compatibleOptions("RedditTargetOptions", {
	content: ContentOverride,
	media: MediaOverride,
	subreddit: z.string().optional(),
	title: z.string().max(300).optional(),
	url: z.string().url().optional(),
	flair_id: z.string().optional(),
	nsfw: z.boolean().optional(),
	spoiler: z.boolean().optional(),
	force_self: z.boolean().optional(),
});

export const BlueskyTargetOptions = compatibleOptions("BlueskyTargetOptions", {
	content: ContentOverride,
	media: MediaOverride,
	languages: z.array(z.string()).max(3).optional(),
	self_labels: z.array(z.string()).optional(),
	link_preview: z.boolean().optional(),
	quote_uri: z.string().optional(),
	quote_cid: z.string().optional(),
	aspectRatio: z
		.object({
			width: z.number().int().positive(),
			height: z.number().int().positive(),
		})
		.optional(),
	thread: z.array(ThreadItem).min(1).max(100).optional(),
});

export const ThreadsTargetOptions = compatibleOptions("ThreadsTargetOptions", {
	content: ContentOverride,
	media: MediaOverride,
	poll: z
		.object({
			options: z.array(z.string().min(1).max(25)).min(2).max(4),
		})
		.optional(),
	quote_post_id: z
		.string()
		.regex(/^\d+$/, "Threads quote_post_id must be a numeric media ID")
		.optional(),
	location_id: z
		.string()
		.regex(/^\d+$/, "Threads location_id must be a numeric Meta location ID")
		.optional(),
	topic_tag: z.string().optional(),
	reply_control: z
		.enum(["everyone", "accounts_you_follow", "mentioned_only"])
		.optional(),
	link_attachment: z.string().url().optional(),
	thread: z.array(ThreadItem).min(1).max(100).optional(),
});

export const TelegramTargetOptions = compatibleOptions(
	"TelegramTargetOptions",
	{
		content: ContentOverride,
		media: MediaOverride,
		parse_mode: z.enum(["HTML", "MarkdownV2"]).optional(),
		disable_preview: z.boolean().optional(),
		protect_content: z.boolean().optional(),
		silent: z.boolean().optional(),
	},
);

export const SnapchatTargetOptions = compatibleOptions(
	"SnapchatTargetOptions",
	{
		content: ContentOverride,
		media: MediaOverride,
		content_type: z
			.enum(["spotlight", "saved_story"])
			.describe("Required publish surface; generic Stories are not supported"),
		locale: z.string().optional(),
	},
);

const GoogleDate = z.object({
	year: z.number().int(),
	month: z.number().int(),
	day: z.number().int(),
});
const GoogleTime = z.object({
	hours: z.number().int().min(0).max(23).optional(),
	minutes: z.number().int().min(0).max(59).optional(),
	seconds: z.number().int().min(0).max(59).optional(),
});
export const GoogleBusinessTargetOptions = compatibleOptions(
	"GoogleBusinessTargetOptions",
	{
		content: ContentOverride,
		media: MediaOverride,
		topic_type: z.enum(["STANDARD", "EVENT", "OFFER", "ALERT"]).optional(),
		language_code: z.string().optional(),
		call_to_action: z
			.object({
				type: z.enum([
					"BOOK",
					"ORDER",
					"SHOP",
					"LEARN_MORE",
					"SIGN_UP",
					"CALL",
				]),
				url: z.string().url().optional(),
			})
			.optional(),
		event: z
			.object({
				title: z.string().optional(),
				schedule: z.object({
					startDate: GoogleDate,
					startTime: GoogleTime.optional(),
					endDate: GoogleDate,
					endTime: GoogleTime.optional(),
				}),
			})
			.optional(),
		offer: z
			.object({
				couponCode: z.string().optional(),
				redeemOnlineUrl: z.string().url().optional(),
				termsConditions: z.string().optional(),
			})
			.optional(),
	},
);

export const WhatsAppTargetOptions = compatibleOptions(
	"WhatsAppTargetOptions",
	{
		content: ContentOverride,
		media: z
			.array(PostMediaItem)
			.max(1)
			.optional()
			.describe(
				"One WhatsApp attachment. Audio attachments cannot include text content because WhatsApp audio messages do not support captions.",
			),
		to: z
			.string()
			.regex(/^[1-9]\d{6,14}$/)
			.describe("Recipient in E.164 digits-only format, without a leading +"),
		preview_url: z.boolean().optional(),
		template_name: z.string().optional(),
		template_language: z.string().optional(),
		template_components: z.array(UnknownObject).optional(),
		interactive: UnknownObject.optional(),
		contacts: z.array(UnknownObject).optional(),
		location: z
			.object({
				latitude: z.number().min(-90).max(90),
				longitude: z.number().min(-180).max(180),
				name: z.string().optional(),
				address: z.string().optional(),
			})
			.optional(),
		reaction: z
			.object({ message_id: z.string(), emoji: z.string().max(16) })
			.optional(),
	},
);

export const MastodonTargetOptions = compatibleOptions(
	"MastodonTargetOptions",
	{
		content: ContentOverride,
		media: MediaOverride,
		visibility: z.enum(["public", "unlisted", "private", "direct"]).optional(),
		spoiler_text: z.string().optional(),
		sensitive: z.boolean().optional(),
		language: z.string().optional(),
		in_reply_to_id: z.string().optional(),
		quoted_status_id: z.string().optional(),
		poll: z
			.object({
				options: z.array(z.string().min(1)).min(2).max(4),
				expires_in: z.number().int().positive(),
				multiple: z.boolean().optional(),
				hide_totals: z.boolean().optional(),
			})
			.optional(),
	},
);

export const DiscordTargetOptions = compatibleOptions("DiscordTargetOptions", {
	content: ContentOverride,
	media: MediaOverride,
	username: z.string().max(80).optional(),
	avatar_url: z.string().url().optional(),
	embeds: z.array(UnknownObject).max(10).optional(),
	tts: z.boolean().optional(),
	thread_id: z
		.string()
		.regex(/^\d{17,20}$/, "Discord thread_id must be a snowflake")
		.optional(),
	thread_name: z.string().min(1).max(100).optional(),
	applied_tags: z
		.array(
			z.string().regex(/^\d{17,20}$/, "Discord tag IDs must be snowflakes"),
		)
		.max(5)
		.optional(),
	poll: z
		.object({
			question: z.object({ text: z.string().min(1).max(300) }),
			answers: z
				.array(
					z.object({
						poll_media: z.object({
							text: z.string().min(1).max(55),
							emoji: z
								.object({
									id: z
										.string()
										.regex(/^\d{17,20}$/)
										.optional(),
									name: z.string().min(1).optional(),
								})
								.refine((emoji) => Boolean(emoji.id) !== Boolean(emoji.name), {
									message:
										"Discord poll emoji requires exactly one of id or name",
								})
								.optional(),
						}),
					}),
				)
				.min(2)
				.max(10),
			duration: z.number().int().min(1).max(768).optional(),
			allow_multiselect: z.boolean().optional(),
			layout_type: z.literal(1).optional(),
		})
		.optional(),
});

export const SmsTargetOptions = compatibleOptions("SmsTargetOptions", {
	content: ContentOverride,
	media: MediaOverride,
	from_number: z
		.string()
		.regex(/^\+[1-9]\d{6,14}$/)
		.optional(),
	phone_numbers: z
		.array(z.string().regex(/^\+[1-9]\d{6,14}$/))
		.min(1)
		.max(100)
		.optional(),
});

export const BeehiivTargetOptions = compatibleOptions("BeehiivTargetOptions", {
	content: ContentOverride,
	media: MediaOverride,
	subject: z.string().optional(),
	preview_text: z.string().optional(),
	content_html: z.string().optional(),
	content_tags: z.array(z.string()).optional(),
	thumbnail_image_url: z.string().url().optional(),
	scheduled_at: z.string().datetime({ offset: true }).optional(),
});

export const ConvertKitTargetOptions = compatibleOptions(
	"ConvertKitTargetOptions",
	{
		content: ContentOverride,
		media: UnsupportedMedia,
		subject: z.string().optional(),
		preview_text: z.string().optional(),
		content_html: z.string().optional(),
		email_template_id: z.number().int().positive().optional(),
		public: z.boolean().optional(),
		published_at: z.string().datetime({ offset: true }).optional(),
		send_at: z
			.string()
			.datetime({ offset: true })
			.optional()
			.describe(
				'ISO timestamp for a scheduled Kit broadcast. RelayAPI rejects provider drafts; use top-level scheduled_at: "draft" for a local Relay draft.',
			),
	},
);

export const MailchimpTargetOptions = compatibleOptions(
	"MailchimpTargetOptions",
	{
		content: ContentOverride,
		media: UnsupportedMedia,
		subject: z.string().optional(),
		preview_text: z.string().optional(),
		content_html: z.string().optional(),
		list_id: z.string().optional(),
		from_email: z.string().email().optional(),
		from_name: z.string().optional(),
		reply_to: z.string().email().optional(),
		schedule_time: z.string().datetime({ offset: true }).optional(),
	},
);

export const ListmonkTargetOptions = compatibleOptions(
	"ListmonkTargetOptions",
	{
		content: ContentOverride,
		media: UnsupportedMedia,
		subject: z.string().optional(),
		content_html: z.string().optional(),
		alt_body: z.string().optional(),
		list_id: z.number().int().positive().optional(),
		from_email: z.string().optional(),
		template_id: z.number().int().positive().optional(),
		tags: z.array(z.string()).optional(),
		headers: z.record(z.string(), z.string()).optional(),
		send_at: z.string().datetime({ offset: true }).optional(),
	},
);

export const SlackTargetOptions = compatibleOptions("SlackTargetOptions", {
	content: ContentOverride,
	media: MediaOverride,
	blocks: z.array(UnknownObject).max(50).optional(),
	attachments: z.array(UnknownObject).max(100).optional(),
	thread_ts: z.string().optional(),
	unfurl_links: z.boolean().optional(),
	unfurl_media: z.boolean().optional(),
});

/**
 * Platform keys are fully described in OpenAPI. Account/workspace target keys
 * remain compatibility aliases and therefore accept an object whose fields are
 * validated again by the resolved platform adapter.
 */
export const PublisherTargetOptions = z
	.object({
		twitter: TwitterTargetOptions.optional(),
		instagram: InstagramTargetOptions.optional(),
		facebook: FacebookTargetOptions.optional(),
		linkedin: LinkedInTargetOptions.optional(),
		tiktok: TikTokTargetOptions.optional(),
		youtube: YouTubeTargetOptions.optional(),
		pinterest: PinterestTargetOptions.optional(),
		reddit: RedditTargetOptions.optional(),
		bluesky: BlueskyTargetOptions.optional(),
		threads: ThreadsTargetOptions.optional(),
		telegram: TelegramTargetOptions.optional(),
		snapchat: SnapchatTargetOptions.optional(),
		googlebusiness: GoogleBusinessTargetOptions.optional(),
		whatsapp: WhatsAppTargetOptions.optional(),
		mastodon: MastodonTargetOptions.optional(),
		discord: DiscordTargetOptions.optional(),
		sms: SmsTargetOptions.optional(),
		beehiiv: BeehiivTargetOptions.optional(),
		convertkit: ConvertKitTargetOptions.optional(),
		mailchimp: MailchimpTargetOptions.optional(),
		listmonk: ListmonkTargetOptions.optional(),
		slack: SlackTargetOptions.optional(),
	})
	.catchall(UnknownObject)
	.openapi("PublisherTargetOptions");
