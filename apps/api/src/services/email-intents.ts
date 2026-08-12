import { createDb, invitation, organization, user } from "@relayapi/db";
import { and, eq, gt } from "drizzle-orm";
import {
	enqueueAuthUserEmail,
	enqueueEmail,
} from "../lib/email-queue/producer";
import type { Env } from "../types";

export const ACCOUNT_EMAIL_KINDS = [
	"verify-email",
	"reset-password",
	"delete-account",
] as const;

export type AccountEmailKind = (typeof ACCOUNT_EMAIL_KINDS)[number];

export type InternalEmailIntent =
	| {
			type: "organization_invitation";
			invitationId: string;
			occurrenceId: string;
	  }
	| {
			type: "account_action";
			kind: AccountEmailKind;
			authUserId: string;
			actionUrl: string;
			token: string;
	  };

export interface StagedEmailIntent {
	deliveryId: string;
	status: "staged";
}

function requiredString(
	value: unknown,
	name: string,
	maxLength: number,
): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength
	) {
		throw new TypeError(`${name} is invalid`);
	}
	return value;
}

function assertExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): void {
	const allowed = new Set(keys);
	if (Object.keys(value).some((key) => !allowed.has(key))) {
		throw new TypeError("Email intent contains unsupported fields");
	}
}

export function parseInternalEmailIntent(value: unknown): InternalEmailIntent {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("Email intent must be an object");
	}
	const input = value as Record<string, unknown>;
	if (input.type === "organization_invitation") {
		assertExactKeys(input, ["type", "invitationId", "occurrenceId"]);
		return {
			type: input.type,
			invitationId: requiredString(input.invitationId, "invitationId", 255),
			occurrenceId: requiredString(input.occurrenceId, "occurrenceId", 200),
		};
	}
	if (input.type === "account_action") {
		assertExactKeys(input, [
			"type",
			"kind",
			"authUserId",
			"actionUrl",
			"token",
		]);
		if (
			typeof input.kind !== "string" ||
			!ACCOUNT_EMAIL_KINDS.includes(input.kind as AccountEmailKind)
		) {
			throw new TypeError("kind is invalid");
		}
		return {
			type: input.type,
			kind: input.kind as AccountEmailKind,
			authUserId: requiredString(input.authUserId, "authUserId", 255),
			actionUrl: requiredString(input.actionUrl, "actionUrl", 4_096),
			token: requiredString(input.token, "token", 4_096),
		};
	}
	throw new TypeError("Email intent type is invalid");
}

function cleanSubjectPart(value: string): string {
	return value
		.replace(/[\r\n]+/g, " ")
		.trim()
		.slice(0, 160);
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

async function stageInvitation(
	env: Env,
	input: Extract<InternalEmailIntent, { type: "organization_invitation" }>,
	expectedOrganizationId?: string,
): Promise<StagedEmailIntent> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const [row] = await db
		.select({
			id: invitation.id,
			email: invitation.email,
			role: invitation.role,
			organizationId: invitation.organizationId,
			organizationName: organization.name,
			inviterEmail: user.email,
		})
		.from(invitation)
		.innerJoin(
			organization,
			and(
				eq(invitation.organizationId, organization.id),
				eq(organization.lifecycleStatus, "active"),
			),
		)
		.innerJoin(user, eq(invitation.inviterId, user.id))
		.where(
			and(
				eq(invitation.id, input.invitationId),
				eq(invitation.status, "pending"),
				gt(invitation.expiresAt, now),
			),
		)
		.limit(1);
	if (
		!row ||
		(expectedOrganizationId && row.organizationId !== expectedOrganizationId)
	) {
		throw new Error("Pending invitation not found");
	}

	const { renderOrganizationInvitation } = await import(
		"../lib/emails/render-intents"
	);
	const appOrigin = new URL(env.APP_BASE_URL ?? "https://relayapi.dev");
	const inviteUrl = new URL(
		`/invite/${encodeURIComponent(row.id)}`,
		appOrigin,
	).toString();
	const html = await renderOrganizationInvitation({
		invitedByEmail: row.inviterEmail,
		organizationName: row.organizationName,
		role: row.role || "member",
		inviteUrl,
	});
	const deliveryId = await enqueueEmail(env, {
		organizationId: row.organizationId,
		to: row.email,
		subject: `You've been invited to join ${cleanSubjectPart(row.organizationName)} on RelayAPI`,
		html,
		idempotencyKey: `invitation:${row.id}:${input.occurrenceId}`,
	});
	return { deliveryId, status: "staged" };
}

const ACCOUNT_CONTENT: Record<
	AccountEmailKind,
	{
		preview: string;
		title: string;
		message: string;
		actionLabel: string;
		expiresIn: string;
		subject: string;
	}
> = {
	"verify-email": {
		preview: "Verify your RelayAPI email address",
		title: "Verify your email",
		message:
			"Confirm this email address to finish creating your RelayAPI account.",
		actionLabel: "Verify email",
		expiresIn: "one hour",
		subject: "Verify your RelayAPI email",
	},
	"reset-password": {
		preview: "Reset your RelayAPI password",
		title: "Reset your password",
		message: "Use this secure link to choose a new RelayAPI password.",
		actionLabel: "Reset password",
		expiresIn: "one hour",
		subject: "Reset your RelayAPI password",
	},
	"delete-account": {
		preview: "Confirm deletion of your RelayAPI account",
		title: "Confirm account deletion",
		message:
			"Confirm that you want to permanently delete your RelayAPI account.",
		actionLabel: "Delete my account",
		expiresIn: "30 minutes",
		subject: "Confirm RelayAPI account deletion",
	},
};

async function stageAccountAction(
	env: Env,
	input: Extract<InternalEmailIntent, { type: "account_action" }>,
): Promise<StagedEmailIntent> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const [accountUser] = await db
		.select({ id: user.id, email: user.email })
		.from(user)
		.where(eq(user.id, input.authUserId))
		.limit(1);
	if (!accountUser) throw new Error("Auth user not found");

	const expectedOrigin = new URL(env.APP_BASE_URL ?? "https://relayapi.dev")
		.origin;
	const actionUrl = new URL(input.actionUrl);
	if (actionUrl.origin !== expectedOrigin) {
		throw new TypeError("Account action URL origin is invalid");
	}
	const encodedToken = encodeURIComponent(input.token);
	if (
		!actionUrl.toString().includes(input.token) &&
		!actionUrl.toString().includes(encodedToken)
	) {
		throw new TypeError("Account action URL does not contain its token");
	}

	const content = ACCOUNT_CONTENT[input.kind];
	const { renderAccountAction } = await import("../lib/emails/render-intents");
	const html = await renderAccountAction({
		...content,
		actionUrl: actionUrl.toString(),
	});
	const deliveryId = await enqueueAuthUserEmail(env, {
		authUserId: accountUser.id,
		subjectUserId: accountUser.id,
		to: accountUser.email,
		subject: content.subject,
		html,
		idempotencyKey: `account:${input.kind}:${await sha256Hex(input.token)}`,
	});
	return { deliveryId, status: "staged" };
}

export async function stageInternalEmailIntent(
	env: Env,
	value: unknown,
): Promise<StagedEmailIntent> {
	const input = parseInternalEmailIntent(value);
	return input.type === "organization_invitation"
		? stageInvitation(env, input)
		: stageAccountAction(env, input);
}

export async function stageInvitationResend(
	env: Env,
	input: {
		invitationId: string;
		organizationId: string;
		occurrenceId: string;
	},
): Promise<StagedEmailIntent> {
	return stageInvitation(
		env,
		{
			type: "organization_invitation",
			invitationId: requiredString(input.invitationId, "invitationId", 255),
			occurrenceId: requiredString(input.occurrenceId, "occurrenceId", 200),
		},
		input.organizationId,
	);
}

export async function stageOnDemandPlatformRequest(
	env: Env,
	input: {
		organizationId: string;
		subjectUserId?: string;
		occurrenceId: string;
		platform: string;
		name?: string;
		email: string;
		message?: string;
		requestingUserEmail?: string;
	},
): Promise<StagedEmailIntent> {
	const { renderOnDemandPlatformRequest } = await import(
		"../lib/emails/render-intents"
	);
	const html = await renderOnDemandPlatformRequest({
		platform: input.platform,
		name: input.name,
		email: input.email,
		message: input.message,
		requestingUserEmail: input.requestingUserEmail,
	});
	const deliveryId = await enqueueEmail(env, {
		organizationId: input.organizationId,
		subjectUserId: input.subjectUserId,
		to: "support@relayapi.dev",
		subject: `[On-Demand] ${cleanSubjectPart(input.platform)} platform request from ${cleanSubjectPart(input.email)}`,
		html,
		idempotencyKey: `on-demand:${input.organizationId}:${input.occurrenceId}`,
	});
	return { deliveryId, status: "staged" };
}
