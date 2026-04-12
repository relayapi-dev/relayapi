import type { APIRoute } from "astro";
import { notifications, eq } from "@relayapi/db";
import { and } from "drizzle-orm";

export const PATCH: APIRoute = async (context) => {
	const user = context.locals.user;
	if (!user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const userId = (user as any).id as string;
	const notifId = context.params.id;
	if (!notifId) {
		return Response.json({ error: "Missing notification ID" }, { status: 400 });
	}

	const db = context.locals.db;

	await db
		.update(notifications)
		.set({ read: true })
		.where(
			and(
				eq(notifications.id, notifId),
				eq(notifications.userId, userId),
			),
		);

	return Response.json({ ok: true });
};
