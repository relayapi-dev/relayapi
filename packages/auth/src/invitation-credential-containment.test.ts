import { describe, expect, test } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("Better Auth invitation authority containment", () => {
	test("keeps acceptance and membership grant in one adapter transaction", async () => {
		const auth = await Bun.file(
			`${repositoryRoot}packages/auth/src/index.ts`,
		).text();

		expect(auth).toContain("issuerCredentialVersion: {");
		expect(auth).toContain("input: false");
		expect(auth).toContain("returned: false");
		expect(auth).toContain(
			"organizationAuthPlugin.endpoints.acceptInvitation =",
		);
		expect(auth).toContain("fenceInvitationAcceptingSession(context)");
		expect(auth).toContain("protectedAcceptInvitationEndpoint");
		expect(auth).toContain("wrapEndpointInTransaction(");

		const fence = await Bun.file(
			`${repositoryRoot}packages/auth/src/invitation-redeemer-fence.ts`,
		).text();
		const userLock = fence.indexOf('model: "user"');
		const sessionLock = fence.indexOf('model: "session"');
		expect(userLock).toBeGreaterThan(-1);
		expect(sessionLock).toBeGreaterThan(userLock);
		expect(fence).toContain('field: "credentialVersion"');
		expect(fence).toContain('field: "token"');
		expect(fence).toContain('field: "expiresAt", operator: "gt"');
	});

	test("fences invitation creation and role updates with live actor authority", async () => {
		const auth = await Bun.file(
			`${repositoryRoot}packages/auth/src/index.ts`,
		).text();
		const fence = await Bun.file(
			`${repositoryRoot}packages/auth/src/organization-actor-fence.ts`,
		).text();

		expect(auth).toContain(
			'await fenceOrganizationMutationActor(context, "invite")',
		);
		expect(auth).toContain(
			'await fenceOrganizationMutationActor(context, "update-member-role")',
		);
		expect(auth).toContain(
			"organizationAuthPlugin.endpoints.createInvitation =",
		);
		expect(auth).toContain(
			"organizationAuthPlugin.endpoints.updateMemberRole =",
		);
		expect(auth).toContain(
			"wrapEndpointInTransaction(protectedCreateInvitationEndpoint)",
		);
		expect(auth).toContain(
			"wrapEndpointInTransaction(protectedUpdateMemberRoleEndpoint)",
		);
		expect(auth).toContain("lifecycleStatus: {");
		expect(auth).toContain("createPostCommitInvitationEmailSender(");
		expect(auth).toContain("queueAfterTransactionHook(async () =>");

		const userLock = fence.indexOf('model: "user"');
		const memberLock = fence.indexOf('model: "member"', userLock);
		const organizationLock = fence.indexOf('model: "organization"', memberLock);
		const sessionLock = fence.indexOf('model: "session"', organizationLock);
		expect(userLock).toBeGreaterThan(-1);
		expect(memberLock).toBeGreaterThan(userLock);
		expect(organizationLock).toBeGreaterThan(memberLock);
		expect(sessionLock).toBeGreaterThan(organizationLock);
		expect(fence).toContain("getAuthoritativeSessionFromCtx");
		expect(fence).toContain("[...lockableMembers.keys()].sort()");
	});
});
