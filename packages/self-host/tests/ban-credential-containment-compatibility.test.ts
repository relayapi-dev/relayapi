import { describe, expect, test } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host user-ban credential containment compatibility", () => {
	test("is migration-first, binding-neutral, and preserves service principals", async () => {
		const [
			identityRenderer,
			identityContracts,
			authMiddleware,
			apiKeys,
			inviteRedeem,
			invitationFence,
			organizationActorFence,
			authConfig,
			appMiddleware,
			wrangler,
		] = await Promise.all([
			Bun.file(
				`${repositoryRoot}packages/db/scripts/render-auth-identity-invariant-sql.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}packages/db/src/provisioning-contracts.ts`,
			).text(),
			Bun.file(`${repositoryRoot}apps/api/src/middleware/auth.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/routes/api-keys.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/routes/invite-redeem.ts`).text(),
			Bun.file(
				`${repositoryRoot}packages/auth/src/invitation-redeemer-fence.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}packages/auth/src/organization-actor-fence.ts`,
			).text(),
			Bun.file(`${repositoryRoot}packages/auth/src/index.ts`).text(),
			Bun.file(`${repositoryRoot}apps/app/src/middleware/index.ts`).text(),
			Bun.file(
				`${repositoryRoot}packages/self-host/src/wrangler-config.ts`,
			).text(),
		]);

		expect(identityContracts).toContain(
			'triggerName: "rotate_user_credential_version_on_ban"',
		);
		expect(identityContracts).toContain(
			'triggerName: "revoke_administrator_impersonation_sessions"',
		);
		expect(identityContracts).toContain(
			'triggerName: "revoke_derived_impersonation_on_session_delete"',
		);
		expect(identityRenderer).toContain(
			'NEW."credentialVersion" := gen_random_uuid()',
		);
		expect(identityRenderer).toContain("AFTER DELETE ON ${qualified(");
		expect(identityRenderer).toContain(
			'IF OLD."impersonatedBy" IS NOT NULL THEN',
		);
		expect(identityRenderer).toContain(
			'derived_impersonation_session."impersonatedBy" = OLD."userId"',
		);
		expect(identityContracts).toContain(
			'triggerName: "enforce_invitation_issuer_credential_generation"',
		);
		expect(identityContracts).toContain(
			'triggerName: "invalidate_member_invitation_authority"',
		);
		expect(identityContracts).toContain(
			'triggerName: "enforce_active_member_user_before_insert"',
		);
		expect(identityRenderer).toContain("SET status = 'canceled'");
		expect(identityRenderer).toContain("FOR UPDATE SKIP LOCKED");
		expect(identityRenderer).toContain(
			"members may only be added for active users",
		);
		expect(authMiddleware).toContain(
			"normalizedCredentialVersion(row.keyCredentialVersion)",
		);
		expect(authMiddleware).toContain('row.principalKind === "service"');
		expect(apiKeys).toContain("referenceId: null");
		expect(apiKeys).toContain("created_by_principal_id: createdByPrincipal");
		expect(apiKeys).not.toContain("credentialVersion: liveCredentialVersion");
		expect(inviteRedeem).toContain("lockCurrentInviteRedeemer(tx, identity)");
		expect(invitationFence).toContain('model: "user"');
		expect(invitationFence).toContain('model: "session"');
		expect(authConfig).toContain("fenceInvitationAcceptingSession(context)");
		expect(organizationActorFence).toContain("getAuthoritativeSessionFromCtx");
		expect(organizationActorFence).toContain(
			"[...lockableMembers.keys()].sort()",
		);
		expect(authConfig).toContain(
			'await fenceOrganizationMutationActor(context, "invite")',
		);
		expect(authConfig).toContain(
			'await fenceOrganizationMutationActor(context, "update-member-role")',
		);
		expect(appMiddleware).toContain('url.pathname.startsWith("/api/")');
		expect(appMiddleware).toContain('!url.pathname.startsWith("/api/auth/")');
		expect(appMiddleware).toContain(
			"disableCookieCache: requiresAuthoritativeSession(context.url)",
		);
		expect(wrangler).not.toContain("CREDENTIAL_VERSION");
	});
});
