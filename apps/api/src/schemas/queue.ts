import { z } from "@hono/zod-openapi";

// --- Queue slot ---

export const QueueSlot = z.object({
	day_of_week: z
		.number()
		.int()
		.min(0)
		.max(6)
		.describe("Day of week (0=Sunday, 6=Saturday)"),
	time: z
		.string()
		.regex(/^\d{2}:\d{2}$/)
		.describe("Time in HH:MM format"),
	timezone: z.string().describe("IANA timezone (e.g. America/New_York)"),
});

// --- Queue schedule ---

export const QueueSchedule = z.object({
	id: z.string().describe("Queue schedule ID"),
	name: z.string().nullable().optional().describe("Schedule name"),
	slots: z.array(QueueSlot).describe("Time slots"),
	is_default: z.boolean().describe("Whether this is the default schedule"),
	created_at: z.string().datetime().describe("Created timestamp"),
	updated_at: z.string().datetime().describe("Updated timestamp"),
});

// --- Create queue ---

export const CreateQueueBody = z.object({
	name: z.string().optional().describe("Schedule name"),
	slots: z.array(QueueSlot).min(1).describe("Time slots"),
	timezone: z.string().describe("Default timezone for slots"),
});

// --- Update queue ---

export const UpdateQueueBody = z.object({
	name: z.string().optional().describe("Schedule name"),
	slots: z.array(QueueSlot).optional().describe("Updated time slots"),
	set_as_default: z
		.boolean()
		.optional()
		.describe("Set this schedule as the default"),
});

// --- Next slot ---

export const NextSlotResponse = z.object({
	next_slot_at: z
		.string()
		.datetime()
		.describe("Next available slot (ISO 8601)"),
	queue_id: z.string().describe("Queue schedule ID"),
});

// --- Preview ---

export const PreviewQuery = z.object({
	count: z.coerce
		.number()
		.int()
		.min(1)
		.max(50)
		.default(10)
		.describe("Number of upcoming slots to preview"),
});

export const PreviewResponse = z.object({
	slots: z
		.array(z.string().datetime())
		.describe("Upcoming slot timestamps (ISO 8601)"),
});

// --- List response ---

export const QueueListResponse = z.object({
	data: z.array(QueueSchedule),
});

// --- Find slot ---

export const FindSlotQuery = z.object({
	account_id: z.string().optional().describe("Account ID to optimize for"),
	after: z
		.string()
		.datetime({ offset: true })
		.optional()
		.describe("Earliest allowed time (ISO 8601). Defaults to now."),
	strategy: z
		.enum(["queue", "best-time", "smart"])
		.default("smart")
		.describe("Algorithm strategy: queue (slots only), best-time (engagement only), or smart (combined)"),
	count: z.coerce
		.number()
		.int()
		.min(1)
		.max(10)
		.default(1)
		.describe("Number of slot suggestions to return"),
});

export const FindSlotCandidate = z.object({
	slot_at: z.string().datetime().describe("Suggested posting time (ISO 8601)"),
	score: z.number().describe("Confidence score 0-100"),
	reason: z
		.enum(["queue_slot", "best_time", "hybrid"])
		.describe("Why this slot was suggested"),
	conflicts: z.number().describe("Number of existing posts at this time"),
});

export const FindSlotResponse = z.object({
	slots: z.array(FindSlotCandidate),
	fallback: z.boolean().describe("True if no ideal slot found, result is best-effort"),
});
