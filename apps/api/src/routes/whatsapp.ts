import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	broadcastRecipients,
	broadcasts,
	type createDb,
	socialAccounts,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { GRAPH_BASE } from "../config/api-versions";
import { decryptAccountTokens } from "../lib/account-token-crypto";
import { fetchPublicUrl, readResponseBytes } from "../lib/fetch-public-url";
import { trackSingleUnitProviderMutation } from "../lib/mutation-provider-boundary";
import { readProviderJson, readProviderText } from "../lib/provider-response";
import { canAccessWorkspaceScope } from "../lib/workspace-scope";
import { BroadcastResponse as GenericBroadcastResponse } from "../schemas/broadcasts";
import { ErrorResponse } from "../schemas/common";
import {
	AccountIdQuery,
	BulkSendBody,
	BusinessProfileResponse,
	CreateFlowBody,
	CreateTemplateBody,
	DisplayNameResponse,
	FlowAccountIdBody,
	FlowIdParams,
	FlowListResponse,
	FlowResponse,
	PhoneNumberListResponse,
	SendFlowBody,
	TemplateIdParams,
	TemplateListResponse,
	TemplateResponse,
	UpdateBusinessProfileBody,
	UpdateDisplayNameBody,
	UpdateFlowBody,
	UploadFlowJsonBody,
	UploadProfilePhotoBody,
	UploadProfilePhotoResponse,
} from "../schemas/whatsapp";
import {
	getAllowedRecipientHashes,
	hashRecipientIdentifier,
} from "../services/contact-consent";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const WA_API_BASE = GRAPH_BASE.facebook;
const WHATSAPP_PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

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
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		)
		.limit(1);
	if (!account) return null;
	if (!canAccessWorkspaceScope(workspaceScope, account.workspaceId))
		return null;
	return decryptAccountTokens(account, encryptionKey);
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
			description: "Broadcast queued for asynchronous delivery",
			content: { "application/json": { schema: GenericBroadcastResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		400: {
			description: "No recipient has current consent",
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
		body: {
			content: { "application/json": { schema: UpdateDisplayNameBody } },
		},
	},
	responses: {
		200: {
			description: "Name change request submitted",
			content: {
				"application/json": {
					schema: z.object({ success: z.boolean(), message: z.string() }),
				},
			},
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
		body: {
			content: { "application/json": { schema: UploadProfilePhotoBody } },
		},
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
			content: {
				"application/json": { schema: z.object({ success: z.boolean() }) },
			},
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
			content: {
				"application/json": { schema: z.object({ success: z.boolean() }) },
			},
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
			content: {
				"application/json": { schema: z.object({ success: z.boolean() }) },
			},
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
			content: {
				"application/json": {
					schema: z.object({
						download_url: z.string().nullable(),
						expires_at: z.string().nullable(),
					}),
				},
			},
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
			content: {
				"application/json": {
					schema: z.object({
						success: z.boolean(),
						validation_errors: z.array(z.any()).optional(),
					}),
				},
			},
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
			content: {
				"application/json": { schema: z.object({ message_id: z.string() }) },
			},
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
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		body.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}
	const allowedHashes = await getAllowedRecipientHashes(
		db,
		c.env.ENCRYPTION_KEY,
		orgId,
		"whatsapp",
		"marketing",
		body.recipients.map((recipient) => ({ identifier: recipient.phone })),
	);
	const authorizedRecipients = (
		await Promise.all(
			body.recipients.map(async (recipient) => ({
				...recipient,
				identifierHash: await hashRecipientIdentifier(
					c.env.ENCRYPTION_KEY,
					orgId,
					"whatsapp",
					"marketing",
					recipient.phone,
				),
			})),
		)
	).filter((recipient) => allowedHashes.has(recipient.identifierHash));
	const uniqueRecipients = Array.from(
		new Map(
			authorizedRecipients.map((recipient) => [
				recipient.identifierHash,
				recipient,
			]),
		).values(),
	);
	if (uniqueRecipients.length === 0) {
		return c.json(
			{
				error: {
					code: "CONSENT_REQUIRED",
					message: "No recipient has current WhatsApp marketing consent",
				},
			},
			400,
		);
	}

	// Persist as a scheduled broadcast and let the broadcast processor deliver it
	// asynchronously — the previous inline send loop could exceed Worker
	// wall-time / subrequest limits for large recipient lists. Clients poll
	// GET /v1/broadcasts/{id} for delivery status.
	const b = await db.transaction(async (tx) => {
		// Re-read and lock the active account in the same transaction that makes
		// the due parent visible. Disconnect and workspace changes cannot interleave
		// between validation and the parent/recipient commit.
		const [activeAccount] = await tx
			.select({
				id: socialAccounts.id,
				workspaceId: socialAccounts.workspaceId,
				scopeKey: socialAccounts.scopeKey,
			})
			.from(socialAccounts)
			.where(
				and(
					eq(socialAccounts.id, account.id),
					eq(socialAccounts.organizationId, orgId),
					eq(socialAccounts.platform, "whatsapp"),
					eq(socialAccounts.lifecycleStatus, "active"),
				),
			)
			.limit(1)
			.for("update");
		if (!activeAccount) return null;

		const [broadcast] = await tx
			.insert(broadcasts)
			.values({
				organizationId: orgId,
				workspaceId: activeAccount.workspaceId,
				socialAccountId: activeAccount.id,
				platform: "whatsapp",
				name: "WhatsApp bulk send",
				templateName: body.template.name,
				templateLanguage: body.template.language,
				templateComponents: body.template.components ?? null,
				status: "scheduled",
				scheduledAt: new Date(),
				recipientCount: uniqueRecipients.length,
			})
			.returning();
		if (!broadcast) throw new Error("Failed to create broadcast");

		await tx.insert(broadcastRecipients).values(
			uniqueRecipients.map((recipient) => ({
				organizationId: orgId,
				scopeKey: broadcast.scopeKey,
				broadcastId: broadcast.id,
				contactIdentifier: recipient.phone,
				contactIdentifierHash: recipient.identifierHash,
				variables: recipient.variables ?? null,
			})),
		);
		return broadcast;
	});
	if (!b) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account became inactive before queueing",
				},
			},
			401,
		);
	}
	return c.json(
		{
			id: b.id,
			name: b.name ?? null,
			description: b.description ?? null,
			platform: b.platform,
			account_id: b.socialAccountId,
			status: b.status as
				| "draft"
				| "scheduled"
				| "sending"
				| "sent"
				| "partially_failed"
				| "requires_attention"
				| "failed"
				| "cancelled",
			message_text: b.messageText ?? null,
			template_name: b.templateName ?? null,
			template_language: b.templateLanguage ?? null,
			recipient_count: b.recipientCount,
			sent_count: b.sentCount,
			failed_count: b.failedCount,
			scheduled_at: b.scheduledAt?.toISOString() ?? null,
			completed_at: b.completedAt?.toISOString() ?? null,
			created_at: b.createdAt.toISOString(),
		},
		200,
	);
});

// --- Templates (WhatsApp Cloud API) ---

app.openapi(listTemplates, async (c) => {
	const orgId = c.get("orgId");
	const { account_id } = c.req.valid("query");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const meta = account.metadata as Record<string, unknown> | null;
	const wabaId = meta?.waba_id as string | undefined;
	if (!wabaId) {
		return c.json(
			{
				error: {
					code: "MISSING_WABA_ID",
					message:
						"WhatsApp Business Account ID not configured in account metadata",
				},
			},
			401,
		);
	}

	try {
		// WhatsApp Business Management API: List message templates for a WABA
		// https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
		const res = await fetch(`${WA_API_BASE}/${wabaId}/message_templates`, {
			headers: { Authorization: `Bearer ${account.accessToken}` },
		});
		if (!res.ok) {
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to list templates: ${err}`,
					},
				},
				401,
			);
		}
		const json = (await readProviderJson(res)) as {
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
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			401,
		);
	}
});

app.openapi(createTemplate, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		body.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const meta = account.metadata as Record<string, unknown> | null;
	const wabaId = meta?.waba_id as string | undefined;
	if (!wabaId) {
		return c.json(
			{
				error: {
					code: "MISSING_WABA_ID",
					message:
						"WhatsApp Business Account ID not configured in account metadata",
				},
			},
			401,
		);
	}

	try {
		// WhatsApp Business Management API: Create a new message template
		// https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates#create-message-templates
		const res = await trackSingleUnitProviderMutation(
			c.get("mutationEffectTracker"),
			"meta.whatsapp.template.create",
			() =>
				fetch(`${WA_API_BASE}/${wabaId}/message_templates`, {
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
				}),
		);

		if (!res.ok) {
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to create template: ${err}`,
					},
				},
				401,
			);
		}

		// The Cloud API returns { id, status, category } on success
		const json = (await readProviderJson(res)) as {
			id: string;
			status: string;
			category: string;
		};

		return c.json(
			{
				name: body.name,
				language: body.language,
				status: (json.status ?? "PENDING") as
					| "APPROVED"
					| "PENDING"
					| "REJECTED",
				category: body.category,
				components: body.components,
			},
			201,
		);
	} catch (e) {
		return c.json(
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			401,
		);
	}
});

app.openapi(getTemplate, async (c) => {
	const orgId = c.get("orgId");
	const { template_name } = c.req.valid("param");
	const { account_id } = c.req.valid("query");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const meta = account.metadata as Record<string, unknown> | null;
	const wabaId = meta?.waba_id as string | undefined;
	if (!wabaId) {
		return c.json(
			{
				error: {
					code: "MISSING_WABA_ID",
					message:
						"WhatsApp Business Account ID not configured in account metadata",
				},
			},
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
		const json = (await readProviderJson(res)) as {
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
				category: template.category as
					| "MARKETING"
					| "UTILITY"
					| "AUTHENTICATION",
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
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			404,
		);
	}
});

app.openapi(deleteTemplate, async (c) => {
	const orgId = c.get("orgId");
	const { template_name } = c.req.valid("param");
	const { account_id } = c.req.valid("query");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const meta = account.metadata as Record<string, unknown> | null;
	const wabaId = meta?.waba_id as string | undefined;
	if (!wabaId) {
		return c.json(
			{
				error: {
					code: "MISSING_WABA_ID",
					message:
						"WhatsApp Business Account ID not configured in account metadata",
				},
			},
			401,
		);
	}

	try {
		// WhatsApp Business Management API: Delete a message template by name
		// https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates#delete-message-templates
		const res = await trackSingleUnitProviderMutation(
			c.get("mutationEffectTracker"),
			"meta.whatsapp.template.delete",
			() =>
				fetch(
					`${WA_API_BASE}/${wabaId}/message_templates?name=${encodeURIComponent(template_name)}`,
					{
						method: "DELETE",
						headers: {
							Authorization: `Bearer ${account.accessToken}`,
						},
					},
				),
		);

		if (!res.ok) {
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to delete template: ${err}`,
					},
				},
				401,
			);
		}
	} catch (e) {
		return c.json(
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			401,
		);
	}

	return c.body(null, 204);
});

// --- Business Profile (WhatsApp Cloud API) ---

app.openapi(getBusinessProfile, async (c) => {
	const orgId = c.get("orgId");
	const { account_id } = c.req.valid("query");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
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
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to get business profile: ${err}`,
					},
				},
				401,
			);
		}

		const json = (await readProviderJson(res)) as {
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
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			401,
		);
	}
});

app.openapi(updateBusinessProfile, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		body.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const phoneNumberId = account.platformAccountId;

	// Build the update payload - only include fields that are provided
	const updatePayload: Record<string, unknown> = {
		messaging_product: "whatsapp",
	};
	if (body.about !== undefined) updatePayload.about = body.about;
	if (body.description !== undefined)
		updatePayload.description = body.description;
	if (body.email !== undefined) updatePayload.email = body.email;
	if (body.websites !== undefined) updatePayload.websites = body.websites;
	if (body.address !== undefined) updatePayload.address = body.address;

	try {
		// WhatsApp Cloud API: Update the business profile for a phone number
		// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/business-profiles
		const updateRes = await trackSingleUnitProviderMutation(
			c.get("mutationEffectTracker"),
			"meta.whatsapp.business_profile.update",
			() =>
				fetch(`${WA_API_BASE}/${phoneNumberId}/whatsapp_business_profile`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${account.accessToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(updatePayload),
				}),
		);

		if (!updateRes.ok) {
			const err = await readProviderText(updateRes);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to update business profile: ${err}`,
					},
				},
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

		const json = (await readProviderJson(getRes)) as {
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
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			401,
		);
	}
});

// --- Phone Numbers (WhatsApp Cloud API) ---

app.openapi(listPhoneNumbers, async (c) => {
	const orgId = c.get("orgId");
	const { account_id } = c.req.valid("query");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const meta = account.metadata as Record<string, unknown> | null;
	const wabaId = meta?.waba_id as string | undefined;
	if (!wabaId) {
		return c.json(
			{
				error: {
					code: "MISSING_WABA_ID",
					message:
						"WhatsApp Business Account ID not configured in account metadata",
				},
			},
			401,
		);
	}

	try {
		// WhatsApp Business Management API: List phone numbers for a WABA
		// https://developers.facebook.com/docs/whatsapp/business-management-api/phone-numbers
		const res = await fetch(`${WA_API_BASE}/${wabaId}/phone_numbers`, {
			headers: { Authorization: `Bearer ${account.accessToken}` },
		});

		if (!res.ok) {
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to list phone numbers: ${err}`,
					},
				},
				401,
			);
		}

		const json = (await readProviderJson(res)) as {
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
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			401,
		);
	}
});

// --- Display Name ---

app.openapi(getDisplayName, async (c) => {
	const orgId = c.get("orgId");
	const { account_id } = c.req.valid("query");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
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
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to get display name: ${err}`,
					},
				},
				401,
			);
		}

		const data = (await readProviderJson(res)) as {
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
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			401,
		);
	}
});

app.openapi(updateDisplayName, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		body.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
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
		const res = await trackSingleUnitProviderMutation(
			c.get("mutationEffectTracker"),
			"meta.whatsapp.display_name.update",
			() =>
				fetch(
					`${WA_API_BASE}/${phoneNumberId}?new_display_name=${encodeURIComponent(body.display_name)}`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${account.accessToken}`,
						},
					},
				),
		);

		if (!res.ok) {
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to update display name: ${err}`,
					},
				},
				401,
			);
		}

		return c.json(
			{
				success: true,
				message:
					"Display name change request submitted. Meta review may take 1-3 business days.",
			},
			200,
		);
	} catch (e) {
		return c.json(
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			401,
		);
	}
});

// --- Profile Photo ---

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(uploadProfilePhoto, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		body.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const phoneNumberId = account.platformAccountId;

	try {
		// SSRF protection: only allow HTTPS URLs and block private/loopback addresses
		const photoUrl = new URL(body.photo_url);
		if (photoUrl.protocol !== "https:") {
			return c.json(
				{
					error: {
						code: "INVALID_URL",
						message: "Only HTTPS URLs are allowed",
					},
				},
				400,
			);
		}
		const host = photoUrl.hostname.toLowerCase();
		if (
			host === "localhost" ||
			host === "127.0.0.1" ||
			host === "[::1]" ||
			host.endsWith(".local") ||
			host.startsWith("10.") ||
			host.startsWith("192.168.") ||
			host.startsWith("169.254.") ||
			/^172\.(1[6-9]|2\d|3[01])\./.test(host)
		) {
			return c.json(
				{
					error: {
						code: "INVALID_URL",
						message: "Private or localhost URLs are not allowed",
					},
				},
				400,
			);
		}

		// Step 1: Fetch the image from the provided URL
		const imageRes = await fetchPublicUrl(body.photo_url, {
			timeout: 30_000,
			timeoutThroughBody: true,
			maxBytes: WHATSAPP_PROFILE_PHOTO_MAX_BYTES,
		});
		if (!imageRes.ok) {
			return c.json(
				{
					error: {
						code: "FETCH_FAILED",
						message: `Failed to fetch image from URL: ${imageRes.statusText}`,
					},
				},
				400,
			);
		}

		const imageBytes = await readResponseBytes(
			imageRes,
			WHATSAPP_PROFILE_PHOTO_MAX_BYTES,
		);
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
			const err = await readProviderText(sessionRes);
			return c.json(
				{
					error: {
						code: "UPLOAD_SESSION_FAILED",
						message: `Failed to create upload session: ${err}`,
					},
				},
				502,
			);
		}

		const sessionData = (await readProviderJson(sessionRes)) as { id?: string };
		const uploadSessionId = sessionData.id;
		if (!uploadSessionId) {
			return c.json(
				{
					error: {
						code: "UPLOAD_SESSION_FAILED",
						message: "No upload session ID returned",
					},
				},
				502,
			);
		}

		// Step 3: Upload the file bytes
		// Docs: https://developers.facebook.com/docs/graph-api/guides/upload
		// Section: "Upload File Data" — POST /upload:<SESSION_ID>
		// Headers: Authorization: OAuth {token}, file_offset: 0
		// Body: raw binary | Returns: { h: "<FILE_HANDLE>" }
		const uploadRes = await fetch(`${WA_API_BASE}/${uploadSessionId}`, {
			method: "POST",
			headers: {
				Authorization: `OAuth ${account.accessToken}`,
				"Content-Type": contentType,
				file_offset: "0",
			},
			body: imageBytes,
		});

		if (!uploadRes.ok) {
			const err = await readProviderText(uploadRes);
			return c.json(
				{
					error: {
						code: "UPLOAD_FAILED",
						message: `Failed to upload photo: ${err}`,
					},
				},
				502,
			);
		}

		const uploadData = (await readProviderJson(uploadRes)) as { h?: string };
		const fileHandle = uploadData.h;
		if (!fileHandle) {
			return c.json(
				{
					error: { code: "UPLOAD_FAILED", message: "No file handle returned" },
				},
				502,
			);
		}

		// Step 4: Set the profile picture handle on the business profile
		// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/business-profiles
		// Confirmed via: https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/whatsapp-business-profile-api
		// Section: "Update Fields" — profile_picture_handle is a valid POST field
		// Requires: messaging_product: "whatsapp" and the handle from Resumable Upload API
		const profileRes = await trackSingleUnitProviderMutation(
			c.get("mutationEffectTracker"),
			"meta.whatsapp.business_profile.photo.update",
			() =>
				fetch(`${WA_API_BASE}/${phoneNumberId}/whatsapp_business_profile`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${account.accessToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						messaging_product: "whatsapp",
						profile_picture_handle: fileHandle,
					}),
				}),
		);

		if (!profileRes.ok) {
			const err = await readProviderText(profileRes);
			return c.json(
				{
					error: {
						code: "PROFILE_UPDATE_FAILED",
						message: `Failed to set profile photo: ${err}`,
					},
				},
				502,
			);
		}

		// Step 5: Fetch the updated profile to get the new URL
		const updatedRes = await fetch(
			`${WA_API_BASE}/${phoneNumberId}/whatsapp_business_profile?fields=profile_picture_url`,
			{ headers: { Authorization: `Bearer ${account.accessToken}` } },
		);
		const updatedJson = (await readProviderJson(updatedRes)) as {
			data?: Array<{ profile_picture_url?: string }>;
		};
		const newUrl = updatedJson.data?.[0]?.profile_picture_url ?? null;

		return c.json({ success: true, profile_picture_url: newUrl }, 200);
	} catch (e) {
		return c.json(
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			502,
		);
	}
});

// --- WhatsApp Flows ---

/** Helper to resolve WABA ID from account metadata */
function getWabaId(account: { metadata: unknown }): string | undefined {
	return (account.metadata as Record<string, unknown> | null)?.waba_id as
		| string
		| undefined;
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
		if (!res.ok)
			return {
				owned: false,
				error: `Flow not found or inaccessible (HTTP ${res.status})`,
			};
		const data = (await readProviderJson(res)) as {
			whatsapp_business_account?: { id?: string };
		};
		const flowWabaId = data.whatsapp_business_account?.id;
		if (!flowWabaId) {
			return {
				owned: false,
				error: "Could not verify flow ownership: WABA not returned by Meta API",
			};
		}
		if (flowWabaId !== wabaId) {
			return {
				owned: false,
				error: "Flow does not belong to this WhatsApp Business Account",
			};
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
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const wabaId = getWabaId(account);
	if (!wabaId) {
		return c.json(
			{ error: { code: "MISSING_WABA_ID", message: "WABA ID not configured" } },
			401,
		);
	}

	try {
		// WhatsApp Flows API — List flows for a WABA
		// Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
		// Section: "List Flows" — GET /{waba-id}/flows
		const res = await fetch(`${WA_API_BASE}/${wabaId}/flows`, {
			headers: { Authorization: `Bearer ${account.accessToken}` },
		});
		if (!res.ok) {
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to list flows: ${err}`,
					},
				},
				502,
			);
		}
		const json = (await readProviderJson(res)) as {
			data?: Array<Record<string, unknown>>;
		};
		return c.json({ data: json.data ?? [] }, 200);
	} catch (e) {
		return c.json(
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			502,
		);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(createFlow, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		body.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const wabaId = getWabaId(account);
	if (!wabaId) {
		return c.json(
			{ error: { code: "MISSING_WABA_ID", message: "WABA ID not configured" } },
			401,
		);
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

		const res = await trackSingleUnitProviderMutation(
			c.get("mutationEffectTracker"),
			"meta.whatsapp.flow.create",
			() =>
				fetch(`${WA_API_BASE}/${wabaId}/flows`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${account.accessToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(payload),
				}),
		);

		if (!res.ok) {
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to create flow: ${err}`,
					},
				},
				502,
			);
		}

		const data = (await readProviderJson(res)) as { id?: string };
		if (!data.id) {
			return c.json(
				{ error: { code: "WA_API_ERROR", message: "No flow ID returned" } },
				502,
			);
		}

		// Fetch the full flow details
		const detailRes = await fetch(
			`${WA_API_BASE}/${data.id}?fields=id,name,status,categories,validation_errors`,
			{ headers: { Authorization: `Bearer ${account.accessToken}` } },
		);
		const detail = (await readProviderJson(detailRes)) as Record<
			string,
			unknown
		>;
		return c.json(detail, 201);
	} catch (e) {
		return c.json(
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			502,
		);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(getFlow, async (c) => {
	const orgId = c.get("orgId");
	const { flow_id } = c.req.valid("param");
	const { account_id } = c.req.valid("query");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const wabaId = getWabaId(account);
	if (wabaId) {
		const ownership = await assertFlowOwnership(
			flow_id,
			wabaId,
			account.accessToken,
		);
		if (!ownership.owned) {
			return c.json(
				{ error: { code: "FORBIDDEN", message: ownership.error } },
				403,
			);
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
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to get flow: ${err}`,
					},
				},
				502,
			);
		}
		const data = (await readProviderJson(res)) as Record<string, unknown>;
		return c.json(data, 200);
	} catch (e) {
		return c.json(
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			502,
		);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(updateFlow, async (c) => {
	const orgId = c.get("orgId");
	const { flow_id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		body.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const wabaId = getWabaId(account);
	if (wabaId) {
		const ownership = await assertFlowOwnership(
			flow_id,
			wabaId,
			account.accessToken,
		);
		if (!ownership.owned) {
			return c.json(
				{ error: { code: "FORBIDDEN", message: ownership.error } },
				403,
			);
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

		const res = await trackSingleUnitProviderMutation(
			c.get("mutationEffectTracker"),
			"meta.whatsapp.flow.update",
			() =>
				fetch(`${WA_API_BASE}/${flow_id}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${account.accessToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(payload),
				}),
		);

		if (!res.ok) {
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to update flow: ${err}`,
					},
				},
				502,
			);
		}

		// Fetch updated details
		const detailRes = await fetch(
			`${WA_API_BASE}/${flow_id}?fields=id,name,status,categories,validation_errors`,
			{ headers: { Authorization: `Bearer ${account.accessToken}` } },
		);
		const detail = (await readProviderJson(detailRes)) as Record<
			string,
			unknown
		>;
		return c.json(detail, 200);
	} catch (e) {
		return c.json(
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			502,
		);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(deleteFlow, async (c) => {
	const orgId = c.get("orgId");
	const { flow_id } = c.req.valid("param");
	const { account_id } = c.req.valid("query");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const wabaId = getWabaId(account);
	if (wabaId) {
		const ownership = await assertFlowOwnership(
			flow_id,
			wabaId,
			account.accessToken,
		);
		if (!ownership.owned) {
			return c.json(
				{ error: { code: "FORBIDDEN", message: ownership.error } },
				403,
			);
		}
	}

	try {
		// WhatsApp Flows API — Delete a DRAFT flow
		// Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
		// Section: "Delete Flow" — DELETE /{flow-id}, returns { success: true }
		const res = await trackSingleUnitProviderMutation(
			c.get("mutationEffectTracker"),
			"meta.whatsapp.flow.delete",
			() =>
				fetch(`${WA_API_BASE}/${flow_id}`, {
					method: "DELETE",
					headers: { Authorization: `Bearer ${account.accessToken}` },
				}),
		);

		if (!res.ok) {
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to delete flow: ${err}`,
					},
				},
				502,
			);
		}

		return c.json({ success: true }, 200);
	} catch (e) {
		return c.json(
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			502,
		);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(publishFlow, async (c) => {
	const orgId = c.get("orgId");
	const { flow_id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		body.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const wabaId = getWabaId(account);
	if (wabaId) {
		const ownership = await assertFlowOwnership(
			flow_id,
			wabaId,
			account.accessToken,
		);
		if (!ownership.owned) {
			return c.json(
				{ error: { code: "FORBIDDEN", message: ownership.error } },
				403,
			);
		}
	}

	try {
		// WhatsApp Flows API — Publish a flow (irreversible, DRAFT → PUBLISHED)
		// Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
		// Section: "Publish Flow" — POST /{flow-id}/publish, no body required, returns { success: true }
		const res = await trackSingleUnitProviderMutation(
			c.get("mutationEffectTracker"),
			"meta.whatsapp.flow.publish",
			() =>
				fetch(`${WA_API_BASE}/${flow_id}/publish`, {
					method: "POST",
					headers: { Authorization: `Bearer ${account.accessToken}` },
				}),
		);

		if (!res.ok) {
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to publish flow: ${err}`,
					},
				},
				502,
			);
		}

		return c.json({ success: true }, 200);
	} catch (e) {
		return c.json(
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			502,
		);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(deprecateFlow, async (c) => {
	const orgId = c.get("orgId");
	const { flow_id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		body.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const wabaId = getWabaId(account);
	if (wabaId) {
		const ownership = await assertFlowOwnership(
			flow_id,
			wabaId,
			account.accessToken,
		);
		if (!ownership.owned) {
			return c.json(
				{ error: { code: "FORBIDDEN", message: ownership.error } },
				403,
			);
		}
	}

	try {
		// WhatsApp Flows API — Deprecate a published flow (irreversible)
		// Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
		// Section: "Deprecate Flow" — POST /{flow-id}/deprecate, no body, returns { success: true }
		const res = await trackSingleUnitProviderMutation(
			c.get("mutationEffectTracker"),
			"meta.whatsapp.flow.deprecate",
			() =>
				fetch(`${WA_API_BASE}/${flow_id}/deprecate`, {
					method: "POST",
					headers: { Authorization: `Bearer ${account.accessToken}` },
				}),
		);

		if (!res.ok) {
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to deprecate flow: ${err}`,
					},
				},
				502,
			);
		}

		return c.json({ success: true }, 200);
	} catch (e) {
		return c.json(
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			502,
		);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(getFlowJson, async (c) => {
	const orgId = c.get("orgId");
	const { flow_id } = c.req.valid("param");
	const { account_id } = c.req.valid("query");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const wabaId = getWabaId(account);
	if (wabaId) {
		const ownership = await assertFlowOwnership(
			flow_id,
			wabaId,
			account.accessToken,
		);
		if (!ownership.owned) {
			return c.json(
				{ error: { code: "FORBIDDEN", message: ownership.error } },
				403,
			);
		}
	}

	try {
		// WhatsApp Flows API — Get flow assets (JSON definition)
		// Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
		// Section: "Get Flow Assets" — GET /{flow-id}/assets
		// Returns: { data: [{ name, asset_type, download_url }] } — look for name === "flow.json"
		const res = await fetch(`${WA_API_BASE}/${flow_id}/assets`, {
			headers: { Authorization: `Bearer ${account.accessToken}` },
		});

		if (!res.ok) {
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to get flow JSON: ${err}`,
					},
				},
				502,
			);
		}

		const json = (await readProviderJson(res)) as {
			data?: Array<{ name?: string; download_url?: string }>;
		};
		const asset = json.data?.find((a) => a.name === "flow.json");

		return c.json(
			{
				download_url: asset?.download_url ?? null,
				expires_at: null,
			},
			200,
		);
	} catch (e) {
		return c.json(
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			502,
		);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(uploadFlowJson, async (c) => {
	const orgId = c.get("orgId");
	const { flow_id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		body.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}

	const wabaId = getWabaId(account);
	if (wabaId) {
		const ownership = await assertFlowOwnership(
			flow_id,
			wabaId,
			account.accessToken,
		);
		if (!ownership.owned) {
			return c.json(
				{ error: { code: "FORBIDDEN", message: ownership.error } },
				403,
			);
		}
	}

	try {
		// WhatsApp Flows API — Upload/update flow JSON asset
		// Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
		// Section: "Update Flow JSON" — POST /{flow-id}/assets (multipart form-data)
		// Required fields: file (JSON blob), name: "flow.json", asset_type: "FLOW_JSON"
		// A successful update still returns validation_errors when the uploaded
		// draft is invalid. The asset was updated, so that response remains K=1.
		const flowJsonBlob = new Blob([JSON.stringify(body.flow_json)], {
			type: "application/json",
		});
		const formData = new FormData();
		formData.append("file", flowJsonBlob, "flow.json");
		formData.append("name", "flow.json");
		formData.append("asset_type", "FLOW_JSON");

		const res = await trackSingleUnitProviderMutation(
			c.get("mutationEffectTracker"),
			"meta.whatsapp.flow.json.update",
			() =>
				fetch(`${WA_API_BASE}/${flow_id}/assets`, {
					method: "POST",
					headers: { Authorization: `Bearer ${account.accessToken}` },
					body: formData,
				}),
		);

		const responseBody = await readProviderText(res);
		let parsed:
			| {
					success?: boolean;
					validation_errors?: unknown[];
					error?: {
						error_user_msg?: string;
						error_data?: { validation_errors?: unknown[] };
					};
			  }
			| undefined;
		try {
			parsed = JSON.parse(responseBody) as typeof parsed;
		} catch {
			/* not JSON */
		}

		if (!res.ok) {
			const validationErrors = parsed?.error?.error_data?.validation_errors;
			if (validationErrors) {
				// The provider-boundary helper has already classified this status.
				// Do not turn an ambiguous 408/425/429/5xx into false K=0 proof.
				return c.json(
					{ success: false, validation_errors: validationErrors },
					200,
				);
			}
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to upload flow JSON: ${responseBody}`,
					},
				},
				502,
			);
		}

		return c.json(
			{
				success: parsed?.success ?? true,
				...(parsed?.validation_errors
					? { validation_errors: parsed.validation_errors }
					: {}),
			},
			200,
		);
	} catch (e) {
		return c.json(
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			502,
		);
	}
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(sendFlowMessage, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const account = await getWhatsAppAccount(
		db,
		body.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account?.accessToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "WhatsApp account not found or missing access token",
				},
			},
			401,
		);
	}
	const allowedFlowHashes = await getAllowedRecipientHashes(
		db,
		c.env.ENCRYPTION_KEY,
		orgId,
		"whatsapp",
		"automation",
		[{ identifier: body.recipient_phone }],
	);
	if (
		!allowedFlowHashes.has(
			await hashRecipientIdentifier(
				c.env.ENCRYPTION_KEY,
				orgId,
				"whatsapp",
				"automation",
				body.recipient_phone,
			),
		)
	) {
		return c.json(
			{
				error: {
					code: "CONSENT_REQUIRED",
					message: "Current WhatsApp automation consent is required",
				},
			},
			400,
		);
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
				header: body.header_text
					? { type: "text", text: body.header_text }
					: undefined,
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

		const res = await trackSingleUnitProviderMutation(
			c.get("mutationEffectTracker"),
			"meta.whatsapp.flow.message.send",
			() =>
				fetch(`${WA_API_BASE}/${phoneNumberId}/messages`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${account.accessToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(payload),
				}),
		);

		if (!res.ok) {
			const err = await readProviderText(res);
			return c.json(
				{
					error: {
						code: "WA_API_ERROR",
						message: `Failed to send flow message: ${err}`,
					},
				},
				502,
			);
		}

		const json = (await readProviderJson(res)) as {
			messages?: Array<{ id?: string }>;
		};
		const messageId = json.messages?.[0]?.id ?? "";

		return c.json({ message_id: messageId }, 200);
	} catch (e) {
		return c.json(
			{
				error: {
					code: "WA_API_ERROR",
					message: e instanceof Error ? e.message : "Unknown error",
				},
			},
			502,
		);
	}
});

export default app;
