import type { APIRoute } from "astro";
import {
	notifications,
	eq,
} from "@relayapi/db";
import { and, desc, lt } from "drizzle-orm";

export const GET: APIRoute = async (context) => {
	const user = context.locals.user;
	if (!user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const userId = (user as any).id as string;
	const db = context.locals.db;
	const url = new URL(context.request.url);
	const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
	const cursor = url.searchParams.get("cursor") || null;
	const unreadOnly = url.searchParams.get("unread") === "true";

	const conditions = [eq(notifications.userId, userId)];
	if (unreadOnly) {
		conditions.push(eq(notifications.read, false));
	}
	if (cursor) {
		conditions.push(lt(notifications.createdAt, new Date(cursor)));
	}

	const rows = await db
		.select()
		.from(notifications)
		.where(and(...conditions))
		.orderBy(desc(notifications.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = hasMore ? rows.slice(0, limit) : rows;
	const nextCursor = hasMore && data.length > 0
		? data[data.length - 1]!.createdAt.toISOString()
		: null;

	return Response.json({
		data,
		has_more: hasMore,
		next_cursor: nextCursor,
	});
};

/** POST = Mark all notifications as read */
export const POST: APIRoute = async (context) => {
	const user = context.locals.user;
	if (!user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const userId = (user as any).id as string;
	const db = context.locals.db;

	await db
		.update(notifications)
		.set({ read: true })
		.where(and(eq(notifications.userId, userId), eq(notifications.read, false)));

	return Response.json({ ok: true });
};
