import { LEGACY_CREDENTIAL_VERSION } from "@relayapi/db";

const LEGACY_VERSION = "v1";
const CURRENT_VERSION = "v2";
const IV_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface DashboardCredentialPointer {
	apiKey: string;
	credentialVersion: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
	const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	const binary = atob(padded);
	const decoded = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		decoded[index] = binary.charCodeAt(index);
	}
	return decoded;
}

async function envelopeKey(secret: string): Promise<CryptoKey> {
	if (secret.length < 16) {
		throw new Error("Dashboard credential envelope secret is unavailable");
	}
	const material = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(`relayapi:dashboard-credential-envelope:v1:${secret}`),
	);
	return crypto.subtle.importKey("raw", material, "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

export async function encryptDashboardApiKey(
	rawKey: string,
	secret: string,
	pointerName: string,
	credentialVersion = LEGACY_CREDENTIAL_VERSION,
): Promise<string> {
	if (!credentialVersion || credentialVersion.length > 128) {
		throw new Error("Dashboard credential version is invalid");
	}
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv,
			additionalData: encoder.encode(pointerName),
		},
		await envelopeKey(secret),
		encoder.encode(JSON.stringify({ apiKey: rawKey, credentialVersion })),
	);
	return `${CURRENT_VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(
		new Uint8Array(ciphertext),
	)}`;
}

export async function decryptDashboardCredential(
	envelope: string,
	secret: string,
	pointerName: string,
): Promise<DashboardCredentialPointer> {
	const [version, encodedIv, encodedCiphertext, extra] = envelope.split(".");
	if (
		(version !== LEGACY_VERSION && version !== CURRENT_VERSION) ||
		!encodedIv ||
		!encodedCiphertext ||
		extra !== undefined
	) {
		throw new Error("Dashboard credential envelope is malformed");
	}
	const iv = base64UrlDecode(encodedIv);
	if (iv.byteLength !== IV_BYTES) {
		throw new Error("Dashboard credential envelope IV is malformed");
	}
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv,
			additionalData: encoder.encode(pointerName),
		},
		await envelopeKey(secret),
		base64UrlDecode(encodedCiphertext),
	);
	const decoded = decoder.decode(plaintext);
	const payload: DashboardCredentialPointer =
		version === LEGACY_VERSION
			? { apiKey: decoded, credentialVersion: LEGACY_CREDENTIAL_VERSION }
			: parseCurrentPayload(decoded);
	if (
		!payload.apiKey.startsWith("rlay_live_") &&
		!payload.apiKey.startsWith("rlay_test_")
	) {
		throw new Error("Dashboard credential envelope payload is invalid");
	}
	return payload;
}

function parseCurrentPayload(value: string): DashboardCredentialPointer {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("Dashboard credential envelope payload is malformed");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		Object.keys(parsed).some(
			(key) => key !== "apiKey" && key !== "credentialVersion",
		) ||
		typeof (parsed as { apiKey?: unknown }).apiKey !== "string" ||
		typeof (parsed as { credentialVersion?: unknown }).credentialVersion !==
			"string" ||
		!(parsed as { credentialVersion: string }).credentialVersion ||
		(parsed as { credentialVersion: string }).credentialVersion.length > 128
	) {
		throw new Error("Dashboard credential envelope payload is invalid");
	}
	return parsed as DashboardCredentialPointer;
}

/** Compatibility helper for callers that only need the bearer itself. */
export async function decryptDashboardApiKey(
	envelope: string,
	secret: string,
	pointerName: string,
): Promise<string> {
	return (await decryptDashboardCredential(envelope, secret, pointerName)).apiKey;
}
