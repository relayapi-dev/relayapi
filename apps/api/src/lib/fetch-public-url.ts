import { fetchWithTimeout } from "./fetch-timeout";
import { isBlockedUrlWithDns } from "./ssrf-guard";

export async function fetchPublicUrl(
	url: string | URL,
	init: RequestInit & { timeout?: number } = {},
): Promise<Response> {
	const urlString = url instanceof URL ? url.toString() : url;
	if (await isBlockedUrlWithDns(urlString)) {
		throw new Error("Blocked public URL");
	}

	return fetchWithTimeout(urlString, {
		...init,
		redirect: "error",
		timeout: init.timeout ?? 30_000,
	});
}
