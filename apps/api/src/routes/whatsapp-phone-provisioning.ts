import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	createDb,
	organizationSubscriptions,
	socialAccounts,
	whatsappPhoneNumbers,
	generateId,
} from "@relayapi/db";
import { and, eq, inArray, count } from "drizzle-orm";
import { maybeDecrypt, maybeEncrypt } from "../lib/crypto";
import { createStripeClient } from "../services/stripe";
import {
	searchAvailableNumbers,
	orderNumber,
	releaseNumber,
} from "../services/telnyx";
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
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const WA_API_BASE = "https://graph.facebook.com/v25.0";
const MAX_NUMBERS_PER_ORG = 5;

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

// ---------------------------------------------------------------------------
// Helper: get a WhatsApp account with a valid access token for the org
// ---------------------------------------------------------------------------

async function getOrgWhatsAppToken(
	db: ReturnType<typeof createDb>,
	orgId: string,
	encryptionKey?: string,
): Promise<{ accessToken: string; wabaId: string | undefined } | null> {
	const accounts = await db
		.select()
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.organizationId, orgId),
				eq(socialAccounts.platform, "whatsapp"),
			),
		)
		.limit(5);

	for (const account of accounts) {
		const token = await maybeDecrypt(account.accessToken, encryptionKey);
		if (token) {
			const wabaId = (account.metadata as { waba_id?: string } | null)?.waba_id;
			return { accessToken: token, wabaId };
		}
	}
	return null;
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
	path: "/",
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
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Number not in pending_verification status",
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
	const db = c.get("db");

	// 1. Require Pro plan
	if (plan !== "pro") {
		return c.json(
			{ error: { code: "PRO_REQUIRED", message: "Phone number provisioning requires a Pro plan" } },
			403,
		);
	}

	// 2. Require Telnyx API key
	if (!c.env.TELNYX_API_KEY) {
		return c.json(
			{ error: { code: "CONFIG_ERROR", message: "Phone number provisioning is not configured" } },
			403,
		);
	}

	// 3. Validate WhatsApp account + WABA
	const account = await getWhatsAppAccount(db, body.account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account || !account.accessToken) {
		return c.json(
			{ error: { code: "ACCOUNT_NOT_FOUND", message: "WhatsApp account not found or missing access token" } },
			401,
		);
	}

	const wabaId = (account.metadata as { waba_id?: string } | null)?.waba_id;
	if (!wabaId) {
		return c.json(
			{ error: { code: "WABA_NOT_FOUND", message: "WhatsApp Business Account ID not found on this account" } },
			401,
		);
	}

	// 4. Acquire a KV lock to prevent concurrent purchases for the same org
	const lockKey = `purchase-lock:${orgId}`;
	const existingLock = await c.env.KV.get(lockKey);
	if (existingLock) {
		return c.json(
			{ error: { code: "IN_PROGRESS", message: "Another phone number purchase is in progress. Please wait." } },
			409,
		);
	}
	await c.env.KV.put(lockKey, "1", { expirationTtl: 120 }); // 2-minute TTL auto-cleanup

	try {

	// 5. Check no number already in progress
	const [inProgress] = await db
		.select({ cnt: count() })
		.from(whatsappPhoneNumbers)
		.where(
			and(
				eq(whatsappPhoneNumbers.organizationId, orgId),
				inArray(whatsappPhoneNumbers.status, ["purchasing", "pending_verification"]),
			),
		);
	if (inProgress && inProgress.cnt > 0) {
		await c.env.KV.delete(lockKey);
		return c.json(
			{ error: { code: "IN_PROGRESS", message: "Another phone number is currently being provisioned" } },
			409,
		);
	}

	// 6. Check max numbers per org
	const [activeCount] = await db
		.select({ cnt: count() })
		.from(whatsappPhoneNumbers)
		.where(
			and(
				eq(whatsappPhoneNumbers.organizationId, orgId),
				inArray(whatsappPhoneNumbers.status, ["purchasing", "pending_verification", "verified", "active"]),
			),
		);
	if (activeCount && activeCount.cnt >= MAX_NUMBERS_PER_ORG) {
		await c.env.KV.delete(lockKey);
		return c.json(
			{ error: { code: "LIMIT_REACHED", message: `Maximum of ${MAX_NUMBERS_PER_ORG} phone numbers per organization` } },
			409,
		);
	}

	// 7. Search + order from Telnyx
	const telnyxKey = c.env.TELNYX_API_KEY!;
	const available = await searchAvailableNumbers(telnyxKey, {
		countryCode: body.country,
		areaCode: body.area_code,
		limit: 1,
	});
	const firstAvailable = available[0];
	if (!firstAvailable) {
		await c.env.KV.delete(lockKey);
		return c.json(
			{ error: { code: "NO_NUMBERS", message: "No phone numbers available for the requested criteria" } },
			409,
		);
	}

	const ordered = await orderNumber(telnyxKey, firstAvailable.phone_number);
	const purchasedNumber = ordered.phoneNumbers[0] ?? firstAvailable.phone_number;

	// 7. Create DB record
	const phoneNumberId = generateId("wpn_");
	await db.insert(whatsappPhoneNumbers).values({
		id: phoneNumberId,
		organizationId: orgId,
		phoneNumber: purchasedNumber,
		provider: "telnyx",
		providerNumberId: ordered.phoneNumberId,
		status: "purchasing",
		country: body.country,
	});

	// 8. Stripe billing
	let checkoutUrl: string | null = null;
	const [orgSub] = await db
		.select()
		.from(organizationSubscriptions)
		.where(eq(organizationSubscriptions.organizationId, orgId))
		.limit(1);

	if (orgSub?.stripeSubscriptionId && c.env.STRIPE_WA_PHONE_PRICE_ID) {
		const stripe = createStripeClient(c.env.STRIPE_SECRET_KEY);
		const item = await stripe.subscriptionItems.create({
			subscription: orgSub.stripeSubscriptionId,
			price: c.env.STRIPE_WA_PHONE_PRICE_ID,
			quantity: 1,
		});
		await db
			.update(whatsappPhoneNumbers)
			.set({ stripeSubscriptionItemId: item.id, updatedAt: new Date() })
			.where(eq(whatsappPhoneNumbers.id, phoneNumberId));
	} else if (orgSub?.stripeCustomerId && c.env.STRIPE_WA_PHONE_PRICE_ID) {
		// No active subscription — create a checkout session
		const stripe = createStripeClient(c.env.STRIPE_SECRET_KEY);
		const session = await stripe.checkout.sessions.create({
			customer: orgSub.stripeCustomerId,
			mode: "subscription",
			line_items: [{ price: c.env.STRIPE_WA_PHONE_PRICE_ID, quantity: 1 }],
			metadata: {
				type: "wa_phone_number",
				phoneNumberId,
				organizationId: orgId,
			},
			success_url: `${c.env.API_BASE_URL ?? "https://api.relayapi.dev"}/v1/whatsapp/phone-numbers/${phoneNumberId}`,
			cancel_url: `${c.env.API_BASE_URL ?? "https://api.relayapi.dev"}/v1/whatsapp/phone-numbers/${phoneNumberId}`,
		});
		checkoutUrl = session.url;
	}

	// 9. Register number with Meta WABA
	// Meta Business Management API: Add phone number to WABA
	// https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/phone_numbers/
	// Only US numbers are supported, so cc is always "1"
	const cc = "1";
	const phoneOnly = purchasedNumber.replace(/^\+1/, "");

	try {
		const metaRes = await fetch(`${WA_API_BASE}/${wabaId}/phone_numbers`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${account.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cc,
				phone_number: phoneOnly,
				verified_name: account.displayName ?? "Business",
			}),
		});

		if (metaRes.ok) {
			const metaData = (await metaRes.json()) as { id?: string };
			await db
				.update(whatsappPhoneNumbers)
				.set({
					waPhoneNumberId: metaData.id ?? null,
					status: "pending_verification",
					updatedAt: new Date(),
				})
				.where(eq(whatsappPhoneNumbers.id, phoneNumberId));
		} else {
			// Meta registration failed — keep in purchasing status, caller can retry
			const metaErr = (await metaRes.json().catch(() => ({}))) as {
				error?: { message?: string };
			};
			console.error("Meta phone registration failed:", metaErr);
		}
	} catch (err) {
		console.error("Meta phone registration error:", err);
	}

	// Re-fetch to get updated status
	const [updated] = await db
		.select()
		.from(whatsappPhoneNumbers)
		.where(eq(whatsappPhoneNumbers.id, phoneNumberId))
		.limit(1);

	return c.json(
		{
			id: updated!.id,
			phone_number: updated!.phoneNumber,
			status: updated!.status,
			checkout_url: checkoutUrl,
		},
		201,
	);

	} finally {
		// Release the purchase lock
		await c.env.KV.delete(lockKey);
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
			{ error: { code: "INVALID_STATUS", message: "Phone number is not in pending_verification status" } },
			409,
		);
	}

	if (!row.waPhoneNumberId) {
		return c.json(
			{ error: { code: "NOT_REGISTERED", message: "Phone number has not been registered with Meta yet" } },
			409,
		);
	}

	// Find a WhatsApp account with a valid access token
	const waToken = await getOrgWhatsAppToken(db, orgId, c.env.ENCRYPTION_KEY);
	if (!waToken) {
		return c.json(
			{ error: { code: "ACCOUNT_NOT_FOUND", message: "No WhatsApp account with valid access token found" } },
			401,
		);
	}
	const { accessToken } = waToken;

	// Meta WhatsApp API: Request verification code
	// https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/phone-number-verification-request-code-api
	const metaRes = await fetch(`${WA_API_BASE}/${row.waPhoneNumberId}/request_code`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			code_method: body.method.toUpperCase(),
			language: "en_US",
		}),
	});

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
			{ error: { code: "INVALID_STATUS", message: "Phone number is not in pending_verification status" } },
			409,
		);
	}

	if (!row.waPhoneNumberId) {
		return c.json(
			{ error: { code: "NOT_REGISTERED", message: "Phone number has not been registered with Meta yet" } },
			409,
		);
	}

	// Find a WhatsApp account with a valid access token
	const waToken = await getOrgWhatsAppToken(db, orgId, c.env.ENCRYPTION_KEY);
	if (!waToken) {
		return c.json(
			{ error: { code: "ACCOUNT_NOT_FOUND", message: "No WhatsApp account with valid access token found" } },
			401,
		);
	}
	const { accessToken, wabaId } = waToken;

	// Step 1: Verify the code with Meta
	// https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account-to-number-current-status/verify_code
	// Official docs: code is passed as a query parameter
	const verifyRes = await fetch(
		`${WA_API_BASE}/${row.waPhoneNumberId}/verify_code?code=${encodeURIComponent(body.code)}`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${accessToken}` },
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
					message: err.error?.message ?? `Verification failed: ${verifyRes.status}`,
				},
			},
			409,
		);
	}

	// Step 2: Register the number for Cloud API
	// https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/register-api
	const pin = String(Math.floor(100000 + Math.random() * 900000));
	const registerRes = await fetch(`${WA_API_BASE}/${row.waPhoneNumberId}/register`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			messaging_product: "whatsapp",
			pin,
		}),
	});

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
					message: regErr.error?.message ?? "Cloud API registration failed. Number is verified but not yet active.",
				},
			},
			409,
		);
	}

	// Step 3: Create or update social account for this number (atomic upsert)
	const encryptedToken = await maybeEncrypt(accessToken, c.env.ENCRYPTION_KEY);

	let upsertedAccount;
	try {
		[upsertedAccount] = await db.insert(socialAccounts).values({
			organizationId: orgId,
			platform: "whatsapp",
			platformAccountId: row.waPhoneNumberId,
			displayName: row.phoneNumber,
			accessToken: encryptedToken,
			metadata: { waba_id: wabaId },
		})
		.onConflictDoUpdate({
			target: [socialAccounts.organizationId, socialAccounts.platform, socialAccounts.platformAccountId],
			set: {
				displayName: row.phoneNumber,
				accessToken: encryptedToken,
				metadata: { waba_id: wabaId },
				updatedAt: new Date(),
			},
		})
		.returning();
	} catch (err) {
		console.error("[whatsapp-provisioning] Account upsert failed:", err instanceof Error ? err.message : err);
		return c.json({ error: { code: "ACCOUNT_SAVE_FAILED", message: "Failed to save WhatsApp account. Please try again." } }, 500);
	}

	// Step 4: Update phone number record to active
	await db
		.update(whatsappPhoneNumbers)
		.set({
			status: "active",
			socialAccountId: upsertedAccount?.id ?? null,
			updatedAt: new Date(),
		})
		.where(eq(whatsappPhoneNumbers.id, phone_number_id));

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

	const releasableStatuses = ["active", "verified", "pending_verification"];
	if (!releasableStatuses.includes(row.status)) {
		return c.json(
			{ error: { code: "INVALID_STATUS", message: `Cannot release a number in ${row.status} status` } },
			409,
		);
	}

	// Mark as releasing
	await db
		.update(whatsappPhoneNumbers)
		.set({ status: "releasing", updatedAt: new Date() })
		.where(eq(whatsappPhoneNumbers.id, phone_number_id));

	// 1. Cancel Stripe subscription item
	if (row.stripeSubscriptionItemId) {
		try {
			const stripe = createStripeClient(c.env.STRIPE_SECRET_KEY);
			await stripe.subscriptionItems.del(row.stripeSubscriptionItemId);
		} catch (err) {
			console.error("Failed to cancel Stripe subscription item:", err);
		}
	}

	// 2. Release number from Telnyx
	if (row.providerNumberId && c.env.TELNYX_API_KEY) {
		try {
			await releaseNumber(c.env.TELNYX_API_KEY, row.providerNumberId);
		} catch (err) {
			console.error("Failed to release Telnyx number:", err);
		}
	}

	// 3. Unlink social account (keep the record but clear the FK)
	await db
		.update(whatsappPhoneNumbers)
		.set({
			status: "released",
			socialAccountId: null,
			updatedAt: new Date(),
		})
		.where(eq(whatsappPhoneNumbers.id, phone_number_id));

	const [updated] = await db
		.select()
		.from(whatsappPhoneNumbers)
		.where(eq(whatsappPhoneNumbers.id, phone_number_id))
		.limit(1);

	return c.json(formatPhoneNumber(updated!), 200);
});

export default app;
