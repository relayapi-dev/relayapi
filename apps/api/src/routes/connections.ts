import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createDb, connectionLogs } from "@relayapi/db";
import { and, desc, eq, gte, lt, lte } from "drizzle-orm";
import { ErrorResponse, PaginationParams } from "../schemas/common";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Schemas ---

const ConnectionLogEntry = z.object({
	id: z.string().describe("Log entry ID"),
	account_id: z.string().nullable().describe("Social account ID"),
	platform: z.string().describe("Platform name"),
	event: z
		.enum(["connected", "disconnected", "token_refreshed", "error"])
		.describe("Event type"),
	message: z.string().nullable().describe("Event details"),
	created_at: z.string().datetime().describe("Timestamp"),
});

const ConnectionLogListResponse = z.object({
	data: z.array(ConnectionLogEntry),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
});

// --- Helper: log a connection event to DB ---

export async function logConnectionEvent(
	env: Env,
	orgId: string,
	entry: {
		account_id: string | null;
		platform: string;
		event: string;
		message: string | null;
	},
	// Optional request-scoped client to avoid allocating a fresh postgres-js
	// client per log write. Background callers (e.g. the token-refresh cron) omit
	// it and fall back to creating one.
	dbClient?: ReturnType<typeof createDb>,
): Promise<void> {
	try {
		const db = dbClient ?? createDb(env.HYPERDRIVE.connectionString);
		await db.insert(connectionLogs).values({
			organizationId: orgId,
			socialAccountId: entry.account_id,
			platform: entry.platform as never,
			event: entry.event,
			message: entry.message,
		});
	} catch (err) {
		console.error("Failed to log connection event:", err);
	}
}

// --- Route definitions ---

const listConnectionLogs = createRoute({
	operationId: "listConnectionLogs",
	method: "get",
	path: "/logs",
	tags: ["Connections"],
	summary: "List connection logs",
	description: "Returns connection event history for the organization.",
	security: [{ Bearer: [] }],
	request: { query: PaginationParams },
	responses: {
		200: {
			description: "Connection log entries",
			content: {
				"application/json": { schema: ConnectionLogListResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Route handlers ---

app.openapi(listConnectionLogs, async (c) => {
	const orgId = c.get("orgId");
	const { limit, from, to, cursor } = c.req.valid("query");
	const db = c.get("db");

	const baseConditions = [eq(connectionLogs.organizationId, orgId)];
	if (from) baseConditions.push(gte(connectionLogs.createdAt, new Date(from)));
	if (to) baseConditions.push(lte(connectionLogs.createdAt, new Date(to)));
	// Keyset pagination: cursor is the createdAt of the last row from the previous
	// page (results are ordered createdAt DESC). Guard against an invalid date so a
	// malformed cursor doesn't produce an `IS NULL`-style no-op filter.
	if (cursor) {
		const cursorDate = new Date(cursor);
		if (!Number.isNaN(cursorDate.getTime())) {
			baseConditions.push(lt(connectionLogs.createdAt, cursorDate));
		}
	}

	const rows = await db
		.select()
		.from(connectionLogs)
		.where(and(...baseConditions))
		.orderBy(desc(connectionLogs.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	return c.json(
		{
			data: data.map((l) => ({
				id: l.id,
				account_id: l.socialAccountId,
				platform: l.platform,
				event: l.event as "connected" | "disconnected" | "token_refreshed" | "error",
				message: l.message,
				created_at: l.createdAt.toISOString(),
			})),
			next_cursor: hasMore ? (data.at(-1)?.createdAt.toISOString() ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

export default app;
