import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	createDb,
	socialAccounts,
	whatsappBroadcasts,
	whatsappBroadcastRecipients,
} from "@relayapi/db";
import { and, eq, desc } from "drizzle-orm";
import { maybeDecrypt } from "../lib/crypto";
import { fetchPublicUrl } from "../lib/fetch-public-url";
import { ErrorResponse } from "../schemas/common";
import {
	AccountIdQuery,
	BroadcastIdParams,
	BroadcastListResponse,
	BroadcastResponse,
	BulkSendBody,
	BulkSendResponse,
	BusinessProfileResponse,
	CreateBroadcastBody,
	CreateTemplateBody,
	PhoneNumberListResponse,
	TemplateIdParams,
	TemplateListResponse,
	TemplateResponse,
	UpdateBusinessProfileBody,
	UpdateDisplayNameBody,
	DisplayNameResponse,
	UploadProfilePhotoBody,
	UploadProfilePhotoResponse,
	FlowResponse,
	FlowListResponse,
	CreateFlowBody,
	UpdateFlowBody,
	FlowIdParams,
	UploadFlowJsonBody,
	FlowAccountIdBody,
	SendFlowBody,
} from "../schemas/whatsapp";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const WA_API_BASE = "https://graph.facebook.com/v25.0";

// ---------------------------------------------------------------------------
// Helper: look up a WhatsApp social account by its relay account_id + org
// ---------------------------------------------------------------------------

async function getWhatsAppAccount(
	db: ReturnType<typeof createDb>,
	accountId: string,
	orgId: string,
	encryptionKey?: string,
	workspaceScope: "all" | string[] = "all",
) {
	const [account] = await db
		.select()
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, accountId),
				eq(socialAccounts.organizationId, orgId),
				eq(socialAccounts.platform, "whatsapp"),
			),
		)
		.limit(1);
	if (!account) return null;
	if (workspaceScope !== "all") {
		if (!account.workspaceId || !workspaceScope.includes(account.workspaceId)) {
			return null;
		}
	}
	return {
		...account,
		accessToken: await maybeDecrypt(account.accessToken, encryptionKey),
		refreshToken: await maybeDecrypt(account.refreshToken, encryptionKey),
	};
}

// =====================
// Bulk Send
// =====================

const bulkSend = createRoute({
	operationId: "whatsappBulkSend",
	method: "post",
	path: "/bulk-send",
	tags: ["WhatsApp"],
	summary: "Send bulk WhatsApp messages via template",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: BulkSendBody } },
		},
	},
	responses: {
		200: {
			description: "Bulk send result",
			content: { "application/json": { schema: BulkSendResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// =====================
// Broadcasts
// =====================

const listBroadcasts = createRoute({
	operationId: "whatsappListBroadcasts",
	method: "get",
	path: "/broadcasts",
	tags: ["WhatsApp"],
	summary: "List broadcasts",
	deprecated: true,
	description: "Deprecated. Use GET /v1/broadcasts instead.",
	security: [{ Bearer: [] }],
	request: { query: AccountIdQuery },
	responses: {
		200: {
			description: "Broadcasts list",
			content: {
				"application/json": { schema: BroadcastListResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const createBroadcast = createRoute({
	operationId: "whatsappCreateBroadcast",
	method: "post",
	path: "/broadcasts",
	tags: ["WhatsApp"],
	summary: "Create a broadcast",
	deprecated: true,
	description: "Deprecated. Use POST /v1/broadcasts instead.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateBroadcastBody } },
		},
	},
	responses: {
		201: {
			description: "Broadcast created",
			content: {
				"application/json": { schema: BroadcastResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getBroadcast = createRoute({
	operationId: "whatsappGetBroadcast",
	method: "get",
	path: "/broadcasts/{broadcast_id}",
	tags: ["WhatsApp"],
	summary: "Get broadcast details",
	deprecated: true,
	description: "Deprecated. Use GET /v1/broadcasts/{id} instead.",
	security: [{ Bearer: [] }],
	request: { params: BroadcastIdParams },
	responses: {
		200: {
			description: "Broadcast details",
			content: {
				"application/json": { schema: BroadcastResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteBroadcast = createRoute({
	operationId: "whatsappDeleteBroadcast",
	method: "delete",
	path: "/broadcasts/{broadcast_id}",
	tags: ["WhatsApp"],
	summary: "Delete a broadcast",
	deprecated: true,
	description: "Deprecated. Use DELETE /v1/broadcasts/{id} instead.",
	security: [{ Bearer: [] }],
	request: { params: BroadcastIdParams },
	responses: {
		204: { description: "Broadcast deleted" },
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const sendBroadcast = createRoute({
	operationId: "whatsappSendBroadcast",
	method: "post",
	path: "/broadcasts/{broadcast_id}/send",
	tags: ["WhatsApp"],
	summary: "Send a broadcast immediately",
	deprecated: true,
	description: "Deprecated. Use POST /v1/broadcasts/{id}/send instead.",
	security: [{ Bearer: [] }],
	request: { params: BroadcastIdParams },
	responses: {
		200: {
			description: "Broadcast sent",
			content: {
				"application/json": { schema: BroadcastResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const scheduleBroadcast = createRoute({
	operationId: "whatsappScheduleBroadcast",
	method: "post",
	path: "/broadcasts/{broadcast_id}/schedule",
	tags: ["WhatsApp"],
	summary: "Schedule a broadcast",
	deprecated: true,
	description: "Deprecated. Use POST /v1/broadcasts/{id}/schedule instead.",
	security: [{ Bearer: [] }],
	request: { params: BroadcastIdParams },
	responses: {
		200: {
			description: "Broadcast scheduled",
			content: {
				"application/json": { schema: BroadcastResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// =====================
// Templates
// =====================

const listTemplates = createRoute({
	operationId: "listWhatsAppTemplates",
	method: "get",
	path: "/templates",
	tags: ["WhatsApp"],
	summary: "List message templates",
	security: [{ Bearer: [] }],
	request: { query: AccountIdQuery },
	responses: {
		200: {
			description: "Templates list",
			content: {
				"application/json": { schema: TemplateListResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const createTemplate = createRoute({
	operationId: "createWhatsAppTemplate",
	method: "post",
	path: "/templates",
	tags: ["WhatsApp"],
	summary: "Create a message template",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateTemplateBody } },
		},
	},
	responses: {
		201: {
			description: "Template created",
			content: {
				"application/json": { schema: TemplateResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getTemplate = createRoute({
	operationId: "getWhatsAppTemplate",
	method: "get",
	path: "/templates/{template_name}",
	tags: ["WhatsApp"],
	summary: "Get template details",
	security: [{ Bearer: [] }],
	request: { params: TemplateIdParams, query: AccountIdQuery },
	responses: {
		200: {
			description: "Template details",
			content: {
				"application/json": { schema: TemplateResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteTemplate = createRoute({
	operationId: "deleteWhatsAppTemplate",
	method: "delete",
	path: "/templates/{template_name}",
	tags: ["WhatsApp"],
	summary: "Delete a message template",
	security: [{ Bearer: [] }],
	request: { params: TemplateIdParams, query: AccountIdQuery },
	responses: {
		204: { description: "Template deleted" },
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// =====================
// Business Profile
// =====================

const getBusinessProfile = createRoute({
	operationId: "getWhatsAppBusinessProfile",
	method: "get",
	path: "/business-profile",
	tags: ["WhatsApp"],
	summary: "Get WhatsApp Business profile",
	security: [{ Bearer: [] }],
	request: { query: AccountIdQuery },
	responses: {
		200: {
			description: "Business profile",
			content: {
				"application/json": { schema: BusinessProfileResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const updateBusinessProfile = createRoute({
	operationId: "updateWhatsAppBusinessProfile",
	method: "put",
	path: "/business-profile",
	tags: ["WhatsApp"],
	summary: "Update WhatsApp Business profile",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: UpdateBusinessProfileBody },
			},
		},
	},
	responses: {
		200: {
			description: "Updated business profile",
			content: {
				"application/json": { schema: BusinessProfileResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// =====================
// Phone Numbers
// =====================

const listPhoneNumbers = createRoute({
	operationId: "listWhatsAppPhoneNumbers",
	method: "get",
	path: "/phone-numbers",
	tags: ["WhatsApp"],
	summary: "List registered phone numbers",
	security: [{ Bearer: [] }],
	request: { query: AccountIdQuery },
	responses: {
		200: {
			description: "Phone numbers",
			content: {
				"application/json": { schema: PhoneNumberListResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// =====================
// Display Name
// =====================

const getDisplayName = createRoute({
	operationId: "getWhatsAppDisplayName",
	method: "get",
	path: "/business-profile/display-name",
	tags: ["WhatsApp"],
	summary: "Get display name and review status",
	security: [{ Bearer: [] }],
	request: { query: AccountIdQuery },
	responses: {
		200: {
			description: "Display name info",
			content: { "application/json": { schema: DisplayNameResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const updateDisplayName = createRoute({
	operationId: "updateWhatsAppDisplayName",
	method: "post",
	path: "/business-profile/display-name",
	tags: ["WhatsApp"],
	summary: "Request display name change (requires Meta review)",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: UpdateDisplayNameBody } } },
	},
	responses: {
		200: {
			description: "Name change request submitted",
			content: { "application/json": { schema: z.object({ success: z.boolean(), message: z.string() }) } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// =====================
// Profile Photo
// =====================

const uploadProfilePhoto = createRoute({
	operationId: "uploadWhatsAppProfilePhoto",
	method: "post",
	path: "/business-profile/photo",
	tags: ["WhatsApp"],
	summary: "Upload WhatsApp Business profile photo",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: UploadProfilePhotoBody } } },
	},
	responses: {
		200: {
			description: "Profile photo updated",
			content: { "application/json": { schema: UploadProfilePhotoResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// =====================
// WhatsApp Flows
// =====================

const listFlows = createRoute({
	operationId: "listWhatsAppFlows",
	method: "get",
	path: "/flows",
	tags: ["WhatsApp"],
	summary: "List WhatsApp Flows",
	security: [{ Bearer: [] }],
	request: { query: AccountIdQuery },
	responses: {
		200: {
			description: "List of flows",
			content: { "application/json": { schema: FlowListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const createFlow = createRoute({
	operationId: "createWhatsAppFlow",
	method: "post",
	path: "/flows",
	tags: ["WhatsApp"],
	summary: "Create a WhatsApp Flow (DRAFT)",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: CreateFlowBody } } },
	},
	responses: {
		201: {
			description: "Flow created",
			content: { "application/json": { schema: FlowResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getFlow = createRoute({
	operationId: "getWhatsAppFlow",
	method: "get",
	path: "/flows/{flow_id}",
	tags: ["WhatsApp"],
	summary: "Get flow details",
	security: [{ Bearer: [] }],
	request: {
		params: FlowIdParams,
		query: AccountIdQuery,
	},
	responses: {
		200: {
			description: "Flow details",
			content: { "application/json": { schema: FlowResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const updateFlow = createRoute({
	operationId: "updateWhatsAppFlow",
	method: "patch",
	path: "/flows/{flow_id}",
	tags: ["WhatsApp"],
	summary: "Update flow metadata (DRAFT only)",
	security: [{ Bearer: [] }],
	request: {
		params: FlowIdParams,
		body: { content: { "application/json": { schema: UpdateFlowBody } } },
	},
	responses: {
		200: {
			description: "Flow updated",
			content: { "application/json": { schema: FlowResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteFlow = createRoute({
	operationId: "deleteWhatsAppFlow",
	method: "delete",
	path: "/flows/{flow_id}",
	tags: ["WhatsApp"],
	summary: "Delete a DRAFT flow",
	security: [{ Bearer: [] }],
	request: {
		params: FlowIdParams,
		query: AccountIdQuery,
	},
	responses: {
		200: {
			description: "Flow deleted",
			content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const publishFlow = createRoute({
	operationId: "publishWhatsAppFlow",
	method: "post",
	path: "/flows/{flow_id}/publish",
	tags: ["WhatsApp"],
	summary: "Publish a flow (irreversible)",
	security: [{ Bearer: [] }],
	request: {
		params: FlowIdParams,
		body: { content: { "application/json": { schema: FlowAccountIdBody } } },
	},
	responses: {
		200: {
			description: "Flow published",
			content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deprecateFlow = createRoute({
	operationId: "deprecateWhatsAppFlow",
	method: "post",
	path: "/flows/{flow_id}/deprecate",
	tags: ["WhatsApp"],
	summary: "Deprecate a published flow (irreversible)",
	security: [{ Bearer: [] }],
	request: {
		params: FlowIdParams,
		body: { content: { "application/json": { schema: FlowAccountIdBody } } },
	},
	responses: {
		200: {
			description: "Flow deprecated",
			content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getFlowJson = createRoute({
	operationId: "getWhatsAppFlowJson",
	method: "get",
	path: "/flows/{flow_id}/json",
	tags: ["WhatsApp"],
	summary: "Get flow JSON asset",
	security: [{ Bearer: [] }],
	request: {
		params: FlowIdParams,
		query: AccountIdQuery,
	},
	responses: {
		200: {
			description: "Flow JSON asset",
			content: { "application/json": { schema: z.object({ download_url: z.string().nullable(), expires_at: z.string().nullable() }) } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const uploadFlowJson = createRoute({
	operationId: "uploadWhatsAppFlowJson",
	method: "put",
	path: "/flows/{flow_id}/json",
	tags: ["WhatsApp"],
	summary: "Upload flow JSON definition (DRAFT only)",
	security: [{ Bearer: [] }],
	request: {
		params: FlowIdParams,
		body: { content: { "application/json": { schema: UploadFlowJsonBody } } },
	},
	responses: {
		200: {
			description: "Flow JSON uploaded",
			content: { "application/json": { schema: z.object({ success: z.boolean(), validation_errors: z.array(z.any()).optional() }) } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const sendFlowMessage = createRoute({
	operationId: "sendWhatsAppFlowMessage",
	method: "post",
	path: "/flows/send",
	tags: ["WhatsApp"],
	summary: "Send a published flow as an interactive message",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: SendFlowBody } } },
	},
	responses: {
		200: {
			description: "Flow message sent",
			content: { "application/json": { schema: z.object({ message_id: z.string() }) } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// =====================
// Handlers
// =====================

// --- Bulk Send ---

app.openapi(bulkSend, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, body.account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json(
			{ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } },
			401,
		);
	}

	const phoneNumberId = account.platformAccountId;
	const token = account.accessToken;

	const results: Array<{ phone: string; status: "sent" | "failed"; error: string | null }> = [];
	let sent = 0;
	let failed = 0;

	for (const recipient of body.recipients) {
		try {
			const messageBody: Record<string, unknown> = {
				messaging_product: "whatsapp",
				to: recipient.phone,
				type: "template",
				template: {
					name: body.template.name,
					language: { code: body.template.language },
					...(body.template.components
						? { components: body.template.components }
						: {}),
				},
			};

			// WhatsApp Cloud API: Send a message (template, text, media, etc.)
			// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
			const res = await fetch(`${WA_API_BASE}/${phoneNumberId}/messages`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(messageBody),
			});

			if (res.ok) {
				results.push({ phone: recipient.phone, status: "sent", error: null });
				sent++;
			} else {
				const err = (await res.json().catch(() => ({}))) as Record<string, unknown>;
				const errorMsg =
					(err as { error?: { message?: string } }).error?.message ??
					`HTTP ${res.status}`;
				results.push({ phone: recipient.phone, status: "failed", error: errorMsg });
				failed++;
			}
		} catch (e) {
			results.push({
				phone: recipient.phone,
				status: "failed",
				error: e instanceof Error ? e.message : "Unknown error",
			});
			failed++;
		}
	}

	return c.json({ summary: { sent, failed }, results }, 200);
});

// --- Broadcasts (Drizzle-based) ---

app.openapi(listBroadcasts, async (c) => {
	const orgId = c.get("orgId");
	const { account_id } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const rows = await db
		.select()
		.from(whatsappBroadcasts)
		.where(
			and(
				eq(whatsappBroadcasts.organizationId, orgId),
				eq(whatsappBroadcasts.socialAccountId, account_id),
			),
		)
		.orderBy(desc(whatsappBroadcasts.createdAt));

	return c.json(
		{
			data: rows.map((b) => ({
				id: b.id,
				name: b.name,
				status: b.status as "draft" | "scheduled" | "sending" | "sent" | "partially_failed" | "failed",
				template: b.templateName,
				recipient_count: b.recipientCount,
				sent: b.sentCount,
				failed: b.failedCount,
				scheduled_at: b.scheduledAt?.toISOString() ?? null,
				created_at: b.createdAt.toISOString(),
			})),
		},
		200,
	);
});

app.openapi(createBroadcast, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [broadcast] = await db
		.insert(whatsappBroadcasts)
		.values({
			organizationId: orgId,
			socialAccountId: body.account_id,
			name: body.name,
			status: body.scheduled_at ? "scheduled" : "draft",
			templateName: body.template.name,
			templateLanguage: body.template.language,
			templateComponents: body.template.components ?? null,
			recipientCount: body.recipients.length,
			scheduledAt: body.scheduled_at ? new Date(body.scheduled_at) : null,
		})
		.returning();

	// Insert recipients
	if (body.recipients.length > 0) {
		await db.insert(whatsappBroadcastRecipients).values(
			body.recipients.map((r) => ({
				broadcastId: broadcast!.id,
				phone: r.phone,
				variables: r.variables ?? null,
			})),
		);
	}

	return c.json(
		{
			id: broadcast!.id,
			name: broadcast!.name,
			status: broadcast!.status as "draft" | "scheduled" | "sending" | "sent" | "partially_failed" | "failed",
			template: broadcast!.templateName,
			recipient_count: broadcast!.recipientCount,
			sent: broadcast!.sentCount,
			failed: broadcast!.failedCount,
			scheduled_at: broadcast!.scheduledAt?.toISOString() ?? null,
			created_at: broadcast!.createdAt.toISOString(),
		},
		201,
	);
});

app.openapi(getBroadcast, async (c) => {
	const orgId = c.get("orgId");
	const { broadcast_id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [broadcast] = await db
		.select()
		.from(whatsappBroadcasts)
		.where(
			and(
				eq(whatsappBroadcasts.id, broadcast_id),
				eq(whatsappBroadcasts.organizationId, orgId),
			),
		)
		.limit(1);

	if (!broadcast) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Broadcast not found" } },
			404,
		);
	}

	return c.json(
		{
			id: broadcast.id,
			name: broadcast.name,
			status: broadcast.status as "draft" | "scheduled" | "sending" | "sent" | "partially_failed" | "failed",
			template: broadcast.templateName,
			recipient_count: broadcast.recipientCount,
			sent: broadcast.sentCount,
			failed: broadcast.failedCount,
			scheduled_at: broadcast.scheduledAt?.toISOString() ?? null,
			created_at: broadcast.createdAt.toISOString(),
		},
		200,
	);
});

app.openapi(deleteBroadcast, async (c) => {
	const orgId = c.get("orgId");
	const { broadcast_id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	await db
		.delete(whatsappBroadcasts)
		.where(
			and(
				eq(whatsappBroadcasts.id, broadcast_id),
				eq(whatsappBroadcasts.organizationId, orgId),
			),
		);

	return c.body(null, 204);
});

// @ts-expect-error — Hono strict return types; handler returns valid BroadcastResponse or ErrorResponse
app.openapi(sendBroadcast, async (c) => {
	const orgId = c.get("orgId");
	const { broadcast_id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [broadcast] = await db
		.select()
		.from(whatsappBroadcasts)
		.where(
			and(
				eq(whatsappBroadcasts.id, broadcast_id),
				eq(whatsappBroadcasts.organizationId, orgId),
			),
		)
		.limit(1);

	if (!broadcast) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Broadcast not found" } },
			404,
		);
	}

	if (broadcast.status !== "draft" && broadcast.status !== "scheduled") {
		return c.json(
			{ error: { code: "INVALID_STATUS", message: `Broadcast is already ${broadcast.status}` } },
			400,
		);
	}

	const account = await getWhatsAppAccount(db, broadcast.socialAccountId, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));

	if (!account || !account.accessToken) {
		return c.json(
			{ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } },
			401,
		);
	}

	const phoneNumberId = account.platformAccountId;
	const token = account.accessToken;

	// Mark as sending
	await db
		.update(whatsappBroadcasts)
		.set({ status: "sending", updatedAt: new Date() })
		.where(eq(whatsappBroadcasts.id, broadcast_id));

	// Fetch recipients
	const recipients = await db
		.select()
		.from(whatsappBroadcastRecipients)
		.where(eq(whatsappBroadcastRecipients.broadcastId, broadcast_id));

	let sent = 0;
	let failed = 0;

	for (const recipient of recipients) {
		try {
			const messageBody = {
				messaging_product: "whatsapp",
				to: recipient.phone,
				type: "template",
				template: {
					name: broadcast.templateName,
					language: { code: broadcast.templateLanguage },
					...(broadcast.templateComponents
						? { components: broadcast.templateComponents }
						: {}),
				},
			};

			// WhatsApp Cloud API: Send a message (template, text, media, etc.)
			// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
			const res = await fetch(`${WA_API_BASE}/${phoneNumberId}/messages`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(messageBody),
			});

			if (res.ok) {
				const json = (await res.json().catch(() => ({}))) as { messages?: Array<{ id?: string }> };
				const messageId = json.messages?.[0]?.id ?? null;
				await db
					.update(whatsappBroadcastRecipients)
					.set({ status: "sent", messageId, sentAt: new Date() })
					.where(eq(whatsappBroadcastRecipients.id, recipient.id));
				sent++;
			} else {
				const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
				const errorMsg = err.error?.message ?? `HTTP ${res.status}`;
				await db
					.update(whatsappBroadcastRecipients)
					.set({ status: "failed", error: errorMsg })
					.where(eq(whatsappBroadcastRecipients.id, recipient.id));
				failed++;
			}
		} catch (e) {
			await db
				.update(whatsappBroadcastRecipients)
				.set({ status: "failed", error: e instanceof Error ? e.message : "Unknown error" })
				.where(eq(whatsappBroadcastRecipients.id, recipient.id));
			failed++;
		}
	}

	const finalStatus =
		failed === 0
			? "sent"
			: sent === 0
				? "failed"
				: "partially_failed";

	const [updated] = await db
		.update(whatsappBroadcasts)
		.set({
			status: finalStatus,
			sentCount: sent,
			failedCount: failed,
			completedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(whatsappBroadcasts.id, broadcast_id))
		.returning();

	return c.json(
		{
			id: updated!.id,
			name: updated!.name,
			status: updated!.status as "draft" | "scheduled" | "sending" | "sent" | "partially_failed" | "failed",
			template: updated!.templateName,
			recipient_count: updated!.recipientCount,
			sent: updated!.sentCount,
			failed: updated!.failedCount,
			scheduled_at: updated!.scheduledAt?.toISOString() ?? null,
			created_at: updated!.createdAt.toISOString(),
		},
		200,
	);
});

// @ts-expect-error — Hono strict return types; handler returns valid BroadcastResponse or ErrorResponse
app.openapi(scheduleBroadcast, async (c) => {
	const orgId = c.get("orgId");
	const { broadcast_id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select()
		.from(whatsappBroadcasts)
		.where(
			and(
				eq(whatsappBroadcasts.id, broadcast_id),
				eq(whatsappBroadcasts.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Broadcast not found" } },
			404,
		);
	}

	const scheduledAt = existing.scheduledAt ?? new Date(Date.now() + 60 * 60 * 1000);

	const [updated] = await db
		.update(whatsappBroadcasts)
		.set({
			status: "scheduled",
			scheduledAt,
			updatedAt: new Date(),
		})
		.where(eq(whatsappBroadcasts.id, broadcast_id))
		.returning();

	return c.json(
		{
			id: updated!.id,
			name: updated!.name,
			status: updated!.status as "draft" | "scheduled" | "sending" | "sent" | "partially_failed" | "failed",
			template: updated!.templateName,
			recipient_count: updated!.recipientCount,
			sent: updated!.sentCount,
			failed: updated!.failedCount,
			scheduled_at: updated!.scheduledAt?.toISOString() ?? null,
			created_at: updated!.createdAt.toISOString(),
		},
		200,
	);
});

// --- Templates (WhatsApp Cloud API) ---

app.openapi(listTemplates, async (c) => {
	const orgId = c.get("orgId");
	const { account_id } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json(
			{ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } },
			401,
		);
	}

	const meta = account.metadata as Record<string, unknown> | null;
	const wabaId = meta?.waba_id as string | undefined;
	if (!wabaId) {
		return c.json(
			{ error: { code: "MISSING_WABA_ID", message: "WhatsApp Business Account ID not configured in account metadata" } },
			401,
		);
	}

	try {
		// WhatsApp Business Management API: List message templates for a WABA
		// https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
		const res = await fetch(
			`${WA_API_BASE}/${wabaId}/message_templates`,
			{ headers: { Authorization: `Bearer ${account.accessToken}` } },
		);
		if (!res.ok) {
			const err = await res.text();
			return c.json(
				{ error: { code: "WA_API_ERROR", message: `Failed to list templates: ${err}` } },
				401,
			);
		}
		const json = (await res.json()) as {
			data: Array<{
				name: string;
				language: string;
				status: string;
				category: string;
				components: Array<{
					type: string;
					text?: string;
					format?: string;
					buttons?: Array<{
						type: string;
						text: string;
						url?: string;
						phone_number?: string;
					}>;
				}>;
			}>;
		};
		return c.json(
			{
				data: (json.data ?? []).map((t) => ({
					name: t.name,
					language: t.language,
					status: t.status as "APPROVED" | "PENDING" | "REJECTED",
					category: t.category as "MARKETING" | "UTILITY" | "AUTHENTICATION",
					components: t.components.map((comp) => ({
						type: comp.type as "HEADER" | "BODY" | "FOOTER" | "BUTTONS",
						...(comp.text !== undefined ? { text: comp.text } : {}),
						...(comp.format !== undefined ? { format: comp.format } : {}),
						...(comp.buttons ? { buttons: comp.buttons } : {}),
					})),
				})),
			},
			200,
		);
	} catch (e) {
		return c.json(
			{ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } },
			401,
		);
	}
});

app.openapi(createTemplate, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, body.account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json(
			{ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } },
			401,
		);
	}

	const meta = account.metadata as Record<string, unknown> | null;
	const wabaId = meta?.waba_id as string | undefined;
	if (!wabaId) {
		return c.json(
			{ error: { code: "MISSING_WABA_ID", message: "WhatsApp Business Account ID not configured in account metadata" } },
			401,
		);
	}

	try {
		// WhatsApp Business Management API: Create a new message template
		// https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates#create-message-templates
		const res = await fetch(`${WA_API_BASE}/${wabaId}/message_templates`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${account.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name: body.name,
				language: body.language,
				category: body.category,
				components: body.components,
			}),
		});

		if (!res.ok) {
			const err = await res.text();
			return c.json(
				{ error: { code: "WA_API_ERROR", message: `Failed to create template: ${err}` } },
				401,
			);
		}

		// The Cloud API returns { id, status, category } on success
		const json = (await res.json()) as {
			id: string;
			status: string;
			category: string;
		};

		return c.json(
			{
				name: body.name,
				language: body.language,
				status: (json.status ?? "PENDING") as "APPROVED" | "PENDING" | "REJECTED",
				category: body.category,
				components: body.components,
			},
			201,
		);
	} catch (e) {
		return c.json(
			{ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } },
			401,
		);
	}
});

app.openapi(getTemplate, async (c) => {
	const orgId = c.get("orgId");
	const { template_name } = c.req.valid("param");
	const { account_id } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json(
			{ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } },
			401,
		);
	}

	const meta = account.metadata as Record<string, unknown> | null;
	const wabaId = meta?.waba_id as string | undefined;
	if (!wabaId) {
		return c.json(
			{ error: { code: "MISSING_WABA_ID", message: "WhatsApp Business Account ID not configured in account metadata" } },
			401,
		);
	}

	try {
		// WhatsApp Business Management API: Get a specific message template by name
		// https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
		const res = await fetch(
			`${WA_API_BASE}/${wabaId}/message_templates?name=${encodeURIComponent(template_name)}`,
			{ headers: { Authorization: `Bearer ${account.accessToken}` } },
		);
		if (!res.ok) {
			return c.json(
				{ error: { code: "NOT_FOUND", message: "Template not found" } },
				404,
			);
		}
		const json = (await res.json()) as {
			data: Array<{
				name: string;
				language: string;
				status: string;
				category: string;
				components: Array<{
					type: string;
					text?: string;
					format?: string;
					buttons?: Array<{
						type: string;
						text: string;
						url?: string;
						phone_number?: string;
					}>;
				}>;
			}>;
		};

		const template = json.data?.[0];
		if (!template) {
			return c.json(
				{ error: { code: "NOT_FOUND", message: "Template not found" } },
				404,
			);
		}

		return c.json(
			{
				name: template.name,
				language: template.language,
				status: template.status as "APPROVED" | "PENDING" | "REJECTED",
				category: template.category as "MARKETING" | "UTILITY" | "AUTHENTICATION",
				components: template.components.map((comp) => ({
					type: comp.type as "HEADER" | "BODY" | "FOOTER" | "BUTTONS",
					...(comp.text !== undefined ? { text: comp.text } : {}),
					...(comp.format !== undefined ? { format: comp.format } : {}),
					...(comp.buttons ? { buttons: comp.buttons } : {}),
				})),
			},
			200,
		);
	} catch (e) {
		return c.json(
			{ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } },
			404,
		);
	}
});

app.openapi(deleteTemplate, async (c) => {
	const orgId = c.get("orgId");
	const { template_name } = c.req.valid("param");
	const { account_id } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json(
			{ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } },
			401,
		);
	}

	const meta = account.metadata as Record<string, unknown> | null;
	const wabaId = meta?.waba_id as string | undefined;
	if (!wabaId) {
		return c.json(
			{ error: { code: "MISSING_WABA_ID", message: "WhatsApp Business Account ID not configured in account metadata" } },
			401,
		);
	}

	try {
		// WhatsApp Business Management API: Delete a message template by name
		// https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates#delete-message-templates
		const res = await fetch(
			`${WA_API_BASE}/${wabaId}/message_templates?name=${encodeURIComponent(template_name)}`,
			{
				method: "DELETE",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
				},
			},
		);

		if (!res.ok) {
			const err = await res.text();
			return c.json(
				{ error: { code: "WA_API_ERROR", message: `Failed to delete template: ${err}` } },
				401,
			);
		}
	} catch (e) {
		return c.json(
			{ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } },
			401,
		);
	}

	return c.body(null, 204);
});

// --- Business Profile (WhatsApp Cloud API) ---

app.openapi(getBusinessProfile, async (c) => {
	const orgId = c.get("orgId");
	const { account_id } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json(
			{ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } },
			401,
		);
	}

	const phoneNumberId = account.platformAccountId;

	try {
		// WhatsApp Cloud API: Get the business profile for a phone number
		// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/business-profiles
		const res = await fetch(
			`${WA_API_BASE}/${phoneNumberId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites`,
			{
				headers: { Authorization: `Bearer ${account.accessToken}` },
			},
		);

		if (!res.ok) {
			const err = await res.text();
			return c.json(
				{ error: { code: "WA_API_ERROR", message: `Failed to get business profile: ${err}` } },
				401,
			);
		}

		const json = (await res.json()) as {
			data: Array<{
				about?: string;
				address?: string;
				description?: string;
				email?: string;
				profile_picture_url?: string;
				websites?: string[];
			}>;
		};

		const profile = json.data?.[0] ?? {};

		return c.json(
			{
				about: profile.about ?? null,
				description: profile.description ?? null,
				email: profile.email ?? null,
				websites: profile.websites ?? [],
				address: profile.address ?? null,
				profile_picture_url: profile.profile_picture_url ?? null,
			},
			200,
		);
	} catch (e) {
		return c.json(
			{ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } },
			401,
		);
	}
});

app.openapi(updateBusinessProfile, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, body.account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json(
			{ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } },
			401,
		);
	}

	const phoneNumberId = account.platformAccountId;

	// Build the update payload - only include fields that are provided
	const updatePayload: Record<string, unknown> = {
		messaging_product: "whatsapp",
	};
	if (body.about !== undefined) updatePayload.about = body.about;
	if (body.description !== undefined) updatePayload.description = body.description;
	if (body.email !== undefined) updatePayload.email = body.email;
	if (body.websites !== undefined) updatePayload.websites = body.websites;
	if (body.address !== undefined) updatePayload.address = body.address;

	try {
		// WhatsApp Cloud API: Update the business profile for a phone number
		// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/business-profiles
		const updateRes = await fetch(
			`${WA_API_BASE}/${phoneNumberId}/whatsapp_business_profile`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(updatePayload),
			},
		);

		if (!updateRes.ok) {
			const err = await updateRes.text();
			return c.json(
				{ error: { code: "WA_API_ERROR", message: `Failed to update business profile: ${err}` } },
				401,
			);
		}

		// WhatsApp Cloud API: Get the updated business profile after modification
		// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/business-profiles
		const getRes = await fetch(
			`${WA_API_BASE}/${phoneNumberId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites`,
			{
				headers: { Authorization: `Bearer ${account.accessToken}` },
			},
		);

		if (!getRes.ok) {
			// Update succeeded but re-fetch failed, return what we know
			return c.json(
				{
					about: body.about ?? null,
					description: body.description ?? null,
					email: body.email ?? null,
					websites: body.websites ?? [],
					address: body.address ?? null,
					profile_picture_url: null,
				},
				200,
			);
		}

		const json = (await getRes.json()) as {
			data: Array<{
				about?: string;
				address?: string;
				description?: string;
				email?: string;
				profile_picture_url?: string;
				websites?: string[];
			}>;
		};

		const profile = json.data?.[0] ?? {};

		return c.json(
			{
				about: profile.about ?? null,
				description: profile.description ?? null,
				email: profile.email ?? null,
				websites: profile.websites ?? [],
				address: profile.address ?? null,
				profile_picture_url: profile.profile_picture_url ?? null,
			},
			200,
		);
	} catch (e) {
		return c.json(
			{ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } },
			401,
		);
	}
});

// --- Phone Numbers (WhatsApp Cloud API) ---

app.openapi(listPhoneNumbers, async (c) => {
	const orgId = c.get("orgId");
	const { account_id } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json(
			{ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } },
			401,
		);
	}

	const meta = account.metadata as Record<string, unknown> | null;
	const wabaId = meta?.waba_id as string | undefined;
	if (!wabaId) {
		return c.json(
			{ error: { code: "MISSING_WABA_ID", message: "WhatsApp Business Account ID not configured in account metadata" } },
			401,
		);
	}

	try {
		// WhatsApp Business Management API: List phone numbers for a WABA
		// https://developers.facebook.com/docs/whatsapp/business-management-api/phone-numbers
		const res = await fetch(
			`${WA_API_BASE}/${wabaId}/phone_numbers`,
			{ headers: { Authorization: `Bearer ${account.accessToken}` } },
		);

		if (!res.ok) {
			const err = await res.text();
			return c.json(
				{ error: { code: "WA_API_ERROR", message: `Failed to list phone numbers: ${err}` } },
				401,
			);
		}

		const json = (await res.json()) as {
			data: Array<{
				id: string;
				display_phone_number: string;
				verified_name: string;
				quality_rating: string;
				code_verification_status?: string;
			}>;
		};

		return c.json(
			{
				data: (json.data ?? []).map((pn) => ({
					id: pn.id,
					phone_number: pn.display_phone_number,
					status: (pn.code_verification_status === "VERIFIED"
						? "active"
						: pn.code_verification_status === "NOT_VERIFIED"
							? "pending"
							: "active") as "active" | "inactive" | "pending",
					display_name: pn.verified_name ?? null,
				})),
			},
			200,
		);
	} catch (e) {
		return c.json(
			{ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } },
			401,
		);
	}
});

// --- Display Name ---

app.openapi(getDisplayName, async (c) => {
	const orgId = c.get("orgId");
	const { account_id } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json(
			{ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } },
			401,
		);
	}

	const phoneNumberId = account.platformAccountId;

	try {
		// WhatsApp Business Management API — Get phone number fields
		// Docs: https://developers.facebook.com/docs/whatsapp/business-management-api/manage-phone-numbers
		// Section: "Retrieve Phone Numbers" — GET /{phone-number-id}?fields=verified_name,name_status
		// verified_name: current approved display name | name_status: review status of pending name change
		const res = await fetch(
			`${WA_API_BASE}/${phoneNumberId}?fields=verified_name,name_status`,
			{ headers: { Authorization: `Bearer ${account.accessToken}` } },
		);

		if (!res.ok) {
			const err = await res.text();
			return c.json(
				{ error: { code: "WA_API_ERROR", message: `Failed to get display name: ${err}` } },
				401,
			);
		}

		const data = (await res.json()) as {
			verified_name?: string;
			name_status?: string;
		};

		return c.json(
			{
				display_name: data.verified_name ?? null,
				review_status: data.name_status ?? null,
			},
			200,
		);
	} catch (e) {
		return c.json(
			{ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } },
			401,
		);
	}
});

app.openapi(updateDisplayName, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, body.account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json(
			{ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } },
			401,
		);
	}

	const phoneNumberId = account.platformAccountId;

	try {
		// WhatsApp Business Management API — Request display name change
		// Docs: https://developers.facebook.com/docs/whatsapp/business-management-api/manage-phone-numbers
		// Section: "Update Display Name" — POST /{phone-number-id}?new_display_name=...
		// Official curl: POST 'https://graph.facebook.com/v25.0/{id}?new_display_name=Lucky%20Shrub'
		// Note: new_display_name is a QUERY PARAMETER, not a JSON body field.
		// Review by Meta takes 1-3 business days. name_status field tracks review progress.
		const res = await fetch(
			`${WA_API_BASE}/${phoneNumberId}?new_display_name=${encodeURIComponent(body.display_name)}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
				},
			},
		);

		if (!res.ok) {
			const err = await res.text();
			return c.json(
				{ error: { code: "WA_API_ERROR", message: `Failed to update display name: ${err}` } },
				401,
			);
		}

		return c.json({ success: true, message: "Display name change request submitted. Meta review may take 1-3 business days." }, 200);
	} catch (e) {
		return c.json(
			{ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } },
			401,
		);
	}
});

// --- Profile Photo ---

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(uploadProfilePhoto, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, body.account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json(
			{ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } },
			401,
		);
	}

	const phoneNumberId = account.platformAccountId;

	try {
		// SSRF protection: only allow HTTPS URLs and block private/loopback addresses
		const photoUrl = new URL(body.photo_url);
		if (photoUrl.protocol !== "https:") {
			return c.json(
				{ error: { code: "INVALID_URL", message: "Only HTTPS URLs are allowed" } },
				400,
			);
		}
		const host = photoUrl.hostname.toLowerCase();
		if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".local") || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.") || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
			return c.json(
				{ error: { code: "INVALID_URL", message: "Private or localhost URLs are not allowed" } },
				400,
			);
		}

		// Step 1: Fetch the image from the provided URL
		const imageRes = await fetchPublicUrl(body.photo_url, { timeout: 30_000 });
		if (!imageRes.ok) {
			return c.json(
				{ error: { code: "FETCH_FAILED", message: `Failed to fetch image from URL: ${imageRes.statusText}` } },
				400,
			);
		}

		const imageBytes = await imageRes.arrayBuffer();
		const contentType = imageRes.headers.get("content-type") ?? "image/jpeg";
		const fileSize = imageBytes.byteLength;

		// Step 2: Create upload session via Meta Resumable Upload API
		// Docs: https://developers.facebook.com/docs/graph-api/guides/upload
		// Section: "Start an Upload Session" — POST /{app-id}/uploads?file_length=...&file_type=...
		// Returns: { id: "upload:<SESSION_ID>" }
		const meta = account.metadata as Record<string, unknown> | null;
		const appId = meta?.app_id as string | undefined;
		const uploadSessionUrl = appId
			? `${WA_API_BASE}/${appId}/uploads`
			: `${WA_API_BASE}/app/uploads`;

		// Docs require: file_name, file_length, file_type, access_token as query params
		const sessionRes = await fetch(
			`${uploadSessionUrl}?file_name=profile_photo.jpg&file_length=${fileSize}&file_type=${encodeURIComponent(contentType)}&access_token=${account.accessToken}`,
			{ method: "POST" },
		);

		if (!sessionRes.ok) {
			const err = await sessionRes.text();
			return c.json(
				{ error: { code: "UPLOAD_SESSION_FAILED", message: `Failed to create upload session: ${err}` } },
				502,
			);
		}

		const sessionData = (await sessionRes.json()) as { id?: string };
		const uploadSessionId = sessionData.id;
		if (!uploadSessionId) {
			return c.json(
				{ error: { code: "UPLOAD_SESSION_FAILED", message: "No upload session ID returned" } },
				502,
			);
		}

		// Step 3: Upload the file bytes
		// Docs: https://developers.facebook.com/docs/graph-api/guides/upload
		// Section: "Upload File Data" — POST /upload:<SESSION_ID>
		// Headers: Authorization: OAuth {token}, file_offset: 0
		// Body: raw binary | Returns: { h: "<FILE_HANDLE>" }
		const uploadRes = await fetch(
			`${WA_API_BASE}/${uploadSessionId}`,
			{
				method: "POST",
				headers: {
					Authorization: `OAuth ${account.accessToken}`,
					"Content-Type": contentType,
					file_offset: "0",
				},
				body: imageBytes,
			},
		);

		if (!uploadRes.ok) {
			const err = await uploadRes.text();
			return c.json(
				{ error: { code: "UPLOAD_FAILED", message: `Failed to upload photo: ${err}` } },
				502,
			);
		}

		const uploadData = (await uploadRes.json()) as { h?: string };
		const fileHandle = uploadData.h;
		if (!fileHandle) {
			return c.json(
				{ error: { code: "UPLOAD_FAILED", message: "No file handle returned" } },
				502,
			);
		}

		// Step 4: Set the profile picture handle on the business profile
		// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/business-profiles
		// Confirmed via: https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/whatsapp-business-profile-api
		// Section: "Update Fields" — profile_picture_handle is a valid POST field
		// Requires: messaging_product: "whatsapp" and the handle from Resumable Upload API
		const profileRes = await fetch(
			`${WA_API_BASE}/${phoneNumberId}/whatsapp_business_profile`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					messaging_product: "whatsapp",
					profile_picture_handle: fileHandle,
				}),
			},
		);

		if (!profileRes.ok) {
			const err = await profileRes.text();
			return c.json(
				{ error: { code: "PROFILE_UPDATE_FAILED", message: `Failed to set profile photo: ${err}` } },
				502,
			);
		}

		// Step 5: Fetch the updated profile to get the new URL
		const updatedRes = await fetch(
			`${WA_API_BASE}/${phoneNumberId}/whatsapp_business_profile?fields=profile_picture_url`,
			{ headers: { Authorization: `Bearer ${account.accessToken}` } },
		);
		const updatedJson = (await updatedRes.json()) as { data?: Array<{ profile_picture_url?: string }> };
		const newUrl = updatedJson.data?.[0]?.profile_picture_url ?? null;

		return c.json({ success: true, profile_picture_url: newUrl }, 200);
	} catch (e) {
		return c.json(
			{ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } },
			502,
		);
	}
});

// --- WhatsApp Flows ---

/** Helper to resolve WABA ID from account metadata */
function getWabaId(account: { metadata: unknown }): string | undefined {
	return (account.metadata as Record<string, unknown> | null)?.waba_id as string | undefined;
}

/** Verify a flow belongs to the caller's WABA by checking the flow's waba_id field */
async function assertFlowOwnership(
	flowId: string,
	wabaId: string,
	accessToken: string,
): Promise<{ owned: true } | { owned: false; error: string }> {
	try {
		const res = await fetch(
			`${WA_API_BASE}/${flowId}?fields=id,whatsapp_business_account`,
			{ headers: { Authorization: `Bearer ${accessToken}` } },
		);
		if (!res.ok) return { owned: false, error: `Flow not found or inaccessible (HTTP ${res.status})` };
		const data = (await res.json()) as { whatsapp_business_account?: { id?: string } };
		const flowWabaId = data.whatsapp_business_account?.id;
		if (!flowWabaId) {
			return { owned: false, error: "Could not verify flow ownership: WABA not returned by Meta API" };
		}
		if (flowWabaId !== wabaId) {
			return { owned: false, error: "Flow does not belong to this WhatsApp Business Account" };
		}
		return { owned: true };
	} catch {
		return { owned: false, error: "Failed to verify flow ownership" };
	}
}

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(listFlows, async (c) => {
	const orgId = c.get("orgId");
	const { account_id } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json({ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } }, 401);
	}

	const wabaId = getWabaId(account);
	if (!wabaId) {
		return c.json({ error: { code: "MISSING_WABA_ID", message: "WABA ID not configured" } }, 401);
	}

	try {
		// WhatsApp Flows API — List flows for a WABA
		// Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
		// Section: "List Flows" — GET /{waba-id}/flows
		const res = await fetch(
			`${WA_API_BASE}/${wabaId}/flows`,
			{ headers: { Authorization: `Bearer ${account.accessToken}` } },
		);
		if (!res.ok) {
			const err = await res.text();
			return c.json({ error: { code: "WA_API_ERROR", message: `Failed to list flows: ${err}` } }, 502);
		}
		const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
		return c.json({ data: json.data ?? [] }, 200);
	} catch (e) {
		return c.json({ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } }, 502);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(createFlow, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, body.account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json({ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } }, 401);
	}

	const wabaId = getWabaId(account);
	if (!wabaId) {
		return c.json({ error: { code: "MISSING_WABA_ID", message: "WABA ID not configured" } }, 401);
	}

	try {
		// WhatsApp Flows API — Create a new flow (DRAFT status)
		// Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
		// Section: "Create Flow" — POST /{waba-id}/flows
		// Required: name, categories[] | Optional: clone_flow_id, flow_json, publish, endpoint_uri
		const payload: Record<string, unknown> = {
			name: body.name,
			categories: body.categories,
		};
		if (body.clone_flow_id) {
			payload.clone_flow_id = body.clone_flow_id;
		}

		const res = await fetch(
			`${WA_API_BASE}/${wabaId}/flows`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
			},
		);

		if (!res.ok) {
			const err = await res.text();
			return c.json({ error: { code: "WA_API_ERROR", message: `Failed to create flow: ${err}` } }, 502);
		}

		const data = (await res.json()) as { id?: string };
		if (!data.id) {
			return c.json({ error: { code: "WA_API_ERROR", message: "No flow ID returned" } }, 502);
		}

		// Fetch the full flow details
		const detailRes = await fetch(
			`${WA_API_BASE}/${data.id}?fields=id,name,status,categories,validation_errors`,
			{ headers: { Authorization: `Bearer ${account.accessToken}` } },
		);
		const detail = (await detailRes.json()) as Record<string, unknown>;
		return c.json(detail, 201);
	} catch (e) {
		return c.json({ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } }, 502);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(getFlow, async (c) => {
	const orgId = c.get("orgId");
	const { flow_id } = c.req.valid("param");
	const { account_id } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json({ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } }, 401);
	}

	const wabaId = getWabaId(account);
	if (wabaId) {
		const ownership = await assertFlowOwnership(flow_id, wabaId, account.accessToken);
		if (!ownership.owned) {
			return c.json({ error: { code: "FORBIDDEN", message: ownership.error } }, 403);
		}
	}

	try {
		// WhatsApp Flows API — Get flow details
		// Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
		// Section: "Get Flow" — GET /{flow-id}?fields=id,name,status,categories,...
		// Valid fields: id, name, status, categories, validation_errors, json_version,
		//   data_api_version, endpoint_uri, preview, whatsapp_business_account, application, health_status
		const res = await fetch(
			`${WA_API_BASE}/${flow_id}?fields=id,name,status,categories,validation_errors,preview,json_version,data_api_version`,
			{ headers: { Authorization: `Bearer ${account.accessToken}` } },
		);
		if (!res.ok) {
			const err = await res.text();
			return c.json({ error: { code: "WA_API_ERROR", message: `Failed to get flow: ${err}` } }, 502);
		}
		const data = (await res.json()) as Record<string, unknown>;
		return c.json(data, 200);
	} catch (e) {
		return c.json({ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } }, 502);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(updateFlow, async (c) => {
	const orgId = c.get("orgId");
	const { flow_id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, body.account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json({ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } }, 401);
	}

	const wabaId = getWabaId(account);
	if (wabaId) {
		const ownership = await assertFlowOwnership(flow_id, wabaId, account.accessToken);
		if (!ownership.owned) {
			return c.json({ error: { code: "FORBIDDEN", message: ownership.error } }, 403);
		}
	}

	try {
		// WhatsApp Flows API — Update flow metadata (DRAFT only)
		// Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
		// Section: "Update Flow" — POST /{flow-id} (Meta uses POST, not PATCH)
		// Optional fields: name, categories, endpoint_uri, application_id
		const payload: Record<string, unknown> = {};
		if (body.name !== undefined) payload.name = body.name;
		if (body.categories !== undefined) payload.categories = body.categories;

		const res = await fetch(
			`${WA_API_BASE}/${flow_id}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
			},
		);

		if (!res.ok) {
			const err = await res.text();
			return c.json({ error: { code: "WA_API_ERROR", message: `Failed to update flow: ${err}` } }, 502);
		}

		// Fetch updated details
		const detailRes = await fetch(
			`${WA_API_BASE}/${flow_id}?fields=id,name,status,categories,validation_errors`,
			{ headers: { Authorization: `Bearer ${account.accessToken}` } },
		);
		const detail = (await detailRes.json()) as Record<string, unknown>;
		return c.json(detail, 200);
	} catch (e) {
		return c.json({ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } }, 502);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(deleteFlow, async (c) => {
	const orgId = c.get("orgId");
	const { flow_id } = c.req.valid("param");
	const { account_id } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json({ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } }, 401);
	}

	const wabaId = getWabaId(account);
	if (wabaId) {
		const ownership = await assertFlowOwnership(flow_id, wabaId, account.accessToken);
		if (!ownership.owned) {
			return c.json({ error: { code: "FORBIDDEN", message: ownership.error } }, 403);
		}
	}

	try {
		// WhatsApp Flows API — Delete a DRAFT flow
		// Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
		// Section: "Delete Flow" — DELETE /{flow-id}, returns { success: true }
		const res = await fetch(
			`${WA_API_BASE}/${flow_id}`,
			{
				method: "DELETE",
				headers: { Authorization: `Bearer ${account.accessToken}` },
			},
		);

		if (!res.ok) {
			const err = await res.text();
			return c.json({ error: { code: "WA_API_ERROR", message: `Failed to delete flow: ${err}` } }, 502);
		}

		return c.json({ success: true }, 200);
	} catch (e) {
		return c.json({ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } }, 502);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(publishFlow, async (c) => {
	const orgId = c.get("orgId");
	const { flow_id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, body.account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json({ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } }, 401);
	}

	const wabaId = getWabaId(account);
	if (wabaId) {
		const ownership = await assertFlowOwnership(flow_id, wabaId, account.accessToken);
		if (!ownership.owned) {
			return c.json({ error: { code: "FORBIDDEN", message: ownership.error } }, 403);
		}
	}

	try {
		// WhatsApp Flows API — Publish a flow (irreversible, DRAFT → PUBLISHED)
		// Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
		// Section: "Publish Flow" — POST /{flow-id}/publish, no body required, returns { success: true }
		const res = await fetch(
			`${WA_API_BASE}/${flow_id}/publish`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${account.accessToken}` },
			},
		);

		if (!res.ok) {
			const err = await res.text();
			return c.json({ error: { code: "WA_API_ERROR", message: `Failed to publish flow: ${err}` } }, 502);
		}

		return c.json({ success: true }, 200);
	} catch (e) {
		return c.json({ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } }, 502);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(deprecateFlow, async (c) => {
	const orgId = c.get("orgId");
	const { flow_id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, body.account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json({ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } }, 401);
	}

	const wabaId = getWabaId(account);
	if (wabaId) {
		const ownership = await assertFlowOwnership(flow_id, wabaId, account.accessToken);
		if (!ownership.owned) {
			return c.json({ error: { code: "FORBIDDEN", message: ownership.error } }, 403);
		}
	}

	try {
		// WhatsApp Flows API — Deprecate a published flow (irreversible)
		// Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
		// Section: "Deprecate Flow" — POST /{flow-id}/deprecate, no body, returns { success: true }
		const res = await fetch(
			`${WA_API_BASE}/${flow_id}/deprecate`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${account.accessToken}` },
			},
		);

		if (!res.ok) {
			const err = await res.text();
			return c.json({ error: { code: "WA_API_ERROR", message: `Failed to deprecate flow: ${err}` } }, 502);
		}

		return c.json({ success: true }, 200);
	} catch (e) {
		return c.json({ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } }, 502);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(getFlowJson, async (c) => {
	const orgId = c.get("orgId");
	const { flow_id } = c.req.valid("param");
	const { account_id } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json({ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } }, 401);
	}

	const wabaId = getWabaId(account);
	if (wabaId) {
		const ownership = await assertFlowOwnership(flow_id, wabaId, account.accessToken);
		if (!ownership.owned) {
			return c.json({ error: { code: "FORBIDDEN", message: ownership.error } }, 403);
		}
	}

	try {
		// WhatsApp Flows API — Get flow assets (JSON definition)
		// Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
		// Section: "Get Flow Assets" — GET /{flow-id}/assets
		// Returns: { data: [{ name, asset_type, download_url }] } — look for name === "flow.json"
		const res = await fetch(
			`${WA_API_BASE}/${flow_id}/assets`,
			{ headers: { Authorization: `Bearer ${account.accessToken}` } },
		);

		if (!res.ok) {
			const err = await res.text();
			return c.json({ error: { code: "WA_API_ERROR", message: `Failed to get flow JSON: ${err}` } }, 502);
		}

		const json = (await res.json()) as { data?: Array<{ name?: string; download_url?: string }> };
		const asset = json.data?.find((a) => a.name === "flow.json");

		return c.json(
			{
				download_url: asset?.download_url ?? null,
				expires_at: null,
			},
			200,
		);
	} catch (e) {
		return c.json({ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } }, 502);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(uploadFlowJson, async (c) => {
	const orgId = c.get("orgId");
	const { flow_id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, body.account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json({ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } }, 401);
	}

	const wabaId = getWabaId(account);
	if (wabaId) {
		const ownership = await assertFlowOwnership(flow_id, wabaId, account.accessToken);
		if (!ownership.owned) {
			return c.json({ error: { code: "FORBIDDEN", message: ownership.error } }, 403);
		}
	}

	try {
		// WhatsApp Flows API — Upload/update flow JSON asset
		// Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
		// Section: "Update Flow JSON" — POST /{flow-id}/assets (multipart form-data)
		// Required fields: file (JSON blob), name: "flow.json", asset_type: "FLOW_JSON"
		// Returns validation_errors array if JSON is invalid
		const flowJsonBlob = new Blob([JSON.stringify(body.flow_json)], { type: "application/json" });
		const formData = new FormData();
		formData.append("file", flowJsonBlob, "flow.json");
		formData.append("name", "flow.json");
		formData.append("asset_type", "FLOW_JSON");

		const res = await fetch(
			`${WA_API_BASE}/${flow_id}/assets`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${account.accessToken}` },
				body: formData,
			},
		);

		if (!res.ok) {
			const err = await res.text();
			// Meta returns validation errors in the response body
			try {
				const parsed = JSON.parse(err) as { error?: { error_user_msg?: string; error_data?: { validation_errors?: unknown[] } } };
				if (parsed.error?.error_data?.validation_errors) {
					return c.json(
						{ success: false, validation_errors: parsed.error.error_data.validation_errors },
						200,
					);
				}
			} catch { /* not JSON, fall through */ }
			return c.json({ error: { code: "WA_API_ERROR", message: `Failed to upload flow JSON: ${err}` } }, 502);
		}

		return c.json({ success: true }, 200);
	} catch (e) {
		return c.json({ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } }, 502);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(sendFlowMessage, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getWhatsAppAccount(db, body.account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json({ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } }, 401);
	}

	const phoneNumberId = account.platformAccountId;

	try {
		// WhatsApp Cloud API — Send an interactive flow message
		// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-flow-messages/
		// Also: https://developers.facebook.com/docs/whatsapp/flows/guides/sendingaflow/
		// Section: "Full Parameters" — POST /{phone-number-id}/messages
		// interactive.type: "flow", action.name: "flow", flow_message_version: "3"
		// flow_action: "navigate" | "data_exchange", flow_action_payload: { screen, data }
		const payload = {
			messaging_product: "whatsapp",
			recipient_type: "individual",
			to: body.recipient_phone,
			type: "interactive",
			interactive: {
				type: "flow",
				header: body.header_text ? { type: "text", text: body.header_text } : undefined,
				body: { text: body.body_text },
				footer: body.footer_text ? { text: body.footer_text } : undefined,
				action: {
					name: "flow",
					parameters: {
						flow_message_version: "3",
						flow_token: body.flow_token,
						flow_id: body.flow_id,
						flow_cta: body.cta_text,
						flow_action: "navigate",
						flow_action_payload: {
							screen: body.screen_id,
							data: body.flow_data ?? {},
						},
					},
				},
			},
		};

		const res = await fetch(
			`${WA_API_BASE}/${phoneNumberId}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
			},
		);

		if (!res.ok) {
			const err = await res.text();
			return c.json({ error: { code: "WA_API_ERROR", message: `Failed to send flow message: ${err}` } }, 502);
		}

		const json = (await res.json()) as { messages?: Array<{ id?: string }> };
		const messageId = json.messages?.[0]?.id ?? "";

		return c.json({ message_id: messageId }, 200);
	} catch (e) {
		return c.json({ error: { code: "WA_API_ERROR", message: e instanceof Error ? e.message : "Unknown error" } }, 502);
	}
});

export default app;
