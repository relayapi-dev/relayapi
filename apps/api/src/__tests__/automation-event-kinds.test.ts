// apps/api/src/__tests__/automation-event-kinds.test.ts
//
// Plan 4 / Unit RR4 / Task 5 — verifies every entrypoint kind that can fire
// from a platform webhook or internal event reaches `matchAndEnrollOrBinding`
// with the expected `event.kind`. Covers:
//   - ad_click / story_reply / story_mention / share_to_dm /
//     live_comment / ref_link_click / tag_applied / tag_removed /
//     field_changed, plus legacy conversion_event rows retained for safe
//     backwards-compatible execution even though new API writes reject them
//   - cycle protection on internal events (tag_add that would retrigger
//     itself must not infinite-loop)

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	automationEntrypoints,
	automationRuns,
	automations,
	contacts,
	createDb,
	customFieldDefinitions,
	customFieldValues,
	generateId,
	socialAccounts,
	workspaces,
} from "@relayapi/db";
import { eq } from "drizzle-orm";
import type { Graph } from "../schemas/automation-graph";
import { dispatchAction } from "../services/automations/actions";
import { matchAndEnrollOrBinding } from "../services/automations/binding-router";
import {
	emitInternalEvent,
	resolveTriggeringSocialAccountId,
} from "../services/automations/internal-events";
import type {
	InboundEvent,
	InboundEventKind,
} from "../services/automations/trigger-matcher";
import {
	deleteOwnedFixtureOrganization,
	deleteOwnedFixtureWorkspaces,
	insertOwnedFixtureOrganization,
} from "./helpers/owned-organization-fixture";

const CONN =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;

const db = CONN
	? createDb(CONN)
	: (null as unknown as ReturnType<typeof createDb>);

let dbAvailable = false;
let orgId = "";
let workspaceId = "";
let socialAccountId = "";

async function seedFixture() {
	orgId = generateId("org_");
	await insertOwnedFixtureOrganization(db, {
		id: orgId,
		name: "event-kinds-org",
		slug: `ek-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({ organizationId: orgId, name: "ek-ws" })
		.returning();
	if (!ws) throw new Error("ws insert failed");
	workspaceId = ws.id;
	const [sa] = await db
		.insert(socialAccounts)
		.values({
			organizationId: orgId,
			workspaceId,
			platform: "instagram",
			platformAccountId: `ig_${generateId("acc_")}`,
			displayName: "Event-kinds IG",
		})
		.returning();
	if (!sa) throw new Error("sa insert failed");
	socialAccountId = sa.id;
}

async function teardownFixture() {
	if (!orgId) return;
	await db
		.delete(automationRuns)
		.where(eq(automationRuns.organizationId, orgId));
	await db.delete(automations).where(eq(automations.organizationId, orgId));
	await db
		.delete(customFieldValues)
		.where(eq(customFieldValues.organizationId, orgId));
	await db
		.delete(customFieldDefinitions)
		.where(eq(customFieldDefinitions.organizationId, orgId));
	await db.delete(contacts).where(eq(contacts.organizationId, orgId));
	await db
		.delete(socialAccounts)
		.where(eq(socialAccounts.organizationId, orgId));
	await deleteOwnedFixtureWorkspaces(db, orgId);
	await deleteOwnedFixtureOrganization(db, orgId);
}

const EMPTY_GRAPH: Graph = {
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

async function makeAutomation(name: string) {
	const [auto] = await db
		.insert(automations)
		.values({
			organizationId: orgId,
			workspaceId,
			name,
			channel: "instagram",
			status: "active",
			graph: EMPTY_GRAPH as never,
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
			name: "event-kind-contact",
		})
		.returning();
	if (!ct) throw new Error("contact insert failed");
	return ct;
}

async function makeEntrypoint(
	automationId: string,
	kind: InboundEventKind | "schedule",
	config: Record<string, unknown> = {},
	socialAccountIdOverride: string | null = socialAccountId,
	specificity = 10,
) {
	const [ep] = await db
		.insert(automationEntrypoints)
		.values({
			organizationId: orgId,
			automationId,
			channel: "instagram",
			kind,
			status: "active",
			socialAccountId: socialAccountIdOverride,
			config,
			specificity,
		})
		.returning();
	if (!ep) throw new Error("entrypoint insert failed");
	return ep;
}

beforeAll(async () => {
	if (!CONN) return;
	try {
		await seedFixture();
		dbAvailable = true;
	} catch (err) {
		console.warn(
			"[automation-event-kinds.test] DB unavailable — tests will skip.",
			err instanceof Error ? err.message : err,
		);
	}
});

afterAll(async () => {
	if (dbAvailable) await teardownFixture();
});

describe("event-kind dispatch", () => {
	const kinds: InboundEventKind[] = [
		"ad_click",
		"story_reply",
		"story_mention",
		"share_to_dm",
		"live_comment",
	];

	for (const kind of kinds) {
		it(`enrolls a contact on ${kind} events`, async () => {
			if (!dbAvailable) return;
			const auto = await makeAutomation(`${kind}-auto`);
			await makeEntrypoint(auto.id, kind);
			const ct = await makeContact();

			const event: InboundEvent = {
				kind,
				channel: "instagram",
				organizationId: orgId,
				socialAccountId,
				contactId: ct.id,
				conversationId: null,
				text: "hi",
				adId: kind === "ad_click" ? undefined : undefined,
			};
			const result = await matchAndEnrollOrBinding(db, event, {});
			expect(result.matched).toBe(true);
			if (result.matched) expect(result.automationId).toBe(auto.id);
		});
	}

	it("enrolls on a ref_link_click internal event", async () => {
		if (!dbAvailable) return;
		const auto = await makeAutomation("ref-auto");
		await makeEntrypoint(auto.id, "ref_link_click", {}, null);
		const ct = await makeContact();

		const event: InboundEvent = {
			kind: "ref_link_click",
			channel: "instagram",
			organizationId: orgId,
			socialAccountId: null,
			contactId: ct.id,
			conversationId: null,
			refUrlId: "ref_abc",
		};
		const result = await matchAndEnrollOrBinding(db, event, {});
		expect(result.matched).toBe(true);
	});

	it("enrolls on a tag_applied internal event", async () => {
		if (!dbAvailable) return;
		const auto = await makeAutomation("tag-applied-auto");
		await makeEntrypoint(auto.id, "tag_applied", {}, null);
		const ct = await makeContact();

		const event: InboundEvent = {
			kind: "tag_applied",
			channel: "instagram",
			organizationId: orgId,
			socialAccountId: null,
			contactId: ct.id,
			conversationId: null,
			tagId: "vip",
		};
		const result = await matchAndEnrollOrBinding(db, event, {});
		expect(result.matched).toBe(true);
	});

	it("enrolls on a field_changed internal event", async () => {
		if (!dbAvailable) return;
		const auto = await makeAutomation("field-changed-auto");
		await makeEntrypoint(
			auto.id,
			"field_changed",
			{ field_keys: ["lead_score"] },
			null,
		);
		const ct = await makeContact();

		const event: InboundEvent = {
			kind: "field_changed",
			channel: "instagram",
			organizationId: orgId,
			socialAccountId: null,
			contactId: ct.id,
			conversationId: null,
			fieldKey: "lead_score",
			fieldValueAfter: 42,
		};
		const result = await matchAndEnrollOrBinding(db, event, {});
		expect(result.matched).toBe(true);
	});

	it("retains matcher compatibility for a legacy conversion_event row", async () => {
		if (!dbAvailable) return;
		const auto = await makeAutomation("conversion-auto");
		await makeEntrypoint(
			auto.id,
			"conversion_event",
			{ event_names: ["purchase"] },
			null,
		);
		const ct = await makeContact();

		const event: InboundEvent = {
			kind: "conversion_event",
			channel: "instagram",
			organizationId: orgId,
			socialAccountId: null,
			contactId: ct.id,
			conversationId: null,
			eventName: "purchase",
			payload: { value: 99, currency: "USD" },
		};
		const result = await matchAndEnrollOrBinding(db, event, {});
		expect(result.matched).toBe(true);
	});
});

describe("internal-event account propagation", () => {
	it("resolves the originating account across inline and resumed run contexts", () => {
		expect(
			resolveTriggeringSocialAccountId({
				env: { socialAccountId: "acc_inline" },
				context: {
					_triggering_social_account_id: "acc_persisted",
					triggerEvent: { socialAccountId: "acc_event" },
				},
			}),
		).toBe("acc_inline");
		expect(
			resolveTriggeringSocialAccountId({
				env: {},
				context: {
					_triggering_social_account_id: "acc_persisted",
					triggerEvent: { socialAccountId: "acc_event" },
				},
			}),
		).toBe("acc_persisted");
		expect(
			resolveTriggeringSocialAccountId({
				env: {},
				context: { triggerEvent: { socialAccountId: "acc_event" } },
			}),
		).toBe("acc_event");
	});

	it("keeps a tag-triggered child run pinned to the source account", async () => {
		if (!dbAvailable) return;

		const listener = await makeAutomation("account-pinned-tag-listener");
		await makeEntrypoint(
			listener.id,
			"tag_applied",
			{ tag_ids: ["account-pinned"] },
			socialAccountId,
			100,
		);
		const ct = await makeContact();

		await dispatchAction(
			{
				id: "account-pinned-tag-action",
				type: "tag_add",
				tag: "account-pinned",
				on_error: "abort",
			} as never,
			{
				runId: "source-account-pinned-run",
				automationId: listener.id,
				organizationId: orgId,
				workspaceId,
				contactId: ct.id,
				conversationId: null,
				channel: "instagram",
				graph: EMPTY_GRAPH,
				context: {
					_triggering_social_account_id: socialAccountId,
				},
				now: new Date(),
				db,
				env: {},
			},
		);

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.contactId, ct.id),
		});
		expect(run?.automationId).toBe(listener.id);
		expect(
			(run?.context as Record<string, unknown> | null)
				?._triggering_social_account_id,
		).toBe(socialAccountId);
	});
});

describe("emitInternalEvent cycle protection", () => {
	it("caps recursion depth when an entrypoint's action emits the same kind", async () => {
		if (!dbAvailable) return;
		// Build an automation whose action_group emits tag_add, and an
		// entrypoint that listens for tag_applied and points back at the same
		// automation. Without cycle protection this would loop forever.
		const graph: Graph = {
			schema_version: 1,
			root_node_key: "tag",
			nodes: [
				{
					key: "tag",
					kind: "action_group",
					config: {
						actions: [
							{
								id: "act_loop",
								type: "tag_add",
								tag: "loop-tag",
								on_error: "continue",
							},
						],
					},
					ports: [],
				},
				{
					key: "stop",
					kind: "end",
					config: { reason: "completed" },
					ports: [{ key: "in", direction: "input" }],
				},
			],
			edges: [
				{ from_node: "tag", from_port: "next", to_node: "stop", to_port: "in" },
			],
		};
		const [auto] = await db
			.insert(automations)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "cycle-auto",
				channel: "instagram",
				status: "active",
				graph: graph as never,
			})
			.returning();
		if (!auto) throw new Error("auto insert failed");

		await makeEntrypoint(auto.id, "tag_applied", {}, null);
		const ct = await makeContact();

		// Directly invoke the tag_add action — its emitInternalEvent should
		// queue exactly one tag_applied event, which enrolls the contact once
		// in the same automation. The second entry then runs tag_add again,
		// which bumps _event_depth and stops at the cap.
		await dispatchAction(
			{
				id: "seed",
				type: "tag_add",
				tag: "loop-tag",
				on_error: "continue",
			} as never,
			{
				runId: "test-run",
				automationId: auto.id,
				organizationId: orgId,
				contactId: ct.id,
				conversationId: null,
				channel: "instagram",
				graph: EMPTY_GRAPH,
				context: {},
				now: new Date(),
				db,
				env: {},
			},
		);

		// Pure assertion: no exception / hang. Also check we didn't spawn a
		// ridiculous number of runs.
		const runs = await db
			.select({ id: automationRuns.id })
			.from(automationRuns)
			.where(eq(automationRuns.contactId, ct.id));
		expect(runs.length).toBeLessThan(20);
	});
});

describe("no-op tag/field mutations skip internal emission", () => {
	it("does not re-enroll a tag_applied listener when tag_add is a no-op", async () => {
		if (!dbAvailable) return;

		// Target automation the listener enrolls into.
		const listener = await makeAutomation("tag-noop-listener");
		await makeEntrypoint(listener.id, "tag_applied", {}, null);

		// Create a contact that already has the tag applied.
		const [ct] = await db
			.insert(contacts)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "noop-contact",
				tags: ["lead"],
			})
			.returning();
		if (!ct) throw new Error("contact insert failed");

		// Re-apply the same tag via the tag_add action — this must be a no-op
		// and NOT enqueue a `tag_applied` internal event.
		await dispatchAction(
			{
				id: "reapply",
				type: "tag_add",
				tag: "lead",
				on_error: "continue",
			} as never,
			{
				runId: "test-run-noop",
				automationId: listener.id,
				organizationId: orgId,
				contactId: ct.id,
				conversationId: null,
				channel: "instagram",
				graph: EMPTY_GRAPH,
				context: {},
				now: new Date(),
				db,
				env: {},
			},
		);

		// No new listener run was created (the pre-condition: tag already there
		// → no emission → no enrollment).
		const runs = await db
			.select({ id: automationRuns.id })
			.from(automationRuns)
			.where(eq(automationRuns.automationId, listener.id));
		expect(runs.length).toBe(0);
	});

	it("does emit on tag_add when the tag was NOT already present", async () => {
		if (!dbAvailable) return;

		const listener = await makeAutomation("tag-new-listener");
		// Scope the entrypoint to only this specific tag and bump specificity
		// so it beats any catch-all tag_applied listeners left behind by
		// earlier tests in this file (the matcher picks the highest-specificity
		// entrypoint, then oldest by created_at as a tiebreaker).
		await makeEntrypoint(
			listener.id,
			"tag_applied",
			{ tag_ids: ["brand-new"] },
			null,
			30,
		);

		const [ct] = await db
			.insert(contacts)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "new-tag-contact",
				tags: [],
			})
			.returning();
		if (!ct) throw new Error("contact insert failed");

		await dispatchAction(
			{
				id: "apply-fresh",
				type: "tag_add",
				tag: "brand-new",
				on_error: "continue",
			} as never,
			{
				runId: "test-run-fresh",
				automationId: listener.id,
				organizationId: orgId,
				contactId: ct.id,
				conversationId: null,
				channel: "instagram",
				graph: EMPTY_GRAPH,
				context: {},
				now: new Date(),
				db,
				env: {},
			},
		);

		const runs = await db
			.select({ id: automationRuns.id })
			.from(automationRuns)
			.where(eq(automationRuns.automationId, listener.id));
		expect(runs.length).toBeGreaterThanOrEqual(1);
	});
});

describe("emitInternalEvent depth guard", () => {
	it("drops events once _event_depth exceeds the max", async () => {
		if (!dbAvailable) return;
		const auto = await makeAutomation("drop-deep-auto");
		await makeEntrypoint(auto.id, "tag_applied", {}, null);
		const ct = await makeContact();

		await emitInternalEvent(
			db,
			{
				kind: "tag_applied",
				channel: "instagram",
				organizationId: orgId,
				socialAccountId: null,
				contactId: ct.id,
				conversationId: null,
				tagId: "deep",
				payload: { _event_depth: 99 },
			},
			{},
		);
		const runs = await db
			.select({ id: automationRuns.id })
			.from(automationRuns)
			.where(eq(automationRuns.automationId, auto.id));
		expect(runs.length).toBe(0);
	});
});
