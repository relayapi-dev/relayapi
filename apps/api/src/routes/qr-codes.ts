import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { organization, qrCodes, refUrls, workspaces } from "@relayapi/db";
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import {
	decodeTimestampIdCursor,
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
	type TimestampIdCursor,
} from "../lib/pagination-cursor";
import { hasPostgresErrorCode } from "../lib/postgres-errors";
import { qrImageUrl, qrScanUrl } from "../lib/public-growth";
import { renderQrSvg } from "../lib/qr-renderer";
import {
	applyWorkspaceScope,
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
} from "../lib/workspace-scope";
import { ErrorResponse } from "../schemas/common";
import {
	QrCodeCreateSpec,
	QrCodeListResponse,
	QrCodeResponse,
	QrCodeUpdateSpec,
} from "../schemas/qr-codes";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
const IdParams = z.object({ id: z.string() });
const ListQuery = z.object({
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	workspace_id: z.string().optional(),
	ref_url_id: z.string().optional(),
	campaign_key: z.string().optional(),
});

type QrWithScope = {
	qrCode: typeof qrCodes.$inferSelect;
	workspaceId: string | null;
	organizationSlug: string;
	workspaceSlug: string | null;
	cursorTimestamp?: string;
};

function serialize(env: Env, row: QrWithScope): z.infer<typeof QrCodeResponse> {
	return {
		id: row.qrCode.id,
		public_id: row.qrCode.publicId,
		organization_id: row.qrCode.organizationId,
		workspace_id: row.workspaceId,
		ref_url_id: row.qrCode.refUrlId,
		label: row.qrCode.label,
		campaign_key: row.qrCode.campaignKey,
		scan_count: row.qrCode.scanCount,
		scan_url: qrScanUrl(env, row.qrCode.publicId),
		image_url: qrImageUrl(env, row.qrCode.publicId),
		created_at: row.qrCode.createdAt.toISOString(),
		updated_at: row.qrCode.updatedAt.toISOString(),
	};
}

function joinedSelection() {
	return {
		qrCode: qrCodes,
		workspaceId: refUrls.workspaceId,
		organizationSlug: organization.slug,
		workspaceSlug: workspaces.slug,
	};
}

async function loadQr(
	db: Variables["db"],
	organizationId: string,
	id: string,
): Promise<QrWithScope | undefined> {
	const [row] = await db
		.select(joinedSelection())
		.from(qrCodes)
		.innerJoin(
			refUrls,
			and(
				eq(refUrls.id, qrCodes.refUrlId),
				eq(refUrls.organizationId, qrCodes.organizationId),
				eq(refUrls.scopeKey, qrCodes.scopeKey),
			),
		)
		.innerJoin(organization, eq(organization.id, qrCodes.organizationId))
		.leftJoin(
			workspaces,
			and(
				eq(workspaces.id, refUrls.workspaceId),
				eq(workspaces.organizationId, refUrls.organizationId),
			),
		)
		.where(and(eq(qrCodes.id, id), eq(qrCodes.organizationId, organizationId)))
		.limit(1);
	return row;
}

const createQr = createRoute({
	operationId: "createQrCode",
	method: "post",
	path: "/",
	tags: ["QR Codes"],
	summary: "Create a deterministic QR placement for a reference URL",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: QrCodeCreateSpec } } },
	},
	responses: {
		201: {
			description: "QR code created",
			content: { "application/json": { schema: QrCodeResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Reference URL not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Placement label conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createQr, async (c) => {
	const body = c.req.valid("json");
	const [ref] = await c
		.get("db")
		.select({
			id: refUrls.id,
			scopeKey: refUrls.scopeKey,
			workspaceId: refUrls.workspaceId,
		})
		.from(refUrls)
		.where(
			and(
				eq(refUrls.id, body.ref_url_id),
				eq(refUrls.organizationId, c.get("orgId")),
			),
		)
		.limit(1);
	if (!ref) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Reference URL not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, ref.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	const [created] = await c
		.get("db")
		.insert(qrCodes)
		.values({
			organizationId: c.get("orgId"),
			scopeKey: ref.scopeKey,
			refUrlId: ref.id,
			label: body.label,
			campaignKey: body.campaign_key ?? null,
		})
		.onConflictDoNothing()
		.returning({ id: qrCodes.id });
	if (!created) {
		return c.json(
			{
				error: {
					code: "QR_LABEL_CONFLICT",
					message: `QR placement label '${body.label}' already exists for this reference URL.`,
				},
			},
			409,
		);
	}
	const row = await loadQr(c.get("db"), c.get("orgId"), created.id);
	if (!row) throw new Error("Created QR code could not be read");
	return c.json(serialize(c.env, row), 201);
});

const listQr = createRoute({
	operationId: "listQrCodes",
	method: "get",
	path: "/",
	tags: ["QR Codes"],
	summary: "List QR placements",
	security: [{ Bearer: [] }],
	request: { query: ListQuery },
	responses: {
		200: {
			description: "QR placements",
			content: { "application/json": { schema: QrCodeListResponse } },
		},
		400: {
			description: "Invalid cursor",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listQr, async (c) => {
	const query = c.req.valid("query");
	let cursor: TimestampIdCursor | null = null;
	try {
		cursor = query.cursor ? decodeTimestampIdCursor(query.cursor) : null;
	} catch {
		return c.json(INVALID_CURSOR_BODY, 400);
	}
	const conditions: SQL[] = [eq(qrCodes.organizationId, c.get("orgId"))];
	applyWorkspaceScope(c, conditions, refUrls.workspaceId);
	if (query.workspace_id) {
		conditions.push(eq(refUrls.workspaceId, query.workspace_id));
	}
	if (query.ref_url_id) {
		conditions.push(eq(qrCodes.refUrlId, query.ref_url_id));
	}
	if (query.campaign_key) {
		conditions.push(eq(qrCodes.campaignKey, query.campaign_key));
	}
	if (cursor) {
		conditions.push(
			sql`(${qrCodes.createdAt}, ${qrCodes.id})
				< (${cursor.timestamp}::timestamptz, ${cursor.id})`,
		);
	}
	const rows = await c
		.get("db")
		.select({
			...joinedSelection(),
			cursorTimestamp: sql<string>`to_char(${qrCodes.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(qrCodes)
		.innerJoin(
			refUrls,
			and(
				eq(refUrls.id, qrCodes.refUrlId),
				eq(refUrls.organizationId, qrCodes.organizationId),
				eq(refUrls.scopeKey, qrCodes.scopeKey),
			),
		)
		.innerJoin(organization, eq(organization.id, qrCodes.organizationId))
		.leftJoin(
			workspaces,
			and(
				eq(workspaces.id, refUrls.workspaceId),
				eq(workspaces.organizationId, refUrls.organizationId),
			),
		)
		.where(and(...conditions))
		.orderBy(desc(qrCodes.createdAt), desc(qrCodes.id))
		.limit(query.limit + 1);
	const hasMore = rows.length > query.limit;
	const page = rows.slice(0, query.limit);
	const last = page.at(-1);
	return c.json(
		{
			data: page.map((row) => serialize(c.env, row)),
			next_cursor:
				hasMore && last
					? encodeTimestampIdCursor(last.cursorTimestamp, last.qrCode.id)
					: null,
			has_more: hasMore,
		},
		200,
	);
});

const getQr = createRoute({
	operationId: "getQrCode",
	method: "get",
	path: "/{id}",
	tags: ["QR Codes"],
	summary: "Get a QR placement",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "QR placement",
			content: { "application/json": { schema: QrCodeResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getQr, async (c) => {
	const row = await loadQr(
		c.get("db"),
		c.get("orgId"),
		c.req.valid("param").id,
	);
	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "QR code not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	return c.json(serialize(c.env, row), 200);
});

const getQrImage = createRoute({
	operationId: "getQrCodeImage",
	method: "get",
	path: "/{id}/image",
	tags: ["QR Codes"],
	summary: "Render a QR image deterministically without object storage",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "SVG QR image",
			content: { "image/svg+xml": { schema: z.string() } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getQrImage, async (c) => {
	const row = await loadQr(
		c.get("db"),
		c.get("orgId"),
		c.req.valid("param").id,
	);
	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "QR code not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	const svg = await renderQrSvg(qrScanUrl(c.env, row.qrCode.publicId));
	return c.body(svg, 200, {
		"Content-Type": "image/svg+xml; charset=utf-8",
		"Cache-Control": "public, max-age=31536000, immutable",
	});
});

const updateQr = createRoute({
	operationId: "updateQrCode",
	method: "patch",
	path: "/{id}",
	tags: ["QR Codes"],
	summary: "Update QR placement identity",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: { content: { "application/json": { schema: QrCodeUpdateSpec } } },
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: QrCodeResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Placement label conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateQr, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const existing = await loadQr(c.get("db"), c.get("orgId"), id);
	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "QR code not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, existing.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	let updated: { id: string } | undefined;
	try {
		[updated] = await c
			.get("db")
			.update(qrCodes)
			.set({
				...(body.label !== undefined ? { label: body.label } : {}),
				...(body.campaign_key !== undefined
					? { campaignKey: body.campaign_key }
					: {}),
				updatedAt: new Date(),
			})
			.where(
				and(eq(qrCodes.id, id), eq(qrCodes.organizationId, c.get("orgId"))),
			)
			.returning({ id: qrCodes.id });
	} catch (error) {
		if (!hasPostgresErrorCode(error, "23505")) throw error;
		return c.json(
			{
				error: {
					code: "QR_LABEL_CONFLICT",
					message: `QR placement label '${body.label}' already exists for this reference URL.`,
				},
			},
			409,
		);
	}
	if (!updated) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "QR code not found" } },
			404,
		);
	}
	const row = await loadQr(c.get("db"), c.get("orgId"), id);
	if (!row) throw new Error("Updated QR code could not be read");
	return c.json(serialize(c.env, row), 200);
});

const deleteQr = createRoute({
	operationId: "deleteQrCode",
	method: "delete",
	path: "/{id}",
	tags: ["QR Codes"],
	summary: "Delete a QR placement",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		204: { description: "Deleted" },
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteQr, async (c) => {
	const row = await loadQr(
		c.get("db"),
		c.get("orgId"),
		c.req.valid("param").id,
	);
	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "QR code not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	const deleted = await c.get("db").transaction(async (tx) => {
		const [locked] = await tx
			.select({ id: qrCodes.id })
			.from(qrCodes)
			.where(
				and(
					eq(qrCodes.id, row.qrCode.id),
					eq(qrCodes.organizationId, c.get("orgId")),
				),
			)
			.for("update")
			.limit(1);
		if (!locked) return false;
		await tx
			.delete(qrCodes)
			.where(
				and(
					eq(qrCodes.id, locked.id),
					eq(qrCodes.organizationId, c.get("orgId")),
				),
			);
		return true;
	});
	if (!deleted) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "QR code not found" } },
			404,
		);
	}
	return c.body(null, 204);
});

export default app;
