// ---------------------------------------------------------------------------
// Organization Settings API — /v1/org-settings
// ---------------------------------------------------------------------------

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	adAccounts,
	adAudiences,
	aiAgents,
	aiKnowledgeBases,
	automations,
	autoPostRules,
	broadcasts,
	contacts,
	type Database,
	ideas,
	inboxConversations,
	landingPages,
	media,
	organizationSettings,
	posts,
	postThreads,
	REQUIRE_WORKSPACE_OPERATIONAL_ROOTS,
	refUrls,
	segments,
	shortLinks,
	socialAccounts,
	subscriptionLists,
	webhookEndpoints,
} from "@relayapi/db";
import { and, count, eq, ne, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { requireAllWorkspaceScopeMiddleware } from "../middleware/permissions";
import { ErrorResponse } from "../schemas/common";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

app.use("*", requireAllWorkspaceScopeMiddleware);

const ORG_SETTINGS_HINT_TTL_SECONDS = 300;

export const WorkspaceScopeBlockerSchema = z.object({
	resource_type: z.string(),
	count: z.number().int().nonnegative(),
});

const OrgSettingsConflictResponse = z.object({
	error: z.object({
		code: z.enum(["ORG_SETTINGS_VERSION_CONFLICT", "WORKSPACE_SCOPE_BLOCKERS"]),
		message: z.string(),
		details: z
			.object({
				blockers: z.array(WorkspaceScopeBlockerSchema).optional(),
				total: z.number().int().nonnegative().optional(),
				current_revision: z.number().int().nonnegative().optional(),
				require_workspace_id: z.boolean().optional(),
			})
			.optional(),
	}),
});

const OrgSettingsResponse = z.object({
	require_workspace_id: z
		.boolean()
		.describe(
			"When enabled, active operational resources must be created in an explicit workspace. Organization-shared definitions remain exempt.",
		),
	revision: z
		.number()
		.int()
		.nonnegative()
		.describe("Compare-and-swap revision for organization settings."),
});

export const UpdateOrgSettingsBody = z
	.object({
		require_workspace_id: z
			.boolean()
			.describe(
				"Require an explicit workspace ID for active operational root creates.",
			),
		expected_revision: z
			.number()
			.int()
			.nonnegative()
			.describe("Revision returned by the latest settings read."),
	})
	.strict();

export type WorkspaceScopeBlocker = z.infer<typeof WorkspaceScopeBlockerSchema>;

type BlockerQuery = {
	resourceType: string;
	count: () => Promise<number>;
};

async function countResult(
	query: PromiseLike<Array<{ value: number | string | bigint }>>,
): Promise<number> {
	const [row] = await query;
	return Number(row?.value ?? 0);
}

/**
 * Explicit inventory of active operational roots that prevent strict workspace
 * mode. Shared definitions and inherited/history/evidence tables are excluded.
 * Keep this isolated so the database schema-contract registry can assert that
 * every operational root is represented here.
 */
export async function getWorkspaceScopeBlockers(
	db: Database,
	organizationId: string,
): Promise<WorkspaceScopeBlocker[]> {
	const unscoped = (
		organizationColumn: AnyPgColumn,
		workspaceColumn: AnyPgColumn,
	) =>
		sql`${organizationColumn} = ${organizationId} AND ${workspaceColumn} IS NULL`;

	const queries: BlockerQuery[] = [
		{
			resourceType: "social_accounts",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(socialAccounts)
						.where(
							and(
								unscoped(
									socialAccounts.organizationId,
									socialAccounts.workspaceId,
								),
								ne(socialAccounts.lifecycleStatus, "disconnected"),
							),
						),
				),
		},
		{
			resourceType: "post_threads",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(postThreads)
						.where(
							unscoped(postThreads.organizationId, postThreads.workspaceId),
						),
				),
		},
		{
			resourceType: "posts",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(posts)
						.where(unscoped(posts.organizationId, posts.workspaceId)),
				),
		},
		{
			resourceType: "media",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(media)
						.where(unscoped(media.organizationId, media.workspaceId)),
				),
		},
		{
			resourceType: "webhook_endpoints",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(webhookEndpoints)
						.where(
							unscoped(
								webhookEndpoints.organizationId,
								webhookEndpoints.workspaceId,
							),
						),
				),
		},
		{
			resourceType: "inbox_conversations",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(inboxConversations)
						.where(
							and(
								unscoped(
									inboxConversations.organizationId,
									inboxConversations.workspaceId,
								),
								ne(inboxConversations.status, "archived"),
							),
						),
				),
		},
		{
			resourceType: "auto_post_rules",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(autoPostRules)
						.where(
							unscoped(autoPostRules.organizationId, autoPostRules.workspaceId),
						),
				),
		},
		{
			resourceType: "contacts",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(contacts)
						.where(unscoped(contacts.organizationId, contacts.workspaceId)),
				),
		},
		{
			resourceType: "broadcasts",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(broadcasts)
						.where(unscoped(broadcasts.organizationId, broadcasts.workspaceId)),
				),
		},
		{
			resourceType: "ad_accounts",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(adAccounts)
						.where(unscoped(adAccounts.organizationId, adAccounts.workspaceId)),
				),
		},
		{
			resourceType: "ad_audiences",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(adAudiences)
						.where(
							unscoped(adAudiences.organizationId, adAudiences.workspaceId),
						),
				),
		},
		{
			resourceType: "short_links",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(shortLinks)
						.where(unscoped(shortLinks.organizationId, shortLinks.workspaceId)),
				),
		},
		{
			resourceType: "ideas",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(ideas)
						.where(unscoped(ideas.organizationId, ideas.workspaceId)),
				),
		},
		{
			resourceType: "automations",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(automations)
						.where(
							and(
								unscoped(automations.organizationId, automations.workspaceId),
								ne(automations.status, "archived"),
							),
						),
				),
		},
		{
			resourceType: "segments",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(segments)
						.where(unscoped(segments.organizationId, segments.workspaceId)),
				),
		},
		{
			resourceType: "subscription_lists",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(subscriptionLists)
						.where(
							unscoped(
								subscriptionLists.organizationId,
								subscriptionLists.workspaceId,
							),
						),
				),
		},
		{
			resourceType: "ai_knowledge_bases",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(aiKnowledgeBases)
						.where(
							unscoped(
								aiKnowledgeBases.organizationId,
								aiKnowledgeBases.workspaceId,
							),
						),
				),
		},
		{
			resourceType: "ai_agents",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(aiAgents)
						.where(unscoped(aiAgents.organizationId, aiAgents.workspaceId)),
				),
		},
		{
			resourceType: "ref_urls",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(refUrls)
						.where(unscoped(refUrls.organizationId, refUrls.workspaceId)),
				),
		},
		{
			resourceType: "landing_pages",
			count: () =>
				countResult(
					db
						.select({ value: count() })
						.from(landingPages)
						.where(
							unscoped(landingPages.organizationId, landingPages.workspaceId),
						),
				),
		},
	];
	const blockerTypes = queries.map((query) => query.resourceType);
	if (
		blockerTypes.length !== REQUIRE_WORKSPACE_OPERATIONAL_ROOTS.length ||
		blockerTypes.some(
			(resourceType, index) =>
				resourceType !== REQUIRE_WORKSPACE_OPERATIONAL_ROOTS[index],
		)
	) {
		throw new Error(
			"Workspace blocker inventory does not match the schema scope contract",
		);
	}

	const blockers: WorkspaceScopeBlocker[] = [];
	// Keep these reads sequential: callers run inside the settings transaction,
	// and postgres.js transactions intentionally reserve one connection.
	for (const query of queries) {
		const value = await query.count();
		if (value > 0) {
			blockers.push({ resource_type: query.resourceType, count: value });
		}
	}
	return blockers;
}

const getSettings = createRoute({
	operationId: "getOrgSettings",
	method: "get",
	path: "/",
	tags: ["Organization Settings"],
	summary: "Get organization settings",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Organization settings",
			content: {
				"application/json": {
					schema: z.object({ data: OrgSettingsResponse }),
				},
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "All-workspace access required",
			content: { "application/json": { schema: ErrorResponse } },
		},
		500: {
			description: "Organization settings are not initialized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — hono-zod-openapi strict response union
app.openapi(getSettings, async (c) => {
	const organizationId = c.get("orgId");
	const db = c.get("db");
	const [settings] = await db
		.select({
			requireWorkspaceId: organizationSettings.requireWorkspaceId,
			revision: organizationSettings.revision,
		})
		.from(organizationSettings)
		.where(eq(organizationSettings.organizationId, organizationId))
		.limit(1);

	if (!settings) {
		return c.json(
			{
				error: {
					code: "ORG_SETTINGS_NOT_INITIALIZED",
					message: "Organization settings are not initialized.",
				},
			},
			500,
		);
	}

	return c.json({
		data: {
			require_workspace_id: settings.requireWorkspaceId,
			revision: settings.revision,
		},
	});
});

const updateSettings = createRoute({
	operationId: "updateOrgSettings",
	method: "patch",
	path: "/",
	tags: ["Organization Settings"],
	summary: "Update organization settings",
	security: [{ Bearer: [] }],
	request: {
		body: {
			required: true,
			content: {
				"application/json": { schema: UpdateOrgSettingsBody },
			},
		},
	},
	responses: {
		200: {
			description: "Settings updated",
			content: {
				"application/json": {
					schema: z.object({ data: OrgSettingsResponse }),
				},
			},
		},
		400: {
			description: "Invalid settings update",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "All-workspace access required",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Revision conflict or active organization-scoped resources",
			content: {
				"application/json": { schema: OrgSettingsConflictResponse },
			},
		},
		500: {
			description: "Organization settings are not initialized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

type UpdateResult =
	| {
			kind: "success";
			requireWorkspaceId: boolean;
			revision: number;
	  }
	| {
			kind: "revision_conflict";
			requireWorkspaceId: boolean;
			revision: number;
	  }
	| { kind: "blockers"; blockers: WorkspaceScopeBlocker[] }
	| { kind: "missing" };

// @ts-expect-error — hono-zod-openapi strict response union
app.openapi(updateSettings, async (c) => {
	const organizationId = c.get("orgId");
	const keyId = c.get("keyId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const result = await db.transaction(async (tx): Promise<UpdateResult> => {
		const [current] = await tx
			.select({
				requireWorkspaceId: organizationSettings.requireWorkspaceId,
				revision: organizationSettings.revision,
			})
			.from(organizationSettings)
			.where(eq(organizationSettings.organizationId, organizationId))
			.for("update")
			.limit(1);

		if (!current) return { kind: "missing" };
		if (current.revision !== body.expected_revision) {
			return {
				kind: "revision_conflict",
				requireWorkspaceId: current.requireWorkspaceId,
				revision: current.revision,
			};
		}

		if (body.require_workspace_id) {
			const blockers = await getWorkspaceScopeBlockers(
				tx as unknown as Database,
				organizationId,
			);
			if (blockers.length > 0) return { kind: "blockers", blockers };
		}

		if (body.require_workspace_id === current.requireWorkspaceId) {
			return {
				kind: "success",
				requireWorkspaceId: current.requireWorkspaceId,
				revision: current.revision,
			};
		}

		const [updated] = await tx
			.update(organizationSettings)
			.set({
				requireWorkspaceId: body.require_workspace_id,
				revision: sql`${organizationSettings.revision} + 1`,
				updatedByUserId: null,
				updatedByApiKeyId: keyId,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(organizationSettings.organizationId, organizationId),
					eq(organizationSettings.revision, body.expected_revision),
				),
			)
			.returning({
				requireWorkspaceId: organizationSettings.requireWorkspaceId,
				revision: organizationSettings.revision,
			});

		if (!updated) {
			return {
				kind: "revision_conflict",
				requireWorkspaceId: current.requireWorkspaceId,
				revision: current.revision,
			};
		}
		return { kind: "success", ...updated };
	});

	if (result.kind === "missing") {
		return c.json(
			{
				error: {
					code: "ORG_SETTINGS_NOT_INITIALIZED",
					message: "Organization settings are not initialized.",
				},
			},
			500,
		);
	}

	if (result.kind === "revision_conflict") {
		return c.json(
			{
				error: {
					code: "ORG_SETTINGS_VERSION_CONFLICT",
					message: "Organization settings changed. Refresh and try again.",
					details: {
						require_workspace_id: result.requireWorkspaceId,
						current_revision: result.revision,
					},
				},
			},
			409,
		);
	}

	if (result.kind === "blockers") {
		return c.json(
			{
				error: {
					code: "WORKSPACE_SCOPE_BLOCKERS",
					message:
						"Assign, archive, or erase organization-scoped operational resources before requiring workspace IDs.",
					details: {
						blockers: result.blockers,
						total: result.blockers.reduce(
							(sum, blocker) => sum + blocker.count,
							0,
						),
					},
				},
			},
			409,
		);
	}

	c.executionCtx.waitUntil(
		writeOrgSettingsHint(
			c.env,
			organizationId,
			result.requireWorkspaceId,
			result.revision,
		),
	);

	return c.json({
		data: {
			require_workspace_id: result.requireWorkspaceId,
			revision: result.revision,
		},
	});
});

async function writeOrgSettingsHint(
	env: Env,
	organizationId: string,
	requireWorkspaceId: boolean,
	revision: number,
): Promise<void> {
	await env.KV.put(
		`org-settings:${organizationId}`,
		JSON.stringify({
			require_workspace_id: requireWorkspaceId,
			revision,
		}),
		{ expirationTtl: ORG_SETTINGS_HINT_TTL_SECONDS },
	);
}

export default app;
