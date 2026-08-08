import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { DASHBOARD_SESSION_AUTHORITY_HEADER } from "@relayapi/config";
import {
	type createDb,
	socialAccounts,
	whatsappPhoneNumbers,
	whatsappPhoneReleaseOperations,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { GRAPH_BASE } from "../config/api-versions";
import {
	decryptAccountToken,
	decryptAccountTokens,
} from "../lib/account-token-crypto";
import { durableCredentialAuthorityAdmission } from "../lib/durable-credential-authority";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import { isDefinitiveProviderMutationRejection } from "../lib/mutation-provider-boundary";
import {
	inheritOperationalCreateScope,
	validatePersistedOperationalScope,
} from "../lib/request-access";
import { canAccessWorkspaceScope } from "../lib/workspace-scope";
import { requireManageBillingMiddleware } from "../middleware/permissions";
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
	adoptDurableUsageReservation,
	settleLinkedDurableUsage,
} from "../services/durable-operation-usage";
import {
	continuePhoneProvisioning,
	createPhoneProvisioningOperation,
	findPhoneProvisioningOperation,
	getPhoneRow,
	PhoneOperationError,
	type PhoneRow,
	processPhoneRelease,
	stagePhoneRelease,
} from "../services/phone-number-operations";
import { searchAvailableNumbers } from "../services/telnyx";
import { settleDurableUsageReservation } from "../services/usage-meter";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

function markPhoneMutationNotApplied(c: AppContext): void {
	c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
		kind: "not_applied",
	});
}

function phoneAuthoritySessionId(c: AppContext): string | null {
	if (c.get("principalType") !== "dashboard_user") return null;
	return c.req.header(DASHBOARD_SESSION_AUTHORITY_HEADER)?.trim() || null;
}

async function trackMetaPhoneMutation(
	c: AppContext,
	label: string,
	operation: () => Promise<Response>,
	authoritative = true,
): Promise<Response> {
	const tracker = c.get("mutationEffectTracker");
	if (!tracker) return operation();
	const attempt = tracker.begin(label);
	try {
		const response = await operation();
		if (response.ok) {
			attempt.committed(1);
			if (authoritative) {
				tracker.setAuthoritativeOutcome({ kind: "committed", units: 1 });
			}
		} else if (isDefinitiveProviderMutationRejection(response.status)) {
			attempt.notApplied();
			if (authoritative) {
				tracker.setAuthoritativeOutcome({ kind: "not_applied" });
			}
		} else {
			attempt.unknown();
			if (authoritative) {
				tracker.setAuthoritativeOutcome({ kind: "unknown" });
			}
		}
		return response;
	} catch (error) {
		attempt.unknown();
		if (authoritative) {
			tracker.setAuthoritativeOutcome({ kind: "unknown" });
		}
		throw error;
	}
}

const requireManageBillingForPhoneMoneyMutations = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	if (
		c.req.method === "DELETE" ||
		(c.req.method === "POST" && c.req.path.endsWith("/purchase"))
	) {
		return requireManageBillingMiddleware(c, next);
	}
	return next();
});
app.use("*", requireManageBillingForPhoneMoneyMutations);

const WA_API_BASE = GRAPH_BASE.facebook;

export function generateWhatsAppVerificationPin(): string {
	const range = 900_000;
	const uint32Cardinality = 2 ** 32;
	const unbiasedCeiling = Math.floor(uint32Cardinality / range) * range;
	const random = new Uint32Array(1);
	let value: number;
	do {
		crypto.getRandomValues(random);
		value = random[0] ?? uint32Cardinality;
	} while (value >= unbiasedCeiling);
	return String(100_000 + (value % range));
}

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
	phone: PhoneRow,
	orgId: string,
	encryptionKey?: string,
	workspaceScope: "all" | string[] = "all",
): Promise<{
	accessToken: string;
	wabaId: string | undefined;
	workspaceId: string | null;
} | null> {
	const sourceAccountId = phone.provisioningSourceAccountId;
	const expectedWabaId = phone.provisioningSourceWabaId;
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
		403: {
			description: "Credential no longer has live release authority",
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

	if (
		plan !== "pro" ||
		(c.get("billingSource") === "stripe" && !c.get("billable"))
	) {
		markPhoneMutationNotApplied(c);
		return c.json(
			{
				error: {
					code: plan !== "pro" ? "PRO_REQUIRED" : "BILLING_NOT_CURRENT",
					message:
						plan !== "pro"
							? "Phone number provisioning requires a Pro plan"
							: "Phone number provisioning is unavailable while hosted billing is delinquent",
				},
			},
			403,
		);
	}

	const telnyxApiKey = c.env.TELNYX_API_KEY;
	if (!telnyxApiKey) {
		markPhoneMutationNotApplied(c);
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
		markPhoneMutationNotApplied(c);
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
		markPhoneMutationNotApplied(c);
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
				markPhoneMutationNotApplied(c);
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
				usageReservation: c.get("usageReservation"),
			});
			operation = created.row;
		}
		await adoptDurableUsageReservation(
			db,
			operation.provisioningUsageReservationId,
			c.get("usageReservation"),
		);

		const completed = await continuePhoneProvisioning(c.env, db, operation.id);
		await settleLinkedDurableUsage(db, {
			organizationId: completed.organizationId,
			usageReservationId: completed.provisioningUsageReservationId,
			committed: true,
		});
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
			if (
				["PAYMENT_PENDING", "TELNYX_ORDER_PENDING", "IN_PROGRESS"].includes(
					error.code,
				)
			) {
				c.header("Idempotency-Retryable", "true");
				c.header("Retry-After", "60");
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

	const row = await getPhoneRow(db, phone_number_id);

	if (!row || row.organizationId !== orgId) {
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

	const row = await getPhoneRow(db, phone_number_id);

	if (!row || row.organizationId !== orgId) {
		markPhoneMutationNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Phone number not found" } },
			404,
		);
	}

	if (row.status !== "pending_verification") {
		markPhoneMutationNotApplied(c);
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
		markPhoneMutationNotApplied(c);
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
		markPhoneMutationNotApplied(c);
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
	const metaRes = await trackMetaPhoneMutation(
		c,
		"meta.whatsapp.request_code",
		() =>
			fetchWithTimeout(`${WA_API_BASE}/${row.waPhoneNumberId}/request_code`, {
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
			}),
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

	const row = await getPhoneRow(db, phone_number_id);

	if (!row || row.organizationId !== orgId) {
		markPhoneMutationNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Phone number not found" } },
			404,
		);
	}

	if (row.status !== "pending_verification") {
		markPhoneMutationNotApplied(c);
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
		markPhoneMutationNotApplied(c);
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
		markPhoneMutationNotApplied(c);
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
	if (!accountScope.ok) {
		markPhoneMutationNotApplied(c);
		return accountScope.response as never;
	}
	const workspaceId = accountScope.workspaceId;
	const authoritySessionId = phoneAuthoritySessionId(c);
	if (c.get("principalType") === "dashboard_user" && !authoritySessionId) {
		markPhoneMutationNotApplied(c);
		return c.json(
			{
				error: {
					code: "SESSION_NO_LONGER_AUTHORIZED",
					message: "The initiating dashboard session is no longer authorized.",
				},
			},
			401,
		);
	}
	const liveAuthority = await db.transaction((tx) =>
		validatePersistedOperationalScope(tx, {
			apiKeyId: c.get("keyId"),
			authoritySessionId,
			organizationId: orgId,
			workspaceId,
			resourceName: "WhatsApp account",
		}),
	);
	if (!liveAuthority.ok) {
		markPhoneMutationNotApplied(c);
		return c.json(
			{
				error: {
					code: liveAuthority.code,
					message: liveAuthority.message,
				},
			},
			liveAuthority.status as never,
		);
	}

	// Step 1: Verify the code with Meta
	// https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account-to-number-current-status/verify_code
	// Official docs: code is passed as a query parameter
	const verifyRes = await trackMetaPhoneMutation(
		c,
		"meta.whatsapp.verify_code",
		() =>
			fetchWithTimeout(
				`${WA_API_BASE}/${row.waPhoneNumberId}/verify_code?code=${encodeURIComponent(body.code)}`,
				{
					method: "POST",
					headers: { Authorization: `Bearer ${accessToken}` },
					timeout: 5_000,
				},
			),
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
	const pin = generateWhatsAppVerificationPin();
	const registerRes = await trackMetaPhoneMutation(
		c,
		"meta.whatsapp.register",
		() =>
			fetchWithTimeout(`${WA_API_BASE}/${row.waPhoneNumberId}/register`, {
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
			}),
		// Verification already succeeded. Registration evidence may refine local
		// state, but it must never regress the request's committed K=1 outcome.
		false,
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
					authoritySessionId,
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
		markPhoneMutationNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Phone number not found" } },
			404,
		);
	}

	if (row.status === "released") {
		const usageReservation = c.get("usageReservation");
		if (usageReservation) {
			await settleDurableUsageReservation(db, {
				reservationId: usageReservation.id,
				organizationId: usageReservation.organizationId,
				committedUnits: 0,
			});
		}
		return c.json(formatPhoneNumber(row), 200);
	}

	const releasableStatuses = [
		"purchasing",
		"pending_verification",
		"verified",
		"active",
		"releasing",
	];
	if (!releasableStatuses.includes(row.status)) {
		markPhoneMutationNotApplied(c);
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

	let releaseOperationOwnsReservation = false;
	try {
		const staged = await stagePhoneRelease(
			db,
			orgId,
			phone_number_id,
			"user_requested",
			c.get("usageReservation"),
			durableCredentialAuthorityAdmission(c, "manage_billing"),
		);
		// From this point onward the durable release row, rather than the request,
		// owns usage settlement. A retry or provider ambiguity must remain parked.
		releaseOperationOwnsReservation = true;
		await adoptDurableUsageReservation(
			db,
			staged.releaseUsageReservationId,
			c.get("usageReservation"),
		);
		const released = await processPhoneRelease(c.env, db, staged.id);
		await settleLinkedDurableUsage(db, {
			organizationId: released.organizationId,
			usageReservationId: released.releaseUsageReservationId,
			committed: true,
		});
		return c.json(formatPhoneNumber(released), 200);
	} catch (error) {
		if (error instanceof PhoneOperationError) {
			if (error.code === "CREDENTIAL_NO_LONGER_AUTHORIZED") {
				markPhoneMutationNotApplied(c);
				return c.json(
					{ error: { code: error.code, message: error.message } },
					403,
				);
			}
			if (
				!releaseOperationOwnsReservation &&
				(error.code === "NOT_FOUND" || error.code === "IN_PROGRESS")
			) {
				// stagePhoneRelease proved its transaction did not create/adopt a
				// release operation, so the request reservation is exactly K=0.
				markPhoneMutationNotApplied(c);
			}
			if (error.code === "NOT_FOUND") {
				return c.json(
					{ error: { code: error.code, message: error.message } },
					404,
				);
			}
			if (
				["PAYMENT_PENDING", "TELNYX_ORDER_PENDING", "IN_PROGRESS"].includes(
					error.code,
				)
			) {
				c.header("Idempotency-Retryable", "true");
				c.header("Retry-After", "60");
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
			.select({ releaseState: whatsappPhoneReleaseOperations.releaseState })
			.from(whatsappPhoneReleaseOperations)
			.where(eq(whatsappPhoneReleaseOperations.phoneNumberId, phone_number_id))
			.limit(1);
		if (
			pending?.releaseState === "failed" ||
			pending?.releaseState === "unknown" ||
			pending?.releaseState === "request_may_have_been_sent"
		) {
			c.header("Idempotency-Retryable", "true");
			c.header("Retry-After", "60");
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
