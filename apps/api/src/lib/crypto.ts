/**
 * AES-256-GCM encryption/decryption for sensitive tokens stored at rest.
 *
 * Encrypted values are stored as: `enc:<base64(iv + ciphertext + tag)>`
 * - IV: 12 bytes (GCM recommended)
 * - Tag: 128 bits (appended by SubtleCrypto)
 *
 * The ENCRYPTION_KEY env var must be a 64-char hex string (256 bits).
 */

const ENC_PREFIX = "enc:";
const IV_LENGTH = 12;

async function importKey(hexKey: string): Promise<CryptoKey> {
	const raw = new Uint8Array(
		hexKey.match(/.{2}/g)!.map((b) => Number.parseInt(b, 16)),
	);
	return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
		"encrypt",
		"decrypt",
	]);
}

export async function encryptToken(
	plaintext: string,
	hexKey: string,
): Promise<string> {
	const key = await importKey(hexKey);
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const encoded = new TextEncoder().encode(plaintext);
	const cipherBuf = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		encoded,
	);
	// Combine IV + ciphertext+tag into a single buffer
	const combined = new Uint8Array(IV_LENGTH + cipherBuf.byteLength);
	combined.set(iv, 0);
	combined.set(new Uint8Array(cipherBuf), IV_LENGTH);
	return ENC_PREFIX + btoa(String.fromCharCode(...combined));
}

export async function decryptToken(
	stored: string,
	hexKey: string,
): Promise<string> {
	// Plaintext legacy tokens (not yet encrypted) are returned as-is
	if (!stored.startsWith(ENC_PREFIX)) {
		return stored;
	}

	const key = await importKey(hexKey);
	const raw = Uint8Array.from(atob(stored.slice(ENC_PREFIX.length)), (c) =>
		c.charCodeAt(0),
	);
	const iv = raw.slice(0, IV_LENGTH);
	const ciphertext = raw.slice(IV_LENGTH);
	const plainBuf = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		key,
		ciphertext,
	);
	return new TextDecoder().decode(plainBuf);
}

/**
 * Encrypt a token. ENCRYPTION_KEY is required — missing key is a fatal error.
 */
export async function maybeEncrypt(
	plaintext: string | null | undefined,
	hexKey: string | undefined,
): Promise<string | null> {
	if (!plaintext) return plaintext ?? null;
	if (!hexKey) throw new Error("ENCRYPTION_KEY is required but not set");
	return encryptToken(plaintext, hexKey);
}

/**
 * Decrypt a token. ENCRYPTION_KEY is required — missing key is a fatal error.
 */
export async function maybeDecrypt(
	stored: string | null | undefined,
	hexKey: string | undefined,
): Promise<string | null> {
	if (!stored) return stored ?? null;
	if (!hexKey) throw new Error("ENCRYPTION_KEY is required but not set");
	return decryptToken(stored, hexKey);
}

/**
 * Decrypt accessToken and refreshToken on an account object.
 * Returns the original object with tokens replaced by plaintext.
 * ENCRYPTION_KEY is required — missing key is a fatal error.
 */
export async function decryptAccountTokens<
	T extends { accessToken: string | null; refreshToken: string | null },
>(account: T, encryptionKey: string | undefined): Promise<T> {
	if (!encryptionKey) throw new Error("ENCRYPTION_KEY is required but not set");
	return {
		...account,
		accessToken: account.accessToken
			? await decryptToken(account.accessToken, encryptionKey)
			: null,
		refreshToken: account.refreshToken
			? await decryptToken(account.refreshToken, encryptionKey)
			: null,
	};
}
