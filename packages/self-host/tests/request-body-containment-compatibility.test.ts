import { describe, expect, test } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host public request-body containment compatibility", () => {
	test("uses the existing rate-limit binding and no new self-host resource", async () => {
		const [invite, publicGrowth, helper, wrangler] = await Promise.all([
			Bun.file(`${repositoryRoot}apps/api/src/routes/invite-redeem.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/routes/public-growth.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/lib/bounded-request-body.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}packages/self-host/src/wrangler-config.ts`,
			).text(),
		]);

		expect(invite).toContain("INVITE_REDEEM_MAX_BODY_BYTES = 4 * 1024");
		expect(publicGrowth).toContain(
			"LANDING_CONVERSION_MAX_BODY_BYTES = 16 * 1024",
		);
		expect(helper).toContain("readRequestBytes(request, maxBytes)");
		expect(wrangler).toContain('name: "FREE_RATE_LIMITER"');
	});
});
