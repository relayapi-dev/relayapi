const HEX_256_RE = /^[0-9a-fA-F]{64}$/;
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export const CONSENT_IDENTITY_KEY_ID = "identity";

export interface ConsentHmacKeyRing {
	activeVersion: string;
	identityKeyHex: string;
	versionKeys: ReadonlyMap<string, string>;
}

export interface ConsentIdentifierIdentity {
	channel: string;
	purpose: string;
	logicalIdentifierHash: string;
	identifierHash: string;
	identifierKeyVersion: string;
	identityKeyFingerprint: string;
}

export interface ProtectedContactSubjectLocator {
	contactSubjectLocator: string;
	contactSubjectIdentityKeyFingerprint: string;
}

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

export function requireConsentHmacKeyConfig(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(
			"ENCRYPTION_KEY with a retained identity entry is required",
		);
	}
	parseConsentHmacKeyRing(value);
	return value;
}

export function canonicalConsentDimension(
	value: string,
	name: "channel" | "purpose",
): string {
	const canonical = value.trim().toLowerCase();
	if (!canonical) throw new Error(`Consent ${name} cannot be empty`);
	return canonical;
}

/**
 * ENCRYPTION_KEY also carries one purpose-isolated HMAC identity anchor:
 *
 *   active=<64hex>,identity=<64hex>,previous=<64hex>
 *
 * The first entry remains the active AES/HMAC version. `identity` is deliberately
 * not active encryption material and must be retained unchanged across rotations.
 * Runtime state stores a keyed fingerprint so replacing it fails closed.
 */
export function parseConsentHmacKeyRing(config: string): ConsentHmacKeyRing {
	const keys = new Map<string, string>();
	for (const rawEntry of config.split(",")) {
		const entry = rawEntry.trim();
		const separator = entry.indexOf("=");
		if (separator <= 0 || entry.indexOf("=", separator + 1) !== -1) {
			throw new Error(
				"Invalid consent HMAC key ring: expected key-id=64-hex entries",
			);
		}
		const id = entry.slice(0, separator);
		const hex = entry.slice(separator + 1);
		if (!KEY_ID_RE.test(id)) {
			throw new Error(`Invalid consent HMAC key id: ${id}`);
		}
		if (!HEX_256_RE.test(hex)) {
			throw new Error(
				`Invalid consent HMAC key ${id}: expected exactly 64 hex characters`,
			);
		}
		if (keys.has(id)) {
			throw new Error(`Duplicate consent HMAC key id: ${id}`);
		}
		keys.set(id, hex.toLowerCase());
	}

	const firstId = keys.keys().next().value;
	if (!firstId)
		throw new Error("Invalid consent HMAC key ring: no keys configured");
	if (firstId === CONSENT_IDENTITY_KEY_ID) {
		throw new Error(
			"Consent identity key must be retained but cannot be the active encryption key",
		);
	}
	const identityKeyHex = keys.get(CONSENT_IDENTITY_KEY_ID);
	if (!identityKeyHex) {
		throw new Error(
			"Consent HMAC key ring must retain an identity=64-hex entry",
		);
	}
	const versionKeys = new Map(keys);
	versionKeys.delete(CONSENT_IDENTITY_KEY_ID);
	return {
		activeVersion: firstId,
		identityKeyHex,
		versionKeys,
	};
}

function importHmacKey(hexKey: string): Promise<CryptoKey> {
	let cached = hmacKeyCache.get(hexKey);
	if (!cached) {
		const pairs = hexKey.match(/.{2}/g);
		if (pairs?.length !== 32) {
			throw new Error("Invalid consent HMAC key material");
		}
		const raw = new Uint8Array(pairs.map((pair) => Number.parseInt(pair, 16)));
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

async function hmacHex(hexKey: string, message: string): Promise<string> {
	const signature = await crypto.subtle.sign(
		"HMAC",
		await importHmacKey(hexKey),
		new TextEncoder().encode(message),
	);
	return Array.from(new Uint8Array(signature), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export async function consentIdentityKeyFingerprint(
	keyConfig: string,
	organizationId: string,
): Promise<string> {
	const ring = parseConsentHmacKeyRing(keyConfig);
	return hmacHex(
		ring.identityKeyHex,
		`relayapi:consent:identity-key-fingerprint:v1\u0000${organizationId}`,
	);
}

/**
 * Stable, non-PII subject discovery key for rows whose contact FK may later be
 * set to NULL. This deliberately reuses the retained identity anchor from the
 * versioned consent key ring, but has a separate domain so consent identifiers
 * and internal contact IDs can never correlate across purposes.
 */
export async function deriveProtectedContactSubjectLocator(
	keyConfig: string,
	organizationId: string,
	contactId: string,
): Promise<ProtectedContactSubjectLocator> {
	if (!organizationId || !contactId) {
		throw new Error("Protected contact subject locator requires both IDs");
	}
	const ring = parseConsentHmacKeyRing(keyConfig);
	return {
		contactSubjectLocator: await hmacHex(
			ring.identityKeyHex,
			[
				"relayapi:protected-subject-locator:contact:v1",
				organizationId,
				contactId,
			].join("\u0000"),
		),
		contactSubjectIdentityKeyFingerprint:
			await consentIdentityKeyFingerprint(keyConfig, organizationId),
	};
}

export async function deriveConsentLookupHashFromLogical(
	keyConfig: string,
	input: {
		organizationId: string;
		channel: string;
		purpose: string;
		logicalIdentifierHash: string;
	},
): Promise<{ identifierHash: string; identifierKeyVersion: string }> {
	const ring = parseConsentHmacKeyRing(keyConfig);
	const channel = canonicalConsentDimension(input.channel, "channel");
	const purpose = canonicalConsentDimension(input.purpose, "purpose");
	const activeKey = ring.versionKeys.get(ring.activeVersion);
	if (!activeKey) {
		throw new Error(
			`Active consent HMAC key ${ring.activeVersion} is unavailable`,
		);
	}
	return {
		identifierHash: await hmacHex(
			activeKey,
			[
				"relayapi:consent:lookup:v1",
				input.organizationId,
				channel,
				purpose,
				ring.activeVersion,
				input.logicalIdentifierHash,
			].join("\u0000"),
		),
		identifierKeyVersion: ring.activeVersion,
	};
}

export async function deriveConsentIdentifierIdentity(
	keyConfig: string,
	input: {
		organizationId: string;
		channel: string;
		purpose: string;
		normalizedIdentifier: string;
	},
): Promise<ConsentIdentifierIdentity> {
	const ring = parseConsentHmacKeyRing(keyConfig);
	const channel = canonicalConsentDimension(input.channel, "channel");
	const purpose = canonicalConsentDimension(input.purpose, "purpose");
	const logicalIdentifierHash = await hmacHex(
		ring.identityKeyHex,
		[
			"relayapi:consent:logical:v1",
			input.organizationId,
			channel,
			purpose,
			input.normalizedIdentifier,
		].join("\u0000"),
	);
	const versioned = await deriveConsentLookupHashFromLogical(keyConfig, {
		organizationId: input.organizationId,
		channel,
		purpose,
		logicalIdentifierHash,
	});
	return {
		channel,
		purpose,
		logicalIdentifierHash,
		...versioned,
		identityKeyFingerprint: await consentIdentityKeyFingerprint(
			keyConfig,
			input.organizationId,
		),
	};
}
