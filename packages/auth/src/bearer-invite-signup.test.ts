import { describe, expect, test } from "bun:test";
import { runWithTransaction } from "@better-auth/core/context";
import {
	inviteSignupClaimForUser,
	isInviteSignupClaimForUser,
} from "@relayapi/db";
import { BEARER_INVITE_SIGNUP_HEADER } from "./bearer-invite-contract";
import {
	type BearerInviteSignupCandidate,
	bearerInviteTokenFromSignUpContext,
	claimBearerInviteForSignUpWithAdapter,
	claimLiveBearerInviteForSignUp,
	hashBearerInviteToken,
	isLiveBearerInviteSignupCandidate,
} from "./bearer-invite-signup";

const TOKEN = `rlay_inv_${"0".repeat(48)}`;
const TOKEN_HASH =
	"afff303d76ac152fea378852529ad795e338a24d1d911cf1fa0957e69e3686c4";
const NOW = new Date("2026-08-08T12:00:00.000Z");

type Where = Array<{
	field: string;
	operator?: string;
	value: unknown;
}>;

type UpdateInput = {
	model: string;
	update: Record<string, unknown>;
	where: Where;
};

type ClaimState = {
	usedAt: Date | null;
	usedBy: string | null;
};

function whereValue(where: Where, field: string): unknown {
	return where.find((condition) => condition.field === field)?.value;
}

function liveTransactionAdapter(options?: {
	claimState?: ClaimState;
	currentGeneration?: () => string;
	onUserLock?: () => Promise<void>;
	onWorkspaceLock?: () => Promise<void>;
	scopeMode?: "all" | "selected";
	updates?: UpdateInput[];
	workspaceStatus?: () => string;
}) {
	const claimState = options?.claimState ?? { usedAt: null, usedBy: null };
	const currentGeneration =
		options?.currentGeneration ?? (() => "generation_2");
	const workspaceStatus = options?.workspaceStatus ?? (() => "active");
	return {
		findOne: async ({ model }: { model: string; where: Where }) => {
			switch (model) {
				case "bearerInviteSignupClaim":
					return {
						id: "inv_1",
						organizationId: "org_1",
						createdBy: "user_issuer",
						createdByPrincipalId: "prn_issuer",
						issuerCredentialVersion: "generation_2",
						tokenHash: TOKEN_HASH,
						scopeMode: options?.scopeMode ?? "all",
						role: "admin",
						usedAt: claimState.usedAt,
						usedBy: claimState.usedBy,
						redeemedByUserId: null,
						expiresAt: new Date("2026-08-09T12:00:00.000Z"),
					};
				case "bearerInviteIssuerPrincipal":
					return {
						id: "prn_issuer",
						organizationId: "org_1",
						kind: "member",
						memberId: "member_issuer",
						lifecycleStatus: "active",
					};
				case "member":
					return {
						id: "member_issuer",
						organizationId: "org_1",
						userId: "user_issuer",
						role: "owner",
					};
				default:
					return null;
			}
		},
		findMany: async () =>
			options?.scopeMode === "selected"
				? [
						{
							organizationId: "org_1",
							inviteTokenId: "inv_1",
							workspaceId: "ws_1",
							scopeMode: "selected",
						},
					]
				: [],
		update: async (input: UpdateInput) => {
			options?.updates?.push(input);
			switch (input.model) {
				case "user": {
					await options?.onUserLock?.();
					const generation = currentGeneration();
					if (whereValue(input.where, "credentialVersion") !== generation) {
						return null;
					}
					return {
						id: "user_issuer",
						credentialVersion: generation,
						banned: false,
						banExpires: null,
					};
				}
				case "member":
					return {
						id: "member_issuer",
						organizationId: "org_1",
						userId: "user_issuer",
						role: "owner",
					};
				case "organization":
					return { id: "org_1", lifecycleStatus: "active" };
				case "bearerInviteIssuerPrincipal":
					return {
						id: "prn_issuer",
						organizationId: "org_1",
						kind: "member",
						memberId: "member_issuer",
						lifecycleStatus: "active",
					};
				case "bearerInviteWorkspace":
					await options?.onWorkspaceLock?.();
					return {
						id: "ws_1",
						organizationId: "org_1",
						lifecycleStatus: workspaceStatus(),
					};
				case "bearerInviteSignupClaim":
					if (claimState.usedAt || claimState.usedBy) return null;
					claimState.usedAt = input.update.usedAt as Date;
					claimState.usedBy = input.update.usedBy as string;
					return {
						id: "inv_1",
						usedAt: claimState.usedAt,
						usedBy: claimState.usedBy,
					};
				default:
					return null;
			}
		},
	} as never;
}

function liveCandidate(
	overrides: Partial<BearerInviteSignupCandidate> = {},
): BearerInviteSignupCandidate {
	return {
		createdBy: "user_issuer",
		expiresAt: new Date("2026-08-09T12:00:00.000Z"),
		issuerBanExpires: null,
		issuerBanned: false,
		issuerCredentialVersion: "generation_2",
		issuerLiveCredentialVersion: "generation_2",
		issuerLiveUserId: "user_issuer",
		issuerPrincipalStatus: "active",
		issuerRole: "owner",
		issuerUserId: "user_issuer",
		organizationStatus: "active",
		role: "admin",
		usedAt: null,
		workspaceScopeValid: true,
		...overrides,
	};
}

describe("bearer invitation signup admission", () => {
	test("accepts the capability only on the email signup endpoint", () => {
		const headers = new Headers({ [BEARER_INVITE_SIGNUP_HEADER]: TOKEN });
		expect(
			bearerInviteTokenFromSignUpContext({
				path: "/sign-up/email",
				request: { headers },
			}),
		).toBe(TOKEN);
		expect(
			bearerInviteTokenFromSignUpContext({
				path: "/callback/google",
				request: { headers },
			}),
		).toBeNull();
		expect(
			bearerInviteTokenFromSignUpContext({
				path: "/sign-up/email",
				headers: new Headers({
					[BEARER_INVITE_SIGNUP_HEADER]: "rlay_inv_not-a-capability",
				}),
			}),
		).toBeNull();
	});

	test("hashes the capability before lookup", async () => {
		expect(await hashBearerInviteToken(TOKEN)).toBe(TOKEN_HASH);
	});

	test("accepts an unconsumed, unexpired invitation with live authority", () => {
		expect(isLiveBearerInviteSignupCandidate(liveCandidate(), NOW)).toBe(true);
	});

	test("atomically binds one token to only one of two different-email signups", async () => {
		const claimState: ClaimState = { usedAt: null, usedBy: null };
		const adapter = liveTransactionAdapter({ claimState });
		const signupAttempts = [
			{ email: "first@example.com", userId: "user_first" },
			{ email: "second@example.com", userId: "user_second" },
		] as const;
		const results = await Promise.all(
			signupAttempts.map(({ userId }) =>
				claimBearerInviteForSignUpWithAdapter(adapter, TOKEN_HASH, userId, NOW),
			),
		);

		expect(results.filter(Boolean)).toHaveLength(1);
		const winner = results[0] ? signupAttempts[0] : signupAttempts[1];
		const loser = results[0] ? signupAttempts[1] : signupAttempts[0];
		expect(winner.email).not.toBe(loser.email);
		expect(claimState.usedBy).not.toBeNull();
		const recordedClaim = String(claimState.usedBy);
		expect(recordedClaim).toBe(inviteSignupClaimForUser(winner.userId));
		expect(isInviteSignupClaimForUser(recordedClaim, winner.userId)).toBe(true);
		expect(isInviteSignupClaimForUser(recordedClaim, loser.userId)).toBe(false);
	});

	test("rejects a generation rotation committed after discovery but before the issuer lock", async () => {
		let generation = "generation_2";
		let releaseUserLock = () => {};
		const userLockRelease = new Promise<void>((resolve) => {
			releaseUserLock = resolve;
		});
		let signalUserLock = () => {};
		const userLockStarted = new Promise<void>((resolve) => {
			signalUserLock = resolve;
		});
		const updates: UpdateInput[] = [];
		const claimState: ClaimState = { usedAt: null, usedBy: null };
		const adapter = liveTransactionAdapter({
			claimState,
			currentGeneration: () => generation,
			onUserLock: async () => {
				signalUserLock();
				await userLockRelease;
			},
			updates,
		});

		const signup = claimBearerInviteForSignUpWithAdapter(
			adapter,
			TOKEN_HASH,
			"user_signup",
			NOW,
		);
		await userLockStarted;
		generation = "generation_3";
		releaseUserLock();

		expect(await signup).toBe(false);
		expect(claimState).toEqual({ usedAt: null, usedBy: null });
		expect(updates.map((update) => update.model)).toEqual(["user"]);
	});

	test("locks all live authority before the token claim", async () => {
		const updates: UpdateInput[] = [];
		const adapter = liveTransactionAdapter({ updates });
		expect(
			await claimBearerInviteForSignUpWithAdapter(
				adapter,
				TOKEN_HASH,
				"user_signup",
				NOW,
			),
		).toBe(true);
		expect(updates.map((update) => update.model)).toEqual([
			"user",
			"member",
			"organization",
			"bearerInviteIssuerPrincipal",
			"bearerInviteSignupClaim",
		]);
	});

	test("rejects a selected-scope invite when its workspace deactivates before the lock", async () => {
		let workspaceLifecycle = "active";
		let releaseWorkspaceLock = () => {};
		const workspaceLockRelease = new Promise<void>((resolve) => {
			releaseWorkspaceLock = resolve;
		});
		let signalWorkspaceLock = () => {};
		const workspaceLockStarted = new Promise<void>((resolve) => {
			signalWorkspaceLock = resolve;
		});
		const updates: UpdateInput[] = [];
		const adapter = liveTransactionAdapter({
			onWorkspaceLock: async () => {
				signalWorkspaceLock();
				await workspaceLockRelease;
			},
			scopeMode: "selected",
			updates,
			workspaceStatus: () => workspaceLifecycle,
		});
		const signup = claimBearerInviteForSignUpWithAdapter(
			adapter,
			TOKEN_HASH,
			"user_signup",
			NOW,
		);
		await workspaceLockStarted;
		workspaceLifecycle = "archived";
		releaseWorkspaceLock();

		expect(await signup).toBe(false);
		expect(updates.map((update) => update.model)).toEqual([
			"user",
			"member",
			"organization",
			"bearerInviteIssuerPrincipal",
			"bearerInviteWorkspace",
		]);
	});

	test("rolls the token claim back when later signup work fails", async () => {
		const durableClaim: ClaimState = { usedAt: null, usedBy: null };
		const baseAdapter = {
			transaction: async (callback: (adapter: never) => Promise<unknown>) => {
				const stagedClaim = { ...durableClaim };
				const result = await callback(
					liveTransactionAdapter({ claimState: stagedClaim }),
				);
				durableClaim.usedAt = stagedClaim.usedAt;
				durableClaim.usedBy = stagedClaim.usedBy;
				return result;
			},
		} as never;

		await expect(
			runWithTransaction(baseAdapter, async () => {
				expect(
					await claimLiveBearerInviteForSignUp(
						TOKEN,
						"user_signup",
						{ context: { adapter: baseAdapter } },
						NOW,
					),
				).toBe(true);
				throw new Error("account insert failed");
			}),
		).rejects.toThrow("account insert failed");
		expect(durableClaim).toEqual({ usedAt: null, usedBy: null });
	});

	test("rejects used and expired invitations", () => {
		expect(
			isLiveBearerInviteSignupCandidate(
				liveCandidate({ usedAt: new Date("2026-08-08T11:00:00.000Z") }),
				NOW,
			),
		).toBe(false);
		expect(
			isLiveBearerInviteSignupCandidate(liveCandidate({ expiresAt: NOW }), NOW),
		).toBe(false);
	});

	test("rejects inactive tenants, principals, or changed issuer authority", () => {
		for (const candidate of [
			liveCandidate({ organizationStatus: "deleting" }),
			liveCandidate({ issuerPrincipalStatus: "revoked" }),
			liveCandidate({ issuerUserId: "user_other" }),
			liveCandidate({ issuerLiveUserId: "user_other" }),
			liveCandidate({ issuerLiveCredentialVersion: "generation_3" }),
			liveCandidate({ issuerBanned: true }),
			liveCandidate({ issuerRole: "admin", role: "owner" }),
			liveCandidate({ workspaceScopeValid: false }),
		]) {
			expect(isLiveBearerInviteSignupCandidate(candidate, NOW)).toBe(false);
		}
	});

	test("accepts an elapsed temporary ban only when the generation still matches", () => {
		expect(
			isLiveBearerInviteSignupCandidate(
				liveCandidate({
					issuerBanned: true,
					issuerBanExpires: new Date("2026-08-08T11:59:59.000Z"),
				}),
				NOW,
			),
		).toBe(true);
	});
});
