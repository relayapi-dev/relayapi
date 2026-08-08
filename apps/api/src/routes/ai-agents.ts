import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	AI_INFERENCE_MODEL,
	AI_INFERENCE_PROVIDER,
	aiAgents,
	aiKnowledgeBases,
	organizationPrincipals,
} from "@relayapi/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { SingleUnitProviderMutationAggregate } from "../lib/mutation-provider-boundary";
import {
	resolveOperationalCreateScope,
	workspaceScopeKey,
} from "../lib/request-access";
import {
	applyWorkspaceScope,
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
} from "../lib/workspace-scope";
import { markMutationInputNotApplied } from "../middleware/mutation-validation";
import {
	AiAgentCreateSpec,
	AiAgentListResponse,
	AiAgentRespondResponse,
	AiAgentRespondSpec,
	AiAgentResponse,
	AiAgentUpdateSpec,
} from "../schemas/ai-agents";
import { ErrorResponse, PaginationParams } from "../schemas/common";
import {
	AiAgentRuntimeError,
	aiRuntimeHttpStatus,
	runAiAgent,
} from "../services/ai-agent";
import { AiKnowledgeError } from "../services/ai-knowledge";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
const IdParams = z.object({ id: z.string() });
const ListQuery = PaginationParams.extend({
	workspace_id: z.string().optional(),
});

type AgentRow = typeof aiAgents.$inferSelect;
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

function serializeAgent(row: AgentRow): z.infer<typeof AiAgentResponse> {
	return {
		id: row.id,
		organization_id: row.organizationId,
		workspace_id: row.workspaceId,
		name: row.name,
		persona: row.persona,
		provider: AI_INFERENCE_PROVIDER,
		model: AI_INFERENCE_MODEL,
		guardrails: {
			version: 1,
			blocked_topics: row.guardrails.blockedTopics,
			fallback_message: row.guardrails.fallbackMessage,
		},
		handoff: {
			version: 1,
			keywords: row.handoffStrategy.keywords,
			confidence_threshold: row.handoffStrategy.confidenceThreshold,
			principal_id: row.handoffPrincipalId,
		},
		knowledge_base_id: row.kbId,
		temperature: row.temperature,
		max_tokens: row.maxTokens,
		enabled: row.enabled,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

async function loadAgent(c: AppContext, id: string): Promise<AgentRow | null> {
	const row = await c.get("db").query.aiAgents.findFirst({
		where: and(
			eq(aiAgents.id, id),
			eq(aiAgents.organizationId, c.get("orgId")),
		),
	});
	return row ?? null;
}

async function referencesAreValid(
	c: AppContext,
	scopeKey: string,
	kbId: string | null | undefined,
	principalId: string | null | undefined,
): Promise<boolean> {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const [kb, principal] = await Promise.all([
		kbId
			? db.query.aiKnowledgeBases.findFirst({
					where: and(
						eq(aiKnowledgeBases.id, kbId),
						eq(aiKnowledgeBases.organizationId, orgId),
						eq(aiKnowledgeBases.scopeKey, scopeKey),
					),
				})
			: Promise.resolve({ id: "" }),
		principalId
			? db.query.organizationPrincipals.findFirst({
					where: and(
						eq(organizationPrincipals.id, principalId),
						eq(organizationPrincipals.organizationId, orgId),
						eq(organizationPrincipals.lifecycleStatus, "active"),
					),
				})
			: Promise.resolve({ id: "" }),
	]);
	return !!kb && !!principal;
}

const createAgent = createRoute({
	operationId: "createAiAgent",
	method: "post",
	path: "/",
	tags: ["AI Agents"],
	summary: "Create an AI agent",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: AiAgentCreateSpec } } },
	},
	responses: {
		201: {
			description: "Created",
			content: { "application/json": { schema: AiAgentResponse } },
		},
		400: {
			description: "Invalid reference",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createAgent, async (c) => {
	const body = c.req.valid("json");
	const scope = await resolveOperationalCreateScope(
		c,
		body.workspace_id,
		"AI agent",
	);
	if (!scope.ok) return scope.response as never;
	const scopeKey = workspaceScopeKey(scope.workspaceId);
	if (
		!(await referencesAreValid(
			c,
			scopeKey,
			body.knowledge_base_id,
			body.handoff?.principal_id,
		))
	) {
		return c.json(
			{
				error: {
					code: "invalid_reference",
					message:
						"Knowledge base and handoff principal must be active and belong to the exact agent scope",
				},
			},
			400,
		);
	}
	const [row] = await c
		.get("db")
		.insert(aiAgents)
		.values({
			organizationId: c.get("orgId"),
			workspaceId: scope.workspaceId,
			name: body.name,
			persona: body.persona ?? null,
			guardrails: body.guardrails
				? {
						version: 1,
						blockedTopics: body.guardrails.blocked_topics,
						fallbackMessage: body.guardrails.fallback_message,
					}
				: undefined,
			handoffStrategy: body.handoff
				? {
						version: 1,
						keywords: body.handoff.keywords,
						confidenceThreshold: body.handoff.confidence_threshold,
					}
				: undefined,
			handoffPrincipalId: body.handoff?.principal_id ?? null,
			kbId: body.knowledge_base_id ?? null,
			temperature: body.temperature,
			maxTokens: body.max_tokens,
			enabled: body.enabled,
		})
		.returning();
	if (!row) throw new Error("Failed to create AI agent");
	return c.json(serializeAgent(row), 201);
});

const listAgents = createRoute({
	operationId: "listAiAgents",
	method: "get",
	path: "/",
	tags: ["AI Agents"],
	summary: "List AI agents",
	security: [{ Bearer: [] }],
	request: { query: ListQuery },
	responses: {
		200: {
			description: "List",
			content: { "application/json": { schema: AiAgentListResponse } },
		},
	},
});

app.openapi(listAgents, async (c) => {
	const { cursor, limit, workspace_id } = c.req.valid("query");
	const conditions = [eq(aiAgents.organizationId, c.get("orgId"))];
	applyWorkspaceScope(c, conditions, aiAgents.workspaceId);
	if (workspace_id) conditions.push(eq(aiAgents.workspaceId, workspace_id));
	if (cursor) {
		const [cursorRow] = await c
			.get("db")
			.select({ createdAt: sql<string>`${aiAgents.createdAt}::text` })
			.from(aiAgents)
			.where(eq(aiAgents.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${aiAgents.createdAt}, ${aiAgents.id}) < (${cursorRow.createdAt}::timestamptz, ${cursor})`,
			);
		}
	}
	const rows = await c
		.get("db")
		.select()
		.from(aiAgents)
		.where(and(...conditions))
		.orderBy(desc(aiAgents.createdAt), desc(aiAgents.id))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit).map(serializeAgent);
	return c.json(
		{
			data,
			next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

const getAgent = createRoute({
	operationId: "getAiAgent",
	method: "get",
	path: "/{id}",
	tags: ["AI Agents"],
	summary: "Get an AI agent",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "AI agent",
			content: { "application/json": { schema: AiAgentResponse } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getAgent, async (c) => {
	const row = await loadAgent(c, c.req.valid("param").id);
	if (!row) {
		return c.json(
			{ error: { code: "not_found", message: "AI agent not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	return c.json(serializeAgent(row), 200);
});

const updateAgent = createRoute({
	operationId: "updateAiAgent",
	method: "patch",
	path: "/{id}",
	tags: ["AI Agents"],
	summary: "Update an AI agent",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: { content: { "application/json": { schema: AiAgentUpdateSpec } } },
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: AiAgentResponse } },
		},
		400: {
			description: "Invalid reference",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateAgent, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const row = await loadAgent(c, id);
	if (!row) {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: "not_found", message: "AI agent not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	const nextKb =
		body.knowledge_base_id === undefined ? row.kbId : body.knowledge_base_id;
	const nextPrincipal =
		body.handoff === undefined
			? row.handoffPrincipalId
			: body.handoff.principal_id;
	if (!(await referencesAreValid(c, row.scopeKey, nextKb, nextPrincipal))) {
		return c.json(
			{
				error: {
					code: "invalid_reference",
					message:
						"Knowledge base and handoff principal must be active and belong to the exact agent scope",
				},
			},
			400,
		);
	}
	const updates: Partial<typeof aiAgents.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (body.name !== undefined) updates.name = body.name;
	if (body.persona !== undefined) updates.persona = body.persona;
	if (body.knowledge_base_id !== undefined)
		updates.kbId = body.knowledge_base_id;
	if (body.temperature !== undefined) updates.temperature = body.temperature;
	if (body.max_tokens !== undefined) updates.maxTokens = body.max_tokens;
	if (body.enabled !== undefined) updates.enabled = body.enabled;
	if (body.guardrails) {
		updates.guardrails = {
			version: 1,
			blockedTopics: body.guardrails.blocked_topics,
			fallbackMessage: body.guardrails.fallback_message,
		};
	}
	if (body.handoff) {
		updates.handoffStrategy = {
			version: 1,
			keywords: body.handoff.keywords,
			confidenceThreshold: body.handoff.confidence_threshold,
		};
		updates.handoffPrincipalId = body.handoff.principal_id;
	}
	const [updated] = await c
		.get("db")
		.update(aiAgents)
		.set(updates)
		.where(
			and(eq(aiAgents.id, id), eq(aiAgents.organizationId, c.get("orgId"))),
		)
		.returning();
	if (!updated) throw new Error("Failed to update AI agent");
	return c.json(serializeAgent(updated), 200);
});

const deleteAgent = createRoute({
	operationId: "deleteAiAgent",
	method: "delete",
	path: "/{id}",
	tags: ["AI Agents"],
	summary: "Delete an AI agent",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		204: { description: "Deleted" },
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteAgent, async (c) => {
	const { id } = c.req.valid("param");
	const row = await loadAgent(c, id);
	if (!row) {
		return c.json(
			{ error: { code: "not_found", message: "AI agent not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	await c
		.get("db")
		.delete(aiAgents)
		.where(
			and(eq(aiAgents.id, id), eq(aiAgents.organizationId, c.get("orgId"))),
		);
	return c.body(null, 204);
});

const respondAgent = createRoute({
	operationId: "respondWithAiAgent",
	method: "post",
	path: "/{id}/respond",
	tags: ["AI Agents"],
	summary: "Generate an AI-agent response",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: { content: { "application/json": { schema: AiAgentRespondSpec } } },
	},
	responses: {
		200: {
			description: "Agent response",
			content: { "application/json": { schema: AiAgentRespondResponse } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Agent disabled",
			content: { "application/json": { schema: ErrorResponse } },
		},
		503: {
			description: "AI provider unavailable",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(respondAgent, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const row = await loadAgent(c, id);
	if (!row) {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: "not_found", message: "AI agent not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		markMutationInputNotApplied(c);
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	const mutation = new SingleUnitProviderMutationAggregate(
		c.get("mutationEffectTracker"),
	);
	try {
		const result = await runAiAgent(
			c.get("db"),
			c.env,
			row,
			{
				message: body.message,
				conversationContext: body.conversation_context,
			},
			mutation,
		);
		// Guardrail/keyword handoffs deliberately remain billable successful
		// responses even though they do not need a provider call.
		mutation.markCommitted();
		return c.json(
			{
				message: result.message,
				confidence: result.confidence,
				handoff_required: result.handoffRequired,
				handoff_reason: result.handoffReason,
				handoff_principal_id: result.handoffPrincipalId,
				knowledge: result.knowledge.map((item) => ({
					document_id: item.documentId,
					similarity: item.similarity,
				})),
			},
			200,
		);
	} catch (error) {
		if (
			error instanceof AiAgentRuntimeError ||
			error instanceof AiKnowledgeError
		) {
			const status = aiRuntimeHttpStatus(error);
			return c.json(
				{
					error: {
						code:
							error instanceof AiAgentRuntimeError ? error.code : error.code,
						message:
							status === 409
								? "AI agent is disabled"
								: "AI provider is unavailable",
					},
				},
				status,
			);
		}
		throw error;
	} finally {
		mutation.finalize();
	}
});

export default app;
