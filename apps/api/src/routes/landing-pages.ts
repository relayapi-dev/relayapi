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
import {
	decodeTimestampIdCursor,
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
	type TimestampIdCursor,
} from "../lib/pagination-cursor";
import { hasPostgresErrorCode } from "../lib/postgres-errors";
import {
	landingPageConversionUrl,
	landingPagePublicUrl,
	type PublicResourceScope,
} from "../lib/public-growth";
import { inheritOperationalCreateScope } from "../lib/request-access";
import {
	applyWorkspaceScope,
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
} from "../lib/workspace-scope";
import { ErrorResponse } from "../schemas/common";
import {
	LandingPageConfig,
	LandingPageCreateSpec,
	LandingPageListResponse,
	LandingPageResponse,
	LandingPageUpdateSpec,
} from "../schemas/landing-pages";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
const IdParams = z.object({ id: z.string() });
const ListQuery = z.object({
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	workspace_id: z.string().optional(),
	automation_id: z.string().optional(),
});

type LandingWithScope = {
	page: typeof landingPages.$inferSelect;
	organizationSlug: string;
	workspaceSlug: string | null;
	cursorTimestamp?: string;
};

function publicScope(row: LandingWithScope): PublicResourceScope {
	return row.page.workspaceId && row.workspaceSlug
		? {
				kind: "workspace",
				organizationId: row.page.organizationId,
				organizationSlug: row.organizationSlug,
				workspaceId: row.page.workspaceId,
				workspaceSlug: row.workspaceSlug,
			}
		: {
				kind: "organization",
				organizationId: row.page.organizationId,
				organizationSlug: row.organizationSlug,
			};
}

function serialize(
	env: Env,
	row: LandingWithScope,
): z.infer<typeof LandingPageResponse> {
	const config = LandingPageConfig.parse(row.page.config);
	const scope = publicScope(row);
	return {
		id: row.page.id,
		organization_id: row.page.organizationId,
		workspace_id: row.page.workspaceId,
		slug: row.page.slug,
		title: row.page.title,
		config,
		automation_id: row.page.automationId,
		visits: row.page.visits,
		conversions: row.page.conversions,
		enabled: row.page.enabled,
		public_url: landingPagePublicUrl(env, scope, row.page.id, row.page.slug),
		conversion_url: landingPageConversionUrl(
			env,
			scope,
			row.page.id,
			row.page.slug,
		),
		created_at: row.page.createdAt.toISOString(),
		updated_at: row.page.updatedAt.toISOString(),
	};
}

function joinedSelection() {
	return {
		page: landingPages,
		organizationSlug: organization.slug,
		workspaceSlug: workspaces.slug,
	};
}

async function loadPage(
	db: Variables["db"],
	organizationId: string,
	id: string,
): Promise<LandingWithScope | undefined> {
	const [row] = await db
		.select(joinedSelection())
		.from(landingPages)
		.innerJoin(organization, eq(organization.id, landingPages.organizationId))
		.leftJoin(
			workspaces,
			and(
				eq(workspaces.id, landingPages.workspaceId),
				eq(workspaces.organizationId, landingPages.organizationId),
			),
		)
		.where(
			and(
				eq(landingPages.id, id),
				eq(landingPages.organizationId, organizationId),
			),
		)
		.limit(1);
	return row;
}

async function loadAutomationWorkspace(
	db: Variables["db"],
	organizationId: string,
	automationId: string,
): Promise<{ workspaceId: string | null } | undefined> {
	const [row] = await db
		.select({ workspaceId: automations.workspaceId })
		.from(automations)
		.where(
			and(
				eq(automations.id, automationId),
				eq(automations.organizationId, organizationId),
			),
		)
		.limit(1);
	return row;
}

const createPage = createRoute({
	operationId: "createLandingPage",
	method: "post",
	path: "/",
	tags: ["Landing Pages"],
	summary: "Create a typed, versioned landing page",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: LandingPageCreateSpec } },
		},
	},
	responses: {
		201: {
			description: "Landing page created",
			content: { "application/json": { schema: LandingPageResponse } },
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
			description: "Automation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Slug conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createPage, async (c) => {
	const body = c.req.valid("json");
	const parentWorkspaces: Array<string | null> = [];
	if (body.automation_id) {
		const automation = await loadAutomationWorkspace(
			c.get("db"),
			c.get("orgId"),
			body.automation_id,
		);
		if (!automation) {
			return c.json(
				{ error: { code: "NOT_FOUND", message: "Automation not found" } },
				404,
			);
		}
		if (isWorkspaceScopeDenied(c, automation.workspaceId)) {
			return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
		}
		parentWorkspaces.push(automation.workspaceId);
	}
	const scope = await inheritOperationalCreateScope(
		c,
		body.workspace_id,
		parentWorkspaces,
		"landing page",
	);
	if (!scope.ok) return scope.response as never;

	const [created] = await c
		.get("db")
		.insert(landingPages)
		.values({
			organizationId: c.get("orgId"),
			workspaceId: scope.workspaceId,
			slug: body.slug,
			title: body.title,
			config: body.config,
			automationId: body.automation_id ?? null,
			enabled: body.enabled,
		})
		.onConflictDoNothing()
		.returning({ id: landingPages.id });
	if (!created) {
		return c.json(
			{
				error: {
					code: "SLUG_CONFLICT",
					message: `Landing-page slug '${body.slug}' is already in use in this scope.`,
				},
			},
			409,
		);
	}
	const row = await loadPage(c.get("db"), c.get("orgId"), created.id);
	if (!row) throw new Error("Created landing page could not be read");
	return c.json(serialize(c.env, row), 201);
});

const listPages = createRoute({
	operationId: "listLandingPages",
	method: "get",
	path: "/",
	tags: ["Landing Pages"],
	summary: "List landing pages",
	security: [{ Bearer: [] }],
	request: { query: ListQuery },
	responses: {
		200: {
			description: "Landing pages",
			content: { "application/json": { schema: LandingPageListResponse } },
		},
		400: {
			description: "Invalid cursor",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listPages, async (c) => {
	const query = c.req.valid("query");
	let cursor: TimestampIdCursor | null = null;
	try {
		cursor = query.cursor ? decodeTimestampIdCursor(query.cursor) : null;
	} catch {
		return c.json(INVALID_CURSOR_BODY, 400);
	}
	const conditions: SQL[] = [eq(landingPages.organizationId, c.get("orgId"))];
	applyWorkspaceScope(c, conditions, landingPages.workspaceId);
	if (query.workspace_id) {
		conditions.push(eq(landingPages.workspaceId, query.workspace_id));
	}
	if (query.automation_id) {
		conditions.push(eq(landingPages.automationId, query.automation_id));
	}
	if (cursor) {
		conditions.push(
			sql`(${landingPages.createdAt}, ${landingPages.id})
				< (${cursor.timestamp}::timestamptz, ${cursor.id})`,
		);
	}
	const rows = await c
		.get("db")
		.select({
			...joinedSelection(),
			cursorTimestamp: sql<string>`to_char(${landingPages.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(landingPages)
		.innerJoin(organization, eq(organization.id, landingPages.organizationId))
		.leftJoin(
			workspaces,
			and(
				eq(workspaces.id, landingPages.workspaceId),
				eq(workspaces.organizationId, landingPages.organizationId),
			),
		)
		.where(and(...conditions))
		.orderBy(desc(landingPages.createdAt), desc(landingPages.id))
		.limit(query.limit + 1);
	const hasMore = rows.length > query.limit;
	const page = rows.slice(0, query.limit);
	const last = page.at(-1);
	return c.json(
		{
			data: page.map((row) => serialize(c.env, row)),
			next_cursor:
				hasMore && last
					? encodeTimestampIdCursor(last.cursorTimestamp, last.page.id)
					: null,
			has_more: hasMore,
		},
		200,
	);
});

const getPage = createRoute({
	operationId: "getLandingPage",
	method: "get",
	path: "/{id}",
	tags: ["Landing Pages"],
	summary: "Get a landing page",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Landing page",
			content: { "application/json": { schema: LandingPageResponse } },
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

app.openapi(getPage, async (c) => {
	const row = await loadPage(
		c.get("db"),
		c.get("orgId"),
		c.req.valid("param").id,
	);
	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Landing page not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, row.page.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	return c.json(serialize(c.env, row), 200);
});

const updatePage = createRoute({
	operationId: "updateLandingPage",
	method: "patch",
	path: "/{id}",
	tags: ["Landing Pages"],
	summary: "Update a landing page",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: {
			content: { "application/json": { schema: LandingPageUpdateSpec } },
		},
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: LandingPageResponse } },
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

app.openapi(updatePage, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const existing = await loadPage(c.get("db"), c.get("orgId"), id);
	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Landing page not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, existing.page.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	if (body.automation_id) {
		const automation = await loadAutomationWorkspace(
			c.get("db"),
			c.get("orgId"),
			body.automation_id,
		);
		if (!automation) {
			return c.json(
				{ error: { code: "NOT_FOUND", message: "Automation not found" } },
				404,
			);
		}
		if (automation.workspaceId !== existing.page.workspaceId) {
			return c.json(
				{
					error: {
						code: "WORKSPACE_SCOPE_CONFLICT",
						message: "Automation and landing page must share a scope.",
					},
				},
				400,
			);
		}
	}
	let updated: { id: string } | undefined;
	try {
		[updated] = await c
			.get("db")
			.update(landingPages)
			.set({
				...(body.slug !== undefined ? { slug: body.slug } : {}),
				...(body.title !== undefined ? { title: body.title } : {}),
				...(body.config !== undefined ? { config: body.config } : {}),
				...(body.automation_id !== undefined
					? { automationId: body.automation_id }
					: {}),
				...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(landingPages.id, id),
					eq(landingPages.organizationId, c.get("orgId")),
				),
			)
			.returning({ id: landingPages.id });
	} catch (error) {
		if (!hasPostgresErrorCode(error, "23505")) throw error;
		return c.json(
			{
				error: {
					code: "SLUG_CONFLICT",
					message: `Landing-page slug '${body.slug}' is already in use in this scope.`,
				},
			},
			409,
		);
	}
	if (!updated) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Landing page not found" } },
			404,
		);
	}
	const row = await loadPage(c.get("db"), c.get("orgId"), id);
	if (!row) throw new Error("Updated landing page could not be read");
	return c.json(serialize(c.env, row), 200);
});

const deletePage = createRoute({
	operationId: "deleteLandingPage",
	method: "delete",
	path: "/{id}",
	tags: ["Landing Pages"],
	summary: "Delete an unreferenced landing page",
	description:
		"Reference URLs must be repointed first so deleting a page cannot break a public redirect.",
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
			description: "Landing page is referenced or dispatch is pending",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deletePage, async (c) => {
	const row = await loadPage(
		c.get("db"),
		c.get("orgId"),
		c.req.valid("param").id,
	);
	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Landing page not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, row.page.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	let result:
		| "deleted"
		| "not_found"
		| "in_use"
		| "pending_dispatch"
		| undefined;
	try {
		result = await c.get("db").transaction(async (tx) => {
			const [locked] = await tx
				.select({ id: landingPages.id })
				.from(landingPages)
				.where(
					and(
						eq(landingPages.id, row.page.id),
						eq(landingPages.organizationId, c.get("orgId")),
					),
				)
				.for("update")
				.limit(1);
			if (!locked) return "not_found" as const;

			const [reference] = await tx
				.select({ id: refUrls.id })
				.from(refUrls)
				.where(
					and(
						eq(refUrls.organizationId, c.get("orgId")),
						eq(refUrls.landingPageId, locked.id),
					),
				)
				.limit(1);
			if (reference) return "in_use" as const;

			const [pendingDispatch] = await tx
				.select({ id: publicGrowthEvents.id })
				.from(publicGrowthEvents)
				.where(
					and(
						eq(publicGrowthEvents.landingPageId, locked.id),
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
				.delete(landingPages)
				.where(
					and(
						eq(landingPages.id, locked.id),
						eq(landingPages.organizationId, c.get("orgId")),
					),
				);
			return "deleted" as const;
		});
	} catch (error) {
		if (!hasPostgresErrorCode(error, "23503")) throw error;
		result = "in_use";
	}
	if (result === "not_found") {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Landing page not found" } },
			404,
		);
	}
	if (result === "pending_dispatch") {
		return c.json(
			{
				error: {
					code: "PUBLIC_GROWTH_DISPATCH_PENDING",
					message:
						"Wait for pending automation deliveries before deleting this landing page.",
				},
			},
			409,
		);
	}
	if (result === "in_use") {
		return c.json(
			{
				error: {
					code: "LANDING_PAGE_IN_USE",
					message: "Repoint reference URLs before deleting this landing page.",
				},
			},
			409,
		);
	}
	return c.body(null, 204);
});

export default app;
