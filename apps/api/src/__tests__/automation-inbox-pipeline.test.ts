// apps/api/src/__tests__/automation-inbox-pipeline.test.ts
//
// Plan 5 / Task 3 — the meta-test that should have caught B1 + B2.
//
// Drives the FULL queue-consumer pipeline: `processInboxEvent` → inbox
// persistence → automation matcher → runner. Earlier e2e suites exercised
// the matcher and runner directly (via `matchAndEnrollOrBinding` /
// `enrollContact`), which bypassed the persistence-before-match ordering
// that hid bug B2. They also never exercised `interactive_payload`
// extraction, which left bug B1 (interactive resume) untested end-to-end.
//
// This suite calls `processInboxEvent` with synthetic `InboxQueueMessage`
// payloads that mirror what `platform-webhooks.ts` enqueues in production.
//
// Requires the SSH tunnel at localhost:5433 (see .vscode/tasks.json); the
// suite skips gracefully when the tunnel is down, matching the convention
// used by the other DB-backed integration suites.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	automationBindings,
	automationEntrypoints,
	automationRuns,
	automations,
	contactChannels,
	contacts,
	createDb,
	generateId,
	inboxConversations,
	inboxMessages,
	organization,
	socialAccounts,
	workspaces,
} from "@relayapi/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Graph } from "../schemas/automation-graph";
import type { InboxQueueMessage } from "../routes/platform-webhooks";
import { processInboxEvent } from "../services/inbox-event-processor";
import { computeSpecificity } from "../services/automations/trigger-matcher";
import type { Env } from "../types";
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
let tgPlatformAccountId = "";
// Separate Meta/Instagram social account for the quick-reply tests — Meta
// quick-replies are a FB/IG platform feature and need an IG normalizer path.
let igSocialAccountId = "";
let igPlatformAccountId = "";

// Shared send transport used by the automation runner when message nodes
// dispatch. We capture outbound messages so assertions can inspect them.
const sendCalls: SendMessageRequest[] = [];
const fakeSendTransport = async (req: SendMessageRequest) => {
	sendCalls.push(req);
	return { success: true, messageId: `msg_${sendCalls.length}` };
};
function resetSendCalls() {
	sendCalls.length = 0;
}

/**
 * Minimal Cloudflare-binding stubs. `processInboxEvent` doesn't touch
 * HYPERDRIVE when a `sharedDb` is passed, and `notifyRealtime` /
 * `dispatchWebhookEvent` both swallow their own errors, so we only need
 * enough surface area to not crash on access.
 */
const testEnv = {
	HYPERDRIVE: { connectionString: CONN },
	ENCRYPTION_KEY: "00000000000000000000000000000000",
	REALTIME: {
		idFromName: (_name: string) => ({ toString: () => "noop" }),
		get: () => ({
			fetch: async () => new Response("ok"),
		}),
	},
	// The runner reads `env.sendTransport` when dispatching message nodes.
	sendTransport: fakeSendTransport,
	db,
} as unknown as Env;

async function seedFixture() {
	orgId = generateId("org_");
	await db.insert(organization).values({
		id: orgId,
		name: "inbox-pipeline-org",
		slug: `ip-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({ organizationId: orgId, name: "ip-ws" })
		.returning();
	if (!ws) throw new Error("workspace insert failed");
	workspaceId = ws.id;

	tgPlatformAccountId = `tg_${generateId("acc_")}`;
	const [sa] = await db
		.insert(socialAccounts)
		.values({
			organizationId: orgId,
			workspaceId,
			platform: "telegram",
			platformAccountId: tgPlatformAccountId,
			displayName: "Pipeline Bot",
			username: "pipeline_bot",
			accessToken: "test-token-plaintext",
		})
		.returning();
	if (!sa) throw new Error("social account insert failed");
	socialAccountId = sa.id;

	igPlatformAccountId = `ig_${generateId("acc_")}`;
	const [igSa] = await db
		.insert(socialAccounts)
		.values({
			organizationId: orgId,
			workspaceId,
			platform: "instagram",
			platformAccountId: igPlatformAccountId,
			displayName: "Pipeline IG",
			username: "pipeline_ig",
			accessToken: "test-token-plaintext",
		})
		.returning();
	if (!igSa) throw new Error("IG social account insert failed");
	igSocialAccountId = igSa.id;
}

async function teardownFixture() {
	if (!orgId) return;
	await db
		.delete(automationRuns)
		.where(eq(automationRuns.organizationId, orgId));
	await db
		.delete(automationBindings)
		.where(eq(automationBindings.organizationId, orgId));
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
		.delete(inboxMessages)
		.where(eq(inboxMessages.organizationId, orgId));
	await db
		.delete(inboxConversations)
		.where(eq(inboxConversations.organizationId, orgId));
	await db
		.delete(contactChannels)
		.where(eq(contactChannels.socialAccountId, socialAccountId));
	if (igSocialAccountId) {
		await db
			.delete(contactChannels)
			.where(eq(contactChannels.socialAccountId, igSocialAccountId));
	}
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
			"[automation-inbox-pipeline.test] DB unavailable — suite will skip.",
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

async function createAutomation(name: string, graph: Graph) {
	const [auto] = await db
		.insert(automations)
		.values({
			organizationId: orgId,
			workspaceId,
			name,
			channel: "telegram" as never,
			status: "active",
			graph: graph as never,
		})
		.returning();
	if (!auto) throw new Error("automation insert failed");
	return auto;
}

async function createEntrypoint(params: {
	automationId: string;
	kind: string;
	config?: Record<string, unknown>;
}) {
	const [ep] = await db
		.insert(automationEntrypoints)
		.values({
			automationId: params.automationId,
			channel: "telegram" as never,
			kind: params.kind as never,
			status: "active",
			socialAccountId,
			config: (params.config ?? {}) as never,
			filters: null,
			allowReentry: false,
			specificity: computeSpecificity(
				params.kind,
				params.config ?? {},
				null,
				socialAccountId,
			),
		})
		.returning();
	if (!ep) throw new Error("entrypoint insert failed");
	return ep;
}

async function createWelcomeBinding(automationId: string) {
	const [binding] = await db
		.insert(automationBindings)
		.values({
			organizationId: orgId,
			workspaceId,
			channel: "telegram",
			bindingType: "welcome_message",
			socialAccountId,
			automationId,
			status: "active",
			config: {},
		})
		.returning();
	if (!binding) throw new Error("welcome binding insert failed");
	return binding;
}

async function createContactWithChannel(identifier: string) {
	const [ct] = await db
		.insert(contacts)
		.values({
			organizationId: orgId,
			workspaceId,
			name: `contact-${identifier}`,
		})
		.returning();
	if (!ct) throw new Error("contact insert failed");
	await db.insert(contactChannels).values({
		contactId: ct.id,
		socialAccountId,
		platform: "telegram",
		identifier,
	});
	return ct;
}

/**
 * Build a synthetic Telegram inbound-message queue payload. Shape matches
 * `platform-webhooks.ts` / the Telegram normalizer in inbox-event-processor.
 */
function buildTelegramTextMessage(params: {
	chatId: string;
	fromId: string;
	text: string;
	messageId?: number;
}): InboxQueueMessage {
	return {
		type: "telegram_webhook",
		platform: "telegram",
		platform_account_id: tgPlatformAccountId,
		organization_id: orgId,
		account_id: socialAccountId,
		event_type: "message",
		payload: {
			update_id: Math.floor(Math.random() * 1_000_000),
			message: {
				message_id: params.messageId ?? Math.floor(Math.random() * 1_000_000),
				from: {
					id: Number(params.fromId),
					first_name: "Pipeline",
					last_name: "Tester",
					username: `pipeline_${params.fromId}`,
				},
				chat: { id: Number(params.chatId), type: "private" },
				date: Math.floor(Date.now() / 1000),
				text: params.text,
			},
		},
		received_at: new Date().toISOString(),
	};
}

/**
 * Instagram DM with a `quick_reply.payload` — the Meta normalizer must
 * extract the payload into `interactive_payload` so the automation
 * interactive-resume path can match `quick_reply.<payload>` ports.
 */
function buildInstagramQuickReplyMessage(params: {
	customerId: string;
	payload: string;
	text?: string;
}): InboxQueueMessage {
	return {
		type: "instagram_webhook",
		platform: "instagram",
		platform_account_id: igPlatformAccountId,
		organization_id: orgId,
		account_id: igSocialAccountId,
		event_type: "messages",
		payload: {
			sender: { id: params.customerId },
			recipient: { id: igPlatformAccountId },
			timestamp: Date.now(),
			message: {
				mid: `mid_${generateId("")}`,
				text: params.text ?? "Topic A",
				quick_reply: { payload: params.payload },
			},
		},
		received_at: new Date().toISOString(),
	};
}

async function createIgContactWithChannel(identifier: string) {
	const [ct] = await db
		.insert(contacts)
		.values({
			organizationId: orgId,
			workspaceId,
			name: `ig-contact-${identifier}`,
		})
		.returning();
	if (!ct) throw new Error("ig contact insert failed");
	await db.insert(contactChannels).values({
		contactId: ct.id,
		socialAccountId: igSocialAccountId,
		platform: "instagram",
		identifier,
	});
	return ct;
}

async function createInstagramAutomation(name: string, graph: Graph) {
	const [auto] = await db
		.insert(automations)
		.values({
			organizationId: orgId,
			workspaceId,
			name,
			channel: "instagram" as never,
			status: "active",
			graph: graph as never,
		})
		.returning();
	if (!auto) throw new Error("instagram automation insert failed");
	return auto;
}

/**
 * Telegram callback_query (button tap) — the normalizer maps this to an
 * inbound message with `interactive_payload = callback_query.data`.
 */
function buildTelegramCallbackQuery(params: {
	chatId: string;
	fromId: string;
	data: string;
}): InboxQueueMessage {
	return {
		type: "telegram_webhook",
		platform: "telegram",
		platform_account_id: tgPlatformAccountId,
		organization_id: orgId,
		account_id: socialAccountId,
		event_type: "callback_query",
		payload: {
			update_id: Math.floor(Math.random() * 1_000_000),
			callback_query: {
				id: `cbq_${generateId("cbq_")}`,
				from: {
					id: Number(params.fromId),
					first_name: "Pipeline",
					last_name: "Button",
					username: `btnuser_${params.fromId}`,
				},
				message: {
					message_id: 1,
					chat: { id: Number(params.chatId), type: "private" },
					date: Math.floor(Date.now() / 1000),
					text: "Ready?",
				},
				data: params.data,
			},
		},
		received_at: new Date().toISOString(),
	};
}

// ---------------------------------------------------------------------------
// 3.1 — Welcome fires on first inbound, NOT on second
// ---------------------------------------------------------------------------

describe("3.1 welcome_message on first inbound only (pipeline)", () => {
	it("fires welcome the first time, skips the second", async () => {
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
				{
					from_node: "msg",
					from_port: "next",
					to_node: "stop",
					to_port: "in",
				},
			],
		};
		const welcomeAuto = await createAutomation("pipeline-welcome", graph);
		await createWelcomeBinding(welcomeAuto.id);

		const chatId = "70001";
		// Pre-create a linked contact so `ensureContactForAuthor` picks this one
		// up deterministically and `contact_channels` is available for the
		// message-send path.
		const ct = await createContactWithChannel(chatId);

		// --- First inbound -----------------------------------------------------
		const firstMsg = buildTelegramTextMessage({
			chatId,
			fromId: chatId,
			text: "hi",
		});
		await processInboxEvent(firstMsg, testEnv, db);

		// An inbox message must have landed.
		const inboxRows1 = await db
			.select({ id: inboxMessages.id })
			.from(inboxMessages)
			.where(eq(inboxMessages.organizationId, orgId));
		expect(inboxRows1.length).toBe(1);

		// Welcome automation must have enrolled.
		const runsAfterFirst = await db
			.select({ id: automationRuns.id, status: automationRuns.status })
			.from(automationRuns)
			.where(
				and(
					eq(automationRuns.automationId, welcomeAuto.id),
					eq(automationRuns.contactId, ct.id),
				),
			);
		expect(runsAfterFirst.length).toBe(1);
		// Welcome message was sent via the fake transport.
		expect(sendCalls.some((c) => c.text === "Welcome aboard!")).toBe(true);

		// --- Second inbound ----------------------------------------------------
		resetSendCalls();
		const secondMsg = buildTelegramTextMessage({
			chatId,
			fromId: chatId,
			text: "hello again",
		});
		await processInboxEvent(secondMsg, testEnv, db);

		const inboxRows2 = await db
			.select({ id: inboxMessages.id })
			.from(inboxMessages)
			.where(eq(inboxMessages.organizationId, orgId));
		expect(inboxRows2.length).toBe(2);

		const runsAfterSecond = await db
			.select({ id: automationRuns.id })
			.from(automationRuns)
			.where(
				and(
					eq(automationRuns.automationId, welcomeAuto.id),
					eq(automationRuns.contactId, ct.id),
				),
			);
		// Still exactly one run for the welcome automation — no re-enrollment.
		expect(runsAfterSecond.length).toBe(1);
		// No welcome send on the second message.
		expect(sendCalls.some((c) => c.text === "Welcome aboard!")).toBe(false);
	}, 45_000);
});

// ---------------------------------------------------------------------------
// 3.2 — Button postback resumes a waiting run
// ---------------------------------------------------------------------------

describe("3.2 button postback resumes waiting run (pipeline)", () => {
	it("advances via button.<id> when a callback_query arrives", async () => {
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
					to_node: "stop",
					to_port: "in",
				},
				{
					from_node: "ask",
					from_port: "button.no",
					to_node: "stop",
					to_port: "in",
				},
			],
		};

		const auto = await createAutomation("pipeline-buttons", graph);
		const chatId = "70002";
		const ct = await createContactWithChannel(chatId);

		// Seed a waiting run parked at the `ask` node — mirrors what
		// `enrollContact` would leave behind once the message dispatches.
		const { enrollContact } = await import(
			"../services/automations/runner"
		);
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
		expect(run!.currentNodeKey).toBe("ask");

		// Fire the callback_query through the full pipeline.
		const cbq = buildTelegramCallbackQuery({
			chatId,
			fromId: chatId,
			data: "yes",
		});
		await processInboxEvent(cbq, testEnv, db);

		run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("completed");
		const ctxJson = (run!.context as Record<string, unknown>) ?? {};
		expect(ctxJson.last_interactive_port).toBe("button.yes");
	}, 45_000);
});

// ---------------------------------------------------------------------------
// 3.3 — Quick-reply resumes a waiting run
// ---------------------------------------------------------------------------

describe("3.3 quick-reply resumes waiting run (pipeline)", () => {
	it("advances via quick_reply.<id> when a matching payload arrives", async () => {
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
						blocks: [{ id: "b1", type: "text", text: "Pick a topic" }],
						quick_replies: [
							{ id: "qr_abc", label: "Topic A" },
							{ id: "qr_xyz", label: "Topic B" },
						],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
						{
							key: "quick_reply.qr_abc",
							direction: "output",
							role: "interactive",
						},
						{
							key: "quick_reply.qr_xyz",
							direction: "output",
							role: "interactive",
						},
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
					from_port: "quick_reply.qr_abc",
					to_node: "stop",
					to_port: "in",
				},
				{
					from_node: "ask",
					from_port: "quick_reply.qr_xyz",
					to_node: "stop",
					to_port: "in",
				},
			],
		};

		const auto = await createAutomation("pipeline-quickreply", graph);
		const chatId = "70003";
		const ct = await createContactWithChannel(chatId);

		const { enrollContact } = await import(
			"../services/automations/runner"
		);
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

		// Telegram delivers quick replies as callback_query.data in practice
		// (there is no separate quick_reply protocol); the normalizer tags it as
		// `button_click` kind but the payload is still the id, so
		// `quick_reply.qr_abc` port matches.
		const cbq = buildTelegramCallbackQuery({
			chatId,
			fromId: chatId,
			data: "qr_abc",
		});
		await processInboxEvent(cbq, testEnv, db);

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("completed");
		const ctxJson = (run!.context as Record<string, unknown>) ?? {};
		expect(ctxJson.last_interactive_port).toBe("quick_reply.qr_abc");
	}, 45_000);
});

// ---------------------------------------------------------------------------
// 3.4 — Text reply to an input node still works (regression)
// ---------------------------------------------------------------------------

describe("3.4 text reply to input node (pipeline regression)", () => {
	it("captures the email and advances the run", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		const graph: Graph = {
			schema_version: 1,
			root_node_key: "ask",
			nodes: [
				{
					key: "ask",
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
					key: "stop",
					kind: "end",
					config: {},
					ports: [{ key: "in", direction: "input" }],
				},
			],
			edges: [
				{
					from_node: "ask",
					from_port: "captured",
					to_node: "stop",
					to_port: "in",
				},
			],
		};

		const auto = await createAutomation("pipeline-input", graph);
		const chatId = "70004";
		const ct = await createContactWithChannel(chatId);

		const { enrollContact } = await import(
			"../services/automations/runner"
		);
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

		const textMsg = buildTelegramTextMessage({
			chatId,
			fromId: chatId,
			text: "alice@example.com",
		});
		await processInboxEvent(textMsg, testEnv, db);

		run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("completed");
		const ctxJson = (run!.context as Record<string, unknown>) ?? {};
		expect(ctxJson.captured_email).toBe("alice@example.com");
	}, 45_000);
});

// ---------------------------------------------------------------------------
// 3.5 — Entrypoint match still works (regression)
// ---------------------------------------------------------------------------

describe("3.5 entrypoint keyword match (pipeline regression)", () => {
	it("enrolls a contact on matching keyword", async () => {
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
						blocks: [
							{ id: "b1", type: "text", text: "Here's a pizza menu" },
						],
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
					from_node: "reply",
					from_port: "next",
					to_node: "stop",
					to_port: "in",
				},
			],
		};

		const auto = await createAutomation("pipeline-keyword", graph);
		await createEntrypoint({
			automationId: auto.id,
			kind: "dm_received",
			config: { keywords: ["pizza"], match_mode: "contains" },
		});

		const chatId = "70005";
		const ct = await createContactWithChannel(chatId);

		const msg = buildTelegramTextMessage({
			chatId,
			fromId: chatId,
			text: "I want pizza",
		});
		await processInboxEvent(msg, testEnv, db);

		const runs = await db
			.select({ id: automationRuns.id, status: automationRuns.status })
			.from(automationRuns)
			.where(
				and(
					eq(automationRuns.automationId, auto.id),
					eq(automationRuns.contactId, ct.id),
				),
			);
		expect(runs.length).toBe(1);
		expect(sendCalls.some((c) => c.text === "Here's a pizza menu")).toBe(true);
	}, 45_000);
});

// ---------------------------------------------------------------------------
// 3.6 — Meta quick_reply.payload extraction (IG DM)
// ---------------------------------------------------------------------------

describe("3.6 Meta quick-reply payload resumes waiting run (pipeline)", () => {
	it("advances via quick_reply.<payload> when an IG DM carries message.quick_reply.payload", async () => {
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
						blocks: [{ id: "b1", type: "text", text: "Pick one" }],
						quick_replies: [
							{ id: "qr_yes", label: "Yes" },
							{ id: "qr_no", label: "No" },
						],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
						{
							key: "quick_reply.qr_yes",
							direction: "output",
							role: "interactive",
						},
						{
							key: "quick_reply.qr_no",
							direction: "output",
							role: "interactive",
						},
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
					from_port: "quick_reply.qr_yes",
					to_node: "stop",
					to_port: "in",
				},
				{
					from_node: "ask",
					from_port: "quick_reply.qr_no",
					to_node: "stop",
					to_port: "in",
				},
			],
		};

		const auto = await createInstagramAutomation("pipeline-ig-qr", graph);
		const customerId = `igcust_${generateId("").slice(-8)}`;
		const ct = await createIgContactWithChannel(customerId);

		const { enrollContact } = await import(
			"../services/automations/runner"
		);
		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "instagram",
			entrypointId: null,
			bindingId: null,
			env: { db, sendTransport: fakeSendTransport },
		});

		// Meta IG DM with `message.quick_reply.payload = "qr_yes"` — the
		// normalizer must extract this into `interactive_payload` so the
		// interactive-resume path matches the `quick_reply.qr_yes` port.
		const qrMsg = buildInstagramQuickReplyMessage({
			customerId,
			payload: "qr_yes",
			text: "Yes",
		});
		await processInboxEvent(qrMsg, testEnv, db);

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("completed");
		const ctxJson = (run!.context as Record<string, unknown>) ?? {};
		expect(ctxJson.last_interactive_port).toBe("quick_reply.qr_yes");
	}, 45_000);
});
