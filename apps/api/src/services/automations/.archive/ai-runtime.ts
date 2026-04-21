import {
	aiAgents,
	aiKnowledgeChunks,
	contacts,
	inboxMessages,
} from "@relayapi/db";
import { and, desc, eq } from "drizzle-orm";
import { applyMergeTags } from "../merge-tags";
import type { NodeExecutionContext } from "../types";

const DEFAULT_AI_MODEL =
	"@cf/meta/llama-3.1-8b-instruct" as "@cf/meta/llama-3.1-8b-instruct-fp8";

type AiMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

export interface AutomationAiContext {
	contact: Record<string, unknown> | null;
	latestInput: string;
	transcript: string;
}

export interface RetrievedKnowledgeChunk {
	id: string;
	content: string;
	score: number;
}

export async function buildAutomationAiContext(
	ctx: NodeExecutionContext,
): Promise<AutomationAiContext> {
	const contact = ctx.enrollment.contact_id
		? await ctx.db.query.contacts.findFirst({
				where: eq(contacts.id, ctx.enrollment.contact_id),
			})
		: null;
	const transcript = await loadConversationTranscript(
		ctx,
		ctx.enrollment.conversation_id,
	);
	const latestInput =
		firstString(
			await loadLatestInboundText(ctx, ctx.enrollment.conversation_id),
			ctx.enrollment.state.last_user_message,
			ctx.enrollment.state.text,
			ctx.enrollment.state.message,
			ctx.enrollment.state.comment_text,
		) ?? "";

	return {
		contact: (contact as unknown as Record<string, unknown>) ?? null,
		latestInput,
		transcript,
	};
}

export function requireAutomationAi(ctx: NodeExecutionContext): Ai | null {
	return ctx.env.AI ?? null;
}

export function resolveAutomationAiModel(model: unknown): string {
	if (typeof model === "string" && model.trim().startsWith("@cf/")) {
		return model.trim();
	}
	return DEFAULT_AI_MODEL;
}

export async function runAutomationAiText(
	ai: Ai,
	model: unknown,
	messages: AiMessage[],
): Promise<string> {
	const result = await ai.run(resolveAutomationAiModel(model) as never, {
		messages,
	});
	return extractResponseText(result).trim();
}

export async function runAutomationAiJson<T>(
	ai: Ai,
	model: unknown,
	messages: AiMessage[],
): Promise<T | null> {
	try {
		const response = await runAutomationAiText(ai, model, messages);
		const parsed = extractJson(response);
		return parsed as T;
	} catch {
		return null;
	}
}

export async function resolveAgentRecord(
	ctx: NodeExecutionContext,
	agentId: string,
) {
	return ctx.db.query.aiAgents.findFirst({
		where: and(
			eq(aiAgents.id, agentId),
			eq(aiAgents.organizationId, ctx.enrollment.organization_id),
		),
	});
}

export async function retrieveKnowledgeContext(
	ctx: NodeExecutionContext,
	kbId: string | null | undefined,
	query: string,
	limit = 4,
): Promise<RetrievedKnowledgeChunk[]> {
	if (!kbId) return [];

	const rows = await ctx.db.query.aiKnowledgeChunks.findMany({
		where: eq(aiKnowledgeChunks.kbId, kbId),
		orderBy: [desc(aiKnowledgeChunks.createdAt)],
		limit: 200,
	});
	if (rows.length === 0) return [];

	const queryTokens = tokenize(query);
	return rows
		.map((row) => ({
			id: row.id,
			content: row.content,
			score: scoreTokenOverlap(queryTokens, tokenize(row.content)),
		}))
		.filter((row) => row.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
}

export function applyAutomationPromptTemplate(
	template: string,
	ctx: Pick<AutomationAiContext, "contact"> & {
		state: Record<string, unknown>;
	},
): string {
	return applyMergeTags(template, {
		contact: ctx.contact,
		state: ctx.state,
	});
}

function extractResponseText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return "";
	const record = result as Record<string, unknown>;
	if (typeof record.response === "string") return record.response;
	if (typeof record.text === "string") return record.text;
	const response = record.response;
	if (Array.isArray(response)) {
		return response
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object") {
					const content = (part as Record<string, unknown>).content;
					return typeof content === "string" ? content : "";
				}
				return "";
			})
			.join("\n")
			.trim();
	}
	return "";
}

function extractJson(raw: string): unknown {
	const objectMatch = raw.match(/\{[\s\S]*\}/);
	if (objectMatch) return JSON.parse(objectMatch[0]);
	const arrayMatch = raw.match(/\[[\s\S]*\]/);
	if (arrayMatch) return JSON.parse(arrayMatch[0]);
	return JSON.parse(raw);
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return null;
}

function tokenize(input: string): Set<string> {
	return new Set(
		input
			.toLowerCase()
			.split(/[^a-z0-9]+/i)
			.map((token) => token.trim())
			.filter((token) => token.length >= 3),
	);
}

function scoreTokenOverlap(
	queryTokens: Set<string>,
	contentTokens: Set<string>,
): number {
	let score = 0;
	for (const token of queryTokens) {
		if (contentTokens.has(token)) score += 1;
	}
	return score;
}

async function loadLatestInboundText(
	ctx: NodeExecutionContext,
	conversationId: string | null,
): Promise<string | null> {
	if (!conversationId) return null;
	const rows = await ctx.db.query.inboxMessages.findMany({
		where: and(
			eq(inboxMessages.conversationId, conversationId),
			eq(inboxMessages.direction, "inbound"),
		),
		orderBy: [desc(inboxMessages.createdAt)],
		limit: 5,
	});
	return (
		rows
			.map((row) => (typeof row.text === "string" ? row.text.trim() : ""))
			.find((text) => text.length > 0) ?? null
	);
}

async function loadConversationTranscript(
	ctx: NodeExecutionContext,
	conversationId: string | null,
): Promise<string> {
	if (!conversationId) return "";
	const rows = await ctx.db.query.inboxMessages.findMany({
		where: eq(inboxMessages.conversationId, conversationId),
		orderBy: [desc(inboxMessages.createdAt)],
		limit: 12,
	});
	return rows
		.slice()
		.reverse()
		.map((row) => {
			const speaker = row.direction === "inbound" ? "Customer" : "Agent";
			return `[${speaker}] ${row.text ?? "(no text)"}`;
		})
		.join("\n");
}
