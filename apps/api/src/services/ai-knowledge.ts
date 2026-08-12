import {
	AI_EMBEDDING_DIMENSIONS,
	AI_EMBEDDING_MODEL,
	AI_EMBEDDING_PROVIDER,
	AI_KNOWLEDGE_DOCUMENT_MAX_ATTEMPTS,
	aiKnowledgeChunks,
	aiKnowledgeDocuments,
	createDb,
	type Database,
	generateId,
	media,
} from "@relayapi/db";
import {
	and,
	asc,
	cosineDistance,
	eq,
	inArray,
	lte,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import {
	fetchPublicUrl,
	readResponseBytes,
	readResponseJson,
} from "../lib/fetch-public-url";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import type { SingleUnitProviderMutationAggregate } from "../lib/mutation-provider-boundary";
import type { Env } from "../types";
import { getStoredObject, storageLocatorForMedia } from "./storage-locator";

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const OPENAI_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const KNOWLEDGE_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
const KNOWLEDGE_LEASE_MS = 5 * 60_000;
const CHUNK_TARGET_CHARS = 1_600;
const CHUNK_OVERLAP_CHARS = 240;
const MAX_CHUNKS_PER_DOCUMENT = 256;
const MAX_EMBEDDING_BATCH = 64;
const MARKDOWN_CONVERSION_MIME_TYPES = new Set([
	"application/pdf",
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);

export class AiKnowledgeError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable: boolean) {
		super(message);
		this.name = "AiKnowledgeError";
		this.code = code;
		this.retryable = retryable;
	}
}

export function isSupportedKnowledgeMediaMimeType(mimeType: string): boolean {
	const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
	return (
		normalized.startsWith("text/") ||
		normalized.includes("json") ||
		normalized.includes("xml") ||
		MARKDOWN_CONVERSION_MIME_TYPES.has(normalized)
	);
}

type OpenAiEmbeddingResponse = {
	data?: Array<{ embedding?: number[]; index?: number }>;
	error?: { code?: string; message?: string; type?: string };
};

export async function createOpenAiEmbeddings(
	env: Pick<Env, "OPENAI_API_KEY">,
	inputs: string[],
	fetcher: typeof fetchWithTimeout = fetchWithTimeout,
	providerMutation?: SingleUnitProviderMutationAggregate,
): Promise<number[][]> {
	if (!env.OPENAI_API_KEY) {
		throw new AiKnowledgeError(
			"embedding_provider_not_configured",
			"OpenAI embeddings are not configured",
			false,
		);
	}
	if (inputs.length === 0 || inputs.length > MAX_EMBEDDING_BATCH) {
		throw new AiKnowledgeError(
			"invalid_embedding_batch",
			`Embedding batches must contain 1-${MAX_EMBEDDING_BATCH} inputs`,
			false,
		);
	}
	const request = () =>
		fetcher(OPENAI_EMBEDDINGS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.OPENAI_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				input: inputs,
				model: AI_EMBEDDING_MODEL,
				encoding_format: "float",
				dimensions: AI_EMBEDDING_DIMENSIONS,
			}),
			timeout: 30_000,
			timeoutThroughBody: true,
		});
	const response = providerMutation
		? await providerMutation.track("openai.embedding.create", request)
		: await request();
	const payload = await readResponseJson<OpenAiEmbeddingResponse>(
		response,
		OPENAI_RESPONSE_MAX_BYTES,
	);
	if (!response.ok) {
		const retryable =
			response.status === 408 ||
			response.status === 409 ||
			response.status === 429 ||
			response.status >= 500;
		throw new AiKnowledgeError(
			payload.error?.code ?? `openai_http_${response.status}`,
			`OpenAI embedding request failed with status ${response.status}`,
			retryable,
		);
	}
	const ordered = [...(payload.data ?? [])].sort(
		(left, right) => (left.index ?? -1) - (right.index ?? -1),
	);
	if (ordered.length !== inputs.length) {
		throw new AiKnowledgeError(
			"invalid_embedding_response_count",
			"OpenAI returned an unexpected embedding count",
			true,
		);
	}
	return ordered.map((item) => {
		const embedding = item.embedding;
		if (
			!embedding ||
			embedding.length !== AI_EMBEDDING_DIMENSIONS ||
			embedding.some((value) => !Number.isFinite(value))
		) {
			throw new AiKnowledgeError(
				"invalid_embedding_dimensions",
				`OpenAI returned an embedding other than ${AI_EMBEDDING_DIMENSIONS} finite dimensions`,
				true,
			);
		}
		return embedding;
	});
}

const KNOWLEDGE_HTML_ENTITIES: Readonly<Record<string, string>> = {
	"&nbsp;": " ",
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
};

function decodeHtmlEntities(value: string): string {
	return value.replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, (entity) => {
		return KNOWLEDGE_HTML_ENTITIES[entity.toLowerCase()] ?? entity;
	});
}

export function normalizeKnowledgeText(
	source: string,
	contentType = "text/plain",
): string {
	const withoutMarkup = contentType.includes("html")
		? source
				.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
				.replace(/<[^>]+>/g, " ")
		: source;
	return decodeHtmlEntities(withoutMarkup)
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function chunkKnowledgeText(text: string): string[] {
	const normalized = normalizeKnowledgeText(text);
	if (!normalized) return [];
	const chunks: string[] = [];
	let offset = 0;
	while (
		offset < normalized.length &&
		chunks.length < MAX_CHUNKS_PER_DOCUMENT
	) {
		let end = Math.min(offset + CHUNK_TARGET_CHARS, normalized.length);
		if (end < normalized.length) {
			const boundary = Math.max(
				normalized.lastIndexOf("\n", end),
				normalized.lastIndexOf(". ", end),
				normalized.lastIndexOf(" ", end),
			);
			if (boundary > offset + CHUNK_TARGET_CHARS / 2) end = boundary + 1;
		}
		const chunk = normalized.slice(offset, end).trim();
		if (chunk) chunks.push(chunk);
		if (end >= normalized.length) {
			offset = end;
			break;
		}
		offset = Math.max(offset + 1, end - CHUNK_OVERLAP_CHARS);
	}
	if (offset < normalized.length) {
		throw new AiKnowledgeError(
			"document_too_large",
			`Document exceeds the ${MAX_CHUNKS_PER_DOCUMENT}-chunk ingestion limit`,
			false,
		);
	}
	return chunks;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

type ClaimedDocument = typeof aiKnowledgeDocuments.$inferSelect;

async function claimKnowledgeDocument(
	db: Database,
	now = new Date(),
	excludedOrganizationIds: readonly string[] = [],
): Promise<ClaimedDocument | null> {
	return db.transaction(async (transaction) => {
		await transaction
			.update(aiKnowledgeDocuments)
			.set({
				status: "terminal_failure",
				attemptId: null,
				claimedAt: null,
				leaseExpiresAt: null,
				nextAttemptAt: now,
				lastErrorCode: sql`CASE
					WHEN ${aiKnowledgeDocuments.deadlineAt} <= ${now}
						THEN 'ingestion_deadline_exceeded'
					ELSE 'ingestion_attempts_exhausted'
				END`,
				lastError: sql`CASE
					WHEN ${aiKnowledgeDocuments.deadlineAt} <= ${now}
						THEN 'Knowledge ingestion exceeded its durable deadline'
					ELSE 'Knowledge ingestion exhausted its durable attempt budget'
				END`,
				completedAt: now,
				updatedAt: now,
			})
			.where(
				or(
					and(
						inArray(aiKnowledgeDocuments.status, [
							"pending",
							"retryable_failure",
						]),
						or(
							lte(aiKnowledgeDocuments.deadlineAt, now),
							sql`${aiKnowledgeDocuments.attemptCount} >= ${AI_KNOWLEDGE_DOCUMENT_MAX_ATTEMPTS}`,
						),
					),
					and(
						eq(aiKnowledgeDocuments.status, "in_flight"),
						lte(aiKnowledgeDocuments.leaseExpiresAt, now),
						or(
							lte(aiKnowledgeDocuments.deadlineAt, now),
							sql`${aiKnowledgeDocuments.attemptCount} >= ${AI_KNOWLEDGE_DOCUMENT_MAX_ATTEMPTS}`,
						),
					),
				),
			);

		const eligibility = or(
			and(
				inArray(aiKnowledgeDocuments.status, ["pending", "retryable_failure"]),
				lte(aiKnowledgeDocuments.nextAttemptAt, now),
			),
			and(
				eq(aiKnowledgeDocuments.status, "in_flight"),
				lte(aiKnowledgeDocuments.leaseExpiresAt, now),
			),
		);
		const rankedEligible = transaction
			.select({
				id: aiKnowledgeDocuments.id,
				tenantRank: sql<number>`row_number() OVER (
					PARTITION BY ${aiKnowledgeDocuments.organizationId}
					ORDER BY ${aiKnowledgeDocuments.nextAttemptAt}, ${aiKnowledgeDocuments.id}
				)`.as("tenant_rank"),
			})
			.from(aiKnowledgeDocuments)
			.where(
				and(
					sql`${aiKnowledgeDocuments.attemptCount} < ${AI_KNOWLEDGE_DOCUMENT_MAX_ATTEMPTS}`,
					sql`${aiKnowledgeDocuments.deadlineAt} > ${now}`,
					eligibility,
				),
			)
			.as("ranked_ai_knowledge_documents");
		const [candidateRow] = await transaction
			.select({ document: aiKnowledgeDocuments })
			.from(aiKnowledgeDocuments)
			.innerJoin(rankedEligible, eq(rankedEligible.id, aiKnowledgeDocuments.id))
			.where(
				and(
					eq(rankedEligible.tenantRank, 1),
					excludedOrganizationIds.length > 0
						? notInArray(aiKnowledgeDocuments.organizationId, [
								...excludedOrganizationIds,
							])
						: undefined,
				),
			)
			.orderBy(
				asc(rankedEligible.tenantRank),
				asc(aiKnowledgeDocuments.nextAttemptAt),
				asc(aiKnowledgeDocuments.organizationId),
				asc(aiKnowledgeDocuments.id),
			)
			.limit(1)
			.for("update", { of: aiKnowledgeDocuments, skipLocked: true });
		const candidate = candidateRow?.document;
		if (!candidate) return null;
		const attemptId = generateId("kbatt_");
		const [claimed] = await transaction
			.update(aiKnowledgeDocuments)
			.set({
				status: "in_flight",
				attemptId,
				attemptCount: sql`${aiKnowledgeDocuments.attemptCount} + 1`,
				claimedAt: now,
				leaseExpiresAt: new Date(now.getTime() + KNOWLEDGE_LEASE_MS),
				lastErrorCode: null,
				lastError: null,
				completedAt: null,
				updatedAt: now,
			})
			.where(eq(aiKnowledgeDocuments.id, candidate.id))
			.returning();
		return claimed ?? null;
	});
}

async function documentSourceText(
	db: Database,
	env: Env,
	document: ClaimedDocument,
): Promise<string> {
	if (document.sourceType === "text") {
		return normalizeKnowledgeText(document.sourceText ?? "");
	}
	if (document.sourceType === "url") {
		if (!document.sourceUrl) {
			throw new AiKnowledgeError(
				"invalid_url_source",
				"URL source is missing its URL",
				false,
			);
		}
		const response = await fetchPublicUrl(document.sourceUrl, {
			headers: {
				Accept: "text/plain, text/html, application/json, application/xml",
			},
			timeout: 20_000,
			timeoutThroughBody: true,
			maxBytes: KNOWLEDGE_SOURCE_MAX_BYTES,
		});
		if (!response.ok) {
			throw new AiKnowledgeError(
				`source_http_${response.status}`,
				`Knowledge source returned status ${response.status}`,
				response.status === 408 ||
					response.status === 429 ||
					response.status >= 500,
			);
		}
		const contentType =
			response.headers.get("content-type")?.toLowerCase() ?? "text/plain";
		if (
			!contentType.startsWith("text/") &&
			!contentType.includes("json") &&
			!contentType.includes("xml")
		) {
			throw new AiKnowledgeError(
				"unsupported_url_content_type",
				`URL knowledge sources must be textual, not ${contentType}`,
				false,
			);
		}
		return normalizeKnowledgeText(
			new TextDecoder().decode(
				await readResponseBytes(response, KNOWLEDGE_SOURCE_MAX_BYTES),
			),
			contentType,
		);
	}
	if (!document.sourceMediaId) {
		throw new AiKnowledgeError(
			"invalid_media_source",
			"Media source is missing its media ID",
			false,
		);
	}
	const [source] = await db
		.select({
			organizationId: media.organizationId,
			scopeKey: media.scopeKey,
			filename: media.filename,
			storageProvider: media.storageProvider,
			storageBucketLocator: media.storageBucketLocator,
			storageRegion: media.storageRegion,
			storageLocationId: media.storageLocationId,
			storageCredentialVersion: media.storageCredentialVersion,
			storageKey: media.storageKey,
			mimeType: media.mimeType,
			status: media.status,
			deletionRequestedAt: media.deletionRequestedAt,
		})
		.from(media)
		.where(
			and(
				eq(media.id, document.sourceMediaId),
				eq(media.organizationId, document.organizationId),
				eq(media.scopeKey, document.scopeKey),
			),
		)
		.limit(1);
	if (
		source?.status !== "ready" ||
		source.deletionRequestedAt ||
		!isSupportedKnowledgeMediaMimeType(source.mimeType)
	) {
		throw new AiKnowledgeError(
			"media_source_unavailable",
			"Media knowledge source is unavailable or is not a supported textual file",
			source?.status !== "ready",
		);
	}
	const object = await getStoredObject(db, env, storageLocatorForMedia(source));
	if (!object) {
		throw new AiKnowledgeError(
			"media_object_missing",
			"Media knowledge source object is missing",
			true,
		);
	}
	const response = new Response(object.body, {
		headers: {
			"content-length": String(object.size),
			"content-type": object.contentType ?? source.mimeType,
		},
	});
	const bytes = await readResponseBytes(response, KNOWLEDGE_SOURCE_MAX_BYTES);
	const contentType = (object.contentType ?? source.mimeType).toLowerCase();
	if (
		contentType.startsWith("text/") ||
		contentType.includes("json") ||
		contentType.includes("xml")
	) {
		return normalizeKnowledgeText(new TextDecoder().decode(bytes), contentType);
	}
	if (!env.AI) {
		throw new AiKnowledgeError(
			"document_conversion_not_configured",
			"Workers AI document conversion is not configured",
			false,
		);
	}
	let converted: ConversionResponse;
	try {
		converted = await env.AI.toMarkdown(
			{
				name: source.filename,
				blob: new Blob([bytes], { type: contentType }),
			},
			{
				conversionOptions: {
					pdf: { metadata: false, images: { convert: false } },
				},
			},
		);
	} catch {
		throw new AiKnowledgeError(
			"document_conversion_failed",
			"Workers AI document conversion failed",
			true,
		);
	}
	if (converted.format === "error") {
		throw new AiKnowledgeError(
			"document_conversion_rejected",
			"Workers AI could not convert the knowledge document",
			false,
		);
	}
	if (
		new TextEncoder().encode(converted.data).byteLength >
		KNOWLEDGE_SOURCE_MAX_BYTES
	) {
		throw new AiKnowledgeError(
			"converted_document_too_large",
			"Converted knowledge document exceeds the ingestion limit",
			false,
		);
	}
	return normalizeKnowledgeText(converted.data, "text/markdown");
}

async function embedChunks(env: Env, chunks: string[]): Promise<number[][]> {
	const embeddings: number[][] = [];
	for (let index = 0; index < chunks.length; index += MAX_EMBEDDING_BATCH) {
		embeddings.push(
			...(await createOpenAiEmbeddings(
				env,
				chunks.slice(index, index + MAX_EMBEDDING_BATCH),
			)),
		);
	}
	return embeddings;
}

async function completeKnowledgeDocument(
	db: Database,
	document: ClaimedDocument,
	chunks: string[],
	embeddings: number[][],
): Promise<boolean> {
	const hashes = await Promise.all(chunks.map(sha256));
	const documentHash = await sha256(chunks.join("\n\n"));
	const completedAt = new Date();
	return db.transaction(async (transaction) => {
		const [locked] = await transaction
			.select({
				id: aiKnowledgeDocuments.id,
				status: aiKnowledgeDocuments.status,
				attemptId: aiKnowledgeDocuments.attemptId,
			})
			.from(aiKnowledgeDocuments)
			.where(eq(aiKnowledgeDocuments.id, document.id))
			.limit(1)
			.for("update");
		if (
			locked?.status !== "in_flight" ||
			locked.attemptId !== document.attemptId
		) {
			return false;
		}
		await transaction
			.delete(aiKnowledgeChunks)
			.where(eq(aiKnowledgeChunks.documentId, document.id));
		for (let index = 0; index < chunks.length; index += 100) {
			const values = chunks.slice(index, index + 100).map((content, local) => {
				const chunkIndex = index + local;
				const embedding = embeddings[chunkIndex];
				const contentHash = hashes[chunkIndex];
				if (!embedding || !contentHash) {
					throw new Error("Knowledge chunk assembly mismatch");
				}
				return {
					documentId: document.id,
					kbId: document.kbId,
					organizationId: document.organizationId,
					scopeKey: document.scopeKey,
					content,
					contentHash,
					embedding,
					chunkIndex,
					tokenCount: Math.ceil(content.length / 4),
				};
			});
			if (values.length > 0) {
				await transaction.insert(aiKnowledgeChunks).values(values);
			}
		}
		await transaction
			.update(aiKnowledgeDocuments)
			.set({
				status: "ready",
				attemptId: null,
				claimedAt: null,
				leaseExpiresAt: null,
				lastCrawledAt: completedAt,
				contentHash: documentHash,
				lastErrorCode: null,
				lastError: null,
				completedAt,
				updatedAt: completedAt,
			})
			.where(eq(aiKnowledgeDocuments.id, document.id));
		return true;
	});
}

function retryDelayMs(attemptCount: number): number {
	return Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.max(0, attemptCount - 1));
}

async function failKnowledgeDocument(
	db: Database,
	document: ClaimedDocument,
	error: unknown,
): Promise<void> {
	const failure =
		error instanceof AiKnowledgeError
			? error
			: new AiKnowledgeError(
					"knowledge_ingestion_failed",
					error instanceof Error ? error.message : "Knowledge ingestion failed",
					true,
				);
	const terminal =
		!failure.retryable ||
		document.attemptCount >= AI_KNOWLEDGE_DOCUMENT_MAX_ATTEMPTS;
	const now = new Date();
	const retryAt = new Date(
		Math.min(
			document.deadlineAt.getTime(),
			now.getTime() + retryDelayMs(document.attemptCount),
		),
	);
	await db
		.update(aiKnowledgeDocuments)
		.set({
			status: terminal ? "terminal_failure" : "retryable_failure",
			attemptId: null,
			claimedAt: null,
			leaseExpiresAt: null,
			nextAttemptAt: terminal ? now : retryAt,
			lastErrorCode: failure.code.slice(0, 100),
			lastError: failure.message.slice(0, 2_000),
			completedAt: terminal ? now : null,
			updatedAt: now,
		})
		.where(
			and(
				eq(aiKnowledgeDocuments.id, document.id),
				eq(aiKnowledgeDocuments.status, "in_flight"),
				eq(aiKnowledgeDocuments.attemptId, document.attemptId ?? ""),
			),
		);
}

export async function processAiKnowledgeDocuments(
	env: Env,
	limit = 2,
): Promise<number> {
	if (limit < 1 || limit > 20)
		throw new Error("AI ingestion limit must be 1-20");
	const db = createDb(env.HYPERDRIVE.connectionString);
	let processed = 0;
	const claimedOrganizations = new Set<string>();
	for (let index = 0; index < limit; index += 1) {
		let document: ClaimedDocument | null = null;
		try {
			document = await claimKnowledgeDocument(db, new Date(), [
				...claimedOrganizations,
			]);
			if (!document && claimedOrganizations.size > 0) {
				claimedOrganizations.clear();
				document = await claimKnowledgeDocument(db);
			}
			if (!document) break;
			claimedOrganizations.add(document.organizationId);
			const source = await documentSourceText(db, env, document);
			const chunks = chunkKnowledgeText(source);
			if (chunks.length === 0) {
				throw new AiKnowledgeError(
					"empty_document",
					"Knowledge source contains no indexable text",
					false,
				);
			}
			const embeddings = await embedChunks(env, chunks);
			await completeKnowledgeDocument(db, document, chunks, embeddings);
		} catch (error) {
			if (document) {
				await failKnowledgeDocument(db, document, error);
			} else {
				console.error(
					JSON.stringify({
						event: "ai_knowledge_claim_failed",
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		}
		processed += 1;
	}
	return processed;
}

export interface KnowledgeSearchResult {
	chunkId: string;
	documentId: string;
	content: string;
	similarity: number;
}

export async function searchKnowledgeBase(
	db: Database,
	env: Pick<Env, "OPENAI_API_KEY">,
	input: {
		organizationId: string;
		scopeKey: string;
		kbId: string;
		query: string;
		limit: number;
	},
	providerMutation?: SingleUnitProviderMutationAggregate,
): Promise<KnowledgeSearchResult[]> {
	const [queryEmbedding] = await createOpenAiEmbeddings(
		env,
		[input.query],
		fetchWithTimeout,
		providerMutation,
	);
	if (!queryEmbedding)
		throw new Error("Embedding provider returned no query vector");
	const distance = cosineDistance(aiKnowledgeChunks.embedding, queryEmbedding);
	const rows = await db
		.select({
			chunkId: aiKnowledgeChunks.id,
			documentId: aiKnowledgeChunks.documentId,
			content: aiKnowledgeChunks.content,
			distance,
		})
		.from(aiKnowledgeChunks)
		.where(
			and(
				eq(aiKnowledgeChunks.organizationId, input.organizationId),
				eq(aiKnowledgeChunks.scopeKey, input.scopeKey),
				eq(aiKnowledgeChunks.kbId, input.kbId),
			),
		)
		.orderBy(asc(distance))
		.limit(input.limit);
	return rows.map((row) => ({
		chunkId: row.chunkId,
		documentId: row.documentId,
		content: row.content,
		similarity: Math.max(0, Math.min(1, 1 - Number(row.distance))),
	}));
}

export const AI_KNOWLEDGE_PROVIDER_CONTRACT = {
	embeddingProvider: AI_EMBEDDING_PROVIDER,
	embeddingModel: AI_EMBEDDING_MODEL,
	embeddingDimensions: AI_EMBEDDING_DIMENSIONS,
} as const;
