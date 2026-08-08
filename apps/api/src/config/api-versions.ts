/**
 * Centralized third-party API versions.
 *
 * When bumping a version, update the corresponding doc URL comment and verify
 * the endpoint paths still work (Meta family changelog:
 * https://developers.facebook.com/docs/graph-api/changelog/versions/).
 */

export const API_VERSIONS = {
	// https://developers.facebook.com/docs/graph-api/changelog/versions/
	// v26.0 is newest as of 2026-08-03. v25.0 remains supported through
	// 2028-07-29 and is retained until the compatibility review is complete.
	meta_graph: "v25.0",
	// https://developers.facebook.com/docs/threads/
	threads_graph: "v1.0",
	// https://developer.x.com/en/docs/twitter-api
	twitter: "2",
	// https://developers.google.com/youtube/v3
	youtube: "v3",
	// https://developers.pinterest.com/docs/api/v5/
	pinterest: "v5",
	// https://developers.tiktok.com/doc/content-posting-api-overview
	tiktok: "v2",
	// https://learn.microsoft.com/en-us/linkedin/marketing/versioning
	// 202604 remains supported; latest verified 2026-07-15 is 202607.
	linkedin: "202604",
} as const;

export const GRAPH_BASE = {
	facebook: `https://graph.facebook.com/${API_VERSIONS.meta_graph}`,
	instagram: `https://graph.instagram.com/${API_VERSIONS.meta_graph}`,
	// https://developers.facebook.com/docs/threads/posts
	// Section "Create a Threads media container": current publishing examples
	// use https://graph.threads.net/v1.0/... (verified 2026-08-03).
	threads: `https://graph.threads.net/${API_VERSIONS.threads_graph}`,
} as const;
