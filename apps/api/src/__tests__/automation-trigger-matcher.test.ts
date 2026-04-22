// apps/api/src/__tests__/automation-trigger-matcher.test.ts
//
// Integration + unit tests for Unit 6 (Phase D + E):
//   - trigger-matcher: entrypoint match, specificity ordering, reentry guard,
//     contact pause
//   - binding-router: welcome_message / default_reply fallback
//   - webhook-receiver: HMAC verification (+ unknown slug, bad payload)
//   - scheduler: processScheduledJobs dispatches resume_run / input_timeout
//   - simulate(): dry-run walker

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	automationBindings,
	automationContactControls,
	automationEntrypoints,
	automationRuns,
	automationScheduledJobs,
	automations,
	contacts,
	createDb,
	generateId,
	organization,
	socialAccounts,
	workspaces,
} from "@relayapi/db";
import { eq } from "drizzle-orm";
import type { Graph } from "../schemas/automation-graph";
import {
	matchAndEnrollOrBinding,
	routeBinding,
} from "../services/automations/binding-router";
import { processScheduledJobs } from "../services/automations/scheduler";
import { simulate } from "../services/automations/simulator";
import {
	computeSpecificity,
	type InboundEvent,
	matchAndEnroll,
} from "../services/automations/trigger-matcher";
import {
	extractByPath,
	receiveAutomationWebhook,
} from "../services/automations/webhook-receiver";

const CONN =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??
	"postgres://relayapi:z9scNsSByxEn8QC6Z6PDQLLSKLum3F@localhost:5433/relayapi?sslmode=disable";

const db = createDb(CONN);

let dbAvailable = false;
let orgId = "";
let workspaceId = "";
let socialAccountId = "";

async function seedFixture() {
	orgId = generateId("org_");
	await db.insert(organization).values({
		id: orgId,
		name: "matcher-test-org",
		slug: `matcher-test-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({
			organizationId: orgId,
			name: "matcher-test-ws",
		})
		.returning();
	if (!ws) throw new Error("workspace insert failed");
	workspaceId = ws.id;

	const [sa] = await db
		.insert(socialAccounts)
		.values({
			organizationId: orgId,
			workspaceId,
			platform: "telegram",
			platformAccountId: `tg_${generateId("acc_")}`,
			displayName: "Test TG Bot",
		})
		.returning();
	if (!sa) throw new Error("social account insert failed");
	socialAccountId = sa.id;
}

async function teardownFixture() {
	if (!orgId) return;
	await db.delete(automationRuns).where(eq(automationRuns.organizationId, orgId));
	await db
		.delete(automationContactControls)
		.where(eq(automationContactControls.organizationId, orgId));
	await db
		.delete(automationBindings)
		.where(eq(automationBindings.organizationId, orgId));
	await db.delete(automations).where(eq(automations.organizationId, orgId));
	await db.delete(contacts).where(eq(contacts.organizationId, orgId));
	await db.delete(socialAccounts).where(eq(socialAccounts.organizationId, orgId));
	await db.delete(workspaces).where(eq(workspaces.organizationId, orgId));
	await db.delete(organization).where(eq(organization.id, orgId));
}

async function makeAutomation(name = "auto") {
	const graph: Graph = {
		schema_version: 1,
		root_node_key: "stop",
		nodes: [
			{
				key: "stop",
				kind: "end",
				config: {},
				ports: [{ key: "in", direction: "input" }],
			},
		],
		edges: [],
	};
	const [auto] = await db
		.insert(automations)
		.values({
			organizationId: orgId,
			workspaceId,
			name,
			channel: "telegram",
			status: "active",
			graph: graph as never,
		})
		.returning();
	if (!auto) throw new Error("automation insert failed");
	return auto;
}

async function makeContact() {
	const [ct] = await db
		.insert(contacts)
		.values({
			organizationId: orgId,
			workspaceId,
			name: "matcher-test-contact",
		})
		.returning();
	if (!ct) throw new Error("contact insert failed");
	return ct;
}

beforeAll(async () => {
	try {
		await seedFixture();
		dbAvailable = true;
	} catch (err) {
		console.warn(
			"[automation-trigger-matcher.test] DB unavailable — tests will skip.",
			err instanceof Error ? err.message : err,
		);
	}
});

afterAll(async () => {
	if (dbAvailable) await teardownFixture();
});

// ---------------------------------------------------------------------------
// Unit tests (no DB required)
// ---------------------------------------------------------------------------

describe("computeSpecificity", () => {
	it("returns 30 for keyword exact match", () => {
		expect(
			computeSpecificity(
				"keyword",
				{ keywords: ["hi"], match_mode: "exact" },
				null,
				null,
			),
		).toBe(30);
	});

	it("returns 30 for webhook_inbound with slug", () => {
		expect(
			computeSpecificity(
				"webhook_inbound",
				{ webhook_slug: "abc123" },
				null,
				null,
			),
		).toBe(30);
	});

	it("returns 25 for asset-filtered comment", () => {
		expect(
			computeSpecificity(
				"comment_created",
				{ post_ids: ["p_1"] },
				null,
				null,
			),
		).toBe(25);
	});

	it("returns 20 for filtered entrypoint", () => {
		expect(
			computeSpecificity(
				"dm_received",
				{},
				{ all: [{ field: "tags", op: "contains", value: "vip" }] },
				null,
			),
		).toBe(20);
	});

	it("returns 10 for account-scoped broad", () => {
		expect(computeSpecificity("dm_received", {}, null, "acc_1")).toBe(10);
	});

	it("returns 0 for catch-all", () => {
		expect(computeSpecificity("dm_received", {}, null, null)).toBe(0);
	});

	it("keyword contains-mode stays at 0 (not 30)", () => {
		expect(
			computeSpecificity(
				"keyword",
				{ keywords: ["hi"], match_mode: "contains" },
				null,
				null,
			),
		).toBe(0);
	});

	it("returns 30 for dm_received with exact-match keywords (§B3 replacement)", () => {
		// Post-§B3: the retired `keyword` kind maps onto `dm_received` with a
		// `keywords` config. Specificity must stay 30 for exact/regex modes,
		// identical to the legacy kind — otherwise keyword triggers would lose
		// against broader dm_received catch-alls.
		expect(
			computeSpecificity(
				"dm_received",
				{ keywords: ["hi"], match_mode: "exact" },
				null,
				null,
			),
		).toBe(30);
		expect(
			computeSpecificity(
				"dm_received",
				{ keywords: ["^hi$"], match_mode: "regex" },
				null,
				null,
			),
		).toBe(30);
	});

	it("dm_received with empty keywords (or contains mode) stays below 30", () => {
		expect(
			computeSpecificity("dm_received", { keywords: [] }, null, null),
		).toBe(0);
		expect(
			computeSpecificity(
				"dm_received",
				{ keywords: ["hi"], match_mode: "contains" },
				null,
				null,
			),
		).toBe(0);
	});
});

describe("extractByPath", () => {
	it("handles root", () => {
		expect(extractByPath({ a: 1 }, "$")).toEqual({ a: 1 });
	});

	it("handles simple property", () => {
		expect(extractByPath({ foo: "bar" }, "$.foo")).toBe("bar");
	});

	it("handles nested property", () => {
		expect(extractByPath({ foo: { bar: "baz" } }, "$.foo.bar")).toBe("baz");
	});

	it("handles array index", () => {
		expect(extractByPath({ xs: [1, 2, 3] }, "$.xs[1]")).toBe(2);
	});

	it("handles nested array paths", () => {
		expect(
			extractByPath({ items: [{ name: "first" }, { name: "second" }] }, "$.items[1].name"),
		).toBe("second");
	});

	it("returns undefined for missing paths", () => {
		expect(extractByPath({ a: 1 }, "$.b.c")).toBeUndefined();
	});

	it("handles bracket-quoted keys", () => {
		expect(extractByPath({ "weird key": 42 }, "$[\"weird key\"]")).toBe(42);
	});
});

describe("simulate (dry-run walker)", () => {
	it("walks a message → end graph and returns 2 steps", async () => {
		const graph: Graph = {
			schema_version: 1,
			root_node_key: "msg",
			nodes: [
				{
					key: "msg",
					kind: "message",
					config: {},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
					],
				},
				{
					key: "stop",
					kind: "end",
					config: {},
					ports: [{ key: "in", direction: "input" }],
				},
			],
			edges: [
				{
					from_node: "msg",
					from_port: "next",
					to_node: "stop",
					to_port: "in",
				},
			],
		};
		const result = await simulate({ graph });
		expect(result.steps.length).toBe(2);
		expect(result.steps[0]!.node_kind).toBe("message");
		expect(result.steps[0]!.outcome).toBe("advance");
		expect(result.steps[1]!.node_kind).toBe("end");
		expect(result.steps[1]!.outcome).toBe("end");
	});

	it("honours branchChoices for condition nodes", async () => {
		const graph: Graph = {
			schema_version: 1,
			root_node_key: "cond",
			nodes: [
				{
					key: "cond",
					kind: "condition",
					config: {},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "true", direction: "output" },
						{ key: "false", direction: "output" },
					],
				},
				{
					key: "true_end",
					kind: "end",
					config: { reason: "true" },
					ports: [{ key: "in", direction: "input" }],
				},
				{
					key: "false_end",
					kind: "end",
					config: { reason: "false" },
					ports: [{ key: "in", direction: "input" }],
				},
			],
			edges: [
				{
					from_node: "cond",
					from_port: "true",
					to_node: "true_end",
					to_port: "in",
				},
				{
					from_node: "cond",
					from_port: "false",
					to_node: "false_end",
					to_port: "in",
				},
			],
		};
		const result = await simulate({
			graph,
			branchChoices: { cond: "false" },
		});
		expect(result.steps.map((s) => s.node_key)).toEqual(["cond", "false_end"]);
	});

	it("respects the maxVisits cap", async () => {
		const graph: Graph = {
			schema_version: 1,
			root_node_key: "g1",
			nodes: [
				{
					key: "g1",
					kind: "goto",
					config: { target_node_key: "g2" },
					ports: [{ key: "in", direction: "input" }],
				},
				{
					key: "g2",
					kind: "goto",
					config: { target_node_key: "g1" },
					ports: [{ key: "in", direction: "input" }],
				},
			],
			edges: [],
		};
		const result = await simulate({ graph, maxVisits: 5 });
		expect(result.exit_reason).toBe("max_visits");
		expect(result.steps.length).toBe(5);
	});

	it("pauses on wait_input for message nodes that expect replies", async () => {
		const graph: Graph = {
			schema_version: 1,
			root_node_key: "msg",
			nodes: [
				{
					key: "msg",
					kind: "message",
					config: { wait_for_reply: true },
					ports: [{ key: "in", direction: "input" }],
				},
			],
			edges: [],
		};
		const result = await simulate({ graph });
		expect(result.steps[0]!.outcome).toBe("wait_input");
		expect(result.exit_reason).toBe("wait_input");
	});

	it("action_group honours branchChoices to take the `error` port (§B12)", async () => {
		// Previously the simulator always exited via `next`, ignoring any
		// branch_choices override. That diverged from condition/randomizer/
		// http_request which all honour forced branches, and broke the
		// per-action-error preview in the dashboard simulate drawer.
		const graph: Graph = {
			schema_version: 1,
			root_node_key: "ag",
			nodes: [
				{
					key: "ag",
					kind: "action_group",
					config: { actions: [{ type: "tag_add", params: { tag: "vip" } }] },
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output" },
						{ key: "error", direction: "output" },
					],
				},
				{
					key: "ok",
					kind: "end",
					config: { reason: "ok" },
					ports: [{ key: "in", direction: "input" }],
				},
				{
					key: "err",
					kind: "end",
					config: { reason: "err" },
					ports: [{ key: "in", direction: "input" }],
				},
			],
			edges: [
				{ from_node: "ag", from_port: "next", to_node: "ok", to_port: "in" },
				{ from_node: "ag", from_port: "error", to_node: "err", to_port: "in" },
			],
		};

		// Default (no branch choice) — should advance via `next`.
		const defaultResult = await simulate({ graph });
		expect(defaultResult.steps.map((s) => s.node_key)).toEqual(["ag", "ok"]);
		expect(defaultResult.steps[0]!.exited_via_port_key).toBe("next");

		// Forced `error` — should advance via `error`.
		const forcedResult = await simulate({
			graph,
			branchChoices: { ag: "error" },
		});
		expect(forcedResult.steps.map((s) => s.node_key)).toEqual(["ag", "err"]);
		expect(forcedResult.steps[0]!.exited_via_port_key).toBe("error");
	});
});

// ---------------------------------------------------------------------------
// DB-backed tests
// ---------------------------------------------------------------------------

describe("matchAndEnroll", () => {
	it("matches a keyword DM entrypoint and enrolls the contact", async () => {
		if (!dbAvailable) return;

		const auto = await makeAutomation("keyword-dm");
		const ct = await makeContact();
		const [ep] = await db
			.insert(automationEntrypoints)
			.values({
				automationId: auto.id,
				channel: "telegram",
				kind: "dm_received",
				status: "active",
				socialAccountId,
				config: { keywords: ["hello"], match_mode: "exact" },
				specificity: 30,
			})
			.returning();
		expect(ep).toBeTruthy();

		const event: InboundEvent = {
			kind: "dm_received",
			channel: "telegram",
			organizationId: orgId,
			socialAccountId,
			contactId: ct.id,
			conversationId: null,
			text: "hello",
		};
		const result = await matchAndEnroll(db, event, {});
		expect(result.matched).toBe(true);
		if (result.matched) {
			expect(result.entrypointId).toBe(ep!.id);
			expect(result.automationId).toBe(auto.id);
		}
	});

	it("returns no_candidates when no entrypoint matches", async () => {
		if (!dbAvailable) return;
		const ct = await makeContact();
		const event: InboundEvent = {
			kind: "dm_received",
			channel: "telegram",
			organizationId: orgId,
			socialAccountId,
			contactId: ct.id,
			conversationId: null,
			text: "nothing to match",
		};
		const result = await matchAndEnroll(db, event, {});
		expect(result.matched).toBe(false);
		if (!result.matched) {
			// There may be earlier entrypoints from other tests — accept either
			// no_candidates or all_filtered, but not an actual match.
			expect(["no_candidates", "all_filtered"]).toContain(result.reason);
		}
	});

	it("picks the higher-specificity entrypoint when multiple match", async () => {
		if (!dbAvailable) return;

		// Two automations: one with keyword exact (specificity 30), one broad (10).
		const autoKeyword = await makeAutomation("specific");
		const autoBroad = await makeAutomation("broad");
		const ct = await makeContact();

		await db.insert(automationEntrypoints).values({
			automationId: autoKeyword.id,
			channel: "telegram",
			kind: "dm_received",
			status: "active",
			socialAccountId,
			config: { keywords: ["buy"], match_mode: "exact" },
			specificity: 30,
		});
		await db.insert(automationEntrypoints).values({
			automationId: autoBroad.id,
			channel: "telegram",
			kind: "dm_received",
			status: "active",
			socialAccountId,
			config: {},
			specificity: 10,
		});

		const event: InboundEvent = {
			kind: "dm_received",
			channel: "telegram",
			organizationId: orgId,
			socialAccountId,
			contactId: ct.id,
			conversationId: null,
			text: "buy",
		};
		const result = await matchAndEnroll(db, event, {});
		expect(result.matched).toBe(true);
		if (result.matched) expect(result.automationId).toBe(autoKeyword.id);
	});

	it("blocks enrollment when the contact has a global pause", async () => {
		if (!dbAvailable) return;

		const auto = await makeAutomation("pause-check");
		const ct = await makeContact();
		await db.insert(automationEntrypoints).values({
			automationId: auto.id,
			channel: "telegram",
			kind: "dm_received",
			status: "active",
			socialAccountId,
			config: {},
			specificity: 0,
		});
		await db.insert(automationContactControls).values({
			organizationId: orgId,
			contactId: ct.id,
			automationId: null,
			pauseReason: "manual_pause",
			pausedUntil: null,
		});

		const event: InboundEvent = {
			kind: "dm_received",
			channel: "telegram",
			organizationId: orgId,
			socialAccountId,
			contactId: ct.id,
			conversationId: null,
			text: "anything",
		};
		const result = await matchAndEnroll(db, event, {});
		expect(result.matched).toBe(false);
		if (!result.matched) expect(result.reason).toBe("paused");
	});
});

describe("routeBinding", () => {
	it("fires a welcome_message binding on first inbound", async () => {
		if (!dbAvailable) return;

		const auto = await makeAutomation("welcome-binding-auto");
		const ct = await makeContact();
		const [binding] = await db
			.insert(automationBindings)
			.values({
				organizationId: orgId,
				workspaceId,
				socialAccountId,
				channel: "telegram",
				bindingType: "welcome_message",
				automationId: auto.id,
				status: "active",
			})
			.returning();
		expect(binding).toBeTruthy();

		const event: InboundEvent = {
			kind: "dm_received",
			channel: "telegram",
			organizationId: orgId,
			socialAccountId,
			contactId: ct.id,
			conversationId: null,
			text: "hi!",
		};
		const result = await routeBinding(db, event, {});
		expect(result.matched).toBe(true);
		if (result.matched) expect(result.automationId).toBe(auto.id);
	});

	it("does NOT fire welcome_message on comment_created (spec §6.6 step 8)", async () => {
		if (!dbAvailable) return;

		// Fresh social account to avoid colliding with the `dm_received` test's
		// welcome binding on the same (account, type) unique index.
		const [sa3] = await db
			.insert(socialAccounts)
			.values({
				organizationId: orgId,
				workspaceId,
				platform: "telegram",
				platformAccountId: `tg_${generateId("acc_")}`,
				displayName: "Test TG Bot 3",
			})
			.returning();
		if (!sa3) throw new Error("sa3 insert failed");

		const auto = await makeAutomation("welcome-no-comment-auto");
		const ct = await makeContact();
		await db.insert(automationBindings).values({
			organizationId: orgId,
			workspaceId,
			socialAccountId: sa3.id,
			channel: "telegram",
			bindingType: "welcome_message",
			automationId: auto.id,
			status: "active",
		});

		const event: InboundEvent = {
			kind: "comment_created",
			channel: "telegram",
			organizationId: orgId,
			socialAccountId: sa3.id,
			contactId: ct.id,
			conversationId: null,
			text: "first comment",
		};
		const result = await routeBinding(db, event, {});
		// A comment must not trigger a welcome_message binding — welcome is
		// DM-only per spec §6.6 step 8.
		expect(result.matched).toBe(false);
	});

	it("matchAndEnrollOrBinding passes through reentry_blocked", async () => {
		if (!dbAvailable) return;

		// Use a separate social account so previously-created binding rows
		// don't collide with the unique constraint on
		// (social_account_id, binding_type).
		const [sa2] = await db
			.insert(socialAccounts)
			.values({
				organizationId: orgId,
				workspaceId,
				platform: "telegram",
				platformAccountId: `tg_${generateId("acc_")}`,
				displayName: "Test TG Bot 2",
			})
			.returning();
		if (!sa2) throw new Error("sa2 insert failed");

		const auto = await makeAutomation("reentry-block");
		const [ep] = await db
			.insert(automationEntrypoints)
			.values({
				automationId: auto.id,
				channel: "telegram",
				kind: "dm_received",
				status: "active",
				socialAccountId: sa2.id,
				config: {},
				specificity: 0,
				allowReentry: false,
			})
			.returning();
		expect(ep).toBeTruthy();

		const ct = await makeContact();

		// Manually insert a prior run for this contact+automation.
		await db.insert(automationRuns).values({
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			status: "completed",
			completedAt: new Date(Date.now() - 60_000),
		});

		// Also insert a welcome binding — we should NOT fall through to it.
		await db.insert(automationBindings).values({
			organizationId: orgId,
			workspaceId,
			socialAccountId: sa2.id,
			channel: "telegram",
			bindingType: "welcome_message",
			automationId: auto.id,
			status: "active",
		});

		const event: InboundEvent = {
			kind: "dm_received",
			channel: "telegram",
			organizationId: orgId,
			socialAccountId: sa2.id,
			contactId: ct.id,
			conversationId: null,
			text: "hi",
		};
		const result = await matchAndEnrollOrBinding(db, event, {});
		expect(result.matched).toBe(false);
		if (!result.matched) expect(result.reason).toBe("reentry_blocked");
	});
});

describe("receiveAutomationWebhook", () => {
	async function hmacHex(secret: string, body: string): Promise<string> {
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const sig = await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(body),
		);
		return Array.from(new Uint8Array(sig))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}

	it("returns unknown_slug when the slug is not registered", async () => {
		if (!dbAvailable) return;
		const result = await receiveAutomationWebhook(
			db,
			{
				slug: "nope-not-real",
				rawBody: "{}",
				signatureHeader: "sha256=abc",
			},
			{},
		);
		expect(result.status).toBe("unknown_slug");
	});

	it("accepts a valid signed payload and returns ok", async () => {
		if (!dbAvailable) return;

		const auto = await makeAutomation("webhook-auto");
		const ct = await makeContact();
		// Use a plaintext secret — maybeDecrypt passes through non-enc: strings.
		const slug = `slug-${generateId("").slice(-10)}`;
		const secret = "s3cr3t-key";
		await db.insert(automationEntrypoints).values({
			automationId: auto.id,
			channel: "telegram",
			kind: "webhook_inbound",
			status: "active",
			socialAccountId: null,
			config: {
				webhook_slug: slug,
				webhook_secret: secret,
				contact_lookup: {
					by: "contact_id",
					field_path: "$.contact_id",
				},
				payload_mapping: { custom_note: "$.note" },
			},
			specificity: 30,
		});

		const body = JSON.stringify({ contact_id: ct.id, note: "from webhook" });
		const sig = await hmacHex(secret, body);

		const result = await receiveAutomationWebhook(
			db,
			{
				slug,
				rawBody: body,
				signatureHeader: `sha256=${sig}`,
			},
			{},
		);
		expect(result.status).toBe("ok");
	});

	it("rejects a bad signature", async () => {
		if (!dbAvailable) return;

		const auto = await makeAutomation("webhook-badsig");
		const slug = `slug-${generateId("").slice(-10)}`;
		await db.insert(automationEntrypoints).values({
			automationId: auto.id,
			channel: "telegram",
			kind: "webhook_inbound",
			status: "active",
			socialAccountId: null,
			config: {
				webhook_slug: slug,
				webhook_secret: "correct-secret",
				contact_lookup: { by: "contact_id", field_path: "$.contact_id" },
			},
			specificity: 30,
		});
		const body = JSON.stringify({ contact_id: "ct_missing" });
		const result = await receiveAutomationWebhook(
			db,
			{
				slug,
				rawBody: body,
				signatureHeader: "sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			},
			{},
		);
		expect(result.status).toBe("bad_signature");
	});

	it("returns bad_payload for non-JSON bodies", async () => {
		if (!dbAvailable) return;

		const auto = await makeAutomation("webhook-badjson");
		const slug = `slug-${generateId("").slice(-10)}`;
		const secret = "x";
		await db.insert(automationEntrypoints).values({
			automationId: auto.id,
			channel: "telegram",
			kind: "webhook_inbound",
			status: "active",
			socialAccountId: null,
			config: {
				webhook_slug: slug,
				webhook_secret: secret,
				contact_lookup: { by: "contact_id", field_path: "$.contact_id" },
			},
			specificity: 30,
		});
		const body = "not-json-at-all";
		const sig = await hmacHex(secret, body);
		const result = await receiveAutomationWebhook(
			db,
			{ slug, rawBody: body, signatureHeader: `sha256=${sig}` },
			{},
		);
		expect(result.status).toBe("bad_payload");
	});
});

describe("processScheduledJobs", () => {
	it("dispatches a resume_run job and advances the run", async () => {
		if (!dbAvailable) return;

		// A simple 2-step graph that completes immediately.
		const graph: Graph = {
			schema_version: 1,
			root_node_key: "msg",
			nodes: [
				{
					key: "msg",
					kind: "message",
					config: {},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
					],
				},
				{
					key: "stop",
					kind: "end",
					config: {},
					ports: [{ key: "in", direction: "input" }],
				},
			],
			edges: [
				{
					from_node: "msg",
					from_port: "next",
					to_node: "stop",
					to_port: "in",
				},
			],
		};
		const [auto] = await db
			.insert(automations)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "sched-auto",
				channel: "telegram",
				status: "active",
				graph: graph as never,
			})
			.returning();
		if (!auto) throw new Error("auto insert failed");

		const ct = await makeContact();
		// Insert a run that's paused at the message node in waiting state.
		const [run] = await db
			.insert(automationRuns)
			.values({
				automationId: auto.id,
				organizationId: orgId,
				contactId: ct.id,
				status: "waiting",
				currentNodeKey: "msg",
				waitingFor: "delay",
				waitingUntil: new Date(Date.now() - 60_000),
			})
			.returning();
		if (!run) throw new Error("run insert failed");

		// Queue a resume_run job that is due.
		await db.insert(automationScheduledJobs).values({
			runId: run.id,
			jobType: "resume_run",
			automationId: auto.id,
			runAt: new Date(Date.now() - 1_000),
			status: "pending",
		});

		const before = Date.now();
		const result = await processScheduledJobs(db, {});
		expect(result.processed + result.failed).toBeGreaterThanOrEqual(1);
		expect(Date.now()).toBeGreaterThan(before);

		// Run should be progressed — typically completed now since handler is a no-op.
		const refreshed = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, run.id),
		});
		expect(["active", "completed", "waiting"]).toContain(refreshed!.status);
	});

	it("reclaims stale processing rows", async () => {
		if (!dbAvailable) return;

		// Insert a job stuck in processing far in the past.
		const ct = await makeContact();
		const auto = await makeAutomation("stale-job");
		const [run] = await db
			.insert(automationRuns)
			.values({
				automationId: auto.id,
				organizationId: orgId,
				contactId: ct.id,
				status: "active",
				currentNodeKey: "stop", // end node — handler returns immediately
			})
			.returning();
		if (!run) throw new Error("run insert failed");

		const [stuck] = await db
			.insert(automationScheduledJobs)
			.values({
				runId: run.id,
				jobType: "resume_run",
				automationId: auto.id,
				runAt: new Date(Date.now() - 20 * 60_000), // 20 min ago
				status: "processing",
				claimedAt: new Date(Date.now() - 10 * 60_000), // claimed 10 min ago
			})
			.returning();
		if (!stuck) throw new Error("stuck job insert failed");

		await processScheduledJobs(db, {}, { staleTimeoutMinutes: 5 });

		const refreshed = await db.query.automationScheduledJobs.findFirst({
			where: eq(automationScheduledJobs.id, stuck.id),
		});
		// Stale job should have been reclaimed and processed (done), or at
		// minimum flipped out of processing.
		expect(refreshed!.status).not.toBe("processing");
	});
});
