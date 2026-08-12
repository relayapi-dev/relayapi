import { z } from "@hono/zod-openapi";
import { isContactPhone } from "../lib/contact-phone";
import { paginatedResponse } from "./common";

export const ContactPhoneInput = z
	.string()
	.trim()
	.min(1)
	.max(80)
	.refine((value) => isContactPhone(value), {
		message:
			"Phone must be an international number with a country calling code",
	});

const ContactNameInput = z.string().max(256);
const ContactEmailInput = z.string().max(320);
const ContactChannelIdentifierInput = z.string().max(1024);
const ContactMetadataInput = z
	.record(z.string(), z.unknown())
	.superRefine((value, ctx) => {
		if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65_536) {
			ctx.addIssue({
				code: "custom",
				message: "Contact metadata must not exceed 65536 encoded bytes",
			});
		}
	});

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

export const ContactSegmentMembershipResponse = z.object({
	segment_id: z.string().describe("Segment ID"),
	workspace_id: z.string().nullable().describe("Workspace ID"),
	name: z.string().describe("Segment name"),
	description: z.string().nullable().describe("Segment description"),
	is_dynamic: z
		.boolean()
		.describe("Whether the segment is dynamically computed"),
	source: z.string().describe("Membership source"),
	created_at: z
		.string()
		.datetime()
		.nullable()
		.describe(
			"Stored membership creation time, or null when membership is dynamically derived",
		),
});

export const ContactSegmentMembershipListResponse = z.object({
	data: z.array(ContactSegmentMembershipResponse),
});

export const ConsentStatus = z.enum(["granted", "denied"]);

export const ContactConsentResponse = z.object({
	id: z.string().describe("Immutable consent event ID"),
	contact_id: z.string().nullable().describe("Contact ID, null after deletion"),
	channel: z
		.string()
		.describe("Delivery channel, such as email, sms, or whatsapp"),
	purpose: z
		.string()
		.describe("Consent purpose, such as marketing or automation"),
	status: ConsentStatus,
	identifier_hash: z
		.string()
		.describe("Versioned organization-scoped HMAC identifier fingerprint"),
	identifier_key_version: z
		.string()
		.describe("HMAC key version used for this immutable evidence"),
	identifier_masked: z
		.string()
		.nullable()
		.describe("Masked identifier for audit display"),
	source: z.string().describe("Evidence source"),
	occurred_at: z
		.string()
		.datetime()
		.describe("When consent or withdrawal occurred"),
	evidence: z.record(z.string(), z.unknown()).nullable(),
	policy_version: z.string().nullable(),
	jurisdiction: z.string().nullable(),
	created_at: z.string().datetime(),
});

export const ContactConsentListResponse = paginatedResponse(
	ContactConsentResponse,
);

// =====================
// Contact Response
// =====================

export const ContactResponse = z.object({
	id: z.string().describe("Contact ID"),
	workspace_id: z
		.string()
		.nullable()
		.describe("Workspace ID, or null for organization scope"),
	name: z.string().nullable().optional().describe("Contact name"),
	email: z.string().nullable().optional().describe("Email address"),
	phone: z.string().nullable().optional().describe("Primary phone number"),
	tags: z.array(z.string()).optional().describe("Tags"),
	opted_in: z.boolean().describe("Whether contact has opted in"),
	channels: z.array(ChannelResponse).optional().describe("Platform channels"),
	segment_ids: z
		.array(z.string())
		.optional()
		.describe("Static segment memberships"),
	metadata: z
		.record(z.string(), z.unknown())
		.nullable()
		.optional()
		.describe("Freeform metadata"),
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

export const ContactSegmentParams = z.object({
	id: z.string().describe("Contact ID"),
	segmentId: z.string().describe("Segment ID"),
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
	search: z
		.string()
		.max(320)
		.optional()
		.describe("Search by name, phone, or email"),
	tag: z.string().optional().describe("Filter by tag"),
	segment_id: z
		.string()
		.optional()
		.describe("Filter by static or dynamically-derived segment membership"),
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

export const ContactConsentQuery = z.object({
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Number of consent events"),
});

// =====================
// Bodies
// =====================

export const CreateContactBody = z
	.object({
		workspace_id: z
			.string()
			.optional()
			.describe(
				"Workspace ID. An initial channel supplies its account workspace in either policy mode; without that parent, strict mode requires an explicit value.",
			),
		name: ContactNameInput.optional().describe("Contact name"),
		email: ContactEmailInput.optional().describe("Email address"),
		phone: ContactPhoneInput.optional().describe("Primary phone number"),
		tags: z.array(z.string()).optional().describe("Tags"),
		opted_in: z
			.boolean()
			.optional()
			.describe(
				"Marketing preference. An explicit value is recorded for every known channel.",
			),
		metadata: ContactMetadataInput.optional().describe("Freeform metadata"),
		// Optional first channel (create in one call)
		account_id: z
			.string()
			.optional()
			.describe("Social account ID for initial channel"),
		platform: z.string().optional().describe("Platform for initial channel"),
		identifier: ContactChannelIdentifierInput.optional().describe(
			"Platform identifier for initial channel",
		),
	})
	.superRefine((value, ctx) => {
		const channelFieldCount = [
			value.account_id,
			value.platform,
			value.identifier,
		].filter(Boolean).length;
		if (channelFieldCount !== 0 && channelFieldCount !== 3) {
			ctx.addIssue({
				code: "custom",
				message:
					"account_id, platform, and identifier must be provided together",
				path: ["account_id"],
			});
		}
	});

export const RecordContactConsentBody = z.object({
	channel: z
		.string()
		.trim()
		.toLowerCase()
		.min(1)
		.max(50)
		.describe("Canonical delivery channel"),
	purpose: z
		.string()
		.trim()
		.toLowerCase()
		.min(1)
		.max(100)
		.describe("Canonical consent purpose"),
	status: ConsentStatus.describe("Granted or denied"),
	identifier: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Recipient identifier; inferred from the contact when unambiguous",
		),
	source: z.string().min(1).max(100).describe("Evidence source"),
	occurred_at: z
		.string()
		.datetime()
		.describe(
			"Actual evidence timestamp; cannot be more than five minutes in the future",
		),
	evidence: z.record(z.string(), z.unknown()).optional(),
	policy_version: z.string().max(100).optional(),
	jurisdiction: z.string().max(100).optional(),
});

export const UpdateContactBody = z.object({
	name: ContactNameInput.optional().describe("Contact name"),
	email: ContactEmailInput.optional().describe("Email address"),
	phone: ContactPhoneInput.optional().describe("Primary phone number"),
	tags: z.array(z.string()).optional().describe("Tags (replaces existing)"),
	opted_in: z
		.boolean()
		.optional()
		.describe(
			"Marketing preference. An explicit value updates every known contact channel.",
		),
	metadata: ContactMetadataInput.optional().describe("Freeform metadata"),
});

export const AddChannelBody = z.object({
	account_id: z.string().describe("Social account ID"),
	platform: z.string().describe("Platform name"),
	identifier: ContactChannelIdentifierInput.describe("Platform identifier"),
});

export const BulkCreateContactsBody = z.object({
	workspace_id: z
		.string()
		.optional()
		.describe(
			"Workspace ID. Channel accounts supply their shared workspace in either policy mode; without those parents, strict mode requires an explicit value.",
		),
	contacts: z
		.array(
			z
				.object({
					name: ContactNameInput.optional(),
					email: ContactEmailInput.optional(),
					phone: ContactPhoneInput.optional(),
					tags: z.array(z.string()).optional(),
					account_id: z.string().optional(),
					platform: z.string().optional(),
					identifier: ContactChannelIdentifierInput.optional(),
				})
				.superRefine((value, ctx) => {
					const channelFieldCount = [
						value.account_id,
						value.platform,
						value.identifier,
					].filter(Boolean).length;
					if (channelFieldCount !== 0 && channelFieldCount !== 3) {
						ctx.addIssue({
							code: "custom",
							message:
								"account_id, platform, and identifier must be provided together",
							path: ["account_id"],
						});
					}
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
	merge_contact_id: z
		.string()
		.describe("ID of the contact to merge into this one (will be deleted)"),
});

export const MergeContactResponse = z.object({
	channels_moved: z.number().describe("Number of channels moved"),
	fields_moved: z.number().describe("Number of custom field values moved"),
	recipients_updated: z
		.number()
		.describe("Number of broadcast recipients updated"),
	conversations_updated: z
		.number()
		.describe("Number of inbox conversations updated"),
	enrollments_updated: z
		.number()
		.describe("Number of automation enrollments (runs) re-parented"),
});

export const SetContactFieldBody = z.object({
	value: z.string().describe("Field value"),
});

export const SetContactFieldResponse = z.object({
	success: z.boolean(),
	field: z.string(),
	value: z.string(),
});
