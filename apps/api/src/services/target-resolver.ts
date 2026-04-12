import type { Database } from "@relayapi/db";
import { workspaces, socialAccounts } from "@relayapi/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Platform } from "../schemas/common";
import { PLATFORMS } from "../schemas/common";

export interface ResolvedTarget {
	key: string; // original target value from the request
	platform: Platform;
	accounts: Array<{
		id: string;
		username: string | null;
		display_name: string | null;
	}>;
}

export interface FailedTarget {
	key: string;
	error: { code: string; message: string };
}

export interface TargetResolution {
	resolved: ResolvedTarget[];
	failed: FailedTarget[];
}

function isPlatformName(value: string): value is Platform {
	return (PLATFORMS as readonly string[]).includes(value);
}

function isAccountId(value: string): boolean {
	return value.startsWith("acc_");
}

function isWorkspaceId(value: string): boolean {
	return value.startsWith("ws_");
}

/**
 * Resolves an array of targets (account IDs, platform names, or workspace IDs)
 * to actual social accounts.
 *
 * - "twitter" → all twitter accounts in the org
 * - "acc_abc123" → direct lookup, verified against the org
 * - "ws_xyz" → all accounts in that workspace
 * - Unknown platform or missing account → added to failed list
 */
export async function resolveTargets(
	db: Database,
	orgId: string,
	targets: string[],
	workspaceScope: "all" | string[],
	prefetchedAccounts?: Array<{ id: string; platform: string; username: string | null; displayName: string | null; workspaceId: string | null }>,
): Promise<TargetResolution> {
	const resolved: ResolvedTarget[] = [];
	const failed: FailedTarget[] = [];

	// Deduplicate targets
	const unique = [...new Set(targets)];

	// Separate into platform names, account IDs, and workspace IDs
	const platformTargets: string[] = [];
	const accountIdTargets: string[] = [];
	const workspaceIdTargets: string[] = [];
	const invalid: string[] = [];

	for (const target of unique) {
		if (isAccountId(target)) {
			accountIdTargets.push(target);
		} else if (isWorkspaceId(target)) {
			workspaceIdTargets.push(target);
		} else if (isPlatformName(target)) {
			platformTargets.push(target);
		} else {
			invalid.push(target);
		}
	}

	// Mark invalid targets
	for (const target of invalid) {
		failed.push({
			key: target,
			error: {
				code: "INVALID_TARGET",
				message: `"${target}" is not a valid platform name, account ID, or workspace ID. Use a platform name (e.g. "twitter"), an account ID (e.g. "acc_xxx"), or a workspace ID (e.g. "ws_xxx").`,
			},
		});
	}

	// Use pre-fetched accounts if available, otherwise fetch once
	// When workspace scope is set, only include accounts from allowed workspaces
	const prefetchConditions = [eq(socialAccounts.organizationId, orgId)];
	if (workspaceScope !== "all") {
		prefetchConditions.push(inArray(socialAccounts.workspaceId, workspaceScope));
	}
	const rawAccounts = prefetchedAccounts ?? await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			workspaceId: socialAccounts.workspaceId,
		})
		.from(socialAccounts)
		.where(and(...prefetchConditions));

	// Safety filter: ensure prefetched accounts also respect workspace scope
	const orgAccounts = (prefetchedAccounts && workspaceScope !== "all")
		? rawAccounts.filter(a => a.workspaceId != null && workspaceScope.includes(a.workspaceId))
		: rawAccounts;

	// Resolve platform name targets
	for (const platform of platformTargets) {
		const matching = orgAccounts.filter((a) => a.platform === platform);
		if (matching.length === 0) {
			failed.push({
				key: platform,
				error: {
					code: "NO_ACCOUNT",
					message: `No ${platform} account connected to this organization.`,
				},
			});
		} else {
			resolved.push({
				key: platform,
				platform: platform as Platform,
				accounts: matching.map((a) => ({
					id: a.id,
					username: a.username,
					display_name: a.displayName,
				})),
			});
		}
	}

	// Resolve workspace ID targets — batch-validate in a single query
	if (workspaceIdTargets.length > 0) {
		const validWorkspaces = await db
			.select({ id: workspaces.id })
			.from(workspaces)
			.where(
				and(
					eq(workspaces.organizationId, orgId),
					inArray(workspaces.id, workspaceIdTargets),
				),
			);
		const validIds = new Set(validWorkspaces.map((w) => w.id));

		for (const wsId of workspaceIdTargets) {
			if (!validIds.has(wsId)) {
				failed.push({
					key: wsId,
					error: {
						code: "WORKSPACE_NOT_FOUND",
						message: `Workspace "${wsId}" not found in this organization.`,
					},
				});
				continue;
			}

			const workspaceAccounts = orgAccounts.filter((a) => a.workspaceId === wsId);
			if (workspaceAccounts.length === 0) {
				failed.push({
					key: wsId,
					error: {
						code: "EMPTY_WORKSPACE",
						message: `Workspace "${wsId}" has no accounts.`,
					},
				});
				continue;
			}

			// Group accounts by platform, creating one ResolvedTarget per platform
			const byPlatform = new Map<string, typeof workspaceAccounts>();
			for (const acc of workspaceAccounts) {
				const list = byPlatform.get(acc.platform) ?? [];
				list.push(acc);
				byPlatform.set(acc.platform, list);
			}
			for (const [platform, accounts] of byPlatform) {
				resolved.push({
					key: wsId,
					platform: platform as Platform,
					accounts: accounts.map((a) => ({
						id: a.id,
						username: a.username,
						display_name: a.displayName,
					})),
				});
			}
		}
	}

	// Resolve account ID targets
	for (const accId of accountIdTargets) {
		const account = orgAccounts.find((a) => a.id === accId);
		if (!account) {
			failed.push({
				key: accId,
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: `Account "${accId}" not found in this organization.`,
				},
			});
		} else {
			resolved.push({
				key: accId,
				platform: account.platform as Platform,
				accounts: [
					{
						id: account.id,
						username: account.username,
						display_name: account.displayName,
					},
				],
			});
		}
	}

	return { resolved, failed };
}
