import { Hono } from "hono";
import { assertAllWorkspaceScope } from "../lib/request-access";
import type { Env, Variables } from "../types";

/**
 * WebSocket upgrade — authenticated via short-lived ticket.
 * Mounted before the global /v1/* auth middleware, so this handles its own auth.
 */
export const websocketUpgrade = new Hono<{ Bindings: Env }>();

websocketUpgrade.get("/", async (c) => {
	const upgradeHeader = c.req.header("Upgrade");
	if (!upgradeHeader || upgradeHeader !== "websocket") {
		return c.json({ error: { code: "BAD_REQUEST", message: "Expected WebSocket upgrade" } }, 426);
	}

	if (c.req.query("token")) {
		return c.json(
			{
				error: {
					code: "TOKEN_QUERY_UNSUPPORTED",
					message: "Raw API keys are not accepted on WebSocket URLs. Request a ws ticket first.",
				},
			},
			400,
		);
	}

	const ticket = c.req.query("ticket");
	if (!ticket) {
		return c.json({ error: { code: "UNAUTHORIZED", message: "Missing ticket" } }, 401);
	}

	const data = await c.env.KV.get<{ org_id: string }>(`ws-ticket:${ticket}`, "json");
	if (!data) {
		return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid or expired ticket" } }, 401);
	}

	await c.env.KV.delete(`ws-ticket:${ticket}`);

	const doId = c.env.REALTIME.idFromName(data.org_id);
	const stub = c.env.REALTIME.get(doId);
	return stub.fetch(c.req.raw);
});

/**
 * WebSocket ticket issuance — requires the standard /v1/* auth middleware chain.
 */
export const websocketTicket = new Hono<{ Bindings: Env; Variables: Variables }>();

websocketTicket.get("/", async (c) => {
	const denied = assertAllWorkspaceScope(
		c,
		"Realtime streaming requires an API key with access to all workspaces.",
	);
	if (denied) return denied;

	const ticket = crypto.randomUUID().replace(/-/g, "");
	const expiresAt = new Date(Date.now() + 60_000).toISOString();

	await c.env.KV.put(
		`ws-ticket:${ticket}`,
		JSON.stringify({ org_id: c.get("orgId"), expires_at: expiresAt }),
		{ expirationTtl: 60 },
	);

	return c.json(
		{
			ticket,
			expires_at: expiresAt,
			ws_url: `/v1/ws?ticket=${ticket}`,
		},
		200,
	);
});
