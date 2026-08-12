import { describe, expect, test } from "bun:test";
import {
	enforceAuthoritativeOrganizationSession,
	hasActiveSessionUserBan,
	isOrganizationEndpoint,
} from "./authoritative-organization-session";

describe("authoritative organization sessions", () => {
	test("matches the complete Better Auth organization surface", () => {
		expect(isOrganizationEndpoint("/organization/create")).toBe(true);
		expect(isOrganizationEndpoint("/organization/update-member-role")).toBe(
			true,
		);
		expect(isOrganizationEndpoint("/organization/list")).toBe(true);
		expect(isOrganizationEndpoint("/admin/ban-user")).toBe(false);
	});

	test("rejects a stale client cookie when no authoritative session exists", async () => {
		const context = {
			request: new Request(
				"https://app.example.com/api/auth/organization/list",
			),
			headers: new Headers({ cookie: "better-auth.session_data=stale" }),
		};
		await expect(
			enforceAuthoritativeOrganizationSession(
				context as never,
				async () => null,
			),
		).rejects.toMatchObject({ status: "UNAUTHORIZED" });
	});

	test("retains server-only calls without headers but rejects active bans", async () => {
		await expect(
			enforceAuthoritativeOrganizationSession({} as never, async () => null),
		).resolves.toBeUndefined();

		await expect(
			enforceAuthoritativeOrganizationSession(
				{} as never,
				async () => ({ user: { banned: true, banExpires: null } }) as never,
			),
		).rejects.toMatchObject({ status: "UNAUTHORIZED" });
	});

	test("treats elapsed temporary bans as inactive and malformed expiries as active", () => {
		expect(
			hasActiveSessionUserBan({ banned: true, banExpires: new Date(99) }, 100),
		).toBe(false);
		expect(
			hasActiveSessionUserBan({ banned: true, banExpires: new Date(101) }, 100),
		).toBe(true);
		expect(hasActiveSessionUserBan({ banned: true, banExpires: "bad" })).toBe(
			true,
		);
	});
});
