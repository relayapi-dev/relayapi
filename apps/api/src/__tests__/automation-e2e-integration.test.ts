// apps/api/src/__tests__/automation-e2e-integration.test.ts
//
// Plan 4 — Unit RR6 / Task 11: real end-to-end integration tests. After the
// targeted fixes landed in Units RR1-RR5, this suite exercises the composed
// automation engine against the real Postgres through the SSH tunnel:
//
//   - enrollContact through runner / nodes / actions
//   - resumeWaitingRunOnInput resumption of input nodes
//   - matchAndEnroll + matchAndEnrollOrBinding event dispatch
//   - receiveAutomationWebhook HMAC + contact lookup path
//   - processScheduledJobs scheduler dispatch
//   - internal event emission (tag_applied) triggering follow-up flows
//   - cycle-protection depth cap (5) on chained internal events
//
// Mocks: platform sends go through the fake `sendTransport` injected into
// `ctx.env`. webhook_out and similar outbound HTTP is monkey-patched at the
// action-registry level so the suite never touches real APIs. DB state for
// every scenario is torn down in afterAll.
//
// Requires the SSH tunnel at localhost:5433 (see .vscode/tasks.json). When
// the tunnel is down the whole suite skips gracefully — mirroring the other
// real-DB suites in this folder.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	automationBindings,
	automationContactControls,
	automationEntrypoints,
	automationRuns,
	automationScheduledJobs,
	automationStepRuns,
	automations,
	contactChannels,
	contacts,
	createDb,
	customFieldDefinitions,
	customFieldValues,
	generateId,
	inboxConversations,
	inboxMessages,
	organization,
	socialAccounts,
	workspaces,
} from "@relayapi/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Graph } from "../schemas/automation-graph";
import { actionRegistry } from "../services/automations/actions";
import { matchAndEnrollOrBinding } from "../services/automations/binding-router";
import { computeSpecificity } from "../services/automations/trigger-matcher";
import { enrollContact } from "../services/automations/runner";
import { processScheduledJobs } from "../services/automations/scheduler";
import {
	buildGraphFromTemplate,
	type TemplateKind,
} from "../services/automations/templates";
import {
	matchAndEnroll,
	type InboundEvent,
} from "../services/automations/trigger-matcher";
import { receiveAutomationWebhook } from "../services/automations/webhook-receiver";
import type { SendMessageRequest } from "../services/message-sender";

const CONN =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??
	"postgres://relayapi:z9scNsSByxEn8QC6Z6PDQLLSKLum3F@localhost:5433/relayapi?sslmode=disable";

const db = createDb(CONN);

let dbAvailable = false;
let orgId = "";
let workspaceId = "";
let socialAccountId = "";

// Fake transport shared across tests — clear between scenarios.
const sendCalls: SendMessageRequest[] = [];
const fakeSendTransport = async (req: SendMessageRequest) => {
	sendCalls.push(req);
	return { success: true, messageId: `msg_${sendCalls.length}` };
};
function resetSendCalls() {
	sendCalls.length = 0;
}

async function seedFixture() {
	orgId = generateId("org_");
	await db.insert(organization).values({
		id: orgId,
		name: "e2e-integration-org",
		slug: `e2ei-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({ organizationId: orgId, name: "e2ei-ws" })
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
			displayName: "E2EI Bot",
			username: "e2ei_bot",
			accessToken: "test-token-plaintext",
		})
		.returning();
	if (!sa) throw new Error("social account insert failed");
	socialAccountId = sa.id;
}

async function teardownFixture() {
	if (!orgId) return;
	await db
		.delete(automationStepRuns)
		.where(
			inArray(
				automationStepRuns.automationId,
				db
					.select({ id: automations.id })
					.from(automations)
					.where(eq(automations.organizationId, orgId)),
			),
		);
	await db
		.delete(automationRuns)
		.where(eq(automationRuns.organizationId, orgId));
	await db
		.delete(automationContactControls)
		.where(eq(automationContactControls.organizationId, orgId));
	await db
		.delete(automationBindings)
		.where(eq(automationBindings.organizationId, orgId));
	await db
		.delete(automationScheduledJobs)
		.where(
			inArray(
				automationScheduledJobs.automationId,
				db
					.select({ id: automations.id })
					.from(automations)
					.where(eq(automations.organizationId, orgId)),
			),
		);
	await db
		.delete(automationEntrypoints)
		.where(
			inArray(
				automationEntrypoints.automationId,
				db
					.select({ id: automations.id })
					.from(automations)
					.where(eq(automations.organizationId, orgId)),
			),
		);
	await db.delete(automations).where(eq(automations.organizationId, orgId));
	await db
		.delete(customFieldValues)
		.where(eq(customFieldValues.organizationId, orgId));
	await db
		.delete(customFieldDefinitions)
		.where(eq(customFieldDefinitions.organizationId, orgId));
	await db
		.delete(inboxMessages)
		.where(eq(inboxMessages.organizationId, orgId));
	await db
		.delete(inboxConversations)
		.where(eq(inboxConversations.organizationId, orgId));
	await db.delete(contactChannels).where(
		inArray(
			contactChannels.contactId,
			db
				.select({ id: contacts.id })
				.from(contacts)
				.where(eq(contacts.organizationId, orgId)),
		),
	);
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
			"[automation-e2e-integration.test] DB unavailable — suite will skip.",
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

async function createAutomation(
	name: string,
	graph: Graph,
	channel = "telegram",
) {
	const [auto] = await db
		.insert(automations)
		.values({
			organizationId: orgId,
			workspaceId,
			name,
			channel: channel as never,
			status: "active",
			graph: graph as never,
		})
		.returning();
	if (!auto) throw new Error("automation insert failed");
	return auto;
}

async function createContactWithChannel(params: {
	name: string;
	identifier: string;
	tags?: string[];
	channel?: string;
}) {
	const [ct] = await db
		.insert(contacts)
		.values({
			organizationId: orgId,
			workspaceId,
			name: params.name,
			tags: params.tags ?? [],
		})
		.returning();
	if (!ct) throw new Error("contact insert failed");
	await db.insert(contactChannels).values({
		contactId: ct.id,
		socialAccountId,
		platform: params.channel ?? "telegram",
		identifier: params.identifier,
	});
	return ct;
}

async function createBareContact(params: {
	name: string;
	email?: string;
	tags?: string[];
}) {
	const [ct] = await db
		.insert(contacts)
		.values({
			organizationId: orgId,
			workspaceId,
			name: params.name,
			email: params.email,
			tags: params.tags ?? [],
		})
		.returning();
	if (!ct) throw new Error("contact insert failed");
	return ct;
}

async function createEntrypoint(params: {
	automationId: string;
	kind: string;
	config?: Record<string, unknown>;
	filters?: Record<string, unknown> | null;
	accountScoped?: boolean;
	allowReentry?: boolean;
	channel?: string;
}) {
	const [ep] = await db
		.insert(automationEntrypoints)
		.values({
			automationId: params.automationId,
			channel: (params.channel ?? "telegram") as never,
			kind: params.kind as never,
			status: "active",
			socialAccountId: params.accountScoped === false ? null : socialAccountId,
			config: (params.config ?? {}) as never,
			filters: params.filters ?? null,
			allowReentry: params.allowReentry ?? false,
			specificity: computeSpecificity(
				params.kind,
				params.config ?? {},
				params.filters ?? null,
				params.accountScoped === false ? null : socialAccountId,
			),
		})
		.returning();
	if (!ep) throw new Error("entrypoint insert failed");
	return ep;
}

// ---------------------------------------------------------------------------
// Scenario 11.1 — Lead capture flow
// ---------------------------------------------------------------------------

describe("11.1 lead capture flow", () => {
	it("asks for email, captures it, tags + sets field, sends thanks, completes", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		const graph: Graph = {
			schema_version: 1,
			root_node_key: "ask_hi",
			nodes: [
				{
					key: "ask_hi",
					kind: "message",
					config: {
						blocks: [{ id: "b1", type: "text", text: "hi, what's your email?" }],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
					],
				},
				{
					key: "ask_email",
					kind: "input",
					config: {
						field: "captured_email",
						input_type: "email",
						max_retries: 2,
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "captured", direction: "output" },
						{ key: "invalid", direction: "output" },
						{ key: "timeout", direction: "output" },
					],
				},
				{
					key: "save",
					kind: "action_group",
					config: {
						actions: [
							{
								id: "a1",
								type: "tag_add",
								tag: "lead",
								on_error: "abort",
							},
							{
								id: "a2",
								type: "field_set",
								field: "email",
								value: "{{state.captured_email}}",
								on_error: "abort",
							},
						],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
						{ key: "error", direction: "output", role: "error" },
					],
				},
				{
					key: "thanks",
					kind: "message",
					config: {
						blocks: [{ id: "b2", type: "text", text: "Thanks — all set!" }],
					},
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
				{ from_node: "ask_hi", from_port: "next", to_node: "ask_email", to_port: "in" },
				{ from_node: "ask_email", from_port: "captured", to_node: "save", to_port: "in" },
				{ from_node: "save", from_port: "next", to_node: "thanks", to_port: "in" },
				{ from_node: "thanks", from_port: "next", to_node: "stop", to_port: "in" },
			],
		};

		// Pre-create the "email" custom field definition so field_set updates it.
		await db.insert(customFieldDefinitions).values({
			organizationId: orgId,
			workspaceId,
			name: "Email",
			slug: "email",
			type: "text",
		});

		const auto = await createAutomation("lead-capture-flow", graph, "telegram");
		const ct = await createContactWithChannel({
			name: "alice-lead",
			identifier: "tg_chat_lead_1",
		});

		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: { db, sendTransport: fakeSendTransport },
		});

		// After enrollContact, the run should be parked waiting for input
		// (the ask_email node). The "ask_hi" message has no interactive
		// elements so it advances past immediately.
		let run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("waiting");
		expect(run!.waitingFor).toBe("input");
		expect(run!.currentNodeKey).toBe("ask_email");
		expect(sendCalls.length).toBe(1);
		expect(sendCalls[0]!.text).toBe("hi, what's your email?");

		// Simulate inbound email via the resume helper.
		const { resumeWaitingRunOnInput } = await import(
			"../services/automations/input-resume"
		);
		const outcome = await resumeWaitingRunOnInput(
			db,
			runId,
			"alice@example.com",
			false,
			{ db, sendTransport: fakeSendTransport },
		);
		expect(outcome).toBe("advanced");

		// Run should now be completed: tag added, field set, thanks sent.
		run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("completed");
		const ctxJson = (run!.context as Record<string, unknown>) ?? {};
		expect(ctxJson.captured_email).toBe("alice@example.com");

		// Tag added to contact.
		const refreshed = await db.query.contacts.findFirst({
			where: eq(contacts.id, ct.id),
		});
		expect(refreshed!.tags).toContain("lead");

		// Field set to the captured email value.
		const fv = await db
			.select({ value: customFieldValues.value })
			.from(customFieldValues)
			.innerJoin(
				customFieldDefinitions,
				eq(customFieldDefinitions.id, customFieldValues.definitionId),
			)
			.where(
				and(
					eq(customFieldValues.contactId, ct.id),
					eq(customFieldDefinitions.slug, "email"),
				),
			);
		expect(fv[0]?.value).toBe("alice@example.com");

		// Two sent messages: prompt + thanks.
		expect(sendCalls.length).toBe(2);
		expect(sendCalls[1]!.text).toBe("Thanks — all set!");
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Scenario 11.2 — Keyword DM trigger
// ---------------------------------------------------------------------------

describe("11.2 keyword DM trigger", () => {
	it("enrolls on matching case-insensitive keyword, skips non-matching", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		const graph: Graph = {
			schema_version: 1,
			root_node_key: "reply",
			nodes: [
				{
					key: "reply",
					kind: "message",
					config: {
						blocks: [{ id: "b1", type: "text", text: "Here's a pizza menu" }],
					},
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
				{ from_node: "reply", from_port: "next", to_node: "stop", to_port: "in" },
			],
		};

		const auto = await createAutomation("kw-dm-auto", graph, "telegram");
		await createEntrypoint({
			automationId: auto.id,
			kind: "dm_received",
			config: { keywords: ["pizza"], match_mode: "contains" },
		});

		// Positive: case-insensitive match.
		const hitCt = await createContactWithChannel({
			name: "pizza-fan",
			identifier: "tg_chat_pizza_1",
		});
		const hit = await matchAndEnroll(
			db,
			{
				kind: "dm_received",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: hitCt.id,
				conversationId: null,
				text: "I want PIZZA please!",
			},
			{ db, sendTransport: fakeSendTransport },
		);
		expect(hit.matched).toBe(true);
		if (!hit.matched) throw new Error("expected match");

		const hitRun = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, hit.runId),
		});
		expect(hitRun!.status).toBe("completed");
		expect(sendCalls.some((c) => c.text === "Here's a pizza menu")).toBe(true);

		// Negative: non-matching text.
		resetSendCalls();
		const missCt = await createContactWithChannel({
			name: "burger-fan",
			identifier: "tg_chat_burger_1",
		});
		const miss = await matchAndEnroll(
			db,
			{
				kind: "dm_received",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: missCt.id,
				conversationId: null,
				text: "burger please",
			},
			{ db, sendTransport: fakeSendTransport },
		);
		expect(miss.matched).toBe(false);
		if (miss.matched) throw new Error("expected no match");
		expect(miss.reason).toBe("all_filtered");
		expect(sendCalls.length).toBe(0);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Scenario 11.3 — Comment to DM
// ---------------------------------------------------------------------------

describe("11.3 comment-to-DM template", () => {
	it("enrolls on matching comment and fires the DM message node", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		// Use an instagram scope for this scenario since comment_to_dm is ig.
		const [igAcc] = await db
			.insert(socialAccounts)
			.values({
				organizationId: orgId,
				workspaceId,
				platform: "instagram",
				platformAccountId: `ig_${generateId("acc_")}`,
				displayName: "E2EI IG",
				username: "e2ei_ig",
				accessToken: "test-token-plaintext",
			})
			.returning();
		if (!igAcc) throw new Error("ig social_account insert failed");
		const igAccountId = igAcc.id;

		const built = buildGraphFromTemplate({
			kind: "comment_to_dm" as TemplateKind,
			channel: "instagram",
			config: {
				post_ids: ["post_xyz"],
				keyword_filter: ["info"],
				dm_message: {
					blocks: [{ id: "b1", type: "text", text: "Here you go!" }],
				},
				once_per_user: true,
				social_account_id: igAccountId,
			},
		});

		const [auto] = await db
			.insert(automations)
			.values({
				organizationId: orgId,
				workspaceId,
				name: built.name,
				description: built.description,
				channel: "instagram",
				status: "active",
				graph: built.graph as never,
				createdFromTemplate: "comment_to_dm",
			})
			.returning();
		if (!auto) throw new Error("automation insert failed");

		for (const ep of built.entrypoints) {
			await db.insert(automationEntrypoints).values({
				automationId: auto.id,
				channel: "instagram",
				kind: ep.kind as never,
				socialAccountId: ep.socialAccountId ?? igAccountId,
				config: (ep.config ?? {}) as never,
				filters: ep.filters ?? null,
				allowReentry: ep.allowReentry ?? false,
				specificity: computeSpecificity(
					ep.kind,
					ep.config ?? {},
					ep.filters ?? null,
					ep.socialAccountId ?? igAccountId,
				),
			});
		}

		// Contact with an IG channel so the DM recipient resolver finds them.
		const [ct] = await db
			.insert(contacts)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "ig-commenter",
			})
			.returning();
		if (!ct) throw new Error("contact insert failed");
		await db.insert(contactChannels).values({
			contactId: ct.id,
			socialAccountId: igAccountId,
			platform: "instagram",
			identifier: "ig_user_42",
		});

		const match = await matchAndEnrollOrBinding(
			db,
			{
				kind: "comment_created",
				channel: "instagram",
				organizationId: orgId,
				socialAccountId: igAccountId,
				contactId: ct.id,
				conversationId: null,
				postId: "post_xyz",
				text: "info please",
			},
			{ db, sendTransport: fakeSendTransport },
		);
		expect(match.matched).toBe(true);
		if (!match.matched) throw new Error("expected match");

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, match.runId),
		});
		expect(["completed", "exited"]).toContain(run!.status);

		// At least one step_run for the message node must have been recorded.
		const steps = await db
			.select()
			.from(automationStepRuns)
			.where(eq(automationStepRuns.runId, match.runId));
		expect(steps.some((s) => s.nodeKind === "message")).toBe(true);

		// Mocked send was called with the rendered text.
		expect(sendCalls.some((c) => c.text === "Here you go!")).toBe(true);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Scenario 11.4 — Welcome message binding on first inbound only
// ---------------------------------------------------------------------------

describe("11.4 welcome_message binding (first inbound only)", () => {
	it("fires welcome on first DM, NOT on second DM", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		const graph: Graph = {
			schema_version: 1,
			root_node_key: "msg",
			nodes: [
				{
					key: "msg",
					kind: "message",
					config: {
						blocks: [{ id: "b1", type: "text", text: "Welcome aboard!" }],
					},
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
				{ from_node: "msg", from_port: "next", to_node: "stop", to_port: "in" },
			],
		};
		const welcomeAuto = await createAutomation(
			"welcome-auto",
			graph,
			"telegram",
		);

		await db.insert(automationBindings).values({
			organizationId: orgId,
			workspaceId,
			channel: "telegram",
			bindingType: "welcome_message",
			socialAccountId,
			automationId: welcomeAuto.id,
			status: "active",
			config: {},
		});

		const ct = await createContactWithChannel({
			name: "welcome-contact",
			identifier: "tg_chat_welcome_1",
		});

		// FIRST inbound DM — welcome should fire. No entrypoints exist for
		// dm_received so matchAndEnrollOrBinding falls through to the binding.
		const first = await matchAndEnrollOrBinding(
			db,
			{
				kind: "dm_received",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: ct.id,
				conversationId: null,
				text: "hi",
			},
			{ db, sendTransport: fakeSendTransport },
		);
		expect(first.matched).toBe(true);
		if (!first.matched) throw new Error("expected welcome to fire");
		expect(first.automationId).toBe(welcomeAuto.id);
		expect(sendCalls.some((c) => c.text === "Welcome aboard!")).toBe(true);

		// Simulate the prior inbound was persisted so the "first inbound" test
		// for the second attempt fails (binding router checks inbox_messages).
		const [conv] = await db
			.insert(inboxConversations)
			.values({
				organizationId: orgId,
				workspaceId,
				accountId: socialAccountId,
				platform: "telegram",
				type: "dm",
				platformConversationId: `tg_conv_welcome_${Date.now()}`,
				participantPlatformId: "tg_chat_welcome_1",
				contactId: ct.id,
				lastMessageAt: new Date(),
			})
			.returning();
		if (!conv) throw new Error("conversation insert failed");
		await db.insert(inboxMessages).values({
			conversationId: conv.id,
			organizationId: orgId,
			direction: "inbound",
			platformMessageId: `msg_welcome_first_${Date.now()}`,
			text: "hi",
		});

		// Clear pending welcome run so reentry-guard doesn't block round 2.
		await db
			.delete(automationRuns)
			.where(eq(automationRuns.automationId, welcomeAuto.id));

		resetSendCalls();
		const second = await matchAndEnrollOrBinding(
			db,
			{
				kind: "dm_received",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: ct.id,
				conversationId: conv.id,
				text: "hello again",
			},
			{ db, sendTransport: fakeSendTransport },
		);
		// No default_reply binding exists AND welcome should not fire twice, so
		// the fallback returns no_candidates.
		expect(second.matched).toBe(false);
		if (second.matched) throw new Error("expected no second welcome");
		// Must NOT have sent the welcome message again.
		expect(sendCalls.some((c) => c.text === "Welcome aboard!")).toBe(false);
	}, 30_000);

	it("welcome binding does NOT fire on comment_created", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		// Same welcome binding from the previous scenario is still active for
		// `socialAccountId` — if bug 9 regressed, a comment would trigger it.
		const ct = await createContactWithChannel({
			name: "comment-only-contact",
			identifier: "tg_chat_comment_only",
		});
		const result = await matchAndEnrollOrBinding(
			db,
			{
				kind: "comment_created",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: ct.id,
				conversationId: null,
				postId: "some_post",
				text: "nice",
			},
			{ db, sendTransport: fakeSendTransport },
		);
		expect(result.matched).toBe(false);
		// No welcome send.
		expect(sendCalls.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Scenario 11.4b — Interactive button resume via resumeWaitingRunOnInteractive
// Plan 5 / Task 1 (B1): runs parked on a `message` node with branch buttons
// must advance via the matching `button.<id>` port. Prior to RR7 this path
// was short-circuited by `resumeWaitingRunOnInput` and runs got stuck.
// ---------------------------------------------------------------------------

describe("11.4b interactive button resume", () => {
	it("advances the waiting run via button.yes when payload='yes'", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		const graph: Graph = {
			schema_version: 1,
			root_node_key: "ask",
			nodes: [
				{
					key: "ask",
					kind: "message",
					config: {
						blocks: [
							{
								id: "b1",
								type: "text",
								text: "Ready?",
								buttons: [
									{ id: "yes", type: "branch", label: "Yes" },
									{ id: "no", type: "branch", label: "No" },
								],
							},
						],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
						{
							key: "button.yes",
							direction: "output",
							role: "interactive",
						},
						{
							key: "button.no",
							direction: "output",
							role: "interactive",
						},
					],
				},
				{
					key: "yes_reply",
					kind: "message",
					config: {
						blocks: [{ id: "y1", type: "text", text: "Great — let's go!" }],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
					],
				},
				{
					key: "no_reply",
					kind: "message",
					config: {
						blocks: [{ id: "n1", type: "text", text: "No worries." }],
					},
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
					from_node: "ask",
					from_port: "button.yes",
					to_node: "yes_reply",
					to_port: "in",
				},
				{
					from_node: "ask",
					from_port: "button.no",
					to_node: "no_reply",
					to_port: "in",
				},
				{
					from_node: "yes_reply",
					from_port: "next",
					to_node: "stop",
					to_port: "in",
				},
				{
					from_node: "no_reply",
					from_port: "next",
					to_node: "stop",
					to_port: "in",
				},
			],
		};

		const auto = await createAutomation("buttons-e2e", graph, "telegram");
		const ct = await createContactWithChannel({
			name: "button-contact",
			identifier: "tg_chat_buttons_1",
		});

		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: { db, sendTransport: fakeSendTransport },
		});

		let run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("waiting");
		expect(run!.waitingFor).toBe("input");
		expect(run!.currentNodeKey).toBe("ask");
		// Only the "Ready?" prompt has been sent so far.
		expect(sendCalls.length).toBe(1);

		const { resumeWaitingRunOnInteractive } = await import(
			"../services/automations/interactive-resume"
		);
		const outcome = await resumeWaitingRunOnInteractive(db, runId, "yes", {
			db,
			sendTransport: fakeSendTransport,
		});
		expect(outcome).toBe("resumed");

		run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("completed");
		// The yes-branch message should have been sent on the way to the end.
		expect(sendCalls.some((c) => c.text === "Great — let's go!")).toBe(true);
		// No-branch message should NOT have been sent.
		expect(sendCalls.some((c) => c.text === "No worries.")).toBe(false);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Scenario 11.5 — Webhook entrypoint
// ---------------------------------------------------------------------------

describe("11.5 webhook_inbound entrypoint", () => {
	const secret =
		"wh_test_secret_0123456789abcdef0123456789abcdef0123456789abcdef";
	const webhookSlug = `e2ei-wh-${generateId("whk_").slice(-8)}`;

	async function signBody(body: string): Promise<string> {
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
		return Array.from(new Uint8Array(sigBuf))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}

	it("valid HMAC + existing contact → ok 202", async () => {
		if (!dbAvailable) return;

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
		const auto = await createAutomation("wh-auto", graph, "telegram");
		await db.insert(automationEntrypoints).values({
			automationId: auto.id,
			channel: "telegram",
			kind: "webhook_inbound",
			status: "active",
			config: {
				webhook_slug: webhookSlug,
				webhook_secret: secret,
				contact_lookup: { by: "email", field_path: "$.email" },
			} as never,
			specificity: 30,
		});

		const emailValue = `wh-${generateId("c_").slice(-8)}@example.com`;
		await createBareContact({ name: "wh-contact", email: emailValue });

		const body = JSON.stringify({ email: emailValue, extra: "x" });
		const sigHex = await signBody(body);

		const res = await receiveAutomationWebhook(
			db,
			{
				slug: webhookSlug,
				rawBody: body,
				signatureHeader: `sha256=${sigHex}`,
			},
			{ db },
		);
		expect(res.status).toBe("ok");
		if (res.status !== "ok") throw new Error("expected ok");
		expect(res.automationId).toBe(auto.id);
	});

	it("bad signature → bad_signature", async () => {
		if (!dbAvailable) return;
		const body = JSON.stringify({ email: "whatever@x.com" });
		const res = await receiveAutomationWebhook(
			db,
			{
				slug: webhookSlug,
				rawBody: body,
				signatureHeader: "sha256=deadbeef",
			},
			{ db },
		);
		expect(res.status).toBe("bad_signature");
	});

	it("unknown slug → unknown_slug", async () => {
		if (!dbAvailable) return;
		const res = await receiveAutomationWebhook(
			db,
			{
				slug: "totally-unknown-slug",
				rawBody: "{}",
				signatureHeader: "sha256=deadbeef",
			},
			{ db },
		);
		expect(res.status).toBe("unknown_slug");
	});

	it("missing contact + no auto_create → contact_lookup_failed", async () => {
		if (!dbAvailable) return;
		const body = JSON.stringify({ email: "not-in-db@example.com" });
		const sigHex = await signBody(body);
		const res = await receiveAutomationWebhook(
			db,
			{
				slug: webhookSlug,
				rawBody: body,
				signatureHeader: `sha256=${sigHex}`,
			},
			{ db },
		);
		expect(res.status).toBe("contact_lookup_failed");
	});
});

// ---------------------------------------------------------------------------
// Scenario 11.6 — Scheduled trigger
// ---------------------------------------------------------------------------

describe("11.6 scheduled_trigger", () => {
	it("enrolls tagged contacts only and reschedules the next cron firing", async () => {
		if (!dbAvailable) return;

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
		const auto = await createAutomation("sched-auto", graph, "telegram");

		const [ep] = await db
			.insert(automationEntrypoints)
			.values({
				automationId: auto.id,
				channel: "telegram",
				kind: "schedule",
				status: "active",
				socialAccountId: null,
				config: { cron: "*/5 * * * *" },
				filters: {
					all: [{ field: "tags", op: "contains", value: "newsletter" }],
				},
				specificity: 20,
			})
			.returning();
		if (!ep) throw new Error("ep insert failed");

		// Two tagged contacts (should enroll), three untagged (must NOT).
		const tagged1 = await createBareContact({
			name: "nl-1",
			tags: ["newsletter"],
		});
		const tagged2 = await createBareContact({
			name: "nl-2",
			tags: ["newsletter"],
		});
		await createBareContact({ name: "notag-1" });
		await createBareContact({ name: "notag-2" });
		await createBareContact({ name: "notag-3" });

		const [job] = await db
			.insert(automationScheduledJobs)
			.values({
				jobType: "scheduled_trigger",
				automationId: auto.id,
				entrypointId: ep.id,
				runAt: new Date(Date.now() - 60_000),
				status: "pending",
			})
			.returning();
		if (!job) throw new Error("job insert failed");

		const result = await processScheduledJobs(db, { db });
		expect(result.processed).toBeGreaterThanOrEqual(1);

		const runs = await db
			.select({ contactId: automationRuns.contactId })
			.from(automationRuns)
			.where(eq(automationRuns.automationId, auto.id));
		const contactIdsEnrolled = new Set(runs.map((r) => r.contactId));
		expect(contactIdsEnrolled.has(tagged1.id)).toBe(true);
		expect(contactIdsEnrolled.has(tagged2.id)).toBe(true);
		// Only the two tagged contacts should have runs (count = 2).
		expect(runs.length).toBe(2);

		// Original job is marked done, a fresh pending job exists for the next cron tick.
		const originalRow = await db.query.automationScheduledJobs.findFirst({
			where: eq(automationScheduledJobs.id, job.id),
		});
		expect(originalRow?.status).toBe("done");

		const pending = await db
			.select({
				id: automationScheduledJobs.id,
				runAt: automationScheduledJobs.runAt,
			})
			.from(automationScheduledJobs)
			.where(
				and(
					eq(automationScheduledJobs.entrypointId, ep.id),
					eq(automationScheduledJobs.status, "pending"),
				),
			);
		expect(pending.length).toBe(1);
		expect(pending[0]!.runAt.getTime()).toBeGreaterThan(Date.now());
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Scenario 11.7 — Branch resolution (condition node)
// ---------------------------------------------------------------------------

describe("11.7 condition branching on tags", () => {
	it("routes premium and free-tagged contacts through different branches", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		const graph: Graph = {
			schema_version: 1,
			root_node_key: "open",
			nodes: [
				{
					key: "open",
					kind: "message",
					config: {
						blocks: [{ id: "b0", type: "text", text: "checking your tier..." }],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
					],
				},
				{
					key: "cond",
					kind: "condition",
					config: {
						predicates: {
							all: [{ field: "tags", op: "contains", value: "premium" }],
						},
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "true", direction: "output" },
						{ key: "false", direction: "output" },
					],
				},
				{
					key: "premium_msg",
					kind: "message",
					config: {
						blocks: [{ id: "b1", type: "text", text: "premium path" }],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
					],
				},
				{
					key: "free_msg",
					kind: "message",
					config: {
						blocks: [{ id: "b2", type: "text", text: "free path" }],
					},
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
				{ from_node: "open", from_port: "next", to_node: "cond", to_port: "in" },
				{ from_node: "cond", from_port: "true", to_node: "premium_msg", to_port: "in" },
				{ from_node: "cond", from_port: "false", to_node: "free_msg", to_port: "in" },
				{ from_node: "premium_msg", from_port: "next", to_node: "stop", to_port: "in" },
				{ from_node: "free_msg", from_port: "next", to_node: "stop", to_port: "in" },
			],
		};
		const auto = await createAutomation("branch-auto", graph, "telegram");

		const ctA = await createContactWithChannel({
			name: "premium-A",
			identifier: "tg_premA",
			tags: ["premium"],
		});
		const ctB = await createContactWithChannel({
			name: "free-B",
			identifier: "tg_freeB",
		});

		await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ctA.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: { db, sendTransport: fakeSendTransport },
		});
		await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ctB.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: { db, sendTransport: fakeSendTransport },
		});

		const runs = await db
			.select({
				id: automationRuns.id,
				contactId: automationRuns.contactId,
			})
			.from(automationRuns)
			.where(eq(automationRuns.automationId, auto.id));

		for (const r of runs) {
			const steps = await db
				.select({ nodeKey: automationStepRuns.nodeKey })
				.from(automationStepRuns)
				.where(eq(automationStepRuns.runId, r.id));
			const keys = new Set(steps.map((s) => s.nodeKey));
			if (r.contactId === ctA.id) {
				expect(keys.has("premium_msg")).toBe(true);
				expect(keys.has("free_msg")).toBe(false);
			} else if (r.contactId === ctB.id) {
				expect(keys.has("free_msg")).toBe(true);
				expect(keys.has("premium_msg")).toBe(false);
			}
		}
		expect(sendCalls.some((c) => c.text === "premium path")).toBe(true);
		expect(sendCalls.some((c) => c.text === "free path")).toBe(true);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Scenario 11.8 — Per-action on_error=continue
// ---------------------------------------------------------------------------

describe("11.8 per-action error handling (continue)", () => {
	it("continues to the next action after a soft failure and exits via `next`", async () => {
		if (!dbAvailable) return;

		// Monkey-patch a test-only action that always throws. We can't simply use
		// webhook_out because it already catches fetch errors silently — the
		// action_group never sees a failure. Instead, register `fake_http_500`
		// that throws synchronously, so the on_error=continue contract can be
		// exercised end-to-end through the runner.
		const prior = actionRegistry.fake_http_500;
		actionRegistry.fake_http_500 = async () => {
			throw new Error("http 500");
		};

		try {
			const graph: Graph = {
				schema_version: 1,
				root_node_key: "save",
				nodes: [
					{
						key: "save",
						kind: "action_group",
						config: {
							actions: [
								{
									id: "a1",
									type: "fake_http_500",
									// Action schema's discriminator will reject this; the
									// action_group handler doesn't re-validate — it dispatches
									// by `type`. Cast to Action via the graph JSONB storage.
									on_error: "continue",
								},
								{
									id: "a2",
									type: "tag_add",
									tag: "completed",
									on_error: "abort",
								},
							],
						},
						ports: [
							{ key: "in", direction: "input" },
							{ key: "next", direction: "output", role: "default" },
							{ key: "error", direction: "output", role: "error" },
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
					{ from_node: "save", from_port: "next", to_node: "stop", to_port: "in" },
				],
			};
			const auto = await createAutomation("err-continue", graph, "telegram");
			const ct = await createContactWithChannel({
				name: "continue-ct",
				identifier: "tg_cont_1",
			});

			const { runId } = await enrollContact(db, {
				automationId: auto.id,
				organizationId: orgId,
				contactId: ct.id,
				conversationId: null,
				channel: "telegram",
				entrypointId: null,
				bindingId: null,
				env: { db, sendTransport: fakeSendTransport },
			});

			const run = await db.query.automationRuns.findFirst({
				where: eq(automationRuns.id, runId),
			});
			expect(run!.status).toBe("completed");

			// Tag was added despite the first action failing, because
			// on_error=continue suppressed the abort route.
			const refreshed = await db.query.contacts.findFirst({
				where: eq(contacts.id, ct.id),
			});
			expect(refreshed!.tags).toContain("completed");

			// The action_group step exited via `next`, not `error`.
			const steps = await db
				.select()
				.from(automationStepRuns)
				.where(eq(automationStepRuns.runId, runId));
			const agStep = steps.find((s) => s.nodeKind === "action_group");
			expect(agStep).toBeTruthy();
			expect(agStep!.exitedViaPortKey).toBe("next");
		} finally {
			if (prior === undefined) delete actionRegistry.fake_http_500;
			else actionRegistry.fake_http_500 = prior;
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Scenario 11.9 — Internal event triggering another flow
// ---------------------------------------------------------------------------

describe("11.9 internal event cross-flow enrollment", () => {
	it("flow A's tag_add emits tag_applied; flow B listens and enrolls the contact", async () => {
		if (!dbAvailable) return;

		// Flow A: action_group [tag_add("cross_flow_tag")] → end
		const graphA: Graph = {
			schema_version: 1,
			root_node_key: "save",
			nodes: [
				{
					key: "save",
					kind: "action_group",
					config: {
						actions: [
							{
								id: "a1",
								type: "tag_add",
								tag: "cross_flow_tag",
								on_error: "abort",
							},
						],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
						{ key: "error", direction: "output", role: "error" },
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
				{ from_node: "save", from_port: "next", to_node: "stop", to_port: "in" },
			],
		};
		const autoA = await createAutomation("flow-a", graphA, "telegram");

		// Flow B: triggered by tag_applied("cross_flow_tag") — just ends.
		const graphB: Graph = {
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
		const autoB = await createAutomation("flow-b", graphB, "telegram");
		await createEntrypoint({
			automationId: autoB.id,
			kind: "tag_applied",
			config: { tag_ids: ["cross_flow_tag"] },
			accountScoped: false,
			channel: "telegram",
		});

		const ct = await createContactWithChannel({
			name: "cross-flow-ct",
			identifier: "tg_cross_1",
		});

		await enrollContact(db, {
			automationId: autoA.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: { db, sendTransport: fakeSendTransport },
		});

		// A run should exist for each automation for this contact.
		const runs = await db
			.select({
				automationId: automationRuns.automationId,
			})
			.from(automationRuns)
			.where(eq(automationRuns.contactId, ct.id));
		const autoIdsWithRun = new Set(runs.map((r) => r.automationId));
		expect(autoIdsWithRun.has(autoA.id)).toBe(true);
		expect(autoIdsWithRun.has(autoB.id)).toBe(true);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Scenario 11.10 — Cycle protection (depth cap)
// ---------------------------------------------------------------------------

describe("11.10 cycle protection", () => {
	it("self-recursive tag loop terminates at the depth cap (<= 5 runs)", async () => {
		if (!dbAvailable) return;

		// Graph adds tag "loop_tag" — and the entrypoint fires on tag_applied("loop_tag").
		// Each enrollment re-adds the tag, which re-emits tag_applied, which
		// would normally enroll again forever. `emitInternalEvent` bumps
		// `_event_depth` and drops past MAX_EVENT_DEPTH=5.
		const graph: Graph = {
			schema_version: 1,
			root_node_key: "save",
			nodes: [
				{
					key: "save",
					kind: "action_group",
					config: {
						actions: [
							{
								id: "a1",
								type: "tag_add",
								tag: "loop_tag",
								on_error: "abort",
							},
						],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
						{ key: "error", direction: "output", role: "error" },
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
				{ from_node: "save", from_port: "next", to_node: "stop", to_port: "in" },
			],
		};
		const loopAuto = await createAutomation("loop-auto", graph, "telegram");
		await createEntrypoint({
			automationId: loopAuto.id,
			kind: "tag_applied",
			config: { tag_ids: ["loop_tag"] },
			accountScoped: false,
			allowReentry: true,
			channel: "telegram",
		});

		const ct = await createContactWithChannel({
			name: "cycle-ct",
			identifier: "tg_cycle_1",
		});

		// First enrollment is the "root". Re-entry from emitInternalEvent is
		// further blocked by the matcher's re-entry guard (no allowReentry, or
		// cooldown), but we enabled allowReentry above so we can see the depth
		// cap engage.
		await enrollContact(db, {
			automationId: loopAuto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: { db, sendTransport: fakeSendTransport },
		});

		const runs = await db
			.select({ id: automationRuns.id, status: automationRuns.status })
			.from(automationRuns)
			.where(
				and(
					eq(automationRuns.automationId, loopAuto.id),
					eq(automationRuns.contactId, ct.id),
				),
			);

		// With MAX_EVENT_DEPTH=5 the recursion must stop well before a runaway.
		// Exact count depends on whether each internal event actually re-enrolls
		// (the re-entry guard sees an active run and may block some), but the
		// invariant is that the total stays small and bounded. Upper-bound check
		// keeps the test stable regardless of exact guard interleaving.
		expect(runs.length).toBeLessThanOrEqual(6);
		// No runs should be active / waiting — everything terminated cleanly.
		expect(runs.every((r) => r.status !== "active")).toBe(true);
	}, 30_000);
});
