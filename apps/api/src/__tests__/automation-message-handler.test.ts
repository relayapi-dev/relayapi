// apps/api/src/__tests__/automation-message-handler.test.ts
//
// Integration test for the Unit-4 `message` node handler. Exercises the full
// path through runLoop → messageHandler → dispatchAutomationMessage → send
// transport. We inject a fake `sendTransport` via `ctx.env.sendTransport` so
// the test never hits a real platform API.
//
// Run the isolated suite through the root `db:with-tunnel` wrapper to include
// DB-backed cases. On CI or without the tunnel, the tests skip rather than fail.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	automationRuns,
	automations,
	contactChannels,
	contacts,
	createDb,
	generateId,
	socialAccounts,
	workspaces,
} from "@relayapi/db";
import { eq } from "drizzle-orm";
import { encryptAccountToken } from "../lib/account-token-crypto";
import type { Graph } from "../schemas/automation-graph";
import { buildCommentPrivateReplyRequest } from "../services/automations/nodes/message";
import { enrollContact } from "../services/automations/runner";
import { recordContactConsent } from "../services/contact-consent";
import type { SendMessageRequest } from "../services/message-sender";
import {
	deleteOwnedFixtureOrganization,
	deleteOwnedFixtureWorkspaces,
	insertOwnedFixtureOrganization,
} from "./helpers/owned-organization-fixture";

const TEST_ENCRYPTION_KEY = `test=${"11".repeat(32)}`;

const CONN =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;

const db = CONN
	? createDb(CONN)
	: (null as unknown as ReturnType<typeof createDb>);

let dbAvailable = false;
let orgId = "";
let workspaceId = "";

async function seedFixtureOrg() {
	orgId = generateId("org_");
	await insertOwnedFixtureOrganization(db, {
		id: orgId,
		name: "message-handler-test-org",
		slug: `msg-handler-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({
			organizationId: orgId,
			name: "message-handler-test-ws",
		})
		.returning();
	if (!ws) throw new Error("workspace insert failed");
	workspaceId = ws.id;
}

async function teardownFixtureOrg() {
	if (!orgId) return;
	await db.delete(automations).where(eq(automations.organizationId, orgId));
	await db.delete(contacts).where(eq(contacts.organizationId, orgId));
	await db
		.delete(socialAccounts)
		.where(eq(socialAccounts.organizationId, orgId));
	await deleteOwnedFixtureWorkspaces(db, orgId);
	await deleteOwnedFixtureOrganization(db, orgId);
}

async function createAutomation(graph: Graph, channel = "telegram") {
	const [auto] = await db
		.insert(automations)
		.values({
			organizationId: orgId,
			workspaceId,
			name: "msg-handler-test-automation",
			channel: channel as never,
			status: "active",
			graph: graph as never,
		})
		.returning();
	if (!auto) throw new Error("automation insert failed");
	return auto;
}

async function createContactWithChannel(
	platform: string,
	identifier: string,
	socialAccountId: string,
) {
	const [ct] = await db
		.insert(contacts)
		.values({
			organizationId: orgId,
			workspaceId,
			name: "msg-handler-test-contact",
		})
		.returning();
	if (!ct) throw new Error("contact insert failed");
	await db.insert(contactChannels).values({
		organizationId: orgId,
		contactId: ct.id,
		socialAccountId,
		platform: platform as typeof contactChannels.$inferInsert.platform,
		identifier,
	});
	await recordContactConsent(db, {
		organizationId: orgId,
		workspaceId,
		contactId: ct.id,
		channel: platform,
		purpose: "automation",
		identifier,
		status: "granted",
		source: "automation-message-handler-test",
		occurredAt: new Date(),
	});
	return ct;
}

async function createSocialAccount(platform: string) {
	const id = generateId("acc_");
	const [acc] = await db
		.insert(socialAccounts)
		.values({
			id,
			organizationId: orgId,
			workspaceId,
			platform: platform as never,
			platformAccountId: `platacc_${platform}_${Date.now()}`,
			username: `bot_${platform}`,
			accessToken: await encryptAccountToken(
				"test-token-plaintext",
				TEST_ENCRYPTION_KEY,
				id,
				"access_token",
			),
		})
		.returning();
	if (!acc) throw new Error("social account insert failed");
	return acc;
}

beforeAll(async () => {
	if (!CONN) return;
	try {
		await seedFixtureOrg();
		dbAvailable = true;
	} catch (err) {
		console.warn(
			"[automation-message-handler.test] DB fixture setup failed — SSH tunnel likely down. Tests will skip.",
			err instanceof Error ? err.message : err,
		);
	}
});

afterAll(async () => {
	if (dbAvailable) await teardownFixtureOrg();
});

describe("automation message handler", () => {
	it("builds official Instagram and Facebook private-reply requests", () => {
		expect(
			buildCommentPrivateReplyRequest("instagram", {
				commentId: "comment_ig",
				accountPlatformId: "ig_business_1",
				accessToken: "IGAA-token",
				text: "Thanks!",
			}),
		).toEqual({
			url: expect.stringContaining("/ig_business_1/messages"),
			body: {
				recipient: { comment_id: "comment_ig" },
				message: { text: "Thanks!" },
			},
		});
		expect(
			buildCommentPrivateReplyRequest("facebook", {
				commentId: "comment_fb",
				accountPlatformId: "page_1",
				accessToken: "page-token",
				text: "Thanks!",
			}),
		).toEqual({
			url: expect.stringContaining("/comment_fb/private_replies"),
			body: { message: "Thanks!" },
		});
	});

	it("renders a text block with buttons and parks the run on wait_input", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		const acc = await createSocialAccount("telegram");
		const ct = await createContactWithChannel("telegram", "tg_chat_42", acc.id);

		const graph: Graph = {
			schema_version: 1,
			root_node_key: "msg",
			nodes: [
				{
					key: "msg",
					kind: "message",
					config: {
						blocks: [
							{
								id: "b1",
								type: "text",
								text: "hi {{contact.name}}, pick one:",
								buttons: [
									{ id: "ba", type: "branch", label: "yes" },
									{ id: "bb", type: "branch", label: "no" },
								],
							},
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
					from_node: "msg",
					from_port: "next",
					to_node: "stop",
					to_port: "in",
				},
			],
		};
		const auto = await createAutomation(graph, "telegram");

		const sendCalls: SendMessageRequest[] = [];
		const sendTransport = async (req: SendMessageRequest) => {
			sendCalls.push(req);
			return { success: true, messageId: `msg_${sendCalls.length}` };
		};

		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: {
				db,
				sendTransport,
				ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
				// Pre-seed contact merge-tag data into run context so
				// {{contact.name}} resolves without a DB hydrate.
			},
			contextOverrides: { contact: { name: "alice" } },
		});

		// 1. sendTransport was invoked once with the rendered text + recipient.
		expect(sendCalls).toHaveLength(1);
		const call = sendCalls[0];
		if (!call) throw new Error("expected a send call");
		expect(call.platform).toBe("telegram");
		expect(call.recipientId).toBe("tg_chat_42");
		expect(call.text).toBe("hi alice, pick one:");
		// Buttons are a native field on SendMessageRequest (Unit RR5: Task 7).
		expect(call.buttons?.length).toBe(2);
		expect(call.buttons?.[0]?.label).toBe("yes");
		expect(call.buttons?.[0]?.type).toBe("branch");

		// 2. Run is parked on wait_input because the text block has branch buttons.
		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		if (!run) throw new Error("expected run to exist");
		expect(run.status).toBe("waiting");
		expect(run.waitingFor).toBe("input");
	});

	it("advances when the message has no interactive elements and no wait_for_reply", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		const acc = await createSocialAccount("telegram");
		const ct = await createContactWithChannel("telegram", "tg_chat_99", acc.id);

		const graph: Graph = {
			schema_version: 1,
			root_node_key: "msg",
			nodes: [
				{
					key: "msg",
					kind: "message",
					config: {
						blocks: [
							{
								id: "b1",
								type: "text",
								text: "just a heads up",
							},
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
					from_node: "msg",
					from_port: "next",
					to_node: "stop",
					to_port: "in",
				},
			],
		};
		const auto = await createAutomation(graph, "telegram");

		const sendCalls: SendMessageRequest[] = [];
		const sendTransport = async (req: SendMessageRequest) => {
			sendCalls.push(req);
			return { success: true, messageId: "msg_1" };
		};

		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: { db, sendTransport, ENCRYPTION_KEY: TEST_ENCRYPTION_KEY },
		});

		expect(sendCalls).toHaveLength(1);
		expect(sendCalls[0]?.text).toBe("just a heads up");

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		if (!run) throw new Error("expected run to exist");
		expect(run.status).toBe("completed");
		expect(run.exitReason).toBe("completed");
	});

	it("fails the run when no contact_channels row exists for the channel", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		// Contact has NO channel membership — handler should return `fail`.
		const [ct] = await db
			.insert(contacts)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "no-channel-contact",
			})
			.returning();
		if (!ct) throw new Error("contact insert failed");

		const graph: Graph = {
			schema_version: 1,
			root_node_key: "msg",
			nodes: [
				{
					key: "msg",
					kind: "message",
					config: {
						blocks: [{ id: "b1", type: "text", text: "hello" }],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
					],
				},
			],
			edges: [],
		};
		const auto = await createAutomation(graph, "telegram");

		const sendTransport = async () => ({ success: true });

		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: { db, sendTransport, ENCRYPTION_KEY: TEST_ENCRYPTION_KEY },
		});

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		if (!run) throw new Error("expected run to exist");
		expect(run.status).toBe("failed");
		expect(run.exitReason).toBe("handler_failure");
	});
});
