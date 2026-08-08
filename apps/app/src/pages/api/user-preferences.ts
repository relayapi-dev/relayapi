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

	const userId = user.id as string;
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

	const userId = user.id as string;
	const db = context.locals.db;
	const body = (await context.request.json()) as Record<string, unknown>;

	const update: Record<string, unknown> = { updatedAt: new Date() };

	if (body.timezone !== undefined) {
		if (typeof body.timezone !== "string" || !isValidTimezone(body.timezone)) {
			return Response.json(
				{ error: "timezone must be a valid IANA timezone" },
				{ status: 400 },
			);
		}
		update.timezone = body.timezone;
	}
	if (body.language !== undefined) {
		if (
			typeof body.language !== "string" ||
			!VALID_LANGUAGES.has(body.language)
		) {
			return Response.json(
				{ error: "language is not supported" },
				{ status: 400 },
			);
		}
		update.language = body.language;
	}
	if (update.timezone === undefined && update.language === undefined) {
		return Response.json(
			{ error: "timezone or language is required" },
			{ status: 400 },
		);
	}

	const [saved] = await db
		.insert(userPreferences)
		.values({
			userId,
			timezone:
				typeof update.timezone === "string" ? update.timezone : "UTC",
			language:
				typeof update.language === "string" ? update.language : "en",
			updatedAt: update.updatedAt as Date,
		})
		.onConflictDoUpdate({
			target: userPreferences.userId,
			set: update,
		})
		.returning({
			timezone: userPreferences.timezone,
			language: userPreferences.language,
		});

	return Response.json(saved);
};
