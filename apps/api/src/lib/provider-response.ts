import { readResponseBytes, readResponseJson } from "./fetch-public-url";

/**
 * Provider control-plane responses are expected to be small JSON or diagnostic
 * payloads. Bound every body that is materialized so a malformed or compromised
 * upstream cannot consume the Worker's shared isolate memory.
 *
 * Media payloads must keep their provider-specific streaming limits and must not
 * use this helper.
 * https://developers.cloudflare.com/workers/best-practices/workers-best-practices/#stream-request-and-response-bodies
 */
export const PROVIDER_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

export function readProviderJson<T = unknown>(response: Response): Promise<T> {
	return readResponseJson<T>(response, PROVIDER_RESPONSE_MAX_BYTES);
}

export async function readProviderText(response: Response): Promise<string> {
	const bytes = await readResponseBytes(response, PROVIDER_RESPONSE_MAX_BYTES);
	return new TextDecoder().decode(bytes);
}
