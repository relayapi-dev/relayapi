/**
 * Inbox AI service — AI-powered classification, reply suggestions, and
 * conversation summarization using Cloudflare Workers AI.
 *
 * Model: @cf/meta/llama-3.1-8b-instruct
 */

import type { Database } from "@relayapi/db";
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

// The base model may not be in @cloudflare/workers-types yet — cast to satisfy the Ai interface.
const MODEL =
	"@cf/meta/llama-3.1-8b-instruct" as "@cf/meta/llama-3.1-8b-instruct-fp8";

const DEFAULT_CLASSIFICATION: Omit<ClassifyResult, "id"> = {
	sentiment: { score: 0, label: "neutral" },
	intent: "general",
	urgency: "low",
	requires_response: false,
};

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

		const responseText =
			(result as { response?: string }).response ?? "";
		const parsed = extractJson(responseText) as Array<
			Partial<Omit<ClassifyResult, "id">>
		>;

		if (!Array.isArray(parsed)) {
			return messages.map((m) => ({ ...DEFAULT_CLASSIFICATION, id: m.id }));
		}

		return messages.map((m, i) => {
			const item = parsed[i];
			if (!item) {
				return { ...DEFAULT_CLASSIFICATION, id: m.id };
			}

			return {
				id: m.id,
				sentiment: {
					score:
						typeof item.sentiment?.score === "number"
							? Math.max(-1, Math.min(1, item.sentiment.score))
							: 0,
					label:
						item.sentiment?.label &&
						["positive", "neutral", "negative"].includes(
							item.sentiment.label,
						)
							? (item.sentiment.label as
									| "positive"
									| "neutral"
									| "negative")
							: "neutral",
				},
				intent:
					item.intent &&
					[
						"question",
						"complaint",
						"compliment",
						"spam",
						"feedback",
						"general",
					].includes(item.intent)
						? (item.intent as ClassifyResult["intent"])
						: "general",
				urgency:
					item.urgency &&
					["high", "medium", "low"].includes(item.urgency)
						? (item.urgency as "high" | "medium" | "low")
						: "low",
				requires_response:
					typeof item.requires_response === "boolean"
						? item.requires_response
						: false,
			};
		});
	} catch {
		return messages.map((m) => ({ ...DEFAULT_CLASSIFICATION, id: m.id }));
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
): Promise<SuggestReplyResult[]> {
	const convo = await getConversationWithMessages(db, conversationId, orgId);
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

		const responseText =
			(result as { response?: string }).response ?? "";
		const parsed = extractJson(responseText) as SuggestReplyResult[];

		if (!Array.isArray(parsed)) {
			return [];
		}

		return parsed
			.slice(0, maxSuggestions)
			.map((item) => ({
				text: typeof item.text === "string" ? item.text : "",
				tone: typeof item.tone === "string" ? item.tone : tone,
				confidence:
					typeof item.confidence === "number"
						? Math.max(0, Math.min(1, item.confidence))
						: 0.5,
			}))
			.filter((s) => s.text.length > 0);
	} catch {
		return [];
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
): Promise<SummarizeResult | null> {
	const convo = await getConversationWithMessages(db, conversationId, orgId);
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

		const responseText =
			(result as { response?: string }).response ?? "";
		const parsed = extractJson(responseText) as Partial<SummarizeResult>;

		return {
			summary:
				typeof parsed.summary === "string"
					? parsed.summary
					: "Unable to generate summary.",
			key_topics: Array.isArray(parsed.key_topics)
				? parsed.key_topics.filter(
						(t): t is string => typeof t === "string",
					)
				: [],
			action_needed:
				typeof parsed.action_needed === "string"
					? parsed.action_needed
					: "unknown",
			message_count: messageCount,
			timespan,
		};
	} catch {
		return {
			summary: "Unable to generate summary.",
			key_topics: [],
			action_needed: "unknown",
			message_count: messageCount,
			timespan,
		};
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
