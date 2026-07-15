import { describe, expect, it, mock } from "bun:test";

const TICKET = "a".repeat(32);
const claim = mock(async (_db, _key, _kind, token: string) =>
	token === TICKET ? { org_id: "org_1" } : null,
);
mock.module("../services/one-time-capability", () => ({
	claimOneTimeCapability: claim,
	issueOneTimeCapability: mock(async () => {}),
}));
const dbColumn = (name: string) => ({ name });
mock.module("@relayapi/db", () => ({
	createDb: () => ({}),
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

const { websocketUpgrade } = await import("../routes/websocket");

describe("WebSocket one-time capability transport", () => {
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
