import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	canAssignOrganizationRole,
	higherOrganizationRole,
	highestOrganizationRole,
} from "../lib/organization-roles";
import {
	CreateInviteTokenBody,
	RedeemInviteTokenBody,
} from "../schemas/invite";

describe("invite-token authority", () => {
	test("role parsing handles Better Auth comma roles without escalation", () => {
		expect(highestOrganizationRole("member, admin")).toBe("admin");
		expect(highestOrganizationRole("unknown, member")).toBe("member");
		expect(canAssignOrganizationRole("member,admin", "owner")).toBe(false);
		expect(canAssignOrganizationRole("owner, admin", "owner")).toBe(true);
		expect(higherOrganizationRole("owner", "member")).toBe("owner");
		expect(higherOrganizationRole("member", "admin")).toBe("admin");
	});

	test("scope input rejects contradictory, empty, and duplicate grants", () => {
		expect(
			CreateInviteTokenBody.safeParse({
				scope_mode: "selected",
				role: "member",
			}).success,
		).toBe(false);
		expect(
			CreateInviteTokenBody.safeParse({
				scope_mode: "all",
				workspace_ids: ["ws_a"],
				role: "member",
			}).success,
		).toBe(false);
		expect(
			CreateInviteTokenBody.safeParse({
				scope_mode: "selected",
				workspace_ids: ["ws_a", "ws_a"],
				role: "member",
			}).success,
		).toBe(false);
		expect(
			CreateInviteTokenBody.safeParse({
				scope_mode: "selected",
				workspace_ids: ["ws_a"],
				role: "member",
			}).success,
		).toBe(true);
	});

	test("redeem accepts only full high-entropy bearer invite tokens", () => {
		expect(
			RedeemInviteTokenBody.safeParse({
				token: `rlay_inv_${"a".repeat(48)}`,
			}).success,
		).toBe(true);
		for (const token of [
			"inv_weak",
			`rlay_inv_${"a".repeat(47)}`,
			`rlay_inv_${"g".repeat(48)}`,
		]) {
			expect(RedeemInviteTokenBody.safeParse({ token }).success).toBe(false);
		}
		expect(
			RedeemInviteTokenBody.safeParse({
				token: `rlay_inv_${"a".repeat(48)}`,
				unexpected: true,
			}).success,
		).toBe(false);
	});

	test("redemption contains the body before its atomic authority changes", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../routes/invite-redeem.ts", import.meta.url)),
			"utf8",
		);
		const middlewareOrder = [
			"inviteIpRateLimit,",
			"inviteBodyPreflight,",
			"authenticateInviteRedeemer,",
			"invitePrincipalRateLimit,",
			"materializeInviteBody,",
		].map((needle) => source.indexOf(needle, source.indexOf("middleware: [")));
		expect(middlewareOrder.every((index) => index >= 0)).toBe(true);
		expect(middlewareOrder).toEqual([...middlewareOrder].sort((a, b) => a - b));
		expect(source).toContain("INVITE_REDEEM_MAX_BODY_BYTES = 4 * 1024");
		expect(source).toContain("preflightBoundedRequestBody(");
		expect(source).toContain("materializeBoundedRequestBody(");
		expect(source).toContain("seedBoundedRequestBody(c.req, bytes)");
		expect(source).toContain("required: true");
		expect(source).toContain("PAYLOAD_TOO_LARGE");
		expect(source).toContain("UNSUPPORTED_MEDIA_TYPE");
		expect(source).toContain(
			"invite-redeem-ip:" + "$" + "{digest.slice(0, 48)}",
		);
		expect(source).toContain("invite-redeem:" + "$" + "{identity.userId}");
		expect(source).toContain('"RATE_LIMITED"');
		expect(source).toContain("db.transaction(async (tx)");
		expect(source).toContain("pg_advisory_xact_lock");
		expect(source).toContain("canAssignOrganizationRole");
		expect(source).toContain('.for("update")');
		expect(source).toContain("isNull(inviteTokens.usedAt)");
		expect(source).toContain("gt(inviteTokens.expiresAt, redeemedAt)");
		expect(source).toContain("higherOrganizationRole");
		const consume = source.indexOf(
			".update(inviteTokens)",
			source.indexOf("// Consume before creating authority rows"),
		);
		expect(consume).toBeGreaterThan(-1);
		expect(source.indexOf("if (!existingMember)", consume)).toBeGreaterThan(
			consume,
		);
		expect(source.indexOf("if (!existingPrincipal)", consume)).toBeGreaterThan(
			consume,
		);
		expect(source).not.toContain('usedBy: generateId("prn_")');
	});

	test("redemption revalidates and locks the exact redeemer after a delayed body", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../routes/invite-redeem.ts", import.meta.url)),
			"utf8",
		);
		const transaction = source.indexOf("db.transaction(async (tx)");
		const redeemerFence = source.indexOf(
			"lockCurrentInviteRedeemer(tx, identity)",
			transaction,
		);
		const invitationLock = source.indexOf("const [invitation]", redeemerFence);
		const membershipWrite = source.indexOf(
			"if (!existingMember)",
			invitationLock,
		);

		expect(transaction).toBeGreaterThan(-1);
		expect(redeemerFence).toBeGreaterThan(transaction);
		expect(invitationLock).toBeGreaterThan(redeemerFence);
		expect(membershipWrite).toBeGreaterThan(invitationLock);
		expect(source).toContain('kind: "session"');
		expect(source).toContain("sessionId: identity.sessionId");
		expect(source).toContain("sessionToken: identity.sessionToken");
		expect(source).toContain('kind: "member_api_key"');
		expect(source).toContain("eq(apikey.id, identity.keyId)");
		expect(source).toContain("eq(apikey.key, identity.keyHash)");
		expect(source).toContain("eq(apikey.principalId, identity.principalId)");
		expect(source).toContain("identity.credentialVersion");
		expect(source).toContain("INVITE_REDEEMER_NO_LONGER_AUTHORIZED");
		expect(source).toContain("status: 401 as const");

		const authenticate = source.indexOf(
			"authenticateInviteRedeemer,",
			source.indexOf("middleware: ["),
		);
		const materialize = source.indexOf("materializeInviteBody,", authenticate);
		expect(materialize).toBeGreaterThan(authenticate);
	});

	test("mint captures selected workspace evidence under the same transaction", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../routes/invite.ts", import.meta.url)),
			"utf8",
		);
		const transaction = source.indexOf("db.transaction(async (tx)");
		const workspaceLock = source.indexOf('.for("share")', transaction);
		const tokenInsert = source.indexOf("tx.insert(inviteTokens)", transaction);
		expect(transaction).toBeGreaterThan(-1);
		expect(workspaceLock).toBeGreaterThan(transaction);
		expect(tokenInsert).toBeGreaterThan(workspaceLock);
		expect(source).toContain("existing.length !== body.workspace_ids.length");
	});
});
