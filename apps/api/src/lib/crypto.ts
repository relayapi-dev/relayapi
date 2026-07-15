/**
 * AES-256-GCM encryption/decryption for sensitive tokens stored at rest.
 *
 * Encrypted values are stored as: `enc:v2:<key-id>:<base64(iv + ciphertext + tag)>`
 * - IV: 12 bytes (GCM recommended)
 * - Tag: 128 bits (appended by SubtleCrypto)
 *
 * ENCRYPTION_KEY is an ordered key ring: `active=64hex,previous=64hex`.
 * A single key must still have an explicit ID (for example, `active=64hex`).
 * The first entry is used for writes and every retained entry is available for
 * reads while a rotation is in progress.
 */

const ENC_V2_PREFIX = "enc:v2:";
const IV_LENGTH = 12;
const HEX_256_RE = /^[0-9a-fA-F]{64}$/;
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export interface EncryptionContext {
	recordId: string;
	field: string;
}

interface KeyRing {
	activeId: string;
	keys: Map<string, string>;
}

// The imported CryptoKey is pure (raw AES key, no KDF) but each call still parses
// the hex and crosses into SubtleCrypto. The secret is process-wide and constant,
// so memoize the imported key per hex secret for the lifetime of the isolate —
// every import after the first collapses into a Map hit. This matters on hot
// inbox/posts list paths that decrypt many account tokens per request.
const keyCache = new Map<string, Promise<CryptoKey>>();

function parseKeyRing(config: string): KeyRing {
	const keys = new Map<string, string>();
	for (const rawEntry of config.split(",")) {
		const entry = rawEntry.trim();
		const separator = entry.indexOf("=");
		if (separator <= 0) {
			throw new Error(
				"Invalid encryption key ring: expected key-id=64-hex entries",
			);
		}
		const id = entry.slice(0, separator);
		const hex = entry.slice(separator + 1);
		if (!KEY_ID_RE.test(id)) {
			throw new Error(`Invalid encryption key id: ${id}`);
		}
		if (!HEX_256_RE.test(hex)) {
			throw new Error(`Invalid encryption key ${id}: expected exactly 64 hex characters`);
		}
		if (keys.has(id)) {
			throw new Error(`Duplicate encryption key id: ${id}`);
		}
		keys.set(id, hex.toLowerCase());
	}

	const activeId = keys.keys().next().value;
	if (!activeId) throw new Error("Invalid encryption key ring: no keys configured");
	return { activeId, keys };
}

function additionalData(context: EncryptionContext | undefined): ArrayBuffer | undefined {
	if (!context) return undefined;
	if (!context.recordId || !context.field) {
		throw new Error("Encryption context requires recordId and field");
	}
	return new TextEncoder().encode(
		`relayapi:v2:${context.recordId}:${context.field}`,
	).buffer as ArrayBuffer;
}

function importKey(hexKey: string): Promise<CryptoKey> {
	if (!HEX_256_RE.test(hexKey)) {
		throw new Error("Invalid encryption key: expected exactly 64 hex characters");
	}
	let cached = keyCache.get(hexKey);
	if (!cached) {
		const hexPairs = hexKey.match(/.{2}/g) as RegExpMatchArray;
		const raw = new Uint8Array(hexPairs.map((b) => Number.parseInt(b, 16)));
		cached = crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
			"encrypt",
			"decrypt",
		]);
		keyCache.set(hexKey, cached);
	}
	return cached;
}

export async function encryptToken(
	plaintext: string,
	keyConfig: string,
	context?: EncryptionContext,
): Promise<string> {
	const ring = parseKeyRing(keyConfig);
	const keyHex = ring.keys.get(ring.activeId);
	if (!keyHex) throw new Error(`Active encryption key ${ring.activeId} is unavailable`);
	const key = await importKey(keyHex);
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const encoded = new TextEncoder().encode(plaintext);
	const cipherBuf = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: additionalData(context) },
		key,
		encoded,
	);
	// Combine IV + ciphertext+tag into a single buffer
	const combined = new Uint8Array(IV_LENGTH + cipherBuf.byteLength);
	combined.set(iv, 0);
	combined.set(new Uint8Array(cipherBuf), IV_LENGTH);
	return `${ENC_V2_PREFIX}${ring.activeId}:${btoa(String.fromCharCode(...combined))}`;
}

export async function decryptToken(
	stored: string,
	keyConfig: string,
	context?: EncryptionContext,
): Promise<string> {
	if (!stored.startsWith(ENC_V2_PREFIX)) {
		throw new Error("Invalid encrypted value: expected enc:v2 envelope");
	}

	const ring = parseKeyRing(keyConfig);
	const remainder = stored.slice(ENC_V2_PREFIX.length);
	const separator = remainder.indexOf(":");
	if (separator <= 0) throw new Error("Invalid v2 encrypted value");
	const keyId = remainder.slice(0, separator);
	const encoded = remainder.slice(separator + 1);
	const keyHex = ring.keys.get(keyId);
	if (!keyHex) throw new Error(`Encryption key ${keyId} is not configured`);
	const aad = additionalData(context);

	const raw = Uint8Array.from(atob(encoded), (c) =>
		c.charCodeAt(0),
	);
	if (raw.byteLength <= IV_LENGTH) throw new Error("Invalid encrypted value");
	const iv = raw.slice(0, IV_LENGTH);
	const ciphertext = raw.slice(IV_LENGTH);
	const key = await importKey(keyHex);
	const plainBuf = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv, additionalData: aad },
		key,
		ciphertext,
	);
	return new TextDecoder().decode(plainBuf);
}

export function encryptionKeyId(stored: string): string | null {
	if (!stored.startsWith(ENC_V2_PREFIX)) return null;
	const remainder = stored.slice(ENC_V2_PREFIX.length);
	const separator = remainder.indexOf(":");
	return separator > 0 ? remainder.slice(0, separator) : null;
}

export function activeEncryptionKeyId(keyConfig: string): string {
	return parseKeyRing(keyConfig).activeId;
}

export function needsReencryption(stored: string, keyConfig: string): boolean {
	return encryptionKeyId(stored) !== activeEncryptionKeyId(keyConfig);
}

/**
 * Encrypt a token. ENCRYPTION_KEY is required — missing key is a fatal error.
 */
export async function maybeEncrypt(
	plaintext: string | null | undefined,
	keyConfig: string | undefined,
	context?: EncryptionContext,
): Promise<string | null> {
	if (!plaintext) return plaintext ?? null;
	if (!keyConfig) throw new Error("ENCRYPTION_KEY is required but not set");
	return encryptToken(plaintext, keyConfig, context);
}

/**
 * Decrypt a token. ENCRYPTION_KEY is required — missing key is a fatal error.
 */
export async function maybeDecrypt(
	stored: string | null | undefined,
	keyConfig: string | undefined,
	context?: EncryptionContext,
): Promise<string | null> {
	if (!stored) return stored ?? null;
	if (!keyConfig) throw new Error("ENCRYPTION_KEY is required but not set");
	return decryptToken(stored, keyConfig, context);
}
