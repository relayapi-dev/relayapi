import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { createDb, inboxMessages } from "@relayapi/db";
import { desc, eq } from "drizzle-orm";
import { ErrorResponse } from "../schemas/common";
import {
	ClassifyBody,
	ClassifyResponse,
	PrioritiesQuery,
	PrioritiesResponse,
	SuggestReplyBody,
	SuggestReplyResponse,
	SummarizeBody,
	SummarizeResponse,
} from "../schemas/inbox-ai";
import {
	calculatePriorityScore,
	classifyMessages,
	suggestReplies,
	summarizeConversation,
} from "../services/inbox-ai";
import { listConversations } from "../services/inbox-persistence";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireAi(env: Env): Ai | null {
	return env.AI ?? null;
}

function serializeConversation(row: {
	id: string;
	platform: string;
	type: string;
	accountId: string;
	participantName: string | null;
	participantAvatar: string | null;
	status: string;
	priority: string | null;
	labels: string[] | null;
	unreadCount: number;
	messageCount: number;
	lastMessageText: string | null;
	lastMessageAt: Date | null;
	lastMessageDirection: string | null;
	createdAt: Date;
	updatedAt: Date;
}) {
	return {
		id: row.id,
		platform: row.platform,
		type: row.type,
		account_id: row.accountId,
		participant_name: row.participantName,
		participant_avatar: row.participantAvatar,
		status: row.status,
		priority: row.priority,
		labels: row.labels ?? [],
		unread_count: row.unreadCount,
		message_count: row.messageCount,
		last_message_text: row.lastMessageText,
		last_message_at: row.lastMessageAt?.toISOString() ?? null,
		last_message_direction: row.lastMessageDirection,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

// ---------------------------------------------------------------------------
// 1. POST /classify — Batch message classification
// ---------------------------------------------------------------------------

const classifyRoute = createRoute({
	operationId: "classifyInboxMessages",
	method: "post",
	path: "/classify",
	tags: ["Inbox AI"],
	summary: "Classify messages with AI (batch, up to 50)",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: ClassifyBody } },
		},
	},
	responses: {
		200: {
			description: "Classification results",
			content: { "application/json": { schema: ClassifyResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		503: {
			description: "AI service unavailable",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(classifyRoute, async (c) => {
	const ai = requireAi(c.env);
	if (!ai) {
		return c.json(
			{
				error: {
					code: "AI_UNAVAILABLE",
					message: "Workers AI binding is not configured",
				},
			} as never,
			503 as never,
		);
	}

	const { messages } = c.req.valid("json");
	const results = await classifyMessages(ai, messages);

	return c.json(results as never, 200);
});

// ---------------------------------------------------------------------------
// 2. POST /suggest-reply — AI reply suggestions
// ---------------------------------------------------------------------------

const suggestReplyRoute = createRoute({
	operationId: "suggestInboxReply",
	method: "post",
	path: "/suggest-reply",
	tags: ["Inbox AI"],
	summary: "Generate AI reply suggestions for a conversation",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: SuggestReplyBody } },
		},
	},
	responses: {
		200: {
			description: "Reply suggestions",
			content: { "application/json": { schema: SuggestReplyResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		503: {
			description: "AI service unavailable",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(suggestReplyRoute, async (c) => {
	const ai = requireAi(c.env);
	if (!ai) {
		return c.json(
			{
				error: {
					code: "AI_UNAVAILABLE",
					message: "Workers AI binding is not configured",
				},
			} as never,
			503 as never,
		);
	}

	const db = c.get("db");
	const orgId = c.get("orgId");
	const { conversation_id, tone, max_suggestions, context } =
		c.req.valid("json");

	const suggestions = await suggestReplies(ai, db, conversation_id, orgId, {
		tone,
		max_suggestions,
		context,
	});

	return c.json({ suggestions } as never, 200);
});

// ---------------------------------------------------------------------------
// 3. POST /summarize — Conversation summary
// ---------------------------------------------------------------------------

const summarizeRoute = createRoute({
	operationId: "summarizeInboxConversation",
	method: "post",
	path: "/summarize",
	tags: ["Inbox AI"],
	summary: "Generate AI summary of a conversation",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: SummarizeBody } },
		},
	},
	responses: {
		200: {
			description: "Conversation summary",
			content: { "application/json": { schema: SummarizeResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Conversation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		503: {
			description: "AI service unavailable",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(summarizeRoute, async (c) => {
	const ai = requireAi(c.env);
	if (!ai) {
		return c.json(
			{
				error: {
					code: "AI_UNAVAILABLE",
					message: "Workers AI binding is not configured",
				},
			} as never,
			503 as never,
		);
	}

	const db = c.get("db");
	const orgId = c.get("orgId");
	const { conversation_id } = c.req.valid("json");

	const result = await summarizeConversation(ai, db, conversation_id, orgId);

	if (!result) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Conversation not found",
				},
			} as never,
			404 as never,
		);
	}

	return c.json(result as never, 200);
});

// ---------------------------------------------------------------------------
// 4. GET /priorities — Prioritized inbox feed
// ---------------------------------------------------------------------------

const prioritiesRoute = createRoute({
	operationId: "getInboxPriorities",
	method: "get",
	path: "/priorities",
	tags: ["Inbox AI"],
	summary: "Prioritized inbox feed sorted by calculated priority score",
	security: [{ Bearer: [] }],
	request: { query: PrioritiesQuery },
	responses: {
		200: {
			description: "Prioritized conversation list",
			content: { "application/json": { schema: PrioritiesResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(prioritiesRoute, async (c) => {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const { type, platform, account_id, status, labels, cursor, limit } =
		c.req.valid("query");

	const parsedLabels = labels
		? labels
				.split(",")
				.map((l) => l.trim())
				.filter(Boolean)
		: undefined;

	const result = await listConversations(db, orgId, {
		type,
		platform,
		status,
		accountId: account_id,
		labels: parsedLabels,
		cursor,
		limit,
	});

	// For each conversation, fetch the latest inbound message to get sentiment/classification
	const withPriority = await Promise.all(
		result.data.map(async (conv) => {
			const [latestMessage] = await db
				.select({
					sentimentScore: inboxMessages.sentimentScore,
					classification: inboxMessages.classification,
				})
				.from(inboxMessages)
				.where(eq(inboxMessages.conversationId, conv.id))
				.orderBy(desc(inboxMessages.createdAt))
				.limit(1);

			const priorityScore = calculatePriorityScore(conv, latestMessage);

			return {
				...serializeConversation(conv),
				priority_score: priorityScore,
			};
		}),
	);

	// Sort by priority score descending
	withPriority.sort((a, b) => b.priority_score - a.priority_score);

	return c.json(
		{
			data: withPriority,
			next_cursor: result.next_cursor,
			has_more: result.has_more,
		} as never,
		200,
	);
});

export default app;
