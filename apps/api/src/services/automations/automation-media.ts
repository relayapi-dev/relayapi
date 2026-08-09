import { type Database, media } from "@relayapi/db";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { mediaPublicHost } from "../../lib/deployment-mode";
import { resolveRelayMediaForPublish } from "../../lib/r2-presign";
import { relayMediaReferenceFromUrl } from "../../lib/relay-media-policy";
import type { MessageBlock } from "../../schemas/automation-graph";
import type { Env } from "../../types";

const MEDIA_ID_PATTERN = /^med_[A-Za-z0-9_-]+$/;

export type AutomationMediaRow = {
	id: string;
	organizationId: string;
	workspaceId: string | null;
	storageKey: string;
	url: string | null;
	status: string;
	deletionRequestedAt: Date | null;
	originalDeletedAt: Date | null;
};

export type AutomationMediaLookupInput = {
	db: Database;
	organizationId: string;
	workspaceId: string | null;
	ids: string[];
	storageKeys: string[];
};

export type AutomationMediaResolverDependencies = {
	loadMediaRows?: (
		input: AutomationMediaLookupInput,
	) => Promise<AutomationMediaRow[]>;
	resolveForPublish?: typeof resolveRelayMediaForPublish;
};

type ParsedMediaReference =
	| { kind: "media_id"; value: string }
	| { kind: "relay_url"; value: string; storageKey: string }
	| { kind: "external_url"; value: string };

export class AutomationMediaReferenceError extends Error {
	constructor(
		public readonly reason: "invalid_reference" | "not_available_in_scope",
	) {
		super(
			reason === "invalid_reference"
				? "Automation media must be a media-library ID or an external HTTP(S) URL"
				: "Automation media is unavailable or outside the automation scope",
		);
		this.name = "AutomationMediaReferenceError";
	}
}

export function automationMediaRowIsAuthorized(
	row: AutomationMediaRow,
	organizationId: string,
	workspaceId: string | null,
): boolean {
	const workspaceAllowed = workspaceId
		? row.workspaceId === workspaceId || row.workspaceId === null
		: row.workspaceId === null;
	return (
		row.organizationId === organizationId &&
		workspaceAllowed &&
		row.status === "ready" &&
		row.deletionRequestedAt === null &&
		row.originalDeletedAt === null &&
		typeof row.url === "string" &&
		row.url.length > 0
	);
}

function parseMediaReference(value: string, env: Env): ParsedMediaReference {
	if (MEDIA_ID_PATTERN.test(value)) {
		return { kind: "media_id", value };
	}

	const relayReference = relayMediaReferenceFromUrl(
		value,
		mediaPublicHost(env),
	);
	if (relayReference) {
		if (!relayReference.storageKey || relayReference.reason) {
			throw new AutomationMediaReferenceError("invalid_reference");
		}
		return {
			kind: "relay_url",
			value,
			storageKey: relayReference.storageKey,
		};
	}

	try {
		const parsed = new URL(value);
		if (
			(parsed.protocol === "https:" || parsed.protocol === "http:") &&
			!parsed.username &&
			!parsed.password
		) {
			return { kind: "external_url", value };
		}
	} catch {
		// Fall through to the stable validation error below.
	}
	throw new AutomationMediaReferenceError("invalid_reference");
}

function mediaReferencesInBlocks(blocks: MessageBlock[]): string[] {
	const references: string[] = [];
	for (const block of blocks) {
		switch (block.type) {
			case "image":
			case "video":
			case "audio":
			case "file":
				if (block.media_ref) references.push(block.media_ref);
				break;
			case "card":
				if (block.media_ref) references.push(block.media_ref);
				break;
			case "gallery":
				for (const card of block.cards) {
					if (card.media_ref) references.push(card.media_ref);
				}
				break;
		}
	}
	return [...new Set(references)];
}

function replaceMediaReferences(
	blocks: MessageBlock[],
	resolved: ReadonlyMap<string, string>,
): MessageBlock[] {
	const replace = (value: string | undefined): string | undefined =>
		value ? (resolved.get(value) ?? value) : value;
	return blocks.map((block) => {
		switch (block.type) {
			case "image":
			case "video":
			case "audio":
			case "file":
				return { ...block, media_ref: replace(block.media_ref) ?? "" };
			case "card":
				return { ...block, media_ref: replace(block.media_ref) };
			case "gallery":
				return {
					...block,
					cards: block.cards.map((card) => ({
						...card,
						media_ref: replace(card.media_ref),
					})),
				};
			default:
				return block;
		}
	});
}

async function loadMediaRows({
	db,
	organizationId,
	workspaceId,
	ids,
	storageKeys,
}: AutomationMediaLookupInput): Promise<AutomationMediaRow[]> {
	const referenceCondition =
		ids.length > 0 && storageKeys.length > 0
			? or(inArray(media.id, ids), inArray(media.storageKey, storageKeys))
			: ids.length > 0
				? inArray(media.id, ids)
				: inArray(media.storageKey, storageKeys);
	if (!referenceCondition) return [];

	const workspaceCondition = workspaceId
		? or(eq(media.workspaceId, workspaceId), isNull(media.workspaceId))
		: isNull(media.workspaceId);
	if (!workspaceCondition) return [];

	return db
		.select({
			id: media.id,
			organizationId: media.organizationId,
			workspaceId: media.workspaceId,
			storageKey: media.storageKey,
			url: media.url,
			status: media.status,
			deletionRequestedAt: media.deletionRequestedAt,
			originalDeletedAt: media.originalDeletedAt,
		})
		.from(media)
		.where(
			and(
				eq(media.organizationId, organizationId),
				workspaceCondition,
				eq(media.status, "ready"),
				isNull(media.deletionRequestedAt),
				isNull(media.originalDeletedAt),
				isNotNull(media.url),
				referenceCondition,
			),
		);
}

/**
 * Resolve durable media-library IDs immediately before provider delivery.
 * Every hosted reference is authorized against the automation tenant/scope,
 * checked against current storage metadata, and replaced with a fresh read URL.
 * External HTTP(S) URLs remain an explicit advanced fallback.
 */
export async function resolveAutomationMessageMedia(
	input: {
		db: Database;
		env: Env;
		organizationId: string;
		workspaceId: string | null;
		blocks: MessageBlock[];
	},
	dependencies: AutomationMediaResolverDependencies = {},
): Promise<MessageBlock[]> {
	const references = mediaReferencesInBlocks(input.blocks);
	if (references.length === 0) return input.blocks;

	const parsed = references.map((reference) =>
		parseMediaReference(reference, input.env),
	);
	const hosted = parsed.filter(
		(reference) => reference.kind !== "external_url",
	);
	if (hosted.length === 0) return input.blocks;

	const ids = hosted.flatMap((reference) =>
		reference.kind === "media_id" ? [reference.value] : [],
	);
	const storageKeys = hosted.flatMap((reference) =>
		reference.kind === "relay_url" ? [reference.storageKey] : [],
	);
	const rows = await (dependencies.loadMediaRows ?? loadMediaRows)({
		db: input.db,
		organizationId: input.organizationId,
		workspaceId: input.workspaceId,
		ids,
		storageKeys,
	});
	const authorizedRows = rows.filter((row) =>
		automationMediaRowIsAuthorized(
			row,
			input.organizationId,
			input.workspaceId,
		),
	);
	const rowsById = new Map(authorizedRows.map((row) => [row.id, row]));
	const rowsByStorageKey = new Map(
		authorizedRows.map((row) => [row.storageKey, row]),
	);
	const replacements = new Map<string, string>();

	for (const reference of hosted) {
		const row =
			reference.kind === "media_id"
				? rowsById.get(reference.value)
				: rowsByStorageKey.get(reference.storageKey);
		if (!row?.url) {
			throw new AutomationMediaReferenceError("not_available_in_scope");
		}
		replacements.set(reference.value, row.url);
	}

	const canonicalBlocks = replaceMediaReferences(input.blocks, replacements);
	return (dependencies.resolveForPublish ?? resolveRelayMediaForPublish)(
		input.db,
		input.env,
		canonicalBlocks,
		input.organizationId,
	);
}
