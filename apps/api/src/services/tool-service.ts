import type { Env } from "../types";

interface ToolServiceResult {
	ok: true;
	data: Record<string, unknown>;
}

interface ToolServiceError {
	ok: false;
	error: string;
	timedOut?: boolean;
}

/**
 * Call the Python downloader service with an internal auth key + timeout.
 */
export async function callDownloaderService(
	env: Env,
	path: string,
	body: Record<string, unknown>,
	timeoutMs: number,
): Promise<ToolServiceResult | ToolServiceError> {
	const baseUrl = env.DOWNLOADER_SERVICE_URL;
	const key = env.DOWNLOADER_SERVICE_KEY;

	if (!baseUrl || !key) {
		return { ok: false, error: "Downloader service not configured" };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetch(`${baseUrl}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Internal-Key": key,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		clearTimeout(timer);

		if (!res.ok) {
			const text = await res.text().catch(() => "Unknown error");
			return { ok: false, error: `Service returned ${res.status}: ${text}` };
		}

		const data = (await res.json()) as Record<string, unknown>;

		if (data.success === false) {
			return {
				ok: false,
				error: (data.error as string) ?? "Extraction failed",
			};
		}

		return { ok: true, data };
	} catch (err) {
		clearTimeout(timer);
		if (err instanceof DOMException && err.name === "AbortError") {
			return { ok: false, error: "Service timeout", timedOut: true };
		}
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Service call failed",
		};
	}
}
