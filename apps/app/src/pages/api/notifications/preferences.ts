import type { APIRoute } from "astro";
import { notificationPreferences, eq } from "@relayapi/db";

const DEFAULTS = {
	postFailures: { push: true, email: true },
	postPublished: { push: true, email: false },
	accountDisconnects: { push: true, email: true },
	paymentAlerts: { push: true, email: true },
	usageAlerts: { push: true, email: true },
	streakWarnings: { push: true, email: true },
	weeklyDigest: { push: false, email: false },
	marketing: { push: false, email: false },
};

export const GET: APIRoute = async (context) => {
	const user = context.locals.user;
	if (!user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const userId = (user as any).id as string;
	const db = context.locals.db;

	const [row] = await db
		.select()
		.from(notificationPreferences)
		.where(eq(notificationPreferences.userId, userId))
		.limit(1);

	if (!row) {
		return Response.json(DEFAULTS);
	}

	return Response.json({
		postFailures: row.postFailures ?? DEFAULTS.postFailures,
		postPublished: row.postPublished ?? DEFAULTS.postPublished,
		accountDisconnects: row.accountDisconnects ?? DEFAULTS.accountDisconnects,
		paymentAlerts: row.paymentAlerts ?? DEFAULTS.paymentAlerts,
		usageAlerts: row.usageAlerts ?? DEFAULTS.usageAlerts,
		streakWarnings: row.streakWarnings ?? DEFAULTS.streakWarnings,
		weeklyDigest: row.weeklyDigest ?? DEFAULTS.weeklyDigest,
		marketing: row.marketing ?? DEFAULTS.marketing,
	});
};

export const PUT: APIRoute = async (context) => {
	const user = context.locals.user;
	if (!user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const userId = (user as any).id as string;
	const db = context.locals.db;
	const body = await context.request.json();

	// Validate shape: each key should be { push: boolean, email: boolean }
	const validKeys = [
		"postFailures",
		"postPublished",
		"accountDisconnects",
		"paymentAlerts",
		"usageAlerts",
		"streakWarnings",
		"weeklyDigest",
		"marketing",
	] as const;

	const update: Record<string, unknown> = { updatedAt: new Date() };
	for (const key of validKeys) {
		if (body[key] && typeof body[key] === "object") {
			update[key] = {
				push: !!body[key].push,
				email: !!body[key].email,
			};
		}
	}

	// Upsert
	const [existing] = await db
		.select({ id: notificationPreferences.id })
		.from(notificationPreferences)
		.where(eq(notificationPreferences.userId, userId))
		.limit(1);

	if (existing) {
		await db
			.update(notificationPreferences)
			.set(update)
			.where(eq(notificationPreferences.userId, userId));
	} else {
		await db.insert(notificationPreferences).values({
			userId,
			...update,
		});
	}

	return Response.json({ ok: true });
};
