import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { connectionLogs, createDb } from "@relayapi/db";
import {
	and,
	count,
	desc,
	eq,
	getTableColumns,
	gte,
	lt,
	lte,
	sql,
} from "drizzle-orm";
import {
	decodeKeysetCursor,
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
} from "../lib/pagination-cursor";
import { ErrorResponse, OffsetPaginationParams } from "../schemas/common";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Schemas ---

const ConnectionLogEntry = z.object({
	id: z.string().describe("Log entry ID"),
	account_id: z.string().nullable().describe("Social account ID"),
	platform: z.string().describe("Platform name"),
	event: z
		.enum([
			"connected",
			"disconnecting",
			"disconnected",
			"token_refreshed",
			"error",
		])
		.describe("Event type"),
	message: z.string().nullable().describe("Event details"),
	snapshot: z
		.record(z.string(), z.unknown())
		.nullable()
		.describe("Immutable lifecycle snapshot"),
	created_at: z.string().datetime().describe("Timestamp"),
});

const ConnectionLogListResponse = z.object({
	data: z.array(ConnectionLogEntry),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
	total: z.number().describe("Total matching log entries (ignores pagination)"),
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
	request: { query: OffsetPaginationParams },
	responses: {
		200: {
			description: "Connection log entries",
			content: {
				"application/json": { schema: ConnectionLogListResponse },
			},
		},
		400: {
			description: "Invalid pagination cursor",
			content: { "application/json": { schema: ErrorResponse } },
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
	const { limit, from, to, cursor, offset } = c.req.valid("query");
	const db = c.get("db");

	// Base conditions (org + time range) drive the total count; cursor/offset
	// only narrow the data page, never the count.
	const baseConditions = [eq(connectionLogs.organizationId, orgId)];
	if (from) baseConditions.push(gte(connectionLogs.createdAt, new Date(from)));
	if (to) baseConditions.push(lte(connectionLogs.createdAt, new Date(to)));

	// `offset` enables random page access and takes precedence over `cursor`.
	const useOffset = offset !== undefined;
	const conditions = [...baseConditions];
	// Offset navigation intentionally takes precedence over the sequential cursor.
	if (!useOffset && cursor) {
		const decoded = decodeKeysetCursor(cursor);
		if (decoded.kind === "invalid") return c.json(INVALID_CURSOR_BODY, 400);
		conditions.push(
			decoded.kind === "composite"
				? sql`(${connectionLogs.createdAt}, ${connectionLogs.id}) < (${decoded.timestamp}::timestamptz, ${decoded.id})`
				: lt(connectionLogs.createdAt, new Date(decoded.timestamp)),
		);
	}

	const dataQuery = db
		.select({
			...getTableColumns(connectionLogs),
			cursorTimestamp: sql<string>`to_char(${connectionLogs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(connectionLogs)
		.where(and(...conditions))
		.orderBy(desc(connectionLogs.createdAt), desc(connectionLogs.id))
		.limit(limit + 1);

	const [rows, countRows] = await Promise.all([
		offset !== undefined ? dataQuery.offset(offset) : dataQuery,
		db
			.select({ total: count() })
			.from(connectionLogs)
			.where(and(...baseConditions)),
	]);
	const total = countRows[0]?.total ?? 0;

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	return c.json(
		{
			data: data.map((l) => ({
				id: l.id,
				account_id: l.socialAccountId,
				platform: l.platform,
				event: l.event as
					| "connected"
					| "disconnecting"
					| "disconnected"
					| "token_refreshed"
					| "error",
				message: l.message,
				snapshot: (l.snapshot as Record<string, unknown> | null) ?? null,
				created_at: l.createdAt.toISOString(),
			})),
			next_cursor: hasMore
				? (() => {
						const last = data.at(-1);
						return last
							? encodeTimestampIdCursor(last.cursorTimestamp, last.id)
							: null;
					})()
				: null,
			has_more: hasMore,
			total,
		},
		200,
	);
});

export default app;
