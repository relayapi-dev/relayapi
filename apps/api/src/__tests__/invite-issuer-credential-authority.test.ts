import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isCurrentInviteIssuerCredential } from "../lib/invite-issuer-authority";

function source(path: string): string {
	return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

describe("invite issuer credential authority", () => {
	test("a ban remains a durable invitation fence after temporary expiry", () => {
		const now = new Date("2026-08-02T12:00:00.000Z");
		expect(
			isCurrentInviteIssuerCredential({
				issuedCredentialVersion: "legacy-v1",
				liveCredentialVersion: "legacy-v1",
				banned: false,
				banExpires: null,
				now,
			}),
		).toBe(true);
		expect(
			isCurrentInviteIssuerCredential({
				issuedCredentialVersion: "generation-1",
				liveCredentialVersion: "generation-1",
				banned: true,
				banExpires: new Date("2026-08-02T13:00:00.000Z"),
				now,
			}),
		).toBe(false);
		expect(
			isCurrentInviteIssuerCredential({
				issuedCredentialVersion: "generation-1",
				liveCredentialVersion: "generation-2",
				banned: true,
				banExpires: new Date("2026-08-02T11:00:00.000Z"),
				now,
			}),
		).toBe(false);
	});

	test("mint serializes with ban and role changes before persisting the live generation", () => {
		const route = source("../routes/invite.ts");
		const transaction = route.indexOf("db.transaction(async (tx)");
		const issuerLock = route.indexOf('.for("share")', transaction);
		const roleCheck = route.indexOf(
			"canAssignOrganizationRole(issuer.memberRole, body.role)",
			issuerLock,
		);
		const tokenInsert = route.indexOf("tx.insert(inviteTokens)", roleCheck);

		expect(transaction).toBeGreaterThan(-1);
		expect(issuerLock).toBeGreaterThan(transaction);
		expect(roleCheck).toBeGreaterThan(issuerLock);
		expect(tokenInsert).toBeGreaterThan(roleCheck);
		expect(route).toContain("keyCredentialVersion: apikey.credentialVersion");
		expect(route).toContain("userCredentialVersion: user.credentialVersion");
		expect(route).toContain(
			"issuerCredentialVersion: currentInviteIssuerCredentialVersion(",
		);
		expect(route).toContain("markMutationInputNotApplied(c)");
	});

	test("redemption locks and rechecks the issuer user generation before granting membership", () => {
		const route = source("../routes/invite-redeem.ts");
		const issuerRead = route.indexOf(
			"issuerCredentialVersion: inviteTokens.issuerCredentialVersion",
		);
		const userJoin = route.indexOf(
			".innerJoin(user, eq(user.id, member.userId))",
			issuerRead,
		);
		const issuerFence = route.indexOf(
			"issuedCredentialVersion: invitation.issuerCredentialVersion",
			userJoin,
		);
		const advisoryLock = route.indexOf("pg_advisory_xact_lock", issuerFence);

		expect(issuerRead).toBeGreaterThan(-1);
		expect(userJoin).toBeGreaterThan(issuerRead);
		expect(issuerFence).toBeGreaterThan(userJoin);
		expect(advisoryLock).toBeGreaterThan(issuerFence);
		expect(route).toContain('.for("update")');
	});
});
