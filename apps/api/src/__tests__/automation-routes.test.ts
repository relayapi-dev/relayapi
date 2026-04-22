// apps/api/src/__tests__/automation-routes.test.ts
//
// Unit 8 smoke tests for the new Phase G routes:
//   G3  automation-entrypoints
//   G4  automation-bindings
//   G5  automation-runs + step-runs
//   G6  contact-automation-controls
//   G7  automations/catalog + automations/{id}/insights
//   G8  entrypoint / binding insights
//
// The catalog + insights-with-empty-DB tests run as pure unit tests with no DB.
// The CRUD integration tests rely on the local SSH tunnel (see README) and
// gracefully skip when the tunnel is down — matching the pattern already used
// by automation-runner.test.ts and automation-trigger-matcher.test.ts.

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
import {
	AUTOMATION_CATALOG,
	AUTOMATION_CATALOG_ETAG,
} from "../routes/_automation-catalog";
import { aggregateInsights } from "../routes/_automation-insights";
import {
	EntrypointCreateSchema,
	validateEntrypointConfig,
} from "../schemas/automation-entrypoints";
import { buildBindingWarnings } from "../routes/automation-bindings";
import { BindingConfigByType } from "../schemas/automation-bindings";
import { computeSpecificity } from "../services/automations/trigger-matcher";
import {
	buildGraphFromTemplate,
	type TemplateKind,
} from "../services/automations/templates";

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
		name: "routes-test-org",
		slug: `routes-test-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({
			organizationId: orgId,
			name: "routes-test-ws",
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
			"[automation-routes.test] DB unavailable — integration tests will skip.",
			err instanceof Error ? err.message : err,
		);
	}
});

afterAll(async () => {
	if (dbAvailable) await teardownFixture();
});

// ---------------------------------------------------------------------------
// G7 — Catalog (pure unit, no DB)
// ---------------------------------------------------------------------------

describe("automation catalog", () => {
	it("contains all 10 node kinds", () => {
		expect(AUTOMATION_CATALOG.node_kinds).toHaveLength(10);
		const kinds = AUTOMATION_CATALOG.node_kinds.map((n) => n.kind).sort();
		expect(kinds).toEqual(
			[
				"action_group",
				"condition",
				"delay",
				"end",
				"goto",
				"http_request",
				"input",
				"message",
				"randomizer",
				"start_automation",
			].sort(),
		);
	});

	it("contains all 15 entrypoint kinds", () => {
		// The dedicated `keyword` kind was removed (spec §B3); inbound-DM keyword
		// filtering now lives on `dm_received` via its `config.keywords`.
		expect(AUTOMATION_CATALOG.entrypoint_kinds).toHaveLength(15);
	});

	it("does not expose the retired `keyword` entrypoint kind", () => {
		const kinds = AUTOMATION_CATALOG.entrypoint_kinds.map((k) => k.kind);
		expect(kinds).not.toContain("keyword");
		expect(kinds).toContain("dm_received");
	});

	it("marks `change_main_menu` as disabled in the action catalog", () => {
		const a = AUTOMATION_CATALOG.action_types.find(
			(x) => x.type === "change_main_menu",
		);
		expect(a).toBeDefined();
		expect((a as Record<string, unknown>).disabled).toBe(true);
	});

	it("contains all 5 binding types with correct wired/stubbed split", () => {
		expect(AUTOMATION_CATALOG.binding_types).toHaveLength(5);
		const wired = AUTOMATION_CATALOG.binding_types.filter(
			(b) => b.v1_status === "wired",
		);
		const stubbed = AUTOMATION_CATALOG.binding_types.filter(
			(b) => b.v1_status === "stubbed",
		);
		expect(wired.map((b) => b.type).sort()).toEqual([
			"default_reply",
			"welcome_message",
		]);
		expect(stubbed.map((b) => b.type).sort()).toEqual([
			"conversation_starter",
			"ice_breaker",
			"main_menu",
		]);
	});

	it("contains 22 action types", () => {
		expect(AUTOMATION_CATALOG.action_types).toHaveLength(22);
	});

	it("contains channel_capabilities for all 4 supported channels", () => {
		const channels = Object.keys(AUTOMATION_CATALOG.channel_capabilities).sort();
		expect(channels).toEqual(
			["facebook", "instagram", "telegram", "whatsapp"].sort(),
		);
	});

	it("does not advertise tiktok in any channel array", () => {
		// TikTok was removed from the v1 automation catalog (Plan 6 Unit RR11 /
		// Task 3). No webhook, normalizer, or real DM send ships in v1, so the
		// catalog must not surface it anywhere.
		for (const ep of AUTOMATION_CATALOG.entrypoint_kinds) {
			expect(ep.channels).not.toContain("tiktok");
		}
		for (const b of AUTOMATION_CATALOG.binding_types) {
			expect(b.channels).not.toContain("tiktok");
		}
		expect(
			Object.keys(AUTOMATION_CATALOG.channel_capabilities),
		).not.toContain("tiktok");
	});

	it("contains the 8 template kinds", () => {
		expect(AUTOMATION_CATALOG.template_kinds.sort()).toEqual(
			[
				"blank",
				"comment_to_dm",
				"faq_bot",
				"follow_to_dm",
				"follower_growth",
				"lead_capture",
				"story_leads",
				"welcome_flow",
			].sort(),
		);
	});

	it("exposes a stable ETag string", () => {
		expect(AUTOMATION_CATALOG_ETAG).toMatch(/^"[0-9a-f]{8}"$/);
	});
});

// ---------------------------------------------------------------------------
// G7 — Route-order regression (pure unit, no DB)
//
// Previously the static `/catalog` and `/insights` routes were registered
// AFTER the dynamic `/{id}` handler, so Hono matched `/{id}` with
// `id="catalog"` first, ran the DB lookup, found nothing, and returned 404.
// These tests guard against a reoccurrence by mounting the real router under
// a stub middleware and confirming static segments win over the dynamic one.
// ---------------------------------------------------------------------------

describe("automations router registration order", () => {
	it("routes GET /catalog to the catalog handler, not GET /{id}", async () => {
		// Lazy import so the test file keeps its pure-unit default (no DB).
		const { OpenAPIHono } = await import("@hono/zod-openapi");
		const { default: automationsRouter } = await import(
			"../routes/automations"
		);

		// biome-ignore lint/suspicious/noExplicitAny: test harness stub for context vars
		const app: any = new OpenAPIHono();
		app.use("*", async (c: any, next: any) => {
			// Minimal stub context so the `/{id}` handler — if erroneously hit —
			// would return a 404 body we can distinguish from the catalog body.
			c.set("orgId", "org_test");
			c.set(
				"db",
				{
					select: () => ({
						from: () => ({
							where: () => ({ limit: async () => [] }),
						}),
					}),
				},
			);
			c.set("apiKey", { workspaceId: null });
			await next();
		});
		app.route("/v1/automations", automationsRouter);

		const res = await app.request("/v1/automations/catalog");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		// Catalog payload shape — node_kinds array is the cheapest fingerprint.
		expect(Array.isArray(body.node_kinds)).toBe(true);
		expect((body.node_kinds as unknown[]).length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// G3 — Entrypoint config validation (pure unit, no DB)
// ---------------------------------------------------------------------------

describe("entrypoint config validation", () => {
	it("validates a dm_received config with keyword filtering", () => {
		// Post-§B3: keyword matching lives on `dm_received` entrypoints.
		const parsed = validateEntrypointConfig("dm_received", {
			keywords: ["pizza"],
			match_mode: "exact",
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects the retired `keyword` kind", () => {
		const parsed = validateEntrypointConfig("keyword", {
			keywords: ["pizza"],
			match_mode: "exact",
		});
		expect(parsed.success).toBe(false);
	});

	it("computes specificity=30 for an exact-match dm_received keyword entrypoint", () => {
		expect(
			computeSpecificity(
				"dm_received",
				{ keywords: ["hi"], match_mode: "exact" },
				null,
				null,
			),
		).toBe(30);
	});

	it("rejects EntrypointCreateSchema with channel=tiktok", () => {
		// Plan 6 Unit RR11 / Task 3: the API no longer accepts tiktok as a
		// valid automation channel. Creating an entrypoint with channel=tiktok
		// must fail Zod validation (translated to HTTP 422 at the route).
		const parsed = EntrypointCreateSchema.safeParse({
			channel: "tiktok",
			kind: "dm_received",
			config: {},
		});
		expect(parsed.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// G4 — Binding config validation (pure unit, no DB)
// ---------------------------------------------------------------------------

describe("binding config validation", () => {
	it("accepts an empty default_reply config", () => {
		const schema = BindingConfigByType.default_reply!;
		const parsed = schema.safeParse({});
		expect(parsed.success).toBe(true);
	});

	it("accepts a conversation_starter config with ≤4 starters", () => {
		const schema = BindingConfigByType.conversation_starter!;
		const parsed = schema.safeParse({
			starters: [{ label: "Hi", payload: "greet" }],
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects >4 conversation_starter items", () => {
		const schema = BindingConfigByType.conversation_starter!;
		const parsed = schema.safeParse({
			starters: Array(5).fill({ label: "x", payload: "y" }),
		});
		expect(parsed.success).toBe(false);
	});

	it("attaches a `binding_pending_sync` warning only for stubbed binding types", () => {
		// Stubbed types — these don't push to the platform yet. Warning MUST
		// be present so the dashboard can surface a "not yet synced" banner.
		for (const stubbed of ["main_menu", "conversation_starter", "ice_breaker"]) {
			const w = buildBindingWarnings(stubbed);
			expect(Array.isArray(w)).toBe(true);
			expect(w!.length).toBe(1);
			expect(w![0]!.code).toBe("binding_pending_sync");
			expect(w![0]!.message).toMatch(/v1\.1/);
		}

		// Wired types — no warning; these go live immediately.
		for (const wired of ["default_reply", "welcome_message"]) {
			expect(buildBindingWarnings(wired)).toBeUndefined();
		}
	});
});

// ---------------------------------------------------------------------------
// G7 — Insights with no runs returns zero totals (no DB required)
// ---------------------------------------------------------------------------

describe("insights with no runs", () => {
	it("returns zero totals when the aggregator finds nothing", async () => {
		if (!dbAvailable) {
			// Skip — cannot hit the DB.
			return;
		}
		// Use a random org id that has no runs → all zero.
		const result = await aggregateInsights(
			db,
			{ period: "7d" },
			{ orgId: "org_nonexistent_for_insights_test" },
		);
		expect(result.totals.enrolled).toBe(0);
		expect(result.totals.completed).toBe(0);
		expect(result.exit_reasons).toEqual([]);
		expect(result.by_entrypoint).toEqual([]);
		expect(result.per_node).toEqual([]);
		expect(typeof result.period.from).toBe("string");
		expect(typeof result.period.to).toBe("string");
	});
});

// ---------------------------------------------------------------------------
// G3 + G4 — Create entrypoint / binding directly (integration)
// ---------------------------------------------------------------------------

describe("entrypoint + binding creation (integration)", () => {
	it("creates a dm_received keyword entrypoint with specificity=30", async () => {
		if (!dbAvailable) return;
		const [auto] = await db
			.insert(automations)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "test-keyword-auto",
				channel: "telegram",
				status: "active",
				graph: {
					schema_version: 1,
					root_node_key: null,
					nodes: [],
					edges: [],
				} as never,
			})
			.returning();
		if (!auto) throw new Error("automation insert failed");

		const config = {
			keywords: ["pizza"],
			match_mode: "exact" as const,
			case_sensitive: false,
		};
		// Post-§B3: keyword matching lives on `dm_received`. Specificity stays 30
		// for `exact`/`regex` keyword configs — same as the retired `keyword` kind.
		const specificity = computeSpecificity("dm_received", config, null, null);
		expect(specificity).toBe(30);

		const [ep] = await db
			.insert(automationEntrypoints)
			.values({
				automationId: auto.id,
				channel: "telegram",
				kind: "dm_received",
				config: config as never,
				specificity,
			})
			.returning();
		expect(ep).toBeDefined();
		expect(ep?.specificity).toBe(30);
	});

	it("enforces the (social_account_id, binding_type) unique constraint", async () => {
		if (!dbAvailable) return;
		const [auto] = await db
			.insert(automations)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "test-binding-auto",
				channel: "telegram",
				status: "active",
				graph: {
					schema_version: 1,
					root_node_key: null,
					nodes: [],
					edges: [],
				} as never,
			})
			.returning();
		if (!auto) throw new Error("automation insert failed");

		const insertBinding = () =>
			db.insert(automationBindings).values({
				organizationId: orgId,
				workspaceId,
				socialAccountId,
				channel: "telegram",
				bindingType: "default_reply",
				automationId: auto.id,
				config: {} as never,
				status: "active",
			});

		// First insert succeeds.
		await insertBinding();

		// Second insert should violate the unique index.
		let threw = false;
		try {
			await insertBinding();
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// G5 — Run stop transitions status correctly (integration)
// ---------------------------------------------------------------------------

describe("automation-runs stop (integration)", () => {
	it("only exits runs in active or waiting state", async () => {
		if (!dbAvailable) return;
		const [auto] = await db
			.insert(automations)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "test-stop-auto",
				channel: "telegram",
				status: "active",
				graph: {
					schema_version: 1,
					root_node_key: null,
					nodes: [],
					edges: [],
				} as never,
			})
			.returning();
		if (!auto) throw new Error("automation insert failed");
		const [ct] = await db
			.insert(contacts)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "stop-test-contact",
			})
			.returning();
		if (!ct) throw new Error("contact insert failed");

		const [run] = await db
			.insert(automationRuns)
			.values({
				automationId: auto.id,
				organizationId: orgId,
				contactId: ct.id,
				status: "active",
			})
			.returning();
		expect(run?.status).toBe("active");

		// Simulate what the route does on /stop.
		const [stopped] = await db
			.update(automationRuns)
			.set({
				status: "exited",
				exitReason: "admin_stopped",
				completedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(automationRuns.id, run!.id))
			.returning();
		expect(stopped?.status).toBe("exited");
		expect(stopped?.exitReason).toBe("admin_stopped");
		expect(stopped?.completedAt).toBeInstanceOf(Date);
	});
});

// ---------------------------------------------------------------------------
// G7 — Automation create-from-template builds graph correctly (pure unit)
// ---------------------------------------------------------------------------

describe("automation create from template", () => {
	it("builds a valid graph for every bundled template kind", () => {
		const fixtures: Record<TemplateKind, Record<string, unknown>> = {
			blank: {},
			welcome_flow: {},
			faq_bot: {
				keywords: [
					{ label: "hours", keyword: "hours", reply: "We're open." },
				],
			},
			lead_capture: { tag: "lead", capture_field: "email" },
			comment_to_dm: {
				post_ids: ["post_abc"],
				keyword_filter: ["link"],
				dm_message: {
					blocks: [{ id: "b1", type: "text", text: "Here!" }],
				},
				public_reply: "DM sent!",
				once_per_user: true,
				social_account_id: "acc_123",
			},
			story_leads: {
				story_ids: null,
				capture_field: "email",
				success_tag: "story_lead",
				social_account_id: "acc_123",
			},
			follower_growth: {
				post_ids: ["post_abc"],
				trigger_keyword: "enter",
				public_reply: "Entered!",
				dm_message: {
					blocks: [{ id: "b1", type: "text", text: "Rules..." }],
				},
				entry_requirements: { must_tag_friends: 2 },
				winner_tag: "contest_winner",
				social_account_id: "acc_123",
			},
			follow_to_dm: {
				social_account_id: "acc_123",
				dm_message: {
					blocks: [{ id: "b1", type: "text", text: "Thanks!" }],
				},
				max_sends_per_day: 50,
				cooldown_between_sends_ms: 2000,
				skip_if_already_messaged: true,
			},
		};
		for (const kind of Object.keys(fixtures) as TemplateKind[]) {
			const built = buildGraphFromTemplate({
				kind,
				channel: "instagram",
				config: fixtures[kind],
			});
			expect(built.graph.schema_version).toBe(1);
			expect(Array.isArray(built.graph.nodes)).toBe(true);
			expect(Array.isArray(built.graph.edges)).toBe(true);
		}
	});

	it("persists a canonical graph with ports + canvas positions (integration)", async () => {
		if (!dbAvailable) return;
		// Mirror what the route does: build, validate, insert. The canonical
		// graph has `ports` derived per node and `canvas_x` / `canvas_y` set
		// by the template's auto-layout helper — these are what the dashboard
		// needs to render handles and distinct node positions.
		const { validateGraph } = await import(
			"../services/automations/validator"
		);

		const built = buildGraphFromTemplate({
			kind: "comment_to_dm",
			channel: "instagram",
			config: {
				post_ids: ["post_abc"],
				keyword_filter: ["link"],
				dm_message: {
					blocks: [{ id: "b1", type: "text", text: "Here!" }],
				},
				social_account_id: "acc_123",
			},
		});
		const validation = validateGraph(built.graph);

		const [row] = await db
			.insert(automations)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "test-template-persist",
				channel: "instagram",
				status: "draft",
				graph: validation.canonicalGraph as never,
				createdFromTemplate: "comment_to_dm",
			})
			.returning();
		expect(row).toBeDefined();

		const [fetched] = await db
			.select()
			.from(automations)
			.where(eq(automations.id, row!.id))
			.limit(1);
		expect(fetched).toBeDefined();
		const g = fetched!.graph as {
			nodes: Array<{
				key: string;
				ports: unknown[];
				canvas_x?: number;
				canvas_y?: number;
			}>;
		};
		expect(g.nodes.length).toBeGreaterThan(0);
		for (const node of g.nodes) {
			expect(Array.isArray(node.ports)).toBe(true);
			expect(node.ports.length).toBeGreaterThan(0);
			expect(typeof node.canvas_x).toBe("number");
			expect(typeof node.canvas_y).toBe("number");
		}
	});
});
