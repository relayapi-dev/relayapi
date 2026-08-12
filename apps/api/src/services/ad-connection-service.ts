import {
	adAccounts,
	adConnections,
	createDb,
	type Database,
	eq,
	generateId,
} from "@relayapi/db";
import { and, notInArray, sql } from "drizzle-orm";
import { encryptAdConnectionToken } from "../lib/ad-connection-token-crypto";
import { canAccessWorkspaceScope } from "../lib/workspace-scope";
import type { Env } from "../types";
import { getAdPlatformAdapter } from "./ad-platforms";
import type {
	AdPlatform,
	AdProviderCredentials,
	PlatformAdAccount,
} from "./ad-platforms/types";
import {
	AdAuthoritativeNotAppliedError,
	AdPlatformError,
} from "./ad-platforms/types";
import { requireAdCapability } from "./ad-platforms/unsupported";
import {
	assertRequiredAdScopes,
	resolveDedicatedAdCredentials,
} from "./ad-provider-credentials";

type AdConnection = typeof adConnections.$inferSelect;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface AdConnectionCredentialInput {
	accessToken: string;
	refreshToken?: string;
	tokenSecret?: string;
	accessTokenExpiresAt?: Date;
	refreshTokenExpiresAt?: Date;
	scopes: string[];
	metadata?: {
		login_customer_id?: string;
		advertiser_ids?: string[];
	};
}

function normalizedMetadata(
	platform: AdPlatform,
	metadata: AdConnectionCredentialInput["metadata"],
): Record<string, unknown> {
	if (platform === "google" && metadata?.login_customer_id) {
		return {
			login_customer_id: metadata.login_customer_id.replaceAll("-", ""),
		};
	}
	if (platform === "tiktok" && metadata?.advertiser_ids?.length) {
		return {
			advertiser_ids: [...new Set(metadata.advertiser_ids)].slice(0, 100),
		};
	}
	return {};
}

function candidateCredentials(
	env: Env,
	platform: AdPlatform,
	input: AdConnectionCredentialInput,
	metadata: Record<string, unknown>,
): AdProviderCredentials {
	if (
		input.accessTokenExpiresAt &&
		input.accessTokenExpiresAt.getTime() <= Date.now() + 60_000
	) {
		throw new AdAuthoritativeNotAppliedError(
			"ADS_CONNECTION_EXPIRED",
			"The submitted access token is expired or expires within one minute",
		);
	}
	assertRequiredAdScopes(platform, input.scopes);
	if (platform === "google" && !env.GOOGLE_ADS_DEVELOPER_TOKEN) {
		throw new AdAuthoritativeNotAppliedError(
			"ADS_PROVIDER_NOT_CONFIGURED",
			"GOOGLE_ADS_DEVELOPER_TOKEN is not configured",
		);
	}
	if (
		platform === "twitter" &&
		(!env.TWITTER_ADS_CONSUMER_KEY ||
			!env.TWITTER_ADS_CONSUMER_SECRET ||
			!input.tokenSecret)
	) {
		throw new AdAuthoritativeNotAppliedError(
			"ADS_PROVIDER_NOT_CONFIGURED",
			"X Ads requires an OAuth 1.0a token secret and configured Ads consumer credentials",
		);
	}
	if (
		platform === "tiktok" &&
		(!Array.isArray(metadata.advertiser_ids) ||
			metadata.advertiser_ids.length === 0)
	) {
		throw new AdAuthoritativeNotAppliedError(
			"ADS_CONNECTION_SETUP_INCOMPLETE",
			"TikTok Ads requires advertiser_ids returned by the Business OAuth exchange",
		);
	}
	return {
		accessToken: input.accessToken,
		tokenSecret: input.tokenSecret,
		developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
		clientId:
			platform === "twitter"
				? env.TWITTER_ADS_CONSUMER_KEY
				: platform === "tiktok"
					? env.TIKTOK_ADS_APP_ID
					: undefined,
		clientSecret:
			platform === "twitter"
				? env.TWITTER_ADS_CONSUMER_SECRET
				: platform === "tiktok"
					? env.TIKTOK_ADS_APP_SECRET
					: undefined,
		loginCustomerId:
			platform === "google" && typeof metadata.login_customer_id === "string"
				? metadata.login_customer_id
				: undefined,
		metadata,
	};
}

async function validateCredentialCandidate(
	env: Env,
	platform: AdPlatform,
	providerPrincipalId: string,
	input: AdConnectionCredentialInput,
	options: { requireAccessibleAccount: boolean },
): Promise<{
	metadata: Record<string, unknown>;
	accounts: PlatformAdAccount[];
}> {
	const adapter = getAdPlatformAdapter(platform);
	if (!adapter) {
		throw new AdAuthoritativeNotAppliedError(
			"UNSUPPORTED_PLATFORM",
			`No adapter for ad platform ${platform}`,
		);
	}
	requireAdCapability(adapter, "account_discovery");
	const metadata = normalizedMetadata(platform, input.metadata);
	const credentials = candidateCredentials(env, platform, input, metadata);
	try {
		const discovered = await adapter.listAdAccounts(
			credentials.accessToken,
			providerPrincipalId,
			credentials,
		);
		const accounts = [
			...new Map(discovered.map((account) => [account.id, account])).values(),
		];
		if (options.requireAccessibleAccount && accounts.length === 0) {
			throw new AdPlatformError(
				"ADS_NO_ACCESSIBLE_ACCOUNTS",
				`The ${platform} credential has no accessible ad accounts`,
			);
		}
		return {
			metadata:
				platform === "tiktok"
					? {
							...metadata,
							advertiser_ids: accounts.map((account) => account.id),
						}
					: metadata,
			accounts,
		};
	} catch (error) {
		if (error instanceof AdPlatformError) {
			throw new AdAuthoritativeNotAppliedError(error);
		}
		throw error;
	}
}

async function encryptedCredentialValues(
	env: Env,
	connectionId: string,
	input: AdConnectionCredentialInput,
) {
	const [accessToken, refreshToken, tokenSecret] = await Promise.all([
		encryptAdConnectionToken(
			input.accessToken,
			env.ENCRYPTION_KEY,
			connectionId,
			"access_token",
		),
		encryptAdConnectionToken(
			input.refreshToken,
			env.ENCRYPTION_KEY,
			connectionId,
			"refresh_token",
		),
		encryptAdConnectionToken(
			input.tokenSecret,
			env.ENCRYPTION_KEY,
			connectionId,
			"token_secret",
		),
	]);
	return { accessToken, refreshToken, tokenSecret };
}

export async function createValidatedAdConnection(
	env: Env,
	input: AdConnectionCredentialInput & {
		organizationId: string;
		workspaceId: string | null;
		platform: AdPlatform;
		providerPrincipalId: string;
		displayName?: string;
	},
	db: Database = createDb(env.HYPERDRIVE.connectionString),
): Promise<{ connection: AdConnection; accounts: PlatformAdAccount[] }> {
	const [existing] = await db
		.select({ id: adConnections.id })
		.from(adConnections)
		.where(
			and(
				eq(adConnections.organizationId, input.organizationId),
				input.workspaceId === null
					? sql`${adConnections.workspaceId} IS NULL`
					: eq(adConnections.workspaceId, input.workspaceId),
				eq(adConnections.platform, input.platform),
				eq(adConnections.providerPrincipalId, input.providerPrincipalId),
			),
		)
		.limit(1);
	if (existing) {
		throw new AdAuthoritativeNotAppliedError(
			"AD_CONNECTION_ALREADY_EXISTS",
			"An ad connection already exists for this provider principal and scope",
		);
	}
	const validated = await validateCredentialCandidate(
		env,
		input.platform,
		input.providerPrincipalId,
		input,
		{ requireAccessibleAccount: true },
	);
	const id = generateId("adconn_");
	const encrypted = await encryptedCredentialValues(env, id, input);
	const connection = await db.transaction(async (tx) => {
		const [inserted] = await tx
			.insert(adConnections)
			.values({
				id,
				organizationId: input.organizationId,
				workspaceId: input.workspaceId,
				platform: input.platform,
				providerPrincipalId: input.providerPrincipalId,
				displayName: input.displayName,
				...encrypted,
				accessTokenExpiresAt: input.accessTokenExpiresAt,
				refreshTokenExpiresAt: input.refreshTokenExpiresAt,
				scopes: [...new Set(input.scopes)],
				status: "active",
				metadata: validated.metadata,
			})
			.onConflictDoNothing()
			.returning();
		if (!inserted) {
			throw new AdAuthoritativeNotAppliedError(
				"AD_CONNECTION_ALREADY_EXISTS",
				"An ad connection already exists for this provider principal and scope",
			);
		}
		await projectDiscoveredAccounts(tx, inserted, validated.accounts);
		return inserted;
	});
	return { connection, accounts: validated.accounts };
}

export async function rotateValidatedAdConnection(
	env: Env,
	connection: AdConnection,
	input: AdConnectionCredentialInput,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
): Promise<{ connection: AdConnection; accounts: PlatformAdAccount[] }> {
	if (connection.status === "revoked") {
		throw new AdAuthoritativeNotAppliedError(
			"ADS_CONNECTION_REVOKED",
			"A revoked ad connection cannot be rotated; create a new connection",
		);
	}
	const validated = await validateCredentialCandidate(
		env,
		connection.platform,
		connection.providerPrincipalId,
		input,
		{ requireAccessibleAccount: false },
	);
	const encrypted = await encryptedCredentialValues(env, connection.id, input);
	const updated = await db.transaction(async (tx) => {
		const [next] = await tx
			.update(adConnections)
			.set({
				...encrypted,
				accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
				refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
				scopes: [...new Set(input.scopes)],
				metadata: validated.metadata,
				status: "active",
				credentialVersion: sql`${adConnections.credentialVersion} + 1`,
				lastError: null,
				lastRefreshAttemptAt: new Date(),
				refreshLeaseExpiresAt: null,
				revokedAt: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(adConnections.id, connection.id),
					eq(adConnections.organizationId, connection.organizationId),
					eq(adConnections.credentialVersion, connection.credentialVersion),
				),
			)
			.returning();
		if (!next) {
			throw new AdAuthoritativeNotAppliedError(
				"OPERATION_IN_PROGRESS",
				"The ad connection changed while its credentials were being validated; retry",
			);
		}
		await projectDiscoveredAccounts(tx, next, validated.accounts);
		return next;
	});
	return { connection: updated, accounts: validated.accounts };
}

export async function revokeAdConnection(
	organizationId: string,
	connectionId: string,
	db: Database,
): Promise<AdConnection> {
	return db.transaction(async (tx) => {
		const [connection] = await tx
			.select()
			.from(adConnections)
			.where(
				and(
					eq(adConnections.id, connectionId),
					eq(adConnections.organizationId, organizationId),
				),
			)
			.for("update")
			.limit(1);
		if (!connection) {
			throw new AdAuthoritativeNotAppliedError(
				"NOT_FOUND",
				"Ad connection not found",
			);
		}
		if (connection.status === "revoked") return connection;
		const now = new Date();
		const [revoked] = await tx
			.update(adConnections)
			.set({
				accessToken: null,
				refreshToken: null,
				tokenSecret: null,
				status: "revoked",
				credentialVersion: sql`${adConnections.credentialVersion} + 1`,
				refreshLeaseExpiresAt: null,
				lastError: null,
				revokedAt: now,
				updatedAt: now,
			})
			.where(eq(adConnections.id, connection.id))
			.returning();
		if (!revoked) throw new Error("Ad connection revocation fence lost");
		await tx
			.update(adAccounts)
			.set({ status: "disabled", updatedAt: now })
			.where(eq(adAccounts.adConnectionId, connection.id));
		return revoked;
	});
}

function operationCapabilities(
	adapter: NonNullable<ReturnType<typeof getAdPlatformAdapter>>,
) {
	return adapter.capabilities.operations;
}

async function projectDiscoveredAccounts(
	db: Database | Transaction,
	connection: AdConnection,
	discovered: PlatformAdAccount[],
): Promise<void> {
	const adapter = getAdPlatformAdapter(connection.platform);
	if (!adapter) {
		throw new AdPlatformError(
			"UNSUPPORTED_PLATFORM",
			`No adapter for ad platform ${connection.platform}`,
		);
	}
	const uniqueDiscovered = [
		...new Map(discovered.map((account) => [account.id, account])).values(),
	];
	const rows: (typeof adAccounts.$inferInsert)[] = uniqueDiscovered.map(
		(account) => ({
			organizationId: connection.organizationId,
			workspaceId: connection.workspaceId,
			adConnectionId: connection.id,
			platform: connection.platform,
			platformAdAccountId: account.id,
			name: account.name,
			currency: account.currency?.toUpperCase(),
			timezone: account.timezone,
			status: account.status ?? "active",
			capabilities: operationCapabilities(adapter),
			capabilitiesCheckedAt: new Date(),
			metadata: account.metadata ?? null,
		}),
	);
	if (rows.length > 0) {
		const projected = await db
			.insert(adAccounts)
			.values(rows)
			.onConflictDoUpdate({
				target: [
					adAccounts.organizationId,
					adAccounts.platform,
					adAccounts.platformAdAccountId,
				],
				set: {
					adConnectionId: sql`excluded.ad_connection_id`,
					workspaceId: sql`excluded.workspace_id`,
					name: sql`excluded.name`,
					currency: sql`excluded.currency`,
					timezone: sql`excluded.timezone`,
					status: sql`excluded.status`,
					capabilities: sql`excluded.capabilities`,
					capabilitiesCheckedAt: sql`excluded.capabilities_checked_at`,
					metadata: sql`coalesce(${adAccounts.metadata}, '{}'::jsonb) || coalesce(excluded.metadata, '{}'::jsonb)`,
					updatedAt: new Date(),
				},
				// A provider account is one authority root inside an organization. A
				// second active connection must not silently steal it, especially across
				// workspace grants. Legacy rows and explicitly revoked authorities can be
				// adopted only within the exact same operational scope.
				setWhere: sql`${adAccounts.workspaceId} IS NOT DISTINCT FROM ${connection.workspaceId}
				AND (
					${adAccounts.adConnectionId} IS NULL
					OR ${adAccounts.adConnectionId} = ${connection.id}
					OR EXISTS (
						SELECT 1
						FROM ${adConnections} AS prior_ad_connection
						WHERE prior_ad_connection.id = ${adAccounts.adConnectionId}
							AND prior_ad_connection.organization_id = ${connection.organizationId}
							AND prior_ad_connection.status = 'revoked'
					)
				)`,
			})
			.returning({ id: adAccounts.id });
		if (projected.length !== rows.length) {
			throw new AdAuthoritativeNotAppliedError(
				"AD_ACCOUNT_ALREADY_CONNECTED",
				"One or more provider ad accounts already belong to another active connection or workspace",
			);
		}
	}

	// The validated provider listing is authoritative for this connection only.
	// Disable rows that disappeared in the same transaction as the upserts so a
	// credential rotation can never leave a stale account usable. The redundant
	// tenant/scope/platform predicates are intentional defense in depth: an empty
	// discovery must not touch another connection even if an invalid legacy row
	// somehow references the same provider account.
	const exactConnectionScope = and(
		eq(adAccounts.adConnectionId, connection.id),
		eq(adAccounts.organizationId, connection.organizationId),
		eq(adAccounts.platform, connection.platform),
		connection.workspaceId === null
			? sql`${adAccounts.workspaceId} IS NULL`
			: eq(adAccounts.workspaceId, connection.workspaceId),
	);
	const discoveredIds = uniqueDiscovered.map((account) => account.id);
	await db
		.update(adAccounts)
		.set({
			status: "disabled",
			syncLeaseExpiresAt: null,
			syncStartedAt: null,
			updatedAt: new Date(),
		})
		.where(
			discoveredIds.length > 0
				? and(
						exactConnectionScope,
						notInArray(adAccounts.platformAdAccountId, discoveredIds),
					)
				: exactConnectionScope,
		);
}

export async function discoverAdAccountsForConnection(
	env: Env,
	organizationId: string,
	connectionId: string,
	workspaceScope: "all" | string[],
	db: Database = createDb(env.HYPERDRIVE.connectionString),
) {
	const [connection] = await db
		.select()
		.from(adConnections)
		.where(
			and(
				eq(adConnections.id, connectionId),
				eq(adConnections.organizationId, organizationId),
			),
		)
		.limit(1);
	if (
		!connection ||
		!canAccessWorkspaceScope(workspaceScope, connection.workspaceId)
	) {
		throw new AdAuthoritativeNotAppliedError(
			"NOT_FOUND",
			"Ad connection not found",
		);
	}
	const adapter = getAdPlatformAdapter(connection.platform);
	if (!adapter) {
		throw new AdAuthoritativeNotAppliedError(
			"UNSUPPORTED_PLATFORM",
			`No adapter for ad platform ${connection.platform}`,
		);
	}
	requireAdCapability(adapter, "account_discovery");
	const credentials = await resolveDedicatedAdCredentials(
		connection,
		undefined,
		env,
	);
	const discovered = await adapter.listAdAccounts(
		credentials.accessToken,
		connection.providerPrincipalId,
		credentials,
	);
	const accounts = [
		...new Map(discovered.map((account) => [account.id, account])).values(),
	];
	await db.transaction(async (tx) => {
		// Fence the provider response against concurrent credential rotation or
		// revocation. Holding the authority row until projection commits means a
		// revoke always wins: it either precedes this check or disables the freshly
		// projected rows immediately after acquiring the same lock.
		const [authoritative] = await tx
			.select()
			.from(adConnections)
			.where(
				and(
					eq(adConnections.id, connection.id),
					eq(adConnections.organizationId, connection.organizationId),
				),
			)
			.for("update")
			.limit(1);
		if (!authoritative) {
			throw new AdAuthoritativeNotAppliedError(
				"NOT_FOUND",
				"Ad connection not found",
			);
		}
		if (authoritative.status === "revoked") {
			throw new AdAuthoritativeNotAppliedError(
				"ADS_CONNECTION_REVOKED",
				"The ad connection was revoked during account discovery",
			);
		}
		if (
			authoritative.status !== "active" ||
			authoritative.credentialVersion !== connection.credentialVersion
		) {
			throw new AdAuthoritativeNotAppliedError(
				"OPERATION_IN_PROGRESS",
				"The ad connection changed during account discovery; retry",
			);
		}
		await projectDiscoveredAccounts(tx, authoritative, accounts);
	});
	return accounts;
}
