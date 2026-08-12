import { beforeEach, describe, expect, it, mock } from "bun:test";

const events: string[] = [];
let complimentaryPlanError: Error | null = null;

mock.module("../services/billing-periods", () => ({
	setComplimentaryPlan: async () => {
		events.push("db:set-complimentary-plan");
		if (complimentaryPlanError) throw complimentaryPlanError;
		return "sub_test";
	},
}));

mock.module("../lib/credential-mutation-authority", () => ({
	withCredentialMutationAuthority: async (
		context: { get(name: "db"): Variables["db"] },
		_options: unknown,
		operation: (
			db: Variables["db"],
			authority: { userId: string },
		) => Promise<unknown>,
	) => {
		const db = context.get("db");
		const run = async (tx: Variables["db"]) => ({
			ok: true as const,
			value: await operation(tx, { userId: "usr_admin" }),
		});
		return "transaction" in db && typeof db.transaction === "function"
			? db.transaction((tx) => run(tx as unknown as Variables["db"]))
			: run(db);
	},
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import admin from "../routes/admin";
import type { Env, Variables } from "../types";
import { createMockEnv, type MockKV } from "./__mocks__/env";

type Query = {
	from: (_table: unknown) => Query;
	innerJoin: (_table: unknown, _condition: unknown) => Query;
	where: (_condition: unknown) => Query;
	for: (_strength: string) => Query;
	limit: (_limit: number) => Promise<Record<string, unknown>[]>;
	then: (
		resolve: (rows: Record<string, unknown>[]) => void,
		reject?: (error: unknown) => void,
	) => void;
};

function selectOnlyDb(responses: Record<string, unknown>[][]): Variables["db"] {
	const select = () => {
		const rows = responses.shift() ?? [];
		const query = {} as Query;
		query.from = () => query;
		query.innerJoin = () => query;
		query.where = () => query;
		query.for = () => query;
		query.limit = async () => rows;
		// biome-ignore lint/suspicious/noThenProperty: intentional Drizzle thenable
		query.then = (resolve) => resolve(rows);
		return query;
	};
	return { select } as unknown as Variables["db"];
}

function updateDb(): Variables["db"] {
	const responses = [
		[{ role: "admin" }],
		[{ id: "org_target" }],
		[{ hash: "hash_one" }, { hash: "hash_two" }],
	];
	const select = () => {
		const rows = responses.shift() ?? [];
		const query = {} as Query;
		query.from = () => query;
		query.innerJoin = () => query;
		query.where = () => query;
		query.for = () => query;
		query.limit = async () => rows;
		// biome-ignore lint/suspicious/noThenProperty: intentional Drizzle thenable
		query.then = (resolve) => resolve(rows);
		return query;
	};
	const update = () => {
		const query = {
			set(_values: Record<string, unknown>) {
				return query;
			},
			where(_condition: unknown) {
				return query;
			},
			// biome-ignore lint/suspicious/noThenProperty: intentional Drizzle thenable
			then(resolve: (value: undefined) => void) {
				events.push("db:update");
				resolve(undefined);
			},
		};
		return query;
	};
	const insert = () => ({
		values: () => ({
			onConflictDoUpdate: async () => {
				events.push("db:upsert");
			},
		}),
	});
	const tx = { select, update, insert };
	return {
		select,
		update,
		insert,
		transaction: async <T>(
			callback: (transaction: typeof tx) => Promise<T>,
		): Promise<T> => {
			events.push("db:transaction:start");
			const result = await callback(tx);
			events.push("db:transaction:commit");
			return result;
		},
	} as unknown as Variables["db"];
}

function subscriptionUpdateDb(): Variables["db"] {
	return selectOnlyDb([
		[{ role: "admin" }],
		[
			{
				organizationId: "org_target",
				source: "complimentary",
			},
		],
		[{ hash: "hash_one" }, { hash: "hash_two" }],
	]);
}

function adminApp(db: Variables["db"]) {
	const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", async (c, next) => {
		c.set("principalType", "dashboard_user");
		c.set("principalUserId", "usr_admin");
		c.set("keyId", "key_admin");
		c.set("db", db);
		await next();
	});
	app.route("/v1/admin", admin);
	app.onError((error, c) =>
		c.json({ error: { code: "INTERNAL_ERROR", message: error.message } }, 500),
	);
	return app;
}

async function testEnvironment(): Promise<{ env: Env; kv: MockKV }> {
	const { env, kv } = createMockEnv();
	await kv.put("org-summary:org_target", "cached");
	await kv.put("apikey:hash_one", "cached");
	await kv.put("apikey:hash_two", "cached");
	const deleteFromKv = kv.delete.bind(kv);
	kv.delete = async (key: string) => {
		events.push(`kv:delete:${key}`);
		await deleteFromKv(key);
	};
	return { env, kv };
}

beforeEach(() => {
	events.length = 0;
	complimentaryPlanError = null;
});

describe("admin billing cache coherence", () => {
	it("invalidates every organization cache only after the plan mutation", async () => {
		const { env, kv } = await testEnvironment();
		const response = await adminApp(updateDb()).request(
			"/v1/admin/organizations/org_target",
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "Updated organization",
					plan: "pro",
					aiEnabled: true,
				}),
			},
			env,
		);

		expect(response.status).toBe(200);
		const planIndex = events.indexOf("db:set-complimentary-plan");
		for (const event of events.filter((entry) =>
			entry.startsWith("kv:delete:"),
		)) {
			expect(events.indexOf(event)).toBeGreaterThan(planIndex);
		}
		expect(await kv.get("org-summary:org_target")).toBeNull();
		expect(await kv.get("apikey:hash_one")).toBeNull();
		expect(await kv.get("apikey:hash_two")).toBeNull();
	});

	it("preserves cache repair for name, slug, and AI updates without a plan change", async () => {
		const { env } = await testEnvironment();
		const response = await adminApp(updateDb()).request(
			"/v1/admin/organizations/org_target",
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "Updated organization",
					slug: "updated-organization",
					aiEnabled: false,
				}),
			},
			env,
		);

		expect(response.status).toBe(200);
		expect(events).not.toContain("db:set-complimentary-plan");
		expect(events.indexOf("kv:delete:org-summary:org_target")).toBeGreaterThan(
			events.lastIndexOf("db:update"),
		);
	});

	it("rolls back the fenced database unit and skips KV when the plan mutation fails", async () => {
		complimentaryPlanError = new Error("simulated plan failure");
		const { env, kv } = await testEnvironment();
		const response = await adminApp(updateDb()).request(
			"/v1/admin/organizations/org_target",
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "Committed before failure",
					plan: "pro",
				}),
			},
			env,
		);

		expect(response.status).toBe(500);
		expect(await kv.get("org-summary:org_target")).toBe("cached");
		expect(await kv.get("apikey:hash_one")).toBe("cached");
		expect(await kv.get("apikey:hash_two")).toBe("cached");
		expect(events.some((event) => event.startsWith("kv:delete:"))).toBe(false);
	});

	it("attempts every subscription cache invalidation before surfacing a KV failure", async () => {
		const { env, kv } = await testEnvironment();
		const deleteFromKv = kv.delete.bind(kv);
		kv.delete = async (key: string) => {
			events.push(`subscription-kv:delete:${key}`);
			if (key === "apikey:hash_one") {
				throw new Error("simulated KV delete failure");
			}
			await deleteFromKv(key);
		};

		const response = await adminApp(subscriptionUpdateDb()).request(
			"/v1/admin/subscriptions/sub_test",
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "active" }),
			},
			env,
		);

		expect(response.status).toBe(500);
		expect(events).toContain("subscription-kv:delete:apikey:hash_one");
		expect(events).toContain("subscription-kv:delete:apikey:hash_two");
		expect(await kv.get("apikey:hash_one")).toBe("cached");
		expect(await kv.get("apikey:hash_two")).toBeNull();
	});
});
