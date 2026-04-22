// apps/api/src/__tests__/automation-interactive-resume.test.ts
//
// Plan 5 / Task 1 (B1) coverage for the interactive-payload resumption path.
// A run parked at a `message` node with branch buttons or quick-reply chips
// waits on input; incoming events carrying an `interactive_payload` should
// match a `button.<id>` / `quick_reply.<id>` port and advance the run.
//
// Prior to RR7 `resumeWaitingRunOnInput` short-circuited for any non-`input`
// node kind, leaving runs parked on message-node buttons permanently stuck.

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
import { resumeWaitingRunOnInteractive } from "../services/automations/interactive-resume";
import { enrollContact } from "../services/automations/runner";
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
		name: "interactive-resume-org",
		slug: `ir-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({ organizationId: orgId, name: "ir-ws" })
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
			displayName: "IR Bot",
			username: "ir_bot",
			accessToken: "test-token-plaintext",
		})
		.returning();
	if (!sa) throw new Error("social account insert failed");
	socialAccountId = sa.id;
}

async function teardownFixture() {
	if (!orgId) return;
	await db
		.delete(automationRuns)
		.where(eq(automationRuns.organizationId, orgId));
	await db.delete(automations).where(eq(automations.organizationId, orgId));
	await db
		.delete(contactChannels)
		.where(eq(contactChannels.socialAccountId, socialAccountId));
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
			"[automation-interactive-resume.test] DB unavailable — suite will skip.",
			err instanceof Error ? err.message : err,
		);
	}
});

afterAll(async () => {
	if (dbAvailable) await teardownFixture();
});

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
 * Graph: message(text + 2 branch buttons "yes","no") → yes_end / no_end.
 * The message has no other blocks so the run parks on `button.yes` /
 * `button.no` ports after the node dispatches.
 */
function buttonsGraph(): Graph {
	return {
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
					{ key: "button.yes", direction: "output", role: "interactive" },
					{ key: "button.no", direction: "output", role: "interactive" },
				],
			},
			{
				key: "yes_end",
				kind: "end",
				config: { reason: "chose_yes" },
				ports: [{ key: "in", direction: "input" }],
			},
			{
				key: "no_end",
				kind: "end",
				config: { reason: "chose_no" },
				ports: [{ key: "in", direction: "input" }],
			},
		],
		edges: [
			{
				from_node: "ask",
				from_port: "button.yes",
				to_node: "yes_end",
				to_port: "in",
			},
			{
				from_node: "ask",
				from_port: "button.no",
				to_node: "no_end",
				to_port: "in",
			},
		],
	};
}

function quickRepliesGraph(): Graph {
	return {
		schema_version: 1,
		root_node_key: "ask",
		nodes: [
			{
				key: "ask",
				kind: "message",
				config: {
					blocks: [{ id: "b1", type: "text", text: "Pick a topic" }],
					quick_replies: [
						{ id: "topic_sales", label: "Sales" },
						{ id: "topic_support", label: "Support" },
					],
				},
				ports: [
					{ key: "in", direction: "input" },
					{ key: "next", direction: "output", role: "default" },
					{
						key: "quick_reply.topic_sales",
						direction: "output",
						role: "interactive",
					},
					{
						key: "quick_reply.topic_support",
						direction: "output",
						role: "interactive",
					},
				],
			},
			{
				key: "sales_end",
				kind: "end",
				config: {},
				ports: [{ key: "in", direction: "input" }],
			},
			{
				key: "support_end",
				kind: "end",
				config: {},
				ports: [{ key: "in", direction: "input" }],
			},
		],
		edges: [
			{
				from_node: "ask",
				from_port: "quick_reply.topic_sales",
				to_node: "sales_end",
				to_port: "in",
			},
			{
				from_node: "ask",
				from_port: "quick_reply.topic_support",
				to_node: "support_end",
				to_port: "in",
			},
		],
	};
}

describe("resumeWaitingRunOnInteractive", () => {
	it("advances a run via button.<id> port on a button-payload resume", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		const auto = await createAutomation("buttons-yes", buttonsGraph());
		const ct = await createContactWithChannel("tg_ir_buttons_1");

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

		// After enrollment the run should be parked at `ask` waiting on the
		// interactive buttons.
		let run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("waiting");
		expect(run!.waitingFor).toBe("input");
		expect(run!.currentNodeKey).toBe("ask");
		expect(sendCalls.length).toBe(1);

		const outcome = await resumeWaitingRunOnInteractive(db, runId, "yes", {
			db,
			sendTransport: fakeSendTransport,
		});
		expect(outcome).toBe("resumed");

		run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("completed");
		expect(run!.currentNodeKey).toBe("yes_end");
		const ctxJson = (run!.context as Record<string, unknown>) ?? {};
		expect(ctxJson.last_input_value).toBe("yes");
		expect(ctxJson.last_interactive_port).toBe("button.yes");
	}, 30_000);

	it("advances via quick_reply.<id> port on a quick-reply payload", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		const auto = await createAutomation("qr-support", quickRepliesGraph());
		const ct = await createContactWithChannel("tg_ir_qr_1");

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

		const outcome = await resumeWaitingRunOnInteractive(
			db,
			runId,
			"topic_support",
			{ db, sendTransport: fakeSendTransport },
		);
		expect(outcome).toBe("resumed");

		run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("completed");
		expect(run!.currentNodeKey).toBe("support_end");
		const ctxJson = (run!.context as Record<string, unknown>) ?? {};
		expect(ctxJson.last_interactive_port).toBe("quick_reply.topic_support");
	}, 30_000);

	it("returns no_match when the payload doesn't match any port", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		const auto = await createAutomation("buttons-no-match", buttonsGraph());
		const ct = await createContactWithChannel("tg_ir_nomatch_1");

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

		const outcome = await resumeWaitingRunOnInteractive(
			db,
			runId,
			"bogus_payload",
			{ db, sendTransport: fakeSendTransport },
		);
		expect(outcome).toBe("no_match");

		// Run should STILL be waiting — caller is expected to fall through to
		// text-input resume / entrypoint matching.
		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("waiting");
		expect(run!.currentNodeKey).toBe("ask");
	}, 30_000);

	it("returns race when the run is no longer waiting", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		const auto = await createAutomation("buttons-race", buttonsGraph());
		const ct = await createContactWithChannel("tg_ir_race_1");

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

		// Simulate another worker completing the run first.
		await db
			.update(automationRuns)
			.set({ status: "completed", completedAt: new Date() })
			.where(eq(automationRuns.id, runId));

		const outcome = await resumeWaitingRunOnInteractive(db, runId, "yes", {
			db,
			sendTransport: fakeSendTransport,
		});
		expect(outcome).toBe("race");
	}, 30_000);

	it("completes the run gracefully when the matched port has no outgoing edge", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		// Graph with a button but no edge from button.maybe → any node.
		const orphanGraph: Graph = {
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
								text: "Pick",
								buttons: [{ id: "maybe", type: "branch", label: "Maybe" }],
							},
						],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
						{ key: "button.maybe", direction: "output", role: "interactive" },
					],
				},
			],
			edges: [],
		};

		const auto = await createAutomation("orphan-button", orphanGraph);
		const ct = await createContactWithChannel("tg_ir_orphan_1");

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

		const outcome = await resumeWaitingRunOnInteractive(db, runId, "maybe", {
			db,
			sendTransport: fakeSendTransport,
		});
		expect(outcome).toBe("resumed");

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("completed");
		expect(run!.currentPortKey).toBe("button.maybe");
	}, 30_000);
});
