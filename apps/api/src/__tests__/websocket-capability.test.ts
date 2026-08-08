import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { Env, Variables } from "../types";

const TICKET = "a".repeat(32);
const claim = mock(async (_db, _key, _kind, token: string) =>
	token === TICKET ? { org_id: "org_1" } : null,
);
const issue = mock(async () => {});
mock.module("../services/one-time-capability", () => ({
	claimOneTimeCapability: claim,
	issueOneTimeCapability: issue,
}));
const dbColumn = (name: string) => ({ name });
mock.module("@relayapi/db", () => ({
	SOCIAL_PLATFORM_IDS: ["twitter", "facebook"],
	createDb: () => ({}),
	LEGACY_CREDENTIAL_VERSION: "legacy-v1",
	ORGANIZATION_SCOPE_KEY: "org",
	apikey: {
		id: dbColumn("id"),
		organizationId: dbColumn("organizationId"),
		referenceId: dbColumn("referenceId"),
		permissions: dbColumn("permissions"),
		metadata: dbColumn("metadata"),
		enabled: dbColumn("enabled"),
		expiresAt: dbColumn("expiresAt"),
	},
	member: {
		id: dbColumn("id"),
		userId: dbColumn("userId"),
		organizationId: dbColumn("organizationId"),
	},
	session: {
		id: dbColumn("id"),
		userId: dbColumn("userId"),
		activeOrganizationId: dbColumn("activeOrganizationId"),
		impersonatedBy: dbColumn("impersonatedBy"),
		expiresAt: dbColumn("expiresAt"),
	},
	user: {
		id: dbColumn("id"),
		banned: dbColumn("banned"),
		banExpires: dbColumn("banExpires"),
		credentialVersion: dbColumn("credentialVersion"),
	},
	organizationPrincipals: {
		id: dbColumn("id"),
		organizationId: dbColumn("organizationId"),
		kind: dbColumn("kind"),
		memberId: dbColumn("memberId"),
		scopeMode: dbColumn("scopeMode"),
		lifecycleStatus: dbColumn("lifecycleStatus"),
	},
	principalWorkspaceGrants: {
		principalId: dbColumn("principalId"),
		organizationId: dbColumn("organizationId"),
		workspaceId: dbColumn("workspaceId"),
	},
	organization: {
		id: dbColumn("id"),
		lifecycleStatus: dbColumn("lifecycleStatus"),
	},
	organizationSettings: {
		organizationId: dbColumn("organizationId"),
		requireWorkspaceId: dbColumn("requireWorkspaceId"),
		revision: dbColumn("revision"),
	},
	workspaces: {
		id: dbColumn("id"),
		organizationId: dbColumn("organizationId"),
		lifecycleStatus: dbColumn("lifecycleStatus"),
	},
}));

const { websocketTicket, websocketUpgrade } = await import(
	"../routes/websocket"
);

describe("WebSocket one-time capability transport", () => {
	it("marks issued bearer capabilities as non-cacheable", async () => {
		const app = new Hono<{ Bindings: Env; Variables: Variables }>();
		app.use("*", async (c, next) => {
			c.set("orgId", "org_1");
			c.set("workspaceScope", "all");
			c.set("db", {} as Variables["db"]);
			await next();
		});
		app.route("/", websocketTicket);

		const response = await app.request("https://api.example.test/", {}, {
			ENCRYPTION_KEY: `test=${"a".repeat(64)}`,
		} as Env);

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toContain("no-store");
		expect(issue).toHaveBeenCalledTimes(1);
	});

	it("rejects bearer capabilities in the URL", async () => {
		const response = await websocketUpgrade.request(
			`https://api.example.test/?ticket=${TICKET}`,
			{ headers: { Upgrade: "websocket" } },
			{} as never,
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual(
			expect.objectContaining({
				error: expect.objectContaining({
					code: "CAPABILITY_QUERY_UNSUPPORTED",
				}),
			}),
		);
	});

	it("consumes the ticket protocol and strips it before Durable Object handoff", async () => {
		let forwarded: Request | undefined;
		const response = await websocketUpgrade.request(
			"https://api.example.test/",
			{
				headers: {
					Upgrade: "websocket",
					"Sec-WebSocket-Protocol": `relayapi.v1, relayapi-ticket.${TICKET}`,
				},
			},
			{
				ENCRYPTION_KEY: `test=${"a".repeat(64)}`,
				HYPERDRIVE: { connectionString: "postgres://unused" },
				REALTIME: {
					idFromName: () => ({ id: "do_1" }),
					get: () => ({
						fetch: async (request: Request) => {
							forwarded = request;
							return new Response("forwarded");
						},
					}),
				},
			} as never,
		);

		expect(response.status).toBe(200);
		expect(claim).toHaveBeenCalledTimes(1);
		expect(forwarded?.url).not.toContain(TICKET);
		expect(forwarded?.headers.get("sec-websocket-protocol")).toBe(
			"relayapi.v1",
		);
	});
});
