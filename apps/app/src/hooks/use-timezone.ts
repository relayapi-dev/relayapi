import { useState, useEffect } from "react";

const CACHE_KEY = "user:timezone";

/**
 * Returns the user's timezone. On first load, auto-detects from the browser
 * and saves to user preferences. On subsequent loads, uses the cached value.
 * If the user has explicitly set a timezone in their profile, that is used.
 */
export function useTimezone(): string {
	const [tz, setTz] = useState(() => {
		if (typeof window === "undefined") return "UTC";
		return (
			localStorage.getItem(CACHE_KEY) ||
			Intl.DateTimeFormat().resolvedOptions().timeZone
		);
	});

	useEffect(() => {
		const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

		fetch("/api/user-preferences")
			.then((r) => r.json())
			.then((data) => {
				if (data.timezone && data.timezone !== "UTC") {
					setTz(data.timezone);
					localStorage.setItem(CACHE_KEY, data.timezone);
				} else {
					// First load or still default — auto-detect from browser
					setTz(browserTz);
					localStorage.setItem(CACHE_KEY, browserTz);
					fetch("/api/user-preferences", {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ timezone: browserTz }),
					}).catch(() => {});
				}
			})
			.catch(() => {
				setTz(browserTz);
			});
	}, []);

	return tz;
}
