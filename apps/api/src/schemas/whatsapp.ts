import { z } from "@hono/zod-openapi";

function isHttpsUrl(url: string): boolean {
	try {
		return new URL(url).protocol === "https:";
	} catch {
		return false;
	}
}

// =====================
// Bulk Send
// =====================

export const BulkSendRecipient = z.object({
	phone: z.string().describe("Phone number in E.164 format"),
	variables: z
		.record(z.string(), z.string())
		.optional()
		.describe("Template variable substitutions"),
});

export const TemplateComponent = z.object({
	type: z.enum(["header", "body", "button"]).describe("Component type"),
	parameters: z
		.array(z.record(z.string(), z.any()))
		.optional()
		.describe("Component parameters"),
});

export const BulkSendBody = z.object({
	account_id: z.string().describe("WhatsApp account ID"),
	recipients: z
		.array(BulkSendRecipient)
		.min(1)
		.max(1000)
		.describe("Recipients"),
	template: z.object({
		name: z.string().describe("Template name"),
		language: z.string().describe("Template language code"),
		components: z
			.array(TemplateComponent)
			.optional()
			.describe("Template components"),
	}),
});

export const BulkSendResultItem = z.object({
	phone: z.string().describe("Recipient phone number"),
	status: z.enum(["sent", "failed"]).describe("Send status"),
	error: z.string().nullable().optional().describe("Error message if failed"),
});

export const BulkSendResponse = z.object({
	summary: z.object({
		sent: z.number().describe("Successfully sent count"),
		failed: z.number().describe("Failed count"),
	}),
	results: z.array(BulkSendResultItem),
});

// =====================
// Broadcasts
// =====================

export const BroadcastResponse = z.object({
	id: z.string().describe("Broadcast ID"),
	name: z.string().describe("Broadcast name"),
	status: z
		.enum(["draft", "scheduled", "sending", "sent", "partially_failed", "failed"])
		.describe("Broadcast status"),
	template: z.string().describe("Template name"),
	recipient_count: z.number().describe("Total recipients"),
	sent: z.number().optional().describe("Successfully sent"),
	failed: z.number().optional().describe("Failed sends"),
	scheduled_at: z
		.string()
		.datetime()
		.nullable()
		.optional()
		.describe("Scheduled time"),
	created_at: z.string().datetime().describe("Created timestamp"),
});

export const CreateBroadcastBody = z.object({
	account_id: z.string().describe("WhatsApp account ID"),
	name: z.string().describe("Broadcast name"),
	template: z.object({
		name: z.string().describe("Template name"),
		language: z.string().describe("Template language code"),
		components: z.array(TemplateComponent).optional(),
	}),
	recipients: z.array(BulkSendRecipient).min(1).describe("Recipient list"),
	scheduled_at: z
		.string()
		.optional()
		.describe("ISO 8601 timestamp to schedule send"),
});

export const BroadcastIdParams = z.object({
	broadcast_id: z.string().describe("Broadcast ID"),
});

export const BroadcastListResponse = z.object({
	data: z.array(BroadcastResponse),
});

// =====================
// Templates
// =====================

export const TemplateComponentSchema = z.object({
	type: z
		.enum(["HEADER", "BODY", "FOOTER", "BUTTONS"])
		.describe("Component type"),
	text: z.string().optional().describe("Component text"),
	format: z.string().optional().describe("Header format (TEXT, IMAGE, etc.)"),
	buttons: z
		.array(
			z.object({
				type: z.string().describe("Button type"),
				text: z.string().describe("Button text"),
				url: z.string().optional(),
				phone_number: z.string().optional(),
			}),
		)
		.optional(),
});

export const TemplateResponse = z.object({
	name: z.string().describe("Template name"),
	language: z.string().describe("Template language code"),
	status: z
		.enum(["APPROVED", "PENDING", "REJECTED"])
		.describe("Approval status"),
	category: z
		.enum(["MARKETING", "UTILITY", "AUTHENTICATION"])
		.describe("Template category"),
	components: z.array(TemplateComponentSchema),
});

export const CreateTemplateBody = z.object({
	account_id: z.string().describe("WhatsApp account ID"),
	name: z.string().describe("Template name"),
	language: z.string().describe("Template language code"),
	category: z
		.enum(["MARKETING", "UTILITY", "AUTHENTICATION"])
		.describe("Template category"),
	components: z.array(TemplateComponentSchema).describe("Template components"),
});

export const TemplateIdParams = z.object({
	template_name: z.string().describe("Template name"),
});

export const TemplateListResponse = z.object({
	data: z.array(TemplateResponse),
});

// =====================
// Groups
// =====================

export const GroupResponse = z.object({
	id: z.string().describe("Group ID"),
	name: z.string().describe("Group name"),
	description: z.string().nullable().optional(),
	contact_count: z.number().describe("Number of contacts"),
	created_at: z.string().datetime().describe("Created timestamp"),
});

export const CreateGroupBody = z.object({
	account_id: z.string().describe("WhatsApp account ID"),
	name: z.string().describe("Group name"),
	description: z.string().optional().describe("Group description"),
	contact_ids: z.array(z.string()).optional().describe("Initial contact IDs"),
});

export const GroupIdParams = z.object({
	group_id: z.string().describe("Group ID"),
});

export const GroupListResponse = z.object({
	data: z.array(GroupResponse),
});

// =====================
// Business Profile
// =====================

export const BusinessProfileResponse = z.object({
	about: z.string().nullable().optional().describe("About text"),
	description: z.string().nullable().optional().describe("Description"),
	email: z.string().nullable().optional().describe("Business email"),
	websites: z.array(z.string()).optional().describe("Website URLs"),
	address: z.string().nullable().optional().describe("Business address"),
	profile_picture_url: z
		.string()
		.nullable()
		.optional()
		.describe("Profile picture URL"),
});

export const UpdateBusinessProfileBody = z.object({
	account_id: z.string().describe("WhatsApp account ID"),
	about: z.string().optional(),
	description: z.string().optional(),
	email: z.string().optional(),
	websites: z.array(z.string()).optional(),
	address: z.string().optional(),
});

// =====================
// Phone Numbers
// =====================

export const PhoneNumberResponse = z.object({
	id: z.string().describe("Phone number ID"),
	phone_number: z.string().describe("Phone number"),
	status: z
		.enum(["active", "inactive", "pending"])
		.describe("Registration status"),
	display_name: z.string().nullable().optional().describe("Display name"),
});

export const PhoneNumberListResponse = z.object({
	data: z.array(PhoneNumberResponse),
});

export const AccountIdQuery = z.object({
	account_id: z.string().describe("WhatsApp account ID"),
});

// =====================
// Phone Number Provisioning
// =====================

export const ProvisionedPhoneNumberResponse = z.object({
	id: z.string().describe("Phone number resource ID"),
	phone_number: z.string().describe("E.164 phone number"),
	status: z
		.enum([
			"purchasing",
			"pending_verification",
			"verified",
			"active",
			"releasing",
			"released",
		])
		.describe("Provisioning status"),
	provider: z.string().describe("Carrier provider"),
	country: z.string().describe("ISO country code"),
	wa_phone_number_id: z
		.string()
		.nullable()
		.optional()
		.describe("Meta WhatsApp phone number ID"),
	social_account_id: z
		.string()
		.nullable()
		.optional()
		.describe("Linked RelayAPI social account ID"),
	monthly_cost_cents: z.number().describe("Monthly cost in cents"),
	created_at: z.string().datetime().describe("Created timestamp"),
});

export const ProvisionedPhoneNumberListResponse = z.object({
	data: z.array(ProvisionedPhoneNumberResponse),
});

export const PurchasePhoneNumberBody = z.object({
	account_id: z
		.string()
		.describe("WhatsApp social account ID (for WABA credentials)"),
	country: z
		.enum(["US"])
		.default("US")
		.describe("Country code (only US supported)"),
	area_code: z
		.string()
		.regex(/^\d{3}$/)
		.optional()
		.describe("3-digit US area code preference"),
});

export const PurchasePhoneNumberResponse = z.object({
	id: z.string().describe("Phone number resource ID"),
	phone_number: z.string().describe("Purchased phone number"),
	status: z.string().describe("Current status"),
	checkout_url: z
		.string()
		.nullable()
		.optional()
		.describe("Stripe checkout URL (first number only)"),
});

export const PhoneNumberIdParams = z.object({
	phone_number_id: z.string().describe("Phone number resource ID"),
});

export const RequestCodeBody = z.object({
	method: z
		.enum(["sms", "voice"])
		.describe("Verification code delivery method"),
});

export const VerifyCodeBody = z.object({
	code: z
		.string()
		.length(6)
		.regex(/^\d+$/)
		.describe("6-digit verification code"),
});

export const PhoneNumberStatusQuery = z.object({
	status: z
		.enum([
			"purchasing",
			"pending_verification",
			"verified",
			"active",
			"releasing",
			"released",
		])
		.optional()
		.describe("Filter by provisioning status"),
});

// =====================
// Display Name
// =====================

export const UpdateDisplayNameBody = z.object({
	account_id: z.string().describe("WhatsApp account ID"),
	display_name: z
		.string()
		.min(3)
		.max(512)
		.describe("New display name (3-512 chars, must represent your business)"),
});

export const DisplayNameResponse = z.object({
	display_name: z.string().nullable().describe("Current verified display name"),
	review_status: z
		.string()
		.nullable()
		.optional()
		.describe("Meta review status for pending name change"),
});

// =====================
// Profile Photo
// =====================

export const UploadProfilePhotoBody = z.object({
	account_id: z.string().describe("WhatsApp account ID"),
	photo_url: z
		.string()
		.url()
		.refine(isHttpsUrl, "URL must use https")
		.describe("Public URL of the photo to upload"),
});

export const UploadProfilePhotoResponse = z.object({
	success: z.boolean(),
	profile_picture_url: z.string().nullable().describe("Updated profile picture URL"),
});

// =====================
// WhatsApp Flows
// =====================

export const FlowResponse = z.object({
	id: z.string().describe("Flow ID"),
	name: z.string().describe("Flow name"),
	status: z.enum(["DRAFT", "PUBLISHED", "DEPRECATED", "BLOCKED", "THROTTLED"]).describe("Flow status"),
	categories: z.array(z.string()).describe("Flow categories"),
	validation_errors: z.array(z.object({
		error: z.string(),
		error_type: z.string(),
		message: z.string(),
		line_start: z.number().optional(),
		line_end: z.number().optional(),
		column_start: z.number().optional(),
		column_end: z.number().optional(),
	})).optional().describe("Validation errors (DRAFT flows)"),
	preview: z.object({
		preview_url: z.string(),
		expires_at: z.string(),
	}).nullable().optional().describe("Preview URL and expiry"),
	json_version: z.string().optional().describe("Flow JSON version"),
	data_api_version: z.string().optional().describe("Data API version"),
});

export const FlowListResponse = z.object({
	data: z.array(FlowResponse),
});

export const CreateFlowBody = z.object({
	account_id: z.string().describe("WhatsApp account ID"),
	name: z.string().describe("Flow name"),
	categories: z
		.array(z.enum([
			"SIGN_UP", "SIGN_IN", "APPOINTMENT_BOOKING", "LEAD_GENERATION",
			"CONTACT_US", "CUSTOMER_SUPPORT", "SURVEY", "OTHER",
		]))
		.min(1)
		.describe("Flow categories"),
	clone_flow_id: z.string().optional().describe("Existing flow ID to clone"),
});

export const UpdateFlowBody = z.object({
	account_id: z.string().describe("WhatsApp account ID"),
	name: z.string().optional().describe("New flow name"),
	categories: z
		.array(z.enum([
			"SIGN_UP", "SIGN_IN", "APPOINTMENT_BOOKING", "LEAD_GENERATION",
			"CONTACT_US", "CUSTOMER_SUPPORT", "SURVEY", "OTHER",
		]))
		.optional()
		.describe("New categories"),
});

export const FlowIdParams = z.object({
	flow_id: z.string().describe("WhatsApp Flow ID"),
});

export const UploadFlowJsonBody = z.object({
	account_id: z.string().describe("WhatsApp account ID"),
	flow_json: z.record(z.string(), z.any()).describe("Flow JSON definition (WhatsApp Flows schema)"),
});

export const FlowAccountIdBody = z.object({
	account_id: z.string().describe("WhatsApp account ID"),
});

export const SendFlowBody = z.object({
	account_id: z.string().describe("WhatsApp account ID"),
	recipient_phone: z.string().describe("Recipient phone number in E.164 format"),
	flow_id: z.string().describe("Published flow ID"),
	flow_token: z.string().describe("Unique token for this flow session"),
	header_text: z.string().optional().describe("Message header text"),
	body_text: z.string().describe("Message body text"),
	footer_text: z.string().optional().describe("Message footer text"),
	cta_text: z.string().describe("CTA button text"),
	screen_id: z.string().describe("Initial screen ID to display"),
	flow_data: z.record(z.string(), z.any()).optional().describe("Initial data to pass to the flow"),
});
