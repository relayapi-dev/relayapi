// apps/api/src/__tests__/usage-timeseries.test.ts
//
// Integration coverage for GET /v1/usage/timeseries — the daily API-call
// aggregation that powers the dashboard "API Calls" heatmap. Seeds a handful of
// api_request_logs rows across known UTC days and asserts the per-day bucketing
// and the publish (write) / listen (read) split.
//
// Relies on the local SSH tunnel (see README) and gracefully skips when the
// tunnel is down — matching the pattern used by automation-routes.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	apiRequestLogs,
	createDb,
	eq,
	generateId,
	organization,
} from "@relayapi/db";
import { Hono } from "hono";
import usageApp from "../routes/usage";
import type { Env, Variables } from "../types";

const CONN =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??
	"postgres://relayapi:z9scNsSByxEn8QC6Z6PDQLLSKLum3F@localhost:5433/relayapi?sslmode=disable";

const db = createDb(CONN);

let dbAvailable = false;
let orgId = "";

// Two distinct UTC days inside the default window: today and 3 days ago. Using
// noon UTC keeps each row firmly inside its calendar day regardless of the
// machine's local timezone.
const DAY_MS = 86_400_000;
const today = new Date();
const dayA = new Date(
	Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12),
);
const dayB = new Date(dayA.getTime() - 3 * DAY_MS);
const dayOutside = new Date(dayA.getTime() - 60 * DAY_MS);

function ymd(d: Date): string {
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function logRow(method: string, path: string, createdAt: Date) {
	return {
		organizationId: orgId,
		apiKeyId: "key_test",
		method,
		path,
		statusCode: 200,
		responseTimeMs: 5,
		billable: method !== "GET",
		createdAt,
	};
}

async function seedFixture() {
	orgId = generateId("org_");
	await db.insert(organization).values({
		id: orgId,
		name: "timeseries-test-org",
		slug: `ts-test-${orgId.slice(-8)}`,
	});
	await db.insert(apiRequestLogs).values([
		// dayA: 2 reads + 1 write
		logRow("GET", "/v1/posts", dayA),
		logRow("GET", "/v1/accounts", dayA),
		logRow("POST", "/v1/posts", dayA),
		// dayB: 1 write
		logRow("POST", "/v1/posts", dayB),
		// outside the 30-day window — must be excluded
		logRow("POST", "/v1/posts", dayOutside),
	]);
}

async function teardownFixture() {
	if (!orgId) return;
	await db.delete(apiRequestLogs).where(eq(apiRequestLogs.organizationId, orgId));
	await db.delete(organization).where(eq(organization.id, orgId));
}

function makeApp() {
	const app = new Hono<{ Bindings: Env; Variables: Variables }>();
	// Stand in for the auth + db-context middleware the real stack runs first.
	app.use("*", async (c, next) => {
		c.set("orgId", orgId);
		c.set("db", db);
		await next();
	});
	app.route("/v1/usage", usageApp);
	return app;
}

beforeAll(async () => {
	try {
		await seedFixture();
		dbAvailable = true;
	} catch (err) {
		console.warn(
			"[usage-timeseries.test] DB unavailable — integration tests will skip.",
			err instanceof Error ? err.message : err,
		);
	}
});

afterAll(async () => {
	if (dbAvailable) await teardownFixture();
});

describe("GET /v1/usage/timeseries", () => {
	it("buckets calls by UTC day and splits publish/listen", async () => {
		if (!dbAvailable) return;

		const app = makeApp();
		const res = await app.fetch(
			new Request("http://localhost/v1/usage/timeseries?days=30"),
		);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			range: { from: string; to: string };
			days: Array<{
				date: string;
				total: number;
				publish: number;
				listen: number;
			}>;
		};

		const byDate = new Map(body.days.map((d) => [d.date, d]));

		const a = byDate.get(ymd(dayA));
		expect(a).toBeDefined();
		expect(a?.total).toBe(3);
		expect(a?.publish).toBe(1);
		expect(a?.listen).toBe(2);

		const b = byDate.get(ymd(dayB));
		expect(b).toBeDefined();
		expect(b?.total).toBe(1);
		expect(b?.publish).toBe(1);
		expect(b?.listen).toBe(0);

		// The 60-day-old row is outside the 30-day window.
		expect(byDate.has(ymd(dayOutside))).toBe(false);
	});

	it("respects the days window", async () => {
		if (!dbAvailable) return;

		const app = makeApp();
		const res = await app.fetch(
			new Request("http://localhost/v1/usage/timeseries?days=1"),
		);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			days: Array<{ date: string }>;
		};
		const dates = new Set(body.days.map((d) => d.date));
		// Only today's bucket can appear in a 1-day window.
		expect(dates.has(ymd(dayB))).toBe(false);
	});
});
