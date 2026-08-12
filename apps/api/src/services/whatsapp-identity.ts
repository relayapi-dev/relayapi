import {
	type Database,
	generateId,
	inboxConversations,
	whatsappIdentityAliases,
} from "@relayapi/db";
import { and, desc, eq } from "drizzle-orm";
import { deriveConsentIdentifierIdentity } from "../lib/consent-hmac";
import { decryptToken, encryptToken } from "../lib/crypto";

export type WhatsAppIdentity = {
	bsuid: string;
	parentBsuid?: string;
	waId?: string;
	username?: string;
};

function normalizedIdentity(value: string): string {
	// BSUIDs are opaque provider identifiers. Trimming transport whitespace is
	// safe; case-folding is not, because Meta does not define them as
	// case-insensitive.
	return value.trim();
}

async function identityHash(
	keyConfig: string,
	organizationId: string,
	kind: "bsuid" | "parent_bsuid" | "wa_id",
	value: string,
): Promise<string> {
	const identity = await deriveConsentIdentifierIdentity(keyConfig, {
		organizationId,
		channel: "whatsapp",
		purpose: `identity_alias_${kind}`,
		normalizedIdentifier: normalizedIdentity(value),
	});
	// logicalIdentifierHash is keyed by the retained identity key, so aliases
	// stay addressable through active encryption-key rotation.
	return identity.logicalIdentifierHash;
}

export async function whatsappIdentityConversationKey(
	keyConfig: string,
	organizationId: string,
	bsuid: string,
): Promise<string> {
	return `bsuid_${await identityHash(
		keyConfig,
		organizationId,
		"bsuid",
		bsuid,
	)}`;
}

function encryptionContext(aliasId: string, field: string) {
	return { recordId: aliasId, field: `whatsapp_identity_${field}` };
}

/**
 * Resolve a direct-message BSUID only from the exact authorized conversation
 * tuple. Callers keep group IDs separate; an alias observed in a group never
 * acquires that group's conversation ID.
 */
export async function resolveWhatsAppOutboundBsuid(
	db: Database,
	keyConfig: string,
	input: {
		organizationId: string;
		accountId: string;
		conversationId: string;
	},
): Promise<string | null> {
	const [alias] = await db
		.select({
			id: whatsappIdentityAliases.id,
			bsuidCiphertext: whatsappIdentityAliases.bsuidCiphertext,
		})
		.from(whatsappIdentityAliases)
		.where(
			and(
				eq(whatsappIdentityAliases.organizationId, input.organizationId),
				eq(whatsappIdentityAliases.accountId, input.accountId),
				eq(whatsappIdentityAliases.platform, "whatsapp"),
				eq(whatsappIdentityAliases.conversationId, input.conversationId),
			),
		)
		.orderBy(desc(whatsappIdentityAliases.lastSeenAt))
		.limit(1);
	if (!alias) return null;
	return decryptToken(
		alias.bsuidCiphertext,
		keyConfig,
		encryptionContext(alias.id, "bsuid"),
	);
}

async function encryptedAliasValues(
	keyConfig: string,
	aliasId: string,
	identity: WhatsAppIdentity,
) {
	const [
		bsuidCiphertext,
		parentBsuidCiphertext,
		waIdCiphertext,
		usernameCiphertext,
	] = await Promise.all([
		encryptToken(
			identity.bsuid,
			keyConfig,
			encryptionContext(aliasId, "bsuid"),
		),
		identity.parentBsuid
			? encryptToken(
					identity.parentBsuid,
					keyConfig,
					encryptionContext(aliasId, "parent_bsuid"),
				)
			: null,
		identity.waId
			? encryptToken(
					identity.waId,
					keyConfig,
					encryptionContext(aliasId, "wa_id"),
				)
			: null,
		identity.username
			? encryptToken(
					identity.username,
					keyConfig,
					encryptionContext(aliasId, "username"),
				)
			: null,
	]);
	return {
		bsuidCiphertext,
		parentBsuidCiphertext,
		waIdCiphertext,
		usernameCiphertext,
	};
}

export async function resolveWhatsAppConversationIdentity(
	db: Database,
	keyConfig: string,
	input: {
		organizationId: string;
		accountId: string;
		identity: WhatsAppIdentity;
	},
): Promise<string | null> {
	const [bsuidHash, waIdHash] = await Promise.all([
		identityHash(
			keyConfig,
			input.organizationId,
			"bsuid",
			input.identity.bsuid,
		),
		input.identity.waId
			? identityHash(
					keyConfig,
					input.organizationId,
					"wa_id",
					input.identity.waId,
				)
			: null,
	]);
	// A BSUID is the authoritative identity. Resolve it first so an incidental
	// or stale wa_id can never win an unordered OR match against another alias.
	const [bsuidAlias] = await db
		.select({
			platformConversationId: inboxConversations.platformConversationId,
		})
		.from(whatsappIdentityAliases)
		.innerJoin(
			inboxConversations,
			and(
				eq(whatsappIdentityAliases.conversationId, inboxConversations.id),
				eq(
					whatsappIdentityAliases.organizationId,
					inboxConversations.organizationId,
				),
			),
		)
		.where(
			and(
				eq(whatsappIdentityAliases.organizationId, input.organizationId),
				eq(whatsappIdentityAliases.accountId, input.accountId),
				eq(whatsappIdentityAliases.bsuidHash, bsuidHash),
			),
		)
		.limit(1);
	if (bsuidAlias) return bsuidAlias.platformConversationId;

	// During the phone-to-BSUID transition, a newly observed BSUID may only be
	// linkable through the legacy phone alias. This fallback is deliberately
	// separate and runs only after the exact BSUID lookup misses.
	if (waIdHash) {
		const [phoneAlias] = await db
			.select({
				platformConversationId: inboxConversations.platformConversationId,
			})
			.from(whatsappIdentityAliases)
			.innerJoin(
				inboxConversations,
				and(
					eq(whatsappIdentityAliases.conversationId, inboxConversations.id),
					eq(
						whatsappIdentityAliases.organizationId,
						inboxConversations.organizationId,
					),
				),
			)
			.where(
				and(
					eq(whatsappIdentityAliases.organizationId, input.organizationId),
					eq(whatsappIdentityAliases.accountId, input.accountId),
					eq(whatsappIdentityAliases.waIdHash, waIdHash),
				),
			)
			.limit(1);
		if (phoneAlias) return phoneAlias.platformConversationId;
	}

	// Upgrade a pre-BSUID phone-keyed conversation without splitting history.
	if (input.identity.waId) {
		const [phoneConversation] = await db
			.select({
				platformConversationId: inboxConversations.platformConversationId,
			})
			.from(inboxConversations)
			.where(
				and(
					eq(inboxConversations.organizationId, input.organizationId),
					eq(inboxConversations.accountId, input.accountId),
					eq(inboxConversations.platformConversationId, input.identity.waId),
				),
			)
			.limit(1);
		if (phoneConversation) return phoneConversation.platformConversationId;
	}
	return null;
}

export async function persistWhatsAppIdentityAlias(
	db: Database,
	keyConfig: string,
	input: {
		organizationId: string;
		workspaceId: string | null;
		accountId: string;
		conversationId: string | null;
		identity: WhatsAppIdentity;
	},
): Promise<void> {
	const [bsuidHash, parentBsuidHash, waIdHash] = await Promise.all([
		identityHash(
			keyConfig,
			input.organizationId,
			"bsuid",
			input.identity.bsuid,
		),
		input.identity.parentBsuid
			? identityHash(
					keyConfig,
					input.organizationId,
					"parent_bsuid",
					input.identity.parentBsuid,
				)
			: null,
		input.identity.waId
			? identityHash(
					keyConfig,
					input.organizationId,
					"wa_id",
					input.identity.waId,
				)
			: null,
	]);
	const [existing] = await db
		.select({ id: whatsappIdentityAliases.id })
		.from(whatsappIdentityAliases)
		.where(
			and(
				eq(whatsappIdentityAliases.organizationId, input.organizationId),
				eq(whatsappIdentityAliases.accountId, input.accountId),
				eq(whatsappIdentityAliases.bsuidHash, bsuidHash),
			),
		)
		.limit(1);
	const aliasId = existing?.id ?? generateId("wai_");
	const encrypted = await encryptedAliasValues(
		keyConfig,
		aliasId,
		input.identity,
	);
	const now = new Date();
	if (existing) {
		await db
			.update(whatsappIdentityAliases)
			.set({
				// Group deliveries expose participant aliases too, but a group is not
				// the participant's direct-message conversation. Never erase an
				// already-resolved direct mapping with a group observation.
				...(input.conversationId
					? { conversationId: input.conversationId }
					: {}),
				bsuidCiphertext: encrypted.bsuidCiphertext,
				...(input.identity.parentBsuid
					? {
							parentBsuidHash,
							parentBsuidCiphertext: encrypted.parentBsuidCiphertext,
						}
					: {}),
				...(input.identity.waId
					? {
							waIdHash,
							waIdCiphertext: encrypted.waIdCiphertext,
						}
					: {}),
				...(input.identity.username
					? { usernameCiphertext: encrypted.usernameCiphertext }
					: {}),
				lastSeenAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(whatsappIdentityAliases.id, aliasId),
					eq(whatsappIdentityAliases.organizationId, input.organizationId),
					eq(whatsappIdentityAliases.accountId, input.accountId),
				),
			);
		return;
	}

	const [inserted] = await db
		.insert(whatsappIdentityAliases)
		.values({
			id: aliasId,
			organizationId: input.organizationId,
			workspaceId: input.workspaceId,
			accountId: input.accountId,
			platform: "whatsapp",
			conversationId: input.conversationId,
			bsuidHash,
			parentBsuidHash,
			waIdHash,
			...encrypted,
			lastSeenAt: now,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing()
		.returning({ id: whatsappIdentityAliases.id });
	if (inserted) return;

	// A concurrent delivery won the unique alias insert. Re-run against its
	// canonical ID so AES-GCM additional authenticated data matches the row.
	await persistWhatsAppIdentityAlias(db, keyConfig, input);
}
