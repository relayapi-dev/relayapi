import { LEGACY_CREDENTIAL_VERSION } from "@relayapi/db";

function normalizedCredentialVersion(value: string | null | undefined): string {
	return value || LEGACY_CREDENTIAL_VERSION;
}

/**
 * A durable invitation is valid only while the issuer remains in the same
 * credential generation. A ban rotates the user generation transactionally,
 * so the mismatch remains authoritative even after a temporary ban expires.
 */
export function isCurrentInviteIssuerCredential(params: {
	issuedCredentialVersion: string | null | undefined;
	liveCredentialVersion: string | null | undefined;
	banned: boolean | null;
	banExpires: Date | null;
	now?: Date;
}): boolean {
	const now = params.now ?? new Date();
	const activeBan =
		params.banned === true &&
		(params.banExpires === null || params.banExpires > now);
	return (
		!activeBan &&
		normalizedCredentialVersion(params.issuedCredentialVersion) ===
			normalizedCredentialVersion(params.liveCredentialVersion)
	);
}

export function currentInviteIssuerCredentialVersion(
	value: string | null | undefined,
): string {
	return normalizedCredentialVersion(value);
}
