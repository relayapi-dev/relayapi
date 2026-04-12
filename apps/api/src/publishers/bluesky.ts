import { fetchPublicUrl } from "../lib/fetch-public-url";
import { classifyPublishError, type EngagementAccount, type EngagementActionResult, type Publisher, type PublishRequest, type PublishResult } from "./types";

interface BlueskySession {
	did: string;
	accessJwt: string;
	refreshJwt: string;
	handle: string;
}

interface BlueskyFacet {
	index: { byteStart: number; byteEnd: number };
	features: Array<{ $type: string; [key: string]: unknown }>;
}

const BSKY_API = "https://bsky.social/xrpc";
const BSKY_VIDEO_API = "https://video.bsky.app/xrpc";
/** Resolve the user's PDS DID for service auth (required for video uploads) */
async function resolvePdsDid(session: BlueskySession): Promise<string> {
	const res = await fetch(
		`https://plc.directory/${encodeURIComponent(session.did)}`,
	);
	if (!res.ok) {
		// Fallback: assume bsky.social for hosted accounts
		return "did:web:bsky.social";
	}
	const doc = (await res.json()) as {
		service?: Array<{ id: string; serviceEndpoint: string }>;
	};
	const pdsEndpoint = doc.service?.find(
		(s) => s.id === "#atproto_pds" || s.id.endsWith("#atproto_pds"),
	)?.serviceEndpoint;
	if (!pdsEndpoint) {
		return "did:web:bsky.social";
	}
	const host = new URL(pdsEndpoint).host;
	return `did:web:${host}`;
}

async function createSession(
	identifier: string,
	password: string,
): Promise<BlueskySession> {
	// AT Protocol — Create an authenticated session with Bluesky
	// https://docs.bsky.app/docs/api/com-atproto-server-create-session
	const res = await fetch(`${BSKY_API}/com.atproto.server.createSession`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ identifier, password }),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(
			`Bluesky auth failed: ${(err as Record<string, string>).message ?? res.statusText}`,
		);
	}
	return res.json() as Promise<BlueskySession>;
}

/** Count grapheme clusters (Bluesky counts graphemes, not UTF-16 code units) */
function countGraphemes(text: string): number {
	return [...new Intl.Segmenter().segment(text)].length;
}

/** Resolve a Bluesky handle to a DID */
async function resolveHandle(
	session: BlueskySession,
	handle: string,
): Promise<string> {
	const params = new URLSearchParams({ handle });
	const res = await fetch(
		`${BSKY_API}/com.atproto.identity.resolveHandle?${params}`,
		{
			headers: { Authorization: `Bearer ${session.accessJwt}` },
		},
	);
	if (!res.ok) {
		throw new Error(`Failed to resolve handle @${handle}`);
	}
	const data = (await res.json()) as { did: string };
	return data.did;
}

/** Resolve DIDs for mention facets in-place */
async function resolveFacetDids(
	session: BlueskySession,
	facets: BlueskyFacet[],
	text: string,
): Promise<void> {
	const encoder = new TextEncoder();
	for (const facet of facets) {
		for (const feature of facet.features) {
			if (
				feature.$type === "app.bsky.richtext.facet#mention" &&
				(!feature.did || feature.did === "")
			) {
				// Extract the handle from the original text using byte offsets
				const textBytes = encoder.encode(text);
				const mentionBytes = textBytes.slice(
					facet.index.byteStart,
					facet.index.byteEnd,
				);
				const mentionText = new TextDecoder().decode(mentionBytes);
				// Remove leading @ from mention text
				const handle = mentionText.startsWith("@")
					? mentionText.slice(1)
					: mentionText;
				feature.did = await resolveHandle(session, handle);
			}
		}
	}
}

/** Detect mentions, links, and hashtags → AT Protocol facets */
function detectFacets(text: string): BlueskyFacet[] {
	const encoder = new TextEncoder();
	const facets: BlueskyFacet[] = [];

	// URLs
	for (const match of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
		const start = match.index ?? 0;
		const beforeBytes = encoder.encode(text.slice(0, start)).byteLength;
		const matchBytes = encoder.encode(match[0]).byteLength;
		facets.push({
			index: { byteStart: beforeBytes, byteEnd: beforeBytes + matchBytes },
			features: [{ $type: "app.bsky.richtext.facet#link", uri: match[0] }],
		});
	}

	// Mentions (@handle.bsky.social)
	for (const match of text.matchAll(
		/(^|\s)@([a-zA-Z0-9.-]+(\.[a-zA-Z]{2,}))/g,
	)) {
		const mentionStart = (match.index ?? 0) + (match[1]?.length ?? 0);
		const mention = match[0].trimStart();
		const beforeBytes = encoder.encode(text.slice(0, mentionStart)).byteLength;
		const matchBytes = encoder.encode(mention).byteLength;
		facets.push({
			index: { byteStart: beforeBytes, byteEnd: beforeBytes + matchBytes },
			features: [
				{ $type: "app.bsky.richtext.facet#mention", did: "" }, // DID resolved later
			],
		});
	}

	// Hashtags
	for (const match of text.matchAll(/(^|\s)#([a-zA-Z0-9_]+)/g)) {
		const tagStart = (match.index ?? 0) + (match[1]?.length ?? 0);
		const beforeBytes = encoder.encode(text.slice(0, tagStart)).byteLength;
		const matchBytes = encoder.encode(match[0].trimStart()).byteLength;
		facets.push({
			index: { byteStart: beforeBytes, byteEnd: beforeBytes + matchBytes },
			features: [{ $type: "app.bsky.richtext.facet#tag", tag: match[2] ?? "" }],
		});
	}

	return facets;
}

async function uploadBlob(
	session: BlueskySession,
	url: string,
): Promise<{
	$type: string;
	ref: { $link: string };
	mimeType: string;
	size: number;
}> {
	// Fetch the media
	const mediaRes = await fetchPublicUrl(url, { timeout: 30_000 });
	if (!mediaRes.ok) {
		throw new Error(
			`Failed to fetch media from ${url}: ${mediaRes.statusText}`,
		);
	}
	const blob = await mediaRes.arrayBuffer();
	const contentType =
		mediaRes.headers.get("content-type") ?? "application/octet-stream";

	// AT Protocol blob upload limit is 1,000,000 bytes per blob
	// https://docs.bsky.app/docs/advanced-guides/posts#images-embeds
	if (blob.byteLength > 1_000_000) {
		throw new Error(
			`Image exceeds Bluesky's 1 MB blob size limit (${(blob.byteLength / 1024 / 1024).toFixed(1)} MB). Resize the image before uploading.`,
		);
	}

	// AT Protocol — Upload a blob (image/media) to Bluesky
	// https://docs.bsky.app/docs/api/com-atproto-repo-upload-blob
	const uploadRes = await fetch(`${BSKY_API}/com.atproto.repo.uploadBlob`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${session.accessJwt}`,
			"Content-Type": contentType,
		},
		body: blob,
	});
	if (!uploadRes.ok) {
		throw new Error(`Bluesky blob upload failed: ${uploadRes.statusText}`);
	}
	const result = (await uploadRes.json()) as {
		blob: { ref: { $link: string }; mimeType: string; size: number };
	};
	return {
		$type: "blob",
		ref: result.blob.ref,
		mimeType: result.blob.mimeType,
		size: result.blob.size,
	};
}

/** Get a service auth token for the video upload service */
async function getServiceAuth(
	session: BlueskySession,
	aud: string,
	lxm: string,
): Promise<string> {
	// AT Protocol — Request a signed service auth token
	// https://docs.bsky.app/docs/api/com-atproto-server-get-service-auth
	// Only aud and lxm are documented query parameters; exp is set server-side
	const params = new URLSearchParams({ aud, lxm });
	const res = await fetch(
		`${BSKY_API}/com.atproto.server.getServiceAuth?${params}`,
		{
			method: "GET",
			headers: { Authorization: `Bearer ${session.accessJwt}` },
		},
	);
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(
			`Bluesky service auth failed: ${(err as Record<string, string>).message ?? res.statusText}`,
		);
	}
	const data = (await res.json()) as { token: string };
	return data.token;
}

/** Upload a video via video.bsky.app and poll until processing completes */
async function uploadVideo(
	session: BlueskySession,
	url: string,
): Promise<{
	$type: string;
	ref: { $link: string };
	mimeType: string;
	size: number;
}> {
	// Fetch the video
	const mediaRes = await fetchPublicUrl(url, { timeout: 30_000 });
	if (!mediaRes.ok) {
		throw new Error(
			`Failed to fetch video from ${url}: ${mediaRes.statusText}`,
		);
	}
	const videoBytes = await mediaRes.arrayBuffer();

	if (videoBytes.byteLength > 100_000_000) {
		throw new Error("Video exceeds Bluesky's 100 MB size limit.");
	}

	// Get service auth token for video upload
	// aud must be the user's PDS DID, not the video service DID
	// https://docs.bsky.app/docs/tutorials/video
	const pdsDid = await resolvePdsDid(session);
	const serviceToken = await getServiceAuth(
		session,
		pdsDid,
		"com.atproto.repo.uploadBlob",
	);

	// Upload to video.bsky.app
	// https://docs.bsky.app/docs/api/app-bsky-video-upload-video
	const filename = `video_${Date.now()}.mp4`;
	const uploadRes = await fetch(
		`${BSKY_VIDEO_API}/app.bsky.video.uploadVideo?did=${encodeURIComponent(session.did)}&name=${encodeURIComponent(filename)}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${serviceToken}`,
				"Content-Type": "video/mp4",
				"Content-Length": String(videoBytes.byteLength),
			},
			body: videoBytes,
		},
	);

	if (!uploadRes.ok && uploadRes.status !== 409) {
		const err = await uploadRes.text();
		throw new Error(`Bluesky video upload failed: ${uploadRes.status} ${err}`);
	}

	// Response wraps data in a jobStatus key
	// https://docs.bsky.app/docs/api/app-bsky-video-upload-video
	const uploadData = (await uploadRes.json()) as {
		jobStatus: {
			jobId: string;
			state: string;
			blob?: { ref: { $link: string }; mimeType: string; size: number };
			error?: string;
		};
	};
	const jobStatus = uploadData.jobStatus;

	// If blob already available (duplicate upload), return immediately
	if (jobStatus.blob) {
		return {
			$type: "blob",
			ref: jobStatus.blob.ref,
			mimeType: jobStatus.blob.mimeType,
			size: jobStatus.blob.size,
		};
	}

	// Poll for processing completion
	// https://docs.bsky.app/docs/api/app-bsky-video-get-job-status
	const maxAttempts = 60; // ~5 minutes max at 5s intervals
	for (let i = 0; i < maxAttempts; i++) {
		await new Promise((r) => setTimeout(r, 5000));

		const statusRes = await fetch(
			`${BSKY_VIDEO_API}/app.bsky.video.getJobStatus?jobId=${encodeURIComponent(jobStatus.jobId)}`,
			{
				headers: { Authorization: `Bearer ${serviceToken}` },
			},
		);

		if (!statusRes.ok) continue;

		// Response also wraps in jobStatus key
		const statusData = (await statusRes.json()) as {
			jobStatus: {
				jobId: string;
				state: string;
				blob?: { ref: { $link: string }; mimeType: string; size: number };
				error?: string;
			};
		};
		const status = statusData.jobStatus;

		if (status.state === "JOB_STATE_COMPLETED" && status.blob) {
			return {
				$type: "blob",
				ref: status.blob.ref,
				mimeType: status.blob.mimeType,
				size: status.blob.size,
			};
		}

		if (status.state === "JOB_STATE_FAILED") {
			throw new Error(
				`Bluesky video processing failed: ${status.error ?? "unknown error"}`,
			);
		}
	}

	throw new Error("Bluesky video processing timed out after 5 minutes.");
}

async function createPost(
	session: BlueskySession,
	record: Record<string, unknown>,
): Promise<{ uri: string; cid: string }> {
	// AT Protocol — Create a record (post) in a Bluesky repo
	// https://docs.bsky.app/docs/api/com-atproto-repo-create-record
	const res = await fetch(`${BSKY_API}/com.atproto.repo.createRecord`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${session.accessJwt}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			repo: session.did,
			collection: "app.bsky.feed.post",
			record,
		}),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(
			`Bluesky post creation failed: ${(err as Record<string, string>).message ?? res.statusText}`,
		);
	}
	return res.json() as Promise<{ uri: string; cid: string }>;
}

export const blueskyPublisher: Publisher = {
	platform: "bluesky",

	async repost(account: EngagementAccount, platformPostId: string): Promise<EngagementActionResult> {
		try {
			const session = await createSession(account.platform_account_id, account.access_token);
			// AT Protocol — Repost a record
			// https://docs.bsky.app/docs/api/com-atproto-repo-create-record
			// Need to resolve the CID of the post to repost
			const getRes = await fetch(`${BSKY_API}/com.atproto.repo.getRecord?${new URLSearchParams({
				repo: platformPostId.split("/")[2] ?? "",
				collection: "app.bsky.feed.post",
				rkey: platformPostId.split("/").pop() ?? "",
			})}`, {
				headers: { Authorization: `Bearer ${session.accessJwt}` },
			});
			if (!getRes.ok) {
				throw new Error(`Failed to fetch post for repost: ${getRes.statusText}`);
			}
			const postData = (await getRes.json()) as { uri: string; cid: string };

			const res = await fetch(`${BSKY_API}/com.atproto.repo.createRecord`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${session.accessJwt}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					repo: session.did,
					collection: "app.bsky.feed.repost",
					record: {
						$type: "app.bsky.feed.repost",
						subject: { uri: postData.uri, cid: postData.cid },
						createdAt: new Date().toISOString(),
					},
				}),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(`Bluesky repost failed: ${(err as Record<string, string>).message ?? res.statusText}`);
			}
			const result = (await res.json()) as { uri: string };
			return { success: true, platform_post_id: result.uri };
		} catch (err) {
			const result = classifyPublishError(err);
			return { success: false, error: result.error };
		}
	},

	async comment(account: EngagementAccount, platformPostId: string, text: string): Promise<EngagementActionResult> {
		try {
			const session = await createSession(account.platform_account_id, account.access_token);
			// Fetch the original post to build reply reference
			const getRes = await fetch(`${BSKY_API}/com.atproto.repo.getRecord?${new URLSearchParams({
				repo: platformPostId.split("/")[2] ?? "",
				collection: "app.bsky.feed.post",
				rkey: platformPostId.split("/").pop() ?? "",
			})}`, {
				headers: { Authorization: `Bearer ${session.accessJwt}` },
			});
			if (!getRes.ok) {
				throw new Error(`Failed to fetch post for reply: ${getRes.statusText}`);
			}
			const postData = (await getRes.json()) as { uri: string; cid: string };

			const record: Record<string, unknown> = {
				$type: "app.bsky.feed.post",
				text,
				createdAt: new Date().toISOString(),
				reply: {
					root: { uri: postData.uri, cid: postData.cid },
					parent: { uri: postData.uri, cid: postData.cid },
				},
			};
			const facets = detectFacets(text);
			if (facets.length > 0) {
				await resolveFacetDids(session, facets, text);
				record.facets = facets;
			}
			const result = await createPost(session, record);
			return { success: true, platform_post_id: result.uri };
		} catch (err) {
			const result = classifyPublishError(err);
			return { success: false, error: result.error };
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			// Auth — access_token is the app password, platform_account_id is the handle
			const session = await createSession(
				request.account.platform_account_id,
				request.account.access_token,
			);

			const opts = request.target_options;

			// Check for thread
			const threadItems = opts.thread as
				| Array<{
						content: string;
						media?: Array<{ url: string; type?: string }>;
				  }>
				| undefined;

			if (threadItems && threadItems.length > 0) {
				return await publishThread(session, threadItems);
			}

			// Single post
			const content = (opts.content as string) ?? request.content ?? "";

			const contentGraphemes = countGraphemes(content);
			if (contentGraphemes > 300) {
				return {
					success: false,
					error: {
						code: "CONTENT_TOO_LONG",
						message: `Content is ${contentGraphemes} characters (graphemes). Bluesky limit is 300.`,
					},
				};
			}

			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;

			const record: Record<string, unknown> = {
				$type: "app.bsky.feed.post",
				text: content,
				createdAt: new Date().toISOString(),
			};

			// Facets (rich text)
			const facets = detectFacets(content);
			if (facets.length > 0) {
				await resolveFacetDids(session, facets, content);
				record.facets = facets;
			}

			// Images embed
			if (media.length > 0) {
				const imageMedia = media.filter(
					(m) => !m.type || m.type === "image" || m.type === "gif",
				);
				const videoMedia = media.filter((m) => m.type === "video");

				if (videoMedia.length > 0) {
					// Video — upload via video.bsky.app service
					// https://docs.bsky.app/docs/tutorials/video
					const videoBlob = await uploadVideo(session, videoMedia[0]!.url);
					record.embed = {
						$type: "app.bsky.embed.video",
						video: videoBlob,
						aspectRatio: (opts.aspectRatio as {
							width: number;
							height: number;
						}) ?? {
							width: 16,
							height: 9,
						},
					};
				} else if (imageMedia.length > 0) {
					const images = await Promise.all(
						imageMedia.slice(0, 4).map(async (m) => {
							const blob = await uploadBlob(session, m.url);
							return { alt: (m as any).alt_text ?? "", image: blob };
						}),
					);
					record.embed = {
						$type: "app.bsky.embed.images",
						images,
					};
				}
			}

			// External link embed (website card preview)
			// Docs: https://docs.bsky.app/docs/advanced-guides/posts#website-card-embeds
			const linkPreview = opts.link_preview as { url: string; title: string; description: string; thumbnail_url?: string } | undefined;
			if (!record.embed && linkPreview) {
				const external: Record<string, unknown> = {
					uri: linkPreview.url,
					title: linkPreview.title,
					description: linkPreview.description,
				};
				if (linkPreview.thumbnail_url) {
					const thumbBlob = await uploadBlob(session, linkPreview.thumbnail_url);
					external.thumb = thumbBlob;
				}
				record.embed = {
					$type: "app.bsky.embed.external",
					external,
				};
			}

			// Quote post embed
			// Docs: https://docs.bsky.app/docs/advanced-guides/posts#quote-posts
			const quoteUri = opts.quote_uri as string | undefined;
			const quoteCid = opts.quote_cid as string | undefined;
			if (quoteUri && quoteCid) {
				if (record.embed) {
					// Combine with existing media embed (recordWithMedia)
					record.embed = {
						$type: "app.bsky.embed.recordWithMedia",
						record: {
							record: { uri: quoteUri, cid: quoteCid },
						},
						media: record.embed,
					};
				} else {
					record.embed = {
						$type: "app.bsky.embed.record",
						record: { uri: quoteUri, cid: quoteCid },
					};
				}
			}

			// Post languages for content discovery
			// Docs: https://docs.bsky.app/docs/advanced-guides/posts
			const langs = opts.languages as string[] | undefined;
			if (langs && langs.length > 0) {
				record.langs = langs.slice(0, 3);
			}

			// Self-labels for content warnings
			const selfLabels = opts.self_labels as string[] | undefined;
			if (selfLabels && selfLabels.length > 0) {
				record.labels = {
					$type: "com.atproto.label.defs#selfLabels",
					values: selfLabels.map((val) => ({ val })),
				};
			}

			const result = await createPost(session, record);

			// Convert AT URI to web URL
			const postId = result.uri.split("/").pop();
			const webUrl = `https://bsky.app/profile/${session.handle}/post/${postId}`;

			return {
				success: true,
				platform_post_id: result.uri,
				platform_url: webUrl,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};

async function publishThread(
	session: BlueskySession,
	items: Array<{
		content: string;
		media?: Array<{ url: string; type?: string }>;
	}>,
): Promise<PublishResult> {
	let rootUri: string | undefined;
	let rootCid: string | undefined;
	let parentUri: string | undefined;
	let parentCid: string | undefined;

	for (const [i, item] of items.entries()) {
		const itemGraphemes = countGraphemes(item.content);
		if (itemGraphemes > 300) {
			return {
				success: false,
				error: {
					code: "CONTENT_TOO_LONG",
					message: `Thread item ${i + 1} is ${itemGraphemes} characters (graphemes). Bluesky limit is 300.`,
				},
			};
		}

		const record: Record<string, unknown> = {
			$type: "app.bsky.feed.post",
			text: item.content,
			createdAt: new Date().toISOString(),
		};

		const facets = detectFacets(item.content);
		if (facets.length > 0) {
			await resolveFacetDids(session, facets, item.content);
			record.facets = facets;
		}

		// Reply reference for thread items after the first
		if (i > 0 && rootUri && rootCid && parentUri && parentCid) {
			record.reply = {
				root: { uri: rootUri, cid: rootCid },
				parent: { uri: parentUri, cid: parentCid },
			};
		}

		// Media — handle video vs images (video requires service auth upload)
		if (item.media && item.media.length > 0) {
			const videoMedia = item.media.filter((m) => m.type === "video");
			const imageMedia = item.media.filter(
				(m) => !m.type || m.type === "image" || m.type === "gif",
			);

			if (videoMedia.length > 0) {
				const videoBlob = await uploadVideo(session, videoMedia[0]!.url);
				record.embed = {
					$type: "app.bsky.embed.video",
					video: videoBlob,
					aspectRatio: { width: 16, height: 9 },
				};
			} else if (imageMedia.length > 0) {
				const images = await Promise.all(
					imageMedia.slice(0, 4).map(async (m) => {
						const blob = await uploadBlob(session, m.url);
						return { alt: (m as any).alt_text ?? "", image: blob };
					}),
				);
				record.embed = { $type: "app.bsky.embed.images", images };
			}
		}

		const result = await createPost(session, record);

		if (i === 0) {
			rootUri = result.uri;
			rootCid = result.cid;
		}
		parentUri = result.uri;
		parentCid = result.cid;
	}

	const postId = rootUri?.split("/").pop();
	const webUrl = `https://bsky.app/profile/${session.handle}/post/${postId}`;

	return {
		success: true,
		platform_post_id: rootUri,
		platform_url: webUrl,
	};
}
