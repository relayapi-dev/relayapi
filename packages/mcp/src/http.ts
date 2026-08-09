import { timingSafeEqual } from "node:crypto";
import {
	createServer as createNodeServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RelayLike } from "./server.js";
import { createServer } from "./server.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_PATH = "/mcp";
const MAX_REQUEST_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const LOOPBACK_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

type HttpEnvironment = Record<string, string | undefined>;

export interface HttpTransportConfig {
	host: string;
	port: number;
	path: string;
	allowedHosts: string[];
	authToken?: string;
}

class RequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

function parsePort(value: string | undefined): number {
	if (value === undefined) return DEFAULT_PORT;
	if (!/^\d+$/.test(value)) {
		throw new Error("RELAYAPI_MCP_PORT must be an integer from 1 to 65535.");
	}
	const port = Number(value);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
		throw new Error("RELAYAPI_MCP_PORT must be an integer from 1 to 65535.");
	}
	return port;
}

function parsePath(value: string | undefined): string {
	const path = value ?? DEFAULT_PATH;
	if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
		throw new Error(
			"RELAYAPI_MCP_PATH must be an absolute URL path without a query or fragment.",
		);
	}
	return path;
}

function normalizeAllowedHost(value: string): string {
	if (value.includes("://") || value.includes("/") || value.includes("?")) {
		throw new Error(
			"RELAYAPI_MCP_ALLOWED_HOSTS entries must be hostnames without schemes, paths, or ports.",
		);
	}
	try {
		const parsed = new URL(`http://${value}`);
		if (parsed.port) throw new Error("port not allowed");
		return parsed.hostname.toLowerCase();
	} catch {
		throw new Error(
			"RELAYAPI_MCP_ALLOWED_HOSTS entries must be valid hostnames without ports.",
		);
	}
}

function parseAllowedHosts(value: string | undefined, host: string): string[] {
	if (!value) {
		if (LOOPBACK_HOSTS.has(host.toLowerCase())) {
			return [...LOOPBACK_ALLOWED_HOSTS];
		}
		throw new Error(
			"RELAYAPI_MCP_ALLOWED_HOSTS is required when HTTP binds to a non-loopback host.",
		);
	}
	const hosts = [
		...new Set(
			value
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean)
				.map(normalizeAllowedHost),
		),
	];
	if (hosts.length === 0) {
		throw new Error("RELAYAPI_MCP_ALLOWED_HOSTS must contain a hostname.");
	}
	return hosts;
}

export function loadHttpConfig(
	env: HttpEnvironment = process.env,
): HttpTransportConfig {
	const host = env.RELAYAPI_MCP_HOST?.trim() || DEFAULT_HOST;
	const authToken = env.RELAYAPI_MCP_AUTH_TOKEN?.trim() || undefined;
	if (!LOOPBACK_HOSTS.has(host.toLowerCase()) && !authToken) {
		throw new Error(
			"RELAYAPI_MCP_AUTH_TOKEN is required when HTTP binds to a non-loopback host.",
		);
	}
	if (authToken && authToken.length < 32) {
		throw new Error("RELAYAPI_MCP_AUTH_TOKEN must be at least 32 characters.");
	}
	return {
		host,
		port: parsePort(env.RELAYAPI_MCP_PORT),
		path: parsePath(env.RELAYAPI_MCP_PATH),
		allowedHosts: parseAllowedHosts(env.RELAYAPI_MCP_ALLOWED_HOSTS, host),
		authToken,
	};
}

export function hostHeaderIsAllowed(
	hostHeader: string | undefined,
	allowedHosts: readonly string[],
): boolean {
	if (!hostHeader) return false;
	try {
		const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
		return allowedHosts.includes(hostname);
	} catch {
		return false;
	}
}

export function bearerTokenIsAllowed(
	authorization: string | undefined,
	expectedToken: string | undefined,
): boolean {
	if (!expectedToken) return true;
	const match = authorization?.match(/^Bearer\s+(.+)$/i);
	if (!match?.[1]) return false;
	const actual = Buffer.from(match[1], "utf8");
	const expected = Buffer.from(expectedToken, "utf8");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function originHeaderIsAllowed(
	originHeader: string | undefined,
	allowedHosts: readonly string[],
): boolean {
	// Native MCP clients do not send Origin. Browser requests must originate
	// from an explicitly allowed host; `null` origins (sandboxed/file pages) are
	// never trusted.
	if (originHeader === undefined) return true;
	if (originHeader === "null") return false;
	try {
		const origin = new URL(originHeader);
		return (
			(origin.protocol === "http:" || origin.protocol === "https:") &&
			!origin.username &&
			!origin.password &&
			allowedHosts.includes(origin.hostname.toLowerCase())
		);
	} catch {
		return false;
	}
}

export function jsonContentTypeIsAllowed(
	contentType: string | undefined,
): boolean {
	return /^application\/json(?:\s*;|$)/i.test(contentType?.trim() ?? "");
}

function writeJson(
	response: ServerResponse,
	status: number,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
): void {
	if (response.headersSent || response.writableEnded) return;
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		...headers,
	});
	response.end(JSON.stringify(body));
}

function writeProtocolError(
	response: ServerResponse,
	status: number,
	code: number,
	message: string,
	headers?: Record<string, string>,
): void {
	writeJson(
		response,
		status,
		{ jsonrpc: "2.0", error: { code, message }, id: null },
		headers,
	);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const contentLength = request.headers["content-length"];
	if (contentLength !== undefined) {
		const length = Number(contentLength);
		if (!Number.isSafeInteger(length) || length < 0) {
			throw new RequestError(400, -32600, "Invalid Content-Length header.");
		}
		if (length > MAX_REQUEST_BYTES) {
			throw new RequestError(413, -32600, "Request body is too large.");
		}
	}

	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.byteLength;
		if (totalBytes > MAX_REQUEST_BYTES) {
			throw new RequestError(413, -32600, "Request body is too large.");
		}
		chunks.push(buffer);
	}

	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new RequestError(400, -32700, "Invalid JSON request body.");
	}
}

export function createHttpRequestHandler(
	client: RelayLike,
	config: HttpTransportConfig,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
	return async (request, response) => {
		if (!hostHeaderIsAllowed(request.headers.host, config.allowedHosts)) {
			writeProtocolError(response, 403, -32000, "Invalid Host header.");
			return;
		}

		let pathname: string;
		try {
			pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		} catch {
			writeProtocolError(response, 400, -32600, "Invalid request URL.");
			return;
		}

		if (pathname === "/healthz") {
			if (request.method !== "GET") {
				writeProtocolError(response, 405, -32000, "Method not allowed.", {
					allow: "GET",
				});
				return;
			}
			writeJson(response, 200, { status: "ok" });
			return;
		}

		if (pathname !== config.path) {
			writeProtocolError(response, 404, -32000, "Not found.");
			return;
		}

		if (
			!bearerTokenIsAllowed(request.headers.authorization, config.authToken)
		) {
			writeProtocolError(response, 401, -32001, "Unauthorized.", {
				"www-authenticate": 'Bearer realm="relayapi-mcp"',
			});
			return;
		}

		if (request.method !== "POST") {
			writeProtocolError(response, 405, -32000, "Method not allowed.", {
				allow: "POST",
			});
			return;
		}
		if (!originHeaderIsAllowed(request.headers.origin, config.allowedHosts)) {
			writeProtocolError(response, 403, -32000, "Untrusted Origin header.");
			return;
		}
		const contentType = request.headers["content-type"];
		if (
			typeof contentType !== "string" ||
			!jsonContentTypeIsAllowed(contentType)
		) {
			writeProtocolError(
				response,
				415,
				-32600,
				"Content-Type must be application/json.",
			);
			return;
		}

		let body: unknown;
		try {
			body = await readJsonBody(request);
		} catch (error) {
			if (error instanceof RequestError) {
				writeProtocolError(response, error.status, error.code, error.message);
				return;
			}
			throw error;
		}

		const mcp = createServer(client);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		try {
			await mcp.connect(transport);
			await transport.handleRequest(request, response, body);
		} catch (error) {
			console.error(
				"MCP HTTP request failed:",
				error instanceof Error ? error.message : error,
			);
			if (!response.headersSent) {
				writeProtocolError(response, 500, -32603, "Internal server error.");
			}
		} finally {
			await mcp.close().catch(() => undefined);
		}
	};
}

export async function startHttpServer(
	client: RelayLike,
	config: HttpTransportConfig,
): Promise<Server> {
	const handler = createHttpRequestHandler(client, config);
	const server = createNodeServer((request, response) => {
		void handler(request, response).catch((error) => {
			console.error(
				"MCP HTTP request failed:",
				error instanceof Error ? error.message : error,
			);
			writeProtocolError(response, 500, -32603, "Internal server error.");
		});
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(config.port, config.host);
	});

	return server;
}
