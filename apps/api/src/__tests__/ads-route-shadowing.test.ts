// apps/api/src/__tests__/ads-route-shadowing.test.ts
//
// Regression guard for a Hono route-shadowing bug: the single-segment catch-all
// `GET /{id}` (getAd) used to be registered BEFORE the literal routes
// `GET /interests` and `GET /audiences`. Hono resolves overlapping routes in
// registration order (first match wins), so `/{id}` captured "/audiences" and
// "/interests" — the dashboard Audiences/Interests tabs 404'd with "Ad not
// found" (getAd's body). The fix registers the literal routes before `/{id}`.
//
// These are pure unit tests (no DB). If a future edit moves the `/{id}` routes
// back above the literal ones, the request hits getAd and returns the 404 body,
// failing these tests. Mirrors the same guard in automation-routes.test.ts
// ("routes GET /catalog to the catalog handler, not GET /{id}").

import { describe, expect, it } from "bun:test";

// Fully chainable Drizzle stub: every builder method returns the same object;
// the terminal `.limit()` resolves to an empty result set. Covers both the
// listAudiences chain (select→from→where→orderBy→limit) and the getAd chain
// (select→from→where→limit), so if shadowing regresses, getAd cleanly returns
// its 404 "Ad not found" body instead of throwing.
function makeStubDb() {
	// biome-ignore lint/suspicious/noExplicitAny: minimal query-builder stub
	const q: any = {
		select: () => q,
		from: () => q,
		where: () => q,
		orderBy: () => q,
		limit: async () => [],
	};
	return q;
}

async function makeApp() {
	const { OpenAPIHono } = await import("@hono/zod-openapi");
	const { default: adsRouter } = await import("../routes/ads");

	// biome-ignore lint/suspicious/noExplicitAny: test harness stub for context vars
	const app: any = new OpenAPIHono();
	// biome-ignore lint/suspicious/noExplicitAny: Hono context stub for test middleware
	app.use("*", async (c: any, next: any) => {
		c.set("orgId", "org_test");
		c.set("db", makeStubDb());
		c.set("apiKey", { workspaceId: null });
		await next();
	});
	app.route("/v1/ads", adsRouter);
	return app;
}

describe("ads route registration order (no /{id} shadowing)", () => {
	it("routes GET /v1/ads/audiences to listAudiences, not getAd", async () => {
		const app = await makeApp();
		const res = await app.request("/v1/ads/audiences?ad_account_id=acc_test");
		// listAudiences → 200 empty list. If shadowed by getAd → 404 "Ad not found".
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(Array.isArray(body.data)).toBe(true);
	});

	it("routes GET /v1/ads/interests to searchInterests, not getAd", async () => {
		const app = await makeApp();
		const res = await app.request(
			"/v1/ads/interests?social_account_id=acc_test&q=test",
		);
		// searchInterests → 200 { data: [] }. If shadowed by getAd → 404.
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(Array.isArray(body.data)).toBe(true);
	});

	it("still routes GET /v1/ads/{id} to getAd (404 for unknown id)", async () => {
		const app = await makeApp();
		const res = await app.request("/v1/ads/ad_does_not_exist");
		// getAd with the stub db finds no ad → its own 404 "Ad not found" body,
		// confirming the catch-all is still reachable for real ad ids.
		expect(res.status).toBe(404);
		const body = (await res.json()) as {
			error?: { code?: string; message?: string };
		};
		expect(body?.error?.message).toBe("Ad not found");
	});
});
