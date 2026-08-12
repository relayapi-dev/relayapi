import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	automations,
	landingPages,
	organization,
	publicGrowthEvents,
	refUrls,
	workspaces,
} from "@relayapi/db";
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Context } from "hono";
import {
	decodeTimestampIdCursor,
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
	type TimestampIdCursor,
} from "../lib/pagination-cursor";
import { hasPostgresErrorCode } from "../lib/postgres-errors";
import { type PublicResourceScope, refPublicUrl } from "../lib/public-growth";
import { inheritOperationalCreateScope } from "../lib/request-access";
import {
	applyWorkspaceScope,
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
} from "../lib/workspace-scope";
import { ErrorResponse } from "../schemas/common";
import {
	RefUrlClickSpec,
	RefUrlCreateSpec,
	RefUrlListResponse,
	RefUrlResponse,
	RefUrlUpdateSpec,
} from "../schemas/ref-urls";
import { recordRefVisit } from "../services/public-growth-events";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const IdParams = z.object({ id: z.string() });
const ListQuery = z.object({
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	workspace_id: z.string().optional(),
	automation_id: z.string().optional(),
});

type RefRow = typeof refUrls.$inferSelect;
type RefWithScope = {
	ref: RefRow;
	organizationSlug: string;
	workspaceSlug: string | null;
	cursorTimestamp?: string;
};

function publicScope(row: RefWithScope): PublicResourceScope {
	return row.ref.workspaceId && row.workspaceSlug
		? {
				kind: "workspace",
				organizationId: row.ref.organizationId,
				organizationSlug: row.organizationSlug,
				workspaceId: row.ref.workspaceId,
				workspaceSlug: row.workspaceSlug,
			}
		: {
				kind: "organization",
				organizationId: row.ref.organizationId,
				organizationSlug: row.organizationSlug,
			};
}

function serialize(
	env: Env,
	row: RefWithScope,
): z.infer<typeof RefUrlResponse> {
	const ref = row.ref;
	return {
		id: ref.id,
		organization_id: ref.organizationId,
		workspace_id: ref.workspaceId,
		slug: ref.slug,
		automation_id: ref.automationId,
		destination:
			ref.destinationType === "https_url"
				? { type: "https_url", url: ref.destinationUrl ?? "" }
				: {
						type: "landing_page",
						landing_page_id: ref.landingPageId ?? "",
					},
		public_url: refPublicUrl(env, publicScope(row), ref.id, ref.slug),
		uses: ref.uses,
		enabled: ref.enabled,
		created_at: ref.createdAt.toISOString(),
		updated_at: ref.updatedAt.toISOString(),
	};
}

function joinedRefSelection() {
	return {
		ref: refUrls,
		organizationSlug: organization.slug,
		workspaceSlug: workspaces.slug,
	};
}

async function loadRef(
	db: Variables["db"],
	organizationId: string,
	id: string,
): Promise<RefWithScope | undefined> {
	const [row] = await db
		.select(joinedRefSelection())
		.from(refUrls)
		.innerJoin(organization, eq(organization.id, refUrls.organizationId))
		.leftJoin(
			workspaces,
			and(
				eq(workspaces.id, refUrls.workspaceId),
				eq(workspaces.organizationId, refUrls.organizationId),
			),
		)
		.where(and(eq(refUrls.id, id), eq(refUrls.organizationId, organizationId)))
		.limit(1);
	return row;
}

async function automationWorkspace(
	c: AppContext,
	automationId: string,
): Promise<
	{ ok: true; workspaceId: string | null } | { ok: false; response: Response }
> {
	const [automation] = await c
		.get("db")
		.select({ workspaceId: automations.workspaceId })
		.from(automations)
		.where(
			and(
				eq(automations.id, automationId),
				eq(automations.organizationId, c.get("orgId")),
			),
		)
		.limit(1);
	if (!automation) {
		return {
			ok: false,
			response: c.json(
				{ error: { code: "NOT_FOUND", message: "Automation not found" } },
				404,
			),
		};
	}
	if (isWorkspaceScopeDenied(c, automation.workspaceId)) {
		return { ok: false, response: c.json(WORKSPACE_ACCESS_DENIED_BODY, 403) };
	}
	return { ok: true, workspaceId: automation.workspaceId };
}

async function landingWorkspace(
	c: AppContext,
	landingPageId: string,
): Promise<
	{ ok: true; workspaceId: string | null } | { ok: false; response: Response }
> {
	const [page] = await c
		.get("db")
		.select({ workspaceId: landingPages.workspaceId })
		.from(landingPages)
		.where(
			and(
				eq(landingPages.id, landingPageId),
				eq(landingPages.organizationId, c.get("orgId")),
			),
		)
		.limit(1);
	if (!page) {
		return {
			ok: false,
			response: c.json(
				{ error: { code: "NOT_FOUND", message: "Landing page not found" } },
				404,
			),
		};
	}
	if (isWorkspaceScopeDenied(c, page.workspaceId)) {
		return { ok: false, response: c.json(WORKSPACE_ACCESS_DENIED_BODY, 403) };
	}
	return { ok: true, workspaceId: page.workspaceId };
}

const createRefUrl = createRoute({
	operationId: "createRefUrl",
	method: "post",
	path: "/",
	tags: ["Ref URLs"],
	summary: "Create a reference URL",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: RefUrlCreateSpec } } },
	},
	responses: {
		201: {
			description: "Created",
			content: { "application/json": { schema: RefUrlResponse } },
		},
		400: {
			description: "Scope conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Parent not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Slug conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createRefUrl, async (c) => {
	const body = c.req.valid("json");
	const parentWorkspaces: Array<string | null> = [];
	if (body.automation_id) {
		const result = await automationWorkspace(c, body.automation_id);
		if (!result.ok) return result.response as never;
		parentWorkspaces.push(result.workspaceId);
	}
	if (body.destination.type === "landing_page") {
		const result = await landingWorkspace(c, body.destination.landing_page_id);
		if (!result.ok) return result.response as never;
		parentWorkspaces.push(result.workspaceId);
	}

	const scope = await inheritOperationalCreateScope(
		c,
		body.workspace_id,
		parentWorkspaces,
		"reference URL",
	);
	if (!scope.ok) return scope.response as never;
	const [created] = await c
		.get("db")
		.insert(refUrls)
		.values({
			organizationId: c.get("orgId"),
			workspaceId: scope.workspaceId,
			slug: body.slug,
			automationId: body.automation_id ?? null,
			destinationType: body.destination.type,
			destinationUrl:
				body.destination.type === "https_url" ? body.destination.url : null,
			landingPageId:
				body.destination.type === "landing_page"
					? body.destination.landing_page_id
					: null,
			enabled: body.enabled,
		})
		.onConflictDoNothing()
		.returning({ id: refUrls.id });
	if (!created) {
		return c.json(
			{
				error: {
					code: "SLUG_CONFLICT",
					message: `Reference URL slug '${body.slug}' is already in use in this scope.`,
				},
			},
			409,
		);
	}
	const row = await loadRef(c.get("db"), c.get("orgId"), created.id);
	if (!row) throw new Error("Created reference URL could not be read");
	return c.json(serialize(c.env, row), 201);
});

const listRefUrls = createRoute({
	operationId: "listRefUrls",
	method: "get",
	path: "/",
	tags: ["Ref URLs"],
	summary: "List reference URLs",
	security: [{ Bearer: [] }],
	request: { query: ListQuery },
	responses: {
		200: {
			description: "Reference URLs",
			content: { "application/json": { schema: RefUrlListResponse } },
		},
		400: {
			description: "Invalid cursor",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listRefUrls, async (c) => {
	const { workspace_id, automation_id, cursor, limit } = c.req.valid("query");
	let decoded: TimestampIdCursor | null = null;
	try {
		decoded = cursor ? decodeTimestampIdCursor(cursor) : null;
	} catch {
		return c.json(INVALID_CURSOR_BODY, 400);
	}
	const conditions: SQL[] = [eq(refUrls.organizationId, c.get("orgId"))];
	applyWorkspaceScope(c, conditions, refUrls.workspaceId);
	if (workspace_id) conditions.push(eq(refUrls.workspaceId, workspace_id));
	if (automation_id) conditions.push(eq(refUrls.automationId, automation_id));
	if (decoded) {
		conditions.push(
			sql`(${refUrls.createdAt}, ${refUrls.id})
				< (${decoded.timestamp}::timestamptz, ${decoded.id})`,
		);
	}
	const rows = await c
		.get("db")
		.select({
			...joinedRefSelection(),
			cursorTimestamp: sql<string>`to_char(${refUrls.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(refUrls)
		.innerJoin(organization, eq(organization.id, refUrls.organizationId))
		.leftJoin(
			workspaces,
			and(
				eq(workspaces.id, refUrls.workspaceId),
				eq(workspaces.organizationId, refUrls.organizationId),
			),
		)
		.where(and(...conditions))
		.orderBy(desc(refUrls.createdAt), desc(refUrls.id))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return c.json(
		{
			data: page.map((row) => serialize(c.env, row)),
			next_cursor:
				hasMore && last
					? encodeTimestampIdCursor(last.cursorTimestamp, last.ref.id)
					: null,
			has_more: hasMore,
		},
		200,
	);
});

const getRefUrl = createRoute({
	operationId: "getRefUrl",
	method: "get",
	path: "/{id}",
	tags: ["Ref URLs"],
	summary: "Get a reference URL",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Reference URL",
			content: { "application/json": { schema: RefUrlResponse } },
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

app.openapi(getRefUrl, async (c) => {
	const row = await loadRef(
		c.get("db"),
		c.get("orgId"),
		c.req.valid("param").id,
	);
	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Reference URL not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, row.ref.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	return c.json(serialize(c.env, row), 200);
});

const updateRefUrl = createRoute({
	operationId: "updateRefUrl",
	method: "patch",
	path: "/{id}",
	tags: ["Ref URLs"],
	summary: "Update a reference URL",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: { content: { "application/json": { schema: RefUrlUpdateSpec } } },
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: RefUrlResponse } },
		},
		400: {
			description: "Scope conflict",
			content: { "application/json": { schema: ErrorResponse } },
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
			description: "Slug conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateRefUrl, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const existing = await loadRef(c.get("db"), c.get("orgId"), id);
	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Reference URL not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, existing.ref.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	if (body.automation_id) {
		const result = await automationWorkspace(c, body.automation_id);
		if (!result.ok) return result.response as never;
		if (result.workspaceId !== existing.ref.workspaceId) {
			return c.json(
				{
					error: {
						code: "WORKSPACE_SCOPE_CONFLICT",
						message: "Automation and reference URL must share a scope.",
					},
				},
				400,
			);
		}
	}
	if (body.destination?.type === "landing_page") {
		const result = await landingWorkspace(c, body.destination.landing_page_id);
		if (!result.ok) return result.response as never;
		if (result.workspaceId !== existing.ref.workspaceId) {
			return c.json(
				{
					error: {
						code: "WORKSPACE_SCOPE_CONFLICT",
						message: "Landing page and reference URL must share a scope.",
					},
				},
				400,
			);
		}
	}

	const updates: Partial<typeof refUrls.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (body.slug !== undefined) updates.slug = body.slug;
	if (body.automation_id !== undefined) {
		updates.automationId = body.automation_id;
	}
	if (body.enabled !== undefined) updates.enabled = body.enabled;
	if (body.destination) {
		updates.destinationType = body.destination.type;
		updates.destinationUrl =
			body.destination.type === "https_url" ? body.destination.url : null;
		updates.landingPageId =
			body.destination.type === "landing_page"
				? body.destination.landing_page_id
				: null;
	}
	let updated: { id: string } | undefined;
	try {
		[updated] = await c
			.get("db")
			.update(refUrls)
			.set(updates)
			.where(
				and(eq(refUrls.id, id), eq(refUrls.organizationId, c.get("orgId"))),
			)
			.returning({ id: refUrls.id });
	} catch (error) {
		if (!hasPostgresErrorCode(error, "23505")) throw error;
		return c.json(
			{
				error: {
					code: "SLUG_CONFLICT",
					message: `Reference URL slug '${body.slug}' is already in use in this scope.`,
				},
			},
			409,
		);
	}
	if (!updated) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Reference URL not found" } },
			404,
		);
	}
	const row = await loadRef(c.get("db"), c.get("orgId"), id);
	if (!row) throw new Error("Updated reference URL could not be read");
	return c.json(serialize(c.env, row), 200);
});

const deleteRefUrl = createRoute({
	operationId: "deleteRefUrl",
	method: "delete",
	path: "/{id}",
	tags: ["Ref URLs"],
	summary: "Delete a reference URL and its QR placements",
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
		409: {
			description: "Automation dispatch is still pending",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteRefUrl, async (c) => {
	const row = await loadRef(
		c.get("db"),
		c.get("orgId"),
		c.req.valid("param").id,
	);
	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Reference URL not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, row.ref.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	const result = await c.get("db").transaction(async (tx) => {
		const [locked] = await tx
			.select({ id: refUrls.id })
			.from(refUrls)
			.where(
				and(
					eq(refUrls.id, row.ref.id),
					eq(refUrls.organizationId, c.get("orgId")),
				),
			)
			.for("update")
			.limit(1);
		if (!locked) return "not_found" as const;

		const [pendingDispatch] = await tx
			.select({ id: publicGrowthEvents.id })
			.from(publicGrowthEvents)
			.where(
				and(
					eq(publicGrowthEvents.refUrlId, locked.id),
					inArray(publicGrowthEvents.status, [
						"pending",
						"processing",
						"retry",
					]),
				),
			)
			.limit(1);
		if (pendingDispatch) return "pending_dispatch" as const;

		await tx
			.delete(refUrls)
			.where(
				and(
					eq(refUrls.id, locked.id),
					eq(refUrls.organizationId, c.get("orgId")),
				),
			);
		return "deleted" as const;
	});
	if (result === "not_found") {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Reference URL not found" } },
			404,
		);
	}
	if (result === "pending_dispatch") {
		return c.json(
			{
				error: {
					code: "PUBLIC_GROWTH_DISPATCH_PENDING",
					message:
						"Wait for pending automation deliveries before deleting this reference URL.",
				},
			},
			409,
		);
	}
	return c.body(null, 204);
});

const recordClick = createRoute({
	operationId: "recordRefUrlClick",
	method: "post",
	path: "/{id}/click",
	tags: ["Ref URLs"],
	summary: "Record an identified reference-URL visit",
	description:
		"Atomically fences the visit, increments its counter once, and commits durable automation dispatch.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: { content: { "application/json": { schema: RefUrlClickSpec } } },
	},
	responses: {
		200: {
			description: "Visit recorded or replayed",
			content: { "application/json": { schema: RefUrlResponse } },
		},
		400: {
			description: "Contact scope conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Reference URL or contact not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(recordClick, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const existing = await loadRef(c.get("db"), c.get("orgId"), id);
	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Reference URL not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, existing.ref.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	const result = await recordRefVisit(c.get("db"), {
		organizationId: c.get("orgId"),
		refUrlId: id,
		contactId: body.contact_id,
		idempotencyKey: body.idempotency_key,
	});
	if (!result.ok) {
		if (result.reason === "contact_scope_conflict") {
			return c.json(
				{
					error: {
						code: "WORKSPACE_SCOPE_CONFLICT",
						message: "Contact and reference URL must share a scope.",
					},
				},
				400,
			);
		}
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Reference URL or contact not found",
				},
			},
			404,
		);
	}
	c.get("mutationEffectTracker")?.setAuthoritativeOutcome(
		result.inserted ? { kind: "committed", units: 1 } : { kind: "not_applied" },
	);
	const row = await loadRef(c.get("db"), c.get("orgId"), id);
	if (!row) throw new Error("Recorded reference URL could not be read");
	return c.json(serialize(c.env, row), 200);
});

export default app;
