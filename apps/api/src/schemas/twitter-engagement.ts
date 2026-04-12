import { z } from "@hono/zod-openapi";

// --- Retweet ---

export const RetweetBody = z.object({
	account_id: z.string().describe("Twitter account ID"),
	tweet_id: z.string().describe("Tweet ID to retweet"),
});

// --- Bookmark ---

export const BookmarkBody = z.object({
	account_id: z.string().describe("Twitter account ID"),
	tweet_id: z.string().describe("Tweet ID to bookmark"),
});

// --- Follow ---

export const FollowBody = z.object({
	account_id: z.string().describe("Twitter account ID"),
	target_user_id: z.string().describe("User ID to follow"),
});

// --- Common response ---

export const EngagementResponse = z.object({
	success: z.boolean().describe("Whether the action succeeded"),
	error: z
		.object({
			code: z.string().describe("Error code (e.g. ACCOUNT_NOT_FOUND, TOKEN_MISSING, TWITTER_API_ERROR)"),
			message: z.string().describe("Human-readable error message"),
			twitter_error_code: z.number().optional().describe("Twitter API error code if available"),
		})
		.optional()
		.describe("Error details when success is false"),
	data: z
		.object({
			retweeted: z.boolean().optional(),
			bookmarked: z.boolean().optional(),
			following: z.boolean().optional(),
			pending_follow: z.boolean().optional(),
		})
		.optional()
		.describe("Action result data from Twitter API"),
});
