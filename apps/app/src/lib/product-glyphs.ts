// Slug → monochrome brand glyph for the product pages. The platform/api data
// modules are JSX-free (so they can be imported in Astro SSR without a React
// jsx-runtime), so icons live here instead, keyed by slug. Platform glyphs reuse
// the landing PLATFORM_PATHS set for visual consistency with the homepage.

import { PLATFORM_PATHS } from "../components/landing/data";

const SMS_GLYPH =
	"M12 2C6.48 2 2 6.04 2 11c0 2.6 1.23 4.94 3.2 6.56-.14 1.06-.6 2.5-1.7 3.84 1.8-.2 3.46-.86 4.7-1.7 1.18.38 2.46.6 3.8.6 5.52 0 10-4.04 10-9S17.52 2 12 2z";

/** Platform slug (lib/platform-data) → single-path brand glyph. */
export const PLATFORM_GLYPHS: Record<string, string> = {
	instagram: PLATFORM_PATHS.instagram,
	twitter: PLATFORM_PATHS.x,
	linkedin: PLATFORM_PATHS.linkedin,
	whatsapp: PLATFORM_PATHS.whatsapp,
	pinterest: PLATFORM_PATHS.pinterest,
	bluesky: PLATFORM_PATHS.bluesky,
	"google-business": PLATFORM_PATHS.google,
	tiktok: PLATFORM_PATHS.tiktok,
	facebook: PLATFORM_PATHS.facebook,
	youtube: PLATFORM_PATHS.youtube,
	threads: PLATFORM_PATHS.threads,
	reddit: PLATFORM_PATHS.reddit,
	telegram: PLATFORM_PATHS.telegram,
	snapchat: PLATFORM_PATHS.snapchat,
	mastodon: PLATFORM_PATHS.mastodon,
	discord: PLATFORM_PATHS.discord,
	twilio: SMS_GLYPH,
};

export function platformGlyph(slug: string): string {
	return PLATFORM_GLYPHS[slug] ?? SMS_GLYPH;
}

/** Default stroke icon (paper plane) — used as the fallback. */
const DEFAULT_API_ICON = ["M22 2 11 13", "M22 2 15 22 11 13 2 9 22 2z"];

/** API slug → stroke-style line-icon path set (Lucide-ish). */
export const API_ICON_PATHS: Record<string, string[]> = {
	"posting-api": DEFAULT_API_ICON,
	"media-api": [
		"M3 3h18v18H3z",
		"M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
		"m21 15-5-5L5 21",
	],
	"analytics-api": ["M3 3v18h18", "M7 16V9", "M12 16V5", "M17 16v-7"],
	"webhooks-api": [
		"M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 1 1 2 17c.01-.7.2-1.4.57-2",
		"m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06",
		"m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8",
	],
};

export function apiIconPaths(slug: string): string[] {
	return API_ICON_PATHS[slug] ?? DEFAULT_API_ICON;
}
