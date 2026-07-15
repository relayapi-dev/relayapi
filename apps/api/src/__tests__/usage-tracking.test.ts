import { beforeEach, describe, expect, it, mock } from "bun:test";

const committedByOrg = new Map<string, number>();
const reserveCalls: Array<{
	organizationId: string;
	units: number;
	hardLimit: boolean;
	idempotencyKey: string;
}> = [];
const finalizeCalls: Array<{ status: number; units: number }> = [];
let reservationSequence = 0;

mock.module("@relayapi/db", () => ({
	apiRequestLogs: {},
	createDb: () => ({
		insert: () => ({
			values: async () => undefined,
		}),
	}),
}));

mock.module("../services/usage-meter", () => ({
	reserveMutationUsage: async (
		_db: unknown,
		input: {
			organizationId: string;
			units: number;
			includedUnits: number;
			hardLimit: boolean;
			idempotencyKey: string;
			periodStart: Date;
			periodEnd: Date;
		},
	) => {
		reserveCalls.push(input);
		const committedUnits = committedByOrg.get(input.organizationId) ?? 0;
		if (input.hardLimit && committedUnits + input.units > input.includedUnits) {
			return {
				ok: false as const,
				includedUnits: input.includedUnits,
				committedUnits,
				reservedUnits: 0,
			};
		}
		reservationSequence += 1;
		return {
			ok: true as const,
			reservation: {
				id: `ur_${reservationSequence}`,
				bucketId: "ub_test",
				organizationId: input.organizationId,
				units: input.units,
				state: "reserved" as const,
				includedUnits: input.includedUnits,
				committedUnits,
				reservedUnits: input.units,
				periodStart: input.periodStart,
				periodEnd: input.periodEnd,
			},
		};
	},
	finalizeMutationUsage: async (
		_db: unknown,
		reservation: {
			organizationId: string;
			units: number;
			includedUnits: number;
		},
		status: number,
	) => {
		finalizeCalls.push({ status, units: reservation.units });
		const before = committedByOrg.get(reservation.organizationId) ?? 0;
		const committedUnits = before + (status < 400 ? reservation.units : 0);
		committedByOrg.set(reservation.organizationId, committedUnits);
		return {
			includedUnits: reservation.includedUnits,
			committedUnits,
			reservedUnits: 0,
		};
	},
}));

let notificationCount = 0;
mock.module("../services/notification-manager", () => ({
	sendNotificationToOrg: async () => {
		notificationCount += 1;
	},
}));

import { createDb } from "@relayapi/db";
import { Hono } from "hono";
import {
	getUsageCount,
	incrementUsage,
	usageTrackingMiddleware,
} from "../middleware/usage-tracking";
import type { Env, Variables } from "../types";
import { createMockEnv, MockKV } from "./__mocks__/env";

function currentMonthKey(): string {
	const now = new Date();
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function createTestApp(
	options: {
		plan?: "free" | "pro";
		callsIncluded?: number;
		orgId?: string;
	} = {},
) {
	const { plan = "free", callsIncluded = 200, orgId = "org_test" } = options;
	const app = new Hono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", async (c, next) => {
		c.set("orgId", orgId);
		c.set("keyId", "key_test");
		c.set("plan", plan);
		c.set("callsIncluded", callsIncluded);
		c.set("periodStart", null);
		c.set("periodEnd", null);
		c.set("db", createDb(c.env.HYPERDRIVE.connectionString));
		await next();
	});
	app.use("*", usageTrackingMiddleware);
	app.get("/v1/posts", (c) => c.json({ ok: true }));
	app.options("/v1/posts", (c) => c.body(null, 204));
	app.post("/v1/posts", (c) => c.json({ ok: true }));
	app.post("/v1/rejected", (c) => c.json({ error: { code: "INVALID" } }, 422));
	app.post("/v1/throws", () => {
		throw new Error("boom");
	});
	app.post("/v1/posts/bulk", (c) => c.json({ ok: true }));
	app.post("/v1/posts/bulk-csv", (c) => c.json({ ok: true }));
	app.post("/v1/contacts/bulk", (c) => c.json({ ok: true }));
	app.post("/v1/contacts/bulk-operations", (c) => c.json({ ok: true }));
	app.post("/v1/whatsapp/bulk-send", (c) => c.json({ ok: true }));
	app.post("/v1/inbox/bulk", (c) => c.json({ ok: true }));
	app.onError((error, c) =>
		c.json({ error: { code: "INTERNAL_ERROR", message: error.message } }, 500),
	);
	return app;
}

function createExecutionContext() {
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

async function executeRequest(
	app: Hono<{ Bindings: Env; Variables: Variables }>,
	request: Request,
	env: Env,
) {
	const execution = createExecutionContext();
	const response = await app.fetch(request, env, execution.context);
	await Promise.all(execution.promises);
	return response;
}

describe("usage KV projection helpers", () => {
	let kv: MockKV;

	beforeEach(() => {
		kv = new MockKV();
	});

	it("projects a count without claiming KV is authoritative", async () => {
		await kv.put(`usage:org_1:${currentMonthKey()}`, "9");
		expect(await incrementUsage(kv as unknown as KVNamespace, "org_1", 3)).toBe(
			12,
		);
		expect(await getUsageCount(kv as unknown as KVNamespace, "org_1")).toBe(12);
	});

	it("returns zero when no projection exists", async () => {
		expect(await getUsageCount(kv as unknown as KVNamespace, "org_new")).toBe(
			0,
		);
	});
});

describe("usageTrackingMiddleware", () => {
	let env: Env;
	let kv: MockKV;

	beforeEach(() => {
		const mockEnv = createMockEnv();
		env = mockEnv.env;
		kv = mockEnv.kv;
		kv._clear();
		committedByOrg.clear();
		reserveCalls.length = 0;
		finalizeCalls.length = 0;
		reservationSequence = 0;
		notificationCount = 0;
	});

	it("commits one unit only after a successful mutation", async () => {
		const response = await executeRequest(
			createTestApp(),
			new Request("http://localhost/v1/posts", { method: "POST" }),
			env,
		);
		expect(response.status).toBe(200);
		expect(committedByOrg.get("org_test")).toBe(1);
		expect(finalizeCalls).toEqual([{ status: 200, units: 1 }]);
		expect(response.headers.get("X-Usage-Count")).toBe("1");
		expect(await getUsageCount(env.KV, "org_test")).toBe(1);
	});

	it("releases a reservation for a handled 4xx response", async () => {
		const response = await executeRequest(
			createTestApp(),
			new Request("http://localhost/v1/rejected", { method: "POST" }),
			env,
		);
		expect(response.status).toBe(422);
		expect(committedByOrg.get("org_test")).toBe(0);
		expect(finalizeCalls).toEqual([{ status: 422, units: 1 }]);
	});

	it("releases a reservation when the handler throws", async () => {
		const response = await executeRequest(
			createTestApp(),
			new Request("http://localhost/v1/throws", { method: "POST" }),
			env,
		);
		expect(response.status).toBe(500);
		expect(committedByOrg.get("org_test")).toBe(0);
		expect(finalizeCalls).toEqual([{ status: 500, units: 1 }]);
	});

	it("keeps GET and OPTIONS requests free", async () => {
		const app = createTestApp();
		const getResponse = await executeRequest(
			app,
			new Request("http://localhost/v1/posts"),
			env,
		);
		const optionsResponse = await executeRequest(
			app,
			new Request("http://localhost/v1/posts", { method: "OPTIONS" }),
			env,
		);
		expect(getResponse.status).toBe(200);
		expect(optionsResponse.status).toBe(204);
		expect(reserveCalls).toHaveLength(0);
		expect(committedByOrg.has("org_test")).toBe(false);
	});

	it("enforces a free-plan limit from PostgreSQL state, not KV", async () => {
		await kv.put(`usage:org_test:${currentMonthKey()}`, "0");
		committedByOrg.set("org_test", 2);
		const response = await executeRequest(
			createTestApp({ callsIncluded: 2 }),
			new Request("http://localhost/v1/posts", { method: "POST" }),
			env,
		);
		expect(response.status).toBe(403);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("FREE_LIMIT_REACHED");
		expect(finalizeCalls).toHaveLength(0);
	});

	it("ignores a stale high KV hint when PostgreSQL allows the mutation", async () => {
		await kv.put(`usage:org_test:${currentMonthKey()}`, "9999");
		const response = await executeRequest(
			createTestApp({ callsIncluded: 2 }),
			new Request("http://localhost/v1/posts", { method: "POST" }),
			env,
		);
		expect(response.status).toBe(200);
		expect(committedByOrg.get("org_test")).toBe(1);
	});

	it("does not hard-stop a pro plan above its included units", async () => {
		committedByOrg.set("org_test", 10);
		const response = await executeRequest(
			createTestApp({ plan: "pro", callsIncluded: 10 }),
			new Request("http://localhost/v1/posts", { method: "POST" }),
			env,
		);
		expect(response.status).toBe(200);
		expect(reserveCalls[0]?.hardLimit).toBe(false);
		expect(committedByOrg.get("org_test")).toBe(11);
	});

	it.each([
		["/v1/posts/bulk", { posts: [{}, {}, {}] }, 3],
		["/v1/contacts/bulk", { contacts: [{}, {}] }, 2],
		[
			"/v1/contacts/bulk-operations",
			{ contact_ids: ["c1", "c2", "c3", "c4"] },
			4,
		],
		["/v1/whatsapp/bulk-send", { recipients: [{}, {}, {}] }, 3],
		["/v1/inbox/bulk", { targets: ["a", "b"] }, 2],
	] as const)("reserves one unit per item for %s", async (path, body, units) => {
		const response = await executeRequest(
			createTestApp(),
			new Request(`http://localhost${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
			env,
		);
		expect(response.status).toBe(200);
		expect(reserveCalls[0]?.units).toBe(units);
		expect(committedByOrg.get("org_test")).toBe(units);
	});

	it("counts CSV data rows, excluding the header", async () => {
		const formData = new FormData();
		formData.set(
			"file",
			new File(["content,targets\nOne,twitter\nTwo,linkedin\n"], "posts.csv", {
				type: "text/csv",
			}),
		);
		const response = await executeRequest(
			createTestApp(),
			new Request("http://localhost/v1/posts/bulk-csv", {
				method: "POST",
				body: formData,
			}),
			env,
		);
		expect(response.status).toBe(200);
		expect(reserveCalls[0]?.units).toBe(2);
	});

	it("uses a fresh execution key for every mutation", async () => {
		const app = createTestApp();
		for (let index = 0; index < 2; index += 1) {
			await executeRequest(
				app,
				new Request("http://localhost/v1/posts", {
					method: "POST",
					headers: { "Idempotency-Key": "same-caller-key" },
				}),
				env,
			);
		}
		expect(reserveCalls[0]?.idempotencyKey).not.toBe(
			reserveCalls[1]?.idempotencyKey,
		);
	});

	it("emits a warning only when a committed threshold is crossed", async () => {
		committedByOrg.set("org_test", 159);
		const response = await executeRequest(
			createTestApp({ callsIncluded: 200 }),
			new Request("http://localhost/v1/posts", { method: "POST" }),
			env,
		);
		expect(response.status).toBe(200);
		expect(notificationCount).toBe(1);
		expect(
			await kv.get(`usage_warning:org_test:80:${currentMonthKey()}`, "text"),
		).toBe("1");
	});
});
