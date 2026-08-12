import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import openApi from "../../../docs/openapi.json";
import {
	changelog,
	footerCols,
	frontier,
	heroChannels,
	productProofs,
} from "../components/landing/data";
import { getApiBySlug } from "../lib/api-data";
import { getPlatformBySlug } from "../lib/platform-data";
import {
	platformConnectionType,
	platformDescriptions,
	platformLabels,
} from "../lib/platform-maps";
import { getExpectedScopes } from "../lib/platform-scopes";
import { PUBLIC_ACCESS_HREF } from "../lib/public-access";

function hasOperation(path: string, method: string): boolean {
	const pathItem = openApi.paths[path as keyof typeof openApi.paths] as
		| Record<string, unknown>
		| undefined;
	return Boolean(pathItem?.[method.toLowerCase()]);
}

describe("public product contract", () => {
	test("the 22-channel hero represents 22 distinct shipped channel ids", () => {
		expect(heroChannels).toHaveLength(22);
		expect(new Set(heroChannels.map((channel) => channel.name)).size).toBe(22);
		expect(heroChannels.map((channel) => channel.name)).toEqual(
			expect.arrayContaining([
				"SMS",
				"Slack",
				"Beehiiv",
				"Kit",
				"Mailchimp",
				"Listmonk",
			]),
		);
		expect(frontier[0]?.body).toContain("22 publishing channels");
		const landingPage = readFileSync(
			new URL("../pages/index.astro", import.meta.url),
			"utf8",
		);
		expect(landingPage).toContain("twenty-two publishing channels");
	});

	test("the dashboard exposes all 22 connection contracts", () => {
		expect(Object.keys(platformConnectionType)).toHaveLength(22);
		expect(platformDescriptions.twitter).toBe("Sign in with X");
		for (const platform of [
			"beehiiv",
			"convertkit",
			"mailchimp",
			"listmonk",
		] as const) {
			expect(platformConnectionType[platform]).toBe("credentials");
			expect(platformLabels[platform]).toBeTruthy();
		}

		const grid = readFileSync(
			new URL(
				"../components/dashboard/connect/platform-grid.tsx",
				import.meta.url,
			),
			"utf8",
		);
		const credentialRoute = readFileSync(
			new URL(
				"../pages/api/connect/[platform]/credentials.ts",
				import.meta.url,
			),
			"utf8",
		);
		const iconMap = readFileSync(
			new URL("../lib/platform-icons.tsx", import.meta.url),
			"utf8",
		);
		for (const platform of Object.keys(platformConnectionType)) {
			expect(grid).toContain(`"${platform}"`);
			expect(iconMap).toContain(`${platform}:`);
		}
		for (const method of [
			"connectBeehiiv",
			"connectConvertKit",
			"connectMailchimp",
			"connectListMonk",
		]) {
			expect(credentialRoute).toContain(`client.connect.${method}`);
		}
		expect(getExpectedScopes("snapchat").posting).toContainEqual(
			expect.objectContaining({
				scope: "snapchat-profile-api",
				label: "Public Profile API",
			}),
		);
		const snapchatPage = JSON.stringify(getPlatformBySlug("snapchat"));
		expect(snapchatPage).toContain("Snapchat Public Profile API");
		expect(snapchatPage).toContain("SNAPCHAT_RECONNECT_REQUIRED");
		expect(snapchatPage).not.toContain("Snapchat Marketing API");
	});

	test("marketing examples use analytics and webhook operations in OpenAPI", () => {
		for (const [path, method] of [
			["/v1/analytics", "get"],
			["/v1/analytics/channels", "get"],
			["/v1/analytics/daily-metrics", "get"],
			["/v1/webhooks", "post"],
			["/v1/webhooks/test", "post"],
			["/v1/webhooks/logs", "get"],
		] as const) {
			expect(hasOperation(path, method)).toBe(true);
		}

		const analytics = getApiBySlug("analytics-api");
		const webhooks = getApiBySlug("webhooks-api");
		expect(analytics).toBeDefined();
		expect(webhooks).toBeDefined();
		const publicCopy = JSON.stringify([analytics, webhooks]);
		expect(publicCopy).not.toContain("/v1/analytics/export");
		expect(publicCopy).not.toContain("/v1/analytics/overview");
		expect(publicCopy).not.toContain("webhooks listen");
		expect(publicCopy).not.toContain("post.engagement_milestone");
	});

	test("unpublished material and access CTAs are explicitly labelled", () => {
		expect(PUBLIC_ACCESS_HREF).toStartWith("mailto:");
		expect(footerCols.flatMap((column) => column.links)).not.toContainEqual(
			expect.objectContaining({ href: "#" }),
		);
		expect(productProofs.every((proof) => proof.status.length > 0)).toBe(true);
		expect(changelog).toHaveLength(1);
		expect(changelog[0]?.title).toContain("Initial release");
		expect(JSON.stringify(frontier)).not.toContain("auto-resized");

		const blog = readFileSync(
			new URL("../components/landing/BlogHighlights.astro", import.meta.url),
			"utf8",
		);
		const legalPageNavbar = readFileSync(
			new URL("../components/section/navbar.tsx", import.meta.url),
			"utf8",
		);
		expect(blog).not.toContain('href="#"');
		expect(blog).toContain("Not published");
		expect(legalPageNavbar).not.toContain('href="/signup"');
		expect(legalPageNavbar).toContain("PUBLIC_ACCESS_HREF");
	});

	test("reported icon-only controls have accessible names", () => {
		const files = [
			"../components/dashboard/pages/team-page.tsx",
			"../components/dashboard/pages/posts/sent-post-card.tsx",
			"../components/dashboard/pages/posts/queue-post-card.tsx",
			"../components/dashboard/inbox/comment-actions.tsx",
			"../components/dashboard/calendar/post-detail-modal.tsx",
		];

		for (const file of files) {
			const source = readFileSync(new URL(file, import.meta.url), "utf8");
			expect(source).toContain("aria-label=");
		}
	});
});
