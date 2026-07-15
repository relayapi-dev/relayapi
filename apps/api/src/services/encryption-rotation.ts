import {
	accountRevocationJobs,
	automationEntrypoints,
	automationSecrets,
	automationWebhookReceipts,
	byosConfigs,
	createDb,
	idempotencyReceipts,
	inboundWebhookEvents,
	shortLinkConfigs,
	socialAccounts,
	webhookEndpoints,
	whatsappPhoneNumbers,
} from "@relayapi/db";
import {
	and,
	eq,
	isNotNull,
	isNull,
	or,
	sql,
	type SQLWrapper,
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
			id: whatsappPhoneNumbers.id,
			sourceAccountId: whatsappPhoneNumbers.releaseSourceAccountId,
			ciphertext: whatsappPhoneNumbers.releaseAccessTokenCiphertext,
		})
		.from(whatsappPhoneNumbers)
		.where(
			and(
				isNotNull(whatsappPhoneNumbers.releaseSourceAccountId),
				isNotNull(whatsappPhoneNumbers.releaseAccessTokenCiphertext),
				doesNotStartWith(
					whatsappPhoneNumbers.releaseAccessTokenCiphertext,
					activeAccountPrefix,
				),
			),
		)
		.orderBy(whatsappPhoneNumbers.id)
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
			.update(whatsappPhoneNumbers)
			.set({ releaseAccessTokenCiphertext: rotated })
			.where(
				and(
					eq(whatsappPhoneNumbers.id, row.id),
					eq(whatsappPhoneNumbers.releaseAccessTokenCiphertext, row.ciphertext),
					eq(whatsappPhoneNumbers.releaseSourceAccountId, row.sourceAccountId),
				),
			)
			.returning({ id: whatsappPhoneNumbers.id });
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

	const byosRows = await db
		.select()
		.from(byosConfigs)
		.where(
			or(
				doesNotStartWith(byosConfigs.accessKeyId, activePrefix),
				doesNotStartWith(byosConfigs.secretAccessKey, activePrefix),
			),
		)
		.orderBy(byosConfigs.id)
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
			.update(byosConfigs)
			.set({
				accessKeyId: nextAccess ?? row.accessKeyId,
				secretAccessKey: nextSecret ?? row.secretAccessKey,
			})
			.where(
				and(
					eq(byosConfigs.id, row.id),
					eq(byosConfigs.accessKeyId, row.accessKeyId),
					eq(byosConfigs.secretAccessKey, row.secretAccessKey),
				),
			)
			.returning({ id: byosConfigs.id });
		changed += result.length;
	}

	const shortLinks = await db
		.select()
		.from(shortLinkConfigs)
		.where(
			and(
				isNotNull(shortLinkConfigs.apiKey),
				doesNotStartWith(shortLinkConfigs.apiKey, activePrefix),
			),
		)
		.orderBy(shortLinkConfigs.id)
		.limit(BATCH_SIZE);
	for (const row of shortLinks) {
		const rotated = await rotateScalar(row.apiKey, keyConfig, undefined, true);
		if (!rotated || !row.apiKey) continue;
		const result = await db
			.update(shortLinkConfigs)
			.set({ apiKey: rotated })
			.where(
				and(
					eq(shortLinkConfigs.id, row.id),
					eq(shortLinkConfigs.apiKey, row.apiKey),
				),
			)
			.returning({ id: shortLinkConfigs.id });
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

	if (changed > 0) {
		console.log("[encryption-rotation] rotated ciphertext batch", {
			activeId,
			changed,
		});
	}
	return changed;
}
