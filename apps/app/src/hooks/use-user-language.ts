import { useEffect, useState } from "react";

export const USER_LANGUAGE_CACHE_KEY = "user:language";
export const DEFAULT_USER_LANGUAGE = "en";

export const USER_LANGUAGE_OPTIONS = [
	{ value: "en", label: "English" },
	{ value: "es", label: "Español" },
	{ value: "fr", label: "Français" },
	{ value: "de", label: "Deutsch" },
	{ value: "ja", label: "日本語" },
	{ value: "zh", label: "中文" },
] as const;

function applyDocumentLanguage(language: string): void {
	document.documentElement.lang = language;
	localStorage.setItem(USER_LANGUAGE_CACHE_KEY, language);
}

/**
 * Applies the persisted user locale to every dashboard document after first
 * paint. localStorage is a cache only; PostgreSQL remains authoritative.
 */
export function useUserLanguage(): string {
	const [language, setLanguage] = useState(() => {
		if (typeof window === "undefined") return DEFAULT_USER_LANGUAGE;
		return (
			localStorage.getItem(USER_LANGUAGE_CACHE_KEY) ?? DEFAULT_USER_LANGUAGE
		);
	});

	useEffect(() => {
		applyDocumentLanguage(language);
	}, [language]);

	useEffect(() => {
		const load = () => {
			fetch("/api/user-preferences")
				.then((response) => response.json())
				.then((body) => {
					if (typeof body.language !== "string") return;
					setLanguage(body.language);
					applyDocumentLanguage(body.language);
				})
				.catch(() => {});
		};
		const windowWithIdle = window as Window & {
			requestIdleCallback?: (callback: () => void) => number;
			cancelIdleCallback?: (id: number) => void;
		};
		if (windowWithIdle.requestIdleCallback) {
			const id = windowWithIdle.requestIdleCallback(load);
			return () => windowWithIdle.cancelIdleCallback?.(id);
		}
		const id = window.setTimeout(load, 0);
		return () => window.clearTimeout(id);
	}, []);

	return language;
}

export function cacheUserLanguage(language: string): void {
	applyDocumentLanguage(language);
}
