// apps/api/src/__tests__/automation-message-handler.test.ts
//
// Integration test for the Unit-4 `message` node handler. Exercises the full
// path through runLoop → messageHandler → dispatchAutomationMessage → send
// transport. We inject a fake `sendTransport` via `ctx.env.sendTransport` so
// the test never hits a real platform API.
//
// Requires the SSH tunnel to localhost:5433 (see .vscode/tasks.json). On CI
// or when the tunnel is down, the tests skip rather than fail.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	automationRuns,
	automations,
	contactChannels,
	contacts,
	createDb,
	generateId,
	organization,
	socialAccounts,
	workspaces,
} from "@relayapi/db";
import { eq } from "drizzle-orm";
import type { Graph } from "../schemas/automation-graph";
import type { SendMessageRequest } from "../services/message-sender";
import { enrollContact } from "../services/automations/runner";

const CONN =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??
	"postgres://relayapi:z9scNsSByxEn8QC6Z6PDQLLSKLum3F@localhost:5433/relayapi?sslmode=disable";

const db = createDb(CONN);

let dbAvailable = false;
let orgId = "";
let workspaceId = "";

async function seedFixtureOrg() {
	orgId = generateId("org_");
	await db.insert(organization).values({
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
	await db.delete(workspaces).where(eq(workspaces.organizationId, orgId));
	await db.delete(organization).where(eq(organization.id, orgId));
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
		contactId: ct.id,
		socialAccountId,
		platform,
		identifier,
	});
	return ct;
}

async function createSocialAccount(platform: string) {
	const [acc] = await db
		.insert(socialAccounts)
		.values({
			organizationId: orgId,
			workspaceId,
			platform: platform as never,
			platformAccountId: `platacc_${platform}_${Date.now()}`,
			username: `bot_${platform}`,
			accessToken: "test-token-plaintext",
		})
		.returning();
	if (!acc) throw new Error("social account insert failed");
	return acc;
}

beforeAll(async () => {
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
	it("renders a text block with buttons and parks the run on wait_input", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		const acc = await createSocialAccount("telegram");
		const ct = await createContactWithChannel(
			"telegram",
			"tg_chat_42",
			acc.id,
		);

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
				// Pre-seed contact merge-tag data into run context so
				// {{contact.name}} resolves without a DB hydrate.
			},
			contextOverrides: { contact: { name: "alice" } },
		});

		// 1. sendTransport was invoked once with the rendered text + recipient.
		expect(sendCalls).toHaveLength(1);
		const call = sendCalls[0]!;
		expect(call.platform).toBe("telegram");
		expect(call.recipientId).toBe("tg_chat_42");
		expect(call.text).toBe("hi alice, pick one:");
		// Buttons are attached as a structured field (see platforms/index TODO).
		expect((call as any).buttons?.length).toBe(2);
		expect((call as any).buttons?.[0]?.label).toBe("yes");

		// 2. Run is parked on wait_input because the text block has branch buttons.
		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("waiting");
		expect(run!.waitingFor).toBe("input");
	});

	it("advances when the message has no interactive elements and no wait_for_reply", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		const acc = await createSocialAccount("telegram");
		const ct = await createContactWithChannel(
			"telegram",
			"tg_chat_99",
			acc.id,
		);

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
			env: { db, sendTransport },
		});

		expect(sendCalls).toHaveLength(1);
		expect(sendCalls[0]?.text).toBe("just a heads up");

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("completed");
		expect(run!.exitReason).toBe("completed");
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
			env: { db, sendTransport },
		});

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("failed");
		expect(run!.exitReason).toBe("handler_failure");
	});
});
