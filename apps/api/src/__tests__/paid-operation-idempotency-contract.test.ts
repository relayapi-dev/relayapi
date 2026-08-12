import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Relay } from "../../../../packages/sdk/src/client";
import type { Ads } from "../../../../packages/sdk/src/resources/ads";
import type { PhoneNumbers } from "../../../../packages/sdk/src/resources/whatsapp/phone-numbers";
import adsRoutes from "../routes/ads";
import phoneProvisioningRoutes from "../routes/whatsapp-phone-provisioning";
import type { Env, Variables } from "../types";

type Assert<T extends true> = T;
type RequiresIdempotencyKey<T> = T extends { idempotencyKey: string }
	? true
	: false;

type _CampaignOptionsRequired = Assert<
	RequiresIdempotencyKey<Parameters<Ads["createCampaign"]>[1]>
>;
type _AdOptionsRequired = Assert<
	RequiresIdempotencyKey<Parameters<Ads["create"]>[1]>
>;
type _BoostOptionsRequired = Assert<
	RequiresIdempotencyKey<Parameters<Ads["boost"]>[1]>
>;
type _PhoneOptionsRequired = Assert<
	RequiresIdempotencyKey<Parameters<PhoneNumbers["purchase"]>[1]>
>;

type Operation = {
	parameters?: Array<{
		name?: string;
		in?: string;
		required?: boolean;
	}>;
};

function operationAt(document: unknown, path: string): Operation {
	return (
		(
			document as {
				paths: Record<string, { post?: Operation }>;
			}
		).paths[path]?.post ?? {}
	);
}

function expectRequiredIdempotencyKey(operation: Operation): void {
	expect(operation.parameters).toContainEqual(
		expect.objectContaining({
			name: "idempotency-key",
			in: "header",
			required: true,
		}),
	);
}

const openApiConfig = {
	openapi: "3.0.0" as const,
	info: { title: "Contract test", version: "1.0.0" },
};

function authorizedFinancialRouter(
	router: typeof adsRoutes,
	permission: "manage_spend" | "manage_billing",
) {
	const app = new Hono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", async (c, next) => {
		c.set("orgId", "org_contract");
		c.set("workspaceScope", "all");
		c.set("principalType", "service");
		c.set("permissions", ["read", "write", permission]);
		await next();
	});
	app.route("/", router);
	return app;
}

describe("paid-operation idempotency contracts", () => {
	it("declares the required header before every paid runtime operation", async () => {
		const adsDocument = adsRoutes.getOpenAPIDocument(openApiConfig);
		const phoneDocument =
			phoneProvisioningRoutes.getOpenAPIDocument(openApiConfig);
		const authorizedAds = authorizedFinancialRouter(adsRoutes, "manage_spend");
		const authorizedPhone = authorizedFinancialRouter(
			phoneProvisioningRoutes,
			"manage_billing",
		);

		expectRequiredIdempotencyKey(operationAt(adsDocument, "/campaigns"));
		expectRequiredIdempotencyKey(operationAt(adsDocument, "/"));
		expectRequiredIdempotencyKey(operationAt(adsDocument, "/boost"));
		expectRequiredIdempotencyKey(operationAt(phoneDocument, "/purchase"));

		const missingHeaderRequests = [
			authorizedAds.request("/campaigns", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					ad_account_id: "aa_contract",
					name: "Campaign",
					objective: "traffic",
				}),
			}),
			authorizedAds.request("/", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					ad_account_id: "aa_contract",
					name: "Ad",
				}),
			}),
			authorizedAds.request("/boost", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					ad_account_id: "aa_contract",
					post_target_id: "pt_contract",
					daily_budget_cents: 100,
					duration_days: 1,
				}),
			}),
			authorizedPhone.request("/purchase", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					account_id: "acc_contract",
					country: "US",
				}),
			}),
		];

		for (const response of await Promise.all(missingHeaderRequests)) {
			expect(response.status).toBe(400);
		}
	});

	it("forwards explicit SDK keys as Idempotency-Key headers", async () => {
		const requests: Request[] = [];
		const client = new Relay({
			apiKey: "rlay_test_contract",
			baseURL: "https://api.example.test",
			maxRetries: 0,
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push(new Request(input, init));
				return Response.json({});
			}) as typeof fetch,
		});

		await client.ads.createCampaign(
			{
				ad_account_id: "aa_contract",
				name: "Campaign",
				objective: "traffic",
			},
			{ idempotencyKey: "campaign-operation" },
		);
		await client.ads.create(
			{ ad_account_id: "aa_contract", name: "Ad" },
			{ idempotencyKey: "ad-operation" },
		);
		await client.ads.boost(
			{
				ad_account_id: "aa_contract",
				post_target_id: "pt_contract",
				daily_budget_cents: 100,
				duration_days: 1,
			},
			{ idempotencyKey: "boost-operation" },
		);
		await client.whatsapp.phoneNumbers.purchase(
			{ account_id: "acc_contract", country: "US" },
			{ idempotencyKey: "phone-operation" },
		);

		expect(
			requests.map((request) => ({
				path: new URL(request.url).pathname,
				key: request.headers.get("idempotency-key"),
			})),
		).toEqual([
			{ path: "/v1/ads/campaigns", key: "campaign-operation" },
			{ path: "/v1/ads", key: "ad-operation" },
			{ path: "/v1/ads/boost", key: "boost-operation" },
			{
				path: "/v1/whatsapp/phone-numbers/purchase",
				key: "phone-operation",
			},
		]);
	});

	it("runs live financial gates before a completed idempotency replay", async () => {
		const source = await Bun.file(new URL("../app.ts", import.meta.url)).text();
		const replay = source.indexOf(
			'timed("idempotency", idempotencyMiddleware)',
		);
		for (const gate of [
			"requireManageBillingMiddleware",
			"requireManageSpendMiddleware",
			"requireViewBillingMiddleware",
		]) {
			const lastGate = source.lastIndexOf(gate, replay);
			expect(lastGate).toBeGreaterThan(-1);
			expect(lastGate).toBeLessThan(replay);
		}
		expect(source.indexOf('"/v1/whatsapp/phone-numbers/*"')).toBeLessThan(
			replay,
		);
		const phoneGate = source.slice(
			source.indexOf('app.use("/v1/whatsapp/phone-numbers/*"'),
			replay,
		);
		expect(phoneGate).toContain('c.req.method === "POST"');
		expect(phoneGate).toContain("phone-numbers\\/purchase");
		expect(phoneGate).toContain('c.req.method === "DELETE"');
		expect(phoneGate).not.toContain('["POST", "PUT", "PATCH", "DELETE"]');
	});
});
