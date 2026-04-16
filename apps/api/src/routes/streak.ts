import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { createDb, orgStreaks } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { ErrorResponse } from "../schemas/common";
import { StreakResponse } from "../schemas/streak";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const STREAK_WINDOW_HOURS = 24;

// --- Route definitions ---

const getStreak = createRoute({
	operationId: "getStreak",
	method: "get",
	path: "/",
	tags: ["Streak"],
	summary: "Get posting streak",
	description:
		"Returns the current posting streak status for the organization, including streak length, best streak, and time remaining.",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Streak details",
			content: { "application/json": { schema: StreakResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Route handlers ---

app.openapi(getStreak, async (c) => {
	const orgId = c.get("orgId");
	const db = c.get("db");

	const [streak] = await db
		.select()
		.from(orgStreaks)
		.where(eq(orgStreaks.organizationId, orgId))
		.limit(1);

	if (!streak || !streak.streakStartedAt) {
		return c.json(
			{
				active: false,
				current_streak_days: streak?.currentStreakDays ?? 0,
				streak_started_at: null,
				last_post_at: streak?.lastPostAt?.toISOString() ?? null,
				best_streak_days: streak?.bestStreakDays ?? 0,
				total_streaks_broken: streak?.totalStreaksBroken ?? 0,
				hours_remaining: null,
			},
			200,
		);
	}

	const hoursRemaining = streak.lastPostAt
		? Math.max(
				0,
				STREAK_WINDOW_HOURS -
					(Date.now() - streak.lastPostAt.getTime()) / (1000 * 60 * 60),
			)
		: null;

	return c.json(
		{
			active: true,
			current_streak_days: streak.currentStreakDays,
			streak_started_at: streak.streakStartedAt.toISOString(),
			last_post_at: streak.lastPostAt?.toISOString() ?? null,
			best_streak_days: streak.bestStreakDays,
			total_streaks_broken: streak.totalStreaksBroken,
			hours_remaining:
				hoursRemaining !== null
					? Math.round(hoursRemaining * 100) / 100
					: null,
		},
		200,
	);
});

export default app;
