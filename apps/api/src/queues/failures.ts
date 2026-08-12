import {
	createDb,
	inboundWebhookEvents,
	organization,
	queueFailures,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { decryptToken, encryptionKeyId, encryptToken } from "../lib/crypto";
import type { Env } from "../types";
import { normalizeQueueClass } from "./queue-class";

export type QueueFailureKind =
	| "permanent_input"
	| "unknown_external_outcome"
	| "dead_letter";

function stringField(body: unknown, ...names: string[]): string | null {
	if (!body || typeof body !== "object") return null;
	const value = body as Record<string, unknown>;
	for (const name of names) {
		if (typeof value[name] === "string") return value[name];
	}
	return null;
}

function normalizePayload(body: unknown): Record<string, unknown> {
	if (body && typeof body === "object" && !Array.isArray(body)) {
		return body as Record<string, unknown>;
	}
	return { raw_body: body ?? null };
}

function organizationIds(body: unknown): string[] {
	if (!body || typeof body !== "object") return [];
	const value = body as Record<string, unknown>;
	const ids = new Set<string>();
	for (const name of ["org_id", "organization_id"]) {
		if (typeof value[name] === "string") ids.add(value[name]);
	}
	if (Array.isArray(value.organization_ids)) {
		for (const id of value.organization_ids) {
			if (typeof id === "string") ids.add(id);
		}
	}
	return [...ids];
}

function locatorIds(
	body: unknown,
	scalarNames: readonly string[],
	arrayName: string,
): string[] {
	if (!body || typeof body !== "object" || Array.isArray(body)) return [];
	const value = body as Record<string, unknown>;
	const ids = new Set<string>();
	for (const name of scalarNames) {
		if (typeof value[name] === "string" && value[name]) {
			ids.add(value[name]);
		}
	}
	if (Array.isArray(value[arrayName])) {
		for (const id of value[arrayName]) {
			if (typeof id === "string" && id) ids.add(id);
		}
	}
	return [...ids];
}

function sanitizeQueueFailureError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
		.replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[redacted-phone]")
		.replace(
			/\b(bearer|token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi,
			"$1=[redacted]",
		)
		.slice(0, 2_000);
}

function queueFailurePayloadContext(
	queueName: string,
	messageId: string,
): { recordId: string; field: string } {
	return {
		recordId: `${queueName}:${messageId}`,
		field: "queue_failure_payload",
	};
}

export async function encryptQueueFailurePayload(
	env: Pick<Env, "ENCRYPTION_KEY">,
	queueName: string,
	messageId: string,
	payload: unknown,
): Promise<{ payloadCiphertext: string; payloadKeyId: string }> {
	const payloadCiphertext = await encryptToken(
		JSON.stringify(normalizePayload(payload)),
		env.ENCRYPTION_KEY,
		queueFailurePayloadContext(queueName, messageId),
	);
	const payloadKeyId = encryptionKeyId(payloadCiphertext);
	if (!payloadKeyId) throw new Error("Queue-failure payload key ID is missing");
	return { payloadCiphertext, payloadKeyId };
}

export async function decryptQueueFailurePayload(
	env: Pick<Env, "ENCRYPTION_KEY">,
	row: {
		queueName: string;
		messageId: string;
		payloadCiphertext: string | null;
	},
): Promise<Record<string, unknown> | null> {
	if (!row.payloadCiphertext) return null;
	const plaintext = await decryptToken(
		row.payloadCiphertext,
		env.ENCRYPTION_KEY,
		queueFailurePayloadContext(row.queueName, row.messageId),
	);
	const parsed = JSON.parse(plaintext) as unknown;
	return parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: null;
}

function mediaOrganizationId(queueName: string, body: unknown): string | null {
	if (normalizeQueueClass(queueName)?.capability !== "media-cleanup")
		return null;
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const object = (body as Record<string, unknown>).object;
	if (!object || typeof object !== "object" || Array.isArray(object))
		return null;
	const key = (object as Record<string, unknown>).key;
	if (typeof key !== "string") return null;
	return key.split("/", 1)[0] || null;
}

export interface QueueFailureRecord {
	queueName: string;
	messageId: string;
	attempts: number;
	payload: unknown;
	kind: QueueFailureKind;
	error: unknown;
	organizationIds?: string[];
	operationId?: string | null;
}

/** Persist a terminal record when no Cloudflare Message object is available. */
export async function recordQueueFailureRecord(
	env: Env,
	input: QueueFailureRecord,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const payload = normalizePayload(input.payload);
	const operationId =
		input.operationId ??
		stringField(
			payload,
			"operation_id",
			"publish_operation_id",
			"job_id",
			"post_id",
			"ad_id",
			"receipt_id",
		);
	const queueCapability = normalizeQueueClass(input.queueName)?.capability;
	await db.transaction(async (tx) => {
		const scopedOrganizations = new Set([
			...(input.organizationIds ?? []),
			...organizationIds(input.payload),
		]);
		const mediaScope = mediaOrganizationId(input.queueName, input.payload);
		if (mediaScope) scopedOrganizations.add(mediaScope);
		if (
			scopedOrganizations.size === 0 &&
			queueCapability === "refresh" &&
			typeof payload.account_id === "string"
		) {
			const [account] = await tx
				.select({ organizationId: socialAccounts.organizationId })
				.from(socialAccounts)
				.where(eq(socialAccounts.id, payload.account_id))
				.limit(1);
			if (account) scopedOrganizations.add(account.organizationId);
		}
		// Raw receipt Queue messages intentionally contain only the durable receipt
		// ID. Resolve the tenant fan-out recorded by the inbox dispatcher so the DLQ
		// entry is immediately visible through every affected organization.
		if (
			scopedOrganizations.size === 0 &&
			queueCapability === "inbox" &&
			typeof payload.receipt_id === "string"
		) {
			const [receipt] = await tx
				.select({ organizationIds: inboundWebhookEvents.organizationIds })
				.from(inboundWebhookEvents)
				.where(eq(inboundWebhookEvents.id, payload.receipt_id))
				.limit(1);
			for (const organizationId of receipt?.organizationIds ?? []) {
				scopedOrganizations.add(organizationId);
			}
		}
		const hasTenantScope = scopedOrganizations.size > 0;

		// Lock surviving tenant rows while the failure is written. This serializes
		// with organization deletion: the purge either removes this record afterward
		// or this write observes the tenant as non-active and cannot reattach it.
		let activeOrganizationIds: string[] = [];
		if (scopedOrganizations.size > 0) {
			const rows = await tx
				.select({ id: organization.id })
				.from(organization)
				.where(
					and(
						inArray(organization.id, [...scopedOrganizations]),
						eq(organization.lifecycleStatus, "active"),
					),
				)
				.for("key share");
			activeOrganizationIds = rows.map(({ id }) => id);
		}
		// A tenant-scoped failure must not be re-created as an unscoped record
		// after that tenant has been fenced or purged.
		if (hasTenantScope && activeOrganizationIds.length === 0) return;
		const persistedPayload =
			hasTenantScope && activeOrganizationIds.length < scopedOrganizations.size
				? {
						redacted: true,
						reason: "inactive_tenant_scope_removed",
						active_organization_ids: activeOrganizationIds,
						...(operationId ? { operation_id: operationId } : {}),
					}
				: payload;
		const encryptedPayload = await encryptQueueFailurePayload(
			env,
			input.queueName,
			input.messageId,
			persistedPayload,
		);
		const preserveSubjectLocators =
			!hasTenantScope ||
			activeOrganizationIds.length === scopedOrganizations.size;

		await tx
			.insert(queueFailures)
			.values({
				queueName: input.queueName,
				messageId: input.messageId,
				organizationIds: activeOrganizationIds,
				operationId,
				failureKind: input.kind,
				attempts: input.attempts,
				...encryptedPayload,
				workspaceIds: preserveSubjectLocators
					? locatorIds(input.payload, ["workspace_id"], "workspace_ids")
					: [],
				userIds: preserveSubjectLocators
					? locatorIds(input.payload, ["user_id"], "user_ids")
					: [],
				contactIds: preserveSubjectLocators
					? locatorIds(input.payload, ["contact_id"], "contact_ids")
					: [],
				accountIds: preserveSubjectLocators
					? locatorIds(
							input.payload,
							["account_id", "social_account_id"],
							"account_ids",
						)
					: [],
				error: sanitizeQueueFailureError(input.error),
			})
			.onConflictDoUpdate({
				target: [queueFailures.queueName, queueFailures.messageId],
				set: {
					attempts: sql`GREATEST(${queueFailures.attempts}, excluded.attempts)`,
					error: sql`CASE
						WHEN ${queueFailures.payloadRedactedAt} IS NULL THEN excluded.error
						ELSE ${queueFailures.error}
					END`,
					payloadCiphertext: sql`CASE
						WHEN ${queueFailures.payloadRedactedAt} IS NULL
							THEN excluded.payload_ciphertext
						ELSE NULL
					END`,
					payloadKeyId: sql`CASE
						WHEN ${queueFailures.payloadRedactedAt} IS NULL
							THEN excluded.payload_key_id
						ELSE NULL
					END`,
					// Redelivery must never renew a privacy clock. Once a receipt is
					// redacted, the unique message identity cannot resurrect its body
					// or erased subject locators.
					payloadExpiresAt: sql`LEAST(${queueFailures.payloadExpiresAt}, excluded.payload_expires_at)`,
					payloadRedactedAt: sql`${queueFailures.payloadRedactedAt}`,
					organizationIds: sql`CASE
						WHEN ${queueFailures.payloadRedactedAt} IS NOT NULL
							THEN ${queueFailures.organizationIds}
						ELSE (
							SELECT COALESCE(array_agg(DISTINCT merged.value), ARRAY[]::text[])
							FROM unnest(${queueFailures.organizationIds} || excluded.organization_ids) AS merged(value)
						)
					END`,
					workspaceIds: sql`CASE
						WHEN ${queueFailures.payloadRedactedAt} IS NOT NULL
							THEN ${queueFailures.workspaceIds}
						ELSE (
							SELECT COALESCE(array_agg(DISTINCT merged.value), ARRAY[]::text[])
							FROM unnest(${queueFailures.workspaceIds} || excluded.workspace_ids) AS merged(value)
						)
					END`,
					userIds: sql`CASE
						WHEN ${queueFailures.payloadRedactedAt} IS NOT NULL
							THEN ${queueFailures.userIds}
						ELSE (
							SELECT COALESCE(array_agg(DISTINCT merged.value), ARRAY[]::text[])
							FROM unnest(${queueFailures.userIds} || excluded.user_ids) AS merged(value)
						)
					END`,
					contactIds: sql`CASE
						WHEN ${queueFailures.payloadRedactedAt} IS NOT NULL
							THEN ${queueFailures.contactIds}
						ELSE (
							SELECT COALESCE(array_agg(DISTINCT merged.value), ARRAY[]::text[])
							FROM unnest(${queueFailures.contactIds} || excluded.contact_ids) AS merged(value)
						)
					END`,
					accountIds: sql`CASE
						WHEN ${queueFailures.payloadRedactedAt} IS NOT NULL
							THEN ${queueFailures.accountIds}
						ELSE (
							SELECT COALESCE(array_agg(DISTINCT merged.value), ARRAY[]::text[])
							FROM unnest(${queueFailures.accountIds} || excluded.account_ids) AS merged(value)
						)
					END`,
				},
			});
	});
}

/** Persist the terminal decision before ACKing a business message. */
export async function recordQueueFailure<T>(
	env: Env,
	queueName: string,
	message: Message<T>,
	kind: QueueFailureKind,
	error: unknown,
): Promise<void> {
	await recordQueueFailureRecord(env, {
		queueName,
		messageId: message.id,
		attempts: message.attempts,
		payload: message.body,
		kind,
		error,
	});
}
