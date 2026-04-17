/**
 * Centralized third-party API versions.
 *
 * When bumping a version, update the corresponding doc URL comment and verify
 * the endpoint paths still work (Meta family changelog:
 * https://developers.facebook.com/docs/graph-api/changelog/versions/).
 */

export const API_VERSIONS = {
	// https://developers.facebook.com/docs/graph-api/changelog/versions/
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
	// https://learn.microsoft.com/en-us/linkedin/marketing/versioning — YYYYMM format
	linkedin: "202603",
} as const;

export const GRAPH_BASE = {
	facebook: `https://graph.facebook.com/${API_VERSIONS.meta_graph}`,
	instagram: `https://graph.instagram.com/${API_VERSIONS.meta_graph}`,
	threads: `https://graph.threads.net/${API_VERSIONS.threads_graph}`,
} as const;
