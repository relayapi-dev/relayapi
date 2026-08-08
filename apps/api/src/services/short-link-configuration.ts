import {
	type Database,
	shortLinkConfigs,
	shortLinkCredentials,
} from "@relayapi/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { maybeDecrypt } from "../lib/crypto";
import type { ExternalShortLinkProviderType } from "./short-link-lifecycle";
import type { ShortLinkProvider } from "./short-link-providers";
import { getProvider } from "./short-link-providers";

export type ShortLinkConfigUpdate = {
	mode: "always" | "ask" | "never";
	provider?: "relayapi" | ExternalShortLinkProviderType;
	domain?: string;
	encryptedApiKey?: string;
};

type ShortLinkConfigTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];

/**
 * Retired credentials are useful only while a current config or historical
 * link still pins their exact provider/version. Provider cleanup jobs retain
 * their own encrypted copy, so they do not keep this tenant credential row
 * alive after the link is erased.
 */
export async function pruneOrphanedShortLinkCredentials(
	db: Pick<Database, "execute">,
	organizationId: string,
): Promise<number> {
	const deleted = (await db.execute(sql`
		DELETE FROM short_link_credentials AS credential
		 WHERE credential.organization_id = ${organizationId}
		   AND credential.state = 'retired'
		   AND NOT EXISTS (
				SELECT 1
				  FROM short_links AS link
				 WHERE link.organization_id = credential.organization_id
				   AND link.provider = credential.provider
				   AND link.credential_version = credential.version
		   )
		   AND NOT EXISTS (
				SELECT 1
				  FROM short_link_configs AS config
				 WHERE config.organization_id = credential.organization_id
				   AND config.provider = credential.provider
				   AND config.credential_version = credential.version
		   )
		RETURNING credential.id
	`)) as unknown as Array<{ id: string }>;
	return deleted.length;
}

export async function updateVersionedShortLinkConfig(
	db: Database,
	organizationId: string,
	input: ShortLinkConfigUpdate,
): Promise<typeof shortLinkConfigs.$inferSelect> {
	return db.transaction((tx) =>
		updateVersionedShortLinkConfigInTransaction(tx, organizationId, input),
	);
}

/**
 * Transaction body used when another invariant (for example the exact issuing
 * credential/session fence) must commit atomically with the configuration.
 */
export async function updateVersionedShortLinkConfigInTransaction(
	tx: ShortLinkConfigTransaction,
	organizationId: string,
	input: ShortLinkConfigUpdate,
): Promise<typeof shortLinkConfigs.$inferSelect> {
	await tx.execute(
		sql`SELECT pg_advisory_xact_lock(hashtextextended(${`short-link-config:${organizationId}`}, 0))`,
	);
	const [existing] = await tx
		.select()
		.from(shortLinkConfigs)
		.where(eq(shortLinkConfigs.organizationId, organizationId))
		.limit(1);

	const provider = input.provider ?? existing?.provider ?? null;
	const domain =
		input.domain !== undefined ? input.domain : (existing?.domain ?? null);
	const providerConfigVersion = (existing?.providerConfigVersion ?? 0) + 1;
	let credentialVersion: number | null = null;
	if (input.encryptedApiKey && (!provider || provider === "relayapi")) {
		throw new Error(
			"An API key can only be stored for a third-party short-link provider",
		);
	}
	if (provider === "short_io" && !domain) {
		throw new Error("Short.io requires a custom domain");
	}

	if (provider && provider !== "relayapi") {
		if (input.encryptedApiKey) {
			const [latest] = await tx
				.select({ version: shortLinkCredentials.version })
				.from(shortLinkCredentials)
				.where(eq(shortLinkCredentials.organizationId, organizationId))
				.orderBy(desc(shortLinkCredentials.version))
				.limit(1);
			credentialVersion = (latest?.version ?? 0) + 1;
			const now = new Date();
			await tx
				.update(shortLinkCredentials)
				.set({ state: "retired", retiredAt: now })
				.where(
					and(
						eq(shortLinkCredentials.organizationId, organizationId),
						eq(shortLinkCredentials.state, "active"),
					),
				);
			await tx.insert(shortLinkCredentials).values({
				organizationId,
				provider,
				version: credentialVersion,
				apiKeyCiphertext: input.encryptedApiKey,
				state: "active",
			});
		} else if (existing?.provider === provider && existing.credentialVersion) {
			credentialVersion = existing.credentialVersion;
		} else {
			throw new Error(
				"API key is required when selecting a third-party provider",
			);
		}
	} else if (
		existing?.credentialVersion &&
		existing.provider &&
		existing.provider !== "relayapi"
	) {
		await tx
			.update(shortLinkCredentials)
			.set({ state: "retired", retiredAt: new Date() })
			.where(
				and(
					eq(shortLinkCredentials.organizationId, organizationId),
					eq(shortLinkCredentials.state, "active"),
				),
			);
	}

	const [config] = await tx
		.insert(shortLinkConfigs)
		.values({
			organizationId,
			mode: input.mode,
			provider,
			domain,
			providerConfigVersion,
			credentialVersion,
		})
		.onConflictDoUpdate({
			target: shortLinkConfigs.organizationId,
			set: {
				mode: input.mode,
				provider,
				domain,
				providerConfigVersion,
				credentialVersion,
				updatedAt: new Date(),
			},
		})
		.returning();
	if (!config) throw new Error("Failed to save short-link configuration");
	await pruneOrphanedShortLinkCredentials(tx, organizationId);
	return config;
}

export async function resolveExternalShortLinkProvider(input: {
	db: Database;
	organizationId: string;
	provider: ExternalShortLinkProviderType;
	credentialVersion: number;
	encryptionKey: string;
}): Promise<{
	provider: ShortLinkProvider;
	apiKey: string;
	credentialCiphertext: string;
} | null> {
	const [credential] = await input.db
		.select()
		.from(shortLinkCredentials)
		.where(
			and(
				eq(shortLinkCredentials.organizationId, input.organizationId),
				eq(shortLinkCredentials.provider, input.provider),
				eq(shortLinkCredentials.version, input.credentialVersion),
			),
		)
		.limit(1);
	if (!credential) return null;
	const provider = getProvider(input.provider);
	if (!provider) return null;
	const apiKey = await maybeDecrypt(
		credential.apiKeyCiphertext,
		input.encryptionKey,
	);
	if (!apiKey) return null;
	return {
		provider,
		apiKey,
		credentialCiphertext: credential.apiKeyCiphertext,
	};
}
