import type { Env } from "../types";

export interface QueueRescueEnvelope {
	version: 2;
	originQueue: string;
	originMessageId: string;
	originAttempts: number;
	rescuedAt: string;
	organizationIds: string[];
	body: unknown;
}

function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "unknown";
}

function mediaOrganizationId(queue: string, body: unknown): string | undefined {
	if (!queue.includes("relayapi-media-cleanup")) return;
	if (!body || typeof body !== "object" || Array.isArray(body)) return;
	const object = (body as Record<string, unknown>).object;
	if (!object || typeof object !== "object" || Array.isArray(object)) return;
	const key = (object as Record<string, unknown>).key;
	if (typeof key !== "string") return;
	const organizationId = key.split("/", 1)[0];
	return organizationId || undefined;
}

function scopedOrganizationIds(queue: string, body: unknown): string[] {
	if (!body || typeof body !== "object" || Array.isArray(body)) return [];
	const value = body as Record<string, unknown>;
	const ids = new Set<string>();
	for (const name of ["organization_id", "org_id", "organizationId", "orgId"]) {
		if (typeof value[name] === "string") ids.add(value[name]);
	}
	if (Array.isArray(value.organization_ids)) {
		for (const id of value.organization_ids) {
			if (typeof id === "string") ids.add(id);
		}
	}
	const mediaScope = mediaOrganizationId(queue, body);
	if (mediaScope) ids.add(mediaScope);
	return [...ids];
}

function operationId(queue: string, body: unknown): string | undefined {
	if (!body || typeof body !== "object" || Array.isArray(body)) return;
	const value = body as Record<string, unknown>;
	for (const name of [
		"operation_id",
		"publish_operation_id",
		"job_id",
		"post_id",
		"ad_id",
		"receipt_id",
	]) {
		if (typeof value[name] === "string") return value[name];
	}
	if (
		queue.includes("relayapi-refresh") &&
		typeof value.account_id === "string"
	) {
		return value.account_id;
	}
}

function serializeEnvelope(envelope: QueueRescueEnvelope): string {
	try {
		return (
			JSON.stringify(envelope, (_key, value) =>
				typeof value === "bigint" ? value.toString() : value,
			) ?? JSON.stringify({ ...envelope, body: null })
		);
	} catch (error) {
		return JSON.stringify({
			...envelope,
			body: null,
			serializationError:
				error instanceof Error ? error.message : String(error),
		});
	}
}

export function createQueueRescueEnvelope(
	queue: string,
	message: Pick<Message<unknown>, "id" | "attempts" | "body">,
): QueueRescueEnvelope {
	const organizationIds = scopedOrganizationIds(queue, message.body);
	const body =
		organizationIds.length === 1
			? message.body
			: {
					redacted: true,
					reason:
						organizationIds.length === 0
							? "missing_tenant_scope"
							: "multiple_tenant_scope",
					...(operationId(queue, message.body)
						? { operation_id: operationId(queue, message.body) }
						: {}),
				};
	return {
		version: 2,
		originQueue: queue,
		originMessageId: message.id,
		originAttempts: message.attempts,
		rescuedAt: new Date().toISOString(),
		organizationIds: organizationIds.length === 1 ? organizationIds : [],
		body,
	};
}

/**
 * R2 is the terminal rescue ledger and is independent of PostgreSQL/Hyperdrive.
 * Deterministic keys make repeated delivery overwrite the same object instead
 * of multiplying records after a consumer crash.
 */
export async function persistQueueRescue(
	env: Env,
	envelope: QueueRescueEnvelope,
): Promise<void> {
	const scope = envelope.organizationIds[0]
		? ["by-organization", safeSegment(envelope.organizationIds[0])]
		: ["unscoped"];
	const key = [
		"queue-rescue",
		...scope,
		safeSegment(envelope.originQueue),
		`${safeSegment(envelope.originMessageId)}.json`,
	].join("/");
	await env.QUEUE_RESCUE_BUCKET.put(key, serializeEnvelope(envelope), {
		httpMetadata: { contentType: "application/json" },
		customMetadata: {
			originQueue: envelope.originQueue.slice(0, 100),
			originMessageId: envelope.originMessageId.slice(0, 180),
			...(envelope.organizationIds[0]
				? { organizationId: envelope.organizationIds[0].slice(0, 180) }
				: {}),
		},
	});
}

export async function consumeQueueRescue(
	batch: MessageBatch<QueueRescueEnvelope | unknown>,
	env: Env,
): Promise<void> {
	for (const message of batch.messages) {
		const body = message.body;
		const envelope =
			body &&
			typeof body === "object" &&
			(body as Partial<QueueRescueEnvelope>).version === 2 &&
			typeof (body as Partial<QueueRescueEnvelope>).originQueue === "string" &&
			typeof (body as Partial<QueueRescueEnvelope>).originMessageId ===
				"string" &&
			Array.isArray((body as Partial<QueueRescueEnvelope>).organizationIds) &&
			((body as Partial<QueueRescueEnvelope>).organizationIds?.length ?? 0) <=
				1 &&
			(body as Partial<QueueRescueEnvelope>).organizationIds?.every(
				(id) => typeof id === "string",
			)
				? (body as QueueRescueEnvelope)
				: createQueueRescueEnvelope("unknown-dlq", message);

		try {
			await persistQueueRescue(env, envelope);
			message.ack();
		} catch (error) {
			console.error("[Queue rescue] R2 persistence failed", {
				messageId: message.id,
				originQueue: envelope.originQueue,
				error: error instanceof Error ? error.message : String(error),
			});
			if (message.attempts >= 95) {
				try {
					// Reset the delivery budget before Cloudflare's finite retry limit can
					// discard the only copy. The deterministic R2 key keeps this idempotent.
					await env.QUEUE_RESCUE_QUEUE.send(envelope);
					message.ack();
					continue;
				} catch (handoffError) {
					console.error("[Queue rescue] self-handoff failed", {
						messageId: message.id,
						error:
							handoffError instanceof Error
								? handoffError.message
								: String(handoffError),
					});
				}
			}
			message.retry({ delaySeconds: Math.min(2 ** message.attempts, 900) });
		}
	}
}
