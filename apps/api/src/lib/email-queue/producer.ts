import {
	createDb,
	type Database,
	emailDeliveries,
	organization,
	user,
} from "@relayapi/db";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Env } from "../../types";
import { encryptionKeyId, encryptToken } from "../crypto";
import { EMAIL_PROVIDER_MAX_ATTEMPTS } from "./policy";
import type { EmailDeliveryEnvelope, EmailQueueMessage } from "./types";

const DEFAULT_FROM = "RelayAPI <notifications@relayapi.dev>";
const EMAIL_DISPATCH_LEASE_MS = 60_000;
const EMAIL_REDELIVERY_GUARD_MS = 5 * 60_000;

export interface SendEmailOptions {
	/** Owning tenant for durable failure-ledger cleanup. */
	organizationId: string;
	/** Optional direct identity locator for erasure before the tenant is removed. */
	subjectUserId?: string;
	to: string;
	subject: string;
	html: string;
	from?: string;
	/** Stable for one logical email occurrence. */
	idempotencyKey: string;
}

export interface SendAuthUserEmailOptions {
	/** Identity owner. Deleting this auth user cascades the staged delivery. */
	authUserId: string;
	/** Optional audit subject. This remains SET NULL on user deletion. */
	subjectUserId?: string;
	to: string;
	subject: string;
	html: string;
	from?: string;
	/** Stable for one logical email occurrence. */
	idempotencyKey: string;
}

type EmailOwner =
	| { intent: "organization"; organizationId: string; authUserId: null }
	| { intent: "auth_user"; organizationId: null; authUserId: string };

export async function emailDeliveryIdForIdempotencyKey(
	key: string,
): Promise<string> {
	if (key.length === 0 || key.length > 4_096) {
		throw new TypeError("Email idempotency key is invalid");
	}
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`relayapi:email-delivery:v1\u0000${key}`),
	);
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `eml_${hex}`;
}

/**
 * Fenced PostgreSQL-outbox handoff. A Worker crash after Queue accepts the
 * message but before `queued_at` commits can only produce a duplicate
 * identifier; the provider claim in `email_deliveries` is independently fenced.
 */
export async function dispatchEmailDelivery(
	env: Env,
	id: string,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
): Promise<"dispatched" | "not_due"> {
	const now = new Date();
	await db
		.update(emailDeliveries)
		.set({
			status: "manual_review",
			dispatchLeaseExpiresAt: null,
			leaseExpiresAt: null,
			error: "Email delivery exhausted its provider-attempt budget or deadline",
			completedAt: now,
		})
		.where(
			and(
				eq(emailDeliveries.id, id),
				inArray(emailDeliveries.status, ["pending", "unknown"]),
				or(
					lte(emailDeliveries.deadlineAt, now),
					sql`${emailDeliveries.providerAttempts} >= ${EMAIL_PROVIDER_MAX_ATTEMPTS}`,
				),
			),
		);
	const [claim] = await db
		.update(emailDeliveries)
		.set({
			dispatchAttempts: sql`${emailDeliveries.dispatchAttempts} + 1`,
			dispatchLeaseToken: sql`${emailDeliveries.dispatchLeaseToken} + 1`,
			dispatchLeaseExpiresAt: new Date(now.getTime() + EMAIL_DISPATCH_LEASE_MS),
		})
		.where(
			and(
				eq(emailDeliveries.id, id),
				inArray(emailDeliveries.status, ["pending", "unknown"]),
				sql`${emailDeliveries.providerAttempts} < ${EMAIL_PROVIDER_MAX_ATTEMPTS}`,
				sql`${emailDeliveries.deadlineAt} > ${now}`,
				lte(emailDeliveries.nextDispatchAt, now),
				or(
					isNull(emailDeliveries.dispatchLeaseExpiresAt),
					lte(emailDeliveries.dispatchLeaseExpiresAt, now),
				),
				or(
					eq(emailDeliveries.status, "pending"),
					and(
						eq(emailDeliveries.status, "unknown"),
						lte(emailDeliveries.nextAttemptAt, now),
					),
				),
			),
		)
		.returning({
			leaseToken: emailDeliveries.dispatchLeaseToken,
			attempts: emailDeliveries.dispatchAttempts,
		});
	if (!claim) return "not_due";

	try {
		const message: EmailQueueMessage = { id };
		await env.EMAIL_QUEUE.send(message);
		await db
			.update(emailDeliveries)
			.set({
				queuedAt: new Date(),
				dispatchLeaseExpiresAt: null,
				nextDispatchAt: new Date(Date.now() + EMAIL_REDELIVERY_GUARD_MS),
			})
			.where(
				and(
					eq(emailDeliveries.id, id),
					eq(emailDeliveries.dispatchLeaseToken, claim.leaseToken),
				),
			);
		console.log(`[EmailQueue] Enqueued email ${message.id}`);
		return "dispatched";
	} catch (error) {
		await db
			.update(emailDeliveries)
			.set({
				dispatchLeaseExpiresAt: null,
				nextDispatchAt: new Date(
					Date.now() +
						Math.min(3600, 2 ** Math.min(claim.attempts, 10)) * 1_000,
				),
			})
			.where(
				and(
					eq(emailDeliveries.id, id),
					eq(emailDeliveries.dispatchLeaseToken, claim.leaseToken),
				),
			);
		throw error;
	}
}

async function stageEmailDelivery(
	env: Env,
	owner: EmailOwner,
	options: Omit<SendEmailOptions, "organizationId">,
): Promise<string> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const deliveryId = await emailDeliveryIdForIdempotencyKey(
		options.idempotencyKey,
	);
	const envelope: EmailDeliveryEnvelope = {
		to: options.to,
		subject: options.subject,
		html: options.html,
		from: options.from || DEFAULT_FROM,
	};
	const envelopeCiphertext = await encryptToken(
		JSON.stringify(envelope),
		env.ENCRYPTION_KEY,
		{ recordId: deliveryId, field: "email_delivery_envelope" },
	);
	const envelopeKeyId = encryptionKeyId(envelopeCiphertext);
	if (!envelopeKeyId) throw new Error("Email envelope key ID is missing");

	const staged = await db.transaction(async (tx) => {
		if (owner.intent === "organization") {
			const [activeOrganization] = await tx
				.select({ id: organization.id })
				.from(organization)
				.where(
					and(
						eq(organization.id, owner.organizationId),
						eq(organization.lifecycleStatus, "active"),
					),
				)
				.for("key share")
				.limit(1);
			if (!activeOrganization) return false;
		} else {
			const [activeUser] = await tx
				.select({ id: user.id })
				.from(user)
				.where(eq(user.id, owner.authUserId))
				.for("key share")
				.limit(1);
			if (!activeUser) return false;
		}

		await tx
			.insert(emailDeliveries)
			.values({
				id: deliveryId,
				intent: owner.intent,
				organizationId: owner.organizationId,
				authUserId: owner.authUserId,
				subjectUserId: options.subjectUserId ?? null,
				envelopeCiphertext,
				envelopeKeyId,
			})
			.onConflictDoNothing();
		const [delivery] = await tx
			.select({
				intent: emailDeliveries.intent,
				organizationId: emailDeliveries.organizationId,
				authUserId: emailDeliveries.authUserId,
				status: emailDeliveries.status,
			})
			.from(emailDeliveries)
			.where(eq(emailDeliveries.id, deliveryId))
			.limit(1);
		if (
			!delivery ||
			delivery.intent !== owner.intent ||
			delivery.organizationId !== owner.organizationId ||
			delivery.authUserId !== owner.authUserId
		) {
			throw new Error("Email idempotency key belongs to another owner");
		}
		return delivery.status === "pending";
	});
	if (staged) await dispatchEmailDelivery(env, deliveryId, db);
	return deliveryId;
}

/**
 * Stage an organization-owned email. Only the encrypted PostgreSQL ledger stores
 * the rendered envelope; Queue receives the opaque ledger identifier.
 */
export async function enqueueEmail(
	env: Env,
	options: SendEmailOptions,
): Promise<string> {
	const { organizationId, ...envelope } = options;
	return stageEmailDelivery(
		env,
		{ intent: "organization", organizationId, authUserId: null },
		envelope,
	);
}

/** Stage an identity-owned account email. */
export async function enqueueAuthUserEmail(
	env: Env,
	options: SendAuthUserEmailOptions,
): Promise<string> {
	const { authUserId, ...envelope } = options;
	return stageEmailDelivery(
		env,
		{ intent: "auth_user", organizationId: null, authUserId },
		envelope,
	);
}

/**
 * Compatibility name for API-owned organization email producers.
 */
export async function sendEmail(
	env: Env,
	options: SendEmailOptions,
): Promise<void> {
	await enqueueEmail(env, options);
}
