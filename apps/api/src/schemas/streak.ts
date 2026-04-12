import { z } from "@hono/zod-openapi";

export const StreakResponse = z.object({
	active: z.boolean().describe("Whether there is an active posting streak"),
	current_streak_days: z.number().int().describe("Current streak length in days"),
	streak_started_at: z
		.string()
		.datetime()
		.nullable()
		.describe("When the current streak started"),
	last_post_at: z
		.string()
		.datetime()
		.nullable()
		.describe("When the last post was published"),
	best_streak_days: z.number().int().describe("Longest streak ever achieved"),
	total_streaks_broken: z.number().int().describe("Total number of streaks that have ended"),
	hours_remaining: z
		.number()
		.nullable()
		.describe("Hours remaining before the current streak expires (null if no active streak)"),
});
