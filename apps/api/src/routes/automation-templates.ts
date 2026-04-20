/**
 * Quick-create templates for common automations.
 * Expand a handful of high-level fields into a full automation spec so the
 * caller (SDK / MCP / dashboard) doesn't have to construct the graph.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
	automationEdges,
	automationNodes,
	automationTriggers,
	automations,
	type Database,
} from "@relayapi/db";
import { eq } from "drizzle-orm";
import type { z } from "@hono/zod-openapi";
import {
	AutomationWithGraphResponse,
	CommentToDmTemplateInput,
	FollowToDmTemplateInput,
	GiveawayTemplateInput,
	KeywordReplyTemplateInput,
	StoryReplyTemplateInput,
	WelcomeDmTemplateInput,
} from "../schemas/automations";
import { ErrorResponse } from "../schemas/common";
import {
	buildCommentToDmTemplate,
	buildFollowToDmTemplate,
	buildGiveawayTemplate,
	buildKeywordReplyTemplate,
	buildStoryReplyTemplate,
	buildWelcomeDmTemplate,
	type MaterializedTemplateSpec,
} from "../services/automations/template-builders";
import type { Env, Variables } from "../types";
import { publishVersion } from "./automations";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
import type { AutomationWithGraphResponse as _TGraph } from "../schemas/automations";

type MaterializedAutomation = z.infer<typeof _TGraph>;

async function materialize(
	db: Database,
	orgId: string,
	createdBy: string,
	spec: MaterializedTemplateSpec,
): Promise<MaterializedAutomation> {
	// Insert automation header + per-trigger rows in a single transaction.
	const { auto } = await db.transaction(async (tx) => {
		const [inserted] = await tx
			.insert(automations)
			.values({
				organizationId: orgId,
				workspaceId: spec.workspace_id ?? null,
				name: spec.name,
				status: spec.status,
				channel: spec.channel as never,
				exitOnReply: spec.exit_on_reply,
				allowReentry: spec.allow_reentry,
				reentryCooldownMin: spec.reentry_cooldown_min ?? null,
				createdBy,
			})
			.returning();
		if (!inserted) throw new Error("insert automation failed");

		await tx.insert(automationTriggers).values(
			spec.triggers.map((t, idx) => ({
				automationId: inserted.id,
				type: t.type as never,
				config: t.config ?? {},
				filters: t.filters ?? {},
				socialAccountId: t.account_id ?? null,
				label: t.label ?? `Trigger #${idx + 1}`,
				orderIndex: t.order_index ?? idx,
			})),
		);

		return { auto: inserted };
	});

	const [triggerNode] = await db
		.insert(automationNodes)
		.values({
			automationId: auto.id,
			key: "trigger",
			type: "trigger" as never,
			config: {},
		})
		.returning();

	const nodeRows = spec.nodes.length
		? await db
				.insert(automationNodes)
				.values(
					spec.nodes.map((n) => ({
						automationId: auto.id,
						key: n.key,
						type: n.type as never,
						config: extractNodeConfig(n),
					})),
				)
				.returning()
		: [];

	const keyToId = new Map<string, string>([
		["trigger", triggerNode!.id],
		...nodeRows.map((n) => [n.key, n.id] as [string, string]),
	]);

	if (spec.edges.length > 0) {
		await db.insert(automationEdges).values(
			spec.edges.map((e, i) => ({
				automationId: auto.id,
				fromNodeId: keyToId.get(e.from)!,
				toNodeId: keyToId.get(e.to)!,
				label: e.label ?? "next",
				order: i,
			})),
		);
	}

	await db
		.update(automations)
		.set({ entryNodeId: triggerNode!.id })
		.where(eq(automations.id, auto.id));

	if (spec.status === "active") {
		await publishVersion(db, auto.id);
	}

	// Read the stored rows back so the response reflects real DB-assigned IDs.
	const updated = await db.query.automations.findFirst({
		where: eq(automations.id, auto.id),
	});
	if (!updated) throw new Error("automation disappeared");

	const storedNodes = await db
		.select()
		.from(automationNodes)
		.where(eq(automationNodes.automationId, auto.id));
	const storedEdges = await db
		.select()
		.from(automationEdges)
		.where(eq(automationEdges.automationId, auto.id));
	const storedTriggers = await db
		.select()
		.from(automationTriggers)
		.where(eq(automationTriggers.automationId, auto.id));
	const idToKey = new Map(storedNodes.map((n) => [n.id, n.key]));

	return {
		id: updated.id,
		organization_id: updated.organizationId,
		workspace_id: updated.workspaceId,
		name: updated.name,
		description: updated.description ?? null,
		status: updated.status as MaterializedAutomation["status"],
		channel: updated.channel as MaterializedAutomation["channel"],
		triggers: storedTriggers
			.slice()
			.sort((a, b) => a.orderIndex - b.orderIndex)
			.map((t) => ({
				id: t.id,
				type: t.type,
				account_id: t.socialAccountId,
				config: t.config,
				filters: t.filters,
				label: t.label,
				order_index: t.orderIndex,
			})),
		entry_node_id: updated.entryNodeId,
		version: updated.version,
		published_version: updated.publishedVersion,
		exit_on_reply: updated.exitOnReply,
		allow_reentry: updated.allowReentry,
		reentry_cooldown_min: updated.reentryCooldownMin,
		total_enrolled: updated.totalEnrolled,
		total_completed: updated.totalCompleted,
		total_exited: updated.totalExited,
		created_at: updated.createdAt.toISOString(),
		updated_at: updated.updatedAt.toISOString(),
		nodes: storedNodes.map((n) => ({
			id: n.id,
			key: n.key,
			type: n.type as MaterializedAutomation["nodes"][number]["type"],
			config: n.config,
			canvas_x: n.canvasX,
			canvas_y: n.canvasY,
			notes: n.notes,
		})),
		edges: storedEdges.map((e) => ({
			id: e.id,
			from_node_key: idToKey.get(e.fromNodeId) ?? "",
			to_node_key: idToKey.get(e.toNodeId) ?? "",
			label: e.label,
			order: e.order,
			condition_expr: e.conditionExpr ?? null,
		})),
	};
}

function extractNodeConfig(
	node: MaterializedTemplateSpec["nodes"][number],
): Record<string, unknown> {
	const { type: _t, key: _k, notes: _n, canvas_x: _x, canvas_y: _y, ...rest } =
		node;
	return rest;
}

// ---------------------------------------------------------------------------
// Comment to DM
// ---------------------------------------------------------------------------

app.openapi(
	createRoute({
		operationId: "createCommentToDmAutomation",
		method: "post",
		path: "/comment-to-dm",
		tags: ["Automation Templates"],
		summary: "Quick-create: comment keyword → DM",
		security: [{ Bearer: [] }],
		request: {
			body: {
				content: { "application/json": { schema: CommentToDmTemplateInput } },
			},
		},
		responses: {
			201: {
				description: "Created",
				content: {
					"application/json": { schema: AutomationWithGraphResponse },
				},
			},
			400: {
				description: "Validation error",
				content: { "application/json": { schema: ErrorResponse } },
			},
		},
	}),
	async (c) => {
		const body = c.req.valid("json");
		const result = await materialize(
			c.get("db"),
			c.get("orgId"),
			c.get("keyId"),
			buildCommentToDmTemplate(body),
		);
		return c.json(result, 201);
	},
);

// ---------------------------------------------------------------------------
// Welcome DM
// ---------------------------------------------------------------------------

app.openapi(
	createRoute({
		operationId: "createWelcomeDmAutomation",
		method: "post",
		path: "/welcome-dm",
		tags: ["Automation Templates"],
		summary: "Quick-create: welcome DM on new conversation",
		security: [{ Bearer: [] }],
		request: {
			body: {
				content: { "application/json": { schema: WelcomeDmTemplateInput } },
			},
		},
		responses: {
			201: {
				description: "Created",
				content: {
					"application/json": { schema: AutomationWithGraphResponse },
				},
			},
		},
	}),
	async (c) => {
		const body = c.req.valid("json");
		const result = await materialize(
			c.get("db"),
			c.get("orgId"),
			c.get("keyId"),
			buildWelcomeDmTemplate(body),
		);
		return c.json(result, 201);
	},
);

// ---------------------------------------------------------------------------
// Keyword reply
// ---------------------------------------------------------------------------

app.openapi(
	createRoute({
		operationId: "createKeywordReplyAutomation",
		method: "post",
		path: "/keyword-reply",
		tags: ["Automation Templates"],
		summary: "Quick-create: keyword DM → reply",
		security: [{ Bearer: [] }],
		request: {
			body: {
				content: { "application/json": { schema: KeywordReplyTemplateInput } },
			},
		},
		responses: {
			201: {
				description: "Created",
				content: {
					"application/json": { schema: AutomationWithGraphResponse },
				},
			},
		},
	}),
	async (c) => {
		const body = c.req.valid("json");
		const result = await materialize(
			c.get("db"),
			c.get("orgId"),
			c.get("keyId"),
			buildKeywordReplyTemplate(body),
		);
		return c.json(result, 201);
	},
);

// ---------------------------------------------------------------------------
// Follow to DM
// ---------------------------------------------------------------------------

app.openapi(
	createRoute({
		operationId: "createFollowToDmAutomation",
		method: "post",
		path: "/follow-to-dm",
		tags: ["Automation Templates"],
		summary: "Quick-create: DM new Instagram followers",
		security: [{ Bearer: [] }],
		request: {
			body: {
				content: { "application/json": { schema: FollowToDmTemplateInput } },
			},
		},
		responses: {
			201: {
				description: "Created",
				content: {
					"application/json": { schema: AutomationWithGraphResponse },
				},
			},
		},
	}),
	async (c) => {
		const body = c.req.valid("json");
		const result = await materialize(
			c.get("db"),
			c.get("orgId"),
			c.get("keyId"),
			buildFollowToDmTemplate(body),
		);
		return c.json(result, 201);
	},
);

// ---------------------------------------------------------------------------
// Story reply
// ---------------------------------------------------------------------------

app.openapi(
	createRoute({
		operationId: "createStoryReplyAutomation",
		method: "post",
		path: "/story-reply",
		tags: ["Automation Templates"],
		summary: "Quick-create: respond to IG story reply",
		security: [{ Bearer: [] }],
		request: {
			body: {
				content: { "application/json": { schema: StoryReplyTemplateInput } },
			},
		},
		responses: {
			409: {
				description: "Template unavailable",
				content: {
					"application/json": { schema: ErrorResponse },
				},
			},
		},
	}),
	async (c) => {
		c.req.valid("json");
		const unavailable = buildStoryReplyTemplate();
		return c.json(
			{
				error: {
					code: "template_unavailable",
					message: unavailable.message,
				},
			},
			409,
		);
	},
);

// ---------------------------------------------------------------------------
// Giveaway
// ---------------------------------------------------------------------------

app.openapi(
	createRoute({
		operationId: "createGiveawayAutomation",
		method: "post",
		path: "/giveaway",
		tags: ["Automation Templates"],
		summary: "Quick-create: giveaway comment → tag + DM confirmation",
		security: [{ Bearer: [] }],
		request: {
			body: {
				content: { "application/json": { schema: GiveawayTemplateInput } },
			},
		},
		responses: {
			201: {
				description: "Created",
				content: {
					"application/json": { schema: AutomationWithGraphResponse },
				},
			},
		},
	}),
	async (c) => {
		const body = c.req.valid("json");
		const result = await materialize(
			c.get("db"),
			c.get("orgId"),
			c.get("keyId"),
			buildGiveawayTemplate(body),
		);
		return c.json(result, 201);
	},
);

export default app;
