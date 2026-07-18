import { describe, expect, it } from "bun:test";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

const proGateSources = [
	["reviews", "apps/app/src/components/dashboard/pages/inbox-reviews-page.tsx"],
	[
		"comments",
		"apps/app/src/components/dashboard/pages/inbox-comments-page.tsx",
	],
	[
		"messages",
		"apps/app/src/components/dashboard/pages/inbox-messages-page.tsx",
	],
	[
		"analytics",
		"apps/app/src/components/dashboard/pages/analytics/analytics-page-new.tsx",
	],
] as const;

const upgradeLinkPattern =
	/<a\s+[^>]*href=["']\/app\/billing["'][^>]*>\s*Upgrade to Pro\s*<\/a>/m;

describe("Pro feature upgrade links", () => {
	for (const [feature, sourcePath] of proGateSources) {
		it(`${feature} links its upgrade CTA to billing`, async () => {
			const source = await Bun.file(`${repoRoot}${sourcePath}`).text();

			expect(source).toMatch(upgradeLinkPattern);
		});
	}
});
