import { GRAPH_BASE } from "../config/api-versions";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import { readResponseJson } from "../lib/fetch-public-url";

const WHATSAPP_MEDIA_METADATA_MAX_BYTES = 16 * 1024;

type MetadataFetcher = typeof fetchWithTimeout;

export interface WhatsAppMediaMetadata {
	sizeBytes: number;
	mimeType?: string;
}

function requiredNonEmpty(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${label} is required`);
	return normalized;
}

function parseFileSize(value: unknown): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d+$/.test(value)
				? Number(value)
				: Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error("WhatsApp media metadata returned an invalid file_size");
	}
	return parsed;
}

/**
 * Resolve the authoritative byte size for an inbound WhatsApp media id before
 * an automation applies `max_size_mb`.
 *
 * Official contract (Meta WhatsApp Cloud API, "Retrieve Media URL"):
 * https://www.postman.com/meta/whatsapp-business-platform/request/ptjyi84/retrieve-media-url
 * `GET /{media-ID}?phone_number_id={PHONE-NUMBER-ID}` returns `file_size`,
 * `mime_type`, and the same media `id`. The short-lived download URL is
 * intentionally not persisted here.
 */
export async function fetchWhatsAppMediaMetadata(
	mediaId: string,
	phoneNumberId: string,
	accessToken: string,
	fetcher: MetadataFetcher = fetchWithTimeout,
): Promise<WhatsAppMediaMetadata> {
	const requestedMediaId = requiredNonEmpty(mediaId, "WhatsApp media id");
	const requestedPhoneNumberId = requiredNonEmpty(
		phoneNumberId,
		"WhatsApp phone number id",
	);
	const token = requiredNonEmpty(accessToken, "WhatsApp access token");
	const url = new URL(
		`${GRAPH_BASE.facebook}/${encodeURIComponent(requestedMediaId)}`,
	);
	url.searchParams.set("phone_number_id", requestedPhoneNumberId);

	const response = await fetcher(url, {
		method: "GET",
		headers: {
			accept: "application/json",
			authorization: `Bearer ${token}`,
		},
		timeout: 10_000,
		timeoutThroughBody: true,
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new Error(
			`WhatsApp media metadata request failed with HTTP ${response.status}`,
		);
	}

	const payload = await readResponseJson<Record<string, unknown>>(
		response,
		WHATSAPP_MEDIA_METADATA_MAX_BYTES,
	);
	if (
		!payload ||
		typeof payload !== "object" ||
		payload.messaging_product !== "whatsapp" ||
		payload.id !== requestedMediaId
	) {
		throw new Error("WhatsApp media metadata did not match the requested media");
	}

	const mimeType =
		typeof payload.mime_type === "string" && payload.mime_type.trim()
			? payload.mime_type.trim()
			: undefined;
	return {
		sizeBytes: parseFileSize(payload.file_size),
		...(mimeType ? { mimeType } : {}),
	};
}
