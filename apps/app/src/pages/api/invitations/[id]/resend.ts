import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { invitation, member, organization, user, eq } from "@relayapi/db";
import { and } from "drizzle-orm";
import { render } from "@react-email/render";
import { Resend } from "resend";
import { InvitationEmail } from "../../../../lib/emails/invitation-email";

const INVITE_MANAGER_ROLES = new Set(["owner", "admin"]);

export const POST: APIRoute = async (context) => {
	const currentUser = context.locals.user;
	if (!currentUser) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const id = context.params.id;
	if (!id) {
		return Response.json({ error: "Missing invitation ID" }, { status: 400 });
	}

	const db = context.locals.db;
	const cfEnv = env as Record<string, unknown>;

	try {
		const [row] = await db
			.select({
				id: invitation.id,
				email: invitation.email,
				role: invitation.role,
				status: invitation.status,
				organizationId: invitation.organizationId,
				organizationName: organization.name,
				inviterEmail: user.email,
			})
			.from(invitation)
			.innerJoin(organization, eq(invitation.organizationId, organization.id))
			.innerJoin(user, eq(invitation.inviterId, user.id))
			.where(eq(invitation.id, id))
			.limit(1);

		if (!row) {
			return Response.json({ error: "Invitation not found" }, { status: 404 });
		}

		// AUTHZ: the caller must be an owner/admin of the invitation's org.
		// Without this, any authenticated user could resend (and re-trigger the
		// invite email for) any invitation by guessing its id (IDOR).
		const currentUserId = currentUser.id as string;
		const [membership] = await db
			.select({ role: member.role })
			.from(member)
			.where(
				and(
					eq(member.userId, currentUserId),
					eq(member.organizationId, row.organizationId),
				),
			)
			.limit(1);

		if (!membership || !INVITE_MANAGER_ROLES.has(membership.role ?? "")) {
			return Response.json({ error: "Forbidden" }, { status: 403 });
		}

		if (row.status !== "pending") {
			return Response.json(
				{ error: "Invitation is no longer pending" },
				{ status: 400 },
			);
		}

		const baseUrl = (cfEnv.BETTER_AUTH_URL as string | undefined) || context.url.origin;
		const inviteUrl = `${baseUrl}/invite/${row.id}`;

		const html = await render(
			InvitationEmail({
				invitedByEmail: row.inviterEmail,
				organizationName: row.organizationName,
				role: row.role || "member",
				inviteUrl,
			}),
		);

		const emailMessage = {
			id: crypto.randomUUID(),
			to: row.email,
			subject: `You've been invited to join ${row.organizationName} on RelayAPI`,
			html,
			from: "RelayAPI <notifications@relayapi.dev>",
		};

		const queue = cfEnv.EMAIL_QUEUE as
			| { send(message: unknown): Promise<void> }
			| undefined;
		if (queue) {
			await queue.send(emailMessage);
		} else if (cfEnv.RESEND_API_KEY) {
			const resend = new Resend(cfEnv.RESEND_API_KEY as string);
			await resend.emails.send({
				from: emailMessage.from,
				to: emailMessage.to,
				subject: emailMessage.subject,
				html: emailMessage.html,
			});
		} else {
			return Response.json(
				{ error: "Email service not configured" },
				{ status: 500 },
			);
		}

		return Response.json({ success: true });
	} catch (e) {
		console.error("Failed to resend invitation:", e);
		return Response.json(
			{ error: "Failed to resend invitation" },
			{ status: 500 },
		);
	}
};
