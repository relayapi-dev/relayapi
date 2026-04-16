import type { StreakData } from "@/hooks/use-streak";
import type { UsageData } from "@/hooks/use-usage";

export interface DashboardBootstrapData {
	has_api_key: boolean;
	usage: UsageData | null;
	streak: StreakData | null;
	notif_count: number;
}

let pending: Promise<DashboardBootstrapData | null> | null = null;

export function fetchDashboardBootstrap(): Promise<DashboardBootstrapData | null> {
	if (pending) return pending;

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
	request.finally(() => {
		if (pending === request) pending = null;
	});

	return request;
}
