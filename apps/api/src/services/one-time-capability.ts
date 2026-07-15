import { type Database, oneTimeCapabilities } from "@relayapi/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { decryptToken, encryptToken } from "../lib/crypto";

export type OneTimeCapabilityKind = "oauth_state" | "websocket_ticket";

async function capabilityId(
	kind: OneTimeCapabilityKind,
	token: string,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`${kind}\0${token}`),
	);
	return `cap_${Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")}`;
}

export async function issueOneTimeCapability(
	db: Database,
	encryptionKey: string,
	params: {
		kind: OneTimeCapabilityKind;
		token: string;
		organizationId?: string | null;
		payload: Record<string, unknown>;
		expiresAt: Date;
	},
): Promise<void> {
	if (params.expiresAt <= new Date()) {
		throw new Error("One-time capability expiry must be in the future");
	}
	const id = await capabilityId(params.kind, params.token);
	const payloadCiphertext = await encryptToken(
		JSON.stringify(params.payload),
		encryptionKey,
		{ recordId: id, field: "payload" },
	);
	await db.insert(oneTimeCapabilities).values({
		id,
		kind: params.kind,
		organizationId: params.organizationId ?? null,
		payloadCiphertext,
		expiresAt: params.expiresAt,
	});
}

/** Atomically consumes a capability and validates its absolute SQL expiry. */
export async function claimOneTimeCapability<T extends object>(
	db: Database,
	encryptionKey: string,
	kind: OneTimeCapabilityKind,
	token: string,
	now = new Date(),
): Promise<T | null> {
	const id = await capabilityId(kind, token);
	const [claimed] = await db
		.update(oneTimeCapabilities)
		.set({ claimedAt: now })
		.where(
			and(
				eq(oneTimeCapabilities.id, id),
				eq(oneTimeCapabilities.kind, kind),
				isNull(oneTimeCapabilities.claimedAt),
				gt(oneTimeCapabilities.expiresAt, now),
			),
		)
		.returning({ payloadCiphertext: oneTimeCapabilities.payloadCiphertext });
	if (!claimed) return null;
	const plaintext = await decryptToken(
		claimed.payloadCiphertext,
		encryptionKey,
		{ recordId: id, field: "payload" },
	);
	const value = JSON.parse(plaintext) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("One-time capability payload is invalid");
	}
	return value as T;
}
