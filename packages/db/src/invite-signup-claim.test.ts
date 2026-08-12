import { describe, expect, test } from "bun:test";
import {
	inviteSignupClaimForUser,
	isInviteSignupClaimForUser,
} from "./invite-signup-claim";

describe("bearer invite signup claim", () => {
	test("binds the claim to exactly one auth user", () => {
		const claim = inviteSignupClaimForUser("user_winner");
		expect(claim).toBe("signup-user:user_winner");
		expect(isInviteSignupClaimForUser(claim, "user_winner")).toBe(true);
		expect(isInviteSignupClaimForUser(claim, "user_loser")).toBe(false);
	});

	test("rejects an empty user identifier", () => {
		expect(() => inviteSignupClaimForUser("")).toThrow("A user ID is required");
	});
});
