/**
 * Inbox AI service — AI-powered classification, reply suggestions, and
 * conversation summarization using Cloudflare Workers AI.
 *
 * Model: @cf/zai-org/glm-4.7-flash
 */

import { AI_INFERENCE_MODEL, type Database } from "@relayapi/db";
import { getConversationWithMessages } from "./inbox-persistence";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClassifyInput {
	id?: string;
	text: string;
}

interface ClassifyResult {
	id?: string;
	sentiment: { score: number; label: "positive" | "neutral" | "negative" };
	intent:
		| "question"
		| "complaint"
		| "compliment"
		| "spam"
		| "feedback"
		| "general";
	urgency: "high" | "medium" | "low";
	requires_response: boolean;
}

interface SuggestReplyOptions {
	tone?: string;
	max_suggestions?: number;
	context?: string;
}

interface SuggestReplyResult {
	text: string;
	tone: string;
	confidence: number;
}

interface SummarizeResult {
	summary: string;
	key_topics: string[];
	action_needed: string;
	message_count: number;
	timespan: string;
}

interface ConversationForPriority {
	type: string;
	lastMessageAt: Date | null;
	unreadCount: number;
	labels: string[] | null;
}

interface MessageForPriority {
	sentimentScore: number | null;
	classification: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MODEL = AI_INFERENCE_MODEL;

export class InboxAiProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InboxAiProviderError";
	}
}

function extractJson(raw: string): unknown {
	// Try to find a JSON array or object in the response
	const arrayMatch = raw.match(/\[[\s\S]*\]/);
	if (arrayMatch) {
		return JSON.parse(arrayMatch[0]);
	}
	const objectMatch = raw.match(/\{[\s\S]*\}/);
	if (objectMatch) {
		return JSON.parse(objectMatch[0]);
	}
	return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// 1. classifyMessages
// ---------------------------------------------------------------------------

export async function classifyMessages(
	ai: Ai,
	messages: ClassifyInput[],
): Promise<ClassifyResult[]> {
	const prompt = `Classify each message. For each, return JSON with:
- sentiment: { score: -1.0 to 1.0, label: "positive"|"neutral"|"negative" }
- intent: one of "question", "complaint", "compliment", "spam", "feedback", "general"
- urgency: "high"|"medium"|"low"
- requires_response: boolean

Messages:
${messages.map((m, i) => `${i + 1}. "${m.text}"`).join("\n")}

Respond ONLY with a JSON array.`;

	try {
		const result = await ai.run(MODEL, {
			messages: [{ role: "user", content: prompt }],
		});

		const responseText = (result as { response?: unknown }).response;
		if (typeof responseText !== "string") {
			throw new Error("Workers AI returned no text response");
		}
		const parsed = extractJson(responseText) as Array<
			Partial<Omit<ClassifyResult, "id">>
		>;

		if (!Array.isArray(parsed) || parsed.length !== messages.length) {
			throw new Error("Workers AI returned an incomplete classification");
		}

		return messages.map((m, i) => {
			const item = parsed[i];
			if (
				!item ||
				typeof item.sentiment?.score !== "number" ||
				!Number.isFinite(item.sentiment.score) ||
				!["positive", "neutral", "negative"].includes(
					item.sentiment.label ?? "",
				) ||
				![
					"question",
					"complaint",
					"compliment",
					"spam",
					"feedback",
					"general",
				].includes(item.intent ?? "") ||
				!["high", "medium", "low"].includes(item.urgency ?? "") ||
				typeof item.requires_response !== "boolean"
			) {
				throw new Error("Workers AI returned an invalid classification");
			}

			return {
				id: m.id,
				sentiment: {
					score: Math.max(-1, Math.min(1, item.sentiment.score)),
					label: item.sentiment.label as
						| "positive"
						| "neutral"
						| "negative",
				},
				intent: item.intent as ClassifyResult["intent"],
				urgency: item.urgency as "high" | "medium" | "low",
				requires_response: item.requires_response,
			};
		});
	} catch (error) {
		throw new InboxAiProviderError(
			error instanceof Error ? error.message : "Workers AI classification failed",
		);
	}
}

// ---------------------------------------------------------------------------
// 2. suggestReplies
// ---------------------------------------------------------------------------

export async function suggestReplies(
	ai: Ai,
	db: Database,
	conversationId: string,
	orgId: string,
	options?: SuggestReplyOptions,
	workspaceScope?: "all" | string[],
): Promise<SuggestReplyResult[]> {
	const convo = await getConversationWithMessages(
		db,
		conversationId,
		orgId,
		workspaceScope,
	);
	if (!convo) {
		return [];
	}

	const maxSuggestions = options?.max_suggestions ?? 3;
	const tone = options?.tone ?? "professional";

	const history = convo.messages
		.map(
			(msg) =>
				`[${msg.direction === "inbound" ? "Customer" : "Agent"}]: ${msg.text ?? "(no text)"}`,
		)
		.join("\n");

	const prompt = `You are a social media customer support assistant.

Conversation history:
${history}
${options?.context ? `\nAdditional context: ${options.context}` : ""}

Generate ${maxSuggestions} reply suggestions with a ${tone} tone.
For each reply provide JSON with:
- text: the suggested reply text
- tone: the tone used (e.g. "professional", "friendly", "empathetic")
- confidence: a number from 0.0 to 1.0 indicating confidence

Respond ONLY with a JSON array.`;

	try {
		const result = await ai.run(MODEL, {
			messages: [{ role: "user", content: prompt }],
		});

		const responseText = (result as { response?: unknown }).response;
		if (typeof responseText !== "string") {
			throw new Error("Workers AI returned no text response");
		}
		const parsed = extractJson(responseText) as SuggestReplyResult[];

		if (!Array.isArray(parsed)) {
			throw new Error("Workers AI returned invalid reply suggestions");
		}

		return parsed.slice(0, maxSuggestions).map((item) => {
			if (
				typeof item.text !== "string" ||
				item.text.trim().length === 0 ||
				typeof item.tone !== "string" ||
				typeof item.confidence !== "number" ||
				!Number.isFinite(item.confidence)
			) {
				throw new Error("Workers AI returned an invalid reply suggestion");
			}
			return {
				text: item.text,
				tone: item.tone,
				confidence: Math.max(0, Math.min(1, item.confidence)),
			};
		});
	} catch (error) {
		throw new InboxAiProviderError(
			error instanceof Error ? error.message : "Workers AI reply generation failed",
		);
	}
}

// ---------------------------------------------------------------------------
// 3. summarizeConversation
// ---------------------------------------------------------------------------

export async function summarizeConversation(
	ai: Ai,
	db: Database,
	conversationId: string,
	orgId: string,
	workspaceScope?: "all" | string[],
): Promise<SummarizeResult | null> {
	const convo = await getConversationWithMessages(
		db,
		conversationId,
		orgId,
		workspaceScope,
	);
	if (!convo) {
		return null;
	}

	const messages = convo.messages;
	const messageCount = messages.length;

	const firstMsg = messages[0];
	const lastMsg = messages[messages.length - 1];
	const timespan =
		firstMsg && lastMsg
			? `${firstMsg.createdAt.toISOString()} to ${lastMsg.createdAt.toISOString()}`
			: "unknown";

	const history = messages
		.map(
			(msg) =>
				`[${msg.direction === "inbound" ? "Customer" : "Agent"}]: ${msg.text ?? "(no text)"}`,
		)
		.join("\n");

	const prompt = `Summarize this customer conversation.

Conversation:
${history}

Respond ONLY with a JSON object containing:
- summary: a brief summary of the conversation (1-3 sentences)
- key_topics: an array of key topics discussed
- action_needed: what action is needed next (or "none" if resolved)

Respond ONLY with JSON.`;

	try {
		const result = await ai.run(MODEL, {
			messages: [{ role: "user", content: prompt }],
		});

		const responseText = (result as { response?: unknown }).response;
		if (typeof responseText !== "string") {
			throw new Error("Workers AI returned no text response");
		}
		const parsed = extractJson(responseText) as Partial<SummarizeResult>;
		if (
			typeof parsed.summary !== "string" ||
			!Array.isArray(parsed.key_topics) ||
			!parsed.key_topics.every((topic) => typeof topic === "string") ||
			typeof parsed.action_needed !== "string"
		) {
			throw new Error("Workers AI returned an invalid conversation summary");
		}

		return {
			summary: parsed.summary,
			key_topics: parsed.key_topics as string[],
			action_needed: parsed.action_needed,
			message_count: messageCount,
			timespan,
		};
	} catch (error) {
		throw new InboxAiProviderError(
			error instanceof Error ? error.message : "Workers AI summarization failed",
		);
	}
}

// ---------------------------------------------------------------------------
// 4. calculatePriorityScore
// ---------------------------------------------------------------------------

export function calculatePriorityScore(
	conversation: ConversationForPriority,
	latestMessage?: MessageForPriority,
): number {
	let score = 0;

	if ((latestMessage?.sentimentScore ?? 0) < -50) score += 30;
	if (latestMessage?.classification === "complaint") score += 25;
	if (conversation.type === "review") score += 20;

	const waitHours = conversation.lastMessageAt
		? (Date.now() - new Date(conversation.lastMessageAt).getTime()) / 3600000
		: 0;
	score += Math.min(waitHours * 2, 48); // cap at 48

	if (conversation.unreadCount > 5) score += 15;
	if (conversation.labels?.includes("urgent")) score += 50;

	return score;
}
