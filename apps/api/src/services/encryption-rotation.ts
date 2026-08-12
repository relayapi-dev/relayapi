import {
	accountRevocationJobs,
	adConnections,
	adConversionEvents,
	adLeads,
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
	mediaUploadSessions,
	operatorResolutionNotes,
	queueFailures,
	shortLinkCredentials,
	socialAccounts,
	socialMutationOperations,
	storageCredentials,
	webhookEndpoints,
	whatsappGroups,
	whatsappIdentityAliases,
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
	adConnectionTokenNeedsReencryption,
	reencryptAdConnectionToken,
} from "../lib/ad-connection-token-crypto";
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

export async function rotateSocialProjectionRequestPayload(
	keyConfig: string,
	row: Pick<
		typeof socialMutationOperations.$inferSelect,
		"organizationId" | "targetType" | "targetId" | "kind" | "requestPayload"
	>,
): Promise<Record<string, unknown> | null> {
	const stored = row.requestPayload.projection_payload_ciphertext;
	if (typeof stored !== "string") return null;
	const rotated = await rotateScalar(
		stored,
		keyConfig,
		{
			recordId: [
				row.organizationId,
				row.targetType,
				row.targetId,
				row.kind,
			].join(":"),
			field: "social_mutation_projection_payload",
		},
		true,
	);
	return rotated
		? { ...row.requestPayload, projection_payload_ciphertext: rotated }
		: null;
}

export async function rotateWhatsAppGroupInviteLink(
	keyConfig: string,
	row: Pick<typeof whatsappGroups.$inferSelect, "id" | "inviteLinkCiphertext">,
): Promise<string | null> {
	return rotateScalar(
		row.inviteLinkCiphertext,
		keyConfig,
		{ recordId: row.id, field: "whatsapp_group_invite_link" },
		true,
	);
}

export async function rotateWhatsAppIdentityAliasValues(
	keyConfig: string,
	row: Pick<
		typeof whatsappIdentityAliases.$inferSelect,
		| "id"
		| "bsuidCiphertext"
		| "parentBsuidCiphertext"
		| "waIdCiphertext"
		| "usernameCiphertext"
	>,
): Promise<{
	bsuidCiphertext: string;
	parentBsuidCiphertext: string | null;
	waIdCiphertext: string | null;
	usernameCiphertext: string | null;
} | null> {
	const [bsuid, parentBsuid, waId, username] = await Promise.all([
		rotateScalar(
			row.bsuidCiphertext,
			keyConfig,
			{ recordId: row.id, field: "whatsapp_identity_bsuid" },
			true,
		),
		rotateScalar(
			row.parentBsuidCiphertext,
			keyConfig,
			{ recordId: row.id, field: "whatsapp_identity_parent_bsuid" },
			true,
		),
		rotateScalar(
			row.waIdCiphertext,
			keyConfig,
			{ recordId: row.id, field: "whatsapp_identity_wa_id" },
			true,
		),
		rotateScalar(
			row.usernameCiphertext,
			keyConfig,
			{ recordId: row.id, field: "whatsapp_identity_username" },
			true,
		),
	]);
	if (!bsuid && !parentBsuid && !waId && !username) return null;
	return {
		bsuidCiphertext: bsuid ?? row.bsuidCiphertext,
		parentBsuidCiphertext: parentBsuid ?? row.parentBsuidCiphertext,
		waIdCiphertext: waId ?? row.waIdCiphertext,
		usernameCiphertext: username ?? row.usernameCiphertext,
	};
}

export async function rotateAdvancedAdLeadPayload(
	keyConfig: string,
	row: Pick<typeof adLeads.$inferSelect, "id" | "payloadCiphertext">,
): Promise<string | null> {
	return rotateScalar(
		row.payloadCiphertext,
		keyConfig,
		{ recordId: row.id, field: "ad_lead_payload" },
		true,
	);
}

export async function rotateAdConversionPayload(
	keyConfig: string,
	row: Pick<typeof adConversionEvents.$inferSelect, "id" | "payloadCiphertext">,
): Promise<string | null> {
	return rotateScalar(
		row.payloadCiphertext,
		keyConfig,
		{ recordId: row.id, field: "ad_conversion_payload" },
		true,
	);
}

export async function rotateMediaUploadAuthority(
	keyConfig: string,
	row: Pick<
		typeof mediaUploadSessions.$inferSelect,
		"id" | "multipartUploadIdCiphertext"
	>,
): Promise<string | null> {
	return rotateScalar(
		row.multipartUploadIdCiphertext,
		keyConfig,
		{ recordId: row.id, field: "multipart_upload_id" },
		true,
	);
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
	const activeAdConnectionPrefix = `adconn:v1:enc:v2:${activeId}:`;
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

	const adConnectionRows = await db
		.select({
			id: adConnections.id,
			accessToken: adConnections.accessToken,
			refreshToken: adConnections.refreshToken,
			tokenSecret: adConnections.tokenSecret,
		})
		.from(adConnections)
		.where(
			or(
				and(
					isNotNull(adConnections.accessToken),
					doesNotStartWith(adConnections.accessToken, activeAdConnectionPrefix),
				),
				and(
					isNotNull(adConnections.refreshToken),
					doesNotStartWith(
						adConnections.refreshToken,
						activeAdConnectionPrefix,
					),
				),
				and(
					isNotNull(adConnections.tokenSecret),
					doesNotStartWith(adConnections.tokenSecret, activeAdConnectionPrefix),
				),
			),
		)
		.orderBy(adConnections.id)
		.limit(BATCH_SIZE);
	for (const row of adConnectionRows) {
		for (const [field, column, oldValue] of [
			["access_token", adConnections.accessToken, row.accessToken],
			["refresh_token", adConnections.refreshToken, row.refreshToken],
			["token_secret", adConnections.tokenSecret, row.tokenSecret],
		] as const) {
			const rotated = adConnectionTokenNeedsReencryption(oldValue, keyConfig)
				? await reencryptAdConnectionToken(oldValue, keyConfig, row.id, field)
				: null;
			if (!rotated || !oldValue) continue;
			const result = await db
				.update(adConnections)
				.set(
					field === "access_token"
						? { accessToken: rotated }
						: field === "refresh_token"
							? { refreshToken: rotated }
							: { tokenSecret: rotated },
				)
				.where(and(eq(adConnections.id, row.id), eq(column, oldValue)))
				.returning({ id: adConnections.id });
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

	const adLeadRows = await db
		.select({
			id: adLeads.id,
			payloadCiphertext: adLeads.payloadCiphertext,
		})
		.from(adLeads)
		.where(doesNotStartWith(adLeads.payloadCiphertext, activePrefix))
		.orderBy(adLeads.expiresAt, adLeads.id)
		.limit(BATCH_SIZE);
	for (const row of adLeadRows) {
		const rotated = await rotateAdvancedAdLeadPayload(keyConfig, row);
		if (!rotated) continue;
		const result = await db
			.update(adLeads)
			.set({ payloadCiphertext: rotated })
			.where(
				and(
					eq(adLeads.id, row.id),
					eq(adLeads.payloadCiphertext, row.payloadCiphertext),
				),
			)
			.returning({ id: adLeads.id });
		changed += result.length;
	}

	const conversionRows = await db
		.select({
			id: adConversionEvents.id,
			payloadCiphertext: adConversionEvents.payloadCiphertext,
		})
		.from(adConversionEvents)
		.where(
			and(
				isNotNull(adConversionEvents.payloadCiphertext),
				doesNotStartWith(adConversionEvents.payloadCiphertext, activePrefix),
			),
		)
		.orderBy(adConversionEvents.id)
		.limit(BATCH_SIZE);
	for (const row of conversionRows) {
		if (!row.payloadCiphertext) continue;
		const rotated = await rotateAdConversionPayload(keyConfig, row);
		if (!rotated) continue;
		const result = await db
			.update(adConversionEvents)
			.set({ payloadCiphertext: rotated })
			.where(
				and(
					eq(adConversionEvents.id, row.id),
					eq(adConversionEvents.payloadCiphertext, row.payloadCiphertext),
				),
			)
			.returning({ id: adConversionEvents.id });
		changed += result.length;
	}

	const mediaUploadRows = await db
		.select({
			id: mediaUploadSessions.id,
			multipartUploadIdCiphertext:
				mediaUploadSessions.multipartUploadIdCiphertext,
		})
		.from(mediaUploadSessions)
		.where(
			and(
				isNotNull(mediaUploadSessions.multipartUploadIdCiphertext),
				doesNotStartWith(
					mediaUploadSessions.multipartUploadIdCiphertext,
					activePrefix,
				),
			),
		)
		.orderBy(mediaUploadSessions.expiresAt, mediaUploadSessions.id)
		.limit(BATCH_SIZE);
	for (const row of mediaUploadRows) {
		if (!row.multipartUploadIdCiphertext) continue;
		const rotated = await rotateMediaUploadAuthority(keyConfig, row);
		if (!rotated) continue;
		const result = await db
			.update(mediaUploadSessions)
			.set({ multipartUploadIdCiphertext: rotated })
			.where(
				and(
					eq(mediaUploadSessions.id, row.id),
					eq(
						mediaUploadSessions.multipartUploadIdCiphertext,
						row.multipartUploadIdCiphertext,
					),
				),
			)
			.returning({ id: mediaUploadSessions.id });
		changed += result.length;
	}

	const projectionCiphertext = sql`${socialMutationOperations.requestPayload}->>'projection_payload_ciphertext'`;
	const socialProjectionRows = await db
		.select({
			id: socialMutationOperations.id,
			organizationId: socialMutationOperations.organizationId,
			targetType: socialMutationOperations.targetType,
			targetId: socialMutationOperations.targetId,
			kind: socialMutationOperations.kind,
			requestPayload: socialMutationOperations.requestPayload,
		})
		.from(socialMutationOperations)
		.where(
			and(
				sql`${projectionCiphertext} IS NOT NULL`,
				doesNotStartWith(projectionCiphertext, activePrefix),
			),
		)
		.orderBy(socialMutationOperations.id)
		.limit(BATCH_SIZE);
	for (const row of socialProjectionRows) {
		const nextPayload = await rotateSocialProjectionRequestPayload(
			keyConfig,
			row,
		);
		if (!nextPayload) continue;
		const result = await db
			.update(socialMutationOperations)
			.set({ requestPayload: nextPayload, updatedAt: new Date() })
			.where(
				and(
					eq(socialMutationOperations.id, row.id),
					eq(socialMutationOperations.organizationId, row.organizationId),
					sql`${socialMutationOperations.requestPayload} IS NOT DISTINCT FROM ${row.requestPayload}`,
				),
			)
			.returning({ id: socialMutationOperations.id });
		changed += result.length;
	}

	const whatsappGroupRows = await db
		.select({
			id: whatsappGroups.id,
			organizationId: whatsappGroups.organizationId,
			accountId: whatsappGroups.accountId,
			inviteLinkCiphertext: whatsappGroups.inviteLinkCiphertext,
		})
		.from(whatsappGroups)
		.where(
			and(
				isNotNull(whatsappGroups.inviteLinkCiphertext),
				doesNotStartWith(whatsappGroups.inviteLinkCiphertext, activePrefix),
			),
		)
		.orderBy(whatsappGroups.id)
		.limit(BATCH_SIZE);
	for (const row of whatsappGroupRows) {
		if (!row.inviteLinkCiphertext) continue;
		const rotated = await rotateWhatsAppGroupInviteLink(keyConfig, row);
		if (!rotated) continue;
		const result = await db
			.update(whatsappGroups)
			.set({ inviteLinkCiphertext: rotated, updatedAt: new Date() })
			.where(
				and(
					eq(whatsappGroups.id, row.id),
					eq(whatsappGroups.organizationId, row.organizationId),
					eq(whatsappGroups.accountId, row.accountId),
					eq(whatsappGroups.inviteLinkCiphertext, row.inviteLinkCiphertext),
				),
			)
			.returning({ id: whatsappGroups.id });
		changed += result.length;
	}

	const whatsappAliasRows = await db
		.select({
			id: whatsappIdentityAliases.id,
			organizationId: whatsappIdentityAliases.organizationId,
			accountId: whatsappIdentityAliases.accountId,
			bsuidCiphertext: whatsappIdentityAliases.bsuidCiphertext,
			parentBsuidCiphertext: whatsappIdentityAliases.parentBsuidCiphertext,
			waIdCiphertext: whatsappIdentityAliases.waIdCiphertext,
			usernameCiphertext: whatsappIdentityAliases.usernameCiphertext,
		})
		.from(whatsappIdentityAliases)
		.where(
			or(
				doesNotStartWith(whatsappIdentityAliases.bsuidCiphertext, activePrefix),
				and(
					isNotNull(whatsappIdentityAliases.parentBsuidCiphertext),
					doesNotStartWith(
						whatsappIdentityAliases.parentBsuidCiphertext,
						activePrefix,
					),
				),
				and(
					isNotNull(whatsappIdentityAliases.waIdCiphertext),
					doesNotStartWith(
						whatsappIdentityAliases.waIdCiphertext,
						activePrefix,
					),
				),
				and(
					isNotNull(whatsappIdentityAliases.usernameCiphertext),
					doesNotStartWith(
						whatsappIdentityAliases.usernameCiphertext,
						activePrefix,
					),
				),
			),
		)
		.orderBy(whatsappIdentityAliases.id)
		.limit(BATCH_SIZE);
	for (const row of whatsappAliasRows) {
		const rotated = await rotateWhatsAppIdentityAliasValues(keyConfig, row);
		if (!rotated) continue;
		const result = await db
			.update(whatsappIdentityAliases)
			.set({ ...rotated, updatedAt: new Date() })
			.where(
				and(
					eq(whatsappIdentityAliases.id, row.id),
					eq(whatsappIdentityAliases.organizationId, row.organizationId),
					eq(whatsappIdentityAliases.accountId, row.accountId),
					sql`${whatsappIdentityAliases.bsuidCiphertext} IS NOT DISTINCT FROM ${row.bsuidCiphertext}`,
					sql`${whatsappIdentityAliases.parentBsuidCiphertext} IS NOT DISTINCT FROM ${row.parentBsuidCiphertext}`,
					sql`${whatsappIdentityAliases.waIdCiphertext} IS NOT DISTINCT FROM ${row.waIdCiphertext}`,
					sql`${whatsappIdentityAliases.usernameCiphertext} IS NOT DISTINCT FROM ${row.usernameCiphertext}`,
				),
			)
			.returning({ id: whatsappIdentityAliases.id });
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
