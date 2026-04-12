import { DurableObject } from "cloudflare:workers";

/**
 * Durable Object that manages real-time WebSocket connections for dashboard updates.
 * One instance per organization, keyed by org ID.
 * Handles events for posts, inbox comments, messages, and more.
 * Uses the WebSocket Hibernation API for cost efficiency — the DO sleeps
 * between messages and only bills duration while actively processing.
 */
export class RealtimeDO extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Internal notification from API handlers — broadcast to all connected clients
		if (url.pathname === "/notify") {
			const event = await request.json();
			const sockets = this.ctx.getWebSockets();
			const payload = JSON.stringify(event);
			for (const ws of sockets) {
				try {
					ws.send(payload);
				} catch {
					// Socket already closed, hibernation API will clean it up
				}
			}
			return new Response("ok");
		}

		// WebSocket upgrade from client
		if (request.headers.get("Upgrade") === "websocket") {
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1]);
			return new Response(null, { status: 101, webSocket: pair[0] });
		}

		return new Response("Not found", { status: 404 });
	}

	// Hibernation API handler — called when a message arrives on a hibernated WS
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		try {
			const data = JSON.parse(message as string);
			if (data.type === "ping") {
				ws.send(JSON.stringify({ type: "pong" }));
			}
		} catch {
			// Ignore malformed messages
		}
	}

	async webSocketClose(): Promise<void> {
		// Cleanup handled automatically by the Hibernation API
	}

	async webSocketError(): Promise<void> {
		// Cleanup handled automatically by the Hibernation API
	}
}
