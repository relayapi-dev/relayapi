import type { APIRoute } from "astro";
import { notifications, eq } from "@relayapi/db";
import { and, count } from "drizzle-orm";

export const GET: APIRoute = async (context) => {
	const user = context.locals.user;
	if (!user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const userId = (user as any).id as string;
	const db = context.locals.db;

	const [result] = await db
		.select({ count: count() })
		.from(notifications)
		.where(and(eq(notifications.userId, userId), eq(notifications.read, false)));

	return Response.json({ count: result?.count ?? 0 });
};
