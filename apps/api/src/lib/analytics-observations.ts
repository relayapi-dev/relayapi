export type CumulativeAnalyticsSnapshot = {
	id: string;
	postTargetId: string;
	collectedAt: Date;
	impressions?: number | null;
	likes?: number | null;
	comments?: number | null;
	shares?: number | null;
	clicks?: number | null;
	views?: number | null;
};

type TimelineMetrics = {
	impressions: number;
	likes: number;
	comments: number;
	shares: number;
	clicks: number;
	views: number;
};

function metricsOf(snapshot: CumulativeAnalyticsSnapshot): TimelineMetrics {
	return {
		impressions: snapshot.impressions ?? 0,
		likes: snapshot.likes ?? 0,
		comments: snapshot.comments ?? 0,
		shares: snapshot.shares ?? 0,
		clicks: snapshot.clicks ?? 0,
		views: snapshot.views ?? 0,
	};
}

function compareSnapshots(
	left: CumulativeAnalyticsSnapshot,
	right: CumulativeAnalyticsSnapshot,
): number {
	const byTime = left.collectedAt.getTime() - right.collectedAt.getTime();
	return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
}

/**
 * Convert provider cumulative counters into interval deltas without summing
 * snapshots. Negative provider corrections are represented as zero new units
 * while the cumulative field still reflects the corrected provider value.
 */
export function cumulativeSnapshotsToDecay(
	snapshots: CumulativeAnalyticsSnapshot[],
	publishedAt: Date | null,
) {
	const ordered = [...snapshots].sort(compareSnapshots);
	let previousImpressions = 0;
	let previousEngagement = 0;
	return ordered.map((snapshot, index) => {
		const cumulativeImpressions = snapshot.impressions ?? 0;
		const cumulativeEngagement =
			(snapshot.likes ?? 0) + (snapshot.comments ?? 0) + (snapshot.shares ?? 0);
		const point = {
			day: publishedAt
				? Math.max(
						0,
						Math.floor(
							(snapshot.collectedAt.getTime() - publishedAt.getTime()) /
								86_400_000,
						),
					)
				: index,
			impressions: Math.max(0, cumulativeImpressions - previousImpressions),
			engagement: Math.max(0, cumulativeEngagement - previousEngagement),
			cumulative_impressions: cumulativeImpressions,
			cumulative_engagement: cumulativeEngagement,
		};
		previousImpressions = cumulativeImpressions;
		previousEngagement = cumulativeEngagement;
		return point;
	});
}

/**
 * Produce one cumulative point per UTC day. For each target/day the latest
 * deterministic snapshot wins; targets without a new observation carry their
 * prior value forward instead of disappearing or having every poll summed.
 */
export function cumulativeTimelineByDay(
	snapshots: CumulativeAnalyticsSnapshot[],
): Array<{ date: string } & TimelineMetrics> {
	const byDate = new Map<string, CumulativeAnalyticsSnapshot[]>();
	for (const snapshot of snapshots) {
		const date = snapshot.collectedAt.toISOString().slice(0, 10);
		const rows = byDate.get(date) ?? [];
		rows.push(snapshot);
		byDate.set(date, rows);
	}

	const latestByTarget = new Map<string, CumulativeAnalyticsSnapshot>();
	const output: Array<{ date: string } & TimelineMetrics> = [];
	for (const date of [...byDate.keys()].sort()) {
		for (const snapshot of byDate.get(date) ?? []) {
			const existing = latestByTarget.get(snapshot.postTargetId);
			if (!existing || compareSnapshots(existing, snapshot) < 0) {
				latestByTarget.set(snapshot.postTargetId, snapshot);
			}
		}
		const total: TimelineMetrics = {
			impressions: 0,
			likes: 0,
			comments: 0,
			shares: 0,
			clicks: 0,
			views: 0,
		};
		for (const snapshot of latestByTarget.values()) {
			const metrics = metricsOf(snapshot);
			total.impressions += metrics.impressions;
			total.likes += metrics.likes;
			total.comments += metrics.comments;
			total.shares += metrics.shares;
			total.clicks += metrics.clicks;
			total.views += metrics.views;
		}
		output.push({ date, ...total });
	}
	return output;
}
