/**
 * Inbox backfill service — fetches historical comments/DMs from platform APIs
 * when an account is first connected, storing them in the inbox DB tables.
 *
 * Called by inbox-event-processor when a `type: "backfill"` queue message arrives.
 */

import { createDb, socialAccounts, eq } from "@relayapi/db";
import { maybeDecrypt } from "../lib/crypto";
import type { InboxQueueMessage } from "../routes/platform-webhooks";
import type { Env } from "../types";
import { upsertConversation, insertMessage } from "./inbox-persistence";

// Max pages to follow per entity to avoid rate limits
const MAX_PAGES = 2;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function processBackfill(
	message: InboxQueueMessage,
	env: Env,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const [account] = await db
		.select()
		.from(socialAccounts)
		.where(eq(socialAccounts.id, message.account_id))
		.limit(1);

	if (!account || !account.accessToken) {
		console.log(
			`[backfill] Account ${message.account_id} not found or missing token, skipping`,
		);
		return;
	}

	const platform = account.platform;
	const token = (await maybeDecrypt(account.accessToken, env.ENCRYPTION_KEY))!;

	console.log(
		`[backfill] Starting backfill for ${platform} account ${account.id}`,
	);

	try {
		switch (platform) {
			case "facebook":
				await backfillFacebook(db, account, token, message.organization_id);
				break;
			case "instagram":
				await backfillInstagram(db, account, token, message.organization_id);
				break;
			case "youtube":
				await backfillYouTube(db, account, token, message.organization_id);
				break;
			case "googlebusiness":
				await backfillGoogleBusiness(
					db,
					account,
					token,
					message.organization_id,
				);
				break;
			default:
				console.log(
					`[backfill] No backfill support for platform "${platform}", skipping`,
				);
				break;
		}
	} catch (err) {
		console.error(`[backfill] Top-level error for ${platform}:`, err);
	}
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type SocialAccount = typeof socialAccounts.$inferSelect;
type DB = ReturnType<typeof createDb>;

// ---------------------------------------------------------------------------
// Facebook backfill
// ---------------------------------------------------------------------------

async function backfillFacebook(
	db: DB,
	account: SocialAccount,
	token: string,
	organizationId: string,
): Promise<void> {
	// Fetch page posts
	const postsUrl = `https://graph.facebook.com/v25.0/me/feed?access_token=${encodeURIComponent(token)}&limit=25&fields=id,message,created_time`;
	const postsRes = await fetch(postsUrl);
	if (!postsRes.ok) {
		console.log(
			`[backfill] Facebook posts fetch failed: ${postsRes.status}`,
		);
		return;
	}

	const postsJson = (await postsRes.json()) as {
		data: Array<{
			id: string;
			message?: string;
			created_time: string;
		}>;
	};

	const posts = postsJson.data ?? [];
	console.log(
		`[backfill] Processing facebook for account ${account.id}: ${posts.length} posts`,
	);

	for (const post of posts) {
		try {
			await fetchAndStoreFacebookComments(
				db,
				account,
				token,
				organizationId,
				post.id,
			);
		} catch (err) {
			console.error(
				`[backfill] Facebook comments error for post ${post.id}:`,
				err,
			);
		}
	}
}

async function fetchAndStoreFacebookComments(
	db: DB,
	account: SocialAccount,
	token: string,
	organizationId: string,
	postId: string,
): Promise<void> {
	let cursor: string | undefined;
	let page = 0;

	while (page < MAX_PAGES) {
		let url = `https://graph.facebook.com/v25.0/${postId}/comments?access_token=${encodeURIComponent(token)}&limit=50&fields=id,from{name,picture},message,created_time`;
		if (cursor) {
			url += `&after=${encodeURIComponent(cursor)}`;
		}

		const res = await fetch(url);
		if (!res.ok) break;

		const json = (await res.json()) as {
			data: Array<{
				id: string;
				from?: { name: string; picture?: { data?: { url?: string } } };
				message: string;
				created_time: string;
			}>;
			paging?: { cursors?: { after?: string }; next?: string };
		};

		const comments = json.data ?? [];
		if (comments.length === 0) break;

		for (const comment of comments) {
			try {
				const conversation = await upsertConversation(db, {
					organizationId,
					accountId: account.id,
					platform: "facebook",
					type: "comment_thread",
					platformConversationId: postId,
					postPlatformId: postId,
					participantName: comment.from?.name ?? null,
					participantPlatformId: comment.from ? comment.from.name : null,
					participantAvatar:
						comment.from?.picture?.data?.url ?? null,
					lastMessageText: comment.message,
					lastMessageAt: new Date(comment.created_time),
					lastMessageDirection: "inbound",
				});

				await insertMessage(db, {
					conversationId: conversation.id,
					organizationId,
					platformMessageId: comment.id,
					authorName: comment.from?.name ?? null,
					authorPlatformId: comment.from ? comment.from.name : null,
					authorAvatarUrl:
						comment.from?.picture?.data?.url ?? null,
					text: comment.message,
					direction: "inbound",
					createdAt: new Date(comment.created_time),
				});
			} catch (err) {
				console.error(
					`[backfill] Facebook comment store error ${comment.id}:`,
					err,
				);
			}
		}

		// Check for next page
		if (!json.paging?.next) break;
		cursor = json.paging.cursors?.after;
		if (!cursor) break;
		page++;
	}
}

// ---------------------------------------------------------------------------
// Instagram backfill
// ---------------------------------------------------------------------------

function igGraphHost(token: string): string {
	return token.startsWith("IGAA")
		? "graph.instagram.com"
		: "graph.facebook.com";
}

async function backfillInstagram(
	db: DB,
	account: SocialAccount,
	token: string,
	organizationId: string,
): Promise<void> {
	const host = igGraphHost(token);

	// Fetch media
	const mediaUrl = `https://${host}/v25.0/me/media?access_token=${encodeURIComponent(token)}&limit=25&fields=id,caption,timestamp`;
	const mediaRes = await fetch(mediaUrl);
	if (!mediaRes.ok) {
		console.log(
			`[backfill] Instagram media fetch failed: ${mediaRes.status}`,
		);
		return;
	}

	const mediaJson = (await mediaRes.json()) as {
		data: Array<{
			id: string;
			caption?: string;
			timestamp: string;
		}>;
	};

	const mediaItems = mediaJson.data ?? [];
	console.log(
		`[backfill] Processing instagram for account ${account.id}: ${mediaItems.length} media items`,
	);

	for (const media of mediaItems) {
		try {
			await fetchAndStoreInstagramComments(
				db,
				account,
				token,
				organizationId,
				media.id,
				host,
			);
		} catch (err) {
			console.error(
				`[backfill] Instagram comments error for media ${media.id}:`,
				err,
			);
		}
	}
}

async function fetchAndStoreInstagramComments(
	db: DB,
	account: SocialAccount,
	token: string,
	organizationId: string,
	mediaId: string,
	host: string,
): Promise<void> {
	let cursor: string | undefined;
	let page = 0;

	while (page < MAX_PAGES) {
		let url = `https://${host}/v25.0/${mediaId}/comments?access_token=${encodeURIComponent(token)}&limit=50&fields=id,from,text,timestamp`;
		if (cursor) {
			url += `&after=${encodeURIComponent(cursor)}`;
		}

		const res = await fetch(url);
		if (!res.ok) break;

		const json = (await res.json()) as {
			data: Array<{
				id: string;
				from?: { username: string; id?: string };
				text: string;
				timestamp: string;
			}>;
			paging?: { cursors?: { after?: string }; next?: string };
		};

		const comments = json.data ?? [];
		if (comments.length === 0) break;

		for (const comment of comments) {
			try {
				const conversation = await upsertConversation(db, {
					organizationId,
					accountId: account.id,
					platform: "instagram",
					type: "comment_thread",
					platformConversationId: mediaId,
					postPlatformId: mediaId,
					participantName: comment.from?.username ?? null,
					participantPlatformId: comment.from?.id ?? null,
					lastMessageText: comment.text,
					lastMessageAt: new Date(comment.timestamp),
					lastMessageDirection: "inbound",
				});

				await insertMessage(db, {
					conversationId: conversation.id,
					organizationId,
					platformMessageId: comment.id,
					authorName: comment.from?.username ?? null,
					authorPlatformId: comment.from?.id ?? null,
					text: comment.text,
					direction: "inbound",
					createdAt: new Date(comment.timestamp),
				});
			} catch (err) {
				console.error(
					`[backfill] Instagram comment store error ${comment.id}:`,
					err,
				);
			}
		}

		// Check for next page
		if (!json.paging?.next) break;
		cursor = json.paging.cursors?.after;
		if (!cursor) break;
		page++;
	}
}

// ---------------------------------------------------------------------------
// YouTube backfill
// ---------------------------------------------------------------------------

async function backfillYouTube(
	db: DB,
	account: SocialAccount,
	token: string,
	organizationId: string,
): Promise<void> {
	const channelId = account.platformAccountId;

	let pageToken: string | undefined;
	let page = 0;
	let totalComments = 0;

	while (page < MAX_PAGES) {
		let url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet,replies&allThreadsRelatedToChannelId=${encodeURIComponent(channelId)}&maxResults=50`;
		if (pageToken) {
			url += `&pageToken=${encodeURIComponent(pageToken)}`;
		}

		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!res.ok) {
			console.log(
				`[backfill] YouTube commentThreads fetch failed: ${res.status}`,
			);
			break;
		}

		const json = (await res.json()) as {
			items: Array<{
				id: string;
				snippet: {
					topLevelComment: {
						id: string;
						snippet: {
							videoId: string;
							authorDisplayName: string;
							authorProfileImageUrl?: string;
							authorChannelId?: { value?: string };
							textOriginal: string;
							publishedAt: string;
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
							authorChannelId?: { value?: string };
							textOriginal: string;
							publishedAt: string;
							parentId: string;
						};
					}>;
				};
			}>;
			nextPageToken?: string;
		};

		const items = json.items ?? [];
		if (items.length === 0) break;

		for (const item of items) {
			try {
				const topComment = item.snippet.topLevelComment.snippet;
				const videoId = topComment.videoId;

				// Upsert conversation for this video's comment thread
				const conversation = await upsertConversation(db, {
					organizationId,
					accountId: account.id,
					platform: "youtube",
					type: "comment_thread",
					platformConversationId: videoId,
					postPlatformId: videoId,
					participantName: topComment.authorDisplayName,
					participantPlatformId:
						topComment.authorChannelId?.value ?? null,
					participantAvatar:
						topComment.authorProfileImageUrl ?? null,
					lastMessageText: topComment.textOriginal,
					lastMessageAt: new Date(topComment.publishedAt),
					lastMessageDirection: "inbound",
				});

				// Store top-level comment
				await insertMessage(db, {
					conversationId: conversation.id,
					organizationId,
					platformMessageId: item.snippet.topLevelComment.id,
					authorName: topComment.authorDisplayName,
					authorPlatformId:
						topComment.authorChannelId?.value ?? null,
					authorAvatarUrl:
						topComment.authorProfileImageUrl ?? null,
					text: topComment.textOriginal,
					direction: "inbound",
					createdAt: new Date(topComment.publishedAt),
				});
				totalComments++;

				// Store replies
				for (const reply of item.replies?.comments ?? []) {
					try {
						await insertMessage(db, {
							conversationId: conversation.id,
							organizationId,
							platformMessageId: reply.id,
							authorName: reply.snippet.authorDisplayName,
							authorPlatformId:
								reply.snippet.authorChannelId?.value ?? null,
							authorAvatarUrl:
								reply.snippet.authorProfileImageUrl ?? null,
							text: reply.snippet.textOriginal,
							direction: "inbound",
							createdAt: new Date(reply.snippet.publishedAt),
						});
						totalComments++;
					} catch (err) {
						console.error(
							`[backfill] YouTube reply store error ${reply.id}:`,
							err,
						);
					}
				}
			} catch (err) {
				console.error(
					`[backfill] YouTube comment thread store error ${item.id}:`,
					err,
				);
			}
		}

		// Check for next page
		if (!json.nextPageToken) break;
		pageToken = json.nextPageToken;
		page++;
	}

	console.log(
		`[backfill] Processing youtube for account ${account.id}: ${totalComments} comments`,
	);
}

// ---------------------------------------------------------------------------
// Google Business backfill (reviews)
// ---------------------------------------------------------------------------

async function backfillGoogleBusiness(
	db: DB,
	account: SocialAccount,
	token: string,
	organizationId: string,
): Promise<void> {
	// Step 1: Resolve the GMB account name
	const accountsRes = await fetch(
		"https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (!accountsRes.ok) {
		console.log(
			`[backfill] Google Business accounts fetch failed: ${accountsRes.status}`,
		);
		return;
	}

	const accountsJson = (await accountsRes.json()) as {
		accounts: Array<{ name: string }>;
	};
	const gmbAccount = accountsJson.accounts?.[0];
	if (!gmbAccount) {
		console.log("[backfill] No GMB account found");
		return;
	}

	// Step 2: Resolve location name
	const meta = account.metadata as { default_location_id?: string } | null;
	let locationName = meta?.default_location_id;

	if (!locationName) {
		const locRes = await fetch(
			`https://mybusinessbusinessinformation.googleapis.com/v1/${gmbAccount.name}/locations`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		if (!locRes.ok) {
			console.log(
				`[backfill] Google Business locations fetch failed: ${locRes.status}`,
			);
			return;
		}
		const locJson = (await locRes.json()) as {
			locations: Array<{ name: string }>;
		};
		locationName = locJson.locations?.[0]?.name;
	}

	if (!locationName) {
		console.log("[backfill] No GMB location found");
		return;
	}

	// Step 3: Fetch reviews (up to MAX_PAGES)
	let pageToken: string | undefined;
	let page = 0;
	let totalReviews = 0;

	while (page < MAX_PAGES) {
		let url = `https://mybusiness.googleapis.com/v4/${locationName}/reviews?pageSize=50`;
		if (pageToken) {
			url += `&pageToken=${encodeURIComponent(pageToken)}`;
		}

		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!res.ok) {
			console.log(
				`[backfill] Google Business reviews fetch failed: ${res.status}`,
			);
			break;
		}

		const json = (await res.json()) as {
			reviews: Array<{
				name: string;
				reviewer: { displayName: string };
				starRating: string;
				comment?: string;
				createTime: string;
			}>;
			nextPageToken?: string;
		};

		const reviews = json.reviews ?? [];
		if (reviews.length === 0) break;

		for (const review of reviews) {
			try {
				const conversation = await upsertConversation(db, {
					organizationId,
					accountId: account.id,
					platform: "googlebusiness",
					type: "review",
					platformConversationId: review.name,
					participantName: review.reviewer.displayName,
					lastMessageText: review.comment ?? null,
					lastMessageAt: new Date(review.createTime),
					lastMessageDirection: "inbound",
				});

				await insertMessage(db, {
					conversationId: conversation.id,
					organizationId,
					platformMessageId: review.name,
					authorName: review.reviewer.displayName,
					text: review.comment ?? null,
					direction: "inbound",
					platformData: { starRating: review.starRating },
					createdAt: new Date(review.createTime),
				});
				totalReviews++;
			} catch (err) {
				console.error(
					`[backfill] Google Business review store error ${review.name}:`,
					err,
				);
			}
		}

		// Check for next page
		if (!json.nextPageToken) break;
		pageToken = json.nextPageToken;
		page++;
	}

	console.log(
		`[backfill] Processing googlebusiness for account ${account.id}: ${totalReviews} reviews`,
	);
}
