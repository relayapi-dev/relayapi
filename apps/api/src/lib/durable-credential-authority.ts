import type { Context } from "hono";
import type { Env, Variables } from "../types";
import {
	type CredentialMutationAuthorityResult,
	type CredentialMutationTransaction,
	createDurableCredentialAuthoritySnapshot,
	type DurableCredentialAuthoritySnapshot,
	lockCredentialMutationAuthorityInTransaction,
	lockDurableCredentialAuthorityInTransaction,
} from "./credential-mutation-authority";

export type DurableFinancialPermission = "manage_billing" | "manage_spend";

export type DurableCredentialAuthorityAdmission = (
	tx: CredentialMutationTransaction,
	options?: {
		revision?: number;
		workspaceId?: string | null;
		requireAllWorkspaceScope?: boolean;
	},
) => Promise<
	CredentialMutationAuthorityResult<DurableCredentialAuthoritySnapshot>
>;

/**
 * Build a request-bound admission callback without leaking Hono context into
 * durable services. The callback must be invoked inside the same transaction
 * that inserts the operation row.
 */
export function durableCredentialAuthorityAdmission(
	c: Context<{ Bindings: Env; Variables: Variables }>,
	requiredFinancialPermission: DurableFinancialPermission,
): DurableCredentialAuthorityAdmission {
	return async (tx, options) => {
		const authority = await lockCredentialMutationAuthorityInTransaction(
			c,
			{ requiredFinancialPermission },
			tx,
		);
		if (!authority.ok) return authority;
		return {
			ok: true,
			value: createDurableCredentialAuthoritySnapshot(authority.value, {
				admittedAt: new Date(),
				revision: options?.revision ?? 1,
				workspaceId: options?.workspaceId,
				requireAllWorkspaceScope: options?.requireAllWorkspaceScope,
			}),
		};
	};
}

export async function revalidateDurableCredentialAuthority(
	tx: CredentialMutationTransaction,
	snapshot: DurableCredentialAuthoritySnapshot,
	requiredFinancialPermission: DurableFinancialPermission,
): Promise<
	CredentialMutationAuthorityResult<DurableCredentialAuthoritySnapshot>
> {
	return lockDurableCredentialAuthorityInTransaction(tx, snapshot, {
		requiredFinancialPermission,
	});
}

export type { DurableCredentialAuthoritySnapshot };
