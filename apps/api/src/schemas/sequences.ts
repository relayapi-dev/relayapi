import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

// --- Sequence Steps ---

const SequenceStepInput = z.object({
	order: z.number().int().min(0).describe("Step position (0-based)"),
	delay_minutes: z.number().int().min(0).describe("Delay in minutes from previous step"),
	message_type: z
		.enum(["text", "template"])
		.default("text")
		.describe("Message type"),
	message_text: z
		.string()
		.optional()
		.describe("Message text (for text type)"),
	template_name: z
		.string()
		.optional()
		.describe("WhatsApp template name (for template type)"),
	template_language: z
		.string()
		.optional()
		.describe("Template language code"),
	template_components: z
		.array(z.record(z.string(), z.any()))
		.optional()
		.describe("Template components"),
});

const SequenceStepResponse = z.object({
	id: z.string(),
	order: z.number().int(),
	delay_minutes: z.number().int(),
	message_type: z.enum(["text", "template"]),
	message_text: z.string().nullable().optional(),
	template_name: z.string().nullable().optional(),
	template_language: z.string().nullable().optional(),
	template_components: z.any().nullable().optional(),
	created_at: z.string().datetime(),
});

// --- Sequence ---

export const CreateSequenceBody = z.object({
	name: z.string().min(1).max(255).describe("Sequence name"),
	description: z.string().optional().describe("Description"),
	platform: z.string().describe("Target platform"),
	account_id: z.string().describe("Social account ID"),
	exit_on_reply: z.boolean().default(true).describe("Exit enrollment on reply"),
	exit_on_unsubscribe: z
		.boolean()
		.default(true)
		.describe("Exit enrollment on unsubscribe"),
	steps: z
		.array(SequenceStepInput)
		.optional()
		.describe("Sequence steps (can be added later)"),
	workspace_id: z.string().optional().describe("Workspace ID to scope this sequence to"),
});

export const UpdateSequenceBody = z.object({
	name: z.string().min(1).max(255).optional(),
	description: z.string().nullable().optional(),
	exit_on_reply: z.boolean().optional(),
	exit_on_unsubscribe: z.boolean().optional(),
	steps: z.array(SequenceStepInput).optional().describe("Replace all steps"),
});

export const SequenceResponse = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().nullable().optional(),
	platform: z.string(),
	account_id: z.string(),
	status: z.enum(["draft", "active", "paused"]),
	exit_on_reply: z.boolean(),
	exit_on_unsubscribe: z.boolean(),
	steps_count: z.number().int(),
	total_enrolled: z.number().int(),
	total_completed: z.number().int(),
	total_exited: z.number().int(),
	created_at: z.string().datetime(),
});

export const SequenceDetailResponse = SequenceResponse.extend({
	steps: z.array(SequenceStepResponse),
});

export const SequenceListResponse = paginatedResponse(SequenceResponse);

export const SequenceIdParams = z.object({
	id: z.string().describe("Sequence ID"),
});

// --- Enrollments ---

export const EnrollBody = z.object({
	contact_ids: z
		.array(z.string())
		.min(1)
		.max(1000)
		.describe("Contact IDs to enroll"),
});

export const EnrollResponse = z.object({
	enrolled: z.number().describe("Successfully enrolled count"),
	skipped: z.number().describe("Already enrolled / skipped count"),
});

export const EnrollmentIdParams = z.object({
	id: z.string().describe("Sequence ID"),
	enrollment_id: z.string().describe("Enrollment ID"),
});

export const EnrollmentResponse = z.object({
	id: z.string(),
	contact_id: z.string(),
	contact_identifier: z.string(),
	status: z.enum(["active", "completed", "exited", "paused"]),
	current_step_index: z.number().int(),
	steps_sent: z.number().int(),
	next_step_at: z.string().datetime().nullable().optional(),
	last_step_sent_at: z.string().datetime().nullable().optional(),
	exit_reason: z.string().nullable().optional(),
	enrolled_at: z.string().datetime(),
});

export const EnrollmentListResponse = paginatedResponse(EnrollmentResponse);
