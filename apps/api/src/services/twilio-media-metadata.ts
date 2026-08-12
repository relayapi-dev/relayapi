import { parseContentLength } from "../lib/fetch-public-url";
import { fetchWithTimeout } from "../lib/fetch-timeout";

type MetadataFetcher = typeof fetchWithTimeout;

const TWILIO_MEDIA_HOST_SUFFIX = ".twilio.com";

function requiredNonEmpty(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${label} is required`);
	return normalized;
}

/**
 * Resolve the byte size of an inbound Twilio MMS attachment before an
 * automation applies `max_size_mb`.
 *
 * Unlike WhatsApp, Twilio's inbound webhook carries no size: the form body
 * exposes only `MediaUrlN` and `MediaContentTypeN`
 * (https://www.twilio.com/docs/messaging/guides/webhook-request), so the size
 * has to come from the media resource itself. A HEAD against the media URL
 * returns `Content-Length` without transferring the body.
 *
 * Media URLs are authenticated with the account's own credentials
 * (`AccountSid:AuthToken` HTTP Basic), the same pair the SMS publisher uses to
 * send. The host is pinned so a spoofed webhook cannot direct these credentials
 * at an arbitrary origin.
 */
export async function fetchTwilioMediaSize(
	mediaUrl: string,
	accountSid: string,
	authToken: string,
	fetcher: MetadataFetcher = fetchWithTimeout,
): Promise<number> {
	const sid = requiredNonEmpty(accountSid, "Twilio account SID");
	const token = requiredNonEmpty(authToken, "Twilio auth token");
	const url = new URL(requiredNonEmpty(mediaUrl, "Twilio media URL"));
	if (url.protocol !== "https:") {
		throw new Error("Twilio media URL must be HTTPS");
	}
	if (
		url.hostname !== "twilio.com" &&
		!url.hostname.endsWith(TWILIO_MEDIA_HOST_SUFFIX)
	) {
		throw new Error("Twilio media URL host is not a Twilio origin");
	}

	const response = await fetcher(url, {
		method: "HEAD",
		headers: { authorization: `Basic ${btoa(`${sid}:${token}`)}` },
		timeout: 10_000,
		timeoutThroughBody: true,
	});
	await response.body?.cancel().catch(() => {});
	if (!response.ok) {
		throw new Error(
			`Twilio media metadata request failed with HTTP ${response.status}`,
		);
	}

	// parseContentLength already rejects a malformed or content-encoded length,
	// which keeps an unknown size unknown rather than guessing one.
	const sizeBytes = parseContentLength(response.headers);
	if (sizeBytes === null) {
		throw new Error("Twilio media response declared no usable Content-Length");
	}
	return sizeBytes;
}
