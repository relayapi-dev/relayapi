import { readProviderJson, readProviderText } from "../lib/provider-response";
import type { Env } from "../types";

interface ToolServiceResult {
	ok: true;
	data: Record<string, unknown>;
	requestStarted: true;
}

interface ToolServiceError {
	ok: false;
	error: string;
	timedOut?: boolean;
	requestStarted: boolean;
	outcomeUnknown?: boolean;
}

/**
 * Call the Python downloader service with an internal auth key + timeout.
 */
export async function callDownloaderService(
	env: Env,
	path: string,
	body: Record<string, unknown>,
	timeoutMs: number,
	onProviderBoundary?: () => Promise<void> | void,
): Promise<ToolServiceResult | ToolServiceError> {
	const baseUrl = env.DOWNLOADER_SERVICE_URL;
	const key = env.DOWNLOADER_SERVICE_KEY;

	if (!baseUrl || !key) {
		return {
			ok: false,
			error: "Downloader service not configured",
			requestStarted: false,
		};
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		// PostgreSQL must durably record the boundary before fetch can start.
		await onProviderBoundary?.();
	} catch (error) {
		clearTimeout(timer);
		throw error;
	}

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
			const text = await readProviderText(res).catch(() => "Unknown error");
			return {
				ok: false,
				error: `Service returned ${res.status}: ${text}`,
				requestStarted: true,
			};
		}

		const data = (await readProviderJson(res)) as Record<string, unknown>;

		if (data.success === false) {
			return {
				ok: false,
				error: (data.error as string) ?? "Extraction failed",
				requestStarted: true,
			};
		}

		return { ok: true, data, requestStarted: true };
	} catch (err) {
		clearTimeout(timer);
		if (err instanceof DOMException && err.name === "AbortError") {
			return {
				ok: false,
				error: "Service timeout",
				timedOut: true,
				requestStarted: true,
				outcomeUnknown: true,
			};
		}
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Service call failed",
			requestStarted: true,
			outcomeUnknown: true,
		};
	}
}
