/**
 * Provider report contracts verified against official documentation:
 *
 * TikTok Marketing API v1.3 — "Create an asynchronous report task",
 * "Get the status of an async report task", and "Download the output of an
 * async report task":
 * POST /open_api/v1.3/report/task/create/
 * GET  /open_api/v1.3/report/task/check/?advertiser_id&task_id
 * GET  /open_api/v1.3/report/task/download/?advertiser_id&task_id
 * https://business-api.tiktok.com/portal/docs?id=1740302766489602
 * https://business-api.tiktok.com/portal/docs?id=1740302781443073
 * https://business-api.tiktok.com/portal/docs?id=1740302808815618
 *
 * X Ads API v12 — "Asynchronous Analytics":
 * POST /12/stats/jobs/accounts/:account_id
 * GET  /12/stats/jobs/accounts/:account_id?job_ids=:job_id
 * https://docs.x.com/x-ads-api/analytics#asynchronous-analytics
 *
 * LinkedIn Marketing API — "Reporting / Ad Analytics":
 * GET /rest/adAnalytics?q=analytics&dateRange=...&timeGranularity=...
 * https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting
 */

import type { z } from "@hono/zod-openapi";
import { API_VERSIONS } from "../config/api-versions";
import type { AdReportProviderRequest } from "../schemas/ads-advanced";
import {
	arrayValue,
	fetchProviderJson,
	objectValue,
	stringValue,
} from "./ad-platforms/http";
import type { AdPlatform, AdProviderCredentials } from "./ad-platforms/types";
import {
	AdAuthoritativeNotAppliedError,
	AdPlatformError,
} from "./ad-platforms/types";

export type AdReportRequest = z.infer<typeof AdReportProviderRequest>;

export type ProviderReportStatus =
	| { status: "pending" }
	| { status: "completed"; downloadUrl?: string; inlineRows?: unknown[] }
	| { status: "failed"; error: string }
	| { status: "cancelled" };

export type ProviderReportSubmission =
	| { status: "provider_pending"; providerJobId: string }
	| { status: "completed"; inlineRows: unknown[] };

export interface AdvancedAdReportAdapter {
	readonly platform: "tiktok" | "twitter" | "linkedin";
	submit(
		credentials: AdProviderCredentials,
		providerAdAccountId: string,
		request: AdReportRequest,
	): Promise<ProviderReportSubmission>;
	status(
		credentials: AdProviderCredentials,
		providerAdAccountId: string,
		providerJobId: string,
	): Promise<ProviderReportStatus>;
	cancel?(
		credentials: AdProviderCredentials,
		providerAdAccountId: string,
		providerJobId: string,
	): Promise<void>;
}

function providerProtocol(message: string, detail?: unknown): never {
	throw new AdPlatformError("PROVIDER_PROTOCOL_ERROR", message, detail);
}

function requireAccessToken(credentials: AdProviderCredentials): string {
	if (!credentials.accessToken) {
		throw new AdAuthoritativeNotAppliedError(
			"ADS_CONNECTION_REQUIRED",
			"The exact advertising connection has no active access token",
		);
	}
	return credentials.accessToken;
}

const TIKTOK_REPORT_BASE = `https://business-api.tiktok.com/open_api/${API_VERSIONS.tiktok_business}/report/task`;

function tiktokEnvelope(value: unknown): Record<string, unknown> {
	const envelope = objectValue(value);
	if (!envelope)
		return providerProtocol("TikTok Ads returned a non-object report response");
	const code = Number(envelope.code ?? 0);
	if (code !== 0) {
		throw new AdPlatformError(
			"PROVIDER_API_ERROR",
			stringValue(envelope.message) ?? `TikTok Ads API error ${code}`,
			{ code, requestId: stringValue(envelope.request_id) },
		);
	}
	return objectValue(envelope.data) ?? {};
}

const tiktokReportAdapter: AdvancedAdReportAdapter = {
	platform: "tiktok",
	async submit(credentials, providerAdAccountId, request) {
		if (request.platform !== "tiktok") {
			throw new AdAuthoritativeNotAppliedError(
				"INVALID_PROVIDER_OPTIONS",
				"TikTok report adapter requires a TikTok report request",
			);
		}
		const { data } = await fetchProviderJson<unknown>({
			platform: "tiktok",
			url: `${TIKTOK_REPORT_BASE}/create/`,
			init: {
				method: "POST",
				headers: {
					"Access-Token": requireAccessToken(credentials),
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					advertiser_id: providerAdAccountId,
					service_type: "AUCTION",
					report_type: request.report_type,
					data_level: request.data_level,
					dimensions: request.dimensions,
					metrics: request.metrics,
					start_date: request.start_date,
					end_date: request.end_date,
					filtering: request.filters,
					output_format: request.output_format,
				}),
			},
		});
		const taskId = stringValue(tiktokEnvelope(data).task_id);
		if (!taskId)
			return providerProtocol("TikTok report creation omitted task_id");
		return { status: "provider_pending", providerJobId: taskId };
	},
	async status(credentials, providerAdAccountId, providerJobId) {
		const url = new URL(`${TIKTOK_REPORT_BASE}/check/`);
		url.searchParams.set("advertiser_id", providerAdAccountId);
		url.searchParams.set("task_id", providerJobId);
		const { data } = await fetchProviderJson<unknown>({
			platform: "tiktok",
			url: url.toString(),
			init: { headers: { "Access-Token": requireAccessToken(credentials) } },
		});
		const state = stringValue(tiktokEnvelope(data).status)?.toUpperCase();
		if (state === "SUCCESS") {
			const download = new URL(`${TIKTOK_REPORT_BASE}/download/`);
			download.searchParams.set("advertiser_id", providerAdAccountId);
			download.searchParams.set("task_id", providerJobId);
			const result = await fetchProviderJson<unknown>({
				platform: "tiktok",
				url: download.toString(),
				init: { headers: { "Access-Token": requireAccessToken(credentials) } },
			});
			const downloadUrl = stringValue(tiktokEnvelope(result.data).download_url);
			if (!downloadUrl) {
				return providerProtocol("TikTok completed report omitted download_url");
			}
			return { status: "completed", downloadUrl };
		}
		if (state === "FAILED")
			return { status: "failed", error: "TikTok report task failed" };
		if (state === "CANCELED" || state === "CANCELLED")
			return { status: "cancelled" };
		if (state === "QUEUING" || state === "PROCESSING" || state === "PENDING") {
			return { status: "pending" };
		}
		return providerProtocol("TikTok report status was unrecognized", {
			status: state,
		});
	},
	async cancel(credentials, providerAdAccountId, providerJobId) {
		const { data } = await fetchProviderJson<unknown>({
			platform: "tiktok",
			url: `${TIKTOK_REPORT_BASE}/cancel/`,
			init: {
				method: "POST",
				headers: {
					"Access-Token": requireAccessToken(credentials),
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					advertiser_id: providerAdAccountId,
					task_id: providerJobId,
				}),
			},
		});
		const status = stringValue(tiktokEnvelope(data).status)?.toUpperCase();
		if (status !== "CANCELED" && status !== "CANCELLED") {
			return providerProtocol("TikTok did not confirm report cancellation", {
				status,
			});
		}
	},
};

function percentEncode(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

async function xAuthorization(
	method: "GET" | "POST",
	url: URL,
	credentials: AdProviderCredentials,
): Promise<string> {
	if (
		!credentials.tokenSecret ||
		!credentials.clientId ||
		!credentials.clientSecret
	) {
		throw new AdAuthoritativeNotAppliedError(
			"ADS_CONNECTION_REQUIRED",
			"X Ads reports require an OAuth 1.0a token secret and Ads consumer credentials",
		);
	}
	const oauth: Record<string, string> = {
		oauth_consumer_key: credentials.clientId,
		oauth_nonce: crypto.randomUUID().replaceAll("-", ""),
		oauth_signature_method: "HMAC-SHA1",
		oauth_timestamp: String(Math.floor(Date.now() / 1000)),
		oauth_token: requireAccessToken(credentials),
		oauth_version: "1.0",
	};
	const parameters = [
		...[...url.searchParams.entries()],
		...Object.entries(oauth),
	]
		.map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
		.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
			leftKey === rightKey
				? leftValue.localeCompare(rightValue)
				: leftKey.localeCompare(rightKey),
		);
	const normalized = parameters
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
	const signatureBase = [
		method,
		percentEncode(`${url.protocol}//${url.host}${url.pathname}`),
		percentEncode(normalized),
	].join("&");
	const signingKey = `${percentEncode(credentials.clientSecret)}&${percentEncode(credentials.tokenSecret)}`;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(signingKey),
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["sign"],
	);
	const signature = base64(
		new Uint8Array(
			await crypto.subtle.sign(
				"HMAC",
				key,
				new TextEncoder().encode(signatureBase),
			),
		),
	);
	return `OAuth ${Object.entries({ ...oauth, oauth_signature: signature })
		.sort(([left], [right]) => left.localeCompare(right))
		.map(
			([keyName, value]) =>
				`${percentEncode(keyName)}="${percentEncode(value)}"`,
		)
		.join(", ")}`;
}

async function xReportRequest(
	method: "GET" | "POST",
	url: URL,
	credentials: AdProviderCredentials,
): Promise<Record<string, unknown>> {
	const { data } = await fetchProviderJson<unknown>({
		platform: "twitter",
		url: url.toString(),
		init: {
			method,
			headers: {
				Authorization: await xAuthorization(method, url, credentials),
			},
		},
	});
	const envelope = objectValue(data);
	if (!envelope)
		return providerProtocol("X Ads returned a non-object report response");
	if (arrayValue(envelope.errors).length > 0) {
		throw new AdPlatformError(
			"PROVIDER_API_ERROR",
			"X Ads report request failed",
			{
				errors: envelope.errors,
			},
		);
	}
	return envelope;
}

const X_REPORT_BASE = `https://ads-api.x.com/${API_VERSIONS.twitter_ads}/stats/jobs/accounts`;

const twitterReportAdapter: AdvancedAdReportAdapter = {
	platform: "twitter",
	async submit(credentials, providerAdAccountId, request) {
		if (request.platform !== "twitter") {
			throw new AdAuthoritativeNotAppliedError(
				"INVALID_PROVIDER_OPTIONS",
				"X report adapter requires an X report request",
			);
		}
		const url = new URL(
			`${X_REPORT_BASE}/${encodeURIComponent(providerAdAccountId)}`,
		);
		url.searchParams.set("entity", request.entity);
		url.searchParams.set("entity_ids", request.entity_ids.join(","));
		url.searchParams.set("start_time", request.start_time);
		url.searchParams.set("end_time", request.end_time);
		url.searchParams.set("granularity", request.granularity);
		url.searchParams.set("placement", request.placement);
		url.searchParams.set("metric_groups", request.metric_groups.join(","));
		if (request.segmentation_type) {
			url.searchParams.set("segmentation_type", request.segmentation_type);
		}
		const envelope = await xReportRequest("POST", url, credentials);
		const data = objectValue(envelope.data);
		const task = data ?? objectValue(arrayValue(envelope.data)[0]);
		const providerJobId = stringValue(task?.id_str) ?? stringValue(task?.id);
		if (!providerJobId)
			return providerProtocol("X report creation omitted id_str");
		return { status: "provider_pending", providerJobId };
	},
	async status(credentials, providerAdAccountId, providerJobId) {
		const url = new URL(
			`${X_REPORT_BASE}/${encodeURIComponent(providerAdAccountId)}`,
		);
		url.searchParams.set("job_ids", providerJobId);
		const envelope = await xReportRequest("GET", url, credentials);
		const task = objectValue(arrayValue(envelope.data)[0]);
		if (!task)
			return providerProtocol("X report status omitted the requested job");
		const state = stringValue(task.status)?.toUpperCase();
		if (state === "SUCCESS") {
			const downloadUrl = stringValue(task.url);
			if (!downloadUrl)
				return providerProtocol("X completed report omitted url");
			const urlValue = new URL(downloadUrl);
			if (
				urlValue.protocol !== "https:" ||
				urlValue.hostname !== "ton.twimg.com"
			) {
				return providerProtocol(
					"X returned a non-official report download URL",
				);
			}
			return { status: "completed", downloadUrl };
		}
		if (state === "FAILED")
			return { status: "failed", error: "X report job failed" };
		if (state === "CANCELLED" || state === "CANCELED")
			return { status: "cancelled" };
		if (state === "PROCESSING" || state === "PENDING")
			return { status: "pending" };
		return providerProtocol("X report status was unrecognized", {
			status: state,
		});
	},
};

function sponsoredAccountUrn(value: string): string {
	const id = value.startsWith("urn:li:sponsoredAccount:")
		? value.slice("urn:li:sponsoredAccount:".length)
		: value;
	if (!/^\d+$/.test(id)) {
		throw new AdAuthoritativeNotAppliedError(
			"INVALID_PROVIDER_RESOURCE",
			"LinkedIn advertising account IDs must be numeric or sponsoredAccount URNs",
		);
	}
	return `urn:li:sponsoredAccount:${id}`;
}

function linkedinDate(value: string): {
	year: number;
	month: number;
	day: number;
} {
	const [year, month, day] = value.split("-").map(Number);
	if (!year || !month || !day) {
		throw new AdAuthoritativeNotAppliedError(
			"INVALID_PROVIDER_OPTIONS",
			"LinkedIn report dates must use YYYY-MM-DD",
		);
	}
	return { year, month, day };
}

const linkedinReportAdapter: AdvancedAdReportAdapter = {
	platform: "linkedin",
	async submit(credentials, providerAdAccountId, request) {
		if (request.platform !== "linkedin") {
			throw new AdAuthoritativeNotAppliedError(
				"INVALID_PROVIDER_OPTIONS",
				"LinkedIn report adapter requires a LinkedIn report request",
			);
		}
		if (!credentials.grantedScopes?.includes("r_ads_reporting")) {
			throw new AdAuthoritativeNotAppliedError(
				"ADS_APPROVAL_REQUIRED",
				"LinkedIn reporting requires Advertising API approval and r_ads_reporting",
			);
		}
		const start = linkedinDate(request.start_date);
		const end = linkedinDate(request.end_date);
		const url = new URL("https://api.linkedin.com/rest/adAnalytics");
		url.searchParams.set("q", "analytics");
		url.searchParams.set(
			"dateRange",
			`(start:(year:${start.year},month:${start.month},day:${start.day}),end:(year:${end.year},month:${end.month},day:${end.day}))`,
		);
		url.searchParams.set("timeGranularity", request.time_granularity);
		url.searchParams.set(
			"accounts",
			`List(${sponsoredAccountUrn(providerAdAccountId)})`,
		);
		url.searchParams.set("pivot", request.pivot);
		url.searchParams.set("fields", request.fields.join(","));
		const { data } = await fetchProviderJson<unknown>({
			platform: "linkedin",
			url: url.toString(),
			init: {
				headers: {
					Authorization: `Bearer ${requireAccessToken(credentials)}`,
					"LinkedIn-Version": API_VERSIONS.linkedin_marketing,
					"X-RestLi-Protocol-Version": "2.0.0",
				},
			},
		});
		const envelope = objectValue(data);
		if (!envelope)
			return providerProtocol(
				"LinkedIn returned a non-object analytics response",
			);
		return { status: "completed", inlineRows: arrayValue(envelope.elements) };
	},
	async status() {
		return providerProtocol(
			"LinkedIn analytics completes within the submission request",
		);
	},
};

const REPORT_ADAPTERS = new Map<AdPlatform, AdvancedAdReportAdapter>([
	["tiktok", tiktokReportAdapter],
	["twitter", twitterReportAdapter],
	["linkedin", linkedinReportAdapter],
]);

export function getAdvancedAdReportAdapter(
	platform: AdPlatform,
): AdvancedAdReportAdapter | undefined {
	return REPORT_ADAPTERS.get(platform);
}
