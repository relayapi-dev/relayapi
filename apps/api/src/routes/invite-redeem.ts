import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
	apikey,
	generateId,
	inviteSignupClaimForUser,
	inviteTokens,
	inviteTokenWorkspaces,
	LEGACY_CREDENTIAL_VERSION,
	member,
	organization,
	organizationPrincipals,
	principalWorkspaceGrants,
	session,
	user,
	workspaces,
} from "@relayapi/db";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import {
	materializeBoundedRequestBody,
	preflightBoundedRequestBody,
	seedBoundedRequestBody,
	UnsupportedRequestMediaTypeError,
} from "../lib/bounded-request-body";
import { sha256Hex } from "../lib/durable-operation";
import { ResponseTooLargeError } from "../lib/fetch-public-url";
import { isCurrentInviteIssuerCredential } from "../lib/invite-issuer-authority";
import {
	canAssignOrganizationRole,
	higherOrganizationRole,
	type OrganizationRole,
} from "../lib/organization-roles";
import { getRequestDb } from "../lib/request-db";
import { hashKey } from "../middleware/auth";
import { ErrorResponse } from "../schemas/common";
import {
	RedeemInviteTokenBody,
	RedeemInviteTokenResponse,
} from "../schemas/invite";
import type { Env, Variables } from "../types";

type InviteRouteVariables = Variables & {
	inviteRedeemer: InviteRedeemer;
	inviteDb: ReturnType<typeof getRequestDb>;
};
type InviteRouteEnv = { Bindings: Env; Variables: InviteRouteVariables };
type InviteContext = Context<InviteRouteEnv>;

const app = new OpenAPIHono<InviteRouteEnv>();
const SESSION_BEARER_PREFIX = "rlay_session_";
const API_KEY_PREFIXES = ["rlay_live_", "rlay_test_"] as const;
export const INVITE_REDEEM_MAX_BODY_BYTES = 4 * 1024;
const INVITE_REDEEM_MEDIA_TYPES = ["application/json"] as const;

type InviteRedeemer =
	| {
			kind: "session";
			userId: string;
			credentialVersion: string;
			sessionId: string;
			sessionToken: string;
	  }
	| {
			kind: "member_api_key";
			userId: string;
			credentialVersion: string;
			keyId: string;
			keyHash: string;
			principalId: string;
	  };

function normalizedCredentialVersion(value: string | null | undefined): string {
	return value || LEGACY_CREDENTIAL_VERSION;
}

async function hashInviteToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function authenticateRedeemer(
	db: ReturnType<typeof getRequestDb>,
	authorization: string | undefined,
): Promise<InviteRedeemer | null> {
	if (!authorization?.startsWith("Bearer ")) return null;
	const bearer = authorization.slice(7);
	const now = new Date();

	if (bearer.startsWith(SESSION_BEARER_PREFIX)) {
		const sessionToken = bearer.slice(SESSION_BEARER_PREFIX.length);
		if (!sessionToken) return null;
		const [identity] = await db
			.select({
				userId: session.userId,
				sessionId: session.id,
				sessionToken: session.token,
				credentialVersion: user.credentialVersion,
			})
			.from(session)
			.innerJoin(user, eq(user.id, session.userId))
			.where(
				and(
					eq(session.token, sessionToken),
					gt(session.expiresAt, now),
					sql`(${user.banned} IS DISTINCT FROM TRUE OR ${user.banExpires} <= ${now})`,
				),
			)
			.limit(1);
		return identity
			? {
					kind: "session",
					userId: identity.userId,
					credentialVersion: normalizedCredentialVersion(
						identity.credentialVersion,
					),
					sessionId: identity.sessionId,
					sessionToken: identity.sessionToken,
				}
			: null;
	}

	if (!API_KEY_PREFIXES.some((prefix) => bearer.startsWith(prefix))) {
		return null;
	}
	const keyHash = await hashKey(bearer);
	const [identity] = await db
		.select({
			userId: member.userId,
			keyId: apikey.id,
			keyCredentialVersion: apikey.credentialVersion,
			principalId: organizationPrincipals.id,
		})
		.from(apikey)
		.innerJoin(
			organization,
			and(
				eq(organization.id, apikey.organizationId),
				eq(organization.lifecycleStatus, "active"),
			),
		)
		.innerJoin(
			organizationPrincipals,
			and(
				eq(organizationPrincipals.id, apikey.principalId),
				eq(organizationPrincipals.organizationId, apikey.organizationId),
				eq(organizationPrincipals.kind, "member"),
				eq(organizationPrincipals.lifecycleStatus, "active"),
			),
		)
		.innerJoin(
			member,
			and(
				eq(member.id, organizationPrincipals.memberId),
				eq(member.organizationId, organizationPrincipals.organizationId),
			),
		)
		.innerJoin(user, eq(user.id, member.userId))
		.where(
			and(
				eq(apikey.key, keyHash),
				eq(apikey.enabled, true),
				or(isNull(apikey.expiresAt), gt(apikey.expiresAt, now)),
				sql`(${user.banned} IS DISTINCT FROM TRUE OR ${user.banExpires} <= ${now})`,
				sql`COALESCE(${apikey.credentialVersion}, ${LEGACY_CREDENTIAL_VERSION}) = COALESCE(${user.credentialVersion}, ${LEGACY_CREDENTIAL_VERSION})`,
			),
		)
		.limit(1);
	return identity
		? {
				kind: "member_api_key",
				userId: identity.userId,
				credentialVersion: normalizedCredentialVersion(
					identity.keyCredentialVersion,
				),
				keyId: identity.keyId,
				keyHash,
				principalId: identity.principalId,
			}
		: null;
}

/**
 * Authentication happens before the bounded body is materialized, so a caller
 * can keep the request stream open while an administrator bans the redeemer.
 * Fence the redeemer's credential generation first, then revalidate and lock
 * the exact session or member-bound API key. The ban path updates the user row
 * before deleting sessions, which gives both operations the same user ->
 * credential lock order and keeps the grant transaction linearizable.
 */
async function lockCurrentInviteRedeemer(
	tx: Parameters<
		Parameters<ReturnType<typeof getRequestDb>["transaction"]>[0]
	>[0],
	identity: InviteRedeemer,
): Promise<boolean> {
	const [liveUser] = await tx
		.select({
			id: user.id,
			banned: user.banned,
			banExpires: user.banExpires,
			credentialVersion: user.credentialVersion,
		})
		.from(user)
		.where(eq(user.id, identity.userId))
		.for("share")
		.limit(1);
	const now = new Date();
	if (
		!liveUser ||
		(liveUser.banned === true &&
			(liveUser.banExpires === null || liveUser.banExpires > now)) ||
		normalizedCredentialVersion(liveUser.credentialVersion) !==
			identity.credentialVersion
	) {
		return false;
	}

	if (identity.kind === "session") {
		const [liveSession] = await tx
			.select({ id: session.id })
			.from(session)
			.where(
				and(
					eq(session.id, identity.sessionId),
					eq(session.token, identity.sessionToken),
					eq(session.userId, identity.userId),
					gt(session.expiresAt, now),
				),
			)
			.for("share")
			.limit(1);
		return Boolean(liveSession);
	}

	const [liveKey] = await tx
		.select({ id: apikey.id })
		.from(apikey)
		.innerJoin(
			organizationPrincipals,
			and(
				eq(organizationPrincipals.id, apikey.principalId),
				eq(organizationPrincipals.organizationId, apikey.organizationId),
				eq(organizationPrincipals.kind, "member"),
				eq(organizationPrincipals.lifecycleStatus, "active"),
			),
		)
		.innerJoin(
			member,
			and(
				eq(member.id, organizationPrincipals.memberId),
				eq(member.organizationId, organizationPrincipals.organizationId),
				eq(member.userId, identity.userId),
			),
		)
		.where(
			and(
				eq(apikey.id, identity.keyId),
				eq(apikey.key, identity.keyHash),
				eq(apikey.principalId, identity.principalId),
				eq(apikey.referenceId, identity.userId),
				eq(apikey.enabled, true),
				or(isNull(apikey.expiresAt), gt(apikey.expiresAt, now)),
				sql`COALESCE(${apikey.credentialVersion}, ${LEGACY_CREDENTIAL_VERSION}) = ${identity.credentialVersion}`,
			),
		)
		.for("share")
		.limit(1);
	return Boolean(liveKey);
}

function unauthorized(c: InviteContext) {
	return c.json(
		{
			error: {
				code: "UNAUTHORIZED",
				message: "A current user session is required to redeem an invitation",
			},
		},
		401,
	);
}

function payloadTooLarge(c: InviteContext) {
	return c.json(
		{
			error: {
				code: "PAYLOAD_TOO_LARGE",
				message: "The request body is too large",
			},
		},
		413,
	);
}

function unsupportedMediaType(c: InviteContext) {
	return c.json(
		{
			error: {
				code: "UNSUPPORTED_MEDIA_TYPE",
				message: "The request media type is not supported",
			},
		},
		415,
	);
}

function rateLimited(c: InviteContext) {
	c.header("Retry-After", "60");
	return c.json(
		{
			error: {
				code: "RATE_LIMITED",
				message: "Too many invitation redemption attempts. Try again shortly.",
			},
		},
		429,
	);
}

const inviteIpRateLimit: MiddlewareHandler<InviteRouteEnv> = createMiddleware(
	async (c, next) => {
		const connectingIp = c.req.header("CF-Connecting-IP")?.trim() || "local";
		const digest = await sha256Hex(
			`invite-redeem-ip-rate-limit:v1:${connectingIp}`,
		);
		const { success } = await c.env.FREE_RATE_LIMITER.limit({
			key: `invite-redeem-ip:${digest.slice(0, 48)}`,
		});
		if (!success) return rateLimited(c);
		await next();
	},
);

const inviteBodyPreflight: MiddlewareHandler<InviteRouteEnv> = createMiddleware(
	async (c, next) => {
		try {
			preflightBoundedRequestBody(
				c.req.raw,
				INVITE_REDEEM_MAX_BODY_BYTES,
				INVITE_REDEEM_MEDIA_TYPES,
			);
		} catch (error) {
			if (error instanceof ResponseTooLargeError) return payloadTooLarge(c);
			if (error instanceof UnsupportedRequestMediaTypeError) {
				return unsupportedMediaType(c);
			}
			throw error;
		}
		await next();
	},
);

const authenticateInviteRedeemer: MiddlewareHandler<InviteRouteEnv> =
	createMiddleware(async (c, next) => {
		const authorization = c.req.header("Authorization");
		// Do not create a database client or consume an unknown-length body for an
		// obviously unauthenticated request.
		if (!authorization?.startsWith("Bearer ")) return unauthorized(c);
		const db = getRequestDb(c.env);
		const identity = await authenticateRedeemer(db, authorization);
		if (!identity) return unauthorized(c);
		c.set("inviteDb", db);
		c.set("inviteRedeemer", identity);
		await next();
	});

const invitePrincipalRateLimit: MiddlewareHandler<InviteRouteEnv> =
	createMiddleware(async (c, next) => {
		const identity = c.get("inviteRedeemer");
		const { success } = await c.env.FREE_RATE_LIMITER.limit({
			key: `invite-redeem:${identity.userId}`,
		});
		if (!success) return rateLimited(c);
		await next();
	});

const materializeInviteBody: MiddlewareHandler<InviteRouteEnv> =
	createMiddleware(async (c, next) => {
		try {
			const bytes = await materializeBoundedRequestBody(
				c.req.raw,
				INVITE_REDEEM_MAX_BODY_BYTES,
			);
			seedBoundedRequestBody(c.req, bytes);
		} catch (error) {
			if (error instanceof ResponseTooLargeError) return payloadTooLarge(c);
			throw error;
		}
		await next();
	});

const redeemInviteToken = createRoute({
	operationId: "redeemInviteToken",
	method: "post",
	path: "/redeem",
	tags: ["Invite Tokens"],
	summary: "Redeem a bearer invitation",
	description:
		"Authenticated, rate-limited redemption atomically consumes the bearer token, creates or upgrades membership, resolves a stable member principal, and applies its workspace grants.",
	security: [{ Bearer: [] }],
	middleware: [
		inviteIpRateLimit,
		inviteBodyPreflight,
		authenticateInviteRedeemer,
		invitePrincipalRateLimit,
		materializeInviteBody,
	],
	request: {
		body: {
			content: { "application/json": { schema: RedeemInviteTokenBody } },
			required: true,
		},
	},
	responses: {
		200: {
			description: "Invitation redeemed",
			content: {
				"application/json": { schema: RedeemInviteTokenResponse },
			},
		},
		400: {
			description: "Invalid invitation",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Authentication required",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Issuer or invitation authority is no longer valid",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Invitation already consumed",
			content: { "application/json": { schema: ErrorResponse } },
		},
		410: {
			description: "Invitation expired",
			content: { "application/json": { schema: ErrorResponse } },
		},
		413: {
			description: "Request body exceeds 4 KiB",
			content: { "application/json": { schema: ErrorResponse } },
		},
		415: {
			description: "Only application/json request bodies are accepted",
			content: { "application/json": { schema: ErrorResponse } },
		},
		429: {
			description: "Too many redemption attempts",
			headers: {
				"Retry-After": {
					description: "Seconds until another attempt should be made",
					schema: { type: "string" },
				},
			},
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(redeemInviteToken, async (c) => {
	const db = c.get("inviteDb");
	const identity = c.get("inviteRedeemer");
	const { token } = c.req.valid("json");
	const tokenHash = await hashInviteToken(token);
	const redeemedAt = new Date();
	const result = await db.transaction(async (tx) => {
		if (!(await lockCurrentInviteRedeemer(tx, identity))) {
			return {
				ok: false as const,
				status: 401 as const,
				code: "INVITE_REDEEMER_NO_LONGER_AUTHORIZED",
				message: "The invitation redeemer is no longer authorized",
			};
		}

		const [invitation] = await tx
			.select({
				id: inviteTokens.id,
				organizationId: inviteTokens.organizationId,
				createdBy: inviteTokens.createdBy,
				issuerCredentialVersion: inviteTokens.issuerCredentialVersion,
				role: inviteTokens.role,
				scopeMode: inviteTokens.scopeMode,
				usedAt: inviteTokens.usedAt,
				usedBy: inviteTokens.usedBy,
				redeemedByUserId: inviteTokens.redeemedByUserId,
				expiresAt: inviteTokens.expiresAt,
				issuerPrincipalId: organizationPrincipals.id,
				issuerPrincipalStatus: organizationPrincipals.lifecycleStatus,
				issuerUserId: member.userId,
				issuerRole: member.role,
				issuerLiveUserId: user.id,
				issuerBanned: user.banned,
				issuerBanExpires: user.banExpires,
				issuerLiveCredentialVersion: user.credentialVersion,
				organizationName: organization.name,
				organizationSlug: organization.slug,
				organizationStatus: organization.lifecycleStatus,
			})
			.from(inviteTokens)
			.innerJoin(organization, eq(organization.id, inviteTokens.organizationId))
			.innerJoin(
				organizationPrincipals,
				and(
					eq(organizationPrincipals.id, inviteTokens.createdByPrincipalId),
					eq(
						organizationPrincipals.organizationId,
						inviteTokens.organizationId,
					),
					eq(organizationPrincipals.kind, "member"),
				),
			)
			.innerJoin(
				member,
				and(
					eq(member.id, organizationPrincipals.memberId),
					eq(member.organizationId, organizationPrincipals.organizationId),
				),
			)
			.innerJoin(user, eq(user.id, member.userId))
			.where(eq(inviteTokens.tokenHash, tokenHash))
			.for("update")
			.limit(1);

		if (!invitation) {
			return {
				ok: false as const,
				status: 400 as const,
				code: "INVALID_INVITE_TOKEN",
				message: "Invitation token is invalid",
			};
		}
		const signupClaim = inviteSignupClaimForUser(identity.userId);
		const ownsSignupClaim =
			invitation.usedAt !== null &&
			invitation.redeemedByUserId === null &&
			invitation.usedBy === signupClaim;
		if (invitation.usedAt && !ownsSignupClaim) {
			return {
				ok: false as const,
				status: 409 as const,
				code: "INVITE_TOKEN_USED",
				message: "Invitation token has already been redeemed",
			};
		}
		// Expiry is waived for the user who already claimed this token during
		// signup. That claim burned the token for everyone else and created an
		// account with no membership, so enforcing expiry here would leave that
		// account permanently locked out with no way to reissue. The claim could
		// only have been made while the token was live, so this honours a
		// reservation rather than resurrecting a dead token, and every other
		// caller is rejected as used at the check above before reaching here.
		if (!ownsSignupClaim && invitation.expiresAt <= redeemedAt) {
			return {
				ok: false as const,
				status: 410 as const,
				code: "INVITE_TOKEN_EXPIRED",
				message: "Invitation token has expired",
			};
		}
		if (
			invitation.organizationStatus !== "active" ||
			invitation.issuerPrincipalStatus !== "active" ||
			invitation.issuerUserId !== invitation.createdBy ||
			invitation.issuerLiveUserId !== invitation.createdBy ||
			!isCurrentInviteIssuerCredential({
				issuedCredentialVersion: invitation.issuerCredentialVersion,
				liveCredentialVersion: invitation.issuerLiveCredentialVersion,
				banned: invitation.issuerBanned,
				banExpires: invitation.issuerBanExpires,
				now: redeemedAt,
			}) ||
			!canAssignOrganizationRole(invitation.issuerRole, invitation.role)
		) {
			return {
				ok: false as const,
				status: 403 as const,
				code: "INVITE_ISSUER_NO_LONGER_AUTHORIZED",
				message:
					"The invitation issuer no longer has authority to grant this role",
			};
		}

		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(
				hashtext(
					'relayapi:invite-redeem:' ||
					${invitation.organizationId} ||
					':' ||
					${identity.userId}
				)
			)`,
		);

		const tokenWorkspaceRows =
			invitation.scopeMode === "selected"
				? await tx
						.select({
							workspaceId: inviteTokenWorkspaces.workspaceId,
							lifecycleStatus: workspaces.lifecycleStatus,
						})
						.from(inviteTokenWorkspaces)
						.innerJoin(
							workspaces,
							and(
								eq(workspaces.id, inviteTokenWorkspaces.workspaceId),
								eq(
									workspaces.organizationId,
									inviteTokenWorkspaces.organizationId,
								),
							),
						)
						.where(
							and(
								eq(
									inviteTokenWorkspaces.organizationId,
									invitation.organizationId,
								),
								eq(inviteTokenWorkspaces.inviteTokenId, invitation.id),
							),
						)
						.for("share")
				: [];
		if (
			invitation.scopeMode === "selected" &&
			(tokenWorkspaceRows.length === 0 ||
				tokenWorkspaceRows.some(
					(workspace) => workspace.lifecycleStatus !== "active",
				))
		) {
			return {
				ok: false as const,
				status: 403 as const,
				code: "INVITE_WORKSPACE_SCOPE_NO_LONGER_VALID",
				message: "One or more invitation workspaces are no longer active",
			};
		}
		const tokenWorkspaceIds = tokenWorkspaceRows.map(
			(workspace) => workspace.workspaceId,
		);

		const [existingMember] = await tx
			.select({ id: member.id, role: member.role })
			.from(member)
			.where(
				and(
					eq(member.organizationId, invitation.organizationId),
					eq(member.userId, identity.userId),
				),
			)
			.for("update")
			.limit(1);
		const memberId = existingMember?.id ?? generateId("mem_");
		const effectiveRole = existingMember
			? higherOrganizationRole(existingMember.role, invitation.role)
			: invitation.role;

		const [existingPrincipal] = await tx
			.select({
				id: organizationPrincipals.id,
				scopeMode: organizationPrincipals.scopeMode,
				lifecycleStatus: organizationPrincipals.lifecycleStatus,
			})
			.from(organizationPrincipals)
			.where(
				and(
					eq(organizationPrincipals.organizationId, invitation.organizationId),
					eq(organizationPrincipals.memberId, memberId),
					eq(organizationPrincipals.kind, "member"),
				),
			)
			.for("update")
			.limit(1);
		const principalId = existingPrincipal?.id ?? generateId("prn_");

		// Consume (or finalize this user's signup claim) before creating authority
		// rows. Everything still lives in this transaction, so a later failure rolls
		// the mutation back, while a CAS miss cannot commit partial access.
		// The owner branch carries no expiry predicate, matching the waiver above:
		// single use is still fenced by the claim identity plus the unredeemed
		// check, inside this transaction's row lock.
		const consumptionFence = ownsSignupClaim
			? and(
					eq(inviteTokens.id, invitation.id),
					eq(inviteTokens.organizationId, invitation.organizationId),
					eq(inviteTokens.usedBy, signupClaim),
					isNull(inviteTokens.redeemedByUserId),
				)
			: and(
					eq(inviteTokens.id, invitation.id),
					eq(inviteTokens.organizationId, invitation.organizationId),
					isNull(inviteTokens.usedAt),
					gt(inviteTokens.expiresAt, redeemedAt),
				);
		const [consumed] = await tx
			.update(inviteTokens)
			.set({
				usedBy: principalId,
				redeemedByUserId: identity.userId,
				usedAt: redeemedAt,
			})
			.where(consumptionFence)
			.returning({ id: inviteTokens.id });
		if (!consumed) {
			return {
				ok: false as const,
				status: 409 as const,
				code: "INVITE_TOKEN_USED",
				message: "Invitation token was consumed concurrently",
			};
		}

		if (!existingMember) {
			await tx.insert(member).values({
				id: memberId,
				userId: identity.userId,
				organizationId: invitation.organizationId,
				role: effectiveRole,
			});
		} else if (effectiveRole !== existingMember.role) {
			await tx
				.update(member)
				.set({ role: effectiveRole })
				.where(
					and(
						eq(member.id, memberId),
						eq(member.organizationId, invitation.organizationId),
					),
				);
		}

		if (!existingPrincipal) {
			await tx.insert(organizationPrincipals).values({
				id: principalId,
				organizationId: invitation.organizationId,
				kind: "member",
				memberId,
				scopeMode: invitation.scopeMode,
			});
		} else if (
			existingPrincipal.scopeMode === "selected" &&
			invitation.scopeMode === "all"
		) {
			await tx
				.delete(principalWorkspaceGrants)
				.where(
					and(
						eq(
							principalWorkspaceGrants.organizationId,
							invitation.organizationId,
						),
						eq(principalWorkspaceGrants.principalId, principalId),
					),
				);
			await tx
				.update(organizationPrincipals)
				.set({
					scopeMode: "all",
					lifecycleStatus: "active",
					disabledAt: null,
					updatedAt: redeemedAt,
				})
				.where(
					and(
						eq(organizationPrincipals.id, principalId),
						eq(
							organizationPrincipals.organizationId,
							invitation.organizationId,
						),
					),
				);
		} else if (existingPrincipal.lifecycleStatus !== "active") {
			await tx
				.update(organizationPrincipals)
				.set({
					lifecycleStatus: "active",
					disabledAt: null,
					updatedAt: redeemedAt,
				})
				.where(
					and(
						eq(organizationPrincipals.id, principalId),
						eq(
							organizationPrincipals.organizationId,
							invitation.organizationId,
						),
					),
				);
		}

		const effectiveScopeMode: "all" | "selected" =
			existingPrincipal?.scopeMode === "all" || invitation.scopeMode === "all"
				? "all"
				: "selected";
		if (effectiveScopeMode === "selected" && tokenWorkspaceIds.length > 0) {
			await tx
				.insert(principalWorkspaceGrants)
				.values(
					tokenWorkspaceIds.map((workspaceId) => ({
						organizationId: invitation.organizationId,
						principalId,
						workspaceId,
					})),
				)
				.onConflictDoNothing();
		}

		const effectiveWorkspaceIds =
			effectiveScopeMode === "selected"
				? (
						await tx
							.select({
								workspaceId: principalWorkspaceGrants.workspaceId,
							})
							.from(principalWorkspaceGrants)
							.where(
								and(
									eq(
										principalWorkspaceGrants.organizationId,
										invitation.organizationId,
									),
									eq(principalWorkspaceGrants.principalId, principalId),
								),
							)
					)
						.map((grant) => grant.workspaceId)
						.sort()
				: null;
		const credentialHashes = (
			await tx
				.select({ keyHash: apikey.key })
				.from(apikey)
				.where(
					and(
						eq(apikey.organizationId, invitation.organizationId),
						eq(apikey.principalId, principalId),
					),
				)
		).map((credential) => credential.keyHash);

		return {
			ok: true as const,
			credentialHashes,
			body: {
				organization: {
					id: invitation.organizationId,
					name: invitation.organizationName,
					slug: invitation.organizationSlug,
				},
				member: {
					id: memberId,
					role: effectiveRole as OrganizationRole,
				},
				principal: {
					id: principalId,
					scope_mode: effectiveScopeMode,
					workspace_ids: effectiveWorkspaceIds,
				},
				redeemed_at: redeemedAt.toISOString(),
			},
		};
	});

	if (!result.ok) {
		const body = {
			error: { code: result.code, message: result.message },
		};
		if (result.status === 400) return c.json(body, 400);
		if (result.status === 401) return c.json(body, 401);
		if (result.status === 403) return c.json(body, 403);
		if (result.status === 409) return c.json(body, 409);
		return c.json(body, 410);
	}
	try {
		await Promise.all([
			...result.credentialHashes.map((keyHash) =>
				c.env.KV.delete(`apikey:${keyHash}`),
			),
			c.env.KV.delete(
				`dashboard-key:${result.body.organization.id}:${identity.userId}`,
			),
		]);
	} catch {
		console.error(
			JSON.stringify({
				event: "invite_redeem_cache_invalidation_failed",
				organization_id: result.body.organization.id,
				principal_id: result.body.principal.id,
			}),
		);
	}
	return c.json(result.body, 200);
});

export default app;
