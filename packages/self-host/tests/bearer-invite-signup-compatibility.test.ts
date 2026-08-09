import { describe, expect, test } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host bearer-invite signup compatibility", () => {
	test("ships the transactional single-use claim and same-user redemption path", async () => {
		const [authConfig, signupClaim, inviteRedeem, appMiddleware, readme] =
			await Promise.all([
				Bun.file(`${repositoryRoot}packages/auth/src/index.ts`).text(),
				Bun.file(
					`${repositoryRoot}packages/auth/src/bearer-invite-signup.ts`,
				).text(),
				Bun.file(
					`${repositoryRoot}apps/api/src/routes/invite-redeem.ts`,
				).text(),
				Bun.file(`${repositoryRoot}apps/app/src/middleware/index.ts`).text(),
				Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
			]);

		expect(appMiddleware).toContain("requireInvitationForSignUp: true");
		expect(authConfig).toContain("bearerInviteSignupClaimPlugin");
		expect(authConfig).toContain("claimLiveBearerInviteForSignUp(");
		expect(signupClaim).toContain("getCurrentAdapter(fallbackAdapter)");
		expect(signupClaim).toContain('model: "bearerInviteSignupClaim"');
		expect(signupClaim).toContain('model: "user"');
		expect(signupClaim).toContain('model: "member"');
		expect(signupClaim).toContain('model: "organization"');
		expect(signupClaim).toContain('model: "bearerInviteIssuerPrincipal"');
		expect(signupClaim).toContain('model: "bearerInviteWorkspace"');
		expect(signupClaim).toContain('{ field: "usedAt", value: null }');
		expect(inviteRedeem).toContain("inviteSignupClaimForUser(identity.userId)");
		expect(inviteRedeem).toContain("invitation.usedBy === signupClaim");
		expect(inviteRedeem).toContain("isNull(inviteTokens.redeemedByUserId)");
		expect(readme).toMatch(/A later signup failure rolls the claim\s+back/);
	});
});
