import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	type createDb,
	socialAccounts,
	whatsappPhoneNumbers,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { GRAPH_BASE } from "../config/api-versions";
import {
	decryptAccountToken,
	decryptAccountTokens,
} from "../lib/account-token-crypto";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import { inheritOperationalCreateScope } from "../lib/request-access";
import { canAccessWorkspaceScope } from "../lib/workspace-scope";
import { ErrorResponse } from "../schemas/common";
import {
	PhoneNumberIdParams,
	PhoneNumberStatusQuery,
	ProvisionedPhoneNumberListResponse,
	ProvisionedPhoneNumberResponse,
	PurchasePhoneNumberBody,
	PurchasePhoneNumberResponse,
	RequestCodeBody,
	VerifyCodeBody,
} from "../schemas/whatsapp";
import { upsertConnectedAccountWithCredentials } from "../services/account-credential-write";
import {
	continuePhoneProvisioning,
	createPhoneProvisioningOperation,
	findPhoneProvisioningOperation,
	PhoneOperationError,
	processPhoneRelease,
	stagePhoneRelease,
} from "../services/phone-number-operations";
import { searchAvailableNumbers } from "../services/telnyx";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const WA_API_BASE = GRAPH_BASE.facebook;
const RequiredIdempotencyKeyHeaders = z.object({
	"idempotency-key": z.string().min(1).openapi({
		description:
			"Caller-generated key that identifies one logical phone-number purchase",
		example: "wa-phone-purchase-018f1f6e",
	}),
});

// ---------------------------------------------------------------------------
// Helper: look up a WhatsApp social account by id + org
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
	if (!canAccessWorkspaceScope(workspaceScope, account.workspaceId))
		return null;
	return decryptAccountTokens(account, encryptionKey);
}

// ---------------------------------------------------------------------------
// Helper: get the exact WhatsApp account that initiated this provisioning
// ---------------------------------------------------------------------------

async function getProvisioningWhatsAppToken(
	db: ReturnType<typeof createDb>,
	phone: typeof whatsappPhoneNumbers.$inferSelect,
	orgId: string,
	encryptionKey?: string,
	workspaceScope: "all" | string[] = "all",
): Promise<{
	accessToken: string;
	wabaId: string | undefined;
	workspaceId: string | null;
} | null> {
	const sourceAccountId = phone.provisioningSourceAccountId;
	const request = phone.provisioningRequest as { waba_id?: unknown } | null;
	const expectedWabaId =
		typeof request?.waba_id === "string" ? request.waba_id : null;
	if (!sourceAccountId || !expectedWabaId) return null;

	const [account] = await db
		.select()
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, sourceAccountId),
				eq(socialAccounts.organizationId, orgId),
				eq(socialAccounts.platform, "whatsapp"),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		)
		.limit(1);
	if (!account) return null;
	if (!canAccessWorkspaceScope(workspaceScope, account.workspaceId))
		return null;

	const wabaId = (account.metadata as { waba_id?: string } | null)?.waba_id;
	if (wabaId !== expectedWabaId) return null;
	const accessToken = await decryptAccountToken(
		account.accessToken,
		encryptionKey,
		account.id,
		"access_token",
	);
	return accessToken
		? { accessToken, wabaId, workspaceId: account.workspaceId }
		: null;
}

// ---------------------------------------------------------------------------
// Helper: map DB row to API response shape
// ---------------------------------------------------------------------------

function formatPhoneNumber(row: typeof whatsappPhoneNumbers.$inferSelect) {
	return {
		id: row.id,
		phone_number: row.phoneNumber,
		status: row.status as
			| "purchasing"
			| "pending_verification"
			| "verified"
			| "active"
			| "releasing"
			| "released",
		provider: row.provider,
		country: row.country,
		wa_phone_number_id: row.waPhoneNumberId ?? null,
		social_account_id: row.socialAccountId ?? null,
		monthly_cost_cents: row.monthlyCostCents,
		created_at: row.createdAt.toISOString(),
	};
}

// ===========================================================================
// Route definitions
// ===========================================================================

const listPhoneNumbers = createRoute({
	operationId: "whatsappListProvisionedPhoneNumbers",
	method: "get",
	// Distinct from the bare `/v1/whatsapp/phone-numbers` so it does not collide
	// with the Cloud-API "registered numbers" list (whatsapp router). Resolves to
	// /v1/whatsapp/phone-numbers/provisioned.
	path: "/provisioned",
	tags: ["WhatsApp Phone Provisioning"],
	summary: "List purchased phone numbers",
	security: [{ Bearer: [] }],
	request: { query: PhoneNumberStatusQuery },
	responses: {
		200: {
			description: "Phone numbers list",
			content: {
				"application/json": { schema: ProvisionedPhoneNumberListResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const purchasePhoneNumber = createRoute({
	operationId: "whatsappPurchasePhoneNumber",
	method: "post",
	path: "/purchase",
	tags: ["WhatsApp Phone Provisioning"],
	summary: "Purchase a US phone number",
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredIdempotencyKeyHeaders,
		body: {
			content: { "application/json": { schema: PurchasePhoneNumberBody } },
		},
	},
	responses: {
		201: {
			description: "Phone number purchase initiated",
			content: {
				"application/json": { schema: PurchasePhoneNumberResponse },
			},
		},
		400: {
			description: "Missing or reused idempotency key",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Forbidden — Pro plan required",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Conflict — another number is in progress or limit reached",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getPhoneNumber = createRoute({
	operationId: "whatsappGetProvisionedPhoneNumber",
	method: "get",
	path: "/{phone_number_id}",
	tags: ["WhatsApp Phone Provisioning"],
	summary: "Get phone number status",
	security: [{ Bearer: [] }],
	request: { params: PhoneNumberIdParams },
	responses: {
		200: {
			description: "Phone number details",
			content: {
				"application/json": { schema: ProvisionedPhoneNumberResponse },
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

const requestCode = createRoute({
	operationId: "whatsappRequestVerificationCode",
	method: "post",
	path: "/{phone_number_id}/request-code",
	tags: ["WhatsApp Phone Provisioning"],
	summary: "Request verification code via SMS or voice",
	security: [{ Bearer: [] }],
	request: {
		params: PhoneNumberIdParams,
		body: {
			content: { "application/json": { schema: RequestCodeBody } },
		},
	},
	responses: {
		200: {
			description: "Verification code requested",
			content: {
				"application/json": {
					schema: z.object({ success: z.boolean() }),
				},
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
		409: {
			description: "Number not in pending_verification status",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const verifyCode = createRoute({
	operationId: "whatsappVerifyPhoneNumber",
	method: "post",
	path: "/{phone_number_id}/verify",
	tags: ["WhatsApp Phone Provisioning"],
	summary: "Submit verification code",
	security: [{ Bearer: [] }],
	request: {
		params: PhoneNumberIdParams,
		body: {
			content: { "application/json": { schema: VerifyCodeBody } },
		},
	},
	responses: {
		200: {
			description: "Phone number verified",
			content: {
				"application/json": {
					schema: z.object({ success: z.boolean(), status: z.string() }),
				},
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		400: {
			description: "Workspace ID required",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Number not in pending_verification status",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		500: {
			description: "Internal server error",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const releasePhoneNumber = createRoute({
	operationId: "whatsappReleasePhoneNumber",
	method: "delete",
	path: "/{phone_number_id}",
	tags: ["WhatsApp Phone Provisioning"],
	summary: "Release a phone number",
	security: [{ Bearer: [] }],
	request: { params: PhoneNumberIdParams },
	responses: {
		200: {
			description: "Phone number released",
			content: {
				"application/json": { schema: ProvisionedPhoneNumberResponse },
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
		409: {
			description: "Number cannot be released in current status",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// ===========================================================================
// Handlers
// ===========================================================================

// GET / — List purchased phone numbers
app.openapi(listPhoneNumbers, async (c) => {
	const orgId = c.get("orgId");
	const { status } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(whatsappPhoneNumbers.organizationId, orgId)];
	if (status) {
		conditions.push(eq(whatsappPhoneNumbers.status, status));
	}

	const rows = await db
		.select()
		.from(whatsappPhoneNumbers)
		.where(and(...conditions))
		.orderBy(whatsappPhoneNumbers.createdAt);

	return c.json({ data: rows.map(formatPhoneNumber) }, 200);
});

// POST /purchase — Purchase a US phone number
app.openapi(purchasePhoneNumber, async (c) => {
	const orgId = c.get("orgId");
	const plan = c.get("plan");
	const body = c.req.valid("json");
	const operationKey = c.req.valid("header")["idempotency-key"];
	const db = c.get("db");

	if (plan !== "pro") {
		return c.json(
			{
				error: {
					code: "PRO_REQUIRED",
					message: "Phone number provisioning requires a Pro plan",
				},
			},
			403,
		);
	}

	const telnyxApiKey = c.env.TELNYX_API_KEY;
	if (!telnyxApiKey) {
		return c.json(
			{
				error: {
					code: "CONFIG_ERROR",
					message: "Phone number provisioning is not configured",
				},
			},
			403,
		);
	}

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

	const wabaId = (account.metadata as { waba_id?: string } | null)?.waba_id;
	if (!wabaId) {
		return c.json(
			{
				error: {
					code: "WABA_NOT_FOUND",
					message: "WhatsApp Business Account ID not found on this account",
				},
			},
			401,
		);
	}

	const operationRequest = {
		account_id: body.account_id,
		waba_id: wabaId,
		verified_name: account.displayName ?? "Business",
		country: body.country,
		area_code: body.area_code,
	};
	try {
		let operation = await findPhoneProvisioningOperation(db, {
			organizationId: orgId,
			operationKey,
			request: operationRequest,
		});
		if (!operation) {
			// Availability search has no side effect. The durable row is committed
			// immediately after selection and before the first chargeable call.
			const available = await searchAvailableNumbers(telnyxApiKey, {
				countryCode: body.country,
				areaCode: body.area_code,
				limit: 1,
			});
			const selected = available[0];
			if (!selected) {
				return c.json(
					{
						error: {
							code: "NO_NUMBERS",
							message: "No phone numbers available for the requested criteria",
						},
					},
					409,
				);
			}
			const created = await createPhoneProvisioningOperation(db, {
				organizationId: orgId,
				operationKey,
				phoneNumber: selected.phone_number,
				request: operationRequest,
			});
			operation = created.row;
		}

		const completed = await continuePhoneProvisioning(c.env, db, operation.id);
		return c.json(
			{
				id: completed.id,
				phone_number: completed.phoneNumber,
				status: completed.status,
				checkout_url: completed.stripeCheckoutUrl,
			},
			201,
		);
	} catch (error) {
		if (error instanceof PhoneOperationError) {
			if (
				error.code === "IDEMPOTENCY_KEY_REQUIRED" ||
				error.code === "IDEMPOTENCY_KEY_REUSED"
			) {
				return c.json(
					{ error: { code: error.code, message: error.message } },
					400,
				);
			}
			return c.json(
				{ error: { code: error.code, message: error.message } },
				409,
			);
		}
		throw error;
	}
});

// GET /:phone_number_id — Get phone number status
app.openapi(getPhoneNumber, async (c) => {
	const orgId = c.get("orgId");
	const { phone_number_id } = c.req.valid("param");
	const db = c.get("db");

	const [row] = await db
		.select()
		.from(whatsappPhoneNumbers)
		.where(
			and(
				eq(whatsappPhoneNumbers.id, phone_number_id),
				eq(whatsappPhoneNumbers.organizationId, orgId),
			),
		)
		.limit(1);

	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Phone number not found" } },
			404,
		);
	}

	return c.json(formatPhoneNumber(row), 200);
});

// POST /:phone_number_id/request-code — Request verification code
app.openapi(requestCode, async (c) => {
	const orgId = c.get("orgId");
	const { phone_number_id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [row] = await db
		.select()
		.from(whatsappPhoneNumbers)
		.where(
			and(
				eq(whatsappPhoneNumbers.id, phone_number_id),
				eq(whatsappPhoneNumbers.organizationId, orgId),
			),
		)
		.limit(1);

	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Phone number not found" } },
			404,
		);
	}

	if (row.status !== "pending_verification") {
		return c.json(
			{
				error: {
					code: "INVALID_STATUS",
					message: "Phone number is not in pending_verification status",
				},
			},
			409,
		);
	}

	if (!row.waPhoneNumberId) {
		return c.json(
			{
				error: {
					code: "NOT_REGISTERED",
					message: "Phone number has not been registered with Meta yet",
				},
			},
			409,
		);
	}
	const waToken = await getProvisioningWhatsAppToken(
		db,
		row,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!waToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "The WhatsApp account used for provisioning is unavailable",
				},
			},
			401,
		);
	}
	const { accessToken } = waToken;

	// Meta WhatsApp API: Request verification code
	// https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/phone-number-verification-request-code-api
	const metaRes = await fetchWithTimeout(
		`${WA_API_BASE}/${row.waPhoneNumberId}/request_code`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				code_method: body.method.toUpperCase(),
				language: "en_US",
			}),
			timeout: 5_000,
		},
	);

	if (!metaRes.ok) {
		const err = (await metaRes.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return c.json(
			{
				error: {
					code: "META_API_ERROR",
					message: err.error?.message ?? `Meta API error: ${metaRes.status}`,
				},
			},
			409,
		);
	}

	await db
		.update(whatsappPhoneNumbers)
		.set({ verificationMethod: body.method, updatedAt: new Date() })
		.where(eq(whatsappPhoneNumbers.id, phone_number_id));

	return c.json({ success: true }, 200);
});

// POST /:phone_number_id/verify — Submit verification code
app.openapi(verifyCode, async (c) => {
	const orgId = c.get("orgId");
	const { phone_number_id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [row] = await db
		.select()
		.from(whatsappPhoneNumbers)
		.where(
			and(
				eq(whatsappPhoneNumbers.id, phone_number_id),
				eq(whatsappPhoneNumbers.organizationId, orgId),
			),
		)
		.limit(1);

	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Phone number not found" } },
			404,
		);
	}

	if (row.status !== "pending_verification") {
		return c.json(
			{
				error: {
					code: "INVALID_STATUS",
					message: "Phone number is not in pending_verification status",
				},
			},
			409,
		);
	}

	if (!row.waPhoneNumberId) {
		return c.json(
			{
				error: {
					code: "NOT_REGISTERED",
					message: "Phone number has not been registered with Meta yet",
				},
			},
			409,
		);
	}
	const verifiedWaPhoneNumberId = row.waPhoneNumberId;

	const waToken = await getProvisioningWhatsAppToken(
		db,
		row,
		orgId,
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!waToken) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "The WhatsApp account used for provisioning is unavailable",
				},
			},
			401,
		);
	}
	const { accessToken, wabaId, workspaceId: sourceWorkspaceId } = waToken;
	const accountScope = await inheritOperationalCreateScope(
		c,
		undefined,
		[sourceWorkspaceId],
		"WhatsApp account",
	);
	if (!accountScope.ok) return accountScope.response as never;
	const workspaceId = accountScope.workspaceId;

	// Step 1: Verify the code with Meta
	// https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account-to-number-current-status/verify_code
	// Official docs: code is passed as a query parameter
	const verifyRes = await fetchWithTimeout(
		`${WA_API_BASE}/${row.waPhoneNumberId}/verify_code?code=${encodeURIComponent(body.code)}`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${accessToken}` },
			timeout: 5_000,
		},
	);

	if (!verifyRes.ok) {
		const err = (await verifyRes.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return c.json(
			{
				error: {
					code: "VERIFICATION_FAILED",
					message:
						err.error?.message ?? `Verification failed: ${verifyRes.status}`,
				},
			},
			409,
		);
	}

	// Step 2: Register the number for Cloud API
	// https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/register-api
	const pin = String(Math.floor(100000 + Math.random() * 900000));
	const registerRes = await fetchWithTimeout(
		`${WA_API_BASE}/${row.waPhoneNumberId}/register`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messaging_product: "whatsapp",
				pin,
			}),
			timeout: 5_000,
		},
	);

	if (!registerRes.ok) {
		// Code verified but Cloud API registration failed — mark as verified (not active)
		await db
			.update(whatsappPhoneNumbers)
			.set({ status: "verified", updatedAt: new Date() })
			.where(eq(whatsappPhoneNumbers.id, phone_number_id));

		const regErr = (await registerRes.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return c.json(
			{
				error: {
					code: "REGISTRATION_FAILED",
					message:
						regErr.error?.message ??
						"Cloud API registration failed. Number is verified but not yet active.",
				},
			},
			409,
		);
	}

	// Steps 3-4: save the credential-bound account and activate the phone row
	// atomically. A failed credential write must not leave either row half-active.
	try {
		await db.transaction(async (tx) => {
			const account = await upsertConnectedAccountWithCredentials(
				tx,
				c.env.ENCRYPTION_KEY,
				{
					apiKeyId: c.get("keyId"),
					authorizedWorkspaceScope: c.get("workspaceScope"),
					insert: {
						organizationId: orgId,
						workspaceId,
						platform: "whatsapp",
						platformAccountId: verifiedWaPhoneNumberId,
						displayName: row.phoneNumber,
						metadata: { waba_id: wabaId },
					},
					update: {
						displayName: row.phoneNumber,
						metadata: { waba_id: wabaId },
					},
					accessToken,
				},
			);
			if (!account) throw new Error("Account upsert returned no row");
			await tx
				.update(whatsappPhoneNumbers)
				.set({
					status: "active",
					socialAccountId: account.id,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(whatsappPhoneNumbers.id, phone_number_id),
						eq(whatsappPhoneNumbers.organizationId, orgId),
					),
				);
		});
	} catch (err) {
		console.error(
			"[whatsapp-provisioning] Account upsert failed:",
			err instanceof Error ? err.message : err,
		);
		return c.json(
			{
				error: {
					code: "ACCOUNT_SAVE_FAILED",
					message: "Failed to save WhatsApp account. Please try again.",
				},
			},
			500,
		);
	}

	return c.json({ success: true, status: "active" }, 200);
});

// DELETE /:phone_number_id — Release a phone number
app.openapi(releasePhoneNumber, async (c) => {
	const orgId = c.get("orgId");
	const { phone_number_id } = c.req.valid("param");
	const db = c.get("db");

	const [row] = await db
		.select()
		.from(whatsappPhoneNumbers)
		.where(
			and(
				eq(whatsappPhoneNumbers.id, phone_number_id),
				eq(whatsappPhoneNumbers.organizationId, orgId),
			),
		)
		.limit(1);

	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Phone number not found" } },
			404,
		);
	}

	if (row.status === "released") {
		return c.json(formatPhoneNumber(row), 200);
	}

	const releasableStatuses = [
		"pending_verification",
		"verified",
		"active",
		"releasing",
	];
	if (!releasableStatuses.includes(row.status)) {
		return c.json(
			{
				error: {
					code: "INVALID_STATUS",
					message: `Cannot release a number in ${row.status} status`,
				},
			},
			409,
		);
	}

	try {
		const staged = await stagePhoneRelease(
			db,
			orgId,
			phone_number_id,
			"user_requested",
		);
		const released = await processPhoneRelease(c.env, db, staged.id);
		return c.json(formatPhoneNumber(released), 200);
	} catch (error) {
		if (error instanceof PhoneOperationError) {
			if (error.code === "NOT_FOUND") {
				return c.json(
					{ error: { code: error.code, message: error.message } },
					404,
				);
			}
			return c.json(
				{ error: { code: error.code, message: error.message } },
				409,
			);
		}

		// Provider failures are persisted as failed/unknown before control returns.
		// Surface the durable pending state so clients never infer that the number
		// has been released while mandatory cleanup is unconfirmed.
		const [pending] = await db
			.select()
			.from(whatsappPhoneNumbers)
			.where(eq(whatsappPhoneNumbers.id, phone_number_id))
			.limit(1);
		if (
			pending?.releaseState === "failed" ||
			pending?.releaseState === "unknown" ||
			pending?.releaseState === "request_may_have_been_sent"
		) {
			return c.json(
				{
					error: {
						code: "RELEASE_PENDING",
						message:
							"Provider cleanup is pending reconciliation; the number remains unreleased",
					},
				},
				409,
			);
		}
		throw error;
	}
});

export default app;
