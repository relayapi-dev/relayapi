import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appRoot = resolve(import.meta.dir, "../..");
const repoRoot = resolve(appRoot, "../..");

function readRepoSource(relativePath: string): string {
	return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("production authentication security contract", () => {
	it("enforces invitations for direct email and first-time OAuth identities", () => {
		const middlewareSource = readRepoSource("apps/app/src/middleware/index.ts");
		const authSource = readRepoSource("packages/auth/src/index.ts");
		const bearerInviteSource = readRepoSource(
			"packages/auth/src/bearer-invite-signup.ts",
		);

		expect(middlewareSource).toContain("requireInvitationForSignUp: true");
		expect(authSource).toMatch(/lower\(\$\{invitation\.email\}\)/);
		expect(authSource).toMatch(/\$\{invitation\.status\} = 'pending'/);
		expect(authSource).toMatch(/\$\{invitation\.expiresAt\} > now\(\)/);
		expect(authSource).toContain('code: "INVITATION_REQUIRED"');
		expect(authSource).toContain("bearerInviteTokenFromSignUpContext(context)");
		expect(authSource).toContain("claimLiveBearerInviteForSignUp(");
		expect(bearerInviteSource).toContain(
			'authContext?.path !== "/sign-up/email"',
		);
		expect(bearerInviteSource).toContain("crypto.subtle.digest(");
		expect(bearerInviteSource).toContain(
			'{ field: "tokenHash", value: tokenHash }',
		);
		expect(bearerInviteSource).toContain("candidate.usedAt");
		expect(bearerInviteSource).toContain("candidate.expiresAt <= now");
		expect(bearerInviteSource).toContain("!candidate.workspaceScopeValid");
		expect(bearerInviteSource).toContain('model: "bearerInviteSignupClaim"');
		expect(bearerInviteSource).toContain('model: "user"');
		expect(bearerInviteSource).toContain('model: "member"');
		expect(bearerInviteSource).toContain('model: "organization"');
		expect(bearerInviteSource).toContain('model: "bearerInviteWorkspace"');
		expect(bearerInviteSource).toContain('{ field: "usedAt", value: null }');
		expect(bearerInviteSource).toContain("inviteSignupClaimForUser(userId)");
		expect(bearerInviteSource).not.toContain("console.");
	});

	it("uses an atomic shared limiter and the trusted Cloudflare client IP", () => {
		const authSource = readRepoSource("packages/auth/src/index.ts");

		expect(authSource).toContain("customStorage: createRateLimitStorage(db)");
		expect(authSource).toContain("pg_advisory_xact_lock");
		expect(authSource).toContain('crypto.subtle.digest("SHA-256"');
		expect(authSource).not.toMatch(
			/`\$\{RATE_LIMIT_IDENTIFIER_PREFIX\}\$\{key\}`/,
		);
		expect(authSource).toContain('ipAddressHeaders: ["cf-connecting-ip"]');
		expect(authSource).toContain('"/sign-in/email": { window: 60, max: 5 }');
		expect(authSource).toContain(
			'"/request-password-reset": { window: 60, max: 3 }',
		);
	});

	it("requires verified hosted email and explicitly gates self-host email flows", () => {
		const middlewareSource = readRepoSource("apps/app/src/middleware/index.ts");
		const authSource = readRepoSource("packages/auth/src/index.ts");

		expect(middlewareSource).toContain(
			'selfHosted && cfEnv.SELF_HOSTED_FEATURE_EMAIL === "1"',
		);
		expect(middlewareSource).toContain(
			"requireEmailVerification: !selfHosted || selfHostedEmailEnabled",
		);
		expect(middlewareSource).toMatch(
			/sendAccountEmail:\s*!selfHosted \|\| selfHostedEmailEnabled\s*\? createAccountEmailSender\(cfEnv\)\s*:\s*undefined/,
		);
		expect(middlewareSource).toMatch(
			/sendInvitationEmail:\s*!selfHosted \|\| selfHostedEmailEnabled\s*\? createInvitationEmailSender\(cfEnv\)\s*:\s*undefined/,
		);
		expect(authSource).toContain("sendResetPassword:");
		expect(authSource).toContain("revokeSessionsOnPasswordReset: true");
		expect(authSource).toContain("sendVerificationEmail:");
		expect(authSource).toContain("sendDeleteAccountVerification:");
		expect(middlewareSource).toContain(
			"await createEmailIntentClient(cfEnv.EMAIL_INTENTS).stage({",
		);
		expect(middlewareSource).not.toContain("waitUntil(delivery)");
	});

	it("replaces Better Auth's split identity deletes with one atomic operation", () => {
		const authSource = readRepoSource("packages/auth/src/index.ts");
		const middlewareSource = readRepoSource("apps/app/src/middleware/index.ts");

		expect(authSource).toContain("const interceptIdentityDelete");
		expect(authSource).toContain('"/admin/remove-user"');
		expect(authSource).toContain(
			"interceptIdentityDelete(deletingSession.userId",
		);
		expect(authSource).toContain(
			"interceptIdentityDelete(deletingAccount.userId",
		);
		expect(authSource).toContain("interceptIdentityDelete(deletingUser.id");
		expect(middlewareSource).toContain("deleteUserAtomically:");
	});

	it("serializes the actual owner delete or demotion in PostgreSQL", () => {
		const migration = readRepoSource(
			"packages/db/scripts/render-auth-identity-invariant-sql.ts",
		);

		expect(migration).toContain("pg_advisory_xact_lock(hashtext(");
		expect(migration).toContain("member -> advisory -> organization");
		expect(migration).toContain(
			'BEFORE INSERT OR DELETE OR UPDATE OF "role", "organizationId"',
		);
		expect(migration).toContain(
			"an active organization must retain at least one owner",
		);
		expect(migration).toContain(
			"members may only be added to active organizations",
		);
		expect(migration).toContain(
			"SET lifecycle_status = organization_row.lifecycle_status",
		);
		expect(migration).toContain("UPDATE auth.apikey");
		expect(migration).toContain("UPDATE auth.session");
		expect(migration).toContain(
			`CREATE CONSTRAINT TRIGGER \${identifier(activeOwner.triggerName)}`,
		);
		expect(
			readRepoSource("packages/db/src/provisioning-contracts.ts"),
		).toContain("enforce_active_organization_owner_at_commit");
		expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
	});

	it("revokes member credentials only after a successful removal", () => {
		const authSource = readRepoSource("packages/auth/src/index.ts");
		const leavePlugin = authSource.slice(
			authSource.indexOf("const membershipLeaveRevocationPlugin"),
			authSource.indexOf("const authoritativeAdminSessionPlugin"),
		);

		expect(authSource).toContain("afterRemoveMember: async");
		expect(authSource).toContain("membershipStillExists.length > 0");
		expect(leavePlugin).toMatch(/after:\s*\[/);
		expect(leavePlugin).not.toMatch(/before:\s*\[/);
	});

	it("creates the organization and initial owner in one adapter transaction", () => {
		const authSource = readRepoSource("packages/auth/src/index.ts");

		expect(authSource).toContain("transaction: true");
		expect(authSource).toContain("wrapEndpointInTransaction(");
		expect(authSource).not.toContain("afterCreateOrganization: async");
	});

	it("does not log raw remote-proxy exceptions", () => {
		const middlewareSource = readRepoSource("apps/app/src/middleware/index.ts");

		expect(middlewareSource).toContain(
			'event: "remote_dashboard_proxy_failed"',
		);
		expect(middlewareSource).not.toContain(
			'console.error("Remote dashboard proxy failed", error)',
		);
	});

	it("bypasses cached sessions for privileged pages and every internal API action", () => {
		const middlewareSource = readRepoSource("apps/app/src/middleware/index.ts");
		const authSource = readRepoSource("packages/auth/src/index.ts");

		expect(middlewareSource).toContain('url.pathname.startsWith("/app/admin")');
		expect(middlewareSource).toContain('url.pathname.startsWith("/api/")');
		expect(middlewareSource).toContain(
			'!url.pathname.startsWith("/api/auth/")',
		);
		expect(middlewareSource).toContain(
			"disableCookieCache: requiresAuthoritativeSession(context.url)",
		);
		expect(authSource).toContain("getAuthoritativeSessionFromCtx(context)");
		expect(authSource).toContain('roles.includes("admin")');
	});

	it("treats signed session cookies as a cache bound to the live user generation", () => {
		const middlewareSource = readRepoSource("apps/app/src/middleware/index.ts");
		const banCleanupSource = readRepoSource(
			"apps/app/src/lib/dashboard-user-ban.ts",
		);

		expect(middlewareSource).toContain("resolvedFromCookieCache");
		expect(middlewareSource).toContain("authUser.credentialVersion");
		expect(middlewareSource).toContain("hasActiveBan(liveUser)");
		expect(middlewareSource).toContain("cachedCredentialVersion");
		expect(middlewareSource).toContain("afterUserBanned: ({ userId })");
		expect(banCleanupSource).toContain("enabled: false");
		expect(banCleanupSource).toContain("attributable_service_key_ids");
	});

	it("keeps framework disclosure off and ships edge security headers", () => {
		const docsConfig = readRepoSource("apps/docs/next.config.mjs");
		const docsMiddleware = readRepoSource("apps/docs/src/middleware.ts");
		const appHeaders = readRepoSource("apps/app/src/lib/security-headers.ts");
		const appMiddleware = readRepoSource("apps/app/src/middleware/index.ts");

		expect(docsConfig).toContain("poweredByHeader: false");
		for (const header of [
			"Strict-Transport-Security",
			"Content-Security-Policy",
			"X-Content-Type-Options",
			"Permissions-Policy",
		]) {
			expect(docsConfig).toContain(header);
			expect(appHeaders).toContain(header);
		}
		expect(appMiddleware).toContain(
			"cfEnv.BETTER_AUTH_URL?.trim() || DEFAULT_PRODUCTION_APP_ORIGIN",
		);
		expect(appMiddleware).toMatch(
			/`\$\{productionAppOrigin\}\$\{context\.url\.pathname\}\$\{context\.url\.search\}`/,
		);
		expect(docsMiddleware).toMatch(
			/`\$\{PRODUCTION_DOCS_ORIGIN\}\$\{request\.nextUrl\.pathname\}\$\{request\.nextUrl\.search\}`/,
		);
	});
});
