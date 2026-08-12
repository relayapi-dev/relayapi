import {
	activeEncryptionKeyId,
	decryptToken,
	encryptionKeyId,
	encryptToken,
} from "./crypto";

const AD_CONNECTION_TOKEN_PREFIX = "adconn:v1:";

export type AdConnectionTokenField =
	| "access_token"
	| "refresh_token"
	| "token_secret";

function context(connectionId: string, field: AdConnectionTokenField) {
	if (!connectionId) {
		throw new Error("Ad connection token encryption requires a connection id");
	}
	return { recordId: connectionId, field };
}

export async function encryptAdConnectionToken(
	plaintext: string | null | undefined,
	keyConfig: string | undefined,
	connectionId: string,
	field: AdConnectionTokenField,
): Promise<string | null> {
	if (!plaintext) return plaintext ?? null;
	if (!keyConfig) throw new Error("ENCRYPTION_KEY is required but not set");
	const encrypted = await encryptToken(
		plaintext,
		keyConfig,
		context(connectionId, field),
	);
	return `${AD_CONNECTION_TOKEN_PREFIX}${encrypted}`;
}

export async function decryptAdConnectionToken(
	stored: string | null | undefined,
	keyConfig: string | undefined,
	connectionId: string,
	field: AdConnectionTokenField,
): Promise<string | null> {
	if (!stored) return stored ?? null;
	if (!keyConfig) throw new Error("ENCRYPTION_KEY is required but not set");
	if (!stored.startsWith(AD_CONNECTION_TOKEN_PREFIX)) {
		throw new Error("Invalid ad connection token: expected adconn:v1 envelope");
	}
	return decryptToken(
		stored.slice(AD_CONNECTION_TOKEN_PREFIX.length),
		keyConfig,
		context(connectionId, field),
	);
}

export function adConnectionTokenNeedsReencryption(
	stored: string | null | undefined,
	keyConfig: string,
): boolean {
	if (!stored) return false;
	if (!stored.startsWith(AD_CONNECTION_TOKEN_PREFIX)) {
		throw new Error("Invalid ad connection token: expected adconn:v1 envelope");
	}
	return (
		encryptionKeyId(stored.slice(AD_CONNECTION_TOKEN_PREFIX.length)) !==
		activeEncryptionKeyId(keyConfig)
	);
}

export async function reencryptAdConnectionToken(
	stored: string | null | undefined,
	keyConfig: string,
	connectionId: string,
	field: AdConnectionTokenField,
): Promise<string | null> {
	if (!stored || !adConnectionTokenNeedsReencryption(stored, keyConfig)) {
		return null;
	}
	const plaintext = await decryptAdConnectionToken(
		stored,
		keyConfig,
		connectionId,
		field,
	);
	return encryptAdConnectionToken(plaintext, keyConfig, connectionId, field);
}
