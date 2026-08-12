import { beforeEach, describe, expect, it, mock } from "bun:test";

const committedByOrg = new Map<string, number>();
const apiLogBillable: boolean[] = [];
const reserveCalls: Array<{
	organizationId: string;
	units: number;
	quotaMode: "hard" | "metered" | "unlimited";
	idempotencyKey: string;
	billingPeriodId?: string | null;
	billingAuthorityState?: "ready" | "pending";
}> = [];
const finalizeCalls: Array<{
	status: number | null;
	units: number;
	commit: boolean;
	reason: string;
	committedUnits: number | null;
}> = [];
let reservationSequence = 0;
let reserveSelfHealed = false;
let finalizedReservationUnitsOverride: number | null = null;
let reservePendingFailures = 0;
let authorityResolutions: Array<Record<string, unknown>> = [];
let authorityRepairCalls = 0;
let authorityRepairResult: Record<string, unknown> = {
	state: "ready",
	plan: "pro",
	billingPeriodId: "bp_repaired",
	subscriptionStatus: "active",
};

class MockBillingAuthorityPendingError extends Error {}

mock.module("@relayapi/db", () => ({
	apiRequestLogs: {},
	createDb: () => ({
		insert: () => ({
			values: async (values: Record<string, unknown>) => {
				if (typeof values.billable === "boolean") {
					apiLogBillable.push(values.billable);
				}
			},
		}),
	}),
}));

mock.module("../services/usage-meter", () => ({
	BillingAuthorityPendingError: MockBillingAuthorityPendingError,
	armUsageReservationProviderBoundary: async () => new Date(),
	resolveSuccessfulMutationAuthority: async () =>
		authorityResolutions.shift() ?? {
			state: "pending",
			plan: "pro",
			billingSource: "stripe",
			subscriptionStatus: "active",
			reason: "missing_or_mismatched_billing_period",
		},
	reserveMutationUsage: async (
		_db: unknown,
		input: {
			organizationId: string;
			units: number;
			includedUnits: number | null;
			quotaMode: "hard" | "metered" | "unlimited";
			idempotencyKey: string;
			periodStart: Date;
			periodEnd: Date;
			billingPeriodId?: string | null;
			billingAuthorityState?: "ready" | "pending";
		},
	) => {
		reserveCalls.push(input);
		if (reservePendingFailures > 0) {
			reservePendingFailures -= 1;
			throw new MockBillingAuthorityPendingError();
		}
		const committedUnits = committedByOrg.get(input.organizationId) ?? 0;
		if (
			input.quotaMode === "hard" &&
			input.includedUnits !== null &&
			committedUnits + input.units > input.includedUnits
		) {
			return {
				ok: false as const,
				selfHealed: reserveSelfHealed,
				quotaMode: input.quotaMode,
				includedUnits: input.includedUnits,
				committedUnits,
				reservedUnits: 0,
			};
		}
		reservationSequence += 1;
		return {
			ok: true as const,
			selfHealed: reserveSelfHealed,
			reservation: {
				id: `ur_${reservationSequence}`,
				bucketId: "ub_test",
				organizationId: input.organizationId,
				units: input.units,
				state: "reserved" as const,
				quotaMode: input.quotaMode,
				includedUnits: input.includedUnits,
				committedUnits,
				reservedUnits: input.units,
				periodStart: input.periodStart,
				periodEnd: input.periodEnd,
			},
		};
	},
	reserveDailyToolUsage: async () => {
		throw new Error("Daily tool usage is outside usage-tracking test scope");
	},
	finalizeMutationUsage: async (
		_db: unknown,
		reservation: {
			organizationId: string;
			units: number;
			quotaMode: "hard" | "metered" | "unlimited";
			includedUnits: number | null;
		},
		disposition: {
			commit: boolean;
			reason: string;
			responseStatus: number | null;
			committedUnits?: number;
		},
	) => {
		const provisionalCommittedDelta =
			disposition.commit && disposition.reason === "settled"
				? (disposition.committedUnits ?? reservation.units)
				: 0;
		const committedDelta =
			finalizedReservationUnitsOverride ?? provisionalCommittedDelta;
		finalizeCalls.push({
			status: disposition.responseStatus,
			units: reservation.units,
			commit: disposition.commit,
			reason: disposition.reason,
			committedUnits: disposition.reason === "unknown" ? null : committedDelta,
		});
		const before = committedByOrg.get(reservation.organizationId) ?? 0;
		const committedUnits = before + committedDelta;
		committedByOrg.set(reservation.organizationId, committedUnits);
		return {
			quotaMode: reservation.quotaMode,
			includedUnits: reservation.includedUnits,
			committedUnits,
			reservationCommittedUnits: committedDelta,
			reservedUnits: disposition.reason === "unknown" ? reservation.units : 0,
		};
	},
	successfulMutationDisposition: (
		responseStatus: number,
		committedUnits = responseStatus < 400 ? 1 : 0,
	) =>
		responseStatus < 400
			? {
					commit: true as const,
					reason: "settled" as const,
					responseStatus,
					committedUnits,
				}
			: {
					commit: false as const,
					reason: "rejected" as const,
					responseStatus,
					committedUnits: 0 as const,
				},
}));

mock.module("../services/stripe-billing-authority", () => ({
	reconcileStripeBillingAuthority: async () => {
		authorityRepairCalls += 1;
		return authorityRepairResult;
	},
}));

let notificationCount = 0;
mock.module("../services/notification-manager", () => ({
	sendNotificationToOrg: async () => {
		notificationCount += 1;
	},
}));

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createDb } from "@relayapi/db";
import { Hono } from "hono";
import { bodyCacheMiddleware } from "../middleware/body-cache";
import { errorContractMiddleware } from "../middleware/error-contract";
import {
	multipartMutationInputPreflight,
	openApiMutationValidationHook,
} from "../middleware/mutation-validation";
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
		bulkCommittedUnits?: number;
		invalidBulkResponse?: boolean;
		ambiguousBulkEffect?: boolean;
		billingAuthorityState?: "ready" | "pending";
	} = {},
) {
	const {
		plan = "free",
		callsIncluded = 200,
		orgId = "org_test",
		bulkCommittedUnits,
		invalidBulkResponse = false,
		ambiguousBulkEffect = false,
		billingAuthorityState = "ready",
	} = options;
	const app = new Hono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", async (c, next) => {
		c.set("orgId", orgId);
		c.set("keyId", "key_test");
		c.set("keyHash", "hashed_test");
		c.set("plan", plan);
		c.set("quotaMode", plan === "pro" ? "metered" : "hard");
		c.set("callsIncluded", callsIncluded);
		c.set("billingSource", plan === "pro" ? "stripe" : "free");
		c.set("billable", plan === "pro");
		c.set("billingPeriodId", plan === "pro" ? "bp_test" : null);
		c.set("billingAuthorityState", billingAuthorityState);
		c.set("periodStart", null);
		c.set("periodEnd", null);
		c.set("db", createDb(c.env.HYPERDRIVE.connectionString));
		await next();
	});
	// Production always bounds and caches authenticated bodies before usage
	// middleware derives bulk units from parsedBody.
	app.use("*", bodyCacheMiddleware);
	app.use("*", usageTrackingMiddleware);
	app.get("/v1/posts", (c) => c.json({ ok: true }));
	app.options("/v1/posts", (c) => c.body(null, 204));
	app.post("/v1/posts", (c) => c.json({ ok: true }));
	app.post("/v1/authoritative-noop", (c) => {
		c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
			kind: "not_applied",
		});
		return c.json({ ok: true });
	});
	app.post("/v1/rejected", (c) => c.json({ error: { code: "INVALID" } }, 422));
	app.post("/v1/tags", (c) => c.json({ error: { code: "INVALID" } }, 422));
	app.post("/v1/content-templates", (c) => c.json({ ok: true }));
	app.patch("/v1/tags/tag_1", (c) => {
		c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
			kind: "committed",
			units: 1,
		});
		return c.json({ error: { code: "PROJECTION_FAILED" } }, 422);
	});
	app.post("/v1/throws", () => {
		throw new Error("boom");
	});
	app.post("/v1/rollback-then-throws", (c) => {
		c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
			kind: "not_applied",
		});
		throw new Error("rolled back");
	});
	app.post("/v1/commit-then-throws", (c) => {
		c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
			kind: "committed",
			units: 1,
		});
		throw new Error("response projection failed");
	});
	app.post("/v1/posts/bulk", async (c) => {
		const body = (await c.req.json()) as { posts: unknown[] };
		if (ambiguousBulkEffect) {
			c.get("mutationEffectTracker")?.begin("postgres.transaction").unknown();
		}
		if (invalidBulkResponse) return c.json({ ok: true });
		const succeeded = bulkCommittedUnits ?? body.posts.length;
		return c.json({ summary: { succeeded } });
	});
	app.post("/v1/posts/bulk-csv", async (c) => {
		const formData = await c.req.formData();
		const file = formData.get("file");
		const rows =
			file instanceof File
				? Math.max(0, (await file.text()).trim().split("\n").length - 1)
				: 0;
		return c.json({ summary: { posts_created: bulkCommittedUnits ?? rows } });
	});
	app.post("/v1/contacts/bulk", async (c) => {
		const body = (await c.req.json()) as { contacts: unknown[] };
		return c.json({ created: bulkCommittedUnits ?? body.contacts.length });
	});
	app.post("/v1/contacts/bulk-operations", async (c) => {
		const body = (await c.req.json()) as { contact_ids: unknown[] };
		return c.json({ affected: bulkCommittedUnits ?? body.contact_ids.length });
	});
	app.post("/v1/whatsapp/bulk-send", async (c) => {
		const body = (await c.req.json()) as { recipients: unknown[] };
		return c.json({
			recipient_count: bulkCommittedUnits ?? body.recipients.length,
		});
	});
	app.post("/v1/inbox/bulk", async (c) => {
		const body = (await c.req.json()) as { targets: unknown[] };
		return c.json({ processed: bulkCommittedUnits ?? body.targets.length });
	});
	app.post("/v1/billing/checkout", (c) =>
		c.json({ url: "https://example.test" }),
	);
	app.post("/v1/short-links/test", (c) =>
		c.json({ success: true, short_url: null, error: null }),
	);
	for (const path of [
		"/v1/auto-post-rules/test-feed",
		"/v1/tools/validate/post",
		"/v1/tools/validate/media",
		"/v1/tools/validate/post-length",
		"/v1/tools/instagram/hashtag-checker",
		"/v1/tools/linkedin/resolve-mention",
	]) {
		app.post(path, (c) => c.json({ ok: true }));
	}
	app.post("/v1/automations/:id/simulate", (c) => c.json({ ok: true }));
	app.onError((error, c) =>
		c.json({ error: { code: "INTERNAL_ERROR", message: error.message } }, 500),
	);
	return app;
}

const semanticValidationRoute = createRoute({
	method: "post",
	path: "/semantic",
	request: {
		body: {
			required: true,
			content: {
				"application/json": {
					schema: z.object({ name: z.string().min(1) }),
				},
			},
		},
	},
	responses: {
		200: {
			description: "Accepted",
			content: {
				"application/json": { schema: z.object({ ok: z.literal(true) }) },
			},
		},
	},
});

const formValidationRoute = createRoute({
	method: "post",
	path: "/form",
	middleware: multipartMutationInputPreflight,
	request: {
		body: {
			required: true,
			content: {
				"multipart/form-data": {
					schema: z.object({ file: z.any() }),
				},
			},
		},
	},
	responses: {
		200: {
			description: "Accepted",
			content: {
				"application/json": { schema: z.object({ ok: z.literal(true) }) },
			},
		},
	},
});

/** Mirrors the production root/child OpenAPI mounting and middleware order. */
function createOpenApiValidationTestApp() {
	const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>({
		defaultHook: openApiMutationValidationHook,
	});
	app.use("*", errorContractMiddleware);
	app.use("*", async (c, next) => {
		c.set("orgId", "org_test");
		c.set("keyId", "key_test");
		c.set("keyHash", "hashed_test");
		c.set("plan", "free");
		c.set("quotaMode", "hard");
		c.set("callsIncluded", 200);
		c.set("billingSource", "free");
		c.set("billable", false);
		c.set("billingPeriodId", null);
		c.set("billingAuthorityState", "ready");
		c.set("periodStart", null);
		c.set("periodEnd", null);
		c.set("db", createDb(c.env.HYPERDRIVE.connectionString));
		await next();
	});
	app.use("*", bodyCacheMiddleware);
	app.use("*", usageTrackingMiddleware);

	const child = new OpenAPIHono<{
		Bindings: Env;
		Variables: Variables;
	}>();
	child.openapi(semanticValidationRoute, (c) => c.json({ ok: true }, 200));
	child.openapi(formValidationRoute, (c) => c.json({ ok: true }, 200));
	app.route("/v1/validation", child);
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

	it("rejects a KV projection that would exceed Number.MAX_SAFE_INTEGER", async () => {
		await kv.put(
			`usage:org_1:${currentMonthKey()}`,
			String(Number.MAX_SAFE_INTEGER),
		);
		await expect(
			incrementUsage(kv as unknown as KVNamespace, "org_1", 1),
		).rejects.toThrow("Number.MAX_SAFE_INTEGER");
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
		reserveSelfHealed = false;
		finalizedReservationUnitsOverride = null;
		reservePendingFailures = 0;
		authorityResolutions = [];
		authorityRepairCalls = 0;
		authorityRepairResult = {
			state: "ready",
			plan: "pro",
			billingPeriodId: "bp_repaired",
			subscriptionStatus: "active",
		};
		apiLogBillable.length = 0;
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
		expect(finalizeCalls).toEqual([
			{
				status: 200,
				units: 1,
				commit: true,
				reason: "settled",
				committedUnits: 1,
			},
		]);
		expect(response.headers.get("X-Usage-Count")).toBe("1");
		expect(await getUsageCount(env.KV, "org_test")).toBe(1);
		expect(apiLogBillable).toEqual([true]);
	});

	it("repairs pending hosted Pro authority before reserving", async () => {
		authorityResolutions = [
			{
				state: "pending",
				plan: "pro",
				billingSource: "stripe",
				subscriptionStatus: "active",
				reason: "missing_or_mismatched_billing_period",
			},
			{
				state: "ready",
				authority: {
					quotaMode: "metered",
					includedUnits: 10_000,
					periodStart: new Date("2026-08-01T00:00:00.000Z"),
					periodEnd: new Date("2026-09-01T00:00:00.000Z"),
					billingPeriodId: "bp_repaired",
				},
			},
		];

		const response = await executeRequest(
			createTestApp({ plan: "pro", billingAuthorityState: "pending" }),
			new Request("http://localhost/v1/posts", { method: "POST" }),
			env,
		);

		expect(response.status).toBe(200);
		expect(authorityRepairCalls).toBe(1);
		expect(reserveCalls).toHaveLength(1);
		expect(reserveCalls[0]).toMatchObject({
			billingPeriodId: "bp_repaired",
			billingAuthorityState: "ready",
		});
	});

	it("returns a retryable 503 without reserving when authority repair is busy", async () => {
		authorityResolutions = [
			{
				state: "pending",
				plan: "pro",
				billingSource: "stripe",
				subscriptionStatus: "active",
				reason: "missing_or_mismatched_billing_period",
			},
		];
		authorityRepairResult = { state: "pending", reason: "fence_busy" };

		const response = await executeRequest(
			createTestApp({ plan: "pro", billingAuthorityState: "pending" }),
			new Request("http://localhost/v1/posts", { method: "POST" }),
			env,
		);

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("5");
		expect(await response.json()).toMatchObject({
			error: { code: "BILLING_AUTHORITY_PENDING" },
		});
		expect(reserveCalls).toHaveLength(0);
		expect(apiLogBillable).toEqual([false]);
	});

	it("fails closed when authority changes again after its one repair", async () => {
		authorityResolutions = [
			{
				state: "pending",
				plan: "pro",
				billingSource: "stripe",
				subscriptionStatus: "active",
				reason: "missing_or_mismatched_billing_period",
			},
			{
				state: "ready",
				authority: {
					quotaMode: "metered",
					includedUnits: 10_000,
					periodStart: new Date("2026-08-01T00:00:00.000Z"),
					periodEnd: new Date("2026-09-01T00:00:00.000Z"),
					billingPeriodId: "bp_repaired",
				},
			},
		];
		reservePendingFailures = 1;

		const response = await executeRequest(
			createTestApp({ plan: "pro", billingAuthorityState: "pending" }),
			new Request("http://localhost/v1/posts", { method: "POST" }),
			env,
		);

		expect(response.status).toBe(503);
		expect(authorityRepairCalls).toBe(1);
		expect(reserveCalls).toHaveLength(1);
	});

	it("repairs and retries once when a cached-ready authority is stale", async () => {
		reservePendingFailures = 1;
		authorityResolutions = [
			{
				state: "pending",
				plan: "pro",
				billingSource: "stripe",
				subscriptionStatus: "active",
				reason: "missing_or_mismatched_billing_period",
			},
			{
				state: "ready",
				authority: {
					quotaMode: "metered",
					includedUnits: 10_000,
					periodStart: new Date("2026-08-01T00:00:00.000Z"),
					periodEnd: new Date("2026-09-01T00:00:00.000Z"),
					billingPeriodId: "bp_repaired",
				},
			},
		];

		const response = await executeRequest(
			createTestApp({ plan: "pro" }),
			new Request("http://localhost/v1/posts", { method: "POST" }),
			env,
		);

		expect(response.status).toBe(200);
		expect(authorityRepairCalls).toBe(1);
		expect(reserveCalls).toHaveLength(2);
		expect(reserveCalls[1]).toMatchObject({
			billingPeriodId: "bp_repaired",
			billingAuthorityState: "ready",
		});
	});

	it("logs and warns from the authoritative reservation K on a K=0 durable replay", async () => {
		committedByOrg.set("org_test", 159);
		finalizedReservationUnitsOverride = 0;
		const response = await executeRequest(
			createTestApp({ plan: "pro", callsIncluded: 200 }),
			new Request("http://localhost/v1/posts", { method: "POST" }),
			env,
		);

		expect(response.status).toBe(200);
		expect(committedByOrg.get("org_test")).toBe(159);
		expect(apiLogBillable).toEqual([false]);
		expect(notificationCount).toBe(0);
	});

	it("settles an explicit successful no-op at K=0", async () => {
		const response = await executeRequest(
			createTestApp(),
			new Request("http://localhost/v1/authoritative-noop", {
				method: "POST",
			}),
			env,
		);

		expect(response.status).toBe(200);
		expect(finalizeCalls[0]).toEqual({
			status: 200,
			units: 1,
			commit: true,
			reason: "settled",
			committedUnits: 0,
		});
		expect(committedByOrg.get("org_test")).toBe(0);
	});

	it("settles a successful PostgreSQL-complete no-op at K=0", async () => {
		const response = await executeRequest(
			createTestApp(),
			new Request("http://localhost/v1/content-templates", {
				method: "POST",
			}),
			env,
		);

		expect(response.status).toBe(200);
		expect(finalizeCalls[0]).toMatchObject({
			commit: true,
			reason: "settled",
			committedUnits: 0,
		});
	});

	it("never blocks or bills the mutation that lets a free organization upgrade", async () => {
		committedByOrg.set("org_test", 200);
		const response = await executeRequest(
			createTestApp({ callsIncluded: 200 }),
			new Request("http://localhost/v1/billing/checkout", {
				method: "POST",
			}),
			env,
		);
		expect(response.status).toBe(200);
		expect(reserveCalls).toHaveLength(0);
		expect(finalizeCalls).toHaveLength(0);
		expect(committedByOrg.get("org_test")).toBe(200);
	});

	it("does not reserve or bill the read-only short-link credential probe", async () => {
		const response = await executeRequest(
			createTestApp({ callsIncluded: 0 }),
			new Request("http://localhost/v1/short-links/test", {
				method: "POST",
			}),
			env,
		);

		expect(response.status).toBe(200);
		expect(reserveCalls).toHaveLength(0);
		expect(finalizeCalls).toHaveLength(0);
		expect(committedByOrg.has("org_test")).toBe(false);
	});

	it("does not reserve or bill POST-shaped reads and simulations", async () => {
		const paths = [
			"/v1/auto-post-rules/test-feed",
			"/v1/tools/validate/post",
			"/v1/tools/validate/media",
			"/v1/tools/validate/post-length",
			"/v1/tools/instagram/hashtag-checker",
			"/v1/tools/linkedin/resolve-mention",
			"/v1/automations/auto_1/simulate",
		];

		for (const path of paths) {
			const response = await executeRequest(
				createTestApp({ callsIncluded: 0 }),
				new Request(`http://localhost${path}`, { method: "POST" }),
				env,
			);
			expect(response.status).toBe(200);
		}

		expect(reserveCalls).toHaveLength(0);
		expect(finalizeCalls).toHaveLength(0);
		expect(committedByOrg.has("org_test")).toBe(false);
	});

	it("does not reserve quota for an unmatched mutation path", async () => {
		const response = await executeRequest(
			createTestApp({ callsIncluded: 0 }),
			new Request("http://localhost/v1/typo-that-does-not-exist", {
				method: "POST",
			}),
			env,
		);

		expect(response.status).toBe(404);
		expect(reserveCalls).toHaveLength(0);
		expect(finalizeCalls).toHaveLength(0);
	});

	it("parks an unclassified 4xx response without effect evidence", async () => {
		const response = await executeRequest(
			createTestApp(),
			new Request("http://localhost/v1/rejected", { method: "POST" }),
			env,
		);
		expect(response.status).toBe(422);
		expect(committedByOrg.get("org_test")).toBe(0);
		expect(finalizeCalls).toEqual([
			{
				status: null,
				units: 1,
				commit: true,
				reason: "unknown",
				committedUnits: null,
			},
		]);
	});

	it("releases a reservation on mounted OpenAPI semantic validation failure", async () => {
		const response = await executeRequest(
			createOpenApiValidationTestApp(),
			new Request("http://localhost/v1/validation/semantic", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: 42 }),
			}),
			env,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "VALIDATION_ERROR" },
		});
		expect(reserveCalls).toHaveLength(1);
		expect(finalizeCalls).toEqual([
			{
				status: 400,
				units: 1,
				commit: false,
				reason: "rejected",
				committedUnits: 0,
			},
		]);
	});

	it("rejects malformed JSON before any usage reservation", async () => {
		const response = await executeRequest(
			createOpenApiValidationTestApp(),
			new Request("http://localhost/v1/validation/semantic", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: '{"name":',
			}),
			env,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "MALFORMED_JSON" },
		});
		expect(reserveCalls).toHaveLength(0);
		expect(finalizeCalls).toHaveLength(0);
	});

	it("releases malformed multipart input before its OpenAPI validator", async () => {
		const response = await executeRequest(
			createOpenApiValidationTestApp(),
			new Request("http://localhost/v1/validation/form", {
				method: "POST",
				headers: {
					"Content-Type": "multipart/form-data; boundary=missing-parts",
				},
				body: "not-a-valid-multipart-body",
			}),
			env,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "MALFORMED_FORM" },
		});
		expect(reserveCalls).toHaveLength(1);
		expect(finalizeCalls[0]).toMatchObject({
			status: 400,
			commit: false,
			reason: "rejected",
			committedUnits: 0,
		});
	});

	it("releases a well-formed multipart request missing its required file", async () => {
		const response = await executeRequest(
			createOpenApiValidationTestApp(),
			new Request("http://localhost/v1/validation/form", {
				method: "POST",
				body: new FormData(),
			}),
			env,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "VALIDATION_ERROR" },
		});
		expect(reserveCalls).toHaveLength(1);
		expect(finalizeCalls[0]).toMatchObject({
			status: 400,
			commit: false,
			reason: "rejected",
			committedUnits: 0,
		});
	});

	it("releases a classified Postgres-only route rejected before any effect", async () => {
		const response = await executeRequest(
			createTestApp(),
			new Request("http://localhost/v1/tags", { method: "POST" }),
			env,
		);
		expect(response.status).toBe(422);
		expect(committedByOrg.get("org_test")).toBe(0);
		expect(finalizeCalls).toEqual([
			{
				status: 422,
				units: 1,
				commit: false,
				reason: "rejected",
				committedUnits: 0,
			},
		]);
	});

	it("charges a classified route whose effect committed before a 4xx projection", async () => {
		const response = await executeRequest(
			createTestApp(),
			new Request("http://localhost/v1/tags/tag_1", { method: "PATCH" }),
			env,
		);
		expect(response.status).toBe(422);
		expect(committedByOrg.get("org_test")).toBe(1);
		expect(finalizeCalls).toEqual([
			{
				status: 422,
				units: 1,
				commit: true,
				reason: "settled",
				committedUnits: 1,
			},
		]);
	});

	it("parks a reservation when the handler outcome is ambiguous", async () => {
		const response = await executeRequest(
			createTestApp(),
			new Request("http://localhost/v1/throws", { method: "POST" }),
			env,
		);
		expect(response.status).toBe(500);
		expect(committedByOrg.get("org_test")).toBe(0);
		expect(finalizeCalls).toEqual([
			{
				status: null,
				units: 1,
				commit: true,
				reason: "unknown",
				committedUnits: null,
			},
		]);
	});

	it("releases an armed reservation after explicit rollback evidence", async () => {
		const response = await executeRequest(
			createTestApp(),
			new Request("http://localhost/v1/rollback-then-throws", {
				method: "POST",
			}),
			env,
		);
		expect(response.status).toBe(500);
		expect(finalizeCalls).toEqual([
			{
				status: 500,
				units: 1,
				commit: false,
				reason: "proven_not_applied",
				committedUnits: 0,
			},
		]);
	});

	it("charges a committed effect even when response projection becomes 5xx", async () => {
		const response = await executeRequest(
			createTestApp(),
			new Request("http://localhost/v1/commit-then-throws", {
				method: "POST",
			}),
			env,
		);
		expect(response.status).toBe(500);
		expect(finalizeCalls).toEqual([
			{
				status: 500,
				units: 1,
				commit: true,
				reason: "settled",
				committedUnits: 1,
			},
		]);
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

	it("delete-invalidates the current API-key cache after authority self-heal", async () => {
		await kv.put("apikey:hashed_test", JSON.stringify({ plan: "free" }));
		reserveSelfHealed = true;
		const response = await executeRequest(
			createTestApp(),
			new Request("http://localhost/v1/posts", { method: "POST" }),
			env,
		);

		expect(response.status).toBe(200);
		expect(await kv.get("apikey:hashed_test")).toBeNull();
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
		expect(reserveCalls[0]?.quotaMode).toBe("metered");
		expect(reserveCalls[0]?.billingPeriodId).toBe("bp_test");
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
	] as const)(
		"reserves one unit per item for %s",
		async (path, body, units) => {
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
		},
	);

	it("commits only the authoritative K from an N-item bulk reservation", async () => {
		const contacts = Array.from({ length: 1_000 }, () => ({}));
		const response = await executeRequest(
			createTestApp({
				plan: "pro",
				callsIncluded: 10_000,
				bulkCommittedUnits: 600,
			}),
			new Request("http://localhost/v1/contacts/bulk", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ contacts }),
			}),
			env,
		);

		expect(response.status).toBe(200);
		expect(reserveCalls[0]?.units).toBe(1_000);
		expect(finalizeCalls[0]).toEqual({
			status: 200,
			units: 1_000,
			commit: true,
			reason: "settled",
			committedUnits: 600,
		});
		expect(committedByOrg.get("org_test")).toBe(600);
	});

	it("bills only consent-filtered recipients accepted into a WhatsApp broadcast", async () => {
		const response = await executeRequest(
			createTestApp({ bulkCommittedUnits: 2 }),
			new Request("http://localhost/v1/whatsapp/bulk-send", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ recipients: [{}, {}, {}, {}] }),
			}),
			env,
		);

		expect(response.status).toBe(200);
		expect(reserveCalls[0]?.units).toBe(4);
		expect(finalizeCalls[0]?.committedUnits).toBe(2);
		expect(committedByOrg.get("org_test")).toBe(2);
	});

	it("parks a bulk outcome whose authoritative K is missing", async () => {
		const response = await executeRequest(
			createTestApp({ invalidBulkResponse: true }),
			new Request("http://localhost/v1/posts/bulk", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ posts: [{}, {}, {}] }),
			}),
			env,
		);

		expect(response.status).toBe(200);
		expect(finalizeCalls[0]).toEqual({
			status: null,
			units: 3,
			commit: true,
			reason: "unknown",
			committedUnits: null,
		});
		expect(committedByOrg.get("org_test")).toBe(0);
	});

	it("parks a 2xx bulk K when a lower-level effect remains ambiguous", async () => {
		const response = await executeRequest(
			createTestApp({ ambiguousBulkEffect: true }),
			new Request("http://localhost/v1/posts/bulk", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ posts: [{}, {}, {}] }),
			}),
			env,
		);

		expect(response.status).toBe(200);
		expect(finalizeCalls[0]).toEqual({
			status: null,
			units: 3,
			commit: true,
			reason: "unknown",
			committedUnits: null,
		});
		expect(committedByOrg.get("org_test")).toBe(0);
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

	it("does not reserve or bill a CSV dry run", async () => {
		const formData = new FormData();
		formData.set(
			"file",
			new File(["content,targets\nOne,twitter\nTwo,linkedin\n"], "posts.csv", {
				type: "text/csv",
			}),
		);
		const response = await executeRequest(
			createTestApp({ callsIncluded: 0 }),
			new Request("http://localhost/v1/posts/bulk-csv?dry_run=true", {
				method: "POST",
				body: formData,
			}),
			env,
		);

		expect(response.status).toBe(200);
		expect(reserveCalls).toHaveLength(0);
		expect(finalizeCalls).toHaveLength(0);
		expect(committedByOrg.has("org_test")).toBe(false);
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
			createTestApp({ plan: "pro", callsIncluded: 200 }),
			new Request("http://localhost/v1/posts", { method: "POST" }),
			env,
		);
		expect(response.status).toBe(200);
		expect(notificationCount).toBe(1);
		expect(await kv.get("usage-warning:org_test:80:ub_test", "text")).toBe("1");
	});
});
