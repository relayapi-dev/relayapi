import { describe, expect, it, spyOn } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { workspaceScopeMiddleware } from "../middleware/permissions";
import { collectWorkspaceIds } from "../middleware/workspace-validation";
import adsRouter from "../routes/ads";
import autoPostRouter from "../routes/auto-post-rules";
import broadcastsRouter from "../routes/broadcasts";
import customFieldsRouter from "../routes/custom-fields";
import mediaRouter from "../routes/media";
import queueRouter from "../routes/queue";
import { enrollContact } from "../services/automations/runner";
import { resolveTargets } from "../services/target-resolver";
import type { Env, Variables } from "../types";

type TenantRow = {
	id: string;
	organizationId: string;
	workspaceId: string | null;
	status?: string;
};

function sqlReferencesColumn(value: unknown, column: string): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { name?: unknown; queryChunks?: unknown[] };
	if (candidate.name === column) return true;
	return (
		candidate.queryChunks?.some((chunk) =>
			sqlReferencesColumn(chunk, column),
		) ?? false
	);
}

function sqlHasParam(value: unknown, param: string): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { value?: unknown; queryChunks?: unknown[] };
	if (candidate.value === param) return true;
	return (
		candidate.queryChunks?.some((chunk) => sqlHasParam(chunk, param)) ?? false
	);
}

/**
 * Minimal Drizzle SELECT stub. It deliberately returns a foreign-org row when
 * the query omits organization_id, so each cross-org test fails if a route ever
 * regresses to an id-only lookup.
 */
function tenantSelectDb(row: TenantRow) {
	let condition: unknown;
	// biome-ignore lint/suspicious/noExplicitAny: focused chainable Drizzle stub
	const chain: any = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: (next: unknown) => {
			condition = next;
			return chain;
		},
		orderBy: () => chain,
		limit: async () => {
			if (
				sqlReferencesColumn(condition, "organization_id") &&
				!sqlHasParam(condition, row.organizationId)
			) {
				return [];
			}
			return [row];
		},
	};
	return chain;
}

function makeRouteApp(
	router: typeof adsRouter,
	row: TenantRow,
	workspaceScope: "all" | string[],
	organizationId = "org_a",
) {
	const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
	// The focused DB stub intentionally implements only the authorization read.
	// Once a permitted route reaches later persistence/provider work, convert that
	// expected stub boundary into a non-auth response without noisy error logging.
	app.onError((_error, c) =>
		c.json({ error: { code: "AUTHORIZED_ROUTE_CONTINUED" } }, 418),
	);
	app.use("*", async (c, next) => {
		c.set("orgId", organizationId);
		c.set("workspaceScope", workspaceScope);
		// biome-ignore lint/suspicious/noExplicitAny: route-isolation DB stub
		c.set("db", tenantSelectDb(row) as any);
		await next();
	});
	app.route("/", router);
	return app;
}

type RouteCase = {
	name: string;
	router: typeof adsRouter;
	path: string;
	method?: string;
	body?: unknown;
	allWorkspaceOnly?: boolean;
};

const routeMatrix: RouteCase[] = [
	{ name: "broadcast get", router: broadcastsRouter, path: "/bc_1" },
	{
		name: "broadcast update",
		router: broadcastsRouter,
		path: "/bc_1",
		method: "PATCH",
		body: { name: "Updated" },
	},
	{
		name: "broadcast add recipients",
		router: broadcastsRouter,
		path: "/bc_1/recipients",
		method: "POST",
		body: { phones: ["+15551234567"] },
	},
	{
		name: "broadcast list recipients",
		router: broadcastsRouter,
		path: "/bc_1/recipients",
	},
	{
		name: "broadcast send",
		router: broadcastsRouter,
		path: "/bc_1/send",
		method: "POST",
	},
	{
		name: "broadcast schedule",
		router: broadcastsRouter,
		path: "/bc_1/schedule",
		method: "POST",
		body: { scheduled_at: "2030-01-01T00:00:00Z" },
	},
	{
		name: "broadcast cancel",
		router: broadcastsRouter,
		path: "/bc_1/cancel",
		method: "POST",
	},
	{ name: "auto-post get", router: autoPostRouter, path: "/apr_1" },
	{
		name: "auto-post update",
		router: autoPostRouter,
		path: "/apr_1",
		method: "PATCH",
		body: { name: "Updated" },
	},
	{
		name: "auto-post activate",
		router: autoPostRouter,
		path: "/apr_1/activate",
		method: "POST",
	},
	{
		name: "auto-post pause",
		router: autoPostRouter,
		path: "/apr_1/pause",
		method: "POST",
	},
	{
		name: "custom-field update",
		router: customFieldsRouter,
		path: "/cfd_1",
		method: "PATCH",
		body: { name: "Updated" },
		allWorkspaceOnly: true,
	},
	{ name: "media get", router: mediaRouter, path: "/med_1" },
	{
		name: "media delete",
		router: mediaRouter,
		path: "/med_1",
		method: "DELETE",
	},
	{
		name: "campaign update",
		router: adsRouter,
		path: "/campaigns/camp_1",
		method: "PATCH",
		body: { status: "paused" },
	},
	{
		name: "campaign delete",
		router: adsRouter,
		path: "/campaigns/camp_1",
		method: "DELETE",
	},
	{ name: "ad analytics", router: adsRouter, path: "/ad_1/analytics" },
	{ name: "audience get", router: adsRouter, path: "/audiences/aud_1" },
	{
		name: "audience users",
		router: adsRouter,
		path: "/audiences/aud_1/users",
		method: "POST",
		body: { users: [{ email: "person@example.com" }] },
	},
	{
		name: "audience delete",
		router: adsRouter,
		path: "/audiences/aud_1",
		method: "DELETE",
	},
	{
		name: "ad-account sync",
		router: adsRouter,
		path: "/accounts/adacc_1/sync",
		method: "POST",
	},
	{ name: "ad get", router: adsRouter, path: "/ad_1" },
	{
		name: "ad update",
		router: adsRouter,
		path: "/ad_1",
		method: "PATCH",
		body: { name: "Updated" },
	},
	{ name: "ad delete", router: adsRouter, path: "/ad_1", method: "DELETE" },
];

function requestFor(testCase: RouteCase): Request {
	return new Request(`http://localhost${testCase.path}`, {
		method: testCase.method ?? "GET",
		headers: testCase.body ? { "content-type": "application/json" } : undefined,
		body: testCase.body ? JSON.stringify(testCase.body) : undefined,
	});
}

async function authorizedResponse(
	app: ReturnType<typeof makeRouteApp>,
	testCase: RouteCase,
) {
	// Several service functions log the expected error when this focused DB stub
	// stops after the authorization query. Keep the route matrix output signal-only.
	const errorSpy = spyOn(console, "error").mockImplementation(() => {});
	try {
		return await app.fetch(requestFor(testCase), {} as Env);
	} finally {
		errorSpy.mockRestore();
	}
}

describe("F-04 direct-id route matrix", () => {
	for (const testCase of routeMatrix) {
		const authorizedStatus = testCase.name === "media get" ? "ready" : "draft";
		it(`permits an all-workspace key to pass authorization: ${testCase.name}`, async () => {
			const app = makeRouteApp(
				testCase.router,
				{
					id: "resource",
					organizationId: "org_a",
					workspaceId: "ws_a",
					status: authorizedStatus,
				},
				"all",
			);
			const response = await authorizedResponse(app, testCase);
			expect(response.status).not.toBe(403);
			expect(response.status).not.toBe(404);
		});

		it(`permits an allowed scoped key to pass authorization: ${testCase.name}`, async () => {
			const app = makeRouteApp(
				testCase.router,
				{
					id: "resource",
					organizationId: "org_a",
					workspaceId: "ws_allowed",
					status: authorizedStatus,
				},
				["ws_allowed"],
			);
			const response = await authorizedResponse(app, testCase);
			if (testCase.allWorkspaceOnly) {
				expect(response.status).toBe(403);
				expect((await response.json()) as { error: { code: string } }).toEqual({
					error: expect.objectContaining({ code: "ORG_LEVEL_ACCESS_REQUIRED" }),
				});
			} else {
				expect(response.status).not.toBe(403);
				expect(response.status).not.toBe(404);
			}
		});

		it(`denies a same-org disallowed workspace: ${testCase.name}`, async () => {
			const app = makeRouteApp(
				testCase.router,
				{
					id: "resource",
					organizationId: "org_a",
					workspaceId: "ws_denied",
					status: "draft",
				},
				["ws_allowed"],
			);
			const response = await app.fetch(requestFor(testCase), {} as Env);
			expect(response.status).toBe(403);
			expect((await response.json()) as { error: { code: string } }).toEqual({
				error: expect.objectContaining({
					code: testCase.allWorkspaceOnly
						? "ORG_LEVEL_ACCESS_REQUIRED"
						: "WORKSPACE_ACCESS_DENIED",
				}),
			});
		});

		it(`hides a foreign-organization id: ${testCase.name}`, async () => {
			const app = makeRouteApp(
				testCase.router,
				{
					id: "resource",
					organizationId: "org_b",
					workspaceId: "ws_foreign",
					status: "draft",
				},
				"all",
			);
			const response = await app.fetch(requestFor(testCase), {} as Env);
			expect(response.status).toBe(404);
		});
	}
});

describe("nested workspace and target relationship isolation", () => {
	it("collects nested bulk workspace ids", () => {
		expect(
			collectWorkspaceIds({
				workspace_id: "ws_top",
				posts: [{ workspace_id: "ws_a" }, { nested: { workspace_id: "ws_b" } }],
			}),
		).toEqual(["ws_top", "ws_a"]);
	});

	it("does not interpret workspace_id inside opaque customer data", () => {
		expect(
			collectWorkspaceIds({
				workspace_id: "ws_top",
				metadata: { workspace_id: "customer-value" },
				flow_json: { screens: [{ data: { workspace_id: "flow-value" } }] },
			}),
		).toEqual(["ws_top"]);
	});

	it("requires organization-wide scope for queue failure administration", async () => {
		const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
		app.use("*", async (c, next) => {
			c.set("orgId", "org_a");
			c.set("workspaceScope", ["ws_allowed"]);
			await next();
		});
		app.route("/queue", queueRouter);

		for (const request of [
			new Request("http://localhost/queue/failures"),
			new Request("http://localhost/queue/failures/qf_1/replay", {
				method: "POST",
			}),
		]) {
			const response = await app.fetch(request, {} as Env);
			expect(response.status).toBe(403);
			expect((await response.json()) as { error: { code: string } }).toEqual({
				error: expect.objectContaining({ code: "ORG_LEVEL_ACCESS_REQUIRED" }),
			});
		}
	});

	it("workspace middleware rejects a nested disallowed workspace", async () => {
		const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
		app.use("*", async (c, next) => {
			c.set("workspaceScope", ["ws_allowed"]);
			c.set("parsedBody", { posts: [{ workspace_id: "ws_denied" }] });
			await next();
		});
		app.use("*", workspaceScopeMiddleware);
		app.post("/bulk", (c) => c.json({ ok: true }));
		const response = await app.request("/bulk", { method: "POST" }, {} as Env);
		expect(response.status).toBe(403);
	});

	it("resource workspace filtering rejects accounts from another workspace", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: only workspace validation is queried
		const db: any = {
			select: () => ({
				from: () => ({
					where: async () => [{ id: "ws_a" }],
				}),
			}),
		};
		const result = await resolveTargets(
			db,
			"org_a",
			["twitter", "acc_foreign_workspace", "ws_a"],
			"all",
			[
				{
					id: "acc_allowed",
					platform: "twitter",
					username: "a",
					displayName: "A",
					workspaceId: "ws_a",
				},
				{
					id: "acc_foreign_workspace",
					platform: "twitter",
					username: "b",
					displayName: "B",
					workspaceId: "ws_b",
				},
			],
			"ws_a",
		);
		expect(
			result.resolved.flatMap((target) =>
				target.accounts.map((account) => account.id),
			),
		).toEqual(["acc_allowed"]);
		expect(result.failed).toContainEqual(
			expect.objectContaining({ key: "acc_foreign_workspace" }),
		);
	});

	it("treats organization-scoped accounts as shared for a non-empty scope", async () => {
		const result = await resolveTargets(
			{} as never,
			"org_a",
			["twitter"],
			["ws_a"],
			[
				{
					id: "acc_global",
					platform: "twitter",
					username: "global",
					displayName: "Global",
					workspaceId: null,
				},
				{
					id: "acc_allowed",
					platform: "twitter",
					username: "allowed",
					displayName: "Allowed",
					workspaceId: "ws_a",
				},
				{
					id: "acc_denied",
					platform: "twitter",
					username: "denied",
					displayName: "Denied",
					workspaceId: "ws_b",
				},
			],
		);

		expect(
			result.resolved.flatMap((target) =>
				target.accounts.map((account) => account.id),
			),
		).toEqual(["acc_global", "acc_allowed"]);
		expect(result.workspaceIds).toEqual([null, "ws_a"]);
	});

	it("gives a zero-grant credential no account scope", async () => {
		const result = await resolveTargets(
			{} as never,
			"org_a",
			["twitter"],
			[],
			[
				{
					id: "acc_global",
					platform: "twitter",
					username: "global",
					displayName: "Global",
					workspaceId: null,
				},
			],
		);

		expect(result.resolved).toEqual([]);
		expect(result.workspaceIds).toEqual([]);
	});
});

describe("F-03 automation enrollment relationships", () => {
	function enrollmentDb(options: {
		contact?: object;
		entrypoint?: object;
		account?: object;
	}) {
		return {
			query: {
				automations: {
					findFirst: async () => ({
						id: "auto_a",
						organizationId: "org_a",
						workspaceId: "ws_a",
						channel: "instagram",
						graph: {
							schema_version: 1,
							root_node_key: "root",
							nodes: [],
							edges: [],
						},
					}),
				},
				contacts: { findFirst: async () => options.contact },
				automationEntrypoints: { findFirst: async () => options.entrypoint },
				automationBindings: { findFirst: async () => undefined },
				socialAccounts: { findFirst: async () => options.account },
				inboxConversations: { findFirst: async () => undefined },
			},
		};
	}

	const baseArgs = {
		automationId: "auto_a",
		organizationId: "org_a",
		contactId: "ct_foreign",
		conversationId: null,
		channel: "instagram",
		entrypointId: null,
		bindingId: null,
		socialAccountId: null,
		env: {},
	};

	it("rejects a contact outside the automation tenant", async () => {
		await expect(
			enrollContact(enrollmentDb({}) as never, baseArgs),
		).rejects.toThrow("contact does not belong to automation tenant");
	});

	it("rejects a foreign entrypoint", async () => {
		await expect(
			enrollContact(enrollmentDb({ contact: { id: "ct_a" } }) as never, {
				...baseArgs,
				contactId: "ct_a",
				entrypointId: "aep_foreign",
			}),
		).rejects.toThrow("entrypoint does not belong to automation");
	});

	it("rejects a social account outside the automation tenant", async () => {
		await expect(
			enrollContact(enrollmentDb({ contact: { id: "ct_a" } }) as never, {
				...baseArgs,
				contactId: "ct_a",
				socialAccountId: "acc_foreign",
			}),
		).rejects.toThrow("social account does not belong to automation tenant");
	});
});
