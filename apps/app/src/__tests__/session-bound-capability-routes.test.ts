import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(path: string): string {
	return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

describe("session-bound dashboard capability routes", () => {
	it("resolves a session-bound client before parsing attacker-controlled bodies", () => {
		for (const routePath of [
			"../pages/api/api-keys.ts",
			"../pages/api/webhooks.ts",
			"../pages/api/webhooks/[id].ts",
			"../pages/api/automations/[id]/graph.ts",
			"../pages/api/automations/[id]/enroll.ts",
			"../pages/api/automations/[id]/entrypoints.ts",
			"../pages/api/automation-entrypoints/[id].ts",
			"../pages/api/automation-bindings/index.ts",
			"../pages/api/automation-bindings/[id].ts",
			"../pages/api/auto-post-rules/[id].ts",
			"../pages/api/short-links/config.ts",
		]) {
			const route = source(routePath);
			const bodyRead = route.indexOf("await ctx.request.json()");
			const clientResolution = route.indexOf(
				"await requireSessionBoundClient(ctx)",
			);
			expect(bodyRead).toBeGreaterThanOrEqual(0);
			expect(clientResolution).toBeGreaterThanOrEqual(0);
			expect(clientResolution).toBeLessThan(bodyRead);
			expect(route).toContain("boundClient.requestOptions");
		}
	});

	it("binds bodyless capability mutations to the authoritative session", () => {
		for (const routePath of [
			"../pages/api/automations/[id]/activate.ts",
			"../pages/api/automations/[id]/resume.ts",
			"../pages/api/automation-entrypoints/[id]/rotate-secret.ts",
			"../pages/api/auto-post-rules/[id]/activate.ts",
		]) {
			const route = source(routePath);
			expect(route).toContain("await requireSessionBoundClient(ctx)");
			expect(route).toContain("boundClient.requestOptions");
		}
	});

	it("binds every dashboard connection step to the exact initiating session", () => {
		for (const routePath of [
			"../pages/api/connect/[platform]/start.ts",
			"../pages/api/connect/[platform]/callback.ts",
			"../pages/api/connect/bluesky.ts",
			"../pages/api/connect/facebook/pages.ts",
			"../pages/api/connect/googlebusiness/locations.ts",
			"../pages/api/connect/linkedin/organizations.ts",
			"../pages/api/connect/pending.ts",
			"../pages/api/connect/pinterest/boards.ts",
			"../pages/api/connect/snapchat/profiles.ts",
			"../pages/api/connect/telegram.ts",
			"../pages/api/connect/whatsapp.ts",
			"../pages/app/connect/start/[platform].ts",
		]) {
			const route = source(routePath);
			expect(route).toContain("await requireSessionBoundClient(ctx)");
			expect(route).not.toContain("await requireClient(ctx)");
			expect(route).toContain(
				"const { client, requestOptions } = boundClient",
			);
			expect(route).toContain("requestOptions");
		}
	});

	it("derives the internal session header exclusively from server locals", () => {
		const apiUtils = source("../lib/api-utils.ts");
		expect(apiUtils).toContain(
			"DASHBOARD_SESSION_AUTHORITY_HEADER]: currentSession.id",
		);
		expect(apiUtils).toContain("dashboardSessionRequestOptions(ctx.locals)");
		const optionsHelperStart = apiUtils.indexOf(
			"export function dashboardSessionRequestOptions",
		);
		const boundClientStart = apiUtils.indexOf(
			"export async function requireSessionBoundClient",
		);
		const optionsHelper = apiUtils.slice(optionsHelperStart, boundClientStart);
		expect(optionsHelper).not.toContain("request.headers.get");
	});
});
