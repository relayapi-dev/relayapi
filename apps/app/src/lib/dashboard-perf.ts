const DEBUG_QUERY_PARAM = "debug_perf";
const DEBUG_STORAGE_KEY = "relayapi:debug-perf";

export const DASHBOARD_PERF_DEBUG_HEADER = "x-relay-debug-perf";

type DashboardPerfPayload = Record<string, unknown>;

function parseDebugFlag(value: string | null): boolean | null {
	if (!value) return null;

	switch (value.toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return null;
	}
}

function roundMs(value: number): number {
	return Number(value.toFixed(1));
}

function readClientDebugFlag(): boolean {
	if (typeof window === "undefined") return false;

	const urlFlag = parseDebugFlag(
		new URLSearchParams(window.location.search).get(DEBUG_QUERY_PARAM),
	);

	try {
		if (urlFlag === true) {
			window.sessionStorage.setItem(DEBUG_STORAGE_KEY, "1");
			return true;
		}

		if (urlFlag === false) {
			window.sessionStorage.removeItem(DEBUG_STORAGE_KEY);
			return false;
		}

		return window.sessionStorage.getItem(DEBUG_STORAGE_KEY) === "1";
	} catch {
		return urlFlag === true;
	}
}

function normalizeFetchTarget(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

export function isDashboardPerfEnabledClient(): boolean {
	return readClientDebugFlag();
}

export function isDashboardPerfEnabledServer(
	url: URL,
	headers?: Headers,
): boolean {
	const queryFlag = parseDebugFlag(url.searchParams.get(DEBUG_QUERY_PARAM));
	if (queryFlag !== null) return queryFlag;

	return parseDebugFlag(headers?.get(DASHBOARD_PERF_DEBUG_HEADER) ?? null) === true;
}

export function withDashboardPerfHeaders(headers?: HeadersInit): Headers {
	const nextHeaders = new Headers(headers);

	if (isDashboardPerfEnabledClient()) {
		nextHeaders.set(DASHBOARD_PERF_DEBUG_HEADER, "1");
	}

	return nextHeaders;
}

export async function dashboardPerfFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
	meta?: DashboardPerfPayload,
): Promise<Response> {
	const enabled = isDashboardPerfEnabledClient();
	const requestInit = enabled
		? {
				...init,
				headers: withDashboardPerfHeaders(init?.headers),
			}
		: init;

	if (!enabled) {
		return fetch(input, requestInit);
	}

	const startedAt = performance.now();
	const target = normalizeFetchTarget(input);

	console.info("[dashboard-perf][client] fetch:start", {
		target,
		...meta,
	});

	try {
		const response = await fetch(input, requestInit);
		console.info("[dashboard-perf][client] fetch:end", {
			target,
			status: response.status,
			ok: response.ok,
			ms: roundMs(performance.now() - startedAt),
			...meta,
		});
		return response;
	} catch (error) {
		console.info("[dashboard-perf][client] fetch:error", {
			target,
			ms: roundMs(performance.now() - startedAt),
			error: error instanceof Error ? error.message : String(error),
			...meta,
		});
		throw error;
	}
}

export function logDashboardPerfClient(
	event: string,
	payload?: DashboardPerfPayload,
): void {
	if (!isDashboardPerfEnabledClient()) return;

	console.info(`[dashboard-perf][client] ${event}`, payload ?? {});
}

export function logDashboardPerfServer(
	event: string,
	payload?: DashboardPerfPayload,
): void {
	console.info(`[dashboard-perf][server] ${event}`, payload ?? {});
}

export function getDashboardPerfDurationMs(startedAt: number): number {
	return roundMs(performance.now() - startedAt);
}

export function getDashboardNavigationTimingSnapshot():
	| DashboardPerfPayload
	| null {
	if (typeof window === "undefined") return null;

	const [navigationEntry] = performance.getEntriesByType(
		"navigation",
	) as PerformanceNavigationTiming[];

	if (!navigationEntry) return null;

	return {
		type: navigationEntry.type,
		redirectCount: navigationEntry.redirectCount,
		ttfbMs: roundMs(
			navigationEntry.responseStart - navigationEntry.requestStart,
		),
		requestMs: roundMs(
			navigationEntry.responseEnd - navigationEntry.requestStart,
		),
		responseEndMs: roundMs(navigationEntry.responseEnd),
		domInteractiveMs: roundMs(navigationEntry.domInteractive),
		domContentLoadedMs: roundMs(navigationEntry.domContentLoadedEventEnd),
		domCompleteMs: roundMs(navigationEntry.domComplete),
		loadEventEndMs: roundMs(navigationEntry.loadEventEnd),
		transferSize: navigationEntry.transferSize,
		encodedBodySize: navigationEntry.encodedBodySize,
		decodedBodySize: navigationEntry.decodedBodySize,
		elapsedFromNavStartMs: roundMs(performance.now()),
	};
}
