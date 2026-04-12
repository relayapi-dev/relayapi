import type { APIRoute } from "astro";
import { invitation, organization, user, eq } from "@relayapi/db";

export const GET: APIRoute = async (context) => {
	const id = context.params.id;
	if (!id) {
		return Response.json({ error: "Missing invitation ID" }, { status: 400 });
	}

	const db = context.locals.db;

	try {
		const [row] = await db
			.select({
				id: invitation.id,
				email: invitation.email,
				role: invitation.role,
				status: invitation.status,
				expiresAt: invitation.expiresAt,
				organizationName: organization.name,
				organizationSlug: organization.slug,
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

		return Response.json(row);
	} catch (e) {
		console.error("Failed to fetch invitation:", e);
		return Response.json(
			{ error: "Failed to fetch invitation" },
			{ status: 500 },
		);
	}
};
