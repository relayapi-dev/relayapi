import { describe, expect, it } from "bun:test";
import type { Database } from "@relayapi/db";
import { decryptAccountTokens } from "../lib/account-token-crypto";
import {
	AccountWorkspaceAccessError,
	upsertConnectedAccountWithCredentials,
} from "../services/account-credential-write";
import { isCurrentCredentialSource } from "../services/account-revocation";

const KEY_CONFIG = `active=${"53".repeat(32)}`;

function authorizationSelect(options: {
	lifecycleStatus: "active" | "deleting";
	workspaceScope?: "all" | string[];
	requireWorkspaceId?: boolean;
	keyAvailable?: boolean;
	existingWorkspaceId?: string | null;
}) {
	return (selection: Record<string, unknown> = {}) => {
		const selected = new Set(Object.keys(selection));
		const rows = () => {
			if (selected.has("referenceId")) {
				return options.keyAvailable === false
					? []
					: [
							{
								id: "key_test",
								referenceId: null,
								permissions: "write",
								metadata: {
									workspace_scope: options.workspaceScope ?? "all",
								},
							},
						];
			}
			if (selected.has("requireWorkspaceId")) {
				return [{ requireWorkspaceId: options.requireWorkspaceId ?? false }];
			}
			if (selected.has("workspaceId")) {
				return "existingWorkspaceId" in options
					? [{ workspaceId: options.existingWorkspaceId ?? null }]
					: [];
			}
			return [{ lifecycleStatus: options.lifecycleStatus }];
		};
		const chain = {
			from: () => chain,
			innerJoin: () => chain,
			where: () => chain,
			for: () => chain,
			limit: async () => rows(),
		};
		return chain;
	};
}

describe("connected account credential writes", () => {
	it("binds new credentials to the stable upserted account id", async () => {
		let credentialUpdate: Record<string, unknown> | undefined;
		let revocationUpdate: Record<string, unknown> | undefined;
		let updateIndex = 0;
		const db = {
			select: authorizationSelect({ lifecycleStatus: "active" }),
			insert: () => ({
				values: () => ({
					onConflictDoUpdate: () => ({
						returning: async () => [
							{ id: "acc_stable", organizationId: "org_test" },
						],
					}),
				}),
			}),
			update: () => {
				const isCredentialUpdate = updateIndex++ === 0;
				return {
					set: (values: Record<string, unknown>) => {
						if (isCredentialUpdate) credentialUpdate = values;
						else revocationUpdate = values;
						return {
							where: () =>
								isCredentialUpdate
									? {
											returning: async () => [
												{
													id: "acc_stable",
													organizationId: "org_test",
													tokenVersion: 1,
													accessToken: values.accessToken,
													refreshToken: values.refreshToken,
												},
											],
										}
									: Promise.resolve([]),
						};
					},
				};
			},
		} as unknown as Database;

		const account = await upsertConnectedAccountWithCredentials(
			db,
			KEY_CONFIG,
			{
				apiKeyId: "key_test",
				authorizedWorkspaceScope: "all",
				insert: {
					organizationId: "org_test",
					platform: "twitter",
					platformAccountId: "provider-user",
				},
				update: {},
				accessToken: "access",
				refreshToken: "refresh",
			},
		);

		expect(account?.id).toBe("acc_stable");
		expect(credentialUpdate?.lifecycleStatus).toBe("active");
		expect(credentialUpdate?.tokenVersion).toBeDefined();
		expect(revocationUpdate).toEqual(
			expect.objectContaining({
				status: "succeeded",
				accessTokenCiphertext: null,
				refreshTokenCiphertext: null,
			}),
		);
		const decrypted = await decryptAccountTokens(
			{
				id: "acc_stable",
				accessToken: credentialUpdate?.accessToken as string,
				refreshToken: credentialUpdate?.refreshToken as string,
			},
			KEY_CONFIG,
		);
		expect(decrypted.accessToken).toBe("access");
		expect(decrypted.refreshToken).toBe("refresh");
	});

	it("does not reactivate an account after tenant deletion has started", async () => {
		let inserted = false;
		let updated = false;
		const db = {
			select: authorizationSelect({ lifecycleStatus: "deleting" }),
			insert: () => {
				inserted = true;
				throw new Error("credential identity must not be written");
			},
			update: () => {
				updated = true;
				throw new Error("credential must not be reactivated");
			},
		} as unknown as Database;

		const account = await upsertConnectedAccountWithCredentials(
			db,
			KEY_CONFIG,
			{
				apiKeyId: "key_test",
				authorizedWorkspaceScope: "all",
				insert: {
					organizationId: "org_deleting",
					platform: "twitter",
					platformAccountId: "provider-user",
				},
				update: {},
				accessToken: "new-access",
			},
		);

		expect(account).toBeUndefined();
		expect(inserted).toBe(false);
		expect(updated).toBe(false);
	});

	it("allows an optional organization-scoped connection for a non-empty workspace grant", async () => {
		const db = {
			select: authorizationSelect({
				lifecycleStatus: "active",
				workspaceScope: ["ws_a"],
			}),
			insert: () => ({
				values: () => ({
					onConflictDoUpdate: () => ({
						returning: async () => [
							{ id: "acc_org", organizationId: "org_test" },
						],
					}),
				}),
			}),
			update: () => ({
				set: (values: Record<string, unknown>) => ({
					where: () => ({
						returning: async () => [
							{
								id: "acc_org",
								organizationId: "org_test",
								tokenVersion: 1,
								accessToken: values.accessToken,
								refreshToken: values.refreshToken,
							},
						],
					}),
				}),
			}),
		} as unknown as Database;

		const account = await upsertConnectedAccountWithCredentials(
			db,
			KEY_CONFIG,
			{
				apiKeyId: "key_test",
				authorizedWorkspaceScope: ["ws_a"],
				insert: {
					organizationId: "org_test",
					workspaceId: null,
					platform: "twitter",
					platformAccountId: "provider-user",
				},
				update: {},
				accessToken: "access",
			},
		);

		expect(account?.id).toBe("acc_org");
	});

	it("does not rotate A credentials when either the initial or live grant cannot access A", async () => {
		for (const scopes of [
			{ initial: ["ws_a"], live: ["ws_b"] },
			{ initial: ["ws_b"], live: ["ws_a"] },
		]) {
			let credentialUpdated = false;
			let conflictWhere: unknown;
			const db = {
				select: authorizationSelect({
					lifecycleStatus: "active",
					workspaceScope: scopes.live,
					existingWorkspaceId: "ws_a",
				}),
				insert: () => ({
					values: () => ({
						onConflictDoUpdate: (options: { setWhere: unknown }) => {
							conflictWhere = options.setWhere;
							return { returning: async () => [] };
						},
					}),
				}),
				update: () => {
					credentialUpdated = true;
					throw new Error("credential mutation must not run");
				},
			} as unknown as Database;

			expect(
				upsertConnectedAccountWithCredentials(db, KEY_CONFIG, {
					apiKeyId: "key_test",
					authorizedWorkspaceScope: scopes.initial,
					insert: {
						organizationId: "org_test",
						workspaceId: null,
						platform: "twitter",
						platformAccountId: "provider-user",
					},
					update: {},
					preserveExistingWorkspaceOnOmission: true,
					accessToken: "must-not-be-written",
				}),
			).rejects.toBeInstanceOf(AccountWorkspaceAccessError);
			expect(conflictWhere).toBeDefined();
			expect(credentialUpdated).toBe(false);
		}
	});

	it("fails closed before identity or credential writes for revoked and zero-grant keys", async () => {
		for (const authorization of [
			{ keyAvailable: false, workspaceScope: "all" as const },
			{ keyAvailable: true, workspaceScope: [] as string[] },
		]) {
			let identityWritten = false;
			let credentialUpdated = false;
			const db = {
				select: authorizationSelect({
					lifecycleStatus: "active",
					...authorization,
				}),
				insert: () => {
					identityWritten = true;
					throw new Error("identity mutation must not run");
				},
				update: () => {
					credentialUpdated = true;
					throw new Error("credential mutation must not run");
				},
			} as unknown as Database;

			expect(
				upsertConnectedAccountWithCredentials(db, KEY_CONFIG, {
					apiKeyId: "key_test",
					authorizedWorkspaceScope: authorization.workspaceScope,
					insert: {
						organizationId: "org_test",
						workspaceId: null,
						platform: "twitter",
						platformAccountId: "provider-user",
					},
					update: {},
					accessToken: "must-not-be-written",
				}),
			).rejects.toBeInstanceOf(AccountWorkspaceAccessError);
			expect(identityWritten).toBe(false);
			expect(credentialUpdated).toBe(false);
		}
	});

	it("treats key rotation as the same grant and a reconnect as a stale revocation", () => {
		const revocationSourceVersion = 7;
		expect(isCurrentCredentialSource(7, revocationSourceVersion)).toBe(true);
		expect(isCurrentCredentialSource(8, revocationSourceVersion)).toBe(false);
	});
});
