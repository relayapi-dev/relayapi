import { countChars, PLATFORM_LIMITS } from "../config/platform-limits";
import type { MediaAttachment } from "../publishers/types";
import type { Platform } from "../schemas/common";

export type PublisherMediaType = NonNullable<MediaAttachment["type"]>;

export interface PlatformPostValidationError {
	code: string;
	message: string;
}

/**
 * Generic media types that each adapter deliberately implements. Keeping this
 * matrix beside the shared preflight prevents a newly added generic media type
 * from falling through an adapter as an image or being silently discarded.
 */
export const PLATFORM_ALLOWED_MEDIA_TYPES: Record<
	Platform,
	readonly PublisherMediaType[]
> = {
	twitter: ["image", "video", "gif"],
	instagram: ["image", "video"],
	facebook: ["image", "video", "gif"],
	linkedin: ["image", "video", "gif", "document"],
	tiktok: ["image", "video"],
	youtube: ["image", "video"],
	pinterest: ["image", "video"],
	reddit: ["image", "video", "gif", "document"],
	bluesky: ["image", "video", "gif"],
	threads: ["image", "video"],
	telegram: ["image", "video", "gif", "document"],
	snapchat: ["image", "video"],
	googlebusiness: ["image", "video"],
	whatsapp: ["image", "video", "document", "audio"],
	mastodon: ["image", "video", "gif"],
	discord: ["image", "video", "gif", "document"],
	sms: ["image", "video", "gif"],
	beehiiv: ["image", "gif"],
	convertkit: [],
	mailchimp: [],
	listmonk: [],
	slack: ["image", "video", "gif", "document"],
};

const MAX_TOTAL_MEDIA: Record<Platform, number> = {
	twitter: 4,
	instagram: 10,
	facebook: 10,
	linkedin: 20,
	tiktok: 35,
	youtube: 2,
	pinterest: 5,
	reddit: 1,
	bluesky: 4,
	threads: 20,
	telegram: 10,
	snapchat: 1,
	googlebusiness: 1,
	whatsapp: 1,
	mastodon: 4,
	discord: 10,
	sms: 10,
	beehiiv: 50,
	convertkit: 0,
	mailchimp: 0,
	listmonk: 0,
	slack: 50,
};

function normalizedType(
	media: Pick<MediaAttachment, "type">,
): PublisherMediaType {
	// API media normalization resolves omitted types before publishing. Dry-run
	// validation keeps its historical conservative image fallback.
	return media.type ?? "image";
}

function addError(
	errors: PlatformPostValidationError[],
	code: string,
	message: string,
): void {
	if (!errors.some((error) => error.code === code)) {
		errors.push({ code, message });
	}
}

export function getPlatformContentLimit(
	platform: Platform,
	hasMedia: boolean,
	options: Record<string, unknown>,
): number {
	const contentType =
		typeof options.content_type === "string" ? options.content_type : undefined;
	if (platform === "snapchat" && contentType === "saved_story") return 45;
	if (platform === "snapchat" && contentType === "spotlight") return 160;
	if ((platform === "telegram" || platform === "whatsapp") && hasMedia) {
		return 1_024;
	}
	return PLATFORM_LIMITS[platform].chars.maxChars;
}

export function getPlatformMediaFileLimit(
	platform: Platform,
	contentType: string | null,
): { maxSize: number; mimeTypeSupported?: boolean } {
	const limits = PLATFORM_LIMITS[platform].media;
	const isVideo = contentType?.startsWith("video/") ?? false;
	const isAudio = contentType?.startsWith("audio/") ?? false;
	const isImage = contentType?.startsWith("image/") ?? false;
	const isGif = contentType === "image/gif";
	const isDocument = !isVideo && !isAudio && !isImage;
	const maxSize = isAudio
		? (limits.maxAudioSize ?? 0)
		: isDocument
			? (limits.maxDocumentSize ?? 0)
			: isVideo
				? limits.maxVideoSize
				: isGif && limits.maxGifSize
					? limits.maxGifSize
					: limits.maxImageSize;
	if (!contentType) return { maxSize };
	const allowedTypes = isAudio
		? (limits.allowedAudioTypes ?? [])
		: isDocument
			? (limits.allowedDocumentTypes ?? [])
			: isVideo
				? limits.allowedVideoTypes
				: limits.allowedImageTypes;
	return {
		maxSize,
		mimeTypeSupported:
			allowedTypes.includes("*/*") || allowedTypes.includes(contentType),
	};
}

export function resolvePlatformMediaForValidation(
	sharedMedia: readonly MediaAttachment[],
	options: Record<string, unknown>,
): MediaAttachment[] {
	return Array.isArray(options.media)
		? (options.media as MediaAttachment[])
		: [...sharedMedia];
}

export function validatePlatformPostInput(
	platform: Platform,
	content: string,
	media: readonly MediaAttachment[],
	options: Record<string, unknown>,
): PlatformPostValidationError[] {
	const errors: PlatformPostValidationError[] = [];
	const mediaTypes = media.map(normalizedType);
	const allowed = new Set(PLATFORM_ALLOWED_MEDIA_TYPES[platform]);
	for (const type of mediaTypes) {
		if (!allowed.has(type)) {
			addError(
				errors,
				"UNSUPPORTED_MEDIA_TYPE",
				`${platform} does not support ${type} attachments through RelayAPI.`,
			);
		}
	}

	const maxTotal = MAX_TOTAL_MEDIA[platform];
	if (media.length > maxTotal) {
		addError(
			errors,
			"TOO_MANY_MEDIA",
			`${platform} allows at most ${maxTotal} media attachments; received ${media.length}.`,
		);
	}

	const imageCount = mediaTypes.filter(
		(type) => type === "image" || type === "gif",
	).length;
	const videoCount = mediaTypes.filter((type) => type === "video").length;
	const documentCount = mediaTypes.filter((type) => type === "document").length;
	const gifCount = mediaTypes.filter((type) => type === "gif").length;
	const limits = PLATFORM_LIMITS[platform];
	if (imageCount > limits.media.maxImages) {
		addError(
			errors,
			limits.media.maxImages === 0 ? "IMAGES_NOT_SUPPORTED" : "TOO_MANY_IMAGES",
			`${platform} allows at most ${limits.media.maxImages} image attachments; received ${imageCount}.`,
		);
	}
	if (videoCount > limits.media.maxVideos) {
		addError(
			errors,
			"TOO_MANY_VIDEOS",
			`${platform} allows at most ${limits.media.maxVideos} video attachments; received ${videoCount}.`,
		);
	}

	if (
		platform === "twitter" &&
		(videoCount > 0 || gifCount > 0) &&
		media.length !== 1
	) {
		addError(
			errors,
			"INVALID_MEDIA_MIX",
			"X allows up to four images, or exactly one GIF, or exactly one video.",
		);
	}
	if (platform === "facebook" && videoCount > 0 && media.length !== 1) {
		addError(
			errors,
			"INVALID_MEDIA_MIX",
			"Facebook feed videos cannot be mixed with image attachments.",
		);
	}
	if (
		platform === "linkedin" &&
		(videoCount > 0 || documentCount > 0) &&
		media.length !== 1
	) {
		addError(
			errors,
			"INVALID_MEDIA_MIX",
			"LinkedIn video and document posts accept exactly one attachment.",
		);
	}
	if (platform === "tiktok" && videoCount > 0 && media.length !== 1) {
		addError(
			errors,
			"MIXED_MEDIA",
			"TikTok accepts one video or an image carousel, not mixed media.",
		);
	}
	if (platform === "bluesky" && videoCount > 0 && media.length !== 1) {
		addError(
			errors,
			"INVALID_MEDIA_MIX",
			"Bluesky accepts one video or up to four images, not mixed media.",
		);
	}
	if (
		platform === "mastodon" &&
		(videoCount > 0 || gifCount > 0) &&
		media.length !== 1
	) {
		addError(
			errors,
			"INVALID_MEDIA_MIX",
			"Mastodon video and GIF posts accept exactly one attachment.",
		);
	}
	if (
		platform === "telegram" &&
		documentCount > 0 &&
		documentCount !== media.length
	) {
		addError(
			errors,
			"INVALID_MEDIA_MIX",
			"Telegram media groups cannot mix documents with photos or videos.",
		);
	}
	if (platform === "telegram" && gifCount > 0 && media.length > 1) {
		addError(
			errors,
			"INVALID_MEDIA_MIX",
			"Telegram animations cannot be included in a media group.",
		);
	}
	if (platform === "pinterest" && videoCount > 0 && media.length > 2) {
		addError(
			errors,
			"INVALID_MEDIA_MIX",
			"Pinterest video pins accept one video and one optional cover image.",
		);
	}

	const contentType =
		typeof options.content_type === "string" ? options.content_type : undefined;
	if (
		(platform === "instagram" || platform === "facebook") &&
		(contentType === "story" ||
			contentType === "reels" ||
			contentType === "reel") &&
		media.length !== 1
	) {
		addError(
			errors,
			media.length === 0 ? "MEDIA_REQUIRED" : "TOO_MANY_MEDIA",
			`${platform} ${contentType} posts require exactly one media attachment.`,
		);
	}
	if (
		(platform === "instagram" && contentType === "reels" && videoCount !== 1) ||
		(platform === "facebook" && contentType === "reel" && videoCount !== 1)
	) {
		addError(
			errors,
			"VIDEO_REQUIRED",
			`${platform} ${contentType} posts require one video attachment.`,
		);
	}

	if (platform === "instagram") {
		const coverSources = [
			options.cover_url,
			options.cover_media_id,
			options.cover_variant_id,
			options.thumb_offset,
		].filter((value) => value !== undefined);
		if (
			(coverSources.length > 0 || options.trial_params !== undefined) &&
			contentType !== "reels"
		) {
			addError(
				errors,
				"REELS_OPTION_REQUIRES_REEL",
				"Instagram cover options and trial_params are supported only when content_type is reels.",
			);
		}
		if (coverSources.length > 1) {
			addError(
				errors,
				"AMBIGUOUS_REEL_COVER",
				"Choose exactly one Instagram Reel cover source: cover_url, cover_media_id, cover_variant_id, or thumb_offset.",
			);
		}
	}

	if (platform === "facebook") {
		const isFeed = contentType === undefined || contentType === "feed";
		if (options.published !== undefined && !isFeed) {
			addError(
				errors,
				"FACEBOOK_OPTION_REQUIRES_FEED",
				"Facebook published is supported only for feed posts.",
			);
		}
		if (
			(options.targeting !== undefined ||
				options.feed_targeting !== undefined) &&
			!isFeed
		) {
			addError(
				errors,
				"FACEBOOK_OPTION_REQUIRES_FEED",
				"Facebook targeting and feed_targeting are supported only for feed posts.",
			);
		}
		if (options.first_comment !== undefined && options.published === false) {
			addError(
				errors,
				"FIRST_COMMENT_REQUIRES_PUBLISHED_POST",
				"Facebook first_comment cannot be added to an unpublished post.",
			);
		}
		if (options.first_comment !== undefined && !isFeed) {
			addError(
				errors,
				"FACEBOOK_OPTION_REQUIRES_FEED",
				"Facebook first_comment is supported only for feed posts.",
			);
		}
		if (options.reel_state !== undefined && contentType !== "reel") {
			addError(
				errors,
				"FACEBOOK_OPTION_REQUIRES_REEL",
				"Facebook reel_state is supported only for Reel posts.",
			);
		}
		if (
			options.reel_scheduled_publish_time !== undefined &&
			options.reel_state !== "SCHEDULED"
		) {
			addError(
				errors,
				"INVALID_REEL_SCHEDULE",
				"Facebook reel_scheduled_publish_time requires reel_state SCHEDULED.",
			);
		}
		if (
			options.reel_state === "SCHEDULED" &&
			typeof options.reel_scheduled_publish_time !== "string"
		) {
			addError(
				errors,
				"INVALID_REEL_SCHEDULE",
				"Facebook reel_state SCHEDULED requires reel_scheduled_publish_time.",
			);
		}
		if (isFeed && videoCount > 0 && options.place_id !== undefined) {
			addError(
				errors,
				"PLACE_UNSUPPORTED_FOR_VIDEO_FEED",
				"Facebook's Page video endpoint does not support the place field; use a text, image, or Reel post.",
			);
		}
	}

	if (
		["instagram", "tiktok", "youtube", "pinterest", "snapchat"].includes(
			platform,
		) &&
		media.length === 0
	) {
		addError(
			errors,
			"MEDIA_REQUIRED",
			`${platform} requires media for this publish operation.`,
		);
	}
	if (platform === "youtube" && videoCount !== 1) {
		addError(
			errors,
			"VIDEO_REQUIRED",
			"YouTube requires exactly one video attachment.",
		);
	}
	if (platform === "snapchat") {
		if (contentType !== "saved_story" && contentType !== "spotlight") {
			addError(
				errors,
				"CONTENT_TYPE_REQUIRED",
				"Snapchat requires content_type to be saved_story or spotlight.",
			);
		}
		if (contentType === "spotlight" && videoCount !== 1) {
			addError(
				errors,
				"VIDEO_REQUIRED",
				"Snapchat Spotlight requires one video attachment.",
			);
		}
	}
	if (platform === "whatsapp") {
		const recipient = typeof options.to === "string" ? options.to : "";
		if (!/^[1-9]\d{6,14}$/.test(recipient)) {
			addError(
				errors,
				"MISSING_RECIPIENT",
				"WhatsApp requires target_options.to in E.164 digits-only format without a leading +.",
			);
		}
		if (mediaTypes.includes("audio") && content.trim().length > 0) {
			addError(
				errors,
				"AUDIO_CAPTION_UNSUPPORTED",
				"WhatsApp audio messages do not support captions; remove text content or use a non-audio attachment.",
			);
		}
	}
	if (platform === "convertkit" && options.send_at === null) {
		addError(
			errors,
			"PROVIDER_DRAFT_UNSUPPORTED",
			'RelayAPI does not create Kit provider drafts; use top-level scheduled_at: "draft" for a local Relay draft, or provide a send_at timestamp.',
		);
	}
	if (
		platform === "tiktok" &&
		(options.publish_mode === undefined || options.publish_mode === "direct") &&
		videoCount > 0
	) {
		if (
			typeof options.allow_duet !== "boolean" ||
			typeof options.allow_stitch !== "boolean"
		) {
			addError(
				errors,
				"VIDEO_INTERACTIONS_REQUIRED",
				"TikTok video posts require explicit allow_duet and allow_stitch choices.",
			);
		}
	}
	if (platform === "tiktok") {
		const publishMode = options.publish_mode ?? "direct";
		if (publishMode !== "direct" && publishMode !== "inbox") {
			addError(
				errors,
				"INVALID_PUBLISH_MODE",
				"TikTok publish_mode must be direct or inbox.",
			);
		} else if (publishMode === "direct") {
			for (const [key, code] of [
				["privacy_level", "PRIVACY_LEVEL_REQUIRED"],
				["allow_comment", "ALLOW_COMMENT_REQUIRED"],
				["brand_content_toggle", "COMMERCIAL_DISCLOSURE_REQUIRED"],
				["brand_organic_toggle", "COMMERCIAL_DISCLOSURE_REQUIRED"],
			] as const) {
				if (options[key] === undefined) {
					addError(
						errors,
						code,
						`TikTok Direct Post requires an explicit ${key} choice.`,
					);
				}
			}
			if (
				options.content_preview_confirmed !== true ||
				options.express_consent_given !== true
			) {
				addError(
					errors,
					"TIKTOK_CONSENT_REQUIRED",
					"TikTok Direct Post requires confirmed preview and express creator consent.",
				);
			}
		} else {
			const directOnly = [
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
			].filter((key) => options[key] !== undefined);
			if (directOnly.length > 0) {
				addError(
					errors,
					"DIRECT_OPTION_WITH_INBOX_MODE",
					`TikTok inbox uploads do not accept Direct Post options: ${directOnly.join(", ")}.`,
				);
			}
			if (videoCount > 0 && options.description !== undefined) {
				addError(
					errors,
					"VIDEO_INBOX_DESCRIPTION_UNSUPPORTED",
					"TikTok's video inbox endpoint accepts only source_info; add the caption when completing the post in TikTok.",
				);
			}
		}
		if (imageCount > 0 && options.source_mode === "file_upload") {
			addError(
				errors,
				"PHOTO_FILE_UPLOAD_UNSUPPORTED",
				"TikTok's photo endpoint supports PULL_FROM_URL only.",
			);
		}
		if (
			videoCount > 0 &&
			(options.photo_cover_index !== undefined ||
				options.auto_add_music !== undefined)
		) {
			addError(
				errors,
				"PHOTO_OPTION_REQUIRES_PHOTOS",
				"TikTok photo_cover_index and auto_add_music are supported only for photo posts.",
			);
		}
		if (
			imageCount > 0 &&
			(options.allow_duet !== undefined ||
				options.allow_stitch !== undefined ||
				options.video_cover_timestamp_ms !== undefined ||
				options.video_made_with_ai !== undefined)
		) {
			addError(
				errors,
				"VIDEO_OPTION_REQUIRES_VIDEO",
				"TikTok allow_duet, allow_stitch, video_cover_timestamp_ms, and video_made_with_ai are supported only for video posts.",
			);
		}
	}

	if (
		platform === "twitter" &&
		options.sensitive_media_warning !== undefined &&
		media.length === 0
	) {
		addError(
			errors,
			"SENSITIVE_MEDIA_REQUIRES_MEDIA",
			"X sensitive_media_warning requires at least one media attachment.",
		);
	}

	if (platform === "threads") {
		if (options.poll !== undefined && media.length > 0) {
			addError(
				errors,
				"POLL_REQUIRES_TEXT_POST",
				"Threads polls can be attached only to text-only posts.",
			);
		}
		if (options.poll !== undefined && Array.isArray(options.thread)) {
			addError(
				errors,
				"POLL_UNSUPPORTED_IN_THREAD",
				"Threads poll options cannot be combined with RelayAPI thread sequences.",
			);
		}
	}

	if (platform === "discord") {
		if (options.thread_id !== undefined && options.thread_name !== undefined) {
			addError(
				errors,
				"DISCORD_THREAD_CONFLICT",
				"Discord thread_id and thread_name are mutually exclusive.",
			);
		}
		if (
			Array.isArray(options.applied_tags) &&
			options.applied_tags.length > 0 &&
			options.thread_name === undefined
		) {
			addError(
				errors,
				"DISCORD_TAGS_REQUIRE_NEW_THREAD",
				"Discord applied_tags require thread_name when creating a forum/media thread.",
			);
		}
		if (options.tts === true && content.trim().length === 0) {
			addError(
				errors,
				"DISCORD_TTS_REQUIRES_CONTENT",
				"Discord TTS messages require text content.",
			);
		}
	}

	const lengthContent =
		typeof options.content_html === "string" ? options.content_html : content;
	const maxChars = getPlatformContentLimit(platform, media.length > 0, options);
	const charCount = countChars(lengthContent, platform);
	if (charCount > maxChars) {
		addError(
			errors,
			"CONTENT_TOO_LONG",
			`Content is ${charCount}/${maxChars} characters for ${platform}.`,
		);
	}

	if (Array.isArray(options.thread)) {
		for (const [index, rawItem] of options.thread.entries()) {
			if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
				continue;
			}
			const item = rawItem as Record<string, unknown>;
			const itemContent = typeof item.content === "string" ? item.content : "";
			const itemMedia = Array.isArray(item.media)
				? (item.media as MediaAttachment[])
				: [];
			const itemOptions = { ...options, thread: undefined };
			for (const error of validatePlatformPostInput(
				platform,
				itemContent,
				itemMedia,
				itemOptions,
			)) {
				addError(errors, error.code, `thread[${index}]: ${error.message}`);
			}
		}
	}

	return errors;
}
