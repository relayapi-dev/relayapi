import {
	exponentialBackoffSeconds,
	QUEUE_RESCUE_POLICY,
} from "../lib/async-policy";
import { decryptToken, encryptionKeyId, encryptToken } from "../lib/crypto";
import { dispatchQueueRescuePersistenceAlert } from "../services/operator-alerts";
import type { Env } from "../types";
import { normalizeQueueClass, type WorkQueueCapability } from "./queue-class";

export type QueueRescueSubjectKind =
	| "workspace"
	| "user"
	| "contact"
	| "account";

export interface QueueRescueSubjectLocator {
	kind: QueueRescueSubjectKind;
	id: string;
}

export interface QueueRescueEnvelope {
	version: 3;
	originQueue: string;
	originMessageId: string;
	originAttempts: number;
	rescuedAt: string;
	organizationIds: string[];
	subjectLocators: QueueRescueSubjectLocator[];
	operationId?: string;
	bodyCiphertext: string;
	bodyKeyId: string;
}

interface LegacyQueueRescueEnvelope {
	version: 2;
	originQueue: string;
	originMessageId: string;
	originAttempts: number;
	rescuedAt: string;
	organizationIds: string[];
	body: unknown;
}

const RESCUE_BODY_FIELD = "queue_rescue_body";
const MAX_SUBJECT_LOCATORS = 8;
const MAX_LOCATOR_ID_LENGTH = 180;
const SUBJECT_LOCATOR_FIELDS: Readonly<
	Record<QueueRescueSubjectKind, readonly string[]>
> = {
	workspace: ["workspace_id", "workspaceId"],
	user: ["user_id", "userId", "subject_user_id", "subjectUserId"],
	contact: ["contact_id", "contactId"],
	account: [
		"account_id",
		"accountId",
		"social_account_id",
		"socialAccountId",
		"ad_account_id",
		"adAccountId",
	],
};

const ORIGIN_CLASS_BY_MESSAGE_TYPE: Readonly<
	Record<string, WorkQueueCapability>
> = {
	publish_outbox: "publish",
	post_completion_effects: "publish",
	refresh_token: "refresh",
	tool_job: "tools",
	sync_metrics: "ads",
	sync_external: "ads",
	sync_posts: "sync",
	generate_external_preview: "sync",
	sync_automation_binding: "sync",
	refresh_internal_metrics: "sync",
	refresh_external_metrics_batch: "sync",
	deliver_customer_webhook: "customer-webhooks",
	raw_platform_webhook: "inbox",
	facebook_webhook: "inbox",
	instagram_webhook: "inbox",
	youtube_pubsub: "inbox",
	youtube_subscribe: "inbox",
	whatsapp_webhook: "inbox",
	telegram_webhook: "inbox",
	sms_webhook: "inbox",
	backfill: "inbox",
};

/**
 * Cloudflare's automatic DLQ -> rescue transfer preserves the body and
 * message identity but exposes only the rescue queue name. Recover the exact
 * configured DLQ from the same closed discriminants each consumer validates.
 */
export function inferAutomaticRescueOriginQueue(
	env: Pick<Env, "DEPLOYMENT_MODE">,
	body: unknown,
): string | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const value = body as Record<string, unknown>;
	let originClass: WorkQueueCapability | undefined;
	if (typeof value.type === "string") {
		originClass = ORIGIN_CLASS_BY_MESSAGE_TYPE[value.type];
	}
	if (
		!originClass &&
		typeof value.id === "string" &&
		Object.keys(value).every((key) => key === "id")
	) {
		originClass = "email";
	}
	if (
		!originClass &&
		typeof value.account === "string" &&
		typeof value.bucket === "string" &&
		value.object !== null &&
		typeof value.object === "object" &&
		typeof (value.object as Record<string, unknown>).key === "string" &&
		typeof value.action === "string"
	) {
		originClass = "media-cleanup";
	}
	if (!originClass) return null;
	const prefix =
		env.DEPLOYMENT_MODE === "self_hosted" ? "relayapi-selfhost" : "relayapi";
	return `${prefix}-${originClass}-dlq`;
}

function queueClass(queue: string): WorkQueueCapability | "rescue" | "unknown" {
	const normalized = normalizeQueueClass(queue);
	if (!normalized) return "unknown";
	return normalized.role === "rescue" ? "rescue" : normalized.capability;
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

function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "unknown";
}

export function queueRescueOrganizationPrefix(organizationId: string): string {
	return `queue-rescue/by-organization/${safeSegment(organizationId)}/`;
}

function mediaOrganizationId(queue: string, body: unknown): string | undefined {
	if (normalizeQueueClass(queue)?.capability !== "media-cleanup") return;
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
		normalizeQueueClass(queue)?.capability === "refresh" &&
		typeof value.account_id === "string"
	) {
		return value.account_id;
	}
}

function subjectLocators(body: unknown): QueueRescueSubjectLocator[] {
	if (!body || typeof body !== "object" || Array.isArray(body)) return [];
	const value = body as Record<string, unknown>;
	const deduplicated = new Map<string, QueueRescueSubjectLocator>();
	for (const [kind, names] of Object.entries(SUBJECT_LOCATOR_FIELDS) as Array<
		[QueueRescueSubjectKind, readonly string[]]
	>) {
		for (const name of names) {
			const id = value[name];
			if (
				typeof id !== "string" ||
				id.length === 0 ||
				id.length > MAX_LOCATOR_ID_LENGTH
			) {
				continue;
			}
			deduplicated.set(`${kind}:${id}`, { kind, id });
			if (deduplicated.size >= MAX_SUBJECT_LOCATORS) {
				return [...deduplicated.values()];
			}
		}
	}
	return [...deduplicated.values()];
}

function serializeBody(body: unknown): string {
	try {
		return (
			JSON.stringify(body, (_key, value) =>
				typeof value === "bigint" ? value.toString() : value,
			) ?? JSON.stringify({ redacted: true, reason: "unserializable_body" })
		);
	} catch {
		return JSON.stringify({
			redacted: true,
			reason: "unserializable_body",
		});
	}
}

function rescueBodyContext(envelope: {
	originQueue: string;
	originMessageId: string;
}) {
	return {
		recordId: `${envelope.originQueue}\u0000${envelope.originMessageId}`,
		field: RESCUE_BODY_FIELD,
	};
}

export async function createQueueRescueEnvelope(
	env: Env,
	queue: string,
	message: Pick<Message<unknown>, "id" | "attempts" | "body">,
	options?: {
		rescuedAt?: string;
		organizationIds?: string[];
	},
): Promise<QueueRescueEnvelope> {
	const detectedOrganizationIds =
		options?.organizationIds ?? scopedOrganizationIds(queue, message.body);
	const organizationIds =
		detectedOrganizationIds.length === 1 ? detectedOrganizationIds : [];
	const body =
		detectedOrganizationIds.length === 1
			? message.body
			: {
					redacted: true,
					reason:
						detectedOrganizationIds.length === 0
							? "missing_tenant_scope"
							: "multiple_tenant_scope",
					...(operationId(queue, message.body)
						? { operation_id: operationId(queue, message.body) }
						: {}),
				};
	const base = {
		originQueue: queue,
		originMessageId: message.id,
		originAttempts: message.attempts,
		rescuedAt: options?.rescuedAt ?? new Date().toISOString(),
		organizationIds,
		subjectLocators:
			organizationIds.length === 1 ? subjectLocators(message.body) : [],
		operationId: operationId(queue, message.body),
	};
	const bodyCiphertext = await encryptToken(
		serializeBody(body),
		env.ENCRYPTION_KEY,
		rescueBodyContext(base),
	);
	const bodyKeyId = encryptionKeyId(bodyCiphertext);
	if (!bodyKeyId)
		throw new Error("Queue rescue body encryption key ID is missing");
	return { version: 3, ...base, bodyCiphertext, bodyKeyId };
}

export async function decryptQueueRescueBody(
	env: Pick<Env, "ENCRYPTION_KEY">,
	envelope: QueueRescueEnvelope,
): Promise<unknown> {
	const plaintext = await decryptToken(
		envelope.bodyCiphertext,
		env.ENCRYPTION_KEY,
		rescueBodyContext(envelope),
	);
	return JSON.parse(plaintext);
}

function isSubjectLocator(value: unknown): value is QueueRescueSubjectLocator {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const locator = value as Partial<QueueRescueSubjectLocator>;
	return (
		(locator.kind === "workspace" ||
			locator.kind === "user" ||
			locator.kind === "contact" ||
			locator.kind === "account") &&
		typeof locator.id === "string" &&
		locator.id.length > 0 &&
		locator.id.length <= MAX_LOCATOR_ID_LENGTH
	);
}

function isEncryptedEnvelope(value: unknown): value is QueueRescueEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const envelope = value as Partial<QueueRescueEnvelope>;
	return (
		envelope.version === 3 &&
		typeof envelope.originQueue === "string" &&
		typeof envelope.originMessageId === "string" &&
		typeof envelope.originAttempts === "number" &&
		typeof envelope.rescuedAt === "string" &&
		Array.isArray(envelope.organizationIds) &&
		envelope.organizationIds.length <= 1 &&
		envelope.organizationIds.every((id) => typeof id === "string") &&
		Array.isArray(envelope.subjectLocators) &&
		envelope.subjectLocators.length <= MAX_SUBJECT_LOCATORS &&
		envelope.subjectLocators.every(isSubjectLocator) &&
		(envelope.operationId === undefined ||
			(typeof envelope.operationId === "string" &&
				envelope.operationId.length <= MAX_LOCATOR_ID_LENGTH)) &&
		typeof envelope.bodyCiphertext === "string" &&
		typeof envelope.bodyKeyId === "string" &&
		encryptionKeyId(envelope.bodyCiphertext) === envelope.bodyKeyId
	);
}

function isLegacyEnvelope(value: unknown): value is LegacyQueueRescueEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const envelope = value as Partial<LegacyQueueRescueEnvelope>;
	return (
		envelope.version === 2 &&
		typeof envelope.originQueue === "string" &&
		typeof envelope.originMessageId === "string" &&
		typeof envelope.originAttempts === "number" &&
		typeof envelope.rescuedAt === "string" &&
		Array.isArray(envelope.organizationIds) &&
		envelope.organizationIds.length <= 1 &&
		envelope.organizationIds.every((id) => typeof id === "string")
	);
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
	await env.QUEUE_RESCUE_BUCKET.put(key, JSON.stringify(envelope), {
		httpMetadata: { contentType: "application/json" },
		customMetadata: {
			originQueue: envelope.originQueue.slice(0, 100),
			originMessageId: envelope.originMessageId.slice(0, 180),
			bodyKeyId: envelope.bodyKeyId,
			subjectLocators: JSON.stringify(envelope.subjectLocators),
			...(envelope.operationId
				? { operationId: envelope.operationId.slice(0, 180) }
				: {}),
			...(envelope.organizationIds[0]
				? { organizationId: envelope.organizationIds[0].slice(0, 180) }
				: {}),
		},
	});
}

export interface QueueRescueSubjectCleanupPage {
	deleted: number;
	complete: boolean;
	cursor?: string;
}

/**
 * Delete one bounded page of rescue evidence for a typed data subject. Callers
 * persist the opaque cursor between erasure ticks. The bucket's 30-day
 * lifecycle remains the hard maximum and is never extended for a hold.
 */
export async function deleteQueueRescueSubjectPage(
	bucket: R2Bucket,
	organizationId: string,
	subject: QueueRescueSubjectLocator,
	options?: { cursor?: string; limit?: number },
): Promise<QueueRescueSubjectCleanupPage> {
	return deleteQueueRescueSubjectsPage(
		bucket,
		organizationId,
		[subject],
		options,
	);
}

export async function deleteQueueRescueSubjectsPage(
	bucket: R2Bucket,
	organizationId: string,
	subjects: readonly QueueRescueSubjectLocator[],
	options?: { cursor?: string; limit?: number },
): Promise<QueueRescueSubjectCleanupPage> {
	if (
		subjects.length === 0 ||
		subjects.length > 500 ||
		subjects.some((subject) => !isSubjectLocator(subject))
	) {
		throw new Error("Invalid queue rescue subject locator set");
	}
	const subjectKeys = new Set(
		subjects.map((subject) => `${subject.kind}:${subject.id}`),
	);
	const limit = Math.min(Math.max(Math.trunc(options?.limit ?? 500), 1), 1_000);
	const page = await bucket.list({
		prefix: queueRescueOrganizationPrefix(organizationId),
		limit,
		...(options?.cursor ? { cursor: options.cursor } : {}),
		include: ["customMetadata"],
	});
	const matchingKeys = page.objects.flatMap((object) => {
		const encoded = object.customMetadata?.subjectLocators;
		if (!encoded) return [];
		try {
			const locators = JSON.parse(encoded) as unknown;
			return Array.isArray(locators) &&
				locators.some(
					(locator) =>
						isSubjectLocator(locator) &&
						subjectKeys.has(`${locator.kind}:${locator.id}`),
				)
				? [object.key]
				: [];
		} catch {
			return [];
		}
	});
	if (matchingKeys.length > 0) await bucket.delete(matchingKeys);
	return {
		deleted: matchingKeys.length,
		complete: !page.truncated,
		...(page.truncated && page.cursor ? { cursor: page.cursor } : {}),
	};
}

export async function deleteQueueRescueSubject(
	bucket: R2Bucket,
	organizationId: string,
	subject: QueueRescueSubjectLocator,
	options?: { maxPages?: number; pageSize?: number },
): Promise<number> {
	const maxPages = Math.min(
		Math.max(Math.trunc(options?.maxPages ?? 20), 1),
		100,
	);
	let cursor: string | undefined;
	let deleted = 0;
	for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
		const page = await deleteQueueRescueSubjectPage(
			bucket,
			organizationId,
			subject,
			{ cursor, limit: options?.pageSize },
		);
		deleted += page.deleted;
		if (page.complete) return deleted;
		cursor = page.cursor;
		if (!cursor) break;
	}
	throw new Error(
		`Queue rescue subject cleanup exceeded ${maxPages} bounded pages`,
	);
}

export async function deleteQueueRescueSubjects(
	bucket: R2Bucket,
	organizationId: string,
	subjects: readonly QueueRescueSubjectLocator[],
	options?: { maxPages?: number; pageSize?: number },
): Promise<number> {
	const maxPages = Math.min(
		Math.max(Math.trunc(options?.maxPages ?? 20), 1),
		100,
	);
	let cursor: string | undefined;
	let deleted = 0;
	for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
		const page = await deleteQueueRescueSubjectsPage(
			bucket,
			organizationId,
			subjects,
			{ cursor, limit: options?.pageSize },
		);
		deleted += page.deleted;
		if (page.complete) return deleted;
		cursor = page.cursor;
		if (!cursor) break;
	}
	throw new Error(
		`Queue rescue subject cleanup exceeded ${maxPages} bounded pages`,
	);
}

export async function consumeQueueRescue(
	batch: MessageBatch<
		QueueRescueEnvelope | LegacyQueueRescueEnvelope | unknown
	>,
	env: Env,
): Promise<void> {
	for (const message of batch.messages) {
		const body = message.body;
		let envelope: QueueRescueEnvelope | undefined;
		const inferredRawOrigin =
			inferAutomaticRescueOriginQueue(env, body) ?? batch.queue;

		try {
			if (isEncryptedEnvelope(body)) {
				// Reconstruct the object to strip any untrusted extra properties
				// before it reaches the immutable rescue artifact.
				envelope = {
					version: 3,
					originQueue: body.originQueue,
					originMessageId: body.originMessageId,
					originAttempts: body.originAttempts,
					rescuedAt: body.rescuedAt,
					organizationIds: body.organizationIds,
					subjectLocators: body.subjectLocators,
					...(body.operationId ? { operationId: body.operationId } : {}),
					bodyCiphertext: body.bodyCiphertext,
					bodyKeyId: body.bodyKeyId,
				};
			} else if (isLegacyEnvelope(body)) {
				envelope = await createQueueRescueEnvelope(
					env,
					body.originQueue,
					{
						id: body.originMessageId,
						attempts: body.originAttempts,
						body: body.body,
					},
					{
						rescuedAt: body.rescuedAt,
						organizationIds: body.organizationIds,
					},
				);
			} else {
				envelope = await createQueueRescueEnvelope(
					env,
					inferredRawOrigin,
					message,
				);
			}
			await persistQueueRescue(env, envelope);
			message.ack();
		} catch (error) {
			console.error("[Queue rescue] R2 persistence failed", {
				messageId: message.id,
				originQueue:
					envelope?.originQueue ??
					(isLegacyEnvelope(body) ? body.originQueue : inferredRawOrigin),
				attempt: message.attempts,
				error: error instanceof Error ? error.message : String(error),
			});
			if (
				QUEUE_RESCUE_POLICY.alertAttempts.some(
					(attempt) => attempt === message.attempts,
				)
			) {
				const originQueue =
					envelope?.originQueue ??
					(isLegacyEnvelope(body) ? body.originQueue : inferredRawOrigin);
				const originMessageId =
					envelope?.originMessageId ??
					(isLegacyEnvelope(body) ? body.originMessageId : message.id);
				const messageDigest = await sha256Hex(
					`${originQueue}\u0000${originMessageId}`,
				);
				console.error("[Queue rescue] persistent terminal-ledger failure", {
					messageId: message.id,
					attempt: message.attempts,
					terminal: message.attempts >= QUEUE_RESCUE_POLICY.terminalAttempt,
				});
				try {
					await dispatchQueueRescuePersistenceAlert(
						{
							type: "queue_rescue_persistence_failure",
							organizationId: envelope?.organizationIds[0] ?? null,
							queueClass: queueClass(originQueue),
							messageDigest,
							attempt: message.attempts,
							terminal: message.attempts >= QUEUE_RESCUE_POLICY.terminalAttempt,
							observedAt: new Date().toISOString(),
							occurrenceId: `queue-rescue:${messageDigest}:${message.attempts}`,
						},
						env,
					);
				} catch {
					console.error("[Queue rescue] sanitized operator alert failed", {
						attempt: message.attempts,
					});
				}
			}
			if (message.attempts >= QUEUE_RESCUE_POLICY.terminalAttempt) {
				// The application budget is authoritative. ACK after the terminal
				// structured alert so at-least-once configuration cannot silently
				// renew the budget forever through a self-handoff loop.
				message.ack();
				continue;
			}
			message.retry({
				delaySeconds: exponentialBackoffSeconds(
					message.attempts,
					QUEUE_RESCUE_POLICY.retry,
					`${envelope?.originQueue ?? inferredRawOrigin}:${envelope?.originMessageId ?? message.id}:${message.attempts}`,
				),
			});
		}
	}
}
