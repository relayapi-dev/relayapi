import { afterEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { DASHBOARD_SESSION_AUTHORITY_HEADER } from "@relayapi/config";
import type { Database } from "@relayapi/db";
import { encryptAccountToken } from "../lib/account-token-crypto";
import { MutationEffectTracker } from "../lib/mutation-effect";
import phoneProvisioningRoutes, {
	generateWhatsAppVerificationPin,
} from "../routes/whatsapp-phone-provisioning";
import type { Env, Variables } from "../types";

type PhoneRouteDb = Database;
const TEST_ENCRYPTION_KEY = `test=${"51".repeat(32)},identity=${"52".repeat(32)}`;
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function selectionDb(rows: unknown[]): PhoneRouteDb {
	// biome-ignore lint/suspicious/noExplicitAny: minimal Drizzle route-test double
	const db: any = {
		select: () => ({
			from: () => {
				// biome-ignore lint/suspicious/noExplicitAny: chainable route-test double
				const query: any = {
					where: () => query,
					limit: async () => rows,
				};
				return query;
			},
		}),
	};
	return db as PhoneRouteDb;
}

function releaseCasConflictDb(): PhoneRouteDb {
	const phone = {
		id: "wpn_conflict",
		organizationId: "org_phone",
		status: "active",
		createdAt: new Date("2026-08-02T00:00:00.000Z"),
		updatedAt: new Date("2026-08-02T00:00:00.000Z"),
		waPhoneNumberId: "meta_phone",
		providerNumberId: "telnyx_phone",
		telnyxOrderId: "telnyx_order",
		stripePhoneSubscriptionId: "sub_phone",
		stripeSubscriptionItemId: "si_phone",
		stripeCheckoutSessionId: null,
	};
	const joined = {
		phone,
		provisioning: {
			phoneNumberId: phone.id,
			organizationId: phone.organizationId,
			provisioningState: "completed",
			provisioningPhase: "completed",
			provisioningLeaseToken: 3,
			provisioningLeaseExpiresAt: null,
			provisioningRequestMayHaveBeenSentAt: null,
		},
		release: null,
	};
	const selections = [
		[phone],
		[joined],
		[
			{
				id: "key_phone",
				referenceId: null,
				principalId: "prn_phone",
				credentialVersion: "generation-1",
				enabled: true,
				expiresAt: null,
				permissions: "read,write,manage_billing",
			},
		],
		[
			{
				id: "prn_phone",
				kind: "service",
				memberId: null,
				scopeMode: "all",
				lifecycleStatus: "active",
			},
		],
		[{ id: "org_phone", lifecycleStatus: "active" }],
		[joined],
	];
	let selection = 0;
	// biome-ignore lint/suspicious/noExplicitAny: focused transaction/CAS test double
	const db: any = {
		select: () => {
			const rows = selections[selection++] ?? [];
			// biome-ignore lint/suspicious/noExplicitAny: chainable route-test double
			const query: any = {
				from: () => query,
				innerJoin: () => query,
				leftJoin: () => query,
				where: () => query,
				for: () => query,
				limit: async () => rows,
			};
			return query;
		},
		update: () => ({
			set: () => ({
				where: () => ({ returning: async () => [] }),
			}),
		}),
		transaction: async (callback: (tx: unknown) => unknown) => callback(db),
	};
	return db as PhoneRouteDb;
}

async function verificationDb(
	options: {
		accountWorkspaceId?: string | null;
		authority?: "service" | "revoked_dashboard";
		workspaceExists?: boolean;
	} = {},
): Promise<PhoneRouteDb> {
	const accountWorkspaceId = options.accountWorkspaceId ?? null;
	const phone = {
		id: "wpn_verify",
		organizationId: "org_phone",
		phoneNumber: "+12025550123",
		status: "pending_verification",
		waPhoneNumberId: "meta_phone",
		createdAt: new Date("2026-08-02T00:00:00.000Z"),
		updatedAt: new Date("2026-08-02T00:00:00.000Z"),
	};
	const provisioning = {
		phoneNumberId: phone.id,
		organizationId: phone.organizationId,
		provisioningSourceAccountId: "acc_phone",
		provisioningSourceWabaId: "waba_phone",
	};
	const account = {
		id: "acc_phone",
		organizationId: phone.organizationId,
		workspaceId: accountWorkspaceId,
		platform: "whatsapp",
		lifecycleStatus: "active",
		accessToken: await encryptAccountToken(
			"meta_access_token",
			TEST_ENCRYPTION_KEY,
			"acc_phone",
			"access_token",
		),
		metadata: { waba_id: "waba_phone" },
	};
	const authoritySelections =
		options.authority === "revoked_dashboard"
			? [
					[
						{
							id: "key_phone",
							referenceId: "usr_phone",
							principalId: "prn_phone",
							principalKind: "member",
							principalMemberId: "mem_phone",
						},
					],
					[
						{
							id: "usr_phone",
							banned: false,
							banExpires: null,
							credentialVersion: "generation-1",
						},
					],
					[
						{
							id: "mem_phone",
							role: "owner",
							userId: "usr_phone",
							organizationId: "org_phone",
						},
					],
					[{ lifecycleStatus: "active" }],
					[
						{
							id: "key_phone",
							referenceId: "usr_phone",
							principalId: "prn_phone",
							credentialVersion: "generation-1",
							enabled: true,
							expiresAt: null,
							permissions: "read,write",
						},
					],
					[
						{
							id: "prn_phone",
							kind: "member",
							memberId: "mem_phone",
							scopeMode: "all",
							lifecycleStatus: "active",
						},
					],
					[],
				]
			: [
					[
						{
							id: "key_phone",
							referenceId: null,
							principalId: "prn_phone",
							principalKind: "service",
							principalMemberId: null,
						},
					],
					[{ lifecycleStatus: "active" }],
					[
						{
							id: "key_phone",
							referenceId: null,
							principalId: "prn_phone",
							credentialVersion: "generation-1",
							enabled: true,
							expiresAt: null,
							permissions: "read,write",
						},
					],
					[
						{
							id: "prn_phone",
							kind: "service",
							memberId: null,
							scopeMode: "all",
							lifecycleStatus: "active",
						},
					],
					[{ requireWorkspaceId: false }],
				];
	const selections = [
		[{ phone, provisioning, release: null }],
		[account],
		[{ requireWorkspaceId: false, revision: 1 }],
		...(accountWorkspaceId
			? [
					options.workspaceExists === false
						? []
						: [{ id: accountWorkspaceId, lifecycleStatus: "active" }],
				]
			: []),
		...authoritySelections,
		...(accountWorkspaceId ? [[{ lifecycleStatus: "active" }]] : []),
	];
	let selection = 0;
	// biome-ignore lint/suspicious/noExplicitAny: focused phone-route test double
	const db: any = {
		select: () => {
			const rows = selections[selection++] ?? [];
			// biome-ignore lint/suspicious/noExplicitAny: chainable route-test double
			const query: any = {
				from: () => query,
				innerJoin: () => query,
				leftJoin: () => query,
				where: () => query,
				for: () => query,
				limit: async () => rows,
			};
			return query;
		},
		update: () => ({
			set: () => ({ where: async () => [] }),
		}),
		transaction: async (callback: (tx: unknown) => unknown) => callback(db),
	};
	return db as PhoneRouteDb;
}

function makeApp(
	db: PhoneRouteDb,
	options: {
		plan?: "free" | "pro";
		billingCurrent?: boolean;
		principalType?: "dashboard_user" | "service";
		workspaceScope?: "all" | string[];
	} = {},
) {
	const tracker = new MutationEffectTracker();
	const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", async (c, next) => {
		tracker.markRouteEntered();
		c.set("orgId", "org_phone");
		c.set("workspaceScope", options.workspaceScope ?? "all");
		c.set("principalType", options.principalType ?? "service");
		c.set(
			"principalUserId",
			options.principalType === "dashboard_user" ? "usr_phone" : null,
		);
		c.set("permissions", ["read", "write", "manage_billing"]);
		c.set("keyId", "key_phone");
		c.set("keyHash", "hash_phone");
		c.set("principalId", "prn_phone");
		c.set("plan", options.plan ?? "pro");
		c.set("billingSource", options.plan === "free" ? "free" : "stripe");
		c.set("billable", options.billingCurrent ?? true);
		c.set("mutationEffectTracker", tracker);
		c.set("db", db);
		await next();
	});
	app.onError((_error, c) =>
		c.json(
			{ error: { code: "INTERNAL_ERROR", message: "Internal error" } },
			500,
		),
	);
	app.route("/v1/whatsapp/phone-numbers", phoneProvisioningRoutes);
	return { app, tracker };
}

function requestVerificationCode(
	app: ReturnType<typeof makeApp>["app"],
	method: "sms" | "voice" = "sms",
) {
	return app.request(
		"/v1/whatsapp/phone-numbers/wpn_verify/request-code",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ method }),
		},
		{ ENCRYPTION_KEY: TEST_ENCRYPTION_KEY } as Env,
	);
}

function verifyPhoneCode(
	app: ReturnType<typeof makeApp>["app"],
	authoritySessionId?: string,
) {
	return app.request(
		"/v1/whatsapp/phone-numbers/wpn_verify/verify",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(authoritySessionId
					? { [DASHBOARD_SESSION_AUTHORITY_HEADER]: authoritySessionId }
					: {}),
			},
			body: JSON.stringify({ code: "123456" }),
		},
		{ ENCRYPTION_KEY: TEST_ENCRYPTION_KEY } as Env,
	);
}

function mockMetaResponses(...responses: Array<Response | Error>): void {
	let call = 0;
	globalThis.fetch = mock(async () => {
		const result = responses[call++];
		if (result instanceof Error) throw result;
		if (!result) throw new Error("Unexpected Meta fetch");
		return result;
	}) as unknown as typeof fetch;
}

function purchaseRequest(app: ReturnType<typeof makeApp>["app"], env: Env) {
	return app.request(
		"/v1/whatsapp/phone-numbers/purchase",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "phone-preboundary-test",
			},
			body: JSON.stringify({ account_id: "acc_phone", country: "US" }),
		},
		env,
	);
}

describe("phone pre-boundary usage accounting", () => {
	it("uses Web Crypto for six-digit WhatsApp registration PINs", () => {
		for (let i = 0; i < 100; i++) {
			expect(generateWhatsAppVerificationPin()).toMatch(/^[1-9][0-9]{5}$/);
		}
	});
	it("proves plan and configuration rejections are K=0", async () => {
		const denied = makeApp(selectionDb([]), { plan: "free" });
		const deniedResponse = await purchaseRequest(denied.app, {} as Env);
		expect(deniedResponse.status).toBe(403);
		expect(denied.tracker.outcome(1)).toEqual({ kind: "not_applied" });

		const unconfigured = makeApp(selectionDb([]));
		const unconfiguredResponse = await purchaseRequest(
			unconfigured.app,
			{} as Env,
		);
		expect(unconfiguredResponse.status).toBe(403);
		expect(unconfigured.tracker.outcome(1)).toEqual({
			kind: "not_applied",
		});
	});

	it("proves release lookup and invalid-state rejections are K=0", async () => {
		const missing = makeApp(selectionDb([]));
		const missingResponse = await missing.app.request(
			"/v1/whatsapp/phone-numbers/wpn_missing",
			{ method: "DELETE" },
			{} as Env,
		);
		expect(missingResponse.status).toBe(404);
		expect(missing.tracker.outcome(1)).toEqual({ kind: "not_applied" });

		const invalid = makeApp(selectionDb([{ status: "manual_review" }]));
		const invalidResponse = await invalid.app.request(
			"/v1/whatsapp/phone-numbers/wpn_invalid",
			{ method: "DELETE" },
			{} as Env,
		);
		expect(invalidResponse.status).toBe(409);
		expect(invalid.tracker.outcome(1)).toEqual({ kind: "not_applied" });
	});

	it("releases a request whose release-staging CAS loses before ownership", async () => {
		const conflict = makeApp(releaseCasConflictDb());
		const response = await conflict.app.request(
			"/v1/whatsapp/phone-numbers/wpn_conflict",
			{ method: "DELETE" },
			{} as Env,
		);

		expect(response.status).toBe(409);
		expect((await response.json()) as unknown).toEqual({
			error: {
				code: "IN_PROGRESS",
				message:
					"Phone provisioning advanced while release was being staged; retry with the same Idempotency-Key",
			},
		});
		expect(conflict.tracker.outcome(1)).toEqual({ kind: "not_applied" });
	});

	it("classifies a received Meta request-code rejection as K=0", async () => {
		mockMetaResponses(
			Response.json(
				{ error: { message: "Verification delivery rejected" } },
				{ status: 400 },
			),
		);
		const rejected = makeApp(await verificationDb());

		const response = await requestVerificationCode(rejected.app);

		expect(response.status).toBe(409);
		expect(rejected.tracker.outcome(1)).toEqual({ kind: "not_applied" });
	});

	it("commits request-code success before its local projection", async () => {
		mockMetaResponses(Response.json({ success: true }));
		const successful = makeApp(await verificationDb());

		const response = await requestVerificationCode(successful.app, "voice");

		expect(response.status).toBe(200);
		expect(successful.tracker.outcome(1)).toEqual({
			kind: "committed",
			units: 1,
		});
	});

	it("parks ambiguous Meta response and transport outcomes", async () => {
		mockMetaResponses(
			Response.json(
				{ error: { message: "upstream unavailable" } },
				{ status: 503 },
			),
		);
		const unavailable = makeApp(await verificationDb());
		const unavailableResponse = await requestVerificationCode(unavailable.app);
		expect(unavailableResponse.status).toBe(409);
		expect(unavailable.tracker.outcome(1)).toEqual({ kind: "unknown" });

		mockMetaResponses(new Error("connection reset after send"));
		const disconnected = makeApp(await verificationDb());
		const disconnectedResponse = await requestVerificationCode(
			disconnected.app,
		);
		expect(disconnectedResponse.status).toBe(500);
		expect(disconnected.tracker.outcome(1)).toEqual({ kind: "unknown" });
	});

	it("keeps K=1 when registration fails after verification succeeds", async () => {
		mockMetaResponses(
			Response.json({ success: true }),
			Response.json(
				{ error: { message: "Cloud registration rejected" } },
				{ status: 400 },
			),
		);
		const partial = makeApp(await verificationDb());

		const response = await verifyPhoneCode(partial.app);

		expect(response.status).toBe(409);
		expect((await response.json()) as unknown).toEqual({
			error: {
				code: "REGISTRATION_FAILED",
				message: "Cloud registration rejected",
			},
		});
		expect(partial.tracker.outcome(1)).toEqual({
			kind: "committed",
			units: 1,
		});

		mockMetaResponses(
			Response.json({ success: true }),
			new Error("registration acknowledgement lost"),
		);
		const ambiguousRegistration = makeApp(await verificationDb());
		const ambiguousResponse = await verifyPhoneCode(ambiguousRegistration.app);
		expect(ambiguousResponse.status).toBe(500);
		expect(ambiguousRegistration.tracker.outcome(1)).toEqual({
			kind: "committed",
			units: 1,
		});
	});

	it("proves inherited workspace denial is K=0 before verification", async () => {
		const denied = makeApp(
			await verificationDb({
				accountWorkspaceId: "ws_missing",
				workspaceExists: false,
			}),
			{ workspaceScope: ["ws_missing"] },
		);

		const response = await verifyPhoneCode(denied.app);

		expect(response.status).toBe(404);
		expect(denied.tracker.outcome(1)).toEqual({ kind: "not_applied" });
	});

	it("rejects missing or revoked dashboard sessions before any Meta mutation", async () => {
		let metaCalls = 0;
		globalThis.fetch = mock(async () => {
			metaCalls += 1;
			return Response.json({ success: true });
		}) as unknown as typeof fetch;

		const missing = makeApp(await verificationDb(), {
			principalType: "dashboard_user",
		});
		const missingResponse = await verifyPhoneCode(missing.app);
		expect(missingResponse.status).toBe(401);
		expect(missing.tracker.outcome(1)).toEqual({ kind: "not_applied" });

		const revoked = makeApp(
			await verificationDb({ authority: "revoked_dashboard" }),
			{ principalType: "dashboard_user" },
		);
		const revokedResponse = await verifyPhoneCode(
			revoked.app,
			"session_revoked",
		);
		expect(revokedResponse.status).toBe(403);
		expect(revoked.tracker.outcome(1)).toEqual({ kind: "not_applied" });
		expect(metaCalls).toBe(0);
	});

	it("keeps every verification pre-provider exit explicitly K=0", async () => {
		const source = await Bun.file(
			new URL("../routes/whatsapp-phone-provisioning.ts", import.meta.url),
		).text();
		const requestCode = source.slice(
			source.indexOf("app.openapi(requestCode"),
			source.indexOf("app.openapi(verifyCode"),
		);
		const verifyCode = source.slice(
			source.indexOf("app.openapi(verifyCode"),
			source.indexOf("// DELETE /:phone_number_id"),
		);
		for (const handler of [requestCode, verifyCode]) {
			for (const code of [
				"NOT_FOUND",
				"INVALID_STATUS",
				"NOT_REGISTERED",
				"ACCOUNT_NOT_FOUND",
			]) {
				const codeAt = handler.indexOf(`"${code}"`);
				expect(codeAt).toBeGreaterThan(-1);
				expect(handler.slice(Math.max(0, codeAt - 400), codeAt)).toContain(
					"markPhoneMutationNotApplied(c)",
				);
			}
		}
		expect(verifyCode).toContain(
			"if (!accountScope.ok) {\n\t\tmarkPhoneMutationNotApplied(c);",
		);
	});

	it("keeps every purchase rejection before durable ownership explicitly K=0", async () => {
		const source = await Bun.file(
			new URL("../routes/whatsapp-phone-provisioning.ts", import.meta.url),
		).text();
		const purchase = source.slice(
			source.indexOf("app.openapi(purchasePhoneNumber"),
			source.indexOf("// GET /:phone_number_id"),
		);
		for (const code of [
			"PRO_REQUIRED",
			"BILLING_NOT_CURRENT",
			"CONFIG_ERROR",
			"ACCOUNT_NOT_FOUND",
			"WABA_NOT_FOUND",
			"NO_NUMBERS",
		]) {
			const codeAt = purchase.indexOf(`"${code}"`);
			expect(codeAt).toBeGreaterThan(-1);
			expect(purchase.slice(Math.max(0, codeAt - 450), codeAt)).toContain(
				"markPhoneMutationNotApplied(c)",
			);
		}
	});

	it("transfers settlement ownership before adoption or provider processing", async () => {
		const source = await Bun.file(
			new URL("../routes/whatsapp-phone-provisioning.ts", import.meta.url),
		).text();
		const release = source.slice(
			source.indexOf("let releaseOperationOwnsReservation"),
		);
		const staged = release.indexOf("await stagePhoneRelease");
		const owned = release.indexOf("releaseOperationOwnsReservation = true");
		const adopted = release.indexOf("await adoptDurableUsageReservation");
		const processed = release.indexOf("await processPhoneRelease");
		expect(staged).toBeGreaterThan(-1);
		expect(owned).toBeGreaterThan(staged);
		expect(adopted).toBeGreaterThan(owned);
		expect(processed).toBeGreaterThan(adopted);
		expect(release).toContain("!releaseOperationOwnsReservation");
		expect(release).toContain('error.code === "NOT_FOUND"');
		expect(release).toContain('error.code === "IN_PROGRESS"');
	});
});
