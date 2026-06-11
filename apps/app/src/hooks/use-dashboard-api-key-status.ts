import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDashboardBootstrap } from "@/lib/dashboard-bootstrap";
import { scheduleAfterPaint, scheduleIdleTask } from "@/lib/idle";

interface DashboardApiKeyStatusResponse {
	has_api_key: boolean;
}

interface DashboardApiKeyStatusValue {
	hasApiKey: boolean | null;
	loading: boolean;
	refetch: () => void;
}

const STATUS_CACHE_KEY = "relayapi:dashboard-api-key-status:v1";
const STATUS_CACHE_TTL_MS = 60_000;

function readCachedStatus(): boolean | null {
	if (typeof window === "undefined") return null;

	try {
		const raw = window.sessionStorage.getItem(STATUS_CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as {
			timestamp: number;
			hasApiKey: boolean;
		};

		if (!parsed.hasApiKey) {
			window.sessionStorage.removeItem(STATUS_CACHE_KEY);
			return null;
		}

		if (Date.now() - parsed.timestamp > STATUS_CACHE_TTL_MS) {
			window.sessionStorage.removeItem(STATUS_CACHE_KEY);
			return null;
		}

		return true;
	} catch {
		return null;
	}
}

function writeCachedStatus(hasApiKey: boolean) {
	if (typeof window === "undefined") return;

	try {
		if (!hasApiKey) {
			window.sessionStorage.removeItem(STATUS_CACHE_KEY);
			return;
		}

		window.sessionStorage.setItem(
			STATUS_CACHE_KEY,
			JSON.stringify({
				timestamp: Date.now(),
				hasApiKey: true,
			}),
		);
	} catch {
		// Ignore storage failures.
	}
}

export function useDashboardApiKeyStatus(
	enabled = true,
	orgId?: string | null,
): DashboardApiKeyStatusValue {
	const cachedStatus = readCachedStatus();
	const [hasApiKey, setHasApiKey] = useState<boolean | null>(cachedStatus);
	const [loading, setLoading] = useState(enabled && cachedStatus === null);
	const fetchedRef = useRef(false);

	const fetchStatus = useCallback(async (options?: { background?: boolean }) => {
		const background = options?.background ?? false;
		if (!background) {
			setLoading(true);
		}

		try {
			const res = await fetch("/api/dashboard-key-status", {
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) return;

			const data =
				(await res.json()) as DashboardApiKeyStatusResponse | null;
			const nextHasApiKey = !!data?.has_api_key;
			setHasApiKey(nextHasApiKey);
			writeCachedStatus(nextHasApiKey);
		} catch {
			// Ignore transient local fetch failures.
		} finally {
			if (!background) {
				setLoading(false);
			}
		}
	}, []);

	useEffect(() => {
		if (!enabled || fetchedRef.current) return;
		fetchedRef.current = true;

		if (cachedStatus !== null) {
			setHasApiKey(cachedStatus);
			setLoading(false);
			// Warm-cache refresh via the shared dashboard bootstrap so the sidebar's
			// single bootstrap call serves key status too (org-keyed for cache reuse).
			return scheduleIdleTask(() => {
				void fetchDashboardBootstrap({ orgId }).then((data) => {
					if (data) {
						setHasApiKey(data.has_api_key);
						writeCachedStatus(data.has_api_key);
					}
				});
			}, 1500);
		}

		return scheduleAfterPaint(() => {
			void fetchDashboardBootstrap({ orgId }).then((data) => {
				if (data) {
					setHasApiKey(data.has_api_key);
					writeCachedStatus(data.has_api_key);
					setLoading(false);
				} else {
					void fetchStatus();
				}
			});
		});
	}, [cachedStatus, enabled, fetchStatus, orgId]);

	return {
		hasApiKey,
		loading,
		refetch: () => {
			void fetchStatus();
		},
	};
}
