import { describe, expect, it } from "bun:test";
import type { Database } from "@relayapi/db";
import { Hono } from "hono";
import {
	aiEnabledMiddleware,
	proOnlyMiddleware,
} from "../middleware/feature-gate";
import type { Env, Variables } from "../types";
import { createMockEnv } from "./__mocks__/env";

type SubscriptionRow = {
	status: "trialing" | "active" | "past_due" | "cancelled";
	source: "stripe" | "complimentary";
	stripeSubscriptionId: string | null;
	trialEndsAt: Date | null;
	delinquentAt: Date | null;
	graceEndsAt: Date | null;
	currentPeriodStart: Date;
	currentPeriodEnd: Date | null;
	aiEnabled: boolean;
};

function entitlementDb(row: SubscriptionRow | null): {
	db: Database;
	reads: () => number;
} {
	let readCount = 0;
	const db = {
		select: () => {
			const query = {
				from: () => query,
				where: () => query,
				limit: async () => {
					readCount += 1;
					return row ? [row] : [];
				},
			};
			return query;
		},
	} as unknown as Database;
	return { db, reads: () => readCount };
}

function executionContext() {
	const promises: Promise<unknown>[] = [];
	return {
		promises,
		context: {
			waitUntil: (promise: Promise<unknown>) => promises.push(promise),
			passThroughOnException: () => undefined,
			props: undefined,
		} as unknown as ExecutionContext,
	};
}

function gatedApp(
	db: Database,
	input: { plan: "free" | "pro"; aiEnabled: boolean },
) {
	const app = new Hono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", async (c, next) => {
		c.set("orgId", "org_feature");
		c.set("keyHash", "hash_feature");
		c.set("plan", input.plan);
		c.set("aiEnabled", input.aiEnabled);
		c.set("db", db);
		await next();
	});
	app.get("/pro", proOnlyMiddleware, (c) => c.json({ ok: true }));
	app.get(
		"/pro-ai",
		proOnlyMiddleware,
		aiEnabledMiddleware,
		(c) => c.json({ ok: true }),
	);
	return app;
}

const activeSubscription: SubscriptionRow = {
	status: "active",
	source: "complimentary",
	stripeSubscriptionId: null,
	trialEndsAt: null,
	delinquentAt: null,
	graceEndsAt: null,
	currentPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
	currentPeriodEnd: new Date("2026-08-01T00:00:00.000Z"),
	aiEnabled: true,
};

describe("feature-gate PostgreSQL authority", () => {
	it("rejects a resurrected Pro cache after the hosted subscription is disabled", async () => {
		const fixture = entitlementDb({
			...activeSubscription,
			status: "cancelled",
			aiEnabled: false,
		});
		const { env, kv } = createMockEnv();
		await kv.put("apikey:hash_feature", "stale");
		const execution = executionContext();

		const response = await gatedApp(fixture.db, {
			plan: "pro",
			aiEnabled: true,
		}).fetch(
			new Request("http://localhost/pro"),
			env,
			execution.context,
		);
		await Promise.all(execution.promises);

		expect(response.status).toBe(403);
		expect(fixture.reads()).toBe(1);
		expect(await kv.get("apikey:hash_feature")).toBeNull();
	});

	it("accepts fresh hosted authority and reads it only once across Pro and AI gates", async () => {
		const fixture = entitlementDb(activeSubscription);
		const { env, kv } = createMockEnv();
		await kv.put("apikey:hash_feature", "stale");
		const execution = executionContext();

		const response = await gatedApp(fixture.db, {
			plan: "free",
			aiEnabled: false,
		}).fetch(
			new Request("http://localhost/pro-ai"),
			env,
			execution.context,
		);
		await Promise.all(execution.promises);

		expect(response.status).toBe(200);
		expect(fixture.reads()).toBe(1);
		expect(await kv.get("apikey:hash_feature")).toBeNull();
	});

	it("keeps self-host feature flags authoritative without a hosted subscription read", async () => {
		const fixture = entitlementDb(null);
		const { env } = createMockEnv();
		env.DEPLOYMENT_MODE = "self_hosted";
		const execution = executionContext();

		const response = await gatedApp(fixture.db, {
			plan: "pro",
			aiEnabled: true,
		}).fetch(
			new Request("http://localhost/pro-ai"),
			env,
			execution.context,
		);
		await Promise.all(execution.promises);

		expect(response.status).toBe(200);
		expect(fixture.reads()).toBe(0);
	});
});
