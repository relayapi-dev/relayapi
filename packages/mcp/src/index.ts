#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRelayClient } from "./client.js";
import { loadConfig } from "./config.js";
import { loadHttpConfig, startHttpServer } from "./http.js";
import { createServer } from "./server.js";

/**
 * Entry point for the RelayAPI MCP server.
 *
 * Transports:
 *   - stdio (default) — for Claude Desktop and local MCP-compatible clients.
 *   - http            — stateless Streamable HTTP for remote MCP clients.
 *
 * Env:
 *   RELAYAPI_KEY       — required, rlay_live_* / rlay_test_*
 *   RELAYAPI_BASE_URL  — optional override
 */
async function main(): Promise<void> {
	const transportArg = process.argv[2] ?? "stdio";
	if (transportArg !== "stdio" && transportArg !== "http") {
		console.error(
			`Unknown transport '${transportArg}'. Expected 'stdio' or 'http'.`,
		);
		process.exit(2);
	}

	const config = loadConfig();
	const client = createRelayClient(config);
	if (transportArg === "http") {
		const httpConfig = loadHttpConfig();
		const httpServer = await startHttpServer(client, httpConfig);
		process.stderr.write(
			`relayapi-mcp-server ready at http://${httpConfig.host}:${httpConfig.port}${httpConfig.path}\n`,
		);
		const shutdown = () => {
			httpServer.close((error) => {
				if (error) {
					console.error("Failed to stop MCP HTTP server:", error.message);
					process.exitCode = 1;
				}
			});
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
		return;
	}

	const server = createServer(client);

	const transport = new StdioServerTransport();
	await server.connect(transport);

	// Keep the process alive; stdio transport blocks on stdin.
	process.stderr.write("relayapi-mcp-server ready on stdio\n");
}

main().catch((err) => {
	console.error("Fatal:", err instanceof Error ? err.message : err);
	process.exit(1);
});
