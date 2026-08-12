import { describe, expect, it } from "bun:test";
import {
	AI_EMBEDDING_DIMENSIONS,
	AI_INFERENCE_MODEL,
	AI_KNOWLEDGE_DOCUMENT_DEADLINE_MS,
	aiAgents,
	aiKnowledgeDocuments,
	type Database,
} from "@relayapi/db";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { MutationEffectTracker } from "../lib/mutation-effect";
import { SingleUnitProviderMutationAggregate } from "../lib/mutation-provider-boundary";
import { AiAgentRuntimeError, runAiAgent } from "../services/ai-agent";
import {
	AiKnowledgeError,
	chunkKnowledgeText,
	createOpenAiEmbeddings,
	isSupportedKnowledgeMediaMimeType,
	normalizeKnowledgeText,
} from "../services/ai-knowledge";
import { classifyMessages, InboxAiProviderError } from "../services/inbox-ai";
import type { Env } from "../types";

function fixture<T>(value: unknown): T {
	return value as T;
}

function providerMutationFixture() {
	const tracker = new MutationEffectTracker();
	tracker.markRouteEntered();
	tracker.markCoverageComplete();
	return {
		tracker,
		mutation: new SingleUnitProviderMutationAggregate(tracker),
	};
}

const baseAgent = {
	id: "aiagent_1",
	organizationId: "org_1",
	workspaceId: null,
	scopeKey: "__organization__",
	name: "Support",
	persona: null,
	provider: "workers_ai" as const,
	model: AI_INFERENCE_MODEL,
	guardrails: {
		version: 1 as const,
		blockedTopics: ["credentials"],
		fallbackMessage: "A team member will help.",
	},
	handoffStrategy: {
		version: 1 as const,
		keywords: ["human"],
		confidenceThreshold: 0.6,
	},
	handoffPrincipalId: "prn_support",
	kbId: null,
	temperature: 0.7,
	maxTokens: 1024,
	enabled: true,
	createdAt: new Date(),
	updatedAt: new Date(),
};

describe("AI provider and lifecycle optimality", () => {
	it("enforces the API guardrail and handoff bounds in PostgreSQL", () => {
		const config = getTableConfig(aiAgents);
		const guardrailCheck = config.checks.find(
			({ name }) => name === "ai_agents_guardrails_shape_check",
		);
		const handoffCheck = config.checks.find(
			({ name }) => name === "ai_agents_handoff_shape_check",
		);
		expect(guardrailCheck).toBeDefined();
		expect(handoffCheck).toBeDefined();
		if (!guardrailCheck || !handoffCheck) {
			throw new Error("AI guardrail checks are missing");
		}
		const dialect = new PgDialect();
		const sqlText = `${dialect.sqlToQuery(guardrailCheck.value).sql} ${
			dialect.sqlToQuery(handoffCheck.value).sql
		}`;
		expect(sqlText).toContain("jsonb_array_length");
		expect(sqlText).toContain("jsonb_path_exists");
		expect(sqlText).toContain("BETWEEN 1 AND 1000");
		expect(sqlText).toContain("121");
	});

	it("gives every ingestion a durable deadline and terminal-attempt bound", () => {
		expect(AI_KNOWLEDGE_DOCUMENT_DEADLINE_MS).toBe(24 * 60 * 60 * 1_000);
		const config = getTableConfig(aiKnowledgeDocuments);
		expect(
			config.columns.find(({ name }) => name === "deadline_at")?.notNull,
		).toBe(true);
		expect(config.checks.map(({ name }) => name)).toContain(
			"ai_knowledge_documents_deadline_check",
		);
		expect(config.indexes.map(({ config: index }) => index.name)).toContain(
			"ai_knowledge_documents_deadline_idx",
		);
	});

	it("terminalizes every exhausted lifecycle and claims tenant-ranked work", async () => {
		const source = await Bun.file(
			new URL("../services/ai-knowledge.ts", import.meta.url),
		).text();
		expect(source).toContain(
			`aiKnowledgeDocuments.attemptCount} >= \${AI_KNOWLEDGE_DOCUMENT_MAX_ATTEMPTS}`,
		);
		expect(source).toContain(
			`PARTITION BY \${aiKnowledgeDocuments.organizationId}`,
		);
		expect(source).toContain("eq(rankedEligible.tenantRank, 1)");
		expect(source).toContain(
			'.for("update", { of: aiKnowledgeDocuments, skipLocked: true })',
		);
		expect(
			source.indexOf("document = await claimKnowledgeDocument"),
		).toBeGreaterThan(source.indexOf("try {"));
	});

	it("normalizes and chunks deterministically with bounded overlap", () => {
		expect(
			normalizeKnowledgeText(
				"<style>bad</style><p>Hello&nbsp;world</p>",
				"text/html",
			),
		).toBe("Hello world");
		expect(normalizeKnowledgeText("&amp;lt;script&amp;gt;", "text/html")).toBe(
			"&lt;script&gt;",
		);
		const text = Array.from(
			{ length: 900 },
			(_, index) => `sentence-${index}.`,
		).join(" ");
		const chunks = chunkKnowledgeText(text);
		expect(chunks.length).toBeGreaterThan(1);
		expect(new Set(chunks).size).toBe(chunks.length);
		expect(chunks.every((chunk) => chunk.length <= 1601)).toBe(true);
		expect(isSupportedKnowledgeMediaMimeType("application/pdf")).toBe(true);
		expect(isSupportedKnowledgeMediaMimeType("image/png")).toBe(true);
		expect(isSupportedKnowledgeMediaMimeType("video/mp4")).toBe(false);
	});

	it("sends the fixed OpenAI embedding contract and rejects dimensional drift", async () => {
		let requestBody: unknown;
		const vector = Array.from({ length: AI_EMBEDDING_DIMENSIONS }, () => 0.25);
		const result = await createOpenAiEmbeddings(
			{ OPENAI_API_KEY: "test-key" },
			["hello"],
			fixture(async (_url: string, init: RequestInit) => {
				requestBody = JSON.parse(String(init.body));
				return Response.json({
					data: [{ index: 0, embedding: vector }],
				});
			}),
		);
		expect(requestBody).toEqual({
			input: ["hello"],
			model: "text-embedding-3-small",
			encoding_format: "float",
			dimensions: 1536,
		});
		expect(result[0]).toHaveLength(1536);

		await expect(
			createOpenAiEmbeddings(
				{ OPENAI_API_KEY: "test-key" },
				["hello"],
				fixture(async () =>
					Response.json({
						data: [{ index: 0, embedding: [0.25] }],
					}),
				),
			),
		).rejects.toBeInstanceOf(AiKnowledgeError);
	});

	it("classifies embedding creation before response parsing", async () => {
		const accepted = providerMutationFixture();
		await expect(
			createOpenAiEmbeddings(
				{ OPENAI_API_KEY: "test-key" },
				["hello"],
				fixture(async () => new Response("not-json", { status: 200 })),
				accepted.mutation,
			),
		).rejects.toBeDefined();
		expect(accepted.tracker.outcome(1)).toEqual({
			kind: "committed",
			units: 1,
		});

		const rejected = providerMutationFixture();
		await expect(
			createOpenAiEmbeddings(
				{ OPENAI_API_KEY: "test-key" },
				["hello"],
				fixture(async () =>
					Response.json({ error: { code: "bad_input" } }, { status: 422 }),
				),
				rejected.mutation,
			),
		).rejects.toBeInstanceOf(AiKnowledgeError);
		rejected.mutation.finalize();
		expect(rejected.tracker.outcome(1)).toEqual({ kind: "not_applied" });

		for (const fetcher of [
			async () => new Response("unavailable", { status: 503 }),
			async () => {
				throw new Error("connection lost");
			},
		]) {
			const ambiguous = providerMutationFixture();
			await expect(
				createOpenAiEmbeddings(
					{ OPENAI_API_KEY: "test-key" },
					["hello"],
					fixture(fetcher),
					ambiguous.mutation,
				),
			).rejects.toBeDefined();
			ambiguous.mutation.finalize();
			expect(ambiguous.tracker.outcome(1)).toEqual({ kind: "unknown" });
		}
	});

	it("classifies Workers AI resolution before model-response validation", async () => {
		const accepted = providerMutationFixture();
		await expect(
			runAiAgent(
				fixture<Database>({}),
				fixture<Env>({
					AI: { run: async () => ({ response: "not-json" }) },
				}),
				fixture(baseAgent),
				{ message: "hello", conversationContext: [] },
				accepted.mutation,
			),
		).rejects.toBeInstanceOf(AiAgentRuntimeError);
		expect(accepted.tracker.outcome(1)).toEqual({
			kind: "committed",
			units: 1,
		});

		const ambiguous = providerMutationFixture();
		await expect(
			runAiAgent(
				fixture<Database>({}),
				fixture<Env>({
					AI: {
						run: async () => {
							throw new Error("binding rejected");
						},
					},
				}),
				fixture(baseAgent),
				{ message: "hello", conversationContext: [] },
				ambiguous.mutation,
			),
		).rejects.toBeInstanceOf(AiAgentRuntimeError);
		ambiguous.mutation.finalize();
		expect(ambiguous.tracker.outcome(1)).toEqual({ kind: "unknown" });
	});

	it("uses stable-principal handoff without calling a provider", async () => {
		let providerCalled = false;
		const result = await runAiAgent(
			fixture<Database>({
				query: {
					organizationPrincipals: {
						findFirst: async () => ({ id: "prn_support" }),
					},
				},
			}),
			fixture<Env>({
				AI: {
					run: async () => {
						providerCalled = true;
						return {};
					},
				},
			}),
			fixture(baseAgent),
			{ message: "I need a human", conversationContext: [] },
		);
		expect(providerCalled).toBe(false);
		expect(result.handoffRequired).toBe(true);
		expect(result.handoffReason).toBe("keyword");
		expect(result.handoffPrincipalId).toBe("prn_support");

		await expect(
			runAiAgent(
				fixture<Database>({
					query: {
						organizationPrincipals: {
							findFirst: async () => undefined,
						},
					},
				}),
				fixture<Env>({}),
				fixture(baseAgent),
				{ message: "I need a human", conversationContext: [] },
			),
		).rejects.toMatchObject({ code: "handoff_principal_unavailable" });
	});

	it("rejects unsupported persisted models instead of silently falling back", async () => {
		await expect(
			runAiAgent(
				fixture<Database>({}),
				fixture<Env>({}),
				fixture({ ...baseAgent, model: "unsupported" }),
				{ message: "hello", conversationContext: [] },
			),
		).rejects.toBeInstanceOf(AiAgentRuntimeError);
	});

	it("uses GLM for inbox AI and surfaces provider failure", async () => {
		const models: string[] = [];
		const results = await classifyMessages(
			fixture<Ai>({
				run: async (selectedModel: string) => {
					models.push(selectedModel);
					return {
						response: JSON.stringify([
							{
								sentiment: { score: 0.5, label: "positive" },
								intent: "compliment",
								urgency: "low",
								requires_response: false,
							},
						]),
					};
				},
			}),
			[{ id: "msg_1", text: "Great work" }],
		);
		expect(models).toEqual(["@cf/zai-org/glm-4.7-flash"]);
		expect(results[0]?.intent).toBe("compliment");

		await expect(
			classifyMessages(
				fixture<Ai>({
					run: async () => {
						throw new Error("provider down");
					},
				}),
				[{ text: "hello" }],
			),
		).rejects.toBeInstanceOf(InboxAiProviderError);
	});
});
