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
	expect(page).toContain("const isBearerInvitation = /^rlay_inv_");
	expect(page).toContain("<BearerInvitationPage");
	expect(page).toContain("<InvitationPage");
});
