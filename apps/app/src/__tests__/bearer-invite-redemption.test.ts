import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("dashboard bearer redemption keeps the auth session server-side and uses the SDK", () => {
	const route = readFileSync(
		fileURLToPath(
			new URL("../pages/api/invite-tokens/redeem.ts", import.meta.url),
		),
		"utf8",
	);
	expect(route).toContain("eq(session.id, currentSession.id)");
	expect(route).toContain("eq(session.userId, currentUser.id)");
	expect(route).toContain("gt(session.expiresAt, new Date())");
	expect(route).toContain("createRelayClient(");
	expect(route).toContain("client.inviteTokens.redeem");
	expect(route).toContain("rlay_session_");
	expect(route).toContain("liveSession.token");
	expect(route).not.toContain('fetch("/v1/');
});

test("bearer invite URLs do not enter the Better Auth invitation flow", () => {
	const page = readFileSync(
		fileURLToPath(new URL("../pages/invite/[id].astro", import.meta.url)),
		"utf8",
	);
	expect(page).toContain("const isBearerInvitation = isBearerInviteToken(id)");
	expect(page).toContain("<BearerInvitationPage");
	expect(page).toContain("<InvitationPage");
	const bearerPage = readFileSync(
		fileURLToPath(
			new URL(
				"../components/invitation/bearer-invitation-page.tsx",
				import.meta.url,
			),
		),
		"utf8",
	);
	expect(bearerPage).toContain("reserves this single-use invitation");
});

test("bearer invite signup remains closed without a capability and returns to redemption", () => {
	const signup = readFileSync(
		fileURLToPath(
			new URL("../components/auth/signup-form.tsx", import.meta.url),
		),
		"utf8",
	);
	expect(signup).toContain("if (!bearerInviteToken)");
	expect(signup).toContain("Hosted signup is invite-only");
	expect(signup).toContain("[BEARER_INVITE_SIGNUP_HEADER]: bearerInviteToken");
	expect(signup).toContain(
		"callbackURL: `/invite/" + "$" + "{bearerInviteToken}`",
	);
	expect(signup).toContain(
		"const destination = `/invite/" + "$" + "{bearerInviteToken}`",
	);
	expect(signup).toContain("href={invitedLoginHref}");
	expect(signup).toContain("/login?redirect=");
	expect(signup).not.toContain("signIn.social");
	const signupPage = readFileSync(
		fileURLToPath(new URL("../pages/signup.astro", import.meta.url)),
		"utf8",
	);
	expect(signupPage).toContain("isBearerInviteToken(requestedInviteToken)");
	expect(signupPage).toContain("inviteToken={inviteToken}");
});
