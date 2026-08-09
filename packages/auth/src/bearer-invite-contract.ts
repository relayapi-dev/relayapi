export const BEARER_INVITE_SIGNUP_HEADER = "x-relayapi-bearer-invite";

export const BEARER_INVITE_TOKEN_PATTERN = /^rlay_inv_[0-9a-f]{48}$/;

export function isBearerInviteToken(value: unknown): value is string {
	return typeof value === "string" && BEARER_INVITE_TOKEN_PATTERN.test(value);
}
