export type AutomationCronExpression =
	| { kind: "interval"; minutes: number }
	| { kind: "hourly" }
	| { kind: "daily"; hour: number; minute: number };

/**
 * Parses the deliberately small cron subset supported by automation schedules.
 * Keeping this parser separate lets request validation and the scheduler share
 * one definition of what is executable.
 */
export function parseAutomationCron(
	cron: string,
): AutomationCronExpression | null {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const [minutePart, hourPart, dayOfMonth, month, dayOfWeek] = parts;
	if (
		minutePart === undefined ||
		hourPart === undefined ||
		dayOfMonth !== "*" ||
		month !== "*" ||
		dayOfWeek !== "*"
	) {
		return null;
	}

	if (hourPart === "*" && /^\*\/\d+$/.test(minutePart)) {
		const minutes = Number(minutePart.slice(2));
		return Number.isInteger(minutes) && minutes >= 1 && minutes <= 59
			? { kind: "interval", minutes }
			: null;
	}

	if (hourPart === "*" && minutePart === "0") {
		return { kind: "hourly" };
	}

	const minute = Number(minutePart);
	const hour = Number(hourPart);
	if (
		Number.isInteger(minute) &&
		minute >= 0 &&
		minute <= 59 &&
		Number.isInteger(hour) &&
		hour >= 0 &&
		hour <= 23
	) {
		return { kind: "daily", hour, minute };
	}

	return null;
}

export function isValidAutomationTimezone(timezone: string): boolean {
	if (timezone.trim().length === 0) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
}
