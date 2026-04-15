import { z } from "@hono/zod-openapi";
import { PlatformEnum, paginatedResponse } from "./common";

export const AccountResponse = z.object({
	id: z.string().describe("Account ID"),
	platform: PlatformEnum,
	platform_account_id: z.string(),
	username: z.string().nullable(),
	display_name: z.string().nullable(),
	avatar_url: z.string().nullable(),
	metadata: z.record(z.string(), z.any()).nullable(),
	workspace: z
		.object({ id: z.string(), name: z.string() })
		.nullable()
		.describe("Account workspace"),
	connected_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const AccountListResponse = paginatedResponse(AccountResponse);

const SyncStatus = z.object({
	enabled: z.boolean(),
	last_sync_at: z.string().datetime().nullable(),
	next_sync_at: z.string().datetime().nullable(),
	total_posts_synced: z.number(),
	total_sync_runs: z.number(),
	last_error: z.string().nullable(),
	last_error_at: z.string().datetime().nullable(),
	consecutive_errors: z.number(),
	rate_limit_reset_at: z.string().datetime().nullable(),
});

const AccountHealthItem = z.object({
	id: z.string(),
	platform: PlatformEnum,
	username: z.string().nullable(),
	display_name: z.string().nullable(),
	avatar_url: z.string().nullable(),
	healthy: z.boolean(),
	token_expires_at: z.string().datetime().nullable(),
	scopes: z.array(z.string()),
	workspace: z
		.object({ id: z.string(), name: z.string() })
		.nullable(),
	sync: SyncStatus.nullable().optional(),
	error: z
		.object({
			code: z.string(),
			message: z.string(),
		})
		.optional(),
});

export const AccountHealthResponse = paginatedResponse(AccountHealthItem);

// --- Update account ---

export const UpdateAccountBody = z.object({
	metadata: z.record(z.string(), z.any()).optional(),
	display_name: z.string().optional(),
	workspace_id: z.string().nullable().optional().describe("Workspace ID (null to unassign)"),
});

// --- Platform-specific resource schemas ---

const FacebookPage = z.object({
	id: z.string(),
	name: z.string(),
	access_token: z.string().optional(),
});

export const FacebookPagesResponse = z.object({
	data: z.array(FacebookPage),
});

export const SetFacebookPageBody = z.object({
	page_id: z.string().describe("Facebook page ID to set as default"),
});

const LinkedInOrg = z.object({
	id: z.string(),
	name: z.string(),
	vanity_name: z.string().nullable(),
});

export const LinkedInOrgsResponse = z.object({
	data: z.array(LinkedInOrg),
});

export const SetLinkedInOrgBody = z.object({
	organization_id: z.string().describe("LinkedIn organization ID"),
	account_type: z
		.enum(["personal", "organization"])
		.describe("Account type to switch to"),
});

const PinterestBoard = z.object({
	id: z.string(),
	name: z.string(),
	url: z.string().nullable(),
});

export const PinterestBoardsResponse = z.object({
	data: z.array(PinterestBoard),
});

export const SetPinterestBoardBody = z.object({
	board_id: z.string().describe("Pinterest board ID to set as default"),
});

const RedditSubreddit = z.object({
	name: z.string(),
	display_name: z.string(),
	subscribers: z.number().nullable(),
});

export const RedditSubredditsResponse = z.object({
	data: z.array(RedditSubreddit),
});

export const SetRedditSubredditBody = z.object({
	subreddit: z.string().describe("Subreddit name to set as default"),
});

const RedditFlair = z.object({
	id: z.string(),
	text: z.string(),
});

export const RedditFlairsResponse = z.object({
	data: z.array(RedditFlair),
});

const GmbLocation = z.object({
	id: z.string(),
	name: z.string(),
	address: z.string().nullable(),
});

export const GmbLocationsResponse = z.object({
	data: z.array(GmbLocation),
});

export const SetGmbLocationBody = z.object({
	location_id: z
		.string()
		.describe("Google My Business location ID to set as default"),
});

const YouTubePlaylist = z.object({
	id: z.string(),
	title: z.string(),
	description: z.string().nullable(),
	privacy: z.enum(["public", "private", "unlisted"]),
	item_count: z.number(),
	thumbnail_url: z.string().nullable(),
});

export const YouTubePlaylistsResponse = z.object({
	data: z.array(YouTubePlaylist),
});

export const SetYouTubePlaylistBody = z.object({
	playlist_id: z.string().describe("YouTube playlist ID to set as default"),
	playlist_name: z
		.string()
		.optional()
		.describe("Playlist name for display purposes"),
});

export const TikTokCreatorInfoResponse = z.object({
	creator_avatar_url: z.string().describe("Creator avatar URL"),
	creator_username: z.string().describe("Creator username"),
	creator_nickname: z.string().describe("Creator display name"),
	privacy_level_options: z.array(z.string()).describe("Available privacy levels for this account"),
	comment_disabled: z.boolean().describe("Whether comments are disabled by default"),
	duet_disabled: z.boolean().describe("Whether duets are disabled by default"),
	stitch_disabled: z.boolean().describe("Whether stitches are disabled by default"),
	max_video_post_duration_sec: z.number().describe("Maximum video duration in seconds"),
});
