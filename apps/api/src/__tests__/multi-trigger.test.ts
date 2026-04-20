/**
 * Integration tests for multi-trigger automation enrollment.
 *
 * These tests require an active SSH tunnel to the database (localhost:5433).
 * They use raw SQL queries via the `postgres` client (not Drizzle) to avoid the
 * mock.module("drizzle-orm", ...) override installed by billing-flows.test.ts,
 * which would break Drizzle when the full suite runs in the same process.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * TODO: The tests below are skipped because billing-flows.test.ts installs a
 * global mock.module("@relayapi/db", ...) that replaces createDb() with a stub
 * for the *entire* Bun process. When the full suite runs, matchAndEnroll() calls
 * createDb() and gets back the mock (which has no .select()/.query() methods),
 * causing every test here to fail with "db.select is not a function".
 *
 * Fix: Refactor billing-flows.test.ts to scope its @relayapi/db mock so it
 * doesn't bleed into other test files (e.g., use mock.restore() in afterAll, or
 * move billing-flows.test.ts to a separate worker process with --no-cache).
 *
 * These tests pass correctly when run in isolation:
 *   bun run --filter @relayapi/api test -- multi-trigger.test.ts
 * ──────────────────────────────────────────────────────────────────────────
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { matchAndEnroll } from "../services/automations/trigger-matcher";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Connection string — dev SSH tunnel (localhost:5433)
// ---------------------------------------------------------------------------

const DB_URL =
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??
	"postgres://relayapi:z9scNsSByxEn8QC6Z6PDQLLSKLum3F@localhost:5433/relayapi?sslmode=disable";

// An org that exists in the DB (created by Better Auth / seed scripts).
const SEED_ORG_ID = "ws_fd2c4bc19517eaa4fca0fc0e7ed759ab";

// Unique prefix so test rows are easy to identify and clean up on each run.
const RUN_ID = `mt_test_${Date.now()}`;

// ---------------------------------------------------------------------------
// Raw SQL client — not affected by mock.module("drizzle-orm", ...)
// ---------------------------------------------------------------------------

const sql = postgres(DB_URL, { prepare: false, max: 3 });

// ---------------------------------------------------------------------------
// Mock env — real HYPERDRIVE connection string, no-op queue
// ---------------------------------------------------------------------------

function makeMockEnv(): Env {
	return {
		HYPERDRIVE: { connectionString: DB_URL } as unknown as Hyperdrive,
		AUTOMATION_QUEUE: {
			send: async () => {},
		} as unknown as Queue,
		// Remaining fields are not used by matchAndEnroll:
		KV: {} as KVNamespace,
		MEDIA_BUCKET: {} as R2Bucket,
		PUBLISH_QUEUE: {} as Queue,
		EMAIL_QUEUE: {} as Queue,
		REFRESH_QUEUE: {} as Queue,
		INBOX_QUEUE: {} as Queue,
		TOOLS_QUEUE: {} as Queue,
		ADS_QUEUE: {} as Queue,
		SYNC_QUEUE: {} as Queue,
		REALTIME: {} as DurableObjectNamespace,
		FREE_RATE_LIMITER: {} as RateLimit,
		PRO_RATE_LIMITER: {} as RateLimit,
		STRIPE_SECRET_KEY: "",
		STRIPE_WEBHOOK_SECRET: "",
		RESEND_API_KEY: "",
		ENCRYPTION_KEY: "a".repeat(64),
		API_BASE_URL: "https://api.test.dev",
		FACEBOOK_WEBHOOK_VERIFY_TOKEN: "",
		TWITTER_CLIENT_ID: "",
		TWITTER_CLIENT_SECRET: "",
		FACEBOOK_APP_ID: "",
		FACEBOOK_APP_SECRET: "",
		INSTAGRAM_APP_ID: "",
		INSTAGRAM_APP_SECRET: "",
		INSTAGRAM_LOGIN_APP_ID: "",
		INSTAGRAM_LOGIN_APP_SECRET: "",
		LINKEDIN_CLIENT_ID: "",
		LINKEDIN_CLIENT_SECRET: "",
		TIKTOK_CLIENT_KEY: "",
		TIKTOK_CLIENT_SECRET: "",
		YOUTUBE_CLIENT_ID: "",
		YOUTUBE_CLIENT_SECRET: "",
		PINTEREST_APP_ID: "",
		PINTEREST_APP_SECRET: "",
		REDDIT_CLIENT_ID: "",
		REDDIT_CLIENT_SECRET: "",
		THREADS_APP_ID: "",
		THREADS_APP_SECRET: "",
		SNAPCHAT_CLIENT_ID: "",
		SNAPCHAT_CLIENT_SECRET: "",
		GOOGLE_CLIENT_ID: "",
		GOOGLE_CLIENT_SECRET: "",
		MASTODON_CLIENT_ID: "",
		MASTODON_CLIENT_SECRET: "",
	} as Env;
}

// ---------------------------------------------------------------------------
// Helpers — raw SQL to avoid drizzle-orm mock contamination
// ---------------------------------------------------------------------------

function makeAutoId(suffix: string) {
	return `${RUN_ID}_auto_${suffix}`;
}

function makeTrigId(suffix: string) {
	return `${RUN_ID}_trig_${suffix}`;
}

async function seedAutomation(autoId: string): Promise<void> {
	await sql`
		INSERT INTO automations
			(id, organization_id, name, channel, status, published_version, version,
			 exit_on_reply, allow_reentry, total_enrolled, total_completed, total_exited,
			 created_at, updated_at)
		VALUES
			(${autoId}, ${SEED_ORG_ID}, ${"Multi-Trigger Test " + autoId},
			 'instagram', 'active', 1, 1,
			 true, false, 0, 0, 0,
			 NOW(), NOW())
		ON CONFLICT DO NOTHING
	`;
}

async function seedTrigger(
	triggerId: string,
	automationId: string,
	type: string,
	config: Record<string, unknown> = {},
): Promise<void> {
	await sql`
		INSERT INTO automation_triggers
			(id, automation_id, type, config, filters, label, order_index, created_at, updated_at)
		VALUES
			(${triggerId}, ${automationId}, ${type}::automation_trigger_type,
			 ${JSON.stringify(config)}::jsonb, '{}'::jsonb,
			 ${"Trigger " + triggerId}, 0, NOW(), NOW())
		ON CONFLICT DO NOTHING
	`;
}

async function cleanupRunRows(autoIds: string[]): Promise<void> {
	if (autoIds.length === 0) return;
	// Delete in FK-safe order: enrollments → triggers → automations.
	await sql`DELETE FROM automation_enrollments WHERE automation_id = ANY(${autoIds})`;
	await sql`DELETE FROM automation_triggers WHERE automation_id = ANY(${autoIds})`;
	await sql`DELETE FROM automations WHERE id = ANY(${autoIds})`;
}

async function findEnrollment(
	autoId: string,
	enrolledIds: string[],
): Promise<{ trigger_id: string | null } | undefined> {
	if (enrolledIds.length === 0) return undefined;
	const rows = await sql<{ trigger_id: string | null }[]>`
		SELECT trigger_id
		FROM automation_enrollments
		WHERE automation_id = ${autoId}
		  AND id = ANY(${enrolledIds})
		LIMIT 1
	`;
	return rows[0];
}

async function findAnyEnrollment(
	autoId: string,
): Promise<{ id: string } | undefined> {
	const rows = await sql<{ id: string }[]>`
		SELECT id FROM automation_enrollments WHERE automation_id = ${autoId} LIMIT 1
	`;
	return rows[0];
}

async function deleteEnrollmentsForAuto(autoId: string): Promise<void> {
	await sql`DELETE FROM automation_enrollments WHERE automation_id = ${autoId}`;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skip("multi-trigger enrollment (integration)", () => {
	const env = makeMockEnv();

	// IDs used across tests — stable so cleanup works.
	const autoMulti = makeAutoId("multi");
	const autoFilter = makeAutoId("filter");
	const trigDm = makeTrigId("dm");
	const trigComment = makeTrigId("comment");
	const trigFilterDm = makeTrigId("filter_dm");
	const trigFilterComment = makeTrigId("filter_comment");
	const allAutoIds = [autoMulti, autoFilter];

	beforeAll(async () => {
		// Clean leftover rows from a previous crashed run (ignore errors).
		await cleanupRunRows(allAutoIds).catch(() => {});

		// Test 1: automation with two distinct triggers (instagram_dm + instagram_comment).
		await seedAutomation(autoMulti);
		await seedTrigger(trigDm, autoMulti, "instagram_dm");
		await seedTrigger(trigComment, autoMulti, "instagram_comment");

		// Test 2: automation with per-trigger keyword config.
		await seedAutomation(autoFilter);
		await seedTrigger(trigFilterDm, autoFilter, "instagram_dm", {
			keywords: ["urgent"],
		});
		await seedTrigger(trigFilterComment, autoFilter, "instagram_comment", {
			keywords: ["hello"],
		});
	});

	afterAll(async () => {
		await cleanupRunRows(allAutoIds);
		await sql.end();
	});

	// -------------------------------------------------------------------------
	// Test 1: enrolls when either of two trigger types matches
	// -------------------------------------------------------------------------

	it("enrolls when instagram_comment matches one of two triggers", async () => {
		const enrolledIds = await matchAndEnroll(env, {
			organization_id: SEED_ORG_ID,
			platform: "instagram",
			trigger_type: "instagram_comment",
			payload: { comment_text: "nice post" },
		});

		// At least one enrollment was created for autoMulti.
		expect(enrolledIds.length).toBeGreaterThan(0);

		// Verify enrollment.trigger_id points to the comment trigger, not the DM trigger.
		const enrollment = await findEnrollment(autoMulti, enrolledIds);
		expect(enrollment).toBeDefined();
		expect(enrollment?.trigger_id).toBe(trigComment);
	});

	it("enrolls when instagram_dm matches one of two triggers", async () => {
		// Delete existing enrollment so the re-entry guard doesn't block this test.
		await deleteEnrollmentsForAuto(autoMulti);

		const enrolledIds = await matchAndEnroll(env, {
			organization_id: SEED_ORG_ID,
			platform: "instagram",
			trigger_type: "instagram_dm",
			payload: { text: "hello" },
		});

		expect(enrolledIds.length).toBeGreaterThan(0);

		const enrollment = await findEnrollment(autoMulti, enrolledIds);
		expect(enrollment).toBeDefined();
		// enrollment.trigger_id must be the DM trigger, not the comment trigger.
		expect(enrollment?.trigger_id).toBe(trigDm);
	});

	// -------------------------------------------------------------------------
	// Test 2: per-trigger config filters correctly
	// -------------------------------------------------------------------------

	it("enrolls on instagram_comment with keyword 'hello' matching comment trigger config", async () => {
		const enrolledIds = await matchAndEnroll(env, {
			organization_id: SEED_ORG_ID,
			platform: "instagram",
			trigger_type: "instagram_comment",
			payload: { comment_text: "hello world" },
		});

		// autoFilter enrolls because trigFilterComment has keyword "hello".
		const enrollment = await findEnrollment(autoFilter, enrolledIds);
		expect(enrollment).toBeDefined();
		// The trigger that fired must be the comment trigger (not the DM trigger).
		expect(enrollment?.trigger_id).toBe(trigFilterComment);
	});

	it("does NOT enroll on instagram_comment with keyword 'urgent' (belongs to DM trigger)", async () => {
		// Remove existing enrollment so the re-entry guard doesn't confuse results.
		await deleteEnrollmentsForAuto(autoFilter);

		await matchAndEnroll(env, {
			organization_id: SEED_ORG_ID,
			platform: "instagram",
			trigger_type: "instagram_comment",
			payload: { comment_text: "urgent news" },
		});

		// trigFilterComment requires keyword "hello", not "urgent".
		// "urgent" belongs to trigFilterDm (instagram_dm) — which is NOT being fired here.
		// So autoFilter must NOT have enrolled.
		const enrollment = await findAnyEnrollment(autoFilter);
		expect(enrollment).toBeUndefined();
	});
});
