import type { contacts, contactChannels } from "@relayapi/db";
import {
	consentIdentityKeyFingerprint,
	parseConsentHmacKeyRing,
	requireConsentHmacKeyConfig,
} from "../lib/consent-hmac";
import { decryptToken, encryptToken } from "../lib/crypto";
import { normalizeContactPhone } from "../lib/contact-phone";

export const CONTACT_NAME_MAX_CHARS = 256;
export const CONTACT_EMAIL_MAX_CHARS = 320;
export const CONTACT_CHANNEL_IDENTIFIER_MAX_CHARS = 1_024;
export const CONTACT_METADATA_MAX_BYTES = 65_536;
export const CONTACT_SEARCH_MAX_CHARS = 320;

const SEARCH_TOKEN_HEX_LENGTH = 32;
const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

type ContactRow = typeof contacts.$inferSelect;
type ContactChannelRow = typeof contactChannels.$inferSelect;

export interface ContactPlaintext {
	name: string | null;
	email: string | null;
	phone: string | null;
	metadata: Record<string, unknown> | null;
}

export type DecryptedContactRow<T extends Partial<ContactRow>> = Omit<
	T,
	| "nameCiphertext"
	| "nameHash"
	| "nameSearchTokens"
	| "emailCiphertext"
	| "emailHash"
	| "emailSearchTokens"
	| "phoneCiphertext"
	| "phoneHash"
	| "phoneSearchTokens"
	| "metadataCiphertext"
	| "searchIdentityKeyFingerprint"
> &
	ContactPlaintext;

export type DecryptedContactChannelRow<T extends Partial<ContactChannelRow>> =
	Omit<
		T,
		"identifierCiphertext" | "identifierHash" | "identityKeyFingerprint"
	> & {
		identifier: string;
	};

export class ContactProtectionIdentityKeyMismatchError extends Error {
	constructor(organizationId: string) {
		super(
			`Contact search identity key does not match durable authority for organization ${organizationId}`,
		);
		this.name = "ContactProtectionIdentityKeyMismatchError";
	}
}

function importHmacKey(hexKey: string): Promise<CryptoKey> {
	let cached = hmacKeyCache.get(hexKey);
	if (!cached) {
		const pairs = hexKey.match(/.{2}/g);
		if (pairs?.length !== 32) {
			throw new Error("Invalid contact-protection HMAC key material");
		}
		const raw = new Uint8Array(
			pairs.map((pair) => Number.parseInt(pair, 16)),
		);
		cached = crypto.subtle.importKey(
			"raw",
			raw,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		hmacKeyCache.set(hexKey, cached);
	}
	return cached;
}

async function hmacHex(keyHex: string, value: string): Promise<string> {
	const signature = await crypto.subtle.sign(
		"HMAC",
		await importHmacKey(keyHex),
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(signature), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function requireBoundedText(
	value: string,
	field: string,
	maxChars: number,
): string {
	if (Array.from(value).length > maxChars) {
		throw new Error(`${field} exceeds ${maxChars} characters`);
	}
	return value;
}

function normalizedSearchText(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("und");
}

function ngramsForStoredValue(value: string): string[] {
	const characters = Array.from(normalizedSearchText(value));
	const grams = new Set<string>();
	for (const size of [1, 2, 3]) {
		for (let index = 0; index + size <= characters.length; index++) {
			grams.add(`${size}\u0000${characters.slice(index, index + size).join("")}`);
		}
	}
	return [...grams];
}

function ngramsForQuery(value: string): string[] {
	const characters = Array.from(normalizedSearchText(value));
	if (characters.length === 0) return [];
	const size = Math.min(characters.length, 3);
	const grams = new Set<string>();
	for (let index = 0; index + size <= characters.length; index++) {
		grams.add(`${size}\u0000${characters.slice(index, index + size).join("")}`);
	}
	return [...grams];
}

async function deriveHash(
	keyConfig: string,
	organizationId: string,
	purpose: string,
	normalizedValue: string,
): Promise<string> {
	const { identityKeyHex } = parseConsentHmacKeyRing(keyConfig);
	return hmacHex(
		identityKeyHex,
		[
			"relayapi:contact-protection:v1",
			organizationId,
			purpose,
			normalizedValue,
		].join("\u0000"),
	);
}

async function deriveSearchTokens(
	keyConfig: string,
	organizationId: string,
	grams: readonly string[],
): Promise<string[]> {
	const { identityKeyHex } = parseConsentHmacKeyRing(keyConfig);
	const tokens = await Promise.all(
		grams.map(async (gram) =>
			(
				await hmacHex(
					identityKeyHex,
					[
						"relayapi:contact-search-ngram:v1",
						organizationId,
						gram,
					].join("\u0000"),
				)
			).slice(0, SEARCH_TOKEN_HEX_LENGTH),
		),
	);
	return [...new Set(tokens)].sort();
}

function contactEncryptionContext(contactId: string, field: string) {
	return { recordId: contactId, field: `contact_${field}` };
}

function channelEncryptionContext(channelId: string) {
	return { recordId: channelId, field: "contact_channel_identifier" };
}

export async function protectContactName(
	keyConfigInput: string,
	organizationId: string,
	contactId: string,
	value: string | null,
) {
	const keyConfig = requireConsentHmacKeyConfig(keyConfigInput);
	if (value === null) {
		return {
			nameCiphertext: null,
			nameHash: null,
			nameSearchTokens: [] as string[],
		};
	}
	requireBoundedText(value, "Contact name", CONTACT_NAME_MAX_CHARS);
	const normalized = normalizedSearchText(value);
	const [nameCiphertext, nameHash, nameSearchTokens] = await Promise.all([
		encryptToken(
			value,
			keyConfig,
			contactEncryptionContext(contactId, "name"),
		),
		deriveHash(keyConfig, organizationId, "name-exact", normalized),
		deriveSearchTokens(
			keyConfig,
			organizationId,
			ngramsForStoredValue(value),
		),
	]);
	return { nameCiphertext, nameHash, nameSearchTokens };
}

export async function protectContactEmail(
	keyConfigInput: string,
	organizationId: string,
	contactId: string,
	value: string | null,
) {
	const keyConfig = requireConsentHmacKeyConfig(keyConfigInput);
	if (value === null) {
		return {
			emailCiphertext: null,
			emailHash: null,
			emailSearchTokens: [] as string[],
		};
	}
	requireBoundedText(value, "Contact email", CONTACT_EMAIL_MAX_CHARS);
	const [emailCiphertext, emailHash, emailSearchTokens] = await Promise.all([
		encryptToken(
			value,
			keyConfig,
			contactEncryptionContext(contactId, "email"),
		),
		deriveHash(
			keyConfig,
			organizationId,
			"email-exact",
			value.trim().toLowerCase(),
		),
		deriveSearchTokens(
			keyConfig,
			organizationId,
			ngramsForStoredValue(value),
		),
	]);
	return { emailCiphertext, emailHash, emailSearchTokens };
}

export async function protectContactPhone(
	keyConfigInput: string,
	organizationId: string,
	contactId: string,
	value: string | null,
) {
	const keyConfig = requireConsentHmacKeyConfig(keyConfigInput);
	if (value === null) {
		return {
			phoneCiphertext: null,
			phoneHash: null,
			phoneSearchTokens: [] as string[],
		};
	}
	requireBoundedText(value, "Contact phone", 80);
	const canonical = normalizeContactPhone(value);
	if (!canonical) {
		throw new Error(
			"Contact phone must include an international country calling code",
		);
	}
	const [phoneCiphertext, phoneHash, phoneSearchTokens] = await Promise.all([
		encryptToken(
			value,
			keyConfig,
			contactEncryptionContext(contactId, "phone"),
		),
		deriveHash(keyConfig, organizationId, "phone-exact", canonical),
		deriveSearchTokens(
			keyConfig,
			organizationId,
			ngramsForStoredValue(value),
		),
	]);
	return { phoneCiphertext, phoneHash, phoneSearchTokens };
}

export async function protectContactMetadata(
	keyConfigInput: string,
	_contactOrganizationId: string,
	contactId: string,
	value: Record<string, unknown> | null,
) {
	const keyConfig = requireConsentHmacKeyConfig(keyConfigInput);
	if (value === null) return { metadataCiphertext: null };
	const serialized = JSON.stringify(value);
	if (new TextEncoder().encode(serialized).byteLength > CONTACT_METADATA_MAX_BYTES) {
		throw new Error(
			`Contact metadata exceeds ${CONTACT_METADATA_MAX_BYTES} bytes`,
		);
	}
	return {
		metadataCiphertext: await encryptToken(
			serialized,
			keyConfig,
			contactEncryptionContext(contactId, "metadata"),
		),
	};
}

export async function protectContactValues(
	keyConfig: string,
	organizationId: string,
	contactId: string,
	value: ContactPlaintext,
) {
	const [name, email, phone, metadata, searchIdentityKeyFingerprint] =
		await Promise.all([
			protectContactName(keyConfig, organizationId, contactId, value.name),
			protectContactEmail(keyConfig, organizationId, contactId, value.email),
			protectContactPhone(keyConfig, organizationId, contactId, value.phone),
			protectContactMetadata(
				keyConfig,
				organizationId,
				contactId,
				value.metadata,
			),
			consentIdentityKeyFingerprint(keyConfig, organizationId),
		]);
	return {
		...name,
		...email,
		...phone,
		...metadata,
		searchIdentityKeyFingerprint,
	};
}

export async function deriveContactEmailHash(
	keyConfig: string,
	organizationId: string,
	email: string,
): Promise<string> {
	return deriveHash(
		requireConsentHmacKeyConfig(keyConfig),
		organizationId,
		"email-exact",
		email.trim().toLowerCase(),
	);
}

export async function deriveContactPhoneHash(
	keyConfig: string,
	organizationId: string,
	phone: string,
): Promise<string | null> {
	const canonical = normalizeContactPhone(phone, {
		allowBareInternational: true,
	});
	return canonical
		? deriveHash(
				requireConsentHmacKeyConfig(keyConfig),
				organizationId,
				"phone-exact",
				canonical,
			)
		: null;
}

export async function deriveContactNameHash(
	keyConfig: string,
	organizationId: string,
	name: string,
): Promise<string> {
	return deriveHash(
		requireConsentHmacKeyConfig(keyConfig),
		organizationId,
		"name-exact",
		normalizedSearchText(name),
	);
}

export async function deriveContactSearchQuery(
	keyConfig: string,
	organizationId: string,
	query: string,
): Promise<{ tokens: string[]; phoneHash: string | null }> {
	requireBoundedText(query, "Contact search", CONTACT_SEARCH_MAX_CHARS);
	return {
		tokens: await deriveSearchTokens(
			requireConsentHmacKeyConfig(keyConfig),
			organizationId,
			ngramsForQuery(query),
		),
		phoneHash: await deriveContactPhoneHash(keyConfig, organizationId, query),
	};
}

export function contactPlaintextMatchesSearch(
	value: Pick<ContactPlaintext, "name" | "email" | "phone">,
	query: string,
): boolean {
	const needle = normalizedSearchText(query);
	if (
		[value.name, value.email, value.phone].some(
			(candidate) =>
				candidate !== null &&
				normalizedSearchText(candidate).includes(needle),
		)
	) {
		return true;
	}
	const queryPhone = normalizeContactPhone(query, {
		allowBareInternational: true,
	});
	return (
		queryPhone !== null &&
		value.phone !== null &&
		normalizeContactPhone(value.phone) === queryPhone
	);
}

async function assertIdentityFingerprint(
	keyConfig: string,
	organizationId: string,
	stored: string,
	expected?: string,
): Promise<void> {
	const fingerprint =
		expected ??
		(await consentIdentityKeyFingerprint(keyConfig, organizationId));
	if (stored !== fingerprint) {
		throw new ContactProtectionIdentityKeyMismatchError(organizationId);
	}
}

export async function decryptContactRow<T extends Partial<ContactRow> & {
	id: string;
	organizationId: string;
	nameCiphertext: string | null;
	emailCiphertext: string | null;
	phoneCiphertext: string | null;
	metadataCiphertext: string | null;
	searchIdentityKeyFingerprint: string;
}>(
	keyConfigInput: string,
	row: T,
	expectedFingerprint?: string,
): Promise<DecryptedContactRow<T>> {
	const keyConfig = requireConsentHmacKeyConfig(keyConfigInput);
	await assertIdentityFingerprint(
		keyConfig,
		row.organizationId,
		row.searchIdentityKeyFingerprint,
		expectedFingerprint,
	);
	const [name, email, phone, metadataText] = await Promise.all([
		row.nameCiphertext
			? decryptToken(
					row.nameCiphertext,
					keyConfig,
					contactEncryptionContext(row.id, "name"),
				)
			: null,
		row.emailCiphertext
			? decryptToken(
					row.emailCiphertext,
					keyConfig,
					contactEncryptionContext(row.id, "email"),
				)
			: null,
		row.phoneCiphertext
			? decryptToken(
					row.phoneCiphertext,
					keyConfig,
					contactEncryptionContext(row.id, "phone"),
				)
			: null,
		row.metadataCiphertext
			? decryptToken(
					row.metadataCiphertext,
					keyConfig,
					contactEncryptionContext(row.id, "metadata"),
				)
			: null,
	]);
	let metadata: Record<string, unknown> | null = null;
	if (metadataText !== null) {
		const parsed: unknown = JSON.parse(metadataText);
		if (
			!parsed ||
			typeof parsed !== "object" ||
			Array.isArray(parsed)
		) {
			throw new Error("Decrypted contact metadata is not an object");
		}
		metadata = parsed as Record<string, unknown>;
	}
	const {
		nameCiphertext: _nameCiphertext,
		nameHash: _nameHash,
		nameSearchTokens: _nameSearchTokens,
		emailCiphertext: _emailCiphertext,
		emailHash: _emailHash,
		emailSearchTokens: _emailSearchTokens,
		phoneCiphertext: _phoneCiphertext,
		phoneHash: _phoneHash,
		phoneSearchTokens: _phoneSearchTokens,
		metadataCiphertext: _metadataCiphertext,
		searchIdentityKeyFingerprint: _searchIdentityKeyFingerprint,
		...safe
	} = row;
	return { ...safe, name, email, phone, metadata } as DecryptedContactRow<T>;
}

export async function decryptContactRows<T extends Partial<ContactRow> & {
	id: string;
	organizationId: string;
	nameCiphertext: string | null;
	emailCiphertext: string | null;
	phoneCiphertext: string | null;
	metadataCiphertext: string | null;
	searchIdentityKeyFingerprint: string;
}>(
	keyConfig: string,
	rows: readonly T[],
): Promise<Array<DecryptedContactRow<T>>> {
	const fingerprints = new Map<string, string>();
	await Promise.all(
		[...new Set(rows.map(({ organizationId }) => organizationId))].map(
			async (organizationId) => {
				fingerprints.set(
					organizationId,
					await consentIdentityKeyFingerprint(keyConfig, organizationId),
				);
			},
		),
	);
	return Promise.all(
		rows.map((row) =>
			decryptContactRow(
				keyConfig,
				row,
				fingerprints.get(row.organizationId),
			),
		),
	);
}

export async function protectContactChannelIdentifier(
	keyConfigInput: string,
	input: {
		id: string;
		organizationId: string;
		identifier: string;
	},
) {
	const keyConfig = requireConsentHmacKeyConfig(keyConfigInput);
	requireBoundedText(
		input.identifier,
		"Contact channel identifier",
		CONTACT_CHANNEL_IDENTIFIER_MAX_CHARS,
	);
	const [
		identifierCiphertext,
		identifierHash,
		identityKeyFingerprint,
	] = await Promise.all([
		encryptToken(
			input.identifier,
			keyConfig,
			channelEncryptionContext(input.id),
		),
		deriveHash(
			keyConfig,
			input.organizationId,
			"channel-identifier-exact",
			input.identifier,
		),
		consentIdentityKeyFingerprint(keyConfig, input.organizationId),
	]);
	return {
		identifierCiphertext,
		identifierHash,
		identityKeyFingerprint,
	};
}

export async function deriveContactChannelIdentifierHash(
	keyConfig: string,
	organizationId: string,
	identifier: string,
): Promise<string> {
	return deriveHash(
		requireConsentHmacKeyConfig(keyConfig),
		organizationId,
		"channel-identifier-exact",
		identifier,
	);
}

export async function decryptContactChannelRow<
	T extends Partial<ContactChannelRow> & {
		id: string;
		organizationId: string;
		identifierCiphertext: string;
		identityKeyFingerprint: string;
	},
>(
	keyConfigInput: string,
	row: T,
	expectedFingerprint?: string,
): Promise<DecryptedContactChannelRow<T>> {
	const keyConfig = requireConsentHmacKeyConfig(keyConfigInput);
	await assertIdentityFingerprint(
		keyConfig,
		row.organizationId,
		row.identityKeyFingerprint,
		expectedFingerprint,
	);
	const identifier = await decryptToken(
		row.identifierCiphertext,
		keyConfig,
		channelEncryptionContext(row.id),
	);
	const {
		identifierCiphertext: _identifierCiphertext,
		identifierHash: _identifierHash,
		identityKeyFingerprint: _identityKeyFingerprint,
		...safe
	} = row;
	return { ...safe, identifier } as DecryptedContactChannelRow<T>;
}

export async function decryptContactChannelRows<
	T extends Partial<ContactChannelRow> & {
		id: string;
		organizationId: string;
		identifierCiphertext: string;
		identityKeyFingerprint: string;
	},
>(
	keyConfig: string,
	rows: readonly T[],
): Promise<Array<DecryptedContactChannelRow<T>>> {
	const fingerprints = new Map<string, string>();
	await Promise.all(
		[...new Set(rows.map(({ organizationId }) => organizationId))].map(
			async (organizationId) => {
				fingerprints.set(
					organizationId,
					await consentIdentityKeyFingerprint(keyConfig, organizationId),
				);
			},
		),
	);
	return Promise.all(
		rows.map((row) =>
			decryptContactChannelRow(
				keyConfig,
				row,
				fingerprints.get(row.organizationId),
			),
		),
	);
}
