import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { member, user } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import {
	highestOrganizationRole,
	ORGANIZATION_ROLE_RANK,
} from "../lib/organization-roles";
import { markMutationInputNotApplied } from "../middleware/mutation-validation";
import { ErrorResponse } from "../schemas/common";
import {
	stageInvitationResend,
	stageOnDemandPlatformRequest,
} from "../services/email-intents";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const IdempotencyHeader = z.object({
	"idempotency-key": z
		.string()
		.min(8)
		.max(200)
		.regex(/^[A-Za-z0-9._:-]+$/)
		.openapi({
			description:
				"Caller-generated key for one logical email-staging occurrence",
			example: "email-occurrence-018f1f6e",
		}),
});

const StagedEmailResponse = z.object({
	delivery_id: z.string(),
	status: z.literal("staged"),
});

const resendInvitation = createRoute({
	operationId: "resendOrganizationInvitation",
	method: "post",
	path: "/invitations/{id}/resend",
	tags: ["Invitations"],
	summary: "Resend a pending organization invitation",
	security: [{ Bearer: [] }],
	request: {
		params: z.object({ id: z.string().min(1).max(255) }),
		headers: IdempotencyHeader,
	},
	responses: {
		202: {
			description: "Invitation email staged",
			content: { "application/json": { schema: StagedEmailResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Organization admin required",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Pending invitation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const OnDemandPlatformRequestBody = z
	.object({
		platform: z.string().trim().min(1).max(100),
		name: z.string().trim().min(1).max(200).optional(),
		email: z.string().trim().email().max(320),
		message: z.string().trim().max(4_000).optional(),
	})
	.strict();

const createOnDemandPlatformRequest = createRoute({
	operationId: "createOnDemandPlatformRequest",
	method: "post",
	path: "/support/on-demand-platform-requests",
	tags: ["Support"],
	summary: "Request an on-demand social platform integration",
	security: [{ Bearer: [] }],
	request: {
		headers: IdempotencyHeader,
		body: {
			content: {
				"application/json": { schema: OnDemandPlatformRequestBody },
			},
		},
	},
	responses: {
		202: {
			description: "Support request email staged",
			content: { "application/json": { schema: StagedEmailResponse } },
		},
		400: {
			description: "Invalid request",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Dashboard member required",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(resendInvitation, async (c) => {
	const organizationId = c.get("orgId");
	const principalUserId = c.get("principalUserId");
	if (c.get("principalType") !== "dashboard_user" || !principalUserId) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "FORBIDDEN",
					message: "An organization member must resend invitations",
				},
			},
			403,
		);
	}
	const [membership] = await c
		.get("db")
		.select({ role: member.role })
		.from(member)
		.where(
			and(
				eq(member.organizationId, organizationId),
				eq(member.userId, principalUserId),
			),
		)
		.limit(1);
	const role = membership ? highestOrganizationRole(membership.role) : null;
	if (!role || ORGANIZATION_ROLE_RANK[role] < ORGANIZATION_ROLE_RANK.admin) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "FORBIDDEN",
					message: "Organization admin access is required",
				},
			},
			403,
		);
	}

	try {
		const staged = await stageInvitationResend(c.env, {
			invitationId: c.req.valid("param").id,
			organizationId,
			occurrenceId: c.req.valid("header")["idempotency-key"],
		});
		return c.json(
			{ delivery_id: staged.deliveryId, status: staged.status },
			202,
		);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === "Pending invitation not found"
		) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "NOT_FOUND",
						message: "Pending invitation not found",
					},
				},
				404,
			);
		}
		throw error;
	}
});

app.openapi(createOnDemandPlatformRequest, async (c) => {
	const organizationId = c.get("orgId");
	const principalUserId = c.get("principalUserId");
	if (c.get("principalType") !== "dashboard_user" || !principalUserId) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "FORBIDDEN",
					message: "An organization member must create support requests",
				},
			},
			403,
		);
	}
	const [requestingUser] = await c
		.get("db")
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, principalUserId))
		.limit(1);
	if (!requestingUser) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "FORBIDDEN",
					message: "The requesting identity no longer exists",
				},
			},
			403,
		);
	}
	const body = c.req.valid("json");
	const staged = await stageOnDemandPlatformRequest(c.env, {
		organizationId,
		subjectUserId: principalUserId,
		occurrenceId: c.req.valid("header")["idempotency-key"],
		platform: body.platform,
		name: body.name,
		email: body.email,
		message: body.message,
		requestingUserEmail: requestingUser.email,
	});
	return c.json({ delivery_id: staged.deliveryId, status: staged.status }, 202);
});

export default app;
