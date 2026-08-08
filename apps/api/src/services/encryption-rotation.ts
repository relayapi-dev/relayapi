import {
	accountRevocationJobs,
	automationEntrypoints,
	automationSecrets,
	automationWebhookReceipts,
	contactChannels,
	contacts,
	createDb,
	emailDeliveries,
	externalSubjectCleanupJobs,
	idempotencyReceipts,
	inboundWebhookEvents,
	operatorResolutionNotes,
	queueFailures,
	shortLinkCredentials,
	socialAccounts,
	storageCredentials,
	webhookEndpoints,
	whatsappPhoneReleaseOperations,
} from "@relayapi/db";
import {
	and,
	eq,
	isNotNull,
	isNull,
	or,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import {
	accountTokenNeedsReencryption,
	reencryptAccountToken,
} from "../lib/account-token-crypto";
import {
	activeEncryptionKeyId,
	decryptToken,
	encryptToken,
	needsReencryption,
} from "../lib/crypto";
import type { Env } from "../types";
import {
	getMetaAdsUserAccessToken,
	replaceMetaAdsUserAccessTokenCiphertext,
} from "./ad-access-token";
import { rotateContactConsentAuthority } from "./contact-consent";

const BATCH_SIZE = 50;

function doesNotStartWith(value: SQLWrapper, prefix: string) {
	return sql`left(${value}, char_length(${prefix})) <> ${prefix}`;
}

async function rotateScalar(
	stored: string | null,
	keyConfig: string,
	context?: { recordId: string; field: string },
	knownSecret = false,
): Promise<string | null> {
	if (
		!stored ||
		(!knownSecret && !stored.startsWith("enc:")) ||
		(stored.startsWith("enc:") && !needsReencryption(stored, keyConfig))
	) {
		return null;
	}
	const plaintext = await decryptToken(stored, keyConfig, context);
	return encryptToken(plaintext, keyConfig, context);
}

/**
 * Resumable online key rotation. Every write compares the complete old
 * ciphertext/document, so reconnect/refresh/config edits win races and are never
 * overwritten by a stale rotation batch.
 */
export async function rotateEncryptedValues(env: Env): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const keyConfig = env.ENCRYPTION_KEY;
	const activeId = activeEncryptionKeyId(keyConfig);
	const activePrefix = `enc:v2:${activeId}:`;
	const activeAccountPrefix = `acct:v1:enc:v2:${activeId}:`;
	let changed = 0;

	const accounts = await db
		.select({
			id: socialAccounts.id,
			accessToken: socialAccounts.accessToken,
			refreshToken: socialAccounts.refreshToken,
			metadata: socialAccounts.metadata,
		})
		.from(socialAccounts)
		.where(
			or(
				and(
					isNotNull(socialAccounts.accessToken),
					doesNotStartWith(socialAccounts.accessToken, activeAccountPrefix),
				),
				and(
					isNotNull(socialAccounts.refreshToken),
					doesNotStartWith(socialAccounts.refreshToken, activeAccountPrefix),
				),
				and(
					sql`${socialAccounts.metadata}->>'meta_ads_user_access_token' IS NOT NULL`,
					doesNotStartWith(
						sql`${socialAccounts.metadata}->>'meta_ads_user_access_token'`,
						activeAccountPrefix,
					),
				),
			),
		)
		.orderBy(socialAccounts.id)
		.limit(BATCH_SIZE);
	for (const row of accounts) {
		for (const [field, column, oldValue] of [
			["access_token", socialAccounts.accessToken, row.accessToken],
			["refresh_token", socialAccounts.refreshToken, row.refreshToken],
		] as const) {
			const rotated = accountTokenNeedsReencryption(oldValue, keyConfig)
				? await reencryptAccountToken(oldValue, keyConfig, row.id, field)
				: null;
			if (!rotated || !oldValue) continue;
			const result = await db
				.update(socialAccounts)
				.set(
					field === "access_token"
						? { accessToken: rotated }
						: { refreshToken: rotated },
				)
				.where(and(eq(socialAccounts.id, row.id), eq(column, oldValue)))
				.returning({ id: socialAccounts.id });
			changed += result.length;
		}

		const oldMetadataToken = getMetaAdsUserAccessToken(row.metadata);
		const rotatedMetadataToken = accountTokenNeedsReencryption(
			oldMetadataToken,
			keyConfig,
		)
			? await reencryptAccountToken(
					oldMetadataToken,
					keyConfig,
					row.id,
					"meta_ads_user_access_token",
				)
			: null;
		if (oldMetadataToken && rotatedMetadataToken) {
			const metadata = replaceMetaAdsUserAccessTokenCiphertext(
				row.metadata,
				rotatedMetadataToken,
			);
			const result = await db
				.update(socialAccounts)
				.set({ metadata })
				.where(
					and(
						eq(socialAccounts.id, row.id),
						sql`${socialAccounts.metadata} IS NOT DISTINCT FROM ${row.metadata}`,
					),
				)
				.returning({ id: socialAccounts.id });
			changed += result.length;
		}
	}

	const revocations = await db
		.select({
			id: accountRevocationJobs.id,
			accountId: accountRevocationJobs.accountId,
			accessToken: accountRevocationJobs.accessTokenCiphertext,
			refreshToken: accountRevocationJobs.refreshTokenCiphertext,
		})
		.from(accountRevocationJobs)
		.where(
			or(
				and(
					isNotNull(accountRevocationJobs.accessTokenCiphertext),
					doesNotStartWith(
						accountRevocationJobs.accessTokenCiphertext,
						activeAccountPrefix,
					),
				),
				and(
					isNotNull(accountRevocationJobs.refreshTokenCiphertext),
					doesNotStartWith(
						accountRevocationJobs.refreshTokenCiphertext,
						activeAccountPrefix,
					),
				),
			),
		)
		.orderBy(accountRevocationJobs.id)
		.limit(BATCH_SIZE);
	for (const row of revocations) {
		for (const [field, column, oldValue] of [
			[
				"access_token",
				accountRevocationJobs.accessTokenCiphertext,
				row.accessToken,
			],
			[
				"refresh_token",
				accountRevocationJobs.refreshTokenCiphertext,
				row.refreshToken,
			],
		] as const) {
			const rotated = accountTokenNeedsReencryption(oldValue, keyConfig)
				? await reencryptAccountToken(oldValue, keyConfig, row.accountId, field)
				: null;
			if (!rotated || !oldValue) continue;
			const result = await db
				.update(accountRevocationJobs)
				.set(
					field === "access_token"
						? { accessTokenCiphertext: rotated }
						: { refreshTokenCiphertext: rotated },
				)
				.where(and(eq(accountRevocationJobs.id, row.id), eq(column, oldValue)))
				.returning({ id: accountRevocationJobs.id });
			changed += result.length;
		}
	}

	const phoneReleaseGrants = await db
		.select({
			id: whatsappPhoneReleaseOperations.releaseOperationId,
			sourceAccountId: whatsappPhoneReleaseOperations.releaseSourceAccountId,
			ciphertext: whatsappPhoneReleaseOperations.releaseAccessTokenCiphertext,
		})
		.from(whatsappPhoneReleaseOperations)
		.where(
			and(
				isNotNull(whatsappPhoneReleaseOperations.releaseSourceAccountId),
				isNotNull(whatsappPhoneReleaseOperations.releaseAccessTokenCiphertext),
				doesNotStartWith(
					whatsappPhoneReleaseOperations.releaseAccessTokenCiphertext,
					activeAccountPrefix,
				),
			),
		)
		.orderBy(whatsappPhoneReleaseOperations.releaseOperationId)
		.limit(BATCH_SIZE);
	for (const row of phoneReleaseGrants) {
		if (!row.sourceAccountId || !row.ciphertext) continue;
		const rotated = accountTokenNeedsReencryption(row.ciphertext, keyConfig)
			? await reencryptAccountToken(
					row.ciphertext,
					keyConfig,
					row.sourceAccountId,
					"access_token",
				)
			: null;
		if (!rotated) continue;
		const result = await db
			.update(whatsappPhoneReleaseOperations)
			.set({ releaseAccessTokenCiphertext: rotated })
			.where(
				and(
					eq(whatsappPhoneReleaseOperations.releaseOperationId, row.id),
					eq(
						whatsappPhoneReleaseOperations.releaseAccessTokenCiphertext,
						row.ciphertext,
					),
					eq(
						whatsappPhoneReleaseOperations.releaseSourceAccountId,
						row.sourceAccountId,
					),
				),
			)
			.returning({ id: whatsappPhoneReleaseOperations.releaseOperationId });
		changed += result.length;
	}

	const endpoints = await db
		.select({
			id: webhookEndpoints.id,
			ciphertext: webhookEndpoints.secretCiphertext,
		})
		.from(webhookEndpoints)
		.where(doesNotStartWith(webhookEndpoints.secretCiphertext, activePrefix))
		.orderBy(webhookEndpoints.id)
		.limit(BATCH_SIZE);
	for (const row of endpoints) {
		const context = { recordId: row.id, field: "secret_ciphertext" };
		const rotated = await rotateScalar(
			row.ciphertext,
			keyConfig,
			context,
			true,
		);
		if (!rotated) continue;
		const result = await db
			.update(webhookEndpoints)
			.set({ secretCiphertext: rotated, secretKeyId: activeId })
			.where(
				and(
					eq(webhookEndpoints.id, row.id),
					eq(webhookEndpoints.secretCiphertext, row.ciphertext),
				),
			)
			.returning({ id: webhookEndpoints.id });
		changed += result.length;
	}

	const emailDeliveryRows = await db
		.select({
			id: emailDeliveries.id,
			ciphertext: emailDeliveries.envelopeCiphertext,
		})
		.from(emailDeliveries)
		.where(
			and(
				isNotNull(emailDeliveries.envelopeCiphertext),
				isNull(emailDeliveries.redactedAt),
				doesNotStartWith(emailDeliveries.envelopeCiphertext, activePrefix),
			),
		)
		.orderBy(emailDeliveries.id)
		.limit(BATCH_SIZE);
	for (const row of emailDeliveryRows) {
		if (!row.ciphertext) continue;
		const rotated = await rotateScalar(
			row.ciphertext,
			keyConfig,
			{ recordId: row.id, field: "email_delivery_envelope" },
			true,
		);
		if (!rotated) continue;
		const result = await db
			.update(emailDeliveries)
			.set({ envelopeCiphertext: rotated, envelopeKeyId: activeId })
			.where(
				and(
					eq(emailDeliveries.id, row.id),
					eq(emailDeliveries.envelopeCiphertext, row.ciphertext),
					isNull(emailDeliveries.redactedAt),
				),
			)
			.returning({ id: emailDeliveries.id });
		changed += result.length;
	}

	const queueFailureRows = await db
		.select({
			id: queueFailures.id,
			queueName: queueFailures.queueName,
			messageId: queueFailures.messageId,
			ciphertext: queueFailures.payloadCiphertext,
		})
		.from(queueFailures)
		.where(
			and(
				isNotNull(queueFailures.payloadCiphertext),
				isNull(queueFailures.payloadRedactedAt),
				doesNotStartWith(queueFailures.payloadCiphertext, activePrefix),
			),
		)
		.orderBy(queueFailures.id)
		.limit(BATCH_SIZE);
	for (const row of queueFailureRows) {
		if (!row.ciphertext) continue;
		const rotated = await rotateScalar(
			row.ciphertext,
			keyConfig,
			{
				recordId: `${row.queueName}:${row.messageId}`,
				field: "queue_failure_payload",
			},
			true,
		);
		if (!rotated) continue;
		const result = await db
			.update(queueFailures)
			.set({ payloadCiphertext: rotated, payloadKeyId: activeId })
			.where(
				and(
					eq(queueFailures.id, row.id),
					eq(queueFailures.payloadCiphertext, row.ciphertext),
					isNull(queueFailures.payloadRedactedAt),
				),
			)
			.returning({ id: queueFailures.id });
		changed += result.length;
	}

	const byosRows = await db
		.select()
		.from(storageCredentials)
		.where(
			or(
				doesNotStartWith(storageCredentials.accessKeyId, activePrefix),
				doesNotStartWith(storageCredentials.secretAccessKey, activePrefix),
			),
		)
		.orderBy(storageCredentials.id)
		.limit(BATCH_SIZE);
	for (const row of byosRows) {
		const nextAccess = await rotateScalar(
			row.accessKeyId,
			keyConfig,
			undefined,
			true,
		);
		const nextSecret = await rotateScalar(
			row.secretAccessKey,
			keyConfig,
			undefined,
			true,
		);
		if (!nextAccess && !nextSecret) continue;
		const result = await db
			.update(storageCredentials)
			.set({
				accessKeyId: nextAccess ?? row.accessKeyId,
				secretAccessKey: nextSecret ?? row.secretAccessKey,
			})
			.where(
				and(
					eq(storageCredentials.id, row.id),
					eq(storageCredentials.accessKeyId, row.accessKeyId),
					eq(storageCredentials.secretAccessKey, row.secretAccessKey),
				),
			)
			.returning({ id: storageCredentials.id });
		changed += result.length;
	}

	const shortLinkCredentialRows = await db
		.select()
		.from(shortLinkCredentials)
		.where(
			doesNotStartWith(shortLinkCredentials.apiKeyCiphertext, activePrefix),
		)
		.orderBy(shortLinkCredentials.id)
		.limit(BATCH_SIZE);
	for (const row of shortLinkCredentialRows) {
		const rotated = await rotateScalar(
			row.apiKeyCiphertext,
			keyConfig,
			undefined,
			true,
		);
		if (!rotated) continue;
		const result = await db
			.update(shortLinkCredentials)
			.set({ apiKeyCiphertext: rotated })
			.where(
				and(
					eq(shortLinkCredentials.id, row.id),
					eq(shortLinkCredentials.apiKeyCiphertext, row.apiKeyCiphertext),
				),
			)
			.returning({ id: shortLinkCredentials.id });
		changed += result.length;
	}

	const shortLinkCleanupRows = await db
		.select({
			id: externalSubjectCleanupJobs.id,
			ciphertext: externalSubjectCleanupJobs.credentialCiphertext,
		})
		.from(externalSubjectCleanupJobs)
		.where(
			and(
				isNotNull(externalSubjectCleanupJobs.credentialCiphertext),
				doesNotStartWith(
					externalSubjectCleanupJobs.credentialCiphertext,
					activePrefix,
				),
			),
		)
		.orderBy(externalSubjectCleanupJobs.id)
		.limit(BATCH_SIZE);
	for (const row of shortLinkCleanupRows) {
		const rotated = await rotateScalar(
			row.ciphertext,
			keyConfig,
			undefined,
			true,
		);
		if (!rotated || !row.ciphertext) continue;
		const result = await db
			.update(externalSubjectCleanupJobs)
			.set({ credentialCiphertext: rotated })
			.where(
				and(
					eq(externalSubjectCleanupJobs.id, row.id),
					eq(externalSubjectCleanupJobs.credentialCiphertext, row.ciphertext),
				),
			)
			.returning({ id: externalSubjectCleanupJobs.id });
		changed += result.length;
	}

	const operatorNoteRows = await db
		.select()
		.from(operatorResolutionNotes)
		.where(
			doesNotStartWith(operatorResolutionNotes.noteCiphertext, activePrefix),
		)
		.orderBy(operatorResolutionNotes.evidenceId)
		.limit(BATCH_SIZE);
	for (const row of operatorNoteRows) {
		const rotated = await rotateScalar(
			row.noteCiphertext,
			keyConfig,
			{ recordId: row.evidenceId, field: "note_ciphertext" },
			true,
		);
		if (!rotated) continue;
		const result = await db
			.update(operatorResolutionNotes)
			.set({ noteCiphertext: rotated })
			.where(
				and(
					eq(operatorResolutionNotes.evidenceId, row.evidenceId),
					eq(operatorResolutionNotes.noteCiphertext, row.noteCiphertext),
				),
			)
			.returning({ evidenceId: operatorResolutionNotes.evidenceId });
		changed += result.length;
	}

	const entrypoints = await db
		.select()
		.from(automationEntrypoints)
		.where(
			and(
				sql`${automationEntrypoints.config}->>'webhook_secret' IS NOT NULL`,
				doesNotStartWith(
					sql`${automationEntrypoints.config}->>'webhook_secret'`,
					activePrefix,
				),
			),
		)
		.orderBy(automationEntrypoints.id)
		.limit(BATCH_SIZE);
	for (const row of entrypoints) {
		const config = row.config as Record<string, unknown>;
		const stored = config.webhook_secret;
		if (typeof stored !== "string") continue;
		const rotated = await rotateScalar(
			stored,
			keyConfig,
			{ recordId: row.id, field: "webhook_secret" },
			true,
		);
		if (!rotated) continue;
		const nextConfig = { ...config, webhook_secret: rotated };
		const result = await db
			.update(automationEntrypoints)
			.set({ config: nextConfig })
			.where(
				and(
					eq(automationEntrypoints.id, row.id),
					eq(automationEntrypoints.config, row.config),
				),
			)
			.returning({ id: automationEntrypoints.id });
		changed += result.length;
	}

	const automationSecretRows = await db
		.select({
			id: automationSecrets.id,
			ciphertext: automationSecrets.ciphertext,
		})
		.from(automationSecrets)
		.where(doesNotStartWith(automationSecrets.ciphertext, activePrefix))
		.orderBy(automationSecrets.id)
		.limit(BATCH_SIZE);
	for (const row of automationSecretRows) {
		const rotated = await rotateScalar(
			row.ciphertext,
			keyConfig,
			{ recordId: row.id, field: "credentials" },
			true,
		);
		if (!rotated) continue;
		const result = await db
			.update(automationSecrets)
			.set({
				ciphertext: rotated,
				keyId: activeId,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(automationSecrets.id, row.id),
					eq(automationSecrets.ciphertext, row.ciphertext),
				),
			)
			.returning({ id: automationSecrets.id });
		changed += result.length;
	}
	const receipts = await db
		.select({
			id: idempotencyReceipts.id,
			ciphertext: idempotencyReceipts.responseBodyCiphertext,
		})
		.from(idempotencyReceipts)
		.where(
			and(
				isNotNull(idempotencyReceipts.responseBodyCiphertext),
				doesNotStartWith(
					idempotencyReceipts.responseBodyCiphertext,
					activePrefix,
				),
			),
		)
		.orderBy(idempotencyReceipts.id)
		.limit(BATCH_SIZE);
	for (const row of receipts) {
		if (!row.ciphertext) continue;
		const rotated = await rotateScalar(
			row.ciphertext,
			keyConfig,
			{ recordId: row.id, field: "response_body" },
			true,
		);
		if (!rotated) continue;
		const result = await db
			.update(idempotencyReceipts)
			.set({ responseBodyCiphertext: rotated })
			.where(
				and(
					eq(idempotencyReceipts.id, row.id),
					eq(idempotencyReceipts.responseBodyCiphertext, row.ciphertext),
				),
			)
			.returning({ id: idempotencyReceipts.id });
		changed += result.length;
	}

	const webhookReceipts = await db
		.select({
			id: automationWebhookReceipts.id,
			ciphertext: automationWebhookReceipts.payloadCiphertext,
		})
		.from(automationWebhookReceipts)
		.where(
			doesNotStartWith(
				automationWebhookReceipts.payloadCiphertext,
				activePrefix,
			),
		)
		.orderBy(automationWebhookReceipts.id)
		.limit(BATCH_SIZE);
	for (const row of webhookReceipts) {
		const rotated = await rotateScalar(
			row.ciphertext,
			keyConfig,
			{ recordId: row.id, field: "payload" },
			true,
		);
		if (!rotated) continue;
		const result = await db
			.update(automationWebhookReceipts)
			.set({ payloadCiphertext: rotated })
			.where(
				and(
					eq(automationWebhookReceipts.id, row.id),
					eq(automationWebhookReceipts.payloadCiphertext, row.ciphertext),
				),
			)
			.returning({ id: automationWebhookReceipts.id });
		changed += result.length;
	}

	const inboundReceipts = await db
		.select({
			id: inboundWebhookEvents.id,
			ciphertext: inboundWebhookEvents.payloadCiphertext,
		})
		.from(inboundWebhookEvents)
		.where(
			and(
				isNull(inboundWebhookEvents.redactedAt),
				doesNotStartWith(inboundWebhookEvents.payloadCiphertext, activePrefix),
			),
		)
		.orderBy(inboundWebhookEvents.id)
		.limit(BATCH_SIZE);
	for (const row of inboundReceipts) {
		const rotated = await rotateScalar(
			row.ciphertext,
			keyConfig,
			{ recordId: row.id, field: "payload_ciphertext" },
			true,
		);
		if (!rotated) continue;
		const result = await db
			.update(inboundWebhookEvents)
			.set({ payloadCiphertext: rotated, payloadKeyId: activeId })
			.where(
				and(
					eq(inboundWebhookEvents.id, row.id),
					eq(inboundWebhookEvents.payloadCiphertext, row.ciphertext),
					isNull(inboundWebhookEvents.redactedAt),
				),
			)
			.returning({ id: inboundWebhookEvents.id });
		changed += result.length;
	}

	const contactRows = await db
		.select({
			id: contacts.id,
			nameCiphertext: contacts.nameCiphertext,
			emailCiphertext: contacts.emailCiphertext,
			phoneCiphertext: contacts.phoneCiphertext,
			metadataCiphertext: contacts.metadataCiphertext,
		})
		.from(contacts)
		.where(
			or(
				and(
					isNotNull(contacts.nameCiphertext),
					doesNotStartWith(contacts.nameCiphertext, activePrefix),
				),
				and(
					isNotNull(contacts.emailCiphertext),
					doesNotStartWith(contacts.emailCiphertext, activePrefix),
				),
				and(
					isNotNull(contacts.phoneCiphertext),
					doesNotStartWith(contacts.phoneCiphertext, activePrefix),
				),
				and(
					isNotNull(contacts.metadataCiphertext),
					doesNotStartWith(contacts.metadataCiphertext, activePrefix),
				),
			),
		)
		.orderBy(contacts.id)
		.limit(BATCH_SIZE);
	for (const row of contactRows) {
		for (const [field, column, oldValue] of [
			["contact_name", contacts.nameCiphertext, row.nameCiphertext],
			["contact_email", contacts.emailCiphertext, row.emailCiphertext],
			["contact_phone", contacts.phoneCiphertext, row.phoneCiphertext],
			["contact_metadata", contacts.metadataCiphertext, row.metadataCiphertext],
		] as const) {
			if (!oldValue) continue;
			const rotated = await rotateScalar(
				oldValue,
				keyConfig,
				{ recordId: row.id, field },
				true,
			);
			if (!rotated) continue;
			const result = await db
				.update(contacts)
				.set(
					field === "contact_name"
						? { nameCiphertext: rotated }
						: field === "contact_email"
							? { emailCiphertext: rotated }
							: field === "contact_phone"
								? { phoneCiphertext: rotated }
								: { metadataCiphertext: rotated },
				)
				.where(and(eq(contacts.id, row.id), eq(column, oldValue)))
				.returning({ id: contacts.id });
			changed += result.length;
		}
	}

	const contactChannelRows = await db
		.select({
			id: contactChannels.id,
			identifierCiphertext: contactChannels.identifierCiphertext,
		})
		.from(contactChannels)
		.where(doesNotStartWith(contactChannels.identifierCiphertext, activePrefix))
		.orderBy(contactChannels.id)
		.limit(BATCH_SIZE);
	for (const row of contactChannelRows) {
		const rotated = await rotateScalar(
			row.identifierCiphertext,
			keyConfig,
			{ recordId: row.id, field: "contact_channel_identifier" },
			true,
		);
		if (!rotated) continue;
		const result = await db
			.update(contactChannels)
			.set({ identifierCiphertext: rotated })
			.where(
				and(
					eq(contactChannels.id, row.id),
					eq(contactChannels.identifierCiphertext, row.identifierCiphertext),
				),
			)
			.returning({ id: contactChannels.id });
		changed += result.length;
	}

	const consentAuthority = await rotateContactConsentAuthority(
		db,
		keyConfig,
		BATCH_SIZE,
	);
	changed += consentAuthority.rewritten;

	if (changed > 0 || consentAuthority.remaining > 0) {
		console.log("[encryption-rotation] rotated ciphertext batch", {
			activeId,
			changed,
			consentAuthority: {
				activeVersion: consentAuthority.activeVersion,
				rewritten: consentAuthority.rewritten,
				remaining: consentAuthority.remaining,
			},
		});
	}
	return changed;
}
