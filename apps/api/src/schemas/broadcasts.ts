import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

// --- Template (WhatsApp only) ---

const TemplateInput = z.object({
	name: z.string().describe("WhatsApp template name"),
	language: z.string().default("en_US").describe("Template language code"),
	components: z
		.array(z.record(z.string(), z.any()))
		.optional()
		.describe("Template components"),
});

// --- Broadcast ---

export const CreateBroadcastBody = z.object({
	account_id: z.string().describe("Social account ID"),
	name: z.string().optional().describe("Broadcast name"),
	description: z.string().optional().describe("Broadcast description"),
	message_text: z
		.string()
		.optional()
		.describe("Message text (required for non-WhatsApp platforms)"),
	template: TemplateInput.optional().describe(
		"WhatsApp template (required for WhatsApp broadcasts)",
	),
	workspace_id: z.string().optional().describe("Workspace ID to scope this broadcast to"),
});

export const UpdateBroadcastBody = z.object({
	name: z.string().optional(),
	description: z.string().nullable().optional(),
	message_text: z.string().optional(),
	template: TemplateInput.optional(),
});

export const ScheduleBroadcastBody = z.object({
	scheduled_at: z
		.string()
		.datetime({ offset: true })
		.describe("ISO 8601 datetime for when to send the broadcast"),
});

export const BroadcastIdParams = z.object({
	id: z.string().describe("Broadcast ID"),
});

export const BroadcastListQuery = z.object({
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
	account_id: z.string().optional().describe("Filter by account ID"),
	status: z
		.enum([
			"draft",
			"scheduled",
			"sending",
			"sent",
			"partially_failed",
			"failed",
			"cancelled",
		])
		.optional()
		.describe("Filter by status"),
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Number of items per page"),
});

export const BroadcastResponse = z.object({
	id: z.string(),
	name: z.string().nullable(),
	description: z.string().nullable(),
	platform: z.string(),
	account_id: z.string(),
	status: z.enum([
		"draft",
		"scheduled",
		"sending",
		"sent",
		"partially_failed",
		"failed",
		"cancelled",
	]),
	message_text: z.string().nullable(),
	template_name: z.string().nullable(),
	template_language: z.string().nullable(),
	recipient_count: z.number().int(),
	sent_count: z.number().int(),
	failed_count: z.number().int(),
	scheduled_at: z.string().datetime().nullable(),
	completed_at: z.string().datetime().nullable(),
	created_at: z.string().datetime(),
});

export const BroadcastListResponse = paginatedResponse(BroadcastResponse);

// --- Recipients ---

export const AddRecipientsBody = z.object({
	phones: z
		.array(z.string())
		.optional()
		.describe("Phone numbers in E.164 format (WhatsApp)"),
	contact_ids: z
		.array(z.string())
		.optional()
		.describe("Contact IDs to resolve platform identifiers from"),
	identifiers: z
		.array(z.string())
		.optional()
		.describe("Raw platform identifiers (IG user ID, chat ID, etc.)"),
});

export const RecipientListQuery = z.object({
	status: z
		.enum(["pending", "sent", "failed"])
		.optional()
		.describe("Filter by delivery status"),
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Number of items per page"),
});

export const RecipientResponse = z.object({
	id: z.string(),
	contact_id: z.string().nullable(),
	contact_identifier: z.string(),
	status: z.enum(["pending", "sent", "failed"]),
	message_id: z.string().nullable(),
	error: z.string().nullable(),
	sent_at: z.string().datetime().nullable(),
});

export const RecipientListResponse = paginatedResponse(RecipientResponse);

export const AddRecipientsResponse = z.object({
	added: z.number().describe("Number of recipients added"),
	skipped: z.number().describe("Number of duplicates skipped"),
});
