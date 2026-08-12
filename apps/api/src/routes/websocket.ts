import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createDb } from "@relayapi/db";
import { Hono } from "hono";
import { assertAllWorkspaceScope } from "../lib/request-access";
import { ErrorResponse } from "../schemas/common";
import {
	claimOneTimeCapability,
	issueOneTimeCapability,
} from "../services/one-time-capability";
import type { Env, Variables } from "../types";

const PUBLIC_PROTOCOL = "relayapi.v1";
const TICKET_PROTOCOL_PREFIX = "relayapi-ticket.";

function ticketFromProtocols(value: string | undefined): string | null {
	if (!value) return null;
	for (const protocol of value.split(",").map((item) => item.trim())) {
		if (protocol.startsWith(TICKET_PROTOCOL_PREFIX)) {
			const ticket = protocol.slice(TICKET_PROTOCOL_PREFIX.length);
			if (/^[a-f0-9]{32}$/.test(ticket)) return ticket;
		}
	}
	return null;
}

/** WebSocket upgrade authenticated by an atomic, single-use SQL capability. */
export const websocketUpgrade = new Hono<{ Bindings: Env }>();

websocketUpgrade.get("/", async (c) => {
	if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
		return c.json(
			{ error: { code: "BAD_REQUEST", message: "Expected WebSocket upgrade" } },
			426,
		);
	}
	if (c.req.query("token") || c.req.query("ticket")) {
		return c.json(
			{
				error: {
					code: "CAPABILITY_QUERY_UNSUPPORTED",
					message:
						"WebSocket credentials are not accepted in URLs; use the returned subprotocol.",
				},
			},
			400,
		);
	}

	const ticket = ticketFromProtocols(c.req.header("sec-websocket-protocol"));
	if (!ticket) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Missing ticket protocol" } },
			401,
		);
	}
	const db = createDb(c.env.HYPERDRIVE.connectionString);
	const data = await claimOneTimeCapability<{ org_id: string }>(
		db,
		c.env.ENCRYPTION_KEY,
		"websocket_ticket",
		ticket,
	);
	if (!data || typeof data.org_id !== "string") {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Invalid or expired ticket" } },
			401,
		);
	}

	const doId = c.env.REALTIME.idFromName(data.org_id);
	const stub = c.env.REALTIME.get(doId);
	const headers = new Headers(c.req.raw.headers);
	// Do not forward the bearer ticket into the Durable Object. It selects only
	// the public protocol, which the browser can safely expose as ws.protocol.
	headers.set("Sec-WebSocket-Protocol", PUBLIC_PROTOCOL);
	return stub.fetch(new Request(c.req.raw, { headers }));
});

/** Ticket issuance uses the normal authenticated /v1 middleware chain. */
export const websocketTicket = new OpenAPIHono<{
	Bindings: Env;
	Variables: Variables;
}>();

const retrieveTicketRoute = createRoute({
	operationId: "retrieveWebSocketTicket",
	method: "get",
	path: "/",
	tags: ["Realtime"],
	summary: "Create a WebSocket ticket",
	description:
		"Issues a single-use, short-lived ticket for an authenticated WebSocket upgrade. Pass the returned protocol as a WebSocket subprotocol; never put the ticket in a URL.",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "A short-lived WebSocket capability",
			content: {
				"application/json": {
					schema: z.object({
						ticket: z.string().length(32),
						protocol: z.string(),
						expires_at: z.string().datetime(),
						ws_url: z.string(),
					}),
				},
			},
		},
		401: {
			description: "The API key is missing or invalid",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "The credential does not have organization-wide scope",
			content: { "application/json": { schema: ErrorResponse } },
		},
		429: {
			description: "The credential has exceeded its request limit",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

websocketTicket.openapi(retrieveTicketRoute, async (c) => {
	const denied = assertAllWorkspaceScope(
		c,
		"Realtime streaming requires an API key with access to all workspaces.",
	);
	if (denied) return denied as never;

	const ticket = crypto.randomUUID().replace(/-/g, "");
	const expiresAt = new Date(Date.now() + 60_000);
	await issueOneTimeCapability(c.get("db"), c.env.ENCRYPTION_KEY, {
		kind: "websocket_ticket",
		token: ticket,
		organizationId: c.get("orgId"),
		payload: { org_id: c.get("orgId") },
		expiresAt,
	});
	c.header("Cache-Control", "no-store");
	return c.json(
		{
			ticket,
			protocol: `${TICKET_PROTOCOL_PREFIX}${ticket}`,
			expires_at: expiresAt.toISOString(),
			ws_url: "/v1/ws",
		},
		200,
	);
});
