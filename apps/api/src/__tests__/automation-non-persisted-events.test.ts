// apps/api/src/__tests__/automation-non-persisted-events.test.ts
//
// Plan 7 / Task 3 — follow and standalone `ad_click` (CTM) events are
// "non-persisted": they don't produce rows in `inbox_conversations` /
// `inbox_messages`. Before this fix, the Facebook/Instagram normalizers
// wrote the platform sender id (PSID/IGSID) into `event.conversation_id`
// and the automations-bridge forwarded it as `InboundEvent.conversationId`
// — ending up in `automation_runs.conversation_id`, which is an FK to
// `inbox_conversations.id`. FK violation. The error was caught by
// `matchAndEnroll`'s inner try/catch and converted to
// `{ matched: false, reason: "no_active_automation" }` — a silent miss for
// every IG/FB `follow` or standalone CTM `ad_click` trigger.
//
// These tests drive the real normalizer + `processInboxEvent` pipeline end
// to end and assert a valid `automation_runs` row with
// `conversation_id = null` is produced.
//
// Also covers the `start_automation` → forward `socialAccountId` contract
// (bug G3): the spawned child run's persisted context must carry the
// parent's triggering social account so a later resume (after a delay)
// resolves the right outbound channel in multi-account workspaces.
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
import { enrollContact } from "../services/automations/runner";
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
let igSocialAccountId = "";
let igPlatformAccountId = "";
let fbSocialAccountId = "";
let fbPlatformAccountId = "";

const sendCalls: SendMessageRequest[] = [];
const fakeSendTransport = async (req: SendMessageRequest) => {
	sendCalls.push(req);
	return { success: true, messageId: `msg_${sendCalls.length}` };
};
function resetSendCalls() {
	sendCalls.length = 0;
}

const testEnv = {
	HYPERDRIVE: { connectionString: CONN },
	ENCRYPTION_KEY: "00000000000000000000000000000000",
	REALTIME: {
		idFromName: (_name: string) => ({ toString: () => "noop" }),
		get: () => ({
			fetch: async () => new Response("ok"),
		}),
	},
	sendTransport: fakeSendTransport,
	db,
} as unknown as Env;

async function seedFixture() {
	orgId = generateId("org_");
	await db.insert(organization).values({
		id: orgId,
		name: "non-persisted-org",
		slug: `np-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({ organizationId: orgId, name: "np-ws" })
		.returning();
	if (!ws) throw new Error("workspace insert failed");
	workspaceId = ws.id;

	igPlatformAccountId = `ig_${generateId("acc_")}`;
	const [igSa] = await db
		.insert(socialAccounts)
		.values({
			organizationId: orgId,
			workspaceId,
			platform: "instagram",
			platformAccountId: igPlatformAccountId,
			displayName: "NP IG",
			username: "np_ig",
			accessToken: "ig-token",
		})
		.returning();
	if (!igSa) throw new Error("IG social account insert failed");
	igSocialAccountId = igSa.id;

	fbPlatformAccountId = `fb_${generateId("acc_")}`;
	const [fbSa] = await db
		.insert(socialAccounts)
		.values({
			organizationId: orgId,
			workspaceId,
			platform: "facebook",
			platformAccountId: fbPlatformAccountId,
			displayName: "NP FB",
			username: "np_fb",
			accessToken: "fb-token",
		})
		.returning();
	if (!fbSa) throw new Error("FB social account insert failed");
	fbSocialAccountId = fbSa.id;
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
	if (igSocialAccountId) {
		await db
			.delete(contactChannels)
			.where(eq(contactChannels.socialAccountId, igSocialAccountId));
	}
	if (fbSocialAccountId) {
		await db
			.delete(contactChannels)
			.where(eq(contactChannels.socialAccountId, fbSocialAccountId));
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
			"[automation-non-persisted-events.test] DB unavailable — suite will skip.",
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

async function createAutomation(params: {
	name: string;
	channel: "instagram" | "facebook" | "telegram";
	graph: Graph;
}) {
	const [auto] = await db
		.insert(automations)
		.values({
			organizationId: orgId,
			workspaceId,
			name: params.name,
			channel: params.channel as never,
			status: "active",
			graph: params.graph as never,
		})
		.returning();
	if (!auto) throw new Error("automation insert failed");
	return auto;
}

/**
 * Minimal graph: message node → end, so enrollment advances (and writes a
 * send call via the fake transport) before parking at completion.
 */
function replyGraph(text: string): Graph {
	return {
		schema_version: 1,
		root_node_key: "reply",
		nodes: [
			{
				key: "reply",
				kind: "message",
				config: {
					blocks: [{ id: "b1", type: "text", text }],
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
}

// ---------------------------------------------------------------------------
// G1: `follow` trigger enrolls (no FK violation)
// ---------------------------------------------------------------------------

describe("G1: follow trigger creates a valid run with conversation_id=null", () => {
	it("Instagram follow event enrolls the contact and produces a clean run", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		const auto = await createAutomation({
			name: "np-ig-follow",
			channel: "instagram",
			graph: replyGraph("Thanks for the follow!"),
		});
		await db.insert(automationEntrypoints).values({
			automationId: auto.id,
			channel: "instagram" as never,
			kind: "follow" as never,
			status: "active",
			socialAccountId: igSocialAccountId,
			config: {},
			filters: null,
			specificity: computeSpecificity("follow", {}, null, igSocialAccountId),
		});

		// IG follows webhook payload — sender is the new follower, recipient is
		// the IG business account we manage. `normalizeInstagramEvent` must
		// return a `follow` event with `conversation_id` ABSENT so the
		// automations bridge writes `conversation_id = null` on the run.
		const followerId = `igu_${generateId("").slice(-8)}`;
		const msg: InboxQueueMessage = {
			type: "instagram_webhook",
			platform: "instagram",
			platform_account_id: igPlatformAccountId,
			organization_id: orgId,
			account_id: igSocialAccountId,
			event_type: "follows",
			payload: {
				sender: { id: followerId },
				recipient: { id: igPlatformAccountId },
				timestamp: Date.now(),
			},
			received_at: new Date().toISOString(),
		};

		await processInboxEvent(msg, testEnv, db);

		// Pick up the run by automation id (contact id was auto-created by
		// `ensureContactForAuthor`).
		const runs = await db
			.select({
				id: automationRuns.id,
				conversationId: automationRuns.conversationId,
				status: automationRuns.status,
			})
			.from(automationRuns)
			.where(eq(automationRuns.automationId, auto.id));
		expect(runs.length).toBe(1);
		expect(runs[0]!.conversationId).toBeNull();
		// The message-node handler ran (via fake transport).
		expect(sendCalls.some((c) => c.text === "Thanks for the follow!")).toBe(
			true,
		);

		// Because it's a non-persisted event, no inbox conversation / message
		// rows should have been created.
		const inboxConvs = await db
			.select({ id: inboxConversations.id })
			.from(inboxConversations)
			.where(eq(inboxConversations.organizationId, orgId));
		expect(inboxConvs.length).toBe(0);
	}, 45_000);

	it("Facebook follow event enrolls the contact and produces a clean run", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		const auto = await createAutomation({
			name: "np-fb-follow",
			channel: "facebook",
			graph: replyGraph("Welcome!"),
		});
		await db.insert(automationEntrypoints).values({
			automationId: auto.id,
			channel: "facebook" as never,
			kind: "follow" as never,
			status: "active",
			socialAccountId: fbSocialAccountId,
			config: {},
			filters: null,
			specificity: computeSpecificity("follow", {}, null, fbSocialAccountId),
		});

		const followerId = `fbu_${generateId("").slice(-8)}`;
		const msg: InboxQueueMessage = {
			type: "facebook_webhook",
			platform: "facebook",
			platform_account_id: fbPlatformAccountId,
			organization_id: orgId,
			account_id: fbSocialAccountId,
			event_type: "follows",
			payload: {
				sender: { id: followerId },
				recipient: { id: fbPlatformAccountId },
				timestamp: Date.now(),
			},
			received_at: new Date().toISOString(),
		};

		await processInboxEvent(msg, testEnv, db);

		const runs = await db
			.select({
				id: automationRuns.id,
				conversationId: automationRuns.conversationId,
			})
			.from(automationRuns)
			.where(eq(automationRuns.automationId, auto.id));
		expect(runs.length).toBe(1);
		expect(runs[0]!.conversationId).toBeNull();
		expect(sendCalls.some((c) => c.text === "Welcome!")).toBe(true);
	}, 45_000);
});

// ---------------------------------------------------------------------------
// G2: standalone `ad_click` (CTM referral) — same non-persisted path
// ---------------------------------------------------------------------------

describe("G2: standalone ad_click / referral creates a valid run", () => {
	it("Instagram standalone referral enrolls with conversation_id=null", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		const auto = await createAutomation({
			name: "np-ig-adclick",
			channel: "instagram",
			graph: replyGraph("CTM hello"),
		});
		await db.insert(automationEntrypoints).values({
			automationId: auto.id,
			channel: "instagram" as never,
			kind: "ad_click" as never,
			status: "active",
			socialAccountId: igSocialAccountId,
			config: {},
			filters: null,
			specificity: computeSpecificity("ad_click", {}, null, igSocialAccountId),
		});

		const clickerId = `igad_${generateId("").slice(-8)}`;
		const msg: InboxQueueMessage = {
			type: "instagram_webhook",
			platform: "instagram",
			platform_account_id: igPlatformAccountId,
			organization_id: orgId,
			account_id: igSocialAccountId,
			event_type: "referral",
			payload: {
				sender: { id: clickerId },
				recipient: { id: igPlatformAccountId },
				timestamp: Date.now(),
				referral: { ad_id: "ad_123", source: "ADS", type: "OPEN_THREAD" },
			},
			received_at: new Date().toISOString(),
		};

		await processInboxEvent(msg, testEnv, db);

		const runs = await db
			.select({
				id: automationRuns.id,
				conversationId: automationRuns.conversationId,
			})
			.from(automationRuns)
			.where(eq(automationRuns.automationId, auto.id));
		expect(runs.length).toBe(1);
		expect(runs[0]!.conversationId).toBeNull();
		expect(sendCalls.some((c) => c.text === "CTM hello")).toBe(true);

		// Non-persisted: no inbox conversation row produced.
		const inboxConvs = await db
			.select({ id: inboxConversations.id })
			.from(inboxConversations)
			.where(eq(inboxConversations.organizationId, orgId));
		expect(inboxConvs.length).toBe(0);
	}, 45_000);

	it("Facebook standalone referral enrolls with conversation_id=null", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		const auto = await createAutomation({
			name: "np-fb-adclick",
			channel: "facebook",
			graph: replyGraph("FB CTM hello"),
		});
		await db.insert(automationEntrypoints).values({
			automationId: auto.id,
			channel: "facebook" as never,
			kind: "ad_click" as never,
			status: "active",
			socialAccountId: fbSocialAccountId,
			config: {},
			filters: null,
			specificity: computeSpecificity("ad_click", {}, null, fbSocialAccountId),
		});

		const clickerId = `fbad_${generateId("").slice(-8)}`;
		const msg: InboxQueueMessage = {
			type: "facebook_webhook",
			platform: "facebook",
			platform_account_id: fbPlatformAccountId,
			organization_id: orgId,
			account_id: fbSocialAccountId,
			event_type: "referral",
			payload: {
				sender: { id: clickerId },
				recipient: { id: fbPlatformAccountId },
				timestamp: Date.now(),
				referral: { ad_id: "ad_456", source: "ADS", type: "OPEN_THREAD" },
			},
			received_at: new Date().toISOString(),
		};

		await processInboxEvent(msg, testEnv, db);

		const runs = await db
			.select({
				id: automationRuns.id,
				conversationId: automationRuns.conversationId,
			})
			.from(automationRuns)
			.where(eq(automationRuns.automationId, auto.id));
		expect(runs.length).toBe(1);
		expect(runs[0]!.conversationId).toBeNull();
		expect(sendCalls.some((c) => c.text === "FB CTM hello")).toBe(true);
	}, 45_000);
});

// ---------------------------------------------------------------------------
// In-DM `ad_click` regression: `messages` event with ADS referral marker
// must still route with a REAL internal conversation id.
// ---------------------------------------------------------------------------

describe("in-DM ad_click (messages event with referral.source=ADS) keeps a real conversation_id", () => {
	it("IG DM carrying referral marker enrolls with conversation_id pointing at inbox_conversations.id", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		// Disable the earlier G2 IG ad_click entrypoint so this test's
		// entrypoint is the sole candidate. The matcher tie-breaks by
		// `created_at ASC` when specificity+priority are equal, and the G2
		// entrypoint is older — without this gate it would win the match
		// and the assertion on runs scoped to THIS auto.id would fail.
		await db
			.update(automationEntrypoints)
			.set({ status: "disabled" })
			.where(
				and(
					eq(automationEntrypoints.channel, "instagram" as never),
					eq(automationEntrypoints.kind, "ad_click" as never),
					eq(automationEntrypoints.socialAccountId, igSocialAccountId),
				),
			);

		const auto = await createAutomation({
			name: "np-ig-indm-adclick",
			channel: "instagram",
			graph: replyGraph("In-DM ad reply"),
		});
		await db.insert(automationEntrypoints).values({
			automationId: auto.id,
			channel: "instagram" as never,
			kind: "ad_click" as never,
			status: "active",
			socialAccountId: igSocialAccountId,
			config: {},
			filters: null,
			specificity: computeSpecificity("ad_click", {}, null, igSocialAccountId),
		});

		const clickerId = `igindm_${generateId("").slice(-8)}`;
		const msg: InboxQueueMessage = {
			type: "instagram_webhook",
			platform: "instagram",
			platform_account_id: igPlatformAccountId,
			organization_id: orgId,
			account_id: igSocialAccountId,
			event_type: "messages",
			// Meta delivers the ad referral at the top level of the messaging
			// payload (not nested under `message`). `extractMetaMessageMarkers`
			// reads `msg.referral` to detect in-DM CTM clicks.
			payload: {
				sender: { id: clickerId },
				recipient: { id: igPlatformAccountId },
				timestamp: Date.now(),
				message: {
					mid: `mid_${generateId("")}`,
					text: "hi I saw your ad",
				},
				referral: { ad_id: "ad_789", source: "ADS", type: "OPEN_THREAD" },
			},
			received_at: new Date().toISOString(),
		};

		await processInboxEvent(msg, testEnv, db);

		const runs = await db
			.select({
				id: automationRuns.id,
				conversationId: automationRuns.conversationId,
			})
			.from(automationRuns)
			.where(eq(automationRuns.automationId, auto.id));
		expect(runs.length).toBe(1);
		// Must be a real inbox_conversations row reference — NOT null.
		expect(runs[0]!.conversationId).not.toBeNull();
		expect(sendCalls.some((c) => c.text === "In-DM ad reply")).toBe(true);

		// The run's conversation_id points at the inbox_conversations row
		// created by `upsertConversation` for this in-DM click.
		const referencedConv = await db
			.select({
				id: inboxConversations.id,
				accountId: inboxConversations.accountId,
			})
			.from(inboxConversations)
			.where(eq(inboxConversations.id, runs[0]!.conversationId as string));
		expect(referencedConv.length).toBe(1);
		expect(referencedConv[0]!.accountId).toBe(igSocialAccountId);
	}, 45_000);
});

// ---------------------------------------------------------------------------
// G3: `start_automation` forwards socialAccountId to the child run
// ---------------------------------------------------------------------------

describe("G3: start_automation forwards socialAccountId to the child run", () => {
	it("child run's persisted _triggering_social_account_id matches parent's", async () => {
		if (!dbAvailable) return;
		resetSendCalls();

		// Target (child) — plain end so start_automation's enroll is cheap.
		const targetGraph: Graph = {
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
		const target = await createAutomation({
			name: "np-start-target",
			channel: "instagram",
			graph: targetGraph,
		});

		// Source — single start_automation node with pass_context: false so
		// G3's fix (forwarding socialAccountId separately) is the ONLY way the
		// child can learn the triggering account.
		const sourceGraph: Graph = {
			schema_version: 1,
			root_node_key: "sa",
			nodes: [
				{
					key: "sa",
					kind: "start_automation",
					config: {
						target_automation_id: target.id,
						pass_context: false,
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
					from_node: "sa",
					from_port: "next",
					to_node: "stop",
					to_port: "in",
				},
			],
		};
		const source = await createAutomation({
			name: "np-start-source",
			channel: "instagram",
			graph: sourceGraph,
		});

		const [ct] = await db
			.insert(contacts)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "start_automation-parent-contact",
			})
			.returning();
		if (!ct) throw new Error("contact insert failed");

		// Enroll the PARENT with the triggering account pinned. Under the fix
		// the start_automation handler forwards this to the child's
		// enrollContact call, which persists it on context.
		const { runId: parentRunId } = await enrollContact(db, {
			automationId: source.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "instagram",
			entrypointId: null,
			bindingId: null,
			socialAccountId: igSocialAccountId,
			env: { db, sendTransport: fakeSendTransport },
		});

		const parentRun = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, parentRunId),
		});
		expect(parentRun!.status).toBe("completed");

		// The child run is whichever automation-runs row belongs to the
		// target automation for this contact.
		const childRuns = await db
			.select({
				id: automationRuns.id,
				context: automationRuns.context,
			})
			.from(automationRuns)
			.where(
				and(
					eq(automationRuns.automationId, target.id),
					eq(automationRuns.contactId, ct.id),
				),
			);
		expect(childRuns.length).toBe(1);

		const childCtx = (childRuns[0]!.context as Record<string, unknown>) ?? {};
		// The fix: child inherits the triggering social account even when
		// `pass_context: false` means context state isn't carried through.
		expect(childCtx._triggering_social_account_id).toBe(igSocialAccountId);
	}, 45_000);
});
