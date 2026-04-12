import {
	createDb,
	posts,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getCachedBestTimes, type BestTimeSlot } from "./best-time-cache";
import type { Env } from "../types";

export interface SlotCandidate {
	slot_at: string;
	score: number;
	reason: "queue_slot" | "best_time" | "hybrid";
	conflicts: number;
}

export interface FindSlotOptions {
	accountId?: string;
	after?: Date;
	strategy?: "queue" | "best-time" | "smart";
	count?: number;
	excludeTimes?: Date[];
}

interface StoredSchedule {
	id: string;
	name: string;
	slots: Array<{ day_of_week: number; time: string; timezone: string }>;
	is_default: boolean;
}

/**
 * Calculate the next N upcoming slot times from a schedule's slots.
 * Reused from queue.ts logic.
 */
function calculateUpcomingSlots(
	slots: StoredSchedule["slots"],
	count: number,
	now: Date,
): Date[] {
	if (slots.length === 0) return [];

	const upcoming: Date[] = [];
	const weeksToCheck = Math.ceil(count / slots.length) + 1;

	for (const slot of slots) {
		const [hoursStr, minutesStr] = slot.time.split(":");
		const hours = Number.parseInt(hoursStr as string, 10);
		const minutes = Number.parseInt(minutesStr as string, 10);

		// Use Intl.DateTimeFormat to resolve the current day-of-week in the slot's timezone
		const tzDayFormat = new Intl.DateTimeFormat("en-US", {
			timeZone: slot.timezone,
			weekday: "short",
		});
		const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

		for (let weekOffset = 0; weekOffset < weeksToCheck; weekOffset++) {
			const currentDay = dayMap[tzDayFormat.format(now)] ?? now.getUTCDay();
			let daysUntilTarget = slot.day_of_week - currentDay;
			if (daysUntilTarget < 0) daysUntilTarget += 7;
			daysUntilTarget += weekOffset * 7;

			// Build the target date in the slot's timezone, then convert to UTC
			const baseDate = new Date(now);
			baseDate.setUTCDate(baseDate.getUTCDate() + daysUntilTarget);

			const dateParts = new Intl.DateTimeFormat("en-US", {
				timeZone: slot.timezone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			}).formatToParts(baseDate);
			const year = dateParts.find((p) => p.type === "year")?.value;
			const month = dateParts.find((p) => p.type === "month")?.value;
			const day = dateParts.find((p) => p.type === "day")?.value;

			const localDateStr = `${year}-${month}-${day}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;

			// Compute the UTC offset for this timezone at this date/time
			const tempUtc = new Date(localDateStr + "Z");
			const tzOffsetParts = new Intl.DateTimeFormat("en-US", {
				timeZone: slot.timezone,
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			}).formatToParts(tempUtc);
			const tzHour = Number(tzOffsetParts.find((p) => p.type === "hour")?.value ?? "0");
			const tzMinute = Number(tzOffsetParts.find((p) => p.type === "minute")?.value ?? "0");
			const localMinutes = tzHour * 60 + tzMinute;
			const utcMinutes = tempUtc.getUTCHours() * 60 + tempUtc.getUTCMinutes();
			let offsetMinutes = localMinutes - utcMinutes;
			if (offsetMinutes > 720) offsetMinutes -= 1440;
			if (offsetMinutes < -720) offsetMinutes += 1440;

			const target = new Date(tempUtc.getTime() - offsetMinutes * 60 * 1000);

			if (target.getTime() > now.getTime()) {
				upcoming.push(target);
			}
		}
	}

	upcoming.sort((a, b) => a.getTime() - b.getTime());
	return upcoming.slice(0, count);
}

async function getSchedules(kv: KVNamespace, orgId: string): Promise<StoredSchedule[]> {
	const data = await kv.get<StoredSchedule[]>(`queue-schedule:${orgId}`, "json");
	return data ?? [];
}

/**
 * Find the best available posting slots for an organization.
 */
export async function findBestSlots(
	env: Env,
	orgId: string,
	options: FindSlotOptions = {},
): Promise<{ slots: SlotCandidate[]; fallback: boolean }> {
	const {
		accountId,
		after = new Date(),
		strategy = "smart",
		count = 1,
		excludeTimes = [],
	} = options;

	// Load queue schedule from KV
	const schedules = await getSchedules(env.KV, orgId);
	const schedule = schedules.find((s) => s.is_default) ?? schedules[0];
	const queueSlots = schedule?.slots ?? [];

	// Generate candidate times from queue slots (14 days worth)
	const maxCandidates = Math.max(count * 10, 50);
	const queueCandidates = calculateUpcomingSlots(queueSlots, maxCandidates, after);
	const queueTimesSet = new Set(queueCandidates.map((d) => d.toISOString()));

	// For best-time strategy, also generate candidates from engagement data
	let bestTimeData: BestTimeSlot[] = [];
	if (strategy === "best-time" || strategy === "smart") {
		bestTimeData = await getCachedBestTimes(env, orgId);
	}

	// Build candidate set
	let candidates: Date[];
	if (strategy === "queue") {
		candidates = queueCandidates;
	} else if (strategy === "best-time") {
		candidates = generateBestTimeCandidates(bestTimeData, after, maxCandidates);
	} else {
		// smart: merge both sources
		const bestTimeCandidates = generateBestTimeCandidates(bestTimeData, after, maxCandidates);
		const merged = new Map<string, Date>();
		for (const d of queueCandidates) merged.set(d.toISOString(), d);
		for (const d of bestTimeCandidates) merged.set(d.toISOString(), d);
		candidates = Array.from(merged.values());
	}

	// Filter out excluded times (for batch auto-scheduling)
	if (excludeTimes.length > 0) {
		const excludeSet = new Set(excludeTimes.map((d) => d.toISOString()));
		candidates = candidates.filter((d) => !excludeSet.has(d.toISOString()));
	}

	// Filter: must be after the `after` time
	candidates = candidates.filter((d) => d.getTime() > after.getTime());

	if (candidates.length === 0) {
		return { slots: [], fallback: true };
	}

	// Collision check: single DB query for all candidates within window
	const windowStart = new Date(Math.min(...candidates.map((d) => d.getTime())));
	const windowEnd = new Date(Math.max(...candidates.map((d) => d.getTime())));
	// Add buffer for collision window (5 minutes each side)
	windowStart.setMinutes(windowStart.getMinutes() - 5);
	windowEnd.setMinutes(windowEnd.getMinutes() + 5);

	const db = createDb(env.HYPERDRIVE.connectionString);
	const scheduledPosts = await db
		.select({ scheduledAt: posts.scheduledAt })
		.from(posts)
		.where(
			and(
				eq(posts.organizationId, orgId),
				inArray(posts.status, ["scheduled", "publishing"]),
				gte(posts.scheduledAt, windowStart),
				lte(posts.scheduledAt, windowEnd),
			),
		);

	// Count conflicts per candidate (posts within +/- 5 minutes)
	const conflictCounts = new Map<string, number>();
	for (const candidate of candidates) {
		const key = candidate.toISOString();
		let conflicts = 0;
		for (const sp of scheduledPosts) {
			if (!sp.scheduledAt) continue;
			const diff = Math.abs(candidate.getTime() - sp.scheduledAt.getTime());
			if (diff <= 5 * 60 * 1000) conflicts++;
		}
		conflictCounts.set(key, conflicts);
	}

	// Load account preferences if accountId provided
	let minGapMinutes = 0;
	let postingWindows: Array<{ day_of_week: number; start_hour: number; end_hour: number }> = [];
	if (accountId) {
		const [account] = await db
			.select({ schedulingPreferences: socialAccounts.schedulingPreferences })
			.from(socialAccounts)
			.where(eq(socialAccounts.id, accountId))
			.limit(1);
		if (account?.schedulingPreferences) {
			const prefs = account.schedulingPreferences as {
				posting_windows?: Array<{ day_of_week: number; start_hour: number; end_hour: number }>;
				min_gap_minutes?: number;
			};
			postingWindows = prefs.posting_windows ?? [];
			minGapMinutes = prefs.min_gap_minutes ?? 0;
		}
	}

	// Compute max engagement for percentile scoring
	const maxEngagement = bestTimeData.length > 0
		? Math.max(...bestTimeData.map((b) => b.avg_engagement))
		: 0;
	const engagementMap = new Map(
		bestTimeData.map((b) => [`${b.day_of_week}:${b.hour_utc}`, b.avg_engagement]),
	);

	// Score each candidate
	const scored: SlotCandidate[] = candidates.map((d) => {
		const key = d.toISOString();
		const dow = d.getUTCDay();
		const hour = d.getUTCHours();
		const conflicts = conflictCounts.get(key) ?? 0;

		// Queue score: 40 points if this time is in the queue schedule
		const queueScore = queueTimesSet.has(key) ? 40 : 0;

		// Engagement score: up to 40 points based on historical engagement percentile
		const engagementKey = `${dow}:${hour}`;
		const engagement = engagementMap.get(engagementKey) ?? 0;
		const engagementPercentile = maxEngagement > 0 ? engagement / maxEngagement : 0;
		const engagementScore = Math.round(engagementPercentile * 40);

		// Collision score: 20 points if no conflicts
		const collisionScore = conflicts === 0 ? 20 : 0;

		let score = queueScore + engagementScore + collisionScore;

		// Apply posting window filter if account preferences set
		if (postingWindows.length > 0) {
			const inWindow = postingWindows.some(
				(w: { day_of_week: number; start_hour: number; end_hour: number }) =>
					w.day_of_week === dow && hour >= w.start_hour && hour < w.end_hour,
			);
			if (!inWindow) score = Math.max(0, score - 30);
		}

		// Determine reason
		let reason: SlotCandidate["reason"] = "hybrid";
		if (queueScore > 0 && engagementScore === 0) reason = "queue_slot";
		else if (queueScore === 0 && engagementScore > 0) reason = "best_time";

		return { slot_at: key, score, reason, conflicts };
	});

	// Sort by score descending, then by time ascending for ties
	scored.sort((a, b) => b.score - a.score || new Date(a.slot_at).getTime() - new Date(b.slot_at).getTime());

	const topSlots = scored.slice(0, count);
	const fallback = topSlots.length === 0 || (topSlots[0]?.score ?? 0) < 20;

	return { slots: topSlots, fallback };
}

/**
 * Find a single best slot.
 */
export async function findBestSlot(
	env: Env,
	orgId: string,
	options: FindSlotOptions = {},
): Promise<SlotCandidate | null> {
	const result = await findBestSlots(env, orgId, { ...options, count: 1 });
	return result.slots[0] ?? null;
}

/**
 * Generate candidate times from best-time engagement data.
 * For each high-engagement hour, produce a candidate at :00 for the next 14 days.
 */
function generateBestTimeCandidates(
	bestTimeData: BestTimeSlot[],
	after: Date,
	maxCount: number,
): Date[] {
	if (bestTimeData.length === 0) return [];

	// Take top 10 time slots by engagement
	const topSlots = bestTimeData.slice(0, 10);
	const candidates: Date[] = [];

	for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
		for (const slot of topSlots) {
			const d = new Date(after);
			d.setUTCDate(d.getUTCDate() + dayOffset);

			// Check if this day matches the slot's day_of_week
			// Adjust to find the next occurrence of this day_of_week
			const currentDay = d.getUTCDay();
			if (currentDay !== slot.day_of_week) continue;

			d.setUTCHours(slot.hour_utc, 0, 0, 0);
			if (d.getTime() > after.getTime()) {
				candidates.push(d);
			}
		}
	}

	candidates.sort((a, b) => a.getTime() - b.getTime());
	return candidates.slice(0, maxCount);
}
