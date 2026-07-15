import {
	activeEncryptionKeyId,
	decryptToken,
	encryptionKeyId,
	encryptToken,
} from "./crypto";

/** Account credentials use a mandatory account- and field-bound envelope. */
const ACCOUNT_TOKEN_PREFIX = "acct:v1:";

export type AccountTokenField =
	| "access_token"
	| "refresh_token"
	| "meta_ads_user_access_token";

export interface StoredAccountTokens {
	id: string;
	accessToken: string | null;
	refreshToken: string | null;
}

function context(accountId: string, field: AccountTokenField) {
	if (!accountId)
		throw new Error("Account token encryption requires an account id");
	return { recordId: accountId, field };
}

export async function encryptAccountToken(
	plaintext: string | null | undefined,
	keyConfig: string | undefined,
	accountId: string,
	field: AccountTokenField,
): Promise<string | null> {
	if (!plaintext) return plaintext ?? null;
	if (!keyConfig) throw new Error("ENCRYPTION_KEY is required but not set");
	const ciphertext = await encryptToken(
		plaintext,
		keyConfig,
		context(accountId, field),
	);
	return `${ACCOUNT_TOKEN_PREFIX}${ciphertext}`;
}

export async function decryptAccountToken(
	stored: string | null | undefined,
	keyConfig: string | undefined,
	accountId: string,
	field: AccountTokenField,
): Promise<string | null> {
	if (!stored) return stored ?? null;
	if (!keyConfig) throw new Error("ENCRYPTION_KEY is required but not set");
	if (!stored.startsWith(ACCOUNT_TOKEN_PREFIX)) {
		throw new Error("Invalid account token: expected acct:v1 envelope");
	}
	return decryptToken(
		stored.slice(ACCOUNT_TOKEN_PREFIX.length),
		keyConfig,
		context(accountId, field),
	);
}

export async function decryptAccountTokens<T extends StoredAccountTokens>(
	account: T,
	keyConfig: string | undefined,
): Promise<T> {
	const [accessToken, refreshToken] = await Promise.all([
		decryptAccountToken(
			account.accessToken,
			keyConfig,
			account.id,
			"access_token",
		),
		decryptAccountToken(
			account.refreshToken,
			keyConfig,
			account.id,
			"refresh_token",
		),
	]);
	return { ...account, accessToken, refreshToken };
}

export function accountTokenNeedsReencryption(
	stored: string | null | undefined,
	keyConfig: string,
): boolean {
	if (!stored) return false;
	if (!stored.startsWith(ACCOUNT_TOKEN_PREFIX)) {
		throw new Error("Invalid account token: expected acct:v1 envelope");
	}
	return (
		encryptionKeyId(stored.slice(ACCOUNT_TOKEN_PREFIX.length)) !==
		activeEncryptionKeyId(keyConfig)
	);
}

export async function reencryptAccountToken(
	stored: string | null | undefined,
	keyConfig: string,
	accountId: string,
	field: AccountTokenField,
): Promise<string | null> {
	if (!stored || !accountTokenNeedsReencryption(stored, keyConfig)) return null;
	const plaintext = await decryptAccountToken(
		stored,
		keyConfig,
		accountId,
		field,
	);
	return encryptAccountToken(plaintext, keyConfig, accountId, field);
}
