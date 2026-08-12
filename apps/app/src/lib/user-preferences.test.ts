import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { userPreferences } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	DEFAULT_USER_LANGUAGE,
	USER_LANGUAGE_OPTIONS,
} from "../hooks/use-user-language";

describe("user preference completion", () => {
	it("closes the persisted language domain and keeps a one-row user authority", () => {
		const checks = getTableConfig(userPreferences).checks.map(
			(candidate) => candidate.name,
		);
		expect(checks).toContain("user_preferences_language_check");
		expect(checks).toContain("user_preferences_timezone_shape_check");
		expect(userPreferences.userId.isUnique).toBe(true);
		expect(DEFAULT_USER_LANGUAGE).toBe("en");
		expect(USER_LANGUAGE_OPTIONS.map(({ value }) => value)).toEqual([
			"en",
			"es",
			"fr",
			"de",
			"ja",
			"zh",
		]);
	});

	it("validates and atomically upserts both preference dimensions", () => {
		const route = readFileSync(
			new URL("../pages/api/user-preferences.ts", import.meta.url),
			"utf8",
		);
		expect(route).toContain("isValidTimezone");
		expect(route).toContain("VALID_LANGUAGES.has");
		expect(route).toContain(".onConflictDoUpdate({");
		expect(route).toContain("target: userPreferences.userId");
		expect(route).toContain(".returning({");
	});

	it("offers language in profile and applies it to every dashboard document", () => {
		const profile = readFileSync(
			new URL("../components/dashboard/pages/profile-page.tsx", import.meta.url),
			"utf8",
		);
		const shell = readFileSync(
			new URL("../components/dashboard/dashboard-shell.tsx", import.meta.url),
			"utf8",
		);
		const hook = readFileSync(
			new URL("../hooks/use-user-language.ts", import.meta.url),
			"utf8",
		);
		expect(profile).toContain('id="profile-language"');
		expect(profile).toContain("saveLanguage");
		expect(shell).toContain("useUserLanguage()");
		expect(hook).toContain("document.documentElement.lang = language");
		expect(hook).toContain('fetch("/api/user-preferences")');
	});
});
