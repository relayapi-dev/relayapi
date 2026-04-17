import type { NodeHandler } from "../types";

interface QuietHours {
	start: string; // HH:mm
	end: string; // HH:mm
	timezone?: string; // IANA, defaults to UTC
}

export const smartDelayHandler: NodeHandler = async (ctx) => {
	const minutes = ctx.node.config.duration_minutes as number | undefined;
	if (typeof minutes !== "number" || minutes < 1) {
		return {
			kind: "fail",
			error: "smart_delay missing or invalid duration_minutes",
		};
	}

	const raw = ctx.node.config.quiet_hours as QuietHours | undefined;
	const baseRunAt = new Date(Date.now() + minutes * 60 * 1000);
	const nextRunAt = raw ? applyQuietHours(baseRunAt, raw) : baseRunAt;

	return { kind: "wait", next_run_at: nextRunAt };
};

/**
 * If `runAt` falls inside the configured quiet window (in the given IANA
 * timezone), push it forward to the next occurrence of the `end` time. If the
 * window crosses midnight (e.g. 22:00 → 07:00) we handle that case too.
 *
 * Returns `runAt` unchanged when it is already outside the window.
 */
export function applyQuietHours(runAt: Date, qh: QuietHours): Date {
	const tz = qh.timezone ?? "UTC";
	const startMin = parseHHmm(qh.start);
	const endMin = parseHHmm(qh.end);
	if (startMin === null || endMin === null || startMin === endMin) {
		// Malformed or zero-width window — ignore to fail open rather than strand
		// the enrollment indefinitely.
		return runAt;
	}

	const parts = tzParts(runAt, tz);
	if (!parts) return runAt;
	const runMin = parts.hour * 60 + parts.minute;
	const crossesMidnight = startMin > endMin;
	const insideWindow = crossesMidnight
		? runMin >= startMin || runMin < endMin
		: runMin >= startMin && runMin < endMin;
	if (!insideWindow) return runAt;

	// Compute the target "end" moment in the run's local date. If the quiet
	// window crosses midnight and the current local time is before `end`, the
	// target is today's `end`. Otherwise it's tomorrow's `end`.
	let targetDay = parts;
	if (crossesMidnight && runMin < endMin) {
		// already the morning tail of the window — today's `end` is correct.
	} else if (crossesMidnight) {
		targetDay = addDays(parts, 1);
	}

	return resolveTzLocal(targetDay.year, targetDay.month, targetDay.day, endMin, tz);
}

function parseHHmm(s: string): number | null {
	const m = /^(\d{2}):(\d{2})$/.exec(s);
	if (!m) return null;
	const h = Number(m[1]);
	const mm = Number(m[2]);
	if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
	return h * 60 + mm;
}

interface TzParts {
	year: number;
	month: number; // 1-12
	day: number;
	hour: number;
	minute: number;
}

function tzParts(d: Date, tz: string): TzParts | null {
	try {
		const fmt = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
		const parts = fmt.formatToParts(d);
		const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
		const hour24 = get("hour") === 24 ? 0 : get("hour");
		return {
			year: get("year"),
			month: get("month"),
			day: get("day"),
			hour: hour24,
			minute: get("minute"),
		};
	} catch {
		return null;
	}
}

function addDays(p: TzParts, n: number): TzParts {
	const utc = Date.UTC(p.year, p.month - 1, p.day) + n * 86_400_000;
	const d = new Date(utc);
	return {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
		hour: p.hour,
		minute: p.minute,
	};
}

/**
 * Given a local Y/M/D + minute-of-day in a given IANA tz, return the absolute
 * UTC Date. Computed by constructing a UTC guess and correcting for the tz
 * offset that Intl reports back, which handles DST transitions.
 */
function resolveTzLocal(
	year: number,
	month: number,
	day: number,
	minuteOfDay: number,
	tz: string,
): Date {
	const hour = Math.floor(minuteOfDay / 60);
	const minute = minuteOfDay % 60;
	const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
	const observed = tzParts(new Date(utcGuess), tz);
	if (!observed) return new Date(utcGuess);
	const observedMs = Date.UTC(
		observed.year,
		observed.month - 1,
		observed.day,
		observed.hour,
		observed.minute,
	);
	const offset = utcGuess - observedMs;
	return new Date(utcGuess + offset);
}
