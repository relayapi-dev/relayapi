import { createDb, webhookEndpoints, webhookLogs } from "@relayapi/db";
import type { Database } from "@relayapi/db";
import { generateId } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import { isBlockedUrlWithDns } from "../lib/ssrf-guard";
import { maybeDecrypt } from "../lib/crypto";
import type { Env } from "../types";

interface WebhookEndpointRow {
	id: string;
	organizationId: string;
	url: string;
	secret: string; // This is the HASHED secret from DB
}

/**
 * Sign payload with HMAC-SHA256.
 */
async function signPayload(payload: string, rawSecret: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(rawSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
	return Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Deliver a webhook event to a registered endpoint with HMAC signing and retry.
 * The raw secret is fetched from KV (stored at webhook creation time).
 */
export async function deliverWebhook(
	env: Env,
	webhook: WebhookEndpointRow,
	event: string,
	data: unknown,
): Promise<void> {
	const deliveryId = generateId("whd_");
	const timestamp = new Date().toISOString();

	const payload = JSON.stringify({
		id: deliveryId,
		event,
		data,
		timestamp,
	});

	// Fetch raw secret from KV for HMAC signing
	// DB stores the hashed secret, KV stores the encrypted raw secret
	const encryptedSecret = await env.KV.get(`webhook-secret:${webhook.id}`);
	const rawSecret = encryptedSecret ? await maybeDecrypt(encryptedSecret, env.ENCRYPTION_KEY) : null;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-RelayAPI-Event": event,
		"X-RelayAPI-Delivery-Id": deliveryId,
	};

	// Only sign if we have the raw secret
	if (rawSecret) {
		const signature = await signPayload(payload, rawSecret);
		headers["X-RelayAPI-Signature"] = `sha256=${signature}`;
	}

	// SECURITY: Re-validate URL at delivery time to prevent SSRF via DNS rebinding
	if (await isBlockedUrlWithDns(webhook.url)) {
		console.error(`[webhook-delivery] Blocked SSRF attempt to ${webhook.url} for webhook ${webhook.id}`);
		return;
	}

	const maxAttempts = 3;
	let lastStatusCode: number | null = null;
	let lastError: string | null = null;
	let success = false;
	let responseTimeMs = 0;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const start = Date.now();
		try {
			const response = await fetchWithTimeout(webhook.url, {
				method: "POST",
				headers,
				body: payload,
				redirect: "error", // Prevent following redirects to internal addresses
				timeout: 5_000,
			});
			responseTimeMs = Date.now() - start;
			lastStatusCode = response.status;
			success = response.ok;

			if (success) break;
			lastError = `HTTP ${response.status}`;
		} catch (err) {
			responseTimeMs = Date.now() - start;
			lastError = err instanceof Error ? err.message : "Network error";
		}

		// Exponential backoff: 1s, 4s, 9s
		if (attempt < maxAttempts - 1) {
			await new Promise((r) => setTimeout(r, (attempt + 1) ** 2 * 1000));
		}
	}

	// Log the delivery attempt
	try {
		const db = createDb(env.HYPERDRIVE.connectionString);
		await db.insert(webhookLogs).values({
			webhookId: webhook.id,
			organizationId: webhook.organizationId,
			event,
			payload: data as Record<string, unknown>,
			statusCode: lastStatusCode,
			responseTimeMs,
			success,
			error: lastError,
		});
	} catch (err) {
		console.error("Failed to log webhook delivery:", err);
	}
}

/**
 * Dispatch a webhook event to all matching endpoints for an organization.
 */
export async function dispatchWebhookEvent(
	env: Env,
	db: Database,
	orgId: string,
	event: string,
	data: unknown,
	workspaceId?: string | null,
): Promise<void> {
	const webhooks = await db
		.select()
		.from(webhookEndpoints)
		.where(
			and(
				eq(webhookEndpoints.organizationId, orgId),
				eq(webhookEndpoints.enabled, true),
			),
		);

	await Promise.allSettled(
		webhooks
			.filter((w) => {
				const events = w.events ?? [];
				const eventMatch = events.length === 0 || events.includes(event);
				// Workspace-scoped webhooks only receive events from the same workspace.
				if (w.workspaceId) return workspaceId === w.workspaceId && eventMatch;
				return eventMatch;
			})
			.map((w) =>
				deliverWebhook(env, w, event, data).catch((err) =>
					console.error(`Webhook delivery failed for ${w.id}:`, err),
				),
			),
	);
}
