/**
 * Platform-specific publishing options accepted by the posts API.
 *
 * Unknown keys remain available during the compatibility window, but clients
 * should prefer the documented fields so unsupported options can be detected
 * before provider I/O.
 */

export interface PostMediaInput {
  /** Public HTTP(S) URL of the media file. */
  url: string;
  /** Omit only when RelayAPI can infer the type from trusted metadata. */
  type?: "image" | "video" | "gif" | "document" | "audio";
  /** Accessible per-media description, forwarded where supported. */
  alt_text?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  /** Read-only durable preview URL; ignored on writes. */
  thumbnail?: string;
}

export interface BaseTargetOptions {
  content?: string;
  media?: PostMediaInput[];
  [key: string]: unknown;
}

export interface ThreadItem {
  content: string;
  media?: PostMediaInput[];
  [key: string]: unknown;
}

export interface TwitterTargetOptions extends BaseTargetOptions {
  /** X place ID forwarded as geo.place_id. */
  place_id?: string;
  /** Sensitive-media labels applied to every uploaded attachment. */
  sensitive_media_warning?: {
    adult_content: boolean;
    graphic_violence: boolean;
    other: boolean;
  };
  reply_to?: string;
  reply_settings?: "following" | "mentionedUsers" | "subscribers" | "verified";
  community_id?: string;
  tagged_user_ids?: string[];
  poll?: { options: string[]; duration_minutes: number };
  thread?: ThreadItem[];
  paid_partnership?: boolean;
  made_with_ai?: boolean;
  share_with_followers?: boolean;
}

export interface InstagramTargetOptions extends BaseTargetOptions {
  content_type?: "feed" | "reels" | "story";
  first_comment?: string;
  share_to_feed?: boolean;
  collaborators?: string[];
  user_tags?: Array<{
    username: string;
    x: number;
    y: number;
    media_index?: number;
  }>;
  thumb_offset?: number;
  /** Public cover image URL for a Reel. */
  cover_url?: string;
  /** Relay media ID resolved to a fresh cover URL when the Reel is published. */
  cover_media_id?: string;
  /** Relay-generated cover variant ID resolved to a fresh URL when the Reel is published. */
  cover_variant_id?: string;
  /** Trial Reels are graduated manually or when Meta's performance threshold is met. */
  trial_params?: { graduation_strategy: "MANUAL" | "SS_PERFORMANCE" };
}

export interface FacebookGeoKey {
  key: string | number;
}

export interface FacebookCity extends FacebookGeoKey {
  radius?: number;
  distance_unit?: "kilometer" | "mile";
}

export interface FacebookCustomLocation {
  latitude: number;
  longitude: number;
  radius?: number;
  distance_unit?: "kilometer" | "mile";
}

export interface FacebookGeoLocations {
  countries?: string[];
  country_groups?: string[];
  regions?: FacebookGeoKey[];
  cities?: FacebookCity[];
  zips?: FacebookGeoKey[];
  geo_markets?: FacebookGeoKey[];
  electoral_districts?: FacebookGeoKey[];
  custom_locations?: FacebookCustomLocation[];
  location_types?: Array<"home" | "recent">;
}

export interface FacebookStrictTargeting {
  geo_locations?: FacebookGeoLocations;
  age_min?: 13 | 15 | 18 | 21 | 25;
}

export interface FacebookFeedTargeting {
  age_min?: number;
  age_max?: number;
  college_years?: number[];
  education_statuses?: Array<1 | 2 | 3>;
  genders?: Array<1 | 2>;
  geo_locations?: FacebookGeoLocations;
  interests?: number[];
  locales?: number[];
  relationship_statuses?: Array<1 | 2 | 3 | 4>;
}

export interface FacebookTargetOptions extends BaseTargetOptions {
  content_type?: "feed" | "reel" | "story";
  title?: string;
  first_comment?: string;
  /** False creates an unpublished provider-side feed post. */
  published?: boolean;
  /** Facebook Page/location ID forwarded as place. */
  place_id?: string;
  /** Strict audience restriction. */
  targeting?: FacebookStrictTargeting;
  /** Preferred News Feed audience; people outside it may still see the post. */
  feed_targeting?: FacebookFeedTargeting;
  reel_state?: "DRAFT" | "SCHEDULED" | "PUBLISHED";
  /** ISO-8601 instant, required only when reel_state is SCHEDULED. */
  reel_scheduled_publish_time?: string;
}

export interface LinkedInTargetOptions extends BaseTargetOptions {
  document_title?: string;
  first_comment?: string;
  disable_link_preview?: boolean;
}

export interface TikTokBaseTargetOptions extends BaseTargetOptions {
  description?: string;
  source_mode?: "file_upload" | "pull_from_url";
  photo_cover_index?: number;
}

export interface TikTokDirectTargetOptions extends TikTokBaseTargetOptions {
  /** Direct Post is the default when publish_mode is omitted. */
  publish_mode?: "direct";
  privacy_level:
    | "PUBLIC_TO_EVERYONE"
    | "MUTUAL_FOLLOW_FRIENDS"
    | "FOLLOWER_OF_CREATOR"
    | "SELF_ONLY";
  allow_comment: boolean;
  /** Required when the attachment is a video. */
  allow_duet?: boolean;
  /** Required when the attachment is a video. */
  allow_stitch?: boolean;
  brand_content_toggle: boolean;
  brand_organic_toggle: boolean;
  content_preview_confirmed: true;
  express_consent_given: true;
  video_made_with_ai?: boolean;
  auto_add_music?: boolean;
  video_cover_timestamp_ms?: number;
}

export interface TikTokInboxTargetOptions extends TikTokBaseTargetOptions {
  /** Uploads content for the creator to finish from a TikTok inbox notification. */
  publish_mode: "inbox";
  privacy_level?: never;
  allow_comment?: never;
  allow_duet?: never;
  allow_stitch?: never;
  brand_content_toggle?: never;
  brand_organic_toggle?: never;
  content_preview_confirmed?: never;
  express_consent_given?: never;
  video_made_with_ai?: never;
  auto_add_music?: never;
  video_cover_timestamp_ms?: never;
}

export type TikTokTargetOptions =
  | TikTokDirectTargetOptions
  | TikTokInboxTargetOptions;

export interface YouTubeTargetOptions extends BaseTargetOptions {
  title?: string;
  visibility?: "public" | "private" | "unlisted";
  category_id?: string;
  tags?: string[];
  made_for_kids?: boolean;
  contains_synthetic_media?: boolean;
  publish_at?: string;
  notify_subscribers?: boolean;
  playlist_id?: string;
  first_comment?: string;
}

export interface PinterestTargetOptions extends BaseTargetOptions {
  board_id?: string;
  title?: string;
  link?: string;
  alt_text?: string;
  cover_image_url?: string;
  cover_image_key_frame_time?: number;
}

export interface RedditTargetOptions extends BaseTargetOptions {
  subreddit?: string;
  title?: string;
  url?: string;
  flair_id?: string;
  nsfw?: boolean;
  spoiler?: boolean;
  force_self?: boolean;
}

export interface BlueskyTargetOptions extends BaseTargetOptions {
  languages?: string[];
  self_labels?: string[];
  link_preview?: boolean;
  quote_uri?: string;
  quote_cid?: string;
  aspectRatio?: { width: number; height: number };
  thread?: ThreadItem[];
}

export interface ThreadsTargetOptions extends BaseTargetOptions {
  poll?: { options: string[] };
  quote_post_id?: string;
  location_id?: string;
  topic_tag?: string;
  reply_control?: "everyone" | "accounts_you_follow" | "mentioned_only";
  link_attachment?: string;
  thread?: ThreadItem[];
}

export interface TelegramTargetOptions extends BaseTargetOptions {
  parse_mode?: "HTML" | "MarkdownV2";
  disable_preview?: boolean;
  protect_content?: boolean;
  silent?: boolean;
}

export interface SnapchatTargetOptions extends BaseTargetOptions {
  content_type: "spotlight" | "saved_story";
  locale?: string;
}

export interface GoogleBusinessTargetOptions extends BaseTargetOptions {
  topic_type?: "STANDARD" | "EVENT" | "OFFER" | "ALERT";
  language_code?: string;
  call_to_action?: {
    type: "BOOK" | "ORDER" | "SHOP" | "LEARN_MORE" | "SIGN_UP" | "CALL";
    url?: string;
  };
  event?: Record<string, unknown>;
  offer?: Record<string, unknown>;
}

export interface WhatsAppTargetOptions extends BaseTargetOptions {
  /** One attachment. Audio attachments cannot be combined with text content. */
  media?: PostMediaInput[];
  /** Recipient in E.164 digits-only format, without a leading `+`. */
  to: string;
  preview_url?: boolean;
  template_name?: string;
  template_language?: string;
  template_components?: Array<Record<string, unknown>>;
  interactive?: Record<string, unknown>;
  contacts?: Array<Record<string, unknown>>;
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  reaction?: { message_id: string; emoji: string };
}

export interface MastodonTargetOptions extends BaseTargetOptions {
  visibility?: "public" | "unlisted" | "private" | "direct";
  spoiler_text?: string;
  sensitive?: boolean;
  language?: string;
  in_reply_to_id?: string;
  quoted_status_id?: string;
  poll?: {
    options: string[];
    expires_in: number;
    multiple?: boolean;
    hide_totals?: boolean;
  };
}

export interface DiscordTargetOptions extends BaseTargetOptions {
  username?: string;
  avatar_url?: string;
  embeds?: Array<Record<string, unknown>>;
  tts?: boolean;
  /** Existing forum/media thread to execute the webhook in. */
  thread_id?: string;
  /** Creates a new forum/media thread; mutually exclusive with thread_id. */
  thread_name?: string;
  applied_tags?: string[];
  poll?: {
    question: { text: string };
    answers: Array<{
      poll_media: {
        text: string;
        emoji?: { id?: string; name?: string };
      };
    }>;
    /** Poll duration in hours (maximum 32 days). */
    duration?: number;
    allow_multiselect?: boolean;
    layout_type?: 1;
  };
}

export interface SmsTargetOptions extends BaseTargetOptions {
  from_number?: string;
  phone_numbers?: string[];
}

export interface BeehiivTargetOptions extends BaseTargetOptions {
  subject?: string;
  preview_text?: string;
  content_html?: string;
  content_tags?: string[];
  thumbnail_image_url?: string;
  scheduled_at?: string;
}

export interface ConvertKitTargetOptions extends BaseTargetOptions {
  /** Kit broadcasts do not accept Relay media attachments. */
  media?: never;
  subject?: string;
  preview_text?: string;
  content_html?: string;
  email_template_id?: number;
  public?: boolean;
  published_at?: string;
  /** ISO timestamp for a scheduled broadcast. Use top-level `scheduled_at: "draft"` for a local Relay draft. */
  send_at?: string;
}

export interface MailchimpTargetOptions extends BaseTargetOptions {
  /** Mailchimp campaign content must be supplied as text or HTML. */
  media?: never;
  subject?: string;
  preview_text?: string;
  content_html?: string;
  list_id?: string;
  from_email?: string;
  from_name?: string;
  reply_to?: string;
  schedule_time?: string;
}

export interface ListmonkTargetOptions extends BaseTargetOptions {
  /** Listmonk campaign content must be supplied as text or HTML. */
  media?: never;
  subject?: string;
  content_html?: string;
  alt_body?: string;
  list_id?: number;
  from_email?: string;
  template_id?: number;
  tags?: string[];
  headers?: Record<string, string>;
  send_at?: string;
}

export interface SlackTargetOptions extends BaseTargetOptions {
  blocks?: Array<Record<string, unknown>>;
  attachments?: Array<Record<string, unknown>>;
  thread_ts?: string;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

/**
 * Platform option shapes accepted under account/workspace compatibility alias
 * keys after RelayAPI resolves the alias to its concrete platform.
 */
export type PlatformTargetOptions =
  | TwitterTargetOptions
  | InstagramTargetOptions
  | FacebookTargetOptions
  | LinkedInTargetOptions
  | TikTokTargetOptions
  | YouTubeTargetOptions
  | PinterestTargetOptions
  | RedditTargetOptions
  | BlueskyTargetOptions
  | ThreadsTargetOptions
  | TelegramTargetOptions
  | SnapchatTargetOptions
  | GoogleBusinessTargetOptions
  | WhatsAppTargetOptions
  | MastodonTargetOptions
  | DiscordTargetOptions
  | SmsTargetOptions
  | BeehiivTargetOptions
  | ConvertKitTargetOptions
  | MailchimpTargetOptions
  | ListmonkTargetOptions
  | SlackTargetOptions;

export interface PublisherTargetOptions {
  twitter?: TwitterTargetOptions;
  instagram?: InstagramTargetOptions;
  facebook?: FacebookTargetOptions;
  linkedin?: LinkedInTargetOptions;
  tiktok?: TikTokTargetOptions;
  youtube?: YouTubeTargetOptions;
  pinterest?: PinterestTargetOptions;
  reddit?: RedditTargetOptions;
  bluesky?: BlueskyTargetOptions;
  threads?: ThreadsTargetOptions;
  telegram?: TelegramTargetOptions;
  snapchat?: SnapchatTargetOptions;
  googlebusiness?: GoogleBusinessTargetOptions;
  whatsapp?: WhatsAppTargetOptions;
  mastodon?: MastodonTargetOptions;
  discord?: DiscordTargetOptions;
  sms?: SmsTargetOptions;
  beehiiv?: BeehiivTargetOptions;
  convertkit?: ConvertKitTargetOptions;
  mailchimp?: MailchimpTargetOptions;
  listmonk?: ListmonkTargetOptions;
  slack?: SlackTargetOptions;
  /** Account and workspace target IDs are compatibility aliases. */
  [target: string]: PlatformTargetOptions | undefined;
}
