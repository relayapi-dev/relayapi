import { createDb, generateId, inboundWebhookEvents } from "@relayapi/db";
import { and, eq, inArray } from "drizzle-orm";
import { activeEncryptionKeyId, encryptToken } from "../lib/crypto";
import type { Env } from "../types";

const UNRESOLVED_RAW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RawInboxQueueMessage {
	type: "raw_platform_webhook";
	receipt_id: string;
	received_at: string;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Persist the verified body and synchronously await one small Queue handoff. */
export async function acceptInboundWebhook(
	env: Env,
	input: {
		provider: "meta" | "youtube" | "whatsapp" | "telegram" | "sms";
		payload: string;
		contentType?: string;
		deliveryId?: string;
		signatureMetadata?: Record<string, unknown>;
	},
): Promise<string> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const receiptId = generateId("iwe_");
	const receivedAt = new Date();
	const bodyHash = await sha256Hex(input.payload);
	const deliveryKey = input.deliveryId
		? `${input.deliveryId}:${bodyHash}`
		: bodyHash;
	const payloadCiphertext = await encryptToken(
		input.payload,
		env.ENCRYPTION_KEY,
		{ recordId: receiptId, field: "payload_ciphertext" },
	);
	const inserted = await db
		.insert(inboundWebhookEvents)
		.values({
			id: receiptId,
			provider: input.provider,
			deliveryKey,
			payloadCiphertext,
			payloadKeyId: activeEncryptionKeyId(env.ENCRYPTION_KEY),
			contentType: input.contentType ?? null,
			signatureMetadata: {
				verified: true,
				body_sha256: bodyHash,
				...(input.signatureMetadata ?? {}),
			},
			receivedAt,
			expiresAt: new Date(receivedAt.getTime() + UNRESOLVED_RAW_RETENTION_MS),
		})
		.onConflictDoNothing()
		.returning({ id: inboundWebhookEvents.id });

	let durableReceiptId = inserted[0]?.id;
	if (!durableReceiptId) {
		const [existing] = await db
			.select({
				id: inboundWebhookEvents.id,
				status: inboundWebhookEvents.status,
				redactedAt: inboundWebhookEvents.redactedAt,
			})
			.from(inboundWebhookEvents)
			.where(
				and(
					eq(inboundWebhookEvents.provider, input.provider),
					eq(inboundWebhookEvents.deliveryKey, deliveryKey),
				),
			)
			.limit(1);
		if (!existing)
			throw new Error("Inbound receipt conflict could not be loaded");
		if (
			existing.redactedAt ||
			["queued", "processing", "completed", "exhausted"].includes(
				existing.status,
			)
		) {
			return existing.id;
		}
		durableReceiptId = existing.id;
	}

	await env.INBOX_QUEUE.send({
		type: "raw_platform_webhook",
		receipt_id: durableReceiptId,
		received_at: new Date().toISOString(),
	} satisfies RawInboxQueueMessage);
	await db
		.update(inboundWebhookEvents)
		.set({ status: "queued", lastError: null })
		.where(
			and(
				eq(inboundWebhookEvents.id, durableReceiptId),
				inArray(inboundWebhookEvents.status, ["received", "failed"]),
			),
		);
	return durableReceiptId;
}
