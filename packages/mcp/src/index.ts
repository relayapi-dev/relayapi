#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRelayClient } from "./client";
import { loadConfig } from "./config";
import { createServer } from "./server";

/**
 * Entry point for the RelayAPI MCP server.
 *
 * Transports:
 *   - stdio (default) — for Claude Desktop and local MCP-compatible clients.
 *   - http            — NOT YET IMPLEMENTED. See the README for the planned
 *                       Streamable-HTTP transport.
 *
 * Env:
 *   RELAYAPI_KEY       — required, rlay_live_* / rlay_test_*
 *   RELAYAPI_BASE_URL  — optional override
 */
async function main(): Promise<void> {
	const transportArg = process.argv[2] ?? "stdio";

	if (transportArg === "http") {
		console.error(
			"http transport is not yet implemented. Use stdio for now, or open an issue if you need Streamable-HTTP support.",
		);
		process.exit(2);
	}

	if (transportArg !== "stdio") {
		console.error(`Unknown transport '${transportArg}'. Expected 'stdio'.`);
		process.exit(2);
	}

	const config = loadConfig();
	const client = createRelayClient(config);
	// Loose cast: the MCP server only uses the automations surface, which the
	// SDK instance provides at runtime; a nominal type mismatch on the SDK's
	// richer generics is not worth propagating through the tool registrations.
	const server = createServer(client as unknown as Parameters<typeof createServer>[0]);

	const transport = new StdioServerTransport();
	await server.connect(transport);

	// Keep the process alive; stdio transport blocks on stdin.
	process.stderr.write("relayapi-mcp-server ready on stdio\n");
}

main().catch((err) => {
	console.error("Fatal:", err instanceof Error ? err.message : err);
	process.exit(1);
});
