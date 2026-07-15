import {
	createDb,
	inboundWebhookEvents,
	organization,
	queueFailures,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../types";

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

function mediaOrganizationId(queueName: string, body: unknown): string | null {
	if (!queueName.includes("relayapi-media-cleanup")) return null;
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
	await db.transaction(async (tx) => {
		const scopedOrganizations = new Set([
			...(input.organizationIds ?? []),
			...organizationIds(input.payload),
		]);
		const mediaScope = mediaOrganizationId(input.queueName, input.payload);
		if (mediaScope) scopedOrganizations.add(mediaScope);
		if (
			scopedOrganizations.size === 0 &&
			input.queueName.includes("relayapi-refresh") &&
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
			input.queueName.includes("relayapi-inbox") &&
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

		await tx
			.insert(queueFailures)
			.values({
				queueName: input.queueName,
				messageId: input.messageId,
				organizationIds: activeOrganizationIds,
				operationId,
				failureKind: input.kind,
				attempts: input.attempts,
				payload: persistedPayload,
				error:
					input.error instanceof Error
						? input.error.message
						: String(input.error),
			})
			.onConflictDoUpdate({
				target: [queueFailures.queueName, queueFailures.messageId],
				set: {
					attempts: sql`GREATEST(${queueFailures.attempts}, excluded.attempts)`,
					error: sql`excluded.error`,
					payload: sql`excluded.payload`,
					organizationIds: sql`(
					SELECT COALESCE(array_agg(DISTINCT merged.value), ARRAY[]::text[])
					FROM unnest(${queueFailures.organizationIds} || excluded.organization_ids) AS merged(value)
					)`,
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
