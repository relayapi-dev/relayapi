import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
	createDb,
	socialAccounts,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { API_VERSIONS, GRAPH_BASE } from "../config/api-versions";
import { ErrorResponse } from "../schemas/common";
import {
	CommentActionResponse,
	CommentIdParams,
	CommentsQuery,
	CommentsResponse,
	PostCommentsParams,
	PostsWithCommentsResponse,
	PrivateReplyBody,
	ReplyCommentBody,
	ReplyReviewBody,
	ReviewActionResponse,
	ReviewIdParams,
	ReviewsListResponse,
	ReviewsQuery,
} from "../schemas/inbox";
import type { Env, Variables } from "../types";
import { notifyRealtime } from "../lib/notify-post-update";
import { mapConcurrently } from "../lib/concurrency";
import { getAccount, getAccountsForOrg, igGraphHost } from "./inbox-helpers";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Platform-specific comment fetchers
// ---------------------------------------------------------------------------

interface CommentData {
	id: string;
	platform: string;
	author_name: string;
	author_avatar: string | null;
	text: string;
	created_at: string;
	likes?: number;
	replies_count?: number;
	hidden?: boolean;
	parent_id?: string | null;
}

async function fetchFacebookComments(
	token: string,
	postId?: string,
	cursor?: string,
	limit = 20,
): Promise<{ data: CommentData[]; next_cursor: string | null }> {
	try {
		const objectId = postId ?? "me";
		// Include nested replies via comments subfield (up to 5 per comment)
		let url = `${GRAPH_BASE.facebook}/${objectId}/comments?access_token=${encodeURIComponent(token)}&limit=${limit}&fields=id,from{name,picture},message,created_time,like_count,comment_count,is_hidden,comments.limit(5){id,from{name,picture},message,created_time,like_count,is_hidden}`;
		if (cursor) {
			url += `&after=${encodeURIComponent(cursor)}`;
		}
		// Facebook Graph API: List comments on an object
		// Docs: https://developers.facebook.com/docs/graph-api/reference/object/comments/#reading
		const res = await fetch(url);
		if (!res.ok) return { data: [], next_cursor: null };
		const json = (await res.json()) as {
			data: Array<{
				id: string;
				from?: { name: string; picture?: { data?: { url?: string } } };
				message: string;
				created_time: string;
				like_count?: number;
				comment_count?: number;
				is_hidden?: boolean;
				comments?: {
					data: Array<{
						id: string;
						from?: { name: string; picture?: { data?: { url?: string } } };
						message: string;
						created_time: string;
						like_count?: number;
						is_hidden?: boolean;
					}>;
				};
			}>;
			paging?: { cursors?: { after?: string }; next?: string };
		};
		const comments: CommentData[] = [];
		for (const c of json.data ?? []) {
			comments.push({
				id: c.id,
				platform: "facebook" as const,
				author_name: c.from?.name ?? "Unknown",
				author_avatar: c.from?.picture?.data?.url ?? null,
				text: c.message,
				created_at: c.created_time,
				likes: c.like_count ?? 0,
				replies_count: c.comment_count ?? 0,
				hidden: c.is_hidden ?? false,
				parent_id: null,
			});
			// Flatten nested replies with parent_id
			for (const r of c.comments?.data ?? []) {
				comments.push({
					id: r.id,
					platform: "facebook" as const,
					author_name: r.from?.name ?? "Unknown",
					author_avatar: r.from?.picture?.data?.url ?? null,
					text: r.message,
					created_at: r.created_time,
					likes: r.like_count ?? 0,
					replies_count: 0,
					hidden: r.is_hidden ?? false,
					parent_id: c.id,
				});
			}
		}
		const nextCursor = json.paging?.next ? (json.paging.cursors?.after ?? null) : null;
		return { data: comments, next_cursor: nextCursor };
	} catch {
		return { data: [], next_cursor: null };
	}
}

async function fetchInstagramComments(
	token: string,
	postId?: string,
	cursor?: string,
	limit = 20,
	accountUsername?: string,
): Promise<{ data: CommentData[]; next_cursor: string | null }> {
	try {
		if (!postId) return { data: [], next_cursor: null };
		const host = igGraphHost(token);
		// Instagram Graph API: GET comments on a media object, including nested replies
		// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments/#reading
		// Host: graph.instagram.com (Instagram Login) or graph.facebook.com (Facebook Login)
		let url = `https://${host}/${API_VERSIONS.meta_graph}/${postId}/comments?access_token=${encodeURIComponent(token)}&limit=${limit}&fields=id,from,text,timestamp,like_count,hidden,replies{id,from,text,timestamp,like_count,hidden}`;
		if (cursor) {
			url += `&after=${encodeURIComponent(cursor)}`;
		}
		const res = await fetch(url);
		if (!res.ok) return { data: [], next_cursor: null };
		const json = (await res.json()) as {
			data: Array<{
				id: string;
				from?: { username: string; profile_picture_url?: string };
				text: string;
				timestamp: string;
				like_count?: number;
				replies?: {
					data: Array<{
						id: string;
						from?: { username: string; profile_picture_url?: string };
						text: string;
						timestamp: string;
						like_count?: number;
						hidden?: boolean;
					}>;
				};
				hidden?: boolean;
			}>;
			paging?: { cursors?: { after?: string }; next?: string };
		};

		// Collect all reply IDs so we can skip them from the top level —
		// Instagram can return the business account's own replies both at
		// the top level AND nested under the parent comment.
		const replyIds = new Set<string>();
		for (const c of json.data ?? []) {
			for (const r of c.replies?.data ?? []) {
				replyIds.add(r.id);
			}
		}

		const comments: CommentData[] = [];
		for (const c of json.data ?? []) {
			// Skip top-level entries that are actually replies (deduplicate)
			if (replyIds.has(c.id)) continue;

			const repliesData = c.replies?.data ?? [];
			comments.push({
				id: c.id,
				platform: "instagram" as const,
				author_name: c.from?.username ?? accountUsername ?? "Unknown",
				author_avatar: c.from?.profile_picture_url ?? null,
				text: c.text,
				created_at: c.timestamp,
				likes: c.like_count ?? 0,
				replies_count: repliesData.length,
				hidden: c.hidden ?? false,
				parent_id: null,
			});
			// Flatten nested replies with parent_id
			for (const r of repliesData) {
				comments.push({
					id: r.id,
					platform: "instagram" as const,
					author_name: r.from?.username ?? accountUsername ?? "Unknown",
					author_avatar: r.from?.profile_picture_url ?? null,
					text: r.text,
					created_at: r.timestamp,
					likes: r.like_count ?? 0,
					replies_count: 0,
					hidden: r.hidden ?? false,
					parent_id: c.id,
				});
			}
		}
		const nextCursor = json.paging?.next ? (json.paging.cursors?.after ?? null) : null;
		return { data: comments, next_cursor: nextCursor };
	} catch {
		return { data: [], next_cursor: null };
	}
}

async function fetchYouTubeComments(
	token: string,
	videoId?: string,
	cursor?: string,
	limit = 20,
): Promise<{ data: CommentData[]; next_cursor: string | null }> {
	try {
		if (!videoId) return { data: [], next_cursor: null };
		// Include replies in the response
		let url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet,replies&videoId=${encodeURIComponent(videoId)}&maxResults=${limit}`;
		if (cursor) {
			url += `&pageToken=${encodeURIComponent(cursor)}`;
		}
		// YouTube Data API: List comment threads for a video (with replies)
		// Docs: https://developers.google.com/youtube/v3/docs/commentThreads/list
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!res.ok) return { data: [], next_cursor: null };
		const json = (await res.json()) as {
			items: Array<{
				id: string;
				snippet: {
					topLevelComment: {
						id: string;
						snippet: {
							authorDisplayName: string;
							authorProfileImageUrl?: string;
							textOriginal: string;
							publishedAt: string;
							likeCount: number;
						};
					};
					totalReplyCount: number;
				};
				replies?: {
					comments: Array<{
						id: string;
						snippet: {
							authorDisplayName: string;
							authorProfileImageUrl?: string;
							textOriginal: string;
							publishedAt: string;
							likeCount: number;
							parentId: string;
						};
					}>;
				};
			}>;
			nextPageToken?: string;
		};
		const comments: CommentData[] = [];
		for (const item of json.items ?? []) {
			const s = item.snippet.topLevelComment.snippet;
			const parentId = item.snippet.topLevelComment.id;
			comments.push({
				id: parentId,
				platform: "youtube" as const,
				author_name: s.authorDisplayName,
				author_avatar: s.authorProfileImageUrl ?? null,
				text: s.textOriginal,
				created_at: s.publishedAt,
				likes: s.likeCount ?? 0,
				replies_count: item.snippet.totalReplyCount ?? 0,
				parent_id: null,
			});
			// Flatten nested replies
			for (const r of item.replies?.comments ?? []) {
				comments.push({
					id: r.id,
					platform: "youtube" as const,
					author_name: r.snippet.authorDisplayName,
					author_avatar: r.snippet.authorProfileImageUrl ?? null,
					text: r.snippet.textOriginal,
					created_at: r.snippet.publishedAt,
					likes: r.snippet.likeCount ?? 0,
					replies_count: 0,
					parent_id: parentId,
				});
			}
		}
		return { data: comments, next_cursor: json.nextPageToken ?? null };
	} catch {
		return { data: [], next_cursor: null };
	}
}

// ---------------------------------------------------------------------------
// Post context types & fetchers — used by listComments to discover posts first
// ---------------------------------------------------------------------------

interface PostContext {
	id: string;
	platform: string;
	account_id: string;
	account_avatar_url?: string | null;
	text: string | null;
	thumbnail_url: string | null;
	platform_url: string | null;
	created_at: string;
	comments_count: number;
}

interface CommentWithPost extends CommentData {
	post_id: string;
	post_text: string | null;
	post_thumbnail_url: string | null;
	post_platform_url: string | null;
	account_id: string;
	account_avatar_url: string | null;
}

async function fetchFacebookPosts(
	token: string,
	limit = 10,
): Promise<PostContext[]> {
	try {
		// Facebook Graph API: List published posts on a Page
		// Docs: https://developers.facebook.com/docs/graph-api/reference/page/published_posts/
		const url = `${GRAPH_BASE.facebook}/me/published_posts?access_token=${encodeURIComponent(token)}&limit=${limit}&fields=id,message,created_time,full_picture,permalink_url,comments.summary(true)`;
		const res = await fetch(url);
		if (!res.ok) return [];
		const json = (await res.json()) as {
			data: Array<{
				id: string;
				message?: string;
				created_time: string;
				full_picture?: string;
				permalink_url?: string;
				comments?: { summary?: { total_count?: number } };
			}>;
		};
		return (json.data ?? []).map((p) => ({
			id: p.id,
			platform: "facebook",
			account_id: "",
			text: p.message ?? null,
			thumbnail_url: p.full_picture ?? null,
			platform_url: p.permalink_url ?? null,
			created_at: p.created_time,
			comments_count: p.comments?.summary?.total_count ?? 0,
		}));
	} catch {
		return [];
	}
}

async function fetchInstagramPosts(
	token: string,
	limit = 10,
): Promise<PostContext[]> {
	try {
		const host = igGraphHost(token);
		// Instagram Graph API: List media for the authenticated user
		// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
		const url = `https://${host}/${API_VERSIONS.meta_graph}/me/media?access_token=${encodeURIComponent(token)}&limit=${limit}&fields=id,caption,timestamp,thumbnail_url,media_url,permalink,comments_count`;
		const res = await fetch(url);
		if (!res.ok) return [];
		const json = (await res.json()) as {
			data: Array<{
				id: string;
				caption?: string;
				timestamp: string;
				thumbnail_url?: string;
				media_url?: string;
				permalink?: string;
				comments_count?: number;
			}>;
		};
		return (json.data ?? []).map((p) => ({
			id: p.id,
			platform: "instagram",
			account_id: "",
			text: p.caption ?? null,
			thumbnail_url: p.thumbnail_url ?? p.media_url ?? null,
			platform_url: p.permalink ?? null,
			created_at: p.timestamp,
			comments_count: p.comments_count ?? 0,
		}));
	} catch {
		return [];
	}
}

async function fetchYouTubePosts(
	token: string,
	limit = 10,
): Promise<PostContext[]> {
	try {
		// YouTube Data API: Get channel's uploads playlist
		// Docs: https://developers.google.com/youtube/v3/docs/channels/list
		const channelRes = await fetch(
			"https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true",
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		if (!channelRes.ok) return [];
		const channelJson = (await channelRes.json()) as {
			items: Array<{
				contentDetails: { relatedPlaylists: { uploads: string } };
			}>;
		};
		const uploadsPlaylistId =
			channelJson.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
		if (!uploadsPlaylistId) return [];

		// YouTube Data API: List playlist items (recent uploads)
		// Docs: https://developers.google.com/youtube/v3/docs/playlistItems/list
		const videosRes = await fetch(
			`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(uploadsPlaylistId)}&maxResults=${limit}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		if (!videosRes.ok) return [];
		const videosJson = (await videosRes.json()) as {
			items: Array<{
				contentDetails: { videoId: string };
				snippet: {
					title: string;
					publishedAt: string;
					thumbnails?: { default?: { url?: string } };
				};
			}>;
		};
		return (videosJson.items ?? []).map((v) => ({
			id: v.contentDetails.videoId,
			platform: "youtube",
			account_id: "",
			text: v.snippet.title ?? null,
			thumbnail_url: v.snippet.thumbnails?.default?.url ?? null,
			platform_url: `https://www.youtube.com/watch?v=${v.contentDetails.videoId}`,
			created_at: v.snippet.publishedAt,
			comments_count: 0,
		}));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// KV cache for post lists — avoids hammering platform APIs on every page load
// ---------------------------------------------------------------------------

const POSTS_CACHE_TTL = 300; // 5 minutes

/** Delete inbox post caches for all accounts in an org so data is fresh on next load */
async function invalidateInboxCache(
	kv: KVNamespace,
	db: ReturnType<typeof createDb>,
	orgId: string,
	env?: Env,
) {
	try {
		// Only need account IDs — skip token decryption
		const accounts = await db
			.select({ id: socialAccounts.id })
			.from(socialAccounts)
			.where(eq(socialAccounts.organizationId, orgId));
		await Promise.all(
			accounts.map((a) => kv.delete(`inbox-posts:${a.id}`).catch(() => {})),
		);
	} catch {
		// non-critical
	}
	// Push real-time update to connected dashboard clients
	if (env) {
		await notifyRealtime(env, orgId, { type: "inbox.updated" }).catch(() => {});
	}
}

async function getCachedPosts(
	kv: KVNamespace,
	accountId: string,
	platform: string,
	token: string,
	limit = 10,
): Promise<PostContext[]> {
	const cacheKey = `inbox-posts:${accountId}`;
	try {
		const cached = await kv.get<PostContext[]>(cacheKey, "json");
		if (cached) return cached;
	} catch {
		// cache miss
	}

	let posts: PostContext[];
	switch (platform) {
		case "facebook":
			posts = await fetchFacebookPosts(token, limit);
			break;
		case "instagram":
			posts = await fetchInstagramPosts(token, limit);
			break;
		case "youtube":
			posts = await fetchYouTubePosts(token, limit);
			break;
		default:
			posts = [];
	}

	// Stamp account_id on each post
	for (const p of posts) {
		p.account_id = accountId;
	}

	if (posts.length > 0) {
		try {
			await kv.put(cacheKey, JSON.stringify(posts), {
				expirationTtl: POSTS_CACHE_TTL,
			});
		} catch {
			// non-critical
		}
	}
	return posts;
}

// =====================
// Comments — Route definitions
// =====================

const listComments = createRoute({
	operationId: "listComments",
	method: "get",
	path: "/comments",
	tags: ["Inbox"],
	summary: "List comments across platforms",
	security: [{ Bearer: [] }],
	request: { query: CommentsQuery },
	responses: {
		200: {
			description: "Comments list",
			content: { "application/json": { schema: CommentsResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getPostComments = createRoute({
	operationId: "getPostComments",
	method: "get",
	path: "/comments/{post_id}",
	tags: ["Inbox"],
	summary: "Get comments for a specific post",
	security: [{ Bearer: [] }],
	request: { params: PostCommentsParams, query: CommentsQuery },
	responses: {
		200: {
			description: "Post comments",
			content: { "application/json": { schema: CommentsResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const listPostsByComments = createRoute({
	operationId: "listPostsByComments",
	method: "get",
	path: "/comments/by-post",
	tags: ["Inbox"],
	summary: "List posts with comment counts",
	security: [{ Bearer: [] }],
	request: { query: CommentsQuery },
	responses: {
		200: {
			description: "Posts with comment counts",
			content: {
				"application/json": { schema: PostsWithCommentsResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const replyToComment = createRoute({
	operationId: "replyToComment",
	method: "post",
	path: "/comments/{post_id}/reply",
	tags: ["Inbox"],
	summary: "Reply to a comment",
	security: [{ Bearer: [] }],
	request: {
		params: PostCommentsParams,
		body: {
			content: { "application/json": { schema: ReplyCommentBody } },
		},
	},
	responses: {
		200: {
			description: "Reply result",
			content: {
				"application/json": { schema: CommentActionResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteComment = createRoute({
	operationId: "deleteComment",
	method: "delete",
	path: "/comments/{comment_id}",
	tags: ["Inbox"],
	summary: "Delete a comment",
	security: [{ Bearer: [] }],
	request: { params: CommentIdParams },
	responses: {
		200: {
			description: "Delete result",
			content: {
				"application/json": { schema: CommentActionResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const hideComment = createRoute({
	operationId: "hideComment",
	method: "post",
	path: "/comments/{comment_id}/hide",
	tags: ["Inbox"],
	summary: "Hide a comment",
	security: [{ Bearer: [] }],
	request: { params: CommentIdParams },
	responses: {
		200: {
			description: "Hide result",
			content: {
				"application/json": { schema: CommentActionResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const unhideComment = createRoute({
	operationId: "unhideComment",
	method: "delete",
	path: "/comments/{comment_id}/hide",
	tags: ["Inbox"],
	summary: "Unhide a comment",
	security: [{ Bearer: [] }],
	request: { params: CommentIdParams },
	responses: {
		200: {
			description: "Unhide result",
			content: {
				"application/json": { schema: CommentActionResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const likeComment = createRoute({
	operationId: "likeComment",
	method: "post",
	path: "/comments/{comment_id}/like",
	tags: ["Inbox"],
	summary: "Like a comment",
	security: [{ Bearer: [] }],
	request: { params: CommentIdParams },
	responses: {
		200: {
			description: "Like result",
			content: {
				"application/json": { schema: CommentActionResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const unlikeComment = createRoute({
	operationId: "unlikeComment",
	method: "delete",
	path: "/comments/{comment_id}/like",
	tags: ["Inbox"],
	summary: "Unlike a comment",
	security: [{ Bearer: [] }],
	request: { params: CommentIdParams },
	responses: {
		200: {
			description: "Unlike result",
			content: {
				"application/json": { schema: CommentActionResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const privateReply = createRoute({
	operationId: "privateReplyToComment",
	method: "post",
	path: "/comments/{comment_id}/private-reply",
	tags: ["Inbox"],
	summary: "Send a private reply to a commenter",
	security: [{ Bearer: [] }],
	request: {
		params: CommentIdParams,
		body: {
			content: { "application/json": { schema: PrivateReplyBody } },
		},
	},
	responses: {
		200: {
			description: "Private reply result",
			content: {
				"application/json": { schema: CommentActionResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// =====================
// Reviews — Route definitions
// =====================

const listReviews = createRoute({
	operationId: "listReviews",
	method: "get",
	path: "/reviews",
	tags: ["Inbox"],
	summary: "List reviews across platforms",
	security: [{ Bearer: [] }],
	request: { query: ReviewsQuery },
	responses: {
		200: {
			description: "Reviews list",
			content: {
				"application/json": { schema: ReviewsListResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const replyToReview = createRoute({
	operationId: "replyToReview",
	method: "post",
	path: "/reviews/{review_id}/reply",
	tags: ["Inbox"],
	summary: "Reply to a review",
	security: [{ Bearer: [] }],
	request: {
		params: ReviewIdParams,
		body: {
			content: { "application/json": { schema: ReplyReviewBody } },
		},
	},
	responses: {
		200: {
			description: "Reply result",
			content: {
				"application/json": { schema: ReviewActionResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteReviewReply = createRoute({
	operationId: "deleteReviewReply",
	method: "delete",
	path: "/reviews/{review_id}/reply",
	tags: ["Inbox"],
	summary: "Delete a review reply",
	security: [{ Bearer: [] }],
	request: { params: ReviewIdParams },
	responses: {
		200: {
			description: "Delete result",
			content: {
				"application/json": { schema: ReviewActionResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// =====================
// Comments — Handlers
// =====================

app.openapi(listComments, async (c) => {
	const orgId = c.get("orgId");
	const { platform, account_id, cursor, limit } = c.req.valid("query");
	const db = c.get("db");
	const maxPostsToInspect = Math.max(limit * 3, 30);

	const accounts = await getAccountsForOrg(db, orgId, { platform, accountId: account_id }, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (accounts.length === 0) {
		return c.json({ data: [], next_cursor: null, has_more: false }, 200);
	}

	// 1. Fetch recent posts for each account (cached in KV)
	const MAX_POSTS_PER_ACCOUNT = 5;
	const postsByAccount = await mapConcurrently(
		accounts.filter((a) => a.accessToken),
		6,
		async (account) => {
			try {
				return await getCachedPosts(
					c.env.KV,
					account.id,
					account.platform,
					account.accessToken!,
					MAX_POSTS_PER_ACCOUNT,
				);
			} catch {
				return [] as PostContext[];
			}
		},
	);

	const allPosts: PostContext[] = [];
	for (const result of postsByAccount) {
		allPosts.push(...result);
	}

	if (allPosts.length === 0) {
		return c.json({ data: [], next_cursor: null, has_more: false }, 200);
	}

	allPosts.sort(
		(a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
	);
	if (allPosts.length > maxPostsToInspect) {
		allPosts.length = maxPostsToInspect;
	}

	// 2. For each post, fetch comments in parallel
	const commentsPerPost = Math.max(Math.ceil(limit / allPosts.length), 5);
	const accountById = new Map(accounts.map((account) => [account.id, account]));
	const commentResults = await mapConcurrently(allPosts, 8, async (post) => {
		const account = accountById.get(post.account_id);
		if (!account?.accessToken) return [] as CommentWithPost[];

		try {
			let result: { data: CommentData[]; next_cursor: string | null };
			switch (post.platform) {
				case "facebook":
					result = await fetchFacebookComments(account.accessToken, post.id, undefined, commentsPerPost);
					break;
				case "instagram":
					result = await fetchInstagramComments(account.accessToken, post.id, undefined, commentsPerPost, account.username ?? undefined);
					break;
				case "youtube":
					result = await fetchYouTubeComments(account.accessToken, post.id, undefined, commentsPerPost);
					break;
				default:
					result = { data: [], next_cursor: null };
			}

			return result.data.map((comment) => ({
				...comment,
				post_id: post.id,
				post_text: post.text ? post.text.slice(0, 120) : null,
				post_thumbnail_url: post.thumbnail_url,
				post_platform_url: post.platform_url,
				account_id: post.account_id,
				account_avatar_url: account.avatarUrl ?? null,
			})) as CommentWithPost[];
		} catch {
			return [] as CommentWithPost[];
		}
	});

	const allComments: CommentWithPost[] = [];
	for (const result of commentResults) {
		allComments.push(...result);
	}

	// 3. Sort by created_at descending
	allComments.sort(
		(a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
	);

	// 4. Time-based cursor pagination
	let filtered = allComments;
	if (cursor) {
		const cursorTime = new Date(cursor).getTime();
		filtered = allComments.filter(
			(c) => new Date(c.created_at).getTime() < cursorTime,
		);
	}

	const page = filtered.slice(0, limit);
	const lastItem = page[page.length - 1];
	const nextCursor =
		lastItem && filtered.length > limit ? lastItem.created_at : null;

	return c.json(
		{
			data: page as any,
			next_cursor: nextCursor,
			has_more: nextCursor !== null,
		},
		200,
	);
});

// ---------------------------------------------------------------------------
// By-post view: returns posts with comment counts (no comment fetching)
// ---------------------------------------------------------------------------

app.openapi(listPostsByComments, async (c) => {
	const orgId = c.get("orgId");
	const { platform, account_id, cursor, limit } = c.req.valid("query");
	const db = c.get("db");

	const accounts = await getAccountsForOrg(db, orgId, { platform, accountId: account_id }, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (accounts.length === 0) {
		return c.json({ data: [], next_cursor: null, has_more: false }, 200);
	}

	const avatarByAccount = new Map<string, string | null>();
	for (const a of accounts) {
		avatarByAccount.set(a.id, a.avatarUrl ?? null);
	}

	const postsByAccount = await mapConcurrently(
		accounts.filter((a) => a.accessToken),
		6,
		async (account) => {
			try {
				return await getCachedPosts(c.env.KV, account.id, account.platform, account.accessToken!, 10);
			} catch {
				return [] as PostContext[];
			}
		},
	);

	const allPosts: PostContext[] = [];
	for (const result of postsByAccount) {
		for (const p of result) {
			p.account_avatar_url = avatarByAccount.get(p.account_id) ?? null;
		}
		allPosts.push(...result);
	}

	// Sort by created_at descending
	allPosts.sort(
		(a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
	);

	// Time-based cursor pagination
	let filtered = allPosts;
	if (cursor) {
		const cursorTime = new Date(cursor).getTime();
		filtered = allPosts.filter(
			(p) => new Date(p.created_at).getTime() < cursorTime,
		);
	}

	const page = filtered.slice(0, limit);
	const lastItem = page[page.length - 1];
	const nextCursor =
		lastItem && filtered.length > limit ? lastItem.created_at : null;

	return c.json(
		{
			data: page.map((p) => ({
				id: p.id,
				platform: p.platform,
				account_id: p.account_id,
				account_avatar_url: p.account_avatar_url ?? null,
				text: p.text ? p.text.slice(0, 120) : null,
				thumbnail_url: p.thumbnail_url,
				platform_url: p.platform_url,
				created_at: p.created_at,
				comments_count: p.comments_count,
			})) as any,
			next_cursor: nextCursor,
			has_more: nextCursor !== null,
		},
		200,
	);
});

app.openapi(getPostComments, async (c) => {
	const orgId = c.get("orgId");
	const { post_id } = c.req.valid("param");
	const { platform, account_id, cursor, limit } = c.req.valid("query");
	const db = c.get("db");

	const accounts = await getAccountsForOrg(db, orgId, { platform, accountId: account_id }, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (accounts.length === 0) {
		return c.json(
			{ data: [], post_id, next_cursor: null, has_more: false },
			200,
		);
	}

	// Use the first matching account that has a token
	const account = accounts.find((a) => a.accessToken);
	if (!account) {
		return c.json(
			{ data: [], post_id, next_cursor: null, has_more: false },
			200,
		);
	}

	let result: { data: CommentData[]; next_cursor: string | null };
	switch (account.platform) {
		case "facebook":
			result = await fetchFacebookComments(account.accessToken!, post_id, cursor, limit);
			break;
		case "instagram":
			result = await fetchInstagramComments(account.accessToken!, post_id, cursor, limit, account.username ?? undefined);
			break;
		case "youtube":
			result = await fetchYouTubeComments(account.accessToken!, post_id, cursor, limit);
			break;
		default:
			result = { data: [], next_cursor: null };
	}

	return c.json(
		{
			data: result.data as any,
			post_id,
			platform: account.platform as any,
			next_cursor: result.next_cursor,
			has_more: result.next_cursor !== null,
		},
		200,
	);
});

app.openapi(replyToComment, async (c) => {
	const orgId = c.get("orgId");
	const { post_id } = c.req.valid("param");
	const { text, account_id, comment_id } = c.req.valid("json");
	const db = c.get("db");

	const account = await getAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account?.accessToken) {
		return c.json({ success: false }, 200);
	}

	// The comment_id to reply to — use the body's comment_id if provided, otherwise the post_id
	const parentId = comment_id ?? post_id;

	try {
		switch (account.platform) {
			case "facebook": {
				// Facebook Graph API: Post a comment reply on an object
				// Docs: https://developers.facebook.com/docs/graph-api/reference/object/comments/#creating
				const res = await fetch(
					`${GRAPH_BASE.facebook}/${parentId}/comments`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							message: text,
							access_token: account.accessToken,
						}),
					},
				);
				if (!res.ok) return c.json({ success: false }, 200);
				const json = (await res.json()) as { id?: string };
				await invalidateInboxCache(c.env.KV, db, orgId, c.env);
				return c.json({ success: true, comment_id: json.id }, 200);
			}
			case "instagram": {
				// Instagram Graph API: Reply to a comment or post a top-level comment
				// Reply: POST /<IG_COMMENT_ID>/replies — Docs: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies/#creating
				// Top-level: POST /<IG_MEDIA_ID>/comments — Docs: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments/#creating
				// Host: graph.instagram.com (Instagram Login) or graph.facebook.com (Facebook Login)
				const igEdge = comment_id ? "replies" : "comments";
				const igRes = await fetch(
					`https://${igGraphHost(account.accessToken)}/${API_VERSIONS.meta_graph}/${parentId}/${igEdge}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							message: text,
							access_token: account.accessToken,
						}),
					},
				);
				if (!igRes.ok) return c.json({ success: false }, 200);
				const igJson = (await igRes.json()) as { id?: string };
				await invalidateInboxCache(c.env.KV, db, orgId, c.env);
				return c.json({ success: true, comment_id: igJson.id }, 200);
			}
			case "youtube": {
				// YouTube Data API: Insert a reply to a comment
				// Docs: https://developers.google.com/youtube/v3/docs/comments/insert
				const res = await fetch(
					"https://www.googleapis.com/youtube/v3/comments?part=snippet",
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${account.accessToken}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							snippet: {
								parentId,
								textOriginal: text,
							},
						}),
					},
				);
				if (!res.ok) return c.json({ success: false }, 200);
				const json = (await res.json()) as { id?: string };
				await invalidateInboxCache(c.env.KV, db, orgId, c.env);
				return c.json({ success: true, comment_id: json.id }, 200);
			}
			default:
				return c.json({ success: false }, 200);
		}
	} catch {
		return c.json({ success: false }, 200);
	}
});

app.openapi(deleteComment, async (c) => {
	const orgId = c.get("orgId");
	const { comment_id } = c.req.valid("param");
	const db = c.get("db");

	// Comment_id doesn't tell us which account owns the comment — we fan out a
	// platform delete to every candidate account and take the first success.
	// Parallel > serial: for N accounts at ~400ms each, serial is 400N ms,
	// parallel caps at ~400ms + the success account's latency.
	const accounts = await getAccountsForOrg(db, orgId, undefined, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	const candidates = accounts.filter(
		(a) =>
			a.accessToken &&
			(a.platform === "facebook" || a.platform === "instagram" || a.platform === "youtube"),
	);

	const results = await Promise.allSettled(
		candidates.map(async (account) => {
			switch (account.platform) {
				case "facebook": {
					// Facebook Graph API: Delete a comment
					// Docs: https://developers.facebook.com/docs/graph-api/reference/comment/#deleting
					const res = await fetch(
						`${GRAPH_BASE.facebook}/${comment_id}?access_token=${encodeURIComponent(account.accessToken!)}`,
						{ method: "DELETE" },
					);
					if (!res.ok) throw new Error(`fb ${res.status}`);
					return;
				}
				case "instagram": {
					// Instagram Graph API: DELETE a comment
					// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/#deleting
					// Host: graph.instagram.com (Instagram Login) or graph.facebook.com (Facebook Login)
					const res = await fetch(
						`https://${igGraphHost(account.accessToken!)}/${API_VERSIONS.meta_graph}/${comment_id}?access_token=${encodeURIComponent(account.accessToken!)}`,
						{ method: "DELETE" },
					);
					if (!res.ok) throw new Error(`ig ${res.status}`);
					return;
				}
				case "youtube": {
					// YouTube Data API: Delete a comment
					// Docs: https://developers.google.com/youtube/v3/docs/comments/delete
					const res = await fetch(
						`https://www.googleapis.com/youtube/v3/comments?id=${encodeURIComponent(comment_id)}`,
						{
							method: "DELETE",
							headers: { Authorization: `Bearer ${account.accessToken!}` },
						},
					);
					if (!res.ok) throw new Error(`yt ${res.status}`);
					return;
				}
			}
		}),
	);

	if (results.some((r) => r.status === "fulfilled")) {
		await invalidateInboxCache(c.env.KV, db, orgId, c.env);
		return c.json({ success: true }, 200);
	}
	return c.json({ success: false }, 200);
});

app.openapi(hideComment, async (c) => {
	const orgId = c.get("orgId");
	const { comment_id } = c.req.valid("param");
	const db = c.get("db");

	// Hide is Facebook/Instagram only. Parallelize across candidates; first
	// success wins. See deleteComment for the rationale.
	const accounts = await getAccountsForOrg(db, orgId, undefined, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	const candidates = accounts.filter(
		(a) => a.accessToken && (a.platform === "facebook" || a.platform === "instagram"),
	);

	const results = await Promise.allSettled(
		candidates.map(async (account) => {
			if (account.platform === "instagram") {
				// Instagram Graph API: Hide a comment (set hide to true)
				// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/#updating
				// NOTE: Instagram uses "hide" param, NOT "is_hidden" (the Facebook param)
				const res = await fetch(
					`https://${igGraphHost(account.accessToken!)}/${API_VERSIONS.meta_graph}/${comment_id}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							hide: true,
							access_token: account.accessToken,
						}),
					},
				);
				if (!res.ok) throw new Error(`ig ${res.status}`);
				return;
			}
			// Facebook Graph API: Hide a comment (set is_hidden to true)
			// Docs: https://developers.facebook.com/docs/graph-api/reference/comment/#updating
			const res = await fetch(
				`${GRAPH_BASE.facebook}/${comment_id}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						is_hidden: true,
						access_token: account.accessToken,
					}),
				},
			);
			if (!res.ok) throw new Error(`fb ${res.status}`);
		}),
	);

	if (results.some((r) => r.status === "fulfilled")) {
		await invalidateInboxCache(c.env.KV, db, orgId, c.env);
		return c.json({ success: true }, 200);
	}
	return c.json({ success: false }, 200);
});

app.openapi(unhideComment, async (c) => {
	const orgId = c.get("orgId");
	const { comment_id } = c.req.valid("param");
	const db = c.get("db");

	// Unhide is Facebook/Instagram only. Parallelized; first success wins.
	const accounts = await getAccountsForOrg(db, orgId, undefined, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	const candidates = accounts.filter(
		(a) => a.accessToken && (a.platform === "facebook" || a.platform === "instagram"),
	);

	const results = await Promise.allSettled(
		candidates.map(async (account) => {
			if (account.platform === "instagram") {
				// Instagram Graph API: Unhide a comment (set hide to false)
				// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/#updating
				// NOTE: Instagram uses "hide" param, NOT "is_hidden" (the Facebook param)
				const res = await fetch(
					`https://${igGraphHost(account.accessToken!)}/${API_VERSIONS.meta_graph}/${comment_id}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							hide: false,
							access_token: account.accessToken,
						}),
					},
				);
				if (!res.ok) throw new Error(`ig ${res.status}`);
				return;
			}
			// Facebook Graph API: Unhide a comment (set is_hidden to false)
			// Docs: https://developers.facebook.com/docs/graph-api/reference/comment/#updating
			const res = await fetch(
				`${GRAPH_BASE.facebook}/${comment_id}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						is_hidden: false,
						access_token: account.accessToken,
					}),
				},
			);
			if (!res.ok) throw new Error(`fb ${res.status}`);
		}),
	);

	if (results.some((r) => r.status === "fulfilled")) {
		await invalidateInboxCache(c.env.KV, db, orgId, c.env);
		return c.json({ success: true }, 200);
	}
	return c.json({ success: false }, 200);
});

app.openapi(likeComment, async (c) => {
	const orgId = c.get("orgId");
	const { comment_id } = c.req.valid("param");
	const db = c.get("db");

	// Only Facebook supports liking comments. Parallelize across FB accounts.
	// NOTE: Instagram Graph API does NOT support liking comments.
	// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/
	const accounts = await getAccountsForOrg(db, orgId, undefined, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	const candidates = accounts.filter((a) => a.accessToken && a.platform === "facebook");

	const results = await Promise.allSettled(
		candidates.map(async (account) => {
			// Facebook Graph API: Like a comment
			// Docs: https://developers.facebook.com/docs/graph-api/reference/object/likes/#creating
			const res = await fetch(
				`${GRAPH_BASE.facebook}/${comment_id}/likes`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						access_token: account.accessToken,
					}),
				},
			);
			if (!res.ok) throw new Error(`fb ${res.status}`);
		}),
	);

	if (results.some((r) => r.status === "fulfilled")) {
		return c.json({ success: true }, 200);
	}
	return c.json({ success: false }, 200);
});

app.openapi(unlikeComment, async (c) => {
	const orgId = c.get("orgId");
	const { comment_id } = c.req.valid("param");
	const db = c.get("db");

	// Only Facebook supports unliking comments. Parallelize across FB accounts.
	// NOTE: Instagram Graph API does NOT support unliking comments.
	// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/
	const accounts = await getAccountsForOrg(db, orgId, undefined, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	const candidates = accounts.filter((a) => a.accessToken && a.platform === "facebook");

	const results = await Promise.allSettled(
		candidates.map(async (account) => {
			// Facebook Graph API: Unlike a comment (remove like)
			// Docs: https://developers.facebook.com/docs/graph-api/reference/object/likes/#deleting
			const res = await fetch(
				`${GRAPH_BASE.facebook}/${comment_id}/likes?access_token=${encodeURIComponent(account.accessToken!)}`,
				{ method: "DELETE" },
			);
			if (!res.ok) throw new Error(`fb ${res.status}`);
		}),
	);

	if (results.some((r) => r.status === "fulfilled")) {
		return c.json({ success: true }, 200);
	}
	return c.json({ success: false }, 200);
});

app.openapi(privateReply, async (c) => {
	const orgId = c.get("orgId");
	const { comment_id } = c.req.valid("param");
	const { text, account_id } = c.req.valid("json");
	const db = c.get("db");

	const account = await getAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account?.accessToken) {
		return c.json({ success: false }, 200);
	}

	// Private replies are Facebook only
	if (account.platform !== "facebook") {
		return c.json({ success: false }, 200);
	}

	try {
		// Facebook Messenger Platform: Send a private reply to a comment author
		// Docs: https://developers.facebook.com/docs/messenger-platform/instagram/features/private-replies
		const res = await fetch(
			`${GRAPH_BASE.facebook}/${comment_id}/private_replies`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					message: text,
					access_token: account.accessToken,
				}),
			},
		);
		if (res.ok) {
			const json = (await res.json()) as { id?: string };
			return c.json({ success: true, comment_id: json.id }, 200);
		}
	} catch {
		// fall through
	}

	return c.json({ success: false }, 200);
});

// =====================
// Reviews — Handlers
// =====================

// NOTE: Messages/Conversations handlers have been moved to inbox-feed.ts
// under the /conversations/* path structure.

app.openapi(listReviews, async (c) => {
	const orgId = c.get("orgId");
	const { platform, account_id, min_rating, max_rating, cursor, limit } = c.req.valid("query");
	const db = c.get("db");

	// Default to googlebusiness if platform is specified
	const accounts = await getAccountsForOrg(db, orgId, { platform, accountId: account_id }, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (accounts.length === 0) {
		return c.json({ data: [], next_cursor: null, has_more: false }, 200);
	}

	type ReviewItem = {
		id: string;
		platform: string;
		author_name: string;
		rating: number;
		text: string | null;
		reply: string | null;
		created_at: string;
	};

	// Fetch reviews from all accounts in parallel (capped by getAccountsForOrg limit)
	const results = await mapConcurrently(
		accounts.filter((account) => account.accessToken),
		4,
		async (account): Promise<{ reviews: ReviewItem[]; cursor: string | null }> => {
			try {
				switch (account.platform) {
					case "googlebusiness": {
						// Google Business Profile API: List accounts to get the GMB account name
						// Docs: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list
						const accountsRes = await fetch(
							"https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
							{ headers: { Authorization: `Bearer ${account.accessToken}` } },
						);
						if (!accountsRes.ok) return { reviews: [], cursor: null };
						const accountsJson = (await accountsRes.json()) as {
							accounts: Array<{ name: string }>;
						};
						const gmbAccount = accountsJson.accounts?.[0];
						if (!gmbAccount) return { reviews: [], cursor: null };

						// Get the location (use metadata default or first location)
						const meta = account.metadata as { default_location_id?: string } | null;
						let locationName = meta?.default_location_id;

						if (!locationName) {
							const locRes = await fetch(
								`https://mybusinessbusinessinformation.googleapis.com/v1/${gmbAccount.name}/locations`,
								{ headers: { Authorization: `Bearer ${account.accessToken}` } },
							);
							if (!locRes.ok) return { reviews: [], cursor: null };
							const locJson = (await locRes.json()) as {
								locations: Array<{ name: string }>;
							};
							locationName = locJson.locations?.[0]?.name;
						}

						if (!locationName) return { reviews: [], cursor: null };

						let url = `https://mybusiness.googleapis.com/v4/${locationName}/reviews?pageSize=${limit}`;
						if (cursor) url += `&pageToken=${encodeURIComponent(cursor)}`;

						const res = await fetch(url, {
							headers: { Authorization: `Bearer ${account.accessToken}` },
						});
						if (!res.ok) return { reviews: [], cursor: null };

						const json = (await res.json()) as {
							reviews: Array<{
								name: string;
								reviewer: { displayName: string };
								starRating: string;
								comment?: string;
								reviewReply?: { comment: string };
								createTime: string;
							}>;
							nextPageToken?: string;
						};

						const ratingMap: Record<string, number> = {
							ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5,
						};

						const reviews: ReviewItem[] = [];
						for (const review of json.reviews ?? []) {
							const rating = ratingMap[review.starRating] ?? 0;
							if (min_rating !== undefined && rating < min_rating) continue;
							if (max_rating !== undefined && rating > max_rating) continue;
							reviews.push({
								id: review.name,
								platform: "googlebusiness",
								author_name: review.reviewer.displayName,
								rating,
								text: review.comment ?? null,
								reply: review.reviewReply?.comment ?? null,
								created_at: review.createTime,
							});
						}
						return { reviews, cursor: json.nextPageToken ?? null };
					}
					case "facebook": {
						let url = `${GRAPH_BASE.facebook}/${account.platformAccountId}/ratings?access_token=${encodeURIComponent(account.accessToken!)}&limit=${limit}&fields=reviewer,rating,review_text,created_time`;
						if (cursor) url += `&after=${encodeURIComponent(cursor)}`;
						const res = await fetch(url);
						if (!res.ok) return { reviews: [], cursor: null };
						const json = (await res.json()) as {
							data: Array<{
								reviewer: { name: string; id: string };
								rating: number;
								review_text?: string;
								created_time: string;
							}>;
							paging?: { cursors?: { after?: string }; next?: string };
						};

						const reviews: ReviewItem[] = [];
						for (const review of json.data ?? []) {
							const rating = Math.round(review.rating);
							if (min_rating !== undefined && rating < min_rating) continue;
							if (max_rating !== undefined && rating > max_rating) continue;
							reviews.push({
								id: review.reviewer.id,
								platform: "facebook",
								author_name: review.reviewer.name,
								rating,
								text: review.review_text ?? null,
								reply: null,
								created_at: review.created_time,
							});
						}
						return { reviews, cursor: json.paging?.next ? (json.paging.cursors?.after ?? null) : null };
					}
					default:
						return { reviews: [], cursor: null };
				}
			} catch {
				return { reviews: [], cursor: null };
			}
		},
	);

	const allReviews: ReviewItem[] = [];
	let lastCursor: string | null = null;
	for (const result of results) {
		allReviews.push(...result.reviews);
		if (result.cursor) lastCursor = result.cursor;
	}

	return c.json(
		{
			data: allReviews.slice(0, limit) as any,
			next_cursor: lastCursor,
			has_more: allReviews.length > limit || lastCursor !== null,
		},
		200,
	);
});

app.openapi(replyToReview, async (c) => {
	const orgId = c.get("orgId");
	const { review_id } = c.req.valid("param");
	const { text, account_id } = c.req.valid("json");
	const db = c.get("db");

	const account = await getAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account?.accessToken) {
		return c.json({ success: false }, 200);
	}

	try {
		switch (account.platform) {
			case "googlebusiness": {
				// review_id is the full resource name e.g. accounts/x/locations/y/reviews/z
				// Google Business Profile API: Reply to a review
				// Docs: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/updateReply
				const res = await fetch(
					`https://mybusiness.googleapis.com/v4/${review_id}/reply`,
					{
						method: "PUT",
						headers: {
							Authorization: `Bearer ${account.accessToken}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ comment: text }),
					},
				);
				return c.json({ success: res.ok }, 200);
			}
			default:
				return c.json({ success: false }, 200);
		}
	} catch {
		return c.json({ success: false }, 200);
	}
});

app.openapi(deleteReviewReply, async (c) => {
	const orgId = c.get("orgId");
	const { review_id } = c.req.valid("param");
	const db = c.get("db");

	// Try all googlebusiness accounts
	const accounts = await getAccountsForOrg(db, orgId, { platform: "googlebusiness" }, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	for (const account of accounts) {
		if (!account.accessToken) continue;

		try {
			// Google Business Profile API: Delete a review reply
			// Docs: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/deleteReply
			const res = await fetch(
				`https://mybusiness.googleapis.com/v4/${review_id}/reply`,
				{
					method: "DELETE",
					headers: { Authorization: `Bearer ${account.accessToken}` },
				},
			);
			if (res.ok) return c.json({ success: true }, 200);
		} catch {
			// try next account
		}
	}

	return c.json({ success: false }, 200);
});

export default app;
