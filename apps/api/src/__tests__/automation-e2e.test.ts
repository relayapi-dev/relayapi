// apps/api/src/__tests__/automation-e2e.test.ts
//
// Plan 1 — Unit 9, Phase I2. End-to-end smoke test exercising the full
// automation lifecycle from template expansion through inbound-event matching,
// run execution, contact pause/resume, webhook trigger, and insights.
//
// Runs against a real Postgres through the SSH tunnel (localhost:5433). If
// the tunnel is down the whole suite skips gracefully — matching the pattern
// used by automation-runner.test.ts, automation-trigger-matcher.test.ts and
// automation-routes.test.ts.
//
// The test drives the runtime via direct service calls (matchAndEnroll,
// receiveAutomationWebhook, enrollContact) rather than going through the
// authenticated HTTP surface. The HTTP layer is covered by automation-routes
// + per-route tests elsewhere in the suite; this test's job is to validate
// that the pieces compose correctly end-to-end.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	automationBindings,
	automationContactControls,
	automationEntrypoints,
	automationRuns,
	automationStepRuns,
	automations,
	contacts,
	createDb,
	generateId,
	organization,
	socialAccounts,
	workspaces,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { aggregateInsights } from "../routes/_automation-insights";
import {
	buildGraphFromTemplate,
	type TemplateKind,
} from "../services/automations/templates";
import {
	computeSpecificity,
	matchAndEnroll,
	type InboundEvent,
} from "../services/automations/trigger-matcher";
import { receiveAutomationWebhook } from "../services/automations/webhook-receiver";

const CONN =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??
	"postgres://relayapi:z9scNsSByxEn8QC6Z6PDQLLSKLum3F@localhost:5433/relayapi?sslmode=disable";

const db = createDb(CONN);

let dbAvailable = false;
let orgId = "";
let workspaceId = "";
let socialAccountId = "";
let contactId = "";

async function seedFixture() {
	orgId = generateId("org_");
	await db.insert(organization).values({
		id: orgId,
		name: "e2e-test-org",
		slug: `e2e-test-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({ organizationId: orgId, name: "e2e-ws" })
		.returning();
	if (!ws) throw new Error("workspace insert failed");
	workspaceId = ws.id;

	const [sa] = await db
		.insert(socialAccounts)
		.values({
			organizationId: orgId,
			workspaceId,
			platform: "instagram",
			platformAccountId: `ig_${generateId("acc_")}`,
			displayName: "E2E IG Account",
		})
		.returning();
	if (!sa) throw new Error("social account insert failed");
	socialAccountId = sa.id;

	const [ct] = await db
		.insert(contacts)
		.values({
			organizationId: orgId,
			workspaceId,
			name: "Jane Commenter",
		})
		.returning();
	if (!ct) throw new Error("contact insert failed");
	contactId = ct.id;
}

async function teardownFixture() {
	if (!orgId) return;
	await db
		.delete(automationRuns)
		.where(eq(automationRuns.organizationId, orgId));
	await db
		.delete(automationContactControls)
		.where(eq(automationContactControls.organizationId, orgId));
	await db
		.delete(automationBindings)
		.where(eq(automationBindings.organizationId, orgId));
	await db.delete(automations).where(eq(automations.organizationId, orgId));
	await db.delete(contacts).where(eq(contacts.organizationId, orgId));
	await db
		.delete(socialAccounts)
		.where(eq(socialAccounts.organizationId, orgId));
	await db.delete(workspaces).where(eq(workspaces.organizationId, orgId));
	await db.delete(organization).where(eq(organization.id, orgId));
}

beforeAll(async () => {
	try {
		await seedFixture();
		dbAvailable = true;
	} catch (err) {
		console.warn(
			"[automation-e2e.test] DB unavailable — e2e suite will skip.",
			err instanceof Error ? err.message : err,
		);
	}
});

afterAll(async () => {
	if (dbAvailable) await teardownFixture();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createCommentToDmAutomation() {
	// Build a template-driven graph + entrypoint set, then persist both.
	const built = buildGraphFromTemplate({
		kind: "comment_to_dm" as TemplateKind,
		channel: "instagram",
		config: {
			post_ids: ["post_123"],
			public_reply: "Sent!",
			dm_message: {
				blocks: [
					{
						id: "blk_1",
						type: "text",
						text: "Hi {{contact.first_name}}!",
					},
				],
				quick_replies: [],
			},
			once_per_user: true,
			social_account_id: socialAccountId,
		},
	});

	const [auto] = await db
		.insert(automations)
		.values({
			organizationId: orgId,
			workspaceId,
			name: built.name,
			description: built.description ?? null,
			channel: "instagram",
			status: "active",
			graph: built.graph as never,
			createdFromTemplate: "comment_to_dm",
			templateConfig: built.graph as never,
		})
		.returning();
	if (!auto) throw new Error("automation insert failed");

	await db.insert(automationEntrypoints).values(
		built.entrypoints.map((ep) => ({
			automationId: auto.id,
			channel: "instagram" as const,
			kind: ep.kind,
			socialAccountId: ep.socialAccountId ?? socialAccountId,
			config: ep.config ?? {},
			filters: ep.filters ?? null,
			allowReentry: ep.allowReentry ?? false,
			reentryCooldownMin: ep.reentryCooldownMin ?? 60,
			priority: ep.priority ?? 100,
			specificity: computeSpecificity(
				ep.kind,
				ep.config ?? {},
				ep.filters ?? null,
				ep.socialAccountId ?? socialAccountId,
			),
		})),
	);

	return auto;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

describe("automation e2e", () => {
	it("comment_to_dm: template → active → matched enrollment → insights", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable (SSH tunnel likely down)");
			return;
		}

		// Step 1-3 — create via template + activate + verify graph persisted.
		const auto = await createCommentToDmAutomation();
		expect(auto.status).toBe("active");
		expect((auto.graph as { nodes: unknown[] }).nodes.length).toBeGreaterThan(0);

		// Confirm the entrypoint row is visible + asset-specificity is scored.
		const eps = await db
			.select()
			.from(automationEntrypoints)
			.where(eq(automationEntrypoints.automationId, auto.id));
		expect(eps.length).toBe(1);
		expect(eps[0]?.kind).toBe("comment_created");
		expect(eps[0]?.specificity).toBe(25); // asset-filtered tier

		// Step 4 — synthesize an inbound event, call the matcher directly.
		const event: InboundEvent = {
			kind: "comment_created",
			channel: "instagram",
			organizationId: orgId,
			socialAccountId,
			contactId,
			conversationId: null,
			postId: "post_123",
			text: "This looks great!",
		};
		const match = await matchAndEnroll(db, event, {});
		expect(match.matched).toBe(true);
		if (!match.matched) throw new Error("expected match");
		expect(match.automationId).toBe(auto.id);

		// Step 5 — scheduler sweep is a no-op here because there are no delay
		// nodes in the comment_to_dm graph. Confirm a run row exists and has
		// reached a terminal state (either completed when the mock runtime
		// short-circuits the send, or failed when the runner attempts a real
		// IG Graph API call without a live token — both prove the runner
		// exercised the graph end-to-end and wrote a step log).
		const runAfter = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, match.runId),
		});
		expect(runAfter).toBeTruthy();
		expect(["completed", "exited", "failed"]).toContain(runAfter!.status);

		// Step 6 — step_run entries should be appended for each executed node,
		// regardless of whether the send succeeded or failed.
		const steps = await db
			.select()
			.from(automationStepRuns)
			.where(eq(automationStepRuns.runId, match.runId));
		expect(steps.length).toBeGreaterThan(0);
		const nodeKinds = steps.map((s) => s.nodeKind);
		expect(nodeKinds).toContain("message");

		// Step 7 — insights should populate totals for the automation scope.
		const insights = await aggregateInsights(
			db,
			{ period: "24h" },
			{ orgId, automationId: auto.id },
		);
		expect(insights.totals.enrolled).toBeGreaterThanOrEqual(1);
		expect(insights.per_node.length).toBeGreaterThan(0);

		// Step 8 — pause this contact globally.
		const [pauseRow] = await db
			.insert(automationContactControls)
			.values({
				organizationId: orgId,
				contactId,
				automationId: null,
				pauseReason: "e2e_test_pause",
				pausedUntil: null,
			})
			.returning();
		expect(pauseRow).toBeTruthy();

		// Step 9 — a second enrollment attempt with the same (contact, event)
		// should now be rejected by the pause check.
		const secondMatch = await matchAndEnroll(db, event, {});
		expect(secondMatch.matched).toBe(false);
		if (secondMatch.matched) throw new Error("expected pause to block");
		expect(secondMatch.reason).toBe("paused");

		// Step 10 — resume: clear the pause row.
		await db
			.delete(automationContactControls)
			.where(
				and(
					eq(automationContactControls.organizationId, orgId),
					eq(automationContactControls.contactId, contactId),
				),
			);
		const afterResume = await db
			.select({ id: automationContactControls.id })
			.from(automationContactControls)
			.where(eq(automationContactControls.contactId, contactId));
		expect(afterResume.length).toBe(0);
	});

	it("webhook_inbound: valid HMAC enrolls, bad signature rejects", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		// Create a simple automation that just ends immediately — the graph is
		// irrelevant; we just need something the receiver can enroll into.
		const [auto] = await db
			.insert(automations)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "e2e-webhook-auto",
				channel: "instagram",
				status: "active",
				graph: {
					schema_version: 1,
					root_node_key: "stop",
					nodes: [
						{
							key: "stop",
							kind: "end",
							config: { reason: "completed" },
							ports: [{ key: "in", direction: "input" }],
						},
					],
					edges: [],
				} as never,
			})
			.returning();
		if (!auto) throw new Error("automation insert failed");

		// Create a webhook_inbound entrypoint with a known plaintext secret.
		const slug = `e2e-${generateId("whk_").slice(-10)}`;
		const secret = "testsecret0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
		await db.insert(automationEntrypoints).values({
			automationId: auto.id,
			channel: "instagram",
			kind: "webhook_inbound",
			config: {
				webhook_slug: slug,
				webhook_secret: secret,
				contact_lookup: {
					by: "contact_id",
					field_path: "$.contact_id",
				},
			} as never,
			specificity: computeSpecificity(
				"webhook_inbound",
				{ webhook_slug: slug },
				null,
				null,
			),
		});

		const body = JSON.stringify({ contact_id: contactId, data: { foo: "bar" } });

		// Compute a valid HMAC-SHA256 signature using Web Crypto.
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const sigBuf = await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(body),
		);
		const sigHex = Array.from(new Uint8Array(sigBuf))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");

		// Step 11-12 — valid signature enrolls.
		const ok = await receiveAutomationWebhook(
			db,
			{
				slug,
				rawBody: body,
				signatureHeader: `sha256=${sigHex}`,
			},
			{},
		);
		expect(ok.status).toBe("ok");
		if (ok.status !== "ok") throw new Error("expected ok");
		expect(ok.automationId).toBe(auto.id);

		// Step 13 — bad signature is rejected with status=bad_signature.
		const bad = await receiveAutomationWebhook(
			db,
			{
				slug,
				rawBody: body,
				signatureHeader: "sha256=deadbeef",
			},
			{},
		);
		expect(bad.status).toBe("bad_signature");

		// Also verify an unknown slug returns unknown_slug (no leakage).
		const unknown = await receiveAutomationWebhook(
			db,
			{
				slug: "does-not-exist",
				rawBody: body,
				signatureHeader: `sha256=${sigHex}`,
			},
			{},
		);
		expect(unknown.status).toBe("unknown_slug");
	});
});
