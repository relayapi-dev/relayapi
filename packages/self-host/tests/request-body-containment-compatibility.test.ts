import { describe, expect, test } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host request containment compatibility", () => {
	test("uses the existing rate-limit binding and no new self-host resource", async () => {
		const [
			invite,
			publicGrowth,
			helper,
			bodyCache,
			analytics,
			bestTime,
			slotFinder,
			wrangler,
		] = await Promise.all([
			Bun.file(`${repositoryRoot}apps/api/src/routes/invite-redeem.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/routes/public-growth.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/lib/bounded-request-body.ts`,
			).text(),
			Bun.file(`${repositoryRoot}apps/api/src/middleware/body-cache.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/routes/analytics.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/best-time-cache.ts`,
			).text(),
			Bun.file(`${repositoryRoot}apps/api/src/services/slot-finder.ts`).text(),
			Bun.file(
				`${repositoryRoot}packages/self-host/src/wrangler-config.ts`,
			).text(),
		]);

		expect(invite).toContain("INVITE_REDEEM_MAX_BODY_BYTES = 4 * 1024");
		expect(publicGrowth).toContain(
			"LANDING_CONVERSION_MAX_BODY_BYTES = 16 * 1024",
		);
		expect(helper).toContain("readRequestBytes(request, maxBytes)");
		expect(bodyCache).toContain(
			"MAX_AUTHENTICATED_JSON_BODY_BYTES = 4 * 1024 * 1024",
		);
		expect(bodyCache).toContain(
			"MAX_BULK_CSV_MULTIPART_BODY_BYTES = 2 * 1024 * 1024",
		);
		expect(bodyCache).toContain(
			"MAX_IDEA_MEDIA_MULTIPART_BODY_BYTES = 3 * 1024 * 1024",
		);
		expect(bodyCache).toContain("seedBoundedRequestBody(c.req, bytes)");
		expect(analytics).toContain("legacyAnalyticsConditions");
		expect(analytics).toContain("requireLegacyAnalyticsPost");
		expect(bestTime).toContain("workspaceScope");
		expect(bestTime).not.toContain("createDb(");
		expect(slotFinder).toContain(
			"workspaceScopeSqlCondition(workspaceScope, posts.workspaceId)",
		);
		expect(wrangler).toContain('name: "FREE_RATE_LIMITER"');
	});
});
