import type { StreakData } from "@/hooks/use-streak";
import type { UsageData } from "@/hooks/use-usage";

export interface DashboardBootstrapData {
	has_api_key: boolean;
	usage: UsageData | null;
	streak: StreakData | null;
	notif_count: number;
}

interface CacheEntry {
	at: number;
	data: DashboardBootstrapData | null;
}

// Short-lived result cache so the 4 dashboard consumers (sidebar bootstrap +
// usage/streak/key-status hooks) share a single /api/dashboard-bootstrap call
// per full-document navigation instead of each refiring it once the in-flight
// promise has resolved. Keyed by active org id so an org switch isn't served a
// stale result.
const RESULT_TTL_MS = 45_000;

let pending: Promise<DashboardBootstrapData | null> | null = null;
let pendingKey: string | null = null;
let cache: { key: string; entry: CacheEntry } | null = null;

export interface FetchDashboardBootstrapOptions {
	/** Cache key (typically the active org id) so org switches aren't served stale data. */
	orgId?: string | null;
	/** Bypass the TTL cache and force a fresh fetch. */
	force?: boolean;
}

export function fetchDashboardBootstrap(
	options: FetchDashboardBootstrapOptions = {},
): Promise<DashboardBootstrapData | null> {
	const key = options.orgId ?? "__default__";

	if (!options.force) {
		// Serve a fresh cached result if we have one for this org.
		if (
			cache &&
			cache.key === key &&
			Date.now() - cache.entry.at < RESULT_TTL_MS
		) {
			return Promise.resolve(cache.entry.data);
		}
		// Coalesce with an in-flight request for the same org.
		if (pending && pendingKey === key) return pending;
	}

	const request = (async () => {
		try {
			const res = await fetch("/api/dashboard-bootstrap", {
				signal: AbortSignal.timeout(15_000),
			});
			if (!res.ok) return null;
			return (await res.json()) as DashboardBootstrapData;
		} catch {
			return null;
		}
	})();

	pending = request;
	pendingKey = key;
	request
		.then((data) => {
			// Only cache successful responses so a transient failure doesn't
			// suppress retries for the whole TTL window.
			if (data) cache = { key, entry: { at: Date.now(), data } };
		})
		.finally(() => {
			if (pending === request) {
				pending = null;
				pendingKey = null;
			}
		});

	return request;
}
