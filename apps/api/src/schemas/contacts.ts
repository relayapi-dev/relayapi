import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

// =====================
// Channel
// =====================

export const ChannelResponse = z.object({
	id: z.string().describe("Channel ID"),
	social_account_id: z.string().describe("Connected social account ID"),
	platform: z.string().describe("Platform name"),
	identifier: z.string().describe("Platform identifier (phone, username, ID)"),
	created_at: z.string().datetime().describe("Created timestamp"),
});

// =====================
// Contact Response
// =====================

export const ContactResponse = z.object({
	id: z.string().describe("Contact ID"),
	name: z.string().nullable().optional().describe("Contact name"),
	email: z.string().nullable().optional().describe("Email address"),
	phone: z.string().nullable().optional().describe("Primary phone number"),
	tags: z.array(z.string()).optional().describe("Tags"),
	opted_in: z.boolean().describe("Whether contact has opted in"),
	channels: z.array(ChannelResponse).optional().describe("Platform channels"),
	metadata: z.record(z.string(), z.unknown()).nullable().optional().describe("Freeform metadata"),
	created_at: z.string().datetime().describe("Created timestamp"),
	updated_at: z.string().datetime().describe("Last update timestamp"),
});

export const ContactListResponse = paginatedResponse(ContactResponse);

// =====================
// Params
// =====================

export const ContactIdParams = z.object({
	id: z.string().describe("Contact ID"),
});

export const ChannelIdParams = z.object({
	id: z.string().describe("Contact ID"),
	channelId: z.string().describe("Channel ID"),
});

export const ContactFieldParams = z.object({
	id: z.string().describe("Contact ID"),
	slug: z.string().describe("Custom field slug"),
});

// =====================
// Query
// =====================

export const ContactQuery = z.object({
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
	search: z.string().optional().describe("Search by name, phone, or email"),
	tag: z.string().optional().describe("Filter by tag"),
	platform: z.string().optional().describe("Filter by platform"),
	account_id: z.string().optional().describe("Filter by social account ID"),
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Number of items"),
});

// =====================
// Bodies
// =====================

export const CreateContactBody = z.object({
	workspace_id: z.string().describe("Workspace ID"),
	name: z.string().optional().describe("Contact name"),
	email: z.string().optional().describe("Email address"),
	phone: z.string().optional().describe("Primary phone number"),
	tags: z.array(z.string()).optional().describe("Tags"),
	opted_in: z.boolean().optional().describe("Opt-in status"),
	metadata: z.record(z.string(), z.unknown()).optional().describe("Freeform metadata"),
	// Optional first channel (create in one call)
	account_id: z.string().optional().describe("Social account ID for initial channel"),
	platform: z.string().optional().describe("Platform for initial channel"),
	identifier: z.string().optional().describe("Platform identifier for initial channel"),
});

export const UpdateContactBody = z.object({
	name: z.string().optional().describe("Contact name"),
	email: z.string().optional().describe("Email address"),
	phone: z.string().optional().describe("Primary phone number"),
	tags: z.array(z.string()).optional().describe("Tags (replaces existing)"),
	opted_in: z.boolean().optional().describe("Opt-in status"),
	metadata: z.record(z.string(), z.unknown()).optional().describe("Freeform metadata"),
});

export const AddChannelBody = z.object({
	account_id: z.string().describe("Social account ID"),
	platform: z.string().describe("Platform name"),
	identifier: z.string().describe("Platform identifier"),
});

export const BulkCreateContactsBody = z.object({
	workspace_id: z.string().describe("Workspace ID"),
	contacts: z
		.array(
			z.object({
				name: z.string().optional(),
				email: z.string().optional(),
				phone: z.string().optional(),
				tags: z.array(z.string()).optional(),
				account_id: z.string().optional(),
				platform: z.string().optional(),
				identifier: z.string().optional(),
			}),
		)
		.min(1)
		.max(1000)
		.describe("Contacts to create"),
});

export const BulkCreateContactsResponse = z.object({
	created: z.number().describe("Successfully created count"),
	skipped: z.number().describe("Skipped (duplicate) count"),
});

export const BulkOperationsBody = z.object({
	contact_ids: z.array(z.string()).min(1).max(500).describe("Contact IDs"),
	action: z.enum(["add_tags", "remove_tags", "delete"]).describe("Action"),
	tags: z.array(z.string()).optional().describe("Tags (for tag actions)"),
});

export const BulkOperationsResponse = z.object({
	affected: z.number().describe("Number of contacts affected"),
});

export const MergeContactBody = z.object({
	merge_contact_id: z.string().describe("ID of the contact to merge into this one (will be deleted)"),
});

export const MergeContactResponse = z.object({
	channels_moved: z.number().describe("Number of channels moved"),
	fields_moved: z.number().describe("Number of custom field values moved"),
	recipients_updated: z.number().describe("Number of broadcast recipients updated"),
	conversations_updated: z.number().describe("Number of inbox conversations updated"),
});

export const SetContactFieldBody = z.object({
	value: z.string().describe("Field value"),
});

export const SetContactFieldResponse = z.object({
	success: z.boolean(),
	field: z.string(),
	value: z.string(),
});
