const INVITE_SIGNUP_CLAIM_PREFIX = "signup-user:";

/** Stable, non-secret binding between a claimed bearer invite and one auth user. */
export function inviteSignupClaimForUser(userId: string): string {
	if (!userId)
		throw new Error("A user ID is required for an invite signup claim");
	return `${INVITE_SIGNUP_CLAIM_PREFIX}${userId}`;
}

export function isInviteSignupClaimForUser(
	claim: string | null | undefined,
	userId: string,
): boolean {
	return claim === inviteSignupClaimForUser(userId);
}
