import type { APIRoute } from "astro";
import { userPreferences, eq } from "@relayapi/db";

function isValidTimezone(tz: string): boolean {
	try {
		Intl.DateTimeFormat(undefined, { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

const VALID_LANGUAGES = new Set(["en", "es", "fr", "de", "ja", "zh"]);

export const GET: APIRoute = async (context) => {
	const user = context.locals.user;
	if (!user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const userId = (user as any).id as string;
	const db = context.locals.db;

	const [row] = await db
		.select()
		.from(userPreferences)
		.where(eq(userPreferences.userId, userId))
		.limit(1);

	return Response.json({
		timezone: row?.timezone ?? "UTC",
		language: row?.language ?? "en",
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

	const update: Record<string, unknown> = { updatedAt: new Date() };

	if (body.timezone && isValidTimezone(body.timezone)) {
		update.timezone = body.timezone;
	}
	if (body.language && VALID_LANGUAGES.has(body.language)) {
		update.language = body.language;
	}

	const [existing] = await db
		.select({ id: userPreferences.id })
		.from(userPreferences)
		.where(eq(userPreferences.userId, userId))
		.limit(1);

	if (existing) {
		await db
			.update(userPreferences)
			.set(update)
			.where(eq(userPreferences.userId, userId));
	} else {
		await db.insert(userPreferences).values({
			userId,
			...update,
		});
	}

	return Response.json({ ok: true });
};
