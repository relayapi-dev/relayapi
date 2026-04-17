import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

// --- Webhook event types ---

export const WebhookEventEnum = z.enum([
	"post.published",
	"post.partial",
	"post.failed",
	"post.scheduled",
	"post.recycled",
	"account.connected",
	"account.disconnected",
	"comment.received",
	"message.received",
	"auto_post.created",
	"auto_post.error",
	"engagement_rule.triggered",
	"cross_post_action.executed",
	"cross_post_action.failed",
]);

// --- Create webhook ---

export const CreateWebhookBody = z.object({
	url: z.string().url().describe("Webhook endpoint URL"),
	events: z.array(WebhookEventEnum).min(1).describe("Events to subscribe to"),
	workspace_id: z.string().optional().describe("Workspace ID to scope this webhook to"),
});

// --- Update webhook ---

export const UpdateWebhookBody = z.object({
	url: z.string().url().optional().describe("Updated endpoint URL"),
	events: z
		.array(WebhookEventEnum)
		.min(1)
		.optional()
		.describe("Updated events"),
	enabled: z.boolean().optional().describe("Enable or disable the webhook"),
});

// --- Webhook response ---

export const WebhookResponse = z.object({
	id: z.string().describe("Webhook ID"),
	url: z.string().url().describe("Endpoint URL"),
	enabled: z.boolean().describe("Whether the webhook is active"),
	events: z.array(z.string()).describe("Subscribed events"),
	created_at: z.string().datetime().describe("Creation timestamp"),
	updated_at: z.string().datetime().describe("Last update timestamp"),
});

// --- Webhook created response (includes secret shown once) ---

export const WebhookCreatedResponse = z.object({
	id: z.string().describe("Webhook ID"),
	url: z.string().url().describe("Endpoint URL"),
	secret: z.string().describe("Webhook signing secret (shown only once)"),
	enabled: z.boolean().describe("Whether the webhook is active"),
	events: z.array(z.string()).describe("Subscribed events"),
	created_at: z.string().datetime().describe("Creation timestamp"),
});

// --- Webhook log entry ---

export const WebhookLogEntry = z.object({
	id: z.string().describe("Log entry ID"),
	webhook_id: z.string().describe("Webhook ID"),
	event: z.string().describe("Event type that triggered the delivery"),
	status_code: z.number().int().nullable().describe("HTTP status code from delivery"),
	response_time_ms: z.number().int().nullable().describe("Response time in milliseconds"),
	success: z.boolean().describe("Whether the delivery was successful"),
	error: z.string().nullable().describe("Error message if delivery failed"),
	payload: z.unknown().nullable().describe("Request body sent to the webhook URL"),
	created_at: z.string().datetime().describe("Delivery timestamp"),
});

// --- Test webhook request ---

export const TestWebhookBody = z.object({
	webhook_id: z.string().describe("ID of the webhook to test"),
});

// --- Test webhook response ---

export const TestWebhookResponse = z.object({
	success: z.boolean().describe("Whether the test delivery succeeded"),
	status_code: z
		.number()
		.int()
		.nullable()
		.describe("HTTP status code from the test delivery"),
	response_time_ms: z
		.number()
		.int()
		.nullable()
		.describe("Response time in milliseconds"),
});

// --- Paginated lists ---

export const WebhookListResponse = paginatedResponse(WebhookResponse);
export const WebhookLogListResponse = paginatedResponse(WebhookLogEntry);
