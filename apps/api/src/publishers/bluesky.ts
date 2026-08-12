import {
	awaitResponseWithBodyCompletion,
	ensureResponseContentLength,
	fetchPublicUrl,
	getFixedLengthResponseBody,
	readResponseBytes,
} from "../lib/fetch-public-url";
import { readPublisherJson, readPublisherText } from "./provider-response";
import {
	classifyPublishError,
	type EngagementAccount,
	type EngagementActionResult,
	getSucceededProviderEffect,
	mergeProviderEffects,
	type ProviderEffect,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
	recordProviderEffect,
} from "./types";

interface BlueskySession {
	did: string;
	accessJwt: string;
	refreshJwt: string;
	handle: string;
	pdsUrl: string;
}

interface BlueskyFacet {
	index: { byteStart: number; byteEnd: number };
	features: Array<{ $type: string; [key: string]: unknown }>;
}

const BSKY_VIDEO_API = "https://video.bsky.app/xrpc";
const BSKY_IMAGE_MAX_BYTES = 2_000_000;
const BSKY_VIDEO_MAX_BYTES = 100_000_000;

type BlueskyMedia = { url: string; type?: string };

/**
 * Resolve the PDS origin selected and verified by the connection flow. AT
 * Protocol accounts can migrate between PDS hosts, so using bsky.social for an
 * arbitrary account can disclose an app password and write to the wrong host.
 */
export function resolveBlueskyPdsUrl(
	metadata: Record<string, unknown> | null | undefined,
): string {
	const raw = metadata?.pds_url;
	if (typeof raw !== "string" || !raw.trim()) {
		throw new PublishError(
			"This Bluesky account has no verified PDS. Reconnect the account before publishing.",
			{ code: "ACCOUNT_RECONNECT_REQUIRED" },
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		throw new PublishError(
			"This Bluesky account has an invalid verified PDS. Reconnect the account before publishing.",
			{ code: "ACCOUNT_RECONNECT_REQUIRED" },
		);
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.port ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash
	) {
		throw new PublishError(
			"The connected Bluesky PDS must be a bare HTTPS origin. Reconnect the account before publishing.",
			{ code: "ACCOUNT_RECONNECT_REQUIRED" },
		);
	}
	return parsed.origin;
}

function pdsXrpcUrl(pdsUrl: string, method: string): string {
	return `${pdsUrl}/xrpc/${method}`;
}

function validateBlueskyMedia(media: BlueskyMedia[]): void {
	if (media.length === 0) return;
	const images = media.filter(
		(item) =>
			item.type === undefined || item.type === "image" || item.type === "gif",
	);
	const videos = media.filter((item) => item.type === "video");
	if (images.length + videos.length !== media.length) {
		throw new Error(
			"CONTENT_ERROR: Bluesky posts support image/GIF or video attachments, not document attachments.",
		);
	}
	if (videos.length > 0 && media.length !== 1) {
		// Official docs: https://docs.bsky.app/docs/tutorials/video
		// Section "Uploading Video" uses one app.bsky.embed.video blob; a post
		// record has one embed, so video cannot be mixed with image embeds.
		throw new Error(
			"CONTENT_ERROR: Bluesky supports exactly one video and cannot mix it with images.",
		);
	}
	if (images.length > 4) {
		// Official docs: https://docs.bsky.app/docs/tutorials/creating-a-post
		// Section "Images embeds" states that each post contains up to four images.
		throw new Error(
			`CONTENT_ERROR: Bluesky supports at most four images; received ${images.length}.`,
		);
	}
}
/** Resolve the verified dispatch host DID used by Bluesky video service auth. */
function resolvePdsDid(session: BlueskySession): string {
	return `did:web:${new URL(session.pdsUrl).host}`;
}

async function createSession(
	identifier: string,
	password: string,
	pdsUrl: string,
): Promise<BlueskySession> {
	// AT Protocol — Create an authenticated session with Bluesky
	// https://docs.bsky.app/docs/api/com-atproto-server-create-session
	const res = await fetchPublicUrl(
		pdsXrpcUrl(pdsUrl, "com.atproto.server.createSession"),
		{
			method: "POST",
			redirect: "error",
			timeout: 30_000,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identifier, password }),
		},
	);
	if (!res.ok) {
		const err = await readPublisherJson(res).catch(() => ({}));
		const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
		throw new PublishError(
			`Bluesky auth failed: ${(err as Record<string, string>).message ?? res.statusText}`,
			{ statusCode: res.status, detail: raw },
		);
	}
	const session = (await readPublisherJson(res)) as Omit<
		BlueskySession,
		"pdsUrl"
	>;
	if (session.did !== identifier) {
		throw new PublishError(
			"The Bluesky PDS authenticated a different identity. Reconnect the account.",
			{ code: "ACCOUNT_RECONNECT_REQUIRED" },
		);
	}
	return { ...session, pdsUrl };
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
	const res = await fetchPublicUrl(
		`${pdsXrpcUrl(session.pdsUrl, "com.atproto.identity.resolveHandle")}?${params}`,
		{
			redirect: "error",
			timeout: 30_000,
			headers: { Authorization: `Bearer ${session.accessJwt}` },
		},
	);
	if (!res.ok) {
		throw new PublishError(`Failed to resolve handle @${handle}`, {
			statusCode: res.status,
			detail: `HTTP ${res.status} ${res.statusText}`,
		});
	}
	const data = (await readPublisherJson(res)) as { did: string };
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
	const mediaRes = await fetchPublicUrl(url, {
		timeout: 30_000,
		maxBytes: BSKY_IMAGE_MAX_BYTES,
	});
	if (!mediaRes.ok) {
		throw new PublishError(
			`Failed to fetch media from ${url}: ${mediaRes.statusText}`,
			{
				statusCode: mediaRes.status,
				detail: `HTTP ${mediaRes.status} ${mediaRes.statusText}`,
			},
		);
	}
	const blob = await readResponseBytes(mediaRes, BSKY_IMAGE_MAX_BYTES);
	const contentType =
		mediaRes.headers.get("content-type") ?? "application/octet-stream";

	// Official docs: https://docs.bsky.app/docs/tutorials/creating-a-post
	// Section "Images Embeds": each image is limited to 2 megabytes. The
	// canonical app.bsky.embed.images lexicon sets maxSize to 2,000,000 bytes.
	// AT Protocol — Upload a blob (image/media) to Bluesky
	// https://docs.bsky.app/docs/api/com-atproto-repo-upload-blob
	const uploadRes = await fetchPublicUrl(
		pdsXrpcUrl(session.pdsUrl, "com.atproto.repo.uploadBlob"),
		{
			method: "POST",
			redirect: "error",
			timeout: 30_000,
			headers: {
				Authorization: `Bearer ${session.accessJwt}`,
				"Content-Type": contentType,
			},
			body: blob,
		},
	);
	if (!uploadRes.ok) {
		throw new PublishError(
			`Bluesky blob upload failed: ${uploadRes.statusText}`,
			{
				statusCode: uploadRes.status,
				detail: `HTTP ${uploadRes.status} ${uploadRes.statusText}`,
			},
		);
	}
	const result = (await readPublisherJson(uploadRes)) as {
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
	const res = await fetchPublicUrl(
		`${pdsXrpcUrl(session.pdsUrl, "com.atproto.server.getServiceAuth")}?${params}`,
		{
			method: "GET",
			redirect: "error",
			timeout: 30_000,
			headers: { Authorization: `Bearer ${session.accessJwt}` },
		},
	);
	if (!res.ok) {
		const err = await readPublisherJson(res).catch(() => ({}));
		const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
		throw new PublishError(
			`Bluesky service auth failed: ${(err as Record<string, string>).message ?? res.statusText}`,
			{ statusCode: res.status, detail: raw },
		);
	}
	const data = (await readPublisherJson(res)) as { token: string };
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
	// Get service auth token for video upload
	// aud must be the user's PDS DID, not the video service DID
	// https://docs.bsky.app/docs/tutorials/video
	const pdsDid = resolvePdsDid(session);
	const serviceToken = await getServiceAuth(
		session,
		pdsDid,
		"com.atproto.repo.uploadBlob",
	);

	// Fetch after authentication setup so the source connection immediately
	// streams into the provider rather than sitting open while API calls run.
	const mediaRes = await fetchPublicUrl(url, { timeout: 30_000 });
	if (!mediaRes.ok) {
		throw new PublishError(
			`Failed to fetch video from ${url}: ${mediaRes.statusText}`,
			{
				statusCode: mediaRes.status,
				detail: `HTTP ${mediaRes.status} ${mediaRes.statusText}`,
			},
		);
	}
	const preparedMediaRes = await ensureResponseContentLength(
		mediaRes,
		BSKY_VIDEO_MAX_BYTES,
		() =>
			fetchPublicUrl(url, {
				timeout: 30_000,
				maxBytes: BSKY_VIDEO_MAX_BYTES,
			}),
	);
	const source = getFixedLengthResponseBody(
		preparedMediaRes,
		BSKY_VIDEO_MAX_BYTES,
	);

	// Upload to video.bsky.app
	// https://docs.bsky.app/docs/api/app-bsky-video-upload-video
	const filename = `video_${Date.now()}.mp4`;
	const uploadRes = await awaitResponseWithBodyCompletion(
		fetch(
			`${BSKY_VIDEO_API}/app.bsky.video.uploadVideo?did=${encodeURIComponent(session.did)}&name=${encodeURIComponent(filename)}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${serviceToken}`,
					"Content-Type": "video/mp4",
					"Content-Length": String(source.contentLength),
				},
				body: source.body,
			},
		),
		source.completion,
	);

	if (!uploadRes.ok && uploadRes.status !== 409) {
		const err = await readPublisherText(uploadRes);
		const raw = `HTTP ${uploadRes.status}\n${err}`;
		throw new PublishError(
			`Bluesky video upload failed: ${uploadRes.status} ${err}`,
			{
				statusCode: uploadRes.status,
				detail: raw,
			},
		);
	}

	// Response wraps data in a jobStatus key
	// https://docs.bsky.app/docs/api/app-bsky-video-upload-video
	const uploadData = (await readPublisherJson(uploadRes)) as {
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
		const statusData = (await readPublisherJson(statusRes)) as {
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
	const res = await fetchPublicUrl(
		pdsXrpcUrl(session.pdsUrl, "com.atproto.repo.createRecord"),
		{
			method: "POST",
			redirect: "error",
			timeout: 30_000,
			headers: {
				Authorization: `Bearer ${session.accessJwt}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				repo: session.did,
				collection: "app.bsky.feed.post",
				record,
			}),
		},
	);
	if (!res.ok) {
		const err = await readPublisherJson(res).catch(() => ({}));
		const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
		throw new PublishError(
			`Bluesky post creation failed: ${(err as Record<string, string>).message ?? res.statusText}`,
			{ statusCode: res.status, detail: raw },
		);
	}
	return readPublisherJson(res) as Promise<{ uri: string; cid: string }>;
}

/** Delete a post record from the connector-verified PDS. */
export async function deleteBlueskyPost(
	account: PublishRequest["account"],
	postUri: string,
	signal?: AbortSignal,
): Promise<Response> {
	// AT Protocol canonical Lexicon:
	// https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/deleteRecord.json
	// POST com.atproto.repo.deleteRecord with repo, collection, and rkey.
	const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/u.exec(
		postUri,
	);
	if (!match?.[1] || !match[2] || match[1] !== account.platform_account_id) {
		throw new PublishError(
			"The Bluesky post URI does not belong to the connected repository.",
			{ code: "CONTENT_ERROR" },
		);
	}
	const pdsUrl = resolveBlueskyPdsUrl(account.metadata);
	const session = await createSession(
		account.platform_account_id,
		account.access_token,
		pdsUrl,
	);
	return fetchPublicUrl(
		pdsXrpcUrl(session.pdsUrl, "com.atproto.repo.deleteRecord"),
		{
			method: "POST",
			redirect: "error",
			timeout: 30_000,
			signal,
			headers: {
				Authorization: `Bearer ${session.accessJwt}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				repo: session.did,
				collection: "app.bsky.feed.post",
				rkey: decodeURIComponent(match[2]),
			}),
		},
	);
}

/** Resolve the strong reference needed to continue a previously journaled thread. */
async function getPostStrongRef(
	session: BlueskySession,
	uri: string,
): Promise<{ uri: string; cid: string }> {
	const parts = uri.split("/");
	const repo = parts[2];
	const rkey = parts.at(-1);
	if (!repo || !rkey) {
		throw new Error("Bluesky recorded thread effect has an invalid AT URI.");
	}
	const response = await fetchPublicUrl(
		`${pdsXrpcUrl(session.pdsUrl, "com.atproto.repo.getRecord")}?${new URLSearchParams(
			{
				repo,
				collection: "app.bsky.feed.post",
				rkey,
			},
		)}`,
		{
			redirect: "error",
			timeout: 30_000,
			headers: { Authorization: `Bearer ${session.accessJwt}` },
		},
	);
	if (!response.ok) {
		throw new PublishError(
			`Bluesky could not resume recorded thread item ${uri}: ${response.statusText}`,
			{
				statusCode: response.status,
				detail: `HTTP ${response.status} ${response.statusText}`,
			},
		);
	}
	const record = (await readPublisherJson(response)) as {
		uri?: string;
		cid?: string;
	};
	if (!record.uri || !record.cid) {
		throw new Error(
			"Bluesky recorded thread item no longer has a resolvable strong reference.",
		);
	}
	return { uri: record.uri, cid: record.cid };
}

export const blueskyPublisher: Publisher = {
	platform: "bluesky",

	async repost(
		account: EngagementAccount,
		platformPostId: string,
	): Promise<EngagementActionResult> {
		try {
			const pdsUrl = resolveBlueskyPdsUrl(account.metadata);
			const session = await createSession(
				account.platform_account_id,
				account.access_token,
				pdsUrl,
			);
			// AT Protocol — Repost a record
			// https://docs.bsky.app/docs/api/com-atproto-repo-create-record
			// Need to resolve the CID of the post to repost
			const getRes = await fetchPublicUrl(
				`${pdsXrpcUrl(pdsUrl, "com.atproto.repo.getRecord")}?${new URLSearchParams(
					{
						repo: platformPostId.split("/")[2] ?? "",
						collection: "app.bsky.feed.post",
						rkey: platformPostId.split("/").pop() ?? "",
					},
				)}`,
				{
					redirect: "error",
					timeout: 30_000,
					headers: { Authorization: `Bearer ${session.accessJwt}` },
				},
			);
			if (!getRes.ok) {
				throw new PublishError(
					`Failed to fetch post for repost: ${getRes.statusText}`,
					{
						statusCode: getRes.status,
						detail: `HTTP ${getRes.status} ${getRes.statusText}`,
					},
				);
			}
			const postData = (await readPublisherJson(getRes)) as {
				uri: string;
				cid: string;
			};

			const res = await fetchPublicUrl(
				pdsXrpcUrl(pdsUrl, "com.atproto.repo.createRecord"),
				{
					method: "POST",
					redirect: "error",
					timeout: 30_000,
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
				},
			);
			if (!res.ok) {
				const err = await readPublisherJson(res).catch(() => ({}));
				const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
				throw new PublishError(
					`Bluesky repost failed: ${(err as Record<string, string>).message ?? res.statusText}`,
					{ statusCode: res.status, detail: raw },
				);
			}
			const result = (await readPublisherJson(res)) as { uri: string };
			return { success: true, platform_post_id: result.uri };
		} catch (err) {
			const result = classifyPublishError(err);
			return { success: false, error: result.error };
		}
	},

	async comment(
		account: EngagementAccount,
		platformPostId: string,
		text: string,
	): Promise<EngagementActionResult> {
		try {
			const pdsUrl = resolveBlueskyPdsUrl(account.metadata);
			const session = await createSession(
				account.platform_account_id,
				account.access_token,
				pdsUrl,
			);
			// Fetch the original post to build reply reference
			const getRes = await fetchPublicUrl(
				`${pdsXrpcUrl(pdsUrl, "com.atproto.repo.getRecord")}?${new URLSearchParams(
					{
						repo: platformPostId.split("/")[2] ?? "",
						collection: "app.bsky.feed.post",
						rkey: platformPostId.split("/").pop() ?? "",
					},
				)}`,
				{
					redirect: "error",
					timeout: 30_000,
					headers: { Authorization: `Bearer ${session.accessJwt}` },
				},
			);
			if (!getRes.ok) {
				throw new PublishError(
					`Failed to fetch post for reply: ${getRes.statusText}`,
					{
						statusCode: getRes.status,
						detail: `HTTP ${getRes.status} ${getRes.statusText}`,
					},
				);
			}
			const postData = (await readPublisherJson(getRes)) as {
				uri: string;
				cid: string;
				value?: { reply?: { root?: { uri: string; cid: string } } };
			};
			// Canonical lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json
			// Record field `reply` references app.bsky.feed.defs#replyRef, whose
			// `root` and `parent` strong references preserve the original thread root.
			const rootRef = postData.value?.reply?.root ?? {
				uri: postData.uri,
				cid: postData.cid,
			};

			const record: Record<string, unknown> = {
				$type: "app.bsky.feed.post",
				text,
				createdAt: new Date().toISOString(),
				reply: {
					root: rootRef,
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
			const opts = request.target_options;
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;
			const threadItems = opts.thread as
				| Array<{
						content: string;
						media?: Array<{ url: string; type?: string }>;
				  }>
				| undefined;
			if (threadItems && threadItems.length > 0) {
				for (const item of threadItems) {
					if (item.media) validateBlueskyMedia(item.media);
				}
			} else {
				validateBlueskyMedia(media);
			}
			const pdsUrl = resolveBlueskyPdsUrl(request.account.metadata);

			// Auth — access_token is the app password, platform_account_id is the DID.
			const session = await createSession(
				request.account.platform_account_id,
				request.account.access_token,
				pdsUrl,
			);

			// Check for thread
			if (threadItems && threadItems.length > 0) {
				return await publishThread(session, threadItems, request);
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

				const firstVideo = videoMedia[0];
				if (firstVideo) {
					// Video — upload via video.bsky.app service
					// https://docs.bsky.app/docs/tutorials/video
					const videoBlob = await uploadVideo(session, firstVideo.url);
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
						imageMedia.map(async (m) => {
							const blob = await uploadBlob(session, m.url);
							return {
								alt: (m as { alt_text?: string }).alt_text ?? "",
								image: blob,
							};
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
			const linkPreview = opts.link_preview as
				| {
						url: string;
						title: string;
						description: string;
						thumbnail_url?: string;
				  }
				| undefined;
			if (!record.embed && linkPreview) {
				const external: Record<string, unknown> = {
					uri: linkPreview.url,
					title: linkPreview.title,
					description: linkPreview.description,
				};
				if (linkPreview.thumbnail_url) {
					const thumbBlob = await uploadBlob(
						session,
						linkPreview.thumbnail_url,
					);
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
			const threadItems = request.target_options.thread;
			return classifyPublishError(err, {
				definitiveHttpRejection:
					!Array.isArray(threadItems) || threadItems.length === 0,
			});
		}
	},
};

async function publishThread(
	session: BlueskySession,
	items: Array<{
		content: string;
		media?: Array<{ url: string; type?: string }>;
	}>,
	request: Pick<PublishRequest, "effect_recorder">,
): Promise<PublishResult> {
	let rootUri: string | undefined;
	let rootCid: string | undefined;
	let parentUri: string | undefined;
	let parentCid: string | undefined;
	let effects: ProviderEffect[] = (request.effect_recorder?.effects ?? [])
		.filter(
			(effect) =>
				effect.name.startsWith("thread_item_") && effect.status === "succeeded",
		)
		.slice();
	let currentIndex = 0;

	try {
		for (const [i, item] of items.entries()) {
			currentIndex = i;
			const itemGraphemes = countGraphemes(item.content);
			if (itemGraphemes > 300) {
				throw new Error(
					`CONTENT_ERROR: Thread item ${i + 1} is ${itemGraphemes} characters (graphemes). Bluesky limit is 300.`,
				);
			}

			const recorded = getSucceededProviderEffect(
				request,
				`thread_item_${i + 1}`,
			);
			if (recorded?.provider_id) {
				const strongRef = await getPostStrongRef(session, recorded.provider_id);
				if (i === 0) {
					rootUri = strongRef.uri;
					rootCid = strongRef.cid;
				}
				parentUri = strongRef.uri;
				parentCid = strongRef.cid;
				continue;
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
				validateBlueskyMedia(item.media);
				const videoMedia = item.media.filter((m) => m.type === "video");
				const imageMedia = item.media.filter(
					(m) => !m.type || m.type === "image" || m.type === "gif",
				);

				const firstVideo = videoMedia[0];
				if (firstVideo) {
					const videoBlob = await uploadVideo(session, firstVideo.url);
					record.embed = {
						$type: "app.bsky.embed.video",
						video: videoBlob,
						aspectRatio: { width: 16, height: 9 },
					};
				} else if (imageMedia.length > 0) {
					const images = await Promise.all(
						imageMedia.map(async (m) => {
							const blob = await uploadBlob(session, m.url);
							return {
								alt: (m as { alt_text?: string }).alt_text ?? "",
								image: blob,
							};
						}),
					);
					record.embed = { $type: "app.bsky.embed.images", images };
				}
			}

			const result = await createPost(session, record);
			const effect: ProviderEffect = {
				name: `thread_item_${i + 1}`,
				status: "succeeded",
				provider_id: result.uri,
			};
			await recordProviderEffect(request, effect);
			effects = mergeProviderEffects(effects, [effect]);

			if (i === 0) {
				rootUri = result.uri;
				rootCid = result.cid;
			}
			parentUri = result.uri;
			parentCid = result.cid;
		}
	} catch (error) {
		if (effects.length === 0) throw error;
		const classified = classifyPublishError(error);
		const postId = rootUri?.split("/").pop();
		const webUrl = rootUri
			? `https://bsky.app/profile/${session.handle}/post/${postId}`
			: undefined;
		return {
			...classified,
			success: false,
			platform_post_id: rootUri,
			platform_url: webUrl,
			provider_outcome: {
				disposition: "partial",
				platform_post_id: rootUri,
				platform_url: webUrl,
				provider_state: `${effects.length}_thread_items_published`,
				effects: [
					...effects,
					{
						name: `thread_item_${currentIndex + 1}`,
						status: "outcome_unknown",
						error: classified.error,
					},
				],
			},
		};
	}

	const postId = rootUri?.split("/").pop();
	const webUrl = `https://bsky.app/profile/${session.handle}/post/${postId}`;

	return {
		success: true,
		platform_post_id: rootUri,
		platform_url: webUrl,
		provider_outcome: {
			disposition: "published",
			platform_post_id: rootUri,
			platform_url: webUrl,
			effects,
		},
	};
}
