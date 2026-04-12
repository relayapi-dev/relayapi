import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { generateId } from "@relayapi/db";
import { ErrorResponse } from "../schemas/common";
import {
	CreateQueueBody,
	FindSlotQuery,
	FindSlotResponse,
	NextSlotResponse,
	PreviewQuery,
	PreviewResponse,
	QueueListResponse,
	QueueSchedule,
	UpdateQueueBody,
} from "../schemas/queue";
import { findBestSlots } from "../services/slot-finder";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- KV helpers ---

interface StoredSchedule {
	id: string;
	name: string;
	slots: Array<{ day_of_week: number; time: string; timezone: string }>;
	is_default: boolean;
	created_at: string;
	updated_at: string;
}

async function getSchedules(
	kv: KVNamespace,
	orgId: string,
): Promise<StoredSchedule[]> {
	const data = await kv.get<StoredSchedule[]>(
		`queue-schedule:${orgId}`,
		"json",
	);
	return data ?? [];
}

async function saveSchedules(
	kv: KVNamespace,
	orgId: string,
	schedules: StoredSchedule[],
): Promise<void> {
	await kv.put(`queue-schedule:${orgId}`, JSON.stringify(schedules));
}

/**
 * Calculate the next N upcoming slot times from a schedule's slots.
 * Each slot defines a recurring weekly time via day_of_week (0=Sunday),
 * time (HH:MM), and timezone.
 */
function calculateUpcomingSlots(
	slots: StoredSchedule["slots"],
	count: number,
	now: Date,
): string[] {
	if (slots.length === 0) return [];

	const upcoming: Date[] = [];

	// For each slot, find next occurrences over enough weeks to fill `count`
	const weeksToCheck = Math.ceil(count / slots.length) + 1;

	for (const slot of slots) {
		const [hoursStr, minutesStr] = slot.time.split(":");
		const hours = Number.parseInt(hoursStr as string, 10);
		const minutes = Number.parseInt(minutesStr as string, 10);

		// Use Intl.DateTimeFormat to resolve the current day-of-week in the slot's timezone
		const tzDayFormat = new Intl.DateTimeFormat("en-US", {
			timeZone: slot.timezone,
			weekday: "short",
		});
		const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

		for (let weekOffset = 0; weekOffset < weeksToCheck; weekOffset++) {
			// Calculate the target date for this slot's day_of_week
			const currentDay = dayMap[tzDayFormat.format(now)] ?? now.getUTCDay();
			let daysUntilTarget = slot.day_of_week - currentDay;
			if (daysUntilTarget < 0) daysUntilTarget += 7;
			daysUntilTarget += weekOffset * 7;

			// Build the target date in the slot's timezone, then convert to UTC
			const baseDate = new Date(now);
			baseDate.setUTCDate(baseDate.getUTCDate() + daysUntilTarget);

			// Format the date parts in the slot's timezone to build an accurate local date string
			const parts = new Intl.DateTimeFormat("en-US", {
				timeZone: slot.timezone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			}).formatToParts(baseDate);
			const year = parts.find((p) => p.type === "year")?.value;
			const month = parts.find((p) => p.type === "month")?.value;
			const day = parts.find((p) => p.type === "day")?.value;

			// Create the target time in the slot's timezone using a parseable format
			const localDateStr = `${year}-${month}-${day}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;

			// Compute the UTC offset for this timezone at this date/time
			const tempUtc = new Date(localDateStr + "Z");
			const tzOffsetParts = new Intl.DateTimeFormat("en-US", {
				timeZone: slot.timezone,
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			}).formatToParts(tempUtc);
			const tzHour = Number(tzOffsetParts.find((p) => p.type === "hour")?.value ?? "0");
			const tzMinute = Number(tzOffsetParts.find((p) => p.type === "minute")?.value ?? "0");
			const localMinutes = tzHour * 60 + tzMinute;
			const utcMinutes = tempUtc.getUTCHours() * 60 + tempUtc.getUTCMinutes();
			let offsetMinutes = localMinutes - utcMinutes;
			if (offsetMinutes > 720) offsetMinutes -= 1440;
			if (offsetMinutes < -720) offsetMinutes += 1440;

			const target = new Date(tempUtc.getTime() - offsetMinutes * 60 * 1000);

			// Only include future slots
			if (target.getTime() > now.getTime()) {
				upcoming.push(target);
			}
		}
	}

	// Sort ascending and take the first `count`
	upcoming.sort((a, b) => a.getTime() - b.getTime());
	return upcoming.slice(0, count).map((d) => d.toISOString());
}

// --- Route definitions ---

const listSlots = createRoute({
	operationId: "listQueueSlots",
	method: "get",
	path: "/slots",
	tags: ["Queue"],
	summary: "List queue schedules",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Queue schedules",
			content: { "application/json": { schema: QueueListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const createSlots = createRoute({
	operationId: "createQueueSlots",
	method: "post",
	path: "/slots",
	tags: ["Queue"],
	summary: "Create a queue schedule",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateQueueBody } },
		},
	},
	responses: {
		201: {
			description: "Queue schedule created",
			content: { "application/json": { schema: QueueSchedule } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const updateSlots = createRoute({
	operationId: "updateQueueSlots",
	method: "put",
	path: "/slots",
	tags: ["Queue"],
	summary: "Update queue schedule",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: UpdateQueueBody } },
		},
	},
	responses: {
		200: {
			description: "Queue schedule updated",
			content: { "application/json": { schema: QueueSchedule } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteSlots = createRoute({
	operationId: "deleteQueueSlots",
	method: "delete",
	path: "/slots",
	tags: ["Queue"],
	summary: "Delete queue schedule",
	security: [{ Bearer: [] }],
	responses: {
		204: { description: "Queue schedule deleted" },
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getNextSlot = createRoute({
	operationId: "getNextQueueSlot",
	method: "get",
	path: "/next-slot",
	tags: ["Queue"],
	summary: "Get next available queue slot",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Next slot",
			content: { "application/json": { schema: NextSlotResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const previewSlots = createRoute({
	operationId: "previewQueueSlots",
	method: "get",
	path: "/preview",
	tags: ["Queue"],
	summary: "Preview upcoming queue slots",
	security: [{ Bearer: [] }],
	request: { query: PreviewQuery },
	responses: {
		200: {
			description: "Preview of upcoming slots",
			content: { "application/json": { schema: PreviewResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Route handlers ---

app.openapi(listSlots, async (c) => {
	const orgId = c.get("orgId");
	const schedules = await getSchedules(c.env.KV, orgId);

	return c.json({ data: schedules }, 200);
});

app.openapi(createSlots, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const schedules = await getSchedules(c.env.KV, orgId);

	const now = new Date().toISOString();
	const isFirst = schedules.length === 0;

	const schedule: StoredSchedule = {
		id: generateId("qs_"),
		name: body.name ?? "Default Schedule",
		slots: body.slots.map((s) => ({
			day_of_week: s.day_of_week,
			time: s.time,
			timezone: s.timezone ?? body.timezone,
		})),
		is_default: isFirst,
		created_at: now,
		updated_at: now,
	};

	schedules.push(schedule);
	await saveSchedules(c.env.KV, orgId, schedules);

	return c.json(schedule, 201);
});

app.openapi(updateSlots, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const schedules = await getSchedules(c.env.KV, orgId);

	// Find the default schedule to update (since this route has no ID param)
	const idx = schedules.findIndex((s) => s.is_default);
	if (idx === -1) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "No queue schedule found",
				},
			},
			404 as any,
		);
	}

	const existing = schedules[idx] as StoredSchedule;
	const updated: StoredSchedule = {
		id: existing.id,
		name: body.name ?? existing.name,
		slots: body.slots ?? existing.slots,
		is_default: body.set_as_default ?? existing.is_default,
		created_at: existing.created_at,
		updated_at: new Date().toISOString(),
	};

	schedules[idx] = updated;
	await saveSchedules(c.env.KV, orgId, schedules);

	return c.json(updated, 200);
});

app.openapi(deleteSlots, async (c) => {
	const orgId = c.get("orgId");
	await c.env.KV.delete(`queue-schedule:${orgId}`);

	return c.body(null, 204);
});

app.openapi(getNextSlot, async (c) => {
	const orgId = c.get("orgId");
	const schedules = await getSchedules(c.env.KV, orgId);

	// Use the default schedule, or fall back to the first one
	const schedule =
		schedules.find((s) => s.is_default) ?? (schedules[0] as StoredSchedule | undefined);

	if (!schedule || schedule.slots.length === 0) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "No queue schedule or slots configured",
				},
			},
			404 as any,
		);
	}

	const now = new Date();
	const upcoming = calculateUpcomingSlots(schedule.slots, 1, now);

	if (upcoming.length === 0) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "No upcoming slots found",
				},
			},
			404 as any,
		);
	}

	return c.json(
		{
			next_slot_at: upcoming[0] as string,
			queue_id: schedule.id,
		},
		200,
	);
});

app.openapi(previewSlots, async (c) => {
	const orgId = c.get("orgId");
	const { count } = c.req.valid("query");
	const schedules = await getSchedules(c.env.KV, orgId);

	// Use the default schedule, or fall back to the first one
	const schedule =
		schedules.find((s) => s.is_default) ?? (schedules[0] as StoredSchedule | undefined);

	if (!schedule || schedule.slots.length === 0) {
		return c.json({ slots: [] }, 200);
	}

	const now = new Date();
	const upcoming = calculateUpcomingSlots(schedule.slots, count, now);

	return c.json({ slots: upcoming }, 200);
});

// --- Find slot (smart scheduling) ---

const findSlot = createRoute({
	operationId: "findQueueSlot",
	method: "get",
	path: "/find-slot",
	tags: ["Queue"],
	summary: "Find best available posting slot",
	description:
		"Returns suggested posting times using queue schedule, historical engagement data, and collision avoidance. Use strategy 'smart' (default) to combine all signals.",
	security: [{ Bearer: [] }],
	request: { query: FindSlotQuery },
	responses: {
		200: {
			description: "Suggested posting slots",
			content: { "application/json": { schema: FindSlotResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(findSlot, async (c) => {
	const orgId = c.get("orgId");
	const { account_id, after, strategy, count } = c.req.valid("query");

	const result = await findBestSlots(c.env, orgId, {
		accountId: account_id,
		after: after ? new Date(after) : new Date(),
		strategy,
		count,
	});

	return c.json(result, 200);
});

export default app;
