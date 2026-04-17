/**
 * Quick-create templates for common automations.
 * Expand a handful of high-level fields into a full automation spec so the
 * caller (SDK / MCP / dashboard) doesn't have to construct the graph.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
	automationEdges,
	automationNodes,
	automations,
	type Database,
} from "@relayapi/db";
import { eq } from "drizzle-orm";
import {
	CommentToDmTemplateInput,
	FollowToDmTemplateInput,
	GiveawayTemplateInput,
	KeywordReplyTemplateInput,
	StoryReplyTemplateInput,
	WelcomeDmTemplateInput,
} from "../schemas/automations";
import { AutomationWithGraphResponse } from "../schemas/automations";
import { ErrorResponse } from "../schemas/common";
import type { Env, Variables } from "../types";
import { publishVersion } from "./automations";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

interface BuiltSpec {
	name: string;
	channel: string;
	workspace_id: string | null;
	trigger: {
		type: string;
		account_id: string;
		config: Record<string, unknown>;
		filters: Record<string, unknown>;
	};
	nodes: Array<{
		key: string;
		type: string;
		config: Record<string, unknown>;
	}>;
	edges: Array<{ from: string; to: string; label?: string }>;
	status?: "draft" | "active";
	allow_reentry?: boolean;
}

import type { z } from "@hono/zod-openapi";
import type { AutomationWithGraphResponse as _TGraph } from "../schemas/automations";

type MaterializedAutomation = z.infer<typeof _TGraph>;

async function materialize(
	db: Database,
	orgId: string,
	createdBy: string,
	spec: BuiltSpec,
): Promise<MaterializedAutomation> {
	const [auto] = await db
		.insert(automations)
		.values({
			organizationId: orgId,
			workspaceId: spec.workspace_id,
			name: spec.name,
			status: spec.status ?? "draft",
			channel: spec.channel as never,
			triggerType: spec.trigger.type as never,
			triggerConfig: spec.trigger.config,
			triggerFilters: spec.trigger.filters,
			socialAccountId: spec.trigger.account_id,
			allowReentry: spec.allow_reentry ?? false,
			createdBy,
		})
		.returning();
	if (!auto) throw new Error("insert automation failed");

	const [triggerNode] = await db
		.insert(automationNodes)
		.values({
			automationId: auto.id,
			key: "trigger",
			type: "trigger" as never,
			config: {},
		})
		.returning();

	const nodeRows = await db
		.insert(automationNodes)
		.values(
			spec.nodes.map((n) => ({
				automationId: auto.id,
				key: n.key,
				type: n.type as never,
				config: n.config,
			})),
		)
		.returning();

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

	const updated = await db.query.automations.findFirst({
		where: eq(automations.id, auto.id),
	});
	if (!updated) throw new Error("automation disappeared");

	// Read the stored nodes + edges back so the response reflects the real IDs
	// + order assigned by the database — not fabricated placeholders.
	const storedNodes = await db
		.select()
		.from(automationNodes)
		.where(eq(automationNodes.automationId, auto.id));
	const storedEdges = await db
		.select()
		.from(automationEdges)
		.where(eq(automationEdges.automationId, auto.id));
	const idToKey = new Map(storedNodes.map((n) => [n.id, n.key]));

	return {
		id: updated.id,
		organization_id: updated.organizationId,
		workspace_id: updated.workspaceId,
		name: updated.name,
		description: updated.description ?? null,
		status: updated.status as MaterializedAutomation["status"],
		channel: updated.channel as MaterializedAutomation["channel"],
		trigger_type:
			updated.triggerType as MaterializedAutomation["trigger_type"],
		trigger_config: updated.triggerConfig,
		trigger_filters: updated.triggerFilters,
		social_account_id: updated.socialAccountId,
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
		// The DM send uses the universal `message_text` node which resolves
		// channel + recipient at runtime. The optional public comment reply
		// uses `instagram_reply_to_comment`.
		const nodes: BuiltSpec["nodes"] = [
			{
				key: "send_dm",
				type: "message_text",
				config: { text: body.dm_message },
			},
		];
		const edges: BuiltSpec["edges"] = [{ from: "trigger", to: "send_dm" }];
		if (body.public_reply) {
			nodes.push({
				key: "public_reply",
				type: "instagram_reply_to_comment",
				config: { text: body.public_reply },
			});
			edges.push({ from: "send_dm", to: "public_reply" });
		}
		// once_per_user: true (the default) → allow_reentry=false on the
		// automation header, which the trigger-matcher already enforces.
		const result = await materialize(c.get("db"), c.get("orgId"), c.get("keyId"), {
			name: body.name,
			channel: "instagram",
			workspace_id: body.workspace_id ?? null,
			trigger: {
				type: "instagram_comment",
				account_id: body.account_id,
				config: {
					keywords: body.keywords,
					match_mode: body.match_mode,
					post_id: body.post_id ?? null,
				},
				filters: {},
			},
			nodes,
			edges,
			status: "draft",
			allow_reentry: !body.once_per_user,
		});
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
		const triggerTypeByChannel: Record<string, string> = {
			instagram: "instagram_dm",
			facebook: "facebook_dm",
			whatsapp: "whatsapp_message",
		};
		// Welcome send goes through the universal message_text node which works
		// for any DM-capable channel via the message-sender service.
		const result = await materialize(c.get("db"), c.get("orgId"), c.get("keyId"), {
			name: body.name,
			channel: body.channel,
			workspace_id: body.workspace_id ?? null,
			trigger: {
				type: triggerTypeByChannel[body.channel]!,
				account_id: body.account_id,
				config: {},
				filters: {},
			},
			nodes: [
				{
					key: "welcome",
					type: "message_text",
					config: { text: body.welcome_message },
				},
			],
			edges: [{ from: "trigger", to: "welcome" }],
			status: "draft",
		});
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
		const triggerMap: Record<string, string> = {
			instagram: "instagram_dm",
			facebook: "facebook_dm",
			whatsapp: "whatsapp_keyword",
			telegram: "telegram_message",
			twitter: "twitter_dm",
			sms: "sms_received",
		};
		const result = await materialize(c.get("db"), c.get("orgId"), c.get("keyId"), {
			name: body.name,
			channel: body.channel,
			workspace_id: body.workspace_id ?? null,
			trigger: {
				type: triggerMap[body.channel] ?? "manual",
				account_id: body.account_id,
				config: { keywords: body.keywords, match_mode: body.match_mode },
				filters: {},
			},
			nodes: [
				{
					key: "reply",
					type: "message_text",
					config: { text: body.reply_message },
				},
			],
			edges: [{ from: "trigger", to: "reply" }],
			status: "draft",
		});
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
		const result = await materialize(c.get("db"), c.get("orgId"), c.get("keyId"), {
			name: body.name,
			channel: "instagram",
			workspace_id: body.workspace_id ?? null,
			trigger: {
				type: "manual",
				account_id: body.account_id,
				config: {},
				filters: {},
			},
			nodes: [
				{
					key: "welcome",
					type: "message_text",
					config: { text: body.welcome_message },
				},
			],
			edges: [{ from: "trigger", to: "welcome" }],
			status: "draft",
		});
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
		const result = await materialize(c.get("db"), c.get("orgId"), c.get("keyId"), {
			name: body.name,
			channel: "instagram",
			workspace_id: body.workspace_id ?? null,
			trigger: {
				type: "instagram_story_reply",
				account_id: body.account_id,
				config: {},
				filters: {},
			},
			nodes: [
				{
					key: "reply",
					type: "message_text",
					config: { text: body.dm_message },
				},
			],
			edges: [{ from: "trigger", to: "reply" }],
			status: "draft",
		});
		return c.json(result, 201);
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
		const triggerType =
			body.channel === "facebook" ? "facebook_comment" : "instagram_comment";
		const result = await materialize(c.get("db"), c.get("orgId"), c.get("keyId"), {
			name: body.name,
			channel: body.channel,
			workspace_id: body.workspace_id ?? null,
			trigger: {
				type: triggerType,
				account_id: body.account_id,
				config: {
					keywords: body.entry_keywords,
					match_mode: "contains",
					post_id: body.post_id ?? null,
				},
				filters: {},
			},
			nodes: [
				{
					key: "tag_entry",
					type: "tag_add",
					config: { tag: body.entry_tag },
				},
				{
					key: "confirm_dm",
					type: "message_text",
					config: { text: body.confirmation_dm },
				},
			],
			edges: [
				{ from: "trigger", to: "tag_entry" },
				{ from: "tag_entry", to: "confirm_dm" },
			],
			status: "draft",
		});
		return c.json(result, 201);
	},
);

export default app;
