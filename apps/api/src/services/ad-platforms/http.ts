import {
	readResponseBytes,
	readResponseJson,
} from "../../lib/fetch-public-url";
import { fetchWithTimeout } from "../../lib/fetch-timeout";
import type { AdPlatform } from "./types";
import { AdPlatformError } from "./types";

const PROVIDER_TIMEOUT_MS = 20_000;
const PROVIDER_JSON_MAX_BYTES = 2 * 1024 * 1024;

const ALLOWED_HOSTS: Record<AdPlatform, ReadonlySet<string>> = {
	meta: new Set(["graph.facebook.com", "graph.instagram.com"]),
	google: new Set(["googleads.googleapis.com"]),
	tiktok: new Set(["business-api.tiktok.com"]),
	linkedin: new Set(["api.linkedin.com"]),
	pinterest: new Set(["api.pinterest.com"]),
	twitter: new Set(["ads-api.x.com"]),
};

export function assertOfficialAdProviderUrl(
	platform: AdPlatform,
	value: string,
): URL {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		!ALLOWED_HOSTS[platform].has(url.hostname.toLowerCase())
	) {
		throw new AdPlatformError(
			"PROVIDER_PROTOCOL_ERROR",
			`Refused a non-official ${platform} Ads API URL`,
		);
	}
	return url;
}

function providerRequestId(response: Response): string | undefined {
	return (
		response.headers.get("request-id") ??
		response.headers.get("x-request-id") ??
		response.headers.get("x-restli-id") ??
		undefined
	);
}

export async function fetchProviderJson<T>(input: {
	platform: AdPlatform;
	url: string;
	init?: RequestInit;
	maxBytes?: number;
}): Promise<{ data: T; response: Response; requestId?: string }> {
	const url = assertOfficialAdProviderUrl(input.platform, input.url);
	const response = await fetchWithTimeout(url.toString(), {
		timeout: PROVIDER_TIMEOUT_MS,
		...input.init,
		headers: {
			Accept: "application/json",
			...input.init?.headers,
		},
	});
	const requestId = providerRequestId(response);
	let data: T;
	try {
		data = await readResponseJson<T>(
			response,
			input.maxBytes ?? PROVIDER_JSON_MAX_BYTES,
		);
	} catch (error) {
		throw new AdPlatformError(
			"PROVIDER_PROTOCOL_ERROR",
			`${input.platform} returned an invalid or oversized JSON response`,
			{
				requestId,
				cause: error instanceof Error ? error.message : String(error),
			},
		);
	}

	if (!response.ok) {
		const retryAfter = response.headers.get("retry-after");
		throw new AdPlatformError(
			response.status === 429
				? "PROVIDER_RATE_LIMITED"
				: response.status === 401 || response.status === 403
					? "ADS_CONNECTION_AUTH_FAILED"
					: response.status >= 500
						? "PROVIDER_TEMPORARILY_UNAVAILABLE"
						: "PROVIDER_API_ERROR",
			`${input.platform} Ads API returned HTTP ${response.status}`,
			{ requestId, retryAfter, response: data },
		);
	}

	return { data, response, requestId };
}

/** Bounded provider call for REST.li writes that legitimately return 201/204
 * with an empty body and carry the created identifier in a response header. */
export async function fetchProviderOptionalJson<T>(input: {
	platform: AdPlatform;
	url: string;
	init?: RequestInit;
	maxBytes?: number;
}): Promise<{ data: T | null; response: Response; requestId?: string }> {
	const url = assertOfficialAdProviderUrl(input.platform, input.url);
	const response = await fetchWithTimeout(url.toString(), {
		timeout: PROVIDER_TIMEOUT_MS,
		...input.init,
		headers: {
			Accept: "application/json",
			...input.init?.headers,
		},
	});
	const requestId = providerRequestId(response);
	let data: T | null = null;
	try {
		const bytes = await readResponseBytes(
			response,
			input.maxBytes ?? PROVIDER_JSON_MAX_BYTES,
		);
		if (bytes.byteLength > 0) {
			data = JSON.parse(new TextDecoder().decode(bytes)) as T;
		}
	} catch (error) {
		throw new AdPlatformError(
			"PROVIDER_PROTOCOL_ERROR",
			`${input.platform} returned an invalid or oversized response`,
			{
				requestId,
				cause: error instanceof Error ? error.message : String(error),
			},
		);
	}

	if (!response.ok) {
		const retryAfter = response.headers.get("retry-after");
		throw new AdPlatformError(
			response.status === 429
				? "PROVIDER_RATE_LIMITED"
				: response.status === 401 || response.status === 403
					? "ADS_CONNECTION_AUTH_FAILED"
					: response.status >= 500
						? "PROVIDER_TEMPORARILY_UNAVAILABLE"
						: "PROVIDER_API_ERROR",
			`${input.platform} Ads API returned HTTP ${response.status}`,
			{ requestId, retryAfter, response: data },
		);
	}

	return { data, response, requestId };
}

export function objectValue(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : undefined;
}

export function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
