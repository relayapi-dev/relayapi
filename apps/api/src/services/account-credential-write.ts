import { type Database, organization, socialAccounts } from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import { encryptAccountToken } from "../lib/account-token-crypto";
import { validatePersistedOperationalScope } from "../lib/request-access";
import {
	canAccessWorkspaceScope,
	workspaceScopeSqlCondition,
} from "../lib/workspace-scope";
import { supersedeAccountRevocationJob } from "./account-revocation";

type AccountInsert = typeof socialAccounts.$inferInsert;

export class AccountWorkspaceConflictError extends Error {
	readonly code = "ACCOUNT_WORKSPACE_CONFLICT";

	constructor(
		readonly existingWorkspaceId: string | null,
		readonly requestedWorkspaceId: string | null,
	) {
		super(
			"This provider account is already connected in another workspace. Move or disconnect the existing account before reconnecting it elsewhere.",
		);
		this.name = "AccountWorkspaceConflictError";
	}
}

export function isAccountWorkspaceConflictError(
	error: unknown,
): error is AccountWorkspaceConflictError {
	return error instanceof AccountWorkspaceConflictError;
}

export class AccountWorkspaceAccessError extends Error {
	readonly code = "WORKSPACE_ACCESS_DENIED";

	constructor() {
		super(
			"This API key does not have access to the connected account's workspace.",
		);
		this.name = "AccountWorkspaceAccessError";
	}
}

export function isAccountWorkspaceAccessError(
	error: unknown,
): error is AccountWorkspaceAccessError {
	return error instanceof AccountWorkspaceAccessError;
}

/**
 * Upsert an account identity first, then seal credentials against the stable
 * database id in the same transaction. This avoids context-free ciphertext and
 * remains race-safe when two connection attempts target the same provider id.
 */
export async function upsertConnectedAccountWithCredentials(
	db: Pick<Database, "insert" | "select" | "update">,
	keyConfig: string,
	params: {
		apiKeyId: string;
		authorizedWorkspaceScope: "all" | string[];
		insert: Omit<AccountInsert, "accessToken" | "refreshToken">;
		update: Partial<
			Omit<
				AccountInsert,
				| "id"
				| "organizationId"
				| "platform"
				| "platformAccountId"
				| "workspaceId"
				| "accessToken"
				| "refreshToken"
			>
		>;
		/**
		 * Optional-mode omission reconnects an existing identity in place. It
		 * cannot demote a workspace-bound account to organization scope.
		 */
		preserveExistingWorkspaceOnOmission?: boolean;
		accessToken: string | null | undefined;
		refreshToken?: string | null | undefined;
	},
): Promise<typeof socialAccounts.$inferSelect | undefined> {
	const liveValidation = await validatePersistedOperationalScope(db, {
		apiKeyId: params.apiKeyId,
		organizationId: params.insert.organizationId,
		workspaceId: params.insert.workspaceId ?? null,
		resourceName: "connected account",
	});
	if (!liveValidation.ok) {
		throw new AccountWorkspaceAccessError();
	}
	const liveAuthorization = liveValidation.authorization;
	if (
		!canAccessWorkspaceScope(
			params.authorizedWorkspaceScope,
			params.insert.workspaceId ?? null,
		) ||
		!canAccessWorkspaceScope(
			liveAuthorization.workspaceScope,
			params.insert.workspaceId ?? null,
		)
	) {
		throw new AccountWorkspaceAccessError();
	}

	// Every caller supplies a transaction. This lock serializes credential writes
	// with tenant deletion's FOR UPDATE lock: either the new grant commits first
	// and deletion snapshots it, or deletion wins and this write is rejected.
	const [activeOrganization] = await db
		.select({ lifecycleStatus: organization.lifecycleStatus })
		.from(organization)
		.where(eq(organization.id, params.insert.organizationId))
		.for("key share")
		.limit(1);
	if (activeOrganization?.lifecycleStatus !== "active") return undefined;

	const [identity] = await db
		.insert(socialAccounts)
		.values(params.insert)
		.onConflictDoUpdate({
			target: [
				socialAccounts.organizationId,
				socialAccounts.platform,
				socialAccounts.platformAccountId,
			],
			set: { ...params.update, updatedAt: new Date() },
			// Re-authentication rotates credentials in place. It must never double
			// as an implicit workspace move for the provider identity.
			setWhere:
				params.preserveExistingWorkspaceOnOmission &&
				(params.insert.workspaceId ?? null) === null
					? and(
							workspaceScopeSqlCondition(
								params.authorizedWorkspaceScope,
								socialAccounts.workspaceId,
							),
							workspaceScopeSqlCondition(
								liveAuthorization.workspaceScope,
								socialAccounts.workspaceId,
							),
						)
					: and(
							workspaceScopeSqlCondition(
								params.authorizedWorkspaceScope,
								socialAccounts.workspaceId,
							),
							workspaceScopeSqlCondition(
								liveAuthorization.workspaceScope,
								socialAccounts.workspaceId,
							),
							sql`${socialAccounts.workspaceId} IS NOT DISTINCT FROM ${params.insert.workspaceId ?? null}`,
						),
		})
		.returning({
			id: socialAccounts.id,
			organizationId: socialAccounts.organizationId,
		});
	if (!identity) {
		const [existing] = await db
			.select({ workspaceId: socialAccounts.workspaceId })
			.from(socialAccounts)
			.where(
				and(
					eq(socialAccounts.organizationId, params.insert.organizationId),
					eq(socialAccounts.platform, params.insert.platform),
					eq(socialAccounts.platformAccountId, params.insert.platformAccountId),
				),
			)
			.limit(1);
		if (existing) {
			if (
				!canAccessWorkspaceScope(
					params.authorizedWorkspaceScope,
					existing.workspaceId,
				) ||
				!canAccessWorkspaceScope(
					liveAuthorization.workspaceScope,
					existing.workspaceId,
				)
			) {
				throw new AccountWorkspaceAccessError();
			}
			throw new AccountWorkspaceConflictError(
				existing.workspaceId,
				params.insert.workspaceId ?? null,
			);
		}
		return undefined;
	}

	const [accessToken, refreshToken] = await Promise.all([
		encryptAccountToken(
			params.accessToken,
			keyConfig,
			identity.id,
			"access_token",
		),
		encryptAccountToken(
			params.refreshToken,
			keyConfig,
			identity.id,
			"refresh_token",
		),
	]);
	const [account] = await db
		.update(socialAccounts)
		.set({
			accessToken,
			refreshToken,
			tokenVersion: sql`${socialAccounts.tokenVersion} + 1`,
			lifecycleStatus: "active",
			disconnectRequestedAt: null,
			disconnectedAt: null,
			disconnectReason: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(socialAccounts.id, identity.id),
				eq(socialAccounts.organizationId, identity.organizationId),
			),
		)
		.returning();
	if (account) {
		await supersedeAccountRevocationJob(db, {
			accountId: account.id,
			organizationId: account.organizationId,
			tokenVersion: account.tokenVersion,
		});
	}
	return account;
}
