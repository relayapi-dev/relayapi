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
	BindingConfigByType,
	BindingCreateSchema,
	BindingUpdateSchema,
} from "../schemas/automation-bindings";
import {
	EntrypointCreateSchema,
	validateEntrypointConfig,
} from "../schemas/automation-entrypoints";
import {
	buildGraphFromTemplate,
	type TemplateKind,
} from "../services/automations/templates";
import { computeSpecificity } from "../services/automations/trigger-matcher";
import {
	deleteOwnedFixtureOrganization,
	deleteOwnedFixtureWorkspaces,
	insertOwnedFixtureOrganization,
} from "./helpers/owned-organization-fixture";
import { protectedContactFixture } from "./helpers/protected-contact-fixtures";

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
	await db
		.delete(automationRuns)
		.where(eq(automationRuns.organizationId, orgId));
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
	await deleteOwnedFixtureWorkspaces(db, orgId);
	await deleteOwnedFixtureOrganization(db, orgId);
}

beforeAll(async () => {
	if (!CONN) return;
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
	it("contains all 12 implemented node kinds", () => {
		expect(AUTOMATION_CATALOG.node_kinds).toHaveLength(12);
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
				"social_profile_check",
				"wait_event",
			].sort(),
		);
	});

	it("contains all 14 publicly creatable entrypoint kinds", () => {
		// The dedicated `keyword` kind was removed (spec §B3); inbound-DM keyword
		// filtering now lives on `dm_received` via its `config.keywords`.
		expect(AUTOMATION_CATALOG.entrypoint_kinds).toHaveLength(14);
	});

	it("does not expose the retired `keyword` entrypoint kind", () => {
		const kinds = AUTOMATION_CATALOG.entrypoint_kinds.map((k) => k.kind);
		expect(kinds).not.toContain("keyword");
		expect(kinds).not.toContain("follow");
		expect(kinds).toContain("dm_received");
		expect(kinds).toContain("conversion_event");
	});

	it("exposes the implemented Facebook `change_main_menu` action", () => {
		const action = AUTOMATION_CATALOG.action_types.find(
			(x) => x.type === "change_main_menu",
		) as Record<string, unknown> | undefined;
		expect(action?.channels).toEqual(["facebook"]);
	});

	it("exposes direct and provider-synchronized binding types", () => {
		expect(AUTOMATION_CATALOG.binding_types).toHaveLength(5);
		expect(AUTOMATION_CATALOG.binding_types.map((b) => b.type).sort()).toEqual([
			"default_reply",
			"get_started",
			"ice_breaker",
			"main_menu",
			"welcome_message",
		]);
		expect(
			AUTOMATION_CATALOG.binding_types
				.filter((binding) => binding.v1_status === "provider_synced")
				.map((binding) => binding.type)
				.sort(),
		).toEqual(["get_started", "ice_breaker", "main_menu"]);
	});

	it("exposes durable conversion logging", () => {
		const action = AUTOMATION_CATALOG.action_types.find(
			(x) => x.type === "log_conversion_event",
		) as Record<string, unknown> | undefined;
		expect(action).toBeDefined();
		expect(action?.disabled).not.toBe(true);
	});

	it("contains 24 action types", () => {
		expect(AUTOMATION_CATALOG.action_types).toHaveLength(24);
	});

	it("contains channel_capabilities for all 4 supported channels", () => {
		const channels = Object.keys(
			AUTOMATION_CATALOG.channel_capabilities,
		).sort();
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
		expect(Object.keys(AUTOMATION_CATALOG.channel_capabilities)).not.toContain(
			"tiktok",
		);
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
		// biome-ignore lint/suspicious/noExplicitAny: test harness middleware stub sets loosely-typed context vars
		app.use("*", async (c: any, next: any) => {
			// Minimal stub context so the `/{id}` handler — if erroneously hit —
			// would return a 404 body we can distinguish from the catalog body.
			c.set("orgId", "org_test");
			c.set("db", {
				select: () => ({
					from: () => ({
						where: () => ({ limit: async () => [] }),
					}),
				}),
			});
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

	it("rejects an entrypoint kind that cannot execute on the selected channel", () => {
		const parsed = EntrypointCreateSchema.safeParse({
			channel: "facebook",
			kind: "share_to_dm",
			config: {},
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects schedules the runtime cannot arm", () => {
		expect(
			validateEntrypointConfig("schedule", {
				cron: "0 9 * * 1",
				timezone: "UTC",
			}).success,
		).toBe(false);
		expect(
			validateEntrypointConfig("schedule", {
				cron: "0 9 * * *",
				timezone: "Not/A_Real_Zone",
			}).success,
		).toBe(false);
	});

	it("accepts the scheduler's supported cron subset", () => {
		for (const cron of ["0 9 * * *", "0 * * * *", "*/15 * * * *"]) {
			expect(
				validateEntrypointConfig("schedule", {
					cron,
					timezone: "Europe/London",
				}).success,
			).toBe(true);
		}
	});

	it("rejects unknown keys instead of silently persisting inert config", () => {
		expect(
			validateEntrypointConfig("story_mention", { keyword: "legacy" }).success,
		).toBe(false);
		expect(
			validateEntrypointConfig("comment_created", {
				post_ids: null,
				keyword_filter: ["legacy"],
			}).success,
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// G4 — Binding config validation (pure unit, no DB)
// ---------------------------------------------------------------------------

describe("binding config validation", () => {
	it("accepts an empty default_reply config", () => {
		const schema = BindingConfigByType.default_reply;
		if (!schema) throw new Error("expected default_reply schema");
		const parsed = schema.safeParse({});
		expect(parsed.success).toBe(true);
	});

	it("accepts all direct and provider-synchronized binding types", () => {
		const supported = [
			["default_reply", {}],
			["welcome_message", {}],
			["get_started", { payload: "GET_STARTED" }],
			[
				"main_menu",
				{
					items: [{ label: "Help", action: "postback", payload: "HELP" }],
				},
			],
			[
				"ice_breaker",
				{ questions: [{ question: "How can I order?", payload: "ORDER" }] },
			],
		] as const;
		for (const [bindingType, config] of supported) {
			const parsed = BindingCreateSchema.safeParse({
				social_account_id: "acc_1",
				channel: "facebook",
				binding_type: bindingType,
				automation_id: "auto_1",
				config,
			});
			expect(parsed.success).toBe(true);
			expect(BindingConfigByType[bindingType]?.safeParse(config).success).toBe(
				true,
			);
		}
	});

	it("accepts the documented 20-item Messenger persistent-menu limit", () => {
		const items = Array.from({ length: 20 }, (_, index) => ({
			label: `Menu ${index + 1}`,
			action: "postback" as const,
			payload: `MENU_${index + 1}`,
		}));
		expect(BindingConfigByType.main_menu?.safeParse({ items }).success).toBe(
			true,
		);
		expect(
			BindingConfigByType.main_menu?.safeParse({
				items: [
					...items,
					{ label: "Too many", action: "postback", payload: "X" },
				],
			}).success,
		).toBe(false);
	});

	it("rejects the retired conversation_starter binding type", () => {
		expect(
			BindingCreateSchema.safeParse({
				social_account_id: "acc_1",
				channel: "facebook",
				binding_type: "conversation_starter",
				automation_id: "auto_1",
				config: {},
			}).success,
		).toBe(false);
	});

	it("rejects platform-sync-only binding statuses", () => {
		expect(
			BindingUpdateSchema.safeParse({ status: "pending_sync" }).success,
		).toBe(false);
		expect(
			BindingUpdateSchema.safeParse({ status: "sync_failed" }).success,
		).toBe(false);
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
				organizationId: orgId,
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
				totalEnrolled: 1,
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
			.values(await protectedContactFixture({
				organizationId: orgId,
				workspaceId,
				name: "stop-test-contact",
			}))
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
		if (!run) throw new Error("expected run to exist");

		const { OpenAPIHono } = await import("@hono/zod-openapi");
		const { default: automationRunsRouter } = await import(
			"../routes/automation-runs"
		);
		// biome-ignore lint/suspicious/noExplicitAny: route harness context is intentionally minimal
		const routeApp: any = new OpenAPIHono();
		// biome-ignore lint/suspicious/noExplicitAny: route harness context is intentionally minimal
		routeApp.use("*", async (c: any, next: any) => {
			c.set("orgId", orgId);
			c.set("db", db);
			c.set("workspaceScope", "all");
			await next();
		});
		routeApp.route("/v1/automation-runs", automationRunsRouter);

		const response = await routeApp.request(
			`/v1/automation-runs/${run.id}/stop`,
			{ method: "POST" },
		);
		expect(response.status).toBe(200);
		const stopped = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, run.id),
		});
		expect(stopped?.status).toBe("exited");
		expect(stopped?.exitReason).toBe("admin_stopped");
		expect(stopped?.completedAt).toBeInstanceOf(Date);

		const repeated = await routeApp.request(
			`/v1/automation-runs/${run.id}/stop`,
			{ method: "POST" },
		);
		expect(repeated.status).toBe(422);
		const autoAfter = await db.query.automations.findFirst({
			where: eq(automations.id, auto.id),
		});
		expect(autoAfter?.totalExited).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// G7 — Automation create-from-template builds graph correctly (pure unit)
// ---------------------------------------------------------------------------

describe("automation create from template", () => {
	it("rejects a template account from the wrong channel", async () => {
		if (!dbAvailable) return;
		const { OpenAPIHono } = await import("@hono/zod-openapi");
		const { default: automationsRouter } = await import(
			"../routes/automations"
		);
		// biome-ignore lint/suspicious/noExplicitAny: route harness context is intentionally minimal
		const routeApp: any = new OpenAPIHono();
		// biome-ignore lint/suspicious/noExplicitAny: route harness context is intentionally minimal
		routeApp.use("*", async (c: any, next: any) => {
			c.set("orgId", orgId);
			c.set("db", db);
			c.set("workspaceScope", "all");
			await next();
		});
		routeApp.route("/v1/automations", automationsRouter);

		// The fixture account is Telegram. Binding it to an Instagram preset must
		// fail before the automation or generated entrypoint is persisted.
		const response = await routeApp.request("/v1/automations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "Wrong-channel preset",
				channel: "instagram",
				workspace_id: workspaceId,
				template: {
					kind: "comment_to_dm",
					config: {
						social_account_id: socialAccountId,
						dm_message: {
							blocks: [{ id: "reply", type: "text", text: "Hello" }],
						},
					},
				},
			}),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "INVALID_ACCOUNT" },
		});
	});

	it("builds a valid graph for every bundled template kind", () => {
		const fixtures: Record<TemplateKind, Record<string, unknown>> = {
			blank: {},
			welcome_flow: {},
			faq_bot: {
				keywords: [{ label: "hours", keyword: "hours", reply: "We're open." }],
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
		const { validateGraph } = await import("../services/automations/validator");

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
		if (!row) throw new Error("expected row to exist");

		const [fetched] = await db
			.select()
			.from(automations)
			.where(eq(automations.id, row.id))
			.limit(1);
		expect(fetched).toBeDefined();
		if (!fetched) throw new Error("expected fetched to exist");
		const g = fetched.graph as {
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
