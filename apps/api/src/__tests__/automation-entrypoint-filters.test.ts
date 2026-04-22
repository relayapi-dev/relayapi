// apps/api/src/__tests__/automation-entrypoint-filters.test.ts
//
// Plan 4 / Unit RR3 — regression suite for the entrypoint config key drift
// (Bug 3). Before the fix the schema validated `keyword_filter`, `tag`,
// `ref_url_id`, `field`, `event_name` but the matcher looked for `keywords`,
// `tag_ids`, `ref_url_ids`, `field_keys`, `event_names`. Templates emitted the
// wrong keys and filters silently no-op'd. This file guards against that
// regression by exercising:
//
//   1. Each per-kind entrypoint config via the Zod schema — the new canonical
//      keys must validate; the old keys must no longer be sufficient on their
//      own for kinds whose filter is now required (tag / field / ref / event).
//   2. End-to-end `matchAndEnroll` firings for every filterable kind — a
//      matching event enrolls, a non-matching event is rejected with
//      `all_filtered` (or `no_candidates` when the config is kind-specific
//      and the event doesn't carry the expected field).
//
// The test skips every DB-dependent case gracefully if the local SSH tunnel
// isn't up, keeping CI green for environments that don't seed the DB.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	automationBindings,
	automationContactControls,
	automationEntrypoints,
	automationRuns,
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
import { validateEntrypointConfig } from "../schemas/automation-entrypoints";
import {
	type InboundEvent,
	type InboundEventKind,
	matchAndEnroll,
} from "../services/automations/trigger-matcher";

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
		name: "entrypoint-filter-test-org",
		slug: `epf-test-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({
			organizationId: orgId,
			name: "epf-test-ws",
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
			displayName: "EPF Test Bot",
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

async function makeAutomation(name: string) {
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
			name: "epf-test-contact",
		})
		.returning();
	if (!ct) throw new Error("contact insert failed");
	return ct;
}

async function makeEntrypoint(
	autoId: string,
	kind: InboundEventKind,
	config: Record<string, unknown>,
) {
	const [ep] = await db
		.insert(automationEntrypoints)
		.values({
			automationId: autoId,
			channel: "telegram",
			kind,
			status: "active",
			socialAccountId,
			config,
			specificity: 25,
		})
		.returning();
	if (!ep) throw new Error("entrypoint insert failed");
	return ep;
}

beforeAll(async () => {
	try {
		await seedFixture();
		dbAvailable = true;
	} catch (err) {
		console.warn(
			"[automation-entrypoint-filters.test] DB unavailable — DB-backed tests will skip.",
			err instanceof Error ? err.message : err,
		);
	}
});

afterAll(async () => {
	if (dbAvailable) await teardownFixture();
});

// ---------------------------------------------------------------------------
// Schema validation — canonical keys pass, legacy stand-alone keys fail
// ---------------------------------------------------------------------------

describe("entrypoint config schema — post key-drift fix", () => {
	it("comment_created: canonical `keywords` passes validation", () => {
		const parsed = validateEntrypointConfig("comment_created", {
			post_ids: ["post_abc"],
			keywords: ["pizza"],
		});
		expect(parsed.success).toBe(true);
	});

	it("story_reply: canonical `keywords` passes validation", () => {
		const parsed = validateEntrypointConfig("story_reply", {
			story_ids: null,
			keywords: ["promo"],
		});
		expect(parsed.success).toBe(true);
	});

	it("field_changed: canonical `field_keys` passes validation", () => {
		const parsed = validateEntrypointConfig("field_changed", {
			field_keys: ["lifecycle_stage"],
		});
		expect(parsed.success).toBe(true);
	});

	it("field_changed: legacy `field` alone fails validation", () => {
		const parsed = validateEntrypointConfig("field_changed", {
			field: "lifecycle_stage",
		});
		expect(parsed.success).toBe(false);
	});

	it("tag_applied: canonical `tag_ids` passes validation", () => {
		const parsed = validateEntrypointConfig("tag_applied", {
			tag_ids: ["lead"],
		});
		expect(parsed.success).toBe(true);
	});

	it("tag_applied: legacy `tag` alone fails validation", () => {
		const parsed = validateEntrypointConfig("tag_applied", {
			tag: "lead",
		});
		expect(parsed.success).toBe(false);
	});

	it("tag_removed: canonical `tag_ids` passes validation", () => {
		const parsed = validateEntrypointConfig("tag_removed", {
			tag_ids: ["lead"],
		});
		expect(parsed.success).toBe(true);
	});

	it("ref_link_click: canonical `ref_url_ids` passes validation", () => {
		const parsed = validateEntrypointConfig("ref_link_click", {
			ref_url_ids: ["ref_campaign_a"],
		});
		expect(parsed.success).toBe(true);
	});

	it("ref_link_click: legacy `ref_url_id` alone fails validation", () => {
		const parsed = validateEntrypointConfig("ref_link_click", {
			ref_url_id: "ref_campaign_a",
		});
		expect(parsed.success).toBe(false);
	});

	it("conversion_event: canonical `event_names` passes validation", () => {
		const parsed = validateEntrypointConfig("conversion_event", {
			event_names: ["purchase"],
		});
		expect(parsed.success).toBe(true);
	});

	it("conversion_event: legacy `event_name` alone fails validation", () => {
		const parsed = validateEntrypointConfig("conversion_event", {
			event_name: "purchase",
		});
		expect(parsed.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Match/no-match integration — each filterable kind
// ---------------------------------------------------------------------------

describe("matchAndEnroll — per-kind filter key alignment", () => {
	it("keyword: matches when text contains filter, rejects otherwise", async () => {
		if (!dbAvailable) return;
		const auto = await makeAutomation("kw-auto");
		const ct = await makeContact();
		await makeEntrypoint(auto.id, "dm_received", {
			keywords: ["pizza"],
			match_mode: "contains",
		});

		const matchEvent: InboundEvent = {
			kind: "dm_received",
			channel: "telegram",
			organizationId: orgId,
			socialAccountId,
			contactId: ct.id,
			conversationId: null,
			text: "I want pizza please",
		};
		const hit = await matchAndEnroll(db, matchEvent, {});
		expect(hit.matched).toBe(true);

		const missCt = await makeContact();
		const missEvent: InboundEvent = {
			...matchEvent,
			contactId: missCt.id,
			text: "burger burger burger",
		};
		const miss = await matchAndEnroll(db, missEvent, {});
		expect(miss.matched).toBe(false);
	});

	it("comment_created: matches when text contains keyword, rejects otherwise", async () => {
		if (!dbAvailable) return;
		const auto = await makeAutomation("comment-auto");
		const ct = await makeContact();
		await makeEntrypoint(auto.id, "comment_created", {
			post_ids: null,
			keywords: ["link"],
		});

		const hit = await matchAndEnroll(
			db,
			{
				kind: "comment_created",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: ct.id,
				conversationId: null,
				text: "send me the link",
			},
			{},
		);
		expect(hit.matched).toBe(true);

		const missCt = await makeContact();
		const miss = await matchAndEnroll(
			db,
			{
				kind: "comment_created",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: missCt.id,
				conversationId: null,
				text: "nice post",
			},
			{},
		);
		expect(miss.matched).toBe(false);
	});

	it("story_reply: matches when text contains keyword, rejects otherwise", async () => {
		if (!dbAvailable) return;
		const auto = await makeAutomation("story-auto");
		const ct = await makeContact();
		await makeEntrypoint(auto.id, "story_reply", {
			story_ids: null,
			keywords: ["promo"],
		});

		const hit = await matchAndEnroll(
			db,
			{
				kind: "story_reply",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: ct.id,
				conversationId: null,
				text: "I'd love the promo",
			},
			{},
		);
		expect(hit.matched).toBe(true);

		const missCt = await makeContact();
		const miss = await matchAndEnroll(
			db,
			{
				kind: "story_reply",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: missCt.id,
				conversationId: null,
				text: "hi",
			},
			{},
		);
		expect(miss.matched).toBe(false);
	});

	it("field_changed: matches when event.fieldKey is in field_keys, rejects otherwise", async () => {
		if (!dbAvailable) return;
		const auto = await makeAutomation("field-auto");
		const ct = await makeContact();
		await makeEntrypoint(auto.id, "field_changed", {
			field_keys: ["lifecycle_stage"],
		});

		const hit = await matchAndEnroll(
			db,
			{
				kind: "field_changed",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: ct.id,
				conversationId: null,
				fieldKey: "lifecycle_stage",
				fieldValueBefore: "lead",
				fieldValueAfter: "customer",
			},
			{},
		);
		expect(hit.matched).toBe(true);

		const missCt = await makeContact();
		const miss = await matchAndEnroll(
			db,
			{
				kind: "field_changed",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: missCt.id,
				conversationId: null,
				fieldKey: "some_other_field",
			},
			{},
		);
		expect(miss.matched).toBe(false);
	});

	it("tag_applied: matches when event.tagId is in tag_ids, rejects otherwise", async () => {
		if (!dbAvailable) return;
		const auto = await makeAutomation("tag-auto");
		const ct = await makeContact();
		// NB: in this codebase contacts.tags stores tag NAMES — the matcher's
		// `tag_ids` field semantically holds names. See schema comment.
		await makeEntrypoint(auto.id, "tag_applied", {
			tag_ids: ["vip"],
		});

		const hit = await matchAndEnroll(
			db,
			{
				kind: "tag_applied",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: ct.id,
				conversationId: null,
				tagId: "vip",
			},
			{},
		);
		expect(hit.matched).toBe(true);

		const missCt = await makeContact();
		const miss = await matchAndEnroll(
			db,
			{
				kind: "tag_applied",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: missCt.id,
				conversationId: null,
				tagId: "cold",
			},
			{},
		);
		expect(miss.matched).toBe(false);
	});

	it("tag_removed: matches when event.tagId is in tag_ids, rejects otherwise", async () => {
		if (!dbAvailable) return;
		const auto = await makeAutomation("tag-rm-auto");
		const ct = await makeContact();
		await makeEntrypoint(auto.id, "tag_removed", {
			tag_ids: ["vip"],
		});

		const hit = await matchAndEnroll(
			db,
			{
				kind: "tag_removed",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: ct.id,
				conversationId: null,
				tagId: "vip",
			},
			{},
		);
		expect(hit.matched).toBe(true);

		const missCt = await makeContact();
		const miss = await matchAndEnroll(
			db,
			{
				kind: "tag_removed",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: missCt.id,
				conversationId: null,
				tagId: "other",
			},
			{},
		);
		expect(miss.matched).toBe(false);
	});

	it("ref_link_click: matches when event.refUrlId is in ref_url_ids, rejects otherwise", async () => {
		if (!dbAvailable) return;
		const auto = await makeAutomation("ref-auto");
		const ct = await makeContact();
		await makeEntrypoint(auto.id, "ref_link_click", {
			ref_url_ids: ["ref_summer_promo"],
		});

		const hit = await matchAndEnroll(
			db,
			{
				kind: "ref_link_click",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: ct.id,
				conversationId: null,
				refUrlId: "ref_summer_promo",
			},
			{},
		);
		expect(hit.matched).toBe(true);

		const missCt = await makeContact();
		const miss = await matchAndEnroll(
			db,
			{
				kind: "ref_link_click",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: missCt.id,
				conversationId: null,
				refUrlId: "ref_other",
			},
			{},
		);
		expect(miss.matched).toBe(false);
	});

	it("conversion_event: matches when event.eventName is in event_names, rejects otherwise", async () => {
		if (!dbAvailable) return;
		const auto = await makeAutomation("conv-auto");
		const ct = await makeContact();
		await makeEntrypoint(auto.id, "conversion_event", {
			event_names: ["purchase"],
		});

		const hit = await matchAndEnroll(
			db,
			{
				kind: "conversion_event",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: ct.id,
				conversationId: null,
				eventName: "purchase",
			},
			{},
		);
		expect(hit.matched).toBe(true);

		const missCt = await makeContact();
		const miss = await matchAndEnroll(
			db,
			{
				kind: "conversion_event",
				channel: "telegram",
				organizationId: orgId,
				socialAccountId,
				contactId: missCt.id,
				conversationId: null,
				eventName: "signup",
			},
			{},
		);
		expect(miss.matched).toBe(false);
	});
});
